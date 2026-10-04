# Quitar "Mini Expediente" (se movió a Alertas por Severidad)

**Fecha:** 2026-10-01
**Archivos:** `_build_reportes/mantenimiento.js`, `_build_reportes/config.json`
(2.0 → 2.1), `Mantenimiento_addin.zip` (raíz del repo, regenerado)
**Archivo eliminado:** `_build_reportes/reporte_expediente_plantilla.html` (movido a
`_build_alertas_fallas/`, ver el changelog gemelo en esa carpeta)

## Por qué

El Mini Expediente (ficha de UN caso puntual de falla) se había agregado aquí el
mismo día (ver `cambios/2026-10-01_agregar-mini-expediente.md`). El usuario revisó
el add-in "Alertas por Severidad" (ya en producción, recién extraído a este repo en
`_build_alertas_fallas/`) y notó que, por cada fila de su tabla de fallas activas, ya
tenía datos más ricos que el picker del expediente de Mantenimiento: conductor
identificado (cruce con Excel de tripulaciones) y turno, ninguno de los dos
disponible aquí ("no hay esa asignación confiable en esta cuenta" era cierto en
Mantenimiento, pero Alertas por Severidad ya lo había resuelto). Decisión explícita:
mover el Mini Expediente POR COMPLETO a Alertas por Severidad, donde además no hace
falta picker -- cada fila de la tabla YA ES la selección completa.

Este add-in vuelve a tener un solo modo (Fallas), igual que cuando se separó
Operaciones a su propio add-in (`cambios/2026-10-01_separar-en-dos-addins.md`).

## Qué se quitó de `mantenimiento.js`

- Pill "Tipo de reporte" (Fallas / Mini Expediente) en `construirFormulario`
  (`envTipo`/`grupoTipo`/`tipoReporte`/`pillFallas`/`pillExpediente`/
  `marcarTipoActivo`/`filaTipo`) y su branch en el handler de
  "Generar y descargar reporte" (`if (tipoReporte.valor === 'expediente') {...}`).
- Sub-formulario completo de picker/entrada manual (`panelExpediente` y todo lo que
  contenía: `modoExpediente`, `grupoModo`, `pillModoLista`/`pillModoManual`,
  `marcarModoActivo`, `bloqueLista`, `estadoLista`, `selectCaso`,
  `casosDisponibles`, `cargarListaExpediente`, `bloqueManual`,
  `inputPlacaManual`/`inputFechaManual`, `obtenerSeleccionExpediente`,
  `actualizarVisibilidadExpediente`).
- Funciones: `construirLinkGoogleMaps`, `resolverPosicionGps`,
  `construirLineaTiempoSenales`, `construirHistorialReciente`,
  `obtenerFallasRecientesParaPicker`, `resolverDatosDeFalla`,
  `ensamblarReporteHtmlExpediente`, `generarReporteExpediente`, y las constantes
  `VENTANA_GPS_MIN`/`VENTANA_GPS_AMPLIADA_MIN`/`VENTANA_TIMELINE_HORAS`/
  `DIAS_HISTORIAL_VEHICULO`/`DIAS_PICKER_EXPEDIENTE`.
- `PLANTILLA_EXPEDIENTE_EMBEBIDA` (el literal embebido de la plantilla del
  expediente) y su comentario asociado.
- `reporte_expediente_plantilla.html` se eliminó de esta carpeta (ya no se lee desde
  aquí) -- se movió, CON cambios (se agregó Conductor/Turno), a
  `_build_alertas_fallas/reporte_expediente_plantilla.html`.
- Subtítulo visible del encabezado del add-in: "Reporte ejecutivo de Fallas o ficha
  de Mini Expediente..." → "Reporte ejecutivo de Fallas...".
- El comentario de cabecera del archivo (historial de versiones) se actualizó para
  reflejar que el Mini Expediente pasó por aquí brevemente el mismo día y se movió,
  en vez de reescribir la historia -- queda como registro honesto de qué pasó.

## Qué NO se tocó (a propósito, el reporte de Fallas las sigue usando directo)

`agruparPorFalla`, `obtenerFaultDataPaginado`, `obtenerCatalogosDiagnosticos`,
`construirFilas` -- ninguna de las 4 es exclusiva del expediente.

**Nota sobre `agruparPorFalla`**: tiene un campo `primeraFecha`/`primeraFechaActiva`
que se había agregado específicamente para el expediente (la "ventana real del
episodio"). Quedó **huérfano** tras este cambio -- `construirFilas` nunca lo leyó
(usa `ultimaFecha`/`activaciones`/`criticidad`/`diasActivos`), así que no cambia el
comportamiento del reporte de Fallas. Se dejó el campo en vez de tocar la lógica de
debounce de reactivación de `agruparPorFalla` solo para borrar algo inofensivo --
documentado en el comentario de la función.

## Verificación realizada

- **Balance de paréntesis/llaves/corchetes**: tokenizador con pila (mismo criterio
  que en tareas anteriores de este add-in: respeta strings, comentarios `//`/`/* */`,
  distingue regex de división) contra `mantenimiento.js` completo tras todos los
  cambios: pila final vacía, sin errores de apertura/cierre.
- **Literales embebidos restantes, byte a byte** (script Python puntual en el
  scratchpad, borrado al terminar): `PLANTILLA_HTML_EMBEBIDA` vs
  `reporte_plantilla.html`: 31682 vs 31682 caracteres, IGUAL; `MOTOR_JS_EMBEBIDO` vs
  `reporte_runtime_engine.js`: 59503 vs 59503 caracteres, IGUAL -- confirmando que la
  cirugía de líneas que quitó el bloque del expediente no tocó ningún byte de estos
  dos literales, que están en otras partes del archivo.
- **Grep de referencias colgantes**: 0 resultados en código real para
  `PLANTILLA_EXPEDIENTE_EMBEBIDA`, `construirLinkGoogleMaps`, `resolverPosicionGps`,
  `construirLineaTiempoSenales`, `construirHistorialReciente`,
  `obtenerFallasRecientesParaPicker`, `resolverDatosDeFalla`,
  `ensamblarReporteHtmlExpediente`, `generarReporteExpediente`, `tipoReporte`,
  `panelExpediente`, `modoExpediente`, `envTipo`/`grupoTipo`/`filaTipo`, y el resto
  de variables del sub-formulario listadas arriba -- las únicas coincidencias que
  quedan de "Mini Expediente" son comentarios históricos explicando qué pasó y por
  qué.
- **Contenido del zip**: `Mantenimiento_addin.zip` regenerado (zip viejo borrado
  primero) con PowerShell `Compress-Archive` y verificado con `zipfile` en Python --
  contiene EXACTAMENTE `config.json`, `mantenimiento.html`, `mantenimiento.js`, y
  `config.json` dentro del zip reporta `"version": "2.1"`.

## Pendiente

- No se pudo probar la instalación real dentro de MyGeotab durante esta tarea (sigue
  pendiente, como ya estaba documentado en changelogs anteriores de este add-in).
- Si en el futuro se quiere limpiar el campo huérfano `primeraFecha`/
  `primeraFechaActiva` de `agruparPorFalla`, es seguro hacerlo (ya se confirmó que
  ningún consumidor lo lee) -- no se hizo en esta tarea para minimizar el diff sobre
  una función que el reporte de Fallas usa en producción.
