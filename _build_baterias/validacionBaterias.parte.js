
  // ============================================================================
  // PANTALLA: Validación de Baterías
  // ============================================================================

  var REFRESCO_MS = 30 * 60 * 1000;     // el ESR y el mínimo de arranque cambian por días, no por minutos
  var elementos = {};
  var datos = null;                     // { filas, ahoraMs }
  var filtros = { ciudad: '', sistema: '', estado: '', texto: '' };
  var seleccionado = null;              // id del vehículo con detalle abierto
  var graficoActual = null;
  var cargando = false;
  var temporizador = null;

  var COLOR_NORMAL = { fondo: '#EAF4DF', texto: '#3F6B12', borde: '#C5E0A5' };
  var ORDEN_ESTADOS = ['Alerta', 'Revisar', 'Vigilar', 'Normal', 'Sin datos'];

  function fmtV(x) { return (x === null || x === undefined || isNaN(x)) ? '—' : (Math.round(x * 10) / 10).toFixed(1).replace('.', ','); }
  function fmtVcon(x) { return (x === null || x === undefined || isNaN(x)) ? '—' : (x > 0 ? '+' : '') + fmtV(x); }
  function num(x, dec) { return (x === null || x === undefined || isNaN(x)) ? '' : String(Math.round(x * Math.pow(10, dec || 0)) / Math.pow(10, dec || 0)).replace('.', ','); }

  function fmtEdad(ms, ahora) {
    if (!ms) return '—';
    var h = (ahora - ms) / MS_HORA;
    if (h < 1) return 'hace ' + Math.max(1, Math.round(h * 60)) + ' min';
    if (h < 48) return 'hace ' + Math.round(h) + ' h';
    return 'hace ' + Math.floor(h / 24) + ' d';
  }

  function pildoraEstado(ev) {
    if (ev.estado === 'Normal') {
      return crear('span', {
        display: 'inline-block', padding: '2px 10px', borderRadius: T.radius.pill, fontSize: '0.72rem', fontWeight: '700',
        background: COLOR_NORMAL.fondo, color: COLOR_NORMAL.texto, border: '1px solid ' + COLOR_NORMAL.borde, whiteSpace: 'nowrap'
      }, ev.sinReferencia ? 'Normal*' : 'Normal');
    }
    return crearPildora(ev.estado, ev.estado === 'Sin datos' ? 0 : ev.nivel);
  }

  // --- Filtros ---------------------------------------------------------------------
  function filasFiltradas() {
    if (!datos) return [];
    var q = filtros.texto.trim().toLowerCase();
    return datos.filas.filter(function (ev) {
      if (filtros.ciudad && ev.vehiculo.ciudad !== filtros.ciudad) return false;
      if (filtros.sistema && String(ev.nominal) !== filtros.sistema) return false;
      if (filtros.estado && ev.estado !== filtros.estado) return false;
      if (q && ev.vehiculo.nombre.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function ordenarFilas(filas) {
    return filas.slice().sort(function (a, b) {
      var oa = ORDEN_ESTADOS.indexOf(a.estado), ob = ORDEN_ESTADOS.indexOf(b.estado);
      if (oa !== ob) return oa - ob;
      var ea = a.esr === null ? 999 : a.esr, eb = b.esr === null ? 999 : b.esr;
      if (ea !== eb) return ea - eb;
      var ma = a.minimoV === null ? 999 : a.minimoV, mb = b.minimoV === null ? 999 : b.minimoV;
      return ma - mb;
    });
  }

  // --- KPIs ------------------------------------------------------------------------
  function pintarKpis(filas) {
    var cont = vaciar(elementos.kpis);
    function contar(est) { return filas.filter(function (f) { return f.estado === est; }).length; }
    var conEsr = filas.filter(function (f) { return f.esrVigente; }).length;
    var sinRef = filas.filter(function (f) { return f.sinReferencia; }).length;
    var defs = [
      [String(filas.length), 'Vehículos evaluados', 'ESR vigente en ' + conEsr + ' · señales en ' + (filas.length - conEsr), undefined, ''],
      [String(contar('Alerta')), 'Alerta', 'ESR < ' + ESR_ALERTA + ' o falla grave', 3, 'Alerta'],
      [String(contar('Revisar')), 'Revisar', 'ESR bajo, caída o sin recuperar', 2, 'Revisar'],
      [String(contar('Vigilar')), 'Vigilar', 'Mínimo de arranque bajo', 1, 'Vigilar'],
      [String(contar('Sin datos')), 'Sin datos', 'Sin ESR ni arranques suficientes', 0, 'Sin datos'],
      [String(sinRef), 'Sin ESR (24 V)', 'Sin umbral absoluto: solo comparación', 0, '']
    ];
    defs.forEach(function (d) {
      var t = crearTarjetaKpi(d[0], d[1], d[2], d[3]);
      if (d[4]) {
        t.style.cursor = 'pointer';
        if (filtros.estado === d[4]) t.style.outline = '2px solid ' + T.color.primary;
        t.title = 'Clic para filtrar la tabla por "' + d[4] + '" (otro clic lo quita)';
        t.addEventListener('click', function () {
          filtros.estado = filtros.estado === d[4] ? '' : d[4];
          elementos.estadoSel.select.value = filtros.estado;
          repintar();
        });
      }
      cont.appendChild(t);
    });
  }

  // --- Tabla -----------------------------------------------------------------------
  function pintarTabla(filas) {
    var cont = vaciar(elementos.tabla);
    if (!filas.length) {
      cont.appendChild(crear('div', { padding: '28px', textAlign: 'center', color: T.color.muted, fontSize: '0.85rem' }, 'Ningún vehículo coincide con los filtros.'));
      return;
    }
    var ahora = datos.ahoraMs;
    var columnas = [
      { titulo: 'Vehículo', valor: function (f) {
          var d = crear('div'); d.appendChild(crear('div', { fontWeight: '700' }, f.vehiculo.nombre));
          d.appendChild(crear('div', { fontSize: '0.7rem', color: T.color.muted }, f.vehiculo.marca)); return d;
        }, orden: function (f) { return f.vehiculo.nombre; } },
      { titulo: 'Ciudad', valor: function (f) { return f.vehiculo.ciudad; }, orden: function (f) { return f.vehiculo.ciudad; } },
      { titulo: 'Sistema', valor: function (f) { return f.nominal ? f.nominal + ' V' : '—'; }, orden: function (f) { return f.nominal || 0; }, alinear: 'center' },
      { titulo: 'Estado', valor: pildoraEstado, orden: function (f) { return ORDEN_ESTADOS.indexOf(f.estado); } },
      { titulo: 'Motivo', valor: function (f) {
          return crear('div', { fontSize: '0.75rem', color: T.color.body, minWidth: '280px' }, f.motivos.join(' · ') || (f.sinReferencia ? 'Sin novedad (sin ESR de referencia)' : 'Sin novedad'));
        } },
      { titulo: 'Fuente', valor: function (f) { return f.esrVigente ? 'ESR Geotab' : (f.sinReferencia ? 'Señales · sin ESR' : 'Señales (estimado)'); }, orden: function (f) { return f.esrVigente ? 0 : 1; } },
      { titulo: 'ESR', alinear: 'right', valor: function (f) {
          if (f.esr === null) return '—';
          var d = crear('div'); d.appendChild(crear('div', { fontWeight: '700' }, String(Math.round(f.esr))));
          d.appendChild(crear('div', { fontSize: '0.68rem', color: f.esrVigente ? T.color.muted : COLOR_NIVEL[2].texto }, f.esrVigente ? f.esrBanda : f.esrBanda + ' · ' + fmtEdad(ahora - f.esrEdadH * MS_HORA, ahora)));
          return d;
        }, orden: function (f) { return f.esr; } },
      { titulo: 'Mín. al arrancar (V)', alinear: 'right', valor: function (f) { return fmtV(f.minimoV); }, orden: function (f) { return f.minimoV; } },
      { titulo: 'Cambio vs sem. previa (V)', alinear: 'right', valor: function (f) {
          var s = crear('span', null, fmtVcon(f.cambioMinimoV));
          if (f.cambioMinimoV !== null && f.cambioMinimoV <= -TENDENCIA_VIGILAR_V * (f.nominal / 12)) { s.style.color = COLOR_NIVEL[2].texto; s.style.fontWeight = '700'; }
          return s;
        }, orden: function (f) { return f.cambioMinimoV; } },
      { titulo: 'Recuperación (V)', alinear: 'right', valor: function (f) {
          var s = crear('span', null, fmtVcon(f.recuperacionV));
          if (f.noRecuperaPct !== null && f.arranquesRec7d >= RECUPERA_MIN_ARRANQUES && f.noRecuperaPct >= RECUPERA_FRACCION) { s.style.color = COLOR_NIVEL[2].texto; s.style.fontWeight = '700'; }
          return s;
        }, orden: function (f) { return f.recuperacionV; } },
      { titulo: 'Arranques 7 d', alinear: 'right', valor: function (f) { return f.arranques7d; }, orden: function (f) { return f.arranques7d; } },
      { titulo: 'Último dato', valor: function (f) { return fmtEdad(f.ultimoDatoMs, ahora); }, orden: function (f) { return f.ultimoDatoMs; } }
    ];
    cont.appendChild(crearTabla(columnas, ordenarFilas(filas), function (f) { seleccionado = seleccionado === f.vehiculo.id ? null : f.vehiculo.id; pintarDetalle(); }));
  }

  // --- Detalle de un vehículo (gráfico ESR + mínimo de arranque) -------------------------
  function destruirGrafico() { if (graficoActual) { try { graficoActual.destroy(); } catch (e) { /* ya destruido */ } graficoActual = null; } }

  function pintarDetalle() {
    destruirGrafico();
    var cont = vaciar(elementos.detalle);
    var ev = null;
    if (seleccionado && datos) datos.filas.forEach(function (f) { if (f.vehiculo.id === seleccionado) ev = f; });
    if (!ev) { cont.style.display = 'none'; return; }
    cont.style.display = 'block';
    var panel = crearPanel({ padding: '16px 18px', margin: '0 22px 16px 22px' });
    var cab = crear('div', { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' });
    cab.appendChild(crear('div', { fontWeight: '800', fontSize: '1rem', color: T.color.ink }, ev.vehiculo.nombre));
    cab.appendChild(pildoraEstado(ev));
    cab.appendChild(crear('div', { fontSize: '0.78rem', color: T.color.muted }, ev.vehiculo.ciudad + ' · ' + ev.vehiculo.marca + ' · ' + (ev.nominal ? ev.nominal + ' V' : 'sistema desconocido')));
    var cerrar = crearBoton('Cerrar', false); cerrar.style.marginLeft = 'auto'; cerrar.style.padding = '5px 12px';
    cerrar.addEventListener('click', function () { seleccionado = null; pintarDetalle(); });
    cab.appendChild(cerrar);
    panel.appendChild(cab);
    panel.appendChild(crear('div', { fontSize: '0.8rem', color: T.color.body, marginBottom: '10px' },
      ev.motivos.length ? ev.motivos.join(' · ') : 'Sin novedad.' + (ev.sinReferencia ? ' (24 V: sin ESR de referencia, la ausencia de alertas no es una garantía de buen estado.)' : '')));

    var dias = {};
    ev.serieEsr.forEach(function (p) { dias[p.dia] = true; });
    ev.serieMinimo.forEach(function (p) { dias[p.dia] = true; });
    var etiquetas = Object.keys(dias).sort();
    if (!etiquetas.length) {
      panel.appendChild(crear('div', { color: T.color.muted, fontSize: '0.8rem' }, 'Sin datos para graficar.'));
    } else if (typeof Chart === 'undefined') {
      panel.appendChild(crear('div', { color: T.color.muted, fontSize: '0.8rem' }, 'No se pudo cargar Chart.js (¿sin acceso a internet?). Los datos siguen en la tabla y en el CSV.'));
    } else {
      var caja = crear('div', { position: 'relative', height: '260px' });
      var lienzo = document.createElement('canvas'); caja.appendChild(lienzo); panel.appendChild(caja);
      var mapaEsr = {}, mapaMin = {};
      ev.serieEsr.forEach(function (p) { mapaEsr[p.dia] = p.valor; });
      ev.serieMinimo.forEach(function (p) { mapaMin[p.dia] = Math.round(p.valor * 100) / 100; });
      graficoActual = new Chart(lienzo.getContext('2d'), {
        type: 'line',
        data: {
          labels: etiquetas.map(function (d) { return d.slice(8, 10) + '-' + MESES[parseInt(d.slice(5, 7), 10) - 1]; }),
          datasets: [
            { label: 'ESR Geotab (0-100)', data: etiquetas.map(function (d) { return d in mapaEsr ? mapaEsr[d] : null; }), borderColor: T.color.primaryDark, backgroundColor: T.color.primaryDark, yAxisID: 'y', spanGaps: true, tension: 0.2, pointRadius: 2 },
            { label: 'Voltaje mínimo al arrancar (V, mediana diaria)', data: etiquetas.map(function (d) { return d in mapaMin ? mapaMin[d] : null; }), borderColor: '#0891B2', backgroundColor: '#0891B2', yAxisID: 'y2', spanGaps: true, tension: 0.2, pointRadius: 2 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
          scales: {
            y: { position: 'left', min: 0, max: 100, title: { display: true, text: 'ESR' } },
            y2: { position: 'right', title: { display: true, text: 'Voltios (mínimo al arrancar)' }, grid: { drawOnChartArea: false } }
          },
          plugins: { legend: { position: 'bottom' } }
        }
      });
    }
    cont.appendChild(panel);
    cont.scrollIntoView && cont.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // --- Exportaciones -----------------------------------------------------------------
  function celdaCsv(v) {
    var t = (v === null || v === undefined) ? '' : String(v);
    return /[;"\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }

  function construirCsv(filas) {
    var cab = ['Vehículo', 'Ciudad', 'Marca', 'Sistema (V)', 'Estado', 'Fuente', 'ESR', 'Banda ESR', 'ESR mediana del periodo', 'Antigüedad ESR (h)',
      'Mínimo al arrancar (V)', 'Cambio vs semana previa (V)', 'Caída al arrancar (V)', 'Reposo (V)', 'Recuperación (V)', '% arranques sin recuperar', 'Arranques 7 d', 'Último dato', 'Motivos'];
    var out = [cab];
    ordenarFilas(filas).forEach(function (f) {
      out.push([f.vehiculo.nombre, f.vehiculo.ciudad, f.vehiculo.marca, f.nominal || '', f.estado, f.esrVigente ? 'ESR Geotab' : (f.sinReferencia ? 'Señales · sin ESR' : 'Señales (estimado)'),
        num(f.esr), f.esrBanda || '', num(f.esrBase), num(f.esrEdadH, 1), num(f.minimoV, 2), num(f.cambioMinimoV, 2), num(f.caidaV, 2), num(f.reposoV, 2), num(f.recuperacionV, 2),
        f.noRecuperaPct === null ? '' : num(f.noRecuperaPct * 100), f.arranques7d, f.ultimoDatoMs ? fmtFecha(f.ultimoDatoMs) : '', f.motivos.join(' | ')]);
    });
    return '﻿' + out.map(function (r) { return r.map(celdaCsv).join(';'); }).join('\r\n');
  }

  // Un mensaje por ciudad, listo para pegar en WhatsApp
  function construirMensaje(filas) {
    var porCiudad = {};
    filas.forEach(function (f) { (porCiudad[f.vehiculo.ciudad] = porCiudad[f.vehiculo.ciudad] || []).push(f); });
    var ahora = fmtFecha(datos.ahoraMs);
    var bloques = Object.keys(porCiudad).sort().map(function (ciudad) {
      var lista = porCiudad[ciudad], l = ['🔋 BATERÍAS — ' + ciudad, ahora, ''];
      [['Alerta', '🔴 ALERTA'], ['Revisar', '🟠 REVISAR'], ['Vigilar', '🟡 VIGILAR']].forEach(function (par) {
        var grupo = lista.filter(function (f) { return f.estado === par[0]; });
        if (!grupo.length) return;
        l.push(par[1] + ' (' + grupo.length + ')');
        ordenarFilas(grupo).forEach(function (f) { l.push('• ' + f.vehiculo.nombre + ' · ' + f.motivos.join(' · ')); });
        l.push('');
      });
      if (l.length === 3) l.push('✅ Sin novedad en baterías.', '');
      var sinDatos = lista.filter(function (f) { return f.estado === 'Sin datos'; }).length, sinRef = lista.filter(function (f) { return f.sinReferencia; }).length;
      if (sinDatos || sinRef) l.push('(' + [sinDatos ? sinDatos + ' sin datos suficientes' : '', sinRef ? sinRef + ' de 24 V sin ESR de referencia' : ''].filter(Boolean).join('; ') + ')');
      return l.join('\n').trim();
    });
    return bloques.join('\n\n────────────────────────────\n\n');
  }

  // --- Pintado general --------------------------------------------------------------------
  function repintar() {
    if (!datos) return;
    var filas = filasFiltradas();
    pintarKpis(filas);
    pintarTabla(filas);
    pintarDetalle();
    elementos.estadoCarga.textContent = 'Datos de ' + fmtFecha(datos.ahoraMs) + ' · ESR de ' + DIAS_ESR + ' d y arranques de ' + DIAS_ARRANQUES + ' d · se actualiza cada ' + (REFRESCO_MS / 60000) + ' min · ' + filas.length + ' de ' + datos.filas.length + ' vehículos';
  }

  function cargar() {
    if (cargando) return;
    cargando = true;
    elementos.botonActualizar.disabled = true;
    var linea = mostrarCargando(elementos.tabla, 'Cargando datos de Geotab…');
    vaciar(elementos.kpis);
    cargarEvaluaciones(function (hecho, total) { linea.textContent = 'Cargando datos de Geotab… ' + hecho + ' de ' + total + ' tramos'; })
      .then(function (r) {
        datos = r;
        var ciudades = {};
        r.filas.forEach(function (f) { ciudades[f.vehiculo.ciudad] = true; });
        elementos.ciudadSel.cargar([{ valor: '', etiqueta: 'Todas' }].concat(Object.keys(ciudades).sort().map(function (c) { return { valor: c, etiqueta: c }; })), filtros.ciudad);
        repintar();
      })
      .catch(function (err) {
        console.error('Validación de Baterías:', err);
        mostrarError(elementos.tabla, describirError(err));
      })
      .then(function () { cargando = false; elementos.botonActualizar.disabled = false; });
  }

  function programarRefresco() {
    detenerRefresco();
    temporizador = setInterval(function () { if (!document.hidden) cargar(); }, REFRESCO_MS);
  }
  function detenerRefresco() { if (temporizador) { clearInterval(temporizador); temporizador = null; } }

  function construirNotaMetodologia() {
    var det = crear('details', { margin: '0 22px 22px 22px', padding: '12px 16px', background: T.color.surface, border: '1px solid ' + T.color.border, borderRadius: T.radius.md, fontSize: '0.78rem', color: T.color.body });
    det.appendChild(crear('summary', { cursor: 'pointer', fontWeight: '700', color: T.color.ink }, 'Cómo se evalúa y qué límites tiene'));
    var lineas = [
      'Fuente 1 — ESR de Geotab (0-100, "Clasificación del sistema eléctrico"): es la referencia. Se usa si su último dato tiene menos de ' + HORAS_ESR_VIGENTE + ' h. Alerta: ESR < ' + ESR_ALERTA + '. Revisar: ESR < ' + ESR_REVISAR + ' o caída de ' + ESR_CAIDA_PUNTOS + ' pts o más bajo su mediana de ' + DIAS_ESR + ' días.',
      'Fuente 2 — Señales de arranque ("Voltaje de arranque"): de cada arranque se toman reposo, mínimo, caída y recuperación; el estado usa la mediana de los últimos 7 días (mínimo ' + MIN_ARRANQUES_VENTANA + ' arranques). Sin ESR vigente, en 12 V: mínimo < ' + fmtV(MINIMO_VIGILAR_12V) + ' V = Vigilar y < ' + fmtV(MINIMO_REVISAR_12V) + ' V = Revisar (umbrales medidos en esta flota el 09-nov-2026).',
      'Tendencia: el mínimo cae ' + fmtV(TENDENCIA_VIGILAR_V) + ' V o más frente a la semana anterior = Vigilar; ' + fmtV(TENDENCIA_REVISAR_V) + ' V o más = Revisar. El peor cambio semanal visto en la flota fue de 0,2 V.',
      'Recuperación: máximo del voltaje del GO en los 5 min siguientes al arranque (no la curva de arranque de ~10 s, que termina antes de que cargue el alternador). Si no llega a ' + fmtV(RECUPERA_CARGA_MIN_12V) + ' V (' + fmtV(RECUPERA_CARGA_MIN_12V * 2) + ' V en 24 V) en ' + Math.round(RECUPERA_FRACCION * 100) + ' % o más de los arranques (mínimo ' + RECUPERA_MIN_ARRANQUES + ') = Revisar alternador o cableado.',
      'Límites: (1) los vehículos de 24 V no tienen ESR de Geotab, por eso no hay umbral absoluto para ellos (marcados "Normal*" cuando no hay novedad): solo se detectan cambios y desviaciones frente a sus pares. (2) El cálculo por señales se calibró con muy pocos casos de baterías malas (3 vehículos con ESR < 30): úselo para priorizar revisión, no para decidir un cambio de batería. (3) Voltajes mostrados en voltios reales; internamente se normalizan a 12 V.',
      '* Normal en un 24 V significa "sin novedad detectable", no "batería comprobada".'
    ];
    lineas.forEach(function (t) { det.appendChild(crear('p', { margin: '8px 0 0 0', lineHeight: '1.45' }, t)); });
    return det;
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi; state = freshState;
      var raiz = document.getElementById('validacionBateriasRoot');
      aplicarEstilo(raiz, { fontFamily: T.font, background: T.color.canvas, padding: '4px' });
      var enc = crearEncabezado('🔋', 'Validación de Baterías',
        'Estado del sistema eléctrico de la flota: ESR de Geotab y señales de arranque, con la fuente y la antigüedad de cada dato.');

      var barra = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' });
      elementos.ciudadSel = crearSelect('Ciudad', [{ valor: '', etiqueta: 'Todas' }], '190px');
      elementos.sistemaSel = crearSelect('Sistema', [{ valor: '', etiqueta: 'Todos' }, { valor: '12', etiqueta: '12 V' }, { valor: '24', etiqueta: '24 V' }], '110px');
      elementos.estadoSel = crearSelect('Estado', [{ valor: '', etiqueta: 'Todos' }].concat(ORDEN_ESTADOS.map(function (e) { return { valor: e, etiqueta: e }; })), '130px');
      var campoBuscar = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
      campoBuscar.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.muted, fontWeight: '600' }, 'Vehículo'));
      var inputBuscar = crear('input', { padding: '7px 10px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm, fontSize: '0.82rem', fontFamily: T.font, color: T.color.ink, width: '150px' });
      inputBuscar.type = 'text'; inputBuscar.placeholder = 'Placa o número';
      campoBuscar.appendChild(inputBuscar);
      elementos.ciudadSel.select.addEventListener('change', function () { filtros.ciudad = this.value; repintar(); });
      elementos.sistemaSel.select.addEventListener('change', function () { filtros.sistema = this.value; repintar(); });
      elementos.estadoSel.select.addEventListener('change', function () { filtros.estado = this.value; repintar(); });
      inputBuscar.addEventListener('input', function () { filtros.texto = this.value; repintar(); });

      elementos.botonActualizar = crearBoton('Actualizar', true);
      elementos.botonActualizar.addEventListener('click', cargar);
      var botonCsv = crearBoton('Descargar CSV', false), botonMsg = crearBoton('Copiar mensaje WhatsApp', false);
      botonCsv.addEventListener('click', function () {
        if (!datos) return;
        descargarArchivo('baterias_' + slug(filtros.ciudad || 'TODAS') + '_' + claveDia(datos.ahoraMs) + '.csv', construirCsv(filasFiltradas()), 'text/csv;charset=utf-8');
      });
      botonMsg.addEventListener('click', function () {
        if (!datos) return;
        var r = copiarTexto(construirMensaje(filasFiltradas()));
        Promise.resolve(r).then(function (ok) { botonMsg.textContent = ok ? 'Copiado ✓' : 'No se pudo copiar'; setTimeout(function () { botonMsg.textContent = 'Copiar mensaje WhatsApp'; }, 2500); });
      });
      [elementos.ciudadSel.envoltorio, elementos.sistemaSel.envoltorio, elementos.estadoSel.envoltorio, campoBuscar, elementos.botonActualizar, botonCsv, botonMsg].forEach(function (e) { barra.appendChild(e); });
      enc.appendChild(barra);
      elementos.estadoCarga = crear('div', { fontSize: '0.72rem', color: T.color.muted, marginTop: '10px' }, '');
      enc.appendChild(elementos.estadoCarga);
      raiz.appendChild(enc);

      elementos.kpis = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', padding: '16px 22px 0 22px' });
      raiz.appendChild(elementos.kpis);
      elementos.detalle = crear('div', { display: 'none', paddingTop: '16px' });   // sobre la tabla: con 85 filas, abajo no se vería
      raiz.appendChild(elementos.detalle);
      var panelTabla = crearPanel({ margin: '16px 22px', padding: '4px 0', overflow: 'hidden' });
      elementos.tabla = crear('div');
      panelTabla.appendChild(elementos.tabla);
      raiz.appendChild(panelTabla);
      raiz.appendChild(construirNotaMetodologia());

      initializedCallback();
      cargar();
    },

    focus: function (freshApi, freshState) {
      api = freshApi; state = freshState;
      programarRefresco();
      if (datos && Date.now() - datos.ahoraMs > REFRESCO_MS) cargar();
    },
    blur: function () { detenerRefresco(); }
  };
