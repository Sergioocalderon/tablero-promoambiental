# Rango por defecto: 7 días en vez de 14

**Fecha:** 2026-10-03
**Versión:** 1.16 → 1.17
**Archivos:** `dashboardAnalisisPTO.js`, `config.json`, `AnalisisPTO_addin.zip`

## Contexto

En la auditoría del mismo día se midió que la vista por defecto de 2
semanas descargaba ~1,6 GB de RPM de alta resolución solo para el periodo
actual. La comparación con el periodo anterior pide otro tanto y no terminaba
ni en 15 minutos. Esto causa el "Se agotó el tiempo de espera consultando
Geotab (multiCall, lote de 15)" que se ve en producción.

Opciones presentadas al usuario (ver
`2026-10-03_auditoria-regla-por-id-marca-ciudad.md`):

- **A.** Ventanas de RPM más chicas con pausas entre lotes.
- **B.** Diagnóstico de RPM estándar: subestima el pico, descartada.
- **C.** Rango por defecto de 1 semana.

**Decisión del usuario: opción C.**

## Cambios

- `DIAS_RANGO_POR_DEFECTO`: 14 → 7.
- Botón "Últimas 2 semanas" → "Última semana" (usa el mismo
  `rangoPorDefecto()`).
- No se toca el cálculo de RPM pico ni la confirmación de PTO. Un rango más
  largo sigue disponible a mano con "Analizar rango", con el mismo costo de
  antes.

## Verificación (corrida real en Chromium con la API real)

- La carga **completa**, incluida la comparación con el periodo anterior,
  terminó en **316 s** sin errores de API ni de consola: 266 llamadas en
  multiCall y ~854 MB entre la semana actual y la anterior.
- Resultado: 2.755 eventos con PTO confirmado (+21 % frente a la semana
  anterior), 32 vehículos afectados (−9 %).
- Sigue siendo una carga pesada (~5 min). Si en MyGeotab real todavía es
  lenta, el siguiente paso es la opción A.
