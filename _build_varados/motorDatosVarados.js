/* ============================================================================
   Motor de Datos y Lógica de Cálculos: Vehículos Varados en Vía
   ============================================================================
   Fase 1 (lectura/normalización) + Fase 2 (cálculo de tiempos + KPIs).
   Lógica pura, sin tocar el DOM -- recibe el JSON que ya entregó SheetJS
   (XLSX.utils.sheet_to_json(workbook.Sheets['VARADOS'])) y devuelve datos
   listos para que otra capa los pinte.

   Columnas esperadas en la hoja VARADOS: MOVIL, FECHA, HORA REPORTE,
   HORA INICIO, HORA FIN, SISTEMA, LOCALIDAD, TECNICO, ESTATUS.
   ============================================================================ */
var VaradosDatos = (function () {
  'use strict';

  var COLUMNAS_REQUERIDAS = ['MOVIL', 'FECHA', 'HORA REPORTE', 'HORA INICIO', 'HORA FIN', 'SISTEMA', 'LOCALIDAD', 'TECNICO', 'ESTATUS'];

  // ==========================================================================
  // FASE 1 -- Lectura y normalización
  // ==========================================================================

  // Mayúsculas + espacios de sobra colapsados -- mismo criterio que ya usa
  // el resto de este proyecto para nombres de grupo/vehículo, para que un
  // "Bogotá " con espacio final y un "BOGOTA" sin tilde no cuenten como dos
  // localidades distintas en las agrupaciones de la Fase 2.
  function normalizarTexto(valor) {
    if (valor === null || valor === undefined) return '';
    return String(valor).trim().replace(/\s+/g, ' ').toUpperCase();
  }

  // SheetJS puede entregar una celda de fecha/hora de 3 formas distintas según
  // cómo esté formateada la celda en el Excel origen -- hay que cubrir las 3:
  //  1) Date de JS (si el workbook se leyó con { cellDates: true }).
  //  2) Número serial de Excel (fracción de día: 0.5 = mediodía) si NO se usó
  //     cellDates -- la forma más común cuando se lee con FileReader crudo.
  //  3) String "HH:MM" o "HH:MM:SS", con o sin AM/PM -- cuando la celda ya
  //     venía como texto en el Excel, no como hora real.
  // Devuelve minutos transcurridos desde medianoche (0-1439.99), o null si no
  // se pudo interpretar (celda vacía, texto no reconocible) -- nunca lanza,
  // para que una fila con un dato sucio no tumbe el procesamiento de las demás.
  function aMinutosDelDia(valorCrudo) {
    if (valorCrudo === null || valorCrudo === undefined || valorCrudo === '') return null;

    if (valorCrudo instanceof Date) {
      if (isNaN(valorCrudo.getTime())) return null;
      return valorCrudo.getHours() * 60 + valorCrudo.getMinutes() + valorCrudo.getSeconds() / 60;
    }

    if (typeof valorCrudo === 'number') {
      // Fracción de día tipo Excel: la parte entera es el número de días
      // desde 1899-12-30 (irrelevante aquí), la parte decimal es la hora.
      var fraccionDia = valorCrudo - Math.floor(valorCrudo);
      return fraccionDia * 24 * 60;
    }

    var texto = String(valorCrudo).trim();
    var coincidencia = texto.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i);
    if (!coincidencia) return null;

    var horas = parseInt(coincidencia[1], 10);
    var minutos = parseInt(coincidencia[2], 10);
    var segundos = coincidencia[3] ? parseInt(coincidencia[3], 10) : 0;
    var meridiano = coincidencia[4] ? coincidencia[4].toUpperCase().replace(/\./g, '') : null;
    if (meridiano === 'PM' && horas < 12) horas += 12;
    if (meridiano === 'AM' && horas === 12) horas = 0;
    if (horas > 23 || minutos > 59) return null;

    return horas * 60 + minutos + segundos / 60;
  }

  // Misma idea que aMinutosDelDia pero para la columna FECHA -- se guarda
  // como Date normalizado a medianoche local (para poder agrupar/filtrar por
  // día sin que la hora arrastrada del Excel estorbe la comparación).
  function aFechaSoloDia(valorCrudo) {
    if (valorCrudo === null || valorCrudo === undefined || valorCrudo === '') return null;

    var fecha = null;
    if (valorCrudo instanceof Date) {
      fecha = valorCrudo;
    } else if (typeof valorCrudo === 'number') {
      // Serial de Excel completo (días desde 1899-12-30, con corrección del
      // bug histórico del año bisiesto 1900 que Excel arrastra a propósito).
      var msPorDia = 24 * 60 * 60 * 1000;
      fecha = new Date(Date.UTC(1899, 11, 30) + Math.round(valorCrudo) * msPorDia);
    } else {
      var texto = String(valorCrudo).trim();
      var coincidencia = texto.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
      if (coincidencia) {
        var dia = parseInt(coincidencia[1], 10);
        var mes = parseInt(coincidencia[2], 10) - 1;
        var anio = parseInt(coincidencia[3], 10);
        if (anio < 100) anio += 2000;
        fecha = new Date(anio, mes, dia);
      } else {
        var intento = new Date(texto);
        fecha = isNaN(intento.getTime()) ? null : intento;
      }
    }
    if (!fecha || isNaN(fecha.getTime())) return null;
    return new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate());
  }

  // Normaliza UNA fila cruda de SheetJS a la forma que consume el resto del
  // motor. Devuelve null (en vez de lanzar) si la fila no trae ni MOVIL ni
  // FECHA -- eso suele ser una fila vacía de relleno al final del Excel, no
  // un registro real; se descarta en silencio en normalizarFilas().
  function normalizarFila(filaCruda) {
    if (!filaCruda) return null;
    var movil = normalizarTexto(filaCruda['MOVIL']);
    var fecha = aFechaSoloDia(filaCruda['FECHA']);
    if (!movil && !fecha) return null;

    return {
      movil: movil,
      fecha: fecha,
      minutoReporte: aMinutosDelDia(filaCruda['HORA REPORTE']),
      minutoInicio: aMinutosDelDia(filaCruda['HORA INICIO']),
      minutoFin: aMinutosDelDia(filaCruda['HORA FIN']),
      sistema: normalizarTexto(filaCruda['SISTEMA']) || 'SIN CLASIFICAR',
      localidad: normalizarTexto(filaCruda['LOCALIDAD']) || 'SIN LOCALIDAD',
      tecnico: normalizarTexto(filaCruda['TECNICO']) || 'SIN ASIGNAR',
      estatus: normalizarTexto(filaCruda['ESTATUS'])
    };
  }

  // Punto de entrada de la Fase 1: JSON crudo de SheetJS -> filas normalizadas
  // CON los tiempos ya calculados (encadena directo con calcularTiemposFila
  // de la Fase 2, porque no tiene sentido normalizar sin calcular).
  function normalizarFilas(filasJson) {
    if (!Array.isArray(filasJson)) return [];
    var resultado = [];
    for (var i = 0; i < filasJson.length; i++) {
      var fila = normalizarFila(filasJson[i]);
      if (!fila) continue;
      resultado.push(calcularTiemposFila(fila));
    }
    return resultado;
  }

  // ==========================================================================
  // FASE 2 -- Cálculo de tiempos
  // ==========================================================================

  // CRÍTICO: diferencia en minutos entre dos horas del MISMO día operativo,
  // con cruce de medianoche. Si "fin" es menor que "inicio" (ej. inicio 23:00,
  // fin 02:00) se asume que fin cayó al día siguiente y se suman 24h -- así
  // nunca da negativo. Este truco solo cubre UN cruce de medianoche: si un
  // varado dura más de 24h reales (se resuelve dos días después de
  // reportado), el resultado va a quedar corto porque HORA FIN no trae
  // consigo su propia fecha en este modelo de datos (una sola columna FECHA
  // para toda la fila). Por eso calcularTiemposFila marca advertencia=true
  // cuando el total da sospechosamente alto (>20h) en vez de confiar en el
  // número a ciegas -- ver más abajo.
  function diferenciaMinutosConCruce(minutoInicio, minutoFin) {
    if (minutoInicio === null || minutoFin === null) return null;
    var diferencia = minutoFin - minutoInicio;
    if (diferencia < 0) diferencia += 24 * 60;
    return diferencia;
  }

  var UMBRAL_ADVERTENCIA_HORAS = 20;

  // Recibe una fila YA normalizada (con minutoReporte/minutoInicio/minutoFin
  // en minutos del día) y le agrega los 3 tiempos pedidos, en minutos Y en
  // horas decimales (más cómodo para promediar/mostrar). Cualquier tiempo
  // cuyo insumo falte queda en null, nunca en 0 -- un 0 se confundiría con
  // "llegó al instante", que es un dato real y distinto de "no hay dato".
  function calcularTiemposFila(fila) {
    var tiempoLlegadaMin = diferenciaMinutosConCruce(fila.minutoReporte, fila.minutoInicio);
    var tiempoReparacionMin = diferenciaMinutosConCruce(fila.minutoInicio, fila.minutoFin);
    var tiempoTotalVaradaMin = diferenciaMinutosConCruce(fila.minutoReporte, fila.minutoFin);

    fila.tiempoLlegadaMin = tiempoLlegadaMin;
    fila.tiempoReparacionMin = tiempoReparacionMin;
    fila.tiempoTotalVaradaMin = tiempoTotalVaradaMin;
    fila.tiempoLlegadaHoras = tiempoLlegadaMin === null ? null : tiempoLlegadaMin / 60;
    fila.tiempoReparacionHoras = tiempoReparacionMin === null ? null : tiempoReparacionMin / 60;
    fila.tiempoTotalVaradaHoras = tiempoTotalVaradaMin === null ? null : tiempoTotalVaradaMin / 60;
    // Ver comentario de diferenciaMinutosConCruce -- un total > 20h con este
    // modelo de una sola fecha es más probablemente un varado de varios días
    // (mal calculado) que uno real de menos de 24h. Se marca, no se descarta,
    // para que la capa de reporte decida si lo resalta o lo excluye.
    fila.advertenciaDuracionSospechosa = tiempoTotalVaradaMin !== null && tiempoTotalVaradaMin > UMBRAL_ADVERTENCIA_HORAS * 60;

    return fila;
  }

  // ==========================================================================
  // FASE 2 -- KPIs gerenciales
  // ==========================================================================
  // Todas reciben la lista de filas YA normalizadas (salida de
  // normalizarFilas) -- es responsabilidad de quien llama filtrar antes por
  // periodo/localidad/sistema si hace falta; estas funciones no filtran, solo
  // agregan lo que reciben.

  function totalReportes(filas) {
    return (filas || []).length;
  }

  function agruparPorCampo(filas, campo) {
    var conteos = {};
    (filas || []).forEach(function (fila) {
      var clave = fila[campo] || 'SIN DATO';
      conteos[clave] = (conteos[clave] || 0) + 1;
    });
    return conteos;
  }

  // Top N móviles con más reportes -- [{ movil, reportes }], orden
  // descendente; empate se rompe alfabéticamente para que el orden sea
  // determinista entre corridas (no dependa del orden de inserción del
  // objeto de conteo).
  function topMoviles(filas, n) {
    n = n || 10;
    var conteos = agruparPorCampo(filas, 'movil');
    return Object.keys(conteos)
      .map(function (movil) { return { movil: movil, reportes: conteos[movil] }; })
      .sort(function (a, b) { return b.reportes - a.reportes || a.movil.localeCompare(b.movil); })
      .slice(0, n);
  }

  // Frecuencia de fallas por SISTEMA -- [{ sistema, reportes }], orden
  // descendente (útil directo para una gráfica de barras/Pareto).
  function frecuenciaPorSistema(filas) {
    var conteos = agruparPorCampo(filas, 'sistema');
    return Object.keys(conteos)
      .map(function (sistema) { return { sistema: sistema, reportes: conteos[sistema] }; })
      .sort(function (a, b) { return b.reportes - a.reportes; });
  }

  // Tiempos promedio de ATENCIÓN por técnico -- "atención" se interpreta como
  // tiempo de REPARACIÓN (inicio->fin), no el tiempo total varada (que
  // incluye el tiempo de llegada, fuera del control del técnico una vez ya
  // está en sitio). Se promedia solo sobre filas con el dato disponible
  // (null se excluye del promedio, no cuenta como 0) y se reporta también
  // cuántos casos entraron en el promedio, para que la capa de reporte pueda
  // avisar si un técnico tiene muy pocos casos como para que el promedio
  // sea representativo.
  function tiemposPromedioPorTecnico(filas) {
    var acumulado = {};
    (filas || []).forEach(function (fila) {
      if (fila.tiempoReparacionHoras === null) return;
      var tecnico = fila.tecnico || 'SIN ASIGNAR';
      if (!acumulado[tecnico]) acumulado[tecnico] = { sumaHoras: 0, casos: 0 };
      acumulado[tecnico].sumaHoras += fila.tiempoReparacionHoras;
      acumulado[tecnico].casos += 1;
    });
    return Object.keys(acumulado)
      .map(function (tecnico) {
        var datos = acumulado[tecnico];
        return {
          tecnico: tecnico,
          casosConDato: datos.casos,
          promedioHorasReparacion: datos.sumaHoras / datos.casos
        };
      })
      .sort(function (a, b) { return b.promedioHorasReparacion - a.promedioHorasReparacion; });
  }

  return {
    COLUMNAS_REQUERIDAS: COLUMNAS_REQUERIDAS,
    // Fase 1
    normalizarTexto: normalizarTexto,
    aMinutosDelDia: aMinutosDelDia,
    aFechaSoloDia: aFechaSoloDia,
    normalizarFila: normalizarFila,
    normalizarFilas: normalizarFilas,
    // Fase 2 -- tiempos
    diferenciaMinutosConCruce: diferenciaMinutosConCruce,
    calcularTiemposFila: calcularTiemposFila,
    // Fase 2 -- KPIs
    totalReportes: totalReportes,
    topMoviles: topMoviles,
    frecuenciaPorSistema: frecuenciaPorSistema,
    tiemposPromedioPorTecnico: tiemposPromedioPorTecnico
  };
})();

// Node/CommonJS (para poder probar este motor con un test runner fuera del
// navegador) sin romper el uso como <script> global en el HTML del
// dashboard -- mismo patrón UMD mínimo, sin dependencias.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = VaradosDatos;
}
