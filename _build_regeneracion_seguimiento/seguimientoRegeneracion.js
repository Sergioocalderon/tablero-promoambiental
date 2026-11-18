/* ARCHIVO GENERADO por herramientas/construir_addins_regeneracion.py -- NO EDITAR A MANO.
   Editar _build_regeneracion_comun/*.js o _build_regeneracion_seguimiento/seguimientoRegeneracion.parte.js y volver a ejecutar el script. */

geotab.addin.seguimientoRegeneracion = function () {
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
  // Add-In: Seguimiento de Regeneraciones DPF
  //
  // Tablero OPERATIVO en vivo (se actualiza solo cada 5 min): qué vehículos
  // tienen la lámpara DPF encendida y qué hay que hacer con cada uno (avisar al
  // conductor, escalar, taller), y cuáles van camino a necesitarlo (hollín sobre
  // el umbral de su marca). Usa los mismos criterios y umbrales que el aviso por
  // Telegram (vigilancia_cumplimiento_regeneracion.py) y que el mensaje por
  // ciudad (reporte_regeneracion_ciudades.py), así que las tres vistas coinciden.
  //
  // Pantalla en tema oscuro (v1.4): encabezado con la hora de actualización, filtros por
  // base y estado, "Regenerar ya", "Próximos al umbral" y el aviso de vehículos sin señal.
  //
  // Un clic en una fila abre el EXPEDIENTE DEL MÓVIL: modal oscuro con el estado, qué
  // hacer, tiempos y la gráfica de hollín de las últimas 48 h, con imagen para compartir
  // en WhatsApp (copiar o descargar). Ver la sección "EXPEDIENTE DEL MÓVIL".
  // ============================================================================

  var DIAS_HISTORIA_LAMPARA = 14;                 // igual que reporte_regeneracion_ciudades.py --dias
  var INTERVALO_AUTO_REFRESCO_MS = 5 * 60 * 1000;

  var elementos = {};
  var datosCache = null;       // { ahora, resultados, senales }
  var ciudadElegida = '';
  var cargaEnCurso = false;
  var idIntervalo = null;
  var contenedorResultados = null;

  // --- Tema oscuro (el mismo del expediente y de Alertas por Severidad) -------------------------
  var D = {
    bg: '#131722', panel: '#1E222D', panelAlt: '#1A1D24', panelSoft: '#262B36', border: '#374151', borde2: '#2A2E39',
    text: '#E2E8F0', textSoft: '#CBD5E1', muted: '#94A3B8', faint: '#64748B',
    verde: '#00D084', whatsapp: '#25D366', rojo: '#FF4D4F', naranja: '#FB923C', amarillo: '#FACC15'
  };

  // Iconos en SVG propio (no hay librerías de iconos disponibles dentro de MyGeotab).
  var ICONOS = {
    copiar: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    descargar: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    cerrar: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    actualizar: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    chat: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    alerta: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
  };

  function crearIcono(nombre, lado, color) {
    var el = crear('span', { display: 'inline-flex', width: lado, height: lado, flex: 'none' });
    if (color) el.style.color = color;
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICONOS[nombre] + '</svg>';
    return el;
  }

  function calcular() {
    var ahora = Date.now();
    return obtenerAlcance().then(function (alcance) {
      var rangos = {
        hollin: [ahora - HORAS_HOLLIN_RECIENTE * MS_HORA, ahora],
        lampara: [ahora - DIAS_HISTORIA_LAMPARA * MS_DIA, ahora],
        interruptor: [ahora - DIAS_HISTORIA_LAMPARA * MS_DIA, ahora],
        ignicion: [ahora - DIAS_HISTORIA_LAMPARA * MS_DIA, ahora],
        regen: [ahora - HORAS_REGEN_ACTIVA * MS_HORA, ahora]
      };
      return cargarSenales(alcance.vehiculos, rangos, function (hechos, total) {
        if (elementos.lineaProgreso) elementos.lineaProgreso.textContent = 'Consultando señales de Geotab… ' + hechos + ' de ' + total;
      }).then(function (senales) {
        var resultados = alcance.vehiculos.map(function (v) {
          var sen = senales[v.id];
          var r = analizarVehiculo(v, sen, ahora - DIAS_HISTORIA_LAMPARA * MS_DIA, ahora, ahora);
          r.tieneRegen = sen.regen.length > 0;
          r.regen = analizarRegeneracionActiva(sen.regen, sen.hollin, sen.interruptor, ahora);
          return r;
        });
        return { ahora: ahora, resultados: resultados, senales: senales };
      });
    });
  }

  // --- Regeneración activa (testigo) -------------------------------------------------------------
  // Diagnóstico "regeneración activa" del filtro de partículas: encendido = el motor está regenerando
  // (automática o manual), con o sin lámpara. Es el mismo del aviso por Telegram
  // (reporte_regeneracion_ciudades.py --regen-activa) y usa su criterio: a los 150 min se mide si el
  // hollín bajó >= 10 puntos. Sin esto, un vehículo que regenera solo (lámpara e interruptor apagados)
  // no aparecía en ninguna lista: el hollín baja, deja de ser "próximo" y nunca tuvo lámpara.
  var HORAS_REGEN_ACTIVA = 48;
  // Cuándo pedir la regeneración manual (calibrado el 2026-10-29 con 30 días de la flota, 841 sesiones): se mira el hollín
  // y su tendencia, no el tiempo con el testigo encendido. Con hollín >= 60 % la automática suele resolver sola y esperar
  // vale la pena (sin bajar a los 60 min, 88 % baja después); la lámpara se enciende hacia 125-145 % cuando el hollín sigue
  // subiendo a pesar del testigo.
  var REGEN_HOLLIN_VALIDAR = 110;    // "Validar el sistema": cerca de donde se enciende la lámpara
  var REGEN_HOLLIN_ATENCION = 100;   // "Atención": hollín alto que no ha bajado
  var REGEN_ATENCION_MIN = 60;       // ...pasados estos minutos sin haber bajado REGEN_CAIDA_MIN_PP puntos
  var REGEN_HOLLIN_RECIENTE_MIN = 90;   // la lectura de hollín que se evalúa no puede ser más vieja que esto
  var REGEN_CAIDA_MIN_PP = 10;
  var REGEN_PROLONGADA_H = 8;        // igual que UMBRAL_SESION_PROLONGADA_HORAS de detectar_regeneracion_dpf.py
  var REGEN_SIN_LECTURAS_MIN = 90;   // el diagnóstico llega cada ~30 min: 3 lecturas sin dato ya es raro
  var REGEN_MARGEN_MANUAL_MIN = 30;  // el interruptor puede apretarse un rato antes de que el testigo se encienda
  var HOLLIN_MUY_ALTO = 150;         // desde aquí el texto dice "muy por encima" de donde se enciende la lámpara
  var REGEN_MANUALES_SIN_EFECTO = 3; // con esta cantidad de manuales y el hollín alto, se manda a taller en vez de insistir

  // Rachas de testigo encendido: [{desde, hasta, abierta}]. La que sigue encendida llega hasta ahora.
  function sesionesRegen(regen, ahoraMs) {
    var sesiones = [], inicio = null;
    regen.forEach(function (m) {
      if (m[1] >= 1) { if (inicio === null) inicio = m[0]; }
      else if (inicio !== null) { sesiones.push({ desde: inicio, hasta: m[0], abierta: false }); inicio = null; }
    });
    if (inicio !== null) sesiones.push({ desde: inicio, hasta: ahoraMs, abierta: true });
    return sesiones;
  }

  // Sesión de regeneración en curso de un vehículo, o null si el testigo está apagado.
  //   regen: [[ms, valor]] de las últimas 48 h; hollin: [[ms, %]] SIN limpiar; interruptor: [[ms, valor]].
  // `tipo`: MANUAL si el interruptor manual se vio activado desde poco antes del inicio hasta ahora (el conductor
  // la pidió o la completó a mano); AUTOMATICA si no. El interruptor se registra por eventos y casi siempre se
  // aprieta con el testigo ya encendido (la automática no terminaba), así que se mira de ahí en adelante.
  function analizarRegeneracionActiva(regen, hollin, interruptor, ahoraMs) {
    if (!regen.length || regen[regen.length - 1][1] < 1) return null;
    var i = regen.length - 1;
    while (i > 0 && regen[i - 1][1] >= 1) i--;
    var inicio = regen[i][0];
    // La racha llega al borde de la ventana: ya venía encendido. Si la primera lectura es bastante posterior al
    // borde (vehículo parado sin lecturas), no se sabe nada de antes y se cuenta desde esa lectura.
    var desdeAntes = i === 0 && (regen[0][0] - (ahoraMs - HORAS_REGEN_ACTIVA * MS_HORA)) < 45 * MS_MIN;

    var limpias = limpiarLecturasHollin(hollin).filter(function (p) { return p[0] <= ahoraMs; });
    var antes = null, minimo = null;
    limpias.forEach(function (p) {
      if (p[0] <= inicio) antes = p[1];
      if (p[0] >= inicio && (minimo === null || p[1] < minimo)) minimo = p[1];
    });
    var actual = limpias.length ? limpias[limpias.length - 1] : null;
    // Techo del sensor sostenido (>= 2 lecturas seguidas de 199 % o más): es la lectura actual aunque la limpieza la descarte.
    var techo = hollinPegadoEnTecho(hollin, ahoraMs);
    if (techo && (ahoraMs - techo.t) / MS_MIN > REGEN_HOLLIN_RECIENTE_MIN) techo = null;
    if (techo && (!actual || techo.t > actual[0])) actual = [techo.t, techo.valor];
    // Valor del testigo: 1 = regenerando; 2 = "regeneración necesaria" (J1939 SPN 3700): el ECU la pide pero no la ejecuta.
    // Medido en 4 días de la flota: con 1 el hollín baja >= 5 pts en el 34 % de las lecturas; con 2 casi no baja (12 % baja, 11 % sube).
    var testigo = regen[regen.length - 1][1];
    var testigoDesde = regen[regen.length - 1][0];
    for (var q = regen.length - 2; q >= 0 && regen[q][1] === testigo; q--) testigoDesde = regen[q][0];
    var caida = antes !== null && minimo !== null ? antes - minimo : null;
    var edad = (ahoraMs - regen[regen.length - 1][0]) / MS_MIN;
    // Con el testigo mudo, la duración observada llega hasta su última lectura (no se inventan horas sin dato).
    var minutos = ((edad > REGEN_SIN_LECTURAS_MIN ? regen[regen.length - 1][0] : ahoraMs) - inicio) / MS_MIN;

    var pulsos = [], activo = false;
    (interruptor || []).forEach(function (m) {
      if (m[1] > 0 && !activo && m[0] >= inicio - REGEN_MARGEN_MANUAL_MIN * MS_MIN && m[0] <= ahoraMs) pulsos.push(m[0]);
      activo = m[1] > 0;
    });
    var manual = pulsos.length > 0;
    var tipo = manual
      ? { codigo: 'MANUAL', etiqueta: 'Manual', veces: pulsos.length, primera: pulsos[0], ultima: pulsos[pulsos.length - 1] }
      : { codigo: 'AUTOMATICA', etiqueta: 'Automática' };

    // Hollín que se evalúa: la última lectura, si es reciente. `tono` es el color de la pastilla (0 gris, 1 ámbar,
    // 2 naranja); `nivel` solo ordena (lo más importante primero).
    var hollinAhora = actual && (ahoraMs - actual[0]) / MS_MIN <= REGEN_HOLLIN_RECIENTE_MIN ? actual[1] : null;
    if (techo) hollinAhora = techo.valor;
    var bajoDesdeInicio = antes !== null && hollinAhora !== null ? antes - hollinAhora : null;

    var estado;
    if (edad > REGEN_SIN_LECTURAS_MIN) {
      estado = { codigo: 'SIN_LECTURAS', nivel: 0, etiqueta: 'Sin lecturas',
        texto: 'El testigo quedó en activo pero no llegan lecturas nuevas hace ' + fmtMinutos(edad) + ': motor apagado o testigo pegado.' };
    } else if (hollinAhora !== null && hollinAhora >= REGEN_HOLLIN_VALIDAR) {
      estado = { codigo: 'VALIDAR', nivel: 4, tono: 2, etiqueta: 'Validar el sistema',
        texto: techo
          ? 'El hollín marca ' + Math.round(hollinAhora) + ' %, el tope del sensor, desde ' + fmtFecha(techo.desde) + ': el filtro está saturado o el sensor pegado.'
          : 'El hollín está en ' + Math.round(hollinAhora) + ' %, ' + (hollinAhora >= HOLLIN_MUY_ALTO ? 'muy por encima de' : 'cerca de') + ' donde suele encenderse la lámpara (' + HOLLIN_LAMPARA_APROX + ' %).' };
    } else if (minutos >= REGEN_ATENCION_MIN && hollinAhora !== null && hollinAhora >= REGEN_HOLLIN_ATENCION &&
               bajoDesdeInicio !== null && bajoDesdeInicio < REGEN_CAIDA_MIN_PP) {
      estado = { codigo: 'ATENCION', nivel: 3, tono: 1, etiqueta: 'Atención',
        texto: 'Lleva ' + fmtDuracion(minutos / 60) + ' regenerando y el hollín sigue en ' + Math.round(hollinAhora) + ' %, sin haber bajado ' + REGEN_CAIDA_MIN_PP + ' puntos.' };
    } else if (minutos >= REGEN_PROLONGADA_H * 60) {
      estado = { codigo: 'PROLONGADA', nivel: 2, tono: 0, etiqueta: 'Prolongada',
        texto: 'Lleva ' + (desdeAntes ? 'más de ' : '') + fmtDuracion(minutos / 60) + ' con el testigo activo: la regeneración no termina de completarse (ciclos cortos de operación o falla) o el testigo está pegado.' };
    } else {
      estado = { codigo: 'EN_CURSO', nivel: 1, tono: 'regen', etiqueta: testigo >= 2 ? 'Pendiente' : 'En curso',
        texto: testigo >= 2 ? 'El motor pide la regeneración (estado "necesaria") desde ' + fmtFecha(testigoDesde) + ' pero no la está ejecutando: mientras tanto el hollín no baja.'
          : (caida !== null && caida >= REGEN_CAIDA_MIN_PP ? 'Regenerando: el hollín ya bajó ' + Math.round(caida) + ' puntos.'
            : (!actual ? 'Regeneración en marcha; este vehículo no reporta hollín, así que no se puede medir cuánto bajó.'
              : 'Regeneración en marcha: se espera que baje el hollín (llega cada ~30 min).')) };
    }

    // Qué hacer con el conductor: solo se pide la manual si es automática y el hollín está alto o no baja.
    var consejo = '', llamar = false;
    if (estado.codigo === 'VALIDAR' || estado.codigo === 'ATENCION') {
      if (manual && tipo.veces >= REGEN_MANUALES_SIN_EFECTO) consejo = 'Se activó la manual ' + tipo.veces + ' veces (la última ' + fmtFecha(tipo.ultima) + ') y el hollín no baja: no insistir, llevar a revisión en taller.';
      else if (manual) consejo = 'Ya se activó la manual (' + fmtFecha(tipo.ultima) + ') y el hollín sigue alto: conviene revisar el vehículo.';
      else {
        llamar = true;
        consejo = estado.codigo === 'VALIDAR' ? 'Validar el sistema: llamar al conductor y pedirle la regeneración manual ahora.'
          : 'Llamar al conductor y pedirle la regeneración manual.';
      }
    } else if (estado.codigo === 'PROLONGADA') {
      consejo = 'Conviene revisar el vehículo: más de ' + REGEN_PROLONGADA_H + ' h con el testigo activo.';
    } else if (estado.codigo === 'EN_CURSO') {
      if (manual) consejo = 'El conductor activó la regeneración manual (' + fmtFecha(tipo.primera) + (tipo.veces > 1 ? ', ' + tipo.veces + ' veces' : '') + ').';
      else if (caida !== null && caida >= REGEN_CAIDA_MIN_PP) consejo = 'No hace falta llamar: regenera sola y el hollín baja.';
      else consejo = 'Esperar: regenera sola. Se pide la manual si el hollín llega a ' + REGEN_HOLLIN_VALIDAR + ' %, o si a los ' + REGEN_ATENCION_MIN + ' min sigue en ' + REGEN_HOLLIN_ATENCION + ' % o más sin bajar.';
    }
    return {
      inicio: inicio, minutos: minutos, desdeAntes: desdeAntes, hollinAntes: antes, hollinMin: minimo, caida: caida,
      hollinActual: actual ? { valor: actual[1], t: actual[0] } : null,
      ultima: regen[regen.length - 1][0], edad: edad, estado: estado, tipo: tipo, consejo: consejo, llamar: llamar
    };
  }

  // --- Clasificación para el tablero ------------------------------------------------
  // Un vehículo que ya está regenerando no es "próximo": aparece en su propia sección.
  function listaProximos(resultados) {
    return resultados.filter(function (r) { return r.proximo && !r.regen; }).sort(function (a, b) { return b.hollinActual.valor - a.hollinActual.valor; });
  }
  function delaCiudad(resultados) {
    return resultados.filter(function (r) { return !ciudadElegida || r.ciudad === ciudadElegida; });
  }

  // --- Mensaje por ciudad (mismo formato que reporte_regeneracion_ciudades.py) ----------
  function fmtFechaLarga(ms) {
    var p = partesBogota(ms);
    return pad2(p.d) + '-' + MESES[p.m] + '-' + p.a + ' ' + pad2(p.h) + ':' + pad2(p.mi);
  }

  // Mismos grupos que el panel (accionDe): cada vehículo sale UNA sola vez, con su situación y qué hacer.
  var ICONO_GRUPO = { LLAMAR: '🔴 📞', REVISAR: '🟠 🔧', ESPERAR: '🔵 ⏳' };

  function hollinTexto(r) {
    var g = r.regen, h = g && g.hollinActual ? g.hollinActual : r.hollinActual;
    if (!h) return '';
    var antes = g && g.hollinAntes !== null && Math.round(g.hollinAntes) !== Math.round(h.valor) ? Math.round(g.hollinAntes) + ' % → ' : '';
    return ' · hollín ' + antes + Math.round(h.valor) + ' %';
  }

  function situacionTexto(r) {
    var p = [];
    if (r.abierto) p.push('lámpara desde ' + fmtFecha(r.abierto.desde) + ' (' + fmtHoras(r.abierto.horasMotor) + ' h de motor)' +
      (r.estado.codigo === 'PARQUEADO' ? ', parqueado o fuera de servicio' : ''));
    if (r.regen) p.push('regenerando ' + r.regen.tipo.etiqueta.toLowerCase() + ' desde ' + (r.regen.desdeAntes ? 'antes de ' : '') +
      fmtFecha(r.regen.inicio) + ' (' + fmtDuracion(r.regen.minutos / 60) + ')');
    return p.join(' · ');
  }

  function mensajeCiudad(ciudad, resultados, ahora) {
    var por = listaAtencion(resultados);
    var prox = listaProximos(resultados);
    var L = ['🔧 REGENERACIÓN DPF — ' + ciudad, fmtFechaLarga(ahora), ''], hay = prox.length > 0;
    GRUPOS_ACCION.forEach(function (g) {
      var lista = por[g.codigo];
      if (!lista.length) return;
      hay = true;
      L.push(ICONO_GRUPO[g.codigo] + ' ' + g.titulo.toUpperCase() + ' (' + lista.length + ')');
      lista.forEach(function (r) {
        L.push('• ' + r.nombre + hollinTexto(r) + ' · ' + situacionTexto(r));
        L.push('   ↳ ' + r.accion.texto);
      });
      L.push('');
    });
    if (prox.length) {
      L.push('🟡 PRÓXIMOS — hollín sobre el umbral de su marca, lámpara apagada (' + prox.length + ')');
      prox.forEach(function (r) { L.push('• ' + r.nombre + ' · hollín ' + Math.round(r.hollinActual.valor) + ' % (umbral ' + r.umbralHollin + ' %)'); });
      L.push('');
    }
    if (!hay) { L.push('✅ Sin vehículos para regenerar por ahora.'); L.push(''); }
    L.push('Umbral de "próximo": International ' + HOLLIN_PROXIMO_DEFECTO + ' %, Foton 95 %, Kenworth 100 %. La lámpara se enciende hacia 125 % o más.');
    var sinDato = resultados.filter(function (r) { return !r.hollinActual; }).length;
    if (sinDato) L.push('(' + sinDato + ' de ' + resultados.length + ' vehículos de esta ciudad no reportan hollín: solo se les detecta la lámpara encendida.)');
    return L.join('\n');
  }

  function textoParaCopiar() {
    var ciudades = ciudadElegida ? [ciudadElegida] : Object.keys(datosCache.resultados.reduce(function (m, r) { m[r.ciudad] = true; return m; }, {})).sort();
    return ciudades.map(function (c) {
      return mensajeCiudad(c, datosCache.resultados.filter(function (r) { return r.ciudad === c; }), datosCache.ahora);
    }).join('\n\n--------------------\n\n');
  }

  // --- Panel -----------------------------------------------------------------------------
  var estadoElegido = '';   // '' = cualquiera; LLAMAR, REVISAR, ESPERAR o PROXIMO

  // Pastilla de "qué hacer", sólida como en el boceto: rojo = escalar o taller, naranja = avisar, ámbar = en observación.
  var PILDORA_NIVEL = {
    3: { fondo: '#DC2626', texto: '#FFFFFF' },
    2: { fondo: '#F97316', texto: '#1A0A00' },
    1: { fondo: '#F59E0B', texto: '#1F1300' },
    0: { fondo: '#475569', texto: '#F1F5F9' },
    regen: { fondo: '#2563EB', texto: '#FFFFFF' }   // regeneración en curso: no pide acción
  };

  function crearPildoraEstado(estado) {
    var c = PILDORA_NIVEL[estado.tono !== undefined ? estado.tono : estado.nivel] || PILDORA_NIVEL[0];
    return crear('span', {
      display: 'inline-block', padding: '2px 10px', borderRadius: T.radius.pill, fontSize: '0.7rem', fontWeight: '700',
      background: c.fondo, color: c.texto, whiteSpace: 'nowrap'
    }, estado.etiqueta);
  }

  function celdaConEstado(estado) {
    var caja = crear('div', { minWidth: '230px' });
    caja.appendChild(crearPildoraEstado(estado));
    caja.appendChild(crear('div', { fontSize: '0.7rem', color: D.muted, marginTop: '4px', maxWidth: '300px', lineHeight: '1.35' }, estado.texto));
    return caja;
  }
  function celdaEstado(r) { return celdaConEstado(r.estado); }
  function textoCaida(caida) {
    if (caida === null) return '—';
    return caida < 0 ? crear('span', { color: D.naranja }, '↑ ' + Math.round(-caida) + ' pts') : Math.round(caida) + ' pts';
  }

  // Estado de la regeneración + qué hacer con el conductor (en naranja y negrita cuando hay que llamar).
  function celdaEstadoRegen(r) {
    var g = r.regen;
    var caja = celdaConEstado(g.estado);
    if (g.consejo) {
      caja.appendChild(crear('div', {
        fontSize: '0.72rem', fontWeight: '700', marginTop: '4px', maxWidth: '300px', lineHeight: '1.35',
        color: g.llamar ? D.naranja : D.textSoft
      }, g.consejo));
    }
    return caja;
  }

  // Automática o manual, para saber de un vistazo si el conductor ya la hizo a mano.
  var PILDORA_TIPO = {
    AUTOMATICA: { fondo: '#334155', texto: '#E2E8F0' },
    MANUAL: { fondo: '#7C3AED', texto: '#FFFFFF' }
  };
  function celdaTipoRegen(r) {
    var tipo = r.regen.tipo, c = PILDORA_TIPO[tipo.codigo];
    var caja = crear('div');
    caja.appendChild(crear('span', {
      display: 'inline-block', padding: '2px 10px', borderRadius: T.radius.pill, fontSize: '0.7rem', fontWeight: '700',
      background: c.fondo, color: c.texto, whiteSpace: 'nowrap'
    }, tipo.etiqueta));
    if (tipo.codigo === 'MANUAL') {
      caja.appendChild(crear('div', { fontSize: '0.7rem', color: D.muted, marginTop: '4px', whiteSpace: 'nowrap' },
        'activó ' + fmtFecha(tipo.primera) + (tipo.veces > 1 ? ' (' + tipo.veces + ' veces)' : '')));
    }
    if (r.regen.llamar) {
      caja.appendChild(crear('span', {
        display: 'inline-block', marginTop: '4px', padding: '2px 10px', borderRadius: T.radius.pill, fontSize: '0.68rem', fontWeight: '700',
        background: PILDORA_NIVEL[2].fondo, color: PILDORA_NIVEL[2].texto, whiteSpace: 'nowrap'
      }, 'Pedir manual'));
    }
    return caja;
  }

  var temporizadorAviso = null;
  function mostrarAviso(texto) {
    if (!elementos.aviso) return;
    elementos.aviso.textContent = texto;
    clearTimeout(temporizadorAviso);
    temporizadorAviso = setTimeout(function () { elementos.aviso.textContent = ''; }, 8000);
  }

  // Botón de la columna Acción: copia la imagen del expediente de ese vehículo para pegarla en WhatsApp.
  function botonImagenWhatsapp(r) {
    var b = crear('button', {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', cursor: 'pointer',
      borderRadius: '6px', color: D.whatsapp, background: 'rgba(37,211,102,0.10)', border: '1px solid rgba(37,211,102,0.4)',
      transition: 'background 0.15s'
    });
    b.type = 'button';
    b.title = 'Copiar la imagen de ' + r.nombre + ' para WhatsApp';
    b.setAttribute('aria-label', b.title);
    b.appendChild(crearIcono('chat', '17px'));
    b.addEventListener('mouseenter', function () { if (!b.disabled) b.style.background = 'rgba(37,211,102,0.22)'; });
    b.addEventListener('mouseleave', function () { b.style.background = 'rgba(37,211,102,0.10)'; });
    b.addEventListener('click', function (e) {
      e.stopPropagation();   // la fila entera abre el expediente: este botón solo copia la imagen
      if (b.disabled) return;
      b.disabled = true; b.style.opacity = '0.5';
      copiarImagenExpediente(modeloExpediente(r), function (t) { mostrarAviso(r.nombre + ': ' + t); }).then(function () {
        b.disabled = false; b.style.opacity = '1';
      });
    });
    return b;
  }

  // Tabla oscura con encabezados ordenables. columnas: [{titulo, valor(fila)->texto|Node, alinear, orden(fila),
  // colorTitulo, fondo (tinte de la columna)}]. opciones: {alClicFila, estiloFila(fila)->{fondo, hover, borde}}.
  function crearTablaOscura(columnas, filas, opciones) {
    var envoltorio = crear('div', { overflowX: 'auto' });
    var tabla = crear('table', { width: '100%', borderCollapse: 'separate', borderSpacing: '0', fontSize: '0.8rem', fontFamily: T.font });
    var filaCabecera = crear('tr');
    var cuerpo = crear('tbody');
    var orden = { col: -1, asc: true };
    var cabeceras = [];

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
      cabeceras.forEach(function (th, i) {
        th.textContent = columnas[i].titulo + (orden.col === i ? (orden.asc ? ' ▲' : ' ▼') : '');
        th.setAttribute('aria-sort', orden.col === i ? (orden.asc ? 'ascending' : 'descending') : 'none');
      });
      lista.forEach(function (fila) {
        var est = (opciones.estiloFila && opciones.estiloFila(fila)) || {};
        var tr = crear('tr', { background: est.fondo || 'transparent', cursor: opciones.alClicFila ? 'pointer' : 'default', transition: 'background 0.15s' });
        if (opciones.alClicFila) tr.addEventListener('click', function () { opciones.alClicFila(fila); });
        tr.addEventListener('mouseenter', function () { tr.style.background = est.hover || 'rgba(255,255,255,0.03)'; });
        tr.addEventListener('mouseleave', function () { tr.style.background = est.fondo || 'transparent'; });
        columnas.forEach(function (col, i) {
          var td = crear('td', {
            padding: '10px 12px', color: D.text, textAlign: col.alinear || 'left', verticalAlign: 'top',
            borderBottom: '1px solid ' + D.borde2, background: col.fondo || 'transparent'
          });
          if (i === 0 && est.borde) td.style.borderLeft = '3px solid ' + est.borde;
          var v = col.valor(fila);
          if (v && v.nodeType) td.appendChild(v); else td.textContent = (v === null || v === undefined) ? '' : String(v);
          tr.appendChild(td);
        });
        cuerpo.appendChild(tr);
      });
    }

    columnas.forEach(function (col, i) {
      var th = crear('th', {
        padding: '9px 12px', textAlign: col.alinear || 'left', fontSize: '0.66rem', fontWeight: '700', textTransform: 'uppercase',
        letterSpacing: '0.05em', whiteSpace: 'nowrap', background: D.panelAlt, borderBottom: '1px solid ' + D.border,
        color: col.colorTitulo || D.muted, cursor: col.orden ? 'pointer' : 'default'
      });
      if (col.orden) th.addEventListener('click', function () {
        orden = { col: i, asc: orden.col === i ? !orden.asc : true };
        pintar();
      });
      cabeceras.push(th);
      filaCabecera.appendChild(th);
    });
    var cab = crear('thead');
    cab.appendChild(filaCabecera);
    tabla.appendChild(cab);
    tabla.appendChild(cuerpo);
    envoltorio.appendChild(tabla);
    pintar();
    return envoltorio;
  }

  // Panel con cabecera (punto de color + título + detalle) y una acción opcional a la derecha.
  function seccionPanel(color, titulo, detalle, subtitulo, accion) {
    var panel = crear('div', { background: D.panel, border: '1px solid ' + D.border, borderRadius: '8px', marginBottom: '16px', overflow: 'hidden' });
    var cab = crear('div', {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', padding: '14px 16px 12px 16px',
      borderBottom: '1px solid ' + D.borde2
    });
    var izq = crear('div');
    var fila = crear('div', { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' });
    fila.appendChild(crear('span', { width: '14px', height: '14px', borderRadius: '50%', background: color, boxShadow: '0 0 10px ' + color, display: 'inline-block' }));
    fila.appendChild(crear('h3', { margin: '0', fontSize: '1.1rem', fontWeight: '800', color: color, textTransform: 'uppercase', letterSpacing: '0.01em' }, titulo));
    fila.appendChild(crear('span', { fontSize: '1.05rem', color: D.textSoft }, detalle));
    izq.appendChild(fila);
    if (subtitulo) izq.appendChild(crear('div', { fontSize: '0.72rem', color: D.muted, marginTop: '4px' }, subtitulo));
    cab.appendChild(izq);
    if (accion) cab.appendChild(accion);
    panel.appendChild(cab);
    return panel;
  }

  function mensajeVacio(texto) {
    return crear('div', { padding: '20px 16px', color: D.muted, fontSize: '0.84rem' }, texto);
  }

  function sustantivo(n, singular, plural) { return n + ' ' + (n === 1 ? singular : plural); }

  // --- Un veredicto por vehículo ----------------------------------------------------------------
  // Lámpara encendida y regeneración se juntan en UNA fila: el vehículo cae en un solo grupo según lo que hay que hacer.
  var GRUPOS_ACCION = [
    { codigo: 'LLAMAR', titulo: 'Llamar ya', unidad: 'por contactar', color: D.rojo, fondo: 'rgba(255,77,79,0.12)', hover: 'rgba(255,77,79,0.20)',
      ayuda: 'Hay que llamar al conductor o escalar con el supervisor ahora. Clic en una fila para abrir el expediente.' },
    { codigo: 'REVISAR', titulo: 'Revisar el vehículo', unidad: 'por revisar', color: D.naranja, fondo: 'rgba(251,146,60,0.12)', hover: 'rgba(251,146,60,0.20)',
      ayuda: 'La regeneración no está resolviendo el hollín o la lámpara sigue encendida tras la manual: conviene revisión o taller.' },
    { codigo: 'ESPERAR', titulo: 'Esperar y volver a mirar', unidad: 'en espera', color: '#4EA8FF', fondo: 'rgba(78,168,255,0.06)', hover: 'rgba(78,168,255,0.14)',
      ayuda: 'Regenerando o con la lámpara recién encendida: todavía no piden acción.' }
  ];

  // Devuelve { grupo, estado, texto }: el grupo, la pastilla y la frase de lo que hay que hacer con ese vehículo.
  function accionDe(r) {
    var L = r.abierto ? r.estado : null, G = r.regen || null;
    if (G && G.llamar) return { grupo: 'LLAMAR', estado: G.estado, texto: G.consejo };
    if (L && (L.codigo === 'AVISAR' || L.codigo === 'ESCALADO')) return { grupo: 'LLAMAR', estado: L, texto: L.texto };
    if (G && (G.estado.codigo === 'VALIDAR' || G.estado.codigo === 'ATENCION' || G.estado.codigo === 'PROLONGADA')) return { grupo: 'REVISAR', estado: G.estado, texto: G.consejo };
    if (L && L.codigo === 'TALLER') return { grupo: 'REVISAR', estado: L, texto: L.texto };
    // Con el testigo mudo manda la lámpara (si la hay); si no, lo que diga la regeneración.
    if (G && (G.estado.codigo !== 'SIN_LECTURAS' || !L)) return { grupo: 'ESPERAR', estado: G.estado, texto: G.consejo || G.estado.texto };
    return { grupo: 'ESPERAR', estado: L, texto: L.texto };
  }

  function listaAtencion(resultados) {
    var por = { LLAMAR: [], REVISAR: [], ESPERAR: [] };
    resultados.filter(function (r) { return r.abierto || r.regen; }).forEach(function (r) {
      r.accion = accionDe(r);
      por[r.accion.grupo].push(r);
    });
    function nivel(r) { return Math.max(r.abierto ? r.estado.nivel : 0, r.regen ? r.regen.estado.nivel : 0); }
    function hollin(r) { var h = r.regen && r.regen.hollinActual ? r.regen.hollinActual : r.hollinActual; return h ? h.valor : 0; }
    Object.keys(por).forEach(function (k) { por[k].sort(function (a, b) { return (nivel(b) - nivel(a)) || (hollin(b) - hollin(a)); }); });
    return por;
  }

  // Qué hacer: pastilla + la frase de acción en lenguaje claro.
  function celdaAccion(r) {
    var caja = crear('div', { minWidth: '250px' });
    caja.appendChild(crearPildoraEstado(r.accion.estado));
    caja.appendChild(crear('div', { fontSize: '0.8rem', fontWeight: '600', color: D.text, marginTop: '5px', maxWidth: '340px', lineHeight: '1.4' }, r.accion.texto));
    return caja;
  }

  // Situación: los dos hechos del vehículo (lámpara y regeneración) en dos líneas, sin repetir filas.
  function celdaSituacion(r) {
    var caja = crear('div', { fontSize: '0.74rem', color: D.textSoft, lineHeight: '1.5', minWidth: '210px' });
    if (r.abierto) {
      caja.appendChild(crear('div', {}, 'Lámpara desde ' + fmtFecha(r.abierto.desde) + ' · ' + fmtHoras(r.abierto.horasMotor) + ' h de motor' +
        (r.abierto.interruptorDesde !== null ? ' · manual activada ' + fmtFecha(r.abierto.interruptorDesde) : '')));
    }
    if (r.regen) {
      var g = r.regen;
      caja.appendChild(crear('div', {}, 'Regeneración ' + g.tipo.etiqueta.toLowerCase() + ' desde ' + (g.desdeAntes ? 'antes del ' : '') + fmtFecha(g.inicio) +
        ' · ' + (g.desdeAntes ? '≥ ' : '') + fmtDuracion(g.minutos / 60) + ' · última lectura hace ' + fmtMinutos(g.edad)));
    }
    return caja;
  }

  // Hollín con su tendencia: sube = rojo, baja = verde.
  function celdaHollin(r) {
    var g = r.regen, h = g && g.hollinActual ? g.hollinActual : r.hollinActual;
    if (!h) return '—';
    var antes = g && g.hollinAntes !== null && Math.round(g.hollinAntes) !== Math.round(h.valor) ? g.hollinAntes : null;
    var caja = crear('div');
    caja.appendChild(crear('b', { fontSize: '0.9rem', color: antes === null ? D.text : (h.valor > antes ? '#FF8587' : D.verde) },
      (antes !== null ? Math.round(antes) + ' % → ' : '') + Math.round(h.valor) + ' %'));
    if (antes !== null) caja.appendChild(crear('div', { fontSize: '0.7rem', color: h.valor > antes ? '#FF8587' : D.verde },
      (h.valor > antes ? '▲ subió ' : '▼ bajó ') + Math.abs(Math.round(h.valor - antes)) + ' pts'));
    return caja;
  }

  function seccionAccion(grupo, lista) {
    var panel = seccionPanel(grupo.color, grupo.titulo, '(' + lista.length + ' ' + grupo.unidad + ')', grupo.ayuda);
    panel.appendChild(crearTablaOscura([
      { titulo: 'Vehículo', valor: celdaVehiculo, orden: function (r) { return r.nombre; } },
      { titulo: 'Ciudad', valor: function (r) { return r.ciudad; }, orden: function (r) { return r.ciudad; } },
      { titulo: 'Qué hacer', valor: celdaAccion },
      { titulo: 'Situación', valor: celdaSituacion },
      { titulo: 'Hollín', alinear: 'right', valor: celdaHollin },
      { titulo: 'Acción', alinear: 'center', valor: botonImagenWhatsapp }
    ], lista, {
      alClicFila: abrirExpediente,
      estiloFila: function () { return { fondo: grupo.fondo, hover: grupo.hover, borde: grupo.color }; }
    }));
    return panel;
  }

  // Reglas que usa el tablero, tomadas de las mismas constantes que la lógica (no se repiten a mano).
  function lineasReglas() {
    function marca(m) { return m.charAt(0).toUpperCase() + m.slice(1); }
    return [
      '"Próximo": hollín por encima del umbral de la marca con la lámpara apagada. Umbral por defecto (International y demás): ' + HOLLIN_PROXIMO_DEFECTO + ' %; ' +
        UMBRAL_HOLLIN_POR_MARCA.map(function (m) { return marca(m[0]) + ' ' + m[1] + ' %'; }).join(', ') + '.',
      'La lámpara se enciende hacia ' + HOLLIN_LAMPARA_APROX + ' % o más: con estos umbrales hay horas de adelanto para regenerar sin esperar el aviso.',
      'Lámpara encendida: avisar al conductor a las ' + UMBRAL_HORAS_ALERTA_CONDUCTOR + ' h de motor encendido, escalar a las ' + UMBRAL_HORAS_ESCALADO_CONDUCTOR +
        ' h, y llevar a taller a las ' + UMBRAL_HORAS_ALERTA_TALLER + ' h de haber activado el interruptor sin que la lámpara se apague.',
      'Manual o automática: manual = el interruptor manual se vio activado desde 30 min antes del inicio hasta ahora; automática = no se vio. El interruptor se registra por eventos, así que una pulsación muy corta podría no quedar registrada.',
      'Cuándo pedir la manual (solo si es automática): "Validar el sistema" = hollín de ' + REGEN_HOLLIN_VALIDAR + ' % o más; "Atención" = hollín de ' + REGEN_HOLLIN_ATENCION +
        ' % o más que a los ' + REGEN_ATENCION_MIN + ' min no ha bajado ' + REGEN_CAIDA_MIN_PP + ' puntos. Calibrado con 30 días de la flota: con hollín de 60 % o más la automática suele resolver sola, por eso se espera; la lámpara se enciende hacia 125-145 %.',
      'En regeneración: el testigo de regeneración activa está encendido ahora. Más de ' + REGEN_PROLONGADA_H + ' h seguidas se marca "prolongada" (conviene revisar el vehículo). Mientras regenera no figura como "próximo".',
      'Testigo "necesaria" ("Pendiente"): el testigo de regeneración tiene dos valores activos. 1 = regenerando; 2 = el motor pide la regeneración pero no la ejecuta (norma J1939, SPN 3700). Medido en 4 días de la flota: con 1 el hollín baja en 1 de cada 3 lecturas; con 2 casi no baja. Con ' + REGEN_MANUALES_SIN_EFECTO + ' o más manuales sin que baje el hollín se recomienda taller. Hollín de 199 % o más en lecturas seguidas = tope del sensor (filtro saturado o sensor pegado).',
      'Solo se leen las últimas ' + HORAS_HOLLIN_RECIENTE + ' h de hollín y ' + DIAS_HISTORIA_LAMPARA + ' días de lámpara. Una lectura de hollín de ' + HOLLIN_MAX_VALIDO + ' % o más se descarta solo si está aislada (si se repite en lecturas seguidas se toma como real).'
    ];
  }

  function seccionProximos(lista) {
    var panelReglas = crear('div', { display: 'none', padding: '12px 16px', background: D.panelAlt, borderBottom: '1px solid ' + D.borde2 });
    lineasReglas().forEach(function (linea) {
      panelReglas.appendChild(crear('p', { margin: '0 0 6px 0', fontSize: '0.78rem', color: D.textSoft, lineHeight: '1.45' }, linea));
    });
    var enlace = crear('button', {
      display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'transparent', border: 'none', cursor: 'pointer',
      color: '#4EA8FF', fontFamily: T.font, fontSize: '0.8rem', padding: '4px 0'
    });
    enlace.type = 'button';
    enlace.setAttribute('aria-expanded', 'false');
    enlace.appendChild(crearIcono('info', '15px'));
    enlace.appendChild(crear('span', {}, 'Ver reglas de umbral'));
    enlace.addEventListener('click', function () {
      var abierto = panelReglas.style.display === 'none';
      panelReglas.style.display = abierto ? 'block' : 'none';
      enlace.setAttribute('aria-expanded', abierto ? 'true' : 'false');
    });

    var panel = seccionPanel(D.amarillo, 'Próximos al umbral',
      '(' + sustantivo(lista.length, 'vehículo preventivo', 'vehículos preventivos') + ')', null, enlace);
    panel.appendChild(panelReglas);
    if (!lista.length) { panel.appendChild(mensajeVacio('Ningún vehículo cerca del umbral.')); return panel; }

    panel.appendChild(crearTablaOscura([
      { titulo: 'Vehículo', valor: celdaVehiculo, orden: function (r) { return r.nombre; } },
      { titulo: 'Ciudad', valor: function (r) { return r.ciudad; }, orden: function (r) { return r.ciudad; } },
      { titulo: 'Marca', valor: function (r) { return r.marca; } },
      {
        titulo: 'Hollín', alinear: 'right', valor: function (r) { return crear('b', { color: D.amarillo }, Math.round(r.hollinActual.valor) + ' %'); },
        orden: function (r) { return r.hollinActual.valor; }
      },
      { titulo: 'Umbral', alinear: 'right', valor: function (r) { return crear('span', { color: D.amarillo }, r.umbralHollin + ' %'); } },
      { titulo: 'Leído', valor: function (r) { return fmtFecha(r.hollinActual.t); }, orden: function (r) { return r.hollinActual.t; } },
      { titulo: 'Acción', alinear: 'center', valor: botonImagenWhatsapp }
    ], lista, { alClicFila: abrirExpediente }));
    return panel;
  }

  // Aviso de vehículos que este tablero no puede vigilar, con el listado desplegable.
  function avisoSinSenal(sinSenal) {
    var caja = crear('div', { background: D.panel, border: '1px solid ' + D.border, borderRadius: '8px', marginBottom: '16px', overflow: 'hidden' });
    var fila = crear('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', padding: '12px 16px' });
    var texto = crear('div', { display: 'flex', alignItems: 'center', gap: '12px', color: D.textSoft, fontSize: '0.9rem' });
    texto.appendChild(crearIcono('alerta', '20px', D.amarillo));
    texto.appendChild(crear('span', {}, 'Hay ' + sustantivo(sinSenal.length, 'vehículo que no reportó', 'vehículos que no reportaron') + ' hollín en las últimas ' +
      HORAS_HOLLIN_RECIENTE + ' h ni lámpara DPF en ' + DIAS_HISTORIA_LAMPARA + ' días (sin señal o parqueados): el tablero no puede vigilarlos.'));
    fila.appendChild(texto);

    var boton = crear('button', {
      padding: '7px 14px', borderRadius: '6px', cursor: 'pointer', fontFamily: T.font, fontSize: '0.8rem',
      background: 'transparent', color: '#4EA8FF', border: '1px solid rgba(78,168,255,0.5)'
    }, 'Ver listado de placas');
    boton.type = 'button';
    boton.setAttribute('aria-expanded', 'false');
    fila.appendChild(boton);
    caja.appendChild(fila);

    var lista = crear('div', { display: 'none', padding: '4px 16px 14px 16px', borderTop: '1px solid ' + D.borde2 });
    var porCiudad = {};
    sinSenal.forEach(function (r) { (porCiudad[r.ciudad] = porCiudad[r.ciudad] || []).push(r.nombre); });
    Object.keys(porCiudad).sort().forEach(function (ciudad) {
      lista.appendChild(crear('div', { fontSize: '0.7rem', fontWeight: '700', color: D.muted, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '12px 0 6px 0' },
        ciudad + ' (' + porCiudad[ciudad].length + ')'));
      var chips = crear('div', { display: 'flex', flexWrap: 'wrap', gap: '6px' });
      porCiudad[ciudad].sort().forEach(function (nombre) {
        chips.appendChild(crear('span', { padding: '3px 10px', borderRadius: T.radius.pill, fontSize: '0.75rem', color: D.textSoft, background: D.panelSoft, border: '1px solid ' + D.border }, nombre));
      });
      lista.appendChild(chips);
    });
    caja.appendChild(lista);
    boton.addEventListener('click', function () {
      var abierto = lista.style.display === 'none';
      lista.style.display = abierto ? 'block' : 'none';
      boton.setAttribute('aria-expanded', abierto ? 'true' : 'false');
      boton.textContent = abierto ? 'Ocultar listado' : 'Ver listado de placas';
    });
    return caja;
  }

  function renderizar() {
    var cont = vaciar(contenedorResultados);
    var resultados = delaCiudad(datosCache.resultados);
    var por = listaAtencion(resultados), prox = listaProximos(resultados);
    // Sin señal = no hay hollín, lámpara ni regeneración activa: el tablero no puede vigilarlo.
    var sinSenal = resultados.filter(function (r) { return !r.tieneHollin && !r.tieneLampara && !r.tieneRegen; });

    // El filtro de estado elige qué grupo se ve (LLAMAR, REVISAR, ESPERAR o PROXIMO); vacío = todos.
    var hay = false;
    GRUPOS_ACCION.forEach(function (g) {
      if ((estadoElegido === '' || estadoElegido === g.codigo) && por[g.codigo].length) { cont.appendChild(seccionAccion(g, por[g.codigo])); hay = true; }
    });
    if (!hay && estadoElegido === '') cont.appendChild(seccionPanel(D.verde, 'Nada por atender', '(sin lámpara encendida ni regeneración en curso)')).appendChild(mensajeVacio('✅ Ningún vehículo con la lámpara encendida ni regenerando por ahora.'));
    if (estadoElegido === '' || estadoElegido === 'PROXIMO') cont.appendChild(seccionProximos(prox));
    if (sinSenal.length) cont.appendChild(avisoSinSenal(sinSenal));
    cont.appendChild(crear('div', { fontSize: '0.7rem', color: D.faint, padding: '0 2px 14px 2px', lineHeight: '1.45' },
      'Horas de motor = tiempo con la ignición encendida y la lámpara prendida. Se actualiza solo cada 5 min mientras el tablero está abierto.'));
  }

  // --- Encabezado y filtros ---------------------------------------------------------------------
  function botonCabecera(texto, icono, colorIcono) {
    var b = crear('button', {
      display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '8px 16px', borderRadius: '6px', cursor: 'pointer',
      fontFamily: T.font, fontSize: '0.84rem', transition: 'background 0.15s'
    });
    b.type = 'button';
    if (icono) b.appendChild(crearIcono(icono, '16px', colorIcono));
    b.appendChild(crear('span', {}, texto));
    return b;
  }

  function construirEncabezadoPanel(raiz) {
    var cab = crear('header', {
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '14px',
      padding: '18px 22px 16px 22px', background: D.panelAlt, borderBottom: '1px solid ' + D.border
    });

    var izq = crear('div');
    // Solo el nombre: el logo no está disponible como archivo y no se improvisa uno.
    izq.appendChild(crear('div', { fontSize: '0.95rem', fontWeight: '700', color: '#FFFFFF', marginBottom: '10px' }, 'Promoambiental'));
    izq.appendChild(crear('h1', { margin: '0', fontSize: '1.7rem', fontWeight: '800', color: '#FFFFFF', letterSpacing: '-0.01em' }, 'Seguimiento de Regeneraciones DPF'));
    izq.appendChild(crear('p', { margin: '6px 0 0 0', fontSize: '0.84rem', color: D.muted },
      'Estado en vivo · priorización de lámparas DPF y alertas de hollín preventivas.'));
    cab.appendChild(izq);

    var der = crear('div', { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '12px' });
    var actualizacion = crear('div', { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', color: D.muted });
    actualizacion.appendChild(crearIcono('actualizar', '14px', D.verde));
    elementos.textoActualizacion = crear('span', {}, 'Actualización: …');
    actualizacion.appendChild(elementos.textoActualizacion);
    der.appendChild(actualizacion);

    var botones = crear('div', { display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'flex-end' });
    elementos.botonCopiar = botonCabecera('Copiar reporte general', 'chat', D.whatsapp);
    aplicarEstilo(elementos.botonCopiar, { color: D.whatsapp, background: 'transparent', border: '1px solid rgba(37,211,102,0.55)' });
    elementos.botonCopiar.addEventListener('mouseenter', function () { elementos.botonCopiar.style.background = 'rgba(37,211,102,0.12)'; });
    elementos.botonCopiar.addEventListener('mouseleave', function () { elementos.botonCopiar.style.background = 'transparent'; });
    elementos.botonCopiar.addEventListener('click', function () {
      if (!datosCache) return;
      Promise.resolve(copiarTexto(textoParaCopiar())).then(function (ok) {
        mostrarAviso(ok ? '✓ Reporte copiado: pégalo en el grupo de WhatsApp.' : 'No se pudo copiar: selecciona y copia manualmente.');
      });
    });
    botones.appendChild(elementos.botonCopiar);

    elementos.botonActualizar = botonCabecera('Actualizar ahora', 'actualizar');
    aplicarEstilo(elementos.botonActualizar, { color: '#FFFFFF', background: '#374151', border: 'none' });
    elementos.botonActualizar.addEventListener('mouseenter', function () { if (!elementos.botonActualizar.disabled) elementos.botonActualizar.style.background = '#4B5563'; });
    elementos.botonActualizar.addEventListener('mouseleave', function () { elementos.botonActualizar.style.background = '#374151'; });
    elementos.botonActualizar.addEventListener('click', function () { cargarYRenderizar(false); });
    botones.appendChild(elementos.botonActualizar);
    der.appendChild(botones);

    elementos.aviso = crear('div', { fontSize: '0.76rem', color: D.verde, maxWidth: '420px', textAlign: 'right', minHeight: '1em', lineHeight: '1.35' });
    der.appendChild(elementos.aviso);
    cab.appendChild(der);
    raiz.appendChild(cab);
  }

  // Select oscuro: el borde se pone verde cuando tiene un filtro puesto.
  function selectOscuro(nombreAccesible, onChange) {
    var select = crear('select', {
      padding: '8px 12px', background: D.bg, border: '1px solid ' + D.border, borderRadius: T.radius.sm,
      fontSize: '0.82rem', fontFamily: T.font, color: D.textSoft, cursor: 'pointer', outline: 'none', colorScheme: 'dark', minWidth: '190px'
    });
    select.setAttribute('aria-label', nombreAccesible);
    select.addEventListener('change', function () {
      select.style.borderColor = select.value === '' ? D.border : D.verde;
      onChange(select.value);
    });
    return select;
  }

  function llenarSelect(select, opciones, elegido) {
    vaciar(select);
    opciones.forEach(function (o) {
      var op = crear('option', { background: D.panel, color: D.text });
      op.value = o.valor; op.textContent = o.etiqueta;
      select.appendChild(op);
    });
    select.value = elegido;
    select.style.borderColor = elegido === '' ? D.border : D.verde;
  }

  function construirFiltros(contenedor) {
    var panel = crear('div', {
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '12px', padding: '12px 16px', marginBottom: '18px',
      background: D.panel, border: '1px solid ' + D.border, borderRadius: '8px'
    });
    panel.appendChild(crear('span', { fontSize: '0.82rem', fontWeight: '600', color: D.muted }, 'Filtros:'));
    elementos.selectBase = selectOscuro('Base', function (v) { ciudadElegida = v; actualizarFiltros(); renderizar(); });
    elementos.selectEstado = selectOscuro('Estado', function (v) { estadoElegido = v; renderizar(); });
    llenarSelect(elementos.selectBase, [{ valor: '', etiqueta: 'Todas las bases' }], '');
    llenarSelect(elementos.selectEstado, [{ valor: '', etiqueta: 'Cualquier estado' }], '');
    panel.appendChild(elementos.selectBase);
    panel.appendChild(elementos.selectEstado);
    contenedor.appendChild(panel);
  }

  // Las opciones salen de los datos: cada base con lo que tiene pendiente y cada estado con su cantidad.
  function actualizarFiltros() {
    var porCiudad = {};
    datosCache.resultados.forEach(function (r) {
      var c = porCiudad[r.ciudad] = porCiudad[r.ciudad] || { LLAMAR: 0, REVISAR: 0, ESPERAR: 0, prox: 0 };
      if (r.abierto || r.regen) c[accionDe(r).grupo]++;
      if (!r.regen && r.proximo) c.prox++;
    });
    if (ciudadElegida && !porCiudad[ciudadElegida]) ciudadElegida = '';
    llenarSelect(elementos.selectBase, [{ valor: '', etiqueta: 'Todas las bases' }].concat(Object.keys(porCiudad).sort().map(function (c) {
      return { valor: c, etiqueta: c + ' — ' + porCiudad[c].LLAMAR + ' llamar · ' + porCiudad[c].REVISAR + ' revisar · ' + porCiudad[c].ESPERAR + ' esperar · ' + porCiudad[c].prox + ' próximos' };
    })), ciudadElegida);

    var base = delaCiudad(datosCache.resultados);
    var opciones = [{ valor: '', etiqueta: 'Cualquier estado' }];
    var porBase = listaAtencion(base);
    GRUPOS_ACCION.forEach(function (g) {
      if (porBase[g.codigo].length) opciones.push({ valor: g.codigo, etiqueta: g.titulo + ' (' + porBase[g.codigo].length + ')' });
    });
    var nProx = listaProximos(base).length;
    if (nProx) opciones.push({ valor: 'PROXIMO', etiqueta: 'Próximos al umbral (' + nProx + ')' });
    if (estadoElegido && !opciones.some(function (o) { return o.valor === estadoElegido; })) estadoElegido = '';
    llenarSelect(elementos.selectEstado, opciones, estadoElegido);

    elementos.botonCopiar.lastChild.textContent = ciudadElegida ? 'Copiar reporte de ' + ciudadElegida : 'Copiar reporte general';
  }

  function cargandoOscuro(contenedor, texto) {
    vaciar(contenedor);
    var caja = crear('div', { padding: '40px 22px', textAlign: 'center', background: D.panel, border: '1px solid ' + D.border, borderRadius: '8px' });
    var linea = crear('div', { fontSize: '0.85rem', color: D.textSoft, fontWeight: '600' }, texto);
    caja.appendChild(linea);
    contenedor.appendChild(caja);
    return linea;
  }

  function errorOscuro(contenedor, mensaje) {
    vaciar(contenedor);
    var caja = crear('div', { padding: '22px 24px', background: 'rgba(255,77,79,0.10)', border: '1px solid rgba(255,77,79,0.45)', borderLeft: '4px solid ' + D.rojo, borderRadius: '8px' });
    caja.appendChild(crear('div', { color: '#FF8587', fontWeight: '700', marginBottom: '4px' }, 'No se pudo cargar la información'));
    caja.appendChild(crear('div', { color: D.textSoft, fontSize: '0.82rem' }, mensaje));
    contenedor.appendChild(caja);
  }

  // ============================================================================
  // EXPEDIENTE DEL MÓVIL
  //
  // Detalle de un vehículo (modal oscuro) con la gráfica de hollín de las últimas
  // 48 h, y la imagen para compartir en grupos de WhatsApp. Se abre con un clic en una fila de las
  // tablas. Todo sale de datos que el tablero ya descargó (datosCache.senales):
  // no hace consultas nuevas a Geotab.
  // ============================================================================

  // Chip de estado sobre fondo oscuro. nivel = el de clasificarEstadoLampara; 'prox' = próximo a regenerar.
  var CHIP_OSCURO = {
    3: { fondo: 'rgba(255,77,79,0.15)', texto: '#FF8587', borde: 'rgba(255,77,79,0.45)' },
    2: { fondo: 'rgba(249,115,22,0.16)', texto: '#FB923C', borde: 'rgba(249,115,22,0.5)' },
    1: { fondo: 'rgba(245,158,11,0.15)', texto: '#FBBF24', borde: 'rgba(245,158,11,0.45)' },
    0: { fondo: 'rgba(148,163,184,0.15)', texto: '#CBD5E1', borde: 'rgba(148,163,184,0.35)' },
    prox: { fondo: 'rgba(250,204,21,0.14)', texto: '#FACC15', borde: 'rgba(250,204,21,0.45)' },
    regen: { fondo: 'rgba(78,168,255,0.15)', texto: '#4EA8FF', borde: 'rgba(78,168,255,0.45)' }
  };

  // Hacia este hollín se enciende la lámpara (mismo dato del aviso de Telegram): solo para
  // pintar la banda "ALTA"; no es un umbral de Geotab.
  var HOLLIN_LAMPARA_APROX = 125;
  // Más que esto entre dos lecturas = intervalo sin lecturas (se dibuja con línea discontinua).
  // El hollín llega con un latido de 30 min (medido en 117.000 lecturas reales: el 30 % de los
  // intervalos son de 30,0 min); solo el 3 % pasa de 45 min, que ya son huecos de verdad.
  var HUECO_SIN_LECTURAS_MIN = 45;
  var TITULO_GRAFICA = 'Filtro de partículas diésel 1 porcentaje de carga de hollín (%)';

  // --- Formato ---------------------------------------------------------------------------
  function fmtFechaSeg(ms) {            // 20/10 19:41:36 (hora Bogotá)
    var d = new Date(ms - 5 * MS_HORA);
    return pad2(d.getUTCDate()) + '/' + pad2(d.getUTCMonth() + 1) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }
  function fmtFechaCompleta(ms) {       // 21/10/2026 13:50
    var p = partesBogota(ms);
    return pad2(p.d) + '/' + pad2(p.m + 1) + '/' + p.a + ' ' + pad2(p.h) + ':' + pad2(p.mi);
  }
  function fmtDuracion(horas) {         // 17 h 30 min · 3 d 4 h
    var totalMin = Math.round(horas * 60);
    var h = Math.floor(totalMin / 60), m = totalMin % 60;
    if (h >= 48) return Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
    if (!h) return m + ' min';
    return h + ' h ' + m + ' min';
  }
  function fmtPct(v) { return (Math.round(v * 10) / 10).toString().replace('.', ',') + ' %'; }

  // --- Modelo: todo lo que muestran el modal y la imagen para compartir -----------------------
  function modeloExpediente(r) {
    var ahora = datosCache.ahora;
    var sen = datosCache.senales[r.id] || { hollin: [], lampara: [], regen: [] };
    var regen = sen.regen || [];
    var t0 = ahora - HORAS_HOLLIN_RECIENTE * MS_HORA;
    var puntos = lecturasParaGrafica(sen.hollin).filter(function (p) { return p[0] >= t0 && p[0] <= ahora; });
    var maxVal = puntos.reduce(function (mx, p) { return Math.max(mx, p[1]); }, 0);
    var ab = r.abierto, rg = r.regen;
    var partes = String(r.nombre).split('-');

    var tLampara = sen.lampara.length ? sen.lampara[sen.lampara.length - 1][0] : null;
    var tHollin = puntos.length ? puntos[puntos.length - 1][0] : null;
    var ultimo = ab ? (Math.max(tLampara || 0, tHollin || 0) || null) : (rg ? rg.ultima : (r.hollinActual ? r.hollinActual.t : null));
    var hace = ultimo ? 'hace ' + fmtMinutos((ahora - ultimo) / MS_MIN) : '';

    // La situación que describe el expediente: la lámpara encendida manda; luego la regeneración en curso; luego el hollín próximo.
    var estado = ab ? r.estado : (rg ? rg.estado : null);
    var notas = [];
    if (ab && ab.interruptorDesde !== null) notas.push('Interruptor manual activo desde ' + fmtFechaSeg(ab.interruptorDesde) + ' (hace ' + fmtDuracion(ab.horasDesdeInterruptor) + ').');
    if (ab && rg) notas.push('El testigo de regeneración está activo desde ' + (rg.desdeAntes ? 'antes del ' : '') + fmtFechaSeg(rg.inicio) + ' (' + rg.tipo.etiqueta.toLowerCase() + ').');

    var m = {
      r: r, ahora: ahora,
      codigo: partes.length > 1 ? partes[0] : r.nombre,
      placa: partes.length > 1 ? partes.slice(1).join('-') : '',
      chipTexto: estado ? estado.etiqueta.toUpperCase() : 'PRÓXIMO',
      chipNivel: estado ? (estado.tono !== undefined ? estado.tono : estado.nivel) : 'prox',
      titulo: ab ? 'LÁMPARA DPF ENCENDIDA — ' + r.estado.etiqueta.toUpperCase()
        : (rg ? 'REGENERACIÓN ACTIVA — ' + rg.estado.etiqueta.toUpperCase() : 'HOLLÍN PRÓXIMO AL UMBRAL — ' + Math.round(r.hollinActual.valor) + ' %'),
      // Con la lámpara encendida el estado manda, pero si la regeneración ya muestra que el hollín no cede (validar / atención)
      // su consejo va también: p. ej. "29 manuales y sigue en 180 %: taller" no puede quedar como "esperando que la lámpara se apague".
      accion: estado ? estado.texto + (rg && rg.consejo && (!ab || rg.estado.codigo === 'VALIDAR' || rg.estado.codigo === 'ATENCION') ? (/[.!?]$/.test(estado.texto) ? ' ' : '. ') + rg.consejo : '')
        : 'Hollín sobre el umbral de la marca (' + r.umbralHollin + ' %) con la lámpara apagada: hay horas de adelanto para regenerar antes de que la lámpara se encienda.',
      nota: notas.join(' '),
      tarjetas: []
    };

    if (ab) {
      m.tarjetas.push({ titulo: 'Duración observada', valor: fmtDuracion(ab.horasTotal), sub: fmtDuracion(ab.horasMotor) + ' con el motor encendido' });
      m.tarjetas.push({ titulo: 'Inicio', valor: fmtFechaSeg(ab.desde), sub: 'lámpara DPF encendida' });
      m.tarjetas.push({ titulo: 'Último registro', valor: ultimo ? fmtFechaSeg(ultimo) : '—', sub: hace });
      // hollinActual descarta lecturas >= HOLLIN_MAX_VALIDO AISLADAS (ruido); si la gráfica sí tiene una, se muestra
      // aclarando que el tablero no la usa, para que la tarjeta y la gráfica no se contradigan.
      var ultimaLectura = puntos.length ? puntos[puntos.length - 1] : null;
      if (r.hollinActual) m.tarjetas.push({ titulo: 'Hollín actual', valor: fmtPct(r.hollinActual.valor), sub: 'umbral de la marca ' + r.umbralHollin + ' %' });
      else if (ultimaLectura) m.tarjetas.push({ titulo: 'Última lectura de hollín', valor: fmtPct(ultimaLectura[1]), sub: 'sobre ' + HOLLIN_MAX_VALIDO + ' %: el tablero no la usa para "próximos"' });
      else m.tarjetas.push({ titulo: 'Hollín actual', valor: '—', sub: 'sin lectura en las últimas 48 h' });
    } else if (rg) {
      m.tarjetas.push({
        titulo: 'Duración observada', valor: (rg.desdeAntes ? '≥ ' : '') + fmtDuracion(rg.minutos / 60),
        sub: rg.desdeAntes ? 'ya estaba activo al empezar las ' + HORAS_REGEN_ACTIVA + ' h' : 'testigo de regeneración activo'
      });
      m.tarjetas.push({
        titulo: 'Inicio', valor: (rg.desdeAntes ? 'antes del ' : '') + fmtFechaSeg(rg.inicio),
        sub: rg.tipo.codigo === 'MANUAL' ? 'manual: activó el interruptor ' + fmtFecha(rg.tipo.primera) : 'automática: no se vio el interruptor'
      });
      m.tarjetas.push({
        titulo: 'Hollín', valor: rg.hollinActual ? (rg.hollinAntes !== null && Math.round(rg.hollinAntes) !== Math.round(rg.hollinActual.valor) ? fmtPct(rg.hollinAntes) + ' → ' : '') + fmtPct(rg.hollinActual.valor) : '—',
        sub: rg.caida === null ? (rg.hollinActual && rg.hollinAntes === null ? 'sin lectura de hollín antes del inicio: no se mide la caída' : 'aún sin lecturas para medir la caída')
          : (rg.caida < 0 ? 'subió ' + Math.round(-rg.caida) + ' puntos: no está bajando' : 'bajó ' + Math.round(rg.caida) + ' puntos (mínimo ' + fmtPct(rg.hollinMin) + ')')
      });
      m.tarjetas.push({ titulo: 'Último registro', valor: fmtFechaSeg(rg.ultima), sub: hace });
    } else {
      m.tarjetas.push({ titulo: 'Hollín actual', valor: fmtPct(r.hollinActual.valor), sub: 'lectura ' + hace });
      m.tarjetas.push({ titulo: 'Umbral de la marca', valor: r.umbralHollin + ' %', sub: r.marca });
      m.tarjetas.push({ titulo: 'Último registro', valor: fmtFechaSeg(ultimo), sub: hace });
    }

    // Gráfica: solo si hay lecturas de hollín en las últimas 48 h.
    m.grafica = null;
    if (puntos.length) {
      var lamparas = [], interruptores = [];
      (r.solicitudes || []).forEach(function (e) {
        var hasta = e.fin || ahora;
        if (hasta >= t0 && e.inicio <= ahora) lamparas.push({ desde: e.inicio, hasta: hasta });
      });
      var interruptorActivo = false;
      (sen.interruptor || []).forEach(function (mm) {
        if (mm[1] > 0 && !interruptorActivo && mm[0] >= t0 && mm[0] <= ahora) interruptores.push(mm[0]);
        interruptorActivo = mm[1] > 0;
      });
      m.grafica = {
        t0: t0, t1: ahora, puntos: puntos, umbral: r.umbralHollin,
        ymax: Math.max(140, Math.ceil((maxVal + 5) / 10) * 10),
        lamparas: lamparas, interruptores: interruptores,
        regen: sesionesRegen(regen, ahora).filter(function (s) { return s.hasta >= t0 && s.desde <= ahora; }),
        regeneraciones: (r.regeneraciones || []).filter(function (e) { return e.fin >= t0 && e.fin <= ahora; }),
        etiqueta: 'Hollín de las últimas 48 horas. Lectura más reciente: ' + fmtPct(puntos[puntos.length - 1][1]) + '.'
      };
    }
    return m;
  }

  // --- Gráfica de hollín en SVG (sin librerías) -----------------------------------------------
  // El mismo dibujo sirve para el modal y para la imagen que se comparte. Solo lleva números y
  // textos fijos: ningún dato de Geotab entra como texto en el SVG.
  var GRAF = { W: 960, H: 270, ml: 46, mr: 16, mt: 14, mb: 30 };

  var TEMA_GRAFICA = {
    texto: '#94A3B8', rejilla: '#2A2E39', eje: '#64748B', linea: '#4EA8FF', hueco: '#8FA3BF',
    baja: 'rgba(255,255,255,0.03)', media: 'rgba(250,173,20,0.07)', alta: 'rgba(255,77,79,0.09)',
    txtBaja: '#6B7280', txtMedia: '#F59E0B', txtAlta: '#FF6B6D',
    lampara: 'rgba(255,77,79,0.16)', lamparaTxt: '#FF8587', regen: '#00D084', interruptor: '#FAAD14', fondo: '#131722',
    regenActiva: 'rgba(78,168,255,0.14)', regenActivaTxt: '#4EA8FF'
  };

  function svgHollin(g) {
    var C = TEMA_GRAFICA;
    var pw = GRAF.W - GRAF.ml - GRAF.mr, ph = GRAF.H - GRAF.mt - GRAF.mb, span = g.t1 - g.t0;
    function x(t) { return GRAF.ml + Math.max(0, Math.min(1, (t - g.t0) / span)) * pw; }
    function y(v) { return GRAF.mt + ph - Math.max(0, Math.min(g.ymax, v)) / g.ymax * ph; }
    function n(v) { return Math.round(v * 10) / 10; }
    var s = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + GRAF.W + ' ' + GRAF.H + '" width="100%" role="img" ' +
      'aria-label="' + g.etiqueta + '" style="display:block;font-family:Arial,Helvetica,sans-serif">'];

    // Bandas de severidad (BAJA hasta el umbral de la marca, MEDIA hasta donde se enciende la lámpara, ALTA por encima).
    [[0, g.umbral, C.baja, 'BAJA', C.txtBaja], [g.umbral, HOLLIN_LAMPARA_APROX, C.media, 'MEDIA', C.txtMedia], [HOLLIN_LAMPARA_APROX, g.ymax, C.alta, 'ALTA', C.txtAlta]]
      .forEach(function (b) {
        s.push('<rect x="' + GRAF.ml + '" y="' + n(y(b[1])) + '" width="' + pw + '" height="' + n(y(b[0]) - y(b[1])) + '" fill="' + b[2] + '"/>');
        s.push('<text x="' + (GRAF.ml + pw - 6) + '" y="' + n(y(b[1]) + 12) + '" text-anchor="end" font-size="9" font-weight="700" fill="' + b[4] + '">' + b[3] + '</text>');
      });

    // Rejilla y ejes: horizontal cada 25 %, vertical cada 6 h en punto (hora Bogotá).
    for (var v = 0; v <= g.ymax; v += 25) {
      s.push('<line x1="' + GRAF.ml + '" x2="' + (GRAF.ml + pw) + '" y1="' + n(y(v)) + '" y2="' + n(y(v)) + '" stroke="' + C.rejilla + '" stroke-width="1"/>');
      s.push('<text x="' + (GRAF.ml - 6) + '" y="' + n(y(v) + 3.5) + '" text-anchor="end" font-size="10" fill="' + C.texto + '">' + v + '</text>');
    }
    var seisHoras = 6 * MS_HORA;
    for (var t = Math.ceil((g.t0 - 5 * MS_HORA) / seisHoras) * seisHoras + 5 * MS_HORA; t <= g.t1; t += seisHoras) {
      var p = partesBogota(t);
      s.push('<line x1="' + n(x(t)) + '" x2="' + n(x(t)) + '" y1="' + GRAF.mt + '" y2="' + (GRAF.mt + ph) + '" stroke="' + C.rejilla + '" stroke-width="1"/>');
      s.push('<text x="' + n(x(t)) + '" y="' + (GRAF.H - 10) + '" text-anchor="middle" font-size="10" fill="' + C.texto + '">' + pad2(p.d) + '/' + pad2(p.m + 1) + ' ' + pad2(p.h) + ':' + pad2(p.mi) + '</text>');
    }
    s.push('<line x1="' + GRAF.ml + '" x2="' + (GRAF.ml + pw) + '" y1="' + (GRAF.mt + ph) + '" y2="' + (GRAF.mt + ph) + '" stroke="' + C.eje + '" stroke-width="1"/>');

    // Lámpara encendida (franja), regeneraciones detectadas e interruptor manual (líneas verticales).
    g.lamparas.forEach(function (l) {
      var x1 = x(l.desde), x2 = x(l.hasta), ancho = Math.max(1.5, x2 - x1);
      s.push('<rect x="' + n(x1) + '" y="' + GRAF.mt + '" width="' + n(ancho) + '" height="' + ph + '" fill="' + C.lampara + '"/>');
      if (ancho > 120) s.push('<text x="' + n(x1 + 5) + '" y="' + (GRAF.mt + 12) + '" font-size="9" font-weight="700" fill="' + C.lamparaTxt + '">LÁMPARA ENCENDIDA</text>');
    });
    g.regen.forEach(function (se) {
      var x1 = x(se.desde), x2 = x(se.hasta), ancho = Math.max(1.5, x2 - x1);
      s.push('<rect x="' + n(x1) + '" y="' + GRAF.mt + '" width="' + n(ancho) + '" height="' + ph + '" fill="' + C.regenActiva + '"/>');
      if (ancho > 150) s.push('<text x="' + n(x1 + 5) + '" y="' + (GRAF.mt + 24) + '" font-size="9" font-weight="700" fill="' + C.regenActivaTxt + '">REGENERACIÓN ACTIVA</text>');
    });
    g.regeneraciones.forEach(function (e) {
      s.push('<line x1="' + n(x(e.fin)) + '" x2="' + n(x(e.fin)) + '" y1="' + GRAF.mt + '" y2="' + (GRAF.mt + ph) + '" stroke="' + C.regen + '" stroke-width="1.4" stroke-dasharray="2 3"/>');
    });
    g.interruptores.forEach(function (t2) {
      s.push('<line x1="' + n(x(t2)) + '" x2="' + n(x(t2)) + '" y1="' + GRAF.mt + '" y2="' + (GRAF.mt + ph) + '" stroke="' + C.interruptor + '" stroke-width="1.6"/>');
    });

    // Umbral de la marca.
    s.push('<line x1="' + GRAF.ml + '" x2="' + (GRAF.ml + pw) + '" y1="' + n(y(g.umbral)) + '" y2="' + n(y(g.umbral)) + '" stroke="' + C.interruptor + '" stroke-width="1" stroke-dasharray="4 4" opacity="0.8"/>');
    s.push('<text x="' + (GRAF.ml + 6) + '" y="' + n(y(g.umbral) - 4) + '" font-size="9" fill="' + C.txtMedia + '">Umbral ' + g.umbral + ' %</text>');

    // Serie: tramo continuo mientras haya lecturas; entre tramos, línea discontinua (intervalo sin lecturas).
    var tramos = [[]], huecos = [];
    g.puntos.forEach(function (pt, i) {
      if (i > 0 && pt[0] - g.puntos[i - 1][0] > HUECO_SIN_LECTURAS_MIN * MS_MIN) {
        huecos.push([g.puntos[i - 1], pt]);
        tramos.push([]);
      }
      tramos[tramos.length - 1].push(pt);
    });
    huecos.forEach(function (h) {
      s.push('<path d="M' + n(x(h[0][0])) + ' ' + n(y(h[0][1])) + 'L' + n(x(h[1][0])) + ' ' + n(y(h[1][1])) + '" fill="none" stroke="' + C.hueco + '" stroke-width="1.6" stroke-dasharray="5 4"/>');
    });
    tramos.forEach(function (tr) {
      if (tr.length === 1) {
        s.push('<circle cx="' + n(x(tr[0][0])) + '" cy="' + n(y(tr[0][1])) + '" r="3" fill="' + C.linea + '"/>');
        return;
      }
      s.push('<path d="M' + tr.map(function (pt) { return n(x(pt[0])) + ' ' + n(y(pt[1])); }).join('L') + '" fill="none" stroke="' + C.linea +
        '" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>');
    });

    // Guía y punto del cursor (los mueve activarHoverGrafica).
    s.push('<line id="hv-guia" x1="0" x2="0" y1="' + GRAF.mt + '" y2="' + (GRAF.mt + ph) + '" stroke="' + C.eje + '" stroke-width="1" visibility="hidden"/>');
    s.push('<circle id="hv-punto" cx="0" cy="0" r="4" fill="' + C.linea + '" stroke="' + C.fondo + '" stroke-width="2" visibility="hidden"/>');
    s.push('</svg>');
    return s.join('');
  }

  function leyendaGraficaHtml(conRegen) {
    var C = TEMA_GRAFICA;
    function item(muestra, texto) {
      return '<span style="display:inline-flex;align-items:center;gap:6px;margin:0 16px 4px 0">' + muestra + '<span>' + texto + '</span></span>';
    }
    function raya(color, estiloLinea, ancho) {
      return '<span style="display:inline-block;width:18px;height:0;border-top:' + ancho + 'px ' + estiloLinea + ' ' + color + '"></span>';
    }
    return item('<span style="display:inline-block;width:14px;height:10px;background:' + C.lampara + ';border:1px solid ' + C.lamparaTxt + '"></span>', 'Lámpara DPF encendida') +
      (conRegen ? item('<span style="display:inline-block;width:14px;height:10px;background:' + C.regenActiva + ';border:1px solid ' + C.regenActivaTxt + '"></span>', 'Regeneración activa o pedida (testigo)') : '') +
      item(raya(C.regen, 'dotted', 2), 'Regeneración detectada (caída del hollín)') +
      item(raya(C.interruptor, 'solid', 2), 'Interruptor manual activado') +
      item(raya(C.hueco, 'dashed', 2), 'Intervalo sin lecturas');
  }

  // Tooltip al pasar el cursor por la gráfica: lectura más cercana (hasta 30 min de distancia).
  function activarHoverGrafica(caja, g) {
    var svg = caja.querySelector('svg');
    if (!svg) return;
    var guia = svg.querySelector('#hv-guia'), punto = svg.querySelector('#hv-punto');
    var tip = crear('div', {
      position: 'absolute', display: 'none', pointerEvents: 'none', zIndex: '2', whiteSpace: 'nowrap', padding: '4px 8px',
      background: '#0B0E14', border: '1px solid ' + D.border, borderRadius: '6px', fontSize: '0.74rem', color: '#FFFFFF'
    });
    caja.style.position = 'relative';
    caja.appendChild(tip);
    var pw = GRAF.W - GRAF.ml - GRAF.mr, ph = GRAF.H - GRAF.mt - GRAF.mb;

    function ocultar() { guia.setAttribute('visibility', 'hidden'); punto.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; }
    svg.addEventListener('mouseleave', ocultar);
    svg.addEventListener('mousemove', function (e) {
      var r = svg.getBoundingClientRect();
      var vx = (e.clientX - r.left) / r.width * GRAF.W;
      var t = g.t0 + (vx - GRAF.ml) / pw * (g.t1 - g.t0);
      var lo = 0, hi = g.puntos.length - 1;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (g.puntos[mid][0] < t) lo = mid + 1; else hi = mid; }
      var mejor = g.puntos[lo];
      if (lo > 0 && Math.abs(g.puntos[lo - 1][0] - t) < Math.abs(mejor[0] - t)) mejor = g.puntos[lo - 1];
      if (Math.abs(mejor[0] - t) > HUECO_SIN_LECTURAS_MIN * MS_MIN) { ocultar(); return; }
      var px = GRAF.ml + (mejor[0] - g.t0) / (g.t1 - g.t0) * pw;
      var py = GRAF.mt + ph - Math.min(g.ymax, mejor[1]) / g.ymax * ph;
      guia.setAttribute('x1', px); guia.setAttribute('x2', px);
      punto.setAttribute('cx', px); punto.setAttribute('cy', py);
      guia.setAttribute('visibility', 'visible'); punto.setAttribute('visibility', 'visible');
      tip.textContent = fmtFecha(mejor[0]) + ' · ' + fmtPct(mejor[1]);
      tip.style.display = 'block';
      tip.style.left = (px / GRAF.W * r.width) + 'px';
      tip.style.top = (py / GRAF.H * r.height - 34) + 'px';
      tip.style.transform = 'translateX(-50%)';
    });
  }

  // --- Imagen para compartir (WhatsApp) ---------------------------------------------------------
  // El expediente se dibuja en un canvas (sin librerías ni HTML intermedio) y sale como PNG vertical:
  // se copia al portapapeles para pegarlo en el grupo, o se descarga para adjuntarlo. Mismo estilo
  // oscuro del modal. A 2x para que el texto se lea nítido en el celular.
  var FUENTE_IMG = "'Inter', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
  var ANCHO_IMG = 1080, MARGEN_IMG = 40, ESCALA_IMG = 2;

  function rectRedondeado(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Parte un texto en líneas que caben en el ancho dado (con ctx.font ya puesto). La primera
  // línea puede tener otro ancho: se usa cuando hay una etiqueta en negrita delante.
  function partirTexto(ctx, texto, anchoPrimera, anchoResto) {
    var lineas = [], actual = '';
    String(texto).split(' ').forEach(function (palabra) {
      var prueba = actual ? actual + ' ' + palabra : palabra;
      var limite = lineas.length ? anchoResto : anchoPrimera;
      if (actual && ctx.measureText(prueba).width > limite) { lineas.push(actual); actual = palabra; } else actual = prueba;
    });
    if (actual) lineas.push(actual);
    return lineas;
  }

  // Dibuja todo el expediente y devuelve la altura que ocupa. Se llama dos veces: una sobre un
  // canvas de medida (para saber el alto) y otra sobre el canvas final.
  function dibujarExpediente(ctx, m, imgGrafica) {
    var W = ANCHO_IMG, M = MARGEN_IMG, IW = W - 2 * M, F = FUENTE_IMG;
    var r = m.r, chip = CHIP_OSCURO[m.chipNivel], C = TEMA_GRAFICA;
    var y = 0;
    ctx.textBaseline = 'alphabetic';

    function texto(t, x, yy, fuente, color, alinear) {
      ctx.font = fuente; ctx.fillStyle = color; ctx.textAlign = alinear || 'left';
      ctx.fillText(t, x, yy);
    }
    function ancho(t, fuente) { ctx.font = fuente; return ctx.measureText(t).width; }

    // Cabecera
    ctx.fillStyle = D.panelAlt; ctx.fillRect(0, 0, W, 104);
    ctx.fillStyle = D.border; ctx.fillRect(0, 104, W, 1);
    texto('EXPEDIENTE DEL MÓVIL', M, 50, '700 30px ' + F, '#FFFFFF');
    texto('Datos al ' + fmtFechaCompleta(m.ahora) + ' · ' + r.ciudad, M, 82, '400 19px ' + F, D.muted);
    y = 138;
    texto(('Seguimiento de regeneración DPF · ' + r.ciudad).toUpperCase(), M, y + 14, '700 16px ' + F, D.muted);
    y += 38;

    // Banda del móvil: si el nombre, el chip y la marca no caben en una fila, el chip y la marca bajan.
    var textoMovil = 'MÓVIL ' + m.codigo + (m.placa ? ' · ' + m.placa : '');
    var wMovil = ancho(textoMovil, '700 46px ' + F);
    var wChip = ancho(m.chipTexto, '700 17px ' + F) + 40;
    var wMarca = ancho(r.marca, '600 21px ' + F);
    var enUnaFila = wMovil + 48 + wChip + 16 + wMarca + 40 <= IW;
    var altoBanda = enUnaFila ? 104 : 166;
    ctx.save();
    rectRedondeado(ctx, M, y, IW, altoBanda, 10);
    ctx.fillStyle = D.panelSoft; ctx.fill();
    ctx.strokeStyle = 'rgba(75,85,99,0.6)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
    texto(textoMovil, M + 24, y + 68, '700 46px ' + F, '#FFFFFF');
    var gx = enUnaFila ? M + IW - 24 - wMarca - 16 - wChip : M + 24;
    var gy = enUnaFila ? y + 33 : y + 100;
    rectRedondeado(ctx, gx, gy, wChip, 38, 6);
    ctx.fillStyle = chip.fondo; ctx.fill();
    ctx.strokeStyle = chip.borde; ctx.stroke();
    ctx.beginPath(); ctx.arc(gx + 17, gy + 19, 4.5, 0, Math.PI * 2); ctx.fillStyle = chip.texto; ctx.fill();
    texto(m.chipTexto, gx + 30, gy + 26, '700 17px ' + F, chip.texto);
    texto(r.marca, gx + wChip + 16, gy + 26, '600 21px ' + F, D.muted);
    y += altoBanda + 30;

    // Título
    ctx.font = '700 34px ' + F;
    partirTexto(ctx, m.titulo, IW, IW).forEach(function (linea) {
      texto(linea, M, y + 34, '700 34px ' + F, '#FFFFFF');
      y += 44;
    });
    y += 12;

    // Qué hacer
    var pad = 20, barra = 6, interior = IW - barra - pad * 2;
    var wEtiqueta = ancho('Qué hacer: ', '700 21px ' + F);
    ctx.font = '400 21px ' + F;
    var lineasAccion = partirTexto(ctx, m.accion, interior - wEtiqueta, interior);
    var lineasNota = m.nota ? partirTexto(ctx, m.nota, interior, interior) : [];
    var altoCaja = pad * 2 + lineasAccion.length * 30 + (lineasNota.length ? 8 + lineasNota.length * 28 : 0) - 6;
    ctx.save();
    rectRedondeado(ctx, M, y, IW, altoCaja, 6);
    ctx.clip();
    ctx.fillStyle = D.panelSoft; ctx.fillRect(M, y, IW, altoCaja);
    ctx.fillStyle = chip.texto; ctx.fillRect(M, y, barra, altoCaja);
    ctx.restore();
    var xt = M + barra + pad, yt = y + pad + 22;
    texto('Qué hacer:', xt, yt, '700 21px ' + F, '#FFFFFF');
    texto(lineasAccion[0] || '', xt + wEtiqueta, yt, '400 21px ' + F, '#CBD5E1');
    for (var i = 1; i < lineasAccion.length; i++) texto(lineasAccion[i], xt, yt + i * 30, '400 21px ' + F, '#CBD5E1');
    yt += (lineasAccion.length - 1) * 30 + 8;
    lineasNota.forEach(function (linea) { yt += 28; texto(linea, xt, yt, '400 19px ' + F, D.muted); });
    y += altoCaja + 26;

    // Tarjetas de datos: 3 en una fila, o 2x2 cuando son 4
    var columnas = m.tarjetas.length >= 4 ? 2 : m.tarjetas.length, hueco = 16;
    var wTarjeta = (IW - hueco * (columnas - 1)) / columnas;
    var filasTarjetas = Math.ceil(m.tarjetas.length / columnas);
    for (var fila = 0; fila < filasTarjetas; fila++) {
      var fragmento = m.tarjetas.slice(fila * columnas, (fila + 1) * columnas);
      ctx.font = '400 16px ' + F;
      var altoFila = Math.max.apply(null, fragmento.map(function (c) {
        return 96 + (c.sub ? partirTexto(ctx, c.sub, wTarjeta - 32, wTarjeta - 32).length * 22 : 0);
      }));
      fragmento.forEach(function (c, j) {
        var x = M + j * (wTarjeta + hueco);
        rectRedondeado(ctx, x, y, wTarjeta, altoFila, 8);
        ctx.fillStyle = D.bg; ctx.fill();
        ctx.strokeStyle = D.border; ctx.stroke();
        texto(c.titulo.toUpperCase(), x + 16, y + 30, '600 14px ' + F, D.muted);
        var tam = 34;
        while (tam > 22 && ancho(c.valor, '700 ' + tam + 'px ' + F) > wTarjeta - 32) tam -= 2;
        texto(c.valor, x + 16, y + 72, '700 ' + tam + 'px ' + F, '#FFFFFF');
        ctx.font = '400 16px ' + F;
        if (c.sub) partirTexto(ctx, c.sub, wTarjeta - 32, wTarjeta - 32).forEach(function (linea, k) {
          texto(linea, x + 16, y + 98 + k * 22, '400 16px ' + F, '#8B98AB');
        });
      });
      y += altoFila + hueco;
    }
    y += 10;

    // Gráfica de hollín
    var anchoGraf = IW - 24, altoGraf = anchoGraf * GRAF.H / GRAF.W;
    var leyenda = [
      { caja: true, color: C.lampara, borde: C.lamparaTxt, t: 'Lámpara DPF encendida' },
      { color: C.regen, trazo: [3, 5], t: 'Regeneración detectada (caída del hollín)' },
      { color: C.interruptor, trazo: [], t: 'Interruptor manual activado' },
      { color: C.hueco, trazo: [8, 6], t: 'Intervalo sin lecturas' }
    ];
    if (m.grafica && m.grafica.regen.length) leyenda.splice(1, 0, { caja: true, color: C.regenActiva, borde: C.regenActivaTxt, t: 'Regeneración activa o pedida (testigo)' });
    var posiciones = [], lx = M + 16, ly = 0, filasLeyenda = 1;
    if (imgGrafica) {
      leyenda.forEach(function (it) {
        var w = 32 + 10 + ancho(it.t, '400 16px ' + F);
        if (lx + w > M + IW - 16) { lx = M + 16; ly += 28; filasLeyenda++; }
        posiciones.push({ it: it, x: lx, dy: ly });
        lx += w + 24;
      });
    }
    var altoCajaGraf = 58 + (imgGrafica ? 10 + altoGraf + 12 + filasLeyenda * 28 + 6 : 96);
    rectRedondeado(ctx, M, y, IW, altoCajaGraf, 8);
    ctx.fillStyle = D.bg; ctx.fill();
    ctx.strokeStyle = D.border; ctx.stroke();
    ctx.fillStyle = D.border; ctx.fillRect(M, y + 58, IW, 1);
    texto(TITULO_GRAFICA, M + 16, y + 36, '600 19px ' + F, '#CBD5E1');
    texto('Últimas 48 h · hora Bogotá', M + IW - 16, y + 36, '400 15px ' + F, D.faint, 'right');
    if (imgGrafica) {
      ctx.drawImage(imgGrafica, M + 12, y + 68, anchoGraf, altoGraf);
      var yLey = y + 68 + altoGraf + 24;
      posiciones.forEach(function (p) {
        var cy = yLey + p.dy;
        if (p.it.caja) {
          ctx.fillStyle = p.it.color; ctx.fillRect(p.x, cy - 12, 26, 16);
          ctx.strokeStyle = p.it.borde; ctx.lineWidth = 1; ctx.strokeRect(p.x + 0.5, cy - 11.5, 25, 15);
        } else {
          ctx.strokeStyle = p.it.color; ctx.lineWidth = 3; ctx.setLineDash(p.it.trazo);
          ctx.beginPath(); ctx.moveTo(p.x, cy - 4); ctx.lineTo(p.x + 30, cy - 4); ctx.stroke();
          ctx.setLineDash([]); ctx.lineWidth = 1;
        }
        texto(p.it.t, p.x + 40, cy, '400 16px ' + F, D.muted);
      });
    } else {
      texto('Este vehículo no reportó hollín en las últimas 48 h: no hay gráfica para mostrar.', M + IW / 2, y + 58 + 54,
        'italic 400 19px ' + F, D.faint, 'center');
    }
    y += altoCajaGraf + 20;

    ctx.font = 'italic 400 15px ' + F;
    partirTexto(ctx, 'Línea discontinua: intervalo sin lecturas (más de ' + HUECO_SIN_LECTURAS_MIN + ' min). La banda ALTA marca donde suele encenderse la lámpara (cerca de ' +
      HOLLIN_LAMPARA_APROX + ' %).', IW, IW).forEach(function (linea) {
      texto(linea, M, y + 14, 'italic 400 15px ' + F, D.faint);
      y += 22;
    });
    y += 18;
    ctx.fillStyle = D.border; ctx.fillRect(0, y, W, 1);
    texto('Seguimiento de Regeneraciones DPF · datos al ' + fmtFechaCompleta(m.ahora), W / 2, y + 36, '400 15px ' + F, D.faint, 'center');
    return y + 60;
  }

  // El SVG de la gráfica se rasteriza como imagen y se pega en el canvas. Primero por data: URI; si el
  // navegador no la acepta, por blob:.
  function svgAImagen(svg) {
    function cargar(url) {
      return new Promise(function (ok, fallo) {
        var img = new Image();
        img.onload = function () { ok(img); };
        img.onerror = function () { fallo(new Error('No se pudo dibujar la gráfica.')); };
        img.src = url;
      });
    }
    return cargar('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)).catch(function () {
      var url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
      return cargar(url).then(function (img) { URL.revokeObjectURL(url); return img; }, function (err) { URL.revokeObjectURL(url); throw err; });
    });
  }

  function generarImagenExpediente(m) {
    // Se rasteriza al doble de tamaño para que no se vea borrosa al escalarla en el canvas de 2x.
    var promesaGrafica = m.grafica
      ? svgAImagen(svgHollin(m.grafica).replace('width="100%"', 'width="' + (GRAF.W * 2) + '" height="' + (GRAF.H * 2) + '"'))
      : Promise.resolve(null);
    return promesaGrafica.then(function (img) {
      var medida = document.createElement('canvas');
      medida.width = ANCHO_IMG; medida.height = 4000;
      var alto = Math.ceil(dibujarExpediente(medida.getContext('2d'), m, img));

      var lienzo = document.createElement('canvas');
      lienzo.width = ANCHO_IMG * ESCALA_IMG; lienzo.height = alto * ESCALA_IMG;
      var ctx = lienzo.getContext('2d');
      ctx.scale(ESCALA_IMG, ESCALA_IMG);
      ctx.fillStyle = D.panel; ctx.fillRect(0, 0, ANCHO_IMG, alto);
      dibujarExpediente(ctx, m, img);
      return new Promise(function (ok, fallo) {
        lienzo.toBlob(function (blob) { if (blob) ok(blob); else fallo(new Error('No se pudo crear la imagen.')); }, 'image/png');
      });
    });
  }

  function nombreImagenExpediente(m) {
    var p = partesBogota(m.ahora);
    return 'Expediente_DPF_' + slug(m.r.nombre) + '_' + p.a + pad2(p.m + 1) + pad2(p.d) + '_' + pad2(p.h) + pad2(p.mi) + '.png';
  }

  function descargarImagenExpediente(m, avisar) {
    avisar('Generando imagen…');
    return generarImagenExpediente(m).then(function (blob) {
      descargarArchivo(nombreImagenExpediente(m), blob, 'image/png');
      avisar('Imagen descargada: adjúntala en el grupo de WhatsApp.');
    }, function (err) { avisar('No se pudo generar la imagen: ' + describirError(err)); });
  }

  // Copia la imagen al portapapeles para pegarla (Ctrl+V) en WhatsApp. Si el navegador no deja
  // copiar imágenes, la descarga en su lugar. La promesa va dentro del ClipboardItem para no perder
  // el permiso del clic mientras se dibuja.
  function copiarImagenExpediente(m, avisar) {
    avisar('Generando imagen…');
    var promesa = generarImagenExpediente(m);
    function descargarDeRespaldo() {
      return promesa.then(function (b) {
        descargarArchivo(nombreImagenExpediente(m), b, 'image/png');
        avisar('No se pudo copiar al portapapeles: se descargó la imagen, adjúntala en WhatsApp.');
      });
    }
    var puedeCopiar = navigator.clipboard && navigator.clipboard.write && window.ClipboardItem;
    var copia = puedeCopiar ? navigator.clipboard.write([new ClipboardItem({ 'image/png': promesa })]) : Promise.reject(new Error('sin portapapeles'));
    return copia.then(function () {
      avisar('✓ Imagen copiada: pégala en el grupo de WhatsApp (Ctrl+V).');
    }, function () {
      return descargarDeRespaldo();
    }).catch(function (err) {
      avisar('No se pudo generar la imagen: ' + describirError(err));
    });
  }

  // --- Modal ---------------------------------------------------------------------------------
  var ALTO_BARRA_MYGEOTAB = 56;   // barra negra superior de MyGeotab (unos 48 px) más un respiro
  var expedienteAbierto = null;   // { superposicion, foco, desbordeBody, alTeclado }

  function cerrarExpediente() {
    if (!expedienteAbierto) return;
    document.removeEventListener('keydown', expedienteAbierto.alTeclado);
    document.body.style.overflow = expedienteAbierto.desbordeBody;
    if (expedienteAbierto.superposicion.parentNode) expedienteAbierto.superposicion.parentNode.removeChild(expedienteAbierto.superposicion);
    var foco = expedienteAbierto.foco;
    expedienteAbierto = null;
    if (foco && foco.focus) foco.focus();
  }

  // variante: 'verde' (acción principal), 'gris' o 'borde'
  function botonExpediente(texto, icono, variante) {
    var ESTILOS = {
      verde: { fondo: D.verde, hover: '#00E699', color: '#06210F', borde: 'none' },
      gris: { fondo: '#374151', hover: '#4B5563', color: '#FFFFFF', borde: 'none' },
      borde: { fondo: 'transparent', hover: 'rgba(255,255,255,0.06)', color: D.muted, borde: '1px solid #4B5563' }
    };
    var e = ESTILOS[variante];
    var b = crear('button', {
      display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '7px 14px', borderRadius: '6px', cursor: 'pointer',
      fontFamily: T.font, fontSize: '0.84rem', fontWeight: variante === 'verde' ? '700' : '400',
      color: e.color, background: e.fondo, border: e.borde, transition: 'background 0.15s'
    });
    b.type = 'button';
    b.appendChild(crearIcono(icono, '15px'));
    b.appendChild(crear('span', {}, texto));
    b.addEventListener('mouseenter', function () { if (!b.disabled) b.style.background = e.hover; });
    b.addEventListener('mouseleave', function () { b.style.background = e.fondo; });
    return b;
  }

  function abrirExpediente(r) {
    cerrarExpediente();
    var m = modeloExpediente(r);

    // top: la barra superior de MyGeotab queda por encima de cualquier capa del add-in y tapaba la
    // cabecera del modal; la superposición empieza por debajo de ella.
    var superposicion = crear('div', {
      position: 'fixed', top: ALTO_BARRA_MYGEOTAB + 'px', left: '0', right: '0', bottom: '0', zIndex: '10000', overflowY: 'auto',
      background: 'rgba(8,10,16,0.74)', padding: '0 16px 24px 16px', boxSizing: 'border-box', fontFamily: T.font
    });
    superposicion.setAttribute('role', 'dialog');
    superposicion.setAttribute('aria-modal', 'true');
    superposicion.setAttribute('aria-label', 'Expediente del móvil ' + r.nombre);
    superposicion.addEventListener('mousedown', function (e) { if (e.target === superposicion) cerrarExpediente(); });

    var tarjeta = crear('div', {
      width: '100%', maxWidth: '1024px', margin: '16px auto 0 auto', color: D.text,
      background: D.panel, border: '1px solid ' + D.border, borderRadius: '8px', boxShadow: '0 25px 50px rgba(0,0,0,0.5)'
    });

    // Cabecera
    // Cabecera fija (sticky): los botones siguen a la vista aunque se desplace el contenido.
    var cab = crear('div', {
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '10px',
      position: 'sticky', top: '0', zIndex: '3', borderRadius: '8px 8px 0 0',
      background: D.panelAlt, borderBottom: '1px solid ' + D.border, padding: '14px 20px'
    });
    var titulos = crear('div');
    titulos.appendChild(crear('h2', { margin: '0', fontSize: '1.25rem', fontWeight: '700', color: '#FFFFFF', letterSpacing: '0.04em', textTransform: 'uppercase' }, 'Expediente del móvil'));
    titulos.appendChild(crear('p', { margin: '4px 0 0 0', fontSize: '0.74rem', color: D.muted }, 'Datos al ' + fmtFechaCompleta(m.ahora) + ' · ' + r.ciudad));
    cab.appendChild(titulos);

    var derecha = crear('div', { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px' });
    var botones = crear('div', { display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' });
    var botonCopiar = botonExpediente('Copiar imagen', 'copiar', 'verde');
    var botonDescargar = botonExpediente('Descargar imagen', 'descargar', 'gris');
    var botonCerrar = botonExpediente('Cerrar', 'cerrar', 'borde');
    var aviso = crear('div', { fontSize: '0.74rem', color: D.verde, maxWidth: '360px', textAlign: 'right', lineHeight: '1.35' });
    // Mientras se dibuja la imagen los dos botones quedan bloqueados para no lanzarla dos veces.
    function conImagen(accion) {
      return function () {
        botonCopiar.disabled = botonDescargar.disabled = true;
        botonCopiar.style.opacity = botonDescargar.style.opacity = '0.6';
        accion(m, function (t) { aviso.textContent = t; }).then(function () {
          botonCopiar.disabled = botonDescargar.disabled = false;
          botonCopiar.style.opacity = botonDescargar.style.opacity = '1';
        });
      };
    }
    botonCopiar.addEventListener('click', conImagen(copiarImagenExpediente));
    botonDescargar.addEventListener('click', conImagen(descargarImagenExpediente));
    botonCerrar.addEventListener('click', cerrarExpediente);
    botones.appendChild(botonCopiar);
    botones.appendChild(botonDescargar);
    botones.appendChild(botonCerrar);
    derecha.appendChild(botones);
    derecha.appendChild(aviso);
    cab.appendChild(derecha);
    tarjeta.appendChild(cab);

    // Cuerpo
    var cuerpo = crear('div', { padding: '18px 20px 20px 20px' });
    cuerpo.appendChild(crear('h3', { margin: '0 0 10px 0', fontSize: '0.72rem', fontWeight: '700', letterSpacing: '0.14em', textTransform: 'uppercase', color: D.muted },
      'Seguimiento de regeneración DPF · ' + r.ciudad));

    var chip = CHIP_OSCURO[m.chipNivel];
    var banda = crear('div', {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginBottom: '16px',
      background: D.panelSoft, border: '1px solid rgba(75,85,99,0.5)', borderRadius: '6px', padding: '12px 16px'
    });
    banda.appendChild(crear('div', { fontSize: '1.5rem', fontWeight: '700', color: '#FFFFFF', letterSpacing: '0.02em' },
      'MÓVIL ' + m.codigo + (m.placa ? ' · ' + m.placa : '')));
    var estado = crear('div', { display: 'flex', alignItems: 'center', gap: '12px', fontSize: '0.84rem' });
    var pildora = crear('span', {
      display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 8px', borderRadius: '4px', fontSize: '0.72rem', fontWeight: '700',
      background: chip.fondo, color: chip.texto, border: '1px solid ' + chip.borde
    });
    pildora.appendChild(crear('span', { width: '6px', height: '6px', borderRadius: '50%', background: chip.texto, display: 'inline-block' }));
    pildora.appendChild(document.createTextNode(m.chipTexto));
    estado.appendChild(pildora);
    estado.appendChild(crear('span', { color: D.muted, fontWeight: '600' }, r.marca));
    banda.appendChild(estado);
    cuerpo.appendChild(banda);

    cuerpo.appendChild(crear('h4', { margin: '0 0 10px 0', fontSize: '1.15rem', fontWeight: '700', color: '#FFFFFF' }, m.titulo));

    var accion = crear('div', {
      marginBottom: '14px', padding: '9px 14px', fontSize: '0.84rem', color: '#CBD5E1', lineHeight: '1.45',
      background: D.panelSoft, borderLeft: '4px solid ' + chip.texto, borderRadius: '4px'
    });
    accion.appendChild(crear('b', { color: '#FFFFFF' }, 'Qué hacer: '));
    accion.appendChild(document.createTextNode(m.accion));
    if (m.nota) accion.appendChild(crear('div', { marginTop: '4px', color: D.muted }, m.nota));
    cuerpo.appendChild(accion);

    var metricas = crear('div', { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px', marginBottom: '14px' });
    m.tarjetas.forEach(function (c) {
      var caja = crear('div', { background: D.bg, border: '1px solid ' + D.border, borderRadius: '6px', padding: '12px' });
      caja.appendChild(crear('div', { fontSize: '0.62rem', color: D.muted, textTransform: 'uppercase', fontWeight: '600', letterSpacing: '0.08em', marginBottom: '4px' }, c.titulo));
      caja.appendChild(crear('div', { fontSize: '1.25rem', color: '#FFFFFF', fontWeight: '700' }, c.valor));
      if (c.sub) caja.appendChild(crear('div', { fontSize: '0.7rem', color: D.faint, marginTop: '2px' }, c.sub));
      metricas.appendChild(caja);
    });
    cuerpo.appendChild(metricas);

    // Gráfica
    var contGrafica = crear('div', { border: '1px solid ' + D.border, borderRadius: '6px', background: D.bg, overflow: 'hidden' });
    var cabGrafica = crear('div', {
      display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', padding: '12px', borderBottom: '1px solid ' + D.border
    });
    cabGrafica.appendChild(crear('h5', { margin: '0', fontSize: '0.84rem', fontWeight: '600', color: '#CBD5E1' }, TITULO_GRAFICA));
    cabGrafica.appendChild(crear('span', { fontSize: '0.72rem', color: D.faint }, 'Últimas 48 h · hora Bogotá'));
    contGrafica.appendChild(cabGrafica);
    var areaGrafica = crear('div', { padding: '8px 10px 0 10px' });
    if (m.grafica) {
      areaGrafica.innerHTML = svgHollin(m.grafica);
      contGrafica.appendChild(areaGrafica);
      activarHoverGrafica(areaGrafica, m.grafica);
      var leyenda = crear('div', { padding: '6px 12px 10px 12px', fontSize: '0.7rem', color: D.muted });
      leyenda.innerHTML = leyendaGraficaHtml(m.grafica.regen.length > 0);
      contGrafica.appendChild(leyenda);
    } else {
      areaGrafica.appendChild(crear('div', { padding: '34px 14px', textAlign: 'center', color: D.faint, fontStyle: 'italic', fontSize: '0.84rem' },
        'Este vehículo no reportó hollín en las últimas 48 h: no hay gráfica para mostrar.'));
      contGrafica.appendChild(areaGrafica);
    }
    cuerpo.appendChild(contGrafica);
    cuerpo.appendChild(crear('div', { marginTop: '8px', fontSize: '0.7rem', color: D.faint, fontStyle: 'italic' },
      'Línea discontinua: intervalo sin lecturas (más de ' + HUECO_SIN_LECTURAS_MIN + ' min). La banda ALTA marca donde suele encenderse la lámpara (cerca de ' + HOLLIN_LAMPARA_APROX + ' %).'));

    tarjeta.appendChild(cuerpo);
    superposicion.appendChild(tarjeta);
    document.body.appendChild(superposicion);

    var alTeclado = function (e) { if (e.key === 'Escape') cerrarExpediente(); };
    document.addEventListener('keydown', alTeclado);
    expedienteAbierto = { superposicion: superposicion, foco: document.activeElement, desbordeBody: document.body.style.overflow, alTeclado: alTeclado };
    document.body.style.overflow = 'hidden';
    botonCerrar.focus();
  }

  // Nombre del vehículo como botón dentro de la fila: se alcanza con el teclado y abre el expediente
  // (el clic sube hasta la fila, que es quien lo abre).
  function celdaVehiculo(r) {
    var b = crear('button', {
      background: 'transparent', border: 'none', padding: '0', cursor: 'pointer', fontFamily: T.font, fontSize: '0.8rem',
      fontWeight: '700', color: '#FFFFFF', textDecoration: 'underline', textDecorationStyle: 'dotted', whiteSpace: 'nowrap'
    }, r.nombre);
    b.type = 'button';
    b.title = 'Ver el expediente de ' + r.nombre;
    return b;
  }

  // MyGeotab deja el resto de la página en blanco: cuando el contenido es corto, el fondo oscuro
  // tiene que llegar hasta el borde inferior de la ventana. Se mide desde donde empieza el add-in
  // (debajo de la barra superior de MyGeotab) y se repite al redimensionar.
  function ajustarAlturaRaiz() {
    var raiz = document.getElementById('seguimientoRegeneracionRoot');
    if (!raiz) return;
    var arriba = Math.max(0, raiz.getBoundingClientRect().top);
    raiz.style.minHeight = Math.max(300, window.innerHeight - arriba) + 'px';
  }

  function cargarYRenderizar(silencioso) {
    if (cargaEnCurso) return;
    cargaEnCurso = true;
    elementos.botonActualizar.disabled = true; elementos.botonActualizar.style.opacity = '0.55';
    if (!silencioso || !datosCache) elementos.lineaProgreso = cargandoOscuro(contenedorResultados, 'Consultando señales de Geotab…');
    calcular()
      .then(function (datos) {
        datosCache = datos;
        elementos.textoActualizacion.textContent = 'Actualización: ' + fmtFechaLarga(datos.ahora);
        actualizarFiltros();
        renderizar();
      })
      .catch(function (err) {
        console.error('Seguimiento de Regeneraciones:', err);
        // Un refresco automático fallido no debe borrar lo que ya se está viendo.
        if (!datosCache) errorOscuro(contenedorResultados, describirError(err));
      })
      .then(function () {
        cargaEnCurso = false;
        elementos.botonActualizar.disabled = false; elementos.botonActualizar.style.opacity = '1';
        ajustarAlturaRaiz();
      });
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi; state = freshState;
      var raiz = document.getElementById('seguimientoRegeneracionRoot');
      aplicarEstilo(raiz, { fontFamily: T.font, background: D.bg, color: D.text, colorScheme: 'dark', boxSizing: 'border-box' });
      construirEncabezadoPanel(raiz);
      var cuerpo = crear('div', { padding: '18px 22px 8px 22px' });
      raiz.appendChild(cuerpo);
      construirFiltros(cuerpo);
      contenedorResultados = crear('div');
      cuerpo.appendChild(contenedorResultados);
      ajustarAlturaRaiz();
      initializedCallback();
    },

    focus: function (freshApi, freshState) {
      api = freshApi; state = freshState;
      if (idIntervalo) clearInterval(idIntervalo);
      idIntervalo = setInterval(function () { cargarYRenderizar(true); }, INTERVALO_AUTO_REFRESCO_MS);
      window.addEventListener('resize', ajustarAlturaRaiz);
      ajustarAlturaRaiz();
      cargarYRenderizar(false);
    },

    blur: function () {
      cerrarExpediente();
      window.removeEventListener('resize', ajustarAlturaRaiz);
      if (idIntervalo) { clearInterval(idIntervalo); idIntervalo = null; }
    }
  };

};
