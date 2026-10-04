"""
geotab_comun.py -- funciones compartidas por las herramientas de analisis de ralenti
======================================================================================

Todo lo que antes estaba duplicado en 6 scripts sueltos (conexion, resolucion
de jerarquia de grupos, clasificacion de criticidad, geometria de zonas) vive
aca una sola vez. Los scripts especificos (ver analisis_ralenti.py) importan
de aca en vez de repetir el codigo.

No se ejecuta directamente -- es un modulo de apoyo.
"""
import math
import os
import pathlib
import time
from datetime import timedelta

import mygeotab
import pandas as pd

try:
    import tomllib  # incluido en Python 3.11+
except ModuleNotFoundError:
    tomllib = None

GRUPOS_RAIZ_NO_CIUDAD = {'tipologia'}

# --- Constantes de la regla Sobre-Revolucion con PTO, identicas a telegram_alertas.py ---
ID_DIAGNOSTICO_PTO = 'DiagnosticPowerTakeoffEngagedId'
VENTANA_PTO_MINUTOS = 3
ID_DIAGNOSTICO_RPM_MOTOR = 'aW3Nmy-ktfEuvrdkya4z0yg'
VENTANA_RPM_SEGUNDOS = 30


# ---------------------------------------------------------------------------
# Conexion a Geotab
# ---------------------------------------------------------------------------

def _buscar_secrets_toml(carpeta_inicial, niveles_maximos=4):
    """Busca .streamlit/secrets.toml empezando en carpeta_inicial y subiendo
    por los padres hasta niveles_maximos veces -- asi funciona sin importar
    si este modulo esta en la raiz del proyecto o en una subcarpeta (ej.
    analisis/), sin tener que hardcodear cuantos niveles subir."""
    carpeta = carpeta_inicial
    for _ in range(niveles_maximos + 1):
        candidato = carpeta / '.streamlit' / 'secrets.toml'
        if candidato.exists():
            return candidato
        if carpeta.parent == carpeta:  # llegamos a la raiz del sistema de archivos
            break
        carpeta = carpeta.parent
    return None


def cargar_credenciales_geotab():
    """Busca primero .streamlit/secrets.toml (mismo archivo que ya usa app.py
    via st.secrets['geotab']), subiendo desde la carpeta de este modulo hacia
    sus padres. Si no existe o falta algun campo, recurre a variables de
    entorno (mismo patron que telegram_alertas.py)."""
    ruta_secrets = _buscar_secrets_toml(pathlib.Path(__file__).resolve().parent)
    datos_toml = {}
    if ruta_secrets and tomllib is not None:
        with open(ruta_secrets, 'rb') as f:
            datos_toml = tomllib.load(f).get('geotab', {})

    credenciales = {
        'usuario': datos_toml.get('usuario') or os.environ.get('GEOTAB_USUARIO'),
        'contrasena': datos_toml.get('contrasena') or os.environ.get('GEOTAB_CONTRASENA'),
        'database': datos_toml.get('database') or os.environ.get('GEOTAB_DATABASE'),
        'server': datos_toml.get('server') or os.environ.get('GEOTAB_SERVER', 'my.geotab.com'),
    }
    faltantes = [k for k, v in credenciales.items() if not v]
    if faltantes:
        raise RuntimeError(
            f"Faltan credenciales de Geotab: {', '.join(faltantes)}. "
            f"Revisa que exista .streamlit/secrets.toml junto a los scripts con la seccion [geotab], "
            f"o define las variables de entorno GEOTAB_USUARIO/GEOTAB_CONTRASENA/GEOTAB_DATABASE/GEOTAB_SERVER."
        )
    return credenciales


def conectar_geotab():
    cred = cargar_credenciales_geotab()
    api = mygeotab.API(
        username=cred['usuario'], password=cred['contrasena'],
        database=cred['database'], server=cred['server'],
    )
    api.authenticate()
    return api


# ---------------------------------------------------------------------------
# Jerarquia de grupos: tipologia, y "es este grupo o algun ancestro suyo X"
# ---------------------------------------------------------------------------

def obtener_id(referencia):
    return referencia['id'] if isinstance(referencia, dict) else referencia


def obtener_arbol_grupos(api):
    """Devuelve (grupos_por_id, padre_de, mapa_tipologia):
      - grupos_por_id: id -> objeto Group completo
      - padre_de: id de grupo hijo -> id de su padre inmediato (para subir la jerarquia)
      - mapa_tipologia: id de grupo -> tipologia (nombre del subgrupo bajo 'Tipologia'
        al que pertenece ese grupo o alguno de sus ancestros), o None si no aplica
    """
    grupos = api.get('Group')
    grupos_por_id = {g['id']: g for g in grupos if isinstance(g, dict)}
    padre_de = {}
    for g in grupos:
        if not isinstance(g, dict):
            continue
        for hijo in (g.get('children') or []):
            padre_de[obtener_id(hijo)] = g['id']

    raiz = next((g for g in grupos if isinstance(g, dict) and g.get('name', '').strip().startswith('*')), None)
    mapa_tipologia = {}
    if raiz:
        def recorrer(grupo_id, tipologia_actual):
            grupo_completo = grupos_por_id.get(grupo_id)
            if not grupo_completo:
                return
            mapa_tipologia[grupo_id] = tipologia_actual
            for hijo in (grupo_completo.get('children') or []):
                recorrer(obtener_id(hijo), tipologia_actual)

        for hijo_raiz in (raiz.get('children') or []):
            hijo_id = obtener_id(hijo_raiz)
            hijo_completo = grupos_por_id.get(hijo_id, {})
            nombre = hijo_completo.get('name', '').strip()
            if nombre.lower() in GRUPOS_RAIZ_NO_CIUDAD:
                for sub in (hijo_completo.get('children') or []):
                    sub_id = obtener_id(sub)
                    sub_completo = grupos_por_id.get(sub_id, {})
                    tipo_nombre = sub_completo.get('name', '').strip()
                    recorrer(sub_id, tipo_nombre)
            else:
                recorrer(hijo_id, None)

    return grupos_por_id, padre_de, mapa_tipologia


def resolver_tipologia(grupos_vehiculo, mapa_tipologia):
    for g in (grupos_vehiculo or []):
        gid = obtener_id(g)
        tipologia = mapa_tipologia.get(gid)
        if tipologia:
            return tipologia
    return 'Sin tipología asignada'


def grupo_o_ancestro_en(grupo_id, conjunto_objetivo, padre_de):
    """True si grupo_id esta en conjunto_objetivo, o si CUALQUIER ancestro
    (subiendo por padre_de) lo esta. Usado para resolver el alcance real de
    una regla asignada a un grupo de nivel alto (ej. una marca)."""
    visitados = set()
    actual = grupo_id
    while actual and actual not in visitados:
        if actual in conjunto_objetivo:
            return True
        visitados.add(actual)
        actual = padre_de.get(actual)
    return False


# ---------------------------------------------------------------------------
# Reglas
# ---------------------------------------------------------------------------

def buscar_regla(api, nombre_objetivo, reglas=None):
    """Busca una regla por nombre EXACTO (insensible a mayusculas). Si no la
    encuentra, devuelve (None, lista_de_parecidas) para poder sugerir
    alternativas -- nunca lanza excepcion por esto."""
    if reglas is None:
        reglas = api.get('Rule')
    objetivo_normalizado = nombre_objetivo.strip().upper()
    regla = next((r for r in reglas if r.get('name', '').strip().upper() == objetivo_normalizado), None)
    if regla:
        return regla, []

    palabras_clave = [p.lower() for p in nombre_objetivo.split() if len(p) > 3]
    parecidas = sorted(set(
        r.get('name', '') for r in reglas
        if any(p in r.get('name', '').lower() for p in palabras_clave)
    ))
    return None, parecidas


def resolver_vehiculos_en_alcance(devices, regla, grupos_por_id, padre_de):
    """Dada una regla ya encontrada, devuelve la lista de Device que caen
    dentro de su alcance real (siguiendo la jerarquia de grupos hacia arriba,
    no solo coincidencia directa). Si la regla no tiene grupos asignados, se
    asume alcance total (comportamiento por defecto de Geotab)."""
    grupos_regla = regla.get('groups') or []
    if not grupos_regla:
        return list(devices)

    ids_grupos_regla = {obtener_id(g) for g in grupos_regla}
    return [
        d for d in devices
        if any(grupo_o_ancestro_en(obtener_id(g), ids_grupos_regla, padre_de) for g in (d.get('groups') or []))
    ]


# ---------------------------------------------------------------------------
# Clasificacion de criticidad de ralenti (acordado con el usuario 2026-08-26)
# ---------------------------------------------------------------------------

def clasificar_criticidad_ralenti(duracion_min):
    if duracion_min > 20:
        return 'ALTA'
    elif duracion_min > 10:
        return 'MEDIA'
    else:
        return 'BAJA'


# ---------------------------------------------------------------------------
# Geometria: point-in-polygon y distancia aproximada (mismo criterio que app.py)
# ---------------------------------------------------------------------------

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


def distancia_metros_aprox(lat1, lon1, lat2, lon2):
    """Distancia aproximada en metros entre dos coordenadas (formula plana,
    suficiente para distinguir 'misma cuadra' vs 'lugar distinto' a esta escala)."""
    dx = (lon2 - lon1) * 111320 * math.cos(math.radians((lat1 + lat2) / 2))
    dy = (lat2 - lat1) * 110540
    return math.sqrt(dx ** 2 + dy ** 2)


# ---------------------------------------------------------------------------
# Sobre-Revolucion con PTO: confirmacion de PTO cercano y pico de RPM.
# Puerto directo de _filtrar_por_pto_cercano / _agregar_rpm_pico en
# telegram_alertas.py, para reusar la MISMA logica ya validada con datos
# reales (no una version aparte que se pueda desalinear con el tiempo).
# ---------------------------------------------------------------------------

LIMITE_PAGINA_STATUSDATA = 50000  # mismo tope real que LIMITE_PAGINA_FAULTDATA en
# telegram_alertas.py, pero aplicado aca a StatusData -- confirmado con datos reales
# (2026-09-01, vehiculo 1161): un diagnostico de alta frecuencia como el de RPM
# devuelve EXACTAMENTE 50000 filas para un rango de 8 dias, todas del primer dia,
# y CERO de los 7 dias siguientes -- sin paginar, esto se ve identico a "el
# dispositivo dejo de reportar" cuando en realidad el dispositivo nunca paro, la
# respuesta simplemente se corto en el primer dia.

def _completar_paginas_statusdata(api, diagnostico_id, id_veh, lecturas_iniciales, f_inicio, f_fin):
    """Si lecturas_iniciales vino exactamente al tope (senal de que la respuesta
    se corto), sigue pidiendo paginas adicionales -- una consulta directa (no
    multi_call) por cada pagina extra, avanzando el cursor desde el ultimo
    dateTime recibido -- hasta que una pagina devuelva menos del limite."""
    if len(lecturas_iniciales) < LIMITE_PAGINA_STATUSDATA:
        return lecturas_iniciales

    todas = list(lecturas_iniciales)
    desde = pd.to_datetime(max(r['dateTime'] for r in lecturas_iniciales))
    while True:
        pagina = api.get('StatusData', search={
            'diagnosticSearch': {'id': diagnostico_id},
            'deviceSearch': {'id': id_veh},
            'fromDate': desde.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
            'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        }) or []
        if not pagina:
            break
        todas.extend(pagina)
        if len(pagina) < LIMITE_PAGINA_STATUSDATA:
            break
        nuevo_desde = pd.to_datetime(max(r['dateTime'] for r in pagina))
        if nuevo_desde <= desde:
            break  # resguardo anti-loop-infinito, igual que _obtener_faultdata_paginado
        desde = nuevo_desde
    return todas


def _multi_call_con_reintentos(api, llamadas, etiqueta, intentos=3, espera_seg=20):
    """api.multi_call con reintentos ante fallos transitorios (p.ej. 503).

    CAMBIO (2026-10-03, auditoria): antes, confirmar_pto_cercano y
    agregar_rpm_pico atrapaban CUALQUIER error, imprimian un aviso y seguian
    devolviendo [] / rpm_pico=None -- un 503 real de Geotab se veia como
    "0 eventos confirmados", un resultado falso indistinguible de uno valido.
    Ahora, si tras los reintentos sigue fallando, se lanza la excepcion: mejor
    un script que se detiene con un error claro que un numero falso."""
    for intento in range(1, intentos + 1):
        try:
            return api.multi_call(llamadas)
        except Exception as e:
            if intento == intentos:
                raise RuntimeError(f"No se pudo consultar {etiqueta} en Geotab tras {intentos} intentos: {e}") from e
            print(f"*** Fallo consultando {etiqueta} (intento {intento}/{intentos}): {e} -- reintentando en {espera_seg}s ***")
            time.sleep(espera_seg)


def confirmar_pto_cercano(api, eventos_candidatos, ventana_minutos=VENTANA_PTO_MINUTOS):
    """De una lista de eventos (dicts con id_veh, activeFrom, activeTo --
    datetimes), devuelve solo los que tienen al menos un pulso de PTO=1 en
    +/- ventana_minutos, agregando pto_pulso y pto_delta_seg a cada uno."""
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
    resultados = _multi_call_con_reintentos(api, llamadas, 'PTO')

    pulsos_por_vehiculo = {}
    for id_veh, lecturas in zip(vehiculos, resultados):
        lecturas_completas = _completar_paginas_statusdata(api, ID_DIAGNOSTICO_PTO, id_veh, lecturas or [], desde_global, hasta_global)
        pulsos = []
        for l in lecturas_completas:
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
        pulsos_en_ventana = [p for p in pulsos_por_vehiculo.get(e['id_veh'], []) if desde <= p <= hasta]
        if pulsos_en_ventana:
            pulso_mas_cercano = min(pulsos_en_ventana, key=lambda p: abs((p - e['activeFrom']).total_seconds()))
            e['pto_pulso'] = pulso_mas_cercano
            e['pto_delta_seg'] = (pulso_mas_cercano - e['activeFrom']).total_seconds()
            confirmados.append(e)
    return confirmados


def agregar_rpm_pico(api, eventos_candidatos, diagnostico_id=ID_DIAGNOSTICO_RPM_MOTOR, ventana_segundos=VENTANA_RPM_SEGUNDOS):
    """Agrega 'rpm_pico' (float o None) a cada evento, consultando StatusData
    del diagnostico de RPM en +/-ventana_segundos."""
    if not eventos_candidatos:
        return eventos_candidatos

    vehiculos = list({e['id_veh'] for e in eventos_candidatos})
    desde_global = min(e['activeFrom'] for e in eventos_candidatos) - timedelta(seconds=ventana_segundos)
    hasta_global = max(e['activeTo'] for e in eventos_candidatos) + timedelta(seconds=ventana_segundos)

    llamadas = [
        ('Get', {
            'typeName': 'StatusData',
            'search': {
                'diagnosticSearch': {'id': diagnostico_id},
                'deviceSearch': {'id': id_veh},
                'fromDate': desde_global.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                'toDate': hasta_global.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
            }
        })
        for id_veh in vehiculos
    ]
    resultados = _multi_call_con_reintentos(api, llamadas, 'RPM')

    lecturas_por_vehiculo = {}
    for id_veh, lecturas in zip(vehiculos, resultados):
        lecturas_completas = _completar_paginas_statusdata(api, diagnostico_id, id_veh, lecturas or [], desde_global, hasta_global)
        puntos = []
        for l in lecturas_completas:
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


# ---------------------------------------------------------------------------
# Turno operativo, mismo criterio que clasificar_turno en app.py
# ---------------------------------------------------------------------------

def clasificar_turno(hora):
    if 5 <= hora < 13:
        return 'R1'
    elif 13 <= hora < 21:
        return 'R2'
    else:
        return 'R3'