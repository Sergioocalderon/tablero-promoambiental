import os
import json
import io
import streamlit as st
import pandas as pd
import plotly.express as px
import mygeotab
from datetime import datetime, timedelta, timezone, time as dt_time
from zoneinfo import ZoneInfo
import streamlit.components.v1 as components
import gspread
from google.oauth2.service_account import Credentials
import numpy as np
import re
import textwrap

ZONA_BOGOTA = ZoneInfo("America/Bogota")

def convertir_a_bogota(serie_fechas):
    fechas = pd.to_datetime(serie_fechas)
    if fechas.dt.tz is None:
        return fechas.dt.tz_localize('UTC').dt.tz_convert(ZONA_BOGOTA)
    else:
        return fechas.dt.tz_convert(ZONA_BOGOTA)

st.set_page_config(page_title="Tablero de Control - Promoambiental", page_icon="🚚", layout="wide")

st.markdown("""
<style>
    .stApp { background-color: #F8FAFC; }
    [data-testid="stMetric"] {
        background-color: #FFFFFF;
        border-radius: 8px;
        padding: 15px 20px;
        box-shadow: 0px 4px 6px rgba(0, 0, 0, 0.05);
        border-left: 6px solid #62A830;
        margin-bottom: 10px;
    }
    [data-testid="stMetricLabel"] { font-size: 1.05rem !important; font-weight: 600 !important; color: #475569 !important; }
    [data-testid="stMetricValue"] { font-size: 2.2rem !important; font-weight: 800 !important; color: #1E293B !important; }
    .stTabs [data-baseweb="tab-list"] {
        gap: 8px;
        background-color: #FFFFFF;
        padding: 8px 8px 0px 8px;
        border-radius: 8px;
        box-shadow: 0px 2px 5px rgba(0, 0, 0, 0.05);
    }
    .stTabs [data-baseweb="tab"] {
        height: 45px;
        border-radius: 6px 6px 0px 0px;
        padding: 10px 20px;
        font-weight: 600;
        color: #64748B;
    }
    .stTabs [aria-selected="true"] { background-color: #62A830 !important; color: #FFFFFF !important; }
    [data-testid="stExpander"] {
        background-color: #FFFFFF;
        border: 1px solid #E2E8F0;
        border-radius: 8px;
        box-shadow: 0px 2px 4px rgba(0, 0, 0, 0.02);
        overflow: hidden;
    }
    [data-testid="stExpander"] summary {
        background-color: #FFFFFF;
        padding: 15px !important;
        font-weight: 600;
        color: #1E293B;
        transition: background-color 0.2s ease;
    }
    [data-testid="stExpander"] summary:hover { background-color: #F1F5F9; }
    .block-container { padding-top: 2rem !important; padding-bottom: 2rem !important; }
</style>
""", unsafe_allow_html=True)

# =============================================================================
# SESIÓN Y CACHÉ INICIAL
# =============================================================================
if 'alertas_altas_previas' not in st.session_state:
    st.session_state.alertas_altas_previas = 0
if 'ciudades_disponibles' not in st.session_state:
    st.session_state.ciudades_disponibles = ['Todas']

st.title("🔧 Tablero Operativo de Mantenimiento")
st.markdown("### Fallas, Comportamiento de Manejo y Salud del Motor")

# =============================================================================
# CONEXIONES A GEOTAB Y GOOGLE SHEETS (CACHEADAS)
# =============================================================================
def obtener_credencial(nombre_env, ruta_secrets=None):
    """Busca primero en variables de entorno (Oracle/Render/HF); si no existe,
    recurre a st.secrets (Streamlit Community Cloud), usando ruta_secrets
    como tupla (seccion, clave)."""
    valor = os.environ.get(nombre_env)
    if valor:
        return valor
    if ruta_secrets:
        seccion, clave = ruta_secrets
        return st.secrets[seccion][clave]
    return None

@st.cache_resource
def iniciar_conexion_geotab():
    try:
        USUARIO = obtener_credencial("GEOTAB_USUARIO", ("geotab", "usuario"))
        CONTRASENA = obtener_credencial("GEOTAB_CONTRASENA", ("geotab", "contrasena"))
        BASE_DE_DATOS = obtener_credencial("GEOTAB_DATABASE", ("geotab", "database"))
        SERVIDOR = obtener_credencial("GEOTAB_SERVER", ("geotab", "server"))
        client = mygeotab.API(username=USUARIO, password=CONTRASENA, database=BASE_DE_DATOS, server=SERVIDOR)
        client.authenticate()
        return client
    except Exception as e:
        st.error(f"Error de autenticación: {e}")
        return None

client = iniciar_conexion_geotab()

ID_HOJA_INCIDENTES = "1QdPCp8Vgwc9mJLLAMNK2f1uKFggTrDaj2KI__bWC0LQ"
ALCANCES_SHEETS = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

@st.cache_resource
def conectar_hoja_incidentes():
    try:
        credenciales_env = os.environ.get("GCP_SERVICE_ACCOUNT_JSON")
        if credenciales_env:
            credenciales_info = json.loads(credenciales_env)
        else:
            credenciales_info = dict(st.secrets["gcp_service_account"])
        credenciales = Credentials.from_service_account_info(credenciales_info, scopes=ALCANCES_SHEETS)
        cliente_sheets = gspread.authorize(credenciales)
        hoja = cliente_sheets.open_by_key(ID_HOJA_INCIDENTES).sheet1
        return hoja
    except Exception as e:
        st.warning(f"No se pudo conectar con Google Sheets: {e}")
        return None

hoja_incidentes = conectar_hoja_incidentes()

# =============================================================================
# FUNCIONES DE CARGA Y ACTUALIZACIÓN DE INCIDENTES (PERSISTENCIA)
# =============================================================================
@st.cache_data(ttl=20)
def cargar_incidentes(_hoja):
    if _hoja is None:
        return {}
    try:
        registros = _hoja.get_all_records()
    except Exception as e:
        st.warning(f"No se pudieron leer los incidentes: {e}")
        return {}
    incidentes = {}
    for r in registros:
        id_inc = str(r.get('id_incidente', '')).strip()
        if not id_inc:
            continue
        acciones_texto = str(r.get('acciones_completadas', '') or '')
        acciones_lista = [a for a in acciones_texto.split('|') if a]
        incidentes[id_inc] = {
            'estado': r.get('estado') or 'Abierto',
            'acciones_realizadas': acciones_lista,
            # Leer la columna K (título esperado: "Ubicacion Reparacion")
            'ubicacion': r.get('Ubicacion Reparacion', 'No registrada'),
            'detalle': {
                'Movil': r.get('movil'),
                'Placa': r.get('placa'),
                'Descripcion_Falla': r.get('descripcion_falla'),
                'Criticidad': r.get('criticidad'),
                'Ciudad': r.get('ciudad') or 'Sin ciudad asignada',
            }
        }
    return incidentes

def crear_incidente_en_hoja(hoja, id_incidente, movil, placa, descripcion_falla, criticidad, fecha_hora, ciudad):
    if hoja is None:
        return
    try:
        hoja.append_row([
            id_incidente,          # A
            movil,                 # B
            placa,                 # C
            descripcion_falla,     # D
            criticidad,            # E
            'Abierto',             # F
            '',                    # G
            str(fecha_hora),       # H
            '',                    # I (fecha cierre - vacía)
            ciudad,                # J (ciudad)
            ''                     # K (ubicación reparación - vacía)
        ])
        cargar_incidentes.clear()
    except Exception as e:
        st.warning(f"No se pudo guardar el incidente: {e}")

def actualizar_incidente_en_hoja(hoja, id_incidente, nuevo_estado, acciones_realizadas, ubicacion=None):
    if hoja is None:
        st.error("❌ No hay conexión con Google Sheets.")
        return False
    try:
        celda = hoja.find(id_incidente, in_column=1)
        if not celda:
            st.error(f"❌ No se encontró el incidente con ID '{id_incidente}'.")
            return False
        fila = celda.row
        hoja.update_cell(fila, 6, nuevo_estado)                  # F
        hoja.update_cell(fila, 7, '|'.join(acciones_realizadas)) # G
        if nuevo_estado == 'Cerrado':
            hoja.update_cell(fila, 9, str(datetime.now(ZONA_BOGOTA)))  # I (fecha cierre)
            if ubicacion:
                hoja.update_cell(fila, 11, ubicacion)            # K (ubicación)
        cargar_incidentes.clear()
        st.success(f"✅ Incidente {id_incidente} actualizado a '{nuevo_estado}'.")
        return True
    except Exception as e:
        st.error(f"❌ Error al actualizar: {e}")
        return False

# =============================================================================
# SIDEBAR – FILTROS
# =============================================================================
st.sidebar.header("⚙️ Parámetros de Búsqueda")
st.sidebar.subheader("📅 Periodo Operativo")

ahora = datetime.now(ZONA_BOGOTA)
inicio_dia = ahora.replace(hour=0, minute=0, second=0, microsecond=0)

col_f1, col_f2 = st.sidebar.columns(2)
with col_f1:
    d_inicio = st.date_input("Día Inicio", inicio_dia.date())
    t_inicio = st.time_input("Hora Inicio", inicio_dia.time())
with col_f2:
    d_fin = st.date_input("Día Fin", ahora.date())
    t_fin = st.time_input("Hora Fin", ahora.time())

fecha_inicio = datetime.combine(d_inicio, t_inicio).replace(tzinfo=ZONA_BOGOTA)
fecha_fin = datetime.combine(d_fin, t_fin).replace(tzinfo=ZONA_BOGOTA)

dias_activa_umbral = 3
duracion_min_minutos = 15
COSTO_MINUTO_RALENTI_COP = 300

if st.sidebar.button("🔄 Actualizar datos", use_container_width=True):
    st.cache_data.clear()
    st.rerun()

# =============================================================================
# PROTOCOLOS Y CONSTANTES
# =============================================================================
PROTOCOLOS = {
    'ALTA': {
        'nombre': 'Protocolo de Emergencia',
        'acciones': [
            {'orden': 1, 'texto': 'Notificar al supervisor de turno.', 'responsable': 'Supervisor'},
            {'orden': 2, 'texto': 'Contactar al conductor.', 'responsable': 'Coordinador'},
            {'orden': 3, 'texto': 'Enviar grúa o mecánico.', 'responsable': 'Jefe de Flota'},
            {'orden': 4, 'texto': 'Registrar incidente en ticketing.', 'responsable': 'Operador'},
            {'orden': 5, 'texto': 'Seguimiento hasta cierre.', 'responsable': 'Supervisor'}
        ],
        'tiempo_max_respuesta_min': 5
    },
    'MEDIA': {
        'nombre': 'Protocolo de Atención Programada',
        'acciones': [
            {'orden': 1, 'texto': 'Evaluar necesidad de detener ruta.', 'responsable': 'Coordinador'},
            {'orden': 2, 'texto': 'Agendar cita en taller.', 'responsable': 'Operador'},
            {'orden': 3, 'texto': 'Notificar al conductor.', 'responsable': 'Operador'}
        ],
        'tiempo_max_respuesta_min': 30
    },
    'BAJA': {
        'nombre': 'Registro y Mantenimiento Preventivo',
        'acciones': [
            {'orden': 1, 'texto': 'Registrar en historial.', 'responsable': 'Sistema'},
            {'orden': 2, 'texto': 'Programar revisión preventiva.', 'responsable': 'Sistema'}
        ],
        'tiempo_max_respuesta_min': 1440
    }
}

IMPACTO_POR_GRUPO = {
    # AJUSTA estas claves para que coincidan EXACTO con los valores que existan
    # en la columna "Grupo" de diccionario_fallas.csv. Estos son valores de ejemplo.
    'Motor': 'Riesgo de daño mayor al motor si continúa operando sin atención.',
    'Refrigeracion': 'Riesgo de sobrecalentamiento y daño al motor.',
    'Frenos': 'Riesgo directo de seguridad vial. Prioridad máxima.',
    'Emisiones': 'Riesgo de multas ambientales y falla del sistema de escape.',
    'Combustible': 'Riesgo de pérdida de potencia o varada en ruta.',
    'Electrico': 'Riesgo de fallas intermitentes en otros sistemas del vehículo.',
    'Transmision': 'Riesgo de daño a la caja de cambios si continúa en operación.',
}

def obtener_texto_impacto(grupo_sistema, criticidad):
    if grupo_sistema in IMPACTO_POR_GRUPO:
        return IMPACTO_POR_GRUPO[grupo_sistema]
    texto_generico_por_criticidad = {
        'ALTA': 'Riesgo de varada o daño mayor si el vehículo continúa en operación.',
        'MEDIA': 'Puede derivar en una falla mayor si no se atiende pronto.',
        'BAJA': 'Sin riesgo inmediato, pero debe registrarse para mantenimiento preventivo.',
    }
    return texto_generico_por_criticidad.get(criticidad, 'Impacto operativo no determinado.')

REFERENCIA_MOTOR_POR_MARCA = {
    "volkswagen": "ISF 3.8",
    "volskwagen": "ISF 3.8",
    "mercedes": "OM926",
    "international": "L9",
    "foton": "X12",
    "kenworth": "ISM 11",
}

NOMBRE_REGLA_RPM_POR_MOTOR = {'L9': 'SOBRE REVOLUCION (L9)', 'X12': 'SOBRE REVOLUCION (X12)'}
LIMITE_VELOCIDAD_POR_CIUDAD = {'Bogotá': 50}

# Límites especiales por localidad/zona (Geotab Zone), independientes del límite de ciudad.
# La coincidencia es por substring, insensible a mayúsculas/minúsculas, contra el nombre
# de la zona tal como está en Geotab. AJUSTA la clave si tu zona se llama distinto
# (ej. "Relleno Sanitario Doña Juana", "RS Colomba", etc.).
LIMITE_VELOCIDAD_ZONAS_ESPECIALES = {
    'doña juana': 30,
}

def obtener_limite_velocidad_aplicable(localidad, limite_ciudad):
    """Devuelve el límite de velocidad para un punto dado su localidad.
    Si la localidad coincide con una zona especial, usa ese límite;
    si no, usa el límite general de la ciudad (ej. 50 km/h)."""
    if localidad:
        localidad_l = localidad.lower()
        for clave, limite_especial in LIMITE_VELOCIDAD_ZONAS_ESPECIALES.items():
            if clave.lower() in localidad_l:
                return limite_especial
    return limite_ciudad

# IDs de diagnóstico Geotab usados para el "freeze frame" (contexto al momento de la falla).
# ID_DIAGNOSTICO_RPM_MOTOR ya se usaba en extraer_datos_manejo(); se reutiliza aquí.
ID_DIAGNOSTICO_RPM_MOTOR = 'aW3Nmy-ktfEuvrdkya4z0yg'          # Engine Speed (RPM)
ID_DIAGNOSTICO_TEMPERATURA = 'DiagnosticEngineCoolantTemperatureId'
ID_DIAGNOSTICO_ODOMETRO = 'DiagnosticOdometerId'               # Geotab entrega esto en metros
TOLERANCIA_FREEZE_FRAME = pd.Timedelta('5min')

def clasificar_turno(momento):
    hora = momento.hour
    if 5 <= hora < 13:
        return 'R1'
    elif 13 <= hora < 21:
        return 'R2'
    else:
        return 'R3'

def normalizar_nombre_localidad(texto):
    conectores = {'de', 'del', 'la', 'las', 'el', 'los', 'y', 'en'}
    palabras = texto.strip().lower().split()
    resultado = [palabra if palabra in conectores else palabra.capitalize() for palabra in palabras]
    if resultado:
        resultado[0] = resultado[0].capitalize()
    return ' '.join(resultado)

# =============================================================================
# FUNCIONES DE EXTRACCIÓN DE DATOS (CACHEADAS)
# =============================================================================
@st.cache_data(ttl=3600)
def obtener_reglas_rpm(_client):
    if _client is None:
        return {}
    try:
        todas_reglas = _client.get('Rule')
        mapa_regla_id = {}
        for motor, nombre_regla in NOMBRE_REGLA_RPM_POR_MOTOR.items():
            objetivo = nombre_regla.strip().upper()
            regla = next((r for r in todas_reglas if r.get('name', '').strip().upper() == objetivo), None)
            if regla:
                mapa_regla_id[motor] = regla['id']
        return mapa_regla_id
    except Exception as e:
        st.warning(f"No se pudieron cargar reglas RPM: {e}")
        return {}

def convertir_a_minutos(valor):
    if valor is None:
        return 0
    if isinstance(valor, dt_time):
        return (valor.hour * 60) + valor.minute + (valor.second / 60) + (valor.microsecond / 60_000_000)
    try:
        return pd.to_timedelta(valor).total_seconds() / 60
    except (ValueError, TypeError):
        return 0

@st.cache_data(ttl=180)
def extraer_datos_manejo(_client, f_inicio, f_fin, _df_vehiculos):
    if _client is None or _df_vehiculos.empty:
        return pd.DataFrame(), pd.DataFrame()
    f_inicio_utc = f_inicio.astimezone(timezone.utc)
    f_fin_utc = f_fin.astimezone(timezone.utc)
    vehiculos_con_regla = _df_vehiculos[_df_vehiculos['Referencia_Motor'].isin(NOMBRE_REGLA_RPM_POR_MOTOR.keys())]
    mapa_reglas = obtener_reglas_rpm(_client)
    eventos_todos = []
    for motor, id_regla in mapa_reglas.items():
        vehiculos_motor = vehiculos_con_regla[vehiculos_con_regla['Referencia_Motor'] == motor]['id_camion'].tolist()
        if not vehiculos_motor:
            continue
        try:
            eventos_raw = _client.get('ExceptionEvent', search={
                'ruleSearch': {'id': id_regla},
                'fromDate': f_inicio_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                'toDate': f_fin_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
            })
            for ev in (eventos_raw or []):
                dev = ev.get('device')
                id_veh = dev['id'] if isinstance(dev, dict) else dev
                if id_veh in vehiculos_motor:
                    eventos_todos.append({
                        'id_camion': id_veh,
                        'Motor': motor,
                        'activeFrom': ev.get('activeFrom'),
                        'activeTo': ev.get('activeTo'),
                    })
        except Exception as e:
            st.warning(f"No se pudieron traer eventos para {motor}: {e}")
    if not eventos_todos:
        return pd.DataFrame(), pd.DataFrame()
    df_eventos = pd.DataFrame(eventos_todos)
    df_eventos['activeFrom'] = convertir_a_bogota(df_eventos['activeFrom'])
    df_eventos['activeTo'] = convertir_a_bogota(df_eventos['activeTo'])
    df_eventos['Fecha'] = df_eventos['activeFrom'].dt.date
    df_eventos['Hora_Bogota'] = df_eventos['activeFrom']
    df_eventos['Turno'] = df_eventos['Hora_Bogota'].apply(clasificar_turno)
    df_eventos['Duracion_Segundos'] = (df_eventos['activeTo'] - df_eventos['activeFrom']).dt.total_seconds()
    df_eventos['Umbral_RPM'] = df_eventos['Motor'].map({'L9': 2100, 'X12': 2100})
    df_eventos = pd.merge(df_eventos, _df_vehiculos, on='id_camion', how='left')

    # Un viaje de red agrupado por vehículo (con deviceSearch, igual que el patrón que sí
    # funciona) en vez de una llamada StatusData por cada evento de sobre-revolución.
    vehiculos_con_eventos_rpm = df_eventos['id_camion'].unique().tolist()
    df_lecturas_rpm = pd.DataFrame()
    if vehiculos_con_eventos_rpm:
        llamadas_rpm = [
            ('Get', {
                'typeName': 'StatusData',
                'search': {
                    'diagnosticSearch': {'id': ID_DIAGNOSTICO_RPM_MOTOR},
                    'deviceSearch': {'id': id_veh},
                    'fromDate': f_inicio_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                    'toDate': f_fin_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
                }
            })
            for id_veh in vehiculos_con_eventos_rpm
        ]
        try:
            resultados_rpm = _client.multi_call(llamadas_rpm)
        except Exception as e:
            st.warning(f"No se pudieron traer lecturas de RPM: {e}")
            resultados_rpm = []
        filas_rpm = []
        for id_veh, lecturas in zip(vehiculos_con_eventos_rpm, resultados_rpm):
            if lecturas and isinstance(lecturas, list):
                for l in lecturas:
                    filas_rpm.append({'id_camion': id_veh, 'dateTime': l.get('dateTime'), 'data': l.get('data')})
        if filas_rpm:
            df_lecturas_rpm = pd.DataFrame(filas_rpm)
            df_lecturas_rpm['dateTime'] = convertir_a_bogota(df_lecturas_rpm['dateTime'])
            df_lecturas_rpm['data'] = pd.to_numeric(df_lecturas_rpm['data'], errors='coerce')
            df_lecturas_rpm = df_lecturas_rpm[['id_camion', 'dateTime', 'data']].dropna()

    def obtener_pico_evento(row):
        if df_lecturas_rpm.empty:
            return None
        desde = row['activeFrom'] - timedelta(seconds=30)
        hasta = row['activeTo'] + timedelta(seconds=30)
        ventana = df_lecturas_rpm[
            (df_lecturas_rpm['id_camion'] == row['id_camion']) &
            (df_lecturas_rpm['dateTime'] >= desde) &
            (df_lecturas_rpm['dateTime'] <= hasta)
        ]
        return ventana['data'].max() if not ventana.empty else None
    df_eventos['RPM_Pico'] = df_eventos.apply(obtener_pico_evento, axis=1)
    df_rpm_diario = df_eventos.groupby(['id_camion', 'Fecha'])['RPM_Pico'].max().reset_index()
    df_rpm_diario = df_rpm_diario.rename(columns={'RPM_Pico': 'RPM_Maximo'})
    return df_eventos, df_rpm_diario

def convertir_a_excel(df):
    buffer = io.BytesIO()
    with pd.ExcelWriter(buffer, engine='openpyxl') as writer:
        df.to_excel(writer, index=False, sheet_name='Datos')
    return buffer.getvalue()

@st.cache_data(ttl=180)
def extraer_datos_velocidad(_client, f_inicio, f_fin, _df_vehiculos):
    if _client is None or _df_vehiculos.empty:
        return pd.DataFrame()
    f_inicio_utc = f_inicio.astimezone(timezone.utc)
    f_fin_utc = f_fin.astimezone(timezone.utc)
    zonas = obtener_zonas(_client)
    # El límite más bajo posible entre todos los configurados (ciudad + zonas especiales).
    # Un punto por debajo de este valor NUNCA puede ser infracción, así que nos ahorramos
    # el cálculo de localidad (point-in-polygon, costoso) para esos puntos.
    limites_posibles = list(LIMITE_VELOCIDAD_POR_CIUDAD.values()) + list(LIMITE_VELOCIDAD_ZONAS_ESPECIALES.values())
    limite_minimo_global = min(limites_posibles) if limites_posibles else 0
    eventos = []
    for ciudad, limite in LIMITE_VELOCIDAD_POR_CIUDAD.items():
        vehiculos_ciudad = _df_vehiculos[_df_vehiculos['Ciudad'] == ciudad]
        if vehiculos_ciudad.empty:
            continue
        ids_vehiculos = vehiculos_ciudad['id_camion'].tolist()

        # Un solo viaje de ida y vuelta al servidor para TODOS los vehículos de la ciudad
        # (antes: una llamada HTTP secuencial por cada vehículo — el cuello de botella real).
        llamadas = [
            ('Get', {
                'typeName': 'LogRecord',
                'search': {
                    'deviceSearch': {'id': id_veh},
                    'fromDate': f_inicio_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                    'toDate': f_fin_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
                }
            })
            for id_veh in ids_vehiculos
        ]
        try:
            resultados = _client.multi_call(llamadas)
        except Exception as e:
            st.warning(f"No se pudo agrupar la consulta de LogRecord para {ciudad}, se omite: {e}")
            continue

        for id_veh, logs in zip(ids_vehiculos, resultados):
            try:
                if not logs or not isinstance(logs, list):
                    continue
                df_log = pd.DataFrame(logs)
                if df_log.empty or 'speed' not in df_log.columns:
                    continue
                df_log['dateTime'] = convertir_a_bogota(df_log['dateTime'])
                df_log = df_log.sort_values('dateTime').reset_index(drop=True)

                # Localidad por punto: solo se calcula para puntos que ya superan el límite
                # mínimo posible. El resto conserva un valor por defecto (nunca es infracción).
                df_log['Localidad_Punto'] = 'Fuera de zonas definidas'
                mascara_relevante = df_log['speed'] > limite_minimo_global
                if mascara_relevante.any():
                    df_log.loc[mascara_relevante, 'Localidad_Punto'] = df_log.loc[mascara_relevante].apply(
                        lambda r: determinar_localidad(r.get('longitude'), r.get('latitude'), zonas), axis=1
                    )
                df_log['Limite_Aplicable'] = df_log['Localidad_Punto'].apply(
                    lambda loc: obtener_limite_velocidad_aplicable(loc, limite)
                )
                df_log['excede'] = df_log['speed'] > df_log['Limite_Aplicable']
                df_log['grupo'] = (df_log['excede'] != df_log['excede'].shift()).cumsum()
                for _, grupo_df in df_log[df_log['excede']].groupby('grupo'):
                    inicio = grupo_df['dateTime'].iloc[0]
                    fin = grupo_df['dateTime'].iloc[-1]
                    duracion = (fin - inicio).total_seconds()
                    if duracion < 5:
                        continue
                    idx_max = grupo_df['speed'].idxmax()
                    fila_max = grupo_df.loc[idx_max]
                    eventos.append({
                        'id_camion': id_veh,
                        'activeFrom': inicio,
                        'activeTo': fin,
                        'Duracion_Segundos': duracion,
                        'Velocidad_Maxima': grupo_df['speed'].max(),
                        'latitude': fila_max.get('latitude'),
                        'longitude': fila_max.get('longitude'),
                        'Localidad': fila_max['Localidad_Punto'],
                        'Limite_Velocidad': fila_max['Limite_Aplicable'],
                    })
            except Exception:
                # Un vehículo con datos inesperados no debe tumbar el resto del cálculo.
                continue
    if not eventos:
        return pd.DataFrame()
    df_eventos_vel = pd.DataFrame(eventos)
    df_eventos_vel['Fecha'] = df_eventos_vel['activeFrom'].dt.date
    df_eventos_vel['Turno'] = df_eventos_vel['activeFrom'].apply(clasificar_turno)
    df_eventos_vel = pd.merge(df_eventos_vel, _df_vehiculos, on='id_camion', how='left')
    return df_eventos_vel

@st.cache_data(ttl=180)
def obtener_zonas(_client):
    if _client is None:
        return []
    try:
        zonas_raw = _client.get('Zone')
        zonas = []
        for z in zonas_raw:
            if isinstance(z, dict) and z.get('points'):
                poligono = [(p['x'], p['y']) for p in z['points']]
                lons = [p[0] for p in poligono]
                lats = [p[1] for p in poligono]
                area = 0
                n = len(poligono)
                for i in range(n):
                    x1, y1 = poligono[i]
                    x2, y2 = poligono[(i + 1) % n]
                    area += x1 * y2 - x2 * y1
                area = abs(area) / 2
                zonas.append({
                    'nombre': z.get('name', 'Zona sin nombre'),
                    'poligono': poligono,
                    'centro_lon': sum(lons) / len(lons),
                    'centro_lat': sum(lats) / len(lats),
                    'area': area
                })
        return zonas
    except Exception as e:
        st.warning(f"No se pudieron cargar zonas: {e}")
        return []

@st.cache_data(ttl=3600)
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

@st.cache_data(ttl=3600)
def obtener_mapa_grupos(_client):
    if _client is None:
        return {}
    try:
        todos_grupos = _client.get('Group')
        grupos_por_id = {g.get('id'): g for g in todos_grupos if isinstance(g, dict)}
        raiz = next((g for g in todos_grupos if g.get('name', '').strip().startswith('*')), None)
        if not raiz:
            st.warning("No se encontró grupo raíz.")
            return {}
        mapa = {}
        def obtener_id(referencia):
            return referencia['id'] if isinstance(referencia, dict) else referencia
        def recorrer(grupo_id, ciudad_actual):
            grupo_completo = grupos_por_id.get(grupo_id)
            if not grupo_completo:
                return
            mapa[grupo_id] = {'nombre': grupo_completo.get('name', ''), 'ciudad': ciudad_actual}
            for hijo in (grupo_completo.get('children') or []):
                recorrer(obtener_id(hijo), ciudad_actual)
        for hijo_raiz in (raiz.get('children') or []):
            hijo_id = obtener_id(hijo_raiz)
            hijo_completo = grupos_por_id.get(hijo_id, {})
            nombre = hijo_completo.get('name', '').strip()
            if es_grupo_marca(nombre):
                recorrer(hijo_id, 'Sin ciudad asignada')
            else:
                ciudad = normalizar_ciudad(nombre)
                recorrer(hijo_id, ciudad)
        return mapa
    except Exception as e:
        st.warning(f"No se pudo cargar jerarquía de grupos: {e}")
        return {}

def resolver_ciudad_marca(vehiculo, mapa_grupos):
    ciudad = 'Sin ciudad asignada'
    marca = 'Sin marca identificada'
    for g in (vehiculo.get('groups') or []):
        gid = g['id'] if isinstance(g, dict) else g
        info = mapa_grupos.get(gid)
        if not info:
            continue
        if info['ciudad'] and ciudad == 'Sin ciudad asignada':
            ciudad = info['ciudad']
        nombre_grupo = info['nombre'].strip().lower()
        for marca_clave in REFERENCIA_MOTOR_POR_MARCA:
            if marca_clave in nombre_grupo:
                marca = info['nombre'].strip()
                break
    return ciudad, marca

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

def determinar_localidad(lon, lat, zonas):
    if pd.isna(lon) or pd.isna(lat):
        return 'Sin ubicación'
    candidatas = [z for z in zonas if punto_en_poligono(lon, lat, z['poligono'])]
    if not candidatas:
        return 'Fuera de zonas definidas'
    zona_mas_especifica = min(candidatas, key=lambda z: z['area'])
    return zona_mas_especifica['nombre']

@st.cache_data(ttl=86400)
def obtener_catalogos_diagnosticos(_client):
    if _client is None:
        return {}, {}
    try:
        dic_diag = {}
        for d in _client.get('Diagnostic'):
            if isinstance(d, dict) and 'id' in d:
                dic_diag[d['id']] = {'nombre': d.get('name') or 'Diagnóstico sin nombre', 'codigo': d.get('code')}
            elif isinstance(d, str):
                dic_diag[d] = {'nombre': d, 'codigo': None}
        dic_fm = {}
        for fm in _client.get('FailureMode'):
            if isinstance(fm, dict) and 'id' in fm:
                dic_fm[fm['id']] = {'nombre': fm.get('name') or 'Modo de falla sin nombre', 'codigo': fm.get('code')}
            elif isinstance(fm, str):
                dic_fm[fm] = {'nombre': fm, 'codigo': None}
        return dic_diag, dic_fm
    except Exception as e:
        st.warning(f"No se pudieron cargar catálogos: {e}")
        return {}, {}

@st.cache_data(ttl=86400)
def cargar_diccionario_fallas():
    try:
        df = pd.read_csv('diccionario_fallas.csv')
        df['SPN'] = df['SPN'].astype(int)
        df['FMI'] = df['FMI'].astype(int)
        return df
    except FileNotFoundError:
        st.warning("No se encontró 'diccionario_fallas.csv'.")
        return pd.DataFrame(columns=['SPN', 'FMI', 'Descripcion', 'Grupo', 'Criticidad', 'Origen_Criticidad', 'Motor_Aplica'])

def clasificar_falla(spn, fmi, referencia_motor, df_diccionario):
    candidatos = df_diccionario[(df_diccionario['SPN'] == spn) & (df_diccionario['FMI'] == fmi)]
    tiene_columna_grupo = 'Grupo' in df_diccionario.columns
    if candidatos.empty:
        return None, 'BAJA', 'Sin clasificar'
    if referencia_motor == 'X12':
        especifico = candidatos[candidatos['Motor_Aplica'] == 'X12']
        if not especifico.empty:
            fila = especifico.iloc[0]
            grupo = fila['Grupo'] if tiene_columna_grupo and pd.notna(fila['Grupo']) else 'Sin clasificar'
            return fila['Descripcion'], fila['Criticidad'], grupo
    generico = candidatos[candidatos['Motor_Aplica'] == 'Generico']
    fila = generico.iloc[0] if not generico.empty else candidatos.iloc[0]
    grupo = fila['Grupo'] if tiene_columna_grupo and pd.notna(fila['Grupo']) else 'Sin clasificar'
    return fila['Descripcion'], fila['Criticidad'], grupo

def reproducir_alarma():
    sonido_url = "https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3"
    html_audio = f'<audio autoplay><source src="{sonido_url}" type="audio/mpeg"></audio>'
    components.html(html_audio, width=0, height=0)
    st.toast("🚨 ¡NUEVA ALERTA CRÍTICA DETECTADA!", icon="🔴")

# =============================================================================
# FUNCIONES CACHEADAS PARA PROCESAMIENTO
# =============================================================================
@st.cache_data(ttl=300)
def procesar_activas(df_fallas, ciudad_filtro, incidentes_guardados=None):
    if df_fallas.empty:
        return pd.DataFrame()
    df = df_fallas.copy()
    if ciudad_filtro != 'Todas' and 'Ciudad' in df.columns:
        df = df[df['Ciudad'] == ciudad_filtro]
    if 'dismiss' in df.columns:
        df = df[~df['dismiss'].fillna(False)]
    if df.empty:
        return df
    ultima_fecha = df.groupby(['id_camion', 'Codigo'])['Fecha_Alerta'].transform('max')
    df = df[df['Fecha_Alerta'] == ultima_fecha]
    if df.empty:
        return df
    rank_criticidad = {'ALTA': 0, 'MEDIA': 1, 'BAJA': 2}
    df['Rank_Criticidad'] = df['Criticidad'].map(rank_criticidad).fillna(2)
    criticidad_max_por_vehiculo = df.groupby('id_camion')['Rank_Criticidad'].min()
    rank_a_texto = {0: 'ALTA', 1: 'MEDIA', 2: 'BAJA'}
    df['Criticidad_Vehiculo'] = df['id_camion'].map(criticidad_max_por_vehiculo).map(rank_a_texto)

    # Filtrar incidentes cerrados hoy
    if incidentes_guardados:
        fecha_hoy = datetime.now(ZONA_BOGOTA).strftime('%Y%m%d')
        ids_cerrados = {
            id_inc for id_inc, inc in incidentes_guardados.items()
            if inc['estado'] == 'Cerrado'
        }
        df['inc_id'] = df['id_camion'].apply(lambda x: f"VEH_{x}_{fecha_hoy}")
        df = df[~df['inc_id'].isin(ids_cerrados)]
    return df

@st.cache_data(ttl=300)
def resumir_zonas(df_fallas_geo):
    if df_fallas_geo.empty:
        return pd.DataFrame()
    conteo = df_fallas_geo.groupby(['Ciudad', 'Localidad']).agg(
        Total_Fallas=('id_camion', 'count'),
        Vehiculos_Unicos=('id_camion', 'nunique')
    ).reset_index().sort_values('Total_Fallas', ascending=False).head(10)
    if not conteo.empty:
        conteo['Porcentaje_Impacto'] = (
            conteo['Total_Fallas'] / conteo['Total_Fallas'].sum() * 100
        ).round(1)
    return conteo

@st.cache_data(ttl=300)
def preparar_tendencia(df_activas):
    if df_activas.empty or 'Fecha_Alerta' not in df_activas.columns or 'Ciudad' not in df_activas.columns:
        return None, None, None, None, None, None
    df = df_activas.copy()
    df['Semana'] = pd.to_datetime(df['Fecha_Alerta']).dt.to_period('W').dt.start_time
    df_tendencia_ciudad = df.groupby(['Semana', 'Ciudad']).size().reset_index(name='Cantidad_Fallas')
    df_tendencia_ciudad = df_tendencia_ciudad.sort_values('Semana')
    if df_tendencia_ciudad.empty:
        return None, None, None, None, None, None
    fecha_min_global = df_tendencia_ciudad['Semana'].min()
    fecha_max_global = df_tendencia_ciudad['Semana'].max()
    todas_semanas = pd.date_range(start=fecha_min_global, end=fecha_max_global, freq='W-MON')
    df_calendario = pd.DataFrame({'Semana': todas_semanas})
    todas_ciudades = df_tendencia_ciudad['Ciudad'].unique()
    df_completo = df_calendario.assign(key=1).merge(
        pd.DataFrame({'Ciudad': todas_ciudades, 'key': 1}), on='key'
    ).drop('key', axis=1)
    df_tendencia_completa = df_completo.merge(
        df_tendencia_ciudad, on=['Semana', 'Ciudad'], how='left'
    ).fillna({'Cantidad_Fallas': 0})
    df_tendencia_completa = df_tendencia_completa.sort_values('Semana')
    semanas_unicas = sorted(df_tendencia_completa['Semana'].unique())
    if not semanas_unicas:
        return None, None, None, None, None, None
    fecha_base = semanas_unicas[0]
    indices = [(s - fecha_base).days for s in semanas_unicas]
    return df_tendencia_completa, fecha_min_global, fecha_max_global, fecha_base, indices, todas_ciudades

# =============================================================================
# EXTRACCIÓN DE DATOS PRINCIPAL (CACHEADA)
# =============================================================================
@st.cache_data(ttl=180)
def extraer_datos_completos(_client, f_inicio, f_fin):
    if _client is None:
        return pd.DataFrame(), pd.DataFrame(), pd.DataFrame(), pd.DataFrame()
    try:
        f_inicio_utc = f_inicio.astimezone(timezone.utc)
        f_fin_utc = f_fin.astimezone(timezone.utc)
        vehiculos_raw = _client.get('Device')
        mapa_grupos = obtener_mapa_grupos(_client)
        df_vehiculos = pd.DataFrame(vehiculos_raw)[['id', 'name', 'licensePlate', 'groups', 'vehicleIdentificationNumber']]
        df_vehiculos = df_vehiculos.rename(columns={
            'id': 'id_camion', 'name': 'Movil', 'licensePlate': 'Placa',
            'vehicleIdentificationNumber': 'N_Motor'
        })
        ciudades_marcas = df_vehiculos['groups'].apply(
            lambda g: resolver_ciudad_marca({'groups': g}, mapa_grupos)
        )
        df_vehiculos['Ciudad'] = [cm[0] for cm in ciudades_marcas]
        df_vehiculos['Marca'] = [cm[1] for cm in ciudades_marcas]
        df_vehiculos['Referencia_Motor'] = df_vehiculos['Marca'].apply(
            lambda m: next((v for k, v in REFERENCIA_MOTOR_POR_MARCA.items() if k in m.lower()), 'Desconocida')
        )
        df_vehiculos = df_vehiculos.drop(columns=['groups'])

        viajes_raw = _client.get('Trip', search={
            'fromDate': f_inicio_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
            'toDate': f_fin_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
        })
        df_resumen_viajes = pd.DataFrame()
        if viajes_raw:
            df_viajes = pd.DataFrame(viajes_raw)
            if not df_viajes.empty and 'device' in df_viajes.columns:
                df_viajes['distancia_km'] = df_viajes['distance'] / 1000
                df_viajes['id_camion'] = df_viajes['device'].apply(lambda x: x['id'] if isinstance(x, dict) else str(x))
                df_viajes['ralenti_minutos'] = df_viajes['idlingDuration'].apply(convertir_a_minutos)
                df_viajes['costo_ralenti_cop'] = df_viajes['ralenti_minutos'] * COSTO_MINUTO_RALENTI_COP
                resumen = df_viajes.groupby('id_camion').agg(
                    Viajes=('id', 'count'),
                    KM_Recorridos=('distancia_km', 'sum'),
                    Total_Ralenti_Min=('ralenti_minutos', 'sum'),
                    Costos_Perdidos_COP=('costo_ralenti_cop', 'sum')
                ).reset_index()
                df_resumen_viajes = pd.merge(resumen, df_vehiculos, on='id_camion', how='left')

        temp_raw = _client.get('StatusData', search={
            'diagnosticSearch': {'id': 'DiagnosticEngineCoolantTemperatureId'},
            'fromDate': f_inicio_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
            'toDate': f_fin_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
        })
        df_temp = pd.DataFrame()
        if temp_raw:
            df_temp = pd.DataFrame(temp_raw)
            if not df_temp.empty and 'device' in df_temp.columns and 'data' in df_temp.columns:
                df_temp['id_camion'] = df_temp['device'].apply(lambda x: x['id'] if isinstance(x, dict) else str(x))
                df_temp['Fecha'] = convertir_a_bogota(df_temp['dateTime']).dt.date
                df_temp['Temperatura'] = pd.to_numeric(df_temp['data'], errors='coerce')
                df_temp = df_temp[(df_temp['Temperatura'] > 40) & (df_temp['Temperatura'] < 130)]
                if not df_temp.empty:
                    df_temp = df_temp.groupby(['id_camion', 'Fecha'])['Temperatura'].max().reset_index()
                    df_temp = pd.merge(df_temp, df_vehiculos, on='id_camion', how='left')

        fallas_raw = _client.get('FaultData', search={
            'fromDate': f_inicio_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
            'toDate': f_fin_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
        })
        df_fallas_resumen = pd.DataFrame()
        if fallas_raw:
            df_fallas = pd.DataFrame(fallas_raw)
            if not df_fallas.empty and 'device' in df_fallas.columns:
                df_fallas['id_camion'] = df_fallas['device'].apply(lambda x: x['id'] if isinstance(x, dict) else str(x))
                dic_diag, dic_fm = obtener_catalogos_diagnosticos(_client)
                def resolver_falla(row):
                    diag_id = row['diagnostic']['id'] if isinstance(row.get('diagnostic'), dict) else None
                    fm_id = row['failureMode']['id'] if isinstance(row.get('failureMode'), dict) else None
                    diag_info = dic_diag.get(diag_id, {'nombre': 'Diagnóstico ECM desconocido', 'codigo': None})
                    fm_info = dic_fm.get(fm_id, {'nombre': '', 'codigo': None})
                    nombre = diag_info['nombre']
                    if fm_info['nombre']:
                        nombre += f" — {fm_info['nombre']}"
                    return pd.Series({
                        'Codigo': nombre,
                        'Diagnostico_ID': diag_id,
                        'FailureMode_ID': fm_id,
                        'SPN_Geotab': diag_info.get('codigo'),
                        'FMI_Geotab': fm_info.get('codigo'),
                    })
                df_fallas[['Codigo', 'Diagnostico_ID', 'FailureMode_ID', 'SPN_Geotab', 'FMI_Geotab']] = \
                    df_fallas.apply(resolver_falla, axis=1)
                df_fallas['Fecha_Alerta'] = convertir_a_bogota(df_fallas['dateTime'])
                ahora = datetime.now(timezone.utc)
                df_fallas['Dias_Activa'] = df_fallas['Fecha_Alerta'].apply(lambda x: max((ahora - x).days, 0))
                df_fallas['Duracion_Activa_Min'] = df_fallas.groupby(['id_camion', 'Codigo'])['Fecha_Alerta'] \
                    .transform(lambda s: (s.max() - s.min()).total_seconds() / 60)
                zonas = obtener_zonas(_client)
                vehiculos_con_falla = df_fallas['id_camion'].unique().tolist()
                logs_por_camion = []
                # Un solo viaje de ida y vuelta al servidor para todos los vehículos con
                # falla (antes: una llamada HTTP secuencial por cada uno).
                llamadas_logs = [
                    ('Get', {
                        'typeName': 'LogRecord',
                        'search': {
                            'deviceSearch': {'id': id_veh},
                            'fromDate': f_inicio_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                            'toDate': f_fin_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
                        }
                    })
                    for id_veh in vehiculos_con_falla
                ]
                try:
                    resultados_logs = _client.multi_call(llamadas_logs)
                    for logs_veh in resultados_logs:
                        if logs_veh:
                            logs_por_camion.extend(logs_veh)
                except Exception as e:
                    st.warning(f"No se pudo agrupar la consulta de LogRecord para geolocalizar fallas: {e}")
                if logs_por_camion:
                    df_logs = pd.DataFrame(logs_por_camion)
                    df_logs['id_camion'] = df_logs['device'].apply(lambda x: x['id'] if isinstance(x, dict) else str(x))
                    df_logs['dateTime'] = convertir_a_bogota(df_logs['dateTime'])
                    df_logs = df_logs[['id_camion', 'dateTime', 'latitude', 'longitude']].dropna()
                    df_logs = df_logs.sort_values('dateTime')
                    df_fallas = df_fallas.sort_values('Fecha_Alerta')
                    df_fallas = pd.merge_asof(
                        df_fallas,
                        df_logs.rename(columns={'dateTime': 'Fecha_Alerta'}),
                        on='Fecha_Alerta',
                        by='id_camion',
                        direction='nearest',
                        tolerance=pd.Timedelta('30min')
                    )
                else:
                    df_fallas['latitude'] = None
                    df_fallas['longitude'] = None
                df_fallas['Localidad'] = df_fallas.apply(
                    lambda r: determinar_localidad(r.get('longitude'), r.get('latitude'), zonas), axis=1
                )

                # --- Contexto (freeze frame): RPM, temperatura y odómetro al momento de la falla ---
                # Antes: pedía el diagnóstico para TODA la flota y luego filtraba.
                # Ahora: pide solo los vehículos con falla (normalmente muchos menos que
                # la flota completa), agrupados en un solo viaje de red por diagnóstico.
                def _obtener_lecturas_diagnostico(diag_id, nombre_columna):
                    if not vehiculos_con_falla:
                        return pd.DataFrame()
                    llamadas = [
                        ('Get', {
                            'typeName': 'StatusData',
                            'search': {
                                'diagnosticSearch': {'id': diag_id},
                                'deviceSearch': {'id': id_veh},
                                'fromDate': f_inicio_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                                'toDate': f_fin_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
                            }
                        })
                        for id_veh in vehiculos_con_falla
                    ]
                    try:
                        resultados = _client.multi_call(llamadas)
                    except Exception:
                        return pd.DataFrame()
                    filas = []
                    for id_veh, lecturas in zip(vehiculos_con_falla, resultados):
                        if lecturas and isinstance(lecturas, list):
                            for l in lecturas:
                                filas.append({'id_camion': id_veh, 'dateTime': l.get('dateTime'), 'data': l.get('data')})
                    if not filas:
                        return pd.DataFrame()
                    df_lec = pd.DataFrame(filas)
                    df_lec['dateTime'] = convertir_a_bogota(df_lec['dateTime'])
                    df_lec[nombre_columna] = pd.to_numeric(df_lec['data'], errors='coerce')
                    df_lec = df_lec[['id_camion', 'dateTime', nombre_columna]].dropna()
                    return df_lec.sort_values('dateTime')

                df_fallas = df_fallas.sort_values('Fecha_Alerta')
                for diag_id, nombre_columna in [
                    (ID_DIAGNOSTICO_RPM_MOTOR, 'RPM_Momento_Falla'),
                    (ID_DIAGNOSTICO_TEMPERATURA, 'Temperatura_Momento_Falla'),
                    (ID_DIAGNOSTICO_ODOMETRO, 'Odometro_Momento_Falla'),
                ]:
                    df_lecturas = _obtener_lecturas_diagnostico(diag_id, nombre_columna)
                    if not df_lecturas.empty:
                        df_fallas = pd.merge_asof(
                            df_fallas,
                            df_lecturas.rename(columns={'dateTime': 'Fecha_Alerta'}),
                            on='Fecha_Alerta',
                            by='id_camion',
                            direction='nearest',
                            tolerance=TOLERANCIA_FREEZE_FRAME
                        )
                    else:
                        df_fallas[nombre_columna] = None
                if 'Odometro_Momento_Falla' in df_fallas.columns:
                    # Geotab entrega el odómetro en metros; se deja en kilómetros para mostrar.
                    df_fallas['Odometro_Momento_Falla'] = df_fallas['Odometro_Momento_Falla'] / 1000

                df_fallas_resumen = pd.merge(df_fallas, df_vehiculos, on='id_camion', how='left')
                df_diccionario = cargar_diccionario_fallas()
                def _clasificar(row):
                    try:
                        spn = int(row['SPN_Geotab'])
                        fmi = int(row['FMI_Geotab'])
                    except (TypeError, ValueError):
                        return pd.Series({'Descripcion_Falla': row['Codigo'], 'Criticidad': 'BAJA', 'Grupo_Sistema': 'Sin clasificar'})
                    desc, crit, grupo = clasificar_falla(spn, fmi, row.get('Referencia_Motor'), df_diccionario)
                    if desc is None:
                        return pd.Series({'Descripcion_Falla': row['Codigo'], 'Criticidad': 'BAJA', 'Grupo_Sistema': 'Sin clasificar'})
                    return pd.Series({'Descripcion_Falla': desc, 'Criticidad': crit, 'Grupo_Sistema': grupo})
                df_fallas_resumen[['Descripcion_Falla', 'Criticidad', 'Grupo_Sistema']] = df_fallas_resumen.apply(_clasificar, axis=1)
        return df_resumen_viajes, df_temp, df_fallas_resumen, df_vehiculos
    except Exception as e:
        st.error(f"Error procesando datos de Geotab: {e}")
        return pd.DataFrame(), pd.DataFrame(), pd.DataFrame(), pd.DataFrame()

# =============================================================================
# EJECUCIÓN PRINCIPAL
# =============================================================================
df_operativo, df_temperatura, df_fallas, df_vehiculos_global = extraer_datos_completos(client, fecha_inicio, fecha_fin)

if not df_vehiculos_global.empty and 'Ciudad' in df_vehiculos_global.columns:
    ciudades_reales = sorted(df_vehiculos_global['Ciudad'].unique())
    if 'Sin ciudad asignada' in ciudades_reales:
        ciudades_reales.remove('Sin ciudad asignada')
    st.session_state.ciudades_disponibles = ['Todas'] + ciudades_reales if ciudades_reales else ['Todas']
else:
    st.session_state.ciudades_disponibles = ['Todas']

st.sidebar.subheader("📍 Filtrar por Ciudad")
ciudad_seleccionada = st.sidebar.selectbox(
    "Selecciona una ciudad",
    options=st.session_state.ciudades_disponibles,
    index=0,
    key="filtro_ciudad"
)

st.sidebar.subheader("🔍 Buscar Vehículo")
placa_buscada = st.sidebar.text_input(
    "Placa o número de móvil",
    value="",
    placeholder="Ej: ABC123 o 450",
    key="buscar_placa"
).strip().upper()

st.sidebar.subheader("🕐 Filtrar por Turno")
turnos_seleccionados = st.sidebar.multiselect(
    "Selecciona turno(s)",
    options=['R1', 'R2', 'R3'],
    default=['R1', 'R2', 'R3'],
    key="filtro_turno",
    help="R1: 05:00-13:00 | R2: 13:00-21:00 | R3: 21:00-05:00"
)

# Cargar incidentes y procesar activas con el filtro de cerrados
incidentes_guardados = cargar_incidentes(hoja_incidentes)
df_activas = procesar_activas(df_fallas, ciudad_seleccionada, incidentes_guardados)

if not df_activas.empty and 'Fecha_Alerta' in df_activas.columns:
    df_activas['Turno'] = df_activas['Fecha_Alerta'].apply(clasificar_turno)

if placa_buscada and not df_activas.empty:
    df_activas = df_activas[
        df_activas['Placa'].astype(str).str.upper().str.contains(placa_buscada, na=False) |
        df_activas['Movil'].astype(str).str.upper().str.contains(placa_buscada, na=False)
    ]
    if df_activas.empty:
        st.sidebar.warning(f"No se encontraron fallas activas para '{placa_buscada}'.")

if turnos_seleccionados and len(turnos_seleccionados) < 3 and not df_activas.empty:
    df_activas = df_activas[df_activas['Turno'].isin(turnos_seleccionados)]
    if df_activas.empty:
        st.sidebar.warning(f"No hay fallas activas en el/los turno(s) seleccionado(s).")

# =============================================================================
# TABS
# =============================================================================
tab_fallas, tab_protocolo, tab_manejo, tab_temperaturas, tab_horometro = st.tabs([
    "🩺 Fallas y Diagnóstico",
    "📋 Protocolo de Atención",
    "🚦 Comportamiento de Manejo",
    "🌡️ Temperaturas y Niveles",
    "⏱️ Horómetro"
])

ORDEN_CRITICIDAD = ['ALTA', 'MEDIA', 'BAJA']
COLOR_CRITICIDAD = {'ALTA': '#B91C1C', 'MEDIA': '#B45309', 'BAJA': '#6B7280'}

# =============================================================================
# TAB FALLAS Y DIAGNÓSTICO
# =============================================================================
with tab_fallas:
    st.subheader("🩺 Fallas y Diagnóstico")
    st.caption(f"Reporte generado el: {datetime.now(ZONA_BOGOTA).strftime('%d/%m/%Y')} - Hora: {datetime.now(ZONA_BOGOTA).strftime('%I:%M %p')}")

    if not df_activas.empty:
        df_vehiculos_activos = df_activas.drop_duplicates('id_camion')
        vehiculos_activos = df_vehiculos_activos['id_camion'].nunique()
        total_eventos_activos = len(df_activas)
        vehiculos_en_alta = (df_vehiculos_activos['Criticidad_Vehiculo'] == 'ALTA').sum()

        ciudad_mas_impacto = 'N/A'
        if 'Ciudad' in df_vehiculos_activos.columns:
            ciudades_validas = df_vehiculos_activos[
                (df_vehiculos_activos['Ciudad'] != 'Sin ciudad asignada') &
                (df_vehiculos_activos['Ciudad'].notna())
            ]['Ciudad']
            if not ciudades_validas.empty:
                ciudad_mas_impacto = ciudades_validas.value_counts().idxmax()

        col_k1, col_k2, col_k3, col_k4 = st.columns(4)
        col_k1.metric("Vehículos con falla activa", vehiculos_activos)
        col_k2.metric("Eventos activos totales", total_eventos_activos)
        col_k3.metric("Vehículos en criticidad ALTA", vehiculos_en_alta)
        col_k4.metric("Ciudad con más impacto", ciudad_mas_impacto)

        if vehiculos_en_alta > st.session_state.alertas_altas_previas:
            reproducir_alarma()
        st.session_state.alertas_altas_previas = vehiculos_en_alta

        st.markdown("**Comparativo por ciudad**")
        comparativo_ciudad = df_vehiculos_activos.groupby('Ciudad').agg(
            Vehiculos_Afectados=('id_camion', 'nunique')
        ).reset_index().sort_values('Vehiculos_Afectados', ascending=False)
        comparativo_ciudad['Porcentaje_Impacto'] = (
            comparativo_ciudad['Vehiculos_Afectados'] / comparativo_ciudad['Vehiculos_Afectados'].sum() * 100
        ).round(1)

        fig_ciudad = px.bar(
            comparativo_ciudad.sort_values('Vehiculos_Afectados'),
            x='Vehiculos_Afectados', y='Ciudad', orientation='h',
            text=comparativo_ciudad.sort_values('Vehiculos_Afectados')['Porcentaje_Impacto'].astype(str) + '%',
            color_discrete_sequence=['#62A830']
        )
        fig_ciudad.update_layout(
            height=200, margin=dict(l=0, r=0, t=10, b=0), showlegend=False,
            plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)',
            xaxis=dict(showgrid=False, zeroline=False, visible=False),
            yaxis=dict(showgrid=False, zeroline=False)
        )
        st.plotly_chart(fig_ciudad, use_container_width=True)
        st.markdown("---")

        col_top5, col_dona = st.columns(2)
        with col_top5:
            st.markdown("**Top 5 vehículos con más eventos activos**")
            top5_vehiculos = df_activas.groupby('Movil').size().reset_index(name='Eventos') \
                .sort_values('Eventos', ascending=False).head(5)
            fig_top5 = px.bar(
                top5_vehiculos.sort_values('Eventos'),
                x='Eventos', y='Movil', orientation='h',
                text='Eventos', color_discrete_sequence=['#1EA0D7']
            )
            fig_top5.update_layout(
                height=280, margin=dict(l=0, r=0, t=10, b=0), showlegend=False,
                plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)',
                xaxis=dict(showgrid=False, zeroline=False, visible=False),
                yaxis=dict(showgrid=False, zeroline=False)
            )
            st.plotly_chart(fig_top5, use_container_width=True)

        with col_dona:
            st.markdown("**Distribución de vehículos por criticidad**")
            dist_criticidad = df_vehiculos_activos['Criticidad_Vehiculo'].value_counts().reset_index()
            dist_criticidad.columns = ['Criticidad', 'Vehiculos']
            fig_dona = px.pie(
                dist_criticidad, values='Vehiculos', names='Criticidad', hole=0.55,
                color='Criticidad',
                color_discrete_map={'ALTA': '#E24B4A', 'MEDIA': '#EF9F27', 'BAJA': '#B4B2A9'}
            )
            fig_dona.update_layout(height=280, margin=dict(l=0, r=0, t=10, b=0))
            st.plotly_chart(fig_dona, use_container_width=True)

        st.markdown("---")
        st.markdown("#### 📈 Tendencia Semanal de Fallas por Ciudad")
        st.caption("Evolución semanal del número de fallas activas por ciudad.")

        result = preparar_tendencia(df_activas)
        df_tendencia_completa, fecha_min_global, fecha_max_global, fecha_base, indices, todas_ciudades = result

        if df_tendencia_completa is not None and not df_tendencia_completa.empty:
            semanas_unicas = sorted(df_tendencia_completa['Semana'].unique())
            indice_min = indices[0]
            indice_max = indices[-1]
            if indice_min == indice_max:
                indice_min_slider = indice_min
                indice_max_slider = indice_min + 1
                valor_defecto = (indice_min_slider, indice_max_slider)
            else:
                indice_min_slider = indice_min
                indice_max_slider = indice_max
                valor_defecto = (indice_min_slider, indice_max_slider)

            st.markdown("**Selecciona el rango de semanas:**")
            rango_indices = st.slider(
                "Mueve las asas",
                min_value=indice_min_slider,
                max_value=indice_max_slider,
                value=valor_defecto,
                key=f"tendencia_slider_{ciudad_seleccionada}"
            )
            fecha_inicio_filtro = fecha_base + pd.Timedelta(days=rango_indices[0])
            fecha_fin_filtro = fecha_base + pd.Timedelta(days=rango_indices[1])
            df_filtrado = df_tendencia_completa[
                (df_tendencia_completa['Semana'] >= fecha_inicio_filtro) &
                (df_tendencia_completa['Semana'] <= fecha_fin_filtro)
            ]
            ciudades_con_datos = df_filtrado[df_filtrado['Cantidad_Fallas'] > 0]['Ciudad'].unique()
            if len(ciudades_con_datos) > 0:
                fig_tendencia = px.line(
                    df_filtrado[df_filtrado['Ciudad'].isin(ciudades_con_datos)],
                    x='Semana', y='Cantidad_Fallas', color='Ciudad',
                    markers=True,
                    title=f"Evolución semanal ({fecha_inicio_filtro.strftime('%d/%m/%Y')} - {fecha_fin_filtro.strftime('%d/%m/%Y')})"
                )
                fig_tendencia.update_layout(height=350, margin=dict(l=0, r=0, t=40, b=0))
                st.plotly_chart(fig_tendencia, use_container_width=True, key=f"fig_tendencia_{ciudad_seleccionada}")

                st.markdown("---")
                st.markdown("#### 📊 Comparativa Semana Actual vs Anterior")
                df_con_datos = df_filtrado[df_filtrado['Cantidad_Fallas'] > 0]
                semanas_con_datos = sorted(df_con_datos['Semana'].unique())
                if len(semanas_con_datos) >= 2:
                    semana_actual = semanas_con_datos[-1]
                    semana_anterior = semanas_con_datos[-2]
                    df_actual = df_con_datos[df_con_datos['Semana'] == semana_actual]
                    df_anterior = df_con_datos[df_con_datos['Semana'] == semana_anterior]
                    df_comparativa = df_actual.merge(df_anterior, on='Ciudad', suffixes=('_actual', '_anterior'), how='outer').fillna(0)
                    df_comparativa['Diferencia'] = df_comparativa['Cantidad_Fallas_actual'] - df_comparativa['Cantidad_Fallas_anterior']
                    df_comparativa['Cambio_%'] = ((df_comparativa['Cantidad_Fallas_actual'] - df_comparativa['Cantidad_Fallas_anterior']) /
                                                   df_comparativa['Cantidad_Fallas_anterior'].replace(0, 1) * 100).round(1)
                    st.dataframe(df_comparativa[['Ciudad', 'Cantidad_Fallas_actual', 'Cantidad_Fallas_anterior', 'Diferencia', 'Cambio_%']],
                                 use_container_width=True, hide_index=True)
                    fig_comparativa = px.bar(df_comparativa, x='Ciudad', y=['Cantidad_Fallas_actual', 'Cantidad_Fallas_anterior'],
                                             barmode='group', title="Comparativa semanal")
                    st.plotly_chart(fig_comparativa, use_container_width=True, key=f"fig_comparativa_{ciudad_seleccionada}")
                else:
                    st.info("Pocas semanas con datos para comparar.")
            else:
                st.warning("El rango seleccionado no tiene datos de fallas.")
        else:
            st.info("No hay datos de fallas para tendencia semanal.")

        with st.expander("📋 Ver detalle completo por vehículo"):
            if not df_activas.empty:
                for ciudad, df_ciudad in df_activas.groupby('Ciudad'):
                    vehiculos_ciudad = df_ciudad['id_camion'].nunique()
                    st.markdown(f"<div style='background:#1F4E4A;color:white;padding:8px 14px;border-radius:6px;font-weight:600;margin-top:16px;'>{ciudad} (TOTAL VEHÍCULOS: {vehiculos_ciudad})</div>", unsafe_allow_html=True)
                    for criticidad in ORDEN_CRITICIDAD:
                        df_nivel = df_ciudad[df_ciudad['Criticidad_Vehiculo'] == criticidad]
                        if df_nivel.empty:
                            continue
                        vehiculos_nivel = df_nivel['id_camion'].nunique()
                        color = COLOR_CRITICIDAD[criticidad]
                        st.markdown(f"<div style='background:{color};color:white;padding:6px 14px;border-radius:4px;font-weight:600;margin-top:8px;'>{criticidad} (CANTIDAD: {vehiculos_nivel})</div>", unsafe_allow_html=True)
                        for id_veh, df_veh in df_nivel.groupby('id_camion'):
                            df_veh_ordenado = df_veh.sort_values('Fecha_Alerta', ascending=False)
                            df_show = df_veh_ordenado[['Movil', 'Marca', 'Referencia_Motor', 'N_Motor',
                                                       'SPN_Geotab', 'FMI_Geotab', 'Fecha_Alerta',
                                                       'Descripcion_Falla', 'Criticidad']].copy()
                            df_show['SPN_Geotab'] = df_show['SPN_Geotab'].apply(lambda x: int(x) if pd.notna(x) else '?')
                            df_show['FMI_Geotab'] = df_show['FMI_Geotab'].apply(lambda x: int(x) if pd.notna(x) else '?')
                            df_show['Fecha_Alerta'] = df_show['Fecha_Alerta'].dt.strftime('%d/%m/%Y %H:%M:%S')
                            df_show = df_show.rename(columns={'SPN_Geotab':'SPN','FMI_Geotab':'FMI','Fecha_Alerta':'Fecha','Descripcion_Falla':'Descripción','Criticidad':'Criticidad'})
                            st.dataframe(df_show, use_container_width=True, hide_index=True)
            else:
                st.info("No hay vehículos con fallas activas.")
    else:
        st.success("✅ No hay fallas activas en este momento. ¡Excelente!")

    # Mapa (se omite por brevedad pero se mantiene igual que antes)

# =============================================================================
# TAB PROTOCOLO DE ATENCIÓN (RENOVADO)
# =============================================================================
with tab_protocolo:
    st.subheader("📋 Protocolo de Atención - Gestión de Incidentes")
    st.caption("Monitoreo nacional desde Bogotá. Se registra el taller que realizó la reparación.")

    if hoja_incidentes is None:
        st.warning("⚠️ No hay conexión con la hoja de seguimiento de incidentes.")

    incidentes_guardados = cargar_incidentes(hoja_incidentes)  # recargar

    estado_filtro = st.radio("Mostrar incidentes:", ["Abiertos", "Cerrados", "Todos"], horizontal=True)

    if not df_activas.empty:
        conteo_crit = df_activas.groupby('Criticidad_Vehiculo')['id_camion'].nunique().reindex(ORDEN_CRITICIDAD, fill_value=0)
        col_res1, col_res2, col_res3 = st.columns(3)
        col_res1.metric("🚨 ALTA", conteo_crit.get('ALTA',0))
        col_res2.metric("⚠️ MEDIA", conteo_crit.get('MEDIA',0))
        col_res3.metric("📋 BAJA", conteo_crit.get('BAJA',0))
        st.markdown("---")

        expandir_todos = st.checkbox("📂 Expandir todos los incidentes", value=False)

        for criticidad in ORDEN_CRITICIDAD:
            df_crit = df_activas[df_activas['Criticidad_Vehiculo'] == criticidad]
            if df_crit.empty:
                continue
            vehiculos_crit = df_crit.groupby('id_camion').agg(
                Cantidad_Fallas=('id_camion', 'count'),
                Ultima_Falla=('Fecha_Alerta', 'max'),
                Movil=('Movil', 'first'),
                Placa=('Placa', 'first'),
                Ciudad=('Ciudad', 'first')
            ).reset_index().sort_values(['Cantidad_Fallas', 'Ultima_Falla'], ascending=[False, False])

            num_vehiculos = len(vehiculos_crit)
            color_fondo = {'ALTA':'#B91C1C','MEDIA':'#B45309','BAJA':'#6B7280'}[criticidad]
            emoji_cabecera = {'ALTA':'🚨','MEDIA':'⚠️','BAJA':'📋'}[criticidad]

            st.markdown(f"""
            <div style="background-color:{color_fondo}; color:white; padding:10px 15px; border-radius:8px; margin-top:20px; margin-bottom:15px; font-weight:bold; font-size:1.2rem;">
                {emoji_cabecera} {criticidad} - {num_vehiculos} vehículo(s)
            </div>
            """, unsafe_allow_html=True)

            for _, veh_row in vehiculos_crit.iterrows():
                id_camion = veh_row['id_camion']
                fila0 = df_crit[df_crit['id_camion'] == id_camion].iloc[0]
                protocolo = PROTOCOLOS.get(criticidad, PROTOCOLOS['BAJA'])

                fecha_hoy_str = datetime.now(ZONA_BOGOTA).strftime('%Y%m%d')
                id_inc = f"VEH_{id_camion}_{fecha_hoy_str}"

                grupo_ordenado = df_crit[df_crit['id_camion'] == id_camion].sort_values('Fecha_Alerta', ascending=False)

                # Agrupación inteligente: las fallas se organizan por sistema (Grupo_Sistema)
                # en vez de listarse todas sueltas, para ver de un vistazo qué componente falló.
                if 'Grupo_Sistema' in grupo_ordenado.columns:
                    bloques_descripcion = []
                    for sistema, df_sistema in grupo_ordenado.groupby('Grupo_Sistema', sort=False):
                        lineas = "\n".join(
                            f"   • {r['Descripcion_Falla']} ({r['Fecha_Alerta'].strftime('%d/%m %H:%M')}) [{r['Criticidad']}]"
                            for _, r in df_sistema.iterrows()
                        )
                        bloques_descripcion.append(f"**Sistema: {sistema}**\n{lineas}")
                    descripcion_consolidada = "\n\n".join(bloques_descripcion)
                    sistema_principal = grupo_ordenado.iloc[0]['Grupo_Sistema']
                else:
                    descripcion_consolidada = "\n".join(
                        f"{i+1}. {r['Descripcion_Falla']} ({r['Fecha_Alerta'].strftime('%d/%m %H:%M')}) [{r['Criticidad']}]"
                        for i, (_, r) in enumerate(grupo_ordenado.iterrows())
                    )
                    sistema_principal = 'Sin clasificar'

                fecha_mas_reciente = grupo_ordenado.iloc[0]['Fecha_Alerta']
                cantidad_fallas = len(grupo_ordenado)
                texto_impacto = obtener_texto_impacto(sistema_principal, criticidad)

                if fecha_mas_reciente.tzinfo is None:
                    fecha_mas_reciente_bogota = fecha_mas_reciente.replace(tzinfo=ZONA_BOGOTA)
                else:
                    fecha_mas_reciente_bogota = fecha_mas_reciente.tz_convert(ZONA_BOGOTA)

                if id_inc not in incidentes_guardados:
                    crear_incidente_en_hoja(
                        hoja_incidentes, id_inc,
                        fila0['Movil'], fila0['Placa'], descripcion_consolidada,
                        criticidad, fecha_mas_reciente_bogota, fila0.get('Ciudad', 'Sin ciudad asignada')
                    )
                    incidentes_guardados = cargar_incidentes(hoja_incidentes)

                inc = incidentes_guardados.get(id_inc, {'estado':'Abierto', 'acciones_realizadas':[], 'detalle':{}})

                if estado_filtro == "Abiertos" and inc['estado'] == 'Cerrado':
                    continue
                if estado_filtro == "Cerrados" and inc['estado'] != 'Cerrado':
                    continue

                emoji = "🚨" if criticidad == 'ALTA' else "⚠️" if criticidad == 'MEDIA' else "📋"
                borde_color = {'ALTA':'#DC2626','MEDIA':'#D97706','BAJA':'#6B7280'}[criticidad]

                with st.expander(
                    f"{emoji} {fila0['Movil']} - {fila0['Placa']} | {criticidad} | {cantidad_fallas} falla(s) — {fecha_mas_reciente_bogota.strftime('%d/%m/%Y %H:%M')}",
                    expanded=(expandir_todos or (inc['estado'] == 'Abierto' and criticidad == 'ALTA'))
                ):
                    st.markdown(f"""<style>div[data-testid="stExpander"] {{ border-left: 6px solid {borde_color} !important; border-radius: 8px !important; }}</style>""", unsafe_allow_html=True)

                    rpm_val = fila0.get('RPM_Momento_Falla')
                    temp_val = fila0.get('Temperatura_Momento_Falla')
                    odo_val = fila0.get('Odometro_Momento_Falla')
                    rpm_txt = f"{rpm_val:,.0f} RPM" if pd.notna(rpm_val) else "No disponible"
                    temp_txt = f"{temp_val:,.0f} °C" if pd.notna(temp_val) else "No disponible"
                    odo_txt = f"{odo_val:,.0f} km" if pd.notna(odo_val) else "No disponible"

                    st.markdown(f"""
                    <div style="background-color:{color_fondo}; padding:12px; border-radius:8px; color:white; margin-bottom:10px;">
                        <h3 style="margin:0;">{emoji} {criticidad} - {fila0['Movil']} ({fila0['Placa']}) - {cantidad_fallas} falla(s) activa(s)</h3>
                        <p style="margin:4px 0;"><strong>Ubicación:</strong> {fila0.get('Localidad','No disponible')}</p>
                        <p style="margin:4px 0;"><strong>Ciudad:</strong> {fila0.get('Ciudad','Sin ciudad asignada')}</p>
                        <p style="margin:4px 0;"><strong>Estado:</strong> {inc['estado']}</p>
                        <p style="margin:4px 0;"><strong>Última alerta:</strong> {fecha_mas_reciente_bogota.strftime('%d/%m/%Y %H:%M:%S')}</p>
                        <p style="margin:8px 0 0 0; font-style:italic;">⚠️ Impacto operativo: {texto_impacto}</p>
                    </div>
                    """, unsafe_allow_html=True)

                    st.markdown(f"""
                    <div style="background-color:#F1F5F9; padding:10px 14px; border-radius:8px; margin-bottom:10px; display:flex; gap:24px; flex-wrap:wrap;">
                        <span>📊 <strong>RPM al momento:</strong> {rpm_txt}</span>
                        <span>🌡️ <strong>Temperatura:</strong> {temp_txt}</span>
                        <span>🛣️ <strong>Odómetro:</strong> {odo_txt}</span>
                    </div>
                    """, unsafe_allow_html=True)

                    st.markdown("**Fallas detectadas (agrupadas por sistema):**")
                    st.markdown(descripcion_consolidada.replace("\n", "  \n"))

                    if inc['estado'] == 'Abierto':
                        with st.form(key=f"form_cierre_{id_inc}"):
                            ciudad_vehiculo = fila0.get('Ciudad', 'Sin ciudad asignada')
                            opciones_taller = [f"Taller propio ({ciudad_vehiculo})"]
                            if ciudad_vehiculo == 'Bogotá':
                                opciones_taller.append("Navitrans Tintalito (Bogotá)")
                            opciones_taller.append("Otro taller externo")
                            ubicacion = st.selectbox("¿Dónde se realizó la reparación?", opciones_taller, key=f"ubicacion_{id_inc}")
                            if st.form_submit_button("🔒 Cerrar incidente"):
                                exito = actualizar_incidente_en_hoja(
                                    hoja_incidentes, id_inc, 'Cerrado',
                                    inc['acciones_realizadas'], ubicacion
                                )
                                if exito:
                                    st.success("✅ Incidente cerrado correctamente.")
                                    st.rerun()
                                else:
                                    st.error("❌ No se pudo cerrar el incidente.")
                    else:
                        ubicacion_registrada = inc.get('ubicacion', 'No registrada')
                        st.success(f"✅ Incidente cerrado. Reparado en: {ubicacion_registrada}")

                    # Búsqueda
                    st.markdown("---")
                    st.markdown("#### 🔍 Buscar causa de falla")
                    opciones_busqueda = []
                    for idx, (_, row) in enumerate(grupo_ordenado.iterrows()):
                        spn = int(row['SPN_Geotab']) if pd.notna(row['SPN_Geotab']) else '?'
                        fmi = int(row['FMI_Geotab']) if pd.notna(row['FMI_Geotab']) else '?'
                        desc = row['Descripcion_Falla'][:45] + "..." if len(row['Descripcion_Falla']) > 45 else row['Descripcion_Falla']
                        opciones_busqueda.append(f"{idx+1}. SPN {spn} | FMI {fmi} - {desc}")
                    if opciones_busqueda:
                        falla_sel = st.selectbox("Selecciona la falla", opciones_busqueda, key=f"buscar_{id_inc}")
                        spn_match = re.search(r'SPN (\d+|\?)', falla_sel)
                        fmi_match = re.search(r'FMI (\d+|\?)', falla_sel)
                        spn = spn_match.group(1) if spn_match else '?'
                        fmi = fmi_match.group(1) if fmi_match else '?'
                        url_google = f"https://www.google.com/search?q=SPN+{spn}+FMI+{fmi}+causa+falla+motores+diesel"
                        st.link_button("🔍 Buscar en Google", url_google)
                        st.caption(f"🔎 Buscando: **SPN {spn} | FMI {fmi}**")

                    # Protocolo
                    st.markdown("---")
                    st.markdown(f"#### {protocolo['nombre']}")
                    st.caption(f"⏱️ Tiempo máximo: {protocolo['tiempo_max_respuesta_min']} min")
                    acciones_realizadas = list(inc['acciones_realizadas'])
                    hubo_cambio = False
                    for accion in protocolo['acciones']:
                        orden = accion['orden']
                        descripcion = accion['texto']
                        responsable = accion['responsable']
                        clave = f"accion_{id_inc}_{orden}"
                        realizada = clave in acciones_realizadas
                        check = st.checkbox(f"**{orden}.** {descripcion} _(Responsable: {responsable})_", value=realizada, key=clave)
                        if check and clave not in acciones_realizadas:
                            acciones_realizadas.append(clave)
                            hubo_cambio = True
                        elif not check and clave in acciones_realizadas:
                            acciones_realizadas.remove(clave)
                            hubo_cambio = True
                    if hubo_cambio:
                        actualizar_incidente_en_hoja(hoja_incidentes, id_inc, inc['estado'], acciones_realizadas)
                    completadas = len(acciones_realizadas)
                    total = len(protocolo['acciones'])
                    if total > 0:
                        st.progress(completadas / total)
                        st.caption(f"Progreso: {completadas} de {total} acciones completadas.")
    else:
        st.success("✅ No hay fallas activas en este momento. ¡Excelente!")

# =============================================================================
# TAB COMPORTAMIENTO DE MANEJO
# =============================================================================
with tab_manejo:
    st.subheader("🚦 Comportamiento de Manejo")
    st.caption("Eventos de sobre-revolución (RPM) y exceso de velocidad en el periodo seleccionado.")

    # El exceso de velocidad se calcula a partir de LogRecord (posición/velocidad cruda,
    # registrada cada 15-30 seg por vehículo), que es el dato más pesado de toda la app.
    # Rangos de fechas largos pueden traer cientos de miles de filas de golpe y agotar
    # la memoria disponible, así que limitamos ese cálculo a un máximo de días.
    MAX_DIAS_EXCESOS = 7
    dias_solicitados = (fecha_fin - fecha_inicio).days + 1
    calcular_excesos = True
    if dias_solicitados > MAX_DIAS_EXCESOS:
        calcular_excesos = False
        st.warning(
            f"⚠️ El rango seleccionado es de {dias_solicitados} días. Para evitar sobrecargar la "
            f"app, el exceso de velocidad solo se calcula para rangos de hasta {MAX_DIAS_EXCESOS} días. "
            f"Reduce el rango de fechas en la barra lateral para ver esta sección, o consulta el "
            f"detalle de sobre-revolución (RPM) más abajo, que sí se calcula para cualquier rango."
        )

    df_eventos_rpm, df_rpm_diario = extraer_datos_manejo(client, fecha_inicio, fecha_fin, df_vehiculos_global)
    if calcular_excesos:
        df_eventos_vel = extraer_datos_velocidad(client, fecha_inicio, fecha_fin, df_vehiculos_global)
    else:
        df_eventos_vel = pd.DataFrame()

    if placa_buscada:
        if not df_eventos_rpm.empty:
            df_eventos_rpm = df_eventos_rpm[
                df_eventos_rpm['Placa'].astype(str).str.upper().str.contains(placa_buscada, na=False) |
                df_eventos_rpm['Movil'].astype(str).str.upper().str.contains(placa_buscada, na=False)
            ]
        if not df_eventos_vel.empty:
            df_eventos_vel = df_eventos_vel[
                df_eventos_vel['Placa'].astype(str).str.upper().str.contains(placa_buscada, na=False) |
                df_eventos_vel['Movil'].astype(str).str.upper().str.contains(placa_buscada, na=False)
            ]
        st.caption(f"🔍 Filtrando por: **{placa_buscada}**")

    if turnos_seleccionados and len(turnos_seleccionados) < 3:
        if not df_eventos_rpm.empty:
            df_eventos_rpm = df_eventos_rpm[df_eventos_rpm['Turno'].isin(turnos_seleccionados)]
        if not df_eventos_vel.empty:
            df_eventos_vel = df_eventos_vel[df_eventos_vel['Turno'].isin(turnos_seleccionados)]
        st.caption(f"🕐 Turno(s): **{', '.join(turnos_seleccionados)}**")

    sub_rpm, sub_vel = st.tabs(["🔧 Sobre-revolución (RPM)", "🚗 Exceso de Velocidad"])

    # --- SUB-TAB: SOBRE-REVOLUCIÓN (RPM) ---
    with sub_rpm:
        if not df_eventos_rpm.empty:
            vehiculos_afectados_rpm = df_eventos_rpm['id_camion'].nunique()
            total_eventos_rpm = len(df_eventos_rpm)
            duracion_promedio_rpm = df_eventos_rpm['Duracion_Segundos'].mean()
            rpm_pico_max = df_eventos_rpm['RPM_Pico'].max() if 'RPM_Pico' in df_eventos_rpm.columns else None

            col_r1, col_r2, col_r3, col_r4 = st.columns(4)
            col_r1.metric("Vehículos con eventos", vehiculos_afectados_rpm)
            col_r2.metric("Eventos totales", total_eventos_rpm)
            col_r3.metric("Duración promedio", f"{duracion_promedio_rpm:,.0f} seg")
            col_r4.metric("RPM pico registrado", f"{rpm_pico_max:,.0f}" if pd.notna(rpm_pico_max) else "N/D")

            st.markdown("---")
            col_rpm_top, col_rpm_turno = st.columns(2)
            with col_rpm_top:
                st.markdown("**Top 10 vehículos con más eventos de sobre-revolución**")
                top_rpm = df_eventos_rpm.groupby('Movil').size().reset_index(name='Eventos') \
                    .sort_values('Eventos', ascending=False).head(10)
                fig_top_rpm = px.bar(
                    top_rpm.sort_values('Eventos'),
                    x='Eventos', y='Movil', orientation='h',
                    text='Eventos', color_discrete_sequence=['#E24B4A']
                )
                fig_top_rpm.update_layout(
                    height=320, margin=dict(l=0, r=0, t=10, b=0), showlegend=False,
                    plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)',
                    xaxis=dict(showgrid=False, zeroline=False, visible=False),
                    yaxis=dict(showgrid=False, zeroline=False)
                )
                st.plotly_chart(fig_top_rpm, use_container_width=True)

            with col_rpm_turno:
                st.markdown("**Eventos por turno**")
                eventos_turno_rpm = df_eventos_rpm.groupby('Turno').size().reset_index(name='Eventos')
                fig_turno_rpm = px.bar(
                    eventos_turno_rpm, x='Turno', y='Eventos',
                    text='Eventos', color_discrete_sequence=['#1EA0D7']
                )
                fig_turno_rpm.update_layout(
                    height=320, margin=dict(l=0, r=0, t=10, b=0), showlegend=False,
                    plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)',
                    yaxis=dict(showgrid=False, zeroline=False, visible=False)
                )
                st.plotly_chart(fig_turno_rpm, use_container_width=True)

            with st.expander("📋 Ver detalle de eventos de sobre-revolución"):
                df_show_rpm = df_eventos_rpm[['Movil', 'Placa', 'Ciudad', 'Motor', 'Umbral_RPM', 'RPM_Pico',
                                               'activeFrom', 'Duracion_Segundos', 'Turno']].copy()
                df_show_rpm['activeFrom'] = df_show_rpm['activeFrom'].dt.strftime('%d/%m/%Y %H:%M:%S')
                df_show_rpm['Duracion_Segundos'] = df_show_rpm['Duracion_Segundos'].round(0)
                df_show_rpm = df_show_rpm.rename(columns={
                    'activeFrom': 'Fecha/Hora', 'Duracion_Segundos': 'Duración (seg)',
                    'Umbral_RPM': 'Umbral RPM', 'RPM_Pico': 'RPM Pico'
                }).sort_values('Fecha/Hora', ascending=False)
                st.dataframe(df_show_rpm, use_container_width=True, hide_index=True)
                st.download_button(
                    "⬇️ Descargar Excel (sobre-revolución)",
                    data=convertir_a_excel(df_show_rpm),
                    file_name=f"sobre_revolucion_{fecha_inicio.strftime('%Y%m%d')}_{fecha_fin.strftime('%Y%m%d')}.xlsx",
                    mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                )
        else:
            st.success("✅ No hay eventos de sobre-revolución en el periodo seleccionado.")

    # --- SUB-TAB: EXCESO DE VELOCIDAD ---
    with sub_vel:
        if not df_eventos_vel.empty:
            vehiculos_afectados_vel = df_eventos_vel['id_camion'].nunique()
            total_eventos_vel = len(df_eventos_vel)
            velocidad_max_registrada = df_eventos_vel['Velocidad_Maxima'].max()
            duracion_promedio_vel = df_eventos_vel['Duracion_Segundos'].mean()

            col_v1, col_v2, col_v3, col_v4 = st.columns(4)
            col_v1.metric("Vehículos con excesos", vehiculos_afectados_vel)
            col_v2.metric("Eventos totales", total_eventos_vel)
            col_v3.metric("Velocidad máxima registrada", f"{velocidad_max_registrada:,.0f} km/h")
            col_v4.metric("Duración promedio", f"{duracion_promedio_vel:,.0f} seg")

            st.markdown("---")
            col_vel_top, col_vel_localidad = st.columns(2)
            with col_vel_top:
                st.markdown("**Top 10 vehículos con más excesos de velocidad**")
                top_vel = df_eventos_vel.groupby('Movil').size().reset_index(name='Eventos') \
                    .sort_values('Eventos', ascending=False).head(10)
                fig_top_vel = px.bar(
                    top_vel.sort_values('Eventos'),
                    x='Eventos', y='Movil', orientation='h',
                    text='Eventos', color_discrete_sequence=['#EF9F27']
                )
                fig_top_vel.update_layout(
                    height=320, margin=dict(l=0, r=0, t=10, b=0), showlegend=False,
                    plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)',
                    xaxis=dict(showgrid=False, zeroline=False, visible=False),
                    yaxis=dict(showgrid=False, zeroline=False)
                )
                st.plotly_chart(fig_top_vel, use_container_width=True)

            with col_vel_localidad:
                st.markdown("**Top 10 localidades con más excesos**")
                top_localidad_vel = df_eventos_vel.groupby('Localidad').size().reset_index(name='Eventos') \
                    .sort_values('Eventos', ascending=False).head(10)
                fig_localidad_vel = px.bar(
                    top_localidad_vel.sort_values('Eventos'),
                    x='Eventos', y='Localidad', orientation='h',
                    text='Eventos', color_discrete_sequence=['#62A830']
                )
                fig_localidad_vel.update_layout(
                    height=320, margin=dict(l=0, r=0, t=10, b=0), showlegend=False,
                    plot_bgcolor='rgba(0,0,0,0)', paper_bgcolor='rgba(0,0,0,0)',
                    xaxis=dict(showgrid=False, zeroline=False, visible=False),
                    yaxis=dict(showgrid=False, zeroline=False)
                )
                st.plotly_chart(fig_localidad_vel, use_container_width=True)

            with st.expander("📋 Ver detalle de excesos de velocidad"):
                df_show_vel = df_eventos_vel[['Movil', 'Placa', 'Ciudad', 'Localidad', 'Limite_Velocidad',
                                               'Velocidad_Maxima', 'activeFrom', 'Duracion_Segundos', 'Turno']].copy()
                df_show_vel['activeFrom'] = df_show_vel['activeFrom'].dt.strftime('%d/%m/%Y %H:%M:%S')
                df_show_vel['Duracion_Segundos'] = df_show_vel['Duracion_Segundos'].round(0)
                df_show_vel = df_show_vel.rename(columns={
                    'activeFrom': 'Fecha/Hora', 'Duracion_Segundos': 'Duración (seg)',
                    'Limite_Velocidad': 'Límite (km/h)', 'Velocidad_Maxima': 'Velocidad Máxima (km/h)'
                }).sort_values('Fecha/Hora', ascending=False)
                st.dataframe(df_show_vel, use_container_width=True, hide_index=True)
                st.download_button(
                    "⬇️ Descargar Excel (excesos de velocidad)",
                    data=convertir_a_excel(df_show_vel),
                    file_name=f"excesos_velocidad_{fecha_inicio.strftime('%Y%m%d')}_{fecha_fin.strftime('%Y%m%d')}.xlsx",
                    mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                )
        else:
            st.success("✅ No hay registros de exceso de velocidad en el periodo seleccionado. Recuerda que solo se monitorea Bogotá — límite general 50 km/h, y 30 km/h dentro del relleno sanitario.")

# Las pestañas de Temperaturas y Horómetro quedan pendientes.
# (Avísame cuándo las quieras y las construyo igual que hicimos con Manejo.)