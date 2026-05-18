/**
 * Obtiene la tasa de cambio del dólar (Bs/USD) del día
 * Fuentes disponibles: DolarAPI (recomendado), BCV
 */

import fetch from 'node-fetch';
import { config } from './config.js';

const USER_AGENT = 'PagoMovilAutomator/1.0';

/**
 * Obtiene la tasa del dólar según la fuente configurada
 * @returns {Promise<{rate: number, source: string, date: string}>}
 */
export async function getExchangeRate() {
  const source = config.exchange.source;

  switch (source) {
    case 'bcv':
      return getBCVRate();
    case 'dolarapi':
    default:
      return getDolarApiRate();
  }
}

/**
 * DolarAPI.com - API venezolana de tasa de cambio
 * Endpoint: https://ve.dolarapi.com/v1/dolares
 * Devuelve: [{ moneda, fuente, nombre, compra, venta, promedio, fechaActualizacion }]
 * fuente: "oficial" (BCV) o "paralelo"
 */
async function getDolarApiRate() {
  const url = 'https://ve.dolarapi.com/v1/dolares';

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 10000,
  });

  if (!res.ok) {
    throw new Error(`DolarAPI respondió con ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();

  const mode = config.exchange.mode;

  const oficial = data.find(t => t.fuente === 'oficial');
  const paralelo = data.find(t => t.fuente === 'paralelo');

  // Elegir según configuración: 'oficial' o 'paralelo'
  let selected;
  if (mode === 'paralelo') {
    selected = paralelo || oficial;
  } else {
    // Por defecto: oficial (BCV)
    selected = oficial || paralelo;
  }

  if (!selected) selected = data[0];

  if (!selected || (selected.promedio === null && selected.precio === null)) {
    throw new Error('No se pudo obtener la tasa de cambio de DolarAPI');
  }

  const rate = selected.promedio || selected.precio;

  return {
    rate,
    source: selected.nombre || selected.fuente || source,
    date: selected.fechaActualizacion || new Date().toISOString(),
  };
}

/**
 * BCV (Banco Central de Venezuela) - tasa oficial
 * Scraping directo del sitio web del BCV
 */
async function getBCVRate() {
  const url = 'https://www.bcv.org.ve/';

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 15000,
  });

  if (!res.ok) {
    throw new Error(`BCV respondió con ${res.status}`);
  }

  const html = await res.text();

  // Buscar el precio del dólar en el HTML
  // El BCV muestra: "Bs/USD 42.50" o similar
  const match = html.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)\s*(?:Bs\/?USD|bolívares|dólar)/i);
  if (!match) {
    throw new Error('No se pudo extraer la tasa del sitio del BCV');
  }

  // El BCV usa formato venezolano (42,50)
  const rateStr = match[1].trim();

  // Normalizar: 42,50 → 42.50
  let rate;
  if (rateStr.includes(',')) {
    rate = parseFloat(rateStr.replace(/\./g, '').replace(',', '.'));
  } else {
    rate = parseFloat(rateStr);
  }

  if (isNaN(rate) || rate <= 0) {
    throw new Error(`Tasa inválida extraída del BCV: ${rateStr}`);
  }

  return {
    rate,
    source: 'BCV (sitio oficial)',
    date: new Date().toISOString().split('T')[0],
  };
}

/**
 * Obtiene la tasa y la formatea como texto para mostrar
 */
export async function formatExchangeRate() {
  try {
    const { rate, source, date } = await getExchangeRate();
    return {
      rate,
      text: `💵 Tasa: Bs. ${rate.toFixed(2)} (${source} - ${date})`,
    };
  } catch (err) {
    console.error('Error obteniendo tasa de cambio:', err.message);
    return {
      rate: null,
      text: `⚠️ No se pudo obtener la tasa: ${err.message}`,
    };
  }
}

// === Prueba inline ===
if (process.argv[1]?.includes('exchange-rate') && process.argv.includes('--test')) {
  const { rate, text } = await formatExchangeRate();
  console.log(text);
  process.exit(0);
}
