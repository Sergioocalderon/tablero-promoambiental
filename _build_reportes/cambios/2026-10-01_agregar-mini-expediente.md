# Agregar "Mini Expediente" (ficha de un caso puntual de falla)

**Fecha:** 2026-10-01
**Archivos:** `_build_reportes/reportes.js`, `_build_reportes/reporte_expediente_plantilla.html`
(nuevo), `_build_reportes/config.json` (1.2 → 1.3), `Reportes_addin.zip` (raíz del repo)

## Contexto

El Add-in "Reportes" ya generaba 2 tipos de reporte (Fallas, Operaciones), ambos
dashboards de FLOTA completa. El usuario pidió un TERCER tipo, "Mini Expediente":
la ficha de UN SOLO caso puntual de falla, para entregar a quien corresponda
(taller/mantenimiento). Decisiones ya confirmadas con el usuario antes de
construir (no se volvieron a preguntar):

1. El formulario ofrece AMBAS formas de elegir el caso: lista de fallas
   recientes (picker con datos reales) o entrada manual (placa + fecha/hora
   aproximada).
2. Contenido: código SPN/FMI + descripción + criticidad + duración, ubicación/
   mapa en el momento (lat/lon real + link a Google Maps), línea de tiempo de
   señales relacionadas alrededor del momento, historial reciente del mismo
   vehículo (contexto de recurrencia). Explícitamente SIN nada de conductor/
   turno (no hay esa asignación confiable en esta cuenta).
3. Salida: HTML descargable, SIN envío por Telegram (decisión ya tomada).

## Qué se construyó

- `reporte_expediente_plantilla.html` (nuevo): plantilla "ficha de caso",
  mismo `<head>`/paleta de colores y tipografía que `reporte_plantilla.html`/
  `reporte_operaciones_plantilla.html` (mismas variables CSS `--ink`/`--accent`/
  `--alta`/`--media`/`--baja`/etc.) pero deliberadamente MÁS SIMPLE: sin
  `nav.toc`, sin gráficos, sin motor de cross-filter -- es una ficha estática
  de un solo caso, no un dashboard de flota. Secciones: detalle de la falla
  (badge de criticidad con los mismos 3 colores `--alta`/`--media`/`--baja`),
  ubicación, línea de tiempo de señales (tabla), historial reciente (tabla).
- `reportes.js`:
  - `PLANTILLA_EXPEDIENTE_EMBEBIDA`: mismo mecanismo de incrustación que
    `PLANTILLA_HTML_EMBEBIDA`/`PLANTILLA_OPERACIONES_EMBEBIDA` (string literal
    generado con `json.dumps(..., ensure_ascii=True)`, insertado con un script
    Python puntual, NO se lee con `fetch()` en runtime). A diferencia de esos
    2, el expediente NO inyecta `MOTOR_JS_EMBEBIDO` -- tiene su propio
    ensamblador (`ensamblarReporteHtmlExpediente`), reemplazo de marcadores
    simple (`reemplazarBloque`), porque no hay dashboard interactivo que
    arrancar.
  - Tercera pill "Mini Expediente" (`pillExpediente`) en el selector de "Tipo
    de reporte", mismo patrón exacto (`crearPill`, `T.color`) que
    Fallas/Operaciones.
  - Sub-formulario nuevo dentro de `construirFormulario`, visible solo con
    `tipoReporte.valor === 'expediente'` (oculta también la cuadrícula
    Empresa/Desde/Hasta/Atajos, que no aplica a un caso puntual):
    - Toggle "Elegir de una lista" / "Ingresar manualmente" (mismo estilo de
      pill segmentada que el resto).
    - Modo lista: `obtenerFallasRecientesParaPicker(empresaNombre)` -- reusa
      `obtenerFaultDataPaginado` + `agruparPorFalla` + `obtenerCatalogosDiagnosticos`
      para traer las fallas de los últimos 30 días de la empresa seleccionada,
      ordenadas por fecha más reciente primero, en un `<select size="6">` con
      el texto "Móvil — código — descripción — última vez: fecha". Se recarga
      si la empresa cambia mientras el picker está activo.
    - Modo manual: input de texto (móvil/placa) + `datetime-local`. La
      validación de la placa contra la lista real de dispositivos ocurre en
      `generarReporteExpediente` (mismo patrón de error vía `actualizarEstado`
      que el resto del formulario, no `alert()`).
  - `agruparPorFalla` (función COMPARTIDA con Fallas/Operaciones) recibió un
    campo nuevo, **additive**: `primeraFecha` (primera activación real del
    episodio, no solo `ultimaFecha` que ya existía) -- necesario para mostrar
    la ventana real del caso elegido en el picker. Ningún consumidor existente
    (`construirFilas`) lee ese campo, así que no cambia el comportamiento de
    Fallas/Operaciones.
  - Funciones nuevas: `construirLinkGoogleMaps`, `resolverPosicionGps`,
    `construirLineaTiempoSenales`, `construirHistorialReciente`,
    `obtenerFallasRecientesParaPicker`, `resolverDatosDeFalla`,
    `ensamblarReporteHtmlExpediente`, `generarReporteExpediente`.

## Patrones de Python replicados en JS (conceptos, no copia literal)

- **Ubicación GPS** (`resolverPosicionGps`): mismo criterio que
  `enriquecer_eventos_con_zona` en `herramientas/geotab_reglas_v3.py` -- UNA
  consulta `LogRecord` por ventana (no una por evento), ventana inicial
  ±10 min; si no hay ningún punto, se amplía UNA vez a ±30 min; si aun así no
  hay nada, se devuelve `null` y el reporte muestra "ubicación no disponible"
  en vez de inventar coordenadas. Formato del link EXACTO ya usado en todo el
  repo: `https://www.google.com/maps?q={lat},{lon}` (verbatim de
  `herramientas/geotab_reglas_v3.py` líneas ~485/1766).
- **Línea de tiempo de señales** (`construirLineaTiempoSenales`): mismo
  concepto que `investigar_caso_puntual`/`investigar_incidente` en
  `herramientas/detectar_regeneracion_dpf.py` -- una sola lista intercalada de
  señales, ordenada por hora, en vez de un bloque separado por señal. Trae, en
  ±2 h alrededor del momento: (a) el propio diagnóstico de la falla vía
  `StatusData` (si tiene valores numéricos -- se omite sin romper nada si no
  los tiene), (b) velocidad real vía `LogRecord.speed` (confirmado en este
  repo que NO existe diagnóstico de velocidad en `StatusData` para esta
  cuenta, ver comentario de `herramientas/calcular_ralenti_real_geotab.py`).

## Decisión NO confirmada explícitamente con el usuario: "momento" representativo en modo lista

Cuando el caso viene del picker, el episodio elegido puede abarcar varios días
(varias activaciones). El encargo pedía usar "el rango real del episodio"
como ventana de tiempo del caso -- eso se respeta para el texto de duración
(`primeraFecha` → `ultimaFecha`), pero para centrar la ubicación GPS y la
línea de tiempo de señales (que necesitan UN instante, no un rango) se usó la
**activación más reciente** (`ultimaFecha`) como "momento de la falla", bajo
el razonamiento de que es lo más relevante para entregar a mantenimiento hoy.
Es defendible pero no se confirmó explícitamente con el usuario -- si se
prefiere la PRIMERA activación u otro criterio, es un cambio de una línea en
`resolverDatosDeFalla`.

## Qué NO se incluyó, a propósito

- **Ignición en la línea de tiempo**: no se encontró con certeza un ID de
  diagnóstico de ignición confirmado contra la cuenta real durante esta tarea
  (no hay acceso de prueba a Geotab en este entorno) -- se documentó como
  pendiente en el código (`construirLineaTiempoSenales`) y en la plantilla
  (pie de página) en vez de arriesgar un ID incorrecto, siguiendo
  explícitamente la instrucción de no inventar IDs de diagnóstico.
- Envío por Telegram: no se agregó (decisión ya tomada con el usuario).
- Conductor/turno: no se agregó (no se pidió, no hay esa asignación confiable
  en esta cuenta, mismo criterio ya documentado para "turno" en el changelog
  de Operaciones).
- No se tocó `generarReporte`/`generarReporteOperaciones` ni la lógica
  existente de Fallas/Operaciones, salvo el campo additive `primeraFecha` en
  `agruparPorFalla` (compartida) y el branch nuevo en el click de
  "Generar y descargar reporte" (el resto del handler quedó igual).

## Verificación realizada

- **Literales embebidos, byte a byte** (script Python puntual, regex +
  `json.loads`, borrado del scratchpad al terminar, no quedó en el repo):
  - `PLANTILLA_HTML_EMBEBIDA` vs `reporte_plantilla.html`: 31682 vs 31682
    caracteres, IGUAL.
  - `MOTOR_JS_EMBEBIDO` vs `reporte_runtime_engine.js`: 59503 vs 59503
    caracteres, IGUAL.
  - `PLANTILLA_OPERACIONES_EMBEBIDA` vs `reporte_operaciones_plantilla.html`:
    31692 vs 31692 caracteres, IGUAL.
  - `PLANTILLA_EXPEDIENTE_EMBEBIDA` (nuevo) vs
    `reporte_expediente_plantilla.html`: 6422 vs 6422 caracteres, IGUAL.
- **Balance de paréntesis/llaves/corchetes de `reportes.js`**: se corrió un
  tokenizador con pila (respeta strings `'...'`/`"..."`/`` `...` ``,
  comentarios `//` y `/* */`, y distingue literal regex de división por
  heurística de "último token significativo") contra el archivo completo
  DESPUÉS de todos los cambios de esta tarea: **`OK: balance de
  paréntesis/llaves/corchetes correcto`** -- sin ningún error de apertura/
  cierre, incluyendo el código nuevo agregado hoy. (`_build_reportes/` es
  carpeta no versionada todavía en este repo -- no hay un `git show HEAD` con
  el que diferenciar "antes" de "después" byte a byte, pero el resultado
  absoluto ya es "balance correcto", más fuerte que una comparación delta.)
- **Contenido del zip**: `Reportes_addin.zip` regenerado con PowerShell
  `Compress-Archive` (zip viejo borrado primero) y verificado con `zipfile` en
  Python -- contiene EXACTAMENTE `config.json`, `reportes.html`, `reportes.js`
  (nada de plantillas sueltas), y `config.json` dentro del zip reporta
  `"version": "1.3"`.
- Scripts Python puntuales de incrustación/verificación: ambos vivieron en el
  directorio de scratchpad de la sesión (fuera del repo), no en
  `herramientas/` ni en la raíz -- no quedó ningún archivo de verificación
  suelto dentro del repo.

## Pendiente de verificar manualmente

1. **Ignición en la línea de tiempo** (ver arriba): confirmar contra
   `api.get('Diagnostic')` en una sesión real cuál es el ID correcto antes de
   agregarla -- hoy la línea de tiempo solo trae el diagnóstico de la propia
   falla + velocidad (LogRecord).
2. **Decisión del "momento representativo"** en modo lista (última activación
   vs. primera) -- ver sección dedicada arriba, no confirmada explícitamente.
3. **No se pudo probar la instalación real dentro de MyGeotab** durante esta
   tarea (es un add-in de navegador, mismo pendiente que ya quedó abierto para
   Fallas y Operaciones) -- en particular, no se generó un Mini Expediente
   real contra una cuenta con datos reales para revisar visualmente que el
   picker, el modo manual y la ficha final se vean y comporten como se
   espera.
4. El picker de "Elegir de una lista" trae fallas de TODA la empresa de los
   últimos 30 días sin límite de cantidad -- en una empresa grande con mucha
   actividad de fallas, el `<select>` podría quedar con una lista larga; no se
   agregó paginación ni buscador porque no se pidió, pero es lo primero a
   revisar si el picker se siente lento o difícil de usar en la práctica.
5. El campo `criticidad` de un caso en modo manual se calcula con
   `criticidadDeRegistro` sobre el registro `FaultData` más cercano a la
   fecha/hora ingresada -- esa función ya tenía la limitación conocida
   documentada en `reportes.js` ("SIN VERIFICAR CONTRA DATOS REALES") de que
   no se confirmó contra una cuenta real que `redStopLamp`/
   `protectWarningLamp`/`amberWarningLamp` existan y se comporten como se
   asume; se hereda esa misma limitación aquí, no se resolvió en esta tarea.
