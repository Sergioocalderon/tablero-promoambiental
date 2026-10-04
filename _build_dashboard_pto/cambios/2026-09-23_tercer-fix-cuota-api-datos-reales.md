# Tercera corrección de "API calls quota exceeded" — calibrada con datos reales medidos

Fecha: 2026-09-23
Versión: 1.10 → 1.11

## Qué cambió

La corrección anterior (agrupación por cercanía temporal, 2h de hueco,
aplicada a AMBAS funciones) seguía fallando. Se midió directamente contra
datos reales de Geotab en vez de seguir ajustando a ciegas:

- **7,910 candidatos crudos en 47 vehículos** en 2 semanas — la agrupación
  por cercanía (gap=2h) generaba **765 llamadas SOLO para
  `confirmarPtoCercano`**, ya casi al límite de 1000 por sí sola, antes de
  sumar `agregarPicoRpm` ni el periodo anterior.
- Se midió la densidad REAL de cada diagnóstico por separado: el pulso de
  PTO (`DiagnosticPowerTakeoffEngagedId`) es mucho menos denso de lo
  asumido — el vehículo más activo de la flota (760 candidatos en 2
  semanas) solo genera **10,806 filas de PTO en las 2 semanas COMPLETAS**
  (sin acotar por candidatos), muy por debajo del límite de página de
  50,000. **`confirmarPtoCercano` nunca necesitaba agrupación.**
- El RPM de alta resolución sí es denso (confirmado antes: 18h de un solo
  vehículo ya llenan 50,000 filas) — ahí sí hace falta agrupar.

Cambios en el código:
- `confirmarPtoCercano` vuelve a una sola ventana `[min,max]` por vehículo
  (sin agrupar) — ~47 llamadas, verificado seguro con datos reales.
- `agregarPicoRpm` mantiene la agrupación por cercanía, pero ahora con un
  **tope de crecimiento por racha** (`VENTANA_TOPE_RACHA_RPM_MS = 20h`)
  además del hueco de fusión (`VENTANA_AGRUPACION_RPM_MS = 12h`) — evita
  que una racha de actividad casi continua reconstruya sin querer la misma
  ventana gigante que se intentaba evitar.
- `agruparPorCercania`/`construirVentanasPorVehiculo` quedaron genéricas
  (reciben `maxGapMs`/`maxSpanMs`) — `confirmarPtoCercano` las llama con
  `Infinity`/`Infinity` (una sola racha = todo el vehículo, igual que
  antes de introducir agrupación), `agregarPicoRpm` con los topes reales.

Estimado de llamadas total con estos cambios: ~47 (PTO, pasada principal) +
~400 (RPM agrupado, solo pasada principal) + ~47 (PTO, periodo anterior) +
un puñado de llamadas cacheadas/únicas ≈ **~500**, con margen amplio bajo
el límite de 1000/min (antes: ~1530+ solo en la pasada principal).

## Por qué

El usuario reportó que el segundo intento (agrupación con 2h de hueco para
ambas funciones) seguía dando el mismo error. Medir en vez de seguir
ajustando parámetros a ciegas mostró que el problema real era tratar PTO
como si fuera tan denso como RPM, cuando en realidad nunca necesitó el
tratamiento especial.

## Archivos

- `dashboardAnalisisPTO.js` — `agruparPorCercania`/`construirVentanasPorVehiculo`
  generalizadas con tope de racha; `confirmarPtoCercano` sin agrupación;
  `agregarPicoRpm` con gap=12h + tope=20h.
- `config.json` — versión 1.10 → 1.11.
