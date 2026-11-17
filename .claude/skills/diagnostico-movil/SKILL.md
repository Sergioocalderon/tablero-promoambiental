---
name: diagnostico-movil
description: Consulta y explica los códigos de falla de UN móvil de la flota (p. ej. "qué códigos tiene el 1164", "fallas del 1123", "diagnóstico del móvil X") leyendo Geotab y clasificándolos con los criterios del proyecto (confirmada vs por verificar, motor vs testigo vs equipo Geotab, FMI 0). Usar siempre que pidan los códigos o fallas actuales de un vehículo concreto.
---

# Diagnóstico de fallas de un móvil

Herramienta: `python .claude/skills/diagnostico-movil/consultar_fallas.py <móvil> [--dias N] [--todas] [--json]`
(solo lee de Geotab; usa las credenciales de `herramientas/geotab_comun.py`). Se ejecuta desde la raíz del repo.

## Cómo responder

1. **Contesta primero la pregunta directa**, en una línea: "¿tiene códigos de falla del motor?" → sí/no y cuántos. Un listado largo antes de la respuesta confunde (caso 1164: la pregunta real era "¿tiene o no tiene?").
2. Luego la tabla por categoría, con SPN/FMI, descripción en español, criticidad, antigüedad del último reporte y si está **Confirmada** o **Por verificar**.
3. Cierra con la lectura: qué es accionable (confirmadas del motor) y qué no (avisos del equipo, por verificar).

## Criterios (todos salen de casos reales; no los relajes)

- **"Active" en Geotab = último estado recibido, NO que la falla siga presente** (caso 1226-FXW563: un único registro de hace 11 días figuraba "activa"). Corte de **24 h**: activa y reportada en las últimas 24 h = *Confirmada*; activa pero más vieja = *Por verificar* ("probablemente ya no está activa"). Mismo corte que el bot de Telegram y el add-in Alertas por Severidad.
- **Cuatro categorías distintas** (el script las separa):
  - *Motor/vehículo*: SPN/FMI reales (J1939). Es lo que se entrega al taller.
  - *Sin clasificar*: `**Unknown Diagnostic NNNNN` — código del fabricante que Geotab no describe ni el `Diccionario_Fallas.csv` conoce. Se reporta con su número y se propone añadirlo al diccionario; no se inventa su significado.
  - *Testigo del tablero*: diagnósticos "luz de advertencia del vehículo / de baja prioridad encendida". Geotab les da los códigos 168 y 175 y **no traen FMI**; **no son el SPN 168 (voltaje de batería) ni el SPN 175 (temperatura de aceite)**. Nunca los presentes como fallas eléctricas (así los muestra hoy, mal, la tarjeta del Sistema Copiloto: "Eléctrico · SPN 168/FMI ?").
  - *Equipo Geotab*: caídas de energía, desconexión, reinicios, firmware, calibración/desactivación del acelerómetro, exceso de eventos duros. **Son fallas del dispositivo, no del vehículo**; decirlo así. Muchas caídas de energía repetidas apuntan a alimentación/cableado del equipo (casos 1164 y 1162), causa sin confirmar.
- **El FMI 0 es un código válido** (dato sobre el rango normal, el nivel más severo). Nunca mostrarlo como "FMI ?" ni tratarlo como vacío (`valor or '?'` lo pierde). Si un conteo de "activaciones" da 0 con un código FMI 0 activo, sospecha de ese bug.
- **Criticidad** (misma regla que `telegram_alertas.py` y `app.py`): luz roja o de protección → ALTA; luz ámbar → MEDIA; solo testigo general o ninguna luz → BAJA.
- La descripción sale de `Diccionario_Fallas.csv` (lookup manual por SPN/FMI, independiente del nombre de Geotab, que puede discrepar); si no está, del nombre de Geotab.

## Qué NO afirmar

- No digas "el vehículo está parado/en riesgo" a partir de un código; di lo que Geotab reporta y cuándo.
- No digas que una falla "sigue activa" si es *Por verificar*.
- Una falla del motor sin luces (MIL aparte) puede ser histórica; la criticidad solo sube con luces.
- La tarjeta "Decisión requerida" del Sistema Copiloto no está en este repo: no prometas cambiar su texto desde aquí.

## Si piden más

- Informe en PDF del móvil: usa la skill `pdf` con los datos de `--json`, en español, y deja el archivo en `C:\Users\sergio.calderon\Downloads` (diciendo la ruta).
- Voltaje/baterías del mismo móvil: lógica del add-in Validación de Baterías (`_build_baterias/logica.js`); ver la memoria `proyecto_addin_validacion_baterias`.
- Códigos nuevos sin clasificar que aparezcan seguido: proponer su fila para `Diccionario_Fallas.csv` (Tipo_Codigo, SPN, FMI, Descripcion, Grupo, Criticidad, Origen_Criticidad, Motor_Aplica).
- Todo en español.
