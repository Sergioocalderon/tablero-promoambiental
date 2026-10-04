# Ocultar "Otro / Sin clasificar" del desglose por sistema

**Fecha:** 2026-09-19
**Archivo:** `_build_dashboard_fallas/dashboardAnalisisFallas.js`
**Versión:** `config.json` 2.0 → 2.1

## Contexto

El usuario reportó que en el hero "Radiografía de sistemas" la mayoría de
las barras eran "desconocidas" y opacaban lo que realmente le interesa
(Motor, Frenos, Dirección, etc.). La taxonomía (`resolverSistemaPrincipal`)
clasifica cualquier diagnóstico que no matchea ninguna palabra clave de
`SISTEMAS` como `'Otro / Sin clasificar'` — en la práctica, códigos
propietarios sin descripción estándar y mensajes de mantenimiento genéricos
(ej. "Instancias de mensajes mensuales restantes"), no fallas de un sistema
real. Al ser mucho volumen, esa barra dominaba visualmente el gráfico.

## Cambio

`agregarPorSistema` ahora descarta los grupos cuyo `resolverSistemaPrincipal`
resuelve a `'Otro / Sin clasificar'` (constante `SISTEMA_SIN_CLASIFICAR`)
antes de agregarlos. Como esta función es la única fuente para el gráfico
"Fallas por sistema" Y para el KPI hero "Sistema con más episodios en el
rango", el cambio se propaga a ambos automáticamente.

**No afecta** los totales generales (KPI "Episodios de falla", etc.) —
esos se calculan aparte, sumando `g.episodios` directo sobre todos los
grupos filtrados, sin pasar por `agregarPorSistema`. Solo desaparece del
desglose *por sistema*.

## Reversión

Si más adelante se decide ampliar la taxonomía (`SISTEMAS`) para cubrir más
diagnósticos reales en vez de ocultar "Sin clasificar", basta con quitar el
`if (sistema === SISTEMA_SIN_CLASIFICAR) return;` agregado en
`agregarPorSistema`.

## Pendiente de verificar manualmente

No hay test suite. Empaquetar y montar el zip en Geotab para confirmar que
el gráfico de sistemas ahora muestra solo categorías reales y que el KPI
"Sistema con más episodios" ya no puede caer en "Otro / Sin clasificar".
