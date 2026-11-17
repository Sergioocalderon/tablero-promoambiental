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
