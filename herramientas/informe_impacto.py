"""
Informe corto para gerencia: impacto de las alertas de regeneración DPF y evolución de varados -> PDF en Descargas.
SOLO LECTURA (Geotab y Excel).

1) DPF: episodios de lámpara del filtro (DiagnosticDieselParticulateFilterLampId) de los vehículos de la regla
   "Regeneración Manual Inactiva y Lámpara DPF Encendida - C", antes y después de --corte (inicio de los avisos).
   La comparación justa usa los MISMOS vehículos en los dos periodos y excluye --excluir (encendidos cortos que
   distorsionan, p. ej. 1802-GVU037).
2) Varados: hoja de VARADOS del Excel "Base online - Interfaz de Telemetría": por mes, varados/día, minutos hasta la
   atención y hasta el cierre, % de atención telefónica y casos de testigo DPF/regeneración.

Uso (desde herramientas/):
    python informe_impacto.py
    python informe_impacto.py --excel "C:\\ruta\\Base online.xlsm" --hoja "VARADOS (2)"
"""
import argparse
import re
import sys
import warnings
from datetime import datetime, timedelta, timezone

import pandas as pd
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

import geotab_comun as gc

warnings.filterwarnings('ignore')
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

REGLA_ALCANCE = 'Regeneración Manual Inactiva y Lámpara DPF Encendida - C'
ID_LAMPARA, ID_INTERRUPTOR = 'DiagnosticDieselParticulateFilterLampId', 'aXfHYX0HFtUaOOr_scNuSsg'
MIN_EPISODIO_S = 300            # lámparas de menos de 5 min no cuentan
VENTANA_MANUAL_ANTES_S = 1800   # el interruptor puede pulsarse hasta 30 min antes de que Geotab registre la lámpara
TZ = 'America/Bogota'


def episodios_lampara(api, desde, hasta):
    regla, _ = gc.buscar_regla(api, REGLA_ALCANCE, reglas=api.get('Rule'))
    gpi, padre, _ = gc.obtener_arbol_grupos(api)
    veh = {d['id']: d['name'] for d in gc.resolver_vehiculos_en_alcance(api.get('Device'), regla, gpi, padre)}

    def bajar(diag):
        out, t = {}, desde
        while t < hasta:
            t2 = min(t + timedelta(days=7), hasta)
            r = api.get('StatusData', search={'diagnosticSearch': {'id': diag}, 'fromDate': t.isoformat(), 'toDate': t2.isoformat()}, resultsLimit=50000)
            assert len(r) < 50000, f'{diag} llegó al tope de 50.000 filas en {t:%d/%m}: bajar el bloque de días'
            for x in r:
                v = gc.obtener_id(x['device'])
                if v in veh:
                    out.setdefault(v, []).append((x['dateTime'].timestamp(), x['data']))
            t = t2
        return out

    lam, sw = bajar(ID_LAMPARA), bajar(ID_INTERRUPTOR)
    ep = []
    for v, pts in lam.items():
        pts.sort(); on = None
        for t, x in pts:
            if x >= 1 and on is None:
                on = t
            elif x < 1 and on is not None:
                if t - on >= MIN_EPISODIO_S:
                    manual = any(on - VENTANA_MANUAL_ANTES_S <= ts <= t and val >= 1 for ts, val in sw.get(v, []))
                    ep.append({'veh': veh[v], 'on': on, 'h': (t - on) / 3600, 'manual': manual})
                on = None
    e = pd.DataFrame(ep)
    e['on'] = pd.to_datetime(e['on'], unit='s', utc=True).dt.tz_convert(TZ)
    return e, len(veh)


def minutos(s):
    m = re.search(r'(\d{1,2}):(\d{2})(?::\d{2})?$', str(s).strip())
    return int(m[1]) * 60 + int(m[2]) if m else None


def resumen_varados(ruta, hoja):
    d = pd.read_excel(ruta, sheet_name=hoja, engine='openpyxl', dtype={'FECHA': object})
    d['_f'] = pd.to_datetime(d['FECHA'], errors='coerce', dayfirst=True)
    sin_fecha = int(d['_f'].isna().sum()); d = d[d['_f'].notna()].copy()
    rep, ini, fin = (d[c].map(minutos) for c in ('HORA REPORTE', 'HORA INICIO', 'HORA FIN'))
    dif = lambda a, b: (b - a).where(b - a >= 0, b - a + 1440)   # cruza la medianoche
    d['t_ini'] = dif(rep, ini).where(lambda x: x <= 720); d['t_fin'] = dif(rep, fin).where(lambda x: x <= 1440)
    txt = d[['DESCRIPCIÓN DEL CONDUCTOR', 'FALLA', 'DESCRIPCION DE LA FALLA', 'COMPONENTE']].fillna('').astype(str).agg(' '.join, axis=1).str.upper()
    d['dpf'] = txt.str.contains(r'DPF|REGENER|FILTRO DE PART|PARTICUL|HOLL[IÍ]N')
    d['mes'] = d['_f'].dt.strftime('%Y-%m')
    dias = d.groupby('mes')['_f'].agg(lambda s: (s.max() - s.min()).days + 1)
    m = d.groupby('mes').agg(varados=('MOVIL', 'size'), t_ini=('t_ini', 'median'), t_fin=('t_fin', 'median'),
                             tel=('TIPO DE ATENCIÓN', lambda s: (s.astype(str).str.upper().str.strip() == 'TELEFONICA').mean()), dpf=('dpf', 'sum'))
    m['por_dia'] = m['varados'] / dias
    ult = d[d['_f'] >= d['_f'].max() - pd.Timedelta(days=29)]
    return m.reset_index(), ult['SISTEMA'].value_counts().head(6), d['_f'].min(), d['_f'].max(), sin_fecha


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--desde', default='2026-08-01')
    ap.add_argument('--corte', default='2026-10-05', help='Inicio de los avisos de regeneración al conductor')
    ap.add_argument('--excluir', default='1802-GVU037')
    ap.add_argument('--excel', default=r'C:\Users\sergio.calderon\Downloads\Base online - Interfaz de Telemetría (8).xlsm')
    ap.add_argument('--hoja', default='VARADOS (2)')
    args = ap.parse_args()

    api = gc.conectar_geotab()
    hasta = datetime.now(timezone.utc)
    e, n_alcance = episodios_lampara(api, datetime.fromisoformat(args.desde).replace(tzinfo=timezone.utc), hasta)
    corte = pd.Timestamp(args.corte, tz=TZ)
    e['despues'] = e['on'] >= corte
    ambos = (set(e[~e.despues].veh) & set(e[e.despues].veh)) - {args.excluir}
    m = e[e.veh.isin(ambos)]
    met = lambda s: {'p90': s['h'].quantile(.9), 'mas4': (s['h'] > 4).mean(), 'manual': s['manual'].mean()}
    a, dsp = met(m[~m.despues]), met(m[m.despues])
    dias_a, dias_d = (corte - e['on'].min()).days, (e['on'].max() - corte).days + 1
    hs_a, hs_d = e[~e.despues]['h'].sum() / dias_a * 7, e[e.despues]['h'].sum() / dias_d * 7
    veh_a, veh_d = e[~e.despues].veh.nunique(), e[e.despues].veh.nunique()
    mens, top, f_min, f_max, sin_fecha = resumen_varados(args.excel, args.hoja)
    print(f'DPF: {len(e)} episodios, {len(ambos)} vehículos comparables | Varados: {f_min:%d/%m}–{f_max:%d/%m/%Y}, {sin_fecha} filas sin fecha')

    # ---------------- PDF ----------------
    AZUL, GRIS = colors.HexColor('#1F3B5B'), colors.HexColor('#F2F4F7')
    st = getSampleStyleSheet()
    H1 = ParagraphStyle('h1', parent=st['Title'], fontSize=17, textColor=AZUL, spaceAfter=2)
    SUB = ParagraphStyle('sub', parent=st['Normal'], fontSize=9, textColor=colors.HexColor('#555555'), spaceAfter=10)
    H2 = ParagraphStyle('h2', parent=st['Heading2'], fontSize=12.5, textColor=AZUL, spaceBefore=10, spaceAfter=5)
    P = ParagraphStyle('p', parent=st['Normal'], fontSize=9.5, leading=13)
    NOTA = ParagraphStyle('nota', parent=P, fontSize=8, leading=10.5, textColor=colors.HexColor('#555555'))
    CEL = ParagraphStyle('cel', parent=P, fontSize=9, leading=11)
    HDR = ParagraphStyle('hdr', parent=CEL, textColor=colors.white, fontName='Helvetica-Bold')
    pct = lambda x: f'{x * 100:.0f} %'
    num = lambda x, dec=1: f'{x:.{dec}f}'.replace('.', ',')
    MES = {'01': 'Ene', '02': 'Feb', '03': 'Mar', '04': 'Abr', '05': 'May', '06': 'Jun', '07': 'Jul', '08': 'Ago', '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dic'}

    def tabla(filas, anchos):
        t = Table([[Paragraph(str(c), HDR if i == 0 else CEL) for c in f] for i, f in enumerate(filas)], colWidths=[w * cm for w in anchos])
        t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, 0), AZUL), ('GRID', (0, 0), (-1, -1), 0.4, colors.HexColor('#C9CED6')),
                               ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, GRIS])]))
        return t

    pd_ini, pd_fin = mens['por_dia'].iloc[0], mens['por_dia'].iloc[-1]
    mes_ini, mes_fin = MES[mens['mes'].iloc[0][5:]], MES[mens['mes'].iloc[-1][5:]]
    dpf_desde_corte = int(mens[mens['mes'] >= f'{corte:%Y-%m}']['dpf'].sum())
    h = [Paragraph('Impacto de la telemetría: regeneración DPF y varados', H1),
         Paragraph(f'Promoambiental · Datos de Geotab ({args.desde[8:]}/{args.desde[5:7]} – {hasta:%d/%m/%Y}) y hoja VARADOS ({f_min:%d/%m} – {f_max:%d/%m/%Y})', SUB),
         Paragraph('Resumen', H2)]
    for b in [
        f'<b>Las lámparas DPF se atienden más rápido desde que existen los avisos</b> ({corte:%d/%m}): los episodios de lámpara de más de 4 horas '
        f'pasaron de <b>{pct(a["mas4"])} a {pct(dsp["mas4"])}</b> y el uso de la regeneración manual de <b>{pct(a["manual"])} a {pct(dsp["manual"])}</b>.',
        f'Horas con la lámpara encendida en toda la flota: <b>{num(hs_a, 0)} → {num(hs_d, 0)} por semana</b> (vehículos que reportan lámpara: {veh_a} → {veh_d}).',
        f'Varados: <b>{num(pd_ini)} → {num(pd_fin)} por día</b> entre {mes_ini} y {mes_fin} ({"−" if pd_fin < pd_ini else "+"}{pct(abs(1 - pd_fin / pd_ini))}). '
        f'Varados por testigo DPF/regeneración desde {corte:%d/%m}: {dpf_desde_corte}.',
    ]:
        h += [Paragraph('• ' + b, P), Spacer(1, 3)]

    h += [Paragraph('1. Regeneración del filtro DPF', H2),
          Paragraph('Cuando el filtro de partículas se llena se enciende una lámpara en el tablero y el conductor debe dejar que regenere (o activarla a mano). '
                    'Si se ignora, el filtro se satura y el vehículo termina en taller.', P), Spacer(1, 5),
          tabla([['Indicador', f'Antes (hasta {corte - pd.Timedelta(days=1):%d/%m})', f'Después (desde {corte:%d/%m})'],
                 ['Episodios de lámpara de más de 4 h', pct(a['mas4']), pct(dsp['mas4'])],
                 ['Duración del 10 % de episodios más largos (p90)', num(a['p90']) + ' h', num(dsp['p90']) + ' h'],
                 ['Episodios resueltos con regeneración manual', pct(a['manual']), pct(dsp['manual'])],
                 ['Horas de lámpara encendida por semana (toda la flota)', num(hs_a, 0) + ' h', num(hs_d, 0) + ' h'],
                 ['Vehículos que reportaron lámpara', str(veh_a), str(veh_d)]], [8.6, 4.3, 4.3]),
          Spacer(1, 4),
          Paragraph(f'Las tres primeras filas comparan los mismos {len(ambos)} vehículos en los dos periodos, sin {args.excluir}. '
                    f'De los {n_alcance} vehículos de la regla, solo {e.veh.nunique()} reportan la lámpara DPF.', NOTA)]

    filas = [['Mes', 'Varados', 'Por día', 'Min. hasta la atención (mediana)', 'Min. hasta el cierre (mediana)', 'Atención telefónica']]
    for _, r in mens.iterrows():
        filas.append([MES[r['mes'][5:]], str(r['varados']), num(r['por_dia']), f"{r['t_ini']:.0f}", f"{r['t_fin']:.0f}", pct(r['tel'])])
    h += [Paragraph('2. Varados', H2), tabla(filas, [1.6, 1.9, 1.7, 4.2, 4.2, 3.0]), Spacer(1, 4),
          Paragraph(f'Último mes hasta el {f_max:%d/%m}. Sistemas con más varados en los últimos 30 días: '
                    + ', '.join(f'{k.capitalize()} ({n})' for k, n in top.items()) + f'. Filas sin fecha válida excluidas: {sin_fecha}.', NOTA)]

    h.append(Paragraph('3. Cómo leer estos números', H2))
    for b in ['La mejora en DPF se puede atribuir a los avisos: coincide con su inicio y se mantiene al comparar los mismos vehículos.',
              'La variación de varados no se puede atribuir solo a la telemetría: también influyen mantenimiento, renovación de flota y operación.',
              'El registro de varados desde WhatsApp mejora la completitud de la hoja; no cambia cuántos varados hay.']:
        h += [Paragraph('• ' + b, P), Spacer(1, 2)]

    salida = rf'C:\Users\sergio.calderon\Downloads\Informe_impacto_telemetria_{hasta:%Y-%m-%d}.pdf'

    def pie(c, doc):
        c.saveState(); c.setFont('Helvetica', 7.5); c.setFillColor(colors.HexColor('#777777'))
        c.drawString(1.8 * cm, 1.1 * cm, f'Fuente: Geotab (lámpara DPF e interruptor de regeneración manual) y hoja VARADOS. Generado {datetime.now():%d/%m/%Y}.')
        c.drawRightString(letter[0] - 1.8 * cm, 1.1 * cm, f'Página {doc.page}'); c.restoreState()

    SimpleDocTemplate(salida, pagesize=letter, leftMargin=1.8 * cm, rightMargin=1.8 * cm, topMargin=1.6 * cm, bottomMargin=1.8 * cm,
                      title='Impacto de la telemetría').build(h, onFirstPage=pie, onLaterPages=pie)
    print('PDF:', salida)


if __name__ == '__main__':
    main()
