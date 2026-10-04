# Desglose por ciudad en el panel Activas vs. inactivas

**Fecha:** 2026-09-16
**Archivo:** `_build_dashboard_fallas/dashboardAnalisisFallas.js`

## Pedido

"Anexarle el tema de saber de qué ciudad son" al panel "Activas vs.
inactivas" — quería ver, sin tener que ir cambiando el filtro global de
Ciudad una por una, cuántas fallas activas/inactivas hay en cada ciudad de
un vistazo.

## Cambio

- Nueva función `contarActivasInactivasPorCiudad(grupos, infoVehiculos)`:
  mismo conteo que `contarActivasInactivas`, pero agrupado por
  `infoVehiculos[idVehiculo].ciudad` (con fallback a `'Sin ciudad
  asignada'`, nunca se oculta un grupo por no tener ciudad resuelta).
  Ordenado por total descendente (ciudad más afectada primero).
- Nueva función `crearFilaCiudad`: una fila compacta por ciudad (nombre +
  mini-barra verde/gris + conteo "X act. / Y inact."), mismo lenguaje visual
  que la barra principal del panel a menor escala.
- `construirBarraResueltas` ahora recibe `porCiudad` y, si hay **más de una
  ciudad** en los datos filtrados, agrega el desglose debajo del conteo
  total (separado por una línea divisoria). Si el usuario ya filtró por una
  sola ciudad, el desglose no se muestra — sería redundante con el total de
  arriba.
- Se encadenó `porCiudad` a través de `aplicarFiltrosYRenderizar` →
  `renderizarResultados` → `construirSeccionGraficos` →
  `construirBarraResueltas`, calculado sobre `gruposFiltrados` (mismo
  universo de datos que ya usan los KPIs y las gráficas, consistencia
  analítica de siempre).

## Pendiente de verificar manualmente

No hay test suite. Verificar en Geotab:
1. Sin filtro de ciudad puesto, confirmar que aparece una fila por cada
   ciudad con actividad en el rango, y que los números suman el total de
   arriba.
2. Con un filtro de ciudad puesto, confirmar que el desglose desaparece (no
   tiene sentido mostrar 1 sola fila redundante).
3. Caso "Sin ciudad asignada": si hay vehículos sin ciudad resuelta,
   confirmar que aparecen como su propia fila en vez de perderse del conteo.
