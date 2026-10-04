# Corregir conteo de "activaciones" para usar episodios (no registros crudos)

**Fecha:** 2026-09-29
**Archivo:** `_build_reportes/reportes.js` (función `agruparPorFalla`)

## Motivo

La primera versión de este add-in (mismo día, ver
`2026-09-29_creacion-addin-reportes.md`) contaba "activaciones" como el total
de registros `FaultData` con `faultState==='Active'`. Se le planteó al usuario
el riesgo: Geotab re-registra el mismo FaultData repetidamente mientras el
código sigue activo (no una sola vez por evento real) -- mismo fenómeno ya
documentado y corregido en este proyecto para PTO (`telegram_alertas.py`) y
para FaultData (`dashboardAnalisisFallas.js`, que llegó a ver 24,641
"episodios" crudos en un solo vehículo en 30 días). El usuario confirmó
explícitamente: "vamonos por tu recomendacion" -- usar el mismo criterio ya
validado en `dashboardAnalisisFallas.js` en vez del conteo simple.

## Cambio

`agruparPorFalla` ahora porta VERBATIM el criterio de
`calcularEpisodiosPorGrupo` (dashboardAnalisisFallas.js): una "activación"
es una transición real hacia `faultState==='Active'` desde un estado que no
era Active, con `DEBOUNCE_REACTIVACION_MIN = 10` minutos -- si el código se
reactiva a los pocos minutos de haberse apagado, se trata como el MISMO
episodio en curso (parpadeo), no como uno nuevo.

"Días activos" (`diasActivos`, usado para el cruce con la evolución diaria y
el cross-filter por fecha) se mantiene sin cambios: sigue marcando todo día
con al menos un registro Active, sin importar el debounce -- es un concepto
aparte de "cuántas veces se activó de verdad", y el reporte de referencia
también los trata por separado (la evolución diaria muestra el rango
completo de un episodio largo, no solo su día de inicio).

## Pendiente

Sigue sin poder confirmarse contra una cuenta Geotab real (mismo pendiente
general del add-in, ver el changelog de creación) -- comparar el número de
"Activaciones" que da este add-in contra lo que muestra
`dashboardAnalisisFallas.js` para el mismo vehículo/código/rango antes de
confiar en el número en producción.
