# Respaldo de geocodificación para ciudades sin localidad definida en Geotab

## Contexto

El campo "DÓNDE" solo resolvía localidad cuando el punto GPS caía dentro de
una geocerca "BOGOTÁ-X" configurada en Geotab -- para cualquier otra ciudad
de la flota sin esas zonas definidas, siempre salía "Localidad no
determinada". El usuario pidió evaluar un respaldo con un servicio de
mapas.

## Qué se agregó

`resolverLocalidadPorGeocoding(lat, lon)`: respaldo que se activa SOLO
cuando `resolverLocalidad` (la geocerca propia) no encuentra nada. Usa
BigDataCloud (`api.bigdatacloud.net/data/reverse-geocode-client`) -- gratis,
sin API key, con CORS habilitado para uso desde el navegador. Verificado en
vivo antes de integrarlo con coordenadas reales de Bogotá (devolvió "San
Cristóbal", coincide con la geocerca propia) y Cali (devolvió "Cali").

No da un polígono (solo el nombre de la localidad), así que en el mapa no
se dibuja ningún contorno cuando la localidad viene de acá -- se marca con
`origen:'geocoding'` y el expediente avisa explícitamente "Ubicación
aproximada (servicio externo, sin geocerca propia configurada para esta
ciudad)" en vez de mostrarlo con la misma confianza que una geocerca real.

Timeout de 4s (`AbortController`) para no colgar la generación del
expediente si el servicio está lento/caído -- cualquier falla (sin red,
timeout, respuesta rara) cae a `null`, mismo comportamiento que si
simplemente no se hubiera encontrado nada.

## Aviso de confiabilidad

Es el tercer servicio externo gratuito que usa este add-in (después de
OpenStreetMap y CARTO, que fallaron en producción). Se verificó
empíricamente antes de integrarlo, pero no hay garantía de que su política
de uso gratuito no cambie en el futuro -- si eso pasa, el fallback
simplemente deja de aportar nada (cae a "Localidad no determinada" como
antes), no rompe el resto del expediente.

## Verificación

- Balance de paréntesis/llaves/corchetes: mismo desbalance preexistente ya
  documentado, sin nuevos problemas.
- `AlertasPorSeveridad_addin.zip` regenerado y copiado a Descargas:
  `config.json` (v1.6) + `alertasFallas.html` + `alertasFallas.js`.

## Pendiente

Probar contra un caso real de una ciudad sin geocerca definida (ej. Cali)
para confirmar que el aviso de "ubicación aproximada" se ve bien en la
imagen final.
