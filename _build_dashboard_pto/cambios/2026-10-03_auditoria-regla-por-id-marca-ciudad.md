# Auditoría: regla por ID, marca Chevrolet, nombre de ciudad con tilde

**Fecha:** 2026-10-03
**Versión:** 1.15 → 1.16
**Archivos:** `dashboardAnalisisPTO.js`, `config.json`, `AnalisisPTO_addin.zip`

## Contexto

Auditoría de los add-ins contra la cuenta real (Chromium + API real, solo
lectura, con recálculo independiente en Python). Cifras del dashboard para la
vista de 2 semanas: **5.016 eventos confirmados en 36 vehículos**. El recálculo
independiente dio **5.017 en 36** (la diferencia de 1 sale del borde de
ventana entre dos implementaciones). Cálculo correcto.

## Cambios

- `ID_REGLA_PTO` (nuevo): `obtenerIdRegla` busca primero por ID y luego por
  `NOMBRE_REGLA_PTO`. Mismo blindaje que Operaciones, donde un renombre en
  Geotab hizo perder una regla en silencio.
- `REFERENCIA_MOTOR_POR_MARCA` + `'chevrolet': 'Sin confirmar'`: el motor de
  NHR y N400 es distinto y no está confirmado, así que no se inventa.
- `normalizarCiudad`: "ESTACIÓN DE TRANSFERENCIA ZIPA" salía "EstacióN De
  Transferencia Zipa" (`\b\w` es solo ASCII en JS). Se aplica el mismo arreglo
  que ya tenía `alertasFallas.js` desde el 2026-10-01.

## Hallazgo SIN corregir: volumen de RPM (pendiente de decisión del usuario)

Medido en la vista por defecto (2 semanas, toda la flota): el pase de RPM
pico descargó **~1,6 GB** en ~340 llamadas. Lotes de 15 llamadas de 300.000 a
526.000 filas (26-115 MB cada uno), y varias ventanas truncadas en el tope de
50.000. La comparación con el periodo anterior seguía cargando a los 15 min.
Esto explica los "Se agotó el tiempo de espera (multiCall, lote de 15)".

Opciones evaluadas con datos reales:

- **Ventanas más chicas** (simulado sobre los 8.991 candidatos reales): el
  mínimo posible es ~0,2 GB, porque los eventos ya suman ~340 h de RPM, pero
  cuesta ~6.000 llamadas, 6 veces la cuota de ~1.000/min que ya se excedió
  antes (ver `2026-09-23_tercer-fix-cuota-api-datos-reales.md`). Un punto
  intermedio (hueco 15 min / tope 1 h) da ~2.340 llamadas y ~3,5 veces menos
  datos, pero necesita pausas entre lotes para no pasar la cuota.
- **Diagnóstico estándar "Velocidad del motor"** (`DiagnosticEngineSpeedId`):
  17 veces menos filas (muestra de 40 eventos), pero subestima el pico
  (mediana −25 rpm, peor caso −709 rpm, solo 11 de 40 exactos). Rompería el
  umbral de 1.500 RPM de Mercedes. **Descartado.**

No se cambió nada de esto: es un compromiso entre velocidad, precisión y
cuota que debe decidir el usuario.

## Verificación

- El dashboard se ejecutó en Chromium con la API real (puente HTTP local). Sin
  errores de consola, con KPIs y tabla renderizados.
- Verificación de la 1.16 (corrida real en Chromium): la regla se resuelve por
  ID, 5.021 eventos confirmados en 36 vehículos (la ventana de 2 semanas se
  corrió unas horas frente a la corrida de la 1.15), "Estación De
  Transferencia Zipa" bien escrito en el filtro y en la tabla, 0 errores de API
  y de consola.
