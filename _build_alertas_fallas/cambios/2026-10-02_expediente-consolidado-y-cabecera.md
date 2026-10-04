# Cabecera con más contraste + Expediente Consolidado (todas las fallas de un vehículo en una imagen)

**Fecha:** 2026-10-02
**Archivos:** `_build_alertas_fallas/reporte_expediente_consolidado_plantilla.html` (nuevo),
`_build_alertas_fallas/alertasFallas.js`, `_build_alertas_fallas/config.json`,
`AlertasPorSeveridad_addin.zip` (raíz del repo, también copiado a Descargas)

## Contexto

El Mini Expediente (`PLANTILLA_EXPEDIENTE_EMBEBIDA` / `ensamblarYDescargarExpediente`,
changelogs `2026-10-01_*` y `2026-10-02_respaldo-geocoding-localidad.md`) ya generaba una
imagen PNG por **un solo código** de falla, con mapa de un marcador. El usuario pidió dos
cosas sobre `crearTarjetaVehiculo`:

1. Más contraste en la línea de ciudad/marca/motor de la cabecera de cada tarjeta de
   vehículo (hoy casi invisible, `T.color.textoGris` sobre el fondo gris-azul de la
   cabecera).
2. Un botón nuevo en esa misma cabecera para generar un **Expediente Consolidado**: una
   sola imagen con TODAS las fallas activas de ese vehículo (no una por código), con tabla
   resumen agrupada por código, un mapa con un marcador por código (coloreado por
   categoría) y una leyenda de esos colores.

## Qué se construyó

### Cabecera de `crearTarjetaVehiculo` (más contraste + botón nuevo)

- El `<span>` de ciudad/marca/motor pasó de `color: T.color.textoGris` (`#6B7280`,
  `0.8rem`) a `color: '#334155'` (gris oscuro real), `fontSize: '0.86rem'`,
  `fontWeight: '600'`, y se agregaron los iconos pedidos: `📍` antes de la ciudad, `⚙️`
  antes de "Motor:".
- La cabecera se reorganizó en dos grupos (`infoVehiculo` con placa+datos a la
  izquierda, el botón nuevo a la derecha) en vez de los 2 `<span>` sueltos de antes --
  necesario porque con 3 hijos directos `justifyContent:'space-between'` los habría
  repartido mal (el del medio quedaría centrado, no pegado a la placa).
- Botón nuevo `📊 Generar Expediente Consolidado`: mismo verde corporativo que usa
  `crearBoton(texto, true)` en el panel de filtros (`T.color.primary`, texto blanco,
  sin borde), pero con el tamaño compacto de los otros botones "inline" de este archivo
  (`botonCargar` en `construirControlTripulaciones`: `padding:'6px 12px'`,
  `fontSize:'0.76rem'`, `fontWeight:'700'`, `borderRadius: T.radius.sm`).

### `reporte_expediente_consolidado_plantilla.html` (nueva plantilla)

Misma tarjeta angosta de 480px, misma paleta de variables CSS (`--ink`, `--muted`,
`--border`, etc.) y mismo Leaflet 1.9.4 por CDN que `reporte_expediente_plantilla.html`,
pero con secciones distintas:

- Cabecera con MÓVIL + placa + línea de ciudad/marca/motor (sin píldoras de
  criticidad/activo -- ya no aplican a UN código, hay varios).
- Tabla resumen (`table.dt`, reintroducida en esta plantilla porque la del Mini
  Expediente la había perdido al simplificarse -- no se tocó la otra plantilla) con
  columnas Código / Descripción (+ badge de categoría) / Criticidad / Veces / Ubicación.
  **Decisión de layout explícita:** `table-layout:fixed` con anchos fijos en las 4
  columnas angostas y la Descripción absorbiendo el resto, en vez del
  `div.tabla-wrap{overflow-x:auto}` que usa el historial del Mini Expediente -- ese
  `overflow-x:auto` tiene sentido en una tabla que se ve interactivamente dentro del
  add-in, pero el Expediente Consolidado se **captura como PNG de ancho fijo
  (480px)**: cualquier columna que quedara fuera del viewport por un scroll horizontal
  simplemente no aparecería en la imagen final (html2canvas no "scrollea", captura lo
  que está en el layout). Se optó por anchos fijos + `word-break:break-word` para que
  la tabla crezca en ALTO (sin problema, el iframe se redimensiona a
  `scrollHeight` antes de capturar) en vez de en ancho.
- Mapa multi-marcador + leyenda de categorías, ver abajo.

### `alertasFallas.js` -- nueva sección "Expediente Consolidado"

- `COLOR_CATEGORIA_MAPA`: paleta categoría→color exacta que pidió el usuario, agregada
  junto a `COLOR_POR_CRITICIDAD`/`CATEGORIAS_OCULTAS` (codifica *categoría de sistema*,
  no criticidad, por eso es una constante separada).
- `agruparItemsPorCodigo(items)`: agrupa por `idDiagnostico + '|' + (idFailureMode ||
  'undefined')` -- misma clave que `claveEpisodio` en `resolverCasoDesdeFila`. Cada
  grupo acumula `conteo` (cuántas filas de `v.items` cayeron en esa clave),
  `criticidad` (la más alta del grupo) y `fechaReferencia` (la más reciente del
  grupo, usada para resolver GPS). En la práctica `obtenerFallasActivas` ya dedupea a
  "último registro por vehículo+diagnóstico+failureMode", así que cada clave debería
  traer un solo item hoy -- se agrupa igual "por si acaso", tal como pidió la tarea.
- `construirFilaResumenConsolidadoHtml(g)` / `construirLeyendaConsolidadoHtml(categorias)`:
  arman el HTML de cada fila de la tabla y de la leyenda, como `<span style="...">`
  inline (mismo motivo que el resto del Mini Expediente: este HTML corre fuera del DOM
  del add-in). Si `g.posicion` es `null` (sin GPS resuelto), la fila muestra
  "Ubicación no disponible" en vez de omitirse.
- `SCRIPT_INIT_MAPA_CONSOLIDADO`: variante de `SCRIPT_INIT_MAPA` (que sigue intacto,
  usado tal cual por el Mini Expediente de un solo código) para varios marcadores.
  Mismo patrón de robustez ya validado hoy contra la cuenta real (`setTimeout(fn, 0)`
  envolviendo toda la inicialización, `invalidateSize()` tanto al crear el mapa como
  justo antes de marcar `__mapaListo`), pero con encuadre dinámico: si hay más de un
  marcador, `L.featureGroup(marcadores).getBounds()` con `mapa.fitBounds(bounds,
  {padding:[16,16]})`; si solo queda un marcador con posición válida, `setView` normal
  (un solo punto no tiene bounds útiles). El encuadre se recalcula (`reencuadrar()`)
  tanto apenas se crean los marcadores como de nuevo justo antes de marcar el mapa
  listo, para que sobreviva el remedido de `invalidateSize()`. Si **ningún** código
  tiene GPS, el mapa no se inicializa en absoluto -- se muestra un aviso de texto y se
  marca `__mapaListo = true` de inmediato (no se inventa un centro de mapa sin datos).
- `construirMapaConsolidadoHtml(grupos)`: filtra a los grupos con `posicion` resuelta,
  construye `{ puntos: [{lat, lon, color}, ...] }` (color = `COLOR_CATEGORIA_MAPA` de
  la categoría de cada grupo) y arma el slot completo (div + JSON + script).
- `PLANTILLA_EXPEDIENTE_CONSOLIDADO_EMBEBIDA`: literal embebido desde
  `reporte_expediente_consolidado_plantilla.html` (mismo mecanismo manual de siempre
  -- `json.dumps(html, ensure_ascii=True)` corrido una vez en el scratchpad de la
  sesión, no en el repo, y luego borrado).
- `ensamblarExpedienteConsolidado(plantillaHtml, datos)`: reemplaza los placeholders
  `{{MOVIL}}`/`{{PLACA}}`/`{{CIUDAD}}`/`{{MARCA}}`/`{{REFERENCIA_MOTOR}}`/`{{N_MOTOR}}`/
  `{{TOTAL_CODIGOS}}`/`{{GENERADO}}` y los 3 slots (tabla, mapa, leyenda) -- mismo
  mecanismo `reemplazarBloque` que ya usa `ensamblarExpediente`.
- `ensamblarYDescargarExpedienteConsolidado(v)`: recibe el objeto vehículo completo de
  `agruparPorVehiculo` (con `v.items`), agrupa, resuelve GPS de **todos los grupos en
  paralelo** (`Promise.all`, pedido explícito), arma el HTML y llama a
  `capturarYDescargarImagen` (reusada tal cual, sin cambios) con el nombre
  `expediente_consolidado_<SLUG_VEHICULO>_<FECHA>.png`.
- `generarExpedienteConsolidadoDesdeBoton(v, boton)`: disparado por el botón nuevo.
  Mismo patrón visual que `generarExpedienteDesdeFila` (texto → `⏳ Generando…`,
  `alert()` si falla, se re-habilita siempre en el `.then()` final) -- ver decisión
  sobre el flag compartido abajo.

## Decisiones no pedidas explícitamente, documentadas

- **`expedienteEnCurso` se reutiliza tal cual** (no se creó un flag separado para el
  consolidado): ese flag ya es global para TODAS las filas de TODAS las vistas
  (tarjetas y cronológica), no por fila -- es decir, el código existente ya serializa
  cualquier generación de imagen del add-in a una por vez. Se mantuvo esa misma
  semántica para el botón nuevo en vez de introducir un segundo flag independiente,
  para no permitir dos capturas con iframe + html2canvas corriendo en simultáneo
  (nunca se probó que eso sea seguro, y no había necesidad real de permitirlo).
- **La leyenda lista las categorías presentes entre los CÓDIGOS del vehículo**, no
  solo las que efectivamente consiguieron marcador en el mapa -- si un código de
  categoría "Frenos" no tiene GPS resuelto, "Frenos" igual aparece en la leyenda
  porque aparece en la tabla resumen de ese vehículo. Interpretación de "categorías
  que de verdad aparecen en este vehículo" (texto literal de la tarea) como referidas
  a la tabla, no al subconjunto geolocalizado.
- **`table-layout:fixed` con anchos fijos** en vez de `overflow-x:auto` -- ver
  justificación completa arriba (sección de la plantilla nueva); es la decisión de
  diseño más consciente de esta tarea porque una tabla capturada a un ancho fijo no
  puede depender de scroll para mostrar contenido.
- **No se tocaron `SCRIPT_INIT_MAPA`, `PLANTILLA_EXPEDIENTE_EMBEBIDA`, `construirDondeHtml`
  ni ninguna otra pieza del Mini Expediente de un solo código** -- todo lo nuevo vive en
  piezas paralelas (`SCRIPT_INIT_MAPA_CONSOLIDADO`, `PLANTILLA_EXPEDIENTE_CONSOLIDADO_EMBEBIDA`,
  etc.), tal como pedía explícitamente la tarea.
- **No se subió `MAXIMO_MS` (7000ms) ni el `setTimeout(marcarListo, 5000)` de respaldo**
  dentro del script de mapa -- un mapa con varios marcadores sigue cargando una sola
  capa de teselas compartida (`capaTiles.on('load', ...)`), que dispara igual sin
  depender de cuántos marcadores haya encima; no hay razón técnica para que tarde más
  que con un solo marcador. Queda como punto a confirmar en campo (ver pendientes).

## Verificación realizada

- **Balance de paréntesis/llaves/corchetes** de `alertasFallas.js` completo, con el
  mismo tokenizador con pila (respeta strings, comentarios, regex) ya usado toda la
  sesión (`check_balance.py`, vivió en el scratchpad): **0 errores y pila final vacía
  tanto ANTES como DESPUÉS de los cambios** (125873 → 144374 caracteres). La tarea
  mencionaba un desbalance de 1 paréntesis ya conocido por un regex de rango Unicode
  en `quitarAcentos`/`slug` -- al correr el checker contra el archivo real tal como
  está hoy en el repo, ese desbalance no aparece (0 mismatches, stack vacío); se
  documenta la discrepancia en vez de asumir el número de la tarea sin confirmarlo.
- **Literal embebido, byte a byte**: `json.loads()` del literal
  `PLANTILLA_EXPEDIENTE_CONSOLIDADO_EMBEBIDA` extraído de `alertasFallas.js`, comparado
  directo contra `reporte_expediente_consolidado_plantilla.html` -- **4434 vs 4434
  caracteres, IGUAL byte a byte**.
- **Referencias colgantes**: se verificaron por nombre las 10 funciones/constantes
  nuevas (`COLOR_CATEGORIA_MAPA`, `agruparItemsPorCodigo`,
  `construirFilaResumenConsolidadoHtml`, `construirLeyendaConsolidadoHtml`,
  `SCRIPT_INIT_MAPA_CONSOLIDADO`, `construirMapaConsolidadoHtml`,
  `ensamblarExpedienteConsolidado`, `ensamblarYDescargarExpedienteConsolidado`,
  `generarExpedienteConsolidadoDesdeBoton`, `PLANTILLA_EXPEDIENTE_CONSOLIDADO_EMBEBIDA`)
  -- todas tienen definición + al menos un uso real, sin placeholders residuales
  (`__PLACEHOLDER_PLANTILLA_CONSOLIDADO__` ya no existe en el archivo final).
- **`config.json`**: versión subida de `"1.10"` a `"1.11"`.
- **Contenido del zip**: `AlertasPorSeveridad_addin.zip` borrado y regenerado desde
  cero con `Compress-Archive`, verificado con `zipfile` en Python -- contiene
  EXACTAMENTE `config.json`, `alertasFallas.html`, `alertasFallas.js`. Copiado a
  `C:\Users\sergio.calderon\Downloads\AlertasPorSeveridad_addin.zip` (sobrescrito).
- Igual que en changelogs anteriores de este add-in, no se pudo correr un parser JS
  real (`node --check`): Node.js no está instalado en este entorno. La verificación de
  sintaxis se apoyó en el tokenizador con pila más revisión manual línea por línea de
  cada función nueva.

## Pendiente de verificar manualmente

1. **No se pudo probar dentro de MyGeotab real** en este entorno (sin navegador con
   sesión de la cuenta) -- en particular: que el botón nuevo se vea bien en la
   cabecera a distintos anchos de pantalla, que el `fitBounds` de varios marcadores dé
   un zoom razonable con vehículos cuyas fallas estén en puntos muy distantes entre
   sí, y que la tabla resumen a `table-layout:fixed` no corte visualmente la
   descripción de un código largo.
2. **Leyenda con muchas categorías**: con las 12 categorías posibles simultáneamente
   en un solo vehículo (caso extremo, poco probable en la práctica) la leyenda
   (`flex-wrap`) debería simplemente pasar a 3-4 líneas en vez de desbordar -- no se
   pudo confirmar visualmente, solo por lectura del CSS (`display:flex;flex-wrap:wrap`
   sin restricción de alto).
3. **Tiempo de carga del mapa con varios marcadores**: se asumió que el evento
   `load` de la capa de teselas (Esri) no tarda más por tener varios
   `circleMarker` superpuestos (son capas separadas, livianas) -- no se midió en vivo
   contra la cuenta real con un vehículo con 3+ códigos activos en ubicaciones
   distintas. Si en la práctica tarda más que el tope de 7s de
   `capturarYDescargarImagen`, la imagen se capturaría con el mapa a medio cargar en
   vez de romperse (el `setTimeout(marcarListo, 5000)` interno ya fuerza
   `__mapaListo` de todas formas) -- pero valdría la pena confirmarlo con un caso real.
