# Corregir desborde visual del control segmentado "Atajos"

**Fecha:** 2026-09-29
**Archivo:** `_build_reportes/reportes.js`

## Problema reportado

El botón "Último mes", al pasar a estado activo (fondo blanco + sombra), se
veía sobresalir del carril gris que lo contiene -- tosco, desalineado.

## Causa real (no solo visual)

El botón activo en sí no cambia de tamaño (el `box-shadow` no afecta el
tamaño de la caja), así que la sombra sola no explica un desborde real. La
causa de fondo es un comportamiento clásico de flexbox: cada pill usa
`flex:'1 1 0'` con `white-space:nowrap` (para no partir el texto), pero por
defecto un ítem flex NO se encoge por debajo del ancho de su propio
contenido aunque `flex-shrink` lo permita -- `min-width` implícito es
`auto`, no `0`. Con "Última semana" y "Último mes" compitiendo por el mismo
carril angosto, el texto más largo empujaba al botón más allá del
contenedor.

## Corrección

- `crearPill`: se agrega `minWidth:'0'` (anula el mínimo implícito de
  flexbox) + `overflow:'hidden'` + `textOverflow:'ellipsis'` como resguardo
  si algún día el carril queda aún más angosto.
- `grupoPills`: padding subido de 3px a 4px -- más margen real entre el
  botón activo y el borde exterior del carril.
- CSS inyectado: `.rptx-pill.is-active` pasa de
  `box-shadow:0 1px 2px rgba(15,23,42,.1)` a `0 2px 4px rgba(0,0,0,.05)`
  (más delicada, pedido explícito del usuario) y `.rptx-pill` pasa de
  transicionar solo `background,color` a `transition:all .2s ease` (para
  que la sombra también entre/salga de forma suave, no de golpe).
- El `border-radius` de cada pill (7px) ya era menor que el del carril
  (`T.radius.sm`, 10px) desde el cambio anterior -- se confirma que sigue
  así, sin necesidad de ajuste.

## Pendiente

Sigue sin poder verse en una instalación real de MyGeotab durante esta
tarea -- mismo pendiente general del add-in.
