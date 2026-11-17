/* ARCHIVO GENERADO por herramientas/construir_addins_regeneracion.py -- NO EDITAR A MANO.
   Editar _build_regeneracion_comun/*.js o _build_regeneracion_analisis/analisisRegeneracion.parte.js y volver a ejecutar el script. */

geotab.addin.analisisRegeneracion = function () {
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
  // Add-In: Análisis de Regeneraciones DPF
  //
  // Tablero HISTÓRICO: cuántas veces pidió regeneración cada vehículo (lámpara
  // DPF), cuántas atendió el conductor con el interruptor manual vs. cuántas
  // se resolvieron solas, cuánto tardó en reaccionar (en minutos de MOTOR
  // ENCENDIDO) y cuántas regeneraciones reales se detectaron por caída de
  // hollín. Para el estado EN VIVO ver "Seguimiento de Regeneraciones"; para
  // sacar el reporte imprimible ver "Reportes de Regeneraciones".
  // ============================================================================

  var DIAS_RANGO_POR_DEFECTO = 14;
  var DIAS_HISTORIA_LAMPARA_PREVIA = 3;   // para saber si ya venía encendida al inicio del rango
  var TOP_N = 8;

  var elementos = {};
  var datosCache = null;           // { desde, hasta, resultados: [analisis por vehículo] }
  var filtros = { ciudad: '', marca: '', vehiculo: '' };
  var cargaEnCurso = false;
  var contenedorResultados = null;
  var refsFiltros = null;
  var charts = [];

  function rangoPorDefecto(dias) {
    var hasta = new Date();
    var desde = new Date(hasta.getTime() - (dias || DIAS_RANGO_POR_DEFECTO) * MS_DIA);
    return { desde: aFechaInputValue(desde), hasta: aFechaInputValue(hasta) };
  }

  // --- Cálculo ------------------------------------------------------------------
  function calcular(desdeMs, hastaMs) {
    var ahoraMs = Math.min(hastaMs, Date.now());
    var previo = DIAS_HISTORIA_LAMPARA_PREVIA * MS_DIA;
    return obtenerAlcance().then(function (alcance) {
      var rangos = {
        hollin: [desdeMs, hastaMs],
        lampara: [desdeMs - previo, hastaMs], interruptor: [desdeMs - previo, hastaMs], ignicion: [desdeMs - previo, hastaMs]
      };
      return cargarSenales(alcance.vehiculos, rangos, function (hechos, total) {
        if (elementos.lineaProgreso) elementos.lineaProgreso.textContent = 'Consultando señales de Geotab… ' + hechos + ' de ' + total;
      }).then(function (senales) {
        var resultados = alcance.vehiculos.map(function (v) {
          return analizarVehiculo(v, senales[v.id], desdeMs, hastaMs, ahoraMs);
        });
        return { desde: desdeMs, hasta: hastaMs, resultados: resultados };
      });
    });
  }

  function filtrar(resultados, excluir) {
    return resultados.filter(function (r) {
      if (excluir !== 'ciudad' && filtros.ciudad && r.ciudad !== filtros.ciudad) return false;
      if (excluir !== 'marca' && filtros.marca && r.marca !== filtros.marca) return false;
      if (excluir !== 'vehiculo' && filtros.vehiculo && r.id !== filtros.vehiculo) return false;
      return true;
    });
  }

  function resumir(resultados) {
    var s = { vehiculos: resultados.length, regeneraciones: 0, solicitudes: 0, manuales: 0, automaticas: 0, enCurso: 0,
              reacciones: [], conSolicitud: 0, lamparaEncendida: 0, sinSenal: [] };
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

  // --- Filtros ---------------------------------------------------------------------
  function valoresUnicos(resultados, campo) {
    var m = {};
    resultados.forEach(function (r) { m[r[campo]] = true; });
    return Object.keys(m).sort();
  }

  function sincronizarSelects() {
    if (!refsFiltros) return;
    refsFiltros.ciudad.select.value = filtros.ciudad;
    refsFiltros.marca.select.value = filtros.marca;
    refsFiltros.vehiculo.select.value = filtros.vehiculo;
  }

  function alternarFiltro(clave, valor) {
    filtros[clave] = filtros[clave] === valor ? '' : valor;
    sincronizarSelects();
    renderizarResultados();
  }

  function construirBarraFiltros(contenedor) {
    var barra = crear('div', { padding: '12px 22px', display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-end', background: T.color.surface, borderBottom: '1px solid ' + T.color.border });
    var ciudad = crearSelect('Ciudad', [{ valor: '', etiqueta: 'Todas' }]);
    var marca = crearSelect('Marca', [{ valor: '', etiqueta: 'Todas' }]);
    var vehiculo = crearSelect('Vehículo', [{ valor: '', etiqueta: 'Todos' }], '220px');
    var limpiar = crearBoton('Limpiar filtros', false);
    [ciudad, marca, vehiculo].forEach(function (c, i) {
      var clave = ['ciudad', 'marca', 'vehiculo'][i];
      c.select.addEventListener('change', function () { filtros[clave] = c.select.value; renderizarResultados(); });
      barra.appendChild(c.envoltorio);
    });
    limpiar.addEventListener('click', function () { filtros = { ciudad: '', marca: '', vehiculo: '' }; sincronizarSelects(); renderizarResultados(); });
    barra.appendChild(limpiar);
    contenedor.appendChild(barra);
    refsFiltros = { ciudad: ciudad, marca: marca, vehiculo: vehiculo };
  }

  function actualizarOpcionesFiltros(resultados) {
    var opc = function (vals, todos) { return [{ valor: '', etiqueta: todos }].concat(vals.map(function (v) { return { valor: v, etiqueta: v }; })); };
    refsFiltros.ciudad.cargar(opc(valoresUnicos(resultados, 'ciudad'), 'Todas'), filtros.ciudad);
    refsFiltros.marca.cargar(opc(valoresUnicos(resultados, 'marca'), 'Todas'), filtros.marca);
    refsFiltros.vehiculo.cargar([{ valor: '', etiqueta: 'Todos' }].concat(resultados.map(function (r) { return { valor: r.id, etiqueta: r.nombre }; })), filtros.vehiculo);
  }

  // --- Resumen narrativo ---------------------------------------------------------
  function construirNarrativa(contenedor, s) {
    var panel = crearPanel({ padding: '14px 18px', marginBottom: '16px', borderLeft: '4px solid ' + T.color.primary });
    panel.appendChild(crear('div', { fontSize: '0.7rem', fontWeight: '800', color: T.color.primaryDark, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '6px' }, 'Lectura del periodo'));
    var lineas = [];
    if (!s.solicitudes && !s.regeneraciones) {
      lineas.push('Sin solicitudes de regeneración ni regeneraciones detectadas en los ' + s.vehiculos + ' vehículos del filtro.');
    } else {
      var cerradas = s.manuales + s.automaticas;
      lineas.push(s.solicitudes + ' solicitud(es) de regeneración (lámpara DPF encendida) en ' + s.conSolicitud + ' de ' + s.vehiculos + ' vehículos.' +
        (cerradas ? ' De las ' + cerradas + ' ya cerradas, ' + s.manuales + ' (' + Math.round(s.manuales / cerradas * 100) + ' %) se atendieron con el interruptor manual y ' + s.automaticas + ' se resolvieron solas.' : ''));
      if (s.reaccionMediana !== null) lineas.push('El conductor tardó una mediana de ' + fmtMinutos(s.reaccionMediana) + ' de motor encendido en activar el interruptor.');
      lineas.push(s.regeneraciones + ' regeneración(es) confirmada(s) por caída sostenida del hollín.');
    }
    if (s.lamparaEncendida) lineas.push(s.lamparaEncendida + ' vehículo(s) tienen la lámpara encendida al cierre del rango.');
    lineas.forEach(function (t) { panel.appendChild(crear('div', { fontSize: '0.84rem', color: T.color.body, marginTop: '3px' }, t)); });
    contenedor.appendChild(panel);
  }

  function construirKpis(contenedor, s) {
    var fila = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' });
    var pctManual = (s.manuales + s.automaticas) ? Math.round(s.manuales / (s.manuales + s.automaticas) * 100) + ' %' : '—';
    fila.appendChild(crearTarjetaKpi(String(s.solicitudes), 'Solicitudes de regeneración', 'lámpara DPF encendida'));
    fila.appendChild(crearTarjetaKpi(String(s.regeneraciones), 'Regeneraciones detectadas', 'por caída sostenida del hollín'));
    fila.appendChild(crearTarjetaKpi(pctManual, 'Atendidas con interruptor manual', s.manuales + ' manuales · ' + s.automaticas + ' solas'));
    fila.appendChild(crearTarjetaKpi(fmtMinutos(s.reaccionMediana), 'Reacción del conductor', 'mediana, minutos de motor encendido'));
    fila.appendChild(crearTarjetaKpi(String(s.lamparaEncendida), 'Con lámpara encendida', 'al cierre del rango', s.lamparaEncendida ? 2 : undefined));
    contenedor.appendChild(fila);
  }

  // --- Gráficos ----------------------------------------------------------------------
  function destruirCharts() { charts.forEach(function (c) { c.destroy(); }); charts = []; }

  function crearCaja(titulo, nota, alto) {
    var caja = crearPanel({ padding: '14px 16px', flex: '1 1 340px', minWidth: '300px' });
    caja.appendChild(crear('div', { fontSize: '0.9rem', fontWeight: '800', color: T.color.ink }, titulo));
    if (nota) caja.appendChild(crear('div', { fontSize: '0.72rem', color: T.color.muted, margin: '2px 0 8px 0' }, nota));
    var zona = crear('div', { position: 'relative', height: alto || '250px' });
    var canvas = document.createElement('canvas');
    zona.appendChild(canvas);
    caja.appendChild(zona);
    return { caja: caja, canvas: canvas, zona: zona };
  }

  function clicYCursor(alClic) {
    return {
      onClick: function (evt, els) { if (els && els.length) alClic(els[0].index); },
      onHover: function (evt, els) { if (evt.native && evt.native.target) evt.native.target.style.cursor = els.length ? 'pointer' : 'default'; }
    };
  }

  function construirGraficos(contenedor, filtrados, todosParaCiudad) {
    if (typeof Chart === 'undefined') {
      contenedor.appendChild(crear('div', { padding: '12px 16px', marginBottom: '16px', color: T.color.body, fontSize: '0.82rem', background: T.color.canvas, borderRadius: T.radius.sm }, 'No se cargó la librería de gráficos (Chart.js). Las tarjetas y la tabla funcionan igual.'));
      return;
    }
    destruirCharts();
    var fila = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' });

    // Tendencia diaria
    var dias = [], vistos = {};
    for (var t = datosCache.desde; t <= datosCache.hasta; t += MS_DIA) { var k = claveDia(t); if (!vistos[k]) { vistos[k] = true; dias.push({ clave: k, ms: t }); } }
    var kFin = claveDia(datosCache.hasta); if (!vistos[kFin]) dias.push({ clave: kFin, ms: datosCache.hasta });
    var porDiaReg = {}, porDiaSol = {};
    filtrados.forEach(function (r) {
      r.regeneraciones.forEach(function (e) { var c = claveDia(e.inicio); porDiaReg[c] = (porDiaReg[c] || 0) + 1; });
      r.solicitudes.forEach(function (e) { var c = claveDia(e.inicio); porDiaSol[c] = (porDiaSol[c] || 0) + 1; });
    });
    // Las regeneraciones por hollín son decenas por día y las solicitudes de lámpara pocas: cada serie lleva su propio eje.
    var g1 = crearCaja('Tendencia diaria', 'Barras (eje izquierdo): regeneraciones detectadas · Línea (eje derecho): solicitudes de lámpara');
    charts.push(new Chart(g1.canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: dias.map(function (d) { return fmtDia(d.ms); }),
        datasets: [
          { type: 'bar', label: 'Regeneraciones detectadas', data: dias.map(function (d) { return porDiaReg[d.clave] || 0; }), backgroundColor: COLOR_SERIE.regeneracion, borderRadius: 4, order: 2 },
          { type: 'line', label: 'Solicitudes de lámpara', data: dias.map(function (d) { return porDiaSol[d.clave] || 0; }), borderColor: COLOR_SERIE.solicitud, backgroundColor: COLOR_SERIE.solicitud, borderWidth: 2, tension: 0.3, pointRadius: 2, order: 1, yAxisID: 'y2' }
        ]
      },
      options: { maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, ticks: { precision: 0 } },
          y2: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { precision: 0, color: COLOR_SERIE.solicitud } }
        } }
    }));
    fila.appendChild(g1.caja);

    // Por ciudad (sin aplicar el filtro de ciudad, para poder cambiar de una a otra)
    var ciudades = {};
    todosParaCiudad.forEach(function (r) {
      var c = ciudades[r.ciudad] = ciudades[r.ciudad] || { reg: 0, sol: 0 };
      c.reg += r.regeneraciones.length; c.sol += r.solicitudes.length;
    });
    var nombresCiudad = Object.keys(ciudades).sort(function (a, b) { return ciudades[b].sol - ciudades[a].sol; });
    var g2 = crearCaja('Solicitudes por ciudad', 'Clic en una barra para filtrar por esa ciudad');
    var ciudadElegida = filtros.ciudad;
    var interaccion2 = clicYCursor(function (i) { alternarFiltro('ciudad', nombresCiudad[i]); });
    charts.push(new Chart(g2.canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: nombresCiudad,
        datasets: [
          { label: 'Solicitudes de lámpara', data: nombresCiudad.map(function (n) { return ciudades[n].sol; }), backgroundColor: nombresCiudad.map(function (n) { return !ciudadElegida || n === ciudadElegida ? COLOR_SERIE.solicitud : COLOR_SERIE.solicitud + '4D'; }), borderRadius: 4, barThickness: 18 }
        ]
      },
      options: { indexAxis: 'y', maintainAspectRatio: false, onClick: interaccion2.onClick, onHover: interaccion2.onHover,
        plugins: { legend: { display: false } },
        scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
    }));
    fila.appendChild(g2.caja);
    contenedor.appendChild(fila);

    var fila2 = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' });

    // Manual vs automática
    var s = resumir(filtrados);
    var g3 = crearCaja('¿Cómo se resolvieron?', 'Solicitudes de lámpara según cómo se cerraron');
    if (!s.solicitudes) {
      g3.zona.removeChild(g3.canvas);
      g3.zona.appendChild(crear('div', { padding: '40px 0', textAlign: 'center', color: T.color.muted, fontSize: '0.82rem' }, 'Sin solicitudes en el periodo'));
    } else {
      charts.push(new Chart(g3.canvas.getContext('2d'), {
        type: 'doughnut',
        data: { labels: ['Manual (interruptor)', 'Resuelta sola', 'En curso'], datasets: [{ data: [s.manuales, s.automaticas, s.enCurso], backgroundColor: [COLOR_SERIE.manual, COLOR_SERIE.automatica, '#CBD5E1'] }] },
        options: { maintainAspectRatio: false, cutout: '62%', plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } } }
      }));
    }
    fila2.appendChild(g3.caja);

    // Top vehículos por solicitudes
    var top = filtrados.filter(function (r) { return r.solicitudes.length; })
      .sort(function (a, b) { return b.solicitudes.length - a.solicitudes.length; }).slice(0, TOP_N);
    var g4 = crearCaja('Vehículos con más solicitudes', 'Clic en una barra para filtrar por ese vehículo');
    if (!top.length) {
      g4.zona.removeChild(g4.canvas);
      g4.zona.appendChild(crear('div', { padding: '40px 0', textAlign: 'center', color: T.color.muted, fontSize: '0.82rem' }, 'Sin solicitudes en el periodo'));
    } else {
      var inter4 = clicYCursor(function (i) { alternarFiltro('vehiculo', top[i].id); });
      charts.push(new Chart(g4.canvas.getContext('2d'), {
        type: 'bar',
        data: { labels: top.map(function (r) { return r.nombre; }), datasets: [{ label: 'Solicitudes', data: top.map(function (r) { return r.solicitudes.length; }),
          backgroundColor: top.map(function (r) { return !filtros.vehiculo || r.id === filtros.vehiculo ? COLOR_SERIE.solicitud : COLOR_SERIE.solicitud + '4D'; }), borderRadius: 4, barThickness: 16 }] },
        options: { indexAxis: 'y', maintainAspectRatio: false, onClick: inter4.onClick, onHover: inter4.onHover,
          plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
      }));
    }
    fila2.appendChild(g4.caja);
    contenedor.appendChild(fila2);
  }

  // --- Tabla y detalle ----------------------------------------------------------------
  function construirTabla(contenedor, filtrados, zonaDetalle) {
    var panel = crearPanel({ marginBottom: '16px', overflow: 'hidden' });
    var cab = crear('div', { padding: '12px 16px' });
    cab.appendChild(crear('div', { fontSize: '0.9rem', fontWeight: '800', color: T.color.ink }, 'Detalle por vehículo'));
    cab.appendChild(crear('div', { fontSize: '0.72rem', color: T.color.muted }, 'Clic en una fila para ver su historial · clic en un título para ordenar'));
    panel.appendChild(cab);

    var columnas = [
      { titulo: 'Vehículo', valor: function (r) { return r.nombre; }, orden: function (r) { return r.nombre; } },
      { titulo: 'Ciudad', valor: function (r) { return r.ciudad; }, orden: function (r) { return r.ciudad; } },
      { titulo: 'Marca', valor: function (r) { return r.marca; }, orden: function (r) { return r.marca; } },
      { titulo: 'Solicitudes', alinear: 'right', valor: function (r) { return r.solicitudes.length; }, orden: function (r) { return r.solicitudes.length; } },
      { titulo: 'Manuales', alinear: 'right', valor: function (r) { return r.solicitudes.filter(function (e) { return e.manual; }).length; }, orden: function (r) { return r.solicitudes.filter(function (e) { return e.manual; }).length; } },
      { titulo: 'Regener. detectadas', alinear: 'right', valor: function (r) { return r.regeneraciones.length; }, orden: function (r) { return r.regeneraciones.length; } },
      { titulo: 'Reacción mediana', alinear: 'right', valor: function (r) { var m = reaccionVehiculo(r); return m === null ? '—' : fmtMinutos(m); }, orden: reaccionVehiculo },
      { titulo: 'Lámpara más larga', alinear: 'right', valor: function (r) { var h = horasMax(r); return h === null ? '—' : fmtHoras(h) + ' h'; }, orden: horasMax },
      { titulo: 'Hollín actual', alinear: 'right', valor: function (r) { return r.hollinActual ? Math.round(r.hollinActual.valor) + ' %' : (r.tieneHollin ? 'sin dato reciente' : 'no reporta'); }, orden: function (r) { return r.hollinActual ? r.hollinActual.valor : null; } },
      { titulo: 'Estado', valor: function (r) { return r.estado ? crearPildora(r.estado.etiqueta, r.estado.nivel) : (r.tieneLampara || r.tieneHollin ? crearPildora('Sin novedad', 0) : crearPildora('Sin señal', 0)); },
        orden: function (r) { return r.estado ? r.estado.nivel : -1; } }
    ];
    panel.appendChild(crearTabla(columnas, filtrados, function (r) { construirDetalle(zonaDetalle, r); }));
    contenedor.appendChild(panel);
  }

  function reaccionVehiculo(r) {
    var m = r.solicitudes.filter(function (e) { return e.manual && !e.abierta; }).map(function (e) { return e.minMotorHastaAccion; });
    return mediana(m);
  }
  function horasMax(r) {
    var h = r.solicitudes.map(function (e) { return e.horas; });
    return h.length ? Math.max.apply(null, h) : null;
  }

  function construirDetalle(zona, r) {
    vaciar(zona);
    var panel = crearPanel({ padding: '14px 16px', marginBottom: '16px', borderLeft: '4px solid ' + T.color.primary });
    var titulo = crear('div', { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' });
    titulo.appendChild(crear('div', { fontSize: '1rem', fontWeight: '800', color: T.color.ink }, r.nombre));
    titulo.appendChild(crear('div', { fontSize: '0.78rem', color: T.color.muted }, r.ciudad + ' · ' + r.marca));
    if (r.estado) titulo.appendChild(crearPildora(r.estado.etiqueta, r.estado.nivel));
    panel.appendChild(titulo);

    if (!r.tieneHollin && !r.tieneLampara) {
      panel.appendChild(crear('div', { fontSize: '0.82rem', color: T.color.body }, 'Este vehículo no reportó hollín ni lámpara DPF en el rango (la señal no llega a Geotab o el motor estuvo apagado).'));
    }

    var sol = r.solicitudes.slice().sort(function (a, b) { return b.inicio - a.inicio; });
    panel.appendChild(crear('div', { fontSize: '0.78rem', fontWeight: '800', color: T.color.muted, textTransform: 'uppercase', margin: '10px 0 4px 0' }, 'Solicitudes de regeneración (lámpara)'));
    if (!sol.length) panel.appendChild(crear('div', { fontSize: '0.82rem', color: T.color.body }, 'Ninguna en el rango.'));
    else panel.appendChild(crearTabla([
      { titulo: 'Lámpara encendida', valor: function (e) { return fmtFecha(e.inicio); } },
      { titulo: 'Apagada', valor: function (e) { return e.abierta ? 'sigue encendida' : fmtFecha(e.fin); } },
      { titulo: 'Duración', alinear: 'right', valor: function (e) { return fmtHoras(e.horas) + ' h'; } },
      { titulo: 'Cómo se resolvió', valor: function (e) { return e.abierta ? crearPildora('En curso', 1) : (e.manual ? crearPildora('Manual', 1) : crearPildora('Sola', 0)); } },
      { titulo: 'Interruptor', valor: function (e) { return e.interruptorDesde ? fmtFecha(e.interruptorDesde) : '—'; } },
      { titulo: 'Motor encendido hasta actuar', alinear: 'right', valor: function (e) { return fmtMinutos(e.minMotorHastaAccion); } }
    ], sol));

    var reg = r.regeneraciones.slice().sort(function (a, b) { return b.inicio - a.inicio; });
    panel.appendChild(crear('div', { fontSize: '0.78rem', fontWeight: '800', color: T.color.muted, textTransform: 'uppercase', margin: '14px 0 4px 0' }, 'Regeneraciones detectadas por hollín'));
    if (!reg.length) panel.appendChild(crear('div', { fontSize: '0.82rem', color: T.color.body }, r.tieneHollin ? 'Ninguna en el rango.' : 'Este vehículo no reporta hollín: solo se le detecta la lámpara.'));
    else panel.appendChild(crearTabla([
      { titulo: 'Inicio', valor: function (e) { return fmtFecha(e.inicio); } },
      { titulo: 'Hollín antes', alinear: 'right', valor: function (e) { return Math.round(e.valorInicio) + ' %'; } },
      { titulo: 'Hollín después', alinear: 'right', valor: function (e) { return Math.round(e.valorFin) + ' %'; } },
      { titulo: 'Caída', alinear: 'right', valor: function (e) { return Math.round(e.caida) + ' pp'; } },
      { titulo: 'Duración', alinear: 'right', valor: function (e) { return fmtMinutos(e.duracionMin); } }
    ], reg));
    zona.appendChild(panel);
    if (zona.scrollIntoView) zona.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // --- Render -------------------------------------------------------------------------
  function renderizarResultados() {
    if (!datosCache) return;
    var cont = vaciar(contenedorResultados);
    var filtrados = filtrar(datosCache.resultados);
    var s = resumir(filtrados);
    var cuerpo = crear('div', { padding: '16px 22px' });
    cont.appendChild(cuerpo);

    construirNarrativa(cuerpo, s);
    construirKpis(cuerpo, s);
    construirGraficos(cuerpo, filtrados, filtrar(datosCache.resultados, 'ciudad'));
    var zonaDetalle = crear('div');
    construirTabla(cuerpo, filtrados, zonaDetalle);
    cuerpo.appendChild(zonaDetalle);

    if (s.sinSenal.length) {
      cuerpo.appendChild(crear('div', { fontSize: '0.76rem', color: T.color.muted, marginBottom: '8px' },
        s.sinSenal.length + ' de ' + s.vehiculos + ' vehículos no reportan hollín ni lámpara DPF y por eso no aparecen con novedades: ' +
        s.sinSenal.slice(0, 15).join(', ') + (s.sinSenal.length > 15 ? '…' : '') + '.'));
    }
    cuerpo.appendChild(crear('div', { fontSize: '0.72rem', color: T.color.muted, paddingBottom: '12px' },
      'Método: una solicitud es un episodio de lámpara DPF encendida (se ignoran parpadeos < 5 min y ceros con el motor apagado o con el interruptor activo). ' +
      'Una regeneración detectada es una caída sostenida del hollín de 10 puntos o más en 40 min. Los tiempos de reacción cuentan solo con el motor encendido.'));
  }

  function cargarYRenderizar(desde, hasta) {
    if (cargaEnCurso) return;
    if (isNaN(desde.getTime()) || isNaN(hasta.getTime()) || desde >= hasta) { mostrarError(contenedorResultados, 'El rango de fechas no es válido: "Desde" debe ser anterior a "Hasta".'); return; }
    cargaEnCurso = true;
    elementos.botones.forEach(function (b) { b.disabled = true; b.style.opacity = '0.55'; });
    elementos.lineaProgreso = mostrarCargando(contenedorResultados, 'Consultando señales de Geotab…');
    calcular(desde.getTime(), hasta.getTime())
      .then(function (datos) {
        datosCache = datos;
        actualizarOpcionesFiltros(datos.resultados);
        renderizarResultados();
      })
      .catch(function (err) {
        console.error('Análisis de Regeneraciones:', err);
        mostrarError(contenedorResultados, describirError(err));
      })
      .then(function () {
        cargaEnCurso = false;
        elementos.botones.forEach(function (b) { b.disabled = false; b.style.opacity = '1'; });
      });
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi; state = freshState;
      var raiz = document.getElementById('analisisRegeneracionRoot');
      aplicarEstilo(raiz, { fontFamily: T.font, background: T.color.canvas, padding: '4px' });

      var enc = crearEncabezado('♻️', 'Análisis de Regeneraciones DPF',
        'Histórico por vehículo: solicitudes de lámpara, regeneración manual vs. automática, reacción del conductor y regeneraciones detectadas por hollín.');
      var r0 = rangoPorDefecto();
      var campoDesde = crearCampoFecha('Desde', r0.desde);
      var campoHasta = crearCampoFecha('Hasta', r0.hasta);
      var botonAnalizar = crearBoton('Analizar rango', true);
      var filaFiltros = crear('div', { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-end' });
      filaFiltros.appendChild(campoDesde.envoltorio);
      filaFiltros.appendChild(campoHasta.envoltorio);
      filaFiltros.appendChild(botonAnalizar);
      var botonesAtajo = [7, 14, 30].map(function (d) {
        var b = crearBoton('Últimos ' + d + ' días', false);
        b.addEventListener('click', function () {
          var r = rangoPorDefecto(d);
          campoDesde.input.value = r.desde; campoHasta.input.value = r.hasta;
          cargarYRenderizar(new Date(r.desde), new Date(r.hasta));
        });
        filaFiltros.appendChild(b);
        return b;
      });
      enc.appendChild(filaFiltros);
      raiz.appendChild(enc);
      elementos.botones = [botonAnalizar].concat(botonesAtajo);

      construirBarraFiltros(raiz);
      botonAnalizar.addEventListener('click', function () { cargarYRenderizar(new Date(campoDesde.input.value), new Date(campoHasta.input.value)); });

      contenedorResultados = crear('div');
      raiz.appendChild(contenedorResultados);
      elementos.inputDesde = campoDesde.input; elementos.inputHasta = campoHasta.input;
      initializedCallback();
    },

    focus: function (freshApi, freshState) {
      api = freshApi; state = freshState;
      if (!datosCache && !cargaEnCurso) cargarYRenderizar(new Date(elementos.inputDesde.value), new Date(elementos.inputHasta.value));
    },

    blur: function () {}
  };

};
