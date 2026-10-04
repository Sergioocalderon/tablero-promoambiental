# Auditoría: marca Chevrolet

**Fecha:** 2026-10-03
**Versión:** 2.1 → 2.2
**Archivos:** `mantenimiento.js`, `config.json`, `Mantenimiento_addin.zip`

## Contexto

Auditoría contra la cuenta real (Chromium + API real, solo lectura). Reporte
de Fallas de Bogotá, última semana, recalculado por fuera en Python, todo
exacto:

- 142 fallas distintas.
- 24 / 31 móviles con fallas.
- 22 ALTA en 3 móviles, 33 MEDIA y 87 BAJA.

**Verificado lo que el código marcaba como "SIN VERIFICAR"**
(`criticidadDeRegistro`): los campos `redStopLamp`, `protectWarningLamp` y
`amberWarningLamp` existen en el 100 % de los FaultData reales (3.768
registros) y tienen valores reales (494 rojas y 1.437 ámbar).
`protectWarningLamp` vino en 0 en esta muestra. Existe además `malfunctionLamp`
(MIL, 246 en true), que hoy no se usa para la criticidad.

## Cambio

- `PALABRAS_GRUPO_MARCA` + `'chevrolet'`. Verificado con la corrida real: el
  comparativo por marca ahora muestra "CHEVROLET - NHR" (3) y "CHEVROLET VAN -
  N400" (4) en vez de "Sin marca".

## Observaciones (sin cambiar)

- El KPI "Sistema principal" sale "Otro / Sin clasificar (46,5 %)": la
  taxonomía de `SISTEMAS` no reconoce casi la mitad de las fallas.
- Al abrir el reporte descargado, la consola muestra 10 errores "No se pudo
  renderizar la gráfica…". Ya estaban antes de este cambio: son los bloques
  `data-*` que la plantilla deja en `{}` a propósito (ver comentario en
  `ensamblarReporteHtmlBase`). `recomputeDashboard` los reemplaza en el mismo
  ciclo, y las 10 gráficas se ven completas.
