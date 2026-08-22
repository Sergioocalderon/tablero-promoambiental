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
import tempfile
from datetime import datetime, timedelta, timezone
from xml.sax.saxutils import escape as escapar_xml
from zoneinfo import ZoneInfo

import mygeotab
import pandas as pd
import requests
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter, landscape
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer

ZONA_BOGOTA = ZoneInfo("America/Bogota")
ESTADO_PATH = "telegram_estado.json"
MAX_CLAVES_GUARDADAS = 5000  # evita que el estado de eventos (append-only) crezca sin limite

# Filtro temporal a una sola ciudad -- ya se esta rodando a nivel nacional, pero por
# ahora el seguimiento (Telegram) solo se quiere en Bogota mientras se mejora el
# proceso; poner en None reactiva todas las ciudades sin tocar nada mas del codigo.
CIUDAD_FILTRO = 'Bogotá'

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
        "ultimo_update_id_procesado": None, "suscriptores": [], "ultimo_turno_fin": None,
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
        for clave in ("revolucion_notificados", "fallas_alta_activas", "suscriptores"):
            valor = datos.get(clave)
            if isinstance(valor, list):
                estado[clave] = valor
        for clave in ("ultima_hora_resumen", "ultimo_turno_fin"):
            valor = datos.get(clave)
            if isinstance(valor, str):
                estado[clave] = valor
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
        "suscriptores": estado.get("suscriptores", []),
        "ultimo_turno_fin": estado.get("ultimo_turno_fin"),
    }
    with open(ESTADO_PATH, "w", encoding="utf-8") as f:
        json.dump(estado_a_guardar, f)


# Se llena en main() (desde estado['suscriptores']) antes de mandar cualquier alerta,
# asi enviar_telegram() no necesita que le pasen el estado explicitamente en cada
# llamada -- son varias a lo largo del script.
_CHAT_IDS_SUSCRITOS = []


def _chat_ids_destino():
    """Lista final de chat_id a los que se manda cada alerta: los fijos en
    TELEGRAM_CHAT_ID (separados por coma, ej. '111111,222222') mas los que se
    auto-suscribieron escribiendole /start al bot (ver
    _CHAT_IDS_SUSCRITOS/responder_mensajes_nuevos), sin duplicados."""
    chat_ids_fijos = [c.strip() for c in os.environ["TELEGRAM_CHAT_ID"].split(",") if c.strip()]
    return list(dict.fromkeys(chat_ids_fijos + _CHAT_IDS_SUSCRITOS))


def enviar_telegram(texto):
    """Manda el mismo mensaje a todos los chat_id de _chat_ids_destino(), sin
    necesitar que compartan un grupo. Devuelve True si se le pudo mandar a al menos
    uno -- si se exigiera que le llegue a TODOS, un solo destinatario con problemas
    (bloqueo el bot, chat_id invalido) haria que el evento se reintente sin parar."""
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    ok_alguno = False
    for chat_id in _chat_ids_destino():
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


def responder_mensajes_nuevos(api, estado):
    """Revisa (via getUpdates) mensajes nuevos que le hayan escrito al bot y
    responde segun el comando:
    - /start: agrega el chat_id a la lista de suscriptores (estado['suscriptores'])
      y manda un mensaje de bienvenida -- asi queda recibiendo alertas de una vez,
      sin que un admin tenga que actualizar el secret TELEGRAM_CHAT_ID a mano.
    - /reporte: genera al vuelo un PDF con todas las fallas activas (cualquier
      criticidad) y se lo manda a quien lo pidio.
    Usa el offset guardado en el estado para no re-procesar ni re-responder los
    mismos mensajes en cada corrida del cron (cada 5 min); nunca lanza una
    excepcion que frene el resto del script."""
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

    estado.setdefault("suscriptores", [])
    for act in actualizaciones:
        estado["ultimo_update_id_procesado"] = act["update_id"]
        mensaje = act.get("message") or {}
        texto = (mensaje.get("text") or "").strip()
        chat_id = mensaje.get("chat", {}).get("id")
        if chat_id is None:
            continue

        if texto.startswith("/start"):
            chat_id_str = str(chat_id)
            if chat_id_str not in estado["suscriptores"]:
                estado["suscriptores"].append(chat_id_str)
                print(f"Nuevo suscriptor agregado: chat_id={chat_id_str}")
            try:
                requests.post(
                    f"https://api.telegram.org/bot{token}/sendMessage",
                    json={"chat_id": chat_id, "text": TEXTO_BIENVENIDA},
                    timeout=15,
                )
                print(f"Bienvenida enviada a chat_id={chat_id}")
            except Exception as e:
                print(f"*** No se pudo enviar bienvenida a chat_id={chat_id}: {e} ***")

        elif texto.startswith("/reporte"):
            ruta_pdf = None
            try:
                ruta_pdf = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False).name
                generar_pdf_reporte_fallas(api, ruta_pdf)
                nombre_archivo = f"reporte_fallas_{datetime.now(ZONA_BOGOTA).strftime('%Y%m%d_%H%M')}.pdf"
                _enviar_documento_telegram(chat_id, ruta_pdf, nombre_archivo, "📄 Reporte de fallas activas")
                print(f"Reporte PDF enviado a chat_id={chat_id}")
            except Exception as e:
                print(f"*** No se pudo generar/enviar el reporte PDF a chat_id={chat_id}: {e} ***")
            finally:
                if ruta_pdf and os.path.exists(ruta_pdf):
                    os.remove(ruta_pdf)


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


def _revisar_regla_revolucion(api, devices, mapa_grupos, nombre_regla, claves_ya_notificadas, duracion_minima_seg):
    """Siempre exige PTO activo cerca (±VENTANA_PTO_MINUTOS) -- la regla de 1300 RPM no
    lo trae en su condicion (el PTO es un pulso, no se puede exigir sostenido), asi que
    se confirma aca aparte, para no generar ruido con ralenti alto sin compactador."""
    f_fin = datetime.now(timezone.utc)
    f_inicio = f_fin - timedelta(hours=VENTANA_REVISION_HORAS)
    candidatos = _obtener_eventos_regla(api, nombre_regla, f_inicio, f_fin, duracion_minima_seg, requiere_pto_cercano=True)
    candidatos = [c for c in candidatos if c['clave'] not in claves_ya_notificadas]
    if CIUDAD_FILTRO:
        candidatos = [
            c for c in candidatos
            if resolver_ciudad_tipologia(devices.get(c['id_veh'], {}).get('groups'), mapa_grupos)[0] == CIUDAD_FILTRO
        ]

    claves_nuevas = []
    for c in candidatos:
        nombre_veh = devices.get(c['id_veh'], {}).get('name', c['id_veh'])
        hora_local = c['activeFrom'].tz_convert(ZONA_BOGOTA).strftime('%d/%m/%Y %H:%M:%S')
        texto = (
            f"🏎️ SOBRE-REVOLUCIÓN CON PTO ACTIVO\n"
            f"Vehículo: {nombre_veh}\n"
            f"Hora: {hora_local}\n"
            f"Duración: {c['duracion_seg']:.0f} segundos sostenidos\n"
            f"Vehículo detenido con RPM alto, PTO activo cerca (±{VENTANA_PTO_MINUTOS} min)."
        )
        if enviar_telegram(texto):
            print(f"Notificado: {c['clave']} ({c['duracion_seg']:.0f}s)")
            claves_nuevas.append(c['clave'])

    return claves_nuevas


def revisar_sobre_revolucion(api, claves_ya_notificadas):
    """Solo la regla SOBRE REVOLUCIÓN CON PTO -- la de L9/X12 (RPM alto en recorrido,
    sin exigir vehiculo detenido) mide algo distinto y se dejo fuera de las alertas
    individuales, igual que ya se hizo en el tablero (app.py)."""
    devices = {d['id']: d for d in api.get('Device')}
    mapa_grupos = obtener_mapa_grupos(api)

    claves_nuevas = _revisar_regla_revolucion(
        api, devices, mapa_grupos, NOMBRE_REGLA_PTO, claves_ya_notificadas, duracion_minima_seg=DURACION_MINIMA_PTO_SEG
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


def _obtener_fallas_activas(api):
    """Todas las fallas activas ahora mismo (cualquier criticidad), una fila por
    vehiculo+diagnostico+modo de falla (la mas reciente). Base comun para
    _obtener_fallas_alta_activas (solo ALTA, usada por las alertas y el resumen por
    hora) y para el reporte PDF completo (todas las criticidades, ver
    generar_pdf_reporte_fallas)."""
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

    # Una fila por combinacion vehiculo+diagnostico+modo de falla (la mas reciente)
    activas = activas.sort_values('dateTime').drop_duplicates(
        subset=['id_camion', 'diag_id', 'fm_id'], keep='last'
    )

    if CIUDAD_FILTRO and not activas.empty:
        def _ciudad_del_vehiculo(id_camion):
            ciudad, _ = resolver_ciudad_tipologia(devices.get(id_camion, {}).get('groups'), mapa_grupos)
            return ciudad
        activas = activas[activas['id_camion'].apply(_ciudad_del_vehiculo) == CIUDAD_FILTRO]

    return activas, devices, dic_diag, dic_fm, mapa_grupos


def _obtener_fallas_alta_activas(api):
    """Solo las fallas ALTA de _obtener_fallas_activas -- usado por las alertas
    individuales (revisar_fallas_altas) y el resumen consolidado por hora, donde no
    interesa si ya se notifico antes, se lista el estado actual."""
    activas, devices, dic_diag, dic_fm, mapa_grupos = _obtener_fallas_activas(api)
    if not activas.empty:
        activas = activas[activas['criticidad'] == 'ALTA']
    return activas, devices, dic_diag, dic_fm, mapa_grupos


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
# Reporte PDF de fallas activas, bajo demanda (comando /reporte en Telegram)
# ---------------------------------------------------------------------------

ORDEN_CRITICIDAD = {'ALTA': 3, 'MEDIA': 2, 'BAJA': 1}
COLOR_POR_CRITICIDAD = {
    'ALTA': colors.HexColor('#ED7D31'), 'MEDIA': colors.HexColor('#FFC000'), 'BAJA': colors.HexColor('#A9D18E'),
}
COLOR_TITULO_PDF = colors.HexColor('#1F4E79')
COLOR_CIUDAD_PDF = colors.HexColor('#0B5345')
COLOR_DESTACADO = colors.HexColor('#C00000')

# Coincidencia por palabra dentro del NOMBRE que ya da Geotab para el diagnostico --
# sin diccionario propio de codigos: son las categorias que mas urgen por riesgo de
# accidente (frenado / control de direccion), asi que se resaltan para que no se
# pierdan entre el resto de fallas de un vehiculo.
PALABRAS_CLAVE_DESTACADAS = ['abs', 'neumático', 'neumatico', 'llanta']


def _es_falla_destacada(nombre_diagnostico):
    nombre_l = (nombre_diagnostico or '').lower()
    return any(palabra in nombre_l for palabra in PALABRAS_CLAVE_DESTACADAS)


def generar_pdf_reporte_fallas(api, ruta_salida, desde_local=None, hasta_local=None):
    """Genera un PDF con fallas activas (cualquier criticidad), agrupadas por ciudad
    y luego por criticidad -- mismo espiritu que el reporte de Google Sheets del
    usuario, pero usando directo el nombre/codigo/criticidad que da Geotab (sin el
    diccionario manual de 1000+ codigos), para no mantener esa misma informacion
    duplicada en dos lugares distintos.

    Sin desde_local/hasta_local: TODAS las fallas activas ahora mismo (usado por
    /reporte). Con ambos: solo las que aparecieron dentro de ese rango (usado por el
    reporte automatico de fin de turno -- ahi interesa lo nuevo del turno, no repetir
    el backlog completo cada vez, que es lo que lo volvia larguisimo)."""
    activas, devices, dic_diag, dic_fm, mapa_grupos = _obtener_fallas_activas(api)
    if desde_local is not None and hasta_local is not None and not activas.empty:
        desde_utc = desde_local.astimezone(timezone.utc)
        hasta_utc = hasta_local.astimezone(timezone.utc)
        activas = activas[(activas['dateTime'] >= desde_utc) & (activas['dateTime'] < hasta_utc)]

    estilos = getSampleStyleSheet()
    estilo_celda = ParagraphStyle('celda', parent=estilos['Normal'], fontSize=8, leading=11)
    estilo_seccion = ParagraphStyle('seccion', parent=estilos['Heading3'], textColor=colors.white, spaceAfter=0, spaceBefore=0)

    if desde_local is not None and hasta_local is not None:
        subtitulo = (
            f"Fallas nuevas entre {desde_local.strftime('%H:%M')} y {hasta_local.strftime('%H:%M')} del "
            f"{desde_local.strftime('%d/%m/%Y')} — criterio de criticidad de Geotab (luces del vehículo)"
        )
    else:
        subtitulo = f"Generado el {datetime.now(ZONA_BOGOTA).strftime('%d/%m/%Y %H:%M')} — fuente: criterio de criticidad de Geotab (luces del vehículo)"

    elementos = [
        Paragraph("Seguimiento de Fallas", estilos['Title']),
        Paragraph(subtitulo, estilos['Normal']),
        Spacer(1, 0.5 * cm),
    ]

    if activas.empty:
        elementos.append(Paragraph("No hay fallas activas en este momento.", estilos['Normal']))
    else:
        por_vehiculo = {}
        for _, fila in activas.iterrows():
            por_vehiculo.setdefault(fila['id_camion'], []).append(fila)

        filas_reporte = []
        for id_camion, filas in por_vehiculo.items():
            vehiculo = devices.get(id_camion, {})
            ciudad, _ = resolver_ciudad_tipologia(vehiculo.get('groups'), mapa_grupos)
            marca = resolver_marca(vehiculo.get('groups'), mapa_grupos) or 'Sin marca'
            marca_l = marca.lower()
            referencia_motor = next(
                (v for k, v in REFERENCIA_MOTOR_POR_MARCA.items() if k in marca_l), 'Desconocido'
            )
            vin = vehiculo.get('engineVehicleIdentificationNumber') or ''
            n_motor = vin[-6:] if vin else 'Sin registrar'

            items = []
            for fila in sorted(filas, key=lambda f: f['dateTime'], reverse=True):
                diag_info = dic_diag.get(fila['diag_id'], {'nombre': 'Diagnóstico desconocido', 'codigo': None})
                fm_info = dic_fm.get(fila['fm_id'], {'nombre': '', 'codigo': None})
                items.append({
                    'spn': diag_info.get('codigo') or '?',
                    'fmi': fm_info.get('codigo') or '?',
                    'nombre': diag_info['nombre'],
                    'criticidad': fila['criticidad'],
                    'hora': fila['dateTime'].tz_convert(ZONA_BOGOTA).strftime('%d/%m/%Y %H:%M:%S'),
                    'destacado': _es_falla_destacada(diag_info['nombre']),
                })

            criticidad_max = max(items, key=lambda it: ORDEN_CRITICIDAD.get(it['criticidad'], 0))['criticidad']
            filas_reporte.append({
                'ciudad': ciudad, 'criticidad': criticidad_max,
                'movil': vehiculo.get('name', id_camion), 'marca': marca,
                'referencia_motor': referencia_motor, 'n_motor': n_motor, 'items': items,
            })

        ciudades = sorted(
            {f['ciudad'] for f in filas_reporte},
            key=lambda c: (c == 'Sin ciudad asignada', c)
        )
        for ciudad in ciudades:
            filas_ciudad = [f for f in filas_reporte if f['ciudad'] == ciudad]
            elementos.append(Spacer(1, 0.3 * cm))
            tabla_ciudad = Table(
                [[Paragraph(f"{ciudad}  (Total vehículos: {len(filas_ciudad)})", estilo_seccion)]],
                colWidths=[24 * cm]
            )
            tabla_ciudad.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), COLOR_CIUDAD_PDF), ('LEFTPADDING', (0, 0), (-1, -1), 6)]))
            elementos.append(tabla_ciudad)

            for criticidad in ('ALTA', 'MEDIA', 'BAJA'):
                filas_nivel = [f for f in filas_ciudad if f['criticidad'] == criticidad]
                if not filas_nivel:
                    continue

                tabla_nivel = Table(
                    [[Paragraph(f"{criticidad}  (Cantidad: {len(filas_nivel)})", estilo_seccion)]],
                    colWidths=[24 * cm]
                )
                tabla_nivel.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), COLOR_POR_CRITICIDAD[criticidad]), ('LEFTPADDING', (0, 0), (-1, -1), 6)]))
                elementos.append(tabla_nivel)

                encabezado = ['Móvil', 'Marca', 'Ref. Motor', 'N° Motor', 'Fallas activas']
                datos_tabla = [encabezado]
                for f in filas_nivel:
                    partes_detalle = []
                    for idx, it in enumerate(f['items'], 1):
                        # Mayuscula ANTES de escapar entidades XML (si se aplicara despues,
                        # ".upper()" corrompe entidades como "&amp;" -> "&AMP;").
                        nombre = it['nombre'].upper() if it['destacado'] else it['nombre']
                        linea = f"{idx}. SPN {it['spn']}/FMI {it['fmi']} — {escapar_xml(nombre)} [{it['criticidad']}] — {it['hora']}"
                        if it['destacado']:
                            linea = f"<font color='#C00000'><b>{linea}</b></font>"
                        partes_detalle.append(linea)
                    detalle = Paragraph("<br/>".join(partes_detalle), estilo_celda)
                    datos_tabla.append([
                        f['movil'], f['marca'], f['referencia_motor'], f['n_motor'], detalle
                    ])

                tabla = Table(datos_tabla, colWidths=[3.5 * cm, 3.5 * cm, 2.5 * cm, 2.8 * cm, 11.7 * cm], repeatRows=1)
                tabla.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#E7E6E6')),
                    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                    ('FONTSIZE', (0, 0), (-1, -1), 8),
                    ('GRID', (0, 0), (-1, -1), 0.5, colors.grey),
                    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ]))
                elementos.append(tabla)
                elementos.append(Spacer(1, 0.2 * cm))

    doc = SimpleDocTemplate(
        ruta_salida, pagesize=landscape(letter),
        leftMargin=1 * cm, rightMargin=1 * cm, topMargin=1 * cm, bottomMargin=1 * cm,
    )
    doc.build(elementos)
    return len(activas)  # cuantas fallas quedaron incluidas -- para que el llamador
    # decida si vale la pena mandar el PDF (ej. el reporte de turno no manda nada si
    # dio 0, en vez de intentar detectarlo leyendo el PDF ya comprimido)


def _enviar_documento_telegram(chat_id, ruta_archivo, nombre_archivo, caption=None):
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    with open(ruta_archivo, 'rb') as f:
        resp = requests.post(
            f"https://api.telegram.org/bot{token}/sendDocument",
            data={"chat_id": chat_id, "caption": caption or ""},
            files={"document": (nombre_archivo, f, "application/pdf")},
            timeout=60,
        )
    if not resp.ok:
        print(f"*** Error enviando documento a Telegram (chat_id={chat_id}): {resp.status_code} {resp.text} ***")
    return resp.ok


# ---------------------------------------------------------------------------
# Reporte PDF automatico de fin de turno (R1/R2/R3)
# ---------------------------------------------------------------------------

HORAS_INICIO_TURNO = [5, 13, 21]  # R1, R2, R3 -- mismo criterio que clasificar_turno en app.py
MAX_TURNOS_CONSOLIDAR = 3  # si el bot estuvo detenido mucho tiempo, no manda un PDF
# por cada turno perdido de golpe -- avisa una vez del hueco y retoma desde los
# ultimos turnos recientes (3 turnos = 24h).


def _limites_turno(momento_local):
    """Devuelve (nombre, inicio, fin) del turno (R1/R2/R3) que contiene momento_local.
    R3 cruza medianoche (21h a 5h del dia siguiente), asi que se arman los bloques de
    hoy Y de ayer antes de buscar cual contiene el momento dado."""
    dia_base = momento_local.replace(hour=0, minute=0, second=0, microsecond=0)
    for offset_dias in (-1, 0):
        base = dia_base + timedelta(days=offset_dias)
        for i, hora in enumerate(HORAS_INICIO_TURNO):
            inicio = base.replace(hour=hora)
            fin = inicio + timedelta(hours=8)
            if inicio <= momento_local < fin:
                return f"R{i + 1}", inicio, fin
    raise ValueError(f"No se pudo determinar el turno para {momento_local}")  # no deberia pasar


def _construir_texto_persistentes(api, inicio_turno, nombre_turno):
    """Lista compacta (una linea por vehiculo, no el detalle completo) de las fallas
    que ya estaban activas ANTES de que empezara este turno y siguen activas ahora --
    para no perder el rastro de lo que lleva dias sin resolverse, ya que el PDF del
    turno solo trae lo nuevo. Mismo criterio que el bloque persistentes del resumen
    por hora, pero con todas las criticidades (no solo ALTA)."""
    activas, devices, dic_diag, dic_fm, mapa_grupos = _obtener_fallas_activas(api)
    if activas.empty:
        return []

    inicio_turno_utc = inicio_turno.astimezone(timezone.utc)
    persistentes = activas[activas['dateTime'] < inicio_turno_utc]
    if persistentes.empty:
        return []

    ahora_utc = datetime.now(timezone.utc)
    filas_persistentes = []
    for _, grupo in persistentes.groupby('id_camion'):
        fila_mas_vieja = grupo.sort_values('dateTime', ascending=True).iloc[0]
        nombre_veh, ciudad, _, _, _, _, _, _ = _texto_falla(fila_mas_vieja, devices, dic_diag, dic_fm, mapa_grupos)
        dias_activa = (ahora_utc - fila_mas_vieja['dateTime']).days
        filas_persistentes.append({
            'ciudad': ciudad, 'n_codigos': len(grupo),
            'texto': f"  • {nombre_veh}: {len(grupo)} código(s), la más vieja lleva {dias_activa} día(s) activa",
        })

    lineas = [
        f"⏳ Fallas persistentes sin resolver (turno {nombre_turno}) — "
        f"{len(persistentes)} en {persistentes['id_camion'].nunique()} vehículos:"
    ]
    for ciudad, filas_ciudad in _agrupar_por_ciudad(filas_persistentes):
        lineas.append(f"{ciudad}:")
        for f in sorted(filas_ciudad, key=lambda x: -x['n_codigos']):
            lineas.append(f['texto'])
    return lineas


def enviar_resumenes_por_turno(api, estado):
    """Manda un PDF cada vez que se completa un turno (R1 termina 13h, R2 21h, R3 5h
    del dia siguiente), con SOLO las fallas que aparecieron nuevas durante ese turno
    (no el backlog completo de 30 dias que trae /reporte) -- asi queda corto y
    accionable en vez de las 29 paginas que salian al mandar todo. Si el turno no tuvo
    fallas nuevas, no se manda nada (silencio quiere decir que no paso nada). Mismo
    patron de deteccion por comparacion de tiempos que enviar_resumenes_por_hora, para
    no depender de que el cron corra justo en el corte del turno."""
    ahora_local = datetime.now(ZONA_BOGOTA)
    _, inicio_turno_actual, _ = _limites_turno(ahora_local)

    ultimo_str = estado.get('ultimo_turno_fin')
    if not ultimo_str:
        # Primera vez que corre esta funcion -- no hay un turno de referencia previo
        # confiable, asi que solo se marca el punto de partida sin mandar nada.
        estado['ultimo_turno_fin'] = inicio_turno_actual.isoformat()
        return

    try:
        ultimo_turno_fin = datetime.fromisoformat(ultimo_str)
    except ValueError:
        estado['ultimo_turno_fin'] = inicio_turno_actual.isoformat()
        return

    if ultimo_turno_fin >= inicio_turno_actual:
        return  # el turno actual todavia no termina

    turnos_pendientes = int((inicio_turno_actual - ultimo_turno_fin).total_seconds() // (8 * 3600))
    if turnos_pendientes > MAX_TURNOS_CONSOLIDAR:
        enviar_telegram(
            f"⚠️ El reporte de fin de turno estuvo detenido ~{turnos_pendientes} turnos "
            f"(desde las {ultimo_turno_fin.strftime('%H:%M del %d/%m')}). Se retoma desde "
            f"los ultimos {MAX_TURNOS_CONSOLIDAR}."
        )
        ultimo_turno_fin = inicio_turno_actual - timedelta(hours=8 * MAX_TURNOS_CONSOLIDAR)

    while ultimo_turno_fin < inicio_turno_actual:
        nombre_turno, inicio_turno, fin_turno = _limites_turno(ultimo_turno_fin)
        ruta_pdf = None
        try:
            ruta_pdf = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False).name
            n_fallas = generar_pdf_reporte_fallas(api, ruta_pdf, desde_local=inicio_turno, hasta_local=fin_turno)
            # Si no hubo fallas nuevas, no vale la pena mandar el PDF -- silencio es la
            # mejor senal de que no paso nada en ese turno.
            if n_fallas == 0:
                print(f"Turno {nombre_turno} ({inicio_turno.strftime('%d/%m %H:%M')}-{fin_turno.strftime('%H:%M')}): sin fallas nuevas, no se manda nada.")
            else:
                nombre_archivo = f"reporte_{nombre_turno}_{fin_turno.strftime('%Y%m%d')}.pdf"
                caption = f"📄 Fallas nuevas — turno {nombre_turno} ({inicio_turno.strftime('%H:%M')}-{fin_turno.strftime('%H:%M')})"
                for chat_id in _chat_ids_destino():
                    _enviar_documento_telegram(chat_id, ruta_pdf, nombre_archivo, caption)
                print(f"Reporte de turno {nombre_turno} enviado.")
        except Exception as e:
            print(f"*** No se pudo generar/enviar el reporte del turno {nombre_turno}: {e} ***")
        finally:
            if ruta_pdf and os.path.exists(ruta_pdf):
                os.remove(ruta_pdf)

        try:
            lineas_persistentes = _construir_texto_persistentes(api, inicio_turno, nombre_turno)
            if lineas_persistentes:
                _enviar_por_partes(lineas_persistentes)
                print(f"Resumen de persistentes del turno {nombre_turno} enviado.")
        except Exception as e:
            print(f"*** No se pudo armar/enviar el resumen de persistentes del turno {nombre_turno}: {e} ***")

        ultimo_turno_fin = fin_turno
        estado['ultimo_turno_fin'] = ultimo_turno_fin.isoformat()


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
    """Eventos de SOBRE REVOLUCIÓN CON PTO (unica regla que interesa por ahora; la de
    L9/X12 mide algo distinto -- RPM alto en recorrido, sin exigir vehiculo detenido --
    y se dejo fuera, igual que en las alertas individuales y en el tablero) con
    activeFrom dentro de [inicio_utc, fin_utc). Se recalcula siempre desde los
    ExceptionEvent de Geotab -- no depende de que claves ya se notificaron
    individualmente."""
    candidatos = _obtener_eventos_regla(
        api, NOMBRE_REGLA_PTO, inicio_utc, fin_utc, DURACION_MINIMA_PTO_SEG, requiere_pto_cercano=True
    )
    _agregar_rpm_pico(api, candidatos)
    filas = []
    for c in candidatos:
        vehiculo = devices.get(c['id_veh'], {})
        ciudad, _ = resolver_ciudad_tipologia(vehiculo.get('groups'), mapa_grupos)
        if CIUDAD_FILTRO and ciudad != CIUDAD_FILTRO:
            continue
        marca = resolver_marca(vehiculo.get('groups'), mapa_grupos)
        filas.append({
            'nombre_veh': vehiculo.get('name', c['id_veh']),
            'ciudad': ciudad,
            'marca': marca or '1300 RPM',
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
    lineas_revolucion.append(f"\n🏎️ Sobre-revolución con PTO activo en esta hora ({len(eventos_revolucion)} eventos):")
    lineas_revolucion.append(f"  Regla: {NOMBRE_REGLA_PTO}")
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
        responder_mensajes_nuevos(api, estado)
        global _CHAT_IDS_SUSCRITOS
        _CHAT_IDS_SUSCRITOS = estado.get('suscriptores', [])

        claves_revolucion_previas = set(estado['revolucion_notificados'])
        claves_revolucion_nuevas = revisar_sobre_revolucion(api, claves_revolucion_previas)
        estado['revolucion_notificados'] = list(claves_revolucion_previas | set(claves_revolucion_nuevas))

        claves_fallas_previas = set(estado['fallas_alta_activas'])
        claves_fallas_actuales, _ = revisar_fallas_altas(api, claves_fallas_previas)
        estado['fallas_alta_activas'] = list(claves_fallas_actuales)

        enviar_resumenes_por_hora(api, estado)
        enviar_resumenes_por_turno(api, estado)
    finally:
        guardar_estado(estado)


if __name__ == "__main__":
    main()
