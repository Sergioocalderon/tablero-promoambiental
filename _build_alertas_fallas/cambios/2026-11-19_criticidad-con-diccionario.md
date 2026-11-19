# 2026-11-19 · v1.22 · Criticidad con el diccionario de fallas

**Problema:** la criticidad salía solo de las luces que Geotab manda con la falla (roja/protección = ALTA, ámbar = MEDIA,
cualquier otra = BAJA). Muchas fallas de motor llegan solo con la luz de check engine (MIL) y quedaban BAJA, sin alarma
sonora, aunque `Diccionario_Fallas.csv` las tenga como MEDIA o ALTA.
Caso: 1157-NWX533, SPN 157 / FMI 18 (baja presión del riel de combustible, 19 registros en 3 días) se mostraba BAJA.

**Cambio:** criticidad final = la mayor entre la de las luces y la del diccionario. El diccionario solo sube, nunca baja.
- Se lee de GitHub: `https://raw.githubusercontent.com/Sergioocalderon/tablero-promoambiental/main/Diccionario_Fallas.csv`
  (una vez por sesión; si falla se sigue solo con luces y se reintenta en el siguiente refresco).
- Fila de la marca del vehículo (Motor_Aplica = grupo de marca) o de su motor (ej. X12) si existe; si no, la `Generico`.
- Solo filas `Tipo_Codigo = SPN` (las SID/PID son J1587).
- Mismo criterio en el bot de Telegram (`criticidad_diccionario` en `telegram_alertas.py`).

**Impacto medido (Bogotá, 19/11 01:30):** de 58 fallas activas confirmadas suben 7 (5 BAJA→MEDIA, 2 MEDIA→ALTA),
entre ellas 1157 SPN 157/18 y 1158 SPN 111/18 (nivel de refrigerante).

**También en v1.22:** el nombre del vehículo en la tabla de códigos ya no se fuerza en una sola línea (`whiteSpace: nowrap`):
los nombres largos (ej. "1148-NWW623 - NWW623-1148") se salían de la columna de 170 px y tapaban la etiqueta de Nivel.
Ahora bajan a una segunda línea.
