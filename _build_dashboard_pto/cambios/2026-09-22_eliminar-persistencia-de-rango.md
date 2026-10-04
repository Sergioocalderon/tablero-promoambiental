# Eliminar persistencia de rango en localStorage — siempre carga rápido (2 semanas)

Fecha: 2026-09-22
Versión: 1.1 → 1.2

## Qué cambió

Se quitó por completo la persistencia del rango de fechas en `localStorage`
(`CLAVE_LOCALSTORAGE`, `cargarRangoGuardado()`, `guardarRango()`). La apertura
del add-in (`initialize`) ahora SIEMPRE prefillea los campos Desde/Hasta con
`rangoPorDefecto()` (últimas 2 semanas), sin importar qué rango se haya
analizado la última vez.

Los campos siguen editables y el botón "Analizar rango" sigue permitiendo una
consulta puntual con cualquier rango — simplemente ya no se recuerda entre
aperturas del add-in.

## Por qué

El usuario reportó una anomalía de carga lenta por "tantos datos iniciales".
Causa real: si la última consulta manual (`Analizar rango`) había sido un
rango grande, ese rango quedaba guardado en `localStorage` y se recargaba
automáticamente en la siguiente apertura del add-in — disparando de nuevo el
pipeline más pesado del ecosistema (StatusData de RPM de alta resolución +
PTO por vehículo, además DUPLICADO porque siempre se pide también el periodo
anterior para la comparación de KPIs).

Pedido explícito: "dejemos que siempre haga la comparación de dos semanas de
la actual y la anterior... para que cargue más rápido" — se aplicó
puntualmente a este add-in (el de fallas NO se tocó, quedó igual que antes).

## Archivos

- `dashboardAnalisisPTO.js` — se eliminaron `CLAVE_LOCALSTORAGE`,
  `cargarRangoGuardado()`, `guardarRango()` y sus llamadas; `construirEncabezado`
  ahora usa `rangoPorDefecto()` directo.
- `config.json` — versión 1.1 → 1.2.
