/**
 * Módulo de Google Sheets
 * Soporte multi-mes: detecta el mes de la fecha del pago y
 * escribe en la hoja correspondiente, creándola si no existe.
 *
 * Columnas: Fecha | Bolivares | Dolares | Especificacion | Entradas/Salidas
 *
 * Formato existente en la hoja:
 *   Fecha: DD/MM/AAAA
 *   Bolivares: BsX.XXX,XX (texto, con prefijo Bs)
 *   Dolares: $X,XX (texto, con prefijo $)
 */

import { google } from 'googleapis';
import { config } from './config.js';

// Mapa de meses en español
const MESES = {
  1: 'Enero', 2: 'Febrero', 3: 'Marzo', 4: 'Abril',
  5: 'Mayo', 6: 'Junio', 7: 'Julio', 8: 'Agosto',
  9: 'Septiembre', 10: 'Octubre', 11: 'Noviembre', 12: 'Diciembre',
};

export class SheetsManager {
  constructor() {
    this.initialized = false;
    this.sheets = null;
    this._existingSheets = []; // cache de hojas existentes
  }

  /**
   * Inicializa la conexión con Google Sheets
   */
  async init() {
    if (this.initialized) return;

    const { credentials, spreadsheetId } = config.google;

    if (!credentials) {
      throw new Error(
        '❌ No hay credenciales de Google.\n' +
        'Configura GOOGLE_SERVICE_ACCOUNT_JSON en .env'
      );
    }
    if (!spreadsheetId) {
      throw new Error('❌ SPREADSHEET_ID no configurado');
    }

    try {
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      this.sheets = google.sheets({ version: 'v4', auth });
      this.spreadsheetId = spreadsheetId;

      // Cachear hojas existentes
      const res = await this.sheets.spreadsheets.get({
        spreadsheetId,
      });
      this._existingSheets = res.data.sheets.map(s => s.properties.title);
      console.log('📋 Hojas disponibles:', this._existingSheets.join(', '));

      this.initialized = true;
      console.log('✅ Conectado a Google Sheets:', spreadsheetId);
    } catch (err) {
      throw new Error(`Error conectando a Google Sheets: ${err.message}`);
    }
  }

  /**
   * Obtiene el nombre de la hoja para un mes/año
   * Ej: "Mayo 2026"
   */
  static getSheetNameForDate(isoDate) {
    if (!isoDate) return config.google.sheetName;

    const parts = isoDate.split('-');
    if (parts.length !== 3) return config.google.sheetName;

    const year = parts[0];
    const month = parseInt(parts[1], 10);
    const monthName = MESES[month];

    if (!monthName) return config.google.sheetName;

    return `${monthName} ${year}`;
  }

  /**
   * Asegura que exista la hoja para un mes/año, la crea si no
   */
  async ensureSheet(sheetName) {
    if (this._existingSheets.includes(sheetName)) {
      return sheetName; // ya existe
    }

    console.log(`🆕 Creando hoja "${sheetName}"...`);

    try {
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title: sheetName,
                gridProperties: { rowCount: 100, columnCount: 5 },
              },
            },
          }],
        },
      });

      // Escribir encabezados
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.spreadsheetId,
        range: `${sheetName}!A1:E1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [['Fecha', 'Bolivares', 'Dolares', 'Especificacion', 'Entradas/Salidas']],
        },
      });

      this._existingSheets.push(sheetName);
      console.log(`✅ Hoja "${sheetName}" creada con encabezados`);
      return sheetName;
    } catch (err) {
      // Puede fallar si otro proceso la creó justo antes
      // Refrescar cache y reintentar
      const res = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });
      this._existingSheets = res.data.sheets.map(s => s.properties.title);

      if (this._existingSheets.includes(sheetName)) {
        console.log(`✅ Hoja "${sheetName}" ya existía (carrera)`);
        return sheetName;
      }

      throw new Error(`Error creando hoja "${sheetName}": ${err.message}`);
    }
  }

  /**
   * Lee una fila específica
   */
  async readRow(rowNumber, sheetName) {
    sheetName = sheetName || config.google.sheetName;
    const range = `${sheetName}!A${rowNumber}:E${rowNumber}`;
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range,
    });
    return res.data.values?.[0] || [];
  }

  /**
   * Obtiene la última fila con datos en una hoja
   */
  async getLastDataRow(sheetName) {
    sheetName = sheetName || config.google.sheetName;
    const range = `${sheetName}!A:A`;
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    return (res.data.values || []).length;
  }

  // ========== Formateadores ==========

  _formatFecha(isoDate) {
    if (!isoDate) return '';
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(isoDate)) return isoDate;
    const parts = isoDate.split('-');
    if (parts.length === 3) {
      return `${parts[2]}/${parts[1]}/${parts[0]}`;
    }
    return isoDate;
  }

  _formatBolivares(num) {
    if (num === null || num === undefined || num === '') return '';
    const n = typeof num === 'string' ? parseFloat(num) : num;
    if (isNaN(n)) return String(num);
    const formatted = n.toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `Bs${formatted}`;
  }

  _formatDolares(num) {
    if (num === null || num === undefined || num === '') return '';
    const n = typeof num === 'string' ? parseFloat(num) : num;
    if (isNaN(n)) return String(num);
    const formatted = n.toLocaleString('es-VE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `$${formatted}`;
  }

  // ========== Escritura ==========

  /**
   * Agrega una fila a la hoja correspondiente al mes de la fecha
   * @param {object} data
   * @param {string} data.fecha - Fecha en YYYY-MM-DD (de dónde saca el mes)
   * @param {number} data.bolivares
   * @param {number} data.dolares
   * @param {string} data.especificacion
   * @param {string} data.tipo - "Salida" o "Entrada"
   */
  async appendRow({ fecha, bolivares, dolares, especificacion, tipo = 'Salida' }) {
    if (!this.initialized) await this.init();

    // Determinar la hoja según la fecha
    const sheetName = SheetsManager.getSheetNameForDate(fecha);
    console.log(`📅 Mes detectado: "${sheetName}"`);

    // Crear la hoja si no existe
    await this.ensureSheet(sheetName);

    const values = [[
      this._formatFecha(fecha),
      this._formatBolivares(bolivares),
      this._formatDolares(dolares),
      especificacion || '',
      tipo,
    ]];

    console.log('📝 Escribiendo fila:', values[0]);

    const range = `${sheetName}!A:E`;
    const res = await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });

    const updatedRange = res.data.updates?.updatedRange || 'desconocido';
    console.log(`✅ Fila agregada en: ${updatedRange}`);

    return {
      success: true,
      range: updatedRange,
      sheetName,
      data: values[0],
    };
  }

  /**
   * Agrega una fila desde datos parseados de Pago Móvil + tasa
   */
  async appendPayment(parsed, tasaBs) {
    const dolares = tasaBs ? (parsed.montoBolivares / tasaBs) : null;

    return this.appendRow({
      fecha: parsed.fecha,
      bolivares: parsed.montoBolivares,
      dolares: dolares !== null ? parseFloat(dolares.toFixed(2)) : null,
      especificacion: [
        `Ref: ${parsed.referencia || '?'}`,
        parsed.concepto || '',
      ].filter(Boolean).join(' - '),
      tipo: 'Salida',
    });
  }
}
