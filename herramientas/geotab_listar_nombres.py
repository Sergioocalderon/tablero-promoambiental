import os
from collections import defaultdict
from dotenv import load_dotenv
import mygeotab

load_dotenv()

USERNAME = os.getenv("GEOTAB_USUARIO")
PASSWORD = os.getenv("GEOTAB_CONTRASENA")
DATABASE = os.getenv("GEOTAB_DATABASE")
SERVER = os.getenv("GEOTAB_SERVER", "my.geotab.com")


def build_tree(groups):
    """Arma un diccionario parent_id -> [hijos] para imprimir el arbol de grupos."""
    children = defaultdict(list)
    by_id = {g["id"]: g for g in groups}
    for g in groups:
        parent = g.get("parent")
        parent_id = parent["id"] if parent else None
        children[parent_id].append(g)
    return children, by_id


def print_tree(children, node_id, by_id, device_count, level=0):
    for g in sorted(children.get(node_id, []), key=lambda x: x.get("name", "")):
        indent = "  " * level
        count = device_count.get(g["id"], 0)
        print(f"{indent}- {g.get('name')}  [id={g['id']}]  (vehiculos directos: {count})")
        print_tree(children, g["id"], by_id, device_count, level + 1)


def main():
    api = mygeotab.API(
        username=USERNAME,
        password=PASSWORD,
        database=DATABASE,
        server=SERVER,
    )
    api.authenticate()

    groups = api.call("Get", typeName="Group")
    devices = api.call("Get", typeName="Device")

    print(f"Total de grupos encontrados: {len(groups)}")
    print(f"Total de vehiculos encontrados: {len(devices)}\n")

    # Contar cuantos vehiculos estan asignados directamente a cada grupo
    device_count = defaultdict(int)
    devices_by_group = defaultdict(list)
    devices_sin_grupo = []

    for d in devices:
        grupos_del_device = d.get("groups", [])
        if not grupos_del_device:
            devices_sin_grupo.append(d.get("name"))
        for g in grupos_del_device:
            device_count[g["id"]] += 1
            devices_by_group[g["id"]].append(d.get("name"))

    children, by_id = build_tree(groups)

    print("=== ARBOL DE GRUPOS (Company Groups) ===")
    # El grupo raiz normalmente es "GroupCompanyId"
    print_tree(children, None, by_id, device_count)

    print("\n=== VEHICULOS SIN NINGUN GRUPO ASIGNADO ===")
    print(f"Total: {len(devices_sin_grupo)}")
    for n in devices_sin_grupo:
        print(f"  - {n}")

    print("\n=== DETALLE: VEHICULOS POR GRUPO ===")
    for g in sorted(groups, key=lambda x: x.get("name", "")):
        miembros = devices_by_group.get(g["id"], [])
        if miembros:
            print(f"\n{g.get('name')} ({len(miembros)} vehiculos):")
            for m in sorted(miembros):
                print(f"  - {m}")


if __name__ == "__main__":
    main()