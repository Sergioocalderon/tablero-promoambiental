# Segunda corrección de "API calls quota exceeded": agrupación por cercanía temporal

Fecha: 2026-09-23
Versión: 1.9 → 1.10

## Qué cambió

Se investigó con datos reales: la regla tiene **47 vehículos** en alcance,
con un promedio de **~168 candidatos por vehículo** en 2 semanas (7,910
candidatos crudos en total). No era un solo vehículo excepcional
(1159-NWY131) — varios vehículos tienen volumen similar, así que la ventana
[min,max] "una por vehículo" (aunque ya era mejor que la ventana global
original) seguía abarcando varios días para MUCHOS vehículos a la vez, y el
primer fallback por bloques fijos (8h/24h) no alcanzaba a compensarlo: la
suma de llamadas de fallback para ~15-20 vehículos truncados simultáneamente
volvía a chocar con el límite de Geotab.

Cambios:
- `confirmarPtoCercano` y `agregarPicoRpm` ahora agrupan los
  candidatos/eventos de cada vehículo por **cercanía temporal real**
  (`agruparPorCercania`, `VENTANA_AGRUPACION_MS = 2h`): dos candidatos caen
  en la misma "racha" si el hueco entre ellos es de 2 horas o menos. Se pide
  UNA ventana de StatusData por racha, no una única ventana [min,max] que
  también abarca los huecos vacíos entre rachas (madrugadas, fines de
  semana sin operación). Esto evita desde el arranque la consulta
  grande-y-condenada-a-truncarse, en vez de detectarla después y reintentar.
- El fallback por bloques de tiempo fijos (de la corrección anterior) se
  mantiene como red de seguridad de ÚLTIMO recurso, solo para el caso raro
  de una racha individual que aun así se pase del límite (un vehículo que
  literalmente no para en 18+ horas seguidas).
- `obtenerTotalesPeriodo` (comparación con el periodo anterior, solo para
  las flechas de tendencia de los KPIs) ya no corre el pipeline completo
  -- se eliminó `agregarPicoRpm` y `resolverVehiculos`/`filtrarPorUmbralMercedes`,
  que ahí solo se usaban para aplicar el filtro de Mercedes a un total que
  de todas formas es aproximado. Se acepta una sobreestimación mínima y
  simétrica entre ambos periodos comparados (no afecta los datos mostrados
  ni tabulados, solo la flecha ▲▼).
- `obtenerInfoVehiculos` pasó de un `Get Device` POR VEHÍCULO (~47 llamadas)
  a UN solo `Get Device` sin filtro, indexado en memoria (`obtenerCatalogoDevice`,
  cacheado).

## Por qué

El fix anterior (bloques de tiempo fijos) resolvió el caso de un solo
vehículo truncado, pero el usuario reportó que el error "API calls quota
exceeded" seguía apareciendo en la carga más simple (rango por defecto, sin
filtros). Investigar con datos reales mostró que el problema era de escala
de flota (muchos vehículos con volumen alto), no de un caso aislado.

## Archivos

- `dashboardAnalisisPTO.js` — nuevas funciones `agruparPorCercania`,
  `construirVentanasPorVehiculo`, `consultarStatusDataAgrupado`,
  `obtenerCatalogoDevice`; `confirmarPtoCercano`/`agregarPicoRpm` reescritas
  sobre agrupación por cercanía; `obtenerTotalesPeriodo` aligerado;
  `obtenerInfoVehiculos` usa el catálogo cacheado.
- `config.json` — versión 1.9 → 1.10.
