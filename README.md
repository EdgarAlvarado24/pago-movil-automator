# Pago Móvil Automator 🎯

Automatiza el registro de tus Pagos Móviles Banesco en Google Sheets.

## Cómo funciona

1. 📸 Tomas una captura de tu Pago Móvil Banesco
2. 🤖 Se extraen los datos (monto, fecha, referencia, concepto)
3. 💱 Se obtiene la tasa de cambio del día (BCV/DolarAPI)
4. 📊 Se calcula el equivalente en dólares
5. ✅ Revisas y confirmas
6. 📝 Se escribe automáticamente en tu Google Sheets

## Fases

### Fase 1: Con OpenClaw
Me envías la captura por chat → yo la proceso → te muestro para revisión → confirmas → escribo en Sheets.

### Fase 2: Bot de Telegram independiente
`node src/telegram-bot.js` → Bot autónomo en Telegram, no depende de mí.

## Configuración

### 1. Google Cloud (obligatorio)

1. Ve a [Google Cloud Console](https://console.cloud.google.com/)
2. Crea un proyecto nuevo o selecciona uno existente
3. Ve a **APIs & Services > Library** y activa **Google Sheets API**
4. Ve a **APIs & Services > Credentials**
5. Crea una **Service Account**:
   - Name: `pago-movil-automator`
   - Role: `Editor` (o `Basic > Editor`)
6. Al finalizar, descarga el archivo JSON con la clave privada
7. Abre tu hoja de cálculo y compártela con el email de la service account
   (se ve como `nombre@proyecto.iam.gserviceaccount.com`)

### 2. Variables de entorno

```bash
cp .env.example .env
```

Edita `.env`:
- `GOOGLE_SERVICE_ACCOUNT_JSON`: Pega TODO el contenido del JSON que descargaste
- `SPREADSHEET_ID`: Ya está configurado (el de tu hoja)
- `SHEET_NAME`: Nombre de la pestaña (por defecto "Hoja 1")

### 3. Telegram bot (para Fase 2)

1. Habla con [@BotFather](https://t.me/BotFather) en Telegram
2. Crea un bot nuevo con `/newbot`
3. Copia el token en `TELEGRAM_BOT_TOKEN` en `.env`
4. Ejecuta `npm run bot`

## Uso

```bash
npm install
npm start -- --text "texto del comprobante" --confirm
```

## Estructura de la hoja

| Fecha | Bolivares | Dolares | Especificacion | Entradas/Salidas |
|-------|-----------|---------|----------------|------------------|
| 2026-05-13 | 1500.00 | 35.71 | Ref: 1234567890 - Pago de servicios | Salida |
# pago-movil-automator
