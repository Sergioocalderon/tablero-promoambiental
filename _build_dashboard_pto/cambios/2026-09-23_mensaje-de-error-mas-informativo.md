# Mensaje de error más informativo ("Error al consultar Geotab." era demasiado genérico)

Fecha: 2026-09-23
Versión: 1.11 → 1.12

## Qué cambió

Nueva función `describirError(err)`: antes, cualquier error que no tuviera
exactamente la forma `{message: '...'}` caía al texto genérico "Error al
consultar Geotab." — sin pistas de la causa real. Ahora prueba varias
formas conocidas de error del SDK de Geotab (string plano, `{error: ...}`,
`{name: ...}`, y como último recurso `JSON.stringify` del objeto completo)
antes de caer al genérico.

## Por qué

El usuario reportó "Error al consultar Geotab." después del tercer fix de
la cuota de API — sin más detalle no se puede saber si es la MISMA cuota
excedida (con otra forma de error), un error de red, o algo nuevo. Este
cambio es de diagnóstico, no un fix en sí — el siguiente paso es que el
usuario reintente y comparta el mensaje ahora más detallado (o lo que
aparezca en la consola del navegador, F12, que sigue quedando registrado
con `console.error` igual que antes).

## Archivos

- `dashboardAnalisisPTO.js` — nueva función `describirError`, usada en el
  `.catch` de `cargarYRenderizar`.
- `config.json` — versión 1.11 → 1.12.
