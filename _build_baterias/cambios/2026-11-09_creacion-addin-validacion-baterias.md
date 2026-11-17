# Validación de Baterías v1.0 — creación

**Fecha:** 2026-11-09
**Archivos:** `_build_baterias/` (`logica.js`, `datos.js`, `validacionBaterias.parte.js`, `config.json`), `_build_regeneracion_comun/ui.js` (kit de diseño compartido), `herramientas/construir_addin_baterias.py` (ensamblador), `ValidacionBaterias_addin.zip`
**Origen:** un script Python recibido para diagnosticar baterías de la flota. Se revisó contra datos reales antes de portarlo; el add-in NO es un puerto literal (ver "Qué se cambió del código recibido").

## Qué hace
Tabla de los vehículos de `*Promoambiental` con estado **Alerta / Revisar / Vigilar / Normal / Sin datos**, la fuente de cada dato (ESR de Geotab o señales de arranque), su antigüedad y el motivo. Filtros por ciudad, sistema (12/24 V), estado y vehículo; las tarjetas de arriba filtran al hacer clic. Al hacer clic en un vehículo se abre su gráfico (ESR diario y voltaje mínimo al arrancar). Exporta CSV y un mensaje de WhatsApp por ciudad. Se actualiza cada 30 min.

Datos: ESR (`DiagnosticElectricalSystemRatingId`, 30 días, ~1.600 filas) y voltaje de arranque (`DiagnosticCrankingVoltageId`, 14 días en tramos de 2 días, ~70.000 filas, con partición automática si un tramo toca el tope de 50.000).

## Criterios (medidos con 30 días de la flota el 2026-11-09: 85 vehículos, 59 con ESR, 12.465 arranques)
| Regla | Umbral | Origen |
|---|---|---|
| ESR → Alerta | < 15 | código recibido (Malo < 5, Precaución 5-14) |
| ESR → Revisar | 15-29, o caída ≥ 15 pts bajo su mediana | 43 días con ESR < 30 fueron de 3 vehículos con fallas reales |
| Sin ESR, 12 V → Revisar / Vigilar | mínimo (mediana 7 d) < 6,5 V / < 7,3 V | ESR < 30: mediana 6,4 V; ESR ≥ 50: rango 7,3-9,0 V; correlación ESR~mínimo 0,78 |
| Tendencia → Vigilar / Revisar | el mínimo cae ≥ 0,3 V / ≥ 0,5 V vs la semana anterior | peor cambio semanal visto: 0,2 V |
| No recupera voltaje → Revisar | carga − reposo < −0,5 V en ≥ 50 % de los arranques (mín. 10) | 1167 y 1164 (24 V): 94 % y 80 % de los arranques, todos los días; sus 20 pares de 24 V: 0 % |
| Datos viejos | último dato > 72 h y nada que señalar → "Sin datos" | lección del caso 1226 (un "activo" sin dato reciente) |

## Qué se cambió del código recibido (y por qué)
- **Se eliminó el "ESR manual" por regresión.** Validado en la flota: error de ±5 pts dejando un vehículo fuera (vs ±8 prediciendo el promedio), pero **con ESR real < 30 predice en promedio 28,8 en vez de 17 y con su umbral de 15 detecta 0 de 43 casos**. Con 24 V es peor: ningún vehículo de 24 V tiene ESR para calibrar y el "ESR" salía de un z-score contra sus pares. En su lugar se muestran indicadores físicos con umbrales medidos.
- **Vehículos de 24 V:** sin ESR de referencia ni umbral absoluto; se marcan "Normal*" cuando no hay novedad y la nota lo explica.
- **Antigüedad del dato** visible en cada fila (el código recibido evaluaba "el último valor" sin decir de cuándo era).
- Alcance por el grupo `*Promoambiental` (la base de Geotab se comparte con otras cuentas) y solo vehículos activos.
- Sin credenciales: el add-in usa la sesión de quien lo abre.

## Probado
- **Lógica contra Python:** los 70.416 puntos de arranque reales de 14 días, 85 vehículos, 960 comparaciones (n.º de arranques, mediana de mínimo/caída/reposo/recuperación, fracción sin recuperar, ESR actual y base): **0 discrepancias**.
- **Pantalla (Chrome headless, API simulada con datos reales):** 85 filas, 0 errores de consola, filtros, detalle con gráfico, CSV (86 líneas) y mensaje por ciudad.
- Resultado sobre la flota del 09-nov: 1 Alerta (3099-GVT587, ESR 3, baja a 5,6 V), 4 Revisar (1222-FXW243 ESR 27; TUCAN63-SSX686 mínimo −0,5 V vs la semana previa; 1167-NWY955 y 1164-NWY952 sin recuperar voltaje), 1 Vigilar (SSI226), 5 Sin datos, 21 vehículos de 24 V sin ESR.
- **No probado dentro de MyGeotab.**

## Límites
- El cálculo por señales (vehículos sin ESR) se calibró con casi ningún ejemplo de batería mala (3 vehículos): sirve para priorizar la revisión, no para decidir un cambio de batería.
- "No recupera voltaje" en el 1167/1164 es una desviación sistemática frente a sus pares, pero la causa (alternador, cableado, o cómo el equipo registra la curva) no está confirmada; verificar en taller. El 1164 mostró +1,6 V el 9-nov con 3 arranques.
- Requiere acceso a internet para Chart.js (cdnjs); sin él se ve la tabla y se avisa en el detalle.
- `enableViewSecurityId: true`: solo lo ven los perfiles marcados en Geotab (igual que los add-ins de regeneración).

## Cómo se regenera
`python herramientas/construir_addin_baterias.py` (los `.js`/`.html` de `_build_baterias/` son archivos generados).
