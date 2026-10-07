"""
vigilancia_cumplimiento_regeneracion.py -- seguimiento en vivo de cumplimiento de
regeneracion del DPF, para avisar a tiempo cuando un conductor debe intervenir
=====================================================================================

Contexto (pedido explicito del usuario, 2026-09-30): despues de confirmar que
"rutas de Usaquen hacen menos regeneracion manual" NO es una senal real (ver
cruce_usaquen_regen_manual.py -- toda la flota usa poco el interruptor manual
por igual), la pregunta de fondo quedo sin resolver: "que hacemos para
identificar que el conductor realice su deber, o que el vehiculo logre
regenerar de manera automatica?". Este script responde eso en vivo, reusando
las 2 piezas que YA estan validadas en Geotab en vez de reinventar umbrales de
hollin:

  - Lampara DPF (ID_DIAGNOSTICO_LAMPARA, binaria 0/1 -- ver R_LAMPARA DEL
    FILTRO DE PARTICULAS DIESEL ENCENDIDA en estado_reglas.md): se enciende
    cuando el filtro necesita regenerar.
  - Interruptor de fuerza manual (ID_DIAGNOSTICO_INTERRUPTOR_MANUAL, binaria
    0/1): el conductor lo activa para forzar la regeneracion manualmente.

Ambas ya son la base de la regla "Regeneracion Manual Inactiva y Lampara DPF
Encendida - C" (interruptor=0 AND lampara=1, id aQ06wSzKCu0iGNW-dBoI9kQ, ya
validada sin bugs, 80 vehiculos). Este script hace lo mismo pero por fuera de
una condicion de regla (para poder medir CUANTO tiempo lleva asi, no solo si
esta pasando ahora) y con un objetivo distinto: avisar ANTES de que el
problema se vuelva cronico.

Por cada vehiculo se reconstruye el "episodio de lampara encendida" (desde que
la lampara prende hasta que se apaga) y dentro de ese episodio se seria si el
interruptor manual se activo o no:

  1. Lampara se apaga SIN que el interruptor se haya activado nunca
     -> "Regeneracion automatica exitosa" (no hizo falta nadie, caso bueno).
  2. Interruptor se activa y DESPUES la lampara se apaga
     -> "Conductor cumplio, regeneracion manual exitosa".
  3. Interruptor se activa pero la lampara NO se apaga tras
     UMBRAL_HORAS_ALERTA_TALLER horas mas -> aviso de taller (el conductor ya
     actuo, el vehiculo no logra regenerar -- probable falla mecanica).
  4. Pasan UMBRAL_HORAS_ALERTA_CONDUCTOR horas DE MOTOR ENCENDIDO desde que la lampara prendio y
     el interruptor NUNCA se activo -> AVISO INMEDIATO por Telegram: alguien
     tiene que decirle al conductor que regenere, antes de que escale.
  4b. Si llega a UMBRAL_HORAS_ESCALADO_CONDUCTOR horas de motor y el interruptor
     sigue sin activarse -> SEGUNDO aviso, escalado (2026-10-06).

Los cierres de episodio (1 y 2) se registran en un CSV historico para poder
sacar despues un % de cumplimiento, pero NO generan alerta de Telegram (evitar
fatiga de alertas por casos buenos). Los avisos 3, 4 y 4b SI son por Telegram.

Estado persistente en estado_cumplimiento_regeneracion.json (mismo principio
que telegram_estado.json -- gitignored, no es una base de datos real) para que
un episodio largo (puede durar dias, ver regeneraciones prolongadas ya
documentadas) sobreviva a un reinicio del script sin perder el "desde cuando"
real. En el primer arranque (sin estado previo) se hace un backfill de
--dias-backfill dias para reconstruir el estado actual de cada vehiculo antes
de empezar a vigilar en vivo.

USO:
  python vigilancia_cumplimiento_regeneracion.py                       # cada 30 min, todos los vehiculos del alcance
  python vigilancia_cumplimiento_regeneracion.py --horas-conductor 2   # horas de MOTOR ENCENDIDO (default desde 2026-10-03)
  python vigilancia_cumplimiento_regeneracion.py --intervalo-min 20
"""
import argparse
import json
import pathlib
import sys
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd
from dotenv import load_dotenv

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

CARPETA_HERRAMIENTAS = pathlib.Path(__file__).resolve().parent
CARPETA_REPO = CARPETA_HERRAMIENTAS.parent
sys.path.insert(0, str(CARPETA_HERRAMIENTAS))
sys.path.insert(0, str(CARPETA_REPO))

import geotab_comun as gc
import detectar_regeneracion_dpf as d

load_dotenv(CARPETA_REPO / '.env')
from telegram_alertas import enviar_telegram  # noqa: E402

TZ_BOGOTA = ZoneInfo('America/Bogota')
NOMBRE_REGLA_ALCANCE = 'Regeneración Manual Inactiva y Lámpara DPF Encendida - C'
RUTA_ESTADO = CARPETA_HERRAMIENTAS / 'estado_cumplimiento_regeneracion.json'
RUTA_HISTORICO_CSV = CARPETA_HERRAMIENTAS / 'historico_cumplimiento_regeneracion.csv'
# Pedido explicito del usuario (2026-09-30): 24h para poder reaccionar e
# informar a tiempo al conductor, antes de que el problema escale.
# CAMBIO (2026-10-03, aprobado por el usuario): ya NO son horas de calendario
# sino horas con el MOTOR ENCENDIDO, con la lámpara prendida y sin activar el
# interruptor. Con calendario, un camión que prende la lámpara en la mañana
# podía pasar el turno entero sin aviso, y uno parqueado avisaba sin sentido
# (caso real 1092-GVT510: 7 días "de demora", solo 43 min con motor). Medido
# en 30 días: cuando el conductor regenera a mano, reacciona en una mediana de
# 10 min de motor y nunca más de 1,1 h -- 2 h deja margen sin falsas alarmas.
UMBRAL_HORAS_ALERTA_CONDUCTOR = 2
# CAMBIO (2026-10-06, aprobado por el usuario): segundo aviso, escalado, si a
# las 4 h de motor la lampara sigue prendida y nadie activo el interruptor. Caso
# real que lo motivo: 3804-GVU088 el 05-oct -- el aviso de las 2 h salio a las
# 20:25 (fuera del turno de quien lo gestiona) y la lampara siguio 4,8 h de
# motor sin interruptor. Un solo aviso por episodio, igual que el primero.
UMBRAL_HORAS_ESCALADO_CONDUCTOR = 4
# Extension razonable del mismo criterio: si el conductor YA activo el
# interruptor y aun asi no resuelve, otras 24h es cuando vale la pena avisar
# que el vehiculo necesita revision mecanica (no es lo que el usuario pidio
# explicitamente, pero sin esto un vehiculo que no logra regenerar ni a mano
# quedaria con un episodio abierto para siempre sin que nadie se entere).
UMBRAL_HORAS_ALERTA_TALLER = 24
VENTANA_LOOKBACK_MIN = 90  # margen de sobra sobre el muestreo real (~30 min) para no perder una transicion
# CAMBIO (2026-10-03, bug real encontrado validando con datos): la lampara DPF
# marca 0 durante unos segundos/minutos y vuelve a 1 sin que haya terminado
# ninguna regeneracion (caso real 1802-GVU037, 03-oct: encendida 06:17-13:27
# con dos "apagados" de 54 s y 68 s, motor encendido todo el tiempo). Antes,
# cada 0 cerraba el episodio como "Regeneracion automatica exitosa" y abria
# otro nuevo: 148 de 192 episodios del historico duraban <30 min (mediana
# 6 min), y lo grave es que el contador de 24h para avisar al conductor se
# reiniciaba en cada parpadeo, asi que esa alerta podia no salir NUNCA.
# Distribucion real (20 dias, toda la flota, 247 tramos apagados entre dos
# encendidos): 111 duran <=15 min, solo 6 entre 15 y 20 min, y el resto es una
# cola larga -- corte natural en ~20 min. Un 0 solo cierra el episodio si la
# lampara NO vuelve a 1 en este margen; si vuelve, es el mismo episodio.
MARGEN_REENCENDIDO_MIN = 20
# CAMBIO (2026-10-03, bug real, el más grave de los dos): al APAGAR el motor la
# lámpara suele reportar 0 (caso real 1802-GVU037: ignición 0 a las 13:27:26,
# lámpara 0 a las 13:27:33), y al día siguiente, al dar arranque, vuelve a 1.
# Antes eso cerraba un episodio "Regeneración automática exitosa" cada noche y
# abría otro cada mañana, así que el contador de 24h nunca llegaba y la
# alerta al conductor no salía jamás. Medido (20 días, 52 vehículos): en
# 4.411 de 4.426 arranques Geotab sí reporta el estado real de la lámpara, y
# 1802-GVU037 arrancó con la lámpara en 1 las 82 veces, un pedido de
# regeneración crónico que se registró como 36 "éxitos". Ahora un 0 con el
# motor APAGADO (o a menos de MARGEN_APAGADO_MOTOR_MIN de apagarlo) se ignora;
# solo un 0 con el motor encendido cuenta como posible fin del episodio.
MARGEN_APAGADO_MOTOR_MIN = 2
ID_DIAGNOSTICO_IGNICION = 'DiagnosticIgnitionId'
# CAMBIO (2026-10-03): la lámpara también parpadea a 1 unos segundos (casos
# reales 3095-GVT513: 9 s al arrancar el 29-sep, 2 min el 2-oct) sin que haya
# ningún pedido real de regeneración. Esos "episodios" se registraban como
# "Regeneración automática exitosa" de 0,0 h. Un episodio más corto que esto y
# SIN interruptor manual no se registra en el histórico (sí se cierra).
DURACION_MINIMA_EPISODIO_MIN = 5
# CAMBIO (2026-10-03, tercer bug real de la misma validación): mientras el
# interruptor manual está ACTIVO la lámpara marca 0 (caso real 3095-GVT513,
# 01-oct: interruptor 1 a las 17:16:33 → lámpara 0 a las 17:16:37; interruptor
# 0 a las 17:17:29 → lámpara 1 a las 17:17:33). Antes eso se registraba como
# "Regeneración manual exitosa" en el instante en que el conductor apretaba el
# botón, y al día siguiente la lámpara arrancaba en 1 y se abría un episodio
# nuevo (21 "éxitos" de 3095-GVT513 en 20 días). Es justo el caso del aviso de
# taller: el conductor cumple, pero el vehículo no termina de regenerar. Ahora
# un 0 con el interruptor activo se ignora (regeneración manual en curso).


def ahora_bogota_str():
    return datetime.now(TZ_BOGOTA).strftime('%Y-%m-%d %H:%M:%S')


def cargar_estado():
    if RUTA_ESTADO.exists():
        with open(RUTA_ESTADO, encoding='utf-8') as f:
            return json.load(f)
    return {}


def guardar_estado(estado):
    with open(RUTA_ESTADO, 'w', encoding='utf-8') as f:
        json.dump(estado, f, indent=2, ensure_ascii=False)


def registrar_historico(fila):
    existe = RUTA_HISTORICO_CSV.exists()
    df = pd.DataFrame([fila])
    df.to_csv(RUTA_HISTORICO_CSV, mode='a', header=not existe, index=False, encoding='utf-8-sig')


def _reconstruir_transiciones(muestras_lampara, muestras_interruptor, muestras_ignicion=()):
    """Mismo principio de forward-fill sobre una linea de tiempo mezclada que ya
    usa calcular_intervalos_ralenti en calcular_ralenti_real_geotab.py. Devuelve
    la lista de (timestamp, 'lampara'|'interruptor'|'ignicion', valor) ordenada.
    Con el mismo timestamp, la ignicion va primero, para que un 0 de lampara
    simultaneo al apagado ya vea el motor apagado."""
    orden = {'ignicion': 0, 'lampara': 1, 'interruptor': 2}
    eventos = [(t, 'lampara', v) for t, v in muestras_lampara] + \
              [(t, 'interruptor', v) for t, v in muestras_interruptor] + \
              [(t, 'ignicion', v) for t, v in muestras_ignicion]
    eventos.sort(key=lambda e: (e[0], orden[e[1]]))
    return eventos


def procesar_vehiculo(v, estado_veh, eventos, ahora_utc):
    """Aplica los eventos (ya ordenados) de lampara/interruptor al estado
    persistido de este vehiculo, actualizandolo in-place. Devuelve la lista de
    avisos a enviar (dicts con 'tipo' y 'texto')."""
    avisos = []
    lamp_on_desde = pd.to_datetime(estado_veh['lamp_on_desde']) if estado_veh.get('lamp_on_desde') else None
    interruptor_desde = pd.to_datetime(estado_veh['interruptor_activado_desde']) if estado_veh.get('interruptor_activado_desde') else None

    # CAMBIO (2026-09-30, bug real encontrado en la primera prueba): la ventana
    # de revision se solapa a proposito (VENTANA_LOOKBACK_MIN) para no perder
    # transiciones -- pero eso significa que vuelve a traer muestras VIEJAS,
    # de ANTES de que el episodio actual empezara. Sin este filtro, una
    # muestra vieja en 0 (de antes de que la lampara se prendiera) se leia
    # como "se acaba de apagar AHORA", cerrando el episodio con una fecha de
    # cierre anterior a la de inicio (duracion negativa, caso real visto:
    # 3098-GVT565 con -1.5h). Se ignora cualquier muestra que no sea mas
    # reciente que la ultima ya procesada para este vehiculo.
    # Episodios ya abiertos y avisados ANTES de existir el aviso escalado
    # (estado sin la clave): no se escalan de golpe al desplegar -- caso real
    # 1802-GVU037, senal pegada desde el 22-sep, pendiente de confirmar en su
    # ciudad. Los episodios nuevos siempre arrancan con la clave en False.
    if 'alertado_escalado' not in estado_veh:
        estado_veh['alertado_escalado'] = bool(estado_veh.get('alertado_24h'))

    ultima_vista = pd.to_datetime(estado_veh['ultima_muestra_vista']) if estado_veh.get('ultima_muestra_vista') else None
    if ultima_vista is not None:
        eventos = [e for e in eventos if e[0] > ultima_vista]
    if eventos:
        estado_veh['ultima_muestra_vista'] = eventos[-1][0].isoformat()

    # Cierre pendiente: la lampara marco 0 en lamp_off_desde, pero el episodio
    # no se da por cerrado hasta confirmar que no vuelve a 1 dentro de
    # MARGEN_REENCENDIDO_MIN (ver comentario de la constante).
    lamp_off_desde = pd.to_datetime(estado_veh['lamp_off_desde']) if estado_veh.get('lamp_off_desde') else None
    margen = timedelta(minutes=MARGEN_REENCENDIDO_MIN)

    def cerrar_episodio(fin):
        nonlocal lamp_on_desde, interruptor_desde, lamp_off_desde, seg_motor, seg_motor_hasta_accion
        # La ventana de revision tiene solape (VENTANA_LOOKBACK_MIN) a
        # proposito para no perder transiciones -- un episodio corto puede
        # volver a aparecer completo en el ciclo siguiente. Se deduplica
        # contra el ultimo cierre ya registrado (por inicio de episodio).
        acumular_motor(fin)
        clave_episodio = lamp_on_desde.isoformat()
        parpadeo = interruptor_desde is None and (fin - lamp_on_desde) < timedelta(minutes=DURACION_MINIMA_EPISODIO_MIN)
        if not parpadeo and estado_veh.get('ultimo_cierre_registrado') != clave_episodio:
            categoria = 'Regeneración manual exitosa' if interruptor_desde is not None else 'Regeneración automática exitosa'
            registrar_historico({
                'Vehiculo': v['name'],
                'Lampara encendida desde': lamp_on_desde,
                'Lampara apagada': fin,
                'Duracion episodio (h)': round((fin - lamp_on_desde).total_seconds() / 3600, 1),
                'Interruptor activado': interruptor_desde is not None,
                'Interruptor activado desde': interruptor_desde,
                'Categoria': categoria,
                # CAMBIO (2026-10-03): tiempo con motor encendido, la medida
                # justa de la reacción del conductor (con el motor apagado no
                # puede regenerar). "Hasta la acción" = hasta activar el
                # interruptor, o hasta que se resolvió solo si nunca lo activó.
                'Min motor encendido hasta accion': round((seg_motor_hasta_accion if seg_motor_hasta_accion is not None else seg_motor) / 60),
                'Min motor encendido episodio': round(seg_motor / 60),
            })
            estado_veh['ultimo_cierre_registrado'] = clave_episodio
        lamp_on_desde = None
        interruptor_desde = None
        lamp_off_desde = None
        seg_motor = 0.0
        seg_motor_hasta_accion = None
        estado_veh['alertado_24h'] = False
        estado_veh['alertado_escalado'] = False
        estado_veh['alertado_taller'] = False

    # Tiempo con motor encendido dentro del episodio abierto (CAMBIO 2026-10-03).
    # cursor_motor = hasta dónde ya se contó; solo se cuenta con la lámpara
    # prendida y sin cierre pendiente.
    seg_motor = float(estado_veh.get('seg_motor_episodio') or 0.0)
    seg_motor_hasta_accion = estado_veh.get('seg_motor_hasta_accion')
    cursor_motor = pd.to_datetime(estado_veh['cursor_motor']) if estado_veh.get('cursor_motor') else None

    def acumular_motor(hasta_t):
        nonlocal seg_motor, cursor_motor
        if motor_encendido and lamp_on_desde is not None and lamp_off_desde is None and cursor_motor is not None:
            inicio = max(cursor_motor, lamp_on_desde)
            if hasta_t > inicio:
                seg_motor += (hasta_t - inicio).total_seconds()
        if cursor_motor is None or hasta_t > cursor_motor:
            cursor_motor = hasta_t

    motor_encendido = estado_veh.get('motor_encendido')  # None = aún no se sabe
    interruptor_activo = bool(estado_veh.get('interruptor_activo'))
    margen_apagado = timedelta(minutes=MARGEN_APAGADO_MOTOR_MIN)

    for t, señal, v_val in eventos:
        acumular_motor(t)
        if señal == 'ignicion':
            motor_encendido = bool(v_val and v_val > 0)
            # Un 0 de lámpara que llegó un instante ANTES del apagado del motor
            # también es efecto del apagado: se anula el cierre pendiente.
            if not motor_encendido and lamp_off_desde is not None and t - lamp_off_desde <= margen_apagado:
                lamp_off_desde = None
            continue
        if señal == 'lampara':
            encendida = bool(v_val and v_val > 0)
            if not encendida and motor_encendido is False:
                continue  # 0 con el motor apagado: no dice nada de la regeneración
            if not encendida and interruptor_activo:
                continue  # 0 con el interruptor manual activo: regeneración manual en curso, no terminada
            if encendida:
                if lamp_off_desde is not None:
                    if t - lamp_off_desde <= margen:
                        lamp_off_desde = None  # parpadeo: sigue siendo el mismo episodio
                        continue
                    cerrar_episodio(lamp_off_desde)  # estuvo apagada de verdad; este 1 abre otro
                if lamp_on_desde is None:
                    lamp_on_desde = t
                    seg_motor = 0.0
                    seg_motor_hasta_accion = None
                    interruptor_desde = None
                    estado_veh['alertado_24h'] = False
                    estado_veh['alertado_escalado'] = False
                    estado_veh['alertado_taller'] = False
            elif lamp_on_desde is not None:
                if lamp_off_desde is None:
                    lamp_off_desde = t
                elif t - lamp_off_desde > margen:
                    cerrar_episodio(lamp_off_desde)  # otra lectura en 0 pasado el margen lo confirma
        elif señal == 'interruptor':
            interruptor_activo = bool(v_val and v_val > 0)
            if interruptor_activo:
                lamp_off_desde = None  # un 0 previo de lámpara era el inicio de la manual, no un cierre
            if v_val and v_val > 0 and lamp_on_desde is not None and interruptor_desde is None:
                interruptor_desde = t
                seg_motor_hasta_accion = seg_motor

    # Sin lecturas nuevas que lo confirmen: se cierra cuando ya pasó el margen y
    # también la ventana de solape (VENTANA_LOOKBACK_MIN) -- para entonces, un 1
    # que llegara con retraso a Geotab ya habría aparecido en la consulta.
    if lamp_off_desde is not None and ahora_utc - lamp_off_desde > max(margen, timedelta(minutes=VENTANA_LOOKBACK_MIN)):
        cerrar_episodio(lamp_off_desde)

    estado_veh['lamp_on_desde'] = lamp_on_desde.isoformat() if lamp_on_desde is not None else None
    estado_veh['interruptor_activado_desde'] = interruptor_desde.isoformat() if interruptor_desde is not None else None
    estado_veh['lamp_off_desde'] = lamp_off_desde.isoformat() if lamp_off_desde is not None else None
    estado_veh['motor_encendido'] = motor_encendido
    estado_veh['interruptor_activo'] = interruptor_activo
    estado_veh['seg_motor_episodio'] = seg_motor
    estado_veh['seg_motor_hasta_accion'] = seg_motor_hasta_accion
    estado_veh['cursor_motor'] = cursor_motor.isoformat() if cursor_motor is not None else None

    # Mientras el cierre está pendiente (lámpara en 0 hace poco) no se avisa:
    # puede ser que la regeneración acabe de terminar.
    if lamp_on_desde is not None and lamp_off_desde is None:
        horas_lampara = (ahora_utc - lamp_on_desde).total_seconds() / 3600
        # Horas de motor hasta AHORA, sin guardarlas: si el motor sigue
        # encendido se suma el tramo desde la última lectura (provisional, el
        # siguiente ciclo lo cuenta con datos reales).
        seg_provisional = seg_motor
        if motor_encendido and cursor_motor is not None and ahora_utc > cursor_motor:
            seg_provisional += (ahora_utc - max(cursor_motor, lamp_on_desde)).total_seconds()
        horas_motor = seg_provisional / 3600
        if interruptor_desde is None:
            if horas_motor >= UMBRAL_HORAS_ALERTA_CONDUCTOR and not estado_veh.get('alertado_24h'):
                avisos.append({
                    'tipo': 'conductor',
                    'texto': (
                        "🟡 DPF -- regeneración pendiente, avisar al conductor\n"
                        f"Vehículo: {v['name']}\n"
                        f"Lámpara DPF encendida desde {lamp_on_desde.astimezone(TZ_BOGOTA).strftime('%Y-%m-%d %H:%M')} hora Bogotá: "
                        f"{horas_motor:.1f} h con el motor encendido ({horas_lampara:.0f} h en total) "
                        "sin que se haya activado el interruptor de regeneración manual.\n"
                        "👉 Informar al conductor que debe realizar la regeneración manual ahora."
                    ),
                })
                estado_veh['alertado_24h'] = True
            # elif: nunca los dos avisos en el mismo ciclo (p.ej. al retomar tras
            # un hueco); el escalado sale en el ciclo siguiente.
            elif (horas_motor >= UMBRAL_HORAS_ESCALADO_CONDUCTOR and estado_veh.get('alertado_24h')
                  and not estado_veh.get('alertado_escalado')):
                avisos.append({
                    'tipo': 'escalado',
                    'texto': (
                        "🟠 DPF -- SEGUNDO AVISO: el conductor aún no regenera\n"
                        f"Vehículo: {v['name']}\n"
                        f"Lámpara DPF encendida desde {lamp_on_desde.astimezone(TZ_BOGOTA).strftime('%Y-%m-%d %H:%M')} hora Bogotá: "
                        f"ya son {horas_motor:.1f} h con el motor encendido ({horas_lampara:.0f} h en total) "
                        f"y el interruptor de regeneración manual sigue sin activarse "
                        f"(el primer aviso salió a las {UMBRAL_HORAS_ALERTA_CONDUCTOR:g} h).\n"
                        "👉 Contactar al conductor o al supervisor del turno: hacer la regeneración manual ya."
                    ),
                })
                estado_veh['alertado_escalado'] = True
        else:
            horas_desde_interruptor = (ahora_utc - interruptor_desde).total_seconds() / 3600
            if horas_desde_interruptor >= UMBRAL_HORAS_ALERTA_TALLER and not estado_veh.get('alertado_taller'):
                avisos.append({
                    'tipo': 'taller',
                    'texto': (
                        "🔴 DPF -- regeneración manual no resuelve, posible falla\n"
                        f"Vehículo: {v['name']}\n"
                        f"El conductor activó el interruptor manual hace {horas_desde_interruptor:.0f}h "
                        f"({interruptor_desde.astimezone(TZ_BOGOTA).strftime('%Y-%m-%d %H:%M')} hora Bogotá) "
                        "y la lámpara DPF sigue encendida.\n"
                        "👉 El conductor ya cumplió -- el vehículo no logra regenerar, programar revisión en taller."
                    ),
                })
                estado_veh['alertado_taller'] = True

    return avisos


def ciclo_backfill(api, vehiculos, dias):
    print(f"Sin estado previo -- reconstruyendo los últimos {dias} días para arrancar con el estado real...")
    hasta = datetime.now(timezone.utc)
    desde = hasta - timedelta(days=dias)
    estado = {}
    for i, v in enumerate(vehiculos, 1):
        print(f"  [{i}/{len(vehiculos)}] {v['name']}...")
        resultados = api.multi_call([
            ('Get', {'typeName': 'StatusData', 'search': {
                'diagnosticSearch': {'id': d.ID_DIAGNOSTICO_LAMPARA}, 'deviceSearch': {'id': v['id']},
                'fromDate': desde.strftime('%Y-%m-%dT%H:%M:%S.%fZ'), 'toDate': hasta.strftime('%Y-%m-%dT%H:%M:%S.%fZ')}}),
            ('Get', {'typeName': 'StatusData', 'search': {
                'diagnosticSearch': {'id': d.ID_DIAGNOSTICO_INTERRUPTOR_MANUAL}, 'deviceSearch': {'id': v['id']},
                'fromDate': desde.strftime('%Y-%m-%dT%H:%M:%S.%fZ'), 'toDate': hasta.strftime('%Y-%m-%dT%H:%M:%S.%fZ')}}),
            ('Get', {'typeName': 'StatusData', 'search': {
                'diagnosticSearch': {'id': ID_DIAGNOSTICO_IGNICION}, 'deviceSearch': {'id': v['id']},
                'fromDate': desde.strftime('%Y-%m-%dT%H:%M:%S.%fZ'), 'toDate': hasta.strftime('%Y-%m-%dT%H:%M:%S.%fZ')}}),
        ])
        lampara = sorted((pd.to_datetime(x['dateTime']), float(x['data'])) for x in resultados[0] or [] if x.get('data') is not None)
        interruptor = sorted((pd.to_datetime(x['dateTime']), float(x['data'])) for x in resultados[1] or [] if x.get('data') is not None)
        ignicion = sorted((pd.to_datetime(x['dateTime']), float(x['data'])) for x in resultados[2] or [] if x.get('data') is not None)
        eventos = _reconstruir_transiciones(lampara, interruptor, ignicion)
        estado_veh = {'lamp_on_desde': None, 'interruptor_activado_desde': None, 'alertado_24h': False, 'alertado_taller': False}
        procesar_vehiculo(v, estado_veh, eventos, hasta)  # avisos del backfill se descartan a proposito, solo interesa el estado final
        estado[v['id']] = estado_veh
    estado['_meta'] = {'ultima_revision': hasta.isoformat()}
    print("Backfill terminado.")
    return estado


def revisar_ciclo(api, vehiculos, estado):
    hasta = datetime.now(timezone.utc)
    desde_str = estado.get('_meta', {}).get('ultima_revision')
    desde = pd.to_datetime(desde_str) if desde_str else (hasta - timedelta(minutes=VENTANA_LOOKBACK_MIN))
    desde = min(desde, hasta - timedelta(minutes=VENTANA_LOOKBACK_MIN))  # margen de solape, nunca mas corto que el lookback

    llamadas = []
    for v in vehiculos:
        llamadas.append(('Get', {'typeName': 'StatusData', 'search': {
            'diagnosticSearch': {'id': d.ID_DIAGNOSTICO_LAMPARA}, 'deviceSearch': {'id': v['id']},
            'fromDate': desde.strftime('%Y-%m-%dT%H:%M:%S.%fZ'), 'toDate': hasta.strftime('%Y-%m-%dT%H:%M:%S.%fZ')}}))
        llamadas.append(('Get', {'typeName': 'StatusData', 'search': {
            'diagnosticSearch': {'id': d.ID_DIAGNOSTICO_INTERRUPTOR_MANUAL}, 'deviceSearch': {'id': v['id']},
            'fromDate': desde.strftime('%Y-%m-%dT%H:%M:%S.%fZ'), 'toDate': hasta.strftime('%Y-%m-%dT%H:%M:%S.%fZ')}}))
        llamadas.append(('Get', {'typeName': 'StatusData', 'search': {
            'diagnosticSearch': {'id': ID_DIAGNOSTICO_IGNICION}, 'deviceSearch': {'id': v['id']},
            'fromDate': desde.strftime('%Y-%m-%dT%H:%M:%S.%fZ'), 'toDate': hasta.strftime('%Y-%m-%dT%H:%M:%S.%fZ')}}))
    resultados = api.multi_call(llamadas)

    hubo_aviso = False
    for idx, v in enumerate(vehiculos):
        lampara = sorted((pd.to_datetime(x['dateTime']), float(x['data'])) for x in resultados[idx * 3] or [] if x.get('data') is not None)
        interruptor = sorted((pd.to_datetime(x['dateTime']), float(x['data'])) for x in resultados[idx * 3 + 1] or [] if x.get('data') is not None)
        ignicion = sorted((pd.to_datetime(x['dateTime']), float(x['data'])) for x in resultados[idx * 3 + 2] or [] if x.get('data') is not None)
        eventos = _reconstruir_transiciones(lampara, interruptor, ignicion)
        estado_veh = estado.setdefault(v['id'], {'lamp_on_desde': None, 'interruptor_activado_desde': None, 'alertado_24h': False, 'alertado_taller': False})
        avisos = procesar_vehiculo(v, estado_veh, eventos, hasta)
        for aviso in avisos:
            hubo_aviso = True
            print('\n' + aviso['texto'])
            enviado = enviar_telegram(aviso['texto'])
            print('(enviado a Telegram: si)' if enviado else '(enviado a Telegram: NO -- se reintenta la marca en el siguiente ciclo)')
            if not enviado:
                # Mismo principio que telegram_alertas.py: no marcar como avisado si el envio fallo.
                if aviso['tipo'] == 'conductor':
                    estado_veh['alertado_24h'] = False
                elif aviso['tipo'] == 'escalado':
                    estado_veh['alertado_escalado'] = False
                else:
                    estado_veh['alertado_taller'] = False

    estado.setdefault('_meta', {})['ultima_revision'] = hasta.isoformat()
    guardar_estado(estado)
    if not hubo_aviso:
        print('  sin novedad.')


def main():
    global UMBRAL_HORAS_ALERTA_CONDUCTOR, UMBRAL_HORAS_ESCALADO_CONDUCTOR, UMBRAL_HORAS_ALERTA_TALLER
    parser = argparse.ArgumentParser(description="Vigilancia en vivo de cumplimiento de regeneración DPF (lámpara vs. interruptor manual).")
    parser.add_argument('--intervalo-min', type=int, default=30)
    parser.add_argument('--dias-backfill', type=int, default=10, help="Días hacia atrás a reconstruir en el primer arranque (sin estado previo).")
    parser.add_argument('--horas-conductor', type=float, default=UMBRAL_HORAS_ALERTA_CONDUCTOR,
                         help="Horas CON EL MOTOR ENCENDIDO (no de calendario, cambio 2026-10-03) con la lámpara encendida y sin interruptor manual antes de avisar al conductor.")
    parser.add_argument('--horas-escalado', type=float, default=UMBRAL_HORAS_ESCALADO_CONDUCTOR,
                         help="Horas de motor encendido para el SEGUNDO aviso (escalado) si el interruptor sigue sin activarse.")
    parser.add_argument('--horas-taller', type=float, default=UMBRAL_HORAS_ALERTA_TALLER,
                         help="Horas tras activar el interruptor manual, sin que la lámpara se apague, antes de avisar de posible falla mecánica.")
    # CAMBIO (2026-10-05): en este PC la vigilancia se detenía cada vez que el
    # equipo se suspendía (huecos medidos de 8, 13 y 3 h en dos días). Ahora
    # corre en GitHub Actions (.github/workflows/vigilancia-regeneracion-dpf.yml),
    # que la lanza cada 30 min con --una-vez: hace UN ciclo (o el backfill, si
    # no hay estado) y termina. El estado y el histórico viajan entre corridas
    # con actions/cache, igual que telegram_estado.json. No manda el mensaje de
    # "arrancó la vigilancia" en cada corrida (serían 48 al día).
    parser.add_argument('--una-vez', action='store_true',
                        help="Hace un solo ciclo y termina (para GitHub Actions). Sin esto, queda en bucle.")
    args = parser.parse_args()

    UMBRAL_HORAS_ALERTA_CONDUCTOR = args.horas_conductor
    UMBRAL_HORAS_ESCALADO_CONDUCTOR = args.horas_escalado
    UMBRAL_HORAS_ALERTA_TALLER = args.horas_taller

    print("Conectando a Geotab...")
    api = gc.conectar_geotab()
    devices = api.get('Device')
    reglas = api.get('Rule')
    regla_alcance, parecidas = gc.buscar_regla(api, NOMBRE_REGLA_ALCANCE, reglas=reglas)
    if not regla_alcance:
        print(f"No se encontró la regla de alcance '{NOMBRE_REGLA_ALCANCE}'. Parecidas: {[r['name'] for r in parecidas]}")
        return
    grupos_por_id, padre_de, _ = gc.obtener_arbol_grupos(api)
    vehiculos = gc.resolver_vehiculos_en_alcance(devices, regla_alcance, grupos_por_id, padre_de)
    print(f"Vehículos en alcance: {len(vehiculos)}")

    estado = cargar_estado()
    if not estado:
        estado = ciclo_backfill(api, vehiculos, args.dias_backfill)
        guardar_estado(estado)
        abiertos = sum(1 for k, s in estado.items() if k != '_meta' and s.get('lamp_on_desde'))
        print(f"Estado inicial: {abiertos} vehículo(s) con lámpara encendida en este momento.")
    else:
        print("Estado previo cargado, continuando desde ahí.")
        if args.una_vez:
            print(f"[{ahora_bogota_str()}] Consultando (una sola vez)...")
            revisar_ciclo(api, vehiculos, estado)  # si falla, que falle la corrida: se ve en GitHub
    if args.una_vez:
        return

    print(f"Vigilando cada {args.intervalo_min} minutos. "
          f"Aviso a conductor tras {UMBRAL_HORAS_ALERTA_CONDUCTOR}h de motor encendido sin intervención, "
          f"aviso de taller tras {UMBRAL_HORAS_ALERTA_TALLER}h más sin resolver. Ctrl+C para detener.\n")
    enviar_telegram(f"👀 Arrancó la vigilancia de cumplimiento de regeneración DPF ({len(vehiculos)} vehículos).")

    try:
        while True:
            print(f"[{ahora_bogota_str()}] Consultando...")
            try:
                revisar_ciclo(api, vehiculos, estado)
            except Exception as e:
                print(f"  Error en este ciclo: {e}")
                try:
                    api = gc.conectar_geotab()
                    print("  Reconectado a Geotab, se reintenta en el siguiente ciclo.")
                except Exception as e2:
                    print(f"  No se pudo reconectar tampoco: {e2}")
            time.sleep(args.intervalo_min * 60)
    except KeyboardInterrupt:
        print("\nVigilancia de cumplimiento detenida por el usuario.")
        enviar_telegram("🛑 Vigilancia de cumplimiento de regeneración DPF detenida.")


if __name__ == '__main__':
    main()
