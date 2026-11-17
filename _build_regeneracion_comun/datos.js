
  // ============================================================================
  // CAPA DE DATOS compartida: API de Geotab, alcance de vehículos con DPF,
  // ciudad/marca y carga de señales (hollín, lámpara, interruptor, ignición).
  // ============================================================================

  var api = null;
  var state = null;

  // Volumen medido el 2026-10-27 (83 vehículos en alcance, 30 días, TODA la
  // flota): hollín ~4.000 filas/día, ignición ~860, lámpara ~250, interruptor
  // ~260. Tramos de 5 días dejan el hollín en ~20.000 filas (3 MB), muy bajo el
  // tope de página de 50.000; si algún tramo lo alcanzara igual, se parte a la
  // mitad (traerTramo) en vez de truncar en silencio.
  var TRAMO_DIAS = 5;
  var LIMITE_PAGINA_STATUSDATA = 50000;
  var TIMEOUT_LLAMADA_MS = 90000;

  var NOMBRE_CIUDAD = {
    'PROMO AMBIENTAL DISTRITO BOGOTA': 'Bogotá (Distrito)', 'PACARIBE': 'Cartagena (Pacaribe)', 'PROMO CALI': 'Cali',
    'PROMO VALLE': 'Valle', 'SER AMBIENTAL': 'Ser Ambiental', 'ESTACIÓN DE TRANSFERENCIA ZIPA': 'Zipaquirá (Estación de transferencia)'
  };
  var MARCAS = ['international', 'kenworth', 'foton', 'chevrolet', 'mercedes', 'volks', 'freightliner', 'hino'];
  var GRUPOS_RAIZ_NO_CIUDAD = ['tipologia'];

  // --- Envoltorios sobre la API de Geotab (callback -> Promise, con tope de espera) ---
  // Una llamada que Geotab nunca contesta (sesión vencida, red) dejaría la
  // pantalla en "Cargando…" para siempre sin ir al catch; el timeout la rechaza.
  function conTimeout(promesaFn, descripcion) {
    return new Promise(function (resolve, reject) {
      var yaResuelto = false;
      var idTimeout = setTimeout(function () {
        if (yaResuelto) return;
        yaResuelto = true;
        reject(new Error('Se agotó el tiempo de espera consultando Geotab (' + descripcion + '). Puede ser la sesión o la red: vuelve a intentarlo.'));
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

  function tituloCase(texto) {
    return (texto || '').toLowerCase().replace(/(^|[^a-záéíóúñü])([a-záéíóúñü])/g, function (_, pre, letra) { return pre + letra.toUpperCase(); });
  }

  // --- Alcance: vehículos dentro de los grupos de la regla de saturación DPF ---
  var alcanceCache = null;

  function obtenerAlcance() {
    if (alcanceCache) return Promise.resolve(alcanceCache);
    return Promise.all([
      apiCall('Get', { typeName: 'Rule' }),
      apiCall('Get', { typeName: 'Device' }),
      apiCall('Get', { typeName: 'Group' })
    ]).then(function (r) {
      var reglas = r[0] || [], devices = r[1] || [], grupos = r[2] || [];
      var regla = null, objetivo = NOMBRE_REGLA_ALCANCE.trim().toUpperCase();
      for (var i = 0; i < reglas.length && !regla; i++) if (reglas[i].id === ID_REGLA_ALCANCE) regla = reglas[i];
      for (var j = 0; j < reglas.length && !regla; j++) if ((reglas[j].name || '').trim().toUpperCase() === objetivo) regla = reglas[j];
      if (!regla) throw new Error("No se encontró la regla de alcance '" + NOMBRE_REGLA_ALCANCE + "' (id " + ID_REGLA_ALCANCE + ") en Geotab.");

      var porId = {}, padre = {};
      grupos.forEach(function (g) { if (g && g.id) porId[g.id] = g; });
      grupos.forEach(function (g) { (g.children || []).forEach(function (h) { padre[idDe(h)] = g.id; }); });
      var raiz = null;
      grupos.forEach(function (g) { if (!raiz && g && typeof g.name === 'string' && g.name.trim().indexOf('*') === 0) raiz = g; });
      var raizHijos = {};
      ((raiz && raiz.children) || []).forEach(function (h) { raizHijos[idDe(h)] = true; });

      var idsRegla = {};
      (regla.groups || []).forEach(function (g) { idsRegla[idDe(g)] = true; });
      var sinGrupos = !(regla.groups && regla.groups.length);   // sin grupos = alcance total (comportamiento de Geotab)

      function enAlcance(gid) {
        for (var d = 0; gid && d < 30; d++) {
          if (idsRegla[gid]) return true;
          gid = padre[gid];
        }
        return false;
      }

      var vehiculos = [];
      devices.forEach(function (dev) {
        if (!sinGrupos && !(dev.groups || []).some(function (g) { return enAlcance(idDe(g)); })) return;
        var ciudad = null, marca = null;
        (dev.groups || []).forEach(function (g) {
          var gid = idDe(g);
          for (var d = 0; gid && d < 30; d++) {
            var nombre = ((porId[gid] && porId[gid].name) || '').trim();
            var minus = nombre.toLowerCase();
            if (!ciudad && raizHijos[gid] && GRUPOS_RAIZ_NO_CIUDAD.indexOf(minus) === -1) ciudad = nombre;
            if (!marca && MARCAS.some(function (m) { return minus.indexOf(m) === 0; })) marca = tituloCase(nombre);
            gid = padre[gid];
          }
        });
        vehiculos.push({
          id: dev.id, nombre: dev.name || dev.id,
          ciudad: NOMBRE_CIUDAD[ciudad] || ciudad || 'Sin ciudad', marca: marca || 'Sin marca'
        });
      });
      vehiculos.sort(function (a, b) { return a.nombre < b.nombre ? -1 : a.nombre > b.nombre ? 1 : 0; });
      alcanceCache = { vehiculos: vehiculos, porId: vehiculos.reduce(function (m, v) { m[v.id] = v; return m; }, {}) };
      return alcanceCache;
    });
  }

  // --- Señales ------------------------------------------------------------------
  function consultaStatus(idDiag, desdeMs, hastaMs) {
    return apiCall('Get', {
      typeName: 'StatusData',
      search: { diagnosticSearch: { id: idDiag }, fromDate: new Date(desdeMs).toISOString(), toDate: new Date(hastaMs).toISOString() }
    });
  }

  // Trae un tramo de TODA la flota; si llega al tope de página lo parte en dos.
  function traerTramo(idDiag, desdeMs, hastaMs) {
    return consultaStatus(idDiag, desdeMs, hastaMs).then(function (filas) {
      filas = filas || [];
      if (filas.length < LIMITE_PAGINA_STATUSDATA) return filas;
      if (hastaMs - desdeMs <= MS_HORA) {
        throw new Error('Un tramo de menos de 1 hora superó el tope de ' + LIMITE_PAGINA_STATUSDATA + ' filas; no se puede traer completo.');
      }
      var mitad = desdeMs + Math.floor((hastaMs - desdeMs) / 2);
      return traerTramo(idDiag, desdeMs, mitad).then(function (a) {
        return traerTramo(idDiag, mitad, hastaMs).then(function (b) { return a.concat(b); });
      });
    });
  }

  // Un diagnóstico en tramos secuenciales -> {idVehiculo: [[ms, valor], ...]} (solo ids de `ids`)
  function traerDiagnostico(idDiag, desdeMs, hastaMs, ids, alAvanzar) {
    var tramos = [], cursor = desdeMs;
    while (cursor < hastaMs) {
      var fin = Math.min(cursor + TRAMO_DIAS * MS_DIA, hastaMs);
      tramos.push([cursor, fin]);
      cursor = fin;
    }
    var porVeh = {};
    return tramos.reduce(function (p, tramo, i) {
      return p.then(function () {
        return traerTramo(idDiag, tramo[0], tramo[1]).then(function (filas) {
          filas.forEach(function (x) {
            var v = idDe(x.device);
            if (!ids[v] || x.data === null || x.data === undefined) return;
            var t = Date.parse(x.dateTime), val = Number(x.data);
            if (isNaN(t) || isNaN(val)) return;
            (porVeh[v] = porVeh[v] || []).push([t, val]);
          });
          if (alAvanzar) alAvanzar(i + 1, tramos.length);
        });
      });
    }, Promise.resolve()).then(function () {
      Object.keys(porVeh).forEach(function (v) { porVeh[v].sort(function (a, b) { return a[0] - b[0]; }); });
      return porVeh;
    });
  }

  // rangos = { hollin: [desdeMs, hastaMs], lampara: [...], interruptor: [...], ignicion: [...], regen: [...] }
  // `regen` (regeneración activa) es opcional: solo se pide si viene en `rangos`.
  // Devuelve { idVehiculo: {hollin, lampara, interruptor, ignicion[, regen]} } para TODOS los del alcance.
  // Las señales se piden en paralelo (cada una en tramos secuenciales).
  function cargarSenales(vehiculos, rangos, alProgreso) {
    var ids = vehiculos.reduce(function (m, v) { m[v.id] = true; return m; }, {});
    var etiquetas = { hollin: 'hollín', lampara: 'lámpara', interruptor: 'interruptor manual', ignicion: 'ignición', regen: 'regeneración activa' };
    var avance = {};
    function reportar() {
      if (!alProgreso) return;
      var hechos = 0, total = 0;
      Object.keys(avance).forEach(function (k) { hechos += avance[k][0]; total += avance[k][1]; });
      alProgreso(hechos, total);
    }
    var claves = Object.keys(etiquetas).filter(function (k) { return rangos[k]; });
    return Promise.all(claves.map(function (k) {
      return traerDiagnostico(
        { hollin: ID_DIAG_HOLLIN, lampara: ID_DIAG_LAMPARA, interruptor: ID_DIAG_INTERRUPTOR, ignicion: ID_DIAG_IGNICION, regen: ID_DIAG_REGEN_ACTIVA }[k],
        rangos[k][0], rangos[k][1], ids,
        function (hecho, total) { avance[k] = [hecho, total]; reportar(); }
      ).catch(function (err) {
        err.message = 'Señal de ' + etiquetas[k] + ': ' + describirError(err);
        throw err;
      });
    })).then(function (res) {
      var salida = {};
      vehiculos.forEach(function (v) {
        salida[v.id] = {};
        claves.forEach(function (k, i) { salida[v.id][k] = res[i][v.id] || []; });
      });
      return salida;
    });
  }
