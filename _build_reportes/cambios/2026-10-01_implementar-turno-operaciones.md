# Implementar turno (T1/T2/T3) en el reporte de Operaciones

## Contexto

El reporte de Operaciones (ver `cambios/2026-09-29_agregar-reporte-operaciones.md`)
dejó el campo `shift` en `null` a propósito -- no existía ningún criterio de
franja horaria confirmado con el usuario. También quedaron sin confirmar las
decisiones de `REGLAS_HABITO` (qué reglas de Geotab usa cada tipo de hábito).

## Confirmado con el usuario (2026-10-01)

- **RALENTÍ y VELOCIDAD**: las reglas elegidas (familia de 6 `V_<modelo>
  RALENTÍ` y `V_VELOCIDAD MAYOR A 50 KM/H`) son correctas. `REGLAS_HABITO` no
  se tocó.
- **Turno**: T1 05:00-13:00, T2 13:00-21:00, T3 21:00-05:00 (hora Bogotá).

## Qué se cambió

- `reportes.js`: nuevas funciones `horaBogota(fecha)` y `calcularTurno(fecha)`
  (junto a las demás utilidades de fecha, cerca de `formatearGenerado`). Usan
  `Intl.DateTimeFormat` con `timeZone: 'America/Bogota'` explícito -- NO
  `fecha.getHours()` -- porque el reporte se genera en el navegador del
  analista, cuya zona horaria del sistema no está garantizada, y un turno mal
  calculado por una diferencia de zona horaria sería peor que dejarlo sin
  calcular. Mismo patrón que ya usan `formatearGenerado`/`formatearFechaHora`.
- `construirFilaOperacion`: `shift: null` → `shift: calcularTurno(evento.activeFrom)`.
- `reporte_operaciones_plantilla.html`: actualizada la nota de la sección
  "Turnos y reglas" (antes decía explícitamente que el turno no se calculaba).
- `PLANTILLA_OPERACIONES_EMBEBIDA` en `reportes.js` re-generada desde el HTML
  actualizado (mismo mecanismo `json.dumps(..., ensure_ascii=True)` ya usado,
  no hay script de build reutilizable para esto todavía -- se hizo con un
  script puntual, verificado byte a byte contra el HTML fuente antes de
  descartarlo).
- `config.json`: versión `1.1` → `1.2`.
- `Reportes_addin.zip` regenerado (verificado: exactamente `config.json`,
  `reportes.html`, `reportes.js`, sin plantillas sueltas).

## Verificación

- El literal `PLANTILLA_OPERACIONES_EMBEBIDA` decodifica byte a byte igual al
  HTML fuente actualizado (confirmado con script puntual).
- Balance de paréntesis/llaves/corchetes de `reportes.js` (excluyendo los 3
  literales embebidos grandes) revisado: llaves y corchetes balanceados;
  paréntesis con el mismo desbalance de 1 que ya se investigó en la sesión
  anterior (atribuido a una limitación del tokenizer simplificado frente a un
  literal regex con rango Unicode en `slug()`, preexistente, no introducido
  por este cambio).
- **No probado**: instalación real en MyGeotab (sigue pendiente, como ya
  estaba documentado).

## Pendiente

- Probar los 2 reportes (Fallas y Operaciones) en una cuenta real de MyGeotab.
- Empezar el Mini Expediente (ficha de caso de falla puntual, disparada a
  mano desde un add-in, con mapa/ubicación) -- siguiente tarea acordada con
  el usuario.
