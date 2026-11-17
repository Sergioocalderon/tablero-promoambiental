# Creación del add-in "Seguimiento de Regeneraciones DPF"

**Fecha:** 2026-10-27
**Versión:** 1.0
**Archivos:** `seguimientoRegeneracion.parte.js`, `config.json` (el resto se genera con `herramientas/construir_addins_regeneracion.py`).

## Qué hace

Tablero operativo en vivo (se refresca solo cada 5 min mientras está abierto):

- **REGENERAR YA:** vehículos con la lámpara DPF encendida, con la acción a tomar según los
  mismos umbrales del aviso por Telegram: avisar al conductor a las 2 h de motor encendido,
  escalar a las 4 h, taller a las 24 h de haber activado el interruptor sin que la lámpara se apague;
  "Sin motor" si lleva más de 24 h casi sin motor encendido (posible parqueado).
- **PRÓXIMOS:** hollín sobre el umbral de su marca (International 80 %, Foton 95 %, Kenworth 100 %), lámpara apagada.
- Selector por ciudad y botón "Copiar mensaje para WhatsApp" con el mismo formato de `reporte_regeneracion_ciudades.py`.
- Historia: 14 días de lámpara/interruptor/ignición y 48 h de hollín (igual que el reporte de Python).

## Verificación

Con datos reales del 2026-10-27: 1 vehículo con lámpara encendida (3094-GVT509, "Taller": activó el
interruptor el 20-oct y la lámpara sigue), 2 próximos en Cali (90 % y 87 %). Mensaje copiado con el formato
esperado; 0 errores de consola. Un refresco automático que falle no borra lo que ya se está viendo.

## Límites conocidos

- Un vehículo sin hollín en 48 h ni lámpara en 14 días cuenta como "Sin señal" (puede estar parqueado).
