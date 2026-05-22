import { google } from 'googleapis';
import logger from './logger.js';

const MESES = {
  1: 'Enero', 2: 'Febrero', 3: 'Marzo', 4: 'Abril',
  5: 'Mayo', 6: 'Junio', 7: 'Julio', 8: 'Agosto',
  9: 'Septiembre', 10: 'Octubre', 11: 'Noviembre', 12: 'Diciembre',
};

export class SheetsManager {
  constructor({ serviceAccountJson, spreadsheetId, sheetColumns = null }) {
    if (!serviceAccountJson) throw new Error('serviceAccountJson es requerido');
    if (!spreadsheetId) throw new Error('spreadsheetId es requerido');

    this.serviceAccountJson = serviceAccountJson;
    this.spreadsheetId = spreadsheetId;
    this.sheetColumns = sheetColumns;
    this.initialized = false;
    this.sheets = null;
    this._existingSheets = [];
  }

  async init() {
    if (this.initialized) return;

    let credentials;
    try {
      credentials = typeof this.serviceAccountJson === 'string'
        ? JSON.parse(this.serviceAccountJson)
        : this.serviceAccountJson;
    } catch {
      throw new Error('El Service Account JSON proporcionado no es válido.');
    }

    try {
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });

      this.sheets = google.sheets({ version: 'v4', auth });

      const res = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });
      this._existingSheets = res.data.sheets.map(s => s.properties.title);
      logger.info('Hojas disponibles en spreadsheet', { sheets: this._existingSheets.join(', '), spreadsheetId: this.spreadsheetId });

      this.initialized = true;
    } catch (err) {
      throw new Error(`Error conectando a Google Sheets: ${err.message}. Verifica que el spreadsheet existe y está compartido con el service account.`);
    }
  }

  get columns() {
    return this.sheetColumns?.mapping || {
      fecha: { col: 0, formato: 'DD/MM/YYYY' },
      bolivares: { col: 1, formato: 'Bs{{value}}' },
      dolares: { col: 2, formato: '${{value}}' },
      especificacion: { col: 3, formato: 'Ref: {{reference}} - {{concept}}' },
      tipo: { col: 4, formato: '{{value}}' },
    };
  }

  get headerNames() {
    return this.sheetColumns?.columnas || ['Fecha', 'Bolivares', 'Dolares', 'Especificacion', 'Entradas/Salidas'];
  }

  get dataStartRow() {
    return this.sheetColumns?.fila_inicio || 2;
  }

  get hasHeaders() {
    return this.sheetColumns?.encabezados !== false;
  }

  static getSheetNameForDate(isoDate) {
    if (!isoDate) return 'General';

    const parts = isoDate.split('-');
    if (parts.length !== 3) return 'General';

    const year = parts[0];
    const month = parseInt(parts[1], 10);
    const monthName = MESES[month];
    if (!monthName) return 'General';

    return `${monthName} ${year}`;
  }

  async ensureSheet(sheetName) {
    if (this._existingSheets.includes(sheetName)) {
      return sheetName;
    }

    logger.info(`Creando hoja "${sheetName}"...`);

    try {
      const numCols = this.headerNames.length;
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: {
                title: sheetName,
                gridProperties: { rowCount: 100, columnCount: numCols },
              },
            },
          }],
        },
      });

      if (this.hasHeaders) {
        const lastCol = String.fromCharCode(64 + numCols);
        await this.sheets.spreadsheets.values.update({
          spreadsheetId: this.spreadsheetId,
          range: `${sheetName}!A1:${lastCol}1`,
          valueInputOption: 'USER_ENTERED',
          requestBody: {
            values: [this.headerNames],
          },
        });
      }

      this._existingSheets.push(sheetName);
      logger.info(`Hoja "${sheetName}" creada con encabezados`);
      return sheetName;
    } catch (err) {
      const res = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });
      this._existingSheets = res.data.sheets.map(s => s.properties.title);

      if (this._existingSheets.includes(sheetName)) {
        logger.info(`Hoja "${sheetName}" ya existía (carrera)`);
        return sheetName;
      }

      throw new Error(`Error creando hoja "${sheetName}": ${err.message}`);
    }
  }

  _formatValue(field, value, context = {}) {
    if (value === null || value === undefined || value === '') return '';

    const fieldConfig = this.columns[field];
    if (!fieldConfig) return String(value);

    const formatter = fieldConfig.formato || '{{value}}';

    if (field === 'fecha' && value) {
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return value;
      const parts = value.split('-');
      if (parts.length === 3) {
        return `${parts[2]}/${parts[1]}/${parts[0]}`;
      }
      return value;
    }

    if (field === 'bolivares' || field === 'dolares') {
      const n = typeof value === 'string' ? parseFloat(value) : value;
      if (isNaN(n)) return String(value);
      const formatted = n.toLocaleString('es-VE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      return formatter.replace('{{value}}', formatted);
    }

    if (field === 'especificacion') {
      return formatter
        .replace('{{reference}}', context.reference || '')
        .replace('{{concept}}', context.concept || '');
    }

    return formatter.replace('{{value}}', String(value));
  }

  async readRow(rowNumber, sheetName) {
    const sheet = sheetName || this._existingSheets.at(-1) || 'General';
    const numCols = this.headerNames.length;
    const lastCol = String.fromCharCode(64 + numCols);
    const range = `${sheet}!A${rowNumber}:${lastCol}${rowNumber}`;
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range,
    });
    return res.data.values?.[0] || [];
  }

  async getLastDataRow(sheetName) {
    const sheet = sheetName || this._existingSheets.at(-1) || 'General';
    const range = `${sheet}!A:A`;
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    return (res.data.values || []).length;
  }

  async appendRow({ fecha, bolivares, dolares, especificacion, tipo = 'Salida' }) {
    if (!this.initialized) await this.init();

    const sheetName = SheetsManager.getSheetNameForDate(fecha);
    logger.info(`Mes detectado: "${sheetName}"`);

    await this.ensureSheet(sheetName);

    const numCols = this.headerNames.length;
    const lastCol = String.fromCharCode(64 + numCols);

    const row = new Array(numCols).fill('');

    const mappingContext = {
      reference: (especificacion || '').replace(/^Ref:\s*/, '').split(' - ')[0] || '',
      concept: (especificacion || '').split(' - ').slice(1).join(' - ') || '',
    };

    row[this.columns.fecha?.col ?? 0] = this._formatValue('fecha', fecha);
    row[this.columns.bolivares?.col ?? 1] = this._formatValue('bolivares', bolivares);
    row[this.columns.dolares?.col ?? 2] = this._formatValue('dolares', dolares);
    row[this.columns.especificacion?.col ?? 3] = this._formatValue('especificacion', especificacion, mappingContext);
    row[this.columns.tipo?.col ?? 4] = this._formatValue('tipo', tipo);

    logger.info('Escribiendo fila', { row, sheetName });

    const range = `${sheetName}!A:${lastCol}`;
    const res = await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });

    const updatedRange = res.data.updates?.updatedRange || 'desconocido';
    logger.info(`Fila agregada en: ${updatedRange}`);

    return {
      success: true,
      range: updatedRange,
      sheetName,
      data: row,
    };
  }

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
