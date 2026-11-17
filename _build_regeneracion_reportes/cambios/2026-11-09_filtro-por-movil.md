# Reportes de Regeneraciones DPF v1.1 — filtro por móvil

**Fecha:** 2026-11-09
**Versión:** 1.0 → 1.1
**Archivos:** `reportesRegeneracion.parte.js`, `config.json`, `ReportesRegeneracion_addin.zip` (el `.js` se regenera con `herramientas/construir_addins_regeneracion.py reportes`)

## Problema
Un usuario (Copiloto, `user.copiloto.app`) reportó que el add-in lista todas las empresas/ciudades pero **no permite filtrar por móvil**: solo se podía generar el reporte de una ciudad o de toda la flota.

## Cambio
- Nuevo selector **Vehículo (móvil)** bajo "Ciudad". Lista los vehículos del alcance de la regla de saturación DPF, ordenados por nombre y con la marca; al cambiar la ciudad se acota a los de esa ciudad y vuelve a "Todos los vehículos (N)". Se puede escribir el inicio del nombre (ej. `1167`) para saltar al vehículo.
- `calcular(desde, hasta, ciudad, vehiculoId)` filtra además por vehículo; consulta solo las señales de ese móvil (más rápido que una ciudad completa).
- Con un vehículo elegido: el título del reporte pasa a `<vehículo> (<ciudad>)`, el archivo a `Reporte_Regeneracion_<VEHICULO>_<desde>_<hasta>`, y los textos concuerdan en singular ("1 vehículo con DPF").
- Sin cambios en los criterios ni en los números: el reporte de un vehículo es exactamente su porción del de la ciudad.

## Probado (Chrome headless, API simulada con los dispositivos y grupos reales)
Selector con 85 vehículos en "Todas"; 33 al elegir Bogotá; al elegir 1167-NWY955 el reporte HTML sale con título "1167-NWY955 (Bogotá (Distrito))", 1 vehículo y archivo `Reporte_Regeneracion_1167_NWY955_2026-11-02_2026-11-09.html`; 0 errores de consola. Las señales se simularon vacías, así que no se probó el contenido de las regeneraciones (no cambió).
No probado dentro de MyGeotab/Copiloto.

## Pendiente
- Subir el zip de nuevo a la plataforma (reemplaza la v1.0).
- Si se quiere elegir varios móviles a la vez, hace falta un selector múltiple (hoy es uno o todos).
