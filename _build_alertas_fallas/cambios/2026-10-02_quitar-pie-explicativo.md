# Quitar el pie explicativo del Mini Expediente

## Contexto

Pedido explícito del usuario: el bloque de pie de página con las notas de
metodología (cómo se resuelve la ubicación, cómo se identifica el
conductor/turno) no es necesario para una alerta rápida.

## Qué se quitó

Los 2 párrafos explicativos del `<footer>` en `reporte_expediente_plantilla.html`.
Se dejó solo "Generado {{GENERADO}}" -- metadato mínimo útil, sin el resto
de la explicación. También se quitó el CSS `footer p` que ya no aplica a
nada.

## Verificación

- `PLANTILLA_EXPEDIENTE_EMBEBIDA` re-incrustada, byte a byte igual al HTML
  fuente (3918 caracteres).
- Balance de paréntesis/llaves/corchetes: mismo desbalance preexistente ya
  documentado, sin cambios nuevos.
- `AlertasPorSeveridad_addin.zip` regenerado y copiado a Descargas:
  `config.json` (v1.7) + `alertasFallas.html` + `alertasFallas.js`.
