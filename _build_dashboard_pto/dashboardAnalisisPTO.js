/* ============================================================================
   Add-In: Análisis de Sobre-Revolución con PTO

   Objetivo: tablero HISTÓRICO/ANALÍTICO (KPIs, tendencia, Top vehículos,
   criticidad) sobre la regla "SOBRE REVOLUCIÓN CON PTO (L9-X12-OM 926-ISF 3.8)"
   -- distinto de "Sobre-Revolución con PTO" (sobreRevolucionPTO.js), que es el
   add-in OPERATIVO en vivo (auto-refresco 5-10 min, filtros de búsqueda
   puntual, cruce con tripulaciones para identificar al conductor). Mismo
   patrón que ya separa "Alertas por Severidad" (tiempo real) de "Dashboard de
   Análisis de Fallas" (histórico) en este ecosistema -- decisión tomada con
   el usuario 2026-09-17: conviven aparte, este no reemplaza al operativo.

   Reutiliza verbatim la lógica ya validada en sobreRevolucionPTO.js: cruce de
   PTO por cercanía (±3 min, el bit Engaged es un pulso de ~1.1s, no se puede
   exigir sostenido), pico real de RPM (±30s), y el umbral propio de 1500 RPM
   para Mercedes (motor OM926) aplicado en código después de que la regla ya
   disparó el candidato a 1300 -- la regla de Geotab no puede ramificar por
   marca dentro de una sola condición.
   ============================================================================ */

geotab.addin.dashboardAnalisisPTO = function () {
  'use strict';

  // --- Constantes ----------------------------------------------------------
  var NOMBRE_REGLA_PTO = 'SOBRE REVOLUCIÓN CON PTO (L9-X12-OM 926-ISF 3.8)';
  // CAMBIO (2026-10-03, auditoría): la regla se busca primero por ID -- el ID
  // no cambia si alguien renombra la regla en Geotab (así se perdió en
  // silencio la regla de ralentí L9 en el add-in de Operaciones). El nombre
  // queda solo como respaldo, por si la regla se borra y se recrea con ID nuevo.
  var ID_REGLA_PTO = 'aRowVAqEyfkWlRNW0D_1czA';
  var DURACION_MINIMA_SEG = 30;
  var ID_DIAGNOSTICO_PTO = 'DiagnosticPowerTakeoffEngagedId';
  var ID_DIAGNOSTICO_RPM = 'aW3Nmy-ktfEuvrdkya4z0yg'; // Velocidad del motor de alta resolución
  var VENTANA_PTO_MIN = 3;      // +/- minutos para confirmar pulso de PTO cercano
  var VENTANA_RPM_SEG = 30;     // +/- segundos para capturar el pico real de RPM
  var UMBRAL_RPM_MERCEDES = 1500; // motor OM926 -- ver comentario de cabecera
  // CAMBIO (2026-09-22): se elimina la persistencia del rango en localStorage
  // -- el usuario reportó una anomalía de carga lenta por "tantos datos
  // iniciales": si la última consulta manual había sido un rango grande
  // (ej. varios meses, vía "Analizar rango"), ESE rango quedaba guardado y
  // se recargaba automáticamente en la siguiente apertura del add-in,
  // disparando de nuevo el pipeline pesado (StatusData de RPM de alta
  // resolución + PTO por vehículo, DOS VECES -- rango actual y periodo
  // anterior). Pedido explícito: que SIEMPRE cargue con el rango rápido por
  // defecto (hoy 1 semana vs. la semana anterior) para que la apertura del
  // add-in sea rápida. El campo Desde/Hasta sigue editable para una consulta
  // puntual con "Analizar rango", pero ya no se recuerda entre sesiones.
  // CAMBIO (2026-09-17): bajado de 30 a 14 dias -- con el alcance nacional
  // (L9/T380 ya cubren toda la flota) y el RPM de alta resolucion, 30 dias
  // hacia el pipeline demasiado pesado (ver cambios/2026-09-17_fix-serverstopped-carga-inicial.md).
  // 14 dias reduce el volumen de datos a la mitad sin perder demasiado
  // contexto para detectar tendencia.
  // CAMBIO (2026-10-03, decisión del usuario tras la auditoría): bajado de 14
  // a 7 días. Medido con la API real: la vista de 2 semanas descargaba
  // ~1,6 GB de RPM de alta resolución (más otro tanto para el periodo
  // anterior), y eso causaba "Se agotó el tiempo de espera". Con 7 días el
  // volumen baja a la mitad sin tocar el cálculo de RPM pico. Un rango más
  // largo sigue disponible a mano con "Analizar rango".
  var DIAS_RANGO_POR_DEFECTO = 7;
  var TOP_N = 5;
  var INTERVALO_AUTO_REFRESCO_MS = 10 * 60 * 1000; // 10 min, igual al operativo
  // Mismo límite de página que herramientas/geotab_comun.py
  // (LIMITE_PAGINA_STATUSDATA) -- un Get de StatusData sin paginar corta la
  // respuesta en esta cantidad de filas. Se usa para DETECTAR truncamiento
  // en confirmarPtoCercano/agregarPicoRpm (ver cambio 2026-09-23).
  var LIMITE_PAGINA_STATUSDATA = 50000;

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

  // --- Sistema de diseño: misma paleta que el resto del ecosistema (dashboardAnalisisFallas.js) ---
  var T = {
    color: {
      primary: '#73B828', primaryDark: '#59901D', primarySoft: '#EAF4DF',
      ink: '#1A2235', body: '#475569', muted: '#88929A',
      surface: '#FFFFFF', canvas: '#F4F5F8', border: '#E5E9F0', borderStrong: '#CBD5E1',
      danger: '#B91C1C', dangerSoft: '#FEF2F2', dangerBorder: '#FCA5A5',
      textoOscuro: '#1F2937', textoGris: '#6B7280',
      alertaFondo: '#F7E8E8', alertaTexto: '#BA3B3B',
      medioFondo: '#FFFBEB', medioTexto: '#B45309'
    },
    radius: { sm: '8px', md: '12px', lg: '16px', pill: '999px' },
    shadow: { card: '0 1px 2px rgba(15,23,42,0.04), 0 1px 10px rgba(15,23,42,0.05)' },
    font: "'Inter', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
  };

  // --- Criticidad por vehículo (CENTRALIZADA) -------------------------------
  // Umbrales calibrados 2026-09-17 contra datos reales de la flota completa
  // (30 días, 50 vehículos con al menos 1 candidato de la regla): p25=21,
  // mediana=113, p75=573, p90=1032, máx=1927. CAMBIO PENDIENTE: esta
  // calibración usa candidatos CRUDOS (antes del cruce con PTO real), porque
  // confirmar los ~50 vehículos completos era demasiado lento para hacerlo en
  // el momento -- una vez que este dashboard acumule uso real, recalibrar
  // contra el conteo YA CONFIRMADO (eventos, no candidatos).
  var CRITICIDAD = {
    CRITICO: { nivel: 'Crítico', color: '#BA3B3B', orden: 4 },
    ALTO: { nivel: 'Alto', color: '#D97736', orden: 3 },
    MEDIO: { nivel: 'Medio', color: '#E5A93B', orden: 2 },
    BAJO: { nivel: 'Bajo', color: T.color.primary, orden: 1 }
  };
  var ORDEN_CRITICIDAD_LEYENDA = [CRITICIDAD.CRITICO, CRITICIDAD.ALTO, CRITICIDAD.MEDIO, CRITICIDAD.BAJO];

  function clasificarCriticidadVehiculo(eventos) {
    if (eventos >= 600) return CRITICIDAD.CRITICO;
    if (eventos >= 200) return CRITICIDAD.ALTO;
    if (eventos >= 50) return CRITICIDAD.MEDIO;
    return CRITICIDAD.BAJO;
  }

  var ICONO_POR_CRITICIDAD = { 'Crítico': '🔴', 'Alto': '🟠', 'Medio': '🟡', 'Bajo': '🟢' };

  var api = null;
  var state = null;
  var elementos = {};

  // --- Utilidades de estilo (CSSOM) -----------------------------------------
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

  // --- Utilidades de fecha ---------------------------------------------------
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

  // --- Envoltorios sobre la API de Geotab (callback -> Promise) -------------
  // CAMBIO (2026-10-02, bug real reportado por el usuario: "se queda pegado"
  // en "Analizando eventos..." sin ningún error en consola): api.call/
  // api.multiCall se envolvían en una Promise que solo se resuelve si Geotab
  // llama a resolve/reject -- si una solicitud se cuelga por sesión vencida o
  // un problema de red (puede pasar, no hay forma de evitarlo del todo), esa
  // Promise NUNCA se resuelve ni se rechaza, así que nunca llega al .catch()
  // del pipeline -- la pantalla queda pegada para siempre sin ningún aviso,
  // exactamente el síntoma reportado. conTimeout() le pone un tope: si una
  // llamada individual (ya acotada por lotes/chunks, nunca debería demorar
  // minutos en un escenario normal) no responde en TIMEOUT_LLAMADA_MS, se
  // rechaza con un mensaje claro -- así el usuario ve el error real y puede
  // reintentar, en vez de quedarse mirando "Analizando..." sin saber si
  // sigue corriendo o ya murió.
  var TIMEOUT_LLAMADA_MS = 45000;

  function conTimeout(promesaFn, descripcion) {
    return new Promise(function (resolve, reject) {
      var yaResuelto = false;
      var idTimeout = setTimeout(function () {
        if (yaResuelto) return;
        yaResuelto = true;
        reject(new Error('Se agotó el tiempo de espera consultando Geotab (' + descripcion + '). Puede ser un problema de sesión o de red -- vuelve a analizar el rango.'));
      }, TIMEOUT_LLAMADA_MS);
      promesaFn().then(function (r) {
        if (yaResuelto) return;
        yaResuelto = true;
        clearTimeout(idTimeout);
        resolve(r);
      }, function (e) {
        if (yaResuelto) return;
        yaResuelto = true;
        clearTimeout(idTimeout);
        reject(e);
      });
    });
  }

  function apiCall(metodo, params) {
    return conTimeout(function () {
      return new Promise(function (resolve, reject) { api.call(metodo, params, resolve, reject); });
    }, metodo);
  }

  // CAMBIO (2026-09-23, bug real "Unexpected end of JSON input"): un
  // multiCall con muchas llamadas de StatusData de alta resolución (RPM)
  // puede devolver una respuesta combinada TAN grande que la conexión la
  // corta a medias -- el JSON llega incompleto y falla al parsear, aunque
  // el NÚMERO de llamadas esté bien bajo el límite de 1000/min (ese es un
  // límite distinto, de cuota, no de tamaño de respuesta). Ahora
  // apiMultiCall parte listas grandes en LOTES secuenciales más chicos
  // (TAMANO_LOTE_MULTICALL) -- cada multiCall real que sale a la red queda
  // acotado, y los resultados se recomponen en el mismo orden que
  // 'llamadas' para que el resto del código (que indexa resultados[i] con
  // llamadas[i]) no note la diferencia.
  var TAMANO_LOTE_MULTICALL = 15;

  function apiMultiCall(llamadas) {
    if (llamadas.length === 0) return Promise.resolve([]);
    if (llamadas.length <= TAMANO_LOTE_MULTICALL) {
      return conTimeout(function () {
        return new Promise(function (resolve, reject) { api.multiCall(llamadas, resolve, reject); });
      }, 'multiCall, ' + llamadas.length + ' llamada(s)');
    }
    var lotes = [];
    for (var i = 0; i < llamadas.length; i += TAMANO_LOTE_MULTICALL) {
      lotes.push(llamadas.slice(i, i + TAMANO_LOTE_MULTICALL));
    }
    var resultados = [];
    return lotes.reduce(function (promesa, lote) {
      return promesa
        .then(function () {
          return conTimeout(function () {
            return new Promise(function (resolve, reject) { api.multiCall(lote, resolve, reject); });
          }, 'multiCall, lote de ' + lote.length);
        })
        .then(function (resultadosLote) { resultados = resultados.concat(resultadosLote); });
    }, Promise.resolve()).then(function () { return resultados; });
  }

  // --- Jerarquía de grupos de Geotab -> ciudad y marca ----------------------
  // Mismo bloque que ya usan sobreRevolucionPTO.js / dashboardAnalisisFallas.js
  // -- duplicación intencional ya documentada en CLAUDE.md.
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
    });
  }

  function resolverMarcaYTipologia(gruposVehiculo, mapaGrupos) {
    var marca = null, ciudad = 'Sin ciudad asignada', tipologia = null;
    (gruposVehiculo || []).forEach(function (g) {
      var gid = (g && g.id) ? g.id : g;
      var info = mapaGrupos[gid];
      if (!info) return;
      if (!marca && esGrupoMarca(info.nombre)) marca = info.nombre;
      if (info.ciudad && ciudad === 'Sin ciudad asignada') ciudad = info.ciudad;
      if (!tipologia && info.tipologia) tipologia = info.tipologia;
    });
    return { marca: marca || 'Sin marca', ciudad: ciudad, tipologia: tipologia || 'Sin tipología asignada' };
  }

  // --- Obtiene el id de la regla por nombre exacto --------------------------
  var idReglaCache = null;
  function obtenerIdRegla() {
    if (idReglaCache) return Promise.resolve(idReglaCache);
    return apiCall('Get', { typeName: 'Rule' }).then(function (reglas) {
      var objetivo = NOMBRE_REGLA_PTO.trim().toUpperCase();
      var encontrada = null;
      for (var i = 0; i < reglas.length; i++) {
        if (reglas[i].id === ID_REGLA_PTO) { encontrada = reglas[i]; break; }
      }
      for (var j = 0; !encontrada && j < reglas.length; j++) {
        var nombre = (reglas[j].name || '').trim().toUpperCase();
        if (nombre === objetivo) { encontrada = reglas[j]; break; }
      }
      if (!encontrada) throw new Error("No se encontró la regla '" + NOMBRE_REGLA_PTO + "' (id " + ID_REGLA_PTO + ") en Geotab.");
      idReglaCache = encontrada.id;
      return idReglaCache;
    });
  }

  // --- Trae ExceptionEvent de la regla en el rango, filtra por duración mínima ---
  function obtenerEventosCandidatos(idRegla, desdeUtc, hastaUtc) {
    return apiCall('Get', {
      typeName: 'ExceptionEvent',
      search: { ruleSearch: { id: idRegla }, fromDate: desdeUtc.toISOString(), toDate: hastaUtc.toISOString() }
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
        candidatos.push({ idVehiculo: idVeh, activeFrom: desde, activeTo: hasta, duracionSeg: duracionSeg });
      });
      return candidatos;
    });
  }

  // Ventanas de chunk seguras para el fallback anti-truncamiento de ÚLTIMO
  // RECURSO (ver más abajo): calibradas contra el peor caso observado el
  // 2026-09-23 (1159-NWY131 -- 18h de RPM de alta resolución ya llenaban
  // 50,000 filas, ~2,778 filas/hora). 8h para RPM deja margen amplio
  // incluso para un vehículo más activo que ese; PTO es un pulso mucho
  // menos denso, así que su chunk puede ser más ancho sin riesgo.
  var VENTANA_CHUNK_RPM_MS = 8 * 60 * 60 * 1000;
  var VENTANA_CHUNK_PTO_MS = 24 * 60 * 60 * 1000;

  function construirLlamadasPorChunks(idVeh, diagnosticId, desde, hasta, chunkMs) {
    var llamadas = [];
    var cursor = desde.getTime();
    var finTotal = hasta.getTime();
    while (cursor < finTotal) {
      var finChunk = Math.min(cursor + chunkMs, finTotal);
      llamadas.push(['Get', {
        typeName: 'StatusData',
        search: { diagnosticSearch: { id: diagnosticId }, deviceSearch: { id: idVeh }, fromDate: new Date(cursor).toISOString(), toDate: new Date(finChunk).toISOString() }
      }]);
      cursor = finChunk;
    }
    return llamadas;
  }

  // CAMBIO (2026-09-23, bug real "API calls quota exceeded" -- TERCERA
  // corrección del mismo problema, esta vez con números reales medidos):
  // la agrupación por cercanía (2do intento) generaba 765 llamadas SOLO
  // para confirmarPtoCercano (medido con datos reales: 47 vehículos, 7910
  // candidatos en 2 semanas) -- ya por sí sola casi al límite antes de
  // sumar agregarPicoRpm ni el periodo anterior.
  //
  // Se investigó la densidad REAL de cada diagnóstico por separado: el
  // pulso de PTO (`DiagnosticPowerTakeoffEngagedId`) es MUCHO menos denso
  // de lo asumido -- el vehículo más activo de la flota (b532, 760
  // candidatos en 2 semanas) solo tiene 10,806 filas de PTO en las 2
  // semanas COMPLETAS (sin acotar por candidatos), muy por debajo del
  // límite de página de 50,000. confirmarPtoCercano NUNCA necesita
  // agrupación -- vuelve a una sola ventana [min,max] por vehículo (~47
  // llamadas totales, verificado seguro con datos reales).
  //
  // El RPM de alta resolución sí es denso (confirmado: 18h de un solo
  // vehículo ya llenan 50,000 filas) -- agregarPicoRpm SÍ necesita
  // agrupación por cercanía temporal, con un TOPE de crecimiento por racha
  // (VENTANA_TOPE_RACHA_MS) para no terminar reconstruyendo sin querer la
  // misma ventana gigante que se intentaba evitar cuando un vehículo tiene
  // actividad casi continua.
  function agruparPorCercania(itemsOrdenadosPorInicio, maxGapMs, maxSpanMs) {
    var grupos = [];
    itemsOrdenadosPorInicio.forEach(function (item) {
      var inicio = item.activeFrom.getTime();
      var fin = item.activeTo.getTime();
      var ultimo = grupos.length ? grupos[grupos.length - 1] : null;
      if (ultimo) {
        var finPropuesto = Math.max(ultimo.fin, fin);
        if (inicio - ultimo.fin <= maxGapMs && (finPropuesto - ultimo.inicio) <= maxSpanMs) {
          ultimo.fin = finPropuesto;
          return;
        }
      }
      grupos.push({ inicio: inicio, fin: fin });
    });
    return grupos;
  }

  // Arma, para cada vehículo, la lista de ventanas a consultar -- función
  // compartida entre confirmarPtoCercano (maxGapMs/maxSpanMs = Infinity,
  // o sea SIEMPRE una sola ventana [min,max] por vehículo, igual que
  // antes de introducir agrupación) y agregarPicoRpm (con agrupación real).
  function construirVentanasPorVehiculo(itemsPorVehiculo, toleranciaMs, maxGapMs, maxSpanMs) {
    var resultado = {};
    Object.keys(itemsPorVehiculo).forEach(function (idVeh) {
      var ordenados = itemsPorVehiculo[idVeh].slice().sort(function (a, b) { return a.activeFrom - b.activeFrom; });
      var grupos = agruparPorCercania(ordenados, maxGapMs, maxSpanMs);
      resultado[idVeh] = grupos.map(function (g) {
        return { desde: new Date(g.inicio - toleranciaMs), hasta: new Date(g.fin + toleranciaMs) };
      });
    });
    return resultado;
  }

  // Solo agregarPicoRpm usa estos -- ver comentario de cabecera arriba.
  var VENTANA_AGRUPACION_RPM_MS = 12 * 60 * 60 * 1000; // 12h de hueco funde dos rachas en una
  var VENTANA_TOPE_RACHA_RPM_MS = 20 * 60 * 60 * 1000; // una racha nunca crece mas de 20h

  // Ejecuta una consulta de StatusData por CADA ventana de CADA vehículo (en
  // un único multiCall), agrupa los resultados de vuelta por vehículo, y
  // aplica el chunk-fallback de último recurso sobre cualquier ventana
  // individual que aun así venga truncada. Devuelve un objeto
  // {idVehiculo: [lecturas crudas]} listo para que cada función lo
  // interprete a su manera (pulsos de PTO vs. picos de RPM).
  function consultarStatusDataAgrupado(ventanasPorVehiculo, diagnosticId, chunkMsFallback) {
    var llamadas = [];
    var idVehPorLlamada = [];
    var ventanaPorLlamada = [];
    Object.keys(ventanasPorVehiculo).forEach(function (idVeh) {
      ventanasPorVehiculo[idVeh].forEach(function (v) {
        llamadas.push(['Get', {
          typeName: 'StatusData',
          search: { diagnosticSearch: { id: diagnosticId }, deviceSearch: { id: idVeh }, fromDate: v.desde.toISOString(), toDate: v.hasta.toISOString() }
        }]);
        idVehPorLlamada.push(idVeh);
        ventanaPorLlamada.push(v);
      });
    });

    if (llamadas.length === 0) return Promise.resolve({});

    return apiMultiCall(llamadas).then(function (resultados) {
      var lecturasPorVehiculo = {};
      var llamadasTruncadas = []; // {idVeh, ventana}
      resultados.forEach(function (lecturas, i) {
        var idVeh = idVehPorLlamada[i];
        if (!lecturasPorVehiculo[idVeh]) lecturasPorVehiculo[idVeh] = [];
        if ((lecturas || []).length >= LIMITE_PAGINA_STATUSDATA) {
          // Se descarta el resultado truncado de ESTA ventana puntual --
          // se reemplaza por los chunks de abajo, no se suma (evita
          // duplicados).
          llamadasTruncadas.push({ idVeh: idVeh, ventana: ventanaPorLlamada[i] });
        } else {
          lecturasPorVehiculo[idVeh] = lecturasPorVehiculo[idVeh].concat(lecturas || []);
        }
      });

      if (llamadasTruncadas.length === 0) return lecturasPorVehiculo;

      var llamadasChunk = [];
      var idVehPorLlamadaChunk = [];
      llamadasTruncadas.forEach(function (t) {
        construirLlamadasPorChunks(t.idVeh, diagnosticId, t.ventana.desde, t.ventana.hasta, chunkMsFallback).forEach(function (llamada) {
          llamadasChunk.push(llamada);
          idVehPorLlamadaChunk.push(t.idVeh);
        });
      });

      return apiMultiCall(llamadasChunk).then(function (resultadosChunk) {
        resultadosChunk.forEach(function (lecturas, i) {
          var idVeh = idVehPorLlamadaChunk[i];
          lecturasPorVehiculo[idVeh] = lecturasPorVehiculo[idVeh].concat(lecturas || []);
        });
        return lecturasPorVehiculo;
      });
    });
  }

  // --- Confirma PTO cercano (±VENTANA_PTO_MIN) para cada candidato ----------
  // Mismo criterio que sobreRevolucionPTO.js / telegram_alertas.py: el PTO es
  // un pulso, no se puede exigir sostenido, solo que haya aparecido cerca.
  function confirmarPtoCercano(candidatos) {
    if (candidatos.length === 0) return Promise.resolve([]);

    var candidatosPorVehiculo = {};
    candidatos.forEach(function (c) {
      if (!candidatosPorVehiculo[c.idVehiculo]) candidatosPorVehiculo[c.idVehiculo] = [];
      candidatosPorVehiculo[c.idVehiculo].push(c);
    });
    // Infinity/Infinity: siempre una sola ventana [min,max] por vehículo --
    // el PTO nunca es denso (ver comentario de cabecera), no hace falta
    // agrupar por rachas.
    var ventanasPorVehiculo = construirVentanasPorVehiculo(candidatosPorVehiculo, VENTANA_PTO_MIN * 60000, Infinity, Infinity);

    return consultarStatusDataAgrupado(ventanasPorVehiculo, ID_DIAGNOSTICO_PTO, VENTANA_CHUNK_PTO_MS).then(function (lecturasPorVehiculo) {
      var pulsosPorVehiculo = {};
      Object.keys(lecturasPorVehiculo).forEach(function (idVeh) {
        pulsosPorVehiculo[idVeh] = lecturasPorVehiculo[idVeh]
          .filter(function (l) { return parseFloat(l.data) > 0; })
          .map(function (l) { return new Date(l.dateTime); });
      });
      return candidatos.filter(function (c) {
        var desde = new Date(c.activeFrom.getTime() - VENTANA_PTO_MIN * 60000);
        var hasta = new Date(c.activeTo.getTime() + VENTANA_PTO_MIN * 60000);
        var pulsos = (pulsosPorVehiculo[c.idVehiculo] || []).filter(function (p) { return p >= desde && p <= hasta; });
        return pulsos.length > 0;
      });
    });
  }

  // --- Agrega el pico de RPM (±VENTANA_RPM_SEG) a cada evento confirmado ----
  // Este es el más pesado de los dos (confirmarPtoCercano/agregarPicoRpm)
  // -- RPM de alta resolución reporta con mucha más frecuencia que el
  // pulso de PTO. Ver el comentario de cabecera junto a
  // construirVentanasPorVehiculo/consultarStatusDataAgrupado para el
  // historial completo de este bug (N/D en RPM pico -> ventana truncada
  // -> fallback por evento -> cuota de API excedida -> agrupación por
  // cercanía temporal).
  function agregarPicoRpm(eventosConfirmados) {
    if (eventosConfirmados.length === 0) return Promise.resolve(eventosConfirmados);

    var eventosPorVehiculo = {};
    eventosConfirmados.forEach(function (c) {
      if (!eventosPorVehiculo[c.idVehiculo]) eventosPorVehiculo[c.idVehiculo] = [];
      eventosPorVehiculo[c.idVehiculo].push(c);
    });
    var ventanasPorVehiculo = construirVentanasPorVehiculo(eventosPorVehiculo, VENTANA_RPM_SEG * 1000, VENTANA_AGRUPACION_RPM_MS, VENTANA_TOPE_RACHA_RPM_MS);

    return consultarStatusDataAgrupado(ventanasPorVehiculo, ID_DIAGNOSTICO_RPM, VENTANA_CHUNK_RPM_MS).then(function (lecturasCrudasPorVehiculo) {
      var lecturasPorVehiculo = {};
      Object.keys(lecturasCrudasPorVehiculo).forEach(function (idVeh) {
        lecturasPorVehiculo[idVeh] = lecturasCrudasPorVehiculo[idVeh].map(function (l) {
          return { t: new Date(l.dateTime), v: parseFloat(l.data) };
        });
      });
      eventosConfirmados.forEach(function (c) {
        var desde = new Date(c.activeFrom.getTime() - VENTANA_RPM_SEG * 1000);
        var hasta = new Date(c.activeTo.getTime() + VENTANA_RPM_SEG * 1000);
        var lecturas = (lecturasPorVehiculo[c.idVehiculo] || []).filter(function (l) { return l.t >= desde && l.t <= hasta; });
        c.rpmPico = lecturas.length ? Math.max.apply(null, lecturas.map(function (l) { return l.v; })) : null;
      });
      return eventosConfirmados;
    });
  }

  // --- Enriquecimiento: nombre/placa/ciudad/marca por vehículo --------------
  // CAMBIO (2026-09-23, bug real "API calls quota exceeded"): antes pedía
  // UN Device Get POR VEHÍCULO (una llamada por cada uno de los ~47 en
  // alcance) -- ahora es UNA sola llamada 'Get Device' sin filtro (trae
  // toda la flota, es un catálogo liviano) y se filtra/indexa en memoria.
  // Reduce ~47 llamadas a 1 en este paso, sin cambiar el resultado.
  var catalogoDeviceCache = null;
  function obtenerCatalogoDevice() {
    if (catalogoDeviceCache) return Promise.resolve(catalogoDeviceCache);
    return apiCall('Get', { typeName: 'Device' }).then(function (devices) {
      var porId = {};
      (devices || []).forEach(function (d) { if (d && d.id) porId[d.id] = d; });
      catalogoDeviceCache = porId;
      return porId;
    });
  }

  function obtenerInfoVehiculos(idsVehiculo) {
    if (idsVehiculo.length === 0) return Promise.resolve({});
    return Promise.all([obtenerCatalogoDevice(), obtenerMapaGrupos()]).then(function (resultados) {
      var catalogoDevice = resultados[0];
      var mapaGrupos = resultados[1];
      var info = {};
      idsVehiculo.forEach(function (idVeh) {
        var dev = catalogoDevice[idVeh];
        var mt = resolverMarcaYTipologia(dev ? dev.groups : null, mapaGrupos);
        info[idVeh] = {
          nombre: dev ? (dev.name || idVeh) : idVeh,
          placa: dev ? (dev.licensePlate || '') : '',
          marca: mt.marca, ciudad: mt.ciudad, tipologia: mt.tipologia,
          referenciaMotor: referenciaMotorDeMarca(mt.marca)
        };
        info[idVeh].claveVehiculo = info[idVeh].nombre + (info[idVeh].placa ? ' - ' + info[idVeh].placa : '');
      });
      return info;
    });
  }

  function resolverVehiculos(eventosConfirmados) {
    var idsVehiculo = Array.from(new Set(eventosConfirmados.map(function (e) { return e.idVehiculo; })));
    return obtenerInfoVehiculos(idsVehiculo).then(function (infoVehiculos) {
      eventosConfirmados.forEach(function (e) {
        var info = infoVehiculos[e.idVehiculo] || { claveVehiculo: e.idVehiculo, ciudad: 'Sin ciudad asignada', tipologia: 'Sin tipología asignada', marca: 'Sin marca', referenciaMotor: 'Desconocido' };
        e.claveVehiculo = info.claveVehiculo; e.ciudad = info.ciudad; e.tipologia = info.tipologia;
        e.marca = info.marca; e.referenciaMotor = info.referenciaMotor;
      });
      return { eventos: eventosConfirmados, infoVehiculos: infoVehiculos };
    });
  }

  // --- Filtro de marca: Mercedes (OM926) exige 1500 RPM real, ver cabecera ---
  function filtrarPorUmbralMercedes(resultado) {
    var filtrados = resultado.eventos.filter(function (e) {
      var marca = (e.marca || '').toLowerCase();
      if (marca.indexOf('mercedes') !== -1 && e.rpmPico !== null && e.rpmPico < UMBRAL_RPM_MERCEDES) return false;
      return true;
    });
    return { eventos: filtrados, infoVehiculos: resultado.infoVehiculos };
  }

  // --- Agregaciones ----------------------------------------------------------
  function agregarPorVehiculo(eventos) {
    var porVehiculo = {};
    eventos.forEach(function (e) {
      if (!porVehiculo[e.idVehiculo]) {
        porVehiculo[e.idVehiculo] = {
          idVehiculo: e.idVehiculo, claveVehiculo: e.claveVehiculo, ciudad: e.ciudad, tipologia: e.tipologia,
          marca: e.marca, referenciaMotor: e.referenciaMotor,
          eventos: 0, duracionTotalSeg: 0, rpmPicoMax: null, ultimaFecha: e.activeFrom
        };
      }
      var acc = porVehiculo[e.idVehiculo];
      acc.eventos += 1;
      acc.duracionTotalSeg += e.duracionSeg;
      if (e.rpmPico !== null && (acc.rpmPicoMax === null || e.rpmPico > acc.rpmPicoMax)) acc.rpmPicoMax = e.rpmPico;
      if (e.activeFrom > acc.ultimaFecha) acc.ultimaFecha = e.activeFrom;
    });

    var lista = Object.keys(porVehiculo).map(function (idVeh) {
      var acc = porVehiculo[idVeh];
      var criticidad = clasificarCriticidadVehiculo(acc.eventos);
      acc.criticidad = criticidad.nivel; acc.colorCriticidad = criticidad.color; acc.ordenCriticidad = criticidad.orden;
      return acc;
    });

    lista.sort(function (a, b) {
      if (b.ordenCriticidad !== a.ordenCriticidad) return b.ordenCriticidad - a.ordenCriticidad;
      return b.eventos - a.eventos;
    });
    return lista;
  }

  // --- Serie temporal: eventos por día (o por semana si el rango es largo) ---
  // CAMBIO (2026-09-22, cross-filter): claveBalde/etiquetaBalde se extraen a
  // funciones de módulo (resolverPorSemana/resolverClaveBalde/etiquetaClaveBalde)
  // -- ya no viven solo dentro de esta función -- porque ahora también las usa
  // eventoPasaClave('dia', ...) para decidir si un evento individual cae en un
  // balde elegido por clic. Mismo patrón que dashboardAnalisisFallas.js.
  function resolverPorSemana(desde, hasta) {
    var diasRango = Math.max(1, Math.round((hasta - desde) / (24 * 60 * 60 * 1000)));
    return diasRango > 60;
  }

  function resolverClaveBalde(fecha, porSemana) {
    if (!porSemana) return fecha.getFullYear() + '-' + String(fecha.getMonth() + 1).padStart(2, '0') + '-' + String(fecha.getDate()).padStart(2, '0');
    var inicioSemana = new Date(fecha);
    inicioSemana.setDate(fecha.getDate() - fecha.getDay());
    return inicioSemana.getFullYear() + '-' + String(inicioSemana.getMonth() + 1).padStart(2, '0') + '-' + String(inicioSemana.getDate()).padStart(2, '0');
  }

  function etiquetaClaveBalde(claveBalde, porSemana) {
    var partes = claveBalde.split('-').map(Number);
    var fechaBalde = new Date(partes[0], partes[1] - 1, partes[2]);
    if (porSemana) return 'Semana del ' + fechaBalde.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
    var dia = fechaBalde.toLocaleDateString('es-CO', { weekday: 'short' });
    dia = dia.charAt(0).toUpperCase() + dia.slice(1).replace('.', '');
    return dia + ' ' + fechaBalde.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
  }

  function construirSerieTemporal(eventos, desde, hasta) {
    var porSemana = resolverPorSemana(desde, hasta);

    var conteos = {};
    eventos.forEach(function (e) { var k = resolverClaveBalde(e.activeFrom, porSemana); conteos[k] = (conteos[k] || 0) + 1; });

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
      claves: baldes.map(function (b) { return b.clave; }),
      porSemana: porSemana
    };
  }

  // --- Totales de un periodo (para comparación "vs. periodo anterior") ------
  // CAMBIO (2026-09-23, bug real "API calls quota exceeded"): antes corría
  // el pipeline COMPLETO (confirmarPtoCercano + agregarPicoRpm +
  // resolverVehiculos + filtrarPorUmbralMercedes) solo para sacar 2 números
  // (total de eventos, vehículos afectados) -- agregarPicoRpm es la
  // consulta más pesada del dashboard (RPM de alta resolución) y acá su
  // resultado ni se usaba para nada más que decidir el filtro de Mercedes.
  // Ahora se omite agregarPicoRpm/resolverVehiculos: se acepta que un
  // candidato de Mercedes por debajo de 1500 RPM real puede colarse en ESTE
  // total comparativo (nunca en los datos que se muestran/tabulan, solo en
  // la flecha de tendencia ▲▼ de los KPIs) -- de todas formas la ligera
  // sobreestimación afecta igual a ambos periodos comparados, así que la
  // dirección de la tendencia sigue siendo confiable.
  function obtenerTotalesPeriodo(desde, hasta) {
    return obtenerIdRegla()
      .then(function (idRegla) { return obtenerEventosCandidatos(idRegla, desde, hasta); })
      .then(confirmarPtoCercano)
      .then(function (eventos) {
        return {
          totalEventos: eventos.length,
          vehiculosAfectados: Array.from(new Set(eventos.map(function (e) { return e.idVehiculo; }))).length
        };
      });
  }

  // --- Render: resumen narrativo gerencial ----------------------------------
  function descripcionFiltroCriticidad() {
    var activas = CF.criticidad || [];
    return activas.length === 1 ? ' con criticidad ' + activas[0] : '';
  }

  function construirResumenNarrativo(contenedor, eventos, vehiculosOrdenados, periodoAnterior) {
    var totalEventos = eventos.length;
    var criticos = vehiculosOrdenados.filter(function (v) { return v.criticidad === CRITICIDAD.CRITICO.nivel; }).length;

    var lineas = [];
    if (vehiculosOrdenados.length === 0) {
      lineas.push({ icono: '✅', texto: 'No se registraron eventos de sobre-revolución con PTO' + descripcionFiltroCriticidad() + ' en el rango seleccionado.', color: T.color.primaryDark });
    } else if (criticos === 0) {
      lineas.push({ icono: '🟢', texto: 'Ningún vehículo en estado crítico — situación bajo control.', color: T.color.primaryDark });
    } else {
      lineas.push({ icono: '🔴', texto: criticos + ' vehículo' + (criticos === 1 ? '' : 's') + ' en estado crítico' + (criticos === 1 ? ' requiere' : ' requieren') + ' atención inmediata.', color: T.color.alertaTexto });
    }

    if (periodoAnterior) {
      var anterior = periodoAnterior.totalEventos;
      if (totalEventos === anterior) {
        lineas.push({ icono: '▬', texto: 'El nivel de sobre-revolución se mantiene igual que en el periodo anterior.', color: T.color.muted });
      } else {
        var subio = totalEventos > anterior;
        var cambioPct = anterior === 0 ? 100 : Math.round(((totalEventos - anterior) / anterior) * 100);
        lineas.push({
          icono: subio ? '▲' : '▼',
          texto: 'Los eventos ' + (subio ? 'aumentaron' : 'bajaron') + ' ' + Math.abs(cambioPct) + '% frente al periodo anterior' + (subio ? '.' : ' — la gestión está funcionando.'),
          color: subio ? T.color.alertaTexto : T.color.primaryDark
        });
      }
    }

    if (vehiculosOrdenados.length > 0) {
      var top = vehiculosOrdenados[0];
      lineas.push({ icono: '🔁', texto: 'El vehículo con más eventos es "' + top.claveVehiculo + '" (' + top.eventos + ' eventos, ' + formatearDuracionTotal(top.duracionTotalSeg) + ' acumulados).', color: T.color.ink });
    }

    var colorBorde = criticos > 0 ? T.color.alertaTexto : T.color.primary;
    var panel = crearPanel({ padding: '16px 18px', marginBottom: '16px', borderLeft: '4px solid ' + colorBorde, display: 'flex', flexDirection: 'column', gap: '8px' });
    panel.appendChild(crear('div', { fontSize: '0.72rem', fontWeight: '800', color: T.color.textoGris, textTransform: 'uppercase', letterSpacing: '0.03em' }, '📌 Resumen'));
    lineas.forEach(function (linea) {
      var fila = crear('div', { display: 'flex', alignItems: 'flex-start', gap: '8px' });
      fila.appendChild(crear('span', { fontSize: '0.95rem', lineHeight: '1.4' }, linea.icono));
      fila.appendChild(crear('span', { fontSize: '0.92rem', fontWeight: '600', color: linea.color, lineHeight: '1.4' }, linea.texto));
      panel.appendChild(fila);
    });
    contenedor.appendChild(panel);
  }

  // --- Render: KPIs ------------------------------------------------------------
  function formatearDuracionTotal(segundos) {
    var minTotal = Math.round(segundos / 60);
    var h = Math.floor(minTotal / 60);
    var m = minTotal % 60;
    return h > 0 ? (h + 'h ' + m + 'min') : (m + ' min');
  }

  // CAMBIO (2026-09-23, pedido explícito: "falta poder seleccionar... quien
  // fue el campeón de sobre revolución"): la tarjeta KPI ahora acepta un
  // 'alHacerClic' opcional -- cuando viene, la tarjeta queda clicable
  // (cursor + resaltado si ya es el vehículo elegido en CF.vehiculo) y
  // dispara ese callback. Se usa en la tarjeta "Más reincidente" para
  // filtrar por ese vehículo con un solo clic, mismo CF.vehiculo que ya
  // escriben el buscador, la fila de la tabla y el gráfico de Top vehículos.
  function crearTarjetaKpi(icono, valor, etiqueta, nodoTendencia, alHacerClic, elegido) {
    var estilo = { padding: '12px 14px', flex: '1 1 170px', minWidth: '160px', display: 'flex', alignItems: 'center', gap: '10px' };
    if (alHacerClic) {
      estilo.cursor = 'pointer';
      if (elegido) { estilo.background = T.color.primarySoft; estilo.border = '1px solid ' + T.color.primary; }
    }
    var tarjeta = crearPanel(estilo);
    if (alHacerClic) {
      tarjeta.title = 'Clic para filtrar por este vehículo';
      tarjeta.addEventListener('click', alHacerClic);
    }
    tarjeta.appendChild(crearChipMarca(icono, '38px'));
    var bloque = crear('div', { minWidth: '0' });
    bloque.appendChild(crear('div', { fontSize: '1.35rem', fontWeight: '800', color: T.color.ink, lineHeight: '1.1' }, String(valor)));
    bloque.appendChild(crear('div', { fontSize: '0.7rem', color: T.color.textoGris, fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.02em' }, etiqueta));
    if (nodoTendencia) bloque.appendChild(nodoTendencia);
    tarjeta.appendChild(bloque);
    return tarjeta;
  }

  function crearIndicadorTendencia(actual, anterior, subeEsMalo) {
    if (anterior === null || anterior === undefined) return null;
    if (actual === anterior) return crear('div', { fontSize: '0.68rem', color: T.color.muted, marginTop: '2px' }, '▬ sin cambios vs. periodo anterior');
    var subio = actual > anterior;
    var esMalo = subio ? subeEsMalo : !subeEsMalo;
    var cambioPct = anterior === 0 ? 100 : Math.round(((actual - anterior) / anterior) * 100);
    var color = esMalo ? CRITICIDAD.CRITICO.color : T.color.primaryDark;
    return crear('div', { fontSize: '0.68rem', fontWeight: '700', color: color, marginTop: '2px' }, (subio ? '▲ ' : '▼ ') + Math.abs(cambioPct) + '% vs. periodo anterior');
  }

  function construirKpis(contenedor, eventos, vehiculosOrdenados, periodoAnterior) {
    var fila = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' });

    var duracionTotalSeg = eventos.reduce(function (s, e) { return s + e.duracionSeg; }, 0);
    var rpmPicoMax = null;
    eventos.forEach(function (e) { if (e.rpmPico !== null && (rpmPicoMax === null || e.rpmPico > rpmPicoMax)) rpmPicoMax = e.rpmPico; });

    fila.appendChild(crearTarjetaKpi('📋', eventos.length, 'Eventos con PTO confirmado', periodoAnterior && crearIndicadorTendencia(eventos.length, periodoAnterior.totalEventos, true)));
    fila.appendChild(crearTarjetaKpi('🚚', vehiculosOrdenados.length, 'Vehículos afectados', periodoAnterior && crearIndicadorTendencia(vehiculosOrdenados.length, periodoAnterior.vehiculosAfectados, true)));
    fila.appendChild(crearTarjetaKpi('⚡', rpmPicoMax !== null ? rpmPicoMax.toFixed(0) : 'N/D', 'RPM pico máximo'));
    fila.appendChild(crearTarjetaKpi('⏱️', formatearDuracionTotal(duracionTotalSeg), 'Tiempo total en sobre-revolución'));
    if (vehiculosOrdenados.length > 0) {
      var top = vehiculosOrdenados[0];
      var vehiculosSeleccionados = CF.vehiculo || [];
      fila.appendChild(crearTarjetaKpi(
        '🔁', top.eventos, 'Más reincidente: ' + top.claveVehiculo, null,
        function () { cfToggle('vehiculo', top.idVehiculo); },
        vehiculosSeleccionados.indexOf(top.idVehiculo) !== -1
      ));
    }
    contenedor.appendChild(fila);

    // CAMBIO (2026-09-23, carga progresiva): mientras el periodo anterior
    // todavía se está trayendo en segundo plano (ver cargarYRenderizar), se
    // avisa que las flechas de tendencia van a aparecer en un momento --
    // sin esto, la ausencia de flechas se podría leer como "sin datos
    // suficientes" en vez de "todavía cargando".
    if (datosCache.periodoAnteriorCargando && sinFiltrosActivos()) {
      contenedor.appendChild(crear('div', {
        fontSize: '0.72rem', color: T.color.muted, marginBottom: '16px'
      }, '⏳ Calculando comparación con el periodo anterior…'));
    }
  }

  // --- Render: leyenda de criticidad y estado vacío -------------------------
  function crearLeyendaCriticidad() {
    var fila = crear('div', { display: 'flex', gap: '10px', flexWrap: 'wrap', margin: '4px 0 10px 0' });
    ORDEN_CRITICIDAD_LEYENDA.forEach(function (c) {
      var item = crear('div', { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.72rem', color: T.color.body });
      item.appendChild(crear('span', { width: '8px', height: '8px', borderRadius: '50%', background: c.color, display: 'inline-block' }));
      item.appendChild(crear('span', {}, c.nivel));
      fila.appendChild(item);
    });
    return fila;
  }

  function crearEstadoVacioGrafico(mensaje) {
    var envoltorio = crear('div', {
      position: 'absolute', top: '0', left: '0', right: '0', bottom: '0',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px'
    });
    envoltorio.appendChild(crear('div', { color: T.color.muted, fontSize: '0.82rem', textAlign: 'center', maxWidth: '320px' }, mensaje));
    return envoltorio;
  }

  // --- Render: gráfico de barras horizontales — Top vehículos ---------------
  // CAMBIO (2026-09-22, cross-filter): clicable -- mismo lenguaje que
  // dashboardAnalisisFallas.js (barra elegida en color sólido, resto
  // atenuado; clic vuelve a sumar/quitar de CF.vehiculo). Recibe
  // 'vehiculosOrdenados' YA calculado ignorando CF.vehiculo (ver
  // eventosParaDimension('vehiculo') en aplicarFiltrosYRenderizar), para
  // seguir mostrando el panorama completo del Top N aunque haya un vehículo
  // elegido -- la tabla de abajo sí colapsa al filtro, este gráfico no.
  var chartTopVehiculos = null;
  function construirGraficoBarras(canvas, vehiculosOrdenados) {
    if (vehiculosOrdenados.length === 0) return false;
    var top = vehiculosOrdenados.slice(0, TOP_N);
    var vehiculosSeleccionados = CF.vehiculo || [];
    if (chartTopVehiculos) chartTopVehiculos.destroy();
    chartTopVehiculos = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: top.map(function (v) { return ICONO_POR_CRITICIDAD[v.criticidad] + ' ' + v.claveVehiculo; }),
        datasets: [{
          label: 'Eventos',
          data: top.map(function (v) { return v.eventos; }),
          backgroundColor: top.map(function (v) {
            if (!vehiculosSeleccionados.length) return v.colorCriticidad;
            return vehiculosSeleccionados.indexOf(v.idVehiculo) !== -1 ? v.colorCriticidad : v.colorCriticidad + '4D';
          }),
          borderRadius: 4, barThickness: 18
        }]
      },
      options: {
        indexAxis: 'y', maintainAspectRatio: false,
        onClick: function (evt, elementosClic) {
          if (!elementosClic || elementosClic.length === 0) return;
          cfToggle('vehiculo', top[elementosClic[0].index].idVehiculo);
        },
        onHover: function (evt, elementosHover) {
          if (evt.native && evt.native.target) evt.native.target.style.cursor = elementosHover.length ? 'pointer' : 'default';
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: function (ctx) { return [ctx.parsed.x + ' eventos', 'Clic para filtrar por este vehículo']; } } }
        },
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    });
    return true;
  }

  // --- Render: gráfico de tendencia — eventos en el tiempo -------------------
  // CAMBIO (2026-09-22, cross-filter): las barras pasaron a ser clicables
  // (mismo criterio que dashboardAnalisisFallas.js -- una línea sola no
  // tiene "elementos" discretos que resaltar/clicar por balde). Clic
  // suma/quita ese día/semana de CF.dia (OR, se pueden elegir varios).
  // CAMBIO (2026-09-23, bug real: el usuario reportó que la línea de
  // tendencia ya no se veía): al pasar de línea a barras se perdió la línea
  // -- debía ser un gráfico MIXTO (barras + línea de media móvil encima),
  // igual que dashboardAnalisisFallas.js, no un reemplazo. Se restaura el
  // dataset de línea (promedio móvil) superpuesto a las barras clicables.
  var chartTendencia = null;
  function construirGraficoTendencia(canvas, serie, nota) {
    var totalEventos = serie.valores.reduce(function (s, v) { return s + v; }, 0);
    if (serie.etiquetas.length === 0 || totalEventos === 0) {
      if (nota) nota.style.display = 'none';
      return false;
    }
    if (chartTendencia) chartTendencia.destroy();
    var diasSeleccionados = CF.dia || [];

    if (nota) {
      nota.style.display = 'block';
      nota.textContent = '🟩 Barras = eventos del periodo   —   Línea = tendencia (promedio móvil)';
    }

    // Misma ventana de media móvil que dashboardAnalisisFallas.js: 7 puntos
    // si la serie es diaria, 3 si ya viene agregada por semana.
    var ventana = serie.porSemana ? 3 : 7;
    var mediaMovil = serie.valores.map(function (_, i) {
      var tramo = serie.valores.slice(Math.max(0, i - ventana + 1), i + 1);
      return tramo.reduce(function (s, v) { return s + v; }, 0) / tramo.length;
    });

    chartTendencia = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: serie.etiquetas,
        datasets: [
          {
            type: 'bar',
            label: 'Eventos con PTO',
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
        ]
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        onClick: function (evt, elementosClic) {
          if (!elementosClic || elementosClic.length === 0) return;
          cfToggle('dia', serie.claves[elementosClic[0].index]);
        },
        onHover: function (evt, elementosHover) {
          if (evt.native && evt.native.target) evt.native.target.style.cursor = elementosHover.length ? 'pointer' : 'default';
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                if (ctx.dataset.type === 'line') return 'Tendencia: ' + Math.round(ctx.parsed.y).toLocaleString('en-US');
                return [ctx.parsed.y + ' evento(s)', 'Clic para filtrar por ' + (serie.porSemana ? 'esta semana' : 'este día')];
              }
            }
          }
        },
        scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    });
    return true;
  }

  function construirSeccionGraficos(contenedor, vehiculosOrdenados, serieTemporal) {
    var seccion = crear('div', { marginBottom: '16px' });

    var panelTendencia = crearPanel({ padding: '16px 18px', marginBottom: '12px' });
    panelTendencia.appendChild(crear('div', { color: T.color.ink, fontSize: '0.85rem', fontWeight: '800', marginBottom: '4px' }, '📈 Tendencia de eventos en el tiempo'));
    var notaTendencia = crear('div', { color: T.color.muted, fontSize: '0.72rem', marginBottom: '8px' });
    panelTendencia.appendChild(notaTendencia);
    var canvasTendencia = crear('canvas', { maxHeight: '190px' });
    var envoltorioTendencia = crear('div', { position: 'relative', height: '190px' });
    envoltorioTendencia.appendChild(canvasTendencia);
    panelTendencia.appendChild(envoltorioTendencia);
    seccion.appendChild(panelTendencia);

    var filaInferior = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap' });
    var panelBarras = crearPanel({ padding: '16px 18px', flex: '1 1 420px', minWidth: '320px' });
    panelBarras.appendChild(crear('div', { margin: '0 0 4px 0', color: T.color.ink, fontSize: '0.85rem', fontWeight: '800' }, '🚨 Top ' + TOP_N + ' vehículos con más eventos'));
    panelBarras.appendChild(crearLeyendaCriticidad());
    var canvasBarras = crear('canvas', { maxHeight: '220px' });
    var envoltorioBarras = crear('div', { position: 'relative', height: '220px' });
    envoltorioBarras.appendChild(canvasBarras);
    panelBarras.appendChild(envoltorioBarras);
    filaInferior.appendChild(panelBarras);
    seccion.appendChild(filaInferior);
    contenedor.appendChild(seccion);

    if (!construirGraficoTendencia(canvasTendencia, serieTemporal, notaTendencia)) {
      canvasTendencia.style.display = 'none';
      envoltorioTendencia.appendChild(crearEstadoVacioGrafico('No se registraron eventos' + descripcionFiltroCriticidad() + ' para el rango seleccionado.'));
    }
    if (!construirGraficoBarras(canvasBarras, vehiculosOrdenados)) {
      canvasBarras.style.display = 'none';
      envoltorioBarras.appendChild(crearEstadoVacioGrafico('No hay vehículos con eventos' + descripcionFiltroCriticidad() + ' en el rango seleccionado.'));
    }
  }

  // --- Render: tabla de vehículos ---------------------------------------------
  function crearPildoraCriticidad(v) {
    return crear('span', {
      display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px',
      borderRadius: T.radius.pill, fontSize: '0.72rem', fontWeight: '700',
      background: v.colorCriticidad + '22', color: v.colorCriticidad
    }, ICONO_POR_CRITICIDAD[v.criticidad] + ' ' + v.criticidad);
  }

  function construirTablaVehiculos(vehiculosOrdenados) {
    var panel = crearPanel({ padding: '16px 18px', flex: '1 1 480px', minWidth: '380px', overflowX: 'auto' });
    panel.appendChild(crear('div', { margin: '0 0 10px 0', color: T.color.ink, fontSize: '0.85rem', fontWeight: '800' }, '🚚 Vehículos'));

    if (vehiculosOrdenados.length === 0) {
      panel.appendChild(crear('div', { color: T.color.muted, fontSize: '0.82rem', padding: '20px 0', textAlign: 'center' }, 'Sin vehículos que mostrar.'));
      return panel;
    }

    var tabla = crear('table', { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' });
    var encabezados = ['#', 'Vehículo', 'Ciudad', 'Marca', 'Criticidad', 'Eventos', 'RPM pico máx', 'Tiempo total', 'Última fecha'];
    var filaEnc = crear('tr');
    encabezados.forEach(function (h) {
      filaEnc.appendChild(crear('th', { textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid ' + T.color.border, color: T.color.textoGris, fontSize: '0.72rem', textTransform: 'uppercase' }, h));
    });
    tabla.appendChild(filaEnc);

    // CAMBIO (2026-09-23, pedido explícito: "que cuando seleccione alguna
    // placa en la tabla me bote con el histórico"): fila clicable -- mismo
    // CF.vehiculo que ya escriben el buscador y el gráfico de Top
    // vehículos, así que clic aquí también dispara el panel de Historial de
    // eventos (ver construirHistorialVehiculo) más abajo en la página.
    var vehiculosSeleccionados = CF.vehiculo || [];
    vehiculosOrdenados.forEach(function (v, i) {
      var elegido = vehiculosSeleccionados.indexOf(v.idVehiculo) !== -1;
      var fila = crear('tr', {
        borderBottom: '1px solid ' + T.color.border, cursor: 'pointer',
        background: elegido ? T.color.primarySoft : 'transparent'
      });
      fila.title = 'Clic para ver el historial de eventos de este vehículo';
      fila.addEventListener('click', function () { cfToggle('vehiculo', v.idVehiculo); });
      fila.appendChild(crear('td', { padding: '6px 8px', color: T.color.muted }, String(i + 1)));
      fila.appendChild(crear('td', { padding: '6px 8px', color: T.color.ink, fontWeight: '600' }, v.claveVehiculo));
      fila.appendChild(crear('td', { padding: '6px 8px', color: T.color.body }, v.ciudad));
      fila.appendChild(crear('td', { padding: '6px 8px', color: T.color.body }, v.marca));
      var celdaCrit = crear('td', { padding: '6px 8px' });
      celdaCrit.appendChild(crearPildoraCriticidad(v));
      fila.appendChild(celdaCrit);
      fila.appendChild(crear('td', { padding: '6px 8px', color: T.color.ink, fontWeight: '700' }, String(v.eventos)));
      fila.appendChild(crear('td', { padding: '6px 8px', color: T.color.body }, v.rpmPicoMax !== null ? v.rpmPicoMax.toFixed(0) : 'N/D'));
      fila.appendChild(crear('td', { padding: '6px 8px', color: T.color.body }, formatearDuracionTotal(v.duracionTotalSeg)));
      fila.appendChild(crear('td', { padding: '6px 8px', color: T.color.muted }, v.ultimaFecha.toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })));
      tabla.appendChild(fila);
    });

    panel.appendChild(tabla);
    return panel;
  }

  // --- Render: historial de eventos individuales de UN vehículo ------------
  // CAMBIO (2026-09-23, pedido explícito): al seleccionar un solo vehículo
  // (fila de la tabla, buscador, o clic en la barra de Top vehículos) se
  // muestra el detalle evento-por-evento -- hasta ahora solo existían
  // agregados (conteo, RPM pico máximo, tiempo total), sin ver CUÁNDO
  // ocurrió cada evento individual ni su duración/RPM puntual. Recibe
  // 'eventos' YA filtrado por TODAS las dimensiones de CF (mismo que
  // alimenta KPIs/resumen/tabla), así que respeta también Ciudad/Criticidad
  // si están activos junto con el vehículo.
  var TOP_HISTORIAL = 100;

  function construirHistorialVehiculo(eventos, infoVehiculos) {
    var idVehiculo = (CF.vehiculo || [])[0];
    if (!idVehiculo) return null;

    var propios = eventos
      .filter(function (e) { return e.idVehiculo === idVehiculo; })
      .slice()
      .sort(function (a, b) { return b.activeFrom - a.activeFrom; });

    var info = infoVehiculos[idVehiculo];
    var nombreVehiculo = info ? info.claveVehiculo : idVehiculo;

    var panel = crearPanel({ padding: '16px 18px', marginBottom: '16px', overflowX: 'auto' });
    var encabezado = crear('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' });
    encabezado.appendChild(crear('div', { color: T.color.ink, fontSize: '0.85rem', fontWeight: '800' }, '🕘 Historial de eventos — ' + nombreVehiculo));
    var botonQuitar = crear('button', {
      padding: '5px 10px', borderRadius: T.radius.sm, border: '1px solid ' + T.color.borderStrong,
      background: T.color.surface, color: T.color.body, fontSize: '0.74rem', fontWeight: '700', cursor: 'pointer'
    }, 'Ver todos los vehículos');
    botonQuitar.addEventListener('click', function () { cfClearKey('vehiculo'); });
    encabezado.appendChild(botonQuitar);
    panel.appendChild(encabezado);

    if (propios.length === 0) {
      panel.appendChild(crear('div', { color: T.color.muted, fontSize: '0.82rem', padding: '12px 0' }, 'Sin eventos confirmados para este vehículo en el rango/filtros actuales.'));
      return panel;
    }

    var top = propios.slice(0, TOP_HISTORIAL);
    panel.appendChild(crear('div', {
      color: T.color.textoGris, fontSize: '0.76rem', marginBottom: '10px'
    }, propios.length + ' evento(s) con PTO confirmado' + (propios.length > TOP_HISTORIAL ? ' (mostrando los ' + TOP_HISTORIAL + ' más recientes)' : '') + '.'));

    var tabla = crear('table', { width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' });
    var filaEnc = crear('tr');
    ['#', 'Fecha y hora', 'Duración', 'RPM pico'].forEach(function (h) {
      filaEnc.appendChild(crear('th', { textAlign: 'left', padding: '6px 8px', borderBottom: '2px solid ' + T.color.border, color: T.color.textoGris, fontSize: '0.72rem', textTransform: 'uppercase' }, h));
    });
    tabla.appendChild(filaEnc);

    top.forEach(function (e, i) {
      var fila = crear('tr', { borderBottom: '1px solid ' + T.color.border });
      fila.appendChild(crear('td', { padding: '6px 8px', color: T.color.muted }, String(i + 1)));
      fila.appendChild(crear('td', { padding: '6px 8px', color: T.color.ink, fontWeight: '600' }, e.activeFrom.toLocaleString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })));
      fila.appendChild(crear('td', { padding: '6px 8px', color: T.color.body }, formatearDuracionTotal(e.duracionSeg)));
      var celdaRpm = crear('td', { padding: '6px 8px' });
      if (e.rpmPico !== null) {
        var esAlto = e.rpmPico >= UMBRAL_RPM_MERCEDES;
        celdaRpm.appendChild(crear('span', {
          fontWeight: '700', color: esAlto ? CRITICIDAD.CRITICO.color : T.color.body
        }, e.rpmPico.toFixed(0)));
      } else {
        celdaRpm.appendChild(crear('span', { color: T.color.muted }, 'N/D'));
      }
      fila.appendChild(celdaRpm);
      tabla.appendChild(fila);
    });

    panel.appendChild(tabla);
    return panel;
  }

  // --- Selector de vehículo (buscador con autocompletado) -------------------
  // CAMBIO (2026-09-22, pedido explícito: "falta poder seleccionar un
  // móvil"): mismo patrón que crearSelectorVehiculo en
  // dashboardAnalisisFallas.js -- input de texto + <datalist> (placa o
  // nombre), escribe sobre CF.vehiculo con cfSet (reemplaza selección única
  // de texto, distinto del clic-para-sumar del gráfico de Top vehículos --
  // ambos mecanismos igual escriben sobre el mismo CF.vehiculo).
  var contadorSelectorVehiculo = 0;

  function crearSelectorVehiculo(ancho) {
    contadorSelectorVehiculo++;
    var idLista = 'dashboardPTOListaVehiculos_' + contadorSelectorVehiculo;
    var envoltorio = crear('div', { display: 'flex', gap: '6px' });
    var input = crear('input', {
      padding: '6px 9px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm,
      fontSize: '0.8rem', fontFamily: T.font, color: T.color.ink, background: T.color.surface, width: ancho || '180px'
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
      cfSet('vehiculo', texto ? (mapaPorClave[texto] || null) : null);
    });

    var botonLimpiarVehiculo = crear('button', {
      padding: '6px 9px', background: 'transparent', color: T.color.body,
      border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm, fontSize: '0.78rem', cursor: 'pointer'
    }, '✕');
    botonLimpiarVehiculo.title = 'Quitar filtro de vehículo';
    botonLimpiarVehiculo.addEventListener('click', function () { input.value = ''; cfClearKey('vehiculo'); });

    envoltorio.appendChild(input);
    envoltorio.appendChild(botonLimpiarVehiculo);
    envoltorio.appendChild(datalist);

    return {
      envoltorio: envoltorio,
      input: input,
      // Repuebla el <datalist> con los vehículos reales de la consulta
      // actual.
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
      },
      // Mantiene el texto mostrado sincronizado con CF.vehiculo aunque haya
      // cambiado por otro mecanismo (clic en la barra de Top vehículos,
      // chip del banner de filtros cruzados, botón "Limpiar filtros").
      sincronizar: function (infoVehiculos) {
        var idsSel = CF.vehiculo || [];
        if (idsSel.length === 1 && infoVehiculos[idsSel[0]]) {
          input.value = infoVehiculos[idsSel[0]].claveVehiculo;
        } else if (idsSel.length !== 1) {
          input.value = '';
        }
      }
    };
  }

  // --- Render: barra de filtros (ciudad + vehículo + criticidad) -----------
  // CAMBIO (2026-09-22, cross-filter): ciudad y criticidad ahora escriben
  // sobre el mismo objeto CF que los gráficos clicables (Top vehículos,
  // Tendencia) -- ciudad usa cfSet (reemplaza, selección única del
  // dropdown), criticidad usa cfToggle (suma/quita, multiselección con los
  // chips). Ya no necesita un 'onCambio' externo: cfSet/cfToggle disparan
  // aplicarFiltrosYRenderizar por sí mismos.
  function construirBarraFiltros(contenedor) {
    var panel = crearPanel({ padding: '14px 16px', marginBottom: '16px', display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-end' });

    var envCiudad = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '160px' });
    envCiudad.appendChild(crear('label', { fontSize: '0.72rem', color: T.color.textoGris, fontWeight: '700', textTransform: 'uppercase' }, 'Ciudad'));
    var selectCiudad = crear('select', { padding: '7px 10px', borderRadius: T.radius.sm, border: '1px solid ' + T.color.borderStrong, fontSize: '0.85rem', fontFamily: T.font });
    var opcionTodas = crear('option'); opcionTodas.value = 'Todas'; opcionTodas.textContent = 'Todas';
    selectCiudad.appendChild(opcionTodas);
    selectCiudad.addEventListener('change', function () { cfSet('ciudad', selectCiudad.value === 'Todas' ? null : selectCiudad.value); });
    envCiudad.appendChild(selectCiudad);
    panel.appendChild(envCiudad);

    var envVehiculo = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    envVehiculo.appendChild(crear('label', { fontSize: '0.72rem', color: T.color.textoGris, fontWeight: '700', textTransform: 'uppercase' }, 'Vehículo'));
    var selectorVehiculo = crearSelectorVehiculo('190px');
    envVehiculo.appendChild(selectorVehiculo.envoltorio);
    panel.appendChild(envVehiculo);

    var envCriticidad = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    envCriticidad.appendChild(crear('label', { fontSize: '0.72rem', color: T.color.textoGris, fontWeight: '700', textTransform: 'uppercase' }, 'Criticidad'));
    var filaChips = crear('div', { display: 'flex', gap: '6px', flexWrap: 'wrap' });
    var chipsPorNivel = {};
    Object.keys(CRITICIDAD).forEach(function (clave) {
      var c = CRITICIDAD[clave];
      var chip = crear('button', {
        padding: '6px 12px', borderRadius: T.radius.pill, border: '1px solid ' + c.color,
        background: c.color, color: '#FFFFFF', fontSize: '0.76rem', fontWeight: '700', cursor: 'pointer'
      }, ICONO_POR_CRITICIDAD[c.nivel] + ' ' + c.nivel);
      chip.addEventListener('click', function () {
        cfToggle('criticidad', c.nivel);
        actualizarEstiloChips();
      });
      chipsPorNivel[clave] = chip;
      filaChips.appendChild(chip);
    });
    function actualizarEstiloChips() {
      var criticidadesActivas = CF.criticidad || [];
      Object.keys(chipsPorNivel).forEach(function (clave) {
        var c = CRITICIDAD[clave];
        var activo = !criticidadesActivas.length || criticidadesActivas.indexOf(c.nivel) !== -1;
        chipsPorNivel[clave].style.background = activo ? c.color : '#FFFFFF';
        chipsPorNivel[clave].style.color = activo ? '#FFFFFF' : c.color;
      });
    }
    actualizarEstiloChips();
    envCriticidad.appendChild(filaChips);
    panel.appendChild(envCriticidad);

    var botonLimpiar = crear('button', {
      padding: '8px 14px', borderRadius: T.radius.sm, border: '1px solid ' + T.color.borderStrong,
      background: T.color.surface, color: T.color.body, fontSize: '0.8rem', fontWeight: '700', cursor: 'pointer'
    }, 'Limpiar filtros');
    botonLimpiar.addEventListener('click', function () {
      selectCiudad.value = 'Todas';
      selectorVehiculo.input.value = '';
      cfClearAll();
      actualizarEstiloChips();
    });
    panel.appendChild(botonLimpiar);

    contenedor.appendChild(panel);
    return {
      actualizarOpcionesCiudad: function (ciudadesDisponibles) {
        var seleccionPrevia = (CF.ciudad && CF.ciudad[0]) || 'Todas';
        selectCiudad.innerHTML = '';
        var opTodas = crear('option'); opTodas.value = 'Todas'; opTodas.textContent = 'Todas';
        selectCiudad.appendChild(opTodas);
        ciudadesDisponibles.forEach(function (ciudad) {
          var op = crear('option'); op.value = ciudad; op.textContent = ciudad; selectCiudad.appendChild(op);
        });
        var sigueValida = seleccionPrevia === 'Todas' || ciudadesDisponibles.indexOf(seleccionPrevia) !== -1;
        selectCiudad.value = sigueValida ? seleccionPrevia : 'Todas';
        // Si la ciudad elegida ya no existe en los datos recién cargados
        // (rango nuevo), se limpia sola en vez de dejar un filtro fantasma
        // -- aplicarFiltrosYRenderizar corre justo después en cargarYRenderizar.
        if (!sigueValida) delete CF.ciudad;
      },
      actualizarOpcionesVehiculo: selectorVehiculo.actualizarOpciones,
      sincronizarSelectorVehiculo: selectorVehiculo.sincronizar,
      actualizarEstiloChips: actualizarEstiloChips
    };
  }

  // --- Encabezado (título + rango de fechas) --------------------------------
  function crearCampoFecha(etiqueta, valorInicial) {
    var envoltorio = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
    envoltorio.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.muted, fontWeight: '600' }, etiqueta));
    var input = crear('input', { padding: '7px 10px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm, fontSize: '0.82rem', fontFamily: T.font, color: T.color.ink, background: '#FFFFFF' });
    input.type = 'datetime-local';
    input.value = valorInicial;
    envoltorio.appendChild(input);
    return { envoltorio: envoltorio, input: input };
  }

  function construirEncabezado(contenedor) {
    var encabezado = crear('div', { padding: '18px 22px', background: T.color.surface, borderBottom: '1px solid ' + T.color.border, position: 'sticky', top: '0', zIndex: '5' });

    var filaTitulo = crear('div', { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' });
    filaTitulo.appendChild(crearChip('🏎️', T.color.primarySoft, T.color.primaryDark, '38px'));
    var bloqueTexto = crear('div');
    bloqueTexto.appendChild(crear('h2', { margin: '0', color: T.color.ink, fontSize: '1.25rem', fontWeight: '800', letterSpacing: '-0.01em' }, 'Análisis de Sobre-Revolución con PTO'));
    bloqueTexto.appendChild(crear('p', { margin: '2px 0 0 0', color: T.color.body, fontSize: '0.82rem' }, 'Tablero histórico — reincidencia, tendencia y criticidad por vehículo. Para monitoreo en vivo, ver el add-in "Sobre-Revolución con PTO".'));
    filaTitulo.appendChild(bloqueTexto);

    var rangoInicial = rangoPorDefecto();
    var campoDesde = crearCampoFecha('Desde', rangoInicial.desde);
    var campoHasta = crearCampoFecha('Hasta', rangoInicial.hasta);

    function crearBoton(texto, primario) {
      return crear('button', {
        alignSelf: 'flex-end', padding: '9px 18px', background: primario ? T.color.primary : T.color.surface,
        color: primario ? '#FFFFFF' : T.color.primaryDark, border: primario ? 'none' : '1px solid ' + T.color.primary,
        borderRadius: T.radius.sm, fontWeight: '700', fontSize: '0.85rem', cursor: 'pointer', transition: 'background 0.15s ease, transform 0.1s ease'
      }, texto);
    }

    var botonAnalizar = crearBoton('Analizar rango', true);
    var botonUltimos30 = crearBoton('Última semana', false);

    var filaFiltros = crear('div', { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-end' });
    filaFiltros.appendChild(campoDesde.envoltorio);
    filaFiltros.appendChild(campoHasta.envoltorio);
    filaFiltros.appendChild(botonAnalizar);
    filaFiltros.appendChild(botonUltimos30);

    encabezado.appendChild(filaTitulo);
    encabezado.appendChild(filaFiltros);
    contenedor.appendChild(encabezado);

    return { inputDesde: campoDesde.input, inputHasta: campoHasta.input, botonAnalizar: botonAnalizar, botonUltimos30: botonUltimos30 };
  }

  function mostrarCargando(contenedor) {
    while (contenedor.firstChild) contenedor.removeChild(contenedor.firstChild);
    var envoltorio = crear('div', { padding: '40px 22px', textAlign: 'center' });
    envoltorio.appendChild(crear('div', { fontSize: '0.85rem', color: T.color.body, fontWeight: '600' }, 'Analizando eventos del rango seleccionado…'));
    contenedor.appendChild(envoltorio);
  }

  // CAMBIO (2026-09-23): el mensaje de error mostraba "Error al consultar
  // Geotab." genérico en vez de la causa real -- el SDK de Geotab a veces
  // rechaza con formas distintas a {message: '...'} (string plano, objeto
  // {error: '...'}, {name, message} sin mensaje, etc.). describirError
  // intenta varias formas conocidas antes de caer al genérico, para poder
  // diagnosticar sin depender de que el usuario abra la consola del
  // navegador.
  function describirError(err) {
    if (!err) return 'Error al consultar Geotab (sin detalle).';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    if (err.error) return typeof err.error === 'string' ? err.error : describirError(err.error);
    if (err.name) return err.name;
    try {
      var texto = JSON.stringify(err);
      if (texto && texto !== '{}') return texto;
    } catch (e) { /* err no serializable, sigue al genérico */ }
    return 'Error al consultar Geotab (sin detalle -- ver consola del navegador, F12).';
  }

  function mostrarError(contenedor, mensaje) {
    while (contenedor.firstChild) contenedor.removeChild(contenedor.firstChild);
    var envoltorio = crear('div', { padding: '24px', background: T.color.dangerSoft, border: '1px solid ' + T.color.dangerBorder, borderRadius: T.radius.md });
    envoltorio.appendChild(crear('div', { color: T.color.danger, fontWeight: '700', marginBottom: '4px' }, 'No se pudo cargar la información'));
    envoltorio.appendChild(crear('div', { color: T.color.body, fontSize: '0.82rem' }, mensaje));
    contenedor.appendChild(envoltorio);
  }

  function deshabilitarBotonesCarga() {
    [elementos.botonAnalizar, elementos.botonUltimos30].forEach(function (boton) {
      if (!boton) return;
      boton.disabled = true; boton.style.opacity = '0.55'; boton.style.cursor = 'not-allowed';
    });
  }
  function habilitarBotonesCarga() {
    [elementos.botonAnalizar, elementos.botonUltimos30].forEach(function (boton) {
      if (!boton) return;
      boton.disabled = false; boton.style.opacity = '1'; boton.style.cursor = 'pointer';
    });
  }

  // --- Render: banner de filtros cruzados activos (chips removibles) -------
  // Mismo patrón que dashboardAnalisisFallas.js: cada valor activo de CF es
  // un chip con su propia "×" (cfRemoveValue), más un botón para vaciar CF
  // entero (cfClearAll).
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
        boton.addEventListener('click', function () {
          cfRemoveValue(clave, valor);
          if (barraFiltrosRefs) {
            if (clave === 'ciudad' && !(CF.ciudad && CF.ciudad.length)) barraFiltrosRefs.actualizarOpcionesCiudad(ciudadesDisponiblesCache);
            barraFiltrosRefs.actualizarEstiloChips();
          }
        });
        chip.appendChild(boton);
        filaChips.appendChild(chip);
      });
    });
    banner.appendChild(filaChips);

    var botonLimpiarTodo = crear('button', {
      alignSelf: 'flex-start', border: '1px solid ' + T.color.primary, background: '#FFFFFF', color: T.color.primaryDark,
      borderRadius: T.radius.sm, padding: '4px 10px', fontSize: '0.74rem', fontWeight: '700', cursor: 'pointer'
    }, 'Quitar todos los filtros cruzados');
    botonLimpiarTodo.addEventListener('click', function () {
      cfClearAll();
      if (barraFiltrosRefs) { barraFiltrosRefs.actualizarOpcionesCiudad(ciudadesDisponiblesCache); barraFiltrosRefs.actualizarEstiloChips(); }
    });
    banner.appendChild(botonLimpiarTodo);

    contenedor.appendChild(banner);
  }

  // 'vehiculosParaGraficoTop' ignora CF.vehiculo a propósito -- ver
  // eventosParaDimension('vehiculo') en aplicarFiltrosYRenderizar -- para que
  // el gráfico de Top vehículos siga mostrando su panorama completo (barra
  // elegida resaltada) aunque la tabla de abajo ya haya colapsado al filtro.
  function renderizarResultados(contenedor, eventos, vehiculosOrdenados, serieTemporal, periodoAnterior, vehiculosParaGraficoTop) {
    // Mantiene el buscador de vehículo sincronizado con CF.vehiculo sin
    // importar cómo haya cambiado (clic en barra, chip del banner, botón
    // Limpiar filtros) -- se llama en cada ciclo de aplicarFiltrosYRenderizar.
    if (barraFiltrosRefs) barraFiltrosRefs.sincronizarSelectorVehiculo(datosCache.infoVehiculos);
    while (contenedor.firstChild) contenedor.removeChild(contenedor.firstChild);
    construirBannerCf(contenedor);
    construirResumenNarrativo(contenedor, eventos, vehiculosOrdenados, periodoAnterior);
    construirKpis(contenedor, eventos, vehiculosOrdenados, periodoAnterior);
    construirSeccionGraficos(contenedor, vehiculosParaGraficoTop, serieTemporal);
    // CAMBIO (2026-09-23): panel de historial evento-por-evento, solo
    // visible cuando hay EXACTAMENTE un vehículo en CF.vehiculo (fila de la
    // tabla, buscador, o clic en la barra de Top vehículos) -- antes de la
    // tabla resumen, porque es el detalle que el usuario pidió ver primero
    // al seleccionar una placa puntual.
    var panelHistorial = construirHistorialVehiculo(eventos, datosCache.infoVehiculos);
    if (panelHistorial) contenedor.appendChild(panelHistorial);
    var filaTablas = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap' });
    filaTablas.appendChild(construirTablaVehiculos(vehiculosOrdenados));
    contenedor.appendChild(filaTablas);
  }

  // --- Orquestación ------------------------------------------------------------
  var contenedorPrincipal = null;
  var contenedorResultados = null;
  var barraFiltrosRefs = null;
  var idIntervaloAutoRefresco = null;
  var cargaEnCurso = false;

  var datosCache = { eventos: [], desde: null, hasta: null, periodoAnterior: null };
  var ciudadesDisponiblesCache = [];

  // --- Cross-filter multidimensional (2026-09-22) --------------------------
  // Mismo patrón CF = {clave: [valores]} de dashboardAnalisisFallas.js:
  // reemplaza el 'filtroEstado' anterior (un solo valor de ciudad + un flag
  // por criticidad, sin vehículo ni fecha). La MISMA clave es OR entre sus
  // valores (ej. Crítico + Alto a la vez); claves DISTINTAS son AND (ej.
  // Ciudad=Bogotá Y Vehículo=X). Cada gráfico "dueño" de una dimensión
  // (Top vehículos, Tendencia) ignora SOLO su propia clave al construir sus
  // datos, para seguir mostrando su panorama completo con la selección
  // resaltada -- ver eventosParaDimension más abajo.
  var CF = {};
  var CF_LABELS = { ciudad: 'Ciudad', vehiculo: 'Vehículo', criticidad: 'Criticidad', dia: 'Fecha' };
  var CF_ORDEN = ['ciudad', 'vehiculo', 'criticidad', 'dia'];

  function cfToggle(clave, valor) {
    var arr = CF[clave] || [];
    var idx = arr.indexOf(valor);
    arr = idx === -1 ? arr.concat([valor]) : arr.slice(0, idx).concat(arr.slice(idx + 1));
    if (arr.length) CF[clave] = arr; else delete CF[clave];
    aplicarFiltrosYRenderizar();
  }
  // cfSet: para el dropdown de Ciudad (selección única) -- REEMPLAZA el
  // valor de esa clave en vez de sumarlo. Un clic posterior en un gráfico
  // (cfToggle) puede seguir sumando un segundo valor, ambos escriben sobre
  // el mismo CF.
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

  // Evalúa si un EVENTO individual pasa el filtro de UNA clave puntual --
  // 'criticidad' NO se resuelve acá porque es una propiedad del VEHÍCULO
  // agregado (conteo total de eventos), no de un evento suelto; se aplica
  // aparte sobre vehiculosBase, en aplicarFiltrosYRenderizar.
  function eventoPasaClave(e, clave) {
    var valores = CF[clave];
    if (!valores || !valores.length) return true;
    if (clave === 'ciudad') return valores.indexOf(e.ciudad) !== -1;
    if (clave === 'vehiculo') return valores.indexOf(e.idVehiculo) !== -1;
    if (clave === 'dia') {
      var porSemana = resolverPorSemana(datosCache.desde, datosCache.hasta);
      return valores.indexOf(resolverClaveBalde(e.activeFrom, porSemana)) !== -1;
    }
    return true;
  }

  function etiquetaValorCf(clave, valor) {
    if (clave === 'vehiculo') {
      var info = datosCache.infoVehiculos[valor];
      return info ? info.claveVehiculo : valor;
    }
    if (clave === 'dia') return etiquetaClaveBalde(valor, resolverPorSemana(datosCache.desde, datosCache.hasta));
    return valor;
  }

  function sinFiltrosActivos() { return !cfHayFiltrosActivos(); }

  // CAMBIO (2026-09-22, cross-filter multidimensional): 'ciudad' se aplica
  // primero y define el universo "base" con el que se calcula la
  // criticidad REAL de cada vehículo -- la criticidad es una propiedad
  // agregada (conteo de eventos) que debe reflejar ese alcance amplio,
  // nunca la dimensión puntual que un gráfico esté ignorando de sí mismo
  // (ver eventosParaDimension). Con eso resuelto, cada gráfico "dueño" de
  // una dimensión (Top vehículos, Tendencia) pide su propio subconjunto
  // ignorando SOLO su propia clave.
  function aplicarFiltrosYRenderizar() {
    var eventosCiudad = datosCache.eventos.filter(function (e) { return eventoPasaClave(e, 'ciudad'); });

    var vehiculosBase = agregarPorVehiculo(eventosCiudad);
    // Si el usuario deselecciona las 4 criticidades por accidente (array
    // vacío tras varios toggles), CF.criticidad se borra solo (ver
    // cfToggle) y esto vuelve a permitir todas -- nunca queda "0 niveles
    // permitidos" mostrando un dashboard vacío sin explicación.
    var idsCriticidadOk = null;
    if (CF.criticidad && CF.criticidad.length) {
      idsCriticidadOk = {};
      vehiculosBase.forEach(function (v) { if (CF.criticidad.indexOf(v.criticidad) !== -1) idsCriticidadOk[v.idVehiculo] = true; });
    }

    function eventosParaDimension(excluirClave) {
      return eventosCiudad.filter(function (e) {
        if (idsCriticidadOk && !idsCriticidadOk[e.idVehiculo]) return false;
        if (excluirClave !== 'vehiculo' && !eventoPasaClave(e, 'vehiculo')) return false;
        if (excluirClave !== 'dia' && !eventoPasaClave(e, 'dia')) return false;
        return true;
      });
    }

    // "Resto del tablero" (KPIs, resumen narrativo, tabla de vehículos):
    // TODAS las dimensiones de CF aplican.
    var eventosParaResto = eventosParaDimension(null);
    var vehiculosOrdenadosParaResto = agregarPorVehiculo(eventosParaResto);

    // Gráficos "dueños" de una dimensión: cada uno ignora SOLO la suya para
    // seguir mostrando su panorama completo con la selección resaltada.
    var vehiculosParaGraficoTop = agregarPorVehiculo(eventosParaDimension('vehiculo'));
    var eventosParaTendencia = eventosParaDimension('dia');

    var serieTemporal = construirSerieTemporal(eventosParaTendencia, datosCache.desde, datosCache.hasta);
    // La comparación vs. periodo anterior solo se muestra sin NINGÚN filtro
    // cruzado activo -- un total filtrado de hoy contra un total SIN
    // filtrar de ayer no es una comparación válida.
    var periodoAnteriorParaKpis = sinFiltrosActivos() ? datosCache.periodoAnterior : null;
    renderizarResultados(contenedorResultados, eventosParaResto, vehiculosOrdenadosParaResto, serieTemporal, periodoAnteriorParaKpis, vehiculosParaGraficoTop);
  }

  // CAMBIO (2026-09-23, carga progresiva): el usuario reportó que la carga
  // completa se sentía lenta -- la causa era que el rango actual y el
  // periodo anterior se pedían EN SERIE y la vista se quedaba en
  // "Analizando…" hasta que las DOS pasadas del pipeline terminaban, aunque
  // el rango actual (lo que el usuario realmente quiere ver) ya estuviera
  // listo desde antes. Ahora se renderiza apenas el rango actual está
  // listo, y el periodo anterior se sigue pidiendo DESPUÉS -- mismo orden
  // secuencial de siempre (ver comentario más abajo sobre el bug real
  // "ServerStopped" del 2026-09-17: las dos pasadas completas EN PARALELO
  // tumbaban la sesión de Geotab, así que NO se paralelizan) -- solo que ya
  // no bloquea la vista: cuando termine, actualiza las flechas de tendencia
  // de los KPIs con un segundo render liviano (sin volver a golpear
  // Geotab). Los botones siguen deshabilitados hasta que ambas pasadas
  // terminen, para no permitir una segunda carga pesada superpuesta con la
  // del periodo anterior en vuelo (mismo candado de siempre, ver
  // cargaEnCurso).
  function cargarYRenderizar(desde, hasta) {
    if (cargaEnCurso) return;
    cargaEnCurso = true;
    deshabilitarBotonesCarga();
    mostrarCargando(contenedorResultados);

    var duracionMs = hasta.getTime() - desde.getTime();
    var desdeAnterior = new Date(desde.getTime() - duracionMs);
    var hastaAnterior = new Date(desde.getTime());

    obtenerIdRegla()
      .then(function (idRegla) { return obtenerEventosCandidatos(idRegla, desde, hasta); })
      .then(confirmarPtoCercano)
      .then(agregarPicoRpm)
      .then(resolverVehiculos)
      .then(filtrarPorUmbralMercedes)
      .then(function (resultado) {
        datosCache = {
          eventos: resultado.eventos, infoVehiculos: resultado.infoVehiculos, desde: desde, hasta: hasta,
          periodoAnterior: null, periodoAnteriorCargando: true
        };
        ciudadesDisponiblesCache = Array.from(new Set(resultado.eventos.map(function (e) { return e.ciudad; }))).sort();
        if (barraFiltrosRefs) {
          barraFiltrosRefs.actualizarOpcionesCiudad(ciudadesDisponiblesCache);
          barraFiltrosRefs.actualizarOpcionesVehiculo(resultado.infoVehiculos);
        }
        aplicarFiltrosYRenderizar();

        // CAMBIO (bug real "ServerStopped" 2026-09-17): el periodo anterior
        // se pide RECIEN ACA, despues de que el pipeline principal ya
        // termino sus multiCall pesados (confirmarPtoCercano/agregarPicoRpm,
        // uno por cada vehiculo en alcance) -- antes se pedia en paralelo
        // desde el arranque, y en la primera carga de la pagina (cache fria,
        // ademas ahora con mas vehiculos tras volver L9/T380 nacionales) los
        // dos pipelines completos a la vez generaban un pico de solicitudes
        // simultaneas que tumbaba la sesion de Geotab.
        return obtenerTotalesPeriodo(desdeAnterior, hastaAnterior)
          .catch(function (err) { console.error('Análisis PTO: no se pudo obtener el periodo anterior:', err); return null; })
          .then(function (periodoAnterior) {
            datosCache.periodoAnterior = periodoAnterior;
            datosCache.periodoAnteriorCargando = false;
            aplicarFiltrosYRenderizar();
          });
      })
      .catch(function (err) {
        console.error('Análisis PTO:', err);
        mostrarError(contenedorResultados, describirError(err));
      })
      .then(function () {
        cargaEnCurso = false;
        habilitarBotonesCarga();
      });
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi; state = freshState;

      contenedorPrincipal = document.getElementById('dashboardPTORoot');
      aplicarEstilo(contenedorPrincipal, { fontFamily: T.font, background: T.color.canvas, padding: '4px' });

      var refs = construirEncabezado(contenedorPrincipal);
      elementos.inputDesde = refs.inputDesde;
      elementos.inputHasta = refs.inputHasta;
      elementos.botonAnalizar = refs.botonAnalizar;
      elementos.botonUltimos30 = refs.botonUltimos30;

      barraFiltrosRefs = construirBarraFiltros(contenedorPrincipal);

      elementos.botonAnalizar.addEventListener('click', function () {
        cargarYRenderizar(new Date(elementos.inputDesde.value), new Date(elementos.inputHasta.value));
      });
      elementos.botonUltimos30.addEventListener('click', function () {
        var rango = rangoPorDefecto();
        elementos.inputDesde.value = rango.desde; elementos.inputHasta.value = rango.hasta;
        cargarYRenderizar(new Date(rango.desde), new Date(rango.hasta));
      });

      contenedorResultados = crear('div');
      contenedorPrincipal.appendChild(contenedorResultados);

      initializedCallback();
    },

    focus: function (freshApi, freshState) {
      api = freshApi; state = freshState;
      if (idIntervaloAutoRefresco) clearInterval(idIntervaloAutoRefresco);
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
