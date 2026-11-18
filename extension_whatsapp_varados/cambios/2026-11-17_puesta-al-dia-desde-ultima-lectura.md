# 2026-11-17 · v1.1.0 · Puesta al día desde la última lectura

**Problema:** al entrar al turno (p. ej. 10 p. m. tras días libres) la extensión solo subía hasta lo último
que ella misma había leído con un tope de 25 tandas y 24 h. Los reportes de los turnos de los compañeros
(que registran con el botón `procesarYRegistrar`) podían quedar sin revisar, y si a alguien se le pasó uno,
nadie lo notaba.

**Cambio (solo `content.js`, el receptor no cambia):**
- Se guarda `ultimaLectura` (última pasada normal con el grupo abierto).
- Al abrir el grupo, sube por el chat hasta `ultimaLectura − 1 h` (mínimo 24 h, máximo 4 días) usando la
  fecha de cada mensaje de WhatsApp (`data-pre-plain-text`, formato 12/24 h) o la "Fecha y Hora" del reporte.
- Revisa todos los reportes de ese tramo; el receptor ya descarta los que estaban en la hoja, así que solo
  se registran los que faltaban.
- `ultimaLectura` no avanza durante la puesta al día: si se corta a mitad, la próxima vez vuelve a subir.
- El contenedor de desplazamiento se detecta aunque haya pocos mensajes en pantalla.
- El aviso muestra "poniéndose al día / revisado desde dd/mm hh:mm".

**Prueba:** página simulada (llegada tras 60 h): registra 1209, 1170, 1501, 1502, 1601 y no sube de más
(1701/1702/1801/1901 quedan fuera). Prueba anterior sin regresiones salvo la puesta al día, cuyos mensajes
simulados traen una fecha fija vieja.

**Primera vez con esta versión:** aún no existe `ultimaLectura`, así que esa vez revisa 24 h.
