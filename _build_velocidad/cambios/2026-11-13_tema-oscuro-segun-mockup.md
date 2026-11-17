# Seguimiento de Velocidad v1.2 — tema oscuro según el mockup del usuario

**Fecha:** 2026-11-13
**Versión:** 1.2 (antes 1.1, tema claro)
**Archivos:** `seguimientoVelocidad.parte.js` (pantalla reescrita), `datos.js` (agrega latitud y longitud de `DeviceStatusInfo`), `config.json`. Sin cambios en `logica.js`: criterios y cálculo iguales.

## Origen
El usuario pasó una imagen de diseño (dashboard oscuro de centro de control) con su prompt. Se siguió esa estructura y los textos; el tema oscuro es el mismo de Seguimiento de Regeneraciones.

## Qué cambió
- Tema oscuro (fondo #131722), título "SEGUIMIENTO DE VELOCIDAD" en mayúsculas con reloj verde y subtítulo "Monitoreo en tiempo real de la flota".
- Controles con etiqueta pequeña sobre el valor; botón de sonido con borde verde y campana (amarilla apagada, verde activa); botón "Actualizar ahora" verde.
- Alarmas en tarjetas en cuadrícula (2 por fila en pantalla ancha) con borde y brillo del color de la severidad: punto que pulsa, "Severidad Alta/Media/Baja", nombre, ciudad, velocidad grande, medidor, píldoras y botón "Mapa".
- **Botón "Mapa" (nuevo):** abre en Google Maps la última posición que reportó el equipo (`DeviceStatusInfo`), en pestaña nueva; si no hay posición válida muestra "Sin posición". Pasar el cursor muestra la antigüedad de esa posición.
- "ACABAN DE PASAR EL LÍMITE (En alerta)": filas con velocidad amarilla, barra y "N de 30 s".
- Secciones plegadas con flecha: "En movimiento, bajo el límite (N)" y "Sin movimiento o sin señal (N)".
- El fondo oscuro llega hasta el borde inferior de la ventana de MyGeotab.

## Decisiones donde no se copió el mockup al pie de la letra
- **Medidor:** se mantienen las zonas escalonadas 50/60/70 (baja, media, alta) en vez de un degradado continuo, porque dibujan los criterios reales de la regla. El marcador de la velocidad es blanco (el negro del mockup no se ve sobre fondo oscuro).
- **Texto de la duración:** el mockup mezclaba "Lleva 30s + sobre el límite" y "Tiempo acumulado: 01m 51s". Se unificó: "Lleva 1 min 51 s sobre el límite" (con "al menos" si la racha ya venía desde antes de la ventana de lectura).
- Se agregó "Lectura hace N s" junto a las píldoras (la antigüedad del dato debe verse siempre).

## Qué se probó / qué NO
Renderizado en Chrome headless con datos reales de la flota y un escenario de ejemplo (3 vehículos con lecturas inventadas), 0 errores de consola; lógica sin cambios. NO probado dentro de MyGeotab: audio en el iframe y si el navegador permite abrir la pestaña del mapa desde ahí.
