# 2026-11-17 · v1.14 · "Copiar reporte general" con los mismos grupos del panel

**Problema:** desde v1.13 el panel muestra un veredicto por vehículo (Llamar ya / Revisar / Esperar), pero el
texto de "Copiar reporte general" (`mensajeCiudad`) seguía con las secciones viejas (Regenerar ya / En
regeneración / Próximos): un vehículo con lámpara encendida y regenerando salía dos veces y con estados distintos
(caso 3094-GVT509).

**Cambio:** `mensajeCiudad` usa `listaAtencion`/`accionDe`, igual que el panel. Por ciudad:
🔴 📞 LLAMAR YA, 🟠 🔧 REVISAR EL VEHÍCULO, 🔵 ⏳ ESPERAR Y VOLVER A MIRAR y 🟡 PRÓXIMOS. Cada vehículo
sale una vez: hollín (con su cambio), situación (lámpara y/o regeneración) y en la línea de abajo qué hacer.
Se borraron `listaYa` y `listaRegeneracion`, que ya no se usaban.

**Prueba:** se renderizó el `.js` construido en Chrome headless con los datos de ejemplo de la vista de v1.13 y
se imprimió el texto copiado: 3094-GVT509 sale una sola vez, en REVISAR, con lámpara y regeneración en la misma
línea. Sintaxis OK (`node --check`).
