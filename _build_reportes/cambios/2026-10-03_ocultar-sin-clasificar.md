# Ocultar "Otro / Sin clasificar" del desglose por sistema

**Fecha:** 2026-10-03
**Versión:** 2.2 → 2.3
**Archivos:** `mantenimiento.js` (+ `MOTOR_JS_EMBEBIDO` y
`PLANTILLA_HTML_EMBEBIDA` regenerados), `reporte_runtime_engine.js`,
`reporte_plantilla.html`, `config.json`, `Mantenimiento_addin.zip`. Por el
motor compartido también cambia `../_build_operaciones/operaciones.js`
(Operaciones 1.3).

## Problema

En la auditoría del mismo día, el KPI "Sistema principal" del reporte de Bogotá
salía **"Otro / Sin clasificar (46,5 %)"**: casi la mitad de las fallas no
tienen una palabra clave de `SISTEMAS` en el nombre (códigos propietarios,
mensajes genéricos). El usuario pidió ocultarlo porque solo mete ruido.

## Cambio

Mismo criterio que ya aplica `dashboardAnalisisFallas.js` desde el
2026-09-19: "Otro / Sin clasificar" se excluye del **KPI "Sistema
principal"**, del **gráfico "Fallas distintas por sistema"** y de la **frase
"El sistema con más fallas es…"** de la narrativa. Esas fallas **siguen
contando** en el total de fallas distintas, en el resto de gráficos y en la
tabla de detalle (columna Categoría). El % del KPI se calcula sobre el total
de fallas distintas.

- `reporte_runtime_engine.js`: nuevo campo opcional del dataset,
  `DASH.hiddenCategories` (+ `isHiddenCategory`), que se respeta en el KPI de
  sistema y en `sistemas_bar`. Si el dataset no lo trae, el comportamiento es
  idéntico al anterior (Operaciones no lo usa).
- `mantenimiento.js`: `hiddenCategories: [SISTEMA_SIN_CLASIFICAR]` en el
  dataset; `construirNarrativa` ignora esa categoría; comentario junto a
  `SISTEMAS` actualizado (decía lo contrario).
- `reporte_plantilla.html`: el subtítulo del gráfico aclara que no incluye las
  fallas sin sistema identificado.
- Literales `MOTOR_JS_EMBEBIDO` (en `mantenimiento.js` y `operaciones.js`) y
  `PLANTILLA_HTML_EMBEBIDA` regenerados con
  `json.dumps(..., ensure_ascii=True)`. Verificados idénticos a su fuente.

## Verificación (corrida real en Chromium con la API real, Bogotá, última semana)

- KPI "Sistema principal": **Motor (14,8 %)**. Antes: "Otro / Sin clasificar
  (46,5 %)".
- Narrativa: "El sistema con más fallas es «Motor»: 21 fallas (14,8 %)."
- Fallas distintas 142 y móviles 24/31, sin cambios: el total no se altera.
- 10/10 gráficas renderizadas, 0 errores de API.
