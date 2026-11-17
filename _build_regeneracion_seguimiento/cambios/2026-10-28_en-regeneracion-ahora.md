# Sección "En regeneración ahora" (vehículos que regeneran sin lámpara)

**Fecha:** 2026-10-28
**Versión:** 1.6 → 1.7
**Archivos:** `seguimientoRegeneracion.parte.js`; piezas comunes `_build_regeneracion_comun/datos.js` (la 5.ª señal es
opcional) y `logica_1_hollin.js` (constante del diagnóstico); `config.json`. El `.js`, el `.html` y el zip se generan con
`herramientas/construir_addins_regeneracion.py`.

## Qué se vio

El 1148-NWW623 (Foton Auman, Bogotá) apareció en el mapa de MyGeotab con la excepción "R_REGENERACIÓN ACTIVA DEL FILTRO DE
PARTÍCULAS DIÉSEL" (28-oct 20:59), pero el tablero no lo mostraba.

## Diagnóstico (datos reales de Geotab)

El 1148 sí estaba en el alcance (84 vehículos). A las 20:59 se encendió el diagnóstico de "regeneración activa" y se mantuvo
hasta las 23:43; el hollín subió de 75 % a 101 % y desde las 21:00 bajó sin parar hasta 79 %. **La lámpara y el interruptor
manual nunca se encendieron**: fue una regeneración automática. El tablero solo cubría "lámpara encendida" y "hollín sobre
el umbral de la marca" (Foton: 95 %), así que desde las 21:59 el 1148 no cumplía ninguna condición. El aviso por Telegram
sí lo cubre (usa ese mismo diagnóstico); el tablero no.

## Qué cambió

- Nueva sección **EN REGENERACIÓN AHORA** (punto azul) entre "Regenerar ya" y "Próximos": vehículos con el diagnóstico
  encendido ahora, con o sin lámpara. Columnas: estado, desde, duración, hollín (antes → ahora), cuánto bajó, última
  lectura y acción (imagen para WhatsApp). Un clic abre el expediente.
- **Estados**, con el criterio del aviso por Telegram (`reporte_regeneracion_ciudades.py --regen-activa`):
  - *En curso:* regenerando; si el hollín ya bajó >= 10 puntos lo dice y aclara que no hace falta avisar al conductor.
  - *Sin efecto:* a los 150 min el hollín no bajó 10 puntos.
  - *Prolongada:* más de 8 h seguidas (`UMBRAL_SESION_PROLONGADA_HORAS`): no completa o el testigo está pegado.
  - *Sin lecturas:* el testigo quedó en "activo" pero no llegan lecturas hace más de 90 min (motor apagado o pegado); la
    duración llega hasta su última lectura y el titular lo cuenta aparte.
- Un vehículo que regenera **ya no figura como "próximo"** (evita contarlo dos veces). Un vehículo con regeneración activa
  tampoco cuenta como "sin señal".
- **Filtro de estado:** nueva opción "En regeneración (n)"; el filtro de base muestra "N regenerar · N regenerando · N próximos".
- **Mensaje de WhatsApp:** nuevo bloque "🔥 EN REGENERACIÓN — testigo activo" (el formato original solo tenía lámpara y
  próximos; este bloque es una ampliación del tablero, `reporte_regeneracion_ciudades.py` no lo trae).
- **Expediente:** tercer caso (regeneración en curso) con tarjetas de duración, inicio, hollín (99 % → 81 %) y último
  registro; la gráfica dibuja una **franja azul por cada sesión de regeneración activa** de las últimas 48 h (en el 1148 se ven
  4); la leyenda y la imagen para WhatsApp la incluyen. Si hay lámpara y regeneración a la vez, el expediente es el de la
  lámpara y añade una nota con el inicio del testigo.
- "Ver reglas de umbral" explica también estas reglas.

## Detalles que salieron de los datos reales

- "Ya venía encendido" (`antes del …`) solo si la racha empieza pegada al borde de la ventana de 48 h, como en el aviso de Telegram.
  Un vehículo parado cuya primera lectura es posterior no se marca como "antes".
- Las sesiones recién iniciadas dicen que el hollín llega cada ~30 min y se evalúa a los 150 min, en lugar de "no hay lecturas".
- "88 % → 88 %" se muestra como "88 %".
- La caída usa las lecturas de hollín ya limpiadas (techo 199 % y saltos bruscos), las mismas de la gráfica; el aviso de
  Telegram descarta >= 150 %, así que en casos con hollín muy alto pueden diferir.

## Comunes (Análisis y Reportes)

`cargarSenales` ahora pide la señal `regen` solo si viene en `rangos`; Análisis y Reportes no la piden, así que su
comportamiento no cambia (se comprobó que ambos siguen cargando). Sus zips se regeneran con el mismo código, sin subir
versión.

## Verificación

Chromium con 4 días de datos reales de las 5 señales de toda la flota, reproduciendo el instante de la captura (28-oct 23:41):
el 1148 sale "En curso · 2 h 42 min · 99 % → 81 % · bajó 18 pts", no figura como próximo, el mensaje de WhatsApp y el expediente
(imagen 2160×2542 px) lo incluyen. Se abrieron los 15 expedientes de dos instantes distintos sin `NaN`/`undefined` y sin errores
de consola. **No probado dentro de MyGeotab.**
