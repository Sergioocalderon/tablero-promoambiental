# 2026-11-17 · v1.1.1 · Formato nuevo de identificador de mensajes de WhatsApp

**Problema (visto en el PC del usuario):** WhatsApp Web cambió el `data-id` de los mensajes a un formato sin
prefijo (`3A97285A1786...` en vez de `false_...@g.us_...`). La extensión no reconocía ninguno (0 de 27) y caía
al respaldo `data-pre-plain-text`, que solo existe en mensajes de texto (3 de 27). Al subir por el chat solo
cargaban imágenes (los SEGUIMIENTO), el conteo no crecía y la puesta al día se detenía creyendo que había
llegado al principio: "mensajes 4 · reportes 0".

**Cambio (`content.js`):**
- Si ningún `data-id` trae el prefijo viejo, se toman todos los `#main [data-id]` que no estén dentro de otro
  (los mensajes citados), incluidas imágenes.
- La puesta al día se detiene tras 3 tandas seguidas sin mensajes nuevos (antes 1).
- La fecha más antigua visible se busca en los primeros 60 mensajes (las imágenes no tienen fecha).

**Prueba:** página simulada con `data-id` del formato nuevo y una tanda de solo imágenes: registra
1209, 1170, 1501, 1502, 1601 y se detiene en el punto correcto. Pruebas anteriores sin cambios.
