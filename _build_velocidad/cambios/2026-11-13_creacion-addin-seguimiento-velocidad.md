# Seguimiento de Velocidad v1.0 — creación del add-in

**Fecha:** 2026-11-13
**Versión:** 1.0
**Archivos:** `logica.js`, `datos.js`, `seguimientoVelocidad.parte.js`, `config.json` (el `.js` y `.html` se generan con `herramientas/construir_addin_velocidad.py`; el kit de diseño sale de `_build_regeneracion_comun/ui.js`)

## Origen
Tarjeta de Trello "Montar addin de seguimiento de velocidad con alarma" (sin descripción). Decisiones del usuario: **en vivo**, **alarma solo en pantalla**.
Criterio: `Paquete_Monitor_Habitos_2026-11-13.zip` (app de Hábitos, solo lectura), regla `V_VELOCIDAD MAYOR A 50 KM/H`.

## Qué hace
- Lee cada 15 s la velocidad del motor en carretera (`DiagnosticEngineRoadSpeedId`) de toda la flota Promoambiental (una consulta de los últimos 5 min, ~1.500 filas medidas) y el estado de comunicación (`DeviceStatusInfo`).
- Estados: **Alarma** (más de 50 km/h durante 30 s seguidos o más), **Sobre el límite** (aún sin 30 s), **En movimiento**, **Sin movimiento** y **Sin señal**.
- Severidad por el pico de la racha, corte [mínimo, máximo): BAJA 50 a <60, MEDIA 60 a <70, ALTA 70 o más (los rangos de la regla).
- Banner rojo con los vehículos en alarma, 4 tarjetas, tabla ordenable, filtros por ciudad y por "mostrar".
- Sonido (WebAudio, 3 pitidos) cuando un vehículo ENTRA en alarma o sube de severidad; por defecto desde MEDIA. Hay que pulsar "Activar sonido" (el navegador exige un clic).

## Por qué velocidad del motor y no GPS
Se midió el 2026-11-13 con 14 vehículos en movimiento: GPS (`DeviceStatusInfo`) frente a motor, diferencia media absoluta de 7,7 km/h. La regla usa la velocidad del motor; el tablero usa la misma.

## Cómo se calcula el tiempo sostenido
Sin estado entre refrescos: de las lecturas de los últimos 5 min toma la racha final de lecturas > 50 km/h y mide de la primera a la última. Subestima como mucho un intervalo de muestreo (unos segundos). Si la racha llega al borde de la ventana se muestra "≥".

## Qué se probó
- Lógica pura: 14 casos en Node (límite exacto 50, cortes 60/70, racha terminada, racha anterior corta, lectura vieja).
- Pantalla: renderizada en Chrome headless con datos reales de la flota y una API simulada; 0 errores de consola. Escenario "demo" con lecturas inventadas para ver varias alarmas.

## Qué NO se probó / límites
- No probado dentro de MyGeotab. No se sabe si el iframe permite audio.
- Solo suena y se ve con la pantalla abierta y visible (Chrome frena las pestañas ocultas). Los excesos con la pantalla cerrada quedan en las reglas de Geotab.
- No incluye la regla de 30 km/h de la geocerca Doña Juana (necesita saber si el vehículo está dentro de la zona).
- No muestra conductor (la mayoría de los registros son `UnknownDriverId`).
- Sin aviso a Telegram (decisión del usuario).
