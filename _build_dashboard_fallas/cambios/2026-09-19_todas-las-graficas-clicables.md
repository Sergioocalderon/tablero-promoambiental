# Todas las gráficas del dashboard ahora son clicables (cross-filter completo)

**Fecha:** 2026-09-19
**Archivo:** `_build_dashboard_fallas/dashboardAnalisisFallas.js`
**Versión:** `config.json` 1.2 → 1.3

## Contexto

Después de sumar cross-filter a "Fallas por sistema" y "Top vehículos"
(2026-09-18), el usuario pidió explícitamente que **todas** las gráficas del
dashboard fueran interactivas, no solo esas dos. Faltaban dos piezas: la
Tendencia (episodios por día) y el panel Activas vs. Inactivas.

## Cambios

1. **Dos dimensiones nuevas en CF**: `dia` (balde de fecha de la Tendencia)
   y `estado` (Activa/Inactiva del panel de resueltas) — `CF_ORDEN` pasa de
   5 a 7 claves. Con esto, TODAS las gráficas del dashboard entran al mismo
   mecanismo de cross-filter (`CF`, chips removibles, "cada gráfico ignora
   su propia dimensión para seguir mostrando su panorama").

2. **Tendencia (episodios por día/semana)**: las barras ahora son clicables
   -- clic en un día lo suma a `CF.dia` (se pueden elegir varios días/
   semanas a la vez, OR). Para esto, la lógica de "a qué balde de fecha
   pertenece un episodio" (antes función local `claveBalde` dentro de
   `construirSerieTemporal`) se sacó a nivel de módulo
   (`resolverPorSemana`/`resolverClaveBalde`/`etiquetaClaveBalde`) para que
   el filtro (`grupoPasaClave`) use EXACTAMENTE el mismo criterio que
   dibuja las barras — una sola fuente de verdad, mismo patrón que
   `resolverSistemaPrincipal`.

3. **Activas vs. inactivas**: la barra de progreso (antes solo informativa)
   ahora tiene sus 2 segmentos clicables (y también los conteos de abajo,
   "Inactivas: N" / "Activas: N", con más superficie para hacer clic) —
   cada uno suma/quita su estado de `CF.estado`. Las filas por ciudad
   (`crearFilaCiudad`) también son clicables ahora: reusan la dimensión
   `ciudad` que ya existía (mismo filtro que el dropdown de encabezado),
   como entrada alternativa.

4. **Recalculo consistente**: `aplicarFiltrosYRenderizar` ahora calcula
   `gruposParaTendencia` (ignora `CF.dia`) y `gruposParaEstado` (ignora
   `CF.estado`) con el mismo patrón `gruposParaDimension(excluirClave)` ya
   usado para Sistema/Vehículo -- la serie temporal y el panel de
   Activas/Inactivas se alimentan de estos en vez de `gruposParaResto`, así
   siguen mostrando su panorama completo (todos los días, ambos estados)
   con la selección resaltada, en vez de colapsar a un solo punto.

5. Los títulos de Tendencia y Activas/Inactivas ahora usan
   `etiquetaFiltrosCf('dia')` / `etiquetaFiltrosCf('estado')`
   respectivamente (excluyen su propia dimensión del sufijo, igual que ya
   hacían Sistemas y Top vehículos).

6. `cargarYRenderizar` limpia `CF.dia` (además de `CF.sistema`, que ya se
   limpiaba) en cada rango de fechas nuevo -- las claves de día (ej.
   "2026-09-07") son específicas del rango anterior y no tendrían sentido
   en uno nuevo.

## Resumen: qué es clicable ahora

| Gráfico | Dimensión CF | Semántica del clic |
|---|---|---|
| Fallas por sistema | `sistema` | Suma/quita (OR) |
| Top N vehículos | `vehiculo` | Suma/quita (OR) |
| Tendencia por día/semana | `dia` | Suma/quita (OR) |
| Activas vs. inactivas (barra + conteos) | `estado` | Suma/quita (OR) |
| Filas por ciudad (dentro de Activas/Inactivas) | `ciudad` | Suma/quita (OR) |
| Chips de Criticidad (barra de filtros) | `criticidad` | Suma/quita (OR) |
| Dropdown Ciudad / Tipo / buscador Vehículo | `ciudad`/`tipo`/`vehiculo` | Reemplaza (set) |

Todo combina entre sí: misma dimensión = OR, dimensiones distintas = AND.

## Pendiente de verificar manualmente

No hay test suite. Empaquetar y montar el zip en Geotab para confirmar:
- Que clic en un día de la Tendencia filtre correctamente el resto del
  dashboard (KPIs, tabla de códigos) a solo los episodios de ese día.
- Que clic en "Inactivas"/"Activas" combine bien con un filtro de sistema o
  vehículo ya activo (AND entre dimensiones).
- Que clic en una fila de ciudad (dentro de Activas/Inactivas) se refleje
  también en el dropdown de Ciudad del encabezado (mismo CF.ciudad).
- Que cambiar de rango de fechas limpie el filtro de día sin romper nada.
