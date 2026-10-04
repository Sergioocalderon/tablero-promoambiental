# Rediseñar el Mini Expediente como tarjeta angosta + mapa embebido real

**Fecha:** 2026-10-01
**Archivos:** `_build_alertas_fallas/reporte_expediente_plantilla.html`,
`_build_alertas_fallas/alertasFallas.js`, `_build_alertas_fallas/config.json`,
`AlertasPorSeveridad_addin.zip` (raíz del repo)

## Contexto

El changelog `2026-10-01_quitar-panel-manual-expediente.md` había dejado pendiente
este rediseño: el usuario mostró una captura de WhatsApp de un mini expediente de
OTRO proyecto ("Telemetry") y pidió que `reporte_expediente_plantilla.html` se
pareciera a esa referencia en vez de seguir usando el header-hero ancho de 4
columnas que comparten los otros 2 reportes del ecosistema
(`_build_reportes/reporte_plantilla.html`, `_build_operaciones/reporte_operaciones_plantilla.html`).
Ese header ancho tiene sentido para un dashboard ejecutivo de escritorio; el Mini
Expediente es, a propósito, una tarjeta angosta pensada para compartir por WhatsApp
a un coordinador/técnico puntual.

## Qué pidió el usuario (resumen de la referencia visual)

De arriba hacia abajo: eyebrow chico "TELEMETRY & FLEET INTELLIGENCE" + subtítulo
discreto "Mini expediente de falla" (no un `<h1>` gigante); dos píldoras
(criticidad + activo/inactivo); título "MÓVIL {id}" + placa; nombre de la falla;
línea "SPN {spn} / FMI {fmi} · {categoría}"; una caja con el significado genérico
del FMI en lenguaje simple (tabla SAE J1939 estándar); bloques CUÁNDO / EMPRESA /
DÓNDE (localidad resuelta por geocerca, con "Incluida en: {ciudad}", coordenadas,
diferencia en segundos contra el punto GPS usado, y hora de esa posición); un
**mapa real embebido** (no un link) con marcador y, si se encontró geocerca de
localidad, su polígono dibujado encima; pie con fecha de generación y las notas de
limitación ya existentes.

## Qué se construyó

- **`reporte_expediente_plantilla.html`**, reescrita de cero como tarjeta angosta
  (`max-width:480px`, centrada, una sola columna) en vez del dashboard ancho
  heredado de Mantenimiento. Carga Leaflet 1.9.4 desde cdnjs.cloudflare.com
  (`leaflet.css` + `leaflet.js`, verificado con `curl -I` antes de usarlo — HTTP
  200 en ambas URLs) en el `<head>`, mismo patrón ya usado por SheetJS en
  `alertasFallas.html` (CDN externo sin problema de CSP porque este HTML se abre
  fuera del sandbox del add-in). El mapa (`<div id="mapa">`) se inicializa con un
  script inline que lee un `<script type="application/json" id="mapa-datos">` con
  lat/lon/polígono/zoom ya resueltos (números puros, sin necesidad de escapar);
  si `typeof L === 'undefined'` (sin internet cuando se abre el archivo) o
  cualquier otra excepción, el `catch` deja un aviso de texto dentro del propio
  div del mapa sin afectar el resto de la tarjeta.
- **`alertasFallas.js`**, nueva sección "Mini Expediente" ampliada:
  - `SIGNIFICADOS_FMI` + `significadoFmi(fmi)`: tabla SAE J1939 tal cual la dio el
    usuario (claves `'0'`..`'21'`, `'31'`), con fallback "Significado no disponible
    para este código." si el FMI no está en la tabla.
  - `obtenerZonasLocalidad()` / `puntoEnPoligono()` / `resolverLocalidad()`: puerto
    a JS de `cargar_zonas_localidad` / `_punto_en_poligono` / `_zona_de_punto` en
    `herramientas/geotab_reglas_v3.py` — mismo criterio exacto (prefijo
    `"bogota-"` sin distinguir mayúsculas/tildes, ray casting bug-for-bug
    idéntico al original incluyendo la reutilización de la última intersección
    calculada cuando un lado es horizontal). Corre en `alertasFallas.js` al
    generar el expediente (consulta `Zone` cacheada, una sola vez por sesión),
    NO en la plantilla — la plantilla solo recibe lat/lon + el polígono ya
    resuelto (o `null`) como JSON embebido.
  - `tiempoRelativoTexto()`: "hace instantes"/"hace N min"/"hace N h" contra el
    momento de generación del expediente.
  - `construirPildorasHtml()`, `construirCuandoHtml()`, `construirEmpresaHtml()`,
    `construirConductorHtml()`, `construirDondeHtml()`: arman el HTML de cada
    bloque de la tarjeta. Las píldoras reusan los MISMOS colores/tamaños que
    `crearPildoraCriticidad`/`crearPildoraEstadoActivo` (vía `COLOR_POR_CRITICIDAD`)
    pero como `<span style="...">` inline, porque este HTML se descarga y se abre
    fuera de la página del add-in — no hay DOM del add-in disponible para llamar
    a esas funciones directamente en el documento standalone.
  - `resolverCasoDesdeFila(it)`: ahora también lleva `spn`, `fmi`, `categoria`,
    `activo` al objeto "caso" (ya existían en `it`, solo no se propagaban).
  - `ensamblarExpediente()` / `ensamblarYDescargarExpediente()`: reescritas para
    el nuevo set de placeholders/slots de la plantilla angosta. Se agregó
    `obtenerZonasLocalidad()` al `Promise.all` ya existente (GPS + línea de
    tiempo + historial), y el cálculo de `diferenciaSegundos` (distancia en
    segundos entre el momento de la falla y el timestamp del punto GPS usado).
  - `config.json`: versión subida de `"1.0"` a `"1.1"` (cambio real del add-in).

## Decisiones no pedidas explícitamente, documentadas

- **Bloque CONDUCTOR**: la captura de referencia que describió el usuario no lo
  incluye, pero el pedido explícito de la tarea decía "no cambies la lógica de
  conductor/turno/criticidad/historial ya existente, solo su presentación
  visual" — interpretado como: no se puede borrar el feature (se agregó a pedido
  explícito del usuario en el changelog `2026-10-01_agregar-mini-expediente.md`),
  solo bajarle protagonismo. Quedó como un bloque más, después de DÓNDE, con el
  mismo estilo chico que EMPRESA/CUÁNDO.
- **"Incluida en: {ciudad}"** solo se dibuja cuando SÍ se encontró geocerca; si no,
  el bloque DÓNDE muestra igual coordenadas/mapa/marcador pero con "Localidad no
  determinada" y sin esa línea ni polígono — tal como pedía la tarea.
- **Línea de tiempo de señales e historial** se mantuvieron (no se pidió quitarlos)
  pero bajaron de protagonismo: pasaron de `<section>` con `<h2>` grande a un
  bloque "secundario" con encabezado chico gris, más abajo en la tarjeta, con la
  tabla envuelta en un `div.tabla-wrap{overflow-x:auto}` porque a 480px de ancho
  la tabla de 3-4 columnas con fechas largas no entra sin scroll horizontal.
- Se dejó un link secundario "Abrir en Google Maps" debajo del mapa (antes era el
  único mecanismo) — no se pidió quitarlo y sigue siendo útil como respaldo si el
  mapa no cargó.
- `{{EMPRESA}}` (nombre del bloque "EMPRESA" en la plantilla) sigue mostrando
  `caso.ciudad`, igual que en la versión anterior del template — no existe ningún
  campo de "nombre de empresa" real en este codebase (toda la flota es
  Promoambiental, segmentada por ciudad/tipología/marca, ver `CLAUDE.md`), así
  que se mantuvo el mismo dato que ya usaba el placeholder original.
- El `catch` de `obtenerZonasLocalidad()` devuelve `[]` en vez de propagar el
  error (igual criterio que `construirLineaTiempoSenales`/`resolverPosicionGps`
  cuando fallan sub-consultas) — si `Zone` falla, el expediente se sigue
  generando igual, solo sin localidad resuelta.

## Verificación realizada

- **Balance de paréntesis/llaves/corchetes** de `alertasFallas.js` completo tras
  los cambios: tokenizador con pila (respeta strings `'...'`/`"..."`/`` `...` ``,
  comentarios `//`/`/* */`, distingue regex de división por heurística de último
  token significativo) — pila final vacía, sin errores de apertura/cierre.
  Longitud total del archivo tras los cambios: 123209 caracteres.
- **Literal embebido, byte a byte**: `json.loads` del literal
  `PLANTILLA_EXPEDIENTE_EMBEBIDA` extraído de `alertasFallas.js` comparado
  directamente contra `reporte_expediente_plantilla.html` — **6705 vs 6705
  caracteres, IGUAL byte a byte**.
- **URL del CDN de Leaflet**: confirmadas EN VIVO con `curl -I` antes de usarlas —
  `https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js` → HTTP 200,
  `https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css` → HTTP 200
  (también se confirmó `unpkg.com/leaflet@1.9.4` como alternativa, también 200,
  pero se usó cdnjs por ser el mismo CDN que ya carga SheetJS en este add-in).
- **Contenido del zip**: `AlertasPorSeveridad_addin.zip` regenerado desde cero
  (se borró el anterior) y verificado con `zipfile` en Python — contiene
  EXACTAMENTE `config.json`, `alertasFallas.html`, `alertasFallas.js`.
- No se pudo correr un parser JS real (`node --check`) porque Node.js no está
  instalado en este entorno (ni en PATH de Git Bash ni en el de PowerShell) — la
  verificación de sintaxis se apoyó en el balance de delimitadores (tokenizador
  con pila) más revisión manual línea por línea de cada función nueva.

## Pendiente de verificar manualmente

1. No se pudo probar la instalación real dentro de MyGeotab durante esta tarea —
   en particular, generar un expediente real desde una fila con GPS disponible
   para confirmar visualmente que el mapa Leaflet se ve bien a 480px de ancho, que
   el `fitBounds` del marcador+polígono da un zoom razonable, y que el polígono de
   la geocerca de localidad realmente coincide con el punto en casos reales de
   Bogotá.
2. El algoritmo de point-in-polygon es un puerto bug-for-bug del original en
   Python (`_punto_en_poligono`) — si ese algoritmo tiene algún caso borde ya
   conocido (puntos sobre el borde, polígonos con huecos, etc.), este puerto lo
   hereda sin corregirlo, a propósito (no se pidió auditar ese algoritmo, solo
   portarlo).
3. El bloque CONDUCTOR es una decisión de diseño no cubierta literalmente por la
   referencia visual (ver sección de arriba) — si el usuario prefiere que no
   aparezca en absoluto en la tarjeta nueva, es un cambio de una línea (quitar el
   slot de la plantilla y su reemplazo en `ensamblarExpediente`).
