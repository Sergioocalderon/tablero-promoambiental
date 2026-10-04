# Bug real: "RPM pico" en N/D por truncamiento de página en StatusData

Fecha: 2026-09-23
Versión: 1.7 → 1.8

## Qué cambió

`confirmarPtoCercano` y `agregarPicoRpm` ahora detectan cuándo la consulta
agrupada por vehículo (ventana min/max de sus propios candidatos, ver
`cambios/2026-09-22_ventana-statusdata-por-vehiculo.md`) viene truncada por
el límite de página de Geotab (`LIMITE_PAGINA_STATUSDATA = 50000`, mismo
límite que `herramientas/geotab_comun.py`). Cuando eso pasa, SOLO para ese
vehículo puntual se vuelve a consultar evento por evento (ventana de
segundos/minutos, nunca se acerca al límite) — el resto de la flota sigue
con la consulta agrupada rápida de siempre.

## Por qué

El usuario reportó que la columna "RPM pico" salía "N/D" para TODOS los
eventos de un vehículo (1159-NWY131) en el nuevo panel de Historial.

Se investigó con datos reales de Geotab: ese vehículo tenía 204 candidatos
confirmados en 2 semanas, repartidos en varios días. El diagnóstico de RPM
de alta resolución reporta TAN seguido que **18 horas** de datos de ese
vehículo ya llenaban las 50,000 filas del límite de página por defecto de
Geotab. Como la consulta agrupada por vehículo (introducida el 2026-09-22
para arreglar el sobre-pedido global) pide desde el candidato MÁS ANTIGUO
hasta el MÁS RECIENTE de ese vehículo —que en este caso abarcaba varios
días—, la respuesta se cortaba antes de cubrir todo el rango, y los eventos
que caían después del corte se quedaban sin ninguna lectura de RPM cercana,
aunque el vehículo sí tuviera datos reales en ese momento.

Es la misma clase de riesgo que ya documenta
`herramientas/detectar_regeneracion_dpf.py` (advertencia cuando una
consulta devuelve exactamente el límite de página) — ahora también cubierto
acá.

## Archivos

- `dashboardAnalisisPTO.js` — nueva constante `LIMITE_PAGINA_STATUSDATA`;
  `confirmarPtoCercano` y `agregarPicoRpm` detectan truncamiento por
  vehículo y aplican un fallback de consulta por evento solo donde hace
  falta.
- `config.json` — versión 1.7 → 1.8.
