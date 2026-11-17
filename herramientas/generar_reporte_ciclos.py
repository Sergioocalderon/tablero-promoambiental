"""
generar_reporte_ciclos.py -- ciclos operativos (salida/entrada de base) en un
HTML autocontenido, listo para abrir con doble clic
============================================================================

Reemplaza el flujo manual "correr script -> exportar Excel -> abrir el
dashboard -> subir el Excel a mano". Este script hace todo de una vez: trae
los Trip de Geotab, calcula los ciclos contra la geocerca de la base (mismo
algoritmo ya validado con el usuario -- ver herramientas/README.md /
conversacion 2026-09-16), y los incrusta directo en una copia de
plantilla_ciclos_operativos.html. El resultado es un archivo HTML que ya
trae los datos adentro (no hace falta Excel ni "Cargar Excel" a mano) --
"actualizar" el reporte es simplemente volver a correr este script.

Uso:
    python generar_reporte_ciclos.py                 # ultimos 7 dias, Bogota
    python generar_reporte_ciclos.py --dias 14

Salida:
    reportes/ciclos_operativos.html
    (y copias en Descargas y en el servidor de Mantenimiento, para que quede
    disponible sin que el usuario tenga que reenviarlo a mano)
"""
import argparse
import json
import pathlib
import shutil
import sys
from datetime import datetime, timedelta, timezone

import geotab_comun as gc

ID_ZONA_BASE_BOGOTA = 'b28CB'  # "BASE DE OPERACIONES PROMOAMBIENTAL DISTRITO"
TZ_LOCAL = timezone(timedelta(hours=-5))

CARPETA_HERRAMIENTAS = pathlib.Path(__file__).resolve().parent
CARPETA_REPO = CARPETA_HERRAMIENTAS.parent
RUTA_PLANTILLA = CARPETA_HERRAMIENTAS / 'plantilla_ciclos_operativos.html'
RUTA_SALIDA_REPO = CARPETA_REPO / 'reportes' / 'ciclos_operativos.html'
RUTA_SALIDA_DESCARGAS = pathlib.Path.home() / 'Downloads' / 'ciclos_operativos.html'
# Servidor compartido de Mantenimiento Distrito -- carpeta de Telemetria (pedido
# del usuario 2026-09-16, ya tenia ahi a mano el Excel de ciclos anterior). Si
# el servidor esta caido o la unidad Z: no esta mapeada en la sesion que corre
# la tarea programada, esta copia simplemente se salta (ver bloque try/except
# en main) -- nunca debe tumbar la generacion de las otras dos copias.
RUTA_SALIDA_SERVIDOR = pathlib.Path(r'Z:\1. MANTENIMIENTO DISTRITO\Telemetria') / 'ciclos_operativos.html'

RUTA_EXCEL_REPO = CARPETA_REPO / 'reportes' / 'ciclos_operativos.xlsx'
RUTA_EXCEL_DESCARGAS = pathlib.Path.home() / 'Downloads' / 'ciclos_operativos.xlsx'
RUTA_EXCEL_SERVIDOR = RUTA_SALIDA_SERVIDOR.with_suffix('.xlsx')

MARCADOR = '// __DATOS_REALES__'


def punto_en_poligono(lon, lat, poligono):
    n = len(poligono)
    dentro = False
    x1, y1 = poligono[0]
    for i in range(1, n + 1):
        x2, y2 = poligono[i % n]
        if lat > min(y1, y2) and lat <= max(y1, y2) and lon <= max(x1, x2):
            if y1 != y2:
                x_interseccion = (lat - y1) * (x2 - x1) / (y2 - y1) + x1
            if x1 == x2 or lon <= x_interseccion:
                dentro = not dentro
        x1, y1 = x2, y2
    return dentro


def ciudad_de(device, grupos_por_id, padre_de):
    for g in (device.get('groups') or []):
        gid = g['id'] if isinstance(g, dict) else g
        actual, visitos = gid, 0
        while actual and visitos < 15:
            info = grupos_por_id.get(actual)
            if not info:
                break
            nombre = (info.get('name') or '').upper()
            if 'BOGOTA' in nombre or 'BOGOTÁ' in nombre or 'DISTRITO' in nombre:
                return 'Bogota'
            actual = padre_de.get(actual)
            visitos += 1
    return None


def tipologia_de(device, mapa_tipologia):
    for g in (device.get('groups') or []):
        gid = g['id'] if isinstance(g, dict) else g
        tip = mapa_tipologia.get(gid)
        if tip:
            return tip
    return None


def marca_de(device, grupos_por_id, padre_de):
    for g in (device.get('groups') or []):
        gid = g['id'] if isinstance(g, dict) else g
        actual, visitos = gid, 0
        while actual and visitos < 15:
            info = grupos_por_id.get(actual)
            if not info:
                break
            nombre = info.get('name') or ''
            if ' - ' in nombre and nombre.split(' - ')[0].isupper():
                return nombre
            actual = padre_de.get(actual)
            visitos += 1
    return 'DESCONOCIDA'


def calcular_ciclos(api, devices, id_zona, dias):
    grupos_por_id, padre_de, mapa_tipologia = gc.obtener_arbol_grupos(api)

    bogota = [d for d in devices if ciudad_de(d, grupos_por_id, padre_de) == 'Bogota']

    # Excluir furgones (carro-taller) y camionetas N400 -- pedido del usuario
    # 2026-09-16, no son parte de la flota de recoleccion.
    incluidos = []
    for d in bogota:
        tip = tipologia_de(d, mapa_tipologia) or ''
        marca = marca_de(d, grupos_por_id, padre_de)
        if tip == 'FURGON' or 'N400' in marca.upper():
            continue
        incluidos.append(d)

    zona = api.get('Zone', search={'id': id_zona})[0]
    poligono = [(p['x'], p['y']) for p in zona['points']]

    def estado_de(stop_point):
        if not stop_point:
            return 'fuera'
        return 'dentro' if punto_en_poligono(stop_point['x'], stop_point['y'], poligono) else 'fuera'

    fin = datetime.now(timezone.utc)
    inicio = fin - timedelta(days=dias)

    llamadas = [
        ('Get', {'typeName': 'Trip', 'search': {'deviceSearch': {'id': d['id']}, 'fromDate': inicio.isoformat(), 'toDate': fin.isoformat()}})
        for d in incluidos
    ]
    resultados = api.multi_call(llamadas) if llamadas else []

    ciclos = []
    for d, trips in zip(incluidos, resultados):
        trips = sorted(trips or [], key=lambda t: t['start'])
        stops = [{'trip_start': t['start'], 'trip_stop': t['stop'], 'estado': estado_de(t.get('stopPoint'))} for t in trips]

        hora_salida_actual = None
        contador_por_dia = {}
        for i, s in enumerate(stops):
            estado_anterior = stops[i - 1]['estado'] if i > 0 else None
            estado_actual = s['estado']

            if estado_anterior == 'dentro' and estado_actual == 'fuera':
                hora_salida_actual = s['trip_start']
            elif estado_anterior == 'fuera' and estado_actual == 'dentro' and hora_salida_actual is not None:
                hora_entrada = s['trip_stop']
                clave_dia = hora_salida_actual.astimezone(TZ_LOCAL).strftime('%Y-%m-%d')
                contador_por_dia[clave_dia] = contador_por_dia.get(clave_dia, 0) + 1
                duracion_min = (hora_entrada - hora_salida_actual).total_seconds() / 60
                ciclos.append({
                    'movil': d.get('name'), 'estado': 'Cerrado',
                    'fSalida': hora_salida_actual.astimezone(TZ_LOCAL).strftime('%Y-%m-%d'),
                    'hSalida': hora_salida_actual.astimezone(TZ_LOCAL).strftime('%H:%M:%S'),
                    'fEntrada': hora_entrada.astimezone(TZ_LOCAL).strftime('%Y-%m-%d'),
                    'hEntrada': hora_entrada.astimezone(TZ_LOCAL).strftime('%H:%M:%S'),
                    'durMin': round(duracion_min, 1), 'ciclo': contador_por_dia[clave_dia],
                })
                hora_salida_actual = None

        if hora_salida_actual is not None:
            clave_dia = hora_salida_actual.astimezone(TZ_LOCAL).strftime('%Y-%m-%d')
            contador_por_dia[clave_dia] = contador_por_dia.get(clave_dia, 0) + 1
            ciclos.append({
                'movil': d.get('name'), 'estado': 'En ruta',
                'fSalida': hora_salida_actual.astimezone(TZ_LOCAL).strftime('%Y-%m-%d'),
                'hSalida': hora_salida_actual.astimezone(TZ_LOCAL).strftime('%H:%M:%S'),
                'fEntrada': '', 'hEntrada': '', 'durMin': None, 'ciclo': contador_por_dia[clave_dia],
            })

    ciclos.sort(key=lambda c: (c['movil'], c['fSalida'], c['hSalida']))
    return ciclos, len(incluidos)


def generar_html(ciclos):
    if not RUTA_PLANTILLA.exists():
        raise SystemExit(f"No se encontro la plantilla: {RUTA_PLANTILLA}")
    plantilla = RUTA_PLANTILLA.read_text(encoding='utf-8')
    if MARCADOR not in plantilla:
        raise SystemExit(f"La plantilla no tiene el marcador {MARCADOR!r} -- no se puede incrustar los datos.")

    generado_en = datetime.now(TZ_LOCAL).strftime('%Y-%m-%d %H:%M')
    linea_nueva = (
        'var DATOS_REALES = ' + json.dumps(ciclos, ensure_ascii=False) + ';'
        ' var GENERADO_EN = ' + json.dumps(generado_en, ensure_ascii=False) + '; ' + MARCADOR
    )

    lineas = plantilla.split('\n')
    reemplazadas = 0
    for i, linea in enumerate(lineas):
        if MARCADOR in linea:
            lineas[i] = linea_nueva
            reemplazadas += 1
    if reemplazadas != 1:
        raise SystemExit(f"Se esperaba encontrar el marcador en 1 linea, se encontro en {reemplazadas}.")

    return '\n'.join(lineas)


UMBRAL_HORAS_EXCEL = 8


def horas_del_ciclo(c, ahora_local):
    """Horas del ciclo; si sigue fuera de base, contra el momento de generacion."""
    if c['durMin'] is not None:
        return c['durMin'] / 60
    salida = datetime.strptime(f"{c['fSalida']} {c['hSalida']}", '%Y-%m-%d %H:%M:%S').replace(tzinfo=TZ_LOCAL)
    return (ahora_local - salida).total_seconds() / 3600


def generar_excel(ciclos, ruta):
    """Excel con dos hojas: 'Ciclos' (detalle, >8h resaltado) y 'Resumen por movil'."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    ahora_local = datetime.now(TZ_LOCAL)
    relleno_rojo = PatternFill('solid', fgColor='FBE1E1')
    fuente_rojo = Font(color='A01C1C', bold=True)
    encabezado_fill = PatternFill('solid', fgColor='4C8323')
    encabezado_font = Font(color='FFFFFF', bold=True)

    wb = Workbook()
    ws = wb.active
    ws.title = 'Ciclos'
    columnas = ['Móvil', 'Estado', 'Fecha salida', 'Hora salida', 'Fecha entrada', 'Hora entrada',
                'Duración (horas)', 'Duración (h:mm)', 'N° ciclo del día', f'Más de {UMBRAL_HORAS_EXCEL}h']
    ws.append(columnas)

    por_movil = {}
    for c in ciclos:
        h = horas_del_ciclo(c, ahora_local)
        excede = h > UMBRAL_HORAS_EXCEL
        hh, mm = int(h), int(round((h - int(h)) * 60))
        if mm == 60:
            hh, mm = hh + 1, 0
        ws.append([
            c['movil'], 'Fuera de base' if c['estado'] == 'En ruta' else c['estado'],
            c['fSalida'], c['hSalida'], c['fEntrada'] or '', c['hEntrada'] or '',
            round(h, 2), f'{hh}:{mm:02d}', c['ciclo'], 'Sí' if excede else 'No',
        ])
        if excede:
            for celda in ws[ws.max_row]:
                celda.fill = relleno_rojo
                celda.font = fuente_rojo
        r = por_movil.setdefault(c['movil'], {'n': 0, 'horas': [], 'exceden': 0, 'fuera': 0})
        r['n'] += 1
        r['horas'].append(h)
        r['exceden'] += 1 if excede else 0
        r['fuera'] += 1 if c['estado'] == 'En ruta' else 0

    for celda in ws[1]:
        celda.fill, celda.font = encabezado_fill, encabezado_font
        celda.alignment = Alignment(horizontal='center')
    ws.freeze_panes = 'A2'
    ws.auto_filter.ref = ws.dimensions
    for i, ancho in enumerate([16, 14, 13, 12, 13, 12, 16, 15, 15, 12], start=1):
        ws.column_dimensions[get_column_letter(i)].width = ancho

    ws2 = wb.create_sheet('Resumen por móvil')
    ws2.append(['Móvil', 'Ciclos', 'Duración promedio (h)', 'Duración máxima (h)',
                f'Ciclos de más de {UMBRAL_HORAS_EXCEL}h', 'Fuera de base ahora'])
    for movil in sorted(por_movil):
        r = por_movil[movil]
        ws2.append([movil, r['n'], round(sum(r['horas']) / len(r['horas']), 2),
                    round(max(r['horas']), 2), r['exceden'], r['fuera']])
        if r['exceden']:
            for celda in ws2[ws2.max_row]:
                celda.fill = relleno_rojo
    for celda in ws2[1]:
        celda.fill, celda.font = encabezado_fill, encabezado_font
        celda.alignment = Alignment(horizontal='center', wrap_text=True)
    ws2.freeze_panes = 'A2'
    ws2.auto_filter.ref = ws2.dimensions
    for i, ancho in enumerate([16, 10, 20, 20, 22, 20], start=1):
        ws2.column_dimensions[get_column_letter(i)].width = ancho

    ruta.parent.mkdir(parents=True, exist_ok=True)
    wb.save(ruta)


def main():
    parser = argparse.ArgumentParser(description='Genera el HTML de ciclos operativos con datos reales incrustados.')
    parser.add_argument('--dias', type=int, default=7, help='Dias hacia atras a analizar (por defecto 7).')
    args = parser.parse_args()

    api = gc.conectar_geotab()
    devices = api.get('Device')

    ciclos, n_vehiculos = calcular_ciclos(api, devices, ID_ZONA_BASE_BOGOTA, args.dias)
    print(f"Vehiculos incluidos: {n_vehiculos}")
    print(f"Ciclos calculados: {len(ciclos)} ({sum(1 for c in ciclos if c['estado']=='Cerrado')} cerrados, {sum(1 for c in ciclos if c['estado']=='En ruta')} en ruta)")

    html_final = generar_html(ciclos)

    RUTA_SALIDA_REPO.parent.mkdir(parents=True, exist_ok=True)
    RUTA_SALIDA_REPO.write_text(html_final, encoding='utf-8')
    print(f"Guardado en: {RUTA_SALIDA_REPO}")

    try:
        RUTA_SALIDA_DESCARGAS.write_text(html_final, encoding='utf-8')
        print(f"Copia en: {RUTA_SALIDA_DESCARGAS}")
    except OSError as e:
        print(f"(no se pudo copiar a Descargas: {e})")

    try:
        RUTA_SALIDA_SERVIDOR.write_text(html_final, encoding='utf-8')
        print(f"Copia en servidor: {RUTA_SALIDA_SERVIDOR}")
    except OSError as e:
        print(f"(no se pudo copiar al servidor -- unidad Z: no disponible en esta sesion?: {e})")

    # Excel con el detalle (mismas tres ubicaciones que el HTML).
    generar_excel(ciclos, RUTA_EXCEL_REPO)
    print(f"Excel guardado en: {RUTA_EXCEL_REPO}")
    for destino in (RUTA_EXCEL_DESCARGAS, RUTA_EXCEL_SERVIDOR):
        try:
            shutil.copyfile(RUTA_EXCEL_REPO, destino)
            print(f"Copia Excel en: {destino}")
        except OSError as e:
            print(f"(no se pudo copiar el Excel a {destino}: {e})")


if __name__ == '__main__':
    # CAMBIO (2026-10-12): la tarea programada corre con pythonw.exe (sin ventana de
    # terminal, que le quitaba el foco al usuario cada hora). Sin consola, sys.stdout es
    # None y los mensajes y errores se perderian: se guardan en reportes/ciclos_log.txt
    # (solo la ultima corrida). Al correrlo a mano desde una terminal no cambia nada.
    if sys.stdout is None or sys.stderr is None:
        _log = open(CARPETA_REPO / 'reportes' / 'ciclos_log.txt', 'w', encoding='utf-8', buffering=1)
        sys.stdout = sys.stderr = _log
        print(f"Corrida {datetime.now():%Y-%m-%d %H:%M:%S} (sin consola)")
    main()
