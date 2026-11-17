
  // ============================================================================
  // LÓGICA PURA: velocidad sostenida sobre el límite y su severidad.
  //
  // Criterio tomado de la regla de Geotab "V_VELOCIDAD MAYOR A 50 KM/H" (paquete de la
  // app de Hábitos, 2026-11-13): velocidad del motor en carretera (DiagnosticEngineRoadSpeedId)
  // por encima de 50 km/h durante al menos 30 s seguidos. Criticidad por el MÁXIMO alcanzado,
  // con corte [mínimo, máximo): BAJA 50 a <60, MEDIA 60 a <70, ALTA 70 o más.
  // ============================================================================

  var MS_HORA = 3600000;

  var LIMITE_KMH = 50;
  var SEGUNDOS_SOSTENIDO = 30;           // por debajo de esto es "sobre el límite", no alarma
  var VENTANA_MIN = 5;                   // minutos de señal que se leen en cada refresco
  var EDAD_MAX_LECTURA_S = 120;          // una lectura más vieja que esto no es "ahora"
  var KMH_DETENIDO = 2;
  // Mayor primero; nivel = semáforo de ui.js (3 urgente, 2 avisar, 1 observación)
  var SEVERIDADES = [
    { nombre: 'ALTA', minimo: 70, nivel: 3 },
    { nombre: 'MEDIA', minimo: 60, nivel: 2 },
    { nombre: 'BAJA', minimo: LIMITE_KMH, nivel: 1 }
  ];

  function severidadDe(pico) {
    for (var i = 0; i < SEVERIDADES.length; i++) if (pico >= SEVERIDADES[i].minimo) return SEVERIDADES[i];
    return null;
  }

  // lecturas: [[tMs, kmh], ...] ordenadas por tiempo. Devuelve { estado, velocidad, t, ... }
  //   ALARMA = sostenida >= SEGUNDOS_SOSTENIDO sobre el límite; SOBRE = sobre el límite, aún sin sostener;
  //   NORMAL = en movimiento bajo el límite; DETENIDO = casi 0 km/h; SIN_LECTURA = no hay lectura reciente.
  // La duración se mide entre lecturas (de la primera sobre el límite a la última), así que subestima como mucho
  // un intervalo de muestreo (unos segundos): no inventa tiempo.
  function evaluarVelocidad(lecturas, ahoraMs) {
    if (!lecturas || !lecturas.length) return { estado: 'SIN_LECTURA', velocidad: null, t: null };
    var n = lecturas.length, ult = lecturas[n - 1];
    if ((ahoraMs - ult[0]) / 1000 > EDAD_MAX_LECTURA_S) return { estado: 'SIN_LECTURA', velocidad: ult[1], t: ult[0] };
    var i = n - 1;
    while (i >= 0 && lecturas[i][1] > LIMITE_KMH) i--;
    if (i === n - 1) return { estado: ult[1] < KMH_DETENIDO ? 'DETENIDO' : 'NORMAL', velocidad: ult[1], t: ult[0] };
    var pico = 0;
    for (var j = i + 1; j < n; j++) if (lecturas[j][1] > pico) pico = lecturas[j][1];
    var duracionS = (ult[0] - lecturas[i + 1][0]) / 1000;
    return {
      estado: duracionS >= SEGUNDOS_SOSTENIDO ? 'ALARMA' : 'SOBRE',
      velocidad: ult[1], t: ult[0], desde: lecturas[i + 1][0], duracionS: duracionS, pico: pico, severidad: severidadDe(pico),
      desdeAntesDeVentana: i < 0       // la racha ya venía desde antes de la ventana leída: la duración real es mayor
    };
  }
