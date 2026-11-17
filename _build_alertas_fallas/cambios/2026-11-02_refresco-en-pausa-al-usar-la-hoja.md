# Alertas por Severidad v1.19 — el refresco automático no interrumpe

**Problema:** cada 5 min el add-in se recargaba solo, mostraba el panel "Cargando…" y perdía la posición de la lista, aunque se estuviera usando.

## Cambio
- El temporizador de 5 min ahora solo **pide** el refresco. Se ejecuta cuando pasan **30 s sin actividad** (mouse, scroll, teclado, toque) y no hay un expediente generándose.
- Mientras se usa la hoja, el encabezado dice "Actualización en pausa mientras usas la hoja"; se revisa cada 5 s si ya se puede.
- Si la pestaña no está a la vista, espera.
- El refresco automático es **silencioso**: no reemplaza la lista por "Cargando…", y conserva la posición de scroll (página y tabla interna). Si falla, deja la lista anterior y solo avisa "Sin actualizar".
- El botón **Actualizar** sigue recargando al instante, con el panel de carga de siempre.
- Constantes: `INACTIVIDAD_MS` (30 s) y `REVISION_PAUSA_MS` (5 s).

## Probado (API simulada, reloj controlado)
5 min con el mouse activo: 0 recargas · 20 s quieto: sigue en pausa · >30 s quieto: recarga sin panel "Cargando" y con el scroll en 150 · botón manual: recarga al instante · 0 errores de consola.
