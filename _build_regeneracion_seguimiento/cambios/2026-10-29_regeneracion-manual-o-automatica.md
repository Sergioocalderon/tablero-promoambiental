# Regeneración manual o automática (y cuándo llamar al conductor)

**Fecha:** 2026-10-29
**Versión:** 1.7 → 1.8
**Archivos:** `seguimientoRegeneracion.parte.js`, `config.json`; el `.js`, el `.html` y el zip los genera
`herramientas/construir_addins_regeneracion.py`.

## Para qué

Al llamar al conductor, a veces dice que la regeneración es automática y a veces hay que pedirle la manual. Hace falta saber
de un vistazo cuál es cuál. Hasta la v1.7 el tablero mostraba que el vehículo regeneraba, pero no de qué tipo.

> **Nota (v1.9):** la regla de "Pedir manual" de abajo (sin efecto a los 150 min / prolongada) se reemplazó por una basada en el nivel de hollín;
> ver `2026-10-29_cuando-pedir-manual.md`. Lo demás (tipo manual/automática, mensaje, expediente) sigue igual.

## Qué cambió (sección "En regeneración ahora")

- **Columna Tipo:** *Manual* (morado, con la hora en que activó el interruptor y cuántas veces) o *Automática* (gris).
- **Regla:** Manual si el interruptor manual se ve activado desde 30 min antes del inicio de la sesión hasta ahora; Automática si
  no. El interruptor se registra por eventos (pasa a 1 y vuelve a 0 en segundos) y casi siempre se aprieta con el testigo ya
  encendido, es decir, cuando la automática no terminaba. En 4 días de datos reales: 16 pulsaciones, 6 vehículos, 6 sesiones.
- **Qué hacer con el conductor** (debajo del estado, en negrita):
  - Automática que baja: "No hace falta llamar: regenera sola y el hollín baja."
  - Automática recién iniciada: "Esperar… si a los 150 min no baja, pedirle la manual."
  - **Automática sin efecto o prolongada: "Llamar: pedirle al conductor la regeneración manual"** y etiqueta naranja *Pedir manual*.
  - Manual en curso: "El conductor activó la regeneración manual (hora)."
  - Manual que no resolvió: "conviene revisar el vehículo".
- **Mensaje de WhatsApp:** cada línea dice "automática" o "manual (activó …)" y añade "📞 pedir manual" cuando toca llamar.
- **Expediente:** el "Qué hacer" incluye el consejo, la tarjeta de inicio dice si fue manual o automática, y la gráfica marca con una
  línea naranja **cada vez que se activó el interruptor** (antes solo las de episodios de lámpara).
- "Bajó" muestra "↑ N pts" cuando el hollín sube durante una regeneración (antes salía "-5 pts").
- "Ver reglas de umbral" explica la regla de manual/automática.

## Criterios que conviene confirmar

La regla de "Pedir manual" es la del propio tablero (sin efecto a los 150 min o prolongada > 8 h, y sin interruptor visto); no es un
criterio que haya definido el usuario. Si en la práctica conviene pedir la manual antes (por ejemplo, con hollín alto y
automática lenta), se ajusta en `analizarRegeneracionActiva`. Una pulsación muy corta del interruptor podría no quedar
registrada, así que "Automática" significa "no se vio el interruptor".

## Verificación

Chromium con 4 días de datos reales de las 5 señales, en 5 instantes distintos: el 1148-NWW623 sale *Manual* a las 00:20 del
28-oct (activó a las 00:12) y *Automática* a las 23:41 (hollín 99 % → 81 %, "no hace falta llamar"); 1149-NWX185 *Manual*
(activó 23:23, 2 veces); 1091-GVT507, automática con más de 47 h y el hollín subiendo de 38 % a 137 %, sale *Prolongada* con
*Pedir manual*. Se abrieron los 15 expedientes de dos instantes sin `NaN`/`undefined` y sin errores de consola; Análisis y
Reportes siguen cargando. **No probado dentro de MyGeotab.**
