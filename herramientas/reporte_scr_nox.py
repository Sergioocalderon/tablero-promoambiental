"""
reporte_scr_nox.py -- estado del sistema SCR / NOx por vehiculo, en un HTML
autocontenido (doble clic para abrir)
============================================================================

Mide si el catalizador SCR esta limpiando el NOx del escape y si los sensores
y la dosificacion de urea (DEF) estan sanos. Metodo validado con el usuario
el 2026-10-05/06:

  Eficiencia SCR (%) = (NOx entrada - NOx salida) / NOx entrada x 100

  1. Se emparejan las lecturas de entrada y salida de NOx (<= 60 s) y la
     temperatura de SALIDA del SCR (<= 120 s). La temperatura de ENTRADA del
     SCR llega siempre en 0 en International/Kenworth -- solo sirve en Foton.
  2. Solo cuentan las lecturas "validas":
       - entrada entre 50 y 3000 ppm  (-200 = sensor calentando; 3012,75 = tope)
       - salida > -200                (negativos pequenos = ruido -> 0)
       - SCR >= 250 C                 (en frio el catalizador no convierte, por
                                       diseno; sin este filtro salen falsos malos)
  3. Por vehiculo: eficiencia MEDIANA y % de lecturas validas por debajo de 80 %.
  4. Fallas del sistema (sensores NOx, dosificacion de DEF, induccion del
     operador, calidad/nivel de DEF) en el periodo -- en el 1087-GVT367 la senal
     util fueron esas fallas, no la eficiencia.

OJO: en los International Geotab guarda el NOx solo cada ~30 min; por eso el
reporte es de periodo (por defecto 7 dias), no de tiempo real.

Niveles de medicion (2026-10-06, pedido del usuario: toda la flota en
seguimiento, dejando claro que se mide completo y que es parcial):
  - COMPLETO: envia los sensores de NOx -> eficiencia + fallas + DEF.
  - PARCIAL: tiene SCR (envia nivel de DEF, temperatura del SCR o tuvo fallas
    del sistema) pero NO envia los sensores de NOx -> solo fallas, DEF y
    temperatura; sin eficiencia. Hoy: Mercedes Atego, Chevrolet NHR, Kenworth
    T380 de Ser Ambiental, 1307/1308.
  - NO MEDIBLE: no envia ninguna senal del SCR (confirmar en ficha tecnica si
    lo tiene) o el GPS no esta comunicando. Se lista igual, con el motivo, para
    que ningun vehiculo quede invisible.

Linea base por vehiculo: cada corrida guarda su resultado en
reportes/historico_scr_nox.csv (una fila por vehiculo y fecha de corte). La
linea base es la mediana de las corridas anteriores de ese vehiculo; una caida
>= CAIDA_ALERTA_PP puntos se marca en amarillo aunque siga "bien" frente a la
flota (un catalizador se degrada de a poco).

Uso:
    python reporte_scr_nox.py                 # ultimos 7 dias, toda la flota
    python reporte_scr_nox.py --dias 14
    python reporte_scr_nox.py --ciudad Bogotá
    python reporte_scr_nox.py --telegram      # ademas manda resumen + HTML al bot
    python reporte_scr_nox.py --semanal --telegram
        # lo que corre alertas-telegram.yml cada 5 min: solo genera si ya es
        # lunes >= 07:00 (Bogota) y esta semana todavia no se mando; si no,
        # sale enseguida sin conectarse a Geotab.

Salida:
    reportes/estado_scr_nox.html  (+ copia en Descargas)
    reportes/historico_scr_nox.csv
    reportes/estado_envio_scr_nox.json  (solo --semanal: ultima semana enviada)
"""
import argparse
import html
import json
import os
import pathlib
import re
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import pandas as pd
import requests
from dotenv import load_dotenv

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
import geotab_comun as gc  # noqa: E402

ID_NOX_ENTRADA = 'a711Snkq7uUiCvzA2uVX-VQ'   # "Ingesta de NOx" (ppm)
ID_NOX_SALIDA = 'aUjE9RmcGKUaGJOB-Fv2wLA'    # "Salida NOx" (ppm)
ID_TEMP_SALIDA_SCR = 'ao4dEeskEskqN5QDjfLkcxw'  # "Postratamiento 1 Temperatura del gas de salida del catalizador SCR"
ID_NIVEL_DEF = 'DiagnosticDieselExhaustFluidId'  # "Nivel de DEF" (%)
ID_TEMP_TANQUE_DEF = 'a_EUvYP1K4kGWomA68ZBh_g'  # "Temperatura del tanque de DEF" -- prueba que hay SCR (TUCAN66 solo envia esta)
DIAS_BUSQUEDA_SENALES = 30  # antes de declarar "no medible", buscar senales del SCR en este tramo

NOX_ENTRADA_MIN, NOX_ENTRADA_MAX = 50, 3000
NOX_NO_LISTO = -199
TOLERANCIA_PAR = pd.Timedelta('60s')
TOLERANCIA_TEMP = pd.Timedelta('120s')
MIN_LECTURAS_VALIDAS = 20
UMBRAL_LECTURA_BAJA = 80        # % -- una lectura por debajo cuenta como "baja"
CAIDA_ALERTA_PP = 3             # puntos de caida vs. la linea base del propio vehiculo
NIVEL_DEF_BAJO = 15             # %
HORAS_FALLA_RECIENTE = 48
HORAS_SIN_COMUNICAR = 48        # GPS sin reportar mas de esto -> "no medible: GPS sin comunicar"

NIVELES = {
    'completo': ('Medición completa',
                 'Envía los sensores de NOx de entrada y salida. Se mide la eficiencia del SCR, '
                 'la salud de los sensores, las fallas del sistema y el nivel de DEF.'),
    'parcial': ('Medición parcial',
                'Tiene SCR (envía nivel o temperatura de DEF, temperatura del SCR o tuvo fallas del sistema), pero NO envía '
                'los sensores de NOx. Se vigilan las fallas del sistema SCR/DEF, el nivel de DEF y la temperatura '
                'del SCR cuando la envía. NO se puede calcular la eficiencia.'),
    'no_medible': ('No medible',
                   'No envía ninguna señal del SCR, o el GPS no está comunicando. No se puede evaluar; '
                   'se lista con el motivo para resolverlo.'),
}

# Parametros por marca. Arrancan iguales para todas (pedido del usuario: empezar
# con un umbral general y afinar por marca con 4-6 semanas de historico). Para
# ajustar una marca, agregar su clave (nombre del grupo de marca, en minusculas).
PARAMETROS_DEFECTO = {'temp_min_scr': 250, 'amarillo': 90, 'rojo': 80, 'pct_bajas_amarillo': 20}
PARAMETROS_POR_MARCA = {
    # 'kenworth - t380': {'amarillo': 92},
}

# Fallas que pertenecen al sistema SCR/NOx/DEF (por nombre del diagnostico).
# Deliberadamente NO incluye DPF/hollin -- eso es regeneracion, otro reporte.
PATRON_FALLA_SCR = re.compile(
    r'nox|l[ií]quido de escape di[eé]sel|\bdef\b|\bscr\b|inducci[oó]n|reductor|urea|dosific', re.I)

PATRON_MARCA = re.compile(r'^(international|foton|kenworth|freightliner|chevrolet|volks|mercedes|hino)', re.I)
TZ_LOCAL = timezone(timedelta(hours=-5))

CARPETA_REPO = pathlib.Path(__file__).resolve().parent.parent
RUTA_HTML = CARPETA_REPO / 'reportes' / 'estado_scr_nox.html'
RUTA_HTML_DESCARGAS = pathlib.Path.home() / 'Downloads' / 'estado_scr_nox.html'
RUTA_HISTORICO = CARPETA_REPO / 'reportes' / 'historico_scr_nox.csv'
RUTA_ESTADO_ENVIO = CARPETA_REPO / 'reportes' / 'estado_envio_scr_nox.json'
RUTA_ESTADO_TELEGRAM = CARPETA_REPO / 'telegram_estado.json'  # de ahi salen los suscriptores (/start)
DIA_ENVIO_SEMANAL, HORA_ENVIO_SEMANAL = 0, 7  # lunes 07:00 hora Bogota


def parametros(marca):
    return {**PARAMETROS_DEFECTO, **PARAMETROS_POR_MARCA.get((marca or '').lower(), {})}


# ---------------------------------------------------------------------------
# Descarga
# ---------------------------------------------------------------------------

def bajar_statusdata(api, diag_id, desde, hasta):
    """Toda la flota, dia por dia (un dia de NOx son ~2 000 filas; el tope es 50 000)."""
    filas = []
    cursor = desde
    while cursor < hasta:
        fin = min(cursor + timedelta(days=1), hasta)
        lect = api.get('StatusData', search={'diagnosticSearch': {'id': diag_id}, 'fromDate': cursor, 'toDate': fin})
        if len(lect) >= 50000:
            raise RuntimeError(f'StatusData {diag_id} llego al tope en {cursor:%Y-%m-%d}; reducir la ventana')
        filas += [(gc.obtener_id(l['device']), l['dateTime'], l['data']) for l in lect]
        cursor = fin
    df = pd.DataFrame(filas, columns=['veh', 't', 'v'])
    df['t'] = pd.to_datetime(df['t'], utc=True)
    return df.sort_values('t')


def bajar_fallas(api, desde, hasta):
    """FaultData de toda la flota en tramos que se parten solos si llegan al tope."""
    salida = []
    tramos = [(desde, hasta)]
    while tramos:
        a, b = tramos.pop()
        lote = api.get('FaultData', search={'fromDate': a, 'toDate': b}, resultsLimit=50000)
        if len(lote) >= 50000:
            medio = a + (b - a) / 2
            tramos += [(a, medio), (medio, b)]
            continue
        salida += lote
        time.sleep(0.5)
    return salida


# ---------------------------------------------------------------------------
# Calculo
# ---------------------------------------------------------------------------

def resolver_grupos(device, grupos_por_id, padre_de, raiz_hijos):
    marca, ciudad = set(), None
    for g in device.get('groups') or []:
        gid = gc.obtener_id(g)
        while gid:
            nombre = ((grupos_por_id.get(gid) or {}).get('name') or '').strip()
            if PATRON_MARCA.search(nombre):
                marca.add(nombre)
            if gid in raiz_hijos and nombre.lower() not in gc.GRUPOS_RAIZ_NO_CIUDAD and not ciudad:
                ciudad = nombre
            gid = padre_de.get(gid)
    return (' / '.join(sorted(marca)) or 'Sin marca'), (ciudad or 'Sin ciudad')


def eficiencia_vehiculo(din, dout, dtemp, temp_min):
    """Devuelve dict con eficiencia y salud de sensores para un vehiculo."""
    r = {'n_entrada': len(din), 'n_salida': len(dout)}
    r['pct_entrada_no_lista'] = round((din.v <= NOX_NO_LISTO).mean() * 100) if len(din) else None
    r['pct_entrada_tope'] = round((din.v >= NOX_ENTRADA_MAX).mean() * 100) if len(din) else None
    if din.empty or dout.empty:
        r['pares_validos'] = 0
        return r
    m = pd.merge_asof(din.rename(columns={'v': 'nin'}), dout[['t', 'v']].rename(columns={'v': 'nout'}),
                      on='t', direction='nearest', tolerance=TOLERANCIA_PAR)
    if dtemp.empty:
        m['temp'] = float('nan')
    else:
        m = pd.merge_asof(m, dtemp[['t', 'v']].rename(columns={'v': 'temp'}),
                          on='t', direction='nearest', tolerance=TOLERANCIA_TEMP)
    m = m.dropna(subset=['nout'])
    val = m[(m.nin > NOX_ENTRADA_MIN) & (m.nin < NOX_ENTRADA_MAX) & (m.nout > NOX_NO_LISTO) & (m.temp >= temp_min)]
    r['pares_validos'] = len(val)
    r['pct_scr_caliente'] = round((m.temp >= temp_min).mean() * 100) if len(m) else None
    if len(val):
        efi = (val.nin - val.nout.clip(lower=0)) / val.nin * 100
        r['eficiencia'] = round(float(efi.median()), 1)
        r['pct_bajas'] = round(float((efi < UMBRAL_LECTURA_BAJA).mean() * 100))
        r['nox_entrada_med'] = round(float(val.nin.median()))
        r['nox_salida_med'] = round(float(val.nout.clip(lower=0).median()), 1)
        r['temp_scr_med'] = round(float(val.temp.median()))
        r['salida_mayor_entrada'] = int((val.nout > val.nin).sum())
        # serie diaria para el mini-grafico
        val = val.assign(dia=val.t.dt.tz_convert(TZ_LOCAL).dt.strftime('%m-%d'), efi=efi)
        r['diaria'] = {d: round(float(x.median()), 1) for d, x in val.groupby('dia').efi}
    return r


def clasificar(r, p):
    """Semaforo + motivos. Orden: rojo > amarillo > gris (sin datos) > verde."""
    rojo, amarillo = [], []
    if r['n_entrada'] == 0 and r['n_salida'] > 0:
        rojo.append('No llega el sensor de NOx de entrada')
    if r['n_salida'] == 0 and r['n_entrada'] > 0:
        rojo.append('No llega el sensor de NOx de salida')
    if r.get('fallas_recientes'):
        rojo.append(f"Falla del sistema en las últimas {HORAS_FALLA_RECIENTE} h")
    efi = r.get('eficiencia')
    suficiente = r.get('pares_validos', 0) >= MIN_LECTURAS_VALIDAS
    if efi is not None and suficiente:
        if efi < p['rojo']:
            rojo.append(f"Eficiencia {efi} % < {p['rojo']} %")
        elif efi < p['amarillo']:
            amarillo.append(f"Eficiencia {efi} % < {p['amarillo']} %")
        if r.get('pct_bajas', 0) >= p['pct_bajas_amarillo']:
            amarillo.append(f"{r['pct_bajas']} % de lecturas por debajo de {UMBRAL_LECTURA_BAJA} %")
        if r.get('caida') is not None and r['caida'] >= CAIDA_ALERTA_PP:
            amarillo.append(f"Bajó {r['caida']} pts frente a su línea base")
    if r.get('fallas_periodo') and not r.get('fallas_recientes'):
        amarillo.append('Fallas del sistema en el período')
    if (r.get('pct_entrada_tope') or 0) >= 10:
        amarillo.append(f"Sensor de entrada saturado en {r['pct_entrada_tope']} % de lecturas")
    if r.get('def_min') is not None and r['def_min'] < NIVEL_DEF_BAJO:
        amarillo.append(f"Nivel de DEF bajó a {r['def_min']:.0f} %")
    if rojo:
        return 'rojo', rojo + amarillo
    if amarillo:
        return 'amarillo', amarillo
    if not suficiente:
        return 'gris', [f"Solo {r.get('pares_validos', 0)} lecturas válidas con SCR caliente (mínimo {MIN_LECTURAS_VALIDAS})"]
    return 'verde', []


def clasificar_parcial(r):
    """Sin eficiencia: solo fallas del sistema y nivel de DEF."""
    rojo, amarillo = [], []
    if r.get('fallas_recientes'):
        rojo.append(f"Falla del sistema en las últimas {HORAS_FALLA_RECIENTE} h")
    elif r.get('fallas_periodo'):
        amarillo.append('Fallas del sistema en el período')
    if r.get('def_min') is not None and r['def_min'] < NIVEL_DEF_BAJO:
        amarillo.append(f"Nivel de DEF bajó a {r['def_min']:.0f} %")
    if r.get('sin_senales_periodo'):
        amarillo.append(f"No envió señales del SCR en el período (sí en los {DIAS_BUSQUEDA_SENALES} días anteriores): "
                        "revisar la conexión del GPS al motor")
    if rojo:
        return 'rojo', rojo + amarillo
    if amarillo:
        return 'amarillo', amarillo
    return 'verde', ['Sin fallas del sistema SCR/DEF en el período']


def actualizar_historico(filas, fecha_corte):
    nuevas = pd.DataFrame([{'fecha_corte': fecha_corte, 'vehiculo': f['vehiculo'], 'marca': f['marca'], 'nivel': f['nivel'],
                            'eficiencia': f.get('eficiencia'), 'pct_bajas': f.get('pct_bajas'),
                            'pares_validos': f.get('pares_validos'), 'estado': f['estado']} for f in filas])
    if RUTA_HISTORICO.exists():
        hist = pd.read_csv(RUTA_HISTORICO, encoding='utf-8-sig')
        hist = hist[hist.fecha_corte != fecha_corte]   # re-correr el mismo dia reemplaza, no duplica
    else:
        hist = pd.DataFrame(columns=nuevas.columns)
    previas = hist
    base = (previas[previas.pares_validos >= MIN_LECTURAS_VALIDAS]
            .groupby('vehiculo').eficiencia.agg(['median', 'count']))
    RUTA_HISTORICO.parent.mkdir(parents=True, exist_ok=True)
    pd.concat([hist, nuevas], ignore_index=True).to_csv(RUTA_HISTORICO, index=False, encoding='utf-8-sig')
    return base


# ---------------------------------------------------------------------------
# HTML
# ---------------------------------------------------------------------------

ETIQUETA = {'rojo': 'Revisar', 'amarillo': 'Vigilar', 'verde': 'Bien', 'gris': 'Sin datos'}
ETIQUETA_PARCIAL = {'rojo': 'Revisar', 'amarillo': 'Vigilar', 'verde': 'Sin fallas'}
ORDEN = {'rojo': 0, 'amarillo': 1, 'gris': 2, 'verde': 3}


def fmt(v, suf=''):
    return '—' if v is None or (isinstance(v, float) and pd.isna(v)) else f'{v}{suf}'


def mini_barras(diaria, p):
    if not diaria:
        return ''
    barras = []
    for dia, v in diaria.items():
        alto = max(4, min(100, (v - 50) * 2)) if v >= 50 else 4
        clase = 'rojo' if v < p['rojo'] else 'amarillo' if v < p['amarillo'] else 'verde'
        barras.append(f'<span class="b {clase}" style="height:{alto:.0f}%" title="{dia}: {v} %"></span>')
    return f'<div class="spark">{"".join(barras)}</div>'


def _atributos_fila(f):
    texto = (f['vehiculo'] + ' ' + f['marca'] + ' ' + f['ciudad']).lower()
    return f'class="filtrable" data-estado="{f["estado"]}" data-texto="{html.escape(texto)}"'


def _celda_vehiculo(f):
    return (f'<td class="veh">{html.escape(f["vehiculo"])}'
            f'<div class="sub">{html.escape(f["marca"])} · {html.escape(f["ciudad"])}</div></td>')


def _celda_motivos(f):
    motivos = ''.join(f'<li>{html.escape(m)}</li>' for m in f['motivos'])
    fallas = ''.join(f'<li>{html.escape(x)}</li>' for x in f.get('fallas_resumen', []))
    return f'<td><ul class="motivos">{motivos}</ul>{"<ul class=fallas>" + fallas + "</ul>" if fallas else ""}</td>'


def _chips(si, no=()):
    return ''.join(f'<span class="chip si">✓ {html.escape(x)}</span>' for x in si) + \
        ''.join(f'<span class="chip no">✗ {html.escape(x)}</span>' for x in no)


def generar_html(filas, fallas_detalle, resumen_marca, meta):
    por_nivel = {n: [f for f in filas if f['nivel'] == n] for n in NIVELES}
    conteo = {k: sum(1 for f in filas if f['nivel'] != 'no_medible' and f['estado'] == k) for k in ORDEN}

    def desglose(nivel):
        fs = por_nivel[nivel]
        if nivel == 'no_medible':
            return ''
        partes = [(k, sum(1 for f in fs if f['estado'] == k)) for k in ('rojo', 'amarillo', 'verde', 'gris')]
        return ' '.join(f'<span class="pill {k}">{n} {(ETIQUETA_PARCIAL if nivel == "parcial" else ETIQUETA).get(k, ETIQUETA[k])}</span>'
                        for k, n in partes if n)

    cobertura_html = ''.join(f"""
<a class="cob {n}" href="#sec-{n}"><div class="n">{len(por_nivel[n])}</div><div class="t">{NIVELES[n][0]}</div>
<div class="d">{html.escape(NIVELES[n][1])}</div><div class="des">{desglose(n)}</div></a>""" for n in NIVELES)

    # --- 1. completo
    filas_c = []
    for f in sorted(por_nivel['completo'], key=lambda f: (ORDEN[f['estado']], f.get('eficiencia') or 999)):
        p = parametros(f['marca'])
        filas_c.append(f"""
<tr {_atributos_fila(f)}>
  <td><span class="pill {f['estado']}">{ETIQUETA[f['estado']]}</span></td>
  {_celda_vehiculo(f)}
  <td class="num fuerte">{fmt(f.get('eficiencia'), ' %')}</td>
  <td>{mini_barras(f.get('diaria'), p)}</td>
  <td class="num">{fmt(f.get('linea_base'), ' %')}</td>
  <td class="num">{fmt(f.get('pct_bajas'), ' %')}</td>
  <td class="num">{fmt(f.get('pares_validos'))}</td>
  <td class="num">{fmt(f.get('nox_entrada_med'))} → {fmt(f.get('nox_salida_med'))}</td>
  <td class="num">{fmt(f.get('temp_scr_med'), ' °C')}</td>
  <td class="num">{fmt(f.get('def_ultimo'), ' %')}</td>
  {_celda_motivos(f)}
</tr>""")

    # --- 2. parcial
    filas_p = []
    for f in sorted(por_nivel['parcial'], key=lambda f: (ORDEN[f['estado']], f['vehiculo'])):
        filas_p.append(f"""
<tr {_atributos_fila(f)}>
  <td><span class="pill {f['estado']}">{ETIQUETA_PARCIAL[f['estado']]}</span></td>
  {_celda_vehiculo(f)}
  <td>{_chips(f['senales_si'], f['senales_no'])}</td>
  <td class="num">{fmt(f.get('def_ultimo'), ' %')}</td>
  <td class="num">{fmt(None if f.get('def_min') is None else round(f['def_min']), ' %')}</td>
  <td class="num">{fmt(f.get('temp_scr_max'), ' °C')}</td>
  {_celda_motivos(f)}
</tr>""")

    # --- 3. no medible
    filas_n = []
    for f in sorted(por_nivel['no_medible'], key=lambda f: (f['marca'], f['vehiculo'])):
        filas_n.append(f"""
<tr {_atributos_fila(f)}>
  <td><span class="pill gris">No medible</span></td>
  {_celda_vehiculo(f)}
  <td>{html.escape(f['motivos'][0])}</td>
  <td>{html.escape(f.get('ultima_comunicacion') or '—')}</td>
</tr>""")

    vacio = lambda n: f'<tr><td colspan="{n}" class="vacio">Ningún vehículo en este nivel.</td></tr>'

    marca_html = ''.join(
        f"<tr><td>{html.escape(m['marca'])}</td><td class='num'>{m['vehiculos']}</td>"
        f"<td class='num'>{m['completo']}</td><td class='num'>{m['parcial']}</td><td class='num'>{m['no_medible']}</td>"
        f"<td class='num fuerte'>{fmt(m['eficiencia_tipica'], ' %')}</td><td class='num'>{fmt(m['rango'])}</td>"
        f"<td class='num'>{m['con_fallas']}</td></tr>" for m in resumen_marca)

    fallas_html = ''.join(
        f"<tr><td>{html.escape(x['vehiculo'])}</td><td>{html.escape(NIVELES[x['nivel']][0]) if x['nivel'] else '—'}</td>"
        f"<td>{html.escape(x['diagnostico'])}</td><td class='num'>{x['spn']}</td>"
        f"<td class='num'>{x['registros']}</td><td>{x['primera']}</td><td>{x['ultima']}</td></tr>" for x in fallas_detalle) \
        or '<tr><td colspan="7" class="vacio">Sin fallas del sistema SCR/NOx/DEF en el período.</td></tr>'

    return f"""<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Estado SCR / NOx</title>
<style>
:root {{ --bg:#f6f7f9; --card:#fff; --tx:#1d2330; --tx2:#5b6475; --bd:#e3e6ec;
  --verde:#1f8a4c; --verde-bg:#e3f4ea; --amarillo:#a86b00; --amarillo-bg:#fdf1d8;
  --rojo:#c0352b; --rojo-bg:#fbe4e2; --gris:#6b7280; --gris-bg:#eceef1; --acento:#2457c5; --acento-bg:#e6edfb; }}
@media (prefers-color-scheme: dark) {{ :root {{ --bg:#14171d; --card:#1c2029; --tx:#e7eaf0; --tx2:#9aa3b2; --bd:#2c3240;
  --verde:#4cc782; --verde-bg:#183324; --amarillo:#f0b54a; --amarillo-bg:#3a2e14;
  --rojo:#f07167; --rojo-bg:#3d1d1b; --gris:#a0a7b4; --gris-bg:#262b35; --acento:#7aa2ff; --acento-bg:#1d2740; }} }}
* {{ box-sizing:border-box }}
body {{ margin:0; background:var(--bg); color:var(--tx); font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif }}
main {{ max-width:1400px; margin:0 auto; padding:24px 16px 48px }}
h1 {{ font-size:22px; margin:0 0 4px }} h2 {{ font-size:17px; margin:36px 0 6px }}
.meta {{ color:var(--tx2); margin-bottom:20px }}
.lead {{ color:var(--tx2); margin:0 0 12px; max-width:900px }}
.cobs {{ display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px }}
.cob {{ display:block; text-decoration:none; color:inherit; background:var(--card); border:1px solid var(--bd);
  border-top:4px solid var(--acento); border-radius:10px; padding:14px 16px }}
.cob.parcial {{ border-top-color:var(--amarillo) }} .cob.no_medible {{ border-top-color:var(--gris) }}
.cob .n {{ font-size:30px; font-weight:700 }} .cob .t {{ font-weight:700; margin-bottom:4px }}
.cob .d {{ color:var(--tx2); font-size:13px; margin-bottom:8px }} .cob .des .pill {{ margin:0 4px 4px 0 }}
.kpis {{ display:flex; gap:8px; flex-wrap:wrap; align-items:center }}
.kpi {{ background:var(--card); border:1px solid var(--bd); border-radius:99px; padding:6px 14px; cursor:pointer; font-weight:600 }}
.kpi.rojo {{ color:var(--rojo) }} .kpi.amarillo {{ color:var(--amarillo) }} .kpi.verde {{ color:var(--verde) }} .kpi.gris {{ color:var(--gris) }}
.kpi.activo {{ outline:2px solid var(--acento) }}
.card {{ background:var(--card); border:1px solid var(--bd); border-radius:10px; overflow-x:auto }}
table {{ width:100%; border-collapse:collapse }}
th, td {{ padding:8px 10px; border-bottom:1px solid var(--bd); text-align:left; vertical-align:top }}
th {{ font-size:12px; color:var(--tx2); font-weight:600; background:var(--card) }}
th.num, td.num {{ text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums }} .fuerte {{ font-weight:700 }}
.veh {{ font-weight:600; white-space:nowrap }} .sub {{ font-weight:400; color:var(--tx2); font-size:12px }}
.pill {{ display:inline-block; padding:2px 10px; border-radius:99px; font-size:12px; font-weight:600; white-space:nowrap }}
.pill.rojo {{ background:var(--rojo-bg); color:var(--rojo) }} .pill.amarillo {{ background:var(--amarillo-bg); color:var(--amarillo) }}
.pill.verde {{ background:var(--verde-bg); color:var(--verde) }} .pill.gris {{ background:var(--gris-bg); color:var(--gris) }}
.chip {{ display:inline-block; padding:1px 8px; border-radius:6px; font-size:12px; margin:0 4px 4px 0; white-space:nowrap }}
.chip.si {{ background:var(--verde-bg); color:var(--verde) }} .chip.no {{ background:var(--gris-bg); color:var(--gris) }}
.mide {{ display:flex; flex-wrap:wrap; gap:4px; margin:0 0 10px }}
ul.motivos, ul.fallas {{ margin:0; padding-left:16px }} ul.fallas {{ color:var(--tx2); font-size:12px }}
.spark {{ display:flex; align-items:flex-end; gap:2px; height:28px; min-width:60px }}
.spark .b {{ width:7px; border-radius:2px 2px 0 0 }} .b.verde {{ background:var(--verde) }} .b.amarillo {{ background:var(--amarillo) }} .b.rojo {{ background:var(--rojo) }}
.filtros {{ display:flex; gap:10px; margin:24px 0 0; flex-wrap:wrap; align-items:center }}
input[type=search] {{ flex:1; min-width:220px; padding:8px 10px; border:1px solid var(--bd); border-radius:8px; background:var(--card); color:var(--tx) }}
.vacio {{ color:var(--tx2); text-align:center }}
.nota {{ color:var(--tx2); font-size:13px }} .nota li {{ margin-bottom:4px }}
</style></head><body><main>
<h1>Estado del sistema SCR / NOx</h1>
<div class="meta">{html.escape(meta['periodo'])} · {meta['vehiculos']} vehículos activos · generado {meta['generado']}</div>

<div class="cobs">{cobertura_html}</div>

<div class="filtros">
  <input type="search" id="buscar" placeholder="Buscar vehículo, marca o ciudad…">
  <div class="kpis">
    <span class="kpi rojo" data-f="rojo">Revisar {conteo['rojo']}</span>
    <span class="kpi amarillo" data-f="amarillo">Vigilar {conteo['amarillo']}</span>
    <span class="kpi verde" data-f="verde">Bien / sin fallas {conteo['verde']}</span>
    <span class="kpi gris" data-f="gris">Sin datos suficientes {conteo['gris']}</span>
  </div>
</div>

<h2 id="sec-completo">1. Medición completa — {len(por_nivel['completo'])} vehículos</h2>
<p class="lead">{html.escape(NIVELES['completo'][1])}</p>
<div class="mide">{_chips(['Eficiencia del SCR', 'Sensores NOx', 'Fallas del sistema', 'Nivel de DEF', 'Línea base propia'])}</div>
<div class="card"><table>
<thead><tr><th>Estado</th><th>Vehículo</th><th class="num">Eficiencia</th><th>Por día</th>
<th class="num">Línea base</th><th class="num">Lecturas &lt; 80 %</th><th class="num">Lecturas válidas</th>
<th class="num">NOx entrada → salida (ppm)</th><th class="num">Temp. SCR</th><th class="num">DEF</th><th>Motivo / fallas</th></tr></thead>
<tbody>{''.join(filas_c) or vacio(11)}</tbody></table></div>

<h2 id="sec-parcial">2. Medición parcial — {len(por_nivel['parcial'])} vehículos</h2>
<p class="lead">{html.escape(NIVELES['parcial'][1])} Un estado "Sin fallas" aquí significa que no hubo fallas ni DEF bajo; <b>no</b> garantiza que el catalizador esté limpiando bien.</p>
<div class="mide">{_chips(['Fallas del sistema', 'Nivel y temperatura de DEF (si los envía)', 'Temperatura del SCR (si la envía)'], ['Eficiencia del SCR', 'Sensores NOx'])}</div>
<div class="card"><table>
<thead><tr><th>Estado</th><th>Vehículo</th><th>Señales que envía</th><th class="num">DEF último</th><th class="num">DEF mínimo</th>
<th class="num">Temp. SCR máx.</th><th>Motivo / fallas</th></tr></thead>
<tbody>{''.join(filas_p) or vacio(7)}</tbody></table></div>

<h2 id="sec-no_medible">3. No medible — {len(por_nivel['no_medible'])} vehículos</h2>
<p class="lead">{html.escape(NIVELES['no_medible'][1])}</p>
<div class="card"><table>
<thead><tr><th>Estado</th><th>Vehículo</th><th>Motivo</th><th>Última comunicación del GPS</th></tr></thead>
<tbody>{''.join(filas_n) or vacio(4)}</tbody></table></div>

<h2>Resumen por marca</h2>
<div class="card"><table>
<thead><tr><th>Marca</th><th class="num">Vehículos</th><th class="num">Completo</th><th class="num">Parcial</th><th class="num">No medible</th>
<th class="num">Eficiencia típica</th><th class="num">Rango</th><th class="num">Con fallas</th></tr></thead>
<tbody>{marca_html}</tbody></table></div>

<h2>Fallas del sistema SCR / NOx / DEF en el período</h2>
<div class="card"><table>
<thead><tr><th>Vehículo</th><th>Nivel</th><th>Diagnóstico</th><th class="num">SPN</th><th class="num">Registros</th><th>Primera</th><th>Última</th></tr></thead>
<tbody>{fallas_html}</tbody></table></div>

<h2>Cómo se calcula</h2>
<ul class="nota">
<li><b>Eficiencia</b> (solo medición completa) = (NOx entrada − NOx salida) / NOx entrada. Es la mediana de las lecturas del período.</li>
<li>Solo cuentan lecturas con el catalizador caliente (salida del SCR ≥ 250 °C) y NOx de entrada entre 50 y 3000 ppm. Se descartan −200 (sensor calentando) y 3012,75 (tope del sensor). En frío el SCR no convierte por diseño, así que esas lecturas no indican falla.</li>
<li><b>Revisar</b>: eficiencia &lt; 80 %, falta un sensor o hay una falla del sistema en las últimas {HORAS_FALLA_RECIENTE} h. <b>Vigilar</b>: eficiencia &lt; 90 %, ≥ 20 % de lecturas por debajo de 80 %, caída ≥ {CAIDA_ALERTA_PP} pts frente a su línea base, fallas en el período o DEF &lt; {NIVEL_DEF_BAJO} %. En la medición parcial solo aplican las fallas y el DEF.</li>
<li><b>Fallas del sistema</b>: sensores de NOx, dosificación de DEF, inducción del operador de SCR, calidad, nivel y calentadores de DEF. No incluye el DPF (hollín/regeneración), que tiene su propio seguimiento.</li>
<li><b>Línea base</b>: mediana de los reportes anteriores del mismo vehículo. Se llena a medida que se generan reportes.</li>
<li>En los International, Geotab guarda el NOx cada ~30 min, así que el reporte mide el período completo y no el tiempo real. Las barras "por día" muestran la eficiencia diaria; pasa el cursor para ver el valor.</li>
</ul>
</main>
<script>
(function () {{
  var filtro = null, buscar = document.getElementById('buscar');
  var filas = Array.prototype.slice.call(document.querySelectorAll('tr.filtrable'));
  function aplicar() {{
    var q = buscar.value.trim().toLowerCase();
    filas.forEach(function (tr) {{
      var ok = (!filtro || tr.dataset.estado === filtro) && (!q || tr.dataset.texto.indexOf(q) >= 0);
      tr.style.display = ok ? '' : 'none';
    }});
  }}
  document.querySelectorAll('.kpi').forEach(function (k) {{
    k.addEventListener('click', function () {{
      filtro = filtro === k.dataset.f ? null : k.dataset.f;
      document.querySelectorAll('.kpi').forEach(function (x) {{ x.classList.toggle('activo', x.dataset.f === filtro); }});
      aplicar();
    }});
  }});
  buscar.addEventListener('input', aplicar);
}})();
</script>
</body></html>"""


# ---------------------------------------------------------------------------
# Envio semanal por Telegram
# ---------------------------------------------------------------------------

def semana_actual():
    ahora = datetime.now(TZ_LOCAL)
    anio, semana, _ = ahora.isocalendar()
    ya_es_hora = (ahora.weekday(), ahora.hour) >= (DIA_ENVIO_SEMANAL, HORA_ENVIO_SEMANAL)
    return f'{anio}-W{semana:02d}', ya_es_hora


def toca_envio_semanal():
    semana, ya_es_hora = semana_actual()
    try:
        enviada = json.loads(RUTA_ESTADO_ENVIO.read_text(encoding='utf-8')).get('ultima_semana_enviada')
    except (OSError, ValueError):
        enviada = None
    return ya_es_hora and enviada != semana


def marcar_semana_enviada():
    RUTA_ESTADO_ENVIO.parent.mkdir(parents=True, exist_ok=True)
    RUTA_ESTADO_ENVIO.write_text(json.dumps({'ultima_semana_enviada': semana_actual()[0],
                                             'enviado': datetime.now(TZ_LOCAL).isoformat()}), encoding='utf-8')


def chat_ids_destino():
    """Mismos destinatarios que telegram_alertas.py: TELEGRAM_CHAT_ID + suscritos con /start."""
    fijos = [c.strip() for c in os.environ['TELEGRAM_CHAT_ID'].split(',') if c.strip()]
    try:
        suscritos = json.loads(RUTA_ESTADO_TELEGRAM.read_text(encoding='utf-8')).get('suscriptores', [])
    except (OSError, ValueError):
        suscritos = []
    return list(dict.fromkeys(fijos + [str(s) for s in suscritos]))


def texto_resumen(filas, meta):
    por_nivel = {n: [f for f in filas if f['nivel'] == n] for n in NIVELES}
    medibles = por_nivel['completo'] + por_nivel['parcial']
    conteo = {k: [f for f in medibles if f['estado'] == k] for k in ORDEN}
    lineas = [f"🧪 Estado del sistema SCR / NOx — {meta['periodo']}",
              f"Cobertura: {len(por_nivel['completo'])} medición completa · {len(por_nivel['parcial'])} parcial "
              f"(sin eficiencia) · {len(por_nivel['no_medible'])} no medibles",
              f"🔴 Revisar {len(conteo['rojo'])} · 🟡 Vigilar {len(conteo['amarillo'])} · "
              f"🟢 Bien/sin fallas {len(conteo['verde'])} · ⚪ Sin datos {len(conteo['gris'])}"]
    for estado, icono in (('rojo', '🔴'), ('amarillo', '🟡')):
        for f in sorted(conteo[estado], key=lambda f: (f['nivel'] != 'completo', f.get('eficiencia') or 999)):
            medida = (f"eficiencia {fmt(f.get('eficiencia'), ' %')}" if f['nivel'] == 'completo'
                      else 'medición parcial, sin eficiencia')
            lineas.append(f"\n{icono} {f['vehiculo']} ({f['marca']}) — {medida}")
            lineas += [f"   • {m}" for m in f['motivos'][:3]]
    if por_nivel['no_medible']:
        lineas.append('\n⚪ No medibles: ' + ', '.join(sorted(f['vehiculo'] for f in por_nivel['no_medible'])))
    lineas.append('\nDetalle completo en el HTML adjunto.')
    texto = '\n'.join(lineas)
    return texto if len(texto) <= 4000 else texto[:3950] + '\n… (ver HTML adjunto)'


def enviar_por_telegram(texto, ruta_html):
    """True si le llego a al menos un destinatario (mismo criterio que enviar_telegram)."""
    token = os.environ['TELEGRAM_BOT_TOKEN']
    ok = False
    for chat_id in chat_ids_destino():
        r1 = requests.post(f'https://api.telegram.org/bot{token}/sendMessage',
                           json={'chat_id': chat_id, 'text': texto}, timeout=15)
        with open(ruta_html, 'rb') as f:
            r2 = requests.post(f'https://api.telegram.org/bot{token}/sendDocument',
                               data={'chat_id': chat_id, 'caption': 'Reporte SCR / NOx (abrir en el navegador)'},
                               files={'document': (ruta_html.name, f, 'text/html')}, timeout=60)
        for r in (r1, r2):
            if not r.ok:
                print(f'*** Error enviando a Telegram (chat_id={chat_id}): {r.status_code} {r.text} ***')
        ok = ok or (r1.ok and r2.ok)
    return ok


def avisar_github(generado):
    """Le dice al workflow si hubo corrida real (para guardar el cache solo entonces)."""
    salida = os.environ.get('GITHUB_OUTPUT')
    if salida:
        with open(salida, 'a', encoding='utf-8') as f:
            f.write(f'generado={"true" if generado else "false"}\n')


# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='Reporte del estado del sistema SCR/NOx por vehiculo (HTML).')
    parser.add_argument('--dias', type=int, default=7, help='Dias hacia atras a analizar (por defecto 7).')
    parser.add_argument('--ciudad', default=None, help='Limitar a una ciudad (nombre del grupo, ej. "Bogotá").')
    parser.add_argument('--telegram', action='store_true', help='Mandar resumen + HTML al bot de Telegram.')
    parser.add_argument('--semanal', action='store_true',
                        help='Solo generar si es lunes >= 07:00 y esta semana no se ha enviado (para el workflow).')
    args = parser.parse_args()

    load_dotenv(CARPETA_REPO / '.env')
    if args.semanal and not toca_envio_semanal():
        print(f'Reporte SCR/NOx semanal: no toca todavía ({semana_actual()[0]} ya enviado o antes del lunes 07:00).')
        avisar_github(False)
        return

    api = gc.conectar_geotab()
    hasta = datetime.now(timezone.utc)
    desde = hasta - timedelta(days=args.dias)

    devices = api.get('Device')
    activos = {d['id']: d for d in devices if not d.get('activeTo') or pd.Timestamp(d['activeTo']) > hasta}
    grupos_por_id, padre_de, _ = gc.obtener_arbol_grupos(api)
    raiz = next((g for g in grupos_por_id.values() if (g.get('name') or '').strip().startswith('*')), None)
    raiz_hijos = {gc.obtener_id(h) for h in (raiz or {}).get('children') or []}

    print('Descargando NOx entrada / salida, temperatura SCR y nivel de DEF...')
    din = bajar_statusdata(api, ID_NOX_ENTRADA, desde, hasta)
    dout = bajar_statusdata(api, ID_NOX_SALIDA, desde, hasta)
    dtemp = bajar_statusdata(api, ID_TEMP_SALIDA_SCR, desde, hasta)
    ddef = bajar_statusdata(api, ID_NIVEL_DEF, desde, hasta)
    dtanque = bajar_statusdata(api, ID_TEMP_TANQUE_DEF, desde, hasta)
    print(f'  lecturas: entrada {len(din)}, salida {len(dout)}, temp SCR {len(dtemp)}, DEF {len(ddef)}, temp tanque DEF {len(dtanque)}')

    print('Descargando fallas del período...')
    fallas = bajar_fallas(api, desde, hasta)
    diags = {d['id']: d for d in api.get('Diagnostic')}
    fallas_scr = []
    for f in fallas:
        d = diags.get(gc.obtener_id(f.get('diagnostic'))) or {}
        if PATRON_FALLA_SCR.search(d.get('name') or ''):
            fallas_scr.append((gc.obtener_id(f['device']), d.get('name'), d.get('code'), pd.Timestamp(f['dateTime'])))
    print(f'  fallas totales {len(fallas)}, del sistema SCR/NOx/DEF {len(fallas_scr)}')

    reciente = pd.Timestamp(hasta) - pd.Timedelta(hours=HORAS_FALLA_RECIENTE)
    fallas_por_veh = defaultdict(lambda: defaultdict(list))
    for veh, nombre, spn, t in fallas_scr:
        fallas_por_veh[veh][(nombre, spn)].append(t)

    # Ultima comunicacion de cada GPS (para separar "no envia SCR" de "GPS apagado")
    ultima_com = {}
    for s in api.get('DeviceStatusInfo'):
        if s.get('dateTime'):
            ultima_com[gc.obtener_id(s['device'])] = pd.Timestamp(s['dateTime'])
    limite_com = pd.Timestamp(hasta) - pd.Timedelta(hours=HORAS_SIN_COMUNICAR)

    con_nox = set(din.veh) | set(dout.veh)
    con_def, con_temp = set(ddef.veh), set(dtemp[dtemp.v > 0].veh)  # temp en 0 = no soportada (ver encabezado)
    con_tanque = set(dtanque.veh)

    def senal_scr_previa(veh):
        """True si en los DIAS_BUSQUEDA_SENALES anteriores al periodo envio NOx, nivel o temp. de DEF:
        el vehiculo tiene SCR aunque esta semana no haya llegado nada (p.ej. 11006-NGY805)."""
        for diag in (ID_NOX_ENTRADA, ID_NIVEL_DEF, ID_TEMP_TANQUE_DEF):
            if api.get('StatusData', search={'deviceSearch': {'id': veh}, 'diagnosticSearch': {'id': diag},
                                             'fromDate': desde - timedelta(days=DIAS_BUSQUEDA_SENALES), 'toDate': desde},
                       resultsLimit=1):
                return True
        return False
    filas = []
    for veh, dev in activos.items():
        marca, ciudad = resolver_grupos(dev, grupos_por_id, padre_de, raiz_hijos)
        if args.ciudad and ciudad.lower() != args.ciudad.lower():
            continue
        p = parametros(marca)
        fv = fallas_por_veh.get(veh, {})
        r = {'_id': veh, 'vehiculo': dev['name'], 'marca': marca, 'ciudad': ciudad,
             'fallas_periodo': bool(fv),
             'fallas_recientes': any(max(ts) >= reciente for ts in fv.values()),
             'fallas_resumen': [f"SPN {spn} · {nombre} ({len(ts)}, última {max(ts).tz_convert(TZ_LOCAL):%d-%b %H:%M})"
                                for (nombre, spn), ts in sorted(fv.items(), key=lambda x: -len(x[1]))]}
        dv = ddef[ddef.veh == veh]
        r['def_ultimo'] = round(float(dv.v.iloc[-1])) if len(dv) else None
        r['def_min'] = float(dv.v.min()) if len(dv) else None
        uc = ultima_com.get(veh)
        r['ultima_comunicacion'] = f'{uc.tz_convert(TZ_LOCAL):%d-%b-%Y %H:%M}' if uc is not None else 'Nunca'

        if veh in con_nox:
            r['nivel'] = 'completo'
            r.update(eficiencia_vehiculo(din[din.veh == veh], dout[dout.veh == veh], dtemp[dtemp.veh == veh], p['temp_min_scr']))
        elif veh in con_def or veh in con_temp or veh in con_tanque or fv or (
                uc is not None and uc >= limite_com and senal_scr_previa(veh)):
            # GPS apagado + nada del SCR en el periodo -> "no medible: GPS sin comunicar", no parcial
            r['nivel'] = 'parcial'
            r['sin_senales_periodo'] = not (veh in con_def or veh in con_temp or veh in con_tanque or fv)
            senales = (('Nivel de DEF', veh in con_def), ('Temp. tanque DEF', veh in con_tanque),
                       ('Temp. SCR', veh in con_temp))
            r['senales_si'] = [n for n, ok in senales if ok] + ['Fallas']
            r['senales_no'] = ['Sensores NOx'] + [n for n, ok in senales if not ok]
            t = dtemp[(dtemp.veh == veh) & (dtemp.v > 0)]
            r['temp_scr_max'] = round(float(t.v.max())) if len(t) else None
        else:
            r['nivel'] = 'no_medible'
        filas.append(r)

    # linea base (corridas anteriores) -> caida -> semaforo -> guardar esta corrida
    def clasificar_todo():
        for r in filas:
            if r['nivel'] == 'completo':
                r['estado'], r['motivos'] = clasificar(r, parametros(r['marca']))
            elif r['nivel'] == 'parcial':
                r['estado'], r['motivos'] = clasificar_parcial(r)
            else:
                uc = ultima_com.get(r['_id'])
                r['estado'] = 'no_medible'
                r['motivos'] = [f"GPS sin comunicar desde {r['ultima_comunicacion']}" if uc is None or uc < limite_com
                                else f'El GPS comunica, pero el motor no envía ninguna señal del SCR (NOx, DEF ni temperaturas) en los últimos {DIAS_BUSQUEDA_SENALES + args.dias} días. '
                                     'Confirmar en ficha técnica si el vehículo tiene SCR.']

    fecha_corte = datetime.now(TZ_LOCAL).strftime('%Y-%m-%d')
    clasificar_todo()  # provisional, para el historico
    base = actualizar_historico(filas, fecha_corte)
    for r in filas:
        if r['nivel'] == 'completo' and r['vehiculo'] in base.index:
            r['linea_base'] = round(float(base.loc[r['vehiculo'], 'median']), 1)
            if r.get('eficiencia') is not None:
                r['caida'] = round(r['linea_base'] - r['eficiencia'], 1)
    clasificar_todo()
    actualizar_historico(filas, fecha_corte)  # reescribe la fila de hoy con el estado final

    por_marca = defaultdict(list)
    for r in filas:
        por_marca[r['marca']].append(r)
    resumen_marca = []
    for marca, rs in sorted(por_marca.items(), key=lambda x: -len(x[1])):
        efis = [r['eficiencia'] for r in rs if r.get('eficiencia') is not None and r.get('pares_validos', 0) >= MIN_LECTURAS_VALIDAS]
        resumen_marca.append({'marca': marca, 'vehiculos': len(rs),
                              **{n: sum(1 for r in rs if r['nivel'] == n) for n in NIVELES},
                              'eficiencia_tipica': round(float(pd.Series(efis).median()), 1) if efis else None,
                              'rango': f'{min(efis)} – {max(efis)}' if efis else None,
                              'con_fallas': sum(1 for r in rs if r['fallas_periodo'])})

    nivel_de = {r['vehiculo']: r['nivel'] for r in filas}
    fallas_detalle = []
    for veh, fv in fallas_por_veh.items():
        nombre_veh = (activos.get(veh) or {}).get('name', veh)
        if args.ciudad and nombre_veh not in nivel_de:
            continue
        for (nombre, spn), ts in fv.items():
            fallas_detalle.append({'vehiculo': nombre_veh, 'nivel': nivel_de.get(nombre_veh), 'diagnostico': nombre or '?',
                                   'spn': spn, 'registros': len(ts),
                                   'primera': f"{min(ts).tz_convert(TZ_LOCAL):%d-%b %H:%M}",
                                   'ultima': f"{max(ts).tz_convert(TZ_LOCAL):%d-%b %H:%M}", '_u': max(ts)})
    fallas_detalle.sort(key=lambda x: x['_u'], reverse=True)

    meta = {'periodo': f"{desde.astimezone(TZ_LOCAL):%d-%b-%Y} a {hasta.astimezone(TZ_LOCAL):%d-%b-%Y} ({args.dias} días)"
                       + (f" · {args.ciudad}" if args.ciudad else ''),
            'vehiculos': len(filas), 'generado': datetime.now(TZ_LOCAL).strftime('%d-%b-%Y %H:%M')}
    contenido = generar_html(filas, fallas_detalle, resumen_marca, meta)

    RUTA_HTML.parent.mkdir(parents=True, exist_ok=True)
    RUTA_HTML.write_text(contenido, encoding='utf-8')
    print(f'Guardado en: {RUTA_HTML}')
    try:
        RUTA_HTML_DESCARGAS.write_text(contenido, encoding='utf-8')
        print(f'Copia en: {RUTA_HTML_DESCARGAS}')
    except OSError as e:
        print(f'(no se pudo copiar a Descargas: {e})')

    for nivel in NIVELES:
        fs = [r for r in filas if r['nivel'] == nivel]
        print(f"\n{NIVELES[nivel][0]}: {len(fs)}")
        for estado in list(ORDEN) + ['no_medible']:
            lista = sorted(r['vehiculo'] for r in fs if r['estado'] == estado)
            if lista:
                print(f"   {estado:10s} {len(lista):3d}  {', '.join(lista)[:180]}")

    if args.telegram:
        enviado = enviar_por_telegram(texto_resumen(filas, meta), RUTA_HTML)
        print('Enviado a Telegram.' if enviado else '*** No se pudo enviar a Telegram ***')
        # Igual que en telegram_alertas.py: solo se marca la semana si el envio salio,
        # si no, la siguiente corrida (5 min despues) lo vuelve a intentar.
        if enviado and args.semanal:
            marcar_semana_enviada()
    avisar_github(True)


if __name__ == '__main__':
    main()
