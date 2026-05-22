import { query } from './index.js';
import { encrypt, decrypt } from '../encryption.js';

export async function findUserByTelegramId(telegramId) {
  const { rows } = await query(
    'SELECT * FROM users WHERE telegram_id = $1',
    [telegramId]
  );
  return rows[0] || null;
}

export async function findOrCreateUser(telegramId, name) {
  const { rows } = await query(
    `INSERT INTO users (telegram_id, name, whitelisted)
     VALUES ($1, $2, false)
     ON CONFLICT (telegram_id)
     DO UPDATE SET name = COALESCE(NULLIF($2, ''), users.name)
     RETURNING *`,
    [telegramId, name || null]
  );
  return rows[0];
}

export async function setUserWhitelisted(telegramId, whitelisted) {
  const { rows } = await query(
    'UPDATE users SET whitelisted = $2 WHERE telegram_id = $1 RETURNING *',
    [telegramId, whitelisted]
  );
  return rows[0] || null;
}

export async function setUserActive(telegramId, active) {
  const { rows } = await query(
    'UPDATE users SET is_active = $2 WHERE telegram_id = $1 RETURNING *',
    [telegramId, active]
  );
  return rows[0] || null;
}

export async function listUsers() {
  const { rows } = await query(
    'SELECT id, telegram_id, name, is_admin, is_active, whitelisted, created_at FROM users ORDER BY created_at DESC'
  );
  return rows;
}

export async function listActiveUsers() {
  const { rows } = await query(
    'SELECT id, telegram_id, name, is_admin, is_active, whitelisted, created_at FROM users WHERE is_active = true ORDER BY created_at DESC'
  );
  return rows;
}

export async function getCredentials(userId) {
  const { rows } = await query(
    'SELECT * FROM user_credentials WHERE user_id = $1',
    [userId]
  );
  if (!rows[0]) return null;

  const cred = rows[0];
  return {
    ...cred,
    service_account_json: cred.service_account_json
      ? decrypt(cred.service_account_json)
      : null,
  };
}

export async function saveCredentials(userId, { serviceAccountJson, spreadsheetId }) {
  const encrypted = serviceAccountJson ? encrypt(serviceAccountJson) : null;

  const { rows } = await query(
    `INSERT INTO user_credentials (user_id, service_account_json, spreadsheet_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id)
     DO UPDATE SET service_account_json = COALESCE($2, user_credentials.service_account_json),
                   spreadsheet_id = COALESCE($3, user_credentials.spreadsheet_id)
     RETURNING *`,
    [userId, encrypted, spreadsheetId || null]
  );
  return rows[0];
}

export async function getPreferences(userId) {
  const { rows } = await query(
    'SELECT * FROM user_preferences WHERE user_id = $1',
    [userId]
  );
  return rows[0] || null;
}

const DEFAULT_SHEET_COLUMNS = {
  columnas: ['Fecha', 'Bolivares', 'Dolares', 'Especificacion', 'Entradas/Salidas'],
  mapping: {
    fecha: { col: 0, formato: 'DD/MM/YYYY' },
    bolivares: { col: 1, formato: 'Bs{{value}}' },
    dolares: { col: 2, formato: '${{value}}' },
    especificacion: { col: 3, formato: 'Ref: {{reference}} - {{concept}}' },
    tipo: { col: 4, formato: '{{value}}' },
  },
  fila_inicio: 2,
  encabezados: true,
};

export async function upsertPreferences(userId, prefs = {}) {
  const current = await getPreferences(userId);

  const exchangeSource = prefs.exchangeSource || current?.exchange_source || 'dolarapi';
  const exchangeMode = prefs.exchangeMode || current?.exchange_mode || 'oficial';
  const sheetColumns = prefs.sheetColumns || current?.sheet_columns || DEFAULT_SHEET_COLUMNS;

  const { rows } = await query(
    `INSERT INTO user_preferences (user_id, exchange_source, exchange_mode, sheet_columns)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (user_id)
     DO UPDATE SET exchange_source = $2,
                   exchange_mode = $3,
                   sheet_columns = $4::jsonb
     RETURNING *`,
    [userId, exchangeSource, exchangeMode, JSON.stringify(sheetColumns)]
  );
  return rows[0];
}

export async function logPayment(userId, { amountBs, amountUsd, exchangeRate, fecha, referencia, concepto, banco, sheetName }) {
  const { rows } = await query(
    `INSERT INTO payment_log (user_id, amount_bs, amount_usd, exchange_rate, fecha, referencia, concepto, banco, sheet_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [userId, amountBs, amountUsd, exchangeRate, fecha, referencia, concepto, banco, sheetName]
  );
  return rows[0];
}

export async function getPaymentStats(userId) {
  const { rows } = await query(
    `SELECT
       COUNT(*)::int AS total_payments,
       COALESCE(SUM(amount_bs), 0) AS total_bs,
       COALESCE(SUM(amount_usd), 0) AS total_usd,
       MIN(created_at) AS first_payment,
       MAX(created_at) AS last_payment
     FROM payment_log
     WHERE user_id = $1`,
    [userId]
  );
  return rows[0];
}

export async function getDefaultSheetColumns() {
  return DEFAULT_SHEET_COLUMNS;
}
