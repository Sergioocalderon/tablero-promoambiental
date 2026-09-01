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
import re
import tempfile
import time
from collections import Counter
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
        "revolucion_notificados": [], "fallas_activas": [], "ultima_hora_resumen": None,
        "ultimo_update_id_procesado": None, "suscriptores": [], "ultimo_turno_fin": None,
        "regeneracion_dpf_notificados": [],
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
        for clave in ("revolucion_notificados", "fallas_activas", "suscriptores", "regeneracion_dpf_notificados"):
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
        "fallas_activas": estado["fallas_activas"][-MAX_CLAVES_GUARDADAS:],
        "ultima_hora_resumen": estado.get("ultima_hora_resumen"),
        "ultimo_update_id_procesado": estado.get("ultimo_update_id_procesado"),
        "suscriptores": estado.get("suscriptores", []),
        "ultimo_turno_fin": estado.get("ultimo_turno_fin"),
        "regeneracion_dpf_notificados": estado.get("regeneracion_dpf_notificados", [])[-MAX_CLAVES_GUARDADAS:],
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
    - /reporte_velocidad: genera al vuelo un PDF con los excesos de velocidad
      (regla NOMBRE_REGLA_VELOCIDAD) del turno en curso hasta este momento.
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

        elif texto.startswith("/reporte_velocidad"):
            ruta_pdf = None
            try:
                requests.post(
                    f"https://api.telegram.org/bot{token}/sendMessage",
                    json={"chat_id": chat_id, "text": "⏳ Estamos gestionando tu solicitud, dame un momento..."},
                    timeout=15,
                )
            except Exception as e:
                print(f"*** No se pudo enviar el aviso de 'procesando' a chat_id={chat_id}: {e} ***")
            try:
                ahora_local = datetime.now(ZONA_BOGOTA)
                _, inicio_turno_actual, _ = _limites_turno(ahora_local)
                ruta_pdf = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False).name
                generar_pdf_reporte_velocidad(api, ruta_pdf, inicio_turno_actual, ahora_local)
                nombre_archivo = f"reporte_velocidad_{ahora_local.strftime('%Y%m%d_%H%M')}.pdf"
                _enviar_documento_telegram(chat_id, ruta_pdf, nombre_archivo, "🚨 Excesos de velocidad (turno en curso)")
                print(f"Reporte de velocidad PDF enviado a chat_id={chat_id}")
            except Exception as e:
                print(f"*** No se pudo generar/enviar el reporte de velocidad PDF a chat_id={chat_id}: {e} ***")
            finally:
                if ruta_pdf and os.path.exists(ruta_pdf):
                    os.remove(ruta_pdf)

        elif texto.startswith("/reporte"):
            ruta_pdf = None
            try:
                requests.post(
                    f"https://api.telegram.org/bot{token}/sendMessage",
                    json={"chat_id": chat_id, "text": "⏳ Estamos gestionando tu solicitud, dame un momento..."},
                    timeout=15,
                )
            except Exception as e:
                print(f"*** No se pudo enviar el aviso de 'procesando' a chat_id={chat_id}: {e} ***")
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
# Se probo ampliarla especificamente para Foton (donde el cruce solo confirmaba 17.6% de
# los eventos) pero un analisis por sesiones reales de PTO mostro que el PTO ahi pulsa en
# rafagas muy frecuentes y cortas (50-70 sesiones/dia, mediana de duracion 0 min) -- con
# una ventana ancha, la mayoria de las "confirmaciones" terminaban agarrando el pulso de
# OTRA parada de compactacion, no la que genero el evento (159 de 231 no caian dentro de
# ninguna sesion real). Se decidio mantener la ventana angosta para todas las marcas por
# ahora, aceptando que en Foton se pierden mas casos reales, hasta que se reemplace este
# cruce por una regla nueva basada en velocidad (el PTO debe desactivarse para moverse).


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
        pulsos_en_ventana = [p for p in pulsos if desde <= p <= hasta]
        if pulsos_en_ventana:
            # Pulso mas cercano al inicio del evento (activeFrom) -- es el dato que
            # importa para el mensaje: que tan cerca estuvo el PTO del arranque del RPM
            # alto, en vez de solo confirmar "hubo alguno dentro de la ventana".
            pulso_mas_cercano = min(pulsos_en_ventana, key=lambda p: abs((p - e['activeFrom']).total_seconds()))
            e['pto_pulso'] = pulso_mas_cercano
            e['pto_delta_seg'] = (pulso_mas_cercano - e['activeFrom']).total_seconds()
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

    # Mismo enriquecimiento de RPM que ya usa el resumen por hora (_resumen_eventos_revolucion_hora)
    # -- aca se agrega tambien a la alerta individual, que hasta ahora no lo traia.
    _agregar_rpm_pico(api, candidatos)

    claves_nuevas = []
    for c in candidatos:
        vehiculo = devices.get(c['id_veh'], {})
        nombre_veh = vehiculo.get('name', c['id_veh'])
        _, tipologia = resolver_ciudad_tipologia(vehiculo.get('groups'), mapa_grupos)
        marca = resolver_marca(vehiculo.get('groups'), mapa_grupos) or 'Sin marca'
        referencia_motor = next(
            (v for k, v in REFERENCIA_MOTOR_POR_MARCA.items() if k in marca.lower()), 'Desconocido'
        )
        hora_local = c['activeFrom'].tz_convert(ZONA_BOGOTA).strftime('%d/%m/%Y %H:%M:%S')
        rpm_texto = f"{c['rpm_pico']:.0f} RPM" if c.get('rpm_pico') is not None else "No disponible"

        delta_seg = c.get('pto_delta_seg')
        if delta_seg is None:
            texto_pto = f"PTO activo cerca (±{VENTANA_PTO_MINUTOS} min)."
        else:
            hora_pulso_local = c['pto_pulso'].tz_convert(ZONA_BOGOTA).strftime('%H:%M:%S')
            abs_delta = abs(delta_seg)
            if abs_delta < 60:
                n_seg = round(abs_delta)
                texto_delta = f"{n_seg} segundo" + ("" if n_seg == 1 else "s")
            else:
                minutos = abs_delta / 60
                texto_delta = f"{minutos:.1f} minuto" + ("" if abs(minutos - 1) < 0.05 else "s")
            if delta_seg < 0:
                direccion = f"{texto_delta} antes del inicio del evento"
            elif delta_seg > 0:
                direccion = f"{texto_delta} después del inicio del evento"
            else:
                direccion = "justo al inicio del evento"
            texto_pto = f"PTO detectado a las {hora_pulso_local} ({direccion})."

        texto = (
            f"🏎️ SOBRE-REVOLUCIÓN CON PTO ACTIVO\n"
            f"Vehículo: {nombre_veh}\n"
            f"Marca: {marca}\n"
            f"Tipología: {tipologia}\n"
            f"Motor: {referencia_motor}\n"
            f"Hora: {hora_local}\n"
            f"RPM registrado: {rpm_texto}\n"
            f"Duración: {c['duracion_seg']:.0f} segundos sostenidos\n"
            f"Vehículo detenido con RPM alto, {texto_pto}"
        )
        if enviar_telegram(texto):
            print(f"Notificado: {c['clave']} ({c['duracion_seg']:.0f}s, {rpm_texto})")
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


def api_get_con_reintentos(api, type_name, intentos=3, espera_seg=5):
    """Wrapper alrededor de api.get con reintentos ante errores transitorios
    de red (ej. 'Response ended prematurely' cuando el catalogo es grande y
    la conexion se corta a mitad de la respuesta -- confirmado con datos
    reales el 2026-09-01 en la consulta de 'Diagnostic', que trae miles de
    registros). No reintenta errores de logica -- solo problemas de red/conexion,
    para no ocultar bugs reales detras de reintentos silenciosos."""
    ultimo_error = None
    for intento in range(1, intentos + 1):
        try:
            return api.get(type_name)
        except (requests.exceptions.ChunkedEncodingError, requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            ultimo_error = e
            print(f"*** Error de red consultando {type_name} (intento {intento}/{intentos}): {e} ***")
            if intento < intentos:
                time.sleep(espera_seg)
    raise ultimo_error


def obtener_catalogos_diagnosticos(api):
    dic_diag = {}
    for d in api_get_con_reintentos(api, 'Diagnostic'):
        if isinstance(d, dict) and 'id' in d:
            dic_diag[d['id']] = {'nombre': d.get('name') or 'Diagnóstico sin nombre', 'codigo': d.get('code')}
    dic_fm = {}
    for fm in api_get_con_reintentos(api, 'FailureMode'):
        if isinstance(fm, dict) and 'id' in fm:
            dic_fm[fm['id']] = {'nombre': fm.get('name') or '', 'codigo': fm.get('code')}
    return dic_diag, dic_fm


LIMITE_PAGINA_FAULTDATA = 50000  # tope real que devuelve la API de Geotab por llamada a
# Get FaultData -- si el rango pedido tiene mas registros que esto (facil con
# VENTANA_FALLAS_DIAS=30 dias, TODA la flota y TODOS los diagnosticos), la respuesta se
# corta ahi, ordenada por dateTime ASCENDENTE. Sin paginar, eso significa quedarse
# siempre con los registros MAS VIEJOS del rango y perder en silencio todo lo reciente
# -- confirmado con datos reales: la llamada sin paginar traia 50000 filas pero
# terminaba el 07/08 aunque se pedian los ultimos 30 dias hasta hoy, asi que NINGUNA
# falla parecia "nueva" nunca (el reporte de turno/hora nunca encontraba nada dentro de
# su ventana) y las fallas "activas" quedaban ancladas a datos de hace mas de 2 semanas.


def _obtener_faultdata_paginado(api, f_inicio, f_fin):
    """Trae TODOS los FaultData en [f_inicio, f_fin), pidiendo pagina por pagina hasta
    que una vuelta devuelva menos de LIMITE_PAGINA_FAULTDATA. Cada vuelta arranca desde
    el dateTime del ultimo registro de la vuelta anterior (rango se solapa a proposito
    para no perder registros que compartan ese mismo instante); se dedupea por 'id' de
    FaultData al final, que es unico por registro."""
    todas = []
    desde = f_inicio
    while True:
        pagina = api.get('FaultData', search={
            'fromDate': desde.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
            'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        }) or []
        todas.extend(pagina)
        if len(pagina) < LIMITE_PAGINA_FAULTDATA:
            break
        ultimo_dt = max(r['dateTime'] for r in pagina)
        if ultimo_dt <= desde:
            break  # resguardo: si no avanza el cursor, cortar en vez de loopear infinito
        desde = ultimo_dt

    vistos = set()
    unicas = []
    for r in todas:
        if r['id'] not in vistos:
            vistos.add(r['id'])
            unicas.append(r)
    return unicas


def _obtener_fallas_activas(api):
    """Todas las fallas activas ahora mismo (cualquier criticidad), una fila por
    vehiculo+diagnostico+modo de falla (la mas reciente). Base comun para las alertas
    individuales, el resumen por hora y el reporte PDF -- todos usan cualquier
    criticidad (ALTA/MEDIA/BAJA), para que coincida con lo que se ve directo en
    Geotab en vez de solo una parte."""
    devices = {d['id']: d for d in api.get('Device')}
    dic_diag, dic_fm = obtener_catalogos_diagnosticos(api)
    mapa_grupos = obtener_mapa_grupos(api)

    f_fin = datetime.now(timezone.utc)
    f_inicio = f_fin - timedelta(days=VENTANA_FALLAS_DIAS)
    fallas = _obtener_faultdata_paginado(api, f_inicio, f_fin)

    if not fallas:
        return pd.DataFrame(), devices, dic_diag, dic_fm, mapa_grupos

    df = pd.DataFrame(fallas)
    df['id_camion'] = df['device'].apply(lambda x: x['id'] if isinstance(x, dict) else x)
    df['diag_id'] = df['diagnostic'].apply(lambda x: x['id'] if isinstance(x, dict) else None)
    df['fm_id'] = df['failureMode'].apply(lambda x: x['id'] if isinstance(x, dict) else None)
    df['criticidad'] = df.apply(clasificar_criticidad_geotab, axis=1)
    df['dateTime'] = pd.to_datetime(df['dateTime'])

    # Primero el registro MAS RECIENTE por vehiculo+diagnostico+modo de falla (sin
    # importar su faultState), y RECIEN AHI se filtra por 'Active'. Si se filtrara por
    # 'Active' antes de dedupear (como estaba antes), un codigo que ya se resolvio --su
    # ultimo registro real es faultState=None/Inactive-- podia seguir viendose "activo"
    # mientras existiera, dentro de VENTANA_FALLAS_DIAS, CUALQUIER registro viejo en
    # 'Active': muchos diagnosticos aca pulsan Active -> None en segundos y vuelven a
    # aparecer dias despues, asi que ese orden mostraba fallas "activas hace semanas"
    # que en Geotab ya estaban resueltas (confirmado con datos reales del vehiculo 1151).
    df = df.sort_values('dateTime').drop_duplicates(
        subset=['id_camion', 'diag_id', 'fm_id'], keep='last'
    )
    activas = df[df['faultState'] == 'Active']

    if CIUDAD_FILTRO and not activas.empty:
        def _ciudad_del_vehiculo(id_camion):
            ciudad, _ = resolver_ciudad_tipologia(devices.get(id_camion, {}).get('groups'), mapa_grupos)
            return ciudad
        activas = activas[activas['id_camion'].apply(_ciudad_del_vehiculo) == CIUDAD_FILTRO]

    return activas, devices, dic_diag, dic_fm, mapa_grupos


def _texto_falla(row, devices, dic_diag, dic_fm, mapa_grupos):
    """Arma los campos de texto de una fila de falla (cualquier criticidad) --
    reutilizado por la alerta individual y por el resumen consolidado por hora."""
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


EMOJI_POR_CRITICIDAD = {'ALTA': '🚨', 'MEDIA': '⚠️', 'BAJA': 'ℹ️'}


def revisar_fallas_activas(api, claves_activas_previas):
    """Alerta individual por cada falla nueva, de CUALQUIER criticidad (antes solo
    ALTA) -- para que lo que llega a Telegram coincida con lo que se ve en Geotab en
    vez de ser solo un subconjunto."""
    activas, devices, dic_diag, dic_fm, mapa_grupos = _obtener_fallas_activas(api)
    if activas.empty:
        return set(), []

    claves_actuales = set()
    filas_nuevas = []
    for _, row in activas.iterrows():
        clave = f"{row['id_camion']}|{row['diag_id']}|{row['fm_id']}"
        claves_actuales.add(clave)
        if clave in claves_activas_previas:
            continue
        filas_nuevas.append(row)

    for row in filas_nuevas:
        nombre_veh, ciudad, tipologia, spn, fmi, descripcion, hora_local, url_busqueda = _texto_falla(
            row, devices, dic_diag, dic_fm, mapa_grupos
        )
        emoji = EMOJI_POR_CRITICIDAD.get(row['criticidad'], '🔧')
        texto = (
            f"{emoji} FALLA ACTIVA ({row['criticidad']})\n"
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
            print(f"Notificado (falla {row['criticidad']}): {clave}")

    if not filas_nuevas:
        print("Sin fallas nuevas que notificar.")
    else:
        print(f"Total fallas notificadas en esta corrida: {len(filas_nuevas)}")

    return claves_actuales, filas_nuevas


# ---------------------------------------------------------------------------
# Ralenti excesivo (motor encendido, detenido, sin PTO) -- clasificacion de
# criticidad por duracion. Usa la regla 'Ralentí Excesivo Sin PTO' de Geotab
# via _obtener_eventos_regla, igual que sobre-revolucion. TODAVIA NO esta
# conectada a ninguna alerta/resumen -- se deja lista aca a proposito.
#
# El umbral de la regla se probo primero en 1 min (2026-08-26) para validar
# los 3 niveles de criticidad con datos reales, pero eso genero demasiado
# ruido: en 25.5h dieron 1789 eventos en Bogota (Intl/Mercedes/Foton), 94% de
# ellos "Baja" (1-10min) -- paradas normales del ciclo de recoleccion, no
# ralenti excesivo real. Se subio a 10 min el mismo dia, que coincide con el
# limite inferior de "Media", asi que de aca en mas la regla practicamente
# nunca va a devolver "Baja" (solo eventos ya cerca de 10 min justos).
# ---------------------------------------------------------------------------

NOMBRE_REGLA_RALENTI = 'Ralentí Excesivo Sin PTO'


def clasificar_criticidad_ralenti(duracion_min):
    """Baja: 1-10 min, Media: 11-20 min, Alta: mas de 20 min (criterio acordado
    con el usuario, mismos rangos para International/Mercedes/Foton). En la
    practica "Baja" casi no va a aparecer -- ver nota arriba sobre el umbral
    de la regla en Geotab (10 min)."""
    if duracion_min > 20:
        return 'ALTA'
    elif duracion_min > 10:
        return 'MEDIA'
    else:
        return 'BAJA'


# ---------------------------------------------------------------------------
# Regeneracion DPF -- deteccion de compactadores que se quedan con la lampara
# de "regeneracion requerida" encendida sin resolverse (ni automatica ni
# manualmente). TODAVIA NO esta conectada a ninguna alerta -- se deja lista
# aca a proposito, igual que ralenti.
#
# Alcance: compactadores dobles de Bogota, marca International o Foton -- son
# los UNICOS compactadores de Bogota con esta telemetria disponible en Geotab
# (validado con datos reales el 2026-08-26/27). El resto de compactadores de
# Bogota -- el Mercedes 1164-NWY952 (doble) y los Volkswagen 1307-LSX407 /
# 1308-LSX408 (sencillos, los unicos 2 de toda la flota) -- no reportan
# NINGUNA variable de DPF en Geotab, asi que quedan fuera hasta que se revise
# la configuracion de su dispositivo con el area tecnica (no es un tema de
# umbral, es que no hay dato que leer).
#
# Como se define "resuelto": el testigo (2109) se prende, y se busca despues
# el primer 'regeneracion activa confirmada' (2740==1 -- OJO que 2740 tiene un
# tercer valor, 2=inhibida, que NO es lo mismo y no cuenta) o el interruptor
# de fuerza (2992==1).
#
# UMBRAL_SIN_REGENERAR_MINUTOS = 20, a pedido explicito del usuario -- no es
# un umbral de "cuanto tardaria en resolverse solo" (eso, validado con datos
# reales de 90 dias fleet-wide, tiene mediana 2.7h, muy por encima de 20 min).
# La idea NO es medir si el sistema automatico lo hubiera resuelto solo, sino
# avisar lo antes posible para que el conductor pare y regenere manualmente
# -- el objetivo es prevenir que se acumule demasiado holl�n en el filtro y
# se dane el sistema, no esperar a confirmar que quedo "sin resolver". Con
# este umbral tan bajo, la alerta va a dispararse practicamente cada vez que
# se prenda el testigo (el interruptor manual casi no se usa hoy en dia --
# encontrado un unico caso real en toda la flota en 90 dias).
# ---------------------------------------------------------------------------

ID_LAMPARA_DPF = 'DiagnosticDieselParticulateFilterLampId'
ID_INTERRUPTOR_DPF = 'aXfHYX0HFtUaOOr_scNuSsg'
ID_REGEN_ACTIVA_DPF = 'a2MenjAEB90iHUfy6X1oc2A'
UMBRAL_SIN_REGENERAR_MINUTOS = 20


def vehiculos_compactadores_bogota_con_dpf(devices, mapa_grupos):
    """Devuelve los id de los compactadores dobles de Bogota (International o
    Foton) -- ver nota de alcance arriba. 'devices' es {id: vehiculo}."""
    resultado = []
    for id_veh, vehiculo in devices.items():
        grupos = vehiculo.get('groups')
        ciudad, tipologia = resolver_ciudad_tipologia(grupos, mapa_grupos)
        if ciudad != 'Bogotá' or tipologia != 'COMPACTADORES DOBLES':
            continue
        marca = (resolver_marca(grupos, mapa_grupos) or '').lower()
        if marca.startswith('international') or marca.startswith('foton'):
            resultado.append(id_veh)
    return resultado


def _episodios_de_encendido(puntos, gap_max_horas=1):
    """Agrupa lecturas consecutivas en valor exacto 1 (no >=1, para no
    confundir con el 2=inhibida de 2740) separadas por menos de gap_max_horas
    en un solo episodio; devuelve el momento de inicio de cada uno."""
    episodios = []
    en_episodio = False
    ultimo_on = None
    for t, v in puntos:
        if v == 1:
            if not en_episodio:
                episodios.append(t)
                en_episodio = True
            elif ultimo_on and (t - ultimo_on).total_seconds() > gap_max_horas * 3600:
                episodios.append(t)
            ultimo_on = t
        else:
            en_episodio = False
    return episodios


def _traer_serie_statusdata(api, diagnostic_id, vehiculos_ids, f_inicio, f_fin):
    """Trae StatusData de un diagnostico para varios vehiculos (multi_call en
    lotes de 5, igual que el resto del script) y devuelve {id_veh: [(dateTime, valor), ...]}
    ordenado por fecha."""
    llamadas = [
        ('Get', {
            'typeName': 'StatusData',
            'search': {
                'diagnosticSearch': {'id': diagnostic_id},
                'deviceSearch': {'id': id_veh},
                'fromDate': f_inicio.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
            }
        })
        for id_veh in vehiculos_ids
    ]
    resultados = []
    for i in range(0, len(llamadas), 5):
        resultados.extend(api.multi_call(llamadas[i:i + 5]))
    series = {}
    for id_veh, lecturas in zip(vehiculos_ids, resultados):
        puntos = []
        for l in (lecturas or []):
            try:
                puntos.append((pd.to_datetime(l['dateTime']), float(l['data'])))
            except (TypeError, ValueError, KeyError):
                continue
        puntos.sort()
        series[id_veh] = puntos
    return series


def detectar_regeneracion_pendiente(api, devices, mapa_grupos, f_inicio, f_fin):
    """Para cada compactador de Bogota con telemetria de DPF disponible (ver
    vehiculos_compactadores_bogota_con_dpf), busca episodios de lampara
    encendida en [f_inicio, f_fin) y verifica si se resolvieron a tiempo.
    Devuelve una lista de dicts (uno por episodio SIN resolver dentro de
    UMBRAL_SIN_REGENERAR_MINUTOS) con id_veh, lampara_desde y
    minutos_transcurridos -- candidatos a alertar. No manda nada a Telegram,
    solo detecta."""
    vehiculos_ids = vehiculos_compactadores_bogota_con_dpf(devices, mapa_grupos)
    if not vehiculos_ids:
        return []

    serie_lampara = _traer_serie_statusdata(api, ID_LAMPARA_DPF, vehiculos_ids, f_inicio, f_fin)
    serie_interruptor = _traer_serie_statusdata(api, ID_INTERRUPTOR_DPF, vehiculos_ids, f_inicio, f_fin)
    serie_regen = _traer_serie_statusdata(api, ID_REGEN_ACTIVA_DPF, vehiculos_ids, f_inicio, f_fin)

    ahora = datetime.now(timezone.utc)
    pendientes = []
    for id_veh in vehiculos_ids:
        episodios = _episodios_de_encendido(serie_lampara.get(id_veh, []))
        regen_confirmada = [t for t, v in serie_regen.get(id_veh, []) if v == 1]
        interruptor_activado = [t for t, v in serie_interruptor.get(id_veh, []) if v == 1]

        for t_lampara in episodios:
            resuelto = any(t >= t_lampara for t in regen_confirmada) or any(t >= t_lampara for t in interruptor_activado)
            if resuelto:
                continue
            minutos_transcurridos = (ahora - t_lampara).total_seconds() / 60
            if minutos_transcurridos >= UMBRAL_SIN_REGENERAR_MINUTOS:
                pendientes.append({
                    'id_veh': id_veh, 'movil': devices.get(id_veh, {}).get('name', id_veh),
                    'lampara_desde': t_lampara, 'minutos_transcurridos': minutos_transcurridos,
                })

    return pendientes


def revisar_regeneracion_pendiente(api, claves_ya_notificadas):
    """Revisa compactadores de Bogota con testigo DPF pendiente (ver
    detectar_regeneracion_pendiente) y notifica los que todavia no se habian
    avisado. La clave incluye el inicio del episodio, asi que un mismo
    episodio se notifica UNA sola vez aunque el testigo siga encendido en las
    siguientes corridas del cron (misma logica anti-duplicados que fallas y
    sobre-revolucion)."""
    devices = {d['id']: d for d in api.get('Device')}
    mapa_grupos = obtener_mapa_grupos(api)
    f_fin = datetime.now(timezone.utc)
    f_inicio = f_fin - timedelta(hours=VENTANA_REVISION_HORAS)
    pendientes = detectar_regeneracion_pendiente(api, devices, mapa_grupos, f_inicio, f_fin)

    claves_nuevas = []
    for p in pendientes:
        clave = f"{p['id_veh']}|{p['lampara_desde'].isoformat()}"
        if clave in claves_ya_notificadas:
            continue
        hora_local = p['lampara_desde'].astimezone(ZONA_BOGOTA).strftime('%d/%m/%Y %H:%M:%S')
        texto = (
            f"🛑 REGENERACIÓN DPF PENDIENTE\n"
            f"Vehículo: {p['movil']}\n"
            f"Testigo encendido desde: {hora_local}\n"
            f"Lleva {p['minutos_transcurridos']:.0f} minutos sin regenerar (ni automática ni manual).\n"
            f"El conductor debe DETENERSE y realizar la regeneración manual."
        )
        if enviar_telegram(texto):
            print(f"Notificado (DPF pendiente): {clave}")
            claves_nuevas.append(clave)

    if not claves_nuevas:
        print("Sin regeneraciones DPF pendientes nuevas que notificar.")
    else:
        print(f"Total regeneraciones DPF pendientes notificadas en esta corrida: {len(claves_nuevas)}")

    return claves_nuevas


# ---------------------------------------------------------------------------
# Excesos de velocidad -- limite operativo propio de la flota de recoleccion
# (Compactador/Ampliroll, 60 km/h), no el limite legal de cada via. Se
# valido con datos reales de 14 dias contra las otras 11 reglas de velocidad
# que existen en Geotab (varias son ruido: una regla de prueba a 10km/h que
# quedo activa sin querer, umbrales fijos que no distinguen tipo de via,
# etc.) -- el usuario eligio esta explicitamente (2026-08-27) por ser el
# limite propio de su tipo de vehiculo, con volumen de eventos manejable.
# ---------------------------------------------------------------------------

NOMBRE_REGLA_VELOCIDAD = 'R_LÍMITE DE VELOCIDAD DE 60 KM/H COMPACTADOR Y AMPLIROLL'
UMBRAL_VELOCIDAD_KMH = 60
DURACION_MINIMA_VELOCIDAD_SEG = 10  # la regla en Geotab ya exige sostenido 10s+; se repite
# aca como piso propio por si la condicion en Geotab cambia mas adelante.

ID_DIAGNOSTICO_VELOCIDAD_PICO = 'DiagnosticEngineRoadSpeedId'  # mismo diagnostico que usa la condicion de la regla
VENTANA_VELOCIDAD_PICO_SEGUNDOS = 15  # margen alrededor del evento, igual criterio que _agregar_rpm_pico


def _agregar_velocidad_pico(api, eventos_candidatos, ventana_segundos=VENTANA_VELOCIDAD_PICO_SEGUNDOS):
    """Agrega 'velocidad_pico' (float en km/h, o None) a cada evento (dict con
    id_veh, activeFrom, activeTo), consultando StatusData del diagnostico de
    velocidad de rodaje en +/-ventana_segundos -- mismo patron que
    _agregar_rpm_pico (el ExceptionEvent marca cuando la condicion se sostuvo,
    pero el pico real puede caer un poco antes/despues del activeFrom/activeTo)."""
    if not eventos_candidatos:
        return eventos_candidatos

    vehiculos = list({e['id_veh'] for e in eventos_candidatos})
    desde_global = min(e['activeFrom'] for e in eventos_candidatos) - timedelta(seconds=ventana_segundos)
    hasta_global = max(e['activeTo'] for e in eventos_candidatos) + timedelta(seconds=ventana_segundos)

    llamadas = [
        ('Get', {
            'typeName': 'StatusData',
            'search': {
                'diagnosticSearch': {'id': ID_DIAGNOSTICO_VELOCIDAD_PICO},
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
        print(f"*** No se pudo consultar velocidad pico para el reporte de excesos: {e} ***")
        for ev in eventos_candidatos:
            ev['velocidad_pico'] = None
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
        e['velocidad_pico'] = max(valores) if valores else None

    return eventos_candidatos


# ---------------------------------------------------------------------------
# Reporte PDF de fallas activas, bajo demanda (comando /reporte en Telegram)
# ---------------------------------------------------------------------------

ORDEN_CRITICIDAD = {'ALTA': 3, 'MEDIA': 2, 'BAJA': 1}
COLOR_POR_CRITICIDAD = {
    'ALTA': colors.HexColor('#EF4444'), 'MEDIA': colors.HexColor('#F59E0B'), 'BAJA': colors.HexColor('#9CA3AF'),
}
COLOR_DESTACADO = colors.HexColor('#C00000')

# Paleta del diseño tipo "tarjeta" del PDF (a pedido del usuario, mockup 2026-08-27):
# fondo gris claro de pagina, encabezado azul oscuro, aviso de filtro en verde, tarjeta
# de resumen con borde azul, y encabezado liviano gris-azulado por vehiculo.
COLOR_FONDO_PDF = colors.HexColor('#F5F7FA')
COLOR_HEADER_PDF = colors.HexColor('#0F1B3D')
COLOR_FILTRO_FONDO_PDF = colors.HexColor('#E8F5E9')
COLOR_FILTRO_BORDE_PDF = colors.HexColor('#2E7D32')
COLOR_RESUMEN_BORDE_PDF = colors.HexColor('#2563EB')
COLOR_VEHICULO_HEADER_PDF = colors.HexColor('#DCE3EC')
COLOR_TEXTO_OSCURO_PDF = colors.HexColor('#1F2937')
COLOR_TEXTO_GRIS_PDF = colors.HexColor('#6B7280')

# Categorias que no le sirven al supervisor de patio (conectividad/telemetria del
# dispositivo, no del vehiculo) -- se ocultan del PDF a pedido del usuario. 'General'
# tambien se oculta porque en la practica son diagnosticos que Geotab no nombra
# ("Unknown Diagnostic") y no se puede saber a que sistema pertenecen.
CATEGORIAS_OCULTAS_PDF = {'Telemática/GPS', 'General'}

# Categoriza por sistema del vehiculo buscando palabras clave en el NOMBRE que ya da
# Geotab para el diagnostico -- Geotab no trae un campo nativo de sistema/categoria
# (se reviso: parameterGroup y controller vienen vacios siempre), asi que esta es la
# unica forma de categorizar sin reintroducir un diccionario propio de 1000+ codigos.
# Se evalua en orden -- la primera categoria que coincida gana, por eso las mas
# especificas (ABS, Neumaticos) van antes que las generales (Motor, Electrico).
CATEGORIAS_SISTEMA = [
    ('ABS', ['abs', 'sensor de rueda', 'válvula moduladora de presión', 'antibloqueo', 'velocidad de desvío']),
    ('Neumáticos', ['neumático', 'neumatico', 'llanta']),
    ('Frenos', ['freno', 'retardador']),
    ('Postratamiento/Escape', [
        'postratamiento', 'escape', 'scr', 'egr', 'recirculación de gases', 'recirculacion de gases',
        'partículas diésel', 'particulas diesel', 'nox', 'catalizador', 'liquido de escape', 'líquido de escape',
    ]),
    ('Motor', [
        'motor', 'aceite', 'refrigerante', 'cigüeñal', 'ciguenal', 'árbol de levas', 'arbol de levas',
        'inyector', 'cilindro', 'turbocompresor', 'combustible', 'admisión', 'admision', 'ralentí', 'ralenti',
        'acelerador',
    ]),
    ('Transmisión', [
        'transmisión', 'transmision', 'embrague', 'cambio de marcha', 'palanca de cambios', 'engranaje', 'divisor',
    ]),
    ('Eje/Suspensión', ['eje', 'diferencial', 'suspensión', 'suspension', 'inclinación', 'inclinacion']),
    ('Eléctrico', [
        'eléctrico', 'electrico', 'luz', 'lámpara', 'lampara', 'batería', 'bateria', 'voltaje', 'interruptor',
        'fusible', 'bocina', 'alarma', 'panel de instrumentos', 'ventana', 'seguro', 'espejo',
    ]),
    ('HVAC', ['hvac', 'aire acondicionado', 'climatiz', 'calefac']),
    ('Dirección', ['dirección', 'direccion', 'volante']),
    ('Telemática/GPS', ['telemático', 'telematico', 'gps', 'antena']),
]


# Fallas del DISPOSITIVO Geotab (desconexion, bateria del dispositivo, comunicacion
# de red/CAN BUS) suelen mencionar "motor", "bateria" o "voltaje" de pasada en su
# descripcion (ej. "Fallo del dispositivo telematico: fuente de alimentacion de bajo
# voltaje"), lo que las hacia caer en Motor/Electrico en vez de Telematica/GPS -- y
# como esa categoria se oculta del PDF, se colaban visibles cuando no deberian. Se
# revisa esto ANTES que el resto de las categorias, sea cual sea el resto del texto.
_PATRON_FALLA_DISPOSITIVO = re.compile(r'\bfall[oa] (?:de|del) dispositivo\b', re.IGNORECASE)


def _categorizar_falla(nombre_diagnostico):
    """Sistema del vehiculo al que pertenece la falla, segun palabras clave en el
    nombre que ya da Geotab. 'General' si no coincide con ninguna categoria conocida.
    Coincide por palabra completa (limite de palabra), no por substring suelto -- si
    no, por ejemplo la palabra clave 'abs' (para ABS) coincidia dentro de 'presión
    ABSOLUTA', categorizando mal una falla real de postratamiento como si fuera ABS
    (encontrado por el usuario con datos reales, vehiculo 1308-LSX408)."""
    nombre_l = (nombre_diagnostico or '').lower()
    if _PATRON_FALLA_DISPOSITIVO.search(nombre_l):
        return 'Telemática/GPS'
    for categoria, palabras in CATEGORIAS_SISTEMA:
        if any(re.search(r'\b' + re.escape(p) + r'\b', nombre_l) for p in palabras):
            return categoria
    return 'General'


def _fondo_pagina_reporte(canvas, doc):
    """Pinta el fondo gris claro de cada pagina -- reportlab no tiene color de pagina
    nativo, hay que pintarlo a mano antes de que se dibuje el contenido."""
    canvas.saveState()
    canvas.setFillColor(COLOR_FONDO_PDF)
    canvas.rect(0, 0, doc.pagesize[0], doc.pagesize[1], fill=1, stroke=0)
    canvas.restoreState()


def _pill_criticidad(criticidad, estilo_pill):
    """Devuelve el 'badge' redondeado de criticidad (tabla de una celda) que se usa
    como primera columna de cada fila de falla."""
    pill = Table([[Paragraph(criticidad, estilo_pill)]], colWidths=[1.8 * cm], rowHeights=[0.55 * cm])
    pill.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), COLOR_POR_CRITICIDAD.get(criticidad, colors.grey)),
        ('ROUNDEDCORNERS', [8, 8, 8, 8]),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
    ]))
    return pill


def generar_pdf_reporte_fallas(api, ruta_salida, desde_local=None, hasta_local=None):
    """Genera un PDF con fallas activas (cualquier criticidad), una tarjeta por
    vehiculo con sus fallas ordenadas por criticidad -- diseño acordado con el
    usuario (mockup 2026-08-27): tarjetas redondeadas, badges de color por
    criticidad, y un resumen arriba con los totales y los sistemas mas afectados.
    Usa directo el nombre/codigo/criticidad que da Geotab (sin el diccionario manual
    de 1000+ codigos), para no mantener esa misma informacion duplicada en dos
    lugares distintos.

    Se ocultan las fallas de CATEGORIAS_OCULTAS_PDF (telemetria/conectividad y
    diagnosticos sin nombre reconocible) -- no le sirven al supervisor de patio, y
    un vehiculo cuyas UNICAS fallas sean de esas categorias no aparece en el PDF.

    Sin desde_local/hasta_local: TODAS las fallas activas ahora mismo (usado por
    /reporte y por el reporte de fin de turno). Con ambos: solo las que aparecieron
    dentro de ese rango (usado por el resumen por hora, que solo quiere lo nuevo)."""
    activas, devices, dic_diag, dic_fm, mapa_grupos = _obtener_fallas_activas(api)
    if desde_local is not None and hasta_local is not None and not activas.empty:
        desde_utc = desde_local.astimezone(timezone.utc)
        hasta_utc = hasta_local.astimezone(timezone.utc)
        activas = activas[(activas['dateTime'] >= desde_utc) & (activas['dateTime'] < hasta_utc)]

    estilos = getSampleStyleSheet()
    estilo_celda = ParagraphStyle('celda', parent=estilos['Normal'], fontSize=8.5, leading=12, textColor=COLOR_TEXTO_OSCURO_PDF)
    estilo_sistema = ParagraphStyle('sistema', parent=estilo_celda, fontName='Helvetica-Bold')
    estilo_fecha = ParagraphStyle('fecha', parent=estilo_celda, textColor=COLOR_TEXTO_GRIS_PDF, alignment=2)
    estilo_codigo = ParagraphStyle('codigo', parent=estilo_celda, fontName='Courier-Bold', textColor=colors.HexColor('#0284C7'), fontSize=8)
    estilo_pill = ParagraphStyle('pill', parent=estilos['Normal'], fontName='Helvetica-Bold', fontSize=8, textColor=colors.white, alignment=1)
    estilo_titulo = ParagraphStyle('titulo', parent=estilos['Title'], textColor=colors.white, alignment=1)
    estilo_subtitulo = ParagraphStyle('subtitulo', parent=estilos['Normal'], textColor=colors.HexColor('#C7D2E0'), alignment=1)
    estilo_filtro = ParagraphStyle('filtro', parent=estilos['Normal'], textColor=COLOR_FILTRO_BORDE_PDF, fontSize=9, leading=13)
    estilo_movil = ParagraphStyle('movil', parent=estilos['Heading4'], textColor=COLOR_TEXTO_OSCURO_PDF, spaceAfter=0, spaceBefore=0)
    estilo_movil_detalle = ParagraphStyle('movil_detalle', parent=estilos['Normal'], textColor=COLOR_TEXTO_GRIS_PDF, fontSize=9, alignment=2)
    estilo_resumen_titulo = ParagraphStyle('resumen_titulo', parent=estilos['Heading3'], textColor=COLOR_TEXTO_OSCURO_PDF, spaceAfter=6)
    estilo_resumen_texto = ParagraphStyle('resumen_texto', parent=estilos['Normal'], textColor=COLOR_TEXTO_OSCURO_PDF, fontSize=9, leading=13)

    if desde_local is not None and hasta_local is not None:
        subtitulo = (
            f"Fallas nuevas entre {desde_local.strftime('%H:%M')} y {hasta_local.strftime('%H:%M')} del "
            f"{desde_local.strftime('%d/%m/%Y')}"
        )
    else:
        subtitulo = f"Estado de Flota Geotab | {CIUDAD_FILTRO or 'Toda la flota'} | Generado: {datetime.now(ZONA_BOGOTA).strftime('%d/%m/%Y %H:%M')}"

    encabezado = Table(
        [[Paragraph("Reporte de Fallas Activas", estilo_titulo)], [Paragraph(subtitulo, estilo_subtitulo)]],
        colWidths=[25 * cm]
    )
    encabezado.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), COLOR_HEADER_PDF),
        ('ROUNDEDCORNERS', [10, 10, 10, 10]),
        ('TOPPADDING', (0, 0), (0, 0), 14), ('BOTTOMPADDING', (0, 0), (0, 0), 2),
        ('TOPPADDING', (0, 1), (0, 1), 2), ('BOTTOMPADDING', (0, 1), (0, 1), 14),
    ]))
    elementos = [encabezado, Spacer(1, 0.4 * cm)]
    filas_reporte = []

    if activas.empty:
        elementos.append(Paragraph("No hay fallas activas en este momento.", estilos['Normal']))
    else:
        por_vehiculo = {}
        for _, fila in activas.iterrows():
            por_vehiculo.setdefault(fila['id_camion'], []).append(fila)

        filas_reporte = []
        total_ocultas = 0
        for id_camion, filas in por_vehiculo.items():
            vehiculo = devices.get(id_camion, {})
            marca = resolver_marca(vehiculo.get('groups'), mapa_grupos) or 'Sin marca'
            marca_l = marca.lower()
            referencia_motor = next(
                (v for k, v in REFERENCIA_MOTOR_POR_MARCA.items() if k in marca_l), 'Desconocido'
            )
            vin = vehiculo.get('engineVehicleIdentificationNumber') or ''
            n_motor = vin[-6:] if vin else 'Sin registrar'

            items = []
            for fila in filas:
                diag_info = dic_diag.get(fila['diag_id'], {'nombre': 'Diagnóstico desconocido', 'codigo': None})
                fm_info = dic_fm.get(fila['fm_id'], {'nombre': '', 'codigo': None})
                categoria = _categorizar_falla(diag_info['nombre'])
                if categoria in CATEGORIAS_OCULTAS_PDF:
                    total_ocultas += 1
                    continue
                nombre = diag_info['nombre']
                if fm_info['nombre']:
                    nombre += f" — {fm_info['nombre']}"
                items.append({
                    'nombre': nombre,
                    'spn': diag_info.get('codigo') or '?',
                    'fmi': fm_info.get('codigo') or '?',
                    'criticidad': fila['criticidad'],
                    'hora': fila['dateTime'].tz_convert(ZONA_BOGOTA).strftime('%d/%m/%Y'),
                    'categoria': categoria,
                    'destacado': categoria in ('ABS', 'Neumáticos', 'Postratamiento/Escape', 'Motor'),
                })

            if not items:
                continue  # este vehiculo solo tenia fallas de categorias ocultas

            items.sort(key=lambda it: (-ORDEN_CRITICIDAD.get(it['criticidad'], 0), it['hora']))
            criticidad_max = items[0]['criticidad']
            filas_reporte.append({
                'criticidad': criticidad_max,
                'movil': vehiculo.get('name', id_camion), 'marca': marca,
                'referencia_motor': referencia_motor, 'n_motor': n_motor, 'items': items,
            })

        if not filas_reporte:
            elementos.append(Paragraph(
                "No hay fallas activas relevantes en este momento "
                f"(se ocultaron {total_ocultas} de conectividad/diagnóstico desconocido).", estilos['Normal']
            ))
        else:
            if total_ocultas:
                aviso_filtro = Table(
                    [[Paragraph(
                        f"<b>Filtro aplicado:</b> se ocultaron {total_ocultas} falla(s) de conectividad "
                        f"telemática y diagnósticos sin nombre reconocible -- no aportan al mantenimiento del vehículo.",
                        estilo_filtro
                    )]],
                    colWidths=[25 * cm]
                )
                aviso_filtro.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (-1, -1), COLOR_FILTRO_FONDO_PDF),
                    ('ROUNDEDCORNERS', [6, 6, 6, 6]),
                    ('BOX', (0, 0), (-1, -1), 1, COLOR_FILTRO_BORDE_PDF),
                    ('LEFTPADDING', (0, 0), (-1, -1), 10), ('RIGHTPADDING', (0, 0), (-1, -1), 10),
                    ('TOPPADDING', (0, 0), (-1, -1), 8), ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
                ]))
                elementos.append(aviso_filtro)
                elementos.append(Spacer(1, 0.35 * cm))

            # --- Resumen de novedades ---
            vehiculos_alta = [f for f in filas_reporte if f['criticidad'] == 'ALTA']
            vehiculos_media_baja = [f for f in filas_reporte if f['criticidad'] != 'ALTA']
            conteo_sistemas = Counter(it['categoria'] for f in filas_reporte for it in f['items'])
            top_sistemas = [c for c, _ in conteo_sistemas.most_common(3)]
            texto_sistemas = "<br/>".join(f"{i}. {s}" for i, s in enumerate(top_sistemas, 1)) or "—"

            fila_resumen = [[
                Paragraph(
                    f"<b>Vehículos en Alerta Crítica (ALTA):</b><br/>{len(vehiculos_alta)} unidad(es) "
                    f"(Prioridad de ingreso a taller)", estilo_resumen_texto
                ),
                Paragraph(
                    f"<b>Vehículos con fallas (MEDIA/BAJA):</b><br/>{len(vehiculos_media_baja)} unidad(es) "
                    f"(Monitoreo preventivo)", estilo_resumen_texto
                ),
                Paragraph(f"<b>Sistemas más afectados:</b><br/>{texto_sistemas}", estilo_resumen_texto),
            ]]
            # Se arma en dos tablas -- titulo a lo ancho, y una fila de 3 columnas debajo --
            # porque Table exige que todas las filas tengan la misma cantidad de columnas.
            tabla_resumen_titulo = Table([[Paragraph("Resumen de Novedades", estilo_resumen_titulo)]], colWidths=[25 * cm])
            tabla_resumen_titulo.setStyle(TableStyle([
                ('LEFTPADDING', (0, 0), (-1, -1), 14), ('TOPPADDING', (0, 0), (-1, -1), 12), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
            ]))
            tabla_resumen_cuerpo = Table([fila_resumen[0]], colWidths=[8.3 * cm, 8.3 * cm, 8.4 * cm])
            tabla_resumen_cuerpo.setStyle(TableStyle([
                ('LEFTPADDING', (0, 0), (0, 0), 14), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
                ('BOTTOMPADDING', (0, 0), (-1, -1), 14),
            ]))
            resumen_envoltorio = Table([[tabla_resumen_titulo], [tabla_resumen_cuerpo]], colWidths=[25 * cm])
            resumen_envoltorio.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), colors.white),
                ('ROUNDEDCORNERS', [8, 8, 8, 8]),
                ('LINEBEFORE', (0, 0), (0, -1), 3, COLOR_RESUMEN_BORDE_PDF),
                ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
                ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
            ]))
            elementos.append(resumen_envoltorio)
            elementos.append(Spacer(1, 0.4 * cm))

            # --- Una tarjeta por vehiculo, ordenadas por criticidad (ALTA primero) ---
            filas_reporte.sort(key=lambda f: (-ORDEN_CRITICIDAD.get(f['criticidad'], 0), f['movil']))
            for f in filas_reporte:
                encabezado_veh = Table(
                    [[
                        Paragraph(f"Placa: {f['movil']}", estilo_movil),
                        Paragraph(f"{f['marca']} | Motor: {f['referencia_motor']} ({f['n_motor']})", estilo_movil_detalle),
                    ]],
                    colWidths=[14 * cm, 11 * cm]
                )
                encabezado_veh.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (-1, -1), COLOR_VEHICULO_HEADER_PDF),
                    ('ROUNDEDCORNERS', [8, 8, 8, 8]),
                    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                    ('LEFTPADDING', (0, 0), (0, 0), 12), ('RIGHTPADDING', (1, 0), (1, 0), 12),
                    ('TOPPADDING', (0, 0), (-1, -1), 8), ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
                ]))
                elementos.append(encabezado_veh)
                elementos.append(Spacer(1, 0.15 * cm))

                # Una fila por FALLA (no una celda gigante con todas las fallas del
                # vehiculo adentro) -- con muchas fallas en un solo vehiculo, esa celda
                # puede terminar mas alta que una pagina entera, y reportlab no puede
                # partir el contenido de una sola celda entre paginas (LayoutError).
                datos_tabla = [['Nivel', 'Código', 'Sistema', 'Descripción del diagnóstico', 'Fecha reporte']]
                for it in f['items']:
                    nombre = it['nombre'].upper() if it['destacado'] else it['nombre']
                    texto_desc = escapar_xml(nombre)
                    if it['destacado']:
                        texto_desc = f"<font color='#C00000'><b>{texto_desc}</b></font>"
                    datos_tabla.append([
                        _pill_criticidad(it['criticidad'], estilo_pill),
                        Paragraph(f"SPN {it['spn']}/FMI {it['fmi']}", estilo_codigo),
                        Paragraph(it['categoria'], estilo_sistema),
                        Paragraph(texto_desc, estilo_celda),
                        Paragraph(it['hora'], estilo_fecha),
                    ])

                tabla = Table(datos_tabla, colWidths=[2.4 * cm, 3.4 * cm, 3.3 * cm, 12.4 * cm, 3.5 * cm], repeatRows=1)
                tabla.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (-1, 0), colors.white),
                    ('TEXTCOLOR', (0, 0), (-1, 0), COLOR_TEXTO_GRIS_PDF),
                    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                    ('FONTSIZE', (0, 0), (-1, 0), 7.5),
                    ('LINEBELOW', (0, 0), (-1, 0), 0.75, colors.HexColor('#D1D5DB')),
                    ('FONTSIZE', (0, 1), (-1, -1), 8.5),
                    ('LINEBELOW', (0, 1), (-1, -1), 0.5, colors.HexColor('#EEF0F3')),
                    ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                    ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
                    ('LEFTPADDING', (0, 0), (0, -1), 0),
                ]))
                elementos.append(tabla)
                elementos.append(Spacer(1, 0.35 * cm))

    doc = SimpleDocTemplate(
        ruta_salida, pagesize=landscape(letter),
        leftMargin=1 * cm, rightMargin=1 * cm, topMargin=1 * cm, bottomMargin=1 * cm,
    )
    doc.build(elementos, onFirstPage=_fondo_pagina_reporte, onLaterPages=_fondo_pagina_reporte)
    return sum(len(f['items']) for f in filas_reporte)  # cuantas fallas quedaron incluidas
    # (ya sin las categorias ocultas) -- para que el llamador decida si vale la pena
    # mandar el PDF (ej. el resumen por hora no manda nada si dio 0)


def generar_pdf_reporte_velocidad(api, ruta_salida, desde_local, hasta_local):
    """Genera el PDF de excesos de velocidad (regla NOMBRE_REGLA_VELOCIDAD) ocurridos
    en [desde_local, hasta_local) -- mismo estilo visual que generar_pdf_reporte_fallas
    (tarjeta por vehiculo, encabezado oscuro, fondo gris). A diferencia del reporte de
    fallas (foto del estado actual), este SIEMPRE es sobre una ventana de tiempo -- un
    exceso de velocidad es un evento puntual, no un estado que sigue 'activo'."""
    devices = {d['id']: d for d in api.get('Device')}
    mapa_grupos = obtener_mapa_grupos(api)
    desde_utc = desde_local.astimezone(timezone.utc)
    hasta_utc = hasta_local.astimezone(timezone.utc)

    candidatos = _obtener_eventos_regla(api, NOMBRE_REGLA_VELOCIDAD, desde_utc, hasta_utc, DURACION_MINIMA_VELOCIDAD_SEG)
    if CIUDAD_FILTRO:
        candidatos = [
            c for c in candidatos
            if resolver_ciudad_tipologia(devices.get(c['id_veh'], {}).get('groups'), mapa_grupos)[0] == CIUDAD_FILTRO
        ]
    _agregar_velocidad_pico(api, candidatos)

    estilos = getSampleStyleSheet()
    estilo_celda = ParagraphStyle('celda_vel', parent=estilos['Normal'], fontSize=8.5, leading=12, textColor=COLOR_TEXTO_OSCURO_PDF)
    estilo_dato = ParagraphStyle('dato_vel', parent=estilo_celda, fontName='Courier-Bold', textColor=colors.HexColor('#0284C7'))
    estilo_titulo = ParagraphStyle('titulo_vel', parent=estilos['Title'], textColor=colors.white, alignment=1)
    estilo_subtitulo = ParagraphStyle('subtitulo_vel', parent=estilos['Normal'], textColor=colors.HexColor('#C7D2E0'), alignment=1)
    estilo_movil = ParagraphStyle('movil_vel', parent=estilos['Heading4'], textColor=COLOR_TEXTO_OSCURO_PDF, spaceAfter=0, spaceBefore=0)
    estilo_movil_detalle = ParagraphStyle('movil_detalle_vel', parent=estilos['Normal'], textColor=COLOR_TEXTO_GRIS_PDF, fontSize=9, alignment=2)
    estilo_resumen_titulo = ParagraphStyle('resumen_titulo_vel', parent=estilos['Heading3'], textColor=COLOR_TEXTO_OSCURO_PDF, spaceAfter=6)
    estilo_resumen_texto = ParagraphStyle('resumen_texto_vel', parent=estilos['Normal'], textColor=COLOR_TEXTO_OSCURO_PDF, fontSize=9, leading=13)

    subtitulo = (
        f"Límite operativo {UMBRAL_VELOCIDAD_KMH} km/h — Compactadores/Ampliroll | {CIUDAD_FILTRO or 'Toda la flota'} | "
        f"{desde_local.strftime('%H:%M')} a {hasta_local.strftime('%H:%M')} del {desde_local.strftime('%d/%m/%Y')}"
    )
    encabezado = Table(
        [[Paragraph("Reporte de Excesos de Velocidad", estilo_titulo)], [Paragraph(subtitulo, estilo_subtitulo)]],
        colWidths=[25 * cm]
    )
    encabezado.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), COLOR_HEADER_PDF),
        ('ROUNDEDCORNERS', [10, 10, 10, 10]),
        ('TOPPADDING', (0, 0), (0, 0), 14), ('BOTTOMPADDING', (0, 0), (0, 0), 2),
        ('TOPPADDING', (0, 1), (0, 1), 2), ('BOTTOMPADDING', (0, 1), (0, 1), 14),
    ]))
    elementos = [encabezado, Spacer(1, 0.4 * cm)]

    if not candidatos:
        elementos.append(Paragraph("No hubo excesos de velocidad en este turno.", estilos['Normal']))
    else:
        por_vehiculo = {}
        for c in candidatos:
            por_vehiculo.setdefault(c['id_veh'], []).append(c)

        filas_reporte = []
        for id_veh, eventos in por_vehiculo.items():
            vehiculo = devices.get(id_veh, {})
            marca = resolver_marca(vehiculo.get('groups'), mapa_grupos) or 'Sin marca'
            eventos.sort(key=lambda e: e['activeFrom'])
            picos_veh = [e.get('velocidad_pico') for e in eventos if e.get('velocidad_pico') is not None]
            filas_reporte.append({
                'movil': vehiculo.get('name', id_veh), 'marca': marca, 'eventos': eventos,
                'duracion_total_seg': sum(e['duracion_seg'] for e in eventos),
                'velocidad_pico_max': max(picos_veh) if picos_veh else None,
            })

        # --- Resumen del turno ---
        total_eventos = len(candidatos)
        total_vehiculos = len(filas_reporte)
        top_vehiculos = sorted(filas_reporte, key=lambda f: -len(f['eventos']))[:3]
        texto_top = "<br/>".join(
            f"{i}. {f['movil']} ({len(f['eventos'])} evento(s))" for i, f in enumerate(top_vehiculos, 1)
        ) or "—"
        picos_validos = [e.get('velocidad_pico') for e in candidatos if e.get('velocidad_pico') is not None]
        texto_pico = f"{max(picos_validos):.0f} km/h" if picos_validos else "Sin dato"

        fila_resumen = [[
            Paragraph(f"<b>Total de excesos:</b><br/>{total_eventos} evento(s) en {total_vehiculos} vehículo(s)", estilo_resumen_texto),
            Paragraph(f"<b>Vehículos más frecuentes:</b><br/>{texto_top}", estilo_resumen_texto),
            Paragraph(f"<b>Velocidad pico más alta registrada:</b><br/>{texto_pico}", estilo_resumen_texto),
        ]]
        tabla_resumen_titulo = Table([[Paragraph("Resumen del Turno", estilo_resumen_titulo)]], colWidths=[25 * cm])
        tabla_resumen_titulo.setStyle(TableStyle([
            ('LEFTPADDING', (0, 0), (-1, -1), 14), ('TOPPADDING', (0, 0), (-1, -1), 12), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ]))
        tabla_resumen_cuerpo = Table([fila_resumen[0]], colWidths=[8.3 * cm, 8.3 * cm, 8.4 * cm])
        tabla_resumen_cuerpo.setStyle(TableStyle([
            ('LEFTPADDING', (0, 0), (0, 0), 14), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 14),
        ]))
        resumen_envoltorio = Table([[tabla_resumen_titulo], [tabla_resumen_cuerpo]], colWidths=[25 * cm])
        resumen_envoltorio.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), colors.white),
            ('ROUNDEDCORNERS', [8, 8, 8, 8]),
            ('LINEBEFORE', (0, 0), (0, -1), 3, COLOR_RESUMEN_BORDE_PDF),
            ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ]))
        elementos.append(resumen_envoltorio)
        elementos.append(Spacer(1, 0.4 * cm))

        # --- Detalle cuantificable por vehiculo (TODOS, no solo el top 3 del
        # resumen) -- pedido explicito del usuario 2026-08-27 despues de validar
        # el PDF, para poder comparar la flota completa de un vistazo antes de
        # entrar al detalle evento por evento de cada tarjeta. ---
        filas_reporte.sort(key=lambda f: (-len(f['eventos']), f['movil']))
        datos_tabla_vehiculos = [['Vehículo', 'Marca', 'N° Eventos', 'Duración total', 'Velocidad pico', f'Exceso máx. sobre {UMBRAL_VELOCIDAD_KMH} km/h']]
        for f in filas_reporte:
            dur_total = f['duracion_total_seg']
            texto_dur_total = f"{dur_total / 60:.1f} min" if dur_total >= 60 else f"{dur_total:.0f} seg"
            pico_max = f['velocidad_pico_max']
            texto_pico_max = f"{pico_max:.0f} km/h" if pico_max is not None else "Sin dato"
            texto_exceso_max = f"+{pico_max - UMBRAL_VELOCIDAD_KMH:.0f} km/h" if pico_max is not None else "—"
            datos_tabla_vehiculos.append([
                Paragraph(f['movil'], estilo_celda),
                Paragraph(f['marca'], estilo_celda),
                Paragraph(str(len(f['eventos'])), estilo_dato),
                Paragraph(texto_dur_total, estilo_dato),
                Paragraph(texto_pico_max, estilo_dato),
                Paragraph(texto_exceso_max, estilo_dato),
            ])

        tabla_titulo_vehiculos = Table([[Paragraph("Detalle por Vehículo", estilo_resumen_titulo)]], colWidths=[25 * cm])
        tabla_titulo_vehiculos.setStyle(TableStyle([
            ('LEFTPADDING', (0, 0), (-1, -1), 0), ('TOPPADDING', (0, 0), (-1, -1), 0), ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ]))
        elementos.append(tabla_titulo_vehiculos)

        tabla_vehiculos = Table(
            datos_tabla_vehiculos,
            colWidths=[4.5 * cm, 5 * cm, 3 * cm, 4 * cm, 4 * cm, 4.5 * cm], repeatRows=1
        )
        tabla_vehiculos.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), colors.white),
            ('BACKGROUND', (0, 0), (-1, 0), COLOR_VEHICULO_HEADER_PDF),
            ('ROUNDEDCORNERS', [8, 8, 8, 8]),
            ('TEXTCOLOR', (0, 0), (-1, 0), COLOR_TEXTO_OSCURO_PDF),
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('FONTSIZE', (0, 0), (-1, 0), 8),
            ('FONTSIZE', (0, 1), (-1, -1), 8.5),
            ('LINEBELOW', (0, 1), (-1, -1), 0.5, colors.HexColor('#EEF0F3')),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
            ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
            ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ]))
        elementos.append(tabla_vehiculos)
        elementos.append(Spacer(1, 0.5 * cm))

        # --- Una tarjeta por vehiculo, mas eventos primero ---
        for f in filas_reporte:
            encabezado_veh = Table(
                [[
                    Paragraph(f"Placa: {f['movil']}", estilo_movil),
                    Paragraph(f"{f['marca']} | {len(f['eventos'])} exceso(s) en el turno", estilo_movil_detalle),
                ]],
                colWidths=[14 * cm, 11 * cm]
            )
            encabezado_veh.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, -1), COLOR_VEHICULO_HEADER_PDF),
                ('ROUNDEDCORNERS', [8, 8, 8, 8]),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('LEFTPADDING', (0, 0), (0, 0), 12), ('RIGHTPADDING', (1, 0), (1, 0), 12),
                ('TOPPADDING', (0, 0), (-1, -1), 8), ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
            ]))
            elementos.append(encabezado_veh)
            elementos.append(Spacer(1, 0.15 * cm))

            datos_tabla = [['Hora', 'Duración sostenida', 'Velocidad pico', f'Exceso sobre {UMBRAL_VELOCIDAD_KMH} km/h']]
            for e in f['eventos']:
                hora = e['activeFrom'].tz_convert(ZONA_BOGOTA).strftime('%d/%m/%Y %H:%M:%S')
                pico = e.get('velocidad_pico')
                texto_pico = f"{pico:.0f} km/h" if pico is not None else "Sin dato"
                texto_exceso = f"+{pico - UMBRAL_VELOCIDAD_KMH:.0f} km/h" if pico is not None else "—"
                datos_tabla.append([
                    Paragraph(hora, estilo_celda),
                    Paragraph(f"{e['duracion_seg']:.0f} seg", estilo_celda),
                    Paragraph(texto_pico, estilo_dato),
                    Paragraph(texto_exceso, estilo_dato),
                ])

            tabla = Table(datos_tabla, colWidths=[6.5 * cm, 6 * cm, 6 * cm, 6.5 * cm], repeatRows=1)
            tabla.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.white),
                ('TEXTCOLOR', (0, 0), (-1, 0), COLOR_TEXTO_GRIS_PDF),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, 0), 7.5),
                ('LINEBELOW', (0, 0), (-1, 0), 0.75, colors.HexColor('#D1D5DB')),
                ('FONTSIZE', (0, 1), (-1, -1), 8.5),
                ('LINEBELOW', (0, 1), (-1, -1), 0.5, colors.HexColor('#EEF0F3')),
                ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
                ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
            ]))
            elementos.append(tabla)
            elementos.append(Spacer(1, 0.35 * cm))

    doc = SimpleDocTemplate(
        ruta_salida, pagesize=landscape(letter),
        leftMargin=1 * cm, rightMargin=1 * cm, topMargin=1 * cm, bottomMargin=1 * cm,
    )
    doc.build(elementos, onFirstPage=_fondo_pagina_reporte, onLaterPages=_fondo_pagina_reporte)
    return len(candidatos)


def _enviar_reporte_velocidad_completo(api, desde_local, hasta_local, nombre_archivo, caption):
    """Genera y manda el PDF de excesos de velocidad del turno [desde_local, hasta_local).
    Siempre se manda, incluso sin eventos -- mismo criterio que el reporte de fallas
    (el supervisor espera un documento cada turno, silencio no es una opcion)."""
    ruta_pdf = None
    try:
        ruta_pdf = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False).name
        n_eventos = generar_pdf_reporte_velocidad(api, ruta_pdf, desde_local, hasta_local)
        for chat_id in _chat_ids_destino():
            _enviar_documento_telegram(chat_id, ruta_pdf, nombre_archivo, caption)
        print(f"{caption}: PDF enviado ({n_eventos} excesos de velocidad).")
    except Exception as e:
        print(f"*** No se pudo generar/enviar el PDF de velocidad ({caption}): {e} ***")
    finally:
        if ruta_pdf and os.path.exists(ruta_pdf):
            os.remove(ruta_pdf)


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


def _construir_texto_persistentes(api, desde, etiqueta):
    """Lista compacta (una linea por vehiculo, no el detalle completo) de las fallas
    que ya estaban activas ANTES de 'desde' y siguen activas ahora -- para no perder
    el rastro de lo que lleva dias sin resolverse, ya que el PDF del periodo (turno u
    hora) solo trae lo nuevo. Cualquier criticidad (no solo ALTA). 'etiqueta' es texto
    libre para el encabezado (ej. 'turno R2' o 'antes de las 14:00')."""
    activas, devices, dic_diag, dic_fm, mapa_grupos = _obtener_fallas_activas(api)
    if activas.empty:
        return []

    desde_utc = desde.astimezone(timezone.utc)
    persistentes = activas[activas['dateTime'] < desde_utc]
    if persistentes.empty:
        return []

    ahora_utc = datetime.now(timezone.utc)
    filas_persistentes = []
    for _, grupo in persistentes.groupby('id_camion'):
        fila_mas_vieja = grupo.sort_values('dateTime', ascending=True).iloc[0]
        nombre_veh, ciudad, _, _, _, _, _, _ = _texto_falla(fila_mas_vieja, devices, dic_diag, dic_fm, mapa_grupos)
        dias_activa = (ahora_utc - fila_mas_vieja['dateTime']).days
        conteo_criticidad = grupo['criticidad'].value_counts().to_dict()
        resumen_criticidad = ', '.join(
            f"{n} {c}" for c, n in sorted(conteo_criticidad.items(), key=lambda kv: -ORDEN_CRITICIDAD.get(kv[0], 0))
        )
        filas_persistentes.append({
            'ciudad': ciudad, 'n_codigos': len(grupo),
            'texto': f"  • {nombre_veh}: {len(grupo)} código(s) ({resumen_criticidad}), la más vieja lleva {dias_activa} día(s) activa",
        })

    lineas = [
        f"⏳ Fallas persistentes sin resolver ({etiqueta}) — "
        f"{len(persistentes)} en {persistentes['id_camion'].nunique()} vehículos:"
    ]
    for ciudad, filas_ciudad in _agrupar_por_ciudad(filas_persistentes):
        lineas.append(f"{ciudad}:")
        for f in sorted(filas_ciudad, key=lambda x: -x['n_codigos']):
            lineas.append(f['texto'])
    return lineas


def _enviar_reporte_fallas(api, desde_local, hasta_local, nombre_archivo, caption, etiqueta_persistentes):
    """Genera y manda el PDF de fallas nuevas en [desde_local, hasta_local) -- silencio
    (no manda nada) si dio 0 -- mas el resumen de texto de las persistentes (activas
    desde antes de desde_local). Mismo patron para el resumen por hora y el reporte de
    fin de turno, asi ambos quedan cortos y faciles de revisar (el PDF trae solo lo
    nuevo, ya agrupado por ciudad/criticidad/sistema; el texto no repite el detalle de
    lo que ya se reporto antes, solo la cuenta de lo que sigue sin resolver)."""
    ruta_pdf = None
    try:
        ruta_pdf = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False).name
        n_fallas = generar_pdf_reporte_fallas(api, ruta_pdf, desde_local=desde_local, hasta_local=hasta_local)
        if n_fallas == 0:
            print(f"{caption}: sin fallas nuevas, no se manda nada.")
        else:
            for chat_id in _chat_ids_destino():
                _enviar_documento_telegram(chat_id, ruta_pdf, nombre_archivo, caption)
            print(f"{caption}: PDF enviado ({n_fallas} fallas).")
    except Exception as e:
        print(f"*** No se pudo generar/enviar el PDF ({caption}): {e} ***")
    finally:
        if ruta_pdf and os.path.exists(ruta_pdf):
            os.remove(ruta_pdf)

    try:
        lineas_persistentes = _construir_texto_persistentes(api, desde_local, etiqueta_persistentes)
        if lineas_persistentes:
            _enviar_por_partes(lineas_persistentes)
            print(f"Resumen de persistentes ({etiqueta_persistentes}) enviado.")
    except Exception as e:
        print(f"*** No se pudo armar/enviar el resumen de persistentes ({etiqueta_persistentes}): {e} ***")


def _enviar_reporte_fallas_completo(api, nombre_archivo, caption):
    """Genera y manda el PDF con TODAS las fallas activas ahora mismo (no solo
    las nuevas de una ventana) -- pensado para el reporte de fin de turno, que
    el supervisor recibe/imprime para hacer su debido proceso y necesita el
    panorama completo, no solo lo que cambio en las ultimas 8 horas. A
    diferencia de _enviar_reporte_fallas, este SIEMPRE se manda, incluso si no
    hay fallas activas (el PDF mismo dice "No hay fallas activas") -- el
    supervisor espera un documento cada turno, silencio no es una opcion aca."""
    ruta_pdf = None
    try:
        ruta_pdf = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False).name
        n_fallas = generar_pdf_reporte_fallas(api, ruta_pdf)
        for chat_id in _chat_ids_destino():
            _enviar_documento_telegram(chat_id, ruta_pdf, nombre_archivo, caption)
        print(f"{caption}: PDF enviado ({n_fallas} fallas activas).")
    except Exception as e:
        print(f"*** No se pudo generar/enviar el PDF ({caption}): {e} ***")
    finally:
        if ruta_pdf and os.path.exists(ruta_pdf):
            os.remove(ruta_pdf)


def enviar_resumenes_por_turno(api, estado):
    """Manda un PDF cada vez que se completa un turno (R1 termina 13h, R2 21h, R3 5h
    del dia siguiente) con el listado COMPLETO de fallas activas (cualquier
    criticidad, no solo las nuevas del turno) -- pensado para que el supervisor
    lo reciba/imprima en cada cambio de turno y tenga el panorama entero para
    su debido proceso. Siempre se manda, incluso si no hay fallas activas.
    Mismo patron de deteccion por comparacion de tiempos que
    enviar_resumenes_por_hora, para no depender de que el cron corra justo en
    el corte del turno."""
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
        ultimo_turno_fin = fin_turno
        estado['ultimo_turno_fin'] = ultimo_turno_fin.isoformat()

    nombre_archivo = f"reporte_{nombre_turno}_{fin_turno.strftime('%Y%m%d')}.pdf"
    caption = f"📄 Fallas activas — turno {nombre_turno} ({inicio_turno.strftime('%H:%M')}-{fin_turno.strftime('%H:%M')})"
    _enviar_reporte_fallas_completo(api, nombre_archivo, caption)

    nombre_archivo_vel = f"velocidad_{nombre_turno}_{fin_turno.strftime('%Y%m%d')}.pdf"
    caption_vel = f"🚨 Excesos de velocidad — turno {nombre_turno} ({inicio_turno.strftime('%H:%M')}-{fin_turno.strftime('%H:%M')})"
    _enviar_reporte_velocidad_completo(api, inicio_turno, fin_turno, nombre_archivo_vel, caption_vel)


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


def _construir_resumen_revolucion_hora(api, inicio_local, fin_local):
    """Resumen de texto de sobre-revolucion con PTO de la hora [inicio_local, fin_local).
    Las fallas NO van aca -- desde que se ampliaron a cualquier criticidad (no solo
    ALTA) el texto se volvia largo y dificil de leer rapido en el celular; van en un
    PDF aparte (ver _enviar_reporte_fallas), con el mismo agrupado por
    ciudad/criticidad/sistema que ya usa /reporte y el reporte de turno."""
    devices = {d['id']: d for d in api.get('Device')}
    mapa_grupos = obtener_mapa_grupos(api)
    inicio_utc = inicio_local.astimezone(timezone.utc)
    fin_utc = fin_local.astimezone(timezone.utc)

    eventos_revolucion = _resumen_eventos_revolucion_hora(api, devices, mapa_grupos, inicio_utc, fin_utc)

    encabezado = f"📊 RESUMEN {inicio_local.strftime('%H:%M')}–{fin_local.strftime('%H:%M')} ({inicio_local.strftime('%d/%m/%Y')})"

    # Organizado por ciudad (no una lista plana) -- con operacion en varias ciudades,
    # revisar todo mezclado obliga a leer la lista entera para encontrar lo propio.
    # Dentro de cada ciudad, agrupado por vehiculo (no una linea por evento) y sin
    # truncar: el usuario necesita el dato completo para poder reaccionar sin el tablero.
    lineas = [encabezado]
    lineas.append(f"\n🏎️ Sobre-revolución con PTO activo en esta hora ({len(eventos_revolucion)} eventos):")
    lineas.append(f"  Regla: {NOMBRE_REGLA_PTO}")
    if eventos_revolucion:
        for ciudad, eventos_ciudad in _agrupar_por_ciudad(eventos_revolucion):
            lineas.append(f"  {ciudad}:")
            por_vehiculo = {}
            for f in eventos_ciudad:
                por_vehiculo.setdefault(f['nombre_veh'], []).append(f)
            for nombre_veh, eventos_veh in sorted(por_vehiculo.items(), key=lambda kv: -len(kv[1])):
                # La marca es la misma para todos los eventos del vehiculo -- va en el
                # encabezado, no repetida en cada linea.
                marca = eventos_veh[0]['marca']
                lineas.append(f"    {nombre_veh} ({marca}, {len(eventos_veh)} evento(s)):")
                for e in sorted(eventos_veh, key=lambda x: x['hora_local']):
                    rpm = f", pico {e['rpm_pico']:.0f} RPM" if e.get('rpm_pico') is not None else ""
                    lineas.append(f"      • {e['hora_local']} — {e['duracion_seg']:.0f}s{rpm}")
    else:
        lineas.append("  Sin eventos en esta hora.")

    return lineas


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
            lineas_revolucion = _construir_resumen_revolucion_hora(api, ultima_hora, fin_hora)
            _enviar_por_partes(lineas_revolucion)
        except Exception as e:
            print(f"*** Error armando/enviando el resumen de revolucion de {ultima_hora.strftime('%H:%M')}: {e} ***")

        nombre_archivo = f"fallas_{ultima_hora.strftime('%Y%m%d_%H%M')}.pdf"
        caption = f"📄 Fallas nuevas — {ultima_hora.strftime('%H:%M')}-{fin_hora.strftime('%H:%M')} ({ultima_hora.strftime('%d/%m/%Y')})"
        _enviar_reporte_fallas(api, ultima_hora, fin_hora, nombre_archivo, caption, f"antes de las {ultima_hora.strftime('%H:%M')}")

        print(f"Resumen por hora procesado: {ultima_hora.strftime('%H:%M')}-{fin_hora.strftime('%H:%M')}")
        ultima_hora = fin_hora
        estado['ultima_hora_resumen'] = ultima_hora.isoformat()


def main():
    api = conectar_geotab()
    estado = cargar_estado()
    print(f"Estado cargado: {len(estado['revolucion_notificados'])} eventos de revolucion, "
          f"{len(estado['fallas_activas'])} fallas ya notificadas antes, "
          f"{len(estado['regeneracion_dpf_notificados'])} regeneraciones DPF ya notificadas antes.")

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

        claves_fallas_previas = set(estado['fallas_activas'])
        claves_fallas_actuales, _ = revisar_fallas_activas(api, claves_fallas_previas)
        # Union, NO reemplazo -- 'fallas_activas' en el estado es memoria de "ya se
        # notifico" (igual que revolucion_notificados), no "lo que esta activo ahora
        # mismo" (eso siempre se recalcula fresco desde Geotab via
        # _obtener_fallas_activas). Muchos diagnosticos pulsan Active -> None -> Active
        # en segundos (ver _obtener_fallas_activas); si se reemplazara por
        # claves_fallas_actuales, una falla que pulsara a 'None' justo cuando corre el
        # cron desaparecia de la memoria y se volvia a notificar como "nueva" la
        # proxima vez que volviera a 'Active', mandando la misma falla una y otra vez.
        estado['fallas_activas'] = list(claves_fallas_previas | claves_fallas_actuales)

        claves_dpf_previas = set(estado['regeneracion_dpf_notificados'])
        claves_dpf_nuevas = revisar_regeneracion_pendiente(api, claves_dpf_previas)
        estado['regeneracion_dpf_notificados'] = list(claves_dpf_previas | set(claves_dpf_nuevas))

        enviar_resumenes_por_hora(api, estado)
        enviar_resumenes_por_turno(api, estado)
    finally:
        guardar_estado(estado)


if __name__ == "__main__":
    main()
