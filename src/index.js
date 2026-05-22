#!/usr/bin/env node

import { PagoMovilParser } from './parser.js';
import { getExchangeRate } from './exchange-rate.js';
import { SheetsManager } from './sheets.js';
import { getAccessToken } from './oauth.js';
import logger from './logger.js';

export async function processPayment(rawText, options = {}) {
  const {
    autoConfirm = false,
    accessToken = null,
    spreadsheetId = null,
    sheetColumns = null,
  } = options;

  const parsed = PagoMovilParser.parse(rawText);
  const validation = PagoMovilParser.validate(parsed);

  if (!validation.valid) {
    return { success: false, step: 'parse', errors: validation.errors, rawText };
  }

  let tasaBs = null;
  try {
    const tasaInfo = await getExchangeRate(parsed.fecha);
    tasaBs = tasaInfo.rate;
  } catch (err) {
    logger.warn('No se pudo obtener tasa', { error: err.message });
  }

  const montoDolares = tasaBs ? (parsed.montoBolivares / tasaBs).toFixed(2) : 'N/A';

  const preview = {
    fecha: parsed.fecha,
    bolivares: parsed.montoBolivares,
    dolares: montoDolares,
    tasa: tasaBs,
    referencia: parsed.referencia,
    concepto: parsed.concepto,
  };

  console.log('\n' + '='.repeat(50));
  console.log('📋 DATOS EXTRAÍDOS');
  console.log('='.repeat(50));
  console.log(PagoMovilParser.formatForReview(parsed, tasaBs));
  console.log('='.repeat(50));

  if (autoConfirm) {
    if (!accessToken || !spreadsheetId) {
      return { success: false, step: 'config', errors: ['Se requiere accessToken y spreadsheetId'] };
    }
    const sheets = new SheetsManager({ accessToken, spreadsheetId, sheetColumns });
    await sheets.init();
    const result = await sheets.appendPayment(parsed, tasaBs);
    return { success: true, step: 'saved', preview, result };
  }

  return { success: true, step: 'preview', preview, confirmationRequired: true };
}

if (process.argv[1]?.includes('index.js') || process.argv[1]?.includes('pago-movil-automator')) {
  const args = process.argv.slice(2);
  const textFlag = args.indexOf('--text');
  const confirmFlag = args.includes('--confirm');

  if (textFlag !== -1 && args[textFlag + 1]) {
    const rawText = args[textFlag + 1];
    processPayment(rawText, { autoConfirm: confirmFlag })
      .then(result => {
        if (result.success && result.step === 'saved') {
          console.log('\n✅ Registro guardado en Google Sheets!');
          console.log(`   Rango: ${result.result.range}`);
        }
        process.exit(result.success ? 0 : 1);
      })
      .catch(err => {
        console.error('❌ Error:', err.message);
        process.exit(1);
      });
  } else {
    console.log('Uso: node src/index.js --text "texto OCR aqui" [--confirm]');
    console.log('  --text          Texto extraído del comprobante');
    console.log('  --confirm       Guardar automáticamente sin confirmación');
    console.log('');
    console.log('Nota: Para guardar en Google Sheets usa el bot de Telegram (npm run bot)');
  }
}
