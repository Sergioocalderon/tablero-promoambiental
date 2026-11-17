/* Lee el grupo de WhatsApp Web que está abierto y manda cada reporte nuevo al proceso de fondo.
   Solo mira la pestaña donde corre (no abre chats, no escribe ni envía mensajes en WhatsApp). */
(function () {
  'use strict';

  var CFG = { grupo: 'Mantenimiento Promo', modo: 'simulacro', horasAtras: 24 };
  var vistos = {};          // data-id de los mensajes ya revisados
  var vistosAlArrancar = {};
  var stats = { detectados: 0, reportes: 0, enviados: 0, viejos: 0, fallos: 0, recargar: false, estado: 'iniciando' };
  var contados = {};        // ids ya contados como reporte (para no contar el mismo cada vez que se revisa)
  var INTERVALO_MS = 4000;
  var ocupado = false;

  function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  function esperar(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---- ¿Está abierto el grupo correcto? ---- */
  function chatCorrecto() {
    // Normal: el encabezado del chat abierto es #main header. Respaldo: cualquier <header> de la página
    // (el panel izquierdo de chats no trae el nombre del grupo, así que no genera falsos positivos).
    var hs = document.querySelectorAll('#main header');
    if (!hs.length) hs = document.querySelectorAll('header');
    var buscado = norm(CFG.grupo);
    for (var k = 0; k < hs.length; k++) {
      var h = hs[k], candidatos = [], t = h.querySelectorAll('span[title]');
      for (var i = 0; i < t.length; i++) candidatos.push(t[i].getAttribute('title') || t[i].textContent);
      candidatos.push(String(h.innerText || '').split('\n')[0]);
      if (candidatos.some(function (c) { return norm(c).indexOf(buscado) >= 0; })) return true;
    }
    return false;
  }

  /* ---- Mensajes ---- */
  function raiz() { return document.querySelector('#main') || document; }

  function nodosMensaje() {
    var r = raiz().querySelectorAll('[data-id]'), out = [];
    for (var i = 0; i < r.length; i++) if (/^(true|false)_/.test(r[i].getAttribute('data-id') || '')) out.push(r[i]);
    if (out.length) return out;
    // Respaldo: si WhatsApp cambió el data-id, se usan los bloques de texto que traen "[hora, fecha] autor:"
    var p = raiz().querySelectorAll('[data-pre-plain-text]');
    for (var j = 0; j < p.length; j++) out.push(p[j]);
    // Solo vale si esos bloques realmente traen texto; si no, se pasa al siguiente método
    if (out.some(function (x) { return textoDe(x); })) return out;
    out = [];
    // Segundo respaldo: filas de la conversación (solo dentro del chat abierto; así no se mezclan con la lista de chats)
    var m = document.querySelector('#main');
    if (m) { var f = m.querySelectorAll('[role="row"]'); for (var k = 0; k < f.length; k++) out.push(f[k]); }
    return out;
  }

  // Identificador estable del mensaje: su data-id o, en los métodos de respaldo, autor+hora+inicio del texto
  function idDe(n) {
    var id = n.getAttribute('data-id');
    if (id) return id;
    return 'pp:' + (n.getAttribute('data-pre-plain-text') || '') + norm(textoDe(n)).slice(0, 160);
  }

  function diagnostico() {
    function q(s) { try { return document.querySelectorAll(s).length; } catch (e) { return -1; } }
    var h = document.querySelector('#main header span[title]');
    return 'chat «' + (h ? (h.getAttribute('title') || h.textContent) : '?') + '» · data-id ' + q('[data-id]') + ' · hora-autor ' + q('[data-pre-plain-text]') + ' · texto ' + q('span.selectable-text') +
      ' · filas-del-chat ' + q('#main [role="row"]') + ' · mensajes-in/out ' + q('#main .message-in, #main .message-out') + ' · dir ' + q('#main span[dir]');
  }

  // Texto del mensaje con sus saltos de línea. Evita contar dos veces los spans anidados.
  function textoDe(nodo) {
    var spans = nodo.querySelectorAll('span.selectable-text'), partes = [];
    for (var i = 0; i < spans.length; i++) {
      var p = spans[i].parentElement;
      if (p && p.closest && p.closest('.selectable-text')) continue;
      partes.push(spans[i].innerText || spans[i].textContent);
    }
    // Respaldo: si la fila no trae el marcado conocido, se usa todo su texto visible
    if (!partes.length && nodo.getAttribute('role') === 'row') partes.push(nodo.innerText || nodo.textContent);
    return partes.join('\n').replace(/\r/g, '').replace(/ /g, ' ').trim();
  }

  function pareceReporte(t) {
    return /(Interno:|Unidad\s+\d+)/i.test(t) && /(Fecha y Hora:|Novedad:|Solicita\s+Asistencia|Requiere\s+Asistencia)/i.test(t);
  }

  // "Fecha y Hora: mar, 10/11/2026 · 04:31:38" -> Date (hora del equipo)
  function fechaReporte(t) {
    var m = String(t).match(/Fecha y Hora:[^\n]*?(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})[^\d\n]*(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
    if (!m) return null;
    var y = +m[3]; if (y < 100) y += 2000;
    return new Date(y, +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0));
  }

  function esViejo(f) { return (Date.now() - f.getTime()) > CFG.horasAtras * 3600000; }

  // Si la extensión se recargó o actualizó, esta pestaña queda con código viejo desconectado ("context invalidated"):
  // lee, pero ya no puede entregar nada. Se avisa en pantalla para que se recargue la pestaña (F5).
  function fallo(msg) {
    stats.fallos++;
    if (/context invalidated|Extension context|Receiving end does not exist/i.test(String(msg))) stats.recargar = true;
  }

  function enviar(id, texto) {
    return new Promise(function (resolver) {
      try {
        chrome.runtime.sendMessage({ tipo: 'reporte', id: id, texto: texto }, function (resp) {
          var le = chrome.runtime && chrome.runtime.lastError;
          if (le) { fallo(le.message); resolver(false); return; }
          if (!(resp && resp.ok)) fallo('sin respuesta');
          resolver(!!(resp && resp.ok));
        });
      } catch (e) { fallo(e && e.message); resolver(false); }
    });
  }

  /* ---- Una pasada sobre lo que hay en pantalla ----
     inicial = true durante la puesta al día: allí solo se aceptan reportes con fecha propia y reciente,
     para no registrar historial viejo ni mensajes sin fecha. */
  function escanear(inicial) {
    if (!chatCorrecto()) { stats.estado = 'otro-chat'; pintar(); return Promise.resolve(0); }
    stats.estado = ocupadoCatchup ? 'poniendose-al-dia' : 'leyendo';
    var nodos = nodosMensaje(), nuevos = [];
    stats.detectados = nodos.length;
    nodos.forEach(function (n) {
      var id = idDe(n);
      if (vistos[id]) return;
      var t = textoDe(n);
      if (!t) return;                                   // todavía no se pintó el texto: se reintenta
      if (!pareceReporte(t)) { vistos[id] = 1; return; }
      if (!contados[id]) { contados[id] = 1; stats.reportes++; }
      var f = fechaReporte(t);
      if ((f && esViejo(f)) || (!f && inicial)) { vistos[id] = 1; stats.viejos++; return; }
      nuevos.push({ id: id, texto: t });
    });
    var cadena = Promise.resolve(0);
    nuevos.forEach(function (it) {
      cadena = cadena.then(function (n) {
        return enviar(it.id, it.texto).then(function (ok) { if (ok) { vistos[it.id] = 1; stats.enviados++; return n + 1; } return n; });
      });
    });
    return cadena.then(function (n) { guardarVistos(); pintar(); return n; });
  }

  /* ---- Puesta al día: sube por el chat para leer lo que llegó con el PC apagado ---- */
  var ocupadoCatchup = false;

  function contenedorScroll() {
    var n = nodosMensaje()[0], p = n && n.parentElement;
    while (p && p !== document.body) {
      var cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight) return p;
      p = p.parentElement;
    }
    return null;
  }

  function conocidosVisibles() {
    return nodosMensaje().filter(function (n) { return vistosAlArrancar[idDe(n)]; }).length;
  }

  function ponerseAlDia() {
    var primeraVez = Object.keys(vistosAlArrancar).length === 0;
    var maxVueltas = primeraVez ? 8 : 25;
    ocupadoCatchup = true;
    var c = contenedorScroll();
    if (!c) { ocupadoCatchup = false; return Promise.resolve(); }
    var previo = 0, i = 0;
    function vuelta() {
      if (i++ >= maxVueltas || !chatCorrecto()) return Promise.resolve();
      c.scrollTop = 0;
      return esperar(1300).then(function () { return escanear(true); }).then(function () {
        var n = nodosMensaje().length;
        if (n === previo) return;                        // ya no carga más: llegó al principio
        previo = n;
        if (!primeraVez && conocidosVisibles() > 0) return;   // ya apareció lo que se leyó la vez anterior
        return vuelta();
      });
    }
    return vuelta().then(function () { c.scrollTop = c.scrollHeight; ocupadoCatchup = false; });
  }

  /* ---- Persistencia ---- */
  var pendienteGuardar = false;
  function guardarVistos() {
    if (pendienteGuardar) return;
    pendienteGuardar = true;
    setTimeout(function () {
      pendienteGuardar = false;
      try { chrome.storage.local.set({ vistos: Object.keys(vistos).slice(-4000) }); } catch (e) { /* sin storage */ }
    }, 1500);
  }

  /* ---- Aviso en pantalla ---- */
  function pintar() {
    var d = document.getElementById('__varados_banner');
    if (!d) {
      d = document.createElement('div');
      d.id = '__varados_banner';
      d.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99999;padding:6px 10px;border-radius:8px;font:12px/1.3 system-ui,sans-serif;color:#fff;pointer-events:none;max-width:560px;opacity:.92';
      document.body.appendChild(d);
    }
    var modo = CFG.modo === 'real' ? 'REAL' : 'SIMULACRO (no envía)';
    if (stats.recargar) {
      d.style.background = '#b91c1c';
      d.textContent = '⚠ La extensión se actualizó o recargó: pulse F5 en esta pestaña para que vuelva a enviar. Nada se está registrando.';
    } else if (stats.estado === 'otro-chat') {
      d.style.background = '#b45309';
      d.textContent = '📋 Abra el grupo «' + CFG.grupo + '» para leer los reportes';
    } else {
      d.style.background = CFG.modo === 'real' ? '#166534' : '#475569';
      d.textContent = '📋 Varados · ' + modo + ' · mensajes ' + stats.detectados + ' · reportes ' + stats.reportes + ' · enviados ' + stats.enviados + (stats.viejos ? ' · antiguos omitidos ' + stats.viejos : '') + (stats.fallos ? ' · envíos fallidos ' + stats.fallos : '');
      // Sin mensajes: se muestra qué encuentra la página, para ajustar el lector sin abrir herramientas de desarrollo
      if (!stats.detectados) {
        d.style.background = '#9f1239';
        d.textContent += ' — SIN MENSAJES. Diagnóstico: ' + diagnostico() + (stats.estado === 'iniciando' ? ' (buscando el grupo, espere 1 minuto)' : '');
      }
    }
  }

  /* ---- Arranque ---- */
  function ciclo() {
    observarChat();                       // si WhatsApp reemplazó el panel del chat, se vuelve a enganchar el observador
    if (ocupado || ocupadoCatchup) return;
    ocupado = true;
    escanear(false).then(function () { ocupado = false; }, function () { ocupado = false; });
  }

  /* ---- Reacción inmediata a los mensajes nuevos ----
     El temporizador de 4 s se frena mucho cuando la pestaña está oculta o tapada por otra ventana (Chrome la deja en una
     pasada por minuto tras unos minutos). Un MutationObserver no depende de temporizadores: se dispara cuando WhatsApp
     pinta el mensaje, aunque la pestaña no esté a la vista. El temporizador queda como respaldo. */
  var observador = null, observado = null, ultimoEscaneoMs = 0, escaneoPendiente = false;
  var ESPACIO_ENTRE_ESCANEOS_MS = 500;

  function alCambiarElChat() {
    var ahora = Date.now();
    if (ahora - ultimoEscaneoMs >= ESPACIO_ENTRE_ESCANEOS_MS) { ultimoEscaneoMs = ahora; ciclo(); return; }   // primer cambio: de inmediato
    if (escaneoPendiente) return;                                                                          // el resto de la ráfaga: una pasada al final
    escaneoPendiente = true;
    setTimeout(function () { escaneoPendiente = false; ultimoEscaneoMs = Date.now(); ciclo(); }, ESPACIO_ENTRE_ESCANEOS_MS);
  }

  function observarChat() {
    var main = document.querySelector('#main');
    if (!main || main === observado) return;
    if (observador) observador.disconnect();
    observador = new MutationObserver(alCambiarElChat);
    observador.observe(main, { childList: true, subtree: true });
    observado = main;
  }

  function iniciar() {
    chrome.storage.local.get(['cfg', 'vistos']).then(function (r) {
      Object.assign(CFG, r.cfg || {});
      (r.vistos || []).forEach(function (id) { vistos[id] = 1; vistosAlArrancar[id] = 1; });
      chrome.storage.onChanged.addListener(function (cambios) { if (cambios.cfg) Object.assign(CFG, cambios.cfg.newValue || {}); });
      // WhatsApp tarda en pintar el chat: se espera a que aparezca el grupo antes de ponerse al día
      var intentos = 0;
      (function esperarGrupo() {
        if (chatCorrecto() && nodosMensaje().length) { ponerseAlDia().then(function () { observarChat(); setInterval(ciclo, INTERVALO_MS); }); return; }
        if (intentos++ < 60) setTimeout(esperarGrupo, 1000); else setInterval(ciclo, INTERVALO_MS);
        pintar();
      })();
    });
  }

  document.addEventListener('visibilitychange', function () { if (!document.hidden) ciclo(); });   // al volver a la pestaña, se lee de inmediato

  if (window.__PRUEBA__) {
    window.__wa = { escanear: escanear, textoDe: textoDe, pareceReporte: pareceReporte, fechaReporte: fechaReporte, chatCorrecto: chatCorrecto,
      stats: stats, vistos: vistos, CFG: CFG, nodosMensaje: nodosMensaje, ponerseAlDia: ponerseAlDia, vistosAlArrancar: vistosAlArrancar, observarChat: observarChat };
  } else {
    iniciar();
  }
})();
