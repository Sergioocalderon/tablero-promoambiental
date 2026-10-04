# Creación del add-in — Análisis de Sobre-Revolución con PTO

**Fecha:** 2026-09-17
**Archivos:** `_build_dashboard_pto/dashboardAnalisisPTO.js`, `.html`, `config.json`

## Contexto

Se pidió actuar como "desarrollador Frontend sénior experto en MyGeotab" para
estructurar un add-in analítico sobre la regla "SOBRE REVOLUCIÓN CON PTO
(L9-X12-OM 926-ISF 3.8)". Se aclaró explícitamente que es un add-in **nuevo y
separado** de `sobreRevolucionPTO.js` (el operativo/tiempo real ya existente),
no un reemplazo — mismo patrón que ya separa "Alertas por Severidad" de
"Dashboard de Análisis de Fallas" en este ecosistema.

## Qué hace

Tablero histórico/analítico: KPIs con tendencia vs. periodo anterior, resumen
narrativo gerencial, gráfico de tendencia temporal, Top 5 vehículos por
criticidad, tabla de detalle por vehículo, filtros de ciudad y criticidad.

## Reutilización de lógica ya validada

Todo el pipeline de datos (`obtenerEventosCandidatos`, `confirmarPtoCercano`,
`agregarPicoRpm`, `resolverVehiculos`, `filtrarPorUmbralMercedes`) es el mismo
ya probado en `sobreRevolucionPTO.js` y en `telegram_alertas.py`: cruce de PTO
por cercanía ±3 min (el bit Engaged es un pulso, no se sostiene), pico real de
RPM ±30s, y el umbral propio de 1500 RPM para Mercedes (motor OM926) aplicado
en código después de que la regla ya disparó el candidato a 1300.

Aplicado desde el inicio (no como fix posterior, ya que se conocía el riesgo):
candado `cargaEnCurso` contra solicitudes superpuestas — el mismo bug que
causó errores "ServerStopped" en el addin operativo.

## Criticidad — calibración pendiente de refinar

Umbrales (Bajo <50, Medio 50-199, Alto 200-599, Crítico ≥600 eventos/rango)
calibrados 2026-09-17 contra la distribución real de **candidatos crudos**
(antes de confirmar PTO) de 50 vehículos en 30 días: p25=21, mediana=113,
p75=573, p90=1032, máx=1927. **Limitación conocida:** no se calibró contra el
conteo YA CONFIRMADO (después del cruce con PTO real) porque correr esa
confirmación para los 50 vehículos completos era demasiado lento para hacerlo
en el momento. Recalibrar contra datos confirmados una vez que este dashboard
acumule uso real — mismo tipo de advertencia que ya se documentó en la regla
piloto "PTO en uso mientras detenido (fast-idle)".

## Pendiente de verificar manualmente

No hay test suite. Verificar en Geotab:
1. Que el resumen narrativo, los KPIs y la tabla muestren números consistentes
   entre sí (misma fuente de datos, sin filtros activos).
2. Que el filtro de ciudad y de criticidad recalculen todo (KPIs, gráficos,
   tabla) de forma consistente.
3. Revisar si los umbrales de criticidad calibrados con candidatos crudos
   producen una distribución razonable con datos reales confirmados, o si
   hace falta ajustarlos.
