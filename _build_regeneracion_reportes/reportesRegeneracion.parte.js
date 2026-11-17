  // ============================================================================
  // Add-In: Reportes de Regeneraciones DPF
  //
  // Genera, para una ciudad (o todas) y un rango de fechas, un reporte HTML
  // AUTÓNOMO (datos incrustados, sin librerías externas, listo para imprimir a
  // PDF) y un CSV con el detalle. Mismos criterios que "Análisis de
  // Regeneraciones DPF" -- los números del reporte coinciden con el tablero.
  // ============================================================================

  var DIAS_RANGO_POR_DEFECTO = 7;
  var DIAS_HISTORIA_LAMPARA_PREVIA = 3;

  var elementos = {};
  var generando = false;

  function rangoPorDefecto(dias) {
    var hasta = new Date();
    return { desde: aFechaInputValue(new Date(hasta.getTime() - (dias || DIAS_RANGO_POR_DEFECTO) * MS_DIA)), hasta: aFechaInputValue(hasta) };
  }

  function calcular(desdeMs, hastaMs, ciudad, vehiculoId) {
    var ahoraMs = Math.min(hastaMs, Date.now());
    var previo = DIAS_HISTORIA_LAMPARA_PREVIA * MS_DIA;
    return obtenerAlcance().then(function (alcance) {
      var vehiculos = alcance.vehiculos.filter(function (v) { return (!ciudad || v.ciudad === ciudad) && (!vehiculoId || v.id === vehiculoId); });
      if (vehiculoId && !vehiculos.length) throw new Error('El vehículo elegido ya no está en el alcance del reporte; actualiza la página.');
      var rangos = {
        hollin: [desdeMs, hastaMs],
        lampara: [desdeMs - previo, hastaMs], interruptor: [desdeMs - previo, hastaMs], ignicion: [desdeMs - previo, hastaMs]
      };
      return cargarSenales(vehiculos, rangos, function (hechos, total) {
        establecerEstado('Consultando señales de Geotab… ' + hechos + ' de ' + total, false);
      }).then(function (senales) {
        return {
          desde: desdeMs, hasta: hastaMs, ciudad: ciudad, vehiculo: vehiculoId ? vehiculos[0].nombre : '',
          resultados: vehiculos.map(function (v) { return analizarVehiculo(v, senales[v.id], desdeMs, hastaMs, ahoraMs); })
        };
      });
    });
  }

  function resumir(resultados) {
    var s = { vehiculos: resultados.length, regeneraciones: 0, solicitudes: 0, manuales: 0, automaticas: 0, enCurso: 0, reacciones: [], conSolicitud: 0, lamparaEncendida: 0, sinSenal: [] };
    resultados.forEach(function (r) {
      s.regeneraciones += r.regeneraciones.length;
      s.solicitudes += r.solicitudes.length;
      if (r.solicitudes.length) s.conSolicitud++;
      if (r.abierto) s.lamparaEncendida++;
      if (!r.tieneHollin && !r.tieneLampara) s.sinSenal.push(r.nombre);
      r.solicitudes.forEach(function (e) {
        if (e.abierta) s.enCurso++;
        else if (e.manual) { s.manuales++; s.reacciones.push(e.minMotorHastaAccion); }
        else s.automaticas++;
      });
    });
    s.reaccionMediana = mediana(s.reacciones);
    return s;
  }

  // --- CSV -----------------------------------------------------------------------------
  function celdaCsv(v) {
    var t = (v === null || v === undefined) ? '' : String(v);
    return /[;"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function num(n) { return n === null || n === undefined ? '' : String(Math.round(n * 10) / 10).replace('.', ','); }

  // Separador ";" y coma decimal: es lo que abre bien Excel en configuración regional de Colombia.
  function construirCsv(datos) {
    var filas = [['Vehículo', 'Ciudad', 'Marca', 'Tipo', 'Inicio', 'Fin', 'Duración (h)', 'Cómo se resolvió', 'Interruptor activado', 'Min de motor hasta actuar', 'Hollín antes (%)', 'Hollín después (%)']];
    datos.resultados.forEach(function (r) {
      r.solicitudes.forEach(function (e) {
        filas.push([r.nombre, r.ciudad, r.marca, 'Solicitud de lámpara', fmtFecha(e.inicio), e.abierta ? 'sigue encendida' : fmtFecha(e.fin), num(e.horas),
          e.abierta ? 'En curso' : (e.manual ? 'Manual' : 'Resuelta sola'), e.interruptorDesde ? fmtFecha(e.interruptorDesde) : '', e.minMotorHastaAccion, '', '']);
      });
      r.regeneraciones.forEach(function (e) {
        filas.push([r.nombre, r.ciudad, r.marca, 'Regeneración por hollín', fmtFecha(e.inicio), fmtFecha(e.fin), num(e.duracionMin / 60), '', '', '', Math.round(e.valorInicio), Math.round(e.valorFin)]);
      });
    });
    return '﻿' + filas.map(function (f) { return f.map(celdaCsv).join(';'); }).join('\r\n');
  }

  // --- Reporte HTML ------------------------------------------------------------------------
  var CSS_REPORTE =
    ':root{--ink:#1A2235;--body:#475569;--muted:#88929A;--border:#E5E9F0;--primary:#73B828;--primary-d:#59901D;--soft:#EAF4DF;--sol:#D97736;--reg:#73B828}' +
    '*{box-sizing:border-box}body{margin:0;background:#F4F5F8;color:var(--ink);font-family:Inter,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:13px}' +
    '.pag{max-width:1080px;margin:0 auto;padding:24px 20px}' +
    'header{background:#fff;border:1px solid var(--border);border-radius:14px;padding:20px 24px;margin-bottom:16px;border-top:5px solid var(--primary)}' +
    'h1{margin:0 0 4px;font-size:22px;letter-spacing:-.01em}h2{margin:0 0 4px;font-size:15px}.sub{color:var(--body);font-size:12.5px}' +
    '.kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}.kpi{flex:1 1 150px;background:#fff;border:1px solid var(--border);border-radius:12px;padding:14px 16px}' +
    '.kpi b{display:block;font-size:26px;letter-spacing:-.02em;line-height:1.1}.kpi span{font-size:12px;font-weight:700;color:var(--body)}.kpi i{display:block;font-style:normal;font-size:11px;color:var(--muted);margin-top:2px}' +
    '.card{background:#fff;border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:16px;break-inside:avoid}' +
    '.card p{margin:3px 0;color:var(--body)}.nota{font-size:11px;color:var(--muted);margin-top:8px}' +
    'table{width:100%;border-collapse:collapse;font-size:12px}th{background:#F4F5F8;color:var(--muted);text-transform:uppercase;font-size:10.5px;letter-spacing:.03em;text-align:left;padding:7px 9px}' +
    'td{padding:7px 9px;border-top:1px solid var(--border);vertical-align:top}td.n,th.n{text-align:right}' +
    '.barras{display:grid;grid-template-columns:62px 1fr 64px;gap:4px 10px;align-items:center;font-size:11.5px}' +
    '.b{height:9px;border-radius:4px;margin:1px 0}.b.s{background:var(--sol)}.b.r{background:var(--reg)}.lg{display:flex;gap:16px;font-size:11.5px;color:var(--body);margin-bottom:8px}' +
    '.lg em{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px;font-style:normal}' +
    '.p{display:inline-block;padding:1px 9px;border-radius:99px;font-size:11px;font-weight:700;background:#EEF1F5;color:#64748B}' +
    '.p.n3{background:#F7E8E8;color:#BA3B3B}.p.n2{background:#FCEBDD;color:#B45309}.p.n1{background:#FFF6DB;color:#92660A}' +
    '@media print{body{background:#fff}.pag{padding:0;max-width:none}header,.kpi,.card{box-shadow:none}@page{size:A4 landscape;margin:12mm}}';

  function narrativa(s) {
    var l = [];
    if (!s.solicitudes && !s.regeneraciones) {
      l.push('Sin solicitudes de regeneración ni regeneraciones detectadas en los ' + s.vehiculos + ' vehículos del reporte.');
      return l;
    }
    var cerradas = s.manuales + s.automaticas;
    l.push(s.solicitudes + ' solicitud(es) de regeneración (lámpara DPF encendida) en ' + s.conSolicitud + ' de ' + s.vehiculos + ' vehículos.' +
      (cerradas ? ' De las ' + cerradas + ' ya cerradas, ' + s.manuales + ' (' + Math.round(s.manuales / cerradas * 100) + ' %) se atendieron con el interruptor manual y ' + s.automaticas + ' se resolvieron solas.' : ''));
    if (s.reaccionMediana !== null) l.push('El conductor tardó una mediana de ' + fmtMinutos(s.reaccionMediana) + ' de motor encendido en activar el interruptor.');
    l.push(s.regeneraciones + ' regeneración(es) confirmada(s) por caída sostenida del hollín.');
    if (s.lamparaEncendida) l.push(s.lamparaEncendida + ' vehículo(s) tienen la lámpara encendida al cierre del rango.');
    return l;
  }

  function seccionTendencia(datos) {
    var dias = [], vistos = {};
    for (var t = datos.desde; t <= datos.hasta; t += MS_DIA) { var k = claveDia(t); if (!vistos[k]) { vistos[k] = true; dias.push({ clave: k, ms: t }); } }
    var kFin = claveDia(datos.hasta); if (!vistos[kFin]) dias.push({ clave: kFin, ms: datos.hasta });
    var sol = {}, reg = {};
    datos.resultados.forEach(function (r) {
      r.solicitudes.forEach(function (e) { var c = claveDia(e.inicio); sol[c] = (sol[c] || 0) + 1; });
      r.regeneraciones.forEach(function (e) { var c = claveDia(e.inicio); reg[c] = (reg[c] || 0) + 1; });
    });
    var max = 1;
    dias.forEach(function (d) { max = Math.max(max, sol[d.clave] || 0, reg[d.clave] || 0); });
    var h = '<div class="card"><h2>Tendencia diaria</h2><div class="lg"><span><em style="background:var(--sol)"></em>Solicitudes de lámpara</span><span><em style="background:var(--reg)"></em>Regeneraciones detectadas</span></div><div class="barras">';
    dias.forEach(function (d) {
      var a = sol[d.clave] || 0, b = reg[d.clave] || 0;
      h += '<div>' + escaparHtml(fmtDia(d.ms)) + '</div><div><div class="b s" style="width:' + (a / max * 100) + '%"></div><div class="b r" style="width:' + (b / max * 100) + '%"></div></div><div>' + a + ' · ' + b + '</div>';
    });
    return h + '</div></div>';
  }

  function seccionCiudades(datos) {
    var c = {};
    datos.resultados.forEach(function (r) {
      var x = c[r.ciudad] = c[r.ciudad] || { veh: 0, sol: 0, man: 0, reg: 0 };
      x.veh++; x.sol += r.solicitudes.length; x.reg += r.regeneraciones.length;
      r.solicitudes.forEach(function (e) { if (e.manual && !e.abierta) x.man++; });
    });
    var nombres = Object.keys(c).sort(function (a, b) { return c[b].sol - c[a].sol; });
    if (nombres.length < 2) return '';
    var h = '<div class="card"><h2>Por ciudad</h2><table><tr><th>Ciudad</th><th class="n">Vehículos</th><th class="n">Solicitudes</th><th class="n">Manuales</th><th class="n">Regeneraciones detectadas</th></tr>';
    nombres.forEach(function (n) { h += '<tr><td>' + escaparHtml(n) + '</td><td class="n">' + c[n].veh + '</td><td class="n">' + c[n].sol + '</td><td class="n">' + c[n].man + '</td><td class="n">' + c[n].reg + '</td></tr>'; });
    return h + '</table></div>';
  }

  function seccionEncendidas(datos) {
    var lista = datos.resultados.filter(function (r) { return r.abierto; }).sort(function (a, b) { return (b.estado.nivel - a.estado.nivel) || (b.abierto.horasMotor - a.abierto.horasMotor); });
    var h = '<div class="card"><h2>Con la lámpara encendida al cierre del rango (' + lista.length + ')</h2>';
    if (!lista.length) return h + '<p>Ningún vehículo con la lámpara DPF encendida.</p></div>';
    h += '<table><tr><th>Vehículo</th><th>Ciudad</th><th>Qué hacer</th><th>Lámpara desde</th><th class="n">Horas de motor</th><th class="n">Horas totales</th><th>Interruptor</th></tr>';
    lista.forEach(function (r) {
      h += '<tr><td>' + escaparHtml(r.nombre) + '</td><td>' + escaparHtml(r.ciudad) + '</td><td><span class="p n' + r.estado.nivel + '">' + escaparHtml(r.estado.etiqueta) + '</span> ' + escaparHtml(r.estado.texto) + '</td><td>' +
        escaparHtml(fmtFecha(r.abierto.desde)) + '</td><td class="n">' + fmtHoras(r.abierto.horasMotor) + '</td><td class="n">' + fmtHoras(r.abierto.horasTotal) + '</td><td>' +
        (r.abierto.interruptorDesde !== null ? 'desde ' + escaparHtml(fmtFecha(r.abierto.interruptorDesde)) : 'sin activar') + '</td></tr>';
    });
    return h + '</table></div>';
  }

  function seccionVehiculos(datos) {
    var lista = datos.resultados.filter(function (r) { return r.solicitudes.length || r.regeneraciones.length; })
      .sort(function (a, b) { return (b.solicitudes.length - a.solicitudes.length) || (b.regeneraciones.length - a.regeneraciones.length); });
    var h = '<div class="card"><h2>Detalle por vehículo (' + lista.length + ')</h2>';
    if (!lista.length) return h + '<p>Ningún vehículo tuvo solicitudes ni regeneraciones en el rango.</p></div>';
    h += '<table><tr><th>Vehículo</th><th>Ciudad</th><th>Marca</th><th class="n">Solicitudes</th><th class="n">Manuales</th><th class="n">Resueltas solas</th><th class="n">Regeneraciones detectadas</th><th class="n">Reacción mediana</th><th class="n">Lámpara más larga</th></tr>';
    lista.forEach(function (r) {
      var cerradas = r.solicitudes.filter(function (e) { return !e.abierta; });
      var man = cerradas.filter(function (e) { return e.manual; });
      var med = mediana(man.map(function (e) { return e.minMotorHastaAccion; }));
      var horas = r.solicitudes.length ? Math.max.apply(null, r.solicitudes.map(function (e) { return e.horas; })) : null;
      h += '<tr><td>' + escaparHtml(r.nombre) + '</td><td>' + escaparHtml(r.ciudad) + '</td><td>' + escaparHtml(r.marca) + '</td><td class="n">' + r.solicitudes.length + '</td><td class="n">' + man.length +
        '</td><td class="n">' + (cerradas.length - man.length) + '</td><td class="n">' + r.regeneraciones.length + '</td><td class="n">' + escaparHtml(fmtMinutos(med)) + '</td><td class="n">' + (horas === null ? '—' : fmtHoras(horas) + ' h') + '</td></tr>';
    });
    return h + '</table></div>';
  }

  function construirReporteHtml(datos) {
    var s = resumir(datos.resultados);
    var titulo = 'Reporte de Regeneraciones DPF — ' + (datos.vehiculo ? datos.vehiculo + ' (' + datos.resultados[0].ciudad + ')' : (datos.ciudad || 'Todas las ciudades'));
    var rango = fmtFecha(datos.desde) + ' → ' + fmtFecha(datos.hasta) + ' (hora Bogotá)';
    var pctManual = (s.manuales + s.automaticas) ? Math.round(s.manuales / (s.manuales + s.automaticas) * 100) + ' %' : '—';
    var h = '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escaparHtml(titulo) + '</title><style>' + CSS_REPORTE + '</style></head><body><div class="pag">';
    h += '<header><h1>' + escaparHtml(titulo) + '</h1><div class="sub">' + escaparHtml(rango) + ' · ' + s.vehiculos + (s.vehiculos === 1 ? ' vehículo' : ' vehículos') + ' con DPF · generado ' + escaparHtml(fmtFecha(Date.now())) + '</div></header>';
    h += '<div class="kpis">' +
      '<div class="kpi"><b>' + s.solicitudes + '</b><span>Solicitudes de regeneración</span><i>lámpara DPF encendida</i></div>' +
      '<div class="kpi"><b>' + s.regeneraciones + '</b><span>Regeneraciones detectadas</span><i>por caída sostenida del hollín</i></div>' +
      '<div class="kpi"><b>' + pctManual + '</b><span>Atendidas con interruptor manual</span><i>' + s.manuales + ' manuales · ' + s.automaticas + ' solas</i></div>' +
      '<div class="kpi"><b>' + escaparHtml(fmtMinutos(s.reaccionMediana)) + '</b><span>Reacción del conductor</span><i>mediana, minutos de motor encendido</i></div>' +
      '<div class="kpi"><b>' + s.lamparaEncendida + '</b><span>Con lámpara encendida</span><i>al cierre del rango</i></div></div>';
    h += '<div class="card"><h2>Lectura del periodo</h2>' + narrativa(s).map(function (t) { return '<p>' + escaparHtml(t) + '</p>'; }).join('') + '</div>';
    h += seccionTendencia(datos) + seccionCiudades(datos) + seccionEncendidas(datos) + seccionVehiculos(datos);
    if (s.sinSenal.length) {
      h += '<div class="card"><h2>Vehículos sin señal (' + s.sinSenal.length + ')</h2><p>No reportan hollín ni lámpara DPF, por lo que este reporte no puede evaluarlos: ' + escaparHtml(s.sinSenal.join(', ')) + '.</p></div>';
    }
    h += '<div class="nota">Método: una solicitud es un episodio de lámpara DPF encendida (se ignoran parpadeos de menos de 5 min y ceros con el motor apagado o con el interruptor manual activo). ' +
      'Una regeneración detectada es una caída sostenida del hollín de 10 puntos o más en 40 min. Los tiempos de reacción cuentan solo con el motor encendido. ' +
      'Vehículos: los del alcance de la regla "' + escaparHtml(NOMBRE_REGLA_ALCANCE) + '".</div>';
    return h + '</div></body></html>';
  }

  // --- Interfaz -----------------------------------------------------------------------------
  function establecerEstado(texto, esError) {
    if (!elementos.estado) return;
    elementos.estado.textContent = texto;
    elementos.estado.style.color = esError ? T.color.danger : T.color.body;
  }

  function nombreArchivo(datos, extension) {
    return 'Reporte_Regeneracion_' + slug(datos.vehiculo || datos.ciudad || 'TODAS') + '_' + claveDia(datos.desde) + '_' + claveDia(datos.hasta) + '.' + extension;
  }

  function generar(formato) {
    if (generando) return;
    var desde = new Date(elementos.inputDesde.value), hasta = new Date(elementos.inputHasta.value);
    if (isNaN(desde.getTime()) || isNaN(hasta.getTime()) || desde >= hasta) { establecerEstado('El rango no es válido: "Desde" debe ser anterior a "Hasta".', true); return; }
    generando = true;
    elementos.botones.forEach(function (b) { b.disabled = true; b.style.opacity = '0.55'; });
    establecerEstado('Consultando señales de Geotab…', false);
    calcular(desde.getTime(), hasta.getTime(), elementos.ciudad.valor(), elementos.vehiculo.valor())
      .then(function (datos) {
        if (formato === 'csv') descargarArchivo(nombreArchivo(datos, 'csv'), construirCsv(datos), 'text/csv;charset=utf-8');
        else descargarArchivo(nombreArchivo(datos, 'html'), construirReporteHtml(datos), 'text/html;charset=utf-8');
        var s = resumir(datos.resultados);
        establecerEstado('Listo: ' + nombreArchivo(datos, formato === 'csv' ? 'csv' : 'html') + ' (' + s.solicitudes + ' solicitudes, ' + s.regeneraciones + ' regeneraciones detectadas, ' + s.vehiculos + (s.vehiculos === 1 ? ' vehículo).' : ' vehículos).'), false);
      })
      .catch(function (err) {
        console.error('Reportes de Regeneraciones:', err);
        establecerEstado(describirError(err), true);
      })
      .then(function () {
        generando = false;
        elementos.botones.forEach(function (b) { b.disabled = false; b.style.opacity = '1'; });
      });
  }

  // Lista desplegable PROPIA con búsqueda (no un <select> nativo): el popup nativo del navegador se
  // pintaba mal dentro del iframe de Copiloto (más angosto que el campo y sin texto), y con 85 móviles
  // conviene poder escribir para filtrar. Estilos por CSSOM como el resto del add-in.
  function normalizarTexto(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

  function crearBuscador(etiqueta) {
    var envoltorio = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px', position: 'relative', width: '100%' });
    envoltorio.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.muted, fontWeight: '600' }, etiqueta));
    var entrada = crear('input', { padding: '8px 34px 8px 10px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm, fontSize: '0.82rem', fontFamily: T.font, color: T.color.ink, background: '#FFFFFF', width: '100%', boxSizing: 'border-box' });
    entrada.type = 'text'; entrada.setAttribute('autocomplete', 'off'); entrada.placeholder = 'Escribe para buscar…';
    var flecha = crear('div', { position: 'absolute', right: '12px', bottom: '9px', fontSize: '0.7rem', color: T.color.muted, pointerEvents: 'none' }, '▼');
    var lista = crear('div', {
      display: 'none', position: 'absolute', left: '0', right: '0', top: '100%', marginTop: '2px', zIndex: '1000', maxHeight: '280px', overflowY: 'auto',
      background: '#FFFFFF', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm, boxShadow: '0 6px 18px rgba(15,23,42,0.16)'
    });
    envoltorio.appendChild(entrada); envoltorio.appendChild(flecha); envoltorio.appendChild(lista);

    var opciones = [], valor = '', visibles = [], activo = -1, alCambiar = null;
    function etiquetaDe(v) { for (var i = 0; i < opciones.length; i++) if (opciones[i].valor === v) return opciones[i].etiqueta; return ''; }
    function cerrar() { lista.style.display = 'none'; entrada.value = etiquetaDe(valor); }
    function elegir(v) { var cambio = v !== valor; valor = v; cerrar(); if (cambio && alCambiar) alCambiar(v); }
    function resaltar(i) {
      activo = i;
      Array.prototype.forEach.call(lista.children, function (el, k) { el.style.background = k === i ? T.color.primarySoft : '#FFFFFF'; });
      if (lista.children[i] && lista.children[i].scrollIntoView) lista.children[i].scrollIntoView({ block: 'nearest' });
    }
    function pintar(filtro) {
      vaciar(lista);
      var q = normalizarTexto(filtro);
      visibles = opciones.filter(function (o) { return !q || normalizarTexto(o.etiqueta).indexOf(q) !== -1; });
      if (!visibles.length) { lista.appendChild(crear('div', { padding: '10px 12px', fontSize: '0.8rem', color: T.color.muted }, 'Sin coincidencias')); activo = -1; return; }
      visibles.forEach(function (o, i) {
        var fila = crear('div', { padding: '8px 12px', fontSize: '0.82rem', fontFamily: T.font, color: T.color.ink, background: '#FFFFFF', cursor: 'pointer', fontWeight: o.valor === valor ? '700' : '400' }, o.etiqueta);
        fila.addEventListener('mousedown', function (e) { e.preventDefault(); elegir(o.valor); });   // mousedown: antes de que el campo pierda el foco
        fila.addEventListener('mouseenter', function () { resaltar(i); });
        lista.appendChild(fila);
      });
      activo = -1;
    }
    function abrir() { pintar(''); lista.style.display = 'block'; entrada.select(); }

    entrada.addEventListener('focus', abrir);
    entrada.addEventListener('click', function () { if (lista.style.display === 'none') abrir(); });
    entrada.addEventListener('input', function () { pintar(entrada.value); lista.style.display = 'block'; if (visibles.length) resaltar(0); });
    entrada.addEventListener('blur', function () { setTimeout(cerrar, 120); });
    entrada.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (lista.style.display === 'none') abrir(); else if (visibles.length) resaltar(Math.min(visibles.length - 1, activo + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (visibles.length) resaltar(Math.max(0, activo - 1)); }
      else if (e.key === 'Enter') { e.preventDefault(); if (activo >= 0 && visibles[activo]) elegir(visibles[activo].valor); else if (visibles.length === 1) elegir(visibles[0].valor); }
      else if (e.key === 'Escape') { cerrar(); entrada.blur(); }
    });

    return {
      envoltorio: envoltorio,
      cargar: function (nuevas, elegido) { opciones = nuevas; valor = elegido !== undefined ? elegido : ''; entrada.value = etiquetaDe(valor); },
      valor: function () { return valor; },
      alCambiar: function (fn) { alCambiar = fn; }
    };
  }

  // Móviles (vehículos) de la ciudad elegida; al cambiar la ciudad se vuelve a "Todos".
  function cargarVehiculos() {
    var ciudad = elementos.ciudad.valor();
    var lista = (elementos.vehiculosAlcance || []).filter(function (v) { return !ciudad || v.ciudad === ciudad; });
    var opciones = [{ valor: '', etiqueta: 'Todos los vehículos (' + lista.length + ')' }];
    lista.forEach(function (v) { opciones.push({ valor: v.id, etiqueta: v.nombre + (v.marca && v.marca !== 'Sin marca' ? ' — ' + v.marca : '') }); });
    elementos.vehiculo.cargar(opciones, '');
  }

  function cargarCiudades() {
    return obtenerAlcance().then(function (alcance) {
      var m = {};
      alcance.vehiculos.forEach(function (v) { m[v.ciudad] = (m[v.ciudad] || 0) + 1; });
      var opciones = [{ valor: '', etiqueta: 'Todas las ciudades (' + alcance.vehiculos.length + ' vehículos)' }];
      Object.keys(m).sort().forEach(function (c) { opciones.push({ valor: c, etiqueta: c + ' (' + m[c] + ')' }); });
      elementos.ciudad.cargar(opciones, '');
      elementos.vehiculosAlcance = alcance.vehiculos;
      cargarVehiculos();
    }).catch(function (err) {
      console.error('Reportes de Regeneraciones:', err);
      establecerEstado(describirError(err), true);
    });
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi; state = freshState;
      var raiz = document.getElementById('reportesRegeneracionRoot');
      aplicarEstilo(raiz, { fontFamily: T.font, background: T.color.canvas, padding: '4px' });
      raiz.appendChild(crearEncabezado('📄', 'Reportes de Regeneraciones DPF',
        'Genera un reporte HTML autónomo (para imprimir a PDF o enviar) y un CSV con el detalle, por ciudad, vehículo (móvil) y rango de fechas.'));

      var panel = crearPanel({ margin: '16px 22px', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px' });
      elementos.ciudad = crearBuscador('Ciudad');
      elementos.ciudad.cargar([{ valor: '', etiqueta: 'Cargando ciudades…' }], '');
      panel.appendChild(elementos.ciudad.envoltorio);
      elementos.vehiculo = crearBuscador('Vehículo (móvil)');
      elementos.vehiculo.cargar([{ valor: '', etiqueta: 'Cargando vehículos…' }], '');
      elementos.ciudad.alCambiar(cargarVehiculos);
      panel.appendChild(elementos.vehiculo.envoltorio);

      var r0 = rangoPorDefecto();
      var campoDesde = crearCampoFecha('Desde', r0.desde), campoHasta = crearCampoFecha('Hasta', r0.hasta);
      elementos.inputDesde = campoDesde.input; elementos.inputHasta = campoHasta.input;
      var filaFechas = crear('div', { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-end' });
      filaFechas.appendChild(campoDesde.envoltorio);
      filaFechas.appendChild(campoHasta.envoltorio);
      [7, 14, 30].forEach(function (d) {
        var b = crearBoton('Últimos ' + d + ' días', false);
        b.addEventListener('click', function () { var r = rangoPorDefecto(d); campoDesde.input.value = r.desde; campoHasta.input.value = r.hasta; });
        filaFechas.appendChild(b);
      });
      panel.appendChild(filaFechas);

      var botonHtml = crearBoton('Generar reporte HTML', true), botonCsv = crearBoton('Descargar CSV', false);
      botonHtml.addEventListener('click', function () { generar('html'); });
      botonCsv.addEventListener('click', function () { generar('csv'); });
      elementos.botones = [botonHtml, botonCsv];
      var filaBotones = crear('div', { display: 'flex', gap: '10px', flexWrap: 'wrap' });
      filaBotones.appendChild(botonHtml); filaBotones.appendChild(botonCsv);
      panel.appendChild(filaBotones);

      elementos.estado = crear('div', { fontSize: '0.82rem', color: T.color.body, minHeight: '1.2em' });
      panel.appendChild(elementos.estado);
      raiz.appendChild(panel);

      cargarCiudades().then(function () { initializedCallback(); });
    },

    focus: function (freshApi, freshState) { api = freshApi; state = freshState; },
    blur: function () {}
  };
