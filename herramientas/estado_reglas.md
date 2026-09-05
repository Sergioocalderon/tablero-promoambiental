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
| R_SATURACIÓN DPF 110% / 120% / 130% / 144% (NIVEL 2) / 155% A26 (NIVEL 2) | 2026-09-04 (barrido) | Sin problemas — las 5 reglas escalonadas disparan con datos reales y volumen creciente según severidad (patrón esperado). | No |

## Reglas custom "R_" que faltan revisar

_(el loop semanal completa esta lista a medida que las va tomando — si aparece una
regla "R_" o "V_" nueva en Geotab que no esté en ninguna de las dos tablas de este
archivo, agregarla acá antes de validarla)._

- (ninguna conocida por ahora — todas las reglas "R_"/"V_" que se identificaron
  hasta el 2026-09-05 ya tienen fila en la tabla de arriba. El loop semanal debe
  revisar si aparecieron reglas nuevas en Geotab antes de asumir que esta lista
  sigue vacía).
