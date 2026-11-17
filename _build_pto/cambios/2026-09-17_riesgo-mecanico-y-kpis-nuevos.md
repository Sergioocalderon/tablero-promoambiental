# Panel de riesgo mecánico + 2 KPIs nuevos

**Fecha:** 2026-09-17
**Archivo:** `_build_pto/sobreRevolucionPTO.js`

## Pedido

Se pidió actuar como "desarrollador Frontend sénior experto en MyGeotab" para
estructurar un nuevo add-in dedicado a analizar la regla "Sobre revolución con
PTO". Al revisar el pedido punto por punto contra el archivo ya existente en
este proyecto, se confirmó que **el add-in ya existía y cubría casi todo lo
pedido** (extracción vía `ExceptionEvent`, cruce de conductor por Excel de
tripulaciones — más robusto que el campo nativo `driver` de Geotab, KPIs, Top
5 con Chart.js, gráfico de tendencia, patrón `initialize`/`focus`/`blur`). Se
identificaron solo 2 gaps reales, que son los que cubre este cambio.

## Cambio 1: panel de riesgo mecánico (gap que no existía en absoluto)

Nuevo bloque colapsable en el encabezado, debajo del subtítulo: un enlace
"⚠️ ¿Por qué importa esto?" que expande un panel explicando el riesgo real
(desgaste de la bomba hidráulica por sostener RPM alto con el compactador
acoplado, costo de una falla imprevista). Recuerda el estado
expandido/colapsado por viewer vía `localStorage`
(`sobreRevolucionPTO_riesgoExpandido`) — mismo patrón que ya usa el resto del
addin para el rango de fechas y las tripulaciones, para que un supervisor que
ya lo sabe de memoria no lo vea expandido cada vez que abre la página.

## Cambio 2: 2 tarjetas KPI nuevas

La fila de KPIs pasó de 3 a 5 tarjetas:
- ⏱️ **Tiempo total en sobre-revolución** — suma de `duracionSeg` de todos los
  eventos visibles, formateada como "Xh Ymin" (nueva función
  `formatearDuracionTotal`, distinta de `formatearDuracion` que ya existía
  para un solo evento — sumar cientos de eventos en minutos sueltos se vuelve
  ilegible).
- 🔁 **Vehículo más reincidente** — el `top5[0]` ya calculado para el gráfico
  de barras, ahora también destacado como KPI en vez de solo verse dentro del
  gráfico. Se adelantó el cálculo de `conteoPorVehiculo`/`top5` (antes vivía
  después de la fila de KPIs) para que ambos usos (KPI y gráfico) partan del
  mismo cálculo — nunca dos fuentes de verdad separadas que puedan
  desalinearse.

## Pendiente de verificar manualmente

No hay test suite. Verificar en Geotab:
1. El panel de riesgo se expande/colapsa correctamente y recuerda el estado
   al recargar la página.
2. Las 2 tarjetas KPI nuevas muestran valores coherentes con la tabla de
   detalle (la suma de duraciones y el vehículo top del gráfico de barras).
3. Con un vehículo de nombre largo en "Vehículo más reincidente", confirmar
   que la tarjeta no rompe el layout de la fila (no se probó visualmente).
