import streamlit as st
import pandas as pd
import plotly.express as px
import mygeotab
from datetime import datetime, timedelta, timezone, time as dt_time
from zoneinfo import ZoneInfo
import streamlit.components.v1 as components
import gspread
from google.oauth2.service_account import Credentials

ZONA_BOGOTA = ZoneInfo("America/Bogota")

# --- CONFIGURACIÓN DE LA PÁGINA ---
st.set_page_config(page_title="Tablero de Control - Promoambiental", page_icon="🚚", layout="wide")

# --- INICIALIZAR MEMORIA DE ALERTAS ---
if 'alertas_altas_previas' not in st.session_state:
    st.session_state.alertas_altas_previas = 0

st.title("🔧 Tablero Operativo de Mantenimiento")
st.markdown("### Fallas, Comportamiento de Manejo y Salud del Motor")

# --- CONEXIÓN A GEOTAB ---
@st.cache_resource
def iniciar_conexion_geotab():
    try:
        USUARIO = st.secrets["geotab"]["usuario"]
        CONTRASENA = st.secrets["geotab"]["contrasena"]
        BASE_DE_DATOS = st.secrets["geotab"]["database"]
        SERVIDOR = st.secrets["geotab"]["server"]

        client = mygeotab.API(username=USUARIO, password=CONTRASENA, database=BASE_DE_DATOS, server=SERVIDOR)
        client.authenticate()
        return client
    except Exception as e:
        st.error(f"Error de autenticación: {e}")
        return None

client = iniciar_conexion_geotab()

# --- CONEXIÓN A GOOGLE SHEETS (PERSISTENCIA DE INCIDENTES) ---
ID_HOJA_INCIDENTES = "1QdPCp8Vgwc9mJLLAMNK2f1uKFggTrDaj2KI__bWC0LQ"
ALCANCES_SHEETS = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]
COLUMNAS_INCIDENTES = [
    'id_incidente', 'movil', 'placa', 'descripcion_falla', 'criticidad',
    'estado', 'acciones_completadas', 'fecha_apertura', 'fecha_cierre', 'ciudad'
]

@st.cache_resource
def conectar_hoja_incidentes():
    try:
        credenciales_info = dict(st.secrets["gcp_service_account"])
        credenciales = Credentials.from_service_account_info(credenciales_info, scopes=ALCANCES_SHEETS)
        cliente_sheets = gspread.authorize(credenciales)
        hoja = cliente_sheets.open_by_key(ID_HOJA_INCIDENTES).sheet1
        return hoja
    except Exception as e:
        st.warning(f"No se pudo conectar con Google Sheets para el seguimiento de incidentes: {e}")
        return None

hoja_incidentes = conectar_hoja_incidentes()

@st.cache_data(ttl=20)
def cargar_incidentes(_hoja):
    if _hoja is None:
        return {}
    try:
        registros = _hoja.get_all_records()
    except Exception as e:
        st.warning(f"No se pudieron leer los incidentes guardados: {e}")
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
            id_incidente, movil, placa, descripcion_falla, criticidad,
            'Abierto', '', str(fecha_hora), '', ciudad
        ])
        cargar_incidentes.clear()
    except Exception as e:
        st.warning(f"No se pudo guardar el incidente nuevo en Sheets: {e}")

def actualizar_incidente_en_hoja(hoja, id_incidente, nuevo_estado, acciones_realizadas):
    if hoja is None:
        return
    try:
        celda = hoja.find(id_incidente, in_column=1)
        if not celda:
            return
        fila = celda.row
        hoja.update_cell(fila, 6, nuevo_estado)
        hoja.update_cell(fila, 7, '|'.join(acciones_realizadas))
        if nuevo_estado == 'Cerrado':
            hoja.update_cell(fila, 9, str(datetime.now(ZONA_BOGOTA)))
        cargar_incidentes.clear()
    except Exception as e:
        st.warning(f"No se pudo actualizar el incidente en Sheets: {e}")

# --- 1. FILTROS LATERALES ---
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

# --- PROTOCOLOS DE ATENCIÓN ---
PROTOCOLOS = {
    'ALTA': {
        'nombre': 'Protocolo de Emergencia',
        'acciones': [
            {'orden': 1, 'texto': 'Notificar al supervisor de turno (WhatsApp / llamada).', 'responsable': 'Supervisor'},
            {'orden': 2, 'texto': 'Contactar al conductor para verificar estado y seguridad.', 'responsable': 'Coordinador'},
            {'orden': 3, 'texto': 'Enviar grúa o mecánico a la ubicación GPS.', 'responsable': 'Jefe de Flota'},
            {'orden': 4, 'texto': 'Registrar incidente en sistema de ticketing.', 'responsable': 'Operador'},
            {'orden': 5, 'texto': 'Seguimiento hasta cierre del evento.', 'responsable': 'Supervisor'}
        ],
        'tiempo_max_respuesta_min': 5
    },
    'MEDIA': {
        'nombre': 'Protocolo de Atención Programada',
        'acciones': [
            {'orden': 1, 'texto': 'Evaluar necesidad de detener la ruta (consulta con supervisor).', 'responsable': 'Coordinador'},
            {'orden': 2, 'texto': 'Agendar cita en taller más cercano para próximas 24 h.', 'responsable': 'Operador'},
            {'orden': 3, 'texto': 'Notificar al conductor sobre la cita.', 'responsable': 'Operador'}
        ],
        'tiempo_max_respuesta_min': 30
    },
    'BAJA': {
        'nombre': 'Registro y Mantenimiento Preventivo',
        'acciones': [
            {'orden': 1, 'texto': 'Registrar la falla en el historial del vehículo.', 'responsable': 'Sistema'},
            {'orden': 2, 'texto': 'Programar revisión en el próximo mantenimiento preventivo.', 'responsable': 'Sistema'}
        ],
        'tiempo_max_respuesta_min': 1440
    }
}

# Tabla fija: referencia de motor por marca
REFERENCIA_MOTOR_POR_MARCA = {
    "volkswagen": "ISF 3.8",
    "volskwagen": "ISF 3.8",
    "mercedes": "OM926",
    "international": "L9",
    "foton": "X12",
    "kenworth": "ISM 11",
}

NOMBRE_REGLA_RPM_POR_MOTOR = {
    'L9': 'SOBRE REVOLUCION (L9)',
    'X12': 'SOBRE REVOLUCION (X12)',
}

LIMITE_VELOCIDAD_POR_CIUDAD = {
    'Bogotá': 50,
}

def clasificar_turno(momento):
    hora = momento.hour
    if 5 <= hora < 13:
        return 'R1'
    elif 13 <= hora < 21:
        return 'R2'
    else:
        return 'R3'

# ===== FUNCIÓN NORMALIZAR NOMBRE LOCALIDAD (global) =====
def normalizar_nombre_localidad(texto):
    conectores = {'de', 'del', 'la', 'las', 'el', 'los', 'y', 'en'}
    palabras = texto.strip().lower().split()
    resultado = [
        palabra if palabra in conectores else palabra.capitalize()
        for palabra in palabras
    ]
    if resultado:
        resultado[0] = resultado[0].capitalize()
    return ' '.join(resultado)

@st.cache_data(ttl=3600)
def obtener_reglas_rpm(_client):
    if _client is None:
        return {}
    try:
        todas_reglas = _client.get('Rule')
        mapa_regla_id = {}
        for motor, nombre_regla in NOMBRE_REGLA_RPM_POR_MOTOR.items():
            objetivo = nombre_regla.strip().upper()
            regla = next(
                (r for r in todas_reglas if r.get('name', '').strip().upper() == objetivo),
                None
            )
            if regla:
                mapa_regla_id[motor] = regla['id']
        return mapa_regla_id
    except Exception as e:
        st.warning(f"No se pudieron cargar las reglas de RPM: {e}")
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
            st.warning(f"No se pudieron traer eventos de sobre-revolución para {motor}: {e}")

    if not eventos_todos:
        return pd.DataFrame(), pd.DataFrame()

    df_eventos = pd.DataFrame(eventos_todos)
    df_eventos['activeFrom'] = pd.to_datetime(df_eventos['activeFrom'])
    df_eventos['activeTo'] = pd.to_datetime(df_eventos['activeTo'])
    df_eventos['Fecha'] = df_eventos['activeFrom'].dt.tz_convert(ZONA_BOGOTA).dt.date
    df_eventos['Hora_Bogota'] = df_eventos['activeFrom'].dt.tz_convert(ZONA_BOGOTA)
    df_eventos['Turno'] = df_eventos['Hora_Bogota'].apply(clasificar_turno)
    df_eventos['Duracion_Segundos'] = (df_eventos['activeTo'] - df_eventos['activeFrom']).dt.total_seconds()
    df_eventos['Umbral_RPM'] = df_eventos['Motor'].map({'L9': 2100, 'X12': 2100})
    df_eventos = pd.merge(df_eventos, _df_vehiculos, on='id_camion', how='left')

    ID_DIAGNOSTICO_RPM = 'aW3Nmy-ktfEuvrdkya4z0yg'

    def obtener_pico_evento(row):
        try:
            desde = row['activeFrom'] - timedelta(seconds=30)
            hasta = row['activeTo'] + timedelta(seconds=30)
            lecturas = _client.get('StatusData', search={
                'diagnosticSearch': {'id': ID_DIAGNOSTICO_RPM},
                'deviceSearch': {'id': row['id_camion']},
                'fromDate': desde.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                'toDate': hasta.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
            })
            if not lecturas:
                return None
            valores = [l.get('data') for l in lecturas if l.get('data') is not None]
            return max(valores) if valores else None
        except Exception:
            return None

    df_eventos['RPM_Pico'] = df_eventos.apply(obtener_pico_evento, axis=1)

    df_rpm_diario = df_eventos.groupby(['id_camion', 'Fecha'])['RPM_Pico'].max().reset_index()
    df_rpm_diario = df_rpm_diario.rename(columns={'RPM_Pico': 'RPM_Maximo'})

    return df_eventos, df_rpm_diario

@st.cache_data(ttl=180)
def extraer_datos_velocidad(_client, f_inicio, f_fin, _df_vehiculos):
    if _client is None or _df_vehiculos.empty:
        return pd.DataFrame()

    f_inicio_utc = f_inicio.astimezone(timezone.utc)
    f_fin_utc = f_fin.astimezone(timezone.utc)

    zonas = obtener_zonas(_client)
    eventos = []

    for ciudad, limite in LIMITE_VELOCIDAD_POR_CIUDAD.items():
        vehiculos_ciudad = _df_vehiculos[_df_vehiculos['Ciudad'] == ciudad]
        if vehiculos_ciudad.empty:
            continue

        for _, veh in vehiculos_ciudad.iterrows():
            try:
                logs = _client.get('LogRecord', search={
                    'deviceSearch': {'id': veh['id_camion']},
                    'fromDate': f_inicio_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                    'toDate': f_fin_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
                })
            except Exception:
                continue
            if not logs:
                continue

            df_log = pd.DataFrame(logs)
            if df_log.empty or 'speed' not in df_log.columns:
                continue

            df_log['dateTime'] = pd.to_datetime(df_log['dateTime'])
            df_log = df_log.sort_values('dateTime').reset_index(drop=True)
            df_log['excede'] = df_log['speed'] > limite
            df_log['grupo'] = (df_log['excede'] != df_log['excede'].shift()).cumsum()

            for _, grupo_df in df_log[df_log['excede']].groupby('grupo'):
                inicio = grupo_df['dateTime'].iloc[0]
                fin = grupo_df['dateTime'].iloc[-1]
                duracion = (fin - inicio).total_seconds()
                if duracion < 5:
                    continue

                idx_max = grupo_df['speed'].idxmax()
                fila_max = grupo_df.loc[idx_max]
                localidad = determinar_localidad(fila_max.get('longitude'), fila_max.get('latitude'), zonas)

                eventos.append({
                    'id_camion': veh['id_camion'],
                    'activeFrom': inicio,
                    'activeTo': fin,
                    'Duracion_Segundos': duracion,
                    'Velocidad_Maxima': grupo_df['speed'].max(),
                    'latitude': fila_max.get('latitude'),
                    'longitude': fila_max.get('longitude'),
                    'Localidad': localidad,
                    'Limite_Velocidad': limite,
                })

    if not eventos:
        return pd.DataFrame()

    df_eventos_vel = pd.DataFrame(eventos)
    df_eventos_vel['Fecha'] = df_eventos_vel['activeFrom'].dt.tz_convert(ZONA_BOGOTA).dt.date
    df_eventos_vel['Turno'] = df_eventos_vel['activeFrom'].dt.tz_convert(ZONA_BOGOTA).apply(clasificar_turno)
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
        st.warning(f"No se pudieron cargar las zonas: {e}")
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
            st.warning("No se encontró un grupo raíz que empiece con '*'.")
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
        st.warning(f"No se pudo cargar la jerarquía de grupos: {e}")
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
                dic_diag[d['id']] = {
                    'nombre': d.get('name') or 'Diagnóstico sin nombre',
                    'codigo': d.get('code')
                }
            elif isinstance(d, str):
                dic_diag[d] = {'nombre': d, 'codigo': None}

        dic_fm = {}
        for fm in _client.get('FailureMode'):
            if isinstance(fm, dict) and 'id' in fm:
                dic_fm[fm['id']] = {
                    'nombre': fm.get('name') or 'Modo de falla sin nombre',
                    'codigo': fm.get('code')
                }
            elif isinstance(fm, str):
                dic_fm[fm] = {'nombre': fm, 'codigo': None}

        return dic_diag, dic_fm
    except Exception as e:
        st.warning(f"No se pudieron cargar los catálogos de diagnóstico: {e}")
        return {}, {}

@st.cache_data(ttl=86400)
def cargar_diccionario_fallas():
    try:
        df = pd.read_csv('diccionario_fallas.csv')
        df['SPN'] = df['SPN'].astype(int)
        df['FMI'] = df['FMI'].astype(int)
        return df
    except FileNotFoundError:
        st.warning("No se encontró 'diccionario_fallas.csv' en la carpeta del proyecto.")
        return pd.DataFrame(columns=['SPN', 'FMI', 'Descripcion', 'Grupo', 'Criticidad', 'Origen_Criticidad', 'Motor_Aplica'])

def clasificar_falla(spn, fmi, referencia_motor, df_diccionario):
    candidatos = df_diccionario[(df_diccionario['SPN'] == spn) & (df_diccionario['FMI'] == fmi)]
    if candidatos.empty:
        return None, 'BAJA'

    if referencia_motor == 'X12':
        especifico = candidatos[candidatos['Motor_Aplica'] == 'X12']
        if not especifico.empty:
            fila = especifico.iloc[0]
            return fila['Descripcion'], fila['Criticidad']

    generico = candidatos[candidatos['Motor_Aplica'] == 'Generico']
    fila = generico.iloc[0] if not generico.empty else candidatos.iloc[0]
    return fila['Descripcion'], fila['Criticidad']

def reproducir_alarma():
    sonido_url = "https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3"
    html_audio = f"""
        <audio autoplay>
            <source src="{sonido_url}" type="audio/mpeg">
        </audio>
    """
    components.html(html_audio, width=0, height=0)
    st.toast("🚨 ¡NUEVA ALERTA CRÍTICA DETECTADA!", icon="🔴")

# --- 2. EXTRACCIÓN DE DATOS ---
@st.cache_data(ttl=180)
def extraer_datos_completos(_client, f_inicio, f_fin):
    if _client is None:
        return pd.DataFrame(), pd.DataFrame(), pd.DataFrame()
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
                df_temp['Fecha'] = pd.to_datetime(df_temp['dateTime']).dt.date
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

                df_fallas['Fecha_Alerta'] = pd.to_datetime(df_fallas['dateTime'])

                ahora = datetime.now(timezone.utc)
                df_fallas['Dias_Activa'] = df_fallas['Fecha_Alerta'].apply(lambda x: max((ahora - x).days, 0))

                df_fallas['Duracion_Activa_Min'] = df_fallas.groupby(['id_camion', 'Codigo'])['Fecha_Alerta'] \
                    .transform(lambda s: (s.max() - s.min()).total_seconds() / 60)

                zonas = obtener_zonas(_client)
                vehiculos_con_falla = df_fallas['id_camion'].unique().tolist()

                logs_por_camion = []
                for id_veh in vehiculos_con_falla:
                    try:
                        logs_veh = _client.get('LogRecord', search={
                            'deviceSearch': {'id': id_veh},
                            'fromDate': f_inicio_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                            'toDate': f_fin_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
                        })
                        if logs_veh:
                            logs_por_camion.extend(logs_veh)
                    except Exception:
                        continue

                if logs_por_camion:
                    df_logs = pd.DataFrame(logs_por_camion)
                    df_logs['id_camion'] = df_logs['device'].apply(lambda x: x['id'] if isinstance(x, dict) else str(x))
                    df_logs['dateTime'] = pd.to_datetime(df_logs['dateTime'])
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

                df_fallas_resumen = pd.merge(df_fallas, df_vehiculos, on='id_camion', how='left')

                df_diccionario = cargar_diccionario_fallas()

                def _clasificar(row):
                    try:
                        spn = int(row['SPN_Geotab'])
                        fmi = int(row['FMI_Geotab'])
                    except (TypeError, ValueError):
                        return pd.Series({'Descripcion_Falla': row['Codigo'], 'Criticidad': 'BAJA'})

                    desc, crit = clasificar_falla(spn, fmi, row.get('Referencia_Motor'), df_diccionario)
                    if desc is None:
                        return pd.Series({'Descripcion_Falla': row['Codigo'], 'Criticidad': 'BAJA'})
                    return pd.Series({'Descripcion_Falla': desc, 'Criticidad': crit})

                df_fallas_resumen[['Descripcion_Falla', 'Criticidad']] = df_fallas_resumen.apply(_clasificar, axis=1)

        return df_resumen_viajes, df_temp, df_fallas_resumen, df_vehiculos
    except Exception as e:
        st.error(f"Error procesando datos de Geotab: {e}")
        return pd.DataFrame(), pd.DataFrame(), pd.DataFrame(), pd.DataFrame()

# --- 3. EJECUCIÓN ---
df_operativo, df_temperatura, df_fallas, df_vehiculos_global = extraer_datos_completos(client, fecha_inicio, fecha_fin)

# --- 4. SISTEMA DE PESTAÑAS ---
tab_fallas, tab_manejo, tab_temperaturas, tab_horometro = st.tabs([
    "🩺 Fallas y Diagnóstico",
    "🚦 Comportamiento de Manejo",
    "🌡️ Temperaturas y Niveles",
    "⏱️ Horómetro"
])

ORDEN_CRITICIDAD = ['ALTA', 'MEDIA', 'BAJA']
COLOR_CRITICIDAD = {'ALTA': '#B91C1C', 'MEDIA': '#B45309', 'BAJA': '#6B7280'}

with tab_fallas:
    st.subheader("🩺 Fallas y Diagnóstico")
    st.caption(f"Reporte generado el: {datetime.now().strftime('%d/%m/%Y')} - Hora: {datetime.now().strftime('%I:%M %p')}")

    if not df_fallas.empty:
        df_activas = df_fallas.copy()

        if 'dismiss' in df_activas.columns:
            df_activas = df_activas[~df_activas['dismiss'].fillna(False)]

        ultima_fecha = df_activas.groupby(['id_camion', 'Codigo'])['Fecha_Alerta'].transform('max')
        df_activas = df_activas[df_activas['Fecha_Alerta'] == ultima_fecha]
        # df_activas = df_activas[df_activas['Dias_Activa'] <= dias_activa_umbral]  # COMENTADO

        if not df_activas.empty:
            rank_criticidad = {'ALTA': 0, 'MEDIA': 1, 'BAJA': 2}
            df_activas['Rank_Criticidad'] = df_activas['Criticidad'].map(rank_criticidad).fillna(2)
            criticidad_max_por_vehiculo = df_activas.groupby('id_camion')['Rank_Criticidad'].min()
            rank_a_texto = {0: 'ALTA', 1: 'MEDIA', 2: 'BAJA'}
            df_activas['Criticidad_Vehiculo'] = df_activas['id_camion'].map(criticidad_max_por_vehiculo).map(rank_a_texto)

            st.markdown("#### 📊 Resumen Cuantitativo")

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
                color_discrete_sequence=['#0F6E56']
            )
            fig_ciudad.update_layout(height=200, margin=dict(l=0, r=0, t=10, b=0), showlegend=False)
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
                    text='Eventos', color_discrete_sequence=['#2a78d6']
                )
                fig_top5.update_layout(height=280, margin=dict(l=0, r=0, t=10, b=0), showlegend=False)
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

            # --- TENDENCIA SEMANAL DE FALLAS POR CIUDAD ---
            st.markdown("---")
            st.markdown("#### 📈 Tendencia Semanal de Fallas por Ciudad")
            st.caption("Evolución semanal del número de fallas activas por ciudad. Usa el deslizador para ajustar el rango de semanas.")

            if not df_activas.empty and 'Fecha_Alerta' in df_activas.columns and 'Ciudad' in df_activas.columns:
                import numpy as np
                
                # 1. Crear columna de semana (inicio de semana = lunes)
                df_activas['Semana'] = pd.to_datetime(df_activas['Fecha_Alerta']).dt.to_period('W').dt.start_time
                
                # 2. Agrupar por semana y ciudad
                df_tendencia_ciudad = df_activas.groupby(['Semana', 'Ciudad']).size().reset_index(name='Cantidad_Fallas')
                df_tendencia_ciudad = df_tendencia_ciudad.sort_values('Semana')
                
                # 3. Obtener rango completo de semanas (para no tener saltos en el eje X)
                fecha_min_global = df_tendencia_ciudad['Semana'].min()
                fecha_max_global = df_tendencia_ciudad['Semana'].max()
                
                # Crear un calendario de todas las semanas entre min y max
                todas_semanas = pd.date_range(
                    start=fecha_min_global,
                    end=fecha_max_global,
                    freq='W-MON'  # Lunes de cada semana
                )
                df_calendario = pd.DataFrame({'Semana': todas_semanas})
                
                # Obtener todas las ciudades únicas
                todas_ciudades = df_tendencia_ciudad['Ciudad'].unique()
                
                # Crear un DataFrame con todas las combinaciones (semana, ciudad)
                df_completo = df_calendario.assign(key=1).merge(
                    pd.DataFrame({'Ciudad': todas_ciudades, 'key': 1}),
                    on='key'
                ).drop('key', axis=1)
                
                # Unir con los datos reales (rellenar con 0 donde no hay datos)
                df_tendencia_completa = df_completo.merge(
                    df_tendencia_ciudad,
                    on=['Semana', 'Ciudad'],
                    how='left'
                ).fillna({'Cantidad_Fallas': 0})
                
                # 4. Ordenar por semana
                df_tendencia_completa = df_tendencia_completa.sort_values('Semana')
                
                # --- SLIDER NUMÉRICO PARA SELECCIONAR RANGO DE SEMANAS ---
                # Convertir fechas a números (días desde la fecha mínima)
                semanas_unicas = sorted(df_tendencia_completa['Semana'].unique())
                fecha_base = semanas_unicas[0]  # primera semana
                indices = [ (s - fecha_base).days for s in semanas_unicas ]
                
                # Crear slider con valores numéricos
                st.markdown("**Selecciona el rango de semanas con el deslizador:**")
                indice_min = indices[0]
                indice_max = indices[-1]
                
                rango_indices = st.slider(
                    "Mueve las dos asas para seleccionar el rango",
                    min_value=indice_min,
                    max_value=indice_max,
                    value=(indice_min, indice_max),
                    key="tendencia_slider_num"
                )
                
                # Convertir los índices seleccionados de vuelta a fechas
                fecha_inicio_filtro = fecha_base + pd.Timedelta(days=rango_indices[0])
                fecha_fin_filtro = fecha_base + pd.Timedelta(days=rango_indices[1])
                
                # Filtrar el DataFrame completo (con todas las semanas)
                df_filtrado = df_tendencia_completa[
                    (df_tendencia_completa['Semana'] >= fecha_inicio_filtro) &
                    (df_tendencia_completa['Semana'] <= fecha_fin_filtro)
                ]
                
                # Obtener ciudades con datos reales en el filtro
                ciudades_con_datos = df_filtrado[df_filtrado['Cantidad_Fallas'] > 0]['Ciudad'].unique()
                
                if len(ciudades_con_datos) > 0:
                    # --- GRÁFICO DE LÍNEAS CON TODAS LAS SEMANAS (CONTINUO) ---
                    fig_tendencia = px.line(
                        df_filtrado[df_filtrado['Ciudad'].isin(ciudades_con_datos)],
                        x='Semana',
                        y='Cantidad_Fallas',
                        color='Ciudad',
                        markers=True,
                        title=f"Evolución semanal (desde {fecha_inicio_filtro.strftime('%d/%m/%Y')} hasta {fecha_fin_filtro.strftime('%d/%m/%Y')})"
                    )
                    fig_tendencia.update_layout(
                        height=350,
                        margin=dict(l=0, r=0, t=40, b=0),
                        xaxis_title="Semana (inicio)",
                        yaxis_title="Número de fallas activas",
                        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1)
                    )
                    st.plotly_chart(fig_tendencia, use_container_width=True)
                    
                    # --- COMPARATIVA SEMANA ACTUAL VS ANTERIOR (dentro del filtro) ---
                    st.markdown("---")
                    st.markdown("#### 📊 Comparativa Semana Actual vs Semana Anterior")
                    
                    # Filtrar solo semanas con datos reales
                    df_con_datos = df_filtrado[df_filtrado['Cantidad_Fallas'] > 0]
                    semanas_con_datos = sorted(df_con_datos['Semana'].unique())
                    
                    if len(semanas_con_datos) >= 2:
                        semana_actual = semanas_con_datos[-1]
                        semana_anterior = semanas_con_datos[-2]
                        
                        df_actual = df_con_datos[df_con_datos['Semana'] == semana_actual]
                        df_anterior = df_con_datos[df_con_datos['Semana'] == semana_anterior]
                        
                        df_comparativa = df_actual.merge(
                            df_anterior,
                            on='Ciudad',
                            suffixes=('_actual', '_anterior'),
                            how='outer'
                        ).fillna(0)
                        
                        df_comparativa['Diferencia'] = df_comparativa['Cantidad_Fallas_actual'] - df_comparativa['Cantidad_Fallas_anterior']
                        df_comparativa['Cambio_%'] = ((df_comparativa['Cantidad_Fallas_actual'] - df_comparativa['Cantidad_Fallas_anterior']) / 
                                                       df_comparativa['Cantidad_Fallas_anterior'].replace(0, 1) * 100).round(1)
                        
                        st.dataframe(
                            df_comparativa[['Ciudad', 'Cantidad_Fallas_actual', 'Cantidad_Fallas_anterior', 'Diferencia', 'Cambio_%']],
                            use_container_width=True,
                            hide_index=True,
                            column_config={
                                'Ciudad': 'Ciudad',
                                'Cantidad_Fallas_actual': f'Semana {semana_actual.strftime("%d/%m")}',
                                'Cantidad_Fallas_anterior': f'Semana {semana_anterior.strftime("%d/%m")}',
                                'Diferencia': 'Diferencia',
                                'Cambio_%': 'Cambio %'
                            }
                        )
                        
                        fig_comparativa = px.bar(
                            df_comparativa,
                            x='Ciudad',
                            y=['Cantidad_Fallas_actual', 'Cantidad_Fallas_anterior'],
                            barmode='group',
                            title=f"Comparativa: semana del {semana_actual.strftime('%d/%m')} vs semana del {semana_anterior.strftime('%d/%m')}",
                            labels={'value': 'Número de fallas', 'variable': 'Semana'}
                        )
                        fig_comparativa.update_layout(height=300, margin=dict(l=0, r=0, t=40, b=0))
                        st.plotly_chart(fig_comparativa, use_container_width=True)
                    else:
                        st.info(f"📅 En el rango seleccionado hay {len(semanas_con_datos)} semana(s) con datos. Amplía el rango con el deslizador para tener más semanas.")
                    
                    # --- ANÁLISIS DE TENDENCIA (con datos filtrados) ---
                    st.markdown("---")
                    st.markdown("**📊 Resumen de tendencia por ciudad**")
                    
                    resumen_tendencias = []
                    for ciudad in ciudades_con_datos:
                        df_ciudad = df_con_datos[df_con_datos['Ciudad'] == ciudad]
                        if len(df_ciudad) >= 3:
                            x = np.arange(len(df_ciudad))
                            y = df_ciudad['Cantidad_Fallas'].values
                            n = len(x)
                            pendiente = (n * np.sum(x*y) - np.sum(x)*np.sum(y)) / (n * np.sum(x**2) - (np.sum(x))**2)
                            
                            if pendiente > 0.5:
                                tendencia = "📈 Al alza"
                            elif pendiente < -0.5:
                                tendencia = "📉 A la baja"
                            else:
                                tendencia = "➡️ Estable"
                            
                            resumen_tendencias.append({
                                'Ciudad': ciudad,
                                'Pendiente': pendiente,
                                'Tendencia': tendencia
                            })
                    
                    if resumen_tendencias:
                        df_resumen = pd.DataFrame(resumen_tendencias)
                        st.dataframe(
                            df_resumen[['Ciudad', 'Tendencia', 'Pendiente']].round(2),
                            use_container_width=True,
                            hide_index=True
                        )
                        
                        max_alza = df_resumen.loc[df_resumen['Pendiente'].idxmax()]
                        max_baja = df_resumen.loc[df_resumen['Pendiente'].idxmin()]
                        
                        col_t1, col_t2 = st.columns(2)
                        with col_t1:
                            st.metric(
                                "📈 Ciudad con mayor crecimiento",
                                max_alza['Ciudad'],
                                delta=f"{max_alza['Pendiente']:.2f} fallas/semana"
                            )
                        with col_t2:
                            st.metric(
                                "📉 Ciudad con mayor decrecimiento",
                                max_baja['Ciudad'],
                                delta=f"{max_baja['Pendiente']:.2f} fallas/semana"
                            )
                    else:
                        st.info("📊 No hay suficientes semanas con datos (mínimo 3) en el rango seleccionado para calcular la tendencia. Ajusta el deslizador para incluir más semanas.")
                else:
                    st.warning("⚠️ El rango seleccionado no tiene datos con fallas. Ajusta el deslizador.")
            else:
                st.info("No hay datos de fallas o ciudades para mostrar la tendencia semanal.")

            with st.expander("📋 Ver detalle completo por vehículo (código, fecha y descripción de cada falla)"):
                for ciudad, df_ciudad in df_activas.groupby('Ciudad'):
                    vehiculos_ciudad = df_ciudad['id_camion'].nunique()
                    st.markdown(f"""
<div style="background:#1F4E4A;color:white;padding:8px 14px;border-radius:6px;font-weight:600;margin-top:16px;">
{ciudad}  (TOTAL VEHÍCULOS: {vehiculos_ciudad})
</div>""", unsafe_allow_html=True)

                    for criticidad in ORDEN_CRITICIDAD:
                        df_nivel = df_ciudad[df_ciudad['Criticidad_Vehiculo'] == criticidad]
                        if df_nivel.empty:
                            continue

                        vehiculos_nivel = df_nivel['id_camion'].nunique()
                        color = COLOR_CRITICIDAD[criticidad]
                        st.markdown(f"""
<div style="background:{color};color:white;padding:6px 14px;border-radius:4px;font-weight:600;margin-top:8px;">
{criticidad}  (CANTIDAD: {vehiculos_nivel})
</div>""", unsafe_allow_html=True)

                        filas_html = ""
                        for id_veh, df_veh in df_nivel.groupby('id_camion'):
                            fila0 = df_veh.iloc[0]
                            df_veh_ordenado = df_veh.sort_values('Fecha_Alerta', ascending=False)

                            codigos_html = "<br>".join(
                                f"{i+1}. SPN {int(r['SPN_Geotab']) if pd.notna(r['SPN_Geotab']) else '?'}"
                                f"-{int(r['FMI_Geotab']) if pd.notna(r['FMI_Geotab']) else '?'}"
                                f" - {r['Fecha_Alerta'].strftime('%d/%m/%Y %H:%M:%S')}"
                                for i, (_, r) in enumerate(df_veh_ordenado.iterrows())
                            )
                            descripciones_html = "<br>".join(
                                f"{i+1}. {r['Descripcion_Falla']} [{r['Criticidad']}]"
                                for i, (_, r) in enumerate(df_veh_ordenado.iterrows())
                            )

                            filas_html += f"""
<tr>
  <td style="padding:8px;border:1px solid #ddd;vertical-align:top;white-space:nowrap;">{fila0['Movil']}</td>
  <td style="padding:8px;border:1px solid #ddd;vertical-align:top;white-space:nowrap;">{fila0['Marca']}</td>
  <td style="padding:8px;border:1px solid #ddd;vertical-align:top;white-space:nowrap;">{fila0['Referencia_Motor']}</td>
  <td style="padding:8px;border:1px solid #ddd;vertical-align:top;white-space:nowrap;">{fila0['N_Motor']}</td>
  <td style="padding:8px;border:1px solid #ddd;vertical-align:top;font-size:12px;">{codigos_html}</td>
  <td style="padding:8px;border:1px solid #ddd;vertical-align:top;font-size:12px;">{descripciones_html}</td>
</tr>"""

                        st.markdown(f"""
<table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
<thead>
<tr style="background:#f3f4f6;">
  <th style="padding:8px;border:1px solid #ddd;text-align:left;">Móvil</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:left;">Marca</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:left;">Referencia Motor</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:left;">N° Motor</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:left;">Código(s) de Falla</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:left;">Descripción</th>
</tr>
</thead>
<tbody>
{filas_html}
</tbody>
</table>
""", unsafe_allow_html=True)
        else:
            st.success(f"✅ No hay fallas activas en los últimos {dias_activa_umbral} días.")
    else:
        st.success("✅ ¡Excelente! No se registran códigos de falla activos en la flota en este rango de fechas.")

    st.markdown("---")

    # --- PROTOCOLO DE ATENCIÓN ---
    st.markdown("---")
    st.subheader("📋 Protocolo de Atención para Fallas Críticas")

    if hoja_incidentes is None:
        st.warning("⚠️ No hay conexión con la hoja de seguimiento de incidentes. El protocolo se muestra pero los cambios no se guardarán hasta que se restablezca la conexión.")

    incidentes_guardados = cargar_incidentes(hoja_incidentes)

    fallas_criticas = df_activas[df_activas['Criticidad_Vehiculo'] == 'ALTA'] if not df_activas.empty else df_activas

    if not fallas_criticas.empty:
        fecha_hoy_str = datetime.now(ZONA_BOGOTA).strftime('%Y%m%d')

        for id_camion, grupo_vehiculo in fallas_criticas.groupby('id_camion'):
            fila0 = grupo_vehiculo.iloc[0]
            id_inc = f"VEH_{id_camion}_{fecha_hoy_str}"

            grupo_ordenado = grupo_vehiculo.sort_values('Fecha_Alerta', ascending=False)
            descripcion_consolidada = "\n".join(
                f"{i+1}. {r['Descripcion_Falla']} ({r['Fecha_Alerta'].strftime('%d/%m %H:%M')})"
                for i, (_, r) in enumerate(grupo_ordenado.iterrows())
            )
            fecha_mas_reciente = grupo_ordenado.iloc[0]['Fecha_Alerta']
            cantidad_fallas = len(grupo_vehiculo)

            if id_inc not in incidentes_guardados:
                crear_incidente_en_hoja(
                    hoja_incidentes, id_inc,
                    fila0['Movil'], fila0['Placa'], descripcion_consolidada,
                    'ALTA', fecha_mas_reciente, fila0.get('Ciudad', 'Sin ciudad asignada')
                )
                incidentes_guardados = cargar_incidentes(hoja_incidentes)

            inc = incidentes_guardados.get(id_inc, {
                'estado': 'Abierto', 'acciones_realizadas': [], 'detalle': {}
            })
            protocolo = PROTOCOLOS['ALTA']

            with st.expander(
                f"🚨 {fila0['Movil']} - {fila0['Placa']} - {cantidad_fallas} falla(s) crítica(s) activa(s) "
                f"({fila0.get('Localidad', 'Desconocida')})",
                expanded=(inc['estado'] == 'Abierto')
            ):
                col1, col2 = st.columns([2, 1])
                with col1:
                    st.markdown(f"**Estado:** {inc['estado']}")
                    st.markdown(f"**Ubicación:** {fila0.get('Localidad', 'No disponible')}")
                    st.markdown(f"**Última falla detectada:** {fecha_mas_reciente.strftime('%d/%m/%Y %H:%M:%S')}")
                with col2:
                    if inc['estado'] == 'Abierto':
                        if st.button("🔒 Cerrar incidente", key=f"cerrar_{id_inc}"):
                            actualizar_incidente_en_hoja(
                                hoja_incidentes, id_inc, 'Cerrado', inc['acciones_realizadas']
                            )
                            st.success("Incidente cerrado correctamente.")
                            st.rerun()

                st.markdown("---")
                st.markdown("**Fallas activas de este vehículo:**")
                st.markdown(descripcion_consolidada.replace("\n", "  \n"))

                st.markdown("---")
                st.markdown(f"#### {protocolo['nombre']}")
                st.caption(f"⏱️ Tiempo máximo de respuesta: {protocolo['tiempo_max_respuesta_min']} min")

                acciones_realizadas = list(inc['acciones_realizadas'])
                hubo_cambio = False
                for accion in protocolo['acciones']:
                    orden = accion['orden']
                    descripcion = accion['texto']
                    responsable = accion['responsable']
                    clave = f"accion_{id_inc}_{orden}"

                    realizada = clave in acciones_realizadas
                    check = st.checkbox(
                        f"**{orden}.** {descripcion} _(Responsable: {responsable})_",
                        value=realizada,
                        key=clave
                    )
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
        st.info("No hay vehículos en criticidad ALTA en este momento.")

    # =====================================================================
    # MAPA DE FALLAS (siempre visible si hay datos, independientemente de críticas)
    # =====================================================================
    st.markdown("---")
    st.markdown("#### 📍 Distribución Geográfica de Fallas por Zona")

    if not df_fallas.empty and 'latitude' in df_fallas.columns:
        df_fallas_geo = df_fallas[df_fallas['latitude'].notna()]

        if not df_fallas_geo.empty:
            conteo_localidad = df_fallas_geo.groupby('Localidad').agg(
                Total_Fallas=('id_camion', 'count'),
                Vehiculos_Unicos=('id_camion', 'nunique')
            ).reset_index().sort_values('Total_Fallas', ascending=False)

            conteo_localidad['Porcentaje_Impacto'] = (
                conteo_localidad['Total_Fallas'] / conteo_localidad['Total_Fallas'].sum() * 100
            ).round(1)

            col_mapa, col_ranking = st.columns([2, 1])

            with col_ranking:
                st.markdown("**Localidades con más fallas**")
                st.caption("(Todas las fallas con coordenadas GPS)")

                filas_localidad_html = ""
                for _, fila in conteo_localidad.iterrows():
                    nombre_formateado = normalizar_nombre_localidad(fila['Localidad'])
                    filas_localidad_html += f"""
<tr>
  <td style="padding:8px;border:1px solid #ddd;text-align:left;">{nombre_formateado}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{int(fila['Total_Fallas'])}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Porcentaje_Impacto']:.1f}%</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{int(fila['Vehiculos_Unicos'])}</td>
</tr>"""

                st.markdown(f"""
<table style="width:100%;border-collapse:collapse;">
<thead>
<tr style="background:#f3f4f6;">
  <th style="padding:8px;border:1px solid #ddd;text-align:left;">Localidad</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Total Fallas</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">% Impacto</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Vehículos Únicos</th>
</tr>
</thead>
<tbody>
{filas_localidad_html}
</tbody>
</table>
""", unsafe_allow_html=True)

            with col_mapa:
                fig_mapa = px.scatter_map(
                    df_fallas_geo,
                    lat='latitude', lon='longitude',
                    color='Localidad',
                    hover_name='Movil',
                    hover_data=['Codigo', 'Placa', 'Localidad', 'Descripcion_Falla'],
                    zoom=10, height=450
                )
                fig_mapa.update_layout(margin={"r": 0, "t": 0, "l": 0, "b": 0})
                st.plotly_chart(fig_mapa, use_container_width=True)
        else:
            st.warning("⚠️ No se encontraron fallas con coordenadas GPS. Verifica que los vehículos estén enviando posición y que el rango de fechas incluya datos.")
    else:
        st.info("No hay fallas registradas en el período seleccionado.")

with tab_manejo:
    st.subheader("🚦 Comportamiento de Manejo")

    df_eventos_rpm, df_rpm_diario = extraer_datos_manejo(client, fecha_inicio, fecha_fin, df_vehiculos_global)

    if not df_eventos_rpm.empty:
        col_m1, col_m2, col_m3 = st.columns(3)
        col_m1.metric("Eventos de sobre-revolución", len(df_eventos_rpm))
        col_m2.metric("Vehículos afectados", df_eventos_rpm['id_camion'].nunique())
        col_m3.metric("Tiempo total en sobre-revolución", f"{df_eventos_rpm['Duracion_Segundos'].sum() / 60:,.1f} min")

        st.markdown("---")

        col_top, col_dona = st.columns(2)

        with col_top:
            st.markdown("**Top vehículos por tiempo acumulado**")
            top_rpm = df_eventos_rpm.groupby('Movil').agg(
                Tiempo_Min=('Duracion_Segundos', lambda s: s.sum() / 60)
            ).reset_index().sort_values('Tiempo_Min', ascending=False).head(5)
            fig_rpm = px.bar(
                top_rpm.sort_values('Tiempo_Min'),
                x='Tiempo_Min', y='Movil', orientation='h',
                text=top_rpm.sort_values('Tiempo_Min')['Tiempo_Min'].round(1),
                color_discrete_sequence=['#E24B4A']
            )
            fig_rpm.update_layout(height=280, margin=dict(l=0, r=0, t=10, b=0), showlegend=False,
                                   xaxis_title="Minutos")
            st.plotly_chart(fig_rpm, use_container_width=True)

        with col_dona:
            st.markdown("**Distribución de impactos por Turno**")
            df_turno_dona = df_eventos_rpm.groupby('Turno').size().reset_index(name='Eventos')
            fig_dona = px.pie(
                df_turno_dona, values='Eventos', names='Turno', hole=0.55,
                color='Turno',
                color_discrete_map={'R1': '#2a78d6', 'R2': '#EF9F27', 'R3': '#2C3E50'}
            )
            fig_dona.update_traces(textposition='inside', textinfo='percent+label')
            fig_dona.update_layout(height=280, margin=dict(l=0, r=0, t=10, b=0), showlegend=False)
            st.plotly_chart(fig_dona, use_container_width=True)

        st.markdown("---")

        st.markdown("**📈 Tendencia Diaria de Sobre-Revoluciones por Turno**")
        st.caption("Evolución del número de infracciones detectadas por jornada operativa a lo largo del periodo seleccionado")

        df_tendencia = df_eventos_rpm.groupby(['Fecha', 'Turno']).size().reset_index(name='Cantidad_Eventos')
        df_tendencia = df_tendencia.sort_values('Fecha')

        fig_linea = px.line(
            df_tendencia,
            x='Fecha',
            y='Cantidad_Eventos',
            color='Turno',
            color_discrete_map={'R1': '#2a78d6', 'R2': '#EF9F27', 'R3': '#2C3E50'},
            markers=True
        )
        fig_linea.update_layout(
            height=320,
            margin=dict(l=0, r=0, t=10, b=0),
            xaxis_title="Fecha Operativa",
            yaxis_title="Número de Eventos",
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1)
        )
        st.plotly_chart(fig_linea, use_container_width=True)

        st.markdown("---")

        st.markdown("**Detalle consolidado por vehículo/día**")
        ranking = df_eventos_rpm.groupby(['Movil', 'Placa', 'Motor', 'Fecha']).agg(
            Umbral_RPM=('Umbral_RPM', 'first'),
            RPM_Maximo=('RPM_Pico', 'max'),
            Veces=('id_camion', 'count'),
            Tiempo_Min=('Duracion_Segundos', lambda s: round(s.sum() / 60, 1))
        ).reset_index().sort_values('Tiempo_Min', ascending=False)

        filas_ranking_html = ""
        for _, fila in ranking.iterrows():
            rpm_max = int(round(fila['RPM_Maximo'])) if pd.notna(fila['RPM_Maximo']) else '-'
            filas_ranking_html += f"""
<tr>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Movil']}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Placa']}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Motor']}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Fecha']}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{int(fila['Umbral_RPM'])}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{rpm_max}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{int(fila['Veces'])}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Tiempo_Min']:.1f}</td>
</tr>"""

        st.markdown(f"""
<table style="width:100%;border-collapse:collapse;">
<thead>
<tr style="background:#f3f4f6;">
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Móvil</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Placa</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Motor</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Fecha</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Umbral RPM</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">RPM Máx.</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Veces</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Tiempo (min)</th>
</tr>
</thead>
<tbody>
{filas_ranking_html}
</tbody>
</table>
""", unsafe_allow_html=True)

        st.markdown("---")

        st.markdown("**🔎 Detalle de eventos por vehículo**")
        vehiculo_seleccionado = st.selectbox(
            "Selecciona un vehículo para ver cada evento individual",
            options=sorted(df_eventos_rpm['Movil'].unique())
        )

        detalle_eventos = df_eventos_rpm[df_eventos_rpm['Movil'] == vehiculo_seleccionado].copy()
        detalle_eventos['Duracion_Min'] = (detalle_eventos['Duracion_Segundos'] / 60).round(2)
        detalle_eventos['Hora_Inicio'] = detalle_eventos['activeFrom'].dt.tz_convert(ZONA_BOGOTA).dt.strftime('%d/%m/%Y %H:%M:%S')
        detalle_eventos['Hora_Fin'] = detalle_eventos['activeTo'].dt.tz_convert(ZONA_BOGOTA).dt.strftime('%d/%m/%Y %H:%M:%S')
        detalle_eventos = detalle_eventos.sort_values('activeFrom', ascending=False)

        def formatear_duracion(segundos):
            if segundos < 60:
                return f"{int(round(segundos))} seg"
            return f"{segundos / 60:.1f} min"

        detalle_eventos['Duracion_Fmt'] = detalle_eventos['Duracion_Segundos'].apply(formatear_duracion)

        def formatear_rpm(valor):
            if pd.isna(valor):
                return "Sin datos"
            return f"{int(round(valor))} RPM"

        detalle_eventos['RPM_Pico'] = pd.to_numeric(detalle_eventos['RPM_Pico'], errors='coerce')
        detalle_eventos['RPM_Pico_Fmt'] = detalle_eventos['RPM_Pico'].apply(formatear_rpm)

        detalle_eventos['Exceso_RPM'] = detalle_eventos['RPM_Pico'] - detalle_eventos['Umbral_RPM']

        def clasificar_evento(row):
            if row['Duracion_Min'] > 5 or row['Exceso_RPM'] > 200:
                return '🔴 Crítico'
            elif row['Duracion_Min'] > 2 or row['Exceso_RPM'] > 100:
                return '🟠 Moderado'
            return '⚪ Leve'

        detalle_eventos['Severidad'] = detalle_eventos.apply(clasificar_evento, axis=1)

        def colorear_fila(row):
            if row['Severidad'] == '🔴 Crítico':
                return ['background-color: #FDECEC'] * len(row)
            elif row['Severidad'] == '🟠 Moderado':
                return ['background-color: #FEF3E2'] * len(row)
            return [''] * len(row)

        st.caption(f"{len(detalle_eventos)} eventos encontrados para {vehiculo_seleccionado}")

        COLOR_FONDO_SEVERIDAD = {
            '🔴 Crítico': '#FDECEC',
            '🟠 Moderado': '#FEF3E2',
            '⚪ Leve': '#FFFFFF',
        }

        filas_detalle_html = ""
        for _, fila in detalle_eventos.iterrows():
            color_fondo = COLOR_FONDO_SEVERIDAD.get(fila['Severidad'], '#FFFFFF')
            filas_detalle_html += f"""
<tr style="background:{color_fondo};">
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Severidad']}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Hora_Inicio']}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Hora_Fin']}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Duracion_Fmt']}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['RPM_Pico_Fmt']}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{int(fila['Umbral_RPM'])}</td>
</tr>"""

        tabla_html_completa = f"""
<table style="width:100%;border-collapse:collapse;">
<thead>
<tr style="background:#f3f4f6;">
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Severidad</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Hora Inicio</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Hora Fin</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Duración</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">RPM Pico</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Umbral RPM</th>
</tr>
</thead>
<tbody>
{filas_detalle_html}
</tbody>
</table>
"""

        if len(detalle_eventos) > 10:
            with st.expander(f"📋 Ver los {len(detalle_eventos)} eventos individuales"):
                st.markdown(tabla_html_completa, unsafe_allow_html=True)
        else:
            st.markdown(tabla_html_completa, unsafe_allow_html=True)
    else:
        st.info("No se registraron eventos de sobre-revolución en este periodo (o ningún vehículo del rango tiene motor L9/X12).")

    st.markdown("---")
    st.markdown("#### 🚗 Excesos de Velocidad")
    st.caption(f"Límite fijo por ciudad. Actualmente configurado: {', '.join(f'{c} = {v} km/h' for c, v in LIMITE_VELOCIDAD_POR_CIUDAD.items())}. Próximamente Cali y Valle.")

    df_eventos_vel = extraer_datos_velocidad(client, fecha_inicio, fecha_fin, df_vehiculos_global)

    if not df_eventos_vel.empty:
        col_v1, col_v2, col_v3 = st.columns(3)
        col_v1.metric("Eventos de exceso de velocidad", len(df_eventos_vel))
        col_v2.metric("Vehículos afectados", df_eventos_vel['id_camion'].nunique())
        col_v3.metric("Tiempo total en exceso", f"{df_eventos_vel['Duracion_Segundos'].sum() / 60:,.1f} min")

        st.markdown("---")

        col_top_vel, col_dona_vel = st.columns(2)

        with col_top_vel:
            st.markdown("**Top vehículos por tiempo acumulado**")
            top_vel = df_eventos_vel.groupby('Movil').agg(
                Tiempo_Min=('Duracion_Segundos', lambda s: s.sum() / 60)
            ).reset_index().sort_values('Tiempo_Min', ascending=False).head(5)
            fig_top_vel = px.bar(
                top_vel.sort_values('Tiempo_Min'),
                x='Tiempo_Min', y='Movil', orientation='h',
                text=top_vel.sort_values('Tiempo_Min')['Tiempo_Min'].round(1),
                color_discrete_sequence=['#8E44AD']
            )
            fig_top_vel.update_layout(height=280, margin=dict(l=0, r=0, t=10, b=0), showlegend=False,
                                       xaxis_title="Minutos")
            st.plotly_chart(fig_top_vel, use_container_width=True)

        with col_dona_vel:
            st.markdown("**Distribución de excesos por Turno**")
            df_turno_dona_vel = df_eventos_vel.groupby('Turno').size().reset_index(name='Eventos')
            fig_dona_vel = px.pie(
                df_turno_dona_vel, values='Eventos', names='Turno', hole=0.55,
                color='Turno',
                color_discrete_map={'R1': '#2a78d6', 'R2': '#EF9F27', 'R3': '#2C3E50'}
            )
            fig_dona_vel.update_traces(textposition='inside', textinfo='percent+label')
            fig_dona_vel.update_layout(height=280, margin=dict(l=0, r=0, t=10, b=0), showlegend=False)
            st.plotly_chart(fig_dona_vel, use_container_width=True)

        st.markdown("---")
        st.markdown("**📈 Tendencia Diaria de Excesos de Velocidad por Turno**")
        st.caption("Evolución del número de excesos de velocidad detectados por jornada operativa")

        df_tendencia_vel = df_eventos_vel.groupby(['Fecha', 'Turno']).size().reset_index(name='Cantidad_Eventos')
        df_tendencia_vel = df_tendencia_vel.sort_values('Fecha')

        fig_linea_vel = px.line(
            df_tendencia_vel,
            x='Fecha', y='Cantidad_Eventos', color='Turno',
            color_discrete_map={'R1': '#2a78d6', 'R2': '#EF9F27', 'R3': '#2C3E50'},
            markers=True
        )
        fig_linea_vel.update_layout(
            height=320, margin=dict(l=0, r=0, t=10, b=0),
            xaxis_title="Fecha Operativa", yaxis_title="Número de Eventos",
            legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="right", x=1)
        )
        st.plotly_chart(fig_linea_vel, use_container_width=True)

        st.markdown("---")
        st.markdown("**Detalle consolidado por vehículo/día**")
        ranking_vel = df_eventos_vel.groupby(['Movil', 'Placa', 'Ciudad', 'Fecha']).agg(
            Limite=('Limite_Velocidad', 'first'),
            Velocidad_Max=('Velocidad_Maxima', 'max'),
            Veces=('id_camion', 'count'),
            Tiempo_Min=('Duracion_Segundos', lambda s: round(s.sum() / 60, 1))
        ).reset_index().sort_values('Tiempo_Min', ascending=False)

        filas_ranking_vel_html = ""
        for _, fila in ranking_vel.iterrows():
            filas_ranking_vel_html += f"""
<tr>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Movil']}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Placa']}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Ciudad']}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Fecha']}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{int(fila['Limite'])} km/h</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Velocidad_Max']:.0f} km/h</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{int(fila['Veces'])}</td>
  <td style="padding:8px;border:1px solid #ddd;text-align:center;">{fila['Tiempo_Min']:.1f}</td>
</tr>"""

        st.markdown(f"""
<table style="width:100%;border-collapse:collapse;">
<thead>
<tr style="background:#f3f4f6;">
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Móvil</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Placa</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Ciudad</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Fecha</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Límite</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Vel. Máx.</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Veces</th>
  <th style="padding:8px;border:1px solid #ddd;text-align:center;">Tiempo (min)</th>
</tr>
</thead>
<tbody>
{filas_ranking_vel_html}
</tbody>
</table>
""", unsafe_allow_html=True)

        st.markdown("---")
        st.markdown("#### 📍 Mapa de Excesos de Velocidad")

        opciones_vehiculo_mapa = ['Todos los vehículos'] + sorted(df_eventos_vel['Movil'].unique())
        vehiculo_mapa_seleccionado = st.selectbox(
            "Filtrar el mapa por vehículo",
            options=opciones_vehiculo_mapa
        )

        if vehiculo_mapa_seleccionado == 'Todos los vehículos':
            df_mapa_vel = df_eventos_vel
            color_mapa = 'Localidad'
        else:
            df_mapa_vel = df_eventos_vel[df_eventos_vel['Movil'] == vehiculo_mapa_seleccionado]
            color_mapa = 'Turno'
            st.caption(f"{len(df_mapa_vel)} registros de exceso de velocidad para {vehiculo_mapa_seleccionado}")

        fig_mapa_vel = px.scatter_map(
            df_mapa_vel,
            lat='latitude', lon='longitude',
            color=color_mapa,
            hover_name='Movil',
            hover_data=['Velocidad_Maxima', 'Placa', 'Turno', 'Localidad'],
            zoom=10, height=450
        )
        fig_mapa_vel.update_layout(margin={"r": 0, "t": 0, "l": 0, "b": 0})
        st.plotly_chart(fig_mapa_vel, use_container_width=True)
    else:
        st.info("No se registraron excesos de velocidad en este periodo (o ningún vehículo pertenece a una ciudad con límite configurado).")