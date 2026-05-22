# Pago Móvil Automator

Automatizador de registro de Pagos Móviles a Google Sheets. Bot de Telegram multi-tenant con PostgreSQL.

## Arquitectura

```
Usuario → Telegram Bot → PostgreSQL (users, credenciales, preferencias)
                      → Google Sheets API (por usuario, con su propio SA)
                      → Exchange Rate API (DolarAPI / BCV)
```

Cada usuario:
- Provee su propio **Service Account JSON** de Google Cloud
- Conecta su propio **Spreadsheet ID**
- Puede personalizar el **formato de columnas** de su hoja
- Datos aislados: ningún usuario ve los datos de otro

## Requisitos

- Node.js 18+
- PostgreSQL (recomendado: Supabase, Neon, Railway)
- Cuenta de Google Cloud + Service Account
- Bot de Telegram (via @BotFather)

## Setup rápido

```bash
# 1. Clonar e instalar
npm install

# 2. Generar clave de encriptación
npm run generate-key

# 3. Configurar .env (ver .env.example)
cp .env.example .env

# 4. Iniciar el bot
npm run bot
```

## Variables de entorno

| Variable | Descripción |
|---|---|
| `DATABASE_URL` | URL de PostgreSQL |
| `TELEGRAM_BOT_TOKEN` | Token del bot de Telegram |
| `ADMIN_TELEGRAM_ID` | ID de Telegram del admin |
| `ENCRYPTION_KEY` | Clave hex de 32 bytes para encriptar SA JSONs |
| `EXCHANGE_SOURCE` | `dolarapi` o `bcv` |
| `EXCHANGE_MODE` | `oficial` o `paralelo` |

## Comandos

### Usuarios
- `/start` — Registrar y ver estado
- `/setup` — Configurar Google Sheets (SA JSON + Spreadsheet ID)
- `/config` — Ver configuración actual
- `/status` — Probar conexión a tu hoja
- `/tasa` — Tasa de cambio del día
- `/ultimo` — Último registro en tu hoja
- `/mystats` — Estadísticas de tus pagos
- `/cancelar` — Cancelar operación pendiente

### Admin
- `/whitelist add [id]` — Aprobar usuario
- `/whitelist remove [id]` — Desaprobar usuario
- `/listusers` — Listar todos los usuarios
- `/removeuser [id]` — Desactivar usuario
- `/broadcast [msg]` — Enviar mensaje a todos

## Flujo de registro

1. Usuario envía `/start` → se registra en DB (whitelisted=false)
2. Admin usa `/whitelist add [telegram_id]`
3. Usuario usa `/setup` → guía paso a paso:
   - Envía su Service Account JSON
   - Envía su Spreadsheet ID
   - Bot prueba conexión y guarda
4. Usuario envía captura de Pago Móvil → se registra en SU hoja

## Scripts

```bash
npm run bot          # Iniciar bot de Telegram
npm run migrate      # Ejecutar migraciones de DB
npm run generate-key # Generar ENCRYPTION_KEY
npm run test:parse   # Probar parser
npm run logs         # Ver logs
```
