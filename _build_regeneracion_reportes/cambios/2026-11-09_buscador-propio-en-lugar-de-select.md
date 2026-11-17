# Reportes de Regeneraciones DPF v1.2 — lista desplegable propia con búsqueda

**Fecha:** 2026-11-09
**Versión:** 1.1 → 1.2
**Archivos:** `reportesRegeneracion.parte.js`, `config.json`, `ReportesRegeneracion_addin.zip`

## Problema
En Copiloto, al abrir "Vehículo (móvil)" (v1.1) el popup nativo del `<select>` se pintaba mal: más angosto que el campo, con la primera fila en azul y **todas las filas sin texto**. El campo cerrado sí mostraba el valor, así que las opciones existían; el fallo está en cómo el navegador dibuja el popup nativo dentro del iframe, y no se puede corregir con estilos.

## Cambio
- Nuevo `crearBuscador(etiqueta)`: lista desplegable **propia** (div con CSSOM), sin popup nativo. Se abre al hacer clic o al enfocar; **escribiendo se filtra** (sin distinguir mayúsculas ni tildes, por cualquier parte del texto, p. ej. `1167` o `mercedes`); flechas arriba/abajo + Enter, Escape y clic para elegir; "Sin coincidencias" si no hay resultados.
- Se usa en **Ciudad** y **Vehículo (móvil)** (ambos eran `<select>` nativos). Al cambiar la ciudad, el vehículo vuelve a "Todos los vehículos (N)".
- Sin cambios en los criterios ni en el contenido del reporte.

## Probado (Chrome headless, API simulada con dispositivos y grupos reales)
7 opciones de ciudad con texto oscuro sobre fondo blanco; al elegir Bogotá, 33 móviles; escribir `1167` deja 1 resultado; `zzz` muestra "Sin coincidencias"; elegir el 1167 genera `Reporte_Regeneracion_1167_NWY955_<desde>_<hasta>.html` con título "1167-NWY955 (Bogotá (Distrito))"; cambiar de ciudad reinicia el vehículo; 0 errores de consola. Captura revisada.
No probado dentro de Copiloto/MyGeotab.

## Pendiente
- Los otros add-ins que usan `crearSelect` (Análisis de Regeneraciones, Validación de Baterías, y posiblemente Seguimiento) pueden tener el mismo fallo del popup nativo en Copiloto. Confirmar y, si es así, mover `crearBuscador` al kit compartido `_build_regeneracion_comun/ui.js` y usarlo allí.
