/* ARCHIVO GENERADO por herramientas/construir_addins_regeneracion.py -- NO EDITAR A MANO.
   Editar _build_regeneracion_comun/*.js o _build_regeneracion_reportes/reportesRegeneracion.parte.js y volver a ejecutar el script. */

geotab.addin.reportesRegeneracion = function () {
  'use strict';
  // ============================================================================
  // LÓGICA PURA de regeneración DPF (sin DOM ni API de Geotab) -- parte 1/2.
  //
  // Puerto a JS de scripts ya validados con datos reales (herramientas/):
  //   - detectar_regeneracion_dpf.py -> limpiarLecturasHollin / detectarEpisodiosHollin
  //   - reporte_regeneracion_ciudades.py -> umbral de hollín "próximo" por marca
  //   - vigilancia_cumplimiento_regeneracion.py -> reconstruirLampara (logica_2_lampara.js)
  //
  // Los archivos de _build_regeneracion_comun/ se concatenan tal cual en los
  // 3 add-ins de regeneración (herramientas/construir_addins_regeneracion.py) y
  // herramientas/probar_regeneracion_js.py los compara contra la salida de los
  // scripts Python con datos reales. Un ajuste de criterio debe hacerse AQUÍ y
  // en el script Python equivalente, no en uno solo.
  // ============================================================================

  // --- Identificadores de diagnóstico (mismos de herramientas/) ---------------
  var ID_DIAG_HOLLIN = 'aYtF4cSGobUSRCKo8yfjyIg';
  var ID_DIAG_LAMPARA = 'DiagnosticDieselParticulateFilterLampId';
  var ID_DIAG_INTERRUPTOR = 'aXfHYX0HFtUaOOr_scNuSsg';
  var ID_DIAG_IGNICION = 'DiagnosticIgnitionId';
  // "Estado de regeneración activa" del filtro de partículas: encendido = el motor está regenerando. Lo usa el
  // tablero de Seguimiento (el aviso por Telegram usa el mismo diagnóstico: dd.ID_DIAGNOSTICO_REGEN_ACTIVA).
  var ID_DIAG_REGEN_ACTIVA = 'a2MenjAEB90iHUfy6X1oc2A';
  // Regla cuyo alcance de grupos define "la flota con DPF" (la misma que usan
  // vigilancia_cumplimiento_regeneracion.py y reporte_regeneracion_ciudades.py:
  // 83 vehículos el 2026-10-27). El ID no cambia si alguien renombra la regla;
  // el nombre queda de respaldo.
  var ID_REGLA_ALCANCE = 'aQ06wSzKCu0iGNW-dBoI9kQ';
  var NOMBRE_REGLA_ALCANCE = 'Regeneración Manual Inactiva y Lámpara DPF Encendida - C';

  // --- Detector de regeneraciones por caída de hollín -------------------------
  // Valores validados el 2026-10-03 contra 40 regeneraciones de referencia.
  var UMBRAL_TECHO_PCT = 199;       // el sensor se queda pegado en el techo: no es lectura real
  var SALTO_RUIDO_PP = 40;          // subida brusca >= esto en <= SALTO_RUIDO_SEG es ruido
  var SALTO_RUIDO_SEG = 300;
  var VENTANA_SOSTENIDA_MIN = 15;   // la caída debe sostenerse este tiempo
  var VENTANA_BUSQUEDA_MIN = 40;    // 30 min de muestreo + margen (bug real 2026-09-25)
  var CAIDA_MINIMA_PCT = 10;
  var DEBOUNCE_MIN = 15;

  // --- Hollín actual / "próximo a regenerar" -----------------------------------
  var HOLLIN_PROXIMO_DEFECTO = 80;
  var UMBRAL_HOLLIN_POR_MARCA = [['foton', 95], ['kenworth', 100]];
  var HOLLIN_MAX_VALIDO = 150;      // una lectura >= 150 AISLADA (la anterior no era alta) se descarta como ruido
  var HORAS_HOLLIN_RECIENTE = 48;

  var MS_MIN = 60 * 1000;
  var MS_HORA = 60 * MS_MIN;
  var MS_DIA = 24 * MS_HORA;

  function umbralHollinMarca(marca) {
    var m = (marca || '').toLowerCase();
    for (var i = 0; i < UMBRAL_HOLLIN_POR_MARCA.length; i++) {
      if (m.indexOf(UMBRAL_HOLLIN_POR_MARCA[i][0]) === 0) return UMBRAL_HOLLIN_POR_MARCA[i][1];
    }
    return HOLLIN_PROXIMO_DEFECTO;
  }

  // filas de StatusData de Geotab -> [[ms, valor], ...] ordenado por tiempo
  function aMuestras(filas) {
    var salida = [];
    (filas || []).forEach(function (x) {
      if (!x || x.data === null || x.data === undefined) return;
      var valor = Number(x.data);
      var t = Date.parse(x.dateTime);
      if (isNaN(valor) || isNaN(t)) return;
      salida.push([t, valor]);
    });
    salida.sort(function (a, b) { return a[0] - b[0]; });
    return salida;
  }

  // --- Hollín: limpieza y detección de episodios -----------------------------
  function limpiarLecturasHollin(lecturas) {
    var limpias = [];
    for (var i = 0; i < lecturas.length; i++) {
      var t = lecturas[i][0], v = lecturas[i][1];
      if (v >= UMBRAL_TECHO_PCT) continue;
      if (limpias.length) {
        var ant = limpias[limpias.length - 1];
        if (v - ant[1] >= SALTO_RUIDO_PP && (t - ant[0]) / 1000 <= SALTO_RUIDO_SEG) continue;
      }
      limpias.push([t, v]);
    }
    return limpias;
  }

  // lecturas: [[ms, %]] SIN limpiar. Devuelve [{inicio, fin, valorInicio, valorFin, caida, duracionMin}]
  function detectarEpisodiosHollin(lecturas) {
    var limpias = limpiarLecturasHollin(lecturas);
    var n = limpias.length;
    if (n < 2) return [];

    var candidatos = [];
    for (var i = 0; i < n; i++) {
      var tI = limpias[i][0], vI = limpias[i][1];
      var limite = tI + VENTANA_BUSQUEDA_MIN * MS_MIN;
      var vMin = vI, tMin = tI;
      var j = i + 1;
      while (j < n && limpias[j][0] <= limite) {
        if (limpias[j][1] < vMin) { vMin = limpias[j][1]; tMin = limpias[j][0]; }
        j++;
      }
      var caida = vI - vMin;
      if (caida >= CAIDA_MINIMA_PCT) {
        candidatos.push({ inicio: tI, fin: tMin, valorInicio: vI, valorFin: vMin, caida: caida });
      }
    }
    if (!candidatos.length) return [];

    // Fusionar candidatos a menos de DEBOUNCE_MIN entre sí.
    var episodios = [JSON.parse(JSON.stringify(candidatos[0]))];
    for (var k = 1; k < candidatos.length; k++) {
      var c = candidatos[k];
      var anterior = episodios[episodios.length - 1];
      if ((c.inicio - anterior.inicio) / 1000 <= DEBOUNCE_MIN * 60) {
        if (c.valorFin < anterior.valorFin) {
          anterior.fin = c.fin;
          anterior.valorFin = c.valorFin;
          anterior.caida = anterior.valorInicio - anterior.valorFin;
        }
      } else {
        episodios.push(JSON.parse(JSON.stringify(c)));
      }
    }

    // Solo cuentan las caídas que se sostienen (el hollín no rebota más de la mitad de lo que bajó).
    var sostenidos = episodios.filter(function (e) {
      return limpias.every(function (l) {
        if (!(l[0] > e.fin && l[0] <= e.fin + VENTANA_SOSTENIDA_MIN * MS_MIN)) return true;
        return l[1] <= e.valorFin + e.caida / 2;
      });
    });
    sostenidos.forEach(function (e) { e.duracionMin = Math.round((e.fin - e.inicio) / MS_MIN * 10) / 10; });
    return sostenidos;
  }

  // Última lectura de hollín válida y reciente: {valor, t} o null.
  // Una lectura >= HOLLIN_MAX_VALIDO solo se descarta si está aislada (la anterior no era alta):
  // si se repite en lecturas seguidas es real (caso 1148-NWW623: 26 % -> 174 % y se sostuvo 30 min).
  function ultimoHollinValido(lecturas, ahoraMs) {
    var mejor = null, anterior = null;
    for (var i = 0; i < lecturas.length; i++) {
      var t = lecturas[i][0], v = lecturas[i][1];
      if (t > ahoraMs) continue;
      var aislada = v >= HOLLIN_MAX_VALIDO && !(anterior !== null && anterior >= HOLLIN_MAX_VALIDO);
      anterior = v;
      if (aislada) continue;
      if (!mejor || t > mejor.t) mejor = { valor: v, t: t };
    }
    if (mejor && (ahoraMs - mejor.t) > HORAS_HOLLIN_RECIENTE * MS_HORA) return null;
    return mejor;
  }

  // Hollín pegado en el techo del sensor: las últimas lecturas (>= 2 seguidas) son >= UMBRAL_TECHO_PCT. {valor, t, desde} o null.
  // Una lectura de techo aislada es ruido (limpiarLecturasHollin la descarta); si se repite durante horas es un filtro
  // saturado o un sensor pegado y no debe pasar inadvertida (caso 3804-GVU088, 03/11/2026: 200 % por más de 3 h y el
  // tablero lo mostraba "en curso" con el último hollín válido de hacía 3 h).
  function hollinPegadoEnTecho(lecturas, ahoraMs) {
    var validas = lecturas.filter(function (p) { return p[0] <= ahoraMs; });
    var n = validas.length, i = n - 1;
    while (i >= 0 && validas[i][1] >= UMBRAL_TECHO_PCT) i--;
    if (n - 1 - i < 2) return null;
    return { valor: validas[n - 1][1], t: validas[n - 1][0], desde: validas[i + 1][0] };
  }

  // Lecturas para dibujar la gráfica: las limpias más las de techo que se repiten (>= 2 seguidas).
  function lecturasParaGrafica(lecturas) {
    var extra = [];
    for (var i = 1; i < lecturas.length; i++) {
      if (lecturas[i][1] >= UMBRAL_TECHO_PCT && lecturas[i - 1][1] >= UMBRAL_TECHO_PCT) extra.push(lecturas[i]);
    }
    return limpiarLecturasHollin(lecturas).concat(extra).sort(function (a, b) { return a[0] - b[0]; });
  }

  function mediana(valores) {
    if (!valores.length) return null;
    var o = valores.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(o.length / 2);
    return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
  }

  // ============================================================================
  // LÓGICA PURA de regeneración DPF -- parte 2/2: lámpara / interruptor manual.
  //
  // Puerto de procesar_vehiculo (vigilancia_cumplimiento_regeneracion.py) para
  // UNA pasada sobre toda la ventana, sin estado persistido -- igual que su
  // ciclo_backfill. Reglas que vienen de bugs reales de esa vigilancia
  // (2026-10-03), todas conservadas aquí:
  //   - un 0 de lámpara solo cierra el episodio si NO vuelve a 1 en
  //     MARGEN_REENCENDIDO_MIN (la lámpara parpadea sin que haya regenerado),
  //   - un 0 con el motor apagado, o a <= MARGEN_APAGADO_MOTOR_MIN de apagarlo,
  //     se ignora (al apagar el motor la lámpara reporta 0),
  //   - un 0 con el interruptor manual activo se ignora (manual en curso),
  //   - episodios < DURACION_MINIMA_EPISODIO_MIN sin interruptor no cuentan,
  //   - el tiempo se mide en horas de MOTOR ENCENDIDO, no de calendario.
  // ============================================================================

  // --- Vigilancia de la lámpara ------------------------------------------------
  var UMBRAL_HORAS_ALERTA_CONDUCTOR = 2;   // horas de MOTOR ENCENDIDO (no de calendario)
  var UMBRAL_HORAS_ESCALADO_CONDUCTOR = 4;
  var UMBRAL_HORAS_ALERTA_TALLER = 24;     // horas desde que se activó el interruptor
  var MARGEN_REENCENDIDO_MIN = 20;
  var MARGEN_APAGADO_MOTOR_MIN = 2;
  var DURACION_MINIMA_EPISODIO_MIN = 5;
  var VENTANA_LOOKBACK_MIN = 90;

  // muestras*: [[ms, valor]] ordenadas. Devuelve:
  //   episodios: solicitudes ya CERRADAS [{inicio, fin, horas, manual, interruptorDesde, minMotorHastaAccion, minMotor}]
  //   abierto:   episodio en curso o null {desde, cierrePendiente, interruptorDesde, horasTotal, horasMotor, horasDesdeInterruptor}
  //   motorEncendido, interruptorActivo: último estado conocido
  function reconstruirLampara(muestrasLampara, muestrasInterruptor, muestrasIgnicion, ahoraMs) {
    var orden = { ignicion: 0, lampara: 1, interruptor: 2 };
    var eventos = [];
    muestrasLampara.forEach(function (m) { eventos.push([m[0], 'lampara', m[1]]); });
    muestrasInterruptor.forEach(function (m) { eventos.push([m[0], 'interruptor', m[1]]); });
    muestrasIgnicion.forEach(function (m) { eventos.push([m[0], 'ignicion', m[1]]); });
    // Mismo timestamp: la ignición va primero, para que un 0 de lámpara simultáneo al apagado ya vea el motor apagado.
    eventos.sort(function (a, b) { return a[0] - b[0] || orden[a[1]] - orden[b[1]]; });

    var margen = MARGEN_REENCENDIDO_MIN * MS_MIN;
    var margenApagado = MARGEN_APAGADO_MOTOR_MIN * MS_MIN;
    var episodios = [];

    var lampOn = null, lampOff = null, interruptorDesde = null;
    var segMotor = 0, segMotorHastaAccion = null, cursor = null;
    var motorEncendido = null, interruptorActivo = false;

    function acumularMotor(hastaT) {
      if (motorEncendido === true && lampOn !== null && lampOff === null && cursor !== null) {
        var inicio = Math.max(cursor, lampOn);
        if (hastaT > inicio) segMotor += (hastaT - inicio) / 1000;
      }
      if (cursor === null || hastaT > cursor) cursor = hastaT;
    }

    function cerrarEpisodio(fin) {
      acumularMotor(fin);
      var parpadeo = interruptorDesde === null && (fin - lampOn) < DURACION_MINIMA_EPISODIO_MIN * MS_MIN;
      if (!parpadeo) {
        episodios.push({
          inicio: lampOn, fin: fin, abierta: false,
          horas: Math.round((fin - lampOn) / MS_HORA * 10) / 10,
          manual: interruptorDesde !== null, interruptorDesde: interruptorDesde,
          minMotorHastaAccion: Math.round((segMotorHastaAccion !== null ? segMotorHastaAccion : segMotor) / 60),
          minMotor: Math.round(segMotor / 60)
        });
      }
      lampOn = null; interruptorDesde = null; lampOff = null;
      segMotor = 0; segMotorHastaAccion = null;
    }

    eventos.forEach(function (ev) {
      var t = ev[0], senal = ev[1], val = ev[2];
      acumularMotor(t);
      if (senal === 'ignicion') {
        motorEncendido = val > 0;
        // Un 0 de lámpara un instante ANTES del apagado también es efecto del apagado.
        if (!motorEncendido && lampOff !== null && t - lampOff <= margenApagado) lampOff = null;
        return;
      }
      if (senal === 'lampara') {
        var encendida = val > 0;
        if (!encendida && motorEncendido === false) return;   // 0 con el motor apagado: no dice nada
        if (!encendida && interruptorActivo) return;          // 0 con el interruptor activo: manual en curso, no terminada
        if (encendida) {
          if (lampOff !== null) {
            if (t - lampOff <= margen) { lampOff = null; return; }   // parpadeo: mismo episodio
            cerrarEpisodio(lampOff);                                   // estuvo apagada de verdad; este 1 abre otro
          }
          if (lampOn === null) {
            lampOn = t; segMotor = 0; segMotorHastaAccion = null; interruptorDesde = null;
          }
        } else if (lampOn !== null) {
          if (lampOff === null) lampOff = t;
          else if (t - lampOff > margen) cerrarEpisodio(lampOff);
        }
      } else if (senal === 'interruptor') {
        interruptorActivo = val > 0;
        if (interruptorActivo) lampOff = null;   // un 0 previo de lámpara era el inicio de la manual
        if (val > 0 && lampOn !== null && interruptorDesde === null) {
          interruptorDesde = t;
          segMotorHastaAccion = segMotor;
        }
      }
    });

    // Sin lecturas nuevas que lo confirmen: se cierra cuando ya pasó el margen y la ventana de solape.
    if (lampOff !== null && ahoraMs - lampOff > Math.max(margen, VENTANA_LOOKBACK_MIN * MS_MIN)) {
      cerrarEpisodio(lampOff);
    }

    var abierto = null;
    if (lampOn !== null) {
      var segProvisional = segMotor;
      if (lampOff === null && motorEncendido === true && cursor !== null && ahoraMs > cursor) {
        segProvisional += (ahoraMs - Math.max(cursor, lampOn)) / 1000;
      }
      abierto = {
        desde: lampOn, cierrePendiente: lampOff !== null, interruptorDesde: interruptorDesde,
        horasTotal: (ahoraMs - lampOn) / MS_HORA, horasMotor: segProvisional / 3600,
        horasDesdeInterruptor: interruptorDesde !== null ? (ahoraMs - interruptorDesde) / MS_HORA : null
      };
    }
    return { episodios: episodios, abierto: abierto, motorEncendido: motorEncendido, interruptorActivo: interruptorActivo };
  }

  // Estado de atención de un episodio abierto, con el mismo criterio de los avisos de Telegram.
  // nivel: 0 informativo, 1 en observación, 2 avisar al conductor, 3 urgente
  function clasificarEstadoLampara(ab) {
    if (ab.interruptorDesde !== null) {
      if (ab.horasDesdeInterruptor >= UMBRAL_HORAS_ALERTA_TALLER) {
        return { codigo: 'TALLER', nivel: 3, etiqueta: 'Taller', texto: 'Activó el interruptor y la lámpara sigue encendida: posible falla, programar revisión en taller' };
      }
      return { codigo: 'EN_CURSO', nivel: 1, etiqueta: 'Manual en curso', texto: 'Regeneración manual activada, esperando que la lámpara se apague' };
    }
    if (ab.horasTotal >= 24 && ab.horasMotor < 1) {
      return { codigo: 'PARQUEADO', nivel: 0, etiqueta: 'Sin motor', texto: 'Casi sin motor encendido: posible vehículo parqueado o fuera de servicio' };
    }
    if (ab.horasMotor >= UMBRAL_HORAS_ESCALADO_CONDUCTOR) {
      return { codigo: 'ESCALADO', nivel: 3, etiqueta: 'Escalar', texto: 'El conductor aún no regenera: contactar al supervisor del turno' };
    }
    if (ab.horasMotor >= UMBRAL_HORAS_ALERTA_CONDUCTOR) {
      return { codigo: 'AVISAR', nivel: 2, etiqueta: 'Avisar', texto: 'Avisar al conductor: hacer la regeneración manual ahora' };
    }
    if (ab.cierrePendiente) {
      return { codigo: 'CERRANDO', nivel: 0, etiqueta: 'Cerrando', texto: 'Lámpara apagada hace poco: confirmando que la regeneración terminó' };
    }
    return { codigo: 'OBSERVACION', nivel: 1, etiqueta: 'Reciente', texto: 'Lámpara encendida hace poco, aún dentro del margen del conductor' };
  }

  // Resumen completo de un vehículo a partir de sus señales crudas.
  //   info = {id, nombre, ciudad, marca}
  //   sen  = { hollin, lampara, interruptor, ignicion } (cada uno [[ms, valor]], ordenado)
  //   desdeMs/hastaMs: rango de análisis; ahoraMs: instante de referencia del "estado actual"
  function analizarVehiculo(info, sen, desdeMs, hastaMs, ahoraMs) {
    var regeneraciones = detectarEpisodiosHollin(sen.hollin).filter(function (e) {
      return e.inicio >= desdeMs && e.inicio <= hastaMs;
    });
    var lamp = reconstruirLampara(sen.lampara, sen.interruptor, sen.ignicion, ahoraMs);
    var solicitudes = lamp.episodios.filter(function (e) { return e.inicio >= desdeMs && e.inicio <= hastaMs; });
    var estado = null;
    if (lamp.abierto) {
      estado = clasificarEstadoLampara(lamp.abierto);
      if (lamp.abierto.desde >= desdeMs && lamp.abierto.desde <= hastaMs) {
        solicitudes = solicitudes.concat([{
          inicio: lamp.abierto.desde, fin: null, abierta: true, horas: Math.round(lamp.abierto.horasTotal * 10) / 10,
          manual: lamp.abierto.interruptorDesde !== null, interruptorDesde: lamp.abierto.interruptorDesde,
          minMotorHastaAccion: Math.round(lamp.abierto.horasMotor * 60), minMotor: Math.round(lamp.abierto.horasMotor * 60)
        }]);
      }
    }
    var hollinActual = ultimoHollinValido(sen.hollin, ahoraMs);
    var umbral = umbralHollinMarca(info.marca);
    return {
      id: info.id, nombre: info.nombre, ciudad: info.ciudad, marca: info.marca,
      tieneHollin: sen.hollin.length > 0, tieneLampara: sen.lampara.length > 0,
      hollinActual: hollinActual, umbralHollin: umbral,
      proximo: !lamp.abierto && hollinActual !== null && hollinActual.valor >= umbral,
      regeneraciones: regeneraciones, solicitudes: solicitudes,
      abierto: lamp.abierto, estado: estado,
      interruptorActivo: lamp.interruptorActivo, motorEncendido: lamp.motorEncendido
    };
  }

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
  // Add-In: Reportes de Regeneraciones DPF
  //
  // Genera, para una ciudad (o todas) y un rango de fechas, un reporte HTML
  // AUTÓNOMO (datos incrustados, sin librerías externas, listo para imprimir a
  // PDF) y un CSV con el detalle. Mismos criterios que "Análisis de
  // Regeneraciones DPF" -- los números del reporte coinciden con el tablero.
  // ============================================================================

  var DIAS_RANGO_POR_DEFECTO = 7;
  var DIAS_HISTORIA_LAMPARA_PREVIA = 3;

  var elementos = {};
  var generando = false;

  function rangoPorDefecto(dias) {
    var hasta = new Date();
    return { desde: aFechaInputValue(new Date(hasta.getTime() - (dias || DIAS_RANGO_POR_DEFECTO) * MS_DIA)), hasta: aFechaInputValue(hasta) };
  }

  function calcular(desdeMs, hastaMs, ciudad, vehiculoId) {
    var ahoraMs = Math.min(hastaMs, Date.now());
    var previo = DIAS_HISTORIA_LAMPARA_PREVIA * MS_DIA;
    return obtenerAlcance().then(function (alcance) {
      var vehiculos = alcance.vehiculos.filter(function (v) { return (!ciudad || v.ciudad === ciudad) && (!vehiculoId || v.id === vehiculoId); });
      if (vehiculoId && !vehiculos.length) throw new Error('El vehículo elegido ya no está en el alcance del reporte; actualiza la página.');
      var rangos = {
        hollin: [desdeMs, hastaMs],
        lampara: [desdeMs - previo, hastaMs], interruptor: [desdeMs - previo, hastaMs], ignicion: [desdeMs - previo, hastaMs]
      };
      return cargarSenales(vehiculos, rangos, function (hechos, total) {
        establecerEstado('Consultando señales de Geotab… ' + hechos + ' de ' + total, false);
      }).then(function (senales) {
        return {
          desde: desdeMs, hasta: hastaMs, ciudad: ciudad, vehiculo: vehiculoId ? vehiculos[0].nombre : '',
          resultados: vehiculos.map(function (v) { return analizarVehiculo(v, senales[v.id], desdeMs, hastaMs, ahoraMs); })
        };
      });
    });
  }

  function resumir(resultados) {
    var s = { vehiculos: resultados.length, regeneraciones: 0, solicitudes: 0, manuales: 0, automaticas: 0, enCurso: 0, reacciones: [], conSolicitud: 0, lamparaEncendida: 0, sinSenal: [] };
    resultados.forEach(function (r) {
      s.regeneraciones += r.regeneraciones.length;
      s.solicitudes += r.solicitudes.length;
      if (r.solicitudes.length) s.conSolicitud++;
      if (r.abierto) s.lamparaEncendida++;
      if (!r.tieneHollin && !r.tieneLampara) s.sinSenal.push(r.nombre);
      r.solicitudes.forEach(function (e) {
        if (e.abierta) s.enCurso++;
        else if (e.manual) { s.manuales++; s.reacciones.push(e.minMotorHastaAccion); }
        else s.automaticas++;
      });
    });
    s.reaccionMediana = mediana(s.reacciones);
    return s;
  }

  // --- CSV -----------------------------------------------------------------------------
  function celdaCsv(v) {
    var t = (v === null || v === undefined) ? '' : String(v);
    return /[;"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }
  function num(n) { return n === null || n === undefined ? '' : String(Math.round(n * 10) / 10).replace('.', ','); }

  // Separador ";" y coma decimal: es lo que abre bien Excel en configuración regional de Colombia.
  function construirCsv(datos) {
    var filas = [['Vehículo', 'Ciudad', 'Marca', 'Tipo', 'Inicio', 'Fin', 'Duración (h)', 'Cómo se resolvió', 'Interruptor activado', 'Min de motor hasta actuar', 'Hollín antes (%)', 'Hollín después (%)']];
    datos.resultados.forEach(function (r) {
      r.solicitudes.forEach(function (e) {
        filas.push([r.nombre, r.ciudad, r.marca, 'Solicitud de lámpara', fmtFecha(e.inicio), e.abierta ? 'sigue encendida' : fmtFecha(e.fin), num(e.horas),
          e.abierta ? 'En curso' : (e.manual ? 'Manual' : 'Resuelta sola'), e.interruptorDesde ? fmtFecha(e.interruptorDesde) : '', e.minMotorHastaAccion, '', '']);
      });
      r.regeneraciones.forEach(function (e) {
        filas.push([r.nombre, r.ciudad, r.marca, 'Regeneración por hollín', fmtFecha(e.inicio), fmtFecha(e.fin), num(e.duracionMin / 60), '', '', '', Math.round(e.valorInicio), Math.round(e.valorFin)]);
      });
    });
    return '﻿' + filas.map(function (f) { return f.map(celdaCsv).join(';'); }).join('\r\n');
  }

  // --- Reporte HTML ------------------------------------------------------------------------
  var CSS_REPORTE =
    ':root{--ink:#1A2235;--body:#475569;--muted:#88929A;--border:#E5E9F0;--primary:#73B828;--primary-d:#59901D;--soft:#EAF4DF;--sol:#D97736;--reg:#73B828}' +
    '*{box-sizing:border-box}body{margin:0;background:#F4F5F8;color:var(--ink);font-family:Inter,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;font-size:13px}' +
    '.pag{max-width:1080px;margin:0 auto;padding:24px 20px}' +
    'header{background:#fff;border:1px solid var(--border);border-radius:14px;padding:20px 24px;margin-bottom:16px;border-top:5px solid var(--primary)}' +
    'h1{margin:0 0 4px;font-size:22px;letter-spacing:-.01em}h2{margin:0 0 4px;font-size:15px}.sub{color:var(--body);font-size:12.5px}' +
    '.kpis{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px}.kpi{flex:1 1 150px;background:#fff;border:1px solid var(--border);border-radius:12px;padding:14px 16px}' +
    '.kpi b{display:block;font-size:26px;letter-spacing:-.02em;line-height:1.1}.kpi span{font-size:12px;font-weight:700;color:var(--body)}.kpi i{display:block;font-style:normal;font-size:11px;color:var(--muted);margin-top:2px}' +
    '.card{background:#fff;border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:16px;break-inside:avoid}' +
    '.card p{margin:3px 0;color:var(--body)}.nota{font-size:11px;color:var(--muted);margin-top:8px}' +
    'table{width:100%;border-collapse:collapse;font-size:12px}th{background:#F4F5F8;color:var(--muted);text-transform:uppercase;font-size:10.5px;letter-spacing:.03em;text-align:left;padding:7px 9px}' +
    'td{padding:7px 9px;border-top:1px solid var(--border);vertical-align:top}td.n,th.n{text-align:right}' +
    '.barras{display:grid;grid-template-columns:62px 1fr 64px;gap:4px 10px;align-items:center;font-size:11.5px}' +
    '.b{height:9px;border-radius:4px;margin:1px 0}.b.s{background:var(--sol)}.b.r{background:var(--reg)}.lg{display:flex;gap:16px;font-size:11.5px;color:var(--body);margin-bottom:8px}' +
    '.lg em{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px;font-style:normal}' +
    '.p{display:inline-block;padding:1px 9px;border-radius:99px;font-size:11px;font-weight:700;background:#EEF1F5;color:#64748B}' +
    '.p.n3{background:#F7E8E8;color:#BA3B3B}.p.n2{background:#FCEBDD;color:#B45309}.p.n1{background:#FFF6DB;color:#92660A}' +
    '@media print{body{background:#fff}.pag{padding:0;max-width:none}header,.kpi,.card{box-shadow:none}@page{size:A4 landscape;margin:12mm}}';

  function narrativa(s) {
    var l = [];
    if (!s.solicitudes && !s.regeneraciones) {
      l.push('Sin solicitudes de regeneración ni regeneraciones detectadas en los ' + s.vehiculos + ' vehículos del reporte.');
      return l;
    }
    var cerradas = s.manuales + s.automaticas;
    l.push(s.solicitudes + ' solicitud(es) de regeneración (lámpara DPF encendida) en ' + s.conSolicitud + ' de ' + s.vehiculos + ' vehículos.' +
      (cerradas ? ' De las ' + cerradas + ' ya cerradas, ' + s.manuales + ' (' + Math.round(s.manuales / cerradas * 100) + ' %) se atendieron con el interruptor manual y ' + s.automaticas + ' se resolvieron solas.' : ''));
    if (s.reaccionMediana !== null) l.push('El conductor tardó una mediana de ' + fmtMinutos(s.reaccionMediana) + ' de motor encendido en activar el interruptor.');
    l.push(s.regeneraciones + ' regeneración(es) confirmada(s) por caída sostenida del hollín.');
    if (s.lamparaEncendida) l.push(s.lamparaEncendida + ' vehículo(s) tienen la lámpara encendida al cierre del rango.');
    return l;
  }

  function seccionTendencia(datos) {
    var dias = [], vistos = {};
    for (var t = datos.desde; t <= datos.hasta; t += MS_DIA) { var k = claveDia(t); if (!vistos[k]) { vistos[k] = true; dias.push({ clave: k, ms: t }); } }
    var kFin = claveDia(datos.hasta); if (!vistos[kFin]) dias.push({ clave: kFin, ms: datos.hasta });
    var sol = {}, reg = {};
    datos.resultados.forEach(function (r) {
      r.solicitudes.forEach(function (e) { var c = claveDia(e.inicio); sol[c] = (sol[c] || 0) + 1; });
      r.regeneraciones.forEach(function (e) { var c = claveDia(e.inicio); reg[c] = (reg[c] || 0) + 1; });
    });
    var max = 1;
    dias.forEach(function (d) { max = Math.max(max, sol[d.clave] || 0, reg[d.clave] || 0); });
    var h = '<div class="card"><h2>Tendencia diaria</h2><div class="lg"><span><em style="background:var(--sol)"></em>Solicitudes de lámpara</span><span><em style="background:var(--reg)"></em>Regeneraciones detectadas</span></div><div class="barras">';
    dias.forEach(function (d) {
      var a = sol[d.clave] || 0, b = reg[d.clave] || 0;
      h += '<div>' + escaparHtml(fmtDia(d.ms)) + '</div><div><div class="b s" style="width:' + (a / max * 100) + '%"></div><div class="b r" style="width:' + (b / max * 100) + '%"></div></div><div>' + a + ' · ' + b + '</div>';
    });
    return h + '</div></div>';
  }

  function seccionCiudades(datos) {
    var c = {};
    datos.resultados.forEach(function (r) {
      var x = c[r.ciudad] = c[r.ciudad] || { veh: 0, sol: 0, man: 0, reg: 0 };
      x.veh++; x.sol += r.solicitudes.length; x.reg += r.regeneraciones.length;
      r.solicitudes.forEach(function (e) { if (e.manual && !e.abierta) x.man++; });
    });
    var nombres = Object.keys(c).sort(function (a, b) { return c[b].sol - c[a].sol; });
    if (nombres.length < 2) return '';
    var h = '<div class="card"><h2>Por ciudad</h2><table><tr><th>Ciudad</th><th class="n">Vehículos</th><th class="n">Solicitudes</th><th class="n">Manuales</th><th class="n">Regeneraciones detectadas</th></tr>';
    nombres.forEach(function (n) { h += '<tr><td>' + escaparHtml(n) + '</td><td class="n">' + c[n].veh + '</td><td class="n">' + c[n].sol + '</td><td class="n">' + c[n].man + '</td><td class="n">' + c[n].reg + '</td></tr>'; });
    return h + '</table></div>';
  }

  function seccionEncendidas(datos) {
    var lista = datos.resultados.filter(function (r) { return r.abierto; }).sort(function (a, b) { return (b.estado.nivel - a.estado.nivel) || (b.abierto.horasMotor - a.abierto.horasMotor); });
    var h = '<div class="card"><h2>Con la lámpara encendida al cierre del rango (' + lista.length + ')</h2>';
    if (!lista.length) return h + '<p>Ningún vehículo con la lámpara DPF encendida.</p></div>';
    h += '<table><tr><th>Vehículo</th><th>Ciudad</th><th>Qué hacer</th><th>Lámpara desde</th><th class="n">Horas de motor</th><th class="n">Horas totales</th><th>Interruptor</th></tr>';
    lista.forEach(function (r) {
      h += '<tr><td>' + escaparHtml(r.nombre) + '</td><td>' + escaparHtml(r.ciudad) + '</td><td><span class="p n' + r.estado.nivel + '">' + escaparHtml(r.estado.etiqueta) + '</span> ' + escaparHtml(r.estado.texto) + '</td><td>' +
        escaparHtml(fmtFecha(r.abierto.desde)) + '</td><td class="n">' + fmtHoras(r.abierto.horasMotor) + '</td><td class="n">' + fmtHoras(r.abierto.horasTotal) + '</td><td>' +
        (r.abierto.interruptorDesde !== null ? 'desde ' + escaparHtml(fmtFecha(r.abierto.interruptorDesde)) : 'sin activar') + '</td></tr>';
    });
    return h + '</table></div>';
  }

  function seccionVehiculos(datos) {
    var lista = datos.resultados.filter(function (r) { return r.solicitudes.length || r.regeneraciones.length; })
      .sort(function (a, b) { return (b.solicitudes.length - a.solicitudes.length) || (b.regeneraciones.length - a.regeneraciones.length); });
    var h = '<div class="card"><h2>Detalle por vehículo (' + lista.length + ')</h2>';
    if (!lista.length) return h + '<p>Ningún vehículo tuvo solicitudes ni regeneraciones en el rango.</p></div>';
    h += '<table><tr><th>Vehículo</th><th>Ciudad</th><th>Marca</th><th class="n">Solicitudes</th><th class="n">Manuales</th><th class="n">Resueltas solas</th><th class="n">Regeneraciones detectadas</th><th class="n">Reacción mediana</th><th class="n">Lámpara más larga</th></tr>';
    lista.forEach(function (r) {
      var cerradas = r.solicitudes.filter(function (e) { return !e.abierta; });
      var man = cerradas.filter(function (e) { return e.manual; });
      var med = mediana(man.map(function (e) { return e.minMotorHastaAccion; }));
      var horas = r.solicitudes.length ? Math.max.apply(null, r.solicitudes.map(function (e) { return e.horas; })) : null;
      h += '<tr><td>' + escaparHtml(r.nombre) + '</td><td>' + escaparHtml(r.ciudad) + '</td><td>' + escaparHtml(r.marca) + '</td><td class="n">' + r.solicitudes.length + '</td><td class="n">' + man.length +
        '</td><td class="n">' + (cerradas.length - man.length) + '</td><td class="n">' + r.regeneraciones.length + '</td><td class="n">' + escaparHtml(fmtMinutos(med)) + '</td><td class="n">' + (horas === null ? '—' : fmtHoras(horas) + ' h') + '</td></tr>';
    });
    return h + '</table></div>';
  }

  function construirReporteHtml(datos) {
    var s = resumir(datos.resultados);
    var titulo = 'Reporte de Regeneraciones DPF — ' + (datos.vehiculo ? datos.vehiculo + ' (' + datos.resultados[0].ciudad + ')' : (datos.ciudad || 'Todas las ciudades'));
    var rango = fmtFecha(datos.desde) + ' → ' + fmtFecha(datos.hasta) + ' (hora Bogotá)';
    var pctManual = (s.manuales + s.automaticas) ? Math.round(s.manuales / (s.manuales + s.automaticas) * 100) + ' %' : '—';
    var h = '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escaparHtml(titulo) + '</title><style>' + CSS_REPORTE + '</style></head><body><div class="pag">';
    h += '<header><h1>' + escaparHtml(titulo) + '</h1><div class="sub">' + escaparHtml(rango) + ' · ' + s.vehiculos + (s.vehiculos === 1 ? ' vehículo' : ' vehículos') + ' con DPF · generado ' + escaparHtml(fmtFecha(Date.now())) + '</div></header>';
    h += '<div class="kpis">' +
      '<div class="kpi"><b>' + s.solicitudes + '</b><span>Solicitudes de regeneración</span><i>lámpara DPF encendida</i></div>' +
      '<div class="kpi"><b>' + s.regeneraciones + '</b><span>Regeneraciones detectadas</span><i>por caída sostenida del hollín</i></div>' +
      '<div class="kpi"><b>' + pctManual + '</b><span>Atendidas con interruptor manual</span><i>' + s.manuales + ' manuales · ' + s.automaticas + ' solas</i></div>' +
      '<div class="kpi"><b>' + escaparHtml(fmtMinutos(s.reaccionMediana)) + '</b><span>Reacción del conductor</span><i>mediana, minutos de motor encendido</i></div>' +
      '<div class="kpi"><b>' + s.lamparaEncendida + '</b><span>Con lámpara encendida</span><i>al cierre del rango</i></div></div>';
    h += '<div class="card"><h2>Lectura del periodo</h2>' + narrativa(s).map(function (t) { return '<p>' + escaparHtml(t) + '</p>'; }).join('') + '</div>';
    h += seccionTendencia(datos) + seccionCiudades(datos) + seccionEncendidas(datos) + seccionVehiculos(datos);
    if (s.sinSenal.length) {
      h += '<div class="card"><h2>Vehículos sin señal (' + s.sinSenal.length + ')</h2><p>No reportan hollín ni lámpara DPF, por lo que este reporte no puede evaluarlos: ' + escaparHtml(s.sinSenal.join(', ')) + '.</p></div>';
    }
    h += '<div class="nota">Método: una solicitud es un episodio de lámpara DPF encendida (se ignoran parpadeos de menos de 5 min y ceros con el motor apagado o con el interruptor manual activo). ' +
      'Una regeneración detectada es una caída sostenida del hollín de 10 puntos o más en 40 min. Los tiempos de reacción cuentan solo con el motor encendido. ' +
      'Vehículos: los del alcance de la regla "' + escaparHtml(NOMBRE_REGLA_ALCANCE) + '".</div>';
    return h + '</div></body></html>';
  }

  // --- Interfaz -----------------------------------------------------------------------------
  function establecerEstado(texto, esError) {
    if (!elementos.estado) return;
    elementos.estado.textContent = texto;
    elementos.estado.style.color = esError ? T.color.danger : T.color.body;
  }

  function nombreArchivo(datos, extension) {
    return 'Reporte_Regeneracion_' + slug(datos.vehiculo || datos.ciudad || 'TODAS') + '_' + claveDia(datos.desde) + '_' + claveDia(datos.hasta) + '.' + extension;
  }

  function generar(formato) {
    if (generando) return;
    var desde = new Date(elementos.inputDesde.value), hasta = new Date(elementos.inputHasta.value);
    if (isNaN(desde.getTime()) || isNaN(hasta.getTime()) || desde >= hasta) { establecerEstado('El rango no es válido: "Desde" debe ser anterior a "Hasta".', true); return; }
    generando = true;
    elementos.botones.forEach(function (b) { b.disabled = true; b.style.opacity = '0.55'; });
    establecerEstado('Consultando señales de Geotab…', false);
    calcular(desde.getTime(), hasta.getTime(), elementos.ciudad.valor(), elementos.vehiculo.valor())
      .then(function (datos) {
        if (formato === 'csv') descargarArchivo(nombreArchivo(datos, 'csv'), construirCsv(datos), 'text/csv;charset=utf-8');
        else descargarArchivo(nombreArchivo(datos, 'html'), construirReporteHtml(datos), 'text/html;charset=utf-8');
        var s = resumir(datos.resultados);
        establecerEstado('Listo: ' + nombreArchivo(datos, formato === 'csv' ? 'csv' : 'html') + ' (' + s.solicitudes + ' solicitudes, ' + s.regeneraciones + ' regeneraciones detectadas, ' + s.vehiculos + (s.vehiculos === 1 ? ' vehículo).' : ' vehículos).'), false);
      })
      .catch(function (err) {
        console.error('Reportes de Regeneraciones:', err);
        establecerEstado(describirError(err), true);
      })
      .then(function () {
        generando = false;
        elementos.botones.forEach(function (b) { b.disabled = false; b.style.opacity = '1'; });
      });
  }

  // Lista desplegable PROPIA con búsqueda (no un <select> nativo): el popup nativo del navegador se
  // pintaba mal dentro del iframe de Copiloto (más angosto que el campo y sin texto), y con 85 móviles
  // conviene poder escribir para filtrar. Estilos por CSSOM como el resto del add-in.
  function normalizarTexto(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

  function crearBuscador(etiqueta) {
    var envoltorio = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px', position: 'relative', width: '100%' });
    envoltorio.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.muted, fontWeight: '600' }, etiqueta));
    var entrada = crear('input', { padding: '8px 34px 8px 10px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm, fontSize: '0.82rem', fontFamily: T.font, color: T.color.ink, background: '#FFFFFF', width: '100%', boxSizing: 'border-box' });
    entrada.type = 'text'; entrada.setAttribute('autocomplete', 'off'); entrada.placeholder = 'Escribe para buscar…';
    var flecha = crear('div', { position: 'absolute', right: '12px', bottom: '9px', fontSize: '0.7rem', color: T.color.muted, pointerEvents: 'none' }, '▼');
    var lista = crear('div', {
      display: 'none', position: 'absolute', left: '0', right: '0', top: '100%', marginTop: '2px', zIndex: '1000', maxHeight: '280px', overflowY: 'auto',
      background: '#FFFFFF', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm, boxShadow: '0 6px 18px rgba(15,23,42,0.16)'
    });
    envoltorio.appendChild(entrada); envoltorio.appendChild(flecha); envoltorio.appendChild(lista);

    var opciones = [], valor = '', visibles = [], activo = -1, alCambiar = null;
    function etiquetaDe(v) { for (var i = 0; i < opciones.length; i++) if (opciones[i].valor === v) return opciones[i].etiqueta; return ''; }
    function cerrar() { lista.style.display = 'none'; entrada.value = etiquetaDe(valor); }
    function elegir(v) { var cambio = v !== valor; valor = v; cerrar(); if (cambio && alCambiar) alCambiar(v); }
    function resaltar(i) {
      activo = i;
      Array.prototype.forEach.call(lista.children, function (el, k) { el.style.background = k === i ? T.color.primarySoft : '#FFFFFF'; });
      if (lista.children[i] && lista.children[i].scrollIntoView) lista.children[i].scrollIntoView({ block: 'nearest' });
    }
    function pintar(filtro) {
      vaciar(lista);
      var q = normalizarTexto(filtro);
      visibles = opciones.filter(function (o) { return !q || normalizarTexto(o.etiqueta).indexOf(q) !== -1; });
      if (!visibles.length) { lista.appendChild(crear('div', { padding: '10px 12px', fontSize: '0.8rem', color: T.color.muted }, 'Sin coincidencias')); activo = -1; return; }
      visibles.forEach(function (o, i) {
        var fila = crear('div', { padding: '8px 12px', fontSize: '0.82rem', fontFamily: T.font, color: T.color.ink, background: '#FFFFFF', cursor: 'pointer', fontWeight: o.valor === valor ? '700' : '400' }, o.etiqueta);
        fila.addEventListener('mousedown', function (e) { e.preventDefault(); elegir(o.valor); });   // mousedown: antes de que el campo pierda el foco
        fila.addEventListener('mouseenter', function () { resaltar(i); });
        lista.appendChild(fila);
      });
      activo = -1;
    }
    function abrir() { pintar(''); lista.style.display = 'block'; entrada.select(); }

    entrada.addEventListener('focus', abrir);
    entrada.addEventListener('click', function () { if (lista.style.display === 'none') abrir(); });
    entrada.addEventListener('input', function () { pintar(entrada.value); lista.style.display = 'block'; if (visibles.length) resaltar(0); });
    entrada.addEventListener('blur', function () { setTimeout(cerrar, 120); });
    entrada.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (lista.style.display === 'none') abrir(); else if (visibles.length) resaltar(Math.min(visibles.length - 1, activo + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (visibles.length) resaltar(Math.max(0, activo - 1)); }
      else if (e.key === 'Enter') { e.preventDefault(); if (activo >= 0 && visibles[activo]) elegir(visibles[activo].valor); else if (visibles.length === 1) elegir(visibles[0].valor); }
      else if (e.key === 'Escape') { cerrar(); entrada.blur(); }
    });

    return {
      envoltorio: envoltorio,
      cargar: function (nuevas, elegido) { opciones = nuevas; valor = elegido !== undefined ? elegido : ''; entrada.value = etiquetaDe(valor); },
      valor: function () { return valor; },
      alCambiar: function (fn) { alCambiar = fn; }
    };
  }

  // Móviles (vehículos) de la ciudad elegida; al cambiar la ciudad se vuelve a "Todos".
  function cargarVehiculos() {
    var ciudad = elementos.ciudad.valor();
    var lista = (elementos.vehiculosAlcance || []).filter(function (v) { return !ciudad || v.ciudad === ciudad; });
    var opciones = [{ valor: '', etiqueta: 'Todos los vehículos (' + lista.length + ')' }];
    lista.forEach(function (v) { opciones.push({ valor: v.id, etiqueta: v.nombre + (v.marca && v.marca !== 'Sin marca' ? ' — ' + v.marca : '') }); });
    elementos.vehiculo.cargar(opciones, '');
  }

  function cargarCiudades() {
    return obtenerAlcance().then(function (alcance) {
      var m = {};
      alcance.vehiculos.forEach(function (v) { m[v.ciudad] = (m[v.ciudad] || 0) + 1; });
      var opciones = [{ valor: '', etiqueta: 'Todas las ciudades (' + alcance.vehiculos.length + ' vehículos)' }];
      Object.keys(m).sort().forEach(function (c) { opciones.push({ valor: c, etiqueta: c + ' (' + m[c] + ')' }); });
      elementos.ciudad.cargar(opciones, '');
      elementos.vehiculosAlcance = alcance.vehiculos;
      cargarVehiculos();
    }).catch(function (err) {
      console.error('Reportes de Regeneraciones:', err);
      establecerEstado(describirError(err), true);
    });
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi; state = freshState;
      var raiz = document.getElementById('reportesRegeneracionRoot');
      aplicarEstilo(raiz, { fontFamily: T.font, background: T.color.canvas, padding: '4px' });
      raiz.appendChild(crearEncabezado('📄', 'Reportes de Regeneraciones DPF',
        'Genera un reporte HTML autónomo (para imprimir a PDF o enviar) y un CSV con el detalle, por ciudad, vehículo (móvil) y rango de fechas.'));

      var panel = crearPanel({ margin: '16px 22px', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px' });
      elementos.ciudad = crearBuscador('Ciudad');
      elementos.ciudad.cargar([{ valor: '', etiqueta: 'Cargando ciudades…' }], '');
      panel.appendChild(elementos.ciudad.envoltorio);
      elementos.vehiculo = crearBuscador('Vehículo (móvil)');
      elementos.vehiculo.cargar([{ valor: '', etiqueta: 'Cargando vehículos…' }], '');
      elementos.ciudad.alCambiar(cargarVehiculos);
      panel.appendChild(elementos.vehiculo.envoltorio);

      var r0 = rangoPorDefecto();
      var campoDesde = crearCampoFecha('Desde', r0.desde), campoHasta = crearCampoFecha('Hasta', r0.hasta);
      elementos.inputDesde = campoDesde.input; elementos.inputHasta = campoHasta.input;
      var filaFechas = crear('div', { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-end' });
      filaFechas.appendChild(campoDesde.envoltorio);
      filaFechas.appendChild(campoHasta.envoltorio);
      [7, 14, 30].forEach(function (d) {
        var b = crearBoton('Últimos ' + d + ' días', false);
        b.addEventListener('click', function () { var r = rangoPorDefecto(d); campoDesde.input.value = r.desde; campoHasta.input.value = r.hasta; });
        filaFechas.appendChild(b);
      });
      panel.appendChild(filaFechas);

      var botonHtml = crearBoton('Generar reporte HTML', true), botonCsv = crearBoton('Descargar CSV', false);
      botonHtml.addEventListener('click', function () { generar('html'); });
      botonCsv.addEventListener('click', function () { generar('csv'); });
      elementos.botones = [botonHtml, botonCsv];
      var filaBotones = crear('div', { display: 'flex', gap: '10px', flexWrap: 'wrap' });
      filaBotones.appendChild(botonHtml); filaBotones.appendChild(botonCsv);
      panel.appendChild(filaBotones);

      elementos.estado = crear('div', { fontSize: '0.82rem', color: T.color.body, minHeight: '1.2em' });
      panel.appendChild(elementos.estado);
      raiz.appendChild(panel);

      cargarCiudades().then(function () { initializedCallback(); });
    },

    focus: function (freshApi, freshState) { api = freshApi; state = freshState; },
    blur: function () {}
  };

};
