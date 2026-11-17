# Confirmación de códigos ("Por verificar") y FMI 0

**Fecha:** 2026-10-29
**Versión:** 1.17 → 1.18
**Archivos:** `alertasFallas.js`, `config.json`, `AlertasPorSeveridad_addin.zip`

## Qué pasó (caso 1226-FXW563)

Una tarjeta pedía "Retirar de operación e ingresar a taller" por una luz roja (SPN 101, presión del cárter) y el taller escaneó el
vehículo sin que saliera ningún código. En Geotab había UN solo registro, del 18/10 05:37, con luz roja y FMI 0; nunca se volvió a
reportar ni se desactivó, y desde entonces el vehículo arrancó 31 veces y el ECU siguió reportando otros códigos (202 registros solo
ese día). "Activa" en Geotab es el último estado que llegó, no que el código siga presente. Era una falsa alarma.

## Qué se midió (30 días de la flota, 82 vehículos, 268.000 registros)

- La idea "un código vivo se reporta en cada arranque" **no se cumple**: solo el 33 % de los arranques traen un nuevo reporte de los códigos
  persistentes. No se puede usar "no reapareció tras 2 arranques".
- Sí se cumple esto: entre dos reportes Active seguidos de un mismo código (sin desactivación en medio, 142.000 pares), el silencio es de
  p95 = 0,4 días y p99 = 1,6 días; solo el 0,5 % pasa de 3 días y solo el 1,5 % de 5 arranques. Con luz roja/protección: p99 = 3,9 días.
- Las alarmas "activas" con luz roja que mostraba el tablero: **11 de 12 llevaban más de 3 días sin reportarse**.

## Qué cambió

- **Por verificar:** un código activo con **3 días o más sin reportarse y 5 o más arranques del vehículo desde entonces** queda "por
  verificar" (`CONFIRMACION_DIAS`, `CONFIRMACION_ARRANQUES`). No se oculta: sigue visible, atenuado, con la etiqueta "Por verificar" y
  "hace 9 d · 9 arranques" (el tooltip explica qué hacer: verificar con escáner, incluidos los códigos inactivos o almacenados).
- **Efectos:** no suena ni sale en el banner; no cuenta en "Unidades en alerta crítica" ni en el reparto de códigos (aparece aparte como
  "Por verificar N", que filtra al hacer clic); el vehículo no se vuelve ALTA por un código viejo (la criticidad del vehículo es la del código
  confirmado más crítico; si todos están por verificar, va al final con la etiqueta "Por verificar"); el filtro de criticidad solo mira lo
  confirmado. Si el código vuelve a reportarse, deja de estar por verificar y puede volver a sonar.
- **Nuevo filtro "Confirmación":** Todas / Solo confirmadas / Por verificar.
- **Expediente y consolidado descargables:** pastilla "CRITICIDAD ALTA · SIN CONFIRMAR" en gris y un aviso ("Sin confirmación reciente: hace 9
  días que no se reporta y el vehículo arrancó 9 veces desde entonces. Probablemente ya no está activo: verificar con escáner…").
- **FMI 0:** `f.fmi = fmInfo.codigo || '?'` descartaba el 0 (falso en JS), así que la clase más grave salía como "FMI ?" y "Significado no
  disponible". Ahora un código 0 es válido (`valorODesconocido`). Afectaba a 8 de 456 fallas activas de la flota (5 con luz roja).
- La columna Nivel de la tabla es más ancha (116 px) para la etiqueta nueva.

## Cuidados

- Sin evidencia no se rebaja: si no se puede consultar la ignición del vehículo (error o sin datos), el código NO se marca por verificar.
- Se consulta la ignición solo de los vehículos con algún código de 3 días o más (una llamada por vehículo, en un solo `multiCall`).
- El umbral no es infalible: ~1 % de los códigos vivos con luz roja podría pasar esos límites; por eso se atenúa y se filtra, no se borra.

## Pendiente

El mismo `|| '?'` sigue en `telegram_alertas.py` (bot en producción, ~l.1497) y en `_build_dashboard_fallas/dashboardAnalisisFallas.js` (~l.760).
La tarjeta "Decisión requerida" del Sistema Copiloto no está en el repo: su texto "Retirar de operación hoy" no cambia con este add-in.

## Verificación

Chromium con una API simulada que reproduce el caso: luz roja FMI 0 de 9 días en un vehículo con arranques (queda "Por verificar" y al final),
falla roja vieja en un vehículo con algo confirmado (sigue MEDIA), FMI 0 reciente (sigue ALTA y muestra "SPN 101/FMI 0"), vehículo sin datos de
ignición (no se rebaja). KPI 3 ALTA / 4 / 15 códigos / 2 por verificar; filtro ALTA solo confirmadas; filtro "Por verificar" 2 filas; expediente
descargable con el aviso y el significado de FMI 0. Regresión completa con la prueba anterior: igual que antes, 0 errores de consola.
**No probado dentro de MyGeotab.**
