import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

export const config = {
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    adminId: parseInt(process.env.ADMIN_TELEGRAM_ID, 10) || 0,
  },

  exchange: {
    source: process.env.EXCHANGE_SOURCE || 'dolarapi',
    mode: process.env.EXCHANGE_MODE || 'oficial',
  },

  database: {
    url: process.env.DATABASE_URL || '',
  },

  encryption: {
    key: process.env.ENCRYPTION_KEY || '',
  },
};
