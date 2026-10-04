# Cross-filter multidimensional en todas las gráficas

Fecha: 2026-09-22
Versión: 1.0 → 1.1

## Qué cambió

Se replicó en `dashboardAnalisisPTO.js` el mismo mecanismo de cross-filtering
que ya usa `dashboardAnalisisFallas.js`: un objeto único `CF = {clave: [valores]}`
donde la misma clave es OR entre sus valores (ej. Crítico + Alto a la vez) y
claves distintas son AND (ej. Ciudad=Bogotá Y Vehículo=X).

Dimensiones ahora clicables/filtrables, todas escribiendo sobre el mismo `CF`:

- **Ciudad** (dropdown de encabezado) — antes ya filtraba, ahora usa `cfSet`.
- **Criticidad** (chips) — antes era un flag independiente por nivel, ahora
  usa `cfToggle` sobre `CF.criticidad`.
- **Vehículo** (nuevo) — clic en una barra del gráfico "Top vehículos" filtra
  por ese vehículo.
- **Fecha/semana** (nuevo) — el gráfico de Tendencia pasó de línea a barras
  clicables; clic en una barra filtra por ese día (o semana, si el rango es
  largo).

Cada gráfico "dueño" de una dimensión (Top vehículos, Tendencia) ignora SOLO
su propia clave al construir sus datos, para seguir mostrando su panorama
completo con la barra elegida resaltada — mismo criterio que en el dashboard
de fallas. La tabla de vehículos sí respeta TODAS las dimensiones activas
(incluido el filtro de vehículo), así que colapsa a una sola fila si se
filtra por un vehículo puntual.

Se agregó un banner de "Filtros cruzados activos" con chips removibles
individualmente (×) y un botón para limpiar todos a la vez — mismo componente
visual que el dashboard de fallas.

## Por qué

Pedido explícito del usuario: "quiero replicar la interacción [del dashboard
de fallas] pero con el dashboard de análisis en sobre revolución con PTO".

## Archivos

- `dashboardAnalisisPTO.js` — CF/cfToggle/cfSet/cfRemoveValue/cfClearKey/cfClearAll,
  `eventoPasaClave`, `etiquetaValorCf`, `construirBannerCf`,
  `resolverPorSemana`/`resolverClaveBalde`/`etiquetaClaveBalde` extraídas de
  `construirSerieTemporal`, gráficos de Top vehículos y Tendencia ahora con
  `onClick`/coloreado por selección, barra de filtros reescrita sobre `CF`.
- `config.json` — versión 1.0 → 1.1.
