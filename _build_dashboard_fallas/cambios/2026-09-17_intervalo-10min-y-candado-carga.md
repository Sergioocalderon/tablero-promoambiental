# Auto-refresco a 10 min + candado contra solicitudes superpuestas

**Fecha:** 2026-09-17
**Archivo:** `_build_dashboard_fallas/dashboardAnalisisFallas.js`

## Pedido

Bajar el auto-refresco de 15 a 10 minutos.

## Cambio 1: intervalo

`INTERVALO_AUTO_REFRESCO_MS`: 15 → 10 minutos.

## Cambio 2 (proactivo, no pedido explícitamente): candado de solicitudes superpuestas

Al bajar el intervalo aumenta la probabilidad de que el refresco automático
dispare un segundo pipeline completo (FaultData + catálogos + periodo
anterior + info de vehículos) mientras un click en "Analizar rango" o
"Últimos 30 días" -- o un tick anterior -- todavía está en vuelo. Es
exactamente el mismo bug real que ya causó errores `ServerStopped` en
`sobreRevolucionPTO.js` (ver `_build_pto/cambios/2026-09-15_candado-contra-cargas-superpuestas.md`),
y este archivo no tenía el mismo candado.

Se aplicó el mismo patrón:
- Nueva variable `cargaEnCurso`: `cargarYRenderizar()` no hace nada si ya
  hay una carga en vuelo.
- Nuevas funciones `deshabilitarBotonesCarga()` / `habilitarBotonesCarga()`:
  deshabilitan visualmente "Analizar rango" y "Últimos 30 días" mientras
  dura la carga.
- `construirEncabezado()` ahora también devuelve `botonFiltrar` y
  `botonUltimos30` en sus refs.

## Pendiente de verificar manualmente

No hay test suite. Verificar en Geotab:
1. Confirmar que el dashboard refresca cada 10 min en vez de 15.
2. Hacer varios clicks seguidos en "Analizar rango" y confirmar que el botón
   se ve deshabilitado durante la carga (no dispara corridas extra).
