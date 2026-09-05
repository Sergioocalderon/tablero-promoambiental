---
name: validar-regla
description: Valida una regla custom de Geotab (lógica de la condición, alcance real de vehículos, eventos disparados, y si el diagnóstico que usa realmente reporta datos) para detectar reglas rotas, mal calibradas o con huecos de cobertura antes de conectarlas a una alerta. Usar cuando el usuario pida validar, revisar, analizar o diagnosticar una regla de Geotab por nombre.
---

# Validar una regla de Geotab

Metodología usada varias veces en este proyecto (reglas de nivel de DEF, indicador de
agua en el combustible, temperatura de motor, salida de taller) para confirmar si una
regla realmente funciona como dice su nombre/comentario, antes de tocarla o de
conectarla a `telegram_alertas.py`.

Requiere `herramientas/geotab_comun.py` (conexión, `buscar_regla`,
`obtener_arbol_grupos`, `resolver_vehiculos_en_alcance`) en el entorno.

## Paso 0 — Confirmar alcance de la validación

Si el usuario no dio nombre exacto, pedirlo o buscar coincidencias parciales con
`buscar_regla` (devuelve `(regla, parecidas)` — si no hay match exacto, mostrar las
parecidas y preguntar cuál). Confirmar también la ventana de tiempo a revisar (por
defecto 30-60 días; usar más si la regla es de baja frecuencia).

## Paso 1 — Lógica cruda de la condición

Traer la regla completa y volcar el árbol de `condition` tal cual lo da la API (no
resumir de memoria): `conditionType`, `value`/`unit`, `diagnostic.id`, `zone.id`,
`rule.id` de cada nodo, recursivamente por `children`. Comparar esa lógica contra lo
que dice el `comment` de la regla — si no coinciden, ya es una pista de bug.

```python
import geotab_comun as gc, json
api = gc.conectar_geotab()
regla, parecidas = gc.buscar_regla(api, "<NOMBRE EXACTO>")
print(json.dumps(regla.get('condition'), indent=2, default=str))
print(regla.get('comment'))
```

## Paso 2 — Alcance real de vehículos

Usar `gc.resolver_vehiculos_en_alcance(devices, regla, grupos_por_id, padre_de)` —
NUNCA asumir el alcance por el nombre de la regla. Si el nombre lista marcas/motores
específicos, listar los vehículos resueltos y confirmar que la marca/motor de cada uno
coincide. Si el alcance es sospechosamente amplio (`*Promoambiental`) o angosto (unos
pocos vehículos) respecto a lo que sugiere el nombre, anotarlo.

Para un chequeo rápido de alcance + eventos ya armado, `herramientas/analisis_ralenti.py
diagnosticar-regla --regla "<nombre>" --dias N` hace los pasos 1 (parcial) y 2 y 3
juntos.

## Paso 3 — Eventos reales disparados

`ExceptionEvent` filtrado por `ruleSearch.id` en la ventana elegida. Si da 0 eventos
pese a tener vehículos en alcance y activeFrom antiguo, es la señal más fuerte de que
algo está roto — no asumir que "simplemente no ha pasado", ir al paso 4.

## Paso 4 — El diagnóstico ¿realmente reporta datos?

Para cada `diagnostic.id` usado en la condición: traer `StatusData` en la misma
ventana, **filtrado a los vehículos del alcance real** (no toda la flota — un
diagnóstico que reporta en otros vehículos pero no en los del alcance es igual de
inútil para esta regla). Revisar:

- **¿Hay muestras?** Cero muestras en los vehículos del alcance = la regla nunca va
  a disparar sin importar el umbral. Antes de concluir "hardware roto", buscar si
  existe OTRO diagnóstico con el MISMO NOMBRE pero ID distinto — Geotab puede tener
  duplicados (uno viejo sin datos, uno vigente con datos) y la regla puede estar
  apuntando al que no sirve. `api.get('Diagnostic')` y filtrar por nombre.
- **¿Qué rango de valores toma?** Comparar min/max/valores distintos contra el
  umbral de la condición. Si el diagnóstico es binario (valores solo 0/1) y la
  condición pide `IsValueMoreThan(value=1)`, es matemáticamente imposible — el
  umbral correcto ahí es `value=0`. Este bug exacto ya apareció una vez.
- **¿Todos los vehículos del alcance reportan, o solo algunos?** Si 4 de 5 no
  tienen ni una muestra, es un hueco de cobertura de hardware/instalación en esos
  vehículos específicos, no un problema de la regla — decirlo así, no mezclarlo.

## Paso 5 — Alcance vs. nombre (opcional, si el nombre lista modelos/motores)

`herramientas/barrido_grupos_reglas.py` audita esto para todas las reglas
custom de una — pero tiene una limitación conocida: su diccionario de motores solo
reconoce L9/X12/OM926/ISF3.8/ISM11, así que cualquier regla cuyo nombre incluya
modelos por nombre propio (T800, T380, NHR, N400) va a marcar "sobrantes" falsos
(vehículos de esos modelos que en realidad SÍ pertenecen ahí). Si sale con
`faltantes=0`, está bien aunque muestre sobrantes; si sale con `faltantes>0`,
investigar si esos vehículos deberían estar y no están.

## Reportar

Resumen en español, directo, con esta forma:
1. Lógica: correcta / bug encontrado (cuál nodo, qué debería decir).
2. Alcance: cuántos vehículos, coincide o no con el nombre.
3. Eventos: cuántos en la ventana, si el conteo es creíble.
4. Diagnóstico: reporta o no en los vehículos del alcance, rango de valores.
5. Veredicto: la regla sirve tal cual / necesita este cambio puntual / hay un hueco
   de hardware que no se arregla por API.

**Nunca aplicar un cambio a la regla sin que el usuario lo confirme explícitamente.**
Si el usuario pide aplicar el fix, seguir el patrón ya establecido en el proyecto:
respaldar el JSON completo de la regla en `backups_reglas/` (mismo formato que usa
`geotab_reglas_v3.py`) antes de llamar a `api.set('Rule', regla)`, y volver a leer la
regla después para confirmar que quedó como se esperaba.
