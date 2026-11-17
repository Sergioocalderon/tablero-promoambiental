  // ============================================================================
  // Add-In: Análisis de Regeneraciones DPF
  //
  // Tablero HISTÓRICO: cuántas veces pidió regeneración cada vehículo (lámpara
  // DPF), cuántas atendió el conductor con el interruptor manual vs. cuántas
  // se resolvieron solas, cuánto tardó en reaccionar (en minutos de MOTOR
  // ENCENDIDO) y cuántas regeneraciones reales se detectaron por caída de
  // hollín. Para el estado EN VIVO ver "Seguimiento de Regeneraciones"; para
  // sacar el reporte imprimible ver "Reportes de Regeneraciones".
  // ============================================================================

  var DIAS_RANGO_POR_DEFECTO = 14;
  var DIAS_HISTORIA_LAMPARA_PREVIA = 3;   // para saber si ya venía encendida al inicio del rango
  var TOP_N = 8;

  var elementos = {};
  var datosCache = null;           // { desde, hasta, resultados: [analisis por vehículo] }
  var filtros = { ciudad: '', marca: '', vehiculo: '' };
  var cargaEnCurso = false;
  var contenedorResultados = null;
  var refsFiltros = null;
  var charts = [];

  function rangoPorDefecto(dias) {
    var hasta = new Date();
    var desde = new Date(hasta.getTime() - (dias || DIAS_RANGO_POR_DEFECTO) * MS_DIA);
    return { desde: aFechaInputValue(desde), hasta: aFechaInputValue(hasta) };
  }

  // --- Cálculo ------------------------------------------------------------------
  function calcular(desdeMs, hastaMs) {
    var ahoraMs = Math.min(hastaMs, Date.now());
    var previo = DIAS_HISTORIA_LAMPARA_PREVIA * MS_DIA;
    return obtenerAlcance().then(function (alcance) {
      var rangos = {
        hollin: [desdeMs, hastaMs],
        lampara: [desdeMs - previo, hastaMs], interruptor: [desdeMs - previo, hastaMs], ignicion: [desdeMs - previo, hastaMs]
      };
      return cargarSenales(alcance.vehiculos, rangos, function (hechos, total) {
        if (elementos.lineaProgreso) elementos.lineaProgreso.textContent = 'Consultando señales de Geotab… ' + hechos + ' de ' + total;
      }).then(function (senales) {
        var resultados = alcance.vehiculos.map(function (v) {
          return analizarVehiculo(v, senales[v.id], desdeMs, hastaMs, ahoraMs);
        });
        return { desde: desdeMs, hasta: hastaMs, resultados: resultados };
      });
    });
  }

  function filtrar(resultados, excluir) {
    return resultados.filter(function (r) {
      if (excluir !== 'ciudad' && filtros.ciudad && r.ciudad !== filtros.ciudad) return false;
      if (excluir !== 'marca' && filtros.marca && r.marca !== filtros.marca) return false;
      if (excluir !== 'vehiculo' && filtros.vehiculo && r.id !== filtros.vehiculo) return false;
      return true;
    });
  }

  function resumir(resultados) {
    var s = { vehiculos: resultados.length, regeneraciones: 0, solicitudes: 0, manuales: 0, automaticas: 0, enCurso: 0,
              reacciones: [], conSolicitud: 0, lamparaEncendida: 0, sinSenal: [] };
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

  // --- Filtros ---------------------------------------------------------------------
  function valoresUnicos(resultados, campo) {
    var m = {};
    resultados.forEach(function (r) { m[r[campo]] = true; });
    return Object.keys(m).sort();
  }

  function sincronizarSelects() {
    if (!refsFiltros) return;
    refsFiltros.ciudad.select.value = filtros.ciudad;
    refsFiltros.marca.select.value = filtros.marca;
    refsFiltros.vehiculo.select.value = filtros.vehiculo;
  }

  function alternarFiltro(clave, valor) {
    filtros[clave] = filtros[clave] === valor ? '' : valor;
    sincronizarSelects();
    renderizarResultados();
  }

  function construirBarraFiltros(contenedor) {
    var barra = crear('div', { padding: '12px 22px', display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-end', background: T.color.surface, borderBottom: '1px solid ' + T.color.border });
    var ciudad = crearSelect('Ciudad', [{ valor: '', etiqueta: 'Todas' }]);
    var marca = crearSelect('Marca', [{ valor: '', etiqueta: 'Todas' }]);
    var vehiculo = crearSelect('Vehículo', [{ valor: '', etiqueta: 'Todos' }], '220px');
    var limpiar = crearBoton('Limpiar filtros', false);
    [ciudad, marca, vehiculo].forEach(function (c, i) {
      var clave = ['ciudad', 'marca', 'vehiculo'][i];
      c.select.addEventListener('change', function () { filtros[clave] = c.select.value; renderizarResultados(); });
      barra.appendChild(c.envoltorio);
    });
    limpiar.addEventListener('click', function () { filtros = { ciudad: '', marca: '', vehiculo: '' }; sincronizarSelects(); renderizarResultados(); });
    barra.appendChild(limpiar);
    contenedor.appendChild(barra);
    refsFiltros = { ciudad: ciudad, marca: marca, vehiculo: vehiculo };
  }

  function actualizarOpcionesFiltros(resultados) {
    var opc = function (vals, todos) { return [{ valor: '', etiqueta: todos }].concat(vals.map(function (v) { return { valor: v, etiqueta: v }; })); };
    refsFiltros.ciudad.cargar(opc(valoresUnicos(resultados, 'ciudad'), 'Todas'), filtros.ciudad);
    refsFiltros.marca.cargar(opc(valoresUnicos(resultados, 'marca'), 'Todas'), filtros.marca);
    refsFiltros.vehiculo.cargar([{ valor: '', etiqueta: 'Todos' }].concat(resultados.map(function (r) { return { valor: r.id, etiqueta: r.nombre }; })), filtros.vehiculo);
  }

  // --- Resumen narrativo ---------------------------------------------------------
  function construirNarrativa(contenedor, s) {
    var panel = crearPanel({ padding: '14px 18px', marginBottom: '16px', borderLeft: '4px solid ' + T.color.primary });
    panel.appendChild(crear('div', { fontSize: '0.7rem', fontWeight: '800', color: T.color.primaryDark, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '6px' }, 'Lectura del periodo'));
    var lineas = [];
    if (!s.solicitudes && !s.regeneraciones) {
      lineas.push('Sin solicitudes de regeneración ni regeneraciones detectadas en los ' + s.vehiculos + ' vehículos del filtro.');
    } else {
      var cerradas = s.manuales + s.automaticas;
      lineas.push(s.solicitudes + ' solicitud(es) de regeneración (lámpara DPF encendida) en ' + s.conSolicitud + ' de ' + s.vehiculos + ' vehículos.' +
        (cerradas ? ' De las ' + cerradas + ' ya cerradas, ' + s.manuales + ' (' + Math.round(s.manuales / cerradas * 100) + ' %) se atendieron con el interruptor manual y ' + s.automaticas + ' se resolvieron solas.' : ''));
      if (s.reaccionMediana !== null) lineas.push('El conductor tardó una mediana de ' + fmtMinutos(s.reaccionMediana) + ' de motor encendido en activar el interruptor.');
      lineas.push(s.regeneraciones + ' regeneración(es) confirmada(s) por caída sostenida del hollín.');
    }
    if (s.lamparaEncendida) lineas.push(s.lamparaEncendida + ' vehículo(s) tienen la lámpara encendida al cierre del rango.');
    lineas.forEach(function (t) { panel.appendChild(crear('div', { fontSize: '0.84rem', color: T.color.body, marginTop: '3px' }, t)); });
    contenedor.appendChild(panel);
  }

  function construirKpis(contenedor, s) {
    var fila = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' });
    var pctManual = (s.manuales + s.automaticas) ? Math.round(s.manuales / (s.manuales + s.automaticas) * 100) + ' %' : '—';
    fila.appendChild(crearTarjetaKpi(String(s.solicitudes), 'Solicitudes de regeneración', 'lámpara DPF encendida'));
    fila.appendChild(crearTarjetaKpi(String(s.regeneraciones), 'Regeneraciones detectadas', 'por caída sostenida del hollín'));
    fila.appendChild(crearTarjetaKpi(pctManual, 'Atendidas con interruptor manual', s.manuales + ' manuales · ' + s.automaticas + ' solas'));
    fila.appendChild(crearTarjetaKpi(fmtMinutos(s.reaccionMediana), 'Reacción del conductor', 'mediana, minutos de motor encendido'));
    fila.appendChild(crearTarjetaKpi(String(s.lamparaEncendida), 'Con lámpara encendida', 'al cierre del rango', s.lamparaEncendida ? 2 : undefined));
    contenedor.appendChild(fila);
  }

  // --- Gráficos ----------------------------------------------------------------------
  function destruirCharts() { charts.forEach(function (c) { c.destroy(); }); charts = []; }

  function crearCaja(titulo, nota, alto) {
    var caja = crearPanel({ padding: '14px 16px', flex: '1 1 340px', minWidth: '300px' });
    caja.appendChild(crear('div', { fontSize: '0.9rem', fontWeight: '800', color: T.color.ink }, titulo));
    if (nota) caja.appendChild(crear('div', { fontSize: '0.72rem', color: T.color.muted, margin: '2px 0 8px 0' }, nota));
    var zona = crear('div', { position: 'relative', height: alto || '250px' });
    var canvas = document.createElement('canvas');
    zona.appendChild(canvas);
    caja.appendChild(zona);
    return { caja: caja, canvas: canvas, zona: zona };
  }

  function clicYCursor(alClic) {
    return {
      onClick: function (evt, els) { if (els && els.length) alClic(els[0].index); },
      onHover: function (evt, els) { if (evt.native && evt.native.target) evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; }
    };
  }

  function construirGraficos(contenedor, filtrados, todosParaCiudad) {
    if (typeof Chart === 'undefined') {
      contenedor.appendChild(crear('div', { padding: '12px 16px', marginBottom: '16px', color: T.color.body, fontSize: '0.82rem', background: T.color.canvas, borderRadius: T.radius.sm }, 'No se cargó la librería de gráficos (Chart.js). Las tarjetas y la tabla funcionan igual.'));
      return;
    }
    destruirCharts();
    var fila = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' });

    // Tendencia diaria
    var dias = [], vistos = {};
    for (var t = datosCache.desde; t <= datosCache.hasta; t += MS_DIA) { var k = claveDia(t); if (!vistos[k]) { vistos[k] = true; dias.push({ clave: k, ms: t }); } }
    var kFin = claveDia(datosCache.hasta); if (!vistos[kFin]) dias.push({ clave: kFin, ms: datosCache.hasta });
    var porDiaReg = {}, porDiaSol = {};
    filtrados.forEach(function (r) {
      r.regeneraciones.forEach(function (e) { var c = claveDia(e.inicio); porDiaReg[c] = (porDiaReg[c] || 0) + 1; });
      r.solicitudes.forEach(function (e) { var c = claveDia(e.inicio); porDiaSol[c] = (porDiaSol[c] || 0) + 1; });
    });
    // Las regeneraciones por hollín son decenas por día y las solicitudes de lámpara pocas: cada serie lleva su propio eje.
    var g1 = crearCaja('Tendencia diaria', 'Barras (eje izquierdo): regeneraciones detectadas · Línea (eje derecho): solicitudes de lámpara');
    charts.push(new Chart(g1.canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: dias.map(function (d) { return fmtDia(d.ms); }),
        datasets: [
          { type: 'bar', label: 'Regeneraciones detectadas', data: dias.map(function (d) { return porDiaReg[d.clave] || 0; }), backgroundColor: COLOR_SERIE.regeneracion, borderRadius: 4, order: 2 },
          { type: 'line', label: 'Solicitudes de lámpara', data: dias.map(function (d) { return porDiaSol[d.clave] || 0; }), borderColor: COLOR_SERIE.solicitud, backgroundColor: COLOR_SERIE.solicitud, borderWidth: 2, tension: 0.3, pointRadius: 2, order: 1, yAxisID: 'y2' }
        ]
      },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, ticks: { precision: 0 } },
          y2: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { precision: 0, color: COLOR_SERIE.solicitud } }
        } }
    }));
    fila.appendChild(g1.caja);

    // Por ciudad (sin aplicar el filtro de ciudad, para poder cambiar de una a otra)
    var ciudades = {};
    todosParaCiudad.forEach(function (r) {
      var c = ciudades[r.ciudad] = ciudades[r.ciudad] || { reg: 0, sol: 0 };
      c.reg += r.regeneraciones.length; c.sol += r.solicitudes.length;
    });
    var nombresCiudad = Object.keys(ciudades).sort(function (a, b) { return ciudades[b].sol - ciudades[a].sol; });
    var g2 = crearCaja('Solicitudes por ciudad', 'Clic en una barra para filtrar por esa ciudad');
    var ciudadElegida = filtros.ciudad;
    var interaccion2 = clicYCursor(function (i) { alternarFiltro('ciudad', nombresCiudad[i]); });
    charts.push(new Chart(g2.canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: nombresCiudad,
        datasets: [
          { label: 'Solicitudes de lámpara', data: nombresCiudad.map(function (n) { return ciudades[n].sol; }), backgroundColor: nombresCiudad.map(function (n) { return !ciudadElegida || n === ciudadElegida ? COLOR_SERIE.solicitud : COLOR_SERIE.solicitud + '4D'; }), borderRadius: 4, barThickness: 18 }
        ]
      },
      options: { indexAxis: 'y', maintainAspectRatio: false, onClick: interaccion2.onClick, onHover: interaccion2.onHover,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
    }));
    fila.appendChild(g2.caja);
    contenedor.appendChild(fila);

    var fila2 = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' });

    // Manual vs automática
    var s = resumir(filtrados);
    var g3 = crearCaja('¿Cómo se resolvieron?', 'Solicitudes de lámpara según cómo se cerraron');
    if (!s.solicitudes) {
      g3.zona.removeChild(g3.canvas);
      g3.zona.appendChild(crear('div', { padding: '40px 0', textAlign: 'center', color: T.color.muted, fontSize: '0.82rem' }, 'Sin solicitudes en el periodo'));
    } else {
      charts.push(new Chart(g3.canvas.getContext('2d'), {
        type: 'doughnut',
        data: { labels: ['Manual (interruptor)', 'Resuelta sola', 'En curso'], datasets: [{ data: [s.manuales, s.automaticas, s.enCurso], backgroundColor: [COLOR_SERIE.manual, COLOR_SERIE.automatica, '#CBD5E1'] }] },
        options: { maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } } }
      }));
    }
    fila2.appendChild(g3.caja);

    // Top vehículos por solicitudes
    var top = filtrados.filter(function (r) { return r.solicitudes.length; })
      .sort(function (a, b) { return b.solicitudes.length - a.solicitudes.length; }).slice(0, TOP_N);
    var g4 = crearCaja('Vehículos con más solicitudes', 'Clic en una barra para filtrar por ese vehículo');
    if (!top.length) {
      g4.zona.removeChild(g4.canvas);
      g4.zona.appendChild(crear('div', { padding: '40px 0', textAlign: 'center', color: T.color.muted, fontSize: '0.82rem' }, 'Sin solicitudes en el periodo'));
    } else {
      var inter4 = clicYCursor(function (i) { alternarFiltro('vehiculo', top[i].id); });
      charts.push(new Chart(g4.canvas.getContext('2d'), {
        type: 'bar',
        data: { labels: top.map(function (r) { return r.nombre; }), datasets: [{ label: 'Solicitudes', data: top.map(function (r) { return r.solicitudes.length; }),
          backgroundColor: top.map(function (r) { return !filtros.vehiculo || r.id === filtros.vehiculo ? COLOR_SERIE.solicitud : COLOR_SERIE.solicitud + '4D'; }), borderRadius: 4, barThickness: 16 }] },
        options: { indexAxis: 'y', maintainAspectRatio: false, onClick: inter4.onClick, onHover: inter4.onHover,
          plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
      }));
    }
    fila2.appendChild(g4.caja);
    contenedor.appendChild(fila2);
  }

  // --- Tabla y detalle ----------------------------------------------------------------
  function construirTabla(contenedor, filtrados, zonaDetalle) {
    var panel = crearPanel({ marginBottom: '16px', overflow: 'hidden' });
    var cab = crear('div', { padding: '12px 16px' });
    cab.appendChild(crear('div', { fontSize: '0.9rem', fontWeight: '800', color: T.color.ink }, 'Detalle por vehículo'));
    cab.appendChild(crear('div', { fontSize: '0.72rem', color: T.color.muted }, 'Clic en una fila para ver su historial · clic en un título para ordenar'));
    panel.appendChild(cab);

    var columnas = [
      { titulo: 'Vehículo', valor: function (r) { return r.nombre; }, orden: function (r) { return r.nombre; } },
      { titulo: 'Ciudad', valor: function (r) { return r.ciudad; }, orden: function (r) { return r.ciudad; } },
      { titulo: 'Marca', valor: function (r) { return r.marca; }, orden: function (r) { return r.marca; } },
      { titulo: 'Solicitudes', alinear: 'right', valor: function (r) { return r.solicitudes.length; }, orden: function (r) { return r.solicitudes.length; } },
      { titulo: 'Manuales', alinear: 'right', valor: function (r) { return r.solicitudes.filter(function (e) { return e.manual; }).length; }, orden: function (r) { return r.solicitudes.filter(function (e) { return e.manual; }).length; } },
      { titulo: 'Regener. detectadas', alinear: 'right', valor: function (r) { return r.regeneraciones.length; }, orden: function (r) { return r.regeneraciones.length; } },
      { titulo: 'Reacción mediana', alinear: 'right', valor: function (r) { var m = reaccionVehiculo(r); return m === null ? '—' : fmtMinutos(m); }, orden: reaccionVehiculo },
      { titulo: 'Lámpara más larga', alinear: 'right', valor: function (r) { var h = horasMax(r); return h === null ? '—' : fmtHoras(h) + ' h'; }, orden: horasMax },
      { titulo: 'Hollín actual', alinear: 'right', valor: function (r) { return r.hollinActual ? Math.round(r.hollinActual.valor) + ' %' : (r.tieneHollin ? 'sin dato reciente' : 'no reporta'); }, orden: function (r) { return r.hollinActual ? r.hollinActual.valor : null; } },
      { titulo: 'Estado', valor: function (r) { return r.estado ? crearPildora(r.estado.etiqueta, r.estado.nivel) : (r.tieneLampara || r.tieneHollin ? crearPildora('Sin novedad', 0) : crearPildora('Sin señal', 0)); },
        orden: function (r) { return r.estado ? r.estado.nivel : -1; } }
    ];
    panel.appendChild(crearTabla(columnas, filtrados, function (r) { construirDetalle(zonaDetalle, r); }));
    contenedor.appendChild(panel);
  }

  function reaccionVehiculo(r) {
    var m = r.solicitudes.filter(function (e) { return e.manual && !e.abierta; }).map(function (e) { return e.minMotorHastaAccion; });
    return mediana(m);
  }
  function horasMax(r) {
    var h = r.solicitudes.map(function (e) { return e.horas; });
    return h.length ? Math.max.apply(null, h) : null;
  }

  function construirDetalle(zona, r) {
    vaciar(zona);
    var panel = crearPanel({ padding: '14px 16px', marginBottom: '16px', borderLeft: '4px solid ' + T.color.primary });
    var titulo = crear('div', { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' });
    titulo.appendChild(crear('div', { fontSize: '1rem', fontWeight: '800', color: T.color.ink }, r.nombre));
    titulo.appendChild(crear('div', { fontSize: '0.78rem', color: T.color.muted }, r.ciudad + ' · ' + r.marca));
    if (r.estado) titulo.appendChild(crearPildora(r.estado.etiqueta, r.estado.nivel));
    panel.appendChild(titulo);

    if (!r.tieneHollin && !r.tieneLampara) {
      panel.appendChild(crear('div', { fontSize: '0.82rem', color: T.color.body }, 'Este vehículo no reportó hollín ni lámpara DPF en el rango (la señal no llega a Geotab o el motor estuvo apagado).'));
    }

    var sol = r.solicitudes.slice().sort(function (a, b) { return b.inicio - a.inicio; });
    panel.appendChild(crear('div', { fontSize: '0.78rem', fontWeight: '800', color: T.color.muted, textTransform: 'uppercase', margin: '10px 0 4px 0' }, 'Solicitudes de regeneración (lámpara)'));
    if (!sol.length) panel.appendChild(crear('div', { fontSize: '0.82rem', color: T.color.body }, 'Ninguna en el rango.'));
    else panel.appendChild(crearTabla([
      { titulo: 'Lámpara encendida', valor: function (e) { return fmtFecha(e.inicio); } },
      { titulo: 'Apagada', valor: function (e) { return e.abierta ? 'sigue encendida' : fmtFecha(e.fin); } },
      { titulo: 'Duración', alinear: 'right', valor: function (e) { return fmtHoras(e.horas) + ' h'; } },
      { titulo: 'Cómo se resolvió', valor: function (e) { return e.abierta ? crearPildora('En curso', 1) : (e.manual ? crearPildora('Manual', 1) : crearPildora('Sola', 0)); } },
      { titulo: 'Interruptor', valor: function (e) { return e.interruptorDesde ? fmtFecha(e.interruptorDesde) : '—'; } },
      { titulo: 'Motor encendido hasta actuar', alinear: 'right', valor: function (e) { return fmtMinutos(e.minMotorHastaAccion); } }
    ], sol));

    var reg = r.regeneraciones.slice().sort(function (a, b) { return b.inicio - a.inicio; });
    panel.appendChild(crear('div', { fontSize: '0.78rem', fontWeight: '800', color: T.color.muted, textTransform: 'uppercase', margin: '14px 0 4px 0' }, 'Regeneraciones detectadas por hollín'));
    if (!reg.length) panel.appendChild(crear('div', { fontSize: '0.82rem', color: T.color.body }, r.tieneHollin ? 'Ninguna en el rango.' : 'Este vehículo no reporta hollín: solo se le detecta la lámpara.'));
    else panel.appendChild(crearTabla([
      { titulo: 'Inicio', valor: function (e) { return fmtFecha(e.inicio); } },
      { titulo: 'Hollín antes', alinear: 'right', valor: function (e) { return Math.round(e.valorInicio) + ' %'; } },
      { titulo: 'Hollín después', alinear: 'right', valor: function (e) { return Math.round(e.valorFin) + ' %'; } },
      { titulo: 'Caída', alinear: 'right', valor: function (e) { return Math.round(e.caida) + ' pp'; } },
      { titulo: 'Duración', alinear: 'right', valor: function (e) { return fmtMinutos(e.duracionMin); } }
    ], reg));
    zona.appendChild(panel);
    if (zona.scrollIntoView) zona.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // --- Render -------------------------------------------------------------------------
  function renderizarResultados() {
    if (!datosCache) return;
    var cont = vaciar(contenedorResultados);
    var filtrados = filtrar(datosCache.resultados);
    var s = resumir(filtrados);
    var cuerpo = crear('div', { padding: '16px 22px' });
    cont.appendChild(cuerpo);

    construirNarrativa(cuerpo, s);
    construirKpis(cuerpo, s);
    construirGraficos(cuerpo, filtrados, filtrar(datosCache.resultados, 'ciudad'));
    var zonaDetalle = crear('div');
    construirTabla(cuerpo, filtrados, zonaDetalle);
    cuerpo.appendChild(zonaDetalle);

    if (s.sinSenal.length) {
      cuerpo.appendChild(crear('div', { fontSize: '0.76rem', color: T.color.muted, marginBottom: '8px' },
        s.sinSenal.length + ' de ' + s.vehiculos + ' vehículos no reportan hollín ni lámpara DPF y por eso no aparecen con novedades: ' +
        s.sinSenal.slice(0, 15).join(', ') + (s.sinSenal.length > 15 ? '…' : '') + '.'));
    }
    cuerpo.appendChild(crear('div', { fontSize: '0.72rem', color: T.color.muted, paddingBottom: '12px' },
      'Método: una solicitud es un episodio de lámpara DPF encendida (se ignoran parpadeos < 5 min y ceros con el motor apagado o con el interruptor activo). ' +
      'Una regeneración detectada es una caída sostenida del hollín de 10 puntos o más en 40 min. Los tiempos de reacción cuentan solo con el motor encendido.'));
  }

  function cargarYRenderizar(desde, hasta) {
    if (cargaEnCurso) return;
    if (isNaN(desde.getTime()) || isNaN(hasta.getTime()) || desde >= hasta) { mostrarError(contenedorResultados, 'El rango de fechas no es válido: "Desde" debe ser anterior a "Hasta".'); return; }
    cargaEnCurso = true;
    elementos.botones.forEach(function (b) { b.disabled = true; b.style.opacity = '0.55'; });
    elementos.lineaProgreso = mostrarCargando(contenedorResultados, 'Consultando señales de Geotab…');
    calcular(desde.getTime(), hasta.getTime())
      .then(function (datos) {
        datosCache = datos;
        actualizarOpcionesFiltros(datos.resultados);
        renderizarResultados();
      })
      .catch(function (err) {
        console.error('Análisis de Regeneraciones:', err);
        mostrarError(contenedorResultados, describirError(err));
      })
      .then(function () {
        cargaEnCurso = false;
        elementos.botones.forEach(function (b) { b.disabled = false; b.style.opacity = '1'; });
      });
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi; state = freshState;
      var raiz = document.getElementById('analisisRegeneracionRoot');
      aplicarEstilo(raiz, { fontFamily: T.font, background: T.color.canvas, padding: '4px' });

      var enc = crearEncabezado('♻️', 'Análisis de Regeneraciones DPF',
        'Histórico por vehículo: solicitudes de lámpara, regeneración manual vs. automática, reacción del conductor y regeneraciones detectadas por hollín.');
      var r0 = rangoPorDefecto();
      var campoDesde = crearCampoFecha('Desde', r0.desde);
      var campoHasta = crearCampoFecha('Hasta', r0.hasta);
      var botonAnalizar = crearBoton('Analizar rango', true);
      var filaFiltros = crear('div', { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-end' });
      filaFiltros.appendChild(campoDesde.envoltorio);
      filaFiltros.appendChild(campoHasta.envoltorio);
      filaFiltros.appendChild(botonAnalizar);
      var botonesAtajo = [7, 14, 30].map(function (d) {
        var b = crearBoton('Últimos ' + d + ' días', false);
        b.addEventListener('click', function () {
          var r = rangoPorDefecto(d);
          campoDesde.input.value = r.desde; campoHasta.input.value = r.hasta;
          cargarYRenderizar(new Date(r.desde), new Date(r.hasta));
        });
        filaFiltros.appendChild(b);
        return b;
      });
      enc.appendChild(filaFiltros);
      raiz.appendChild(enc);
      elementos.botones = [botonAnalizar].concat(botonesAtajo);

      construirBarraFiltros(raiz);
      botonAnalizar.addEventListener('click', function () { cargarYRenderizar(new Date(campoDesde.input.value), new Date(campoHasta.input.value)); });

      contenedorResultados = crear('div');
      raiz.appendChild(contenedorResultados);
      elementos.inputDesde = campoDesde.input; elementos.inputHasta = campoHasta.input;
      initializedCallback();
    },

    focus: function (freshApi, freshState) {
      api = freshApi; state = freshState;
      if (!datosCache && !cargaEnCurso) cargarYRenderizar(new Date(elementos.inputDesde.value), new Date(elementos.inputHasta.value));
    },

    blur: function () {}
  };
