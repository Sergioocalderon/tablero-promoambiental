'use strict';
var BASE = { url: '', token: '', grupo: 'Mantenimiento Promo', modo: 'simulacro', horasAtras: 24, tgToken: '', tgChat: '' };
function $(id) { return document.getElementById(id); }
function decir(texto, clase) { var m = $('msg'); m.textContent = texto; m.className = clase || ''; }

// Los campos se llenan UNA sola vez (al abrir) y tras Guardar. El refresco periódico solo actualiza cola y movimientos:
// antes también reescribía los campos y borraba lo que la persona estaba escribiendo.
function cargarCampos() {
  chrome.storage.local.get('cfg').then(function (r) {
    var c = Object.assign({}, BASE, r.cfg || {});
    $('url').value = c.url; $('token').value = c.token; $('grupo').value = c.grupo; $('modo').value = c.modo; $('horas').value = c.horasAtras;
    $('tgToken').value = c.tgToken; $('tgChat').value = c.tgChat;
  });
}

function cargar() {
  chrome.storage.local.get(['cola', 'registro']).then(function (r) {
    $('ncola').textContent = (r.cola || []).length;
    var tb = document.querySelector('#reg tbody'); tb.innerHTML = '';
    (r.registro || []).slice(0, 60).forEach(function (x) {
      var tr = document.createElement('tr');
      var clase = /registrado|duplicado/.test(x.estado) ? 'ok' : (/error|revisar/.test(x.estado) ? 'mal' : 'aviso');
      [new Date(x.ts).toLocaleString('es-CO'), x.estado, x.detalle || ''].forEach(function (t, i) {
        var td = document.createElement('td'); td.textContent = t; if (i === 1) td.className = clase; tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
  });
}

$('guardar').onclick = function () {
  var url = $('url').value.trim();
  if (url && !/^https:\/\/script\.google\.com\/macros\/s\/[^\s]+\/exec$/.test(url)) { decir('La URL debe empezar por https://script.google.com/macros/s/ y terminar en /exec', 'mal'); return; }
  chrome.storage.local.set({ cfg: { url: url, token: $('token').value.trim(), grupo: $('grupo').value.trim() || BASE.grupo, modo: $('modo').value, horasAtras: Math.max(1, Number($('horas').value) || 24),
    tgToken: $('tgToken').value.trim(), tgChat: $('tgChat').value.trim() } })
    .then(function () { decir('Guardado.', 'ok'); cargarCampos(); cargar(); });
};

$('probar').onclick = function () {
  var url = $('url').value.trim();
  if (!url) { decir('Escriba primero la URL.', 'mal'); return; }
  decir('Probando…');
  fetch(url).then(function (r) { return r.text(); }).then(function (t) {
    if (/Receptor de reportes activo/.test(t)) decir('Conexión correcta: el receptor responde.', 'ok');
    else decir('La URL responde, pero no es el receptor (¿se publicó como aplicación web con acceso a "Cualquier persona"?).', 'mal');
  }).catch(function (e) { decir('No se pudo conectar: ' + e.message, 'mal'); });
};

$('probarTg').onclick = function () {
  decir('Enviando prueba… (use Guardar antes si cambió el token o el chat)');
  chrome.runtime.sendMessage({ tipo: 'probarTelegram' }, function (r) {
    if (r && r.ok) decir('Aviso de prueba enviado: revise Telegram.', 'ok'); else decir('No se pudo enviar: revise el token y el chat ID (y que estén guardados).', 'mal');
  });
};

$('vaciar').onclick =function () { chrome.runtime.sendMessage({ tipo: 'vaciar' }, function () { decir('Cola enviada.', 'ok'); setTimeout(cargar, 800); }); };
cargarCampos();
cargar();
setInterval(cargar, 5000);
