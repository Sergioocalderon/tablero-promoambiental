/* Proceso de fondo: recibe los reportes que lee content.js, los guarda en una cola que
   sobrevive al cierre del navegador y los envía al receptor (Apps Script). Si no hay
   conexión o el PC estuvo apagado, la cola se vacía sola al volver. */
'use strict';

var CFG_BASE = { url: '', token: '', grupo: 'Mantenimiento Promo', modo: 'simulacro', horasAtras: 24, tgToken: '', tgChat: '' };
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

// v1.2.1: un mismo reporte llega varias veces (las respuestas que lo citan, p. ej. "en camino", traen el texto completo).
// Clave = unidad + "Fecha y Hora" del reporte; sin fecha y hora propia no se puede saber si es el mismo y se envía.
var DIAS_CLAVES = 4;   // igual al máximo de la puesta al día de content.js
function claveReporte(texto) {
  var t = String(texto);
  var u = (t.match(/Unidad\s+(\d+)/i) || t.match(/Interno:\s*(\d+)/i) || [])[1];
  var f = ((t.match(/Fecha y Hora:\s*([^\n]*)/i) || [])[1] || '').replace(/\D/g, '');
  return u && f.length >= 10 ? u + '|' + f : null;
}

// Claves ya contestadas por el receptor (registrado, duplicado, ignorado o a revisar): sus copias no se vuelven a enviar.
function marcarListo(k) {
  if (!k) return Promise.resolve();
  return chrome.storage.local.get('listos').then(function (r) {
    var l = r.listos || {}, limite = Date.now() - DIAS_CLAVES * 86400000;
    l[k] = Date.now();
    Object.keys(l).forEach(function (x) { if (l[x] < limite) delete l[x]; });
    return chrome.storage.local.set({ listos: l });
  });
}

function recibir(m) {
  return leerCfg().then(function (c) {
    if (c.modo !== 'real') {
      return registrar('simulacro', m.id, 'Se habría enviado: ' + resumen(m.texto)).then(function () { return { ok: true, simulacro: true }; });
    }
    var k = claveReporte(m.texto);
    return chrome.storage.local.get(['cola', 'listos']).then(function (r) {
      var cola = r.cola || [], listos = r.listos || {};
      if (k && (listos[k] || cola.some(function (x) { return x.clave === k; }))) return { ok: true, repetido: true };
      if (!cola.some(function (x) { return x.id === m.id; })) cola.push({ id: m.id, texto: m.texto, clave: k, intentos: 0, ts: Date.now() });
      return chrome.storage.local.set({ cola: cola }).then(function () { vaciarCola(); return { ok: true, encolado: true }; });
    });
  });
}

// Cuánto tardó: desde que la extensión vio el mensaje, el viaje de ida y vuelta al receptor y lo que tardó el receptor por dentro.
function tiempos(it, res, t0) {
  var s = function (ms) { return (ms / 1000).toFixed(1) + ' s'; };
  return ' · ' + s(Date.now() - it.ts) + ' desde que se vio · envío ' + s(Date.now() - t0) +
    (res && res.ms ? ' · receptor ' + s(res.ms.total) + ' (abrir ' + s(res.ms.abrir) + ', leer ' + s(res.ms.leer) + ', escribir ' + s(res.ms.escribir) + ')' : '');
}

// Envía la cola, lo más nuevo primero (v1.2.1: tras una puesta al día lo reciente es lo que suele faltar en la hoja).
// Se detiene al primer problema y reintenta en la próxima alarma (1 min).
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
        var it = cola[cola.length - 1], t0 = Date.now();
        return fetch(c.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token: c.token, texto: it.texto, recibido: it.ts }) })
          .then(function (resp) { return resp.json(); })
          .then(function (res) {
            if (res && res.ok) {
              return quitar(it.id).then(function () { return marcarListo(it.clave); }).then(function () { return registrar(res.duplicado ? 'duplicado' : 'registrado', it.id, resumen(it.texto) + (res.fila ? ' · fila ' + res.fila : '') + (res.sinFechaEnMensaje ? ' · sin fecha en el mensaje' : '') + tiempos(it, res, t0)); }).then(siguiente);
            }
            if (res && res.ignorado) {
              return quitar(it.id).then(function () { return marcarListo(it.clave); }).then(function () {
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

/* ---- Vigilancia: aviso por Telegram si la pestaña de WhatsApp deja de leer el grupo ----
   content.js manda un latido (sano / motivo). Si pasan MIN_SIN_LEER minutos sin un latido sano, se avisa UNA vez;
   cuando vuelve a leer, se avisa que se recuperó. El estado vive en storage porque el proceso de fondo se reinicia. */
var MIN_SIN_LEER = 15;
var MOTIVOS = {
  'otro-chat': 'WhatsApp Web está abierto en otro chat',
  'sin-mensajes': 'no detecta mensajes en el grupo (WhatsApp pudo cambiar su página)',
  'recargar': 'la extensión se actualizó y la pestaña quedó vieja: pulsar F5 en WhatsApp Web',
  '': 'no llegan señales: la pestaña de WhatsApp Web está cerrada, dormida o el PC suspendido'
};

function horaCorta(ms) { var d = new Date(ms); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

function telegram(c, texto) {
  if (!c.tgToken || !c.tgChat) return Promise.resolve(false);
  return fetch('https://api.telegram.org/bot' + c.tgToken + '/sendMessage', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: c.tgChat, text: texto })
  }).then(function (r) { return r.json(); }).then(function (j) { return !!(j && j.ok); }, function () { return false; });
}

function recibirLatido(m) {
  return chrome.storage.local.get('vigia').then(function (r) {
    var v = r.vigia || {};
    v.motivo = m.motivo || '';
    if (!m.sano) return chrome.storage.local.set({ vigia: v });
    v.ultimoSano = Date.now();
    if (!v.alertado) return chrome.storage.local.set({ vigia: v });
    return leerCfg().then(function (c) {
      return telegram(c, '✅ Varados: la extensión volvió a leer el grupo «' + c.grupo + '» (' + horaCorta(Date.now()) + ').').then(function (ok) {
        if (ok) v.alertado = false;      // si el aviso no salió, se reintenta con el siguiente latido sano
        return chrome.storage.local.set({ vigia: v });
      });
    });
  });
}

function revisarVigilancia() {
  return Promise.all([leerCfg(), chrome.storage.local.get('vigia')]).then(function (x) {
    var c = x[0], v = x[1].vigia || {};
    if (c.modo !== 'real' || !c.tgToken || !c.tgChat) return;
    if (!v.ultimoSano) { v.ultimoSano = Date.now(); return chrome.storage.local.set({ vigia: v }); }   // recién instalada: empieza a contar
    if (v.alertado || Date.now() - v.ultimoSano < MIN_SIN_LEER * 60000) return;
    var texto = '⚠ Varados: la extensión NO está leyendo el grupo «' + c.grupo + '» desde las ' + horaCorta(v.ultimoSano) +
      '.\nMotivo: ' + (MOTIVOS[v.motivo] || MOTIVOS['']) + '.\nLos reportes de ese tiempo se registrarán solos cuando vuelva a leer.';
    return telegram(c, texto).then(function (ok) { if (ok) { v.alertado = true; return chrome.storage.local.set({ vigia: v }); } });
  });
}

chrome.runtime.onMessage.addListener(function (m, _sender, responder) {
  if (m && m.tipo === 'latido') {
    recibirLatido(m).then(function () { responder({ ok: true }); }, function () { responder({ ok: false }); });
    return true;
  }
  if (m && m.tipo === 'probarTelegram') {
    leerCfg().then(function (c) { return telegram(c, '🔔 Prueba de la extensión de Varados: los avisos por Telegram funcionan.'); })
      .then(function (ok) { responder({ ok: ok }); });
    return true;
  }
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

chrome.alarms.onAlarm.addListener(function (a) { if (a.name === 'vaciar') { vaciarCola(); revisarVigilancia(); } });
chrome.runtime.onInstalled.addListener(function () { chrome.alarms.create('vaciar', { periodInMinutes: 1 }); });
chrome.runtime.onStartup.addListener(function () { chrome.alarms.create('vaciar', { periodInMinutes: 1 }); vaciarCola(); });
