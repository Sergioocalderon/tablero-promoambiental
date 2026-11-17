# Rediseño de la pantalla: "centro de control" oscuro

**Fecha:** 2026-10-28
**Versión:** 1.15 → 1.16
**Archivos:** `alertasFallas.js`, `config.json`, `AlertasPorSeveridad_addin.zip`

## Qué cambió (solo presentación; la lógica de datos, filtros y alarma no se tocó)

- **Tema oscuro** (`D`, `ESTILO_NIVEL`) basado en el boceto del usuario. Tailwind y FontAwesome por CDN
  no se usan: todo es CSSOM con iconos SVG propios (`ICONOS`), porque Geotab elimina los `<style>`.
- **Encabezado:** título, hora de la última carga ("Actualizado 3:36 a. m. · cada 5 min") y campana.
  La campana muestra un punto rojo mientras haya códigos nuevos sin ver; un clic los marca
  (cierra el banner y detiene la repetición del sonido).
- **Tarjetas KPI:** ALTA (clicable: filtra por criticidad), MEDIA/BAJA y **Códigos activos** con barra
  de reparto por nivel. Debajo, "Sistemas más afectados" (chips que filtran por sistema).
- **Barra de control unificada:** rango de fechas (botón con ventana flotante y validación), búsqueda con icono,
  ciudad / criticidad / turno / sistema (el borde se pone verde cuando hay filtro), Limpiar, Excel de
  tripulaciones (punto verde/naranja según haya archivo) y Actualizar (gira mientras carga).
- **Tabla "mapa de calor":** fila tintada y con borde izquierdo según nivel, pastillas por nivel, código en azul
  monoespaciado, descripción coloreada por nivel, cabecera fija, **acciones tenues que se encienden al pasar el
  cursor** (buscar causa, historial, expediente). Columnas de ancho fijo: las tarjetas por vehículo quedan
  alineadas entre sí; en pantallas angostas la tabla se desplaza en horizontal dentro de su tarjeta.
- **Vista:** "Por vehículo" / "Más recientes primero" como control segmentado; **se recuerda la última elegida**
  (`alertasFallas_vista`). El valor por defecto sigue siendo "Por vehículo".
- **Pie de la tabla:** aviso de fallas de conectividad ocultas y estado del archivo de tripulaciones
  (antes eran un banner verde y un panel aparte).
- Una falla = una sola función de fila (`construirFilaFalla`), compartida por las dos vistas; antes estaba duplicada.
- Clic en la placa (vista cronológica) filtra por ese vehículo, con chip para quitar el filtro.

## Decisiones respecto al boceto

- **La tarjeta "Tiempos de aviso y cierre — 92 % en meta" NO se incluyó.** Ese dato no existe en ningún sistema
  conectado y mostrarlo sería inventar una métrica en una herramienta usada para decisiones reales. Se reemplazó por
  "Códigos activos" con el reparto por nivel, que sale de los datos de la carga.
- Se omitieron los iconos decorativos de ayuda y usuario (sin función).
- La columna **Conductor** se conserva aunque el boceto no la traía (usa el Excel de tripulaciones).
- La pastilla "Activo" ya no sale en cada fila (siempre era "Activo"); solo aparece si una falla no está activa.
- La descripción de sistemas críticos (ABS, neumáticos, postratamiento, motor) sigue resaltándose, ahora en negrita
  y ya no todo en mayúsculas.
- Expedientes descargables (mini y consolidado): sin cambios, HTML claro. Sus botones ahora restauran el icono
  al terminar (`marcarOcupado`).

## Verificación

Chromium con una API de Geotab simulada (7 vehículos, 16 fallas, 2 de conectividad): KPI 2 ALTA / 5 MEDIA-BAJA /
14 códigos; filtros por KPI, búsqueda, ciudad y vehículo; historial desplegable; ventana de fechas con validación;
banner y campana con un código nuevo; 0 errores de consola. **No probado dentro de MyGeotab.**
