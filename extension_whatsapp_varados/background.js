/* Proceso de fondo: recibe los reportes que lee content.js, los guarda en una cola que
   sobrevive al cierre del navegador y los envía al receptor (Apps Script). Si no hay
   conexión o el PC estuvo apagado, la cola se vacía sola al volver. */
'use strict';

var CFG_BASE = { url: '', token: '', grupo: 'Mantenimiento Promo', modo: 'simulacro', horasAtras: 24 };
var MAX_INTENTOS = 5;
var enCurso = false;

function leerCfg() {
  return chrome.storage.local.get('cfg').then(function (r) { return Object.assign({}, CFG_BASE, r.cfg || {}); });
}

function registrar(estado, id, detalle) {
  return chrome.storage.local.get('registro').then(function (r) {
    var reg = r.registro || [];
    reg.unshift({ ts: Date.now(), estado: estado, id: id, detalle: detalle });
    return chrome.storage.local.set({ registro: reg.slice(0, 200) });
  });
}

// "Unidad 1209 · mar, 10/11/2026 · 04:31:38"
function resumen(texto) {
  var u = ((String(texto).match(/Interno:\s*(\d+)/i) || String(texto).match(/Unidad\s+(\d+)/i)) || [])[1] || '?';
  var f = (String(texto).match(/Fecha y Hora:\s*([^\n]*)/i) || [])[1] || '';
  return 'Unidad ' + u + (f ? ' · ' + f.trim() : '');
}

function badge(texto, color) {
  try { chrome.action.setBadgeText({ text: texto }); if (color) chrome.action.setBadgeBackgroundColor({ color: color }); } catch (e) { /* sin icono */ }
}

function actualizarBadge() {
  return chrome.storage.local.get('cola').then(function (r) {
    var n = (r.cola || []).length;
    badge(n ? String(n) : '', '#b45309');
  });
}

function quitar(id) {
  return chrome.storage.local.get('cola').then(function (r) {
    return chrome.storage.local.set({ cola: (r.cola || []).filter(function (x) { return x.id !== id; }) });
  });
}

function recibir(m) {
  return leerCfg().then(function (c) {
    if (c.modo !== 'real') {
      return registrar('simulacro', m.id, 'Se habría enviado: ' + resumen(m.texto)).then(function () { return { ok: true, simulacro: true }; });
    }
    return chrome.storage.local.get('cola').then(function (r) {
      var cola = r.cola || [];
      if (!cola.some(function (x) { return x.id === m.id; })) cola.push({ id: m.id, texto: m.texto, intentos: 0, ts: Date.now() });
      return chrome.storage.local.set({ cola: cola });
    }).then(function () { vaciarCola(); return { ok: true, encolado: true }; });
  });
}

// Cuánto tardó: desde que la extensión vio el mensaje, el viaje de ida y vuelta al receptor y lo que tardó el receptor por dentro.
function tiempos(it, res, t0) {
  var s = function (ms) { return (ms / 1000).toFixed(1) + ' s'; };
  return ' · ' + s(Date.now() - it.ts) + ' desde que se vio · envío ' + s(Date.now() - t0) +
    (res && res.ms ? ' · receptor ' + s(res.ms.total) + ' (abrir ' + s(res.ms.abrir) + ', leer ' + s(res.ms.leer) + ', escribir ' + s(res.ms.escribir) + ')' : '');
}

// Envía la cola en orden. Se detiene al primer problema y reintenta en la próxima alarma (1 min).
function vaciarCola() {
  if (enCurso) return Promise.resolve();
  enCurso = true;
  return leerCfg().then(function (c) {
    if (c.modo !== 'real') return;
    if (!c.url || !c.token) { badge('!', '#b91c1c'); return; }
    function siguiente() {
      return chrome.storage.local.get('cola').then(function (r) {
        var cola = r.cola || [];
        if (!cola.length) return;
        var it = cola[0], t0 = Date.now();
        return fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: c.token, texto: it.texto, recibido: it.ts }) })
          .then(function (resp) { return resp.json(); })
          .then(function (res) {
            if (res && res.ok) {
              return quitar(it.id).then(function () { return registrar(res.duplicado ? 'duplicado' : 'registrado', it.id, resumen(it.texto) + (res.fila ? ' · fila ' + res.fila : '') + (res.sinFechaEnMensaje ? ' · sin fecha en el mensaje' : '') + tiempos(it, res, t0)); }).then(siguiente);
            }
            if (res && res.ignorado) {
              return quitar(it.id).then(function () {
                return res.revisar ? registrar('revisar', it.id, resumen(it.texto) + ' · ' + (res.error || 'revisar a mano')) : registrar('ignorado', it.id, 'El receptor no lo tomó como reporte');
              }).then(siguiente);
            }
            if (res && res.error === 'no autorizado') {
              badge('!', '#b91c1c');
              return registrar('error', it.id, 'Token incorrecto: revise la configuración de la extensión');
            }
            if (res && /ocupado/.test(String(res.error))) return;      // reintenta en la próxima alarma
            it.intentos = (it.intentos || 0) + 1;
            if (it.intentos >= MAX_INTENTOS) {
              return quitar(it.id).then(function () { return registrar('error', it.id, 'Descartado tras ' + MAX_INTENTOS + ' intentos: ' + (res && res.error)); }).then(siguiente);
            }
            return chrome.storage.local.set({ cola: cola }).then(function () { return registrar('reintento', it.id, String(res && res.error)); });
          })
          .catch(function (e) { return registrar('sin-conexion', it.id, String(e && e.message ? e.message : e)); });   // queda en la cola
      });
    }
    return siguiente();
  }).then(function () { enCurso = false; return actualizarBadge(); }, function () { enCurso = false; });
}

chrome.runtime.onMessage.addListener(function (m, _sender, responder) {
  if (m && m.tipo === 'reporte') {
    recibir(m).then(responder, function (e) { responder({ ok: false, error: String(e) }); });
    return true;
  }
  if (m && m.tipo === 'vaciar') {
    vaciarCola().then(function () { responder({ ok: true }); });
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener(function (a) { if (a.name === 'vaciar') vaciarCola(); });
chrome.runtime.onInstalled.addListener(function () { chrome.alarms.create('vaciar', { periodInMinutes: 1 }); });
chrome.runtime.onStartup.addListener(function () { chrome.alarms.create('vaciar', { periodInMinutes: 1 }); vaciarCola(); });
