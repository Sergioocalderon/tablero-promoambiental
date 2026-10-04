# Auditoría: marca Chevrolet y nombre de ciudad con tilde

**Fecha:** 2026-10-03
**Versión:** 2.4 → 2.5
**Archivos:** `dashboardAnalisisFallas.js`, `config.json`, `DashboardFallas_addin.zip` (nuevo, raíz del repo)

## Contexto

Auditoría contra la cuenta real (Chromium + API real, solo lectura). Cifras de
la vista de 30 días recalculadas por fuera en Python, todas exactas:

- 14.086 episodios y 75 vehículos.
- 423 activas / 810 inactivas.
- +4 % frente al periodo anterior.
- Top 5 de códigos idéntico.

## Cambios

- `REFERENCIA_MOTOR_POR_MARCA` + `'chevrolet': 'Sin confirmar'`: los NHR y N400
  salían "Sin marca" y con motor "Desconocido".
- `normalizarCiudad`: "EstacióN De Transferencia Zipa" → "Estación De
  Transferencia Zipa" (`\b\w` es solo ASCII en JS). Es el mismo arreglo que ya
  tenía `alertasFallas.js` desde el 2026-10-01 y que no se había llevado aquí.

## Observaciones (no son errores de cálculo; pendientes de decisión)

- "57 vehículos en estado crítico" (de 75): el umbral ≥21 episodios se calibró
  el 2026-09-12, y hoy el promedio es de ~188 episodios por vehículo, así que
  casi toda la flota cae en "Crítico".
- "Activas vs. inactivas" cuenta combinaciones vehículo+falla (1.233), no
  episodios (14.086). La cifra es correcta, pero la etiqueta se presta a
  confusión.
- El código #1, SPN 12984 "Instancias de mensajes mensuales restantes" (1.270
  episodios en 5 vehículos), parece un contador telemático y no una falla
  mecánica.

## Nota

Este add-in no tenía zip de instalación en la raíz del repo. Se genera
`DashboardFallas_addin.zip` con `config.json`, `dashboardAnalisisFallas.html`
y `dashboardAnalisisFallas.js`.
