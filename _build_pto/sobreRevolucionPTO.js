/* ============================================================================
   Add-In: Sobre-Revolución con PTO
   Puerto a JavaScript de la logica ya validada en Python:
     - app.py            -> tab_revolucion (extraer_datos_manejo_pto, cruzar_con_pto)
     - telegram_alertas.py -> _revisar_regla_revolucion / _filtrar_por_pto_cercano

   Regla en Geotab: RPM > 1300 sostenido 30s con velocidad < 1 km/h (vehiculo
   detenido, compactando). El nombre de la regla en Geotab sigue diciendo
   "CON PTO" pero la condicion de la regla YA NO exige PTO (es un pulso,
   ~1.1s de mediana entre cambios) -- por eso el PTO se confirma aparte,
   cruzando contra pulsos de StatusData en una ventana de +/-3 min.

   Estilo: Geotab elimina los <style> tags del HTML, asi que todo el CSS se
   aplica programaticamente via element.style.* (CSSOM). Ningun elemento usa
   <style> ni hojas de estilo externas propias.
   ============================================================================ */

geotab.addin.sobreRevolucionPTO = function () {
  'use strict';

  // --- Constantes, iguales a las de telegram_alertas.py / app.py ------------
  var NOMBRE_REGLA_PTO = 'SOBRE REVOLUCIÓN CON PTO (L9-X12-OM 926-ISF 3.8)';
  var DURACION_MINIMA_SEG = 30;
  var ID_DIAGNOSTICO_PTO = 'DiagnosticPowerTakeoffEngagedId';
  var ID_DIAGNOSTICO_RPM = 'aW3Nmy-ktfEuvrdkya4z0yg'; // Engine Speed (RPM)
  var VENTANA_PTO_MIN = 3;      // +/- minutos para confirmar pulso de PTO cercano
  var VENTANA_RPM_SEG = 30;     // +/- segundos para capturar el pico real de RPM
  var VENTANA_LIVE_HORAS = 5;   // tamaño del rango "en vivo" (rodante, termina en "ahora")
  var CLAVE_LOCALSTORAGE = 'sobreRevolucionPTO_rango';
  var CLAVE_LOCALSTORAGE_TRIPULACIONES = 'tripulaciones_datos';
  var CLAVE_LOCALSTORAGE_TRIPULACIONES_META = 'tripulaciones_meta';
  var CLAVE_LOCALSTORAGE_RIESGO = 'sobreRevolucionPTO_riesgoExpandido';

  // Misma tabla que REFERENCIA_MOTOR_POR_MARCA en app.py / telegram_alertas.py
  var REFERENCIA_MOTOR_POR_MARCA = {
    'volkswagen': 'ISF 3.8', 'volskwagen': 'ISF 3.8', 'mercedes': 'OM926',
    'international': 'L9', 'foton': 'X12', 'kenworth': 'ISM 11'
  };
  var NOMBRE_GRUPO_TIPOLOGIA = 'tipologia'; // rama de la jerarquia de grupos donde cada hijo es un tipo de vehiculo

  // --- Sistema de diseño: paleta con roles, no colores sueltos ---------------
  // Verde de marca tomado de app.py (COSTO_MINUTO_RALENTI / estilo del tablero).
  var T = {
    color: {
      primary: '#62A830',
      primaryDark: '#4C8323',
      primarySoft: '#EAF4E1',
      ink: '#0F172A',      // titulos
      body: '#475569',     // texto secundario
      muted: '#94A3B8',    // texto terciario / placeholders
      surface: '#FFFFFF',  // tarjetas
      canvas: '#F1F5F9',   // fondo general
      border: '#E5E9F0',
      borderStrong: '#CBD5E1',
      danger: '#B91C1C',
      dangerSoft: '#FEF2F2',
      dangerBorder: '#FCA5A5',
      rowHover: '#F8FAFC'
    },
    radius: { sm: '8px', md: '12px', lg: '16px', pill: '999px' },
    shadow: {
      card: '0 1px 2px rgba(15,23,42,0.04), 0 1px 10px rgba(15,23,42,0.05)',
      hover: '0 6px 20px rgba(15,23,42,0.10)'
    },
    font: "'Inter', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
  };

  // Alias retro-compatibles con el resto del archivo (evita reescribir cada referencia)
  var COLOR_VERDE = T.color.primary;
  var COLOR_TEXTO = T.color.ink;
  var COLOR_GRIS = T.color.body;
  var COLOR_FONDO_TARJETA = T.color.surface;
  var COLOR_BORDE = T.color.border;

  var api = null;
  var state = null;
  var elementos = {};
  var chartTopVehiculos = null;

  // --- Utilidades de estilo (CSSOM, ya que <style> se elimina) --------------
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

  // --- Elementos de diseño reutilizables --------------------------------
  // Chip cuadrado con esquinas redondeadas para acompañar títulos de sección
  // y KPIs -- es el elemento que se repite en toda la interfaz para dar
  // identidad visual consistente, en vez de emojis sueltos de distinto tamaño.
  function crearChip(simbolo, colorFondo, colorTexto, tamano) {
    var lado = tamano || '34px';
    return crear('div', {
      width: lado, height: lado, minWidth: lado,
      borderRadius: T.radius.sm,
      background: colorFondo,
      color: colorTexto,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '1rem', fontWeight: '700'
    }, simbolo);
  }

  function crearPanel(estilosExtra) {
    var base = {
      background: T.color.surface,
      borderRadius: T.radius.md,
      border: '1px solid ' + T.color.border,
      boxShadow: T.shadow.card
    };
    for (var k in estilosExtra) { base[k] = estilosExtra[k]; }
    return crear('div', base);
  }

  function crearEtiquetaSeccion(simbolo, texto) {
    var fila = crear('div', { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' });
    fila.appendChild(crearChip(simbolo, T.color.primarySoft, T.color.primaryDark, '28px'));
    fila.appendChild(crear('h3', {
      margin: '0', color: T.color.ink, fontSize: '0.95rem', fontWeight: '700', letterSpacing: '0.01em'
    }, texto));
    return fila;
  }

  // --- Utilidades de fecha ----------------------------------------------
  function aFechaInputValue(d) {
    // yyyy-MM-ddTHH:mm para <input type="datetime-local">
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function cargarRangoGuardado() {
    try {
      var guardado = JSON.parse(localStorage.getItem(CLAVE_LOCALSTORAGE) || 'null');
      if (guardado && guardado.desde && guardado.hasta) return guardado;
    } catch (e) { /* ignorar, se usa el rango por defecto */ }
    return rangoLiveActual();
  }

  // Rango "en vivo": siempre las ultimas VENTANA_LIVE_HORAS terminando ahora
  // mismo -- se recalcula cada vez que se llama, nunca queda congelado.
  function rangoLiveActual() {
    var ahora = new Date();
    var desde = new Date(ahora.getTime() - VENTANA_LIVE_HORAS * 60 * 60 * 1000);
    return { desde: aFechaInputValue(desde), hasta: aFechaInputValue(ahora) };
  }

  function guardarRango(desde, hasta) {
    try {
      localStorage.setItem(CLAVE_LOCALSTORAGE, JSON.stringify({ desde: desde, hasta: hasta }));
    } catch (e) { /* localStorage no disponible, se sigue sin persistir */ }
  }

  function cargarPreferenciaRiesgo() {
    try { return localStorage.getItem(CLAVE_LOCALSTORAGE_RIESGO) === '1'; }
    catch (e) { return false; }
  }

  function guardarPreferenciaRiesgo(expandido) {
    try { localStorage.setItem(CLAVE_LOCALSTORAGE_RIESGO, expandido ? '1' : '0'); }
    catch (e) { /* localStorage no disponible, se sigue sin persistir */ }
  }

  // --- Envoltorios sobre la API de Geotab (callback -> Promise) -------------
  function apiCall(metodo, params) {
    return new Promise(function (resolve, reject) {
      api.call(metodo, params, resolve, reject);
    });
  }

  function apiMultiCall(llamadas) {
    return new Promise(function (resolve, reject) {
      api.multiCall(llamadas, resolve, reject);
    });
  }

  // --- Obtiene la regla por nombre exacto (misma logica que _obtener_eventos_regla) ---
  function obtenerIdRegla() {
    return apiCall('Get', { typeName: 'Rule' }).then(function (reglas) {
      var objetivo = NOMBRE_REGLA_PTO.trim().toUpperCase();
      var encontrada = null;
      for (var i = 0; i < reglas.length; i++) {
        var nombre = (reglas[i].name || '').trim().toUpperCase();
        if (nombre === objetivo) { encontrada = reglas[i]; break; }
      }
      if (!encontrada) {
        throw new Error("No se encontro la regla '" + NOMBRE_REGLA_PTO + "' en Geotab.");
      }
      return encontrada.id;
    });
  }

  // --- Trae ExceptionEvent de la regla en el rango, filtra por duracion minima ---
  function obtenerEventosCandidatos(idRegla, desdeUtc, hastaUtc) {
    return apiCall('Get', {
      typeName: 'ExceptionEvent',
      search: {
        ruleSearch: { id: idRegla },
        fromDate: desdeUtc.toISOString(),
        toDate: hastaUtc.toISOString()
      }
    }).then(function (eventos) {
      var candidatos = [];
      (eventos || []).forEach(function (ev) {
        if (!ev.activeFrom || !ev.activeTo) return;
        var desde = new Date(ev.activeFrom);
        var hasta = new Date(ev.activeTo);
        var duracionSeg = (hasta - desde) / 1000;
        if (duracionSeg < DURACION_MINIMA_SEG) return;
        var dev = ev.device;
        var idVeh = (dev && dev.id) ? dev.id : dev;
        candidatos.push({
          idVehiculo: idVeh,
          activeFrom: desde,
          activeTo: hasta,
          duracionSeg: duracionSeg,
          clave: idVeh + '|' + ev.activeFrom
        });
      });
      return candidatos;
    });
  }

  // --- Confirma PTO cercano (+/- VENTANA_PTO_MIN) para cada candidato --------
  // Misma logica que cruzar_con_pto / _filtrar_por_pto_cercano en Python: el PTO
  // es un pulso, no se puede exigir sostenido, solo que haya aparecido cerca.
  function confirmarPtoCercano(candidatos) {
    if (candidatos.length === 0) return Promise.resolve([]);

    var vehiculosUnicos = [];
    candidatos.forEach(function (c) {
      if (vehiculosUnicos.indexOf(c.idVehiculo) === -1) vehiculosUnicos.push(c.idVehiculo);
    });

    var desdeGlobal = new Date(Math.min.apply(null, candidatos.map(function (c) { return c.activeFrom.getTime(); })) - VENTANA_PTO_MIN * 60000);
    var hastaGlobal = new Date(Math.max.apply(null, candidatos.map(function (c) { return c.activeTo.getTime(); })) + VENTANA_PTO_MIN * 60000);

    var llamadas = vehiculosUnicos.map(function (idVeh) {
      return ['Get', {
        typeName: 'StatusData',
        search: {
          diagnosticSearch: { id: ID_DIAGNOSTICO_PTO },
          deviceSearch: { id: idVeh },
          fromDate: desdeGlobal.toISOString(),
          toDate: hastaGlobal.toISOString()
        }
      }];
    });

    return apiMultiCall(llamadas).then(function (resultados) {
      var pulsosPorVehiculo = {};
      vehiculosUnicos.forEach(function (idVeh, i) {
        var lecturas = resultados[i] || [];
        pulsosPorVehiculo[idVeh] = lecturas
          .filter(function (l) { return parseFloat(l.data) > 0; })
          .map(function (l) { return new Date(l.dateTime); });
      });

      var confirmados = [];
      candidatos.forEach(function (c) {
        var desde = new Date(c.activeFrom.getTime() - VENTANA_PTO_MIN * 60000);
        var hasta = new Date(c.activeTo.getTime() + VENTANA_PTO_MIN * 60000);
        var pulsos = (pulsosPorVehiculo[c.idVehiculo] || []).filter(function (p) {
          return p >= desde && p <= hasta;
        });
        if (pulsos.length > 0) {
          // Pulso mas cercano al inicio del evento, igual criterio que
          // _revisar_regla_revolucion en telegram_alertas.py.
          var masCercano = pulsos[0];
          var menorDelta = Math.abs(masCercano - c.activeFrom);
          pulsos.forEach(function (p) {
            var delta = Math.abs(p - c.activeFrom);
            if (delta < menorDelta) { menorDelta = delta; masCercano = p; }
          });
          c.ptoPulso = masCercano;
          c.ptoDeltaSeg = (masCercano - c.activeFrom) / 1000;
          confirmados.push(c);
        }
      });
      return confirmados;
    });
  }

  // --- Agrega el pico de RPM (+/- VENTANA_RPM_SEG) a cada evento confirmado --
  function agregarPicoRpm(eventosConfirmados) {
    if (eventosConfirmados.length === 0) return Promise.resolve(eventosConfirmados);

    var vehiculosUnicos = [];
    eventosConfirmados.forEach(function (c) {
      if (vehiculosUnicos.indexOf(c.idVehiculo) === -1) vehiculosUnicos.push(c.idVehiculo);
    });

    var desdeGlobal = new Date(Math.min.apply(null, eventosConfirmados.map(function (c) { return c.activeFrom.getTime(); })) - VENTANA_RPM_SEG * 1000);
    var hastaGlobal = new Date(Math.max.apply(null, eventosConfirmados.map(function (c) { return c.activeTo.getTime(); })) + VENTANA_RPM_SEG * 1000);

    var llamadas = vehiculosUnicos.map(function (idVeh) {
      return ['Get', {
        typeName: 'StatusData',
        search: {
          diagnosticSearch: { id: ID_DIAGNOSTICO_RPM },
          deviceSearch: { id: idVeh },
          fromDate: desdeGlobal.toISOString(),
          toDate: hastaGlobal.toISOString()
        }
      }];
    });

    return apiMultiCall(llamadas).then(function (resultados) {
      var lecturasPorVehiculo = {};
      vehiculosUnicos.forEach(function (idVeh, i) {
        lecturasPorVehiculo[idVeh] = (resultados[i] || []).map(function (l) {
          return { t: new Date(l.dateTime), v: parseFloat(l.data) };
        });
      });

      eventosConfirmados.forEach(function (c) {
        var desde = new Date(c.activeFrom.getTime() - VENTANA_RPM_SEG * 1000);
        var hasta = new Date(c.activeTo.getTime() + VENTANA_RPM_SEG * 1000);
        var valores = (lecturasPorVehiculo[c.idVehiculo] || [])
          .filter(function (l) { return l.t >= desde && l.t <= hasta && !isNaN(l.v); })
          .map(function (l) { return l.v; });
        c.rpmPico = valores.length ? Math.max.apply(null, valores) : null;
      });
      return eventosConfirmados;
    });
  }

  // --- Turno operativo, mismos rangos horarios que clasificar_turno en
  // app.py/geotab_comun.py (solo cambia el prefijo mostrado aca: T en vez de R,
  // a pedido del usuario -- el backend en Python sigue usando R1/R2/R3). ------
  function clasificarTurno(hora) {
    if (hora >= 5 && hora < 13) return 'T1';
    if (hora >= 13 && hora < 21) return 'T2';
    return 'T3';
  }

  // --- Jerarquia de grupos de Geotab -> marca y tipologia -------------------
  // Puerto directo de obtener_mapa_grupos / resolver_marca en telegram_alertas.py.
  function esGrupoMarca(nombre) {
    var l = (nombre || '').trim().toLowerCase();
    return Object.keys(REFERENCIA_MOTOR_POR_MARCA).some(function (marca) {
      return l.indexOf(marca) !== -1;
    });
  }

  function referenciaMotorDeMarca(marca) {
    var l = (marca || '').toLowerCase();
    var claves = Object.keys(REFERENCIA_MOTOR_POR_MARCA);
    for (var i = 0; i < claves.length; i++) {
      if (l.indexOf(claves[i]) !== -1) return REFERENCIA_MOTOR_POR_MARCA[claves[i]];
    }
    return 'Desconocido';
  }

  var mapaGruposCache = null; // se recarga una vez por sesion de la pagina, no por cada refresco

  function normalizarCiudad(nombre) {
    var n = (nombre || '').toUpperCase();
    if (n.indexOf('BOGOTA') !== -1 || n.indexOf('BOGOTÁ') !== -1) return 'Bogotá';
    if (n.indexOf('CALI') !== -1) return 'Cali';
    if (n.indexOf('VALLE') !== -1) return 'Valle';
    // Title-case simple, igual criterio que nombre.strip().title() en Python
    return (nombre || '').trim().toLowerCase().replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }

  function obtenerMapaGrupos() {
    if (mapaGruposCache) return Promise.resolve(mapaGruposCache);
    return apiCall('Get', { typeName: 'Group' }).then(function (grupos) {
      var porId = {};
      (grupos || []).forEach(function (g) { if (g && g.id) porId[g.id] = g; });

      function idDe(ref) { return (ref && ref.id) ? ref.id : ref; }

      var raiz = (grupos || []).filter(function (g) { return g && typeof g.name === 'string'; })
        .find(function (g) { return g.name.trim().indexOf('*') === 0; });

      var mapa = {};
      if (!raiz) { mapaGruposCache = mapa; return mapa; }

      function recorrer(grupoId, ciudadActual, tipologiaActual) {
        var grupoCompleto = porId[grupoId];
        if (!grupoCompleto) return;
        mapa[grupoId] = { nombre: grupoCompleto.name || '', ciudad: ciudadActual, tipologia: tipologiaActual };
        (grupoCompleto.children || []).forEach(function (hijo) { recorrer(idDe(hijo), ciudadActual, tipologiaActual); });
      }

      (raiz.children || []).forEach(function (hijoRaiz) {
        var hijoId = idDe(hijoRaiz);
        var hijoCompleto = porId[hijoId] || {};
        var nombre = (hijoCompleto.name || '').trim();
        if (nombre.toLowerCase() === NOMBRE_GRUPO_TIPOLOGIA) {
          // Rama Tipologia: cada subgrupo directo es un tipo de vehiculo distinto;
          // esta rama no representa ninguna ciudad especifica.
          (hijoCompleto.children || []).forEach(function (sub) {
            var subId = idDe(sub);
            var subCompleto = porId[subId] || {};
            var tipoNombre = (subCompleto.name || '').trim();
            recorrer(subId, 'Sin ciudad asignada', tipoNombre);
          });
        } else if (esGrupoMarca(nombre)) {
          // Rama de marca (International, Foton, etc.): tampoco representa ciudad.
          recorrer(hijoId, 'Sin ciudad asignada', null);
        } else {
          // Cualquier otra rama de nivel raiz se asume que es una ciudad.
          recorrer(hijoId, normalizarCiudad(nombre), null);
        }
      });

      mapaGruposCache = mapa;
      return mapa;
    }).catch(function (e) {
      console.error('No se pudo cargar la jerarquia de grupos:', e);
      return {};
    });
  }

  function resolverMarcaYTipologia(gruposVehiculo, mapaGrupos) {
    var marca = null;
    var ciudad = 'Sin ciudad asignada';
    var tipologia = 'Sin tipología asignada';
    (gruposVehiculo || []).forEach(function (g) {
      var gid = (g && g.id) ? g.id : g;
      var info = mapaGrupos[gid];
      if (!info) return;
      if (!marca && esGrupoMarca(info.nombre)) marca = info.nombre.trim();
      if (info.ciudad && ciudad === 'Sin ciudad asignada') ciudad = info.ciudad;
      if (info.tipologia && tipologia === 'Sin tipología asignada') tipologia = info.tipologia;
    });
    return { marca: marca || 'Sin marca identificada', ciudad: ciudad, tipologia: tipologia };
  }

  // --- Resuelve nombre/placa/marca/tipologia de cada vehiculo involucrado ----
  function resolverVehiculos(eventosConfirmados) {
    var vehiculosUnicos = [];
    eventosConfirmados.forEach(function (c) {
      if (vehiculosUnicos.indexOf(c.idVehiculo) === -1) vehiculosUnicos.push(c.idVehiculo);
    });
    if (vehiculosUnicos.length === 0) return Promise.resolve(eventosConfirmados);

    var llamadas = vehiculosUnicos.map(function (idVeh) {
      return ['Get', { typeName: 'Device', search: { id: idVeh } }];
    });

    return Promise.all([apiMultiCall(llamadas), obtenerMapaGrupos()]).then(function (resultados) {
      var respuestasDevice = resultados[0];
      var mapaGrupos = resultados[1];

      var infoPorVehiculo = {};
      vehiculosUnicos.forEach(function (idVeh, i) {
        var dev = (respuestasDevice[i] || [])[0];
        var mt = resolverMarcaYTipologia(dev ? dev.groups : null, mapaGrupos);
        infoPorVehiculo[idVeh] = {
          nombre: dev ? (dev.name || idVeh) : idVeh,
          placa: dev ? (dev.licensePlate || '') : '',
          marca: mt.marca,
          ciudad: mt.ciudad,
          tipologia: mt.tipologia,
          referenciaMotor: referenciaMotorDeMarca(mt.marca)
        };
      });
      eventosConfirmados.forEach(function (c) {
        var info = infoPorVehiculo[c.idVehiculo] || {
          nombre: c.idVehiculo, placa: '', marca: 'Sin marca identificada',
          ciudad: 'Sin ciudad asignada', tipologia: 'Sin tipología asignada', referenciaMotor: 'Desconocido'
        };
        c.nombreVehiculo = info.nombre;
        c.placa = info.placa;
        c.marca = info.marca;
        c.ciudad = info.ciudad;
        c.tipologia = info.tipologia;
        c.referenciaMotor = info.referenciaMotor;
        c.turno = clasificarTurno(c.activeFrom.getHours());
        c.claveVehiculo = c.nombreVehiculo + (c.placa ? ' - ' + c.placa : '');
      });
      return eventosConfirmados;
    });
  }

  // CAMBIO: la regla de Geotab sigue en 1300 RPM para TODAS las marcas (no se
  // tocó -- ramificar por grupo dentro de una sola regla no es posible en
  // Geotab). Mercedes (motor OM926) exige además este umbral propio, aplicado
  // aca DESPUES de que la regla ya genero el candidato a 1300 -- mismo
  // criterio que _filtrar_por_umbral_mercedes en telegram_alertas.py
  // (decisión tomada con el usuario 2026-09-14). Si rpmPico es null (la
  // consulta de RPM falló), NO se descarta -- mismo criterio de "fallar
  // abierto" que el resto del add-in.
  var UMBRAL_RPM_MERCEDES = 1500;

  function filtrarPorUmbralMercedes(eventos) {
    return eventos.filter(function (e) {
      var marca = (e.marca || '').toLowerCase();
      var esMercedesBajoUmbral = marca.indexOf('mercedes') !== -1 &&
        e.rpmPico !== null && e.rpmPico !== undefined && e.rpmPico < UMBRAL_RPM_MERCEDES;
      return !esMercedesBajoUmbral;
    });
  }

  // --- Texto del cruce de PTO, mismo criterio que _revisar_regla_revolucion en telegram_alertas.py ---
  function formatearDeltaPto(e) {
    if (!e.ptoPulso || e.ptoDeltaSeg === undefined) return 'PTO activo cerca (±' + VENTANA_PTO_MIN + ' min).';
    var absDelta = Math.abs(e.ptoDeltaSeg);
    var textoDelta;
    if (absDelta < 60) {
      var nSeg = Math.round(absDelta);
      textoDelta = nSeg + ' segundo' + (nSeg === 1 ? '' : 's');
    } else {
      var minutos = absDelta / 60;
      textoDelta = minutos.toFixed(1) + ' minuto' + (Math.abs(minutos - 1) < 0.05 ? '' : 's');
    }
    var direccion;
    if (e.ptoDeltaSeg < 0) direccion = textoDelta + ' antes del inicio del evento';
    else if (e.ptoDeltaSeg > 0) direccion = textoDelta + ' después del inicio del evento';
    else direccion = 'justo al inicio del evento';
    return 'PTO detectado a las ' + formatearHora(e.ptoPulso) + ' (' + direccion + ').';
  }

  // ---------------------------------------------------------------------------
  // Tripulaciones: cruce con el Excel diario de conductor-vehiculo-turno que
  // pasa el equipo de operaciones (columnas reales: PLACA, # INTERNO,
  // TRIPULACIÓN, FECHA, HORA INICIO, HORA FIN, # CEDULA, GRUPO). Se parsea
  // 100% en el navegador con SheetJS (nunca sale del equipo del usuario) y se
  // guarda en localStorage para no tener que resubirlo cada vez que se abre
  // el add-in -- misma clave que usa el add-in de Alertas por Severidad, por
  // si algun dia comparten origen y localStorage (no hace daño si no lo comparten,
  // cada uno simplemente pide su propio archivo).
  // ---------------------------------------------------------------------------
  var tripulacionesCache = [];
  var tripulacionesMetaCache = null;

  function normalizarPlacaTripulacion(valor) {
    if (valor === null || valor === undefined) return null;
    var limpio = String(valor).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return limpio || null;
  }

  // SSF.parse_date_code convierte un serial de Excel (fecha y/o fraccion de
  // dia) a sus componentes y-m-d-H-M-S mediante pura aritmetica -- sin pasar
  // por ningun Date/huso horario intermedio, asi se evita el mismo tipo de bug
  // de zona horaria que ya se corrigio una vez en el add-in de Alertas.
  function serialAFechaLocal(serialFecha, serialHora) {
    if (serialFecha === null || serialFecha === undefined) return null;
    var partesFecha = XLSX.SSF.parse_date_code(serialFecha);
    if (!partesFecha) return null;
    var horas = 0, minutos = 0, segundos = 0;
    if (serialHora !== null && serialHora !== undefined) {
      var partesHora = XLSX.SSF.parse_date_code(serialHora);
      if (partesHora) { horas = partesHora.H; minutos = partesHora.M; segundos = Math.round(partesHora.S || 0); }
    }
    return new Date(partesFecha.y, partesFecha.m - 1, partesFecha.d, horas, minutos, segundos);
  }

  // 'YYYY-MM-DD' en hora local -- clave para comparar SOLO la fecha calendario
  // (sin hora), usada para exigir que el turno sea del mismo día que el evento.
  function claveFechaLocal(fecha) {
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return fecha.getFullYear() + '-' + pad(fecha.getMonth() + 1) + '-' + pad(fecha.getDate());
  }

  function parsearArchivoTripulaciones(arrayBuffer) {
    var wb = XLSX.read(arrayBuffer, { type: 'array' });
    var ws = wb.Sheets[wb.SheetNames[0]];
    var filas = XLSX.utils.sheet_to_json(ws, { raw: true, defval: null });

    var turnos = [];
    filas.forEach(function (f) {
      var placa = normalizarPlacaTripulacion(f['PLACA']);
      var conductorCrudo = f['TRIPULACIÓN'] || f['TRIPULACION'];
      if (!placa || !conductorCrudo) return;

      var desde = serialAFechaLocal(f['FECHA'], f['HORA INICIO']);
      var hasta = serialAFechaLocal(f['FECHA'], f['HORA FIN']);
      if (!desde || !hasta) return;
      // 'fechaTurno' se guarda ANTES del ajuste de medianoche: es la fecha real
      // que trae la columna FECHA del Excel (el día al que pertenece el turno),
      // no la fecha en que se cruza el evento. Se usa en buscarConductor para
      // exigir coincidencia exacta de día -- ver comentario ahí.
      var fechaTurno = claveFechaLocal(desde);
      if (hasta <= desde) hasta = new Date(hasta.getTime() + 24 * 60 * 60 * 1000); // turno nocturno cruza medianoche

      turnos.push({
        placa: placa,
        codigoInterno: f['# INTERNO'] !== null && f['# INTERNO'] !== undefined ? String(f['# INTERNO']).trim() : null,
        conductor: String(conductorCrudo).trim(),
        cedula: f['# CEDULA'] !== null && f['# CEDULA'] !== undefined ? String(f['# CEDULA']).trim() : null,
        grupo: f['GRUPO'] || null,
        fechaTurno: fechaTurno,
        desde: desde.toISOString(),
        hasta: hasta.toISOString()
      });
    });
    return turnos;
  }

  function cargarTripulacionesGuardadas() {
    try {
      var datos = JSON.parse(localStorage.getItem(CLAVE_LOCALSTORAGE_TRIPULACIONES) || 'null');
      var meta = JSON.parse(localStorage.getItem(CLAVE_LOCALSTORAGE_TRIPULACIONES_META) || 'null');
      tripulacionesCache = Array.isArray(datos) ? datos : [];
      tripulacionesMetaCache = meta;
    } catch (e) { tripulacionesCache = []; tripulacionesMetaCache = null; }
  }

  function guardarTripulaciones(turnos, meta) {
    tripulacionesCache = turnos;
    tripulacionesMetaCache = meta;
    try {
      localStorage.setItem(CLAVE_LOCALSTORAGE_TRIPULACIONES, JSON.stringify(turnos));
      localStorage.setItem(CLAVE_LOCALSTORAGE_TRIPULACIONES_META, JSON.stringify(meta));
    } catch (e) { console.error('No se pudo guardar el archivo de tripulaciones (localStorage lleno o no disponible):', e); }
  }

  // Devuelve el/los nombre(s) de conductor cuyo turno cubre 'fecha' para ese
  // vehiculo (por placa O por codigo interno -- lo que primero coincida).
  // Si hay mas de un turno solapado (pasa en la data real: dos conductores
  // con el mismo horario de inicio en rutas distintas), se devuelven todos
  // separados por " / " en vez de adivinar cual es el correcto. SOLO match
  // exacto -- a proposito, sin tolerancia ni aproximacion: la atribucion de
  // conductor puede usarse para llamados de atencion, asi que "No identificado"
  // (dato faltante, honesto) es preferible a un nombre aproximado que alguien
  // podria leer como un hecho confirmado.
  //
  // El archivo de tripulaciones SIEMPRE llega un dia despues del que cubre
  // (se carga hoy con la info de ayer, workflow fijo del usuario) -- por eso
  // se exige que 'fechaTurno' (el dia real de la fila) sea EXACTAMENTE el
  // mismo dia calendario que 'fecha' (el evento a identificar), incluso para
  // turnos nocturnos que cruzan medianoche. Sin este chequeo, un turno de
  // ayer que se extiende +24h por cruzar medianoche podia "alcanzar" y dar
  // falso positivo sobre eventos de HOY con el conductor de un turno viejo
  // (bug real detectado 2026-09-10: aparecia el conductor de la manana en
  // eventos de la tarde del dia siguiente). Mientras no se cargue el archivo
  // de HOY, cualquier evento de hoy debe quedar "No identificado" a proposito.
  function buscarConductor(placaVehiculo, codigoVehiculo, fecha) {
    if (!tripulacionesCache.length || !fecha) return null;
    var placaNorm = normalizarPlacaTripulacion(placaVehiculo);
    var codigoNorm = codigoVehiculo ? String(codigoVehiculo).trim() : null;
    var fechaEventoClave = claveFechaLocal(fecha);

    var nombresExactos = [];
    var gruposExactos = [];
    for (var i = 0; i < tripulacionesCache.length; i++) {
      var t = tripulacionesCache[i];
      var coincideVehiculo = (placaNorm && t.placa === placaNorm) || (codigoNorm && t.codigoInterno === codigoNorm);
      if (!coincideVehiculo) continue;
      if (t.fechaTurno !== fechaEventoClave) continue;
      var desde = new Date(t.desde), hasta = new Date(t.hasta);
      if (fecha >= desde && fecha <= hasta) {
        if (nombresExactos.indexOf(t.conductor) === -1) nombresExactos.push(t.conductor);
        if (t.grupo && gruposExactos.indexOf(t.grupo) === -1) gruposExactos.push(t.grupo);
      }
    }
    return nombresExactos.length
      ? { texto: nombresExactos.join(' / '), grupo: gruposExactos.join(' / ') || null, aproximado: false }
      : null;
  }

  // Texto final a mostrar: nombre + su grupo de ruta (columna GRUPO del Excel,
  // ej. R3/R4/R8 -- distinto del Turno T1/T2/T3 que se calcula por hora del evento).
  function textoConductorConGrupo(resultado) {
    if (!resultado) return 'No identificado';
    return resultado.texto + (resultado.grupo ? ' (Grupo ' + resultado.grupo + ')' : '');
  }

  // Extrae codigo/placa del 'name' del Device, que en esta cuenta siempre
  // viene como 'CODIGO-PLACA' (ej. '1148-NWW623') -- mismo criterio que
  // placa_desde_nombre_device en herramientas/cruce_inventario_geotab.py.
  function codigoYPlacaDeNombre(nombreDevice) {
    if (!nombreDevice) return { codigo: null, placa: null };
    var partes = nombreDevice.split('-');
    if (partes.length < 2) return { codigo: null, placa: nombreDevice };
    return { codigo: partes[0], placa: partes.slice(1).join('-') };
  }

  function construirControlTripulaciones(contenedor, onCargado) {
    var panel = crear('div', {
      display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
      padding: '8px 22px', fontSize: '0.78rem', color: T.color.body
    });

    var textoEstado = crear('span');
    function actualizarTextoEstado() {
      if (tripulacionesMetaCache && tripulacionesCache.length) {
        textoEstado.textContent = '📋 Tripulaciones: ' + tripulacionesMetaCache.nombreArchivo +
          ' — ' + tripulacionesCache.length + ' turnos (cargado ' + tripulacionesMetaCache.cargadoEn + ')';
        textoEstado.style.color = T.color.body;
      } else {
        textoEstado.textContent = '⚠️ Sin archivo de tripulaciones cargado — el conductor no se puede identificar.';
        textoEstado.style.color = T.color.muted;
      }
    }
    actualizarTextoEstado();

    var inputArchivo = crear('input');
    inputArchivo.type = 'file';
    inputArchivo.accept = '.xlsx,.xls';
    inputArchivo.style.display = 'none';
    inputArchivo.addEventListener('change', function () {
      var archivo = inputArchivo.files && inputArchivo.files[0];
      if (!archivo) return;
      var lector = new FileReader();
      lector.onload = function (evento) {
        try {
          var turnos = parsearArchivoTripulaciones(evento.target.result);
          if (!turnos.length) {
            alert('No se encontraron filas validas en ese Excel (se esperan columnas PLACA, TRIPULACIÓN, FECHA, HORA INICIO, HORA FIN).');
            return;
          }
          var meta = { nombreArchivo: archivo.name, cargadoEn: formatearFechaHora(new Date()), filas: turnos.length };
          guardarTripulaciones(turnos, meta);
          actualizarTextoEstado();
          if (onCargado) onCargado();
        } catch (e) {
          console.error('Error parseando archivo de tripulaciones:', e);
          alert('No se pudo leer ese archivo como Excel. Revisa que sea el .xlsx correcto.');
        }
      };
      lector.readAsArrayBuffer(archivo);
      inputArchivo.value = '';
    });

    var botonCargar = crear('button', {
      padding: '6px 12px', borderRadius: T.radius.sm, fontSize: '0.76rem', fontWeight: '700',
      cursor: 'pointer', background: 'transparent', color: T.color.primaryDark, border: '1px solid ' + T.color.primary
    }, '📂 Cargar Excel de tripulaciones');
    botonCargar.addEventListener('click', function () { inputArchivo.click(); });

    panel.appendChild(textoEstado);
    panel.appendChild(botonCargar);
    panel.appendChild(inputArchivo);
    contenedor.appendChild(panel);
  }

  // --- Estado de filtros y orden, todo client-side (sin volver a consultar Geotab) ---
  var eventosCache = [];
  var filtroEstado = { texto: '', turno: 'Todos', ciudad: 'Todas', vehiculo: null, rpmMinimo: '' };
  var ordenEstado = { columna: 'fecha', direccion: 'desc' };

  function aplicarFiltros(eventos) {
    var texto = filtroEstado.texto.trim().toLowerCase();
    var rpmMin = parseFloat(filtroEstado.rpmMinimo);
    var haySesionRpmMin = !isNaN(rpmMin) && filtroEstado.rpmMinimo !== '';

    return eventos.filter(function (e) {
      if (texto) {
        var indice = (e.claveVehiculo + ' ' + e.marca + ' ' + e.tipologia + ' ' + e.ciudad).toLowerCase();
        if (indice.indexOf(texto) === -1) return false;
      }
      if (filtroEstado.turno !== 'Todos' && e.turno !== filtroEstado.turno) return false;
      if (filtroEstado.ciudad !== 'Todas' && e.ciudad !== filtroEstado.ciudad) return false;
      if (filtroEstado.vehiculo && e.claveVehiculo !== filtroEstado.vehiculo) return false;
      if (haySesionRpmMin && (e.rpmPico === null || e.rpmPico < rpmMin)) return false;
      return true;
    });
  }

  function ordenarEventos(eventos) {
    var factor = ordenEstado.direccion === 'asc' ? 1 : -1;
    return eventos.slice().sort(function (a, b) {
      var va, vb;
      if (ordenEstado.columna === 'duracion') { va = a.duracionSeg; vb = b.duracionSeg; }
      else if (ordenEstado.columna === 'rpm') {
        va = a.rpmPico === null ? -Infinity : a.rpmPico;
        vb = b.rpmPico === null ? -Infinity : b.rpmPico;
      } else if (ordenEstado.columna === 'movil') { va = a.nombreVehiculo; vb = b.nombreVehiculo; }
      else if (ordenEstado.columna === 'placa') { va = a.placa || ''; vb = b.placa || ''; }
      else if (ordenEstado.columna === 'turno') { va = a.turno; vb = b.turno; }
      else if (ordenEstado.columna === 'marca') { va = a.marca; vb = b.marca; }
      else if (ordenEstado.columna === 'ciudad') { va = a.ciudad; vb = b.ciudad; }
      else if (ordenEstado.columna === 'tipologia') { va = a.tipologia; vb = b.tipologia; }
      else { va = a.activeFrom; vb = b.activeFrom; }

      if (typeof va === 'string') {
        return va.localeCompare(vb) * factor;
      }
      if (va < vb) return -1 * factor;
      if (va > vb) return 1 * factor;
      return 0;
    });
  }

  // El filtro de ciudad NO cuenta aqui a proposito: el refresco automatico
  // debe seguir corriendo aunque el usuario solo haya elegido una ciudad,
  // y solo se detiene cuando hay un filtro de analisis mas fino en curso
  // (texto, turno, vehiculo puntual o piso de RPM) que un refetch pisaria.
  function hayFiltrosQueBloqueanAutoRefresco() {
    return !!(filtroEstado.texto || filtroEstado.turno !== 'Todos' || filtroEstado.vehiculo || filtroEstado.rpmMinimo);
  }

  function hayFiltrosActivos() {
    return !!(filtroEstado.texto || filtroEstado.turno !== 'Todos' || filtroEstado.ciudad !== 'Todas' || filtroEstado.vehiculo || filtroEstado.rpmMinimo);
  }

  // --- Barra de filtros interactiva (todo client-side, sin re-consultar Geotab) ---
  function construirBarraFiltros(contenedor, onCambio) {
    var panelExterno = crear('div', { padding: '14px 22px' });
    var panel = crearPanel({ padding: '14px 18px', display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-end' });

    // Busqueda por movil/placa
    var envBusqueda = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1', minWidth: '180px' });
    envBusqueda.appendChild(crear('label', {
      fontSize: '0.7rem', fontWeight: '700', color: T.color.muted, textTransform: 'uppercase', letterSpacing: '0.04em'
    }, 'Buscar móvil o placa'));
    var inputBusqueda = crear('input');
    inputBusqueda.type = 'text';
    inputBusqueda.placeholder = 'Ej: 3095, GVT513, Foton, Compactador...';
    aplicarEstilo(inputBusqueda, {
      padding: '8px 10px', border: '1px solid ' + T.color.border, borderRadius: T.radius.sm,
      fontSize: '0.85rem', color: T.color.ink
    });
    inputBusqueda.addEventListener('input', function () {
      filtroEstado.texto = inputBusqueda.value;
      onCambio();
    });
    envBusqueda.appendChild(inputBusqueda);

    // Turno: botones tipo pastilla, uno activo a la vez
    var envTurno = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    envTurno.appendChild(crear('label', {
      fontSize: '0.7rem', fontWeight: '700', color: T.color.muted, textTransform: 'uppercase', letterSpacing: '0.04em'
    }, 'Turno'));
    var filaTurnos = crear('div', { display: 'flex', gap: '6px' });
    var botonesTurno = {};
    ['Todos', 'T1', 'T2', 'T3'].forEach(function (turno) {
      var boton = crear('button', {
        padding: '7px 12px', borderRadius: T.radius.pill, fontSize: '0.78rem', fontWeight: '700',
        cursor: 'pointer', transition: 'all 0.12s ease', border: '1px solid ' + T.color.border
      }, turno);
      boton.addEventListener('click', function () {
        filtroEstado.turno = turno;
        actualizarBotonesTurno();
        onCambio();
      });
      botonesTurno[turno] = boton;
      filaTurnos.appendChild(boton);
    });
    envTurno.appendChild(filaTurnos);

    function actualizarBotonesTurno() {
      Object.keys(botonesTurno).forEach(function (turno) {
        var boton = botonesTurno[turno];
        var activo = filtroEstado.turno === turno;
        boton.style.background = activo ? T.color.primary : T.color.surface;
        boton.style.color = activo ? '#FFFFFF' : T.color.body;
        boton.style.borderColor = activo ? T.color.primary : T.color.border;
      });
    }
    actualizarBotonesTurno();

    // Ciudad: desplegable, se repuebla dinamicamente segun las ciudades que
    // realmente aparezcan en los datos cargados (ver actualizarOpcionesCiudad).
    var envCiudad = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '160px' });
    envCiudad.appendChild(crear('label', {
      fontSize: '0.7rem', fontWeight: '700', color: T.color.muted, textTransform: 'uppercase', letterSpacing: '0.04em'
    }, 'Ciudad'));
    var selectCiudad = crear('select');
    aplicarEstilo(selectCiudad, {
      padding: '8px 10px', border: '1px solid ' + T.color.border, borderRadius: T.radius.sm,
      fontSize: '0.85rem', color: T.color.ink, background: T.color.surface
    });
    selectCiudad.addEventListener('change', function () {
      filtroEstado.ciudad = selectCiudad.value;
      onCambio();
    });
    envCiudad.appendChild(selectCiudad);

    // RPM minimo
    var envRpm = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px', width: '130px' });
    envRpm.appendChild(crear('label', {
      fontSize: '0.7rem', fontWeight: '700', color: T.color.muted, textTransform: 'uppercase', letterSpacing: '0.04em'
    }, 'RPM mínimo'));
    var inputRpm = crear('input');
    inputRpm.type = 'number';
    inputRpm.placeholder = 'Ej: 1500';
    aplicarEstilo(inputRpm, {
      padding: '8px 10px', border: '1px solid ' + T.color.border, borderRadius: T.radius.sm,
      fontSize: '0.85rem', color: T.color.ink
    });
    inputRpm.addEventListener('input', function () {
      filtroEstado.rpmMinimo = inputRpm.value;
      onCambio();
    });
    envRpm.appendChild(inputRpm);

    // Limpiar filtros
    var botonLimpiar = crear('button', {
      padding: '8px 14px', borderRadius: T.radius.sm, fontSize: '0.8rem', fontWeight: '700',
      cursor: 'pointer', background: 'transparent', color: T.color.body, border: '1px solid ' + T.color.border
    }, 'Limpiar filtros');
    botonLimpiar.addEventListener('click', function () {
      filtroEstado.texto = ''; filtroEstado.turno = 'Todos'; filtroEstado.ciudad = 'Todas';
      filtroEstado.vehiculo = null; filtroEstado.rpmMinimo = '';
      inputBusqueda.value = ''; inputRpm.value = ''; selectCiudad.value = 'Todas';
      actualizarBotonesTurno();
      onCambio();
    });

    panel.appendChild(envBusqueda);
    panel.appendChild(envTurno);
    panel.appendChild(envCiudad);
    panel.appendChild(envRpm);
    panel.appendChild(botonLimpiar);
    panelExterno.appendChild(panel);

    // Chip de "filtrando por vehiculo X" -- aparece solo cuando se hace clic en una barra de la grafica
    var chipVehiculo = crear('div', { marginTop: '10px', display: 'none', alignItems: 'center', gap: '8px' });
    var textoChip = crear('span', {
      fontSize: '0.78rem', color: T.color.primaryDark, background: T.color.primarySoft,
      padding: '5px 10px', borderRadius: T.radius.pill, fontWeight: '600'
    });
    var botonQuitarChip = crear('button', {
      background: 'transparent', border: 'none', color: T.color.primaryDark, cursor: 'pointer',
      fontSize: '0.78rem', fontWeight: '700', textDecoration: 'underline'
    }, 'Quitar filtro');
    botonQuitarChip.addEventListener('click', function () {
      filtroEstado.vehiculo = null;
      chipVehiculo.style.display = 'none';
      onCambio();
    });
    chipVehiculo.appendChild(textoChip);
    chipVehiculo.appendChild(botonQuitarChip);
    panelExterno.appendChild(chipVehiculo);

    contenedor.appendChild(panelExterno);

    return {
      mostrarChipVehiculo: function (nombreVehiculo) {
        textoChip.textContent = '🚚 Filtrando por: ' + nombreVehiculo;
        chipVehiculo.style.display = 'flex';
      },
      ocultarChipVehiculo: function () { chipVehiculo.style.display = 'none'; },
      // Repuebla el desplegable de ciudad segun las ciudades presentes en
      // eventosCache, conservando la seleccion actual si sigue siendo valida.
      actualizarOpcionesCiudad: function (ciudadesDisponibles) {
        var seleccionPrevia = selectCiudad.value || 'Todas';
        selectCiudad.innerHTML = '';
        var opcionTodas = crear('option');
        opcionTodas.value = 'Todas';
        opcionTodas.textContent = 'Todas';
        selectCiudad.appendChild(opcionTodas);
        ciudadesDisponibles.forEach(function (ciudad) {
          var opcion = crear('option');
          opcion.value = ciudad;
          opcion.textContent = ciudad;
          selectCiudad.appendChild(opcion);
        });
        var siguenValida = seleccionPrevia === 'Todas' || ciudadesDisponibles.indexOf(seleccionPrevia) !== -1;
        selectCiudad.value = siguenValida ? seleccionPrevia : 'Todas';
        filtroEstado.ciudad = selectCiudad.value;
      }
    };
  }

  // --- Construccion visual ---------------------------------------------------
  function crearCampoFecha(etiquetaTexto, valorInicial) {
    var envoltorio = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    envoltorio.appendChild(crear('label', {
      fontSize: '0.7rem', fontWeight: '700', color: T.color.muted,
      textTransform: 'uppercase', letterSpacing: '0.04em'
    }, etiquetaTexto));
    var input = crear('input');
    input.type = 'datetime-local';
    input.value = valorInicial;
    aplicarEstilo(input, {
      padding: '8px 10px', border: '1px solid ' + T.color.border, borderRadius: T.radius.sm,
      fontSize: '0.85rem', color: T.color.ink, background: T.color.surface
    });
    input.addEventListener('focus', function () { input.style.borderColor = T.color.primary; });
    input.addEventListener('blur', function () { input.style.borderColor = T.color.border; });
    envoltorio.appendChild(input);
    return { envoltorio: envoltorio, input: input };
  }

  function construirEncabezado(contenedor) {
    var encabezado = crear('div', {
      padding: '18px 22px',
      background: T.color.surface,
      borderBottom: '1px solid ' + T.color.border,
      position: 'sticky', top: '0', zIndex: '5'
    });

    var filaTitulo = crear('div', { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' });
    filaTitulo.appendChild(crearChip('🏎️', T.color.primarySoft, T.color.primaryDark, '38px'));

    var bloqueTexto = crear('div');
    bloqueTexto.appendChild(crear('h2', {
      margin: '0', color: T.color.ink, fontSize: '1.25rem', fontWeight: '800', letterSpacing: '-0.01em'
    }, 'Sobre-Revolución con PTO'));
    bloqueTexto.appendChild(crear('p', {
      margin: '2px 0 0 0', color: T.color.body, fontSize: '0.82rem'
    }, 'RPM > 1300 sostenido 30s con el vehículo detenido · PTO confirmado por cercanía (±3 min)'));

    // --- Panel de riesgo mecanico, colapsable (pedido 2026-09-17) ---------
    // Recuerda el estado (expandido/colapsado) por viewer via localStorage,
    // igual que el resto de preferencias de este addin -- para un supervisor
    // que ya lo sabe de memoria, no debe reaparecer expandido cada vez.
    var expandidoInicial = cargarPreferenciaRiesgo();
    var TEXTO_CERRADO = '⚠️ ¿Por qué importa esto? — riesgo mecánico y de costos';
    var TEXTO_ABIERTO = '▲ Ocultar';
    var enlaceRiesgo = crear('a', {
      display: 'inline-block', marginTop: '6px', fontSize: '0.76rem', fontWeight: '700',
      color: T.color.danger, textDecoration: 'none', cursor: 'pointer'
    }, expandidoInicial ? TEXTO_ABIERTO : TEXTO_CERRADO);
    var panelRiesgo = crear('div', {
      marginTop: '8px', padding: '10px 12px', background: T.color.dangerSoft,
      border: '1px solid ' + T.color.dangerBorder, borderRadius: T.radius.sm,
      fontSize: '0.78rem', color: T.color.ink, lineHeight: '1.45', maxWidth: '640px',
      display: expandidoInicial ? 'block' : 'none'
    }, 'Sostener el motor en RPM alto con la bomba hidráulica del compactador acoplada acelera el ' +
       'desgaste del sello y los rodamientos de la bomba, reduciendo su vida útil y elevando el riesgo ' +
       'de una falla costosa e imprevista en plena ruta. Cada evento repetido en el mismo vehículo es ' +
       'una señal operativa para corregir el hábito de conducción antes de que se traduzca en un daño ' +
       'real al sistema hidráulico.');
    enlaceRiesgo.addEventListener('click', function () {
      var expandidoAhora = panelRiesgo.style.display !== 'none';
      var nuevoEstado = !expandidoAhora;
      panelRiesgo.style.display = nuevoEstado ? 'block' : 'none';
      enlaceRiesgo.textContent = nuevoEstado ? TEXTO_ABIERTO : TEXTO_CERRADO;
      guardarPreferenciaRiesgo(nuevoEstado);
    });
    bloqueTexto.appendChild(enlaceRiesgo);
    bloqueTexto.appendChild(panelRiesgo);

    filaTitulo.appendChild(bloqueTexto);

    var rango = cargarRangoGuardado();
    var campoDesde = crearCampoFecha('Desde', rango.desde);
    var campoHasta = crearCampoFecha('Hasta', rango.hasta);

    var botonActualizar = crear('button', {
      alignSelf: 'flex-end',
      padding: '9px 18px',
      background: T.color.primary,
      color: '#FFFFFF',
      border: 'none',
      borderRadius: T.radius.sm,
      fontWeight: '700',
      fontSize: '0.85rem',
      cursor: 'pointer',
      transition: 'background 0.15s ease, transform 0.1s ease'
    }, 'Actualizar');
    botonActualizar.addEventListener('mouseenter', function () { botonActualizar.style.background = T.color.primaryDark; });
    botonActualizar.addEventListener('mouseleave', function () { botonActualizar.style.background = T.color.primary; });
    botonActualizar.addEventListener('mousedown', function () { botonActualizar.style.transform = 'scale(0.97)'; });
    botonActualizar.addEventListener('mouseup', function () { botonActualizar.style.transform = 'scale(1)'; });
    botonActualizar.addEventListener('click', function () {
      // "Actualizar" siempre vuelve al modo en vivo -- si el usuario venia de
      // revisar un rango historico con "Filtrar fechas", este boton es la
      // forma explicita de decir "ya termine, quiero ver lo actual otra vez".
      modoHistorico = false;
      refrescarDatos();
    });

    // Boton secundario: respeta las fechas que el usuario haya escrito a mano
    // en los campos Desde/Hasta, sin pisarlas con "ultima hora" -- para
    // revisar un rango historico especifico (ej. varios dias atras). Activa
    // el modo historico, asi el refresco automatico y "Actualizar" no se lo
    // pisan solos mientras lo esta revisando (ver modoHistorico).
    var botonFiltrar = crear('button', {
      alignSelf: 'flex-end',
      padding: '9px 18px',
      background: T.color.surface,
      color: T.color.primaryDark,
      border: '1px solid ' + T.color.primary,
      borderRadius: T.radius.sm,
      fontWeight: '700',
      fontSize: '0.85rem',
      cursor: 'pointer',
      transition: 'background 0.15s ease, transform 0.1s ease'
    }, 'Filtrar fechas');
    botonFiltrar.addEventListener('mouseenter', function () { botonFiltrar.style.background = T.color.primarySoft; });
    botonFiltrar.addEventListener('mouseleave', function () { botonFiltrar.style.background = T.color.surface; });
    botonFiltrar.addEventListener('mousedown', function () { botonFiltrar.style.transform = 'scale(0.97)'; });
    botonFiltrar.addEventListener('mouseup', function () { botonFiltrar.style.transform = 'scale(1)'; });
    botonFiltrar.addEventListener('click', function () {
      modoHistorico = true;
      guardarRango(campoDesde.input.value, campoHasta.input.value);
      cargarYRenderizar(new Date(campoDesde.input.value), new Date(campoHasta.input.value));
    });

    var filaFiltros = crear('div', { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-end' });
    filaFiltros.appendChild(campoDesde.envoltorio);
    filaFiltros.appendChild(campoHasta.envoltorio);
    filaFiltros.appendChild(botonFiltrar);
    filaFiltros.appendChild(botonActualizar);

    encabezado.appendChild(filaTitulo);
    encabezado.appendChild(filaFiltros);
    contenedor.appendChild(encabezado);

    return {
      inputDesde: campoDesde.input, inputHasta: campoHasta.input,
      botonActualizar: botonActualizar, botonFiltrar: botonFiltrar
    };
  }

  function construirTarjetaKpi(simbolo, valor, etiqueta) {
    var tarjeta = crearPanel({
      padding: '16px 18px',
      flex: '1',
      minWidth: '170px',
      display: 'flex',
      alignItems: 'center',
      gap: '14px',
      transition: 'box-shadow 0.15s ease, transform 0.15s ease',
      cursor: 'default'
    });
    tarjeta.appendChild(crearChip(simbolo, T.color.primarySoft, T.color.primaryDark, '40px'));

    var bloqueTexto = crear('div');
    bloqueTexto.appendChild(crear('div', {
      fontSize: '1.7rem', fontWeight: '800', color: T.color.ink,
      fontVariantNumeric: 'tabular-nums', lineHeight: '1.1'
    }, valor));
    bloqueTexto.appendChild(crear('div', {
      fontSize: '0.75rem', color: T.color.body, fontWeight: '600', marginTop: '2px'
    }, etiqueta));
    tarjeta.appendChild(bloqueTexto);

    tarjeta.addEventListener('mouseenter', function () {
      tarjeta.style.boxShadow = T.shadow.hover;
      tarjeta.style.transform = 'translateY(-1px)';
    });
    tarjeta.addEventListener('mouseleave', function () {
      tarjeta.style.boxShadow = T.shadow.card;
      tarjeta.style.transform = 'translateY(0)';
    });
    return tarjeta;
  }

  function formatearFechaHora(d) {
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // Segundos en vez de "0.5 min" cuando el evento dura menos de 1 min -- un
  // evento de 33s mostrado como "0.5 min" obliga a hacer la cuenta al reves
  // para saber si fue algo breve o si en realidad duro medio minuto largo.
  function formatearDuracion(segundos) {
    if (segundos < 60) return Math.round(segundos) + ' s';
    return (segundos / 60).toFixed(1) + ' min';
  }

  // Para sumas de MUCHOS eventos (horas totales), "min" solo se vuelve
  // ilegible -- "Xh Ymin" es el mismo patron ya usado en los otros dashboards
  // del proyecto para totales acumulados.
  function formatearDuracionTotal(segundos) {
    var minTotal = Math.round(segundos / 60);
    var h = Math.floor(minTotal / 60);
    var m = minTotal % 60;
    return h > 0 ? (h + 'h ' + m + 'min') : (m + ' min');
  }

  function formatearHora(d) {
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // columnas: [{ etiqueta, alineacion, clave (para ordenar, opcional) }]
  // filas: array de eventos (objetos completos, no arreglos de texto) -- asi
  // la tabla puede construir la fila de detalle expandible por si misma.
  function construirTabla(columnas, filasEventos, extraerCelda, onClicEncabezado) {
    var envoltorio = crear('div', { overflowX: 'auto' });
    var tabla = crear('table', { width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem' });
    var encabezado = crear('thead');
    var filaEncabezado = crear('tr');

    filaEncabezado.appendChild(crear('th', {
      width: '32px', padding: '10px 8px', borderBottom: '1px solid ' + T.color.border, background: T.color.canvas
    }, ''));

    columnas.forEach(function (col) {
      var esOrdenable = !!col.clave;
      var activo = ordenEstado.columna === col.clave;
      var th = crear('th', {
        textAlign: col.alineacion || 'left', padding: '10px 14px', borderBottom: '1px solid ' + T.color.border,
        background: T.color.canvas,
        color: activo ? T.color.primaryDark : T.color.muted, fontWeight: '700', fontSize: '0.7rem',
        textTransform: 'uppercase', letterSpacing: '0.05em',
        cursor: esOrdenable ? 'pointer' : 'default', userSelect: 'none'
      });
      var flecha = activo ? (ordenEstado.direccion === 'asc' ? ' ▲' : ' ▼') : '';
      th.textContent = col.etiqueta + flecha;
      if (esOrdenable) {
        th.addEventListener('click', function () {
          if (ordenEstado.columna === col.clave) {
            ordenEstado.direccion = ordenEstado.direccion === 'asc' ? 'desc' : 'asc';
          } else {
            ordenEstado.columna = col.clave;
            ordenEstado.direccion = 'desc';
          }
          onClicEncabezado();
        });
      }
      filaEncabezado.appendChild(th);
    });
    encabezado.appendChild(filaEncabezado);
    tabla.appendChild(encabezado);

    var cuerpo = crear('tbody');
    filasEventos.forEach(function (e) {
      var expandido = false;
      var tr = crear('tr', { background: T.color.surface, transition: 'background 0.1s ease', cursor: 'pointer' });
      var celdaCaret = crear('td', {
        padding: '10px 8px', borderBottom: '1px solid ' + T.color.border, color: T.color.muted,
        textAlign: 'center', fontSize: '0.7rem'
      }, '▸');
      tr.appendChild(celdaCaret);

      columnas.forEach(function (col) {
        tr.appendChild(crear('td', {
          padding: '10px 14px', borderBottom: '1px solid ' + T.color.border, color: T.color.ink,
          textAlign: col.alineacion || 'left',
          fontVariantNumeric: col.alineacion === 'right' ? 'tabular-nums' : 'normal'
        }, extraerCelda(e, col.clave)));
      });

      var trDetalle = crear('tr', { background: T.color.rowHover, display: 'none' });
      var tdDetalle = crear('td', { padding: '10px 16px 14px 40px', borderBottom: '1px solid ' + T.color.border, color: T.color.body, fontSize: '0.8rem' });
      tdDetalle.setAttribute('colspan', String(columnas.length + 1));
      tdDetalle.appendChild(crear('div', { marginBottom: '3px' }, 'Motor: ' + e.referenciaMotor + ' (' + e.marca + ')'));
      tdDetalle.appendChild(crear('div', {}, formatearDeltaPto(e)));
      trDetalle.appendChild(tdDetalle);

      function alternarDetalle() {
        expandido = !expandido;
        celdaCaret.textContent = expandido ? '▾' : '▸';
        trDetalle.style.display = expandido ? 'table-row' : 'none';
      }
      tr.addEventListener('click', alternarDetalle);

      tr.addEventListener('mouseenter', function () { tr.style.background = T.color.rowHover; });
      tr.addEventListener('mouseleave', function () { tr.style.background = T.color.surface; });

      cuerpo.appendChild(tr);
      cuerpo.appendChild(trDetalle);
    });
    tabla.appendChild(cuerpo);
    envoltorio.appendChild(tabla);
    return envoltorio;
  }

  var barraFiltrosRefs = null;

  function renderizarResultados(contenedor, eventosCompletos) {
    while (contenedor.firstChild) contenedor.removeChild(contenedor.firstChild);

    var eventos = ordenarEventos(aplicarFiltros(eventosCompletos));

    if (eventosCompletos.length === 0) {
      var envoltorioVacio = crear('div', { padding: '22px' });
      var panelVacio = crearPanel({
        padding: '36px 24px', textAlign: 'center', display: 'flex',
        flexDirection: 'column', alignItems: 'center', gap: '10px'
      });
      panelVacio.appendChild(crearChip('✅', T.color.primarySoft, T.color.primaryDark, '44px'));
      panelVacio.appendChild(crear('div', { color: T.color.ink, fontWeight: '700', fontSize: '0.95rem' }, 'Todo en orden'));
      panelVacio.appendChild(crear('div', { color: T.color.body, fontSize: '0.85rem', maxWidth: '360px' },
        'No hay eventos de sobre-revolución con PTO confirmado en el periodo seleccionado.'));
      envoltorioVacio.appendChild(panelVacio);
      contenedor.appendChild(envoltorioVacio);
      return;
    }

    if (eventos.length === 0) {
      var envoltorioSinResultados = crear('div', { padding: '22px' });
      var panelSinResultados = crearPanel({
        padding: '30px 24px', textAlign: 'center', display: 'flex',
        flexDirection: 'column', alignItems: 'center', gap: '10px'
      });
      panelSinResultados.appendChild(crearChip('🔍', T.color.primarySoft, T.color.primaryDark, '40px'));
      panelSinResultados.appendChild(crear('div', { color: T.color.ink, fontWeight: '700', fontSize: '0.9rem' }, 'Sin resultados con estos filtros'));
      panelSinResultados.appendChild(crear('div', { color: T.color.body, fontSize: '0.83rem' }, 'Prueba ajustando la búsqueda, el turno o el RPM mínimo.'));
      envoltorioSinResultados.appendChild(panelSinResultados);
      contenedor.appendChild(envoltorioSinResultados);
      return;
    }

    var vehiculosUnicos = {};
    var rpmMax = null;
    var duracionTotalSeg = 0;
    eventos.forEach(function (e) {
      vehiculosUnicos[e.idVehiculo] = true;
      if (e.rpmPico !== null && (rpmMax === null || e.rpmPico > rpmMax)) rpmMax = e.rpmPico;
      duracionTotalSeg += e.duracionSeg || 0;
    });

    // CAMBIO: se adelanta el conteo por vehiculo (antes vivia despues de la
    // fila de KPIs) porque ahora el KPI de "vehiculo mas reincidente" tambien
    // lo necesita -- una sola fuente de verdad para el Top 5 y para el KPI,
    // nunca dos calculos separados que puedan desalinearse.
    var conteoPorVehiculo = {};
    eventos.forEach(function (e) {
      conteoPorVehiculo[e.claveVehiculo] = (conteoPorVehiculo[e.claveVehiculo] || 0) + 1;
    });
    var top5 = Object.keys(conteoPorVehiculo)
      .map(function (k) { return { nombre: k, eventos: conteoPorVehiculo[k] }; })
      .sort(function (a, b) { return b.eventos - a.eventos; })
      .slice(0, 5);

    var filaKpis = crear('div', { display: 'flex', gap: '14px', padding: '4px 22px 0 22px', flexWrap: 'wrap' });
    filaKpis.appendChild(construirTarjetaKpi('🚚', Object.keys(vehiculosUnicos).length, 'Vehículos involucrados'));
    filaKpis.appendChild(construirTarjetaKpi('📋', eventos.length, hayFiltrosActivos() ? 'Eventos (filtrados)' : 'Eventos con PTO confirmado'));
    filaKpis.appendChild(construirTarjetaKpi('⚡', rpmMax !== null ? rpmMax.toFixed(0) : 'N/D', 'RPM máximo registrado'));
    filaKpis.appendChild(construirTarjetaKpi('⏱️', formatearDuracionTotal(duracionTotalSeg), 'Tiempo total en sobre-revolución'));
    if (top5.length > 0) {
      filaKpis.appendChild(construirTarjetaKpi('🔁', top5[0].nombre + ' (' + top5[0].eventos + ')', 'Vehículo más reincidente'));
    }
    contenedor.appendChild(filaKpis);

    // --- Top 5 vehiculos con mas eventos + grafica interactiva ---

    var seccionTop = crear('div', { padding: '20px 22px 0 22px' });
    var panelTop = crearPanel({ padding: '18px' });
    var filaTituloTop = crear('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center' });
    filaTituloTop.appendChild(crearEtiquetaSeccion('🔝', 'Top 5 — más eventos con PTO accionado'));
    filaTituloTop.appendChild(crear('span', { fontSize: '0.72rem', color: T.color.muted }, 'Clic en una barra para filtrar'));
    panelTop.appendChild(filaTituloTop);
    var canvasTop = crear('canvas', { maxHeight: '210px' });
    panelTop.appendChild(canvasTop);
    seccionTop.appendChild(panelTop);
    contenedor.appendChild(seccionTop);

    if (chartTopVehiculos) chartTopVehiculos.destroy();
    chartTopVehiculos = new Chart(canvasTop.getContext('2d'), {
      type: 'bar',
      data: {
        labels: top5.map(function (f) { return f.nombre; }),
        datasets: [{
          label: 'Eventos con PTO',
          data: top5.map(function (f) { return f.eventos; }),
          backgroundColor: top5.map(function (f) {
            return f.nombre === filtroEstado.vehiculo ? T.color.primaryDark : T.color.primary;
          }),
          borderRadius: 4,
          barThickness: 18
        }]
      },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        onHover: function (evt, elementos) { evt.native.target.style.cursor = elementos.length ? 'pointer' : 'default'; },
        onClick: function (evt, elementos) {
          if (!elementos.length) return;
          var nombre = top5[elementos[0].index].nombre;
          filtroEstado.vehiculo = (filtroEstado.vehiculo === nombre) ? null : nombre;
          if (filtroEstado.vehiculo) barraFiltrosRefs.mostrarChipVehiculo(nombre);
          else barraFiltrosRefs.ocultarChipVehiculo();
          renderizarResultados(contenedor, eventosCompletos);
        },
        plugins: { legend: { display: false } },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { precision: 0, color: T.color.muted, font: { size: 11 } },
            grid: { color: T.color.border }
          },
          y: {
            ticks: { color: T.color.body, font: { size: 11 } },
            grid: { display: false }
          }
        }
      }
    });

    // --- Tabla de detalle, ordenable y con filas expandibles ---
    var seccionDetalle = crear('div', { padding: '20px 22px 22px 22px' });
    var panelDetalle = crearPanel({ padding: '18px', overflow: 'hidden' });
    panelDetalle.appendChild(crearEtiquetaSeccion('📄', 'Detalle de eventos (clic en una fila para ver el cruce con PTO)'));

    var columnasTabla = [
      { etiqueta: 'Móvil', alineacion: 'left', clave: 'movil' },
      { etiqueta: 'Placa', alineacion: 'left', clave: 'placa' },
      { etiqueta: 'Ciudad', alineacion: 'left', clave: 'ciudad' },
      { etiqueta: 'Marca', alineacion: 'left', clave: 'marca' },
      { etiqueta: 'Tipología', alineacion: 'left', clave: 'tipologia' },
      { etiqueta: 'Turno', alineacion: 'left', clave: 'turno' },
      { etiqueta: 'Fecha/Hora', alineacion: 'left', clave: 'fecha' },
      { etiqueta: 'Duración', alineacion: 'right', clave: 'duracion' },
      { etiqueta: 'RPM Pico', alineacion: 'right', clave: 'rpm' },
      { etiqueta: 'Conductor', alineacion: 'left', clave: null }
    ];

    panelDetalle.appendChild(construirTabla(
      columnasTabla,
      eventos,
      function (e, clave) {
        switch (clave) {
          case 'movil': return e.nombreVehiculo;
          case 'placa': return e.placa || '—';
          case 'ciudad': return e.ciudad;
          case 'marca': return e.marca;
          case 'tipologia': return e.tipologia;
          case 'turno': return e.turno;
          case 'fecha': return formatearFechaHora(e.activeFrom);
          case 'duracion': return formatearDuracion(e.duracionSeg);
          case 'rpm': return e.rpmPico !== null ? e.rpmPico.toFixed(0) : 'N/D';
          default: {
            var partes = codigoYPlacaDeNombre(e.nombreVehiculo);
            var resultado = buscarConductor(e.placa || partes.placa, partes.codigo, e.activeFrom);
            return textoConductorConGrupo(resultado);
          }
        }
      },
      function () { renderizarResultados(contenedor, eventosCompletos); }
    ));
    seccionDetalle.appendChild(panelDetalle);
    contenedor.appendChild(seccionDetalle);
  }

  function mostrarError(contenedor, mensaje) {
    while (contenedor.firstChild) contenedor.removeChild(contenedor.firstChild);
    var envoltorio = crear('div', { padding: '22px' });
    var panel = crear('div', {
      display: 'flex', alignItems: 'flex-start', gap: '12px',
      padding: '16px 18px', background: T.color.dangerSoft, color: T.color.danger,
      borderRadius: T.radius.md, border: '1px solid ' + T.color.dangerBorder
    });
    panel.appendChild(crear('div', { fontSize: '1.1rem', lineHeight: '1' }, '⚠️'));
    var textoBloque = crear('div');
    textoBloque.appendChild(crear('div', { fontWeight: '700', fontSize: '0.85rem', marginBottom: '2px' }, 'No se pudo cargar la información'));
    textoBloque.appendChild(crear('div', { fontSize: '0.82rem' }, mensaje));
    panel.appendChild(textoBloque);
    envoltorio.appendChild(panel);
    contenedor.appendChild(envoltorio);
  }

  function mostrarCargando(contenedor) {
    while (contenedor.firstChild) contenedor.removeChild(contenedor.firstChild);
    var envoltorio = crear('div', { padding: '40px 22px', textAlign: 'center' });
    envoltorio.appendChild(crear('div', { fontSize: '0.85rem', color: T.color.body, fontWeight: '600' }, 'Cargando eventos…'));
    contenedor.appendChild(envoltorio);
  }

  // Deshabilita "Actualizar"/"Filtrar fechas" mientras hay una carga en
  // vuelo -- refuerzo visual del candado cargaEnCurso: sin esto el usuario
  // ve la pantalla pegada en "Cargando eventos..." y sigue haciendo click,
  // sin saber que cada click ya no dispara nada nuevo (silenciosamente
  // ignorado por el candado) porque no hay ninguna señal de que el boton
  // este ocupado.
  function deshabilitarBotonesCarga() {
    [elementos.botonActualizar, elementos.botonFiltrar].forEach(function (boton) {
      if (!boton) return;
      boton.disabled = true;
      boton.style.opacity = '0.55';
      boton.style.cursor = 'not-allowed';
    });
  }

  function habilitarBotonesCarga() {
    [elementos.botonActualizar, elementos.botonFiltrar].forEach(function (boton) {
      if (!boton) return;
      boton.disabled = false;
      boton.style.opacity = '1';
      boton.style.cursor = 'pointer';
    });
  }

  var contenedorPrincipal = null;
  var contenedorResultados = null;

  var INTERVALO_AUTO_REFRESCO_MS = 10 * 60 * 1000; // 10 minutos
  var idIntervaloAutoRefresco = null;

  // Candado contra solicitudes superpuestas: sin esto, un click de "Actualizar"
  // mientras el refresco automatico (o un click anterior) ya esta en vuelo
  // dispara un SEGUNDO pipeline completo en paralelo -- y cada pipeline hace
  // un multiCall de PTO y otro de RPM con una sub-llamada POR VEHICULO con
  // eventos en el rango (fueron 50+ vehiculos en pruebas). Varias de esas
  // tandas encimadas es lo que estaba saturando la sesion y produciendo
  // errores "ServerStopped" repetidos, visibles como "Cargando eventos..."
  // pegado (bug real reportado 2026-09-15). Mientras haya una carga en vuelo,
  // las demas se ignoran en vez de sumarse.
  var cargaEnCurso = false;

  // true cuando el usuario fijo un rango a mano con "Filtrar fechas" para
  // revisar un evento historico especifico -- mientras este en true, nadie
  // (ni el refresco automatico ni "Actualizar") le toca las fechas, mismo
  // criterio que corrigio el bug real reportado 2026-09-11 (ver abajo). En
  // false (modo por defecto) el rango es "en vivo": rueda hacia adelante
  // hasta el momento actual en cada refresco, en vez de quedar congelado en
  // lo que decia la pantalla cuando se abrio el addin (bug real reportado
  // 2026-09-15: "Actualizar" funcionaba pero la fecha/hora nunca avanzaba).
  var modoHistorico = false;

  // Refresca los datos. Dos modos, ver modoHistorico:
  //  - Modo historico (el usuario uso "Filtrar fechas"): usa el rango que YA
  //    esta en pantalla tal cual, sin tocarlo -- si esto se rompe, 5 min
  //    despues de filtrar un rango especifico la pantalla vuelve sola a
  //    "ahora" y el usuario lo ve como "se me quito el filtro" (bug real
  //    2026-09-11).
  //  - Modo en vivo (por defecto): recalcula el rango a las ultimas
  //    VENTANA_LIVE_HORAS terminando AHORA, actualiza los campos Desde/Hasta
  //    en pantalla para que se vea que avanzaron, y lo guarda -- si esto se
  //    rompe, "Actualizar" sigue funcionando pero la fecha/hora se queda
  //    congelada en lo que decia al abrir el addin (bug real 2026-09-15).
  // La llaman el refresco automatico de 10 min (via refrescoAutomatico, si
  // no hay filtro fino bloqueando), el boton "Actualizar" y el focus() al
  // volver a esta pagina.
  function refrescarDatos() {
    var desde, hasta;
    if (modoHistorico) {
      desde = new Date(elementos.inputDesde.value);
      hasta = new Date(elementos.inputHasta.value);
    } else {
      var rango = rangoLiveActual();
      elementos.inputDesde.value = rango.desde;
      elementos.inputHasta.value = rango.hasta;
      guardarRango(rango.desde, rango.hasta);
      desde = new Date(rango.desde);
      hasta = new Date(rango.hasta);
    }
    cargarYRenderizar(desde, hasta, true);
  }

  // Usada por el temporizador y por el regreso de visibilidad -- a diferencia
  // del boton "Actualizar" (que siempre refresca porque el usuario lo pidio a
  // proposito), esta NO debe pisar un analisis en curso: si hay un filtro fino
  // activo (texto, turno, vehiculo o piso de RPM) se salta el refetch y espera
  // al siguiente tick. El filtro de ciudad no cuenta, ver hayFiltrosQueBloqueanAutoRefresco.
  function refrescoAutomatico() {
    if (hayFiltrosQueBloqueanAutoRefresco()) return;
    refrescarDatos();
  }

  // Referencia nombrada (no una funcion anonima) para poder quitar el mismo
  // listener en blur() -- ver comentario en focus().
  function manejarCambioVisibilidad() {
    if (document.visibilityState === 'visible') refrescoAutomatico();
  }

  function cargarYRenderizar(desde, hasta, conservarFiltroVehiculo) {
    // Si ya hay una carga en vuelo, esta se ignora en vez de apilarse encima
    // -- ver comentario junto a la declaracion de cargaEnCurso. El boton
    // Actualizar/Filtrar fechas tambien queda deshabilitado mientras tanto,
    // asi que un click repetido por impaciencia no vuelve a disparar esto.
    if (cargaEnCurso) return;
    cargaEnCurso = true;
    deshabilitarBotonesCarga();

    mostrarCargando(contenedorResultados);
    // El refresco automatico cada 10 min y el boton "Actualizar" solo traen datos
    // nuevos del MISMO vehiculo que ya se estaba mirando -- no tiene sentido
    // quitarle el filtro al usuario en medio de su analisis. Cuando el usuario
    // cambia el RANGO DE FECHAS a mano (boton "Filtrar fechas") si se resetea,
    // porque ahi el contexto realmente cambio.
    if (!conservarFiltroVehiculo) {
      filtroEstado.vehiculo = null;
      if (barraFiltrosRefs) barraFiltrosRefs.ocultarChipVehiculo();
    }
    obtenerIdRegla()
      .then(function (idRegla) { return obtenerEventosCandidatos(idRegla, desde, hasta); })
      .then(confirmarPtoCercano)
      .then(agregarPicoRpm)
      .then(resolverVehiculos)
      .then(filtrarPorUmbralMercedes)
      .then(function (eventos) {
        eventosCache = eventos;
        var ciudadesDisponibles = Array.from(new Set(eventos.map(function (e) { return e.ciudad; }))).sort();
        barraFiltrosRefs.actualizarOpcionesCiudad(ciudadesDisponibles);
        renderizarResultados(contenedorResultados, eventosCache);
      })
      .catch(function (err) {
        console.error('Sobre-Revolución PTO:', err);
        mostrarError(contenedorResultados, (err && err.message) ? err.message : 'Error al consultar Geotab.');
      })
      .then(function () {
        cargaEnCurso = false;
        habilitarBotonesCarga();
      });
  }

  function actualizarVista() {
    renderizarResultados(contenedorResultados, eventosCache);
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi;
      state = freshState;

      contenedorPrincipal = document.getElementById('sobreRevolucionPTORoot');
      aplicarEstilo(contenedorPrincipal, { fontFamily: T.font, background: T.color.canvas });

      var refs = construirEncabezado(contenedorPrincipal);
      elementos.inputDesde = refs.inputDesde;
      elementos.inputHasta = refs.inputHasta;
      elementos.botonActualizar = refs.botonActualizar;
      elementos.botonFiltrar = refs.botonFiltrar;

      cargarTripulacionesGuardadas();
      construirControlTripulaciones(contenedorPrincipal, actualizarVista);

      barraFiltrosRefs = construirBarraFiltros(contenedorPrincipal, actualizarVista);

      contenedorResultados = crear('div');
      contenedorPrincipal.appendChild(contenedorResultados);

      initializedCallback();
    },

    focus: function (freshApi, freshState) {
      api = freshApi;
      state = freshState;

      // Arranca el refresco automatico cada 10 min mientras la pagina esta
      // activa -- pero solo si el usuario no esta con un filtro fino puesto
      // (ver refrescoAutomatico/hayFiltrosQueBloqueanAutoRefresco), para no
      // pisarle el analisis en curso. Se limpia primero por si focus() se
      // llama varias veces sin un blur() de por medio (evita duplicar el
      // intervalo).
      if (idIntervaloAutoRefresco) clearInterval(idIntervaloAutoRefresco);
      idIntervaloAutoRefresco = setInterval(refrescoAutomatico, INTERVALO_AUTO_REFRESCO_MS);

      // CAMBIO (bug real 2026-09-14): los navegadores retrasan/pausan los
      // setInterval de pestañas en segundo plano (ahorro de batería/memoria)
      // -- si el usuario deja esta pestaña abierta pero minimizada o detrás
      // de otra, el temporizador de 10 min puede no dispararse a tiempo, y
      // pasar mucho más de eso sin datos frescos aunque el código esté bien.
      // Este listener refuerza eso: en cuanto la pestaña vuelve a ser
      // visible, refresca al instante (si no hay filtro fino bloqueando),
      // sin esperar al próximo tick del temporizador que pudo haber quedado
      // pausado.
      document.addEventListener('visibilitychange', manejarCambioVisibilidad);

      refrescarDatos();
    },

    blur: function () {
      // Se detiene el refresco automatico cuando el usuario sale de esta
      // pagina dentro de Geotab, para no seguir consultando la API en segundo
      // plano sin que nadie este viendo los datos.
      if (idIntervaloAutoRefresco) {
        clearInterval(idIntervaloAutoRefresco);
        idIntervaloAutoRefresco = null;
      }
      document.removeEventListener('visibilitychange', manejarCambioVisibilidad);
    }
  };
};
