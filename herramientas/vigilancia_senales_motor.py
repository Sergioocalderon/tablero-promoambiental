"""
vigilancia_senales_motor.py -- avisa cuando un vehiculo DEJA DE ENVIAR senales del motor
=========================================================================================

Motivo (2026-10-10): la unidad 11006-NGY805 (Chevrolet NHR) perdio 19 senales del
motor el 11-sep porque su GPS paso del protocolo OBD2 WWH-CAN al CAN generico, y
nadie se dio cuenta en un mes. Una regla de Geotab NO puede detectarlo: las reglas
se disparan cuando LLEGA un dato, no cuando deja de llegar. La senal de "protocolo
detectado" tampoco sirve (se repite cientos de veces y da falsas alarmas). Por eso
este chequeo compara cada vehiculo contra si mismo:

  Una senal esta PERDIDA en un vehiculo si
    - llegaba en al menos MIN_BLOQUES_BASE de los BLOQUES_BASE bloques de 24 h previos, Y
    - no llego en ninguno de los BLOQUES_RECIENTES bloques de 24 h mas recientes, Y
    - el vehiculo opero (ignicion) en al menos MIN_BLOQUES_OPERO de esos bloques recientes
      (un camion parqueado no cuenta).
  Senales vigiladas: nivel de DEF, estado/gatillo/tipo de regeneracion del DPF,
  horas de motor y PTO (las que perdio 11006).

Validado con datos reales (flota de 80 vehiculos): con corte del 15-sep habria marcado
SOLO a 11006 (3-4 dias despues del cambio, en vez de un mes) y hoy solo a 11006, sin
falsas alarmas.

Avisos por Telegram, sin ruido:
  - Un mensaje cuando un vehiculo aparece con senales perdidas (o se suman nuevas).
  - Un recordatorio por semana mientras siga sin resolverse.
  - Un mensaje cuando las senales vuelven.
  - Si no hay novedad no manda nada.
Como la ventana base "olvida" a los 14 dias, el estado (estado_senales_motor.json)
recuerda que senales se avisaron y las sigue dando por perdidas hasta que vuelvan.

Uso:
    python vigilancia_senales_motor.py               # un chequeo ahora, manda Telegram si hay novedad
    python vigilancia_senales_motor.py --sin-telegram  # solo imprime, no manda ni guarda estado
    python vigilancia_senales_motor.py --diario        # lo que corre el workflow cada 5 min: solo
                                                       # actua despues de las 07:00 Bogota y una vez al dia
"""
import argparse
import json
import os
import pathlib
import sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd
from dotenv import load_dotenv

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

CARPETA_HERRAMIENTAS = pathlib.Path(__file__).resolve().parent
CARPETA_REPO = CARPETA_HERRAMIENTAS.parent
sys.path.insert(0, str(CARPETA_HERRAMIENTAS))
sys.path.insert(0, str(CARPETA_REPO))
import geotab_comun as gc  # noqa: E402

TZ_BOGOTA = ZoneInfo('America/Bogota')
RUTA_ESTADO = CARPETA_HERRAMIENTAS / 'estado_senales_motor.json'
HORA_CHEQUEO_DIARIO = 7

BLOQUES_RECIENTES = 3
BLOQUES_BASE = 14
BLOQUES_BASE_INICIAL = 40   # solo la PRIMERA corrida (sin estado): mira mas atras para sembrar problemas ya existentes
MIN_BLOQUES_BASE = 7
MIN_BLOQUES_OPERO = 2
DIAS_RECORDATORIO = 7
LIMITE_PAGINA = 50000

ID_IGNICION = 'DiagnosticIgnitionId'
SENALES = {
    'DiagnosticDieselExhaustFluidId': 'Nivel de DEF',
    'aTEM7u5qGsEe-gPR0o_6rvg': 'Estado de regeneración del DPF',
    'azVxF2xaijUiTooIDuFv3Yg': 'Gatillo de regeneración del DPF',
    'ax5zzYLi3REKx7qGzmeExOw': 'Tipo de regeneración del DPF',
    'DiagnosticEngineHoursId': 'Horas de motor',
    'DiagnosticPowerTakeoffEngagedId': 'Toma de fuerza (PTO)',
}


def fm(t):
    return t.strftime('%Y-%m-%dT%H:%M:%S.%fZ')


# ---------------------------------------------------------------------------
# Datos
# ---------------------------------------------------------------------------

def _vehiculos_en_tramo(api, diag_id, a, b):
    """Ids de vehiculos con al menos un dato en [a, b). Si la respuesta llega al tope
    de Geotab se parte el tramo (un tope corta la respuesta y haria ver como 'sin
    datos' a vehiculos que si reportaron)."""
    lote = api.get('StatusData', search={'diagnosticSearch': {'id': diag_id}, 'fromDate': fm(a), 'toDate': fm(b)},
                   resultsLimit=LIMITE_PAGINA) or []
    if len(lote) >= LIMITE_PAGINA and (b - a) > timedelta(minutes=30):
        m = a + (b - a) / 2
        return _vehiculos_en_tramo(api, diag_id, a, m) | _vehiculos_en_tramo(api, diag_id, m, b)
    return {gc.obtener_id(r['device']) for r in lote}


def presencia_por_bloque(api, ahora, bloques_base=BLOQUES_BASE):
    """{(id_veh, id_diag): {numero de bloque}}; bloque 0 = ultimas 24 h, 1 = las 24 h
    anteriores, etc. Bloques moviles (no dias calendario) para no depender de la hora
    a la que corre."""
    n = BLOQUES_RECIENTES + bloques_base
    llamadas, claves = [], []
    for diag in list(SENALES) + [ID_IGNICION]:
        for k in range(n):
            a, b = ahora - timedelta(hours=24 * (k + 1)), ahora - timedelta(hours=24 * k)
            llamadas.append(('Get', {'typeName': 'StatusData', 'search': {
                'diagnosticSearch': {'id': diag}, 'fromDate': fm(a), 'toDate': fm(b)}, 'resultsLimit': LIMITE_PAGINA}))
            claves.append((diag, k, a, b))
    resultados = []
    for i in range(0, len(llamadas), 40):
        resultados += gc._multi_call_con_reintentos(api, llamadas[i:i + 40], 'presencia de señales del motor')
    pres = {}
    for (diag, k, a, b), lote in zip(claves, resultados):
        vehs = _vehiculos_en_tramo(api, diag, a, b) if len(lote or []) >= LIMITE_PAGINA else {gc.obtener_id(r['device']) for r in lote or []}
        for v in vehs:
            pres.setdefault((v, diag), set()).add(k)
    return pres


# ---------------------------------------------------------------------------
# Deteccion
# ---------------------------------------------------------------------------

def detectar(pres, vehiculos, bloques_base=BLOQUES_BASE):
    """{id_veh: {'opero': bool, 'perdidas': [ids de senal], 'presentes_recientes': set(ids)}}"""
    recientes = set(range(BLOQUES_RECIENTES))
    base = set(range(BLOQUES_RECIENTES, BLOQUES_RECIENTES + bloques_base))
    salida = {}
    for v in vehiculos:
        opero = len(pres.get((v, ID_IGNICION), set()) & recientes) >= MIN_BLOQUES_OPERO
        perdidas = [d for d in SENALES
                    if len(pres.get((v, d), set()) & base) >= MIN_BLOQUES_BASE and not (pres.get((v, d), set()) & recientes)]
        presentes = {d for d in SENALES if pres.get((v, d), set()) & recientes}
        salida[v] = {'opero': opero, 'perdidas': perdidas if opero else [], 'presentes_recientes': presentes}
    return salida


def actualizar_estado(estado, deteccion, nombres, ahora):
    """Aplica la deteccion al estado persistido y devuelve la lista de avisos
    [{'veh', 'tipo', 'texto', 'senales'}]. NO marca nada como avisado: eso lo hace
    quien envia, solo si el envio salio (ver main)."""
    avisos = []
    for v, d in deteccion.items():
        previo = estado.get(v)
        nombre = nombres.get(v, v)
        if previo:
            # senales ya avisadas que siguen sin llegar (la ventana base ya las olvido, se confia en el estado)
            siguen = [s for s in previo['senales'] if s not in d['presentes_recientes']]
            nuevas = [s for s in d['perdidas'] if s not in previo['senales']]
            if d['opero'] and not siguen and not nuevas:
                avisos.append({'veh': v, 'tipo': 'resuelto', 'senales': previo['senales'], 'texto': (
                    f"✅ Señales del motor recuperadas: {nombre}\n"
                    f"Volvieron a llegar: {', '.join(SENALES[s] for s in previo['senales'])}.")})
                continue
            if nuevas:
                todas = siguen + nuevas
                avisos.append({'veh': v, 'tipo': 'nuevas', 'senales': todas, 'texto': _texto_perdida(nombre, todas, previo.get('desde'), ahora, nuevas=nuevas)})
                continue
            ult = pd.to_datetime(previo['ultimo_aviso'])
            if siguen and (ahora - ult) >= timedelta(days=DIAS_RECORDATORIO):
                avisos.append({'veh': v, 'tipo': 'recordatorio', 'senales': siguen, 'texto': _texto_perdida(nombre, siguen, previo.get('desde'), ahora, recordatorio=True)})
        elif d['perdidas']:
            avisos.append({'veh': v, 'tipo': 'nuevo', 'senales': d['perdidas'], 'texto': _texto_perdida(nombre, d['perdidas'], None, ahora)})
    return avisos


def _texto_perdida(nombre, senales, desde, ahora, nuevas=None, recordatorio=False):
    cab = '🔁 RECORDATORIO' if recordatorio else ('🟠 Se sumaron señales perdidas' if nuevas else '🟠 Vehículo dejó de enviar señales del motor')
    lineas = [f"{cab}: {nombre}"]
    if desde:
        lineas.append(f"Detectado desde {pd.to_datetime(desde).astimezone(TZ_BOGOTA):%d-%b-%Y}.")
    lineas.append('Señales que dejaron de llegar: ' + ', '.join(SENALES[s] for s in senales) + '.')
    if nuevas:
        lineas.append('Nuevas: ' + ', '.join(SENALES[s] for s in nuevas) + '.')
    if not recordatorio:
        lineas.append('El vehículo sí estuvo operando; no es que esté parqueado.')
    lineas.append('👉 Revisar el GPS/arnés del vehículo (causa habitual: el equipo cambió a un protocolo del motor más básico).')
    return '\n'.join(lineas)


def cargar_estado():
    try:
        return json.loads(RUTA_ESTADO.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {'_meta': {}, 'vehiculos': {}}


def guardar_estado(estado):
    RUTA_ESTADO.write_text(json.dumps(estado, indent=1, ensure_ascii=False), encoding='utf-8')


def avisar_github(corrio):
    salida = os.environ.get('GITHUB_OUTPUT')
    if salida:
        with open(salida, 'a', encoding='utf-8') as f:
            f.write(f'generado={"true" if corrio else "false"}\n')


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description='Detecta vehiculos que dejaron de enviar senales del motor.')
    ap.add_argument('--sin-telegram', action='store_true', help='Solo imprimir; no manda mensajes ni guarda estado.')
    ap.add_argument('--diario', action='store_true', help=f'Solo corre despues de las {HORA_CHEQUEO_DIARIO}:00 (Bogota), una vez al dia.')
    args = ap.parse_args()
    load_dotenv(CARPETA_REPO / '.env')

    ahora_local = datetime.now(TZ_BOGOTA)
    estado = cargar_estado()
    if args.diario:
        if ahora_local.hour < HORA_CHEQUEO_DIARIO or estado['_meta'].get('ultima_fecha') == ahora_local.strftime('%Y-%m-%d'):
            print('Vigilancia de señales del motor: hoy ya corrió o aún no es la hora.')
            avisar_github(False)
            return

    ahora = pd.Timestamp(datetime.now(timezone.utc))
    api = gc.conectar_geotab()
    nombres = {d['id']: d['name'] for d in api.get('Device') if not d.get('activeTo') or pd.Timestamp(d['activeTo']) > ahora}
    primera = not estado['_meta'].get('ultimo_chequeo')
    bloques_base = BLOQUES_BASE_INICIAL if primera else BLOQUES_BASE
    if primera:
        print(f'Primera corrida (sin estado): ventana base de {bloques_base} días para detectar problemas que ya existían.')
    pres = presencia_por_bloque(api, ahora.to_pydatetime(), bloques_base)
    deteccion = detectar(pres, list(nombres), bloques_base)

    con_perdida = {v: d for v, d in deteccion.items() if d['perdidas']}
    print(f"Vehículos activos: {len(nombres)} | operaron: {sum(1 for d in deteccion.values() if d['opero'])} | con señales perdidas ahora: {len(con_perdida)}")
    for v, d in sorted(con_perdida.items(), key=lambda x: nombres[x[0]]):
        print(f"  {nombres[v]}: {', '.join(SENALES[s] for s in d['perdidas'])}")

    avisos = actualizar_estado(estado.setdefault('vehiculos', {}), deteccion, nombres, ahora)
    print(f'Avisos a enviar: {len(avisos)}')
    for a in avisos:
        print(f"\n[{a['tipo']}] {nombres[a['veh']]}\n{a['texto']}")
    if args.sin_telegram:
        return

    from telegram_alertas import enviar_telegram  # noqa: E402  (despues de load_dotenv)
    fallos = 0
    for a in avisos:
        # Mismo principio que telegram_alertas.py: solo se marca como avisado si el envio salio.
        if not enviar_telegram(a['texto']):
            fallos += 1
            print(f"*** No se pudo enviar el aviso de {nombres[a['veh']]}; se reintenta en el siguiente chequeo ***")
            continue
        if a['tipo'] == 'resuelto':
            estado['vehiculos'].pop(a['veh'], None)
        else:
            prev = estado['vehiculos'].get(a['veh'], {})
            estado['vehiculos'][a['veh']] = {'senales': a['senales'], 'desde': prev.get('desde') or ahora.isoformat(),
                                             'ultimo_aviso': ahora.isoformat()}
    if not fallos:  # con un envio fallido NO se da el dia por hecho: --diario lo reintenta en 5 min
        estado['_meta']['ultima_fecha'] = ahora_local.strftime('%Y-%m-%d')
    estado['_meta']['ultimo_chequeo'] = ahora.isoformat()
    guardar_estado(estado)
    avisar_github(True)


if __name__ == '__main__':
    main()
