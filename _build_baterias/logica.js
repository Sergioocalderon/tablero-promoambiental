
  // ============================================================================
  // LÓGICA PURA de validación de baterías (sin DOM ni API: se prueba en Node
  // contra la salida de Python, ver cambios/ del add-in).
  //
  // Dos fuentes, y la pantalla siempre dice cuál se usó:
  //   1. ESR de Geotab ("Clasificación del sistema eléctrico", 0-100): referencia.
  //   2. Señales de arranque ("Voltaje de arranque", ~1 lectura/s durante ~10 s):
  //      voltaje mínimo, caída, reposo y recuperación de cada arranque.
  //
  // Todo voltaje se normaliza a escala 12 V para comparar 12 V con 24 V
  // (24 V se divide a la mitad); la pantalla muestra voltios reales.
  //
  // Umbrales medidos con 30 días de la flota (09-nov-2026, 85 vehículos, 59 con
  // ESR, 12.465 arranques). Límites conocidos, para no sobreprometer:
  //   - Solo 3 vehículos tuvieron días con ESR < 30: el cálculo por señales de
  //     arranque se calibró casi sin ejemplos de baterías malas.
  //   - Los 21 vehículos de 24 V NO tienen ESR de Geotab: no hay umbral absoluto
  //     para ellos, solo comparación contra sus pares y contra su propia semana.
  // ============================================================================

  var MS_HORA = 3600000;
  var MS_DIA = 86400000;

  // --- ESR (bandas de Geotab y criterio del código recibido: alerta < 15) ---
  var ESR_ALERTA = 15;          // < 15 = Alerta (Malo < 5, Precaución 5-14)
  var ESR_REVISAR = 30;         // 15-29 = Revisar (en la flota, los días con ESR < 30 fueron de baterías con fallas reales)
  var ESR_CAIDA_PUNTOS = 15;    // cae >= 15 pts bajo su mediana del periodo
  var HORAS_ESR_VIGENTE = 72;   // un ESR más viejo no se usa como "actual"

  // --- Detección de arranques en la serie "Voltaje de arranque" ---
  var GAP_ARRANQUE_S = 30;      // más de 30 s entre lecturas = otro arranque
  var MIN_PUNTOS_ARRANQUE = 3;
  var CAIDA_MIN_ARRANQUE_V = 0.5;   // menos caída que esto no es un arranque
  var VOLTAJE_SISTEMA_24V = 18;     // reposo > 18 V = sistema de 24 V

  // --- Evaluación por señales (escala 12 V) ---
  var MIN_ARRANQUES_VENTANA = 5;    // con menos arranques en 7 días no se evalúa
  var MINIMO_REVISAR_12V = 6.5;     // mediana del mínimo < 6,5 V (en los casos con ESR < 30 fue 6,4 V)
  var MINIMO_VIGILAR_12V = 7.3;     // < 7,3 V: por debajo de todos los vehículos con ESR >= 50 (rango 7,3-9,0)
  var TENDENCIA_VIGILAR_V = 0.3;    // el mínimo cae >= 0,3 V vs la semana anterior (el peor cambio semanal visto fue 0,2 V)
  var TENDENCIA_REVISAR_V = 0.5;
  var RECUPERA_UMBRAL_V = -0.5;     // carga - reposo < -0,5 V = no recupera
  var RECUPERA_FRACCION = 0.5;      // en >= 50 % de los arranques
  var RECUPERA_MIN_ARRANQUES = 10;

  var NIVEL_TEXTO = { 3: 'Alerta', 2: 'Revisar', 1: 'Vigilar', 0: 'Normal' };

  function mediana(valores) {
    var v = valores.filter(function (x) { return x !== null && x !== undefined && !isNaN(x); }).sort(function (a, b) { return a - b; });
    if (!v.length) return null;
    var m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }

  function moda(valores) {
    var c = {}, mejor = null, nMejor = 0;
    valores.forEach(function (x) { c[x] = (c[x] || 0) + 1; if (c[x] > nMejor || (c[x] === nMejor && x < mejor)) { mejor = x; nMejor = c[x]; } });
    return mejor;
  }

  // Día calendario en hora de Bogotá (UTC-5, sin horario de verano): 'YYYY-MM-DD'
  function diaBogota(ms) { return new Date(ms - 5 * MS_HORA).toISOString().slice(0, 10); }

  function bandaEsr(esr) {
    if (esr === null || esr === undefined || isNaN(esr)) return 'Sin dato';
    if (esr >= 50) return 'Bueno';
    if (esr >= 15) return 'Regular';
    if (esr >= 5) return 'Precaución';
    return 'Malo';
  }

  // puntos: [[ms, voltios], ...] de UN vehículo, ordenados por tiempo.
  // Devuelve un arranque por cada curva reposo -> caída -> recuperación.
  function segmentarArranques(puntos) {
    var arranques = [], inicio = 0;
    function cerrar(desde, hasta) {          // [desde, hasta)
      if (hasta - desde < MIN_PUNTOS_ARRANQUE) return;
      var rep = puntos[desde][1], imin = desde, vmin = rep, i;
      for (i = desde; i < hasta; i++) if (puntos[i][1] < vmin) { vmin = puntos[i][1]; imin = i; }
      if (rep - vmin < CAIDA_MIN_ARRANQUE_V) return;
      var carga = -Infinity;
      for (i = imin; i < hasta; i++) if (puntos[i][1] > carga) carga = puntos[i][1];
      var nominal = rep > VOLTAJE_SISTEMA_24V ? 24 : 12, k = 12 / nominal;
      arranques.push({
        t: puntos[desde][0], nominal: nominal, reposo: rep * k, minimo: vmin * k, caida: (rep - vmin) * k,
        carga: carga * k, duracionS: (puntos[hasta - 1][0] - puntos[desde][0]) / 1000
      });
    }
    for (var i = 1; i < puntos.length; i++) {
      if ((puntos[i][0] - puntos[i - 1][0]) / 1000 > GAP_ARRANQUE_S) { cerrar(inicio, i); inicio = i; }
    }
    if (puntos.length) cerrar(inicio, puntos.length);
    return arranques;
  }

  // Resumen de los arranques con inicio en (desdeMs, hastaMs]
  function resumirVentana(arranques, desdeMs, hastaMs) {
    var w = arranques.filter(function (a) { return a.t > desdeMs && a.t <= hastaMs; });
    if (!w.length) return { n: 0 };
    var rec = w.map(function (a) { return a.carga - a.reposo; });
    return {
      n: w.length,
      nominal: moda(w.map(function (a) { return a.nominal; })),
      minimo: mediana(w.map(function (a) { return a.minimo; })),
      caida: mediana(w.map(function (a) { return a.caida; })),
      reposo: mediana(w.map(function (a) { return a.reposo; })),
      rec: mediana(rec),
      fracNoRec: rec.filter(function (r) { return r < RECUPERA_UMBRAL_V; }).length / w.length
    };
  }

  // [[ms, esr], ...] ordenados -> [{dia, valor}] con el ÚLTIMO valor de cada día de Bogotá
  function esrDiario(puntos) {
    var porDia = {}, orden = [];
    puntos.forEach(function (p) {
      var d = diaBogota(p[0]);
      if (!(d in porDia)) orden.push(d);
      porDia[d] = p[1];
    });
    return orden.sort().map(function (d) { return { dia: d, valor: porDia[d] }; });
  }

  // Serie diaria para el gráfico: mediana del mínimo (voltios reales) por día
  function minimoDiario(arranques) {
    var porDia = {};
    arranques.forEach(function (a) { (porDia[diaBogota(a.t)] = porDia[diaBogota(a.t)] || []).push(a.minimo * a.nominal / 12); });
    return Object.keys(porDia).sort().map(function (d) { return { dia: d, valor: mediana(porDia[d]), n: porDia[d].length }; });
  }

  // --- Evaluación de un vehículo ---------------------------------------------------
  // entrada: { esrPuntos: [[ms, esr]], arranques: [...], ahoraMs }
  // salida: nivel (0-3), estado, fuente, motivos[] y todos los indicadores que muestra la tabla.
  function evaluarVehiculo(entrada) {
    var ahora = entrada.ahoraMs;
    var diario = esrDiario(entrada.esrPuntos || []);
    var ultimoEsrMs = (entrada.esrPuntos && entrada.esrPuntos.length) ? entrada.esrPuntos[entrada.esrPuntos.length - 1][0] : null;
    var esrEdadH = ultimoEsrMs === null ? null : (ahora - ultimoEsrMs) / MS_HORA;
    var esrVigente = esrEdadH !== null && esrEdadH <= HORAS_ESR_VIGENTE;

    var s7 = resumirVentana(entrada.arranques, ahora - 7 * MS_DIA, ahora);
    var sPrev = resumirVentana(entrada.arranques, ahora - 14 * MS_DIA, ahora - 7 * MS_DIA);
    var ultimoArranqueMs = entrada.arranques.length ? entrada.arranques[entrada.arranques.length - 1].t : null;
    var nominal = s7.n ? s7.nominal : (entrada.arranques.length ? entrada.arranques[entrada.arranques.length - 1].nominal : null);
    var k = nominal ? nominal / 12 : 1;                       // escala 12 V -> voltios reales
    var suficientes = s7.n >= MIN_ARRANQUES_VENTANA;

    var out = {
      nivel: 0, motivos: [], nominal: nominal,
      fuente: esrVigente ? 'ESR Geotab' : 'Señales de arranque',
      esr: diario.length ? diario[diario.length - 1].valor : null, esrBanda: null, esrBase: null, esrEdadH: esrEdadH, esrVigente: esrVigente,
      arranques7d: s7.n, minimoV: s7.n ? s7.minimo * k : null, caidaV: s7.n ? s7.caida * k : null, reposoV: s7.n ? s7.reposo * k : null,
      recuperacionV: s7.n ? s7.rec * k : null, noRecuperaPct: s7.n ? s7.fracNoRec : null,
      cambioMinimoV: (suficientes && sPrev.n >= MIN_ARRANQUES_VENTANA) ? (s7.minimo - sPrev.minimo) * k : null,
      ultimoArranqueMs: ultimoArranqueMs, ultimoDatoMs: Math.max(ultimoEsrMs || 0, ultimoArranqueMs || 0) || null,
      resumen7d: s7, resumenPrev: sPrev
    };
    function subir(nivel, motivo) { if (nivel > out.nivel) out.nivel = nivel; if (motivo) out.motivos.push(motivo); }
    function v1(x) { return (Math.round(x * 10) / 10).toFixed(1).replace('.', ','); }

    // 1) ESR de Geotab (referencia)
    if (diario.length) {
      out.esrBanda = bandaEsr(out.esr);
      out.esrBase = diario.length > 1 ? mediana(diario.slice(0, -1).map(function (d) { return d.valor; })) : out.esr;
    }
    if (esrVigente) {
      if (out.esr < ESR_ALERTA) subir(3, 'ESR ' + Math.round(out.esr) + ' (' + out.esrBanda + '): batería en mal estado');
      else if (out.esr < ESR_REVISAR) subir(2, 'ESR ' + Math.round(out.esr) + ': bajo ' + ESR_REVISAR + ', revisar');
      if (out.esrBase - out.esr >= ESR_CAIDA_PUNTOS) subir(2, 'El ESR cayó ' + Math.round(out.esrBase - out.esr) + ' pts bajo su mediana del periodo (' + Math.round(out.esrBase) + ')');
    } else if (esrEdadH !== null) {
      out.motivos.push('ESR de Geotab desactualizado (hace ' + Math.floor(esrEdadH / 24) + ' d): se usan las señales de arranque');
    }

    // 2) Señales de arranque
    if (!suficientes) {
      if (!esrVigente) { out.sinDatos = true; out.motivos.push(s7.n ? 'Solo ' + s7.n + ' arranque(s) en 7 días: insuficiente para evaluar' : 'Sin arranques registrados en 7 días'); }
    } else {
      if (!esrVigente && nominal === 12) {
        if (s7.minimo < MINIMO_REVISAR_12V) subir(2, 'Voltaje mínimo al arrancar muy bajo (' + v1(out.minimoV) + ' V): estimación sin ESR');
        else if (s7.minimo < MINIMO_VIGILAR_12V) subir(1, 'Voltaje mínimo al arrancar bajo (' + v1(out.minimoV) + ' V): estimación sin ESR');
      }
      if (out.cambioMinimoV !== null) {
        var caidaSemana = -(s7.minimo - sPrev.minimo);
        if (caidaSemana >= TENDENCIA_REVISAR_V) subir(2, 'El voltaje mínimo cayó ' + v1(caidaSemana * k) + ' V vs la semana anterior');
        else if (caidaSemana >= TENDENCIA_VIGILAR_V) subir(1, 'El voltaje mínimo cayó ' + v1(caidaSemana * k) + ' V vs la semana anterior');
      }
      if (s7.n >= RECUPERA_MIN_ARRANQUES && s7.fracNoRec >= RECUPERA_FRACCION) {
        subir(2, 'No recupera voltaje tras arrancar en ' + Math.round(s7.fracNoRec * 100) + ' % de los arranques: revisar alternador o cableado');
      }
    }

    // Un "Normal" con datos viejos afirmaría un estado que nadie midió hoy (caso 1226-FXW563:
    // la tarjeta decía "activa" por un único registro de hace 11 días). Si el último dato es
    // más viejo que HORAS_ESR_VIGENTE y no hay nada que señalar, se dice "Sin datos".
    var edadDatoH = out.ultimoDatoMs === null ? null : (ahora - out.ultimoDatoMs) / MS_HORA;
    if (out.nivel === 0 && !out.sinDatos && edadDatoH !== null && edadDatoH > HORAS_ESR_VIGENTE) {
      out.sinDatos = true;
      out.motivos.push('Sin datos nuevos desde hace ' + Math.floor(edadDatoH / 24) + ' d (¿vehículo sin comunicar o parado?)');
    }
    out.sinReferencia = !esrVigente && nominal === 24;       // 24 V: sin umbral absoluto
    out.estado = out.sinDatos ? 'Sin datos' : NIVEL_TEXTO[out.nivel];
    return out;
  }
