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

    mapeo = leer_mapeo(CSV_PATH)
    tipologias_unicas = sorted(set(mapeo.values()))

    groups = api.call("Get", typeName="Group")
    by_name = {g.get("name"): g for g in groups}
    devices = api.call("Get", typeName="Device")
    devices_by_name = {d.get("name"): d for d in devices}

    print("=== PLAN (dry run, todavia no se aplica nada) ===\n")

    padre = by_name.get(NOMBRE_GRUPO_PADRE)
    if padre:
        print(f"Grupo padre '{NOMBRE_GRUPO_PADRE}' ya existe (id={padre['id']})")
    else:
        print(f"Se creara el grupo padre '{NOMBRE_GRUPO_PADRE}' (bajo Entire Organization)")

    print("\nSubgrupos de tipologia:")
    for t in tipologias_unicas:
        existente = by_name.get(t)
        if existente:
            print(f"  '{t}' ya existe (id={existente['id']})")
        else:
            print(f"  Se creara subgrupo '{t}'")

    print(f"\nVehiculos a actualizar: {len(mapeo)}")
    sin_device = []
    for device_name, tipo in mapeo.items():
        d = devices_by_name.get(device_name)
        if not d:
            sin_device.append(device_name)
            continue
        grupos_actuales = [g.get("name") for g in d.get("groups", [])]
        print(f"  {device_name}: grupos actuales {grupos_actuales} -> se agrega '{tipo}'")

    if sin_device:
        print(f"\n[AVISO] {len(sin_device)} vehiculos del CSV no se encontraron en Geotab: {sin_device}")

    respuesta = input("\nEscribi SI para aplicar estos cambios en Geotab (cualquier otra cosa cancela): ")
    if respuesta.strip().upper() != "SI":
        print("Cancelado. No se aplico ningun cambio.")
        return

    print("\nAplicando cambios...")

    if not padre:
        nuevo_id = api.call("Add", typeName="Group", entity={"name": NOMBRE_GRUPO_PADRE})
        padre = {"id": nuevo_id, "name": NOMBRE_GRUPO_PADRE}
        print(f"  OK: grupo padre creado (id={nuevo_id})")

    subgrupo_por_tipo = {}
    for t in tipologias_unicas:
        existente = by_name.get(t)
        if existente:
            subgrupo_por_tipo[t] = existente
        else:
            nuevo_id = api.call(
                "Add",
                typeName="Group",
                entity={"name": t, "parent": {"id": padre["id"]}},
            )
            subgrupo_por_tipo[t] = {"id": nuevo_id, "name": t}
            print(f"  OK: subgrupo '{t}' creado (id={nuevo_id})")

    for device_name, tipo in mapeo.items():
        d = devices_by_name.get(device_name)
        if not d:
            continue
        grupo_tipo = subgrupo_por_tipo[tipo]
        grupos_actuales_ids = {g.get("id") for g in d.get("groups", [])}
        if grupo_tipo["id"] in grupos_actuales_ids:
            print(f"  {device_name}: ya tenia el grupo '{tipo}', se omite")
            continue
        d.setdefault("groups", []).append({"id": grupo_tipo["id"]})
        api.call("Set", typeName="Device", entity=d)
        print(f"  OK: {device_name} -> agregado a '{tipo}'")

    print("\nListo. Todos los cambios se aplicaron correctamente.")


if __name__ == "__main__":
    main()