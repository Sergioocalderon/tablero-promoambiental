"""Ensambla el add-in "Validación de Baterías" de MyGeotab a partir de sus piezas.

    _build_baterias/logica.js                  lógica pura (arranques, ESR, estados) -- se prueba aparte
    _build_baterias/datos.js                   API de Geotab, alcance y carga de señales
    _build_regeneracion_comun/ui.js            kit de diseño compartido con los add-ins de regeneración
    _build_baterias/validacionBaterias.parte.js  pantalla
    _build_baterias/config.json                manifiesto (nombre y versión)

Escribe validacionBaterias.js y validacionBaterias.html en _build_baterias/ (ARCHIVOS
GENERADOS: se editan las piezas, no el resultado) y arma ValidacionBaterias_addin.zip en
la raíz del repo, listo para subir a MyGeotab.

    python construir_addin_baterias.py
"""
import json
import pathlib
import zipfile

CARPETA_REPO = pathlib.Path(__file__).resolve().parent.parent
CARPETA = CARPETA_REPO / '_build_baterias'
UI_COMUN = CARPETA_REPO / '_build_regeneracion_comun' / 'ui.js'
ARCHIVO = 'validacionBaterias'
CHART_JS = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'

CABECERA_JS = """/* ARCHIVO GENERADO por herramientas/construir_addin_baterias.py -- NO EDITAR A MANO.
   Editar _build_baterias/*.js (o _build_regeneracion_comun/ui.js) y volver a ejecutar el script. */

geotab.addin.validacionBaterias = function () {
  'use strict';
"""

HTML = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <!-- Geotab elimina las etiquetas <style>: todo el estilo se aplica por JS (CSSOM) en validacionBaterias.js -->
  <script src="%s"></script>
</head>
<body>
  <div id="validacionBateriasRoot"></div>
  <script src="validacionBaterias.js"></script>
</body>
</html>
""" % CHART_JS


def main():
    piezas = [CARPETA / 'logica.js', CARPETA / 'datos.js', UI_COMUN, CARPETA / f'{ARCHIVO}.parte.js']
    js = CABECERA_JS + ''.join(p.read_text(encoding='utf-8') for p in piezas) + '\n};\n'
    (CARPETA / f'{ARCHIVO}.js').write_text(js, encoding='utf-8', newline='\n')
    (CARPETA / f'{ARCHIVO}.html').write_text(HTML, encoding='utf-8', newline='\n')

    config = json.loads((CARPETA / 'config.json').read_text(encoding='utf-8'))
    destino = CARPETA_REPO / 'ValidacionBaterias_addin.zip'
    with zipfile.ZipFile(destino, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in ('config.json', f'{ARCHIVO}.html', f'{ARCHIVO}.js'):
            z.write(CARPETA / f, f)
    print(f"{config['name']} v{config['version']}: {destino.name} ({destino.stat().st_size // 1024} KB, {len(js.splitlines())} líneas de JS)")


if __name__ == '__main__':
    main()
