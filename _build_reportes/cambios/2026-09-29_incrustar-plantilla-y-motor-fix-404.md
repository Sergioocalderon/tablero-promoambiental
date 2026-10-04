# Incrustar plantilla y motor en reportes.js (corrige 404 real en MyGeotab)

**Fecha:** 2026-09-29
**Archivo:** `_build_reportes/reportes.js`

## Bug real reportado por el usuario

Al instalar el Local Add-In en MyGeotab (zip con `config.json`, `reportes.html`,
`reportes.js`, `reporte_plantilla.html`, `reporte_runtime_engine.js`) y generar
un reporte, la consola mostró: **"No se pudo cargar reporte_runtime_engine.js
(HTTP 404)"**. `reportes.js` sí cargó y se ejecutó (el error viene de su propio
`fetch()`), pero el segundo archivo hermano no se sirvió -- Geotab no expone
de forma confiable más de un archivo estático dentro de un Local Add-In vía
`fetch()` en tiempo de ejecución, al menos como está instalado.

## Corrección

En vez de investigar más a fondo el mecanismo de servido de archivos de
MyGeotab (variable entre instalaciones/versiones), se elimina la dependencia
por completo: `reporte_plantilla.html` y `reporte_runtime_engine.js` se
incrustan como STRINGS dentro de `reportes.js` (`PLANTILLA_HTML_EMBEBIDA` /
`MOTOR_JS_EMBEBIDO`), generados con `json.dumps(..., ensure_ascii=True)` desde
los archivos originales -- sin retipear ni escapar nada a mano, así se
garantiza que el contenido es idéntico y el resultado es ASCII puro (evita
cualquier problema de encoding al servir el archivo). Se verificó
programáticamente que ambos literales decodifican exactamente al contenido
original (mismo `len()`, mismo inicio/fin) y que el archivo final queda
balanceado en paréntesis/llaves/corchetes.

`obtenerTextoArchivo`/`obtenerPlantillaYMotor` (las funciones que hacían
`fetch()`) y las cachés `cacheMotorJs`/`cachePlantillaHtml` se eliminaron por
completo -- ya no hacen falta, la generación del reporte ahora es síncrona en
ese paso.

`reporte_plantilla.html` y `reporte_runtime_engine.js` **se mantienen en la
carpeta** como copia legible de referencia (para editar el diseño/motor del
reporte más adelante sin tener que decodificar el string embebido), pero
**ya no se leen en tiempo de ejecución** -- si se edita alguno de los dos,
hay que regenerar el literal embebido en `reportes.js` (con
`json.dumps(texto, ensure_ascii=True)` sobre el archivo editado) y volver a
pegarlo, no basta con editar el archivo suelto.

## Zip de instalación

Se regeneró `Reportes_addin.zip` (raíz del repo) con solo 3 archivos ahora
que el add-in es autosuficiente: `config.json`, `reportes.html`, `reportes.js`.
