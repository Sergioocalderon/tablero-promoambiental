const fs = require('fs'), vm = require('vm'), assert = require('assert');
const RUTA = require('path').join(__dirname, '..', 'mantenimiento.js');   // node pruebas/prueba_escopos.js [salida.html]
const src = fs.readFileSync(RUTA, 'utf8');
const a = src.indexOf('  var LIMITE_PAGINA_FAULTDATA'), b = src.indexOf('  // --- Retroalimentación visual');
assert(a > 0 && b > a, 'no se ubicó el tramo de funciones');
const trozo = src.slice(a, b) + '\n return { construirEscopos, construirFichas, serieOrdenada, valorCercano, construirTablaDetalle, construirFlota, construirDataset, construirDiasIso, construirFiltrosLi, ensamblarReporteHtml, formatearDuracion, resolverSistema, PLANTILLA_Z: PLANTILLA_Z };';
const ctx = { console, Date, JSON, Math, Object, Array, String, Number, RegExp, Promise, encodeURIComponent, Intl };
vm.createContext(ctx);
// la plantilla incrustada (comprimida) está antes del tramo: se incluye el bloque entre sus marcas
const pIni = src.indexOf('  // ==== PLANTILLA_COMPRIMIDA'), pFin = src.indexOf('  // ==== FIN PLANTILLA_COMPRIMIDA');
const F = vm.runInContext('(function(){' + src.slice(pIni, pFin) + '\n' + trozo + '})()', ctx);

let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };
const H = 3600000, D = 24 * H;
const corte = new Date('2026-11-11T13:00:00'), hasta = corte, desde = new Date(corte.getTime() - 7 * D);
const t = ms => new Date(corte.getTime() - ms).toISOString();
const reg = (dev, diag, ms, estado, o) => Object.assign({ device: { id: dev }, diagnostic: { id: diag }, failureMode: { id: 'FM1' }, controller: { id: 'ControllerJ1939EngineNo1Id' }, dateTime: t(ms), faultState: estado, dismiss: false }, o || {});
const cat = { dicDiag: { D1: { nombre: 'Temperatura del refrigerante del motor', codigo: 110 }, D2: { nombre: 'Evento Go', codigo: 5, fuente: 'SourceGeotabGoId' }, D3: { nombre: 'Presión de aceite', codigo: 100 }, D4: { nombre: 'Voltaje de la batería', codigo: 168 }, D5: { nombre: 'Presión de turbo', codigo: 102 } }, dicFm: { FM1: { nombre: 'Above normal', codigo: 0 } } };
const info = { d1: { nombre: '1001', placa: 'AAA111', marca: 'Foton', tipologia: 'COMPACTADORES', empresa: 'EMP' }, d2: { nombre: '1002', placa: 'BBB222', marca: 'Chevrolet', tipologia: 'FURGON', empresa: 'EMP' } };

const registros = [
  // 1) d1/D1: activa desde hace 9 días (antes del rango), sigue reportando hasta hace 2 h -> ACTIVA, no es activación del período
  reg('d1', 'D1', 9 * D, 'Active'), reg('d1', 'D1', 5 * D, 'Active', { amberWarningLamp: true }), reg('d1', 'D1', 1 * D, 'Active'), reg('d1', 'D1', 2 * H, 'Active', { redStopLamp: true }),
  // 2) d1/D2: GoFault -> excluida
  reg('d1', 'D2', 3 * D, 'Active'),
  // 3) d2/D1: dos episodios en el período; el segundo con luz roja; termina inactiva
  reg('d2', 'D1', 3 * D, 'Active', { amberWarningLamp: true }), reg('d2', 'D1', 3 * D - H, 'None'), reg('d2', 'D1', 1 * D, 'Active', { redStopLamp: true }), reg('d2', 'D1', 1 * D - 2 * H, 'None'),
  // 4) d2/D3: un solo registro Active hace 36 h -> NO activa (regla 24 h) pero sí 1 activación
  reg('d2', 'D3', 36 * H, 'Active'),
  // 5) d2/D4: parpadeo (reactiva a los 4 min) -> 1 episodio
  reg('d2', 'D4', 2 * D, 'Active'), reg('d2', 'D4', 2 * D - 60000, 'None'), reg('d2', 'D4', 2 * D - 5 * 60000, 'Active'), reg('d2', 'D4', 2 * D - 6 * 60000, 'None'),
  // 5b) d1/D5: Pending con luz MIL hace 3 h -> ACTIVA (Pending cuenta como activa) y MEDIA (MIL)
  reg('d1', 'D5', 3 * H, 'Pending', { malfunctionLamp: true }),
  // 6) dispositivo fuera de alcance -> se ignora
  reg('dX', 'D1', 1 * D, 'Active')
];

console.log('Escopos:');
const e = F.construirEscopos(registros, cat, info, 'EMP', desde, hasta, corte);
ok(e.activos.length === 2 && e.activos.some(f => f.codigo === 'SPN 110 / FMI 0' && f.movil === '1001'), 'activos al corte: la 1001/SPN 110 y la Pending (la de la regla de 24 h y la GoFault quedan fuera)');
const fp = e.activos.find(f => f.codigo === 'SPN 102 / FMI 0');
ok(fp && fp.criticidad === 'MEDIA', 'Pending cuenta como activa y la luz MIL da criticidad MEDIA');
e.activos = e.activos.filter(f => f.codigo !== 'SPN 102 / FMI 0');
ok(e.activos[0].criticidad === 'ALTA', 'la criticidad del activo es la del ÚLTIMO registro (luz roja)');
ok(e.activos[0].tipo_falla === 'Recurrente' && e.activos[0].activaciones === 0, 'venía de antes del período: Recurrente y sin activaciones propias');
ok(/d /.test(e.activos[0].duracion), 'duración de una falla larga ("' + e.activos[0].duracion + '")');
ok(e.activaciones.length === 4, 'activaciones del período: 4 fallas (d2/D1, d2/D3, d2/D4 y la Pending d1/D5); la 1001/SPN 110 no, porque empezó antes');
const f3 = e.activaciones.find(f => f.movil === '1002' && f.codigo.indexOf('SPN 110') === 0);
ok(f3.activaciones === 2 && f3.criticidad === 'ALTA' && f3.estado === 'Inactivo', 'd2/D1: 2 activaciones, criticidad máxima ALTA, estado Inactivo');
const dias = Object.keys(f3.activationCritDays).sort();
ok(dias.length === 2 && f3.activationCritDays[dias[0]].MEDIA === 1 && f3.activationCritDays[dias[1]].ALTA === 1, 'activationCritDays: cada día con la criticidad de su episodio');
const f4 = e.activaciones.find(f => f.codigo.indexOf('SPN 100') === 0);
ok(f4.activaciones === 1 && f4.estado === 'Inactivo' && !e.activos.some(f => f.codigo.indexOf('SPN 100') === 0), 'd2/D3: una activación y NO figura como activa (último registro de hace 36 h)');
const f5 = e.activaciones.find(f => f.codigo.indexOf('SPN 168') === 0);
ok(f5.activaciones === 1, 'd2/D4: el parpadeo de 4 min cuenta una sola activación');
ok(!e.activos.concat(e.activaciones).some(f => f.device === 'dX' || f.codigo.indexOf('SPN 5') === 0), 'GoFault y dispositivos fuera de alcance excluidos');

console.log('Tablas y dataset:');
const tA = F.construirTablaDetalle(e.activos, true), tB = F.construirTablaDetalle(e.activaciones, false);
ok(tA.columns.length === 18 && tA.rows.every(r => r.length === 18) && tB.rows.every(r => r.length === 18), 'las filas del detalle tienen las 18 columnas');
ok(tB.rows[0][3].periodSeverity === true && tB.rows[0][5].kind === 'period_activations', 'activaciones: celdas de criticidad y cantidad con byDay');
const dev = [{ id: 'd1', name: '1001' }, { id: 'd2', name: '1002' }];
const flota = F.construirFlota(dev, info, 'EMP');
const ds = F.construirDataset(e, flota, F.construirDiasIso(desde, hasta));
ok(ds.scopeVersion === 2 && ds.fleet.length === 2 && ds.dayLabels.length === 8 && ds.dayLabels[0] === '2026-11-04', 'dataset v2: flota y 8 días ISO');
const datos = { empresaNombre: 'EMP <&>', periodoValue: '04 nov 2026 → 11 nov 2026', periodoDetail: 'Rango · 8 días', periodoFechas: '04/11/2026 → 11/11/2026', generadoTexto: '11/11/2026 13:00', filtrosLi: F.construirFiltrosLi('EMP', desde, hasta, 2), fichas: F.construirFichas(e, 'Rango · 04/11/2026 → 11/11/2026 (8 días)', corte), dataset: ds, tablaActivos: tA, tablaActivaciones: tB };
const plantilla = require('zlib').inflateSync(Buffer.from(F.PLANTILLA_Z, 'base64')).toString('utf8');
ok(plantilla === fs.readFileSync(require('path').join(__dirname, '..', 'reporte_plantilla_v2.html'), 'utf8'), 'la plantilla comprimida dentro del .js es idéntica a reporte_plantilla_v2.html');
const html = F.ensamblarReporteHtml(plantilla, datos);
ok(!/\{\{[A-Z_]+\}\}/.test(html) && html.indexOf('EMP &lt;&amp;&gt;') > 0, 'ensamblado: sin marcadores sin sustituir y con el nombre escapado');
const out = process.argv[2] || 'salida.html';
fs.writeFileSync(out, html);
const e2 = F.construirEscopos(registros, cat, info, 'EMP', desde, hasta, corte);   // datos sin las modificaciones de arriba
const fi = F.construirFichas(e2, 'p', corte);
ok(fi.rows.length === e2.activos.length + e2.activaciones.length && fi.rows[0].state === 'Activo' && fi.rows[e2.activaciones[0].reviewIndex].codes === e2.activaciones[0].codigo, 'fichas: filas = activos + activaciones, y reviewIndex apunta a la fila correcta');
// Contadores (StatusData): odómetro en metros -> km, horas de motor en segundos -> h, lectura más cercana con tolerancia
const base = new Date('2026-11-10T00:00:00').getTime();
const serieKm = F.serieOrdenada([{ dateTime: new Date(base).toISOString(), data: 100000000 }, { dateTime: new Date(base + 6 * H).toISOString(), data: 100500000 }, { dateTime: new Date(base + 2 * D).toISOString(), data: 101000000 }, { dateTime: 'x', data: 'no-numero' }], 1000);
ok(serieKm.length === 3 && serieKm[0][1] === 100000, 'serieOrdenada: metros a km y descarta lecturas inválidas');
ok(F.valorCercano(serieKm, base + 5 * H) === 100500, 'valorCercano: toma la lectura más cercana (la de +6 h)');
ok(F.valorCercano(serieKm, base + 1 * D) === null, 'valorCercano: sin lectura a menos de 12 h -> null (la ficha muestra "—")');
const eh = F.construirEscopos(registros, cat, info, 'EMP', desde, hasta, corte);
const cont = { d1: { km: serieKm, horas: F.serieOrdenada([{ dateTime: new Date(base).toISOString(), data: 36000 }], 3600) } };
const fc = F.construirFichas(eh, 'p', corte, cont);
ok(fc.rows.every(r => r.counters.primera.status === 'NO_DATA' || r.counters.primera.km || r.counters.primera.hours) && fc.rows[0].counters.primera.status === 'NO_DATA', 'fichas con contadores: formato {km:{value}, hours:{value}, status} y NO_DATA cuando no hay lectura');
console.log('\n' + n + ' comprobaciones correctas. HTML:', Math.round(html.length / 1024), 'KB');
