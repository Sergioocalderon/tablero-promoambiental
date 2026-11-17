# El fondo oscuro llega hasta el borde inferior de la ventana

**Fecha:** 2026-10-28
**Versión:** 1.4 → 1.5
**Archivos:** `seguimientoRegeneracion.parte.js`, `config.json`; el `.js`, el `.html` y el zip los genera
`herramientas/construir_addins_regeneracion.py`.

## Qué se vio

Dentro de MyGeotab el panel oscuro terminaba donde terminaba el contenido y debajo quedaba la página en blanco.
La raíz del add-in tenía un alto mínimo fijo (`70vh`) y el resto de la página es de MyGeotab, no del add-in.

## Qué cambió

`ajustarAlturaRaiz()` fija el alto mínimo de la raíz en `alto de la ventana − distancia a la que empieza el add-in`
(debajo de la barra superior de MyGeotab). Se recalcula al iniciar, al enfocar, al terminar cada carga y al
redimensionar la ventana (el listener se quita al salir del add-in). Si el contenido es más alto que la ventana, la
página crece con él y no sobra blanco debajo.

## Verificación

Chromium reproduciendo la página (barra negra de 45 px, página blanca): a 1662×910 y a 1662×1200 el panel llega exactamente
al borde inferior, sin barra de desplazamiento extra; con ventana baja o con el listado de placas desplegado la altura
del documento coincide con el final del panel. 0 errores de consola. **No probado dentro de MyGeotab.**

## Pendiente

Alertas por Severidad (v1.16) usa el mismo `minHeight: '70vh'`: puede mostrar el mismo espacio blanco.
