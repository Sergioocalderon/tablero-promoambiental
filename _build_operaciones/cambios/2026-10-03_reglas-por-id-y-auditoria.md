# Reglas por ID, aviso de reglas faltantes y marca Chevrolet

**Fecha:** 2026-10-03
**Versión:** 1.1 → 1.2
**Archivos:** `operaciones.js`, `config.json`, `Operaciones_addin.zip`

## Contexto

Auditoría completa de los add-ins contra la cuenta real de Geotab: cada add-in
se ejecutó en Chromium con la API real (solo lectura) y sus cifras se
recalcularon por fuera en Python. En Operaciones, velocidad, ralentí y PTO
cuadraron con el recálculo independiente. Pero el ralentí estaba
**incompleto**.

## Bug real: la regla de ralentí L9 se perdía en silencio

Alguien renombró en Geotab `V_(L9) RALENTÍ` a `V_(L9 y  VOLSKWAGEN) RALENTÍ`
(con doble espacio). Es la misma regla, con el mismo historial desde julio, y
ahora también incluye el grupo Volkswagen. `REGLAS_HABITO` buscaba por nombre
exacto, así que la omitía y solo lo avisaba en la consola del navegador.

Impacto medido (7 días, toda la flota): el reporte veía ~550 de ~2.200
eventos de ralentí (−75 %) y ~191 de ~523 h (−63 %). En Bogotá, los 11
compactadores International (1152-1161, 1307, 1308) salían con cero ralentí.

## Cambios

- `REGLAS_HABITO` pasa de lista de nombres a `{id, nombre}`. Se busca primero
  por ID (no cambia si la regla se renombra) y, si el ID no existe, por nombre
  (respaldo por si la regla se borra y se recrea).
- `resolverReglasHabito` junta las reglas que no aparecen por ninguno de los
  dos en `reglasFaltantes`. El reporte las lista en rojo en "Filtros
  aplicados" y el mensaje final del add-in sale como error, en vez de
  omitirlas en silencio.
- `PALABRAS_GRUPO_MARCA` + `'chevrolet'`: los NHR y N400 salían "Sin marca".
- Comentarios desactualizados corregidos (`REGLAS_HABITO en reportes.js` →
  `operaciones.js`; las decisiones de velocidad y ralentí sí fueron confirmadas
  con el usuario el 2026-10-01).

## Reglas auditadas el 2026-10-03

- Las 6 de ralentí: velocidad de rueda <1 km/h, banda de RPM de ralentí de cada
  motor, encendido, ≥5 min. Muestra de 12 eventos cruzada con GPS (0-3 km/h,
  ruido normal) y PTO (0 pulsos): es ralentí real, no compactación. Ningún
  vehículo en dos reglas a la vez.
- `V_VELOCIDAD MAYOR A 50 KM/H`: velocidad de rueda >50 km/h sostenida 30 s.
  Muestra de 10 eventos con GPS máx. 57-103 km/h.

## Verificación (corrida real, Bogotá, última semana, add-in en Chromium con API real)

| | 1.1 (antes) | 1.2 (después) |
|---|---|---|
| Eventos de ralentí | 447 | **1.004** |
| Móviles con ralentí | 17 | **27** |
| Tiempo en ralentí | 93 h 35 min | **191 h 50 min** |
| `V_(L9 y  VOLSKWAGEN) RALENTÍ` | 0 (omitida) | 557 |

- 12/12 gráficas renderizadas, 0 errores de consola y 0 errores de API.
- Prueba del aviso: con el ID de `V_(T380) RALENTÍ` cambiado por uno
  inexistente (solo dentro del arnés de prueba), el reporte muestra en rojo
  "⚠ Reglas de Geotab no encontradas (sus eventos NO están en este reporte):
  V_(T380) RALENTÍ BORRADA (RALENTÍ)" y el mensaje final del add-in dice
  "Descarga iniciada, PERO faltan reglas en Geotab…".
- Velocidad (2.134/2.135) y PTO (1.264/1.263) prácticamente iguales entre
  ambas corridas. La diferencia de ±1 sale de los minutos entre una corrida y
  la otra.

## Pendiente (decisión del usuario)

El pipeline de PTO descarga mucho dato de RPM de alta resolución (45-100 MB
por lote, ~415 MB por una semana de Bogotá). Ver la propuesta en el
changelog del 2026-10-03 de `_build_dashboard_pto/`.
