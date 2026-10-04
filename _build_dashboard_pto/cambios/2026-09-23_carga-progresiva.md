# Carga progresiva: el rango actual se muestra sin esperar al periodo anterior

Fecha: 2026-09-23
Versión: 1.5 → 1.6

## Qué cambió

`cargarYRenderizar` ahora renderiza el dashboard apenas el pipeline del
rango actual está listo (candidatos → PTO cercano → RPM pico → info de
vehículos), sin esperar a que termine también el pipeline del periodo
anterior (usado solo para las flechas de tendencia en los KPIs).

El periodo anterior se sigue pidiendo DESPUÉS, en el mismo orden secuencial
de siempre — **no se paralelizó** con el rango actual, porque eso fue
exactamente lo que causó el bug real "ServerStopped" documentado el
2026-09-17 (las dos pasadas completas del pipeline al mismo tiempo tumbaban
la sesión de Geotab). Lo único que cambió es que ya no bloquea la vista:
cuando el periodo anterior termina, actualiza las flechas de tendencia con
un segundo render liviano (recalcula sobre datos ya en memoria, no vuelve a
consultar Geotab).

Mientras el periodo anterior sigue en vuelo, aparece un aviso discreto
"⏳ Calculando comparación con el periodo anterior…" bajo los KPIs, para que
la ausencia de flechas de tendencia no se lea como "sin datos suficientes".

Los botones de rango siguen deshabilitados hasta que TERMINAN ambas
pasadas (mismo candado `cargaEnCurso` de siempre) — evita que una segunda
carga pesada se dispare mientras el periodo anterior todavía está en vuelo.

## Por qué

Pedido explícito del usuario tras preguntar cómo mejorar el tiempo de carga:
el usuario esperaba el doble del trabajo real (rango actual + periodo
anterior en serie) antes de ver cualquier dato, aunque el rango actual —lo
que realmente quiere ver— ya estuviera listo desde antes.

## Archivos

- `dashboardAnalisisPTO.js` — `cargarYRenderizar` renderiza el rango actual
  antes de pedir el periodo anterior; `construirKpis` agrega el aviso de
  "calculando comparación" mientras `datosCache.periodoAnteriorCargando`
  es `true`.
- `config.json` — versión 1.5 → 1.6.
