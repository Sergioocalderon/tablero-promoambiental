# Dashboard de Análisis de Fallas v2.8 — el FMI 0 ya no sale como "FMI ?"

**Fecha:** 2026-11-03
**Versión:** 2.7 → 2.8
**Archivos:** `dashboardAnalisisFallas.js`, `config.json`, `DashboardFallas_addin.zip`

## Problema
`fmi: fmInfo.codigo || '?'` (y lo mismo con el SPN) descartaba el código 0, porque en JavaScript el cero es falso. El FMI 0 ("dato por encima del rango normal, nivel más severo") salía como "FMI ?" en el código más repetido, en la tabla de códigos y en el resumen narrativo, justo para la clase más grave.

## Cambio
- Nueva función `valorODesconocido(v)`: devuelve `'?'` solo si el valor es `null`, `undefined` o vacío; el 0 se conserva.
- `agregarPorCodigo` la usa para `spn` y `fmi`.
- La clave de agrupación ya comparaba contra `null/undefined`, así que el agrupamiento por SPN/FMI no cambia.
- Mismo arreglo que `valorODesconocido` en Alertas por Severidad (v1.18) y `_codigo_o_desconocido` en `telegram_alertas.py`.

## Probado
Chromium: el archivo completo parsea sin errores y `valorODesconocido` devuelve `[0, 101, '?', '?', '?']` para `[0, 101, null, undefined, '']`. No probado con datos reales dentro de MyGeotab.
