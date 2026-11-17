/* ARCHIVO GENERADO por herramientas/construir_addin_baterias.py -- NO EDITAR A MANO.
   Editar _build_baterias/*.js (o _build_regeneracion_comun/ui.js) y volver a ejecutar el script. */

geotab.addin.validacionBaterias = function () {
  'use strict';

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

  // ============================================================================
  // CAPA DE DATOS: API de Geotab, alcance de vehículos (grupo *Promoambiental),
  // ciudad/marca, y carga de ESR y voltaje de arranque.
  //
  // Volumen medido el 2026-11-09 (85 vehículos): ESR ~1.600 filas en 30 días;
  // voltaje de arranque ~4.900 filas/día (70.000 en 14 días). Tramos de 2 días
  // quedan en ~10.000 filas, muy bajo el tope de página de 50.000; si algún
  // tramo lo alcanzara igual, se parte a la mitad en vez de truncar en silencio.
  // ============================================================================

  var api = null;
  var state = null;

  var ID_DIAG_ESR = 'DiagnosticElectricalSystemRatingId';        // "Clasificación del sistema eléctrico"
  var ID_DIAG_ARRANQUE = 'DiagnosticCrankingVoltageId';          // "Voltaje de arranque"
  var NOMBRE_GRUPO_RAIZ = '*Promoambiental';   // la base de Geotab se comparte con otras cuentas: se acota por este grupo
  var DIAS_ESR = 30;
  var DIAS_ARRANQUES = 14;                     // 7 días actuales + 7 previos para la tendencia
  var TRAMO_DIAS_ARRANQUES = 2;
  var LIMITE_PAGINA_STATUSDATA = 50000;
  var TIMEOUT_LLAMADA_MS = 90000;

  var NOMBRE_CIUDAD = {
    'PROMO AMBIENTAL DISTRITO BOGOTA': 'Bogotá (Distrito)', 'PACARIBE': 'Cartagena (Pacaribe)', 'PROMO CALI': 'Cali',
    'PROMO VALLE': 'Valle', 'SER AMBIENTAL': 'Ser Ambiental', 'ESTACIÓN DE TRANSFERENCIA ZIPA': 'Zipaquirá (Estación de transferencia)'
  };
  var MARCAS = ['international', 'kenworth', 'foton', 'chevrolet', 'mercedes', 'volks', 'freightliner', 'hino'];
  var GRUPOS_RAIZ_NO_CIUDAD = ['tipologia'];

  // --- Envoltorios sobre la API de Geotab (callback -> Promise, con tope de espera) ---
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

  // --- Alcance: vehículos activos dentro del grupo raíz ---------------------------
  function obtenerAlcance() {
    return Promise.all([apiCall('Get', { typeName: 'Device' }), apiCall('Get', { typeName: 'Group' })]).then(function (r) {
      var devices = r[0] || [], grupos = r[1] || [];
      var porId = {}, padre = {};
      grupos.forEach(function (g) { if (g && g.id) porId[g.id] = g; });
      grupos.forEach(function (g) { (g.children || []).forEach(function (h) { padre[idDe(h)] = g.id; }); });

      var objetivo = NOMBRE_GRUPO_RAIZ.trim().toLowerCase(), raiz = null;
      grupos.forEach(function (g) { if (!raiz && g && typeof g.name === 'string' && g.name.trim().toLowerCase() === objetivo) raiz = g; });
      if (!raiz) throw new Error("No se encontró el grupo '" + NOMBRE_GRUPO_RAIZ + "' en Geotab.");
      var raizHijos = {};
      (raiz.children || []).forEach(function (h) { raizHijos[idDe(h)] = true; });

      function dentroDeRaiz(gid) {
        for (var d = 0; gid && d < 30; d++) { if (gid === raiz.id) return true; gid = padre[gid]; }
        return false;
      }

      var ahora = Date.now(), vehiculos = [];
      devices.forEach(function (dev) {
        if (!(dev.groups || []).some(function (g) { return dentroDeRaiz(idDe(g)); })) return;
        var hasta = dev.activeTo ? Date.parse(dev.activeTo) : NaN;
        if (!isNaN(hasta) && hasta < ahora) return;                       // dado de baja
        var ciudad = null, marca = null;
        (dev.groups || []).forEach(function (g) {
          var gid = idDe(g);
          for (var d = 0; gid && d < 30; d++) {
            var nombre = ((porId[gid] && porId[gid].name) || '').trim(), minus = nombre.toLowerCase();
            if (!ciudad && raizHijos[gid] && GRUPOS_RAIZ_NO_CIUDAD.indexOf(minus) === -1) ciudad = nombre;
            if (!marca && MARCAS.some(function (m) { return minus.indexOf(m) === 0; })) marca = tituloCase(nombre);
            gid = padre[gid];
          }
        });
        vehiculos.push({ id: dev.id, nombre: dev.name || dev.id, ciudad: NOMBRE_CIUDAD[ciudad] || ciudad || 'Sin ciudad', marca: marca || 'Sin marca' });
      });
      vehiculos.sort(function (a, b) { return a.nombre < b.nombre ? -1 : a.nombre > b.nombre ? 1 : 0; });
      return vehiculos;
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
  function traerDiagnostico(idDiag, desdeMs, hastaMs, tramoDias, ids, alAvanzar) {
    var tramos = [], cursor = desdeMs;
    while (cursor < hastaMs) {
      var fin = Math.min(cursor + tramoDias * MS_DIA, hastaMs);
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

  // Carga todo lo necesario y devuelve la evaluación de cada vehículo del alcance.
  function cargarEvaluaciones(alProgreso) {
    var ahoraMs = Date.now();
    return obtenerAlcance().then(function (vehiculos) {
      var ids = vehiculos.reduce(function (m, v) { m[v.id] = true; return m; }, {});
      var avance = { esr: [0, 1], arr: [0, 1] };
      function reportar() { if (alProgreso) alProgreso(avance.esr[0] + avance.arr[0], avance.esr[1] + avance.arr[1]); }
      return Promise.all([
        traerDiagnostico(ID_DIAG_ESR, ahoraMs - DIAS_ESR * MS_DIA, ahoraMs, DIAS_ESR, ids, function (h, t) { avance.esr = [h, t]; reportar(); })
          .catch(function (err) { err.message = 'ESR de Geotab: ' + describirError(err); throw err; }),
        traerDiagnostico(ID_DIAG_ARRANQUE, ahoraMs - DIAS_ARRANQUES * MS_DIA, ahoraMs, TRAMO_DIAS_ARRANQUES, ids, function (h, t) { avance.arr = [h, t]; reportar(); })
          .catch(function (err) { err.message = 'Voltaje de arranque: ' + describirError(err); throw err; })
      ]).then(function (res) {
        var esrPorVeh = res[0], arrPorVeh = res[1];
        var filas = vehiculos.map(function (v) {
          var arranques = segmentarArranques(arrPorVeh[v.id] || []);
          var ev = evaluarVehiculo({ esrPuntos: esrPorVeh[v.id] || [], arranques: arranques, ahoraMs: ahoraMs });
          ev.vehiculo = v;
          ev.serieEsr = esrDiario(esrPorVeh[v.id] || []);
          ev.serieMinimo = minimoDiario(arranques);
          return ev;
        });
        return { filas: filas, ahoraMs: ahoraMs };
      });
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
  // PANTALLA: Validación de Baterías
  // ============================================================================

  var REFRESCO_MS = 30 * 60 * 1000;     // el ESR y el mínimo de arranque cambian por días, no por minutos
  var elementos = {};
  var datos = null;                     // { filas, ahoraMs }
  var filtros = { ciudad: '', sistema: '', estado: '', texto: '' };
  var seleccionado = null;              // id del vehículo con detalle abierto
  var graficoActual = null;
  var cargando = false;
  var temporizador = null;

  var COLOR_NORMAL = { fondo: '#EAF4DF', texto: '#3F6B12', borde: '#C5E0A5' };
  var ORDEN_ESTADOS = ['Alerta', 'Revisar', 'Vigilar', 'Normal', 'Sin datos'];

  function fmtV(x) { return (x === null || x === undefined || isNaN(x)) ? '—' : (Math.round(x * 10) / 10).toFixed(1).replace('.', ','); }
  function fmtVcon(x) { return (x === null || x === undefined || isNaN(x)) ? '—' : (x > 0 ? '+' : '') + fmtV(x); }
  function num(x, dec) { return (x === null || x === undefined || isNaN(x)) ? '' : String(Math.round(x * Math.pow(10, dec || 0)) / Math.pow(10, dec || 0)).replace('.', ','); }

  function fmtEdad(ms, ahora) {
    if (!ms) return '—';
    var h = (ahora - ms) / MS_HORA;
    if (h < 1) return 'hace ' + Math.max(1, Math.round(h * 60)) + ' min';
    if (h < 48) return 'hace ' + Math.round(h) + ' h';
    return 'hace ' + Math.floor(h / 24) + ' d';
  }

  function pildoraEstado(ev) {
    if (ev.estado === 'Normal') {
      return crear('span', {
        display: 'inline-block', padding: '2px 10px', borderRadius: T.radius.pill, fontSize: '0.72rem', fontWeight: '700',
        background: COLOR_NORMAL.fondo, color: COLOR_NORMAL.texto, border: '1px solid ' + COLOR_NORMAL.borde, whiteSpace: 'nowrap'
      }, ev.sinReferencia ? 'Normal*' : 'Normal');
    }
    return crearPildora(ev.estado, ev.estado === 'Sin datos' ? 0 : ev.nivel);
  }

  // --- Filtros ---------------------------------------------------------------------
  function filasFiltradas() {
    if (!datos) return [];
    var q = filtros.texto.trim().toLowerCase();
    return datos.filas.filter(function (ev) {
      if (filtros.ciudad && ev.vehiculo.ciudad !== filtros.ciudad) return false;
      if (filtros.sistema && String(ev.nominal) !== filtros.sistema) return false;
      if (filtros.estado && ev.estado !== filtros.estado) return false;
      if (q && ev.vehiculo.nombre.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function ordenarFilas(filas) {
    return filas.slice().sort(function (a, b) {
      var oa = ORDEN_ESTADOS.indexOf(a.estado), ob = ORDEN_ESTADOS.indexOf(b.estado);
      if (oa !== ob) return oa - ob;
      var ea = a.esr === null ? 999 : a.esr, eb = b.esr === null ? 999 : b.esr;
      if (ea !== eb) return ea - eb;
      var ma = a.minimoV === null ? 999 : a.minimoV, mb = b.minimoV === null ? 999 : b.minimoV;
      return ma - mb;
    });
  }

  // --- KPIs ------------------------------------------------------------------------
  function pintarKpis(filas) {
    var cont = vaciar(elementos.kpis);
    function contar(est) { return filas.filter(function (f) { return f.estado === est; }).length; }
    var conEsr = filas.filter(function (f) { return f.esrVigente; }).length;
    var sinRef = filas.filter(function (f) { return f.sinReferencia; }).length;
    var defs = [
      [String(filas.length), 'Vehículos evaluados', 'ESR vigente en ' + conEsr + ' · señales en ' + (filas.length - conEsr), undefined, ''],
      [String(contar('Alerta')), 'Alerta', 'ESR < ' + ESR_ALERTA + ' o falla grave', 3, 'Alerta'],
      [String(contar('Revisar')), 'Revisar', 'ESR bajo, caída o sin recuperar', 2, 'Revisar'],
      [String(contar('Vigilar')), 'Vigilar', 'Mínimo de arranque bajo', 1, 'Vigilar'],
      [String(contar('Sin datos')), 'Sin datos', 'Sin ESR ni arranques suficientes', 0, 'Sin datos'],
      [String(sinRef), 'Sin ESR (24 V)', 'Sin umbral absoluto: solo comparación', 0, '']
    ];
    defs.forEach(function (d) {
      var t = crearTarjetaKpi(d[0], d[1], d[2], d[3]);
      if (d[4]) {
        t.style.cursor = 'pointer';
        if (filtros.estado === d[4]) t.style.outline = '2px solid ' + T.color.primary;
        t.title = 'Clic para filtrar la tabla por "' + d[4] + '" (otro clic lo quita)';
        t.addEventListener('click', function () {
          filtros.estado = filtros.estado === d[4] ? '' : d[4];
          elementos.estadoSel.select.value = filtros.estado;
          repintar();
        });
      }
      cont.appendChild(t);
    });
  }

  // --- Tabla -----------------------------------------------------------------------
  function pintarTabla(filas) {
    var cont = vaciar(elementos.tabla);
    if (!filas.length) {
      cont.appendChild(crear('div', { padding: '28px', textAlign: 'center', color: T.color.muted, fontSize: '0.85rem' }, 'Ningún vehículo coincide con los filtros.'));
      return;
    }
    var ahora = datos.ahoraMs;
    var columnas = [
      { titulo: 'Vehículo', valor: function (f) {
          var d = crear('div'); d.appendChild(crear('div', { fontWeight: '700' }, f.vehiculo.nombre));
          d.appendChild(crear('div', { fontSize: '0.7rem', color: T.color.muted }, f.vehiculo.marca)); return d;
        }, orden: function (f) { return f.vehiculo.nombre; } },
      { titulo: 'Ciudad', valor: function (f) { return f.vehiculo.ciudad; }, orden: function (f) { return f.vehiculo.ciudad; } },
      { titulo: 'Sistema', valor: function (f) { return f.nominal ? f.nominal + ' V' : '—'; }, orden: function (f) { return f.nominal || 0; }, alinear: 'center' },
      { titulo: 'Estado', valor: pildoraEstado, orden: function (f) { return ORDEN_ESTADOS.indexOf(f.estado); } },
      { titulo: 'Motivo', valor: function (f) {
          return crear('div', { fontSize: '0.75rem', color: T.color.body, minWidth: '280px' }, f.motivos.join(' · ') || (f.sinReferencia ? 'Sin novedad (sin ESR de referencia)' : 'Sin novedad'));
        } },
      { titulo: 'Fuente', valor: function (f) { return f.esrVigente ? 'ESR Geotab' : (f.sinReferencia ? 'Señales · sin ESR' : 'Señales (estimado)'); }, orden: function (f) { return f.esrVigente ? 0 : 1; } },
      { titulo: 'ESR', alinear: 'right', valor: function (f) {
          if (f.esr === null) return '—';
          var d = crear('div'); d.appendChild(crear('div', { fontWeight: '700' }, String(Math.round(f.esr))));
          d.appendChild(crear('div', { fontSize: '0.68rem', color: f.esrVigente ? T.color.muted : COLOR_NIVEL[2].texto }, f.esrVigente ? f.esrBanda : f.esrBanda + ' · ' + fmtEdad(ahora - f.esrEdadH * MS_HORA, ahora)));
          return d;
        }, orden: function (f) { return f.esr; } },
      { titulo: 'Mín. al arrancar (V)', alinear: 'right', valor: function (f) { return fmtV(f.minimoV); }, orden: function (f) { return f.minimoV; } },
      { titulo: 'Cambio vs sem. previa (V)', alinear: 'right', valor: function (f) {
          var s = crear('span', null, fmtVcon(f.cambioMinimoV));
          if (f.cambioMinimoV !== null && f.cambioMinimoV <= -TENDENCIA_VIGILAR_V * (f.nominal / 12)) { s.style.color = COLOR_NIVEL[2].texto; s.style.fontWeight = '700'; }
          return s;
        }, orden: function (f) { return f.cambioMinimoV; } },
      { titulo: 'Recuperación (V)', alinear: 'right', valor: function (f) {
          var s = crear('span', null, fmtVcon(f.recuperacionV));
          if (f.noRecuperaPct !== null && f.arranques7d >= RECUPERA_MIN_ARRANQUES && f.noRecuperaPct >= RECUPERA_FRACCION) { s.style.color = COLOR_NIVEL[2].texto; s.style.fontWeight = '700'; }
          return s;
        }, orden: function (f) { return f.recuperacionV; } },
      { titulo: 'Arranques 7 d', alinear: 'right', valor: function (f) { return f.arranques7d; }, orden: function (f) { return f.arranques7d; } },
      { titulo: 'Último dato', valor: function (f) { return fmtEdad(f.ultimoDatoMs, ahora); }, orden: function (f) { return f.ultimoDatoMs; } }
    ];
    cont.appendChild(crearTabla(columnas, ordenarFilas(filas), function (f) { seleccionado = seleccionado === f.vehiculo.id ? null : f.vehiculo.id; pintarDetalle(); }));
  }

  // --- Detalle de un vehículo (gráfico ESR + mínimo de arranque) -------------------------
  function destruirGrafico() { if (graficoActual) { try { graficoActual.destroy(); } catch (e) { /* ya destruido */ } graficoActual = null; } }

  function pintarDetalle() {
    destruirGrafico();
    var cont = vaciar(elementos.detalle);
    var ev = null;
    if (seleccionado && datos) datos.filas.forEach(function (f) { if (f.vehiculo.id === seleccionado) ev = f; });
    if (!ev) { cont.style.display = 'none'; return; }
    cont.style.display = 'block';
    var panel = crearPanel({ padding: '16px 18px', margin: '0 22px 16px 22px' });
    var cab = crear('div', { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '8px' });
    cab.appendChild(crear('div', { fontWeight: '800', fontSize: '1rem', color: T.color.ink }, ev.vehiculo.nombre));
    cab.appendChild(pildoraEstado(ev));
    cab.appendChild(crear('div', { fontSize: '0.78rem', color: T.color.muted }, ev.vehiculo.ciudad + ' · ' + ev.vehiculo.marca + ' · ' + (ev.nominal ? ev.nominal + ' V' : 'sistema desconocido')));
    var cerrar = crearBoton('Cerrar', false); cerrar.style.marginLeft = 'auto'; cerrar.style.padding = '5px 12px';
    cerrar.addEventListener('click', function () { seleccionado = null; pintarDetalle(); });
    cab.appendChild(cerrar);
    panel.appendChild(cab);
    panel.appendChild(crear('div', { fontSize: '0.8rem', color: T.color.body, marginBottom: '10px' },
      ev.motivos.length ? ev.motivos.join(' · ') : 'Sin novedad.' + (ev.sinReferencia ? ' (24 V: sin ESR de referencia, la ausencia de alertas no es una garantía de buen estado.)' : '')));

    var dias = {};
    ev.serieEsr.forEach(function (p) { dias[p.dia] = true; });
    ev.serieMinimo.forEach(function (p) { dias[p.dia] = true; });
    var etiquetas = Object.keys(dias).sort();
    if (!etiquetas.length) {
      panel.appendChild(crear('div', { color: T.color.muted, fontSize: '0.8rem' }, 'Sin datos para graficar.'));
    } else if (typeof Chart === 'undefined') {
      panel.appendChild(crear('div', { color: T.color.muted, fontSize: '0.8rem' }, 'No se pudo cargar Chart.js (¿sin acceso a internet?). Los datos siguen en la tabla y en el CSV.'));
    } else {
      var caja = crear('div', { position: 'relative', height: '260px' });
      var lienzo = document.createElement('canvas'); caja.appendChild(lienzo); panel.appendChild(caja);
      var mapaEsr = {}, mapaMin = {};
      ev.serieEsr.forEach(function (p) { mapaEsr[p.dia] = p.valor; });
      ev.serieMinimo.forEach(function (p) { mapaMin[p.dia] = Math.round(p.valor * 100) / 100; });
      graficoActual = new Chart(lienzo.getContext('2d'), {
        type: 'line',
        data: {
          labels: etiquetas.map(function (d) { return d.slice(8, 10) + '-' + MESES[parseInt(d.slice(5, 7), 10) - 1]; }),
          datasets: [
            { label: 'ESR Geotab (0-100)', data: etiquetas.map(function (d) { return d in mapaEsr ? mapaEsr[d] : null; }), borderColor: T.color.primaryDark, backgroundColor: T.color.primaryDark, yAxisID: 'y', spanGaps: true, tension: 0.2, pointRadius: 2 },
            { label: 'Voltaje mínimo al arrancar (V, mediana diaria)', data: etiquetas.map(function (d) { return d in mapaMin ? mapaMin[d] : null; }), borderColor: '#0891B2', backgroundColor: '#0891B2', yAxisID: 'y2', spanGaps: true, tension: 0.2, pointRadius: 2 }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
          scales: {
            y: { position: 'left', min: 0, max: 100, title: { display: true, text: 'ESR' } },
            y2: { position: 'right', title: { display: true, text: 'Voltios (mínimo al arrancar)' }, grid: { drawOnChartArea: false } }
          },
          plugins: { legend: { position: 'bottom' } }
        }
      });
    }
    cont.appendChild(panel);
    cont.scrollIntoView && cont.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // --- Exportaciones -----------------------------------------------------------------
  function celdaCsv(v) {
    var t = (v === null || v === undefined) ? '' : String(v);
    return /[;"\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }

  function construirCsv(filas) {
    var cab = ['Vehículo', 'Ciudad', 'Marca', 'Sistema (V)', 'Estado', 'Fuente', 'ESR', 'Banda ESR', 'ESR mediana del periodo', 'Antigüedad ESR (h)',
      'Mínimo al arrancar (V)', 'Cambio vs semana previa (V)', 'Caída al arrancar (V)', 'Reposo (V)', 'Recuperación (V)', '% arranques sin recuperar', 'Arranques 7 d', 'Último dato', 'Motivos'];
    var out = [cab];
    ordenarFilas(filas).forEach(function (f) {
      out.push([f.vehiculo.nombre, f.vehiculo.ciudad, f.vehiculo.marca, f.nominal || '', f.estado, f.esrVigente ? 'ESR Geotab' : (f.sinReferencia ? 'Señales · sin ESR' : 'Señales (estimado)'),
        num(f.esr), f.esrBanda || '', num(f.esrBase), num(f.esrEdadH, 1), num(f.minimoV, 2), num(f.cambioMinimoV, 2), num(f.caidaV, 2), num(f.reposoV, 2), num(f.recuperacionV, 2),
        f.noRecuperaPct === null ? '' : num(f.noRecuperaPct * 100), f.arranques7d, f.ultimoDatoMs ? fmtFecha(f.ultimoDatoMs) : '', f.motivos.join(' | ')]);
    });
    return '﻿' + out.map(function (r) { return r.map(celdaCsv).join(';'); }).join('\r\n');
  }

  // Un mensaje por ciudad, listo para pegar en WhatsApp
  function construirMensaje(filas) {
    var porCiudad = {};
    filas.forEach(function (f) { (porCiudad[f.vehiculo.ciudad] = porCiudad[f.vehiculo.ciudad] || []).push(f); });
    var ahora = fmtFecha(datos.ahoraMs);
    var bloques = Object.keys(porCiudad).sort().map(function (ciudad) {
      var lista = porCiudad[ciudad], l = ['🔋 BATERÍAS — ' + ciudad, ahora, ''];
      [['Alerta', '🔴 ALERTA'], ['Revisar', '🟠 REVISAR'], ['Vigilar', '🟡 VIGILAR']].forEach(function (par) {
        var grupo = lista.filter(function (f) { return f.estado === par[0]; });
        if (!grupo.length) return;
        l.push(par[1] + ' (' + grupo.length + ')');
        ordenarFilas(grupo).forEach(function (f) { l.push('• ' + f.vehiculo.nombre + ' · ' + f.motivos.join(' · ')); });
        l.push('');
      });
      if (l.length === 3) l.push('✅ Sin novedad en baterías.', '');
      var sinDatos = lista.filter(function (f) { return f.estado === 'Sin datos'; }).length, sinRef = lista.filter(function (f) { return f.sinReferencia; }).length;
      if (sinDatos || sinRef) l.push('(' + [sinDatos ? sinDatos + ' sin datos suficientes' : '', sinRef ? sinRef + ' de 24 V sin ESR de referencia' : ''].filter(Boolean).join('; ') + ')');
      return l.join('\n').trim();
    });
    return bloques.join('\n\n────────────────────────────\n\n');
  }

  // --- Pintado general --------------------------------------------------------------------
  function repintar() {
    if (!datos) return;
    var filas = filasFiltradas();
    pintarKpis(filas);
    pintarTabla(filas);
    pintarDetalle();
    elementos.estadoCarga.textContent = 'Datos de ' + fmtFecha(datos.ahoraMs) + ' · ESR de ' + DIAS_ESR + ' d y arranques de ' + DIAS_ARRANQUES + ' d · se actualiza cada ' + (REFRESCO_MS / 60000) + ' min · ' + filas.length + ' de ' + datos.filas.length + ' vehículos';
  }

  function cargar() {
    if (cargando) return;
    cargando = true;
    elementos.botonActualizar.disabled = true;
    var linea = mostrarCargando(elementos.tabla, 'Cargando datos de Geotab…');
    vaciar(elementos.kpis);
    cargarEvaluaciones(function (hecho, total) { linea.textContent = 'Cargando datos de Geotab… ' + hecho + ' de ' + total + ' tramos'; })
      .then(function (r) {
        datos = r;
        var ciudades = {};
        r.filas.forEach(function (f) { ciudades[f.vehiculo.ciudad] = true; });
        elementos.ciudadSel.cargar([{ valor: '', etiqueta: 'Todas' }].concat(Object.keys(ciudades).sort().map(function (c) { return { valor: c, etiqueta: c }; })), filtros.ciudad);
        repintar();
      })
      .catch(function (err) {
        console.error('Validación de Baterías:', err);
        mostrarError(elementos.tabla, describirError(err));
      })
      .then(function () { cargando = false; elementos.botonActualizar.disabled = false; });
  }

  function programarRefresco() {
    detenerRefresco();
    temporizador = setInterval(function () { if (!document.hidden) cargar(); }, REFRESCO_MS);
  }
  function detenerRefresco() { if (temporizador) { clearInterval(temporizador); temporizador = null; } }

  function construirNotaMetodologia() {
    var det = crear('details', { margin: '0 22px 22px 22px', padding: '12px 16px', background: T.color.surface, border: '1px solid ' + T.color.border, borderRadius: T.radius.md, fontSize: '0.78rem', color: T.color.body });
    det.appendChild(crear('summary', { cursor: 'pointer', fontWeight: '700', color: T.color.ink }, 'Cómo se evalúa y qué límites tiene'));
    var lineas = [
      'Fuente 1 — ESR de Geotab (0-100, "Clasificación del sistema eléctrico"): es la referencia. Se usa si su último dato tiene menos de ' + HORAS_ESR_VIGENTE + ' h. Alerta: ESR < ' + ESR_ALERTA + '. Revisar: ESR < ' + ESR_REVISAR + ' o caída de ' + ESR_CAIDA_PUNTOS + ' pts o más bajo su mediana de ' + DIAS_ESR + ' días.',
      'Fuente 2 — Señales de arranque ("Voltaje de arranque"): de cada arranque se toman reposo, mínimo, caída y recuperación; el estado usa la mediana de los últimos 7 días (mínimo ' + MIN_ARRANQUES_VENTANA + ' arranques). Sin ESR vigente, en 12 V: mínimo < ' + fmtV(MINIMO_VIGILAR_12V) + ' V = Vigilar y < ' + fmtV(MINIMO_REVISAR_12V) + ' V = Revisar (umbrales medidos en esta flota el 09-nov-2026).',
      'Tendencia: el mínimo cae ' + fmtV(TENDENCIA_VIGILAR_V) + ' V o más frente a la semana anterior = Vigilar; ' + fmtV(TENDENCIA_REVISAR_V) + ' V o más = Revisar. El peor cambio semanal visto en la flota fue de 0,2 V.',
      'Recuperación: si el voltaje tras arrancar queda más de ' + fmtV(-RECUPERA_UMBRAL_V) + ' V por debajo del reposo en ' + Math.round(RECUPERA_FRACCION * 100) + ' % o más de los arranques (mínimo ' + RECUPERA_MIN_ARRANQUES + ') = Revisar alternador o cableado.',
      'Límites: (1) los vehículos de 24 V no tienen ESR de Geotab, por eso no hay umbral absoluto para ellos (marcados "Normal*" cuando no hay novedad): solo se detectan cambios y desviaciones frente a sus pares. (2) El cálculo por señales se calibró con muy pocos casos de baterías malas (3 vehículos con ESR < 30): úselo para priorizar revisión, no para decidir un cambio de batería. (3) Voltajes mostrados en voltios reales; internamente se normalizan a 12 V.',
      '* Normal en un 24 V significa "sin novedad detectable", no "batería comprobada".'
    ];
    lineas.forEach(function (t) { det.appendChild(crear('p', { margin: '8px 0 0 0', lineHeight: '1.45' }, t)); });
    return det;
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi; state = freshState;
      var raiz = document.getElementById('validacionBateriasRoot');
      aplicarEstilo(raiz, { fontFamily: T.font, background: T.color.canvas, padding: '4px' });
      var enc = crearEncabezado('🔋', 'Validación de Baterías',
        'Estado del sistema eléctrico de la flota: ESR de Geotab y señales de arranque, con la fuente y la antigüedad de cada dato.');

      var barra = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'flex-end' });
      elementos.ciudadSel = crearSelect('Ciudad', [{ valor: '', etiqueta: 'Todas' }], '190px');
      elementos.sistemaSel = crearSelect('Sistema', [{ valor: '', etiqueta: 'Todos' }, { valor: '12', etiqueta: '12 V' }, { valor: '24', etiqueta: '24 V' }], '110px');
      elementos.estadoSel = crearSelect('Estado', [{ valor: '', etiqueta: 'Todos' }].concat(ORDEN_ESTADOS.map(function (e) { return { valor: e, etiqueta: e }; })), '130px');
      var campoBuscar = crear('div', { display: 'flex', flexDirection: 'column', gap: '4px' });
      campoBuscar.appendChild(crear('label', { fontSize: '0.75rem', color: T.color.muted, fontWeight: '600' }, 'Vehículo'));
      var inputBuscar = crear('input', { padding: '7px 10px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm, fontSize: '0.82rem', fontFamily: T.font, color: T.color.ink, width: '150px' });
      inputBuscar.type = 'text'; inputBuscar.placeholder = 'Placa o número';
      campoBuscar.appendChild(inputBuscar);
      elementos.ciudadSel.select.addEventListener('change', function () { filtros.ciudad = this.value; repintar(); });
      elementos.sistemaSel.select.addEventListener('change', function () { filtros.sistema = this.value; repintar(); });
      elementos.estadoSel.select.addEventListener('change', function () { filtros.estado = this.value; repintar(); });
      inputBuscar.addEventListener('input', function () { filtros.texto = this.value; repintar(); });

      elementos.botonActualizar = crearBoton('Actualizar', true);
      elementos.botonActualizar.addEventListener('click', cargar);
      var botonCsv = crearBoton('Descargar CSV', false), botonMsg = crearBoton('Copiar mensaje WhatsApp', false);
      botonCsv.addEventListener('click', function () {
        if (!datos) return;
        descargarArchivo('baterias_' + slug(filtros.ciudad || 'TODAS') + '_' + claveDia(datos.ahoraMs) + '.csv', construirCsv(filasFiltradas()), 'text/csv;charset=utf-8');
      });
      botonMsg.addEventListener('click', function () {
        if (!datos) return;
        var r = copiarTexto(construirMensaje(filasFiltradas()));
        Promise.resolve(r).then(function (ok) { botonMsg.textContent = ok ? 'Copiado ✓' : 'No se pudo copiar'; setTimeout(function () { botonMsg.textContent = 'Copiar mensaje WhatsApp'; }, 2500); });
      });
      [elementos.ciudadSel.envoltorio, elementos.sistemaSel.envoltorio, elementos.estadoSel.envoltorio, campoBuscar, elementos.botonActualizar, botonCsv, botonMsg].forEach(function (e) { barra.appendChild(e); });
      enc.appendChild(barra);
      elementos.estadoCarga = crear('div', { fontSize: '0.72rem', color: T.color.muted, marginTop: '10px' }, '');
      enc.appendChild(elementos.estadoCarga);
      raiz.appendChild(enc);

      elementos.kpis = crear('div', { display: 'flex', gap: '12px', flexWrap: 'wrap', padding: '16px 22px 0 22px' });
      raiz.appendChild(elementos.kpis);
      elementos.detalle = crear('div', { display: 'none', paddingTop: '16px' });   // sobre la tabla: con 85 filas, abajo no se vería
      raiz.appendChild(elementos.detalle);
      var panelTabla = crearPanel({ margin: '16px 22px', padding: '4px 0', overflow: 'hidden' });
      elementos.tabla = crear('div');
      panelTabla.appendChild(elementos.tabla);
      raiz.appendChild(panelTabla);
      raiz.appendChild(construirNotaMetodologia());

      initializedCallback();
      cargar();
    },

    focus: function (freshApi, freshState) {
      api = freshApi; state = freshState;
      programarRefresco();
      if (datos && Date.now() - datos.ahoraMs > REFRESCO_MS) cargar();
    },
    blur: function () { detenerRefresco(); }
  };

};
