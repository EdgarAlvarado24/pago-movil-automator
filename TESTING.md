# Testing - Fase 2 (OAuth2)

## Setup previo

Antes de probar, necesitas crear un **OAuth 2.0 Client ID** en Google Cloud:

1. Ve a https://console.cloud.google.com/apis/credentials
2. Crear credenciales → ID de cliente OAuth 2.0 → Aplicación web
3. Agrega URI de redirección autorizada: `http://TU_IP:3456/oauth/callback`
4. Copia Client ID y Client Secret al `.env`

## Nuevo flujo /setup con OAuth2

```
/setup
→ Bot responde con enlace de Google OAuth
→ Usuario hace click → autoriza en Google
→ Google redirige al servidor OAuth del bot
→ Bot crea hoja automáticamente
→ "✅ Configuración completada! 📊 Nueva hoja creada: ..."
```

## /config

```
/config
→ 📋 Tu configuración
  📊 Spreadsheet: spreadsheet_id
  🔑 Autenticación: ✅ OAuth2 (Google)
  💱 Preferencias de tasa:
     Fuente: dolarapi
     Modo: oficial
```

## /status

```
/status
→ "✅ Conexión exitosa"
```

## /ultimo + /mystats + flujo de pago

Sin cambios respecto a antes, pero ahora usando OAuth2 internamente.

## /remove

```
/remove
→ "⚠️ ¿Estás seguro? Esto eliminará todos tus datos..."
  [✅ Sí, borrar mis datos]  [❌ No, cancelar]
```

## Servidor OAuth

El bot inicia un servidor HTTP en el puerto `OAUTH_PORT` (default: 3456).

Endpoints:
- `/oauth/callback` — callback de Google OAuth
- `/health` — health check

## Variables .env nuevas

```
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=tu_client_secret
OAUTH_REDIRECT_URI=http://localhost:3456/oauth/callback
OAUTH_PORT=3456
```

## Notas de seguridad

- Los refresh tokens se almacenan encriptados (AES-256-GCM) en PostgreSQL
- El usuario puede revocar el acceso desde https://myaccount.google.com/permissions
- No se almacenan Service Account JSONs (más seguro)
