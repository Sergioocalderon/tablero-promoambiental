# Estado de validación de reglas Geotab

Seguimiento de avance del skill `validar-regla`: qué reglas custom ya se revisaron,
qué se encontró, y cuáles siguen pendientes. Actualizado por el loop semanal de
validación (ver `.claude/skills/validar-regla/`) y a mano en sesiones puntuales.

## ⚠️ Pendientes con acción concreta (no perder de vista)

1. **R_INDICADOR DE AGUA EN EL COMBUSTIBLE** — alguien (no fuimos nosotros) modificó
   la condición el 2026-09-03 después de nuestro fix: ahora es
   `DurationShorterThan(5s) → And(agua>0, Ignition=1)` en vez del simple
   `IsValueMoreThan(0)` que dejamos. `DurationShorterThan` es sospechoso para este
   caso (el evento real que encontramos duró 2 días sostenidos — una condición de
   "duración MENOR a 5s" podría no capturar justo los casos sostenidos que
   importan). Sin resolver: falta confirmar con el usuario si fue intencional.
2. **R_NIVEL REFRIGERANTE MOTOR (TODO PROMO)** — muy ruidosa: 3199 eventos en 60
   días, sin `DurationLongerThan` (a diferencia de reglas similares). Un puñado de
   vehículos oscilan entre ~49% y ~98-99% repetidamente. No es necesariamente un
   bug (podría ser un problema real en esos vehículos puntuales), pero vale la pena
   agregar una duración mínima para reducir ruido antes de conectarla a una alerta.
3. **R_TEMPERATURA DE MOTOR MÁXIMA (X12)** — de los 5 vehículos en el alcance, solo
   1 (`1157-NWX533`) reportaba el diagnóstico de temperatura al momento de la
   prueba (2026-09-04); los otros 4 empezaron a reportar recién durante la prueba
   temporal. Vale la pena reconfirmar en unas semanas que los 5 siguen reportando.
4. ~~Alerta en revoluciones altas con PTO (L9) / ALERTA EN REVOLUCIONES ALTAS CON
   PTO (X12)~~ — **ELIMINADAS 2026-09-25** (pedido explícito del usuario, en vez de
   arreglar el bug). Respaldo completo de cada una antes de borrar en
   `backups_reglas/ELIMINACION_*_20260925_224554.json`, por si hace falta
   recuperarlas. Detalle del bug que tenían (para referencia futura, ya no aplica):
   la condición de PTO usaba `IsValueMoreThan(1)` sobre `DiagnosticPowerTakeoffEngagedId`
   (binario 0/1) — matemáticamente imposible de cumplir, 0 eventos en 90 días pese
   a tener vehículos en alcance (34 en L9, 5 en X12); el comentario describía un
   rango RPM 700-1100/750-1100 que no coincidía con la condición real (RPM>1500).

## Reglas ya validadas

| Regla | Última revisión | Resultado | ¿Conectada a Telegram? |
|---|---|---|---|
| R_INDICADOR DE AGUA EN EL COMBUSTIBLE (L9-OM 926-ISF 3.8-T800-NHR-N400) | 2026-09-03 | Bug corregido (umbral `IsValueMoreThan` de 1→0, diagnóstico binario). Ver pendiente #1 arriba. | No |
| R_CAÍDA DE TENSIÓN CARGA DEL ALTERNADOR (X12) | 2026-09-05 | Bug corregido: la condición apuntaba a un diagnóstico duplicado sin datos (`aNyAEOjdq60G5fimWQjX5XQ`); se cambió al diagnóstico con el mismo nombre que sí reporta (`aN0WrntRcn0-qsdgG7M7D5w`, 4872 muestras/30d, 48 por debajo de 27V). `1148-NWW623` sigue sin reportar ese diagnóstico — hueco de hardware en ese vehículo puntual, no de la regla. | No |
| R_TEMPERATURA DE MOTOR MÁXIMA (X12) | 2026-09-04 | Umbral 101°C/15s confirmado correcto con datos reales (motores nunca superan 94-96°C en operación normal). | **Sí** (2026-09-04) |
| R_SALIDA CARRO TALLER DE BASE | 2026-09-01 | Sin problemas. Alcance correcto (2 vehículos Bogotá + exclusión correcta del vehículo de Cali). | No |
| V_NIVEL TANQUE DE COMBUSTIBLE (L9-X12-OM 926-ISF 3.8-T800-T380-NHR) | 2026-09-01/02 | Sin problemas de lógica ni alcance. 2 fallas reales de sensor de DEF detectadas en 2 vehículos puntuales (hardware, no la regla). | No |
| SOBRE REVOLUCIÓN CON PTO (L9-X12-OM 926-ISF 3.8) | 2026-09-04/05 | Análisis profundo (solo Bogotá, confirmado con PTO ±3min): Usaquén concentra 38% de eventos, `1159-NWY131` triplica el promedio de su marca, International no tiene gobernador de RPM (Foton sí, tope 1900). Ver informe gerencial. | **Sí** (ya existía antes de esta sesión) |
| R_FILTRO DE PARTÍCULAS DIÉSEL 1 PORCENTAJE DE CARGA DE HOLLÍN (...) | 2026-09-04 (barrido) | Sin problemas — dispara con datos reales (210 eventos/60d, 16 vehículos). | No |
| R_GEOCERCA BOGOTÁ-SEGUIMIENTO | 2026-09-04 (barrido) | Sin problemas — 42 eventos/60d, 12 vehículos. | No |
| R_LÁMPARA DEL FILTRO DE PARTÍCULAS DIÉSEL ENCENDIDA | 2026-09-04 (barrido) | Sin problemas — condición binaria bien planteada (`>0` sobre lámpara 0/1). | No |
| R_NIVEL TANQUE DE COMBUSTIBLE (TODO PROMO) | 2026-09-04 (barrido) | Sin problemas — 434 eventos/60d, 44 vehículos, datos continuos y creíbles. | No |
| R_POSIBLE MANIPULACIÓN DEL DISPOSITIVO | 2026-09-04 (barrido) | Sin problemas — usa condición tipo `Fault` (FaultData), no `IsValueX` sobre StatusData; ya genera eventos reales. | No |
| R_REGENERACIÓN ACTIVA DEL FILTRO DE PARTÍCULAS DIÉSEL | 2026-09-22 (creada, en proceso de validación) | **Regla nueva, piloto.** Creada a raíz de la corrección de R_SATURACIÓN DPF, para identificar cuándo un vehículo está regenerando el DPF (útil para no confundir una caída real de % de hollín con ruido de sensor). Condición: `IsValueMoreThan(0)` sobre "Estado de regeneración activa del filtro de partículas diésel" (`a2MenjAEB90iHUfy6X1oc2A`) — se eligió sobre el diagnóstico genérico "Activado/Desactivado" porque reporta en 48/64 vehículos del alcance (vs. 4/64 del genérico). Valores reales observados: 0, 1, 2 — se usa `>0` para cubrir ambos hasta confirmar qué distingue el valor 2. Mismo alcance (14 grupos, 64 vehículos) que las 5 reglas de SATURACIÓN DPF. `id=a7MLK6kE5GkCaAFiNtAB4zw`. El usuario mencionó que este mismo enfoque (diagnóstico dedicado) ya se había probado hace unos meses y no fue eficaz — ver [[proyecto-deteccion-regeneracion-dpf]] en memoria. Se armó una alternativa complementaria: `herramientas/detectar_regeneracion_dpf.py`, que detecta regeneración por caída sostenida del % de hollín (heurística, sin depender de este diagnóstico) — 549 episodios detectados en 36/64 vehículos en 30 días. Se intentó cruzar ambas señales (`--cruzar-regla`) pero el primer intento (2026-09-22) fue inválido: la regla llevaba solo 43 minutos activa contra 30 días de heurística, no es una comparación justa. Sí se confirmó con datos crudos que el diagnóstico dedicado reporta un patrón real sostenido (2.5+ h seguidas en valor 1-2, muestreo ~30min — no es ruido). **Cruce válido 2026-09-23 (ventana 24 h, regla ya con ~27 h de historia)**: 18/24 (75%) de los episodios por caída de hollín coinciden con un evento de la regla; en sentido inverso, 10/27 sesiones de la regla (37%) tienen una caída de hollín ≥10 pp en 30 min asociada. Las otras 17 se explican así: 8 empiezan con hollín ≤15% (la heurística no puede ver caídas <10 pp), 5 tienen caída lenta/moderada, y 4 son sesiones "pegadas" de >1 día (1.2 a 6.4 días, ej. 3094-GVT509 con hollín constante en 178%) — el diagnóstico se queda en >0 y el ExceptionEvent no cierra, no es una regeneración real de días. **Falta**: (1) acotar la duración máxima de una sesión válida (o exigir que el hollín baje) para descartar las pegadas; (2) revisar los 6 episodios de hollín sin evento de la regla (ej. 1148-NWW623) por cobertura del diagnóstico; (3) repetir con 3-7 días de historia. | No |
| R_SATURACIÓN DPF 110% / 120% / 130% / 144% (NIVEL 2) / 155% A26 (NIVEL 2) | 2026-09-22 (validación profunda, corrige el barrido superficial del 2026-09-04) | **2 bugs corregidos.** (1) 144%/155% A26 usaban como compuerta el "Interruptor de fuerza de regeneración genérico" (`aXfHYX0HFtUaOOr_scNuSsg==0`) en vez de la Lámpara DPF que sí usan 110/120/130% — ese interruptor está en 0 el 99.8% del tiempo (13,094/13,123 muestras, 64 vehículos/60d), así que no filtraba nada; explicaba que 144% tuviera MÁS eventos (353) que 130% (161), rompiendo el patrón "más severo = menos frecuente". Se cambió a la misma Lámpara DPF (4.1% en 1, filtro real) en las 2 reglas de NIVEL 2. (2) Ninguna de las 5 tenía `DurationLongerThan` — mismo diagnóstico de % de hollín (`aYtF4cSGobUSRCKo8yfjyIg`) que ya mostró picos físicamente imposibles en R_DPF CARGA DE HOLLÍN-ROJA. Confirmado con datos: muestra de 5 eventos reales de la regla 144% mostró saltos de 70-98%→176-200% en <1s, tocando siempre el techo de 200% (imposible físicamente, saturación real no cambia en segundos); 49% de los 353 eventos duraban <15s. Se agregó `DurationLongerThan(15s)` a las 5 reglas (mismo valor que ROJA). Backups en `backups_reglas/SATURACION_DPF_*_20260922_001919.json`. | No |
| SOBRE REVOLUCIÓN (L9) | 2026-09-17 | Lógica correcta (`RPM>2100` sostenido 1s, ignición encendida, sin PTO/velocidad). Volumen extremo: ~50,000 eventos/90d, concentrado en 7 vehículos (2 dominan: `1154-NWX543` 16,714 y `1160-NWY132` 12,578 eventos). Coincide con el hallazgo ya documentado de International sin gobernador de RPM — probablemente esté contando aceleraciones normales, no mal uso real. No conectar a alerta sin antes ajustar el umbral/duración. | No |
| SOBRE REVOLUCIÓN (X12) | 2026-09-17 | Sin problemas — 876 eventos/90d (5 vehículos Foton), volumen creíble (Foton sí topa en 1900 RPM por gobernador, por eso mucho menos ruidosa que la de L9). | No |
| ~~Alerta en revoluciones altas con PTO (L9)~~ | 2026-09-25 | **ELIMINADA** (pedido explícito del usuario). Tenía bug confirmado: `PTO IsValueMoreThan(1)` imposible sobre diagnóstico binario, 0 eventos en 90 días. Respaldo en `backups_reglas/`. | No (borrada) |
| ~~ALERTA EN REVOLUCIONES ALTAS CON PTO (X12)~~ | 2026-09-25 | **ELIMINADA** (pedido explícito del usuario). Mismo bug exacto que la versión L9. Respaldo en `backups_reglas/`. | No (borrada) |
| PTO en uso mientras detenido - medicion por RPM (fast-idle) | 2026-09-17 | **No aplica por el momento** (deprioritizada por el usuario, no se completó la validación). Es una regla piloto/experimental: mide PTO por proxy de RPM alto (>900) sostenido 30s con velocidad~0, en vez de depender del bit `DiagnosticPowerTakeoffEngagedId` (pulsos muy cortos) — mismo patrón que "SOBRE REVOLUCIÓN CON PTO". Su propio comentario admite que el umbral de 900 RPM se calibró con **un solo punto de dato real** (vehículo 1154) y pide ajustarlo antes de confiar en producción. Alcance: 9 vehículos (grupo INTERNATIONAL HV607, `b2C8D`). Volumen muy alto: 22,602 eventos/30d. Único dato ya verificado: de una muestra de 5,072 eventos en 7 días, el 84.3% coincide con un pulso real de PTO cercano (±3min) — sugiere que el umbral no está mal calibrado, pero falta terminar el análisis de distribución RPM (confirmado vs. no confirmado) para decidir si ajustarlo. | No |
| V_DPF CARGA DE HOLLÍN — AMARILLA | 2026-09-24 (re-validada con datos reales; nombre real lleva prefijo `V_`, no `R_` como estaba anotado acá) | Lógica correcta y sin cambios desde el 2026-09-17 (`avHtWMDSMaEqIditAu04nZQ`): `DurationLongerThan(600s)[70≤holl<85]` OR `[lámpara DPF==1 AND holl<85]` (esta segunda rama sin duración, a propósito — la lámpara es una señal discreta, no ruidosa). 146 eventos/60d, 18 vehículos — duración mínima real 10s (viene de la rama de lámpara, sin guardia; la rama de duración nunca dispara por debajo de 600s, como debe ser). | No |
| V_DPF CARGA DE HOLLÍN — NARANJA | 2026-09-24 (re-validada) | Lógica correcta y sin cambios desde el 2026-09-17 (`a-FZDYpv2b0usEZj-88OuIA`): `DurationLongerThan(300s)[85≤holl<95]`. 62 eventos/60d, 10 vehículos, duración mínima real 341s (bien por encima del piso de 300s) — sin señales de ruido colándose. | No |
| V_DPF CARGA DE HOLLÍN — ROJA | 2026-09-24 (re-validada) | Lógica correcta y sin cambios desde el 2026-09-17 (`aDiiqe5CJkUS7OewiFYbK_w`): `DurationLongerThan(15s)[holl≥95]`. 39 eventos/60d, 10 vehículos, duración mínima real 25s (por encima del piso de 15s, ningún evento pegado al umbral). Progresión de eventos entre las 3 reglas es creíble (146→62→39, coherente con pasar menos tiempo en niveles más severos). **Hallazgo nuevo:** 22 de los 80 vehículos del alcance (27.5%) no tienen NINGUNA muestra del diagnóstico de hollín en 60 días — hueco de cobertura de hardware, no bug de la regla (confirmado con el mismo patrón de ceiling de ruido ~150-200% ya documentado en R_SATURACIÓN DPF, presente en al menos 1 vehículo de una muestra de 15, pero sin evidencia de que esté colando falsos positivos dado que las duraciones reales quedan bien por encima de los umbrales). ROJA sigue siendo la más expuesta a un pico de ruido corto por tener el piso de duración más bajo de las tres (15s) — vale la pena subirlo un poco si se conecta a una alerta en tiempo real. | No |
| ~~Regeneración Manual Inactiva y Lámpara DPF Encendida~~ (sin sufijo) | 2026-09-28 | **ELIMINADA** — duplicado exacto de "... - C" (mismo alcance de 80 vehículos, misma condición, mismos 540 eventos/60d). Antes de borrar se copió su comentario ("Regeneración Realizada Manualmente Por operador") a la que se conservó. Respaldo de ambas en `backups_reglas/DUPLICADO_REGEN_MANUAL_INACTIVA_*_20260928_235333.json`. | No (borrada) |
| Regeneración Manual Inactiva y Lámpara DPF Encendida - C | 2026-09-28 | Conservada (id `aQ06wSzKCu0iGNW-dBoI9kQ`) — condición `interruptor manual=0 AND lámpara=1`, alcance 80 vehículos (nacional, más amplio que los 64/68 de las demás reglas DPF — no se tocó ese alcance, solo se resolvió el duplicado). Ahora tiene el comentario que le faltaba, copiado de la regla eliminada. | No |
| V_(L9 y  VOLSKWAGEN) RALENTÍ (antes `V_(L9) RALENTÍ`) | 2026-10-03 | **Renombrada en Geotab por terceros** (doble espacio en el nombre; mismo id `aCS-g7695wkmdmAGramgf2w`, historial desde 2026-07-05). Ahora también incluye el grupo VOLSKWAGEN - DELIVERY 9.170 (40 vehículos en alcance). El renombre hizo que el add-in Operaciones la perdiera en silencio (buscaba por nombre) — corregido en Operaciones 1.2 (búsqueda por ID). Lógica correcta: `DurationLongerThan(300s)[vel. rueda<1.01 AND 675<RPM alta-res<825 AND encendido]`. 1.660 eventos/7d en 35 vehículos. | No |
| V_(T380) RALENTÍ · V_(X12 y T800) RALENTÍ · V_RALENTÍ N400 800 RPM · V_RALENTÍ FURGÓN NHR 650 RPM · V_RALENTÍ MERCEDES | 2026-10-03 | Sin problemas. Las 5 tienen el mismo patrón que la de L9 (≥5 min, vel. rueda<1.01, banda de RPM de ralentí propia de cada motor, encendido). Grupos de modelo disjuntos: ningún vehículo cae en 2 reglas. Muestra de 12 eventos cruzada con LogRecord (vel. GPS 0-3 km/h, ruido normal) y PTO (0 pulsos dentro del evento) → ralentí real, no compactación. Volumen 7d: T380 469, X12/T800 259, N400 36, NHR 100, Mercedes 157. Usadas por el add-in Operaciones. | No |
| V_VELOCIDAD MAYOR A 50 KM/H | 2026-10-03 | Sin problemas. `DurationLongerThan(30s)[vel. rueda>50]`, alcance 80 vehículos. 9.351 eventos/7d en 72 vehículos (volumen alto pero coherente con el umbral bajo). Muestra de 10 eventos con vel. GPS máx 57-103 km/h. Usada por el add-in Operaciones. | No |

**Nota sobre las 3 reglas DPF de arriba:** a pedido explícito del usuario, el 2026-09-17
se **borraron y recrearon desde cero** en Geotab (no solo se editaron) para
"volver a empezar el seguimiento" — la lógica y los grupos quedaron
verificados idénticos a como estaban justo antes de borrar, pero los IDs
cambiaron y el historial de `ExceptionEvent` bajo los IDs viejos
(`aTOt1Vsx7U0u9rkMeoe3_cg` / `a9E38J3R4u0WzFUu3UpiA9A` / `axjZI-F48zkaWo-FgT_2_MA`)
ya no es consultable por esa vía. Respaldo del estado justo antes de borrar
en `backups_reglas/recrear_*_20260917_1553*.json`.

## Reglas custom "R_" que faltan revisar

_(el loop semanal completa esta lista a medida que las va tomando — si aparece una
regla "R_" o "V_" nueva en Geotab que no esté en ninguna de las dos tablas de este
archivo, agregarla acá antes de validarla)._

- (ninguna conocida por ahora — todas las reglas "R_"/"V_" que se identificaron
  hasta el 2026-09-05 ya tienen fila en la tabla de arriba. El loop semanal debe
  revisar si aparecieron reglas nuevas en Geotab antes de asumir que esta lista
  sigue vacía).
