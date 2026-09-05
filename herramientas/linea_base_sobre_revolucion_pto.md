# Línea base — SOBRE REVOLUCIÓN CON PTO (antes de capacitaciones)

Captura de referencia tomada **antes** de que arranque cualquier programa de
capacitación a operadores orientado a reducir la sobre-revolución con PTO. Cuando
el programa tenga fecha y forma concreta, comparar contra estos números para medir
si mejoró o empeoró — no recalcular esta semana desde cero, usar esto como ancla.

- **Semana analizada:** 29 ago – 04 sep 2026 (hora Bogotá)
- **Alcance:** Bogotá, compactadores dobles
- **Método:** eventos de la regla `SOBRE REVOLUCIÓN CON PTO (L9-X12-OM 926-ISF 3.8)`
  confirmados contra un pulso real de PTO (±3 min) — no el conteo crudo de Geotab.
- **Capacitaciones:** todavía no iniciadas al momento de esta captura (2026-09-05).

## Totales

- **785 eventos confirmados** en la semana.
- **38% del total (298 eventos) concentrados en Usaquén** — más del doble que
  Chapinero, la segunda localidad.
- **12 vehículos distintos** con actividad en Usaquén.

## Por localidad

| Localidad | Eventos | % del total |
|---|---|---|
| Usaquén | 298 | 38% |
| Chapinero | 169 | 22% |
| San Cristóbal | 117 | 15% |
| Usme | 84 | 11% |
| Parque Innovación Doña Juana | 63 | 8% |
| Santa Fe | 43 | 5% |
| Puente Aranda | 10 | 1% |
| Rafael Uribe Uribe | 1 | <1% |

## Top vehículos (ranking completo)

| Vehículo | Eventos |
|---|---|
| 1159-NWY131 | 155 |
| 1161-NWY133 | 138 |
| 1307-LSX407 | 105 |
| 1149-NWX185 | 93 |
| 1156-NWX542 | 75 |
| 1153-NWX416 | 46 |
| 1150-NWX186 | 37 |
| 1157-NWX533 | 34 |
| 1154-NWX543 | 31 |
| 1148-NWW623 | 22 |
| 1152-NWX541 | 18 |
| 1160-NWY132 | 14 |
| 1151-NWX183 | 12 |
| 1158-SSX744 | 4 |
| 1155-NWX483 | 1 |

`1159-NWY131` es el caso más marcado: 77% de sus eventos (120) caen en Usaquén, y
triplica el promedio de eventos/vehículo de su propia marca (International).

## Por marca

| Marca | Eventos | Vehículos | Eventos/vehículo | Duración promedio |
|---|---|---|---|---|
| International · Hv607 | 482 | 9 | 53.6 | 2.5 min |
| Foton · Auman | 198 | 5 | 39.6 | 1.1 min |
| Volkswagen · Delivery 9.170 | 105 | 1 | 105.0 | 2.3 min (*muestra de 1 solo vehículo*) |

**Nota mecánica (no cambia con capacitación):** International no tiene gobernador
de RPM por crucero ni pedal; Foton sí (tope 1900 RPM). Si al re-medir después de
las capacitaciones la brecha de duración International-vs-Foton se mantiene igual
de ancha, es esperable — esa parte depende del vehículo, no del operador. Lo que sí
debería moverse con la capacitación es el **volumen de eventos** y qué tan
concentrado queda en unos pocos vehículos/operadores (ej. `1159-NWY131`).

## Cómo comparar más adelante

Cuando el programa de capacitaciones tenga fecha de inicio, correr el mismo
análisis (ver conversación / skill `validar-regla` como referencia de metodología:
`_obtener_eventos_regla` con `requiere_pto_cercano=True`, filtrado a Bogotá) para
la semana equivalente y comparar cada tabla de arriba línea por línea. Recién ahí
tiene sentido construir un skill dedicado a esta comparación — con esta única
captura no alcanza para ver tendencia.
