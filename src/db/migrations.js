import logger from '../logger.js';
import { query } from './index.js';

const MIGRATIONS = [
  {
    name: '001_create_users',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT NOT NULL UNIQUE,
        name VARCHAR(255),
        is_admin BOOLEAN NOT NULL DEFAULT false,
        is_active BOOLEAN NOT NULL DEFAULT true,
        whitelisted BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    name: '002_create_user_credentials',
    sql: `
      CREATE TABLE IF NOT EXISTS user_credentials (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        service_account_json TEXT,
        spreadsheet_id VARCHAR(255),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    name: '003_create_user_preferences',
    sql: `
      CREATE TABLE IF NOT EXISTS user_preferences (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        exchange_source VARCHAR(20) NOT NULL DEFAULT 'dolarapi',
        exchange_mode VARCHAR(20) NOT NULL DEFAULT 'oficial',
        sheet_columns JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    name: '004_create_payment_log',
    sql: `
      CREATE TABLE IF NOT EXISTS payment_log (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount_bs NUMERIC(12, 2),
        amount_usd NUMERIC(12, 2),
        exchange_rate NUMERIC(12, 2),
        fecha VARCHAR(10),
        referencia VARCHAR(50),
        concepto TEXT,
        banco VARCHAR(50),
        sheet_name VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  },
  {
    name: '005_add_updated_at_trigger',
    sql: `
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger WHERE tgname = 'update_users_updated_at'
        ) THEN
          CREATE TRIGGER update_users_updated_at
            BEFORE UPDATE ON users
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger WHERE tgname = 'update_user_credentials_updated_at'
        ) THEN
          CREATE TRIGGER update_user_credentials_updated_at
            BEFORE UPDATE ON user_credentials
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_trigger WHERE tgname = 'update_user_preferences_updated_at'
        ) THEN
          CREATE TRIGGER update_user_preferences_updated_at
            BEFORE UPDATE ON user_preferences
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END;
      $$;
    `,
  },
  {
    name: '006_insert_admin_user',
    sql: `
      INSERT INTO users (telegram_id, name, is_admin, whitelisted)
      VALUES ($1, 'Admin', true, true)
      ON CONFLICT (telegram_id) DO NOTHING;
    `,
  },
];

export async function runMigrations() {
  logger.info('Ejecutando migraciones de base de datos...');

  await query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  for (const migration of MIGRATIONS) {
    const { rows } = await query('SELECT id FROM migrations WHERE name = $1', [migration.name]);
    if (rows.length > 0) {
      logger.debug(`Migración ya ejecutada: ${migration.name}`);
      continue;
    }

    try {
      if (migration.name === '006_insert_admin_user') {
        const adminId = process.env.ADMIN_TELEGRAM_ID;
        if (!adminId) {
          logger.warn('ADMIN_TELEGRAM_ID no configurado. No se insertó usuario admin.');
          await query('INSERT INTO migrations (name) VALUES ($1)', [migration.name]);
          continue;
        }
        await query(migration.sql, [parseInt(adminId, 10)]);
      } else {
        await query(migration.sql);
      }

      await query('INSERT INTO migrations (name) VALUES ($1)', [migration.name]);
      logger.info(`Migración ejecutada: ${migration.name}`);
    } catch (err) {
      logger.error(`Error en migración ${migration.name}`, { error: err.message });
      throw err;
    }
  }

  logger.info('Migraciones completadas.');
}
