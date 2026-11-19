"""
Traduce un código de falla de Geotab (SPN/FMI) con el Diccionario_Fallas.csv del proyecto.

Para quien saca reportes de fallas directo de la API de Geotab: Geotab nombra todos los códigos con el
diccionario J1939 genérico, y algunas marcas usan esos números con otro significado (ej. VW Delivery:
SPN 1814/FMI 5 es el intermitente delantero, no "VDC completamente operativo").

Regla de búsqueda (en este orden):
  1. Fila con el mismo SPN y FMI cuyo Motor_Aplica sea uno de los grupos del vehículo en Geotab
     (nombre exacto, ej. 'VOLSKWAGEN - DELIVERY 9.170'), contando los grupos padre.
  2. Fila con Motor_Aplica = 'Generico'.
  3. Si no hay fila: el nombre que da Geotab.
(Las filas con Motor_Aplica = 'X12' son del motor Cummins X12; quien las use debe saber qué vehículos lo tienen.)

El diccionario vigente se puede leer siempre desde GitHub (repo público, sin datos sensibles):
    https://raw.githubusercontent.com/Sergioocalderon/tablero-promoambiental/main/Diccionario_Fallas.csv

Uso:
    from traducir_falla import cargar_diccionario, describir
    dic = cargar_diccionario()                         # local, o cargar_diccionario(URL_DICCIONARIO)
    describir(dic, 1814, 5, ['VOLSKWAGEN - DELIVERY 9.170'], 'VDC completamente operativo')
"""
import csv
import io
import urllib.request
from pathlib import Path

URL_DICCIONARIO = 'https://raw.githubusercontent.com/Sergioocalderon/tablero-promoambiental/main/Diccionario_Fallas.csv'
RUTA_LOCAL = Path(__file__).resolve().parent.parent / 'Diccionario_Fallas.csv'


def cargar_diccionario(origen=RUTA_LOCAL):
    """Devuelve {(spn, fmi): [filas]} leyendo el CSV local o una URL."""
    if str(origen).startswith('http'):
        texto = urllib.request.urlopen(origen, timeout=30).read().decode('utf-8-sig')
    else:
        texto = Path(origen).read_text(encoding='utf-8-sig')
    dic = {}
    for f in csv.DictReader(io.StringIO(texto)):
        try:
            dic.setdefault((int(f['SPN']), int(f['FMI'])), []).append(f)
        except (TypeError, ValueError):
            continue   # filas sin SPN/FMI numérico
    return dic


def describir(dic, spn, fmi, grupos_vehiculo=(), nombre_geotab=None):
    """Devuelve (descripcion, criticidad, fuente). fuente: 'marca' | 'generico' | 'geotab'."""
    filas = dic.get((int(spn), int(fmi)), [])
    grupos = {str(g).strip().upper() for g in grupos_vehiculo}
    for f in filas:
        if f['Motor_Aplica'].strip().upper() in grupos:
            return f['Descripcion'], f['Criticidad'], 'marca'
    for f in filas:
        if f['Motor_Aplica'] == 'Generico':
            return f['Descripcion'], f['Criticidad'], 'generico'
    return nombre_geotab, None, 'geotab'


if __name__ == '__main__':
    d = cargar_diccionario()
    vw = ['PROMO AMBIENTAL DISTRITO BOGOTA', 'VOLSKWAGEN - DELIVERY 9.170']
    desc, _, fuente = describir(d, 1814, 5, vw, 'VDC completamente operativo')
    assert fuente == 'marca' and 'Intermitente delantero' in desc, desc
    assert describir(d, 1814, 5, ['INTERNATIONAL - HV607'], 'VDC')[2] != 'marca'
    assert describir(d, 99999, 9, vw, 'Nombre Geotab') == ('Nombre Geotab', None, 'geotab')
    print('autochequeo OK ·', desc[:60])
