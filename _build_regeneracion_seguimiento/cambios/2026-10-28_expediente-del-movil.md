# Expediente del móvil (modal oscuro con gráfica de hollín)

**Fecha:** 2026-10-28
**Versión:** 1.0 → 1.2 (se salta la 1.1: ese número ya lo usan los zips `*_sin_restriccion` de prueba)
**Archivos:** `seguimientoRegeneracion.parte.js` (nueva sección "EXPEDIENTE DEL MÓVIL"), `config.json`;
el `.js`, el `.html` y el zip los genera `herramientas/construir_addins_regeneracion.py`.

## Qué hace

Un clic en una fila de "REGENERAR YA" o "PRÓXIMOS" (o en el nombre del vehículo, que ahora es un botón
alcanzable con el teclado) abre el **Expediente del móvil**, a partir del boceto del usuario:

- Cabecera con "Datos al dd/mm/aaaa hh:mm · ciudad", **Imprimir PDF** y **Cerrar** (también Esc o clic en el fondo).
- Banda del móvil (`MÓVIL 1148 · NWW623`), chip de estado (Taller, Avisar, Escalar… o PRÓXIMO) y marca.
- Título de la situación, **"Qué hacer"** (el mismo texto del tablero) y, si aplica, desde cuándo está activo el interruptor manual.
- Tarjetas: lámpara encendida → duración observada (con horas de motor), inicio, último registro y hollín;
  próximo → hollín actual, umbral de la marca y último registro.
- **Gráfica de hollín de las últimas 48 h** dibujada en SVG propio (sin librerías): bandas BAJA / MEDIA / ALTA,
  línea del umbral de la marca, franja de lámpara encendida, regeneraciones detectadas, interruptor manual,
  **línea discontinua en los intervalos sin lecturas** y cursor con la lectura más cercana.
- ~~Imprimir PDF~~ (v1.2): se reemplazó en la v1.3 por la imagen para compartir en WhatsApp, ver
  `2026-10-28_imagen-para-whatsapp.md`.

No hace consultas nuevas a Geotab: usa las señales que el tablero ya descargó (`datosCache.senales`).
El expediente es una foto de los datos al abrirlo; para ver datos nuevos hay que cerrarlo y volver a abrirlo.
Al salir del add-in el modal se cierra solo.

## Criterios que conviene conocer

- **Banda ALTA = 125 %:** es el valor hacia el que se enciende la lámpara (el mismo del mensaje de Telegram);
  sirve para pintar la banda, no es un umbral de Geotab. BAJA llega hasta el umbral de la marca (International 80 %,
  Foton 95 %, Kenworth 100 %) y MEDIA hasta 125 %.
- **Intervalo sin lecturas = más de 45 min.** El hollín llega con un latido de 30 min (medido en 117.000 lecturas
  reales, el 30 % de los intervalos son de 30,0 min); solo el 3 % supera 45 min.
- **Lecturas ≥ 150 %:** el tablero las descarta para "próximos". Si la gráfica tiene una (p. ej. 182 % en 3094-GVT509),
  la tarjeta la muestra como "Última lectura de hollín" aclarando que no se usa para "próximos", para que tarjeta y
  gráfica no se contradigan.
- La gráfica solo cubre 48 h porque es lo que el tablero descarga de hollín; la lámpara sí se ve hasta 14 días en las
  tarjetas de duración e inicio.
- No se muestra "empresa": el tablero no resuelve ese dato (solo ciudad y marca) y no se inventa.

## Verificación

Chromium con los datos reales volcados de Geotab (30 días): 3 vehículos en las tablas (1 con lámpara, 2 próximos); se
abrieron los 3 expedientes sin textos `NaN`/`undefined`; cursor, Esc, clic en el fondo, foco de vuelta al botón,
restauración del scroll del body, ventana imprimible y PDF generados; 0 errores de consola. **No probado dentro de MyGeotab.**
