# Fix de raíz: "Unexpected end of JSON input" — multiCall partido en lotes

Fecha: 2026-09-23
Versión: 1.12 → 1.13

## Qué cambió

`apiMultiCall` ahora parte automáticamente cualquier lista de llamadas de
más de `TAMANO_LOTE_MULTICALL` (15) en lotes secuenciales, cada uno
disparado como su propio `api.multiCall` real hacia Geotab. Los resultados
se recomponen en el mismo orden que la lista original, así que ningún
código que consuma `apiMultiCall` (indexando `resultados[i]` con
`llamadas[i]`) tuvo que cambiar.

## Por qué

Los fixes anteriores (agrupación por cercanía temporal + separar PTO de
RPM) resolvieron el límite de **cantidad** de llamadas por minuto (1000),
pero dejaron sin resolver un problema distinto: un solo `multiCall` con
cientos de consultas de RPM de alta resolución, aunque esté bajo el límite
de cuota, puede devolver una respuesta combinada tan grande (potencialmente
cientos de miles de filas de StatusData en un solo JSON) que la conexión la
corta a medias antes de que termine de transmitirse — el navegador recibe
un JSON incompleto y `JSON.parse` falla con "Unexpected end of JSON input".
Este es un límite de **tamaño de respuesta / red**, no de cuota de API, así
que ningún ajuste al conteo de llamadas lo iba a arreglar por sí solo.

Partir en lotes de 15 llamadas por `multiCall` real acota el tamaño de cada
respuesta individual, evitando el corte, a costa de más viajes de ida y
vuelta secuenciales (aceptable: siguen siendo solicitudes rápidas, y el
total de llamadas ya está bien controlado desde el fix anterior).

## Archivos

- `dashboardAnalisisPTO.js` — `apiMultiCall` ahora hace batching interno
  automático; ningún llamador cambió.
- `config.json` — versión 1.12 → 1.13.
