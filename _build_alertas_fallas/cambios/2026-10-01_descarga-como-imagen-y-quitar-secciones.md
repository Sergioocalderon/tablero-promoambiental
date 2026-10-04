# Mini Expediente: descarga como imagen + quitar señales/historial

## Contexto

Pedido explícito del usuario tras la primera prueba real: "quita la
información innecesaria (Señales relacionadas, Historial reciente) y que al
descargar sea una imagen nítida para pasar por WhatsApp -- recuerda que esto
es para generar alertas." El caso de uso real es una alerta rápida, no un
informe completo.

## Qué se quitó

- Sección "Señales relacionadas (± 2 h alrededor del momento)" y toda su
  lógica (`construirLineaTiempoSenales`, las llamadas a StatusData/LogRecord
  que la alimentaban, `VENTANA_TIMELINE_HORAS`).
- Sección "Historial reciente del vehículo" y toda su lógica
  (`obtenerHistorialVehiculo`, `historialVehiculoCache`,
  `DIAS_HISTORIAL_EXPEDIENTE`).
- Las funciones se borraron por completo (no quedaron sin usar) -- también
  reduce las consultas a Geotab por expediente generado (2 llamadas menos).
- CSS asociado (`.bloque-secundario`, `.tabla-wrap`, `table.dt`) quitado de
  la plantilla.
- Controles de zoom del mapa (`zoomControl:false`) -- no tienen sentido en
  una imagen estática, y la referencia visual del usuario tampoco los tenía.

## Qué se agregó: descarga como imagen

El botón "Generar expediente" ya no descarga un `.html` -- descarga un
`.png`. Mecanismo:

1. Se arma el mismo HTML de siempre (plantilla + mapa Leaflet/CARTO con su
   propio script de inicialización).
2. Se renderiza en un `<iframe>` oculto (posicionado fuera de la pantalla,
   NO con `display:none`/`visibility:hidden` -- esas propiedades pueden
   hacer que el navegador no pinte el contenido de verdad, y el mapa
   necesita pintarse para poder capturarlo).
3. Se espera a que el mapa termine de cargar: `SCRIPT_INIT_MAPA` (el script
   que corre dentro del iframe) marca `window.__mapaListo = true` en toda
   salida posible -- con datos, sin datos, con error, o cuando el evento
   `load` de las teselas de CARTO dispara. Respaldo de 5s por si ese evento
   nunca llega. El código del add-in revisa esa bandera cada 150ms, con un
   tope duro de 7s para no quedarse esperando para siempre.
4. Se captura con **html2canvas** (CDN, `cdnjs.cloudflare.com/.../html2canvas/1.4.1`,
   URL verificada en vivo) a `scale:2` (nitidez pedida explícitamente) con
   `useCORS:true`.
5. El tile layer de Leaflet se configuró con `crossOrigin:true` -- requisito
   del navegador para que html2canvas pueda leer los píxeles de las teselas
   de mapa sin que el canvas quede "tainted" (bloqueado por seguridad de
   origen cruzado).
6. El canvas resultante se exporta a PNG (`canvas.toBlob`) y se dispara la
   descarga con el mismo patrón de Blob+link que ya usaba el HTML.

`alertasFallas.html` ahora también carga html2canvas por CDN (mismo
precedente que SheetJS/Leaflet).

## Verificación

- Balance de paréntesis/llaves/corchetes: mismo desbalance preexistente de 1
  paréntesis (regex literals con caracteres de agrupación dentro de clases
  de caracteres, ya documentado en changelogs anteriores) -- llaves y
  corchetes balanceados, sin nuevos desbalances introducidos.
- `PLANTILLA_EXPEDIENTE_EMBEBIDA` decodifica byte a byte igual al HTML
  fuente actualizado (4914 caracteres, confirmado con script puntual).
- URL de html2canvas verificada en vivo con `curl -I` → 200.
- 0 referencias colgantes a las funciones/constantes quitadas (confirmado
  con grep) -- las únicas coincidencias restantes son el comentario propio
  que explica qué se quitó.
- `AlertasPorSeveridad_addin.zip` regenerado y copiado a Descargas,
  verificado con `zipfile`: exactamente `config.json` (v1.3) +
  `alertasFallas.html` + `alertasFallas.js`.

## Pendiente

- Probar contra MyGeotab real que la imagen se descargue bien y se vea
  nítida (no se pudo probar la captura de canvas/CORS de CARTO con tiles
  reales desde este entorno -- es la pieza de mayor riesgo de este cambio,
  por la combinación iframe + CORS + timing asíncrono de los tiles).
- Si el tope de 7 segundos resulta corto en una conexión lenta, es un solo
  número para ajustar (`MAXIMO_MS` en `capturarYDescargarImagen`).
