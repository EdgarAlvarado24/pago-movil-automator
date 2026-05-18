#!/usr/bin/env node

/**
 * Pago Móvil Automator
 * Punto de entrada principal
 *
 * Este módulo procesa pagos móviles Banesco:
 * 1. Toma texto (de OCR o pegado manualmente)
 * 2. Parsea los datos
 * 3. Obtiene la tasa de cambio del día
 * 4. Muestra para revisión
 * 5. Escribe en Google Sheets (previa confirmación)
 *
 * Para uso con OpenClaw: se invoca programáticamente
 * Para uso standalone: node src/index.js --text "texto OCR" --confirm
 */

import { PagoMovilParser } from './parser.js';
import { getExchangeRate } from './exchange-rate.js';
import { SheetsManager } from './sheets.js';

/**
 * Procesa un pago móvil desde texto OCR
 * @param {string} rawText - Texto extraído del comprobante
 * @param {object} [options]
 * @param {boolean} [options.autoConfirm=false] - Saltar confirmación
 * @returns {Promise<object>} Resultado del proceso
 */
export async function processPayment(rawText, options = {}) {
  const { autoConfirm = false } = options;

  // 1. Parsear
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

  // 2. Obtener tasa
  let tasaBs = null;
  let tasaInfo = null;
  try {
    tasaInfo = await getExchangeRate();
    tasaBs = tasaInfo.rate;
  } catch (err) {
    console.warn('⚠️ No se pudo obtener tasa:', err.message);
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

  // 3. Mostrar para revisión
  console.log('\n' + '='.repeat(50));
  console.log('📋 DATOS EXTRAÍDOS');
  console.log('='.repeat(50));
  console.log(PagoMovilParser.formatForReview(parsed, tasaBs));
  console.log('='.repeat(50));

  // 4. Guardar si auto-confirmado
  if (autoConfirm) {
    const sheets = new SheetsManager();
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

// CLI mode
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
    console.log('  --text     Texto extraído del comprobante');
    console.log('  --confirm  Guardar automáticamente sin confirmación');
  }
}
