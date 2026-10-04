# Bug real: el fix de ayer disparó "API calls quota exceeded"

Fecha: 2026-09-23
Versión: 1.8 → 1.9

## Qué cambió

El fallback anti-truncamiento de `confirmarPtoCercano`/`agregarPicoRpm`
(agregado hoy mismo para arreglar el "RPM pico" en N/D, ver
`cambios/2026-09-23_bug-rpm-pico-truncado-por-paginacion.md`) pasó de
re-consultar **por evento** a re-consultar **por bloques de tiempo fijos**
(`construirLlamadasPorChunks`, nueva función compartida): 8 horas por
bloque para RPM, 24 horas para PTO.

## Por qué

La primera versión del fallback (por evento) funcionó para arreglar el
"N/D", pero generó una cantidad de llamadas proporcional a la cantidad de
EVENTOS del vehículo truncado — con 1159-NWY131 (204 candidatos) eso fueron
204 llamadas extra solo para ese vehículo. Entre eso, que el mismo patrón se
repite para el periodo anterior (comparación de KPIs), y el resto del
pipeline normal, la sesión chocó con el límite duro de Geotab: "API calls
quota exceeded. Maximum admitted 1000 per 1m" — el usuario reportó el error
directamente en pantalla.

Los bloques de tiempo fijos acotan el fallback al tamaño del **rango**
analizado, no a la cantidad de eventos del vehículo: un vehículo con 5
candidatos y uno con 500 candidatos en el mismo rango de 2 semanas generan
la MISMA cantidad de llamadas de fallback (como mucho 42 para RPM, 14 para
PTO, si sus candidatos abarcan las 2 semanas completas). El tamaño de los
bloques se calibró contra el peor caso real encontrado ayer (18h de RPM de
ese vehículo ya llenaban 50,000 filas) dejando margen amplio.

## Archivos

- `dashboardAnalisisPTO.js` — nueva función `construirLlamadasPorChunks`
  (compartida), `confirmarPtoCercano` y `agregarPicoRpm` reemplazan el
  fallback por evento por el fallback por bloques de tiempo.
- `config.json` — versión 1.8 → 1.9.
