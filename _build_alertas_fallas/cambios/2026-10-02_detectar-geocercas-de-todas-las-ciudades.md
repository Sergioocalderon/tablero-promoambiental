# Fix: solo se reconocían geocercas de Bogotá, ignorando las de otras 13 ciudades

## Contexto

El usuario reportó: "tenemos un error -- si tenemos geocercas en ciertas
ciudades aprovecha las que sí están, las que no, notifica que no se han
configurado todavía."

## Investigación contra la cuenta real (2026-10-02)

`obtenerZonasLocalidad()` tenía hardcodeado `PREFIJO_ZONA_LOCALIDAD = 'bogota-'`
-- cualquier geocerca que no empezara exactamente con ese texto se ignoraba
por completo. Se consultó `api.get('Zone')` contra la cuenta real para ver
qué otras geocercas existen con el mismo patrón "CIUDAD-LOCALIDAD":

| Ciudad/municipio | Geocercas |
|---|---|
| Cartagena | 211 |
| Fusagasugá | 65 |
| Flandes | 47 |
| Girardot | 45 |
| Espinal | 42 |
| Melgar | 32 |
| Bogotá | 29 |
| Cali | 22 |
| Ricaurte | 16 |
| Tocaima | 15 |
| Valle | 15 |
| Agua de Dios | 12 |
| Guamo | 11 |
| Arbeláez | 6 |
| Zipaquirá | 1 |

Todas ignoradas excepto Bogotá. También hay nombres de zona con guión que
NO son ciudades (ruido): "TERMINAL DEL SUR" (2), "CORREDOR LA CEJA" (3),
"TERMINAL" (3), "DIVEMOTOR" (1), "BASE" (1), "5 CA" (1) -- máximo 3.

## Fix

Se quitó el prefijo fijo. Ahora `obtenerZonasLocalidad()` agrupa TODAS las
geocercas por el texto antes del primer guión, y reconoce como "ciudad con
localidades" cualquier grupo con `UMBRAL_ZONAS_CIUDAD = 4` geocercas o más
-- umbral elegido porque separa limpio lo real (mínimo 6, Arbeláez) del
ruido (máximo 3). Es un descubrimiento dinámico, no una lista fija: si
alguien configura geocercas para una ciudad nueva en Geotab más adelante,
el código las reconoce solo con que haya 4 o más, sin tocar código de
nuevo.

También se agregó la distinción pedida explícitamente: el campo "Dónde"
ahora dice **"Esta ciudad todavía no tiene geocercas de localidad
configuradas en Geotab"** cuando la ciudad del caso (comparada contra las
ciudades descubiertas) no tiene NINGUNA geocerca -- en vez del genérico
"Localidad no determinada" que no distinguía esto de un punto suelto que
simplemente cayó fuera de una geocerca que sí existe.

## Verificación

- Consulta real contra `api.get('Zone')` (vía `herramientas/geotab_comun.py`,
  script puntual, borrado al terminar) -- confirmó las 14 ciudades/municipios
  con geocercas y los 6 nombres de ruido.
- Balance de paréntesis/llaves/corchetes: mismo desbalance preexistente ya
  documentado, sin cambios nuevos.
- `AlertasPorSeveridad_addin.zip` regenerado y copiado a Descargas:
  `config.json` (v1.8) + `alertasFallas.html` + `alertasFallas.js`.

## Pendiente

Probar con un caso real de Cali, Cartagena u otra de las ciudades recién
reconocidas para confirmar que ahora sí muestra la localidad y el polígono
correctos.
