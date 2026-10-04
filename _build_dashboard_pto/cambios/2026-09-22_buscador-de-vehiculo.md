# Buscador de vehículo (placa o nombre) en la barra de filtros

Fecha: 2026-09-22
Versión: 1.3 → 1.4

## Qué cambió

Se agregó `crearSelectorVehiculo()` — mismo patrón ya usado en
`dashboardAnalisisFallas.js`: un campo de texto con autocompletado
(`<datalist>`) para buscar por placa o nombre, más un botón "✕" para quitar
el filtro. Vive en la barra de filtros, junto a Ciudad y Criticidad, y
escribe sobre `CF.vehiculo` con `cfSet` (reemplaza la selección — un solo
vehículo a la vez desde el buscador; sigue siendo posible sumar más
vehículos haciendo clic en las barras del gráfico "Top vehículos", que usa
`cfToggle`, ambos mecanismos comparten el mismo `CF.vehiculo`).

El texto del buscador se mantiene sincronizado con `CF.vehiculo` sin
importar cómo haya cambiado (clic en el gráfico, chip del banner de filtros
cruzados, botón "Limpiar filtros") — se resincroniza en cada ciclo de
`aplicarFiltrosYRenderizar`.

## Por qué

Pedido explícito del usuario: "falta poder seleccionar un móvil".

## Archivos

- `dashboardAnalisisPTO.js` — `crearSelectorVehiculo()`, integrado en
  `construirBarraFiltros` (poblado en `cargarYRenderizar` vía
  `actualizarOpcionesVehiculo`, sincronizado en `renderizarResultados` vía
  `sincronizarSelectorVehiculo`).
- `config.json` — versión 1.3 → 1.4.
