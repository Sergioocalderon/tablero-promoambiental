import os
from dotenv import load_dotenv
import mygeotab

load_dotenv()

USERNAME = os.getenv("GEOTAB_USUARIO")
PASSWORD = os.getenv("GEOTAB_CONTRASENA")
DATABASE = os.getenv("GEOTAB_DATABASE")
SERVER = os.getenv("GEOTAB_SERVER", "my.geotab.com")

# Mapeo explicito: id del grupo -> nuevo nombre estandarizado
# Agregá aca mas filas si encontramos mas inconsistencias.
RENOMBRAR = {
    "b2C8D": "INTERNATIONAL - HV607",
    "b2C93": "INTERNATIONAL - HV607",
    "b2C8E": "MERCEDES - ATEGO 3133",
}


def main():
    api = mygeotab.API(
        username=USERNAME,
        password=PASSWORD,
        database=DATABASE,
        server=SERVER,
    )
    api.authenticate()

    groups = api.call("Get", typeName="Group")
    by_id = {g["id"]: g for g in groups}

    print("=== CAMBIOS PROPUESTOS (dry run, todavia no se aplica nada) ===\n")
    cambios = []
    for group_id, nuevo_nombre in RENOMBRAR.items():
        grupo = by_id.get(group_id)
        if not grupo:
            print(f"  [AVISO] No se encontro el grupo con id={group_id}, se omite.")
            continue
        nombre_actual = grupo.get("name")
        if nombre_actual == nuevo_nombre:
            print(f"  '{nombre_actual}' (id={group_id}) ya esta correcto, se omite.")
            continue
        print(f"  '{nombre_actual}'  ->  '{nuevo_nombre}'   (id={group_id})")
        cambios.append((grupo, nuevo_nombre))

    if not cambios:
        print("\nNo hay cambios pendientes. Nada que hacer.")
        return

    print(f"\nTotal de grupos a renombrar: {len(cambios)}")
    respuesta = input("\nEscribi SI para aplicar estos cambios en Geotab (cualquier otra cosa cancela): ")

    if respuesta.strip().upper() != "SI":
        print("Cancelado. No se aplico ningun cambio.")
        return

    print("\nAplicando cambios...")
    for grupo, nuevo_nombre in cambios:
        grupo["name"] = nuevo_nombre
        api.call("Set", typeName="Group", entity=grupo)
        print(f"  OK: {grupo['id']} -> '{nuevo_nombre}'")

    print("\nListo. Todos los cambios se aplicaron correctamente.")


if __name__ == "__main__":
    main()