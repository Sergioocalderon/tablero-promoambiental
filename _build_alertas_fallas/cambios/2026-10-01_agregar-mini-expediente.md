# Adoptar el add-in al repo + agregar "Mini Expediente" por fila

**Fecha:** 2026-10-01
**Archivos:** `_build_alertas_fallas/alertasFallas.js`, `_build_alertas_fallas/config.json`
(nuevo), `_build_alertas_fallas/reporte_expediente_plantilla.html` (nuevo, movida desde
`_build_reportes/`), `AlertasPorSeveridad_addin.zip` (raíz del repo)

## Contexto: primera extracción de este add-in al repo

"Alertas por Severidad" ya estaba instalado y en PRODUCCIÓN en MyGeotab (monitor en
tiempo real de fallas activas, agrupadas por vehículo, con cruce de conductor vía
Excel de tripulaciones, turno, polling/alarma sonora), pero nunca había tenido
`config.json` en este repo -- se extrajo de Descargas a `_build_alertas_fallas/`
(`alertasFallas.html`/`alertasFallas.js`) como parte de esta misma tarea.

**`config.json` es nuevo, no se pudo leer cuál era la versión real instalada hoy en
Geotab** (no hay forma de consultarlo desde este entorno). Se usó
`"name": "Alertas por Severidad"` (coincide literal con el comentario de cabecera de
`alertasFallas.js`, línea 2) y `"version": "1.0"` como punto de partida de
trazabilidad DESDE AHORA -- si la versión realmente instalada era otra, hay que
corregir este valor a mano, no se puede inferir.

## Qué se pidió

El usuario revisó este add-in y notó que, por cada fila de falla, ya tenía datos más
ricos que el picker del Mini Expediente que se acababa de construir en Mantenimiento
(`_build_reportes/`, ver `cambios/2026-09-29.../2026-10-01_agregar-mini-expediente.md`
en esa carpeta): conductor identificado (`buscarConductor`, cruce con el Excel de
tripulaciones -- más confiable que el campo nativo `driver` de Geotab, casi siempre
vacío en esta flota), turno (`clasificarTurno`), y un panel de historial ya
expandible por fila (`obtenerHistorialFalla`/`crearPanelHistorial`/
`llenarPanelHistorial`). Decisión explícita: mover el Mini Expediente POR COMPLETO
aquí, con un botón "📋 Generar expediente" por fila (la fila YA ES la selección
completa, sin picker) más una entrada manual de respaldo para casos que ya no
aparecen activos. Ver el changelog gemelo en `_build_reportes/cambios/
2026-10-01_quitar-mini-expediente.md` para qué se quitó de Mantenimiento.

## Qué se construyó

- `reporte_expediente_plantilla.html` (movida desde `_build_reportes/`, con cambios):
  se agregó un cuarto `.header-item` ("Conductor", con el turno al lado:
  `{{CONDUCTOR}} · Turno {{TURNO}}`) y el `.header-grid` pasó de `repeat(3,...)` a
  `repeat(4,...)` columnas; se agregó un párrafo nuevo al pie explicando el origen
  del conductor (cruce manual de Excel, coincidencia exacta de vehículo+día) y del
  turno. El resto de la plantilla (detalle de falla, ubicación, línea de tiempo,
  historial) quedó igual que la versión de Mantenimiento.
- `alertasFallas.js`, nueva sección "Mini Expediente" (antes de
  `crearPildoraCriticidad`):
  - `PLANTILLA_EXPEDIENTE_EMBEBIDA`: mismo mecanismo de incrustación ya usado en
    `mantenimiento.js`/`operaciones.js` (string literal generado con
    `json.dumps(..., ensure_ascii=True)`, script Python puntual en el scratchpad de
    la sesión, borrado al terminar -- NO se lee con `fetch()` en runtime).
  - **GPS y línea de tiempo de señales**: portados TAL CUAL desde
    `mantenimiento.js` (`construirLinkGoogleMaps`, `resolverPosicionGps`,
    `construirLineaTiempoSenales`) -- no existía nada parecido en este archivo.
    Mismas ventanas (±10 min GPS, ampliable a ±30 min; ±2 h línea de tiempo) y
    mismo link `https://www.google.com/maps?q={lat},{lon}`. Misma limitación ya
    documentada: la línea de tiempo NO incluye ignición (no se pudo confirmar con
    certeza el ID de diagnóstico correcto contra la cuenta real).
  - **Conductor**: se agregó al expediente (MEJORA real sobre la versión vieja, que
    no lo tenía) usando `buscarConductor`/`textoConductorConGrupo`, ya existentes en
    este archivo -- sin tocar su lógica.
  - **Turno**: reutiliza `clasificarTurno` (ya existente) en vez de duplicar lógica.
    **Posible inconsistencia señalada, NO corregida** (no se pidió): `clasificarTurno`
    usa `hora.getHours()` (hora LOCAL del navegador), mientras que
    `calcularTurno`/`horaBogota` en el add-in de Operaciones usa
    `Intl.DateTimeFormat` con `America/Bogota` EXPLÍCITO a propósito (ver
    `_build_reportes/cambios/2026-10-01_implementar-turno-operaciones.md`),
    precisamente para no depender de la zona horaria del equipo que genera el
    reporte. Los LÍMITES horarios (T1 05:00–13:00, T2 13:00–21:00, T3 21:00–05:00)
    son IDÉNTICOS en ambos add-ins -- la diferencia es solo el origen de la hora.
    Documentado en el código (`ensamblarYDescargarExpediente`) y aquí para que el
    usuario decida si vale la pena alinear `clasificarTurno` a `Intl.DateTimeFormat`.
  - **Historial reciente del vehículo**: NO se reutilizó `obtenerHistorialFalla` tal
    cual (esa función es POR CÓDIGO puntual: cuenta activaciones/desactivaciones de
    UN diagnóstico+failureMode para el panel "Ver historial" de una fila). Se
    generalizó en una función nueva, `obtenerHistorialVehiculo`, que reutiliza el
    MISMO patrón de consulta (`FaultData` de un dispositivo en una ventana de días +
    catálogos Diagnostic/FailureMode + `clasificarCriticidadEvento`) pero agrupando
    TODOS los códigos del vehículo (excluyendo el código del caso actual), en vez de
    reimplementar `construirHistorialReciente`/`agruparPorFalla` de
    `mantenimiento.js` desde cero. A propósito NO adopta el debounce de reactivación
    de 10 min que tiene `agruparPorFalla` -- "activaciones" aquí sigue siendo el
    conteo CRUDO de registros `faultState==='Active'`, igual que ya hacía
    `obtenerHistorialFalla` para el panel por fila. Es la misma duplicación
    intencional entre archivos que ya documenta `CLAUDE.md`, no una inconsistencia
    nueva.
  - `agregarInfoVehiculo`: `resolverMarcaYTipologia` ya calculaba `tipologia` pero se
    descartaba -- se guarda ahora (`info.tipologia` / `f.tipologia`) porque el
    expediente necesita mostrarla. Cambio additive, no afecta a ningún consumidor
    existente de `agregarInfoVehiculo`.
  - `resolverCasoDesdeFila(it)` / `resolverCasoManual(texto, fechaHora)`: normalizan
    ambos orígenes (fila de la tabla / entrada manual) al mismo formato de "caso"
    que consume `ensamblarYDescargarExpediente`. La entrada manual resuelve el
    vehículo con `resolverDispositivoPorTexto` (nuevo -- este archivo nunca traía el
    catálogo completo de `Device` en ningún otro flujo) y busca el `FaultData` más
    cercano a la fecha/hora ingresada dentro de ±2 h; si no encuentra nada, lo dice
    explícitamente (`encontrada: false`) en vez de fabricar un caso vacío.
  - `generarExpedienteDesdeFila(it, enlace)`: dispara la descarga desde el link de la
    fila, deshabilitando/renombrando el link mientras genera (sin bloquear toda la
    pantalla).
  - `construirPanelExpedienteManual(contenedor)`: panel nuevo, agregado en
    `initialize()` justo después del control de tripulaciones (cerca de
    encabezado/filtros, como pidió el usuario) -- móvil/placa + fecha/hora +
    validación inline (mismos mensajes de error específicos que el resto del
    formulario, nunca un `alert()` silencioso salvo para errores inesperados de red).
  - Botón "📋 Generar expediente" agregado en la celda de acciones (`celdaBuscar`) de
    `crearTarjetaVehiculo`, junto a "🔍 Buscar causa"/"🕘 Ver historial" -- pedido
    explícito. **Extensión no pedida explícitamente, por consistencia**: el mismo
    botón se agregó también en `construirTablaCronologica` (vista "Más recientes",
    `celdaAcciones`), que muestra las MISMAS filas aplanadas con las mismas acciones
    -- dejarlo solo en una vista hubiera sido inconsistente para el usuario.

## Verificación realizada

- **Balance de paréntesis/llaves/corchetes**: tokenizador con pila (respeta strings
  `'...'`/`"..."`/`` `...` ``, comentarios `//`/`/* */`, distingue regex de división
  por heurística de último token significativo) contra `alertasFallas.js` completo
  tras todos los cambios: pila final vacía, sin errores de apertura/cierre.
- **Literal embebido, byte a byte** (script Python puntual en el scratchpad,
  `json.loads` del literal extraído + comparación directa contra el archivo fuente,
  borrado al terminar): `PLANTILLA_EXPEDIENTE_EMBEBIDA` vs
  `reporte_expediente_plantilla.html`: 7015 vs 7015 caracteres, **IGUAL byte a
  byte**.
- **Contenido del zip**: `AlertasPorSeveridad_addin.zip` (nuevo) verificado con
  `zipfile` en Python -- contiene EXACTAMENTE `config.json`, `alertasFallas.html`,
  `alertasFallas.js`.
- **Comparación de límites de turno** (pedida explícitamente): `clasificarTurno` en
  este archivo usa T1 `>=5 && <13`, T2 `>=13 && <21`, T3 el resto -- IDÉNTICO a
  T1 05:00–13:00 / T2 13:00–21:00 / T3 21:00–05:00 confirmados para Operaciones el
  2026-10-01. Los LÍMITES coinciden; lo que difiere es que `clasificarTurno` lee
  `hora.getHours()` (hora del navegador) en vez de forzar `America/Bogota` como sí
  hace `horaBogota`/`calcularTurno` en Operaciones -- ver nota de inconsistencia
  arriba, no corregida a propósito (no se pidió).

## Pendiente de verificar manualmente

1. No se pudo probar la instalación real dentro de MyGeotab durante esta tarea (es
   un add-in de navegador) -- en particular, generar un expediente real desde una
   fila de la tabla y desde la entrada manual contra una cuenta con datos reales,
   para revisar visualmente que el conductor/turno/GPS/línea de tiempo/historial se
   vean como se espera.
2. La versión `"1.0"` en `config.json` es un punto de partida, no un hecho
   confirmado -- si la versión real instalada hoy en Geotab era otra, corregirla a
   mano (no hay forma de consultarla desde este entorno).
3. La inconsistencia de `clasificarTurno` (hora de navegador) vs
   `horaBogota`/`calcularTurno` (hora Bogotá explícita) de Operaciones -- ver arriba
   -- queda documentada para que el usuario decida si vale la pena alinearla; no se
   tocó `clasificarTurno` porque también la usan las columnas "Turno" ya existentes
   de la tabla de fallas activas (cambiarla afecta más que solo el expediente).
4. `obtenerHistorialVehiculo` no adopta el debounce de reactivación de
   `agruparPorFalla` (mantenimiento.js) -- "activaciones" en el historial del
   expediente puede ser un número más alto que en un reporte de Mantenimiento para
   el mismo vehículo/código, por diseño (mismo criterio que ya usaba
   `obtenerHistorialFalla` en este archivo). Si se quiere un número directamente
   comparable entre los dos add-ins, habría que portar el debounce.
