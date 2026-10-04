/* ============================================================================
   Add-In: Alertas por Severidad
   Puerto a JavaScript del MISMO diseño ya validado con el usuario para el PDF
   de fallas activas de telegram_alertas.py (generar_pdf_reporte_fallas,
   _categorizar_falla, CATEGORIAS_SISTEMA) -- no de la pestaña "alertas" de
   app.py (esa version, con freeze-frame RPM/temp/odometro/velocidad y
   localidad por GPS, se probo primero pero el usuario pidio alinear el add-in
   al diseño de tarjetas que ya usa el bot de Telegram, mas simple).

   Categorizacion: por palabras clave en el NOMBRE del diagnostico que da
   Geotab (CATEGORIAS_SISTEMA/_categorizar_falla) -- NO usa
   Diccionario_Fallas.csv ni SPN/FMI para esto, a proposito, igual que
   telegram_alertas.py. Se ocultan fallas de conectividad/telemetria
   (CATEGORIAS_OCULTAS_PDF) y se resaltan en rojo negrita las de sistemas
   criticos (ABS, Neumaticos, Postratamiento/Escape, Motor).

   Estilo: Geotab elimina los <style> tags del HTML, asi que todo el CSS se
   aplica programaticamente via element.style.* (CSSOM), igual que en
   sobreRevolucionPTO.js.
   ============================================================================ */

geotab.addin.alertasFallas = function () {
  'use strict';

  // --- Constantes ------------------------------------------------------------
  var CLAVE_LOCALSTORAGE = 'alertasFallas_rango';
  var CLAVE_LOCALSTORAGE_ALARMA = 'alertasFallas_alarmadas';
  var INTERVALO_AUTO_REFRESCO_MS = 5 * 60 * 1000; // 5 minutos, igual que el add-in de PTO
  var NIVELES_ALARMA = { ALTA: true, MEDIA: true }; // BAJA no dispara alarma sonora

  // "Activas ahora" necesita mirar bastante mas atras que el rango que el usuario
  // ve en pantalla -- un codigo puede seguir activo aunque su ultimo dato haya
  // llegado ayer (sin registro nuevo hoy). Mismo criterio que VENTANA_FALLAS_DIAS
  // en telegram_alertas.py: 30 dias de respaldo, independiente de que "Desde" diga "hoy".
  var VENTANA_FALLAS_DIAS = 30;
  // Tope real que devuelve Get FaultData por llamada -- si el rango pedido tiene mas
  // registros que esto, la respuesta se corta ahi, ORDENADA POR dateTime ASCENDENTE,
  // asi que sin paginar te quedas con los registros MAS VIEJOS y perdes en silencio
  // todo lo reciente (mismo bug real que ya se encontro y corrigio en
  // _obtener_faultdata_paginado de telegram_alertas.py).
  var LIMITE_PAGINA_FAULTDATA = 50000;

  var REFERENCIA_MOTOR_POR_MARCA = {
    'volkswagen': 'ISF 3.8', 'volskwagen': 'ISF 3.8', 'mercedes': 'OM926',
    'international': 'L9', 'foton': 'X12', 'kenworth': 'ISM 11',
    // CAMBIO (2026-10-03, auditoría): sin 'chevrolet' los furgones NHR y la
    // van N400 (grupos 'CHEVROLET - NHR', 'CHEVROLET VAN - N400') salían como
    // "Sin marca". El motor de cada modelo es distinto y no está confirmado,
    // así que se declara así en vez de inventar una referencia.
    'chevrolet': 'Sin confirmar'
  };
  var NOMBRE_GRUPO_TIPOLOGIA = 'tipologia';

  // Mismos valores que ORDEN_CRITICIDAD / COLOR_POR_CRITICIDAD / COLOR_DESTACADO
  // en telegram_alertas.py -- consistencia total con el PDF que ya se manda por Telegram.
  var ORDEN_CRITICIDAD = { ALTA: 3, MEDIA: 2, BAJA: 1 };
  var COLOR_POR_CRITICIDAD = { ALTA: '#EF4444', MEDIA: '#F59E0B', BAJA: '#9CA3AF' };
  var COLOR_DESTACADO = '#C00000';
  var CATEGORIAS_DESTACADAS = { 'ABS': true, 'Neumáticos': true, 'Postratamiento/Escape': true, 'Motor': true };
  var CATEGORIAS_OCULTAS = { 'Telemática/GPS': true, 'General': true };

  // Paleta categoría -> color, SOLO para los marcadores/leyenda del mapa del
  // Expediente Consolidado (ver ensamblarYDescargarExpedienteConsolidado más
  // abajo) -- paleta pedida explícitamente por el usuario, no reusa
  // COLOR_POR_CRITICIDAD/COLOR_DESTACADO porque esos codifican criticidad, no
  // sistema/categoría.
  var COLOR_CATEGORIA_MAPA = {
    'ABS': '#0ea5e9', 'Neumáticos': '#78716c', 'Frenos': '#dc2626',
    'Postratamiento/Escape': '#16a34a', 'Motor': '#ea580c', 'Transmisión': '#7c3aed',
    'Eje/Suspensión': '#0891b2', 'Eléctrico': '#eab308', 'HVAC': '#06b6d4',
    'Dirección': '#be185d', 'Telemática/GPS': '#64748b', 'General': '#94a3b8'
  };

  // Puerto exacto de CATEGORIAS_SISTEMA en telegram_alertas.py -- se evalua en
  // orden, la primera categoria que coincida gana (por eso las mas especificas
  // van antes que las generales).
  var CATEGORIAS_SISTEMA = [
    ['ABS', ['abs', 'sensor de rueda', 'válvula moduladora de presión', 'antibloqueo', 'velocidad de desvío']],
    ['Neumáticos', ['neumático', 'neumatico', 'llanta']],
    ['Frenos', ['freno', 'retardador']],
    ['Postratamiento/Escape', [
      'postratamiento', 'escape', 'scr', 'egr', 'recirculación de gases', 'recirculacion de gases',
      'partículas diésel', 'particulas diesel', 'nox', 'catalizador', 'liquido de escape', 'líquido de escape'
    ]],
    ['Motor', [
      'motor', 'aceite', 'refrigerante', 'cigüeñal', 'ciguenal', 'árbol de levas', 'arbol de levas',
      'inyector', 'cilindro', 'turbocompresor', 'combustible', 'admisión', 'admision', 'ralentí', 'ralenti',
      'acelerador'
    ]],
    ['Transmisión', ['transmisión', 'transmision', 'embrague', 'cambio de marcha', 'palanca de cambios', 'engranaje', 'divisor']],
    ['Eje/Suspensión', ['eje', 'diferencial', 'suspensión', 'suspension', 'inclinación', 'inclinacion']],
    ['Eléctrico', [
      'eléctrico', 'electrico', 'luz', 'lámpara', 'lampara', 'batería', 'bateria', 'voltaje', 'interruptor',
      'fusible', 'bocina', 'alarma', 'panel de instrumentos', 'ventana', 'seguro', 'espejo'
    ]],
    ['HVAC', ['hvac', 'aire acondicionado', 'climatiz', 'calefac']],
    ['Dirección', ['dirección', 'direccion', 'volante']],
    ['Telemática/GPS', ['telemático', 'telematico', 'gps', 'antena']]
  ];
  // Fallas del DISPOSITIVO Geotab (desconexion, bateria del dispositivo) suelen
  // mencionar "motor"/"batería"/"voltaje" de pasada -- se revisa esto ANTES que
  // el resto, igual que _PATRON_FALLA_DISPOSITIVO en telegram_alertas.py.
  var PATRON_FALLA_DISPOSITIVO = /\bfall[oa] (?:de|del) dispositivo\b/i;

  // --- Sistema de diseño: paleta con roles, no colores sueltos ---------------
  var T = {
    color: {
      primary: '#62A830',
      primaryDark: '#4C8323',
      primarySoft: '#EAF4E1',
      ink: '#0F1B3D',       // COLOR_HEADER_PDF
      body: '#475569',
      muted: '#94A3B8',
      surface: '#FFFFFF',
      canvas: '#F5F7FA',    // COLOR_FONDO_PDF
      border: '#E5E9F0',
      borderStrong: '#CBD5E1',
      danger: '#B91C1C',
      dangerSoft: '#FEF2F2',
      dangerBorder: '#FCA5A5',
      filtroFondo: '#E8F5E9',    // COLOR_FILTRO_FONDO_PDF
      filtroBorde: '#2E7D32',    // COLOR_FILTRO_BORDE_PDF
      resumenBorde: '#2563EB',   // COLOR_RESUMEN_BORDE_PDF
      vehiculoHeader: '#DCE3EC', // COLOR_VEHICULO_HEADER_PDF
      textoOscuro: '#1F2937',    // COLOR_TEXTO_OSCURO_PDF
      textoGris: '#6B7280'       // COLOR_TEXTO_GRIS_PDF
    },
    radius: { sm: '8px', md: '12px', lg: '16px', pill: '999px' },
    shadow: { card: '0 1px 2px rgba(15,23,42,0.04), 0 1px 10px rgba(15,23,42,0.05)' },
    font: "'Inter', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
  };

  var api = null;
  var state = null;
  var elementos = {};

  // --- Utilidades de estilo (CSSOM) ------------------------------------------
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

  function crearChip(simbolo, colorFondo, colorTexto, tamano) {
    var lado = tamano || '34px';
    return crear('div', {
      width: lado, height: lado, minWidth: lado,
      borderRadius: T.radius.sm, background: colorFondo, color: colorTexto,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: '1rem', fontWeight: '700'
    }, simbolo);
  }

  function crearPanel(estilosExtra) {
    var base = {
      background: T.color.surface, borderRadius: T.radius.md,
      border: '1px solid ' + T.color.border, boxShadow: T.shadow.card
    };
    for (var k in estilosExtra) { base[k] = estilosExtra[k]; }
    return crear('div', base);
  }

  // --- Utilidades de fecha ----------------------------------------------
  function aFechaInputValue(d) {
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function inicioDeHoy() {
    var ahora = new Date();
    return new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate(), 0, 0, 0, 0);
  }

  function cargarRangoGuardado() {
    try {
      var guardado = JSON.parse(localStorage.getItem(CLAVE_LOCALSTORAGE) || 'null');
      if (guardado && guardado.desde && guardado.hasta) return guardado;
    } catch (e) { /* ignorar, se usa el rango por defecto */ }
    return { desde: aFechaInputValue(inicioDeHoy()), hasta: aFechaInputValue(new Date()) };
  }

  function guardarRango(desde, hasta) {
    try { localStorage.setItem(CLAVE_LOCALSTORAGE, JSON.stringify({ desde: desde, hasta: hasta })); }
    catch (e) { /* localStorage no disponible, se sigue sin persistir */ }
  }

  // --- Envoltorios sobre la API de Geotab (callback -> Promise) -------------
  function apiCall(metodo, params) {
    return new Promise(function (resolve, reject) { api.call(metodo, params, resolve, reject); });
  }

  function apiMultiCall(llamadas) {
    if (llamadas.length === 0) return Promise.resolve([]);
    return new Promise(function (resolve, reject) { api.multiCall(llamadas, resolve, reject); });
  }

  // --- Jerarquia de grupos de Geotab -> ciudad y marca -----------------------
  // Puerto directo de obtener_mapa_grupos / resolver_marca en telegram_alertas.py,
  // mismo bloque que ya usa sobreRevolucionPTO.js.
  function esGrupoMarca(nombre) {
    var l = (nombre || '').trim().toLowerCase();
    return Object.keys(REFERENCIA_MOTOR_POR_MARCA).some(function (marca) { return l.indexOf(marca) !== -1; });
  }

  function referenciaMotorDeMarca(marca) {
    var l = (marca || '').toLowerCase();
    var claves = Object.keys(REFERENCIA_MOTOR_POR_MARCA);
    for (var i = 0; i < claves.length; i++) {
      if (l.indexOf(claves[i]) !== -1) return REFERENCIA_MOTOR_POR_MARCA[claves[i]];
    }
    return 'Desconocido';
  }

  var mapaGruposCache = null;

  function normalizarCiudad(nombre) {
    var n = (nombre || '').toUpperCase();
    if (n.indexOf('BOGOTA') !== -1 || n.indexOf('BOGOTÁ') !== -1) return 'Bogotá';
    if (n.indexOf('CALI') !== -1) return 'Cali';
    if (n.indexOf('VALLE') !== -1) return 'Valle';
    // CAMBIO (2026-10-01, bug real visto en campo: "ESTACIÓN DE TRANSFERENCIA
    // ZIPA" salía como "EstaciónN De Transferencia Zipa"): \b\w no reconoce
    // letras acentuadas como parte de una palabra (\w es solo ASCII en JS),
    // así que una tilde como la "ó" partía la palabra en dos para efectos del
    // regex y capitalizaba también la letra siguiente. capitalizar() (abajo)
    // ya resuelve esto bien dividiendo por espacios en vez de por \b -- se
    // reutiliza en vez de duplicar la lógica seguro/inseguro dos veces.
    return capitalizar(nombre);
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
          (hijoCompleto.children || []).forEach(function (sub) {
            var subId = idDe(sub);
            var subCompleto = porId[subId] || {};
            recorrer(subId, 'Sin ciudad asignada', (subCompleto.name || '').trim());
          });
        } else if (esGrupoMarca(nombre)) {
          recorrer(hijoId, 'Sin ciudad asignada', null);
        } else {
          recorrer(hijoId, normalizarCiudad(nombre), null);
        }
      });

      mapaGruposCache = mapa;
      return mapa;
    }).catch(function (e) {
      console.error('Alertas: no se pudo cargar la jerarquia de grupos:', e);
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
    return { marca: marca || 'Sin marca', ciudad: ciudad, tipologia: tipologia };
  }

  // --- Categorizacion de fallas por palabras clave (puerto de _categorizar_falla) ---
  function categorizarFalla(nombreDiagnostico) {
    var nombreL = (nombreDiagnostico || '').toLowerCase();
    if (PATRON_FALLA_DISPOSITIVO.test(nombreL)) return 'Telemática/GPS';
    for (var i = 0; i < CATEGORIAS_SISTEMA.length; i++) {
      var categoria = CATEGORIAS_SISTEMA[i][0];
      var palabras = CATEGORIAS_SISTEMA[i][1];
      for (var j = 0; j < palabras.length; j++) {
        var patron = new RegExp('\\b' + palabras[j].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
        if (patron.test(nombreL)) return categoria;
      }
    }
    return 'General';
  }

  // --- Catalogos Diagnostic / FailureMode -> nombre + codigo (SPN/FMI) ------
  var catalogosCache = null;

  function obtenerCatalogosDiagnosticos() {
    if (catalogosCache) return Promise.resolve(catalogosCache);
    return Promise.all([
      apiCall('Get', { typeName: 'Diagnostic' }),
      apiCall('Get', { typeName: 'FailureMode' })
    ]).then(function (resultados) {
      var dicDiag = {};
      (resultados[0] || []).forEach(function (d) {
        if (d && d.id) dicDiag[d.id] = { nombre: d.name || 'Diagnóstico desconocido', codigo: d.code };
      });
      var dicFm = {};
      (resultados[1] || []).forEach(function (fm) {
        if (fm && fm.id) dicFm[fm.id] = { nombre: fm.name || '', codigo: fm.code };
      });
      catalogosCache = { dicDiag: dicDiag, dicFm: dicFm };
      return catalogosCache;
    });
  }

  // --- FaultData -> fallas "activas" -----------------------------------------
  // Puerto de extraer_datos_completos / procesar_activas (app.py) y de
  // _obtener_fallas_activas (telegram_alertas.py): ultimo registro por
  // (vehiculo, diagnostico, modo de falla), excluyendo dismiss=true.
  function idDeRef(ref) { return (ref && ref.id) ? ref.id : ref; }

  // Todo el proyecto muestra horas en America/Bogota explicitamente (ver
  // ZONA_BOGOTA en app.py/telegram_alertas.py) en vez de confiar en la zona
  // horaria del equipo donde corre el navegador -- sin esto, el mismo dato
  // puede mostrar una hora distinta segun donde este abierto MyGeotab.
  function formatearFechaHora(fecha) {
    return fecha.toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  }

  // Trae TODOS los FaultData en [desde, hasta), pidiendo pagina por pagina hasta que
  // una vuelta devuelva menos de LIMITE_PAGINA_FAULTDATA. Cada vuelta arranca desde el
  // dateTime del ultimo registro de la vuelta anterior (el rango se solapa a proposito
  // para no perder registros que compartan ese mismo instante); se dedupea por 'id' de
  // FaultData al final. Puerto directo de _obtener_faultdata_paginado en telegram_alertas.py.
  function obtenerFaultDataPaginado(desde, hasta) {
    function pedirPagina(desdeActual, acumulado) {
      return apiCall('Get', {
        typeName: 'FaultData',
        search: { fromDate: desdeActual.toISOString(), toDate: hasta.toISOString() }
      }).then(function (pagina) {
        pagina = pagina || [];
        var todas = acumulado.concat(pagina);
        if (pagina.length < LIMITE_PAGINA_FAULTDATA) return todas;

        var ultimoDt = pagina.reduce(function (max, r) {
          var t = new Date(r.dateTime);
          return t > max ? t : max;
        }, desdeActual);
        if (ultimoDt <= desdeActual) return todas; // resguardo anti-loop-infinito
        return pedirPagina(ultimoDt, todas);
      });
    }

    return pedirPagina(desde, []).then(function (todas) {
      var vistos = {};
      var unicas = [];
      todas.forEach(function (r) {
        if (!vistos[r.id]) { vistos[r.id] = true; unicas.push(r); }
      });
      return unicas;
    });
  }

  function obtenerFallasActivas(desde, hasta) {
    // "Activas ahora" siempre mira al menos VENTANA_FALLAS_DIAS hacia atras,
    // sin importar que tan angosto sea el "Desde" que se ve en pantalla -- un
    // codigo activo cuyo ultimo dato llego hace dias (sin registro nuevo hoy)
    // igual debe aparecer. Si el usuario elige un rango MAS ancho que eso a
    // proposito, se respeta ese rango mas ancho.
    var minimoDesde = new Date(hasta.getTime() - VENTANA_FALLAS_DIAS * 24 * 60 * 60 * 1000);
    var desdeReal = desde < minimoDesde ? desde : minimoDesde;

    return obtenerFaultDataPaginado(desdeReal, hasta).then(function (registros) {
      var porClave = {};
      (registros || []).forEach(function (r) {
        if (!r.device || !r.dateTime) return;
        var clave = idDeRef(r.device) + '|' + idDeRef(r.diagnostic) + '|' + idDeRef(r.failureMode);
        var actual = porClave[clave];
        if (!actual || new Date(r.dateTime) > new Date(actual.dateTime)) porClave[clave] = r;
      });

      // Primero el registro MAS RECIENTE por clave (sin importar su faultState), y
      // RECIEN AHI se filtra por 'Active' -- mismo orden que _obtener_fallas_activas
      // en telegram_alertas.py. Si se filtrara por 'Active' antes de dedupear, un
      // codigo que ya se resolvio (su ultimo registro real es faultState=None) podia
      // seguir viendose "activo" mientras existiera, dentro del rango consultado,
      // CUALQUIER registro viejo en 'Active' -- confirmado con datos reales
      // (2026-09-10, vehiculo 1149-NWX185, SPN190): el ultimo registro era 'Inactivo'
      // pero como no se filtraba por faultState, igual aparecia en pantalla.
      var activas = [];
      Object.keys(porClave).forEach(function (clave) {
        var r = porClave[clave];
        if (r.dismiss === true) return;
        if (r.faultState !== 'Active') return;
        activas.push({
          idVehiculo: idDeRef(r.device),
          idDiagnostico: idDeRef(r.diagnostic),
          idFailureMode: idDeRef(r.failureMode),
          fecha: new Date(r.dateTime),
          redStopLamp: !!r.redStopLamp,
          amberWarningLamp: !!r.amberWarningLamp,
          protectWarningLamp: !!r.protectWarningLamp
        });
      });
      return activas;
    });
  }

  // --- Criticidad -- puerto exacto de clasificar_criticidad_geotab ---------
  function clasificarCriticidadEvento(f) {
    if (f.redStopLamp || f.protectWarningLamp) return 'ALTA';
    if (f.amberWarningLamp) return 'MEDIA';
    return 'BAJA';
  }

  // --- Turno operativo, mismos rangos horarios que clasificar_turno en
  // app.py/geotab_comun.py (prefijo T en vez de R, igual que el add-in de PTO). ---
  function clasificarTurno(hora) {
    if (hora >= 5 && hora < 13) return 'T1';
    if (hora >= 13 && hora < 21) return 'T2';
    return 'T3';
  }

  // --- Info de vehiculo (nombre/placa/ciudad/marca/motor) --------------------
  function agregarInfoVehiculo(fallasActivas) {
    var vehiculosUnicos = [];
    fallasActivas.forEach(function (f) {
      if (vehiculosUnicos.indexOf(f.idVehiculo) === -1) vehiculosUnicos.push(f.idVehiculo);
    });
    if (vehiculosUnicos.length === 0) return Promise.resolve(fallasActivas);

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
        var vin = (dev && dev.engineVehicleIdentificationNumber) || '';
        infoPorVehiculo[idVeh] = {
          nombre: dev ? (dev.name || idVeh) : idVeh,
          placa: dev ? (dev.licensePlate || '') : '',
          marca: mt.marca,
          ciudad: mt.ciudad,
          // CAMBIO (2026-10-01, Mini Expediente): mt.tipologia ya se resolvía
          // aquí mismo (resolverMarcaYTipologia) pero se descartaba -- se
          // guarda ahora porque el expediente necesita mostrarla, igual que
          // ya hacía la versión vieja en mantenimiento.js. Additive, no
          // cambia el comportamiento de ningún consumidor existente.
          tipologia: mt.tipologia,
          referenciaMotor: referenciaMotorDeMarca(mt.marca),
          nMotor: vin ? vin.slice(-6) : 'Sin registrar'
        };
      });

      fallasActivas.forEach(function (f) {
        var info = infoPorVehiculo[f.idVehiculo] || {
          nombre: f.idVehiculo, placa: '', marca: 'Sin marca',
          ciudad: 'Sin ciudad asignada', tipologia: 'Sin tipología asignada', referenciaMotor: 'Desconocido', nMotor: 'Sin registrar'
        };
        f.nombreVehiculo = info.nombre;
        f.placa = info.placa;
        f.marca = info.marca;
        f.ciudad = info.ciudad;
        f.tipologia = info.tipologia;
        f.referenciaMotor = info.referenciaMotor;
        f.nMotor = info.nMotor;
        f.claveVehiculo = info.nombre + (info.placa ? ' - ' + info.placa : '');
      });
      return fallasActivas;
    });
  }

  // --- Clasifica cada falla: criticidad + nombre + categoria de sistema -----
  function agregarClasificacion(fallasActivas) {
    return obtenerCatalogosDiagnosticos().then(function (catalogos) {
      fallasActivas.forEach(function (f) {
        var diagInfo = catalogos.dicDiag[f.idDiagnostico] || { nombre: 'Diagnóstico desconocido', codigo: null };
        var fmInfo = catalogos.dicFm[f.idFailureMode] || { nombre: '', codigo: null };
        f.criticidad = clasificarCriticidadEvento(f);
        f.spn = diagInfo.codigo || '?';
        f.fmi = fmInfo.codigo || '?';
        f.categoria = categorizarFalla(diagInfo.nombre);
        f.destacado = !!CATEGORIAS_DESTACADAS[f.categoria];
        f.nombreFalla = diagInfo.nombre + (fmInfo.nombre ? ' — ' + fmInfo.nombre : '');
        f.activo = true; // explicito: en este punto f ya paso el filtro faultState==='Active' de obtenerFallasActivas()
        f.turno = clasificarTurno(f.fecha.getHours());
      });
      return fallasActivas;
    });
  }

  // --- Agrupa por vehiculo, oculta categorias irrelevantes, ordena --------
  // Puerto exacto del bloque de armado de filas_reporte en
  // generar_pdf_reporte_fallas (telegram_alertas.py).
  function agruparPorVehiculo(fallasActivas) {
    var porVehiculo = {};
    fallasActivas.forEach(function (f) {
      if (!porVehiculo[f.idVehiculo]) porVehiculo[f.idVehiculo] = [];
      porVehiculo[f.idVehiculo].push(f);
    });

    var vehiculos = [];
    var totalOcultas = 0;
    Object.keys(porVehiculo).forEach(function (idVeh) {
      var items = porVehiculo[idVeh].filter(function (f) {
        if (!f.activo) return false; // descarta cualquier historico que no este activo ahora mismo
        if (CATEGORIAS_OCULTAS[f.categoria]) { totalOcultas++; return false; }
        return true;
      });
      if (items.length === 0) return; // este vehiculo solo tenia fallas de categorias ocultas

      items.sort(function (a, b) {
        var diff = (ORDEN_CRITICIDAD[b.criticidad] || 0) - (ORDEN_CRITICIDAD[a.criticidad] || 0);
        if (diff !== 0) return diff;
        return a.fecha - b.fecha; // mismo criterio que 'hora' ascendente en el PDF
      });

      vehiculos.push({
        idVehiculo: idVeh,
        claveVehiculo: items[0].claveVehiculo,
        marca: items[0].marca,
        ciudad: items[0].ciudad,
        referenciaMotor: items[0].referenciaMotor,
        nMotor: items[0].nMotor,
        criticidad: items[0].criticidad, // el mas critico queda primero tras el sort
        items: items
      });
    });

    vehiculos.sort(function (a, b) {
      var diff = (ORDEN_CRITICIDAD[b.criticidad] || 0) - (ORDEN_CRITICIDAD[a.criticidad] || 0);
      if (diff !== 0) return diff;
      return a.claveVehiculo.localeCompare(b.claveVehiculo);
    });

    return { vehiculos: vehiculos, totalOcultas: totalOcultas };
  }

  // --- Alarma sonora + banner para codigos nuevos (cualquier criticidad) -----
  // Semantica "ever notified" (append-only), igual criterio que las alertas de
  // flota de telegram_alertas.py (ver CLAUDE.md) -- evita que un codigo que
  // sigue activo dispare la alarma de nuevo en cada auto-refresco de 5 min.
  // Solo se re-alerta si de verdad desaparecio y volvio a aparecer (la clave
  // se libera cuando esa falla deja de estar en el resultado "activas").
  var esPrimerCargaAbsoluta = false;

  function cargarClavesAlertadas() {
    try {
      var guardado = JSON.parse(localStorage.getItem(CLAVE_LOCALSTORAGE_ALARMA) || 'null');
      if (guardado === null) { esPrimerCargaAbsoluta = true; return {}; }
      return guardado;
    } catch (e) { return {}; }
  }

  function guardarClavesAlertadas(mapa) {
    try { localStorage.setItem(CLAVE_LOCALSTORAGE_ALARMA, JSON.stringify(mapa)); }
    catch (e) { /* localStorage no disponible, se sigue sin persistir */ }
  }

  var clavesAlertadas = cargarClavesAlertadas();
  var audioCtx = null;

  // Sonido tipo sirena, con un tono DISTINTO segun criticidad para que se
  // puedan diferenciar sin mirar la pantalla: ALTA = onda cuadrada, tonos
  // agudos (900/650Hz), pulso rapido -- mas urgente/agresiva. MEDIA = onda
  // triangular, tonos mas graves (600/450Hz), pulso mas lento -- se nota pero
  // se distingue claramente de ALTA.
  var TONOS_ALARMA = {
    ALTA: { tipo: 'square', frecAlta: 900, frecBaja: 650, duracionPulso: 0.18, repeticiones: 6 },
    MEDIA: { tipo: 'triangle', frecAlta: 600, frecBaja: 450, duracionPulso: 0.3, repeticiones: 4 }
  };

  function reproducirAlarmaSonora(criticidad) {
    var tono = TONOS_ALARMA[criticidad] || TONOS_ALARMA.ALTA;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var ahora = audioCtx.currentTime;
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = tono.tipo;
      for (var i = 0; i < tono.repeticiones; i++) {
        osc.frequency.setValueAtTime(i % 2 === 0 ? tono.frecAlta : tono.frecBaja, ahora + i * tono.duracionPulso);
      }
      var duracionTotal = tono.repeticiones * tono.duracionPulso;
      gain.gain.setValueAtTime(0.3, ahora);
      gain.gain.setValueAtTime(0.0001, ahora + duracionTotal);
      osc.connect(gain); gain.connect(audioCtx.destination);
      osc.start(ahora);
      osc.stop(ahora + duracionTotal + 0.05);
    } catch (e) { console.error('Alertas: no se pudo reproducir el sonido de alarma:', e); }
  }

  // Repite la sirena cada 5 min hasta que el usuario cierre el banner (o hasta
  // un tope de repeticiones) -- para que un codigo MEDIA/ALTA nuevo no pase
  // desapercibido si nadie estaba mirando la pantalla justo cuando sono la
  // primera vez. Recuerda que criticidad sono para repetir el MISMO tono.
  var INTERVALO_REPETICION_ALARMA_MS = 5 * 60 * 1000;
  var TOPE_REPETICIONES_ALARMA = 6; // ~30 minutos insistiendo si no se revisa
  var intervaloRepeticionAlarma = null;

  function detenerRepeticionAlarma() {
    if (intervaloRepeticionAlarma) { clearInterval(intervaloRepeticionAlarma); intervaloRepeticionAlarma = null; }
  }

  function iniciarRepeticionAlarma(criticidad) {
    detenerRepeticionAlarma();
    var repeticionesRestantes = TOPE_REPETICIONES_ALARMA;
    intervaloRepeticionAlarma = setInterval(function () {
      var bannerVisible = elementos.bannerAlarma && elementos.bannerAlarma.style.display !== 'none';
      if (repeticionesRestantes <= 0 || !bannerVisible) { detenerRepeticionAlarma(); return; }
      reproducirAlarmaSonora(criticidad);
      repeticionesRestantes--;
    }, INTERVALO_REPETICION_ALARMA_MS);
  }

  function mostrarBannerAlarma(nuevos) {
    if (!elementos.bannerAlarma) return;
    var banner = elementos.bannerAlarma;
    while (banner.firstChild) banner.removeChild(banner.firstChild);

    var hayAlta = nuevos.some(function (it) { return it.criticidad === 'ALTA'; });
    aplicarEstilo(banner, {
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px',
      background: hayAlta ? T.color.dangerSoft : '#FFFBEB',
      border: '1px solid ' + (hayAlta ? T.color.dangerBorder : '#FDE68A'),
      borderRadius: T.radius.md, padding: '12px 16px', marginBottom: '16px'
    });

    var texto = crear('div', { fontSize: '0.85rem', color: T.color.textoOscuro });
    texto.appendChild(crear('div', { fontWeight: '700', marginBottom: '4px' },
      (hayAlta ? '🚨' : '⚠️') + ' ' + nuevos.length + ' código(s) nuevo(s)'));
    var detalle = crear('div', { color: T.color.body, fontSize: '0.8rem' });
    nuevos.slice(0, 5).forEach(function (it) {
      detalle.appendChild(crear('div', {}, '• ' + it.claveVehiculo + ' — ' + it.nombreFalla + ' (' + it.criticidad + ')'));
    });
    if (nuevos.length > 5) detalle.appendChild(crear('div', {}, '… y ' + (nuevos.length - 5) + ' más.'));
    texto.appendChild(detalle);
    banner.appendChild(texto);

    var botonCerrar = crear('button', {
      background: 'transparent', border: 'none', color: T.color.body, cursor: 'pointer',
      fontSize: '1rem', fontWeight: '700', lineHeight: '1'
    }, '×');
    botonCerrar.addEventListener('click', function () { banner.style.display = 'none'; detenerRepeticionAlarma(); });
    banner.appendChild(botonCerrar);

    banner.style.display = 'flex';
  }


  // Compara los items de esta corrida (segun NIVELES_ALARMA) contra clavesAlertadas: dispara
  // sonido+banner solo para los genuinamente nuevos, y libera del set cualquier
  // clave que ya no este activa (para que si se resuelve y vuelve a aparecer,
  // se vuelva a alertar -- no es un "ya se avisó una vez para siempre").
  function revisarAlarma(vehiculos) {
    var activasAhora = {};
    var candidatos = [];
    vehiculos.forEach(function (v) {
      v.items.forEach(function (it) {
        if (!NIVELES_ALARMA[it.criticidad]) return;
        var clave = it.idVehiculo + '|' + it.idDiagnostico + '|' + it.idFailureMode;
        activasAhora[clave] = true;
        if (!clavesAlertadas[clave]) candidatos.push({ clave: clave, item: it });
      });
    });

    if (esPrimerCargaAbsoluta) {
      // Primera vez que corre este add-in en este navegador: no tiene sentido
      // "alertar" de todo lo que ya estaba activo de antes -- se siembra en
      // silencio y de aca en adelante si alerta lo nuevo.
      candidatos.forEach(function (c) { clavesAlertadas[c.clave] = true; });
      esPrimerCargaAbsoluta = false;
      guardarClavesAlertadas(clavesAlertadas);
      return;
    }

    if (candidatos.length > 0) {
      candidatos.forEach(function (c) { clavesAlertadas[c.clave] = true; });
      Object.keys(clavesAlertadas).forEach(function (clave) { if (!activasAhora[clave]) delete clavesAlertadas[clave]; });
      guardarClavesAlertadas(clavesAlertadas);
      var criticidadAlarma = candidatos.some(function (c) { return c.item.criticidad === 'ALTA'; }) ? 'ALTA' : 'MEDIA';
      reproducirAlarmaSonora(criticidadAlarma);
      mostrarBannerAlarma(candidatos.map(function (c) { return c.item; }));
      iniciarRepeticionAlarma(criticidadAlarma);
    } else {
      Object.keys(clavesAlertadas).forEach(function (clave) { if (!activasAhora[clave]) delete clavesAlertadas[clave]; });
      guardarClavesAlertadas(clavesAlertadas);
    }
  }

  // ---------------------------------------------------------------------------
  // Tripulaciones: cruce con el Excel diario de conductor-vehiculo-turno que
  // pasa el equipo de operaciones (columnas reales: PLACA, # INTERNO,
  // TRIPULACIÓN, FECHA, HORA INICIO, HORA FIN, # CEDULA, GRUPO). Se parsea
  // 100% en el navegador con SheetJS (nunca sale del equipo del usuario) y se
  // guarda en localStorage -- misma clave que usa el add-in de Sobre-Revolución
  // con PTO, por si algun dia comparten origen y localStorage (no hace daño
  // si no lo comparten, cada uno simplemente pide su propio archivo).
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
  // de zona horaria que ya se corrigio una vez en este mismo add-in.
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
    var filasHoja = XLSX.utils.sheet_to_json(ws, { raw: true, defval: null });

    var turnos = [];
    filasHoja.forEach(function (f) {
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
      var datos = JSON.parse(localStorage.getItem('tripulaciones_datos') || 'null');
      var meta = JSON.parse(localStorage.getItem('tripulaciones_meta') || 'null');
      tripulacionesCache = Array.isArray(datos) ? datos : [];
      tripulacionesMetaCache = meta;
    } catch (e) { tripulacionesCache = []; tripulacionesMetaCache = null; }
  }

  function guardarTripulaciones(turnos, meta) {
    tripulacionesCache = turnos;
    tripulacionesMetaCache = meta;
    try {
      localStorage.setItem('tripulaciones_datos', JSON.stringify(turnos));
      localStorage.setItem('tripulaciones_meta', JSON.stringify(meta));
    } catch (e) { console.error('No se pudo guardar el archivo de tripulaciones (localStorage lleno o no disponible):', e); }
  }

  // Devuelve el/los nombre(s) de conductor cuyo turno cubre 'fecha' para ese
  // vehiculo (por placa O por codigo interno). Si hay mas de un turno
  // solapado se devuelven todos separados por " / " en vez de adivinar cual
  // es el correcto. SOLO match exacto -- a proposito, sin tolerancia ni
  // aproximacion: la atribucion de conductor puede usarse para llamados de
  // atencion, asi que "No identificado" (dato faltante, honesto) es preferible
  // a un nombre aproximado que alguien podria leer como un hecho confirmado.
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
  // viene como 'CODIGO-PLACA' (ej. '1148-NWW623').
  function codigoYPlacaDeNombre(nombreDevice) {
    if (!nombreDevice) return { codigo: null, placa: null };
    var partes = nombreDevice.split('-');
    if (partes.length < 2) return { codigo: null, placa: nombreDevice };
    return { codigo: partes[0], placa: partes.slice(1).join('-') };
  }

  function construirControlTripulaciones(contenedor, onCargado) {
    var panel = crearPanel({
      display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
      padding: '10px 16px', marginBottom: '12px', fontSize: '0.78rem', color: T.color.textoGris
    });

    var textoEstado = crear('span');
    function actualizarTextoEstado() {
      if (tripulacionesMetaCache && tripulacionesCache.length) {
        textoEstado.textContent = '📋 Tripulaciones: ' + tripulacionesMetaCache.nombreArchivo +
          ' — ' + tripulacionesCache.length + ' turnos (cargado ' + tripulacionesMetaCache.cargadoEn + ')';
        textoEstado.style.color = T.color.textoGris;
      } else {
        textoEstado.textContent = '⚠️ Sin archivo de tripulaciones cargado — el conductor no se puede identificar.';
        textoEstado.style.color = T.color.muted || T.color.textoGris;
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

  // --- Filtros -----------------------------------------------------------
  var filtroEstado = { texto: '', ciudad: 'Todas', vehiculo: null, criticidad: 'Todas', sistema: 'Todas', turno: 'Todos' };
  var resultadoCache = { vehiculos: [], totalOcultas: 0 };
  var barraFiltrosRefs = null;
  var modoVista = 'vehiculo'; // 'vehiculo' | 'cronologico'

  // Aplana las tarjetas filtradas en una sola lista de fallas (con el dato de
  // a que vehiculo pertenece cada una), ordenada por fecha descendente -- para
  // la vista "Mas recientes" que pidio el usuario, viendo la flota entera como
  // un unico feed en vez de agrupado por vehiculo.
  function aplanarFallas(vehiculosFiltrados) {
    var filas = [];
    vehiculosFiltrados.forEach(function (v) {
      v.items.forEach(function (it) {
        var fila = {};
        for (var k in it) { fila[k] = it[k]; }
        fila.claveVehiculo = v.claveVehiculo;
        fila.marca = v.marca;
        fila.ciudad = v.ciudad;
        filas.push(fila);
      });
    });
    filas.sort(function (a, b) { return b.fecha - a.fecha; });
    return filas;
  }

  // Devuelve una copia del vehiculo con 'items' reemplazado -- se usa para
  // filtrar por criticidad/sistema DENTRO de la tarjeta (no solo cuales
  // tarjetas se muestran), asi un vehiculo con fallas mixtas solo enseña las
  // filas que coinciden con el filtro elegido.
  function conItemsFiltrados(v, items) {
    return {
      idVehiculo: v.idVehiculo, claveVehiculo: v.claveVehiculo, marca: v.marca, ciudad: v.ciudad,
      referenciaMotor: v.referenciaMotor, nMotor: v.nMotor, criticidad: v.criticidad, items: items
    };
  }

  function aplicarFiltros(vehiculos) {
    var texto = filtroEstado.texto.trim().toLowerCase();
    return vehiculos.filter(function (v) {
      if (texto && (v.claveVehiculo + ' ' + v.ciudad).toLowerCase().indexOf(texto) === -1) return false;
      if (filtroEstado.ciudad !== 'Todas' && v.ciudad !== filtroEstado.ciudad) return false;
      if (filtroEstado.vehiculo && v.claveVehiculo !== filtroEstado.vehiculo) return false;
      return true;
    }).map(function (v) {
      if (filtroEstado.criticidad === 'Todas' && filtroEstado.sistema === 'Todas' && filtroEstado.turno === 'Todos') return v;
      var items = v.items;
      if (filtroEstado.criticidad !== 'Todas') items = items.filter(function (it) { return it.criticidad === filtroEstado.criticidad; });
      if (filtroEstado.sistema !== 'Todas') items = items.filter(function (it) { return it.categoria === filtroEstado.sistema; });
      if (filtroEstado.turno !== 'Todos') items = items.filter(function (it) { return it.turno === filtroEstado.turno; });
      return items.length ? conItemsFiltrados(v, items) : null;
    }).filter(function (v) { return v !== null; });
  }

  function tieneFiltrosActivos() {
    return !!(filtroEstado.texto || filtroEstado.ciudad !== 'Todas' || filtroEstado.vehiculo ||
      filtroEstado.criticidad !== 'Todas' || filtroEstado.sistema !== 'Todas' || filtroEstado.turno !== 'Todos');
  }

  // --- Encabezado (titulo + rango de fechas + botones) -----------------------
  function construirEncabezado(contenedor) {
    var panel = crearPanel({ padding: '18px 22px', marginBottom: '16px', background: T.color.ink });

    var filaTitulo = crear('div', { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' });
    filaTitulo.appendChild(crearChip('🚨', 'rgba(255,255,255,0.12)', '#FFFFFF', '34px'));
    var bloqueTitulo = crear('div');
    bloqueTitulo.appendChild(crear('h2', { margin: '0', color: '#FFFFFF', fontSize: '1.15rem', fontWeight: '800' }, 'Alertas por Severidad'));
    filaTitulo.appendChild(bloqueTitulo);
    panel.appendChild(filaTitulo);

    var rangoGuardado = cargarRangoGuardado();

    function crearCampoFecha(etiqueta, valorInicial) {
      var envoltorio = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
      envoltorio.appendChild(crear('label', { fontSize: '0.75rem', color: '#C7D2E0', fontWeight: '600' }, etiqueta));
      var input = crear('input', {
        padding: '7px 10px', border: '1px solid rgba(255,255,255,0.3)', borderRadius: T.radius.sm,
        fontSize: '0.82rem', fontFamily: T.font, color: T.color.ink, background: '#FFFFFF'
      });
      input.type = 'datetime-local';
      input.value = valorInicial;
      envoltorio.appendChild(input);
      return { envoltorio: envoltorio, input: input };
    }

    var campoDesde = crearCampoFecha('Desde', rangoGuardado.desde);
    var campoHasta = crearCampoFecha('Hasta', rangoGuardado.hasta);

    function crearBoton(texto, primario) {
      return crear('button', {
        alignSelf: 'flex-end', padding: '9px 18px',
        background: primario ? T.color.primary : 'transparent',
        color: '#FFFFFF',
        border: primario ? 'none' : '1px solid rgba(255,255,255,0.4)',
        borderRadius: T.radius.sm, fontWeight: '700', fontSize: '0.85rem', cursor: 'pointer'
      }, texto);
    }

    var botonActualizar = crearBoton('Actualizar', true);
    botonActualizar.addEventListener('click', function () { actualizarRangoDefecto(); });

    var botonFiltrar = crearBoton('Filtrar fechas', false);
    botonFiltrar.addEventListener('click', function () {
      guardarRango(campoDesde.input.value, campoHasta.input.value);
      cargarYRenderizar(new Date(campoDesde.input.value), new Date(campoHasta.input.value));
    });

    var filaFiltros = crear('div', { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-end', marginTop: '14px' });
    filaFiltros.appendChild(campoDesde.envoltorio);
    filaFiltros.appendChild(campoHasta.envoltorio);
    filaFiltros.appendChild(botonFiltrar);
    filaFiltros.appendChild(botonActualizar);
    panel.appendChild(filaFiltros);

    panel.appendChild(crear('p', { margin: '8px 0 0 0', fontSize: '0.72rem', color: '#94A3B8' },
      'Nota: "activas ahora" siempre revisa al menos los últimos 30 días para no perder códigos que sigan activos aunque no tengan dato nuevo hoy — puede aparecer algo más viejo que "Desde".'));

    contenedor.appendChild(panel);
    return { inputDesde: campoDesde.input, inputHasta: campoHasta.input };
  }

  // --- Barra de filtros (texto, ciudad, chip de vehiculo) ---------------------
  function construirBarraFiltros(contenedor, onCambio) {
    var panelExterno = crearPanel({ padding: '14px 18px', marginBottom: '16px' });
    var panel = crear('div', { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-end' });

    var envBusqueda = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 220px' });
    envBusqueda.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.body, fontWeight: '600' }, 'Buscar'));
    var inputBusqueda = crear('input', {
      padding: '7px 10px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm,
      fontSize: '0.82rem', fontFamily: T.font, color: T.color.textoOscuro, width: '100%', boxSizing: 'border-box'
    });
    inputBusqueda.type = 'text';
    inputBusqueda.placeholder = 'Móvil, placa, ciudad…';
    inputBusqueda.addEventListener('input', function () { filtroEstado.texto = inputBusqueda.value; onCambio(); });
    envBusqueda.appendChild(inputBusqueda);

    var envCiudad = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    envCiudad.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.body, fontWeight: '600' }, 'Ciudad'));
    var selectCiudad = crear('select', {
      padding: '7px 10px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm,
      fontSize: '0.82rem', fontFamily: T.font, color: T.color.textoOscuro, background: T.color.surface
    });
    var opcionTodas0 = crear('option'); opcionTodas0.value = 'Todas'; opcionTodas0.textContent = 'Todas';
    selectCiudad.appendChild(opcionTodas0);
    selectCiudad.addEventListener('change', function () { filtroEstado.ciudad = selectCiudad.value; onCambio(); });
    envCiudad.appendChild(selectCiudad);

    var envCriticidad = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    envCriticidad.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.body, fontWeight: '600' }, 'Criticidad'));
    var selectCriticidad = crear('select', {
      padding: '7px 10px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm,
      fontSize: '0.82rem', fontFamily: T.font, color: T.color.textoOscuro, background: T.color.surface
    });
    ['Todas', 'ALTA', 'MEDIA', 'BAJA'].forEach(function (nivel) {
      var opcion = crear('option'); opcion.value = nivel; opcion.textContent = nivel;
      selectCriticidad.appendChild(opcion);
    });
    selectCriticidad.addEventListener('change', function () { filtroEstado.criticidad = selectCriticidad.value; onCambio(); });
    envCriticidad.appendChild(selectCriticidad);

    var envTurno = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    envTurno.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.body, fontWeight: '600' }, 'Turno'));
    var selectTurno = crear('select', {
      padding: '7px 10px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm,
      fontSize: '0.82rem', fontFamily: T.font, color: T.color.textoOscuro, background: T.color.surface
    });
    ['Todos', 'T1', 'T2', 'T3'].forEach(function (turno) {
      var opcion = crear('option'); opcion.value = turno; opcion.textContent = turno;
      selectTurno.appendChild(opcion);
    });
    selectTurno.addEventListener('change', function () { filtroEstado.turno = selectTurno.value; onCambio(); });
    envTurno.appendChild(selectTurno);

    var envSistema = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    envSistema.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.body, fontWeight: '600' }, 'Sistema'));
    var selectSistema = crear('select', {
      padding: '7px 10px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm,
      fontSize: '0.82rem', fontFamily: T.font, color: T.color.textoOscuro, background: T.color.surface
    });
    var opcionTodasSistema = crear('option'); opcionTodasSistema.value = 'Todas'; opcionTodasSistema.textContent = 'Todos';
    selectSistema.appendChild(opcionTodasSistema);
    selectSistema.addEventListener('change', function () { filtroEstado.sistema = selectSistema.value; onCambio(); });
    envSistema.appendChild(selectSistema);

    var botonLimpiar = crear('button', {
      alignSelf: 'flex-end', padding: '8px 14px', background: 'transparent',
      color: T.color.body, border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm,
      fontSize: '0.8rem', fontWeight: '600', cursor: 'pointer'
    }, 'Limpiar filtros');
    botonLimpiar.addEventListener('click', function () {
      filtroEstado.texto = ''; filtroEstado.ciudad = 'Todas'; filtroEstado.vehiculo = null;
      filtroEstado.criticidad = 'Todas'; filtroEstado.sistema = 'Todas'; filtroEstado.turno = 'Todos';
      inputBusqueda.value = ''; selectCiudad.value = 'Todas';
      selectCriticidad.value = 'Todas'; selectSistema.value = 'Todas'; selectTurno.value = 'Todos';
      chipVehiculo.style.display = 'none';
      onCambio();
    });

    panel.appendChild(envBusqueda);
    panel.appendChild(envCiudad);
    panel.appendChild(envCriticidad);
    panel.appendChild(envTurno);
    panel.appendChild(envSistema);
    panel.appendChild(botonLimpiar);
    panelExterno.appendChild(panel);

    // Alternador de vista: tarjetas por vehiculo (orden por criticidad, diseño
    // igual al PDF) vs. lista cronologica global (todas las fallas de la flota
    // en una sola lista, la mas reciente arriba) -- pedido explicito del usuario
    // para poder ver "que codigos han sido los mas recientes" sin ir tarjeta por tarjeta.
    var filaVista = crear('div', { display: 'flex', gap: '6px', marginTop: '10px' });
    function crearBotonVista(etiqueta, valor) {
      var boton = crear('button', {
        padding: '6px 12px', borderRadius: T.radius.pill, fontSize: '0.78rem', fontWeight: '700',
        cursor: 'pointer', border: '1px solid ' + T.color.borderStrong
      }, etiqueta);
      boton.addEventListener('click', function () {
        modoVista = valor;
        actualizarBotonesVista();
        onCambio();
      });
      return boton;
    }
    var botonVistaVehiculo = crearBotonVista('Por vehículo', 'vehiculo');
    var botonVistaCronologica = crearBotonVista('🕘 Más recientes primero', 'cronologico');
    function actualizarBotonesVista() {
      [botonVistaVehiculo, botonVistaCronologica].forEach(function (b) {
        var activo = (b === botonVistaVehiculo && modoVista === 'vehiculo') || (b === botonVistaCronologica && modoVista === 'cronologico');
        aplicarEstilo(b, {
          background: activo ? T.color.primary : 'transparent',
          color: activo ? '#FFFFFF' : T.color.body,
          borderColor: activo ? T.color.primary : T.color.borderStrong
        });
      });
    }
    actualizarBotonesVista();
    filaVista.appendChild(botonVistaVehiculo);
    filaVista.appendChild(botonVistaCronologica);
    panelExterno.appendChild(filaVista);

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
      filtroEstado.vehiculo = null; chipVehiculo.style.display = 'none'; onCambio();
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
      actualizarOpcionesCiudad: function (ciudadesDisponibles) {
        var seleccionPrevia = selectCiudad.value || 'Todas';
        selectCiudad.innerHTML = '';
        var opcionTodas = crear('option'); opcionTodas.value = 'Todas'; opcionTodas.textContent = 'Todas';
        selectCiudad.appendChild(opcionTodas);
        ciudadesDisponibles.forEach(function (ciudad) {
          var opcion = crear('option'); opcion.value = ciudad; opcion.textContent = ciudad;
          selectCiudad.appendChild(opcion);
        });
        var siguenValida = seleccionPrevia === 'Todas' || ciudadesDisponibles.indexOf(seleccionPrevia) !== -1;
        selectCiudad.value = siguenValida ? seleccionPrevia : 'Todas';
        filtroEstado.ciudad = selectCiudad.value;
      },
      actualizarOpcionesSistema: function (sistemasDisponibles) {
        var seleccionPrevia = selectSistema.value || 'Todas';
        selectSistema.innerHTML = '';
        var opcionTodas = crear('option'); opcionTodas.value = 'Todas'; opcionTodas.textContent = 'Todos';
        selectSistema.appendChild(opcionTodas);
        sistemasDisponibles.forEach(function (sistema) {
          var opcion = crear('option'); opcion.value = sistema; opcion.textContent = sistema;
          selectSistema.appendChild(opcion);
        });
        var siguenValido = seleccionPrevia === 'Todas' || sistemasDisponibles.indexOf(seleccionPrevia) !== -1;
        selectSistema.value = siguenValido ? seleccionPrevia : 'Todas';
        filtroEstado.sistema = selectSistema.value;
      },
      // Usados por el resumen clicable (construirResumen) para que el select
      // refleje el filtro que se acaba de aplicar con un clic.
      seleccionarSistema: function (sistema) { selectSistema.value = sistema; filtroEstado.sistema = sistema; },
      seleccionarCriticidad: function (criticidad) { selectCriticidad.value = criticidad; filtroEstado.criticidad = criticidad; }
    };
  }

  // --- Resumen de novedades + aviso de filtro (igual que el PDF) -------------
  function construirResumen(contenedor, vehiculos, totalOcultas) {
    if (totalOcultas > 0) {
      var aviso = crear('div', {
        background: T.color.filtroFondo, border: '1px solid ' + T.color.filtroBorde, borderRadius: T.radius.sm,
        padding: '10px 14px', marginBottom: '14px', fontSize: '0.82rem', color: T.color.filtroBorde
      });
      var negrita = crear('b', {}, 'Filtro aplicado: ');
      aviso.appendChild(negrita);
      aviso.appendChild(document.createTextNode(
        'se ocultaron ' + totalOcultas + ' falla(s) de conectividad telemática y diagnósticos sin nombre reconocible -- no aportan al mantenimiento del vehículo.'
      ));
      contenedor.appendChild(aviso);
    }

    if (vehiculos.length === 0) return;

    var vehiculosAlta = vehiculos.filter(function (v) { return v.criticidad === 'ALTA'; });
    var vehiculosMediaBaja = vehiculos.filter(function (v) { return v.criticidad !== 'ALTA'; });
    var conteoSistemas = {};
    vehiculos.forEach(function (v) {
      v.items.forEach(function (it) { conteoSistemas[it.categoria] = (conteoSistemas[it.categoria] || 0) + 1; });
    });
    var topSistemas = Object.keys(conteoSistemas)
      .sort(function (a, b) { return conteoSistemas[b] - conteoSistemas[a]; })
      .slice(0, 3);

    var panel = crearPanel({ padding: '16px 20px', marginBottom: '16px', borderLeft: '3px solid ' + T.color.resumenBorde });
    panel.appendChild(crear('div', { fontWeight: '700', fontSize: '0.95rem', color: T.color.textoOscuro, marginBottom: '10px' }, 'Resumen de Novedades'));

    var fila = crear('div', { display: 'flex', gap: '28px', flexWrap: 'wrap', fontSize: '0.85rem', color: T.color.textoOscuro });

    // Los conteos y la lista de sistemas son clicables: aplican el filtro
    // correspondiente en la barra de arriba de un solo clic, sin tener que
    // ir a buscar el select -- el resumen deja de ser solo lectura.
    function crearFilaClicable(texto, onClick) {
      var el = crear('div', { color: T.color.primaryDark, cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' }, texto);
      el.addEventListener('click', onClick);
      return el;
    }

    var col1 = crear('div');
    col1.appendChild(crear('b', {}, 'Vehículos en Alerta Crítica (ALTA):'));
    col1.appendChild(crearFilaClicable(
      vehiculosAlta.length + ' unidad(es) (Prioridad de ingreso a taller)',
      function () { if (barraFiltrosRefs) { barraFiltrosRefs.seleccionarCriticidad('ALTA'); actualizarVista(); } }
    ));
    fila.appendChild(col1);

    var col2 = crear('div');
    col2.appendChild(crear('b', {}, 'Vehículos con fallas (MEDIA/BAJA):'));
    col2.appendChild(crear('div', { color: T.color.body }, vehiculosMediaBaja.length + ' unidad(es) (Monitoreo preventivo)'));
    fila.appendChild(col2);

    var col3 = crear('div');
    col3.appendChild(crear('b', {}, 'Sistemas más afectados:'));
    var listaSistemas = crear('div', { color: T.color.body });
    if (topSistemas.length === 0) {
      listaSistemas.textContent = '—';
    } else {
      topSistemas.forEach(function (s, i) {
        listaSistemas.appendChild(crearFilaClicable((i + 1) + '. ' + s, function () {
          if (barraFiltrosRefs) { barraFiltrosRefs.seleccionarSistema(s); actualizarVista(); }
        }));
      });
    }
    col3.appendChild(listaSistemas);
    fila.appendChild(col3);

    panel.appendChild(fila);
    contenedor.appendChild(panel);
  }

  // --- Tarjeta por vehiculo: tabla de fallas, igual estructura que el PDF -----
  function urlBusquedaCausa(spn, fmi) {
    return 'https://www.google.com/search?q=SPN+' + spn + '+FMI+' + fmi + '+causa+falla+motores+diesel';
  }

  // --- Historial de un codigo puntual (vehiculo+diagnostico+modo de falla) ---
  // Bajo demanda (no se trae para todas las filas de una), asi que no infla la
  // cantidad de llamadas a Geotab por cada corrida. Consulta FaultData de ESE
  // vehiculo en una ventana mas amplia y cuenta transiciones reales -- ojo:
  // varios codigos (confirmado con datos reales, ej. SPN 168) nunca traen un
  // registro de "resuelto" explicito, solo se repiten como Active una y otra
  // vez -- eso tambien es informacion util, no un error de la cuenta.
  var VENTANA_HISTORIAL_DIAS = 90;
  var historialCache = {};

  function obtenerHistorialFalla(idVehiculo, idDiagnostico, idFailureMode) {
    var clave = idVehiculo + '|' + idDiagnostico + '|' + idFailureMode;
    if (historialCache[clave]) return historialCache[clave];

    var hasta = new Date();
    var desde = new Date(hasta.getTime() - VENTANA_HISTORIAL_DIAS * 24 * 60 * 60 * 1000);

    var promesa = apiCall('Get', {
      typeName: 'FaultData',
      search: { deviceSearch: { id: idVehiculo }, fromDate: desde.toISOString(), toDate: hasta.toISOString() }
    }).then(function (registros) {
      var propios = (registros || []).filter(function (r) {
        return idDeRef(r.diagnostic) === idDiagnostico && idDeRef(r.failureMode) === idFailureMode;
      }).map(function (r) { return { fecha: new Date(r.dateTime), estado: r.faultState || 'None' }; })
        .sort(function (a, b) { return b.fecha - a.fecha; }); // mas reciente primero

      var activaciones = propios.filter(function (r) { return r.estado === 'Active'; }).length;
      var desactivaciones = propios.length - activaciones;

      return {
        registros: propios,
        activaciones: activaciones,
        desactivaciones: desactivaciones,
        primeraVez: propios.length ? propios[propios.length - 1].fecha : null,
        ultimaVez: propios.length ? propios[0].fecha : null,
        ventanaDias: VENTANA_HISTORIAL_DIAS
      };
    });

    historialCache[clave] = promesa;
    return promesa;
  }

  function crearPanelHistorial() {
    var panel = crear('div', {
      background: T.color.canvas, border: '1px solid ' + T.color.border, borderRadius: T.radius.sm,
      padding: '10px 14px', margin: '4px 0', fontSize: '0.78rem', color: T.color.textoOscuro
    });
    panel.appendChild(crear('div', { color: T.color.body }, 'Cargando historial…'));
    return panel;
  }

  function llenarPanelHistorial(panel, historial) {
    while (panel.firstChild) panel.removeChild(panel.firstChild);

    var resumen = crear('div', { display: 'flex', gap: '18px', flexWrap: 'wrap', marginBottom: historial.registros.length ? '8px' : '0' });
    resumen.appendChild(crear('span', {}, '🔴 Se activó ' + historial.activaciones + ' vez(veces)'));
    resumen.appendChild(crear('span', {}, '🟢 Se desactivó ' + historial.desactivaciones + ' vez(veces)'));
    if (historial.primeraVez) {
      resumen.appendChild(crear('span', { color: T.color.body },
        'Desde ' + formatearFechaHora(historial.primeraVez) + ' hasta ' + formatearFechaHora(historial.ultimaVez)));
    }
    panel.appendChild(resumen);

    if (historial.desactivaciones === 0 && historial.activaciones > 1) {
      panel.appendChild(crear('div', { color: T.color.body, fontStyle: 'italic', marginBottom: '8px' },
        'Geotab nunca registró una desactivación explícita para este código en los últimos ' + historial.ventanaDias +
        ' días -- solo se repite como activo.'));
    }

    if (historial.registros.length > 0) {
      var lista = crear('div', { maxHeight: '160px', overflowY: 'auto', border: '1px solid ' + T.color.border, borderRadius: '6px' });
      historial.registros.forEach(function (r) {
        var esActivo = r.estado === 'Active';
        var filaHist = crear('div', {
          display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '4px 10px',
          borderBottom: '1px solid ' + T.color.border
        });
        filaHist.appendChild(crear('span', {}, formatearFechaHora(r.fecha)));
        filaHist.appendChild(crear('span', { color: esActivo ? '#B91C1C' : '#15803D', fontWeight: '600' },
          esActivo ? 'Activo' : 'Inactivo'));
        lista.appendChild(filaHist);
      });
      panel.appendChild(lista);
    }
  }

  // ============================================================================
  // --- Mini Expediente (ficha de UN caso puntual de falla) -------------------
  // ============================================================================
  // Portado desde el add-in de Mantenimiento (_build_reportes/mantenimiento.js)
  // el 2026-10-01 -- decisión explícita del usuario: esta ficha de UN caso
  // puntual (código+criticidad+duración, ubicación GPS, línea de tiempo de
  // señales ±2h, historial reciente del vehículo) calza mejor aquí que en
  // Mantenimiento, porque cada fila de la tabla de fallas activas YA ES la
  // selección (no hace falta picker) y este add-in YA resuelve conductor
  // (buscarConductor, cruce con el Excel de tripulaciones) y turno
  // (clasificarTurno) -- ninguno de los dos existía en la versión vieja del
  // expediente. Ver cambios/2026-10-01_agregar-mini-expediente.md.
  //
  // GPS: portado TAL CUAL desde mantenimiento.js (mismas ventanas, mismo link
  // de Google Maps) -- no existía nada parecido en este archivo.
  //
  // CAMBIO (2026-10-01, pedido explícito del usuario): la línea de tiempo de
  // señales y el historial reciente del vehículo SE QUITARON del Mini
  // Expediente -- "información innecesaria" para el caso de uso real, que es
  // generar una alerta rápida para compartir por WhatsApp, no un informe
  // completo. Las funciones que las armaban (construirLineaTiempoSenales,
  // obtenerHistorialVehiculo) se borraron del todo, no se dejaron sin usar.
  //
  // Turno: reutiliza clasificarTurno (arriba, junto a agregarClasificacion) en
  // vez de duplicar lógica nueva. OJO -- posible inconsistencia señalada en el
  // changelog de esta tarea: clasificarTurno usa 'hora.getHours()' (hora local
  // del NAVEGADOR), mientras que calcularTurno/horaBogota en el add-in de
  // Operaciones usa Intl.DateTimeFormat con 'America/Bogota' EXPLÍCITO a
  // propósito (ver cambios/2026-10-01_implementar-turno-operaciones.md en
  // _build_reportes/), precisamente para no depender de la zona horaria del
  // equipo donde se genera el reporte. Los LÍMITES horarios (5/13/21) son
  // idénticos en ambos add-ins -- la diferencia es solo el origen de la hora.
  // No se tocó clasificarTurno (no se pidió), queda documentado para que el
  // usuario decida si vale la pena alinearlo.
  var VENTANA_GPS_MIN = 10;          // ventana inicial +/- para buscar LogRecord
  var VENTANA_GPS_AMPLIADA_MIN = 30; // si la inicial no tiene ningún punto, se amplía UNA vez

  var expedienteEnCurso = false;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatearDecimal(v) {
    return (v || 0).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  function slug(texto) {
    return (texto || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos (marcas diacríticas combinadas)
      .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'VEHICULO';
  }

  function reemplazarBloque(html, marcador, reemplazo) {
    if (html.indexOf(marcador) === -1) {
      console.warn('Alertas (expediente): no se encontró el marcador esperado en la plantilla: ' + marcador);
      return html;
    }
    return html.split(marcador).join(reemplazo);
  }

  function descargarBlob(nombreArchivo, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = nombreArchivo;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  // CAMBIO (2026-10-01, pedido explícito del usuario): la tarjeta ya NO se
  // descarga como HTML -- se renderiza en un iframe oculto (mismo documento
  // completo de siempre, con su propio Leaflet/CARTO adentro), se espera a
  // que el mapa termine de cargar (window.__mapaListo, ver SCRIPT_INIT_MAPA)
  // y se captura con html2canvas a una imagen PNG nítida (scale:2) lista
  // para compartir por WhatsApp -- este es un add-in de ALERTAS, el objetivo
  // es algo que se pueda reenviar de inmediato, no un documento para abrir.
  function capturarYDescargarImagen(contenidoHtml, nombreArchivo) {
    return new Promise(function (resolve, reject) {
      if (typeof html2canvas === 'undefined') {
        reject(new Error('No se pudo generar la imagen: la librería html2canvas no cargó (revisa la conexión a internet).'));
        return;
      }
      var iframe = document.createElement('iframe');
      // Fuera de la vista (no display:none / visibility:hidden -- algunos
      // navegadores no renderizan del todo un elemento oculto así, y el mapa
      // necesita pintarse de verdad para que html2canvas lo capture bien).
      aplicarEstilo(iframe, { position: 'fixed', left: '-9999px', top: '0', width: '480px', height: '1200px', border: 'none' });
      document.body.appendChild(iframe);

      var yaResuelto = false;
      function limpiar() { if (iframe.parentNode) iframe.parentNode.removeChild(iframe); }
      function conError(err) {
        if (yaResuelto) return;
        yaResuelto = true;
        limpiar();
        reject(err);
      }

      iframe.onerror = function () { conError(new Error('No se pudo renderizar el expediente para capturarlo.')); };
      iframe.onload = function () {
        try {
          var ventanaIframe = iframe.contentWindow;
          var docIframe = iframe.contentDocument;
          var INTERVALO_MS = 150, MAXIMO_MS = 7000, transcurrido = 0;
          var temporizador = setInterval(function () {
            transcurrido += INTERVALO_MS;
            if (ventanaIframe.__mapaListo !== true && transcurrido < MAXIMO_MS) return;
            clearInterval(temporizador);
            iframe.style.height = docIframe.body.scrollHeight + 'px';
            html2canvas(docIframe.body, { useCORS: true, backgroundColor: '#f1f5f9', scale: 2 })
              .then(function (canvas) {
                canvas.toBlob(function (blob) {
                  if (!blob) { conError(new Error('No se pudo generar la imagen del expediente.')); return; }
                  descargarBlob(nombreArchivo, blob);
                  limpiar();
                  if (!yaResuelto) { yaResuelto = true; resolve(); }
                }, 'image/png');
              }).catch(conError);
          }, INTERVALO_MS);
        } catch (e) { conError(e); }
      };
      iframe.srcdoc = contenidoHtml;
    });
  }

  // Formato EXACTO ya usado en todo el repo para el link de Google Maps (ver
  // herramientas/geotab_reglas_v3.py líneas ~485/1766) -- no inventar otro.
  function construirLinkGoogleMaps(lat, lon) {
    return 'https://www.google.com/maps?q=' + lat + ',' + lon;
  }

  // Resuelve la posición GPS de UN vehículo en UN momento dado. Ventana
  // inicial +/-10 min; si no hay NINGÚN punto, se amplía una sola vez a
  // +/-30 min; si aun así no hay nada, se devuelve null (el llamador debe
  // mostrar "ubicación no disponible" -- no se inventan coordenadas). Puerto
  // directo de resolverPosicionGps en mantenimiento.js.
  function resolverPosicionGps(idVehiculo, momento) {
    function consultarVentana(minutos) {
      var desde = new Date(momento.getTime() - minutos * 60 * 1000);
      var hasta = new Date(momento.getTime() + minutos * 60 * 1000);
      return apiCall('Get', {
        typeName: 'LogRecord',
        search: { deviceSearch: { id: idVehiculo }, fromDate: desde.toISOString(), toDate: hasta.toISOString() }
      });
    }
    return consultarVentana(VENTANA_GPS_MIN).then(function (registros) {
      if (registros && registros.length) return registros;
      return consultarVentana(VENTANA_GPS_AMPLIADA_MIN);
    }).then(function (registros) {
      if (!registros || !registros.length) return null;
      var masCercano = registros.reduce(function (mejor, r) {
        var dist = Math.abs(new Date(r.dateTime) - momento);
        return (!mejor || dist < mejor.dist) ? { r: r, dist: dist } : mejor;
      }, null);
      if (!masCercano || masCercano.r.latitude == null || masCercano.r.longitude == null) return null;
      return { lat: masCercano.r.latitude, lon: masCercano.r.longitude, dateTime: new Date(masCercano.r.dateTime) };
    });
  }

  // Normaliza una fila de fallas activas (de agruparPorVehiculo) al formato de
  // "caso" que espera ensamblarYDescargarExpediente.
  function resolverCasoDesdeFila(it) {
    var claveEpisodio = it.idVehiculo + '|' + it.idDiagnostico + '|' + (it.idFailureMode || 'undefined');
    return {
      encontrada: true, idVehiculo: it.idVehiculo, nombreVehiculo: it.nombreVehiculo, placa: it.placa,
      marca: it.marca, ciudad: it.ciudad, tipologia: it.tipologia,
      momento: it.fecha, idDiagnostico: it.idDiagnostico, idFailureMode: it.idFailureMode,
      nombreDiagnostico: it.nombreFalla,
      spn: it.spn, fmi: it.fmi, categoria: it.categoria, activo: it.activo !== false,
      codigo: 'SPN ' + it.spn + '/FMI ' + it.fmi,
      descripcion: it.nombreFalla,
      criticidad: it.criticidad,
      duracionTexto: 'Reportada el ' + formatearFechaHora(it.fecha) + ' — código activo según el último registro consultado en Geotab.',
      claveEpisodio: claveEpisodio
    };
  }

  // --- Mini Expediente: significado genérico de FMI (SAE J1939) -------------
  // Tabla estándar, usada tal cual -- no es específica de Promoambiental ni de
  // ningún diagnóstico puntual, es el significado del MODO DE FALLA (FMI) en
  // sí, independiente del SPN. Si el FMI de la falla no está acá (no debería
  // pasar en una cuenta J1939 normal), se muestra un texto neutral en vez de
  // romper.
  var SIGNIFICADOS_FMI = {
    '0': 'Dato válido pero por encima del rango normal de operación (nivel más severo)',
    '1': 'Dato válido pero por debajo del rango normal de operación (nivel más severo)',
    '2': 'Dato errático, intermitente o incorrecto',
    '3': 'Voltaje por encima de lo normal, o en corto con una fuente alta',
    '4': 'Voltaje por debajo de lo normal, o en corto con una fuente baja',
    '5': 'Corriente por debajo de lo normal o circuito abierto',
    '6': 'Corriente por encima de lo normal o circuito a tierra',
    '7': 'Sistema mecánico no responde o está desajustado',
    '8': 'Frecuencia, ancho de pulso o período anormal',
    '9': 'Tasa de actualización anormal',
    '10': 'Tasa de cambio anormal',
    '11': 'Causa raíz desconocida',
    '12': 'Dispositivo o componente inteligente defectuoso',
    '13': 'Fuera de calibración',
    '14': 'Instrucciones especiales',
    '15': 'Dato válido pero por encima del rango normal de operación (nivel menos severo)',
    '16': 'Dato válido pero por encima del rango normal de operación (nivel moderadamente severo)',
    '17': 'Dato válido pero por debajo del rango normal de operación (nivel menos severo)',
    '18': 'Dato válido pero por debajo del rango normal de operación (nivel moderadamente severo)',
    '19': 'Datos de red recibidos con error',
    '20': 'Dato con deriva alta',
    '21': 'Dato con deriva baja',
    '31': 'Condición presente'
  };

  function significadoFmi(fmi) {
    return SIGNIFICADOS_FMI[String(fmi)] || 'Significado no disponible para este código.';
  }

  // --- Mini Expediente: localidad por geocerca (Zone) ------------------------
  // Puerto a JS de cargar_zonas_localidad / _zona_de_punto / _punto_en_poligono
  // en herramientas/geotab_reglas_v3.py -- mismo criterio: zonas cuyo 'name'
  // empieza con el prefijo 'bogota-' (sin distinguir mayúsculas/tildes), point-
  // in-polygon por ray casting. Corre acá (al generar el expediente), NO en la
  // plantilla -- la plantilla solo recibe lat/lon + el polígono ya resuelto (o
  // null) como dato embebido.
  // CAMBIO (2026-10-02, bug real reportado por el usuario): antes solo se
  // reconocían geocercas con el prefijo fijo "bogota-" -- pero al revisar la
  // cuenta real de Geotab (api.get('Zone'), 2026-10-02) aparecieron geocercas
  // con el MISMO patrón "CIUDAD-LOCALIDAD" para otras 13 ciudades/municipios
  // (Cartagena 211, Cali 22, Fusagasugá 65, Girardot 45, Espinal 42, Melgar
  // 32, Ricaurte 16, Tocaima 15, Valle 15, Agua de Dios 12, Guamo 11,
  // Arbeláez 6, Zipaquirá 1) que el código ignoraba por completo. En vez de
  // mantener una lista fija de ciudades (que vuelve a quedar desactualizada
  // en cuanto alguien configure una ciudad nueva en Geotab), se descubren
  // SOLAS agrupando todas las geocercas por el texto antes del primer guión
  // y quedándose con los grupos de UMBRAL_ZONAS_CIUDAD geocercas o más --
  // ese umbral separa limpio las ciudades reales (mínimo real encontrado: 6)
  // de nombres de zona sueltos que también tienen un guión pero no son una
  // ciudad (ej. "TERMINAL DEL SUR", "CORREDOR LA CEJA", "DIVEMOTOR" -- máximo
  // real encontrado entre esos: 3).
  var UMBRAL_ZONAS_CIUDAD = 4;
  var zonasLocalidadCache = null;

  function quitarAcentos(texto) {
    return (texto || '').normalize('NFD').replace(/[̀-ͯ]/g, ''); // mismo patrón que slug()
  }

  function capitalizar(texto) {
    return (texto || '').toLowerCase().split(' ').filter(function (p) { return p.length > 0; })
      .map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join(' ');
  }

  // Devuelve { zonas: [...], ciudades: ['BOGOTÁ','CALI',...] } -- zonas es la
  // lista plana ya filtrada (de TODAS las ciudades reconocidas) que espera
  // resolverLocalidad; ciudades es la lista de nombres (normalizados, sin
  // acentos, mayúsculas) con al menos una geocerca, para poder avisar
  // explícitamente cuando la ciudad del caso NO está entre ellas en vez de
  // confundirlo con "el punto no cayó en ninguna zona".
  function obtenerZonasLocalidad() {
    if (zonasLocalidadCache) return zonasLocalidadCache;
    zonasLocalidadCache = apiCall('Get', { typeName: 'Zone' }).then(function (zonas) {
      var porPrefijo = {};
      (zonas || []).forEach(function (z) {
        var nombre = z.name || '';
        var idx = nombre.indexOf('-');
        if (idx <= 0) return;
        var prefijo = quitarAcentos(nombre.slice(0, idx)).trim().toUpperCase();
        if (!prefijo) return;
        var puntos = (z.points || [])
          .map(function (pt) { return [pt.x, pt.y]; })
          .filter(function (p) { return p[0] != null && p[1] != null; });
        if (puntos.length < 3) return;
        (porPrefijo[prefijo] = porPrefijo[prefijo] || []).push({ nombre: nombre, puntos: puntos });
      });
      var zonasValidas = [];
      var ciudadesConLocalidad = [];
      Object.keys(porPrefijo).forEach(function (prefijo) {
        if (porPrefijo[prefijo].length >= UMBRAL_ZONAS_CIUDAD) {
          zonasValidas = zonasValidas.concat(porPrefijo[prefijo]);
          ciudadesConLocalidad.push(prefijo);
        }
      });
      return { zonas: zonasValidas, ciudades: ciudadesConLocalidad };
    }).catch(function (e) {
      console.warn('Alertas (expediente): no se pudieron cargar zonas de localidad: ' + ((e && e.message) || e));
      return { zonas: [], ciudades: [] };
    });
    return zonasLocalidadCache;
  }

  // Ray casting estándar -- puerto directo de _punto_en_poligono (incluye la
  // misma particularidad del original: si un lado es horizontal (y1===y2) se
  // reutiliza la última intersección calculada en vez de recalcularla).
  function puntoEnPoligono(lon, lat, puntos) {
    var dentro = false;
    var n = puntos.length;
    var x = lon, y = lat;
    var x1 = puntos[0][0], y1 = puntos[0][1];
    var xInterseccion;
    for (var i = 1; i <= n; i++) {
      var p2 = puntos[i % n];
      var x2 = p2[0], y2 = p2[1];
      if (y > Math.min(y1, y2)) {
        if (y <= Math.max(y1, y2)) {
          if (x <= Math.max(x1, x2)) {
            if (y1 !== y2) { xInterseccion = (y - y1) * (x2 - x1) / (y2 - y1) + x1; }
            if (x1 === x2 || x <= xInterseccion) { dentro = !dentro; }
          }
        }
      }
      x1 = x2; y1 = y2;
    }
    return dentro;
  }

  // Devuelve { localidad, ciudad, poligono: [[lat,lon], ...] } de la primera
  // zona que contenga el punto, o null si no cae en ninguna. El nombre de
  // "ciudad" es la parte ANTES del primer guión del nombre de la zona (ej.
  // "BOGOTÁ-SAN CRISTOBAL" -> ciudad "Bogotá", localidad "San Cristobal").
  function resolverLocalidad(lon, lat, zonas) {
    if (lon == null || lat == null || !zonas || !zonas.length) return null;
    for (var i = 0; i < zonas.length; i++) {
      if (puntoEnPoligono(lon, lat, zonas[i].puntos)) {
        var partes = zonas[i].nombre.split('-');
        var ciudadTexto = capitalizar((partes[0] || '').trim());
        var localidadTexto = capitalizar(partes.slice(1).join('-').trim()) || zonas[i].nombre;
        var poligonoLatLon = zonas[i].puntos.map(function (p) { return [p[1], p[0]]; });
        return { localidad: localidadTexto, ciudad: ciudadTexto, poligono: poligonoLatLon, origen: 'geocerca' };
      }
    }
    return null;
  }

  // Respaldo cuando NO hay ninguna geocerca "bogota-X" que contenga el punto
  // (pedido explícito del usuario, 2026-10-02: hay ciudades de la flota sin
  // localidad definida en Geotab todavía). Usa geocodificación inversa
  // gratuita y sin API key (BigDataCloud, verificado en vivo con
  // coordenadas reales de Bogotá y Cali antes de integrarlo). Sin polígono
  // (esta fuente no da un contorno, solo el nombre) -- se marca
  // origen:'geocoding' para que construirDondeHtml avise que es una
  // ubicación aproximada de un servicio externo, no la geocerca propia de
  // la empresa. Nunca bloquea ni rompe el expediente si falla: cualquier
  // error (sin red, timeout, respuesta rara) devuelve null como si
  // simplemente no se hubiera encontrado nada, igual que resolverLocalidad.
  var TIMEOUT_GEOCODING_MS = 4000;

  function resolverLocalidadPorGeocoding(lat, lon) {
    if (lat == null || lon == null || typeof fetch === 'undefined') return Promise.resolve(null);
    var controlador = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var idTimeout = controlador ? setTimeout(function () { controlador.abort(); }, TIMEOUT_GEOCODING_MS) : null;
    var url = 'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=' + lat + '&longitude=' + lon + '&localityLanguage=es';
    return fetch(url, controlador ? { signal: controlador.signal } : {})
      .then(function (resp) { return resp.ok ? resp.json() : null; })
      .then(function (datos) {
        if (idTimeout) clearTimeout(idTimeout);
        if (!datos) return null;
        var localidadTexto = datos.locality || datos.city || null;
        var ciudadTexto = datos.city || datos.principalSubdivision || null;
        if (!localidadTexto) return null;
        return { localidad: localidadTexto, ciudad: ciudadTexto || localidadTexto, poligono: null, origen: 'geocoding' };
      })
      .catch(function () {
        if (idTimeout) clearTimeout(idTimeout);
        return null;
      });
  }

  // --- Mini Expediente: tiempo relativo ("hace N min"/"hace N h") -----------
  function tiempoRelativoTexto(momento, ahora) {
    var diffMs = ahora - momento;
    if (diffMs < 0) diffMs = 0;
    var minutos = Math.floor(diffMs / 60000);
    if (minutos < 1) return 'hace instantes';
    if (minutos < 60) return 'hace ' + minutos + ' min';
    return 'hace ' + Math.floor(minutos / 60) + ' h';
  }

  // --- Mini Expediente: piezas de HTML del layout nuevo (tarjeta angosta) ---
  // Las dos píldoras reusan EXACTAMENTE los mismos colores/tamaños que
  // crearPildoraCriticidad/crearPildoraEstadoActivo (arriba, usadas en vivo en
  // la tabla del add-in) -- acá van como <span style="..."> inline porque este
  // HTML se descarga y se abre fuera de la página del add-in, así que no hay
  // DOM del add-in disponible para llamar a esas funciones directamente.
  function construirPildorasHtml(criticidad, activo) {
    var colorCrit = COLOR_POR_CRITICIDAD[criticidad] || '#94A3B8';
    var pildoraCrit = '<span style="display:inline-block;min-width:46px;text-align:center;padding:3px 10px;' +
      'border-radius:999px;background:' + colorCrit + ';color:#FFFFFF;font-weight:700;font-size:11.5px;' +
      'letter-spacing:.02em">CRITICIDAD ' + escapeHtml(criticidad) + '</span>';
    var bgActivo = activo ? '#DCFCE7' : '#F1F5F9';
    var colorActivo = activo ? '#15803D' : '#64748B';
    var pildoraActivo = '<span style="display:inline-block;padding:2px 10px;border-radius:999px;' +
      'background:' + bgActivo + ';color:' + colorActivo + ';font-weight:700;font-size:11px">' +
      (activo ? 'ACTIVO' : 'INACTIVO') + '</span>';
    return pildoraCrit + pildoraActivo;
  }

  function construirCuandoHtml(momento, ahora) {
    return '<div class="field-label">Cuándo</div>' +
      '<div class="field-value">' + escapeHtml(formatearFechaHora(momento)) + '</div>' +
      '<div class="field-sub">' + escapeHtml(tiempoRelativoTexto(momento, ahora)) + '</div>';
  }

  function construirEmpresaHtml(ciudad, tipologia) {
    return '<div class="field-label">Empresa</div>' +
      '<div class="field-value">' + escapeHtml(ciudad) + '</div>' +
      '<div class="field-sub">' + escapeHtml(tipologia) + '</div>';
  }

  function construirConductorHtml(conductor, turno) {
    return '<div class="field-label">Conductor</div>' +
      '<div class="field-value">' + escapeHtml(conductor) + '</div>' +
      '<div class="field-sub">Turno ' + escapeHtml(turno) + '</div>';
  }

  // Script inline que corre en el navegador de QUIEN ABRE el expediente (no en
  // el add-in) -- inicializa el mapa Leaflet con los datos ya resueltos en
  // #mapa-datos (JSON, solo números/arrays, sin necesidad de escapar). Si
  // Leaflet no cargó (sin internet), deja un aviso en el div del mapa sin
  // romper el resto de la tarjeta.
  // CAMBIO (2026-10-01, pedido explícito del usuario): la descarga ahora es
  // una IMAGEN (capturarYDescargarImagen), no el HTML -- el script de abajo
  // corre dentro del iframe oculto donde se renderiza la tarjeta antes de
  // capturarla, y por eso marca `window.__mapaListo = true` en TODA salida
  // posible (con datos, sin datos, con error, tras cargar las teselas) --
  // es la señal que espera el código del add-in antes de tomar la captura,
  // para no fotografiar un mapa a medio cargar.
  // CAMBIO (2026-10-02, bug real visto en campo): el mapa cargaba solo un
  // recuadro chico de teselas en una esquina, con el resto del contenedor
  // gris vacío y sin marcador/polígono visibles -- síntoma clásico de
  // Leaflet midiendo el tamaño del contenedor #mapa ANTES de que el
  // navegador terminara de calcular el layout del documento recién insertado
  // en el iframe (el <script> corre inline, durante el parseo del HTML, no
  // necesariamente después de que el motor de layout ya "asentó" el tamaño
  // real del div). Fix: todo el init se corre un tick despues
  // (setTimeout 0, deja que el navegador haga el layout primero) y se llama
  // mapa.invalidateSize() tanto apenas se crea el mapa como justo antes de
  // avisar que está listo -- invalidateSize() obliga a Leaflet a remedir el
  // contenedor y recalcular las teselas visibles, re-centrando la vista
  // después porque invalidateSize puede correr el encuadre.
  var SCRIPT_INIT_MAPA = "(function () {\n" +
    "  function avisoError() {\n" +
    "    var el = document.getElementById('mapa');\n" +
    "    if (el) el.innerHTML = '<div style=\"padding:28px 10px;text-align:center;font-size:12px;color:#64748b\">No se pudo cargar el mapa (sin conexión a internet).</div>';\n" +
    "    window.__mapaListo = true;\n" +
    "  }\n" +
    "  setTimeout(function () {\n" +
    "  try {\n" +
    "    var datosEl = document.getElementById('mapa-datos');\n" +
    "    var datos = datosEl ? JSON.parse(datosEl.textContent) : null;\n" +
    "    if (!datos || datos.lat == null || datos.lon == null) { window.__mapaListo = true; return; }\n" +
    "    if (typeof L === 'undefined') { avisoError(); return; }\n" +
    "    var mapa = L.map('mapa', { zoomControl: false }).setView([datos.lat, datos.lon], datos.zoom || 15);\n" +
    "    mapa.invalidateSize();\n" +
    "    mapa.setView([datos.lat, datos.lon], datos.zoom || 15);\n" +
    // CAMBIO (2026-10-01, 2 bugs reales en campo seguidos): primero el
    // servidor gratuito de OpenStreetMap bloqueó las solicitudes ("Access
    // blocked -- App is not following the tile usage policy"). Se cambió a
    // CARTO (Voyager), pero CARTO también resultó requerir API key -- sin
    // una, tapa el mapa con una marca de agua "API KEY REQUIRED" en vez de
    // servir las teselas reales. Se cambia a las teselas de Esri
    // (World_Street_Map, server.arcgisonline.com), que SÍ siguen siendo
    // gratuitas sin API key para este volumen de uso y confirmaron traer
    // 'Access-Control-Allow-Origin: *' (verificado en vivo con curl) --
    // necesario para que html2canvas pueda leer los píxeles sin que el
    // canvas quede "tainted". OJO: el esquema de URL de Esri es {z}/{y}/{x}
    // (orden invertido respecto a OSM/CARTO, que usan {z}/{x}/{y}).
    // crossOrigin: true -- hace que Leaflet pida las teselas con el atributo
    // crossorigin="anonymous", requisito del navegador para que html2canvas
    // (useCORS:true) pueda leer esos pixeles al capturar el iframe sin que
    // el canvas quede "tainted" (bloqueado por seguridad).
    "    var capaTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {\n" +
    "      maxZoom: 19, crossOrigin: true,\n" +
    "      attribution: 'Tiles &copy; Esri'\n" +
    "    }).addTo(mapa);\n" +
    // CAMBIO (2026-10-02, pedido explícito): se quitó el contorno de la
    // geocerca de localidad del mapa -- el usuario lo vio y decidió que no
    // aporta. El marcador de la posición se queda.
    "    L.circleMarker([datos.lat, datos.lon], {\n" +
    "      radius: 8, color: '#1d4ed8', weight: 2, fillColor: '#3b82f6', fillOpacity: 0.9\n" +
    "    }).addTo(mapa);\n" +
    "    var yaListo = false;\n" +
    "    function marcarListo() {\n" +
    "      if (yaListo) return;\n" +
    "      yaListo = true;\n" +
    "      mapa.invalidateSize();\n" + // segunda remedición justo antes de capturar, por si el layout cambió entre la creación y ahora
    "      window.__mapaListo = true;\n" +
    "    }\n" +
    "    capaTiles.on('load', marcarListo);\n" +
    "    setTimeout(marcarListo, 5000);\n" + // respaldo si 'load' nunca dispara (ej. tesela parcial fallida)
    "  } catch (e) { avisoError(); }\n" +
    "  }, 0);\n" +
    "})();";

  function construirDondeHtml(posicion, localidadInfo, diferenciaSegundos, ciudadConfigurada) {
    if (!posicion) {
      return '<div class="field-label">Dónde</div>' +
        '<div class="field-value sin-dato">Ubicación no disponible: no se encontró ningún registro GPS en ±' +
        VENTANA_GPS_AMPLIADA_MIN + ' min alrededor del momento de la falla.</div>';
    }
    var localidadTexto = localidadInfo ? localidadInfo.localidad : 'Localidad no determinada';
    var incluidaHtml = localidadInfo
      ? '<div class="field-sub">Incluida en: ' + escapeHtml(localidadInfo.ciudad) + '</div>' : '';
    // CAMBIO (2026-10-02, pedido explícito): distinguir en el texto "esta
    // ciudad todavía no tiene geocercas de localidad configuradas en Geotab"
    // (información accionable -- hay que configurarla) de "sí hay geocercas
    // para esta ciudad pero este punto puntual no cayó en ninguna" (puede
    // pasar en el borde de una zona, no implica que falte configuración).
    var origenHtml = '';
    if (localidadInfo && localidadInfo.origen === 'geocoding') {
      origenHtml = ciudadConfigurada
        ? '<div class="field-sub" style="font-style:italic">Ubicación aproximada (servicio externo) -- este punto no cayó dentro de ninguna geocerca de localidad existente.</div>'
        : '<div class="field-sub" style="font-style:italic">Ubicación aproximada (servicio externo) -- esta ciudad todavía no tiene geocercas de localidad configuradas en Geotab.</div>';
    } else if (!localidadInfo && !ciudadConfigurada) {
      origenHtml = '<div class="field-sub" style="font-style:italic">Esta ciudad todavía no tiene geocercas de localidad configuradas en Geotab.</div>';
    }
    // poligono de la geocerca ya NO se manda al mapa (se quitó el contorno
    // rojo, pedido explícito 2026-10-02) -- solo se usa lat/lon del marcador.
    var datosMapa = { lat: posicion.lat, lon: posicion.lon, zoom: 15 };
    return '<div class="field-label">Dónde</div>' +
      '<div class="field-value' + (localidadInfo ? '' : ' sin-dato') + '">' + escapeHtml(localidadTexto) + '</div>' +
      incluidaHtml +
      origenHtml +
      '<div class="field-sub">' + posicion.lat + ', ' + posicion.lon + '</div>' +
      '<div class="field-sub">GPS más cercano · ' + diferenciaSegundos + ' s de diferencia</div>' +
      '<div class="field-sub">Posición registrada: ' + escapeHtml(formatearFechaHora(posicion.dateTime)) + '</div>' +
      '<div class="field-sub"><a class="ext-link" href="' + escapeHtml(construirLinkGoogleMaps(posicion.lat, posicion.lon)) +
      '" target="_blank" rel="noopener">Abrir en Google Maps</a></div>' +
      '<div class="map-wrap"><div id="mapa" style="height:220px;border-radius:10px;overflow:hidden"></div></div>' +
      '<script type="application/json" id="mapa-datos">' + JSON.stringify(datosMapa) + '</script>' +
      '<script>' + SCRIPT_INIT_MAPA + '</script>';
  }

  function ensamblarExpediente(plantillaHtml, datos) {
    var html = plantillaHtml;
    html = reemplazarBloque(html, '{{MOVIL}}', escapeHtml(datos.movil));
    html = reemplazarBloque(html, '{{PLACA}}', escapeHtml(datos.placa || '—'));
    html = reemplazarBloque(html, '{{NOMBRE_FALLA}}', escapeHtml(datos.nombreFalla));
    html = reemplazarBloque(html, '{{SPN}}', escapeHtml(datos.spn));
    html = reemplazarBloque(html, '{{FMI}}', escapeHtml(datos.fmi));
    html = reemplazarBloque(html, '{{CATEGORIA}}', escapeHtml(datos.categoria));
    html = reemplazarBloque(html, '{{SIGNIFICADO_FMI}}', escapeHtml(datos.significadoFmi));
    html = reemplazarBloque(html, '{{GENERADO}}', escapeHtml(datos.generadoTexto));
    html = reemplazarBloque(html, '<div id="aviso-slot"></div>', datos.avisoSinDatosHtml || '');
    html = reemplazarBloque(html, '<div class="pildoras" id="pildoras-slot"></div>', '<div class="pildoras">' + datos.pildorasHtml + '</div>');
    html = reemplazarBloque(html, '<div class="campo" id="cuando-slot"></div>', '<div class="campo">' + datos.cuandoHtml + '</div>');
    html = reemplazarBloque(html, '<div class="campo" id="empresa-slot"></div>', '<div class="campo">' + datos.empresaHtml + '</div>');
    html = reemplazarBloque(html, '<div class="campo" id="donde-slot"></div>', '<div class="campo">' + datos.dondeHtml + '</div>');
    html = reemplazarBloque(html, '<div class="campo" id="conductor-slot"></div>', '<div class="campo">' + datos.conductorHtml + '</div>');
    return html;
  }

  // Recibe un "caso" ya normalizado (resolverCasoDesdeFila), resuelve GPS +
  // localidad (geocerca), arma el HTML de la tarjeta y dispara la descarga
  // como IMAGEN (ver capturarYDescargarImagen).
  function ensamblarYDescargarExpediente(caso) {
    var partesVeh = codigoYPlacaDeNombre(caso.nombreVehiculo);
    var resultadoConductor = buscarConductor(caso.placa || partesVeh.placa, partesVeh.codigo, caso.momento);
    var turno = clasificarTurno(caso.momento.getHours());
    var ahoraGeneracion = new Date();

    return Promise.all([
      resolverPosicionGps(caso.idVehiculo, caso.momento),
      obtenerZonasLocalidad()
    ]).then(function (r) {
      var posicion = r[0], zonasLocalidad = r[1];

      var localidadZona = posicion ? resolverLocalidad(posicion.lon, posicion.lat, zonasLocalidad.zonas) : null;
      var diferenciaSegundos = posicion ? Math.round(Math.abs(posicion.dateTime - caso.momento) / 1000) : null;

      // CAMBIO (2026-10-02, pedido explícito): distinguir "la ciudad SÍ tiene
      // geocercas configuradas pero este punto no cayó en ninguna" de "esta
      // ciudad todavía no tiene NINGUNA geocerca de localidad" -- lo segundo
      // es información accionable (hay que configurarla en Geotab), no es lo
      // mismo que un punto suelto fuera de cobertura.
      var ciudadNormalizada = quitarAcentos(caso.ciudad || '').trim().toUpperCase();
      var ciudadConfigurada = zonasLocalidad.ciudades.indexOf(ciudadNormalizada) !== -1;

      // Respaldo (pedido explícito 2026-10-02): si no hay geocerca que
      // contenga el punto, se intenta geocodificación inversa externa antes
      // de rendirse con "Localidad no determinada" -- aplica tanto si la
      // ciudad simplemente no tiene geocercas como si las tiene pero esta
      // posición puntual no cayó en ninguna.
      var pLocalidad = (!localidadZona && posicion)
        ? resolverLocalidadPorGeocoding(posicion.lat, posicion.lon)
        : Promise.resolve(localidadZona);

      return pLocalidad.then(function (localidadInfo) {
        var avisoSinDatosHtml = caso.encontrada ? '' :
          '<div class="aviso-sin-datos">⚠ No se encontró ninguna falla real para este vehículo en la ventana consultada -- este expediente documenta únicamente la ubicación disponible alrededor de la fecha/hora ingresada manualmente.</div>';

        var datos = {
          movil: partesVeh.codigo || caso.nombreVehiculo, placa: caso.placa || partesVeh.placa,
          nombreFalla: caso.descripcion, spn: caso.spn, fmi: caso.fmi, categoria: caso.categoria,
          significadoFmi: significadoFmi(caso.fmi),
          generadoTexto: formatearFechaHora(ahoraGeneracion),
          avisoSinDatosHtml: avisoSinDatosHtml,
          pildorasHtml: construirPildorasHtml(caso.criticidad, caso.activo !== false),
          cuandoHtml: construirCuandoHtml(caso.momento, ahoraGeneracion),
          empresaHtml: construirEmpresaHtml(caso.ciudad, caso.tipologia),
          dondeHtml: construirDondeHtml(posicion, localidadInfo, diferenciaSegundos, ciudadConfigurada),
          conductorHtml: construirConductorHtml(textoConductorConGrupo(resultadoConductor), turno)
        };

        var htmlFinal = ensamblarExpediente(PLANTILLA_EXPEDIENTE_EMBEBIDA, datos);
        var nombreArchivo = 'mini_expediente_' + slug(caso.nombreVehiculo) + '_' + aFechaInputValue(new Date()).slice(0, 10) + '.png';
        return capturarYDescargarImagen(htmlFinal, nombreArchivo);
      });
    });
  }

  // Disparado desde el link "📋 Generar expediente" de una fila ya visible en
  // pantalla -- la fila YA ES la selección completa (vehículo+diagnóstico+
  // failureMode+fecha), no hace falta picker.
  function generarExpedienteDesdeFila(it, enlace) {
    if (expedienteEnCurso) return;
    expedienteEnCurso = true;
    var textoOriginal = enlace.textContent;
    enlace.textContent = '⏳ Generando…';
    ensamblarYDescargarExpediente(resolverCasoDesdeFila(it)).catch(function (err) {
      console.error('Alertas (expediente):', err);
      alert('No se pudo generar el expediente: ' + ((err && err.message) || err));
    }).then(function () {
      expedienteEnCurso = false;
      enlace.textContent = textoOriginal;
    });
  }

  var PLANTILLA_EXPEDIENTE_EMBEBIDA = "<!doctype html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Mini Expediente \u2014 Caso de Falla</title>\n<!-- Leaflet (mapa OpenStreetMap embebido, MIT license) -- este HTML se descarga y se\n     abre fuera del sandbox del add-in de Geotab, as\u00ed que puede cargar librer\u00edas\n     externas por CDN sin problema de CSP (mismo precedente que SheetJS en\n     alertasFallas.html). Si no hay internet cuando se abre el expediente, el script\n     inline de abajo detecta que \"L\" no existe y muestra un aviso en vez de romper\n     el resto de la tarjeta. -->\n<link rel=\"stylesheet\" href=\"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css\">\n<script src=\"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js\"></script>\n<style>\n:root{--ink:#0b2454;--accent:#0891b2;--corp:#2563eb;--muted:#64748b;--border:#e2e8f0;--bg:#f1f5f9;--card:#ffffff;\n      --alta:#dc2626;--media:#f59e0b;--baja:#94a3b8;--good:#16a34a}\n*{box-sizing:border-box}\nbody{margin:0;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:#1e293b;font-size:14px;display:flex;justify-content:center}\n.card{width:100%;max-width:480px;background:var(--card);border-radius:16px;padding:22px 20px 18px;box-shadow:0 1px 2px rgba(15,23,42,.05),0 8px 24px rgba(15,23,42,.06)}\n.eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:750}\n.subtitulo{font-size:13px;font-weight:650;color:var(--ink);margin-top:2px}\n.pildoras{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}\n.titulo-movil{font-size:22px;font-weight:800;color:var(--ink);letter-spacing:-.01em;margin:2px 0}\n.titulo-movil .placa{font-size:14px;font-weight:650;color:var(--muted);margin-left:8px}\n.nombre-falla{font-size:15px;font-weight:700;color:#1e293b;line-height:1.3;margin:2px 0 6px}\n.codigo-linea{font-family:'Courier New',monospace;font-size:12.5px;font-weight:750;color:var(--accent);margin-bottom:12px}\n.caja-fmi{background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.45;margin-bottom:18px}\n.campo{margin-bottom:14px}\n.field-label{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:750;margin-bottom:3px}\n.field-value{font-size:14px;font-weight:700;color:#1e293b}\n.field-value.sin-dato{font-weight:600;font-style:italic;color:var(--muted)}\n.field-sub{font-size:12px;color:var(--muted);margin-top:2px;line-height:1.4}\n.map-wrap{margin-top:10px}\na.ext-link{color:var(--accent);text-decoration:none;font-weight:650}\na.ext-link:hover{text-decoration:underline}\n.aviso-sin-datos{background:#fffbeb;border:1px solid #fde68a;color:#92400e;border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:12.5px;font-weight:650;line-height:1.4}\n.sin-dato{color:var(--muted);font-style:italic}\nfooter{text-align:center;color:var(--muted);font-size:10.5px;padding:16px 2px 2px;border-top:1px solid var(--border);margin-top:20px}\n@media print{ body{background:#fff;padding:0} .card{box-shadow:none;max-width:none} }\n</style>\n</head>\n<body>\n\n<div class=\"card\">\n\n  <header>\n    <div class=\"eyebrow\">Telemetry &amp; Fleet Intelligence</div>\n    <div class=\"subtitulo\">Mini expediente de falla</div>\n  </header>\n\n  <div id=\"aviso-slot\"></div>\n\n  <div class=\"pildoras\" id=\"pildoras-slot\"></div>\n\n  <h1 class=\"titulo-movil\">M\u00d3VIL {{MOVIL}} <span class=\"placa\">{{PLACA}}</span></h1>\n  <div class=\"nombre-falla\">{{NOMBRE_FALLA}}</div>\n  <div class=\"codigo-linea\">SPN {{SPN}} / FMI {{FMI}} \u00b7 {{CATEGORIA}}</div>\n\n  <div class=\"caja-fmi\">{{SIGNIFICADO_FMI}}</div>\n\n  <div class=\"campo\" id=\"cuando-slot\"></div>\n  <div class=\"campo\" id=\"empresa-slot\"></div>\n  <div class=\"campo\" id=\"donde-slot\"></div>\n  <div class=\"campo\" id=\"conductor-slot\"></div>\n\n  <footer>Generado {{GENERADO}}</footer>\n\n</div>\n\n</body>\n</html>\n";

  // ===========================================================================
  // Expediente Consolidado: TODAS las fallas activas de UN veh\u00edculo en una sola
  // imagen (en vez de una por c\u00f3digo, como el Mini Expediente de arriba) --
  // pedido expl\u00edcito del usuario, mismo pipeline de captura
  // (capturarYDescargarImagen) y misma tarjeta angosta (480px), pero agrupando
  // v.items por c\u00f3digo y con un mapa de VARIOS marcadores en vez de uno solo.
  // ===========================================================================

  // Agrupa items de un mismo vehiculo por codigo (idDiagnostico + idFailureMode),
  // misma clave que claveEpisodio en resolverCasoDesdeFila -- en la practica cada
  // clave hoy tiene un solo item (obtenerFallasActivas ya dedupea a "ultimo
  // registro por vehiculo+diagnostico+failureMode"), pero se agrupa igual por si
  // alguna vez hay mas de uno activo a la vez bajo la misma clave. Si hay mas de
  // un item en el grupo, 'conteo' > 1, 'criticidad' queda la mas alta del grupo y
  // 'fechaReferencia' la mas reciente (la que se usa para resolver GPS).
  function agruparItemsPorCodigo(items) {
    var porClave = {};
    var orden = [];
    items.forEach(function (it) {
      var clave = it.idDiagnostico + '|' + (it.idFailureMode || 'undefined');
      var g = porClave[clave];
      if (!g) {
        g = porClave[clave] = {
          clave: clave, idDiagnostico: it.idDiagnostico, idFailureMode: it.idFailureMode,
          nombreFalla: it.nombreFalla, spn: it.spn, fmi: it.fmi, categoria: it.categoria,
          criticidad: it.criticidad, conteo: 0, fechaReferencia: it.fecha, posicion: null
        };
        orden.push(clave);
      }
      g.conteo++;
      if ((ORDEN_CRITICIDAD[it.criticidad] || 0) > (ORDEN_CRITICIDAD[g.criticidad] || 0)) g.criticidad = it.criticidad;
      if (it.fecha > g.fechaReferencia) g.fechaReferencia = it.fecha;
    });
    return orden.map(function (clave) { return porClave[clave]; });
  }

  // Una fila <tr> de la tabla resumen -- nota "Ubicaci\u00f3n no disponible" en vez de
  // omitir el c\u00f3digo si resolverPosicionGps no encontr\u00f3 nada (pedido expl\u00edcito).
  function construirFilaResumenConsolidadoHtml(g) {
    var colorCat = COLOR_CATEGORIA_MAPA[g.categoria] || COLOR_CATEGORIA_MAPA.General;
    var colorCrit = COLOR_POR_CRITICIDAD[g.criticidad] || '#94A3B8';
    var ubicacionHtml = g.posicion
      ? '<span class="en-mapa">Ver mapa</span>'
      : '<span class="sin-gps">Ubicaci\u00f3n no disponible</span>';
    return '<tr>' +
      '<td class="codigo-celda">SPN ' + escapeHtml(g.spn) + '<br>FMI ' + escapeHtml(g.fmi) + '</td>' +
      '<td>' + escapeHtml(g.nombreFalla) +
        '<div><span class="badge-cat" style="background:' + colorCat + '">' + escapeHtml(g.categoria) + '</span></div>' +
      '</td>' +
      '<td><span class="badge-criticidad" style="background:' + colorCrit + '">' + escapeHtml(g.criticidad) + '</span></td>' +
      '<td>' + g.conteo + '</td>' +
      '<td>' + ubicacionHtml + '</td>' +
      '<td>' + escapeHtml(formatearFechaHora(g.fechaReferencia)) + '</td>' +
      '</tr>';
  }

  // Leyenda chica debajo del mapa -- SOLO de las categorias que de verdad
  // aparecen entre los codigos de ESTE vehiculo (pedido explicito), no las 12
  // categorias siempre.
  function construirLeyendaConsolidadoHtml(categorias) {
    return categorias.map(function (cat) {
      var color = COLOR_CATEGORIA_MAPA[cat] || COLOR_CATEGORIA_MAPA.General;
      return '<div class="leyenda-item"><span class="leyenda-cuadro" style="background:' + color + '"></span>' + escapeHtml(cat) + '</div>';
    }).join('');
  }

  // Variante de SCRIPT_INIT_MAPA (arriba) para VARIOS marcadores en vez de uno
  // solo -- mismo patron de robustez (setTimeout 0 para dejar que el navegador
  // calcule el layout del iframe antes de medir el contenedor, invalidateSize()
  // tanto al crear el mapa como justo antes de avisar que esta listo, con
  // setView/fitBounds reaplicado despues de cada invalidateSize()). A
  // diferencia del mapa de un solo codigo, ACA si hace falta fitBounds porque
  // puede haber marcadores en lugares distintos -- si solo queda 1 marcador con
  // posicion valida, fitBounds no da un encuadre util (un punto no tiene area),
  // asi que se usa setView normal en ese caso. No se modifica SCRIPT_INIT_MAPA
  // original -- el Mini Expediente de un solo codigo sigue usandolo tal cual.
  // CAMBIO (2026-10-02, bug real visto en campo): a diferencia del mapa de un
  // solo c\u00f3digo (que centra UNA vez y nunca vuelve a mover la vista), este
  // mapa consolidado necesita encuadrar TODOS los marcadores -- el bug era
  // que `reencuadrar()`/`fitBounds()` corr\u00eda DESPU\u00c9S de agregar la capa de
  // teselas, as\u00ed que el cambio de vista disparaba una SEGUNDA carga
  // as\u00edncrona de teselas que la captura no esperaba (el mapa quedaba con
  // teselas del encuadre viejo, chicas, en una esquina, y los marcadores ya
  // posicionados seg\u00fan el encuadre nuevo -- exactamente lo que se vio en la
  // imagen real). Fix: se calculan los bounds finales ANTES de tocar
  // Leaflet, se aplican con invalidateSize() sobre el mapa YA encuadrado
  // correctamente, y RECI\u00c9N DESPU\u00c9S se agrega la capa de teselas -- as\u00ed la
  // vista nunca cambia una vez que las teselas ya se empezaron a pedir, no
  // hace falta una segunda espera.
  var SCRIPT_INIT_MAPA_CONSOLIDADO = "(function () {\n" +
    "  function avisoError() {\n" +
    "    var el = document.getElementById('mapa');\n" +
    "    if (el) el.innerHTML = '<div style=\"padding:28px 10px;text-align:center;font-size:12px;color:#64748b\">No se pudo cargar el mapa (sin conexi\u00f3n a internet).</div>';\n" +
    "    window.__mapaListo = true;\n" +
    "  }\n" +
    "  function avisoSinPuntos() {\n" +
    "    var el = document.getElementById('mapa');\n" +
    "    if (el) el.innerHTML = '<div style=\"padding:28px 10px;text-align:center;font-size:12px;color:#64748b\">Ninguno de los c\u00f3digos tiene ubicaci\u00f3n GPS disponible.</div>';\n" +
    "    window.__mapaListo = true;\n" +
    "  }\n" +
    "  setTimeout(function () {\n" +
    "  try {\n" +
    "    var datosEl = document.getElementById('mapa-datos');\n" +
    "    var datos = datosEl ? JSON.parse(datosEl.textContent) : null;\n" +
    "    var puntos = (datos && datos.puntos) ? datos.puntos : [];\n" +
    "    if (!puntos.length) { avisoSinPuntos(); return; }\n" +
    "    if (typeof L === 'undefined') { avisoError(); return; }\n" +
    "    var mapa = L.map('mapa', { zoomControl: false }).setView([puntos[0].lat, puntos[0].lon], 15);\n" +
    "    mapa.invalidateSize();\n" +
    "    if (puntos.length > 1) {\n" +
    "      var bounds = L.latLngBounds(puntos.map(function (p) { return [p.lat, p.lon]; }));\n" +
    "      mapa.fitBounds(bounds, { padding: [16, 16] });\n" +
    "    } else {\n" +
    "      mapa.setView([puntos[0].lat, puntos[0].lon], 15);\n" +
    "    }\n" +
    "    var capaTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {\n" +
    "      maxZoom: 19, crossOrigin: true,\n" +
    "      attribution: 'Tiles &copy; Esri'\n" +
    "    }).addTo(mapa);\n" +
    "    puntos.forEach(function (p) {\n" +
    "      L.circleMarker([p.lat, p.lon], {\n" +
    "        radius: 8, color: '#1e293b', weight: 1.5, fillColor: p.color || '#94a3b8', fillOpacity: 0.9\n" +
    "      }).addTo(mapa);\n" +
    "    });\n" +
    "    var yaListo = false;\n" +
    "    function marcarListo() {\n" +
    "      if (yaListo) return;\n" +
    "      yaListo = true;\n" +
    "      window.__mapaListo = true;\n" + // sin invalidateSize() acá a propósito -- podría disparar otra carga de teselas justo antes de capturar, el mismo bug que se acaba de corregir
    "    }\n" +
    "    capaTiles.on('load', marcarListo);\n" +
    "    setTimeout(marcarListo, 5000);\n" +
    "  } catch (e) { avisoError(); }\n" +
    "  }, 0);\n" +
    "})();";

  // Arma el div del mapa + el JSON de puntos + el script de init, mismo patron
  // de slot que construirDondeHtml. Solo entran al mapa los grupos que SI
  // resolvieron posicion (los sin GPS ya quedan marcados en la tabla resumen,
  // no se les inventa una coordenada).
  function construirMapaConsolidadoHtml(grupos) {
    var puntos = grupos.filter(function (g) { return g.posicion; }).map(function (g) {
      return { lat: g.posicion.lat, lon: g.posicion.lon, color: COLOR_CATEGORIA_MAPA[g.categoria] || COLOR_CATEGORIA_MAPA.General };
    });
    var datosMapa = { puntos: puntos };
    return '<div class="map-wrap"><div id="mapa" style="height:240px;border-radius:10px;overflow:hidden"></div></div>' +
      '<script type="application/json" id="mapa-datos">' + JSON.stringify(datosMapa) + '</script>' +
      '<script>' + SCRIPT_INIT_MAPA_CONSOLIDADO + '</script>';
  }

  function ensamblarExpedienteConsolidado(plantillaHtml, datos) {
    var html = plantillaHtml;
    html = reemplazarBloque(html, '{{MOVIL}}', escapeHtml(datos.movil));
    html = reemplazarBloque(html, '{{PLACA}}', escapeHtml(datos.placa || '\u2014'));
    html = reemplazarBloque(html, '{{CIUDAD}}', escapeHtml(datos.ciudad));
    html = reemplazarBloque(html, '{{MARCA}}', escapeHtml(datos.marca));
    html = reemplazarBloque(html, '{{REFERENCIA_MOTOR}}', escapeHtml(datos.referenciaMotor));
    html = reemplazarBloque(html, '{{N_MOTOR}}', escapeHtml(datos.nMotor));
    html = reemplazarBloque(html, '{{TOTAL_CODIGOS}}', String(datos.totalCodigos));
    html = reemplazarBloque(html, '{{GENERADO}}', escapeHtml(datos.generadoTexto));
    html = reemplazarBloque(html, '<tbody id="resumen-filas-slot"></tbody>', '<tbody>' + datos.filasResumenHtml + '</tbody>');
    html = reemplazarBloque(html, '<div id="mapa-slot"></div>', datos.mapaHtml);
    html = reemplazarBloque(html, '<div class="leyenda" id="leyenda-slot"></div>', '<div class="leyenda">' + datos.leyendaHtml + '</div>');
    return html;
  }

  // Recibe 'v' (un vehiculo completo de agruparPorVehiculo, con v.items) --
  // agrupa por codigo, resuelve GPS de cada grupo EN PARALELO (Promise.all,
  // pedido explicito), arma el HTML y dispara la descarga como imagen (mismo
  // capturarYDescargarImagen generico que ya usa el Mini Expediente de un solo
  // codigo).
  function ensamblarYDescargarExpedienteConsolidado(v) {
    var grupos = agruparItemsPorCodigo(v.items);
    var primerItem = v.items[0];
    var partesVeh = codigoYPlacaDeNombre(primerItem.nombreVehiculo);
    var ahoraGeneracion = new Date();

    return Promise.all(grupos.map(function (g) {
      return resolverPosicionGps(v.idVehiculo, g.fechaReferencia).then(function (posicion) {
        g.posicion = posicion;
      });
    })).then(function () {
      var categoriasPresentes = [];
      grupos.forEach(function (g) { if (categoriasPresentes.indexOf(g.categoria) === -1) categoriasPresentes.push(g.categoria); });

      var datos = {
        movil: partesVeh.codigo || primerItem.nombreVehiculo, placa: primerItem.placa || partesVeh.placa,
        ciudad: v.ciudad, marca: v.marca, referenciaMotor: v.referenciaMotor, nMotor: v.nMotor,
        totalCodigos: grupos.length,
        generadoTexto: formatearFechaHora(ahoraGeneracion),
        filasResumenHtml: grupos.map(construirFilaResumenConsolidadoHtml).join(''),
        mapaHtml: construirMapaConsolidadoHtml(grupos),
        leyendaHtml: construirLeyendaConsolidadoHtml(categoriasPresentes)
      };

      var htmlFinal = ensamblarExpedienteConsolidado(PLANTILLA_EXPEDIENTE_CONSOLIDADO_EMBEBIDA, datos);
      var nombreArchivo = 'expediente_consolidado_' + slug(v.claveVehiculo) + '_' + aFechaInputValue(new Date()).slice(0, 10) + '.png';
      return capturarYDescargarImagen(htmlFinal, nombreArchivo);
    });
  }

  // Disparado desde el bot\u00f3n "\ud83d\udcca Generar Expediente Consolidado" de la cabecera
  // de una tarjeta de veh\u00edculo -- mismo patr\u00f3n deshabilitar-mientras-genera que
  // generarExpedienteDesdeFila, y comparte el MISMO flag expedienteEnCurso (una
  // sola imagen a la vez en todo el add-in, sea mini expediente o consolidado,
  // para no correr dos capturas con iframe/html2canvas en simult\u00e1neo).
  function generarExpedienteConsolidadoDesdeBoton(v, boton) {
    if (expedienteEnCurso) return;
    expedienteEnCurso = true;
    var textoOriginal = boton.textContent;
    boton.disabled = true;
    boton.textContent = '\u23f3 Generando\u2026';
    ensamblarYDescargarExpedienteConsolidado(v).catch(function (err) {
      console.error('Alertas (expediente consolidado):', err);
      alert('No se pudo generar el expediente consolidado: ' + ((err && err.message) || err));
    }).then(function () {
      expedienteEnCurso = false;
      boton.disabled = false;
      boton.textContent = textoOriginal;
    });
  }

  var PLANTILLA_EXPEDIENTE_CONSOLIDADO_EMBEBIDA = "<!doctype html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Expediente Consolidado \u2014 Resumen de Fallas</title>\n<!-- Leaflet (mismo CDN/versi\u00f3n que reporte_expediente_plantilla.html) -- este HTML se\n     descarga y se abre fuera del sandbox del add-in, puede cargar librer\u00edas externas\n     por CDN sin problema de CSP. Si no hay internet cuando se abre, el script inline\n     de abajo detecta que \"L\" no existe y muestra un aviso sin romper el resto. -->\n<link rel=\"stylesheet\" href=\"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css\">\n<script src=\"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js\"></script>\n<style>\n:root{--ink:#0b2454;--accent:#0891b2;--corp:#2563eb;--muted:#64748b;--border:#e2e8f0;--bg:#f1f5f9;--card:#ffffff;\n      --alta:#dc2626;--media:#f59e0b;--baja:#94a3b8;--good:#16a34a}\n*{box-sizing:border-box}\nbody{margin:0;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:#1e293b;font-size:14px;display:flex;justify-content:center}\n.card{width:100%;max-width:480px;background:var(--card);border-radius:16px;padding:22px 20px 18px;box-shadow:0 1px 2px rgba(15,23,42,.05),0 8px 24px rgba(15,23,42,.06)}\n.eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:750}\n.subtitulo{font-size:13px;font-weight:650;color:var(--ink);margin-top:2px}\n.titulo-movil{font-size:22px;font-weight:800;color:var(--ink);letter-spacing:-.01em;margin:10px 0 2px}\n.titulo-movil .placa{font-size:14px;font-weight:650;color:var(--muted);margin-left:8px}\n.field-sub{font-size:12px;color:var(--muted);margin-top:2px;line-height:1.4}\n.seccion-titulo{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:750;margin:18px 0 8px;border-top:1px solid var(--border);padding-top:14px}\ntable.dt{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:4px;table-layout:fixed}\ntable.dt th{text-align:left;padding:5px 4px;font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border-bottom:1px solid var(--border);font-weight:750}\ntable.dt td{padding:6px 4px;border-bottom:1px solid var(--border);vertical-align:top;word-break:break-word;line-height:1.35}\ntable.dt th:nth-child(1), table.dt td:nth-child(1){width:58px}\ntable.dt th:nth-child(3), table.dt td:nth-child(3){width:50px;text-align:center}\ntable.dt th:nth-child(4), table.dt td:nth-child(4){width:28px;text-align:center}\ntable.dt th:nth-child(5), table.dt td:nth-child(5){width:62px}\ntable.dt th:nth-child(6), table.dt td:nth-child(6){width:72px;font-size:10px}\n.codigo-celda{font-family:'Courier New',monospace;font-weight:700;color:var(--accent)}\n.badge-cat{display:inline-block;padding:1px 7px;border-radius:999px;color:#fff;font-size:9px;font-weight:700;margin-top:3px}\n.badge-criticidad{display:inline-block;min-width:38px;text-align:center;padding:2px 6px;border-radius:999px;color:#fff;font-weight:700;font-size:9.5px}\n.sin-gps{font-style:italic;color:var(--muted);font-size:10px}\n.en-mapa{color:var(--muted);font-size:10px}\n.map-wrap{margin-top:6px}\n.leyenda{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;font-size:11px;color:#1e293b}\n.leyenda-item{display:flex;align-items:center;gap:6px}\n.leyenda-cuadro{width:10px;height:10px;border-radius:2px;display:inline-block;flex:none}\nfooter{text-align:center;color:var(--muted);font-size:10.5px;padding:16px 2px 2px;border-top:1px solid var(--border);margin-top:20px}\n@media print{ body{background:#fff;padding:0} .card{box-shadow:none;max-width:none} }\n</style>\n</head>\n<body>\n\n<div class=\"card\">\n\n  <header>\n    <div class=\"eyebrow\">Telemetry &amp; Fleet Intelligence</div>\n    <div class=\"subtitulo\">Expediente consolidado de fallas</div>\n  </header>\n\n  <h1 class=\"titulo-movil\">M\u00d3VIL {{MOVIL}} <span class=\"placa\">{{PLACA}}</span></h1>\n  <div class=\"field-sub\">{{CIUDAD}} \u00b7 {{MARCA}} \u00b7 Motor: {{REFERENCIA_MOTOR}} ({{N_MOTOR}})</div>\n\n  <div class=\"seccion-titulo\">Resumen de c\u00f3digos activos ({{TOTAL_CODIGOS}})</div>\n  <table class=\"dt\">\n    <thead>\n      <tr><th>C\u00f3digo</th><th>Descripci\u00f3n</th><th>Criticidad</th><th>Veces</th><th>Ubicaci\u00f3n</th><th>\u00daltimo reporte</th></tr>\n    </thead>\n    <tbody id=\"resumen-filas-slot\"></tbody>\n  </table>\n\n  <div class=\"seccion-titulo\">Ubicaci\u00f3n de los c\u00f3digos</div>\n  <div id=\"mapa-slot\"></div>\n\n  <div class=\"leyenda\" id=\"leyenda-slot\"></div>\n\n  <footer>Generado {{GENERADO}}</footer>\n\n</div>\n\n</body>\n</html>\n";

  function crearPildoraCriticidad(criticidad) {
    return crear('span', {
      display: 'inline-block', minWidth: '46px', textAlign: 'center', padding: '3px 10px',
      borderRadius: T.radius.pill, background: COLOR_POR_CRITICIDAD[criticidad] || T.color.muted,
      color: '#FFFFFF', fontWeight: '700', fontSize: '0.72rem'
    }, criticidad);
  }

  // Badge de estado (Activo/Inactivo) para la fila -- en "Mas reciente primero"
  // hoy siempre sale 'Activo' porque esta vista solo trae fallas con
  // faultState==='Active' (a proposito, a pedido del usuario); el badge queda
  // igual como confirmacion visual explicita en vez de solo inferirlo.
  function crearPildoraEstadoActivo(activo) {
    return crear('span', {
      display: 'inline-block', padding: '2px 8px', borderRadius: T.radius.pill,
      background: activo ? '#DCFCE7' : '#F1F5F9', color: activo ? '#15803D' : '#64748B',
      fontWeight: '700', fontSize: '0.68rem', marginLeft: '6px'
    }, activo ? 'Activo' : 'Inactivo');
  }

  function crearTarjetaVehiculo(v) {
    var tarjeta = crearPanel({ marginBottom: '12px', overflow: 'hidden' });

    var cabecera = crear('div', {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px',
      background: T.color.vehiculoHeader, padding: '10px 16px'
    });

    var infoVehiculo = crear('div', { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' });
    infoVehiculo.appendChild(crear('span', { fontWeight: '700', fontStyle: 'italic', color: T.color.textoOscuro, fontSize: '0.9rem' },
      'Placa: ' + v.claveVehiculo));
    // CAMBIO (2026-10-02, pedido explícito -- más contraste): antes
    // T.color.textoGris (#6B7280, casi no se notaba sobre el fondo gris-azul de
    // la cabecera) -- ahora un gris oscuro real (#334155), fuente más grande e
    // iconos sutiles (📍 ciudad, ⚙️ motor) para que esta línea no quede
    // perdida al lado de la placa en negrita.
    infoVehiculo.appendChild(crear('span', { color: '#334155', fontSize: '0.86rem', fontWeight: '600' },
      '📍 ' + v.ciudad + ' | ' + v.marca + ' | ⚙️ Motor: ' + v.referenciaMotor + ' (' + v.nMotor + ')'));
    cabecera.appendChild(infoVehiculo);

    // Expediente Consolidado (2026-10-02, pedido explícito): a diferencia de
    // "📋 Generar expediente" (una fila = un código), este botón vive en la
    // cabecera porque opera sobre TODO v.items del vehículo, no sobre una fila
    // puntual de la tabla.
    var botonConsolidado = crear('button', {
      padding: '6px 12px', borderRadius: T.radius.sm, border: 'none',
      background: T.color.primary, color: '#FFFFFF', fontWeight: '700', fontSize: '0.76rem',
      cursor: 'pointer', whiteSpace: 'nowrap'
    }, '📊 Generar Expediente Consolidado');
    botonConsolidado.addEventListener('click', function () { generarExpedienteConsolidadoDesdeBoton(v, botonConsolidado); });
    cabecera.appendChild(botonConsolidado);

    tarjeta.appendChild(cabecera);

    var tabla = crear('table', { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' });
    var encabezadoTabla = crear('tr');
    ['Nivel', 'Código', 'Sistema', 'Descripción del diagnóstico', 'Fecha reporte', 'Turno', 'Conductor', ''].forEach(function (titulo) {
      encabezadoTabla.appendChild(crear('th', {
        textAlign: 'left', padding: '8px 10px', fontSize: '0.72rem', textTransform: 'uppercase',
        color: T.color.textoGris, borderBottom: '1px solid ' + T.color.border
      }, titulo));
    });
    tabla.appendChild(encabezadoTabla);

    v.items.forEach(function (it) {
      var fila = crear('tr');
      var celdaNivelVeh = crear('td', { padding: '8px 10px', borderBottom: '1px solid ' + T.color.border, whiteSpace: 'nowrap' });
      celdaNivelVeh.appendChild(crearPildoraCriticidad(it.criticidad));
      celdaNivelVeh.appendChild(crearPildoraEstadoActivo(!!it.activo));
      fila.appendChild(celdaNivelVeh);

      fila.appendChild(crear('td', {
        padding: '8px 10px', borderBottom: '1px solid ' + T.color.border, fontFamily: "'Courier New', monospace",
        color: '#0284C7', fontWeight: '700', whiteSpace: 'nowrap'
      }, 'SPN ' + it.spn + '/FMI ' + it.fmi));

      fila.appendChild(crear('td', {
        padding: '8px 10px', borderBottom: '1px solid ' + T.color.border, fontWeight: '700', color: T.color.textoOscuro
      }, it.categoria));

      var celdaDescripcion = crear('td', { padding: '8px 10px', borderBottom: '1px solid ' + T.color.border });
      var textoDescripcion = it.destacado ? it.nombreFalla.toUpperCase() : it.nombreFalla;
      celdaDescripcion.appendChild(crear('span', {
        color: it.destacado ? COLOR_DESTACADO : T.color.textoOscuro,
        fontWeight: it.destacado ? '700' : '400'
      }, textoDescripcion));
      fila.appendChild(celdaDescripcion);

      fila.appendChild(crear('td', {
        padding: '8px 10px', borderBottom: '1px solid ' + T.color.border, color: T.color.textoGris, whiteSpace: 'nowrap'
      }, formatearFechaHora(it.fecha)));

      fila.appendChild(crear('td', {
        padding: '8px 10px', borderBottom: '1px solid ' + T.color.border, color: T.color.textoGris, whiteSpace: 'nowrap'
      }, it.turno || '—'));

      var partesVeh = codigoYPlacaDeNombre(it.nombreVehiculo);
      var resultadoConductor = buscarConductor(it.placa || partesVeh.placa, partesVeh.codigo, it.fecha);
      var colorConductor = !resultadoConductor ? T.color.muted : (resultadoConductor.aproximado ? '#B45309' : T.color.textoOscuro);
      fila.appendChild(crear('td', {
        padding: '8px 10px', borderBottom: '1px solid ' + T.color.border,
        color: colorConductor, fontStyle: resultadoConductor ? 'normal' : 'italic'
      }, textoConductorConGrupo(resultadoConductor)));

      var celdaBuscar = crear('td', {
        padding: '8px 10px', borderBottom: '1px solid ' + T.color.border, whiteSpace: 'nowrap',
        display: 'flex', gap: '10px', alignItems: 'center'
      });
      var link = crear('a', { color: T.color.primaryDark, fontSize: '0.75rem', fontWeight: '600' }, '🔍 Buscar causa');
      link.href = urlBusquedaCausa(it.spn, it.fmi);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      celdaBuscar.appendChild(link);

      var filaHistorial = crear('tr');
      var celdaHistorial = crear('td', { padding: '0 10px 10px 10px', borderBottom: '1px solid ' + T.color.border });
      celdaHistorial.colSpan = 8;
      filaHistorial.appendChild(celdaHistorial);
      filaHistorial.hidden = true;

      var linkHistorial = crear('a', { color: T.color.textoGris, fontSize: '0.75rem', fontWeight: '600', cursor: 'pointer' }, '🕘 Ver historial');
      var cargado = false;
      linkHistorial.addEventListener('click', function () {
        filaHistorial.hidden = !filaHistorial.hidden;
        if (!filaHistorial.hidden && !cargado) {
          cargado = true;
          var panel = crearPanelHistorial();
          celdaHistorial.appendChild(panel);
          obtenerHistorialFalla(it.idVehiculo, it.idDiagnostico, it.idFailureMode).then(function (historial) {
            llenarPanelHistorial(panel, historial);
          });
        }
      });
      celdaBuscar.appendChild(linkHistorial);

      // Mini Expediente (2026-10-01): la fila YA ES la selección completa
      // (vehículo+diagnóstico+failureMode+fecha) -- sin picker, un clic basta.
      var linkExpediente = crear('a', { color: T.color.primaryDark, fontSize: '0.75rem', fontWeight: '600', cursor: 'pointer' }, '📋 Generar expediente');
      linkExpediente.addEventListener('click', function () { generarExpedienteDesdeFila(it, linkExpediente); });
      celdaBuscar.appendChild(linkExpediente);

      fila.appendChild(celdaBuscar);

      tabla.appendChild(fila);
      tabla.appendChild(filaHistorial);
    });

    tarjeta.appendChild(tabla);
    return tarjeta;
  }

  // --- Render principal --------------------------------------------------
  function renderizarResultados(contenedor, resultado) {
    while (contenedor.firstChild) contenedor.removeChild(contenedor.firstChild);

    var vehiculosFiltrados = aplicarFiltros(resultado.vehiculos);

    if (resultado.vehiculos.length === 0) {
      // Puerto de las dos ramas distintas en generar_pdf_reporte_fallas: "nada
      // paso" (exito) vs "algo paso pero todo era irrelevante" (aclarar cuanto
      // se oculto, no mostrar el mensaje de exito que seria enganoso).
      var panelVacio = crearPanel({ padding: '30px', textAlign: 'center' });
      if (resultado.totalOcultas > 0) {
        panelVacio.appendChild(crear('div', { color: T.color.body, fontWeight: '700', fontSize: '0.9rem' },
          'No hay fallas activas relevantes en este momento (se ocultaron ' + resultado.totalOcultas +
          ' de conectividad/diagnóstico desconocido).'));
      } else {
        panelVacio.appendChild(crear('div', { color: T.color.primaryDark, fontWeight: '700', fontSize: '0.9rem' },
          '✅ No hay fallas activas en este momento. ¡Excelente!'));
      }
      contenedor.appendChild(panelVacio);
      return;
    }

    construirResumen(contenedor, resultado.vehiculos, resultado.totalOcultas);

    if (vehiculosFiltrados.length === 0) {
      var vacio = crearPanel({ padding: '24px', textAlign: 'center' });
      vacio.appendChild(crear('div', { color: T.color.body, fontSize: '0.85rem' },
        'Ningún vehículo coincide con los filtros actuales.' + (tieneFiltrosActivos() ? ' Probá quitando alguno.' : '')));
      contenedor.appendChild(vacio);
      return;
    }

    if (modoVista === 'cronologico') {
      var filas = aplanarFallas(vehiculosFiltrados);
      contenedor.appendChild(construirTablaCronologica(filas));
      return;
    }

    // Sin secciones por criticidad -- una sola lista de tarjetas, ya viene
    // ordenada (mas critico primero) desde agruparPorVehiculo, igual que el PDF.
    vehiculosFiltrados.forEach(function (v) { contenedor.appendChild(crearTarjetaVehiculo(v)); });
  }

  // --- Vista cronologica: todas las fallas filtradas en una sola tabla, la
  // mas reciente arriba, con vehiculo por fila ya que no esta agrupado. -----
  function construirTablaCronologica(filas) {
    var panel = crearPanel({ marginBottom: '12px', overflow: 'hidden' });

    if (filas.length === 0) {
      panel.appendChild(crear('div', { padding: '24px', textAlign: 'center', color: T.color.body, fontSize: '0.85rem' },
        'Ningún vehículo coincide con los filtros actuales.' + (tieneFiltrosActivos() ? ' Probá quitando alguno.' : '')));
      return panel;
    }

    var tabla = crear('table', { width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' });
    var encabezadoTabla = crear('tr');
    ['Fecha', 'Vehículo', 'Nivel', 'Código', 'Sistema', 'Descripción del diagnóstico', 'Turno', 'Conductor', ''].forEach(function (titulo) {
      encabezadoTabla.appendChild(crear('th', {
        textAlign: 'left', padding: '8px 10px', fontSize: '0.72rem', textTransform: 'uppercase',
        color: T.color.textoGris, borderBottom: '1px solid ' + T.color.border, background: T.color.vehiculoHeader
      }, titulo));
    });
    tabla.appendChild(encabezadoTabla);

    filas.forEach(function (it) {
      var fila = crear('tr');
      fila.appendChild(crear('td', {
        padding: '8px 10px', borderBottom: '1px solid ' + T.color.border, color: T.color.textoGris, whiteSpace: 'nowrap'
      }, formatearFechaHora(it.fecha)));

      fila.appendChild(crear('td', {
        padding: '8px 10px', borderBottom: '1px solid ' + T.color.border, fontStyle: 'italic', fontWeight: '600',
        color: T.color.textoOscuro, whiteSpace: 'nowrap'
      }, it.claveVehiculo));

      var celdaNivel = crear('td', { padding: '8px 10px', borderBottom: '1px solid ' + T.color.border, whiteSpace: 'nowrap' });
      celdaNivel.appendChild(crearPildoraCriticidad(it.criticidad));
      celdaNivel.appendChild(crearPildoraEstadoActivo(!!it.activo));
      fila.appendChild(celdaNivel);

      fila.appendChild(crear('td', {
        padding: '8px 10px', borderBottom: '1px solid ' + T.color.border, fontFamily: "'Courier New', monospace",
        color: '#0284C7', fontWeight: '700', whiteSpace: 'nowrap'
      }, 'SPN ' + it.spn + '/FMI ' + it.fmi));

      fila.appendChild(crear('td', {
        padding: '8px 10px', borderBottom: '1px solid ' + T.color.border, fontWeight: '700', color: T.color.textoOscuro
      }, it.categoria));

      var celdaDescripcion = crear('td', { padding: '8px 10px', borderBottom: '1px solid ' + T.color.border });
      var textoDescripcion = it.destacado ? it.nombreFalla.toUpperCase() : it.nombreFalla;
      celdaDescripcion.appendChild(crear('span', {
        color: it.destacado ? COLOR_DESTACADO : T.color.textoOscuro,
        fontWeight: it.destacado ? '700' : '400'
      }, textoDescripcion));
      fila.appendChild(celdaDescripcion);

      fila.appendChild(crear('td', {
        padding: '8px 10px', borderBottom: '1px solid ' + T.color.border, color: T.color.textoGris, whiteSpace: 'nowrap'
      }, it.turno || '—'));

      var partesVehCron = codigoYPlacaDeNombre(it.nombreVehiculo);
      var resultadoConductorCron = buscarConductor(it.placa || partesVehCron.placa, partesVehCron.codigo, it.fecha);
      var colorConductorCron = !resultadoConductorCron ? T.color.muted : (resultadoConductorCron.aproximado ? '#B45309' : T.color.textoOscuro);
      fila.appendChild(crear('td', {
        padding: '8px 10px', borderBottom: '1px solid ' + T.color.border,
        color: colorConductorCron, fontStyle: resultadoConductorCron ? 'normal' : 'italic'
      }, textoConductorConGrupo(resultadoConductorCron)));

      var celdaAcciones = crear('td', {
        padding: '8px 10px', borderBottom: '1px solid ' + T.color.border, whiteSpace: 'nowrap',
        display: 'flex', gap: '10px', alignItems: 'center'
      });
      var link = crear('a', { color: T.color.primaryDark, fontSize: '0.75rem', fontWeight: '600' }, '🔍 Buscar causa');
      link.href = urlBusquedaCausa(it.spn, it.fmi);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      celdaAcciones.appendChild(link);

      var filaHistorial = crear('tr');
      var celdaHistorial = crear('td', { padding: '0 10px 10px 10px', borderBottom: '1px solid ' + T.color.border });
      celdaHistorial.colSpan = 9;
      filaHistorial.appendChild(celdaHistorial);
      filaHistorial.hidden = true;

      var linkHistorial = crear('a', { color: T.color.textoGris, fontSize: '0.75rem', fontWeight: '600', cursor: 'pointer' }, '🕘 Ver historial');
      var cargado = false;
      linkHistorial.addEventListener('click', function () {
        filaHistorial.hidden = !filaHistorial.hidden;
        if (!filaHistorial.hidden && !cargado) {
          cargado = true;
          var panelHist = crearPanelHistorial();
          celdaHistorial.appendChild(panelHist);
          obtenerHistorialFalla(it.idVehiculo, it.idDiagnostico, it.idFailureMode).then(function (historial) {
            llenarPanelHistorial(panelHist, historial);
          });
        }
      });
      celdaAcciones.appendChild(linkHistorial);

      // Mini Expediente (2026-10-01): misma acción que en la vista por
      // vehículo (crearTarjetaVehiculo) -- se agrega también aquí para que
      // la vista cronológica (mismas filas, aplanadas) no quede inconsistente.
      var linkExpedienteCron = crear('a', { color: T.color.primaryDark, fontSize: '0.75rem', fontWeight: '600', cursor: 'pointer' }, '📋 Generar expediente');
      linkExpedienteCron.addEventListener('click', function () { generarExpedienteDesdeFila(it, linkExpedienteCron); });
      celdaAcciones.appendChild(linkExpedienteCron);

      fila.appendChild(celdaAcciones);

      tabla.appendChild(fila);
      tabla.appendChild(filaHistorial);
    });

    panel.appendChild(tabla);
    return panel;
  }

  function mostrarCargando(contenedor) {
    while (contenedor.firstChild) contenedor.removeChild(contenedor.firstChild);
    var envoltorio = crear('div', { padding: '40px 22px', textAlign: 'center' });
    envoltorio.appendChild(crear('div', { fontSize: '0.85rem', color: T.color.body, fontWeight: '600' }, 'Cargando fallas activas…'));
    contenedor.appendChild(envoltorio);
  }

  function mostrarError(contenedor, mensaje) {
    while (contenedor.firstChild) contenedor.removeChild(contenedor.firstChild);
    var envoltorio = crear('div', {
      padding: '24px', background: T.color.dangerSoft, border: '1px solid ' + T.color.dangerBorder, borderRadius: T.radius.md
    });
    envoltorio.appendChild(crear('div', { color: T.color.danger, fontWeight: '700', marginBottom: '4px' }, 'No se pudo cargar la información'));
    envoltorio.appendChild(crear('div', { color: T.color.body, fontSize: '0.82rem' }, mensaje));
    contenedor.appendChild(envoltorio);
  }

  // --- Orquestacion --------------------------------------------------------
  var contenedorPrincipal = null;
  var contenedorResultados = null;
  var idIntervaloAutoRefresco = null;

  function actualizarRangoDefecto() {
    var desde = inicioDeHoy();
    var hasta = new Date();
    elementos.inputDesde.value = aFechaInputValue(desde);
    elementos.inputHasta.value = aFechaInputValue(hasta);
    guardarRango(elementos.inputDesde.value, elementos.inputHasta.value);
    // true = conservar el filtro de vehiculo -- refresco automatico, boton
    // "Actualizar" y focus() vuelven a lo mismo que se estaba mirando (mismo
    // criterio ya corregido en sobreRevolucionPTO.js).
    cargarYRenderizar(desde, hasta, true);
  }

  function cargarYRenderizar(desde, hasta, conservarFiltroVehiculo) {
    mostrarCargando(contenedorResultados);
    if (!conservarFiltroVehiculo) {
      filtroEstado.vehiculo = null;
      if (barraFiltrosRefs) barraFiltrosRefs.ocultarChipVehiculo();
    }

    obtenerFallasActivas(desde, hasta)
      .then(agregarInfoVehiculo)
      .then(agregarClasificacion)
      .then(agruparPorVehiculo)
      .then(function (resultado) {
        resultadoCache = resultado;
        revisarAlarma(resultado.vehiculos);
        var ciudadesDisponibles = Array.from(new Set(resultado.vehiculos.map(function (v) { return v.ciudad; }))).sort();
        if (barraFiltrosRefs) barraFiltrosRefs.actualizarOpcionesCiudad(ciudadesDisponibles);

        var conteoSistemas = {};
        resultado.vehiculos.forEach(function (v) {
          v.items.forEach(function (it) { conteoSistemas[it.categoria] = (conteoSistemas[it.categoria] || 0) + 1; });
        });
        var sistemasDisponibles = Object.keys(conteoSistemas).sort(function (a, b) { return conteoSistemas[b] - conteoSistemas[a]; });
        if (barraFiltrosRefs) barraFiltrosRefs.actualizarOpcionesSistema(sistemasDisponibles);

        renderizarResultados(contenedorResultados, resultadoCache);
      })
      .catch(function (err) {
        console.error('Alertas:', err);
        mostrarError(contenedorResultados, (err && err.message) ? err.message : 'Error al consultar Geotab.');
      });
  }

  function actualizarVista() {
    renderizarResultados(contenedorResultados, resultadoCache);
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi;
      state = freshState;

      contenedorPrincipal = document.getElementById('alertasFallasRoot');
      aplicarEstilo(contenedorPrincipal, { fontFamily: T.font, background: T.color.canvas, padding: '4px' });

      var refs = construirEncabezado(contenedorPrincipal);
      elementos.inputDesde = refs.inputDesde;
      elementos.inputHasta = refs.inputHasta;

      cargarTripulacionesGuardadas();
      construirControlTripulaciones(contenedorPrincipal, actualizarVista);

      barraFiltrosRefs = construirBarraFiltros(contenedorPrincipal, actualizarVista);

      elementos.bannerAlarma = crear('div', { display: 'none' });
      contenedorPrincipal.appendChild(elementos.bannerAlarma);

      contenedorResultados = crear('div');
      contenedorPrincipal.appendChild(contenedorResultados);

      initializedCallback();
    },

    focus: function (freshApi, freshState) {
      api = freshApi;
      state = freshState;
      if (idIntervaloAutoRefresco) clearInterval(idIntervaloAutoRefresco);
      idIntervaloAutoRefresco = setInterval(actualizarRangoDefecto, INTERVALO_AUTO_REFRESCO_MS);
      actualizarRangoDefecto();
    },

    blur: function () {
      if (idIntervaloAutoRefresco) { clearInterval(idIntervaloAutoRefresco); idIntervaloAutoRefresco = null; }
      detenerRepeticionAlarma();
    }
  };
};
