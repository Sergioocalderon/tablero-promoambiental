# Fix: el mapa del Expediente Consolidado ubicaba los códigos en barrios que no eran

**Versión 1.15** · `alertasFallas.js`, función `scriptMapaConsolidado` (reemplaza a `SCRIPT_INIT_MAPA_CONSOLIDADO`)

## Qué se vio

El usuario generó el expediente del móvil 1149 (Bogotá, Foton Auman) y los puntos
aparecían en lugares que no correspondían a donde estuvo el vehículo.

## Diagnóstico (con datos reales)

Las coordenadas eran correctas: se compararon con los `LogRecord` de Geotab de cada
falla (por ejemplo 4.55616, -74.09319 para los códigos de las 10:50 del 10-oct) y
coincidían con las del add-in. El error estaba al **dibujar**:

- Los marcadores estaban a ~24,5 px/km y el mapa de fondo a ~41 px/km: **las calles
  salían ~1,7 veces más ampliadas que los puntos**, así que cada punto caía en otro barrio.
- El marcador del código del 27-sep (base del Distrito, Puente Aranda) quedaba **fuera
  del recuadro** y no se veía.
- Los códigos con la misma posición (ABS y neumáticos del mismo evento) se tapaban entre sí.

Es el mismo origen de los arreglos del 01 y 02-oct: Leaflet posiciona las teselas con
transformaciones CSS y animaciones de zoom, y `html2canvas` las captura a medias o con
otra escala. Cada arreglo corregía un síntoma y volvía a aparecer otro.

## Fix de fondo

El mapa consolidado **ya no usa Leaflet**. Se calcula todo con la misma fórmula (Web Mercator):

- Se elige el mayor zoom en que entran todos los puntos con margen.
- Cada tesela es un `<img>` en posición absoluta (left/top en píxeles, sin transform ni animación).
- Cada marcador es un `<div>` calculado con **la misma función** que las teselas: no existe
  un segundo cálculo que pueda diferir.
- Los códigos con idéntica posición se abren en abanico unos píxeles para verlos todos.
- Las teselas se superponen 1 px para evitar una línea clara entre filas al capturar.
- El recuadro del mapa pasa de 240 a 300 px de alto para poder acercar más el zoom.
- Si no hay internet, se muestra el mapa gris con los puntos y el aviso "Mapa base no disponible".

El mapa del Mini Expediente de **un solo código** (`SCRIPT_INIT_MAPA`) no se tocó; sigue con Leaflet.

## Cómo se probó

Con Chromium (Playwright) cargando el JS real del add-in y generando el expediente del
1149 con sus 5 códigos reales, capturado con html2canvas igual que en el add-in:
5/5 marcadores visibles, 6/6 teselas cargadas, sin errores de consola. Se agregó un punto
de control en la Plaza de Bolívar (cayó sobre el centro de Bogotá) y el código de la base
del Distrito cayó en Puente Aranda.
