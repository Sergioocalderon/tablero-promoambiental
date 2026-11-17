# Seguimiento de Regeneraciones DPF v1.13 — un veredicto por vehículo, agrupado por acción

**Fecha:** 2026-11-13
**Versión:** 1.13 (antes 1.12)
**Archivos:** `seguimientoRegeneracion.parte.js`, `config.json`

## Por qué
Un mismo vehículo (caso 3094-GVT509) salía en "Regenerar ya" y en "En regeneración ahora", con dos estados distintos
("Manual en curso" y "Validar el sistema"). Quien hacía el seguimiento tenía que cruzar dos tablas para saber qué hacer.

## Qué cambió
- Las dos tablas se funden en **una fila por vehículo** y tres grupos por acción:
  - **Llamar ya**: hay que contactar al conductor o escalar (lámpara en AVISAR/ESCALADO, o la regeneración pide la manual).
  - **Revisar el vehículo**: la manual no bajó el hollín, regeneración prolongada o lámpara con el interruptor activado sin apagarse (taller).
  - **Esperar y volver a mirar**: regenerando o lámpara recién encendida; no pide acción aún.
- Columnas: Vehículo, Ciudad, Qué hacer (pastilla + frase de acción), Situación (lámpara y regeneración en dos líneas), Hollín, Acción.
  Se quitan Marca, Horas totales, Interruptor, Tipo, Bajó y Última lectura como columnas sueltas (los datos pasan a "Situación").
- Hollín con tendencia en color: sube = rojo, baja = verde ("▲ subió 89 pts").
- Los grupos vacíos no se muestran. El filtro de estado ahora es: Llamar ya / Revisar / Esperar / Próximos.
  El desplegable de bases cuenta "llamar · revisar · esperar · próximos".
- "Próximos al umbral" no cambia.

## Prioridad de las reglas (`accionDe`)
1. La regeneración pide llamar, o la lámpara está en AVISAR/ESCALADO → Llamar ya.
2. Regeneración en VALIDAR/ATENCIÓN/PROLONGADA, o lámpara en TALLER → Revisar.
3. Lo demás → Esperar (con el testigo mudo manda la lámpara, si la hay).
Los umbrales y textos de cada estado no cambian: salen de la misma lógica de antes.

## No cambió
- El texto de "Copiar reporte general" (WhatsApp) sigue con las secciones antiguas; un vehículo puede salir en dos de ellas.
- El expediente, las alertas y las reglas de umbral.
