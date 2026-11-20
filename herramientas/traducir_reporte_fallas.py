"""
Traduce el reporte HTML de fallas que genera el compañero (programa propio por API de Geotab) con el
Diccionario_Fallas.csv del proyecto, sin tocar nada más del reporte.

Por qué: Geotab nombra todos los códigos con el J1939 genérico (y el modo de falla en inglés), y algunas
marcas usan esos números con otro significado (VW Delivery: SPN 1814/FMI 5 es el intermitente, no
"VDC completamente operativo"). El taller lee el reporte y sus fichas PDF: ahí tiene que salir lo correcto.

Qué cambia (en los datos JSON incrustados; el reporte y sus fichas se arman en el navegador con ellos):
  - Diagnóstico: la descripción del diccionario para la marca del vehículo (o la genérica); si no existe,
    se deja el nombre de Geotab.
  - Descripción del modo de falla: el FMI en español (estándar J1939) en vez del texto en inglés.
Todo lo demás (conteos, criticidad, fechas, gráficas, filtros, fichas) queda igual.

Uso:
    python traducir_reporte_fallas.py "C:/.../Reporte_Fallos_X.html"      -> escribe "... (traducido).html" al lado
    python traducir_reporte_fallas.py --prueba                            -> autochequeo
"""
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from traducir_falla import cargar_diccionario, describir

FMI_ES = {
    0: 'Datos válidos pero por encima del rango normal - nivel más severo',
    1: 'Datos válidos pero por debajo del rango normal - nivel más severo',
    2: 'Datos erráticos, intermitentes o incorrectos',
    3: 'Voltaje por encima de lo normal o en corto a fuente alta',
    4: 'Voltaje por debajo de lo normal o en corto a fuente baja',
    5: 'Corriente por debajo de lo normal o circuito abierto',
    6: 'Corriente por encima de lo normal o circuito a tierra',
    7: 'Sistema mecánico no responde o fuera de ajuste',
    8: 'Frecuencia, ancho de pulso o período anormal',
    9: 'Tasa de actualización anormal',
    10: 'Tasa de cambio anormal',
    11: 'Causa raíz desconocida',
    12: 'Dispositivo o componente inteligente defectuoso',
    13: 'Fuera de calibración',
    14: 'Instrucciones especiales',
    15: 'Datos válidos pero por encima del rango normal - nivel menos severo',
    16: 'Datos válidos pero por encima del rango normal - nivel moderadamente severo',
    17: 'Datos válidos pero por debajo del rango normal - nivel menos severo',
    18: 'Datos válidos pero por debajo del rango normal - nivel moderadamente severo',
    19: 'Error en los datos de red recibidos',
    20: 'Datos desviados hacia arriba',
    21: 'Datos desviados hacia abajo',
    31: 'Condición existente',
}
# Motor por marca: el diccionario tiene filas del Cummins X12 (Foton). Igual que REFERENCIA_MOTOR_POR_MARCA del bot.
MOTOR_POR_MARCA = {'volkswagen': 'ISF 3.8', 'volskwagen': 'ISF 3.8', 'mercedes': 'OM926', 'international': 'L9', 'foton': 'X12', 'kenworth': 'ISM 11'}
RE_CODIGO = re.compile(r'SPN\s*(\d+)\s*/\s*FMI\s*(\d+)', re.I)
RE_BLOQUE = re.compile(r'(<script type="application/json" id="([^"]+)">)(.*?)(</script>)', re.S)


def _grupos(marca, modelo):
    marca, modelo = (marca or '').strip(), (modelo or '').strip()
    motor = next((v for k, v in MOTOR_POR_MARCA.items() if k in marca.lower()), '')
    return [g for g in (f'{marca} - {modelo}' if modelo else '', marca, motor) if g]


MOTOR_ECU = 'ControllerJ1939EngineNo1Id'
CARROCERIA = 'ControllerBodyControllerId'
NOTA_CARROCERIA = ' (computador de carrocería: el nombre estándar puede no aplicar en esta marca; confirmar con el escáner de la marca)'
HORAS_CONFIRMACION = 24   # mismo corte que el bot y Alertas por Severidad: "Activo" sin reporte en 24 h = por verificar


class Traductor:
    def __init__(self, dic):
        self.dic, self.cambios = dic, 0
        self.fc = {}   # FC Cummins: la numeración es la misma en todos sus motores (validado con el escáner del 1308)
        for (spn, fmi), filas in dic.items():
            for f in filas:
                for x in (f.get('Codigo_Escaner') or '').split('/'):
                    if x.strip():
                        self.fc.setdefault((spn, fmi), []).append(x.strip())

    def diagnostico(self, codigos, marca, modelo, nombre_geotab, controlador=''):
        m = RE_CODIGO.search(codigos or '')
        if not m:
            return nombre_geotab, False
        spn, fmi = int(m[1]), int(m[2])
        desc, _, fuente = describir(self.dic, spn, fmi, _grupos(marca, modelo), nombre_geotab)
        ok = fuente != 'geotab' and bool(desc)
        desc = desc if ok else nombre_geotab
        if controlador == MOTOR_ECU and (spn, fmi) in self.fc:
            desc, ok = 'FC ' + ' / '.join(dict.fromkeys(self.fc[(spn, fmi)])) + ' · ' + (desc or ''), True
        elif controlador == CARROCERIA and fuente != 'marca':
            desc, ok = (desc or '') + NOTA_CARROCERIA, True
        return desc, ok

    def fmi(self, codigos, texto):
        m = RE_CODIGO.search(codigos or '')
        return FMI_ES.get(int(m[2]), texto) if m else texto


def _fecha(texto):
    """'17/11/2026 08:53' (hora Bogotá) o ISO con zona -> datetime UTC; None si no se entiende."""
    try:
        if '/' in str(texto):
            return datetime.strptime(texto.strip(), '%d/%m/%Y %H:%M').replace(tzinfo=timezone(timedelta(hours=-5))).astimezone(timezone.utc)
        return datetime.fromisoformat(str(texto)).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def traducir_html(html, dic):
    t = Traductor(dic)
    bloques = {m[2]: json.loads(m[3]) for m in RE_BLOQUE.finditer(html)}
    rev = bloques.get('data-fault-review', {})
    revision = rev.get('rows', [])
    generado = _fecha(rev.get('generated_at'))
    modelo_de = {}            # (móvil) -> (marca, modelo), de las filas de revisión que traen el modelo
    for r in revision:
        modelo_de[str(r.get('mobile'))] = (r.get('brand'), r.get('model'))
    ds = bloques.get('data-dashboard-dataset')
    filas_ds = [r for filas in list(((ds or {}).get('scopes') or {}).values()) + [(ds or {}).get('rows') or []] for r in filas if 'codigo' in r]
    # Por (móvil, código): módulo que lo envía (va en el id de la fila), último registro y si sigue "Activo"
    info = {}
    for r in filas_ds:
        i = info.setdefault((str(r['movil']), r['codigo']), {'ctrl': '', 'ultima': None, 'activo': False})
        i['ctrl'] = i['ctrl'] or str(r.get('id', '')).split('|')[-1]
        u = _fecha(r.get('ultima'))
        if u and (i['ultima'] is None or u > i['ultima']):
            i['ultima'] = u
        i['activo'] = i['activo'] or r.get('estado') == 'Activo'
    por_codigo, por_falla = {}, {}

    def nuevo(movil, codigos, marca, nombre):
        marca2, modelo = modelo_de.get(str(movil), (marca, ''))
        ctrl = info.get((str(movil), codigos), {}).get('ctrl', '')
        desc, ok = t.diagnostico(codigos, marca2 or marca, modelo, nombre, ctrl)
        if ok and desc != nombre:
            t.cambios += 1
        por_codigo.setdefault(codigos, set()).add(desc)
        por_falla[f'{movil} · {codigos}'] = desc
        return desc

    def modo(movil, codigos, texto):
        """Modo de falla en español; si figura Activo pero no se reporta hace más de 24 h, se avisa delante."""
        out = t.fmi(codigos, texto)
        i = info.get((str(movil), codigos))
        if generado and i and i['activo'] and i['ultima'] and generado - i['ultima'] > timedelta(hours=HORAS_CONFIRMACION):
            out = f"⚠ POR VERIFICAR: sin reporte desde {i['ultima'].astimezone(timezone(timedelta(hours=-5))):%d/%m/%Y} · {out}"
        return out

    for r in revision:                                                       # fichas PDF
        r['description'] = nuevo(r['mobile'], r['codes'], r.get('brand'), r['description'])
        r['failure_description'] = modo(r['mobile'], r['codes'], r.get('failure_description'))
    for r in filas_ds:                                                       # filtros, buscador y gráficas recalculadas
        r['diagnostico'] = nuevo(r['movil'], r['codigo'], r.get('marca'), r.get('diagnostico'))
        r['descripcion'] = modo(r['movil'], r['codigo'], r.get('descripcion'))
    for clave, b in bloques.items():
        if clave.endswith('_detalle') and isinstance(b, dict) and 'columns' in b:   # tablas de detalle
            c = b['columns']
            i_mov, i_diag, i_desc, i_cod, i_marca = (c.index(x) if x in c else None for x in ('Móvil', 'Diagnóstico', 'Descripción', 'Códigos', 'Marca'))
            if None in (i_mov, i_diag, i_cod):
                continue
            for row in b['rows']:
                row[i_diag] = nuevo(row[i_mov], row[i_cod], row[i_marca] if i_marca is not None else '', row[i_diag])
                if i_desc is not None and isinstance(row[i_desc], str):
                    row[i_desc] = modo(row[i_mov], row[i_cod], row[i_desc])
    for clave, b in bloques.items():                                         # rankings por código / por falla
        if not (isinstance(b, dict) and isinstance(b.get('items'), list)):
            continue
        for it in b['items']:
            cf = str(it.get('cf_value') or '')
            desc = por_falla.get(cf)
            if desc is None and RE_CODIGO.fullmatch(cf.strip() or 'x'):
                opciones = por_codigo.get(cf, set())
                desc = next(iter(opciones)) if len(opciones) == 1 else None   # mismo código con distinto significado por marca: se deja
            if desc and ' · ' in str(it.get('name', '')):
                it['name'] = it['name'].split(' · ', 1)[0] + ' · ' + desc

    def reemplazo(m):
        b = bloques.get(m[2])
        if b is None:
            return m[0]
        return m[1] + json.dumps(b, ensure_ascii=False).replace('</', '<\\/') + m[4]

    return RE_BLOQUE.sub(reemplazo, html), t.cambios


def _prueba():
    dic = cargar_diccionario()
    html = ('<script type="application/json" id="data-fault-review">' + json.dumps({'rows': [
        {'mobile': '1308', 'plate': 'LSX408', 'brand': 'VOLSKWAGEN', 'model': 'DELIVERY 9.170', 'codes': 'SPN 1814 / FMI 5',
         'description': 'VDC completamente operativo', 'failure_description': 'Current below normal or open circuit'},
        {'mobile': '1157', 'plate': 'NWX533', 'brand': 'FOTON', 'model': 'AUMAN', 'codes': 'SPN 99999 / FMI 0',
         'description': 'Nombre Geotab', 'failure_description': 'Data valid but above normal operational range - most severe level'}]})
            + '</script>')
    out, n = traducir_html(html, dic)
    filas = json.loads(RE_BLOQUE.search(out)[3])['rows']
    assert 'ntermitente' in filas[0]['description'], filas[0]
    assert filas[0]['failure_description'] == FMI_ES[5]
    assert filas[1]['description'] == 'Nombre Geotab' and filas[1]['failure_description'] == FMI_ES[0]   # FMI 0 no se pierde
    assert n == 1
    # Caso 1308: FC Cummins en el motor, nota en carrocería sin fila de marca, y "Activo" viejo marcado
    fila = lambda cod, ctrl, ultima: {'id': f'b1|x|y|{ctrl}', 'movil': '1308', 'marca': 'VOLSKWAGEN', 'codigo': cod,
                                      'diagnostico': 'Nombre Geotab', 'descripcion': 'x', 'estado': 'Activo', 'ultima': ultima}
    ds = {'scopes': {'activos': [fila('SPN 100 / FMI 2', MOTOR_ECU, '17/11/2026 08:53'), fila('SPN 2000 / FMI 9', CARROCERIA, '17/11/2026 08:53'),
                                 fila('SPN 723 / FMI 7', MOTOR_ECU, '19/09/2026 05:37')]}}
    html = ('<script type="application/json" id="data-fault-review">' + json.dumps({'generated_at': '2026-11-17T19:20:43+00:00', 'rows': []})
            + '</script><script type="application/json" id="data-dashboard-dataset">' + json.dumps(ds) + '</script>')
    out, _ = traducir_html(html, dic)
    a, b, c = [json.loads(m[3]) for m in RE_BLOQUE.finditer(out)][1]['scopes']['activos']
    assert a['diagnostico'].startswith('FC 435 · ') and 'POR VERIFICAR' not in a['descripcion'], a
    assert b['diagnostico'].endswith(NOTA_CARROCERIA), b
    assert c['descripcion'].startswith('⚠ POR VERIFICAR: sin reporte desde 19/09/2026'), c
    print('autochequeo OK ·', filas[0]['description'][:60], '|', a['diagnostico'][:50])


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--prueba':
        _prueba()
        sys.exit()
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    origen = Path(sys.argv[1])
    salida, n = traducir_html(origen.read_text(encoding='utf-8'), cargar_diccionario())
    destino = origen.with_name(origen.stem + ' (traducido).html')
    destino.write_text(salida, encoding='utf-8')
    print(f'{n} descripciones reemplazadas con el diccionario -> {destino}')
