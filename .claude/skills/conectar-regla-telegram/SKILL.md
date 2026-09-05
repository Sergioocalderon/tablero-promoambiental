---
name: conectar-regla-telegram
description: Conecta una regla ya validada de Geotab a una alerta en tiempo real del bot de Telegram (telegram_alertas.py), siguiendo el mismo patrón que sobre-revolución/temperatura de motor. Usar cuando el usuario pida avisar, notificar, alertar o conectar al bot una regla de Geotab que ya existe.
---

# Conectar una regla de Geotab al bot de Telegram

Antes de esto, la regla debería estar validada (ver skill `validar-regla`) — conectar
una regla rota solo automatiza el ruido. Este skill agrega una alerta nueva a
`telegram_alertas.py`, que corre cada 5 min vía GitHub Actions
(`.github/workflows/alertas-telegram.yml`).

## Paso 1 — Elegir el patrón según el tipo de evento

- **Evento puntual sin ventana de confirmación extra** (temperatura de motor,
  regeneración DPF pendiente, salida de zona): usar `_obtener_eventos_regla` directo.
  Ver `revisar_temperatura_motor` como plantilla — es el caso más simple.
- **Evento que necesita confirmar algo cercano en el tiempo** (ej. sobre-revolución
  con PTO, donde el PTO es un pulso y no viene en la condición de la regla): usar
  `_obtener_eventos_regla(..., requiere_pto_cercano=True)` o el patrón de
  `_filtrar_por_pto_cercano` si es una confirmación distinta a PTO.
- **Fallas de FaultData** (no ExceptionEvent de una Rule): ese camino ya existe y es
  distinto — ver `revisar_fallas_activas` / `generar_pdf_reporte_fallas`. Este skill
  es para reglas basadas en `ExceptionEvent`, no para fallas.

## Paso 2 — Escribir la función de revisión

Nombre: `revisar_<algo_descriptivo>(api, claves_ya_notificadas)`. Cuerpo mínimo
(copiar y adaptar de `revisar_temperatura_motor`):

```python
NOMBRE_REGLA_XXX = 'NOMBRE EXACTO DE LA REGLA EN GEOTAB'

def revisar_xxx(api, claves_ya_notificadas):
    devices = {d['id']: d for d in api.get('Device')}
    mapa_grupos = obtener_mapa_grupos(api)

    f_fin = datetime.now(timezone.utc)
    f_inicio = f_fin - timedelta(hours=VENTANA_REVISION_HORAS)
    candidatos = _obtener_eventos_regla(api, NOMBRE_REGLA_XXX, f_inicio, f_fin)
    candidatos = [c for c in candidatos if c['clave'] not in claves_ya_notificadas]
    if CIUDAD_FILTRO:
        candidatos = [
            c for c in candidatos
            if resolver_ciudad_tipologia(devices.get(c['id_veh'], {}).get('groups'), mapa_grupos)[0] == CIUDAD_FILTRO
        ]

    claves_nuevas = []
    for c in candidatos:
        vehiculo = devices.get(c['id_veh'], {})
        nombre_veh = vehiculo.get('name', c['id_veh'])
        ciudad, tipologia = resolver_ciudad_tipologia(vehiculo.get('groups'), mapa_grupos)
        hora_local = c['activeFrom'].tz_convert(ZONA_BOGOTA).strftime('%d/%m/%Y %H:%M:%S')
        texto = (
            f"<EMOJI> <TITULO EN MAYUSCULAS>\n"
            f"Vehículo: {nombre_veh}\n"
            f"Ciudad: {ciudad}\n"
            f"Tipología: {tipologia}\n"
            f"Hora: {hora_local}\n"
            f"Duración: {c['duracion_seg']:.0f} segundos sostenidos\n"
            f"<contexto/acción recomendada>"
        )
        if enviar_telegram(texto):          # <- SOLO se marca notificado si esto da True
            print(f"Notificado (xxx): {c['clave']}")
            claves_nuevas.append(c['clave'])

    if claves_nuevas:
        print(f"Total xxx notificados en esta corrida: {len(claves_nuevas)}")
    else:
        print("Sin eventos nuevos de xxx que notificar.")
    return claves_nuevas
```

**Bug ya cometido una vez, no repetir:** si en vez de texto simple se manda un PDF
(`generar_pdf_reporte_fallas` + `_enviar_documento_telegram`), `_enviar_documento_telegram`
devuelve `False` en vez de lanzar excepción cuando falla el envío. Si el código marca
como "notificado" sin chequear ese `True`/`False`, una falla de red silencia el
evento PARA SIEMPRE (su clave no cambia entre corridas). Siempre condicionar el
`append`/unión de claves al resultado real del envío, nunca marcar "notificado" solo
porque se intentó.

## Paso 3 — Estado persistente (dedup entre corridas)

En `cargar_estado()`: agregar la clave nueva (ej. `"xxx_notificados": []`) al dict
`default` y a la lista de claves tipo-lista que se copian desde el JSON leído.
En `guardar_estado()`: agregarla al dict que se escribe (con el mismo slice
`[-MAX_CLAVES_GUARDADAS:]` que usan las demás).

Semántica por defecto: **lista que solo crece** (unión, nunca reemplazo) — evita
re-notificar un código que pulsa Active→None→Active en segundos. Si la regla es para
seguimiento urgente de un vehículo puntual donde SÍ importa re-avisar tras un
resolver-y-reaparecer real (no un pulso de segundos), usar en cambio el patrón de
"foto del estado actual" de `revisar_seguimiento` — son dos semánticas distintas a
propósito, no mezclarlas sin pensar cuál aplica.

## Paso 4 — Conectar en `main()`

```python
claves_xxx_previas = set(estado['xxx_notificados'])
claves_xxx_nuevas = revisar_xxx(api, claves_xxx_previas)
estado['xxx_notificados'] = list(claves_xxx_previas | set(claves_xxx_nuevas))
```

Agregarlo después de las revisiones existentes, antes de `enviar_resumenes_por_hora`.

## Paso 5 — Probar antes de pushear

Simular un evento real o forzado y verificar que el texto arma bien, SIN mandar nada
de verdad: mockear `enviar_telegram = lambda *a, **k: True` (o `False` para probar el
camino de fallo) y correr la función contra Geotab real de solo-lectura. En consola
Windows, si el texto tiene emoji, imprimir con
`sys.stdout.reconfigure(encoding='utf-8')` primero o el print revienta por encoding
(no es un bug del código, es la consola).

Borrar cualquier script de prueba (`_test_*.py`) antes de commitear — no son
herramientas reutilizables, son descartables.

## Paso 6 — Commit y push

`git fetch origin main` primero (puede haber commits de otra persona tocando el
mismo archivo — mergear, no sobrescribir). Commit descriptivo en español explicando
qué regla se conectó y por qué. Push. Avisar al usuario que el cambio tarda hasta
~5 minutos en tomar efecto (el cron corre cada 5 min), no es instantáneo.
