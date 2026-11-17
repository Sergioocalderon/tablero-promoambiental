"""Ensambla el add-in "Seguimiento de Velocidad" de MyGeotab a partir de sus piezas.

    _build_velocidad/logica.js                    lógica pura (velocidad sostenida, severidad) -- se prueba aparte
    _build_velocidad/datos.js                     API de Geotab, alcance y lectura de la velocidad del motor
    _build_regeneracion_comun/ui.js               kit de diseño compartido con los demás add-ins
    _build_velocidad/seguimientoVelocidad.parte.js  pantalla
    _build_velocidad/config.json                  manifiesto (nombre y versión)

Escribe seguimientoVelocidad.js y seguimientoVelocidad.html en _build_velocidad/ (ARCHIVOS
GENERADOS: se editan las piezas, no el resultado) y arma SeguimientoVelocidad_addin.zip en la
raíz del repo, listo para subir a MyGeotab.

    python construir_addin_velocidad.py
"""
import json
import pathlib
import zipfile

CARPETA_REPO = pathlib.Path(__file__).resolve().parent.parent
CARPETA = CARPETA_REPO / '_build_velocidad'
UI_COMUN = CARPETA_REPO / '_build_regeneracion_comun' / 'ui.js'
ARCHIVO = 'seguimientoVelocidad'

CABECERA_JS = """/* ARCHIVO GENERADO por herramientas/construir_addin_velocidad.py -- NO EDITAR A MANO.
   Editar _build_velocidad/*.js (o _build_regeneracion_comun/ui.js) y volver a ejecutar el script. */

geotab.addin.seguimientoVelocidad = function () {
  'use strict';
"""

HTML = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <!-- Geotab elimina las etiquetas <style>: todo el estilo se aplica por JS (CSSOM) en seguimientoVelocidad.js -->
</head>
<body>
  <div id="seguimientoVelocidadRoot"></div>
  <script src="seguimientoVelocidad.js"></script>
</body>
</html>
"""


def main():
    piezas = [CARPETA / 'logica.js', CARPETA / 'datos.js', UI_COMUN, CARPETA / f'{ARCHIVO}.parte.js']
    js = CABECERA_JS + ''.join(p.read_text(encoding='utf-8') for p in piezas) + '\n};\n'
    (CARPETA / f'{ARCHIVO}.js').write_text(js, encoding='utf-8', newline='\n')
    (CARPETA / f'{ARCHIVO}.html').write_text(HTML, encoding='utf-8', newline='\n')

    config = json.loads((CARPETA / 'config.json').read_text(encoding='utf-8'))
    destino = CARPETA_REPO / 'SeguimientoVelocidad_addin.zip'
    with zipfile.ZipFile(destino, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in ('config.json', f'{ARCHIVO}.html', f'{ARCHIVO}.js'):
            z.write(CARPETA / f, f)
    print(f"{config['name']} v{config['version']}: {destino.name} ({destino.stat().st_size // 1024} KB, {len(js.splitlines())} líneas de JS)")


if __name__ == '__main__':
    main()
