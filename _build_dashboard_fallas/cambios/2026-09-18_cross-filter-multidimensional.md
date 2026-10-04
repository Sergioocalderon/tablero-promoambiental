# Cross-filter multidimensional (inspirado en reporte de referencia)

**Fecha:** 2026-09-18
**Archivo:** `_build_dashboard_fallas/dashboardAnalisisFallas.js`
**Versión:** `config.json` 1.1 → 1.2

## Contexto

El usuario compartió un reporte HTML de referencia (`Reporte_Fallos_...html`,
generado por un script Python distinto, fuera de este ecosistema de
add-ins) con un motor de cross-filter multidimensional: CUALQUIER gráfico es
clicable, los filtros se combinan con chips visibles/removibles, y cada
gráfico "dueño" de una dimensión sigue mostrando su panorama completo para
poder comparar y cambiar de selección. Pidió explícitamente usar ese ejemplo
para "sumar" mejoras a las gráficas de este dashboard, priorizando el
cross-filter multidimensional sobre otras 3 opciones (mini-desglose de
criticidad en barras, franja de criticidad en el resumen, comparativos
normalizados) — esas quedan pendientes para una iteración futura.

## Cambio central: filtroEstado + sistemaSeleccionado → CF unificado

Antes había dos mecanismos de filtro separados: `filtroEstado` (un solo
valor por dimensión: ciudad/tipo/vehículo, más un mapa de criticidades) y la
variable suelta `sistemaSeleccionado` (drill-down de sistema, agregado el
mismo día en la sesión anterior). Se reemplazan ambos por un único objeto:

```js
var CF = {}; // {clave: [valores]} -- misma clave = OR, claves distintas = AND
```

Mismo patrón exacto que el motor JS del reporte de referencia (`CF`,
`cfToggle`, `filterRowsCf(rows, exclude)`), adaptado a la arquitectura de
este dashboard (episodios agregados por grupo, no filas crudas; Chart.js en
vez de barras DOM hechas a mano).

## Piezas nuevas

- **`cfToggle`/`cfSet`/`cfRemoveValue`/`cfClearKey`/`cfClearAll`**: API única
  para mutar CF desde cualquier control (dropdown, input, clic en gráfico,
  chip del banner). `cfSet` reemplaza el valor de una clave (para
  Ciudad/Tipo/buscador de Vehículo, controles de selección única);
  `cfToggle` suma/quita un valor (para clics en gráficos y chips de
  Criticidad, que ahora admiten más de un valor a la vez).
- **`grupoPasaClave(g, clave, catalogos)`**: evalúa un grupo contra UNA
  dimensión de CF. Criticidad queda afuera a propósito (es una propiedad
  agregada del vehículo, no de un grupo individual).
- **`gruposParaDimension(excluirClave)`** (dentro de
  `aplicarFiltrosYRenderizar`): aplica TODO CF salvo una clave — usado una
  vez por cada gráfico "dueño" de una dimensión, para que ese gráfico en
  particular siga mostrando TODAS sus categorías mientras el resto del
  tablero sí queda filtrado. Se generalizó el mecanismo que ayer solo
  existía para Sistema; ahora también se aplica a **Top vehículos** (el
  gráfico de barras de vehículos ahora es clicable y también se ignora a
  sí mismo).
- **`construirBannerCf`**: franja con un chip removible por cada valor de CF
  activo + botón "Quitar todos los filtros cruzados" — aparece arriba del
  resumen ejecutivo, oculto por completo si no hay ningún filtro cruzado.
- **`etiquetaFiltrosCf(excluirClave)`**: sufijo "— Ciudad: Bogotá · Sistema:
  Motor" en los títulos de Tendencia, Top vehículos, Activas/Inactivas y
  Fallas por sistema (cada uno excluye su propia dimensión del sufijo).

## Vehículos: de "un solo filtro" a "chart-driven cross-filter"

El gráfico de "Top N vehículos con más fallas" (antes solo informativo) es
ahora clicable igual que "Fallas por sistema": clic en una barra suma ese
vehículo a `CF.vehiculo` (se puede elegir más de uno, OR), la barra
seleccionada pasa a verde oscuro y el resto se atenúa. El buscador de texto
(`inputVehiculo`) sigue existiendo como atajo alternativo, pero ahora usa
`cfSet` (reemplaza la selección) en vez de sumarla — mezcla intencional de
mecanismos "buscar uno" vs. "clic para sumar varios".

## Criticidad: cambio de comportamiento a propósito

Antes los 4 chips de criticidad empezaban TODOS presionados (mostrando
todo) y un clic los "apagaba" uno por uno (exclusión). Ahora usan la misma
semántica que el resto del cross-filter: `CF.criticidad` vacío = sin filtro
(los 4 se ven presionados), y el PRIMER clic en un chip AÍSLA a ese nivel
(los otros 3 se ven sueltos), con clics adicionales sumando más niveles
(OR). Es un cambio de comportamiento real respecto a ayer, adoptado a
propósito para que Criticidad se sienta igual de clicable/combinable que
Sistema o Vehículo — documentado acá para que no sea una sorpresa.

## Pendiente (no incluido en esta iteración)

El usuario priorizó cross-filter sobre 3 mejoras más del reporte de
referencia, que quedan para después si se piden:
- Mini-desglose de criticidad junto a cada barra (ej. "A 5 · M 3 · B 2").
- Franja compacta de criticidad clicable pegada al resumen ejecutivo.
- Comparativos normalizados por tamaño real de grupo (tasa de fallas por
  vehículo, no el total crudo) para tipo/marca/ciudad.
Tampoco se agregó clic-para-filtrar en la Tendencia (evolución por día) ni
en "Activas vs. inactivas" — se mantienen como gráficos de solo lectura por
ahora, para no ampliar demasiado el alcance de este cambio.

## Pendiente de verificar manualmente

No hay test suite. Empaquetar y montar el zip en Geotab para confirmar:
- Que clic en una barra de "Fallas por sistema" Y en una barra de "Top
  vehículos" combinen correctamente (AND entre dimensiones distintas).
- Que clic en DOS barras de sistemas distintas las combine con OR (ambas
  aparecen en el detalle SPN/FMI).
- Que el banner de chips aparezca/desaparezca correctamente y que cada ×
  quite solo ese valor puntual.
- Que "Quitar todos los filtros cruzados" y "Limpiar filtros" (barra de
  filtros) dejen el dashboard exactamente igual que al cargar.
- Que cambiar el rango de fechas limpie el drill-down de sistema pero
  conserve ciudad/tipo/vehículo si siguen siendo válidos en el rango nuevo.
