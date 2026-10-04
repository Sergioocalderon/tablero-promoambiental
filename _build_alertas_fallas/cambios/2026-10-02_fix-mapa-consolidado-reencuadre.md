# Fix: mapa consolidado mostraba teselas chicas en una esquina, con los marcadores fuera

## Contexto

El usuario mostró una captura real del Expediente Consolidado: 3 marcadores
visibles en distintas posiciones del contenedor, pero las teselas del mapa
solo cargaron en un recuadro chico centro-derecha -- mismo síntoma visual
que el bug ya corregido en el mapa de un solo código, pero en el mapa
multi-marcador nuevo.

## Diagnóstico

El fix anterior (mapa de un solo código) resolvía el problema de que
Leaflet medía mal el contenedor al crearse, llamando `invalidateSize()`
ANTES de agregar la capa de teselas -- funcionaba porque ese mapa nunca
vuelve a mover la vista después.

El mapa consolidado SÍ necesita mover la vista otra vez: después de
agregar todos los marcadores, llamaba a `reencuadrar()` (`fitBounds()`
sobre todos los marcadores) para que entraran todos en el encuadre. El bug
real: `reencuadrar()` corría **después** de haber agregado la capa de
teselas -- ese cambio de encuadre dispara una segunda carga asíncrona de
teselas (para la nueva área visible) que el código nunca esperaba: el
evento `'load'` de la capa de teselas ya se había disparado para el
encuadre VIEJO (chico, de un solo punto), así que `window.__mapaListo` se
marcaba como `true` antes de que las teselas del encuadre nuevo
terminaran de llegar -- html2canvas capturaba el mapa a medio cargar.

## Fix

Se reordenó la secuencia: ahora los bounds finales se calculan ANTES de
tocar Leaflet (`L.latLngBounds(puntos...)`), se aplican con
`fitBounds()`/`setView()` sobre el mapa recién creado, y **recién
después** se agrega la capa de teselas -- la vista nunca vuelve a cambiar
una vez que las teselas ya se empezaron a pedir, así que una sola espera
del evento `'load'` alcanza (no hace falta una segunda espera ni un
segundo `invalidateSize()`, que de hecho se quitó de `marcarListo()` a
propósito para no reintroducir el mismo riesgo).

## Verificación

- Balance de paréntesis/llaves/corchetes de la función reescrita, comparado
  aislado ANTES vs DESPUÉS del cambio (script puntual): 44/44 paréntesis,
  20/20 llaves, 12/12 corchetes en la versión vieja; 40/40 paréntesis,
  20/20 llaves, 10/10 corchetes en la nueva -- ambas perfectamente
  balanceadas en aislado, confirmando que el cambio no introdujo un
  desbalance real (el +1 que sigue marcando el verificador simple de la
  sesión contra el archivo completo es el mismo falso positivo ya conocido
  del regex Unicode en `quitarAcentos`/`slug`, no algo nuevo).
- `AlertasPorSeveridad_addin.zip` regenerado y copiado a Descargas:
  `config.json` (v1.12) + `alertasFallas.html` + `alertasFallas.js`.

## Pendiente

Confirmar con un caso real (vehículo con varios códigos en ubicaciones
distintas, como el de la captura) que esta vez el mapa carga completo con
todos los marcadores sobre calles reales.
