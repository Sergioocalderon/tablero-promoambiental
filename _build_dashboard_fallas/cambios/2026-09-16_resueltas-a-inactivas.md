# "Resueltas" → "Inactivas" en el panel Activas vs. inactivas

**Fecha:** 2026-09-16
**Archivo:** `_build_dashboard_fallas/dashboardAnalisisFallas.js`

## Cambio

Se cambió la etiqueta visible "Resueltas" por "Inactivas" en los lugares que
usan `estadoActivas.inactivas` (definido en `contarActivasInactivas`, cuenta
grupos cuyo último registro NO es `faultState='Active'`):

- Título del porcentaje en la barra de progreso (`construirBarraResueltas`).
- Conteo debajo de la barra ("Inactivas: N").
- Encabezado del panel ("🟢 Activas vs. inactivas").
- Tarjeta KPI de la fila superior ("Inactivas", antes "Resueltas / inactivas").

Solo se tocó el texto visible — la variable/campo interno sigue llamándose
`inactivas` (ya era el nombre correcto), y los nombres de función/variable
internos (`construirBarraResueltas`, `panelResueltas`, etc.) no se
renombraron, para no arriesgar romper una referencia por un cambio cosmético.

## Pendiente de verificar manualmente

Confirmar visualmente en Geotab que las 4 ubicaciones dicen "Inactivas" y no
quedó ninguna mención de "Resueltas".
