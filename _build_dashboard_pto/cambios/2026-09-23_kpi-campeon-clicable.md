# La tarjeta "Más reincidente" (campeón de sobre-revolución) ahora filtra al hacer clic

Fecha: 2026-09-23
Versión: 1.13 → 1.14

## Qué cambió

`crearTarjetaKpi` acepta un `alHacerClic` opcional (y un flag `elegido`
para resaltarla si ya es el vehículo activo en `CF.vehiculo`). La tarjeta
"🔁 Más reincidente: <vehículo>" en la fila de KPIs ahora es clicable: un
clic filtra por ese vehículo (`cfToggle('vehiculo', ...)`), mismo
`CF.vehiculo` que ya escriben el buscador, la fila de la tabla y el gráfico
de Top vehículos — con eso también dispara el panel de "Historial de
eventos" de ese vehículo.

Las demás tarjetas KPI (Eventos, Vehículos afectados, RPM pico, Tiempo
total) no reciben el parámetro y siguen sin ser clicables, sin cambios.

## Por qué

Pedido explícito del usuario: poder seleccionar desde el apartado de
arriba (KPIs) "quién fue el campeón de sobre-revolución" directamente,
sin tener que bajar a la tabla o al gráfico.

## Archivos

- `dashboardAnalisisPTO.js` — `crearTarjetaKpi` con soporte de clic
  opcional; la tarjeta "Más reincidente" en `construirKpis` lo usa.
- `config.json` — versión 1.13 → 1.14.
