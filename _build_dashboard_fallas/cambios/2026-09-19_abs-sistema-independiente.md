# "ABS" como sistema independiente (antes se colaba en Neumáticos/Eje)

**Fecha:** 2026-09-19
**Archivo:** `_build_dashboard_fallas/dashboardAnalisisFallas.js`
**Versión:** `config.json` 2.3 → 2.4

## Contexto

El usuario reportó: al consultar el sistema "Neumáticos", el drill-down
traía códigos de ABS -- para él, eso debería ser del sistema ABS, no de
Neumáticos.

## Causa raíz confirmada

La taxonomía (`SISTEMAS`) no tenía ninguna categoría "ABS". Los
diagnósticos de sensores de rueda ABS en Geotab se nombran por EJE físico
("Sensor de rueda ABS eje 1 derecho", "Sensor de rueda ABS eje 2
izquierdo", "VDC completamente operativo", etc.) -- la palabra clave `'eje'`
de "Neumáticos/Eje" (pensada para capturar fallas de eje/diferencial reales)
los capturaba por accidente, porque ninguna otra categoría los reconocía
antes.

## Cambio

Se agrega `'ABS'` como sistema independiente en `SISTEMAS`, con palabras
clave `['abs', 'antibloqueo', 'vdc']`, ubicado ANTES de "Neumáticos/Eje" en
el array (`resolverSistemaPrincipal` devuelve el primer sistema que
matchea) -- así "...ABS eje 1..." se clasifica como ABS, no como
Neumáticos, sin tocar la clasificación real de fallas de eje/diferencial
puras (que siguen sin la palabra "abs" en su nombre).

## Pendiente / decisión del usuario

**No se agregó "ABS" a `SISTEMAS_CRITICOS_NOMBRES`** (la lista de 4
sistemas que marcan un vehículo como "Crítico" por sí solos: Motor, Frenos,
Dirección, Embrague) -- es una decisión de negocio aparte de la corrección
de taxonomía, y no se debe asumir sin confirmar. Preguntar al usuario si
ABS también debería considerarse crítico (tiene sentido dado que es un
sistema de seguridad de frenado, pero es su decisión).

## Pendiente de verificar manualmente

No hay test suite. Montar el zip en Geotab y confirmar que:
- El drill-down de "Neumáticos/Eje" ya no muestra códigos de ABS.
- Aparece una barra "ABS" propia en el gráfico de sistemas con los códigos
  correspondientes.
