# 2026-11-19 · v1.2 · Recuperación medida con el voltaje del GO a 5 minutos

**Problema:** "No recupera voltaje tras arrancar" usaba la curva de "Voltaje de arranque" (~10 s). Esa curva termina
antes de que el alternador cargue, y desde la instalación del lector NFC (16/09) el 1167 y el 1164 salían "no recupera"
en 91 % y 69 % de los arranques: falsa alarma (tras arrancar el GO sí llega a ~28 V en 1-2 min).

**Cambio:** la recuperación es el MÁXIMO del voltaje del GO (`DiagnosticGoDeviceVoltageId`) en los 5 min siguientes
a cada arranque. No recupera = no llega a 13,0 V (26,0 V en 24 V). Revisar si pasa en >= 50 % de los arranques
con lectura del GO (mínimo 10). Arranques sin lectura del GO en la ventana no cuentan (no se afirma nada).
Se cargan 7 días extra de voltaje del GO (~3.400 filas/día en la flota).

**Medido (19/11, 7 días, 82 vehículos):** mediana del máximo a 5 min = 13,9 V (escala 12 V). Con el criterio nuevo
1167 = 6 %, 1164 = 0 %, ningún vehículo >= 50 % (con el viejo: 1167 y 1164 en Revisar). Se eligió 13,0 V y no
13,5 V (27 V) porque el 1928-QQU074 tiene mediana 13,2 V y con 13,5 saldría marcado sin evidencia de falla.
