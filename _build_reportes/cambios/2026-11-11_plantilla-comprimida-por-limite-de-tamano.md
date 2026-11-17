# Mantenimiento v3.3 — plantilla comprimida (MyGeotab no dejaba guardar el add-in)

**Problema:** con v3.2 MyGeotab no dejaba guardar el add-in, mientras otros sí. Diferencia medida: `mantenimiento.js` pesaba **399 KB** (los demás, 147–187 KB) y tenía una línea de **332.103 caracteres** (la plantilla del reporte incrustada como un solo texto). Se informó que MyGeotab limita el tamaño.

## Cambio
- La plantilla `reporte_plantilla_v2.html` (313 KB) se incrusta **comprimida** (zlib + base64, líneas de 160 caracteres) entre las marcas `PLANTILLA_COMPRIMIDA` de `mantenimiento.js`.
- `obtenerPlantilla()` la descomprime en el navegador con `DecompressionStream('deflate')` al generar el reporte (una sola vez; queda en memoria).
- `incrustar_plantilla_v2.py` regenera el bloque (también lo reemplaza si ya existe).
- Resultado: `mantenimiento.js` **181 KB**, línea más larga 306 caracteres. El reporte generado es el mismo.

## Probado
- Node: `pruebas/prueba_escopos.js` 21 ✓, incluye que la plantilla comprimida es idéntica a `reporte_plantilla_v2.html`.
- Chrome headless: la descompresión da el mismo texto (huella SHA-256 idéntica) y la segunda llamada usa la copia en memoria.
- **No probado dentro de MyGeotab** (guardado y generación real del reporte).

## Requisito
Navegador con `DecompressionStream` (Chrome/Edge 80+, Firefox 113+, Safari 16.4+). Si falta, el add-in muestra un mensaje en vez de generar el reporte.
