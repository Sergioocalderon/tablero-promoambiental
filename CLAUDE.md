# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Fleet maintenance/telemetry tooling for Promoambiental (a waste-collection company)
built on top of the Geotab API (`mygeotab`). It has three independent deployables
that all read the same Geotab account but run on different schedules/hosts, plus a
folder of one-off analysis/audit scripts:

- **`app.py`** — Streamlit dashboard (5 tabs: `fallas`, `alertas`, `niveles`,
  `seguimiento`, `revolución`). Deployed on Streamlit Community Cloud; `index.html`
  embeds it in an iframe; `keep_alive.py` (run via `.github/workflows/keep-alive.yml`,
  every 6h) uses Playwright to click through Streamlit's "wake up" screen since the
  free tier sleeps after inactivity. Also writes/reads a Google Sheet (via `gspread`)
  to snapshot which fault codes were already seen, so re-loading the dashboard
  doesn't treat everything as new.
- **`telegram_alertas.py`** — standalone script, NOT run by the dashboard. Runs via
  `.github/workflows/alertas-telegram.yml` every 5 minutes on GitHub Actions. Polls
  Geotab for new faults/rule events and pushes messages/PDFs to a Telegram bot. Its
  own dedup state lives in `telegram_estado.json`, persisted between runs with
  `actions/cache` (gitignored, not a real DB).
- **`herramientas/`** — CLI scripts for one-off analysis, rule auditing, and rule
  correction. Not deployed anywhere; run manually. `herramientas/README.md`
  documents which older scripts (`analisis_ralenti_furgones.py`,
  `analisis_rpm_ralenti_furgones.py`, `diagnostico_regla_furgon.py`,
  `diagnostico_regla.py`, `analisis_historico_1927.py`, `ubicacion_eventos_1927.py`,
  `verificar_zona_sede.py`) were superseded by `analisis_ralenti.py` and are pending
  deletion — treat them as deprecated if you encounter them.

## Commands

```bash
pip install -r requirements.txt          # app.py deps
pip install mygeotab pandas python-dotenv reportlab openpyxl   # herramientas/ scripts

streamlit run app.py                     # run the dashboard locally
python telegram_alertas.py               # run one polling cycle by hand (normally cron-only)

# herramientas/ tools (each is self-contained, run from herramientas/):
python geotab_reglas_v3.py --list                                  # list all rules
python geotab_reglas_v3.py --start YYYY-MM-DD --end YYYY-MM-DD --rules "NOMBRE"   # validate a rule
python geotab_reglas_v3.py --duration-report "NOMBRE" --start ... --end ... --con-localidad --con-marca  # Excel report
python analisis_ralenti.py diagnosticar-regla --regla "NOMBRE" --dias 30          # scope + event check for one rule
python barrido_grupos_reglas.py          # audit every custom rule's group scope vs. its name
```

There is no test suite, linter, or build step in this repo — nothing to run beyond
the scripts themselves.

### Credentials (three separate paths, same Geotab account)

- `herramientas/` scripts and `telegram_alertas.py` read `.env`
  (`GEOTAB_USUARIO`, `GEOTAB_CONTRASENA`, `GEOTAB_DATABASE`, `GEOTAB_SERVER`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
- `app.py` reads `.streamlit/secrets.toml`.
- The GitHub Actions workflows read the same variable names from repo secrets.

All three are gitignored; there is no committed `.env.example`.

## Architecture notes that span multiple files

**Group hierarchy encodes city, "tipología" (vehicle role, e.g. `COMPACTADORES
DOBLES`), and "marca" (engine/brand group, e.g. `International - Hv607`).** There is
no dedicated field for any of these on `Device` — they're inferred by walking a
vehicle's Geotab `groups` up the parent chain and matching against known group
names. This resolution logic (`obtener_mapa_grupos`, `resolver_ciudad_tipologia`,
`resolver_marca`) is duplicated with slightly different names across `app.py`,
`telegram_alertas.py`, and `herramientas/geotab_reglas_v3.py` — when fixing a
group-resolution bug, check whether it needs fixing in more than one file.
`herramientas/geotab_comun.py` is the one place other `herramientas/` scripts
actually share this logic instead of duplicating it (`obtener_arbol_grupos`,
`resolver_vehiculos_en_alcance`, `buscar_regla`).

**`telegram_alertas.py` restricts almost everything to `CIUDAD_FILTRO = 'Bogotá'`**
(a module-level constant) — this is a deliberate, temporary scoping decision while
the alerting process matures, not a hard architectural limit. Setting it to `None`
re-enables all cities without touching anything else.

**PTO (power take-off / compactor) is a pulse, not a level** — real hardware pulses
it on/off roughly every second, so no Geotab rule condition can require it directly
without misfiring constantly. Rules named "... CON PTO" generally do NOT check PTO
in their own condition; confirmation happens after the fact by cross-referencing
`DiagnosticPowerTakeoffEngagedId` StatusData within a time window around the
candidate event (`VENTANA_PTO_MINUTOS = 3`, see `_filtrar_por_pto_cercano` in
`telegram_alertas.py`). Any analysis of an "over-rev with PTO" style rule that
doesn't do this cross-reference will overcount heavily (idle-high-RPM without the
compactor engaged looks identical to the rule condition itself).

**Two different alert-dedup semantics coexist in `telegram_alertas.py`, on
purpose:**
- Fleet-wide alerts (faults, general over-rev) use an **append-only** "ever
  notified" set — required because many diagnostics pulse `Active → None → Active`
  within seconds, and re-notifying on every pulse would be unusable spam.
- Per-vehicle urgent tracking (`revisar_seguimiento`, driven by the `/seguir`
  Telegram command) instead keeps a **snapshot of what's currently active**, so a
  code that resolves and later genuinely reappears gets re-notified. Don't port one
  pattern to a new alert without deciding which semantics actually fits it.
- Either way, a clave must only be added to the "notified" state after the send
  actually succeeds (`enviar_telegram`/`_enviar_documento_telegram` return
  `True`/`False`, they don't raise on failure) — marking something notified before
  confirming delivery has caused a real alert to go permanently silent before.

**Editing a Geotab `Rule` programmatically always follows the same pattern** (see
`actualizar_duracion_regla`/`actualizar_grupos_regla` in `geotab_reglas_v3.py`, and
the same pattern is re-used ad hoc elsewhere): fetch the full rule, dump a JSON
backup into `backups_reglas/` *before* mutating anything, mutate the specific
condition node in place, `api.set('Rule', regla)`, then re-fetch and print the
result to confirm the write actually took. Geotab has been observed to hold two
`Diagnostic` entities with the **identical display name** but different IDs (one
dead, one live) — a rule condition can end up pointing at the dead one, which looks
like a calibration bug (0 events forever) but is actually a wrong-ID bug; check for
a same-named duplicate before assuming the threshold itself is wrong.

**`Diccionario_Fallas.csv`** (repo root) is `app.py`'s manual SPN/FMI-to-description
lookup, kept independent of whatever name Geotab itself reports for a diagnostic —
the two can disagree.
