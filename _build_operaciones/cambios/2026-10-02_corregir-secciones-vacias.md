# Corregir secciones vacías en el reporte de Operaciones

**Fecha:** 2026-10-02
**Archivos:** `_build_operaciones/reporte_operaciones_plantilla.html`,
`_build_operaciones/operaciones.js` (`PLANTILLA_OPERACIONES_EMBEBIDA`),
`_build_operaciones/config.json`, `Operaciones_addin.zip`

## Síntoma reportado

El reporte descargado mostraba los KPIs, pero las gráficas salían vacías aunque
sí hubiera eventos: evolución diaria, distribución por tipo, rankings de
velocidad, ralentí y PTO, turnos y reglas.

## Causa

En la plantilla, el contenedor `#hab_evolucion` tenía `data-kind="evolstack"`,
pero el motor (`reporte_runtime_engine.js`, `recomputeChart`) solo reconoce
`evostack`. Con un tipo desconocido, el motor caía a `renderBar`, que espera
`spec.series`. La serie de evolución no trae ese campo, así que lanzaba
`TypeError: Cannot read properties of undefined (reading 'forEach')`.

Como `hab_evolucion` es la PRIMERA gráfica que pinta
`recomputeHabitsDashboard()`, la excepción abortaba todo el recálculo
(`runInitPhase('recálculo')` solo la registra en consola). Por eso se veían los
KPIs, que se asignan antes, y ninguna gráfica.

## Cambio

- Plantilla: `data-kind="evolstack"` → `data-kind="evostack"`.
- `PLANTILLA_OPERACIONES_EMBEBIDA` se regeneró desde el HTML
  (`json.dumps(..., ensure_ascii=True)`); se verificó que es idéntica byte a
  byte a la fuente.
- No se tocó el motor (está duplicado tal cual en `mantenimiento.js`). La
  plantilla de Fallas no usa `evostack` y no se ve afectada.
- `config.json`: versión `1.0` → `1.1`.

## Verificación

Se armó un reporte con 120 eventos sintéticos de los 3 tipos, con el mismo
ensamblado que `ensamblarReporteHtmlBase`, y se abrió en Chromium (Playwright):

- Antes: 0/12 gráficas renderizadas, con el `TypeError` de arriba en consola.
- Después: 12/12 gráficas renderizadas y 0 errores en consola.

**No probado:** generar el reporte con datos reales desde MyGeotab.
