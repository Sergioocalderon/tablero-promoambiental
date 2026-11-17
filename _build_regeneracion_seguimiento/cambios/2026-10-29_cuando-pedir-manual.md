# Cuándo pedir la regeneración manual: reglas por nivel de hollín

**Fecha:** 2026-10-29
**Versión:** 1.8 → 1.9
**Archivos:** `seguimientoRegeneracion.parte.js` (`analizarRegeneracionActiva`), `config.json`; el `.js`, el `.html` y el zip los
genera `herramientas/construir_addins_regeneracion.py`.

## Por qué se cambió la regla

La v1.8 pedía la manual cuando la automática "no bajaba 10 puntos a los 150 min" o duraba más de 8 h. Calibrada con 30 días de la
flota (841 sesiones de regeneración activa) esa regla era mala:

- El 68 % de las sesiones empiezan con hollín < 60 % (DPF casi limpio): ahí no bajar es normal. La regla marcaba como "sin efecto"
  a 35 de las 74 sesiones largas de ese tipo (hollín mediano 15 %).
- Con hollín >= 60 % (270 sesiones) la automática suele resolver: 91-100 % bajan >= 10 pts, y esperar vale la pena (sin bajar a los
  60 min, el 88 % baja después; a los 150 min, el 82 %; mediana 53 min, p75 102 min).
- El testigo encendido no garantiza nada: 74 de 81 encendidos de lámpara ocurrieron con una regeneración activa en curso.
- Las 31 manuales se hicieron casi siempre (29) con la lámpara ya encendida, con hollín mediano ~170 %, y lo bajaron ~135 pts.

## Reglas nuevas (solo para regeneración **automática**; se mira la última lectura de hollín si tiene <= 90 min)

| Estado | Condición | Acción |
|---|---|---|
| **Validar el sistema** (naranja) | hollín >= 110 % | llamar al conductor y pedirle la manual ahora |
| **Atención** (ámbar) | hollín >= 100 % y, pasados 60 min, no ha bajado 10 pts respecto al inicio | llamar y pedir la manual |
| En curso | cualquier otro caso | No hace falta llamar si el hollín baja; si no, esperar |
| Prolongada (gris) | más de 8 h con el testigo | conviene revisar el vehículo (no se pide la manual) |
| Sin lecturas (gris) | testigo en activo y sin lecturas hace > 90 min | motor apagado o testigo pegado |

Si ya se vio el interruptor (manual) y el hollín sigue alto: "ya se activó la manual… conviene revisar el vehículo" (no se vuelve a pedir).
Se quitó el estado "Sin efecto". "Validar el sistema" reemplaza al "Urgente" propuesto (nombre más ameno, pedido por el usuario); su pastilla es
naranja, no roja. Nuevo filtro de estado **"Pedir manual (n)"** para ver solo a quién hay que llamar. "Ver reglas de umbral" explica estas reglas.

## Lo medido (hollín inicial >= 60 %, 270 sesiones; resultado malo = la lámpara se enciende durante o hasta 2 h después)

- Hollín >= 110 %: 98 % de las lámparas pasan por ahí, avisa ~18 min antes; ~50 % de los avisos se habrían resuelto solos.
- Hollín >= 100 % sin bajar 10 pts a los 60 min: 68 % de precisión, atrapa el 81 % de las lámparas.
- Regla anterior (150 min): 49 % de precisión, atrapa el 74 %.
- Ninguna regla da mucha anticipación: cuando la automática falla, el hollín sube rápido y la lámpara llega en ~1 h. Volumen estimado en toda la
  flota: ~2 llamadas al día por "Atención" y ~3 por "Validar el sistema".

## Pendiente

Falta la verdad de campo (qué conductores dijeron "es automática" y qué ocurrió). El criterio de lámpara es un sustituto de "la manual era
necesaria". Los umbrales son constantes al inicio de `analizarRegeneracionActiva` (`REGEN_HOLLIN_VALIDAR`, `REGEN_HOLLIN_ATENCION`,
`REGEN_ATENCION_MIN`) para ajustarlos con datos del usuario.

## Verificación

Chromium con 4 días de datos reales y 5 instantes distintos: 1091-GVT507 (hollín 131-192 %) y 3096-GVT514 (119 %) salen en "Validar el
sistema"; 1148-NWW623 a las 23:41 sigue en "En curso, no hace falta llamar" (hollín 99 % → 81 %); desaparecen las marcas falsas en sesiones de poco
hollín. 0 errores de consola.
