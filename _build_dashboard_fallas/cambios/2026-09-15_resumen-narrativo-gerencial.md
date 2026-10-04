# Resumen narrativo gerencial arriba del dashboard

**Fecha:** 2026-09-15
**Archivo:** `_build_dashboard_fallas/dashboardAnalisisFallas.js`

## Objetivo

Pedido explícito: que el dashboard sea "ameno" para gerencia y conteste
preguntas básicas sin obligar a leer gráficos/tablas. Se definieron 3
preguntas con el usuario:

1. ¿Cuántos vehículos están en estado crítico ahora mismo?
2. ¿La situación mejoró o empeoró frente al periodo anterior (y cuánto)?
3. ¿Cuál es el problema que más se repite y amerita atención?

## Cambio

Nueva función `construirResumenNarrativo` (antes de `renderizarResultados`),
llamada como lo primero que se pinta en cada render — antes que los KPIs.
Arma 2-3 líneas con ícono + frase en lenguaje simple:

- **Línea 1 (siempre)**: cantidad de vehículos en estado crítico, o mensaje
  positivo si no hay ninguno, o mensaje neutro si no hubo fallas en el rango.
- **Línea 2 (solo si hay `periodoAnterior`)**: sube/baja/igual en episodios
  totales vs. el periodo anterior, con el porcentaje — mismo criterio que
  `crearIndicadorTendencia`: **no se muestra con filtros activos**, porque
  comparar un total filtrado de hoy contra uno sin filtrar de ayer no es
  válido (ver `aplicarFiltrosYRenderizar` / `sinFiltrosActivos`).
- **Línea 3 (solo si hay códigos)**: el código de falla más repetido
  (nombre + SPN/FMI), cuántos episodios y en cuántos vehículos.

Importante: **no recalcula nada por su cuenta** — lee `grupos`,
`vehiculosOrdenados`, `codigosOrdenados` y `periodoAnterior`, los mismos
datos ya agregados que usan los KPIs y las gráficas. Esto garantiza que el
resumen nunca puede desalinearse del resto del dashboard, y que se actualiza
solo con cada refresco automático (15 min), cambio de rango de fechas, o
cambio de filtro (ciudad/tipo/criticidad).

Estilo: panel con borde izquierdo de color (rojo si hay críticos, verde si
no), mismo lenguaje visual que las tarjetas KPI existentes (`crearPanel`),
sin agregar ninguna librería ni gráfico nuevo.

## Pendiente de verificar manualmente

No hay test suite. Verificar en Geotab:
1. Con datos reales, que las 3 líneas digan algo coherente con lo que
   muestran los KPIs/tablas debajo.
2. Que la línea de tendencia desaparece al aplicar cualquier filtro
   (ciudad/tipo/criticidad) y vuelve a aparecer al quitarlos.
3. Caso sin fallas en el rango (ej. una ciudad sin actividad) -- debe mostrar
   el mensaje neutro, no un error ni un panel vacío.
