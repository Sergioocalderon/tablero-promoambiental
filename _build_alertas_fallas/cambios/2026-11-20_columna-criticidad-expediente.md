# v1.23 — Columna de criticidad del Expediente consolidado

**Problema:** en el Expediente consolidado (ej. móvil 1803) la pastilla "MEDIA" se partía en dos líneas ("MEDI / A") y los títulos "CRITICIDAD" y "VECES" quedaban pegados, porque la columna medía 50 px y la de Veces 28 px.

**Cambio:** columna Criticidad 50→72 px, Veces 28→44 px y la pastilla de criticidad con `white-space:nowrap`. Se cambió en `alertasFallas.js` (plantilla embebida) y en `reporte_expediente_consolidado_plantilla.html`. La columna Descripción cede ese espacio.
