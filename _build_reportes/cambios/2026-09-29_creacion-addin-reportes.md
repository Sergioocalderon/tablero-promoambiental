# Creación del Add-in "Reportes" (reporte de Fallas descargable)

**Fecha:** 2026-09-29
**Archivos:** `_build_reportes/config.json`, `_build_reportes/reportes.html`,
`_build_reportes/reportes.js`, `_build_reportes/reporte_plantilla.html`,
`_build_reportes/reporte_runtime_engine.js`

## Contexto

El usuario ya tenía un reporte de fallas ejecutivo en HTML (KPIs, cross-filter
multidimensional, Pareto, tabla maestra), generado por un script Python fuera
de este repo. Pidió un Add-in NUEVO y SEPARADO (no un botón dentro del Add-in
"Dashboard de Análisis de Fallas" ya existente) que deje elegir empresa +
rango de fechas dentro de MyGeotab y descargue ESE MISMO diseño/motor, sin
pasar por el script Python. Alcance explícito de esta primera versión: solo
Fallas, no hábitos/PTO.

## Qué se construyó

- `config.json`: mismo formato que `_build_dashboard_fallas/config.json` /
  `_build_dashboard_pto/config.json` (`name: "Reportes"`, `version: "1.0"`,
  `items[0].path: "ActivityLink/"`).
- `reportes.html`: shell mínimo (`#reportesRoot` + `<script src="reportes.js">`),
  SIN Chart.js/chartjs-plugin-datalabels -- ni esta pantalla de configuración
  ni el reporte descargado los usan (el motor del reporte dibuja barras con
  `<div>`, no `<canvas>`).
- `reporte_plantilla.html`: copia BYTE-IDÉNTICA (`Copy-Item`, no retipeada) del
  archivo que el usuario dejó preparado
  (`Reporte_Fallos_PACARIBE_plantilla.html`) -- HTML/CSS del reporte sin
  datos, con marcadores `{{EMPRESA}}` / `{{PERIODO_VALUE}}` / `{{PERIODO_DETAIL}}`
  / `{{GENERADO}}` y contenedores vacíos (`#nofault-slot`, `#filters-list`,
  `#narrative-list`) más bloques `<script type="application/json" id="data-*">{}</script>`.
  No se le hizo NINGÚN cambio -- se usa tal cual, con reemplazo de texto en
  tiempo de ejecución desde `reportes.js`.
- `reporte_runtime_engine.js`: copia BYTE-IDÉNTICA del motor de renderizado
  completo que el usuario dejó preparado (`reporte_runtime_engine.js`,
  cross-filter, `renderPareto`/`renderEvolution`/`renderDistributionBar`/
  `initTables`/`initCharts`, ~1100 líneas). Solo se reemplazó el comentario de
  cabecera (explicaba que era un extracto para el chat) por uno que describe
  su rol real dentro del add-in -- el CÓDIGO no se tocó. Se sirve como archivo
  aparte y `reportes.js` lo lee con `fetch()` en tiempo de generación para
  incrustarlo VERBATIM en cada reporte descargado (evita cualquier riesgo de
  transcripción manual de un archivo tan largo y load-bearing).
- `reportes.js`: el Add-in. `geotab.addin.reportes = function(){...}` con el
  mismo boilerplate `initialize/focus/blur` que `dashboardAnalisisFallas.js`.

## Lógica portada de `dashboardAnalisisFallas.js` (línea aprox. en ese archivo)

- Tema visual `T` (paleta corporativa, línea ~57-82) -- verbatim, para que el
  selector de esta pantalla comparta marca con los otros 2 add-ins.
- `apiCall` (línea ~316) -- verbatim.
- `LIMITE_PAGINA_FAULTDATA = 50000` y `obtenerFaultDataPaginado` (línea
  ~436-468, comentario "Puerto directo de...") -- verbatim, mismo patrón de
  paginación (pide de nuevo desde la fecha del último registro de la página
  si esta vino llena, para no perder registros recientes en rangos grandes).
- `obtenerCatalogosDiagnosticos` (línea ~415-432) -- verbatim.
- Taxonomía `SISTEMAS` + coincidencia por palabra completa `\b...\b` (línea
  ~126-188) -- portada, con dos diferencias deliberadas (ver limitación
  abajo): no se excluye "Otro / Sin clasificar" del desglose, y no se porta
  `SISTEMAS_CRITICOS_NOMBRES`/`esFallaSistemaCritico` (ese concepto de
  "vehículo crítico" no existe en el reporte de referencia).
- Resolución de jerarquía de grupos (`obtenerMapaGrupos`/
  `resolverMarcaYTipologia`, línea ~325-410) -- ADAPTADA, no verbatim: se
  reutiliza la forma del algoritmo (recorrido top-down desde la raíz `*...`,
  rama `Tipologia` aparte, detección de rama de marca por palabra clave), pero
  "ciudad" se convierte en "empresa" y se quita la normalización de nombre de
  ciudad (`normalizarCiudad`) -- ver decisión abierta más abajo.

## Lógica NUEVA (no existe en ningún archivo del repo, con motivo)

- **Criticidad por FALLA (ALTA/MEDIA/BAJA)**: `dashboardAnalisisFallas.js`
  clasifica criticidad POR VEHÍCULO (4 niveles, por cantidad de episodios) --
  un modelo incompatible con el reporte de referencia, que clasifica cada
  FILA/falla individual en 3 niveles. El pie de página del reporte de
  referencia es explícito: "ALTA (luz roja o de protección), MEDIA (luz
  ámbar) o BAJA (sin luz de alerta)". Se implementó `criticidadDeRegistro`
  usando los campos estándar de `FaultData` en MyGeotab (`redStopLamp`,
  `protectWarningLamp`, `amberWarningLamp`). **NO SE PUDO VERIFICAR CONTRA
  UNA CUENTA GEOTAB REAL** durante esta tarea -- antes de confiar en la
  columna "Criticidad" del reporte generado, confirmar manualmente que esos 3
  campos existen y traen el valor esperado.
- **Conteo de "activaciones"**: se agrupa por la misma clave
  vehículo+diagnóstico+failureMode que usa `calcularEpisodiosPorGrupo`.
  **CAMBIO (2026-09-29, corrección tras revisión del usuario):** la primera
  versión de este archivo NO portaba el debounce de reactivación / conteo de
  episodios (`DEBOUNCE_REACTIVACION_MIN`), y contaba cada registro
  `faultState==='Active'` como una activación -- eso infla el número, porque
  Geotab re-registra el mismo FaultData repetidamente mientras el código
  sigue activo (mismo fenómeno ya documentado con PTO en
  `telegram_alertas.py` y con FaultData en `dashboardAnalisisFallas.js`, que
  llegó a ver 24,641 "episodios" crudos en un solo vehículo en 30 días). Se
  corrigió para portar VERBATIM el criterio de `calcularEpisodiosPorGrupo`:
  "activación" = transición real hacia Active con el mismo debounce de 10
  minutos. "Días activos" (usado para el cruce con la evolución diaria) se
  mantiene como estaba -- ese es un concepto aparte, marca todo día con al
  menos un registro Active, sin importar el debounce.
- Narrativa ejecutiva (`construirNarrativa`), banner "sin fallas"
  (`construirBannerSinFallas`), y el ensamblado del HTML final
  (`ensamblarReporteHtml`/`inyectarJson`/`inyectarScriptMotor`) son lógica
  nueva de este add-in, sin equivalente previo en el repo.

## `t_maestra`: forma inferida, no verificada contra el original

El archivo de referencia truncaba el bloque `data-t_maestra` real. Se
reconstruyó su forma leyendo `initTables()` en el motor (usa `payload.columns`,
`payload.rows`, `payload.pageSize`, `payload.crossfilter`, `payload.secondaryColumns`),
pero las columnas EXACTAS y cuáles van en `secondaryColumns` son una decisión
propia, razonada pero no confirmada con el usuario:

- `columns`: Móvil, Placa, Tipo, Marca, Categoría, Diagnóstico, Código,
  Criticidad, Activaciones, Estado, Última fecha, Días activos.
- `secondaryColumns`: Última fecha, Días activos (se pliegan en la fila de
  detalle en la vista compacta/móvil).
- `crossfilter`: mapea Móvil/Tipo/Marca/Categoría/Criticidad por igualdad
  exacta, Diagnóstico por prefijo (la celda empieza con el código SPN/FMI), y
  "Días activos" por `contains` (celda multi-valor separada por comas, que
  `cellHasToken` en el motor ya sabe partir) -- así un clic en cualquier
  gráfico también filtra esta tabla.

## Decisión abierta: qué es "empresa" en esta cuenta

CLAUDE.md documenta ciudad/tipología/marca en la jerarquía de grupos, pero
**no existe ningún campo ni rama dedicada a "empresa"** -- se confirmó con
grep que ningún archivo del repo resuelve ese concepto. Se decidió (ver
comentario extenso en `reportes.js`, función `esGrupoMarca`/
`construirMapaEmpresas`) tratar como "empresa" el MISMO nivel de grupo que
`dashboardAnalisisFallas.js` ya llama "ciudad": el primer hijo de la raíz
(`*...`) que no es la rama `Tipologia` ni una rama de marca. En una cuenta
multi-cliente como esta (el ejemplo real es "PACARIBE", que no matchea ningún
patrón de ciudad colombiana) ese nivel es, con alta probabilidad, donde viven
los nombres de empresa/cliente reales -- pero **no se pudo confirmar contra
la cuenta Geotab real**. El selector de "Empresa" del add-in muestra
exactamente esos grupos candidatos. Si en la práctica "empresa" vive en otro
nivel de la jerarquía, el punto de cambio es un solo lugar
(`construirMapaEmpresas` en `reportes.js`).

## Otras limitaciones conocidas / decisiones tomadas sin poder confirmarlas

- **Taxonomía de sistemas más pobre que la muestra real**: el reporte de
  referencia (PACARIBE) tiene categorías ("Indicadores del vehículo", "Código
  propietario", "Comunicación/Red", "Seguridad", "General") que la taxonomía
  `SISTEMAS` de `dashboardAnalisisFallas.js` no cubre -- viene de la
  taxonomía del script Python original, no visible en este repo. Se portó la
  taxonomía existente en el repo (decisión ya tomada explícitamente con el
  usuario: reutilizar lógica ya resuelta), así que muchos diagnósticos caerán
  en "Otro / Sin clasificar" en vez de una categoría más específica.
- **Sin exclusión de "equipo telemático"**: el reporte de referencia excluye
  fallas del propio dispositivo GPS/rastreo (footer: "Se excluyeron 20
  falla(s) del propio equipo de rastreo"). No hay ninguna clasificación de
  "diagnóstico de equipo telemático vs. diagnóstico de vehículo" en el repo
  para portar, y armar una desde cero estaba fuera de alcance razonable de
  esta tarea -- se omitió por completo (no se excluye nada, y el footer del
  reporte generado no menciona esa exclusión).
- **Bloques `data-*` por gráfico se dejan vacíos (`{}`)**: `criticidad_donut`,
  `evolucion_bar`, `sistemas_bar`, `diagnosticos_bar`,
  `diagnosticos_frecuentes_bar`, `ranking_bar`, `ranking_activaciones_bar`,
  `tipo_bar`, `marca_bar`, `empresa_bar` se dejan como `{}` en vez de
  pre-calcularlos. El motor ejecuta `recomputeDashboard()` de forma síncrona
  justo después de `initCharts()`, en el mismo listener de
  `DOMContentLoaded` -- no hay ningún frame renderizado entre ambas fases, así
  que el estado "vacío" de estos bloques nunca llega a pintarse en pantalla.
  Solo `data-dashboard-dataset` y `data-t_maestra` se llenan de verdad (son
  los únicos que el motor no puede reconstruir solo).
- **Sin filtros adicionales en el propio Add-in**: a diferencia del reporte
  de referencia (que tiene selectores de marca/tipo/móvil/criticidad), esta
  primera versión del Add-in solo expone empresa + rango de fechas, como pidió
  el usuario explícitamente. El `filters-box` del reporte generado refleja
  solo esos dos filtros (más "Flota analizada: N vehículo(s)").
- **`t_maestra.pageSize`**: se fijó en 20 (mismo valor por defecto que usa
  `initTables()` si el campo faltara) -- no había forma de confirmar el valor
  real usado en el reporte de PACARIBE.

## Pendiente de verificar manualmente

No hay test suite. Antes de dar por buena esta primera versión:

1. Confirmar en una cuenta Geotab real que el grupo elegido como "empresa"
   en el selector corresponde de verdad a la empresa/cliente esperada (ver
   "Decisión abierta" arriba).
2. Confirmar que `FaultData` trae `redStopLamp`/`protectWarningLamp`/
   `amberWarningLamp` poblados (columna "Criticidad").
3. Generar un reporte real y compararlo visualmente contra
   `Reporte_Fallos_PACARIBE_2026-09-27_ORIGINAL.html` -- especialmente el
   comportamiento de la tabla maestra (orden, paginación, cross-filter) dado
   que su forma exacta (`t_maestra`) fue inferida, no confirmada.
4. Confirmar que Geotab sirve `reporte_plantilla.html` y
   `reporte_runtime_engine.js` como archivos estáticos accesibles por
   `fetch()` relativo desde `reportes.html` una vez el Add-in está instalado
   (debería funcionar igual que cualquier otro archivo de la carpeta del
   add-in, pero no se pudo probar en una instalación real durante esta tarea).
