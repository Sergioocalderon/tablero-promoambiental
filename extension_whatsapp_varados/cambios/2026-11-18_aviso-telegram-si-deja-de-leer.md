# 2026-11-18 · v1.2.0 · Aviso por Telegram si la extensión deja de leer

**Problema:** WhatsApp cambió su página el 17/11 y la extensión siguió "funcionando" sin leer nada; solo se
notó porque el usuario miró el aviso en pantalla. Si nadie lo mira, los reportes se acumulan sin registrarse.

**Cambio:**
- `content.js` manda un latido al proceso de fondo (sano o con motivo: otro chat, sin mensajes, recargar),
  como máximo uno por minuto o cuando cambia el estado.
- `background.js`, en la alarma de cada minuto: en modo REAL y con token/chat de Telegram configurados, si
  pasan 15 min sin un latido sano envía UN aviso con el motivo; al volver a leer avisa la recuperación. Estado en
  `chrome.storage.local.vigia` (el proceso de fondo se reinicia). Solo se marca avisado si Telegram respondió ok.
- Opciones: campos "Token del bot" y "Chat ID" (se guardan solo en este navegador) y botón "Probar aviso Telegram".
- Permiso nuevo: `https://api.telegram.org/*`.

**Prueba:** `prueba_vigia.js` (chrome/fetch/reloj simulados): no avisa a los 10 min, avisa a los 16 con el motivo,
no repite, avisa la recuperación una vez, no avisa en simulacro. Pruebas de lectura sin cambios.

**Límite:** con Chrome cerrado o el PC apagado no hay quién envíe el aviso.
