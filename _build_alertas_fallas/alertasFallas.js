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

   Confirmación (v1.20): solo es "confirmado" un código reportado en las últimas 24 h. Uno más viejo queda "por verificar" si el
   dispositivo comunica, el vehículo se movió >= 5 km y llegan señales del motor; si falla alguna de esas tres pruebas queda
   "sin evidencia" (no se afirma que esté activo ni que no). Lo no confirmado se ve atenuado, no suena y no cuenta en los
   indicadores críticos. FMI 0 ya no se pierde como "?" (v1.18).
   v1.21: lo "sin evidencia" se separa por causa: "falla de dispositivo" (sin comunicar o sin señal del motor), "vehículo parado"
   y "no consultado"; cada uno con su filtro, su enlace en la tarjeta de códigos y el motivo visible en la fila.

   Pantalla (v1.16): tema oscuro "centro de control" (objeto D, ESTILO_NIVEL):
   KPI, barra de control unificada, tabla con filas tintadas por nivel y
   acciones que se encienden al pasar el cursor. Iconos en SVG propio
   (ICONOS) -- sin Tailwind ni FontAwesome. Los expedientes que se descargan
   conservan su HTML claro.
   ============================================================================ */

geotab.addin.alertasFallas = function () {
  'use strict';

  // --- Constantes ------------------------------------------------------------
  var CLAVE_LOCALSTORAGE = 'alertasFallas_rango';
  var CLAVE_LOCALSTORAGE_ALARMA = 'alertasFallas_alarmadas';
  var INTERVALO_AUTO_REFRESCO_MS = 5 * 60 * 1000; // 5 minutos, igual que el add-in de PTO
  // El refresco automático no interrumpe: si se está usando la hoja (mouse, scroll, teclado, toque) queda en pausa y se hace
  // cuando pasan INACTIVIDAD_MS sin actividad. REVISION_PAUSA_MS = cada cuánto se revisa si ya se puede.
  var INACTIVIDAD_MS = 30 * 1000;
  var REVISION_PAUSA_MS = 5 * 1000;
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

  // Confirmación de que un código sigue vivo (v1.20, validada el 2026-11-03 con 45 días de la flota). Un código vivo se
  // reporta varias veces al día: con el último reporte de menos de 24 h el 77-96 % se repite en las 24 h siguientes; con 1 a 3
  // días solo el 29 %. Por eso:
  //   - Confirmado: último reporte de menos de CONFIRMACION_HORAS.
  //   - Por verificar: más viejo, y hay evidencia de que SI debió reportarse: el dispositivo comunica, el vehículo recorrió
  //     MOVIMIENTO_KM_MIN o más desde el reporte (la ignición sola engaña: un motor encendido en el patio no es evidencia) y
  //     llegan señales del motor (si el GPS sigue vivo pero el motor dejó de enviar señales, la falta de reportes no significa
  //     nada: caso 11006-NGY805).
  //   - Sin evidencia: más viejo y falla alguna de las tres condiciones: no se afirma que esté activo ni que no lo esté.
  // Un fallo del dispositivo (o de la consulta) nunca cuenta como prueba de que el código desapareció.
  var CONFIRMACION_HORAS = 24;
  var MOVIMIENTO_KM_MIN = 5;
  var ID_DIAG_RPM_MOTOR = 'aW3Nmy-ktfEuvrdkya4z0yg';   // RPM del motor que sí reporta seguido (el genérico reporta muy poco)

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

  function crearPanel(estilosExtra) {
    var base = {
      background: T.color.surface, borderRadius: T.radius.md,
      border: '1px solid ' + T.color.border, boxShadow: T.shadow.card
    };
    for (var k in estilosExtra) { base[k] = estilosExtra[k]; }
    return crear('div', base);
  }

  // --- Tema oscuro del "centro de control" (lo que se ve dentro de MyGeotab) ---
  // Mismos roles que T pero sobre fondo oscuro. Los expedientes que se descargan
  // siguen con su propio HTML claro (plantillas embebidas más abajo): esto NO los toca.
  var D = {
    bg: '#131722', panel: '#1E222D', panelAlt: '#1A1D24', border: '#2A2E39', borderStrong: '#3B4150',
    text: '#E2E8F0', textSoft: '#CBD5E1', muted: '#94A3B8', faint: '#64748B',
    verde: '#00D084', rojo: '#FF4D4F', naranja: '#FAAD14', azul: '#60A5FA',
    sombra: '0 4px 14px rgba(0,0,0,0.25)'
  };

  // Un solo lugar para el look de cada nivel: pastilla, tinte de fila ("mapa de
  // calor") y color del texto de la descripción.
  var ESTILO_NIVEL = {
    ALTA: {
      color: '#FF4D4F', fondo: 'rgba(255,77,79,0.18)', borde: 'rgba(255,77,79,0.45)', texto: '#FECACA',
      fila: 'rgba(255,77,79,0.10)', filaHover: 'rgba(255,77,79,0.17)', descripcion: '#FECACA'
    },
    MEDIA: {
      color: '#FAAD14', fondo: 'rgba(250,173,20,0.18)', borde: 'rgba(250,173,20,0.45)', texto: '#FDE68A',
      fila: 'rgba(250,173,20,0.08)', filaHover: 'rgba(250,173,20,0.15)', descripcion: '#FDE68A'
    },
    BAJA: {
      color: '#64748B', fondo: 'rgba(148,163,184,0.14)', borde: 'rgba(148,163,184,0.35)', texto: '#CBD5E1',
      fila: 'transparent', filaHover: 'rgba(255,255,255,0.04)', descripcion: '#94A3B8'
    }
  };

  // Iconos propios en SVG (trazo, 24x24): FontAwesome/Tailwind por CDN no se pueden
  // usar aquí. Son constantes del código, no llevan datos de Geotab.
  var ICONOS = {
    alerta: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    circulo: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    barras: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
    calendario: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    buscar: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    actualizar: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    hoja: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    historial: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/><polyline points="12 7 12 12 15 14"/>',
    expediente: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="15" y2="16"/>',
    capas: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    campana: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    cerrar: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
  };

  function crearIcono(nombre, lado, color) {
    var envoltorio = crear('span', { display: 'inline-flex', width: lado, height: lado, flex: 'none' });
    if (color) envoltorio.style.color = color;
    envoltorio.setAttribute('aria-hidden', 'true');
    envoltorio.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONOS[nombre] + '</svg>';
    return envoltorio;
  }

  function limpiarNodo(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // Animaciones por la Web Animations API: Geotab quita los <style>, así que no
  // hay @keyframes disponibles.
  function pulsar(el) {
    if (el.animate) {
      el.animate([{ transform: 'scale(1)', opacity: 0.7 }, { transform: 'scale(2.6)', opacity: 0 }],
        { duration: 1600, iterations: Infinity, easing: 'ease-out' });
    }
  }

  function girar(el) {
    return el.animate ? el.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
      { duration: 900, iterations: Infinity }) : null;
  }

  // Los botones de "generar expediente" cambian su texto mientras trabajan; con
  // iconos dentro hay que guardar los hijos y devolverlos, no solo el textContent.
  // Devuelve la función que restaura el botón.
  function marcarOcupado(boton) {
    var hijos = Array.prototype.slice.call(boton.childNodes);
    boton.textContent = boton.getAttribute('data-compacto') ? '⏳' : '⏳ Generando…';
    return function () {
      boton.textContent = '';
      hijos.forEach(function (h) { boton.appendChild(h); });
    };
  }

  // "28/10, 2:15 a. m." -- el valor completo queda en el title de la celda.
  function fechaCorta(fecha) {
    return fecha.toLocaleString('es-CO', {
      timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', hour: 'numeric', minute: '2-digit', hour12: true
    });
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

  // v1.22: muchas fallas de motor llegan solo con la luz de check engine (MIL), que no cuenta arriba, y salían BAJA aunque el
  // Diccionario_Fallas.csv las tenga como MEDIA/ALTA (caso 1157-NWX533, SPN 157/FMI 18). La criticidad final es la mayor entre
  // luces y diccionario: el diccionario solo sube, nunca baja. Mismo criterio que criticidad_diccionario en telegram_alertas.py.
  // Si GitHub no responde se sigue solo con las luces (como antes) y se reintenta en el siguiente refresco.
  var URL_DICCIONARIO = 'https://raw.githubusercontent.com/Sergioocalderon/tablero-promoambiental/main/Diccionario_Fallas.csv';
  var diccionarioCache = null;

  function leerCsv(texto) {
    var filas = [], fila = [], campo = '', comillas = false;
    for (var i = 0; i < texto.length; i++) {
      var c = texto[i];
      if (comillas) {
        if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
        else if (c === '"') comillas = false;
        else campo += c;
      } else if (c === '"') comillas = true;
      else if (c === ',') { fila.push(campo); campo = ''; }
      else if (c === '\n') { fila.push(campo.replace(/\r$/, '')); filas.push(fila); fila = []; campo = ''; }
      else campo += c;
    }
    if (campo || fila.length) { fila.push(campo); filas.push(fila); }
    return filas;
  }

  function obtenerDiccionarioCriticidad() {
    if (diccionarioCache) return Promise.resolve(diccionarioCache);
    return fetch(URL_DICCIONARIO).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (texto) {
      var filas = leerCsv(texto.replace(/^﻿/, ''));
      var cab = filas[0] || [];
      var iTipo = cab.indexOf('Tipo_Codigo'), iSpn = cab.indexOf('SPN'), iFmi = cab.indexOf('FMI');
      var iCrit = cab.indexOf('Criticidad'), iAplica = cab.indexOf('Motor_Aplica');
      var dic = {};
      filas.slice(1).forEach(function (f) {
        if ((f[iTipo] || '').trim() !== 'SPN') return;   // SID/PID son J1587: su número no es un SPN de Geotab
        var crit = (f[iCrit] || '').trim().toUpperCase();
        if (!ORDEN_CRITICIDAD[crit]) return;
        var clave = (f[iSpn] || '').trim() + '|' + (f[iFmi] || '').trim();
        (dic[clave] = dic[clave] || []).push({ aplica: (f[iAplica] || '').trim().toUpperCase(), crit: crit });
      });
      diccionarioCache = dic;
      return dic;
    }).catch(function (e) {
      console.warn('Alertas por Severidad: no se pudo leer el diccionario de fallas, criticidad solo por luces', e);
      return {};
    });
  }

  // Fila de la marca (grupo de Geotab) o del motor (ej. 'X12') del vehículo si existe; si no, la 'Generico'.
  function criticidadDiccionario(dic, spn, fmi, marca, referenciaMotor) {
    if (spn === null || spn === undefined || fmi === null || fmi === undefined) return null;
    var filas = dic[spn + '|' + fmi] || [];
    var propias = [(marca || '').trim().toUpperCase(), (referenciaMotor || '').trim().toUpperCase()];
    for (var i = 0; i < filas.length; i++) if (filas[i].aplica && propias.indexOf(filas[i].aplica) !== -1) return filas[i].crit;
    for (var j = 0; j < filas.length; j++) if (filas[j].aplica === 'GENERICO') return filas[j].crit;
    return null;
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
    return Promise.all([obtenerCatalogosDiagnosticos(), obtenerDiccionarioCriticidad()]).then(function (res) {
      var catalogos = res[0], dicCriticidad = res[1];
      fallasActivas.forEach(function (f) {
        var diagInfo = catalogos.dicDiag[f.idDiagnostico] || { nombre: 'Diagnóstico desconocido', codigo: null };
        var fmInfo = catalogos.dicFm[f.idFailureMode] || { nombre: '', codigo: null };
        var porLuces = clasificarCriticidadEvento(f);
        var porDiccionario = criticidadDiccionario(dicCriticidad, diagInfo.codigo, fmInfo.codigo, f.marca, f.referenciaMotor);
        f.criticidad = (ORDEN_CRITICIDAD[porDiccionario] || 0) > ORDEN_CRITICIDAD[porLuces] ? porDiccionario : porLuces;
        f.spn = valorODesconocido(diagInfo.codigo);
        f.fmi = valorODesconocido(fmInfo.codigo);
        f.categoria = categorizarFalla(diagInfo.nombre);
        f.destacado = !!CATEGORIAS_DESTACADAS[f.categoria];
        f.nombreFalla = diagInfo.nombre + (fmInfo.nombre ? ' — ' + fmInfo.nombre : '');
        f.activo = true; // explicito: en este punto f ya paso el filtro faultState==='Active' de obtenerFallasActivas()
        f.turno = clasificarTurno(f.fecha.getHours());
      });
      return fallasActivas;
    });
  }

  // El código 0 es válido: FMI 0 = "dato por encima del rango normal, nivel más severo". Con `|| '?'` el cero se perdía y la
  // clase más grave salía como "FMI ?" y "Significado no disponible" (caso 1226-FXW563).
  function valorODesconocido(v) {
    return (v === null || v === undefined || v === '') ? '?' : v;
  }

  // --- Confirmación: ¿el código se sigue reportando? -------------------------------------------
  // Marca cada falla con estadoConf ('confirmado' | 'por-verificar' | 'sin-evidencia'), horasSinReporte, kmDesde y motivo,
  // y deja sinConfirmar = (estadoConf !== 'confirmado'). Solo consulta a los vehículos con algún código de más de 24 h.
  function agregarConfirmacion(fallasActivas) {
    var ahora = Date.now(), HORA = 60 * 60 * 1000;
    var desdePorVeh = {};
    fallasActivas.forEach(function (f) {
      var t = f.fecha.getTime();
      if ((ahora - t) / HORA < CONFIRMACION_HORAS) return;
      if (!(f.idVehiculo in desdePorVeh) || t < desdePorVeh[f.idVehiculo]) desdePorVeh[f.idVehiculo] = t;
    });
    var ids = Object.keys(desdePorVeh);

    // evidencia: { idVehiculo: { viajes: [[inicioMs, km]], comunica: bool, motor24h: bool } } o null si no se pudo consultar
    function marcar(evidencia) {
      fallasActivas.forEach(function (f) {
        var horas = (ahora - f.fecha.getTime()) / HORA;
        f.horasSinReporte = horas;
        f.diasSinReporte = horas / 24;
        f.kmDesde = null;
        f.motivo = '';
        f.tipoSE = '';          // 'parado' | 'dispositivo' | 'consulta' (solo si estadoConf = 'sin-evidencia')
        f.motivoCorto = '';
        if (horas < CONFIRMACION_HORAS) { f.estadoConf = 'confirmado'; }
        else {
          var ev = evidencia ? evidencia[f.idVehiculo] : null;
          if (!ev) { f.estadoConf = 'sin-evidencia'; f.tipoSE = 'consulta'; f.motivoCorto = 'No se pudo consultar'; f.motivo = 'no se pudo consultar el estado del vehículo'; }
          else {
            var t0 = f.fecha.getTime();
            f.kmDesde = ev.viajes.reduce(function (s, v) { return v[0] > t0 ? s + v[1] : s; }, 0);
            if (!ev.comunica) { f.estadoConf = 'sin-evidencia'; f.tipoSE = 'dispositivo'; f.motivoCorto = 'Dispositivo sin comunicar'; f.motivo = 'el dispositivo no ha comunicado en las últimas ' + CONFIRMACION_HORAS + ' h'; }
            else if (f.kmDesde < MOVIMIENTO_KM_MIN) {
              f.estadoConf = 'sin-evidencia'; f.tipoSE = 'parado'; f.motivoCorto = 'Sin movimiento';
              f.motivo = 'el vehículo casi no se ha movido desde entonces (' + Math.round(f.kmDesde) + ' km)';
            }
            else if (!ev.motor24h) { f.estadoConf = 'sin-evidencia'; f.tipoSE = 'dispositivo'; f.motivoCorto = 'Sin señal del motor'; f.motivo = 'no llegan señales del motor (últimas ' + CONFIRMACION_HORAS + ' h)'; }
            else f.estadoConf = 'por-verificar';
          }
        }
        f.sinConfirmar = f.estadoConf !== 'confirmado';
      });
      return fallasActivas;
    }
    if (!ids.length) return Promise.resolve(marcar({}));

    var desde24h = new Date(ahora - CONFIRMACION_HORAS * HORA).toISOString(), hasta = new Date(ahora).toISOString();
    var llamadas = [];
    ids.forEach(function (id) {
      llamadas.push(['Get', { typeName: 'Trip', search: { deviceSearch: { id: id }, fromDate: new Date(desdePorVeh[id]).toISOString(), toDate: hasta }, resultsLimit: LIMITE_PAGINA_FAULTDATA }]);
      llamadas.push(['Get', { typeName: 'DeviceStatusInfo', search: { deviceSearch: { id: id } } }]);
      llamadas.push(['Get', { typeName: 'StatusData', search: { deviceSearch: { id: id }, diagnosticSearch: { id: ID_DIAG_RPM_MOTOR }, fromDate: desde24h, toDate: hasta }, resultsLimit: 1 }]);
    });
    return apiMultiCall(llamadas).then(function (resp) {
      var evidencia = {};
      ids.forEach(function (id, i) {
        var viajes = resp[3 * i] || [], estado = (resp[3 * i + 1] || [])[0], motor = resp[3 * i + 2] || [];
        var ultCom = estado && estado.dateTime ? Date.parse(estado.dateTime) : NaN;
        evidencia[id] = {
          viajes: viajes.map(function (v) { return [Date.parse(v.start), Number(v.distance) || 0]; }).filter(function (v) { return !isNaN(v[0]); }),
          comunica: !!estado && (!!estado.isDeviceCommunicating || (!isNaN(ultCom) && (ahora - ultCom) <= CONFIRMACION_HORAS * HORA)),
          motor24h: motor.length > 0
        };
      });
      return marcar(evidencia);
    }).catch(function (err) {
      console.error('Alertas: no se pudo consultar el estado de los vehículos para confirmar los códigos:', err);
      return marcar(null);
    });
  }

  // Rótulo de la pastilla / filtro de un código no confirmado.
  function etiquetaConfirmacion(it) {
    if (it.estadoConf !== 'sin-evidencia') return 'Por verificar';
    return it.tipoSE === 'dispositivo' ? 'Falla de dispositivo' : it.tipoSE === 'consulta' ? 'No consultado' : 'Vehículo parado';
  }

  function textoAntiguedad(horas) {
    return horas < 48 ? Math.round(horas) + ' h' : Math.round(horas / 24) + ' d';
  }

  function textoSinConfirmar(it) {
    var ant = textoAntiguedad(it.horasSinReporte);
    if (it.estadoConf === 'sin-evidencia') {
      return 'No se puede confirmar ni descartar: el último reporte fue hace ' + ant + ' y ' + it.motivo +
        '. Es el último estado conocido: verificar con escáner.';
    }
    return 'Sin confirmación reciente: hace ' + ant + ' que no se reporta y el vehículo recorrió ' + Math.round(it.kmDesde) +
      ' km desde entonces, con el dispositivo y el motor transmitiendo. Probablemente ya no está activo: verificar con escáner, ' +
      'incluyendo los códigos inactivos o almacenados.';
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
        if (!!a.sinConfirmar !== !!b.sinConfirmar) return a.sinConfirmar ? 1 : -1;   // lo confirmado primero
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
        // La criticidad del vehículo es la del código CONFIRMADO más crítico; si todos están por verificar, no cuenta como crítico.
        criticidad: items[0].sinConfirmar ? 'BAJA' : items[0].criticidad,
        soloPorVerificar: !!items[0].sinConfirmar,
        items: items
      });
    });

    vehiculos.sort(function (a, b) {
      if (a.soloPorVerificar !== b.soloPorVerificar) return a.soloPorVerificar ? 1 : -1;
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

  // La campana del encabezado refleja el banner: punto rojo mientras haya códigos
  // nuevos sin marcar como vistos; un clic en ella los marca (cierra el banner y
  // detiene la repetición del sonido).
  function actualizarCampana(hayNuevos) {
    if (!elementos.puntoCampana) return;
    elementos.puntoCampana.style.display = hayNuevos ? 'block' : 'none';
    var texto = hayNuevos ? 'Hay códigos nuevos. Clic para marcarlos como vistos.' : 'Sin códigos nuevos';
    elementos.campana.title = texto;
    elementos.campana.setAttribute('aria-label', texto);
  }

  function cerrarBannerAlarma() {
    if (elementos.bannerAlarma) elementos.bannerAlarma.style.display = 'none';
    detenerRepeticionAlarma();
    actualizarCampana(false);
  }

  function mostrarBannerAlarma(nuevos) {
    if (!elementos.bannerAlarma) return;
    var banner = elementos.bannerAlarma;
    limpiarNodo(banner);

    var hayAlta = nuevos.some(function (it) { return it.criticidad === 'ALTA'; });
    var estilo = ESTILO_NIVEL[hayAlta ? 'ALTA' : 'MEDIA'];
    aplicarEstilo(banner, {
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px',
      background: estilo.fondo, border: '1px solid ' + estilo.borde, borderLeft: '4px solid ' + estilo.color,
      borderRadius: T.radius.sm, padding: '12px 16px', marginBottom: '14px'
    });

    var contenido = crear('div', { display: 'flex', alignItems: 'flex-start', gap: '12px' });
    contenido.appendChild(crearIcono(hayAlta ? 'alerta' : 'circulo', '22px', estilo.color));

    var texto = crear('div', { fontSize: '0.85rem' });
    texto.appendChild(crear('div', { fontWeight: '700', marginBottom: '4px', color: '#FFFFFF' }, nuevos.length + ' código(s) nuevo(s)'));
    var detalle = crear('div', { color: D.textSoft, fontSize: '0.8rem' });
    nuevos.slice(0, 5).forEach(function (it) {
      detalle.appendChild(crear('div', {}, '• ' + it.claveVehiculo + ' — ' + it.nombreFalla + ' (' + it.criticidad + ')'));
    });
    if (nuevos.length > 5) detalle.appendChild(crear('div', {}, '… y ' + (nuevos.length - 5) + ' más.'));
    texto.appendChild(detalle);
    contenido.appendChild(texto);
    banner.appendChild(contenido);

    var botonCerrar = crear('button', {
      background: 'transparent', border: 'none', color: D.muted, cursor: 'pointer', padding: '2px', display: 'flex'
    });
    botonCerrar.type = 'button';
    botonCerrar.title = 'Marcar como vistos';
    botonCerrar.setAttribute('aria-label', 'Marcar como vistos');
    botonCerrar.appendChild(crearIcono('cerrar', '18px'));
    botonCerrar.addEventListener('click', cerrarBannerAlarma);
    banner.appendChild(botonCerrar);

    banner.style.display = 'flex';
    actualizarCampana(true);
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
        if (!NIVELES_ALARMA[it.criticidad] || it.sinConfirmar) return;   // lo por verificar no suena
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

  function textoEstadoTripulaciones() {
    if (tripulacionesMetaCache && tripulacionesCache.length) {
      return 'Tripulaciones: ' + tripulacionesMetaCache.nombreArchivo +
        ' — ' + tripulacionesCache.length + ' turnos (cargado ' + tripulacionesMetaCache.cargadoEn + ')';
    }
    return 'Sin archivo de tripulaciones cargado — el conductor no se puede identificar.';
  }

  // Botón "Excel" de la barra de control. El <input type=file> va FUERA del botón
  // (en un envoltorio): dentro, el clic sintético sobre el input burbujearía al
  // botón y volvería a abrirse en bucle.
  function crearBotonTripulaciones(onCargado) {
    var envoltorio = crear('span', { display: 'inline-flex' });

    var boton = crear('button', {
      display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '8px 12px', cursor: 'pointer',
      background: 'transparent', border: '1px solid ' + D.borderStrong, borderRadius: T.radius.sm,
      color: D.textSoft, fontSize: '0.82rem', fontFamily: T.font
    });
    boton.type = 'button';
    boton.appendChild(crearIcono('hoja', '16px', '#22C55E'));
    boton.appendChild(crear('span', {}, 'Excel'));
    var punto = crear('span', { width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block' });
    boton.appendChild(punto);

    function pintar() {
      var hay = !!(tripulacionesMetaCache && tripulacionesCache.length);
      punto.style.background = hay ? D.verde : D.naranja;
      boton.title = 'Cargar Excel de tripulaciones. ' + textoEstadoTripulaciones();
    }
    pintar();

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
          pintar();
          if (onCargado) onCargado();
        } catch (e) {
          console.error('Error parseando archivo de tripulaciones:', e);
          alert('No se pudo leer ese archivo como Excel. Revisa que sea el .xlsx correcto.');
        }
      };
      lector.readAsArrayBuffer(archivo);
      inputArchivo.value = '';
    });

    boton.addEventListener('click', function () { inputArchivo.click(); });
    envoltorio.appendChild(boton);
    envoltorio.appendChild(inputArchivo);
    return envoltorio;
  }

  // --- Filtros -----------------------------------------------------------
  var filtroEstado = { texto: '', ciudad: 'Todas', vehiculo: null, criticidad: 'Todas', sistema: 'Todas', turno: 'Todos', confirmacion: 'Todas' };
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
      referenciaMotor: v.referenciaMotor, nMotor: v.nMotor, criticidad: v.criticidad, soloPorVerificar: v.soloPorVerificar, items: items
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
      if (filtroEstado.criticidad === 'Todas' && filtroEstado.sistema === 'Todas' && filtroEstado.turno === 'Todos' && filtroEstado.confirmacion === 'Todas') return v;
      var items = v.items;
      if (filtroEstado.confirmacion === 'Confirmadas') items = items.filter(function (it) { return !it.sinConfirmar; });
      if (filtroEstado.confirmacion === 'Por verificar') items = items.filter(function (it) { return it.estadoConf === 'por-verificar'; });
      if (filtroEstado.confirmacion === 'Sin evidencia') items = items.filter(function (it) { return it.estadoConf === 'sin-evidencia'; });
      if (filtroEstado.confirmacion === 'Vehículo parado') items = items.filter(function (it) { return it.tipoSE === 'parado'; });
      if (filtroEstado.confirmacion === 'Falla de dispositivo') items = items.filter(function (it) { return it.tipoSE === 'dispositivo'; });
      if (filtroEstado.confirmacion === 'No consultado') items = items.filter(function (it) { return it.tipoSE === 'consulta'; });
      // El filtro de criticidad (y la tarjeta ALTA) miran solo lo confirmado, salvo que se pida explícitamente lo no confirmado.
      if (filtroEstado.criticidad !== 'Todas') {
        items = items.filter(function (it) {
          return it.criticidad === filtroEstado.criticidad && (!it.sinConfirmar || (filtroEstado.confirmacion !== 'Todas' && filtroEstado.confirmacion !== 'Confirmadas'));
        });
      }
      if (filtroEstado.sistema !== 'Todas') items = items.filter(function (it) { return it.categoria === filtroEstado.sistema; });
      if (filtroEstado.turno !== 'Todos') items = items.filter(function (it) { return it.turno === filtroEstado.turno; });
      return items.length ? conItemsFiltrados(v, items) : null;
    }).filter(function (v) { return v !== null; });
  }

  function tieneFiltrosActivos() {
    return !!(filtroEstado.texto || filtroEstado.ciudad !== 'Todas' || filtroEstado.vehiculo ||
      filtroEstado.criticidad !== 'Todas' || filtroEstado.sistema !== 'Todas' || filtroEstado.turno !== 'Todos' || filtroEstado.confirmacion !== 'Todas');
  }

  // --- Encabezado: título, estado de la última carga y campana ----------------
  function construirEncabezado(contenedor) {
    var barra = crear('div', {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px',
      paddingBottom: '14px', marginBottom: '18px', borderBottom: '1px solid ' + D.border
    });

    var titulos = crear('div');
    titulos.appendChild(crear('div', {
      fontSize: '0.68rem', letterSpacing: '0.14em', textTransform: 'uppercase', color: D.verde, fontWeight: '700'
    }, 'Centro de control de telemetría'));
    titulos.appendChild(crear('h2', {
      margin: '2px 0 0 0', fontSize: '1.5rem', fontWeight: '700', color: '#FFFFFF', letterSpacing: '0.01em'
    }, 'Alertas por Severidad'));
    barra.appendChild(titulos);

    var derecha = crear('div', { display: 'flex', alignItems: 'center', gap: '16px' });

    var estado = crear('div', { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.78rem', color: D.muted });
    var luz = crear('span', { position: 'relative', display: 'inline-block', width: '8px', height: '8px' });
    var ondaLuz = crear('span', { position: 'absolute', top: '0', left: '0', width: '8px', height: '8px', borderRadius: '50%', background: D.verde });
    pulsar(ondaLuz);
    luz.appendChild(ondaLuz);
    luz.appendChild(crear('span', { position: 'absolute', top: '0', left: '0', width: '8px', height: '8px', borderRadius: '50%', background: D.verde }));
    estado.appendChild(luz);
    elementos.textoActualizado = crear('span', {}, 'Cargando…');
    estado.appendChild(elementos.textoActualizado);
    derecha.appendChild(estado);

    var campana = crear('button', {
      position: 'relative', display: 'flex', padding: '6px', background: 'transparent', border: 'none',
      borderRadius: T.radius.sm, color: D.muted, cursor: 'pointer'
    });
    campana.type = 'button';
    campana.appendChild(crearIcono('campana', '22px'));
    var puntoCampana = crear('span', { position: 'absolute', top: '3px', right: '3px', width: '10px', height: '10px', display: 'none' });
    var ondaCampana = crear('span', { position: 'absolute', top: '0', left: '0', width: '10px', height: '10px', borderRadius: '50%', background: D.rojo });
    pulsar(ondaCampana);
    puntoCampana.appendChild(ondaCampana);
    puntoCampana.appendChild(crear('span', { position: 'absolute', top: '0', left: '0', width: '10px', height: '10px', borderRadius: '50%', background: D.rojo }));
    campana.appendChild(puntoCampana);
    campana.addEventListener('click', cerrarBannerAlarma);
    campana.addEventListener('mouseenter', function () { campana.style.color = '#FFFFFF'; });
    campana.addEventListener('mouseleave', function () { campana.style.color = D.muted; });
    derecha.appendChild(campana);

    elementos.campana = campana;
    elementos.puntoCampana = puntoCampana;
    actualizarCampana(false);

    barra.appendChild(derecha);
    contenedor.appendChild(barra);
  }

  // --- Barra de control unificada: rango, búsqueda, filtros, Excel y Actualizar -
  function estiloControl() {
    return {
      padding: '8px 12px', background: D.bg, border: '1px solid ' + D.borderStrong, borderRadius: T.radius.sm,
      fontSize: '0.82rem', fontFamily: T.font, color: D.textSoft, outline: 'none', colorScheme: 'dark'
    };
  }

  // Select oscuro con el borde en verde cuando tiene un filtro distinto al valor
  // por defecto, para ver de un vistazo qué filtros están puestos.
  function crearSelectOscuro(nombreAccesible, valorDefecto, onChange) {
    var select = crear('select', estiloControl());
    select.style.cursor = 'pointer';
    select.setAttribute('aria-label', nombreAccesible);
    function resaltar() { select.style.borderColor = select.value === valorDefecto ? D.borderStrong : D.verde; }
    select.addEventListener('change', function () { resaltar(); onChange(select.value); });
    return {
      elemento: select,
      // opciones: [{ valor, texto }]. Conserva la selección si sigue existiendo.
      poner: function (opciones, seleccion) {
        limpiarNodo(select);
        opciones.forEach(function (o) {
          var opcion = crear('option', { background: D.panel, color: D.text });
          opcion.value = o.valor;
          opcion.textContent = o.texto;
          select.appendChild(opcion);
        });
        var existe = opciones.some(function (o) { return o.valor === seleccion; });
        select.value = existe ? seleccion : valorDefecto;
        resaltar();
        return select.value;
      }
    };
  }

  // "Hoy, 12:00 a. m. – Ahora" cuando el rango es el de por defecto; si no, las
  // dos fechas. Las fechas del input datetime-local son hora local del navegador.
  function describirRango(valorDesde, valorHasta) {
    var d = new Date(valorDesde), h = new Date(valorHasta);
    if (isNaN(d.getTime()) || isNaN(h.getTime())) return 'Elegir rango';
    function hora(x) { return x.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true }); }
    function corta(x) { return x.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit' }) + ', ' + hora(x); }
    var esHoyHastaAhora = d.getTime() === inicioDeHoy().getTime() && (Date.now() - h.getTime()) < 15 * 60 * 1000;
    return esHoyHastaAhora ? 'Hoy, ' + hora(d) + ' – Ahora' : corta(d) + ' – ' + corta(h);
  }

  function construirBarraControl(contenedor, onCambio) {
    var panel = crear('div', {
      display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'center', justifyContent: 'space-between',
      background: D.panel, border: '1px solid ' + D.border, borderRadius: T.radius.sm, padding: '12px', marginBottom: '14px'
    });
    // Los filtros se reacomodan entre sí (flex 1 1 0 + minWidth 0); Excel y Actualizar
    // se quedan a la derecha en vez de caer a una segunda fila.
    var izquierda = crear('div', { display: 'flex', flex: '1 1 0', minWidth: '0', flexWrap: 'wrap', gap: '12px', alignItems: 'center' });
    var derecha = crear('div', { display: 'flex', flex: 'none', gap: '8px', alignItems: 'center' });

    // --- Rango de fechas (botón + ventana flotante con los dos campos) ---
    var rangoGuardado = cargarRangoGuardado();
    var inputDesde = crear('input', estiloControl());
    inputDesde.type = 'datetime-local';
    inputDesde.value = rangoGuardado.desde;
    inputDesde.setAttribute('aria-label', 'Desde');
    var inputHasta = crear('input', estiloControl());
    inputHasta.type = 'datetime-local';
    inputHasta.value = rangoGuardado.hasta;
    inputHasta.setAttribute('aria-label', 'Hasta');

    var envFecha = crear('div', { position: 'relative' });
    var botonFecha = crear('button', {
      display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '8px 14px', cursor: 'pointer',
      background: D.panelAlt, border: '1px solid ' + D.borderStrong, borderRadius: T.radius.sm,
      color: D.textSoft, fontSize: '0.82rem', fontFamily: T.font
    });
    botonFecha.type = 'button';
    botonFecha.appendChild(crearIcono('calendario', '16px'));
    var textoRango = crear('span');
    botonFecha.appendChild(textoRango);
    envFecha.appendChild(botonFecha);

    function actualizarTextoRango() { textoRango.textContent = describirRango(inputDesde.value, inputHasta.value); }
    actualizarTextoRango();

    var ventana = crear('div', {
      display: 'none', flexDirection: 'column', gap: '10px', position: 'absolute', top: 'calc(100% + 6px)', left: '0',
      zIndex: '30', minWidth: '270px', padding: '14px', background: D.panel, border: '1px solid ' + D.borderStrong,
      borderRadius: T.radius.sm, boxShadow: '0 10px 30px rgba(0,0,0,0.5)'
    });
    function campo(etiqueta, input) {
      var env = crear('label', { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.72rem', color: D.muted, fontWeight: '600' }, etiqueta);
      env.appendChild(input);
      return env;
    }
    ventana.appendChild(campo('Desde', inputDesde));
    ventana.appendChild(campo('Hasta', inputHasta));
    var mensajeRango = crear('div', { display: 'none', fontSize: '0.74rem', color: '#FF8587' });
    ventana.appendChild(mensajeRango);

    var filaBotonesRango = crear('div', { display: 'flex', gap: '8px' });
    var botonAplicar = crear('button', {
      flex: '1', padding: '8px 12px', background: D.verde, color: '#06210F', border: 'none',
      borderRadius: T.radius.sm, fontWeight: '700', fontSize: '0.8rem', cursor: 'pointer'
    }, 'Aplicar');
    botonAplicar.type = 'button';
    var botonHoy = crear('button', {
      flex: '1', padding: '8px 12px', background: 'transparent', color: D.textSoft, border: '1px solid ' + D.borderStrong,
      borderRadius: T.radius.sm, fontWeight: '600', fontSize: '0.8rem', cursor: 'pointer'
    }, 'Hoy hasta ahora');
    botonHoy.type = 'button';
    filaBotonesRango.appendChild(botonAplicar);
    filaBotonesRango.appendChild(botonHoy);
    ventana.appendChild(filaBotonesRango);
    ventana.appendChild(crear('p', { margin: '0', fontSize: '0.7rem', lineHeight: '1.4', color: D.faint },
      '"Activas ahora" siempre revisa al menos los últimos 30 días para no perder códigos que sigan activos aunque no tengan dato nuevo hoy: puede aparecer algo más viejo que "Desde".'));
    envFecha.appendChild(ventana);

    function abrirVentana() { ventana.style.display = 'flex'; mensajeRango.style.display = 'none'; }
    function cerrarVentana() { ventana.style.display = 'none'; }
    botonFecha.addEventListener('click', function () {
      if (ventana.style.display === 'none') abrirVentana(); else cerrarVentana();
    });
    document.addEventListener('mousedown', function (e) { if (!envFecha.contains(e.target)) cerrarVentana(); });
    ventana.addEventListener('keydown', function (e) { if (e.key === 'Escape') cerrarVentana(); });

    botonAplicar.addEventListener('click', function () {
      var d = new Date(inputDesde.value), h = new Date(inputHasta.value);
      var problema = null;
      if (isNaN(d.getTime()) || isNaN(h.getTime())) problema = 'Completa las dos fechas.';
      else if (d.getTime() >= h.getTime()) problema = '"Desde" debe ser anterior a "Hasta".';
      if (problema) { mensajeRango.textContent = problema; mensajeRango.style.display = 'block'; return; }
      guardarRango(inputDesde.value, inputHasta.value);
      actualizarTextoRango();
      cerrarVentana();
      cargarYRenderizar(d, h);
    });
    botonHoy.addEventListener('click', function () { cerrarVentana(); actualizarRangoDefecto(); });
    izquierda.appendChild(envFecha);

    // --- Búsqueda ---
    var envBusqueda = crear('div', { position: 'relative', flex: '1 1 200px', minWidth: '180px' });
    var iconoBusqueda = crearIcono('buscar', '16px', D.faint);
    aplicarEstilo(iconoBusqueda, { position: 'absolute', left: '11px', top: '50%', marginTop: '-8px', pointerEvents: 'none' });
    envBusqueda.appendChild(iconoBusqueda);
    var inputBusqueda = crear('input', estiloControl());
    aplicarEstilo(inputBusqueda, { width: '100%', boxSizing: 'border-box', paddingLeft: '34px' });
    inputBusqueda.type = 'text';
    inputBusqueda.placeholder = 'Buscar móvil, placa, ciudad…';
    inputBusqueda.setAttribute('aria-label', 'Buscar móvil, placa o ciudad');
    inputBusqueda.addEventListener('input', function () { filtroEstado.texto = inputBusqueda.value; onCambio(); });
    inputBusqueda.addEventListener('focus', function () { inputBusqueda.style.borderColor = D.verde; });
    inputBusqueda.addEventListener('blur', function () { inputBusqueda.style.borderColor = D.borderStrong; });
    envBusqueda.appendChild(inputBusqueda);
    izquierda.appendChild(envBusqueda);

    // --- Filtros ---
    var OPCIONES_CRITICIDAD = [
      { valor: 'Todas', texto: 'Criticidad: Todas' }, { valor: 'ALTA', texto: 'Criticidad: ALTA' },
      { valor: 'MEDIA', texto: 'Criticidad: MEDIA' }, { valor: 'BAJA', texto: 'Criticidad: BAJA' }
    ];
    var OPCIONES_TURNO = [
      { valor: 'Todos', texto: 'Turno: Todos' }, { valor: 'T1', texto: 'Turno: T1 (Mañana)' },
      { valor: 'T2', texto: 'Turno: T2 (Tarde)' }, { valor: 'T3', texto: 'Turno: T3 (Noche)' }
    ];
    var selectCiudad = crearSelectOscuro('Ciudad', 'Todas', function (v) { filtroEstado.ciudad = v; onCambio(); });
    selectCiudad.poner([{ valor: 'Todas', texto: 'Todas las ciudades' }], 'Todas');
    var selectCriticidad = crearSelectOscuro('Criticidad', 'Todas', function (v) { filtroEstado.criticidad = v; onCambio(); });
    selectCriticidad.poner(OPCIONES_CRITICIDAD, 'Todas');
    var selectTurno = crearSelectOscuro('Turno', 'Todos', function (v) { filtroEstado.turno = v; onCambio(); });
    selectTurno.poner(OPCIONES_TURNO, 'Todos');
    var OPCIONES_CONFIRMACION = [
      { valor: 'Todas', texto: 'Confirmación: Todas' }, { valor: 'Confirmadas', texto: 'Solo confirmadas' },
      { valor: 'Por verificar', texto: 'Por verificar (sin reporte en 24 h)' },
      { valor: 'Sin evidencia', texto: 'Sin evidencia (todas)' },
      { valor: 'Falla de dispositivo', texto: 'Falla de dispositivo (sin comunicar o sin motor)' },
      { valor: 'Vehículo parado', texto: 'Sin evidencia: vehículo parado' },
      { valor: 'No consultado', texto: 'No se pudo consultar' }
    ];
    var selectConfirmacion = crearSelectOscuro('Confirmación', 'Todas', function (v) { filtroEstado.confirmacion = v; onCambio(); });
    selectConfirmacion.poner(OPCIONES_CONFIRMACION, 'Todas');
    var selectSistema = crearSelectOscuro('Sistema', 'Todas', function (v) { filtroEstado.sistema = v; onCambio(); });
    selectSistema.poner([{ valor: 'Todas', texto: 'Sistema: Todos' }], 'Todas');
    izquierda.appendChild(selectCiudad.elemento);
    izquierda.appendChild(selectCriticidad.elemento);
    izquierda.appendChild(selectTurno.elemento);
    izquierda.appendChild(selectConfirmacion.elemento);
    izquierda.appendChild(selectSistema.elemento);

    var botonLimpiar = crear('button', {
      padding: '8px 12px', background: 'transparent', border: 'none', color: D.muted,
      fontSize: '0.8rem', fontWeight: '600', cursor: 'pointer', textDecoration: 'underline'
    }, 'Limpiar filtros');
    botonLimpiar.type = 'button';
    botonLimpiar.addEventListener('click', function () {
      filtroEstado.texto = ''; filtroEstado.ciudad = 'Todas'; filtroEstado.vehiculo = null;
      filtroEstado.criticidad = 'Todas'; filtroEstado.sistema = 'Todas'; filtroEstado.turno = 'Todos'; filtroEstado.confirmacion = 'Todas';
      inputBusqueda.value = '';
      selectCiudad.elemento.value = 'Todas'; selectCiudad.poner(opcionesCiudadActuales, 'Todas');
      selectCriticidad.poner(OPCIONES_CRITICIDAD, 'Todas');
      selectTurno.poner(OPCIONES_TURNO, 'Todos');
      selectConfirmacion.poner(OPCIONES_CONFIRMACION, 'Todas');
      selectSistema.poner(opcionesSistemaActuales, 'Todas');
      chipVehiculo.style.display = 'none';
      onCambio();
    });
    izquierda.appendChild(botonLimpiar);

    // --- Derecha: tripulaciones y actualizar ---
    derecha.appendChild(crearBotonTripulaciones(onCambio));

    var botonActualizar = crear('button', {
      display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '9px 18px', cursor: 'pointer',
      background: D.verde, color: '#06210F', border: 'none', borderRadius: T.radius.sm,
      fontWeight: '700', fontSize: '0.84rem', fontFamily: T.font
    });
    botonActualizar.type = 'button';
    var iconoActualizar = crearIcono('actualizar', '16px');
    botonActualizar.appendChild(iconoActualizar);
    botonActualizar.appendChild(crear('span', {}, 'Actualizar'));
    botonActualizar.addEventListener('click', function () { actualizarRangoDefecto(); });
    derecha.appendChild(botonActualizar);

    panel.appendChild(izquierda);
    panel.appendChild(derecha);
    contenedor.appendChild(panel);

    // Chip de "filtrando por este vehículo" (se activa con un clic en la placa
    // dentro de la tabla cronológica).
    var chipVehiculo = crear('div', { display: 'none', alignItems: 'center', gap: '10px', margin: '-4px 0 14px 0' });
    var textoChip = crear('span', {
      fontSize: '0.78rem', color: D.verde, background: 'rgba(0,208,132,0.12)', border: '1px solid rgba(0,208,132,0.35)',
      padding: '5px 12px', borderRadius: T.radius.pill, fontWeight: '600'
    });
    var botonQuitarChip = crear('button', {
      background: 'transparent', border: 'none', color: D.muted, cursor: 'pointer',
      fontSize: '0.78rem', fontWeight: '600', textDecoration: 'underline'
    }, 'Quitar filtro');
    botonQuitarChip.type = 'button';
    botonQuitarChip.addEventListener('click', function () {
      filtroEstado.vehiculo = null; chipVehiculo.style.display = 'none'; onCambio();
    });
    chipVehiculo.appendChild(textoChip);
    chipVehiculo.appendChild(botonQuitarChip);
    contenedor.appendChild(chipVehiculo);

    var opcionesCiudadActuales = [{ valor: 'Todas', texto: 'Todas las ciudades' }];
    var opcionesSistemaActuales = [{ valor: 'Todas', texto: 'Sistema: Todos' }];
    var animacionGiro = null;

    return {
      inputDesde: inputDesde,
      inputHasta: inputHasta,
      actualizarTextoRango: actualizarTextoRango,
      // Mientras carga: el botón se deshabilita y el icono gira.
      marcarCargando: function (cargando) {
        botonActualizar.disabled = cargando;
        botonActualizar.style.opacity = cargando ? '0.65' : '1';
        botonActualizar.style.cursor = cargando ? 'wait' : 'pointer';
        if (cargando && !animacionGiro) animacionGiro = girar(iconoActualizar);
        if (!cargando && animacionGiro) { animacionGiro.cancel(); animacionGiro = null; }
      },
      mostrarChipVehiculo: function (nombreVehiculo) {
        textoChip.textContent = 'Filtrando por: ' + nombreVehiculo;
        chipVehiculo.style.display = 'flex';
      },
      ocultarChipVehiculo: function () { chipVehiculo.style.display = 'none'; },
      actualizarOpcionesCiudad: function (ciudadesDisponibles) {
        opcionesCiudadActuales = [{ valor: 'Todas', texto: 'Todas las ciudades' }].concat(
          ciudadesDisponibles.map(function (c) { return { valor: c, texto: c }; }));
        filtroEstado.ciudad = selectCiudad.poner(opcionesCiudadActuales, filtroEstado.ciudad);
      },
      actualizarOpcionesSistema: function (sistemasDisponibles) {
        opcionesSistemaActuales = [{ valor: 'Todas', texto: 'Sistema: Todos' }].concat(
          sistemasDisponibles.map(function (s) { return { valor: s, texto: 'Sistema: ' + s }; }));
        filtroEstado.sistema = selectSistema.poner(opcionesSistemaActuales, filtroEstado.sistema);
      },
      // Usados por los KPI y los chips de sistemas para que el select refleje el
      // filtro que se acaba de aplicar con un clic.
      seleccionarSistema: function (sistema) {
        filtroEstado.sistema = selectSistema.poner(opcionesSistemaActuales, sistema);
      },
      seleccionarConfirmacion: function (valor) {
        filtroEstado.confirmacion = selectConfirmacion.poner(OPCIONES_CONFIRMACION, valor);
      },
      seleccionarCriticidad: function (criticidad) {
        filtroEstado.criticidad = selectCriticidad.poner(OPCIONES_CRITICIDAD, criticidad);
      }
    };
  }

  // --- Tarjetas de indicadores (KPI) + sistemas más afectados -----------------
  function crearTarjetaKpi(color, titulo, icono) {
    var tarjeta = crear('div', {
      display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '12px', minHeight: '108px',
      background: D.panel, border: '1px solid ' + D.border, borderLeft: '4px solid ' + color,
      borderRadius: T.radius.sm, padding: '16px 18px', boxShadow: D.sombra
    });
    var cabecera = crear('div', {
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px',
      color: D.muted, fontSize: '0.72rem', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.06em'
    });
    cabecera.appendChild(crear('span', {}, titulo));
    cabecera.appendChild(crearIcono(icono, '22px', color));
    var cuerpo = crear('div');
    tarjeta.appendChild(cabecera);
    tarjeta.appendChild(cuerpo);
    return { tarjeta: tarjeta, cuerpo: cuerpo };
  }

  function crearNumeroKpi(valor, unidad) {
    var fila = crear('div', { display: 'flex', alignItems: 'baseline', gap: '8px' });
    fila.appendChild(crear('span', { fontSize: '2.3rem', fontWeight: '700', color: '#FFFFFF', lineHeight: '1' }, String(valor)));
    fila.appendChild(crear('span', { fontSize: '0.9rem', color: D.faint }, unidad));
    return fila;
  }

  function construirKpis(contenedor) {
    var fila = crear('div', {
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '14px', marginBottom: '12px'
    });
    var kAlta = crearTarjetaKpi(D.rojo, 'Unidades en alerta crítica (ALTA)', 'alerta');
    var kResto = crearTarjetaKpi(D.naranja, 'Vehículos con fallas (MEDIA/BAJA)', 'circulo');
    var kTotal = crearTarjetaKpi(D.verde, 'Códigos activos', 'barras');
    fila.appendChild(kAlta.tarjeta);
    fila.appendChild(kResto.tarjeta);
    fila.appendChild(kTotal.tarjeta);
    contenedor.appendChild(fila);

    // La tarjeta ALTA es un atajo al filtro de criticidad (como el resumen anterior).
    kAlta.tarjeta.style.cursor = 'pointer';
    kAlta.tarjeta.setAttribute('role', 'button');
    kAlta.tarjeta.tabIndex = 0;
    kAlta.tarjeta.title = 'Clic para ver solo las ALTA';
    function alternarAlta() {
      if (!barraFiltrosRefs) return;
      barraFiltrosRefs.seleccionarCriticidad(filtroEstado.criticidad === 'ALTA' ? 'Todas' : 'ALTA');
      actualizarVista();
    }
    kAlta.tarjeta.addEventListener('click', alternarAlta);
    kAlta.tarjeta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); alternarAlta(); }
    });

    var filaSistemas = crear('div', { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px', marginBottom: '18px' });
    contenedor.appendChild(filaSistemas);

    var ultimosVehiculos = [];

    function pintar(vehiculos) {
      ultimosVehiculos = vehiculos;
      var vehiculosAlta = vehiculos.filter(function (v) { return v.criticidad === 'ALTA'; });
      var conteoNivel = { ALTA: 0, MEDIA: 0, BAJA: 0 };
      var conteoSistemas = {};
      var totalCodigos = 0, porVerificar = 0, parados = 0, fallaDisp = 0, sinConsulta = 0;
      vehiculos.forEach(function (v) {
        v.items.forEach(function (it) {
          if (it.sinConfirmar) {
            if (it.estadoConf !== 'sin-evidencia') porVerificar++;
            else if (it.tipoSE === 'dispositivo') fallaDisp++;
            else if (it.tipoSE === 'consulta') sinConsulta++;
            else parados++;
            return;
          }
          totalCodigos++;
          conteoNivel[it.criticidad] = (conteoNivel[it.criticidad] || 0) + 1;
          conteoSistemas[it.categoria] = (conteoSistemas[it.categoria] || 0) + 1;
        });
      });

      limpiarNodo(kAlta.cuerpo);
      kAlta.cuerpo.appendChild(crearNumeroKpi(vehiculosAlta.length, 'unidades'));
      kAlta.cuerpo.appendChild(crear('div', { fontSize: '0.74rem', color: D.muted, marginTop: '6px' }, 'Prioridad de ingreso a taller'));
      kAlta.tarjeta.style.borderColor = filtroEstado.criticidad === 'ALTA' ? D.rojo : D.border;
      kAlta.tarjeta.style.borderLeft = '4px solid ' + D.rojo;

      limpiarNodo(kResto.cuerpo);
      kResto.cuerpo.appendChild(crearNumeroKpi(vehiculos.filter(function (v) { return !v.soloPorVerificar; }).length - vehiculosAlta.length, 'unidades'));
      kResto.cuerpo.appendChild(crear('div', { fontSize: '0.74rem', color: D.muted, marginTop: '6px' }, 'Monitoreo preventivo'));

      // Reparto de los códigos por nivel: dato real de esta carga (reemplaza al
      // "% en meta" del boceto, que no existe en ninguna fuente de datos).
      limpiarNodo(kTotal.cuerpo);
      kTotal.cuerpo.appendChild(crearNumeroKpi(totalCodigos, totalCodigos === 1 ? 'código' : 'códigos'));
      var barraNiveles = crear('div', { display: 'flex', gap: '2px', height: '8px', borderRadius: '4px', overflow: 'hidden', background: D.border, marginTop: '10px' });
      var leyenda = crear('div', { display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '8px', fontSize: '0.72rem', color: D.muted });
      ['ALTA', 'MEDIA', 'BAJA'].forEach(function (nivel) {
        var n = conteoNivel[nivel] || 0;
        if (n) barraNiveles.appendChild(crear('div', { flex: n + ' 1 0', background: ESTILO_NIVEL[nivel].color }));
        var item = crear('span', { display: 'inline-flex', alignItems: 'center', gap: '5px' });
        item.appendChild(crear('span', { width: '8px', height: '8px', borderRadius: '2px', background: ESTILO_NIVEL[nivel].color, display: 'inline-block' }));
        item.appendChild(document.createTextNode(nivel + ' ' + n));
        leyenda.appendChild(item);
      });
      if (totalCodigos) kTotal.cuerpo.appendChild(barraNiveles);
      // Códigos activos según Geotab que no están confirmados: no cuentan arriba; un clic los filtra.
      function crearChipConfirmacion(texto, titulo, valorFiltro, color) {
        var chip = crear('button', {
          display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '0', background: 'transparent', border: 'none',
          cursor: 'pointer', fontFamily: T.font, fontSize: '0.72rem', color: color || D.muted, textDecoration: 'underline'
        }, texto);
        chip.type = 'button';
        chip.title = titulo;
        chip.addEventListener('click', function () {
          if (barraFiltrosRefs) { barraFiltrosRefs.seleccionarConfirmacion(filtroEstado.confirmacion === valorFiltro ? 'Todas' : valorFiltro); actualizarVista(); }
        });
        leyenda.appendChild(chip);
      }
      if (porVerificar) {
        crearChipConfirmacion('Por verificar ' + porVerificar, 'Activos en Geotab pero sin reportarse hace más de ' + CONFIRMACION_HORAS +
          ' h, con el vehículo en movimiento (' + MOVIMIENTO_KM_MIN + ' km o más) y el dispositivo transmitiendo: probablemente ya no están activos.', 'Por verificar');
      }
      if (fallaDisp) {
        crearChipConfirmacion('Falla de dispositivo ' + fallaDisp, 'Códigos de más de ' + CONFIRMACION_HORAS +
          ' h en vehículos cuyo dispositivo no comunica o del que no llegan señales del motor: no se puede saber si el código sigue, y el equipo necesita revisión.', 'Falla de dispositivo', D.naranja);
      }
      if (parados) {
        crearChipConfirmacion('Vehículo parado ' + parados, 'Códigos de más de ' + CONFIRMACION_HORAS +
          ' h en vehículos que casi no se han movido (menos de ' + MOVIMIENTO_KM_MIN + ' km): no hay evidencia a favor ni en contra.', 'Vehículo parado');
      }
      if (sinConsulta) {
        crearChipConfirmacion('No consultado ' + sinConsulta, 'No se pudo consultar a Geotab el estado de estos vehículos.', 'No consultado');
      }
      kTotal.cuerpo.appendChild(leyenda);

      limpiarNodo(filaSistemas);
      var topSistemas = Object.keys(conteoSistemas)
        .sort(function (a, b) { return conteoSistemas[b] - conteoSistemas[a]; })
        .slice(0, 3);
      if (topSistemas.length) {
        filaSistemas.appendChild(crear('span', { fontSize: '0.74rem', color: D.muted, fontWeight: '600', marginRight: '2px' }, 'Sistemas más afectados:'));
        topSistemas.forEach(function (s, i) {
          var activo = filtroEstado.sistema === s;
          var chip = crear('button', {
            padding: '5px 12px', borderRadius: T.radius.pill, cursor: 'pointer', fontSize: '0.76rem', fontWeight: '600',
            fontFamily: T.font, color: activo ? '#06210F' : D.textSoft,
            background: activo ? D.verde : D.panel, border: '1px solid ' + (activo ? D.verde : D.borderStrong)
          }, (i + 1) + '. ' + s + ' · ' + conteoSistemas[s]);
          chip.type = 'button';
          chip.title = activo ? 'Quitar el filtro de sistema' : 'Ver solo ' + s;
          chip.addEventListener('click', function () {
            if (barraFiltrosRefs) { barraFiltrosRefs.seleccionarSistema(activo ? 'Todas' : s); actualizarVista(); }
          });
          filaSistemas.appendChild(chip);
        });
      }
    }

    return { pintar: pintar };
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
      background: D.bg, border: '1px solid ' + D.border, borderRadius: T.radius.sm,
      padding: '10px 14px', margin: '4px 0', fontSize: '0.78rem', color: D.textSoft
    });
    panel.appendChild(crear('div', { color: D.muted }, 'Cargando historial…'));
    return panel;
  }

  function llenarPanelHistorial(panel, historial) {
    limpiarNodo(panel);

    var resumen = crear('div', { display: 'flex', gap: '18px', flexWrap: 'wrap', marginBottom: historial.registros.length ? '8px' : '0' });
    resumen.appendChild(crear('span', {}, '🔴 Se activó ' + historial.activaciones + ' vez(veces)'));
    resumen.appendChild(crear('span', {}, '🟢 Se desactivó ' + historial.desactivaciones + ' vez(veces)'));
    if (historial.primeraVez) {
      resumen.appendChild(crear('span', { color: D.muted },
        'Desde ' + formatearFechaHora(historial.primeraVez) + ' hasta ' + formatearFechaHora(historial.ultimaVez)));
    }
    panel.appendChild(resumen);

    if (historial.desactivaciones === 0 && historial.activaciones > 1) {
      panel.appendChild(crear('div', { color: D.muted, fontStyle: 'italic', marginBottom: '8px' },
        'Geotab nunca registró una desactivación explícita para este código en los últimos ' + historial.ventanaDias +
        ' días -- solo se repite como activo.'));
    }

    if (historial.registros.length > 0) {
      var lista = crear('div', { maxHeight: '160px', overflowY: 'auto', border: '1px solid ' + D.border, borderRadius: '6px' });
      historial.registros.forEach(function (r) {
        var esActivo = r.estado === 'Active';
        var filaHist = crear('div', {
          display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '4px 10px',
          borderBottom: '1px solid ' + D.border
        });
        filaHist.appendChild(crear('span', {}, formatearFechaHora(r.fecha)));
        filaHist.appendChild(crear('span', { color: esActivo ? '#FF8587' : '#52C41A', fontWeight: '600' },
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
      criticidad: it.criticidad, sinConfirmar: !!it.sinConfirmar, estadoConf: it.estadoConf, horasSinReporte: it.horasSinReporte, kmDesde: it.kmDesde, motivo: it.motivo,
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
  function construirPildorasHtml(criticidad, activo, sinConfirmar) {
    var colorCrit = sinConfirmar ? '#94A3B8' : (COLOR_POR_CRITICIDAD[criticidad] || '#94A3B8');
    var pildoraCrit = '<span style="display:inline-block;min-width:46px;text-align:center;padding:3px 10px;' +
      'border-radius:999px;background:' + colorCrit + ';color:#FFFFFF;font-weight:700;font-size:11.5px;' +
      'letter-spacing:.02em">CRITICIDAD ' + escapeHtml(criticidad) + (sinConfirmar ? ' · SIN CONFIRMAR' : '') + '</span>';
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
        var avisoConfirmacionHtml = caso.sinConfirmar
          ? '<div class="aviso-sin-datos">⚠ ' + escapeHtml(textoSinConfirmar(caso)) + '</div>' : '';
        var avisoSinDatosHtml = avisoConfirmacionHtml + (caso.encontrada ? '' :
          '<div class="aviso-sin-datos">⚠ No se encontró ninguna falla real para este vehículo en la ventana consultada -- este expediente documenta únicamente la ubicación disponible alrededor de la fecha/hora ingresada manualmente.</div>');

        var datos = {
          movil: partesVeh.codigo || caso.nombreVehiculo, placa: caso.placa || partesVeh.placa,
          nombreFalla: caso.descripcion, spn: caso.spn, fmi: caso.fmi, categoria: caso.categoria,
          significadoFmi: significadoFmi(caso.fmi),
          generadoTexto: formatearFechaHora(ahoraGeneracion),
          avisoSinDatosHtml: avisoSinDatosHtml,
          pildorasHtml: construirPildorasHtml(caso.criticidad, caso.activo !== false, caso.sinConfirmar),
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
    var restaurar = marcarOcupado(enlace);
    ensamblarYDescargarExpediente(resolverCasoDesdeFila(it)).catch(function (err) {
      console.error('Alertas (expediente):', err);
      alert('No se pudo generar el expediente: ' + ((err && err.message) || err));
    }).then(function () {
      expedienteEnCurso = false;
      restaurar();
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
          criticidad: it.criticidad, conteo: 0, fechaReferencia: it.fecha, posicion: null,
          sinConfirmar: true, estadoConf: it.estadoConf, horasSinReporte: it.horasSinReporte
        };
        orden.push(clave);
      }
      g.conteo++;
      if (!it.sinConfirmar) { g.sinConfirmar = false; g.estadoConf = 'confirmado'; }   // basta un reporte confirmado para que el código cuente como confirmado
      if (it.horasSinReporte < g.horasSinReporte) g.horasSinReporte = it.horasSinReporte;
      if ((ORDEN_CRITICIDAD[it.criticidad] || 0) > (ORDEN_CRITICIDAD[g.criticidad] || 0)) g.criticidad = it.criticidad;
      if (it.fecha > g.fechaReferencia) g.fechaReferencia = it.fecha;
    });
    return orden.map(function (clave) { return porClave[clave]; });
  }

  // Una fila <tr> de la tabla resumen -- nota "Ubicaci\u00f3n no disponible" en vez de
  // omitir el c\u00f3digo si resolverPosicionGps no encontr\u00f3 nada (pedido expl\u00edcito).
  function construirFilaResumenConsolidadoHtml(g) {
    var colorCat = COLOR_CATEGORIA_MAPA[g.categoria] || COLOR_CATEGORIA_MAPA.General;
    var colorCrit = g.sinConfirmar ? '#94A3B8' : (COLOR_POR_CRITICIDAD[g.criticidad] || '#94A3B8');
    var ubicacionHtml = g.posicion
      ? '<span class="en-mapa">Ver mapa</span>'
      : '<span class="sin-gps">Ubicaci\u00f3n no disponible</span>';
    return '<tr>' +
      '<td class="codigo-celda">SPN ' + escapeHtml(g.spn) + '<br>FMI ' + escapeHtml(g.fmi) + '</td>' +
      '<td>' + escapeHtml(g.nombreFalla) +
        (g.sinConfirmar ? '<div class="sin-gps">' + (g.estadoConf === 'sin-evidencia' ? 'Sin evidencia' : 'Sin confirmación reciente') + ': hace ' + textoAntiguedad(g.horasSinReporte) + '</div>' : '') +
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

  // Mapa del expediente CONSOLIDADO (varios marcadores).
  // CAMBIO (2026-10-10, bug real visto en campo con el movil 1149): el mapa base
  // salia MAS AMPLIADO que los marcadores (los puntos estaban a ~24 px/km y las
  // calles a ~41 px/km), asi que los puntos caian en barrios que no eran, y un
  // marcador (el de la base del Distrito) quedaba fuera del recuadro. Era el mismo
  // origen de los dos arreglos anteriores (2026-10-01 y 2026-10-02): Leaflet mueve
  // las teselas con transformaciones CSS y animaciones de zoom, y html2canvas las
  // captura a medias o con otra escala. Se parchaba cada sintoma y volvia a salir.
  // Solucion de fondo: este mapa YA NO USA LEAFLET. Se calcula todo con la misma
  // formula (Web Mercator) para teselas y marcadores:
  //   - se elige el mayor zoom en el que entran todos los puntos con margen,
  //   - cada tesela es un <img> en posicion absoluta (left/top en pixeles, sin
  //     transform ni animacion),
  //   - cada marcador es un <div> en posicion absoluta calculado con la MISMA
  //     funcion que las teselas -- no existe un segundo calculo que pueda diferir.
  // El mapa de un solo codigo (SCRIPT_INIT_MAPA) no se toco.
  function scriptMapaConsolidado() {
    var TESELA = 256, MARGEN = 26, RADIO = 8;
    var el = document.getElementById('mapa');
    function listo() { window.__mapaListo = true; }
    function aviso(texto) {
      if (el) el.innerHTML = '<div style="padding:28px 10px;text-align:center;font-size:12px;color:#64748b">' + texto + '</div>';
      listo();
    }
    try {
      var datosEl = document.getElementById('mapa-datos');
      var datos = datosEl ? JSON.parse(datosEl.textContent) : null;
      var puntos = (datos && datos.puntos) ? datos.puntos : [];
      if (!el || !puntos.length) { aviso('Ninguno de los códigos tiene ubicación GPS disponible.'); return; }
      var W = el.clientWidth || 416, H = el.clientHeight || 240;

      function mundoPx(lat, lon, z) {
        var tam = TESELA * Math.pow(2, z);
        var s = Math.sin(lat * Math.PI / 180);
        return { x: (lon + 180) / 360 * tam, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * tam };
      }

      // Zoom: el mayor en el que todos los puntos entran con margen (un solo punto -> 15).
      var z = 15;
      if (puntos.length > 1) {
        for (z = 17; z > 2; z--) {
          var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          puntos.forEach(function (p) {
            var m = mundoPx(p.lat, p.lon, z);
            minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x); minY = Math.min(minY, m.y); maxY = Math.max(maxY, m.y);
          });
          if ((maxX - minX) <= W - 2 * MARGEN && (maxY - minY) <= H - 2 * MARGEN) break;
        }
      }
      var cx = 0, cy = 0, minX2 = Infinity, maxX2 = -Infinity, minY2 = Infinity, maxY2 = -Infinity;
      puntos.forEach(function (p) {
        var m = mundoPx(p.lat, p.lon, z);
        minX2 = Math.min(minX2, m.x); maxX2 = Math.max(maxX2, m.x); minY2 = Math.min(minY2, m.y); maxY2 = Math.max(maxY2, m.y);
      });
      cx = (minX2 + maxX2) / 2; cy = (minY2 + maxY2) / 2;
      var ox = cx - W / 2, oy = cy - H / 2;           // esquina superior izquierda del recuadro, en pixeles del mundo

      el.style.position = 'relative';
      el.style.overflow = 'hidden';
      el.style.background = '#e2e8f0';

      // Teselas
      var n = Math.pow(2, z), pendientes = 0, errores = 0, total = 0, terminado = false;
      function terminar() { if (terminado) return; terminado = true; if (total && errores === total) { var nota = document.createElement('div'); nota.textContent = 'Mapa base no disponible (sin conexión)'; nota.style.cssText = 'position:absolute;left:0;right:0;top:8px;text-align:center;font-size:11px;color:#64748b'; el.appendChild(nota); } listo(); }
      function alTerminarTesela(fallo) { if (fallo) errores++; pendientes--; if (pendientes <= 0) terminar(); }
      for (var tx = Math.floor(ox / TESELA); tx <= Math.floor((ox + W) / TESELA); tx++) {
        for (var ty = Math.floor(oy / TESELA); ty <= Math.floor((oy + H) / TESELA); ty++) {
          if (ty < 0 || ty >= n) continue;
          // +1 px de ancho/alto: las baldosas se superponen 1 px para que html2canvas no deje una linea clara entre filas/columnas (la posicion NO cambia)
          var img = document.createElement('img');
          img.crossOrigin = 'anonymous';
          img.alt = '';
          img.style.cssText = 'position:absolute;display:block;width:' + (TESELA + 1) + 'px;height:' + (TESELA + 1) + 'px;max-width:none;left:' + Math.round(tx * TESELA - ox) + 'px;top:' + Math.round(ty * TESELA - oy) + 'px';
          pendientes++; total++;
          img.onload = function () { alTerminarTesela(false); };
          img.onerror = function () { alTerminarTesela(true); };
          img.src = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/' + z + '/' + ty + '/' + (((tx % n) + n) % n);
          el.appendChild(img);
        }
      }

      // Marcadores: misma funcion mundoPx que las teselas. Si varios codigos tienen
      // exactamente la misma posicion (mismo evento), se abren en abanico unos pixeles
      // para que se vean todos los colores en vez de quedar uno tapando a los demas.
      var grupos = {};
      puntos.forEach(function (p) { var k = p.lat.toFixed(5) + ',' + p.lon.toFixed(5); (grupos[k] = grupos[k] || []).push(p); });
      Object.keys(grupos).forEach(function (k) {
        var g = grupos[k];
        g.forEach(function (p, i) {
          var m = mundoPx(p.lat, p.lon, z);
          var dx = 0, dy = 0;
          if (g.length > 1) { var ang = (2 * Math.PI * i) / g.length - Math.PI / 2; dx = Math.cos(ang) * (RADIO * 0.9); dy = Math.sin(ang) * (RADIO * 0.9); }
          var pin = document.createElement('div');
          pin.style.cssText = 'position:absolute;box-sizing:border-box;border-radius:50%;border:1.5px solid #1e293b;opacity:.92;z-index:5;' +
            'width:' + (RADIO * 2) + 'px;height:' + (RADIO * 2) + 'px;' +
            'left:' + Math.round(m.x - ox - RADIO + dx) + 'px;top:' + Math.round(m.y - oy - RADIO + dy) + 'px;' +
            'background:' + (p.color || '#94a3b8');
          el.appendChild(pin);
        });
      });

      var atr = document.createElement('div');
      atr.textContent = 'Tiles © Esri';
      atr.style.cssText = 'position:absolute;right:0;bottom:0;z-index:6;background:rgba(255,255,255,.8);color:#475569;font-size:9px;padding:1px 5px;border-top-left-radius:4px';
      el.appendChild(atr);

      if (!pendientes) terminar();
      setTimeout(terminar, 6000);   // tope: si alguna tesela no responde, igual se captura
    } catch (e) { aviso('No se pudo cargar el mapa.'); }
  }
  var SCRIPT_INIT_MAPA_CONSOLIDADO = '(' + scriptMapaConsolidado.toString() + ')();';

  // Arma el div del mapa + el JSON de puntos + el script de init, mismo patron
  // de slot que construirDondeHtml. Solo entran al mapa los grupos que SI
  // resolvieron posicion (los sin GPS ya quedan marcados en la tabla resumen,
  // no se les inventa una coordenada).
  function construirMapaConsolidadoHtml(grupos) {
    var puntos = grupos.filter(function (g) { return g.posicion; }).map(function (g) {
      return { lat: g.posicion.lat, lon: g.posicion.lon, color: COLOR_CATEGORIA_MAPA[g.categoria] || COLOR_CATEGORIA_MAPA.General };
    });
    var datosMapa = { puntos: puntos };
    return '<div class="map-wrap"><div id="mapa" style="height:300px;border-radius:10px;overflow:hidden"></div></div>' +
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
    boton.disabled = true;
    var restaurar = marcarOcupado(boton);
    ensamblarYDescargarExpedienteConsolidado(v).catch(function (err) {
      console.error('Alertas (expediente consolidado):', err);
      alert('No se pudo generar el expediente consolidado: ' + ((err && err.message) || err));
    }).then(function () {
      expedienteEnCurso = false;
      boton.disabled = false;
      restaurar();
    });
  }

  var PLANTILLA_EXPEDIENTE_CONSOLIDADO_EMBEBIDA = "<!doctype html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>Expediente Consolidado \u2014 Resumen de Fallas</title>\n<!-- Leaflet (mismo CDN/versi\u00f3n que reporte_expediente_plantilla.html) -- este HTML se\n     descarga y se abre fuera del sandbox del add-in, puede cargar librer\u00edas externas\n     por CDN sin problema de CSP. Si no hay internet cuando se abre, el script inline\n     de abajo detecta que \"L\" no existe y muestra un aviso sin romper el resto. -->\n<link rel=\"stylesheet\" href=\"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css\">\n<script src=\"https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js\"></script>\n<style>\n:root{--ink:#0b2454;--accent:#0891b2;--corp:#2563eb;--muted:#64748b;--border:#e2e8f0;--bg:#f1f5f9;--card:#ffffff;\n      --alta:#dc2626;--media:#f59e0b;--baja:#94a3b8;--good:#16a34a}\n*{box-sizing:border-box}\nbody{margin:0;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:#1e293b;font-size:14px;display:flex;justify-content:center}\n.card{width:100%;max-width:480px;background:var(--card);border-radius:16px;padding:22px 20px 18px;box-shadow:0 1px 2px rgba(15,23,42,.05),0 8px 24px rgba(15,23,42,.06)}\n.eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:750}\n.subtitulo{font-size:13px;font-weight:650;color:var(--ink);margin-top:2px}\n.titulo-movil{font-size:22px;font-weight:800;color:var(--ink);letter-spacing:-.01em;margin:10px 0 2px}\n.titulo-movil .placa{font-size:14px;font-weight:650;color:var(--muted);margin-left:8px}\n.field-sub{font-size:12px;color:var(--muted);margin-top:2px;line-height:1.4}\n.seccion-titulo{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:750;margin:18px 0 8px;border-top:1px solid var(--border);padding-top:14px}\ntable.dt{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:4px;table-layout:fixed}\ntable.dt th{text-align:left;padding:5px 4px;font-size:9px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border-bottom:1px solid var(--border);font-weight:750}\ntable.dt td{padding:6px 4px;border-bottom:1px solid var(--border);vertical-align:top;word-break:break-word;line-height:1.35}\ntable.dt th:nth-child(1), table.dt td:nth-child(1){width:58px}\ntable.dt th:nth-child(3), table.dt td:nth-child(3){width:50px;text-align:center}\ntable.dt th:nth-child(4), table.dt td:nth-child(4){width:28px;text-align:center}\ntable.dt th:nth-child(5), table.dt td:nth-child(5){width:62px}\ntable.dt th:nth-child(6), table.dt td:nth-child(6){width:72px;font-size:10px}\n.codigo-celda{font-family:'Courier New',monospace;font-weight:700;color:var(--accent)}\n.badge-cat{display:inline-block;padding:1px 7px;border-radius:999px;color:#fff;font-size:9px;font-weight:700;margin-top:3px}\n.badge-criticidad{display:inline-block;min-width:38px;text-align:center;padding:2px 6px;border-radius:999px;color:#fff;font-weight:700;font-size:9.5px}\n.sin-gps{font-style:italic;color:var(--muted);font-size:10px}\n.en-mapa{color:var(--muted);font-size:10px}\n.map-wrap{margin-top:6px}\n.leyenda{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:10px;font-size:11px;color:#1e293b}\n.leyenda-item{display:flex;align-items:center;gap:6px}\n.leyenda-cuadro{width:10px;height:10px;border-radius:2px;display:inline-block;flex:none}\nfooter{text-align:center;color:var(--muted);font-size:10.5px;padding:16px 2px 2px;border-top:1px solid var(--border);margin-top:20px}\n@media print{ body{background:#fff;padding:0} .card{box-shadow:none;max-width:none} }\n</style>\n</head>\n<body>\n\n<div class=\"card\">\n\n  <header>\n    <div class=\"eyebrow\">Telemetry &amp; Fleet Intelligence</div>\n    <div class=\"subtitulo\">Expediente consolidado de fallas</div>\n  </header>\n\n  <h1 class=\"titulo-movil\">M\u00d3VIL {{MOVIL}} <span class=\"placa\">{{PLACA}}</span></h1>\n  <div class=\"field-sub\">{{CIUDAD}} \u00b7 {{MARCA}} \u00b7 Motor: {{REFERENCIA_MOTOR}} ({{N_MOTOR}})</div>\n\n  <div class=\"seccion-titulo\">Resumen de c\u00f3digos activos ({{TOTAL_CODIGOS}})</div>\n  <table class=\"dt\">\n    <thead>\n      <tr><th>C\u00f3digo</th><th>Descripci\u00f3n</th><th>Criticidad</th><th>Veces</th><th>Ubicaci\u00f3n</th><th>\u00daltimo reporte</th></tr>\n    </thead>\n    <tbody id=\"resumen-filas-slot\"></tbody>\n  </table>\n\n  <div class=\"seccion-titulo\">Ubicaci\u00f3n de los c\u00f3digos</div>\n  <div id=\"mapa-slot\"></div>\n\n  <div class=\"leyenda\" id=\"leyenda-slot\"></div>\n\n  <footer>Generado {{GENERADO}}</footer>\n\n</div>\n\n</body>\n</html>\n";

  // Pastilla de un código activo en Geotab que lleva días sin reportarse (ver agregarConfirmacion).
  function crearPildoraPorVerificar(it) {
    var p = crear('span', {
      display: 'inline-block', padding: '2px 8px', borderRadius: '4px', fontSize: '0.64rem', fontWeight: '700',
      letterSpacing: '0.04em', textTransform: 'uppercase', color: D.textSoft, cursor: 'help',
      background: 'rgba(148,163,184,0.10)', border: '1px dashed ' + D.borderStrong,
      whiteSpace: 'normal', maxWidth: '88px', textAlign: 'center', lineHeight: '1.25'   // las etiquetas largas pasan a dos líneas en vez de invadir la columna siguiente
    }, etiquetaConfirmacion(it));
    if (it.tipoSE === 'dispositivo') { p.style.color = D.naranja; p.style.borderColor = D.naranja; p.style.background = 'rgba(250,173,20,0.10)'; }
    p.title = textoSinConfirmar(it);
    return p;
  }

  function crearPildoraCriticidad(criticidad) {
    var estilo = ESTILO_NIVEL[criticidad] || ESTILO_NIVEL.BAJA;
    return crear('span', {
      display: 'inline-block', minWidth: '48px', textAlign: 'center', padding: '2px 10px', borderRadius: '4px',
      background: estilo.fondo, color: estilo.texto, border: '1px solid ' + estilo.borde,
      fontWeight: '700', fontSize: '0.66rem', letterSpacing: '0.06em', textTransform: 'uppercase'
    }, criticidad);
  }

  // Estado de la falla: hoy esta vista solo trae fallas con faultState==='Active'
  // (a propósito, a pedido del usuario), así que solo se pinta cuando NO está
  // activa -- una pastilla "Activo" en cada fila era ruido.
  function crearPildoraEstadoActivo(activo) {
    return crear('span', {
      display: 'inline-block', padding: '2px 8px', borderRadius: '4px', marginLeft: '6px',
      background: 'rgba(148,163,184,0.14)', color: D.muted, fontWeight: '700', fontSize: '0.64rem',
      letterSpacing: '0.04em', textTransform: 'uppercase'
    }, activo ? 'Activo' : 'Inactivo');
  }

  var NOMBRE_TURNO = { T1: 'Mañana (05:00–12:59)', T2: 'Tarde (13:00–20:59)', T3: 'Noche (21:00–04:59)' };

  // Botón de icono de la columna Acciones: tenue en reposo, se enciende al pasar
  // por la fila (ver construirFilaFalla) y al enfocarlo con el teclado.
  function crearAccion(icono, titulo, tag) {
    var el = crear(tag || 'button', {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '6px', borderRadius: '6px',
      background: 'transparent', border: 'none', color: D.muted, cursor: 'pointer', textDecoration: 'none',
      transition: 'color 0.15s, transform 0.15s, background 0.15s'
    });
    if (!tag || tag === 'button') el.type = 'button';
    el.title = titulo;
    el.setAttribute('aria-label', titulo);
    el.setAttribute('data-compacto', '1');
    el.appendChild(crearIcono(icono, '17px'));
    function encender() { aplicarEstilo(el, { color: D.verde, transform: 'scale(1.12)', background: 'rgba(0,208,132,0.10)' }); }
    function apagar() { aplicarEstilo(el, { color: D.muted, transform: 'scale(1)', background: 'transparent' }); }
    el.addEventListener('mouseenter', encender);
    el.addEventListener('mouseleave', apagar);
    el.addEventListener('focus', encender);
    el.addEventListener('blur', apagar);
    return el;
  }

  var ESTILO_CELDA = { padding: '10px 14px', borderBottom: '1px solid ' + D.border, verticalAlign: 'middle' };

  function celdaFalla(estilos, contenido) {
    var td = crear('td', ESTILO_CELDA);
    if (estilos) aplicarEstilo(td, estilos);
    if (contenido !== undefined && contenido !== null) {
      if (typeof contenido === 'string') td.textContent = contenido; else td.appendChild(contenido);
    }
    return td;
  }

  // Una falla = dos <tr> (la fila y, debajo, el historial desplegable). La usan
  // la vista cronológica (con columna Vehículo) y las tarjetas por vehículo.
  // opciones.conVehiculo: agrega la columna Vehículo (clic = filtrar por él).
  function construirFilaFalla(it, opciones) {
    var apagada = !!it.sinConfirmar;   // por verificar: se ve atenuada y sin el tinte de alarma
    var estilo = ESTILO_NIVEL[apagada ? 'BAJA' : it.criticidad] || ESTILO_NIVEL.BAJA;
    var conVehiculo = !!(opciones && opciones.conVehiculo);
    var columnas = conVehiculo ? 9 : 8;
    var esBaja = it.criticidad === 'BAJA' || apagada;

    var fila = crear('tr', { background: estilo.fila, transition: 'background 0.15s' });

    var celdaFecha = celdaFalla({
      whiteSpace: 'nowrap', color: esBaja ? D.muted : D.textSoft,
      borderLeft: '3px solid ' + (esBaja ? 'transparent' : estilo.color)
    }, fechaCorta(it.fecha));
    celdaFecha.title = formatearFechaHora(it.fecha);
    if (apagada) {
      celdaFecha.appendChild(crear('div', { fontSize: '0.68rem', color: D.faint, marginTop: '2px' },
        'hace ' + textoAntiguedad(it.horasSinReporte) + (it.kmDesde !== null && it.kmDesde !== undefined ? ' · ' + Math.round(it.kmDesde) + ' km' : '')));
    }
    fila.appendChild(celdaFecha);

    if (conVehiculo) {
      var botonVehiculo = crear('button', {
        background: 'transparent', border: 'none', padding: '0', cursor: 'pointer', fontFamily: T.font,
        // v1.22: con nowrap los nombres largos ("1148-NWW623 - NWW623-1148") se salían de la columna y tapaban el Nivel
        fontSize: '0.82rem', fontWeight: '700', color: esBaja ? D.textSoft : '#FFFFFF', whiteSpace: 'normal',
        overflowWrap: 'anywhere', textAlign: 'left', maxWidth: '100%'
      }, it.claveVehiculo);
      botonVehiculo.type = 'button';
      botonVehiculo.title = 'Ver solo este vehículo';
      botonVehiculo.addEventListener('mouseenter', function () { botonVehiculo.style.textDecoration = 'underline'; });
      botonVehiculo.addEventListener('mouseleave', function () { botonVehiculo.style.textDecoration = 'none'; });
      botonVehiculo.addEventListener('click', function () {
        filtroEstado.vehiculo = it.claveVehiculo;
        if (barraFiltrosRefs) barraFiltrosRefs.mostrarChipVehiculo(it.claveVehiculo);
        actualizarVista();
      });
      fila.appendChild(celdaFalla(null, botonVehiculo));
    }

    var celdaNivel = celdaFalla({ whiteSpace: 'nowrap', textAlign: 'center' });
    var pildoraNivel = crearPildoraCriticidad(it.criticidad);
    if (apagada) pildoraNivel.style.opacity = '0.45';
    celdaNivel.appendChild(pildoraNivel);
    if (apagada) {
      celdaNivel.appendChild(crear('div', { marginTop: '4px' })).appendChild(crearPildoraPorVerificar(it));
      if (it.tipoSE === 'dispositivo') celdaNivel.appendChild(crear('div', { fontSize: '0.64rem', color: D.naranja, marginTop: '3px' }, it.motivoCorto));
    }
    if (!it.activo) celdaNivel.appendChild(crearPildoraEstadoActivo(false));
    fila.appendChild(celdaNivel);

    fila.appendChild(celdaFalla({
      fontFamily: "'Courier New', monospace", fontSize: '0.76rem', color: esBaja ? '#7AA6D6' : D.azul,
      fontWeight: '700', whiteSpace: 'nowrap'
    }, 'SPN ' + it.spn + '/FMI ' + it.fmi));

    fila.appendChild(celdaFalla({
      whiteSpace: 'nowrap', color: esBaja ? D.muted : D.textSoft, fontWeight: it.destacado ? '700' : '400'
    }, it.categoria));

    // Los sistemas críticos (ABS, neumáticos, postratamiento, motor) siguen
    // resaltándose, igual que en el PDF de Telegram: ahora en negrita sobre el
    // color del nivel, ya no todo en mayúsculas.
    fila.appendChild(celdaFalla({
      color: estilo.descripcion, fontWeight: it.destacado ? '700' : '500', lineHeight: '1.35'
    }, it.nombreFalla));

    var celdaTurno = celdaFalla({ textAlign: 'center', color: D.muted }, it.turno || '—');
    if (it.turno && NOMBRE_TURNO[it.turno]) celdaTurno.title = NOMBRE_TURNO[it.turno];
    fila.appendChild(celdaTurno);

    var partesVeh = codigoYPlacaDeNombre(it.nombreVehiculo);
    var conductor = buscarConductor(it.placa || partesVeh.placa, partesVeh.codigo, it.fecha);
    fila.appendChild(celdaFalla({
      color: !conductor ? D.faint : (conductor.aproximado ? '#F59E0B' : D.textSoft),
      fontStyle: conductor ? 'normal' : 'italic', fontSize: '0.78rem'
    }, textoConductorConGrupo(conductor)));

    // --- Acciones ---
    var grupoAcciones = crear('div', { display: 'flex', justifyContent: 'center', gap: '2px', opacity: '0.45', transition: 'opacity 0.15s' });
    var enlaceCausa = crearAccion('buscar', 'Buscar causa raíz', 'a');
    enlaceCausa.href = urlBusquedaCausa(it.spn, it.fmi);
    enlaceCausa.target = '_blank';
    enlaceCausa.rel = 'noopener noreferrer';
    grupoAcciones.appendChild(enlaceCausa);

    var filaHistorial = crear('tr');
    var celdaHistorial = crear('td', { padding: '0 14px 10px 14px', borderBottom: '1px solid ' + D.border, background: estilo.fila });
    celdaHistorial.colSpan = columnas;
    filaHistorial.appendChild(celdaHistorial);
    filaHistorial.hidden = true;

    var botonHistorial = crearAccion('historial', 'Ver historial del código');
    botonHistorial.setAttribute('aria-expanded', 'false');
    var cargado = false;
    botonHistorial.addEventListener('click', function () {
      filaHistorial.hidden = !filaHistorial.hidden;
      botonHistorial.setAttribute('aria-expanded', filaHistorial.hidden ? 'false' : 'true');
      if (!filaHistorial.hidden && !cargado) {
        cargado = true;
        var panelHist = crearPanelHistorial();
        celdaHistorial.appendChild(panelHist);
        obtenerHistorialFalla(it.idVehiculo, it.idDiagnostico, it.idFailureMode).then(function (historial) {
          llenarPanelHistorial(panelHist, historial);
        });
      }
    });
    grupoAcciones.appendChild(botonHistorial);

    // Mini Expediente (2026-10-01): la fila YA ES la selección completa
    // (vehículo+diagnóstico+failureMode+fecha) -- sin picker, un clic basta.
    var botonExpediente = crearAccion('expediente', 'Generar expediente');
    botonExpediente.addEventListener('click', function () { generarExpedienteDesdeFila(it, botonExpediente); });
    grupoAcciones.appendChild(botonExpediente);

    fila.appendChild(celdaFalla({ textAlign: 'center', whiteSpace: 'nowrap' }, grupoAcciones));

    function resaltarFila() { fila.style.background = estilo.filaHover; grupoAcciones.style.opacity = '1'; }
    function normalizarFila() { fila.style.background = estilo.fila; grupoAcciones.style.opacity = '0.45'; }
    fila.addEventListener('mouseenter', resaltarFila);
    fila.addEventListener('mouseleave', normalizarFila);
    fila.addEventListener('focusin', resaltarFila);
    fila.addEventListener('focusout', normalizarFila);

    return { fila: fila, filaHistorial: filaHistorial };
  }

  // Tabla de fallas (cabecera fija al desplazar). filas: ítems ya filtrados/ordenados.
  function construirTablaFallas(filas, conVehiculo) {
    var titulos = conVehiculo
      ? ['Fecha / Hora', 'Vehículo', 'Nivel', 'Código SPN/FMI', 'Sistema', 'Descripción del diagnóstico', 'Turno', 'Conductor', 'Acciones']
      : ['Fecha / Hora', 'Nivel', 'Código SPN/FMI', 'Sistema', 'Descripción del diagnóstico', 'Turno', 'Conductor', 'Acciones'];
    var centrados = { 'Nivel': true, 'Turno': true, 'Acciones': true };

    // Anchos fijos por columna: así todas las tablas (una por vehículo) quedan
    // alineadas entre sí, y la Descripción se queda con el resto. Por debajo de
    // minWidth la tabla se desplaza en horizontal dentro de su tarjeta.
    var ANCHO_COLUMNA = {
      'Fecha / Hora': 120, 'Vehículo': 170, 'Nivel': 116, 'Código SPN/FMI': 150, 'Sistema': 160,
      'Turno': 64, 'Conductor': 150, 'Acciones': 120
    };
    var anchoFijo = 0;
    titulos.forEach(function (titulo) { anchoFijo += ANCHO_COLUMNA[titulo] || 0; });

    var envoltorio = crear('div', { overflow: 'auto', maxHeight: conVehiculo ? '68vh' : 'none' });
    envoltorio.setAttribute('data-scroll', 'tabla'); // el refresco automático conserva su posición
    var tabla = crear('table', {
      width: '100%', minWidth: (anchoFijo + 320) + 'px', tableLayout: 'fixed',
      borderCollapse: 'separate', borderSpacing: '0', fontSize: '0.82rem', textAlign: 'left'
    });
    var grupoColumnas = crear('colgroup');
    titulos.forEach(function (titulo) {
      var col = crear('col');
      if (ANCHO_COLUMNA[titulo]) col.style.width = ANCHO_COLUMNA[titulo] + 'px';
      grupoColumnas.appendChild(col);
    });
    tabla.appendChild(grupoColumnas);
    var cabecera = crear('thead');
    var filaCabecera = crear('tr');
    titulos.forEach(function (titulo) {
      filaCabecera.appendChild(crear('th', {
        position: 'sticky', top: '0', zIndex: '2', background: D.panelAlt, color: D.muted,
        padding: '10px 14px', borderBottom: '1px solid ' + D.borderStrong, fontSize: '0.68rem', fontWeight: '600',
        textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
        textAlign: centrados[titulo] ? 'center' : 'left'
      }, titulo));
    });
    cabecera.appendChild(filaCabecera);
    tabla.appendChild(cabecera);

    var cuerpo = crear('tbody');
    filas.forEach(function (it) {
      var par = construirFilaFalla(it, { conVehiculo: conVehiculo });
      cuerpo.appendChild(par.fila);
      cuerpo.appendChild(par.filaHistorial);
    });
    tabla.appendChild(cuerpo);
    envoltorio.appendChild(tabla);
    return envoltorio;
  }

  function crearTarjetaVehiculo(v) {
    var estiloVeh = ESTILO_NIVEL[v.criticidad] || ESTILO_NIVEL.BAJA;
    var tarjeta = crear('div', {
      marginBottom: '12px', overflow: 'hidden', background: D.panel, border: '1px solid ' + D.border,
      borderLeft: '4px solid ' + (v.criticidad === 'BAJA' ? D.borderStrong : estiloVeh.color), borderRadius: T.radius.sm
    });

    var cabecera = crear('div', {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px',
      background: D.panelAlt, padding: '12px 16px', borderBottom: '1px solid ' + D.border
    });

    var info = crear('div', { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '12px' });
    info.appendChild(crear('span', { fontWeight: '700', color: '#FFFFFF', fontSize: '1rem' }, v.claveVehiculo));
    info.appendChild(v.soloPorVerificar ? crearPildoraPorVerificar(v.items[0]) : crearPildoraCriticidad(v.criticidad));
    info.appendChild(crear('span', { color: D.muted, fontSize: '0.8rem' },
      v.ciudad + ' · ' + v.marca + ' · Motor: ' + v.referenciaMotor + ' (' + v.nMotor + ')'));
    info.appendChild(crear('span', { color: D.faint, fontSize: '0.76rem' },
      v.items.length + (v.items.length === 1 ? ' código' : ' códigos')));
    cabecera.appendChild(info);

    // Expediente Consolidado (2026-10-02): a diferencia de "Generar expediente" (una
    // fila = un código), este botón opera sobre TODO v.items del vehículo.
    var botonConsolidado = crear('button', {
      display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '7px 12px', cursor: 'pointer',
      background: 'transparent', color: D.verde, border: '1px solid rgba(0,208,132,0.5)', borderRadius: T.radius.sm,
      fontWeight: '700', fontSize: '0.76rem', fontFamily: T.font, whiteSpace: 'nowrap'
    });
    botonConsolidado.type = 'button';
    botonConsolidado.appendChild(crearIcono('capas', '15px'));
    botonConsolidado.appendChild(crear('span', {}, 'Expediente consolidado'));
    botonConsolidado.addEventListener('mouseenter', function () { botonConsolidado.style.background = 'rgba(0,208,132,0.12)'; });
    botonConsolidado.addEventListener('mouseleave', function () { botonConsolidado.style.background = 'transparent'; });
    botonConsolidado.addEventListener('click', function () { generarExpedienteConsolidadoDesdeBoton(v, botonConsolidado); });
    cabecera.appendChild(botonConsolidado);

    tarjeta.appendChild(cabecera);
    tarjeta.appendChild(construirTablaFallas(v.items, false));
    return tarjeta;
  }

  // --- Render principal --------------------------------------------------
  function crearEstadoVacio(texto, color) {
    return crear('div', { padding: '34px 22px', textAlign: 'center', fontSize: '0.9rem', fontWeight: '600', color: color || D.muted }, texto);
  }

  function construirCabeceraResultados(totalFilas, totalVehiculos) {
    var cabecera = crear('div', {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px',
      padding: '12px 16px', background: D.panelAlt, borderBottom: '1px solid ' + D.border
    });
    var titulo = crear('div', { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' });
    titulo.appendChild(crear('span', { fontWeight: '700', color: '#FFFFFF', fontSize: '0.95rem' }, 'Fallas activas'));
    titulo.appendChild(crear('span', { color: D.muted, fontSize: '0.78rem' },
      totalFilas + (totalFilas === 1 ? ' código' : ' códigos') + ' · ' + totalVehiculos + (totalVehiculos === 1 ? ' vehículo' : ' vehículos') +
      (tieneFiltrosActivos() ? ' (con filtros)' : '')));
    cabecera.appendChild(titulo);

    // Alternador de vista: tarjetas por vehículo (orden por criticidad, diseño del
    // PDF) vs. lista cronológica de toda la flota (la más reciente arriba).
    var grupo = crear('div', { display: 'inline-flex', border: '1px solid ' + D.borderStrong, borderRadius: T.radius.sm, overflow: 'hidden' });
    [['vehiculo', 'Por vehículo'], ['cronologico', 'Más recientes primero']].forEach(function (par) {
      var activo = modoVista === par[0];
      var boton = crear('button', {
        padding: '6px 14px', border: 'none', cursor: 'pointer', fontFamily: T.font, fontSize: '0.76rem', fontWeight: '700',
        background: activo ? D.verde : 'transparent', color: activo ? '#06210F' : D.textSoft
      }, par[1]);
      boton.type = 'button';
      boton.setAttribute('aria-pressed', activo ? 'true' : 'false');
      boton.addEventListener('click', function () {
        if (modoVista === par[0]) return;
        modoVista = par[0];
        guardarModoVista(modoVista);
        actualizarVista();
      });
      grupo.appendChild(boton);
    });
    cabecera.appendChild(grupo);
    return cabecera;
  }

  function construirPieResultados(totalOcultas) {
    var pie = crear('div', {
      display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '6px 18px',
      padding: '10px 16px', background: D.panelAlt, borderTop: '1px solid ' + D.border, fontSize: '0.74rem', color: D.muted
    });
    pie.appendChild(crear('span', {}, totalOcultas > 0
      ? 'Filtro activo: ocultadas ' + totalOcultas + ' falla(s) de conectividad telemática y diagnósticos sin nombre reconocible que no aportan al mantenimiento.'
      : 'Sin fallas ocultas por conectividad.'));
    pie.appendChild(crear('span', {}, textoEstadoTripulaciones()));
    return pie;
  }

  function renderizarResultados(contenedor, resultado) {
    limpiarNodo(contenedor);

    // Los KPI cuentan TODA la flota con fallas, sin filtros (igual que el resumen anterior).
    if (elementos.kpis) elementos.kpis.pintar(resultado.vehiculos);

    if (resultado.vehiculos.length === 0) {
      // Puerto de las dos ramas distintas en generar_pdf_reporte_fallas: "nada
      // pasó" (éxito) vs "algo pasó pero todo era irrelevante" (aclarar cuánto
      // se ocultó, no mostrar el mensaje de éxito que sería engañoso).
      var panelVacio = crear('div', { background: D.panel, border: '1px solid ' + D.border, borderRadius: T.radius.sm });
      panelVacio.appendChild(resultado.totalOcultas > 0
        ? crearEstadoVacio('No hay fallas activas relevantes en este momento (se ocultaron ' + resultado.totalOcultas +
            ' de conectividad/diagnóstico desconocido).', D.textSoft)
        : crearEstadoVacio('✅ No hay fallas activas en este momento. ¡Excelente!', D.verde));
      contenedor.appendChild(panelVacio);
      return;
    }

    var vehiculosFiltrados = aplicarFiltros(resultado.vehiculos);
    var filas = aplanarFallas(vehiculosFiltrados);

    var panel = crear('div', { background: D.panel, border: '1px solid ' + D.border, borderRadius: T.radius.sm, overflow: 'hidden', boxShadow: D.sombra });
    panel.appendChild(construirCabeceraResultados(filas.length, vehiculosFiltrados.length));

    if (vehiculosFiltrados.length === 0) {
      panel.appendChild(crearEstadoVacio('Ningún vehículo coincide con los filtros actuales.' +
        (tieneFiltrosActivos() ? ' Prueba quitando alguno.' : '')));
    } else if (modoVista === 'cronologico') {
      panel.appendChild(construirTablaFallas(filas, true));
    } else {
      // Una sola lista de tarjetas, ya ordenada (más crítico primero) desde agruparPorVehiculo.
      var lista = crear('div', { padding: '12px 12px 0 12px' });
      vehiculosFiltrados.forEach(function (v) { lista.appendChild(crearTarjetaVehiculo(v)); });
      panel.appendChild(lista);
    }

    panel.appendChild(construirPieResultados(resultado.totalOcultas));
    contenedor.appendChild(panel);
  }

  function mostrarCargando(contenedor) {
    limpiarNodo(contenedor);
    var envoltorio = crear('div', {
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '40px 22px',
      background: D.panel, border: '1px solid ' + D.border, borderRadius: T.radius.sm
    });
    var rueda = crearIcono('actualizar', '18px', D.verde);
    girar(rueda);
    envoltorio.appendChild(rueda);
    envoltorio.appendChild(crear('div', { fontSize: '0.85rem', color: D.textSoft, fontWeight: '600' }, 'Cargando fallas activas…'));
    contenedor.appendChild(envoltorio);
  }

  function mostrarError(contenedor, mensaje) {
    limpiarNodo(contenedor);
    var envoltorio = crear('div', {
      padding: '22px 24px', background: ESTILO_NIVEL.ALTA.fila, border: '1px solid ' + ESTILO_NIVEL.ALTA.borde,
      borderLeft: '4px solid ' + D.rojo, borderRadius: T.radius.sm
    });
    envoltorio.appendChild(crear('div', { color: '#FF8587', fontWeight: '700', marginBottom: '4px' }, 'No se pudo cargar la información'));
    envoltorio.appendChild(crear('div', { color: D.textSoft, fontSize: '0.82rem' }, mensaje));
    contenedor.appendChild(envoltorio);
  }

  // --- Orquestacion --------------------------------------------------------
  var contenedorPrincipal = null;
  var contenedorResultados = null;
  var idIntervaloAutoRefresco = null;

  // La vista elegida (por vehículo / cronológica) se recuerda entre sesiones.
  var CLAVE_LOCALSTORAGE_VISTA = 'alertasFallas_vista';

  function cargarModoVista() {
    try {
      var guardado = localStorage.getItem(CLAVE_LOCALSTORAGE_VISTA);
      if (guardado === 'vehiculo' || guardado === 'cronologico') return guardado;
    } catch (e) { /* sin localStorage: vista por defecto */ }
    return 'vehiculo';
  }

  function guardarModoVista(valor) {
    try { localStorage.setItem(CLAVE_LOCALSTORAGE_VISTA, valor); }
    catch (e) { /* localStorage no disponible, se sigue sin persistir */ }
  }

  // --- Refresco automático que no interrumpe ------------------------------------
  var ultimaInteraccion = 0;
  var refrescoPendiente = false;
  var pausaAvisada = false;
  var cargaEnCurso = false;
  var idRevisionPausa = null;
  var EVENTOS_INTERACCION = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'scroll'];

  function registrarInteraccion() { ultimaInteraccion = Date.now(); }

  function usandoLaHoja() {
    return Date.now() - ultimaInteraccion < INACTIVIDAD_MS || expedienteEnCurso;
  }

  // Cada 5 min solo se "pide" el refresco; se ejecuta en cuanto se deja de usar la hoja (y la pestaña está a la vista).
  function pedirAutoRefresco() {
    refrescoPendiente = true;
    revisarPausa();
  }

  function revisarPausa() {
    if (!refrescoPendiente) return;
    if (document.hidden || usandoLaHoja()) {
      if (!pausaAvisada && elementos.textoActualizado && !document.hidden) {
        pausaAvisada = true;
        elementos.textoActualizado.textContent = 'Actualización en pausa mientras usas la hoja';
      }
      return;
    }
    actualizarRangoDefecto(true);
  }

  // Posición de scroll (página y tabla interna) para devolverla tras repintar sin el panel "Cargando".
  function capturarScroll() {
    var s = { ancestros: [], ventana: window.pageYOffset, tabla: 0 };
    for (var el = contenedorPrincipal; el; el = el.parentElement) {
      if (el.scrollTop > 0) s.ancestros.push([el, el.scrollTop]);
    }
    var tabla = contenedorResultados.querySelector('[data-scroll="tabla"]');
    if (tabla) s.tabla = tabla.scrollTop;
    return s;
  }

  function restaurarScroll(s) {
    s.ancestros.forEach(function (p) { p[0].scrollTop = p[1]; });
    window.scrollTo(window.pageXOffset, s.ventana);
    var tabla = contenedorResultados.querySelector('[data-scroll="tabla"]');
    if (tabla) tabla.scrollTop = s.tabla;
  }

  // silencioso = refresco automático: sin panel "Cargando" y conservando el scroll.
  function actualizarRangoDefecto(silencioso) {
    refrescoPendiente = false;
    pausaAvisada = false;
    if (silencioso === true && cargaEnCurso) return;
    var desde = inicioDeHoy();
    var hasta = new Date();
    elementos.inputDesde.value = aFechaInputValue(desde);
    elementos.inputHasta.value = aFechaInputValue(hasta);
    elementos.actualizarTextoRango();
    guardarRango(elementos.inputDesde.value, elementos.inputHasta.value);
    // true = conservar el filtro de vehiculo -- refresco automatico, boton
    // "Actualizar" y focus() vuelven a lo mismo que se estaba mirando (mismo
    // criterio ya corregido en sobreRevolucionPTO.js).
    cargarYRenderizar(desde, hasta, true, silencioso === true);
  }

  function cargarYRenderizar(desde, hasta, conservarFiltroVehiculo, silencioso) {
    cargaEnCurso = true;
    if (!silencioso) mostrarCargando(contenedorResultados);
    if (barraFiltrosRefs) barraFiltrosRefs.marcarCargando(true);
    if (!conservarFiltroVehiculo) {
      filtroEstado.vehiculo = null;
      if (barraFiltrosRefs) barraFiltrosRefs.ocultarChipVehiculo();
    }

    obtenerFallasActivas(desde, hasta)
      .then(agregarInfoVehiculo)
      .then(agregarClasificacion)
      .then(agregarConfirmacion)
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

        var scroll = silencioso ? capturarScroll() : null;
        renderizarResultados(contenedorResultados, resultadoCache);
        ajustarAlturaRaiz();
        if (scroll) restaurarScroll(scroll);
        cargaEnCurso = false;
        if (barraFiltrosRefs) barraFiltrosRefs.marcarCargando(false);
        if (elementos.textoActualizado) {
          elementos.textoActualizado.textContent = 'Actualizado ' +
            new Date().toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: true }) + ' · cada 5 min';
        }
      })
      .catch(function (err) {
        console.error('Alertas:', err);
        cargaEnCurso = false;
        if (barraFiltrosRefs) barraFiltrosRefs.marcarCargando(false);
        if (elementos.textoActualizado) elementos.textoActualizado.textContent = 'Sin actualizar';
        // En el refresco automático no se borra lo que se estaba mirando: se deja la lista anterior.
        if (!silencioso) mostrarError(contenedorResultados, (err && err.message) ? err.message : 'Error al consultar Geotab.');
      });
  }

  // MyGeotab deja el resto de la página en blanco: cuando el contenido es corto, el fondo oscuro tiene que llegar
  // hasta el borde inferior de la ventana. Se mide desde donde empieza el add-in (debajo de la barra superior de
  // MyGeotab) y se repite al redimensionar.
  function ajustarAlturaRaiz() {
    var raiz = document.getElementById('alertasFallasRoot');
    if (!raiz) return;
    var arriba = Math.max(0, raiz.getBoundingClientRect().top);
    raiz.style.minHeight = Math.max(300, window.innerHeight - arriba) + 'px';
  }

  function actualizarVista() {
    // renderizarResultados también repinta los KPI, así el filtro activo (ALTA /
    // sistema) queda resaltado tras cada cambio.
    renderizarResultados(contenedorResultados, resultadoCache);
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi;
      state = freshState;
      modoVista = cargarModoVista();

      contenedorPrincipal = document.getElementById('alertasFallasRoot');
      aplicarEstilo(contenedorPrincipal, {
        fontFamily: T.font, background: D.bg, color: D.text, colorScheme: 'dark',
        padding: '20px 24px', boxSizing: 'border-box'
      });

      construirEncabezado(contenedorPrincipal);

      elementos.bannerAlarma = crear('div', { display: 'none' });
      contenedorPrincipal.appendChild(elementos.bannerAlarma);

      elementos.kpis = construirKpis(contenedorPrincipal);

      cargarTripulacionesGuardadas();
      barraFiltrosRefs = construirBarraControl(contenedorPrincipal, actualizarVista);
      elementos.inputDesde = barraFiltrosRefs.inputDesde;
      elementos.inputHasta = barraFiltrosRefs.inputHasta;
      elementos.actualizarTextoRango = barraFiltrosRefs.actualizarTextoRango;

      contenedorResultados = crear('div');
      contenedorPrincipal.appendChild(contenedorResultados);
      ajustarAlturaRaiz();

      initializedCallback();
    },

    focus: function (freshApi, freshState) {
      api = freshApi;
      state = freshState;
      if (idIntervaloAutoRefresco) clearInterval(idIntervaloAutoRefresco);
      idIntervaloAutoRefresco = setInterval(pedirAutoRefresco, INTERVALO_AUTO_REFRESCO_MS);
      if (idRevisionPausa) clearInterval(idRevisionPausa);
      idRevisionPausa = setInterval(revisarPausa, REVISION_PAUSA_MS);
      EVENTOS_INTERACCION.forEach(function (ev) { document.addEventListener(ev, registrarInteraccion, { capture: true, passive: true }); });
      window.addEventListener('resize', ajustarAlturaRaiz);
      ajustarAlturaRaiz();
      actualizarRangoDefecto();
    },

    blur: function () {
      window.removeEventListener('resize', ajustarAlturaRaiz);
      EVENTOS_INTERACCION.forEach(function (ev) { document.removeEventListener(ev, registrarInteraccion, true); });
      if (idRevisionPausa) { clearInterval(idRevisionPausa); idRevisionPausa = null; }
      refrescoPendiente = false;
      if (idIntervaloAutoRefresco) { clearInterval(idIntervaloAutoRefresco); idIntervaloAutoRefresco = null; }
      detenerRepeticionAlarma();
    }
  };
};
