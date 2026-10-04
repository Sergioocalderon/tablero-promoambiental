# Móviles en el detalle de un sistema

**Fecha:** 2026-10-03
**Versión:** 2.6 → 2.7
**Archivos:** `dashboardAnalisisFallas.js`, `config.json`, `DashboardFallas_addin.zip`

## Pedido del usuario

Al seleccionar un sistema (ej. Motor), la tabla "Códigos SPN/FMI de este
sistema" mostraba en "Vehículos" solo cuántos móviles tenían cada código, no
cuáles.

## Cambio

- `agregarPorCodigo`: `vehiculosAfectados` guarda ahora los episodios por
  vehículo (antes solo `true`) y cada código trae `episodiosPorVehiculo`
  (`[{idVehiculo, episodios}]`, de más a menos). `vehiculosAfectados` (el
  conteo) no cambia para el resto de consumidores.
- Nueva `crearCeldaMovilesCodigo`: la columna pasa a llamarse "Móviles
  (episodios)" y muestra una etiqueta por móvil con sus episodios de ESE
  código ("1220-FXW192 (103)"). Hasta 6 etiquetas; el resto en "+N más"
  con la lista completa al pasar el mouse.
- Cada etiqueta filtra el dashboard por ese móvil, con el mismo
  `cfToggle('vehiculo', id)` del gráfico Top vehículos, y queda resaltada
  mientras el filtro esté activo. Otro clic lo quita.

## Verificación (corrida real en Chromium con la API real, 30 días)

- Clic en la barra "Motor" → tabla con 15 de 90 códigos. Cada código lista
  sus móviles y la suma de episodios por móvil cuadra con la columna
  Episodios (ej. 871/1: 103+74+64+30+23+1 = 295).
- Clic en la etiqueta "LSY868 (438)" → el dashboard queda filtrado por
  LSY868 (Top 5 vehículos muestra solo ese móvil).
- 0 errores de consola y de API.
