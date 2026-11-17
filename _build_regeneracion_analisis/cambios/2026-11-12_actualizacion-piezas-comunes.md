# Análisis de Regeneraciones DPF v1.1 — actualización con las piezas comunes del 3/11

**Fecha:** 2026-11-12
**Versión:** 1.1 (antes 1.0, zip del 28/10)
**Archivos:** `config.json` (solo la versión) y `analisisRegeneracion.js` (regenerado, sin cambio en su parte propia)

## Qué cambió

Sin cambios en la pantalla propia del add-in. El zip estaba desactualizado frente a las piezas comunes
(`_build_regeneracion_comun/`) y ahora las incluye:
- Hollín pegado en el techo (2 o más lecturas seguidas >= 199 %) se toma como real y no como ruido.
- El testigo del filtro con valor 2 se lee como "regeneración necesaria", no como regeneración activa.
- Gráfica con la meseta del tope del sensor.

Detalle en `_build_regeneracion_seguimiento/cambios/2026-11-03_testigo-necesaria-y-hollin-en-el-techo.md`.
