"""
reporte_regeneracion_ciudades.py -- vehiculos que necesitan regenerar el DPF, por ciudad
=========================================================================================

Para pasarle a cada coordinador la lista de su ciudad (2026-10-13, pedido del usuario).

Dos listas por ciudad:
  REGENERAR YA  -- la lampara del DPF esta encendida (el motor pide regeneracion).
                   Mismo criterio de episodio que la vigilancia de cumplimiento
                   (vigilancia_cumplimiento_regeneracion.py): un 0 de la lampara con el
                   motor apagado o con el interruptor manual activo NO la apaga.
  PROXIMOS      -- lampara apagada pero hollin >= --hollin-proximo (80 % por defecto).
                   Medido en esta flota: la lampara se enciende cuando el hollin llega a
                   125-148 % (mediana 138 %), asi que 80 % es "se viene": sirve para
                   planear la regeneracion manual antes de que la lampara se encienda.

Salida (en reportes/ y copia en Descargas):
  regeneracion_por_ciudad.xlsx   resumen + una hoja por ciudad
  regeneracion_whatsapp.txt      un mensaje por ciudad, listo para copiar y pegar

Uso:
    python reporte_regeneracion_ciudades.py
    python reporte_regeneracion_ciudades.py --hollin-proximo 90 --dias 14
    python reporte_regeneracion_ciudades.py --telegram          # ademas manda un mensaje por ciudad al bot
    python reporte_regeneracion_ciudades.py --diario --telegram
        # lo que corre alertas-telegram.yml cada 5 min: solo actua despues de las 06:00
        # (Bogota) y UNA vez al dia; si no, sale enseguida sin conectarse a Geotab. No genera
        # Excel (en GitHub no hace falta). Un mensaje por ciudad con novedad + una linea con las
        # ciudades sin novedad. Si un envio falla, reintenta solo las ciudades que faltan.

Solo LEE datos de Geotab. Demora ~1 minuto. Solo se pueden evaluar los vehiculos que
reportan hollin: los demas se cuentan aparte (no hay forma de saber su nivel).
"""
import argparse
import contextlib
import io
import json
import os
import pathlib
import shutil
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

CARPETA_HERRAMIENTAS = pathlib.Path(__file__).resolve().parent
CARPETA_REPO = CARPETA_HERRAMIENTAS.parent
sys.path.insert(0, str(CARPETA_HERRAMIENTAS))
sys.path.insert(0, str(CARPETA_REPO))

import geotab_comun as gc  # noqa: E402
import detectar_regeneracion_dpf as dd  # noqa: E402
import vigilancia_cumplimiento_regeneracion as vg  # noqa: E402

TZ = ZoneInfo('America/Bogota')
HOLLIN_PROXIMO_DEFECTO = 80
HOLLIN_MAX_VALIDO = 150          # lecturas >= 150 se descartan como ruido en el ultimo dato (ver detectar_regeneracion_dpf)
HORAS_HOLLIN_RECIENTE = 48       # el ultimo hollin debe ser de las ultimas 48 h para contar
MARCAS = ('international', 'kenworth', 'foton', 'chevrolet', 'mercedes', 'volks', 'freightliner', 'hino')
NOMBRE_CIUDAD = {
    'PROMO AMBIENTAL DISTRITO BOGOTA': 'Bogotá (Distrito)', 'PACARIBE': 'Cartagena (Pacaribe)', 'PROMO CALI': 'Cali',
    'PROMO VALLE': 'Valle', 'SER AMBIENTAL': 'Ser Ambiental', 'ESTACIÓN DE TRANSFERENCIA ZIPA': 'Zipaquirá (Estación de transferencia)',
}
RUTA_XLSX = CARPETA_REPO / 'reportes' / 'regeneracion_por_ciudad.xlsx'
RUTA_TXT = CARPETA_REPO / 'reportes' / 'regeneracion_whatsapp.txt'
DESCARGAS = pathlib.Path.home() / 'Downloads'
RUTA_ESTADO_ENVIO = CARPETA_REPO / 'reportes' / 'estado_envio_regeneracion_ciudades.json'
HORA_ENVIO_DIARIO = 6            # hora de Bogota a partir de la cual se manda el mensaje del dia (turno R1 empieza a las 5)


def fm(t):
    return t.strftime('%Y-%m-%dT%H:%M:%S.%fZ')


def ciudad_y_marca(dev, gpi, padre, raiz_hijos):
    ciudad, marca = None, None
    for g in dev.get('groups') or []:
        gid = gc.obtener_id(g)
        while gid:
            nombre = (gpi.get(gid, {}).get('name') or '').strip()
            if gid in raiz_hijos and nombre.lower() not in gc.GRUPOS_RAIZ_NO_CIUDAD and not ciudad:
                ciudad = nombre
            if not marca and nombre.lower().startswith(MARCAS):
                marca = nombre.title()
            gid = padre.get(gid)
    return NOMBRE_CIUDAD.get(ciudad, ciudad or 'Sin ciudad'), marca or 'Sin marca'


def ultimo_hollin(api, ahora, ids_validos):
    """{id_veh: (porcentaje, fecha)} con la ultima lectura de hollin de las ultimas 48 h."""
    llamadas = [('Get', {'typeName': 'StatusData', 'search': {
        'diagnosticSearch': {'id': dd.ID_DIAGNOSTICO_HOLLIN},
        'fromDate': fm(ahora - timedelta(hours=24 * (k + 1))), 'toDate': fm(ahora - timedelta(hours=24 * k))},
        'resultsLimit': 50000}) for k in range(2)]
    res = gc._multi_call_con_reintentos(api, llamadas, 'hollin')
    ult = {}
    for lote in res:
        for x in lote or []:
            v = gc.obtener_id(x['device'])
            try:
                val = float(x['data'])
            except (TypeError, ValueError):
                continue
            t = pd.Timestamp(x['dateTime'])
            if v in ids_validos and val < HOLLIN_MAX_VALIDO and (v not in ult or t > ult[v][1]):
                ult[v] = (val, t)
    return {v: u for v, u in ult.items() if (ahora - u[1]) <= timedelta(hours=HORAS_HOLLIN_RECIENTE)}


def fmt_fecha(t):
    return pd.Timestamp(t).tz_convert(TZ).strftime('%d-%b %H:%M').lower() if t is not None else ''


def fmt_h(h):
    return f'{h:.1f}'.replace('.', ',')


def construir_filas(api, vehiculos, ahora, dias, hollin_proximo):
    devs = {d['id']: d for d in api.get('Device')}
    gpi, padre, _ = gc.obtener_arbol_grupos(api)
    raiz = next((g for g in gpi.values() if (g.get('name') or '').strip().startswith('*')), None)
    raiz_hijos = {gc.obtener_id(h) for h in (raiz or {}).get('children') or []}

    print(f'Reconstruyendo el estado de la lámpara de {len(vehiculos)} vehículos ({dias} días)...')
    with contextlib.redirect_stdout(io.StringIO()):          # el backfill imprime una linea por vehiculo
        estado = vg.ciclo_backfill(api, vehiculos, dias)
    hollin = ultimo_hollin(api, ahora, {v['id'] for v in vehiculos})

    filas, sin_hollin, total_por_ciudad = [], [], {}
    for v in vehiculos:
        e = estado.get(v['id'], {})
        ciudad, marca = ciudad_y_marca(devs[v['id']], gpi, padre, raiz_hijos)
        total_por_ciudad[ciudad] = total_por_ciudad.get(ciudad, 0) + 1
        h = hollin.get(v['id'])
        lamp = e.get('lamp_on_desde')
        if h is None:
            sin_hollin.append((ciudad, v['name']))
        base = {'Ciudad': ciudad, 'Vehículo': v['name'], 'Marca': marca, 'Hollín %': round(h[0]) if h else None,
                'Hollín leído': fmt_fecha(h[1]) if h else ''}
        if lamp:
            desde = pd.Timestamp(lamp)
            horas_motor = float(e.get('seg_motor_episodio') or 0) / 3600
            horas_total = (ahora - desde).total_seconds() / 3600
            obs = []
            if horas_total >= 24 and horas_motor < 1:
                obs.append('casi sin motor encendido: posible vehículo parqueado o fuera de servicio')
            if horas_total >= 24 * dias - 1:
                obs.append(f'lámpara encendida durante toda la ventana de {dias} días o más')
            if e.get('interruptor_activado_desde'):
                obs.append(f"interruptor manual activado desde {fmt_fecha(e['interruptor_activado_desde'])}")
            filas.append({**base, 'Prioridad': 'REGENERAR YA', 'Lámpara desde': fmt_fecha(desde),
                          'Horas con lámpara': round(horas_total, 1), 'Horas de motor con lámpara': round(horas_motor, 1),
                          'Observación': '; '.join(obs)})
        elif h and h[0] >= hollin_proximo:
            filas.append({**base, 'Prioridad': 'PRÓXIMO', 'Lámpara desde': '', 'Horas con lámpara': None,
                          'Horas de motor con lámpara': None, 'Observación': f'hollín desde {hollin_proximo} %, lámpara aún apagada'})
    return filas, sin_hollin, total_por_ciudad


def mensaje_ciudad(ciudad, filas, ahora, hollin_proximo, total=0, sin_dato=0):
    ya = sorted([f for f in filas if f['Prioridad'] == 'REGENERAR YA'], key=lambda f: -(f['Horas de motor con lámpara'] or 0))
    prox = sorted([f for f in filas if f['Prioridad'] == 'PRÓXIMO'], key=lambda f: -(f['Hollín %'] or 0))
    L = [f'🔧 REGENERACIÓN DPF — {ciudad}', f'{ahora.astimezone(TZ):%d-%b-%Y %H:%M}'.lower(), '']
    if ya:
        L.append(f'🔴 REGENERAR YA — lámpara encendida ({len(ya)})')
        for f in ya:
            extra = f" · hollín {f['Hollín %']} %" if f['Hollín %'] is not None else ''
            nota = ' · ⚠ parqueado o fuera de servicio' if 'parqueado' in f['Observación'] else ''
            man = ' · interruptor manual activo' if 'interruptor' in f['Observación'] else ''
            L.append(f"• {f['Vehículo']} · desde {f['Lámpara desde']} · {fmt_h(f['Horas de motor con lámpara'])} h de motor{extra}{man}{nota}")
        L.append('')
    if prox:
        L.append(f'🟡 PRÓXIMOS — hollín desde {hollin_proximo} %, lámpara apagada ({len(prox)})')
        for f in prox:
            L.append(f"• {f['Vehículo']} · hollín {f['Hollín %']} %")
        L.append('')
    if not ya and not prox:
        L.append('✅ Sin vehículos para regenerar por ahora.')
        L.append('')
    L.append('La lámpara se enciende cuando el hollín llega a 125 % o más.')
    if sin_dato:
        L.append(f'({sin_dato} de {total} vehículos de esta ciudad no reportan hollín: solo se les detecta la lámpara encendida.)')
    return '\n'.join(L)


def escribir_excel(resumen, df, todas_ciudades):
    cols = ['Prioridad', 'Vehículo', 'Marca', 'Hollín %', 'Hollín leído', 'Lámpara desde', 'Horas con lámpara', 'Horas de motor con lámpara', 'Observación']
    RUTA_XLSX.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(RUTA_XLSX, engine='openpyxl') as w:
        pd.DataFrame(resumen).to_excel(w, sheet_name='Resumen', index=False)
        for c in todas_ciudades:
            d = df[df['Ciudad'] == c][cols] if len(df) else pd.DataFrame(columns=cols)
            d = d.sort_values(['Prioridad', 'Hollín %'], ascending=[False, False]) if len(d) else d
            d.to_excel(w, sheet_name=c[:31].replace('/', '-'), index=False)
        for ws in w.book.worksheets:
            for col in ws.columns:
                ws.column_dimensions[col[0].column_letter].width = min(60, max(12, max(len(str(x.value or '')) for x in col) + 2))
            ws.freeze_panes = 'A2'


def cargar_estado_envio():
    try:
        return json.loads(RUTA_ESTADO_ENVIO.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def guardar_estado_envio(estado):
    RUTA_ESTADO_ENVIO.parent.mkdir(parents=True, exist_ok=True)
    RUTA_ESTADO_ENVIO.write_text(json.dumps(estado, ensure_ascii=False), encoding='utf-8')


def avisar_github(corrio):
    """Le dice al workflow si hubo corrida real (para guardar el cache solo entonces)."""
    salida = os.environ.get('GITHUB_OUTPUT')
    if salida:
        with open(salida, 'a', encoding='utf-8') as f:
            f.write(f'generado={"true" if corrio else "false"}\n')


def enviar_por_ciudad(mensajes_por_ciudad, hay_novedad, hoy, enviar):
    """Manda un mensaje por ciudad con novedad y una linea con las que no tienen. `enviar` devuelve
    True si el envio salio. Solo se marca como enviado lo que salio (mismo principio que
    telegram_alertas.py): si algo falla, la proxima corrida reintenta solo lo que falta, sin
    repetir lo que ya llego. Devuelve True si no quedo nada pendiente."""
    estado = cargar_estado_envio()
    enviadas = set(estado.get('enviadas', [])) if estado.get('fecha') == hoy else set()
    con_novedad = [c for c in mensajes_por_ciudad if hay_novedad[c]]
    sin_novedad = [c for c in mensajes_por_ciudad if not hay_novedad[c]]
    pendientes = [(c, mensajes_por_ciudad[c]) for c in con_novedad]
    if sin_novedad:
        pendientes.append(('_sin_novedad', '✅ Regeneración DPF — sin novedades hoy en: ' + ', '.join(sin_novedad) + '.'))
    todo_ok = True
    for clave, texto in pendientes:
        if clave in enviadas:
            continue
        if enviar(texto):
            enviadas.add(clave)
            guardar_estado_envio({'fecha': hoy, 'enviadas': sorted(enviadas)})
        else:
            todo_ok = False
            print(f'*** No se pudo enviar el mensaje de {clave}; se reintenta en la siguiente corrida ***')
    if todo_ok:
        guardar_estado_envio({'fecha': hoy, 'enviadas': sorted(enviadas), 'completo': True})
    return todo_ok


RUTA_ESTADO_CRUCES = CARPETA_REPO / 'reportes' / 'estado_cruces_hollin.json'
HISTERESIS_HOLLIN = 15            # el hollin debe bajar de (umbral - 15) para que un nuevo cruce vuelva a avisar
VENTANA_CRUCES_HORAS = 3          # el hollin llega cada ~30 min por vehiculo: 3 h de lecturas alcanzan de sobra


def revisar_cruces(api, ahora, umbral, enviar):
    """Avisa en cuanto un vehiculo CRUZA el umbral de hollin (por defecto 80 %), sin esperar al mensaje
    diario. Un solo aviso por cruce: el vehiculo queda "notificado" hasta que su hollin baje de
    (umbral - HISTERESIS_HOLLIN), por ejemplo tras regenerar; ahi un nuevo cruce vuelve a avisar.
    Primera corrida (sin estado): los vehiculos que YA estan por encima se marcan como notificados
    sin mandar nada (los cubre el mensaje diario), para no mandar un diluvio al activarlo.
    Devuelve True si el estado cambio (para que el workflow guarde el cache solo entonces)."""
    try:
        estado = json.loads(RUTA_ESTADO_CRUCES.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        estado = {}
    notificados = dict(estado.get('notificados', {}))
    dispositivos = {d['id']: d for d in api.get('Device') if not d.get('activeTo') or pd.Timestamp(d['activeTo']) > ahora}
    lecturas = api.get('StatusData', search={'diagnosticSearch': {'id': dd.ID_DIAGNOSTICO_HOLLIN},
                                             'fromDate': fm(ahora - timedelta(hours=VENTANA_CRUCES_HORAS)), 'toDate': fm(ahora)},
                       resultsLimit=50000) or []
    ultimo = {}
    for x in lecturas:
        v = gc.obtener_id(x['device'])
        try:
            val = float(x['data'])
        except (TypeError, ValueError):
            continue
        t = pd.Timestamp(x['dateTime'])
        if v in dispositivos and val < HOLLIN_MAX_VALIDO and (v not in ultimo or t > ultimo[v][1]):
            ultimo[v] = (val, t)
    cambio = False

    if not estado.get('sembrado'):
        notificados = {dispositivos[v]['name']: ahora.isoformat() for v, (val, _) in ultimo.items() if val >= umbral}
        guardar = {'sembrado': True, 'notificados': notificados}
        RUTA_ESTADO_CRUCES.parent.mkdir(parents=True, exist_ok=True)
        RUTA_ESTADO_CRUCES.write_text(json.dumps(guardar, ensure_ascii=False), encoding='utf-8')
        print(f'Primera corrida: {len(notificados)} vehículos ya estaban sobre {umbral:g} % y quedan como avisados (los cubre el mensaje diario).')
        return True

    for nombre in list(notificados):                      # los que bajaron de verdad (regeneraron) vuelven a poder avisar
        v = next((i for i, d in dispositivos.items() if d['name'] == nombre), None)
        if v in ultimo and ultimo[v][0] < umbral - HISTERESIS_HOLLIN:
            del notificados[nombre]
            cambio = True

    nuevos = [(v, val) for v, (val, _) in ultimo.items() if val >= umbral and dispositivos[v]['name'] not in notificados]
    if nuevos:
        gpi, padre, _ = gc.obtener_arbol_grupos(api)
        raiz = next((g for g in gpi.values() if (g.get('name') or '').strip().startswith('*')), None)
        raiz_hijos = {gc.obtener_id(h) for h in (raiz or {}).get('children') or []}
        por_ciudad = {}
        for v, val in nuevos:
            ciudad, _ = ciudad_y_marca(dispositivos[v], gpi, padre, raiz_hijos)
            por_ciudad.setdefault(ciudad, []).append((dispositivos[v]['name'], round(val)))
        lineas = [f'🟡 DPF PRÓXIMO A REGENERAR — hollín desde {umbral:g} %']
        for ciudad in sorted(por_ciudad):
            lineas.append(f'• {ciudad}: ' + ', '.join(f'{n} ({val} %)' for n, val in sorted(por_ciudad[ciudad], key=lambda x: -x[1])))
        lineas.append('La lámpara se enciende cuando el hollín llega a 125 % o más. Conviene planear la regeneración.')
        if enviar('\n'.join(lineas)):
            for v, _ in nuevos:
                notificados[dispositivos[v]['name']] = ahora.isoformat()
            cambio = True
            print(f'Avisados {len(nuevos)} vehículos que cruzaron {umbral:g} %: ' + ', '.join(dispositivos[v]['name'] for v, _ in nuevos))
        else:
            print('*** No se pudo enviar el aviso de cruce; se reintenta en la siguiente corrida ***')
    else:
        print(f'Sin cruces nuevos de {umbral:g} % ({len(ultimo)} vehículos con hollín reciente).')
    if cambio:
        RUTA_ESTADO_CRUCES.write_text(json.dumps({'sembrado': True, 'notificados': notificados}, ensure_ascii=False), encoding='utf-8')
    return cambio


def main():
    ap = argparse.ArgumentParser(description='Vehículos que necesitan regenerar el DPF, por ciudad.')
    ap.add_argument('--hollin-proximo', type=float, default=HOLLIN_PROXIMO_DEFECTO, help='Hollín mínimo (%%) para la lista de próximos.')
    ap.add_argument('--dias', type=int, default=14, help='Días de historia para reconstruir el estado de la lámpara.')
    ap.add_argument('--telegram', action='store_true', help='Mandar un mensaje por ciudad al bot de Telegram.')
    ap.add_argument('--diario', action='store_true', help=f'Solo corre despues de las {HORA_ENVIO_DIARIO}:00 (Bogota) y una vez al dia; sin Excel.')
    ap.add_argument('--cruces', action='store_true', help='Solo avisa (Telegram) de los vehículos que ACABAN de cruzar el umbral de hollín; para correr cada 5 min.')
    args = ap.parse_args()

    if args.cruces:
        ahora = pd.Timestamp(datetime.now(timezone.utc))
        api = gc.conectar_geotab()
        cambio = revisar_cruces(api, ahora, args.hollin_proximo, vg.enviar_telegram)
        avisar_github(cambio)
        return

    hoy = datetime.now(TZ).strftime('%Y-%m-%d')
    if args.diario:
        e = cargar_estado_envio()
        if datetime.now(TZ).hour < HORA_ENVIO_DIARIO or (e.get('fecha') == hoy and e.get('completo')):
            print('Regeneración por ciudad: hoy ya se envió o aún no es la hora.')
            avisar_github(False)
            return

    ahora = pd.Timestamp(datetime.now(timezone.utc))
    api = gc.conectar_geotab()
    devs = api.get('Device')
    regla, _ = gc.buscar_regla(api, vg.NOMBRE_REGLA_ALCANCE, reglas=api.get('Rule'))
    gpi, padre, _ = gc.obtener_arbol_grupos(api)
    vehiculos = gc.resolver_vehiculos_en_alcance(devs, regla, gpi, padre)

    filas, sin_hollin, total_por_ciudad = construir_filas(api, vehiculos, ahora, args.dias, args.hollin_proximo)
    total = sum(total_por_ciudad.values())
    df = pd.DataFrame(filas)
    todas_ciudades = sorted(total_por_ciudad)      # TODAS las ciudades, tambien las que no tienen nada que regenerar

    resumen = []
    for c in todas_ciudades:
        fc = [f for f in filas if f['Ciudad'] == c]
        resumen.append({'Ciudad': c, 'Vehículos evaluados': total_por_ciudad[c], 'Regenerar ya': sum(1 for f in fc if f['Prioridad'] == 'REGENERAR YA'),
                        'Próximos': sum(1 for f in fc if f['Prioridad'] == 'PRÓXIMO'),
                        'Vehículos sin dato de hollín': sum(1 for cc, _ in sin_hollin if cc == c)})
    if not args.diario:                      # en GitHub no hace falta Excel (ni openpyxl instalado)
        escribir_excel(resumen, df, todas_ciudades)

    # --- un mensaje por ciudad (sirve igual para WhatsApp y para Telegram)
    mensajes = {c: mensaje_ciudad(c, [f for f in filas if f['Ciudad'] == c], ahora, args.hollin_proximo, total_por_ciudad[c],
                                  sum(1 for cc, _ in sin_hollin if cc == c)) for c in todas_ciudades}
    RUTA_TXT.parent.mkdir(parents=True, exist_ok=True)
    SEPARADOR = '\n\n' + '─' * 28 + '\n\n'
    RUTA_TXT.write_text(SEPARADOR.join(mensajes.values()), encoding='utf-8')
    if not args.diario:
        for ruta in (RUTA_XLSX, RUTA_TXT):
            try:
                shutil.copyfile(ruta, DESCARGAS / ruta.name)
            except OSError as e:
                print(f'(no se pudo copiar {ruta.name} a Descargas: {e})')

    n_ya = sum(1 for f in filas if f['Prioridad'] == 'REGENERAR YA')
    n_prox = sum(1 for f in filas if f['Prioridad'] == 'PRÓXIMO')
    print(f'\nVehículos evaluados: {total} | sin dato de hollín: {len(sin_hollin)} | regenerar ya: {n_ya} | próximos: {n_prox}\n')
    print(pd.DataFrame(resumen).to_string(index=False))
    print('\n' + '=' * 60 + '\n')
    print(SEPARADOR.join(mensajes.values()))

    if args.telegram:
        hay_novedad = {c: any(f['Ciudad'] == c for f in filas) for c in todas_ciudades}
        completo = enviar_por_ciudad(mensajes, hay_novedad, hoy, vg.enviar_telegram)
        print('\nTelegram: enviado.' if completo else '\n*** Telegram: quedaron mensajes sin enviar ***')
    avisar_github(True)


if __name__ == '__main__':
    main()
