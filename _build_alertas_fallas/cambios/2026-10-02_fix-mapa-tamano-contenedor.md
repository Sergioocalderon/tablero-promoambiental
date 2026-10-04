# Fix: el mapa solo cargaba un recuadro chico de teselas, sin marcador ni polígono

## Contexto

El usuario mostró una captura real: el contenedor del mapa (220px de alto,
ancho completo de la tarjeta) aparecía casi todo gris, con solo un
rectángulo pequeño de teselas cargadas en el centro -- sin marcador ni
polígono de localidad visibles en ningún lado.

## Diagnóstico

Síntoma clásico de Leaflet: el `<script>` que inicializa el mapa corre
inline, durante el parseo del documento dentro del iframe oculto -- no hay
garantía de que el navegador ya haya terminado de calcular el layout real
del `div#mapa` en ese momento exacto. Si `L.map('mapa')` mide el contenedor
ANTES de que el layout esté asentado, Leaflet arranca con un tamaño
equivocado (normalmente más chico) y solo pide/dibuja teselas para esa área
reducida -- el resto del div visualmente correcto (220px × ancho de la
tarjeta) queda vacío porque Leaflet nunca "supo" que existía.

## Fix

- Todo el cuerpo de `SCRIPT_INIT_MAPA` ahora corre dentro de
  `setTimeout(fn, 0)` -- empuja la inicialización a la cola de tareas del
  navegador, después de que el layout pendiente del documento recién
  insertado ya se procesó.
- `mapa.invalidateSize()` se llama dos veces: apenas se crea el mapa (ANTES
  de agregar la capa de teselas, para que esta pida las teselas correctas
  desde el principio) y otra vez justo antes de avisar que el mapa está
  listo para capturar (por si el layout cambió entre la creación y el
  momento de la captura). Después de cada `invalidateSize()` se vuelve a
  centrar la vista (`setView`), porque invalidateSize puede correr el
  encuadre.

## Verificación

- Balance de paréntesis/llaves/corchetes: mismo desbalance preexistente ya
  documentado, sin cambios nuevos.
- `AlertasPorSeveridad_addin.zip` regenerado y copiado a Descargas:
  `config.json` (v1.9) + `alertasFallas.html` + `alertasFallas.js`.

## Pendiente

No se pudo probar en un navegador real desde este entorno -- es un fix
basado en un patrón bien conocido de Leaflet (contenedor medido antes de
tiempo), pero el usuario debe confirmar que esta vez el mapa carga completo
con marcador y polígono visibles.
