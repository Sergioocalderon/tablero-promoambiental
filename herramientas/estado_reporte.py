"""
estado_reporte.py -- que vehiculos le estan reportando telemetria a Geotab
ahora mismo y cuales no (o llevan atraso).

Usa DeviceStatusInfo (dateTime de ultima comunicacion + isDeviceCommunicating),
el mismo campo que MyGeotab usa internamente para pintar un vehiculo como
"comunicando" o no en su propia UI -- no LogRecord ni StatusData sueltos, que
solo dirian "hay o no hay GPS", no el estado de comunicacion real del equipo.

Uso:
    python estado_reporte.py                    # toda la flota, umbral 6h
    python estado_reporte.py --horas 12          # umbral de "atrasado" distinto
    python estado_reporte.py --ciudad Bogota     # solo una ciudad
    python estado_reporte.py --excel             # ademas del texto, guarda un .xlsx en reportes/
"""
import argparse
import pathlib
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from geotab_comun import conectar_geotab, obtener_arbol_grupos, obtener_id

ZONA_BOGOTA = ZoneInfo("America/Bogota")
GRUPOS_RAIZ_NO_CIUDAD = {'tipologia'}
UMBRAL_HORAS_DEFECTO = 6


def normalizar_ciudad(nombre):
    n = nombre.upper()
    if 'BOGOTA' in n or 'BOGOTÁ' in n:
        return 'Bogotá'
    if 'CALI' in n:
        return 'Cali'
    if 'VALLE' in n:
        return 'Valle'
    return nombre.strip().title()


def resolver_ciudad(grupos_vehiculo, grupos_por_id, padre_de, ids_ciudad_raiz):
    """Sube por la jerarquia de cada grupo del vehiculo hasta encontrar cual de
    los hijos directos de '*' (excluyendo la rama 'Tipologia') es su ancestro --
    ese hijo directo ES la ciudad, igual criterio que obtener_mapa_grupos en
    telegram_alertas.py/app.py, re-derivado aca sin importar ese modulo entero
    (evita arrastrar dependencias de reportlab/requests solo para esto)."""
    for g in (grupos_vehiculo or []):
        actual = obtener_id(g)
        visitados = set()
        while actual and actual not in visitados:
            if actual in ids_ciudad_raiz:
                return normalizar_ciudad(grupos_por_id[actual].get('name', ''))
            visitados.add(actual)
            actual = padre_de.get(actual)
    return 'Sin ciudad asignada'


def exportar_excel(al_dia, atrasados, nunca, ciudad_filtro):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = 'Estado de reporte'

    encabezados = ['Estado', 'Vehículo', 'Placa', 'Ciudad', 'Tipología', 'Última comunicación', 'Horas de atraso']
    ws.append(encabezados)
    for celda in ws[1]:
        celda.font = Font(bold=True, color='FFFFFF')
        celda.fill = PatternFill('solid', fgColor='0F1B3D')

    RELLENO_ATRASADO = PatternFill('solid', fgColor='FDE2E2')
    RELLENO_NUNCA = PatternFill('solid', fgColor='E5E5E5')

    def agregar_fila(etiqueta, f, relleno=None):
        hora_txt = f['ultima_comm'].astimezone(ZONA_BOGOTA).strftime('%d/%m/%Y %H:%M') if f['ultima_comm'] else 'Sin registro'
        fila = [etiqueta, f['nombre'], f['placa'], f['ciudad'], f['tipologia'], hora_txt,
                round(f['horas_atraso'], 1) if f['horas_atraso'] is not None else None]
        ws.append(fila)
        if relleno:
            for celda in ws[ws.max_row]:
                celda.fill = relleno

    for f in atrasados:
        agregar_fila('ATRASADO', f, RELLENO_ATRASADO)
    for f in nunca:
        agregar_fila('SIN REGISTRO', f, RELLENO_NUNCA)
    for f in al_dia:
        agregar_fila('AL DÍA', f)

    ws.freeze_panes = 'A2'
    anchos = [14, 18, 14, 22, 24, 20, 16]
    for i, ancho in enumerate(anchos, start=1):
        ws.column_dimensions[get_column_letter(i)].width = ancho

    carpeta_salida = pathlib.Path(__file__).resolve().parent / 'reportes'
    carpeta_salida.mkdir(exist_ok=True)
    sufijo_ciudad = f"_{normalizar_ciudad(ciudad_filtro)}" if ciudad_filtro else ''
    nombre_archivo = f"estado_reporte{sufijo_ciudad}_{datetime.now(ZONA_BOGOTA).strftime('%Y%m%d_%H%M')}.xlsx"
    ruta = carpeta_salida / nombre_archivo
    wb.save(ruta)
    return ruta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--horas', type=float, default=UMBRAL_HORAS_DEFECTO,
                         help=f'Horas sin comunicar para marcar un vehiculo como atrasado (default {UMBRAL_HORAS_DEFECTO})')
    parser.add_argument('--ciudad', default=None, help='Filtrar a una sola ciudad (ej. Bogota)')
    parser.add_argument('--excel', action='store_true', help='Ademas del texto, guarda un .xlsx en reportes/')
    args = parser.parse_args()

    api = conectar_geotab()
    print("Conectado a Geotab. Consultando flota...")

    devices = api.get('Device')
    devices = [d for d in devices if d.get('groups')]  # descarta equipos sin ningun grupo asignado (pruebas/huerfanos)
    estados = api.get('DeviceStatusInfo')
    estado_por_device = {obtener_id(e['device']): e for e in estados if e.get('device')}

    grupos_por_id, padre_de, mapa_tipologia = obtener_arbol_grupos(api)
    raiz = next((g for g in grupos_por_id.values() if g.get('name', '').strip().startswith('*')), None)
    ids_ciudad_raiz = set()
    if raiz:
        for hijo in (raiz.get('children') or []):
            hijo_id = obtener_id(hijo)
            nombre_hijo = grupos_por_id.get(hijo_id, {}).get('name', '').strip()
            if nombre_hijo.lower() not in GRUPOS_RAIZ_NO_CIUDAD:
                ids_ciudad_raiz.add(hijo_id)

    ahora = datetime.now(timezone.utc)
    filas = []
    for d in devices:
        ciudad = resolver_ciudad(d.get('groups'), grupos_por_id, padre_de, ids_ciudad_raiz)
        if args.ciudad and normalizar_ciudad(args.ciudad) != ciudad:
            continue
        tipologia = 'Sin tipología asignada'
        for g in (d.get('groups') or []):
            t = mapa_tipologia.get(obtener_id(g))
            if t:
                tipologia = t
                break

        info = estado_por_device.get(d['id'])
        ultima_comm = None
        comunicando = False
        if info and info.get('dateTime'):
            valor_fecha = info['dateTime']
            # mygeotab ya devuelve datetime (no str) para este campo -- a diferencia de
            # otros endpoints del SDK, asi que no hace falta parsear nada aca.
            ultima_comm = valor_fecha if isinstance(valor_fecha, datetime) else datetime.fromisoformat(str(valor_fecha).replace('Z', '+00:00'))
            if ultima_comm.tzinfo is None:
                ultima_comm = ultima_comm.replace(tzinfo=timezone.utc)
            comunicando = bool(info.get('isDeviceCommunicating'))

        horas_atraso = (ahora - ultima_comm).total_seconds() / 3600 if ultima_comm else None

        filas.append({
            'nombre': d.get('name', d['id']),
            'placa': d.get('licensePlate', ''),
            'ciudad': ciudad,
            'tipologia': tipologia,
            'ultima_comm': ultima_comm,
            'comunicando': comunicando,
            'horas_atraso': horas_atraso,
        })

    nunca = [f for f in filas if f['ultima_comm'] is None]
    atrasados = [f for f in filas if f['ultima_comm'] is not None and f['horas_atraso'] > args.horas]
    al_dia = [f for f in filas if f['ultima_comm'] is not None and f['horas_atraso'] <= args.horas]

    atrasados.sort(key=lambda f: f['horas_atraso'], reverse=True)
    al_dia.sort(key=lambda f: (f['ciudad'], f['nombre']))

    print(f"\n=== Estado de comunicación de la flota ({len(filas)} vehículos"
          f"{' — ' + normalizar_ciudad(args.ciudad) if args.ciudad else ''}) ===")
    print(f"Umbral de atraso: {args.horas:.0f}h\n")

    print(f"✅ REPORTANDO AL DÍA: {len(al_dia)}")
    for f in al_dia:
        hora_txt = f['ultima_comm'].astimezone(ZONA_BOGOTA).strftime('%d/%m/%Y %H:%M')
        print(f"   {f['nombre']:<18} {f['ciudad']:<12} {f['tipologia']:<22} última: {hora_txt}")

    print(f"\n🔴 ATRASADOS (>{args.horas:.0f}h sin comunicar): {len(atrasados)}")
    for f in atrasados:
        hora_txt = f['ultima_comm'].astimezone(ZONA_BOGOTA).strftime('%d/%m/%Y %H:%M')
        print(f"   {f['nombre']:<18} {f['ciudad']:<12} {f['tipologia']:<22} "
              f"última: {hora_txt}  ({f['horas_atraso']:.1f}h atrás)")

    print(f"\n⚫ SIN REGISTRO DE COMUNICACIÓN NUNCA: {len(nunca)}")
    for f in nunca:
        print(f"   {f['nombre']:<18} {f['ciudad']:<12} {f['tipologia']:<22} (sin DeviceStatusInfo)")

    if args.excel:
        ruta = exportar_excel(al_dia, atrasados, nunca, args.ciudad)
        print(f"\nExcel guardado en: {ruta}")


if __name__ == '__main__':
    main()
