"""Revisa Geotab periodicamente y manda alertas a Telegram, sin depender de que
el tablero (app.py) este abierto. Pensado para correr como job programado
(ver .github/workflows/alertas-telegram.yml).

Usa un archivo local (ESTADO_PATH) para recordar que eventos ya se notificaron
y no repetir el mensaje en cada corrida. En GitHub Actions ese archivo se
persiste entre corridas con actions/cache (no requiere credenciales extra de
Google Sheets, a diferencia del snapshot que usa app.py).
"""
import os
import json
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import mygeotab
import pandas as pd
import requests

ZONA_BOGOTA = ZoneInfo("America/Bogota")

NOMBRE_REGLA_RPM_POR_MOTOR = {'L9': 'SOBRE REVOLUCIÓN (L9)', 'X12': 'SOBRE REVOLUCIÓN (X12)'}
DURACION_MINIMA_SEG = 60  # filtra picos breves (cambios de marcha) y solo avisa sobre-revoluciones sostenidas
VENTANA_REVISION_HORAS = 2  # margen hacia atras en cada corrida, por si el cron se atrasa o se salta una ejecucion
ESTADO_PATH = "telegram_estado_revolucion.json"
MAX_CLAVES_GUARDADAS = 5000  # evita que el archivo de estado crezca sin limite


def conectar_geotab():
    api = mygeotab.API(
        username=os.environ["GEOTAB_USUARIO"],
        password=os.environ["GEOTAB_CONTRASENA"],
        database=os.environ["GEOTAB_DATABASE"],
        server=os.environ.get("GEOTAB_SERVER", "my.geotab.com"),
    )
    api.authenticate()
    return api


def cargar_claves_notificadas():
    if not os.path.exists(ESTADO_PATH):
        return set()
    try:
        with open(ESTADO_PATH, "r", encoding="utf-8") as f:
            return set(json.load(f))
    except (json.JSONDecodeError, OSError):
        return set()


def guardar_claves_notificadas(claves):
    claves_a_guardar = list(claves)[-MAX_CLAVES_GUARDADAS:]
    with open(ESTADO_PATH, "w", encoding="utf-8") as f:
        json.dump(claves_a_guardar, f)


def enviar_telegram(texto):
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    chat_id = os.environ["TELEGRAM_CHAT_ID"]
    resp = requests.post(
        f"https://api.telegram.org/bot{token}/sendMessage",
        json={"chat_id": chat_id, "text": texto},
        timeout=15,
    )
    if not resp.ok:
        print(f"*** Error enviando a Telegram: {resp.status_code} {resp.text} ***")
    return resp.ok


def revisar_sobre_revolucion(api, claves_ya_notificadas):
    f_fin = datetime.now(timezone.utc)
    f_inicio = f_fin - timedelta(hours=VENTANA_REVISION_HORAS)

    reglas = api.get('Rule')
    devices = {d['id']: d for d in api.get('Device')}

    claves_nuevas = []
    for motor, nombre_regla in NOMBRE_REGLA_RPM_POR_MOTOR.items():
        regla = next(
            (r for r in reglas if r.get('name', '').strip().upper() == nombre_regla.strip().upper()), None
        )
        if not regla:
            print(f"*** No se encontro la regla '{nombre_regla}' ***")
            continue

        eventos = api.get('ExceptionEvent', search={
            'ruleSearch': {'id': regla['id']},
            'fromDate': f_inicio.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
            'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
        })

        for ev in (eventos or []):
            dev = ev.get('device')
            id_veh = dev['id'] if isinstance(dev, dict) else dev
            activeFrom = ev.get('activeFrom')
            activeTo = ev.get('activeTo')
            if not activeFrom or not activeTo:
                continue

            dt_desde = pd.to_datetime(activeFrom)
            dt_hasta = pd.to_datetime(activeTo)
            duracion_seg = (dt_hasta - dt_desde).total_seconds()
            if duracion_seg < DURACION_MINIMA_SEG:
                continue

            clave = f"{id_veh}|{activeFrom}"
            if clave in claves_ya_notificadas:
                continue

            nombre_veh = devices.get(id_veh, {}).get('name', id_veh)
            hora_local = dt_desde.tz_convert(ZONA_BOGOTA).strftime('%d/%m/%Y %H:%M:%S')
            texto = (
                f"🏎️ SOBRE-REVOLUCIÓN ({motor})\n"
                f"Vehículo: {nombre_veh}\n"
                f"Hora: {hora_local}\n"
                f"Duración: {duracion_seg:.0f} segundos sostenidos\n"
                f"Vehículo detenido con RPM alto."
            )
            if enviar_telegram(texto):
                print(f"Notificado: {clave} ({duracion_seg:.0f}s)")
                claves_nuevas.append(clave)

    if claves_nuevas:
        print(f"Total notificados en esta corrida: {len(claves_nuevas)}")
    else:
        print("Sin eventos nuevos de sobre-revolucion que notificar.")

    return claves_nuevas


def main():
    api = conectar_geotab()
    claves_ya_notificadas = cargar_claves_notificadas()
    print(f"Claves ya notificadas cargadas del estado: {len(claves_ya_notificadas)}")

    claves_nuevas = revisar_sobre_revolucion(api, claves_ya_notificadas)

    claves_ya_notificadas.update(claves_nuevas)
    guardar_claves_notificadas(claves_ya_notificadas)


if __name__ == "__main__":
    main()
