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
    """Nunca debe lanzar una excepcion: si el archivo de estado no existe, esta
    corrupto, o quedo en un formato viejo incompatible (ej. una lista en vez de un
    dict, de una version anterior del script), se sigue con estado vacio en vez de
    frenar el script -- si esto lanzara una excepcion, guardar_estado() nunca se
    ejecutaria y el mismo estado viejo se re-guardaria corrida tras corrida,
    haciendo que TODO se vuelva a notificar como "nuevo" cada 5 minutos."""
    default = {
        "revolucion_notificados": [], "fallas_alta_activas": [], "ultima_hora_resumen": None,
        "ultimo_update_id_procesado": None,
    }
    if not os.path.exists(ESTADO_PATH):
        return default
    try:
        with open(ESTADO_PATH, "r", encoding="utf-8") as f:
            datos = json.load(f)
        if not isinstance(datos, dict):
            print(f"*** Estado en '{ESTADO_PATH}' tiene formato viejo/invalido (no es un dict) -- se ignora. ***")
            return default
        estado = dict(default)
        for clave in ("revolucion_notificados", "fallas_alta_activas"):
            valor = datos.get(clave)
            if isinstance(valor, list):
                estado[clave] = valor
        valor_hora = datos.get("ultima_hora_resumen")
        if isinstance(valor_hora, str):
            estado["ultima_hora_resumen"] = valor_hora
        valor_update_id = datos.get("ultimo_update_id_procesado")
        if isinstance(valor_update_id, int):
            estado["ultimo_update_id_procesado"] = valor_update_id
        return estado
    except Exception as e:
        print(f"*** No se pudo leer '{ESTADO_PATH}' ({e}) -- se sigue con estado vacio. ***")
        return default


def guardar_estado(estado):
    estado_a_guardar = {
        "revolucion_notificados": estado["revolucion_notificados"][-MAX_CLAVES_GUARDADAS:],
        "fallas_alta_activas": estado["fallas_alta_activas"],
        "ultima_hora_resumen": estado.get("ultima_hora_resumen"),
        "ultimo_update_id_procesado": estado.get("ultimo_update_id_procesado"),
    }
    with open(ESTADO_PATH, "w", encoding="utf-8") as f:
        json.dump(estado_a_guardar, f)


def enviar_telegram(texto):
    """TELEGRAM_CHAT_ID puede traer un solo chat_id o varios separados por coma
    (ej. '111111,222222') para mandarle el mismo mensaje a varias personas/chats sin
    necesitar que compartan un grupo. Devuelve True si se le pudo mandar a al menos
    uno -- si se exigiera que le llegue a TODOS, un solo destinatario con problemas
    (bloqueo el bot, chat_id invalido) haria que el evento se reintente sin parar."""
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    chat_ids = [c.strip() for c in os.environ["TELEGRAM_CHAT_ID"].split(",") if c.strip()]
    ok_alguno = False
    for chat_id in chat_ids:
        resp = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": texto},
            timeout=15,
        )
        if resp.ok:
            ok_alguno = True
        else:
            print(f"*** Error enviando a Telegram (chat_id={chat_id}): {resp.status_code} {resp.text} ***")
    return ok_alguno


TEXTO_BIENVENIDA = (
    "👋 ¡Hola! Este es el bot de alertas de Promoambiental.\n\n"
    "Vas a recibir automáticamente:\n"
    "🏎️ Alertas de sobre-revolución del motor\n"
    "🚨 Fallas críticas (ALTA) apenas se activen\n"
    "📊 Un resumen consolidado cada hora\n\n"
    "No necesitas hacer nada más -- ya quedaste suscrito. Para dejar de recibir "
    "mensajes, avisa a quien administra el bot para que te quite del listado."
)


def responder_mensajes_nuevos(estado):
    """Revisa (via getUpdates) si alguien le escribio /start al bot y le responde con
    un mensaje de bienvenida -- sin esto, quien escribe /start no recibe ninguna
    confirmacion de que quedo conectado (asi paso con Samuel: escribio pero no le
    salio nada). Usa el offset guardado en el estado para no re-procesar ni
    re-responder los mismos mensajes en cada corrida del cron (cada 5 min); nunca
    lanza una excepcion que frene el resto del script."""
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    params = {"timeout": 0}
    offset = estado.get("ultimo_update_id_procesado")
    if offset is not None:
        params["offset"] = offset + 1
    try:
        resp = requests.get(f"https://api.telegram.org/bot{token}/getUpdates", params=params, timeout=15)
        resp.raise_for_status()
        actualizaciones = resp.json().get("result", [])
    except Exception as e:
        print(f"*** No se pudieron revisar mensajes entrantes de Telegram: {e} ***")
        return

    for act in actualizaciones:
        estado["ultimo_update_id_procesado"] = act["update_id"]
        mensaje = act.get("message") or {}
        texto = (mensaje.get("text") or "").strip()
        chat_id = mensaje.get("chat", {}).get("id")
        if chat_id is None or not texto.startswith("/start"):
            continue
        try:
            requests.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": TEXTO_BIENVENIDA},
                timeout=15,
            )
            print(f"Bienvenida enviada a chat_id={chat_id}")
        except Exception as e:
            print(f"*** No se pudo enviar bienvenida a chat_id={chat_id}: {e} ***")


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
VENTANA_PTO_MINUTOS = 3  # ni muy ancha (el PTO pulsa ~cada 1s todo el dia, asi que 10 min
# encuentra "algun" pulso por pura coincidencia) ni muy angosta (con 1 min se perdio un
# caso real de prueba: el ultimo pulso de PTO quedo ~2 min antes de que arrancara el
# evento de RPM sostenido -- el motor tarda en subir y sostenerse tras activar el PTO).


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


def _obtener_eventos_regla(api, nombre_regla, f_inicio, f_fin, duracion_minima_seg=0, requiere_pto_cercano=False):
    """Trae ExceptionEvent de una regla en [f_inicio, f_fin) (datetimes con tz UTC) y
    filtra por duracion minima y, si aplica, por PTO cercano. No dedupea contra
    notificaciones previas -- eso lo maneja quien llame a esta funcion, segun el caso
    (alerta individual vs. resumen consolidado por hora)."""
    reglas = api.get('Rule')
    regla = next((r for r in reglas if r.get('name', '').strip().upper() == nombre_regla.strip().upper()), None)
    if not regla:
        print(f"*** No se encontro la regla '{nombre_regla}' ***")
        return []

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

        candidatos.append({
            'id_veh': id_veh, 'activeFrom': dt_desde, 'activeTo': dt_hasta,
            'clave': f"{id_veh}|{activeFrom}", 'duracion_seg': duracion_seg,
        })

    if requiere_pto_cercano:
        candidatos = _filtrar_por_pto_cercano(api, candidatos)

    return candidatos


def _revisar_regla_revolucion(api, devices, nombre_regla, etiqueta, claves_ya_notificadas,
                               duracion_minima_seg=0, requiere_pto_cercano=False):
    f_fin = datetime.now(timezone.utc)
    f_inicio = f_fin - timedelta(hours=VENTANA_REVISION_HORAS)
    candidatos = _obtener_eventos_regla(api, nombre_regla, f_inicio, f_fin, duracion_minima_seg, requiere_pto_cercano)
    candidatos = [c for c in candidatos if c['clave'] not in claves_ya_notificadas]

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
    return nombre.strip().title()  # ej. "SER AMBIENTAL" -> "Ser Ambiental", para que
    # quede parejo con Bogotá/Cali/Valle como encabezado de ciudad en el resumen


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


def resolver_marca(grupos_vehiculo, mapa_grupos):
    """Busca entre los grupos del vehiculo cual es el grupo de marca (International,
    Foton, Mercedes, Volkswagen, Kenworth) y devuelve su nombre. Se usa para mostrar la
    marca real del vehiculo en vez del codigo de motor (L9/X12), que no dice nada por
    si solo a alguien reaccionando sin el tablero."""
    for g in (grupos_vehiculo or []):
        gid = g['id'] if isinstance(g, dict) else g
        info = mapa_grupos.get(gid)
        if info and es_grupo_marca(info['nombre']):
            return info['nombre'].strip().title()
    return None


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


def _obtener_fallas_alta_activas(api):
    """Todas las fallas ALTA que Geotab marca activas ahora mismo (una fila por
    vehiculo+diagnostico+modo de falla, la mas reciente). Se usa tanto para las
    alertas individuales (revisar_fallas_altas) como para el resumen consolidado
    por hora -- ahi no interesa si ya se notifico antes, se lista el estado actual."""
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
        return pd.DataFrame(), devices, dic_diag, dic_fm, mapa_grupos

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
    return activas_alta, devices, dic_diag, dic_fm, mapa_grupos


def _texto_falla(row, devices, dic_diag, dic_fm, mapa_grupos):
    """Arma los campos de texto de una fila de falla ALTA -- reutilizado por la
    alerta individual y por el resumen consolidado por hora."""
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
    return nombre_veh, ciudad, tipologia, spn, fmi, descripcion, hora_local, url_busqueda


def revisar_fallas_altas(api, claves_activas_previas):
    activas_alta, devices, dic_diag, dic_fm, mapa_grupos = _obtener_fallas_alta_activas(api)
    if activas_alta.empty:
        return set(), []

    claves_actuales = set()
    filas_nuevas = []
    for _, row in activas_alta.iterrows():
        clave = f"{row['id_camion']}|{row['diag_id']}|{row['fm_id']}"
        claves_actuales.add(clave)
        if clave in claves_activas_previas:
            continue
        filas_nuevas.append(row)

    for row in filas_nuevas:
        nombre_veh, ciudad, tipologia, spn, fmi, descripcion, hora_local, url_busqueda = _texto_falla(
            row, devices, dic_diag, dic_fm, mapa_grupos
        )
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


# ---------------------------------------------------------------------------
# Resumen consolidado por hora (ademas de las alertas individuales de arriba)
# ---------------------------------------------------------------------------

MAX_HORAS_CONSOLIDAR = 6  # si el bot estuvo mucho tiempo sin correr, no se manda un
# mensaje por cada hora perdida (serian decenas de mensajes de golpe) -- se avisa una
# vez del hueco y se retoma desde las ultimas horas recientes.

LIMITE_TELEGRAM = 3500  # margen bajo el limite real de la API de Telegram (4096
# caracteres) -- con muchas fallas ALTA activas el resumen puede superarlo facil.

TOP_N_RESUMEN = 8  # cuantos vehiculos se listan en detalle por seccion antes de
# resumir el resto en una sola linea -- la regla de PTO sola puede generar 15-20
# eventos/hora, listar cada uno hacia el mensaje larguisimo e ilegible.


def _enviar_por_partes(lineas):
    """Manda una lista de lineas como uno o mas mensajes de Telegram, partiendo en
    varios si hace falta para no pasarse del limite de caracteres de la API. Nunca
    corta una linea a la mitad."""
    partes = []
    buffer = ""
    for linea in lineas:
        candidato = f"{buffer}\n{linea}" if buffer else linea
        if len(candidato) > LIMITE_TELEGRAM and buffer:
            partes.append(buffer)
            buffer = linea
        else:
            buffer = candidato
    if buffer:
        partes.append(buffer)

    ok = True
    total = len(partes)
    for i, parte in enumerate(partes, 1):
        prefijo = f"(parte {i}/{total})\n" if total > 1 else ""
        ok = enviar_telegram(prefijo + parte) and ok
    return ok


ID_DIAGNOSTICO_RPM_MOTOR = 'aW3Nmy-ktfEuvrdkya4z0yg'  # Engine Speed (RPM) -- mismo id que usa app.py
VENTANA_RPM_SEGUNDOS = 30  # margen alrededor del evento para capturar el pico real
# (el ExceptionEvent marca cuando la condicion se sostuvo, pero el pico de RPM puede
# caer un poco antes/despues del activeFrom/activeTo exactos), igual que app.py.


def _agregar_rpm_pico(api, eventos_candidatos, ventana_segundos=VENTANA_RPM_SEGUNDOS):
    """Agrega 'rpm_pico' (float o None) a cada evento (dict con id_veh, activeFrom,
    activeTo), consultando StatusData del diagnostico de RPM en +/-ventana_segundos.
    Si falla la consulta, deja rpm_pico=None en todos en vez de frenar el resumen."""
    if not eventos_candidatos:
        return eventos_candidatos

    vehiculos = list({e['id_veh'] for e in eventos_candidatos})
    desde_global = min(e['activeFrom'] for e in eventos_candidatos) - timedelta(seconds=ventana_segundos)
    hasta_global = max(e['activeTo'] for e in eventos_candidatos) + timedelta(seconds=ventana_segundos)

    llamadas = [
        ('Get', {
            'typeName': 'StatusData',
            'search': {
                'diagnosticSearch': {'id': ID_DIAGNOSTICO_RPM_MOTOR},
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
        print(f"*** No se pudo consultar RPM para el resumen de sobre-revolucion: {e} ***")
        for ev in eventos_candidatos:
            ev['rpm_pico'] = None
        return eventos_candidatos

    lecturas_por_vehiculo = {}
    for id_veh, lecturas in zip(vehiculos, resultados):
        puntos = []
        for l in (lecturas or []):
            try:
                puntos.append((pd.to_datetime(l['dateTime']), float(l.get('data'))))
            except (TypeError, ValueError):
                continue
        lecturas_por_vehiculo[id_veh] = puntos

    for e in eventos_candidatos:
        desde = e['activeFrom'] - timedelta(seconds=ventana_segundos)
        hasta = e['activeTo'] + timedelta(seconds=ventana_segundos)
        valores = [v for (t, v) in lecturas_por_vehiculo.get(e['id_veh'], []) if desde <= t <= hasta]
        e['rpm_pico'] = max(valores) if valores else None

    return eventos_candidatos


def _resumen_eventos_revolucion_hora(api, devices, mapa_grupos, inicio_utc, fin_utc):
    """Eventos de sobre-revolucion (las 3 reglas) con activeFrom dentro de
    [inicio_utc, fin_utc). Se recalcula siempre desde los ExceptionEvent de Geotab --
    no depende de que claves ya se notificaron individualmente."""
    fuentes = [
        (NOMBRE_REGLA_RPM_POR_MOTOR['L9'], 'L9', DURACION_MINIMA_SEG, False),
        (NOMBRE_REGLA_RPM_POR_MOTOR['X12'], 'X12', DURACION_MINIMA_SEG, False),
        (NOMBRE_REGLA_PTO, '1300 RPM', DURACION_MINIMA_PTO_SEG, True),
    ]
    filas = []
    for nombre_regla, etiqueta, duracion_minima, requiere_pto in fuentes:
        candidatos = _obtener_eventos_regla(api, nombre_regla, inicio_utc, fin_utc, duracion_minima, requiere_pto)
        _agregar_rpm_pico(api, candidatos)
        for c in candidatos:
            vehiculo = devices.get(c['id_veh'], {})
            ciudad, _ = resolver_ciudad_tipologia(vehiculo.get('groups'), mapa_grupos)
            marca = resolver_marca(vehiculo.get('groups'), mapa_grupos)
            filas.append({
                'nombre_veh': vehiculo.get('name', c['id_veh']),
                'ciudad': ciudad,
                'etiqueta': etiqueta,
                'marca': marca or etiqueta,
                'hora_local': c['activeFrom'].tz_convert(ZONA_BOGOTA).strftime('%H:%M:%S'),
                'duracion_seg': c['duracion_seg'],
                'rpm_pico': c.get('rpm_pico'),
            })
    filas.sort(key=lambda f: f['hora_local'])
    return filas


def _agrupar_por_ciudad(items, clave_ciudad=lambda x: x['ciudad']):
    """Agrupa una lista en un dict {ciudad: [items]}, ordenado por cantidad de items
    descendente y con 'Sin ciudad asignada' siempre al final (si aparece)."""
    grupos = {}
    for item in items:
        grupos.setdefault(clave_ciudad(item), []).append(item)
    ciudades = [c for c in grupos if c != 'Sin ciudad asignada']
    ciudades.sort(key=lambda c: -len(grupos[c]))
    if 'Sin ciudad asignada' in grupos:
        ciudades.append('Sin ciudad asignada')
    return [(c, grupos[c]) for c in ciudades]


def _construir_resumen_hora(api, inicio_local, fin_local):
    devices = {d['id']: d for d in api.get('Device')}
    mapa_grupos = obtener_mapa_grupos(api)
    inicio_utc = inicio_local.astimezone(timezone.utc)
    fin_utc = fin_local.astimezone(timezone.utc)

    eventos_revolucion = _resumen_eventos_revolucion_hora(api, devices, mapa_grupos, inicio_utc, fin_utc)
    activas_alta, _, dic_diag, dic_fm, _ = _obtener_fallas_alta_activas(api)

    encabezado = f"📊 RESUMEN {inicio_local.strftime('%H:%M')}–{fin_local.strftime('%H:%M')} ({inicio_local.strftime('%d/%m/%Y')})"

    # Se arman DOS mensajes separados (sobre-revolucion / fallas) en vez de uno solo --
    # asi cada uno queda completo y legible por si mismo aunque _enviar_por_partes tenga
    # que dividirlo por longitud; un solo mensaje largo se puede partir a la mitad de
    # una ciudad o un vehiculo, lo cual es mas confuso de leer.
    # Las secciones van organizadas por ciudad (no una lista plana) -- con operacion en
    # varias ciudades, revisar todo mezclado obliga a leer la lista entera para
    # encontrar lo propio. Dentro de cada ciudad, agrupado por vehiculo (no una linea
    # por evento) y sin truncar: el usuario necesita el dato completo para poder
    # reaccionar sin el tablero.
    lineas_revolucion = [encabezado]
    lineas_revolucion.append(f"\n🏎️ Sobre-revolución en esta hora ({len(eventos_revolucion)} eventos):")
    lineas_revolucion.append(
        f"  L9 = {NOMBRE_REGLA_RPM_POR_MOTOR['L9']} | X12 = {NOMBRE_REGLA_RPM_POR_MOTOR['X12']} | "
        f"1300 RPM = {NOMBRE_REGLA_PTO}"
    )
    if eventos_revolucion:
        for ciudad, eventos_ciudad in _agrupar_por_ciudad(eventos_revolucion):
            lineas_revolucion.append(f"  {ciudad}:")
            por_vehiculo = {}
            for f in eventos_ciudad:
                por_vehiculo.setdefault(f['nombre_veh'], []).append(f)
            for nombre_veh, eventos_veh in sorted(por_vehiculo.items(), key=lambda kv: -len(kv[1])):
                # La marca es la misma para todos los eventos del vehiculo -- va en el
                # encabezado, no repetida en cada linea.
                marca = eventos_veh[0]['marca']
                lineas_revolucion.append(f"    {nombre_veh} ({marca}, {len(eventos_veh)} evento(s)):")
                for e in sorted(eventos_veh, key=lambda x: x['hora_local']):
                    rpm = f", pico {e['rpm_pico']:.0f} RPM" if e.get('rpm_pico') is not None else ""
                    lineas_revolucion.append(f"      • {e['hora_local']} — {e['duracion_seg']:.0f}s{rpm}")
    else:
        lineas_revolucion.append("  Sin eventos en esta hora.")

    # Separado en dos bloques -- si el codigo acaba de salir hay que poder reaccionar
    # sin el tablero (hora + SPN/FMI + descripcion completos), pero una falla que lleva
    # semanas activa no debe repetirse con el mismo detalle cada hora ni desaparecer del
    # resumen -- se resume por vehiculo.
    nuevas = activas_alta[
        (activas_alta['dateTime'] >= inicio_utc) & (activas_alta['dateTime'] < fin_utc)
    ] if not activas_alta.empty else activas_alta
    persistentes = activas_alta[activas_alta['dateTime'] < inicio_utc] if not activas_alta.empty else activas_alta

    lineas_fallas = [encabezado]
    lineas_fallas.append(f"\n🆕 Fallas ALTA nuevas esta hora ({len(nuevas)}):")
    if not nuevas.empty:
        filas_nuevas = []
        for _, row in nuevas.sort_values('dateTime', ascending=False).iterrows():
            nombre_veh, ciudad, _, spn, fmi, descripcion, hora_local, _ = _texto_falla(row, devices, dic_diag, dic_fm, mapa_grupos)
            filas_nuevas.append({'ciudad': ciudad, 'texto': f"    • {nombre_veh} — {hora_local}: SPN {spn}/FMI {fmi} {descripcion}"})
        for ciudad, filas_ciudad in _agrupar_por_ciudad(filas_nuevas):
            lineas_fallas.append(f"  {ciudad}:")
            lineas_fallas.extend(f['texto'] for f in filas_ciudad)
    else:
        lineas_fallas.append("  Ninguna.")

    lineas_fallas.append(
        f"\n⏳ Fallas ALTA persistentes sin resolver "
        f"({len(persistentes)} en {persistentes['id_camion'].nunique() if not persistentes.empty else 0} vehículos):"
    )
    if not persistentes.empty:
        ahora_utc = datetime.now(timezone.utc)
        filas_persistentes = []
        for _, grupo in persistentes.groupby('id_camion'):
            fila_mas_vieja = grupo.sort_values('dateTime', ascending=True).iloc[0]
            nombre_veh, ciudad, _, _, _, _, _, _ = _texto_falla(fila_mas_vieja, devices, dic_diag, dic_fm, mapa_grupos)
            dias_activa = (ahora_utc - fila_mas_vieja['dateTime']).days
            filas_persistentes.append({
                'ciudad': ciudad,
                'n_codigos': len(grupo),
                'texto': f"    • {nombre_veh}: {len(grupo)} código(s), la más vieja lleva {dias_activa} día(s) activa",
            })
        for ciudad, filas_ciudad in _agrupar_por_ciudad(filas_persistentes):
            lineas_fallas.append(f"  {ciudad}:")
            for f in sorted(filas_ciudad, key=lambda x: -x['n_codigos']):
                lineas_fallas.append(f['texto'])
    else:
        lineas_fallas.append("  Ninguna.")

    return lineas_revolucion, lineas_fallas


def enviar_resumenes_por_hora(api, estado):
    """Manda un resumen consolidado por cada hora reloj (Bogota) ya completada desde
    el ultimo resumen enviado. Como el cron de GitHub Actions no corre exactamente
    cada 5 min (puede tardar 20-50 min en la practica), esto se detecta por
    comparacion de horas, no por conteo de corridas -- funciona sin importar cuando
    exactamente caiga cada ejecucion del workflow."""
    ahora_local = datetime.now(ZONA_BOGOTA)
    hora_actual = ahora_local.replace(minute=0, second=0, microsecond=0)

    ultima_str = estado.get('ultima_hora_resumen')
    if not ultima_str:
        # Primera vez que corre esta funcion -- no hay una hora de referencia previa
        # confiable, asi que solo se marca el punto de partida sin mandar nada.
        estado['ultima_hora_resumen'] = hora_actual.isoformat()
        return

    try:
        ultima_hora = datetime.fromisoformat(ultima_str)
    except ValueError:
        estado['ultima_hora_resumen'] = hora_actual.isoformat()
        return

    if ultima_hora >= hora_actual:
        return  # todavia no se completa una hora nueva desde el ultimo resumen

    horas_pendientes = int((hora_actual - ultima_hora).total_seconds() // 3600)
    if horas_pendientes > MAX_HORAS_CONSOLIDAR:
        enviar_telegram(
            f"⚠️ El resumen por hora estuvo detenido ~{horas_pendientes} horas "
            f"(desde las {ultima_hora.strftime('%H:%M del %d/%m')}). Se retoma desde "
            f"las {(hora_actual - timedelta(hours=MAX_HORAS_CONSOLIDAR)).strftime('%H:%M')}."
        )
        ultima_hora = hora_actual - timedelta(hours=MAX_HORAS_CONSOLIDAR)

    while ultima_hora < hora_actual:
        fin_hora = ultima_hora + timedelta(hours=1)
        try:
            lineas_revolucion, lineas_fallas = _construir_resumen_hora(api, ultima_hora, fin_hora)
            _enviar_por_partes(lineas_revolucion)
            _enviar_por_partes(lineas_fallas)
            print(f"Resumen por hora enviado (2 mensajes): {ultima_hora.strftime('%H:%M')}-{fin_hora.strftime('%H:%M')}")
        except Exception as e:
            print(f"*** Error armando/enviando el resumen de {ultima_hora.strftime('%H:%M')}: {e} ***")
        ultima_hora = fin_hora
        estado['ultima_hora_resumen'] = ultima_hora.isoformat()


def main():
    api = conectar_geotab()
    estado = cargar_estado()
    print(f"Estado cargado: {len(estado['revolucion_notificados'])} eventos de revolucion, "
          f"{len(estado['fallas_alta_activas'])} fallas ALTA activas previas.")

    # Se guarda el estado pase lo que pase (incluso si algo falla a mitad de camino),
    # para no volver a notificar lo que ya se envio en esta misma corrida. Sin esto,
    # una excepcion a mitad de camino deja el estado desactualizado y TODO se vuelve a
    # notificar en la siguiente corrida (5 min despues), y en la siguiente, indefinidamente.
    try:
        responder_mensajes_nuevos(estado)

        claves_revolucion_previas = set(estado['revolucion_notificados'])
        claves_revolucion_nuevas = revisar_sobre_revolucion(api, claves_revolucion_previas)
        estado['revolucion_notificados'] = list(claves_revolucion_previas | set(claves_revolucion_nuevas))

        claves_fallas_previas = set(estado['fallas_alta_activas'])
        claves_fallas_actuales, _ = revisar_fallas_altas(api, claves_fallas_previas)
        estado['fallas_alta_activas'] = list(claves_fallas_actuales)

        enviar_resumenes_por_hora(api, estado)
    finally:
        guardar_estado(estado)


if __name__ == "__main__":
    main()
