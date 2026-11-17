---
name: nuevo-addin
description: Crea de una vez el esqueleto completo de un add-in nuevo de MyGeotab (carpeta _build_*, config.json con la plantilla del proyecto, html, js, registro de cambios, zip) y lo copia a Descargas. Usar SIEMPRE que se vaya a crear un add-in nuevo de MyGeotab/Copiloto, aunque el usuario solo diga "hagamos un add-in de X".
---

# Nuevo add-in de MyGeotab

Cada add-in vive en su carpeta `_build_<slug>/` y se sube a MyGeotab/Copiloto como un zip
**plano** (sin carpeta contenedora) con `config.json` + `.html` + `.js`. Antes de escribir
código, genera siempre este esqueleto; después se llena con la lógica.

## Paso 0 — Definir nombres (preguntar solo lo que falte)

| Dato | Ejemplo |
|---|---|
| Nombre visible (`name` y `menuName.en`) | `Validación de Baterías` |
| Slug de carpeta | `_build_baterias` |
| Archivo base (camelCase) | `validacionBaterias` → `.html`, `.js`, global `geotab.addin.validacionBaterias` |
| Id del contenedor | `validacionBateriasRoot` |
| `path` del menú | `ActivityLink/` (valor por defecto) |
| Zip de salida | `ValidacionBaterias_addin.zip` |

## Paso 1 — `config.json` (plantilla del proyecto, no cambiar la estructura)

```json
{
    "name": "<nombre visible>",
    "supportEmail": "sergio.calderon@promoambientaldistrito.com",
    "version": "1.0",
    "items": [
        {
            "url": "<archivoBase>.html",
            "path": "ActivityLink/",
            "menuName": {
                "en": "<nombre visible>"
            }
        }
    ]
}
```

- `version` empieza en `"1.0"` y se sube en cada cambio real posterior (trazabilidad de qué build está montado).
- La plantilla NO trae `"enableViewSecurityId": true`. Los add-ins recientes (regeneración DPF, baterías) sí lo llevan, para que solo lo vean los perfiles marcados (la base de Geotab se comparte con otras cuentas). **No lo agregues por tu cuenta: pregúntalo al terminar** ("¿lo restrinjo por perfil?").

## Paso 2 — `<archivoBase>.html`

Geotab elimina las etiquetas `<style>`: todo el estilo se aplica por JS (CSSOM).

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <!-- Geotab elimina las etiquetas <style>: todo el estilo se aplica por JS (CSSOM) en <archivoBase>.js -->
  <!-- Solo si hay gráficos: <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script> -->
</head>
<body>
  <div id="<archivoBase>Root"></div>
  <script src="<archivoBase>.js"></script>
</body>
</html>
```

## Paso 3 — `<archivoBase>.js` (esqueleto)

```js
geotab.addin.<archivoBase> = function () {
  'use strict';
  var api = null, state = null;
  // ... lógica y pantalla ...
  return {
    initialize: function (freshApi, freshState, initializedCallback) {
      api = freshApi; state = freshState;
      var raiz = document.getElementById('<archivoBase>Root');
      // construir la pantalla con aplicarEstilo()/crear() (CSSOM)
      initializedCallback();      // llamar pronto; la carga de datos va aparte
    },
    focus: function (freshApi, freshState) { api = freshApi; state = freshState; },
    blur: function () {}
  };
};
```

Reutiliza en vez de reescribir:
- **Kit de diseño** (paleta, `crear`, `crearPanel`, `crearSelect`, `crearTabla`, KPI, CSV, copiar): `_build_regeneracion_comun/ui.js`.
- **Capa de datos** (`apiCall` con tope de espera, `describirError`, alcance de vehículos, ciudad/marca por grupos, `StatusData` por tramos con partición al tocar el tope de 50.000 filas): `_build_baterias/datos.js` y `_build_regeneracion_comun/datos.js`.
- Si el add-in tiene lógica no trivial, sepárala en piezas (`logica.js`, `datos.js`, `<archivoBase>.parte.js`) y arma el `.js` con un ensamblador Python como `herramientas/construir_addin_baterias.py` (los `.js`/`.html` pasan a ser archivos generados).

Reglas del proyecto que aplican a todo add-in:
- **Mide antes de consultar `StatusData`**: la densidad real de cada diagnóstico (el RPM de alta resolución llena 50.000 filas en 18 h de un solo vehículo); no asumas.
- **Acota por el grupo `*Promoambiental`** y vehículos activos (la base se comparte con otras cuentas).
- **Muestra siempre la fuente y la antigüedad del dato**; un valor viejo no se presenta como estado actual (lección del caso 1226).
- **No inventes datos que ningún sistema tiene** (p. ej. "tiempo fuera de servicio"); un cálculo estimado se etiqueta como estimado.
- Criticidad en 4 niveles (Crítico, Alto, Medio, Bajo) cuando aplique; cross-filtering desde la misma caché de datos, nunca consultas nuevas por cambiar un filtro.
- Sin credenciales en el código: el add-in usa la sesión de quien lo abre.

## Paso 4 — Registro de cambios

Crear `_build_<slug>/cambios/YYYY-MM-DD_creacion-addin-<slug>.md` con: título y versión, fecha, archivos, origen/problema, qué hace, criterios (con su origen medido), qué se probó y **qué NO** (p. ej. "no probado dentro de MyGeotab"), y límites. Cada cambio posterior lleva su propio archivo en esa carpeta.

## Paso 5 — Pruebas (no hay suite; no hay Node en este equipo)

- Lógica pura: probarla en Chrome headless (`C:\Program Files\Google\Chrome\Application\chrome.exe --headless=new --dump-dom <pagina.html>`), con la lógica y datos reales incrustados, y compararla contra la salida de Python cuando sea un puerto.
- Pantalla: página de prueba con `api.call` simulado que sirva datos reales; revisar 0 errores de consola y capturar con `--screenshot`. Usar un bloque `<script>` aparte por cada parte (un error de sintaxis en un bloque invalida todo el bloque).
- Los scripts de prueba van a la carpeta scratchpad, no al repo.

## Paso 6 — Zip y entrega

- Zip plano con `zipfile` de Python (`config.json`, `<archivoBase>.html`, `<archivoBase>.js`); en Git Bash no hay `zip`.
- Copiarlo a la raíz del repo **y a `C:\Users\sergio.calderon\Downloads`** (siempre), y decir la ruta completa.
- No hacer commit ni push sin que lo pida (el repo `tablero-promoambiental` es público); los zips y `_build_*` nuevos quedan sin commit hasta entonces.
- En el chat, dar el `config.json` **ya diligenciado** (el mismo del zip, en bloque de código) para pegarlo en MyGeotab al montar un add-in NUEVO. En actualizaciones de un add-in ya montado no hace falta.

## Paso 7 — Cierre

Guardar una memoria `proyecto_addin_<slug>` (criterios medidos, hallazgos, pendientes) y su línea en `MEMORY.md`. En el mensaje final: qué hace, dónde está el zip, qué se probó y qué no, y la pregunta pendiente sobre `enableViewSecurityId`.
