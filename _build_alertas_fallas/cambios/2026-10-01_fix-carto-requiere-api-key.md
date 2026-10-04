# Fix: CARTO también requiere API key (segundo proveedor de mapa roto)

## Contexto

Después de cambiar de OpenStreetMap (bloqueado por política de uso) a CARTO
Voyager, la segunda prueba real mostró que CARTO TAMBIÉN exige API key --
sin una, tapa el mapa con una marca de agua grande "API KEY REQUIRED" en vez
de servir las teselas reales. El usuario insistió en que la ubicación
("dónde fue") debe quedar legible en la imagen.

## Fix

Se cambió a las teselas de **Esri** (`World_Street_Map`,
`server.arcgisonline.com`), que siguen siendo gratuitas sin API key para
este volumen de uso. Verificado en vivo con `curl -I` antes de aplicar el
cambio: `200 OK` + header `Access-Control-Allow-Origin: *` (confirma que
html2canvas puede leer los píxeles de las teselas sin que el canvas quede
"tainted").

**Detalle técnico que casi pasa desapercibido**: el esquema de URL de Esri
es `{z}/{y}/{x}` -- orden invertido respecto a OpenStreetMap/CARTO, que usan
`{z}/{x}/{y}`. Si se cambia de proveedor otra vez en el futuro, revisar
siempre el esquema de coordenadas de cada proveedor, no asumir que todos
usan el mismo orden.

## Verificación

- `curl -I` en vivo contra una tesela real de Esri: `200 OK`,
  `Access-Control-Allow-Origin: *`, `Content-Type: image/jpeg`.
- Balance de paréntesis/llaves/corchetes: mismo desbalance preexistente de 1
  paréntesis (ya documentado, no nuevo). Llaves y corchetes balanceados.
- `AlertasPorSeveridad_addin.zip` regenerado y copiado a Descargas,
  verificado con `zipfile`: exactamente `config.json` (v1.4) +
  `alertasFallas.html` + `alertasFallas.js`.

## Pendiente

Esta es la TERCERA vez que se cambia el proveedor de mapa sin poder probar
dentro de un navegador real desde este entorno -- el usuario debe confirmar
que esta vez las calles sí se ven. Si Esri también da problemas, las
alternativas siguientes a evaluar serían un proveedor con API key gratuita
real (MapTiler, Stadia Maps) -- a esa altura vale la pena que el usuario
decida si prefiere crear una cuenta gratuita en vez de seguir buscando
proveedores 100% sin registro.
