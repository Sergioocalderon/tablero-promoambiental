"""
calificacion_camara.py -- calificacion PROVISIONAL de conductores con los eventos de la camara
=============================================================================================

Pedido del usuario (2026-10-21): calificar al conductor con los eventos de la camara IOX-SMARTER AI
mientras se validan los clips. Es el modelo propio propuesto ese dia, NO el Driver Safety Scorecard de
Geotab (que por defecto solo pesa 6 reglas, ninguna de camara salvo cinturon).

Modelo
  * Cada evento suma PUNTOS DE PENALIZACION segun su peso (tabla PESOS).
  * Indice = puntos por cada 100 km recorridos (menor = mejor). Se normaliza por distancia para comparar
    conductores que recorren distinto.
  * Solo es "evaluable" con MIN_KM o mas en el periodo; con menos se marca "datos insuficientes".
  * NO puntuan: lente obstruido, cubierta retirada y camara desmontada (fallas del equipo), el boton (lo
    pulsa el conductor a proposito) y el bostezo (indicio de fatiga, se cuenta aparte como informativo).
  * No se convierte a nota 0-100 todavia: hacerlo con percentiles requiere varios conductores.

Agrupa por CONDUCTOR si el viaje/evento tiene uno identificado (tarjeta NFC); si no, por vehiculo
("sin conductor identificado"). El periodo de cada vehiculo empieza cuando la camara se conecto por
primera vez (para no diluir con km anteriores a la camara).

Los eventos son detecciones automaticas SIN validar contra el video: no usar esta calificacion para
consecuencias disciplinarias hasta medir el porcentaje de aciertos.

Uso:
    python calificacion_camara.py                    # ultimos 7 dias, todos los vehiculos con camara
    python calificacion_camara.py --dias 30
    python calificacion_camara.py --vehiculo 1167    # solo ese vehiculo
Salida: reportes/calificacion_camara_<AAAAMMDD>.xlsx (copia en Descargas). Solo LEE datos de Geotab.
"""
import argparse
import collections
import pathlib
import shutil
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd

CARPETA_HERRAMIENTAS = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(CARPETA_HERRAMIENTAS))
import geotab_comun as gc  # noqa: E402

TZ = ZoneInfo('America/Bogota')
CARPETA_REPO = CARPETA_HERRAMIENTAS.parent
DESCARGAS = pathlib.Path.home() / 'Downloads'

# nombre de la regla de Geotab -> (etiqueta, puntos por evento)
PESOS = {
    'Driver Distracted': ('Conductor distraído', 4),
    'Camera Detected No Seatbelt': ('Sin cinturón', 3),
    'Rolling Stop': ('Pasó señal de alto', 3),
    'Tailgating/Close Following': ('Distancia de seguimiento', 2),
    'Harsh Braking (New)': ('Frenada brusca', 2),
    'Harsh Cornering (New)': ('Giro brusco', 2),
    'Harsh Acceleration (New)': ('Aceleración brusca', 1),
    'Smoking': ('Fumando', 1),
}
ID_BOSTEZO = 'a2ASkwuYP9UKmWRAJxopslg'        # Bostezo del conductor detectado: informativo, no puntua
PREFIJO_DIAG_CAMARA = 'Cámara IOX-SMARTER AI'  # su primera muestra = cuando se conecto la camara
MIN_KM = 50
DIAS_BUSCAR_CAMARA = 60


def fm(t):
    return t.strftime('%Y-%m-%dT%H:%M:%S.%fZ')


def vehiculos_con_camara(api, ahora, filtro):
    """Devuelve {device_id: (nombre, inicio_camara)} con los vehiculos cuya camara reporto en los ultimos 60 dias."""
    diag = next((d for d in api.get('Diagnostic') if d['name'].startswith(PREFIJO_DIAG_CAMARA)), None)
    if diag is None:
        return {}
    devs = {d['id']: d for d in api.get('Device')}
    llam = [('Get', {'typeName': 'StatusData', 'search': {'diagnosticSearch': {'id': diag['id']},
            'fromDate': ahora - timedelta(days=k + 10), 'toDate': ahora - timedelta(days=k)}, 'resultsLimit': 50000})
            for k in range(0, DIAS_BUSCAR_CAMARA, 10)]
    primera = {}
    for lote in gc._multi_call_con_reintentos(api, llam, 'camara'):
        for x in lote or []:
            v = gc.obtener_id(x['device'])
            t = pd.Timestamp(x['dateTime'])
            if v not in primera or t < primera[v]:
                primera[v] = t
    return {v: (devs[v]['name'], t) for v, t in primera.items() if v in devs and (not filtro or filtro in devs[v]['name'])}


def nombres_conductores(api, ids):
    nombres = {}
    for i in ids:
        if not i or i == 'UnknownDriverId':
            continue
        try:
            u = api.get('User', search={'id': i})
            if u:
                nombres[i] = ' '.join(p for p in (u[0].get('firstName'), u[0].get('lastName')) if p) or u[0].get('name') or i
        except Exception:
            nombres[i] = i
    return nombres


def main():
    ap = argparse.ArgumentParser(description='Calificación provisional de conductores con eventos de la cámara.')
    ap.add_argument('--dias', type=int, default=7, help='Ventana en días (se recorta al inicio de la cámara de cada vehículo).')
    ap.add_argument('--vehiculo', default='', help='Parte del nombre del vehículo (ej. 1167).')
    args = ap.parse_args()

    api = gc.conectar_geotab()
    ahora = pd.Timestamp(datetime.now(timezone.utc))
    camaras = vehiculos_con_camara(api, ahora, args.vehiculo)
    if not camaras:
        print('Ningún vehículo con cámara encontrado.'); return
    reglas = {r['id']: r['name'] for r in api.get('Rule')}
    print('Vehículos con cámara:', ', '.join(f'{n} (desde {t.astimezone(TZ):%d-%b %H:%M})' for n, t in camaras.values()))

    filas_dia, detalle, informativos = [], [], collections.Counter()
    for v, (nombre, inicio_cam) in camaras.items():
        desde = max(ahora - timedelta(days=args.dias), inicio_cam)
        viajes = api.get('Trip', search={'deviceSearch': {'id': v}, 'fromDate': fm(desde), 'toDate': fm(ahora)}, resultsLimit=50000) or []
        eventos = api.get('ExceptionEvent', search={'deviceSearch': {'id': v}, 'fromDate': fm(desde), 'toDate': fm(ahora)}, resultsLimit=50000) or []
        bost = api.get('StatusData', search={'diagnosticSearch': {'id': ID_BOSTEZO}, 'deviceSearch': {'id': v}, 'fromDate': fm(desde), 'toDate': fm(ahora)}, resultsLimit=50000) or []
        conductores = nombres_conductores(api, {gc.obtener_id(t.get('driver')) for t in viajes} | {gc.obtener_id(e.get('driver')) for e in eventos})

        def grupo(drv):
            i = gc.obtener_id(drv) if drv else None
            return conductores.get(i) or f'{nombre} (sin conductor identificado)'

        km, horas = collections.Counter(), collections.Counter()
        for t in viajes:
            g = grupo(t.get('driver')); dia = pd.Timestamp(t['start']).astimezone(TZ).strftime('%Y-%m-%d')
            km[(g, dia)] += float(t.get('distance') or 0)
            horas[(g, dia)] += (pd.Timestamp(t['stop']) - pd.Timestamp(t['start'])).total_seconds() / 3600
        ev = collections.defaultdict(collections.Counter)
        for e in eventos:
            n = reglas.get(gc.obtener_id(e['rule']), '')
            if n in PESOS:
                g = grupo(e.get('driver')); a = pd.Timestamp(e['activeFrom']).astimezone(TZ)
                ev[(g, a.strftime('%Y-%m-%d'))][n] += 1
                detalle.append({'Grupo': g, 'Vehículo': nombre, 'Fecha': a.strftime('%Y-%m-%d'), 'Hora': a.strftime('%H:%M:%S'), 'Evento': PESOS[n][0], 'Puntos': PESOS[n][1],
                                'Duración (s)': round((pd.Timestamp(e['activeTo']) - pd.Timestamp(e['activeFrom'])).total_seconds())})
        for x in bost:
            if float(x['data']) >= 1:
                informativos[grupo(None)] += 1
        for k in set(km) | set(ev):
            g, dia = k
            puntos = sum(PESOS[n][1] * c for n, c in ev[k].items())
            fila = {'Grupo': g, 'Vehículo': nombre, 'Día': dia, 'Km': round(km[k], 1), 'Horas de viaje': round(horas[k], 1), 'Eventos': sum(ev[k].values()), 'Puntos': puntos}
            for n, (etq, _) in PESOS.items():
                fila[etq] = ev[k][n]
            filas_dia.append(fila)

    dia = pd.DataFrame(filas_dia).sort_values(['Grupo', 'Día'])
    cols_ev = [etq for etq, _ in PESOS.values()]
    res = dia.groupby(['Grupo', 'Vehículo'], as_index=False).agg({'Km': 'sum', 'Horas de viaje': 'sum', 'Eventos': 'sum', 'Puntos': 'sum', **{c: 'sum' for c in cols_ev}})
    res['Índice (puntos por 100 km)'] = (res['Puntos'] / res['Km'] * 100).round(1)
    res['Puntos por hora de viaje'] = (res['Puntos'] / res['Horas de viaje']).round(2)
    res['Evaluable'] = res['Km'].apply(lambda k: 'Sí' if k >= MIN_KM else f'Datos insuficientes (< {MIN_KM} km)')
    res['Bostezos (informativo)'] = res['Grupo'].map(informativos).fillna(0).astype(int)
    res[['Km', 'Horas de viaje']] = res[['Km', 'Horas de viaje']].round(1)
    dia['Índice del día (por 100 km)'] = (dia['Puntos'] / dia['Km'].where(dia['Km'] > 0) * 100).round(1)

    notas = pd.DataFrame({'Método': [
        'Calificación PROVISIONAL con eventos automáticos de la cámara, sin validar contra el video.',
        'Índice = puntos de penalización por cada 100 km (menor es mejor). Con menos de %d km no es evaluable.' % MIN_KM,
        'Pesos (puntos por evento): ' + '; '.join(f'{etq} {p}' for etq, p in PESOS.values()),
        'No puntúan: lente obstruido, cubierta retirada, cámara desmontada (fallas del equipo), botón de cámara (acción del conductor) y bostezo (informativo de fatiga).',
        'Agrupa por conductor identificado (NFC); si no hay, por vehículo "sin conductor identificado".',
        'El periodo de cada vehículo empieza cuando la cámara se conectó por primera vez.',
        'No usar para consecuencias disciplinarias hasta validar los clips y medir el porcentaje de aciertos. Empezar con coaching.']})
    ruta = CARPETA_REPO / 'reportes' / f'calificacion_camara_{datetime.now(TZ):%Y%m%d}.xlsx'
    ruta.parent.mkdir(parents=True, exist_ok=True)
    with pd.ExcelWriter(ruta, engine='openpyxl') as w:
        res.to_excel(w, sheet_name='Resumen', index=False)
        dia.to_excel(w, sheet_name='Por día', index=False)
        pd.DataFrame(detalle).sort_values(['Fecha', 'Hora']).to_excel(w, sheet_name='Eventos', index=False)
        notas.to_excel(w, sheet_name='Notas del método', index=False)
    try:
        shutil.copyfile(ruta, DESCARGAS / ruta.name)
    except OSError as e:
        print(f'(no se pudo copiar a Descargas: {e})')
    pd.set_option('display.width', 220); pd.set_option('display.max_columns', 30)
    print('\n' + res[['Grupo', 'Km', 'Horas de viaje', 'Eventos', 'Puntos', 'Índice (puntos por 100 km)', 'Evaluable', 'Bostezos (informativo)']].to_string(index=False))
    print('\n' + dia[['Grupo', 'Día', 'Km', 'Eventos', 'Puntos', 'Índice del día (por 100 km)']].to_string(index=False))
    print(f'\nGuardado: {ruta} (copia en Descargas)')


if __name__ == '__main__':
    main()
