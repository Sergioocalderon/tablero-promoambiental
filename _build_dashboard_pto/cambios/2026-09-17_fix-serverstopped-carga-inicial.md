# Fix: "ServerStopped" en la primera carga

**Fecha:** 2026-09-17
**Archivo:** `_build_dashboard_pto/dashboardAnalisisPTO.js`

## Problema reportado

Al montar el addin en Geotab por primera vez, se quedó pegado en "Analizando
eventos del rango seleccionado…", con un banner de error mencionando
"5347.js" (ruido de la plataforma, no del addin). En la consola, filtrando
por "Análisis PTO", apareció el error real bajo nuestro propio
`console.error`:

```
name: "ServerStopped"
isNetworkException: true
xhrStatus: 0
```

Mismo tipo de error de sesión/conexión ya visto antes en `sobreRevolucionPTO.js`.

## Causa raíz

`cargarYRenderizar()` disparaba **dos pipelines completos en paralelo** desde
el arranque: el rango actual (`obtenerIdRegla → ... → filtrarPorUmbralMercedes`)
Y la comparación con el periodo anterior (`obtenerTotalesPeriodo`, que corre
internamente ese mismo pipeline completo otra vez). Cada uno hace sus propios
`multiCall` pesados (`confirmarPtoCercano`, `agregarPicoRpm`), uno por cada
vehículo en alcance. En la primera carga de la página (caché fría) y con más
vehículos que antes (L9/T380 ya nacionales, ver
`herramientas/estado_reglas.md`), correr ambos pipelines a la vez generó un
pico de solicitudes simultáneas que tumbó la sesión de Geotab.

## Cambio

La consulta del periodo anterior (`obtenerTotalesPeriodo`) ahora se dispara
**después** de que el pipeline principal ya terminó sus `multiCall` pesados,
no en paralelo desde el arranque — mismo principio que ya llevó al candado
`cargaEnCurso` en otros addins de este ecosistema: nunca varias tandas de
solicitudes por vehículo en vuelo al mismo tiempo.

## Pendiente de verificar manualmente

No hay test suite. Volver a montar el zip en Geotab y confirmar que la
primera carga completa sin el error `ServerStopped`. Si vuelve a pasar,
revisar si además hace falta paginar `obtenerEventosCandidatos` (por ahora
sin límite de resultados) para rangos de 30+ días con muchos vehículos.
