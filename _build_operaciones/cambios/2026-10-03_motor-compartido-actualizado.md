# Motor de renderizado compartido actualizado

**Fecha:** 2026-10-03
**Versión:** 1.2 → 1.3
**Archivos:** `operaciones.js` (`MOTOR_JS_EMBEBIDO` regenerado), `config.json`, `Operaciones_addin.zip`

## Qué cambió

`MOTOR_JS_EMBEBIDO` se regeneró desde `_build_reportes/reporte_runtime_engine.js`
para mantenerlo idéntico al que lleva Mantenimiento. El cambio del motor es el
campo opcional `DASH.hiddenCategories`, usado solo por el reporte de Fallas
de Mantenimiento (ver `_build_reportes/cambios/2026-10-03_ocultar-sin-clasificar.md`).
El reporte de Operaciones (`habits_dashboard`) no lo usa: su comportamiento
no cambia.

## Verificación

Corrida real en Chromium con la API real (Bogotá, última semana): 12/12
gráficas renderizadas, 0 errores de API, de consola ni del reporte descargado.
Mismas cifras que la 1.2: velocidad 2.135, ralentí 1.004, PTO 1.265 (±1 por la
hora de la consulta).
