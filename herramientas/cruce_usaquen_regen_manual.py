"""
cruce_usaquen_regen_manual.py -- valida si las rutas de Usaquen usan menos el
interruptor de regeneracion manual del DPF que el resto de la flota
=====================================================================================

Contexto (sesion 2026-09-30): el usuario observo en campo que los vehiculos que
cubren rutas de Usaquen casi nunca necesitan la regeneracion MANUAL del DPF
(interruptor de fuerza, ID_DIAGNOSTICO_INTERRUPTOR_MANUAL en
detectar_regeneracion_dpf.py) -- hipotesis: su ciclo de operacion favorece la
regeneracion pasiva/automatica (quiza mas marcha sostenida, menos ralenti que
otras localidades).

No existe ningun archivo con la asignacion vehiculo->ruta por placa (se revisaron
los dos geojson en C:\\Users\\sergio.calderon\\Documents\\Visual Studio\\Microrutas,
ninguno tiene columna de placa). Por eso este script DERIVA la asignacion por
cruce geografico real: usa los poligonos de la localidad USAQUEN (de
Microrruta_recoleccion_202609.geojson) y verifica que % de los puntos GPS reales
de cada vehiculo (LogRecord) cae dentro de esos poligonos en una ventana reciente.

Dos ventanas independientes a proposito:
  - Ventana de CLASIFICACION geografica (--dias-gps, default 7): corta a proposito
    para no traer millones de puntos LogRecord de toda la flota. Asume que la
    asignacion de ruta es estable semana a semana (razonable para rutas fijas).
  - Ventana de COMPARACION de uso del interruptor manual (--dias-interruptor,
    default 60): mas larga, mismo tipo de ventana que ya se usa en el proyecto
    para validar reglas (30-60 dias), porque las activaciones manuales son
    eventos raros (el interruptor esta en 0 el ~99.8% del tiempo, ver memoria).

Alcance de vehiculos: reutiliza el mismo alcance ya validado para el DPF
(NOMBRE_REGLA_ALCANCE en detectar_regeneracion_dpf.py), no un alcance nuevo.

USO:
  python cruce_usaquen_regen_manual.py
  python cruce_usaquen_regen_manual.py --dias-gps 10 --dias-interruptor 90
  python cruce_usaquen_regen_manual.py --umbral-pct 15 --excel
"""
import argparse
import json
import pathlib
from datetime import datetime, timedelta, timezone

import pandas as pd
from shapely.geometry import shape, Point
from shapely.ops import unary_union
from shapely.prepared import prep

import geotab_comun as gc
import detectar_regeneracion_dpf as d

RUTA_POLIGONOS_USAQUEN = pathlib.Path(__file__).resolve().parent / '_usaquen_poligonos.json'
LIMITE_PAGINA_LOGRECORD = 50000  # mismo tope real ya documentado en calcular_ralenti_real_geotab.py
# CAMBIO (2026-09-30): consecutivas lecturas con el interruptor en >0 separadas
# por menos de esto se cuentan como UNA sola activacion, no varias -- mismo
# principio de debounce que DEBOUNCE_MIN/VENTANA_PTO_MINUTOS en el resto del
# proyecto, para no sobre-contar por muestreo denso durante una misma maniobra.
DEBOUNCE_ACTIVACION_MIN = 60


def cargar_forma_usaquen():
    with open(RUTA_POLIGONOS_USAQUEN, encoding='utf-8') as f:
        features = json.load(f)
    formas = [shape(feat['geometry']) for feat in features]
    union = unary_union(formas)
    return union, union.bounds  # bounds = (minx, miny, maxx, maxy) para filtro rapido por bbox


def muestras_logrecord(api, id_veh, desde, hasta):
    """Pagina LogRecord igual que _muestras_logrecord_velocidad en
    calcular_ralenti_real_geotab.py, pero devuelve (t, lon, lat) en vez de velocidad."""
    fmt = '%Y-%m-%dT%H:%M:%S.%fZ'
    todos = []
    desde_actual = desde
    while True:
        pagina = api.get('LogRecord', search={
            'deviceSearch': {'id': id_veh},
            'fromDate': desde_actual.strftime(fmt), 'toDate': hasta.strftime(fmt),
        }) or []
        if not pagina:
            break
        todos.extend(pagina)
        if len(pagina) < LIMITE_PAGINA_LOGRECORD:
            break
        nuevo_desde = pd.to_datetime(max(r['dateTime'] for r in pagina))
        if nuevo_desde <= desde_actual:
            break
        desde_actual = nuevo_desde
    return [(r['dateTime'], r.get('longitude'), r.get('latitude')) for r in todos
            if r.get('longitude') is not None and r.get('latitude') is not None]


def clasificar_vehiculo(puntos, forma_preparada, bounds):
    """% de puntos GPS dentro del poligono de Usaquen. Filtro rapido por bbox
    antes del contains() exacto (mucho mas barato, la mayoria de puntos de
    vehiculos que no son de Usaquen se descartan sin tocar shapely de verdad).
    Recibe la forma YA preparada con shapely.prepared.prep (hacerlo una sola vez
    para toda la flota, no por vehiculo -- prep() tiene su propio costo)."""
    if not puntos:
        return 0.0, 0
    minx, miny, maxx, maxy = bounds
    dentro = 0
    for _, lon, lat in puntos:
        if lon is None or lat is None:
            continue
        if minx <= lon <= maxx and miny <= lat <= maxy and forma_preparada.contains(Point(lon, lat)):
            dentro += 1
    return round(100 * dentro / len(puntos), 1), dentro


def contar_activaciones_manuales(muestras):
    """Cuenta flancos de subida (valor pasa de 0/ausente a >0) en el interruptor
    de fuerza manual, fusionando los que caen a menos de DEBOUNCE_ACTIVACION_MIN
    minutos entre si en una sola activacion -- mismo motivo que el debounce de
    PTO: el interruptor puede generar varias muestras seguidas en >0 durante una
    misma maniobra del conductor, eso NO son activaciones distintas."""
    muestras = sorted(muestras, key=lambda x: x[0])
    activaciones = []
    anterior_valor = 0.0
    for t, v in muestras:
        if v and v > 0 and not (anterior_valor and anterior_valor > 0):
            if activaciones and (t - activaciones[-1]).total_seconds() / 60 < DEBOUNCE_ACTIVACION_MIN:
                pass
            else:
                activaciones.append(t)
        anterior_valor = v
    return activaciones


def main():
    parser = argparse.ArgumentParser(
        description="Valida si los vehiculos que operan en Usaquen usan menos el interruptor de regeneracion manual del DPF.")
    parser.add_argument('--dias-gps', type=int, default=7,
                         help="Ventana reciente (dias) de puntos GPS para clasificar que vehiculos operan en Usaquen.")
    parser.add_argument('--dias-interruptor', type=int, default=60,
                         help="Ventana (dias) para contar activaciones del interruptor de fuerza manual.")
    parser.add_argument('--umbral-pct', type=float, default=15.0,
                         help="Minimo %% de puntos GPS dentro de Usaquen para clasificar el vehiculo como 'opera en Usaquen'.")
    parser.add_argument('--excel', action='store_true')
    args = parser.parse_args()

    print("Cargando poligonos de Usaquen...")
    forma_usaquen, bounds = cargar_forma_usaquen()
    forma_preparada = prep(forma_usaquen)
    print(f"  bbox Usaquen: {bounds}")

    print("Conectando a Geotab...")
    api = gc.conectar_geotab()
    devices = api.get('Device')
    reglas = api.get('Rule')
    regla_alcance, _ = gc.buscar_regla(api, d.NOMBRE_REGLA_ALCANCE, reglas=reglas)
    if not regla_alcance:
        print(f"No se encontro la regla de alcance '{d.NOMBRE_REGLA_ALCANCE}' -- se aborta.")
        return
    grupos_por_id, padre_de, _ = gc.obtener_arbol_grupos(api)
    vehiculos = gc.resolver_vehiculos_en_alcance(devices, regla_alcance, grupos_por_id, padre_de)
    print(f"Vehiculos en alcance (mismo que DPF): {len(vehiculos)}")

    hasta_utc = datetime.now(timezone.utc)
    desde_gps = hasta_utc - timedelta(days=args.dias_gps)
    desde_interruptor = hasta_utc - timedelta(days=args.dias_interruptor)

    filas = []
    for i, v in enumerate(vehiculos, 1):
        print(f"  [{i}/{len(vehiculos)}] {v['name']}...")
        puntos = muestras_logrecord(api, v['id'], desde_gps, hasta_utc)
        pct_usaquen, n_dentro = clasificar_vehiculo(
            [(pd.to_datetime(t), lon, lat) for t, lon, lat in puntos], forma_preparada, bounds)

        muestras_interruptor = api.get('StatusData', search={
            'diagnosticSearch': {'id': d.ID_DIAGNOSTICO_INTERRUPTOR_MANUAL}, 'deviceSearch': {'id': v['id']},
            'fromDate': desde_interruptor.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
            'toDate': hasta_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        }) or []
        serie_interruptor = [(pd.to_datetime(x['dateTime']), float(x['data'])) for x in muestras_interruptor
                              if x.get('data') is not None]
        activaciones = contar_activaciones_manuales(serie_interruptor)

        filas.append({
            'Vehiculo': v['name'],
            'Puntos GPS (ventana)': len(puntos),
            '% puntos en Usaquen': pct_usaquen,
            'Opera en Usaquen': pct_usaquen >= args.umbral_pct,
            'Muestras interruptor': len(serie_interruptor),
            'Activaciones manuales': len(activaciones),
            f'Activaciones/{args.dias_interruptor}d': len(activaciones),
        })

    df = pd.DataFrame(filas).sort_values('% puntos en Usaquen', ascending=False)
    print("\n=== Detalle por vehiculo ===")
    print(df.to_string(index=False))

    grupo_usaquen = df[df['Opera en Usaquen']]
    grupo_resto = df[~df['Opera en Usaquen']]
    print(f"\n=== Comparacion ({len(grupo_usaquen)} en Usaquen vs {len(grupo_resto)} resto) ===")
    if len(grupo_usaquen) == 0:
        print("Ningun vehiculo del alcance quedo clasificado como 'opera en Usaquen' con este umbral -- "
              "subir --dias-gps o bajar --umbral-pct.")
    else:
        prom_usaquen = grupo_usaquen['Activaciones manuales'].mean()
        prom_resto = grupo_resto['Activaciones manuales'].mean() if len(grupo_resto) else float('nan')
        print(f"Promedio activaciones manuales/{args.dias_interruptor}d en Usaquen: {prom_usaquen:.2f} "
              f"({len(grupo_usaquen)} vehiculos)")
        print(f"Promedio activaciones manuales/{args.dias_interruptor}d en el resto: {prom_resto:.2f} "
              f"({len(grupo_resto)} vehiculos)")
        sin_muestras_usaquen = int((grupo_usaquen['Muestras interruptor'] == 0).sum())
        sin_muestras_resto = int((grupo_resto['Muestras interruptor'] == 0).sum())
        if sin_muestras_usaquen or sin_muestras_resto:
            print(f"AVISO: {sin_muestras_usaquen} vehiculo(s) de Usaquen y {sin_muestras_resto} del resto no "
                  f"tuvieron NINGUNA muestra del interruptor en la ventana -- no es lo mismo que '0 activaciones', "
                  f"revisar si reportan el diagnostico antes de concluir.")

    if args.excel:
        ruta = f"cruce_usaquen_regen_manual_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
        df.to_excel(ruta, index=False)
        print(f"\nExcel exportado: {ruta}")


if __name__ == '__main__':
    main()
