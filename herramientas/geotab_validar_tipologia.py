import os
import csv
from dotenv import load_dotenv
import mygeotab

load_dotenv()

USERNAME = os.getenv("GEOTAB_USUARIO")
PASSWORD = os.getenv("GEOTAB_CONTRASENA")
DATABASE = os.getenv("GEOTAB_DATABASE")
SERVER = os.getenv("GEOTAB_SERVER", "my.geotab.com")

CSV_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mapeo_tipologia.csv")
NOMBRE_GRUPO_PADRE = "Tipologia"


def leer_mapeo(path):
    mapeo = {}
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            mapeo[row["device_name"]] = row["tipo"].strip()
    return mapeo


def main():
    api = mygeotab.API(
        username=USERNAME,
        password=PASSWORD,
        database=DATABASE,
        server=SERVER,
    )
    api.authenticate()

    mapeo_esperado = leer_mapeo(CSV_PATH)

    groups = api.call("Get", typeName="Group")
    by_id = {g["id"]: g for g in groups}
    by_name = {g.get("name"): g for g in groups}

    devices = api.call("Get", typeName="Device")
    devices_by_name = {d.get("name"): d for d in devices}

    print("--- Grupos de nivel raiz disponibles ---")
    for g in groups:
        parent = g.get("parent")
        if not parent or parent.get("id") in ("GroupCompanyId", None):
            print(f"  '{g.get('name')}' (id={g['id']})")

    print("\n=== VALIDACION: Grupo padre y subgrupos ===\n")

    padre = by_name.get(NOMBRE_GRUPO_PADRE)
    if padre:
        print(f"OK: grupo padre '{NOMBRE_GRUPO_PADRE}' existe (id={padre['id']})")
    else:
        print(f"[ERROR] grupo padre '{NOMBRE_GRUPO_PADRE}' NO existe")

    hijos_del_padre_ids = set()
    if padre:
        hijos_del_padre_ids = {
            (h["id"] if isinstance(h, dict) else h) for h in (padre.get("children") or [])
        }

    tipologias_esperadas = sorted(set(mapeo_esperado.values()))
    subgrupos_ok = 0
    for t in tipologias_esperadas:
        g = by_name.get(t)
        if not g:
            print(f"[ERROR] subgrupo '{t}' NO existe")
            continue
        if padre and g["id"] in hijos_del_padre_ids:
            print(f"OK: subgrupo '{t}' existe y esta bajo '{NOMBRE_GRUPO_PADRE}' (id={g['id']})")
            subgrupos_ok += 1
        else:
            print(f"[AVISO] subgrupo '{t}' existe (id={g['id']}) pero NO esta en los children de '{NOMBRE_GRUPO_PADRE}'")

    print(f"\nSubgrupos correctos: {subgrupos_ok}/{len(tipologias_esperadas)}")

    print("\n=== VALIDACION: Asignacion por vehiculo ===\n")

    correctos = 0
    incorrectos = []
    no_encontrados = []

    for device_name, tipo_esperado in mapeo_esperado.items():
        d = devices_by_name.get(device_name)
        if not d:
            no_encontrados.append(device_name)
            continue

        grupo_esperado = by_name.get(tipo_esperado)
        if not grupo_esperado:
            incorrectos.append((device_name, tipo_esperado, "grupo esperado no existe"))
            continue

        grupos_actuales_ids = {g.get("id") for g in d.get("groups", [])}
        grupos_actuales_nombres = [by_id.get(gid, {}).get("name", gid) for gid in grupos_actuales_ids]

        if grupo_esperado["id"] in grupos_actuales_ids:
            correctos += 1
        else:
            incorrectos.append((device_name, tipo_esperado, f"tiene: {grupos_actuales_nombres}"))

    print(f"Vehiculos correctos: {correctos}/{len(mapeo_esperado)}")

    if no_encontrados:
        print(f"\n[AVISO] {len(no_encontrados)} vehiculos del CSV no se encontraron en Geotab:")
        for n in no_encontrados:
            print(f"  - {n}")

    if incorrectos:
        print(f"\n[ERROR] {len(incorrectos)} vehiculos con problema:")
        for device_name, esperado, detalle in incorrectos:
            print(f"  - {device_name}: se esperaba '{esperado}', {detalle}")
    else:
        print("\nTodos los vehiculos tienen su tipologia asignada correctamente.")


if __name__ == "__main__":
    main()
