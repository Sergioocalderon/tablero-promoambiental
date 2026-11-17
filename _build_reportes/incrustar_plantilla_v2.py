"""Incrusta reporte_plantilla_v2.html dentro de mantenimiento.js COMPRIMIDA (zlib + base64, en líneas cortas).
Motivo: MyGeotab limita el tamaño de lo que se guarda del add-in; la plantilla en texto (313 KB, en una sola línea) hacía el .js de ~400 KB y no dejaba guardarlo.
El navegador la descomprime con DecompressionStream al generar el reporte (obtenerPlantilla en mantenimiento.js).

Uso:  python -X utf8 incrustar_plantilla_v2.py     (desde esta carpeta)
"""
import base64
import zlib

INI = '  // ==== PLANTILLA_COMPRIMIDA (generado por incrustar_plantilla_v2.py: no editar a mano) ===='
FIN = '  // ==== FIN PLANTILLA_COMPRIMIDA ===='
ANCHO = 160

crudo = open('mantenimiento.js', encoding='utf-8', newline='').read()
crlf = '\r\n' in crudo
js = crudo.replace('\r\n', '\n').split('\n')
z = base64.b64encode(zlib.compress(open('reporte_plantilla_v2.html', 'rb').read(), 9)).decode('ascii')

bloque = [INI, '  var PLANTILLA_Z = [']
bloque += ["    '" + z[i:i + ANCHO] + "'," for i in range(0, len(z), ANCHO)]
bloque += [
    '  ].join(\'\');',
    '  var plantillaPromesa = null;',
    '  function obtenerPlantilla() {',
    '    if (!plantillaPromesa) {',
    '      plantillaPromesa = Promise.resolve().then(function () {',
    "        if (typeof DecompressionStream === 'undefined') throw new Error('Este navegador no puede abrir la plantilla del reporte. Use una versión reciente de Chrome, Edge o Firefox.');",
    '        var bin = atob(PLANTILLA_Z), bytes = new Uint8Array(bin.length);',
    '        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);',
    "        return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'))).text();",
    '      }).catch(function (e) { plantillaPromesa = null; throw e; });',
    '    }',
    '    return plantillaPromesa;',
    '  }',
    FIN,
]

if INI in js:
    a, b = js.index(INI), js.index(FIN)
    js[a:b + 1] = bloque
else:
    idx = [i for i, l in enumerate(js) if l.startswith('  var PLANTILLA_HTML_EMBEBIDA = ')]
    assert len(idx) == 1, 'no se encontró la declaración de la plantilla ni el bloque comprimido'
    js[idx[0]:idx[0] + 1] = bloque

out = '\n'.join(js)
if crlf:
    out = out.replace('\n', '\r\n')
open('mantenimiento.js', 'w', encoding='utf-8', newline='').write(out)
print('Plantilla comprimida:', len(z) // 1024, 'KB; mantenimiento.js:', len(out.encode('utf-8')) // 1024, 'KB; línea más larga:', max(len(l) for l in js))
