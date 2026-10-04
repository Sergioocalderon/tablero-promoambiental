# Fix: el tablero se quedaba pegado en "Analizando eventos..." sin ningún error

## Contexto

El usuario reportó que el tablero se queda pegado al analizar ciertas fechas
personalizadas -- confirmó que no aparece ningún error en la consola del
navegador (F12), solo se queda cargando indefinidamente.

## Diagnóstico

`apiCall`/`apiMultiCall` envuelven `api.call`/`api.multiCall` (SDK de
add-ins de Geotab) en una `Promise` que solo se resuelve cuando Geotab llama
a `resolve` o `reject` -- **no había ningún timeout**. Si una solicitud se
cuelga (sesión vencida, problema de red puntual -- puede pasar, no depende
del código de este add-in), esa `Promise` no se resuelve NI se rechaza
nunca. Como nunca se rechaza, nunca llega al `.catch()` del pipeline en
`cargarYRenderizar` -- la pantalla se queda en "Analizando eventos..." para
siempre, sin ningún error que mostrar porque, técnicamente, nada falló --
simplemente nunca terminó. Esto explica exactamente los síntomas
reportados: sin error en consola, pegado indefinidamente.

## Fix

Nueva función `conTimeout(promesaFn, descripcion)`: envuelve cualquier
llamada con un tope de `TIMEOUT_LLAMADA_MS = 45000` (45s) -- tiempo generoso
porque cada llamada real que sale a la red ya está acotada por lotes
(`TAMANO_LOTE_MULTICALL = 15`) y chunks (`VENTANA_CHUNK_RPM_MS`/
`VENTANA_CHUNK_PTO_MS`), así que en un escenario normal ninguna debería
tardar minutos. Si se cumple el tope, rechaza con un mensaje claro ("Se
agotó el tiempo de espera consultando Geotab... vuelve a analizar el
rango") en vez de colgarse. Se aplicó a los 3 puntos donde este archivo
llama directamente a `api.call`/`api.multiCall` (`apiCall`, y los 2 casos
dentro de `apiMultiCall`: lote único y lotes secuenciales).

## Verificación

- Balance de paréntesis/llaves/corchetes: perfectamente balanceado (este
  archivo no tiene el patrón de regex Unicode que causa falsos positivos en
  otros add-ins de este ecosistema).
- `AnalisisPTO_addin.zip` generado por primera vez en la raíz del repo
  (antes no existía ahí) y copiado a Descargas: `config.json` (v1.15) +
  `dashboardAnalisisPTO.html` + `dashboardAnalisisPTO.js`.

## Pendiente

No se pudo reproducir el cuelgue real desde este entorno (no hay acceso a
un navegador). El fix ataca la causa más probable dado lo observado (sin
error, pegado indefinidamente) pero el usuario debe confirmar que, tras
instalar esta versión, el error aparece en vez de quedarse pegado la
próxima vez que pase (sea cual sea la causa real del cuelgue de red/sesión,
que sigue sin poder evitarse del todo -- el fix la hace visible y
recuperable, no la elimina).
