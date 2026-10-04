/* Motor de renderizado del reporte de fallas (cross-filter, tablas, gráficas
   Pareto/evolución/distribución). Se sirve tal cual junto con reportes.js/
   reportes.html dentro del add-in, y reportes.js lo lee en tiempo de
   ejecución (fetch) para incrustarlo VERBATIM dentro de cada reporte HTML
   generado -- no se modifica esta lógica, es puro motor de presentación sin
   nada específico de una empresa o periodo. */
(function(){
  function byId(id){return document.getElementById(id);}
  function readData(srcId){var el=byId(srcId); return el?JSON.parse(el.textContent):null;}

  // ============================================================
  // CROSS-FILTER MULTI-DIMENSIONAL — 100% en el navegador (cierre 2026-09)
  // ============================================================
  // CF = {clave: [valores]} — VARIOS filtros combinables. MISMA
  // dimensión = OR entre sus valores; DIMENSIONES DISTINTAS = AND.
  // Un gráfico EMITE (spec.cfKey/spec.cfLabel); clic añade el valor a
  // su dimensión, clic de nuevo sobre el mismo lo quita. La tabla
  // maestra ESCUCHA (payload.crossfilter: [{column,key,label,match}]).
  var CF = {};
  var CF_LABELS = {};
  var CF_TABLES = [];

  function cfToggle(key, val, label){
    CF_LABELS[key] = label || key;
    var arr = CF[key] || [];
    var idx = arr.indexOf(val);
    if(idx === -1) arr = arr.concat([val]); else arr = arr.slice(0, idx).concat(arr.slice(idx + 1));
    if(arr.length) CF[key] = arr; else delete CF[key];
    refreshCrossfilter();
    // Ajuste puntual 2026-09: SIN auto-scroll a la tabla maestra — el
    // usuario pidió explícitamente que un clic de filtro no interrumpa
    // la lectura del dashboard moviendo la vista por su cuenta. El
    // scroll solo debe moverlo el usuario.
  }
  function cfRemoveValue(key, val){
    var arr = (CF[key] || []).filter(function(v){ return v !== val; });
    if(arr.length) CF[key] = arr; else delete CF[key];
    refreshCrossfilter();
  }
  function cfClearKey(key){ delete CF[key]; refreshCrossfilter(); }
  function cfClearAll(){ CF = {}; refreshCrossfilter(); }
  window.cfClearAll = cfClearAll;
  function refreshCrossfilter(){
    recomputeDashboard();
    CF_TABLES.forEach(function(fn){ fn(); });
    renderChips();
    document.querySelectorAll('[data-cf-key]').forEach(function(el){
      var key = el.getAttribute('data-cf-key'), val = el.getAttribute('data-cf-value');
      var active = CF[key];
      el.classList.toggle('cf-dim', !!active && active.indexOf(val) === -1);
      el.classList.toggle('cf-selected', !!active && active.indexOf(val) !== -1);
    });
  }

  // ============================================================
  // RECÁLCULO GLOBAL — KPIs + TODOS los gráficos (fase final 2026-09)
  // ============================================================
  // Espejo EXACTO de `_dashboard_from_rows()` (Python, motor de la app):
  // misma "una sola verdad analítica" en ambos lados. `DASH` se carga
  // UNA vez desde el dataset embebido; cada clic solo re-agrega en
  // memoria — cero red, cero servidor.
  var DASH = null;
  function loadDashboard(){
    var el = byId('data-dashboard-dataset');
    DASH = el ? JSON.parse(el.textContent) : null;
  }
  var CF_FIELD = {
    movil: 'movil', tipo: 'tipo', marca: 'marca', empresa: 'empresa',
    sistema: 'categoria', criticidad: 'criticidad', diagnostico: 'codigo',
  };
  function rowMatchesCf(row, key, values){
    if(DASH && DASH.kind === 'habits_dashboard'){
      var habitField = {dia:'dia', movil:'movil', empresa:'empresa', tipo:'tipoVehiculo', habit_type:'habitType', regla:'regla', duration_bin:'durationBin', turno:'shift'}[key];
      return habitField != null && values.indexOf(row[habitField]) !== -1;
    }
    if(key === 'dia') return values.some(function(d){ return row.dias.indexOf(d) !== -1; });
    var field = CF_FIELD[key];
    return field != null && values.indexOf(row[field]) !== -1;
  }
  function filterRowsCf(rows, exclude){
    var out = rows;
    Object.keys(CF).forEach(function(key){
      if(key === exclude) return;
      var values = CF[key];
      if(!values || !values.length) return;
      out = out.filter(function(r){ return rowMatchesCf(r, key, values); });
    });
    return out;
  }
  function decFmt(v, digits){
    digits = (digits == null) ? 1 : digits;
    return v.toLocaleString('es-CO', {minimumFractionDigits: digits, maximumFractionDigits: digits});
  }
  function flotaForCf(){
    if(CF.movil && CF.movil.length) return CF.movil.length;
    var flota = DASH.baseFlota;
    ['tipo', 'marca', 'empresa'].forEach(function(dim){
      var values = CF[dim];
      if(values && values.length){
        var sum = 0;
        values.forEach(function(v){ sum += (DASH.fleetSizes[dim][v] || 0); });
        flota = Math.min(flota, sum);
      }
    });
    return flota;
  }
  function countByField(rows, field){
    var m = {};
    rows.forEach(function(r){ m[r[field]] = (m[r[field]] || 0) + 1; });
    return m;
  }
  function groupCriticidad(rows, field){
    var m = {};
    rows.forEach(function(r){
      var g = r[field];
      if(!m[g]) m[g] = {};
      m[g][r.criticidad] = (m[g][r.criticidad] || 0) + 1;
    });
    return m;
  }
  function totalOfCounts(counts){
    var t = 0; Object.keys(counts).forEach(function(k){ t += counts[k]; }); return t;
  }
  // Refinamiento visual ejecutivo (2026-09): criticidad dominante de un
  // grupo (empate roto por severidad, no por orden de inserción) — usada
  // para el "badge" de color junto al nombre en cada barra Pareto.
  var CRIT_RANK = {ALTA: 3, MEDIA: 2, BAJA: 1};
  function dominantCrit(counts){
    if(!counts) return null;
    var best = null, bestN = -1;
    Object.keys(counts).forEach(function(c){
      var n = counts[c] || 0;
      if(n > bestN || (n === bestN && (CRIT_RANK[c] || 0) > (CRIT_RANK[best] || 0))){ best = c; bestN = n; }
    });
    return bestN > 0 ? best : null;
  }
  var CORPORATE_BLUE = '#2563eb';
  // Espejo de `CRITICALITY_COLORS` (Python) — constante, no depende del
  // dataset embebido, así el primer render (antes de `loadDashboard()`
  // terminar) y el recálculo usan siempre los mismos colores.
  var CRIT_COLORS = {ALTA: '#dc2626', MEDIA: '#f59e0b', BAJA: '#94a3b8'};
  // Espejo de `_split_kpi_value()` (Python): separa "11 / 31 (35,5 %)" en
  // valor principal + leyenda secundaria para la jerarquía tipográfica del
  // KPI (refinamiento visual ejecutivo 2026-09).
  function splitKpiValue(text){
    var idx = text.indexOf(' (');
    if(idx !== -1 && text.charAt(text.length - 1) === ')'){
      return {main: text.slice(0, idx), caption: text.slice(idx + 1)};
    }
    return {main: text, caption: null};
  }
  // Espejo de `_kpi_visual_class()` (Python): semántica de riesgo sobria
  // (rojo/ámbar/azul) SOLO para los KPIs prioritarios — nunca una alarma
  // permanente en el resto del tablero.
  function kpiVisualClass(id, text){
    if(id === 'fallas_alta') return 'kpi--risk-high';
    if(id === 'concentracion') return 'kpi--risk-mid';
    if(id === 'sistema_principal') return 'kpi--accent-blue';
    if(id === 'moviles_afectados' || id === 'hab_moviles'){
      var m = /([\d.,]+)\s*%/.exec(text);
      if(m){
        var pct = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
        if(pct >= 50) return 'kpi--risk-high';
        if(pct >= 25) return 'kpi--risk-mid';
      }
      return 'kpi--accent-blue';
    }
    return '';
  }
  function setKpi(id, text){
    var el = byId('kpi-' + id);
    if(!el) return;
    var parts = splitKpiValue(text);
    el.textContent = '';
    var mainSpan = document.createElement('span'); mainSpan.className = 'kpi-main'; mainSpan.textContent = parts.main;
    el.appendChild(mainSpan);
    if(parts.caption){
      var capSpan = document.createElement('span'); capSpan.className = 'kpi-caption'; capSpan.textContent = parts.caption;
      el.appendChild(capSpan);
    }
    var card = el.closest('.kpi');
    if(card){
      card.classList.remove('kpi--risk-high', 'kpi--risk-mid', 'kpi--accent-blue');
      var cls = kpiVisualClass(id, text);
      if(cls) card.classList.add(cls);
    }
  }
  function recomputeChart(id, builder, cfKey, cfLabel){
    var el = byId(id);
    if(!el) return;
    var spec = builder();
    el.innerHTML = '';
    var empty = !spec || (spec.categories && !spec.categories.length) || (spec.items && !spec.items.length);
    if(empty){
      el.style.minHeight = '';
      el.innerHTML = '<p style="color:var(--muted);font-size:12.5px;padding:8px 2px">' + ((DASH && DASH.emptyText) || 'No hay fallas para esta selección.') + '</p>';
      return;
    }
    spec.cfKey = cfKey; spec.cfLabel = cfLabel;
    if(spec.height) el.style.minHeight = spec.height + 'px';
    var kind = el.dataset.kind;
    if(kind === 'pareto') renderPareto(el, spec);
    else if(kind === 'evolution') renderEvolution(el, spec);
    else if(kind === 'distribution') renderDistributionBar(el, spec);
    else if(kind === 'evostack') renderEvoStack(el, spec);
    else renderBar(el, spec);
  }
  // ============================================================
  // REPORTE DE OPERACIONES / HÁBITOS — recálculo global (100 % local)
  // Dataset: DASH.rows (un evento por fila). Tres tipos: VELOCIDAD,
  // RALENTÍ y PTO. Cada gráfico excluye su PROPIA dimensión del filtro
  // para no colapsarse a sí mismo (mismo criterio que Fallos).
  // ============================================================
  var HAB_COLORS = {'VELOCIDAD': '#2563eb', 'RALENTÍ': '#0891b2', 'PTO': '#7c3aed'};
  var HAB_BINS = ['5–10 min', '10–20 min', '20 min o más'];
  function hNum(v, d){ return (v || 0).toLocaleString('es-CO', {maximumFractionDigits: d == null ? 1 : d}); }
  function hDur(v){
    v = Math.round(v || 0);
    if(v < 60) return v + ' s';
    if(v < 3600) return (v / 60).toLocaleString('es-CO', {maximumFractionDigits: 1}) + ' min';
    return fmtSeconds(v);
  }
  function hOf(list, t){ return list.filter(function(r){ return r.habitType === t; }); }
  function hGroup(list, f){ var m = {}; list.forEach(function(r){ (m[r[f]] || (m[r[f]] = [])).push(r); }); return m; }
  function hDistinct(list, f){ var s = {}; list.forEach(function(r){ s[r[f]] = 1; }); return Object.keys(s); }
  function hSum(list, f){ return list.reduce(function(a, r){ return a + (+r[f] || 0); }, 0); }
  function hTop(groups, valueFn){
    var best = null, bv = -1;
    Object.keys(groups).forEach(function(k){
      var v = valueFn(groups[k], k);
      if(v > bv || (v === bv && best !== null && k < best)){ best = k; bv = v; }
    });
    return best === null ? null : {name: best, value: bv};
  }
  function hUnion(list){
    var groups = {};
    list.forEach(function(r){
      if(r.startMs != null && r.endMs != null){ (groups[r.idDevice] || (groups[r.idDevice] = [])).push([r.startMs, r.endMs]); }
    });
    var byDev = {}, total = 0;
    Object.keys(groups).forEach(function(k){
      var a = groups[k].sort(function(x, y){ return x[0] - y[0]; }), end = -Infinity, sum = 0;
      a.forEach(function(x){
        if(x[1] <= end) return;
        if(x[0] > end){ sum += x[1] - x[0]; end = x[1]; } else { sum += x[1] - end; end = x[1]; }
      });
      byDev[k] = sum / 1000; total += sum / 1000;
    });
    return {total: total, byDev: byDev};
  }
  function hMedian(list, f){
    var v = list.map(function(r){ return +r[f] || 0; }).sort(function(a, b){ return a - b; });
    if(!v.length) return 0;
    var m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  function hRulesOf(list){ return hDistinct(list, 'regla').sort().join(', '); }
  function hRank(list, valueFn, unit, color, extraFn){
    var g = hGroup(list, 'movil');
    var items = Object.keys(g).map(function(m){
      var x = g[m], q = x[0];
      return {name: m, value: valueFn(x), placa: q.placa, tipo: q.tipoVehiculo, extra: extraFn(x, q)};
    }).filter(function(it){ return it.value > 0; })
      .sort(function(a, b){ return (b.value - a.value) || (a.name < b.name ? -1 : 1); }).slice(0, DASH.topN);
    return items.length ? {items: items, unit: unit, color: color, height: Math.max(200, items.length * 34)} : null;
  }
  function recomputeHabitsDashboard(){
    var rows = filterRowsCf(DASH.rows, null);
    var speed = hOf(rows, 'VELOCIDAD'), idle = hOf(rows, 'RALENTÍ'), pto = hOf(rows, 'PTO');
    var movs = hDistinct(rows, 'movil').length, flota = flotaForCf();
    var pct = flota ? decFmt(100 * movs / flota) : '0,0';
    var idleU = hUnion(idle);
    // ---- General
    setKpi('hab_total', hNum(rows.length, 0));
    setKpi('hab_moviles', movs + ' / ' + flota + ' (' + pct + ' %)');
    setKpi('hab_velocidad', hNum(speed.length, 0)); setKpi('hab_ralenti', hNum(idle.length, 0)); setKpi('hab_pto', hNum(pto.length, 0));
    setKpi('hab_tiempo_ralenti', idle.length ? fmtSeconds(idleU.total) : '—');
    // ---- Velocidad
    var sg = hGroup(speed, 'movil'), sr = hGroup(speed, 'regla');
    var stop = hTop(sg, function(x){ return x.length; }), srule = hTop(sr, function(x){ return x.length; });
    setKpi('vel_total', hNum(speed.length, 0)); setKpi('vel_moviles', String(Object.keys(sg).length));
    setKpi('vel_top_movil', stop ? stop.name + ' (' + hNum(stop.value, 0) + ')' : '—');
    setKpi('vel_regla', srule ? srule.name : '—');
    // ---- Ralentí
    var ig = hGroup(idle, 'movil');
    setKpi('idle_total', hNum(idle.length, 0)); setKpi('idle_moviles', String(Object.keys(ig).length));
    setKpi('idle_tiempo', idle.length ? fmtSeconds(idleU.total) : '—');
    setKpi('idle_prom', idle.length ? hDur(hSum(idle, 'durationSeconds') / idle.length) : '—');
    setKpi('idle_mediana', idle.length ? hDur(hMedian(idle, 'durationSeconds')) : '—');
    var itopT = hTop(ig, function(x){ return hUnion(x).total; });
    setKpi('idle_top_tiempo', itopT ? itopT.name + ' (' + fmtSeconds(itopT.value) + ')' : '—');
    // ---- PTO
    var pg = hGroup(pto, 'movil'), ptop = hTop(pg, function(x){ return x.length; });
    var rpms = pto.map(function(r){ return r.rpmPeak; }).filter(function(v){ return v != null; });
    setKpi('pto_total', hNum(pto.length, 0)); setKpi('pto_moviles', String(Object.keys(pg).length));
    setKpi('pto_rpm', rpms.length ? hNum(Math.max.apply(null, rpms), 0) + ' rpm' : '—');
    setKpi('pto_duracion', pto.length ? fmtSeconds(hSum(pto, 'durationSeconds')) : '—');
    setKpi('pto_prom', pto.length ? hDur(hSum(pto, 'durationSeconds') / pto.length) : '—');
    setKpi('pto_top_movil', ptop ? ptop.name + ' (' + hNum(ptop.value, 0) + ')' : '—');
    // ---- Narrativa dinámica
    var nar = byId('hab-narrative');
    if(nar){
      var mg = hGroup(rows, 'movil'), mtop = hTop(mg, function(x){ return x.length; });
      var byType = [['VELOCIDAD', speed.length], ['RALENTÍ', idle.length], ['PTO', pto.length]].sort(function(a, b){ return b[1] - a[1]; });
      nar.textContent = rows.length
        ? ('Con la selección actual hay ' + hNum(rows.length, 0) + ' eventos operacionales en ' + movs + ' móvil(es): ' + hNum(speed.length, 0) + ' de velocidad, ' + hNum(idle.length, 0) + ' de ralentí y ' + hNum(pto.length, 0) + ' de sobre-revolución con PTO. El mayor volumen es ' + (byType[0][0] === 'PTO' ? 'PTO' : byType[0][0].toLowerCase()) + ' (' + decFmt(100 * byType[0][1] / rows.length) + ' %); el móvil con más eventos es ' + mtop.name + ' (' + hNum(mtop.value, 0) + ').' + (idle.length ? ' El tiempo en ralentí es ' + fmtSeconds(idleU.total) + ' (unión de intervalos, sin doble conteo).' : ''))
        : 'No hay eventos para esta selección.';
    }
    // ---- Evolución general
    recomputeChart('hab_evolucion', function(){
      var base = filterRowsCf(DASH.rows, 'dia'), days = {}, movDay = {};
      DASH.dayLabels.forEach(function(d){ days[d] = {'VELOCIDAD': 0, 'RALENTÍ': 0, 'PTO': 0}; movDay[d] = {}; });
      base.forEach(function(r){ if(days[r.dia]){ days[r.dia][r.habitType] = (days[r.dia][r.habitType] || 0) + 1; movDay[r.dia][r.movil] = 1; } });
      var vals = DASH.dayLabels.map(function(d){ return days[d]['VELOCIDAD'] + days[d]['RALENTÍ'] + days[d]['PTO']; });
      if(!vals.some(function(v){ return v > 0; })) return null;
      return {categories: DASH.dayLabels, labels: DASH.dayLabels.map(function(d){ return (DASH.dayDisplay && DASH.dayDisplay[d]) || d; }), values: vals, stacks: DASH.dayLabels.map(function(d){ return days[d]; }),
              moviles: DASH.dayLabels.map(function(d){ return Object.keys(movDay[d]).length; }),
              average: vals.reduce(function(a, b){ return a + b; }, 0) / (vals.length || 1), colors: HAB_COLORS};
    }, 'dia', 'Fecha');
    recomputeChart('hab_tipos', function(){
      var base = filterRowsCf(DASH.rows, 'habit_type'), tot = base.length || 1;
      var items = ['VELOCIDAD', 'RALENTÍ', 'PTO'].map(function(t){ var n = hOf(base, t).length; return {name: t, value: n, pct: Math.round(n / tot * 1000) / 10, color: HAB_COLORS[t]}; });
      if(!base.length) return null;
      return {items: items, title: 'Eventos por tipo de hábito'};
    }, 'habit_type', 'Tipo de hábito');
    // ---- Velocidad
    var vBase = hOf(filterRowsCf(DASH.rows, 'movil'), 'VELOCIDAD');
    recomputeChart('hab_velocidad_ranking', function(){
      return hRank(vBase, function(x){ return x.length; }, 'eventos', '#2563eb', function(x, q){
        return ['Empresa: <b>' + q.empresa + '</b>', 'Reglas: <b>' + hRulesOf(x) + '</b>'];
      });
    }, 'movil', 'Móvil');
    recomputeChart('hab_velocidad_reglas', function(){
      var g = hGroup(hOf(filterRowsCf(DASH.rows, 'regla'), 'VELOCIDAD'), 'regla');
      var items = Object.keys(g).map(function(k){ return {name: k, value: g[k].length, moviles: hDistinct(g[k], 'movil').length}; }).sort(function(a, b){ return b.value - a.value; });
      return items.length ? {items: items, unit: 'eventos', color: '#2563eb', height: Math.max(120, items.length * 40)} : null;
    }, 'regla', 'Regla');
    // ---- Ralentí
    var iBase = hOf(filterRowsCf(DASH.rows, 'movil'), 'RALENTÍ');
    recomputeChart('hab_ralenti_eventos', function(){
      return hRank(iBase, function(x){ return x.length; }, 'eventos', '#0891b2', function(x, q){
        return ['Empresa: <b>' + q.empresa + '</b>', 'Tiempo (unión): <b>' + fmtSeconds(hUnion(x).total) + '</b>', 'Reglas: <b>' + hRulesOf(x) + '</b>'];
      });
    }, 'movil', 'Móvil');
    recomputeChart('hab_ralenti_tiempo', function(){
      var byDev = hUnion(iBase).byDev;
      return hRank(iBase, function(x){ return byDev[x[0].idDevice] || 0; }, 'segundos', '#0e7490', function(x, q){
        return ['Empresa: <b>' + q.empresa + '</b>', 'Tiempo (unión): <b>' + fmtSeconds(byDev[x[0].idDevice] || 0) + '</b>', 'Eventos: <b>' + x.length + '</b>'];
      });
    }, 'movil', 'Móvil');
    recomputeChart('hab_bins', function(){
      var base = hOf(filterRowsCf(DASH.rows, 'duration_bin'), 'RALENTÍ').filter(function(r){ return HAB_BINS.indexOf(r.durationBin) !== -1; });
      var tot = base.length;
      var items = HAB_BINS.map(function(b){ var n = base.filter(function(r){ return r.durationBin === b; }).length; return {name: b, value: n, extra: [hNum(tot ? 100 * n / tot : 0, 1) + ' % de los eventos de 5 min o más']}; });
      return tot ? {items: items, unit: 'eventos', color: '#0891b2', height: 150} : null;
    }, 'duration_bin', 'Rango de duración');
    // ---- PTO
    var pBase = hOf(filterRowsCf(DASH.rows, 'movil'), 'PTO');
    function ptoExtra(x, q){
      var r = x.map(function(e){ return e.rpmPeak; }).filter(function(v){ return v != null; });
      return ['Empresa: <b>' + q.empresa + '</b>', 'Duración total: <b>' + fmtSeconds(hSum(x, 'durationSeconds')) + '</b>', 'Duración promedio: <b>' + hDur(hSum(x, 'durationSeconds') / x.length) + '</b>', 'RPM pico máx.: <b>' + (r.length ? hNum(Math.max.apply(null, r), 0) : 'N/D') + '</b>'];
    }
    recomputeChart('hab_pto_eventos', function(){ return hRank(pBase, function(x){ return x.length; }, 'eventos', '#7c3aed', ptoExtra); }, 'movil', 'Móvil');
    recomputeChart('hab_pto_tiempo', function(){ return hRank(pBase, function(x){ return hSum(x, 'durationSeconds'); }, 'segundos', '#6d28d9', ptoExtra); }, 'movil', 'Móvil');
    recomputeChart('hab_pto_rpm', function(){
      return hRank(pBase, function(x){ var r = x.map(function(e){ return e.rpmPeak; }).filter(function(v){ return v != null; }); return r.length ? Math.max.apply(null, r) : 0; }, 'rpm', '#a78bfa', ptoExtra);
    }, 'movil', 'Móvil');
    // ---- Turnos (dimensión GLOBAL: todos los tipos de hábito)
    recomputeChart('hab_turnos', function(){
      var base = filterRowsCf(DASH.rows, 'turno');
      if(!base.length) return null;
      var g = hGroup(base, 'shift');
      var items = ['T1', 'T2', 'T3'].map(function(k){
        var x = g[k] || [];
        return {name: k, value: x.length, moviles: hDistinct(x, 'movil').length,
                extra: ['Velocidad: <b>' + hOf(x, 'VELOCIDAD').length + '</b>', 'Ralentí: <b>' + hOf(x, 'RALENTÍ').length + '</b>', 'PTO: <b>' + hOf(x, 'PTO').length + '</b>']};
      });
      return {items: items, unit: 'eventos', color: '#2563eb', height: 150};
    }, 'turno', 'Turno');
    // ---- Distribución por regla (todas las reglas, tipo como contexto)
    recomputeChart('hab_reglas', function(){
      var g = hGroup(filterRowsCf(DASH.rows, 'regla'), 'regla');
      var items = Object.keys(g).map(function(k){ return {name: k, value: g[k].length, moviles: hDistinct(g[k], 'movil').length, extra: ['Tipo de hábito: <b>' + g[k][0].habitType + '</b>']}; }).sort(function(a, b){ return b.value - a.value; });
      return items.length ? {items: items, unit: 'eventos', color: '#2563eb', height: Math.max(200, items.length * 34)} : null;
    }, 'regla', 'Regla');
    [['velocidad', speed.length], ['ralenti', idle.length], ['pto', pto.length]].forEach(function(p){
      var sec = byId(p[0]); if(sec) sec.classList.toggle('section-empty', p[1] === 0);
    });
  }
  function fmtSeconds(v){v=Math.round(v||0);var h=Math.floor(v/3600),m=Math.floor((v%3600)/60);return h?(h+' h '+String(m).padStart(2,'0')+' min'):(m+' min');}
  function recomputeDashboard(){
    if(!DASH) return;
    if(DASH.kind === 'habits_dashboard'){ recomputeHabitsDashboard(); return; }
    var full = filterRowsCf(DASH.rows, null);
    var fallasDistintas = full.length;
    var movilesSet = {}; full.forEach(function(r){ movilesSet[r.movil] = 1; });
    var movilesAfectados = Object.keys(movilesSet).length;
    var flota = flotaForCf();
    setKpi('fallas_distintas', fallasDistintas.toLocaleString('es-CO'));
    setKpi('moviles_afectados', movilesAfectados + ' / ' + flota + ' (' + (flota ? decFmt(100 * movilesAfectados / flota) : '0,0') + ' %)');
    if(fallasDistintas){
      var altaRows = full.filter(function(r){ return r.criticidad === 'ALTA'; });
      if(DASH.activeCrit.indexOf('ALTA') !== -1){
        var altaMoviles = {}; altaRows.forEach(function(r){ altaMoviles[r.movil] = 1; });
        setKpi('fallas_alta', altaRows.length + ' en ' + Object.keys(altaMoviles).length + ' móvil(es)');
      } else if(DASH.activeCrit.length){
        var fb = DASH.activeCrit[0];
        setKpi('fallas_alta', String(full.filter(function(r){ return r.criticidad === fb; }).length));
      }
      var catCounts = countByField(full, 'categoria');
      var topCat = null, topCatN = -1;
      Object.keys(catCounts).forEach(function(c){ if(catCounts[c] > topCatN){ topCat = c; topCatN = catCounts[c]; } });
      setKpi('sistema_principal', topCat + ' (' + decFmt(100 * topCatN / fallasDistintas) + ' %)');
      var movCounts = countByField(full, 'movil');
      var top5 = Object.keys(movCounts).map(function(m){ return [m, movCounts[m]]; })
        .sort(function(a, b){ return b[1] - a[1]; }).slice(0, 5);
      var top5sum = top5.reduce(function(a, kv){ return a + kv[1]; }, 0);
      setKpi('concentracion', decFmt(100 * top5sum / fallasDistintas) + ' % en ' + top5.length + ' móviles');
    } else {
      setKpi('fallas_alta', '—'); setKpi('sistema_principal', '—'); setKpi('concentracion', '—');
    }

    recomputeChart('evolucion_bar', function(){
      if(!DASH.dayLabels.length) return null;
      var base = filterRowsCf(DASH.rows, 'dia');
      var perDay = {}; var movDia = {};
      DASH.dayLabels.forEach(function(d){ perDay[d] = {}; movDia[d] = {}; });
      base.forEach(function(r){
        r.dias.forEach(function(d){
          if(perDay[d] != null){ perDay[d][r.criticidad] = (perDay[d][r.criticidad] || 0) + 1; movDia[d][r.movil] = 1; }
        });
      });
      var values = DASH.dayLabels.map(function(d){ return totalOfCounts(perDay[d]); });
      var avg = values.length ? values.reduce(function(a, b){ return a + b; }, 0) / values.length : 0;
      return {
        categories: DASH.dayLabels, values: values,
        breakdown: DASH.dayLabels.map(function(d){ return perDay[d]; }),
        moviles: DASH.dayLabels.map(function(d){ return Object.keys(movDia[d]).length; }),
        average: Math.round(avg * 10) / 10, color: CORPORATE_BLUE,
      };
    }, 'dia', 'Fecha');

    recomputeChart('criticidad_donut', function(){
      var base = filterRowsCf(DASH.rows, 'criticidad');
      var counts = countByField(base, 'criticidad');
      var total = DASH.activeCrit.reduce(function(a, c){ return a + (counts[c] || 0); }, 0) || 1;
      var items = DASH.activeCrit.filter(function(c){ return counts[c]; }).map(function(c){
        return {name: c, value: counts[c] || 0, pct: Math.round((counts[c] || 0) / total * 1000) / 10, color: DASH.critColors[c]};
      });
      return {items: items};
    }, 'criticidad', 'Criticidad');

    recomputeChart('sistemas_bar', function(){
      var base = filterRowsCf(DASH.rows, 'sistema');
      var groups = groupCriticidad(base, 'categoria');
      var keys = Object.keys(groups);
      if(!keys.length) return null;
      var items = keys.map(function(g){
        return {name: g, value: totalOfCounts(groups[g]), crit: dominantCrit(groups[g]), breakdown: groups[g]};
      }).sort(function(a, b){ return b.value - a.value; });
      return {items: items, unit: 'fallas', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};
    }, 'sistema', 'Sistema');

    recomputeChart('ranking_bar', function(){
      var base = filterRowsCf(DASH.rows, 'movil');
      var groups = groupCriticidad(base, 'movil');
      var meta = {}; base.forEach(function(r){ meta[r.movil] = {placa: r.placa, tipo: r.tipo}; });
      var keys = Object.keys(groups);
      if(!keys.length) return null;
      var items = keys.map(function(m){
        return {
          name: m, value: totalOfCounts(groups[m]), crit: dominantCrit(groups[m]), breakdown: groups[m],
          placa: (meta[m] || {}).placa, tipo: (meta[m] || {}).tipo,
        };
      }).sort(function(a, b){ return b.value - a.value; }).slice(0, DASH.topNMoviles);
      return {items: items, unit: 'fallas', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};
    }, 'movil', 'Móvil');

    recomputeChart('ranking_activaciones_bar', function(){
      var base = filterRowsCf(DASH.rows, 'movil');
      var act = {}; var groups = groupCriticidad(base, 'movil'); var meta = {};
      base.forEach(function(r){
        act[r.movil] = (act[r.movil] || 0) + r.activaciones;
        meta[r.movil] = {placa: r.placa, tipo: r.tipo};
      });
      var keys = Object.keys(act);
      if(!keys.length) return null;
      var items = keys.map(function(m){
        return {
          name: m, value: act[m], crit: dominantCrit(groups[m]), breakdown: groups[m] || null,
          placa: (meta[m] || {}).placa, tipo: (meta[m] || {}).tipo,
        };
      }).sort(function(a, b){ return b.value - a.value; }).slice(0, DASH.topNMoviles);
      return {items: items, unit: 'activaciones', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};
    }, 'movil', 'Móvil');

    recomputeChart('diagnosticos_bar', function(){
      var base = filterRowsCf(DASH.rows, 'diagnostico');
      var moviles = {}; var crit = {};
      base.forEach(function(r){
        (moviles[r.codigo] = moviles[r.codigo] || {})[r.movil] = 1;
        (crit[r.codigo] = crit[r.codigo] || {})[r.criticidad] = (crit[r.codigo][r.criticidad] || 0) + 1;
      });
      var keys = Object.keys(moviles);
      if(!keys.length) return null;
      var items = keys.map(function(c){
        return {
          name: c, value: Object.keys(moviles[c]).length, crit: dominantCrit(crit[c]), breakdown: crit[c],
          moviles: Object.keys(moviles[c]).length,
        };
      }).sort(function(a, b){ return b.value - a.value; }).slice(0, DASH.topNDiag);
      return {items: items, unit: 'móviles', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};
    }, 'diagnostico', 'Diagnóstico');

    recomputeChart('diagnosticos_frecuentes_bar', function(){
      var base = filterRowsCf(DASH.rows, 'diagnostico');
      var act = {}; var moviles = {}; var crit = {};
      base.forEach(function(r){
        act[r.codigo] = (act[r.codigo] || 0) + r.activaciones;
        (moviles[r.codigo] = moviles[r.codigo] || {})[r.movil] = 1;
        (crit[r.codigo] = crit[r.codigo] || {})[r.criticidad] = (crit[r.codigo][r.criticidad] || 0) + 1;
      });
      var keys = Object.keys(act);
      if(!keys.length) return null;
      var items = keys.map(function(c){
        return {
          name: c, value: act[c], crit: dominantCrit(crit[c]), breakdown: crit[c] || null,
          moviles: moviles[c] ? Object.keys(moviles[c]).length : 0,
        };
      }).sort(function(a, b){ return b.value - a.value; }).slice(0, DASH.topNDiag);
      return {items: items, unit: 'activaciones', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};
    }, 'diagnostico', 'Diagnóstico');

    // Comparativos — misma forma "pareto" horizontal que Sistemas/Ranking
    // (refinamiento visual 2026-09): nombres largos (empresas, tipos de
    // vehículo) ya no chocan con las cifras — cada dato tiene su propia
    // columna fija, en vez de una barra vertical con la etiqueta rotada.
    function comparativeScaleMax(){
      var max = 0;
      [['tipo', 'tipo'], ['marca', 'marca'], ['empresa', 'empresa']].forEach(function(pair){
        var dim = pair[0], field = CF_FIELD[dim];
        var base = filterRowsCf(DASH.rows, dim);
        var counts = countByField(base, field);
        Object.keys(counts).forEach(function(g){
          var size = DASH.fleetSizes[dim][g];
          if(size) max = Math.max(max, Math.round(counts[g] / size * 100) / 100);
        });
      });
      return max || 1;
    }
    var sharedComparisonMax = comparativeScaleMax();
    [['tipo', 'Tipo de vehículo'], ['marca', 'Marca'], ['empresa', 'Empresa']].forEach(function(pair){
      var dim = pair[0], label = pair[1];
      recomputeChart(dim + '_bar', function(){
        var base = filterRowsCf(DASH.rows, dim);
        var field = CF_FIELD[dim];
        var counts = countByField(base, field);
        var groups = groupCriticidad(base, field);
        var items = Object.keys(counts)
          .filter(function(g){ return DASH.fleetSizes[dim][g]; })
          .map(function(g){
            return {name: g, value: Math.round(counts[g] / DASH.fleetSizes[dim][g] * 100) / 100, breakdown: groups[g] || null};
          })
          .sort(function(a, b){ return b.value - a.value; });
        if(!items.length) return null;
        return {items: items, unit: 'fallas/vehículo', color: CORPORATE_BLUE,
                scaleMax: sharedComparisonMax, height: Math.max(200, 30 * items.length)};
      }, dim, label);
    });
  }
  function renderChips(){
    var holder = byId('cf-chips-global');
    if(!holder) return;
    var keys = Object.keys(CF);
    var banner = holder.closest('.cf-banner');
    if(banner) banner.classList.toggle('active', keys.length > 0);
    holder.innerHTML = '';
    keys.forEach(function(key){
      (CF[key] || []).forEach(function(val){
        var chip = document.createElement('span'); chip.className = 'cf-chip';
        chip.appendChild(document.createTextNode(CF_LABELS[key] + ': ' + val + ' '));
        var btn = document.createElement('button'); btn.textContent = '×'; btn.title = 'Quitar este filtro';
        btn.onclick = function(){ cfRemoveValue(key, val); };
        chip.appendChild(btn);
        holder.appendChild(chip);
      });
    });
  }
  function cellHasToken(cellStr, token){
    return cellStr.split(',').map(function(s){ return s.trim(); }).indexOf(token) !== -1;
  }

  // ---- Tooltip inmediato compartido (sin el retardo del title nativo) ----
  var TIP;
  function ensureTip(){
    if(!TIP){ TIP = document.createElement('div'); TIP.id = 'cf-tip'; document.body.appendChild(TIP); }
    return TIP;
  }
  function bindTip(el, htmlFn){
    el.addEventListener('mouseenter', function(e){
      var tip = ensureTip(); tip.innerHTML = htmlFn(); tip.style.display = 'block'; positionTip(e);
    });
    el.addEventListener('mousemove', positionTip);
    el.addEventListener('mouseleave', function(){ if(TIP) TIP.style.display = 'none'; });
  }
  function positionTip(e){
    if(!TIP) return;
    var x = e.clientX + 14, y = e.clientY + 14;
    var maxX = window.innerWidth - TIP.offsetWidth - 10, maxY = window.innerHeight - TIP.offsetHeight - 10;
    TIP.style.left = Math.min(x, Math.max(0, maxX)) + 'px';
    TIP.style.top = Math.min(y, Math.max(0, maxY)) + 'px';
  }

  // ---- Barras (horizontal/vertical, apiladas o agrupadas) ----
  function renderBar(container, spec){
    var max=0;
    spec.categories.forEach(function(_,i){
      var total=0, maxSeries=0;
      spec.series.forEach(function(s){ total+=(s.values[i]||0); maxSeries=Math.max(maxSeries,s.values[i]||0); });
      max=Math.max(max, spec.stacked?total:maxSeries);
    });
    max = max||1;
    var clickHint = spec.cfKey ? '<br><i style="opacity:.7">Haz clic para filtrar</i>' : '';
    if(spec.horizontal){
      spec.categories.forEach(function(cat,i){
        var row=document.createElement('div'); row.className='bar-row';
        var label=document.createElement('div'); label.className='bar-label'; label.textContent=cat; label.title=cat;
        var track=document.createElement('div'); track.className='bar-track';
        var total=0;
        var parts=[];
        spec.series.forEach(function(s){
          var v=s.values[i]||0; if(!v) return;
          var seg=document.createElement('div'); seg.className='bar-seg';
          seg.style.width=(v/max*100)+'%'; seg.style.background=s.color;
          track.appendChild(seg); total+=v;
          parts.push(s.name+': <b>'+v.toLocaleString('es-CO')+'</b>');
        });
        var val=document.createElement('div'); val.className='bar-value'; val.textContent=total.toLocaleString('es-CO');
        row.appendChild(label); row.appendChild(track); row.appendChild(val);
        bindTip(row, function(){ return '<b>'+cat+'</b><br>'+parts.join('<br>')+clickHint; });
        if(spec.cfKey){
          row.classList.add('cf-clickable');
          row.setAttribute('data-cf-key', spec.cfKey);
          row.setAttribute('data-cf-value', cat);
          row.addEventListener('click', function(){ cfToggle(spec.cfKey, cat, spec.cfLabel||spec.cfKey); });
        }
        container.appendChild(row);
      });
    } else {
      var wrap=document.createElement('div'); wrap.className='vbars';
      var labels=document.createElement('div'); labels.className='vbars-labels';
      spec.categories.forEach(function(cat,i){
        var col=document.createElement('div'); col.className='vbar-col';
        var total=0; var parts=[];
        spec.series.forEach(function(s){
          var v=s.values[i]||0; if(!v) return;
          var seg=document.createElement('div'); seg.className='vbar-seg';
          seg.style.height=(v/max*100)+'%'; seg.style.background=s.color;
          col.appendChild(seg); total+=v;
          parts.push(s.name+': <b>'+v.toLocaleString('es-CO')+'</b>');
        });
        var valLabel=document.createElement('div'); valLabel.className='vbar-value';
        valLabel.textContent=total.toLocaleString('es-CO');
        col.appendChild(valLabel);
        bindTip(col, function(){ return '<b>'+cat+'</b><br>'+parts.join('<br>')+clickHint; });
        if(spec.cfKey){
          col.classList.add('cf-clickable');
          col.setAttribute('data-cf-key', spec.cfKey);
          col.setAttribute('data-cf-value', cat);
          col.addEventListener('click', function(){ cfToggle(spec.cfKey, cat, spec.cfLabel||spec.cfKey); });
        }
        wrap.appendChild(col);
        var lab=document.createElement('span'); lab.textContent=cat; lab.title=cat;
        labels.appendChild(lab);
      });
      container.appendChild(wrap); container.appendChild(labels);
    }
    if(spec.series.length>1){
      var legend=document.createElement('div'); legend.className='legend';
      spec.series.forEach(function(s){
        var sp=document.createElement('span');
        var i=document.createElement('i'); i.style.background=s.color;
        sp.appendChild(i); sp.appendChild(document.createTextNode(s.name));
        legend.appendChild(sp);
      });
      container.appendChild(legend);
    }
  }

  function renderEvoStack(container, spec){
    var max = Math.max.apply(null, spec.values.concat([spec.average || 0, 1]));
    var dense = spec.categories.length > 18;
    var wrap = document.createElement('div'); wrap.className = 'vbars evo-wrap' + (dense ? ' dense' : '');
    var labels = document.createElement('div'); labels.className = 'vbars-labels evo-labels' + (dense ? ' dense' : '');
    var types = ['VELOCIDAD', 'RALENTÍ', 'PTO'];
    spec.categories.forEach(function(cat, i){
      var col = document.createElement('div'); col.className = 'vbar-col';
      var v = spec.values[i] || 0, st = spec.stacks[i] || {};
      var seg = document.createElement('div'); seg.className = 'vbar-seg evo-seg evo-stack';
      seg.style.height = (v / max * 100) + '%';
      types.forEach(function(t){
        var n = st[t] || 0; if(!n || !v) return;
        var part = document.createElement('div'); part.className = 'evo-part';
        part.style.height = (n / v * 100) + '%'; part.style.background = spec.colors[t];
        seg.appendChild(part);
      });
      var valLabel = document.createElement('div'); valLabel.className = 'evo-value';
      var totalSpan = document.createElement('span'); totalSpan.className = 'evo-total'; totalSpan.textContent = v.toLocaleString('es-CO');
      valLabel.appendChild(totalSpan); seg.appendChild(valLabel); col.appendChild(seg);
      var mv = (spec.moviles && spec.moviles[i]) || 0;
      bindTip(col, function(){
        return '<b>' + ((spec.labels && spec.labels[i]) || cat) + '</b><br>' + v.toLocaleString('es-CO') + ' eventos · ' + mv + ' móvil(es)'
          + types.map(function(t){ return '<br><span style="color:' + spec.colors[t] + '">■</span> ' + t + ': <b>' + (st[t] || 0).toLocaleString('es-CO') + '</b>'; }).join('')
          + (spec.cfKey ? '<br><i style="opacity:.7">Haz clic para filtrar</i>' : '');
      });
      if(spec.cfKey){
        col.classList.add('cf-clickable'); col.setAttribute('data-cf-key', spec.cfKey); col.setAttribute('data-cf-value', cat);
        col.addEventListener('click', function(){ cfToggle(spec.cfKey, cat, spec.cfLabel || spec.cfKey); });
      }
      wrap.appendChild(col);
      var shown = (spec.labels && spec.labels[i]) || cat; var lab = document.createElement('span'); lab.textContent = shown; lab.title = shown; labels.appendChild(lab);
    });
    if(spec.average){
      var avgLine = document.createElement('div'); avgLine.className = 'avg-line';
      avgLine.style.bottom = Math.min(100, spec.average / max * 100) + '%';
      var avgTag = document.createElement('span'); avgTag.className = 'avg-tag';
      avgTag.textContent = 'Promedio: ' + spec.average.toLocaleString('es-CO', {maximumFractionDigits: 1});
      avgLine.appendChild(avgTag); wrap.appendChild(avgLine);
    }
    container.appendChild(wrap); container.appendChild(labels);
    var legend = document.createElement('div'); legend.className = 'evo-legend';
    types.forEach(function(t){ var sp = document.createElement('span'); sp.innerHTML = '<i style="background:' + spec.colors[t] + '"></i>' + t; legend.appendChild(sp); });
    container.appendChild(legend);
  }

  // ---- Criticidad transversal (refinamiento ejecutivo 2026-09) ----
  var CRIT_ORDER = ['ALTA', 'MEDIA', 'BAJA'];
  var CRIT_ABBR = {ALTA: 'A', MEDIA: 'M', BAJA: 'B'};
  function critMiniParts(breakdown){
    if(!breakdown) return [];
    return CRIT_ORDER.filter(function(c){ return breakdown[c]; });
  }
  function buildCritMini(breakdown, extraClass){
    var parts = critMiniParts(breakdown);
    if(!parts.length) return null;
    var wrap = document.createElement('div'); wrap.className = 'crit-mini' + (extraClass ? ' ' + extraClass : '');
    parts.forEach(function(c){
      var item = document.createElement('span'); item.className = 'cm-item'; item.title = c;
      var letter = document.createElement('b'); letter.className = 'cm-' + c.toLowerCase(); letter.textContent = CRIT_ABBR[c];
      item.appendChild(letter);
      item.appendChild(document.createTextNode(breakdown[c]));
      wrap.appendChild(item);
    });
    return wrap;
  }
  function critTipLine(breakdown){
    var parts = critMiniParts(breakdown).map(function(c){ return c + ': <b>' + breakdown[c] + '</b>'; });
    return parts.length ? parts.join(' · ') : '';
  }

  // ---- Pareto ejecutivo (barra única horizontal, orden mayor->menor) ----
  function renderPareto(container, spec){
    var max = 0;
    spec.items.forEach(function(it){ max = Math.max(max, it.value || 0); });
    max = spec.scaleMax || max || 1;
    var clickHint = spec.cfKey ? '<br><i style="opacity:.7">Haz clic para filtrar</i>' : '';
    var hasCrit = false;
    spec.items.forEach(function(it){
      var row = document.createElement('div'); row.className = 'pareto-row';
      var label = document.createElement('div'); label.className = 'bar-label'; label.title = it.name;
      label.appendChild(document.createTextNode(it.name));
      var value = document.createElement('div'); value.className = 'pareto-value';
      var isTime = spec.unit === 'segundos';
      var valueMain = document.createElement('strong'); valueMain.textContent = isTime ? hDur(it.value) : (it.value || 0).toLocaleString('es-CO', {maximumFractionDigits: 2});
      var valueUnit = document.createElement('small'); valueUnit.textContent = isTime ? 'tiempo' : (spec.unit || 'valor');
      value.appendChild(valueMain); value.appendChild(valueUnit);
      var visual = document.createElement('div'); visual.className = 'pareto-visual';
      var track = document.createElement('div'); track.className = 'bar-track';
      var seg = document.createElement('div'); seg.className = 'bar-seg';
      seg.style.width = (it.value / max * 100) + '%'; seg.style.background = spec.color || CORPORATE_BLUE;
      track.appendChild(seg);
      visual.appendChild(track);
      var mini = buildCritMini(it.breakdown);
      if(mini){ visual.appendChild(mini); hasCrit = true; }
      row.appendChild(label); row.appendChild(value); row.appendChild(visual);

      var tipLines = ['<b>' + it.name + '</b>', (isTime ? 'Tiempo' : (spec.unit || 'valor')) + ': <b>' + (isTime ? hDur(it.value) : (it.value || 0).toLocaleString('es-CO')) + '</b>'];
      var critLine = critTipLine(it.breakdown);
      if(critLine) tipLines.push(critLine);
      if(it.activaciones != null) tipLines.push('Activaciones: <b>' + it.activaciones.toLocaleString('es-CO') + '</b>');
      if(it.moviles != null && spec.unit !== 'móviles') tipLines.push('Móviles: <b>' + it.moviles.toLocaleString('es-CO') + '</b>');
      if(it.placa) tipLines.push('Placa: <b>' + it.placa + '</b>');
      if(it.tipo) tipLines.push('Tipo: <b>' + it.tipo + '</b>');
      if(it.extra) it.extra.forEach(function(line){ tipLines.push(line); });
      bindTip(row, function(){ return tipLines.join('<br>') + clickHint; });

      if(spec.cfKey){
        row.classList.add('cf-clickable');
        row.setAttribute('data-cf-key', spec.cfKey);
        row.setAttribute('data-cf-value', it.name);
        row.addEventListener('click', function(){ cfToggle(spec.cfKey, it.name, spec.cfLabel || spec.cfKey); });
      }
      container.appendChild(row);
    });
    if(spec.scaleMax){
      var scale = document.createElement('p'); scale.className = 'chart-scale';
      scale.textContent = 'Escala compartida: 0–' + spec.scaleMax.toLocaleString('es-CO', {maximumFractionDigits: 2}) + ' ' + (spec.unit || '');
      container.appendChild(scale);
    }
    if(hasCrit){
      var key = document.createElement('div'); key.className = 'crit-key';
      key.innerHTML = '<span><b class="cm-alta">A</b> Alta</span><span><b class="cm-media">M</b> Media</span><span><b class="cm-baja">B</b> Baja</span>';
      container.appendChild(key);
    }
  }

  // ---- Evolución ejecutiva (barra única por día + línea de promedio) ----
  function renderEvolution(container, spec){
    var refs = spec.values.concat([spec.average || 0, 1]);
    var max = Math.max.apply(null, refs);
    var dense = spec.categories.length > 18;
    var wrap = document.createElement('div'); wrap.className = 'vbars evo-wrap' + (dense ? ' dense' : '');
    var labels = document.createElement('div'); labels.className = 'vbars-labels evo-labels' + (dense ? ' dense' : '');
    var clickHint = spec.cfKey ? '<br><i style="opacity:.7">Haz clic para filtrar</i>' : '';
    spec.categories.forEach(function(cat, i){
      var col = document.createElement('div'); col.className = 'vbar-col';
      var v = spec.values[i] || 0;
      var bd = (spec.breakdown && spec.breakdown[i]) || {};
      var seg = document.createElement('div'); seg.className = 'vbar-seg evo-seg';
      seg.style.height = (v / max * 100) + '%'; seg.style.background = spec.color || CORPORATE_BLUE;
      var valLabel = document.createElement('div'); valLabel.className = 'evo-value';
      var totalSpan = document.createElement('span'); totalSpan.className = 'evo-total'; totalSpan.textContent = v.toLocaleString('es-CO');
      valLabel.appendChild(totalSpan);
      var mini = buildCritMini(bd, 'evo-mini');
      if(mini) valLabel.appendChild(mini);
      seg.appendChild(valLabel);
      col.appendChild(seg);
      var mv = (spec.moviles && spec.moviles[i]) || 0;
      bindTip(col, function(){
        var critLine = critTipLine(bd);
        return '<b>' + cat + '</b><br>' + v.toLocaleString('es-CO') + ' fallas distintas · ' + mv + ' móvil(es) afectados'
          + (critLine ? '<br>' + critLine : '') + clickHint;
      });
      if(spec.cfKey){
        col.classList.add('cf-clickable');
        col.setAttribute('data-cf-key', spec.cfKey);
        col.setAttribute('data-cf-value', cat);
        col.addEventListener('click', function(){ cfToggle(spec.cfKey, cat, spec.cfLabel || spec.cfKey); });
      }
      wrap.appendChild(col);
      var lab = document.createElement('span'); lab.textContent = cat; lab.title = cat;
      labels.appendChild(lab);
    });
    if(spec.average){
      var avgLine = document.createElement('div'); avgLine.className = 'avg-line';
      avgLine.style.bottom = Math.min(100, spec.average / max * 100) + '%';
      var avgTag = document.createElement('span'); avgTag.className = 'avg-tag';
      avgTag.textContent = 'Promedio: ' + spec.average.toLocaleString('es-CO', {maximumFractionDigits: 1});
      avgLine.appendChild(avgTag);
      wrap.appendChild(avgLine);
    }
    container.appendChild(wrap); container.appendChild(labels);
  }

  // ---- Criticidad transversal — franja compacta pegada al Resumen ejecutivo ----
  function renderDistributionBar(container, spec){
    var items = spec.items.filter(function(it){ return it.value > 0; });
    var total = items.reduce(function(a, it){ return a + it.value; }, 0) || 1;
    var wrap = document.createElement('div'); wrap.className = 'crit-strip';
    var head = document.createElement('span'); head.className = 'crit-strip-head'; head.textContent = spec.title || 'Criticidad de las fallas';
    wrap.appendChild(head);
    var clickHint = spec.cfKey ? '<br><i style="opacity:.7">Haz clic para filtrar</i>' : '';
    items.forEach(function(it){
      var pill = document.createElement('span'); pill.className = 'crit-pill';
      var dot = document.createElement('i'); dot.className = 'crit-pill-dot'; dot.style.background = it.color;
      var name = document.createElement('span'); name.className = 'crit-pill-name'; name.textContent = it.name;
      var val = document.createElement('b'); val.textContent = it.value.toLocaleString('es-CO');
      var pct = document.createElement('small'); pct.textContent = it.pct + ' %';
      pill.appendChild(dot); pill.appendChild(name); pill.appendChild(val); pill.appendChild(pct);
      bindTip(pill, function(){ return it.name + ': <b>' + it.value.toLocaleString('es-CO') + '</b> (' + it.pct + '%)' + clickHint; });
      if(spec.cfKey){
        pill.classList.add('cf-clickable');
        pill.setAttribute('data-cf-key', spec.cfKey);
        pill.setAttribute('data-cf-value', it.name);
        pill.addEventListener('click', function(){ cfToggle(spec.cfKey, it.name, spec.cfLabel || spec.cfKey); });
      }
      wrap.appendChild(pill);
    });
    var bar = document.createElement('div'); bar.className = 'crit-strip-bar';
    items.forEach(function(it){
      var seg = document.createElement('span'); seg.style.width = (it.value / total * 100) + '%'; seg.style.background = it.color;
      bar.appendChild(seg);
    });
    wrap.appendChild(bar);
    container.appendChild(wrap);
  }

  // ---- Timeline (episodios como barras horizontales por rango) ----
  function renderTimeline(container, spec){
    var span=(spec.max-spec.min)||1;
    spec.rows.forEach(function(r){
      var row=document.createElement('div'); row.className='timeline-row';
      var label=document.createElement('div'); label.className='timeline-label'; label.textContent=r.label; label.title=r.label;
      var track=document.createElement('div'); track.className='timeline-track';
      var bar=document.createElement('div'); bar.className='timeline-bar';
      var left=(r.start-spec.min)/span*100, width=Math.max((r.end-r.start)/span*100, 0.6);
      bar.style.left=left+'%'; bar.style.width=width+'%'; bar.style.background=r.color;
      bar.title=r.tooltip||r.label;
      track.appendChild(bar);
      row.appendChild(label); row.appendChild(track);
      container.appendChild(row);
    });
  }

  function initCharts(){
    document.querySelectorAll('.chart[data-src]').forEach(function(el){
      try {
        var spec=readData(el.getAttribute('data-src'));
        if(!spec || spec.deferred) return;
        var kind = el.dataset.kind;
        if(kind==='bar') renderBar(el, spec);
        else if(kind==='pareto') renderPareto(el, spec);
        else if(kind==='evolution') renderEvolution(el, spec);
        else if(kind==='distribution') renderDistributionBar(el, spec);
        else if(kind==='timeline') renderTimeline(el, spec);
        else throw new Error('Tipo de gráfica no soportado: ' + kind);
      } catch(error) {
        console.error('[Telemetry report] No se pudo renderizar la gráfica ' + (el.id || '(sin id)'), error);
        el.innerHTML = '';
        var message = document.createElement('div');
        message.className = 'chart-render-error';
        message.textContent = 'No se pudo renderizar esta gráfica';
        el.appendChild(message);
      }
    });
  }

  function escHtml(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ---- Tablas: búsqueda + orden + paginación ----
  function initTables(){
    document.querySelectorAll('.table-card[data-src]').forEach(function(card){
      var payload=readData(card.getAttribute('data-src'));
      if(!payload) return;
      var columns=payload.columns, rows=payload.rows.slice(), pageSize=payload.pageSize||20;
      var state={page:0, sortCol:-1, sortDir:1, filter:''};
      var scroll=card.querySelector('.table-scroll');
      var search=card.querySelector('.table-search');
      var pager=card.querySelector('.table-pager');
      var sortSelect=card.querySelector('.table-sort-mobile');
      var sortDirBtn=card.querySelector('.table-sort-dir');
      var crossfilter=payload.crossfilter||[];
      var secondaryNames = payload.secondaryColumns || [];
      var secondaryIdx = secondaryNames.map(function(n){ return columns.indexOf(n); }).filter(function(i){ return i >= 0; });
      var primaryIdx = columns.map(function(_, i){ return i; }).filter(function(i){ return secondaryIdx.indexOf(i) === -1; });

      if(sortSelect){
        primaryIdx.forEach(function(i){
          var opt=document.createElement('option'); opt.value=String(i); opt.textContent=columns[i];
          sortSelect.appendChild(opt);
        });
        sortSelect.addEventListener('change', function(){
          state.sortCol = parseInt(sortSelect.value, 10); state.sortDir = 1; render();
        });
      }
      if(sortDirBtn){
        sortDirBtn.addEventListener('click', function(){
          state.sortDir *= -1; render();
        });
      }
      function syncSortControls(){
        if(sortSelect && state.sortCol >= 0) sortSelect.value = String(state.sortCol);
        if(sortDirBtn) sortDirBtn.textContent = state.sortDir === 1 ? '↓' : '↑';
      }

      function cellText(c){ return (c&&typeof c==='object') ? String(c.text||'') : String(c); }
      function cellMatchesAny(cell, mapping, values){
        var text = cellText(cell);
        return values.some(function(v){
          return mapping.match === 'contains' ? cellHasToken(text, v) : mapping.match === 'prefix' ? text.indexOf(v) === 0 : text === v;
        });
      }
      function filtered(){
        var list=rows;
        if(state.filter){
          var q=state.filter.toLowerCase();
          list=list.filter(function(r){ return r.some(function(c){return cellText(c).toLowerCase().indexOf(q)!==-1;}); });
        }
        Object.keys(CF).forEach(function(key){
          var mapping = crossfilter.filter(function(m){ return m.key === key; })[0];
          if(!mapping) return;
          var idx = columns.indexOf(mapping.column);
          if(idx < 0) return;
          var values = CF[key];
          list = list.filter(function(r){ return cellMatchesAny(r[idx], mapping, values); });
        });
        return list;
      }
      function sorted(list){
        if(state.sortCol<0) return list;
        var idx=state.sortCol, dir=state.sortDir;
        return list.slice().sort(function(a,b){
          var ca=a[idx], cb=b[idx];
          if(ca && cb && typeof ca==='object' && typeof cb==='object' && ca.sort!=null && cb.sort!=null) return (ca.sort-cb.sort)*dir;
          var x=cellText(ca), y=cellText(cb);
          var nx=parseFloat(x.replace(/\./g,'').replace(',','.')), ny=parseFloat(y.replace(/\./g,'').replace(',','.'));
          var cmp = (!isNaN(nx)&&!isNaN(ny)) ? (nx-ny) : x.localeCompare(y,'es');
          return cmp*dir;
        });
      }
      function renderCellInto(td, c, colName){
        if(c && typeof c === 'object' && c.href){
          var a=document.createElement('a'); a.href=c.href; a.target='_blank'; a.rel='noopener noreferrer';
          a.textContent=c.text||c.href; a.className='ext-link'; td.appendChild(a);
          return;
        }
        var text = cellText(c);
        td.textContent = text;
        if(text) td.title = text;
        if(colName === 'Diagnóstico') td.classList.add('dt-cell-wide');
        else if(colName === 'Categoría') td.classList.add('dt-cell-narrow');
      }
      function render(){
        var data=sorted(filtered());
        var totalPages=Math.max(1, Math.ceil(data.length/pageSize));
        state.page=Math.min(state.page, totalPages-1);
        var pageRows=data.slice(state.page*pageSize, state.page*pageSize+pageSize);
        if(!data.length){
          scroll.innerHTML='<p style="color:var(--muted);font-size:12.5px;padding:8px 2px">Sin resultados para esta selección.</p>';
          pager.innerHTML=''; return;
        }
        syncSortControls();
        var table=document.createElement('table'); table.className='dt' + (secondaryIdx.length ? ' dt-compact' : '');
        var thead=document.createElement('thead'); var htr=document.createElement('tr');
        primaryIdx.forEach(function(i){
          var col = columns[i];
          var th=document.createElement('th'); th.textContent=col;
          if(i===state.sortCol) th.className = state.sortDir===1?'sort-asc':'sort-desc';
          th.addEventListener('click', function(){
            if(state.sortCol===i) state.sortDir*=-1; else {state.sortCol=i; state.sortDir=1;}
            render();
          });
          htr.appendChild(th);
        });
        thead.appendChild(htr); table.appendChild(thead);
        var tbody=document.createElement('tbody');
        pageRows.forEach(function(r, visibleIndex){
          var stripe = card.id === 't_maestra' ? (visibleIndex % 2 ? ' dt-row-even' : ' dt-row-odd') : '';
          var tr=document.createElement('tr');
          if(secondaryIdx.length) tr.className = 'dt-row-primary';
          tr.className += stripe;
          primaryIdx.forEach(function(i){
            var td=document.createElement('td');
            td.setAttribute('data-label', columns[i]);
            renderCellInto(td, r[i], columns[i]);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
          if(secondaryIdx.length){
            var parts = secondaryIdx.map(function(i){
              var text = cellText(r[i]);
              return text ? ('<b>' + escHtml(columns[i]) + ':</b> ' + escHtml(text)) : null;
            }).filter(function(p){ return p; });
            if(parts.length){
              var trS = document.createElement('tr'); trS.className = 'dt-row-secondary' + stripe;
              var tdS = document.createElement('td'); tdS.colSpan = primaryIdx.length;
              tdS.innerHTML = parts.join(' &nbsp;·&nbsp; ');
              trS.appendChild(tdS);
              tbody.appendChild(trS);
            }
          }
        });
        table.appendChild(tbody);
        scroll.innerHTML=''; scroll.appendChild(table);
        pager.innerHTML='';
        var info=document.createElement('span');
        info.textContent = data.length ? ('Mostrando '+(state.page*pageSize+1)+'–'+Math.min(data.length,(state.page+1)*pageSize)+' de '+data.length) : 'Sin resultados';
        var prev=document.createElement('button'); prev.textContent='Anterior'; prev.disabled=state.page<=0;
        prev.onclick=function(){state.page--; render();};
        var next=document.createElement('button'); next.textContent='Siguiente'; next.disabled=state.page>=totalPages-1;
        next.onclick=function(){state.page++; render();};
        pager.appendChild(info); pager.appendChild(prev); pager.appendChild(next);
      }
      if(search) search.addEventListener('input', function(e){ state.filter=e.target.value; state.page=0; render(); });
      if(crossfilter.length) CF_TABLES.push(function(){ state.page=0; render(); });
      render();
    });
  }

  function runInitPhase(name, fn){
    try { fn(); }
    catch(error) { console.error('[Telemetry report] Falló la inicialización de ' + name, error); }
  }

  document.addEventListener('DOMContentLoaded', function(){
    runInitPhase('dashboard', loadDashboard);
    runInitPhase('gráficas', initCharts);
    runInitPhase('recálculo', recomputeDashboard);
    runInitPhase('tablas', initTables);
  });
})();
