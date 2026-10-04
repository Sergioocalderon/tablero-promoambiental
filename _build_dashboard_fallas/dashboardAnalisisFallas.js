/* ============================================================================
   Add-In: Dashboard de Análisis de Fallas

   Objetivo: identificar vehículos/códigos con reincidencia anómala de fallas
   para sustentar reclamaciones de garantía ante el distribuidor -- no es una
   vista de "qué está fallando ahora mismo" (para eso ya existe el add-in
   "Alertas por Severidad"), sino un análisis cuantitativo sobre un rango de
   fechas elegido por el usuario, sin ventana oculta de respaldo.

   Reutiliza verbatim varios bloques ya validados en alertasFallas.js/
   sobreRevolucionPTO.js (tema visual, apiCall/apiMultiCall, resolución de
   ciudad/marca por jerarquía de grupos, catálogos Diagnostic/FailureMode) --
   mismo patrón de duplicación intencional ya documentado en CLAUDE.md.

   Conteo de "episodios" (NO de registros crudos de FaultData): Geotab
   re-registra un FaultData con faultState='Active' repetidamente mientras el
   código sigue activo (no una sola vez por evento), así que contar filas
   crudas sobrestima muchísimo la recurrencia real. Un "episodio" es una
   transición hacia faultState='Active' desde un estado que NO era activo
   (o el primer registro del grupo) -- mismo criterio de fondo que ya evitó el
   sobre-conteo del PTO (ver VENTANA_PTO_MINUTOS en telegram_alertas.py):
   cualquier análisis de fallas que no distinga esto sobrestima con fuerza.
   ============================================================================ */

geotab.addin.dashboardAnalisisFallas = function () {
  'use strict';

  // --- Constantes --------------------------------------------------------
  var CLAVE_LOCALSTORAGE = 'dashboardAnalisisFallas_rango';
  var DIAS_RANGO_POR_DEFECTO = 30;
  // Mismo tope real de FaultData por llamada que ya se documentó y corrigió en
  // telegram_alertas.py / alertasFallas.js -- sin paginar se pierden en
  // silencio los registros más recientes de un rango grande.
  var LIMITE_PAGINA_FAULTDATA = 50000;
  var TOP_N = 5;
  // CAMBIO (pedido 2026-09-17): 10 min, no 5 como en "Alertas por Severidad"
  // -- acá se analiza un patrón de reincidencia sobre 30+ días, que no
  // cambia de forma relevante minuto a minuto, y la consulta de FaultData es
  // más pesada que "activas ahora". 10 min alcanza para una pantalla dejada
  // abierta y no satura la API (antes 15 min, bajado a pedido del usuario).
  var INTERVALO_AUTO_REFRESCO_MS = 10 * 60 * 1000;

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

  // --- Sistema de diseño: paleta con roles, no colores sueltos -----------
  // CAMBIO: paleta de marca real de Promoambiental (hex exactos entregados
  // por el usuario 2026-09-12) -- primary/primaryDark/primarySoft son el
  // verde corporativo #73B828 y sus derivados (más oscuro/más claro,
  // calculados con la misma proporción que ya tenían las versiones
  // anteriores, porque el usuario solo dio el tono base). alertaTexto/
  // alertaFondo se alinean con el mismo rojo vino que "Crítico" (ver
  // CRITICIDAD más abajo) para que el rojo del dashboard sea uno solo.
  var T = {
    color: {
      primary: '#73B828',
      primaryDark: '#59901D',
      primarySoft: '#EAF4DF',
      ink: '#1A2235',
      body: '#475569',
      muted: '#88929A',
      surface: '#FFFFFF',
      canvas: '#F4F5F8',
      border: '#E5E9F0',
      borderStrong: '#CBD5E1',
      danger: '#B91C1C',
      dangerSoft: '#FEF2F2',
      dangerBorder: '#FCA5A5',
      textoOscuro: '#1F2937',
      textoGris: '#6B7280',
      alertaFondo: '#F7E8E8',
      alertaTexto: '#BA3B3B',
      medioFondo: '#FFFBEB',
      medioTexto: '#B45309'
    },
    radius: { sm: '8px', md: '12px', lg: '16px', pill: '999px' },
    shadow: { card: '0 1px 2px rgba(15,23,42,0.04), 0 1px 10px rgba(15,23,42,0.05)' },
    font: "'Inter', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
  };

  // --- Clasificación de criticidad por vehículo (CENTRALIZADA) --------------
  // Colores con intención psicológica pedida por el usuario -- deliberadamente
  // distintos de la paleta T.color general, para que esta escala de 4 niveles
  // se reconozca de un vistazo en cualquier gráfico/leyenda/filtro que la use.
  var CRITICIDAD = {
    // CAMBIO: tonos "armonizados" de marca (rojo vino / naranja tierra /
    // mostaza) entregados por el usuario 2026-09-12, en vez de rojo/naranja/
    // amarillo puros -- mismo semáforo, menos estridente junto al verde/azul.
    CRITICO: { nivel: 'Crítico', color: '#BA3B3B', orden: 4 },
    ALTO: { nivel: 'Alto', color: '#D97736', orden: 3 },
    MEDIO: { nivel: 'Medio', color: '#E5A93B', orden: 2 },
    // CAMBIO: "Bajo" usa el mismo verde corporativo (T.color.primary) que ya
    // usan botones y acentos en los 3 add-ins -- antes tenía un verde propio
    // (#28a745) ligeramente distinto, que no calzaba con la marca.
    BAJO: { nivel: 'Bajo', color: T.color.primary, orden: 1 }
  };
  var ORDEN_CRITICIDAD_LEYENDA = [CRITICIDAD.CRITICO, CRITICIDAD.ALTO, CRITICIDAD.MEDIO, CRITICIDAD.BAJO];

  // Taxonomía de SISTEMAS PRINCIPALES por el NOMBRE del diagnóstico de
  // Geotab -- mismo patrón de clasificación por palabras clave que ya usa
  // alertasFallas.js (categorizarFalla). Antes esto solo existía como una
  // lista de 4 sistemas "críticos" (booleano); CAMBIO (2026-09-18, sección
  // "Fallas por sistema" del dashboard): se generaliza a una taxonomía
  // completa (Motor/Frenos/Dirección/Embrague/Transmisión/Eléctrico/
  // Postratamiento/Neumáticos-Eje/HVAC), con esFallaSistemaCritico ahora
  // DERIVADA de resolverSistemaPrincipal en vez de tener su propia lista de
  // palabras clave por separado -- una sola fuente de verdad, para no
  // repetir el bug real del 2026-09-15 (palabra clave nueva agregada en un
  // lado y olvidada en el otro).
  //
  // Regla de negocio (ver CLAUDE.md): "Embrague" es SIEMPRE un sistema
  // independiente, nunca se agrupa bajo "Transmisión" -- por eso son dos
  // entradas separadas en SISTEMAS, cada una con sus propias palabras clave.
  // CAMBIO (bug real 2026-09-19, reportado por el usuario): "Neumáticos/Eje"
  // no debería tener casi nada de ABS, pero los sensores de rueda ABS se
  // nombran en Geotab por EJE físico ("Sensor de rueda ABS eje 1 derecho",
  // "Sensor de rueda ABS eje 2 izquierdo") -- sin una categoría ABS propia,
  // la palabra clave 'eje' de Neumáticos los capturaba por accidente antes
  // de que ninguna otra categoría los reconociera. Se agrega 'ABS' como
  // sistema independiente, ANTES de 'Neumáticos/Eje' en el array (el match
  // es "primero que aparece gana" en resolverSistemaPrincipal), para que
  // "...ABS eje 1..." se clasifique como ABS y no como Neumáticos.
  var SISTEMAS = [
    { nombre: 'Motor', claves: ['motor', 'aceite', 'refrigerante', 'cigüeñal', 'ciguenal', 'árbol de levas', 'arbol de levas', 'inyector', 'cilindro', 'turbocompresor', 'admisión', 'admision'] },
    { nombre: 'Frenos', claves: ['freno', 'retardador'] },
    { nombre: 'ABS', claves: ['abs', 'antibloqueo', 'vdc'] },
    { nombre: 'Dirección', claves: ['dirección', 'direccion', 'volante'] },
    { nombre: 'Embrague', claves: ['embrague', 'clutch'] },
    { nombre: 'Transmisión', claves: ['transmisión', 'transmision', 'caja de cambios', 'convertidor de par'] },
    { nombre: 'Sist. Eléctrico', claves: ['batería', 'bateria', 'alternador', 'voltaje', 'tensión', 'tension', 'luz', 'lámpara', 'lampara'] },
    { nombre: 'Postratamiento', claves: ['dpf', 'scr', 'def', 'hollín', 'hollin', 'urea', 'partículas', 'particulas'] },
    { nombre: 'Neumáticos/Eje', claves: ['neumático', 'neumatico', 'llanta', 'eje', 'diferencial'] },
    { nombre: 'HVAC', claves: ['hvac', 'climatiz', 'ventilador', 'soplador', 'aire acondicionado'] }
  ];
  // Los únicos 4 sistemas que marcan un VEHÍCULO como "Crítico" por sí solos
  // (ver clasificarCriticidadVehiculo) -- el resto de SISTEMAS existe para el
  // desglose visual, no para la clasificación de criticidad.
  var SISTEMAS_CRITICOS_NOMBRES = ['Motor', 'Frenos', 'Dirección', 'Embrague'];

  // CAMBIO (bug real 2026-09-12): con "indexOf" (substring) "direccion"
  // coincidía con "Velocidad direccioNAL del vehículo" (rumbo, no el sistema
  // de dirección) y "motor" con "motor del VENTILADOR HVAC" / "motor del
  // limpiaparabrisas" (motores de accesorio, no el motor del vehículo) --
  // confirmado con datos reales de Geotab (2026-09-12) en 3 de 5 vehículos
  // del Top 5, donde eso bastaba para marcarlos como "Crítico" sin serlo.
  // Ahora: coincidencia por PALABRA COMPLETA (\b...\b, igual que
  // categorizarFalla en alertasFallas.js), y una lista de exclusión que se
  // revisa ANTES que las palabras clave -- pero SOLO bloquea los 4 sistemas
  // críticos (ver resolverSistemaPrincipal): "motor del ventilador" no debe
  // marcar el vehículo como Crítico, pero sigue debiendo aparecer en el
  // gráfico de sistemas bajo "HVAC" (coincide con la palabra "ventilador" de
  // esa categoría), no desaparecer del desglose.
  //
  // CAMBIO (2026-09-15): mismo problema se repite con "embrague" -- validado
  // contra los 632 diagnósticos reales de la cuenta que mencionan
  // embrague/clutch, la mayoría son el embrague de tracción real (cilindro,
  // actuador, discos, pedal), pero varios son embragues de ACCESORIO que no
  // deberían marcar el vehículo como crítico: embrague del ventilador (ya
  // cubierto por la exclusión "ventilador"), embrague del soplador, y
  // embrague de aire acondicionado / del compresor (electroembrague del A/C).
  var EXCLUSIONES_SISTEMA_CRITICO = [
    'ventilador', 'limpiaparabrisas', 'vidrio', 'espejo', 'asiento', 'direccional',
    'embrague del soplador', 'embrague de aire acondicionado', 'embrague del compresor'
  ];

  // Única función que decide a qué sistema principal pertenece un
  // diagnóstico -- el gráfico "Fallas por sistema", su drill-down, y
  // esFallaSistemaCritico llaman TODOS a esta función, nunca reimplementan
  // el match de palabras clave aparte.
  function resolverSistemaPrincipal(nombreDiagnostico) {
    var nombreL = (nombreDiagnostico || '').toLowerCase();
    var excluido = EXCLUSIONES_SISTEMA_CRITICO.some(function (palabra) { return nombreL.indexOf(palabra) !== -1; });
    for (var i = 0; i < SISTEMAS.length; i++) {
      var sistema = SISTEMAS[i];
      // La exclusión solo bloquea los 4 sistemas críticos -- para el resto
      // de la taxonomía (ej. HVAC) sí se permite el match, así "motor del
      // ventilador" cae en HVAC en vez de perderse del desglose.
      if (excluido && SISTEMAS_CRITICOS_NOMBRES.indexOf(sistema.nombre) !== -1) continue;
      var coincide = sistema.claves.some(function (palabra) {
        return new RegExp('\\b' + palabra + '\\b', 'i').test(nombreL);
      });
      if (coincide) return sistema.nombre;
    }
    return 'Otro / Sin clasificar';
  }

  function esFallaSistemaCritico(nombreDiagnostico) {
    return SISTEMAS_CRITICOS_NOMBRES.indexOf(resolverSistemaPrincipal(nombreDiagnostico)) !== -1;
  }

  // Única función que decide el nivel de criticidad de un vehículo -- todo lo
  // demás (gráfico de barras, leyenda, filtro, tooltip) llama a ESTA función,
  // nunca reimplementa el umbral aparte.
  //
  // NO incluye "tiempo de inactividad fuera de servicio": ese dato no existe
  // en Geotab ni en ningún otro sistema conectado a este dashboard -- inventar
  // un número ahí produciría una clasificación falsa en una herramienta que
  // se usa para sustentar reclamos reales de garantía (decisión tomada con el
  // usuario 2026-09-11). Se usan solo los dos criterios que sí son datos
  // reales: cantidad de episodios, y si alguna falla es de un sistema crítico.
  // CAMBIO (recalibración 2026-09-12): umbrales originales (1 / 2-4 / 5-9 /
  // ≥10) se definieron ANTES de arreglar el bug del debounce (ver
  // calcularEpisodiosPorGrupo) y de datos reales -- verificado contra Bogotá
  // completa (01-12 sept 2026, 26 vehículos con actividad): el piso real de
  // la flota es 3 episodios, nadie tiene 0-1, así que "Bajo" quedaba vacío
  // siempre. Nuevos umbrales calibrados a esa distribución real (Bajo 1-4 ·
  // Medio 5-8 · Alto 9-20 · Crítico ≥21 o falla de sistema crítico) --
  // ajustar aquí si la flota cambia de escala más adelante.
  function clasificarCriticidadVehiculo(datos) {
    var episodios = datos.episodios || 0;
    if (datos.tieneFallaCritica || episodios >= 21) return CRITICIDAD.CRITICO;
    if (episodios >= 9) return CRITICIDAD.ALTO;
    if (episodios >= 5) return CRITICIDAD.MEDIO;
    return CRITICIDAD.BAJO;
  }

  // CAMBIO: emoji por nivel de criticidad -- se usa como prefijo en las
  // etiquetas del eje Y del gráfico de Top 5 (en vez de segmentar la barra
  // por criticidad) y en la leyenda manual.
  var ICONO_POR_CRITICIDAD = { 'Crítico': '🔴', 'Alto': '🟠', 'Medio': '🟡', 'Bajo': '🟢' };

  var api = null;
  var state = null;
  var elementos = {};

  // --- Utilidades de estilo (CSSOM) ---------------------------------------
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

  // CAMBIO: ícono "de marca" para los KPIs -- círculo con delineado azul
  // marino + punto de acento verde corporativo, igual al lenguaje visual del
  // ícono de camión/podadora del sitio de Promoambiental, en vez del fondo
  // tintado por urgencia que usaba antes. La urgencia (rojo/verde/ámbar) la
  // sigue llevando el borde izquierdo de la tarjeta y las píldoras, no el ícono.
  function crearChipMarca(simbolo, tamano) {
    var lado = tamano || '38px';
    var contenedor = crear('div', { position: 'relative', width: lado, height: lado, minWidth: lado });
    contenedor.appendChild(crear('div', {
      width: lado, height: lado, borderRadius: '50%', background: '#FFFFFF',
      border: '2px solid ' + T.color.ink, boxSizing: 'border-box',
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1rem'
    }, simbolo));
    contenedor.appendChild(crear('div', {
      position: 'absolute', bottom: '-2px', right: '-2px', width: '11px', height: '11px',
      borderRadius: '50%', background: T.color.primary, border: '2px solid #FFFFFF', boxSizing: 'border-box'
    }));
    return contenedor;
  }

  function crearPanel(estilosExtra) {
    var base = {
      background: T.color.surface, borderRadius: T.radius.md,
      border: '1px solid ' + T.color.border, boxShadow: T.shadow.card
    };
    for (var k in estilosExtra) { base[k] = estilosExtra[k]; }
    return crear('div', base);
  }

  // --- Utilidades de fecha ------------------------------------------------
  function aFechaInputValue(d) {
    function pad(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function rangoPorDefecto() {
    var hasta = new Date();
    var desde = new Date(hasta.getTime() - DIAS_RANGO_POR_DEFECTO * 24 * 60 * 60 * 1000);
    return { desde: aFechaInputValue(desde), hasta: aFechaInputValue(hasta) };
  }

  function cargarRangoGuardado() {
    try {
      var guardado = JSON.parse(localStorage.getItem(CLAVE_LOCALSTORAGE) || 'null');
      if (guardado && guardado.desde && guardado.hasta) return guardado;
    } catch (e) { /* ignorar, se usa el rango por defecto */ }
    return rangoPorDefecto();
  }

  function guardarRango(desde, hasta) {
    try { localStorage.setItem(CLAVE_LOCALSTORAGE, JSON.stringify({ desde: desde, hasta: hasta })); }
    catch (e) { /* localStorage no disponible, se sigue sin persistir */ }
  }

  function formatearFechaHora(fecha) {
    return fecha.toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  }

  // --- Envoltorios sobre la API de Geotab (callback -> Promise) ----------
  function apiCall(metodo, params) {
    return new Promise(function (resolve, reject) { api.call(metodo, params, resolve, reject); });
  }

  function apiMultiCall(llamadas) {
    if (llamadas.length === 0) return Promise.resolve([]);
    return new Promise(function (resolve, reject) { api.multiCall(llamadas, resolve, reject); });
  }

  // --- Jerarquía de grupos de Geotab -> ciudad y marca --------------------
  // Puerto directo de obtener_mapa_grupos / resolver_marca en telegram_alertas.py,
  // mismo bloque que ya usan sobreRevolucionPTO.js y alertasFallas.js.
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
    // CAMBIO (2026-10-03, auditoría): \b\w no reconoce letras acentuadas
    // (\w es solo ASCII en JS), así que "ESTACIÓN" salía "EstacióN". Mismo
    // arreglo que ya tenía alertasFallas.js desde el 2026-10-01: capitalizar
    // separando por espacios, no por \b.
    return (nombre || '').trim().toLowerCase().split(' ').filter(function (p) { return p.length > 0; })
      .map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join(' ');
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
      console.error('Dashboard fallas: no se pudo cargar la jerarquia de grupos:', e);
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

  // --- Catálogos Diagnostic / FailureMode -> nombre + código (SPN/FMI) ---
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

  function idDeRef(ref) { return (ref && ref.id) ? ref.id : ref; }

  // --- FaultData paginado ---------------------------------------------------
  // Trae TODOS los FaultData en [desde, hasta), pidiendo página por página hasta
  // que una vuelta devuelva menos de LIMITE_PAGINA_FAULTDATA. Puerto directo de
  // _obtener_faultdata_paginado (telegram_alertas.py) / obtenerFaultDataPaginado
  // (alertasFallas.js).
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

  // CAMBIO (bug real 2026-09-12): algunos diagnósticos (velocidad de rueda,
  // sensores ABS, ciertos códigos "Unknown Diagnostic") no son un evento
  // discreto de falla -- son más bien una medición que fluctúa Activo/
  // Inactivo constantemente en la operación normal (mismo fenómeno ya
  // documentado con el PTO en telegram_alertas.py: "pulsa cada ~1s, cualquier
  // análisis que no lo filtre sobrestima con fuerza"). Confirmado con datos
  // reales: un solo vehículo llegó a 24,641 "episodios" en 30 días, con un
  // único diagnóstico aportando 2,681 -- eso vuelve inútil cualquier umbral
  // de criticidad por cantidad de episodios (todo el mundo termina "Crítico").
  // DEBOUNCE_REACTIVACION_MIN: si el código se reactiva a los pocos minutos
  // de haberse apagado, se trata como el MISMO episodio en curso (parpadeo),
  // no como uno nuevo -- solo cuenta episodio nuevo si pasó un rato real sin
  // el código activo. No elimina el diagnóstico ni lo oculta: solo evita
  // contar cada parpadeo individual como una recurrencia distinta.
  var DEBOUNCE_REACTIVACION_MIN = 10;

  // --- Conteo por episodios (ver comentario de cabecera del archivo) -----
  // Agrupa por (vehículo, diagnóstico, modo de falla), ordena cronológicamente
  // y cuenta transiciones hacia faultState==='Active' -- eso es un "episodio",
  // con el debounce de arriba aplicado. También calcula si el grupo sigue
  // activo al final del rango consultado.
  function calcularEpisodiosPorGrupo(registros) {
    var porGrupo = {};
    (registros || []).forEach(function (r) {
      if (!r.device || !r.dateTime || !r.diagnostic) return;
      var clave = idDeRef(r.device) + '|' + idDeRef(r.diagnostic) + '|' + idDeRef(r.failureMode);
      if (!porGrupo[clave]) porGrupo[clave] = [];
      porGrupo[clave].push(r);
    });

    var grupos = [];
    Object.keys(porGrupo).forEach(function (clave) {
      var registrosGrupo = porGrupo[clave].slice().sort(function (a, b) {
        return new Date(a.dateTime) - new Date(b.dateTime);
      });

      var episodios = 0;
      var fechasEpisodios = [];
      var activoAnterior = false;
      var finUltimaActivacion = null; // fecha en que el grupo se vio Activo por última vez antes de apagarse
      registrosGrupo.forEach(function (r) {
        var fecha = new Date(r.dateTime);
        var activo = r.faultState === 'Active' && r.dismiss !== true;
        if (activo) {
          if (!activoAnterior) {
            var msDesdeUltimaActivacion = finUltimaActivacion ? (fecha - finUltimaActivacion) : Infinity;
            var esParpadeo = msDesdeUltimaActivacion <= DEBOUNCE_REACTIVACION_MIN * 60 * 1000;
            if (!esParpadeo) { episodios++; fechasEpisodios.push(fecha); }
          }
        } else if (activoAnterior) {
          finUltimaActivacion = fecha; // se acaba de apagar -- referencia para el debounce
        }
        activoAnterior = activo;
      });

      // CAMBIO (bug real 2026-09-12): un grupo puede tener episodios===0 si
      // TODOS sus registros dentro del rango consultado son "no activos" --
      // pasa cuando la falla ya estaba activa ANTES de "Desde" y el rango
      // solo alcanza a capturar su resolución (un registro "Inactivo" suelto,
      // sin ningún "Activo" adelante). Antes ese grupo igual se agregaba a
      // vehiculosOrdenados (sumando 1 a "códigos distintos" y a "vehículos
      // afectados") y a contarActivasInactivas (sumando 1 a "resueltas"), pero
      // aportaba 0 al total de episodios -- eso producía KPIs inconsistentes
      // entre sí (ej. "0 episodios" pero "4 vehículos afectados" al filtrar
      // por criticidad Baja). Se excluye aquí, en el origen, para que TODOS
      // los KPIs deriven siempre del mismo universo de grupos.
      if (episodios === 0) return;

      var partes = clave.split('|');
      var ultimo = registrosGrupo[registrosGrupo.length - 1];
      grupos.push({
        idVehiculo: partes[0],
        idDiagnostico: partes[1],
        idFailureMode: partes[2] === 'undefined' ? null : partes[2],
        episodios: episodios,
        fechasEpisodios: fechasEpisodios,
        primeraFecha: new Date(registrosGrupo[0].dateTime),
        ultimaFecha: new Date(ultimo.dateTime),
        activaAlFinal: ultimo.faultState === 'Active' && ultimo.dismiss !== true
      });
    });
    return grupos;
  }

  // --- Serie temporal: episodios por día (o por semana si el rango es largo) ---
  // Agrupa las fechas de INICIO de cada episodio (no todo el rango que estuvo
  // activo) en baldes de tiempo, rellenando con 0 los baldes sin datos para que
  // la línea de tendencia no salte huecos -- así los picos de anomalías se ven
  // en su posición real dentro del rango, no comprimidos.
  //
  // CAMBIO (2026-09-19, cross-filter en la Tendencia): resolverPorSemana/
  // resolverClaveBalde/etiquetaClaveBalde se sacan a nivel de módulo (antes
  // vivían solo dentro de construirSerieTemporal) para que grupoPasaClave
  // pueda usar EXACTAMENTE el mismo criterio de "a qué balde de fecha
  // pertenece este episodio" al filtrar por CF.dia -- una sola fuente de
  // verdad, igual que resolverSistemaPrincipal para el drill-down de sistema.
  function resolverPorSemana(desde, hasta) {
    var diasRango = Math.max(1, Math.round((hasta - desde) / (24 * 60 * 60 * 1000)));
    return diasRango > 60;
  }

  function resolverClaveBalde(fecha, porSemana) {
    if (!porSemana) {
      return fecha.getFullYear() + '-' + String(fecha.getMonth() + 1).padStart(2, '0') + '-' + String(fecha.getDate()).padStart(2, '0');
    }
    var inicioSemana = new Date(fecha);
    inicioSemana.setDate(fecha.getDate() - fecha.getDay());
    return inicioSemana.getFullYear() + '-' + String(inicioSemana.getMonth() + 1).padStart(2, '0') + '-' + String(inicioSemana.getDate()).padStart(2, '0');
  }

  // CAMBIO: agrega el nombre del día de la semana (ej. "lun 12 sept") en la
  // vista diaria -- antes solo mostraba "12 sept", sin decir qué día de la
  // semana era, que es justo lo útil para notar patrones (ej. "siempre
  // pasa los lunes"). En la vista semanal no aplica un solo día, así que
  // se deja como "semana del 12 sept".
  function etiquetaClaveBalde(clave, porSemana) {
    var partes = clave.split('-');
    var fechaBalde = new Date(Number(partes[0]), Number(partes[1]) - 1, Number(partes[2]));
    if (porSemana) {
      return 'Semana del ' + fechaBalde.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
    }
    return fechaBalde.toLocaleDateString('es-CO', { weekday: 'short', day: '2-digit', month: 'short' });
  }

  function construirSerieTemporal(grupos, desde, hasta) {
    var porSemana = resolverPorSemana(desde, hasta);

    var conteos = {};
    grupos.forEach(function (g) {
      g.fechasEpisodios.forEach(function (f) { var k = resolverClaveBalde(f, porSemana); conteos[k] = (conteos[k] || 0) + 1; });
    });

    var baldes = [];
    var cursor = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate());
    if (porSemana) cursor.setDate(cursor.getDate() - cursor.getDay());
    var pasoDias = porSemana ? 7 : 1;
    while (cursor <= hasta) {
      var k = resolverClaveBalde(cursor, porSemana);
      baldes.push({ clave: k, etiqueta: etiquetaClaveBalde(k, porSemana), valor: conteos[k] || 0 });
      cursor = new Date(cursor.getTime() + pasoDias * 24 * 60 * 60 * 1000);
    }

    return {
      etiquetas: baldes.map(function (b) { return b.etiqueta; }),
      valores: baldes.map(function (b) { return b.valor; }),
      claves: baldes.map(function (b) { return b.clave; }), // CAMBIO: insumo del clic-para-filtrar (CF.dia)
      porSemana: porSemana
    };
  }

  // --- Enriquecimiento: nombre/placa/ciudad/marca por vehículo -----------
  function obtenerInfoVehiculos(idsVehiculo) {
    if (idsVehiculo.length === 0) return Promise.resolve({});
    var llamadas = idsVehiculo.map(function (idVeh) {
      return ['Get', { typeName: 'Device', search: { id: idVeh } }];
    });
    return Promise.all([apiMultiCall(llamadas), obtenerMapaGrupos()]).then(function (resultados) {
      var respuestasDevice = resultados[0];
      var mapaGrupos = resultados[1];
      var info = {};
      idsVehiculo.forEach(function (idVeh, i) {
        var dev = (respuestasDevice[i] || [])[0];
        var mt = resolverMarcaYTipologia(dev ? dev.groups : null, mapaGrupos);
        info[idVeh] = {
          nombre: dev ? (dev.name || idVeh) : idVeh,
          placa: dev ? (dev.licensePlate || '') : '',
          marca: mt.marca,
          ciudad: mt.ciudad,
          tipologia: mt.tipologia,
          referenciaMotor: referenciaMotorDeMarca(mt.marca)
        };
        info[idVeh].claveVehiculo = info[idVeh].nombre + (info[idVeh].placa ? ' - ' + info[idVeh].placa : '');
      });
      return info;
    });
  }

  // --- Agregaciones: top vehículos / top códigos / activas vs inactivas --
  // CAMBIO: agregarPorVehiculo ahora recibe también 'catalogos', necesario
  // para resolver el NOMBRE de cada diagnóstico y saber si pertenece a un
  // sistema crítico (motor/frenos/dirección) -- insumo de clasificarCriticidadVehiculo.
  function agregarPorVehiculo(grupos, infoVehiculos, catalogos) {
    var porVehiculo = {};
    grupos.forEach(function (g) {
      if (!porVehiculo[g.idVehiculo]) {
        porVehiculo[g.idVehiculo] = { idVehiculo: g.idVehiculo, episodios: 0, codigosDistintos: 0, ultimaFecha: g.ultimaFecha, tieneFallaCritica: false };
      }
      var acc = porVehiculo[g.idVehiculo];
      acc.episodios += g.episodios;
      acc.codigosDistintos += 1;
      if (g.ultimaFecha > acc.ultimaFecha) acc.ultimaFecha = g.ultimaFecha;
      // CAMBIO: marca el vehículo si ALGUNA de sus fallas es de un sistema
      // crítico -- basta una sola para que el vehículo entero se clasifique
      // como Crítico, sin importar cuántos episodios tenga en total.
      var diagInfo = catalogos.dicDiag[g.idDiagnostico];
      if (diagInfo && esFallaSistemaCritico(diagInfo.nombre)) acc.tieneFallaCritica = true;
    });

    var lista = Object.keys(porVehiculo).map(function (idVeh) {
      var acc = porVehiculo[idVeh];
      var info = infoVehiculos[idVeh] || { claveVehiculo: idVeh, ciudad: 'Sin ciudad asignada', tipologia: 'Sin tipología asignada', marca: 'Sin marca', referenciaMotor: 'Desconocido' };
      // CAMBIO: clasificación de criticidad centralizada (ver clasificarCriticidadVehiculo).
      var criticidad = clasificarCriticidadVehiculo({ episodios: acc.episodios, tieneFallaCritica: acc.tieneFallaCritica });
      return {
        idVehiculo: idVeh,
        claveVehiculo: info.claveVehiculo,
        ciudad: info.ciudad,
        tipologia: info.tipologia || 'Sin tipología asignada',
        marca: info.marca,
        referenciaMotor: info.referenciaMotor,
        episodios: acc.episodios,
        codigosDistintos: acc.codigosDistintos,
        ultimaFecha: acc.ultimaFecha,
        tieneFallaCritica: acc.tieneFallaCritica,
        criticidad: criticidad.nivel,
        colorCriticidad: criticidad.color,
        ordenCriticidad: criticidad.orden
      };
    });

    // CAMBIO: orden por criticidad primero (más severo arriba), y dentro de la
    // misma criticidad, por episodios descendente -- pedido explícito.
    lista.sort(function (a, b) {
      if (b.ordenCriticidad !== a.ordenCriticidad) return b.ordenCriticidad - a.ordenCriticidad;
      return b.episodios - a.episodios;
    });
    return lista;
  }

  // CAMBIO (2026-09-19, coherencia de datos): agrupar por SPN/FMI REAL
  // cuando el diagnóstico lo tiene, no por el ID interno de Geotab
  // (idDiagnostico/idFailureMode). Geotab puede tener DOS entidades
  // `Diagnostic` distintas (IDs diferentes) para el MISMO código J1939 real
  // -- ya documentado en CLAUDE.md ("diagnóstico duplicado": uno vivo, uno
  // muerto, o simplemente dos objetos para el mismo SPN/FMI en cuentas
  // grandes con varios modelos de motor). Sin este cambio, una falla
  // idéntica reportada por dos entidades Diagnostic distintas se veía como
  // DOS filas separadas de "1 vehículo" cada una en vez de una sola fila
  // sumada -- exactamente el patrón que hizo sospechar de los datos (Top
  // vehículos con cientos de episodios, pero ningún código del Top 5
  // repetido entre más de 1 vehículo). Si el diagnóstico NO tiene código
  // real (SPN "?", "Diagnóstico desconocido"), se sigue agrupando por ID
  // interno -- fusionar todos los "?" bajo una sola clave uniría
  // diagnósticos genuinamente distintos que Geotab no logró identificar.
  function agregarPorCodigo(grupos, catalogos) {
    var porCodigo = {};
    grupos.forEach(function (g) {
      var diagInfo = catalogos.dicDiag[g.idDiagnostico] || { nombre: 'Diagnóstico desconocido', codigo: null };
      var fmInfo = catalogos.dicFm[g.idFailureMode] || { nombre: '', codigo: null };
      var tieneCodigoReal = diagInfo.codigo !== null && diagInfo.codigo !== undefined;
      var clave = tieneCodigoReal
        ? 'spn:' + diagInfo.codigo + '|' + (fmInfo.codigo !== null && fmInfo.codigo !== undefined ? fmInfo.codigo : '')
        : 'id:' + g.idDiagnostico + '|' + g.idFailureMode;
      if (!porCodigo[clave]) {
        porCodigo[clave] = {
          idDiagnostico: g.idDiagnostico,
          idFailureMode: g.idFailureMode,
          spn: diagInfo.codigo || '?',
          fmi: fmInfo.codigo || '?',
          nombreFalla: diagInfo.nombre + (fmInfo.nombre ? ' — ' + fmInfo.nombre : ''),
          episodios: 0,
          vehiculosAfectados: {},
          ultimaFecha: g.ultimaFecha
        };
      }
      var acc = porCodigo[clave];
      acc.episodios += g.episodios;
      acc.vehiculosAfectados[g.idVehiculo] = true;
      if (g.ultimaFecha > acc.ultimaFecha) acc.ultimaFecha = g.ultimaFecha;
    });

    var lista = Object.keys(porCodigo).map(function (clave) {
      var acc = porCodigo[clave];
      return {
        idDiagnostico: acc.idDiagnostico,
        idFailureMode: acc.idFailureMode,
        spn: acc.spn,
        fmi: acc.fmi,
        nombreFalla: acc.nombreFalla,
        episodios: acc.episodios,
        vehiculosAfectados: Object.keys(acc.vehiculosAfectados).length,
        ultimaFecha: acc.ultimaFecha
      };
    });

    lista.sort(function (a, b) { return b.episodios - a.episodios; });
    return lista;
  }

  // --- Agregación por sistema principal (drill-down general -> particular) ---
  // Mismo patrón que agregarPorCodigo, pero la clave de agrupación es el
  // SISTEMA (resolverSistemaPrincipal sobre el nombre del diagnóstico), no el
  // par SPN/FMI -- insumo del gráfico "Fallas por sistema".
  //
  // CAMBIO (2026-09-19, pedido explícito del usuario): se excluye "Otro /
  // Sin clasificar" del resultado -- son diagnósticos que no matchean
  // ninguna palabra clave de la taxonomía (SISTEMAS), y en la práctica son
  // la mayoría de los códigos de la cuenta (códigos propietarios sin
  // descripción estándar, mensajes de mantenimiento genéricos, etc.), no
  // fallas de un sistema real. Sin este filtro, esa barra opacaba a las que
  // sí importan (Motor, Frenos, etc.) en el gráfico y en el KPI "Sistema
  // con más episodios". Sigue contando en el total de episodios de los
  // KPIs generales (esta función no toca esos totales) -- solo desaparece
  // del desglose por sistema. Revertir quitando este `if` si más adelante
  // se decide curar la taxonomía para cubrir más diagnósticos.
  var SISTEMA_SIN_CLASIFICAR = 'Otro / Sin clasificar';

  function agregarPorSistema(grupos, catalogos) {
    var porSistema = {};
    grupos.forEach(function (g) {
      var diagInfo = catalogos.dicDiag[g.idDiagnostico];
      var sistema = resolverSistemaPrincipal(diagInfo ? diagInfo.nombre : '');
      if (sistema === SISTEMA_SIN_CLASIFICAR) return;
      if (!porSistema[sistema]) porSistema[sistema] = { sistema: sistema, episodios: 0, vehiculosAfectados: {} };
      porSistema[sistema].episodios += g.episodios;
      porSistema[sistema].vehiculosAfectados[g.idVehiculo] = true;
    });

    var lista = Object.keys(porSistema).map(function (s) {
      var acc = porSistema[s];
      return { sistema: acc.sistema, episodios: acc.episodios, vehiculosAfectados: Object.keys(acc.vehiculosAfectados).length };
    });
    lista.sort(function (a, b) { return b.episodios - a.episodios; });
    return lista;
  }

  // --- KPIs del hero de sistemas (rediseño 2026-09-19) --------------------
  // Los 3 siguientes NO incluyen "impacto en costos" ni "vehículos
  // inmovilizados" -- ninguno de los dos es un dato real disponible en
  // Geotab ni en ningún otro sistema conectado a este dashboard (mismo
  // criterio ya aplicado el 2026-09-11 para "tiempo fuera de servicio":
  // inventar un número ahí falsearía una herramienta que se usa para
  // sustentar reclamos de garantía). "Vehículos con alerta crítica activa"
  // es el KPI real más cercano a esa necesidad gerencial: cuenta vehículos
  // con una falla de sistema crítico (Motor/Frenos/Dirección/Embrague)
  // TODAVÍA activa al cierre del rango -- un dato que sí existe.

  // Sistema crítico (de los 4 de SISTEMAS_CRITICOS_NOMBRES) con más
  // episodios ACTIVOS al cierre del rango -- null si ninguno tiene activos.
  function calcularSistemaMayorCriticidadActiva(grupos, catalogos) {
    var conteos = {};
    grupos.forEach(function (g) {
      if (!g.activaAlFinal) return;
      var diagInfo = catalogos.dicDiag[g.idDiagnostico];
      var sistema = resolverSistemaPrincipal(diagInfo ? diagInfo.nombre : '');
      if (SISTEMAS_CRITICOS_NOMBRES.indexOf(sistema) === -1) return;
      conteos[sistema] = (conteos[sistema] || 0) + g.episodios;
    });
    var mejor = null, mejorN = 0;
    Object.keys(conteos).forEach(function (s) { if (conteos[s] > mejorN) { mejor = s; mejorN = conteos[s]; } });
    return mejor ? { sistema: mejor, episodiosActivos: mejorN } : null;
  }

  // Vehículos únicos con una falla de sistema crítico activa al cierre del rango.
  function calcularVehiculosAlertaCriticaActiva(grupos, catalogos) {
    var ids = {};
    grupos.forEach(function (g) {
      if (!g.activaAlFinal) return;
      var diagInfo = catalogos.dicDiag[g.idDiagnostico];
      if (diagInfo && esFallaSistemaCritico(diagInfo.nombre)) ids[g.idVehiculo] = true;
    });
    return Object.keys(ids).length;
  }

  // % de TODOS los episodios del rango (no solo los activos) que caen en
  // alguno de los 4 sistemas críticos.
  function calcularPctEpisodiosCriticos(grupos, catalogos) {
    var total = 0, criticos = 0;
    grupos.forEach(function (g) {
      total += g.episodios;
      var diagInfo = catalogos.dicDiag[g.idDiagnostico];
      if (SISTEMAS_CRITICOS_NOMBRES.indexOf(resolverSistemaPrincipal(diagInfo ? diagInfo.nombre : '')) !== -1) criticos += g.episodios;
    });
    return total > 0 ? Math.round((criticos / total) * 100) : 0;
  }

  function contarActivasInactivas(grupos) {
    var activas = 0, inactivas = 0;
    grupos.forEach(function (g) { if (g.activaAlFinal) activas++; else inactivas++; });
    return { activas: activas, inactivas: inactivas, total: grupos.length };
  }

  // CAMBIO: mismo conteo que contarActivasInactivas, pero desglosado por
  // ciudad -- pedido del usuario 2026-09-16 para el panel "Activas vs.
  // inactivas". Usa infoVehiculos (ya resuelto en cargarYRenderizar) para
  // saber la ciudad de cada grupo por su idVehiculo; si un vehículo no tiene
  // ciudad resuelta cae en 'Sin ciudad asignada' -- se muestra igual, no se
  // oculta, mismo criterio del resto del dashboard.
  function contarActivasInactivasPorCiudad(grupos, infoVehiculos) {
    var porCiudad = {};
    grupos.forEach(function (g) {
      var info = infoVehiculos[g.idVehiculo];
      var ciudad = (info && info.ciudad) || 'Sin ciudad asignada';
      if (!porCiudad[ciudad]) porCiudad[ciudad] = { ciudad: ciudad, activas: 0, inactivas: 0, total: 0 };
      if (g.activaAlFinal) porCiudad[ciudad].activas++; else porCiudad[ciudad].inactivas++;
      porCiudad[ciudad].total++;
    });
    return Object.keys(porCiudad).map(function (c) { return porCiudad[c]; })
      .sort(function (a, b) { return b.total - a.total; });
  }

  // CAMBIO: totales agregados de un periodo, sin resolver info de vehículo
  // (no hace falta nombre/ciudad para una comparación de totales) -- insumo
  // de los indicadores de tendencia en los KPIs. Solo se usa para la flota
  // completa (sin filtros de ciudad/tipo/criticidad aplicados), porque
  // comparar un total filtrado de hoy contra uno SIN filtrar de ayer sería
  // una comparación inválida -- ver aplicarFiltrosYRenderizar.
  function obtenerTotalesPeriodo(desde, hasta) {
    return obtenerFaultDataPaginado(desde, hasta).then(function (registros) {
      var grupos = calcularEpisodiosPorGrupo(registros);
      var estado = contarActivasInactivas(grupos);
      return {
        totalEpisodios: grupos.reduce(function (s, g) { return s + g.episodios; }, 0),
        vehiculosAfectados: Array.from(new Set(grupos.map(function (g) { return g.idVehiculo; }))).length,
        activas: estado.activas,
        inactivas: estado.inactivas
      };
    });
  }

  // --- Render: KPIs (compactos, con chip de ícono) --------------------------
  // CAMBIO: crearTarjetaKpi ahora acepta un nodo de tendencia opcional
  // (crearIndicadorTendencia) que se agrega debajo del subtexto.
  function crearTarjetaKpi(icono, colorIcono, valor, etiqueta, subtexto, nodoTendencia) {
    var tarjeta = crearPanel({
      padding: '12px 14px', flex: '1 1 160px', minWidth: '155px',
      display: 'flex', alignItems: 'center', gap: '10px'
    });
    tarjeta.appendChild(crearChipMarca(icono, '38px'));
    var bloque = crear('div', { minWidth: '0' });
    bloque.appendChild(crear('div', { fontSize: '1.35rem', fontWeight: '800', color: T.color.ink, lineHeight: '1.1' }, String(valor)));
    bloque.appendChild(crear('div', { fontSize: '0.7rem', color: T.color.textoGris, fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.02em' }, etiqueta));
    if (subtexto) bloque.appendChild(crear('div', {
      fontSize: '0.72rem', color: T.color.body, marginTop: '2px',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
    }, subtexto));
    if (nodoTendencia) bloque.appendChild(nodoTendencia);
    tarjeta.appendChild(bloque);
    return tarjeta;
  }

  // CAMBIO: variante donde el IDENTIFICADOR (nombre del vehículo / código de
  // falla) es el elemento tipográfico principal, y la cantidad pasa a ser una
  // píldora secundaria -- antes era al revés (número gigante, nombre chiquito
  // y truncado con "…"), que es lo opuesto de lo que el usuario necesita leer
  // primero en estas dos tarjetas puntuales.
  // CAMBIO: link "Buscar causa" -- mismo patrón de búsqueda ya usado en la
  // pestaña de fallas de app.py (SPN+FMI+causa+falla+motores+diesel), para no
  // inventar una redacción de búsqueda distinta a la que ya se validó ahí.
  function crearLinkBuscarCausa(spn, fmi) {
    var url = 'https://www.google.com/search?q=SPN+' + encodeURIComponent(spn) + '+FMI+' + encodeURIComponent(fmi) + '+causa+falla+motores+diesel';
    var link = crear('a', {
      display: 'inline-block', fontSize: '0.72rem', fontWeight: '700',
      color: T.color.primaryDark, textDecoration: 'none'
    }, '🔍 Buscar causa');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function crearTarjetaKpiDestacado(icono, colorIcono, etiqueta, identificador, cantidadTexto, nodoExtra) {
    var tarjeta = crearPanel({
      padding: '12px 14px', flex: '1 1 200px', minWidth: '190px',
      display: 'flex', alignItems: 'flex-start', gap: '10px', borderLeft: '4px solid ' + colorIcono
    });
    tarjeta.appendChild(crearChipMarca(icono, '38px'));
    var bloque = crear('div', { minWidth: '0' });
    bloque.appendChild(crear('div', { fontSize: '0.7rem', color: T.color.textoGris, fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.02em' }, etiqueta));
    bloque.appendChild(crear('div', { fontSize: '0.95rem', fontWeight: '800', color: T.color.ink, lineHeight: '1.25', marginTop: '2px' }, identificador));
    bloque.appendChild(crear('span', {
      display: 'inline-block', marginTop: '5px', marginRight: '8px', padding: '2px 9px', borderRadius: T.radius.pill,
      background: colorIcono, color: '#FFFFFF', fontSize: '0.72rem', fontWeight: '700'
    }, cantidadTexto));
    if (nodoExtra) bloque.appendChild(nodoExtra);
    tarjeta.appendChild(bloque);
    return tarjeta;
  }

  // CAMBIO: indicador de tendencia vs. el periodo inmediatamente anterior
  // (misma duración, justo antes de "Desde"). 'subeEsMalo' define la
  // semántica de color: para "episodios"/"activas", subir es rojo; para
  // "resueltas", subir es verde. Si no hay dato del periodo anterior
  // (primera carga, o la consulta del periodo previo falló) no se muestra
  // nada -- mejor omitir que mostrar una comparación a medias.
  function crearIndicadorTendencia(actual, anterior, subeEsMalo) {
    if (anterior === null || anterior === undefined) return null;
    if (actual === anterior) return crear('div', { fontSize: '0.68rem', color: T.color.muted, marginTop: '2px' }, '▬ sin cambios vs. periodo anterior');
    var subio = actual > anterior;
    var esMalo = subio ? subeEsMalo : !subeEsMalo;
    var cambioPct = anterior === 0 ? 100 : Math.round(((actual - anterior) / anterior) * 100);
    var color = esMalo ? CRITICIDAD.CRITICO.color : T.color.primaryDark;
    return crear('div', { fontSize: '0.68rem', fontWeight: '700', color: color, marginTop: '2px' },
      (subio ? '▲ ' : '▼ ') + Math.abs(cambioPct) + '% vs. periodo anterior');
  }

  // --- Render: KPIs del HERO (rediseño 2026-09-19) ------------------------
  // Primera fila de KPIs que ve el usuario -- reemplaza los genéricos
  // (episodios/vehículos/activas/inactivas, que bajan a construirKpis,
  // ahora la fila SECUNDARIA junto a Tendencia) por 4 indicadores
  // orientados a sistema/criticidad, pedido explícito del usuario para
  // que el dashboard "lidere" con la radiografía de sistemas en vez de
  // con la tendencia temporal. Los primeros 2 son clicables (saltan
  // directo al drill-down del sistema correspondiente, cfToggle).
  function construirKpisHero(contenedor, grupos, catalogos) {
    var fila = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' });

    var mayorCriticidadActiva = calcularSistemaMayorCriticidadActiva(grupos, catalogos);
    var tarjetaMayorCriticidad = crearTarjetaKpiDestacado(
      '🔴', CRITICIDAD.CRITICO.color, 'Sistema con mayor criticidad activa',
      mayorCriticidadActiva ? mayorCriticidadActiva.sistema : 'Ninguno activo',
      mayorCriticidadActiva ? mayorCriticidadActiva.episodiosActivos + ' episodio(s) activo(s)' : '0 activos'
    );
    if (mayorCriticidadActiva) {
      aplicarEstilo(tarjetaMayorCriticidad, { cursor: 'pointer' });
      tarjetaMayorCriticidad.title = 'Clic para ver el detalle de ' + mayorCriticidadActiva.sistema;
      tarjetaMayorCriticidad.addEventListener('click', function () { cfToggle('sistema', mayorCriticidadActiva.sistema); });
    }
    fila.appendChild(tarjetaMayorCriticidad);

    fila.appendChild(crearTarjetaKpi(
      '🚨', T.color.alertaTexto, calcularVehiculosAlertaCriticaActiva(grupos, catalogos),
      'Vehículos con alerta crítica activa', 'Motor, Frenos, Dirección o Embrague'
    ));

    fila.appendChild(crearTarjetaKpi(
      '📊', T.color.ink, calcularPctEpisodiosCriticos(grupos, catalogos) + '%',
      '% de episodios en sistemas críticos', 'Sobre el total del rango seleccionado'
    ));

    var sistemasOrdenados = agregarPorSistema(grupos, catalogos);
    if (sistemasOrdenados.length > 0) {
      var top = sistemasOrdenados[0];
      var tarjetaTop = crearTarjetaKpiDestacado(
        '🧩', T.color.ink, 'Sistema con más episodios en el rango', top.sistema,
        top.episodios + ' episodio(s)'
      );
      aplicarEstilo(tarjetaTop, { cursor: 'pointer' });
      tarjetaTop.title = 'Clic para ver el detalle de ' + top.sistema;
      tarjetaTop.addEventListener('click', function () { cfToggle('sistema', top.sistema); });
      fila.appendChild(tarjetaTop);
    }

    contenedor.appendChild(fila);
  }

  // CAMBIO: construirKpis ahora recibe 'periodoAnterior' (totales del rango
  // equivalente inmediatamente anterior, o null si no se pudo obtener) para
  // los indicadores de tendencia. CAMBIO (2026-09-19): pasó a ser la fila
  // SECUNDARIA de KPIs -- ver construirKpisHero, que ahora lidera.
  function construirKpis(contenedor, grupos, vehiculosOrdenados, codigosOrdenados, estadoActivas, periodoAnterior) {
    var fila = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' });

    var totalEpisodios = grupos.reduce(function (s, g) { return s + g.episodios; }, 0);

    fila.appendChild(crearTarjetaKpi(
      '📋', T.color.ink, totalEpisodios, 'Episodios de falla', 'En el rango seleccionado',
      periodoAnterior && crearIndicadorTendencia(totalEpisodios, periodoAnterior.totalEpisodios, true)
    ));
    fila.appendChild(crearTarjetaKpi(
      '🚚', T.color.ink, vehiculosOrdenados.length, 'Vehículos afectados', null,
      periodoAnterior && crearIndicadorTendencia(vehiculosOrdenados.length, periodoAnterior.vehiculosAfectados, true)
    ));
    fila.appendChild(crearTarjetaKpi(
      '🔴', T.color.alertaTexto, estadoActivas.activas, 'Activas al final del rango', null,
      periodoAnterior && crearIndicadorTendencia(estadoActivas.activas, periodoAnterior.activas, true)
    ));
    fila.appendChild(crearTarjetaKpi(
      '✅', T.color.primaryDark, estadoActivas.inactivas, 'Inactivas', null,
      periodoAnterior && crearIndicadorTendencia(estadoActivas.inactivas, periodoAnterior.inactivas, false)
    ));

    if (vehiculosOrdenados.length > 0) {
      var top = vehiculosOrdenados[0];
      fila.appendChild(crearTarjetaKpiDestacado('⚠️', T.color.alertaTexto, 'Vehículo con más fallas', top.claveVehiculo, top.episodios + ' episodio(s)'));
    }
    if (codigosOrdenados.length > 0) {
      var topCod = codigosOrdenados[0];
      fila.appendChild(crearTarjetaKpiDestacado(
        '🔁', T.color.alertaTexto, 'Código más repetido', 'SPN ' + topCod.spn + ' / FMI ' + topCod.fmi,
        topCod.episodios + ' episodio(s)', crearLinkBuscarCausa(topCod.spn, topCod.fmi)
      ));
    }

    contenedor.appendChild(fila);
  }

  // --- Render: número resaltado si es anómalo (alto respecto al resto) ---
  // CAMBIO: "data bar" -- barra de fondo proporcional al máximo de la tabla,
  // detrás del número. Se lee la magnitud relativa de un vistazo, sin tener
  // que comparar los números fila por fila.
  function crearBarraDatos(valor, maximo) {
    var porcentaje = maximo > 0 ? Math.round((valor / maximo) * 100) : 0;
    var esAlto = maximo > 0 && valor >= maximo * 0.6;
    var contenedor = crear('div', { position: 'relative', minWidth: '64px', height: '20px' });
    contenedor.appendChild(crear('div', {
      position: 'absolute', left: '0', top: '0', bottom: '0', width: porcentaje + '%',
      background: esAlto ? T.color.alertaFondo : T.color.primarySoft, borderRadius: T.radius.sm
    }));
    contenedor.appendChild(crear('span', {
      // CAMBIO: número normal en azul marino (ancla a la marca) en vez de
      // gris oscuro -- el rojo se conserva para el caso "alto" (alerta real).
      position: 'relative', display: 'inline-block', lineHeight: '20px', paddingLeft: '6px',
      fontWeight: '800', color: esAlto ? T.color.alertaTexto : T.color.ink
    }, String(valor)));
    return contenedor;
  }

  // CAMBIO: descripciones largas de falla truncadas con "…" + tooltip nativo
  // (atributo title) con el texto completo -- evita que una descripción larga
  // empuje o rompa el resto de la tabla.
  function crearTextoTruncado(texto, anchoMaximo) {
    var span = crear('span', {
      // CAMBIO: color explícito "Gris Texto" de marca -- antes heredaba el
      // gris genérico de la celda (T.color.body).
      display: 'inline-block', maxWidth: anchoMaximo || '240px', overflow: 'hidden',
      textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom', color: T.color.muted
    }, texto);
    span.title = texto;
    return span;
  }

  // --- Render: tablas secundarias (soporte, no protagonistas) --------------
  // Filas alternas + bordes sutiles + encabezado discreto -- a propósito menos
  // vistosas que los gráficos: son el respaldo detallado para quien necesite
  // el dato exacto, no lo primero que se lee.
  function construirTablaSecundaria(titulo, columnas, filas, extraerCeldas) {
    var panel = crearPanel({ padding: '14px 16px', flex: '1 1 380px', minWidth: '320px' });
    panel.appendChild(crear('div', {
      margin: '0 0 10px 0', color: T.color.body, fontSize: '0.78rem', fontWeight: '700',
      textTransform: 'uppercase', letterSpacing: '0.03em'
    }, titulo));

    if (filas.length === 0) {
      panel.appendChild(crear('div', { fontSize: '0.8rem', color: T.color.textoGris }, 'Sin fallas registradas en el rango seleccionado.'));
      return panel;
    }

    var tabla = crear('table', { width: '100%', borderCollapse: 'collapse', fontSize: '0.76rem' });
    var encabezado = crear('tr');
    columnas.forEach(function (titulo) {
      encabezado.appendChild(crear('th', {
        textAlign: 'left', padding: '5px 8px', borderBottom: '1px solid ' + T.color.border,
        color: T.color.muted, fontSize: '0.66rem', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.02em'
      }, titulo));
    });
    tabla.appendChild(encabezado);

    filas.forEach(function (item, i) {
      var fila = crear('tr', { background: i % 2 === 1 ? T.color.canvas : 'transparent' });
      extraerCeldas(item, i).forEach(function (contenidoCelda) {
        var celda = crear('td', { padding: '6px 8px', borderBottom: '1px solid ' + T.color.border, color: T.color.body });
        if (contenidoCelda instanceof Node) celda.appendChild(contenidoCelda);
        else celda.textContent = contenidoCelda;
        fila.appendChild(celda);
      });
      tabla.appendChild(fila);
    });

    panel.appendChild(tabla);
    return panel;
  }

  // CAMBIO: columna de Criticidad (pill de color) agregada a la tabla de
  // detalle -- para que coincida con el color del gráfico de barras y no
  // parezcan dos criterios distintos.
  function crearPildoraCriticidad(v) {
    return crear('span', {
      display: 'inline-block', padding: '2px 9px', borderRadius: T.radius.pill,
      background: v.colorCriticidad, color: '#FFFFFF', fontSize: '0.72rem', fontWeight: '700'
    }, v.criticidad);
  }

  function construirTablaVehiculos(vehiculosOrdenados) {
    var top = vehiculosOrdenados.slice(0, TOP_N);
    var maximo = top.length ? top[0].episodios : 0;
    return construirTablaSecundaria(
      'Detalle — Top ' + TOP_N + ' vehículos',
      ['#', 'Vehículo', 'Ciudad', 'Criticidad', 'Códigos', 'Episodios', 'Última falla'],
      top,
      function (v, i) {
        return [
          String(i + 1), v.claveVehiculo, v.ciudad, crearPildoraCriticidad(v), String(v.codigosDistintos),
          crearBarraDatos(v.episodios, maximo), formatearFechaHora(v.ultimaFecha)
        ];
      }
    );
  }

  // CAMBIO: celda SPN/FMI con el link "Buscar causa" debajo -- mismo link que
  // ya se agregó al KPI "Código más repetido", disponible ahora para
  // cualquiera de los Top 5, no solo el primero.
  function crearCeldaSpnFmiConBusqueda(c) {
    var celda = crear('div');
    celda.appendChild(crear('div', {}, c.spn + ' / ' + c.fmi));
    celda.appendChild(crearLinkBuscarCausa(c.spn, c.fmi));
    return celda;
  }

  function construirTablaCodigos(codigosOrdenados) {
    var top = codigosOrdenados.slice(0, TOP_N);
    var maximo = top.length ? top[0].episodios : 0;
    return construirTablaSecundaria(
      'Detalle — Top ' + TOP_N + ' códigos',
      ['#', 'SPN/FMI', 'Descripción', 'Vehículos', 'Episodios', 'Última falla'],
      top,
      function (c, i) {
        return [
          String(i + 1), crearCeldaSpnFmiConBusqueda(c), crearTextoTruncado(c.nombreFalla, '260px'), String(c.vehiculosAfectados),
          crearBarraDatos(c.episodios, maximo), formatearFechaHora(c.ultimaFecha)
        ];
      }
    );
  }

  // --- Render: gráfico de barras horizontales — Top vehículos --------------
  var chartBarras = null;

  // CAMBIO (refactor gerencial 2026-09-12): se quitó el apilado por
  // criticidad de falla -- 4 segmentos por barra era ruido visual y
  // dificultaba comparar volumen total entre vehículos de un vistazo. Ahora
  // es una sola barra de un solo color (verde corporativo); la criticidad
  // del VEHÍCULO (clasificarCriticidadVehiculo, ya calculada en
  // agregarPorVehiculo) se muestra como ícono al inicio de la etiqueta del
  // eje Y, no como color de la barra.
  // CAMBIO (2026-09-18, cross-filter multidimensional): ahora es clicable
  // -- clic en una barra suma/quita ese vehículo de CF.vehiculo (OR, puede
  // elegirse más de uno), mismo mecanismo que "Fallas por sistema". La
  // barra seleccionada pasa a T.color.primaryDark; el resto se atenúa.
  function construirGraficoBarras(canvas, vehiculosOrdenados) {
    var top = vehiculosOrdenados.slice(0, TOP_N);
    if (chartBarras) { chartBarras.destroy(); chartBarras = null; }
    if (top.length === 0) return false;
    var vehiculosSeleccionados = CF.vehiculo || [];

    chartBarras = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: top.map(function (v) { return (ICONO_POR_CRITICIDAD[v.criticidad] || '') + ' ' + v.claveVehiculo; }),
        datasets: [{
          label: 'Episodios de falla',
          data: top.map(function (v) { return v.episodios; }),
          backgroundColor: top.map(function (v) {
            if (!vehiculosSeleccionados.length) return T.color.primary;
            return vehiculosSeleccionados.indexOf(v.idVehiculo) !== -1 ? T.color.primaryDark : 'rgba(115,184,40,0.3)';
          }),
          borderRadius: 5,
          barThickness: 20,
          // CAMBIO: con una sola barra por vehículo, el total ES el valor
          // del dataset -- ya no hace falta sumar entre datasets como en la
          // versión apilada.
          datalabels: {
            anchor: 'end', align: 'end', clamp: true,
            color: T.color.ink, font: { weight: '700', size: 11 },
            formatter: function (valor) { return valor.toLocaleString('en-US'); }
          }
        }]
      },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        layout: { padding: { right: 34 } }, // espacio para que el datalabel no quede cortado
        onClick: function (evt, elementosClic) {
          if (!elementosClic || elementosClic.length === 0) return;
          cfToggle('vehiculo', top[elementosClic[0].index].idVehiculo);
        },
        onHover: function (evt, elementosHover) {
          if (evt.native && evt.native.target) evt.native.target.style.cursor = elementosHover.length ? 'pointer' : 'default';
        },
        plugins: {
          legend: { display: false }, // la leyenda de íconos se dibuja aparte (crearLeyendaCriticidad)
          tooltip: {
            callbacks: {
              label: function (ctx) {
                var v = top[ctx.dataIndex];
                return [v.episodios.toLocaleString('en-US') + ' episodio(s)', 'Criticidad: ' + v.criticidad, 'Clic para filtrar por este vehículo'];
              }
            }
          }
        },
        scales: {
          x: { stacked: false, beginAtZero: true, display: false }, // sin eje -- el total ya se lee en el datalabel
          y: { stacked: false, ticks: { color: T.color.textoOscuro, font: { size: 11, weight: '600' } }, grid: { display: false } }
        }
      }
    });
    return true;
  }

  // --- Render: gráfico de barras horizontales — Fallas por sistema ---------
  // CAMBIO (2026-09-18): sección nueva de drill-down general -> particular.
  // Barras horizontales (no treemap, ver propuesta técnica: en este
  // dashboard se prioriza comparar magnitudes exactas de un vistazo sobre
  // densidad visual) en T.color.ink (azul marino) -- deliberadamente NO
  // T.color.primary (verde), que ya es el color del gráfico de "Top
  // vehículos", para que ambos gráficos no se confundan entre sí. Al
  // seleccionar un sistema (clic), la barra elegida pasa a
  // T.color.primaryDark y el resto se atenúa -- mismo lenguaje de "estado
  // activo" que ya usan los botones. Nunca usa rojo/naranja/mostaza
  // (CRITICIDAD.*): esos colores quedan exclusivos de señales de criticidad
  // real, no de un conteo neutral de volumen.
  var chartSistemas = null;

  function construirGraficoSistemas(canvas, sistemasOrdenados, sistemasSeleccionados, alHacerClicSistema) {
    if (chartSistemas) { chartSistemas.destroy(); chartSistemas = null; }
    if (sistemasOrdenados.length === 0) return false;

    chartSistemas = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: sistemasOrdenados.map(function (s) { return s.sistema; }),
        datasets: [{
          label: 'Episodios de falla',
          data: sistemasOrdenados.map(function (s) { return s.episodios; }),
          // CAMBIO (2026-09-18, cross-filter): 'sistemasSeleccionados' ahora
          // es un array (CF.sistema) -- se puede tener más de un sistema
          // elegido a la vez (OR), no solo uno.
          backgroundColor: sistemasOrdenados.map(function (s) {
            if (!sistemasSeleccionados.length) return T.color.ink;
            return sistemasSeleccionados.indexOf(s.sistema) !== -1 ? T.color.primaryDark : 'rgba(26,34,53,0.25)';
          }),
          borderRadius: 5,
          barThickness: 18,
          datalabels: {
            anchor: 'end', align: 'end', clamp: true,
            color: T.color.ink, font: { weight: '700', size: 11 },
            formatter: function (valor) { return valor.toLocaleString('en-US'); }
          }
        }]
      },
      options: {
        indexAxis: 'y',
        maintainAspectRatio: false,
        layout: { padding: { right: 34 } },
        onClick: function (evt, elementosClic) {
          if (!elementosClic || elementosClic.length === 0) return;
          alHacerClicSistema(sistemasOrdenados[elementosClic[0].index].sistema);
        },
        onHover: function (evt, elementosHover) {
          if (evt.native && evt.native.target) evt.native.target.style.cursor = elementosHover.length ? 'pointer' : 'default';
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                var s = sistemasOrdenados[ctx.dataIndex];
                return [
                  s.episodios.toLocaleString('en-US') + ' episodio(s)',
                  s.vehiculosAfectados + ' vehículo(s) afectado(s)',
                  'Clic para ver el detalle SPN/FMI'
                ];
              }
            }
          }
        },
        scales: {
          x: { beginAtZero: true, display: false },
          y: { ticks: { color: T.color.textoOscuro, font: { size: 11, weight: '600' } }, grid: { display: false } }
        }
      }
    });
    return true;
  }

  var TOP_SISTEMA_DETALLE = 15;

  function construirTablaSistemaDetalle(codigosOrdenados) {
    var total = codigosOrdenados.length;
    var top = codigosOrdenados.slice(0, TOP_SISTEMA_DETALLE);
    var maximo = top.length ? top[0].episodios : 0;
    var panel = construirTablaSecundaria(
      'Códigos SPN/FMI de este sistema' + (total > TOP_SISTEMA_DETALLE ? ' (top ' + TOP_SISTEMA_DETALLE + ' de ' + total + ')' : ''),
      ['SPN/FMI', 'Descripción', 'Vehículos', 'Episodios', 'Última falla'],
      top,
      function (c) {
        return [
          crearCeldaSpnFmiConBusqueda(c), crearTextoTruncado(c.nombreFalla, '320px'), String(c.vehiculosAfectados),
          crearBarraDatos(c.episodios, maximo), formatearFechaHora(c.ultimaFecha)
        ];
      }
    );
    panel.style.flex = '1 1 100%';
    return panel;
  }

  // CAMBIO (2026-09-18, cross-filter multidimensional): el drill-down de
  // sistema ya no es una variable propia -- vive en CF.sistema (array, ver
  // sección "Cross-filter" más abajo), igual que ciudad/tipo/vehículo/
  // criticidad. gruposFiltrados acá es el universo QUE IGNORA el propio
  // filtro de sistema (para que este gráfico siga mostrando TODOS los
  // sistemas y se pueda comparar/cambiar de selección) pero SÍ respeta el
  // resto de CF -- ver gruposParaDimension en aplicarFiltrosYRenderizar.
  // CAMBIO (rediseño 2026-09-19): HERO del dashboard -- acento verde
  // corporativo arriba (única sección con esta marca, para que se lea como
  // la protagonista) + selector de vehículo PROPIO en el encabezado (además
  // del que ya está en la barra de filtros superior, pedido explícito para
  // no tener que volver arriba mientras se mira esta gráfica) + franja de
  // contexto sobre la tabla de detalle al hacer drill-down.
  function construirSeccionSistemas(contenedor, gruposFiltrados, catalogos) {
    var panel = crearPanel({ padding: '18px 20px', marginBottom: '16px', borderTop: '3px solid ' + T.color.primary });
    var sistemasSeleccionados = CF.sistema || [];

    var filaTitulo = crear('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', marginBottom: '2px' });
    filaTitulo.appendChild(crear('div', { color: T.color.ink, fontSize: '1rem', fontWeight: '800' }, '🧩 Radiografía de sistemas' + etiquetaFiltrosCf('sistema')));

    var filaControles = crear('div', { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' });
    // Selector de vehículo propio del hero -- misma fábrica que la barra de
    // filtros, escribe sobre el mismo CF.vehiculo. Se repuebla en cada
    // render con datosCache.infoVehiculos (ya cargado) y precarga el texto
    // si CF.vehiculo ya tiene un único valor activo (ej. elegido desde el
    // gráfico de Top vehículos o desde la barra de filtros).
    var selectorVehiculoHero = crearSelectorVehiculo('160px');
    selectorVehiculoHero.actualizarOpciones(datosCache.infoVehiculos);
    if (CF.vehiculo && CF.vehiculo.length === 1) {
      var infoSeleccionado = datosCache.infoVehiculos[CF.vehiculo[0]];
      if (infoSeleccionado) selectorVehiculoHero.input.value = infoSeleccionado.claveVehiculo;
    }
    filaControles.appendChild(selectorVehiculoHero.envoltorio);
    if (sistemasSeleccionados.length) {
      var botonVolver = crear('button', {
        padding: '4px 12px', background: 'transparent', color: T.color.primaryDark,
        border: '1px solid ' + T.color.primaryDark, borderRadius: T.radius.pill,
        fontSize: '0.74rem', fontWeight: '700', cursor: 'pointer'
      }, '← Ver todos los sistemas');
      botonVolver.addEventListener('click', function () { cfClearKey('sistema'); });
      filaControles.appendChild(botonVolver);
    }
    filaTitulo.appendChild(filaControles);
    panel.appendChild(filaTitulo);
    panel.appendChild(crear('div', { margin: '0 0 10px 0', color: T.color.muted, fontSize: '0.72rem' },
      'Clic en una barra para filtrar por ese sistema (se puede elegir más de uno). El resto del tablero se recalcula junto con este gráfico.'));

    var sistemasOrdenados = agregarPorSistema(gruposFiltrados, catalogos);
    var totalTodosSistemas = sistemasOrdenados.reduce(function (s, e) { return s + e.episodios; }, 0);
    var alturaGrafico = Math.max(140, sistemasOrdenados.length * 30);
    var canvas = crear('canvas', { maxHeight: alturaGrafico + 'px' });
    var envoltorio = crear('div', { position: 'relative', height: alturaGrafico + 'px' });
    envoltorio.appendChild(canvas);
    panel.appendChild(envoltorio);

    if (!construirGraficoSistemas(canvas, sistemasOrdenados, sistemasSeleccionados, function (sistema) {
      cfToggle('sistema', sistema);
    })) {
      canvas.style.display = 'none';
      envoltorio.appendChild(crearEstadoVacioGrafico('No hay fallas clasificadas por sistema' + descripcionFiltroCriticidad() + ' en el rango seleccionado.'));
    }

    if (sistemasSeleccionados.length) {
      var gruposSistema = gruposFiltrados.filter(function (g) {
        var diagInfo = catalogos.dicDiag[g.idDiagnostico];
        return sistemasSeleccionados.indexOf(resolverSistemaPrincipal(diagInfo ? diagInfo.nombre : '')) !== -1;
      });
      var codigosSistema = agregarPorCodigo(gruposSistema, catalogos);
      panel.appendChild(crear('div', { borderTop: '1px solid ' + T.color.border, margin: '14px 0' }));
      panel.appendChild(crear('div', { margin: '0 0 8px 0', color: T.color.ink, fontSize: '0.8rem', fontWeight: '800' }, 'Detalle — ' + sistemasSeleccionados.join(', ')));

      // CAMBIO (rediseño 2026-09-19): franja de contexto -- episodios/
      // vehículos/participación del sistema elegido, para no tener que
      // volver a mirar los KPIs de arriba mientras se está en el drill-down.
      var episodiosSeleccionados = gruposSistema.reduce(function (s, g) { return s + g.episodios; }, 0);
      var vehiculosSeleccionados = Array.from(new Set(gruposSistema.map(function (g) { return g.idVehiculo; }))).length;
      var pctSeleccionado = totalTodosSistemas > 0 ? Math.round((episodiosSeleccionados / totalTodosSistemas) * 100) : 0;
      panel.appendChild(crear('div', {
        margin: '0 0 12px 0', color: T.color.body, fontSize: '0.76rem', fontWeight: '600'
      }, episodiosSeleccionados.toLocaleString('en-US') + ' episodio(s) · ' + vehiculosSeleccionados + ' vehículo(s) · ' + pctSeleccionado + '% del total de fallas por sistema'));

      panel.appendChild(construirTablaSistemaDetalle(codigosSistema));
    }

    contenedor.appendChild(panel);
  }

  // CAMBIO: leyenda con el mismo ícono que ahora prefija cada vehículo en el
  // eje Y (antes eran puntos de color, cuando la criticidad vivía en la
  // barra apilada) -- mismo orden que ORDEN_CRITICIDAD_LEYENDA (más severo primero).
  function crearLeyendaCriticidad() {
    var fila = crear('div', { display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '8px', alignItems: 'center' });
    ORDEN_CRITICIDAD_LEYENDA.forEach(function (nivel) {
      var item = crear('div', { display: 'flex', alignItems: 'center', gap: '5px' });
      item.appendChild(crear('span', { fontSize: '0.8rem' }, ICONO_POR_CRITICIDAD[nivel.nivel] || ''));
      item.appendChild(crear('span', { fontSize: '0.74rem', color: T.color.ink, fontWeight: '600' }, nivel.nivel));
      fila.appendChild(item);
    });
    fila.appendChild(crearAyudaCriticidad());
    return fila;
  }

  // --- Ayuda de criticidad: ícono ⓘ + tooltip clicable (rediseño 2026-09-19) ---
  // Componente único reutilizado en cada lugar donde aparece la palabra
  // "Criticidad" (leyenda del gráfico, barra de filtros) -- explica los 4
  // umbrales reales de clasificarCriticidadVehiculo sin ensuciar la
  // interfaz con texto suelto. Clic (no hover) para que funcione igual en
  // pantallas táctiles; un solo tooltip abierto a la vez
  // (referenciaAyudaCriticidadAbierta) y se cierra al hacer clic afuera.
  var referenciaAyudaCriticidadAbierta = null;

  function crearAyudaCriticidad() {
    var contenedor = crear('span', { position: 'relative', display: 'inline-flex', verticalAlign: 'middle' });
    var boton = crear('button', {
      width: '15px', height: '15px', borderRadius: '50%', border: '1px solid ' + T.color.borderStrong,
      background: T.color.surface, color: T.color.muted, fontSize: '10px', fontWeight: '800',
      lineHeight: '13px', padding: '0', cursor: 'pointer', display: 'inline-flex',
      alignItems: 'center', justifyContent: 'center', flex: 'none'
    }, 'i');
    boton.type = 'button';
    boton.setAttribute('aria-label', 'Cómo se mide la criticidad');

    var panel = crear('div', {
      display: 'none', position: 'absolute', zIndex: '30', top: '20px', left: '0',
      background: T.color.ink, color: '#FFFFFF', borderRadius: T.radius.sm, padding: '10px 12px',
      fontSize: '0.72rem', lineHeight: '1.7', width: '230px', fontWeight: '600',
      boxShadow: '0 6px 20px rgba(15,23,42,0.28)'
    });
    panel.innerHTML =
      '🔴 <b>Crítico</b>: ≥21 episodios, o cualquier falla de Motor/Frenos/Dirección/Embrague<br>' +
      '🟠 <b>Alto</b>: 9–20 episodios<br>' +
      '🟡 <b>Medio</b>: 5–8 episodios<br>' +
      '🟢 <b>Bajo</b>: 1–4 episodios';

    boton.addEventListener('click', function (evt) {
      evt.stopPropagation();
      var abrir = panel.style.display !== 'block';
      if (referenciaAyudaCriticidadAbierta && referenciaAyudaCriticidadAbierta !== panel) referenciaAyudaCriticidadAbierta.style.display = 'none';
      panel.style.display = abrir ? 'block' : 'none';
      referenciaAyudaCriticidadAbierta = abrir ? panel : null;
    });

    contenedor.appendChild(boton);
    contenedor.appendChild(panel);
    return contenedor;
  }

  // CAMBIO: estado vacío amigable para un gráfico sin datos -- reemplaza la
  // línea/barra/dona plana en cero (visualmente confusa) por un mensaje
  // centrado. Se posiciona absoluto dentro del mismo envoltorio 'relative'
  // que ya usa cada gráfico, así que ocupa el mismo espacio sin alterar el
  // layout del panel.
  function crearEstadoVacioGrafico(mensaje) {
    var caja = crear('div', {
      position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 20px'
    });
    caja.appendChild(crear('div', { color: T.color.muted, fontSize: '0.82rem', textAlign: 'center', maxWidth: '340px' }, mensaje));
    return caja;
  }

  // CAMBIO: menciona la criticidad activa en el mensaje de estado vacío
  // cuando el usuario filtró por una sola (ej. "con criticidad Baja") -- si
  // no hay filtro de criticidad activo, o hay varias seleccionadas, el
  // mensaje queda genérico.
  function descripcionFiltroCriticidad() {
    var activas = CF.criticidad || [];
    return activas.length === 1 ? ' con criticidad ' + activas[0] : '';
  }

  // --- Render: barra de progreso — Activas vs Resueltas ---------------------
  // CAMBIO (refactor gerencial 2026-09-12): se reemplazó la dona de Chart.js
  // por una barra de progreso HTML/CSS nativa (sin canvas) -- una dona ocupa
  // bastante espacio en pantalla para comunicar solo 2 números; una barra
  // horizontal dice lo mismo en una fracción de la altura, y el % de
  // resolución se lee como titular en vez de texto superpuesto a un gráfico.
  // Recibe el CONTENEDOR (no un canvas) y construye/inyecta todo directo ahí.
  // CAMBIO: fila compacta con el nombre de la ciudad + su propia mini-barra
  // -- mismo lenguaje visual que la barra principal, a menor escala, para
  // que se lea como parte del mismo componente y no como una tabla aparte.
  // CAMBIO (2026-09-19, cross-filter): fila clicable -- reusa la dimensión
  // 'ciudad' que ya existe (mismo CF que el dropdown de encabezado), una
  // entrada alternativa más al mismo filtro. Se atenúa si hay otras
  // ciudades activas en CF.ciudad y esta no es una de ellas.
  function crearFilaCiudad(item) {
    var pct = item.total > 0 ? Math.round((item.inactivas / item.total) * 100) : 0;
    var ciudadesActivas = CF.ciudad || [];
    var elegida = ciudadesActivas.indexOf(item.ciudad) !== -1;
    var fila = crear('div', {
      display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', borderRadius: T.radius.sm,
      padding: '2px 4px', margin: '-2px -4px',
      opacity: (ciudadesActivas.length && !elegida) ? '0.4' : '1',
      outline: elegida ? '2px solid ' + T.color.primary : 'none'
    });
    fila.title = 'Clic para filtrar por ' + item.ciudad;
    fila.addEventListener('click', function () { cfToggle('ciudad', item.ciudad); });
    fila.appendChild(crear('span', {
      fontSize: '0.74rem', color: T.color.body, fontWeight: '600', minWidth: '78px',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
    }, item.ciudad));
    var mini = crear('div', {
      flex: '1', display: 'flex', height: '8px', borderRadius: T.radius.pill,
      overflow: 'hidden', background: T.color.border
    });
    mini.appendChild(crear('div', { flexBasis: pct + '%', background: T.color.primary }));
    mini.appendChild(crear('div', { flexBasis: (100 - pct) + '%', background: T.color.muted }));
    fila.appendChild(mini);
    fila.appendChild(crear('span', {
      fontSize: '0.72rem', color: T.color.textoGris, fontWeight: '700', minWidth: '58px', textAlign: 'right'
    }, item.activas + ' act. / ' + item.inactivas + ' inact.'));
    return fila;
  }

  function construirBarraResueltas(contenedor, estadoActivas, porCiudad) {
    while (contenedor.firstChild) contenedor.removeChild(contenedor.firstChild);
    // CAMBIO (bug real 2026-09-12): crearEstadoVacioGrafico se posiciona
    // 'absolute, top/left/right/bottom:0' esperando un ancestro
    // 'position:relative' que lo acote a SU panel (así lo usan tendencia y
    // barras) -- acá faltaba, así que sin ningún ancestro posicionado el
    // mensaje se estiraba contra el contenedor posicionado más cercano en
    // TODA la página, tapando el dashboard completo (pantalla en blanco) en
    // cualquier filtro que dejara "Activas vs. Resueltas" en cero.
    aplicarEstilo(contenedor, { position: 'relative', minHeight: '90px' });

    if (estadoActivas.total === 0) {
      contenedor.appendChild(crearEstadoVacioGrafico('Sin fallas' + descripcionFiltroCriticidad() + ' para mostrar.'));
      return;
    }

    var tasaResolucion = Math.round((estadoActivas.inactivas / estadoActivas.total) * 100);
    var pctActivas = 100 - tasaResolucion;

    var titular = crear('div', { display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '12px' });
    titular.appendChild(crear('span', { fontSize: '2rem', fontWeight: '800', color: T.color.ink, lineHeight: '1' }, tasaResolucion + '%'));
    titular.appendChild(crear('span', { fontSize: '0.78rem', color: T.color.textoGris, fontWeight: '700', textTransform: 'uppercase' }, 'Inactivas'));
    contenedor.appendChild(titular);

    // CAMBIO (2026-09-19, cross-filter): barra clicable -- cada segmento
    // suma/quita su estado ('Inactiva'/'Activa') de CF.estado. El segmento
    // NO elegido se atenúa (mismo lenguaje que el resto de gráficos), pero
    // sin filtro activo ambos se ven a full color.
    var estadosActivos = CF.estado || [];
    var opacidadInactivas = (estadosActivos.length && estadosActivos.indexOf('Inactiva') === -1) ? '0.35' : '1';
    var opacidadActivas = (estadosActivos.length && estadosActivos.indexOf('Activa') === -1) ? '0.35' : '1';

    var barra = crear('div', {
      display: 'flex', width: '100%', height: '16px', borderRadius: T.radius.pill,
      overflow: 'hidden', background: T.color.border
    });
    var segInactivas = crear('div', { flexBasis: tasaResolucion + '%', background: T.color.primary, opacity: opacidadInactivas, cursor: 'pointer' });
    segInactivas.title = 'Clic para filtrar por Inactivas';
    segInactivas.addEventListener('click', function () { cfToggle('estado', 'Inactiva'); });
    var segActivas = crear('div', { flexBasis: pctActivas + '%', background: T.color.muted, opacity: opacidadActivas, cursor: 'pointer' });
    segActivas.title = 'Clic para filtrar por Activas';
    segActivas.addEventListener('click', function () { cfToggle('estado', 'Activa'); });
    barra.appendChild(segInactivas);
    barra.appendChild(segActivas);
    contenedor.appendChild(barra);

    // Conteos reales debajo -- el % no dice CUÁNTAS son, esto sí. También
    // clicables (mismo filtro que la barra, más superficie para hacer clic).
    var filaConteos = crear('div', { display: 'flex', justifyContent: 'space-between', marginTop: '10px' });
    var itemResueltas = crear('div', { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', opacity: opacidadInactivas });
    itemResueltas.title = 'Clic para filtrar por Inactivas';
    itemResueltas.addEventListener('click', function () { cfToggle('estado', 'Inactiva'); });
    itemResueltas.appendChild(crear('span', { width: '9px', height: '9px', borderRadius: '50%', background: T.color.primary, display: 'inline-block' }));
    itemResueltas.appendChild(crear('span', { fontSize: '0.76rem', color: T.color.body }, 'Inactivas: ' + estadoActivas.inactivas.toLocaleString('en-US')));
    var itemActivas = crear('div', { display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', opacity: opacidadActivas });
    itemActivas.title = 'Clic para filtrar por Activas';
    itemActivas.addEventListener('click', function () { cfToggle('estado', 'Activa'); });
    itemActivas.appendChild(crear('span', { width: '9px', height: '9px', borderRadius: '50%', background: T.color.muted, display: 'inline-block' }));
    itemActivas.appendChild(crear('span', { fontSize: '0.76rem', color: T.color.body }, 'Activas: ' + estadoActivas.activas.toLocaleString('en-US')));
    filaConteos.appendChild(itemResueltas);
    filaConteos.appendChild(itemActivas);
    contenedor.appendChild(filaConteos);

    // Desglose por ciudad -- solo tiene sentido mostrarlo si hay mas de una
    // ciudad en los datos filtrados (con el filtro de Ciudad puesto en una
    // sola, ya es redundante con el total de arriba).
    if (porCiudad && porCiudad.length > 1) {
      var separador = crear('div', { borderTop: '1px solid ' + T.color.border, margin: '12px 0 10px 0' });
      contenedor.appendChild(separador);
      var listaCiudades = crear('div', { display: 'flex', flexDirection: 'column', gap: '8px' });
      porCiudad.forEach(function (item) { listaCiudades.appendChild(crearFilaCiudad(item)); });
      contenedor.appendChild(listaCiudades);
    }
  }

  // --- Render: gráfico de tendencia — episodios en el tiempo ----------------
  var chartTendencia = null;

  // CAMBIO: paso de escala "amigable" (1, 2, 5, 10, 20, 50, 100, 200, 500,
  // 1000...) en vez de dejar que Chart.js reparta el máximo entre ~5 marcas
  // sin más criterio (lo que daba saltos como 530/1060/1590 -- difíciles de
  // sumar mentalmente). Con rangos chicos (máximo ≤ 10) el paso se queda en 1,
  // porque no existen fracciones de episodio -- mismo caso que el fix anterior
  // para cuando el filtro deja solo 1 episodio en pantalla.
  function calcularPasoAmigable(maximo) {
    if (maximo <= 10) return 1;
    var pasoBruto = maximo / 5; // apunta a ~5 marcas en el eje
    var magnitud = Math.pow(10, Math.floor(Math.log10(pasoBruto)));
    var normalizado = pasoBruto / magnitud;
    var pasoNormalizado = normalizado <= 1 ? 1 : normalizado <= 2 ? 2 : normalizado <= 5 ? 5 : 10;
    return Math.round(pasoNormalizado * magnitud);
  }

  // CAMBIO (refactor gerencial 2026-09-12): se eliminó toda la lógica de
  // desviación estándar / varianza / banda de tolerancia -- exigía leer "el
  // punto está fuera de una banda estadística", denso para un vistazo
  // rápido. Ahora es un gráfico MIXTO: barras verdes = episodios del
  // periodo, línea azul marino = tendencia. La línea es un PROMEDIO MÓVIL
  // simple (no una "meta" inventada) porque no existe ningún valor objetivo
  // real configurado en este sistema -- una línea de meta a secas sería un
  // número fabricado en una herramienta para reclamos de garantía.
  // CAMBIO: 'badge' es el veredicto explícito "¿mi gestión está funcionando?"
  // -- compara el promedio de la PRIMERA mitad del rango visible contra la
  // SEGUNDA mitad (sobre la línea de tendencia ya suavizada, no sobre el
  // ruido crudo de las barras). Es un complemento del indicador ▲/▼ vs.
  // periodo anterior que ya tienen los KPIs (ese sí compara contra una
  // consulta real a Geotab del periodo previo, más riguroso, pero solo se ve
  // sin filtros activos) -- este veredicto funciona con cualquier filtro
  // puesto, porque no necesita datos fuera del rango que ya está en pantalla.
  function construirGraficoTendencia(canvas, serie, nota, badge) {
    if (chartTendencia) { chartTendencia.destroy(); chartTendencia = null; }

    var totalEpisodios = serie.valores.reduce(function (s, v) { return s + v; }, 0);
    if (serie.etiquetas.length === 0 || totalEpisodios === 0) {
      nota.style.display = 'none';
      badge.style.display = 'none';
      return false;
    }

    nota.style.display = 'block';
    nota.textContent = '🟩 Barras = episodios del periodo   —   Línea = tendencia (promedio móvil)';

    // Ventana de 7 puntos si la serie es diaria, 3 si ya viene agregada por
    // semana (rangos largos) -- ventana más chica al principio de la serie
    // (promedio de lo disponible) en vez de dejar los primeros puntos sin
    // línea, para que la tendencia se vea completa de extremo a extremo.
    var ventana = serie.porSemana ? 3 : 7;
    var mediaMovil = serie.valores.map(function (_, i) {
      var tramo = serie.valores.slice(Math.max(0, i - ventana + 1), i + 1);
      return tramo.reduce(function (s, v) { return s + v; }, 0) / tramo.length;
    });

    var n = serie.valores.length;
    if (n >= 4) {
      var mitad = Math.floor(n / 2);
      var promedio = function (arr) { return arr.reduce(function (s, v) { return s + v; }, 0) / arr.length; };
      var promedioInicio = promedio(mediaMovil.slice(0, mitad));
      var promedioFinal = promedio(mediaMovil.slice(mitad));
      var cambioPct = promedioInicio > 0
        ? Math.round(((promedioFinal - promedioInicio) / promedioInicio) * 100)
        : (promedioFinal > 0 ? 100 : 0);

      var veredicto;
      if (Math.abs(cambioPct) < 10) {
        veredicto = { texto: 'Estable', flecha: '▬', color: T.color.muted };
      } else if (cambioPct < 0) {
        veredicto = { texto: 'Mejorando', flecha: '▼', color: T.color.primary };
      } else {
        veredicto = { texto: 'Empeorando', flecha: '▲', color: CRITICIDAD.CRITICO.color };
      }

      badge.style.display = 'inline-block';
      badge.style.background = veredicto.color + '1A';
      badge.style.color = veredicto.color;
      badge.textContent = veredicto.texto === 'Estable'
        ? (veredicto.flecha + ' Estable (variación menor al 10% en el rango)')
        : (veredicto.flecha + ' ' + veredicto.texto + ' (' + Math.abs(cambioPct) + '% ' +
          (cambioPct < 0 ? 'menos' : 'más') + ' fallas que al inicio del rango)');
    } else {
      badge.style.display = 'none'; // muy pocos puntos para comparar inicio vs. final con sentido
    }

    // CAMBIO (2026-09-19, cross-filter): barra por día/semana ahora clicable
    // -- clic suma/quita ese balde de CF.dia (OR, se pueden elegir varios),
    // mismo lenguaje visual (verde oscuro = elegido, resto atenuado) que
    // Sistemas/Top vehículos.
    var diasSeleccionados = CF.dia || [];
    var datasets = [
      {
        type: 'bar',
        label: serie.porSemana ? 'Episodios por semana' : 'Episodios por día',
        data: serie.valores,
        backgroundColor: serie.claves.map(function (clave) {
          if (!diasSeleccionados.length) return T.color.primary;
          return diasSeleccionados.indexOf(clave) !== -1 ? T.color.primaryDark : 'rgba(115,184,40,0.3)';
        }),
        borderRadius: 4,
        order: 2
      },
      {
        type: 'line',
        label: 'Tendencia (promedio móvil)',
        data: mediaMovil,
        borderColor: T.color.ink,
        borderWidth: 2,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointBackgroundColor: T.color.ink,
        fill: false,
        order: 1
      }
    ];

    var pasoAmigable = calcularPasoAmigable(Math.max.apply(null, serie.valores));

    chartTendencia = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: { labels: serie.etiquetas, datasets: datasets },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false }, // un hover muestra barra + tendencia juntas
        onClick: function (evt, elementosClic) {
          if (!elementosClic || elementosClic.length === 0) return;
          cfToggle('dia', serie.claves[elementosClic[0].index]);
        },
        onHover: function (evt, elementosHover) {
          if (evt.native && evt.native.target) evt.native.target.style.cursor = elementosHover.length ? 'pointer' : 'default';
        },
        plugins: {
          legend: { display: false },
          datalabels: { display: false }, // este gráfico usa tooltip, no etiquetas fijas
          // CAMBIO: tooltip "ejecutivo" -- separador de miles + frase
          // completa, con estilo de más presencia (fondo azul marino).
          tooltip: {
            backgroundColor: T.color.ink,
            titleColor: '#FFFFFF',
            bodyColor: '#FFFFFF',
            padding: 10,
            cornerRadius: 8,
            displayColors: false,
            callbacks: {
              label: function (ctx) {
                if (ctx.dataset.type === 'line') {
                  return 'Tendencia: ' + Math.round(ctx.parsed.y).toLocaleString('en-US');
                }
                var valor = ctx.parsed.y;
                return [
                  valor.toLocaleString('en-US') + (valor === 1 ? ' episodio registrado' : ' episodios registrados'),
                  'Clic para filtrar por ' + (serie.porSemana ? 'esta semana' : 'este día')
                ];
              }
            }
          }
        },
        scales: {
          x: { ticks: { color: T.color.muted, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false } },
          y: {
            beginAtZero: true,
            ticks: {
              stepSize: pasoAmigable, precision: 0,
              callback: function (valor) { return valor.toLocaleString('en-US'); }, // separador de miles también en el eje
              color: T.color.muted, font: { size: 11 }
            },
            grid: { color: 'rgba(26,34,53,0.06)' }, // cuadrícula tenue -- el dato manda, no el fondo
            border: { display: false }
          }
        }
      }
    });
    return true;
  }

  // --- Encabezado (título + rango de fechas + botones) --------------------
  function construirEncabezado(contenedor) {
    var panel = crearPanel({
      padding: '18px 22px', marginBottom: '16px',
      background: 'linear-gradient(135deg, ' + T.color.ink + ' 0%, #1B2C5C 100%)'
    });

    var filaTitulo = crear('div', { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' });
    filaTitulo.appendChild(crearChip('📊', 'rgba(255,255,255,0.12)', '#FFFFFF', '34px'));
    var bloqueTitulo = crear('div');
    bloqueTitulo.appendChild(crear('h2', { margin: '0', color: '#FFFFFF', fontSize: '1.15rem', fontWeight: '800' }, 'Dashboard de Análisis de Fallas'));
    bloqueTitulo.appendChild(crear('div', { color: '#C7D2E0', fontSize: '0.78rem', marginTop: '2px' }, 'Reincidencias y anomalías para sustentar reclamos de garantía'));
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

    var botonFiltrar = crearBoton('Analizar rango', true);
    botonFiltrar.addEventListener('click', function () {
      guardarRango(campoDesde.input.value, campoHasta.input.value);
      cargarYRenderizar(new Date(campoDesde.input.value), new Date(campoHasta.input.value));
    });

    var botonUltimos30 = crearBoton('Últimos 30 días', false);
    botonUltimos30.addEventListener('click', function () {
      var rango = rangoPorDefecto();
      campoDesde.input.value = rango.desde;
      campoHasta.input.value = rango.hasta;
      guardarRango(rango.desde, rango.hasta);
      cargarYRenderizar(new Date(rango.desde), new Date(rango.hasta));
    });

    var envCiudad = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    envCiudad.appendChild(crear('label', { fontSize: '0.75rem', color: '#C7D2E0', fontWeight: '600' }, 'Ciudad'));
    var selectCiudad = crear('select', {
      padding: '7px 10px', border: '1px solid rgba(255,255,255,0.3)', borderRadius: T.radius.sm,
      fontSize: '0.82rem', fontFamily: T.font, color: T.color.ink, background: '#FFFFFF'
    });
    var opcionTodasCiudad = crear('option'); opcionTodasCiudad.value = 'Todas'; opcionTodasCiudad.textContent = 'Todas';
    selectCiudad.appendChild(opcionTodasCiudad);
    selectCiudad.addEventListener('change', function () {
      cfSet('ciudad', selectCiudad.value === 'Todas' ? null : selectCiudad.value);
    });
    envCiudad.appendChild(selectCiudad);

    var filaFiltros = crear('div', { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-end', marginTop: '14px' });
    filaFiltros.appendChild(campoDesde.envoltorio);
    filaFiltros.appendChild(campoHasta.envoltorio);
    filaFiltros.appendChild(envCiudad);
    filaFiltros.appendChild(botonFiltrar);
    filaFiltros.appendChild(botonUltimos30);
    panel.appendChild(filaFiltros);

    contenedor.appendChild(panel);
    return {
      inputDesde: campoDesde.input,
      inputHasta: campoHasta.input,
      botonFiltrar: botonFiltrar,
      botonUltimos30: botonUltimos30,
      selectCiudad: selectCiudad,
      actualizarOpcionesCiudad: function (ciudadesDisponibles) {
        var seleccionPrevia = selectCiudad.value || 'Todas';
        selectCiudad.innerHTML = '';
        var opcionTodas = crear('option'); opcionTodas.value = 'Todas'; opcionTodas.textContent = 'Todas';
        selectCiudad.appendChild(opcionTodas);
        ciudadesDisponibles.forEach(function (ciudad) {
          var opcion = crear('option'); opcion.value = ciudad; opcion.textContent = ciudad;
          selectCiudad.appendChild(opcion);
        });
        var sigueValida = seleccionPrevia === 'Todas' || ciudadesDisponibles.indexOf(seleccionPrevia) !== -1;
        selectCiudad.value = sigueValida ? seleccionPrevia : 'Todas';
        if (!sigueValida) delete CF.ciudad; // la ciudad elegida ya no existe en este rango -- se limpia sin disparar otro render (aplicarFiltrosYRenderizar corre después, en cargarYRenderizar)
      }
    };
  }

  // --- Selector de vehículo (fábrica reutilizable, rediseño 2026-09-19) ---
  // Antes vivía inline solo en construirBarraFiltros; ahora se instancia
  // DOS veces -- ahí y en el encabezado del hero de "Fallas por sistema"
  // (pedido explícito: "controles dinámicos para seleccionar un vehículo
  // específico" directamente en la gráfica central, sin volver a la barra
  // superior). Cada instancia tiene su propio <datalist> (id único, evita
  // colisión) pero ambas escriben sobre el mismo CF.vehiculo.
  var contadorSelectorVehiculo = 0;

  function crearSelectorVehiculo(ancho) {
    contadorSelectorVehiculo++;
    var idLista = 'dashboardFallasListaVehiculos_' + contadorSelectorVehiculo;
    var envoltorio = crear('div', { display: 'flex', gap: '6px' });
    var input = crear('input', {
      padding: '6px 9px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm,
      fontSize: '0.8rem', fontFamily: T.font, color: T.color.textoOscuro, background: T.color.surface, width: ancho || '180px'
    });
    input.type = 'text';
    input.placeholder = 'Buscar placa o nombre…';
    input.setAttribute('list', idLista);
    var datalist = crear('datalist');
    datalist.id = idLista;

    // clave (nombre - placa, en minúsculas) -> idVehiculo.
    var mapaPorClave = {};

    input.addEventListener('change', function () {
      var texto = input.value.trim().toLowerCase();
      // cfSet REEMPLAZA CF.vehiculo -- si además hay vehículos elegidos por
      // clic en el gráfico de Top vehículos, escribir acá los reemplaza a
      // todos por este único resultado (buscador de texto único, distinto
      // del clic-para-sumar del gráfico).
      cfSet('vehiculo', texto ? (mapaPorClave[texto] || null) : null);
    });

    var botonLimpiar = crear('button', {
      padding: '6px 9px', background: 'transparent', color: T.color.body,
      border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm, fontSize: '0.78rem', cursor: 'pointer'
    }, '✕');
    botonLimpiar.title = 'Quitar filtro de vehículo';
    botonLimpiar.addEventListener('click', function () { input.value = ''; cfClearKey('vehiculo'); });

    envoltorio.appendChild(input);
    envoltorio.appendChild(botonLimpiar);
    envoltorio.appendChild(datalist);

    return {
      envoltorio: envoltorio,
      input: input,
      // Repuebla el <datalist> con los vehículos reales de la consulta
      // actual, y precarga el texto si ya hay un CF.vehiculo de un solo
      // valor activo (ej. elegido desde la OTRA instancia del selector).
      actualizarOpciones: function (infoVehiculos) {
        datalist.innerHTML = '';
        mapaPorClave = {};
        Object.keys(infoVehiculos).forEach(function (idVeh) {
          var clave = infoVehiculos[idVeh].claveVehiculo;
          if (!clave) return;
          mapaPorClave[clave.toLowerCase()] = idVeh;
          var opcion = crear('option'); opcion.value = clave;
          datalist.appendChild(opcion);
        });
        var claveActual = input.value.trim().toLowerCase();
        if (claveActual && !mapaPorClave[claveActual]) { input.value = ''; delete CF.vehiculo; }
      }
    };
  }

  // CAMBIO: barra de filtros adicional -- tipo de vehículo (dropdown, se
  // repuebla con los tipos reales que trae cada consulta, mismo patrón que
  // el select de Ciudad) + criticidad (chips de multiselección) + botón
  // "Limpiar filtros". El filtro de "área/sede" que se pidió no se duplica
  // aparte: en este proyecto esa noción YA es "Ciudad" (Bogotá/Cali/Valle,
  // resuelta por jerarquía de grupos de Geotab), que ya está en el encabezado.
  function construirBarraFiltros(contenedor) {
    var panel = crearPanel({ padding: '14px 18px', marginBottom: '16px', display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-end' });

    var envTipo = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    envTipo.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.body, fontWeight: '600' }, 'Tipo de vehículo'));
    var selectTipo = crear('select', {
      padding: '7px 10px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm,
      fontSize: '0.82rem', fontFamily: T.font, color: T.color.textoOscuro, background: T.color.surface
    });
    var opcionTodosTipo = crear('option'); opcionTodosTipo.value = 'Todas'; opcionTodosTipo.textContent = 'Todos';
    selectTipo.appendChild(opcionTodosTipo);
    selectTipo.addEventListener('change', function () {
      cfSet('tipo', selectTipo.value === 'Todas' ? null : selectTipo.value);
    });
    envTipo.appendChild(selectTipo);
    panel.appendChild(envTipo);

    // CAMBIO (2026-09-19): usa la fábrica crearSelectorVehiculo -- misma
    // lógica que antes, ahora compartida con la instancia del hero de
    // sistemas (ver construirSeccionSistemas).
    var envVehiculo = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    envVehiculo.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.body, fontWeight: '600' }, 'Vehículo'));
    var selectorVehiculo = crearSelectorVehiculo('190px');
    envVehiculo.appendChild(selectorVehiculo.envoltorio);
    panel.appendChild(envVehiculo);

    var envCriticidad = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    var filaLabelCriticidad = crear('div', { display: 'flex', alignItems: 'center', gap: '4px' });
    filaLabelCriticidad.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.body, fontWeight: '600' }, 'Criticidad'));
    filaLabelCriticidad.appendChild(crearAyudaCriticidad());
    envCriticidad.appendChild(filaLabelCriticidad);
    var filaChips = crear('div', { display: 'flex', gap: '6px', flexWrap: 'wrap' });
    var botonesCriticidad = {};

    // CAMBIO (2026-09-18, cross-filter): las 4 criticidades ahora viven en
    // CF.criticidad (array de niveles) con la MISMA semántica que el resto
    // de dimensiones -- vacío = sin filtro (se muestran las 4), un clic
    // AGREGA ese nivel al filtro (aísla/suma, ya no "des-marca" desde un
    // estado inicial de las 4 activas). Cambio de comportamiento respecto
    // a antes, adoptado a propósito para que Criticidad se sienta igual de
    // clicable/combinable que Sistema o Vehículo.
    function actualizarEstiloChip(nivelId) {
      var boton = botonesCriticidad[nivelId];
      var activos = CF.criticidad || [];
      var activo = activos.length === 0 || activos.indexOf(CRITICIDAD[nivelId].nivel) !== -1;
      var color = CRITICIDAD[nivelId].color;
      aplicarEstilo(boton, {
        background: activo ? color : 'transparent',
        color: activo ? '#FFFFFF' : color,
        border: '1px solid ' + color
      });
    }

    Object.keys(CRITICIDAD).forEach(function (nivelId) {
      var boton = crear('button', {
        padding: '5px 11px', borderRadius: T.radius.pill, fontSize: '0.76rem', fontWeight: '700', cursor: 'pointer'
      }, CRITICIDAD[nivelId].nivel);
      boton.addEventListener('click', function () {
        cfToggle('criticidad', CRITICIDAD[nivelId].nivel);
        Object.keys(CRITICIDAD).forEach(actualizarEstiloChip);
      });
      botonesCriticidad[nivelId] = boton;
      actualizarEstiloChip(nivelId);
      filaChips.appendChild(boton);
    });
    envCriticidad.appendChild(filaChips);
    panel.appendChild(envCriticidad);

    var botonLimpiar = crear('button', {
      padding: '8px 14px', background: 'transparent', color: T.color.body,
      border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm,
      fontSize: '0.8rem', fontWeight: '600', cursor: 'pointer'
    }, 'Limpiar filtros');
    botonLimpiar.addEventListener('click', function () {
      CF = {};
      Object.keys(CRITICIDAD).forEach(actualizarEstiloChip);
      if (elementos.selectCiudad) elementos.selectCiudad.value = 'Todas';
      selectTipo.value = 'Todas';
      selectorVehiculo.input.value = '';
      aplicarFiltrosYRenderizar();
    });
    panel.appendChild(botonLimpiar);

    contenedor.appendChild(panel);
    return {
      selectTipo: selectTipo,
      actualizarOpcionesTipo: function (tiposDisponibles) {
        var seleccionPrevia = selectTipo.value || 'Todas';
        selectTipo.innerHTML = '';
        var opcionTodas = crear('option'); opcionTodas.value = 'Todas'; opcionTodas.textContent = 'Todos';
        selectTipo.appendChild(opcionTodas);
        tiposDisponibles.forEach(function (tipo) {
          var opcion = crear('option'); opcion.value = tipo; opcion.textContent = tipo;
          selectTipo.appendChild(opcion);
        });
        var sigueValida = seleccionPrevia === 'Todas' || tiposDisponibles.indexOf(seleccionPrevia) !== -1;
        selectTipo.value = sigueValida ? seleccionPrevia : 'Todas';
        if (!sigueValida) delete CF.tipo;
      },
      actualizarOpcionesVehiculo: selectorVehiculo.actualizarOpciones
    };
  }

  function mostrarCargando(contenedor) {
    while (contenedor.firstChild) contenedor.removeChild(contenedor.firstChild);
    var envoltorio = crear('div', { padding: '40px 22px', textAlign: 'center' });
    envoltorio.appendChild(crear('div', { fontSize: '0.85rem', color: T.color.body, fontWeight: '600' }, 'Analizando fallas del rango seleccionado…'));
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

  // Grid de gráficos: ~60% del ancho principal, tendencia arriba a todo el
  // ancho (es una serie de tiempo, gana claridad horizontal) y barras/dona
  // abajo repartiéndose el espacio -- las tablas quedan como sección aparte,
  // más abajo y con menos peso visual (ver construirTablaSecundaria).
  // CAMBIO: ya no recibe 'grupos'/'catalogos' -- solo el gráfico de barras
  // los necesitaba (para el desglose apilado por criticidad de falla), y ese
  // desglose se quitó en el refactor gerencial 2026-09-12.
  function construirSeccionGraficos(contenedor, vehiculosOrdenados, estadoActivas, serieTemporal, porCiudad) {
    var seccion = crear('div', { marginBottom: '16px' });

    var panelTendencia = crearPanel({ padding: '16px 18px', marginBottom: '12px' });
    var filaTituloTendencia = crear('div', { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '2px' });
    // CAMBIO (2026-09-18, cross-filter): título con sufijo de TODOS los
    // filtros cruzados activos (etiquetaFiltrosCf), no solo sistema -- esta
    // misma tendencia (con su veredicto Mejorando/Empeorando) se recalcula
    // sobre cualquier combinación de CF (ver aplicarFiltrosYRenderizar), así
    // que el título tiene que decirlo para que no se lea como la tendencia
    // de TODA la flota por error.
    filaTituloTendencia.appendChild(crear('div', {
      color: T.color.ink, fontSize: '0.85rem', fontWeight: '800'
      // 'dia' se excluye del sufijo: este gráfico ignora su propio filtro
      // (muestra siempre el rango completo) para poder comparar/cambiar de
      // día elegido sin perder el panorama -- mismo criterio que Sistemas.
    }, '📈 Tendencia de episodios en el tiempo' + etiquetaFiltrosCf('dia')));
    // CAMBIO: veredicto explícito "¿la gestión está funcionando?" -- lo llena
    // construirGraficoTendencia comparando la primera mitad del rango contra
    // la segunda (ver comentario ahí). Empieza oculto hasta que haya
    // suficientes puntos para comparar con sentido.
    var badgeTendencia = crear('span', {
      display: 'none', padding: '3px 10px', borderRadius: T.radius.pill, fontSize: '0.74rem', fontWeight: '700'
    });
    filaTituloTendencia.appendChild(badgeTendencia);
    panelTendencia.appendChild(filaTituloTendencia);
    // CAMBIO: la nota ahora empieza oculta -- construirGraficoTendencia le
    // pone el texto de "barras = ... línea = ..." solo cuando hay datos.
    var notaTendencia = crear('div', { margin: '0 0 10px 0', color: T.color.muted, fontSize: '0.72rem', display: 'none' });
    panelTendencia.appendChild(notaTendencia);
    var canvasTendencia = crear('canvas', { maxHeight: '190px' });
    var envoltorioTendencia = crear('div', { position: 'relative', height: '190px' });
    envoltorioTendencia.appendChild(canvasTendencia);
    panelTendencia.appendChild(envoltorioTendencia);
    seccion.appendChild(panelTendencia);

    var filaInferior = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap' });

    var panelBarras = crearPanel({ padding: '16px 18px', flex: '3 1 420px', minWidth: '320px' });
    panelBarras.appendChild(crear('div', {
      margin: '0 0 4px 0', color: T.color.ink, fontSize: '0.85rem', fontWeight: '800'
      // 'vehiculo' se excluye del sufijo: este gráfico ignora su propio
      // filtro (muestra siempre el Top 5 completo para poder comparar),
      // solo resalta la barra elegida -- mismo criterio que Sistemas.
    }, '🚨 Top ' + TOP_N + ' vehículos con más fallas' + etiquetaFiltrosCf('vehiculo')));
    panelBarras.appendChild(crearLeyendaCriticidad()); // CAMBIO: leyenda de criticidad
    var canvasBarras = crear('canvas', { maxHeight: '220px' });
    var envoltorioBarras = crear('div', { position: 'relative', height: '220px' });
    envoltorioBarras.appendChild(canvasBarras);
    panelBarras.appendChild(envoltorioBarras);
    filaInferior.appendChild(panelBarras);

    // CAMBIO: panel de dona -> panel de barra de progreso HTML/CSS (sin
    // canvas). Mismo ancho reducido de antes (la info es igual de compacta).
    var panelResueltas = crearPanel({ padding: '16px 18px', flex: '1 1 220px', minWidth: '200px' });
    panelResueltas.appendChild(crear('div', {
      margin: '0 0 10px 0', color: T.color.ink, fontSize: '0.85rem', fontWeight: '800'
    }, '🟢 Activas vs. inactivas' + etiquetaFiltrosCf('estado')));
    var contenedorResueltas = crear('div');
    panelResueltas.appendChild(contenedorResueltas);
    filaInferior.appendChild(panelResueltas);

    seccion.appendChild(filaInferior);
    contenedor.appendChild(seccion);

    // CAMBIO: si un gráfico no tuvo datos reales (0 episodios / 0 vehículos),
    // se oculta su canvas y se muestra un mensaje amigable centrado en su
    // lugar -- en vez de una línea/barra plana en cero, que confunde más de
    // lo que informa. La barra de progreso maneja su propio vacío internamente.
    if (!construirGraficoTendencia(canvasTendencia, serieTemporal, notaTendencia, badgeTendencia)) {
      canvasTendencia.style.display = 'none';
      envoltorioTendencia.appendChild(crearEstadoVacioGrafico(
        'No se registraron episodios de falla' + descripcionFiltroCriticidad() + ' para el rango seleccionado.'
      ));
    }

    if (!construirGraficoBarras(canvasBarras, vehiculosOrdenados)) {
      canvasBarras.style.display = 'none';
      envoltorioBarras.appendChild(crearEstadoVacioGrafico(
        'No hay vehículos con fallas' + descripcionFiltroCriticidad() + ' en el rango seleccionado.'
      ));
    }

    construirBarraResueltas(contenedorResueltas, estadoActivas, porCiudad);
  }

  // --- Render: resumen narrativo gerencial (CAMBIO 2026-09-15) ------------
  // Contesta en lenguaje simple las 3 preguntas que un director/coordinador
  // se hace al abrir el dashboard, sin tener que leer gráficos ni tablas:
  //   1. ¿Cuántos vehículos están en estado crítico ahora mismo?
  //   2. ¿La situación mejoró o empeoró frente al periodo anterior (y cuánto)?
  //   3. ¿Cuál es el problema que más se repite y amerita atención?
  // Deliberadamente NO es un texto fijo: se arma cada vez a partir de los
  // mismos datos ya agregados que usan los KPIs/gráficas/tablas (nunca
  // recalcula nada por su cuenta), así que queda siempre sincronizado y se
  // actualiza solo con cada refresco automático, cambio de fecha o filtro.
  function construirResumenNarrativo(contenedor, grupos, vehiculosOrdenados, codigosOrdenados, periodoAnterior) {
    var totalEpisodios = grupos.reduce(function (s, g) { return s + g.episodios; }, 0);
    var criticos = vehiculosOrdenados.filter(function (v) { return v.criticidad === CRITICIDAD.CRITICO.nivel; }).length;

    var lineas = [];

    // --- Pregunta 1: estado general ---------------------------------------
    if (vehiculosOrdenados.length === 0) {
      lineas.push({ icono: '✅', texto: 'No se registraron fallas' + descripcionFiltroCriticidad() + ' en el rango seleccionado.', color: T.color.primaryDark });
    } else if (criticos === 0) {
      lineas.push({ icono: '🟢', texto: 'Ningún vehículo en estado crítico — situación bajo control.', color: T.color.primaryDark });
    } else {
      lineas.push({
        icono: '🔴',
        texto: criticos + ' vehículo' + (criticos === 1 ? '' : 's') + ' en estado crítico' + (criticos === 1 ? ' requiere' : ' requieren') + ' atención inmediata.',
        color: T.color.alertaTexto
      });
    }

    // --- Pregunta 2: tendencia vs. periodo anterior -----------------------
    // Mismo criterio que crearIndicadorTendencia/construirKpis: solo tiene
    // sentido comparar cuando periodoAnterior existe (sin filtros activos,
    // ver aplicarFiltrosYRenderizar) -- comparar un total filtrado de hoy
    // contra uno sin filtrar de ayer no es una comparación válida.
    if (periodoAnterior) {
      var anterior = periodoAnterior.totalEpisodios;
      if (totalEpisodios === anterior) {
        lineas.push({ icono: '▬', texto: 'El nivel de fallas se mantiene igual que en el periodo anterior.', color: T.color.muted });
      } else {
        var subio = totalEpisodios > anterior;
        var cambioPct = anterior === 0 ? 100 : Math.round(((totalEpisodios - anterior) / anterior) * 100);
        lineas.push({
          icono: subio ? '▲' : '▼',
          texto: 'Las fallas ' + (subio ? 'aumentaron' : 'bajaron') + ' ' + Math.abs(cambioPct) + '% frente al periodo anterior' + (subio ? '.' : ' — la gestión está funcionando.'),
          color: subio ? T.color.alertaTexto : T.color.primaryDark
        });
      }
    }

    // --- Pregunta 3: problema que más se repite ---------------------------
    if (codigosOrdenados.length > 0) {
      var top = codigosOrdenados[0];
      lineas.push({
        icono: '🔁',
        texto: 'El problema más repetido es "' + top.nombreFalla + '" (SPN ' + top.spn + ' / FMI ' + top.fmi + '), con ' +
          top.episodios + ' episodio(s) en ' + top.vehiculosAfectados + ' vehículo(s).',
        color: T.color.ink
      });
    }

    var colorBorde = criticos > 0 ? T.color.alertaTexto : T.color.primary;
    var panel = crearPanel({
      padding: '16px 18px', marginBottom: '16px', borderLeft: '4px solid ' + colorBorde,
      display: 'flex', flexDirection: 'column', gap: '8px'
    });
    panel.appendChild(crear('div', {
      fontSize: '0.72rem', fontWeight: '800', color: T.color.textoGris, textTransform: 'uppercase', letterSpacing: '0.03em'
    }, '📌 Resumen'));
    lineas.forEach(function (linea) {
      var fila = crear('div', { display: 'flex', alignItems: 'flex-start', gap: '8px' });
      fila.appendChild(crear('span', { fontSize: '0.95rem', lineHeight: '1.4' }, linea.icono));
      fila.appendChild(crear('span', { fontSize: '0.92rem', fontWeight: '600', color: linea.color, lineHeight: '1.4' }, linea.texto));
      panel.appendChild(fila);
    });
    contenedor.appendChild(panel);
  }

  // --- Render: banner de filtros cruzados activos (2026-09-18) -----------
  // Un chip removible por cada valor activo en CF, agrupados visualmente
  // -- mismo patrón que el reporte de referencia que el usuario trajo como
  // ejemplo (cf-banner/cf-chips). Si no hay ningún filtro cruzado activo,
  // no se muestra nada (ni un contenedor vacío).
  function construirBannerCf(contenedor) {
    var claves = CF_ORDEN.filter(function (k) { return CF[k] && CF[k].length; });
    if (!claves.length) return;

    var banner = crearPanel({
      padding: '10px 14px', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '8px',
      background: T.color.primarySoft, border: '1px solid ' + T.color.primary
    });
    banner.appendChild(crear('div', {
      fontSize: '0.7rem', fontWeight: '800', color: T.color.primaryDark, textTransform: 'uppercase', letterSpacing: '0.03em'
    }, '🔗 Filtros cruzados activos'));

    var filaChips = crear('div', { display: 'flex', flexWrap: 'wrap', gap: '6px' });
    claves.forEach(function (clave) {
      CF[clave].forEach(function (valor) {
        var chip = crear('span', {
          display: 'inline-flex', alignItems: 'center', gap: '6px', background: T.color.primary, color: '#FFFFFF',
          borderRadius: T.radius.pill, padding: '3px 6px 3px 12px', fontSize: '0.76rem', fontWeight: '700'
        });
        chip.appendChild(document.createTextNode(CF_LABELS[clave] + ': ' + etiquetaValorCf(clave, valor)));
        var boton = crear('button', {
          border: 'none', background: 'rgba(255,255,255,0.35)', color: '#FFFFFF', borderRadius: '50%',
          width: '16px', height: '16px', lineHeight: '1', cursor: 'pointer', fontSize: '11px', fontWeight: '800', padding: '0'
        }, '×');
        boton.title = 'Quitar este filtro';
        boton.addEventListener('click', function () { cfRemoveValue(clave, valor); });
        chip.appendChild(boton);
        filaChips.appendChild(chip);
      });
    });
    banner.appendChild(filaChips);

    var botonLimpiarTodo = crear('button', {
      alignSelf: 'flex-start', border: '1px solid ' + T.color.primary, background: '#FFFFFF', color: T.color.primaryDark,
      borderRadius: T.radius.sm, padding: '4px 10px', fontSize: '0.74rem', fontWeight: '700', cursor: 'pointer'
    }, 'Quitar todos los filtros cruzados');
    botonLimpiarTodo.addEventListener('click', cfClearAll);
    banner.appendChild(botonLimpiarTodo);

    contenedor.appendChild(banner);
  }

  // 'grupos'/'vehiculosOrdenados' ya vienen restringidos a TODO CF (ver
  // aplicarFiltrosYRenderizar). 'gruposTodosLosSistemas' y
  // 'vehiculosParaGraficoTop' son aparte: cada uno ignora SU PROPIA
  // dimensión (sistema / vehículo) para que esos dos gráficos sigan
  // mostrando su panorama completo mientras el resto del dashboard queda
  // enfocado en la selección.
  //
  // CAMBIO (rediseño 2026-09-19, pedido explícito del usuario): el hero ya
  // no es la tendencia temporal -- es la "Radiografía de Sistemas". Nuevo
  // orden: resumen -> KPIs de sistema/criticidad (construirKpisHero) ->
  // HERO (Fallas por sistema, con su propio selector de vehículo y
  // drill-down) -> sección SECUNDARIA (KPIs genéricos + Tendencia + Top
  // vehículos + Activas/Inactivas, ahora más chica) -> tablas de detalle.
  function renderizarResultados(
    contenedor, grupos, vehiculosOrdenados, codigosOrdenados, estadoActivas, serieTemporal,
    periodoAnterior, porCiudad, catalogos, gruposTodosLosSistemas, vehiculosParaGraficoTop
  ) {
    while (contenedor.firstChild) contenedor.removeChild(contenedor.firstChild);
    construirBannerCf(contenedor);
    construirResumenNarrativo(contenedor, grupos, vehiculosOrdenados, codigosOrdenados, periodoAnterior);
    construirKpisHero(contenedor, grupos, catalogos);
    // HERO: drill-down general -> particular por sistema, ahora primero.
    construirSeccionSistemas(contenedor, gruposTodosLosSistemas, catalogos);

    // Sección secundaria (demota tendencia/KPIs genéricos, pedido explícito
    // del usuario) -- rótulo discreto para separarla visualmente del hero.
    contenedor.appendChild(crear('div', {
      margin: '4px 0 10px 0', color: T.color.muted, fontSize: '0.7rem', fontWeight: '800',
      textTransform: 'uppercase', letterSpacing: '0.04em', borderTop: '1px solid ' + T.color.border, paddingTop: '16px'
    }, 'Panorama general'));
    construirKpis(contenedor, grupos, vehiculosOrdenados, codigosOrdenados, estadoActivas, periodoAnterior);
    construirSeccionGraficos(contenedor, vehiculosParaGraficoTop, estadoActivas, serieTemporal, porCiudad);

    // CAMBIO (2026-09-19, pedido explícito del usuario): la tabla "Detalle
    // — Top N vehículos" AHORA SÍ respeta CF.vehiculo -- usa
    // 'vehiculosOrdenados' (todas las dimensiones de CF aplicadas), no
    // 'vehiculosParaGraficoTop' (que ignora vehículo a propósito, ver
    // construirSeccionGraficos/construirGraficoBarras). Si se filtra por un
    // solo vehículo, esta tabla ahora colapsa a esa fila -- el GRÁFICO de
    // arriba (Top vehículos) sigue mostrando el panorama completo con la
    // barra elegida resaltada, eso no cambió.
    var filaTablas = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap' });
    filaTablas.appendChild(construirTablaVehiculos(vehiculosOrdenados));
    filaTablas.appendChild(construirTablaCodigos(codigosOrdenados));
    contenedor.appendChild(filaTablas);
  }

  // --- Orquestación ---------------------------------------------------------
  // cargarYRenderizar SIEMPRE consulta Geotab (cambio de rango de fechas).
  // aplicarFiltrosYRenderizar SOLO recalcula sobre lo que ya está en
  // datosCache -- el filtro de ciudad no dispara una consulta nueva, filtra en
  // memoria y vuelve a agregar/renderizar al instante.
  var contenedorPrincipal = null;
  var contenedorResultados = null;

  // --- Cross-filter multidimensional (2026-09-18) -------------------------
  // Mismo patrón que el reporte de referencia que trajo el usuario para
  // "sumar" mejoras de gráficas (Reporte_Fallos_....html, con su motor
  // JS de CF/cfToggle/filterRowsCf): CF = {clave: [valores]}. La MISMA
  // clave es OR entre sus valores (ej. criticidad Crítico + Alto a la
  // vez); claves DISTINTAS son AND (ej. Ciudad=Bogotá Y Sistema=Motor).
  // Reemplaza el filtroEstado anterior (un solo valor por dimensión, sin
  // Sistema) y la variable suelta 'sistemaSeleccionado' -- ahora TODA
  // dimensión filtrable (ciudad, tipo, vehículo, sistema, criticidad) vive
  // en el mismo objeto, con el mismo mecanismo de chips removibles (ver
  // construirBannerCf) y el mismo criterio "cada gráfico ignora su PROPIA
  // dimensión para seguir mostrando el panorama completo" (ver
  // gruposParaDimension en aplicarFiltrosYRenderizar).
  var CF = {};
  // CAMBIO (2026-09-19): se agregan 'dia' (barra de Tendencia) y 'estado'
  // (Activas/Inactivas) -- ahora TODOS los gráficos del dashboard son
  // clicables, no solo Sistema/Vehículo.
  var CF_LABELS = { ciudad: 'Ciudad', tipo: 'Tipo de vehículo', vehiculo: 'Vehículo', sistema: 'Sistema', criticidad: 'Criticidad', dia: 'Fecha', estado: 'Estado' };
  var CF_ORDEN = ['ciudad', 'tipo', 'vehiculo', 'sistema', 'criticidad', 'dia', 'estado'];

  function cfToggle(clave, valor) {
    var arr = CF[clave] || [];
    var idx = arr.indexOf(valor);
    arr = idx === -1 ? arr.concat([valor]) : arr.slice(0, idx).concat(arr.slice(idx + 1));
    if (arr.length) CF[clave] = arr; else delete CF[clave];
    aplicarFiltrosYRenderizar();
  }
  // cfSet: para controles de selección única (dropdown Ciudad/Tipo,
  // buscador de Vehículo) -- REEMPLAZA el valor de esa clave en vez de
  // sumarlo. Un clic posterior en un gráfico (cfToggle) puede seguir
  // sumando un segundo valor -- ambos mecanismos escriben sobre el mismo CF.
  function cfSet(clave, valor) {
    if (valor) CF[clave] = [valor]; else delete CF[clave];
    aplicarFiltrosYRenderizar();
  }
  function cfRemoveValue(clave, valor) {
    var arr = (CF[clave] || []).filter(function (v) { return v !== valor; });
    if (arr.length) CF[clave] = arr; else delete CF[clave];
    aplicarFiltrosYRenderizar();
  }
  function cfClearKey(clave) { delete CF[clave]; aplicarFiltrosYRenderizar(); }
  function cfClearAll() { CF = {}; aplicarFiltrosYRenderizar(); }
  function cfHayFiltrosActivos() { return CF_ORDEN.some(function (k) { return CF[k] && CF[k].length; }); }

  // Evalúa si un grupo (episodio de falla de un vehículo+diagnóstico) pasa
  // el filtro de UNA clave puntual -- 'criticidad' NO se resuelve acá
  // porque es una propiedad del VEHÍCULO agregado (episodios totales +
  // tieneFallaCritica), no de un grupo individual; se aplica aparte, sobre
  // vehiculosOrdenados, en aplicarFiltrosYRenderizar.
  function grupoPasaClave(g, clave, catalogos) {
    var valores = CF[clave];
    if (!valores || !valores.length) return true;
    if (clave === 'ciudad') { var info = datosCache.infoVehiculos[g.idVehiculo]; return !!info && valores.indexOf(info.ciudad) !== -1; }
    if (clave === 'tipo') { var info2 = datosCache.infoVehiculos[g.idVehiculo]; return !!info2 && valores.indexOf(info2.tipologia) !== -1; }
    if (clave === 'vehiculo') { return valores.indexOf(g.idVehiculo) !== -1; }
    if (clave === 'sistema') {
      var diagInfo = catalogos.dicDiag[g.idDiagnostico];
      return valores.indexOf(resolverSistemaPrincipal(diagInfo ? diagInfo.nombre : '')) !== -1;
    }
    // CAMBIO (2026-09-19): 'dia' -- un grupo puede tener episodios en VARIOS
    // días, así que pasa el filtro si CUALQUIERA de sus fechas cae en un
    // balde elegido (mismo criterio resolverClaveBalde que arma la barra de
    // Tendencia -- una sola fuente de verdad para "a qué día pertenece").
    if (clave === 'dia') {
      var porSemana = resolverPorSemana(datosCache.desde, datosCache.hasta);
      return (g.fechasEpisodios || []).some(function (f) { return valores.indexOf(resolverClaveBalde(f, porSemana)) !== -1; });
    }
    // 'estado' -- Activa/Inactiva al final del rango (ver activaAlFinal en
    // calcularEpisodiosPorGrupo), mismo criterio que ya usa contarActivasInactivas.
    if (clave === 'estado') { return valores.indexOf(g.activaAlFinal ? 'Activa' : 'Inactiva') !== -1; }
    return true;
  }

  function etiquetaValorCf(clave, valor) {
    if (clave === 'vehiculo') {
      var info = datosCache.infoVehiculos[valor];
      return info ? info.claveVehiculo : valor;
    }
    if (clave === 'dia') {
      return etiquetaClaveBalde(valor, resolverPorSemana(datosCache.desde, datosCache.hasta));
    }
    return valor;
  }

  // Sufijo "— Ciudad: Bogotá · Sistema: Motor" para títulos de panel.
  // excluirClave: la dimensión que ESE panel ya ignora para seguir
  // mostrando su propio panorama completo (ver comentario de cabecera).
  function etiquetaFiltrosCf(excluirClave) {
    var partes = [];
    CF_ORDEN.forEach(function (clave) {
      if (clave === excluirClave) return;
      var valores = CF[clave];
      if (!valores || !valores.length) return;
      partes.push(CF_LABELS[clave] + ': ' + valores.map(function (v) { return etiquetaValorCf(clave, v); }).join('/'));
    });
    return partes.length ? ' — ' + partes.join(' · ') : '';
  }

  var datosCache = { grupos: [], infoVehiculos: {}, catalogos: null, desde: null, hasta: null, periodoAnterior: null };
  var idIntervaloAutoRefresco = null;

  // CAMBIO (2026-09-17): candado contra solicitudes superpuestas -- mismo
  // bug real ya encontrado y corregido en sobreRevolucionPTO.js: sin esto,
  // el refresco automatico (ahora cada 10 min) puede disparar un segundo
  // pipeline completo (FaultData + catalogos + periodo anterior + info de
  // vehiculos) mientras un click en "Analizar rango"/"Ultimos 30 dias" (o un
  // tick anterior) sigue en vuelo, saturando la sesion de Geotab. Mientras
  // haya una carga en curso, las demas se ignoran en vez de sumarse.
  var cargaEnCurso = false;

  function deshabilitarBotonesCarga() {
    [elementos.botonFiltrar, elementos.botonUltimos30].forEach(function (boton) {
      if (!boton) return;
      boton.disabled = true;
      boton.style.opacity = '0.55';
      boton.style.cursor = 'not-allowed';
    });
  }

  function habilitarBotonesCarga() {
    [elementos.botonFiltrar, elementos.botonUltimos30].forEach(function (boton) {
      if (!boton) return;
      boton.disabled = false;
      boton.style.opacity = '1';
      boton.style.cursor = 'pointer';
    });
  }

  function sinFiltrosActivos() { return !cfHayFiltrosActivos(); }

  // CAMBIO (2026-09-18, cross-filter multidimensional): 'ciudad' y 'tipo'
  // (dropdowns de encabezado) se aplican primero y definen el universo
  // "base" con el que se calcula la criticidad REAL de cada vehículo --
  // la criticidad es una propiedad agregada (episodios totales +
  // tieneFallaCritica) que debe reflejar ese alcance amplio, nunca la
  // dimensión puntual que un gráfico esté ignorando de sí mismo (ver
  // gruposParaDimension). Con eso resuelto una sola vez, cada gráfico
  // "dueño" de una dimensión (Sistema, Top vehículos) pide su propio
  // subconjunto ignorando SOLO su propia clave, para seguir mostrando su
  // panorama completo aunque el resto del tablero ya esté filtrado --
  // mismo patrón 'filterRowsCf(rows, exclude)' del reporte de referencia
  // que el usuario trajo como ejemplo.
  function aplicarFiltrosYRenderizar() {
    var catalogos = datosCache.catalogos;

    var gruposCiudadTipo = datosCache.grupos.filter(function (g) {
      return grupoPasaClave(g, 'ciudad', catalogos) && grupoPasaClave(g, 'tipo', catalogos);
    });

    var vehiculosBase = agregarPorVehiculo(gruposCiudadTipo, datosCache.infoVehiculos, catalogos);
    // Si el usuario deselecciona las 4 criticidades por accidente (array
    // vacío tras varios toggles), CF.criticidad se borra solo (ver
    // cfToggle) y esto vuelve a permitir todas -- nunca queda "0 niveles
    // permitidos" mostrando un dashboard vacío sin explicación.
    var idsCriticidadOk = null;
    if (CF.criticidad && CF.criticidad.length) {
      idsCriticidadOk = {};
      vehiculosBase.forEach(function (v) { if (CF.criticidad.indexOf(v.criticidad) !== -1) idsCriticidadOk[v.idVehiculo] = true; });
    }

    function gruposParaDimension(excluirClave) {
      return gruposCiudadTipo.filter(function (g) {
        if (idsCriticidadOk && !idsCriticidadOk[g.idVehiculo]) return false;
        if (excluirClave !== 'vehiculo' && !grupoPasaClave(g, 'vehiculo', catalogos)) return false;
        if (excluirClave !== 'sistema' && !grupoPasaClave(g, 'sistema', catalogos)) return false;
        if (excluirClave !== 'dia' && !grupoPasaClave(g, 'dia', catalogos)) return false;
        if (excluirClave !== 'estado' && !grupoPasaClave(g, 'estado', catalogos)) return false;
        return true;
      });
    }

    // "Resto del tablero" (KPIs, resumen narrativo, tabla de códigos):
    // TODAS las dimensiones de CF aplican.
    var gruposParaResto = gruposParaDimension(null);
    var vehiculosOrdenadosParaResto = agregarPorVehiculo(gruposParaResto, datosCache.infoVehiculos, catalogos);

    // Gráficos "dueños" de una dimensión: cada uno ignora SOLO la suya,
    // para poder seguir comparando/cambiar de selección sin perder el
    // panorama -- mismo criterio para las 4 dimensiones clicables
    // (Sistema, Top vehículos, Tendencia por día, Activas/Inactivas).
    var gruposParaSistemas = gruposParaDimension('sistema');
    var vehiculosParaGraficoTop = agregarPorVehiculo(gruposParaDimension('vehiculo'), datosCache.infoVehiculos, catalogos);
    var gruposParaTendencia = gruposParaDimension('dia');
    var gruposParaEstado = gruposParaDimension('estado');

    var codigosOrdenados = agregarPorCodigo(gruposParaResto, catalogos);
    // CAMBIO (2026-09-19): estadoActivas/porCiudad ahora se calculan sobre
    // gruposParaEstado (ignora CF.estado) en vez de gruposParaResto -- así
    // el panel "Activas vs. inactivas" sigue mostrando AMBOS segmentos
    // (resaltando el elegido) en vez de colapsar a uno solo al hacer clic.
    var estadoActivas = contarActivasInactivas(gruposParaEstado);
    var porCiudad = contarActivasInactivasPorCiudad(gruposParaEstado, datosCache.infoVehiculos);
    // CAMBIO (2026-09-19): misma lógica para la Tendencia -- se calcula
    // sobre gruposParaTendencia (ignora CF.dia) para que el gráfico de
    // barras por día siga completo, con la barra elegida resaltada.
    var serieTemporal = construirSerieTemporal(gruposParaTendencia, datosCache.desde, datosCache.hasta);
    // CAMBIO: la comparación vs. periodo anterior solo se muestra sin
    // NINGÚN filtro cruzado activo -- un total filtrado de hoy contra un
    // total SIN filtrar de ayer no es una comparación válida (ver
    // obtenerTotalesPeriodo).
    var periodoAnteriorParaKpis = sinFiltrosActivos() ? datosCache.periodoAnterior : null;
    renderizarResultados(
      contenedorResultados, gruposParaResto, vehiculosOrdenadosParaResto, codigosOrdenados, estadoActivas,
      serieTemporal, periodoAnteriorParaKpis, porCiudad, catalogos, gruposParaSistemas, vehiculosParaGraficoTop
    );
  }

  function cargarYRenderizar(desde, hasta) {
    // Si ya hay una carga en vuelo, esta se ignora -- ver comentario junto a
    // la declaracion de cargaEnCurso.
    if (cargaEnCurso) return;
    cargaEnCurso = true;
    deshabilitarBotonesCarga();
    // Un rango de fechas nuevo trae un dataset distinto -- el drill-down de
    // sistema ya no aplica, y las claves de 'dia' (ej. "2026-09-07") son
    // específicas del rango anterior y no significan nada en el nuevo.
    // 'estado'/'ciudad'/'tipo'/'vehiculo'/'criticidad' sí pueden seguir
    // siendo válidos (se revalidan aparte, ver actualizarOpciones*).
    delete CF.sistema;
    delete CF.dia;

    mostrarCargando(contenedorResultados);

    // CAMBIO: periodo anterior = mismo tamaño de rango, justo antes de
    // "Desde" (ej. si el rango son 30 días, se compara contra los 30 días
    // inmediatamente anteriores). Si esta consulta falla, no se rompe el
    // dashboard -- simplemente no se muestran los indicadores de tendencia.
    var duracionMs = hasta.getTime() - desde.getTime();
    var desdeAnterior = new Date(desde.getTime() - duracionMs);
    var hastaAnterior = new Date(desde.getTime());
    var promesaPeriodoAnterior = obtenerTotalesPeriodo(desdeAnterior, hastaAnterior)
      .catch(function (err) { console.error('Dashboard fallas: no se pudo obtener el periodo anterior:', err); return null; });

    Promise.all([obtenerFaultDataPaginado(desde, hasta), obtenerCatalogosDiagnosticos(), promesaPeriodoAnterior])
      .then(function (resultados) {
        var registros = resultados[0];
        var catalogos = resultados[1];
        var periodoAnterior = resultados[2];
        var grupos = calcularEpisodiosPorGrupo(registros);
        var idsVehiculo = Array.from(new Set(grupos.map(function (g) { return g.idVehiculo; })));

        return obtenerInfoVehiculos(idsVehiculo).then(function (infoVehiculos) {
          datosCache = { grupos: grupos, infoVehiculos: infoVehiculos, catalogos: catalogos, desde: desde, hasta: hasta, periodoAnterior: periodoAnterior };

          var ciudadesDisponibles = Array.from(new Set(
            idsVehiculo.map(function (idVeh) { return infoVehiculos[idVeh] ? infoVehiculos[idVeh].ciudad : null; })
              .filter(function (c) { return !!c; })
          )).sort();
          if (elementos.actualizarOpcionesCiudad) elementos.actualizarOpcionesCiudad(ciudadesDisponibles);

          // CAMBIO: repuebla el dropdown de "Tipo de vehículo" con los tipos
          // reales que trajo esta consulta (mismo patrón que Ciudad).
          var tiposDisponibles = Array.from(new Set(
            idsVehiculo.map(function (idVeh) { return infoVehiculos[idVeh] ? infoVehiculos[idVeh].tipologia : null; })
              .filter(function (t) { return !!t; })
          )).sort();
          if (elementos.actualizarOpcionesTipo) elementos.actualizarOpcionesTipo(tiposDisponibles);

          // CAMBIO (2026-09-18): repuebla el selector de vehículo con lo que
          // trajo esta consulta (mismo patrón que Ciudad/Tipo).
          if (elementos.actualizarOpcionesVehiculo) elementos.actualizarOpcionesVehiculo(infoVehiculos);

          aplicarFiltrosYRenderizar();
        });
      })
      .catch(function (err) {
        console.error('Dashboard fallas:', err);
        mostrarError(contenedorResultados, (err && err.message) ? err.message : 'Error al consultar Geotab.');
      })
      .then(function () {
        cargaEnCurso = false;
        habilitarBotonesCarga();
      });
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi;
      state = freshState;

      contenedorPrincipal = document.getElementById('dashboardFallasRoot');
      aplicarEstilo(contenedorPrincipal, { fontFamily: T.font, background: T.color.canvas, padding: '4px' });

      var refs = construirEncabezado(contenedorPrincipal);
      elementos.inputDesde = refs.inputDesde;
      elementos.inputHasta = refs.inputHasta;
      elementos.botonFiltrar = refs.botonFiltrar;
      elementos.botonUltimos30 = refs.botonUltimos30;
      elementos.selectCiudad = refs.selectCiudad;
      elementos.actualizarOpcionesCiudad = refs.actualizarOpcionesCiudad;

      // CAMBIO: barra de filtros de tipo de vehículo + criticidad + limpiar.
      var refsFiltros = construirBarraFiltros(contenedorPrincipal);
      elementos.actualizarOpcionesTipo = refsFiltros.actualizarOpcionesTipo;
      elementos.actualizarOpcionesVehiculo = refsFiltros.actualizarOpcionesVehiculo;

      contenedorResultados = crear('div');
      contenedorPrincipal.appendChild(contenedorResultados);

      // CAMBIO (2026-09-19): cierra el tooltip de ayuda de criticidad al
      // hacer clic en cualquier otro lugar de la página (el propio botón
      // ya hace stopPropagation, así que un clic afuera siempre llega acá).
      document.addEventListener('click', function () {
        if (referenciaAyudaCriticidadAbierta) { referenciaAyudaCriticidadAbierta.style.display = 'none'; referenciaAyudaCriticidadAbierta = null; }
      });

      initializedCallback();
    },

    focus: function (freshApi, freshState) {
      api = freshApi;
      state = freshState;
      if (idIntervaloAutoRefresco) clearInterval(idIntervaloAutoRefresco);
      // El filtro de ciudad se conserva solo: cargarYRenderizar repuebla el
      // select con actualizarOpcionesCiudad, que mantiene la selección previa
      // si sigue siendo válida (mismo criterio que alertasFallas.js).
      idIntervaloAutoRefresco = setInterval(function () {
        cargarYRenderizar(new Date(elementos.inputDesde.value), new Date(elementos.inputHasta.value));
      }, INTERVALO_AUTO_REFRESCO_MS);
      cargarYRenderizar(new Date(elementos.inputDesde.value), new Date(elementos.inputHasta.value));
    },

    blur: function () {
      if (idIntervaloAutoRefresco) { clearInterval(idIntervaloAutoRefresco); idIntervaloAutoRefresco = null; }
    }
  };
};
