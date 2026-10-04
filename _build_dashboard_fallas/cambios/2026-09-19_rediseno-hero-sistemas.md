# Rediseño de arquitectura visual: Hero de Sistemas

**Fecha:** 2026-09-19
**Archivo:** `_build_dashboard_fallas/dashboardAnalisisFallas.js`
**Versión:** `config.json` 1.3 → 2.0 (mayor, no menor — reestructura completa
del orden de página, no una feature aislada, siguiendo la convención de
[[feedback_versionar_addins]])

## Contexto

El usuario pidió reestructurar por completo la arquitectura visual del
dashboard: que la primera sección (hero) esté enfocada 100% en el análisis
por sistema principal, desplazando la tendencia temporal a un segundo
plano. Propuesta técnica aprobada explícitamente antes de implementar (ver
turno anterior), con un ajuste: se avisó que "Impacto en costos
operativos" no es un dato real disponible en ningún sistema conectado
(mismo criterio ya documentado el 2026-09-11 para "tiempo fuera de
servicio") y se sustituyó por un KPI real equivalente.

## Nuevo orden de página

```
Encabezado → Banner de filtros cruzados → Resumen narrativo
→ KPIs del HERO (construirKpisHero, nuevo)
→ 🎯 HERO: Radiografía de sistemas (construirSeccionSistemas, ahora primero)
→ — Panorama general — (rótulo separador)
→ KPIs genéricos (construirKpis, antes primero, ahora secundario)
→ Tendencia + Top vehículos + Activas/Inactivas (construirSeccionGraficos)
→ Tablas Top 5 vehículos/códigos
```

## Cambios

1. **`construirKpisHero`** (nuevo): 4 tarjetas que lideran el dashboard,
   todas con datos reales (nada fabricado):
   - **Sistema con mayor criticidad activa** — de los 4 sistemas críticos
     (Motor/Frenos/Dirección/Embrague), el que tiene más episodios con
     `activaAlFinal=true`. Clicable → `cfToggle('sistema', ...)`.
   - **Vehículos con alerta crítica activa** — vehículos únicos con una
     falla de sistema crítico activa al cierre del rango. Nombrado así
     a propósito, NO "inmovilizados" (ese estado operativo no se mide en
     ningún sistema conectado).
   - **% de episodios en sistemas críticos** — sobre el total del rango.
   - **Sistema con más episodios en el rango** — clicable también.
   - Funciones de cálculo nuevas junto a `agregarPorSistema`:
     `calcularSistemaMayorCriticidadActiva`, `calcularVehiculosAlertaCriticaActiva`,
     `calcularPctEpisodiosCriticos`.

2. **`construirSeccionSistemas` promovida a hero**: se mueve de la 4ª
   posición a la 2ª (justo después del resumen narrativo). Cambios
   visuales para marcarla como protagonista: borde superior verde
   corporativo (`T.color.primary`, única sección con este acento), título
   más grande (de `0.85rem` a `1rem`).

3. **Selector de vehículo duplicado en el hero**: se extrajo la lógica que
   antes vivía solo inline en `construirBarraFiltros` a una fábrica
   reutilizable `crearSelectorVehiculo(ancho)` (input + datalist propio +
   `cfSet`/limpiar) — ahora se instancia DOS veces: la barra de filtros
   global (sin cambios de comportamiento) y el encabezado del hero (nuevo,
   pedido explícito para no tener que volver arriba mientras se mira la
   gráfica central). Ambas instancias escriben sobre el mismo `CF.vehiculo`.

4. **Franja de contexto en el drill-down**: al elegir un sistema, arriba de
   la tabla de detalle SPN/FMI aparece "N episodio(s) · M vehículo(s) · X%
   del total de fallas por sistema" — evita tener que volver a mirar los
   KPIs de arriba mientras se está enfocado en un sistema puntual.

5. **`crearAyudaCriticidad`** (nuevo): ícono ⓘ circular + tooltip clicable
   (no hover, para que funcione igual en pantallas táctiles) con los 4
   umbrales reales de `clasificarCriticidadVehiculo`. Un solo tooltip
   abierto a la vez, se cierra con clic afuera (listener global agregado en
   `initialize`). Integrado en 2 lugares: la leyenda de criticidad bajo
   "Top vehículos" (`crearLeyendaCriticidad`) y el label "Criticidad" de la
   barra de filtros — a propósito NO en cada encabezado de tabla, para no
   sobrecargar la interfaz con el mismo ícono repetido de más.

6. **Taxonomía Embrague/Transmisión**: sin cambios — ya estaba resuelta
   desde el 2026-09-18 (`SISTEMAS` trata Embrague como entrada
   independiente). Se confirmó, no se tocó código.

7. **Paleta**: sin cambios de fondo — se reutilizan `T.color.ink`
   (estructura/texto), `T.color.primary` (nuevo acento del hero, además de
   su uso ya existente para métricas positivas) y los colores de
   `CRITICIDAD` (exclusivos de criticidad, nunca en gráficos neutrales).

## Pendiente de verificar manualmente

No hay test suite. Empaquetar y montar el zip en Geotab para confirmar:
- Que el hero de sistemas sea lo primero visible al cargar (después del
  resumen narrativo), y que la tendencia haya bajado de posición.
- Que el selector de vehículo del hero y el de la barra de filtros se
  mantengan sincronizados (elegir uno actualiza el otro en el próximo render).
- Que los 2 KPIs clicables del hero (Sistema con mayor criticidad activa /
  Sistema con más episodios) salten correctamente al drill-down.
- Que el tooltip de ayuda de criticidad se abra con clic, se cierre con
  clic afuera, y no queden dos abiertos a la vez.
