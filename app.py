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

ID_HOJA_SEGUIMIENTO = "1QdPCp8Vgwc9mJLLAMNK2f1uKFggTrDaj2KI__bWC0LQ"  # mismo libro que ya se usaba
ALCANCES_SHEETS = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

@st.cache_resource
def conectar_hoja_seguimiento():
    """Conecta con una hoja dedicada a guardar qué códigos estaban activos la última
    vez que se revisó el tablero, para poder detectar cuáles se acaban de activar
    y cuáles ya se desactivaron. La crea si todavía no existe."""
    try:
        credenciales_env = os.environ.get("GCP_SERVICE_ACCOUNT_JSON")
        if credenciales_env:
            credenciales_info = json.loads(credenciales_env)
        else:
            credenciales_info = dict(st.secrets["gcp_service_account"])
        credenciales = Credentials.from_service_account_info(credenciales_info, scopes=ALCANCES_SHEETS)
        cliente_sheets = gspread.authorize(credenciales)
        libro = cliente_sheets.open_by_key(ID_HOJA_SEGUIMIENTO)
        try:
            hoja = libro.worksheet('snapshot_codigos')
        except gspread.exceptions.WorksheetNotFound:
            hoja = libro.add_worksheet(title='snapshot_codigos', rows=3000, cols=2)
            hoja.append_row(['clave', 'fecha_registro'])
        return hoja
    except Exception as e:
        st.warning(f"No se pudo conectar con Google Sheets: {e}")
        return None

hoja_snapshot = conectar_hoja_seguimiento()

# =============================================================================
# FUNCIONES DE SEGUIMIENTO DE CÓDIGOS (ACTIVACIÓN / DESACTIVACIÓN)
# =============================================================================
@st.cache_data(ttl=20)
def cargar_snapshot_codigos(_hoja):
    if _hoja is None:
        return set()
    try:
        valores = _hoja.col_values(1)[1:]  # saltar encabezado
        return set(v for v in valores if v)
    except Exception as e:
        st.warning(f"No se pudo leer el snapshot de códigos: {e}")
        return set()

def guardar_snapshot_codigos(hoja, claves_actuales):
    if hoja is None:
        return
    try:
        hoja.clear()
        hoja.append_row(['clave', 'fecha_registro'])
        ahora_str = str(datetime.now(ZONA_BOGOTA))
        filas = [[clave, ahora_str] for clave in sorted(claves_actuales)]
        if filas:
            hoja.append_rows(filas)
        cargar_snapshot_codigos.clear()
    except Exception as e:
        st.warning(f"No se pudo guardar el snapshot de códigos: {e}")

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
# CONSTANTES DE CLASIFICACIÓN DE VEHÍCULOS
# =============================================================================
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
def procesar_activas(df_fallas, ciudad_filtro):
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
df_activas = procesar_activas(df_fallas, ciudad_seleccionada)

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
tab_fallas, tab_seguimiento = st.tabs([
    "🩺 Fallas y Diagnóstico",
    "⏱️ Seguimiento de Códigos"
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
                            df_show['SPN_Geotab'] = df_show['SPN_Geotab'].apply(lambda x: str(int(x)) if pd.notna(x) else '?')
                            df_show['FMI_Geotab'] = df_show['FMI_Geotab'].apply(lambda x: str(int(x)) if pd.notna(x) else '?')
                            df_show['Fecha_Alerta'] = df_show['Fecha_Alerta'].dt.strftime('%d/%m/%Y %H:%M:%S')
                            df_show = df_show.rename(columns={'SPN_Geotab':'SPN','FMI_Geotab':'FMI','Fecha_Alerta':'Fecha','Descripcion_Falla':'Descripción','Criticidad':'Criticidad'})
                            st.dataframe(df_show, use_container_width=True, hide_index=True)
            else:
                st.info("No hay vehículos con fallas activas.")
    else:
        st.success("✅ No hay fallas activas en este momento. ¡Excelente!")

    # Mapa (se omite por brevedad pero se mantiene igual que antes)

# =============================================================================
# TAB SEGUIMIENTO DE CÓDIGOS (tiempo activo + activación/desactivación)
# =============================================================================
with tab_seguimiento:
    st.subheader("⏱️ Seguimiento de Códigos")
    st.caption(
        "Cuánto tiempo llevan activos los códigos de falla, y cuáles se activaron "
        "o desactivaron desde la última vez que se revisó el tablero."
    )

    claves_anteriores = cargar_snapshot_codigos(hoja_snapshot)

    if not df_activas.empty:
        df_codigos_activos = df_activas.drop_duplicates(['id_camion', 'Codigo']).copy()
        df_codigos_activos['clave'] = (
            df_codigos_activos['id_camion'].astype(str) + '|' + df_codigos_activos['Codigo'].astype(str)
        )
        claves_actuales = set(df_codigos_activos['clave'])
    else:
        df_codigos_activos = pd.DataFrame()
        claves_actuales = set()

    claves_nuevas = claves_actuales - claves_anteriores
    claves_desactivadas = claves_anteriores - claves_actuales

    col_s1, col_s2, col_s3 = st.columns(3)
    col_s1.metric("Códigos activos ahora", len(claves_actuales))
    col_s2.metric("🆕 Recién activados", len(claves_nuevas))
    col_s3.metric("✅ Recién desactivados", len(claves_desactivadas))

    st.markdown("---")

    if not df_codigos_activos.empty:
        df_codigos_activos['Estado'] = df_codigos_activos['clave'].apply(
            lambda c: '🆕 Nuevo' if c in claves_nuevas else 'Ya estaba activo'
        )
        df_codigos_activos['Tiempo_Activo_Horas'] = (df_codigos_activos['Duracion_Activa_Min'] / 60).round(1)

        st.markdown("**Códigos actualmente activos**")
        columnas_mostrar = ['Movil', 'Placa', 'Ciudad', 'Codigo', 'Criticidad',
                             'Dias_Activa', 'Tiempo_Activo_Horas', 'Estado']
        columnas_disponibles = [c for c in columnas_mostrar if c in df_codigos_activos.columns]
        df_show_seg = df_codigos_activos[columnas_disponibles].rename(columns={
            'Dias_Activa': 'Días desde última alerta',
            'Tiempo_Activo_Horas': 'Tiempo activo (horas)'
        }).sort_values('Tiempo activo (horas)', ascending=False)
        st.dataframe(df_show_seg, use_container_width=True, hide_index=True)
        st.download_button(
            "⬇️ Descargar Excel (seguimiento de códigos)",
            data=convertir_a_excel(df_show_seg),
            file_name=f"seguimiento_codigos_{datetime.now(ZONA_BOGOTA).strftime('%Y%m%d_%H%M')}.xlsx",
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        )
    else:
        st.success("✅ No hay códigos activos en este momento.")

    if claves_desactivadas:
        with st.expander(f"✅ Ver los {len(claves_desactivadas)} código(s) que se desactivaron desde la última revisión"):
            st.write(sorted(claves_desactivadas))

    guardar_snapshot_codigos(hoja_snapshot, claves_actuales)