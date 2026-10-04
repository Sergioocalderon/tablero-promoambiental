# Separar el add-in combinado en dos: Mantenimiento + Operaciones

## Contexto

Hasta hoy este add-in (`reportes.js`/`reportes.html`, `config.json` con
`name: "Reportes"`) tenía TRES tipos de reporte elegibles por pill dentro del
mismo formulario: Fallas, Mini Expediente (ver
`cambios/2026-10-01_agregar-mini-expediente.md`) y Operaciones (hábitos:
velocidad, ralentí, PTO -- ver
`cambios/2026-09-29_agregar-reporte-operaciones.md` y
`cambios/2026-10-01_implementar-turno-operaciones.md`). El usuario pidió
explícitamente separarlo en DOS add-ins independientes de MyGeotab:
"Mantenimiento" (Fallas + Mini Expediente) y "Operaciones" (solo hábitos, sin
selector). Esta carpeta se queda siendo el add-in de Mantenimiento -- mínima
disrupción al historial de changelogs ya acumulado aquí desde el 2026-09-29.
El add-in nuevo nace en `_build_operaciones/` (ver
`_build_operaciones/cambios/2026-10-01_creacion-addin-operaciones.md`).

**Contrapartida aceptada explícitamente por el usuario**: el código
compartido entre los dos add-ins (conexión a la API, catálogos de
diagnósticos, resolución de empresa/dispositivos, el motor de plantillas
`MOTOR_JS_EMBEBIDO`, el sistema de diseño `T`/`crearPill`/
`inyectarEstilosGlobales`, helpers de fecha) queda DUPLICADO, verbatim, en
los dos archivos `.js` resultantes. No es un error a corregir -- Geotab no
soporta compartir un módulo JS entre dos add-ins de forma sencilla, y el
usuario ya decidió que la separación completa de archivos es preferible a
mantener un acoplamiento entre dos add-ins con ciclos de vida independientes.

## Qué se quitó de este add-in (se mudó a Operaciones)

- La pill "Operaciones" del selector "Tipo de reporte" (ahora solo tiene
  "Fallas" / "Mini Expediente") y el branch correspondiente en el handler de
  envío (`if (tipoReporte.valor === 'operaciones') generarReporteOperaciones(...)`).
- Toda la lógica exclusiva de Operaciones: `REGLAS_HABITO`, el pipeline de
  PTO (`apiMultiCall`, `construirLlamadasPorChunksOperaciones`,
  `agruparPorCercaniaOperaciones`, `construirVentanasPorVehiculoOperaciones`,
  `consultarStatusDataAgrupadoOperaciones`, `confirmarPtoCercano`,
  `agregarPicoRpm`), `obtenerReglas`/`resolverReglasHabito`/
  `obtenerEventosDeRegla`, `horaBogota`/`calcularTurno`,
  `construirFilaOperacion`, `construirColumnasTablaOperaciones`,
  `construirCrossfilterTablaOperaciones`, `formatearDuracionOperaciones`,
  `construirFilasTablaOperaciones`, `generarReporteOperaciones`,
  `ensamblarReporteHtmlOperaciones`, `PLANTILLA_OPERACIONES_EMBEBIDA` y todas
  las constantes de PTO/RPM (`ID_DIAGNOSTICO_PTO`, `ID_DIAGNOSTICO_RPM`,
  `VENTANA_PTO_MIN`, `VENTANA_RPM_SEG`, `UMBRAL_RPM_MERCEDES`,
  `DURACION_MINIMA_PTO_SEG`, `LIMITE_PAGINA_STATUSDATA`, ventanas de chunk
  `*_MS`, `TAMANO_LOTE_MULTICALL`, `calcularDurationBin`, `cacheReglas`).

## Qué quedó en este add-in (Mantenimiento)

- Fallas: `obtenerFaultDataPaginado`, `obtenerCatalogosDiagnosticos`, la
  taxonomía `SISTEMAS`/`resolverSistema`, `criticidadDeRegistro`,
  `agruparPorFalla`, `construirFilas`, `construirColumnasTabla`,
  `construirCrossfilterTabla`, `construirNarrativa`,
  `construirBannerSinFallas`, `ensamblarReporteHtml`, `generarReporte`,
  `PLANTILLA_HTML_EMBEBIDA`.
- Mini Expediente: `construirLinkGoogleMaps`, `resolverPosicionGps`,
  `construirLineaTiempoSenales`, `construirHistorialReciente`,
  `obtenerFallasRecientesParaPicker`, `resolverDatosDeFalla`,
  `ensamblarReporteHtmlExpediente`, `generarReporteExpediente`,
  `PLANTILLA_EXPEDIENTE_EMBEBIDA`. Nótese que `obtenerFaultDataPaginado`,
  `obtenerCatalogosDiagnosticos` y `agruparPorFalla` los usa TAMBIÉN Mini
  Expediente (para su picker/historial), no son exclusivos de Fallas -- se
  quedaron en la categoría "compartida entre Fallas y Mini Expediente", no se
  duplicaron dentro de este mismo archivo.
- Compartido con Operaciones (duplicado también en `operaciones.js`): tema
  `T`, `apiCall`/`idDeRef`, `crear`/`crearPanel`/`aplicarEstilo`,
  `esGrupoMarca`/`obtenerGruposYDispositivos`/`construirMapaEmpresas`/
  `resolverInfoDispositivo`, helpers de fecha (`aFechaInputValue`,
  `formatearFechaHora`, `construirEtiquetasDias`, etc.),
  `construirFleetSizes`, `construirFiltrosHtmlComun`,
  `inyectarJson`/`reemplazarBloque`/`inyectarScriptMotor`/
  `ensamblarReporteHtmlBase`, `descargarHtml`/`slug`,
  `actualizarEstado`/`actualizarBoton`, `inyectarEstilosGlobales`,
  `cargarEmpresasEnSelector`, `MOTOR_JS_EMBEBIDO`.

## Archivos renombrados/creados

- `reportes.html` → `mantenimiento.html` (shell sin cambios salvo el
  `<script src>` y el `id` del contenedor raíz, de `reportesRoot` a
  `mantenimientoRoot`).
- `reportes.js` → `mantenimiento.js`. El wrapper pasó de
  `geotab.addin.reportes = function () {...}` a
  `geotab.addin.mantenimiento = function () {...}` (mismo criterio que el
  resto del repo: el nombre de la función del add-in sigue al nombre del
  archivo .js, no al `name` de `config.json` -- ver `dashboardAnalisisFallas.js`
  / `sobreRevolucionPTO.js`).
- `config.json`: `name`/`menuName.en` de `"Reportes"` a `"Mantenimiento"`,
  `items[0].url` a `mantenimiento.html`, `version` `1.3` → `2.0` (cambio
  estructural grande: separación de add-in, no un fix puntual).
- `Reportes_addin.zip` (raíz del repo) eliminado; `Mantenimiento_addin.zip`
  generado en su lugar con exactamente `config.json`, `mantenimiento.html`,
  `mantenimiento.js`.
- `reporte_plantilla.html` / `reporte_expediente_plantilla.html` /
  `reporte_runtime_engine.js` (copias legibles de referencia, no se leen en
  tiempo de ejecución) se quedaron sin tocar en esta carpeta.
  `reporte_operaciones_plantilla.html` también se quedó aquí sin mover --
  **decisión dudosa, no confirmada con el usuario**: ahora es una referencia
  que describe el reporte del OTRO add-in; se dejó porque el enunciado de la
  tarea no pidió moverla y porque, al no leerse en tiempo de ejecución, no
  afecta el funcionamiento de ningún add-in, pero arquitectónicamente tendría
  más sentido vivir junto a `operaciones.js`.

## Cómo se hizo la separación (metodología)

Inventario completo de las ~97 declaraciones de nivel superior de
`reportes.js` (`function`/`var`), cada una clasificada en Compartida /
Mantenimiento / Operaciones a partir de qué función llama a cuál (verificado
con `grep` de cada símbolo contra el archivo completo, no por nombre/intuición
-- p.ej. `construirEtiquetasDias`, `construirFleetSizes` y
`construirFiltrosHtmlComun` parecían candidatas a "Fallas" pero en realidad
las llama también `generarReporteOperaciones`, así que son Compartidas).
Extracción automática por script (con un tokenizador que reconoce
exactamente los comentarios de 2 espacios de indentación -- la misma
indentación que usan TODOS los comentarios de sección de este archivo -- para
que cada comentario de documentación viaje CON la declaración que describe en
vez de quedarse pegado al bloque anterior; los comentarios internos de una
función, más indentados, nunca matchean ese patrón y no interfieren).
`construirEncabezado`, `construirFormulario` y el objeto `return {...}` del
add-in se reescribieron a mano (no son un simple recorte: el formulario
pierde selector/pill/sub-formulario según el add-in).

## Verificación

- **Balance de paréntesis/llaves/corchetes** (tokenizador con pila que
  respeta strings/comentarios/regex): `mantenimiento.js` → OK, balance
  correcto. (El mismo tokenizador corrido contra el `reportes.js` original
  también dio OK, como control de que el tokenizador en sí es correcto.)
- **Referencias colgantes a símbolos de Operaciones** (deben dar 0 en código,
  ignorando menciones dentro de comentarios): `REGLAS_HABITO` → 0,
  `generarReporteOperaciones` → 0 en código (1 mención en un comentario de
  cabecera, histórica), `ensamblarReporteHtmlOperaciones` → 0,
  `construirFilaOperacion`/`construirColumnasTablaOperaciones`/
  `construirCrossfilterTablaOperaciones`/`formatearDuracionOperaciones` → 0,
  `horaBogota`/`calcularTurno` → 0, `apiMultiCall` → 0 en código (1 mención
  en el comentario de cabecera, heredado del original), `confirmarPtoCercano`/
  `agregarPicoRpm` → 0, `obtenerReglas`/`resolverReglasHabito`/
  `obtenerEventosDeRegla`/`cacheReglas` → 0, `ID_DIAGNOSTICO_PTO`/
  `ID_DIAGNOSTICO_RPM` → 0, `pillOperaciones` → 0.
- **Sin duplicados accidentales**: 82 declaraciones de nivel superior en
  `mantenimiento.js`, ninguna repetida (verificado por nombre).
- **Literales embebidos byte-idénticos a la fuente**: `PLANTILLA_HTML_EMBEBIDA`
  (32907 caracteres), `PLANTILLA_EXPEDIENTE_EMBEBIDA` (6841 caracteres) y
  `MOTOR_JS_EMBEBIDO` (61387 caracteres) comparados carácter a carácter contra
  la línea `var ... = "...";` del `reportes.js` original -- idénticos los 3.
- **Zip**: `Mantenimiento_addin.zip` verificado con `zipfile` -- contiene
  exactamente `config.json`, `mantenimiento.html`, `mantenimiento.js`, y cada
  uno es byte-idéntico al archivo correspondiente en el repo.
- **No probado**: instalación real en MyGeotab de ninguno de los dos add-ins
  resultantes (sigue pendiente, como ya estaba documentado para la versión
  combinada).

## Ajustes menores durante la separación

- Dos comentarios de cabecera de literal embebido quedaron con una referencia
  colgante tras la separación ("mismo mecanismo que `PLANTILLA_HTML_EMBEBIDA`
  arriba" dentro de lo que ahora es `operaciones.js`, donde esa variable ya
  no existe; y "mismo mecanismo que PLANTILLA_HTML_EMBEBIDA/
  PLANTILLA_OPERACIONES_EMBEBIDA" dentro de lo que ahora es este archivo,
  donde `PLANTILLA_OPERACIONES_EMBEBIDA` ya no existe). Se reescribieron para
  apuntar al archivo correcto en vez de borrarse a ciegas.
- Prefijos de log (`console.warn`/`console.error`) que decían literal
  `'Reportes: ...'` o `'Reportes (Operaciones): ...'`/`'Reportes (expediente): ...'`
  se renombraron a `'Mantenimiento: ...'` (y se simplificó la redundancia
  `(Operaciones)` en los que quedaron solo en `operaciones.js`, donde ya no
  hace falta desambiguar) -- cosmético, no cambia ningún criterio de negocio.

## Pendiente

- Probar los 2 add-ins resultantes (Mantenimiento y Operaciones) en una
  cuenta real de MyGeotab.
- Decidir si `reporte_operaciones_plantilla.html` se muda a
  `_build_operaciones/` (ver nota en "Archivos renombrados/creados" arriba).
