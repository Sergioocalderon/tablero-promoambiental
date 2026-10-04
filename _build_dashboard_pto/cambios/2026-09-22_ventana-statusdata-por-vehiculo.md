# Bug real de rendimiento: ventana de StatusData global → por vehículo

Fecha: 2026-09-22
Versión: 1.2 → 1.3

## Qué cambió

`confirmarPtoCercano` y `agregarPicoRpm` calculaban una ventana de fechas
**global** (`desdeGlobal`/`hastaGlobal` = mínimo/máximo entre los candidatos
de TODOS los vehículos) y la usaban igual para la consulta de StatusData de
**cada** vehículo. Ahora cada vehículo consulta solo la ventana de SUS
PROPIOS candidatos (min/max ± la tolerancia de siempre: 3 min para PTO, 30 s
para RPM).

## Por qué

El usuario reportó que, incluso después de fijar el rango por defecto a 2
semanas (ver `cambios/2026-09-22_eliminar-persistencia-de-rango.md`), el
add-in seguía tardando mucho en cargar. Ese cambio anterior solo evitaba que
se recargara un rango viejo GRANDE por accidente — no tocaba este problema
estructural, presente en CUALQUIER rango con candidatos repartidos entre
varios vehículos.

Ejemplo concreto del bug: si el vehículo A tenía un candidato el día 1 y el
vehículo B uno el día 14 (dentro de una ventana de 2 semanas, típico con
~50-64 vehículos en alcance), la consulta de StatusData del vehículo A
pedía datos desde el día 1 **hasta el día 14** — 14 días de RPM de alta
resolución para un vehículo que solo necesitaba una ventana de minutos
alrededor de su propio evento. Multiplicado por cada vehículo en alcance,
esto inflaba brutalmente el volumen de datos pedido en cada carga,
independientemente de qué tan corto fuera el rango elegido.

`agregarPicoRpm` es el que más pesaba: el diagnóstico de RPM es de alta
resolución (reporta con mucha más frecuencia que el pulso de PTO), así que
era el mayor contribuyente al tiempo de carga.

## Archivos

- `dashboardAnalisisPTO.js` — `confirmarPtoCercano` y `agregarPicoRpm` ahora
  agrupan candidatos/eventos por vehículo primero, y calculan la ventana de
  consulta de StatusData sobre ese subconjunto, no sobre el global.
- `config.json` — versión 1.2 → 1.3.
