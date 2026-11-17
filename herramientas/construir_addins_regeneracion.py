"""Ensambla los 3 add-ins de regeneración DPF de MyGeotab a partir de las
piezas comunes y las partes específicas de cada uno.

    _build_regeneracion_comun/        logica_1_hollin.js, logica_2_lampara.js, datos.js, ui.js
    _build_regeneracion_<nombre>/     <archivo>.parte.js + config.json (+ cambios/)

Por cada add-in escribe <archivo>.js y <archivo>.html en su carpeta (ARCHIVOS
GENERADOS: se editan las piezas, no el resultado) y arma el zip listo para
subir a MyGeotab en la raíz del repo.

    python construir_addins_regeneracion.py            # arma los 3
    python construir_addins_regeneracion.py analisis   # solo uno
"""
import json
import pathlib
import sys
import zipfile

CARPETA_REPO = pathlib.Path(__file__).resolve().parent.parent
COMUN = CARPETA_REPO / '_build_regeneracion_comun'
PIEZAS_COMUNES = ['logica_1_hollin.js', 'logica_2_lampara.js', 'datos.js', 'ui.js']

# nombre corto -> (carpeta, archivo base, global de geotab.addin, id del contenedor, zip, ¿usa Chart.js?)
ADDINS = {
    'analisis': ('_build_regeneracion_analisis', 'analisisRegeneracion', 'analisisRegeneracion', 'analisisRegeneracionRoot', 'AnalisisRegeneracion_addin.zip', True),
    'seguimiento': ('_build_regeneracion_seguimiento', 'seguimientoRegeneracion', 'seguimientoRegeneracion', 'seguimientoRegeneracionRoot', 'SeguimientoRegeneracion_addin.zip', False),
    'reportes': ('_build_regeneracion_reportes', 'reportesRegeneracion', 'reportesRegeneracion', 'reportesRegeneracionRoot', 'ReportesRegeneracion_addin.zip', False),
}
CHART_JS = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'

CABECERA_JS = """/* ARCHIVO GENERADO por herramientas/construir_addins_regeneracion.py -- NO EDITAR A MANO.
   Editar _build_regeneracion_comun/*.js o {carpeta}/{archivo}.parte.js y volver a ejecutar el script. */

geotab.addin.{global_} = function () {{
  'use strict';
"""

HTML = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <!-- Geotab elimina las etiquetas <style>: todo el estilo se aplica por JS (CSSOM) en {archivo}.js -->
{chart}</head>
<body>
  <div id="{root}"></div>
  <script src="{archivo}.js"></script>
</body>
</html>
"""


def armar(nombre):
    carpeta_n, archivo, global_, root, zip_n, usa_chart = ADDINS[nombre]
    carpeta = CARPETA_REPO / carpeta_n
    parte = (carpeta / f'{archivo}.parte.js').read_text(encoding='utf-8')
    comunes = ''.join((COMUN / p).read_text(encoding='utf-8') for p in PIEZAS_COMUNES)
    js = CABECERA_JS.format(carpeta=carpeta_n, archivo=archivo, global_=global_) + comunes + '\n' + parte + '\n};\n'
    (carpeta / f'{archivo}.js').write_text(js, encoding='utf-8', newline='\n')
    chart = f'  <script src="{CHART_JS}"></script>\n' if usa_chart else ''
    html = HTML.format(archivo=archivo, root=root, chart=chart)
    (carpeta / f'{archivo}.html').write_text(html, encoding='utf-8', newline='\n')

    config = json.loads((carpeta / 'config.json').read_text(encoding='utf-8'))
    destino = CARPETA_REPO / zip_n
    with zipfile.ZipFile(destino, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in ('config.json', f'{archivo}.html', f'{archivo}.js'):
            z.write(carpeta / f, f)
    print(f"{config['name']} v{config['version']}: {destino.name} ({destino.stat().st_size // 1024} KB, {len(js.splitlines())} líneas de JS)")


if __name__ == '__main__':
    elegidos = sys.argv[1:] or list(ADDINS)
    for n in elegidos:
        armar(n)
