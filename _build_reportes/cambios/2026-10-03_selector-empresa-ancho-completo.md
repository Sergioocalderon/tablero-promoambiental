# Selector de empresa a todo el ancho

**Fecha:** 2026-10-03
**Versión:** 2.3 → 2.4
**Archivos:** `mantenimiento.js` (`construirFormulario`), `config.json`, zip del add-in

## Problema (reportado por el usuario con captura)

El selector "Empresa" compartía fila con Desde, Hasta y Atajos
(`grid-template-columns: 1.3fr 1fr 1fr 1fr`). Dentro del contenedor de
760 px le tocaban ~170 px, y nombres como "ESTACIÓN DE TRANSFERENCIA ZIPA" o
"PROMO AMBIENTAL DISTRITO BOGOTA" salían cortados ("ESTACIÓN DE TRANSFER").
Las fechas también se cortaban ("26/09/2026 09…") y las pills de atajos
quedaban apretadas.

## Cambio

- Empresa ocupa su propia fila a todo el ancho (`gridColumn: '1 / -1'`).
- Segunda fila: Desde | Hasta | Atajos
  (`minmax(170px,1fr) minmax(170px,1fr) minmax(200px,1.1fr)`).
- La regla responsive existente (`@media (max-width:620px)` → una sola
  columna) no cambia.

## Verificación

Captura del formulario cargado con la API real (Chromium, 900 px de ancho) y
"PROMO AMBIENTAL DISTRITO BOGOTA" seleccionada: el nombre completo cabe, las
fechas se leen completas con la hora ("26/09/2026 09:33 p. m.") y los dos
atajos se leen sin cortarse. 0 errores de consola.
