# Historial de eventos al seleccionar una placa en la tabla

Fecha: 2026-09-23
Versión: 1.6 → 1.7

## Qué cambió

- La tabla "Vehículos" ahora tiene filas clicables: clic en una fila filtra
  por ese vehículo (`cfToggle('vehiculo', ...)`, mismo `CF.vehiculo` que ya
  escriben el buscador y el gráfico de Top vehículos) y la resalta.
- Nuevo panel "🕘 Historial de eventos — <vehículo>", visible solo cuando hay
  EXACTAMENTE un vehículo en `CF.vehiculo` (por fila, buscador, o barra del
  gráfico). Lista cada evento individual confirmado (no el agregado que ya
  mostraba la tabla resumen): fecha y hora, duración, y RPM pico —
  resaltado en rojo si supera el umbral de 1500 RPM que usa el filtro de
  Mercedes/OM926. Ordenado del más reciente al más antiguo, con un botón
  "Ver todos los vehículos" para quitar el filtro.

## Por qué

Pedido explícito del usuario: que al seleccionar una placa en la tabla lo
lleve al histórico de esa unidad, con más información de la que ya daba el
agregado (conteo, RPM pico máximo, tiempo total) — quería ver CUÁNDO ocurrió
cada evento y su detalle puntual.

## Archivos

- `dashboardAnalisisPTO.js` — `construirTablaVehiculos` (filas clicables),
  nueva función `construirHistorialVehiculo`, integrada en
  `renderizarResultados`.
- `config.json` — versión 1.6 → 1.7.
