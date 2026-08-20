"""Revisa Geotab periodicamente y manda alertas a Telegram, sin depender de que
el tablero (app.py) este abierto. Pensado para correr como job programado
(ver .github/workflows/alertas-telegram.yml).

Usa un archivo local (ESTADO_PATH) para recordar que ya se notifico y no
repetir el mensaje en cada corrida. En GitHub Actions ese archivo se persiste
entre corridas con actions/cache (no requiere credenciales extra de Google
Sheets, a diferencia del snapshot que usa app.py, que ademas no esta
configurado actualmente).
"""
import os
import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import mygeotab
import pandas as pd
import requests

ZONA_BOGOTA = ZoneInfo("America/Bogota")
ESTADO_PATH = "telegram_estado.json"
MAX_CLAVES_GUARDADAS = 5000  # evita que el estado de eventos (append-only) crezca sin limite

# --- Sobre-revolucion sin PTO: la regla no tiene duracion minima propia en Geotab,
# asi que se filtra aca (picos breves de cambios de marcha no cuentan). ---
NOMBRE_REGLA_RPM_POR_MOTOR = {'L9': 'SOBRE REVOLUCIÓN (L9)', 'X12': 'SOBRE REVOLUCIÓN (X12)'}
DURACION_MINIMA_SEG = 60
VENTANA_REVISION_HORAS = 2  # margen hacia atras, por si el cron se atrasa o se salta una ejecucion

# --- Sobre-revolucion, umbral bajo (1300 RPM): el nombre de la regla en Geotab sigue
# diciendo "CON PTO" pero ya NO exige PTO en la condicion -- se confirmo con datos reales
# que el diagnostico de PTO es un pulso (mediana ~1.1s entre cambios), asi que exigirlo
# sostenido 30s casi nunca se cumplia. Ahora solo exige RPM > 1300 + velocidad < 1 km/h
# sostenido 30s (corregido el 2026-08-20); el PTO se puede confirmar aparte si hace falta.
# Los ExceptionEvent tampoco vienen pre-filtrados por duracion -- se filtra aca igual
# que con las otras reglas. ---
NOMBRE_REGLA_PTO = 'SOBRE REVOLUCIÓN CON PTO (L9-X12-OM 926-ISF 3.8)'
DURACION_MINIMA_PTO_SEG = 30

# --- Fallas criticas: severidad tomada directo de las luces que reporta Geotab
# (mismo criterio que app.py: ALTA = roja o proteccion motor, MEDIA = ambar). ---
VENTANA_FALLAS_DIAS = 30  # rango amplio para no perder fallas activas de hace tiempo; se filtra por faultState

REFERENCIA_MOTOR_POR_MARCA = {
    "volkswagen": "ISF 3.8", "volskwagen": "ISF 3.8", "mercedes": "OM926",
    "international": "L9", "foton": "X12", "kenworth": "ISM 11",
}
GRUPOS_RAIZ_NO_CIUDAD = {'tipologia'}


def conectar_geotab():
    api = mygeotab.API(
        username=os.environ["GEOTAB_USUARIO"],
        password=os.environ["GEOTAB_CONTRASENA"],
        database=os.environ["GEOTAB_DATABASE"],
        server=os.environ.get("GEOTAB_SERVER", "my.geotab.com"),
    )
    api.authenticate()
    return api


def cargar_estado():
    default = {"revolucion_notificados": [], "fallas_alta_activas": []}
    if not os.path.exists(ESTADO_PATH):
        return default
    try:
        with open(ESTADO_PATH, "r", encoding="utf-8") as f:
            datos = json.load(f)
        return {**default, **datos}
    except (json.JSONDecodeError, OSError):
        return default


def guardar_estado(estado):
    estado_a_guardar = {
        "revolucion_notificados": estado["revolucion_notificados"][-MAX_CLAVES_GUARDADAS:],
        "fallas_alta_activas": estado["fallas_alta_activas"],
    }
    with open(ESTADO_PATH, "w", encoding="utf-8") as f:
        json.dump(estado_a_guardar, f)


def enviar_telegram(texto):
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    chat_id = os.environ["TELEGRAM_CHAT_ID"]
    resp = requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat_id, "text": texto},
        timeout=15,
    )
    if not resp.ok:
        print(f"*** Error enviando a Telegram: {resp.status_code} {resp.text} ***")
    return resp.ok


def clasificar_criticidad_geotab(falla):
    """Mismo criterio que app.py: ALTA = luz roja o de proteccion del motor,
    MEDIA = luz ambar, BAJA = solo testigo general o ninguna luz activa."""
    if falla.get('redStopLamp') or falla.get('protectWarningLamp'):
        return 'ALTA'
    if falla.get('amberWarningLamp'):
        return 'MEDIA'
    return 'BAJA'


# ---------------------------------------------------------------------------
# Sobre-revolucion (umbral general y umbral bajo 1300 RPM)
# ---------------------------------------------------------------------------

ID_DIAGNOSTICO_PTO = 'DiagnosticPowerTakeoffEngagedId'
VENTANA_PTO_MINUTOS = 1  # ventana angosta a propósito: el PTO pulsa ~cada 1s todo el día,
# así que una ventana amplia (ej. 10 min) casi siempre encuentra "algún" pulso por pura
# coincidencia y deja de ser una confirmación real de que el compactador estaba operando.


def _filtrar_por_pto_cercano(api, eventos_candidatos, ventana_minutos=VENTANA_PTO_MINUTOS):
    """De una lista de eventos (dicts con id_veh, activeFrom, activeTo -- datetimes),
    devuelve solo los que tienen al menos un pulso de PTO=1 en +/- ventana_minutos.
    El PTO es un pulso (mediana ~1.1s entre cambios, confirmado con datos reales), asi
    que no se puede exigir dentro de la condicion de la Regla -- se confirma aca aparte.
    Si falla la consulta, no se notifica nada (mejor omitir que generar ruido)."""
    if not eventos_candidatos:
        return []

    vehiculos = list({e['id_veh'] for e in eventos_candidatos})
    desde_global = min(e['activeFrom'] for e in eventos_candidatos) - timedelta(minutes=ventana_minutos)
    hasta_global = max(e['activeTo'] for e in eventos_candidatos) + timedelta(minutes=ventana_minutos)

    llamadas = [
        ('Get', {
            'typeName': 'StatusData',
            'search': {
                'diagnosticSearch': {'id': ID_DIAGNOSTICO_PTO},
                'deviceSearch': {'id': id_veh},
                'fromDate': desde_global.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                'toDate': hasta_global.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
            }
        })
        for id_veh in vehiculos
    ]
    try:
        resultados = api.multi_call(llamadas)
    except Exception as e:
        print(f"*** No se pudo consultar PTO para confirmar eventos de 1300 RPM: {e} ***")
        return []

    pulsos_por_vehiculo = {}
    for id_veh, lecturas in zip(vehiculos, resultados):
        pulsos = []
        for l in (lecturas or []):
            try:
                if float(l.get('data') or 0) > 0:
                    pulsos.append(pd.to_datetime(l['dateTime']))
            except (TypeError, ValueError):
                continue
        pulsos_por_vehiculo[id_veh] = pulsos

    confirmados = []
    for e in eventos_candidatos:
        desde = e['activeFrom'] - timedelta(minutes=ventana_minutos)
        hasta = e['activeTo'] + timedelta(minutes=ventana_minutos)
        pulsos = pulsos_por_vehiculo.get(e['id_veh'], [])
        if any(desde <= p <= hasta for p in pulsos):
            confirmados.append(e)
    return confirmados


def _revisar_regla_revolucion(api, devices, nombre_regla, etiqueta, claves_ya_notificadas,
                               duracion_minima_seg=0, requiere_pto_cercano=False):
    reglas = api.get('Rule')
    regla = next((r for r in reglas if r.get('name', '').strip().upper() == nombre_regla.strip().upper()), None)
    if not regla:
        print(f"*** No se encontro la regla '{nombre_regla}' ***")
        return []

    f_fin = datetime.now(timezone.utc)
    f_inicio = f_fin - timedelta(hours=VENTANA_REVISION_HORAS)
    eventos = api.get('ExceptionEvent', search={
        'ruleSearch': {'id': regla['id']},
        'fromDate': f_inicio.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    })

    candidatos = []
    for ev in (eventos or []):
        dev = ev.get('device')
        id_veh = dev['id'] if isinstance(dev, dict) else dev
        activeFrom = ev.get('activeFrom')
        activeTo = ev.get('activeTo')
        if not activeFrom or not activeTo:
            continue

        dt_desde = pd.to_datetime(activeFrom)
        dt_hasta = pd.to_datetime(activeTo)
        duracion_seg = (dt_hasta - dt_desde).total_seconds()
        if duracion_seg < duracion_minima_seg:
            continue

        clave = f"{id_veh}|{activeFrom}"
        if clave in claves_ya_notificadas:
            continue

        candidatos.append({
            'id_veh': id_veh, 'activeFrom': dt_desde, 'activeTo': dt_hasta,
            'clave': clave, 'duracion_seg': duracion_seg,
        })

    if requiere_pto_cercano:
        candidatos = _filtrar_por_pto_cercano(api, candidatos)

    claves_nuevas = []
    for c in candidatos:
        nombre_veh = devices.get(c['id_veh'], {}).get('name', c['id_veh'])
        hora_local = c['activeFrom'].tz_convert(ZONA_BOGOTA).strftime('%d/%m/%Y %H:%M:%S')
        texto = (
            f"🏎️ SOBRE-REVOLUCIÓN ({etiqueta})\n"
            f"Vehículo: {nombre_veh}\n"
            f"Hora: {hora_local}\n"
            f"Duración: {c['duracion_seg']:.0f} segundos sostenidos\n"
            f"Vehículo detenido con RPM alto."
            + (f"\nPTO activo cerca (±{VENTANA_PTO_MINUTOS} min)." if requiere_pto_cercano else "")
        )
        if enviar_telegram(texto):
            print(f"Notificado: {c['clave']} ({c['duracion_seg']:.0f}s)")
            claves_nuevas.append(c['clave'])

    return claves_nuevas


def revisar_sobre_revolucion(api, claves_ya_notificadas):
    devices = {d['id']: d for d in api.get('Device')}

    claves_nuevas = []
    for motor, nombre_regla in NOMBRE_REGLA_RPM_POR_MOTOR.items():
        claves_nuevas += _revisar_regla_revolucion(
            api, devices, nombre_regla, motor, claves_ya_notificadas, duracion_minima_seg=DURACION_MINIMA_SEG
        )

    # Umbral bajo (1300 RPM): sin PTO en la condicion de la regla (es un pulso, no se
    # puede exigir sostenido), asi que se confirma aparte -- solo se notifica si hubo
    # un pulso de PTO cerca, para no generar ruido con ralenti alto sin compactador.
    claves_nuevas += _revisar_regla_revolucion(
        api, devices, NOMBRE_REGLA_PTO, "1300 RPM", claves_ya_notificadas,
        duracion_minima_seg=DURACION_MINIMA_PTO_SEG, requiere_pto_cercano=True
    )

    if claves_nuevas:
        print(f"Total sobre-revolucion notificados en esta corrida: {len(claves_nuevas)}")
    else:
        print("Sin eventos nuevos de sobre-revolucion que notificar.")

    return claves_nuevas


# ---------------------------------------------------------------------------
# Fallas criticas (ALTA)
# ---------------------------------------------------------------------------

def es_grupo_marca(nombre):
    nombre_l = nombre.strip().lower()
    return any(marca in nombre_l for marca in REFERENCIA_MOTOR_POR_MARCA)


def normalizar_ciudad(nombre):
    n = nombre.upper()
    if 'BOGOTA' in n or 'BOGOTÁ' in n:
        return 'Bogotá'
    if 'CALI' in n:
        return 'Cali'
    if 'VALLE' in n:
        return 'Valle'
    return nombre.strip()


def obtener_mapa_grupos(api):
    """Recorre la jerarquia de grupos y devuelve, por id de grupo, la ciudad y
    tipologia (tipo de vehiculo) a las que pertenece -- mismo criterio que
    app.py (obtener_mapa_grupos/resolver_ciudad_marca), extendido para
    tambien capturar la tipologia."""
    grupos = api.get('Group')
    by_id = {g['id']: g for g in grupos if isinstance(g, dict)}
    raiz = next((g for g in grupos if g.get('name', '').strip().startswith('*')), None)
    if not raiz:
        return {}

    def obtener_id(referencia):
        return referencia['id'] if isinstance(referencia, dict) else referencia

    mapa = {}

    def recorrer(grupo_id, ciudad_actual, tipologia_actual):
        grupo_completo = by_id.get(grupo_id)
        if not grupo_completo:
            return
        mapa[grupo_id] = {'nombre': grupo_completo.get('name', ''), 'ciudad': ciudad_actual, 'tipologia': tipologia_actual}
        for hijo in (grupo_completo.get('children') or []):
            recorrer(obtener_id(hijo), ciudad_actual, tipologia_actual)

    for hijo_raiz in (raiz.get('children') or []):
        hijo_id = obtener_id(hijo_raiz)
        hijo_completo = by_id.get(hijo_id, {})
        nombre = hijo_completo.get('name', '').strip()
        if nombre.lower() in GRUPOS_RAIZ_NO_CIUDAD:
            # Rama de Tipologia: cada subgrupo directo es un tipo de vehiculo distinto
            for sub in (hijo_completo.get('children') or []):
                sub_id = obtener_id(sub)
                sub_completo = by_id.get(sub_id, {})
                tipo_nombre = sub_completo.get('name', '').strip()
                recorrer(sub_id, 'Sin ciudad asignada', tipo_nombre)
        elif es_grupo_marca(nombre):
            recorrer(hijo_id, 'Sin ciudad asignada', None)
        else:
            recorrer(hijo_id, normalizar_ciudad(nombre), None)

    return mapa


def resolver_ciudad_tipologia(grupos_vehiculo, mapa_grupos):
    ciudad = 'Sin ciudad asignada'
    tipologia = 'Sin tipología asignada'
    for g in (grupos_vehiculo or []):
        gid = g['id'] if isinstance(g, dict) else g
        info = mapa_grupos.get(gid)
        if not info:
            continue
        if info['ciudad'] and ciudad == 'Sin ciudad asignada':
            ciudad = info['ciudad']
        if info.get('tipologia') and tipologia == 'Sin tipología asignada':
            tipologia = info['tipologia']
    return ciudad, tipologia


def obtener_catalogos_diagnosticos(api):
    dic_diag = {}
    for d in api.get('Diagnostic'):
        if isinstance(d, dict) and 'id' in d:
            dic_diag[d['id']] = {'nombre': d.get('name') or 'Diagnóstico sin nombre', 'codigo': d.get('code')}
    dic_fm = {}
    for fm in api.get('FailureMode'):
        if isinstance(fm, dict) and 'id' in fm:
            dic_fm[fm['id']] = {'nombre': fm.get('name') or '', 'codigo': fm.get('code')}
    return dic_diag, dic_fm


def revisar_fallas_altas(api, claves_activas_previas):
    devices = {d['id']: d for d in api.get('Device')}
    dic_diag, dic_fm = obtener_catalogos_diagnosticos(api)
    mapa_grupos = obtener_mapa_grupos(api)

    f_fin = datetime.now(timezone.utc)
    f_inicio = f_fin - timedelta(days=VENTANA_FALLAS_DIAS)
    fallas = api.get('FaultData', search={
        'fromDate': f_inicio.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
    })

    if not fallas:
        return set(), []

    df = pd.DataFrame(fallas)
    df['id_camion'] = df['device'].apply(lambda x: x['id'] if isinstance(x, dict) else x)
    df['diag_id'] = df['diagnostic'].apply(lambda x: x['id'] if isinstance(x, dict) else None)
    df['fm_id'] = df['failureMode'].apply(lambda x: x['id'] if isinstance(x, dict) else None)
    df['criticidad'] = df.apply(clasificar_criticidad_geotab, axis=1)
    df['dateTime'] = pd.to_datetime(df['dateTime'])

    # Solo lo que Geotab marca activo ahora mismo (evita reinventar la logica de
    # "ultima ocurrencia dentro de una ventana" -- Geotab ya lo sabe con certeza).
    activas = df[df['faultState'] == 'Active']
    activas_alta = activas[activas['criticidad'] == 'ALTA']

    # Una fila por combinacion vehiculo+diagnostico+modo de falla (la mas reciente)
    activas_alta = activas_alta.sort_values('dateTime').drop_duplicates(
        subset=['id_camion', 'diag_id', 'fm_id'], keep='last'
    )

    claves_actuales = set()
    filas_nuevas = []
    for _, row in activas_alta.iterrows():
        clave = f"{row['id_camion']}|{row['diag_id']}|{row['fm_id']}"
        claves_actuales.add(clave)
        if clave in claves_activas_previas:
            continue
        filas_nuevas.append(row)

    for row in filas_nuevas:
        diag_info = dic_diag.get(row['diag_id'], {'nombre': 'Diagnóstico desconocido', 'codigo': None})
        fm_info = dic_fm.get(row['fm_id'], {'nombre': '', 'codigo': None})
        vehiculo = devices.get(row['id_camion'], {})
        nombre_veh = vehiculo.get('name', row['id_camion'])
        ciudad, tipologia = resolver_ciudad_tipologia(vehiculo.get('groups'), mapa_grupos)
        hora_local = row['dateTime'].tz_convert(ZONA_BOGOTA).strftime('%d/%m/%Y %H:%M:%S')
        spn = diag_info.get('codigo') or '?'
        fmi = fm_info.get('codigo') or '?'
        descripcion = diag_info['nombre']
        if fm_info['nombre']:
            descripcion += f" — {fm_info['nombre']}"
        url_busqueda = f"https://www.google.com/search?q=SPN+{spn}+FMI+{fmi}+causa+falla+motores+diesel"

        texto = (
            f"🚨 FALLA CRÍTICA (ALTA)\n"
            f"Vehículo: {nombre_veh}\n"
            f"Ciudad: {ciudad}\n"
            f"Tipología: {tipologia}\n"
            f"SPN {spn} | FMI {fmi}\n"
            f"{descripcion}\n"
            f"Hora: {hora_local}\n"
            f"🔍 Buscar causa: {url_busqueda}"
        )
        if enviar_telegram(texto):
            clave = f"{row['id_camion']}|{row['diag_id']}|{row['fm_id']}"
            print(f"Notificado (falla ALTA): {clave}")

    if not filas_nuevas:
        print("Sin fallas ALTA nuevas que notificar.")
    else:
        print(f"Total fallas ALTA notificadas en esta corrida: {len(filas_nuevas)}")

    return claves_actuales, filas_nuevas


def main():
    api = conectar_geotab()
    estado = cargar_estado()
    print(f"Estado cargado: {len(estado['revolucion_notificados'])} eventos de revolucion, "
          f"{len(estado['fallas_alta_activas'])} fallas ALTA activas previas.")

    claves_revolucion_previas = set(estado['revolucion_notificados'])
    claves_revolucion_nuevas = revisar_sobre_revolucion(api, claves_revolucion_previas)
    estado['revolucion_notificados'] = list(claves_revolucion_previas | set(claves_revolucion_nuevas))

    claves_fallas_previas = set(estado['fallas_alta_activas'])
    claves_fallas_actuales, _ = revisar_fallas_altas(api, claves_fallas_previas)
    estado['fallas_alta_activas'] = list(claves_fallas_actuales)

    guardar_estado(estado)


if __name__ == "__main__":
    main()
