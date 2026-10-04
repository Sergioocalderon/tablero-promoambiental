# Agrupar "Top códigos" por SPN/FMI real, no por ID interno de Geotab

**Fecha:** 2026-09-19
**Archivo:** `_build_dashboard_fallas/dashboardAnalisisFallas.js`
**Versión:** `config.json` 2.2 → 2.3

## Contexto

El usuario reportó que los datos "no le parecían coherentes": el vehículo
#1 del Top 5 acumulaba 722 episodios en 42 códigos distintos, pero el
código más repetido de TODA la flota (Top 5 códigos, varias ciudades)
apenas llegaba a 20 episodios y afectaba a **1 solo vehículo** — los 5
códigos del Top 5 afectaban a 1 vehículo cada uno, algo raro en una flota
multi-ciudad donde se esperarían códigos genéricos (luces de advertencia,
sensores) repetidos entre muchos vehículos.

## Hipótesis (grounded en CLAUDE.md, no confirmada con datos en vivo)

`CLAUDE.md` ya documenta que Geotab puede tener **dos entidades
`Diagnostic` con IDs distintos para el mismo diagnóstico real** ("uno
muerto, uno vivo" fue el caso encontrado en `R_CAÍDA DE TENSIÓN ALTERNADOR`
el 2026-09-05). `agregarPorCodigo` agrupaba por `idDiagnostico|idFailureMode`
(el ID interno de Geotab) en vez de por el SPN/FMI real -- si la cuenta
tiene IDs duplicados para el mismo código J1939 (plausible en una flota
nacional con varios modelos de motor: L9, X12, OM926, ISF 3.8...), la misma
falla real se fragmentaba en varias filas de "1 vehículo" en vez de sumarse
en una sola fila de la flota completa. Esto explicaría exactamente el
patrón reportado.

## Cambio

`agregarPorCodigo` ahora agrupa por **SPN/FMI real** (`diagInfo.codigo` /
`fmInfo.codigo`) cuando el diagnóstico tiene un código identificable —
independiente de qué entidad `Diagnostic` de Geotab lo haya reportado. Si
el diagnóstico NO tiene código real ("Diagnóstico desconocido", SPN "?"),
se sigue agrupando por ID interno, a propósito: fusionar todos los "?" bajo
una sola clave uniría diagnósticos genuinamente distintos que Geotab no
identificó, que es peor que dejarlos separados.

Este cambio también beneficia automáticamente la tabla de detalle del
drill-down por sistema (`construirTablaSistemaDetalle`), que reutiliza la
misma función.

## Pendiente de verificar manualmente

No hay test suite, y esta hipótesis **no se confirmó contra datos reales**
(no hay acceso a Geotab desde esta sesión de edición de código). Al montar
el zip:
- Confirmar que el Top 5 de códigos ahora muestra conteos de "Vehículos"
  más altos que 1 para los códigos genéricos esperables (luces de
  advertencia, sensores de rueda, etc.).
- Si el problema persiste igual después de este cambio, la hipótesis de
  IDs duplicados queda descartada y hay que investigar otra causa (por
  ejemplo, revisar con `herramientas/geotab_reglas_v3.py` o una consulta
  directa si existen de verdad Diagnostic duplicados en la cuenta para los
  SPN/FMI del Top 5 reportado).
