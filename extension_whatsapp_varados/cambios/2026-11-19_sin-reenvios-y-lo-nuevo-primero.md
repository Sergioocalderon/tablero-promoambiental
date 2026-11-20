# 2026-11-19 · v1.2.1 · Sin reenvíos repetidos y lo más nuevo primero

**Problema:** en la puesta al día de las 22:15 del 19/11 la extensión reenvió 25 mensajes que ya estaban en la hoja,
uno por uno (~8 s cada uno, casi todo arranque de Apps Script), del más viejo al más nuevo. Los únicos que faltaban
(1405 de las 19:13 y 1151 de las 21:47) quedaron al final y entraron ~190 s después.
Eran solo 8 reportes distintos: las respuestas del grupo que citan el reporte ("en camino") traen el texto completo y
se tomaban como otro reporte (el 1109 de las 08:21 se envió 5 veces).

**Cambio (solo background.js):**
- Clave del reporte = unidad + "Fecha y Hora". Si esa clave ya está en la cola o el receptor ya la contestó
  (registrado, duplicado, ignorado o a revisar) en los últimos 4 días, la copia no se envía.
  Sin "Fecha y Hora" propia no hay clave y se envía como antes.
- La cola se envía de lo más nuevo a lo más viejo.

**Prueba:** simulación del barrido de hoy (4 copias del 1120, 5 del 1109, 1405 y 1151): 4 envíos en vez de 11,
y 1151/1405 salen justo después del primero que ya estaba en vuelo.
