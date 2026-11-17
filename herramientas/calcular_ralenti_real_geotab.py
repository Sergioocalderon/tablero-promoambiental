"""
calcular_ralenti_real_geotab.py -- consumo REAL de ralentí, calculado directo de Geotab
==========================================================================================

Complemento de calcular_costo_ralenti.py: ese módulo solo hace el cálculo puro (recibe
horas de ralentí + tasa de combustible ya resueltas). Este script SÍ consulta Geotab en
vivo para resolverlas de verdad, para los vehículos que tienen el sensor.

Definición de "ralentí" usada aquí -- MISMA que la regla ya validada en este proyecto
"Ralentí Excesivo Sin PTO" (velocidad < 1 km/h, ignición encendida, PTO NO enganchado),
pero SIN el piso de duración de 600s (10 min) de esa regla -- para costeo de
combustible interesa el tiempo total, no solo los episodios "excesivos"; un paro de 3
minutos también quema combustible real. Se excluye el tiempo con PTO enganchado a
propósito, igual que la regla: ese es consumo operativo legítimo (compactador
funcionando), no desperdicio -- mezclarlo inflaría el número de "ralentí" reportado.

Unidad de DiagnosticInstantaneousFuelRateId: CONFIRMADO contra la cuenta real
(2026-09-29) que reporta en m³/s, no en L/h -- ver calcular_costo_ralenti.py para el
detalle de cómo se confirmó. La tasa promedio de consumo NO se calcula sobre todas las
muestras del periodo -- se calcula solo con las muestras cuyo timestamp cae DENTRO de
un intervalo de ralentí real (si no, se mezclaría el consumo de manejo, mucho más alto,
con el de ralentí, sobreestimando fuerte el costo del ralentí).

Uso:
    python calcular_ralenti_real_geotab.py --dias 30
    python calcular_ralenti_real_geotab.py --desde 2026-09-01 --hasta 2026-09-29 --salida reporte.xlsx
"""
import argparse
import sys
from datetime import datetime, timedelta, timezone

import pandas as pd

import geotab_comun as gc
import calcular_costo_ralenti as costo

# CAMBIO (2026-09-29, bug real encontrado al probar contra la cuenta): NO existe
# 'DiagnosticSpeedId' como StatusData en esta cuenta (api.get('Diagnostic',
# search={'id':'DiagnosticSpeedId'}) devuelve vacío) -- la velocidad real vive en
# LogRecord.speed (GPS), no en un diagnóstico. Confirma esto la propia regla
# "Ralentí Excesivo Sin PTO": su condición de velocidad usa el conditionType nativo
# "Speed" de Geotab (lee LogRecord), no FilterStatusDataByDiagnostic. Ver
# _muestras_logrecord_velocidad más abajo -- primer intento de este script usaba
# StatusData para todo y daba 0 paros de ralentí en TODOS los vehículos probados
# (silenciosamente mal, no lanzaba error) hasta que se verificó contra datos reales.
ID_DIAGNOSTICO_IGNITION = 'DiagnosticIgnitionId'
ID_DIAGNOSTICO_PTO = 'DiagnosticPowerTakeoffEngagedId'
ID_DIAGNOSTICO_FUEL_RATE = 'DiagnosticInstantaneousFuelRateId'

NOMBRE_REGLA_ALCANCE = 'Ralentí Excesivo Sin PTO'  # solo para resolver alcance de vehículos, no se usan sus ExceptionEvent

# CAMBIO (2026-09-29, hallazgo real): el make/model que Geotab decodifica del VIN no
# siempre coincide con el nombre comercial que usa el usuario -- confirmado contra la
# cuenta real: "Chevrolet NHR" aparece como "Isuzu N Series / ELF / NLR 4x2" (NHR es
# una placa de motor Isuzu vendida bajo licencia Chevrolet en Colombia), y
# Foton/Mercedes-Benz vienen con vinInfoModel VACÍO en varios vehículos. En vez de
# adivinar una correspondencia automática (riesgo real de mapear mal un vehículo a la
# tasa nominal equivocada), esto queda vacío a propósito -- se llena a mano, por
# MÓVIL (no por marca/modelo, que es lo que falla), después de confirmar con la lista
# que main() imprime para cada vehículo "sin dato real" (móvil, placa, marca/modelo
# tal cual lo da Geotab). Ejemplo una vez confirmado:
#   SOBRESCRITURA_MODELO_POR_MOVIL = {'3050-XXX111': 'CHEVROLET NHR'}
SOBRESCRITURA_MODELO_POR_MOVIL = {}

UMBRAL_VELOCIDAD_KMH = 1
# Umbral de "vehículo sin dato real" -- si en todo el periodo no aparece NINGUNA
# muestra del diagnóstico de tasa de combustible, se trata como uno de los 15 sin
# cobertura (necesita tasa nominal). Si aparecen muestras pero ninguna cae dentro de
# un intervalo de ralentí (ej. un vehículo que no paró nada en el periodo), se usa el
# promedio de TODAS sus muestras del periodo como segunda mejor opción -- sigue
# siendo "Real (Geotab)", el vehículo sí tiene el sensor.


def _muestras_statusdata(api, diagnostico_id, id_veh, desde, hasta):
    """Trae TODAS las muestras de un diagnóstico para un vehículo en el rango,
    paginando con el mismo helper ya validado en geotab_comun (evita perder datos en
    rangos grandes -- ver LIMITE_PAGINA_STATUSDATA ahí)."""
    fmt = '%Y-%m-%dT%H:%M:%S.%fZ'
    primera_pagina = api.get('StatusData', search={
        'diagnosticSearch': {'id': diagnostico_id}, 'deviceSearch': {'id': id_veh},
        'fromDate': desde.strftime(fmt), 'toDate': hasta.strftime(fmt),
    }) or []
    completas = gc._completar_paginas_statusdata(api, diagnostico_id, id_veh, primera_pagina, desde, hasta)
    muestras = sorted(
        ((pd.to_datetime(r['dateTime']), r['data']) for r in completas if r.get('data') is not None),
        key=lambda par: par[0]
    )
    return muestras


LIMITE_PAGINA_LOGRECORD = 50000  # mismo tope real de la API que StatusData/FaultData (ver geotab_comun.LIMITE_PAGINA_STATUSDATA)


def _muestras_logrecord_velocidad(api, id_veh, desde, hasta):
    """Velocidad real del vehículo (GPS) -- ver el CAMBIO documentado junto a las
    constantes de diagnóstico: NO existe un StatusData de velocidad en esta cuenta,
    hay que traerla de LogRecord. Denso (puede ser una muestra cada 15-30s por
    vehículo), así que pagina igual que StatusData -- un vehículo real de prueba dio
    9,276 registros en solo 2 días."""
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
            break  # resguardo anti-loop-infinito, mismo patrón que _completar_paginas_statusdata
        desde_actual = nuevo_desde

    muestras = sorted(
        ((pd.to_datetime(r['dateTime']), r['speed']) for r in todos if r.get('speed') is not None),
        key=lambda par: par[0]
    )
    return muestras


def calcular_intervalos_ralenti(muestras_speed, muestras_ignition, muestras_pto, desde, hasta):
    """Reconstruye los intervalos reales de ralentí (velocidad<1, ignición=1,
    PTO no enganchado) a partir de 3 series de StatusData con timestamps
    independientes -- mismo criterio de "último valor conocido" (forward-fill) que
    usa Geotab internamente para evaluar condiciones de regla entre muestras.
    Devuelve lista de (inicio, fin) datetime, y el total de segundos.

    Si al inicio del rango no hay ninguna muestra previa de velocidad o ignición, se
    asume NO-ralentí hasta la primera muestra real (más seguro que asumir quieto sin
    dato) -- para PTO, sin muestra previa se asume NO enganchado (PTO pulsa
    frecuentemente, ver CLAUDE.md, así que en la práctica casi siempre hay una
    muestra reciente si el vehículo está realmente trabajando con el compactador)."""
    eventos = []
    eventos += [(t, 'speed', v) for t, v in muestras_speed]
    eventos += [(t, 'ignition', v) for t, v in muestras_ignition]
    eventos += [(t, 'pto', v) for t, v in muestras_pto]
    eventos.sort(key=lambda e: e[0])

    estado = {'speed': None, 'ignition': None, 'pto': None}

    def es_ralenti():
        if estado['speed'] is None or estado['ignition'] is None:
            return False
        if estado['speed'] >= UMBRAL_VELOCIDAD_KMH:
            return False
        if estado['ignition'] != 1:
            return False
        if estado['pto'] is not None and estado['pto'] >= 1:
            return False
        return True

    intervalos = []
    t_anterior = desde
    ralenti_vigente = False
    for (t, campo, valor) in eventos:
        if t < desde:
            estado[campo] = valor  # arrastrar estado previo al rango, sin generar intervalo
            continue
        if t > hasta:
            break
        if ralenti_vigente and t > t_anterior:
            intervalos.append((t_anterior, t))
        estado[campo] = valor
        ralenti_vigente = es_ralenti()
        t_anterior = t
    if ralenti_vigente and hasta > t_anterior:
        intervalos.append((t_anterior, hasta))

    intervalos = _fusionar_intervalos_cercanos(intervalos)
    total_segundos = sum((fin - inicio).total_seconds() for inicio, fin in intervalos)
    return intervalos, total_segundos


# CAMBIO (2026-09-29, bug real encontrado al probar): sin esto, un vehículo daba
# 2,800-3,900 "paros" en solo 2 días -- físicamente imposible. Causa: ruido de GPS,
# la velocidad fluctúa por unos segundos justo alrededor del umbral de 1 km/h aunque
# el camión esté completamente quieto, así que lo que es UN solo paro real se
# fragmentaba en miles de micro-intervalos separados por gaps de pocos segundos.
# Mismo principio de "debounce" que ya usa el resto del proyecto para parpadeos
# similares (DEBOUNCE_REACTIVACION_MIN en dashboardAnalisisFallas.js,
# VENTANA_PTO_MINUTOS en telegram_alertas.py) -- se fusionan intervalos separados por
# un hueco corto en vez de contarlos como paros distintos. 60s se eligió porque el
# GPS de estos dispositivos pinga cada 15-30s estando quieto (ver
# maxSecondsBetweenLogs=200 en la config del Device, y conteos reales observados) --
# un hueco de 60s cubre 2-3 pings de margen sin fundir paros genuinamente distintos
# que estén separados por minutos. Esto NO cambia el total de horas de ralentí de
# forma relevante (la duración fusionada sigue sumando prácticamente lo mismo, los
# huecos que se "rellenan" son de segundos) -- solo limpia el CONTEO de paros para
# que sea creíble, y de paso deja intervalos más robustos para cruzar contra las
# muestras de tasa de combustible.
UMBRAL_FUSION_INTERVALOS_SEG = 60


def _fusionar_intervalos_cercanos(intervalos, umbral_segundos=UMBRAL_FUSION_INTERVALOS_SEG):
    if not intervalos:
        return []
    fusionados = [intervalos[0]]
    for inicio, fin in intervalos[1:]:
        ultimo_inicio, ultimo_fin = fusionados[-1]
        if (inicio - ultimo_fin).total_seconds() <= umbral_segundos:
            fusionados[-1] = (ultimo_inicio, max(ultimo_fin, fin))
        else:
            fusionados.append((inicio, fin))
    return fusionados


def _timestamp_en_intervalos(t, intervalos):
    # Lineal a propósito -- los intervalos por vehículo/periodo son pocos (decenas a
    # unos pocos cientos), no vale la pena una estructura más compleja.
    for inicio, fin in intervalos:
        if inicio <= t <= fin:
            return True
        if t < inicio:
            return False  # intervalos vienen ordenados por inicio
    return False


def tasa_promedio_en_ralenti(muestras_fuel_rate_m3_s, intervalos):
    """Devuelve (tasa_l_h_promedio, n_muestras_usadas, uso_fallback) sobre las
    muestras de tasa de combustible que cayeron DENTRO de los intervalos de ralentí
    -- ya convertidas de m3/s a L/h (ver docstring del módulo). Si el vehículo tiene
    muestras pero ninguna cayó en un intervalo de ralentí (ej. no paró en el
    periodo), usa el promedio de TODAS sus muestras como segunda mejor opción
    (uso_fallback=True) en vez de descartar el vehículo."""
    if not muestras_fuel_rate_m3_s:
        return None, 0, False

    en_ralenti = [v for (t, v) in muestras_fuel_rate_m3_s if _timestamp_en_intervalos(t, intervalos)]
    if en_ralenti:
        valores_l_h = [costo.metros_cubicos_por_segundo_a_litros_por_hora(v) for v in en_ralenti]
        return sum(valores_l_h) / len(valores_l_h), len(valores_l_h), False

    todas_l_h = [costo.metros_cubicos_por_segundo_a_litros_por_hora(v) for (_, v) in muestras_fuel_rate_m3_s]
    return sum(todas_l_h) / len(todas_l_h), len(todas_l_h), True


def procesar_vehiculo(api, dispositivo, empresa_nombre, desde, hasta):
    id_veh = dispositivo['id']
    muestras_speed = _muestras_logrecord_velocidad(api, id_veh, desde, hasta)
    muestras_ignition = _muestras_statusdata(api, ID_DIAGNOSTICO_IGNITION, id_veh, desde, hasta)
    muestras_pto = _muestras_statusdata(api, ID_DIAGNOSTICO_PTO, id_veh, desde, hasta)
    muestras_fuel = _muestras_statusdata(api, ID_DIAGNOSTICO_FUEL_RATE, id_veh, desde, hasta)

    intervalos, total_segundos = calcular_intervalos_ralenti(muestras_speed, muestras_ignition, muestras_pto, desde, hasta)
    horas_ralenti = total_segundos / 3600

    tasa_l_h, n_muestras, uso_fallback = tasa_promedio_en_ralenti(muestras_fuel, intervalos)

    # CAMBIO (2026-09-29, hallazgo real al probar contra la cuenta): Device.comment
    # viene VACÍO en esta cuenta -- el modelo real vive en vinInfoMake/vinInfoModel
    # (decodificado del VIN por Geotab). PERO ese decodificado NO siempre coincide
    # con el nombre comercial que usa el usuario: "Chevrolet NHR" en Geotab aparece
    # como "Isuzu N Series / ELF / NLR 4x2" (NHR es una placa de motor Isuzu vendida
    # bajo licencia Chevrolet en Colombia), y Foton/Mercedes-Benz vienen con
    # vinInfoModel VACÍO -- el VIN no siempre trae esa parte decodificable. Por eso
    # NO se intenta adivinar el nombre comercial aquí: se reporta el make/model tal
    # cual lo da Geotab, y main() imprime también la placa de cada vehículo "sin
    # dato real" para que el mapeo a TASAS_NOMINALES_GAL_H lo confirme una persona.
    nombre_movil = dispositivo.get('name', id_veh)
    marca_geotab = (dispositivo.get('vinInfoMake') or '').strip()
    modelo_geotab = (dispositivo.get('vinInfoModel') or '').strip()
    modelo_texto = SOBRESCRITURA_MODELO_POR_MOVIL.get(nombre_movil) or (marca_geotab + ' ' + modelo_geotab).strip() or None

    return costo.VehiculoRalenti(
        movil=nombre_movil,
        empresa=empresa_nombre,
        horas_ralenti=round(horas_ralenti, 3),
        modelo=modelo_texto,
        tasa_l_h=tasa_l_h,
        confiabilidad=('estimado con promedio de todo el periodo, no solo ralentí -- revisar' if uso_fallback else None),
    ), n_muestras, len(intervalos)


def main():
    parser = argparse.ArgumentParser(description="Calcula consumo real de ralentí para toda la flota, consultando Geotab en vivo.")
    grupo_fecha = parser.add_mutually_exclusive_group()
    grupo_fecha.add_argument('--dias', type=int, default=30, help="Días hacia atrás desde ahora (por defecto 30).")
    parser.add_argument('--desde', help="YYYY-MM-DD, alternativa a --dias.")
    parser.add_argument('--hasta', help="YYYY-MM-DD, por defecto ahora.")
    parser.add_argument('--empresa', default='Promoambiental')
    parser.add_argument('--salida', default='reporte_ralenti_real.xlsx')
    parser.add_argument('--limite', type=int, default=None, help="Procesa solo los primeros N vehículos del alcance -- útil para probar antes de correr la flota completa (80 vehículos x 4 diagnósticos puede tardar).")
    args = parser.parse_args()

    hasta = datetime.strptime(args.hasta, '%Y-%m-%d').replace(tzinfo=timezone.utc) if args.hasta else datetime.now(timezone.utc)
    desde = datetime.strptime(args.desde, '%Y-%m-%d').replace(tzinfo=timezone.utc) if args.desde else hasta - timedelta(days=args.dias)

    print(f"Conectando a Geotab... periodo {desde.date()} a {hasta.date()}")
    api = gc.conectar_geotab()
    devices = api.get('Device')
    grupos_por_id, padre_de, _ = gc.obtener_arbol_grupos(api)
    regla, parecidas = gc.buscar_regla(api, NOMBRE_REGLA_ALCANCE)
    if not regla:
        print(f"ERROR: no se encontró la regla '{NOMBRE_REGLA_ALCANCE}' para resolver el alcance. Parecidas: {parecidas}", file=sys.stderr)
        sys.exit(1)
    en_alcance = gc.resolver_vehiculos_en_alcance(devices, regla, grupos_por_id, padre_de)
    print(f"Vehículos en alcance: {len(en_alcance)}")
    if args.limite:
        en_alcance = en_alcance[:args.limite]
        print(f"--limite activo: procesando solo {len(en_alcance)} vehículo(s).")

    vehiculos_resultado = []
    sin_dato_real = []
    vehiculos_fallidos = []
    for i, dispositivo in enumerate(en_alcance, 1):
        nombre = dispositivo.get('name', dispositivo['id'])
        # CAMBIO (2026-09-29, bug real: se perdieron 15 de 80 vehiculos en la
        # primera corrida completa): un corte transitorio de conectividad con
        # user.copiloto.app (mismo problema ya visto con vigilancia_regeneracion.py)
        # tumbo la sesion a mitad de camino -- SIN reconexion, cada vehiculo
        # siguiente fallaba igual en cascada (ServiceUnavailable / 404) hasta el
        # final del barrido. Mismo patron ya validado en ese otro script: ante
        # cualquier error, reconectar y reintentar UNA vez el mismo vehiculo antes
        # de darlo por perdido -- un corte de segundos no deberia costar el 19% de
        # la flota.
        try:
            veh, n_muestras, n_intervalos = procesar_vehiculo(api, dispositivo, args.empresa, desde, hasta)
        except Exception as e:
            print(f"  [{i}/{len(en_alcance)}] {nombre}: ERROR -- {e} -- reconectando y reintentando...", file=sys.stderr)
            try:
                api = gc.conectar_geotab()
                veh, n_muestras, n_intervalos = procesar_vehiculo(api, dispositivo, args.empresa, desde, hasta)
                print(f"  [{i}/{len(en_alcance)}] {nombre}: OK tras reintento.")
            except Exception as e2:
                print(f"  [{i}/{len(en_alcance)}] {nombre}: ERROR de nuevo tras reconectar -- {e2} -- se omite este vehículo.", file=sys.stderr)
                vehiculos_fallidos.append(nombre)
                continue
        if veh.tasa_l_h is None:
            sin_dato_real.append(veh)
            placa = dispositivo.get('licensePlate', '')
            marca_modelo = veh.modelo or '(sin marca/modelo decodificado por Geotab)'
            print(f"  [{i}/{len(en_alcance)}] {nombre} (placa {placa}): SIN dato real (0 muestras de tasa de combustible), {veh.horas_ralenti:.1f}h de ralentí -- Geotab lo decodifica como '{marca_modelo}', confirma el nombre comercial real y agrégalo a SOBRESCRITURA_MODELO_POR_MOVIL o TASAS_NOMINALES_GAL_H si no coincide.")
        else:
            aviso = f" ({veh.confiabilidad})" if veh.confiabilidad else ""
            print(f"  [{i}/{len(en_alcance)}] {nombre}: {veh.horas_ralenti:.1f}h ralentí, {n_intervalos} paro(s), tasa {veh.tasa_l_h:.2f} L/h de {n_muestras} muestra(s){aviso}")
        vehiculos_resultado.append(veh)

    print(f"\n{len(vehiculos_resultado) - len(sin_dato_real)} vehículo(s) con dato real, {len(sin_dato_real)} necesitan tasa nominal por modelo.")
    if vehiculos_fallidos:
        print(f"ATENCIÓN: {len(vehiculos_fallidos)} vehículo(s) se perdieron incluso tras reconectar y reintentar -- no están en el reporte: {vehiculos_fallidos}")
    if sin_dato_real:
        modelos_faltantes = sorted(set((v.modelo or '(sin marca/modelo decodificado por Geotab)') for v in sin_dato_real))
        print("Modelos sin tasa nominal aún en TASAS_NOMINALES_GAL_H:", modelos_faltantes)

    # CAMBIO (2026-09-29, pedido explícito del usuario: "dame el archivo para
    # validar" antes de tener las 3 tasas nominales confirmadas): estricto=False --
    # el reporte SIEMPRE se genera con los 80 vehículos, incluso si a algunos les
    # falta la tasa nominal. Esos quedan con Consumo=vacío y Origen='Pendiente (sin
    # tasa nominal)', nunca con un número inventado -- se completan solos apenas se
    # llene TASAS_NOMINALES_GAL_H (o SOBRESCRITURA_MODELO_POR_MOVIL) y se corra de
    # nuevo, sin tener que esperar a tener las 3 tasas listas para ver el reporte.
    reporte = costo.calcular_consumo_flota(vehiculos_resultado, estricto=False)
    pendientes = int((reporte['Origen del Dato'] == costo.ORIGEN_PENDIENTE).sum())

    reporte.to_excel(args.salida, index=False)
    print(f"\nReporte guardado en {args.salida}")
    if pendientes:
        print(f"{pendientes} vehículo(s) quedaron como '{costo.ORIGEN_PENDIENTE}' -- confirma sus tasas nominales y vuelve a correr para completarlos.")
    print(reporte.groupby('Origen del Dato')['Consumo total (galones)'].agg(['count', 'sum']))


if __name__ == '__main__':
    main()
