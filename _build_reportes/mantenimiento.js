/* ============================================================================
   Add-In: Mantenimiento (Fallas)

   Hasta el 2026-10-01 este archivo era "reportes.js", UN add-in con 3 tipos
   de reporte elegibles por pill (Fallas / Operaciones / Mini Expediente). El
   usuario pidió separarlo en DOS add-ins independientes de MyGeotab --
   decisión explicita, ver cambios/2026-10-01_separar-en-dos-addins.md para
   el detalle completo de qué se movió a dónde. Esta carpeta
   (_build_reportes/) se queda siendo el add-in de MANTENIMIENTO (mínima
   disrupción al historial de changelogs ya acumulado aquí desde el
   2026-09-29); el reporte de Operaciones (hábitos: velocidad, ralentí,
   PTO) se mudó a un add-in nuevo y separado en _build_operaciones/ (ver
   _build_operaciones/cambios/2026-10-01_creacion-addin-operaciones.md).

   CAMBIO (2026-10-01, el mismo día, por la tarde): el Mini Expediente
   (tercera pill agregada más abajo en "Tercera versión") se agregó aquí
   primero pero se movió COMPLETO a Alertas por Severidad
   (_build_alertas_fallas/) poco después -- decisión explícita del usuario
   tras notar que ese add-in ya resolvía conductor/turno por fila y no
   necesitaba picker. Este archivo volvió a quedar con un solo modo (Fallas),
   igual que cuando se separó Operaciones. Ver
   cambios/2026-10-01_quitar-mini-expediente.md.

   Esta pantalla deja elegir una empresa (grupo Geotab) + rango de fechas y
   descarga un reporte HTML autocontenido -- el MISMO diseño visual/
   estructura/motor JS que ya se usa para los reportes de fallas generados
   por un script Python separado (fuera de este repo), pero disparado desde
   dentro de MyGeotab.

   DUPLICACIÓN INTENCIONAL (aceptada explícitamente con el usuario, no es
   un error a corregir): el código compartido entre este add-in y el de
   Operaciones -- conexión a la API, catálogos de diagnósticos, resolución
   de empresa/dispositivos, el motor de plantillas (ya NO: desde v3.0 el motor va dentro de PLANTILLA_HTML_EMBEBIDA), el
   sistema de diseño (T/crearPill/inyectarEstilosGlobales), helpers de
   fecha -- vive DUPLICADO, verbatim, en operaciones.js. Geotab no soporta
   compartir un módulo JS entre dos add-ins de forma sencilla, y aunque lo
   soportara, el usuario ya decidió que la separación completa de archivos
   es preferible a mantener un acoplamiento entre dos add-ins con ciclos de
   vida independientes.

   Historial relevante (de la época en que este archivo todavía se llamaba
   reportes.js y contenía los 3 tipos de reporte):

   Primera versión (2026-09-29): SOLO el reporte de Fallas -- ver
   cambios/2026-09-29_creacion-addin-reportes.md para el detalle completo de
   qué se portó de dónde y qué queda pendiente de confirmar.

   Segunda versión (2026-09-29/30): se agregó "Operaciones" (hábitos:
   velocidad, ralentí, PTO) como HERMANO de Fallas dentro del MISMO add-in
   (luego separado en su propio add-in, ver arriba). Usaba el MISMO motor de
   renderizado (ya soportaba DASH.kind==='habits_dashboard' desde el día 1) y
   una plantilla HTML nueva (reporte_operaciones_plantilla.html, ahora en
   _build_operaciones/). Ver cambios/2026-09-29_agregar-reporte-operaciones.md
   para el detalle de qué reglas de Geotab se usan para cada hábito y por qué
   (decisión NO confirmada con el usuario -- ver ese changelog antes de
   confiar en el reporte generado por el add-in de Operaciones).

   Tercera versión (2026-10-01): se agregó "Mini Expediente" (ficha de UN
   caso puntual de falla) como tercera pill, dentro del add-in de entonces.
   Quedó en ESTE add-in (Mantenimiento) justo tras la separación -- ver
   cambios/2026-10-01_agregar-mini-expediente.md para el detalle de qué se
   construyó -- pero se movió por completo a Alertas por Severidad poco
   después, el mismo día (ver el CAMBIO documentado arriba, al inicio de este
   bloque, y cambios/2026-10-01_quitar-mini-expediente.md). Esta versión del
   archivo YA NO tiene esa pill ni el código del expediente.

   Reutiliza (adaptado, no siempre verbatim) varios bloques ya validados en
   dashboardAnalisisFallas.js: tema visual T, apiCall/apiMultiCall, paginado
   de FaultData, catálogos Diagnostic/FailureMode, la taxonomía SISTEMAS para
   clasificar cada diagnóstico, y el conteo de "activaciones" por episodios
   (transición real hacia Active, con debounce de reactivación -- ver
   episodiosDeRegistros) -- mismo patrón de duplicación intencional ya documentado
   en CLAUDE.md ("Group hierarchy... duplicada con slightly different names
   across app.py, telegram_alertas.py, y herramientas/geotab_reglas_v3.py").

   El reporte final (el .html descargable) se arma combinando strings
   INCRUSTADOS en este mismo archivo (ver PLANTILLA_HTML_EMBEBIDA
   más abajo, generada por construir_plantilla_v2.py desde
   los .html/.js que se guardan aparte solo como copia legible de referencia
   -- NO se leen en tiempo de ejecución) con los datos recién consultados a
   Geotab, antes de disparar la descarga vía Blob. CAMBIO (2026-09-29): antes
   se cargaban con fetch() como archivos hermanos, pero eso dio 404 real
   dentro de MyGeotab -- ver cambios/2026-09-29_incrustar-plantilla-y-motor-fix-404.md.
   ============================================================================ */

geotab.addin.mantenimiento = function () {
  'use strict';

  // --- Constantes de datos -------------------------------------------------
  // Mismo tope real de FaultData por llamada que ya se documentó y corrigió en
  // telegram_alertas.py / dashboardAnalisisFallas.js -- sin paginar se pierden
  // en silencio los registros más recientes de un rango grande.
  var LIMITE_PAGINA_FAULTDATA = 50000;

  // Grupos cuyo nombre contiene alguna de estas palabras se tratan como rama
  // de "marca" (motor/ensamblador), no como empresa/ciudad -- mismo criterio
  // (esGrupoMarca) ya usado en dashboardAnalisisFallas.js/telegram_alertas.py.
  // CAMBIO (2026-10-03, auditoría): + 'chevrolet' -- sin ella los grupos
  // 'CHEVROLET - NHR' / 'CHEVROLET VAN - N400' no se reconocían como marca y
  // esos vehículos salían como "Sin marca" en el reporte.
  var PALABRAS_GRUPO_MARCA = ['volkswagen', 'volskwagen', 'mercedes', 'international', 'foton', 'kenworth', 'chevrolet'];
  var NOMBRE_GRUPO_TIPOLOGIA = 'tipologia';

  // CAMBIO (2026-09-29, bug real en produccion: fetch('reporte_runtime_engine.js')
  // devolvia 404 dentro de MyGeotab aunque reportes.js si cargaba -- el Local
  // Add-In no estaba sirviendo los archivos hermanos de forma confiable). Se
  // incrustan el motor y la plantilla COMO STRINGS dentro de este mismo archivo
  // (generados con json.dumps desde los .html/.js originales, sin retipear nada a
  // mano) para que el add-in no dependa de que Geotab sirva mas de un archivo.
  // ==== PLANTILLA_COMPRIMIDA (generado por incrustar_plantilla_v2.py: no editar a mano) ====
  var PLANTILLA_Z = [
    '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',
  ].join('');
  var plantillaPromesa = null;
  function obtenerPlantilla() {
    if (!plantillaPromesa) {
      plantillaPromesa = Promise.resolve().then(function () {
        if (typeof DecompressionStream === 'undefined') throw new Error('Este navegador no puede abrir la plantilla del reporte. Use una versión reciente de Chrome, Edge o Firefox.');
        var bin = atob(PLANTILLA_Z), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).text();
      }).catch(function (e) { plantillaPromesa = null; throw e; });
    }
    return plantillaPromesa;
  }
  // ==== FIN PLANTILLA_COMPRIMIDA ====

  // --- Tema visual (verbatim de dashboardAnalisisFallas.js/dashboardAnalisisPTO.js,
  // para que el selector de esta pantalla comparta marca con los otros 2 add-ins) ---
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
      // CAMBIO (2026-09-29, pedido explícito de diseño ejecutivo): verde
      // esmeralda para el botón principal (distinto del verde corporativo
      // T.color.primary, que aquí solo queda como acento de marca en el
      // encabezado) y azul para el estado "cargando" de la alerta en línea.
      success: '#10B981',
      successDark: '#0EA371',
      successSoft: '#ECFDF5',
      successText: '#065F46',
      successBorder: '#A7F3D0',
      infoSoft: '#EFF6FF',
      infoText: '#1E3A8A',
      infoBorder: '#BFDBFE'
    },
    radius: { sm: '10px', md: '12px', lg: '18px', pill: '999px' },
    shadow: { card: '0 1px 2px rgba(15,23,42,0.05), 0 8px 24px rgba(15,23,42,0.07)' },
    font: "'Inter', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
  };

  // Taxonomía de sistemas por palabra clave del NOMBRE del diagnóstico --
  // PORTADA VERBATIM de dashboardAnalisisFallas.js (SISTEMAS +
  // EXCLUSIONES_SISTEMA_CRITICO no se necesitan aquí porque este reporte no
  // clasifica "vehículo crítico", solo clasifica cada FALLA por sistema).
  //
  // LIMITACIÓN CONOCIDA (ver cambios/2026-09-29_creacion-addin-reportes.md):
  // el reporte de referencia (PACARIBE) muestra categorías que esta lista de
  // 10 sistemas NO tiene ("Indicadores del vehículo", "Código propietario",
  // "Comunicación/Red", "Seguridad", "General") -- viene de un script Python
  // separado con su propia taxonomía, más completa, que no es visible en
  // este repo. Se porta la de dashboardAnalisisFallas.js porque es la única
  // fuente de verdad de este tipo YA VALIDADA que existe en el repo (decisión
  // tomada explícitamente con el usuario: reutilizar lógica de negocio ya
  // resuelta aunque implique duplicarla).
  // CAMBIO (2026-10-03, pedido del usuario tras la auditoría): antes, a
  // diferencia de esa otra pantalla, aquí NO se excluía "Otro / Sin
  // clasificar" del desglose por sistema. En datos reales era el 46,5 % de
  // las fallas y salía como "Sistema principal", lo que solo metía ruido.
  // Ahora se excluye del KPI de sistema, del gráfico por sistema
  // (DASH.hiddenCategories, ver reporte_runtime_engine.js) y de la frase de
  // la narrativa. Esas fallas SIGUEN contando en el total de fallas
  // distintas, en el resto de gráficos y en la tabla de detalle (columna
  // Categoría), igual que en dashboardAnalisisFallas.js.
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
  var EXCLUSIONES_SISTEMA = ['ventilador', 'limpiaparabrisas', 'vidrio', 'espejo', 'asiento', 'direccional'];
  var SISTEMA_SIN_CLASIFICAR = 'Otro / Sin clasificar';

  // Única función que decide a qué sistema pertenece un diagnóstico -- mismo
  // criterio de coincidencia por PALABRA COMPLETA (\b...\b) que
  // resolverSistemaPrincipal en dashboardAnalisisFallas.js, para no repetir
  // el bug real ya documentado ahí (substring "direccion" matcheando
  // "Velocidad direccioNAL", "motor" matcheando "motor del ventilador HVAC").
  function resolverSistema(nombreDiagnostico) {
    var nombreL = (nombreDiagnostico || '').toLowerCase();
    var excluido = EXCLUSIONES_SISTEMA.some(function (palabra) { return nombreL.indexOf(palabra) !== -1; });
    for (var i = 0; i < SISTEMAS.length; i++) {
      var sistema = SISTEMAS[i];
      if (excluido) continue;
      var coincide = sistema.claves.some(function (palabra) {
        return new RegExp('\\b' + palabra + '\\b', 'i').test(nombreL);
      });
      if (coincide) return sistema.nombre;
    }
    return SISTEMA_SIN_CLASIFICAR;
  }

  // --- Criticidad POR FALLA (ALTA/MEDIA/BAJA) -------------------------------
  // Distinta a propósito de la criticidad de dashboardAnalisisFallas.js (esa
  // es POR VEHÍCULO, en 4 niveles Crítico/Alto/Medio/Bajo, calculada por
  // cantidad de episodios -- no aplica aquí, el reporte de referencia usa 3
  // niveles POR FALLA). El pie de página del reporte original es explícito
  // sobre el criterio: "ALTA (luz roja o de protección), MEDIA (luz ámbar) o
  // BAJA (sin luz de alerta)". Eso corresponde a los campos estándar de
  // FaultData en MyGeotab (redStopLamp / protectWarningLamp / amberWarningLamp).
  //
  // SIN VERIFICAR CONTRA DATOS REALES (ver changelog): no se pudo probar esta
  // función contra una cuenta Geotab real durante esta tarea -- confirmar que
  // esos 3 campos booleanos existen y se comportan como se asume antes de
  // confiar en la columna "Criticidad" del reporte generado.
  function criticidadDeRegistro(registro) {
    if (registro.redStopLamp || registro.protectWarningLamp) return 'ALTA';
    if (registro.amberWarningLamp || registro.malfunctionLamp) return 'MEDIA';   // MIL (check engine) = MEDIA, igual que la aplicación
    return 'BAJA';
  }

  // Estado "activo" = Active o Pending (política de la aplicación: ACTIVATION_STATES). Los valores reales de
  // FaultData.faultState en esta cuenta son 'Active', 'Pending' y 'None' (None = no activa).
  function registroActivo(r) {
    return (r.faultState === 'Active' || r.faultState === 'Pending') && r.dismiss !== true;
  }

  var RANGO_CRITICIDAD = { ALTA: 3, MEDIA: 2, BAJA: 1 };

  var api = null;
  var state = null;
  var elementos = {};
  var contenedorPrincipal = null;

  // Cachés (se recargan cada vez que se abre el add-in con focus(), no hace
  // falta invalidarlas manualmente -- Group/Device no cambian tan seguido).
  var cacheGrupos = null;
  var cacheDispositivos = null;
  var cacheCatalogos = null;
  var cargaEnCurso = false;

  // --- Utilidades de estilo (CSSOM) -- Geotab elimina <style> del add-in ---
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

  // --- Envoltorios sobre la API de Geotab (callback -> Promise) -- verbatim
  // del mismo patrón en dashboardAnalisisFallas.js/dashboardAnalisisPTO.js ---
  function apiCall(metodo, params) {
    return new Promise(function (resolve, reject) { api.call(metodo, params, resolve, reject); });
  }

  function idDeRef(ref) { return (ref && ref.id) ? ref.id : ref; }

  // --- FaultData paginado ---------------------------------------------------
  // Puerto directo de obtenerFaultDataPaginado (dashboardAnalisisFallas.js) /
  // _obtener_faultdata_paginado (telegram_alertas.py).
  function obtenerFaultDataPaginado(desde, hasta, idDispositivo) {
    function pedirPagina(desdeActual, acumulado) {
      var busqueda = { fromDate: desdeActual.toISOString(), toDate: hasta.toISOString() };
      if (idDispositivo) busqueda.deviceSearch = { id: idDispositivo };
      return apiCall('Get', {
        typeName: 'FaultData',
        search: busqueda
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

  // --- Catálogos Diagnostic / FailureMode -> nombre + código (SPN/FMI) -----
  // Verbatim de obtenerCatalogosDiagnosticos (dashboardAnalisisFallas.js).
  function obtenerCatalogosDiagnosticos() {
    if (cacheCatalogos) return Promise.resolve(cacheCatalogos);
    return Promise.all([
      apiCall('Get', { typeName: 'Diagnostic' }),
      apiCall('Get', { typeName: 'FailureMode' })
    ]).then(function (resultados) {
      var dicDiag = {};
      (resultados[0] || []).forEach(function (d) {
        if (d && d.id) dicDiag[d.id] = { nombre: d.name || 'Diagnóstico desconocido', codigo: d.code, fuente: idDeRef(d.source) };
      });
      var dicFm = {};
      (resultados[1] || []).forEach(function (fm) {
        if (fm && fm.id) dicFm[fm.id] = { nombre: fm.name || '', codigo: fm.code };
      });
      cacheCatalogos = { dicDiag: dicDiag, dicFm: dicFm };
      return cacheCatalogos;
    });
  }

  // --- Jerarquía de grupos -> "empresa" + tipología + marca -----------------
  // DECISIÓN ABIERTA (ver changelog): esta cuenta de Geotab no tiene un campo
  // ni una rama de grupos dedicada a "empresa" -- CLAUDE.md solo documenta
  // ciudad/tipología/marca. dashboardAnalisisFallas.js resuelve "ciudad" como
  // el primer grupo hijo de la raíz ('*...') que NO es la rama "Tipologia" ni
  // una rama de marca (esGrupoMarca) -- en una cuenta multi-cliente como esta
  // (PACARIBE en el ejemplo real, que no matchea ningún patrón de ciudad
  // colombiana conocido) ese MISMO nivel es, con alta probabilidad, donde
  // viven los nombres de empresa/cliente reales. Se reutiliza exactamente esa
  // resolución, pero SIN la normalización de nombre de ciudad (normalizarCiudad
  // capitalizaba "Bogotá/Cali/Valle" a propósito; para un nombre de empresa
  // como "PACARIBE" eso lo degradaría a "Pacaribe", perdiendo el mayúsculas
  // real del grupo) -- aquí se usa el nombre del grupo tal cual, solo con trim().
  // NO CONFIRMADO con el usuario: si en esta cuenta "empresa" vive en otro
  // nivel de la jerarquía, hay que ajustar aquí (un solo punto de cambio).
  function esGrupoMarca(nombre) {
    var l = (nombre || '').trim().toLowerCase();
    return PALABRAS_GRUPO_MARCA.some(function (marca) { return l.indexOf(marca) !== -1; });
  }

  function obtenerGruposYDispositivos() {
    var pGrupos = cacheGrupos ? Promise.resolve(cacheGrupos) : apiCall('Get', { typeName: 'Group' }).then(function (g) { cacheGrupos = g || []; return cacheGrupos; });
    var pDispositivos = cacheDispositivos ? Promise.resolve(cacheDispositivos) : apiCall('Get', { typeName: 'Device' }).then(function (d) { cacheDispositivos = d || []; return cacheDispositivos; });
    return Promise.all([pGrupos, pDispositivos]);
  }

  // Recorre el árbol de grupos UNA vez y devuelve:
  //  - empresasDisponibles: [{id, nombre}] -- candidatos para el selector.
  //  - mapaGrupos: idGrupo -> {nombre, empresa, tipologia} (empresa/tipologia
  //    heredados de la rama a la que pertenece cada grupo, igual que
  //    obtener_mapa_grupos en telegram_alertas.py / obtenerMapaGrupos en
  //    dashboardAnalisisFallas.js, pero "ciudad" pasa a llamarse "empresa").
  function construirMapaEmpresas(grupos) {
    var porId = {};
    (grupos || []).forEach(function (g) { if (g && g.id) porId[g.id] = g; });
    function idDe(ref) { return (ref && ref.id) ? ref.id : ref; }

    var raiz = (grupos || []).filter(function (g) { return g && typeof g.name === 'string'; })
      .find(function (g) { return g.name.trim().indexOf('*') === 0; });

    var mapa = {};
    var empresasDisponibles = [];
    if (!raiz) return { mapa: mapa, empresasDisponibles: empresasDisponibles };

    function recorrer(grupoId, empresaActual, tipologiaActual) {
      var grupoCompleto = porId[grupoId];
      if (!grupoCompleto) return;
      mapa[grupoId] = { nombre: grupoCompleto.name || '', empresa: empresaActual, tipologia: tipologiaActual };
      (grupoCompleto.children || []).forEach(function (hijo) { recorrer(idDe(hijo), empresaActual, tipologiaActual); });
    }

    (raiz.children || []).forEach(function (hijoRaiz) {
      var hijoId = idDe(hijoRaiz);
      var hijoCompleto = porId[hijoId] || {};
      var nombre = (hijoCompleto.name || '').trim();
      if (nombre.toLowerCase() === NOMBRE_GRUPO_TIPOLOGIA) {
        (hijoCompleto.children || []).forEach(function (sub) {
          var subId = idDe(sub);
          var subCompleto = porId[subId] || {};
          recorrer(subId, null, (subCompleto.name || '').trim());
        });
      } else if (esGrupoMarca(nombre)) {
        recorrer(hijoId, null, null);
      } else if (nombre) {
        empresasDisponibles.push({ id: hijoId, nombre: nombre });
        recorrer(hijoId, nombre, null);
      }
    });

    empresasDisponibles.sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
    return { mapa: mapa, empresasDisponibles: empresasDisponibles };
  }

  // Un Device en Geotab suele estar etiquetado DIRECTAMENTE con varios grupos
  // a la vez (no solo el más profundo) -- por eso, igual que
  // resolverMarcaYTipologia en dashboardAnalisisFallas.js, alcanza con mirar
  // dev.groups (sin subir por la jerarquía de padres) y consultar el mapa
  // precalculado para cada uno.
  function resolverInfoDispositivo(dispositivo, mapaGrupos) {
    var marca = null, empresa = null, tipologia = null;
    (dispositivo.groups || []).forEach(function (g) {
      var gid = idDeRef(g);
      var info = mapaGrupos[gid];
      if (!info) return;
      if (!marca && esGrupoMarca(info.nombre)) marca = info.nombre.trim();
      if (!empresa && info.empresa) empresa = info.empresa;
      if (!tipologia && info.tipologia) tipologia = info.tipologia;
    });
    return {
      nombre: dispositivo.name || dispositivo.id,
      placa: dispositivo.licensePlate || '',
      marca: marca || 'Sin marca',
      tipologia: tipologia || 'Sin tipología asignada',
      empresa: empresa
    };
  }

  // --- Fechas ----------------------------------------------------------------
  var DIAS_ABREV = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  var MESES_ABREV = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function aFechaInputValue(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function etiquetaDia(fecha) {
    return DIAS_ABREV[fecha.getDay()] + ' ' + pad(fecha.getDate()) + '/' + pad(fecha.getMonth() + 1);
  }

  function formatearFechaCorta(d) {
    return d.getDate() + ' ' + MESES_ABREV[d.getMonth()] + ' ' + d.getFullYear();
  }

  function formatearFechaHora(fecha) {
    return fecha.toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  }

  function formatearGenerado(d) {
    try {
      var texto = new Intl.DateTimeFormat('es-CO', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
      }).format(d);
      return texto.replace(',', '');
    } catch (e) {
      return formatearFechaHora(d);
    }
  }

  function formatearDecimal(v) {
    return (v || 0).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // CAMBIO (2026-09-29, pedido explícito del usuario tras revisar el primer
  // build): Geotab re-registra el MISMO FaultData con faultState='Active'
  // repetidamente mientras el código sigue activo -- no una sola vez por
  // evento real (mismo fenómeno ya documentado con PTO en telegram_alertas.py
  // y con FaultData en dashboardAnalisisFallas.js: un solo vehículo llegó a
  // 24,641 "episodios" crudos en 30 días). La primera versión de este add-in
  // contaba "activaciones" como el total de registros Active -- eso infla el
  // número. Se porta VERBATIM el criterio de calcularEpisodiosPorGrupo de
  // dashboardAnalisisFallas.js: "activación" = transición real hacia Active
  // desde un estado que no era Active, con un debounce de reactivación (si se
  // reactiva a los pocos minutos de apagarse, es el MISMO episodio en curso,
  // no uno nuevo).
  var DEBOUNCE_REACTIVACION_MIN = 10;

  // --- Reporte v2: dos secciones (Fallos activos al generar / Activaciones en el período) ---------------
  // CAMBIO (2026-11-11, pedido del usuario): el reporte pasa al formato de dos secciones de la aplicación
  // (Paquete_Reporte_de_Fallos). Reglas, tal como las usa la aplicación y el resto del proyecto:
  //  - ACTIVOS al generar: una falla cuenta si su ÚLTIMO registro es Active (sin dismiss) y llegó en las últimas
  //    24 h respecto al corte (regla de "falla confirmada"; evita tratar como activa una falla con un solo
  //    registro viejo). El rango de fechas NO limita esta sección.
  //  - ACTIVACIONES del período: cada inicio real de episodio dentro del rango (misma regla y debounce de
  //    reactivación de siempre). Los registros Active repetidos mientras sigue activa no suman.
  //  - Sin GoFault: se excluyen los fallos de la fuente Geotab GO (solo camión y OBD), como la aplicación.
  //  shortcut: sin la base local de la aplicación, "Nueva/Recurrente" y la duración de episodios largos se
  //  calculan solo con SEMILLA_DIAS de historial previo al rango; subir SEMILLA_DIAS si hace falta más memoria.
  var SEMILLA_DIAS = 7;
  var LIMITE_CONSULTA_POR_DISPOSITIVO = 20;   // hasta esta cantidad de vehículos se consulta FaultData uno por uno
  var VENTANA_CONFIRMACION_MS = 24 * 60 * 60 * 1000;
  var FUENTE_GOFAULT = 'SourceGeotabGoId';
  var CONTROLADOR_GOFAULT = 'ControllerGoDeviceId';

  function esGoFault(idDiagnostico, catalogos, controlador) {
    var d = catalogos.dicDiag[idDiagnostico];
    return (d && d.fuente === FUENTE_GOFAULT) || controlador === CONTROLADOR_GOFAULT;
  }

  function isoDia(f) { return f.getFullYear() + '-' + pad(f.getMonth() + 1) + '-' + pad(f.getDate()); }

  function fechaHoraCorta(f) {
    return pad(f.getDate()) + '/' + pad(f.getMonth() + 1) + '/' + f.getFullYear() + ' ' + pad(f.getHours()) + ':' + pad(f.getMinutes());
  }

  function formatearDuracion(seg) {
    seg = Math.max(0, Math.round(seg));
    var d = Math.floor(seg / 86400), h = Math.floor((seg % 86400) / 3600), m = Math.floor((seg % 3600) / 60);
    if (d > 0) return d + ' d ' + h + ' h';
    if (h > 0) return h + ' h ' + m + ' min';
    if (m > 0) return m + ' min';
    return seg + ' s';
  }

  function construirDiasIso(desde, hasta) {
    var dias = [];
    var cursor = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate());
    var fin = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate());
    while (cursor <= fin) {
      dias.push(isoDia(cursor));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    }
    return dias;
  }

  // Episodios de UNA falla (vehículo|diagnóstico|modo|controlador). `regs` ya viene ordenado por fecha.
  // Un episodio empieza en la transición hacia Active; si se reactiva a los pocos minutos de apagarse
  // (DEBOUNCE_REACTIVACION_MIN) sigue siendo el mismo. `truncado`: el primer registro de la ventana ya era
  // Active, así que el inicio real puede ser anterior.
  function episodiosDeRegistros(regs) {
    var episodios = [], actual = null, activoAnterior = false, finUltimo = null;
    regs.forEach(function (r, i) {
      var fecha = new Date(r.dateTime);
      var activo = registroActivo(r);
      if (activo) {
        var nivel = criticidadDeRegistro(r);
        if (!activoAnterior) {
          var parpadeo = actual && finUltimo && (fecha - finUltimo) <= DEBOUNCE_REACTIVACION_MIN * 60 * 1000;
          if (parpadeo) actual.fin = null;
          else { actual = { inicio: fecha, fin: null, nivel: nivel, truncado: i === 0 }; episodios.push(actual); }
        }
        if (RANGO_CRITICIDAD[nivel] > RANGO_CRITICIDAD[actual.nivel]) actual.nivel = nivel;
      } else if (activoAnterior) {
        finUltimo = fecha;
        actual.fin = fecha;
      }
      activoAnterior = activo;
    });
    return { episodios: episodios, activoFinal: activoAnterior };
  }

  // Devuelve { activos: [fila], activaciones: [fila] } con los campos que lee el motor del reporte
  // (scopeVersion 2). `registros` = FaultData de la flota en alcance entre (desde - semilla) y el corte.
  function construirEscopos(registros, catalogos, infoDispositivos, empresaNombre, desde, hasta, corte) {
    var porClave = {};
    (registros || []).forEach(function (r) {
      if (!r.device || !r.dateTime || !r.diagnostic) return;
      var idDiag = idDeRef(r.diagnostic), ctrl = idDeRef(r.controller);
      if (esGoFault(idDiag, catalogos, ctrl)) return;
      var clave = idDeRef(r.device) + '|' + idDiag + '|' + idDeRef(r.failureMode) + '|' + ctrl;
      (porClave[clave] = porClave[clave] || []).push(r);
    });

    var activos = [], activaciones = [];
    Object.keys(porClave).forEach(function (clave) {
      var partes = clave.split('|');
      var info = infoDispositivos[partes[0]];
      if (!info) return;
      var regs = porClave[clave].slice().sort(function (a, b) { return new Date(a.dateTime) - new Date(b.dateTime); });
      var res = episodiosDeRegistros(regs);
      if (!res.episodios.length) return;

      var diagInfo = catalogos.dicDiag[partes[1]] || { nombre: 'Diagnóstico desconocido', codigo: null };
      var fmInfo = (partes[2] && partes[2] !== 'undefined' && partes[2] !== 'null') ? (catalogos.dicFm[partes[2]] || { nombre: '', codigo: null }) : { nombre: '', codigo: null };
      var codigo = formatearCodigo(diagInfo, fmInfo);
      var ultimo = regs[regs.length - 1], tUltimo = new Date(ultimo.dateTime);
      var activoAlCorte = res.activoFinal && (corte - tUltimo) <= VENTANA_CONFIRMACION_MS;
      var epActual = activoAlCorte ? res.episodios[res.episodios.length - 1] : null;
      var segActivo = epActual ? Math.max(0, (corte - epActual.inicio) / 1000) : 0;
      var habiaAntes = regs.some(function (r) { return registroActivo(r) && new Date(r.dateTime) < desde; });
      var base = {
        id: clave, device: partes[0], movil: info.nombre, placa: info.placa, tipo: info.tipologia, marca: info.marca,
        empresa: empresaNombre, categoria: resolverSistema(diagInfo.nombre), codigo: codigo, diagnostico: diagInfo.nombre,
        descripcion: fmInfo.nombre || 'Sin modo de falla', estado: activoAlCorte ? 'Activo' : 'Inactivo',
        tipo_falla: (habiaAntes || res.episodios.length > 1) ? 'Recurrente' : 'Nueva', falla: info.nombre + ' · ' + codigo,
        seconds: segActivo,
        inicio: epActual ? (epActual.truncado ? 'Antes de ' : '') + fechaHoraCorta(epActual.inicio) : '—',
        duracion: epActual ? (epActual.truncado ? '≥ ' : '') + formatearDuracion(segActivo) : '0 s',
        ultima: fechaHoraCorta(tUltimo), ultimaIso: tUltimo.toISOString()
      };

      if (activoAlCorte) {
        activos.push(Object.assign({}, base, {
          criticidad: criticidadDeRegistro(ultimo), activaciones: 0, dias: [], activationDays: {}, activationCritDays: {},
          primera: fechaHoraCorta(epActual.inicio), primeraIso: epActual.inicio.toISOString()
        }));
      }

      var enPeriodo = res.episodios.filter(function (e) { return e.inicio >= desde && e.inicio <= hasta; });
      if (enPeriodo.length) {
        var porDia = {}, critDia = {}, mejor = 'BAJA';
        enPeriodo.forEach(function (e) {
          var d = isoDia(e.inicio);
          porDia[d] = (porDia[d] || 0) + 1;
          critDia[d] = critDia[d] || {};
          critDia[d][e.nivel] = (critDia[d][e.nivel] || 0) + 1;
          if (RANGO_CRITICIDAD[e.nivel] > RANGO_CRITICIDAD[mejor]) mejor = e.nivel;
        });
        activaciones.push(Object.assign({}, base, {
          criticidad: mejor, activaciones: enPeriodo.length, dias: Object.keys(porDia).sort(), activationDays: porDia,
          activationCritDays: critDia, primera: fechaHoraCorta(enPeriodo[0].inicio), primeraIso: enPeriodo[0].inicio.toISOString(),
          ultima: fechaHoraCorta(enPeriodo[enPeriodo.length - 1].inicio), ultimaIso: enPeriodo[enPeriodo.length - 1].inicio.toISOString()
        }));
      }
    });

    activos.sort(function (a, b) { return (RANGO_CRITICIDAD[b.criticidad] - RANGO_CRITICIDAD[a.criticidad]) || (b.seconds - a.seconds); });
    activaciones.sort(function (a, b) { return (b.activaciones - a.activaciones) || (RANGO_CRITICIDAD[b.criticidad] - RANGO_CRITICIDAD[a.criticidad]); });
    activos.forEach(function (f, i) { f.reviewIndex = i; });
    // reviewIndex = posición en los datos de las fichas: primero los activos y luego las activaciones.
    activaciones.forEach(function (f, i) { f.reviewIndex = activos.length + i; });
    return { activos: activos, activaciones: activaciones };
  }

  // --- Kilometraje y horas de motor para las fichas (StatusData) ----------------------------------------
  // Valores medidos en esta cuenta: DiagnosticOdometerAdjustmentId en METROS y DiagnosticEngineHoursAdjustmentId en
  // SEGUNDOS (la ficha los muestra en km y h). Se toma la lectura más cercana a la fecha de la falla, con tolerancia.
  var DIAG_ODOMETRO = 'DiagnosticOdometerAdjustmentId';
  var DIAG_HORAS_MOTOR = 'DiagnosticEngineHoursAdjustmentId';
  var TOLERANCIA_CONTADOR_MS = 12 * 60 * 60 * 1000;
  var VEHICULOS_POR_LOTE = 8;

  function serieOrdenada(registros, divisor) {
    return (registros || []).filter(function (r) { return r && r.dateTime && typeof r.data === 'number'; })
      .map(function (r) { return [new Date(r.dateTime).getTime(), r.data / divisor]; })
      .sort(function (a, b) { return a[0] - b[0]; });
  }

  // Lectura más cercana a tMs (búsqueda binaria) o null si la más cercana está fuera de la tolerancia.
  function valorCercano(serie, tMs) {
    if (!serie || !serie.length) return null;
    var lo = 0, hi = serie.length - 1;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (serie[mid][0] < tMs) lo = mid + 1; else hi = mid; }
    var mejor = serie[lo];
    if (lo > 0 && Math.abs(serie[lo - 1][0] - tMs) < Math.abs(mejor[0] - tMs)) mejor = serie[lo - 1];
    return Math.abs(mejor[0] - tMs) <= TOLERANCIA_CONTADOR_MS ? mejor[1] : null;
  }

  function obtenerContadores(idsDispositivos, desde, hasta) {
    var resultado = {};
    function pedir(id, diag) {
      return apiCall('Get', { typeName: 'StatusData', search: { deviceSearch: { id: id }, diagnosticSearch: { id: diag }, fromDate: desde.toISOString(), toDate: hasta.toISOString() } });
    }
    var lotes = [];
    for (var i = 0; i < idsDispositivos.length; i += VEHICULOS_POR_LOTE) lotes.push(idsDispositivos.slice(i, i + VEHICULOS_POR_LOTE));
    return lotes.reduce(function (cadena, lote) {
      return cadena.then(function () {
        return Promise.all(lote.map(function (id) {
          return Promise.all([pedir(id, DIAG_ODOMETRO), pedir(id, DIAG_HORAS_MOTOR)]).then(function (r) {
            resultado[id] = { km: serieOrdenada(r[0], 1000), horas: serieOrdenada(r[1], 3600) };
          });
        }));
      });
    }, Promise.resolve()).then(function () { return resultado; });
  }

  // Datos de las fichas PDF de revisión (el generador ya viene dentro de la plantilla). Orden = activos y luego
  // activaciones, que es lo que espera reviewIndex. `contadores` (opcional) = { idDispositivo: {km, horas} }; sin él
  // (o sin lectura cercana) la ficha muestra "—". shortcut: sin modelo del vehículo; agregar leyendo Device si se necesita.
  function construirFichas(escopos, periodoTexto, corte, contadores) {
    function instantanea(iso, idDisp) {
      var c = contadores && contadores[idDisp], t = new Date(iso).getTime();
      var km = c ? valorCercano(c.km, t) : null, h = c ? valorCercano(c.horas, t) : null;
      return { at: iso, km: km == null ? null : { value: km }, hours: h == null ? null : { value: h }, status: (km == null && h == null) ? 'NO_DATA' : 'OK' };
    }
    function fila(f) {
      return {
        mobile: f.movil, plate: f.placa, company: f.empresa, brand: f.marca, model: '', vehicle_type: f.tipo, codes: f.codigo,
        description: f.diagnostico, failure_description: f.descripcion, severity: f.criticidad, state: f.estado,
        first_at: f.primeraIso, last_at: f.ultimaIso, category: f.categoria,
        counters: { primera: instantanea(f.primeraIso, f.device), ultima: instantanea(f.ultimaIso, f.device) }
      };
    }
    return { rows: escopos.activos.map(fila).concat(escopos.activaciones.map(fila)), period: periodoTexto, generated_at: corte.toISOString() };
  }

  function formatearCodigo(diagInfo, fmInfo) {
    var spn = (diagInfo && diagInfo.codigo !== null && diagInfo.codigo !== undefined) ? diagInfo.codigo : '—';
    var fmi = (fmInfo && fmInfo.codigo !== null && fmInfo.codigo !== undefined) ? fmInfo.codigo : '—';
    return 'SPN ' + spn + ' / FMI ' + fmi;
  }

  // --- Tablas de detalle y dataset del reporte v2 ------------------------------------------------------
  // Columnas, filtros cruzados y celdas EXACTOS a los que lee el motor (ver el ejemplo del paquete).
  var COLUMNAS_ACTIVOS = ['Móvil', 'Diagnóstico', 'Descripción', 'Criticidad', 'Nueva o recurrente', 'Duración activa', 'Inicio de la activación',
    'Último registro', 'Índice de ficha', 'Códigos', 'Sistema', 'Placa', 'Empresa', 'Tipo', 'Marca', 'Falla', 'Fechas', 'Buscar'];
  var COLUMNAS_ACTIVACIONES = ['Móvil', 'Diagnóstico', 'Descripción', 'Criticidad', 'Nueva o recurrente', 'Activaciones', 'Primera activación',
    'Última activación', 'Índice de ficha', 'Códigos', 'Sistema', 'Placa', 'Empresa', 'Tipo', 'Marca', 'Falla', 'Fechas', 'Buscar'];
  var CROSSFILTER_DETALLE = [
    { column: 'Sistema', key: 'sistema', label: 'Sistema', match: 'exact' },
    { column: 'Criticidad', key: 'criticidad', label: 'Criticidad', match: 'exact' },
    { column: 'Móvil', key: 'movil', label: 'Móvil', match: 'exact' },
    { column: 'Tipo', key: 'tipo', label: 'Tipología', match: 'exact' },
    { column: 'Marca', key: 'marca', label: 'Marca', match: 'exact' },
    { column: 'Empresa', key: 'empresa', label: 'Empresa', match: 'exact' },
    { column: 'Códigos', key: 'diagnostico', label: 'Código', match: 'exact' },
    { column: 'Nueva o recurrente', key: 'tipo_falla', label: 'Nueva o recurrente', match: 'exact' },
    { column: 'Falla', key: 'falla', label: 'Falla', match: 'exact' },
    { column: 'Fechas', key: 'dia', label: 'Fecha', match: 'contains' }
  ];

  function celdaBuscar(f) {
    return { text: 'Buscar código ↗', href: 'https://www.google.com/search?q=' + encodeURIComponent(f.codigo + ' ' + f.diagnostico + ' ' + f.marca) };
  }

  function filaDetalle(f, esActivos) {
    var pill = { text: f.criticidad, kind: 'pill', tone: f.criticidad.toLowerCase() };
    var medida;
    if (esActivos) {
      medida = { text: f.duracion, sort: f.seconds };
    } else {
      pill.periodSeverity = true; pill.byDay = f.activationCritDays;
      medida = { text: String(f.activaciones), kind: 'period_activations', byDay: f.activationCritDays };
    }
    return [f.movil, f.diagnostico, f.descripcion, pill, f.tipo_falla, medida,
      esActivos ? f.inicio : f.primera, esActivos ? f.ultima : f.ultima, f.reviewIndex, f.codigo, f.categoria, f.placa,
      f.empresa, f.tipo, f.marca, f.falla, esActivos ? '' : f.dias.join(','), celdaBuscar(f)];
  }

  function construirTablaDetalle(filas, esActivos) {
    return {
      columns: esActivos ? COLUMNAS_ACTIVOS : COLUMNAS_ACTIVACIONES,
      rows: filas.map(function (f) { return filaDetalle(f, esActivos); }),
      pageSize: 20,
      crossfilter: CROSSFILTER_DETALLE,
      secondaryColumns: ['Códigos', 'Sistema', 'Descripción', 'Inicio de la activación', 'Último registro', 'Primera activación', 'Última activación', 'Placa'],
      hiddenColumns: ['Empresa', 'Tipo', 'Marca', 'Falla', 'Fechas', 'Índice de ficha']
    };
  }

  function construirFlota(dispositivosEnAlcance, infoDispositivos, empresaNombre) {
    return dispositivosEnAlcance.map(function (d) {
      var info = infoDispositivos[d.id] || { nombre: d.name || d.id, marca: 'Sin marca', tipologia: 'Sin tipología asignada' };
      return { device: d.id, movil: info.nombre, tipo: info.tipologia, marca: info.marca, empresa: empresaNombre };
    });
  }

  function construirDataset(escopos, flota, diasIso) {
    return {
      kind: 'fault_dashboard', scopeVersion: 2, rows: [],
      scopes: { activos: escopos.activos, activaciones: escopos.activaciones },
      fleet: flota, activeCrit: ['ALTA', 'MEDIA', 'BAJA'],
      critColors: { ALTA: '#dc2626', MEDIA: '#b45309', BAJA: '#64748b' },
      dayLabels: diasIso, baseFlota: flota.length, fleetSizes: {}, topN: 12
    };
  }

  function construirFiltrosLi(empresaNombre, desde, hasta, baseFlota) {
    return [
      'Empresa: ' + empresaNombre,
      'Periodo: ' + formatearFechaCorta(desde) + ' → ' + formatearFechaCorta(hasta),
      'Flota analizada: ' + baseFlota + ' vehículo(s) del catálogo',
      'Fallos activos: último registro Active de las últimas 24 h antes del corte',
      'Fallos de Geotab (GoFault): excluidos (solo camión y OBD)'
    ].map(function (t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('');
  }

  // --- Ensamblado del HTML final ---------------------------------------------
  function inyectarJson(html, id, objeto) {
    var marcador = '<script type="application/json" id="' + id + '">{}</script>';
    if (html.indexOf(marcador) === -1) {
      console.warn('Mantenimiento: no se encontró el bloque de datos ' + id + ' en la plantilla.');
      return html;
    }
    var json = JSON.stringify(objeto).replace(/<\/script/gi, '<\\/script');
    var reemplazo = '<script type="application/json" id="' + id + '">' + json + '</script>';
    return html.split(marcador).join(reemplazo);
  }

  function reemplazarBloque(html, marcador, reemplazo) {
    if (html.indexOf(marcador) === -1) {
      console.warn('Mantenimiento: no se encontró el marcador esperado en la plantilla: ' + marcador);
      return html;
    }
    return html.split(marcador).join(reemplazo);
  }

  // Ensamblado: la plantilla ya trae el motor y los estilos del reporte (generada con construir_plantilla_v2.py);
  // aquí solo se sustituyen los marcadores y los 3 bloques de datos.
  function ensamblarReporteHtml(plantillaHtml, datos) {
    var html = plantillaHtml;
    html = reemplazarBloque(html, '{{EMPRESA}}', escapeHtml(datos.empresaNombre));
    html = reemplazarBloque(html, '{{PERIODO_VALUE}}', escapeHtml(datos.periodoValue));
    html = reemplazarBloque(html, '{{PERIODO_DETAIL}}', escapeHtml(datos.periodoDetail));
    html = reemplazarBloque(html, '{{PERIODO_FECHAS}}', escapeHtml(datos.periodoFechas));
    html = reemplazarBloque(html, '{{GENERADO}}', escapeHtml(datos.generadoTexto));
    html = reemplazarBloque(html, '{{FILTROS_LI}}', datos.filtrosLi);
    html = reemplazarBloque(html, '{{SEMILLA_DIAS}}', String(SEMILLA_DIAS));
    html = inyectarJson(html, 'data-dashboard-dataset', datos.dataset);
    html = inyectarJson(html, 'data-fault-review', datos.fichas);
    html = inyectarJson(html, 'data-activos_detalle', datos.tablaActivos);
    html = inyectarJson(html, 'data-activaciones_detalle', datos.tablaActivaciones);
    return html;
  }

  function descargarHtml(nombreArchivo, contenidoHtml) {
    var blob = new Blob([contenidoHtml], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = nombreArchivo;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function slug(texto) {
    return (texto || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos (marcas diacríticas combinadas)
      .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'EMPRESA';
  }

  // --- Flujo principal: generar y descargar -----------------------------------
  function generarReporte(empresaId, empresaNombre, desde, hasta, presetTexto) {
    if (cargaEnCurso) return;
    cargaEnCurso = true;
    actualizarBoton(true);
    actualizarEstado('Cargando grupos y vehículos…', 'loading');

    obtenerGruposYDispositivos()
      .then(function (resultado) {
        var grupos = resultado[0], dispositivos = resultado[1];
        var arbol = construirMapaEmpresas(grupos);
        var infoDispositivos = {};
        var dispositivosEnAlcance = [];
        dispositivos.forEach(function (d) {
          var info = resolverInfoDispositivo(d, arbol.mapa);
          if (info.empresa !== empresaNombre) return;
          infoDispositivos[d.id] = info;
          dispositivosEnAlcance.push(d);
        });

        if (!dispositivosEnAlcance.length) {
          throw new Error('No se encontraron vehículos en el grupo "' + empresaNombre + '". Revisa la jerarquía de grupos en Geotab.');
        }

        actualizarEstado('Consultando fallas en Geotab (puede tardar si el rango es amplio)…', 'loading');
        var idsEnAlcance = {};
        dispositivosEnAlcance.forEach(function (d) { idsEnAlcance[d.id] = true; });

        // Ventana: desde (rango - semilla) hasta AHORA. La sección "activos" siempre se evalúa al corte (ahora), y la
        // semilla permite reconocer episodios que venían de antes del rango.
        var corte = new Date();
        var desdeConsulta = new Date(desde.getTime() - SEMILLA_DIAS * 24 * 60 * 60 * 1000);
        var hastaConsulta = hasta > corte ? hasta : corte;

        // Flota chica: una consulta por vehículo (mucho menos datos que traer toda la base); flota grande: una sola consulta.
        var pFallas = dispositivosEnAlcance.length <= LIMITE_CONSULTA_POR_DISPOSITIVO
          ? Promise.all(dispositivosEnAlcance.map(function (d) { return obtenerFaultDataPaginado(desdeConsulta, hastaConsulta, d.id); }))
              .then(function (listas) { return [].concat.apply([], listas); })
          : obtenerFaultDataPaginado(desdeConsulta, hastaConsulta);

        return Promise.all([pFallas, obtenerCatalogosDiagnosticos()])
          .then(function (r2) {
            var registrosCrudos = r2[0], catalogos = r2[1];
            var registros = registrosCrudos.filter(function (r) { return r.device && idsEnAlcance[idDeRef(r.device)]; });

            actualizarEstado('Procesando ' + registros.length.toLocaleString('es-CO') + ' registros de fallas…', 'loading');
            var escopos = construirEscopos(registros, catalogos, infoDispositivos, empresaNombre, desde, hasta, corte);
            var flota = construirFlota(dispositivosEnAlcance, infoDispositivos, empresaNombre);
            var diasEnRango = Math.max(1, Math.round((hasta - desde) / (24 * 60 * 60 * 1000)) + 1);

            var datos = {
              empresaNombre: empresaNombre,
              periodoValue: formatearFechaCorta(desde) + ' → ' + formatearFechaCorta(hasta),
              periodoDetail: (presetTexto || 'Rango personalizado') + ' · ' + diasEnRango + (diasEnRango === 1 ? ' día' : ' días'),
              periodoFechas: pad(desde.getDate()) + '/' + pad(desde.getMonth() + 1) + '/' + desde.getFullYear() + ' → ' +
                pad(hasta.getDate()) + '/' + pad(hasta.getMonth() + 1) + '/' + hasta.getFullYear(),
              generadoTexto: formatearGenerado(corte),
              filtrosLi: construirFiltrosLi(empresaNombre, desde, hasta, flota.length),
              dataset: construirDataset(escopos, flota, construirDiasIso(desde, hasta)),
              tablaActivos: construirTablaDetalle(escopos.activos, true),
              tablaActivaciones: construirTablaDetalle(escopos.activaciones, false)
            };

            // Kilometraje y horas de motor para las fichas: si falla (permisos, red) el reporte sale igual, sin esos datos.
            var idsConFallas = {};
            escopos.activos.concat(escopos.activaciones).forEach(function (f) { idsConFallas[f.device] = true; });
            actualizarEstado('Consultando kilometraje y horas de motor…', 'loading');
            return obtenerContadores(Object.keys(idsConFallas), desdeConsulta, corte)
              .catch(function (err) { console.warn('Mantenimiento: sin kilometraje/horas para las fichas:', err); return null; })
              .then(function (contadores) {
                datos.fichas = construirFichas(escopos, (presetTexto || 'Rango personalizado') + ' · ' + datos.periodoFechas + ' (' + diasEnRango + (diasEnRango === 1 ? ' día)' : ' días)'), corte, contadores);
                actualizarEstado('Generando el archivo del reporte…', 'loading');
                return obtenerPlantilla().then(function (plantilla) {
                var htmlFinal = ensamblarReporteHtml(plantilla, datos);
                var nombreArchivo = 'reporte_fallas_' + slug(empresaNombre) + '_' + aFechaInputValue(new Date()).slice(0, 10) + '.html';
                descargarHtml(nombreArchivo, htmlFinal);
                actualizarEstado('Descarga iniciada — ' + escopos.activos.length + ' falla(s) activa(s) al corte y ' + escopos.activaciones.length +
                  ' con activaciones en el período, en ' + flota.length + ' vehículo(s) del catálogo.' + (contadores ? '' : ' (Sin kilometraje ni horas de motor en las fichas.)'), 'success');
                });
              });
          });
      })
      .catch(function (err) {
        console.error('Mantenimiento:', err);
        actualizarEstado((err && err.message) ? err.message : 'Ocurrió un error al generar el reporte.', 'error');
      })
      .then(function () {
        cargaEnCurso = false;
        actualizarBoton(false);
      });
  }

  // --- Retroalimentación visual: alerta en línea (carga / éxito / error) -----
  // CAMBIO (2026-09-29, pedido explícito de diseño): antes era un texto plano
  // que solo cambiaba de color. Ahora es una alerta con fondo suave + icono,
  // con 3 estados visuales (T.color.info* para "cargando", success* para
  // "listo", danger* -- ya existía -- para error). `tipo` nulo/vacío oculta
  // la alerta por completo (mismo uso que antes con texto '').
  var ICONOS_ALERTA = {
    loading: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex:none;margin-top:1px;animation:rptxGirar 0.85s linear infinite"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="34 300"/></svg>',
    success: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex:none;margin-top:1px"><circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.14"/><path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex:none;margin-top:1px"><circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.14"/><path d="M12 7.5v6M12 16.7v.1" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>'
  };
  var ESTILOS_ALERTA = {
    loading: { background: T.color.infoSoft, color: T.color.infoText, border: T.color.infoBorder },
    success: { background: T.color.successSoft, color: T.color.successText, border: T.color.successBorder },
    error: { background: T.color.dangerSoft, color: T.color.danger, border: T.color.dangerBorder }
  };

  function actualizarEstado(texto, tipo) {
    if (!elementos.estado) return;
    var el = elementos.estado;
    if (!texto || !tipo) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    var estilo = ESTILOS_ALERTA[tipo] || ESTILOS_ALERTA.error;
    aplicarEstilo(el, {
      display: 'flex', alignItems: 'flex-start', gap: '9px', padding: '10px 13px',
      borderRadius: T.radius.sm, background: estilo.background, color: estilo.color,
      border: '1px solid ' + estilo.border, fontSize: '0.83rem', lineHeight: '1.4'
    });
    el.innerHTML = (ICONOS_ALERTA[tipo] || '') + '<span>' + escapeHtml(texto) + '</span>';
  }

  function actualizarBoton(deshabilitado) {
    if (!elementos.botonGenerar) return;
    elementos.botonGenerar.disabled = deshabilitado;
  }

  // --- Hoja de estilos inyectada (CSSOM) --------------------------------------
  // Geotab elimina las etiquetas <style> que vienen en el HTML del add-in, pero
  // UNA creada y adjuntada por JS en tiempo de ejecución sí sobrevive -- es la
  // única forma de lograr :focus/:hover/:active/@media reales (un inline style
  // por sí solo no puede expresar pseudo-clases ni media queries). Sin
  // precedente en este repo (dashboardAnalisisFallas.js resuelve todo con
  // estilos inline estáticos, sin estados interactivos) -- se documenta aquí
  // por si sirve de referencia para otro add-in más adelante. Con guarda para
  // no duplicar el <style> si el add-in se reinicializa.
  function inyectarEstilosGlobales() {
    if (document.getElementById('rptx-estilos')) return;
    var css = '' +
      '.rptx-control{transition:border-color .15s ease,box-shadow .15s ease}' +
      '.rptx-control:focus{outline:none;border-color:' + T.color.ink + ';box-shadow:0 0 0 3px rgba(26,34,53,.14)}' +
      // CAMBIO (2026-09-29, corrección pedida: el botón activo se veía
      // "tosco", desbordando el carril gris al ganar fondo blanco + sombra):
      // transition:all (no solo background/color) para que la sombra tampoco
      // aparezca de golpe, y una sombra bien delicada (antes 0.1 de opacidad,
      // ahora 0.05) que no compite visualmente con el carril que la contiene.
      '.rptx-pill{transition:all .2s ease}' +
      '.rptx-pill:hover{color:' + T.color.ink + '}' +
      '.rptx-pill.is-active{background:#FFFFFF;color:' + T.color.ink + ';box-shadow:0 2px 4px rgba(0,0,0,.05)}' +
      '.rptx-btn-primary{transition:background .15s ease,box-shadow .15s ease,transform .08s ease}' +
      '.rptx-btn-primary:hover:not(:disabled){background:' + T.color.successDark + ';box-shadow:0 4px 14px rgba(16,185,129,.32)}' +
      '.rptx-btn-primary:active:not(:disabled){transform:translateY(1px)}' +
      '.rptx-btn-primary:disabled{opacity:.55;cursor:not-allowed}' +
      '@keyframes rptxGirar{to{transform:rotate(360deg)}}' +
      '@media (max-width:620px){.rptx-form-grid{grid-template-columns:1fr !important}}';
    var style = document.createElement('style');
    style.id = 'rptx-estilos';
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  }

  // --- Construcción de la UI ---------------------------------------------------
  function construirEncabezado(contenedor) {
    var panel = crearPanel({
      padding: '20px 24px', marginBottom: '16px',
      background: 'linear-gradient(135deg, ' + T.color.ink + ' 0%, #1B2C5C 100%)'
    });
    var filaTitulo = crear('div', { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' });
    var chip = crear('div', {
      width: '34px', height: '34px', minWidth: '34px', borderRadius: T.radius.sm,
      background: 'rgba(255,255,255,0.12)', color: '#FFFFFF', display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: '1rem', fontWeight: '700'
    }, '📄');
    filaTitulo.appendChild(chip);
    var bloqueTitulo = crear('div');
    bloqueTitulo.appendChild(crear('h2', { margin: '0', color: '#FFFFFF', fontSize: '1.15rem', fontWeight: '800' }, 'Mantenimiento'));
    bloqueTitulo.appendChild(crear('div', { color: '#C7D2E0', fontSize: '0.78rem', marginTop: '2px' }, 'Reporte ejecutivo de Fallas, por empresa y rango de fechas, en un HTML descargable'));
    filaTitulo.appendChild(bloqueTitulo);
    panel.appendChild(filaTitulo);
    contenedor.appendChild(panel);
    return panel;
  }

  function construirFormulario(contenedor) {
    var panel = crearPanel({ padding: '22px 24px', marginBottom: '16px' });

    function envoltorioCampo(etiqueta) {
      var env = crear('div', { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '0' });
      env.appendChild(crear('label', {
        fontSize: '0.72rem', color: '#64748b', fontWeight: '600',
        textTransform: 'uppercase', letterSpacing: '.04em'
      }, etiqueta));
      return env;
    }

    var estiloControl = {
      height: '40px', padding: '0 12px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm,
      fontSize: '0.87rem', fontFamily: T.font, color: T.color.textoOscuro, background: '#FFFFFF',
      appearance: 'none', WebkitAppearance: 'none', width: '100%', boxSizing: 'border-box'
    };

    var envEmpresa = envoltorioCampo('Empresa');
    var selectEmpresa = crear('select', estiloControl);
    selectEmpresa.className = 'rptx-control';
    envEmpresa.appendChild(selectEmpresa);

    var ahora = new Date();
    var hace7 = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);

    var envDesde = envoltorioCampo('Desde');
    var inputDesde = crear('input', estiloControl);
    inputDesde.className = 'rptx-control';
    inputDesde.type = 'datetime-local';
    inputDesde.value = aFechaInputValue(hace7);
    envDesde.appendChild(inputDesde);

    var envHasta = envoltorioCampo('Hasta');
    var inputHasta = crear('input', estiloControl);
    inputHasta.className = 'rptx-control';
    inputHasta.type = 'datetime-local';
    inputHasta.value = aFechaInputValue(ahora);
    envHasta.appendChild(inputHasta);

    var presetTexto = { valor: 'Última semana' };

    var envPills = envoltorioCampo('Atajos');
    var grupoPills = crear('div', {
      display: 'inline-flex', background: '#F1F5F9', borderRadius: T.radius.sm,
      padding: '4px', gap: '2px', alignItems: 'stretch', height: '40px', boxSizing: 'border-box', width: '100%'
    });
    grupoPills.className = 'rptx-pill-group';
    envPills.appendChild(grupoPills);

    function crearPill(texto, activaInicial) {
      var btn = crear('button', {
        border: 'none', background: 'transparent', padding: '0 12px', borderRadius: '7px',
        fontSize: '0.78rem', fontWeight: '600', color: T.color.textoGris, cursor: 'pointer', fontFamily: T.font,
        flex: '1 1 0', minWidth: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
      }, texto);
      btn.type = 'button';
      btn.className = 'rptx-pill' + (activaInicial ? ' is-active' : '');
      return btn;
    }

    function marcarPillActiva(pillElegida) {
      Array.prototype.forEach.call(grupoPills.children, function (p) {
        p.classList.toggle('is-active', p === pillElegida);
      });
    }

    // CAMBIO (2026-10-01): este add-in vuelve a tener un solo modo (Fallas) --
    // el Mini Expediente se movió por completo a Alertas por Severidad
    // (_build_alertas_fallas/), que ya resolvía conductor/turno por fila y no
    // necesitaba picker (la fila de la tabla YA ES la selección). Misma
    // simplificación que ya se hizo aquí cuando se separó Operaciones a su
    // propio add-in -- ver cambios/2026-10-01_quitar-mini-expediente.md. Se
    // quitó la pill "Tipo de reporte" (Fallas/Mini Expediente), su branch en
    // el handler de envío, y el sub-formulario de picker/entrada manual.

    var botonSemana = crearPill('Última semana', true);
    botonSemana.addEventListener('click', function () {
      var h = new Date();
      var d = new Date(h.getTime() - 7 * 24 * 60 * 60 * 1000);
      inputDesde.value = aFechaInputValue(d); inputHasta.value = aFechaInputValue(h);
      presetTexto.valor = 'Última semana';
      marcarPillActiva(botonSemana);
    });

    var botonMes = crearPill('Último mes', false);
    botonMes.addEventListener('click', function () {
      var h = new Date();
      var d = new Date(h.getTime() - 30 * 24 * 60 * 60 * 1000);
      inputDesde.value = aFechaInputValue(d); inputHasta.value = aFechaInputValue(h);
      presetTexto.valor = 'Últimos 30 días';
      marcarPillActiva(botonMes);
    });

    grupoPills.appendChild(botonSemana);
    grupoPills.appendChild(botonMes);

    inputDesde.addEventListener('change', function () { presetTexto.valor = 'Rango personalizado'; marcarPillActiva(null); });
    inputHasta.addEventListener('change', function () { presetTexto.valor = 'Rango personalizado'; marcarPillActiva(null); });

    var iconoDescarga = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex:none"><path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var botonGenerar = crear('button', {
      display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '11px 22px',
      background: T.color.success, color: '#FFFFFF', border: 'none', borderRadius: T.radius.sm,
      fontWeight: '700', fontSize: '0.88rem', cursor: 'pointer', fontFamily: T.font,
      boxShadow: '0 1px 2px rgba(16,185,129,.28)', alignSelf: 'flex-end', whiteSpace: 'nowrap'
    });
    botonGenerar.className = 'rptx-btn-primary';
    botonGenerar.innerHTML = iconoDescarga + '<span>Generar y descargar reporte</span>';
    botonGenerar.addEventListener('click', function () {
      var empresaId = selectEmpresa.value;
      var empresaNombre = selectEmpresa.options[selectEmpresa.selectedIndex] ? selectEmpresa.options[selectEmpresa.selectedIndex].textContent : '';
      if (!empresaId) { actualizarEstado('Elige una empresa antes de generar el reporte.', 'error'); return; }

      var desde = new Date(inputDesde.value), hasta = new Date(inputHasta.value);
      if (!inputDesde.value || !inputHasta.value || isNaN(desde) || isNaN(hasta)) { actualizarEstado('Revisa el rango de fechas.', 'error'); return; }
      if (desde >= hasta) { actualizarEstado('"Desde" debe ser anterior a "Hasta".', 'error'); return; }
      generarReporte(empresaId, empresaNombre, desde, hasta, presetTexto.valor);
    });

    var filaCampos = crear('div', {
      // CAMBIO (2026-10-03, pedido del usuario): Empresa va en su propia fila a
      // todo el ancho -- compartiendo fila con las fechas le tocaban ~170px y
      // nombres como "ESTACIÓN DE TRANSFERENCIA ZIPA" o "PROMO AMBIENTAL
      // DISTRITO BOGOTA" salían cortados; las fechas y los atajos también
      // quedaban apretados. Ahora: fila 1 Empresa, fila 2 Desde | Hasta | Atajos.
      display: 'grid', gridTemplateColumns: 'minmax(170px,1fr) minmax(170px,1fr) minmax(200px,1.1fr)',
      gap: '14px', alignItems: 'end'
    });
    filaCampos.className = 'rptx-form-grid';
    envEmpresa.style.gridColumn = '1 / -1';
    filaCampos.appendChild(envEmpresa);
    filaCampos.appendChild(envDesde);
    filaCampos.appendChild(envHasta);
    filaCampos.appendChild(envPills);
    panel.appendChild(filaCampos);

    var filaAccion = crear('div', { display: 'flex', justifyContent: 'flex-end', marginTop: '18px' });
    filaAccion.appendChild(botonGenerar);
    panel.appendChild(filaAccion);

    var estado = crear('div', { marginTop: '14px', display: 'none' });
    panel.appendChild(estado);

    contenedor.appendChild(panel);
    return { selectEmpresa: selectEmpresa, botonGenerar: botonGenerar, estado: estado };
  }


  function cargarEmpresasEnSelector(selectEmpresa) {
    return obtenerGruposYDispositivos().then(function (resultado) {
      var arbol = construirMapaEmpresas(resultado[0]);
      var seleccionPrevia = selectEmpresa.value;
      selectEmpresa.innerHTML = '';
      if (!arbol.empresasDisponibles.length) {
        var opcionVacia = crear('option', null, 'Sin grupos de empresa disponibles');
        opcionVacia.value = '';
        selectEmpresa.appendChild(opcionVacia);
        actualizarEstado('No se encontró ningún grupo candidato a "empresa" bajo la raíz de grupos de esta cuenta.', 'error');
        return;
      }
      arbol.empresasDisponibles.forEach(function (e) {
        var opcion = crear('option', null, e.nombre);
        opcion.value = e.id;
        selectEmpresa.appendChild(opcion);
      });
      var sigueValida = Array.prototype.some.call(selectEmpresa.options, function (o) { return o.value === seleccionPrevia; });
      if (sigueValida) selectEmpresa.value = seleccionPrevia;
    }).catch(function (err) {
      console.error('Mantenimiento: no se pudieron cargar los grupos/empresas:', err);
      actualizarEstado('No se pudieron cargar las empresas disponibles: ' + ((err && err.message) || err), 'error');
    });
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi;
      state = freshState;

      inyectarEstilosGlobales();

      contenedorPrincipal = document.getElementById('mantenimientoRoot');
      aplicarEstilo(contenedorPrincipal, {
        fontFamily: T.font, background: T.color.canvas, padding: '16px',
        maxWidth: '760px', margin: '0 auto', boxSizing: 'border-box'
      });

      construirEncabezado(contenedorPrincipal);
      var refs = construirFormulario(contenedorPrincipal);
      elementos.selectEmpresa = refs.selectEmpresa;
      elementos.botonGenerar = refs.botonGenerar;
      elementos.estado = refs.estado;

      initializedCallback();
    },

    focus: function (freshApi, freshState) {
      api = freshApi;
      state = freshState;
      actualizarEstado('Cargando empresas disponibles…', 'loading');
      cargarEmpresasEnSelector(elementos.selectEmpresa).then(function () {
        if (elementos.selectEmpresa.value) actualizarEstado('', null);
      });
    },

    blur: function () { /* sin auto-refresco: este add-in no deja nada corriendo en segundo plano */ }
  };
};
