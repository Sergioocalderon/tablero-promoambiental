# Rango "en vivo" de 5 horas que avanza con el reloj

**Fecha:** 2026-09-15
**Archivo:** `_build_pto/sobreRevolucionPTO.js`

## Problema reportado

Con el candado de solicitudes superpuestas ya funcionando, "Actualizar" volvía
a traer datos correctamente, pero los campos **Desde/Hasta nunca avanzaban**
a la fecha/hora actual: se quedaban congelados en lo que decía la pantalla
cuando se abrió el addin (o lo último guardado en localStorage), sin importar
cuánto tiempo pasara ni cuántas veces se presionara "Actualizar". Esto viene
del fix anterior del bug de 2026-09-11 (`refrescarDatos` dejó de tocar los
campos de fecha a propósito, para no pisarle al usuario un rango histórico
armado con "Filtrar fechas") — pero terminó rompiendo el caso normal: sin un
rango histórico de por medio, tampoco había forma de que la ventana avanzara.

## Cambio

Se separan dos modos explícitos con la variable `modoHistorico`:

- **Modo en vivo (por defecto, `modoHistorico = false`)**: cada refresco
  (automático, `focus()`, o clic en "Actualizar") recalcula el rango como
  **las últimas `VENTANA_LIVE_HORAS` (5) terminando en el momento actual**,
  actualiza los campos Desde/Hasta en pantalla para que se vea que avanzaron,
  y lo guarda en localStorage.
- **Modo histórico (`modoHistorico = true`)**: se activa solo al presionar
  "Filtrar fechas". Mientras esté activo, ni el refresco automático ni
  `focus()` tocan los campos — mismo comportamiento que ya protegía el bug de
  2026-09-11.
- **"Actualizar" siempre vuelve a modo en vivo** (`modoHistorico = false`)
  antes de refrescar — es la forma explícita de decir "ya terminé de revisar
  el rango histórico, quiero ver lo actual otra vez".
- Nueva función `rangoLiveActual()` (últimas `VENTANA_LIVE_HORAS` horas hasta
  ahora), reemplaza el cálculo de "últimas 24h" que solo se usaba como
  fallback inicial.

## Comportamiento resultante

- Sin tocar nada, el addin siempre muestra los últimos 5 horas hasta el
  momento actual, avanzando en cada refresco automático (10 min) o clic en
  "Actualizar".
- "Filtrar fechas" sigue permitiendo fijar un rango histórico específico
  (ej. varios días atrás) sin que se lo pisen los refrescos automáticos.
- Un reload completo de la página (F5) vuelve siempre a modo en vivo, incluso
  si antes del reload se estaba en modo histórico — es un cambio de
  comportamiento intencional respecto a antes (donde el último rango
  guardado, histórico o no, se restauraba tal cual al recargar).

## Pendiente de verificar manualmente

1. Dejar el addin abierto varios minutos y confirmar que Desde/Hasta avanzan
   solos con cada refresco automático (10 min) sin tocar nada.
2. Usar "Filtrar fechas" con un rango de hace varios días, esperar 10+ min, y
   confirmar que el rango histórico NO se pisa solo.
3. Desde modo histórico, presionar "Actualizar" y confirmar que vuelve al
   rango en vivo de 5 horas.
