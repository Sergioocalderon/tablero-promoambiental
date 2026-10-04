# Agregar reporte "Operaciones" (hábitos: velocidad, ralentí, PTO)

**Fecha:** 2026-09-29/30
**Archivos:** `_build_reportes/reportes.js`, `_build_reportes/reporte_operaciones_plantilla.html`
(nuevo), `_build_reportes/config.json`, `Reportes_addin.zip` (raíz del repo)

## Contexto

El Add-in "Reportes" (creado hoy mismo, ver
`cambios/2026-09-29_creacion-addin-reportes.md`) solo generaba el reporte de
Fallas. El usuario pidió agregarle un SEGUNDO tipo de reporte, "Operaciones"
(hábitos: velocidad, ralentí, uso de PTO), como HERMANO del de Fallas dentro
del MISMO add-in -- no un add-in nuevo. El motor de renderizado compartido
(`reporte_runtime_engine.js`) ya tenía soporte completo para
`DASH.kind === 'habits_dashboard'` desde el día 1 (diseñado para 2 tipos de
reporte desde el principio), simplemente no se había usado todavía.

## Qué se construyó

- `reporte_operaciones_plantilla.html`: plantilla nueva, mismo `<head>`/paleta/
  layout (`nav.toc` lateral) que `reporte_plantilla.html`, con las secciones y
  los IDs exactos que `recomputeHabitsDashboard()` busca en el motor (KPIs
  `kpi-hab_*`/`kpi-vel_*`/`kpi-idle_*`/`kpi-pto_*`, narrativa en un único
  `<p id="hab-narrative">` en vez del `<ul>` de Fallas, secciones
  `id="velocidad"`/`id="ralenti"`/`id="pto"` para el atenuado
  `section-empty`). `<body class="report-habits">`.
  - Los gráficos `hab_*` NO llevan `data-src` ni bloque
    `<script id="data-hab_*">` -- a diferencia de Fallas, `recomputeChart()`
    arma el spec con un builder JS (no lee `readData()`), así que ese bloque
    intermedio es innecesario aquí (en Fallas ya era vestigial, ver el
    changelog de creación del add-in).
  - Sección nueva "Turnos y reglas" con una nota explícita (`.sec-sub`) de que
    el turno no se calcula todavía -- ver más abajo.
- `reportes.js`:
  - `PLANTILLA_OPERACIONES_EMBEBIDA`: mismo mecanismo que
    `PLANTILLA_HTML_EMBEBIDA` (incrustada con `json.dumps(..., ensure_ascii=True)`,
    NO se lee con `fetch()`). Reutiliza el MISMO `MOTOR_JS_EMBEBIDO` -- no
    hace falta una segunda copia del motor.
  - Selector de "Tipo de reporte" (pills Fallas/Operaciones) en el formulario,
    mismo lenguaje visual que "Atajos" (`crearPill`, `T.color`, etc.). El
    botón "Generar y descargar reporte" ahora rama a `generarReporte` o
    `generarReporteOperaciones` según la selección.
  - `ensamblarReporteHtml` se partió en una base genérica
    (`ensamblarReporteHtmlBase`) + 2 envoltorios delgados
    (`ensamblarReporteHtml` para Fallas, `ensamblarReporteHtmlOperaciones`
    para Operaciones) -- Operaciones no tiene banner "sin fallas" ni narrativa
    estática (el motor arma la narrativa en vivo dentro de `#hab-narrative`),
    así que ese caso pasa un array de bloques opcionales vacío.
  - `construirFiltrosHtmlComun` se extrajo de `generarReporte` (antes estaba
    inline) para que ambos tipos de reporte compartan la misma lógica de
    "Filtros aplicados" (Empresa/Periodo/Flota analizada).
  - Pipeline nuevo de obtención de eventos: `obtenerReglas`,
    `resolverReglasHabito`, `obtenerEventosDeRegla` (genéricos, para
    velocidad/ralentí) y, para PTO, un puerto directo del pipeline YA
    VALIDADO de `dashboardAnalisisPTO.js` (`apiMultiCall` con lotes de 15,
    `agruparPorCercania`/`construirVentanasPorVehiculo`/
    `consultarStatusDataAgrupado` con el mismo fallback anti-truncamiento por
    chunks, `confirmarPtoCercano`, `agregarPicoRpm`) -- se renombraron con
    sufijo `Operaciones` donde había riesgo de colisión de nombres.

## Qué se portó de `dashboardAnalisisPTO.js` (y qué NO)

**Importante, corrige una premisa del encargo:** pese a lo que sugiere el
nombre de la carpeta (`_build_dashboard_pto`), `dashboardAnalisisPTO.js`
**SOLO calcula el hábito de PTO/sobre-revolución** -- no tiene NINGUNA lógica
de velocidad ni de ralentí para portar (confirmado con `grep` exhaustivo:
`NOMBRE_REGLA_PTO` es la única constante de nombre de regla en todo el
archivo). Velocidad y ralentí son lógica nueva de esta tarea, con su propio
mecanismo de resolución de reglas (`REGLAS_HABITO`, ver abajo).

Lo que SÍ se portó verbatim/adaptado de `dashboardAnalisisPTO.js` (líneas
aproximadas en ese archivo, ~1738 líneas):

- `NOMBRE_REGLA_PTO` (línea 25), `ID_DIAGNOSTICO_PTO`/`ID_DIAGNOSTICO_RPM`
  (líneas 27-28), `VENTANA_PTO_MIN`/`VENTANA_RPM_SEG`/`UMBRAL_RPM_MERCEDES`
  (líneas 29-31), `DURACION_MINIMA_SEG=30` (línea 26) -- verbatim.
- `obtenerEventosCandidatos` (línea 307) -- el patrón `ExceptionEvent` con
  `ruleSearch:{id}` + `fromDate`/`toDate` que da `activeFrom`/`activeTo`
  directos; generalizado a `obtenerEventosDeRegla` (reusable para cualquier
  regla, no solo PTO).
- `apiMultiCall` con lotes de `TAMANO_LOTE_MULTICALL=15` (línea 190, comentario
  "Unexpected end of JSON input") -- verbatim.
- `agruparPorCercania`/`construirVentanasPorVehiculo`/
  `consultarStatusDataAgrupado` (líneas 373-469, con el fallback anti-
  truncamiento por chunks de `LIMITE_PAGINA_STATUSDATA=50000`) -- verbatim,
  renombradas con sufijo `Operaciones`.
- `confirmarPtoCercano` (línea 474) y `agregarPicoRpm` (línea 511) -- puerto
  directo, adaptados para usar `infoDispositivos`/`resolverInfoDispositivo`
  ya existentes en `reportes.js` (empresa/tipología/marca) en vez de la
  resolución propia de vehículos de `dashboardAnalisisPTO.js`
  (`obtenerInfoVehiculos`/`resolverVehiculos`) -- ver decisión de "empresa"
  más abajo.
- `filtrarPorUmbralMercedes` (línea 589) -- mismo criterio (1500 RPM para
  motores OM926/Mercedes), aplicado inline en `generarReporteOperaciones`
  usando `infoDispositivos[...].marca`.

## Reglas de Geotab usadas por cada hábito -- VERIFICADO contra la cuenta real

A diferencia de PTO (regla única ya validada, ver
`herramientas/estado_reglas.md`), **no existía ninguna regla ni script en el
repo que ya resolviera "cuál es la regla de velocidad/ralentí"**. Se
consultó la cuenta real de Geotab (`api.get('Rule')` + `api.get('ExceptionEvent')`,
2026-09-30) para decidir con datos reales en vez de adivinar:

- **RALENTÍ** -- familia `V_<modelo> RALENTÍ` (6 reglas): `V_(L9) RALENTÍ`,
  `V_(T380) RALENTÍ`, `V_(X12 y T800) RALENTÍ`, `V_RALENTÍ N400 800 RPM`,
  `V_RALENTÍ FURGÓN NHR 650 RPM`, `V_RALENTÍ MERCEDES`. Se inspeccionó el
  `groups` real de cada una: cada una tiene un **grupo de modelo/motor
  DISJUNTO** (Chevrolet N400, Chevrolet NHR, Mercedes Atego 3133,
  Kenworth T800/Foton Auman, International HV607, Kenworth T380) y un
  comentario casi idéntico ("Vel<1 km/h, RPM en rango nominal de ralentí,
  encendido, ~5 min") -- mismo patrón ya usado en el repo para
  V_DPF CARGA DE HOLLÍN (3 reglas paralelas). Se **excluyeron a propósito** 3
  candidatas que también matchean "RALENT" por nombre: `Ralentí Excesivo Sin
  PTO` (alcance `*Promoambiental`, TODA la flota -- su propio comentario dice
  *"Regla en proceso de prueba"*, se solaparía con la familia V_),
  `1. RALENTÍ TOTAL` (alcance compañía completa, comentario
  *"Reporte - Horas de motor"* -- es un contador de horas de motor, no un
  hábito de ralentí excesivo) y `Ralentí > 5min` (alcance compañía completa,
  sin comentario, mismo umbral que la familia V_ pero sin scoping por
  modelo -- probable duplicado/prueba).
- **VELOCIDAD** -- `V_VELOCIDAD MAYOR A 50 KM/H` (alcance `*Promoambiental`,
  toda la flota; único comentario descriptivo real entre 12 candidatas por
  nombre: *"supera los 50 km/h sostenido 30s"*; sigue la convención `V_` que
  en este repo marca reglas revisadas/productivas). Se **excluyeron a
  propósito** `Exceso de Velocidad 70/80/90km/h`, `Velocidad 75 Km/h` y
  `SV_Exceso de velocidad Nacional`: las 5 tienen el MISMO alcance (compañía
  completa), SIN comentario, y umbrales que se solapan entre sí -- un mismo
  exceso de velocidad real (ej. 85 km/h) dispararía "70km/h" Y "80km/h" a la
  vez, inflando el conteo varias veces sobre el mismo evento físico si se
  sumaran todas. También se excluyó `V_LÍMITE DE VELOCIDAD DE 30 KM/H
  GEOCERCA PARQUE DE INNOVACION DOÑA JUANA` por ser un límite de ZONA
  puntual (geocerca), no un hábito general de exceso de velocidad.
- **PTO** -- `SOBRE REVOLUCIÓN CON PTO (L9-X12-OM 926-ISF 3.8)`, verbatim de
  `NOMBRE_REGLA_PTO`, ya validada (ver `herramientas/estado_reglas.md`).

**NINGUNA de las decisiones de RALENTÍ/VELOCIDAD fue confirmada con el
usuario** -- son la interpretación más defendible con los datos reales de
alcance de grupos y comentario de cada regla candidata, pero es el primer
punto a revisar antes de confiar en los números del reporte de Operaciones.
Cambiar qué reglas se usan es editar un solo lugar: el objeto `REGLAS_HABITO`
al inicio de `reportes.js`.

## Campo "turno" (shift): NO implementado, a propósito

No existe ningún concepto de turno (T1/T2/T3) en `dashboardAnalisisPTO.js` ni
en ningún otro archivo del repo -- no se inventó un corte de horas
arbitrario. `construirFilaOperacion` deja `shift: null` en TODAS las filas,
con un comentario explícito en el código. Consecuencia visible en el reporte
generado: la sección "Turnos y reglas" sigue mostrando el gráfico
`hab_turnos` (el motor lo pinta igual, con T1/T2/T3 en cero eventos cada
uno, porque `filterRowsCf(DASH.rows, 'turno')` no queda vacío solo porque
`shift` sea `null`) -- se agregó una nota (`.sec-sub`) en la plantilla
explicando que está pendiente, para que no se lea como un bug silencioso.

**Qué se necesitaría para implementarlo**: franjas horarias de turno
confirmadas con el usuario (ej. T1 06:00-14:00, T2 14:00-22:00, T3
22:00-06:00, o lo que corresponda a la operación real de Promoambiental) --
en ese momento es un cambio de una sola línea en `construirFilaOperacion`
(derivar `shift` de `evento.activeFrom.getHours()`).

## Decisión de "empresa": se reutiliza la de Fallas, no la de `dashboardAnalisisPTO.js`

`dashboardAnalisisPTO.js` resuelve "ciudad" (`obtenerMapaGrupos`/
`resolverMarcaYTipologia`), no "empresa". `reportes.js` ya tenía su propia
resolución de "empresa" (`construirMapaEmpresas`/`resolverInfoDispositivo`,
construida hoy mismo para Fallas) que es funcionalmente equivalente pero ya
habla en términos de "empresa" -- se reutilizó tal cual para Operaciones (no
se duplicó una segunda resolución de grupos). **Verificado contra la cuenta
real**: la raíz de grupos es `*Promoambiental`, con 6 empresas candidatas
(`ESTACIÓN DE TRANSFERENCIA ZIPA`, `PACARIBE`, `PROMO AMBIENTAL DISTRITO
BOGOTA`, `PROMO CALI`, `PROMO VALLE`, `SER AMBIENTAL`), las 80 vehículos del
catálogo quedan asignados a alguna de las 6 (0 sin empresa resuelta) -- la
resolución SÍ funciona correctamente en esta cuenta real.

## Prueba contra la cuenta real (2 días, empresa "PROMO AMBIENTAL DISTRITO BOGOTA", 31 vehículos)

Se replicó el pipeline completo de `generarReporteOperaciones` en un script
Python standalone (misma cuenta, mismas reglas/IDs, mismo criterio de
filtrado por empresa/duración/PTO) para validar los números antes de dar la
tarea por terminada -- no se pudo ejecutar `reportes.js` dentro de MyGeotab
real (es un add-in de navegador), así que esto es la validación más cercana
posible sin esa instalación:

- Empresas candidatas encontradas: 6, las 80 devices del catálogo quedan
  todas asignadas a alguna.
- VELOCIDAD (`V_VELOCIDAD MAYOR A 50 KM/H`): **796 eventos** en 31 vehículos,
  últimos 2 días.
- RALENTÍ (familia `V_*`, 6 reglas): **304 eventos** -- desglose real por
  regla/modelo: `V_(L9) RALENTÍ` 161, `V_(X12 y T800) RALENTÍ` 34,
  `V_RALENTÍ N400 800 RPM` 13, `V_RALENTÍ FURGÓN NHR 650 RPM` 43,
  `V_RALENTÍ MERCEDES` 53, `V_(T380) RALENTÍ` 0 (sin vehículos T380 activos
  en esta empresa en el rango -- no es un error, el alcance de esa regla es
  otro grupo de modelo).
- PTO: **970 candidatos** de la regla → **490 confirmados** (50.5%) tras
  cruzar con el pulso real (±3 min) y aplicar el umbral Mercedes. Muestra
  real de un vehículo Mercedes (Atego 3133, motor OM926): eventos con
  `rpmPico` entre 1600 y 2056 RPM, todos por encima del umbral propio de
  1500 RPM para esa marca -- confirma que el filtro Mercedes SÍ se está
  aplicando (no descarta de más ni de menos) y que los picos de RPM
  calculados son fisicamente razonables.

Estos números salen de una réplica en Python del pipeline exacto de
`generarReporteOperaciones` (misma cuenta, mismas reglas/IDs, mismo criterio
de filtrado) -- no de ejecutar `reportes.js` dentro de MyGeotab (es un add-in
de navegador, no se pudo instalar y correr en una sesión real durante esta
tarea), pero valida que la lógica -- resolución de empresa, ids de regla,
filtro por alcance de vehículos, cruce de PTO por cercanía y umbral
Mercedes -- produce resultados reales, no vacíos ni absurdos.

**Bug real encontrado y corregido durante esta prueba -- pero en el SCRIPT DE
PRUEBA, no en `reportes.js`:** la primera versión del script de validación
calculaba la duración de cada evento con
`(at - af).total_seconds() if hasattr(at, "total_seconds") else 0`, un error
de traducción mental Python/JS -- `at` es un `datetime`, no un `timedelta`,
así que `hasattr(at, "total_seconds")` es `False` SIEMPRE y la duración
quedaba en 0 para todo evento, descartándolo en silencio (`if dur <= 0:
continue`) sin pasar por ningún contador de rechazo, lo que hizo parecer
"0 eventos en el alcance de la empresa" en la primera corrida pese a que el
filtro por vehículo funcionaba bien (796/3434 eventos SÍ pasaban ese
filtro). El código real de `reportes.js` (`obtenerEventosDeRegla`) usa
aritmética de fechas de JavaScript (`(activeTo - activeFrom) / 1000`), que
no tiene este problema -- se revisó línea por línea para confirmar que el
equivalente JS es correcto y no reproduce el bug del script de prueba.

## Verificación de los literales embebidos

Script Python: extrae `PLANTILLA_HTML_EMBEBIDA`, `MOTOR_JS_EMBEBIDO` y
`PLANTILLA_OPERACIONES_EMBEBIDA` de `reportes.js` con regex + `json.loads`, y
compara byte a byte contra `reporte_plantilla.html`,
`reporte_runtime_engine.js` y `reporte_operaciones_plantilla.html`
respectivamente -- los 3 coinciden exactamente (`len()` y contenido
idénticos). También se verificó el balance de paréntesis/llaves/corchetes de
todo `reportes.js` con un tokenizador simple (respeta strings, comentarios y
literales regex) -- balance correcto.

## Zip de instalación

Se regeneró `Reportes_addin.zip` (raíz del repo) con `Compress-Archive`,
mismos 3 archivos que la versión anterior (`config.json`, `reportes.html`,
`reportes.js`) -- se confirmó que el zip NO incluye las plantillas sueltas ni
el motor (quedan incrustados dentro de `reportes.js`).

## Pendiente de verificar manualmente

1. Confirmar con el usuario las decisiones de RALENTÍ/VELOCIDAD (ver arriba)
   -- son defendibles con los datos reales pero no están confirmadas.
2. Definir y confirmar el criterio de turno (T1/T2/T3) si se quiere ese
   desglose real -- hoy queda vacío a propósito.
3. Generar un reporte real desde dentro de MyGeotab (no se pudo probar la
   instalación real del add-in durante esta tarea, igual que quedó pendiente
   para Fallas) y revisar visualmente la sección "Turnos y reglas" para
   confirmar que la nota sobre el turno pendiente se lee bien en contexto.
4. El pipeline de PTO hace 1 llamada `StatusData` por candidato-ventana
   (confirmación + pico de RPM) -- con una empresa grande y un rango de
   fechas amplio esto puede ser lento (mismo problema ya documentado y
   mitigado con lotes/chunks en `dashboardAnalisisPTO.js`); no se probó
   contra un rango mayor a 2 días en esta tarea.
