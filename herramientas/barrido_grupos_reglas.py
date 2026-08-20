"""Barrido de las 107 reglas custom de Geotab: para cada una, infiere de su
NOMBRE si deberia aplicar a ciertas ciudades/motores/tipologias, calcula el
alcance REAL (vehiculos cubiertos segun 'groups' de la regla, expandiendo
grupos hijos) y compara. Marca como sospechosa cualquier regla donde el
alcance real no coincide con lo que el nombre sugiere -- exactamente el tipo
de problema que ya encontramos a mano en "SOBRE REVOLUCIÓN (L9)" (le faltaba
el grupo de Ser Ambiental) y en la regla de 1300 RPM (le faltaban 7 grupos).

No modifica nada en Geotab -- es de solo lectura. Genera un CSV para revisar.
"""
import os
import re
import unicodedata
from collections import defaultdict
from datetime import datetime

from dotenv import load_dotenv
import mygeotab
import pandas as pd

load_dotenv()  # busca el .env en la carpeta desde donde se ejecuta (la raiz del repo)

api = mygeotab.API(
    username=os.getenv("GEOTAB_USUARIO"),
    password=os.getenv("GEOTAB_CONTRASENA"),
    database=os.getenv("GEOTAB_DATABASE"),
    server=os.getenv("GEOTAB_SERVER", "my.geotab.com"),
)
api.authenticate()

# --- mismo criterio de ciudad/marca/tipologia validado en app.py / telegram_alertas.py ---
REFERENCIA_MOTOR_POR_MARCA = {
    "volkswagen": "ISF 3.8", "volskwagen": "ISF 3.8", "mercedes": "OM926",
    "international": "L9", "foton": "X12", "kenworth": "ISM 11",
}
GRUPOS_RAIZ_NO_CIUDAD = {'tipologia'}


def obtener_id(referencia):
    return referencia['id'] if isinstance(referencia, dict) else referencia


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


def _sin_tildes(texto):
    texto = unicodedata.normalize("NFKD", texto)
    return "".join(c for c in texto if not unicodedata.combining(c))


def normalizar_texto(texto):
    """minusculas, sin tildes, sin espacios -- para comparar 'OM926' contra 'OM 926'."""
    return _sin_tildes(texto).lower().replace(" ", "").replace("-", "")


print("Conectado. Cargando grupos, vehiculos y reglas...")

grupos = api.get('Group')
by_id = {g['id']: g for g in grupos if isinstance(g, dict)}
raiz = next((g for g in grupos if g.get('name', '').strip().startswith('*')), None)
if not raiz:
    raise SystemExit("No se encontro el grupo raiz ('*...').")

# mapa_grupos: id_grupo -> {'nombre':, 'ciudad':, 'tipologia':}
mapa_grupos = {}


def recorrer(grupo_id, ciudad_actual, tipologia_actual):
    grupo_completo = by_id.get(grupo_id)
    if not grupo_completo:
        return
    mapa_grupos[grupo_id] = {
        'nombre': grupo_completo.get('name', ''),
        'ciudad': ciudad_actual,
        'tipologia': tipologia_actual,
    }
    for hijo in (grupo_completo.get('children') or []):
        recorrer(obtener_id(hijo), ciudad_actual, tipologia_actual)


for hijo_raiz in (raiz.get('children') or []):
    hijo_id = obtener_id(hijo_raiz)
    hijo_completo = by_id.get(hijo_id, {})
    nombre = hijo_completo.get('name', '').strip()
    if nombre.lower() in GRUPOS_RAIZ_NO_CIUDAD:
        for sub in (hijo_completo.get('children') or []):
            sub_id = obtener_id(sub)
            sub_completo = by_id.get(sub_id, {})
            tipo_nombre = sub_completo.get('name', '').strip()
            recorrer(sub_id, 'Sin ciudad asignada', tipo_nombre)
    elif es_grupo_marca(nombre):
        recorrer(hijo_id, 'Sin ciudad asignada', None)
    else:
        recorrer(hijo_id, normalizar_ciudad(nombre), None)

# --- cierre transitivo de grupos (grupo -> si mismo + todos sus descendientes) ---
_cache_descendientes = {}


def descendientes(gid):
    if gid in _cache_descendientes:
        return _cache_descendientes[gid]
    resultado = {gid}
    completo = by_id.get(gid)
    if completo:
        for hijo in (completo.get('children') or []):
            resultado |= descendientes(obtener_id(hijo))
    _cache_descendientes[gid] = resultado
    return resultado


# --- vehiculos: ciudad, tipologia, motor (marca), y el set de ids de sus propios grupos ---
devices = api.get('Device')
vehiculos = {}
for d in devices:
    grupos_veh = d.get('groups') or []
    group_ids = {obtener_id(g) for g in grupos_veh}

    ciudad = 'Sin ciudad asignada'
    tipologia = 'Sin tipología asignada'
    marca_nombre = None
    for gid in group_ids:
        info = mapa_grupos.get(gid)
        if not info:
            continue
        if info['ciudad'] and info['ciudad'] != 'Sin ciudad asignada' and ciudad == 'Sin ciudad asignada':
            ciudad = info['ciudad']
        if info.get('tipologia') and tipologia == 'Sin tipología asignada':
            tipologia = info['tipologia']
        if marca_nombre is None and es_grupo_marca(info['nombre']):
            marca_nombre = info['nombre'].strip()

    motor = next(
        (v for k, v in REFERENCIA_MOTOR_POR_MARCA.items() if marca_nombre and k in marca_nombre.lower()),
        'Desconocido'
    )

    vehiculos[d['id']] = {
        'placa': d.get('licensePlate') or d.get('name'),
        'nombre': d.get('name'),
        'ciudad': ciudad,
        'tipologia': tipologia,
        'motor': motor,
        'group_ids': group_ids,
    }

ciudades_presentes = sorted({
    v['ciudad'] for v in vehiculos.values() if v['ciudad'] not in (None, 'Sin ciudad asignada')
})
tipologias_presentes = sorted({
    v['tipologia'] for v in vehiculos.values() if v['tipologia'] not in (None, 'Sin tipología asignada')
})
motores_conocidos = sorted(set(REFERENCIA_MOTOR_POR_MARCA.values()))

print(f"Vehiculos: {len(vehiculos)} | Ciudades detectadas: {ciudades_presentes} | "
      f"Tipologias detectadas: {tipologias_presentes} | Motores: {motores_conocidos}")

reglas = [r for r in api.get('Rule') if (r.get('baseType') or '').lower() != 'stock']
print(f"Reglas custom encontradas: {len(reglas)}\n")

filas = []
for regla in reglas:
    nombre_regla = regla.get('name', '')
    nombre_norm = normalizar_texto(nombre_regla)

    grupos_regla = regla.get('groups') or []
    if not grupos_regla:
        alcance_ids = set(mapa_grupos.keys())  # sin restriccion -> toda la flota
        tipo_alcance = 'TODA LA FLOTA (sin grupos)'
    else:
        alcance_ids = set()
        for g in grupos_regla:
            alcance_ids |= descendientes(obtener_id(g))
        tipo_alcance = 'GRUPOS ESPECIFICOS'

    vehiculos_en_alcance = {
        vid for vid, info in vehiculos.items() if info['group_ids'] & alcance_ids
    }

    ciudades_detectadas = [c for c in ciudades_presentes if normalizar_texto(c) in nombre_norm]
    motores_detectados = [m for m in motores_conocidos if normalizar_texto(m) in nombre_norm]
    tipologias_detectadas = [t for t in tipologias_presentes if normalizar_texto(t) in nombre_norm]

    hay_patron = bool(ciudades_detectadas or motores_detectados or tipologias_detectadas)

    if hay_patron:
        esperados = {
            vid for vid, info in vehiculos.items()
            if (not ciudades_detectadas or info['ciudad'] in ciudades_detectadas)
            and (not motores_detectados or info['motor'] in motores_detectados)
            and (not tipologias_detectadas or info['tipologia'] in tipologias_detectadas)
        }
        faltantes = esperados - vehiculos_en_alcance
        sobrantes = vehiculos_en_alcance - esperados
        sospecha = bool(faltantes or sobrantes)
    else:
        esperados = None
        faltantes = set()
        sobrantes = set()
        sospecha = False

    filas.append({
        'Regla': nombre_regla,
        'Tipo_Alcance': tipo_alcance,
        'Ciudades_en_nombre': ", ".join(ciudades_detectadas) or "-",
        'Motores_en_nombre': ", ".join(motores_detectados) or "-",
        'Tipologias_en_nombre': ", ".join(tipologias_detectadas) or "-",
        'Patron_detectado': hay_patron,
        'Veh_Alcance_Actual': len(vehiculos_en_alcance),
        'Veh_Esperados': len(esperados) if esperados is not None else None,
        'N_Faltantes': len(faltantes),
        'N_Sobrantes': len(sobrantes),
        'Sospecha': sospecha,
        'Placas_Faltantes': ", ".join(sorted(vehiculos[v]['placa'] or '' for v in faltantes)[:15]),
        'Placas_Sobrantes': ", ".join(sorted(vehiculos[v]['placa'] or '' for v in sobrantes)[:15]),
    })

df = pd.DataFrame(filas).sort_values(['Sospecha', 'N_Faltantes', 'N_Sobrantes'], ascending=[False, False, False])
os.makedirs("reportes", exist_ok=True)  # no va a git (.gitignore), puede no existir aun
out_path = "reportes/barrido_grupos_reglas.csv"
df.to_csv(out_path, index=False, encoding="utf-8-sig")

n_sospechosas = int(df['Sospecha'].sum())
n_con_patron = int(df['Patron_detectado'].sum())
print(f"Reglas con patron detectable en el nombre: {n_con_patron} / {len(df)}")
print(f"Reglas SOSPECHOSAS (alcance no coincide con el nombre): {n_sospechosas}")
print(f"\nReporte completo guardado en: {out_path}\n")

if n_sospechosas:
    print("--- Top sospechosas ---")
    for _, fila in df[df['Sospecha']].head(20).iterrows():
        print(f"- {fila['Regla']}")
        print(f"    ciudades={fila['Ciudades_en_nombre']} motores={fila['Motores_en_nombre']} tipologias={fila['Tipologias_en_nombre']}")
        print(f"    alcance_actual={fila['Veh_Alcance_Actual']} esperados={fila['Veh_Esperados']} faltantes={fila['N_Faltantes']} sobrantes={fila['N_Sobrantes']}")
        if fila['N_Faltantes']:
            print(f"    FALTAN: {fila['Placas_Faltantes']}")
        if fila['N_Sobrantes']:
            print(f"    SOBRAN: {fila['Placas_Sobrantes']}")
