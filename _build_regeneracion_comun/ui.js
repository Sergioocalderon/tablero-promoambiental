
  // ============================================================================
  // KIT DE DISEÑO compartido (CSSOM: Geotab elimina las etiquetas <style> de
  // los add-ins). Misma paleta que dashboardAnalisisFallas / AnalisisPTO.
  // ============================================================================

  var T = {
    color: {
      primary: '#73B828', primaryDark: '#59901D', primarySoft: '#EAF4DF',
      ink: '#1A2235', body: '#475569', muted: '#88929A',
      surface: '#FFFFFF', canvas: '#F4F5F8', border: '#E5E9F0', borderStrong: '#CBD5E1',
      danger: '#B91C1C', dangerSoft: '#FEF2F2', dangerBorder: '#FCA5A5'
    },
    radius: { sm: '8px', md: '12px', lg: '16px', pill: '999px' },
    shadow: { card: '0 1px 2px rgba(15,23,42,0.04), 0 1px 10px rgba(15,23,42,0.05)' },
    font: "'Inter', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
  };

  // Semáforo de atención (nivel de clasificarEstadoLampara): 3 urgente, 2 avisar, 1 observación, 0 informativo
  var COLOR_NIVEL = {
    3: { fondo: '#F7E8E8', texto: '#BA3B3B', borde: '#E7B4B4' },
    2: { fondo: '#FCEBDD', texto: '#B45309', borde: '#F2C79D' },
    1: { fondo: '#FFF6DB', texto: '#92660A', borde: '#EBD28A' },
    0: { fondo: '#EEF1F5', texto: '#64748B', borde: '#D5DBE3' }
  };
  var COLOR_SERIE = { manual: '#59901D', automatica: '#0891B2', regeneracion: '#73B828', solicitud: '#D97736' };

  function aplicarEstilo(el, estilos) {
    for (var p in estilos) if (Object.prototype.hasOwnProperty.call(estilos, p)) el.style[p] = estilos[p];
    return el;
  }

  function crear(tag, estilos, texto) {
    var el = document.createElement(tag);
    if (estilos) aplicarEstilo(el, estilos);
    if (texto !== undefined && texto !== null) el.textContent = texto;
    return el;
  }

  function vaciar(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  function crearPanel(extra) {
    var base = { background: T.color.surface, borderRadius: T.radius.md, border: '1px solid ' + T.color.border, boxShadow: T.shadow.card };
    for (var k in extra) base[k] = extra[k];
    return crear('div', base);
  }

  function crearChip(simbolo, fondo, texto, lado) {
    lado = lado || '34px';
    return crear('div', {
      width: lado, height: lado, minWidth: lado, borderRadius: T.radius.sm, background: fondo, color: texto,
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem', fontWeight: '700'
    }, simbolo);
  }

  function crearPildora(texto, nivel) {
    var c = COLOR_NIVEL[nivel] || COLOR_NIVEL[0];
    return crear('span', {
      display: 'inline-block', padding: '2px 10px', borderRadius: T.radius.pill, fontSize: '0.72rem', fontWeight: '700',
      background: c.fondo, color: c.texto, border: '1px solid ' + c.borde, whiteSpace: 'nowrap'
    }, texto);
  }

  function crearBoton(texto, primario) {
    return crear('button', {
      padding: '9px 18px', background: primario ? T.color.primary : T.color.surface,
      color: primario ? '#FFFFFF' : T.color.primaryDark, border: primario ? 'none' : '1px solid ' + T.color.primary,
      borderRadius: T.radius.sm, fontWeight: '700', fontSize: '0.85rem', cursor: 'pointer', fontFamily: T.font
    }, texto);
  }

  function crearCampoFecha(etiqueta, valor) {
    var envoltorio = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    envoltorio.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.muted, fontWeight: '600' }, etiqueta));
    var input = crear('input', { padding: '7px 10px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm, fontSize: '0.82rem', fontFamily: T.font, color: T.color.ink, background: '#FFFFFF' });
    input.type = 'datetime-local';
    input.value = valor;
    envoltorio.appendChild(input);
    return { envoltorio: envoltorio, input: input };
  }

  // opciones: [{valor, etiqueta}]
  function crearSelect(etiqueta, opciones, ancho) {
    var envoltorio = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: ancho || '170px' });
    envoltorio.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.muted, fontWeight: '600' }, etiqueta));
    var select = crear('select', { padding: '8px 10px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm, fontSize: '0.82rem', fontFamily: T.font, color: T.color.ink, background: '#FFFFFF' });
    function cargar(nuevas, elegido) {
      vaciar(select);
      nuevas.forEach(function (o) {
        var op = document.createElement('option');
        op.value = o.valor; op.textContent = o.etiqueta;
        select.appendChild(op);
      });
      if (elegido !== undefined) select.value = elegido;
    }
    cargar(opciones);
    envoltorio.appendChild(select);
    return { envoltorio: envoltorio, select: select, cargar: cargar };
  }

  function crearTarjetaKpi(valor, etiqueta, detalle, nivel) {
    var tarjeta = crearPanel({ padding: '14px 16px', flex: '1 1 150px', minWidth: '150px' });
    if (nivel !== undefined) tarjeta.style.borderLeft = '4px solid ' + COLOR_NIVEL[nivel].texto;
    tarjeta.appendChild(crear('div', { fontSize: '1.7rem', fontWeight: '800', color: T.color.ink, letterSpacing: '-0.02em', lineHeight: '1.1' }, valor));
    tarjeta.appendChild(crear('div', { fontSize: '0.78rem', fontWeight: '700', color: T.color.body, marginTop: '4px' }, etiqueta));
    if (detalle) tarjeta.appendChild(crear('div', { fontSize: '0.72rem', color: T.color.muted, marginTop: '2px' }, detalle));
    return tarjeta;
  }

  function mostrarCargando(contenedor, texto) {
    vaciar(contenedor);
    var caja = crear('div', { padding: '40px 22px', textAlign: 'center' });
    var linea = crear('div', { fontSize: '0.85rem', color: T.color.body, fontWeight: '600' }, texto || 'Cargando…');
    caja.appendChild(linea);
    contenedor.appendChild(caja);
    return linea;
  }

  function mostrarError(contenedor, mensaje) {
    vaciar(contenedor);
    var caja = crear('div', { padding: '24px', background: T.color.dangerSoft, border: '1px solid ' + T.color.dangerBorder, borderRadius: T.radius.md, margin: '16px 22px' });
    caja.appendChild(crear('div', { color: T.color.danger, fontWeight: '700', marginBottom: '4px' }, 'No se pudo cargar la información'));
    caja.appendChild(crear('div', { color: T.color.body, fontSize: '0.82rem' }, mensaje));
    contenedor.appendChild(caja);
  }

  function crearEncabezado(icono, titulo, subtitulo) {
    var enc = crear('div', { padding: '18px 22px', background: T.color.surface, borderBottom: '1px solid ' + T.color.border });
    var fila = crear('div', { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '14px', flexWrap: 'wrap' });
    fila.appendChild(crearChip(icono, T.color.primarySoft, T.color.primaryDark, '38px'));
    var texto = crear('div');
    texto.appendChild(crear('h2', { margin: '0', color: T.color.ink, fontSize: '1.25rem', fontWeight: '800', letterSpacing: '-0.01em' }, titulo));
    texto.appendChild(crear('p', { margin: '2px 0 0 0', color: T.color.body, fontSize: '0.82rem' }, subtitulo));
    fila.appendChild(texto);
    enc.appendChild(fila);
    return enc;
  }

  // Tabla simple. columnas: [{titulo, valor(fila)->texto|Node, alinear, orden(fila)->número|texto}]
  function crearTabla(columnas, filas, alClicFila) {
    var envoltorio = crear('div', { overflowX: 'auto' });
    var tabla = crear('table', { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', fontFamily: T.font });
    var cabecera = crear('tr');
    var orden = { col: -1, asc: true };
    var cuerpo = crear('tbody');

    function pintar() {
      vaciar(cuerpo);
      var lista = filas.slice();
      if (orden.col >= 0 && columnas[orden.col].orden) {
        var f = columnas[orden.col].orden;
        lista.sort(function (a, b) {
          var x = f(a), y = f(b);
          if (x === y) return 0;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          return (x < y ? -1 : 1) * (orden.asc ? 1 : -1);
        });
      }
      lista.forEach(function (fila) {
        var tr = crear('tr', { borderTop: '1px solid ' + T.color.border, cursor: alClicFila ? 'pointer' : 'default' });
        if (alClicFila) tr.addEventListener('click', function () { alClicFila(fila); });
        columnas.forEach(function (col) {
          var td = crear('td', { padding: '8px 10px', color: T.color.ink, textAlign: col.alinear || 'left', verticalAlign: 'top' });
          var v = col.valor(fila);
          if (v && v.nodeType) td.appendChild(v); else td.textContent = (v === null || v === undefined) ? '' : String(v);
          tr.appendChild(td);
        });
        cuerpo.appendChild(tr);
      });
    }

    columnas.forEach(function (col, i) {
      var th = crear('th', {
        padding: '8px 10px', textAlign: col.alinear || 'left', fontSize: '0.7rem', fontWeight: '800', color: T.color.muted,
        textTransform: 'uppercase', letterSpacing: '0.03em', background: T.color.canvas, whiteSpace: 'nowrap',
        cursor: col.orden ? 'pointer' : 'default'
      }, col.titulo);
      if (col.orden) th.addEventListener('click', function () {
        orden = { col: i, asc: orden.col === i ? !orden.asc : true };
        pintar();
      });
      cabecera.appendChild(th);
    });
    var cab = crear('thead'); cab.appendChild(cabecera);
    tabla.appendChild(cab); tabla.appendChild(cuerpo);
    envoltorio.appendChild(tabla);
    pintar();
    return envoltorio;
  }

  // --- Fechas y formato ---------------------------------------------------------
  var MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  // Partes de una fecha en hora de Bogotá (UTC-5, sin horario de verano).
  function partesBogota(ms) {
    var d = new Date(ms - 5 * MS_HORA);
    return { a: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtFecha(ms) {            // 26-oct 14:05
    if (ms === null || ms === undefined) return '';
    var p = partesBogota(ms);
    return pad2(p.d) + '-' + MESES[p.m] + ' ' + pad2(p.h) + ':' + pad2(p.mi);
  }
  function fmtDia(ms) { var p = partesBogota(ms); return pad2(p.d) + '-' + MESES[p.m]; }
  function claveDia(ms) { var p = partesBogota(ms); return p.a + '-' + pad2(p.m + 1) + '-' + pad2(p.d); }
  function fmtHoras(h) { return (Math.round(h * 10) / 10).toFixed(1).replace('.', ','); }
  function fmtMinutos(min) {
    if (min === null || min === undefined) return '—';
    if (min < 60) return Math.round(min) + ' min';
    return fmtHoras(min / 60) + ' h';
  }

  // datetime-local trabaja en hora local del navegador (Bogotá para estos usuarios)
  function aFechaInputValue(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function escaparHtml(t) {
    return String(t === null || t === undefined ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function slug(texto) {
    return (texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'TODAS';
  }

  function descargarArchivo(nombre, contenido, tipo) {
    var blob = new Blob([contenido], { type: tipo });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = nombre;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function copiarTexto(texto) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(texto).then(function () { return true; }, function () { return copiarTextoRespaldo(texto); });
    }
    return Promise.resolve(copiarTextoRespaldo(texto));
  }
  function copiarTextoRespaldo(texto) {
    var ta = crear('textarea', { position: 'fixed', left: '-9999px' });
    ta.value = texto;
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
