/**
 * Configuración centralizada
 * Carga variables de entorno y expone objetos de configuración
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

function loadGoogleCredentials() {
  const jsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!jsonStr) {
    console.warn('⚠️ GOOGLE_SERVICE_ACCOUNT_JSON no está configurado en .env');
    return null;
  }
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('❌ Error parseando GOOGLE_SERVICE_ACCOUNT_JSON:', e.message);
    return null;
  }
}

export const config = {
  google: {
    credentials: loadGoogleCredentials(),
    spreadsheetId: process.env.SPREADSHEET_ID || '',
    sheetName: process.env.SHEET_NAME || 'Hoja1',
  },

  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    allowedUserIds: (process.env.ALLOWED_USER_IDS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(Number),
  },

  exchange: {
    source: process.env.EXCHANGE_SOURCE || 'dolarapi',
    // 'oficial' = BCV, 'paralelo' = tasa del mercado paralelo
    mode: process.env.EXCHANGE_MODE || 'oficial',
  },

  sheets: {
    // Columnas de la hoja: Fecha | Bolivares | Dolares | Especificacion | Entradas/Salidas
    // Índice 0-based
    col: {
      FECHA: 0,
      BOLIVARES: 1,
      DOLARES: 2,
      ESPECIFICACION: 3,
      ENTRADAS_SALIDAS: 4,
    },
    // Fila donde empiezan los datos (asumiendo fila 1 = encabezados)
    dataStartRow: 2,
  },
};
