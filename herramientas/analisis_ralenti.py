"""
analisis_ralenti.py -- herramienta unica de analisis de ralenti (con subcomandos)
====================================================================================

Reemplaza a: analisis_ralenti_furgones.py, analisis_rpm_ralenti_furgones.py,
diagnostico_regla_furgon.py, diagnostico_regla.py, analisis_historico_1927.py,
ubicacion_eventos_1927.py, verificar_zona_sede.py -- todo lo que se armo en la
sesion de depuracion de las reglas de ralenti de furgones/N400 vive aca ahora,
como subcomandos de un solo script (mismo patron que ya usa geotab_reglas_v3.py).

Requiere geotab_comun.py en la misma carpeta.

USO -- un subcomando por tarea:

  1) Resumen de ralenti por tipologia (ej. furgones), ultimos N dias:
     python analisis_ralenti.py resumen --tipologia furgon --dias 7

  2) Comparar diagnosticos de RPM dentro de eventos de ralenti confirmado:
     python analisis_ralenti.py rango-rpm --tipologia furgon --dias 7 --regla "Ralentí Excesivo Sin PTO"

  3) Diagnosticar si una regla especifica esta generando eventos:
     python analisis_ralenti.py diagnosticar-regla --regla "V_RALENTÍ N400 800 RPM" --dias 30

  4) Ver el patron historico de una regla en un vehiculo especifico:
     python analisis_ralenti.py historico-vehiculo --regla "V_RALENTÍ N400 800 RPM" --vehiculo 1927-QQU073 --dias 60

  5) Ver la ubicacion GPS de cada evento de un vehiculo:
     python analisis_ralenti.py ubicaciones --regla "V_RALENTÍ N400 800 RPM" --vehiculo 1927-QQU073 --dias 60

  6) Verificar si una coordenada cae dentro de una zona de Geotab:
     python analisis_ralenti.py verificar-zona --lat 4.63417816 --lon -74.1113434 --zona b28CB

Para ver la ayuda de cualquier subcomando: python analisis_ralenti.py <subcomando> -h
"""
import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone

import pandas as pd
from zoneinfo import ZoneInfo

import geotab_comun as gc

ZONA_BOGOTA = ZoneInfo("America/Bogota")

# IDs de diagnostico ya validados en app.py / telegram_alertas.py
ID_RPM_VALIDADO = 'aW3Nmy-ktfEuvrdkya4z0yg'
ID_RPM_GENERICO = 'DiagnosticEngineSpeedId'
NOMBRE_REGLA_RALENTI_DEFECTO = 'Ralentí Excesivo Sin PTO'


# ---------------------------------------------------------------------------
# Subcomando: resumen
# ---------------------------------------------------------------------------

def comando_resumen(args):
    api = gc.conectar_geotab()
    print("Cargando jerarquia de grupos y vehiculos...")
    _, _, mapa_tipologia = gc.obtener_arbol_grupos(api)
    devices = api.get('Device')

    vehiculos = []
    for d in devices:
        tipologia = gc.resolver_tipologia(d.get('groups'), mapa_tipologia)
        if args.tipologia.lower() in tipologia.lower():
            vehiculos.append({'id': d['id'], 'nombre': d.get('name', d['id'])})

    if not vehiculos:
        tipologias_disponibles = sorted(set(v for v in mapa_tipologia.values() if v))
        print(f"\nNo se encontro ningun vehiculo con tipologia que contenga '{args.tipologia}'.")
        print("Tipologias disponibles:")
        for t in tipologias_disponibles:
            print(f"  - {t}")
        return

    print(f"Vehiculos: {', '.join(v['nombre'] for v in vehiculos)}")
    ids_vehiculos = {v['id'] for v in vehiculos}
    nombres_por_id = {v['id']: v['nombre'] for v in vehiculos}

    f_fin = datetime.now(timezone.utc)
    f_inicio = f_fin - timedelta(days=args.dias)

    regla, parecidas = gc.buscar_regla(api, args.regla)
    if not regla:
        print(f"\n*** No se encontro la regla '{args.regla}'. ***")
        if parecidas:
            print("Reglas parecidas:", ', '.join(parecidas))
        return

    eventos_raw = api.get('ExceptionEvent', search={
        'ruleSearch': {'id': regla['id']},
        'fromDate': f_inicio.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    })

    filas = []
    for ev in (eventos_raw or []):
        id_veh = gc.obtener_id(ev.get('device'))
        if id_veh not in ids_vehiculos:
            continue
        desde, hasta = ev.get('activeFrom'), ev.get('activeTo')
        if not desde or not hasta:
            continue
        duracion_min = (pd.to_datetime(hasta) - pd.to_datetime(desde)).total_seconds() / 60
        filas.append({
            'vehiculo': nombres_por_id[id_veh],
            'duracion_min': duracion_min,
            'criticidad': gc.clasificar_criticidad_ralenti(duracion_min),
        })

    print(f"\n{'=' * 70}\nRESUMEN -- {args.tipologia.upper()} (ultimos {args.dias} dias, regla '{args.regla}')\n{'=' * 70}")
    if not filas:
        print("\nSin eventos en el periodo para estos vehiculos.")
        return

    df = pd.DataFrame(filas)
    print(f"\nTotal eventos: {len(df)}")
    print(f"Total horas en ralenti: {df['duracion_min'].sum() / 60:.1f} h")
    print(f"Vehiculos con al menos un evento: {df['vehiculo'].nunique()} de {len(vehiculos)}")

    print("\nDistribucion por criticidad:")
    for crit in ['ALTA', 'MEDIA', 'BAJA']:
        print(f"  {crit:6s}: {(df['criticidad'] == crit).sum()}")

    resumen_veh = df.groupby('vehiculo').agg(
        eventos=('vehiculo', 'count'), minutos_totales=('duracion_min', 'sum'),
        evento_mas_largo_min=('duracion_min', 'max'),
    ).reset_index().sort_values('minutos_totales', ascending=False)

    print(f"\n{'Vehiculo':<20}{'Eventos':>10}{'Min. totales':>15}{'Evento max (min)':>20}")
    print("-" * 65)
    for _, row in resumen_veh.iterrows():
        print(f"{row['vehiculo']:<20}{int(row['eventos']):>10}{row['minutos_totales']:>15.1f}{row['evento_mas_largo_min']:>20.1f}")

    sin_eventos = [v['nombre'] for v in vehiculos if v['nombre'] not in df['vehiculo'].unique()]
    if sin_eventos:
        print(f"\nSin eventos en el periodo ({len(sin_eventos)}): {', '.join(sin_eventos)}")


# ---------------------------------------------------------------------------
# Subcomando: rango-rpm
# ---------------------------------------------------------------------------

def comando_rango_rpm(args):
    api = gc.conectar_geotab()
    print("Cargando jerarquia de grupos y vehiculos...")
    _, _, mapa_tipologia = gc.obtener_arbol_grupos(api)
    devices = api.get('Device')

    vehiculos = []
    for d in devices:
        tipologia = gc.resolver_tipologia(d.get('groups'), mapa_tipologia)
        if args.tipologia.lower() in tipologia.lower():
            vehiculos.append({'id': d['id'], 'nombre': d.get('name', d['id'])})
    if not vehiculos:
        print(f"No se encontro ningun vehiculo con tipologia que contenga '{args.tipologia}'.")
        return
    print(f"Vehiculos: {', '.join(v['nombre'] for v in vehiculos)}")
    ids_vehiculos = {v['id'] for v in vehiculos}

    f_fin = datetime.now(timezone.utc)
    f_inicio = f_fin - timedelta(days=args.dias)

    regla, parecidas = gc.buscar_regla(api, args.regla)
    if not regla:
        print(f"*** No se encontro la regla '{args.regla}'. ***")
        if parecidas:
            print("Reglas parecidas:", ', '.join(parecidas))
        return

    eventos_raw = api.get('ExceptionEvent', search={
        'ruleSearch': {'id': regla['id']},
        'fromDate': f_inicio.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    })

    eventos = []
    for ev in (eventos_raw or []):
        id_veh = gc.obtener_id(ev.get('device'))
        if id_veh not in ids_vehiculos:
            continue
        desde, hasta = ev.get('activeFrom'), ev.get('activeTo')
        if not desde or not hasta:
            continue
        eventos.append({'id_veh': id_veh, 'desde': pd.to_datetime(desde), 'hasta': pd.to_datetime(hasta)})

    if not eventos:
        print("No hay eventos confirmados en el periodo -- nada que analizar.")
        return
    print(f"Encontrados {len(eventos)} eventos confirmados. Consultando RPM dentro de cada ventana...\n")

    diagnosticos = {ID_RPM_VALIDADO: [], args.diagnostico_alterno: []} if args.diagnostico_alterno else {ID_RPM_VALIDADO: [], ID_RPM_GENERICO: []}

    for diagnostico_id in diagnosticos:
        lecturas_por_vehiculo = {}
        for id_veh in ids_vehiculos:
            try:
                registros = api.get('StatusData', search={
                    'diagnosticSearch': {'id': diagnostico_id}, 'deviceSearch': {'id': id_veh},
                    'fromDate': f_inicio.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                    'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
                })
            except Exception as e:
                print(f"  *** Error consultando {diagnostico_id} para {id_veh}: {e} ***")
                registros = []
            puntos = []
            for r in (registros or []):
                try:
                    puntos.append((pd.to_datetime(r['dateTime']), float(r['data'])))
                except (TypeError, ValueError, KeyError):
                    continue
            lecturas_por_vehiculo[id_veh] = puntos

        for ev in eventos:
            for t, v in lecturas_por_vehiculo.get(ev['id_veh'], []):
                if ev['desde'] <= t <= ev['hasta']:
                    diagnosticos[diagnostico_id].append(v)

    print("=" * 70)
    print("COMPARACION DE DIAGNOSTICOS DE RPM DENTRO DE EVENTOS DE RALENTI CONFIRMADO")
    print("=" * 70)
    for diagnostico_id, valores in diagnosticos.items():
        print(f"\nDiagnostico: {diagnostico_id}")
        if not valores:
            print("  *** SIN DATOS. ***")
            continue
        serie = pd.Series(valores)
        print(f"  Lecturas: {len(serie)}  Min: {serie.min():.0f}  P5: {serie.quantile(.05):.0f}  "
              f"Mediana: {serie.median():.0f}  P95: {serie.quantile(.95):.0f}  Max: {serie.max():.0f}")
        if args.ventana:
            lo, hi = args.ventana
            dentro = sum(1 for v in valores if lo <= v <= hi)
            print(f"  Dentro de la ventana {lo}-{hi} RPM: {dentro}/{len(valores)} ({dentro / len(valores) * 100:.1f}%)")


# ---------------------------------------------------------------------------
# Subcomando: diagnosticar-regla
# ---------------------------------------------------------------------------

def comando_diagnosticar_regla(args):
    api = gc.conectar_geotab()
    print("Cargando arbol de grupos y vehiculos...")
    grupos_por_id, padre_de, _ = gc.obtener_arbol_grupos(api)
    devices = api.get('Device')
    nombres_por_id = {d['id']: d.get('name', d['id']) for d in devices}

    print(f"\n{'=' * 70}\nPASO 1 -- Buscando la regla exacta: '{args.regla}'\n{'=' * 70}")
    regla, parecidas = gc.buscar_regla(api, args.regla)
    if not regla:
        print("*** NO SE ENCONTRO una regla con ese nombre EXACTO. ***")
        if parecidas:
            print("Reglas parecidas:")
            for n in parecidas:
                print(f"  - {n}")
        return
    print(f"Regla encontrada. ID: {regla['id']}")

    print(f"\n{'=' * 70}\nPASO 2 -- Alcance real de la regla\n{'=' * 70}")
    grupos_regla = regla.get('groups') or []
    if grupos_regla:
        print("Grupos asignados directamente:")
        for g in grupos_regla:
            gid = gc.obtener_id(g)
            print(f"  - {grupos_por_id.get(gid, {}).get('name', gid)}")
    else:
        print("*** Sin grupos asignados -- se asume alcance total. ***")

    vehiculos_cubiertos = gc.resolver_vehiculos_en_alcance(devices, regla, grupos_por_id, padre_de)
    ids_cubiertos = {d['id'] for d in vehiculos_cubiertos}
    print(f"\nVehiculos dentro del alcance real ({len(vehiculos_cubiertos)}):")
    for d in vehiculos_cubiertos:
        print(f"  - {nombres_por_id[d['id']]}")
    if not vehiculos_cubiertos:
        print("  *** NINGUN vehiculo cae en el alcance -- por eso nunca va a generar eventos.")

    print(f"\n{'=' * 70}\nPASO 3 -- Eventos en los ultimos {args.dias} dias\n{'=' * 70}")
    f_fin = datetime.now(timezone.utc)
    f_inicio = f_fin - timedelta(days=args.dias)
    eventos = api.get('ExceptionEvent', search={
        'ruleSearch': {'id': regla['id']},
        'fromDate': f_inicio.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    })

    if not eventos:
        print(f"\n*** CERO eventos en los ultimos {args.dias} dias. ***")
        if vehiculos_cubiertos:
            print("*** La regla tiene vehiculos en su alcance pero nunca se ha disparado.")
            print("*** Revisa el diagnostico de RPM usado en la condicion -- compara con")
            print("*** 'rango-rpm' si un ID generico (DiagnosticEngineSpeedId) realmente reporta datos.")
    else:
        print(f"\n{len(eventos)} evento(s) en total.")
        eventos_en_alcance = [ev for ev in eventos if gc.obtener_id(ev.get('device')) in ids_cubiertos]
        print(f"De esos, {len(eventos_en_alcance)} corresponden a vehiculos dentro del alcance esperado.")
        for ev in sorted(eventos_en_alcance, key=lambda e: e.get('activeFrom', '')):
            id_veh = gc.obtener_id(ev.get('device'))
            desde = pd.to_datetime(ev.get('activeFrom')).tz_convert(ZONA_BOGOTA)
            hasta = pd.to_datetime(ev.get('activeTo')).tz_convert(ZONA_BOGOTA)
            duracion_min = (hasta - desde).total_seconds() / 60
            print(f"  - {nombres_por_id.get(id_veh, id_veh)}: {desde.strftime('%d/%m/%Y %H:%M:%S')} ({duracion_min:.1f} min)")


# ---------------------------------------------------------------------------
# Subcomando: historico-vehiculo
# ---------------------------------------------------------------------------

def comando_historico_vehiculo(args):
    api = gc.conectar_geotab()
    devices = api.get('Device')
    vehiculo = next((d for d in devices if d.get('name', '').strip() == args.vehiculo), None)
    if not vehiculo:
        print(f"*** No se encontro el vehiculo '{args.vehiculo}'. ***")
        parecidos = [d.get('name', '') for d in devices if args.vehiculo.split('-')[0] in d.get('name', '')]
        if parecidos:
            print("Vehiculos parecidos:", ', '.join(parecidos))
        return

    regla, parecidas = gc.buscar_regla(api, args.regla)
    if not regla:
        print(f"*** No se encontro la regla '{args.regla}'. ***")
        if parecidas:
            print("Reglas parecidas:", ', '.join(parecidas))
        return

    f_fin = datetime.now(timezone.utc)
    f_inicio = f_fin - timedelta(days=args.dias)
    eventos_raw = api.get('ExceptionEvent', search={
        'ruleSearch': {'id': regla['id']}, 'deviceSearch': {'id': vehiculo['id']},
        'fromDate': f_inicio.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    })

    eventos = []
    for ev in (eventos_raw or []):
        desde, hasta = ev.get('activeFrom'), ev.get('activeTo')
        if not desde or not hasta:
            continue
        dt_desde = pd.to_datetime(desde).tz_convert(ZONA_BOGOTA)
        dt_hasta = pd.to_datetime(hasta).tz_convert(ZONA_BOGOTA)
        eventos.append({
            'fecha': dt_desde.date(), 'hora': dt_desde.strftime('%H:%M'),
            'hora_num': dt_desde.hour, 'duracion_min': (dt_hasta - dt_desde).total_seconds() / 60,
        })

    print(f"\n{'=' * 70}\nHISTORICO -- {args.vehiculo} -- ultimos {args.dias} dias\n{'=' * 70}")
    if not eventos:
        print("\nSin eventos en todo el periodo.")
        return

    fechas_unicas = sorted(set(e['fecha'] for e in eventos))
    print(f"\nTotal eventos: {len(eventos)}")
    print(f"Dias distintos con evento: {len(fechas_unicas)} de {args.dias} dias en la ventana")
    if len(fechas_unicas) == 1:
        print(f"*** Todos los eventos caen en un SOLO dia ({fechas_unicas[0]}) -- parece aislado, no recurrente. ***")
    else:
        print("*** Se repite en multiples dias -- patron recurrente. ***")

    por_fecha = defaultdict(list)
    for e in eventos:
        por_fecha[e['fecha']].append(e)

    print(f"\n{'Fecha':<14}{'Eventos':>10}{'Min. totales':>15}")
    print("-" * 40)
    for fecha in sorted(por_fecha.keys()):
        evs = por_fecha[fecha]
        print(f"{str(fecha):<14}{len(evs):>10}{sum(e['duracion_min'] for e in evs):>15.1f}")

    conteo_horas = defaultdict(int)
    for e in eventos:
        conteo_horas[e['hora_num']] += 1
    print("\nDistribucion por hora del dia:")
    for hora in sorted(conteo_horas.keys()):
        print(f"  {hora:02d}:00  {'#' * conteo_horas[hora]} ({conteo_horas[hora]})")

    print("\nDetalle cronologico:")
    for fecha in sorted(por_fecha.keys()):
        for e in sorted(por_fecha[fecha], key=lambda x: x['hora']):
            print(f"  {fecha} {e['hora']}  -> {e['duracion_min']:.1f} min")


# ---------------------------------------------------------------------------
# Subcomando: ubicaciones
# ---------------------------------------------------------------------------

def comando_ubicaciones(args):
    api = gc.conectar_geotab()
    devices = api.get('Device')
    vehiculo = next((d for d in devices if d.get('name', '').strip() == args.vehiculo), None)
    if not vehiculo:
        print(f"*** No se encontro el vehiculo '{args.vehiculo}'. ***")
        return
    id_vehiculo = vehiculo['id']

    regla, parecidas = gc.buscar_regla(api, args.regla)
    if not regla:
        print(f"*** No se encontro la regla '{args.regla}'. ***")
        if parecidas:
            print("Reglas parecidas:", ', '.join(parecidas))
        return

    f_fin = datetime.now(timezone.utc)
    f_inicio = f_fin - timedelta(days=args.dias)
    eventos_raw = api.get('ExceptionEvent', search={
        'ruleSearch': {'id': regla['id']}, 'deviceSearch': {'id': id_vehiculo},
        'fromDate': f_inicio.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    })
    if not eventos_raw:
        print("Sin eventos en el periodo.")
        return

    print("Consultando LogRecord (GPS)...")
    logs_raw = api.get('LogRecord', search={
        'deviceSearch': {'id': id_vehiculo},
        'fromDate': f_inicio.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    })
    df_logs = pd.DataFrame(logs_raw or [])
    if df_logs.empty:
        print("*** No hay registros GPS para este vehiculo en el periodo. ***")
        return
    df_logs['dateTime'] = pd.to_datetime(df_logs['dateTime'])
    df_logs = df_logs.sort_values('dateTime')

    print(f"\n{'=' * 90}\nUBICACION DE CADA EVENTO -- {args.vehiculo}\n{'=' * 90}")
    ubicaciones = []
    for ev in sorted(eventos_raw, key=lambda e: e.get('activeFrom', '')):
        desde = pd.to_datetime(ev.get('activeFrom'))
        idx = (df_logs['dateTime'] - desde).abs().idxmin()
        fila = df_logs.loc[idx]
        desde_local = desde.tz_convert(ZONA_BOGOTA)
        lat, lon = fila.get('latitude'), fila.get('longitude')
        ubicaciones.append({'hora': desde_local.strftime('%H:%M'), 'lat': lat, 'lon': lon})
        print(f"\n{desde_local.strftime('%Y-%m-%d %H:%M')}")
        print(f"  Coordenadas: {lat}, {lon}")
        print(f"  Ver en mapa: https://www.google.com/maps?q={lat},{lon}")

    print(f"\n{'=' * 90}\nCOMPARACION ENTRE PARADAS\n{'=' * 90}")
    UMBRAL_MISMO_LUGAR_METROS = 150
    for i in range(1, len(ubicaciones)):
        a, b = ubicaciones[i - 1], ubicaciones[i]
        if None in (a['lat'], a['lon'], b['lat'], b['lon']):
            continue
        dist = gc.distancia_metros_aprox(a['lat'], a['lon'], b['lat'], b['lon'])
        etiqueta = "MISMO LUGAR" if dist < UMBRAL_MISMO_LUGAR_METROS else "lugar DISTINTO"
        print(f"  {a['hora']} -> {b['hora']}: {dist:.0f} m -- {etiqueta}")


# ---------------------------------------------------------------------------
# Subcomando: comparar-turnos (comportamiento de manejo por turno, mismo vehiculo)
# ---------------------------------------------------------------------------

def comando_comparar_turnos(args):
    api = gc.conectar_geotab()
    devices = api.get('Device')

    # Busqueda flexible: el usuario suele dar solo el numero de movil (ej. "1161"),
    # no la placa completa, asi que se busca por substring en el nombre.
    coincidencias = [d for d in devices if args.vehiculo.lower() in d.get('name', '').lower()]
    if len(coincidencias) == 0:
        print(f"*** No se encontro ningun vehiculo que contenga '{args.vehiculo}' en el nombre. ***")
        return
    if len(coincidencias) > 1:
        print(f"*** Varios vehiculos coinciden con '{args.vehiculo}':")
        for d in coincidencias:
            print(f"  - {d.get('name')}")
        print("*** Se usa el primero de la lista. Si no es el correcto, usa --vehiculo con el nombre completo. ***")
    vehiculo = coincidencias[0]
    id_vehiculo = vehiculo['id']
    nombre_vehiculo = vehiculo.get('name', id_vehiculo)
    print(f"Vehiculo: {nombre_vehiculo}")

    regla, parecidas = gc.buscar_regla(api, args.regla)
    if not regla:
        print(f"*** No se encontro la regla '{args.regla}'. ***")
        if parecidas:
            print("Reglas parecidas:", ', '.join(parecidas))
        return

    if args.desde and args.hasta:
        # Rango exacto en fechas de Bogota (dia completo): desde las 00:00 del
        # dia 'desde' hasta las 00:00 del dia SIGUIENTE a 'hasta' -- asi
        # "hasta el 31" incluye todo el 31, no se corta a medianoche.
        try:
            fecha_desde = datetime.strptime(args.desde, '%Y-%m-%d').replace(tzinfo=ZONA_BOGOTA)
            fecha_hasta = datetime.strptime(args.hasta, '%Y-%m-%d').replace(tzinfo=ZONA_BOGOTA) + timedelta(days=1)
        except ValueError:
            print(f"*** --desde/--hasta deben tener formato YYYY-MM-DD (ej. 2026-08-24). ***")
            return
        f_inicio = fecha_desde.astimezone(timezone.utc)
        f_fin = fecha_hasta.astimezone(timezone.utc)
        print(f"Consultando eventos entre {args.desde} y {args.hasta} (hora Bogotá, ambos dias incluidos)...")
    else:
        f_fin = datetime.now(timezone.utc)
        f_inicio = f_fin - timedelta(days=args.dias)
        print(f"Consultando eventos de los ultimos {args.dias} dias (ventana amplia; el reporte te dice el rango real con datos)...")

    eventos_raw = api.get('ExceptionEvent', search={
        'ruleSearch': {'id': regla['id']}, 'deviceSearch': {'id': id_vehiculo},
        'fromDate': f_inicio.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    })

    candidatos = []
    for ev in (eventos_raw or []):
        desde, hasta = ev.get('activeFrom'), ev.get('activeTo')
        if not desde or not hasta:
            continue
        dt_desde = pd.to_datetime(desde)
        dt_hasta = pd.to_datetime(hasta)
        duracion_seg = (dt_hasta - dt_desde).total_seconds()
        if duracion_seg < args.duracion_minima:
            continue
        candidatos.append({
            'id_veh': id_vehiculo, 'activeFrom': dt_desde, 'activeTo': dt_hasta, 'duracion_seg': duracion_seg,
        })

    if not candidatos:
        print("\nSin eventos que cumplan la duracion minima en el periodo -- nada que comparar.")
        return

    print(f"Confirmando PTO cercano (±{gc.VENTANA_PTO_MINUTOS} min) y RPM pico...")
    confirmados = gc.confirmar_pto_cercano(api, candidatos)
    gc.agregar_rpm_pico(api, confirmados)

    if not confirmados:
        print("\nNinguno de los eventos tuvo PTO confirmado cerca -- nada que comparar (revisa si la regla realmente exige PTO, o si el diagnostico de PTO no esta reportando).")
        return

    for c in confirmados:
        c['desde_local'] = c['activeFrom'].tz_convert(ZONA_BOGOTA)
        c['turno'] = gc.clasificar_turno(c['desde_local'].hour)
        c['duracion_min'] = c['duracion_seg'] / 60

    fechas = [c['desde_local'].date() for c in confirmados]
    print(f"\n{'=' * 70}\nSOBRE-REVOLUCIÓN CON PTO -- {nombre_vehiculo}\n{'=' * 70}")
    print(f"Rango real con eventos encontrados: {min(fechas)} a {max(fechas)} ({len(set(fechas))} dia(s) distintos)")
    print(f"Total eventos con PTO confirmado: {len(confirmados)}")

    print("\nComparativo por turno (proxy de conductor, ya que no hay ID de conductor configurado):")
    turnos_presentes = sorted(set(c['turno'] for c in confirmados))
    print(f"\n{'Turno':<8}{'Eventos':>10}{'Min. totales':>15}{'Min. promedio':>16}{'Min. max':>12}{'RPM promedio':>15}{'RPM max':>10}")
    print("-" * 86)
    for turno in turnos_presentes:
        del_turno = [c for c in confirmados if c['turno'] == turno]
        duraciones = [c['duracion_min'] for c in del_turno]
        rpms = [c['rpm_pico'] for c in del_turno if c.get('rpm_pico') is not None]
        rpm_prom = f"{sum(rpms) / len(rpms):.0f}" if rpms else "N/D"
        rpm_max = f"{max(rpms):.0f}" if rpms else "N/D"
        print(f"{turno:<8}{len(del_turno):>10}{sum(duraciones):>15.1f}{sum(duraciones) / len(duraciones):>16.1f}{max(duraciones):>12.1f}{rpm_prom:>15}{rpm_max:>10}")

    print("\nDetalle cronologico:")
    for c in sorted(confirmados, key=lambda x: x['activeFrom']):
        rpm_texto = f"{c['rpm_pico']:.0f} RPM" if c.get('rpm_pico') is not None else "N/D"
        print(f"  {c['desde_local'].strftime('%Y-%m-%d %H:%M:%S')} [{c['turno']}]  {c['duracion_min']:>5.1f} min   {rpm_texto}")


# ---------------------------------------------------------------------------
# Subcomando: densidad-diagnostico (revisar si un diagnostico dejo de reportar)
# ---------------------------------------------------------------------------

def comando_densidad_diagnostico(args):
    api = gc.conectar_geotab()
    devices = api.get('Device')
    coincidencias = [d for d in devices if args.vehiculo.lower() in d.get('name', '').lower()]
    if not coincidencias:
        print(f"*** No se encontro ningun vehiculo que contenga '{args.vehiculo}'. ***")
        return
    if len(coincidencias) > 1:
        print(f"*** Varios vehiculos coinciden con '{args.vehiculo}', usando el primero: {coincidencias[0].get('name')} ***")
    vehiculo = coincidencias[0]
    print(f"Vehiculo: {vehiculo.get('name')}")

    if args.desde and args.hasta:
        fecha_desde = datetime.strptime(args.desde, '%Y-%m-%d').replace(tzinfo=ZONA_BOGOTA)
        fecha_hasta = datetime.strptime(args.hasta, '%Y-%m-%d').replace(tzinfo=ZONA_BOGOTA) + timedelta(days=1)
        f_inicio = fecha_desde.astimezone(timezone.utc)
        f_fin = fecha_hasta.astimezone(timezone.utc)
    else:
        f_fin = datetime.now(timezone.utc)
        f_inicio = f_fin - timedelta(days=args.dias)

    print(f"Consultando diagnostico '{args.diagnostico}' (sin filtrar por eventos, todo el rango)...")
    lecturas = api.get('StatusData', search={
        'diagnosticSearch': {'id': args.diagnostico},
        'deviceSearch': {'id': vehiculo['id']},
        'fromDate': f_inicio.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        'toDate': f_fin.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    })

    print(f"\n{'=' * 60}\nDENSIDAD DE '{args.diagnostico}' -- {vehiculo.get('name')}\n{'=' * 60}")
    print(f"Total lecturas en el periodo: {len(lecturas or [])}")

    if not lecturas:
        print("\n*** CERO lecturas en todo el periodo. Este diagnostico no esta reportando nada para este vehiculo en este rango. ***")
        return

    df = pd.DataFrame(lecturas)
    df['dateTime'] = pd.to_datetime(df['dateTime']).dt.tz_convert(ZONA_BOGOTA)
    df['fecha'] = df['dateTime'].dt.date
    df['valor'] = pd.to_numeric(df['data'], errors='coerce')

    conteo_por_dia = df.groupby('fecha').agg(lecturas=('dateTime', 'count'), valor_min=('valor', 'min'), valor_max=('valor', 'max'))
    print(f"\n{'Fecha':<14}{'Lecturas':>10}{'Valor min':>12}{'Valor max':>12}")
    print("-" * 48)
    todas_fechas = pd.date_range(f_inicio.astimezone(ZONA_BOGOTA).date(), f_fin.astimezone(ZONA_BOGOTA).date() - timedelta(days=1)).date
    for fecha in todas_fechas:
        if fecha in conteo_por_dia.index:
            fila = conteo_por_dia.loc[fecha]
            print(f"{str(fecha):<14}{int(fila['lecturas']):>10}{fila['valor_min']:>12.0f}{fila['valor_max']:>12.0f}")
        else:
            print(f"{str(fecha):<14}{'0 <<<':>10}{'--':>12}{'--':>12}")

    dias_sin_datos = [f for f in todas_fechas if f not in conteo_por_dia.index]
    if dias_sin_datos:
        print(f"\n*** {len(dias_sin_datos)} dia(s) con CERO lecturas de este diagnostico: {dias_sin_datos} ***")
        print("*** Si esto empieza en una fecha especifica y sigue asi hasta hoy, el dispositivo probablemente")
        print("*** dejo de reportar esta senal (revisar configuracion del dispositivo / conectividad).")


# ---------------------------------------------------------------------------
# Subcomando: listar-reglas (encontrar el nombre EXACTO de una regla)
# ---------------------------------------------------------------------------

def comando_listar_reglas(args):
    api = gc.conectar_geotab()
    reglas = api.get('Rule')
    contiene = (args.contiene or '').lower()
    coincidencias = [r for r in reglas if contiene in r.get('name', '').lower()]

    print(f"\n{'=' * 70}")
    if contiene:
        print(f"Reglas cuyo nombre contiene '{args.contiene}' (insensible a mayusculas):")
    else:
        print("Todas las reglas:")
    print("=" * 70)

    if not coincidencias:
        print("\n(ninguna coincidencia)")
        return

    for r in sorted(coincidencias, key=lambda x: x.get('name', '')):
        print(f"  - '{r.get('name')}'  (id: {r.get('id')})")
    print(f"\nTotal: {len(coincidencias)}")


# ---------------------------------------------------------------------------
# Subcomando: verificar-zona
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Subcomando: comparar-fechas (mismo vehiculo/regla, dos dias especificos --
# ej. lunes de esta semana vs. el lunes anterior, para comparar turnos/
# conductores que rotan semana por medio)
# ---------------------------------------------------------------------------

def comando_comparar_fechas(args):
    api = gc.conectar_geotab()
    devices = api.get('Device')

    coincidencias = [d for d in devices if args.vehiculo.lower() in d.get('name', '').lower()]
    if len(coincidencias) == 0:
        print(f"*** No se encontro ningun vehiculo que contenga '{args.vehiculo}' en el nombre. ***")
        return
    if len(coincidencias) > 1:
        print(f"*** Varios vehiculos coinciden con '{args.vehiculo}':")
        for d in coincidencias:
            print(f"  - {d.get('name')}")
        print("*** Se usa el primero de la lista. ***")
    vehiculo = coincidencias[0]
    id_vehiculo = vehiculo['id']
    nombre_vehiculo = vehiculo.get('name', id_vehiculo)
    print(f"Vehiculo: {nombre_vehiculo}")

    regla, parecidas = gc.buscar_regla(api, args.regla)
    if not regla:
        print(f"*** No se encontro la regla '{args.regla}'. ***")
        if parecidas:
            print("Reglas parecidas:", ', '.join(parecidas))
        return

    # Sin --fecha1/--fecha2: por defecto, el lunes de esta semana vs. el lunes
    # de la semana anterior (weekday(): lunes=0 ... domingo=6).
    if args.fecha1 and args.fecha2:
        fecha1 = datetime.strptime(args.fecha1, '%d/%m/%Y').date()
        fecha2 = datetime.strptime(args.fecha2, '%d/%m/%Y').date()
    else:
        hoy = datetime.now(ZONA_BOGOTA).date()
        fecha1 = hoy - timedelta(days=hoy.weekday())
        fecha2 = fecha1 - timedelta(days=7)

    print(f"Comparando: {fecha1.strftime('%d/%m/%Y')} vs {fecha2.strftime('%d/%m/%Y')}")

    fechas_objetivo = {fecha1, fecha2}
    inicio_dia = min(fechas_objetivo)
    fin_dia = max(fechas_objetivo) + timedelta(days=1)
    f_inicio_local = datetime.combine(inicio_dia, datetime.min.time(), tzinfo=ZONA_BOGOTA)
    f_fin_local = datetime.combine(fin_dia, datetime.min.time(), tzinfo=ZONA_BOGOTA)
    f_inicio_utc = f_inicio_local.astimezone(timezone.utc)
    f_fin_utc = f_fin_local.astimezone(timezone.utc)

    eventos_raw = api.get('ExceptionEvent', search={
        'ruleSearch': {'id': regla['id']}, 'deviceSearch': {'id': id_vehiculo},
        'fromDate': f_inicio_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ'),
        'toDate': f_fin_utc.strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    })

    candidatos = []
    for ev in (eventos_raw or []):
        desde, hasta = ev.get('activeFrom'), ev.get('activeTo')
        if not desde or not hasta:
            continue
        dt_desde = pd.to_datetime(desde)
        dt_hasta = pd.to_datetime(hasta)
        duracion_seg = (dt_hasta - dt_desde).total_seconds()
        if duracion_seg < args.duracion_minima:
            continue
        candidatos.append({'id_veh': id_vehiculo, 'activeFrom': dt_desde, 'activeTo': dt_hasta, 'duracion_seg': duracion_seg})

    if not candidatos:
        print("\nSin eventos en ninguna de las dos fechas -- nada que comparar.")
        return

    print(f"Confirmando PTO cercano (±{gc.VENTANA_PTO_MINUTOS} min) y RPM pico...")
    confirmados = gc.confirmar_pto_cercano(api, candidatos)
    gc.agregar_rpm_pico(api, confirmados)

    for c in confirmados:
        c['desde_local'] = c['activeFrom'].tz_convert(ZONA_BOGOTA)
        c['fecha_local'] = c['desde_local'].date()
        c['duracion_min'] = c['duracion_seg'] / 60

    # Solo se conservan eventos que caigan EXACTAMENTE en una de las dos fechas
    # pedidas -- la consulta trajo el rango completo entre las dos, incluyendo
    # dias intermedios si las fechas dadas no son consecutivas.
    confirmados = [c for c in confirmados if c['fecha_local'] in fechas_objetivo]

    print(f"\n{'=' * 70}\nSOBRE-REVOLUCIÓN CON PTO -- {nombre_vehiculo}\n{'=' * 70}")
    print(f"Total eventos con PTO confirmado en las 2 fechas: {len(confirmados)}")

    print(f"\n{'Fecha':<14}{'Eventos':>10}{'Min. totales':>15}{'Min. promedio':>16}{'Min. max':>12}{'RPM promedio':>15}{'RPM max':>10}")
    print("-" * 92)
    for fecha in sorted(fechas_objetivo):
        del_dia = [c for c in confirmados if c['fecha_local'] == fecha]
        if not del_dia:
            print(f"{fecha.strftime('%d/%m/%Y'):<14}{'0':>10}{'—':>15}{'—':>16}{'—':>12}{'—':>15}{'—':>10}")
            continue
        duraciones = [c['duracion_min'] for c in del_dia]
        rpms = [c['rpm_pico'] for c in del_dia if c.get('rpm_pico') is not None]
        rpm_prom = f"{sum(rpms) / len(rpms):.0f}" if rpms else "N/D"
        rpm_max = f"{max(rpms):.0f}" if rpms else "N/D"
        print(f"{fecha.strftime('%d/%m/%Y'):<14}{len(del_dia):>10}{sum(duraciones):>15.1f}{sum(duraciones) / len(duraciones):>16.1f}{max(duraciones):>12.1f}{rpm_prom:>15}{rpm_max:>10}")

    for fecha in sorted(fechas_objetivo):
        del_dia = sorted([c for c in confirmados if c['fecha_local'] == fecha], key=lambda x: x['activeFrom'])
        print(f"\nDetalle {fecha.strftime('%d/%m/%Y')} ({len(del_dia)} evento(s)):")
        if not del_dia:
            print("  (sin eventos)")
            continue
        for c in del_dia:
            rpm_texto = f"{c['rpm_pico']:.0f} RPM" if c.get('rpm_pico') is not None else "N/D"
            print(f"  {c['desde_local'].strftime('%H:%M:%S')}   {c['duracion_min']:>5.1f} min   {rpm_texto}")


def comando_verificar_zona(args):
    api = gc.conectar_geotab()
    zonas_raw = api.get('Zone')
    candidatas = [
        z for z in zonas_raw if isinstance(z, dict) and (
            args.zona.lower() in str(z.get('id', '')).lower()
            or args.zona.lower() in str(z.get('name', '')).lower()
            or args.zona.lower() in str(z.get('externalReference', '')).lower()
        )
    ]
    if not candidatas:
        print(f"*** No se encontro ninguna zona que coincida con '{args.zona}'. ***")
        return

    print(f"Zona(s) candidata(s): {[z.get('name', z.get('id')) for z in candidatas]}")
    for zona in candidatas:
        puntos = zona.get('points') or []
        if not puntos:
            print(f"\nZona '{zona.get('name')}': sin poligono definido.")
            continue
        poligono = [(p['x'], p['y']) for p in puntos]
        centro_lon = sum(p[0] for p in poligono) / len(poligono)
        centro_lat = sum(p[1] for p in poligono) / len(poligono)
        dentro = gc.punto_en_poligono(args.lon, args.lat, poligono)
        dist = gc.distancia_metros_aprox(args.lat, args.lon, centro_lat, centro_lon)
        print(f"\nZona: {zona.get('name')}")
        print(f"  Centro: {centro_lat:.6f}, {centro_lon:.6f}  (distancia al punto dado: {dist:.0f} m)")
        print(f"  *** {'DENTRO' if dentro else 'FUERA'} de esta zona. ***")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Herramientas de analisis de ralenti (Geotab)")
    sub = parser.add_subparsers(dest='comando', required=True)

    p = sub.add_parser('resumen', help='Resumen de ralenti por tipologia')
    p.add_argument('--tipologia', required=True, help="Ej: furgon, n400")
    p.add_argument('--dias', type=int, default=7)
    p.add_argument('--regla', default=NOMBRE_REGLA_RALENTI_DEFECTO)
    p.set_defaults(func=comando_resumen)

    p = sub.add_parser('rango-rpm', help='Comparar diagnosticos de RPM en eventos confirmados')
    p.add_argument('--tipologia', required=True)
    p.add_argument('--dias', type=int, default=7)
    p.add_argument('--regla', default=NOMBRE_REGLA_RALENTI_DEFECTO)
    p.add_argument('--diagnostico-alterno', default=None, help="Segundo ID de diagnostico a comparar contra el validado")
    p.add_argument('--ventana', type=float, nargs=2, metavar=('MIN', 'MAX'), default=(585, 715))
    p.set_defaults(func=comando_rango_rpm)

    p = sub.add_parser('diagnosticar-regla', help='Validar si una regla especifica genera eventos')
    p.add_argument('--regla', required=True)
    p.add_argument('--dias', type=int, default=30)
    p.set_defaults(func=comando_diagnosticar_regla)

    p = sub.add_parser('historico-vehiculo', help='Patron historico de una regla en un vehiculo')
    p.add_argument('--regla', required=True)
    p.add_argument('--vehiculo', required=True)
    p.add_argument('--dias', type=int, default=60)
    p.set_defaults(func=comando_historico_vehiculo)

    p = sub.add_parser('ubicaciones', help='Ubicacion GPS de cada evento de un vehiculo')
    p.add_argument('--regla', required=True)
    p.add_argument('--vehiculo', required=True)
    p.add_argument('--dias', type=int, default=60)
    p.set_defaults(func=comando_ubicaciones)

    p = sub.add_parser('comparar-turnos', help='Comparar comportamiento de manejo por turno (mismo vehiculo, ej. sobre-revolucion con PTO)')
    p.add_argument('--regla', required=True)
    p.add_argument('--vehiculo', required=True, help="Busqueda por substring, ej: 1161")
    p.add_argument('--dias', type=int, default=90, help="Ventana hacia atras desde hoy (se ignora si usas --desde/--hasta)")
    p.add_argument('--desde', default=None, help="Fecha inicio exacta, formato YYYY-MM-DD (hora Bogota), ej: 2026-08-24")
    p.add_argument('--hasta', default=None, help="Fecha fin exacta (incluida), formato YYYY-MM-DD, ej: 2026-08-31")
    p.add_argument('--duracion-minima', type=int, default=30, help="Segundos minimos del evento (default 30, igual que la regla)")
    p.set_defaults(func=comando_comparar_turnos)

    p = sub.add_parser('comparar-fechas', help='Comparar dos fechas especificas (ej. lunes de esta semana vs. lunes anterior)')
    p.add_argument('--regla', required=True)
    p.add_argument('--vehiculo', required=True, help="Busqueda por substring, ej: 1161")
    p.add_argument('--fecha1', default=None, help="DD/MM/YYYY. Si se omite junto con --fecha2, usa el lunes de esta semana")
    p.add_argument('--fecha2', default=None, help="DD/MM/YYYY. Si se omite junto con --fecha1, usa el lunes de la semana anterior")
    p.add_argument('--duracion-minima', type=int, default=30)
    p.set_defaults(func=comando_comparar_fechas)

    p = sub.add_parser('densidad-diagnostico', help='Revisar si un diagnostico dejo de reportar (lecturas por dia)')
    p.add_argument('--vehiculo', required=True, help="Busqueda por substring, ej: 1161")
    p.add_argument('--diagnostico', default='aW3Nmy-ktfEuvrdkya4z0yg', help="ID del diagnostico (default: RPM validado)")
    p.add_argument('--dias', type=int, default=14)
    p.add_argument('--desde', default=None, help="Fecha inicio exacta YYYY-MM-DD")
    p.add_argument('--hasta', default=None, help="Fecha fin exacta YYYY-MM-DD")
    p.set_defaults(func=comando_densidad_diagnostico)

    p = sub.add_parser('listar-reglas', help='Listar reglas por coincidencia parcial (para encontrar el nombre EXACTO)')
    p.add_argument('--contiene', default='', help="Texto a buscar dentro del nombre, ej: PTO")
    p.set_defaults(func=comando_listar_reglas)

    p = sub.add_parser('verificar-zona', help='Confirmar si una coordenada cae dentro de una zona')
    p.add_argument('--lat', type=float, required=True)
    p.add_argument('--lon', type=float, required=True)
    p.add_argument('--zona', required=True)
    p.set_defaults(func=comando_verificar_zona)

    args = parser.parse_args()
    print("Conectando a Geotab...")
    args.func(args)


if __name__ == "__main__":
    main()
