# Creación del add-in "Reportes de Regeneraciones DPF"

**Fecha:** 2026-10-27
**Versión:** 1.0
**Archivos:** `reportesRegeneracion.parte.js`, `config.json` (el resto se genera con `herramientas/construir_addins_regeneracion.py`).

## Qué hace

Para una ciudad (o todas) y un rango de fechas descarga:

- **Reporte HTML autónomo** (datos incrustados, sin librerías externas, con estilos de impresión A4 horizontal
  para guardar como PDF): KPIs, lectura del periodo, tendencia diaria, tabla por ciudad,
  vehículos con lámpara encendida y qué hacer con cada uno, detalle por vehículo y vehículos sin señal.
- **CSV** con una fila por solicitud de lámpara y por regeneración detectada (separador `;` y coma decimal,
  para abrirlo directo en Excel con configuración regional de Colombia).

Los números coinciden con los de "Análisis de Regeneraciones DPF" (mismo motor).

## Verificación

Rango de 30 días con datos reales: HTML de ~21 KB y CSV de 2.069 filas (75 solicitudes + 1.994 regeneraciones),
iguales a los KPIs del análisis. 0 errores de consola.
