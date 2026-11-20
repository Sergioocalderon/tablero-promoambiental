# v1.24 — Fallas intermitentes y testigos del tablero

**Problema (caso 1157-NWX533):** el SPN 157/FMI 18 pulsaba Active→None en segundos y el add-in no lo mostraba, porque solo tomaba el último registro si era 'Active'. Lo único que se veía eran los testigos 168/175, y salían como "SPN 175/FMI ? · Eléctrico", que parece batería o temperatura de aceite.

**Cambio:**
- Si el último registro de un código es inactivo pero tuvo un registro 'Active' en las últimas 24 h, ahora se muestra con la pastilla **Intermitente**. Se usan la fecha y las luces de ese último 'Active', así que cuenta como confirmado.
- Los diagnósticos de luces del tablero (IDs de testigo de Geotab, o nombre "luz de advertencia") salen con la categoría **Testigo del tablero** y el código "Testigo", sin SPN/FMI. Esto aplica en la tabla, en el caso y en el Expediente consolidado.
