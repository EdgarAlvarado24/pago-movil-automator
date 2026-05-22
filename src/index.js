#!/usr/bin/env node

import { PagoMovilParser } from './parser.js';
import { getExchangeRate } from './exchange-rate.js';
import { SheetsManager } from './sheets.js';
import logger from './logger.js';

export async function processPayment(rawText, options = {}) {
  const {
    autoConfirm = false,
    serviceAccountJson = null,
    spreadsheetId = null,
    sheetColumns = null,
  } = options;

  if (!serviceAccountJson || !spreadsheetId) {
    return {
      success: false,
      step: 'config',
      errors: ['Se requiere serviceAccountJson y spreadsheetId para multi-tenant'],
    };
  }

  const parsed = PagoMovilParser.parse(rawText);
  const validation = PagoMovilParser.validate(parsed);

  if (!validation.valid) {
    return {
      success: false,
      step: 'parse',
      errors: validation.errors,
      rawText,
    };
  }

  let tasaBs = null;
  let tasaInfo = null;
  try {
    tasaInfo = await getExchangeRate(parsed.fecha);
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
    const sheets = new SheetsManager({
      serviceAccountJson,
      spreadsheetId,
      sheetColumns,
    });
    await sheets.init();
    const result = await sheets.appendPayment(parsed, tasaBs);
    return {
      success: true,
      step: 'saved',
      preview,
      result,
    };
  }

  return {
    success: true,
    step: 'preview',
    preview,
    confirmationRequired: true,
  };
}

if (process.argv[1]?.includes('index.js') || process.argv[1]?.includes('pago-movil-automator')) {
  const args = process.argv.slice(2);
  const textFlag = args.indexOf('--text');
  const confirmFlag = args.includes('--confirm');
  const saFlag = args.indexOf('--sa');
  const ssFlag = args.indexOf('--spreadsheet');

  if (textFlag !== -1 && args[textFlag + 1]) {
    const rawText = args[textFlag + 1];
    const serviceAccountJson = saFlag !== -1 ? args[saFlag + 1] : process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const spreadsheetId = ssFlag !== -1 ? args[ssFlag + 1] : process.env.SPREADSHEET_ID;

    processPayment(rawText, {
      autoConfirm: confirmFlag,
      serviceAccountJson,
      spreadsheetId,
    })
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
    console.log('  --sa            Service Account JSON (opcional, usa env var)');
    console.log('  --spreadsheet   Spreadsheet ID (opcional, usa env var)');
  }
}
