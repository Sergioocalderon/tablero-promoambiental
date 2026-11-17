# Candado contra solicitudes superpuestas (fix de "ServerStopped" repetido)

**Fecha:** 2026-09-15
**Archivo:** `_build_pto/sobreRevolucionPTO.js`

## Problema reportado

El addin se quedaba pegado en "Cargando eventos…" repetidamente. En la consola
del navegador el error real (visible bajo el prefijo `Sobre-Revolución PTO:`,
que es nuestro propio `console.error`) era:

```
name: "ServerStopped"
isNetworkException: true
xhrStatus: 0
message: ""
```

## Causa raíz

`cargarYRenderizar()` no tenía ninguna protección contra ejecutarse dos veces
en paralelo. Cada corrida hace, además de la consulta de eventos: un
`api.multiCall` con una sub-llamada **por cada vehículo con eventos** en
`confirmarPtoCercano()` (cruce de PTO) y otro igual en `agregarPicoRpm()`
(pico de RPM) — con 50+ vehículos en juego, son 100+ sub-llamadas por corrida.

Sin candado, cualquier combinación de estos disparadores podía superponerse:
- El refresco automático cada 10 min (`refrescoAutomatico`).
- El listener de `visibilitychange` (se dispara cada vez que se vuelve a la
  pestaña).
- Un click en "Actualizar" o "Filtrar fechas" mientras una corrida anterior
  (lenta, o de las de arriba) todavía estaba en vuelo.
- El caso más probable en la práctica: el usuario ve "Cargando…" pegado y
  hace click de nuevo por impaciencia, apilando una tercera, cuarta corrida.

Varias tandas de 100+ sub-llamadas encimadas es lo que probablemente estaba
saturando la sesión del lado de Geotab y produciendo el `ServerStopped`
repetido.

## Cambio

- Nueva variable `cargaEnCurso` (candado simple): `cargarYRenderizar()` no
  hace nada si ya hay una carga en vuelo, en vez de sumarse a ella.
- Nuevas funciones `deshabilitarBotonesCarga()` / `habilitarBotonesCarga()`:
  deshabilitan visualmente "Actualizar" y "Filtrar fechas" mientras dura la
  carga (opacidad reducida, `cursor: not-allowed`, `disabled = true`), para
  que un click repetido por impaciencia no quede silenciosamente ignorado sin
  que el usuario entienda por qué.
- `construirEncabezado()` ahora también devuelve `botonActualizar` y
  `botonFiltrar` en sus refs, guardados en `elementos` junto con los campos
  de fecha que ya se guardaban ahí.

## Pendiente de verificar manualmente

No hay test suite para los addins. Verificar en Geotab:
1. Dejar la pestaña abierta 10+ min y confirmar que el refresco automático no
   se superpone con un click manual de "Actualizar" hecho en ese momento.
2. Hacer varios clicks seguidos en "Actualizar" y confirmar que el botón se
   ve deshabilitado durante la carga (no se disparan corridas extra).
3. Confirmar que el error "ServerStopped" deja de repetirse con el uso normal
   (puede seguir ocurriendo como blip aislado si el servidor de Geotab
   realmente se reinicia del lado de ellos — eso no lo arregla este cambio,
   solo evita que el addin lo agrave apilando más carga).
