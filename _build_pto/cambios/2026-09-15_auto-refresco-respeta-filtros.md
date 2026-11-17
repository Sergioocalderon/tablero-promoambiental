# Auto-refresco respeta filtros finos, ciudad no bloquea

**Fecha:** 2026-09-15
**Archivo:** `_build_pto/sobreRevolucionPTO.js`

## Problema reportado

El addin se actualizaba solo (refresco automático) mientras el usuario tenía
filtros activos, interrumpiendo el análisis en curso.

## Cambio

- Nueva función `hayFiltrosQueBloqueanAutoRefresco()`: igual que
  `hayFiltrosActivos()` pero **sin contar el filtro de ciudad**.
- `INTERVALO_AUTO_REFRESCO_MS`: 5 → **10 minutos**.
- Nueva función `refrescoAutomatico()`: wrapper que solo llama a
  `refrescarDatos()` si no hay un filtro fino activo (texto, turno, vehículo
  puntual o piso de RPM).
- El `setInterval` de `focus()` y el listener de `visibilitychange` ahora usan
  `refrescoAutomatico()` en vez de `refrescarDatos()` directo.
- El botón **"Actualizar"** y la carga inicial en `focus()` siguen llamando a
  `refrescarDatos()` directo sin condición — siempre refrescan porque son
  acción explícita del usuario o carga de página.

## Comportamiento resultante

- Sin filtros, o con solo el filtro de ciudad puesto: sigue refrescando cada
  10 min.
- Con texto, turno, un vehículo puntual o piso de RPM activo: el
  auto-refresco se pausa hasta que el usuario limpie esos filtros o presione
  "Actualizar" a mano.

## Pendiente de verificar manualmente

No hay test suite para los addins (Vanilla JS, sin build step). Verificar en
Geotab:
1. Aplicar un filtro de turno/texto/RPM y confirmar que la tabla no se mueve
   sola durante 10+ min.
2. Limpiar filtros y confirmar que sí se refresca automáticamente.
3. Confirmar que el botón "Actualizar" siempre refresca, con o sin filtros.
