# Fix: mapa bloqueado por política de OSM + bug de capitalización con tildes

## Contexto

Primera prueba real del Mini Expediente contra datos reales de Geotab (campo
"EMPRESA" y mapa del Mini Expediente). Aparecieron 2 bugs reales.

## Bug 1: mapa bloqueado ("Access blocked")

El servidor gratuito de teselas de OpenStreetMap (`tile.openstreetmap.org`)
rechazó las solicitudes con el mensaje "App is not following the tile usage
policy of OpenStreetMap's volunteer-run servers". Ese servidor es solo para
pruebas puntuales/bajo volumen, no para quedar embebido en una herramienta
que varias personas abren repetidamente (política real: ver
operations.osmfoundation.org/policies/tiles).

**Fix**: se cambió el tile layer de Leaflet a las teselas gratuitas de CARTO
(Voyager, `basemaps.cartocdn.com`), que sí están pensadas para este tipo de
uso embebido y no requieren API key. Misma cobertura geográfica (sigue
siendo datos de OpenStreetMap por debajo), solo cambia el servidor que sirve
las imágenes. Atribución actualizada para incluir a CARTO además de
OpenStreetMap (requisito de sus términos de uso).

## Bug 2: "EstaciónN De Transferencia Zipa"

`normalizarCiudad` (usada para el campo "Empresa" del expediente, entre
otros lugares) capitalizaba con `/\b\w/g` sobre el texto ya en minúsculas.
`\w` en JavaScript es ASCII puro -- no reconoce vocales con tilde como parte
de una palabra. Eso significa que "ó" cuenta como un carácter NO-palabra
para la expresión regular, así que la letra siguiente ("n" en "estación")
queda justo después de una "transición a no-palabra", y `\b\w` la vuelve a
capturar como si fuera el inicio de una palabra nueva -- de ahí la "N"
capitalizada de más.

**Fix**: se reemplazó esa línea por una llamada a `capitalizar()`, función
que ya existía en el mismo archivo y resuelve esto bien (divide por
espacios en vez de por `\b`, no tiene el problema de los acentos).

## Verificación

- Balance de paréntesis/llaves/corchetes: el verificador simple de la sesión
  sigue dando el mismo desbalance de 1 paréntesis que YA existía antes de
  este cambio (causado por literales de expresión regular con paréntesis/
  corchetes dentro de clases de caracteres, ej. línea 293 y las 2
  ocurrencias de `quitarAcentos`/`slug` con el rango Unicode de diacríticos
  -- no es nuevo, ya estaba documentado). Llaves y corchetes balanceados.
- `AlertasPorSeveridad_addin.zip` regenerado y copiado a Descargas,
  verificado con `zipfile`: exactamente `config.json` (v1.2) +
  `alertasFallas.html` + `alertasFallas.js`.
- No se instaló/probó de nuevo contra MyGeotab real dentro de esta tarea --
  el usuario ya tiene el zip actualizado para volver a probar.

## Pendiente

Confirmar visualmente (el usuario) que el mapa carga bien con CARTO en una
prueba real, y que "EstaciónN" ahora sale como "Estación" en el campo
Empresa.
