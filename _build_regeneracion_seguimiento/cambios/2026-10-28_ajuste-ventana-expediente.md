# Ajuste de la ventana del expediente dentro de MyGeotab

**Fecha:** 2026-10-28
**Versión:** 1.5 → 1.6
**Archivos:** `seguimientoRegeneracion.parte.js`, `config.json`; el `.js`, el `.html` y el zip los genera
`herramientas/construir_addins_regeneracion.py`.

## Qué se vio

En MyGeotab la barra negra superior queda por encima de cualquier capa del add-in y tapaba la parte de arriba del
modal: se cortaban el título "Expediente del móvil" y los botones. Además el modal era alto y, en pantallas bajas,
había que desplazarlo sin poder llegar a los botones.

## Qué cambió

- La superposición empieza por debajo de la barra de MyGeotab (`ALTO_BARRA_MYGEOTAB = 56`), así que el modal ya no
  queda tapado. Se cierra con Esc o con un clic en el fondo oscuro, como antes.
- **Cabecera fija** (`position: sticky`): "Copiar imagen", "Descargar imagen" y "Cerrar" siguen a la vista al desplazar.
  Para eso la tarjeta ya no recorta su contenido (`overflow: hidden`) y la cabecera lleva sus propias esquinas redondeadas.
- **Más compacto:** menos relleno y márgenes, título y tarjetas algo más pequeños y gráfica un 10 % más baja
  (`GRAF.H` 300 → 270). La imagen para WhatsApp usa la misma proporción y también queda más corta (2160×2674 px).

## Verificación

Chromium simulando la barra de MyGeotab (fija, z-index máximo): a 1654×936 la cabecera y los botones quedan libres y el
modal cabe sin desplazar; a 1366×680 la cabecera se queda fija bajo la barra al desplazar el contenido. La imagen se sigue
copiando al portapapeles. 0 errores de consola. **No probado dentro de MyGeotab.**
