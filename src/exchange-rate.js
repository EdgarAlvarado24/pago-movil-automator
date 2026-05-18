/**
 * Obtiene la tasa de cambio del dólar (Bs/USD) del día
 * Con caché persistente para consultar por fecha histórica.
 *
 * Cuando se procesa un pago, se intenta usar la tasa de la fecha del
 * comprobante (no la tasa actual). Las tasas se cachean en un archivo
 * local (rate-cache.json) cada vez que se consultan.
 *
 * Fuentes: DolarAPI (recomendado), BCV
 */

import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RATE_CACHE_FILE = path.join(__dirname, '..', 'rate-cache.json');

const USER_AGENT = 'PagoMovilAutomator/1.0';

// ============================================================
// CACHÉ PERSISTENTE
// ============================================================

function loadCache() {
  try {
    const data = fs.readFileSync(RATE_CACHE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

const MAX_CACHE_DAYS = 365; // mantener hasta 1 año

function saveCache(cache) {
  // Podar entradas más viejas que MAX_CACHE_DAYS
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_CACHE_DAYS);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  for (const key of Object.keys(cache)) {
    if (key < cutoffStr) delete cache[key];
  }

  fs.writeFileSync(RATE_CACHE_FILE, JSON.stringify(cache, null, 2));
  console.log(`💾 Caché de tasas guardada (${Object.keys(cache).length} fechas)`);
}

/**
 * Busca la tasa más cercana para una fecha dada (hacia atrás)
 */
function findClosestRate(cache, dateStr) {
  // Match exacto
  if (cache[dateStr]) return cache[dateStr];

  // Buscar hacia atrás hasta 5 días
  const date = new Date(dateStr + 'T12:00:00');
  for (let i = 1; i <= 5; i++) {
    date.setDate(date.getDate() - 1);
    const key = date.toISOString().split('T')[0];
    if (cache[key]) return cache[key];
  }

  return null;
}

// ============================================================
// FETCHERS
// ============================================================

/**
 * Obtiene la tasa de cambio para una fecha específica.
 * @param {string} [dateStr] - Fecha del pago en YYYY-MM-DD
 * @returns {Promise<{rate: number, source: string, date: string}>}
 */
export async function getExchangeRate(dateStr) {
  const cache = loadCache();

  // Si se pidió una fecha específica, buscar en caché primero
  if (dateStr) {
    const cached = findClosestRate(cache, dateStr);
    if (cached) {
      console.log(`📅 Tasa recuperada del caché: ${cached.date} → Bs. ${cached.rate}/USD`);
      return cached;
    }
    console.log(`⚠️ No hay tasa cacheada para ${dateStr}, obteniendo la más reciente...`);
  }

  // Obtener tasa actual
  const source = config.exchange.source;
  let result;

  switch (source) {
    case 'bcv':
      result = await getBCVRate();
      break;
    case 'dolarapi':
    default:
      result = await getDolarApiRate();
      break;
  }

  // Guardar en caché (usar la fecha de actualización de la API como key)
  const cacheKey = result.date.split('T')[0].split(' ')[0]; // normalizar a YYYY-MM-DD
  if (!cache[cacheKey]) {
    cache[cacheKey] = result;
    saveCache(cache);
  }

  // Si se pidió una fecha y no estaba en caché, devolver la actual con nota
  if (dateStr && result.date !== dateStr) {
    console.log(`⚠️ Usando tasa del ${result.date} para un pago del ${dateStr}`);
    return { ...result, date: result.date, note: `Tasa del ${result.date} usada para pago del ${dateStr}` };
  }

  return result;
}

/**
 * DolarAPI.com - API venezolana de tasa de cambio
 */
async function getDolarApiRate() {
  const url = 'https://ve.dolarapi.com/v1/dolares';

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 10000,
  });

  if (!res.ok) throw new Error(`DolarAPI respondió con ${res.status}: ${res.statusText}`);

  const data = await res.json();
  const mode = config.exchange.mode;

  const oficial = data.find(t => t.fuente === 'oficial');
  const paralelo = data.find(t => t.fuente === 'paralelo');

  let selected;
  if (mode === 'paralelo') {
    selected = paralelo || oficial;
  } else {
    selected = oficial || paralelo;
  }
  if (!selected) selected = data[0];
  if (!selected || (selected.promedio === null && selected.precio === null)) {
    throw new Error('No se pudo obtener la tasa de cambio de DolarAPI');
  }

  const rate = selected.promedio || selected.precio;
  const apiDate = selected.fechaActualizacion || new Date().toISOString();

  return {
    rate,
    source: selected.nombre || selected.fuente || config.exchange.source,
    date: apiDate,
  };
}

/**
 * BCV - scraping directo
 */
async function getBCVRate() {
  const url = 'https://www.bcv.org.ve/';

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 15000,
  });

  if (!res.ok) throw new Error(`BCV respondió con ${res.status}`);

  const html = await res.text();
  const match = html.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)\s*(?:Bs\/?USD|bolívares|dólar)/i);

  if (!match) throw new Error('No se pudo extraer la tasa del sitio del BCV');

  const rateStr = match[1].trim();
  let rate;
  if (rateStr.includes(',')) {
    rate = parseFloat(rateStr.replace(/\./g, '').replace(',', '.'));
  } else {
    rate = parseFloat(rateStr);
  }

  if (isNaN(rate) || rate <= 0) throw new Error(`Tasa inválida: ${rateStr}`);

  return {
    rate,
    source: 'BCV (sitio oficial)',
    date: new Date().toISOString().split('T')[0],
  };
}

/**
 * Versión con formato para mostrar
 */
export async function formatExchangeRate(dateStr) {
  try {
    const { rate, source, date } = await getExchangeRate(dateStr);
    return {
      rate,
      text: `💵 Tasa: Bs. ${rate.toFixed(2)} (${source} - ${date})`,
    };
  } catch (err) {
    return {
      rate: null,
      text: `⚠️ No se pudo obtener la tasa: ${err.message}`,
    };
  }
}

/**
 * Muestra el contenido del caché (diagnóstico)
 */
export function getCachedRates() {
  const cache = loadCache();
  const dates = Object.keys(cache).sort().reverse();
  if (dates.length === 0) return '📭 No hay tasas cacheadas.';

  return dates.map(k => {
    const r = cache[k];
    return `📅 ${k}: Bs. ${r.rate.toFixed(2)} (${r.source})`;
  }).join('\n');
}

// === Prueba inline ===
if (process.argv[1]?.includes('exchange-rate') && process.argv.includes('--test')) {
  const { rate, text } = await formatExchangeRate();
  console.log(text);
  process.exit(0);
}
