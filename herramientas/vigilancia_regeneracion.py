"""
vigilancia_regeneracion.py -- vigilancia en vivo de posibles regeneraciones del DPF
=====================================================================================

Prueba de campo puntual (pedido 2026-09-25): monitorea 1-2 vehiculos de Bogota cada
N minutos y avisa por Telegram apenas detecta una caida de hollin compatible con una
regeneracion, para que alguien revise el tablero del camion EN ESE MOMENTO y confirme
si aparece el testigo de regeneracion -- la confirmacion FISICA que falta ademas de la
validacion estadistica ya hecha (ver detectar_regeneracion_dpf.py y la memoria del
proyecto proyecto_deteccion_regeneracion_dpf.md).

Los 2 vehiculos por defecto (1148-NWW623, 1156-NWX542) se eligieron por ser los unicos
de Bogota, entre los que mas episodios muestran en 3 dias, con buena coincidencia
entre la tendencia de hollin y la regla piloto (80% y 60% respectivamente).

Esto NO es una alerta permanente -- se corre a mano durante la ventana de la prueba y
se detiene con Ctrl+C. Reutiliza toda la logica ya validada de
detectar_regeneracion_dpf.py (misma deteccion de episodios, mismo cruce contra la
regla piloto) y el mismo bot de Telegram que ya usa telegram_alertas.py.

Uso:
    python vigilancia_regeneracion.py                          # 1148-NWW623 y 1156-NWX542, cada 15 min
    python vigilancia_regeneracion.py --intervalo-min 20
    python vigilancia_regeneracion.py --vehiculo "1148-NWW623"  # repetible, para vigilar solo uno
"""
import argparse
import pathlib
import sys
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pandas as pd
from dotenv import load_dotenv

# CAMBIO (2026-09-28, bug real: se perdio un aviso de verdad): la consola de
# Windows con la salida redirigida a un archivo (como hace el proceso en
# segundo plano) usa cp1252 por defecto, que no sabe codificar emojis como
# 🔍 -- el print() de un aviso real tiraba UnicodeEncodeError, cortando el
# ciclo ANTES de llegar a enviar_telegram(). Reconfigurar stdout/stderr a
# UTF-8 evita que esto vuelva a pasar sin importar que emoji se use.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

CARPETA_HERRAMIENTAS = pathlib.Path(__file__).resolve().parent
CARPETA_REPO = CARPETA_HERRAMIENTAS.parent
sys.path.insert(0, str(CARPETA_HERRAMIENTAS))
sys.path.insert(0, str(CARPETA_REPO))  # telegram_alertas.py vive en la raiz del repo, no en herramientas/

import geotab_comun as gc
import detectar_regeneracion_dpf as d

# telegram_alertas.enviar_telegram lee TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID de
# os.environ en el momento de llamarla -- hay que cargar el .env ANTES de
# importarla (import solo trae la funcion, no ejecuta nada a nivel de modulo,
# pero enviar_telegram() si necesita las variables ya puestas quien sabe cuando
# se llame).
load_dotenv(CARPETA_REPO / '.env')
from telegram_alertas import enviar_telegram  # noqa: E402

TZ_BOGOTA = ZoneInfo('America/Bogota')
VEHICULOS_POR_DEFECTO = ['1148-NWW623', '1156-NWX542']
VENTANA_LOOKBACK_MIN = 90  # cubre VENTANA_BUSQUEDA_MIN (30) + margen para no cortar un episodio a medias


def hora_bogota(dt_utc):
    return dt_utc.astimezone(TZ_BOGOTA).strftime('%H:%M:%S')


def revisar_ciclo(api, vehiculos, ya_notificados):
    hasta = datetime.now(timezone.utc)
    desde = hasta - timedelta(minutes=VENTANA_LOOKBACK_MIN)
    fmt = '%Y-%m-%dT%H:%M:%S.%fZ'

    llamadas = [('Get', {'typeName': 'StatusData', 'search': {
        'diagnosticSearch': {'id': d.ID_DIAGNOSTICO_HOLLIN}, 'deviceSearch': {'id': v['id']},
        'fromDate': desde.strftime(fmt), 'toDate': hasta.strftime(fmt)}}) for v in vehiculos]
    resultados = api.multi_call(llamadas)

    eventos_regla = d.obtener_eventos_regla_piloto(api, vehiculos, desde, hasta) or {}

    huboAlgo = False
    for v, r in zip(vehiculos, resultados):
        lecturas = sorted([(pd.to_datetime(x['dateTime']), float(x['data'])) for x in r])
        episodios = d.detectar_episodios_vehiculo(lecturas)
        for ep in episodios:
            clave = (v['id'], ep['inicio'].isoformat())
            if clave in ya_notificados:
                continue
            huboAlgo = True
            confirma_regla = d.cruzar_episodio_con_regla(ep, eventos_regla.get(v['id'], []))
            texto = (
                "🔍 Posible regeneración DPF -- " + v['name'] + "\n"
                f"Hollín: {ep['valor_inicio']:.0f}% → {ep['valor_fin']:.0f}% "
                f"(cayó {ep['caida']:.0f} pp en {ep['duracion_min']:.0f} min)\n"
                f"Inicio: {hora_bogota(ep['inicio'])} hora Bogotá\n"
                "Regla piloto: " + ("✅ confirma con un evento real" if confirma_regla else "⚠️ sin evento asociado") + "\n\n"
                "👉 Revisa AHORA el tablero de " + v['name'] + ": ¿aparece el testigo de regeneración activa?"
            )
            # CAMBIO (2026-09-28, bug real: se perdio un aviso para siempre):
            # antes 'clave' se marcaba como notificada ANTES de intentar
            # imprimir/enviar -- si el print() fallaba (ver el fix de
            # encoding arriba) o enviar_telegram() fallaba, el episodio
            # quedaba marcado como "ya avisado" sin haber avisado nunca,
            # y como el episodio sale de la ventana de 90 min en el
            # siguiente ciclo, se perdia para siempre. Mismo principio que
            # ya usa telegram_alertas.py: solo se marca notificado DESPUES
            # de que el envio realmente funciono.
            try:
                print('\n' + texto)
            except Exception as e:
                print(f"\n(no se pudo imprimir el aviso en consola, se intenta enviar igual: {e})")
            enviado = enviar_telegram(texto)
            if enviado:
                ya_notificados.add(clave)
                print('(enviado a Telegram: si)')
            else:
                print('(enviado a Telegram: NO -- revisar token/chat_id, se reintenta en el siguiente ciclo)')
    if not huboAlgo:
        print('  sin novedad.')


def main():
    parser = argparse.ArgumentParser(description="Vigilancia en vivo de posibles regeneraciones del DPF (prueba de campo, Bogota).")
    parser.add_argument('--intervalo-min', type=int, default=15)
    parser.add_argument('--vehiculo', action='append', default=None,
                         help="Nombre exacto del vehiculo (ej. '1148-NWW623'); repetible. Por defecto los 2 de Bogota ya validados.")
    args = parser.parse_args()

    nombres_objetivo = args.vehiculo or VEHICULOS_POR_DEFECTO

    print("Conectando a Geotab...")
    api = gc.conectar_geotab()
    devices = api.get('Device')
    vehiculos = [dv for dv in devices if dv.get('name') in nombres_objetivo]
    faltantes = set(nombres_objetivo) - set(v['name'] for v in vehiculos)
    if faltantes:
        print(f"AVISO: no se encontraron estos vehiculos, se ignoran: {faltantes}")
    if not vehiculos:
        print("Ningun vehiculo valido para vigilar -- se aborta.")
        return

    print(f"Vigilando: {[v['name'] for v in vehiculos]}")
    print(f"Cada {args.intervalo_min} minutos. Ctrl+C para detener.\n")

    enviar_telegram("👀 Arrancó la vigilancia en vivo de regeneración DPF para: " + ', '.join(v['name'] for v in vehiculos))

    ya_notificados = set()
    try:
        while True:
            print(f"[{datetime.now(TZ_BOGOTA).strftime('%H:%M:%S')}] Consultando...")
            try:
                revisar_ciclo(api, vehiculos, ya_notificados)
            except Exception as e:
                # CAMBIO (2026-09-26, bug real observado en producción): si el
                # equipo se suspende/hiberna varias horas (laptop cerrada), la
                # sesion autenticada de Geotab queda vencida al reactivarse --
                # sin esto, el script se quedaba atascado repitiendo
                # "Cannot authenticate" cada ciclo indefinidamente, sin volver
                # a vigilar nunca. Ahora, ante CUALQUIER error del ciclo, se
                # intenta reconectar (nueva autenticacion) antes del siguiente
                # intento -- si el error era de conectividad/sesion, se
                # autocura solo; si era otra cosa, el proximo ciclo lo vuelve
                # a mostrar igual.
                print(f"  Error en este ciclo: {e}")
                try:
                    api = gc.conectar_geotab()
                    print("  Reconectado a Geotab, se reintenta en el siguiente ciclo.")
                except Exception as e2:
                    print(f"  No se pudo reconectar tampoco: {e2}")
            time.sleep(args.intervalo_min * 60)
    except KeyboardInterrupt:
        print("\nVigilancia detenida por el usuario.")
        enviar_telegram("🛑 Vigilancia en vivo de regeneración DPF detenida.")


if __name__ == '__main__':
    main()
