#!/usr/bin/env node

import { Bot } from 'grammy';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { config } from './config.js';
import { PagoMovilParser } from './parser.js';
import { getExchangeRate, getCachedRates } from './exchange-rate.js';
import { SheetsManager } from './sheets.js';
import { extractTextFromImage } from './ocr.js';
import { runMigrations } from './db/migrations.js';
import {
  findOrCreateUser,
  getCredentials,
  saveCredentials,
  getPreferences,
  upsertPreferences,
  listUsers,
  setUserWhitelisted,
  setUserActive,
  logPayment,
  getPaymentStats,
  getDefaultSheetColumns,
} from './db/queries.js';
import logger from './logger.js';

const TEMP_DIR = path.join(os.tmpdir(), 'pago-movil-bot');
const pendingConfirmations = new Map();

function escMD(text) {
  if (!text) return '';
  return String(text).replace(/[_*`\[]/g, '\\$&');
}

function isAdmin(telegramId) {
  return config.telegram.adminId === telegramId;
}

function chunkString(str, size = 4000) {
  const chunks = [];
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size));
  }
  return chunks;
}

async function startBot() {
  if (!config.telegram.token) {
    logger.error('TELEGRAM_BOT_TOKEN no configurado');
    process.exit(1);
  }

  if (!config.database.url) {
    logger.error('DATABASE_URL no configurada');
    process.exit(1);
  }

  await runMigrations();
  await fs.mkdir(TEMP_DIR, { recursive: true });

  try {
    const oldFiles = await fs.readdir(TEMP_DIR);
    for (const f of oldFiles) {
      await fs.unlink(path.join(TEMP_DIR, f)).catch(() => {});
    }
    if (oldFiles.length > 0) logger.info(`Limpiados ${oldFiles.length} archivos temporales viejos`);
  } catch { /* ok */ }

  const bot = new Bot(config.telegram.token);

  logger.info('Bot de Telegram iniciado');

  function isAllowed(user) {
    if (!user) return false;
    if (user.is_admin) return true;
    return user.is_active && user.whitelisted;
  }

  async function ensureUser(ctx) {
    const telegramId = ctx.from?.id || ctx.chat?.id;
    if (!telegramId) {
      await ctx.reply('❌ No se pudo identificar tu usuario.');
      return null;
    }
    const user = await findOrCreateUser(telegramId, ctx.from?.first_name || '');
    return user;
  }

  async function requireRegistered(ctx, user) {
    if (!user) {
      const u = await ensureUser(ctx);
      if (!u) return null;
      user = u;
    }

    if (!isAllowed(user)) {
      if (!user.whitelisted) {
        await ctx.reply(
          '⏳ *Esperando aprobación*\n\n' +
          'Tu usuario está registrado pero necesita ser aprobado por un administrador.\n\n' +
          'Contacta al admin para que te agregue a la whitelist.',
          { parse_mode: 'Markdown' }
        );
      } else if (!user.is_active) {
        await ctx.reply('❌ Tu cuenta ha sido desactivada. Contacta al administrador.');
      }
      return null;
    }

    return user;
  }

  async function requireCredentials(ctx, user) {
    const creds = await getCredentials(user.id);
    if (!creds || !creds.service_account_json || !creds.spreadsheet_id) {
      await ctx.reply(
        '⚠️ *Configuración pendiente*\n\n' +
        'Antes de usar el bot, necesitas configurar tu conexión a Google Sheets.\n\n' +
        'Usa /setup para comenzar la configuración.\n\n' +
        'Necesitarás:\n' +
        '1️⃣ El JSON de tu Service Account de Google Cloud\n' +
        '2️⃣ El ID de tu hoja de cálculo de Google Sheets\n\n' +
        '¿Listo? Envía /setup',
        { parse_mode: 'Markdown' }
      );
      return null;
    }
    return creds;
  }

  bot.command('start', async (ctx) => {
    const telegramId = ctx.from?.id || ctx.chat?.id;
    const user = await ensureUser(ctx);

    if (!user) return;

    if (!isAllowed(user)) {
      if (!user.whitelisted) {
        await ctx.reply(
          '👋 *Bienvenido al Automatizador de Pagos*\n\n' +
          'Tu usuario está registrado. Ahora necesitas que un administrador te apruebe.\n\n' +
          `📌 *Tu ID de Telegram:* \`${telegramId}\`\n\n` +
          'Envía este ID al administrador para que te agregue a la whitelist.',
          { parse_mode: 'Markdown' }
        );
      } else if (!user.is_active) {
        await ctx.reply('❌ Tu cuenta ha sido desactivada.');
      }
      return;
    }

    const creds = await getCredentials(user.id);
    let configStatus = creds?.spreadsheet_id
      ? `✅ Conectado a spreadsheet: \`${creds.spreadsheet_id}\``
      : '⚠️ *No has configurado tu hoja de cálculo.* Usa /setup para empezar.';

    await ctx.reply(
      '👋 *Bienvenido al Automatizador de Pagos*\n\n' +
      '📸 Envíame una *captura* de un Pago Móvil y yo:\n' +
      '1️⃣ Extraeré los datos (monto, fecha, ref, concepto)\n' +
      '2️⃣ Calcularé el equivalente en $ (tasa del día)\n' +
      '3️⃣ Lo agregaré a *tu* Google Sheets\n\n' +
      `${configStatus}\n\n` +
      `📌 *Tu ID:* \`${telegramId}\`\n\n` +
      'Comandos:\n' +
      '/setup — Configurar tu Google Sheets\n' +
      '/config — Ver tu configuración actual\n' +
      '/status — Probar conexión a tu hoja\n' +
      '/tasa — Ver la tasa de cambio del día\n' +
      '/ultimo — Ver tu último registro\n' +
      '/mystats — Ver estadísticas de tus pagos\n' +
      '/cancelar — Cancelar operación pendiente',
      { parse_mode: 'Markdown' }
    );
  });

  bot.command('setup', async (ctx) => {
    const user = await requireRegistered(ctx);
    if (!user) return;

    await ctx.reply(
      '🔧 *Configuración de Google Sheets*\n\n' +
      'Paso 1: *Service Account*\n\n' +
      'Necesitas un Service Account de Google Cloud con acceso a Google Sheets.\n\n' +
      'Si no tienes uno:\n' +
      '1. Ve a https://console.cloud.google.com/\n' +
      '2. Crea un proyecto o selecciona uno existente\n' +
      '3. Ve a "IAM y Administración" > "Cuentas de servicio"\n' +
      '4. Crea una cuenta de servicio y genera una clave JSON\n' +
      '5. Descarga el archivo JSON\n\n' +
      '*Envía el contenido del JSON como un mensaje de texto* (empieza con `{` y termina con `}`).\n\n' +
      '¿Listo? Envía tu JSON de Service Account:',
      { parse_mode: 'Markdown' }
    );

    pendingConfirmations.set(`setup:sa:${ctx.chat.id}`, { userId: user.id });
  });

  bot.command('config', async (ctx) => {
    const user = await requireRegistered(ctx);
    if (!user) return;

    const creds = await getCredentials(user.id);
    const prefs = await getPreferences(user.id);

    const lines = [
      '📋 *Tu configuración*\n',
      `📊 Spreadsheet ID: \`${creds?.spreadsheet_id || '❌ No configurado'}\``,
      `🔑 Service Account: ${creds?.service_account_json ? '✅ Configurado' : '❌ No configurado'}`,
      '',
      '💱 *Preferencias de tasa:*',
      `   Fuente: \`${prefs?.exchange_source || 'dolarapi'}\``,
      `   Modo: \`${prefs?.exchange_mode || 'oficial'}\``,
    ];

    if (prefs?.sheet_columns) {
      lines.push('', '📐 *Formato de columnas:*');
      const cols = prefs.sheet_columns;
      if (cols.columnas) {
        lines.push(`   Columnas: ${cols.columnas.join(', ')}`);
      }
    }

    lines.push('', 'Para cambiar la configuración, usa /setup');

    const msg = lines.join('\n');
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  bot.command('status', async (ctx) => {
    const user = await requireRegistered(ctx);
    if (!user) return;

    const creds = await requireCredentials(ctx, user);
    if (!creds) return;

    const statusMsg = await ctx.reply('🔍 Probando conexión a Google Sheets...');

    try {
      const prefs = await getPreferences(user.id);
      const sheets = new SheetsManager({
        serviceAccountJson: creds.service_account_json,
        spreadsheetId: creds.spreadsheet_id,
        sheetColumns: prefs?.sheet_columns || null,
      });

      await sheets.init();

      const lastRow = await sheets.getLastDataRow();

      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `✅ *Conexión exitosa*\n\n` +
        `📊 Spreadsheet: \`${creds.spreadsheet_id}\`\n` +
        `📝 Hojas disponibles: ${sheets._existingSheets.length}\n` +
        `📄 Última fila con datos: ${lastRow}\n\n` +
        `Todo funcionando correctamente.`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `❌ *Error de conexión*\n\n${escMD(err.message)}`,
        { parse_mode: 'Markdown' }
      );
    }
  });

  bot.command('mystats', async (ctx) => {
    const user = await requireRegistered(ctx);
    if (!user) return;

    try {
      const stats = await getPaymentStats(user.id);
      if (!stats || stats.total_payments === 0) {
        await ctx.reply('📭 Aún no has registrado pagos.');
        return;
      }

      await ctx.reply(
        `📊 *Tus estadísticas*\n\n` +
        `📦 Total de pagos: ${stats.total_payments}\n` +
        `💰 Total Bs.: ${escMD(Number(stats.total_bs).toLocaleString('es-VE', { minimumFractionDigits: 2 }))}\n` +
        `💵 Total USD: ${escMD(Number(stats.total_usd).toLocaleString('es-VE', { minimumFractionDigits: 2 }))}\n` +
        `📅 Primer pago: ${stats.first_payment ? new Date(stats.first_payment).toLocaleDateString('es-VE') : '—'}\n` +
        `📅 Último pago: ${stats.last_payment ? new Date(stats.last_payment).toLocaleDateString('es-VE') : '—'}`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      await ctx.reply(`❌ Error: ${err.message}`);
    }
  });

  bot.command('tasa', async (ctx) => {
    if (!await requireRegistered(ctx)) return;

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

  bot.command('ultimo', async (ctx) => {
    const user = await requireRegistered(ctx);
    if (!user) return;

    const creds = await requireCredentials(ctx, user);
    if (!creds) return;

    try {
      const prefs = await getPreferences(user.id);
      const sheets = new SheetsManager({
        serviceAccountJson: creds.service_account_json,
        spreadsheetId: creds.spreadsheet_id,
        sheetColumns: prefs?.sheet_columns || null,
      });

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

  bot.command('cancelar', async (ctx) => {
    const confirmKey = `confirm:${ctx.chat.id}`;
    const saKey = `setup:sa:${ctx.chat.id}`;
    const sidKey = `setup:sid:${ctx.chat.id}`;

    if (pendingConfirmations.has(confirmKey)) {
      pendingConfirmations.delete(confirmKey);
      await ctx.reply('✅ Operación cancelada.');
    } else if (pendingConfirmations.has(saKey)) {
      pendingConfirmations.delete(saKey);
      await ctx.reply('✅ Configuración cancelada.');
    } else if (pendingConfirmations.has(sidKey)) {
      pendingConfirmations.delete(sidKey);
      await ctx.reply('✅ Configuración cancelada.');
    } else {
      await ctx.reply('No hay ninguna operación pendiente.');
    }
  });

  bot.command('cache', async (ctx) => {
    if (!await requireRegistered(ctx)) return;
    const rates = getCachedRates();
    if (typeof rates === 'string' && rates.startsWith('📭')) {
      await ctx.reply(rates);
    } else {
      await ctx.reply(`🗂️ *Tasas cacheadas:*\n\n${escMD(rates)}`, { parse_mode: 'Markdown' });
    }
  });

  bot.command('help', async (ctx) => {
    const user = await requireRegistered(ctx);
    if (!user) return;

    const helpLines = [
      '📚 *Comandos disponibles*\n',
      '📸 *Envíame una foto* de un Pago Móvil para procesarlo',
      '',
      '🔧 *Configuración*',
      '/setup — Configurar Google Sheets (SA JSON + Spreadsheet ID)',
      '/config — Ver configuración actual',
      '/status — Probar conexión a tu hoja',
      '',
      '📊 *Información*',
      '/tasa — Tasa de cambio del día',
      '/ultimo — Último registro en tu hoja',
      '/mystats — Estadísticas de tus pagos',
      '/cache — Tasas cacheadas',
      '',
      '🛠️ *Utilidades*',
      '/cancelar — Cancelar operación pendiente',
      '/help — Mostrar esta ayuda',
    ];

    if (isAdmin(ctx.from?.id)) {
      helpLines.push(
        '',
        '👑 *Admin*',
        '/whitelist add [telegram_id] — Aprobar usuario',
        '/whitelist remove [telegram_id] — Desaprobar usuario',
        '/listusers — Listar todos los usuarios',
        '/removeuser [telegram_id] — Eliminar usuario',
        '/broadcast [mensaje] — Enviar mensaje a todos',
      );
    }

    await ctx.reply(helpLines.join('\n'), { parse_mode: 'Markdown' });
  });

  if (isAdmin(config.telegram.adminId)) {
    bot.command('whitelist', async (ctx) => {
      if (!isAdmin(ctx.from?.id)) {
        await ctx.reply('❌ Solo el administrador puede usar este comando.');
        return;
      }

      const args = ctx.match?.trim().split(/\s+/);
      if (!args || args.length < 2) {
        await ctx.reply(
          'Uso:\n' +
          '/whitelist add [telegram_id] — Aprobar usuario\n' +
          '/whitelist remove [telegram_id] — Quitar aprobación',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const action = args[0].toLowerCase();
      const targetId = parseInt(args[1], 10);
      if (isNaN(targetId)) {
        await ctx.reply('❌ Telegram ID inválido.');
        return;
      }

      try {
        if (action === 'add') {
          const user = await setUserWhitelisted(targetId, true);
          if (user) {
            await ctx.reply(`✅ Usuario \`${targetId}\` (${user.name || 'sin nombre'}) aprobado.`, { parse_mode: 'Markdown' });
          } else {
            await ctx.reply(`⚠️ Usuario \`${targetId}\` no encontrado. Primero debe enviar /start al bot.`, { parse_mode: 'Markdown' });
          }
        } else if (action === 'remove') {
          const user = await setUserWhitelisted(targetId, false);
          if (user) {
            await ctx.reply(`✅ Usuario \`${targetId}\` desaprobado.`, { parse_mode: 'Markdown' });
          } else {
            await ctx.reply(`⚠️ Usuario \`${targetId}\` no encontrado.`, { parse_mode: 'Markdown' });
          }
        } else {
          await ctx.reply('❌ Acción inválida. Usa `add` o `remove`.', { parse_mode: 'Markdown' });
        }
      } catch (err) {
        await ctx.reply(`❌ Error: ${err.message}`);
      }
    });

    bot.command('listusers', async (ctx) => {
      if (!isAdmin(ctx.from?.id)) {
        await ctx.reply('❌ Solo el administrador puede usar este comando.');
        return;
      }

      try {
        const users = await listUsers();
        if (users.length === 0) {
          await ctx.reply('📭 No hay usuarios registrados.');
          return;
        }

        const lines = users.map(u => {
          const status = u.is_active ? (u.whitelisted ? '✅' : '⏳') : '❌';
          const name = u.name || '(sin nombre)';
          return `${status} \`${u.telegram_id}\` — ${escMD(name)}${u.is_admin ? ' 👑' : ''}`;
        });

        const header = `👥 *Usuarios (${users.length})*\n\n`;
        const msg = header + lines.join('\n');

        const chunks = chunkString(msg);
        for (const chunk of chunks) {
          await ctx.reply(chunk, { parse_mode: 'Markdown' });
        }
      } catch (err) {
        await ctx.reply(`❌ Error: ${err.message}`);
      }
    });

    bot.command('removeuser', async (ctx) => {
      if (!isAdmin(ctx.from?.id)) return;

      const args = ctx.match?.trim().split(/\s+/);
      if (!args || args.length < 1) {
        await ctx.reply('Uso: /removeuser [telegram_id]');
        return;
      }

      const targetId = parseInt(args[0], 10);
      if (isNaN(targetId)) {
        await ctx.reply('❌ Telegram ID inválido.');
        return;
      }

      try {
        const user = await setUserActive(targetId, false);
        if (user) {
          await ctx.reply(`✅ Usuario \`${targetId}\` desactivado.`, { parse_mode: 'Markdown' });
        } else {
          await ctx.reply(`⚠️ Usuario \`${targetId}\` no encontrado.`, { parse_mode: 'Markdown' });
        }
      } catch (err) {
        await ctx.reply(`❌ Error: ${err.message}`);
      }
    });

    bot.command('broadcast', async (ctx) => {
      if (!isAdmin(ctx.from?.id)) return;

      const message = ctx.match?.trim();
      if (!message) {
        await ctx.reply('Uso: /broadcast [mensaje]');
        return;
      }

      try {
        const users = await listUsers();
        let sent = 0;
        let failed = 0;

        await ctx.reply(`📤 Enviando mensaje a ${users.length} usuarios...`);

        for (const user of users) {
          if (!user.is_active) continue;
          try {
            await ctx.api.sendMessage(user.telegram_id, `📢 *Comunicado:*\n\n${message}`, { parse_mode: 'Markdown' });
            sent++;
          } catch {
            failed++;
          }
        }

        await ctx.reply(`✅ Mensaje enviado: ${sent} usuarios, ${failed} fallos.`);
      } catch (err) {
        await ctx.reply(`❌ Error: ${err.message}`);
      }
    });
  }

  bot.on(':photo', async (ctx) => {
    const user = await requireRegistered(ctx);
    if (!user) return;

    const creds = await requireCredentials(ctx, user);
    if (!creds) return;

    try {
      await ctx.reply('📥 Descargando imagen...');

      const file = await ctx.getFile();
      if (!file.file_path) {
        await ctx.reply('❌ No se pudo obtener la ruta del archivo.');
        return;
      }

      const localPath = path.join(TEMP_DIR, `payment_${Date.now()}.jpg`);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;

      const response = await fetch(fileUrl, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) {
        throw new Error(`Telegram API respondió con ${response.status}: ${response.statusText}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(localPath, buffer);

      await ctx.reply('📸 Imagen recibida, extrayendo datos...');

      const rawText = await extractTextFromImage(localPath);
      await fs.unlink(localPath).catch(() => {});
      logger.info('OCR completado', { userId: user.id, length: rawText?.length });

      if (!rawText || rawText.trim().length < 20) {
        await ctx.reply(
          '❌ No se pudo extraer texto de la imagen. ' +
          'Asegúrate de que la captura sea clara y legible.'
        );
        return;
      }

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

      await ctx.reply('💱 Obteniendo tasa de cambio del día...');
      let tasaData;
      try {
        tasaData = await getExchangeRate(parsed.fecha);
      } catch (err) {
        tasaData = { rate: null, source: 'No disponible' };
        await ctx.reply(
          `⚠️ No se pudo obtener la tasa: ${err.message}. Se usará "N/A" para dólares.`
        );
      }

      const montoDolares = tasaData.rate
        ? (parsed.montoBolivares / tasaData.rate).toFixed(2)
        : 'N/A';

      pendingConfirmations.set(`confirm:${ctx.chat.id}`, {
        parsed,
        tasaBs: tasaData.rate,
        montoDolares,
        userId: user.id,
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
          (parsed.concepto ? ` - ${escMD(parsed.concepto || '')}` : '') + '\n\n' +
        `¿Guardar en tu hoja de cálculo?`,
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
      logger.error('Error procesando imagen', { userId: user.id, error: err.message });
      await ctx.reply(`❌ Error procesando la imagen: ${err.message}`);
    }
  });

  bot.on('callback_query:data', async (ctx) => {
    const chatId = ctx.chat.id;
    const data = ctx.callbackQuery.data;
    const key = `confirm:${chatId}`;

    if (!pendingConfirmations.has(key)) {
      await ctx.answerCallbackQuery('No hay operación pendiente');
      return;
    }

    const pending = pendingConfirmations.get(key);

    if (data === 'cancel') {
      pendingConfirmations.delete(key);
      await ctx.editMessageText('❌ Operación cancelada.');
      await ctx.answerCallbackQuery('Cancelado');
      return;
    }

    if (data === 'confirm') {
      try {
        await ctx.editMessageText('💾 Guardando en Google Sheets...');

        const creds = await getCredentials(pending.userId);
        if (!creds || !creds.service_account_json) {
          await ctx.reply('❌ No se encontraron tus credenciales. Usa /setup para configurar.');
          pendingConfirmations.delete(key);
          return;
        }

        const prefs = await getPreferences(pending.userId);
        const sheets = new SheetsManager({
          serviceAccountJson: creds.service_account_json,
          spreadsheetId: creds.spreadsheet_id,
          sheetColumns: prefs?.sheet_columns || null,
        });

        const result = await sheets.appendPayment(pending.parsed, pending.tasaBs);

        await logPayment(pending.userId, {
          amountBs: pending.parsed.montoBolivares,
          amountUsd: pending.tasaBs ? parseFloat(pending.montoDolares) : null,
          exchangeRate: pending.tasaBs,
          fecha: pending.parsed.fecha,
          referencia: pending.parsed.referencia,
          concepto: pending.parsed.concepto,
          banco: pending.parsed.bancoEmisor || pending.parsed.banco,
          sheetName: result.sheetName,
        });

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
        logger.error('Error guardando pago', { userId: pending.userId, error: err.message });
        await ctx.reply(`❌ Error al guardar: ${err.message}`);
        await ctx.answerCallbackQuery('Error');
      } finally {
        pendingConfirmations.delete(key);
      }
    }
  });

  bot.on('message:text', async (ctx) => {
    if (ctx.msg.text?.startsWith('/')) return;

    const saKey = `setup:sa:${ctx.chat.id}`;
    const sidKey = `setup:sid:${ctx.chat.id}`;

    if (pendingConfirmations.has(saKey)) {
      const setup = pendingConfirmations.get(saKey);
      const text = ctx.msg.text.trim();

      if (!text.startsWith('{')) {
        await ctx.reply(
          '❌ Eso no parece un JSON válido. El Service Account JSON debe empezar con `{`.\n\n' +
          'Envía el contenido completo del archivo JSON que descargaste de Google Cloud.\n\n' +
          'O usa /cancelar para salir.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      let parsedJson;
      try {
        parsedJson = JSON.parse(text);
        if (!parsedJson.client_email || !parsedJson.private_key) {
          throw new Error('Faltan campos requeridos (client_email, private_key)');
        }
      } catch (err) {
        const detail = err.message.includes('Faltan')
          ? err.message
          : 'El JSON no es válido. Verifica que copiaste el archivo completo.';
        await ctx.reply(`❌ ${detail}\n\nIntenta de nuevo o usa /cancelar para salir.`);
        return;
      }

      await ctx.reply(
        '✅ *Service Account configurado!*\n\n' +
        'Paso 2: *Spreadsheet ID*\n\n' +
        'Abre tu hoja de Google Sheets y copia el ID de la URL:\n' +
        '`https://docs.google.com/spreadsheets/d/`**`SPREADSHEET_ID`**`/edit`\n\n' +
        '*Importante:* La hoja debe estar compartida con:\n' +
        `\`${parsedJson.client_email}\`\n\n` +
        'Envía el Spreadsheet ID:',
        { parse_mode: 'Markdown' }
      );

      pendingConfirmations.set(sidKey, {
        userId: setup.userId,
        serviceAccountJson: text,
      });
      pendingConfirmations.delete(saKey);
      return;
    }

    if (pendingConfirmations.has(sidKey)) {
      const setup = pendingConfirmations.get(sidKey);
      const spreadsheetId = ctx.msg.text.trim();

      if (!spreadsheetId || spreadsheetId.length < 10) {
        await ctx.reply(
          '❌ Ese no parece un Spreadsheet ID válido.\n\n' +
          'El ID está en la URL de tu hoja:\n' +
          '`https://docs.google.com/spreadsheets/d/`**`ACA_EL_ID`**`/edit`\n\n' +
          'O usa /cancelar para salir.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const statusMsg = await ctx.reply('🔍 Probando conexión a la hoja...');

      try {
        const sheets = new SheetsManager({
          serviceAccountJson: setup.serviceAccountJson,
          spreadsheetId,
        });
        await sheets.init();

        await saveCredentials(setup.userId, {
          serviceAccountJson: setup.serviceAccountJson,
          spreadsheetId,
        });

        const defaultCols = await getDefaultSheetColumns();
        await upsertPreferences(setup.userId, { sheetColumns: defaultCols });

        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `✅ *Configuración completada!*\n\n` +
          `✅ Service Account configurado\n` +
          `✅ Spreadsheet conectado: \`${spreadsheetId}\`\n\n` +
          `Ahora puedes enviarme capturas de Pago Móvil para registrarlas automáticamente en tu hoja. 📸`,
          { parse_mode: 'Markdown' }
        );

        logger.info('Usuario configuró Google Sheets', { userId: setup.userId, spreadsheetId });
      } catch (err) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `❌ *Error conectando a la hoja*\n\n${escMD(err.message)}\n\n` +
          `Verifica que:\n` +
          `1️⃣ El Spreadsheet ID es correcto\n` +
          `2️⃣ La hoja está compartida con \`${JSON.parse(setup.serviceAccountJson).client_email}\`\n` +
          `3️⃣ El Service Account tiene permisos de editor\n\n` +
          `Usa /setup para intentar de nuevo.`,
          { parse_mode: 'Markdown' }
        );
      } finally {
        pendingConfirmations.delete(sidKey);
      }
      return;
    }
  });

  setInterval(() => {
    const now = Date.now();
    for (const [key, pending] of pendingConfirmations) {
      if (pending._createdAt && (now - pending._createdAt) > 30 * 60 * 1000) {
        pendingConfirmations.delete(key);
        logger.debug(`Confirmación caducada: ${key}`);
      }
    }
  }, 5 * 60 * 1000);

  setInterval(async () => {
    try {
      const files = await fs.readdir(TEMP_DIR);
      for (const f of files) {
        await fs.unlink(path.join(TEMP_DIR, f)).catch(() => {});
      }
      if (files.length > 0) logger.info(`Limpieza periódica: ${files.length} archivos`);
    } catch { /* ok */ }
  }, 60 * 60 * 1000);

  bot.catch((err) => {
    logger.error('Bot error', { error: err.message, stack: err.stack });
  });

  process.once('SIGINT', () => bot.stop());
  process.once('SIGTERM', () => bot.stop());

  logger.info('Bot listo para recibir imágenes');
  await bot.start();
}

startBot().catch(err => {
  logger.error('Error fatal', { error: err.message, stack: err.stack });
  process.exit(1);
});
