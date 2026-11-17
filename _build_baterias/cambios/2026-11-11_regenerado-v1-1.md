# Validación de Baterías v1.1 — regenerado limpio

**Fecha:** 2026-11-11
**Archivos:** `config.json` (versión 1.0 → 1.1), `validacionBaterias.js`/`.html` regenerados con `herramientas/construir_addin_baterias.py`, zip.

**Motivo:** al montar el add-in en MyGeotab salía "Otro usuario editó la configuración del sistema" (error de MyGeotab al crear un add-in nuevo; no del código). Se regenera para entregar un paquete limpio y distinguir esta compilación de la 1.0. Se contrastó otra vez con el script original recibido (mismas constantes: ESR 15, caída 15 pts, carga −0,5 V, ventana 7 d, 3 d sin ESR).

**Criterios:** sin cambios. Se mantiene la decisión de NO usar el "ESR manual" por regresión (con ESR real < 30 detecta 0 de 43 casos; en 24 V no hay referencia). Ver `2026-11-09_creacion-addin-validacion-baterias.md`.

## Probado
- El JS y el HTML regenerados son **byte a byte idénticos** a los de v1.0 (solo cambia la versión del manifiesto); sintaxis válida.
- Prueba de lógica contra Python con los datos reales del 09-nov: 85 vehículos, 960 comparaciones, **0 discrepancias**.
- **No probado dentro de MyGeotab** (el guardado falló en la pantalla de creación; ver nota abajo).

## Montaje
Si MyGeotab no deja crear uno nuevo, reutilizar el espacio de un add-in propio que ya no se use (las actualizaciones sí guardan) y reemplazar su config y archivos por estos.
