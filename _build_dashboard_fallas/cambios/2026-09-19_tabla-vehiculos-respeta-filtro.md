# Tabla "Detalle — Top vehículos" ahora respeta el filtro de vehículo

**Fecha:** 2026-09-19
**Archivo:** `_build_dashboard_fallas/dashboardAnalisisFallas.js`
**Versión:** `config.json` 2.1 → 2.2

## Contexto

El usuario preguntó si la tabla "Detalle — Top 5 vehículos" cambiaba al
filtrar. Se le explicó que, por diseño (2026-09-18), esa tabla ignoraba a
propósito `CF.vehiculo` para acompañar al gráfico de arriba (que también lo
ignora, así se puede comparar el Top 5 completo con la barra elegida
resaltada). El usuario pidió el cambio: quiere que la TABLA sí colapse a la
fila del vehículo filtrado.

## Cambio

En `renderizarResultados`, la tabla pasa de recibir `vehiculosParaGraficoTop`
(ignora `CF.vehiculo`) a recibir `vehiculosOrdenados` (respeta TODAS las
dimensiones de CF, incluido vehículo). El **gráfico** de Top vehículos
arriba no se tocó -- sigue mostrando el panorama completo con la barra
elegida resaltada, coherente con Sistemas/Tendencia/Activas-Inactivas.

Resultado: filtrar por un vehículo puntual ahora colapsa la tabla a esa
única fila (o a las filas de los vehículos elegidos si se seleccionó más de
uno vía clic en el gráfico), mientras el gráfico de barras arriba sigue
mostrando el Top 5 completo para comparar.

## Pendiente

El usuario mencionó que además quiere revisar coherencia de datos en
general ("no me parecen coherentes") -- pendiente de que especifique qué
números concretos ve raros, antes de tocar más lógica de agregación.
