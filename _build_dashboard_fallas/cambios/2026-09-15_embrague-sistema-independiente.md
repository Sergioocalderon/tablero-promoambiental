# "Embrague" como sistema crítico independiente de transmisión

**Fecha:** 2026-09-15
**Archivo:** `_build_dashboard_fallas/dashboardAnalisisFallas.js`

## Contexto

Al pedir un resumen ejecutivo del dashboard para un Director de Operaciones,
se requería afirmar que "el sistema de EMBRAGUE se evalúa y categoriza como
un sistema completamente independiente de la transmisión" — al revisar el
código (`SISTEMAS_CRITICOS`, línea ~105) esto **no era cierto todavía**: la
lista de sistemas críticos solo tenía motor/frenos/dirección. Una falla de
embrague solo se marcaba crítica por accidente, si de paso contenía la
palabra "cilindro" (ej. "cilindro de embrague", que matcheaba por el bucket
de motor). Nombres reales como "Presión del embrague" o "Condición de
desgaste de los discos de embrague" no contenían ninguna palabra clave
existente y quedaban sin detectar del todo.

## Cambio

- Se agrega `['embrague', 'clutch']` como cuarto sistema crítico en
  `SISTEMAS_CRITICOS`, independiente de cualquier categoría de transmisión.
- Se agregan 3 exclusiones específicas a `EXCLUSIONES_SISTEMA_CRITICO`:
  `'embrague del soplador'`, `'embrague de aire acondicionado'`,
  `'embrague del compresor'` — mismo tipo de falso positivo que ya se había
  corregido para "motor" (motor del ventilador HVAC): estos son embragues de
  ACCESORIO (compresor de A/C, ventilador de enfriamiento), no el embrague de
  tracción del vehículo.

## Validación contra datos reales

Se probó la función `esFallaSistemaCritico` (réplica en Python) contra los
**330 nombres únicos** de diagnósticos de la cuenta de Geotab que mencionan
"embrague" o "clutch":

- **317 correctamente marcados como críticos** — embrague de tracción real:
  pedal, actuador, sensor de posición/presión, transmisión de doble embrague,
  embrague del convertidor de par, embrague de la toma de fuerza (PTO),
  embrague 4WD/AWD.
- **13 correctamente excluidos** — embragues de accesorio: compresor de A/C
  (7 variantes: circuito, relé, controlador), ventilador de enfriamiento del
  motor (3 variantes).

## Pendiente / nota menor

2 de los 317 marcados como críticos corresponden a unidades de refrigeración
de carga (Carrier / ThermoKing: "Fallo del embrague" / "Revise las correas o
el embrague") — es el embrague de la banda del compresor del equipo de frío,
no el embrague de tracción del vehículo. Volumen bajo (2 de 330), se deja
como sabido pero sin excluir por ahora; agregar `'unidad de refrigeración'` a
las exclusiones si llega a generar ruido real en la flota.

## Pendiente de verificar manualmente

No hay test suite. Verificar en Geotab que algún vehículo con falla de
embrague real (ej. "Presión del embrague" o "Discos de embrague") ahora
aparece clasificado como Crítico en el dashboard, y que un vehículo con solo
fallas de embrague de A/C/ventilador NO se marca crítico por eso.
