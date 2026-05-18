#!/usr/bin/env node

/**
 * Bot de Telegram para automatización de gastos
 *
 * Uso:
 *   node src/telegram-bot.js
 *
 * Requisitos:
 *   - TELEGRAM_BOT_TOKEN configurado en .env
 *   - GOOGLE_SERVICE_ACCOUNT_JSON configurado en .env
 */

import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { PagoMovilParser } from './parser.js';
import { getExchangeRate } from './exchange-rate.js';
import { SheetsManager } from './sheets.js';
import { extractTextFromImage } from './ocr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = path.join(os.tmpdir(), 'pago-movil-bot');

// ============================
// HELPERS
// ============================

/**
 * Escapa caracteres para el Markdown LEGACY de Telegram
 * Solo escapamos: _ * ` [   (lo demas es para MarkdownV2)
 */
function escMD(text) {
  if (!text) return '';
  return String(text).replace(/[_*`\[]/g, '\\$&');
}

/**
 * Envía mensaje con parse_mode='Markdown' escapando automáticamente
 * las variables interpoladas que contengan datos del usuario
 */
function sendMD(bot, chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    ...extra,
  });
}

/**
 * Envía mensaje SIN Markdown (texto plano)
 */
function sendPlain(bot, chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, extra);
}

const pendingConfirmations = new Map();

function isAllowed(chatId) {
  const allowed = config.telegram.allowedUserIds;
  if (allowed.length === 0) return true;
  return allowed.includes(chatId);
}

// ============================
// BOT PRINCIPAL
// ============================

async function startBot() {
  if (!config.telegram.token) {
    console.error('❌ TELEGRAM_BOT_TOKEN no configurado');
    process.exit(1);
  }

  await fs.mkdir(TEMP_DIR, { recursive: true });

  // Limpiar archivos temporales huérfanos de ejecuciones anteriores
  const oldFiles = await fs.readdir(TEMP_DIR);
  for (const f of oldFiles) {
    await fs.unlink(path.join(TEMP_DIR, f)).catch(() => {});
  }
  if (oldFiles.length > 0) console.log(`🧹 Limpiados ${oldFiles.length} archivos temporales viejos`);

  const bot = new TelegramBot(config.telegram.token, { polling: true });
  const sheets = new SheetsManager();

  console.log('🤖 Bot de Telegram iniciado!');
  console.log(`   Temp dir: ${TEMP_DIR}`);

  // ---- /start ----
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id || chatId;
    if (!isAllowed(chatId)) {
      sendPlain(bot, chatId, '❌ No tienes permiso para usar este bot.');
      return;
    }

    sendMD(bot, chatId,
      '👋 *Bienvenido al Automatizador de Gastos*\n\n' +
      '📸 Envíame una *captura* de un Pago Móvil Banesco y yo:\n' +
      '1️⃣ Extraeré los datos (monto, fecha, ref, concepto)\n' +
      '2️⃣ Calcularé el equivalente en $ (tasa del día)\n' +
      '3️⃣ Lo agregaré a tu Google Sheets\n\n' +
      `📌 *Tu ID:* \`${userId}\`\n\n` +
      'Comandos:\n' +
      '/tasa — Ver la tasa de cambio del día\n' +
      '/ultimo — Ver el último registro\n' +
      '/cancelar — Cancelar operación pendiente'
    );
  });

  // ---- /tasa ----
  bot.onText(/\/tasa/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAllowed(chatId)) return;

    try {
      const { rate } = await getExchangeRate();
      sendMD(bot, chatId,
        `💵 *Tasa de cambio del día*\n\nBs. ${escMD(rate.toFixed(2))} por USD`
      );
    } catch (err) {
      sendPlain(bot, chatId, `❌ Error: ${err.message}`);
    }
  });

  // ---- /cancelar ----
  bot.onText(/\/cancelar/, (msg) => {
    const chatId = msg.chat.id;
    if (pendingConfirmations.has(chatId)) {
      pendingConfirmations.delete(chatId);
      sendPlain(bot, chatId, '✅ Operación cancelada.');
    } else {
      sendPlain(bot, chatId, 'No hay ninguna operación pendiente.');
    }
  });

  // ---- /ultimo ----
  bot.onText(/\/ultimo/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isAllowed(chatId)) return;

    try {
      await sheets.init();
      const lastRow = await sheets.getLastDataRow();
      if (lastRow <= 1) {
        sendPlain(bot, chatId, '📭 La hoja está vacía.');
        return;
      }
      const [fecha, bs, usd, espec, tipo] = await sheets.readRow(lastRow);
      sendMD(bot, chatId,
        `📋 *Último registro (fila ${lastRow})*\n\n` +
        `📅 ${escMD(fecha || '—')}\n` +
        `💰 ${escMD(bs || '—')}\n` +
        `💵 ${escMD(usd || '—')}\n` +
        `📝 ${escMD(espec || '—')}\n` +
        `🏷️ ${escMD(tipo || '—')}`
      );
    } catch (err) {
      sendPlain(bot, chatId, `❌ Error: ${err.message}`);
    }
  });

  // ---- Fotos / Capturas ----
  bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    if (!isAllowed(chatId)) return;

    const photo = msg.photo[msg.photo.length - 1];

    try {
      const file = await bot.getFile(photo.file_id);
      if (!file.file_path) {
        sendPlain(bot, chatId, '❌ No se pudo obtener el archivo.');
        return;
      }

      const localPath = path.join(TEMP_DIR, `payment_${Date.now()}.jpg`);
      const downloadUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;

      const response = await fetch(downloadUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(localPath, buffer);

      await sendPlain(bot, chatId, '📸 Imagen recibida, extrayendo datos...');

      // OCR
      const rawText = await extractTextFromImage(localPath);

      // Eliminar imagen temporal — ya no la necesitamos
      await fs.unlink(localPath).catch(() => {});
      console.log('📄 OCR:', rawText.slice(0, 600));

      if (!rawText || rawText.trim().length < 20) {
        sendPlain(bot, chatId,
          '❌ No se pudo extraer texto de la imagen. ' +
          'Asegúrate de que la captura sea clara y legible.'
        );
        return;
      }

      // Parse
      const parsed = PagoMovilParser.parse(rawText);
      const validation = PagoMovilParser.validate(parsed);

      if (!validation.valid) {
        const errorList = validation.errors.join('\n• ');
        sendPlain(bot, chatId,
          `⚠️ No se pudo procesar completamente:\n• ${errorList}\n\n` +
          `Texto extraído:\n\`\`\`\n${rawText.slice(0, 1500)}\n\`\`\``
        );
        return;
      }

      // Tasa de cambio
      await sendPlain(bot, chatId, '💱 Obteniendo tasa de cambio del día...');
      let tasaData;
      try {
        tasaData = await getExchangeRate();
      } catch (err) {
        tasaData = { rate: null, source: 'No disponible' };
        sendPlain(bot, chatId,
          `⚠️ No se pudo obtener la tasa: ${err.message}. Se usará "N/A" para dólares.`
        );
      }

      const montoDolares = tasaData.rate
        ? (parsed.montoBolivares / tasaData.rate).toFixed(2)
        : 'N/A';

      // Guardar estado pendiente (con timestamp para auto-cancel)
      pendingConfirmations.set(chatId, {
        parsed,
        tasaBs: tasaData.rate,
        montoDolares,
        _createdAt: Date.now(),
      });

      const confirmKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Aceptar y guardar', callback_data: 'confirm' },
              { text: '❌ Cancelar', callback_data: 'cancel' },
            ],
          ],
        },
      };

      // Mensaje de revisión — escapar datos del usuario
      const tasaStr = tasaData.rate ? escMD(tasaData.rate.toFixed(2)) : 'N/A';
      sendMD(bot, chatId,
        `📋 *Datos extraídos — Revisa antes de guardar:*\n\n` +
        `📅 *Fecha:* ${escMD(parsed.fecha || '?')}\n` +
        `💰 *Monto:* Bs. ${escMD(parsed.montoBolivares.toFixed(2))}\n` +
        `💵 *En dólares:* $${escMD(montoDolares)}` +
          (tasaData.rate ? ` (tasa: Bs. ${tasaStr})` : '') + '\n' +
        `🔢 *Referencia:* ${escMD(parsed.referencia || '?')}\n` +
        `📝 *Concepto:* ${escMD(parsed.concepto || '(sin concepto)')}\n` +
        `📱 *Origen:* ${escMD(parsed.pagador || '?')}\n` +
        `📱 *Destino:* ${escMD(parsed.beneficiario || '?')}\n` +
        `🏦 *Emisor:* ${escMD(parsed.bancoEmisor || '?')}\n` +
        `🏦 *Receptor:* ${escMD(parsed.bancoReceptor || '?')}\n\n` +
        `📝 *Especificación:* Ref: ${escMD(parsed.referencia || '?')}` +
          (parsed.concepto ? ` - ${escMD(parsed.concepto)}` : '') + '\n\n' +
        `¿Guardar en la hoja de cálculo?`,
        confirmKeyboard
      );

    } catch (err) {
      console.error('❌ Error procesando imagen:', err);
      sendPlain(bot, chatId, `❌ Error procesando la imagen: ${err.message}`);
    }
  });

  // ---- Botones inline ----
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (!pendingConfirmations.has(chatId)) {
      bot.answerCallbackQuery(query.id, { text: 'No hay operación pendiente' });
      return;
    }

    const pending = pendingConfirmations.get(chatId);

    if (data === 'cancel') {
      pendingConfirmations.delete(chatId);
      bot.editMessageText('❌ Operación cancelada.', {
        chat_id: chatId,
        message_id: query.message.message_id,
      });
      bot.answerCallbackQuery(query.id, { text: 'Cancelado' });
      return;
    }

    if (data === 'confirm') {
      try {
        await bot.editMessageText('💾 Guardando en Google Sheets...', {
          chat_id: chatId,
          message_id: query.message.message_id,
        });

        await sheets.init();
        const result = await sheets.appendPayment(pending.parsed, pending.tasaBs);

        const conceptStr = pending.parsed.concepto || '(sin concepto)';
        const dolaresStr = pending.tasaBs
          ? ` → $${pending.montoDolares}`
          : '';

        sendMD(bot, chatId,
          `✅ *¡Guardado exitosamente!*\n\n` +
          `📊 Hoja: \`${escMD(result.sheetName)}\`\n` +
          `📍 Rango: \`${escMD(result.range)}\`\n` +
          `📅 ${escMD(pending.parsed.fecha)}\n` +
          `💰 Bs. ${escMD(pending.parsed.montoBolivares.toFixed(2))}${escMD(dolaresStr)}\n` +
          `📝 ${escMD(conceptStr)}`
        );

        bot.answerCallbackQuery(query.id, { text: '✅ Guardado' });
      } catch (err) {
        sendPlain(bot, chatId, `❌ Error al guardar: ${err.message}`);
        bot.answerCallbackQuery(query.id, { text: 'Error' });
      } finally {
        pendingConfirmations.delete(chatId);
      }
    }
  });

  // Limpieza periódica de confirmaciones caducadas (>30 min)
  setInterval(() => {
    const now = Date.now();
    for (const [chatId, pending] of pendingConfirmations) {
      if (pending._createdAt && (now - pending._createdAt) > 30 * 60 * 1000) {
        pendingConfirmations.delete(chatId);
        console.log(`🧹 Confirmación caducada: chat ${chatId}`);
      }
    }
  }, 5 * 60 * 1000); // cada 5 minutos

  // Limpieza de archivos temp huérfanos (cada hora)
  setInterval(async () => {
    try {
      const files = await fs.readdir(TEMP_DIR);
      for (const f of files) {
        await fs.unlink(path.join(TEMP_DIR, f)).catch(() => {});
      }
      if (files.length > 0) console.log(`🧹 Limpieza periódica: ${files.length} archivos`);
    } catch { /* TEMP_DIR no existe */ }
  }, 60 * 60 * 1000);

  bot.on('polling_error', (err) => {
    console.error('⚠️ Polling error:', err.message);
  });

  console.log('✅ Bot listo para recibir imágenes!');
}

startBot().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
