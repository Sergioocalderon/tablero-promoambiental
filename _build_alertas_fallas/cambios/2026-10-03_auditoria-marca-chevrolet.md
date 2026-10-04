# Auditoría: marca Chevrolet

**Fecha:** 2026-10-03
**Versión:** 1.13 → 1.14
**Archivos:** `alertasFallas.js`, `config.json`, `AlertasPorSeveridad_addin.zip`

## Contexto

Auditoría contra la cuenta real (Chromium + API real, solo lectura). Cifras
recalculadas por fuera en Python, todas exactas:

- 8 vehículos en ALTA y 50 en MEDIA/BAJA.
- 26 / 69 / 169 fallas visibles por criticidad.
- Las fallas ocultas cuadran (164 frente a 166, por los minutos entre una
  consulta y otra).

## Cambio

- `REFERENCIA_MOTOR_POR_MARCA` + `'chevrolet': 'Sin confirmar'`: los furgones
  NHR y la van N400 salían con "Motor: Desconocido" y sin marca. Verificado con
  la corrida real: ahora sale "Motor: Sin confirmar".

## Observación pendiente de decisión del usuario (sin cambiar)

`CATEGORIAS_OCULTAS` incluye 'General', o sea todo diagnóstico cuyo nombre no
contenga una palabra clave conocida. El aviso dice "conectividad telemática y
diagnósticos sin nombre reconocible". Medido el 2026-10-03:

- No oculta ninguna falla ALTA.
- Oculta **29 MEDIA** (luz ámbar), casi todas códigos propietarios "Unknown
  Diagnostic 520422/520423/520431…". 520422 y 520423 son el #2 y #3 más
  repetidos de la flota en el Dashboard de Fallas.
- Oculta **10 "Alerta: Se excedió el límite de aceleración para colisiones"**
  (posibles choques).
