/**
 * Módulo de OCR (Reconocimiento Óptico de Caracteres)
 * Usa Tesseract.js para extraer texto de imágenes de comprobantes de pago
 *
 * Para uso standalone (Telegram bot), cuando no se depende del análisis
 * de imagen de OpenClaw
 */

import { createWorker } from 'tesseract.js';

/**
 * Extrae texto de una imagen usando Tesseract.js
 * @param {string} imagePath - Ruta local a la imagen
 * @param {object} [options]
 * @param {string} [options.lang='spa'] - Idioma (spa para español)
 * @returns {Promise<string>} Texto extraído
 */
export async function extractTextFromImage(imagePath, options = {}) {
  const lang = options.lang || 'spa';

  console.log(`🔍 Extrayendo texto de: ${imagePath} (idioma: ${lang})`);

  const worker = await createWorker(lang);

  try {
    const { data } = await worker.recognize(imagePath);
    console.log(`✅ OCR completado: ${data.text.length} caracteres extraídos`);
    return data.text;
  } catch (err) {
    console.error('❌ Error en OCR:', err.message);
    throw err;
  } finally {
    await worker.terminate();
  }
}

/**
 * Versión que intenta con español primero y falla a inglés si es necesario
 */
export async function extractTextRobust(imagePath) {
  try {
    return await extractTextFromImage(imagePath, { lang: 'spa' });
  } catch {
    console.log('⚠️ Falló con español, intentando con inglés...');
    return await extractTextFromImage(imagePath, { lang: 'eng' });
  }
}
