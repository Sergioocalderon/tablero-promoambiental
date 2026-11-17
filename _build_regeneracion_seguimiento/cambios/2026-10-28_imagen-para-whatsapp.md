# Expediente: imagen para compartir en grupos de WhatsApp (reemplaza "Imprimir PDF")

**Fecha:** 2026-10-28
**Versión:** 1.2 → 1.3
**Archivos:** `seguimientoRegeneracion.parte.js`, `config.json`; el `.js`, el `.html` y el zip los genera `herramientas/construir_addins_regeneracion.py`.

## Qué cambió

El uso real del expediente es mandar el caso a los grupos de WhatsApp, no imprimirlo. Se quitó "Imprimir PDF"
(y con él la versión clara imprimible y su tema) y el modal ahora tiene:

- **Copiar imagen:** deja el PNG en el portapapeles para pegarlo en el grupo con Ctrl+V. Si el navegador no deja
  copiar imágenes, la descarga y avisa.
- **Descargar imagen:** guarda `Expediente_DPF_<móvil>_<aaaammdd>_<hhmm>.png` para adjuntarlo.

La imagen es vertical (1080 px de ancho dibujados a 2x, ~450 KB), con el mismo estilo oscuro del modal: cabecera,
móvil, estado, qué hacer, tarjetas (2x2 si son 4, en fila si son 3), gráfica de hollín con su leyenda y pie con la
fecha de los datos. Se dibuja directo en un canvas: sin librerías, sin HTML intermedio y sin consultas nuevas a Geotab.
Mientras se genera, los dos botones quedan bloqueados para no lanzarla dos veces.

## Verificación

Chromium con los datos reales volcados de Geotab, desde un origen https: el portapapeles recibió un PNG de
2160×2394 px, la descarga generó los PNG de 1089-GVT472 (próximo) y de 3094-GVT509 (lámpara, con nota del
interruptor y 4 tarjetas); sin portapapeles disponible, el respaldo descarga la imagen. 0 errores de consola.
**No probado dentro de MyGeotab:** ahí falta confirmar que el portapapeles de imágenes esté permitido
(si no lo está, el respaldo descarga el PNG).
