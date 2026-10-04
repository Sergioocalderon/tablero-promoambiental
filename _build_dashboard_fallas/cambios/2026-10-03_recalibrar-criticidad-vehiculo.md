# Recalibrar la criticidad por vehículo

**Fecha:** 2026-10-03
**Versión:** 2.5 → 2.6
**Archivos:** `dashboardAnalisisFallas.js`, `config.json`, `DashboardFallas_addin.zip`

## Problema

En la auditoría del mismo día, 57 de 75 vehículos salían "Crítico" en la
vista de 30 días, así que la categoría ya no distinguía nada. Además
contradecía el KPI "31 vehículos con alerta crítica activa". Con datos reales
se vio que **los dos criterios estaban saturados a la vez**:

- **Cantidad:** con umbral ≥21 episodios (calibrado el 2026-09-12 con Bogotá,
  12 días) entraban 49 vehículos. La distribución real de 30 días es P25 9 ·
  mediana 76 · P75 260 · P90 567 · máx 1.130.
- **Sistema:** bastaba UN episodio de Motor/Frenos/Dirección/Embrague en
  cualquier momento del rango, aunque ya estuviera resuelto (54 vehículos).
  Subir solo el umbral de cantidad no alcanzaba: seguían ~54 críticos.

## Opciones simuladas con los mismos datos reales

| Calibración | Crítico | Alto | Medio | Bajo |
|---|---|---|---|---|
| Anterior (5/9/21 + cualquier falla crítica) | 57 | 1 | 4 | 13 |
| Cuartiles (9/76/260) + falla crítica ACTIVA | 36 | 6 | 15 | 18 |
| **Cuartiles con crítico en P90 (9/76/567) + falla crítica ACTIVA** | **32** | **10** | **15** | **18** |
| Cuartiles + cualquier falla crítica | 54 | 1 | 3 | 17 |

## Cambio (pedido por el usuario: "recalcula el dato")

- Nuevos umbrales, redondeados sobre la opción elegida: **Bajo 1-9 · Medio
  10-79 · Alto 80-499 · Crítico ≥500**.
- El criterio de sistema pasa a **falla crítica que SIGUE ACTIVA al cierre
  del rango** (`tieneFallaCriticaActiva`, derivado de `activaAlFinal` de cada
  grupo). Es el mismo criterio que el KPI "vehículos con alerta crítica
  activa", que es lo que de verdad pide "atención inmediata".
  `tieneFallaCritica` se conserva en el objeto del vehículo por compatibilidad.
- Texto de ayuda (ⓘ junto a Criticidad) actualizado con los nuevos umbrales y
  la nota "calibrados para 30 días".

## Verificación (corrida real en Chromium con la API real)

- "**33 vehículos** en estado crítico" (antes 57), coherente con "31
  vehículos con alerta crítica activa". Los 2 restantes superan 500 episodios.
- El resto de KPIs no cambia (14.083 episodios y 75 vehículos, solo varía por
  la hora de la consulta). 0 errores de API y de consola.

## Limitación conocida

Los umbrales de cantidad están calibrados para el rango por defecto de 30
días. Con un rango más corto, los vehículos tienden a caer en niveles más
bajos por cantidad. El criterio de falla crítica activa no depende del rango.
