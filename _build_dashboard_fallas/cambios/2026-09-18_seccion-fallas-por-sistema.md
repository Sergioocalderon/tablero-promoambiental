# Nueva sección: "Fallas por sistema principal" (drill-down general -> particular)

**Fecha:** 2026-09-18
**Archivo:** `_build_dashboard_fallas/dashboardAnalisisFallas.js`
**Versión:** `config.json` 1.0 → 1.1 (feature nueva + cambio de comportamiento
en filtros existentes, ver "Cross-filtering del drill-down" más abajo) —
convención adoptada a pedido del usuario: subir el número de versión en cada
cambio real, para poder identificar en Geotab qué build está montado.

## Contexto

Se pidió anexar al dashboard una vista de "radiografía por sistema" que
permita ir de lo general (volumen de fallas por sistema) a lo particular
(códigos SPN/FMI de ese sistema, o de un vehículo puntual), sin romper la
consistencia visual ni los patrones ya establecidos del ecosistema de
add-ins (ver `proyecto_addins_mygeotab_arquitectura` en memoria): sin
modales, mismo componente de tabla ya existente, mismo Chart.js, misma
paleta de marca.

## Cambios

1. **Taxonomía de sistemas generalizada.** `SISTEMAS_CRITICOS` (array de
   arrays de palabras clave, solo para el booleano "es crítico") se
   reemplaza por `SISTEMAS` (9 categorías: Motor, Frenos, Dirección,
   Embrague, Transmisión, Sist. Eléctrico, Postratamiento, Neumáticos/Eje,
   HVAC) + `SISTEMAS_CRITICOS_NOMBRES` (los 4 que siguen marcando un
   vehículo como Crítico). `resolverSistemaPrincipal(nombreDiagnostico)` es
   ahora la única función que clasifica por sistema; `esFallaSistemaCritico`
   se deriva de ella en vez de tener su propia lista de palabras clave
   duplicada — evita repetir el bug real del 2026-09-15 (palabra clave
   agregada en un lado y olvidada en el otro). Regla de negocio respetada:
   Embrague sigue siendo una entrada independiente, nunca agrupada bajo
   Transmisión.
   - La lista de exclusiones (`EXCLUSIONES_SISTEMA_CRITICO`) ahora solo
     bloquea los 4 sistemas críticos, no la clasificación general — así
     "motor del ventilador" no marca el vehículo como Crítico, pero sigue
     apareciendo en el gráfico bajo "HVAC" en vez de perderse del desglose.

2. **`agregarPorSistema` / `filtrarGruposPorSistema`** (junto a
   `agregarPorCodigo`): agregación de episodios por sistema y el subconjunto
   de grupos de un sistema puntual, mismo patrón ya usado para vehículos/códigos.

3. **Gráfico "Fallas por sistema"** (`construirGraficoSistemas`): barras
   horizontales Chart.js (no treemap — se prioriza comparar magnitudes
   exactas de un vistazo, mismo criterio que ya descartó el apilado por
   criticidad en el refactor del 2026-09-12). Color `T.color.ink` (azul
   marino), deliberadamente distinto del verde de "Top vehículos" para que
   ambos gráficos no se confundan. Clic en una barra selecciona el sistema
   (pasa a `T.color.primaryDark`, el resto se atenúa) y dispara el drill-down.

4. **Drill-down sin modal**: al seleccionar un sistema aparece debajo del
   gráfico una tabla de detalle SPN/FMI (reutiliza `construirTablaSecundaria`,
   tope 15 filas con nota "top 15 de N") + un chip "← Ver todos los
   sistemas" para volver. Estado (`sistemaSeleccionado`) se resetea al
   cambiar cualquier filtro o el rango de fechas, pero NO dentro de
   `aplicarFiltrosYRenderizar` (esa función también se dispara al hacer
   clic en una barra, resetear ahí deshacía la selección en el mismo instante).

5. **Selector de vehículo** (`construirBarraFiltros`): input de texto +
   `<datalist>` sobre "nombre - placa", mismo patrón de filtrado en memoria
   que Ciudad/Tipo (cero llamadas nuevas a Geotab). Recalcula automáticamente
   el gráfico de sistemas porque este se alimenta del mismo `gruposFiltrados`
   que ya respeta el filtro. Se limpia solo si el vehículo tipeado ya no
   aparece en un rango nuevo (mismo criterio "sigueValida" de Ciudad/Tipo).

6. **Ubicación en el layout**: la nueva sección se inserta a todo el ancho
   entre la fila de gráficos existente (Tendencia + Top vehículos + Activas/
   Inactivas) y la fila de tablas Top 5 — mantiene la lectura de arriba hacia
   abajo (panorama -> por sistema -> detalle nominal).

## Cross-filtering del drill-down (ajuste posterior, mismo día)

A pedido del usuario: al seleccionar un sistema, el resto del dashboard debía
"integrarse" con ese filtro, y en particular quería poder ver la **tendencia**
de ese sistema específico (¿mejorando o empeorando?) — antes, el drill-down
solo mostraba una tabla de códigos aparte; el resto de KPIs/tendencia/Top
vehículos/Activas-Inactivas seguía sumando TODOS los sistemas sin importar
la selección.

- `aplicarFiltrosYRenderizar` ahora calcula `gruposParaResto` (y
  `vehiculosOrdenadosParaResto`, recalculado con `agregarPorVehiculo` — no
  solo filtrado, para que `episodios`/`criticidad` también queden acotados
  al sistema) cuando hay un `sistemaSeleccionado`. Este subconjunto alimenta
  KPIs, resumen narrativo, Top vehículos, tabla de códigos, Activas/Inactivas
  y, sobre todo, la **serie temporal** — por lo que el gráfico de tendencia
  ya existente (con su veredicto "Mejorando/Empeorando" del refactor
  2026-09-12) automáticamente responde la pregunta del usuario para el
  sistema elegido, sin necesitar un gráfico nuevo.
- El gráfico "Fallas por sistema" en sí sigue alimentándose del universo SIN
  ese filtro (`gruposFiltrados`, pasado aparte a `renderizarResultados` como
  `gruposTodosLosSistemas`) — así siempre muestra todos los sistemas para
  poder comparar y cambiar de drill-down sin perder el panorama.
- Los títulos de "Tendencia de episodios en el tiempo", "Top N vehículos con
  más fallas" y "Activas vs. inactivas" agregan el sufijo "— Sistema: X"
  cuando hay drill-down activo, para que no se lean por error como datos de
  toda la flota.
- El indicador "vs. periodo anterior" (KPIs y resumen narrativo) se sigue
  ocultando con cualquier filtro activo, ahora incluyendo el drill-down de
  sistema — comparar un total de un sistema contra el total SIN filtrar de
  ayer no sería válido (mismo criterio ya aplicado a ciudad/tipo/criticidad).

## Pendiente de verificar manualmente

No hay test suite. Empaquetar y montar el zip en Geotab para confirmar:
- Que el gráfico de sistemas muestre categorías creíbles con datos reales
  (en particular que "Embrague" aparezca separado de "Transmisión").
- Que el selector de vehículo recalcule el gráfico de sistemas sin
  disparar una consulta nueva a Geotab (Network tab).
- Que el clic en una barra abra el detalle SPN/FMI y el botón "← Ver todos
  los sistemas" lo cierre correctamente.
- Que cambiar de rango de fechas, ciudad, tipo o criticidad cierre
  automáticamente el drill-down abierto.
