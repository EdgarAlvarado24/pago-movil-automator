#!/usr/bin/env node
/**
 * Actualización diaria de la tasa de cambio.
 * Este script es invocado por cron para precargar la tasa
 * sin necesidad de interacción del usuario.
 */
import { getExchangeRate } from '../src/exchange-rate.js';

try {
  const result = await getExchangeRate();
  console.log(`✅ Tasa diaria: Bs. ${result.rate}/USD (${result.source})`);
  process.exit(0);
} catch (err) {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
}
