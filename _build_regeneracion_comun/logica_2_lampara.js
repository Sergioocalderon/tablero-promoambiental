
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
