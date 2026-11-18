"""
Cumplimiento del chip NFC de conductores (SOLO LECTURA en Geotab).

1) Alineación: compara el Excel de control de chips (CHIPS - CONDUCTOR.xlsx) contra las llaves
   (User.keys) cargadas en Geotab.
2) Cumplimiento por vehículo y turno: solo cuenta los turnos en que el vehículo SALIÓ A OPERAR
   (paradas fuera de la base y de talleres/concesionarios) y mira si alguien pasó el chip en ese turno.
   Se mide por pases reales (DriverChange), no por Trip.driver: Geotab deja el viaje a nombre del
   último que pasó el chip, así que un turno sin pase sale "con conductor" equivocado.

Uso (desde herramientas/):
    python cumplimiento_nfc.py              # últimos 7 días
    python cumplimiento_nfc.py --dias 14
"""
import argparse
import re
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from geotab_comun import conectar_geotab, punto_en_poligono

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

EXCEL_CHIPS = Path(r'C:\Users\sergio.calderon\Documents\Dashboard\Directorio\CHIPS - CONDUCTOR.xlsx')
ZONA_BASE = 'b28CB'   # BASE DE OPERACIONES PROMOAMBIENTAL DISTRITO
TIPOS_ZONA_PROVEEDOR = {'b1D0', 'ZoneTypeVendorServiceCenterId', 'ZoneTypeInHouseServiceCenterId', 'b4A3', 'b4F1', 'b4F2'}
MIN_PARADAS_FUERA = 3   # paradas fuera de base/proveedores para contar que el turno operó
BOG = timezone(timedelta(hours=-5))


def idde(r):
    return (r.get('id') if isinstance(r, dict) else r) if r else None


def palabras(nombre):
    s = unicodedata.normalize('NFD', str(nombre or '')).encode('ascii', 'ignore').decode().lower()
    return set(re.findall(r'[a-z]+', s))


def mismo_nombre(a, b):
    """'Passo Tovar Luis Alberto' vs 'Luis Alberto Passo Tovar': mismas palabras en otro orden, o al menos 2 en común."""
    pa, pb = palabras(a), palabras(b)
    return bool(pa and pb) and (pa <= pb or pb <= pa or len(pa & pb) >= 2)


def turno_de(t):
    """Turno operativo: día 05:00-16:59, noche 17:00-04:59 (la noche se fecha al día en que empieza)."""
    tl = t.astimezone(BOG)
    if 5 <= tl.hour < 17:
        return tl.date(), 'día'
    return ((tl - timedelta(days=1)).date() if tl.hour < 5 else tl.date()), 'noche'


def leer_excel():
    if not EXCEL_CHIPS.exists():
        return []
    import openpyxl
    ws = openpyxl.load_workbook(EXCEL_CHIPS, data_only=True, read_only=True).active
    filas = []
    for r in ws.iter_rows(min_row=2, values_only=True):
        if not r or not r[0]:
            continue
        filas.append({'nombre': str(r[0]).strip(), 'movil': str(r[4] or '').strip(),
                      'turno': 'noche' if str(r[5] or '').strip() else ('día' if str(r[6] or '').strip() else '?'),
                      'rol': str(r[7] or '').strip(), 'chip': str(r[8] or '').strip().upper() or None})
    return filas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dias', type=int, default=7)
    args = ap.parse_args()

    api = conectar_geotab()
    ahora = datetime.now(timezone.utc)
    desde = ahora - timedelta(days=args.dias)
    usuarios = api.get('User')
    nombre_u = {u['id']: f"{u.get('firstName', '')} {u.get('lastName', '')}".strip() for u in usuarios}
    dueno_chip = {k.get('serialNumber', '').upper(): u['id'] for u in usuarios for k in (u.get('keys') or [])}
    devices = {d['id']: d['name'] for d in api.get('Device')}

    # ---- 1) Alineación Excel vs Geotab ----
    excel = leer_excel()
    print(f"== 1) Excel de chips vs Geotab  ({EXCEL_CHIPS.name if excel else 'Excel NO encontrado'})")
    problemas = 0
    for f in excel:
        if not f['chip']:
            print(f"  · {f['nombre']} ({f['movil']} {f['turno']}, {f['rol']}): sin chip asignado"); continue
        uid = dueno_chip.get(f['chip'])
        if not uid:
            problemas += 1; print(f"  ✘ {f['chip']} de {f['nombre']}: no está cargado en ningún usuario de Geotab")
        elif not mismo_nombre(f['nombre'], nombre_u[uid]):
            problemas += 1; print(f"  ✘ {f['chip']}: Excel dice {f['nombre']}, Geotab lo tiene {nombre_u[uid]}")
    for chip, uid in dueno_chip.items():
        if excel and chip not in {f['chip'] for f in excel}:
            problemas += 1; print(f"  ✘ {chip} cargado en Geotab a {nombre_u[uid]} pero no está en el Excel")
    print(f"  {'✔ Todo alineado' if not problemas else f'{problemas} diferencia(s)'}"
          f" ({sum(1 for f in excel if f['chip'])} chips en el Excel, {len(dueno_chip)} en Geotab)")

    # ---- 2) Cumplimiento por turno ----
    zonas = api.get('Zone')
    poly = lambda z: [(p['x'], p['y']) for p in z['points']]
    base = [poly(z) for z in zonas if z['id'] == ZONA_BASE]
    proveedores = [(z['name'], poly(z)) for z in zonas
                   if any((t if isinstance(t, str) else t.get('id')) in TIPOS_ZONA_PROVEEDOR for t in z.get('zoneTypes', []))
                   or 'NAVITRANS' in z.get('name', '').upper()]

    def donde(p):
        if not p:
            return 'fuera'
        if any(punto_en_poligono(p['x'], p['y'], b) for b in base):
            return 'base'
        for n, pl in proveedores:
            if punto_en_poligono(p['x'], p['y'], pl):
                return 'prov:' + n
        return 'fuera'

    pases_todos = [c for c in api.get('DriverChange', search={'fromDate': desde.isoformat()}, resultsLimit=50000)
                   if c.get('type') == 'DriverKey']
    # Vehículos con lector: los que tuvieron algún pase en 60 días o aparecen en el Excel
    hace60 = [c for c in api.get('DriverChange', search={'fromDate': (ahora - timedelta(days=60)).isoformat()}, resultsLimit=50000)
              if c.get('type') == 'DriverKey']
    moviles_excel = {f['movil'] for f in excel}
    vehiculos = sorted({idde(c['device']) for c in hace60} |
                       {i for i, n in devices.items() if n.split('-')[0] in moviles_excel})
    titular = {(f['movil'], f['turno']): f['nombre'] for f in excel if f['rol'].lower().startswith('princip')}

    print(f"\n== 2) Cumplimiento por turno, últimos {args.dias} días (solo turnos que salieron a operar)")
    for vid in vehiculos:
        vn = devices.get(vid, vid); movil = vn.split('-')[0]
        pases = defaultdict(set)
        for c in pases_todos:
            if idde(c['device']) == vid:
                pases[turno_de(c['dateTime'])].add(nombre_u.get(idde(c['driver']), idde(c['driver'])))
        est = defaultdict(lambda: {'fuera': 0, 'prov': set()})
        for t in api.get('Trip', search={'deviceSearch': {'id': vid}, 'fromDate': desde.isoformat(), 'toDate': ahora.isoformat()}):
            d = donde(t.get('stopPoint')); e = est[turno_de(t['start'])]
            if d == 'fuera':
                e['fuera'] += 1
            elif d.startswith('prov:'):
                e['prov'].add(d[5:])
        print(f"\n  {vn}")
        for tn in ('día', 'noche'):
            operados = sorted(k for k, e in est.items() if k[1] == tn and e['fuera'] >= MIN_PARADAS_FUERA)
            con = [k for k in operados if pases.get(k)]
            sin = [k for k in operados if not pases.get(k)]
            prov = sorted(k for k, e in est.items() if k[1] == tn and e['prov'] and e['fuera'] < MIN_PARADAS_FUERA)
            if not operados and not prov:
                continue
            pct = 100 * len(con) / len(operados) if operados else 0
            sem = '🟢' if pct >= 85 else ('🟡' if pct >= 50 else '🔴')
            quien = sorted({n for k in con for n in pases[k]})
            print(f"    {tn:5} {sem} {len(con)}/{len(operados)} turnos con chip ({pct:.0f} %)"
                  f" · titular (Excel): {titular.get((movil, tn), '?')} · pasaron: {', '.join(quien) or '—'}")
            if sin:
                print(f"           sin chip: {', '.join(k[0].strftime('%a %d/%m') for k in sin)}")
            if prov:
                print(f"           en taller/proveedor (no cuenta): {', '.join(k[0].strftime('%a %d/%m') for k in prov)}")


if __name__ == '__main__':
    if '--prueba' in sys.argv:
        assert mismo_nombre('Passo Tovar Luis Alberto  ', 'Luis Alberto Passo Tovar')
        assert mismo_nombre('Rodriguez Pedreros Oscar Armando', 'Oscar Rodriguez')
        assert not mismo_nombre('Tafur Ruiz Edwin', 'WILMAR ANDRES RODRIGUEZ GUALTEROS')
        assert turno_de(datetime(2026, 11, 17, 7, 30, tzinfo=timezone.utc)) == (datetime(2026, 11, 16).date(), 'noche')  # 02:30 Bogotá = noche que empezó el 16
        assert turno_de(datetime(2026, 11, 17, 11, 0, tzinfo=timezone.utc)) == (datetime(2026, 11, 17).date(), 'día')   # 06:00 Bogotá
        print('autochequeo OK')
    else:
        main()
