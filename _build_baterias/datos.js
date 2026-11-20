
  // ============================================================================
  // CAPA DE DATOS: API de Geotab, alcance de vehículos (grupo *Promoambiental),
  // ciudad/marca, y carga de ESR y voltaje de arranque.
  //
  // Volumen medido el 2026-11-09 (85 vehículos): ESR ~1.600 filas en 30 días;
  // voltaje de arranque ~4.900 filas/día (70.000 en 14 días). Tramos de 2 días
  // quedan en ~10.000 filas, muy bajo el tope de página de 50.000; si algún
  // tramo lo alcanzara igual, se parte a la mitad en vez de truncar en silencio.
  // ============================================================================

  var api = null;
  var state = null;

  var ID_DIAG_ESR = 'DiagnosticElectricalSystemRatingId';        // "Clasificación del sistema eléctrico"
  var ID_DIAG_ARRANQUE = 'DiagnosticCrankingVoltageId';          // "Voltaje de arranque"
  var ID_DIAG_VOLTAJE_GO = 'DiagnosticGoDeviceVoltageId';        // voltaje del GO: recuperación 5 min tras arrancar (v1.2)
  var DIAS_VOLTAJE_GO = 7;                                       // solo la ventana actual (~3.400 filas/día en la flota)
  var NOMBRE_GRUPO_RAIZ = '*Promoambiental';   // la base de Geotab se comparte con otras cuentas: se acota por este grupo
  var DIAS_ESR = 30;
  var DIAS_ARRANQUES = 14;                     // 7 días actuales + 7 previos para la tendencia
  var TRAMO_DIAS_ARRANQUES = 2;
  var LIMITE_PAGINA_STATUSDATA = 50000;
  var TIMEOUT_LLAMADA_MS = 90000;

  var NOMBRE_CIUDAD = {
    'PROMO AMBIENTAL DISTRITO BOGOTA': 'Bogotá (Distrito)', 'PACARIBE': 'Cartagena (Pacaribe)', 'PROMO CALI': 'Cali',
    'PROMO VALLE': 'Valle', 'SER AMBIENTAL': 'Ser Ambiental', 'ESTACIÓN DE TRANSFERENCIA ZIPA': 'Zipaquirá (Estación de transferencia)'
  };
  var MARCAS = ['international', 'kenworth', 'foton', 'chevrolet', 'mercedes', 'volks', 'freightliner', 'hino'];
  var GRUPOS_RAIZ_NO_CIUDAD = ['tipologia'];

  // --- Envoltorios sobre la API de Geotab (callback -> Promise, con tope de espera) ---
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
        var ciudad = null, marca = null;
        (dev.groups || []).forEach(function (g) {
          var gid = idDe(g);
          for (var d = 0; gid && d < 30; d++) {
            var nombre = ((porId[gid] && porId[gid].name) || '').trim(), minus = nombre.toLowerCase();
            if (!ciudad && raizHijos[gid] && GRUPOS_RAIZ_NO_CIUDAD.indexOf(minus) === -1) ciudad = nombre;
            if (!marca && MARCAS.some(function (m) { return minus.indexOf(m) === 0; })) marca = tituloCase(nombre);
            gid = padre[gid];
          }
        });
        vehiculos.push({ id: dev.id, nombre: dev.name || dev.id, ciudad: NOMBRE_CIUDAD[ciudad] || ciudad || 'Sin ciudad', marca: marca || 'Sin marca' });
      });
      vehiculos.sort(function (a, b) { return a.nombre < b.nombre ? -1 : a.nombre > b.nombre ? 1 : 0; });
      return vehiculos;
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
  function traerDiagnostico(idDiag, desdeMs, hastaMs, tramoDias, ids, alAvanzar) {
    var tramos = [], cursor = desdeMs;
    while (cursor < hastaMs) {
      var fin = Math.min(cursor + tramoDias * MS_DIA, hastaMs);
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

  // Carga todo lo necesario y devuelve la evaluación de cada vehículo del alcance.
  function cargarEvaluaciones(alProgreso) {
    var ahoraMs = Date.now();
    return obtenerAlcance().then(function (vehiculos) {
      var ids = vehiculos.reduce(function (m, v) { m[v.id] = true; return m; }, {});
      var avance = { esr: [0, 1], arr: [0, 1], go: [0, 1] };
      function reportar() { if (alProgreso) alProgreso(avance.esr[0] + avance.arr[0] + avance.go[0], avance.esr[1] + avance.arr[1] + avance.go[1]); }
      return Promise.all([
        traerDiagnostico(ID_DIAG_ESR, ahoraMs - DIAS_ESR * MS_DIA, ahoraMs, DIAS_ESR, ids, function (h, t) { avance.esr = [h, t]; reportar(); })
          .catch(function (err) { err.message = 'ESR de Geotab: ' + describirError(err); throw err; }),
        traerDiagnostico(ID_DIAG_ARRANQUE, ahoraMs - DIAS_ARRANQUES * MS_DIA, ahoraMs, TRAMO_DIAS_ARRANQUES, ids, function (h, t) { avance.arr = [h, t]; reportar(); })
          .catch(function (err) { err.message = 'Voltaje de arranque: ' + describirError(err); throw err; }),
        traerDiagnostico(ID_DIAG_VOLTAJE_GO, ahoraMs - DIAS_VOLTAJE_GO * MS_DIA - RECUPERA_VENTANA_MS, ahoraMs, TRAMO_DIAS_ARRANQUES, ids, function (h, t) { avance.go = [h, t]; reportar(); })
          .catch(function (err) { err.message = 'Voltaje del GO: ' + describirError(err); throw err; })
      ]).then(function (res) {
        var esrPorVeh = res[0], arrPorVeh = res[1], goPorVeh = res[2];
        var filas = vehiculos.map(function (v) {
          var arranques = agregarCargaGo(segmentarArranques(arrPorVeh[v.id] || []), goPorVeh[v.id] || []);
          var ev = evaluarVehiculo({ esrPuntos: esrPorVeh[v.id] || [], arranques: arranques, ahoraMs: ahoraMs });
          ev.vehiculo = v;
          ev.serieEsr = esrDiario(esrPorVeh[v.id] || []);
          ev.serieMinimo = minimoDiario(arranques);
          return ev;
        });
        return { filas: filas, ahoraMs: ahoraMs };
      });
    });
  }
