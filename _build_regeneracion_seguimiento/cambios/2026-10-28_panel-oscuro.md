# Panel principal en tema oscuro (reestructuración visual)

**Fecha:** 2026-10-28
**Versión:** 1.3 → 1.4
**Archivos:** `seguimientoRegeneracion.parte.js`, `config.json`; el `.js`, el `.html` y el zip los genera
`herramientas/construir_addins_regeneracion.py`.

## Qué cambió (solo presentación; el cálculo de lámparas, hollín y estados no se tocó)

A partir del boceto del usuario:

- **Encabezado:** nombre de la empresa, título, subtítulo, "Actualización: 27-oct-2026 04:42" (hora de la última
  carga, hora Bogotá), **Copiar reporte general** (verde, con icono de chat) y **Actualizar ahora**.
- **Filtros:** "Todas las bases" y "Cualquier estado". Las opciones salen de los datos: cada base con lo que tiene
  pendiente (`Cali — 0 regenerar · 2 próximos`) y cada estado con su cantidad (`Taller (1)`, `Próximos al umbral (2)`).
  El borde se pone verde cuando hay un filtro puesto. Si un estado deja de existir tras refrescar, el filtro se limpia.
  Reemplazan a las 5 tarjetas KPI y a los chips de ciudad.
- **REGENERAR YA:** punto rojo, tabla oscura con filas tintadas en rojo y la columna "Horas de motor" resaltada, pastilla
  de "Qué hacer" sólida (rojo = urgente, naranja = avisar, ámbar = en observación, gris = informativo). El subtítulo
  conserva el conteo de urgentes y por avisar que daban las tarjetas.
- **PRÓXIMOS AL UMBRAL:** punto amarillo, hollín y umbral en amarillo, y **Ver reglas de umbral** (panel desplegable con
  umbrales por marca, aviso al conductor/escalado/taller y límites de lectura; se arma con las mismas constantes de la
  lógica, no con números repetidos a mano).
- **Aviso de sin señal** con **Ver listado de placas**: ahora muestra TODAS las placas agrupadas por ciudad (antes se
  cortaba en 20).
- **Acción por fila:** botón de chat que **copia la imagen del expediente** de ese vehículo, lista para pegar en el grupo
  de WhatsApp, sin abrir el expediente (en las dos tablas). Un clic en el resto de la fila sí lo abre.
- Encabezados ordenables con flecha ▲/▼ y `aria-sort`.
- El chip de estado del expediente usa ahora la misma paleta (nivel 1 pasa de azul a ámbar).

## Decisiones respecto al boceto

- **Sin logo:** solo el nombre "Promoambiental". No hay archivo del logo y no se improvisa uno; si se entrega la imagen se
  puede incrustar.
- **Un solo botón "Actualizar ahora"** (el boceto lo repetía).
- **Copiar reporte general:** con una base elegida el botón dice "Copiar reporte de <base>" y copia solo esa base; sin
  filtro copia todas (mismo formato de siempre, el de `reporte_regeneracion_ciudades.py`).
- **La columna Acción también está en "Próximos"** (el boceto no la traía) para poder mandar esos casos igual.
- El filtro de estado decide qué sección se ve: un estado de lámpara deja solo "Regenerar ya" filtrada; "Próximos" deja solo
  los próximos. El aviso de sin señal depende de la base, no del estado.

## Verificación

Chromium con los datos reales volcados de Geotab (1 vehículo con lámpara, 2 próximos, 24 sin señal): filtros por base y
estado (con conservación y limpieza), reglas de umbral, listado de las 24 placas, orden de columnas, copia del reporte
(texto) y de la imagen (PNG 2160×2734) al portapapeles, el botón de la fila no abre el modal, el clic en la fila sí, y
regresión completa del expediente. 0 errores de consola. **No probado dentro de MyGeotab.**
