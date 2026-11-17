# Alertas por Severidad v1.21 — "Sin evidencia" separado por causa

**Problema:** en v1.20 el estado "Sin evidencia" juntaba cuatro motivos distintos y el motivo solo se veía al pasar el mouse. No se podía ver de un vistazo qué vehículos tenían un problema de dispositivo; se mezclaban con los que estaban parados (42 de 43 en los datos del 3/11).

## Cambio
Cada código "sin evidencia" lleva ahora `tipoSE` y `motivoCorto`:

| Tipo | Cuándo | Pastilla | Motivo visible |
|---|---|---|---|
| `dispositivo` | el dispositivo no comunica en 24 h, o no llegan señales del motor | **Falla de dispositivo** (naranja) | "Dispositivo sin comunicar" / "Sin señal del motor" |
| `parado` | el vehículo recorrió menos de 5 km desde el reporte | Vehículo parado | – |
| `consulta` | no se pudo consultar a Geotab | No consultado | – |

- Filtro **Confirmación**: Todas / Solo confirmadas / Por verificar / Sin evidencia (todas) / **Falla de dispositivo** / Vehículo parado / No se pudo consultar.
- Tarjeta de códigos: un enlace por cada causa (solo aparece si hay casos); "Falla de dispositivo" va en naranja.
- La pastilla pasa a dos líneas para no invadir la columna siguiente. En la vista por vehículo la cabecera muestra la misma etiqueta.
- La criticidad y la regla de confirmación no cambian.

## Probado (Chromium, API simulada)
- 8 vehículos: filtro "Falla de dispositivo" → 1149-NWX185 (sin señal del motor) y 2012-CLI002 (sin comunicar); "Vehículo parado" → 3800-GVU033; "Por verificar" → 3 códigos; "Confirmadas" → 4.
- Con la consulta de viajes caída: los 6 códigos viejos quedan "No consultado" (no cuentan como falla de dispositivo).
- Regresión de v1.19/v1.20 (pausa de recarga, expediente, filtros, KPI): sin errores de consola.
- No probado dentro de MyGeotab.
