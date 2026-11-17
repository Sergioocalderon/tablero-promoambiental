/* ARCHIVO GENERADO por herramientas/construir_addin_velocidad.py -- NO EDITAR A MANO.
   Editar _build_velocidad/*.js (o _build_regeneracion_comun/ui.js) y volver a ejecutar el script. */

geotab.addin.seguimientoVelocidad = function () {
  'use strict';

  // ============================================================================
  // LÓGICA PURA: velocidad sostenida sobre el límite y su severidad.
  //
  // Criterio tomado de la regla de Geotab "V_VELOCIDAD MAYOR A 50 KM/H" (paquete de la
  // app de Hábitos, 2026-11-13): velocidad del motor en carretera (DiagnosticEngineRoadSpeedId)
  // por encima de 50 km/h durante al menos 30 s seguidos. Criticidad por el MÁXIMO alcanzado,
  // con corte [mínimo, máximo): BAJA 50 a <60, MEDIA 60 a <70, ALTA 70 o más.
  // ============================================================================

  var MS_HORA = 3600000;

  var LIMITE_KMH = 50;
  var SEGUNDOS_SOSTENIDO = 30;           // por debajo de esto es "sobre el límite", no alarma
  var VENTANA_MIN = 5;                   // minutos de señal que se leen en cada refresco
  var EDAD_MAX_LECTURA_S = 120;          // una lectura más vieja que esto no es "ahora"
  var KMH_DETENIDO = 2;
  // Mayor primero; nivel = semáforo de ui.js (3 urgente, 2 avisar, 1 observación)
  var SEVERIDADES = [
    { nombre: 'ALTA', minimo: 70, nivel: 3 },
    { nombre: 'MEDIA', minimo: 60, nivel: 2 },
    { nombre: 'BAJA', minimo: LIMITE_KMH, nivel: 1 }
  ];

  function severidadDe(pico) {
    for (var i = 0; i < SEVERIDADES.length; i++) if (pico >= SEVERIDADES[i].minimo) return SEVERIDADES[i];
    return null;
  }

  // lecturas: [[tMs, kmh], ...] ordenadas por tiempo. Devuelve { estado, velocidad, t, ... }
  //   ALARMA = sostenida >= SEGUNDOS_SOSTENIDO sobre el límite; SOBRE = sobre el límite, aún sin sostener;
  //   NORMAL = en movimiento bajo el límite; DETENIDO = casi 0 km/h; SIN_LECTURA = no hay lectura reciente.
  // La duración se mide entre lecturas (de la primera sobre el límite a la última), así que subestima como mucho
  // un intervalo de muestreo (unos segundos): no inventa tiempo.
  function evaluarVelocidad(lecturas, ahoraMs) {
    if (!lecturas || !lecturas.length) return { estado: 'SIN_LECTURA', velocidad: null, t: null };
    var n = lecturas.length, ult = lecturas[n - 1];
    if ((ahoraMs - ult[0]) / 1000 > EDAD_MAX_LECTURA_S) return { estado: 'SIN_LECTURA', velocidad: ult[1], t: ult[0] };
    var i = n - 1;
    while (i >= 0 && lecturas[i][1] > LIMITE_KMH) i--;
    if (i === n - 1) return { estado: ult[1] < KMH_DETENIDO ? 'DETENIDO' : 'NORMAL', velocidad: ult[1], t: ult[0] };
    var pico = 0;
    for (var j = i + 1; j < n; j++) if (lecturas[j][1] > pico) pico = lecturas[j][1];
    var duracionS = (ult[0] - lecturas[i + 1][0]) / 1000;
    return {
      estado: duracionS >= SEGUNDOS_SOSTENIDO ? 'ALARMA' : 'SOBRE',
      velocidad: ult[1], t: ult[0], desde: lecturas[i + 1][0], duracionS: duracionS, pico: pico, severidad: severidadDe(pico),
      desdeAntesDeVentana: i < 0       // la racha ya venía desde antes de la ventana leída: la duración real es mayor
    };
  }

  // ============================================================================
  // CAPA DE DATOS: API de Geotab, alcance de vehículos (grupo *Promoambiental) y
  // lectura de la velocidad del motor.
  //
  // Volumen: la velocidad del motor llega cada ~5-20 s por vehículo con el motor encendido.
  // Una sola consulta de los últimos 5 minutos de TODA la flota (85 vehículos) son unos
  // miles de filas, muy por debajo del tope de página de 50.000. Si lo alcanzara, el
  // tablero lo avisa en vez de mostrar datos incompletos como si fueran todos.
  // ============================================================================

  var api = null;
  var state = null;

  var ID_DIAG_VELOCIDAD = 'DiagnosticEngineRoadSpeedId';   // "Velocidad del motor en carretera" (km/h), la de la regla de 50 km/h
  var NOMBRE_GRUPO_RAIZ = '*Promoambiental';   // la base de Geotab se comparte con otras cuentas: se acota por este grupo
  var LIMITE_PAGINA_STATUSDATA = 50000;
  var TIMEOUT_LLAMADA_MS = 60000;

  var NOMBRE_CIUDAD = {
    'PROMO AMBIENTAL DISTRITO BOGOTA': 'Bogotá (Distrito)', 'PACARIBE': 'Cartagena (Pacaribe)', 'PROMO CALI': 'Cali',
    'PROMO VALLE': 'Valle', 'SER AMBIENTAL': 'Ser Ambiental', 'ESTACIÓN DE TRANSFERENCIA ZIPA': 'Zipaquirá (Estación de transferencia)'
  };
  var GRUPOS_RAIZ_NO_CIUDAD = ['tipologia'];

  // --- Envoltorios sobre la API de Geotab (callback -> Promise, con tope de espera) ---
  function conTimeout(promesaFn, descripcion) {
    return new Promise(function (resolve, reject) {
      var yaResuelto = false;
      var idTimeout = setTimeout(function () {
        if (yaResuelto) return;
        yaResuelto = true;
        reject(new Error('Se agotó el tiempo de espera consultando Geotab (' + descripcion + '). Puede ser la sesión o la red.'));
      }, TIMEOUT_LLAMADA_MS);
      promesaFn().then(function (r) {
        if (yaResuelto) return;
        yaResuelto = true; clearTimeout(idTimeout); resolve(r);
      }, function (e) {
        if (yaResuelto) return;
        yaResuelto = true; clearTimeout(idTimeout); reject(e);
      });
    });
  }

  function apiCall(metodo, params) {
    return conTimeout(function () {
      return new Promise(function (resolve, reject) { api.call(metodo, params, resolve, reject); });
    }, metodo);
  }

  function describirError(err) {
    if (!err) return 'Error al consultar Geotab (sin detalle).';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    if (err.error) return typeof err.error === 'string' ? err.error : describirError(err.error);
    if (err.name) return err.name;
    try { var t = JSON.stringify(err); if (t && t !== '{}') return t; } catch (e) { /* no serializable */ }
    return 'Error al consultar Geotab (sin detalle -- ver consola del navegador, F12).';
  }

  function idDe(ref) { return (ref && ref.id) ? ref.id : ref; }

  // --- Alcance: vehículos activos dentro del grupo raíz ---------------------------
  function obtenerAlcance() {
    return Promise.all([apiCall('Get', { typeName: 'Device' }), apiCall('Get', { typeName: 'Group' })]).then(function (r) {
      var devices = r[0] || [], grupos = r[1] || [];
      var porId = {}, padre = {};
      grupos.forEach(function (g) { if (g && g.id) porId[g.id] = g; });
      grupos.forEach(function (g) { (g.children || []).forEach(function (h) { padre[idDe(h)] = g.id; }); });

      var objetivo = NOMBRE_GRUPO_RAIZ.trim().toLowerCase(), raiz = null;
      grupos.forEach(function (g) { if (!raiz && g && typeof g.name === 'string' && g.name.trim().toLowerCase() === objetivo) raiz = g; });
      if (!raiz) throw new Error("No se encontró el grupo '" + NOMBRE_GRUPO_RAIZ + "' en Geotab.");
      var raizHijos = {};
      (raiz.children || []).forEach(function (h) { raizHijos[idDe(h)] = true; });

      function dentroDeRaiz(gid) {
        for (var d = 0; gid && d < 30; d++) { if (gid === raiz.id) return true; gid = padre[gid]; }
        return false;
      }

      var ahora = Date.now(), vehiculos = [];
      devices.forEach(function (dev) {
        if (!(dev.groups || []).some(function (g) { return dentroDeRaiz(idDe(g)); })) return;
        var hasta = dev.activeTo ? Date.parse(dev.activeTo) : NaN;
        if (!isNaN(hasta) && hasta < ahora) return;                       // dado de baja
        var ciudad = null;
        (dev.groups || []).forEach(function (g) {
          var gid = idDe(g);
          for (var d = 0; gid && d < 30; d++) {
            var nombre = ((porId[gid] && porId[gid].name) || '').trim();
            if (!ciudad && raizHijos[gid] && GRUPOS_RAIZ_NO_CIUDAD.indexOf(nombre.toLowerCase()) === -1) ciudad = nombre;
            gid = padre[gid];
          }
        });
        vehiculos.push({ id: dev.id, nombre: dev.name || dev.id, ciudad: NOMBRE_CIUDAD[ciudad] || ciudad || 'Sin ciudad' });
      });
      vehiculos.sort(function (a, b) { return a.nombre < b.nombre ? -1 : a.nombre > b.nombre ? 1 : 0; });
      return vehiculos;
    });
  }

  // --- Velocidad: últimos VENTANA_MIN minutos de toda la flota + estado de comunicación ---
  function cargarVelocidades() {
    var ahora = Date.now();
    return Promise.all([
      apiCall('Get', {
        typeName: 'StatusData',
        search: { diagnosticSearch: { id: ID_DIAG_VELOCIDAD }, fromDate: new Date(ahora - VENTANA_MIN * 60000).toISOString(), toDate: new Date(ahora).toISOString() },
        resultsLimit: LIMITE_PAGINA_STATUSDATA
      }),
      apiCall('Get', { typeName: 'DeviceStatusInfo' })
    ]).then(function (r) {
      var filas = r[0] || [], lecturas = {}, info = {};
      filas.forEach(function (f) {
        var id = idDe(f.device);
        (lecturas[id] = lecturas[id] || []).push([Date.parse(f.dateTime), Number(f.data)]);
      });
      Object.keys(lecturas).forEach(function (id) { lecturas[id].sort(function (a, b) { return a[0] - b[0]; }); });
      (r[1] || []).forEach(function (s) { info[idDe(s.device)] = { comunica: !!s.isDeviceCommunicating, t: Date.parse(s.dateTime), lat: s.latitude, lon: s.longitude }; });
      return { ahora: ahora, lecturas: lecturas, info: info, truncado: filas.length >= LIMITE_PAGINA_STATUSDATA };
    });
  }

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

  // ============================================================================
  // PANTALLA: Seguimiento de Velocidad (en vivo, con alarma en pantalla), tema oscuro
  //
  // Lo primero que se ve son las alarmas (quién va sobre el límite y qué tan grave). Cada una lleva un
  // medidor que dibuja los criterios de la regla (50/60/70 km/h), la velocidad actual y el pico, y un
  // botón para ver dónde está. Lo demás queda plegado. Los criterios y la lógica no cambian (logica.js).
  // ============================================================================

  var REFRESCO_MS = 15 * 1000;
  var elementos = {};
  var alcance = null;                   // vehículos de la flota (se carga una vez)
  var datos = null;                     // { ahora, lecturas, info, truncado }
  var filtros = { ciudad: '' };
  var abiertos = { mov: false, quietos: false };   // los <details> se vuelven a dibujar cada refresco: se recuerda cuáles estaban abiertos
  var nivelSonar = 2;                   // suena desde esta severidad (1 baja, 2 media, 3 alta)
  var sonidoActivo = false, audioCtx = null;
  var alarmados = {};                   // id -> nivel de la alarma en el refresco anterior
  var cargando = false, temporizador = null;
  var REDUCIR_MOVIMIENTO = false;
  try { REDUCIR_MOVIMIENTO = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* sin matchMedia */ }

  // Tema oscuro (el mismo de Seguimiento de Regeneraciones y Alertas por Severidad)
  var D = {
    bg: '#131722', panel: '#1E222D', panelSoft: '#262B36', plegable: '#2A3448', border: '#374151', borde2: '#2A2E39',
    text: '#F1F5F9', textSoft: '#CBD5E1', muted: '#94A3B8', faint: '#64748B',
    verde: '#00D084', rojo: '#FF4D4F', naranja: '#FB923C', amarillo: '#FACC15'
  };
  var ORDEN_ESTADO = { ALARMA: 0, SOBRE: 1, NORMAL: 2, DETENIDO: 3, SIN_SENAL: 4 };
  var COLOR_SEV = { 1: D.amarillo, 2: D.naranja, 3: D.rojo };          // borde, velocidad y zona del medidor
  var RELLENO_SEV = { 1: '#A16207', 2: '#C2570C', 3: '#B3262B' };      // píldora rellena (texto blanco, contraste suficiente)
  var NOMBRE_SEVERIDAD = { 1: 'Baja', 2: 'Media', 3: 'Alta' };

  var ICONOS = {
    reloj: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    campana: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    campanaOff: '<path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/>',
    pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    chevron: '<polyline points="9 18 15 12 9 6"/>'
  };
  function crearIcono(nombre, lado, color) {
    var el = crear('span', { display: 'inline-flex', width: lado, height: lado, flex: 'none' });
    if (color) el.style.color = color;
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONOS[nombre] + '</svg>';
    return el;
  }

  function fmtDuracion(s) {
    if (s < 60) return Math.round(s) + ' s';
    var m = Math.floor(s / 60);
    return m + ' min ' + Math.round(s - m * 60) + ' s';
  }
  function fmtKmh(x) { return (x === null || x === undefined || isNaN(x)) ? '—' : String(Math.round(x)); }
  function numeroTabular(el) { el.style.fontVariantNumeric = 'tabular-nums'; return el; }

  // --- Evaluación de la flota -------------------------------------------------------
  function construirFilas() {
    return alcance.map(function (v) {
      var ev = evaluarVelocidad(datos.lecturas[v.id], datos.ahora);
      if (ev.estado === 'SIN_LECTURA') {
        // Sin velocidad del motor reciente: si el equipo sí comunica, el vehículo está sin movimiento; si no, no hay señal.
        var inf = datos.info[v.id];
        ev.estado = inf && inf.comunica && (datos.ahora - inf.t) < 10 * 60000 ? 'DETENIDO' : 'SIN_SENAL';
      }
      return { v: v, ev: ev };
    }).sort(function (a, b) {
      var d = ORDEN_ESTADO[a.ev.estado] - ORDEN_ESTADO[b.ev.estado];
      if (d) return d;
      if (a.ev.estado === 'ALARMA') { var n = b.ev.severidad.nivel - a.ev.severidad.nivel; if (n) return n; }
      return (b.ev.velocidad || 0) - (a.ev.velocidad || 0);
    });
  }

  // --- Sonido (WebAudio, sin archivos; el navegador exige un clic previo) --------------
  function pitar() {
    if (!sonidoActivo || !audioCtx) return;
    try {
      [0, 0.28, 0.56].forEach(function (d) {
        var o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = 'square'; o.frequency.value = 880; g.gain.value = 0.15;
        o.connect(g); g.connect(audioCtx.destination);
        o.start(audioCtx.currentTime + d); o.stop(audioCtx.currentTime + d + 0.18);
      });
    } catch (e) { /* sin audio: la alarma sigue visible */ }
  }

  function pintarBotonSonido() {
    var b = vaciar(elementos.botonSonido);
    b.appendChild(crear('span', {}, sonidoActivo ? 'Sonido activado (clic para silenciar)' : 'Sonido apagado (clic para activar)'));
    b.appendChild(crearIcono(sonidoActivo ? 'campana' : 'campanaOff', '17px', sonidoActivo ? D.verde : D.amarillo));
    b.style.background = sonidoActivo ? 'rgba(0,208,132,0.14)' : 'transparent';
  }

  function alternarSonido() {
    if (sonidoActivo) { sonidoActivo = false; }
    else {
      try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        sonidoActivo = true;
        pitar();                          // prueba: si no se oye, el navegador o el equipo lo están bloqueando
      } catch (e) { sonidoActivo = false; }
    }
    pintarBotonSonido();
  }

  // Suena solo cuando un vehículo ENTRA en alarma (o sube de severidad), no en cada refresco.
  function revisarSonido(filas) {
    var ahora = {}, nuevo = false;
    filas.forEach(function (f) {
      if (f.ev.estado !== 'ALARMA') return;
      var nivel = f.ev.severidad.nivel;
      ahora[f.v.id] = nivel;
      if ((alarmados[f.v.id] || 0) < nivel && nivel >= nivelSonar) nuevo = true;
    });
    alarmados = ahora;
    if (nuevo) pitar();
  }

  // --- Medidor: la escala dibuja los criterios de la regla ------------------------------
  // Gris hasta 50 km/h; desde ahí baja (amarillo), media (naranja) y alta (rojo). Marcador blanco = velocidad ahora;
  // marcador tenue = pico de la racha.
  function crearMedidor(velocidad, pico) {
    var tope = Math.max(90, Math.ceil(((pico || velocidad) + 5) / 10) * 10);
    function pct(v) { return Math.max(0, Math.min(100, v / tope * 100)); }
    var caja = crear('div', { position: 'relative', height: '38px', width: '100%' });
    caja.setAttribute('role', 'img');
    caja.setAttribute('aria-label', fmtKmh(velocidad) + ' km/h' + (pico > velocidad + 0.5 ? ', pico de ' + fmtKmh(pico) + ' km/h' : '') +
      '. Zonas: baja desde ' + LIMITE_KMH + ', media desde 60 y alta desde 70 km/h.');
    var pista = crear('div', { position: 'absolute', left: '0', right: '0', top: '9px', height: '10px', borderRadius: '5px', overflow: 'hidden', background: D.border });
    [[LIMITE_KMH, 60, 1], [60, 70, 2], [70, tope, 3]].forEach(function (z) {
      pista.appendChild(crear('div', { position: 'absolute', top: '0', bottom: '0', left: pct(z[0]) + '%', width: (pct(z[1]) - pct(z[0])) + '%', background: COLOR_SEV[z[2]] }));
    });
    caja.appendChild(pista);
    [LIMITE_KMH, 60, 70].forEach(function (v) {
      caja.appendChild(numeroTabular(crear('div', { position: 'absolute', left: pct(v) + '%', top: '23px', transform: 'translateX(-50%)', fontSize: '0.7rem', color: D.muted }, String(v))));
    });
    if (pico && pico > velocidad + 0.5) {
      var m = crear('div', { position: 'absolute', left: pct(pico) + '%', top: '5px', width: '3px', height: '18px', marginLeft: '-1px', borderRadius: '2px', background: D.muted });
      m.title = 'Pico de ' + fmtKmh(pico) + ' km/h';
      caja.appendChild(m);
    }
    caja.appendChild(crear('div', { position: 'absolute', left: pct(velocidad) + '%', top: '3px', width: '5px', height: '22px', marginLeft: '-2px', borderRadius: '3px', background: '#F8FAFC', boxShadow: '0 0 0 2px ' + D.panel }));
    return caja;
  }

  function puntoPulso(color) {
    var p = crear('span', { display: 'inline-block', width: '9px', height: '9px', borderRadius: '50%', background: color, flex: '0 0 auto' });
    if (!REDUCIR_MOVIMIENTO && typeof p.animate === 'function') {
      p.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0.35, transform: 'scale(1.5)' }], { duration: 900, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
    }
    return p;
  }

  function pildora(texto, borde, relleno) {
    return crear('span', {
      display: 'inline-block', padding: '4px 12px', borderRadius: '999px', fontSize: '0.78rem', fontWeight: '600', whiteSpace: 'nowrap',
      border: '1px solid ' + borde, background: relleno || 'transparent', color: relleno ? '#FFFFFF' : borde
    }, texto);
  }

  // Botón "Mapa": abre la última posición del vehículo (la que informa Geotab) en una pestaña nueva.
  function botonMapa(f) {
    var inf = datos.info[f.v.id];
    var hayPosicion = inf && typeof inf.lat === 'number' && typeof inf.lon === 'number' && !(inf.lat === 0 && inf.lon === 0);
    var a = crear('a', {
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '10px', borderRadius: '8px', textDecoration: 'none',
      background: D.panelSoft, color: hayPosicion ? D.text : D.faint, fontSize: '0.88rem', fontWeight: '600', border: '1px solid ' + D.border
    });
    a.appendChild(crearIcono('pin', '15px', hayPosicion ? D.text : D.faint));
    a.appendChild(crear('span', {}, hayPosicion ? 'Mapa' : 'Sin posición'));
    if (hayPosicion) {
      a.href = 'https://www.google.com/maps/search/?api=1&query=' + inf.lat + ',' + inf.lon;
      a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.title = 'Última posición reportada hace ' + fmtDuracion((datos.ahora - inf.t) / 1000);
    }
    return a;
  }

  // --- Zona principal: las alarmas ---------------------------------------------------------
  function tarjetaAlarma(f) {
    var ev = f.ev, nivel = ev.severidad.nivel, color = COLOR_SEV[nivel];
    var tarjeta = crear('div', {
      display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px 18px', borderRadius: '14px', background: D.panel,
      border: '2px solid ' + color, boxShadow: '0 0 0 1px ' + color + '33, 0 0 22px ' + color + '40'
    });

    var arriba = crear('div', { display: 'flex', flexWrap: 'wrap', gap: '8px 18px', justifyContent: 'space-between', alignItems: 'flex-start' });
    var izq = crear('div', { flex: '1 1 150px', minWidth: '140px' });
    var sev = crear('div', { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: D.muted });
    sev.appendChild(puntoPulso(color));
    sev.appendChild(crear('span', {}, 'Severidad ' + NOMBRE_SEVERIDAD[nivel]));
    izq.appendChild(sev);
    izq.appendChild(crear('div', { fontSize: '1.4rem', fontWeight: '800', color: D.text, marginTop: '4px', letterSpacing: '-0.01em' }, f.v.nombre));
    izq.appendChild(crear('div', { fontSize: '0.88rem', color: D.muted, marginTop: '1px' }, f.v.ciudad));
    arriba.appendChild(izq);

    var der = crear('div', { flex: '1 1 210px', minWidth: '190px', maxWidth: '300px' });
    var velocidad = numeroTabular(crear('div', { textAlign: 'right', color: color, lineHeight: '1', marginBottom: '6px' }));
    velocidad.appendChild(crear('span', { fontSize: '2.3rem', fontWeight: '800', letterSpacing: '-0.02em' }, fmtKmh(ev.velocidad)));
    velocidad.appendChild(crear('span', { fontSize: '1.1rem', fontWeight: '700', marginLeft: '5px' }, 'km/h'));
    der.appendChild(velocidad);
    der.appendChild(crearMedidor(ev.velocidad, ev.pico));
    arriba.appendChild(der);
    tarjeta.appendChild(arriba);

    var pildoras = crear('div', { display: 'flex', flexWrap: 'wrap', gap: '8px' });
    pildoras.appendChild(pildora('Pico de ' + fmtKmh(ev.pico) + ' km/h', color));
    pildoras.appendChild(pildora((ev.desdeAntesDeVentana ? 'Lleva al menos ' : 'Lleva ') + fmtDuracion(ev.duracionS) + ' sobre el límite', RELLENO_SEV[nivel], RELLENO_SEV[nivel]));
    pildoras.appendChild(crear('span', { alignSelf: 'center', fontSize: '0.78rem', color: D.muted }, 'Lectura hace ' + fmtDuracion((datos.ahora - ev.t) / 1000)));
    tarjeta.appendChild(pildoras);

    tarjeta.appendChild(botonMapa(f));
    return tarjeta;
  }

  function tituloSeccion(texto, color, detalle) {
    var t = crear('h2', { margin: '0', fontSize: '1.7rem', fontWeight: '800', color: color, letterSpacing: '0.005em' }, texto);
    if (detalle) t.appendChild(crear('span', { fontSize: '1.2rem', fontWeight: '500', color: D.textSoft, marginLeft: '10px' }, detalle));
    return t;
  }

  function pintarAlarmas(filas) {
    var cont = vaciar(elementos.alarmas);
    var alarmas = filas.filter(function (f) { return f.ev.estado === 'ALARMA'; });
    if (alarmas.length) {
      cont.appendChild(tituloSeccion((alarmas.length === 1 ? 'VEHÍCULO' : 'VEHÍCULOS') + ' SOBRE ' + LIMITE_KMH + ' km/h', D.rojo));
      cont.appendChild(crear('div', { fontSize: '0.82rem', color: D.muted, margin: '4px 0 14px' },
        'La alarma se activa cuando pasan de ' + LIMITE_KMH + ' km/h durante ' + SEGUNDOS_SOSTENIDO + ' s o más. Primero los más graves.'));
      var rejilla = crear('div', { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 400px), 1fr))', gap: '16px' });
      alarmas.forEach(function (f) { rejilla.appendChild(tarjetaAlarma(f)); });
      cont.appendChild(rejilla);
    } else {
      var rapidos = filas.filter(function (f) { return f.ev.estado === 'SOBRE' || f.ev.estado === 'NORMAL'; }).sort(function (a, b) { return b.ev.velocidad - a.ev.velocidad; });
      cont.appendChild(tituloSeccion('NINGÚN VEHÍCULO EN ALARMA', D.verde));
      cont.appendChild(crear('div', { fontSize: '0.9rem', color: D.textSoft, marginTop: '6px' },
        rapidos.length ? 'El más rápido ahora es ' + rapidos[0].v.nombre + ', a ' + fmtKmh(rapidos[0].ev.velocidad) + ' km/h.' : 'Ningún vehículo con velocidad del motor reciente.'));
    }
  }

  // Acaban de pasar el límite pero aún no suman los 30 s de la regla: la barra muestra cuánto falta.
  function pintarVigilancia(filas) {
    var cont = vaciar(elementos.vigilancia);
    var sobre = filas.filter(function (f) { return f.ev.estado === 'SOBRE'; });
    if (!sobre.length) return;
    cont.appendChild(tituloSeccion('ACABAN DE PASAR EL LÍMITE', D.text, '(En alerta)'));
    cont.appendChild(crear('div', { fontSize: '0.82rem', color: D.muted, margin: '4px 0 8px' },
      'Todavía no cumplen los ' + SEGUNDOS_SOSTENIDO + ' s de la regla. Si siguen así, pasan a alarma.'));
    sobre.forEach(function (f, i) {
      var fila = crear('div', { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 22px', padding: '12px 4px', borderTop: i ? '1px solid ' + D.borde2 : '1px solid ' + D.borde2 });
      fila.appendChild(crear('div', { flex: '0 0 170px', color: D.text, fontSize: '0.98rem' }, f.v.nombre));
      fila.appendChild(numeroTabular(crear('div', { flex: '0 0 90px', fontWeight: '800', fontSize: '1.05rem', color: D.amarillo }, fmtKmh(f.ev.velocidad) + ' km/h')));
      var avance = crear('div', { flex: '1 1 240px', display: 'flex', alignItems: 'center', gap: '16px' });
      var pista = crear('div', { flex: '1', height: '10px', borderRadius: '5px', background: D.border, overflow: 'hidden' });
      pista.appendChild(crear('div', { height: '100%', borderRadius: '5px', width: Math.min(100, f.ev.duracionS / SEGUNDOS_SOSTENIDO * 100) + '%', background: D.amarillo }));
      avance.appendChild(pista);
      avance.appendChild(numeroTabular(crear('span', { fontSize: '0.85rem', color: D.textSoft, whiteSpace: 'nowrap', minWidth: '62px', textAlign: 'right' }, Math.round(f.ev.duracionS) + ' de ' + SEGUNDOS_SOSTENIDO + ' s')));
      fila.appendChild(avance);
      cont.appendChild(fila);
    });
  }

  // --- El resto de la flota, plegado ---------------------------------------------------------
  function tablaOscura(filas) {
    var tabla = crear('table', { width: '100%', borderCollapse: 'collapse', fontSize: '0.84rem', fontFamily: T.font });
    var cab = crear('tr');
    ['Vehículo', 'Ciudad', 'Velocidad', 'Última lectura'].forEach(function (t, i) {
      cab.appendChild(crear('th', { padding: '8px 14px', textAlign: i === 2 ? 'right' : 'left', fontSize: '0.75rem', fontWeight: '700', color: D.muted, background: 'rgba(0,0,0,0.18)' }, t));
    });
    var thead = crear('thead'); thead.appendChild(cab); tabla.appendChild(thead);
    var cuerpo = crear('tbody');
    filas.forEach(function (f) {
      var tr = crear('tr', { borderTop: '1px solid ' + D.borde2 });
      var celdas = [
        crear('b', { color: D.text }, f.v.nombre), f.v.ciudad,
        numeroTabular(crear('span', {}, f.ev.velocidad === null ? '—' : fmtKmh(f.ev.velocidad) + ' km/h')),
        f.ev.t === null ? 'sin lectura' : 'hace ' + fmtDuracion((datos.ahora - f.ev.t) / 1000)
      ];
      celdas.forEach(function (c, i) {
        var td = crear('td', { padding: '8px 14px', color: D.textSoft, textAlign: i === 2 ? 'right' : 'left' });
        if (c && c.nodeType) td.appendChild(c); else td.textContent = c;
        tr.appendChild(td);
      });
      cuerpo.appendChild(tr);
    });
    tabla.appendChild(cuerpo);
    var envoltorio = crear('div', { overflowX: 'auto' });
    envoltorio.appendChild(tabla);
    return envoltorio;
  }

  function plegable(clave, titulo, filas) {
    var d = document.createElement('details');
    aplicarEstilo(d, { background: D.plegable, borderRadius: '10px', overflow: 'hidden' });
    var resumen = crear('summary', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', cursor: 'pointer', fontWeight: '700', fontSize: '1rem', color: D.text, listStyle: 'none' });
    resumen.appendChild(crear('span', {}, titulo + ' (' + filas.length + ')'));
    var flecha = crearIcono('chevron', '18px', D.text);
    flecha.style.transition = REDUCIR_MOVIMIENTO ? 'none' : 'transform 0.15s';
    resumen.appendChild(flecha);
    d.appendChild(resumen);
    function girar() { flecha.style.transform = d.open ? 'rotate(90deg)' : 'none'; }
    d.open = abiertos[clave]; girar();
    d.addEventListener('toggle', function () { abiertos[clave] = d.open; girar(); });
    if (filas.length) d.appendChild(tablaOscura(filas));
    else d.appendChild(crear('div', { padding: '4px 18px 16px', fontSize: '0.85rem', color: D.muted }, 'Ninguno por ahora.'));
    return d;
  }

  function pintarResto(filas) {
    var cont = vaciar(elementos.resto);
    cont.appendChild(plegable('mov', 'En movimiento, bajo el límite', filas.filter(function (f) { return f.ev.estado === 'NORMAL'; })));
    cont.appendChild(plegable('quietos', 'Sin movimiento o sin señal', filas.filter(function (f) { return f.ev.estado === 'DETENIDO' || f.ev.estado === 'SIN_SENAL'; })));
  }

  function pintar() {
    if (!datos || !alcance) return;
    var todas = construirFilas();
    elementos.cargandoCiudades();
    revisarSonido(todas);                // el sonido vigila toda la flota, aunque la pantalla esté filtrada por ciudad
    var filas = todas.filter(function (f) { return !filtros.ciudad || f.v.ciudad === filtros.ciudad; });
    pintarAlarmas(filas);
    pintarVigilancia(filas);
    pintarResto(filas);
    elementos.aviso.textContent = datos.truncado ? '⚠ La lectura llegó al tope de ' + LIMITE_PAGINA_STATUSDATA + ' filas: puede faltar información de algún vehículo.' : '';
    var h = new Date(datos.ahora);
    elementos.actualizado.textContent = 'Actualizado a las ' + pad2(h.getHours()) + ':' + pad2(h.getMinutes()) + ':' + pad2(h.getSeconds()) + '. Se refresca solo cada ' + (REFRESCO_MS / 1000) + ' s.';
  }

  function mensajeOscuro(contenedor, titulo, texto, color) {
    vaciar(contenedor);
    contenedor.appendChild(crear('div', { fontSize: '1.1rem', fontWeight: '700', color: color || D.textSoft }, titulo));
    if (texto) contenedor.appendChild(crear('div', { fontSize: '0.85rem', color: D.muted, marginTop: '4px' }, texto));
  }

  function cargar(primera) {
    if (cargando) return;
    cargando = true;
    elementos.botonActualizar.disabled = true; elementos.botonActualizar.style.opacity = '0.6';
    if (primera) mensajeOscuro(elementos.alarmas, 'Leyendo la velocidad de la flota…');
    (alcance ? Promise.resolve(alcance) : obtenerAlcance().then(function (a) { alcance = a; return a; }))
      .then(function () { return cargarVelocidades(); })
      .then(function (d) { datos = d; pintar(); })
      .catch(function (err) {
        console.error('Seguimiento de Velocidad:', err);
        // Un refresco fallido no debe borrar lo que ya se está viendo.
        if (!datos) mensajeOscuro(elementos.alarmas, 'No se pudo cargar la información', describirError(err), D.rojo);
        else elementos.aviso.textContent = '⚠ No se pudo actualizar (' + describirError(err) + '). Se muestra la última lectura.';
      })
      .then(function () { cargando = false; elementos.botonActualizar.disabled = false; elementos.botonActualizar.style.opacity = '1'; });
  }

  // --- Armado de la pantalla -----------------------------------------------------------
  // Caja con la etiqueta pequeña arriba y el valor debajo, como en el diseño.
  function selectOscuro(etiqueta, opciones, ancho) {
    var caja = crear('label', { display: 'flex', flexDirection: 'column', gap: '1px', padding: '6px 12px', minWidth: ancho || '190px', border: '1px solid ' + D.border, borderRadius: '8px', background: D.panel, cursor: 'pointer' });
    caja.appendChild(crear('span', { fontSize: '0.72rem', color: D.muted }, etiqueta));
    var select = crear('select', { background: 'transparent', border: 'none', color: D.text, fontSize: '0.98rem', fontFamily: T.font, outline: 'none', cursor: 'pointer', colorScheme: 'dark', padding: '2px 0' });
    function cargarOpciones(lista, elegido) {
      vaciar(select);
      lista.forEach(function (o) { var op = document.createElement('option'); op.value = o.valor; op.textContent = o.etiqueta; select.appendChild(op); });
      if (elegido !== undefined) select.value = elegido;
    }
    cargarOpciones(opciones);
    caja.appendChild(select);
    return { envoltorio: caja, select: select, cargar: cargarOpciones };
  }

  function botonOscuro(relleno) {
    return crear('button', {
      display: 'inline-flex', alignItems: 'center', gap: '10px', padding: '12px 20px', borderRadius: '8px', cursor: 'pointer', fontFamily: T.font, fontSize: '0.95rem', fontWeight: '600',
      border: relleno ? 'none' : '1px solid ' + D.verde, background: relleno ? D.verde : 'transparent', color: relleno ? '#04281C' : D.verde
    });
  }

  // MyGeotab deja el resto de la página en blanco: el fondo oscuro tiene que llegar hasta el borde inferior de la ventana.
  function ajustarAlturaRaiz() {
    var raiz = document.getElementById('seguimientoVelocidadRoot');
    if (!raiz) return;
    var arriba = Math.max(0, raiz.getBoundingClientRect().top);
    raiz.style.minHeight = Math.max(300, window.innerHeight - arriba) + 'px';
  }

  function construirPantalla(raiz) {
    aplicarEstilo(raiz, { fontFamily: T.font, background: D.bg, color: D.text, colorScheme: 'dark', boxSizing: 'border-box', padding: '24px 28px 32px', display: 'flex', flexDirection: 'column', gap: '16px' });

    var titulo = crear('div');
    var fila = crear('div', { display: 'flex', alignItems: 'center', gap: '12px' });
    fila.appendChild(crear('h1', { margin: '0', fontSize: '1.9rem', fontWeight: '800', color: '#FFFFFF', letterSpacing: '0.005em', textTransform: 'uppercase' }, 'Seguimiento de Velocidad'));
    fila.appendChild(crearIcono('reloj', '26px', D.verde));
    titulo.appendChild(fila);
    titulo.appendChild(crear('p', { margin: '4px 0 0', fontSize: '1rem', color: D.muted }, 'Monitoreo en tiempo real de la flota'));
    raiz.appendChild(titulo);

    var barra = crear('div', { display: 'flex', flexWrap: 'wrap', gap: '14px', alignItems: 'stretch' });
    var selCiudad = selectOscuro('Ciudad o empresa', [{ valor: '', etiqueta: 'Todas' }]);
    selCiudad.select.addEventListener('change', function () { filtros.ciudad = selCiudad.select.value; pintar(); });
    var selSonar = selectOscuro('Sonar desde la severidad', [
      { valor: '1', etiqueta: 'Baja (50 km/h)' }, { valor: '2', etiqueta: 'Media (60 km/h)' }, { valor: '3', etiqueta: 'Alta (70 km/h)' }
    ], '210px');
    selSonar.select.value = String(nivelSonar);
    selSonar.select.addEventListener('change', function () { nivelSonar = Number(selSonar.select.value); });
    barra.appendChild(selCiudad.envoltorio); barra.appendChild(selSonar.envoltorio);

    elementos.botonSonido = botonOscuro(false);
    elementos.botonSonido.addEventListener('click', alternarSonido);
    pintarBotonSonido();
    elementos.botonActualizar = botonOscuro(true);
    elementos.botonActualizar.appendChild(crear('span', {}, 'Actualizar ahora'));
    elementos.botonActualizar.addEventListener('click', function () { cargar(false); });
    barra.appendChild(elementos.botonSonido); barra.appendChild(elementos.botonActualizar);
    raiz.appendChild(barra);

    // las ciudades salen de los vehículos del alcance
    elementos.cargandoCiudades = function () {
      var ciudades = {};
      alcance.forEach(function (v) { ciudades[v.ciudad] = true; });
      var lista = [{ valor: '', etiqueta: 'Todas' }].concat(Object.keys(ciudades).sort().map(function (c) { return { valor: c, etiqueta: c }; }));
      if (selCiudad.select.options.length !== lista.length) selCiudad.cargar(lista, filtros.ciudad);
    };

    elementos.actualizado = crear('div', { fontSize: '0.8rem', color: D.muted, marginTop: '-6px' });
    elementos.aviso = crear('div', { fontSize: '0.85rem', color: D.rojo, fontWeight: '600' });
    elementos.alarmas = crear('div', { marginTop: '6px' });
    elementos.vigilancia = crear('div', { marginTop: '10px' });
    elementos.resto = crear('div', { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '10px' });
    [elementos.actualizado, elementos.aviso, elementos.alarmas, elementos.vigilancia, elementos.resto].forEach(function (e) { raiz.appendChild(e); });

    var nota = document.createElement('details');
    aplicarEstilo(nota, { fontSize: '0.78rem', color: D.muted, lineHeight: '1.5', marginTop: '6px' });
    nota.appendChild(crear('summary', { cursor: 'pointer', color: D.faint, fontWeight: '600' }, 'Cómo se calcula'));
    nota.appendChild(crear('p', { margin: '6px 0 0', maxWidth: '760px' },
      'Usa la velocidad del motor en carretera, la misma señal de la regla V_VELOCIDAD MAYOR A 50 KM/H, con los últimos ' + VENTANA_MIN + ' minutos de cada vehículo. ' +
      'La severidad sale del pico de la racha: baja de 50 a menos de 60 km/h, media de 60 a menos de 70 y alta desde 70. ' +
      'El tiempo sobre el límite se mide entre lecturas. El botón Mapa abre la última posición que reportó el equipo. ' +
      'La alarma suena y se ve solo con esta pantalla abierta y visible; los excesos con la pantalla cerrada quedan en las reglas de Geotab.'));
    raiz.appendChild(nota);
    ajustarAlturaRaiz();
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi; state = freshState;
      construirPantalla(document.getElementById('seguimientoVelocidadRoot'));
      initializedCallback();
    },
    focus: function (freshApi, freshState) {
      api = freshApi; state = freshState;
      if (temporizador) clearInterval(temporizador);
      temporizador = setInterval(function () { cargar(false); }, REFRESCO_MS);
      window.addEventListener('resize', ajustarAlturaRaiz);
      ajustarAlturaRaiz();
      cargar(!datos);
    },
    blur: function () {
      if (temporizador) { clearInterval(temporizador); temporizador = null; }
      window.removeEventListener('resize', ajustarAlturaRaiz);
    }
  };

};
