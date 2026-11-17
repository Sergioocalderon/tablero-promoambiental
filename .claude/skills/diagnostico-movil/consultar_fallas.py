"""Fallas de un móvil leídas de Geotab y clasificadas con los criterios de la skill diagnostico-movil.

    python consultar_fallas.py 1123              # fallas confirmadas y por verificar (últimos 30 días)
    python consultar_fallas.py 1123 --dias 90    # ventana más larga
    python consultar_fallas.py 1123 --todas      # incluye las inactivas
    python consultar_fallas.py 1123 --json       # salida estructurada

Solo LEE de Geotab. Las credenciales salen de geotab_comun (mismo .env / secrets que herramientas/).
"""
import argparse
import csv
import json
import pathlib
import sys
from datetime import datetime, timedelta, timezone

RAIZ = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(RAIZ / 'herramientas'))
from geotab_comun import conectar_geotab  # noqa: E402

CONFIRMACION_HORAS = 24   # mismo corte que el bot de Telegram y el add-in Alertas por Severidad

# Diagnósticos de Geotab que NO son códigos SPN/FMI del motor
TESTIGOS = {'DiagnosticGeneralVehicleWarningLightId', 'DiagnosticLowPriorityWarningLightId',
            'DiagnosticMalfunctionIndicatorLampId', 'DiagnosticRedStopLampId', 'DiagnosticAmberWarningLampId',
            'DiagnosticProtectLampId'}
EQUIPO_PALABRAS = ('dispositivo telem', 'telematic', 'firmware', 'reinicio', 'acelerómetro', 'aceler',
                   'búfer', 'buffer', 'eventos duros', 'desconectado', 'toda la energía', 'unplugged')


def _id(x):
    return x.get('id') if isinstance(x, dict) else x


def cargar_diccionario():
    dic = {}
    ruta = RAIZ / 'Diccionario_Fallas.csv'
    if ruta.exists():
        with open(ruta, encoding='utf-8-sig') as fh:
            for r in csv.DictReader(fh):
                dic[(r['SPN'], r['FMI'])] = r
    return dic


def categoria(diag_id, nombre):
    n = (nombre or '').lower()
    if diag_id in TESTIGOS or 'luz de advertencia' in n or 'warning light' in n:
        return 'Testigo del tablero'
    if any(p in n for p in EQUIPO_PALABRAS) or (diag_id or '').startswith(('DiagnosticDevice', 'DiagnosticThirdParty')):
        return 'Equipo Geotab'
    if 'unknown diagnostic' in n:
        return 'Sin clasificar'
    return 'Motor/vehículo'


def criticidad(f):
    if f.get('redStopLamp') or f.get('protectWarningLamp'):
        return 'ALTA'
    if f.get('amberWarningLamp'):
        return 'MEDIA'
    return 'BAJA'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('movil', help='número del móvil, p. ej. 1123')
    ap.add_argument('--dias', type=int, default=30)
    ap.add_argument('--todas', action='store_true', help='incluir también las inactivas')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()

    api = conectar_geotab()
    devs = [d for d in api.get('Device') if str(d.get('name', '')).startswith(str(a.movil))]
    if not devs:
        sys.exit(f'No hay un dispositivo que empiece por "{a.movil}".')
    if len(devs) > 1:
        print('Varios dispositivos coinciden, se usa el primero:', [d['name'] for d in devs], file=sys.stderr)
    dev = devs[0]
    ahora = datetime.now(timezone.utc)
    crudo = api.get('FaultData', search={'deviceSearch': {'id': dev['id']},
                                         'fromDate': ahora - timedelta(days=a.dias), 'toDate': ahora})
    dd = {d['id']: d for d in api.get('Diagnostic') if isinstance(d, dict)}
    fm = {d['id']: d for d in api.get('FailureMode') if isinstance(d, dict)}
    dic = cargar_diccionario()

    ultimo, cuenta = {}, {}
    for r in sorted(crudo, key=lambda x: x['dateTime']):
        k = (_id(r['diagnostic']), _id(r.get('failureMode')))
        ultimo[k] = r
        cuenta[k] = cuenta.get(k, 0) + 1

    filas = []
    for k, r in ultimo.items():
        d = dd.get(k[0]) or {}
        m = fm.get(k[1]) or {}
        spn, fmi = d.get('code'), m.get('code')
        di = dic.get((str(spn), str(fmi))) or {}
        edad_h = (ahora - r['dateTime'].astimezone(timezone.utc)).total_seconds() / 3600
        activa = r.get('faultState') == 'Active'
        if activa and edad_h <= CONFIRMACION_HORAS:
            vigencia = 'Confirmada'
        elif activa:
            vigencia = 'Por verificar'
        else:
            vigencia = 'Inactiva'
        nombre = di.get('Descripcion') or d.get('name') or k[0]
        cat = categoria(k[0], d.get('name'))
        filas.append({
            'categoria': cat, 'vigencia': vigencia, 'criticidad': criticidad(r),
            # el 0 es un FMI válido (nivel más severo): no mostrarlo como "?"
            'spn': spn, 'fmi': fmi if fmi is not None else None,
            'codigo': (f'SPN {spn} / FMI {fmi}' if fmi is not None else
                       (f'Código Geotab {spn}' if cat != 'Motor/vehículo' else f'SPN {spn} / FMI sin dato')),
            'nombre': nombre[:120], 'modo_falla': m.get('name'), 'edad_h': round(edad_h, 1),
            'registros': cuenta[k], 'grupo': di.get('Grupo'),
            'luces': {x: bool(r.get(x)) for x in ('redStopLamp', 'amberWarningLamp', 'protectWarningLamp', 'malfunctionLamp')},
        })

    if not a.todas:
        filas = [f for f in filas if f['vigencia'] != 'Inactiva']
    orden_v = {'Confirmada': 0, 'Por verificar': 1, 'Inactiva': 2}
    orden_c = {'ALTA': 0, 'MEDIA': 1, 'BAJA': 2}
    filas.sort(key=lambda f: (f['categoria'] != 'Motor/vehículo', orden_v[f['vigencia']], orden_c[f['criticidad']], f['edad_h']))

    if a.json:
        print(json.dumps({'movil': dev['name'], 'consultado': ahora.isoformat(), 'ventana_dias': a.dias, 'fallas': filas},
                         ensure_ascii=False, indent=2))
        return
    print(f"Móvil {dev['name']} | {len(crudo)} registros en {a.dias} d | corte de confirmación: {CONFIRMACION_HORAS} h")
    for cat in ('Motor/vehículo', 'Sin clasificar', 'Testigo del tablero', 'Equipo Geotab'):
        grupo = [f for f in filas if f['categoria'] == cat]
        if not grupo:
            continue
        print(f'\n== {cat} ({len(grupo)}) ==')
        for f in grupo:
            luces = ','.join(k.replace('WarningLamp', '').replace('StopLamp', '').replace('malfunctionLamp', 'MIL')
                             for k, v in f['luces'].items() if v) or '-'
            print(f"  [{f['vigencia']:<13}] {f['criticidad']:<5} {f['codigo']:<24} hace {f['edad_h']:>6} h | {f['registros']:>5} reg | luces: {luces} | {f['nombre']}")
    if not filas:
        print('\nSin fallas confirmadas ni por verificar en la ventana.')


if __name__ == '__main__':
    main()
