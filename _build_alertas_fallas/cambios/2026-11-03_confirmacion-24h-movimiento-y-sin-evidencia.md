# Alertas por Severidad v1.20 — confirmación en 3 estados, a prueba de fallas del dispositivo

**Problema:** el criterio v1.18 llamaba "Confirmado" a todo código activo con menos de 3 días, o con 3 días pero pocos arranques. Medido con 45 días de la flota (backtest, fotos de hace 8 a 15 días), de los códigos con último reporte de 1 a 3 días solo el 29 % volvía a reportarse en las 24 h siguientes: la mayoría ya no estaba. Además, la ignición sola engaña (un motor encendido en el patio) y no distinguía un dispositivo caído de un código resuelto.

**Objetivo:** que un código se reporte como activo solo cuando es verídico, sin falsos reportes.

## Cambio (`agregarConfirmacion`)
| Estado | Condición | Efecto |
|---|---|---|
| **Confirmado** | Último reporte de menos de 24 h (`CONFIRMACION_HORAS`) | Suena, cuenta en las tarjetas y en "alerta crítica" |
| **Por verificar** | Más de 24 h **y** el dispositivo comunica **y** el vehículo recorrió ≥ 5 km desde el reporte (`MOVIMIENTO_KM_MIN`) **y** llegan señales del motor | Atenuado, sin sonido, no cuenta |
| **Sin evidencia** | Más de 24 h y falla alguna de las tres pruebas, o no se pudo consultar | Atenuado, sin sonido, no cuenta; se muestra como "último estado conocido" con el motivo |

- Movimiento = suma de `distance` de los `Trip` posteriores al reporte (reemplaza los arranques de la ignición).
- Dispositivo = `DeviceStatusInfo.isDeviceCommunicating`, o última comunicación en las últimas 24 h.
- Señal del motor = hay `StatusData` de la RPM `aW3Nmy-ktfEuvrdkya4z0yg` en las últimas 24 h (caso 11006: el GPS vivo con el motor sin señales no prueba nada).
- Si falla la consulta (Trip, estado o RPM), todos los códigos de más de 24 h quedan **Sin evidencia**; nunca "Por verificar" ni "Confirmado".
- La lámpara (criticidad) se sigue leyendo del último registro; con menos de 24 h es la lectura más actual.

## Interfaz
- Pastillas "Por verificar" y "Sin evidencia" con el motivo en el texto de ayuda; la celda de fecha muestra "hace N h/d · N km".
- Filtro Confirmación: Todas / Solo confirmadas / Por verificar / Sin evidencia. En la tarjeta de códigos hay un chip clicable por cada estado no confirmado.
- Expediente y consolidado usan el mismo texto (`textoSinConfirmar`).

## Simulación con datos reales (3/11/2026, 299 códigos visibles)
Confirmados 178 → 133 (24 h); unidades en alerta crítica 3 → 2 (el 3098-GVT565 deja de contar: su lámpara DPF se apagó el 2/11 y el hollín está en 19 %). De los 166 códigos de más de 24 h, 123 quedan Por verificar y 43 Sin evidencia (42 sin movimiento y 1 sin señal del motor). Los 9 ALTA de más de 24 h tienen entre 176 y 3.196 km recorridos desde su último reporte.

## Probado (Chromium, API simulada)
- 10 códigos de 8 vehículos: 4 confirmados, 3 por verificar, 3 sin evidencia (sin movimiento, sin señal del motor, dispositivo sin comunicar). Tarjetas: 2 unidades ALTA, 1 MEDIA/BAJA, 4 códigos.
- Fallo de la API de viajes: los 6 códigos viejos quedan Sin evidencia, los 4 confirmados no cambian.
- Filtros, chips, orden por vehículo, expediente (con y sin evidencia) y la pausa de recarga de v1.19: sin errores de consola.
- No probado dentro de MyGeotab.

## Límites
- Los porcentajes miden si el código se vuelve a reportar, no si existe; la verdad solo la da el escáner.
- Un vehículo que legítimamente no reporte la RPM de alta resolución quedará siempre en Sin evidencia (hoy 1 de 53).
- Si el GPS falla pero el motor sigue bien, los km dan cero y queda Sin evidencia.
- Las constantes 24 h / 5 km se pueden ajustar; 12 h quitaría ~13 códigos MEDIA/BAJA más de confirmados.
