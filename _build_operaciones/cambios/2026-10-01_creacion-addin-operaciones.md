# Creación del Add-in "Operaciones" (hábitos de conducción)

**Fecha:** 2026-10-01
**Archivos:** `_build_operaciones/config.json`, `_build_operaciones/operaciones.html`,
`_build_operaciones/operaciones.js`

## Contexto

Hasta hoy el reporte de Operaciones (hábitos: velocidad, ralentí, PTO) vivía
como una tercera pill dentro del add-in combinado "Reportes"
(`_build_reportes/reportes.js`), junto a Fallas y Mini Expediente -- ver
`_build_reportes/cambios/2026-09-29_agregar-reporte-operaciones.md` y
`_build_reportes/cambios/2026-10-01_implementar-turno-operaciones.md` para
el historial completo de esa lógica. El usuario pidió separar ese add-in
combinado en DOS add-ins independientes de MyGeotab: Mantenimiento (Fallas +
Mini Expediente, se queda en `_build_reportes/`, ver
`_build_reportes/cambios/2026-10-01_separar-en-dos-addins.md`) y este add-in
nuevo, Operaciones, que contiene SOLO el reporte de hábitos.

A diferencia del add-in de Mantenimiento, este add-in NO tiene selector de
tipo de reporte -- es el único modo disponible. El formulario se simplificó
en consecuencia: elegir empresa + rango de fechas y generar directo, sin
ningún control segmentado de una sola opción.

**Duplicación intencional, aceptada explícitamente por el usuario**: el
código compartido con el add-in de Mantenimiento (conexión a la API,
catálogos de diagnósticos, resolución de empresa/dispositivos, el motor de
plantillas `MOTOR_JS_EMBEBIDO`, el sistema de diseño `T`/`crearPill`/
`inyectarEstilosGlobales`, helpers de fecha) vive DUPLICADO, verbatim, en
`mantenimiento.js`. No es un error a corregir -- Geotab no soporta compartir
un módulo JS entre dos add-ins de forma sencilla, y el usuario ya decidió que
la separación completa de archivos es preferible a mantener un acoplamiento
entre dos add-ins con ciclos de vida independientes.

## Qué se construyó

- `config.json`: mismo formato que el resto de add-ins del repo (`name:
  "Operaciones"`, `menuName.en: "Operaciones"`, `version: "1.0"` -- add-in
  nuevo --, `items[0].path: "ActivityLink/"`, mismo `supportEmail` que
  Mantenimiento).
- `operaciones.html`: shell mínimo (`#operacionesRoot` + `<script
  src="operaciones.js">`), mismo patrón que `mantenimiento.html`/
  `dashboardAnalisisFallas.html` -- sin Chart.js/chartjs-plugin-datalabels
  (el reporte descargado dibuja con `<div>`, no `<canvas>`, y esta pantalla
  de configuración tampoco tiene gráficas).
- `operaciones.js`: el add-in. `geotab.addin.operaciones = function()
  {...}` con el mismo boilerplate `initialize/focus/blur` que
  `mantenimiento.js`/`dashboardAnalisisFallas.js` (el nombre de la función
  sigue al nombre del archivo .js, no al `name` de `config.json`, mismo
  criterio que el resto del repo).

## Lógica heredada VERBATIM de `reportes.js` (sin cambios de negocio)

- Pipeline completo de hábitos: `REGLAS_HABITO` (velocidad/ralentí/PTO, con
  todo el razonamiento documentado sobre qué reglas de Geotab se incluyen y
  cuáles se excluyen a propósito -- ver
  `_build_reportes/cambios/2026-09-29_agregar-reporte-operaciones.md`, esa
  decisión NO se revisó ni se confirmó en esta tarea, solo se trasladó),
  `obtenerReglas`/`resolverReglasHabito`/`obtenerEventosDeRegla`.
- Confirmación de PTO contra pulso real (`apiMultiCall`,
  `construirLlamadasPorChunksOperaciones`, `agruparPorCercaniaOperaciones`,
  `construirVentanasPorVehiculoOperaciones`,
  `consultarStatusDataAgrupadoOperaciones`, `confirmarPtoCercano`,
  `agregarPicoRpm`) -- PTO es un pulso, no un nivel (ver CLAUDE.md), por eso
  ninguna regla puede exigirlo directamente y hace falta este cruce con
  `±VENTANA_PTO_MIN`.
- Turno (`horaBogota`/`calcularTurno`, T1/T2/T3 hora Bogotá, confirmado con
  el usuario el 2026-10-01 -- ver changelog de esa tarea en
  `_build_reportes/cambios/`).
- Ensamblado y descarga: `construirFilaOperacion`,
  `construirColumnasTablaOperaciones`, `construirCrossfilterTablaOperaciones`,
  `formatearDuracionOperaciones`, `construirFilasTablaOperaciones`,
  `ensamblarReporteHtmlOperaciones` (usa `ensamblarReporteHtmlBase` sin
  bloques opcionales -- Operaciones arma su narrativa en vivo dentro del
  motor, no en un `<ul>` estático), `generarReporteOperaciones`,
  `PLANTILLA_OPERACIONES_EMBEBIDA` (generada desde
  `reporte_operaciones_plantilla.html`, que se quedó en
  `_build_reportes/` -- ver nota de decisión abierta en el changelog de
  Mantenimiento).
- Todas las constantes de PTO/RPM (`ID_DIAGNOSTICO_PTO`, `ID_DIAGNOSTICO_RPM`,
  `VENTANA_PTO_MIN`, `VENTANA_RPM_SEG`, `UMBRAL_RPM_MERCEDES`,
  `DURACION_MINIMA_PTO_SEG`, `LIMITE_PAGINA_STATUSDATA`, las ventanas de
  chunk `*_MS`, `TAMANO_LOTE_MULTICALL`), `calcularDurationBin`, `cacheReglas`.

## Lógica compartida con Mantenimiento (duplicada verbatim en ambos archivos)

Tema visual `T`, `apiCall`/`idDeRef`, `crear`/`crearPanel`/`aplicarEstilo`,
resolución de grupos/empresa/dispositivos (`esGrupoMarca`,
`obtenerGruposYDispositivos`, `construirMapaEmpresas`,
`resolverInfoDispositivo`), helpers de fecha (`aFechaInputValue`,
`formatearFechaHora`, `construirEtiquetasDias`, etc.), `construirFleetSizes`,
`construirFiltrosHtmlComun`, `inyectarJson`/`reemplazarBloque`/
`inyectarScriptMotor`/`ensamblarReporteHtmlBase`, `descargarHtml`/`slug`,
`actualizarEstado`/`actualizarBoton`, `inyectarEstilosGlobales`,
`cargarEmpresasEnSelector`, `MOTOR_JS_EMBEBIDO` (el motor de renderizado
`reporte_runtime_engine.js` incrustado -- ambos add-ins renderizan su
dashboard con el mismo motor, `DASH.kind==='habits_dashboard'` para este).

## Formulario simplificado (sin selector de tipo de reporte)

`construirFormulario` se reescribió desde cero (no es un simple recorte del
original): Empresa + Desde + Hasta + Atajos (pills "Última semana"/"Último
mes", mismo mecanismo `crearPill`/`marcarPillActiva` que el resto del repo) +
botón "Generar y descargar reporte", que llama directo a
`generarReporteOperaciones` tras validar empresa y rango de fechas. Sin la
fila "Tipo de reporte" (pills Fallas/Operaciones/Mini Expediente) ni el
sub-formulario de Mini Expediente -- ninguno de los dos existe en este
add-in. `construirEncabezado` también se reescribió (título "Operaciones",
subtítulo describiendo el reporte de hábitos).

## Verificación

- **Balance de paréntesis/llaves/corchetes** (mismo tokenizador con pila que
  respeta strings/comentarios/regex usado para `mantenimiento.js`):
  `operaciones.js` → OK, balance correcto.
- **Referencias colgantes a símbolos de Mantenimiento** (deben dar 0 en
  código, ignorando menciones dentro de comentarios):
  `generarReporteExpediente`/`ensamblarReporteHtmlExpediente`/
  `PLANTILLA_EXPEDIENTE_EMBEBIDA` → 0, `construirLinkGoogleMaps`/
  `resolverPosicionGps`/`construirLineaTiempoSenales`/
  `construirHistorialReciente`/`obtenerFallasRecientesParaPicker`/
  `resolverDatosDeFalla` → 0, `construirFilas`/`construirColumnasTabla`/
  `construirCrossfilterTabla`/`construirNarrativa`/
  `construirBannerSinFallas` → 0, `obtenerFaultDataPaginado`/
  `obtenerCatalogosDiagnosticos`/`agruparPorFalla`/`resolverSistema`/
  `criticidadDeRegistro`/`SISTEMAS` → 0, `generarReporte`/
  `ensamblarReporteHtml` (wrapper de Fallas) → 0, `pillExpediente`/
  `pillFallas`/`tipoReporte` → 0. `PLANTILLA_HTML_EMBEBIDA` aparece 1 vez,
  pero dentro de un comentario (referencia explícita a dónde vive esa
  variable en el add-in de Mantenimiento), no en código.
- **Sin duplicados accidentales**: 84 declaraciones de nivel superior en
  `operaciones.js`, ninguna repetida.
- **Literales embebidos byte-idénticos a la fuente**:
  `PLANTILLA_OPERACIONES_EMBEBIDA` (33018 caracteres) y `MOTOR_JS_EMBEBIDO`
  (61387 caracteres, idéntico carácter a carácter al que lleva
  `mantenimiento.js`) comparados contra la línea `var ... = "...";`
  correspondiente del `reportes.js` original -- idénticos los 2.
- **Zip**: `Operaciones_addin.zip` verificado con `zipfile` -- contiene
  exactamente `config.json`, `operaciones.html`, `operaciones.js`, y cada uno
  es byte-idéntico al archivo correspondiente en el repo.
- **No probado**: instalación real en MyGeotab (add-in nuevo, nunca se
  instaló; mismo pendiente que ya tenía el reporte de Operaciones dentro del
  add-in combinado).

## Decisión abierta (no confirmada con el usuario)

`reporte_operaciones_plantilla.html` (copia legible de referencia del HTML
que generó `PLANTILLA_OPERACIONES_EMBEBIDA`, no se lee en tiempo de
ejecución) se quedó en `_build_reportes/` en vez de moverse a esta carpeta --
el enunciado de la tarea no lo pidió y no afecta el funcionamiento de ningún
add-in, pero arquitectónicamente tendría más sentido vivir junto a
`operaciones.js`. Si se mueve más adelante, actualizar también el comentario
de cabecera de `PLANTILLA_OPERACIONES_EMBEBIDA` en este archivo (menciona la
ruta del HTML de origen).

## Pendiente

- Probar este add-in en una cuenta real de MyGeotab (instalación +
  generación de un reporte real).
- Las mismas decisiones no confirmadas que ya tenía el reporte de
  Operaciones dentro del add-in combinado (criterio de `REGLAS_HABITO` para
  RALENTÍ/VELOCIDAD) siguen sin confirmar -- ver
  `_build_reportes/cambios/2026-09-29_agregar-reporte-operaciones.md`.
