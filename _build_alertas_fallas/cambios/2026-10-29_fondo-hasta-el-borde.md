# El fondo oscuro llega hasta el borde inferior de la ventana

**Fecha:** 2026-10-29
**Versión:** 1.16 → 1.17
**Archivos:** `alertasFallas.js`, `config.json`, `AlertasPorSeveridad_addin.zip`

## Qué se veía

Dentro de MyGeotab el panel oscuro terminaba donde terminaba el contenido y debajo quedaba la página en blanco: la raíz tenía un
alto mínimo fijo (`70vh`) y el resto de la página es de MyGeotab. Mismo problema ya corregido en el Seguimiento de Regeneraciones.

## Qué cambió

`ajustarAlturaRaiz()` fija el alto mínimo de la raíz en `alto de la ventana − distancia a la que empieza el add-in` (debajo de la barra
superior de MyGeotab). Se recalcula al iniciar, al enfocar, al terminar cada carga y al redimensionar (el listener se quita en `blur`).
Si el contenido es más alto que la ventana, la página crece con él y no sobra blanco.

## Verificación

Chromium reproduciendo la página (barra negra fija de 48 px, fondo blanco) con la API simulada de siempre: a 1662×910 y a 1662×1250 el
panel llega exactamente al borde inferior, sin barra de desplazamiento extra; con contenido largo la altura del documento coincide con el final
del panel. Regresión funcional completa de la pantalla (KPI, filtros, vistas, historial, banner y campana): igual que antes, 0 errores de
consola. **No probado dentro de MyGeotab.**
