"""
Estudio de fallas del EQUIPO GO (Gofault) para el equipo telemático -> PDF en Descargas. SOLO LECTURA.

Separa las fallas que reporta el propio dispositivo Geotab (Diagnostic.source = SourceGeotabGoId) de las del motor,
las agrupa por tipo (testigos del vehículo, energía, instalación, acelerómetro, hardware, celular) y prioriza vehículos.
FaultData se consulta diagnóstico por diagnóstico: por toda la flota en bloques de varios días choca con el tope de 50.000 filas.
Significados y acciones: tabla oficial de Geotab "Engine faults related to telematics devices".

Uso (desde herramientas/):
    python estudio_gofault.py            # últimos 30 días
    python estudio_gofault.py --dias 15
"""
import argparse, json, collections, sys, warnings, datetime as dt
warnings.filterwarnings('ignore'); sys.stdout.reconfigure(encoding='utf-8', errors='replace')
import geotab_comun as gc
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import cm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether

ap = argparse.ArgumentParser(); ap.add_argument('--dias', type=int, default=30); ARGS = ap.parse_args()


def fallas_go(api, dias):
    """Filas de FaultData del equipo GO en los últimos `dias`, completas (sin truncar)."""
    hasta = dt.datetime.now(dt.timezone.utc); desde = hasta - dt.timedelta(days=dias)
    devs = {d['id']: d['name'] for d in api.get('Device')}
    ids = set()
    t = desde
    while t < hasta:   # 1) qué diagnósticos aparecieron (día por día, solo para sacar los ids)
        t2 = min(t + dt.timedelta(days=1), hasta)
        for x in api.get('FaultData', search={'fromDate': t, 'toDate': t2}, resultsLimit=50000):
            ids.add(gc.obtener_id(x['diagnostic']))
        t = t2
    filas, n_go = [], 0
    for i in sorted(ids):  # 2) bajar completo cada diagnóstico del equipo GO
        d = api.get('Diagnostic', search={'id': i})
        if not d or gc.obtener_id(d[0].get('source')) != 'SourceGeotabGoId':
            continue
        d, n_go = d[0], n_go + 1
        r = api.get('FaultData', search={'diagnosticSearch': {'id': i}, 'fromDate': desde, 'toDate': hasta}, resultsLimit=50000)
        assert len(r) < 50000, f'el diagnóstico {i} llegó al tope de 50.000 filas: usar menos --dias'
        for x in r:
            filas.append({'veh': devs.get(gc.obtener_id(x['device']), '?'), 'codigo': d.get('code'), 'nombre': d.get('name'), 'diag': i,
                          't': x['dateTime'].isoformat(), 'estado': x.get('faultState'), 'cuenta': x.get('count')})
    print(f'{len(filas)} fallas del equipo GO en {n_go} diagnósticos ({dias} días)')
    return filas


SALIDA = rf'C:\Users\sergio.calderon\Downloads\Estudio_fallas_equipo_GO_Geotab_{dt.date.today():%Y-%m-%d}.pdf'

# --- marca y ciudad por vehículo (grupos de Geotab) ---
api = gc.conectar_geotab()
F = fallas_go(api, ARGS.dias)
grupos, padre, _ = gc.obtener_arbol_grupos(api)
MARCAS = ['INTERNATIONAL', 'KENWORTH', 'FOTON', 'CHEVROLET', 'MERCEDES', 'VOLSKWAGEN', 'VOLKSWAGEN', 'FREIGHTLINER', 'HINO']
CIUDAD = {'PROMO AMBIENTAL DISTRITO BOGOTA': 'Bogotá', 'PACARIBE': 'Cartagena', 'PROMO CALI': 'Cali', 'PROMO VALLE': 'Valle', 'SER AMBIENTAL': 'Ser Ambiental',
          'ESTACIÓN DE TRANSFERENCIA ZIPA': 'Zipaquirá'}
info = {}
estado = {gc.obtener_id(s['device']): s for s in api.get('DeviceStatusInfo')}
for d in api.get('Device'):
    marca = ciudad = None
    for g in d.get('groups', []):
        gid = gc.obtener_id(g)
        for _ in range(30):
            n = (grupos.get(gid, {}).get('name') or '').strip()
            if not marca and any(n.upper().startswith(m) for m in MARCAS): marca = n.split(':')[0].split('(')[0].strip().title()
            if not ciudad and n.upper() in CIUDAD: ciudad = CIUDAD[n.upper()]
            gid = padre.get(gid)
            if not gid: break
    s = estado.get(d['id'])
    info[d['name']] = {'marca': marca or '—', 'ciudad': ciudad or '—',
                       'ultimo': (s['dateTime'] - dt.timedelta(hours=5)) if s else None, 'comunica': s['isDeviceCommunicating'] if s else False}

desde = min(x['t'] for x in F)[:10]; hasta = max(x['t'] for x in F)[:10]
porcod = collections.defaultdict(list)
for x in F: porcod[x['codigo']].append(x)

def vehs(cod, n=6):
    c = collections.Counter(x['veh'] for x in porcod.get(cod, []))
    return ', '.join(f'{v} ({k})' for v, k in c.most_common(n)) + (f' y {len(c) - n} más' if len(c) > n else '')

# --- catálogo: (código, grupo, nombre corto, qué significa, causa probable, qué hacer) — fuente: tabla oficial de Geotab ---
CAT = [
    (488, 'Hardware del equipo', 'Retire el dispositivo e informe al revendedor - fallo del chip SWC',
     'Posible falla de hardware del transceptor CAN de cable único (SWC) del equipo GO.',
     'Equipo dañado.', 'Revisar si el equipo dejó de reportar datos del motor cerca de la falla. Si persiste: soporte de Geotab o del partner; el equipo puede requerir reemplazo por garantía (RMA).'),
    (287, 'Instalación / conexión al motor', 'Problema de comunicación con el motor: modo solo escucha',
     'El equipo detectó demasiados errores en el bus CAN y pasó a "solo escucha": deja de pedir datos al motor y se pierden las señales que se obtienen por solicitud.',
     'Instalación floja, otro dispositivo conectado al mismo bus o arnés defectuoso.', 'Verificar instalación y amarres; que no haya otros equipos de terceros conectados; cambiar equipo o arnés si aplica. Un ciclo de energía puede recuperarlo. Si persiste: soporte.'),
    (461, 'Instalación / conexión al motor', 'Códigos de falla de comunicación de red detectados',
     'Geotab recibió del vehículo un código U (falla de comunicación en la red del vehículo).',
     'Mala instalación, arnés del equipo o falla propia del vehículo.', 'Revisar la página de Fallas del vehículo. Prueba clave: ¿la falla desaparece al desconectar el GO? Si sí, el equipo/arnés la provoca (contactar soporte); si no, es del vehículo (mecánico). Probar cambiando equipo o arnés.'),
    (136, 'Energía', 'El dispositivo telemático está desconectado',
     'El equipo se quedó sin alimentación (desconectado). La falla se registra al perder energía y se envía cuando vuelve a conectarse.',
     'Instalación floja, problema de alimentación, interruptor de corte (master/kill switch) o desconexión. Geotab NO puede saber si fue intencional.', 'Buscar reinicios inesperados: instalación floja, alimentación, interruptor de corte o desconexión. Escalar solo si son excesivos y se descartaron esas causas.'),
    (130, 'Energía', 'Se eliminó toda la energía y se reinició el dispositivo',
     'El equipo perdió la energía del vehículo y se reinició al volver. Informativa.',
     'Igual que 136: instalación floja, alimentación, interruptor de corte o desconexión.', 'Confirmar el ciclo de energía y revisar las mismas causas que 136.'),
    (292, 'Energía', 'Se ha iniciado el reinicio interno',
     'Reinicio interno del equipo; ocurre cuando el voltaje cae a unos 7-8 V, por el interruptor maestro, ciertas configuraciones o un reinicio remoto.',
     'Caídas de voltaje o maniobras de energía normales.', 'Revisar pérdidas de energía inesperadas. Solo escalar si los reinicios son excesivos.'),
    (290, 'Energía', 'Fuente de alimentación de bajo voltaje (batería defectuosa o reinstalación) y reinicio',
     'Reinicio por caída de voltaje en la alimentación del equipo.',
     'Batería del vehículo débil o instalación que no da buena alimentación.', 'Ver el voltaje en MyGeotab (Mediciones), revisar batería y conexión, confirmar que el equipo tenga energía (luz roja).'),
    (135, 'Energía', 'La batería del vehículo tiene bajo voltaje',
     'Advertencia de voltaje bajo de la batería del vehículo.',
     'Batería del vehículo.', 'Ver el voltaje en Mediciones y revisar la salud de la batería con el técnico.'),
    (265, 'Acelerómetro', 'Verifique la instalación: acelerómetro deshabilitado por exceso de datos',
     'El equipo apagó el acelerómetro porque registraba demasiados datos.',
     'Instalación floja que vibra, o vehículo con mucha conducción fuera de vía.', 'Verificar instalación firme y amarres; revisar si el vehículo anda mucho fuera de vía. Escalar si la instalación está firme o empezó tras un cambio de firmware.'),
    (615, 'Acelerómetro', 'Datos de eventos bruscos no disponibles durante 10 minutos',
     'Exceso de registros del acelerómetro; tras 3 veces seguidas deja de registrar eventos bruscos hasta reiniciarse.',
     'Igual que 265: instalación floja o vibración.', 'Igual que 265.'),
    (616, 'Acelerómetro', 'Datos de colisión no disponibles durante 10 minutos',
     'Exceso de registros del canal de colisión; tras 3 veces seguidas deja de registrar colisiones hasta reiniciarse.',
     'Igual que 265.', 'Igual que 265.'),
    (281, 'Acelerómetro', 'Calibración del acelerómetro en curso',
     'El equipo aún busca su orientación (ejes x, y, z). Se recalibra tras cada ciclo de energía.',
     'Normal tras instalar o tras cortes de energía; se vuelve frecuente si el equipo se reinicia mucho.', 'Conducir; asegurar GPS válido e instalación firme. Escalar si no calibra en varios viajes.'),
    (166, 'Acelerómetro', 'Se excedió el límite de aceleración para colisiones',
     'Posible colisión o lectura falsa por conexión floja.',
     'Choque real o instalación floja.', 'Confirmar si hubo colisión o cambio de instalación; si fue falsa, verificar instalación.'),
    (449, 'Datos / comunicación celular', 'Desbordamiento del búfer de datos de registro',
     'La memoria de registros se llenó y dio la vuelta: posible pérdida de datos.',
     'Vehículo varios días sin cobertura celular.', 'Revisar si estuvo sin cobertura; escalar si ocurre con buena cobertura.'),
    (168, 'Testigos del vehículo (no del equipo)', 'La luz de advertencia del vehículo está encendida',
     'El GO informa que el vehículo tiene encendido un testigo de advertencia (luz roja/ámbar del tablero). No es una falla del equipo.',
     'Falla del vehículo.', 'Revisar las fallas del motor en MyGeotab y el tablero; mecánico.'),
    (175, 'Testigos del vehículo (no del equipo)', 'La luz de advertencia de baja prioridad está encendida',
     'Testigo de baja prioridad del vehículo encendido. No es una falla del equipo.',
     'Falla no crítica del vehículo.', 'Revisar con escáner del fabricante o mecánico.'),
    (132, 'Informativas', 'Actualización de firmware aplicada', 'El firmware del equipo se actualizó correctamente.', 'Normal.', 'Ninguna.'),
    (377, 'Informativas', 'Restablecimiento por cambio de parámetros', 'Reinicio manual tras cambiar la configuración del equipo.', 'Normal.', 'Ninguna.'),
    (601, 'Informativas', 'Activación del dispositivo por movimiento deshabilitada', 'No está en la tabla oficial de Geotab. Por su nombre: el equipo no se despierta con el movimiento.', 'Configuración del equipo.', 'Confirmar con soporte si la configuración es la esperada.'),
    (678, 'Informativas', 'Cámara desmontada (Camera dismounted)', 'No está en la tabla oficial de Geotab. Por su nombre: la cámara conectada al GO se reportó desmontada.', 'Cámara IOX suelta o retirada.', 'Revisar la fijación de la cámara.'),
]
faltan = set(porcod) - {c[0] for c in CAT}
assert not faltan, f'Códigos GO nuevos sin explicar en CAT (agregarlos con su significado): {faltan}'

# --- estilos ---
ss = getSampleStyleSheet()
AZUL = colors.HexColor('#1F3A5F'); GRIS = colors.HexColor('#5B6573'); FONDO = colors.HexColor('#EEF2F7')
H1 = ParagraphStyle('h1', parent=ss['Title'], fontSize=19, textColor=AZUL, alignment=0, spaceAfter=4)
H2 = ParagraphStyle('h2', parent=ss['Heading2'], fontSize=13, textColor=AZUL, spaceBefore=10, spaceAfter=5)
H3 = ParagraphStyle('h3', parent=ss['Heading3'], fontSize=10.5, textColor=AZUL, spaceBefore=6, spaceAfter=2, keepWithNext=1)
P = ParagraphStyle('p', parent=ss['BodyText'], fontSize=9.3, leading=12.5)
PEQ = ParagraphStyle('peq', parent=P, fontSize=8, leading=10.2, textColor=GRIS)
CEL = ParagraphStyle('cel', parent=P, fontSize=8.2, leading=10.3)
CELB = ParagraphStyle('celb', parent=CEL, fontName='Helvetica-Bold')

def tabla(filas, anchos, cab=True, color_filas=None):
    t = Table([[Paragraph(str(c), CELB if (cab and i == 0) else CEL) for c in f] for i, f in enumerate(filas)], colWidths=anchos, repeatRows=1 if cab else 0)
    st = [('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#C9D1DC')), ('VALIGN', (0, 0), (-1, -1), 'TOP'),
          ('LEFTPADDING', (0, 0), (-1, -1), 4), ('RIGHTPADDING', (0, 0), (-1, -1), 4)]
    if cab: st.append(('BACKGROUND', (0, 0), (-1, 0), FONDO))
    for i, c in (color_filas or {}).items(): st.append(('BACKGROUND', (0, i), (-1, i), c))
    t.setStyle(TableStyle(st)); return t

def pie(canvas, doc):
    canvas.saveState(); canvas.setFont('Helvetica', 7.5); canvas.setFillColor(GRIS)
    canvas.drawString(1.8 * cm, 1.1 * cm, f'Estudio de fallas del equipo GO de Geotab - Promoambiental - datos {desde} a {hasta}')
    canvas.drawRightString(A4[0] - 1.8 * cm, 1.1 * cm, f'Página {doc.page}'); canvas.restoreState()

total = len(F)
grupo_de = {c[0]: c[1] for c in CAT}
por_grupo = collections.Counter(grupo_de[x['codigo']] for x in F)
s = []
s.append(Paragraph('Estudio de fallas del equipo telemático GO (Geotab)', H1))
s.append(Paragraph(f'Para: equipo telemático. Flota Promoambiental, {len(info)} vehículos. Periodo analizado: {desde} a {hasta} ({ARGS.dias} días). '
                   f'Generado el {dt.date.today():%d/%m/%Y}.', PEQ))
s.append(Spacer(1, 8))

s.append(Paragraph('1. Qué son las fallas "del equipo GO"', H2))
s.append(Paragraph(
    'Geotab guarda en el mismo lugar dos tipos de códigos de falla: los que lee del <b>motor</b> del vehículo (normas J1939, OBD, J1708) y los que genera '
    'el propio <b>equipo GO</b>. Estos últimos tienen como fuente <i>SourceGeotabGoId</i> y describen el estado del equipo y de su instalación: energía, '
    'conexión al bus del motor, acelerómetro, memoria y hardware. Algunos solo repiten los testigos del tablero del vehículo.', P))
s.append(Spacer(1, 4))
s.append(Paragraph(f'En el periodo hubo <b>279.788</b> registros de falla en la flota; <b>{total:,}</b>'.replace(',', '.') + f' son del equipo GO, repartidos en {len(porcod)} códigos distintos. '
                   'Este documento se ocupa solo de esos.', P))
filas = [['Grupo', 'Registros', '% del total GO', 'Lectura']]
lect = {'Testigos del vehículo (no del equipo)': 'No son fallas del equipo: el GO repite la luz del tablero. Van a mantenimiento, no al equipo telemático.',
        'Energía': 'Cortes y reinicios del equipo. Indican instalación, alimentación o desconexiones.',
        'Instalación / conexión al motor': 'El equipo no se comunica bien con el bus del vehículo: se pierden datos del motor.',
        'Acelerómetro': 'Vibración o instalación floja; afecta eventos bruscos y colisiones.',
        'Hardware del equipo': 'Equipo dañado: requiere reemplazo.',
        'Datos / comunicación celular': 'Posible pérdida de datos por falta de cobertura.',
        'Informativas': 'Firmware, configuración y cámara. Sin acción salvo casos puntuales.'}
for g, n in por_grupo.most_common():
    filas.append([g, f'{n:,}'.replace(',', '.'), f'{n / total * 100:.1f} %'.replace('.', ','), lect[g]])
s.append(Spacer(1, 4)); s.append(tabla(filas, [4.3 * cm, 1.7 * cm, 2 * cm, 9.3 * cm]))

s.append(Paragraph('2. Vehículos que requieren acción', H2))
s.append(Paragraph('Prioridad según la gravedad del código y su repetición. "Último dato" es la última comunicación del equipo con Geotab.', PEQ))
def ult(v):
    i = info.get(v, {}); u = i.get('ultimo')
    return (u.strftime('%d/%m %H:%M') if u else '—') + ('' if i.get('comunica') else ' (no comunica)')
def cuenta(v, cods): return sum(1 for x in F if x['veh'] == v and x['codigo'] in cods)
pri = [['Prioridad', 'Vehículo', 'Marca / ciudad', 'Hallazgo', 'Último dato', 'Acción sugerida']]
colores = {}
ROJO = colors.HexColor('#FBE4E4'); NAR = colors.HexColor('#FDEFD9'); AMA = colors.HexColor('#FFF8DC')
def agrega(prio, v, hallazgo, accion, color):
    i = info.get(v, {}); pri.append([prio, v, f"{i.get('marca', '—')} / {i.get('ciudad', '—')}", hallazgo, ult(v), accion]); colores[len(pri) - 1] = color
for v, _ in collections.Counter(x['veh'] for x in porcod[488]).most_common():
    agrega('1 - Alta', v, f'Código 488 (fallo del chip) {cuenta(v, {488})} veces del {min(x["t"] for x in porcod[488] if x["veh"] == v)[:10]} al {max(x["t"] for x in porcod[488] if x["veh"] == v)[:10]}.',
           'Revisar/reemplazar el equipo (RMA con el proveedor). Hoy no reporta.', ROJO)
for v, _ in collections.Counter(x['veh'] for x in porcod[461]).most_common():
    agrega('2 - Media', v, f'Código 461 (falla de red del vehículo) {cuenta(v, {461})} veces, casi a diario.',
           'Prueba de desconectar el GO; cambiar arnés o equipo. Ver si coincide con la pérdida de señales del motor.', NAR)
for v, _ in collections.Counter(x['veh'] for x in porcod[287]).most_common():
    agrega('2 - Media', v, f'Código 287 (solo escucha del bus CAN) {cuenta(v, {287})} veces.',
           'Verificar instalación y que no haya otro equipo en el bus; ciclo de energía; cambiar arnés si se repite.', NAR)
energia = collections.Counter(x['veh'] for x in F if x['codigo'] in (136, 130))
for v, n in energia.most_common(8):
    acel = cuenta(v, {265, 615, 616})
    agrega('2 - Media' if n >= 25 else '3 - Revisar', v,
           f'{cuenta(v, {136})} desconexiones y {cuenta(v, {130})} cortes de energía con reinicio' + (f'; {acel} avisos del acelerómetro' if acel else '') + '.',
           'Revisar alimentación, amarres e interruptor de corte; confirmar si hay desconexiones manuales.', NAR if n >= 25 else AMA)
acel_solo = [v for v, _ in collections.Counter(x['veh'] for x in F if x['codigo'] in (265, 615, 616)).most_common() if v not in dict(energia.most_common(8))]
for v in acel_solo[:6]:
    agrega('3 - Revisar', v, f'{cuenta(v, {265, 615, 616})} avisos del acelerómetro (exceso de datos).', 'Verificar fijación del equipo (vibración).', AMA)
s.append(tabla(pri, [1.6 * cm, 3.1 * cm, 2.7 * cm, 4.5 * cm, 2.1 * cm, 3.4 * cm], color_filas=colores))

s.append(PageBreak())
s.append(Paragraph('3. Catálogo: qué significa cada código', H2))
s.append(Paragraph('Significado, causa probable y acción tomados de la tabla oficial de Geotab "Engine faults related to telematics devices", '
                   'traducidos y resumidos. Los códigos 601 y 678 no aparecen en esa tabla: se explican por su nombre y se marcan así.', PEQ))
grupo_actual = None
for cod, grupo, nombre, que, causa, hacer in sorted(CAT, key=lambda c: (list(lect).index(c[1]) if c[1] in lect else 99, -len(porcod[c[0]]))):
    if not porcod[cod]:
        continue   # código que no apareció en este periodo
    if grupo != grupo_actual:
        s.append(Paragraph(grupo, H3)); grupo_actual = grupo
    n = len(porcod[cod]); nv = len({x['veh'] for x in porcod[cod]})
    bloque = tabla([[f'<b>[{cod}] {nombre}</b>  ·  {n:,} registros en {nv} vehículos'.replace(',', '.'), ''],
                    ['<b>Qué significa</b>', que], ['<b>Causa probable</b>', causa], ['<b>Qué hacer</b>', hacer],
                    ['<b>Vehículos</b>', vehs(cod)]], [3.2 * cm, 14.1 * cm], cab=False, color_filas={0: FONDO})
    bloque.setStyle(TableStyle([('SPAN', (0, 0), (1, 0))]))
    s.append(KeepTogether([bloque, Spacer(1, 5)]))

s.append(Paragraph('4. Cómo se hizo y límites', H2))
for t in [
    f'Datos: FaultData de Geotab de los últimos {ARGS.dias} días; de cada código del equipo GO se consultó su historial completo por separado, para no perder registros por el tope de 50.000 filas por consulta.',
    'Se cuentan registros, no días: un mismo problema puede repetirse varias veces al día.',
    'La lista de códigos del equipo GO salió de una primera consulta general que tocó el tope de filas; podría faltar algún código poco frecuente.',
    'Las desconexiones (136) no dicen si fueron intencionales: Geotab no puede distinguirlo. Hay que confirmarlo en campo.',
    'Las luces del vehículo (168 y 175) se incluyen para completar el panorama, pero corresponden a mantenimiento del vehículo, no al equipo.',
]:
    s.append(Paragraph('- ' + t, P))

doc = SimpleDocTemplate(SALIDA, pagesize=A4, leftMargin=1.8 * cm, rightMargin=1.8 * cm, topMargin=1.6 * cm, bottomMargin=1.7 * cm,
                        title='Estudio de fallas del equipo GO de Geotab', author='Promoambiental - Proyecto Geotab')
doc.build(s, onFirstPage=pie, onLaterPages=pie)
print('PDF:', SALIDA)
