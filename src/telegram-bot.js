#!/usr/bin/env node

import { Bot } from 'grammy';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { config } from './config.js';
import { PagoMovilParser } from './parser.js';
import { getExchangeRate, getCachedRates } from './exchange-rate.js';
import { SheetsManager, createSpreadsheet } from './sheets.js';
import { extractTextFromImage } from './ocr.js';
import { runMigrations } from './db/migrations.js';
import {
  findOrCreateUser,
  getCredentials,
  saveOAuthTokens,
  getPreferences,
  upsertPreferences,
  listUsers,
  setUserWhitelisted,
  setUserActive,
  logPayment,
  getPaymentStats,
  getDefaultSheetColumns,
  deleteUserData,
} from './db/queries.js';
import { generateAuthUrl, exchangeCode, refreshAccessTokenIfNeeded } from './oauth.js';
import { startAuthServer } from './auth-server.js';
import logger from './logger.js';

const TEMP_DIR = path.join(os.tmpdir(), 'pago-movil-bot');
const pendingConfirmations = new Map();
const oauthPending = new Map();
const rateLimit = new Map();
const RATE_LIMIT_WINDOW = 60_000;
const RATE_LIMIT_MAX = 10;

function checkRateLimit(telegramId) {
  const now = Date.now();
  const entry = rateLimit.get(telegramId) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW;
  }

  entry.count++;
  rateLimit.set(telegramId, entry);

  if (entry.count > RATE_LIMIT_MAX) {
    const waitSec = Math.ceil((entry.resetAt - now) / 1000);
    return { allowed: false, waitSec };
  }

  return { allowed: true };
}

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
    const hasAuth = creds?.refresh_token;
    if (!hasAuth || !creds?.spreadsheet_id) {
      await ctx.reply(
        '⚠️ *Configuración pendiente*\n\n' +
        'Antes de usar el bot, necesitas conectar tu Google Sheets.\n\n' +
        'Usa /setup y autoriza con tu cuenta de Google.\n\n' +
        'Solo toma 30 segundos. 🚀',
        { parse_mode: 'Markdown' }
      );
      return null;
    }
    return creds;
  }

  async function getSheetsManager(userId) {
    const creds = await getCredentials(userId);
    if (!creds || !creds.spreadsheet_id) return null;

    const prefs = await getPreferences(userId);
    if (!creds.refresh_token) return null;

    const accessToken = await refreshAccessTokenIfNeeded(creds.refresh_token);
    return new SheetsManager({
      accessToken,
      spreadsheetId: creds.spreadsheet_id,
      sheetColumns: prefs?.sheet_columns || null,
    });
  }

  async function _showFormatSummary(ctx, chatId, state) {
    const summary = state.columns.map((c, i) => {
      const choice = FORMAT_FIELD_CHOICES.find(f => f.field === c.field);
      const label = choice?.label || c.field || '?';
      const tmpl = c.template ? ` (${c.template})` : '';
      return `${i + 1}. "${c.name}" → ${label}${tmpl}`;
    }).join('\n');

    pendingConfirmations.set(`format:save:${chatId}`, state);
    await ctx.reply(
      `📐 *Resumen del formato*\n\n${summary}\n\n` +
      `¿Guardar este formato?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Guardar', callback_data: 'format_save' },
              { text: '❌ Cancelar', callback_data: 'format_cancel' },
            ],
          ],
        },
      }
    );
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
      '/format — Personalizar columnas de tu hoja\n' +
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

    const creds = await getCredentials(user.id);
    if (creds?.refresh_token) {
      await ctx.reply(
        '⚠️ *Ya tienes Google Sheets configurado.*\n\n' +
        'Si quieres reconectar con una cuenta diferente:\n' +
        '1. Primero revoca el acceso en: https://myaccount.google.com/permissions\n' +
        '2. Luego usa /setup de nuevo\n\n' +
        'O usa /remove para borrar tu configuración actual y empezar de cero.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (!config.oauth.clientId || !config.oauth.clientSecret) {
      await ctx.reply(
        '❌ *OAuth2 no configurado*\n\n' +
        'El administrador del bot aún no ha configurado las credenciales de Google.\n\n' +
        'Comunícate con el admin y pídele que configure:\n' +
        '• `GOOGLE_CLIENT_ID`\n' +
        '• `GOOGLE_CLIENT_SECRET`\n\n' +
        'en el archivo `.env` del servidor.\n\n' +
        'Mientras tanto, los comandos de administración siguen funcionando.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const state = crypto.randomUUID();
    const redirectUri = config.oauth.redirectUri;
    const authUrl = generateAuthUrl(state, redirectUri);

    oauthPending.set(state, {
      userId: user.id,
      chatId: ctx.chat.id,
      redirectUri,
      notify: (msg) => ctx.api.sendMessage(ctx.chat.id, msg, { parse_mode: 'Markdown' }),
      createdAt: Date.now(),
    });

    const usesLocalhost = redirectUri.includes('127.0.0.1') || redirectUri.includes('localhost');

    const autoHelp = usesLocalhost
      ? '\n✅ *Si estás en la misma máquina del bot*, la autorización será automática.'
      : '';

    await ctx.reply(
      '🔧 *Configuración con Google OAuth2*\n\n' +
      'Voy a pedirte acceso a tu Google Sheets.\n\n' +
      '1️⃣ Haz click en el enlace de abajo\n' +
      '2️⃣ Inicia sesión con tu cuenta de Google\n' +
      '3️⃣ Acepta los permisos solicitados\n' +
      '4️⃣ Vuelve a Telegram\n' +
      `${autoHelp}\n\n` +
      '❓ *¿No funciona el paso automático?*\n' +
      'Si ves un error de conexión después de autorizar:\n' +
      '   a) *Copia la URL completa* de la barra de direcciones\n' +
      '   b) Pégala aquí en el chat\n' +
      '   c) Yo extraeré el código automáticamente\n\n' +
      `🔗 [Autorizar Google Sheets](${authUrl})\n\n` +
      '⏳ *Este enlace expira en 5 minutos.*',
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  });

  bot.command('config', async (ctx) => {
    const user = await requireRegistered(ctx);
    if (!user) return;

    const creds = await getCredentials(user.id);
    const prefs = await getPreferences(user.id);

    const authMethod = creds?.refresh_token
      ? '✅ OAuth2 (Google)'
      : '❌ No configurado';

    const lines = [
      '📋 *Tu configuración*\n',
      `📊 Spreadsheet: \`${creds?.spreadsheet_id || '❌ No configurado'}\``,
      `🔑 Autenticación: ${authMethod}`,
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

    lines.push('', 'Para cambiar el formato, usa /format');

    if (prefs?.sheet_columns?.campos_disponibles) {
      lines.push('', '📎 *Campos disponibles:*');
      lines.push(`   \`${prefs.sheet_columns.campos_disponibles.join('`, `')}\``);
    }

    const msg = lines.join('\n');
    await ctx.reply(msg, { parse_mode: 'Markdown' });
  });

  const FORMAT_FIELD_CHOICES = [
    { label: '📅 Fecha', field: 'fecha', template: 'DD/MM/YYYY' },
    { label: '💰 Monto Bs', field: 'bolivares', template: 'Bs{{value}}' },
    { label: '💵 Monto USD', field: 'dolares', template: '${{value}}' },
    { label: '🔢 Referencia', field: 'referencia', template: '{{referencia}}' },
    { label: '📝 Concepto', field: 'concepto', template: '{{concepto}}' },
    { label: '📱 Pagador', field: 'pagador', template: '{{pagador}}' },
    { label: '📱 Beneficiario', field: 'beneficiario', template: '{{beneficiario}}' },
    { label: '🏦 Banco Emisor', field: 'bancoEmisor', template: '{{bancoEmisor}}' },
    { label: '🏦 Banco Receptor', field: 'bancoReceptor', template: '{{bancoReceptor}}' },
    { label: '🆔 Cédula', field: 'receptorId', template: '{{receptorId}}' },
    { label: '👤 Nombre Receptor', field: 'nombreReceptor', template: '{{nombreReceptor}}' },
    { label: '🏷️ Tipo (Entrada/Salida)', field: 'tipo', template: '{{value}}' },
    { label: '📎 Ref + Concepto', field: 'especificacion', template: 'Ref: {{reference}} - {{concept}}' },
    { label: '🏦 Origen → Destino', field: 'bancoFull', template: '{{bancoEmisor}} → {{bancoReceptor}}' },
  ];

  bot.command('format', async (ctx) => {
    const user = await requireRegistered(ctx);
    if (!user) return;

    const creds = await requireCredentials(ctx, user);
    if (!creds) return;

    const prefs = await getPreferences(user.id);
    const current = prefs?.sheet_columns;
    const curCols = current?.columnas?.join(', ') || 'Fecha, Bolivares, Dolares, Especificacion, Entradas/Salidas';

    await ctx.reply(
      `📐 *Configuración de columnas*\n\n` +
      `Formato actual: \`${curCols}\`\n\n` +
      `¿Cuántas columnas quieres en tu hoja? (máximo 10)\n` +
      `Responde solo con un número.`,
      { parse_mode: 'Markdown' }
    );

    pendingConfirmations.set(`format:init:${ctx.chat.id}`, {
      userId: user.id,
      steps: [],
      _createdAt: Date.now(),
    });
  });

  bot.command('status', async (ctx) => {
    const user = await requireRegistered(ctx);
    if (!user) return;

    const creds = await requireCredentials(ctx, user);
    if (!creds) return;

    const statusMsg = await ctx.reply('🔍 Probando conexión a Google Sheets...');

    try {
      const sheets = await getSheetsManager(user.id);
      if (!sheets) {
        await ctx.api.editMessageText(ctx.chat.id, statusMsg.message_id, '❌ No se pudo inicializar la conexión.');
        return;
      }

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
      const sheets = await getSheetsManager(user.id);
      if (!sheets) {
        await ctx.reply('❌ No se pudo inicializar la conexión a Sheets.');
        return;
      }

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
    const chatId = ctx.chat.id;
    const confirmKey = `confirm:${chatId}`;
    const choiceKey = `setup:choice:${chatId}`;
    const awaitingKey = `awaiting_sid:${chatId}`;
    const formatInitKey = `format:init:${chatId}`;
    const formatNameKey = `format:name:${chatId}`;
    const formatTemplateKey = `format:template:${chatId}`;
    const formatSaveKey = `format:save:${chatId}`;

    const anyKey = [confirmKey, choiceKey, awaitingKey, formatInitKey, formatNameKey, formatTemplateKey, formatSaveKey].find(k => pendingConfirmations.has(k));
    if (anyKey) {
      pendingConfirmations.delete(anyKey);
      await ctx.reply('✅ Operación cancelada.');
    } else {
      await ctx.reply('No hay ninguna operación pendiente.');
    }
  });

  bot.command('remove', async (ctx) => {
    const user = await ensureUser(ctx);
    if (!user) return;

    await ctx.reply(
      '⚠️ *¿Estás seguro?*\n\n' +
      'Esto eliminará todos tus datos del bot:\n' +
      '• Tus credenciales de Google\n' +
      '• Tus preferencias de formato\n' +
      '• Tu registro de pagos\n\n' +
      '*No elimina tus hojas de cálculo*, solo los datos guardados en el bot.\n\n' +
      '¿Confirmas?',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Sí, borrar mis datos', callback_data: 'remove_confirm' },
              { text: '❌ No, cancelar', callback_data: 'remove_cancel' },
            ],
          ],
        },
      }
    );
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
      '/setup — Configurar Google Sheets',
      '/config — Ver configuración actual',
      '/format — Personalizar columnas de tu hoja',
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
      '/remove — Borrar mis datos del bot',
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

    const rl = checkRateLimit(user.telegram_id);
    if (!rl.allowed) {
      await ctx.reply(`⏳ *Demasiadas solicitudes.* Espera ${rl.waitSec} segundos.`, { parse_mode: 'Markdown' });
      return;
    }

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

      const tipoInicial = 'Salida';

      pendingConfirmations.set(`confirm:${ctx.chat.id}`, {
        parsed,
        tasaBs: tasaData.rate,
        montoDolares,
        userId: user.id,
        tipo: tipoInicial,
        _createdAt: Date.now(),
      });

      const tasaStr = tasaData.rate ? escMD(tasaData.rate.toFixed(2)) : 'N/A';
      const tipoIcon = tipoInicial === 'Salida' ? '📤' : '📥';

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
        `🏦 *Receptor:* ${escMD(parsed.bancoReceptor || '?')}\n` +
        `🏷️ *Tipo:* ${tipoIcon} ${tipoInicial}\n\n` +
        `📝 *Especificación:* Ref: ${escMD(parsed.referencia || '?')}` +
          (parsed.concepto ? ` - ${escMD(parsed.concepto || '')}` : '') + '\n\n' +
        `¿Guardar en tu hoja de cálculo?`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Aceptar y guardar', callback_data: 'confirm' },
                { text: '🔄 Entrada/Salida', callback_data: 'toggle_tipo' },
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
    const confirmKey = `confirm:${chatId}`;
    const choiceKey = `setup:choice:${chatId}`;

    if (data === 'setup_cancel') {
      pendingConfirmations.delete(choiceKey);
      await ctx.editMessageText('❌ Configuración cancelada.');
      await ctx.answerCallbackQuery('Cancelado');
      return;
    }

    if (data === 'format_cancel') {
      const fKey = `format:save:${chatId}`;
      pendingConfirmations.delete(fKey);
      for (let i = 0; i < 10; i++) {
        pendingConfirmations.delete(`format:name:${chatId}:${i}`);
        pendingConfirmations.delete(`format:template:${chatId}:${i}`);
      }
      pendingConfirmations.delete(`format:cols:${chatId}`);
      await ctx.editMessageText('❌ Formato cancelado.');
      await ctx.answerCallbackQuery('Cancelado');
      return;
    }

    if (data === 'format_save') {
      const state = pendingConfirmations.get(`format:save:${chatId}`);
      if (!state) {
        await ctx.answerCallbackQuery('Sesión expirada');
        return;
      }

      const fUserId = state.userId || (await findOrCreateUser(ctx.from?.id || chatId))?.id;
      if (!fUserId) {
        await ctx.editMessageText('❌ No se pudo identificar tu usuario. Usa /start primero.');
        await ctx.answerCallbackQuery('Error');
        return;
      }

      try {
        const mapping = {};
        const columnas = [];

        state.columns.forEach((col, i) => {
          columnas.push(col.name);
          if (col.field && FORMAT_FIELD_CHOICES.some(c => c.field === col.field)) {
            mapping[col.field === 'bancoFull' ? 'especificacion' : col.field] = {
              col: i,
              formato: col.template || '{{value}}',
            };
          }
        });

        if (!mapping.fecha) {
          await ctx.answerCallbackQuery('Falta columna Fecha');
          return;
        }

        await upsertPreferences(fUserId, {
          sheetColumns: {
            columnas,
            mapping,
            fila_inicio: 2,
            encabezados: true,
            campos_disponibles: FORMAT_FIELD_CHOICES.map(c => c.field),
          },
        });

        await ctx.editMessageText(
          `✅ *Formato guardado!*\n\nColumnas: \`${columnas.join('`, `')}\``,
          { parse_mode: 'Markdown' }
        );
        await ctx.answerCallbackQuery('✅ Formato guardado');
      } catch (err) {
        await ctx.editMessageText(`❌ Error guardando formato: ${err.message}`);
        await ctx.answerCallbackQuery('Error');
      }

      pendingConfirmations.delete(`format:save:${chatId}`);
      return;
    }

    if (data.startsWith('fld_')) {
      const parts = data.split('_');
      const idx = parseInt(parts[1], 10);
      const field = parts.slice(2).join('_');
      const nameKey = `format:name:${chatId}`;

      const state = pendingConfirmations.get(nameKey);
      if (!state || !state.columns[idx]) {
        await ctx.answerCallbackQuery('Sesión expirada');
        return;
      }

      state.columns[idx].field = field;
      state.currentCol = idx;
      pendingConfirmations.delete(nameKey);
      pendingConfirmations.set(`format:template:${chatId}`, state);

      const choice = FORMAT_FIELD_CHOICES.find(c => c.field === field);
      const defaultTemplate = choice?.template || '{{value}}';

      await ctx.editMessageText(
        `Columna "${state.columns[idx].name}": escribe el formato.\n` +
        `\nUsa \`{{value}}\` para el valor principal y\n` +
        `\`{{campo}}\` para cualquier campo del parser.\n\n` +
        `Ejemplo: \`${defaultTemplate}\`\n\n` +
        `Responde con el formato o escribe "default" para usar ese.`,
        { parse_mode: 'Markdown' }
      );
      await ctx.answerCallbackQuery(choice?.label || field);
      return;
    }

    if (data.startsWith('oauth_new_')) {
      const state = data.slice(10);
      const session = oauthPending.get(state);
      if (!session || !session._tokens) {
        await ctx.editMessageText('❌ Sesión expirada. Usa /setup de nuevo.');
        await ctx.answerCallbackQuery('Error');
        return;
      }

      await ctx.editMessageText('✨ Creando hoja de cálculo...');

      try {
        const defaultCols = await getDefaultSheetColumns();
        const { spreadsheetId, spreadsheetUrl } = await createSpreadsheet({
          accessToken: session._tokens.access_token,
          sheetColumns: defaultCols,
        });

        await saveOAuthTokens(session.userId, {
          refreshToken: session._tokens.refresh_token,
          scopes: session._tokens.scope || '',
          spreadsheetId,
        });

        session._completed = true;
        session._completedAt = Date.now();
        session._spreadsheetUrl = spreadsheetUrl;

        await ctx.reply(
          `✅ *Configuración completada!*\n\n` +
          `📊 *Nueva hoja creada:*\n${spreadsheetUrl}\n\n` +
          `Ya puedes enviarme capturas de Pago Móvil! 📸`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );

        logger.info('Hoja creada vía OAuth callback', { userId: session.userId, spreadsheetId });
        await ctx.answerCallbackQuery('✅ Hoja creada');
      } catch (err) {
        logger.error('Error creando hoja', { error: err.message });
        await ctx.reply(`❌ Error creando hoja: ${err.message}\n\nUsa /setup de nuevo.`);
        await ctx.answerCallbackQuery('Error');
      }
      return;
    }

    if (data.startsWith('oauth_existing_')) {
      const state = data.slice(15);
      logger.debug('Buscando sesión oauth_existing', {
        state,
        stateLen: state.length,
        pendingSize: oauthPending.size,
        pendingStates: [...oauthPending.keys()].join(','),
        found: oauthPending.has(state),
      });
      let session = oauthPending.get(state);
      if (!session || !session._tokens) {
        session = [...oauthPending.values()].find(s => s.chatId === chatId && s._tokens);
        if (!session) {
          await ctx.editMessageText('❌ Sesión expirada. Usa /setup de nuevo.');
          await ctx.answerCallbackQuery('Error');
          return;
        }
      }

      pendingConfirmations.set(`awaiting_sid:${chatId}`, {
        userId: session.userId,
        tokens: session._tokens,
        state,
      });

      await ctx.editMessageText(
        '🔗 *Usar hoja existente*\n\n' +
        'Abre tu hoja de Google Sheets y copia el ID de la URL:\n' +
        '`https://docs.google.com/spreadsheets/d/`**`SPREADSHEET_ID`**`/edit`\n\n' +
        'Envía el ID:',
        { parse_mode: 'Markdown' }
      );
      await ctx.answerCallbackQuery('Usar existente');
      return;
    }

    if (data === 'remove_cancel') {
      await ctx.editMessageText('✅ Operación cancelada. Tus datos están a salvo.');
      await ctx.answerCallbackQuery('Cancelado');
      return;
    }

    if (data === 'remove_confirm') {
      const telegramId = ctx.from?.id || ctx.chat?.id;
      if (!telegramId) {
        await ctx.answerCallbackQuery('Error');
        return;
      }

      try {
        await ctx.editMessageText('🗑️ Eliminando tus datos...');
        await deleteUserData(telegramId);
        await ctx.reply(
          '✅ *Datos eliminados.*\n\n' +
          'Tus credenciales, preferencias y registro de pagos han sido borrados.\n\n' +
          'Si quieres volver a usar el bot, envía /start y configura todo de nuevo.',
          { parse_mode: 'Markdown' }
        );
        await ctx.answerCallbackQuery('✅ Datos eliminados');
      } catch (err) {
        logger.error('Error eliminando datos de usuario', { telegramId, error: err.message });
        await ctx.reply(`❌ Error al eliminar datos: ${err.message}`);
        await ctx.answerCallbackQuery('Error');
      }
      return;
    }

    const key = confirmKey;

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

    if (data === 'toggle_tipo') {
      const newTipo = pending.tipo === 'Salida' ? 'Entrada' : 'Salida';
      pending.tipo = newTipo;
      pendingConfirmations.set(key, pending);

      const tipoIcon = newTipo === 'Salida' ? '📤' : '📥';
      await ctx.editMessageReplyMarkup({
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Aceptar y guardar', callback_data: 'confirm' },
              { text: `🔄 ${newTipo === 'Salida' ? 'Entrada' : 'Salida'}`, callback_data: 'toggle_tipo' },
              { text: '❌ Cancelar', callback_data: 'cancel' },
            ],
          ],
        },
      });
      await ctx.answerCallbackQuery(`Tipo cambiado a: ${newTipo}`);
      return;
    }

    if (data === 'confirm') {
      try {
        await ctx.editMessageText('💾 Guardando en Google Sheets...');

        const sheets = await getSheetsManager(pending.userId);
        if (!sheets) {
          await ctx.reply('❌ No se encontraron tus credenciales. Usa /setup para configurar.');
          pendingConfirmations.delete(key);
          return;
        }

        const result = await sheets.appendPayment(pending.parsed, pending.tasaBs, pending.tipo);

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

    const text = ctx.msg.text.trim();
    const chatId = ctx.chat.id;

    // === FORMAT WIZARD ===
    const formatInitKey = `format:init:${chatId}`;
    const formatNameKey = `format:name:${chatId}`;
    const formatTemplateKey = `format:template:${chatId}`;

    if (pendingConfirmations.has(formatInitKey)) {
      const initState = pendingConfirmations.get(formatInitKey);
      const num = parseInt(text, 10);
      if (isNaN(num) || num < 1 || num > 10) {
        await ctx.reply('❌ Responde con un número entre 1 y 10.');
        return;
      }
      pendingConfirmations.delete(formatInitKey);
      pendingConfirmations.set(formatNameKey, {
        userId: initState.userId,
        columns: [],
        totalCols: num,
        currentCol: 0,
      });
      await ctx.reply(`Columna 1 de ${num}: ¿cómo se llama?`);
      return;
    }

    if (pendingConfirmations.has(formatNameKey)) {
      const state = pendingConfirmations.get(formatNameKey);
      state.columns.push({ name: text });
      const idx = state.columns.length - 1;

      const keyboard = [];
      for (let j = 0; j < FORMAT_FIELD_CHOICES.length; j += 2) {
        const row = [];
        row.push({ text: FORMAT_FIELD_CHOICES[j].label, callback_data: `fld_${idx}_${FORMAT_FIELD_CHOICES[j].field}` });
        if (FORMAT_FIELD_CHOICES[j + 1]) {
          row.push({ text: FORMAT_FIELD_CHOICES[j + 1].label, callback_data: `fld_${idx}_${FORMAT_FIELD_CHOICES[j + 1].field}` });
        }
        keyboard.push(row);
      }

      await ctx.reply(
        `Columna "${text}": ¿qué dato contiene?`,
        { reply_markup: { inline_keyboard: keyboard } }
      );
      return;
    }

    if (pendingConfirmations.has(formatTemplateKey)) {
      const state = pendingConfirmations.get(formatTemplateKey);
      const col = state.columns[state.currentCol];
      col.template = text === 'default' ? undefined : text;
      pendingConfirmations.delete(formatTemplateKey);

      state.currentCol++;
      if (state.currentCol < state.totalCols) {
        pendingConfirmations.set(formatNameKey, state);
        await ctx.reply(`Columna ${state.currentCol + 1} de ${state.totalCols}: ¿cómo se llama?`);
      } else {
        await _showFormatSummary(ctx, chatId, state);
      }
      return;
    }

    const codeMatch = text.match(/[?&]code=([^&]+)/);
    const stateMatch = text.match(/[?&]state=([^&]+)/);

    if (codeMatch && stateMatch) {
      const code = decodeURIComponent(codeMatch[1]);
      const state = decodeURIComponent(stateMatch[1]);

      const session = oauthPending.get(state);

      if (session?._completed) {
        const url = session._spreadsheetUrl;
        await ctx.reply(
          `✅ *Ya está configurado!*\n\n` +
          `Tu hoja ya fue creada:\n${url}\n\n` +
          `Envía una foto de un Pago Móvil para empezar a registrar. 📸`,
          { parse_mode: 'Markdown', disable_web_page_preview: true }
        );
        return;
      }

      if (!session) {
        const user = await findOrCreateUser(ctx.from?.id || ctx.chat?.id);
        const creds = user ? await getCredentials(user.id) : null;
        if (creds?.refresh_token || creds?.spreadsheet_id) {
          const url = `https://docs.google.com/spreadsheets/d/${creds.spreadsheet_id}/edit`;
          await ctx.reply(
            `✅ *Ya tienes configuraci\u00f3n activa!*\n\n` +
            `Tu hoja: ${url}\n\nEnv\u00eda una foto para empezar. \uD83D\uDCF8`,
            { parse_mode: 'Markdown', disable_web_page_preview: true }
          );
        } else {
          await ctx.reply('❌ Enlace expirado. Usa /setup para generar uno nuevo.');
        }
        return;
      }

      session._processing = true;
      await ctx.reply('🔑 Código recibido. Guardando acceso...');

      try {
        const tokens = await exchangeCode(code, session.redirectUri);

        session._tokens = tokens;
        session._tokensSavedAt = Date.now();

        await ctx.reply(
          '✅ *Autorización de Google recibida!*\n\n¿Qué hoja de cálculo quieres usar?',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '✨ Crear hoja nueva', callback_data: `oauth_new_${state}` },
                  { text: '🔗 Usar existente', callback_data: `oauth_existing_${state}` },
                ],
              ],
            },
          }
        );

        logger.info('Tokens guardados vía paste, esperando elección de hoja', { userId: session.userId });
      } catch (err) {
        logger.error('Error procesando código OAuth pegado', { error: err.message });
        await ctx.reply(`❌ Error: ${err.message}\n\nUsa /setup para intentar de nuevo.`);
      }
      return;
    }

    const awaitingKey = `awaiting_sid:${ctx.chat.id}`;
    if (pendingConfirmations.has(awaitingKey)) {
      const pending = pendingConfirmations.get(awaitingKey);
      const spreadsheetId = text.trim();

      if (!spreadsheetId || spreadsheetId.length < 10 || spreadsheetId.includes(' ')) {
        await ctx.reply(
          '❌ Ese no parece un ID válido.\n\n' +
          'El ID está en la URL de tu hoja:\n' +
          '`https://docs.google.com/spreadsheets/d/`**`ACA_EL_ID`**`/edit`\n\n' +
          'O usa /cancelar para salir.',
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const statusMsg = await ctx.reply('🔍 Verificando hoja...');

      try {
        const sheets = new SheetsManager({
          accessToken: await refreshAccessTokenIfNeeded(pending.tokens.refresh_token),
          spreadsheetId,
        });
        await sheets.init();

        await saveOAuthTokens(pending.userId, {
          refreshToken: pending.tokens.refresh_token,
          scopes: pending.tokens.scope || '',
          spreadsheetId,
        });

        const session = oauthPending.get(pending.state);
        if (session) {
          session._completed = true;
          session._completedAt = Date.now();
          session._spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
        }

        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `✅ *Configuración completada!*\n\n` +
          `📊 Hoja conectada: \`${spreadsheetId}\`\n\n` +
          `Ya puedes enviarme capturas de Pago Móvil! 📸`,
          { parse_mode: 'Markdown' }
        );

        logger.info('Hoja existente vinculada', { userId: pending.userId, spreadsheetId });
      } catch (err) {
        await ctx.api.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          `❌ *Error*\n\n${escMD(err.message)}\n\n` +
          `Verifica que el ID es correcto y que la hoja existe. Usa /cancelar para salir.`,
          { parse_mode: 'Markdown' }
        );
      } finally {
        pendingConfirmations.delete(awaitingKey);
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
    for (const [id, entry] of rateLimit) {
      if (now > entry.resetAt) rateLimit.delete(id);
    }
    for (const [state, session] of oauthPending) {
      if (session._completed && session._completedAt && (now - session._completedAt) > 2 * 60 * 1000) {
        oauthPending.delete(state);
        continue;
      }
      if (session.createdAt && (now - session.createdAt) > 6 * 60 * 1000) {
        oauthPending.delete(state);
        logger.debug(`Sesión OAuth caducada: ${state}`);
        session.notify?.('⏰ *Tiempo de espera agotado.* Usa /setup de nuevo para generar un nuevo enlace.', { parse_mode: 'Markdown' }).catch(() => {});
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

  if (config.oauth.clientId && config.oauth.clientSecret) {
    try {
      const authServer = await startAuthServer(config.oauth.port, oauthPending, config.telegram.token);
      logger.info(`Servidor OAuth iniciado en puerto ${config.oauth.port}`);

      process.once('SIGINT', () => { authServer.close(); bot.stop(); });
      process.once('SIGTERM', () => { authServer.close(); bot.stop(); });
    } catch (err) {
      logger.error('Error iniciando servidor OAuth', { error: err.message });
    }
  } else {
    logger.warn([
      '',
      '╔══════════════════════════════════════════════════════════════════╗',
      '║  ⚠️  OAuth2 de Google no configurado                            ║',
      '║                                                                  ║',
      '║  1. Ve a https://console.cloud.google.com/apis/credentials       ║',
      '║  2. Crea un proyecto o selecciona uno existente                  ║',
      '║  3. Habilita Google Sheets API + Google Drive API                ║',
      '║  4. "Crear ID de cliente OAuth 2.0" → "Aplicación web"          ║',
      '║  5. URI de redirección autorizada:                               ║',
      '║     ' + config.oauth.redirectUri.padEnd(59) + '║',
      '║                                                                  ║',
      '║     ⚡ Si tu máquina NO está expuesta a internet, usa:           ║',
      '║        http://127.0.0.1:3456/oauth/callback                      ║',
      '║        (Google permite loopback para apps nativas)               ║',
      '║                                                                  ║',
      '║     📋 Si el redirect falla, el usuario puede pegar la URL       ║',
      '║        de la barra de direcciones en el chat del bot.            ║',
      '║                                                                  ║',
      '║  6. Copia GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET al .env        ║',
      '╚══════════════════════════════════════════════════════════════════╝',
      '',
    ].join('\n'));
  }

  logger.info('Bot listo para recibir imágenes');
  await bot.start();
}

startBot().catch(err => {
  logger.error('Error fatal', { error: err.message, stack: err.stack });
  process.exit(1);
});
