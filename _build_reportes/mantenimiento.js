/* ============================================================================
   Add-In: Mantenimiento (Fallas)

   Hasta el 2026-10-01 este archivo era "reportes.js", UN add-in con 3 tipos
   de reporte elegibles por pill (Fallas / Operaciones / Mini Expediente). El
   usuario pidió separarlo en DOS add-ins independientes de MyGeotab --
   decisión explicita, ver cambios/2026-10-01_separar-en-dos-addins.md para
   el detalle completo de qué se movió a dónde. Esta carpeta
   (_build_reportes/) se queda siendo el add-in de MANTENIMIENTO (mínima
   disrupción al historial de changelogs ya acumulado aquí desde el
   2026-09-29); el reporte de Operaciones (hábitos: velocidad, ralentí,
   PTO) se mudó a un add-in nuevo y separado en _build_operaciones/ (ver
   _build_operaciones/cambios/2026-10-01_creacion-addin-operaciones.md).

   CAMBIO (2026-10-01, el mismo día, por la tarde): el Mini Expediente
   (tercera pill agregada más abajo en "Tercera versión") se agregó aquí
   primero pero se movió COMPLETO a Alertas por Severidad
   (_build_alertas_fallas/) poco después -- decisión explícita del usuario
   tras notar que ese add-in ya resolvía conductor/turno por fila y no
   necesitaba picker. Este archivo volvió a quedar con un solo modo (Fallas),
   igual que cuando se separó Operaciones. Ver
   cambios/2026-10-01_quitar-mini-expediente.md.

   Esta pantalla deja elegir una empresa (grupo Geotab) + rango de fechas y
   descarga un reporte HTML autocontenido -- el MISMO diseño visual/
   estructura/motor JS que ya se usa para los reportes de fallas generados
   por un script Python separado (fuera de este repo), pero disparado desde
   dentro de MyGeotab.

   DUPLICACIÓN INTENCIONAL (aceptada explícitamente con el usuario, no es
   un error a corregir): el código compartido entre este add-in y el de
   Operaciones -- conexión a la API, catálogos de diagnósticos, resolución
   de empresa/dispositivos, el motor de plantillas (MOTOR_JS_EMBEBIDO), el
   sistema de diseño (T/crearPill/inyectarEstilosGlobales), helpers de
   fecha -- vive DUPLICADO, verbatim, en operaciones.js. Geotab no soporta
   compartir un módulo JS entre dos add-ins de forma sencilla, y aunque lo
   soportara, el usuario ya decidió que la separación completa de archivos
   es preferible a mantener un acoplamiento entre dos add-ins con ciclos de
   vida independientes.

   Historial relevante (de la época en que este archivo todavía se llamaba
   reportes.js y contenía los 3 tipos de reporte):

   Primera versión (2026-09-29): SOLO el reporte de Fallas -- ver
   cambios/2026-09-29_creacion-addin-reportes.md para el detalle completo de
   qué se portó de dónde y qué queda pendiente de confirmar.

   Segunda versión (2026-09-29/30): se agregó "Operaciones" (hábitos:
   velocidad, ralentí, PTO) como HERMANO de Fallas dentro del MISMO add-in
   (luego separado en su propio add-in, ver arriba). Usaba el MISMO motor de
   renderizado (ya soportaba DASH.kind==='habits_dashboard' desde el día 1) y
   una plantilla HTML nueva (reporte_operaciones_plantilla.html, ahora en
   _build_operaciones/). Ver cambios/2026-09-29_agregar-reporte-operaciones.md
   para el detalle de qué reglas de Geotab se usan para cada hábito y por qué
   (decisión NO confirmada con el usuario -- ver ese changelog antes de
   confiar en el reporte generado por el add-in de Operaciones).

   Tercera versión (2026-10-01): se agregó "Mini Expediente" (ficha de UN
   caso puntual de falla) como tercera pill, dentro del add-in de entonces.
   Quedó en ESTE add-in (Mantenimiento) justo tras la separación -- ver
   cambios/2026-10-01_agregar-mini-expediente.md para el detalle de qué se
   construyó -- pero se movió por completo a Alertas por Severidad poco
   después, el mismo día (ver el CAMBIO documentado arriba, al inicio de este
   bloque, y cambios/2026-10-01_quitar-mini-expediente.md). Esta versión del
   archivo YA NO tiene esa pill ni el código del expediente.

   Reutiliza (adaptado, no siempre verbatim) varios bloques ya validados en
   dashboardAnalisisFallas.js: tema visual T, apiCall/apiMultiCall, paginado
   de FaultData, catálogos Diagnostic/FailureMode, la taxonomía SISTEMAS para
   clasificar cada diagnóstico, y el conteo de "activaciones" por episodios
   (transición real hacia Active, con debounce de reactivación -- ver
   agruparPorFalla) -- mismo patrón de duplicación intencional ya documentado
   en CLAUDE.md ("Group hierarchy... duplicada con slightly different names
   across app.py, telegram_alertas.py, y herramientas/geotab_reglas_v3.py").

   El reporte final (el .html descargable) se arma combinando strings
   INCRUSTADOS en este mismo archivo (ver PLANTILLA_HTML_EMBEBIDA/
   MOTOR_JS_EMBEBIDO más abajo, generados desde
   los .html/.js que se guardan aparte solo como copia legible de referencia
   -- NO se leen en tiempo de ejecución) con los datos recién consultados a
   Geotab, antes de disparar la descarga vía Blob. CAMBIO (2026-09-29): antes
   se cargaban con fetch() como archivos hermanos, pero eso dio 404 real
   dentro de MyGeotab -- ver cambios/2026-09-29_incrustar-plantilla-y-motor-fix-404.md.
   ============================================================================ */

geotab.addin.mantenimiento = function () {
  'use strict';

  // --- Constantes de datos -------------------------------------------------
  // Mismo tope real de FaultData por llamada que ya se documentó y corrigió en
  // telegram_alertas.py / dashboardAnalisisFallas.js -- sin paginar se pierden
  // en silencio los registros más recientes de un rango grande.
  var LIMITE_PAGINA_FAULTDATA = 50000;

  // Grupos cuyo nombre contiene alguna de estas palabras se tratan como rama
  // de "marca" (motor/ensamblador), no como empresa/ciudad -- mismo criterio
  // (esGrupoMarca) ya usado en dashboardAnalisisFallas.js/telegram_alertas.py.
  // CAMBIO (2026-10-03, auditoría): + 'chevrolet' -- sin ella los grupos
  // 'CHEVROLET - NHR' / 'CHEVROLET VAN - N400' no se reconocían como marca y
  // esos vehículos salían como "Sin marca" en el reporte.
  var PALABRAS_GRUPO_MARCA = ['volkswagen', 'volskwagen', 'mercedes', 'international', 'foton', 'kenworth', 'chevrolet'];
  var NOMBRE_GRUPO_TIPOLOGIA = 'tipologia';

  // CAMBIO (2026-09-29, bug real en produccion: fetch('reporte_runtime_engine.js')
  // devolvia 404 dentro de MyGeotab aunque reportes.js si cargaba -- el Local
  // Add-In no estaba sirviendo los archivos hermanos de forma confiable). Se
  // incrustan el motor y la plantilla COMO STRINGS dentro de este mismo archivo
  // (generados con json.dumps desde los .html/.js originales, sin retipear nada a
  // mano) para que el add-in no dependa de que Geotab sirva mas de un archivo.
  var PLANTILLA_HTML_EMBEBIDA = "<!doctype html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>An\u00e1lisis y Reporte de Fallos</title>\n<style>\n:root{--ink:#0b2454;--accent:#0891b2;--corp:#2563eb;--muted:#64748b;--border:#e2e8f0;--bg:#f8fafc;--card:#ffffff;\n      --alta:#dc2626;--media:#f59e0b;--baja:#94a3b8;--good:#16a34a}\n*{box-sizing:border-box}\nbody{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:#1e293b;font-size:14px}\nheader.brand{background:var(--ink);color:#fff;padding:20px 28px}\nheader.brand .name{font-size:12px;opacity:.75;letter-spacing:.04em;text-transform:uppercase}\nheader.brand h1{margin:4px 0 2px;font-size:22px}\nheader.brand .subtitle{opacity:.85;font-size:13px}\n.executive-report-header{background:linear-gradient(115deg,#0b2454 0%,#12376f 72%,#0b2454 100%);padding:28px clamp(22px,5vw,64px) 26px;color:#fff}\n.executive-report-header .eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#a9c7ed;font-weight:700}\n.executive-report-header h1{margin:7px 0 5px;font-size:clamp(27px,3vw,40px);line-height:1.08;letter-spacing:-.02em}\n.executive-report-header .scope{font-size:clamp(15px,1.5vw,19px);font-weight:650;color:#dbeafe;letter-spacing:.01em}\n.executive-report-header .purpose{margin:13px 0 22px;max-width:760px;color:#cbd8eb;font-size:14px;line-height:1.45}\n.executive-report-header .header-grid{display:grid;grid-template-columns:minmax(260px,1.7fr) repeat(2,minmax(180px,1fr));gap:12px;align-items:stretch}\n.executive-report-header .header-item{border-top:1px solid rgba(191,219,254,.35);padding-top:10px;min-width:0}\n.executive-report-header .header-item.period{border-top:0;background:#fff;color:var(--ink);border-radius:8px;padding:14px 16px}\n.executive-report-header .header-label{display:block;font-size:10px;text-transform:uppercase;letter-spacing:.09em;font-weight:750;color:#a9c7ed;margin-bottom:5px}\n.executive-report-header .period .header-label{color:#64748b}\n.executive-report-header .period-value{font-size:clamp(17px,1.8vw,23px);font-weight:750;line-height:1.2;white-space:normal}\n.executive-report-header .period-detail{display:block;margin-top:5px;font-size:12px;color:#64748b}\n.executive-report-header .header-value{font-size:14px;line-height:1.35;color:#f8fafc}\n.executive-report-header .status-value{display:flex;align-items:center;gap:7px;font-weight:750}\n.executive-report-header .status-dot{width:8px;height:8px;border-radius:50%;background:#4ade80;flex:none}\n.executive-report-header .status-dot.warn{background:#fbbf24}.executive-report-header .status-dot.bad{background:#f87171}\n.report-fault .legacy-report-header,.report-habits .legacy-report-header{display:none}\n.executive-report-header .status-detail{display:block;margin-top:4px;font-size:11px;color:#cbd8eb;line-height:1.35}\n@media (max-width:900px){.executive-report-header .header-grid{grid-template-columns:1fr 1fr}.executive-report-header .period{grid-column:1/-1}}\n@media (max-width:600px){.executive-report-header{padding:22px 18px}.executive-report-header .header-grid{grid-template-columns:1fr;gap:14px}.executive-report-header .period{grid-column:auto}.executive-report-header .purpose{margin-bottom:18px}}\n.meta{display:flex;flex-wrap:wrap;gap:18px;margin-top:12px;font-size:12px}\n.meta div b{display:block;font-size:12px;opacity:.7;font-weight:600}\n.layout{display:flex;max-width:1520px;margin:0 auto}\nnav.toc{width:210px;flex:none;padding:20px 12px;position:sticky;top:0;align-self:flex-start;max-height:100vh;overflow:auto}\nnav.toc a{display:block;padding:7px 10px;border-radius:6px;color:#334155;text-decoration:none;font-size:13px;margin-bottom:2px}\nnav.toc a:hover{background:#e2e8f0}\nmain{flex:1;min-width:0;padding:20px 28px 60px}\n.filters-box{background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:10px 14px;margin-bottom:18px;font-size:12.5px;color:#3730a3}\n.filters-box summary{cursor:pointer;font-weight:600}\nsection{margin-bottom:34px;scroll-margin-top:14px}\nsection h2{font-size:19px;line-height:1.2;color:var(--ink);border-bottom:2px solid var(--border);padding-bottom:9px;margin:0 0 16px}\n.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:18px}\n.kpi{background:var(--card);border:1px solid var(--border);border-left:4px solid #cbd5e1;border-radius:8px;\n  padding:10px 14px;min-width:150px}\n.kpi b{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:19px;font-weight:800;color:var(--ink)}\n.kpi .kpi-caption{font-size:12px;font-weight:600;color:var(--muted)}\n.kpi span:last-child{display:block;margin-top:2px;font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}\n.kpi--priority{min-width:170px}\n.kpi--priority b{font-size:24px}\n.kpi--risk-high{border-left-color:var(--alta);background:#fef2f2}\n.kpi--risk-high b{color:#991b1b}\n.kpi--risk-mid{border-left-color:var(--media);background:#fffbeb}\n.kpi--risk-mid b{color:#92400e}\n.kpi--accent-blue{border-left-color:var(--corp);background:#eff6ff}\n.kpi--accent-blue b{color:#1e40af}\n.narrative{background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:12px 16px;margin-bottom:16px}\n.narrative li{margin-bottom:4px}\n.charts-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:16px;margin-bottom:14px;align-items:start}\n.chart-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:17px 18px;min-width:0;box-shadow:0 1px 2px rgba(15,23,42,.04)}\n.chart-card h3{margin:0;font-size:15px;line-height:1.3;color:var(--ink);font-weight:800}\n.chart-render-error{display:flex;align-items:center;justify-content:center;min-height:140px;padding:18px;text-align:center;color:#991b1b;background:#fef2f2;border:1px dashed #fecaca;border-radius:8px;font-weight:650}\n.chart-subtitle{margin:5px 0 8px;font-size:12px;color:var(--muted);line-height:1.48;max-width:78ch}\n.chart-hint{display:inline-flex;margin:0 0 12px;padding:3px 8px;border-radius:999px;background:#f1f5f9;font-size:10px;color:#64748b;font-style:normal;font-weight:650}\n.report-fault #evolucion .charts-row,.report-fault #sistemas .charts-row{grid-template-columns:minmax(0,1fr)}\n.report-fault #diagnosticos .charts-row,.report-fault #ranking .charts-row{grid-template-columns:repeat(2,minmax(0,1fr))}\n.report-fault #comparativos .charts-row{grid-template-columns:repeat(3,minmax(0,1fr))}\ntable.dt{width:100%;border-collapse:collapse;font-size:12.5px}\ntable.dt thead th{background:var(--ink);color:#fff;text-align:left;padding:7px 9px;position:sticky;top:0;cursor:pointer;white-space:nowrap}\ntable.dt thead th:after{content:'';opacity:.5;margin-left:4px}\ntable.dt thead th.sort-asc:after{content:'\u25b2'}\ntable.dt thead th.sort-desc:after{content:'\u25bc'}\ntable.dt tbody td{padding:6px 9px;border-bottom:1px solid var(--border)}\ntable.dt tbody tr:nth-child(even){background:#f8fafc}\ntable.dt.dt-compact tbody tr:nth-child(even){background:transparent}\ntable.dt tbody tr.dt-row-primary td{border-bottom:none;padding-top:8px}\ntable.dt tbody tr.dt-row-secondary td{padding:1px 9px 9px;border-bottom:1px solid var(--border);\n  font-size:11px;color:var(--muted);line-height:1.7;background:#fbfcfd}\ntable.dt tbody tr.dt-row-secondary td b{color:#475569;font-weight:700}\ntable.dt tbody tr.dt-row-primary:hover td{background:#f1f5f9}\ntable.dt tbody tr.dt-row-primary:hover + tr.dt-row-secondary td{background:#eef2f7}\n.dt-cell-wide{max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.dt-cell-narrow{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.table-sort-mobile-wrap{display:none;align-items:center;gap:6px}\n.table-sort-mobile{padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:#fff}\n.table-sort-dir{border:1px solid var(--border);background:#fff;border-radius:6px;padding:6px 10px;font-size:13px;cursor:pointer;line-height:1}\n.table-sort-dir:hover{background:#f1f5f9}\n.table-card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px;overflow:hidden}\n.master-table{border-color:#bfdbfe;box-shadow:0 0 0 1px #eff6ff}\n.cf-banner{display:none;flex-direction:column;gap:8px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;\n  border-radius:8px;padding:10px 12px;margin-bottom:10px;font-size:12.5px}\n.cf-banner.active{display:flex}\n.cf-banner .cf-banner-title{font-weight:700;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;opacity:.8}\n.cf-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}\n.cf-chip{display:inline-flex;align-items:center;gap:6px;background:#dbeafe;color:#1e3a8a;border-radius:999px;\n  padding:3px 6px 3px 12px;font-size:12px;font-weight:600}\n.cf-chip button{border:none;background:#bfdbfe;color:#1e3a8a;border-radius:50%;width:18px;height:18px;line-height:1;\n  cursor:pointer;font-size:12px;font-weight:700}\n.cf-chip button:hover{background:#93c5fd}\n.cf-banner .cf-clear-all{align-self:flex-start;border:1px solid #93c5fd;background:#fff;color:#1e40af;border-radius:6px;\n  padding:3px 10px;font-size:11.5px;cursor:pointer}\n.cf-banner .cf-clear-all:hover{background:#dbeafe}\n#cf-tip{position:fixed;z-index:9999;background:#0b2454;color:#fff;padding:6px 10px;border-radius:6px;font-size:12px;\n  line-height:1.5;pointer-events:none;box-shadow:0 4px 14px rgba(0,0,0,.25);display:none;max-width:260px}\n#cf-tip b{font-weight:700}\n.table-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}\n.table-toolbar input{padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:12.5px;min-width:200px}\n.table-scroll{overflow-x:auto}\n.table-pager{display:flex;gap:8px;align-items:center;margin-top:10px;font-size:12px;color:var(--muted)}\n.table-pager button{border:1px solid var(--border);background:#fff;border-radius:6px;padding:3px 10px;cursor:pointer}\n.table-pager button:disabled{opacity:.4;cursor:default}\n.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;border-radius:6px;transition:opacity .15s}\n.bar-row.cf-clickable{cursor:pointer}\n.bar-row.cf-clickable:hover{background:#f1f5f9}\n.cf-dim{opacity:.32}\n.cf-selected{outline:2px solid var(--accent);outline-offset:1px;border-radius:4px}\n.vbar-col.cf-clickable{cursor:pointer}\n.legend span.cf-clickable{cursor:pointer;padding:1px 6px;border-radius:5px;transition:opacity .15s}\n.legend span.cf-clickable:hover{background:#f1f5f9}\n.bar-label{width:170px;flex:none;display:flex;align-items:center;justify-content:flex-end;gap:0;font-size:12px;\n  color:#334155;text-align:right;line-height:1.25;white-space:normal;overflow:hidden;word-break:break-word}\n.bar-track{flex:1;background:#eef2f7;border-radius:4px;height:16px;position:relative;display:flex}\n.bar-seg{height:100%}\n.bar-seg:first-child{border-radius:4px 0 0 4px}\n.bar-value{font-size:11px;color:var(--muted);width:56px;flex:none}\n.vbars{position:relative;display:flex;align-items:flex-end;gap:6px;height:180px;border-bottom:1px solid var(--border);padding-bottom:2px}\n.vbar-col{flex:1;display:flex;flex-direction:column-reverse;align-items:stretch;height:100%;position:relative;transition:opacity .15s}\n.vbar-seg{width:100%}\n.vbar-value{position:absolute;bottom:100%;left:0;right:0;text-align:center;font-size:10.5px;font-weight:700;color:#334155;margin-bottom:2px}\n.vbars-labels{display:flex;gap:6px;margin-top:4px}\n.vbars-labels span{flex:1;text-align:center;font-size:10px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.evo-labels.dense span{visibility:hidden}\n.evo-labels.dense span:nth-child(3n+1),.evo-labels.dense span:last-child{visibility:visible}\n.evo-wrap.dense .evo-mini{display:none}\n.legend{display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:12px}\n.legend span{display:inline-flex;align-items:center;gap:5px}\n.legend i{width:10px;height:10px;border-radius:3px;display:inline-block}\n.pareto-row{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:'label value' 'visual visual';gap:7px 14px;padding:9px 5px;border-bottom:1px solid #edf2f7;border-radius:7px;transition:opacity .15s}\n.pareto-row:last-of-type{border-bottom:none}\n.pareto-row.cf-clickable{cursor:pointer}\n.pareto-row.cf-clickable:hover{background:#f1f5f9}\n.pareto-row .bar-label{grid-area:label;width:auto;justify-content:flex-start;text-align:left;font-size:12px;font-weight:700;color:#334155;overflow:visible;overflow-wrap:anywhere}\n.pareto-value{grid-area:value;display:flex;align-items:baseline;justify-content:flex-end;gap:5px;white-space:nowrap;color:var(--ink)}\n.pareto-value strong{font-size:14px;font-weight:850}\n.pareto-value small{font-size:9.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.025em}\n.pareto-visual{grid-area:visual;display:grid;grid-template-columns:minmax(70px,1fr) auto;align-items:center;gap:12px;min-width:0}\n.pareto-visual .bar-track{height:10px;border-radius:999px;overflow:hidden}\n.pareto-visual .bar-seg{border-radius:999px}\n.pareto-visual .crit-mini{margin-left:0;min-width:88px;justify-content:flex-end}\n.crit-key{display:flex;justify-content:flex-end;gap:11px;margin-top:10px;padding-top:9px;border-top:1px solid var(--border);font-size:9.5px;color:var(--muted)}\n.crit-key b{font-weight:850}\n.chart-scale{margin:10px 0 0;text-align:right;color:var(--muted);font-size:9.5px}\n.crit-dot{width:9px;height:9px;border-radius:50%;flex:none;display:inline-block;margin-right:2px}\n.dist-wrap{display:flex;flex-direction:column;gap:8px}\n.dist-track{display:flex;width:100%;height:22px;border-radius:6px;overflow:hidden;background:#eef2f7}\n.dist-seg{height:100%;transition:opacity .15s}\n.dist-seg.cf-clickable{cursor:pointer}\n.dist-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12.5px}\n.dist-chip{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:#334155;transition:opacity .15s}\n.dist-chip.cf-clickable{cursor:pointer}\n.dist-chip.cf-clickable:hover{text-decoration:underline}\n.dist-chip i{width:10px;height:10px;border-radius:3px;display:inline-block}\n.chart-inline{margin:2px 0 14px}\n.crit-strip{display:flex;flex-wrap:wrap;align-items:center;gap:14px 22px;padding:8px 0 2px}\n.crit-strip-head{font-size:10.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);flex:none}\n.crit-pill{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:#334155;transition:opacity .15s}\n.crit-pill.cf-clickable{cursor:pointer}\n.crit-pill.cf-clickable:hover .crit-pill-name{text-decoration:underline}\n.crit-pill.cf-selected{outline:2px solid var(--accent);outline-offset:3px;border-radius:6px}\n.crit-pill-dot{width:9px;height:9px;border-radius:50%;background:var(--crit-color,#94a3b8);flex:none}\n.crit-pill-name{font-weight:800;letter-spacing:.03em;text-transform:uppercase;font-size:10.5px}\n.crit-pill b{font-size:15px;font-weight:800;color:var(--ink)}\n.crit-pill small{color:var(--muted);font-size:11px}\n.crit-strip-bar{display:flex;width:100%;height:5px;border-radius:999px;overflow:hidden;background:#eef2f7;margin-top:2px}\n.crit-strip-bar span{height:100%}\n.crit-mini{display:inline-flex;align-items:center;gap:7px;margin-left:8px;font-size:10.5px;color:#475569;flex:none}\n.cm-item{display:inline-flex;align-items:center;gap:2px;white-space:nowrap}\n.cm-item b{font-weight:800;font-size:10.5px}\n.cm-alta{color:var(--alta)}\n.cm-media{color:var(--media)}\n.cm-baja{color:var(--baja)}\n.evo-mini{display:flex;justify-content:center;margin-left:0;margin-top:1px;font-size:9px;white-space:nowrap}\n.evo-seg{position:relative;width:100%}\n.evo-value{position:absolute;bottom:100%;left:0;right:0;text-align:center;margin-bottom:3px;white-space:nowrap}\n.evo-total{display:block;font-size:10.5px;font-weight:700;color:#334155}\n.evo-wrap{margin-top:38px}\n.avg-line{position:absolute;left:0;right:0;border-top:2px dashed #94a3b8;z-index:1}\n.avg-tag{position:absolute;right:0;top:-16px;background:#fff;color:#64748b;font-size:10px;font-weight:700;padding:1px 5px;border-radius:4px;border:1px solid var(--border)}\n.no-fault-banner{background:linear-gradient(135deg,#ecfdf5,#f0fdfa);border:1px solid #a7f3d0;border-radius:12px;\n  padding:14px 18px;margin-bottom:18px;overflow:hidden}\n.no-fault-banner .nf-head{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:800;color:#065f46;\n  text-transform:uppercase;letter-spacing:.03em;margin-bottom:8px}\n.no-fault-banner .nf-empty{font-size:13px;color:#065f46}\n.nf-ticker{position:relative;overflow:hidden;-webkit-mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent);\n  mask-image:linear-gradient(90deg,transparent,#000 6%,#000 94%,transparent)}\n.nf-track{display:flex;gap:10px;width:max-content;animation:nf-scroll 32s linear infinite}\n.nf-ticker:hover .nf-track{animation-play-state:paused}\n@keyframes nf-scroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}\n.nf-chip{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #a7f3d0;color:#065f46;\n  border-radius:999px;padding:5px 12px;font-size:12px;font-weight:700;white-space:nowrap}\n@media (prefers-reduced-motion: reduce){.nf-track{animation:none}}\n.timeline-row{display:flex;align-items:center;gap:10px;margin-bottom:5px;font-size:12px}\n.timeline-label{width:170px;flex:none;color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.timeline-track{flex:1;background:#f1f5f9;border-radius:4px;height:14px;position:relative}\n.timeline-bar{position:absolute;top:0;height:100%;border-radius:4px;min-width:3px}\n.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;color:#fff}\na.ext-link{color:var(--accent);text-decoration:none;font-weight:600;white-space:nowrap}\na.ext-link:hover{text-decoration:underline}\nfooter{text-align:center;color:var(--muted);font-size:11px;padding:24px;border-top:1px solid var(--border);margin-top:20px}\n@media print{\n  nav.toc{display:none}\n  .layout{display:block}\n  main{padding:0}\n  section{page-break-inside:avoid}\n  .table-toolbar,.table-pager{display:none}\n  body{background:#fff}\n}\n@media (max-width:1180px){\n  .report-fault #comparativos .charts-row{grid-template-columns:repeat(2,minmax(0,1fr))}\n  .table-sort-mobile-wrap{display:flex}\n  table.dt.dt-compact{display:block; width:100%}\n  table.dt.dt-compact thead{display:none}\n  table.dt.dt-compact tbody{display:block}\n  table.dt.dt-compact tbody tr.dt-row-primary{\n    display:flex;flex-wrap:wrap;column-gap:16px;row-gap:4px;\n    padding:10px 12px 6px;margin-top:10px;\n    background:var(--card);border:1px solid var(--border);border-bottom:none;\n    border-radius:8px 8px 0 0;\n  }\n  table.dt.dt-compact tbody tr.dt-row-primary td{\n    display:flex;flex-direction:column;gap:1px;\n    flex:1 1 84px;min-width:0;max-width:none;\n    padding:2px 0;border-bottom:none;\n    white-space:normal;overflow:visible;text-overflow:clip;overflow-wrap:break-word;\n  }\n  table.dt.dt-compact tbody tr.dt-row-primary td[data-label=\"Diagn\u00f3stico\"],\n  table.dt.dt-compact tbody tr.dt-row-primary td[data-label=\"Buscar\"]{flex-basis:100%}\n  table.dt.dt-compact tbody tr.dt-row-primary td[data-label=\"Categor\u00eda\"]{flex:1 1 150px}\n  table.dt.dt-compact tbody tr.dt-row-primary td::before{\n    content:attr(data-label);font-size:9.5px;font-weight:800;color:var(--muted);\n    text-transform:uppercase;letter-spacing:.03em;\n  }\n  table.dt.dt-compact tbody tr.dt-row-secondary{display:block}\n  table.dt.dt-compact tbody tr.dt-row-secondary td{\n    display:block;border:1px solid var(--border);border-top:none;\n    border-radius:0 0 8px 8px;padding:6px 12px 10px;overflow-wrap:break-word;\n  }\n  table.dt.dt-compact tbody tr.dt-row-primary:hover td,\n  table.dt.dt-compact tbody tr.dt-row-primary:hover + tr.dt-row-secondary td{background:inherit}\n  table.dt.dt-compact td.dt-cell-wide, table.dt.dt-compact td.dt-cell-narrow{\n    max-width:none;white-space:normal;overflow:visible;text-overflow:clip;\n  }\n}\n#t_maestra table.dt tbody tr.dt-row-odd{--dt-row-bg:#fff}\n#t_maestra table.dt tbody tr.dt-row-even{--dt-row-bg:#f5f8fc}\n#t_maestra table.dt tbody tr.dt-row-odd,\n#t_maestra table.dt tbody tr.dt-row-even,\n#t_maestra table.dt tbody tr.dt-row-odd td,\n#t_maestra table.dt tbody tr.dt-row-even td{background:var(--dt-row-bg)}\n#t_maestra table.dt tbody tr.dt-row-primary:hover,\n#t_maestra table.dt tbody tr.dt-row-primary:hover td,\n#t_maestra table.dt tbody tr.dt-row-primary:hover + tr.dt-row-secondary,\n#t_maestra table.dt tbody tr.dt-row-primary:hover + tr.dt-row-secondary td{\n  background:#eaf1fb;\n}\n@media (max-width:820px){\n  .layout{flex-direction:column}\n  nav.toc{width:100%;position:relative;max-height:none;display:flex;flex-wrap:wrap;gap:4px}\n  .bar-label{width:120px}\n  .report-fault #diagnosticos .charts-row,.report-fault #ranking .charts-row,\n  .report-fault #comparativos .charts-row{grid-template-columns:minmax(0,1fr)}\n  .evo-labels.dense span:nth-child(3n+1){visibility:hidden}\n  .evo-labels.dense span:nth-child(4n+1),.evo-labels.dense span:last-child{visibility:visible}\n}\n@media (max-width:560px){\n  main{padding:14px 14px 40px}\n  .kpi{min-width:130px}\n  .kpi--priority{min-width:140px}\n  .bar-label{width:92px;font-size:11px}\n  .chart-card{padding:14px 13px}\n  .pareto-row{grid-template-columns:minmax(0,1fr) auto;gap:6px 10px;padding:9px 2px}\n  .pareto-visual{grid-template-columns:minmax(55px,1fr);gap:5px}\n  .pareto-visual .crit-mini{justify-content:flex-start;min-width:0}\n  .pareto-value{flex-direction:column;align-items:flex-end;gap:0}\n  .pareto-value strong{font-size:13px}\n  .crit-strip{gap:10px 16px}\n  .crit-mini{margin-left:4px;gap:5px}\n}\n\n.section-empty .kpis,.section-empty .charts-row{opacity:.5}\n.kpi b .kpi-main{display:inline;margin:0;font-size:inherit;font-weight:inherit;color:inherit;text-transform:none;letter-spacing:normal}\n.evo-stack{display:flex;flex-direction:column-reverse}\n.evo-part{width:100%;flex:none}\n.evo-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:8px;font-size:11px;color:var(--muted)}\n.evo-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}\n.report-habits .kpis--secondary .kpi{border-left-color:#e2e8f0;background:#fafcff}\n.report-habits .kpis--secondary .kpi b{font-size:16px}\n.report-habits .sec-sub{margin:-8px 0 14px;font-size:12.5px;color:var(--muted)}\n.report-habits .chart-card .bar-label{font-size:12px}\n</style>\n</head>\n<body class=\"report-fault\">\n\n<header class=\"executive-report-header\">\n  <div class=\"eyebrow\">Telemetry &amp; Fleet Intelligence</div>\n  <h1>An\u00e1lisis y Reporte de Fallos</h1>\n  <div class=\"scope\">{{EMPRESA}}</div>\n  <p class=\"purpose\">Comportamiento de fallas, criticidad, sistemas afectados y concentraci\u00f3n en la flota</p>\n  <div class=\"header-grid\">\n    <div class=\"header-item period\"><span class=\"header-label\">Periodo analizado</span><span class=\"period-value\">{{PERIODO_VALUE}}</span><span class=\"period-detail\">{{PERIODO_DETAIL}}</span></div>\n    <div class=\"header-item\"><span class=\"header-label\">Generado</span><span class=\"header-value\">{{GENERADO}}</span></div>\n  </div>\n</header>\n<div class=\"layout\">\n  <nav class=\"toc\"><a href=\"#resumen\">Resumen ejecutivo</a><a href=\"#evolucion\">Evoluci\u00f3n en el periodo</a><a href=\"#sistemas\">Sistemas</a><a href=\"#diagnosticos\">Diagn\u00f3sticos</a><a href=\"#ranking\">Ranking de m\u00f3viles</a><a href=\"#comparativos\">Comparativos normalizados</a><a href=\"#detalle\">Detalle de fallos</a></nav>\n  <main>\n    <div id=\"nofault-slot\"></div>\n    <details class=\"filters-box\"><summary>Filtros aplicados</summary><ul id=\"filters-list\"></ul></details>\n    <section id=\"resumen\" class=\"section-resumen\"><h2>Resumen ejecutivo</h2><div class=\"kpis\"><div class=\"kpi\"><b id=\"kpi-fallas_distintas\"></b><span>Fallas distintas</span></div><div class=\"kpi kpi--priority kpi--risk-high\"><b id=\"kpi-moviles_afectados\"></b><span>M\u00f3viles afectados</span></div><div class=\"kpi kpi--priority kpi--risk-high\"><b id=\"kpi-fallas_alta\"></b><span>Fallas ALTA</span></div><div class=\"kpi kpi--priority kpi--accent-blue\"><b id=\"kpi-sistema_principal\"></b><span>Sistema principal</span></div><div class=\"kpi kpi--priority kpi--risk-mid\"><b id=\"kpi-concentracion\"></b><span>Concentraci\u00f3n</span></div></div><div class=\"chart chart-inline\" id=\"criticidad_donut\" data-kind=\"distribution\" data-src=\"data-criticidad_donut\"></div><script type=\"application/json\" id=\"data-criticidad_donut\">{}</script><div class=\"narrative\"><ul id=\"narrative-list\"></ul></div></section>\n    <section id=\"evolucion\" class=\"section-evolucion\"><h2>Evoluci\u00f3n en el periodo</h2><div class=\"charts-row\"><div class=\"chart-card chart-card--evolution\"><h3>Fallas distintas por d\u00eda</h3><p class=\"chart-subtitle\">Cada barra muestra fallas distintas activas ese d\u00eda; la l\u00ednea punteada marca el promedio diario.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"evolucion_bar\" data-kind=\"evolution\" data-src=\"data-evolucion_bar\" style=\"min-height:280px\"></div><script type=\"application/json\" id=\"data-evolucion_bar\">{}</script></div></div></section>\n    <section id=\"sistemas\" class=\"section-sistemas\"><h2>Sistemas</h2><div class=\"charts-row\"><div class=\"chart-card chart-card--pareto\"><h3>Fallas distintas por sistema</h3><p class=\"chart-subtitle\">Cantidad de fallas diferentes agrupadas por sistema. No incluye las fallas sin sistema identificado (siguen contando en el total y en el detalle). A/M/B muestra el desglose por criticidad.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"sistemas_bar\" data-kind=\"pareto\" data-src=\"data-sistemas_bar\" style=\"min-height:390px\"></div><script type=\"application/json\" id=\"data-sistemas_bar\">{}</script></div></div></section>\n    <section id=\"diagnosticos\" class=\"section-diagnosticos\"><h2>Diagn\u00f3sticos</h2><div class=\"charts-row\"><div class=\"chart-card chart-card--pareto\"><h3>Top 12 c\u00f3digos m\u00e1s extendidos en la flota</h3><p class=\"chart-subtitle\">Cobertura: cu\u00e1ntos m\u00f3viles distintos presentaron este c\u00f3digo (no cu\u00e1ntas veces se activ\u00f3).</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"diagnosticos_bar\" data-kind=\"pareto\" data-src=\"data-diagnosticos_bar\" style=\"min-height:360px\"></div><script type=\"application/json\" id=\"data-diagnosticos_bar\">{}</script></div><div class=\"chart-card chart-card--pareto\"><h3>Top 12 c\u00f3digos m\u00e1s frecuentes</h3><p class=\"chart-subtitle\">Frecuencia: total de activaciones del c\u00f3digo en el periodo, sumando todos los m\u00f3viles.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"diagnosticos_frecuentes_bar\" data-kind=\"pareto\" data-src=\"data-diagnosticos_frecuentes_bar\" style=\"min-height:360px\"></div><script type=\"application/json\" id=\"data-diagnosticos_frecuentes_bar\">{}</script></div></div></section>\n    <section id=\"ranking\" class=\"section-ranking\"><h2>Ranking de m\u00f3viles</h2><div class=\"charts-row\"><div class=\"chart-card chart-card--pareto\"><h3>Top 10 m\u00f3viles con m\u00e1s fallas distintas</h3><p class=\"chart-subtitle\">Variedad: cu\u00e1ntos tipos diferentes de falla present\u00f3 cada m\u00f3vil (no cu\u00e1ntas veces se repiti\u00f3 cada uno).</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"ranking_bar\" data-kind=\"pareto\" data-src=\"data-ranking_bar\" style=\"min-height:300px\"></div><script type=\"application/json\" id=\"data-ranking_bar\">{}</script></div><div class=\"chart-card chart-card--pareto\"><h3>Top 10 m\u00f3viles por activaciones totales</h3><p class=\"chart-subtitle\">Volumen: cu\u00e1ntas veces se activ\u00f3 una falla en total en ese m\u00f3vil (incluye repeticiones del mismo c\u00f3digo).</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"ranking_activaciones_bar\" data-kind=\"pareto\" data-src=\"data-ranking_activaciones_bar\" style=\"min-height:300px\"></div><script type=\"application/json\" id=\"data-ranking_activaciones_bar\">{}</script></div></div></section>\n    <section id=\"comparativos\" class=\"section-comparativos\"><h2>Comparativos normalizados</h2><div class=\"charts-row\"><div class=\"chart-card chart-card--pareto\"><h3>Comparativo por tipo de veh\u00edculo</h3><p class=\"chart-subtitle\">Tasa de fallas distintas por veh\u00edculo del grupo. La barra ya est\u00e1 normalizada por el tama\u00f1o real del grupo.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"tipo_bar\" data-kind=\"pareto\" data-src=\"data-tipo_bar\" style=\"min-height:200px\"></div><script type=\"application/json\" id=\"data-tipo_bar\">{}</script></div><div class=\"chart-card chart-card--pareto\"><h3>Comparativo por marca</h3><p class=\"chart-subtitle\">Tasa de fallas distintas por veh\u00edculo del grupo. La barra ya est\u00e1 normalizada por el tama\u00f1o real del grupo.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"marca_bar\" data-kind=\"pareto\" data-src=\"data-marca_bar\" style=\"min-height:200px\"></div><script type=\"application/json\" id=\"data-marca_bar\">{}</script></div><div class=\"chart-card chart-card--pareto\"><h3>Comparativo por empresa</h3><p class=\"chart-subtitle\">Tasa de fallas distintas por veh\u00edculo del grupo. La barra ya est\u00e1 normalizada por el tama\u00f1o real del grupo.</p><p class=\"chart-hint\">Haz clic para filtrar</p><div class=\"chart\" id=\"empresa_bar\" data-kind=\"pareto\" data-src=\"data-empresa_bar\" style=\"min-height:200px\"></div><script type=\"application/json\" id=\"data-empresa_bar\">{}</script></div></div></section>\n    <section id=\"detalle\" class=\"section-detalle\"><h2>Detalle de fallos</h2><div class=\"table-card master-table\" id=\"t_maestra\" data-src=\"data-t_maestra\"><div class=\"cf-banner\"><div class=\"cf-banner-title\">Filtros del dashboard</div><div class=\"cf-chips\" id=\"cf-chips-global\"></div><button class=\"cf-clear-all\" onclick=\"window.cfClearAll()\">Mostrar todas las fallas</button></div><div class=\"table-toolbar\"><h3 style=\"margin:0;font-size:13.5px\">Detalle de fallos</h3><div class=\"table-sort-mobile-wrap\"><select class=\"table-sort-mobile\" aria-label=\"Ordenar por\"></select><button type=\"button\" class=\"table-sort-dir\" title=\"Cambiar direcci\u00f3n\" aria-label=\"Cambiar direcci\u00f3n\">\u2193</button></div><input class=\"table-search\" type=\"text\" placeholder=\"Buscar en detalle de fallos\u2026\"></div><div class=\"table-scroll\"></div><div class=\"table-pager\"></div><p style=\"font-size:11px;color:var(--muted);margin:6px 0 0\">Una fila por falla distinta (m\u00f3vil + diagn\u00f3stico + m\u00f3dulo). Haz clic en cualquier gr\u00e1fica para filtrar.</p><script type=\"application/json\" id=\"data-t_maestra\">{}</script></div></section>\n    <footer>Telemetry &amp; Fleet Intelligence \u00b7 Documento generado autom\u00e1ticamente a partir del hist\u00f3rico de la flota.<p>El an\u00e1lisis considera una falla \u00fanica por veh\u00edculo, c\u00f3digo y m\u00f3dulo que la reporta \u2014 no cada vez que se enciende o se apaga, que puede ocurrir muchas veces al d\u00eda.</p><p>La criticidad de cada falla es la m\u00e1s alta que tuvo en el periodo: ALTA (luz roja o de protecci\u00f3n), MEDIA (luz \u00e1mbar) o BAJA (sin luz de alerta).</p><p>\u00abC\u00f3digo propietario\u00bb agrupa fallas del fabricante sin una descripci\u00f3n est\u00e1ndar disponible.</p><p>Las comparaciones por veh\u00edculo, marca o empresa usan el tama\u00f1o real de cada grupo en la flota, no solo el total de fallas \u2014 as\u00ed un grupo peque\u00f1o no parece m\u00e1s problem\u00e1tico solo por tener m\u00e1s veh\u00edculos.</p><p>\u00abSiguen activas\u00bb refleja el \u00faltimo estado reportado; algunas fallas no siempre notifican cuando se resuelven.</p></footer>\n  </main>\n</div>\n<script type=\"application/json\" id=\"data-dashboard-dataset\">{}</script>\n<script id=\"report-runtime-script\">\n/* === PEGAR AQU\u00cd, TAL CUAL, TODO EL BLOQUE <script> (IIFE) DEL ARCHIVO\n   ORIGINAL Reporte_Fallos_PACARIBE_2026-09-27.html, DESDE\n   \"(function(){\" HASTA EL \"})();\" FINAL -- ES EL MOTOR DE RENDERIZADO\n   (cross-filter, renderPareto, renderEvolution, tablas, etc.), NO SE\n   MODIFICA. Est\u00e1 documentado \u00edntegro en Reporte_Fallos_PACARIBE_2026-09-27.html\n   guardado junto a este archivo. */\n</script>\n</body>\n</html>\n";
  var MOTOR_JS_EMBEBIDO = "/* Motor de renderizado del reporte de fallas (cross-filter, tablas, gr\u00e1ficas\n   Pareto/evoluci\u00f3n/distribuci\u00f3n). Se sirve tal cual junto con reportes.js/\n   reportes.html dentro del add-in, y reportes.js lo lee en tiempo de\n   ejecuci\u00f3n (fetch) para incrustarlo VERBATIM dentro de cada reporte HTML\n   generado -- no se modifica esta l\u00f3gica, es puro motor de presentaci\u00f3n sin\n   nada espec\u00edfico de una empresa o periodo. */\n(function(){\n  function byId(id){return document.getElementById(id);}\n  function readData(srcId){var el=byId(srcId); return el?JSON.parse(el.textContent):null;}\n\n  // ============================================================\n  // CROSS-FILTER MULTI-DIMENSIONAL \u2014 100% en el navegador (cierre 2026-09)\n  // ============================================================\n  // CF = {clave: [valores]} \u2014 VARIOS filtros combinables. MISMA\n  // dimensi\u00f3n = OR entre sus valores; DIMENSIONES DISTINTAS = AND.\n  // Un gr\u00e1fico EMITE (spec.cfKey/spec.cfLabel); clic a\u00f1ade el valor a\n  // su dimensi\u00f3n, clic de nuevo sobre el mismo lo quita. La tabla\n  // maestra ESCUCHA (payload.crossfilter: [{column,key,label,match}]).\n  var CF = {};\n  var CF_LABELS = {};\n  var CF_TABLES = [];\n\n  function cfToggle(key, val, label){\n    CF_LABELS[key] = label || key;\n    var arr = CF[key] || [];\n    var idx = arr.indexOf(val);\n    if(idx === -1) arr = arr.concat([val]); else arr = arr.slice(0, idx).concat(arr.slice(idx + 1));\n    if(arr.length) CF[key] = arr; else delete CF[key];\n    refreshCrossfilter();\n    // Ajuste puntual 2026-09: SIN auto-scroll a la tabla maestra \u2014 el\n    // usuario pidi\u00f3 expl\u00edcitamente que un clic de filtro no interrumpa\n    // la lectura del dashboard moviendo la vista por su cuenta. El\n    // scroll solo debe moverlo el usuario.\n  }\n  function cfRemoveValue(key, val){\n    var arr = (CF[key] || []).filter(function(v){ return v !== val; });\n    if(arr.length) CF[key] = arr; else delete CF[key];\n    refreshCrossfilter();\n  }\n  function cfClearKey(key){ delete CF[key]; refreshCrossfilter(); }\n  function cfClearAll(){ CF = {}; refreshCrossfilter(); }\n  window.cfClearAll = cfClearAll;\n  function refreshCrossfilter(){\n    recomputeDashboard();\n    CF_TABLES.forEach(function(fn){ fn(); });\n    renderChips();\n    document.querySelectorAll('[data-cf-key]').forEach(function(el){\n      var key = el.getAttribute('data-cf-key'), val = el.getAttribute('data-cf-value');\n      var active = CF[key];\n      el.classList.toggle('cf-dim', !!active && active.indexOf(val) === -1);\n      el.classList.toggle('cf-selected', !!active && active.indexOf(val) !== -1);\n    });\n  }\n\n  // ============================================================\n  // REC\u00c1LCULO GLOBAL \u2014 KPIs + TODOS los gr\u00e1ficos (fase final 2026-09)\n  // ============================================================\n  // Espejo EXACTO de `_dashboard_from_rows()` (Python, motor de la app):\n  // misma \"una sola verdad anal\u00edtica\" en ambos lados. `DASH` se carga\n  // UNA vez desde el dataset embebido; cada clic solo re-agrega en\n  // memoria \u2014 cero red, cero servidor.\n  var DASH = null;\n  function loadDashboard(){\n    var el = byId('data-dashboard-dataset');\n    DASH = el ? JSON.parse(el.textContent) : null;\n  }\n  var CF_FIELD = {\n    movil: 'movil', tipo: 'tipo', marca: 'marca', empresa: 'empresa',\n    sistema: 'categoria', criticidad: 'criticidad', diagnostico: 'codigo',\n  };\n  function rowMatchesCf(row, key, values){\n    if(DASH && DASH.kind === 'habits_dashboard'){\n      var habitField = {dia:'dia', movil:'movil', empresa:'empresa', tipo:'tipoVehiculo', habit_type:'habitType', regla:'regla', duration_bin:'durationBin', turno:'shift'}[key];\n      return habitField != null && values.indexOf(row[habitField]) !== -1;\n    }\n    if(key === 'dia') return values.some(function(d){ return row.dias.indexOf(d) !== -1; });\n    var field = CF_FIELD[key];\n    return field != null && values.indexOf(row[field]) !== -1;\n  }\n  function filterRowsCf(rows, exclude){\n    var out = rows;\n    Object.keys(CF).forEach(function(key){\n      if(key === exclude) return;\n      var values = CF[key];\n      if(!values || !values.length) return;\n      out = out.filter(function(r){ return rowMatchesCf(r, key, values); });\n    });\n    return out;\n  }\n  function decFmt(v, digits){\n    digits = (digits == null) ? 1 : digits;\n    return v.toLocaleString('es-CO', {minimumFractionDigits: digits, maximumFractionDigits: digits});\n  }\n  function flotaForCf(){\n    if(CF.movil && CF.movil.length) return CF.movil.length;\n    var flota = DASH.baseFlota;\n    ['tipo', 'marca', 'empresa'].forEach(function(dim){\n      var values = CF[dim];\n      if(values && values.length){\n        var sum = 0;\n        values.forEach(function(v){ sum += (DASH.fleetSizes[dim][v] || 0); });\n        flota = Math.min(flota, sum);\n      }\n    });\n    return flota;\n  }\n  function isHiddenCategory(cat){\n    return !!(DASH && DASH.hiddenCategories && DASH.hiddenCategories.indexOf(cat) !== -1);\n  }\n  function countByField(rows, field){\n    var m = {};\n    rows.forEach(function(r){ m[r[field]] = (m[r[field]] || 0) + 1; });\n    return m;\n  }\n  function groupCriticidad(rows, field){\n    var m = {};\n    rows.forEach(function(r){\n      var g = r[field];\n      if(!m[g]) m[g] = {};\n      m[g][r.criticidad] = (m[g][r.criticidad] || 0) + 1;\n    });\n    return m;\n  }\n  function totalOfCounts(counts){\n    var t = 0; Object.keys(counts).forEach(function(k){ t += counts[k]; }); return t;\n  }\n  // Refinamiento visual ejecutivo (2026-09): criticidad dominante de un\n  // grupo (empate roto por severidad, no por orden de inserci\u00f3n) \u2014 usada\n  // para el \"badge\" de color junto al nombre en cada barra Pareto.\n  var CRIT_RANK = {ALTA: 3, MEDIA: 2, BAJA: 1};\n  function dominantCrit(counts){\n    if(!counts) return null;\n    var best = null, bestN = -1;\n    Object.keys(counts).forEach(function(c){\n      var n = counts[c] || 0;\n      if(n > bestN || (n === bestN && (CRIT_RANK[c] || 0) > (CRIT_RANK[best] || 0))){ best = c; bestN = n; }\n    });\n    return bestN > 0 ? best : null;\n  }\n  var CORPORATE_BLUE = '#2563eb';\n  // Espejo de `CRITICALITY_COLORS` (Python) \u2014 constante, no depende del\n  // dataset embebido, as\u00ed el primer render (antes de `loadDashboard()`\n  // terminar) y el rec\u00e1lculo usan siempre los mismos colores.\n  var CRIT_COLORS = {ALTA: '#dc2626', MEDIA: '#f59e0b', BAJA: '#94a3b8'};\n  // Espejo de `_split_kpi_value()` (Python): separa \"11 / 31 (35,5 %)\" en\n  // valor principal + leyenda secundaria para la jerarqu\u00eda tipogr\u00e1fica del\n  // KPI (refinamiento visual ejecutivo 2026-09).\n  function splitKpiValue(text){\n    var idx = text.indexOf(' (');\n    if(idx !== -1 && text.charAt(text.length - 1) === ')'){\n      return {main: text.slice(0, idx), caption: text.slice(idx + 1)};\n    }\n    return {main: text, caption: null};\n  }\n  // Espejo de `_kpi_visual_class()` (Python): sem\u00e1ntica de riesgo sobria\n  // (rojo/\u00e1mbar/azul) SOLO para los KPIs prioritarios \u2014 nunca una alarma\n  // permanente en el resto del tablero.\n  function kpiVisualClass(id, text){\n    if(id === 'fallas_alta') return 'kpi--risk-high';\n    if(id === 'concentracion') return 'kpi--risk-mid';\n    if(id === 'sistema_principal') return 'kpi--accent-blue';\n    if(id === 'moviles_afectados' || id === 'hab_moviles'){\n      var m = /([\\d.,]+)\\s*%/.exec(text);\n      if(m){\n        var pct = parseFloat(m[1].replace(/\\./g, '').replace(',', '.'));\n        if(pct >= 50) return 'kpi--risk-high';\n        if(pct >= 25) return 'kpi--risk-mid';\n      }\n      return 'kpi--accent-blue';\n    }\n    return '';\n  }\n  function setKpi(id, text){\n    var el = byId('kpi-' + id);\n    if(!el) return;\n    var parts = splitKpiValue(text);\n    el.textContent = '';\n    var mainSpan = document.createElement('span'); mainSpan.className = 'kpi-main'; mainSpan.textContent = parts.main;\n    el.appendChild(mainSpan);\n    if(parts.caption){\n      var capSpan = document.createElement('span'); capSpan.className = 'kpi-caption'; capSpan.textContent = parts.caption;\n      el.appendChild(capSpan);\n    }\n    var card = el.closest('.kpi');\n    if(card){\n      card.classList.remove('kpi--risk-high', 'kpi--risk-mid', 'kpi--accent-blue');\n      var cls = kpiVisualClass(id, text);\n      if(cls) card.classList.add(cls);\n    }\n  }\n  function recomputeChart(id, builder, cfKey, cfLabel){\n    var el = byId(id);\n    if(!el) return;\n    var spec = builder();\n    el.innerHTML = '';\n    var empty = !spec || (spec.categories && !spec.categories.length) || (spec.items && !spec.items.length);\n    if(empty){\n      el.style.minHeight = '';\n      el.innerHTML = '<p style=\"color:var(--muted);font-size:12.5px;padding:8px 2px\">' + ((DASH && DASH.emptyText) || 'No hay fallas para esta selecci\u00f3n.') + '</p>';\n      return;\n    }\n    spec.cfKey = cfKey; spec.cfLabel = cfLabel;\n    if(spec.height) el.style.minHeight = spec.height + 'px';\n    var kind = el.dataset.kind;\n    if(kind === 'pareto') renderPareto(el, spec);\n    else if(kind === 'evolution') renderEvolution(el, spec);\n    else if(kind === 'distribution') renderDistributionBar(el, spec);\n    else if(kind === 'evostack') renderEvoStack(el, spec);\n    else renderBar(el, spec);\n  }\n  // ============================================================\n  // REPORTE DE OPERACIONES / H\u00c1BITOS \u2014 rec\u00e1lculo global (100 % local)\n  // Dataset: DASH.rows (un evento por fila). Tres tipos: VELOCIDAD,\n  // RALENT\u00cd y PTO. Cada gr\u00e1fico excluye su PROPIA dimensi\u00f3n del filtro\n  // para no colapsarse a s\u00ed mismo (mismo criterio que Fallos).\n  // ============================================================\n  var HAB_COLORS = {'VELOCIDAD': '#2563eb', 'RALENT\u00cd': '#0891b2', 'PTO': '#7c3aed'};\n  var HAB_BINS = ['5\u201310 min', '10\u201320 min', '20 min o m\u00e1s'];\n  function hNum(v, d){ return (v || 0).toLocaleString('es-CO', {maximumFractionDigits: d == null ? 1 : d}); }\n  function hDur(v){\n    v = Math.round(v || 0);\n    if(v < 60) return v + ' s';\n    if(v < 3600) return (v / 60).toLocaleString('es-CO', {maximumFractionDigits: 1}) + ' min';\n    return fmtSeconds(v);\n  }\n  function hOf(list, t){ return list.filter(function(r){ return r.habitType === t; }); }\n  function hGroup(list, f){ var m = {}; list.forEach(function(r){ (m[r[f]] || (m[r[f]] = [])).push(r); }); return m; }\n  function hDistinct(list, f){ var s = {}; list.forEach(function(r){ s[r[f]] = 1; }); return Object.keys(s); }\n  function hSum(list, f){ return list.reduce(function(a, r){ return a + (+r[f] || 0); }, 0); }\n  function hTop(groups, valueFn){\n    var best = null, bv = -1;\n    Object.keys(groups).forEach(function(k){\n      var v = valueFn(groups[k], k);\n      if(v > bv || (v === bv && best !== null && k < best)){ best = k; bv = v; }\n    });\n    return best === null ? null : {name: best, value: bv};\n  }\n  function hUnion(list){\n    var groups = {};\n    list.forEach(function(r){\n      if(r.startMs != null && r.endMs != null){ (groups[r.idDevice] || (groups[r.idDevice] = [])).push([r.startMs, r.endMs]); }\n    });\n    var byDev = {}, total = 0;\n    Object.keys(groups).forEach(function(k){\n      var a = groups[k].sort(function(x, y){ return x[0] - y[0]; }), end = -Infinity, sum = 0;\n      a.forEach(function(x){\n        if(x[1] <= end) return;\n        if(x[0] > end){ sum += x[1] - x[0]; end = x[1]; } else { sum += x[1] - end; end = x[1]; }\n      });\n      byDev[k] = sum / 1000; total += sum / 1000;\n    });\n    return {total: total, byDev: byDev};\n  }\n  function hMedian(list, f){\n    var v = list.map(function(r){ return +r[f] || 0; }).sort(function(a, b){ return a - b; });\n    if(!v.length) return 0;\n    var m = Math.floor(v.length / 2);\n    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;\n  }\n  function hRulesOf(list){ return hDistinct(list, 'regla').sort().join(', '); }\n  function hRank(list, valueFn, unit, color, extraFn){\n    var g = hGroup(list, 'movil');\n    var items = Object.keys(g).map(function(m){\n      var x = g[m], q = x[0];\n      return {name: m, value: valueFn(x), placa: q.placa, tipo: q.tipoVehiculo, extra: extraFn(x, q)};\n    }).filter(function(it){ return it.value > 0; })\n      .sort(function(a, b){ return (b.value - a.value) || (a.name < b.name ? -1 : 1); }).slice(0, DASH.topN);\n    return items.length ? {items: items, unit: unit, color: color, height: Math.max(200, items.length * 34)} : null;\n  }\n  function recomputeHabitsDashboard(){\n    var rows = filterRowsCf(DASH.rows, null);\n    var speed = hOf(rows, 'VELOCIDAD'), idle = hOf(rows, 'RALENT\u00cd'), pto = hOf(rows, 'PTO');\n    var movs = hDistinct(rows, 'movil').length, flota = flotaForCf();\n    var pct = flota ? decFmt(100 * movs / flota) : '0,0';\n    var idleU = hUnion(idle);\n    // ---- General\n    setKpi('hab_total', hNum(rows.length, 0));\n    setKpi('hab_moviles', movs + ' / ' + flota + ' (' + pct + ' %)');\n    setKpi('hab_velocidad', hNum(speed.length, 0)); setKpi('hab_ralenti', hNum(idle.length, 0)); setKpi('hab_pto', hNum(pto.length, 0));\n    setKpi('hab_tiempo_ralenti', idle.length ? fmtSeconds(idleU.total) : '\u2014');\n    // ---- Velocidad\n    var sg = hGroup(speed, 'movil'), sr = hGroup(speed, 'regla');\n    var stop = hTop(sg, function(x){ return x.length; }), srule = hTop(sr, function(x){ return x.length; });\n    setKpi('vel_total', hNum(speed.length, 0)); setKpi('vel_moviles', String(Object.keys(sg).length));\n    setKpi('vel_top_movil', stop ? stop.name + ' (' + hNum(stop.value, 0) + ')' : '\u2014');\n    setKpi('vel_regla', srule ? srule.name : '\u2014');\n    // ---- Ralent\u00ed\n    var ig = hGroup(idle, 'movil');\n    setKpi('idle_total', hNum(idle.length, 0)); setKpi('idle_moviles', String(Object.keys(ig).length));\n    setKpi('idle_tiempo', idle.length ? fmtSeconds(idleU.total) : '\u2014');\n    setKpi('idle_prom', idle.length ? hDur(hSum(idle, 'durationSeconds') / idle.length) : '\u2014');\n    setKpi('idle_mediana', idle.length ? hDur(hMedian(idle, 'durationSeconds')) : '\u2014');\n    var itopT = hTop(ig, function(x){ return hUnion(x).total; });\n    setKpi('idle_top_tiempo', itopT ? itopT.name + ' (' + fmtSeconds(itopT.value) + ')' : '\u2014');\n    // ---- PTO\n    var pg = hGroup(pto, 'movil'), ptop = hTop(pg, function(x){ return x.length; });\n    var rpms = pto.map(function(r){ return r.rpmPeak; }).filter(function(v){ return v != null; });\n    setKpi('pto_total', hNum(pto.length, 0)); setKpi('pto_moviles', String(Object.keys(pg).length));\n    setKpi('pto_rpm', rpms.length ? hNum(Math.max.apply(null, rpms), 0) + ' rpm' : '\u2014');\n    setKpi('pto_duracion', pto.length ? fmtSeconds(hSum(pto, 'durationSeconds')) : '\u2014');\n    setKpi('pto_prom', pto.length ? hDur(hSum(pto, 'durationSeconds') / pto.length) : '\u2014');\n    setKpi('pto_top_movil', ptop ? ptop.name + ' (' + hNum(ptop.value, 0) + ')' : '\u2014');\n    // ---- Narrativa din\u00e1mica\n    var nar = byId('hab-narrative');\n    if(nar){\n      var mg = hGroup(rows, 'movil'), mtop = hTop(mg, function(x){ return x.length; });\n      var byType = [['VELOCIDAD', speed.length], ['RALENT\u00cd', idle.length], ['PTO', pto.length]].sort(function(a, b){ return b[1] - a[1]; });\n      nar.textContent = rows.length\n        ? ('Con la selecci\u00f3n actual hay ' + hNum(rows.length, 0) + ' eventos operacionales en ' + movs + ' m\u00f3vil(es): ' + hNum(speed.length, 0) + ' de velocidad, ' + hNum(idle.length, 0) + ' de ralent\u00ed y ' + hNum(pto.length, 0) + ' de sobre-revoluci\u00f3n con PTO. El mayor volumen es ' + (byType[0][0] === 'PTO' ? 'PTO' : byType[0][0].toLowerCase()) + ' (' + decFmt(100 * byType[0][1] / rows.length) + ' %); el m\u00f3vil con m\u00e1s eventos es ' + mtop.name + ' (' + hNum(mtop.value, 0) + ').' + (idle.length ? ' El tiempo en ralent\u00ed es ' + fmtSeconds(idleU.total) + ' (uni\u00f3n de intervalos, sin doble conteo).' : ''))\n        : 'No hay eventos para esta selecci\u00f3n.';\n    }\n    // ---- Evoluci\u00f3n general\n    recomputeChart('hab_evolucion', function(){\n      var base = filterRowsCf(DASH.rows, 'dia'), days = {}, movDay = {};\n      DASH.dayLabels.forEach(function(d){ days[d] = {'VELOCIDAD': 0, 'RALENT\u00cd': 0, 'PTO': 0}; movDay[d] = {}; });\n      base.forEach(function(r){ if(days[r.dia]){ days[r.dia][r.habitType] = (days[r.dia][r.habitType] || 0) + 1; movDay[r.dia][r.movil] = 1; } });\n      var vals = DASH.dayLabels.map(function(d){ return days[d]['VELOCIDAD'] + days[d]['RALENT\u00cd'] + days[d]['PTO']; });\n      if(!vals.some(function(v){ return v > 0; })) return null;\n      return {categories: DASH.dayLabels, labels: DASH.dayLabels.map(function(d){ return (DASH.dayDisplay && DASH.dayDisplay[d]) || d; }), values: vals, stacks: DASH.dayLabels.map(function(d){ return days[d]; }),\n              moviles: DASH.dayLabels.map(function(d){ return Object.keys(movDay[d]).length; }),\n              average: vals.reduce(function(a, b){ return a + b; }, 0) / (vals.length || 1), colors: HAB_COLORS};\n    }, 'dia', 'Fecha');\n    recomputeChart('hab_tipos', function(){\n      var base = filterRowsCf(DASH.rows, 'habit_type'), tot = base.length || 1;\n      var items = ['VELOCIDAD', 'RALENT\u00cd', 'PTO'].map(function(t){ var n = hOf(base, t).length; return {name: t, value: n, pct: Math.round(n / tot * 1000) / 10, color: HAB_COLORS[t]}; });\n      if(!base.length) return null;\n      return {items: items, title: 'Eventos por tipo de h\u00e1bito'};\n    }, 'habit_type', 'Tipo de h\u00e1bito');\n    // ---- Velocidad\n    var vBase = hOf(filterRowsCf(DASH.rows, 'movil'), 'VELOCIDAD');\n    recomputeChart('hab_velocidad_ranking', function(){\n      return hRank(vBase, function(x){ return x.length; }, 'eventos', '#2563eb', function(x, q){\n        return ['Empresa: <b>' + q.empresa + '</b>', 'Reglas: <b>' + hRulesOf(x) + '</b>'];\n      });\n    }, 'movil', 'M\u00f3vil');\n    recomputeChart('hab_velocidad_reglas', function(){\n      var g = hGroup(hOf(filterRowsCf(DASH.rows, 'regla'), 'VELOCIDAD'), 'regla');\n      var items = Object.keys(g).map(function(k){ return {name: k, value: g[k].length, moviles: hDistinct(g[k], 'movil').length}; }).sort(function(a, b){ return b.value - a.value; });\n      return items.length ? {items: items, unit: 'eventos', color: '#2563eb', height: Math.max(120, items.length * 40)} : null;\n    }, 'regla', 'Regla');\n    // ---- Ralent\u00ed\n    var iBase = hOf(filterRowsCf(DASH.rows, 'movil'), 'RALENT\u00cd');\n    recomputeChart('hab_ralenti_eventos', function(){\n      return hRank(iBase, function(x){ return x.length; }, 'eventos', '#0891b2', function(x, q){\n        return ['Empresa: <b>' + q.empresa + '</b>', 'Tiempo (uni\u00f3n): <b>' + fmtSeconds(hUnion(x).total) + '</b>', 'Reglas: <b>' + hRulesOf(x) + '</b>'];\n      });\n    }, 'movil', 'M\u00f3vil');\n    recomputeChart('hab_ralenti_tiempo', function(){\n      var byDev = hUnion(iBase).byDev;\n      return hRank(iBase, function(x){ return byDev[x[0].idDevice] || 0; }, 'segundos', '#0e7490', function(x, q){\n        return ['Empresa: <b>' + q.empresa + '</b>', 'Tiempo (uni\u00f3n): <b>' + fmtSeconds(byDev[x[0].idDevice] || 0) + '</b>', 'Eventos: <b>' + x.length + '</b>'];\n      });\n    }, 'movil', 'M\u00f3vil');\n    recomputeChart('hab_bins', function(){\n      var base = hOf(filterRowsCf(DASH.rows, 'duration_bin'), 'RALENT\u00cd').filter(function(r){ return HAB_BINS.indexOf(r.durationBin) !== -1; });\n      var tot = base.length;\n      var items = HAB_BINS.map(function(b){ var n = base.filter(function(r){ return r.durationBin === b; }).length; return {name: b, value: n, extra: [hNum(tot ? 100 * n / tot : 0, 1) + ' % de los eventos de 5 min o m\u00e1s']}; });\n      return tot ? {items: items, unit: 'eventos', color: '#0891b2', height: 150} : null;\n    }, 'duration_bin', 'Rango de duraci\u00f3n');\n    // ---- PTO\n    var pBase = hOf(filterRowsCf(DASH.rows, 'movil'), 'PTO');\n    function ptoExtra(x, q){\n      var r = x.map(function(e){ return e.rpmPeak; }).filter(function(v){ return v != null; });\n      return ['Empresa: <b>' + q.empresa + '</b>', 'Duraci\u00f3n total: <b>' + fmtSeconds(hSum(x, 'durationSeconds')) + '</b>', 'Duraci\u00f3n promedio: <b>' + hDur(hSum(x, 'durationSeconds') / x.length) + '</b>', 'RPM pico m\u00e1x.: <b>' + (r.length ? hNum(Math.max.apply(null, r), 0) : 'N/D') + '</b>'];\n    }\n    recomputeChart('hab_pto_eventos', function(){ return hRank(pBase, function(x){ return x.length; }, 'eventos', '#7c3aed', ptoExtra); }, 'movil', 'M\u00f3vil');\n    recomputeChart('hab_pto_tiempo', function(){ return hRank(pBase, function(x){ return hSum(x, 'durationSeconds'); }, 'segundos', '#6d28d9', ptoExtra); }, 'movil', 'M\u00f3vil');\n    recomputeChart('hab_pto_rpm', function(){\n      return hRank(pBase, function(x){ var r = x.map(function(e){ return e.rpmPeak; }).filter(function(v){ return v != null; }); return r.length ? Math.max.apply(null, r) : 0; }, 'rpm', '#a78bfa', ptoExtra);\n    }, 'movil', 'M\u00f3vil');\n    // ---- Turnos (dimensi\u00f3n GLOBAL: todos los tipos de h\u00e1bito)\n    recomputeChart('hab_turnos', function(){\n      var base = filterRowsCf(DASH.rows, 'turno');\n      if(!base.length) return null;\n      var g = hGroup(base, 'shift');\n      var items = ['T1', 'T2', 'T3'].map(function(k){\n        var x = g[k] || [];\n        return {name: k, value: x.length, moviles: hDistinct(x, 'movil').length,\n                extra: ['Velocidad: <b>' + hOf(x, 'VELOCIDAD').length + '</b>', 'Ralent\u00ed: <b>' + hOf(x, 'RALENT\u00cd').length + '</b>', 'PTO: <b>' + hOf(x, 'PTO').length + '</b>']};\n      });\n      return {items: items, unit: 'eventos', color: '#2563eb', height: 150};\n    }, 'turno', 'Turno');\n    // ---- Distribuci\u00f3n por regla (todas las reglas, tipo como contexto)\n    recomputeChart('hab_reglas', function(){\n      var g = hGroup(filterRowsCf(DASH.rows, 'regla'), 'regla');\n      var items = Object.keys(g).map(function(k){ return {name: k, value: g[k].length, moviles: hDistinct(g[k], 'movil').length, extra: ['Tipo de h\u00e1bito: <b>' + g[k][0].habitType + '</b>']}; }).sort(function(a, b){ return b.value - a.value; });\n      return items.length ? {items: items, unit: 'eventos', color: '#2563eb', height: Math.max(200, items.length * 34)} : null;\n    }, 'regla', 'Regla');\n    [['velocidad', speed.length], ['ralenti', idle.length], ['pto', pto.length]].forEach(function(p){\n      var sec = byId(p[0]); if(sec) sec.classList.toggle('section-empty', p[1] === 0);\n    });\n  }\n  function fmtSeconds(v){v=Math.round(v||0);var h=Math.floor(v/3600),m=Math.floor((v%3600)/60);return h?(h+' h '+String(m).padStart(2,'0')+' min'):(m+' min');}\n  function recomputeDashboard(){\n    if(!DASH) return;\n    if(DASH.kind === 'habits_dashboard'){ recomputeHabitsDashboard(); return; }\n    var full = filterRowsCf(DASH.rows, null);\n    var fallasDistintas = full.length;\n    var movilesSet = {}; full.forEach(function(r){ movilesSet[r.movil] = 1; });\n    var movilesAfectados = Object.keys(movilesSet).length;\n    var flota = flotaForCf();\n    setKpi('fallas_distintas', fallasDistintas.toLocaleString('es-CO'));\n    setKpi('moviles_afectados', movilesAfectados + ' / ' + flota + ' (' + (flota ? decFmt(100 * movilesAfectados / flota) : '0,0') + ' %)');\n    if(fallasDistintas){\n      var altaRows = full.filter(function(r){ return r.criticidad === 'ALTA'; });\n      if(DASH.activeCrit.indexOf('ALTA') !== -1){\n        var altaMoviles = {}; altaRows.forEach(function(r){ altaMoviles[r.movil] = 1; });\n        setKpi('fallas_alta', altaRows.length + ' en ' + Object.keys(altaMoviles).length + ' m\u00f3vil(es)');\n      } else if(DASH.activeCrit.length){\n        var fb = DASH.activeCrit[0];\n        setKpi('fallas_alta', String(full.filter(function(r){ return r.criticidad === fb; }).length));\n      }\n      // DASH.hiddenCategories (opcional, 2026-10-03): categor\u00edas que el\n      // reporte pide excluir del KPI de sistema y del gr\u00e1fico por sistema\n      // (p.ej. 'Otro / Sin clasificar', que solo mete ruido). Esas fallas\n      // siguen contando en el total y en la tabla. El % se calcula sobre el\n      // total de fallas distintas.\n      var catCounts = countByField(full.filter(function(r){ return !isHiddenCategory(r.categoria); }), 'categoria');\n      var topCat = null, topCatN = -1;\n      Object.keys(catCounts).forEach(function(c){ if(catCounts[c] > topCatN){ topCat = c; topCatN = catCounts[c]; } });\n      setKpi('sistema_principal', topCat === null ? '\u2014' : topCat + ' (' + decFmt(100 * topCatN / fallasDistintas) + ' %)');\n      var movCounts = countByField(full, 'movil');\n      var top5 = Object.keys(movCounts).map(function(m){ return [m, movCounts[m]]; })\n        .sort(function(a, b){ return b[1] - a[1]; }).slice(0, 5);\n      var top5sum = top5.reduce(function(a, kv){ return a + kv[1]; }, 0);\n      setKpi('concentracion', decFmt(100 * top5sum / fallasDistintas) + ' % en ' + top5.length + ' m\u00f3viles');\n    } else {\n      setKpi('fallas_alta', '\u2014'); setKpi('sistema_principal', '\u2014'); setKpi('concentracion', '\u2014');\n    }\n\n    recomputeChart('evolucion_bar', function(){\n      if(!DASH.dayLabels.length) return null;\n      var base = filterRowsCf(DASH.rows, 'dia');\n      var perDay = {}; var movDia = {};\n      DASH.dayLabels.forEach(function(d){ perDay[d] = {}; movDia[d] = {}; });\n      base.forEach(function(r){\n        r.dias.forEach(function(d){\n          if(perDay[d] != null){ perDay[d][r.criticidad] = (perDay[d][r.criticidad] || 0) + 1; movDia[d][r.movil] = 1; }\n        });\n      });\n      var values = DASH.dayLabels.map(function(d){ return totalOfCounts(perDay[d]); });\n      var avg = values.length ? values.reduce(function(a, b){ return a + b; }, 0) / values.length : 0;\n      return {\n        categories: DASH.dayLabels, values: values,\n        breakdown: DASH.dayLabels.map(function(d){ return perDay[d]; }),\n        moviles: DASH.dayLabels.map(function(d){ return Object.keys(movDia[d]).length; }),\n        average: Math.round(avg * 10) / 10, color: CORPORATE_BLUE,\n      };\n    }, 'dia', 'Fecha');\n\n    recomputeChart('criticidad_donut', function(){\n      var base = filterRowsCf(DASH.rows, 'criticidad');\n      var counts = countByField(base, 'criticidad');\n      var total = DASH.activeCrit.reduce(function(a, c){ return a + (counts[c] || 0); }, 0) || 1;\n      var items = DASH.activeCrit.filter(function(c){ return counts[c]; }).map(function(c){\n        return {name: c, value: counts[c] || 0, pct: Math.round((counts[c] || 0) / total * 1000) / 10, color: DASH.critColors[c]};\n      });\n      return {items: items};\n    }, 'criticidad', 'Criticidad');\n\n    recomputeChart('sistemas_bar', function(){\n      var base = filterRowsCf(DASH.rows, 'sistema').filter(function(r){ return !isHiddenCategory(r.categoria); });\n      var groups = groupCriticidad(base, 'categoria');\n      var keys = Object.keys(groups);\n      if(!keys.length) return null;\n      var items = keys.map(function(g){\n        return {name: g, value: totalOfCounts(groups[g]), crit: dominantCrit(groups[g]), breakdown: groups[g]};\n      }).sort(function(a, b){ return b.value - a.value; });\n      return {items: items, unit: 'fallas', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};\n    }, 'sistema', 'Sistema');\n\n    recomputeChart('ranking_bar', function(){\n      var base = filterRowsCf(DASH.rows, 'movil');\n      var groups = groupCriticidad(base, 'movil');\n      var meta = {}; base.forEach(function(r){ meta[r.movil] = {placa: r.placa, tipo: r.tipo}; });\n      var keys = Object.keys(groups);\n      if(!keys.length) return null;\n      var items = keys.map(function(m){\n        return {\n          name: m, value: totalOfCounts(groups[m]), crit: dominantCrit(groups[m]), breakdown: groups[m],\n          placa: (meta[m] || {}).placa, tipo: (meta[m] || {}).tipo,\n        };\n      }).sort(function(a, b){ return b.value - a.value; }).slice(0, DASH.topNMoviles);\n      return {items: items, unit: 'fallas', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};\n    }, 'movil', 'M\u00f3vil');\n\n    recomputeChart('ranking_activaciones_bar', function(){\n      var base = filterRowsCf(DASH.rows, 'movil');\n      var act = {}; var groups = groupCriticidad(base, 'movil'); var meta = {};\n      base.forEach(function(r){\n        act[r.movil] = (act[r.movil] || 0) + r.activaciones;\n        meta[r.movil] = {placa: r.placa, tipo: r.tipo};\n      });\n      var keys = Object.keys(act);\n      if(!keys.length) return null;\n      var items = keys.map(function(m){\n        return {\n          name: m, value: act[m], crit: dominantCrit(groups[m]), breakdown: groups[m] || null,\n          placa: (meta[m] || {}).placa, tipo: (meta[m] || {}).tipo,\n        };\n      }).sort(function(a, b){ return b.value - a.value; }).slice(0, DASH.topNMoviles);\n      return {items: items, unit: 'activaciones', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};\n    }, 'movil', 'M\u00f3vil');\n\n    recomputeChart('diagnosticos_bar', function(){\n      var base = filterRowsCf(DASH.rows, 'diagnostico');\n      var moviles = {}; var crit = {};\n      base.forEach(function(r){\n        (moviles[r.codigo] = moviles[r.codigo] || {})[r.movil] = 1;\n        (crit[r.codigo] = crit[r.codigo] || {})[r.criticidad] = (crit[r.codigo][r.criticidad] || 0) + 1;\n      });\n      var keys = Object.keys(moviles);\n      if(!keys.length) return null;\n      var items = keys.map(function(c){\n        return {\n          name: c, value: Object.keys(moviles[c]).length, crit: dominantCrit(crit[c]), breakdown: crit[c],\n          moviles: Object.keys(moviles[c]).length,\n        };\n      }).sort(function(a, b){ return b.value - a.value; }).slice(0, DASH.topNDiag);\n      return {items: items, unit: 'm\u00f3viles', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};\n    }, 'diagnostico', 'Diagn\u00f3stico');\n\n    recomputeChart('diagnosticos_frecuentes_bar', function(){\n      var base = filterRowsCf(DASH.rows, 'diagnostico');\n      var act = {}; var moviles = {}; var crit = {};\n      base.forEach(function(r){\n        act[r.codigo] = (act[r.codigo] || 0) + r.activaciones;\n        (moviles[r.codigo] = moviles[r.codigo] || {})[r.movil] = 1;\n        (crit[r.codigo] = crit[r.codigo] || {})[r.criticidad] = (crit[r.codigo][r.criticidad] || 0) + 1;\n      });\n      var keys = Object.keys(act);\n      if(!keys.length) return null;\n      var items = keys.map(function(c){\n        return {\n          name: c, value: act[c], crit: dominantCrit(crit[c]), breakdown: crit[c] || null,\n          moviles: moviles[c] ? Object.keys(moviles[c]).length : 0,\n        };\n      }).sort(function(a, b){ return b.value - a.value; }).slice(0, DASH.topNDiag);\n      return {items: items, unit: 'activaciones', color: CORPORATE_BLUE, height: Math.max(200, 30 * items.length)};\n    }, 'diagnostico', 'Diagn\u00f3stico');\n\n    // Comparativos \u2014 misma forma \"pareto\" horizontal que Sistemas/Ranking\n    // (refinamiento visual 2026-09): nombres largos (empresas, tipos de\n    // veh\u00edculo) ya no chocan con las cifras \u2014 cada dato tiene su propia\n    // columna fija, en vez de una barra vertical con la etiqueta rotada.\n    function comparativeScaleMax(){\n      var max = 0;\n      [['tipo', 'tipo'], ['marca', 'marca'], ['empresa', 'empresa']].forEach(function(pair){\n        var dim = pair[0], field = CF_FIELD[dim];\n        var base = filterRowsCf(DASH.rows, dim);\n        var counts = countByField(base, field);\n        Object.keys(counts).forEach(function(g){\n          var size = DASH.fleetSizes[dim][g];\n          if(size) max = Math.max(max, Math.round(counts[g] / size * 100) / 100);\n        });\n      });\n      return max || 1;\n    }\n    var sharedComparisonMax = comparativeScaleMax();\n    [['tipo', 'Tipo de veh\u00edculo'], ['marca', 'Marca'], ['empresa', 'Empresa']].forEach(function(pair){\n      var dim = pair[0], label = pair[1];\n      recomputeChart(dim + '_bar', function(){\n        var base = filterRowsCf(DASH.rows, dim);\n        var field = CF_FIELD[dim];\n        var counts = countByField(base, field);\n        var groups = groupCriticidad(base, field);\n        var items = Object.keys(counts)\n          .filter(function(g){ return DASH.fleetSizes[dim][g]; })\n          .map(function(g){\n            return {name: g, value: Math.round(counts[g] / DASH.fleetSizes[dim][g] * 100) / 100, breakdown: groups[g] || null};\n          })\n          .sort(function(a, b){ return b.value - a.value; });\n        if(!items.length) return null;\n        return {items: items, unit: 'fallas/veh\u00edculo', color: CORPORATE_BLUE,\n                scaleMax: sharedComparisonMax, height: Math.max(200, 30 * items.length)};\n      }, dim, label);\n    });\n  }\n  function renderChips(){\n    var holder = byId('cf-chips-global');\n    if(!holder) return;\n    var keys = Object.keys(CF);\n    var banner = holder.closest('.cf-banner');\n    if(banner) banner.classList.toggle('active', keys.length > 0);\n    holder.innerHTML = '';\n    keys.forEach(function(key){\n      (CF[key] || []).forEach(function(val){\n        var chip = document.createElement('span'); chip.className = 'cf-chip';\n        chip.appendChild(document.createTextNode(CF_LABELS[key] + ': ' + val + ' '));\n        var btn = document.createElement('button'); btn.textContent = '\u00d7'; btn.title = 'Quitar este filtro';\n        btn.onclick = function(){ cfRemoveValue(key, val); };\n        chip.appendChild(btn);\n        holder.appendChild(chip);\n      });\n    });\n  }\n  function cellHasToken(cellStr, token){\n    return cellStr.split(',').map(function(s){ return s.trim(); }).indexOf(token) !== -1;\n  }\n\n  // ---- Tooltip inmediato compartido (sin el retardo del title nativo) ----\n  var TIP;\n  function ensureTip(){\n    if(!TIP){ TIP = document.createElement('div'); TIP.id = 'cf-tip'; document.body.appendChild(TIP); }\n    return TIP;\n  }\n  function bindTip(el, htmlFn){\n    el.addEventListener('mouseenter', function(e){\n      var tip = ensureTip(); tip.innerHTML = htmlFn(); tip.style.display = 'block'; positionTip(e);\n    });\n    el.addEventListener('mousemove', positionTip);\n    el.addEventListener('mouseleave', function(){ if(TIP) TIP.style.display = 'none'; });\n  }\n  function positionTip(e){\n    if(!TIP) return;\n    var x = e.clientX + 14, y = e.clientY + 14;\n    var maxX = window.innerWidth - TIP.offsetWidth - 10, maxY = window.innerHeight - TIP.offsetHeight - 10;\n    TIP.style.left = Math.min(x, Math.max(0, maxX)) + 'px';\n    TIP.style.top = Math.min(y, Math.max(0, maxY)) + 'px';\n  }\n\n  // ---- Barras (horizontal/vertical, apiladas o agrupadas) ----\n  function renderBar(container, spec){\n    var max=0;\n    spec.categories.forEach(function(_,i){\n      var total=0, maxSeries=0;\n      spec.series.forEach(function(s){ total+=(s.values[i]||0); maxSeries=Math.max(maxSeries,s.values[i]||0); });\n      max=Math.max(max, spec.stacked?total:maxSeries);\n    });\n    max = max||1;\n    var clickHint = spec.cfKey ? '<br><i style=\"opacity:.7\">Haz clic para filtrar</i>' : '';\n    if(spec.horizontal){\n      spec.categories.forEach(function(cat,i){\n        var row=document.createElement('div'); row.className='bar-row';\n        var label=document.createElement('div'); label.className='bar-label'; label.textContent=cat; label.title=cat;\n        var track=document.createElement('div'); track.className='bar-track';\n        var total=0;\n        var parts=[];\n        spec.series.forEach(function(s){\n          var v=s.values[i]||0; if(!v) return;\n          var seg=document.createElement('div'); seg.className='bar-seg';\n          seg.style.width=(v/max*100)+'%'; seg.style.background=s.color;\n          track.appendChild(seg); total+=v;\n          parts.push(s.name+': <b>'+v.toLocaleString('es-CO')+'</b>');\n        });\n        var val=document.createElement('div'); val.className='bar-value'; val.textContent=total.toLocaleString('es-CO');\n        row.appendChild(label); row.appendChild(track); row.appendChild(val);\n        bindTip(row, function(){ return '<b>'+cat+'</b><br>'+parts.join('<br>')+clickHint; });\n        if(spec.cfKey){\n          row.classList.add('cf-clickable');\n          row.setAttribute('data-cf-key', spec.cfKey);\n          row.setAttribute('data-cf-value', cat);\n          row.addEventListener('click', function(){ cfToggle(spec.cfKey, cat, spec.cfLabel||spec.cfKey); });\n        }\n        container.appendChild(row);\n      });\n    } else {\n      var wrap=document.createElement('div'); wrap.className='vbars';\n      var labels=document.createElement('div'); labels.className='vbars-labels';\n      spec.categories.forEach(function(cat,i){\n        var col=document.createElement('div'); col.className='vbar-col';\n        var total=0; var parts=[];\n        spec.series.forEach(function(s){\n          var v=s.values[i]||0; if(!v) return;\n          var seg=document.createElement('div'); seg.className='vbar-seg';\n          seg.style.height=(v/max*100)+'%'; seg.style.background=s.color;\n          col.appendChild(seg); total+=v;\n          parts.push(s.name+': <b>'+v.toLocaleString('es-CO')+'</b>');\n        });\n        var valLabel=document.createElement('div'); valLabel.className='vbar-value';\n        valLabel.textContent=total.toLocaleString('es-CO');\n        col.appendChild(valLabel);\n        bindTip(col, function(){ return '<b>'+cat+'</b><br>'+parts.join('<br>')+clickHint; });\n        if(spec.cfKey){\n          col.classList.add('cf-clickable');\n          col.setAttribute('data-cf-key', spec.cfKey);\n          col.setAttribute('data-cf-value', cat);\n          col.addEventListener('click', function(){ cfToggle(spec.cfKey, cat, spec.cfLabel||spec.cfKey); });\n        }\n        wrap.appendChild(col);\n        var lab=document.createElement('span'); lab.textContent=cat; lab.title=cat;\n        labels.appendChild(lab);\n      });\n      container.appendChild(wrap); container.appendChild(labels);\n    }\n    if(spec.series.length>1){\n      var legend=document.createElement('div'); legend.className='legend';\n      spec.series.forEach(function(s){\n        var sp=document.createElement('span');\n        var i=document.createElement('i'); i.style.background=s.color;\n        sp.appendChild(i); sp.appendChild(document.createTextNode(s.name));\n        legend.appendChild(sp);\n      });\n      container.appendChild(legend);\n    }\n  }\n\n  function renderEvoStack(container, spec){\n    var max = Math.max.apply(null, spec.values.concat([spec.average || 0, 1]));\n    var dense = spec.categories.length > 18;\n    var wrap = document.createElement('div'); wrap.className = 'vbars evo-wrap' + (dense ? ' dense' : '');\n    var labels = document.createElement('div'); labels.className = 'vbars-labels evo-labels' + (dense ? ' dense' : '');\n    var types = ['VELOCIDAD', 'RALENT\u00cd', 'PTO'];\n    spec.categories.forEach(function(cat, i){\n      var col = document.createElement('div'); col.className = 'vbar-col';\n      var v = spec.values[i] || 0, st = spec.stacks[i] || {};\n      var seg = document.createElement('div'); seg.className = 'vbar-seg evo-seg evo-stack';\n      seg.style.height = (v / max * 100) + '%';\n      types.forEach(function(t){\n        var n = st[t] || 0; if(!n || !v) return;\n        var part = document.createElement('div'); part.className = 'evo-part';\n        part.style.height = (n / v * 100) + '%'; part.style.background = spec.colors[t];\n        seg.appendChild(part);\n      });\n      var valLabel = document.createElement('div'); valLabel.className = 'evo-value';\n      var totalSpan = document.createElement('span'); totalSpan.className = 'evo-total'; totalSpan.textContent = v.toLocaleString('es-CO');\n      valLabel.appendChild(totalSpan); seg.appendChild(valLabel); col.appendChild(seg);\n      var mv = (spec.moviles && spec.moviles[i]) || 0;\n      bindTip(col, function(){\n        return '<b>' + ((spec.labels && spec.labels[i]) || cat) + '</b><br>' + v.toLocaleString('es-CO') + ' eventos \u00b7 ' + mv + ' m\u00f3vil(es)'\n          + types.map(function(t){ return '<br><span style=\"color:' + spec.colors[t] + '\">\u25a0</span> ' + t + ': <b>' + (st[t] || 0).toLocaleString('es-CO') + '</b>'; }).join('')\n          + (spec.cfKey ? '<br><i style=\"opacity:.7\">Haz clic para filtrar</i>' : '');\n      });\n      if(spec.cfKey){\n        col.classList.add('cf-clickable'); col.setAttribute('data-cf-key', spec.cfKey); col.setAttribute('data-cf-value', cat);\n        col.addEventListener('click', function(){ cfToggle(spec.cfKey, cat, spec.cfLabel || spec.cfKey); });\n      }\n      wrap.appendChild(col);\n      var shown = (spec.labels && spec.labels[i]) || cat; var lab = document.createElement('span'); lab.textContent = shown; lab.title = shown; labels.appendChild(lab);\n    });\n    if(spec.average){\n      var avgLine = document.createElement('div'); avgLine.className = 'avg-line';\n      avgLine.style.bottom = Math.min(100, spec.average / max * 100) + '%';\n      var avgTag = document.createElement('span'); avgTag.className = 'avg-tag';\n      avgTag.textContent = 'Promedio: ' + spec.average.toLocaleString('es-CO', {maximumFractionDigits: 1});\n      avgLine.appendChild(avgTag); wrap.appendChild(avgLine);\n    }\n    container.appendChild(wrap); container.appendChild(labels);\n    var legend = document.createElement('div'); legend.className = 'evo-legend';\n    types.forEach(function(t){ var sp = document.createElement('span'); sp.innerHTML = '<i style=\"background:' + spec.colors[t] + '\"></i>' + t; legend.appendChild(sp); });\n    container.appendChild(legend);\n  }\n\n  // ---- Criticidad transversal (refinamiento ejecutivo 2026-09) ----\n  var CRIT_ORDER = ['ALTA', 'MEDIA', 'BAJA'];\n  var CRIT_ABBR = {ALTA: 'A', MEDIA: 'M', BAJA: 'B'};\n  function critMiniParts(breakdown){\n    if(!breakdown) return [];\n    return CRIT_ORDER.filter(function(c){ return breakdown[c]; });\n  }\n  function buildCritMini(breakdown, extraClass){\n    var parts = critMiniParts(breakdown);\n    if(!parts.length) return null;\n    var wrap = document.createElement('div'); wrap.className = 'crit-mini' + (extraClass ? ' ' + extraClass : '');\n    parts.forEach(function(c){\n      var item = document.createElement('span'); item.className = 'cm-item'; item.title = c;\n      var letter = document.createElement('b'); letter.className = 'cm-' + c.toLowerCase(); letter.textContent = CRIT_ABBR[c];\n      item.appendChild(letter);\n      item.appendChild(document.createTextNode(breakdown[c]));\n      wrap.appendChild(item);\n    });\n    return wrap;\n  }\n  function critTipLine(breakdown){\n    var parts = critMiniParts(breakdown).map(function(c){ return c + ': <b>' + breakdown[c] + '</b>'; });\n    return parts.length ? parts.join(' \u00b7 ') : '';\n  }\n\n  // ---- Pareto ejecutivo (barra \u00fanica horizontal, orden mayor->menor) ----\n  function renderPareto(container, spec){\n    var max = 0;\n    spec.items.forEach(function(it){ max = Math.max(max, it.value || 0); });\n    max = spec.scaleMax || max || 1;\n    var clickHint = spec.cfKey ? '<br><i style=\"opacity:.7\">Haz clic para filtrar</i>' : '';\n    var hasCrit = false;\n    spec.items.forEach(function(it){\n      var row = document.createElement('div'); row.className = 'pareto-row';\n      var label = document.createElement('div'); label.className = 'bar-label'; label.title = it.name;\n      label.appendChild(document.createTextNode(it.name));\n      var value = document.createElement('div'); value.className = 'pareto-value';\n      var isTime = spec.unit === 'segundos';\n      var valueMain = document.createElement('strong'); valueMain.textContent = isTime ? hDur(it.value) : (it.value || 0).toLocaleString('es-CO', {maximumFractionDigits: 2});\n      var valueUnit = document.createElement('small'); valueUnit.textContent = isTime ? 'tiempo' : (spec.unit || 'valor');\n      value.appendChild(valueMain); value.appendChild(valueUnit);\n      var visual = document.createElement('div'); visual.className = 'pareto-visual';\n      var track = document.createElement('div'); track.className = 'bar-track';\n      var seg = document.createElement('div'); seg.className = 'bar-seg';\n      seg.style.width = (it.value / max * 100) + '%'; seg.style.background = spec.color || CORPORATE_BLUE;\n      track.appendChild(seg);\n      visual.appendChild(track);\n      var mini = buildCritMini(it.breakdown);\n      if(mini){ visual.appendChild(mini); hasCrit = true; }\n      row.appendChild(label); row.appendChild(value); row.appendChild(visual);\n\n      var tipLines = ['<b>' + it.name + '</b>', (isTime ? 'Tiempo' : (spec.unit || 'valor')) + ': <b>' + (isTime ? hDur(it.value) : (it.value || 0).toLocaleString('es-CO')) + '</b>'];\n      var critLine = critTipLine(it.breakdown);\n      if(critLine) tipLines.push(critLine);\n      if(it.activaciones != null) tipLines.push('Activaciones: <b>' + it.activaciones.toLocaleString('es-CO') + '</b>');\n      if(it.moviles != null && spec.unit !== 'm\u00f3viles') tipLines.push('M\u00f3viles: <b>' + it.moviles.toLocaleString('es-CO') + '</b>');\n      if(it.placa) tipLines.push('Placa: <b>' + it.placa + '</b>');\n      if(it.tipo) tipLines.push('Tipo: <b>' + it.tipo + '</b>');\n      if(it.extra) it.extra.forEach(function(line){ tipLines.push(line); });\n      bindTip(row, function(){ return tipLines.join('<br>') + clickHint; });\n\n      if(spec.cfKey){\n        row.classList.add('cf-clickable');\n        row.setAttribute('data-cf-key', spec.cfKey);\n        row.setAttribute('data-cf-value', it.name);\n        row.addEventListener('click', function(){ cfToggle(spec.cfKey, it.name, spec.cfLabel || spec.cfKey); });\n      }\n      container.appendChild(row);\n    });\n    if(spec.scaleMax){\n      var scale = document.createElement('p'); scale.className = 'chart-scale';\n      scale.textContent = 'Escala compartida: 0\u2013' + spec.scaleMax.toLocaleString('es-CO', {maximumFractionDigits: 2}) + ' ' + (spec.unit || '');\n      container.appendChild(scale);\n    }\n    if(hasCrit){\n      var key = document.createElement('div'); key.className = 'crit-key';\n      key.innerHTML = '<span><b class=\"cm-alta\">A</b> Alta</span><span><b class=\"cm-media\">M</b> Media</span><span><b class=\"cm-baja\">B</b> Baja</span>';\n      container.appendChild(key);\n    }\n  }\n\n  // ---- Evoluci\u00f3n ejecutiva (barra \u00fanica por d\u00eda + l\u00ednea de promedio) ----\n  function renderEvolution(container, spec){\n    var refs = spec.values.concat([spec.average || 0, 1]);\n    var max = Math.max.apply(null, refs);\n    var dense = spec.categories.length > 18;\n    var wrap = document.createElement('div'); wrap.className = 'vbars evo-wrap' + (dense ? ' dense' : '');\n    var labels = document.createElement('div'); labels.className = 'vbars-labels evo-labels' + (dense ? ' dense' : '');\n    var clickHint = spec.cfKey ? '<br><i style=\"opacity:.7\">Haz clic para filtrar</i>' : '';\n    spec.categories.forEach(function(cat, i){\n      var col = document.createElement('div'); col.className = 'vbar-col';\n      var v = spec.values[i] || 0;\n      var bd = (spec.breakdown && spec.breakdown[i]) || {};\n      var seg = document.createElement('div'); seg.className = 'vbar-seg evo-seg';\n      seg.style.height = (v / max * 100) + '%'; seg.style.background = spec.color || CORPORATE_BLUE;\n      var valLabel = document.createElement('div'); valLabel.className = 'evo-value';\n      var totalSpan = document.createElement('span'); totalSpan.className = 'evo-total'; totalSpan.textContent = v.toLocaleString('es-CO');\n      valLabel.appendChild(totalSpan);\n      var mini = buildCritMini(bd, 'evo-mini');\n      if(mini) valLabel.appendChild(mini);\n      seg.appendChild(valLabel);\n      col.appendChild(seg);\n      var mv = (spec.moviles && spec.moviles[i]) || 0;\n      bindTip(col, function(){\n        var critLine = critTipLine(bd);\n        return '<b>' + cat + '</b><br>' + v.toLocaleString('es-CO') + ' fallas distintas \u00b7 ' + mv + ' m\u00f3vil(es) afectados'\n          + (critLine ? '<br>' + critLine : '') + clickHint;\n      });\n      if(spec.cfKey){\n        col.classList.add('cf-clickable');\n        col.setAttribute('data-cf-key', spec.cfKey);\n        col.setAttribute('data-cf-value', cat);\n        col.addEventListener('click', function(){ cfToggle(spec.cfKey, cat, spec.cfLabel || spec.cfKey); });\n      }\n      wrap.appendChild(col);\n      var lab = document.createElement('span'); lab.textContent = cat; lab.title = cat;\n      labels.appendChild(lab);\n    });\n    if(spec.average){\n      var avgLine = document.createElement('div'); avgLine.className = 'avg-line';\n      avgLine.style.bottom = Math.min(100, spec.average / max * 100) + '%';\n      var avgTag = document.createElement('span'); avgTag.className = 'avg-tag';\n      avgTag.textContent = 'Promedio: ' + spec.average.toLocaleString('es-CO', {maximumFractionDigits: 1});\n      avgLine.appendChild(avgTag);\n      wrap.appendChild(avgLine);\n    }\n    container.appendChild(wrap); container.appendChild(labels);\n  }\n\n  // ---- Criticidad transversal \u2014 franja compacta pegada al Resumen ejecutivo ----\n  function renderDistributionBar(container, spec){\n    var items = spec.items.filter(function(it){ return it.value > 0; });\n    var total = items.reduce(function(a, it){ return a + it.value; }, 0) || 1;\n    var wrap = document.createElement('div'); wrap.className = 'crit-strip';\n    var head = document.createElement('span'); head.className = 'crit-strip-head'; head.textContent = spec.title || 'Criticidad de las fallas';\n    wrap.appendChild(head);\n    var clickHint = spec.cfKey ? '<br><i style=\"opacity:.7\">Haz clic para filtrar</i>' : '';\n    items.forEach(function(it){\n      var pill = document.createElement('span'); pill.className = 'crit-pill';\n      var dot = document.createElement('i'); dot.className = 'crit-pill-dot'; dot.style.background = it.color;\n      var name = document.createElement('span'); name.className = 'crit-pill-name'; name.textContent = it.name;\n      var val = document.createElement('b'); val.textContent = it.value.toLocaleString('es-CO');\n      var pct = document.createElement('small'); pct.textContent = it.pct + ' %';\n      pill.appendChild(dot); pill.appendChild(name); pill.appendChild(val); pill.appendChild(pct);\n      bindTip(pill, function(){ return it.name + ': <b>' + it.value.toLocaleString('es-CO') + '</b> (' + it.pct + '%)' + clickHint; });\n      if(spec.cfKey){\n        pill.classList.add('cf-clickable');\n        pill.setAttribute('data-cf-key', spec.cfKey);\n        pill.setAttribute('data-cf-value', it.name);\n        pill.addEventListener('click', function(){ cfToggle(spec.cfKey, it.name, spec.cfLabel || spec.cfKey); });\n      }\n      wrap.appendChild(pill);\n    });\n    var bar = document.createElement('div'); bar.className = 'crit-strip-bar';\n    items.forEach(function(it){\n      var seg = document.createElement('span'); seg.style.width = (it.value / total * 100) + '%'; seg.style.background = it.color;\n      bar.appendChild(seg);\n    });\n    wrap.appendChild(bar);\n    container.appendChild(wrap);\n  }\n\n  // ---- Timeline (episodios como barras horizontales por rango) ----\n  function renderTimeline(container, spec){\n    var span=(spec.max-spec.min)||1;\n    spec.rows.forEach(function(r){\n      var row=document.createElement('div'); row.className='timeline-row';\n      var label=document.createElement('div'); label.className='timeline-label'; label.textContent=r.label; label.title=r.label;\n      var track=document.createElement('div'); track.className='timeline-track';\n      var bar=document.createElement('div'); bar.className='timeline-bar';\n      var left=(r.start-spec.min)/span*100, width=Math.max((r.end-r.start)/span*100, 0.6);\n      bar.style.left=left+'%'; bar.style.width=width+'%'; bar.style.background=r.color;\n      bar.title=r.tooltip||r.label;\n      track.appendChild(bar);\n      row.appendChild(label); row.appendChild(track);\n      container.appendChild(row);\n    });\n  }\n\n  function initCharts(){\n    document.querySelectorAll('.chart[data-src]').forEach(function(el){\n      try {\n        var spec=readData(el.getAttribute('data-src'));\n        if(!spec || spec.deferred) return;\n        var kind = el.dataset.kind;\n        if(kind==='bar') renderBar(el, spec);\n        else if(kind==='pareto') renderPareto(el, spec);\n        else if(kind==='evolution') renderEvolution(el, spec);\n        else if(kind==='distribution') renderDistributionBar(el, spec);\n        else if(kind==='timeline') renderTimeline(el, spec);\n        else throw new Error('Tipo de gr\u00e1fica no soportado: ' + kind);\n      } catch(error) {\n        console.error('[Telemetry report] No se pudo renderizar la gr\u00e1fica ' + (el.id || '(sin id)'), error);\n        el.innerHTML = '';\n        var message = document.createElement('div');\n        message.className = 'chart-render-error';\n        message.textContent = 'No se pudo renderizar esta gr\u00e1fica';\n        el.appendChild(message);\n      }\n    });\n  }\n\n  function escHtml(s){\n    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');\n  }\n\n  // ---- Tablas: b\u00fasqueda + orden + paginaci\u00f3n ----\n  function initTables(){\n    document.querySelectorAll('.table-card[data-src]').forEach(function(card){\n      var payload=readData(card.getAttribute('data-src'));\n      if(!payload) return;\n      var columns=payload.columns, rows=payload.rows.slice(), pageSize=payload.pageSize||20;\n      var state={page:0, sortCol:-1, sortDir:1, filter:''};\n      var scroll=card.querySelector('.table-scroll');\n      var search=card.querySelector('.table-search');\n      var pager=card.querySelector('.table-pager');\n      var sortSelect=card.querySelector('.table-sort-mobile');\n      var sortDirBtn=card.querySelector('.table-sort-dir');\n      var crossfilter=payload.crossfilter||[];\n      var secondaryNames = payload.secondaryColumns || [];\n      var secondaryIdx = secondaryNames.map(function(n){ return columns.indexOf(n); }).filter(function(i){ return i >= 0; });\n      var primaryIdx = columns.map(function(_, i){ return i; }).filter(function(i){ return secondaryIdx.indexOf(i) === -1; });\n\n      if(sortSelect){\n        primaryIdx.forEach(function(i){\n          var opt=document.createElement('option'); opt.value=String(i); opt.textContent=columns[i];\n          sortSelect.appendChild(opt);\n        });\n        sortSelect.addEventListener('change', function(){\n          state.sortCol = parseInt(sortSelect.value, 10); state.sortDir = 1; render();\n        });\n      }\n      if(sortDirBtn){\n        sortDirBtn.addEventListener('click', function(){\n          state.sortDir *= -1; render();\n        });\n      }\n      function syncSortControls(){\n        if(sortSelect && state.sortCol >= 0) sortSelect.value = String(state.sortCol);\n        if(sortDirBtn) sortDirBtn.textContent = state.sortDir === 1 ? '\u2193' : '\u2191';\n      }\n\n      function cellText(c){ return (c&&typeof c==='object') ? String(c.text||'') : String(c); }\n      function cellMatchesAny(cell, mapping, values){\n        var text = cellText(cell);\n        return values.some(function(v){\n          return mapping.match === 'contains' ? cellHasToken(text, v) : mapping.match === 'prefix' ? text.indexOf(v) === 0 : text === v;\n        });\n      }\n      function filtered(){\n        var list=rows;\n        if(state.filter){\n          var q=state.filter.toLowerCase();\n          list=list.filter(function(r){ return r.some(function(c){return cellText(c).toLowerCase().indexOf(q)!==-1;}); });\n        }\n        Object.keys(CF).forEach(function(key){\n          var mapping = crossfilter.filter(function(m){ return m.key === key; })[0];\n          if(!mapping) return;\n          var idx = columns.indexOf(mapping.column);\n          if(idx < 0) return;\n          var values = CF[key];\n          list = list.filter(function(r){ return cellMatchesAny(r[idx], mapping, values); });\n        });\n        return list;\n      }\n      function sorted(list){\n        if(state.sortCol<0) return list;\n        var idx=state.sortCol, dir=state.sortDir;\n        return list.slice().sort(function(a,b){\n          var ca=a[idx], cb=b[idx];\n          if(ca && cb && typeof ca==='object' && typeof cb==='object' && ca.sort!=null && cb.sort!=null) return (ca.sort-cb.sort)*dir;\n          var x=cellText(ca), y=cellText(cb);\n          var nx=parseFloat(x.replace(/\\./g,'').replace(',','.')), ny=parseFloat(y.replace(/\\./g,'').replace(',','.'));\n          var cmp = (!isNaN(nx)&&!isNaN(ny)) ? (nx-ny) : x.localeCompare(y,'es');\n          return cmp*dir;\n        });\n      }\n      function renderCellInto(td, c, colName){\n        if(c && typeof c === 'object' && c.href){\n          var a=document.createElement('a'); a.href=c.href; a.target='_blank'; a.rel='noopener noreferrer';\n          a.textContent=c.text||c.href; a.className='ext-link'; td.appendChild(a);\n          return;\n        }\n        var text = cellText(c);\n        td.textContent = text;\n        if(text) td.title = text;\n        if(colName === 'Diagn\u00f3stico') td.classList.add('dt-cell-wide');\n        else if(colName === 'Categor\u00eda') td.classList.add('dt-cell-narrow');\n      }\n      function render(){\n        var data=sorted(filtered());\n        var totalPages=Math.max(1, Math.ceil(data.length/pageSize));\n        state.page=Math.min(state.page, totalPages-1);\n        var pageRows=data.slice(state.page*pageSize, state.page*pageSize+pageSize);\n        if(!data.length){\n          scroll.innerHTML='<p style=\"color:var(--muted);font-size:12.5px;padding:8px 2px\">Sin resultados para esta selecci\u00f3n.</p>';\n          pager.innerHTML=''; return;\n        }\n        syncSortControls();\n        var table=document.createElement('table'); table.className='dt' + (secondaryIdx.length ? ' dt-compact' : '');\n        var thead=document.createElement('thead'); var htr=document.createElement('tr');\n        primaryIdx.forEach(function(i){\n          var col = columns[i];\n          var th=document.createElement('th'); th.textContent=col;\n          if(i===state.sortCol) th.className = state.sortDir===1?'sort-asc':'sort-desc';\n          th.addEventListener('click', function(){\n            if(state.sortCol===i) state.sortDir*=-1; else {state.sortCol=i; state.sortDir=1;}\n            render();\n          });\n          htr.appendChild(th);\n        });\n        thead.appendChild(htr); table.appendChild(thead);\n        var tbody=document.createElement('tbody');\n        pageRows.forEach(function(r, visibleIndex){\n          var stripe = card.id === 't_maestra' ? (visibleIndex % 2 ? ' dt-row-even' : ' dt-row-odd') : '';\n          var tr=document.createElement('tr');\n          if(secondaryIdx.length) tr.className = 'dt-row-primary';\n          tr.className += stripe;\n          primaryIdx.forEach(function(i){\n            var td=document.createElement('td');\n            td.setAttribute('data-label', columns[i]);\n            renderCellInto(td, r[i], columns[i]);\n            tr.appendChild(td);\n          });\n          tbody.appendChild(tr);\n          if(secondaryIdx.length){\n            var parts = secondaryIdx.map(function(i){\n              var text = cellText(r[i]);\n              return text ? ('<b>' + escHtml(columns[i]) + ':</b> ' + escHtml(text)) : null;\n            }).filter(function(p){ return p; });\n            if(parts.length){\n              var trS = document.createElement('tr'); trS.className = 'dt-row-secondary' + stripe;\n              var tdS = document.createElement('td'); tdS.colSpan = primaryIdx.length;\n              tdS.innerHTML = parts.join(' &nbsp;\u00b7&nbsp; ');\n              trS.appendChild(tdS);\n              tbody.appendChild(trS);\n            }\n          }\n        });\n        table.appendChild(tbody);\n        scroll.innerHTML=''; scroll.appendChild(table);\n        pager.innerHTML='';\n        var info=document.createElement('span');\n        info.textContent = data.length ? ('Mostrando '+(state.page*pageSize+1)+'\u2013'+Math.min(data.length,(state.page+1)*pageSize)+' de '+data.length) : 'Sin resultados';\n        var prev=document.createElement('button'); prev.textContent='Anterior'; prev.disabled=state.page<=0;\n        prev.onclick=function(){state.page--; render();};\n        var next=document.createElement('button'); next.textContent='Siguiente'; next.disabled=state.page>=totalPages-1;\n        next.onclick=function(){state.page++; render();};\n        pager.appendChild(info); pager.appendChild(prev); pager.appendChild(next);\n      }\n      if(search) search.addEventListener('input', function(e){ state.filter=e.target.value; state.page=0; render(); });\n      if(crossfilter.length) CF_TABLES.push(function(){ state.page=0; render(); });\n      render();\n    });\n  }\n\n  function runInitPhase(name, fn){\n    try { fn(); }\n    catch(error) { console.error('[Telemetry report] Fall\u00f3 la inicializaci\u00f3n de ' + name, error); }\n  }\n\n  document.addEventListener('DOMContentLoaded', function(){\n    runInitPhase('dashboard', loadDashboard);\n    runInitPhase('gr\u00e1ficas', initCharts);\n    runInitPhase('rec\u00e1lculo', recomputeDashboard);\n    runInitPhase('tablas', initTables);\n  });\n})();\n";

  // --- Tema visual (verbatim de dashboardAnalisisFallas.js/dashboardAnalisisPTO.js,
  // para que el selector de esta pantalla comparta marca con los otros 2 add-ins) ---
  var T = {
    color: {
      primary: '#73B828',
      primaryDark: '#59901D',
      primarySoft: '#EAF4DF',
      ink: '#1A2235',
      body: '#475569',
      muted: '#88929A',
      surface: '#FFFFFF',
      canvas: '#F4F5F8',
      border: '#E5E9F0',
      borderStrong: '#CBD5E1',
      danger: '#B91C1C',
      dangerSoft: '#FEF2F2',
      dangerBorder: '#FCA5A5',
      textoOscuro: '#1F2937',
      textoGris: '#6B7280',
      // CAMBIO (2026-09-29, pedido explícito de diseño ejecutivo): verde
      // esmeralda para el botón principal (distinto del verde corporativo
      // T.color.primary, que aquí solo queda como acento de marca en el
      // encabezado) y azul para el estado "cargando" de la alerta en línea.
      success: '#10B981',
      successDark: '#0EA371',
      successSoft: '#ECFDF5',
      successText: '#065F46',
      successBorder: '#A7F3D0',
      infoSoft: '#EFF6FF',
      infoText: '#1E3A8A',
      infoBorder: '#BFDBFE'
    },
    radius: { sm: '10px', md: '12px', lg: '18px', pill: '999px' },
    shadow: { card: '0 1px 2px rgba(15,23,42,0.05), 0 8px 24px rgba(15,23,42,0.07)' },
    font: "'Inter', -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
  };

  // Taxonomía de sistemas por palabra clave del NOMBRE del diagnóstico --
  // PORTADA VERBATIM de dashboardAnalisisFallas.js (SISTEMAS +
  // EXCLUSIONES_SISTEMA_CRITICO no se necesitan aquí porque este reporte no
  // clasifica "vehículo crítico", solo clasifica cada FALLA por sistema).
  //
  // LIMITACIÓN CONOCIDA (ver cambios/2026-09-29_creacion-addin-reportes.md):
  // el reporte de referencia (PACARIBE) muestra categorías que esta lista de
  // 10 sistemas NO tiene ("Indicadores del vehículo", "Código propietario",
  // "Comunicación/Red", "Seguridad", "General") -- viene de un script Python
  // separado con su propia taxonomía, más completa, que no es visible en
  // este repo. Se porta la de dashboardAnalisisFallas.js porque es la única
  // fuente de verdad de este tipo YA VALIDADA que existe en el repo (decisión
  // tomada explícitamente con el usuario: reutilizar lógica de negocio ya
  // resuelta aunque implique duplicarla).
  // CAMBIO (2026-10-03, pedido del usuario tras la auditoría): antes, a
  // diferencia de esa otra pantalla, aquí NO se excluía "Otro / Sin
  // clasificar" del desglose por sistema. En datos reales era el 46,5 % de
  // las fallas y salía como "Sistema principal", lo que solo metía ruido.
  // Ahora se excluye del KPI de sistema, del gráfico por sistema
  // (DASH.hiddenCategories, ver reporte_runtime_engine.js) y de la frase de
  // la narrativa. Esas fallas SIGUEN contando en el total de fallas
  // distintas, en el resto de gráficos y en la tabla de detalle (columna
  // Categoría), igual que en dashboardAnalisisFallas.js.
  var SISTEMAS = [
    { nombre: 'Motor', claves: ['motor', 'aceite', 'refrigerante', 'cigüeñal', 'ciguenal', 'árbol de levas', 'arbol de levas', 'inyector', 'cilindro', 'turbocompresor', 'admisión', 'admision'] },
    { nombre: 'Frenos', claves: ['freno', 'retardador'] },
    { nombre: 'ABS', claves: ['abs', 'antibloqueo', 'vdc'] },
    { nombre: 'Dirección', claves: ['dirección', 'direccion', 'volante'] },
    { nombre: 'Embrague', claves: ['embrague', 'clutch'] },
    { nombre: 'Transmisión', claves: ['transmisión', 'transmision', 'caja de cambios', 'convertidor de par'] },
    { nombre: 'Sist. Eléctrico', claves: ['batería', 'bateria', 'alternador', 'voltaje', 'tensión', 'tension', 'luz', 'lámpara', 'lampara'] },
    { nombre: 'Postratamiento', claves: ['dpf', 'scr', 'def', 'hollín', 'hollin', 'urea', 'partículas', 'particulas'] },
    { nombre: 'Neumáticos/Eje', claves: ['neumático', 'neumatico', 'llanta', 'eje', 'diferencial'] },
    { nombre: 'HVAC', claves: ['hvac', 'climatiz', 'ventilador', 'soplador', 'aire acondicionado'] }
  ];
  var EXCLUSIONES_SISTEMA = ['ventilador', 'limpiaparabrisas', 'vidrio', 'espejo', 'asiento', 'direccional'];
  var SISTEMA_SIN_CLASIFICAR = 'Otro / Sin clasificar';

  // Única función que decide a qué sistema pertenece un diagnóstico -- mismo
  // criterio de coincidencia por PALABRA COMPLETA (\b...\b) que
  // resolverSistemaPrincipal en dashboardAnalisisFallas.js, para no repetir
  // el bug real ya documentado ahí (substring "direccion" matcheando
  // "Velocidad direccioNAL", "motor" matcheando "motor del ventilador HVAC").
  function resolverSistema(nombreDiagnostico) {
    var nombreL = (nombreDiagnostico || '').toLowerCase();
    var excluido = EXCLUSIONES_SISTEMA.some(function (palabra) { return nombreL.indexOf(palabra) !== -1; });
    for (var i = 0; i < SISTEMAS.length; i++) {
      var sistema = SISTEMAS[i];
      if (excluido) continue;
      var coincide = sistema.claves.some(function (palabra) {
        return new RegExp('\\b' + palabra + '\\b', 'i').test(nombreL);
      });
      if (coincide) return sistema.nombre;
    }
    return SISTEMA_SIN_CLASIFICAR;
  }

  // --- Criticidad POR FALLA (ALTA/MEDIA/BAJA) -------------------------------
  // Distinta a propósito de la criticidad de dashboardAnalisisFallas.js (esa
  // es POR VEHÍCULO, en 4 niveles Crítico/Alto/Medio/Bajo, calculada por
  // cantidad de episodios -- no aplica aquí, el reporte de referencia usa 3
  // niveles POR FALLA). El pie de página del reporte original es explícito
  // sobre el criterio: "ALTA (luz roja o de protección), MEDIA (luz ámbar) o
  // BAJA (sin luz de alerta)". Eso corresponde a los campos estándar de
  // FaultData en MyGeotab (redStopLamp / protectWarningLamp / amberWarningLamp).
  //
  // SIN VERIFICAR CONTRA DATOS REALES (ver changelog): no se pudo probar esta
  // función contra una cuenta Geotab real durante esta tarea -- confirmar que
  // esos 3 campos booleanos existen y se comportan como se asume antes de
  // confiar en la columna "Criticidad" del reporte generado.
  function criticidadDeRegistro(registro) {
    if (registro.redStopLamp || registro.protectWarningLamp) return 'ALTA';
    if (registro.amberWarningLamp) return 'MEDIA';
    return 'BAJA';
  }

  var RANGO_CRITICIDAD = { ALTA: 3, MEDIA: 2, BAJA: 1 };

  var api = null;
  var state = null;
  var elementos = {};
  var contenedorPrincipal = null;

  // Cachés (se recargan cada vez que se abre el add-in con focus(), no hace
  // falta invalidarlas manualmente -- Group/Device no cambian tan seguido).
  var cacheGrupos = null;
  var cacheDispositivos = null;
  var cacheCatalogos = null;
  var cargaEnCurso = false;

  // --- Utilidades de estilo (CSSOM) -- Geotab elimina <style> del add-in ---
  function aplicarEstilo(el, estilos) {
    for (var propiedad in estilos) {
      if (Object.prototype.hasOwnProperty.call(estilos, propiedad)) {
        el.style[propiedad] = estilos[propiedad];
      }
    }
    return el;
  }

  function crear(tag, estilos, texto) {
    var el = document.createElement(tag);
    if (estilos) aplicarEstilo(el, estilos);
    if (texto !== undefined && texto !== null) el.textContent = texto;
    return el;
  }

  function crearPanel(estilosExtra) {
    var base = {
      background: T.color.surface, borderRadius: T.radius.md,
      border: '1px solid ' + T.color.border, boxShadow: T.shadow.card
    };
    for (var k in estilosExtra) { base[k] = estilosExtra[k]; }
    return crear('div', base);
  }

  // --- Envoltorios sobre la API de Geotab (callback -> Promise) -- verbatim
  // del mismo patrón en dashboardAnalisisFallas.js/dashboardAnalisisPTO.js ---
  function apiCall(metodo, params) {
    return new Promise(function (resolve, reject) { api.call(metodo, params, resolve, reject); });
  }

  function idDeRef(ref) { return (ref && ref.id) ? ref.id : ref; }

  // --- FaultData paginado ---------------------------------------------------
  // Puerto directo de obtenerFaultDataPaginado (dashboardAnalisisFallas.js) /
  // _obtener_faultdata_paginado (telegram_alertas.py).
  function obtenerFaultDataPaginado(desde, hasta) {
    function pedirPagina(desdeActual, acumulado) {
      return apiCall('Get', {
        typeName: 'FaultData',
        search: { fromDate: desdeActual.toISOString(), toDate: hasta.toISOString() }
      }).then(function (pagina) {
        pagina = pagina || [];
        var todas = acumulado.concat(pagina);
        if (pagina.length < LIMITE_PAGINA_FAULTDATA) return todas;
        var ultimoDt = pagina.reduce(function (max, r) {
          var t = new Date(r.dateTime);
          return t > max ? t : max;
        }, desdeActual);
        if (ultimoDt <= desdeActual) return todas; // resguardo anti-loop-infinito
        return pedirPagina(ultimoDt, todas);
      });
    }
    return pedirPagina(desde, []).then(function (todas) {
      var vistos = {};
      var unicas = [];
      todas.forEach(function (r) {
        if (!vistos[r.id]) { vistos[r.id] = true; unicas.push(r); }
      });
      return unicas;
    });
  }

  // --- Catálogos Diagnostic / FailureMode -> nombre + código (SPN/FMI) -----
  // Verbatim de obtenerCatalogosDiagnosticos (dashboardAnalisisFallas.js).
  function obtenerCatalogosDiagnosticos() {
    if (cacheCatalogos) return Promise.resolve(cacheCatalogos);
    return Promise.all([
      apiCall('Get', { typeName: 'Diagnostic' }),
      apiCall('Get', { typeName: 'FailureMode' })
    ]).then(function (resultados) {
      var dicDiag = {};
      (resultados[0] || []).forEach(function (d) {
        if (d && d.id) dicDiag[d.id] = { nombre: d.name || 'Diagnóstico desconocido', codigo: d.code };
      });
      var dicFm = {};
      (resultados[1] || []).forEach(function (fm) {
        if (fm && fm.id) dicFm[fm.id] = { nombre: fm.name || '', codigo: fm.code };
      });
      cacheCatalogos = { dicDiag: dicDiag, dicFm: dicFm };
      return cacheCatalogos;
    });
  }

  // --- Jerarquía de grupos -> "empresa" + tipología + marca -----------------
  // DECISIÓN ABIERTA (ver changelog): esta cuenta de Geotab no tiene un campo
  // ni una rama de grupos dedicada a "empresa" -- CLAUDE.md solo documenta
  // ciudad/tipología/marca. dashboardAnalisisFallas.js resuelve "ciudad" como
  // el primer grupo hijo de la raíz ('*...') que NO es la rama "Tipologia" ni
  // una rama de marca (esGrupoMarca) -- en una cuenta multi-cliente como esta
  // (PACARIBE en el ejemplo real, que no matchea ningún patrón de ciudad
  // colombiana conocido) ese MISMO nivel es, con alta probabilidad, donde
  // viven los nombres de empresa/cliente reales. Se reutiliza exactamente esa
  // resolución, pero SIN la normalización de nombre de ciudad (normalizarCiudad
  // capitalizaba "Bogotá/Cali/Valle" a propósito; para un nombre de empresa
  // como "PACARIBE" eso lo degradaría a "Pacaribe", perdiendo el mayúsculas
  // real del grupo) -- aquí se usa el nombre del grupo tal cual, solo con trim().
  // NO CONFIRMADO con el usuario: si en esta cuenta "empresa" vive en otro
  // nivel de la jerarquía, hay que ajustar aquí (un solo punto de cambio).
  function esGrupoMarca(nombre) {
    var l = (nombre || '').trim().toLowerCase();
    return PALABRAS_GRUPO_MARCA.some(function (marca) { return l.indexOf(marca) !== -1; });
  }

  function obtenerGruposYDispositivos() {
    var pGrupos = cacheGrupos ? Promise.resolve(cacheGrupos) : apiCall('Get', { typeName: 'Group' }).then(function (g) { cacheGrupos = g || []; return cacheGrupos; });
    var pDispositivos = cacheDispositivos ? Promise.resolve(cacheDispositivos) : apiCall('Get', { typeName: 'Device' }).then(function (d) { cacheDispositivos = d || []; return cacheDispositivos; });
    return Promise.all([pGrupos, pDispositivos]);
  }

  // Recorre el árbol de grupos UNA vez y devuelve:
  //  - empresasDisponibles: [{id, nombre}] -- candidatos para el selector.
  //  - mapaGrupos: idGrupo -> {nombre, empresa, tipologia} (empresa/tipologia
  //    heredados de la rama a la que pertenece cada grupo, igual que
  //    obtener_mapa_grupos en telegram_alertas.py / obtenerMapaGrupos en
  //    dashboardAnalisisFallas.js, pero "ciudad" pasa a llamarse "empresa").
  function construirMapaEmpresas(grupos) {
    var porId = {};
    (grupos || []).forEach(function (g) { if (g && g.id) porId[g.id] = g; });
    function idDe(ref) { return (ref && ref.id) ? ref.id : ref; }

    var raiz = (grupos || []).filter(function (g) { return g && typeof g.name === 'string'; })
      .find(function (g) { return g.name.trim().indexOf('*') === 0; });

    var mapa = {};
    var empresasDisponibles = [];
    if (!raiz) return { mapa: mapa, empresasDisponibles: empresasDisponibles };

    function recorrer(grupoId, empresaActual, tipologiaActual) {
      var grupoCompleto = porId[grupoId];
      if (!grupoCompleto) return;
      mapa[grupoId] = { nombre: grupoCompleto.name || '', empresa: empresaActual, tipologia: tipologiaActual };
      (grupoCompleto.children || []).forEach(function (hijo) { recorrer(idDe(hijo), empresaActual, tipologiaActual); });
    }

    (raiz.children || []).forEach(function (hijoRaiz) {
      var hijoId = idDe(hijoRaiz);
      var hijoCompleto = porId[hijoId] || {};
      var nombre = (hijoCompleto.name || '').trim();
      if (nombre.toLowerCase() === NOMBRE_GRUPO_TIPOLOGIA) {
        (hijoCompleto.children || []).forEach(function (sub) {
          var subId = idDe(sub);
          var subCompleto = porId[subId] || {};
          recorrer(subId, null, (subCompleto.name || '').trim());
        });
      } else if (esGrupoMarca(nombre)) {
        recorrer(hijoId, null, null);
      } else if (nombre) {
        empresasDisponibles.push({ id: hijoId, nombre: nombre });
        recorrer(hijoId, nombre, null);
      }
    });

    empresasDisponibles.sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
    return { mapa: mapa, empresasDisponibles: empresasDisponibles };
  }

  // Un Device en Geotab suele estar etiquetado DIRECTAMENTE con varios grupos
  // a la vez (no solo el más profundo) -- por eso, igual que
  // resolverMarcaYTipologia en dashboardAnalisisFallas.js, alcanza con mirar
  // dev.groups (sin subir por la jerarquía de padres) y consultar el mapa
  // precalculado para cada uno.
  function resolverInfoDispositivo(dispositivo, mapaGrupos) {
    var marca = null, empresa = null, tipologia = null;
    (dispositivo.groups || []).forEach(function (g) {
      var gid = idDeRef(g);
      var info = mapaGrupos[gid];
      if (!info) return;
      if (!marca && esGrupoMarca(info.nombre)) marca = info.nombre.trim();
      if (!empresa && info.empresa) empresa = info.empresa;
      if (!tipologia && info.tipologia) tipologia = info.tipologia;
    });
    return {
      nombre: dispositivo.name || dispositivo.id,
      placa: dispositivo.licensePlate || '',
      marca: marca || 'Sin marca',
      tipologia: tipologia || 'Sin tipología asignada',
      empresa: empresa
    };
  }

  // --- Fechas ----------------------------------------------------------------
  var DIAS_ABREV = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  var MESES_ABREV = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function aFechaInputValue(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function etiquetaDia(fecha) {
    return DIAS_ABREV[fecha.getDay()] + ' ' + pad(fecha.getDate()) + '/' + pad(fecha.getMonth() + 1);
  }

  function formatearFechaCorta(d) {
    return d.getDate() + ' ' + MESES_ABREV[d.getMonth()] + ' ' + d.getFullYear();
  }

  function formatearFechaHora(fecha) {
    return fecha.toLocaleString('es-CO', { timeZone: 'America/Bogota' });
  }

  function formatearGenerado(d) {
    try {
      var texto = new Intl.DateTimeFormat('es-CO', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
      }).format(d);
      return texto.replace(',', '');
    } catch (e) {
      return formatearFechaHora(d);
    }
  }

  function construirEtiquetasDias(desde, hasta) {
    var etiquetas = [];
    var cursor = new Date(desde.getFullYear(), desde.getMonth(), desde.getDate());
    var fin = new Date(hasta.getFullYear(), hasta.getMonth(), hasta.getDate());
    while (cursor <= fin) {
      etiquetas.push(etiquetaDia(cursor));
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
    return etiquetas;
  }

  function formatearDecimal(v) {
    return (v || 0).toLocaleString('es-CO', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // CAMBIO (2026-09-29, pedido explícito del usuario tras revisar el primer
  // build): Geotab re-registra el MISMO FaultData con faultState='Active'
  // repetidamente mientras el código sigue activo -- no una sola vez por
  // evento real (mismo fenómeno ya documentado con PTO en telegram_alertas.py
  // y con FaultData en dashboardAnalisisFallas.js: un solo vehículo llegó a
  // 24,641 "episodios" crudos en 30 días). La primera versión de este add-in
  // contaba "activaciones" como el total de registros Active -- eso infla el
  // número. Se porta VERBATIM el criterio de calcularEpisodiosPorGrupo de
  // dashboardAnalisisFallas.js: "activación" = transición real hacia Active
  // desde un estado que no era Active, con un debounce de reactivación (si se
  // reactiva a los pocos minutos de apagarse, es el MISMO episodio en curso,
  // no uno nuevo).
  var DEBOUNCE_REACTIVACION_MIN = 10;

  // --- Agrupación de FaultData en "fallas distintas" -------------------------
  // Misma CLAVE de agrupación (vehículo|diagnóstico|failureMode) que
  // calcularEpisodiosPorGrupo en dashboardAnalisisFallas.js -- "una falla
  // única por vehículo, código y módulo que la reporta", tal como dice el pie
  // de página del reporte de referencia. "días activos" es un concepto
  // APARTE de "activaciones": marca todo día donde hubo al menos un registro
  // Active (así el rango de un episodio largo se ve completo en la evolución
  // diaria), mientras que "activaciones" solo cuenta transiciones reales --
  // mismo criterio que usan los `dias`/`categoria` de dashboard-dataset en el
  // motor de renderizado (ver reporte_runtime_engine.js).
  function agruparPorFalla(registros) {
    var porGrupo = {};
    (registros || []).forEach(function (r) {
      if (!r.device || !r.dateTime || !r.diagnostic) return;
      var clave = idDeRef(r.device) + '|' + idDeRef(r.diagnostic) + '|' + idDeRef(r.failureMode);
      (porGrupo[clave] = porGrupo[clave] || []).push(r);
    });

    var grupos = [];
    Object.keys(porGrupo).forEach(function (clave) {
      var regs = porGrupo[clave].slice().sort(function (a, b) { return new Date(a.dateTime) - new Date(b.dateTime); });
      var activaciones = 0;
      var diasActivos = {};
      var mejorCriticidad = 'BAJA';
      var activoAnterior = false;
      var finUltimaActivacion = null; // fecha en que el grupo se vio Activo por última vez antes de apagarse
      // primeraFechaActiva: se agregó para el Mini Expediente (2026-10-01) --
      // necesitaba la "ventana real del episodio" (primera activación ->
      // última), no solo ultimaFecha. El expediente se movió a Alertas por
      // Severidad el mismo día (ver cambios/2026-10-01_quitar-mini-expediente.md),
      // así que este campo (y el "primeraFecha" que arma el grupo más abajo)
      // quedaron huérfanos -- se dejan a propósito, additive y sin leerse por
      // ningún consumidor (construirFilas usa ultimaFecha/activaciones/
      // criticidad/diasActivos, no primeraFecha), en vez de tocar la lógica
      // de debounce de reactivación de esta función solo para borrar un campo
      // inofensivo.
      var primeraFechaActiva = null;
      regs.forEach(function (r) {
        var fecha = new Date(r.dateTime);
        var activo = r.faultState === 'Active' && r.dismiss !== true;
        if (activo) {
          if (!primeraFechaActiva) primeraFechaActiva = fecha;
          diasActivos[etiquetaDia(fecha)] = true;
          var nivel = criticidadDeRegistro(r);
          if (RANGO_CRITICIDAD[nivel] > RANGO_CRITICIDAD[mejorCriticidad]) mejorCriticidad = nivel;
          if (!activoAnterior) {
            var msDesdeUltimaActivacion = finUltimaActivacion ? (fecha - finUltimaActivacion) : Infinity;
            var esParpadeo = msDesdeUltimaActivacion <= DEBOUNCE_REACTIVACION_MIN * 60 * 1000;
            if (!esParpadeo) activaciones++;
          }
        } else if (activoAnterior) {
          finUltimaActivacion = fecha; // se acaba de apagar -- referencia para el debounce
        }
        activoAnterior = activo;
      });
      // Mismo resguardo que calcularEpisodiosPorGrupo (CAMBIO bug real
      // 2026-09-12 documentado en dashboardAnalisisFallas.js): un grupo puede
      // no tener NINGUNA activación real dentro del rango si la falla ya
      // estaba activa antes de "Desde" y el rango solo alcanza a capturar su
      // resolución -- se excluye aquí, en el origen, para no producir KPIs
      // inconsistentes entre sí.
      if (activaciones === 0) return;

      var partes = clave.split('|');
      var ultimo = regs[regs.length - 1];
      grupos.push({
        idVehiculo: partes[0],
        idDiagnostico: partes[1],
        idFailureMode: partes[2] === 'undefined' ? null : partes[2],
        activaciones: activaciones,
        diasActivos: Object.keys(diasActivos),
        primeraFecha: primeraFechaActiva || new Date(regs[0].dateTime),
        ultimaFecha: new Date(ultimo.dateTime),
        activaAlFinal: ultimo.faultState === 'Active' && ultimo.dismiss !== true,
        criticidad: mejorCriticidad
      });
    });
    return grupos;
  }

  function formatearCodigo(diagInfo, fmInfo) {
    var spn = (diagInfo && diagInfo.codigo !== null && diagInfo.codigo !== undefined) ? diagInfo.codigo : '—';
    var fmi = (fmInfo && fmInfo.codigo !== null && fmInfo.codigo !== undefined) ? fmInfo.codigo : '—';
    return 'SPN ' + spn + ' / FMI ' + fmi;
  }

  // Arma en un solo paso la fila de la tabla maestra (array posicional, según
  // columnas de construirColumnasTabla) y la fila del dataset del dashboard
  // (objeto con los campos EXACTOS que lee reporte_runtime_engine.js --
  // ver CF_FIELD dentro del motor: movil/tipo/marca/empresa/categoria/
  // criticidad/codigo, más "dias" para el cruce con la evolución diaria).
  function construirFilas(grupos, catalogos, infoDispositivos, empresaNombre) {
    var filasTabla = [];
    var filasDataset = [];
    grupos.forEach(function (g) {
      var diagInfo = catalogos.dicDiag[g.idDiagnostico] || { nombre: 'Diagnóstico desconocido', codigo: null };
      var fmInfo = catalogos.dicFm[g.idFailureMode] || { nombre: '', codigo: null };
      var codigo = formatearCodigo(diagInfo, fmInfo);
      var descripcion = diagInfo.nombre + (fmInfo.nombre ? ' — ' + fmInfo.nombre : '');
      var textoDiagnostico = codigo + ' — ' + descripcion;
      var categoria = resolverSistema(diagInfo.nombre);
      var info = infoDispositivos[g.idVehiculo] || { nombre: g.idVehiculo, placa: '', marca: 'Sin marca', tipologia: 'Sin tipología asignada' };
      var estadoTexto = g.activaAlFinal ? 'Activa' : 'Inactiva';
      var diasTexto = g.diasActivos.join(', ');

      filasTabla.push([
        info.nombre, info.placa, info.tipologia, info.marca, categoria, textoDiagnostico,
        codigo, g.criticidad, g.activaciones, estadoTexto, formatearFechaHora(g.ultimaFecha), diasTexto
      ]);

      filasDataset.push({
        movil: info.nombre, placa: info.placa, tipo: info.tipologia, marca: info.marca, empresa: empresaNombre,
        categoria: categoria, criticidad: g.criticidad, codigo: codigo, activaciones: g.activaciones,
        dias: g.diasActivos, activa: g.activaAlFinal
      });
    });
    return { filasTabla: filasTabla, filasDataset: filasDataset };
  }

  function construirColumnasTabla() {
    return ['Móvil', 'Placa', 'Tipo', 'Marca', 'Categoría', 'Diagnóstico', 'Código', 'Criticidad', 'Activaciones', 'Estado', 'Última fecha', 'Días activos'];
  }

  // crossfilter: mapea columna de la tabla -> misma clave (cfKey) que usan
  // los gráficos, para que un clic en cualquier gráfico también filtre esta
  // tabla (ver CF_TABLES / initTables en reporte_runtime_engine.js).
  // match:'contains' en "Días activos" porque esa celda es una lista
  // separada por comas (cellHasToken del motor la parte por ',' y compara
  // cada token -- mismo mecanismo pensado para columnas multi-valor).
  function construirCrossfilterTabla() {
    return [
      { column: 'Móvil', key: 'movil', match: 'exact' },
      { column: 'Tipo', key: 'tipo', match: 'exact' },
      { column: 'Marca', key: 'marca', match: 'exact' },
      { column: 'Categoría', key: 'sistema', match: 'exact' },
      { column: 'Diagnóstico', key: 'diagnostico', match: 'prefix' },
      { column: 'Criticidad', key: 'criticidad', match: 'exact' },
      { column: 'Días activos', key: 'dia', match: 'contains' }
    ];
  }

  function construirFleetSizes(dispositivosEnAlcance, infoDispositivos, empresaNombre) {
    var tipo = {}, marca = {};
    dispositivosEnAlcance.forEach(function (d) {
      var info = infoDispositivos[d.id] || { tipologia: 'Sin tipología asignada', marca: 'Sin marca' };
      tipo[info.tipologia] = (tipo[info.tipologia] || 0) + 1;
      marca[info.marca] = (marca[info.marca] || 0) + 1;
    });
    var empresa = {};
    empresa[empresaNombre] = dispositivosEnAlcance.length;
    return { tipo: tipo, marca: marca, empresa: empresa };
  }

  // --- Narrativa ejecutiva (texto fijo, generado una vez, NO recalculado por
  // el motor -- el motor nunca toca #narrative-list) --------------------------
  function construirNarrativa(filasDataset, baseFlota) {
    var lineas = [];
    var total = filasDataset.length;
    if (!total) return lineas;

    var movilesSet = {};
    filasDataset.forEach(function (r) { movilesSet[r.movil] = true; });
    var nMoviles = Object.keys(movilesSet).length;
    var pctMoviles = baseFlota ? (100 * nMoviles / baseFlota) : 0;
    lineas.push('Se registraron ' + total + ' fallas distintas en ' + nMoviles + ' de ' + baseFlota +
      ' móviles (' + formatearDecimal(pctMoviles) + ' % de la flota analizada); ' +
      formatearDecimal(nMoviles ? total / nMoviles : 0) + ' fallas por móvil afectado.');

    var altaFilas = filasDataset.filter(function (r) { return r.criticidad === 'ALTA'; });
    if (altaFilas.length) {
      var altaMoviles = {};
      altaFilas.forEach(function (r) { altaMoviles[r.movil] = true; });
      lineas.push(altaFilas.length + ' falla(s) de criticidad ALTA (' + formatearDecimal(100 * altaFilas.length / total) +
        ' %) afectaron a ' + Object.keys(altaMoviles).length + ' móvil(es).');
    }

    var porMovil = {};
    filasDataset.forEach(function (r) { porMovil[r.movil] = (porMovil[r.movil] || 0) + 1; });
    var top5 = Object.keys(porMovil).map(function (m) { return [m, porMovil[m]]; })
      .sort(function (a, b) { return b[1] - a[1]; }).slice(0, 5);
    var sumaTop5 = top5.reduce(function (a, kv) { return a + kv[1]; }, 0);
    if (top5.length) {
      lineas.push('Los ' + top5.length + ' móviles con más fallas (' + top5.map(function (kv) { return kv[0]; }).join(', ') +
        ') concentran el ' + formatearDecimal(100 * sumaTop5 / total) + ' % de las fallas distintas.');
    }

    var porSistema = {};
    filasDataset.forEach(function (r) {
      if (r.categoria === SISTEMA_SIN_CLASIFICAR) return; // ver CAMBIO 2026-10-03 junto a SISTEMAS
      porSistema[r.categoria] = (porSistema[r.categoria] || 0) + 1;
    });
    var topSistema = null, topSistemaN = -1;
    Object.keys(porSistema).forEach(function (s) { if (porSistema[s] > topSistemaN) { topSistema = s; topSistemaN = porSistema[s]; } });
    if (topSistema) {
      lineas.push('El sistema con más fallas es «' + topSistema + '»: ' + topSistemaN + ' fallas (' +
        formatearDecimal(100 * topSistemaN / total) + ' %).');
    }

    var mapaCodigoMoviles = {};
    filasDataset.forEach(function (r) { (mapaCodigoMoviles[r.codigo] = mapaCodigoMoviles[r.codigo] || {})[r.movil] = true; });
    var topCodigo = null, topCodigoN = -1;
    Object.keys(mapaCodigoMoviles).forEach(function (c) {
      var n = Object.keys(mapaCodigoMoviles[c]).length;
      if (n > topCodigoN) { topCodigo = c; topCodigoN = n; }
    });
    if (topCodigo) lineas.push('El código más extendido es ' + topCodigo + ', presente en ' + topCodigoN + ' móvil(es).');

    var totalActivaciones = filasDataset.reduce(function (a, r) { return a + (r.activaciones || 0); }, 0);
    lineas.push(totalActivaciones.toLocaleString('es-CO') + ' activaciones reportadas: los códigos conmutan activo/inactivo, por eso el análisis se basa en fallas distintas.');

    var activasAlFinal = filasDataset.filter(function (r) { return r.activa; }).length;
    lineas.push(activasAlFinal + ' de las fallas del periodo siguen activas según su último registro en Geotab.');

    return lineas;
  }

  function construirBannerSinFallas(dispositivosSinFallas) {
    if (!dispositivosSinFallas.length) return '';
    var chips = dispositivosSinFallas.map(function (d) {
      return '<span class="nf-chip">' + escapeHtml(d.nombre) + (d.placa ? (' · ' + escapeHtml(d.placa)) : '') + '</span>';
    });
    var doble = chips.concat(chips).join(''); // duplicado para el loop del marquee CSS (translateX -50%)
    return '<div class="no-fault-banner"><div class="nf-head">✓ ' + dispositivosSinFallas.length +
      ' móvil(es) de la flota analizada sin fallas en el periodo</div><div class="nf-ticker"><div class="nf-track">' +
      doble + '</div></div></div>';
  }

  // Filtros aplicados (compartido por Fallas y Operaciones -- ambos muestran
  // Empresa/Periodo/Flota analizada en el mismo <ul id="filters-list">).
  function construirFiltrosHtmlComun(empresaNombre, desde, hasta, baseFlota) {
    return [
      '<li>Empresa: ' + escapeHtml(empresaNombre) + '</li>',
      '<li>Periodo: ' + escapeHtml(formatearFechaCorta(desde)) + ' → ' + escapeHtml(formatearFechaCorta(hasta)) + '</li>',
      '<li>Flota analizada: ' + baseFlota + ' vehículo(s) del catálogo</li>'
    ].join('');
  }

  // --- Ensamblado del HTML final ---------------------------------------------
  function inyectarJson(html, id, objeto) {
    var marcador = '<script type="application/json" id="' + id + '">{}</script>';
    if (html.indexOf(marcador) === -1) {
      console.warn('Mantenimiento: no se encontró el bloque de datos ' + id + ' en la plantilla.');
      return html;
    }
    var json = JSON.stringify(objeto).replace(/<\/script/gi, '<\\/script');
    var reemplazo = '<script type="application/json" id="' + id + '">' + json + '</script>';
    return html.split(marcador).join(reemplazo);
  }

  function reemplazarBloque(html, marcador, reemplazo) {
    if (html.indexOf(marcador) === -1) {
      console.warn('Mantenimiento: no se encontró el marcador esperado en la plantilla: ' + marcador);
      return html;
    }
    return html.split(marcador).join(reemplazo);
  }

  // El motor (reporte_runtime_engine.js) se incrusta VERBATIM -- no se toca
  // ni una línea, solo se escapa "</script" por si el propio motor llegara a
  // contener ese texto literal dentro de un string (no lo contiene hoy, pero
  // es una salvaguarda barata para no romper el HTML de salida).
  function inyectarScriptMotor(html, motorJs) {
    var inicio = '<script id="report-runtime-script">';
    var idxInicio = html.indexOf(inicio);
    if (idxInicio === -1) {
      console.warn('Mantenimiento: no se encontró el marcador del motor de renderizado en la plantilla.');
      return html;
    }
    var idxFinComentario = html.indexOf('</script>', idxInicio);
    var antes = html.slice(0, idxInicio);
    var despues = html.slice(idxFinComentario + '</script>'.length);
    var motorSeguro = motorJs.replace(/<\/script/gi, '<\\/script');
    return antes + inicio + '\n' + motorSeguro + '\n</script>' + despues;
  }

  // Ensamblado genérico, COMPARTIDO por los 2 tipos de reporte (Fallas y
  // Operaciones): ambos usan el mismo motor y los mismos marcadores base
  // ({{EMPRESA}}/{{PERIODO_*}}/{{GENERADO}}, data-dashboard-dataset,
  // data-t_maestra, filters-list). `bloquesOpcionales` cubre lo que SOLO
  // tiene la plantilla de Fallas (banner "sin fallas" + narrativa estática
  // en <ul>) -- Operaciones no los tiene porque el motor arma su narrativa
  // en vivo dentro de #hab-narrative (ver recomputeHabitsDashboard en
  // reporte_runtime_engine.js), así que ese caso pasa un array vacío.
  //
  // Bloques por-gráfico (data-criticidad_donut, data-evolucion_bar, etc. en
  // Fallas) se DEJAN como {} en la plantilla -- ver nota en el changelog:
  // recomputeDashboard() se ejecuta de forma síncrona justo después de
  // initCharts() en el mismo listener de DOMContentLoaded del motor, así que
  // el primer pintado con estos bloques vacíos nunca llega a mostrarse (no
  // hay "yield" de frame entre ambas fases). Los gráficos de Operaciones
  // (hab_*) ni siquiera llevan bloque data-src -- recomputeChart() no los lee
  // (arma el spec con un builder JS, no con readData), así que no hace falta
  // ese vestigio en la plantilla nueva.
  function ensamblarReporteHtmlBase(plantillaHtml, motorJs, datos, bloquesOpcionales) {
    var html = plantillaHtml;
    html = reemplazarBloque(html, '{{EMPRESA}}', escapeHtml(datos.empresaNombre));
    html = reemplazarBloque(html, '{{PERIODO_VALUE}}', escapeHtml(datos.periodoValue));
    html = reemplazarBloque(html, '{{PERIODO_DETAIL}}', escapeHtml(datos.periodoDetail));
    html = reemplazarBloque(html, '{{GENERADO}}', escapeHtml(datos.generadoTexto));
    html = inyectarJson(html, 'data-dashboard-dataset', datos.dashboardDataset);
    html = inyectarJson(html, 'data-t_maestra', datos.tMaestra);
    html = reemplazarBloque(html, '<ul id="filters-list"></ul>', '<ul id="filters-list">' + datos.filtrosHtml + '</ul>');
    (bloquesOpcionales || []).forEach(function (b) { html = reemplazarBloque(html, b.marcador, b.reemplazo); });
    html = inyectarScriptMotor(html, motorJs);
    return html;
  }

  function ensamblarReporteHtml(plantillaHtml, motorJs, datos) {
    return ensamblarReporteHtmlBase(plantillaHtml, motorJs, datos, [
      { marcador: '<div id="nofault-slot"></div>', reemplazo: datos.bannerSinFallasHtml || '' },
      { marcador: '<ul id="narrative-list"></ul>', reemplazo: '<ul id="narrative-list">' + datos.narrativaHtml + '</ul>' }
    ]);
  }

  function descargarHtml(nombreArchivo, contenidoHtml) {
    var blob = new Blob([contenidoHtml], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = nombreArchivo;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function slug(texto) {
    return (texto || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos (marcas diacríticas combinadas)
      .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'EMPRESA';
  }

  // --- Flujo principal: generar y descargar -----------------------------------
  function generarReporte(empresaId, empresaNombre, desde, hasta, presetTexto) {
    if (cargaEnCurso) return;
    cargaEnCurso = true;
    actualizarBoton(true);
    actualizarEstado('Cargando grupos y vehículos…', 'loading');

    obtenerGruposYDispositivos()
      .then(function (resultado) {
        var grupos = resultado[0], dispositivos = resultado[1];
        var arbol = construirMapaEmpresas(grupos);
        var infoDispositivos = {};
        var dispositivosEnAlcance = [];
        dispositivos.forEach(function (d) {
          var info = resolverInfoDispositivo(d, arbol.mapa);
          if (info.empresa !== empresaNombre) return;
          infoDispositivos[d.id] = info;
          dispositivosEnAlcance.push(d);
        });

        if (!dispositivosEnAlcance.length) {
          throw new Error('No se encontraron vehículos en el grupo "' + empresaNombre + '". Revisa la jerarquía de grupos en Geotab.');
        }

        actualizarEstado('Consultando fallas en Geotab (puede tardar si el rango es amplio)…', 'loading');
        var idsEnAlcance = {};
        dispositivosEnAlcance.forEach(function (d) { idsEnAlcance[d.id] = true; });

        return Promise.all([obtenerFaultDataPaginado(desde, hasta), obtenerCatalogosDiagnosticos()])
          .then(function (r2) {
            var registrosCrudos = r2[0], catalogos = r2[1];
            var registros = registrosCrudos.filter(function (r) { return r.device && idsEnAlcance[idDeRef(r.device)]; });

            actualizarEstado('Procesando ' + registros.length.toLocaleString('es-CO') + ' registros de fallas…', 'loading');
            var grupos2 = agruparPorFalla(registros);
            var resultadoFilas = construirFilas(grupos2, catalogos, infoDispositivos, empresaNombre);

            // Se compara por id de dispositivo (idVehiculo), no por nombre --
            // "movil" en filasDataset es el NOMBRE mostrado, no sirve como clave.
            var idsConFalla = {};
            grupos2.forEach(function (g) { idsConFalla[g.idVehiculo] = true; });
            var dispositivosSinFallas = dispositivosEnAlcance
              .filter(function (d) { return !idsConFalla[d.id]; })
              .map(function (d) { return { nombre: (infoDispositivos[d.id] || {}).nombre || d.name, placa: (infoDispositivos[d.id] || {}).placa || '' }; });

            var dayLabels = construirEtiquetasDias(desde, hasta);
            var baseFlota = dispositivosEnAlcance.length;
            var fleetSizes = construirFleetSizes(dispositivosEnAlcance, infoDispositivos, empresaNombre);

            var dashboardDataset = {
              kind: 'fault_dashboard',
              rows: resultadoFilas.filasDataset,
              fleetSizes: fleetSizes,
              activeCrit: ['ALTA', 'MEDIA', 'BAJA'],
              dayLabels: dayLabels,
              critColors: { ALTA: '#dc2626', MEDIA: '#b45309', BAJA: '#94a3b8' },
              baseFlota: baseFlota,
              topNMoviles: 10,
              topNDiag: 12,
              hiddenCategories: [SISTEMA_SIN_CLASIFICAR],
              emptyText: 'No se encontraron fallas para el alcance y periodo seleccionados.'
            };

            var tMaestra = {
              columns: construirColumnasTabla(),
              rows: resultadoFilas.filasTabla,
              pageSize: 20,
              crossfilter: construirCrossfilterTabla(),
              secondaryColumns: ['Última fecha', 'Días activos']
            };

            var diasEnRango = Math.max(1, Math.round((hasta - desde) / (24 * 60 * 60 * 1000)) + 1);
            var filtrosHtml = construirFiltrosHtmlComun(empresaNombre, desde, hasta, baseFlota);
            var narrativaHtml = construirNarrativa(resultadoFilas.filasDataset, baseFlota)
              .map(function (l) { return '<li>' + escapeHtml(l) + '</li>'; }).join('');

            var datos = {
              empresaNombre: empresaNombre,
              periodoValue: formatearFechaCorta(desde) + ' → ' + formatearFechaCorta(hasta),
              periodoDetail: (presetTexto || 'Rango personalizado') + ' · ' + diasEnRango + (diasEnRango === 1 ? ' día' : ' días'),
              generadoTexto: formatearGenerado(new Date()),
              dashboardDataset: dashboardDataset,
              tMaestra: tMaestra,
              bannerSinFallasHtml: construirBannerSinFallas(dispositivosSinFallas),
              filtrosHtml: filtrosHtml,
              narrativaHtml: narrativaHtml
            };

            actualizarEstado('Generando el archivo del reporte…', 'loading');
            var htmlFinal = ensamblarReporteHtml(PLANTILLA_HTML_EMBEBIDA, MOTOR_JS_EMBEBIDO, datos);
            var nombreArchivo = 'reporte_fallas_' + slug(empresaNombre) + '_' + aFechaInputValue(new Date()).slice(0, 10) + '.html';
            descargarHtml(nombreArchivo, htmlFinal);
            actualizarEstado('Descarga iniciada — ' + resultadoFilas.filasDataset.length + ' falla(s) distinta(s) en ' + baseFlota + ' vehículo(s) del catálogo.', 'success');
          });
      })
      .catch(function (err) {
        console.error('Mantenimiento:', err);
        actualizarEstado((err && err.message) ? err.message : 'Ocurrió un error al generar el reporte.', 'error');
      })
      .then(function () {
        cargaEnCurso = false;
        actualizarBoton(false);
      });
  }

  // --- Retroalimentación visual: alerta en línea (carga / éxito / error) -----
  // CAMBIO (2026-09-29, pedido explícito de diseño): antes era un texto plano
  // que solo cambiaba de color. Ahora es una alerta con fondo suave + icono,
  // con 3 estados visuales (T.color.info* para "cargando", success* para
  // "listo", danger* -- ya existía -- para error). `tipo` nulo/vacío oculta
  // la alerta por completo (mismo uso que antes con texto '').
  var ICONOS_ALERTA = {
    loading: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex:none;margin-top:1px;animation:rptxGirar 0.85s linear infinite"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="34 300"/></svg>',
    success: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex:none;margin-top:1px"><circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.14"/><path d="M7.5 12.5l3 3 6-6.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex:none;margin-top:1px"><circle cx="12" cy="12" r="10" fill="currentColor" fill-opacity="0.14"/><path d="M12 7.5v6M12 16.7v.1" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>'
  };
  var ESTILOS_ALERTA = {
    loading: { background: T.color.infoSoft, color: T.color.infoText, border: T.color.infoBorder },
    success: { background: T.color.successSoft, color: T.color.successText, border: T.color.successBorder },
    error: { background: T.color.dangerSoft, color: T.color.danger, border: T.color.dangerBorder }
  };

  function actualizarEstado(texto, tipo) {
    if (!elementos.estado) return;
    var el = elementos.estado;
    if (!texto || !tipo) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    var estilo = ESTILOS_ALERTA[tipo] || ESTILOS_ALERTA.error;
    aplicarEstilo(el, {
      display: 'flex', alignItems: 'flex-start', gap: '9px', padding: '10px 13px',
      borderRadius: T.radius.sm, background: estilo.background, color: estilo.color,
      border: '1px solid ' + estilo.border, fontSize: '0.83rem', lineHeight: '1.4'
    });
    el.innerHTML = (ICONOS_ALERTA[tipo] || '') + '<span>' + escapeHtml(texto) + '</span>';
  }

  function actualizarBoton(deshabilitado) {
    if (!elementos.botonGenerar) return;
    elementos.botonGenerar.disabled = deshabilitado;
  }

  // --- Hoja de estilos inyectada (CSSOM) --------------------------------------
  // Geotab elimina las etiquetas <style> que vienen en el HTML del add-in, pero
  // UNA creada y adjuntada por JS en tiempo de ejecución sí sobrevive -- es la
  // única forma de lograr :focus/:hover/:active/@media reales (un inline style
  // por sí solo no puede expresar pseudo-clases ni media queries). Sin
  // precedente en este repo (dashboardAnalisisFallas.js resuelve todo con
  // estilos inline estáticos, sin estados interactivos) -- se documenta aquí
  // por si sirve de referencia para otro add-in más adelante. Con guarda para
  // no duplicar el <style> si el add-in se reinicializa.
  function inyectarEstilosGlobales() {
    if (document.getElementById('rptx-estilos')) return;
    var css = '' +
      '.rptx-control{transition:border-color .15s ease,box-shadow .15s ease}' +
      '.rptx-control:focus{outline:none;border-color:' + T.color.ink + ';box-shadow:0 0 0 3px rgba(26,34,53,.14)}' +
      // CAMBIO (2026-09-29, corrección pedida: el botón activo se veía
      // "tosco", desbordando el carril gris al ganar fondo blanco + sombra):
      // transition:all (no solo background/color) para que la sombra tampoco
      // aparezca de golpe, y una sombra bien delicada (antes 0.1 de opacidad,
      // ahora 0.05) que no compite visualmente con el carril que la contiene.
      '.rptx-pill{transition:all .2s ease}' +
      '.rptx-pill:hover{color:' + T.color.ink + '}' +
      '.rptx-pill.is-active{background:#FFFFFF;color:' + T.color.ink + ';box-shadow:0 2px 4px rgba(0,0,0,.05)}' +
      '.rptx-btn-primary{transition:background .15s ease,box-shadow .15s ease,transform .08s ease}' +
      '.rptx-btn-primary:hover:not(:disabled){background:' + T.color.successDark + ';box-shadow:0 4px 14px rgba(16,185,129,.32)}' +
      '.rptx-btn-primary:active:not(:disabled){transform:translateY(1px)}' +
      '.rptx-btn-primary:disabled{opacity:.55;cursor:not-allowed}' +
      '@keyframes rptxGirar{to{transform:rotate(360deg)}}' +
      '@media (max-width:620px){.rptx-form-grid{grid-template-columns:1fr !important}}';
    var style = document.createElement('style');
    style.id = 'rptx-estilos';
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  }

  // --- Construcción de la UI ---------------------------------------------------
  function construirEncabezado(contenedor) {
    var panel = crearPanel({
      padding: '20px 24px', marginBottom: '16px',
      background: 'linear-gradient(135deg, ' + T.color.ink + ' 0%, #1B2C5C 100%)'
    });
    var filaTitulo = crear('div', { display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px' });
    var chip = crear('div', {
      width: '34px', height: '34px', minWidth: '34px', borderRadius: T.radius.sm,
      background: 'rgba(255,255,255,0.12)', color: '#FFFFFF', display: 'flex', alignItems: 'center',
      justifyContent: 'center', fontSize: '1rem', fontWeight: '700'
    }, '📄');
    filaTitulo.appendChild(chip);
    var bloqueTitulo = crear('div');
    bloqueTitulo.appendChild(crear('h2', { margin: '0', color: '#FFFFFF', fontSize: '1.15rem', fontWeight: '800' }, 'Mantenimiento'));
    bloqueTitulo.appendChild(crear('div', { color: '#C7D2E0', fontSize: '0.78rem', marginTop: '2px' }, 'Reporte ejecutivo de Fallas, por empresa y rango de fechas, en un HTML descargable'));
    filaTitulo.appendChild(bloqueTitulo);
    panel.appendChild(filaTitulo);
    contenedor.appendChild(panel);
    return panel;
  }

  function construirFormulario(contenedor) {
    var panel = crearPanel({ padding: '22px 24px', marginBottom: '16px' });

    function envoltorioCampo(etiqueta) {
      var env = crear('div', { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: '0' });
      env.appendChild(crear('label', {
        fontSize: '0.72rem', color: '#64748b', fontWeight: '600',
        textTransform: 'uppercase', letterSpacing: '.04em'
      }, etiqueta));
      return env;
    }

    var estiloControl = {
      height: '40px', padding: '0 12px', border: '1px solid ' + T.color.borderStrong, borderRadius: T.radius.sm,
      fontSize: '0.87rem', fontFamily: T.font, color: T.color.textoOscuro, background: '#FFFFFF',
      appearance: 'none', WebkitAppearance: 'none', width: '100%', boxSizing: 'border-box'
    };

    var envEmpresa = envoltorioCampo('Empresa');
    var selectEmpresa = crear('select', estiloControl);
    selectEmpresa.className = 'rptx-control';
    envEmpresa.appendChild(selectEmpresa);

    var ahora = new Date();
    var hace7 = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);

    var envDesde = envoltorioCampo('Desde');
    var inputDesde = crear('input', estiloControl);
    inputDesde.className = 'rptx-control';
    inputDesde.type = 'datetime-local';
    inputDesde.value = aFechaInputValue(hace7);
    envDesde.appendChild(inputDesde);

    var envHasta = envoltorioCampo('Hasta');
    var inputHasta = crear('input', estiloControl);
    inputHasta.className = 'rptx-control';
    inputHasta.type = 'datetime-local';
    inputHasta.value = aFechaInputValue(ahora);
    envHasta.appendChild(inputHasta);

    var presetTexto = { valor: 'Última semana' };

    var envPills = envoltorioCampo('Atajos');
    var grupoPills = crear('div', {
      display: 'inline-flex', background: '#F1F5F9', borderRadius: T.radius.sm,
      padding: '4px', gap: '2px', alignItems: 'stretch', height: '40px', boxSizing: 'border-box', width: '100%'
    });
    grupoPills.className = 'rptx-pill-group';
    envPills.appendChild(grupoPills);

    function crearPill(texto, activaInicial) {
      var btn = crear('button', {
        border: 'none', background: 'transparent', padding: '0 12px', borderRadius: '7px',
        fontSize: '0.78rem', fontWeight: '600', color: T.color.textoGris, cursor: 'pointer', fontFamily: T.font,
        flex: '1 1 0', minWidth: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
      }, texto);
      btn.type = 'button';
      btn.className = 'rptx-pill' + (activaInicial ? ' is-active' : '');
      return btn;
    }

    function marcarPillActiva(pillElegida) {
      Array.prototype.forEach.call(grupoPills.children, function (p) {
        p.classList.toggle('is-active', p === pillElegida);
      });
    }

    // CAMBIO (2026-10-01): este add-in vuelve a tener un solo modo (Fallas) --
    // el Mini Expediente se movió por completo a Alertas por Severidad
    // (_build_alertas_fallas/), que ya resolvía conductor/turno por fila y no
    // necesitaba picker (la fila de la tabla YA ES la selección). Misma
    // simplificación que ya se hizo aquí cuando se separó Operaciones a su
    // propio add-in -- ver cambios/2026-10-01_quitar-mini-expediente.md. Se
    // quitó la pill "Tipo de reporte" (Fallas/Mini Expediente), su branch en
    // el handler de envío, y el sub-formulario de picker/entrada manual.

    var botonSemana = crearPill('Última semana', true);
    botonSemana.addEventListener('click', function () {
      var h = new Date();
      var d = new Date(h.getTime() - 7 * 24 * 60 * 60 * 1000);
      inputDesde.value = aFechaInputValue(d); inputHasta.value = aFechaInputValue(h);
      presetTexto.valor = 'Última semana';
      marcarPillActiva(botonSemana);
    });

    var botonMes = crearPill('Último mes', false);
    botonMes.addEventListener('click', function () {
      var h = new Date();
      var d = new Date(h.getTime() - 30 * 24 * 60 * 60 * 1000);
      inputDesde.value = aFechaInputValue(d); inputHasta.value = aFechaInputValue(h);
      presetTexto.valor = 'Últimos 30 días';
      marcarPillActiva(botonMes);
    });

    grupoPills.appendChild(botonSemana);
    grupoPills.appendChild(botonMes);

    inputDesde.addEventListener('change', function () { presetTexto.valor = 'Rango personalizado'; marcarPillActiva(null); });
    inputHasta.addEventListener('change', function () { presetTexto.valor = 'Rango personalizado'; marcarPillActiva(null); });

    var iconoDescarga = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" style="flex:none"><path d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    var botonGenerar = crear('button', {
      display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '11px 22px',
      background: T.color.success, color: '#FFFFFF', border: 'none', borderRadius: T.radius.sm,
      fontWeight: '700', fontSize: '0.88rem', cursor: 'pointer', fontFamily: T.font,
      boxShadow: '0 1px 2px rgba(16,185,129,.28)', alignSelf: 'flex-end', whiteSpace: 'nowrap'
    });
    botonGenerar.className = 'rptx-btn-primary';
    botonGenerar.innerHTML = iconoDescarga + '<span>Generar y descargar reporte</span>';
    botonGenerar.addEventListener('click', function () {
      var empresaId = selectEmpresa.value;
      var empresaNombre = selectEmpresa.options[selectEmpresa.selectedIndex] ? selectEmpresa.options[selectEmpresa.selectedIndex].textContent : '';
      if (!empresaId) { actualizarEstado('Elige una empresa antes de generar el reporte.', 'error'); return; }

      var desde = new Date(inputDesde.value), hasta = new Date(inputHasta.value);
      if (!inputDesde.value || !inputHasta.value || isNaN(desde) || isNaN(hasta)) { actualizarEstado('Revisa el rango de fechas.', 'error'); return; }
      if (desde >= hasta) { actualizarEstado('"Desde" debe ser anterior a "Hasta".', 'error'); return; }
      generarReporte(empresaId, empresaNombre, desde, hasta, presetTexto.valor);
    });

    var filaCampos = crear('div', {
      // CAMBIO (2026-10-03, pedido del usuario): Empresa va en su propia fila a
      // todo el ancho -- compartiendo fila con las fechas le tocaban ~170px y
      // nombres como "ESTACIÓN DE TRANSFERENCIA ZIPA" o "PROMO AMBIENTAL
      // DISTRITO BOGOTA" salían cortados; las fechas y los atajos también
      // quedaban apretados. Ahora: fila 1 Empresa, fila 2 Desde | Hasta | Atajos.
      display: 'grid', gridTemplateColumns: 'minmax(170px,1fr) minmax(170px,1fr) minmax(200px,1.1fr)',
      gap: '14px', alignItems: 'end'
    });
    filaCampos.className = 'rptx-form-grid';
    envEmpresa.style.gridColumn = '1 / -1';
    filaCampos.appendChild(envEmpresa);
    filaCampos.appendChild(envDesde);
    filaCampos.appendChild(envHasta);
    filaCampos.appendChild(envPills);
    panel.appendChild(filaCampos);

    var filaAccion = crear('div', { display: 'flex', justifyContent: 'flex-end', marginTop: '18px' });
    filaAccion.appendChild(botonGenerar);
    panel.appendChild(filaAccion);

    var estado = crear('div', { marginTop: '14px', display: 'none' });
    panel.appendChild(estado);

    contenedor.appendChild(panel);
    return { selectEmpresa: selectEmpresa, botonGenerar: botonGenerar, estado: estado };
  }


  function cargarEmpresasEnSelector(selectEmpresa) {
    return obtenerGruposYDispositivos().then(function (resultado) {
      var arbol = construirMapaEmpresas(resultado[0]);
      var seleccionPrevia = selectEmpresa.value;
      selectEmpresa.innerHTML = '';
      if (!arbol.empresasDisponibles.length) {
        var opcionVacia = crear('option', null, 'Sin grupos de empresa disponibles');
        opcionVacia.value = '';
        selectEmpresa.appendChild(opcionVacia);
        actualizarEstado('No se encontró ningún grupo candidato a "empresa" bajo la raíz de grupos de esta cuenta.', 'error');
        return;
      }
      arbol.empresasDisponibles.forEach(function (e) {
        var opcion = crear('option', null, e.nombre);
        opcion.value = e.id;
        selectEmpresa.appendChild(opcion);
      });
      var sigueValida = Array.prototype.some.call(selectEmpresa.options, function (o) { return o.value === seleccionPrevia; });
      if (sigueValida) selectEmpresa.value = seleccionPrevia;
    }).catch(function (err) {
      console.error('Mantenimiento: no se pudieron cargar los grupos/empresas:', err);
      actualizarEstado('No se pudieron cargar las empresas disponibles: ' + ((err && err.message) || err), 'error');
    });
  }

  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi;
      state = freshState;

      inyectarEstilosGlobales();

      contenedorPrincipal = document.getElementById('mantenimientoRoot');
      aplicarEstilo(contenedorPrincipal, {
        fontFamily: T.font, background: T.color.canvas, padding: '16px',
        maxWidth: '760px', margin: '0 auto', boxSizing: 'border-box'
      });

      construirEncabezado(contenedorPrincipal);
      var refs = construirFormulario(contenedorPrincipal);
      elementos.selectEmpresa = refs.selectEmpresa;
      elementos.botonGenerar = refs.botonGenerar;
      elementos.estado = refs.estado;

      initializedCallback();
    },

    focus: function (freshApi, freshState) {
      api = freshApi;
      state = freshState;
      actualizarEstado('Cargando empresas disponibles…', 'loading');
      cargarEmpresasEnSelector(elementos.selectEmpresa).then(function () {
        if (elementos.selectEmpresa.value) actualizarEstado('', null);
      });
    },

    blur: function () { /* sin auto-refresco: este add-in no deja nada corriendo en segundo plano */ }
  };
};
