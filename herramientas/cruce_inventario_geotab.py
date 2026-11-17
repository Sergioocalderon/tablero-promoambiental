"""
cruce_inventario_geotab.py -- cruza el inventario vehicular nacional (Excel,
manejado por el area administrativa) contra los Device que existen en Geotab,
por placa, para detectar:

  A) Vehiculos que el inventario dice "En servicio" pero que NO tienen ningun
     Device en Geotab con esa placa -- posible vacio de rastreo.
  B) Devices en Geotab que NO aparecen en "Flota en Servicio" del inventario --
     puede ser diferencia de formato de placa, o un vehiculo que el inventario
     no tiene registrado como en servicio.
  C) Devices en Geotab cuya placa SI aparece, pero en la hoja "Flota Inactiva"
     del inventario (no en servicio) -- inconsistencia real que vale la pena
     revisar: Geotab lo sigue rastreando pero administrativamente esta inactivo.

El inventario es nacional (488 vehiculos "en servicio", varias empresas del
grupo); esta cuenta de Geotab solo cubre una parte de esas empresas -- por eso
el punto A se agrupa por empresa, para distinguir "esta empresa SI tiene
Devices en esta cuenta de Geotab, y aun asi falta esta placa" de "esta empresa
entera no esta en esta cuenta de Geotab" (lo segundo no es un hueco real).

Uso:
    python cruce_inventario_geotab.py [--inventario RUTA] [--excel]
Por defecto busca el inventario en Descargas con el nombre mas reciente que
empiece por "InventarioNacional".
"""
import argparse
import glob
import pathlib
import re
from datetime import datetime
from zoneinfo import ZoneInfo

import openpyxl

from geotab_comun import conectar_geotab

ZONA_BOGOTA = ZoneInfo("America/Bogota")

# Remolques/equipo sin motor propio o maquinaria de patio -- nunca llevan GPS de
# flota, asi que aparecer en "faltan en Geotab" no es un hueco real. Coincidencia
# por substring (insensible a mayusculas) contra 'Tipo de Vehiculo' del inventario.
TIPOS_SIN_GPS_ESPERADO = [
    'semirremolque', 'tráiler', 'trailer', 'minicargador', 'retroexcavadora',
    'camabaja', 'carrotanque', 'chipper', 'poliguinda', 'lavacontenedores',
]


def tiene_gps_esperado(tipo_vehiculo):
    t = (tipo_vehiculo or '').lower()
    return not any(clave in t for clave in TIPOS_SIN_GPS_ESPERADO)


def normalizar_placa(valor):
    if valor is None:
        return None
    texto = re.sub(r'[^A-Z0-9]', '', str(valor).upper())
    return texto or None


def placa_desde_nombre_device(nombre):
    """El 'name' de un Device en esta cuenta viene como 'CODIGO-PLACA' (ej.
    '1158-SSX744', 'TUCAN66-SSX670') -- la placa es siempre el ultimo tramo."""
    if not nombre:
        return None
    return normalizar_placa(nombre.split('-')[-1])


def cargar_hoja_inventario(ruta, nombre_hoja, columnas_necesarias):
    wb = openpyxl.load_workbook(ruta, read_only=True, data_only=True)
    ws = wb[nombre_hoja]
    filas = list(ws.iter_rows(values_only=True))
    encabezado = [str(c).strip() if c else '' for c in filas[0]]
    indices = {}
    for objetivo in columnas_necesarias:
        try:
            indices[objetivo] = encabezado.index(objetivo)
        except ValueError:
            candidatos = [i for i, h in enumerate(encabezado) if h.startswith(objetivo[:6])]
            if not candidatos:
                raise ValueError(f"No se encontro la columna '{objetivo}' en la hoja '{nombre_hoja}'. Encabezado real: {encabezado}")
            indices[objetivo] = candidatos[0]

    filas_datos = []
    for f in filas[1:]:
        fila = {clave: f[idx] for clave, idx in indices.items()}
        filas_datos.append(fila)
    return filas_datos


def encontrar_inventario_por_defecto():
    candidatos = sorted(
        glob.glob(str(pathlib.Path.home() / 'Downloads' / 'InventarioNacional*.xlsx')),
        key=lambda p: pathlib.Path(p).stat().st_mtime, reverse=True
    )
    if not candidatos:
        raise FileNotFoundError("No se encontro ningun 'InventarioNacional*.xlsx' en Descargas -- pasa la ruta con --inventario.")
    return candidatos[0]


def exportar_excel(faltan_en_geotab, sin_registro_servicio, inactivos_en_geotab):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    hoja_por_defecto = wb.active

    def hoja(nombre, encabezados, filas, color_header='0F1B3D'):
        ws = wb.create_sheet(nombre)
        ws.append(encabezados)
        for celda in ws[1]:
            celda.font = Font(bold=True, color='FFFFFF')
            celda.fill = PatternFill('solid', fgColor=color_header)
        for f in filas:
            ws.append(f)
        ws.freeze_panes = 'A2'
        for i in range(1, len(encabezados) + 1):
            ws.column_dimensions[get_column_letter(i)].width = 24
        return ws

    hoja('Sin Geotab (en servicio)',
         ['Empresa', 'Placa', 'Código', 'Tipo de Vehículo'],
         [[f['empresa'], f['placa'], f['codigo'], f['tipo']] for f in faltan_en_geotab])

    hoja('Sin registro en inventario',
         ['Vehículo Geotab', 'Placa'],
         [[f['nombre'], f['placa']] for f in sin_registro_servicio])

    hoja('Geotab pero inventario Inactivo',
         ['Vehículo Geotab', 'Placa', 'Empresa', 'Detalle de Venta'],
         [[f['nombre'], f['placa'], f['empresa'], f['detalle_venta']] for f in inactivos_en_geotab])

    wb.remove(hoja_por_defecto)

    carpeta_salida = pathlib.Path(__file__).resolve().parent / 'reportes'
    carpeta_salida.mkdir(exist_ok=True)
    ruta = carpeta_salida / f"cruce_inventario_geotab_{datetime.now(ZONA_BOGOTA).strftime('%Y%m%d_%H%M')}.xlsx"
    wb.save(ruta)
    return ruta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventario', default=None, help='Ruta al Excel InventarioNacional.xlsx')
    parser.add_argument('--excel', action='store_true', help='Exportar el resultado a reportes/')
    args = parser.parse_args()

    ruta_inventario = args.inventario or encontrar_inventario_por_defecto()
    print(f"Inventario: {ruta_inventario}")

    servicio = cargar_hoja_inventario(ruta_inventario, 'Flota en Servicio', ['Empresa', 'Placa', 'Código', 'Tipo de Vehículo'])
    inactiva = cargar_hoja_inventario(ruta_inventario, 'Flota Inactiva', ['Empresa', 'Placa', 'Detalle de Venta'])

    servicio_por_placa = {}
    empresas_en_servicio = set()
    for f in servicio:
        placa = normalizar_placa(f['Placa'])
        if not placa:
            continue
        servicio_por_placa[placa] = f
        empresas_en_servicio.add((f['Empresa'] or '').strip())

    inactiva_por_placa = {}
    for f in inactiva:
        placa = normalizar_placa(f['Placa'])
        if placa:
            inactiva_por_placa[placa] = f

    api = conectar_geotab()
    print("Conectado a Geotab. Consultando flota...")
    devices = [d for d in api.get('Device') if d.get('groups')]

    placas_geotab = {}
    for d in devices:
        placa = placa_desde_nombre_device(d.get('name'))
        if placa:
            placas_geotab[placa] = d

    empresas_con_presencia_geotab = {
        emp for emp in empresas_en_servicio
        if any(normalizar_placa(f['Placa']) in placas_geotab
               for f in servicio if (f['Empresa'] or '').strip() == emp)
    }

    faltan_en_geotab = []
    for placa, f in servicio_por_placa.items():
        empresa = (f['Empresa'] or '').strip()
        tipo = f['Tipo de Vehículo']
        if empresa in empresas_con_presencia_geotab and placa not in placas_geotab and tiene_gps_esperado(tipo):
            faltan_en_geotab.append({'empresa': empresa, 'placa': placa, 'codigo': f['Código'], 'tipo': tipo})

    sin_registro_servicio = []
    inactivos_en_geotab = []
    for placa, d in placas_geotab.items():
        if placa in servicio_por_placa:
            continue
        if placa in inactiva_por_placa:
            fi = inactiva_por_placa[placa]
            inactivos_en_geotab.append({'nombre': d.get('name'), 'placa': placa, 'empresa': fi['Empresa'], 'detalle_venta': fi['Detalle de Venta']})
        else:
            sin_registro_servicio.append({'nombre': d.get('name'), 'placa': placa})

    faltan_en_geotab.sort(key=lambda f: (f['empresa'], f['placa']))
    sin_registro_servicio.sort(key=lambda f: f['nombre'] or '')
    inactivos_en_geotab.sort(key=lambda f: f['nombre'] or '')

    print(f"\nEmpresas con presencia en esta cuenta de Geotab: {sorted(empresas_con_presencia_geotab)}")
    print(f"\n🔴 En servicio segun inventario, tipo con GPS esperado, SIN Device en Geotab: {len(faltan_en_geotab)}")
    print("   (ya excluye remolques/maquinaria de patio sin motor propio: semirremolques,")
    print("    minicargadores, retroexcavadoras, camabajas, etc.)")
    from collections import Counter
    conteo_tipos = Counter(f['tipo'] for f in faltan_en_geotab)
    for tipo, n in conteo_tipos.most_common():
        print(f"   {n:4d}  {tipo}")

    print(f"\n🟡 Device en Geotab SIN registro en 'Flota en Servicio': {len(sin_registro_servicio)}")
    for f in sin_registro_servicio:
        print(f"   {f['nombre']:<20} placa={f['placa']}")

    print(f"\n⚠️  Device en Geotab pero el inventario lo marca INACTIVO: {len(inactivos_en_geotab)}")
    for f in inactivos_en_geotab:
        print(f"   {f['nombre']:<20} placa={f['placa']}  empresa={f['empresa']}  ({f['detalle_venta']})")

    if args.excel:
        ruta = exportar_excel(faltan_en_geotab, sin_registro_servicio, inactivos_en_geotab)
        print(f"\nExcel guardado en: {ruta}")


if __name__ == '__main__':
    main()
