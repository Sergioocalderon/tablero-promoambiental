# Bug real: se perdió la línea de tendencia al hacer las barras clicables

Fecha: 2026-09-23
Versión: 1.4 → 1.5

## Qué cambió

El 2026-09-22, al convertir el gráfico de Tendencia de línea a barras
clicables (para poder filtrar por día/semana con `cfToggle('dia', ...)`),
se reemplazó por completo el dataset de línea en vez de sumarle uno de
barras — el gráfico se quedó solo con barras, sin la línea de tendencia
(promedio móvil) que el título del panel seguía prometiendo.

Ahora es un gráfico MIXTO, igual que `dashboardAnalisisFallas.js`: barras
clicables (dataset `type: 'bar'`) + línea de tendencia superpuesta (dataset
`type: 'line'`, promedio móvil de 7 puntos si la serie es diaria o 3 si es
semanal). Se agregó también la nota "🟩 Barras = eventos del periodo —
Línea = tendencia (promedio móvil)" debajo del título, mismo texto que ya
usa el dashboard de fallas.

## Por qué

El usuario validó el add-in después del cambio anterior y reportó que ya no
veía la línea de tendencia — captura de pantalla del gráfico mostrando solo
barras.

## Archivos

- `dashboardAnalisisPTO.js` — `construirGraficoTendencia` ahora arma un
  chart mixto (barras + línea de promedio móvil) en vez de solo barras;
  `construirSeccionGraficos` agrega el elemento de nota bajo el título del
  panel.
- `config.json` — versión 1.4 → 1.5.
