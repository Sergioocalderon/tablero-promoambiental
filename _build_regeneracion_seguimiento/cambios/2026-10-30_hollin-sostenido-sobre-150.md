# Seguimiento de Regeneraciones DPF v1.11 — hollín sostenido sobre 150 %

**Caso 1148-NWW623 (30/10/2026):** el expediente decía "Hollín actual 26 %" y la gráfica terminaba en 166 %.

## Qué pasó en los datos
- 01:32:25 el hollín marcó 26 % (fin de una regeneración automática) y 2 s después 174 %.
- Siguió en 165-174 % durante 30 min (10 lecturas), la lámpara DPF volvió a encenderse y la regeneración se reinició a las 01:55.
- El motor se apagó a las 02:03.

## Error
`ultimoHollinValido` descartaba SIEMPRE toda lectura >= 150 % como ruido, aunque se repitiera. La tarjeta tomaba entonces la última lectura < 150 (la de 26 %, vieja) y la gráfica sí dibujaba la real.

## Cambio
- Una lectura >= 150 % solo se descarta si está **aislada** (la lectura anterior no era alta). Si se repite en lecturas seguidas se toma como real.
- Afecta a la pieza común `logica_1_hollin.js`, por lo que Análisis y Reportes la tendrán la próxima vez que se regeneren.
- Texto de la ayuda actualizado.
