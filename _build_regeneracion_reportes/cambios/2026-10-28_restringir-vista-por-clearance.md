# Restringir la vista del add-in por permiso de seguridad

**Fecha:** 2026-10-28
**Versión:** 1.0 (sin cambio: el add-in aún no estaba montado en la plataforma)
**Archivos:** `config.json`

## Qué cambió

Se agregó `"enableViewSecurityId": true` al manifiesto. MyGeotab crea el permiso
"View Reportes de Regeneraciones DPF add-in" en las autorizaciones de seguridad, y solo
los usuarios cuyo perfil lo tenga marcado ven el add-in en el menú.

## Cómo se activa

Administración → Usuarios → Autorizaciones de seguridad: marcar el permiso en el perfil
de los usuarios de Promoambiental y dejarlo desmarcado en el resto.
