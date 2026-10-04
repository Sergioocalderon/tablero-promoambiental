"""
detectar_regeneracion_dpf.py -- deteccion de regeneracion del DPF por tendencia del % de hollin
==================================================================================================

Contexto (sesion 2026-09-22): el enfoque de usar un diagnostico dedicado de
Geotab ("Estado de regeneracion activa del filtro de particulas diesel",
a2MenjAEB90iHUfy6X1oc2A, 48/64 vehiculos con datos -- ver regla piloto
R_REGENERACION ACTIVA DEL FILTRO DE PARTICULAS DIESEL) ya se habia probado
antes de esta sesion y no fue efectivo (motivo exacto no recordado por el
usuario). Los diagnosticos de temperatura de gases de escape/postratamiento
tampoco sirven como alternativa: se revisaron 4 variantes distintas
(generica + admision/salida/intermedia del DPF) y NINGUNA reporta datos en
esta flota (0/64 vehiculos, 30 dias).

Por eso este script detecta la regeneracion directamente de la UNICA senal con
cobertura completa: el % de carga de hollin (aYtF4cSGobUSRCKo8yfjyIg, 64/64
vehiculos, ~160k muestras/60d). No puede vivir como una regla de Geotab en
vivo porque Geotab no tiene un tipo de condicion nativo para "tendencia
bajando en el tiempo" -- por eso es un script de analisis historico, no una
alerta en tiempo real (mismo motivo por el que la confirmacion de PTO vive en
codigo, no en la condicion de la regla, ver VENTANA_PTO_MINUTOS).

Logica de deteccion (ver validacion de R_SATURACION DPF, sesion 2026-09-22):
  1. Se descartan el techo del sensor (>=199) y las subidas bruscas -- son la firma de
     (ANTES: toda lectura >=150%, ver CAMBIO 2026-10-03 junto a UMBRAL_TECHO_PCT)
     error de sensor/comunicacion ya confirmada con datos reales (salto de
     70-100% a 176-200% en <1s, sin relacion con saturacion real). Sin este
     filtro, la "caida" del pico de ruido de vuelta a un valor normal se
     contaria como una regeneracion falsa.
  2. Sobre las lecturas limpias, se busca en cada punto el minimo alcanzado en
     los siguientes VENTANA_BUSQUEDA_MIN minutos. Si la caida (valor actual
     menos ese minimo) es >= CAIDA_MINIMA_PCT, se marca como inicio de una
     regeneracion candidata.
  3. Inicios candidatos a menos de DEBOUNCE_MIN minutos entre si se fusionan
     en un solo episodio (mismo principio de debounce ya usado para episodios
     de falla en dashboardAnalisisFallas.js / calcularEpisodiosPorGrupo).

Limitacion conocida: es una heuristica sobre UNA sola senal, no una medicion
directa de "regeneracion activa" como tal -- cualquier caida sostenida del %
de hollin por otro motivo (cambio real del filtro, reset del sensor tras
mantenimiento) se contaria igual. No hay forma de diferenciarlo sin el
diagnostico dedicado, que ya sabemos que SI reporta datos pero que no dio
buen resultado la vez anterior por un motivo que no se pudo confirmar.

USO:
  python detectar_regeneracion_dpf.py --dias 30
  python detectar_regeneracion_dpf.py --dias 30 --vehiculo 1150
  python detectar_regeneracion_dpf.py --dias 30 --excel

  Cruzar los episodios detectados por tendencia contra los ExceptionEvent
  reales de la regla piloto del diagnostico dedicado (robustece la prueba:
  si ambas senales coinciden en el tiempo, sube la confianza de las dos a
  la vez; si divergen mucho, es la primera pista concreta de que fallo el
  intento anterior con el diagnostico dedicado):
  python detectar_regeneracion_dpf.py --dias 30 --cruzar-regla

  Investigar un caso puntual reportado por alguien en campo (ej. "vi el
  testigo encendido y luego apagado en el vehiculo X, a esta hora") -- trae
  las 4 senales relevantes (diagnostico dedicado, hollin, testigo, interruptor
  manual) en una sola linea de tiempo alrededor de la hora reportada, para
  poder confirmar o descartar el caso con datos reales en vez de a mano
  (ver sesion 2026-09-25, caso real de 1154-NWX543):
  python detectar_regeneracion_dpf.py --investigar --vehiculo "1154-NWX543" --cuando "2026-09-24 23:31"
  python detectar_regeneracion_dpf.py --investigar --vehiculo "1154-NWX543" --cuando "2026-09-24 23:31" --ventana-horas 3
"""
import argparse
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd

import geotab_comun as gc

ID_DIAGNOSTICO_HOLLIN = 'aYtF4cSGobUSRCKo8yfjyIg'
# "Estado de regeneracion activa del filtro de particulas diesel" -- el
# diagnostico dedicado detras de la regla piloto (ver NOMBRE_REGLA_PILOTO).
ID_DIAGNOSTICO_REGEN_ACTIVA = 'a2MenjAEB90iHUfy6X1oc2A'
ID_DIAGNOSTICO_LAMPARA = 'DiagnosticDieselParticulateFilterLampId'
ID_DIAGNOSTICO_INTERRUPTOR_MANUAL = 'aXfHYX0HFtUaOOr_scNuSsg'
# Misma regla usada para resolver el alcance (64 vehiculos) que las 5 reglas
# de saturacion DPF -- reutiliza el mismo criterio de alcance, no lo duplica.
NOMBRE_REGLA_ALCANCE = 'R_SATURACIÓN DPF 110% - C.'
# Regla piloto creada el 2026-09-22 sobre "Estado de regeneracion activa del
# filtro de particulas diesel" (a2MenjAEB90iHUfy6X1oc2A) -- ver estado_reglas.md.
NOMBRE_REGLA_PILOTO = 'R_REGENERACIÓN ACTIVA DEL FILTRO DE PARTÍCULAS DIÉSEL'
VENTANA_CRUCE_MIN = 15  # tolerancia +/- para considerar que un evento de la regla "confirma" un episodio detectado
# CAMBIO (2026-09-26): sesiones de la regla piloto mas largas que esto NO son
# ruido ni un bug -- se investigo a fondo (ver memoria del proyecto) y son
# evidencia real de regeneraciones que el motor no logra completar de un
# tiron: la flota es mayoritariamente de recoleccion de basura, que opera
# mas en ralenti/paradas cortas que en marcha sostenida (confirmado con un
# caso real: 62.7h con 71 Trips de ~20min cada uno en esa ventana -- el ECM
# reintenta la regeneracion cada vez que el camion vuelve a arrancar). Por
# eso NO se descartan sin mas: se excluyen del cruce contra el detector de
# hollin (una regeneracion interrumpida de dias no deja una caida limpia que
# el heuristico pueda encontrar, y contarla igual infla el % de coincidencia
# artificialmente) pero se reportan APARTE como su propia categoria -- ver
# analizar_sesiones_prolongadas -- porque es probablemente el hallazgo mas
# accionable de todo esto: que vehiculos estan luchando para regenerar.
UMBRAL_SESION_PROLONGADA_HORAS = 8
TZ_BOGOTA = ZoneInfo('America/Bogota')

# CAMBIO (2026-10-03, validación contra regeneraciones de referencia): antes se
# descartaba toda lectura >= 150 % como ruido (UMBRAL_RUIDO_PCT). Pero en 5
# vehículos (3095-GVT513, 3098-GVT565, 3802-GVU035, 1094-GVT586, 3094-GVT509)
# entre el 20 % y el 67 % de las lecturas están en 150-199 con subidas
# GRADUALES y reales (ej. 3802-GVU035: 96 → 118 → 142 → 155 → 173 → 190), y
# sus regeneraciones (177 → 151 → 122 → 110 en ~40 min) quedaban invisibles.
# El ruido documentado el 2026-09-22 es otro patrón: el techo de 200 y saltos
# bruscos de 70 a 176-200 en segundos, más vaivenes rápidos (95 → 176 → 126 →
# 194 en 5 min). Ahora se descarta solo eso:
#  - lecturas en el techo (>= UMBRAL_TECHO_PCT),
#  - subidas bruscas (>= SALTO_RUIDO_PP en <= SALTO_RUIDO_SEG respecto de la
#    lectura anterior ya aceptada),
#  - y una caída solo cuenta si se SOSTIENE: en los VENTANA_SOSTENIDA_MIN
#    siguientes el hollín no rebota más de la mitad de lo que bajó.
# Medido (21 días, 58 vehículos), contra 40 regeneraciones de referencia (38
# cierres de lámpara de la vigilancia corregida + 2 casos de campo): el filtro
# anterior detectaba 34/40 y contaba 1.031 episodios; este detecta 35/40 con
# 1.013 (deja de contar 39 vaivenes de ruido y agrega 26 regeneraciones reales).
UMBRAL_TECHO_PCT = 199
SALTO_RUIDO_PP = 40
SALTO_RUIDO_SEG = 300
VENTANA_SOSTENIDA_MIN = 15


def limpiar_lecturas_hollin(lecturas):
    """Quita el techo del sensor y las subidas bruscas (ver CAMBIO 2026-10-03)."""
    limpias = []
    for t, v in lecturas:
        if v >= UMBRAL_TECHO_PCT:
            continue
        if limpias and v - limpias[-1][1] >= SALTO_RUIDO_PP and (t - limpias[-1][0]).total_seconds() <= SALTO_RUIDO_SEG:
            continue
        limpias.append((t, v))
    return limpias
# CAMBIO (2026-09-25, bug real encontrado con --investigar sobre un caso real
# reportado en campo -- 1154-NWX543, 24-sept 23:11-23:29): una regeneracion
# real y grande (16% -> 2%) NO fue detectada porque la siguiente lectura de
# hollin llego a los 30 min y 1 SEGUNDO -- justo un instante despues del
# limite de VENTANA_BUSQUEDA_MIN=30, que coincide casi exacto con el
# intervalo de muestreo real del hollin (~30 min). Cualquier jitter de unos
# segundos en el momento exacto del muestreo puede sacar la lectura que
# confirma la caida fuera de la ventana. Subido a 40 min para dar margen real
# sin perder precision (una regeneracion dura minutos, no se confunde con
# nada que tome 30-40 min en pasar).
VENTANA_BUSQUEDA_MIN = 40   # minutos hacia adelante para buscar el minimo tras cada lectura
CAIDA_MINIMA_PCT = 10       # caida minima en puntos porcentuales para contar como regeneracion candidata
DEBOUNCE_MIN = 15           # inicios candidatos a menos de esto entre si se fusionan en un solo episodio


def detectar_episodios_vehiculo(lecturas):
    """lecturas: lista de (datetime, valor) ordenada por tiempo, SIN filtrar.
    Devuelve lista de episodios: {inicio, fin, valor_inicio, valor_fin, caida, duracion_min}."""
    limpias = limpiar_lecturas_hollin(lecturas)
    n = len(limpias)
    if n < 2:
        return []

    candidatos = []
    for i in range(n):
        t_i, v_i = limpias[i]
        limite = t_i + timedelta(minutes=VENTANA_BUSQUEDA_MIN)
        v_min, t_min = v_i, t_i
        j = i + 1
        while j < n and limpias[j][0] <= limite:
            if limpias[j][1] < v_min:
                v_min, t_min = limpias[j][1], limpias[j][0]
            j += 1
        caida = v_i - v_min
        if caida >= CAIDA_MINIMA_PCT:
            candidatos.append({'inicio': t_i, 'fin': t_min, 'valor_inicio': v_i, 'valor_fin': v_min, 'caida': caida})

    if not candidatos:
        return []

    # Fusionar candidatos a menos de DEBOUNCE_MIN entre si -- mismo principio
    # de debounce ya usado para episodios de falla en el dashboard.
    episodios = [dict(candidatos[0])]
    for c in candidatos[1:]:
        anterior = episodios[-1]
        if (c['inicio'] - anterior['inicio']).total_seconds() <= DEBOUNCE_MIN * 60:
            if c['valor_fin'] < anterior['valor_fin']:
                anterior['fin'] = c['fin']
                anterior['valor_fin'] = c['valor_fin']
                anterior['caida'] = anterior['valor_inicio'] - anterior['valor_fin']
        else:
            episodios.append(dict(c))

    # Solo cuentan las caídas que se sostienen (ver CAMBIO 2026-10-03).
    sostenidos = []
    for e in episodios:
        tras = [v for t, v in limpias if e['fin'] < t <= e['fin'] + timedelta(minutes=VENTANA_SOSTENIDA_MIN)]
        if all(v <= e['valor_fin'] + e['caida'] / 2 for v in tras):
            sostenidos.append(e)
    episodios = sostenidos

    for e in episodios:
        e['duracion_min'] = round((e['fin'] - e['inicio']).total_seconds() / 60, 1)
    return episodios


def obtener_eventos_regla_piloto(api, vehiculos, desde, hasta):
    """Trae los ExceptionEvent reales de la regla piloto del diagnostico
    dedicado, agrupados por id de vehiculo -- lista de (activeFrom, activeTo)
    por vehiculo. Devuelve {} si la regla no existe (ej. se borro despues)."""
    regla_piloto, parecidas = gc.buscar_regla(api, NOMBRE_REGLA_PILOTO, reglas=api.get('Rule'))
    if not regla_piloto:
        print(f"AVISO: no se encontro la regla piloto '{NOMBRE_REGLA_PILOTO}'. Parecidas: {parecidas}")
        print("       Se omite el cruce.")
        return None

    eventos = api.get('ExceptionEvent', search={
        'ruleSearch': {'id': regla_piloto['id']},
        'fromDate': desde.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        'toDate': hasta.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
    }) or []

    por_vehiculo = {}
    n_prolongadas = 0
    for e in eventos:
        id_veh = e['device']['id'] if isinstance(e.get('device'), dict) else e.get('device')
        af = pd.to_datetime(e['activeFrom'])
        at = pd.to_datetime(e['activeTo']) if e.get('activeTo') else af
        if (at - af).total_seconds() / 3600 > UMBRAL_SESION_PROLONGADA_HORAS:
            # Regeneracion prolongada/interrumpida (ver comentario de
            # UMBRAL_SESION_PROLONGADA_HORAS) -- se excluye SOLO del cruce
            # contra el detector de hollin, no se descarta del todo: ver
            # analizar_sesiones_prolongadas para el reporte dedicado.
            n_prolongadas += 1
            continue
        por_vehiculo.setdefault(id_veh, []).append((af, at))

    total_usables = len(eventos) - n_prolongadas
    print(f"Eventos reales de la regla piloto en la ventana: {len(eventos)} (regla id={regla_piloto['id']})")
    if n_prolongadas:
        print(f"  -> {n_prolongadas} son regeneraciones prolongadas/interrumpidas (>{UMBRAL_SESION_PROLONGADA_HORAS}h, "
              f"ver 'Regeneraciones prolongadas' más abajo) -- se excluyen del cruce contra hollín, quedan {total_usables} usables.")
    return por_vehiculo


ID_DIAGNOSTICO_HORAS_MOTOR = 'DiagnosticEngineHoursId'


def analizar_sesiones_prolongadas(api, vehiculos, desde, hasta):
    """Reporta APARTE las sesiones de la regla piloto mas largas que
    UMBRAL_SESION_PROLONGADA_HORAS -- ver el comentario junto a esa
    constante para el porque. Para cada una, trae los Trip del vehiculo en
    esa misma ventana como evidencia (muchos viajes cortos = operacion en
    ralenti/paradas, consistente con una regeneracion que no logra
    completarse de un tiron).

    CAMBIO (2026-09-29, caso real investigado: 3094-GVT509): no todas las
    sesiones prolongadas son "regeneracion interrumpida" -- ese vehiculo
    llevaba 9+ dias con el motor APAGADO (ignicion=0, GPS fijo en el mismo
    sitio, sin ninguna muestra nueva de horas de motor) cuando la sesion
    "prolongada" en realidad es solo la ULTIMA lectura del diagnostico
    dedicado, congelada porque no hay motor encendido para generar una
    nueva. Se distingue revisando si las Horas de Motor avanzaron algo
    DENTRO de la ventana -- si no avanzaron nada, es 'Posible fuera de
    servicio' (vehiculo parado, no un problema de regeneracion), no
    'Regeneracion interrumpida' (el patron real de para-y-arranca)."""
    regla_piloto, _ = gc.buscar_regla(api, NOMBRE_REGLA_PILOTO, reglas=api.get('Rule'))
    if not regla_piloto:
        return []

    eventos = api.get('ExceptionEvent', search={
        'ruleSearch': {'id': regla_piloto['id']},
        'fromDate': desde.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        'toDate': hasta.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
    }) or []

    nombre_por_id = {v['id']: v.get('name', v['id']) for v in vehiculos}
    prolongadas = []
    for e in eventos:
        af = pd.to_datetime(e['activeFrom'])
        at = pd.to_datetime(e['activeTo']) if e.get('activeTo') else af
        dur_h = (at - af).total_seconds() / 3600
        if dur_h <= UMBRAL_SESION_PROLONGADA_HORAS:
            continue
        id_veh = e['device']['id'] if isinstance(e.get('device'), dict) else e.get('device')
        trips = api.get('Trip', search={
            'deviceSearch': {'id': id_veh},
            'fromDate': af.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
            'toDate': at.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        }) or []
        dur_viajes = [(t['stop'] - t['start']).total_seconds() / 60 for t in trips if t.get('start') and t.get('stop')]

        # CAMBIO (2026-09-29, bug real: 3094-GVT509 seguia marcando "interrumpida"):
        # comparar min/max de TODA la ventana no alcanza -- ese vehiculo tuvo
        # actividad real el 16-19 de septiembre y despues quedo 10 dias sin
        # ninguna muestra nueva, pero como hubo ALGUN cambio en algun punto de
        # la ventana completa, el chequeo anterior daba "avanzo" igual. Lo que
        # importa es si hay actividad RECIENTE (cerca del final de la ventana,
        # que suele ser "ahora"), no si hubo actividad en cualquier momento.
        horas_motor = api.get('StatusData', search={
            'diagnosticSearch': {'id': ID_DIAGNOSTICO_HORAS_MOTOR}, 'deviceSearch': {'id': id_veh},
            'fromDate': af.strftime('%Y-%m-%dT%H:%M:%S.%fZ'), 'toDate': at.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        }) or []
        if not horas_motor:
            categoria = 'Posible fuera de servicio'
        else:
            ultima_muestra = max(pd.to_datetime(x['dateTime']) for x in horas_motor)
            horas_sin_dato_reciente = (at - ultima_muestra).total_seconds() / 3600
            categoria = 'Posible fuera de servicio' if horas_sin_dato_reciente > 24 else 'Regeneración interrumpida'

        prolongadas.append({
            'Vehiculo': nombre_por_id.get(id_veh, id_veh),
            'Categoria': categoria,
            'Inicio': af,
            'Fin': at,
            'Duracion (h)': round(dur_h, 1),
            'Viajes en la ventana': len(trips),
            'Dur. promedio viaje (min)': round(sum(dur_viajes) / len(dur_viajes), 1) if dur_viajes else None,
        })
    return prolongadas


def cruzar_episodio_con_regla(episodio, eventos_vehiculo):
    """True si algun evento de la regla piloto se solapa (con tolerancia
    VENTANA_CRUCE_MIN) con el episodio detectado por tendencia."""
    if not eventos_vehiculo:
        return False
    desde = episodio['inicio'] - timedelta(minutes=VENTANA_CRUCE_MIN)
    hasta = episodio['fin'] + timedelta(minutes=VENTANA_CRUCE_MIN)
    return any(af <= hasta and at >= desde for af, at in eventos_vehiculo)


def investigar_incidente(api, vehiculo, cuando_utc, ventana_horas):
    """Reconstruye, para UN vehiculo y una hora reportada (ej. por una foto de
    campo), una linea de tiempo unica con las 4 senales relevantes: el
    diagnostico dedicado de regeneracion activa, el % de hollin, el testigo
    (lampara) y el interruptor de fuerza manual -- mas los eventos reales de
    la regla piloto en esa ventana. Formalizado a partir del caso real de
    1154-NWX543 (sesion 2026-09-25): antes esto se armaba a mano cada vez,
    ahora es un modo reutilizable del script.
    """
    desde = cuando_utc - timedelta(hours=ventana_horas)
    hasta = cuando_utc + timedelta(hours=ventana_horas)
    fmt = '%Y-%m-%dT%H:%M:%S.%fZ'

    print(f"\nVehiculo: {vehiculo['name']}")
    print(f"Ventana revisada: {desde.astimezone(TZ_BOGOTA).strftime('%Y-%m-%d %H:%M:%S')} "
          f"a {hasta.astimezone(TZ_BOGOTA).strftime('%Y-%m-%d %H:%M:%S')} (hora Bogota)")
    print(f"Hora reportada: {cuando_utc.astimezone(TZ_BOGOTA).strftime('%Y-%m-%d %H:%M:%S')} (hora Bogota)\n")

    diagnosticos = {
        ID_DIAGNOSTICO_REGEN_ACTIVA: 'Diagnostico dedicado (regeneracion activa)',
        ID_DIAGNOSTICO_HOLLIN: '% de hollin',
        ID_DIAGNOSTICO_LAMPARA: 'Testigo/lampara DPF',
        ID_DIAGNOSTICO_INTERRUPTOR_MANUAL: 'Interruptor de fuerza manual',
    }
    llamadas = [
        ('Get', {'typeName': 'StatusData', 'search': {
            'diagnosticSearch': {'id': did}, 'deviceSearch': {'id': vehiculo['id']},
            'fromDate': desde.strftime(fmt), 'toDate': hasta.strftime(fmt),
        }})
        for did in diagnosticos
    ]
    resultados = api.multi_call(llamadas)

    # Linea de tiempo unica: todas las senales intercaladas y ordenadas por hora,
    # en vez de un bloque separado por diagnostico -- asi se lee de corrido "que
    # paso primero, que paso despues" sin tener que cruzar 4 tablas a mano.
    eventos_linea_tiempo = []
    hollin_serie = []
    for did, lecturas in zip(diagnosticos.keys(), resultados):
        etiqueta = diagnosticos[did]
        for l in lecturas or []:
            try:
                t = pd.to_datetime(l['dateTime'])
                v = float(l.get('data'))
            except (TypeError, ValueError):
                continue
            eventos_linea_tiempo.append((t, etiqueta, v))
            if did == ID_DIAGNOSTICO_HOLLIN:
                hollin_serie.append((t, v))
    eventos_linea_tiempo.sort(key=lambda x: x[0])

    if not eventos_linea_tiempo:
        print("Sin ninguna muestra de estos 4 diagnosticos en la ventana -- no se puede reconstruir nada.")
        return

    print("=== Linea de tiempo (todas las senales) ===")
    for t, etiqueta, v in eventos_linea_tiempo:
        marca = '  <-- HORA REPORTADA' if abs((t - cuando_utc).total_seconds()) < 60 else ''
        print(f"  {t.astimezone(TZ_BOGOTA).strftime('%H:%M:%S')}  {etiqueta:<45} {v}{marca}")

    # Episodios de regeneracion (por tendencia de hollin) dentro de la ventana.
    hollin_serie.sort(key=lambda x: x[0])
    episodios = detectar_episodios_vehiculo(hollin_serie)
    print(f"\n=== Episodios detectados por caida de hollin en la ventana ({len(episodios)}) ===")
    for e in episodios:
        print(f"  {e['inicio'].astimezone(TZ_BOGOTA).strftime('%H:%M:%S')} -> "
              f"{e['fin'].astimezone(TZ_BOGOTA).strftime('%H:%M:%S')}  "
              f"({e['valor_inicio']:.0f}% -> {e['valor_fin']:.0f}%, cayo {e['caida']:.0f} pp en {e['duracion_min']:.0f} min)")

    # Eventos reales de la regla piloto en la misma ventana.
    eventos_regla = obtener_eventos_regla_piloto(api, [vehiculo], desde, hasta) or {}
    eventos_vehiculo = eventos_regla.get(vehiculo['id'], [])
    print(f"\n=== Eventos de la regla piloto en la ventana ({len(eventos_vehiculo)}) ===")
    for af, at in sorted(eventos_vehiculo):
        dur_min = (at - af).total_seconds() / 60
        print(f"  {af.astimezone(TZ_BOGOTA).strftime('%H:%M:%S')} -> {at.astimezone(TZ_BOGOTA).strftime('%H:%M:%S')} ({dur_min:.0f} min)")

    # Aviso si el testigo/interruptor no tuvieron NINGUNA muestra en la ventana
    # -- mismo hallazgo de la sesion 2026-09-25: su muestreo es tan espaciado
    # (horas entre lecturas) que un encendido/apagado corto puede pasar
    # completamente invisible, y eso NO significa que no haya pasado.
    for did in (ID_DIAGNOSTICO_LAMPARA, ID_DIAGNOSTICO_INTERRUPTOR_MANUAL):
        if not any(etq == diagnosticos[did] for _, etq, _ in eventos_linea_tiempo):
            print(f"\nAVISO: '{diagnosticos[did]}' no tuvo NINGUNA muestra dentro de esta ventana -- su muestreo es "
                  f"espaciado (a veces horas entre lecturas), asi que esto NO confirma que no haya cambiado de "
                  f"valor, solo que no lo alcanzamos a capturar. No tratar como negativo confirmado.")


def main():
    parser = argparse.ArgumentParser(description="Detecta regeneraciones del DPF por caida sostenida del % de hollin")
    parser.add_argument('--dias', type=int, default=30)
    parser.add_argument('--vehiculo', default=None, help="Filtrar por substring del nombre, ej: 1150")
    parser.add_argument('--excel', action='store_true', help="Exportar detalle a Excel ademas del resumen en pantalla")
    parser.add_argument('--cruzar-regla', action='store_true',
                         help="Cruzar cada episodio detectado contra los ExceptionEvent reales de la regla piloto "
                              "del diagnostico dedicado, para ver si ambas senales coinciden en el tiempo")
    parser.add_argument('--investigar', action='store_true',
                         help="Modo investigacion: reconstruye la linea de tiempo de un caso puntual (requiere "
                              "--vehiculo con el nombre EXACTO y --cuando). No corre el analisis agregado de --dias.")
    parser.add_argument('--cuando', default=None,
                         help="Hora reportada del incidente, hora Bogota, formato 'YYYY-MM-DD HH:MM' (para --investigar).")
    parser.add_argument('--ventana-horas', type=float, default=2.0,
                         help="Horas antes/despues de --cuando a mostrar en el modo --investigar (por defecto 2).")
    args = parser.parse_args()

    print("Conectando a Geotab...")
    api = gc.conectar_geotab()

    if args.investigar:
        if not args.vehiculo or not args.cuando:
            print("--investigar requiere --vehiculo (nombre exacto) y --cuando ('YYYY-MM-DD HH:MM', hora Bogota).")
            return
        try:
            cuando_bog = datetime.strptime(args.cuando, '%Y-%m-%d %H:%M').replace(tzinfo=TZ_BOGOTA)
        except ValueError:
            print(f"No se pudo interpretar --cuando '{args.cuando}'. Formato esperado: 'YYYY-MM-DD HH:MM'.")
            return
        cuando_utc = cuando_bog.astimezone(timezone.utc)

        devices = api.get('Device')
        candidatos = [d for d in devices if args.vehiculo.lower() in (d.get('name') or '').lower()]
        if not candidatos:
            print(f"Ningun vehiculo coincide con '{args.vehiculo}'.")
            return
        if len(candidatos) > 1:
            print(f"'{args.vehiculo}' coincide con {len(candidatos)} vehiculos, se necesita el nombre exacto:")
            for d in candidatos:
                print(' ', d['name'])
            return

        investigar_incidente(api, candidatos[0], cuando_utc, args.ventana_horas)
        return

    todas_reglas = api.get('Rule')
    regla, parecidas = gc.buscar_regla(api, NOMBRE_REGLA_ALCANCE, reglas=todas_reglas)
    if not regla:
        print(f"No se encontro la regla '{NOMBRE_REGLA_ALCANCE}'. Parecidas: {parecidas}")
        return

    devices = api.get('Device')
    grupos_por_id, padre_de, _ = gc.obtener_arbol_grupos(api)
    vehiculos = gc.resolver_vehiculos_en_alcance(devices, regla, grupos_por_id, padre_de)

    if args.vehiculo:
        vehiculos = [v for v in vehiculos if args.vehiculo.lower() in (v.get('name') or '').lower()]
        if not vehiculos:
            print(f"Ningun vehiculo del alcance DPF coincide con '{args.vehiculo}'.")
            return

    print(f"Vehiculos a analizar: {len(vehiculos)}")

    hasta = datetime.now(timezone.utc)
    desde = hasta - timedelta(days=args.dias)

    llamadas = [
        ('Get', {'typeName': 'StatusData', 'search': {
            'diagnosticSearch': {'id': ID_DIAGNOSTICO_HOLLIN},
            'deviceSearch': {'id': v['id']},
            'fromDate': desde.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
            'toDate': hasta.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        }})
        for v in vehiculos
    ]
    print("Consultando StatusData (puede tardar con muchos vehiculos)...")
    resultados = api.multi_call(llamadas)

    eventos_por_vehiculo = None
    if args.cruzar_regla:
        eventos_por_vehiculo = obtener_eventos_regla_piloto(api, vehiculos, desde, hasta)

    filas_resumen = []
    filas_detalle = []
    for v, lecturas in zip(vehiculos, resultados):
        lecturas = lecturas or []
        # Aviso, no paginacion completa -- ver LIMITE_PAGINA_STATUSDATA en
        # geotab_comun.py: si un vehiculo topa exacto el limite, la respuesta
        # pudo haberse cortado en silencio (mismo riesgo ya documentado ahi).
        if len(lecturas) >= gc.LIMITE_PAGINA_STATUSDATA:
            print(f"  AVISO: {v.get('name', v['id'])} devolvio exactamente {len(lecturas)} lecturas "
                  f"(posible corte de pagina, faltaria completar con paginacion manual).")

        serie = []
        for l in lecturas:
            try:
                serie.append((pd.to_datetime(l['dateTime']), float(l.get('data'))))
            except (TypeError, ValueError):
                continue
        serie.sort(key=lambda x: x[0])

        episodios = detectar_episodios_vehiculo(serie)

        eventos_vehiculo = (eventos_por_vehiculo or {}).get(v['id']) if eventos_por_vehiculo is not None else None
        if args.cruzar_regla:
            for e in episodios:
                e['confirmado_regla'] = cruzar_episodio_con_regla(e, eventos_vehiculo)

        fila_resumen = {
            'Vehiculo': v.get('name', v['id']),
            'Muestras': len(serie),
            'Episodios detectados': len(episodios),
            'Caida promedio (pp)': round(sum(e['caida'] for e in episodios) / len(episodios), 1) if episodios else 0,
            'Duracion promedio (min)': round(sum(e['duracion_min'] for e in episodios) / len(episodios), 1) if episodios else 0,
        }
        if args.cruzar_regla:
            confirmados = sum(1 for e in episodios if e['confirmado_regla'])
            fila_resumen['Confirmados por regla'] = confirmados
            fila_resumen['% confirmado'] = round(100 * confirmados / len(episodios), 0) if episodios else 0
        filas_resumen.append(fila_resumen)

        for e in episodios:
            fila_detalle = {
                'Vehiculo': v.get('name', v['id']),
                'Inicio': e['inicio'],
                'Fin': e['fin'],
                '% inicio': round(e['valor_inicio'], 1),
                '% fin': round(e['valor_fin'], 1),
                'Caida (pp)': round(e['caida'], 1),
                'Duracion (min)': e['duracion_min'],
            }
            if args.cruzar_regla:
                fila_detalle['Confirmado por regla'] = e['confirmado_regla']
            filas_detalle.append(fila_detalle)

    df_resumen = pd.DataFrame(filas_resumen).sort_values('Episodios detectados', ascending=False)
    print("\n=== Resumen por vehiculo ===")
    print(df_resumen.to_string(index=False))

    total_episodios = sum(r['Episodios detectados'] for r in filas_resumen)
    con_episodios = sum(1 for r in filas_resumen if r['Episodios detectados'] > 0)
    print(f"\nTotal de episodios detectados en {args.dias} dias: {total_episodios}")
    print(f"Vehiculos con al menos 1 episodio: {con_episodios} / {len(vehiculos)}")

    if args.cruzar_regla and eventos_por_vehiculo is not None:
        total_confirmados = sum(r.get('Confirmados por regla', 0) for r in filas_resumen)
        pct_global = round(100 * total_confirmados / total_episodios, 1) if total_episodios else 0
        total_eventos_regla = sum(len(v) for v in eventos_por_vehiculo.values())
        print(f"\n=== Cruce contra la regla piloto (ventana +/-{VENTANA_CRUCE_MIN} min) ===")
        print(f"Episodios detectados por tendencia confirmados por un evento real de la regla: "
              f"{total_confirmados} / {total_episodios} ({pct_global}%)")
        print(f"Eventos reales de la regla en la ventana: {total_eventos_regla}")
        if pct_global >= 60:
            print("Coincidencia alta -- ambas senales se refuerzan mutuamente, sube la confianza en las dos.")
        elif pct_global >= 25:
            print("Coincidencia parcial -- se solapan, pero no lo suficiente como para decir que miden lo mismo.")
        else:
            print("Coincidencia baja -- las dos senales estan detectando cosas distintas (o una de las dos "
                  "no esta funcionando bien). Esto podria explicar por que el enfoque del diagnostico dedicado "
                  "no fue efectivo la vez anterior.")

        # CAMBIO (2026-09-26, pedido explicito del usuario): reporte aparte de
        # las regeneraciones prolongadas/interrumpidas -- ver comentario de
        # UMBRAL_SESION_PROLONGADA_HORAS. No es ruido, es probablemente el
        # hallazgo mas accionable de toda esta validacion: que vehiculos
        # luchan para completar la regeneracion por operar mas en
        # ralenti/paradas cortas que en marcha sostenida.
        prolongadas = analizar_sesiones_prolongadas(api, vehiculos, desde, hasta)
        print(f"\n=== Regeneraciones prolongadas/interrumpidas (>{UMBRAL_SESION_PROLONGADA_HORAS}h, excluidas del cruce de arriba) ===")
        if not prolongadas:
            print("Ninguna en esta ventana.")
        else:
            df_prolongadas = pd.DataFrame(prolongadas).sort_values('Duracion (h)', ascending=False)
            print(df_prolongadas.to_string(index=False))
            if args.excel:
                # Excel no admite datetimes con tz -- quitarla solo para el export,
                # la impresion en pantalla de arriba ya uso la version con tz.
                df_prolongadas_excel = df_prolongadas.copy()
                df_prolongadas_excel['Inicio'] = df_prolongadas_excel['Inicio'].dt.tz_localize(None)
                df_prolongadas_excel['Fin'] = df_prolongadas_excel['Fin'].dt.tz_localize(None)
            n_interrumpida = sum(1 for p in prolongadas if p['Categoria'] == 'Regeneración interrumpida')
            n_fuera_servicio = sum(1 for p in prolongadas if p['Categoria'] == 'Posible fuera de servicio')
            print(f"\n{len(prolongadas)} sesion(es) prolongada(s), {sum(p['Duracion (h)'] for p in prolongadas):.0f}h acumuladas en total:")
            print(f"  {n_interrumpida} de 'Regeneración interrumpida' (muchos viajes cortos = opera en ralenti/paradas, "
                  f"no logra completar la regeneracion de un tiron)")
            print(f"  {n_fuera_servicio} de 'Posible fuera de servicio' (las Horas de Motor no avanzaron nada en la "
                  f"ventana -- el vehiculo esta parado/apagado, no es un problema de regeneracion)")
            resumen_por_vehiculo = {}
            for p in prolongadas:
                r = resumen_por_vehiculo.setdefault(p['Vehiculo'], {'sesiones': 0, 'horas': 0.0, 'categorias': set()})
                r['sesiones'] += 1
                r['horas'] += p['Duracion (h)']
                r['categorias'].add(p['Categoria'])
            print("\nPor vehiculo:")
            for veh, r in sorted(resumen_por_vehiculo.items(), key=lambda kv: -kv[1]['horas']):
                cats = ' / '.join(sorted(r['categorias']))
                print(f"  {veh:>16}: {r['sesiones']} sesion(es), {r['horas']:.0f}h acumuladas -- {cats}")
            if args.excel:
                df_prolongadas_excel.to_excel(f"regeneracion_dpf_prolongadas_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx", index=False)

    if args.excel and filas_detalle:
        ruta = f"regeneracion_dpf_detalle_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
        df_detalle_excel = pd.DataFrame(filas_detalle)
        df_detalle_excel['Inicio'] = df_detalle_excel['Inicio'].dt.tz_localize(None)
        df_detalle_excel['Fin'] = df_detalle_excel['Fin'].dt.tz_localize(None)
        with pd.ExcelWriter(ruta) as writer:
            df_resumen.to_excel(writer, sheet_name='Resumen', index=False)
            df_detalle_excel.to_excel(writer, sheet_name='Detalle', index=False)
        print(f"\nExcel exportado: {ruta}")


if __name__ == "__main__":
    main()
