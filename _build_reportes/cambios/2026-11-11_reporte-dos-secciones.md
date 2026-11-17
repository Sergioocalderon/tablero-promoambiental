# Reporte de fallos en dos secciones (Activos al generar / Activaciones en el período)

**Fecha:** 2026-11-11
**Versión:** 2.4 → 3.2 (3.0 = dos secciones; 3.1 = fichas PDF; 3.2 = kilometraje y horas en las fichas)
**Archivos:** `mantenimiento.js`, `reporte_plantilla_v2.html` (nuevo), `construir_plantilla_v2.py` (nuevo),
`incrustar_plantilla_v2.py` (nuevo), `pruebas/prueba_escopos.js` (nuevo), `config.json`, `Mantenimiento_addin.zip`.

## Por qué
El reporte de fallos de la aplicación (Herramientas › Análisis y Reporte de Fallos, ver
`Paquete_Reporte_de_Fallos_2026-11-09.zip`) pasó de una sola vista a **dos secciones independientes**. El add-in
generaba el formato anterior (una sola lista de "fallas distintas"). Ahora genera el mismo formato nuevo, tomando
la plantilla y el motor JS del HTML de ejemplo del paquete.

## Qué cambia en el reporte descargado
- **Fallos activos al generar**: falla cuyo último registro está Active (o Pending) y llegó en las **últimas 24 h** antes del
  corte. El rango de fechas no limita esta sección. Criticidad = la del último registro.
- **Activaciones en el período**: cada inicio real de episodio dentro del rango (misma regla y debounce de 10 min de
  siempre). Criticidad = máximo por episodio, por día.
- Matriz de criticidad por sistema con total, comparativos por móvil (tipología y marca: fallos ÷ móviles de la flota,
  con las cifras originales), "¿Cuándo se activaron?", tablas de detalle con filtros cruzados.
- **Sin GoFault** (fuente `SourceGeotabGoId` / controlador `ControllerGoDeviceId`): solo camión y OBD, como la aplicación.
  Verificado con datos reales: ambas reglas coinciden (276 de 276 registros).
- `Pending` cuenta como activa y la luz MIL (check engine) da criticidad MEDIA, igual que la aplicación.

## Fichas PDF de revisión (v3.1)
El generador de fichas (PDF por móvil o por sistema, con registro de intervención y envío por WhatsApp) viene dentro de la
plantilla como JavaScript (`window.FichaPdf`); solo necesita el bloque `data-fault-review`: una fila por falla, los activos
primero y las activaciones después (`reviewIndex` = posición). `construirFichas` lo arma con los mismos datos del reporte.
**Kilometraje y horas de motor (v3.2):** salen de StatusData (`DiagnosticOdometerAdjustmentId` en metros y
`DiagnosticEngineHoursAdjustmentId` en segundos, medidos con datos reales; la ficha los muestra en km y h). Se toma la lectura
más cercana a la fecha de la falla (tolerancia 12 h); se consultan solo los vehículos con fallas, en lotes de 8. Si la consulta
falla el reporte sale igual y el mensaje lo avisa. Sin modelo del vehículo (queda vacío).

## Qué se quitó o no se trajo
- **Evolución de los fallos** (7 semanas por empresa): necesita historial largo que el add-in no tiene.
- Del pie de página se quitó lo que el add-in no hace (filtros de inclusión de telemática/indicadores).

## Límites conocidos (sin la base local de la aplicación)
- "Nueva/Recurrente" y la duración de episodios largos se calculan con `SEMILLA_DIAS = 7` días de historial previo al
  rango. Una duración con «≥» indica que el inicio real puede ser anterior. No siempre coincidirá con la aplicación.
- La clasificación por sistema sigue siendo la del add-in (10 sistemas + "Otro / Sin clasificar"), más gruesa que la de la
  aplicación. Con datos reales de ZIPA, 5 de 11 fallas activas caen en "Otro / Sin clasificar" y se ve como una fila
  más en la matriz (antes se ocultaba del gráfico de sistemas; el motor nuevo no tiene ese ajuste).
- Fechas en hora del navegador (Colombia).

## Implementación
- `construirEscopos`, `episodiosDeRegistros`, `construirTablaDetalle`, `construirDataset`, `ensamblarReporteHtml`
  reemplazan a `agruparPorFalla`, `construirFilas`, la narrativa y el ensamblado con motor aparte.
- La plantilla incrustada ya incluye el motor: `MOTOR_JS_EMBEBIDO` desaparece. Se regenera con
  `python -X utf8 construir_plantilla_v2.py "<ejemplo.html>"` y se incrusta con `python -X utf8 incrustar_plantilla_v2.py`.
  El script falla si quedan datos del ejemplo dentro de la plantilla.
- Consulta a Geotab: flota de hasta 20 vehículos → una consulta de FaultData por vehículo (`deviceSearch`); si es mayor, una
  consulta global como antes. Ventana: (desde − 7 días) hasta ahora.
- `reporte_plantilla.html` y `reporte_runtime_engine.js` quedan solo como referencia del formato anterior.

## Verificación
- `node pruebas/prueba_escopos.js`: 20 comprobaciones (continuación de episodios, regla de 24 h, GoFault, parpadeo,
  Pending/MIL, estructura de las tablas, marcadores).
- Chrome headless con datos reales de ESTACIÓN DE TRANSFERENCIA ZIPA (4 vehículos, 13.305 registros, 14 días):
  11 fallas activas, 35 con activaciones (485), 0 GoFault, 35 ms de cálculo, 0 errores de consola, ambas pestañas
  renderizadas y revisadas visualmente. Fichas: en Chrome, `FichaPdf.build` genera un PDF válido (%PDF-, 16 KB) con los datos reales de un móvil. Con ZIPA: 46 de 46 fichas con km y horas al inicio y al último registro; el PDF muestra, p. ej., «824.610,2 km» y «31.947,4 h».
- **No probado**: la ejecución dentro de MyGeotab (llamadas `api.call` desde el add-in), ni empresas con más de 20 vehículos.
