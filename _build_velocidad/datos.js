
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
