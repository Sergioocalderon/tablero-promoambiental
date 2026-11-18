---
name: orquestar
description: Coordina los agentes del proyecto (lector-proyecto, auditor-geotab, programador, revisor-addin) para un cambio de varios pasos: explorar, consultar Geotab, programar, revisar y entregar. Usar cuando el usuario diga "orquesta", "usa los agentes", "hazlo con los agentes" o pida un cambio grande que cruce varios archivos o necesite datos de Geotab antes de programar.
---

# Orquestar los agentes del proyecto

Los agentes arrancan sin contexto y cuestan tokens. Orquesta solo cuando el trabajo lo justifica:
cambio en varios archivos, exploración amplia o consulta pesada a Geotab. Un ajuste de pocas líneas
en un archivo que ya conoces: hazlo tú directo y no lances agentes.

| Agente | Modelo | Para qué | Puede escribir |
|---|---|---|---|
| `lector-proyecto` | haiku | Ubicar archivos, llamadores y cómo funciona algo | No |
| `auditor-geotab` | sonnet | Consultas/estudios de Geotab, solo lectura | Solo en scratchpad |
| `programador` | sonnet | Implementar el cambio ya decidido | Sí (código del repo) |
| `revisor-addin` | sonnet | Revisar add-in/extensión antes de entregar | No |

## Flujo

### 1. Entender y decidir
- Lee el pedido. Si hay una decisión que es del usuario (criterio, umbral, alcance), pregúntala ANTES
  de lanzar nada. Lo demás, decídelo tú.

### 2. Explorar (en paralelo si aplica)
- `lector-proyecto`: qué archivos, funciones y llamadores toca el cambio; si la lógica está duplicada
  (app.py / telegram_alertas.py / geotab_reglas_v3.py).
- `auditor-geotab`: solo si el cambio depende de datos reales (qué diagnóstico reporta, cuántos
  vehículos, qué valores salen). Pide período, filtros y conclusión con cifras.
- Si ninguno de los dos hace falta, sáltate este paso.
- Lanza los dos en el mismo mensaje cuando no dependan uno del otro.

### 3. Plan corto al usuario
- Solo si el cambio es grande, toca algo visible para otros (add-in montado, bot) o requiere escribir
  en Geotab: 3-6 líneas con qué se hará y qué no. Espera su OK si hay escritura en Geotab.

### 4. Programar
Lanza `programador` con un encargo autocontenido (no ve esta conversación):
```
Objetivo: <qué debe quedar funcionando, en una frase>
Contexto: <lo que encontraron lector/auditor: archivos ruta:línea, datos clave>
Alcance: <qué tocar y qué NO tocar>
Criterio de aceptación: <cómo sabemos que quedó bien>
Prueba: <qué ejecutar o qué autochequeo dejar>
Si es add-in/extensión: subir versión X -> Y y changelog <slug>.
```
- Cambios independientes en archivos distintos: puedes lanzar varios `programador` en paralelo.
  Mismo archivo: siempre en serie.

### 5. Revisar
- Si tocó un add-in (`_build_*`) o la extensión: lanza `revisor-addin` con la carpeta (y el zip si existe).
- Si responde `FALTA`: devuelve al `programador` solo los puntos ✘. Máximo 2 vueltas; si sigue fallando,
  arréglalo tú o explícale al usuario qué queda.
- Revisa tú el diff (`git diff --stat` y lo esencial): los agentes reportan, tú verificas.

### 6. Lo que hace SOLO el agente principal (nunca un subagente)
- Escribir en Geotab: respaldo en `backups_reglas/` + OK explícito del usuario + volver a leer para confirmar.
- Trello: no mover ni comentar tarjetas sin que lo pida.
- Copiar zips a `C:\Users\sergio.calderon\Downloads` y dar la ruta; en add-in NUEVO, pegar el config.json en el chat.
- Commit/push: solo si el usuario lo pide.

### 7. Informe final al usuario (en español)
- Qué quedó hecho y dónde (rutas), cómo se probó y el resultado real.
- Qué agentes se usaron, en una línea.
- Lo que no se hizo o el riesgo pendiente, en 1-2 líneas.
