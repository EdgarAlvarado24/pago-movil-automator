#!/usr/bin/env node

/**
 * Bot de Telegram para automatización de gastos
 * Basado en grammy (reemplazo de node-telegram-bot-api)
 *
 * Uso:
 *   node src/telegram-bot.js
 *
 * Requisitos:
 *   - TELEGRAM_BOT_TOKEN configurado en .env
 *   - GOOGLE_SERVICE_ACCOUNT_JSON configurado en .env
 */

import { Bot } from 'grammy';
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
 * Memoria de operaciones pendientes de confirmación (por chatId)
 */
const pendingConfirmations = new Map();

/**
 * Verifica si un chatId está autorizado
 */
function isAllowed(chatId) {
  const allowed = config.telegram.allowedUserIds;
  if (allowed.length === 0) return true; // Sin restricción si no hay IDs configurados
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

  const bot = new Bot(config.telegram.token);
  const sheets = new SheetsManager();

  console.log('🤖 Bot de Telegram iniciado!');
  console.log(`   Temp dir: ${TEMP_DIR}`);

  // ==========================================
  // COMANDOS
  // ==========================================

  // ---- /start ----
  bot.command('start', async (ctx) => {
    if (!isAllowed(ctx.chat.id)) {
      await ctx.reply('❌ No tienes permiso para usar este bot.');
      return;
    }

    await ctx.reply(
      '👋 *Bienvenido al Automatizador de Gastos*\n\n' +
      '📸 Envíame una *captura* de un Pago Móvil Banesco y yo:\n' +
      '1️⃣ Extraeré los datos (monto, fecha, ref, concepto)\n' +
      '2️⃣ Calcularé el equivalente en $ (tasa del día)\n' +
      '3️⃣ Lo agregaré a tu Google Sheets\n\n' +
      `📌 *Tu ID:* \`${ctx.from?.id || ctx.chat.id}\`\n\n` +
      'Comandos:\n' +
      '/tasa — Ver la tasa de cambio del día\n' +
      '/ultimo — Ver el último registro\n' +
      '/cancelar — Cancelar operación pendiente',
      { parse_mode: 'Markdown' }
    );
  });

  // ---- /tasa ----
  bot.command('tasa', async (ctx) => {
    if (!isAllowed(ctx.chat.id)) return;

    try {
      const { rate } = await getExchangeRate();
      await ctx.reply(
        `💵 *Tasa de cambio del día*\n\nBs. ${escMD(rate.toFixed(2))} por USD`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // ---- /cancelar ----
  bot.command('cancelar', async (ctx) => {
    if (pendingConfirmations.has(ctx.chat.id)) {
      pendingConfirmations.delete(ctx.chat.id);
      await ctx.reply('✅ Operación cancelada.');
    } else {
      await ctx.reply('No hay ninguna operación pendiente.');
    }
  });

  // ---- /ultimo ----
  bot.command('ultimo', async (ctx) => {
    if (!isAllowed(ctx.chat.id)) return;

    try {
      await sheets.init();
      const lastRow = await sheets.getLastDataRow();
      if (lastRow <= 1) {
        await ctx.reply('📭 La hoja está vacía.');
        return;
      }
      const [fecha, bs, usd, espec, tipo] = await sheets.readRow(lastRow);
      await ctx.reply(
        `📋 *Último registro (fila ${lastRow})*\n\n` +
        `📅 ${escMD(fecha || '—')}\n` +
        `💰 ${escMD(bs || '—')}\n` +
        `💵 ${escMD(usd || '—')}\n` +
        `📝 ${escMD(espec || '—')}\n` +
        `🏷️ ${escMD(tipo || '—')}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  // ==========================================
  // FOTOS / CAPTURAS
  // ==========================================

  bot.on(':photo', async (ctx) => {
    if (!isAllowed(ctx.chat.id)) return;

    const photo = ctx.msg.photo.at(-1); // la de mayor resolución

    try {
      const file = await ctx.getFile();
      if (!file.file_path) {
        await ctx.reply('❌ No se pudo obtener el archivo.');
        return;
      }

      const localPath = path.join(TEMP_DIR, `payment_${Date.now()}.jpg`);
      // Descargar usando la URL de Telegram directamente
      const url = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
      const response = await fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(localPath, buffer);

      await ctx.reply('📸 Imagen recibida, extrayendo datos...');

      // OCR
      const rawText = await extractTextFromImage(localPath);

      // Eliminar imagen temporal — ya no la necesitamos
      await fs.unlink(localPath).catch(() => {});
      console.log('📄 OCR:', rawText.slice(0, 600));

      if (!rawText || rawText.trim().length < 20) {
        await ctx.reply(
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
        await ctx.reply(
          `⚠️ No se pudo procesar completamente:\n• ${errorList}\n\n` +
          `Texto extraído:\n\`\`\`\n${rawText.slice(0, 1500)}\n\`\`\``
        );
        return;
      }

      // Tasa de cambio
      await ctx.reply('💱 Obteniendo tasa de cambio del día...');
      let tasaData;
      try {
        tasaData = await getExchangeRate();
      } catch (err) {
        tasaData = { rate: null, source: 'No disponible' };
        await ctx.reply(
          `⚠️ No se pudo obtener la tasa: ${err.message}. Se usará "N/A" para dólares.`
        );
      }

      const montoDolares = tasaData.rate
        ? (parsed.montoBolivares / tasaData.rate).toFixed(2)
        : 'N/A';

      // Guardar estado pendiente (con timestamp para auto-cancel)
      pendingConfirmations.set(ctx.chat.id, {
        parsed,
        tasaBs: tasaData.rate,
        montoDolares,
        _createdAt: Date.now(),
      });

      const tasaStr = tasaData.rate ? escMD(tasaData.rate.toFixed(2)) : 'N/A';

      await ctx.reply(
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
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Aceptar y guardar', callback_data: 'confirm' },
                { text: '❌ Cancelar', callback_data: 'cancel' },
              ],
            ],
          },
        }
      );

    } catch (err) {
      console.error('❌ Error procesando imagen:', err);
      await ctx.reply(`❌ Error procesando la imagen: ${err.message}`);
    }
  });

  // ==========================================
  // BOTONES INLINE
  // ==========================================

  bot.on('callback_query:data', async (ctx) => {
    const chatId = ctx.chat.id;
    const data = ctx.callbackQuery.data;

    if (!pendingConfirmations.has(chatId)) {
      await ctx.answerCallbackQuery('No hay operación pendiente');
      return;
    }

    const pending = pendingConfirmations.get(chatId);

    if (data === 'cancel') {
      pendingConfirmations.delete(chatId);
      await ctx.editMessageText('❌ Operación cancelada.');
      await ctx.answerCallbackQuery('Cancelado');
      return;
    }

    if (data === 'confirm') {
      try {
        await ctx.editMessageText('💾 Guardando en Google Sheets...');

        await sheets.init();
        const result = await sheets.appendPayment(pending.parsed, pending.tasaBs);

        const conceptStr = pending.parsed.concepto || '(sin concepto)';
        const dolaresStr = pending.tasaBs
          ? ` → $${pending.montoDolares}`
          : '';

        await ctx.reply(
          `✅ *¡Guardado exitosamente!*\n\n` +
          `📊 Hoja: \`${escMD(result.sheetName)}\`\n` +
          `📍 Rango: \`${escMD(result.range)}\`\n` +
          `📅 ${escMD(pending.parsed.fecha)}\n` +
          `💰 Bs. ${escMD(pending.parsed.montoBolivares.toFixed(2))}${escMD(dolaresStr)}\n` +
          `📝 ${escMD(conceptStr)}`,
          { parse_mode: 'Markdown' }
        );

        await ctx.answerCallbackQuery('✅ Guardado');
      } catch (err) {
        await ctx.reply(`❌ Error al guardar: ${err.message}`);
        await ctx.answerCallbackQuery('Error');
      } finally {
        pendingConfirmations.delete(chatId);
      }
    }
  });

  // ==========================================
  // TAREAS DE FONDO
  // ==========================================

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

  // ==========================================
  // ERROR HANDLER & ARRANQUE
  // ==========================================

  bot.catch((err) => {
    console.error('⚠️ Bot error:', err);
  });

  // Manejo de señal de terminación para cierre graceful
  process.once('SIGINT', () => bot.stop());
  process.once('SIGTERM', () => bot.stop());

  console.log('✅ Bot listo para recibir imágenes!');
  await bot.start();
}

startBot().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
