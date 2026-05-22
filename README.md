# Pago Móvil Automator

Automatizador de registro de Pagos Móviles a Google Sheets.  
Bot de Telegram multi-tenant con PostgreSQL y OAuth2.

## Arquitectura

```
Usuario → Telegram Bot → PostgreSQL (usuarios, tokens, preferencias)
                       → Google Sheets API (vía OAuth2 del usuario)
                       → Exchange Rate API (DolarAPI / BCV)
```

Cada usuario autoriza su propia cuenta de Google (OAuth2):
- Nunca se almacenan Service Account JSONs
- El usuario puede revocar el acceso desde su cuenta Google
- Datos completamente aislados entre usuarios

## Requisitos

- Node.js 18+
- PostgreSQL (recomendado: Supabase, Neon, Railway)
- Cuenta de Google Cloud (para crear OAuth 2.0 Client ID)
- Bot de Telegram (vía @BotFather)

## Setup rápido

```bash
# 1. Clonar e instalar
npm install

# 2. Generar clave de encriptación
npm run generate-key

# 3. Configurar .env
cp .env.example .env
# Editar .env con tus credenciales (ver sección "Admin Setup" abajo)

# 4. Iniciar el bot
npm run bot
```

---

## Admin Setup (Configuración inicial)

El admin debe configurar **tres cosas** antes de que los usuarios puedan usar el bot:

### 1. PostgreSQL

Crea una base de datos gratuita en [Supabase](https://supabase.com) o [Neon](https://neon.tech) y copia la URL de conexión a `DATABASE_URL` en `.env`.

### 2. Bot de Telegram

Crea un bot con [@BotFather](https://t.me/BotFather), copia el token a `TELEGRAM_BOT_TOKEN`, y averigua tu ID de Telegram con [@userinfobot](https://t.me/userinfobot) para `ADMIN_TELEGRAM_ID`.

### 3. OAuth 2.0 de Google (paso más importante)

El bot usa OAuth2 para que cada usuario autorice su propia cuenta de Google.  
No se usan Service Accounts.

**Pasos en Google Cloud Console:**

1. Ve a [Google Cloud Console → APIs y Servicios](https://console.cloud.google.com/apis/dashboard)
2. Crea un proyecto o selecciona uno existente
3. **Habilita las APIs necesarias** (ambas):
   - [Google Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
4. Ve a [Credenciales](https://console.cloud.google.com/apis/credentials)
5. Click en **"Crear credenciales" → "ID de cliente OAuth 2.0"**
   - Tipo: **Aplicación web**
   - Nombre: `Pago Móvil Automator`
   - **URI de redirección autorizada**: `http://TU_IP:3456/oauth/callback`
     - Si pruebas local: `http://localhost:3456/oauth/callback`
     - Si pruebas en red local: `http://192.168.x.x:3456/oauth/callback`
     - Si usas ngrok: `https://xxxx.ngrok.io/oauth/callback`
6. Click en **Crear**
7. Copia los valores que aparecen:
   - **Client ID** → `GOOGLE_CLIENT_ID` en `.env`
   - **Client Secret** → `GOOGLE_CLIENT_SECRET` en `.env`

8. Asegúrate de que `OAUTH_REDIRECT_URI` en `.env` coincida exactamente con la URI registrada en Google.

---

## Variables de entorno (.env)

| Variable | Obligatoria | Descripción |
|---|---|---|
| `DATABASE_URL` | ✅ | URL de PostgreSQL |
| `TELEGRAM_BOT_TOKEN` | ✅ | Token del bot de Telegram |
| `ADMIN_TELEGRAM_ID` | ✅ | ID de Telegram del admin |
| `GOOGLE_CLIENT_ID` | ✅ | OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | OAuth 2.0 Client Secret |
| `OAUTH_REDIRECT_URI` | ✅ | URI de redirección OAuth (debe coincidir con Google) |
| `ENCRYPTION_KEY` | ✅ | Clave hex de 32 bytes (generar con `npm run generate-key`) |
| `OAUTH_PORT` | ❌ | Puerto del servidor OAuth (default: 3456) |
| `EXCHANGE_SOURCE` | ❌ | `dolarapi` o `bcv` (default: dolarapi) |
| `EXCHANGE_MODE` | ❌ | `oficial` o `paralelo` (default: oficial) |
| `LOG_LEVEL` | ❌ | `error`, `warn`, `info`, `debug` (default: info) |

---

## Comandos

### Usuarios
| Comando | Descripción |
|---|---|
| `/start` | Registrar y ver estado de configuración |
| `/setup` | Conectar Google Sheets vía OAuth2 (un solo clic) |
| `/config` | Ver configuración actual |
| `/status` | Probar conexión a tu hoja |
| `/tasa` | Tasa de cambio del día |
| `/ultimo` | Último registro en tu hoja |
| `/mystats` | Estadísticas de tus pagos |
| `/remove` | Borrar todos tus datos del bot |
| `/cancelar` | Cancelar operación pendiente |
| `/help` | Mostrar ayuda |

### Admin
| Comando | Descripción |
|---|---|
| `/whitelist add [id]` | Aprobar usuario |
| `/whitelist remove [id]` | Desaprobar usuario |
| `/listusers` | Listar todos los usuarios |
| `/removeuser [id]` | Desactivar usuario |
| `/broadcast [msg]` | Enviar mensaje a todos los usuarios |

---

## Flujo de uso

**Para el admin (una sola vez):**
1. Configurar `.env` con OAuth2, Telegram y PostgreSQL
2. Iniciar el bot con `npm run bot`
3. Agregar usuarios a la whitelist con `/whitelist add [telegram_id]`

**Para cada usuario:**
1. Enviar `/start` al bot
2. Esperar a que el admin lo apruebe
3. Enviar `/setup`
4. Hacer clic en el enlace de Google y autorizar
5. El bot crea automáticamente su hoja de cálculo
6. Enviar fotos de Pagos Móviles → se registran en su hoja

---

## Scripts

```bash
npm run bot          # Iniciar bot de Telegram
npm run migrate      # Ejecutar migraciones de DB
npm run generate-key # Generar ENCRYPTION_KEY
npm run test:parse   # Probar parser
npm run logs         # Ver logs en tiempo real
```

## Seguridad

- Los refresh tokens de OAuth2 se almacenan encriptados (AES-256-GCM)
- No se almacenan Service Account JSONs
- Cada usuario solo accede a sus propias hojas
- El usuario puede revocar el acceso desde: https://myaccount.google.com/permissions
- Los tokens expiran y se renuevan automáticamente
- Rate limiting: máximo 10 operaciones por minuto por usuario
