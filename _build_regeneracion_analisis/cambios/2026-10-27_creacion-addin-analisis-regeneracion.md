# Creación del add-in "Análisis de Regeneraciones DPF"

**Fecha:** 2026-10-27
**Versión:** 1.0
**Archivos:** `analisisRegeneracion.parte.js` (parte propia), `config.json`; el `.js`/`.html` y el zip los genera `herramientas/construir_addins_regeneracion.py` a partir de `_build_regeneracion_comun/`.

## Qué hace

Tablero histórico por rango de fechas sobre los 83 vehículos del alcance de la regla
"Regeneración Manual Inactiva y Lámpara DPF Encendida - C" (la misma que usan la vigilancia
de Telegram y el reporte por ciudad de Python):

- Solicitudes de regeneración (episodios de lámpara DPF encendida), manuales vs. resueltas solas.
- Reacción del conductor: mediana de minutos de MOTOR ENCENDIDO hasta activar el interruptor.
- Regeneraciones detectadas por caída sostenida del hollín.
- Tendencia diaria (solicitudes en eje derecho: son ~2/día frente a ~70 regeneraciones/día),
  solicitudes por ciudad, cómo se resolvieron, top de vehículos, tabla por vehículo con historial.
- Filtros por ciudad, marca y vehículo; clic en las barras filtra.

## Origen de la lógica

Puerto a JS de `detectar_regeneracion_dpf.py` (hollín) y `vigilancia_cumplimiento_regeneracion.py`
(lámpara/interruptor/ignición, con las correcciones del 2026-10-03). Una sola copia en
`_build_regeneracion_comun/` compartida por los 3 add-ins de regeneración.

## Verificación

Con 30 días reales de Geotab (83 vehículos), la lógica JS en Chromium coincide con la salida de
los scripts Python: 1.994 regeneraciones por hollín, 74 solicitudes cerradas y 1 abierta,
0 diferencias. En el add-in completo con API simulada con esos datos: 75 solicitudes y 1.994
regeneraciones; el mismo resultado forzando la división de tramos por tope de página. 0 errores de consola.

## Límites conocidos

- 23-24 vehículos no reportan hollín ni lámpara: aparecen como "Sin señal", no como "sin novedad".
- Una lámpara encendida desde antes de la ventana consultada (+3 días previos) se ve como iniciada dentro de ella.
