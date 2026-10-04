/* ============================================================================
   Add-In: Operaciones (hábitos de conducción: velocidad, ralentí, PTO)

   Nace el 2026-10-01 al separar el add-in combinado "Reportes" en dos
   add-ins independientes de MyGeotab -- decisión explícita del usuario, ver
   cambios/2026-10-01_creacion-addin-operaciones.md para el detalle completo
   de qué se heredo de reportes.js y qué se dejó fuera. El reporte de Fallas
   y el de Mini Expediente se quedaron en el add-in "Mantenimiento"
   (_build_reportes/, ver
   _build_reportes/cambios/2026-10-01_separar-en-dos-addins.md).

   A diferencia del add-in de Mantenimiento, ESTE add-in NO tiene selector de
   tipo de reporte -- es el único modo: elegir empresa (grupo Geotab) + rango
   de fechas y descargar directo el reporte de hábitos (velocidad, ralentí,
   PTO) en HTML autocontenido. Se simplificó el formulario a propósito: no
   tiene sentido dejar un selector de pills de una sola opción.

   DUPLICACIÓN INTENCIONAL (aceptada explícitamente con el usuario, no es un
   error a corregir): el código compartido con el add-in de Mantenimiento --
   conexión a la API, catálogos de diagnósticos, resolución de empresa/
   dispositivos, el motor de plantillas (MOTOR_JS_EMBEBIDO), el sistema de
   diseño (T/crearPill/inyectarEstilosGlobales), helpers de fecha -- vive
   DUPLICADO, verbatim, en mantenimiento.js (antes reportes.js). Geotab no
   soporta compartir un módulo JS entre dos add-ins de forma sencilla, y el
   usuario ya decidió que la separación completa de archivos es preferible a
   mantener un acoplamiento entre dos add-ins con ciclos de vida
   independientes.

   Lógica de hábitos heredada VERBATIM de reportes.js (agregada ahí el
   2026-09-29/30 como "Operaciones", HERMANO de Fallas dentro del add-in de
   entonces) -- ver cambios/2026-09-29_agregar-reporte-operaciones.md para el
   detalle de qué reglas de Geotab se usan para cada hábito y por qué
   (decisión NO confirmada con el usuario -- ver ese changelog antes de
   confiar en el reporte generado). Usa el MISMO motor de renderizado que el
   add-in de Mantenimiento (MOTOR_JS_EMBEBIDO, duplicado verbatim en este
   archivo, DASH.kind==='habits_dashboard') y su propia plantilla
   (PLANTILLA_OPERACIONES_EMBEBIDA, generada desde
   reporte_operaciones_plantilla.html).

   PTO es un pulso, no un nivel -- el hardware real lo pulsa on/off cada
   segundo, así que ninguna condición de regla de Geotab puede exigirlo
   directamente sin disparar en falso constantemente (ver CLAUDE.md). La
   confirmación de PTO en este add-in se hace cruzando el candidato con un
   pulso real de DiagnosticPowerTakeoffEngagedId dentro de ±VENTANA_PTO_MIN
   -- mismo patrón que dashboardAnalisisPTO.js/telegram_alertas.py.

   El reporte final (el .html descargable) se arma combinando strings
   INCRUSTADOS en este mismo archivo (ver PLANTILLA_OPERACIONES_EMBEBIDA/
   MOTOR_JS_EMBEBIDO más abajo, generados desde los .html/.js que se guardan
   aparte solo como copia legible de referencia -- NO se leen en tiempo de
   ejecución) con los datos recién consultados a Geotab, antes de disparar la
   descarga vía Blob. Mismo mecanismo que el add-in de Mantenimiento, por el
   mismo motivo real (fetch() de un archivo hermano daba 404 dentro de
   MyGeotab -- ver cambios/2026-09-29_incrustar-plantilla-y-motor-fix-404.md).
   ============================================================================ */

geotab.addin.operaciones = function () {
  'use strict';

  // Grupos cuyo nombre contiene alguna de estas palabras se tratan como rama
  // de "marca" (motor/ensamblador), no como empresa/ciudad -- mismo criterio
  // (esGrupoMarca) ya usado en dashboardAnalisisFallas.js/telegram_alertas.py.
  // CAMBIO (2026-10-03, auditoría): + 'chevrolet' -- sin ella los grupos
  // 'CHEVROLET - NHR' / 'CHEVROLET VAN - N400' no se reconocían como marca y
  // esos vehículos salían como "Sin marca" en el reporte.
  var PALABRAS_GRUPO_MARCA = ['volkswagen', 'volskwagen', 'mercedes', 'international', 'foton', 'kenworth', 'chevrolet'];
  var NOMBRE_GRUPO_TIPOLOGIA = 'tipologia';
  var MOTOR_JS_EMBEBIDO = "/* Motor de renderizado del reporte de fallas (cross-filter, tablas, gr\u00e1ficas\n   Pareto/evoluci\u00f3n/distribuci\u00f3n). Se sirve tal cual junto con reportes.js/\n   reportes.html dentro del add-in, y reportes.js lo lee en tiempo de\n   ejecuci\u00f3n (fetch) para incrustarlo VERBATIM dentro de cada reporte HTML\n   generado -- no se modifica esta l\u00f3gica, es puro motor de presentaci\u00f3n sin\n   nada espec\u00edfico de una empresa o periodo. */\n(function(){\n  function byId(id){return document.getElementById(id);}\n  function readData(srcId){var el=byId(srcId); return el?JSON.parse(el.textContent):null;}\n\n  // ============================================================\n  // CROSS-FILTER MULTI-DIMENSIONAL \u2014 100% en el navegador (cierre 2026-09)\n  // ============================================================\n  // CF = {clave: [valores]} \u2014 VARIOS filtros combinables. MISMA\n  // dimensi\u00f3n = OR entre sus valores; DIMENSIONES DISTINTAS = AND.\n  // Un gr\u00e1fico EMITE (spec.cfKey/spec.cfLabel); clic a\u00f1ade el valor a\n  // su dimensi\u00f3n, clic de nuevo sobre el mismo lo quita. La tabla\n  // maestra ESCUCHA (payload.crossfilter: [{column,key,label,match}]).\n  var CF = {};\n  var CF_LABELS = {};\n  var CF_TABLES = [];\n\n  function cfToggle(key, val, label){\n    CF_LABELS[key] = label || key;\n    var arr = CF[key] || [];\n    var idx = arr.indexOf(val);\n    if(idx === -1) arr = arr.concat([val]); else arr = arr.slice(0, idx).concat(arr.slice(idx + 1));\n    if(arr.length) CF[key] = arr; else delete CF[key];\n    refreshCrossfilter();\n    // Ajuste puntual 2026-09: SIN auto-scroll a la tabla maestra \u2014 el\n    // usuario pidi\u00f3 expl\u00edcitamente que un clic de filtro no interrumpa\n    // la lectura del dashboard moviendo la vista por su cuenta. El\n    // scroll solo debe moverlo el usuario.\n  }\n  function cfRemoveValue(key, val){\n    var arr = (CF[key] || []).filter(function(v){ return v !== val; });\n    if(arr.length) CF[key] = arr; else delete CF[key];\n    refreshCrossfilter();\n  }\n  function cfClearKey(key){ delete CF[key]; refreshCrossfilter(); }\n  function cfClearAll(){ CF = {}; refreshCrossfilter(); }\n  window.cfClearAll = cfClearAll;\n  function refreshCrossfilter(){\n    recomputeDashboard();\n    CF_TABLES.forEach(function(fn){ fn(); });\n    renderChips();\n    document.querySelectorAll('[data-cf-key]').forEach(function(el){\n      var key = el.getAttribute('data-cf-key'), val = el.getAttribute('data-cf-value');\n      var active = CF[key];\n      el.classList.toggle('cf-dim', !!active && active.indexOf(val) === -1);\n      el.classList.toggle('cf-selected', !!active && active.indexOf(val) !== -1);\n    });\n  }\n\n  // ============================================================\n  // REC\u00c1LCULO GLOBAL \u2014 KPIs + TODOS los gr\u00e1ficos (fase final 2026-09)\n  // ============================================================\n  // Espejo EXACTO de `_dashboard_from_rows()` (Python, motor de la app):\n  // misma \"una sola verdad anal\u00edtica\" en ambos lados. `DASH` se carga\n  // UNA vez desde el dataset embebido; cada clic solo re-agrega en\n  // memoria \u2014 cero red, cero servidor.\n  var DASH = null;\n  function loadDashboard(){\n    var el = byId('data-dashboard-dataset');\n    DASH = el ? JSON.parse(el.textContent) : null;\n  }\n  var CF_FIELD = {\n    movil: 'movil', tipo: 'tipo', marca: 'marca', empresa: 'empresa',\n    sistema: 'categoria', criticidad: 'criticidad', diagnostico: 'codigo',\n  };\n  function rowMatchesCf(row, key, values){\n    if(DASH && DASH.kind === 'habits_dashboard'){\n      var habitField = {dia:'dia', movil:'movil', empresa:'empresa', tipo:'tipoVehiculo', habit_type:'habitType', regla:'regla', duration_bin:'durationBin', turno:'shift'}[key];\n      return habitField != null && values.indexOf(row[habitField]) !== -1;\n    }\n    if(key === 'dia') return values.some(function(d){ return row.dias.indexOf(d) !== -1; });\n    var field = CF_FIELD[key];\n    return field != null && values.indexOf(row[field]) !== -1;\n  }\n  function filterRowsCf(rows, exclude){\n    var out = rows;\n    Object.keys(CF).forEach(function(key){\n      if(key === exclude) return;\n      var values = CF[key];\n      if(!values || !values.length) return;\n      out = out.filter(function(r){ return rowMatchesCf(r, key, values); });\n    });\n    return out;\n  }\n  function decFmt(v, digits){\n    digits = (digits == null) ? 1 : digits;\n    return v.toLocaleString('es-CO', {minimumFractionDigits: digits, maximumFractionDigits: digits});\n  }\n  function flotaForCf(){\n    if(CF.movil && CF.movil.length) return CF.movil.length;\n    var flota = DASH.baseFlota;\n    ['tipo', 'marca', 'empresa'].forEach(function(dim){\n      var values = CF[dim];\n      if(values && values.length){\n        var sum = 0;\n        values.forEach(function(v){ sum += (DASH.fleetSizes[dim][v] || 0); });\n        flota = Math.min(flota, sum);\n      }\n    });\n    return flota;\n  }\n  function isHiddenCategory(cat){\n    return !!(DASH && DASH.hiddenCategories && DASH.hiddenCategories.indexOf(cat) !== -1);\n  }\n  function countByField(rows, field){\n    var m = {};\n    rows.forEach(function(r){ m[r[field]] = (m[r[field]] || 0) + 1; });\n    return m;\n  }\n  function groupCriticidad(rows, field){\n    var m = {};\n    rows.forEach(function(r){\n      var g = r[field];\n      if(!m[g]) m[g] = {};\n      m[g][r.criticidad] = (m[g][r.criticidad] || 0) + 1;\n    });\n    return m;\n  }\n  function totalOfCounts(counts){\n    var t = 0; Object.keys(counts).forEach(function(k){ t += counts[k]; }); return t;\n  }\n  // Refinamiento visual ejecutivo (2026-09): criticidad dominante de un\n  // grupo (empate roto por severidad, no por orden de inserci\u00f3n) \u2014 usada\n  // para el \"badge\" de color junto al nombre en cada barra Pareto.\n  var CRIT_RANK = {ALTA: 3, MEDIA: 2, BAJA: 1};\n  function dominantCrit(counts){\n    if(!counts) return null;\n    var best = null, bestN = -1;\n    Object.keys(counts).forEach(function(c){\n      var n = counts[c] || 0;\n      if(n > bestN || (n === bestN && (CRIT_RANK[c] || 0) > (CRIT_RANK[best] || 0))){ best = c; bestN = n; }\n    });\n    return bestN > 0 ? best : null;\n  }\n  var CORPORATE_BLUE = '#2563eb';\n  // Espejo de `CRITICALITY_COLORS` (Python) \u2014 constante, no depende del\n  // dataset embebido, as\u00ed el primer render (antes de `loadDashboard()`\n  // terminar) y el rec\u00e1lculo usan siempre los mismos colores.\n  var CRIT_COLORS = {ALTA: '#dc2626', MEDIA: '#f59e0b', BAJA: '#94a3b8'};\n  // Espejo de `_split_kpi_value()` (Python): separa \"11 / 31 (35,5 %)\" en\n  // valor principal + leyenda secundaria para la jerarqu\u00eda tipogr\u00e1fica del\n  // KPI (refinamiento visual ejecutivo 2026-09).\n  function splitKpiValue(text){\n    var idx = text.indexOf(' (');\n    if(idx !== -1 && text.charAt(text.length - 1) === ')'){\n      return {main: text.slice(0, idx), caption: text.slice(idx + 1)};\n    }\n    return {main: text, caption: null};\n  }\n  // Espejo de `_kpi_visual_class()` (Python): sem\u00e1ntica de riesgo sobria\n  // (rojo/\u00e1mbar/azul) SOLO para los KPIs prioritarios \u2014 nunca una alarma\n  // permanente en el resto del tablero.\n  function kpiVisualClass(id, text){\n    if(id === 'fallas_alta') return 'kpi--risk-high';\n    if(id === 'concentracion') return 'kpi--risk-mid';\n    if(id === 'sistema_principal') return 'kpi--accent-blue';\n    if(id === 'moviles_afectados' || id === 'hab_moviles'){\n      var m = /([\\d.,]+)\\s*%/.exec(text);\n      if(m){\n        var pct = parseFloat(m[1].replace(/\\./g, '').replace(',', '.'));\n        if(pct >= 50) return 'kpi--risk-high';\n        if(pct >= 25) return 'kpi--risk-mid';\n      }\n      return 'kpi--accent-blue';\n    }\n    return '';\n  }\n  function setKpi(id, text){\n    var el = byId('kpi-' + id);\n    if(!el) return;\n    var parts = splitKpiValue(text);\n    el.textContent = '';\n    var mainSpan = document.createElement('span'); mainSpan.className = 'kpi-main'; mainSpan.textContent = parts.main;\n    el.appendChild(mainSpan);\n    if(parts.caption){\n      var capSpan = document.createElement('span'); capSpan.className = 'kpi-caption'; capSpan.textContent = parts.caption;\n      el.appendChild(capSpan);\n    }\n    var card = el.closest('.kpi');\n    if(card){\n      card.classList.remove('kpi--risk-high', 'kpi--risk-mid', 'kpi--accent-blue');\n      var cls = kpiVisualClass(id, text);\n      if(cls) card.classList.add(cls);\n    }\n  }\n  function recomputeChart(id, builder, cfKey, cfLabel){\n    var el = byId(id);\n    if(!el) return;\n    var spec = builder();\n    el.innerHTML = '';\n    var empty = !spec || (spec.categories && !spec.categories.length) || (spec.items && !spec.items.length);\n    if(empty){\n      el.style.minHeight = '';\n      el.innerHTML = '<p style=\"color:var(--muted);font-size:12.5px;padding:8px 2px\">' + ((DASH && DASH.emptyText) || 'No hay fallas para esta selecci\u00f3n.') + '</p>';\n      return;\n    }\n    spec.cfKey = cfKey; spec.cfLabel = cfLabel;\n    if(spec.height) el.style.minHeight = spec.height + 'px';\n    var kind = el.dataset.kind;\n    if(kind === 'pareto') renderPareto(el, spec);\n    else if(kind === 'evolution') renderEvolution(el, spec);\n    else if(kind === 'distribution') renderDistributionBar(el, spec);\n    else if(kind === 'evostack') renderEvoStack(el, spec);\n    else renderBar(el, spec);\n  }\n  // ============================================================\n  // REPORTE DE OPERACIONES / H\u00c1BITOS \u2014 rec\u00e1lculo global (100 % local)\n  // Dataset: DASH.rows (un evento por fila). Tres tipos: VELOCIDAD,\n  // RALENT\u00cd y PTO. Cada gr\u00e1fico excluye su PROPIA dimensi\u00f3n del filtro\n  // para no colapsarse a s\u00ed mismo (mismo criterio que Fallos).\n  // ============================================================\n  var HAB_COLORS = {'VELOCIDAD': '#2563eb', 'RALENT\u00cd': '#0891b2', 'PTO': '#7c3aed'};\n  var HAB_BINS = ['5\u201310 min', '10\u201320 min', '20 min o m\u00e1s'];\n  function hNum(v, d){ return (v || 0).toLocaleString('es-CO', {maximumFractionDigits: d == null ? 1 : d}); }\n  function hDur(v){\n    v = Math.round(v || 0);\n    if(v < 60) return v + ' s';\n    if(v < 3600) return (v / 60).toLocaleString('es-CO', {maximumFractionDigits: 1}) + ' min';\n    return fmtSeconds(v);\n  }\n  function hOf(list, t){ return list.filter(function(r){ return r.habitType === t; }); }\n  function hGroup(list, f){ var m = {}; list.forEach(function(r){ (m[r[f]] || (m[r[f]] = [])).push(r); }); return m; }\n  function hDistinct(list, f){ var s = {}; list.forEach(function(r){ s[r[f]] = 1; }); return Object.keys(s); }\n  function hSum(list, f){ return list.reduce(function(a, r){ return a + (+r[f] || 0); }, 0); }\n  function hTop(groups, valueFn){\n    var best = null, bv = -1;\n    Object.keys(groups).forEach(function(k){\n      var v = valueFn(groups[k], k);\n      if(v > bv || (v === bv && best !== null && k < best)){ best = k; bv = v; }\n    });\n    return best === null ? null : {name: best, value: bv};\n  }\n  function hUnion(list){\n    var groups = {};\n    list.forEach(function(r){\n      if(r.startMs != null && r.endMs != null){ (groups[r.idDevice] || (groups[r.idDevice] = [])).push([r.startMs, r.endMs]); }\n    });\n    var byDev = {}, total = 0;\n    Object.keys(groups).forEach(function(k){\n      var a = groups[k].sort(function(x, y){ return x[0] - y[0]; }), end = -Infinity, sum = 0;\n      a.forEach(function(x){\n        if(x[1] <= end) return;\n        if(x[0] > end){ sum += x[1] - x[0]; end = x[1]; } else { sum += x[1] - end; end = x[1]; }\n      });\n      byDev[k] = sum / 1000; total += sum / 1000;\n    });\n    return {total: total, byDev: byDev};\n  }\n  function hMedian(list, f){\n    var v = list.map(function(r){ return +r[f] || 0; }).sort(function(a, b){ return a - b; });\n    if(!v.length) return 0;\n    var m = Math.floor(v.length / 2);\n    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;\n  }\n  function hRulesOf(list){ return hDistinct(list, 'regla').sort().join(', '); }\n  function hRank(list, valueFn, unit, color, extraFn){\n    var g = hGroup(list, 'movil');\n    var items = Object.keys(g).map(function(m){\n      var x = g[m], q = x[0];\n      return {name: m, value: valueFn(x), placa: q.placa, tipo: q.tipoVehiculo, extra: extraFn(x, q)};\n    }).filter(function(it){ return it.value > 0; })\n      .sort(function(a, b){ return (b.value - a.value) || (a.name < b.name ? -1 : 1); }).slice(0, DASH.topN);\n    return items.length ? {items: items, unit: unit, color: color, height: Math.max(200, items.length * 34)} : null;\n  }\n  function recomputeHabitsDashboard(){\n    var rows = filterRowsCf(DASH.rows, null);\n    var speed = hOf(rows, 'VELOCIDAD'), idle = hOf(rows, 'RALENT\u00cd'), pto = hOf(rows, 'PTO');\n    var movs = hDistinct(rows, 'movil').length, flota = flotaForCf();\n    var pct = flota ? decFmt(100 * movs / flota) : '0,0';\n    var idleU = hUnion(idle);\n    // ---- General\n    setKpi('hab_total', hNum(rows.length, 0));\n    setKpi('hab_moviles', movs + ' / ' + flota + ' (' + pct + ' %)');\n    setKpi('hab_velocidad', hNum(speed.length, 0)); setKpi('hab_ralenti', hNum(idle.length, 0)); setKpi('hab_pto', hNum(pto.length, 0));\n    setKpi('hab_tiempo_ralenti', idle.length ? fmtSeconds(idleU.total) : '\u2014');\n    // ---- Velocidad\n    var sg = hGroup(speed, 'movil'), sr = hGroup(speed, 'regla');\n    var stop = hTop(sg, function(x){ return x.length; }), srule = hTop(sr, function(x){ return x.length; });\n    setKpi('vel_total', hNum(speed.length, 0)); setKpi('vel_moviles', String(Object.keys(sg).length));\n    setKpi('vel_top_movil', stop ? stop.name + ' (' + hNum(stop.value, 0) + ')' : '\u2014');\n    setKpi('vel_regla', srule ? srule.name : '\u2014');\n    // ---- Ralent\u00ed\n    var ig = hGroup(idle, 'movil');\n    setKpi('idle_total', hNum(idle.length, 0)); setKpi('idle_moviles', String(Object.keys(ig).length));\n    setKpi('idle_tiempo', idle.length ? fmtSeconds(idleU.total) : '\u2014');\n    setKpi('idle_prom', idle.length ? hDur(hSum(idle, 'durationSeconds') / idle.length) : '\u2014');\n    setKpi('idle_mediana', idle.length ? hDur(hMedian(idle, 'durationSeconds')) : '\u2014');\n    var itopT = hTop(ig, function(x){ return hUnion(x).total; });\n    setKpi('idle_top_tiempo', itopT ? itopT.name + ' (' + fmtSeconds(itopT.value) + ')' : '\u2014');\n    // ---- PTO\n    var pg = hGroup(pto, 'movil'), ptop = hTop(pg, function(x){ return x.length; });\n    var rpms = pto.map(function(r){ return r.rpmPeak; }).filter(function(v){ return v != null; });\n    setKpi('pto_total', hNum(pto.length, 0)); setKpi('pto_moviles', String(Object.keys(pg).length));\n    setKpi('pto_rpm', rpms.length ? hNum(Math.max.apply(null, rpms), 0) + ' rpm' : '\u2014');\n    setKpi('pto_duracion', pto.length ? fmtSeconds(hSum(pto, 'durationSeconds')) : '\u2014');\n    setKpi('pto_prom', pto.length ? hDur(hSum(pto, 'durationSeconds') / pto.length) : '\u2014');\n    setKpi('pto_top_movil', ptop ? ptop.name + ' (' + hNum(ptop.value, 0) + ')' : '\u2014');\n    // ---- Narrativa din\u00e1mica\n    var nar = byId('hab-narrative');\n    if(nar){\n      var mg = hGroup(rows, 'movil'), mtop = hTop(mg, function(x){ return x.length; });\n      var byType = [['VELOCIDAD', speed.length], ['RALENT\u00cd', idle.length], ['PTO', pto.length]].sort(function(a, b){ return b[1] - a[1]; });\n      nar.textContent = rows.length\n        ? ('Con la selecci\u00f3n actual hay ' + hNum(rows.length, 0) + ' eventos operacionales en ' + movs + ' m\u00f3vil(es): ' + hNum(speed.length, 0) + ' de velocidad, ' + hNum(idle.length, 0) + ' de ralent\u00ed y ' + hNum(pto.length, 0) + ' de sobre-revoluci\u00f3n con PTO. El mayor volumen es ' + (byType[0][0] === 'PTO' ? 'PTO' : byType[0][0].toLowerCase()) + ' (' + decFmt(100 * byType[0][1] / rows.length) + ' %); el m\u00f3vil con m\u00e1s eventos es ' + mtop.name + ' (' + hNum(mtop.value, 0) + ').' + (idle.length ? ' El tiempo en ralent\u00ed es ' + fmtSeconds(idleU.total) + ' (uni\u00f3n de intervalos, sin doble conteo).' : ''))\n        : 'No hay eventos para esta selecci\u00f3n.';\n    }\n    // ---- Evoluci\u00f3n general\n    recomputeChart('hab_evolucion', function(){\n      var base = filterRowsCf(DASH.rows, 'dia'), days = {}, movDay = {};\n      DASH.dayLabels.forEach(function(d){ days[d] = {'VELOCIDAD': 0, 'RALENT\u00cd': 0, 'PTO': 0}; movDay[d] = {}; });\n      base.forEach(function(r){ if(days[r.dia]){ days[r.dia][r.habitType] = (days[r.dia][r.habitType] || 0) + 1; movDay[r.dia][r.movil] = 1; } });\n      var vals = DASH.dayLabels.map(function(d){ return days[d]['VELOCIDAD'] + days[d]['RALENT\u00cd'] + days[d]['PTO']; });\n      if(!vals.some(function(v){ return v > 0; })) return null;\n      return {categories: DASH.dayLabels, labels: DASH.dayLabels.map(function(d){ return (DASH.dayDisplay && DASH.dayDisplay[d]) || d; }), values: vals, stacks: DASH.dayLabels.map(function(d){ return days[d]; }),\n              moviles: DASH.dayLabels.map(function(d){ return Object.keys(movDay[d]).length; }),\n              average: vals.reduce(function(a, b){ return a + b; }, 0) / (vals.length || 1), colors: HAB_COLORS};\n    }, 'dia', 'Fecha');\n    recomputeChart('hab_tipos', function(){\n      var base = filterRowsCf(DASH.rows, 'habit_type'), tot = base.length || 1;\n      var items = ['VELOCIDAD', 'RALENT\u00cd', 'PTO'].map(function(t){ var n = hOf(base, t).length; return {name: t, value: n, pct: Math.round(n / tot * 1000) / 10, color: HAB_COLORS[t]}; });\n      if(!base.length) return null;\n      return {items: items, title: 'Eventos por tipo de h\u00e1bito'};\n    }, 'habit_type', 'Tipo de h\u00e1bito');\n    // ---- Velocidad\n    var vBase = hOf(filterRowsCf(DASH.rows, 'movil'), 'VELOCIDAD');\n    recomputeChart('hab_velocidad_ranking', function(){\n      return hRank(vBase, function(x){ return x.length; }, 'eventos', '#2563eb', function(x, q){\n        return ['Empresa: <b>' + q.empresa + '</b>', 'Reglas: <b>' + hRulesOf(x) + '</b>'];\n      });\n    }, 'movil', 'M\u00f3vil');\n    recomputeChart('hab_velocidad_reglas', function(){\n      var g = hGroup(hOf(filterRowsCf(DASH.rows, 'regla'), 'VELOCIDAD'), 'regla');\n      var items = Object.keys(g).map(function(k){ return {name: k, value: g[k].length, moviles: hDistinct(g[k], 'movil').length}; }).sort(function(a, b){ return b.value - a.value; });\n      return items.length ? {items: items, unit: 'eventos', color: '#2563eb', height: Math.max(120, items.length * 40)} : null;\n    }, 'regla', 'Regla');\n    // ---- Ralent\u00ed\n    var iBase = hOf(filterRowsCf(DASH.rows, 'movil'), 'RALENT\u00cd');\n    recomputeChart('hab_ralenti_eventos', function(){\n      return hRank(iBase, function(x){ return x.length; }, 'eventos', '#0891b2', function(x, q){\n        return ['Empresa: <b>' + q.empresa + '</b>', 'Tiempo (uni\u00f3n): <b>' + fmtSeconds(hUnion(x).total) + '</b>', 'Reglas: <b>' + hRulesOf(x) + '</b>'];\n      });\n    }, 'movil', 'M\u00f3vil');\n    recomputeChart('hab_ralenti_tiempo', function(){\n      var byDev = hUnion(iBase).byDev;\n      return hRank(iBase, function(x){ return byDev[x[0].idDevice] || 0; }, 'segundos', '#0e7490', function(x, q){\n        return ['Empresa: <b>' + q.empresa + '</b>', 'Tiempo (uni\u00f3n): <b>' + fmtSeconds(byDev[x[0].idDevice] || 0) + '</b>', 'Eventos: <b>' + x.length + '</b>'];\n      });\n    }, 'movil', 'M\u00f3vil');\n    recomputeChart('hab_bins', function(){\n      var base = hOf(filterRowsCf(DASH.rows, 'duration_bin'), 'RALENT\u00cd').filter(function(r){ return HAB_BINS.indexOf(r.durationBin) !== -1; });\n      var tot = base.length;\n      var items = HAB_BINS.map(function(b){ var n = base.filter(function(r){ return r.durationBin === b; }).length; return {name: b, value: n, extra: [hNum(tot ? 100 * n / tot : 0, 1) + ' % de los eventos de 5 min o m\u00e1s']}; });\n      return tot ? {items: items, unit: 'eventos', color: '#0891b2', height: 150} : null;\n    }, 'duration_bin', 'Rango de duraci\u00f3n');\n    // ---- PTO\n    var pBase = hOf(filterRowsCf(DASH.rows, 'movil'), 'PTO');\n    function ptoExtra(x, q){\n      var r = x.map(function(e){ return e.rpmPeak; }).filter(function(v){ return v != null; });\n      return ['Empresa: <b>' + q.empresa + '</b>', 'Duraci\u00f3n total: <b>' + fmtSeconds(hSum(x, 'durationSeconds')) + '</b>', 'Duraci\u00f3n promedio: <b>' + hDur(hSum(x, 'durationSeconds') / x.length) + '</b>', 'RPM pico m\u00e1x.: <b>' + (r.length ? hNum(Math.max.apply(null, r), 0) : 'N/D') + '</b>'];\n    }\n    recomputeChart('hab_pto_eventos', function(){ return hRank(pBase, function(x){ return x.length; }, 'eventos', '#7c3aed', ptoExtra); }, 'movil', 'M\u00f3vil');\n    recomputeChart('hab_pto_tiempo', function(){ return hRank(pBase, function(x){ return hSum(x, 'durationSeconds'); }, 'segundos', '#6d28d9', ptoExtra); }, 'movil', 'M\u00f3vil');\n    recomputeChart('hab_pto_rpm', function(){\n      return hRank(pBase, function(x){ var r = x.map(function(e){ return e.rpmPeak; }).filter(function(v){ return v != null; }); return r.length ? Math.max.apply(null, r) : 0; }, 'rpm', '#a78bfa', ptoExtra);\n    }, 'movil', 'M\u00f3vil');\n    // ---- Turnos (dimensi\u00f3n GLOBAL: todos los tipos de h\u00e1bito)\n    recomputeChart('hab_turnos', function(){\n      var base = filterRowsCf(DASH.rows, 'turno');\n      if(!base.length) return null;\n      var g = hGroup(base, 'shift');\n      var items = ['T1', 'T2', 'T3'].map(function(k){\n        var x = g[k] || [];\n        return {name: k, value: x.length, moviles: hDistinct(x, 'movil').length,\n                extra: ['Velocidad: <b>' + hOf(x, 'VELOCIDAD').length + '</b>', 'Ralent\u00ed: <b>' + hOf(x, 'RALENT\u00cd').length + '</b>', 'PTO: <b>' + hOf(x, 'PTO').length + '</b>']};\n      });\n      return {items: items, unit: 'eventos', color: '#2563eb', height: 150};\n    }, 'turno', 'Turno');\n    // ---- Distribuci\u00f3n por regla (todas las reglas, tipo como contexto)\n    recomputeChart('hab_reglas', function(){\n      var g = hGroup(filterRowsCf(DASH.rows, 'regla'), 'regla');\n      var items = Object.keys(g).map(function(k){ return {name: k, value: g[k].length, moviles: hDistinct(g[k], 'movil').length, extra: ['Tipo de h\u00e1bito: <b>' + g[k][0].habitType + '</b>']}; }).sort(function(a, b){ return b.value - a.value; });\n      return items.length ? {items: items, unit: 'eventos', color: '#2563eb', height: Math.max(200, items.length * 34)} : null;\n    }, 'regla', 'Regla');\n    [['velocidad', speed.length], ['ralenti', idle.length], ['pto', pto.length]].forEach(function(p){\n      var sec = byId(p[0]); if(sec) sec.classList.toggle('section-empty', p[1] === 0);\n    });\n  }\n  function fmtSeconds(v){v=Math.round(v||0);var h=Math.floor(v/3600),m=Math.floor((v%3600)/60);return h?(h+' h '+String(m).padStart(2,'0')+' min'):(m+' min');}\n  function recomputeDashboard(){\n    if(!DASH) return;\n    if(DASH.kind === 'habits_dashboard'){ recomputeHabitsDashboard(); return; }\n    var full = filterRowsCf(DASH.rows, null);\n    var fallasDistintas = full.length;\n    var movilesSet = {}; full.forEach(function(r){ movilesSet[r.movil] = 1; });\n    var movilesAfectados = Object.keys(movilesSet).length;\n    var flota = flotaForCf();\n    setKpi('fallas_distintas', fallasDistintas.toLocaleString('es-CO'));\n    setKpi('moviles_afectados', movilesAfectados + ' / ' + flota + ' (' + (flota ? decFmt(100 * movilesAfectados / flota) : '0,0') + ' %)');\n    if(fallasDistintas){\n      var altaRows = full.filter(function(r){ return r.criticidad === 'ALTA'; });\n      if(DASH.activeCrit.indexOf('ALTA') !== -1){\n        var altaMoviles = {}; altaRows.forEach(function(r){ altaMoviles[r.movil] = 1; });\n        setKpi('fallas_alta', altaRows.length + ' en ' + Object.keys(altaMoviles).length + ' m\u00f3vil(es)');\n      } else if(DASH.activeCrit.length){\n        var fb = DASH.activeCrit[0];\n        setKpi('fallas_alta', String(full.filter(function(r){ return r.criticidad === fb; }).length));\n      }\n      // DASH.hiddenCategories (opcional, 2026-10-03): categor\u00edas que el\n      // reporte pide excluir del KPI de sistema y del gr\u00e1fico por sistema\n      // (p.ej. 'Otro / Sin clasificar', que solo mete ruido). Esas fallas\n      // siguen contando en el total y en la tabla. El % se calcula sobre el\n      // total de fallas distintas.\n      var catCounts = countByField(full.filter(function(r){ return !isHiddenCategory(r.categoria); }), 'categoria');\n      var topCat = null, topCatN = -1;\n      Object.keys(catCounts).forEach(function(c){ if(catCounts[c] > topCatN){ topCat = c; topCatN = catCounts[c]; } });\n      setKpi('sistema_principal', topCat === null ? '\u2014' : topCat + ' (' + decFmt(100 * topCatN / fallasDistintas) + ' %)');\n      var movCounts = countByField(full, 'movil');\n      var top5 = Object.keys(movCounts).map(function(m){ return [m, movCounts[m]]; })\n        .sort(function(a, b){ return b[1] - a[1]; }).slice(0, 5);\n      var top5sum = top5.reduce(function(a, kv){ return a + kv[1]; }, 0);\n      setKpi('concentracion', decFmt(100 * top5sum / fallasDistintas) + ' % en ' + top5.length + ' m\u00f3viles');\n    } else {\n      setKpi('fallas_alta', '\u2014'); setKpi('sistema_principal', '\u2014'); setKpi('concentracion', '\u2014');\n    }\n\n    recomputeChart('evolucion_bar', function(){\n      if(!DASH.dayLabels.length) return null;\n      var base = filterRowsCf(DASH.rows, 'dia');\n      var perDay = {}; var movDia = {};\n      DASH.dayLabels.forEach(function(d){ perDay[d] = {}; movDia[d] = {}; });\n      base.forEach(function(r){\n        r.dias.forEach(function(d){\n          if(perDay[d] != null){ perDay[d][r.criticidad] = (perDay[d][r.criticidad] || 0) + 1; movDia[d][r.movil] = 1; }\n        });\n      });\n      var values = DASH.dayLabels.map(function(d){ return totalOfCounts(perDay[d]); });\n      var avg = values.length ? values.reduce(function(a, b){ return a + b; }, 0) / values.length : 0;\n      return {\n        categories: DASH.dayLabels, values: values,\n        breakdown: DASH.dayLabels.map(function(d){ return perDay[d]; }),\n        moviles: DASH.dayLabels.map(function(d){ return Object.keys(movDia[d]).length; }),\n        average: Math.round(avg * 10) / 10, color: CORPORATE_BLUE,\n      };\n    }, 'dia', 'Fecha');\n\n    recomputeChart('criticidad_donut', function(){\n      var base = filterRowsCf(DASH.rows, 'criticidad');\n      var counts = countByField(base, 'criticidad');\n      var total = DASH.activeCrit.reduce(function(a, c){ return a + (counts[c] || 0); }, 0) || 1;\n      var items = DASH.activeCrit.filter(function(c){ return counts[c]; }).map(function(c){\n        return {name: c, value: counts[c] || 0, pct: Math.round((counts[c] || 0) / total * 1000) / 10, color: DASH.critColors[c]};\n      });\n      return {items: items};\n    }, 'criticidad', 'Criticidad');\n\n    recomputeChart('sistemas_bar', function(){\n      var base = filterRowsCf(DASH.rows, 'sistema').filter(function(r){ return !isHiddenCategory(r.categoria); });\n      var groups = groupCriticidad(base, 'categoria');\n      var keys = Object.keys(groups);\n      if(!keys.length) return null;\n      var items = keys.map(function(g){\n        return {name: g, value: totalOfCounts(groups[g]), crit: dominantCrit(groups[g]), breakdown: groups[g]};\n      }).sort(function(a, b){ return b.value - a.value; });\n      return {items: items, unit: 'fallas', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};\n    }, 'sistema', 'Sistema');\n\n    recomputeChart('ranking_bar', function(){\n      var base = filterRowsCf(DASH.rows, 'movil');\n      var groups = groupCriticidad(base, 'movil');\n      var meta = {}; base.forEach(function(r){ meta[r.movil] = {placa: r.placa, tipo: r.tipo}; });\n      var keys = Object.keys(groups);\n      if(!keys.length) return null;\n      var items = keys.map(function(m){\n        return {\n          name: m, value: totalOfCounts(groups[m]), crit: dominantCrit(groups[m]), breakdown: groups[m],\n          placa: (meta[m] || {}).placa, tipo: (meta[m] || {}).tipo,\n        };\n      }).sort(function(a, b){ return b.value - a.value; }).slice(0, DASH.topNMoviles);\n      return {items: items, unit: 'fallas', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};\n    }, 'movil', 'M\u00f3vil');\n\n    recomputeChart('ranking_activaciones_bar', function(){\n      var base = filterRowsCf(DASH.rows, 'movil');\n      var act = {}; var groups = groupCriticidad(base, 'movil'); var meta = {};\n      base.forEach(function(r){\n        act[r.movil] = (act[r.movil] || 0) + r.activaciones;\n        meta[r.movil] = {placa: r.placa, tipo: r.tipo};\n      });\n      var keys = Object.keys(act);\n      if(!keys.length) return null;\n      var items = keys.map(function(m){\n        return {\n          name: m, value: act[m], crit: dominantCrit(groups[m]), breakdown: groups[m] || null,\n          placa: (meta[m] || {}).placa, tipo: (meta[m] || {}).tipo,\n        };\n      }).sort(function(a, b){ return b.value - a.value; }).slice(0, DASH.topNMoviles);\n      return {items: items, unit: 'activaciones', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};\n    }, 'movil', 'M\u00f3vil');\n\n    recomputeChart('diagnosticos_bar', function(){\n      var base = filterRowsCf(DASH.rows, 'diagnostico');\n      var moviles = {}; var crit = {};\n      base.forEach(function(r){\n        (moviles[r.codigo] = moviles[r.codigo] || {})[r.movil] = 1;\n        (crit[r.codigo] = crit[r.codigo] || {})[r.criticidad] = (crit[r.codigo][r.criticidad] || 0) + 1;\n      });\n      var keys = Object.keys(moviles);\n      if(!keys.length) return null;\n      var items = keys.map(function(c){\n        return {\n          name: c, value: Object.keys(moviles[c]).length, crit: dominantCrit(crit[c]), breakdown: crit[c],\n          moviles: Object.keys(moviles[c]).length,\n        };\n      }).sort(function(a, b){ return b.value - a.value; }).slice(0, DASH.topNDiag);\n      return {items: items, unit: 'm\u00f3viles', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};\n    }, 'diagnostico', 'Diagn\u00f3stico');\n\n    recomputeChart('diagnosticos_frecuentes_bar', function(){\n      var base = filterRowsCf(DASH.rows, 'diagnostico');\n      var act = {}; var moviles = {}; var crit = {};\n      base.forEach(function(r){\n        act[r.codigo] = (act[r.codigo] || 0) + r.activaciones;\n        (moviles[r.codigo] = moviles[r.codigo] || {})[r.movil] = 1;\n        (crit[r.codigo] = crit[r.codigo] || {})[r.criticidad] = (crit[r.codigo][r.criticidad] || 0) + 1;\n      });\n      var keys = Object.keys(act);\n      if(!keys.length) return null;\n      var items = keys.map(function(c){\n        return {\n          name: c, value: act[c], crit: dominantCrit(crit[c]), breakdown: crit[c] || null,\n          moviles: moviles[c] ? Object.keys(moviles[c]).length : 0,\n        };\n      }).sort(function(a, b){ return b.value - a.value; }).slice(0, DASH.topNDiag);\n      return {items: items, unit: 'activaciones', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};\n    }, 'diagnostico', 'Diagn\u00f3stico');\n\n    // Comparativos \u2014 misma forma \"pareto\" horizontal que Sistemas/Ranking\n    // (refinamiento visual 2026-09): nombres largos (empresas, tipos de\n    // veh\u00edculo) ya no chocan con las cifras \u2014 cada dato tiene su propia\n    // columna fija, en vez de una barra vertical con la etiqueta rotada.\n    function comparativeScaleMax(){\n      var max = 0;\n      [['tipo', 'tipo'], ['marca', 'marca'], ['empresa', 'empresa']].forEach(function(pair){\n        var dim = pair[0], field = CF_FIELD[dim];\n        var base = filterRowsCf(DASH.rows, dim);\n        var counts = countByField(base, field);\n        Object.keys(counts).forEach(function(g){\n          var size = DASH.fleetSizes[dim][g];\n          if(size) max = Math.max(max, Math.round(counts[g] / size * 100) / 100);\n        });\n      });\n      return max || 1;\n    }\n    var sharedComparisonMax = comparativeScaleMax();\n    [['tipo', 'Tipo de veh\u00edculo'], ['marca', 'Marca'], ['empresa', 'Empresa']].forEach(function(pair){\n      var dim = pair[0], label = pair[1];\n      recomputeChart(dim + '_bar', function(){\n        var base = filterRowsCf(DASH.rows, dim);\n        var field = CF_FIELD[dim];\n        var counts = countByField(base, field);\n        var groups = groupCriticidad(base, field);\n        var items = Object.keys(counts)\n          .filter(function(g){ return DASH.fleetSizes[dim][g]; })\n          .map(function(g){\n            return {name: g, value: Math.round(counts[g] / DASH.fleetSizes[dim][g] * 100) / 100, breakdown: groups[g] || null};\n          })\n          .sort(function(a, b){ return b.value - a.value; });\n        if(!items.length) return null;\n        return {items: items, unit: 'fallas/veh\u00edculo', color: CORPORATE_BLUE,\n                scaleMax: sharedComparisonMax, height: Math.max(200, 30 * items.length)};\n      }, dim, label);\n    });\n  }\n  function renderChips(){\n    var holder = byId('cf-chips-global');\n    if(!holder) return;\n    var keys = Object.keys(CF);\n    var banner = holder.closest('.cf-banner');\n    if(banner) banner.classList.toggle('active', keys.length > 0);\n    holder.innerHTML = '';\n    keys.forEach(function(key){\n      (CF[key] || []).forEach(function(val){\n        var chip = document.createElement('span'); chip.className = 'cf-chip';\n        chip.appendChild(document.createTextNode(CF_LABELS[key] + ': ' + val + ' '));\n        var btn = document.createElement('button'); btn.textContent = '\u00d7'; btn.title = 'Quitar este filtro';\n        btn.onclick = function(){ cfRemoveValue(key, val); };\n        chip.appendChild(btn);\n        holder.appendChild(chip);\n      });\n    });\n  }\n  function cellHasToken(cellStr, token){\n    return cellStr.split(',').map(function(s){ return s.trim(); }).indexOf(token) !== -1;\n  }\n\n  // ---- Tooltip inmediato compartido (sin el retardo del title nativo) ----\n  var TIP;\n  function ensureTip(){\n    if(!TIP){ TIP = document.createElement('div'); TIP.id = 'cf-tip'; document.body.appendChild(TIP); }\n    return TIP;\n  }\n  function bindTip(el, htmlFn){\n    el.addEventListener('mouseenter', function(e){\n      var tip = ensureTip(); tip.innerHTML = htmlFn(); tip.style.display = 'block'; positionTip(e);\n    });\n    el.addEventListener('mousemove', positionTip);\n    el.addEventListener('mouseleave', function(){ if(TIP) TIP.style.display = 'none'; });\n  }\n  function positionTip(e){\n    if(!TIP) return;\n    var x = e.clientX + 14, y = e.clientY + 14;\n    var maxX = window.innerWidth - TIP.offsetWidth - 10, maxY = window.innerHeight - TIP.offsetHeight - 10;\n    TIP.style.left = Math.min(x, Math.max(0, maxX)) + 'px';\n    TIP.style.top = Math.min(y, Math.max(0, maxY)) + 'px';\n  }\n\n  // ---- Barras (horizontal/vertical, apiladas o agrupadas) ----\n  function renderBar(container, spec){\n    var max=0;\n    spec.categories.forEach(function(_,i){\n      var total=0, maxSeries=0;\n      spec.series.forEach(function(s){ total+=(s.values[i]||0); maxSeries=Math.max(maxSeries,s.values[i]||0); });\n      max=Math.max(max, spec.stacked?total:maxSeries);\n    });\n    max = max||1;\n    var clickHint = spec.cfKey ? '<br><i style=\"opacity:.7\">Haz clic para filtrar</i>' : '';\n    if(spec.horizontal){\n      spec.categories.forEach(function(cat,i){\n        var row=document.createElement('div'); row.className='bar-row';\n        var label=document.createElement('div'); label.className='bar-label'; label.textContent=cat; label.title=cat;\n        var track=document.createElement('div'); track.className='bar-track';\n        var total=0;\n        var parts=[];\n        spec.series.forEach(function(s){\n          var v=s.values[i]||0; if(!v) return;\n          var seg=document.createElement('div'); seg.className='bar-seg';\n          seg.style.width=(v/max*100)+'%'; seg.style.background=s.color;\n          track.appendChild(seg); total+=v;\n          parts.push(s.name+': <b>'+v.toLocaleString('es-CO')+'</b>');\n        });\n        var val=document.createElement('div'); val.className='bar-value'; val.textContent=total.toLocaleString('es-CO');\n        row.appendChild(label); row.appendChild(track); row.appendChild(val);\n        bindTip(row, function(){ return '<b>'+cat+'</b><br>'+parts.join('<br>')+clickHint; });\n        if(spec.cfKey){\n          row.classList.add('cf-clickable');\n          row.setAttribute('data-cf-key', spec.cfKey);\n          row.setAttribute('data-cf-value', cat);\n          row.addEventListener('click', function(){ cfToggle(spec.cfKey, cat, spec.cfLabel||spec.cfKey); });\n        }\n        container.appendChild(row);\n      });\n    } else {\n      var wrap=document.createElement('div'); wrap.className='vbars';\n      var labels=document.createElement('div'); labels.className='vbars-labels';\n      spec.categories.forEach(function(cat,i){\n        var col=document.createElement('div'); col.className='vbar-col';\n        var total=0; var parts=[];\n        spec.series.forEach(function(s){\n          var v=s.values[i]||0; if(!v) return;\n          var seg=document.createElement('div'); seg.className='vbar-seg';\n          seg.style.height=(v/max*100)+'%'; seg.style.background=s.color;\n          col.appendChild(seg); total+=v;\n          parts.push(s.name+': <b>'+v.toLocaleString('es-CO')+'</b>');\n        });\n        var valLabel=document.createElement('div'); valLabel.className='vbar-value';\n        valLabel.textContent=total.toLocaleString('es-CO');\n        col.appendChild(valLabel);\n        bindTip(col, function(){ return '<b>'+cat+'</b><br>'+parts.join('<br>')+clickHint; });\n        if(spec.cfKey){\n          col.classList.add('cf-clickable');\n          col.setAttribute('data-cf-key', spec.cfKey);\n          col.setAttribute('data-cf-value', cat);\n          col.addEventListener('click', function(){ cfToggle(spec.cfKey, cat, spec.cfLabel||spec.cfKey); });\n        }\n        wrap.appendChild(col);\n        var lab=document.createElement('span'); lab.textContent=cat; lab.title=cat;\n        labels.appendChild(lab);\n      });\n      container.appendChild(wrap); container.appendChild(labels);\n    }\n    if(spec.series.length>1){\n      var legend=document.createElement('div'); legend.className='legend';\n      spec.series.forEach(function(s){\n        var sp=document.createElement('span');\n        var i=document.createElement('i'); i.style.background=s.color;\n        sp.appendChild(i); sp.appendChild(document.createTextNode(s.name));\n        legend.appendChild(sp);\n      });\n      container.appendChild(legend);\n    }\n  }\n\n  function renderEvoStack(container, spec){\n    var max = Math.max.apply(null, spec.values.concat([spec.average || 0, 1]));\n    var dense = spec.categories.length > 18;\n    var wrap = document.createElement('div'); wrap.className = 'vbars evo-wrap' + (dense ? ' dense' : '');\n    var labels = document.createElement('div'); labels.className = 'vbars-labels evo-labels' + (dense ? ' dense' : '');\n    var types = ['VELOCIDAD', 'RALENT\u00cd', 'PTO'];\n    spec.categories.forEach(function(cat, i){\n      var col = document.createElement('div'); col.className = 'vbar-col';\n      var v = spec.values[i] || 0, st = spec.stacks[i] || {};\n      var seg = document.createElement('div'); seg.className = 'vbar-seg evo-seg evo-stack';\n      seg.style.height = (v / max * 100) + '%';\n      types.forEach(function(t){\n        var n = st[t] || 0; if(!n || !v) return;\n        var part = document.createElement('div'); part.className = 'evo-part';\n        part.style.height = (n / v * 100) + '%'; part.style.background = spec.colors[t];\n        seg.appendChild(part);\n      });\n      var valLabel = document.createElement('div'); valLabel.className = 'evo-value';\n      var totalSpan = document.createElement('span'); totalSpan.className = 'evo-total'; totalSpan.textContent = v.toLocaleString('es-CO');\n      valLabel.appendChild(totalSpan); seg.appendChild(valLabel); col.appendChild(seg);\n      var mv = (spec.moviles && spec.moviles[i]) || 0;\n      bindTip(col, function(){\n        return '<b>' + ((spec.labels && spec.labels[i]) || cat) + '</b><br>' + v.toLocaleString('es-CO') + ' eventos \u00b7 ' + mv + ' m\u00f3vil(es)'\n          + types.map(function(t){ return '<br><span style=\"color:' + spec.colors[t] + '\">\u25a0</span> ' + t + ': <b>' + (st[t] || 0).toLocaleString('es-CO') + '</b>'; }).join('')\n          + (spec.cfKey ? '<br><i style=\"opacity:.7\">Haz clic para filtrar</i>' : '');\n      });\n      if(spec.cfKey){\n        col.classList.add('cf-clickable'); col.setAttribute('data-cf-key', spec.cfKey); col.setAttribute('data-cf-value', cat);\n        col.addEventListener('click', function(){ cfToggle(spec.cfKey, cat, spec.cfLabel || spec.cfKey); });\n      }\n      wrap.appendChild(col);\n      var shown = (spec.labels && spec.labels[i]) || cat; var lab = document.createElement('span'); lab.textContent = shown; lab.title = shown; labels.appendChild(lab);\n    });\n    if(spec.average){\n      var avgLine = document.createElement('div'); avgLine.className = 'avg-line';\n      avgLine.style.bottom = Math.min(100, spec.average / max * 100) + '%';\n      var avgTag = document.createElement('span'); avgTag.className = 'avg-tag';\n      avgTag.textContent = 'Promedio: ' + spec.average.toLocaleString('es-CO', {maximumFractionDigits: 1});\n      avgLine.appendChild(avgTag); wrap.appendChild(avgLine);\n    }\n    container.appendChild(wrap); container.appendChild(labels);\n    var legend = document.createElement('div'); legend.className = 'evo-legend';\n    types.forEach(function(t){ var sp = document.createElement('span'); sp.innerHTML = '<i style=\"background:' + spec.colors[t] + '\"></i>' + t; legend.appendChild(sp); });\n    container.appendChild(legend);\n  }\n\n  // ---- Criticidad transversal (refinamiento ejecutivo 2026-09) ----\n  var CRIT_ORDER = ['ALTA', 'MEDIA', 'BAJA'];\n  var CRIT_ABBR = {ALTA: 'A', MEDIA: 'M', BAJA: 'B'};\n  function critMiniParts(breakdown){\n    if(!breakdown) return [];\n    return CRIT_ORDER.filter(function(c){ return breakdown[c]; });\n  }\n  function buildCritMini(breakdown, extraClass){\n    var parts = critMiniParts(breakdown);\n    if(!parts.length) return null;\n    var wrap = document.createElement('div'); wrap.className = 'crit-mini' + (extraClass ? ' ' + extraClass : '');\n    parts.forEach(function(c){\n      var item = document.createElement('span'); item.className = 'cm-item'; item.title = c;\n      var letter = document.createElement('b'); letter.className = 'cm-' + c.toLowerCase(); letter.textContent = CRIT_ABBR[c];\n      item.appendChild(letter);\n      item.appendChild(document.createTextNode(breakdown[c]));\n      wrap.appendChild(item);\n    });\n    return wrap;\n  }\n  function critTipLine(breakdown){\n    var parts = critMiniParts(breakdown).map(function(c){ return c + ': <b>' + breakdown[c] + '</b>'; });\n    return parts.length ? parts.join(' \u00b7 ') : '';\n  }\n\n  // ---- Pareto ejecutivo (barra \u00fanica horizontal, orden mayor->menor) ----\n  function renderPareto(container, spec){\n    var max = 0;\n    spec.items.forEach(function(it){ max = Math.max(max, it.value || 0); });\n    max = spec.scaleMax || max || 1;\n    var clickHint = spec.cfKey ? '<br><i style=\"opacity:.7\">Haz clic para filtrar</i>' : '';\n    var hasCrit = false;\n    spec.items.forEach(function(it){\n      var row = document.createElement('div'); row.className = 'pareto-row';\n      var label = document.createElement('div'); label.className = 'bar-label'; label.title = it.name;\n      label.appendChild(document.createTextNode(it.name));\n      var value = document.createElement('div'); value.className = 'pareto-value';\n      var isTime = spec.unit === 'segundos';\n      var valueMain = document.createElement('strong'); valueMain.textContent = isTime ? hDur(it.value) : (it.value || 0).toLocaleString('es-CO', {maximumFractionDigits: 2});\n      var valueUnit = document.createElement('small'); valueUnit.textContent = isTime ? 'tiempo' : (spec.unit || 'valor');\n      value.appendChild(valueMain); value.appendChild(valueUnit);\n      var visual = document.createElement('div'); visual.className = 'pareto-visual';\n      var track = document.createElement('div'); track.className = 'bar-track';\n      var seg = document.createElement('div'); seg.className = 'bar-seg';\n      seg.style.width = (it.value / max * 100) + '%'; seg.style.background = spec.color || CORPORATE_BLUE;\n      track.appendChild(seg);\n      visual.appendChild(track);\n      var mini = buildCritMini(it.breakdown);\n      if(mini){ visual.appendChild(mini); hasCrit = true; }\n      row.appendChild(label); row.appendChild(value); row.appendChild(visual);\n\n      var tipLines = ['<b>' + it.name + '</b>', (isTime ? 'Tiempo' : (spec.unit || 'valor')) + ': <b>' + (isTime ? hDur(it.value) : (it.value || 0).toLocaleString('es-CO')) + '</b>'];\n      var critLine = critTipLine(it.breakdown);\n      if(critLine) tipLines.push(critLine);\n      if(it.activaciones != null) tipLines.push('Activaciones: <b>' + it.activaciones.toLocaleString('es-CO') + '</b>');\n      if(it.moviles != null && spec.unit !== 'm\u00f3viles') tipLines.push('M\u00f3viles: <b>' + it.moviles.toLocaleString('es-CO') + '</b>');\n      if(it.placa) tipLines.push('Placa: <b>' + it.placa + '</b>');\n      if(it.tipo) tipLines.push('Tipo: <b>' + it.tipo + '</b>');\n      if(it.extra) it.extra.forEach(function(line){ tipLines.push(line); });\n      bindTip(row, function(){ return tipLines.join('<br>') + clickHint; });\n\n      if(spec.cfKey){\n        row.classList.add('cf-clickable');\n        row.setAttribute('data-cf-key', spec.cfKey);\n        row.setAttribute('data-cf-value', it.name);\n        row.addEventListener('click', function(){ cfToggle(spec.cfKey, it.name, spec.cfLabel || spec.cfKey); });\n      }\n      container.appendChild(row);\n    });\n    if(spec.scaleMax){\n      var scale = document.createElement('p'); scale.className = 'chart-scale';\n      scale.textContent = 'Escala compartida: 0\u2013' + spec.scaleMax.toLocaleString('es-CO', {maximumFractionDigits: 2}) + ' ' + (spec.unit || '');\n      container.appendChild(scale);\n    }\n    if(hasCrit){\n      var key = document.createElement('div'); key.className = 'crit-key';\n      key.innerHTML = '<span><b class=\"cm-alta\">A</b> Alta</span><span><b class=\"cm-media\">M</b> Media</span><span><b class=\"cm-baja\">B</b> Baja</span>';\n      container.appendChild(key);\n    }\n  }\n\n  // ---- Evoluci\u00f3n ejecutiva (barra \u00fanica por d\u00eda + l\u00ednea de promedio) ----\n  function renderEvolution(container, spec){\n    var refs = spec.values.concat([spec.average || 0, 1]);\n    var max = Math.max.apply(null, refs);\n    var dense = spec.categories.length > 18;\n    var wrap = document.createElement('div'); wrap.className = 'vbars evo-wrap' + (dense ? ' dense' : '');\n    var labels = document.createElement('div'); labels.className = 'vbars-labels evo-labels' + (dense ? ' dense' : '');\n    var clickHint = spec.cfKey ? '<br><i style=\"opacity:.7\">Haz clic para filtrar</i>' : '';\n    spec.categories.forEach(function(cat, i){\n      var col = document.createElement('div'); col.className = 'vbar-col';\n      var v = spec.values[i] || 0;\n      var bd = (spec.breakdown && spec.breakdown[i]) || {};\n      var seg = document.createElement('div'); seg.className = 'vbar-seg evo-seg';\n      seg.style.height = (v / max * 100) + '%'; seg.style.background = spec.color || CORPORATE_BLUE;\n      var valLabel = document.createElement('div'); valLabel.className = 'evo-value';\n      var totalSpan = document.createElement('span'); totalSpan.className = 'evo-total'; totalSpan.textContent = v.toLocaleString('es-CO');\n      valLabel.appendChild(totalSpan);\n      var mini = buildCritMini(bd, 'evo-mini');\n      if(mini) valLabel.appendChild(mini);\n      seg.appendChild(valLabel);\n      col.appendChild(seg);\n      var mv = (spec.moviles && spec.moviles[i]) || 0;\n      bindTip(col, function(){\n        var critLine = critTipLine(bd);\n        return '<b>' + cat + '</b><br>' + v.toLocaleString('es-CO') + ' fallas distintas \u00b7 ' + mv + ' m\u00f3vil(es) afectados'\n          + (critLine ? '<br>' + critLine : '') + clickHint;\n      });\n      if(spec.cfKey){\n        col.classList.add('cf-clickable');\n        col.setAttribute('data-cf-key', spec.cfKey);\n        col.setAttribute('data-cf-value', cat);\n        col.addEventListener('click', function(){ cfToggle(spec.cfKey, cat, spec.cfLabel || spec.cfKey); });\n      }\n      wrap.appendChild(col);\n      var lab = document.createElement('span'); lab.textContent = cat; lab.title = cat;\n      labels.appendChild(lab);\n    });\n    if(spec.average){\n      var avgLine = document.createElement('div'); avgLine.className = 'avg-line';\n      avgLine.style.bottom = Math.min(100, spec.average / max * 100) + '%';\n      var avgTag = document.createElement('span'); avgTag.className = 'avg-tag';\n      avgTag.textContent = 'Promedio: ' + spec.average.toLocaleString('es-CO', {maximumFractionDigits: 1});\n      avgLine.appendChild(avgTag);\n      wrap.appendChild(avgLine);\n    }\n    container.appendChild(wrap); container.appendChild(labels);\n  }\n\n  // ---- Criticidad transversal \u2014 franja compacta pegada al Resumen ejecutivo ----\n  function renderDistributionBar(container, spec){\n    var items = spec.items.filter(function(it){ return it.value > 0; });\n    var total = items.reduce(function(a, it){ return a + it.value; }, 0) || 1;\n    var wrap = document.createElement('div'); wrap.className = 'crit-strip';\n    var head = document.createElement('span'); head.className = 'crit-strip-head'; head.textContent = spec.title || 'Criticidad de las fallas';\n    wrap.appendChild(head);\n    var clickHint = spec.cfKey ? '<br><i style=\"opacity:.7\">Haz clic para filtrar</i>' : '';\n    items.forEach(function(it){\n      var pill = document.createElement('span'); pill.className = 'crit-pill';\n      var dot = document.createElement('i'); dot.className = 'crit-pill-dot'; dot.style.background = it.color;\n      var name = document.createElement('span'); name.className = 'crit-pill-name'; name.textContent = it.name;\n      var val = document.createElement('b'); val.textContent = it.value.toLocaleString('es-CO');\n      var pct = document.createElement('small'); pct.textContent = it.pct + ' %';\n      pill.appendChild(dot); pill.appendChild(name); pill.appendChild(val); pill.appendChild(pct);\n      bindTip(pill, function(){ return it.name + ': <b>' + it.value.toLocaleString('es-CO') + '</b> (' + it.pct + '%)' + clickHint; });\n      if(spec.cfKey){\n        pill.classList.add('cf-clickable');\n        pill.setAttribute('data-cf-key', spec.cfKey);\n        pill.setAttribute('data-cf-value', it.name);\n        pill.addEventListener('click', function(){ cfToggle(spec.cfKey, it.name, spec.cfLabel || spec.cfKey); });\n      }\n      wrap.appendChild(pill);\n    });\n    var bar = document.createElement('div'); bar.className = 'crit-strip-bar';\n    items.forEach(function(it){\n      var seg = document.createElement('span'); seg.style.width = (it.value / total * 100) + '%'; seg.style.background = it.color;\n      bar.appendChild(seg);\n    });\n    wrap.appendChild(bar);\n    container.appendChild(wrap);\n  }\n\n  // ---- Timeline (episodios como barras horizontales por rango) ----\n  function renderTimeline(container, spec){\n    var span=(spec.max-spec.min)||1;\n    spec.rows.forEach(function(r){\n      var row=document.createElement('div'); row.className='timeline-row';\n      var label=document.createElement('div'); label.className='timeline-label'; label.textContent=r.label; label.title=r.label;\n      var track=document.createElement('div'); track.className='timeline-track';\n      var bar=document.createElement('div'); bar.className='timeline-bar';\n      var left=(r.start-spec.min)/span*100, width=Math.max((r.end-r.start)/span*100, 0.6);\n      bar.style.left=left+'%'; bar.style.width=width+'%'; bar.style.background=r.color;\n      bar.title=r.tooltip||r.label;\n      track.appendChild(bar);\n      row.appendChild(label); row.appendChild(track);\n      container.appendChild(row);\n    });\n  }\n\n  function initCharts(){\n    document.querySelectorAll('.chart[data-src]').forEach(function(el){\n      try {\n        var spec=readData(el.getAttribute('data-src'));\n        if(!spec || spec.deferred) return;\n        var kind = el.dataset.kind;\n        if(kind==='bar') renderBar(el, spec);\n        else if(kind==='pareto') renderPareto(el, spec);\n        else if(kind==='evolution') renderEvolution(el, spec);\n        else if(kind==='distribution') renderDistributionBar(el, spec);\n        else if(kind==='timeline') renderTimeline(el, spec);\n        else throw new Error('Tipo de gr\u00e1fica no soportado: ' + kind);\n      } catch(error) {\n        console.error('[Telemetry report] No se pudo renderizar la gr\u00e1fica ' + (el.id || '(sin id)'), error);\n        el.innerHTML = '';\n        var message = document.createElement('div');\n        message.className = 'chart-render-error';\n        message.textContent = 'No se pudo renderizar esta gr\u00e1fica';\n        el.appendChild(message);\n      }\n    });\n  }\n\n  function escHtml(s){\n    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');\n  }\n\n  // ---- Tablas: b\u00fasqueda + orden + paginaci\u00f3n ----\n  function initTables(){\n    document.querySelectorAll('.table-card[data-src]').forEach(function(card){\n      var payload=readData(card.getAttribute('data-src'));\n      if(!payload) return;\n      var columns=payload.columns, rows=payload.rows.slice(), pageSize=payload.pageSize||20;\n      var state={page:0, sortCol:-1, sortDir:1, filter:''};\n      var scroll=card.querySelector('.table-scroll');\n      var search=card.querySelector('.table-search');\n      var pager=card.querySelector('.table-pager');\n      var sortSelect=card.querySelector('.table-sort-mobile');\n      var sortDirBtn=card.querySelector('.table-sort-dir');\n      var crossfilter=payload.crossfilter||[];\n      var secondaryNames = payload.secondaryColumns || [];\n      var secondaryIdx = secondaryNames.map(function(n){ return columns.indexOf(n); }).filter(function(i){ return i >= 0; });\n      var primaryIdx = columns.map(function(_, i){ return i; }).filter(function(i){ return secondaryIdx.indexOf(i) === -1; });\n\n      if(sortSelect){\n        primaryIdx.forEach(function(i){\n          var opt=document.createElement('option'); opt.value=String(i); opt.textContent=columns[i];\n          sortSelect.appendChild(opt);\n        });\n        sortSelect.addEventListener('change', function(){\n          state.sortCol = parseInt(sortSelect.value, 10); state.sortDir = 1; render();\n        });\n      }\n      if(sortDirBtn){\n        sortDirBtn.addEventListener('click', function(){\n          state.sortDir *= -1; render();\n        });\n      }\n      function syncSortControls(){\n        if(sortSelect && state.sortCol >= 0) sortSelect.value = String(state.sortCol);\n        if(sortDirBtn) sortDirBtn.textContent = state.sortDir === 1 ? '\u2193' : '\u2191';\n      }\n\n      function cellText(c){ return (c&&typeof c==='object') ? String(c.text||'') : String(c); }\n      function cellMatchesAny(cell, mapping, values){\n        var text = cellText(cell);\n        return values.some(function(v){\n          return mapping.match === 'contains' ? cellHasToken(text, v) : mapping.match === 'prefix' ? text.indexOf(v) === 0 : text === v;\n        });\n      }\n      function filtered(){\n        var list=rows;\n        if(state.filter){\n          var q=state.filter.toLowerCase();\n          list=list.filter(function(r){ return r.some(function(c){return cellText(c).toLowerCase().indexOf(q)!==-1;}); });\n        }\n        Object.keys(CF).forEach(function(key){\n          var mapping = crossfilter.filter(function(m){ return m.key === key; })[0];\n          if(!mapping) return;\n          var idx = columns.indexOf(mapping.column);\n          if(idx < 0) return;\n          var values = CF[key];\n          list = list.filter(function(r){ return cellMatchesAny(r[idx], mapping, values); });\n        });\n        return list;\n      }\n      function sorted(list){\n        if(state.sortCol<0) return list;\n        var idx=state.sortCol, dir=state.sortDir;\n        return list.slice().sort(function(a,b){\n          var ca=a[idx], cb=b[idx];\n          if(ca && cb && typeof ca==='object' && typeof cb==='object' && ca.sort!=null && cb.sort!=null) return (ca.sort-cb.sort)*dir;\n          var x=cellText(ca), y=cellText(cb);\n          var nx=parseFloat(x.replace(/\\./g,'').replace(',','.')), ny=parseFloat(y.replace(/\\./g,'').replace(',','.'));\n          var cmp = (!isNaN(nx)&&!isNaN(ny)) ? (nx-ny) : x.localeCompare(y,'es');\n          return cmp*dir;\n        });\n      }\n      function renderCellInto(td, c, colName){\n        if(c && typeof c === 'object' && c.href){\n          var a=document.createElement('a'); a.href=c.href; a.target='_blank'; a.rel='noopener noreferrer';\n          a.textContent=c.text||c.href; a.className='ext-link'; td.appendChild(a);\n          return;\n        }\n        var text = cellText(c);\n        td.textContent = text;\n        if(text) td.title = text;\n        if(colName === 'Diagn\u00f3stico') td.classList.add('dt-cell-wide');\n        else if(colName === 'Categor\u00eda') td.classList.add('dt-cell-narrow');\n      }\n      function render(){\n        var data=sorted(filtered());\n        var totalPages=Math.max(1, Math.ceil(data.length/pageSize));\n        state.page=Math.min(state.page, totalPages-1);\n        var pageRows=data.slice(state.page*pageSize, state.page*pageSize+pageSize);\n        if(!data.length){\n          scroll.innerHTML='<p style=\"color:var(--muted);font-size:12.5px;padding:8px 2px\">Sin resultados para esta selecci\u00f3n.</p>';\n          pager.innerHTML=''; return;\n        }\n        syncSortControls();\n        var table=document.createElement('table'); table.className='dt' + (secondaryIdx.length ? ' dt-compact' : '');\n        var thead=document.createElement('thead'); var htr=document.createElement('tr');\n        primaryIdx.forEach(function(i){\n          var col = columns[i];\n          var th=document.createElement('th'); th.textContent=col;\n          if(i===state.sortCol) th.className = state.sortDir===1?'sort-asc':'sort-desc';\n          th.addEventListener('click', function(){\n            if(state.sortCol===i) state.sortDir*=-1; else {state.sortCol=i; state.sortDir=1;}\n            render();\n          });\n          htr.appendChild(th);\n        });\n        thead.appendChild(htr); table.appendChild(thead);\n        var tbody=document.createElement('tbody');\n        pageRows.forEach(function(r, visibleIndex){\n          var stripe = card.id === 't_maestra' ? (visibleIndex % 2 ? ' dt-row-even' : ' dt-row-odd') : '';\n          var tr=document.createElement('tr');\n          if(secondaryIdx.length) tr.className = 'dt-row-primary';\n          tr.className += stripe;\n          primaryIdx.forEach(function(i){\n            var td=document.createElement('td');\n            td.setAttribute('data-label', columns[i]);\n            renderCellInto(td, r[i], columns[i]);\n            tr.appendChild(td);\n          });\n          tbody.appendChild(tr);\n          if(secondaryIdx.length){\n            var parts = secondaryIdx.map(function(i){\n              var text = cellText(r[i]);\n              return text ? ('<b>' + escHtml(columns[i]) + ':</b> ' + escHtml(text)) : null;\n            }).filter(function(p){ return p; });\n            if(parts.length){\n              var trS = document.createElement('tr'); trS.className = 'dt-row-secondary' + stripe;\n              var tdS = document.createElement('td'); tdS.colSpan = primaryIdx.length;\n              tdS.innerHTML = parts.join(' &nbsp;\u00b7&nbsp; ');\n              trS.appendChild(tdS);\n              tbody.appendChild(trS);\n            }\n          }\n        });\n        table.appendChild(tbody);\n        scroll.innerHTML=''; scroll.appendChild(table);\n        pager.innerHTML='';\n        var info=document.createElement('span');\n        info.textContent = data.length ? ('Mostrando '+(state.page*pageSize+1)+'\u2013'+Math.min(data.length,(state.page+1)*pageSize)+' de '+data.length) : 'Sin resultados';\n        var prev=document.createElement('button'); prev.textContent='Anterior'; prev.disabled=state.page<=0;\n        prev.onclick=function(){state.page--; render();};\n        var next=document.createElement('button'); next.textContent='Siguiente'; next.disabled=state.page>=totalPages-1;\n        next.onclick=function(){state.page++; render();};\n        pager.appendChild(info); pager.appendChild(prev); pager.appendChild(next);\n      }\n      if(search) search.addEventListener('input', function(e){ state.filter=e.target.value; state.page=0; render(); });\n      if(crossfilter.length) CF_TABLES.push(function(){ state.page=0; render(); });\n      render();\n    });\n  }\n\n  function runInitPhase(name, fn){\n    try { fn(); }\n    catch(error) { console.error('[Telemetry report] Fall\u00f3 la inicializaci\u00f3n de ' + name, error); }\n  }\n\n  document.addEventListener('DOMContentLoaded', function(){\n    runInitPhase('dashboard', loadDashboard);\n    runInitPhase('gr\u00e1ficas', initCharts);\n    runInitPhase('rec\u00e1lculo', recomputeDashboard);\n    runInitPhase('tablas', initTables);\n  });\n})();\n";

  // Plantilla del reporte de Operaciones (hábitos) -- mismo mecanismo de
  // incrustación que PLANTILLA_HTML_EMBEBIDA en el add-in de Mantenimiento
  // (mantenimiento.js, antes reportes.js): generada con json.dumps() desde
  // reporte_operaciones_plantilla.html, incrustada como string (NO fetch en
  // tiempo de ejecución, mismo bug real de 404 dentro de MyGeotab ya
  // documentado). Usa el MISMO motor (MOTOR_JS_EMBEBIDO, duplicado verbatim
  // en este archivo) -- no hace falta una segunda copia, el motor ya soporta
  // DASH.kind==='habits_dashboard'.
  var PLANTILLA_OPERACIONES_EMBEBIDA = "<!doctype html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>An\u00e1lisis y Reporte de Operaciones</title>\n<style>\n:root{--ink:#0b2454;--accent:#0891b2;--corp:#2563eb;--muted:#64748b;--border:#e2e8f0;--bg:#f8fafc;--card:#ffffff;\n      --alta:#dc2626;--media:#f59e0b;--baja:#94a3b8;--good:#16a34a}\n*{box-sizing:border-box}\nbody{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:#1e293b;font-size:14px}\nheader.brand{background:var(--ink);color:#fff;padding:20px 28px}\nheader.brand .name{font-size:12px;opacity:.75;letter-spacing:.04em;text-transform:uppercase}\nheader.brand h1{margin:4px 0 2px;font-size:22px}\nheader.brand .subtitle{opacity:.85;font-size:13px}\n.executive-report-header{background:linear-gradient(115deg,#0b2454 0%,#12376f 72%,#0b2454 100%);padding:28px clamp(22px,5vw,64px) 26px;color:#fff}\n.executive-report-header .eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#a9c7ed;font-weight:700}\n.executive-report-header h1{margin:7px 0 5px;font-size:clamp(27px,3vw,40px);line-height:1.08;letter-spacing:-.02em}\n.executive-report-header .scope{font-size:clamp(15px,1.5vw,19px);font-weight:650;color:#dbeafe;letter-spacing:.01em}\n.executive-report-header .purpose{margin:13px 0 22px;max-width:760px;color:#cbd8eb;font-size:14px;line-height:1.45}\n.executive-report-header .header-grid{display:grid;grid-template-columns:minmax(260px,1.7fr) repeat(2,minmax(180px,1fr));gap:12px;align-items:stretch}\n.executive-report-header .header-item{border-top:1px solid rgba(191,219,254,.35);padding-top:10px;min-width:0}\n.executive-report-header .header-item.period{border-top:0;background:#fff;color:var(--ink);border-radius:8px;padding:14px 16px}\n.executive-report-header .header-label{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.09em;font-weight:750;color:#a9c7ed;margin-bottom:5px}\n.executive-report-header .period .header-label{color:#64748b}\n.executive-report-header .period-value{font-size:clamp(17px,1.8vw,23px);font-weight:750;line-height:1.2;white-space:normal}\n.executive-report-header .period-detail{display:block;margin-top:5px;font-size:12px;color:#64748b}\n.executive-report-header .header-value{font-size:14px;line-height:1.35;color:#f8fafc}\n.executive-report-header .status-value{display:flex;align-items:center;gap:7px;font-weight:750}\n.executive-report-header .status-dot{width:8px;height:8px;border-radius:50%;background:#4ade80;flex:none}\n.executive-report-header .status-dot.warn{background:#fbbf24}.executive-report-header .status-dot.bad{background:#f87171}\n.report-fault .legacy-report-header,.report-habits .legacy-report-header{display:none}\n.executive-report-header .status-detail{display:block;margin-top:4px;font-size:11px;color:#cbd8eb;line-height:1.35}\n@media (max-width:900px){.executive-report-header .header-grid{grid-template-columns:1fr 1fr}.executive-report-header .period{grid-column:1/-1}}\n@media (max-width:600px){.executive-report-header{padding:22px 18px}.executive-report-header .header-grid{grid-template-columns:1fr;gap:14px}.executive-report-header .period{grid-column:auto}.executive-report-header .purpose{margin-bottom:18px}}\n.meta{display:flex;flex-wrap:wrap;gap:18px;margin-top:12px;font-size:12px}\n.meta div b{display:block;font-size:12px;opacity:.7;font-weight:600}\n.layout{display:flex;max-width:1520px;margin:0 auto}\nnav.toc{width:210px;flex:none;padding:20px 12px;position:sticky;top:0;align-self:flex-start;max-height:100vh;overflow:auto}\nnav.toc a{display:block;padding:7px 10px;border-radius:6px;color:#334155;text-decoration:none;font-size:13px;margin-bottom:2px}\nnav.toc a:hover{background:#e2e8f0}\nmain{flex:1;min-width:0;padding:20px 28px 60px}\n.filters-box{background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:10px 14px;margin-bottom:18px;font-size:12.5px;color:#3730a3}\n.filters-box summary{cursor:pointer;font-weight:600}\nsection{margin-bottom:34px;scroll-margin-top:14px}\nsection h2{font-size:19px;line-height:1.2;color:var(--ink);border-bottom:2px solid var(--border);padding-bottom:9px;margin:0 0 16px}\n.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:18px}\n.kpi{background:var(--card);border:1px solid var(--border);border-left:4px solid #cbd5e1;border-radius:8px;\n  padding:10px 14px;min-width:150px}\n.kpi b{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:19px;font-weight:800;color:var(--ink)}\n.kpi .kpi-caption{font-size:12px;font-weight:600;color:var(--muted)}\n.kpi span:last-child{display:block;margin-top:2px;font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}\n.kpi--priority{min-width:170px}\n.kpi--priority b{font-size:24px}\n.kpi--risk-high{border-left-color:var(--alta);background:#fef2f2}\n.kpi--risk-high b{color:#991b1b}\n.kpi--risk-mid{border-left-color:var(--media);background:#fffbeb}\n.kpi--risk-mid b{color:#92400e}\n.kpi--accent-blue{border-left-color:var(--corp);background:#eff6ff}\n.kpi--accent-blue b{color:#1e40af}\n.narrative{background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:12px 16px;margin-bottom:16px}\n.narrative li{margin-bottom:4px}\n.narrative p{margin:0}\n.charts-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:16px;margin-bottom:14px;align-items:start}\n.chart-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:17px 18px;min-width:0;box-shadow:0 1px 2px rgba(15,23,42,.04)}\n.chart-card h3{margin:0;font-size:15px;line-height:1.3;color:var(--ink);font-weight:800}\n.chart-render-error{display:flex;align-items:center;justify-content:center;min-height:140px;padding:18px;text-align:center;color:#991b1b;background:#fef2f2;border:1px dashed #fecaca;border-radius:8px;font-weight:650}\n.chart-subtitle{margin:5px 0 8px;font-size:12px;color:var(--muted);line-height:1.48;max-width:78ch}\n.chart-hint{display:inline-flex;margin:0 0 12px;padding:3px 8px;border-radius:999px;background:#f1f5f9;font-size:10px;color:#64748b;font-style:normal;font-weight:650}\n.report-habits #resumen .charts-row{grid-template-columns:minmax(0,1fr)}\n.report-habits #velocidad .charts-row,.report-habits #ralenti .charts-row,\n.report-habits #pto .charts-row,.report-habits #turnos .charts-row{grid-template-columns:repeat(2,minmax(0,1fr))}\ntable.dt{width:100%;border-collapse:collapse;font-size:12.5px}\ntable.dt thead th{background:var(--ink);color:#fff;text-align:left;padding:7px 9px;position:sticky;top:0;cursor:pointer;white-space:nowrap}\ntable.dt thead th:after{content:'';opacity:.5;margin-left:4px}\ntable.dt thead th.sort-asc:after{content:'\u25b2'}\ntable.dt thead th.sort-desc:after{content:'\u25bc'}\ntable.dt tbody td{padding:6px 9px;border-bottom:1px solid var(--border)}\ntable.dt tbody tr:nth-child(even){background:#f8fafc}\ntable.dt.dt-compact tbody tr:nth-child(even){background:transparent}\ntable.dt tbody tr.dt-row-primary td{border-bottom:none;padding-top:8px}\ntable.dt tbody tr.dt-row-secondary td{padding:1px 9px 9px;border-bottom:1px solid var(--border);\n  font-size:11px;color:var(--muted);line-height:1.7;background:#fbfcfd}\ntable.dt tbody tr.dt-row-secondary td b{color:#475569;font-weight:700}\ntable.dt tbody tr.dt-row-primary:hover td{background:#f1f5f9}\ntable.dt tbody tr.dt-row-primary:hover + tr.dt-row-secondary td{background:#eef2f7}\n.dt-cell-wide{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dt-cell-narrow{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.table-sort-mobile-wrap{display:none;align-items:center;gap:6px}\n.table-sort-mobile{padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:#fff}\n.table-sort-dir{border:1px solid var(--border);background:#fff;border-radius:6px;padding:6px 10px;font-size:13px;cursor:pointer;line-height:1}\n.table-sort-dir:hover{background:#f1f5f9}\n.table-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px;overflow:hidden}\n.master-table{border-color:#bfdbfe;box-shadow:0 0 0 1px #eff6ff}\n.cf-banner{display:none;flex-direction:column;gap:8px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;\n  border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:12.5px}\n.cf-banner.active{display:flex}\n.cf-banner .cf-banner-title{font-weight:700;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;opacity:.8}\n.cf-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}\n.cf-chip{display:inline-flex;align-items:center;gap:6px;background:#dbeafe;color:#1e3a8a;border-radius:999px;\n  padding:3px 6px 3px 12px;font-size:12px;font-weight:600}\n.cf-chip button{border:none;background:#bfdbfe;color:#1e3a8a;border-radius:50%;width:18px;height:18px;line-height:1;\n  cursor:pointer;font-size:12px;font-weight:700}\n.cf-chip button:hover{background:#93c5fd}\n.cf-banner .cf-clear-all{align-self:flex-start;border:1px solid #93c5fd;background:#fff;color:#1e40af;border-radius:6px;\n  padding:3px 10px;font-size:11.5px;cursor:pointer}\n.cf-banner .cf-clear-all:hover{background:#dbeafe}\n#cf-tip{position:fixed;z-index:9999;background:#0b2454;color:#fff;padding:6px 10px;border-radius:6px;font-size:12px;\n  line-height:1.5;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.25);display:none;max-width:260px}\n#cf-tip b{font-weight:700}\n.table-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}\n.table-toolbar input{padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:12.5px;min-width:200px}\n.table-scroll{overflow-x:auto}\n.table-pager{display:flex;gap:8px;align-items:center;margin-top:10px;font-size:12px;color:var(--muted)}\n.table-pager button{border:1px solid var(--border);background:#fff;border-radius:6px;padding:3px 10px;cursor:pointer}\n.table-pager button:disabled{opacity:.4;cursor:default}\n.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;border-radius:6px;transition:opacity .15s}\n.bar-row.cf-clickable{cursor:pointer}\n.bar-row.cf-clickable:hover{background:#f1f5f9}\n.cf-dim{opacity:.32}\n.cf-selected{outline:2px solid var(--accent);outline-offset:1px;border-radius:4px}\n.vbar-col.cf-clickable{cursor:pointer}\n.legend span.cf-clickable{cursor:pointer;padding:1px 6px;border-radius:5px;transition:opacity .15s}\n.legend span.cf-clickable:hover{background:#f1f5f9}\n.bar-label{width:170px;flex:none;display:flex;align-items:center;justify-content:flex-end;gap:0;font-size:12px;\n  color:#334155;text-align:right;line-height:1.25;white-space:normal;overflow:hidden;word-break:break-word}\n.bar-track{flex:1;background:#eef2f7;border-radius:4px;height:16px;position:relative;display:flex}\n.bar-seg{height:100%}\n.bar-seg:first-child{border-radius:4px 0 0 4px}\n.bar-value{font-size:11px;color:var(--muted);width:56px;flex:none}\n.vbars{position:relative;display:flex;align-items:flex-end;gap:6px;height:180px;border-bottom:1px solid var(--border);padding-bottom:2px}\n.vbar-col{flex:1;display:flex;flex-direction:column-reverse;align-items:stretch;height:100%;position:relative;transition:opacity .15s}\n.vbar-seg{width:100%}\n.vbar-value{position:absolute;bottom:100%;left:0;right:0;text-align:center;font-size:10.5px;font-weight:700;color:#334155;margin-bottom:2px}\n.vbars-labels{display:flex;gap:6px;margin-top:4px}\n.vbars-labels span{flex:1;text-align:center;font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.evo-labels.dense span{visibility:hidden}\n.evo-labels.dense span:nth-child(3n+1),.evo-labels.dense span:last-child{visibility:visible}\n.evo-wrap.dense .evo-mini{display:none}\n.legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:12px}\n.legend span{display:inline-flex;align-items:center;gap:5px}\n.legend i{width:10px;height:10px;border-radius:3px;display:inline-block}\n.pareto-row{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:'label value' 'visual visual';gap:7px 14px;padding:9px 5px;border-bottom:1px solid #edf2f7;border-radius:7px;transition:opacity .15s}\n.pareto-row:last-of-type{border-bottom:none}\n.pareto-row.cf-clickable{cursor:pointer}\n.pareto-row.cf-clickable:hover{background:#f1f5f9}\n.pareto-row .bar-label{grid-area:label;width:auto;justify-content:flex-start;text-align:left;font-size:12px;font-weight:700;color:#334155;overflow:visible;overflow-wrap:anywhere}\n.pareto-value{grid-area:value;display:flex;align-items:baseline;justify-content:flex-end;gap:5px;white-space:nowrap;color:var(--ink)}\n.pareto-value strong{font-size:14px;font-weight:850}\n.pareto-value small{font-size:9.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.025em}\n.pareto-visual{grid-area:visual;display:grid;grid-template-columns:minmax(70px,1fr) auto;align-items:center;gap:12px;min-width:0}\n.pareto-visual .bar-track{height:10px;border-radius:999px;overflow:hidden}\n.pareto-visual .bar-seg{border-radius:999px}\n.pareto-visual .crit-mini{margin-left:0;min-width:88px;justify-content:flex-end}\n.crit-key{display:flex;justify-content:flex-end;gap:11px;margin-top:10px;padding-top:9px;border-top:1px solid var(--border);font-size:9.5px;color:var(--muted)}\n.crit-key b{font-weight:850}\n.chart-scale{margin:10px 0 0;text-align:right;color:var(--muted);font-size:9.5px}\n.crit-dot{width:9px;height:9px;border-radius:50%;flex:none;display:inline-block;margin-right:2px}\n.dist-wrap{display:flex;flex-direction:column;gap:8px}\n.dist-track{display:flex;width:100%;height:22px;border-radius:6px;overflow:hidden;background:#eef2f7}\n.dist-seg{height:100%;transition:opacity .15s}\n.dist-seg.cf-clickable{cursor:pointer}\n.dist-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px}\n.dist-chip{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:#334155;transition:opacity .15s}\n.dist-chip.cf-clickable{cursor:pointer}\n.dist-chip.cf-clickable:hover{text-decoration:underline}\n.dist-chip i{width:10px;height:10px;border-radius:3px;display:inline-block}\n.chart-inline{margin:2px 0 14px}\n.crit-strip{display:flex;flex-wrap:wrap;align-items:center;gap:14px 22px;padding:8px 0 2px}\n.crit-strip-head{font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);flex:none}\n.crit-pill{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:#334155;transition:opacity .15s}\n.crit-pill.cf-clickable{cursor:pointer}\n.crit-pill.cf-clickable:hover .crit-pill-name{text-decoration:underline}\n.crit-pill.cf-selected{outline:2px solid var(--accent);outline-offset:3px;border-radius:6px}\n.crit-pill-dot{width:9px;height:9px;border-radius:50%;background:var(--crit-color,#94a3b8);flex:none}\n.crit-pill-name{font-weight:800;letter-spacing:.03em;text-transform:uppercase;font-size:10.5px}\n.crit-pill b{font-size:15px;font-weight:800;color:var(--ink)}\n.crit-pill small{color:var(--muted);font-size:11px}\n.crit-strip-bar{display:flex;width:100%;height:5px;border-radius:999px;overflow:hidden;background:#eef2f7;margin-top:2px}\n.crit-strip-bar span{height:100%}\n.crit-mini{display:inline-flex;align-items:center;gap:7px;margin-left:8px;font-size:10.5px;color:#475569;flex:none}\n.cm-item{display:inline-flex;align-items:center;gap:2px;white-space:nowrap}\n.cm-item b{font-weight:800;font-size:10.5px}\n.cm-alta{color:var(--alta)}\n.cm-media{color:var(--media)}\n.cm-baja{color:var(--baja)}\n.evo-mini{display:flex;justify-content:center;margin-left:0;margin-top:1px;font-size:9px;white-space:nowrap}\n.evo-seg{position:relative;width:100%}\n.evo-value{position:absolute;bottom:100%;left:0;right:0;text-align:center;margin-bottom:3px;white-space:nowrap}\n.evo-total{display:block;font-size:10.5px;font-weight:700;color:#334155}\n.evo-wrap{margin-top:38px}\n.avg-line{position:absolute;left:0;right:0;border-top:2px dashed #94a3b8;z-index:1}\n.avg-tag{position:absolute;right:0;top:-16px;background:#fff;color:#64748b;font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;border:1px solid var(--border)}\n.timeline-row{display:flex;align-items:center;gap:10px;margin-bottom:5px;font-size:12px}\n.timeline-label{width:170px;flex:none;color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.timeline-track{flex:1;background:#f1f5f9;border-radius:4px;height:14px;position:relative}\n.timeline-bar{position:absolute;top:0;height:100%;border-radius:4px;min-width:3px}\n.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;color:#fff}\na.ext-link{color:var(--accent);text-decoration:none;font-weight:600;white-space:nowrap}\na.ext-link:hover{text-decoration:underline}\nfooter{text-align:center;color:var(--muted);font-size:11px;padding:24px;border-top:1px solid var(--border);margin-top:20px}\n@media print{\n  nav.toc{display:none}\n  .layout{display:block}\n  main{padding:0}\n  section{page-break-inside:avoid}\n  .table-toolbar,.table-pager{display:none}\n  body{background:#fff}\n}\n@media (max-width:1180px){\n  .report-habits #velocidad .charts-row,.report-habits #ralenti .charts-row,\n  .report-habits #pto .charts-row,.report-habits #turnos .charts-row{grid-template-columns:repeat(2,minmax(0,1fr))}\n  .table-sort-mobile-wrap{display:flex}\n  table.dt.dt-compact{display:block; width:100%}\n  table.dt.dt-compact thead{display:none}\n  table.dt.dt-compact tbody{display:block}\n  table.dt.dt-compact tbody tr.dt-row-primary{\n    display:flex;flex-wrap:wrap;column-gap:16px;row-gap:4px;\n    padding:10px 12px 6px;margin-top:10px;\n    background:var(--card);border:1px solid var(--border);border-bottom:none;\n    border-radius:8px 8px 0 0;\n  }\n  table.dt.dt-compact tbody tr.dt-row-primary td{\n    display:flex;flex-direction:column;gap:1px;\n    flex:1 1 84px;min-width:0;max-width:none;\n    padding:2px 0;border-bottom:none;\n    white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:break-word;\n  }\n  table.dt.dt-compact tbody tr.dt-row-primary td[data-label=\"Regla\"],\n  table.dt.dt-compact tbody tr.dt-row-primary td[data-label=\"Buscar\"]{flex-basis:100%}\n  table.dt.dt-compact tbody tr.dt-row-primary td::before{\n    content:attr(data-label);font-size:9.5px;font-weight:800;color:var(--muted);\n    text-transform:uppercase;letter-spacing:.03em;\n  }\n  table.dt.dt-compact tbody tr.dt-row-secondary{display:block}\n  table.dt.dt-compact tbody tr.dt-row-secondary td{\n    display:block;border:1px solid var(--border);border-top:none;\n    border-radius:0 0 8px 8px;padding:6px 12px 10px;overflow-wrap:break-word;\n  }\n  table.dt.dt-compact tbody tr.dt-row-primary:hover td,\n  table.dt.dt-compact tbody tr.dt-row-primary:hover + tr.dt-row-secondary td{background:inherit}\n  table.dt.dt-compact td.dt-cell-wide, table.dt.dt-compact td.dt-cell-narrow{\n    max-width:none;white-space:normal;overflow:visible;text-overflow:clip;\n  }\n}\n#t_maestra table.dt tbody tr.dt-row-odd{--dt-row-bg:#fff}\n#t_maestra table.dt tbody tr.dt-row-even{--dt-row-bg:#f5f8fc}\n#t_maestra table.dt tbody tr.dt-row-odd,\n#t_maestra table.dt tbody tr.dt-row-even,\n#t_maestra table.dt tbody tr.dt-row-odd td,\n#t_maestra table.dt tbody tr.dt-row-even td{background:var(--dt-row-bg)}\n#t_maestra table.dt tbody tr.dt-row-primary:hover,\n#t_maestra table.dt tbody tr.dt-row-primary:hover td,\n#t_maestra table.dt tbody tr.dt-row-primary:hover + tr.dt-row-secondary,\n#t_maestra table.dt tbody tr.dt-row-primary:hover + tr.dt-row-secondary td{\n  background:#eaf1fb;\n}\n@media (max-width:820px){\n  .layout{flex-direction:column}\n  nav.toc{width:100%;position:relative;max-height:none;display:flex;flex-wrap:wrap;gap:4px}\n  .bar-label{width:120px}\n  .report-habits #velocidad .charts-row,.report-habits #ralenti .charts-row,\n  .report-habits #pto .charts-row,.report-habits #turnos .charts-row{grid-template-columns:minmax(0,1fr)}\n  .evo-labels.dense span:nth-child(3n+1){visibility:hidden}\n  .evo-labels.dense span:nth-child(4n+1),.evo-labels.dense span:last-child{visibility:visible}\n}\n@media (max-width:560px){\n  main{padding:14px 14px 40px}\n  .kpi{min-width:130px}\n  .kpi--priority{min-width:140px}\n  .bar-label{width:92px;font-size:11px}\n  .chart-card{padding:14px 13px}\n  .pareto-row{grid-template-columns:minmax(0,1fr) auto;gap:6px 10px;padding:9px 2px}\n  .pareto-visual{grid-template-columns:minmax(55px,1fr);gap:5px}\n  .pareto-visual .crit-mini{justify-content:flex-start;min-width:0}\n  .pareto-value{flex-direction:column;align-items:flex-end;gap:0}\n  .pareto-value strong{font-size:13px}\n  .crit-strip{gap:10px 16px}\n  .crit-mini{margin-left:4px;gap:5px}\n}\n\n.section-empty .kpis,.section-empty .charts-row{opacity:.5}\n.kpi b .kpi-main{display:inline;margin:0;font-size:inherit;font-weight:inherit;color:inherit;text-transform:none;letter-spacing:normal}\n.evo-stack{display:flex;flex-direction:column-reverse}\n.evo-part{width:100%;flex:none}\n.evo-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:8px;font-size:11px;color:var(--muted)}\n.evo-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}\n.report-habits .kpis--secondary .kpi{border-left-color:#e2e8f0;background:#fafcff}\n.report-habits .kpis--secondary .kpi b{font-size:16px}\n.report-habits .sec-sub{margin:-8px 0 14px;font-size:12.5px;color:var(--muted)}\n.report-habits .chart-card .bar-label{font-size:12px}\n</style>\n</head>\n<body class=\"report-habits\">\n\n<header class=\"executive-report-header\">\n  <div class=\"eyebrow\">Telemetry &amp; Fleet Intelligence</div>\n  <h1>An\u00e1lisis y Reporte de Operaciones</h1>\n  <div class=\"scope\">{{EMPRESA}}</div>\n  <p class=\"purpose\">H\u00e1bitos de conducci\u00f3n y operaci\u00f3n: exceso de velocidad, ralent\u00ed excesivo y uso de PTO (toma de fuerza) fuera de rango en la flota</p>\n  <div class=\"header-grid\">\n    <div class=\"header-item period\"><span class=\"header-label\">Periodo analizado</span><span class=\"period-value\">{{PERIODO_VALUE}}</span><span class=\"period-detail\">{{PERIODO_DETAIL}}</span></div>\n    <div class=\"header-item\"><span class=\"header-label\">Generado</span><span class=\"header-value\">{{GENERADO}}</span></div>\n  </div>\n</header>\n<div class=\"layout\">\n  <nav class=\"toc\"><a href=\"#resumen\">Resumen general</a><a href=\"#velocidad\">Velocidad</a><a href=\"#ralenti\">Ralent\u00ed</a><a href=\"#pto\">PTO</a><a href=\"#turnos\">Turnos y reglas</a><a href=\"#detalle\">Detalle de eventos</a></nav>\n  <main>\n    <details class=\"filters-box\"><summary>Filtros aplicados</summary><ul id=\"filters-list\"></ul></details>\n    <section id=\"resumen\" class=\"section-resumen\"><h2>Resumen general</h2><div class=\"kpis\"><div class=\"kpi\"><b id=\"kpi-hab_total\"></b><span>Eventos operacionales</span></div><div class=\"kpi kpi--priority kpi--accent-blue\"><b id=\"kpi-hab_moviles\"></b><span>M\u00f3viles con eventos</span></div><div class=\"kpi\"><b id=\"kpi-hab_velocidad\"></b><span>Eventos de velocidad</span></div><div class=\"kpi\"><b id=\"kpi-hab_ralenti\"></b><span>Eventos de ralent\u00ed</span></div><div class=\"kpi\"><b id=\"kpi-hab_pto\"></b><span>Eventos de PTO</span></div><div class=\"kpi kpi--priority\"><b id=\"kpi-hab_tiempo_ralenti\"></b><span>Tiempo total en ralent\u00ed</span></div></div><div class=\"charts-row\"><div class=\"chart-card\"><h3>Eventos por d\u00eda y tipo de h\u00e1bito</h3><p class=\"chart-subtitle\">Cada barra apila los 3 tipos de h\u00e1bito ese d\u00eda (velocidad, ralent\u00ed, PTO). La l\u00ednea punteada marca el promedio diario.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"hab_evolucion\" data-kind=\"evostack\" style=\"min-height:280px\"></div></div><div class=\"chart-card\"><h3>Distribuci\u00f3n por tipo de h\u00e1bito</h3><p class=\"chart-subtitle\">Participaci\u00f3n de cada tipo de h\u00e1bito sobre el total de eventos de la selecci\u00f3n actual.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart chart-inline\" id=\"hab_tipos\" data-kind=\"distribution\"></div></div></div><div class=\"narrative\"><p id=\"hab-narrative\"></p></div></section>\n\n    <section id=\"velocidad\" class=\"section-velocidad\"><h2>Velocidad</h2><p class=\"sec-sub\">Eventos de exceso de velocidad sostenido, seg\u00fan la(s) regla(s) de Geotab vigentes para este h\u00e1bito (ver \"Turnos y reglas\" para el detalle por regla).</p><div class=\"kpis\"><div class=\"kpi kpi--priority kpi--accent-blue\"><b id=\"kpi-vel_total\"></b><span>Eventos de velocidad</span></div><div class=\"kpi\"><b id=\"kpi-vel_moviles\"></b><span>M\u00f3viles con eventos</span></div><div class=\"kpi\"><b id=\"kpi-vel_top_movil\"></b><span>M\u00f3vil con m\u00e1s eventos</span></div><div class=\"kpi\"><b id=\"kpi-vel_regla\"></b><span>Regla m\u00e1s frecuente</span></div></div><div class=\"charts-row\"><div class=\"chart-card\"><h3>Top m\u00f3viles por eventos de velocidad</h3><p class=\"chart-subtitle\">Cantidad de eventos de exceso de velocidad por m\u00f3vil en la selecci\u00f3n actual.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"hab_velocidad_ranking\" data-kind=\"pareto\"></div></div><div class=\"chart-card\"><h3>Eventos por regla de velocidad</h3><p class=\"chart-subtitle\">Cu\u00e1ntos eventos aport\u00f3 cada regla de velocidad configurada en Geotab.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"hab_velocidad_reglas\" data-kind=\"pareto\"></div></div></div></section>\n\n    <section id=\"ralenti\" class=\"section-ralenti\"><h2>Ralent\u00ed</h2><p class=\"sec-sub\">Ralent\u00ed excesivo (motor encendido, veh\u00edculo pr\u00e1cticamente detenido, sostenido m\u00e1s all\u00e1 del umbral propio de cada regla por modelo/motor).</p><div class=\"kpis\"><div class=\"kpi kpi--priority kpi--accent-blue\"><b id=\"kpi-idle_total\"></b><span>Eventos de ralent\u00ed</span></div><div class=\"kpi\"><b id=\"kpi-idle_moviles\"></b><span>M\u00f3viles con eventos</span></div></div><div class=\"kpis kpis--secondary\"><div class=\"kpi\"><b id=\"kpi-idle_tiempo\"></b><span>Tiempo total (uni\u00f3n de intervalos)</span></div><div class=\"kpi\"><b id=\"kpi-idle_prom\"></b><span>Duraci\u00f3n promedio</span></div><div class=\"kpi\"><b id=\"kpi-idle_mediana\"></b><span>Duraci\u00f3n mediana</span></div><div class=\"kpi\"><b id=\"kpi-idle_top_tiempo\"></b><span>M\u00f3vil con m\u00e1s tiempo</span></div></div><div class=\"charts-row\"><div class=\"chart-card\"><h3>Top m\u00f3viles por eventos de ralent\u00ed</h3><p class=\"chart-subtitle\">Cantidad de eventos de ralent\u00ed excesivo por m\u00f3vil en la selecci\u00f3n actual.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"hab_ralenti_eventos\" data-kind=\"pareto\"></div></div><div class=\"chart-card\"><h3>Top m\u00f3viles por tiempo en ralent\u00ed</h3><p class=\"chart-subtitle\">Tiempo total en ralent\u00ed por m\u00f3vil -- uni\u00f3n de intervalos por veh\u00edculo, sin doble conteo si dos eventos se superponen.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"hab_ralenti_tiempo\" data-kind=\"pareto\"></div></div><div class=\"chart-card\"><h3>Eventos por rango de duraci\u00f3n</h3><p class=\"chart-subtitle\">Solo eventos de 5 minutos o m\u00e1s (las reglas de ralent\u00ed de esta flota ya exigen un m\u00ednimo de 5 min por condici\u00f3n).</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"hab_bins\" data-kind=\"pareto\" style=\"min-height:150px\"></div></div></div></section>\n\n    <section id=\"pto\" class=\"section-pto\"><h2>PTO</h2><p class=\"sec-sub\">Sobre-revoluci\u00f3n con PTO (toma de fuerza) activo -- confirmado cruzando cada candidato con un pulso real de PTO en una ventana de \u00b13 min (el bit de PTO es un pulso, no una se\u00f1al sostenida). Incluye el umbral propio de 1500 RPM para motores Mercedes (OM926).</p><div class=\"kpis\"><div class=\"kpi kpi--priority kpi--accent-blue\"><b id=\"kpi-pto_total\"></b><span>Eventos de PTO</span></div><div class=\"kpi\"><b id=\"kpi-pto_moviles\"></b><span>M\u00f3viles con eventos</span></div></div><div class=\"kpis kpis--secondary\"><div class=\"kpi\"><b id=\"kpi-pto_rpm\"></b><span>RPM pico m\u00e1ximo</span></div><div class=\"kpi\"><b id=\"kpi-pto_duracion\"></b><span>Duraci\u00f3n total</span></div><div class=\"kpi\"><b id=\"kpi-pto_prom\"></b><span>Duraci\u00f3n promedio</span></div><div class=\"kpi\"><b id=\"kpi-pto_top_movil\"></b><span>M\u00f3vil con m\u00e1s eventos</span></div></div><div class=\"charts-row\"><div class=\"chart-card\"><h3>Top m\u00f3viles por eventos de PTO</h3><p class=\"chart-subtitle\">Cantidad de eventos confirmados de sobre-revoluci\u00f3n con PTO por m\u00f3vil.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"hab_pto_eventos\" data-kind=\"pareto\"></div></div><div class=\"chart-card\"><h3>Top m\u00f3viles por tiempo en PTO</h3><p class=\"chart-subtitle\">Duraci\u00f3n total acumulada de los eventos confirmados, por m\u00f3vil.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"hab_pto_tiempo\" data-kind=\"pareto\"></div></div><div class=\"chart-card\"><h3>Top m\u00f3viles por RPM pico</h3><p class=\"chart-subtitle\">Mayor RPM registrado dentro de \u00b130s del evento, por m\u00f3vil.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"hab_pto_rpm\" data-kind=\"pareto\"></div></div></div></section>\n\n    <section id=\"turnos\" class=\"section-turnos\"><h2>Turnos y reglas</h2><p class=\"sec-sub\">Turno asignado por hora de inicio del evento, hora Bogot\u00e1 (T1 05:00-13:00, T2 13:00-21:00, T3 21:00-05:00) -- rangos confirmados con el usuario el 2026-10-01.</p><div class=\"charts-row\"><div class=\"chart-card\"><h3>Eventos por turno</h3><p class=\"chart-subtitle\">T1 05:00-13:00 \u00b7 T2 13:00-21:00 \u00b7 T3 21:00-05:00 (hora Bogot\u00e1).</p><div class=\"chart\" id=\"hab_turnos\" data-kind=\"pareto\" style=\"min-height:150px\"></div></div><div class=\"chart-card\"><h3>Eventos por regla</h3><p class=\"chart-subtitle\">Todas las reglas de Geotab que aportaron eventos a este reporte, de cualquier tipo de h\u00e1bito.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"hab_reglas\" data-kind=\"pareto\"></div></div></div></section>\n\n    <section id=\"detalle\" class=\"section-detalle\"><h2>Detalle de eventos</h2><div class=\"table-card master-table\" id=\"t_maestra\" data-src=\"data-t_maestra\"><div class=\"cf-banner\"><div class=\"cf-banner-title\">Filtros del dashboard</div><div class=\"cf-chips\" id=\"cf-chips-global\"></div><button class=\"cf-clear-all\" onclick=\"window.cfClearAll()\">Mostrar todos los eventos</button></div><div class=\"table-toolbar\"><h3 style=\"margin:0;font-size:13.5px\">Detalle de eventos operacionales</h3><div class=\"table-sort-mobile-wrap\"><select class=\"table-sort-mobile\" aria-label=\"Ordenar por\"></select><button type=\"button\" class=\"table-sort-dir\" title=\"Cambiar direcci\u00f3n\" aria-label=\"Cambiar direcci\u00f3n\">\u2193</button></div><input class=\"table-search\" type=\"text\" placeholder=\"Buscar en detalle de eventos\u2026\"></div><div class=\"table-scroll\"></div><div class=\"table-pager\"></div><p style=\"font-size:11px;color:var(--muted);margin:6px 0 0\">Una fila por evento (activaci\u00f3n de una regla). Haz clic en cualquier gr\u00e1fica para filtrar.</p><script type=\"application/json\" id=\"data-t_maestra\">{}</script></div></section>\n\n    <footer>Telemetry &amp; Fleet Intelligence \u00b7 Documento generado autom\u00e1ticamente a partir del hist\u00f3rico de la flota.<p>Cada evento corresponde a una activaci\u00f3n (ExceptionEvent) de una regla de Geotab -- no a un veh\u00edculo, as\u00ed que un mismo m\u00f3vil puede aparecer muchas veces.</p><p>El tiempo total de ralent\u00ed usa la uni\u00f3n de los intervalos de cada veh\u00edculo, para no contar dos veces un mismo periodo si dos eventos se superponen.</p><p>Los eventos de PTO ya est\u00e1n confirmados por cercan\u00eda real con el bit de PTO (\u00b13 min) -- el candidato original de la regla no exige el pulso directamente porque es una se\u00f1al intermitente.</p><p>El turno (T1/T2/T3) todav\u00eda no se calcula en este reporte -- pendiente de definir franjas horarias con el usuario.</p></footer>\n  </main>\n</div>\n<script type=\"application/json\" id=\"data-dashboard-dataset\">{}</script>\n<script id=\"report-runtime-script\">\n/* === PEGAR AQU\u00cd, TAL CUAL, TODO EL BLOQUE <script> (IIFE) DE\n   reporte_runtime_engine.js -- ES EL MISMO MOTOR QUE USA EL REPORTE DE\n   FALLAS (soporta 'fault_dashboard' y 'habits_dashboard'), NO SE MODIFICA. */\n</script>\n</body>\n</html>\n";

  // --- Tema visual (verbatim de dashboardAnalisisFallas.js/dashboardAnalisisPTO.js,
  // para que el selector de esta pantalla comparta marca con los otros 2 add-ins) ---
  var T = {
    color: {
      primary: '#73B828',
      primaryDark: '#59901D',
      primarySoft: '#EAF4DF',
      ink: '#1A2235',
      body: '#475569',
      muted: '#88929A',
      surface: '#FFFFFF',
      canvas: '#F4F5F8',
      border: '#E5E9F0',
      borderStrong: '#CBD5E1',
      danger: '#B91C1C',
      dangerSoft: '#FEF2F2',
      dangerBorder: '#FCA5A5',
      textoOscuro: '#1F2937',
      textoGris: '#6B7280',
      // CAMBIO (2026-09-29, pedido explícito de diseño ejecutivo): verde
      // esmeralda para el botón principal (distinto del verde corporativo
      // T.color.primary, que aquí solo queda como acento de marca en el
      // encabezado) y azul para el estado "cargando" de la alerta en línea.
      success: '#10B981',
      successDark: '#0EA371',
      successSoft: '#ECFDF5',
      successText: '#065F46',
      successBorder: '#A7F3D0',
      infoSoft: '#EFF6FF',
      infoText: '#1E3A8A',
      infoBorder: '#BFDBFE'
    },
    radius: { sm: '10px', md: '12px', lg: '18px', pill: '999px' },
    shadow: { card: '0 1px 2px rgba(15,23,42,0.05), 0 8px 24px rgba(15,23,42,0.07)' },
    font: "'Inter', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
  };

  // ============================================================================
  // --- Reporte de OPERACIONES (hábitos: velocidad, ralentí, PTO) ------------
  // ============================================================================
  // Motor de renderizado compartido con Fallas (reporte_runtime_engine.js,
  // DASH.kind === 'habits_dashboard') -- ver recomputeHabitsDashboard() ahí
  // para el contrato exacto de datos que se arma más abajo (construirFilaOperacion).
  //
  // Reglas de Geotab usadas por cada hábito -- VERIFICADO contra la cuenta
  // real el 2026-09-30 (api.get('Rule') + api.get('ExceptionEvent') en vivo,
  // ver cambios/2026-09-29_agregar-reporte-operaciones.md para el detalle
  // completo). IMPORTANTE: dashboardAnalisisPTO.js SOLO calcula PTO/sobre-
  // revolución -- pese a lo que sugiere su nombre de carpeta, NO tiene lógica
  // de velocidad ni de ralentí para portar. Solo la regla de PTO (dentro de
  // REGLAS_HABITO.PTO) es verbatim de ese archivo; velocidad/ralentí son
  // lógica nueva de esta tarea.
  //
  //  RALENTÍ: la familia "V_<modelo> RALENTÍ" -- 6 reglas con un comentario
  //  casi idéntico ("Vel<1 km/h, RPM en rango nominal de ralentí, encendido,
  //  min ~5 min") y un GRUPO DE MODELO DISJUNTO cada una (Chevrolet N400,
  //  Chevrolet NHR, Mercedes Atego 3133, Kenworth T800/Foton Auman,
  //  International HV607, Kenworth T380) -- mismo patrón ya usado en este
  //  repo para V_DPF CARGA DE HOLLÍN (3 reglas paralelas) o V_NIVEL TANQUE DE
  //  COMBUSTIBLE. Se EXCLUYEN a propósito 3 candidatas que también matchean
  //  "RALENT" por nombre pero tienen otro alcance/propósito: "Ralentí
  //  Excesivo Sin PTO" (alcance TODA LA FLOTA, su propio comentario dice
  //  "Regla en proceso de prueba" -- se solaparía con la familia V_ y no está
  //  confirmada como productiva), "1. RALENTÍ TOTAL" (alcance compañía
  //  completa, comentario "Reporte - Horas de motor" -- es un contador de
  //  horas de motor, no un hábito de ralentí excesivo) y "Ralentí > 5min"
  //  (alcance compañía completa, sin comentario, mismo umbral que la familia
  //  V_ pero sin scoping por modelo -- probable duplicado/prueba).
  //
  //  VELOCIDAD: 'V_VELOCIDAD MAYOR A 50 KM/H' -- alcance toda la flota
  //  (*Promoambiental), único comentario descriptivo real entre las 12
  //  reglas candidatas encontradas por nombre ("supera los 50 km/h sostenido
  //  30s"), y sigue la convención "V_" que en este repo (ver
  //  herramientas/estado_reglas.md) marca reglas ya revisadas/productivas.
  //  Se EXCLUYEN a propósito 'Exceso de Velocidad 70/80/90km/h', 'Velocidad
  //  75 Km/h' y 'SV_Exceso de velocidad Nacional': las 5 tienen el MISMO
  //  alcance (compañía completa), SIN comentario, y umbrales que se solapan
  //  entre sí (un mismo exceso de velocidad real dispara varias a la vez) --
  //  sumarlas inflaría el conteo varias veces sobre el mismo evento físico.
  //  También se excluye 'V_LÍMITE DE VELOCIDAD DE 30 KM/H GEOCERCA...' por
  //  ser un límite de ZONA puntual (geocerca), no un hábito general de
  //  exceso de velocidad.
  //
  //  Ambas decisiones (RALENTÍ/VELOCIDAD) confirmadas con el usuario el
  //  2026-10-01; la lógica de cada regla se auditó contra datos reales el
  //  2026-10-03 (velocidad de rueda/RPM/encendido, muestra cruzada con GPS y
  //  PTO).
  //
  //  PTO: 'SOBRE REVOLUCIÓN CON PTO (L9-X12-OM 926-ISF 3.8)' -- misma regla
  //  que dashboardAnalisisPTO.js, ya validada (ver
  //  herramientas/estado_reglas.md, fila "SOBRE REVOLUCIÓN CON PTO").
  //
  //  CAMBIO (2026-10-03, bug real): cada regla se identifica por su ID de
  //  Geotab, no por el nombre. Alguien renombró 'V_(L9) RALENTÍ' a
  //  'V_(L9 y  VOLSKWAGEN) RALENTÍ' (misma regla, mismo historial desde
  //  julio, ahora también con el grupo Volkswagen) y la búsqueda por nombre
  //  exacto la descartaba en silencio: el reporte perdía ~75 % del ralentí y
  //  los 11 compactadores International de Bogotá salían en cero. El nombre
  //  queda solo como respaldo (por si la regla se borra y se recrea con otro
  //  ID), y si una regla no aparece por ninguno de los dos, el reporte lo
  //  avisa de forma visible (ver reglasFaltantes en generarReporteOperaciones).
  var REGLAS_HABITO = {
    'VELOCIDAD': [
      { id: 'aY_X-HaqiSEmrNe8vpPlFFA', nombre: 'V_VELOCIDAD MAYOR A 50 KM/H' }
    ],
    'RALENTÍ': [
      { id: 'aCS-g7695wkmdmAGramgf2w', nombre: 'V_(L9 y  VOLSKWAGEN) RALENTÍ' },
      { id: 'aNFQR_KK-L0asGKUbLZnaKg', nombre: 'V_(T380) RALENTÍ' },
      { id: 'aTO2RdfTdcUaleFzlyYxa9g', nombre: 'V_(X12 y T800) RALENTÍ' },
      { id: 'am-KxBt9ldke7sGkvvvWOtQ', nombre: 'V_RALENTÍ N400 800 RPM' },
      { id: 'aHj1FH8QuzkqW7Cr1RArwgg', nombre: 'V_RALENTÍ FURGÓN NHR 650 RPM' },
      { id: 'alGL2aztCSkiyMdzN1Kl4Mg', nombre: 'V_RALENTÍ MERCEDES' }
    ],
    'PTO': [
      { id: 'aRowVAqEyfkWlRNW0D_1czA', nombre: 'SOBRE REVOLUCIÓN CON PTO (L9-X12-OM 926-ISF 3.8)' }
    ]
  };
  var HAB_ORDEN_TIPOS = ['VELOCIDAD', 'RALENTÍ', 'PTO'];

  // --- PTO: mismas constantes que dashboardAnalisisPTO.js (verbatim) -------
  var ID_DIAGNOSTICO_PTO = 'DiagnosticPowerTakeoffEngagedId';
  var ID_DIAGNOSTICO_RPM = 'aW3Nmy-ktfEuvrdkya4z0yg'; // Velocidad del motor de alta resolución (confirmado contra la cuenta real 2026-09-30)
  var VENTANA_PTO_MIN = 3;        // +/- minutos para confirmar pulso de PTO cercano
  var VENTANA_RPM_SEG = 30;       // +/- segundos para capturar el pico real de RPM
  var UMBRAL_RPM_MERCEDES = 1500; // motor OM926
  var DURACION_MINIMA_PTO_SEG = 30;
  var LIMITE_PAGINA_STATUSDATA = 50000;
  var VENTANA_CHUNK_RPM_MS = 8 * 60 * 60 * 1000;
  var VENTANA_CHUNK_PTO_MS = 24 * 60 * 60 * 1000;
  var VENTANA_AGRUPACION_RPM_MS = 12 * 60 * 60 * 1000;
  var VENTANA_TOPE_RACHA_RPM_MS = 20 * 60 * 60 * 1000;
  var TAMANO_LOTE_MULTICALL = 15;

  // Bins de duración de RALENTÍ -- mismos 3 rangos que HAB_BINS en
  // reporte_runtime_engine.js (ver hab_bins). Eventos <5min no entran en
  // ningún bin (durationBin: null) pero SÍ cuentan para los demás KPIs -- en
  // la práctica casi no debería pasar porque las 6 reglas de la familia V_
  // ya exigen ~5 min de condición sostenida por sí mismas.
  function calcularDurationBin(segundos) {
    if (segundos < 300) return null;
    if (segundos < 600) return '5–10 min';
    if (segundos < 1200) return '10–20 min';
    return '20 min o más';
  }

  var api = null;
  var state = null;
  var elementos = {};
  var contenedorPrincipal = null;

  // Cachés (se recargan cada vez que se abre el add-in con focus(), no hace
  // falta invalidarlas manualmente -- Group/Device no cambian tan seguido).
  var cacheGrupos = null;
  var cacheDispositivos = null;
  var cacheCatalogos = null;
  var cargaEnCurso = false;

  // --- Utilidades de estilo (CSSOM) -- Geotab elimina <style> del add-in ---
  function aplicarEstilo(el, estilos) {
    for (var propiedad in estilos) {
      if (Object.prototype.hasOwnProperty.call(estilos, propiedad)) {
        el.style[propiedad] = estilos[propiedad];
      }
    }
    return el;
  }

  function crear(tag, estilos, texto) {
    var el = document.createElement(tag);
    if (estilos) aplicarEstilo(el, estilos);
    if (texto !== undefined && texto !== null) el.textContent = texto;
    return el;
  }

  function crearPanel(estilosExtra) {
    var base = {
      background: T.color.surface, borderRadius: T.radius.md,
      border: '1px solid ' + T.color.border, boxShadow: T.shadow.card
    };
    for (var k in estilosExtra) { base[k] = estilosExtra[k]; }
    return crear('div', base);
  }

  // --- Envoltorios sobre la API de Geotab (callback -> Promise) -- verbatim
  // del mismo patrón en dashboardAnalisisFallas.js/dashboardAnalisisPTO.js ---
  function apiCall(metodo, params) {
    return new Promise(function (resolve, reject) { api.call(metodo, params, resolve, reject); });
  }

  function idDeRef(ref) { return (ref && ref.id) ? ref.id : ref; }

  // --- Jerarquía de grupos -> "empresa" + tipología + marca -----------------
  // DECISIÓN ABIERTA (ver changelog): esta cuenta de Geotab no tiene un campo
  // ni una rama de grupos dedicada a "empresa" -- CLAUDE.md solo documenta
  // ciudad/tipología/marca. dashboardAnalisisFallas.js resuelve "ciudad" como
  // el primer grupo hijo de la raíz ('*...') que NO es la rama "Tipologia" ni
  // una rama de marca (esGrupoMarca) -- en una cuenta multi-cliente como esta
  // (PACARIBE en el ejemplo real, que no matchea ningún patrón de ciudad
  // colombiana conocido) ese MISMO nivel es, con alta probabilidad, donde
  // viven los nombres de empresa/cliente reales. Se reutiliza exactamente esa
  // resolución, pero SIN la normalización de nombre de ciudad (normalizarCiudad
  // capitalizaba "Bogotá/Cali/Valle" a propósito; para un nombre de empresa
  // como "PACARIBE" eso lo degradaría a "Pacaribe", perdiendo el mayúsculas
  // real del grupo) -- aquí se usa el nombre del grupo tal cual, solo con trim().
  // NO CONFIRMADO con el usuario: si en esta cuenta "empresa" vive en otro
  // nivel de la jerarquía, hay que ajustar aquí (un solo punto de cambio).
  function esGrupoMarca(nombre) {
    var l = (nombre || '').trim().toLowerCase();
    return PALABRAS_GRUPO_MARCA.some(function (marca) { return l.indexOf(marca) !== -1; });
  }

  function obtenerGruposYDispositivos() {
    var pGrupos = cacheGrupos ? Promise.resolve(cacheGrupos) : apiCall('Get', { typeName: 'Group' }).then(function (g) { cacheGrupos = g || []; return cacheGrupos; });
    var pDispositivos = cacheDispositivos ? Promise.resolve(cacheDispositivos) : apiCall('Get', { typeName: 'Device' }).then(function (d) { cacheDispositivos = d || []; return cacheDispositivos; });
    return Promise.all([pGrupos, pDispositivos]);
  }

  // Recorre el árbol de grupos UNA vez y devuelve:
  //  - empresasDisponibles: [{id, nombre}] -- candidatos para el selector.
  //  - mapaGrupos: idGrupo -> {nombre, empresa, tipologia} (empresa/tipologia
  //    heredados de la rama a la que pertenece cada grupo, igual que
  //    obtener_mapa_grupos en telegram_alertas.py / obtenerMapaGrupos en
  //    dashboardAnalisisFallas.js, pero "ciudad" pasa a llamarse "empresa").
  function construirMapaEmpresas(grupos) {
    var porId = {};
    (grupos || []).forEach(function (g) { if (g && g.id) porId[g.id] = g; });
    function idDe(ref) { return (ref && ref.id) ? ref.id : ref; }

    var raiz = (grupos || []).filter(function (g) { return g && typeof g.name === 'string'; })
      .find(function (g) { return g.name.trim().indexOf('*') === 0; });

    var mapa = {};
    var empresasDisponibles = [];
    if (!raiz) return { mapa: mapa, empresasDisponibles: empresasDisponibles };

    function recorrer(grupoId, empresaActual, tipologiaActual) {
      var grupoCompleto = porId[grupoId];
      if (!grupoCompleto) return;
      mapa[grupoId] = { nombre: grupoCompleto.name || '', empresa: empresaActual, tipologia: tipologiaActual };
      (grupoCompleto.children || []).forEach(function (hijo) { recorrer(idDe(hijo), empresaActual, tipologiaActual); });
    }

    (raiz.children || []).forEach(function (hijoRaiz) {
      var hijoId = idDe(hijoRaiz);
      var hijoCompleto = porId[hijoId] || {};
      var nombre = (hijoCompleto.name || '').trim();
      if (nombre.toLowerCase() === NOMBRE_GRUPO_TIPOLOGIA) {
        (hijoCompleto.children || []).forEach(function (sub) {
          var subId = idDe(sub);
          var subCompleto = porId[subId] || {};
          recorrer(subId, null, (subCompleto.name || '').trim());
        });
      } else if (esGrupoMarca(nombre)) {
        recorrer(hijoId, null, null);
      } else if (nombre) {
        empresasDisponibles.push({ id: hijoId, nombre: nombre });
        recorrer(hijoId, nombre, null);
      }
    });

    empresasDisponibles.sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
    return { mapa: mapa, empresasDisponibles: empresasDisponibles };
  }

  // Un Device en Geotab suele estar etiquetado DIRECTAMENTE con varios grupos
  // a la vez (no solo el más profundo) -- por eso, igual que
  // resolverMarcaYTipologia en dashboardAnalisisFallas.js, alcanza con mirar
  // dev.groups (sin subir por la jerarquía de padres) y consultar el mapa
  // precalculado para cada uno.
  function resolverInfoDispositivo(dispositivo, mapaGrupos) {
    var marca = null, empresa = null, tipologia = null;
    (dispositivo.groups || []).forEach(function (g) {
      var gid = idDeRef(g);
      var info = mapaGrupos[gid];
      if (!info) return;
      if (!marca && esGrupoMarca(info.nombre)) marca = info.nombre.trim();
      if (!empresa && info.empresa) empresa = info.empresa;
      if (!tipologia && info.tipologia) tipologia = info.tipologia;
    });
    return {
      nombre: dispositivo.name || dispositivo.id,
      placa: dispositivo.licensePlate || '',
      marca: marca || 'Sin marca',
      tipologia: tipologia || 'Sin tipología asignada',
      empresa: empresa
    };
  }

  // --- Fechas ----------------------------------------------------------------
  var DIAS_ABREV = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  var MESES_ABREV = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function aFechaInputValue(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function etiquetaDia(fecha) {
    return DIAS_ABREV[fecha.getDay()] + ' ' + pad(fecha.getDate()) + '/' + pad(fecha.getMonth() + 1);
  }

  function formatearFechaCorta(d) {
    return d.getDate() + ' ' + MESES_ABREV[d.getMonth()] + ' ' + d.getFullYear();
  }

  function formatearFechaHora(fecha) {
    return fecha.toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  }

  // Turnos de operación confirmados con el usuario (2026-10-01): T1 05:00-13:00,
  // T2 13:00-21:00, T3 21:00-05:00 (hora Bogotá, NO la del navegador que genera
  // el reporte -- por eso Intl.DateTimeFormat con timeZone explícito, mismo
  // patrón ya usado en formatearGenerado/formatearFechaHora, en vez de
  // fecha.getHours() que dependería de la zona horaria local del equipo).
  function horaBogota(fecha) {
    var horaTexto = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Bogota', hour: '2-digit', hour12: false }).format(fecha);
    var h = parseInt(horaTexto, 10);
    return h === 24 ? 0 : h; // algunos motores de Intl devuelven "24" para medianoche en vez de "00"
  }

  function calcularTurno(fecha) {
    var h = horaBogota(fecha);
    if (h >= 5 && h < 13) return 'T1';
    if (h >= 13 && h < 21) return 'T2';
    return 'T3'; // 21:00-04:59
  }

  function formatearGenerado(d) {
    try {
      var texto = new Intl.DateTimeFormat('es-CO', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
      }).format(d);
      return texto.replace(',', '');
    } catch (e) {
      return formatearFechaHora(d);
    }
  }

  function construirEtiquetasDias(desde, hasta) {
    var etiquetas = [];
    var cursor = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate());
    var fin = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate());
    while (cursor <= fin) {
      etiquetas.push(etiquetaDia(cursor));
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
    return etiquetas;
  }

  function formatearDecimal(v) {
    return (v || 0).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ============================================================================
  // --- Reporte de OPERACIONES: obtención de eventos por regla ---------------
  // ============================================================================

  var cacheReglas = null;
  function obtenerReglas() {
    if (cacheReglas) return Promise.resolve(cacheReglas);
    return apiCall('Get', { typeName: 'Rule' }).then(function (reglas) {
      cacheReglas = reglas || [];
      return cacheReglas;
    });
  }

  // Resuelve, para un tipo de hábito, la lista de {id, name} de reglas
  // REALMENTE presentes en Geotab: primero por ID, y si el ID ya no existe,
  // por nombre exacto (normalizado a mayúsculas/trim). Las que no aparecen
  // por ninguno de los dos se agregan a `faltantes` -- el reporte las muestra
  // de forma visible en vez de omitirlas en silencio (ver CAMBIO 2026-10-03
  // en REGLAS_HABITO). El `name` devuelto es siempre el nombre ACTUAL en
  // Geotab, no el guardado aquí.
  function resolverReglasHabito(tipo, todasLasReglas, faltantes) {
    var encontradas = [];
    REGLAS_HABITO[tipo].forEach(function (objetivo) {
      var regla = todasLasReglas.filter(function (r) { return r.id === objetivo.id; })[0];
      if (!regla) {
        var nombreObjetivo = objetivo.nombre.trim().toUpperCase();
        regla = todasLasReglas.filter(function (r) { return (r.name || '').trim().toUpperCase() === nombreObjetivo; })[0];
      }
      if (regla) {
        encontradas.push({ id: regla.id, name: regla.name });
      } else {
        console.warn('Operaciones: no se encontró la regla "' + objetivo.nombre + '" (id ' + objetivo.id + ', ' + tipo + ') en Geotab -- se omite.');
        faltantes.push(objetivo.nombre + ' (' + tipo + ')');
      }
    });
    return encontradas;
  }

  // Trae ExceptionEvent de UNA regla en el rango -- mismo patrón que
  // obtenerEventosCandidatos en dashboardAnalisisPTO.js (activeFrom/activeTo
  // ya vienen calculados por el propio motor de reglas de Geotab, no hace
  // falta derivarlos de StatusData crudo salvo para PTO -- ver más abajo).
  function obtenerEventosDeRegla(idRegla, desde, hasta, duracionMinimaSeg) {
    return apiCall('Get', {
      typeName: 'ExceptionEvent',
      search: { ruleSearch: { id: idRegla }, fromDate: desde.toISOString(), toDate: hasta.toISOString() }
    }).then(function (eventos) {
      var candidatos = [];
      (eventos || []).forEach(function (ev) {
        if (!ev.activeFrom || !ev.activeTo || !ev.device) return;
        var activeFrom = new Date(ev.activeFrom);
        var activeTo = new Date(ev.activeTo);
        var duracionSeg = (activeTo - activeFrom) / 1000;
        if (duracionSeg <= 0) return;
        if (duracionMinimaSeg && duracionSeg < duracionMinimaSeg) return;
        candidatos.push({ idVehiculo: idDeRef(ev.device), activeFrom: activeFrom, activeTo: activeTo, duracionSeg: duracionSeg });
      });
      return candidatos;
    });
  }

  // --- PTO: el resto de este bloque es un puerto directo (adaptado al
  // apiCall/idDeRef ya existentes en este archivo) del pipeline YA VALIDADO
  // de dashboardAnalisisPTO.js -- PTO es un pulso intermitente
  // (DiagnosticPowerTakeoffEngagedId), así que el candidato de la regla no
  // puede exigirlo directamente (ver CLAUDE.md, "PTO es un pulso, no un
  // nivel"): hay que confirmar cada candidato cruzándolo con un pulso real
  // dentro de ±VENTANA_PTO_MIN, y agregar el pico de RPM real por separado.
  function apiMultiCall(llamadas) {
    if (llamadas.length === 0) return Promise.resolve([]);
    if (llamadas.length <= TAMANO_LOTE_MULTICALL) {
      return new Promise(function (resolve, reject) { api.multiCall(llamadas, resolve, reject); });
    }
    var lotes = [];
    for (var i = 0; i < llamadas.length; i += TAMANO_LOTE_MULTICALL) {
      lotes.push(llamadas.slice(i, i + TAMANO_LOTE_MULTICALL));
    }
    var resultados = [];
    return lotes.reduce(function (promesa, lote) {
      return promesa
        .then(function () { return new Promise(function (resolve, reject) { api.multiCall(lote, resolve, reject); }); })
        .then(function (resultadosLote) { resultados = resultados.concat(resultadosLote); });
    }, Promise.resolve()).then(function () { return resultados; });
  }

  function construirLlamadasPorChunksOperaciones(idVeh, diagnosticId, desde, hasta, chunkMs) {
    var llamadas = [];
    var cursor = desde.getTime();
    var finTotal = hasta.getTime();
    while (cursor < finTotal) {
      var finChunk = Math.min(cursor + chunkMs, finTotal);
      llamadas.push(['Get', {
        typeName: 'StatusData',
        search: { diagnosticSearch: { id: diagnosticId }, deviceSearch: { id: idVeh }, fromDate: new Date(cursor).toISOString(), toDate: new Date(finChunk).toISOString() }
      }]);
      cursor = finChunk;
    }
    return llamadas;
  }

  function agruparPorCercaniaOperaciones(itemsOrdenadosPorInicio, maxGapMs, maxSpanMs) {
    var grupos = [];
    itemsOrdenadosPorInicio.forEach(function (item) {
      var inicio = item.activeFrom.getTime();
      var fin = item.activeTo.getTime();
      var ultimo = grupos.length ? grupos[grupos.length - 1] : null;
      if (ultimo) {
        var finPropuesto = Math.max(ultimo.fin, fin);
        if (inicio - ultimo.fin <= maxGapMs && (finPropuesto - ultimo.inicio) <= maxSpanMs) {
          ultimo.fin = finPropuesto;
          return;
        }
      }
      grupos.push({ inicio: inicio, fin: fin });
    });
    return grupos;
  }

  function construirVentanasPorVehiculoOperaciones(itemsPorVehiculo, toleranciaMs, maxGapMs, maxSpanMs) {
    var resultado = {};
    Object.keys(itemsPorVehiculo).forEach(function (idVeh) {
      var ordenados = itemsPorVehiculo[idVeh].slice().sort(function (a, b) { return a.activeFrom - b.activeFrom; });
      var grupos = agruparPorCercaniaOperaciones(ordenados, maxGapMs, maxSpanMs);
      resultado[idVeh] = grupos.map(function (g) {
        return { desde: new Date(g.inicio - toleranciaMs), hasta: new Date(g.fin + toleranciaMs) };
      });
    });
    return resultado;
  }

  function consultarStatusDataAgrupadoOperaciones(ventanasPorVehiculo, diagnosticId, chunkMsFallback) {
    var llamadas = [], idVehPorLlamada = [], ventanaPorLlamada = [];
    Object.keys(ventanasPorVehiculo).forEach(function (idVeh) {
      ventanasPorVehiculo[idVeh].forEach(function (v) {
        llamadas.push(['Get', {
          typeName: 'StatusData',
          search: { diagnosticSearch: { id: diagnosticId }, deviceSearch: { id: idVeh }, fromDate: v.desde.toISOString(), toDate: v.hasta.toISOString() }
        }]);
        idVehPorLlamada.push(idVeh); ventanaPorLlamada.push(v);
      });
    });
    if (llamadas.length === 0) return Promise.resolve({});
    return apiMultiCall(llamadas).then(function (resultados) {
      var lecturasPorVehiculo = {}, llamadasTruncadas = [];
      resultados.forEach(function (lecturas, i) {
        var idVeh = idVehPorLlamada[i];
        if (!lecturasPorVehiculo[idVeh]) lecturasPorVehiculo[idVeh] = [];
        if ((lecturas || []).length >= LIMITE_PAGINA_STATUSDATA) {
          llamadasTruncadas.push({ idVeh: idVeh, ventana: ventanaPorLlamada[i] });
        } else {
          lecturasPorVehiculo[idVeh] = lecturasPorVehiculo[idVeh].concat(lecturas || []);
        }
      });
      if (llamadasTruncadas.length === 0) return lecturasPorVehiculo;
      var llamadasChunk = [], idVehPorLlamadaChunk = [];
      llamadasTruncadas.forEach(function (t) {
        construirLlamadasPorChunksOperaciones(t.idVeh, diagnosticId, t.ventana.desde, t.ventana.hasta, chunkMsFallback).forEach(function (llamada) {
          llamadasChunk.push(llamada); idVehPorLlamadaChunk.push(t.idVeh);
        });
      });
      return apiMultiCall(llamadasChunk).then(function (resultadosChunk) {
        resultadosChunk.forEach(function (lecturas, i) {
          var idVeh = idVehPorLlamadaChunk[i];
          lecturasPorVehiculo[idVeh] = lecturasPorVehiculo[idVeh].concat(lecturas || []);
        });
        return lecturasPorVehiculo;
      });
    });
  }

  // Confirma PTO cercano (±VENTANA_PTO_MIN) -- puerto directo de
  // confirmarPtoCercano en dashboardAnalisisPTO.js.
  function confirmarPtoCercano(candidatos) {
    if (candidatos.length === 0) return Promise.resolve([]);
    var candidatosPorVehiculo = {};
    candidatos.forEach(function (c) {
      (candidatosPorVehiculo[c.idVehiculo] = candidatosPorVehiculo[c.idVehiculo] || []).push(c);
    });
    var ventanasPorVehiculo = construirVentanasPorVehiculoOperaciones(candidatosPorVehiculo, VENTANA_PTO_MIN * 60000, Infinity, Infinity);
    return consultarStatusDataAgrupadoOperaciones(ventanasPorVehiculo, ID_DIAGNOSTICO_PTO, VENTANA_CHUNK_PTO_MS).then(function (lecturasPorVehiculo) {
      var pulsosPorVehiculo = {};
      Object.keys(lecturasPorVehiculo).forEach(function (idVeh) {
        pulsosPorVehiculo[idVeh] = lecturasPorVehiculo[idVeh]
          .filter(function (l) { return parseFloat(l.data) > 0; })
          .map(function (l) { return new Date(l.dateTime); });
      });
      return candidatos.filter(function (c) {
        var desde = new Date(c.activeFrom.getTime() - VENTANA_PTO_MIN * 60000);
        var hasta = new Date(c.activeTo.getTime() + VENTANA_PTO_MIN * 60000);
        var pulsos = (pulsosPorVehiculo[c.idVehiculo] || []).filter(function (p) { return p >= desde && p <= hasta; });
        return pulsos.length > 0;
      });
    });
  }

  // Agrega el pico de RPM (±VENTANA_RPM_SEG) -- puerto directo de
  // agregarPicoRpm en dashboardAnalisisPTO.js.
  function agregarPicoRpm(eventosConfirmados) {
    if (eventosConfirmados.length === 0) return Promise.resolve(eventosConfirmados);
    var eventosPorVehiculo = {};
    eventosConfirmados.forEach(function (c) {
      (eventosPorVehiculo[c.idVehiculo] = eventosPorVehiculo[c.idVehiculo] || []).push(c);
    });
    var ventanasPorVehiculo = construirVentanasPorVehiculoOperaciones(eventosPorVehiculo, VENTANA_RPM_SEG * 1000, VENTANA_AGRUPACION_RPM_MS, VENTANA_TOPE_RACHA_RPM_MS);
    return consultarStatusDataAgrupadoOperaciones(ventanasPorVehiculo, ID_DIAGNOSTICO_RPM, VENTANA_CHUNK_RPM_MS).then(function (lecturasCrudasPorVehiculo) {
      var lecturasPorVehiculo = {};
      Object.keys(lecturasCrudasPorVehiculo).forEach(function (idVeh) {
        lecturasPorVehiculo[idVeh] = lecturasCrudasPorVehiculo[idVeh].map(function (l) { return { t: new Date(l.dateTime), v: parseFloat(l.data) }; });
      });
      eventosConfirmados.forEach(function (c) {
        var desde = new Date(c.activeFrom.getTime() - VENTANA_RPM_SEG * 1000);
        var hasta = new Date(c.activeTo.getTime() + VENTANA_RPM_SEG * 1000);
        var lecturas = (lecturasPorVehiculo[c.idVehiculo] || []).filter(function (l) { return l.t >= desde && l.t <= hasta; });
        c.rpmPico = lecturas.length ? Math.max.apply(null, lecturas.map(function (l) { return l.v; })) : null;
      });
      return eventosConfirmados;
    });
  }

  function construirFleetSizes(dispositivosEnAlcance, infoDispositivos, empresaNombre) {
    var tipo = {}, marca = {};
    dispositivosEnAlcance.forEach(function (d) {
      var info = infoDispositivos[d.id] || { tipologia: 'Sin tipología asignada', marca: 'Sin marca' };
      tipo[info.tipologia] = (tipo[info.tipologia] || 0) + 1;
      marca[info.marca] = (marca[info.marca] || 0) + 1;
    });
    var empresa = {};
    empresa[empresaNombre] = dispositivosEnAlcance.length;
    return { tipo: tipo, marca: marca, empresa: empresa };
  }

  // Filtros aplicados (compartido por Fallas y Operaciones -- ambos muestran
  // Empresa/Periodo/Flota analizada en el mismo <ul id="filters-list">).
  function construirFiltrosHtmlComun(empresaNombre, desde, hasta, baseFlota) {
    return [
      '<li>Empresa: ' + escapeHtml(empresaNombre) + '</li>',
      '<li>Periodo: ' + escapeHtml(formatearFechaCorta(desde)) + ' → ' + escapeHtml(formatearFechaCorta(hasta)) + '</li>',
      '<li>Flota analizada: ' + baseFlota + ' vehículo(s) del catálogo</li>'
    ].join('');
  }

  // --- Reporte de OPERACIONES: fila del dataset + fila de la tabla maestra --
  // Forma EXACTA que espera recomputeHabitsDashboard() en
  // reporte_runtime_engine.js -- ver el comentario de cabecera de este
  // archivo para el detalle campo por campo.
  function construirFilaOperacion(evento, tipo, nombreRegla, info, empresaNombre) {
    return {
      dia: etiquetaDia(evento.activeFrom),
      movil: info.nombre,
      placa: info.placa,
      empresa: empresaNombre,
      tipoVehiculo: info.tipologia,
      habitType: tipo,
      regla: nombreRegla,
      durationBin: tipo === 'RALENTÍ' ? calcularDurationBin(evento.duracionSeg) : null,
      // Turno (T1 05-13h / T2 13-21h / T3 21-05h, hora Bogotá) -- rangos
      // confirmados con el usuario el 2026-10-01 (ver changelog).
      shift: calcularTurno(evento.activeFrom),
      startMs: evento.activeFrom.getTime(),
      endMs: evento.activeTo.getTime(),
      durationSeconds: evento.duracionSeg,
      rpmPeak: tipo === 'PTO' ? (evento.rpmPico == null ? null : evento.rpmPico) : null,
      idDevice: evento.idVehiculo
    };
  }

  function construirColumnasTablaOperaciones() {
    return ['Móvil', 'Placa', 'Tipo', 'Tipo de hábito', 'Regla', 'Inicio', 'Fin', 'Duración', 'RPM pico'];
  }

  function construirCrossfilterTablaOperaciones() {
    return [
      { column: 'Móvil', key: 'movil', match: 'exact' },
      { column: 'Tipo', key: 'tipo', match: 'exact' },
      { column: 'Tipo de hábito', key: 'habit_type', match: 'exact' },
      { column: 'Regla', key: 'regla', match: 'exact' }
    ];
  }

  function formatearDuracionOperaciones(seg) {
    seg = Math.round(seg || 0);
    var h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s = seg % 60;
    if (h) return h + ' h ' + (m < 10 ? '0' + m : m) + ' min';
    if (m) return m + ' min ' + (s < 10 ? '0' + s : s) + ' s';
    return s + ' s';
  }

  function construirFilasTablaOperaciones(filasDataset) {
    return filasDataset.map(function (r) {
      return [
        r.movil, r.placa, r.tipoVehiculo, r.habitType, r.regla,
        formatearFechaHora(new Date(r.startMs)), formatearFechaHora(new Date(r.endMs)),
        formatearDuracionOperaciones(r.durationSeconds),
        r.rpmPeak != null ? (r.rpmPeak.toLocaleString('es-CO') + ' rpm') : '—'
      ];
    });
  }

  // --- Ensamblado del HTML final ---------------------------------------------
  function inyectarJson(html, id, objeto) {
    var marcador = '<script type="application/json" id="' + id + '">{}</script>';
    if (html.indexOf(marcador) === -1) {
      console.warn('Operaciones: no se encontró el bloque de datos ' + id + ' en la plantilla.');
      return html;
    }
    var json = JSON.stringify(objeto).replace(/<\/script/gi, '<\\/script');
    var reemplazo = '<script type="application/json" id="' + id + '">' + json + '</script>';
    return html.split(marcador).join(reemplazo);
  }

  function reemplazarBloque(html, marcador, reemplazo) {
    if (html.indexOf(marcador) === -1) {
      console.warn('Operaciones: no se encontró el marcador esperado en la plantilla: ' + marcador);
      return html;
    }
    return html.split(marcador).join(reemplazo);
  }

  // El motor (reporte_runtime_engine.js) se incrusta VERBATIM -- no se toca
  // ni una línea, solo se escapa "</script" por si el propio motor llegara a
  // contener ese texto literal dentro de un string (no lo contiene hoy, pero
  // es una salvaguarda barata para no romper el HTML de salida).
  function inyectarScriptMotor(html, motorJs) {
    var inicio = '<script id="report-runtime-script">';
    var idxInicio = html.indexOf(inicio);
    if (idxInicio === -1) {
      console.warn('Operaciones: no se encontró el marcador del motor de renderizado en la plantilla.');
      return html;
    }
    var idxFinComentario = html.indexOf('</script>', idxInicio);
    var antes = html.slice(0, idxInicio);
    var despues = html.slice(idxFinComentario + '</script>'.length);
    var motorSeguro = motorJs.replace(/<\/script/gi, '<\\/script');
    return antes + inicio + '\n' + motorSeguro + '\n</script>' + despues;
  }

  // Ensamblado genérico, COMPARTIDO por los 2 tipos de reporte (Fallas y
  // Operaciones): ambos usan el mismo motor y los mismos marcadores base
  // ({{EMPRESA}}/{{PERIODO_*}}/{{GENERADO}}, data-dashboard-dataset,
  // data-t_maestra, filters-list). `bloquesOpcionales` cubre lo que SOLO
  // tiene la plantilla de Fallas (banner "sin fallas" + narrativa estática
  // en <ul>) -- Operaciones no los tiene porque el motor arma su narrativa
  // en vivo dentro de #hab-narrative (ver recomputeHabitsDashboard en
  // reporte_runtime_engine.js), así que ese caso pasa un array vacío.
  //
  // Bloques por-gráfico (data-criticidad_donut, data-evolucion_bar, etc. en
  // Fallas) se DEJAN como {} en la plantilla -- ver nota en el changelog:
  // recomputeDashboard() se ejecuta de forma síncrona justo después de
  // initCharts() en el mismo listener de DOMContentLoaded del motor, así que
  // el primer pintado con estos bloques vacíos nunca llega a mostrarse (no
  // hay "yield" de frame entre ambas fases). Los gráficos de Operaciones
  // (hab_*) ni siquiera llevan bloque data-src -- recomputeChart() no los lee
  // (arma el spec con un builder JS, no con readData), así que no hace falta
  // ese vestigio en la plantilla nueva.
  function ensamblarReporteHtmlBase(plantillaHtml, motorJs, datos, bloquesOpcionales) {
    var html = plantillaHtml;
    html = reemplazarBloque(html, '{{EMPRESA}}', escapeHtml(datos.empresaNombre));
    html = reemplazarBloque(html, '{{PERIODO_VALUE}}', escapeHtml(datos.periodoValue));
    html = reemplazarBloque(html, '{{PERIODO_DETAIL}}', escapeHtml(datos.periodoDetail));
    html = reemplazarBloque(html, '{{GENERADO}}', escapeHtml(datos.generadoTexto));
    html = inyectarJson(html, 'data-dashboard-dataset', datos.dashboardDataset);
    html = inyectarJson(html, 'data-t_maestra', datos.tMaestra);
    html = reemplazarBloque(html, '<ul id="filters-list"></ul>', '<ul id="filters-list">' + datos.filtrosHtml + '</ul>');
    (bloquesOpcionales || []).forEach(function (b) { html = reemplazarBloque(html, b.marcador, b.reemplazo); });
    html = inyectarScriptMotor(html, motorJs);
    return html;
  }

  function ensamblarReporteHtmlOperaciones(plantillaHtml, motorJs, datos) {
    return ensamblarReporteHtmlBase(plantillaHtml, motorJs, datos, []);
  }

  function descargarHtml(nombreArchivo, contenidoHtml) {
    var blob = new Blob([contenidoHtml], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = nombreArchivo;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function slug(texto) {
    return (texto || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos (marcas diacríticas combinadas)
      .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'EMPRESA';
  }

  // --- Flujo principal: generar y descargar (Operaciones) ---------------------
  // Mismo esqueleto que generarReporte (empresa/dispositivos en alcance,
  // luego consulta a Geotab, luego ensamblado + descarga), pero la consulta
  // es "eventos de N reglas" en vez de "FaultData paginado", y PTO necesita
  // el paso extra de confirmación + pico de RPM (ver bloque de funciones más
  // arriba, puerto de dashboardAnalisisPTO.js).
  function generarReporteOperaciones(empresaId, empresaNombre, desde, hasta, presetTexto) {
    if (cargaEnCurso) return;
    cargaEnCurso = true;
    actualizarBoton(true);
    actualizarEstado('Cargando grupos y vehículos…', 'loading');

    var infoDispositivos, dispositivosEnAlcance, baseFlota;
    var reglasFaltantes = [];

    obtenerGruposYDispositivos()
      .then(function (resultado) {
        var grupos = resultado[0], dispositivos = resultado[1];
        var arbol = construirMapaEmpresas(grupos);
        infoDispositivos = {};
        dispositivosEnAlcance = [];
        dispositivos.forEach(function (d) {
          var info = resolverInfoDispositivo(d, arbol.mapa);
          if (info.empresa !== empresaNombre) return;
          infoDispositivos[d.id] = info;
          dispositivosEnAlcance.push(d);
        });

        if (!dispositivosEnAlcance.length) {
          throw new Error('No se encontraron vehículos en el grupo "' + empresaNombre + '". Revisa la jerarquía de grupos en Geotab.');
        }

        baseFlota = dispositivosEnAlcance.length;
        var idsEnAlcance = {};
        dispositivosEnAlcance.forEach(function (d) { idsEnAlcance[d.id] = true; });

        actualizarEstado('Consultando reglas de velocidad, ralentí y PTO en Geotab…', 'loading');
        return obtenerReglas().then(function (todasLasReglas) {
          var reglasPorTipo = {};
          HAB_ORDEN_TIPOS.forEach(function (tipo) { reglasPorTipo[tipo] = resolverReglasHabito(tipo, todasLasReglas, reglasFaltantes); });

          if (HAB_ORDEN_TIPOS.every(function (t) { return reglasPorTipo[t].length === 0; })) {
            throw new Error('No se encontró ninguna de las reglas de hábitos configuradas (ver REGLAS_HABITO en operaciones.js) en esta cuenta de Geotab.');
          }

          actualizarEstado('Consultando eventos de velocidad y ralentí en Geotab (puede tardar si el rango es amplio)…', 'loading');

          // Velocidad y Ralentí: el ExceptionEvent de Geotab YA trae
          // activeFrom/activeTo directos -- no hace falta cruzar con ningún
          // diagnóstico adicional (a diferencia de PTO, que es un pulso).
          var tareasSimples = [];
          ['VELOCIDAD', 'RALENTÍ'].forEach(function (tipo) {
            reglasPorTipo[tipo].forEach(function (regla) {
              tareasSimples.push(
                obtenerEventosDeRegla(regla.id, desde, hasta, null).then(function (candidatos) {
                  return { tipo: tipo, regla: regla, candidatos: candidatos.filter(function (c) { return idsEnAlcance[c.idVehiculo]; }) };
                })
              );
            });
          });

          // PTO: SÍ necesita el cruce por cercanía + pico de RPM + umbral
          // Mercedes -- mismo pipeline validado que dashboardAnalisisPTO.js.
          var tareaPto = Promise.resolve({ tipo: 'PTO', eventos: [] });
          if (reglasPorTipo.PTO.length) {
            var reglaPto = reglasPorTipo.PTO[0];
            tareaPto = obtenerEventosDeRegla(reglaPto.id, desde, hasta, DURACION_MINIMA_PTO_SEG)
              .then(function (candidatos) { return candidatos.filter(function (c) { return idsEnAlcance[c.idVehiculo]; }); })
              .then(function (candidatosEnAlcance) {
                actualizarEstado('Confirmando eventos de PTO cercanos al pulso real (' + candidatosEnAlcance.length + ' candidato(s))…', 'loading');
                return confirmarPtoCercano(candidatosEnAlcance);
              })
              .then(function (confirmados) {
                actualizarEstado('Calculando pico de RPM para ' + confirmados.length + ' evento(s) de PTO confirmados…', 'loading');
                return agregarPicoRpm(confirmados);
              })
              .then(function (conRpm) {
                // Umbral propio de 1500 RPM para Mercedes (OM926) -- mismo
                // criterio que filtrarPorUmbralMercedes en dashboardAnalisisPTO.js.
                var filtrados = conRpm.filter(function (e) {
                  var marca = (infoDispositivos[e.idVehiculo] || {}).marca || '';
                  if (marca.toLowerCase().indexOf('mercedes') !== -1 && e.rpmPico !== null && e.rpmPico < UMBRAL_RPM_MERCEDES) return false;
                  return true;
                });
                return { tipo: 'PTO', regla: reglaPto, eventos: filtrados };
              });
          }

          return Promise.all(tareasSimples.concat([tareaPto]));
        });
      })
      .then(function (resultados) {
        var filasDataset = [];
        resultados.forEach(function (r) {
          if (r.tipo === 'PTO') {
            (r.eventos || []).forEach(function (e) {
              var info = infoDispositivos[e.idVehiculo] || { nombre: e.idVehiculo, placa: '', tipologia: 'Sin tipología asignada' };
              filasDataset.push(construirFilaOperacion(e, 'PTO', r.regla.name, info, empresaNombre));
            });
          } else {
            (r.candidatos || []).forEach(function (c) {
              var info = infoDispositivos[c.idVehiculo] || { nombre: c.idVehiculo, placa: '', tipologia: 'Sin tipología asignada' };
              filasDataset.push(construirFilaOperacion(c, r.tipo, r.regla.name, info, empresaNombre));
            });
          }
        });

        actualizarEstado('Generando el archivo del reporte…', 'loading');
        var dayLabels = construirEtiquetasDias(desde, hasta);
        var fleetSizes = construirFleetSizes(dispositivosEnAlcance, infoDispositivos, empresaNombre);
        var dashboardDataset = {
          kind: 'habits_dashboard',
          rows: filasDataset,
          dayLabels: dayLabels,
          fleetSizes: fleetSizes,
          baseFlota: baseFlota,
          topN: 10,
          emptyText: 'No se encontraron eventos operacionales (velocidad, ralentí o PTO) para el alcance y periodo seleccionados.'
        };
        var tMaestra = {
          columns: construirColumnasTablaOperaciones(),
          rows: construirFilasTablaOperaciones(filasDataset),
          pageSize: 20,
          crossfilter: construirCrossfilterTablaOperaciones()
        };
        var diasEnRango = Math.max(1, Math.round((hasta - desde) / (24 * 60 * 60 * 1000)) + 1);
        var datos = {
          empresaNombre: empresaNombre,
          periodoValue: formatearFechaCorta(desde) + ' → ' + formatearFechaCorta(hasta),
          periodoDetail: (presetTexto || 'Rango personalizado') + ' · ' + diasEnRango + (diasEnRango === 1 ? ' día' : ' días'),
          generadoTexto: formatearGenerado(new Date()),
          dashboardDataset: dashboardDataset,
          tMaestra: tMaestra,
          filtrosHtml: construirFiltrosHtmlComun(empresaNombre, desde, hasta, baseFlota) +
            (reglasFaltantes.length
              ? '<li style="color:#b91c1c;font-weight:700">⚠ Reglas de Geotab no encontradas (sus eventos NO están en este reporte): ' + escapeHtml(reglasFaltantes.join(', ')) + '</li>'
              : '')
        };

        var htmlFinal = ensamblarReporteHtmlOperaciones(PLANTILLA_OPERACIONES_EMBEBIDA, MOTOR_JS_EMBEBIDO, datos);
        var nombreArchivo = 'reporte_operaciones_' + slug(empresaNombre) + '_' + aFechaInputValue(new Date()).slice(0, 10) + '.html';
        descargarHtml(nombreArchivo, htmlFinal);
        if (reglasFaltantes.length) {
          actualizarEstado('Descarga iniciada, PERO faltan reglas en Geotab (sus eventos no están en el reporte): ' + reglasFaltantes.join(', ') + '.', 'error');
        } else {
          actualizarEstado('Descarga iniciada — ' + filasDataset.length + ' evento(s) operacionales en ' + baseFlota + ' vehículo(s) del catálogo.', 'success');
        }
      })
      .catch(function (err) {
        console.error('Operaciones:', err);
        actualizarEstado((err && err.message) ? err.message : 'Ocurrió un error al generar el reporte.', 'error');
      })
      .then(function () {
        cargaEnCurso = false;
        actualizarBoton(false);
      });
  }

  // --- Retroalimentación visual: alerta en línea (carga / éxito / error) -----
  // CAMBIO (2026-09-29, pedido explícito de diseño): antes era un texto plano
  // que solo cambiaba de color. Ahora es una alerta con fondo suave + icono,
  // con 3 estados visuales (T.color.info* para "cargando", success* para
  // "listo", danger* -- ya existía -- para error). `tipo` nulo/vacío oculta
  // la alerta por completo (mismo uso que antes con texto '').
  var ICONOS_ALERTA = {
    loading: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex:none;margin-top:1px;animation:rptxGirar 0.85s linear infinite"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="34 300"/></svg>',
    success: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex:none;margin-top:1px"><circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.14"/><path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex:none;margin-top:1px"><circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.14"/><path d="M12 7.5v6M12 16.7v.1" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>'
  };
  var ESTILOS_ALERTA = {
    loading: { background: T.color.infoSoft, color: T.color.infoText, border: T.color.infoBorder },
    success: { background: T.color.successSoft, color: T.color.successText, border: T.color.successBorder },
    error: { background: T.color.dangerSoft, color: T.color.danger, border: T.color.dangerBorder }
  };

  function actualizarEstado(texto, tipo) {
    if (!elementos.estado) return;
    var el = elementos.estado;
    if (!texto || !tipo) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    var estilo = ESTILOS_ALERTA[tipo] || ESTILOS_ALERTA.error;
    aplicarEstilo(el, {
      display: 'flex', alignItems: 'flex-start', gap: '9px', padding: '10px 13px',
      borderRadius: T.radius.sm, background: estilo.background, color: estilo.color,
      border: '1px solid ' + estilo.border, fontSize: '0.83rem', lineHeight: '1.4'
    });
    el.innerHTML = (ICONOS_ALERTA[tipo] || '') + '<span>' + escapeHtml(texto) + '</span>';
  }

  function actualizarBoton(deshabilitado) {
    if (!elementos.botonGenerar) return;
    elementos.botonGenerar.disabled = deshabilitado;
  }

  // --- Hoja de estilos inyectada (CSSOM) --------------------------------------
  // Geotab elimina las etiquetas <style> que vienen en el HTML del add-in, pero
  // UNA creada y adjuntada por JS en tiempo de ejecución sí sobrevive -- es la
  // única forma de lograr :focus/:hover/:active/@media reales (un inline style
  // por sí solo no puede expresar pseudo-clases ni media queries). Sin
  // precedente en este repo (dashboardAnalisisFallas.js resuelve todo con
  // estilos inline estáticos, sin estados interactivos) -- se documenta aquí
  // por si sirve de referencia para otro add-in más adelante. Con guarda para
  // no duplicar el <style> si el add-in se reinicializa.
  function inyectarEstilosGlobales() {
    if (document.getElementById('rptx-estilos')) return;
    var css = '' +
      '.rptx-control{transition:border-color .15s ease,box-shadow .15s ease}' +
      '.rptx-control:focus{outline:none;border-color:' + T.color.ink + ';box-shadow:0 0 0 3px rgba(26,34,53,.14)}' +
      // CAMBIO (2026-09-29, corrección pedida: el botón activo se veía
      // "tosco", desbordando el carril gris al ganar fondo blanco + sombra):
      // transition:all (no solo background/color) para que la sombra tampoco
      // aparezca de golpe, y una sombra bien delicada (antes 0.1 de opacidad,
      // ahora 0.05) que no compite visualmente con el carril que la contiene.
      '.rptx-pill{transition:all .2s ease}' +
      '.rptx-pill:hover{color:' + T.color.ink + '}' +
      '.rptx-pill.is-active{background:#FFFFFF;color:' + T.color.ink + ';box-shadow:0 2px 4px rgba(0,0,0,.05)}' +
      '.rptx-btn-primary{transition:background .15s ease,box-shadow .15s ease,transform .08s ease}' +
      '.rptx-btn-primary:hover:not(:disabled){background:' + T.color.successDark + ';box-shadow:0 4px 14px rgba(16,185,129,.32)}' +
      '.rptx-btn-primary:active:not(:disabled){transform:translateY(1px)}' +
      '.rptx-btn-primary:disabled{opacity:.55;cursor:not-allowed}' +
      '@keyframes rptxGirar{to{transform:rotate(360deg)}}' +
      '@media (max-width:620px){.rptx-form-grid{grid-template-columns:1fr !important}}';
    var style = document.createElement('style');
    style.id = 'rptx-estilos';
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  }

  // --- Construcción de la UI ---------------------------------------------------
  function construirEncabezado(contenedor) {
    var panel = crearPanel({
      padding: '20px 24px', marginBottom: '16px',
      background: 'linear-gradient(135deg, ' + T.color.ink + ' 0%, #1B2C5C 100%)'
    });
    var filaTitulo = crear('div', { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' });
    var chip = crear('div', {
      width: '34px', height: '34px', minWidth: '34px', borderRadius: T.radius.sm,
      background: 'rgba(255,255,255,0.12)', color: '#FFFFFF', display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: '1rem', fontWeight: '700'
    }, '📄');
    filaTitulo.appendChild(chip);
    var bloqueTitulo = crear('div');
    bloqueTitulo.appendChild(crear('h2', { margin: '0', color: '#FFFFFF', fontSize: '1.15rem', fontWeight: '800' }, 'Operaciones'));
    bloqueTitulo.appendChild(crear('div', { color: '#C7D2E0', fontSize: '0.78rem', marginTop: '2px' }, 'Reporte ejecutivo de hábitos de conducción (velocidad, ralentí, PTO) por empresa y rango de fechas, en un HTML descargable'));
    filaTitulo.appendChild(bloqueTitulo);
    panel.appendChild(filaTitulo);
    contenedor.appendChild(panel);
    return panel;
  }

  // CAMBIO (2026-10-01, separación de add-ins): sin selector de tipo de
  // reporte -- este add-in SOLO genera Operaciones, así que no tiene sentido
  // un control segmentado de una sola opción. El formulario queda reducido a
  // Empresa/Desde/Hasta/Atajos + el botón de generar (sin el sub-formulario
  // de Mini Expediente, que no existe en este add-in).
  function construirFormulario(contenedor) {
    var panel = crearPanel({ padding: '22px 24px', marginBottom: '16px' });

    function envoltorioCampo(etiqueta) {
      var env = crear('div', { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '0' });
      env.appendChild(crear('label', {
        fontSize: '0.72rem', color: '#64748b', fontWeight: '600',
        textTransform: 'uppercase', letterSpacing: '.04em'
      }, etiqueta));
      return env;
    }

    var estiloControl = {
      height: '40px', padding: '0 12px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm,
      fontSize: '0.87rem', fontFamily: T.font, color: T.color.textoOscuro, background: '#FFFFFF',
      appearance: 'none', WebkitAppearance: 'none', width: '100%', boxSizing: 'border-box'
    };

    var envEmpresa = envoltorioCampo('Empresa');
    var selectEmpresa = crear('select', estiloControl);
    selectEmpresa.className = 'rptx-control';
    envEmpresa.appendChild(selectEmpresa);

    var ahora = new Date();
    var hace7 = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);

    var envDesde = envoltorioCampo('Desde');
    var inputDesde = crear('input', estiloControl);
    inputDesde.className = 'rptx-control';
    inputDesde.type = 'datetime-local';
    inputDesde.value = aFechaInputValue(hace7);
    envDesde.appendChild(inputDesde);

    var envHasta = envoltorioCampo('Hasta');
    var inputHasta = crear('input', estiloControl);
    inputHasta.className = 'rptx-control';
    inputHasta.type = 'datetime-local';
    inputHasta.value = aFechaInputValue(ahora);
    envHasta.appendChild(inputHasta);

    var presetTexto = { valor: 'Última semana' };

    var envPills = envoltorioCampo('Atajos');
    var grupoPills = crear('div', {
      display: 'inline-flex', background: '#F1F5F9', borderRadius: T.radius.sm,
      padding: '4px', gap: '2px', alignItems: 'stretch', height: '40px', boxSizing: 'border-box', width: '100%'
    });
    grupoPills.className = 'rptx-pill-group';
    envPills.appendChild(grupoPills);

    function crearPill(texto, activaInicial) {
      var btn = crear('button', {
        border: 'none', background: 'transparent', padding: '0 12px', borderRadius: '7px',
        fontSize: '0.78rem', fontWeight: '600', color: T.color.textoGris, cursor: 'pointer', fontFamily: T.font,
        flex: '1 1 0', minWidth: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
      }, texto);
      btn.type = 'button';
      btn.className = 'rptx-pill' + (activaInicial ? ' is-active' : '');
      return btn;
    }

    function marcarPillActiva(pillElegida) {
      Array.prototype.forEach.call(grupoPills.children, function (p) {
        p.classList.toggle('is-active', p === pillElegida);
      });
    }

    var botonSemana = crearPill('Última semana', true);
    botonSemana.addEventListener('click', function () {
      var h = new Date();
      var d = new Date(h.getTime() - 7 * 24 * 60 * 60 * 1000);
      inputDesde.value = aFechaInputValue(d); inputHasta.value = aFechaInputValue(h);
      presetTexto.valor = 'Última semana';
      marcarPillActiva(botonSemana);
    });

    var botonMes = crearPill('Último mes', false);
    botonMes.addEventListener('click', function () {
      var h = new Date();
      var d = new Date(h.getTime() - 30 * 24 * 60 * 60 * 1000);
      inputDesde.value = aFechaInputValue(d); inputHasta.value = aFechaInputValue(h);
      presetTexto.valor = 'Últimos 30 días';
      marcarPillActiva(botonMes);
    });

    grupoPills.appendChild(botonSemana);
    grupoPills.appendChild(botonMes);

    inputDesde.addEventListener('change', function () { presetTexto.valor = 'Rango personalizado'; marcarPillActiva(null); });
    inputHasta.addEventListener('change', function () { presetTexto.valor = 'Rango personalizado'; marcarPillActiva(null); });

    var iconoDescarga = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex:none"><path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var botonGenerar = crear('button', {
      display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '11px 22px',
      background: T.color.success, color: '#FFFFFF', border: 'none', borderRadius: T.radius.sm,
      fontWeight: '700', fontSize: '0.88rem', cursor: 'pointer', fontFamily: T.font,
      boxShadow: '0 1px 2px rgba(16,185,129,.28)', alignSelf: 'flex-end', whiteSpace: 'nowrap'
    });
    botonGenerar.className = 'rptx-btn-primary';
    botonGenerar.innerHTML = iconoDescarga + '<span>Generar y descargar reporte</span>';
    botonGenerar.addEventListener('click', function () {
      var empresaId = selectEmpresa.value;
      var empresaNombre = selectEmpresa.options[selectEmpresa.selectedIndex] ? selectEmpresa.options[selectEmpresa.selectedIndex].textContent : '';
      if (!empresaId) { actualizarEstado('Elige una empresa antes de generar el reporte.', 'error'); return; }

      var desde = new Date(inputDesde.value), hasta = new Date(inputHasta.value);
      if (!inputDesde.value || !inputHasta.value || isNaN(desde) || isNaN(hasta)) { actualizarEstado('Revisa el rango de fechas.', 'error'); return; }
      if (desde >= hasta) { actualizarEstado('"Desde" debe ser anterior a "Hasta".', 'error'); return; }
      generarReporteOperaciones(empresaId, empresaNombre, desde, hasta, presetTexto.valor);
    });

    var filaCampos = crear('div', {
      display: 'grid', gridTemplateColumns: 'minmax(150px,1.3fr) minmax(140px,1fr) minmax(140px,1fr) minmax(180px,1fr)',
      gap: '14px', alignItems: 'end'
    });
    filaCampos.className = 'rptx-form-grid';
    filaCampos.appendChild(envEmpresa);
    filaCampos.appendChild(envDesde);
    filaCampos.appendChild(envHasta);
    filaCampos.appendChild(envPills);
    panel.appendChild(filaCampos);

    var filaAccion = crear('div', { display: 'flex', justifyContent: 'flex-end', marginTop: '18px' });
    filaAccion.appendChild(botonGenerar);
    panel.appendChild(filaAccion);

    var estado = crear('div', { marginTop: '14px', display: 'none' });
    panel.appendChild(estado);

    contenedor.appendChild(panel);
    return { selectEmpresa: selectEmpresa, botonGenerar: botonGenerar, estado: estado };
  }


  function cargarEmpresasEnSelector(selectEmpresa) {
    return obtenerGruposYDispositivos().then(function (resultado) {
      var arbol = construirMapaEmpresas(resultado[0]);
      var seleccionPrevia = selectEmpresa.value;
      selectEmpresa.innerHTML = '';
      if (!arbol.empresasDisponibles.length) {
        var opcionVacia = crear('option', null, 'Sin grupos de empresa disponibles');
        opcionVacia.value = '';
        selectEmpresa.appendChild(opcionVacia);
        actualizarEstado('No se encontró ningún grupo candidato a "empresa" bajo la raíz de grupos de esta cuenta.', 'error');
        return;
      }
      arbol.empresasDisponibles.forEach(function (e) {
        var opcion = crear('option', null, e.nombre);
        opcion.value = e.id;
        selectEmpresa.appendChild(opcion);
      });
      var sigueValida = Array.prototype.some.call(selectEmpresa.options, function (o) { return o.value === seleccionPrevia; });
      if (sigueValida) selectEmpresa.value = seleccionPrevia;
    }).catch(function (err) {
      console.error('Operaciones: no se pudieron cargar los grupos/empresas:', err);
      actualizarEstado('No se pudieron cargar las empresas disponibles: ' + ((err && err.message) || err), 'error');
    });
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi;
      state = freshState;

      inyectarEstilosGlobales();

      contenedorPrincipal = document.getElementById('operacionesRoot');
      aplicarEstilo(contenedorPrincipal, {
        fontFamily: T.font, background: T.color.canvas, padding: '16px',
        maxWidth: '760px', margin: '0 auto', boxSizing: 'border-box'
      });

      construirEncabezado(contenedorPrincipal);
      var refs = construirFormulario(contenedorPrincipal);
      elementos.selectEmpresa = refs.selectEmpresa;
      elementos.botonGenerar = refs.botonGenerar;
      elementos.estado = refs.estado;

      initializedCallback();
    },

    focus: function (freshApi, freshState) {
      api = freshApi;
      state = freshState;
      actualizarEstado('Cargando empresas disponibles…', 'loading');
      cargarEmpresasEnSelector(elementos.selectEmpresa).then(function () {
        if (elementos.selectEmpresa.value) actualizarEstado('', null);
      });
    },

    blur: function () { /* sin auto-refresco: este add-in no deja nada corriendo en segundo plano */ }
  };
};
