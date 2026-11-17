# Seguimiento de Velocidad v1.1 — rediseño: las alarmas primero

**Fecha:** 2026-11-13
**Versión:** 1.1 (antes 1.0)
**Archivos:** `seguimientoVelocidad.parte.js`, `config.json`. Sin cambios en `logica.js` ni `datos.js`: los criterios y la lectura de datos son los mismos.

## Por qué
La v1.0 ponía al mismo nivel cuatro tarjetas idénticas ("0 sobre el límite", "63 sin señal"), una lista de toda la flota con 22 vehículos a 8 km/h y un banner que repetía lo mismo que la tabla. Se rehízo con las pautas de la skill `frontend-design` (guía leída del marketplace local; la skill no está instalada): estructura que informa, un solo elemento memorable, textos en oraciones, movimiento mínimo.

## Qué cambió
- **Zona principal = alarmas.** Una fila por vehículo en alarma, ordenadas por gravedad: nombre y ciudad, velocidad en grande, medidor, y una frase ("Severidad media. Lleva 1 min 51 s sobre el límite, con un pico de 68 km/h. Última lectura hace 1 min 27 s.").
- **Medidor** (el elemento memorable): la escala dibuja los criterios de la regla. Gris hasta 50 km/h, luego baja (ámbar), media (naranja) y alta (roja) desde 70. Marcador oscuro = velocidad ahora, marcador claro = pico.
- **"Acaban de pasar el límite":** los que aún no suman 30 s, con una barra de "N de 30 s".
- **Sin alarmas:** mensaje en calma con el vehículo más rápido ("El más rápido ahora es X, a N km/h").
- **El resto, plegado:** "En movimiento, bajo el límite (N)" y "Sin movimiento o sin señal (N)", con tabla simple. Se recuerda cuáles estaban abiertos entre refrescos.
- Se quitan las 4 tarjetas, el banner repetido y el selector "Mostrar". Se mantienen Ciudad, "Sonar desde la severidad", el botón de sonido y "Actualizar ahora".
- Textos en minúsculas y oraciones; se quitan las mayúsculas de los encabezados y los puntos medios. Números tabulares.
- Un solo movimiento: el punto de las alarmas pulsa. Se apaga si el equipo tiene activado "reducir movimiento".
- La nota larga de abajo pasa a un desplegable "Cómo se calcula".

## Qué se probó
Renderizado en Chrome headless con datos reales de la flota (sin alarmas inventadas y con un escenario de ejemplo de 4 vehículos), 0 errores de consola. Lógica sin cambios (14 casos en Node de la v1.0).

## Qué NO
No probado dentro de MyGeotab. El audio sigue sin verificarse en el iframe.
