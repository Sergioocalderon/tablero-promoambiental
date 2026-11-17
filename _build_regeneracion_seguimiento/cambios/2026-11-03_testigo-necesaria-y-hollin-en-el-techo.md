# Seguimiento de Regeneraciones DPF v1.12 — testigo "necesaria", hollín en el techo y manuales sin efecto

Validado con 4 días de datos reales (30/10 al 3/11/2026) de toda la flota: 13 expedientes revisados, tarjeta y gráfica coinciden en todos.

## 1. Hollín pegado en el techo (caso 3804-GVU088)
- El vehículo marcaba **200 %** (tope del sensor) desde las 07:02 y el tablero lo mostraba "En curso — regenerando", porque la limpieza descarta toda lectura >= 199 % y quedaba como "último hollín" el de las 06:43 (191 %), ya viejo.
- Ahora, **2 o más lecturas seguidas >= 199 %** se toman como reales: "El hollín marca 200 %, el tope del sensor, desde HH:MM: el filtro está saturado o el sensor pegado" (estado Validar el sistema). La gráfica del expediente dibuja la meseta.
- Una lectura de techo aislada sigue siendo ruido. La detección de regeneraciones por caída de hollín no cambia.
- Pieza común: `hollinPegadoEnTecho` y `lecturasParaGrafica` en `_build_regeneracion_comun/logica_1_hollin.js`.

## 2. El testigo tiene dos valores activos: 1 y 2
- J1939 SPN 3700 (fuente secundaria, manual Danfoss PLUS+1): 0 = no activa, 1 = **activa**, 2 = **regeneración necesaria** (el motor la pide, no la ejecuta).
- Medido en la flota (4 días, pares de lecturas de hollín): con estado 1 baja >= 5 pts el 34 % de las veces (mediana -2); con estado 2 baja el 12 % y sube el 11 % (no baja). El estado pasa de 1 a 2 y de 2 a 1 con frecuencia (178 y 162 veces).
- El tablero contaba ambos como "regenerando". Ahora, si el último valor es 2, el estado se llama **Pendiente**: "El motor pide la regeneración (estado "necesaria") desde HH:MM pero no la está ejecutando: mientras tanto el hollín no baja."
- Los 4 vehículos con hollín >= 100 % ese día estaban en estado 2.
- La leyenda azul de la gráfica dice ahora "Regeneración activa o pedida (testigo)".

## 3. Manuales sin efecto
- Si ya se activó la manual **3 o más veces** y el hollín sigue alto (Validar/Atención), el consejo es "no insistir, llevar a revisión en taller" (caso 3096-GVT514: 29 activaciones, hollín en 180 %).
- Con la lámpara encendida, el expediente agrega ese consejo al mensaje principal (antes decía solo "esperando que la lámpara se apague").

## 4. Texto
- Hollín >= 150 %: "muy por encima de donde suele encenderse la lámpara (125 %)" en vez de "cerca de".
- Ayuda del tablero actualizada con estas reglas.

## Pendiente
- Análisis y Reportes (v1.0) tienen las piezas comunes nuevas al reconstruirlos, pero su comportamiento no cambia.
- Confirmar con el campo qué significa el estado 2 para los conductores (si el vehículo está parado o en ruta cuando pasa a "necesaria").
