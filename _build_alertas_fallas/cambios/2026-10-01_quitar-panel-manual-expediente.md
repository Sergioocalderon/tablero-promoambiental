# Quitar el panel de entrada manual del Mini Expediente

## Contexto

Al mover el Mini Expediente a este add-in se agregó, además del botón por
fila, un panel de entrada manual de respaldo (placa + fecha/hora) cerca del
encabezado, para casos que ya no aparecen como falla activa.

## Qué pidió el usuario

Mostró una captura de referencia (el mini expediente de WhatsApp del otro
proyecto "Telemetry") y pidió explícitamente que NO haya una barra arriba
para generar el expediente -- solo el botón que ya trae cada código de falla
en su fila.

## Qué se cambió

- `alertasFallas.js`: se quitó `construirPanelExpedienteManual` completa, su
  llamada en `initialize()`, y las dos funciones que quedaron huérfanas
  (`resolverCasoManual`, `resolverDispositivoPorTexto`) -- ninguna otra parte
  del archivo las usaba. El botón "📋 Generar expediente" por fila (en las
  vistas por vehículo y cronológica) sigue igual, es el único punto de
  entrada que queda.
- `AlertasPorSeveridad_addin.zip` regenerado.

## Verificación

- Balance de paréntesis/llaves/corchetes: OK.
- Sin referencias colgantes a las 3 funciones quitadas (confirmado con grep).
- Zip verificado con `zipfile`: exactamente `config.json` + `alertasFallas.html`
  + `alertasFallas.js`.

## Pendiente

La captura de referencia que mostró el usuario tiene un diseño distinto al
que ya tiene `reporte_expediente_plantilla.html` (mapa estático embebido en
vez de link, caja con descripción en lenguaje simple del FMI, jerarquía de
localidad "Incluida en: X"). No se tocó el diseño en esta tarea -- el pedido
fue específicamente sobre la barra de entrada manual, no sobre el layout del
expediente. Queda abierto si se quiere rediseñar la plantilla para acercarse
más a esa referencia.
