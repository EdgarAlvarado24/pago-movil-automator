import { google } from 'googleapis';
import logger from './logger.js';

const SPREADSHEET_TITLE = 'Registro de Pagos Móviles';

const MESES = {
  1: 'Enero', 2: 'Febrero', 3: 'Marzo', 4: 'Abril',
  5: 'Mayo', 6: 'Junio', 7: 'Julio', 8: 'Agosto',
  9: 'Septiembre', 10: 'Octubre', 11: 'Noviembre', 12: 'Diciembre',
};

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

function buildAuth(accessToken) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

export async function createSpreadsheet({ accessToken, sheetColumns = null, title = SPREADSHEET_TITLE }) {
  if (!accessToken) {
    throw new Error('Se requiere accessToken de OAuth2');
  }

  const auth = buildAuth(accessToken);

  const sheets = google.sheets({ version: 'v4', auth });

  const headerNames = sheetColumns?.columnas || ['Fecha', 'Bolivares', 'Dolares', 'Especificacion', 'Entradas/Salidas'];

  logger.info('Creando nuevo spreadsheet...');

  let res;
  try {
    res = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: [{
          properties: {
            title: 'General',
            gridProperties: { rowCount: 100, columnCount: headerNames.length },
          },
        }],
      },
    });
  } catch (err) {
    if (err.message?.includes('permission') || err.code === 403) {
      throw new Error(
        'No tengo permiso para crear hojas de cálculo.\n\n' +
        'Para solucionarlo:\n' +
        '1. Ve a https://console.cloud.google.com/apis/library/drive.googleapis.com\n' +
        '2. Asegúrate de que la *Google Drive API* esté habilitada\n' +
        '3. Espera 2-3 minutos y vuelve a intentar con /setup'
      );
    }
    throw err;
  }

  const spreadsheetId = res.data.spreadsheetId;
  logger.info(`Spreadsheet creado: ${spreadsheetId}`);

  const lastCol = String.fromCharCode(64 + headerNames.length);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `General!A1:${lastCol}1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [headerNames] },
  });

  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  logger.info(`Encabezados escritos en hoja "General"`);
  return { spreadsheetId, spreadsheetUrl };
}

export class SheetsManager {
  constructor({ accessToken, spreadsheetId, sheetColumns = null }) {
    if (!accessToken) throw new Error('Se requiere accessToken de OAuth2');
    if (!spreadsheetId) throw new Error('spreadsheetId es requerido');

    this.accessToken = accessToken;
    this.spreadsheetId = spreadsheetId;
    this.sheetColumns = sheetColumns;
    this.initialized = false;
    this.sheets = null;
    this._existingSheets = [];
    this._sheetIds = new Map();
  }

  async init() {
    if (this.initialized) return;

    try {
      const auth = buildAuth(this.accessToken);

      this.sheets = google.sheets({ version: 'v4', auth });

      const res = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });
      this._existingSheets = res.data.sheets.map(s => s.properties.title);
      this._sheetIds = new Map(res.data.sheets.map(s => [s.properties.title, s.properties.sheetId]));
      logger.info('Hojas disponibles en spreadsheet', { sheets: this._existingSheets.join(', '), spreadsheetId: this.spreadsheetId });

      this.initialized = true;
    } catch (err) {
      throw new Error(`Error conectando a Google Sheets: ${err.message}. Verifica que el spreadsheet existe y tienes acceso con tu cuenta de Google.`);
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
      try {
        const updated = await this.sheets.spreadsheets.get({
          spreadsheetId: this.spreadsheetId,
          ranges: [sheetName],
          fields: 'sheets.properties(sheetId,title)',
        });
        const newSheet = updated.data.sheets?.[0];
        if (newSheet?.properties) {
          this._sheetIds.set(newSheet.properties.title, newSheet.properties.sheetId);
        }
      } catch { /* non-critical, fallback al ID 0 */ }
      logger.info(`Hoja "${sheetName}" creada con encabezados`);
      return sheetName;
    } catch (err) {
      const res = await this.sheets.spreadsheets.get({
        spreadsheetId: this.spreadsheetId,
      });
      this._existingSheets = res.data.sheets.map(s => s.properties.title);
      this._sheetIds = new Map(res.data.sheets.map(s => [s.properties.title, s.properties.sheetId]));

      if (this._existingSheets.includes(sheetName)) {
        logger.info(`Hoja "${sheetName}" ya existía (carrera)`);
        return sheetName;
      }

      throw new Error(`Error creando hoja "${sheetName}": ${err.message}`);
    }
  }

  _getSheetId(title) {
    return this._sheetIds.get(title) ?? null;
  }

  _formatValue(field, value, context = {}) {
    if (value === null || value === undefined || value === '') return '';

    const fieldConfig = this.columns[field];
    if (!fieldConfig) return String(value);

    let formatter = fieldConfig.formato || '{{value}}';

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

    formatter = formatter.replace('{{value}}', String(value ?? ''));
    for (const [key, val] of Object.entries(context)) {
      formatter = formatter.replaceAll(`{{${key}}}`, val ?? '');
    }
    return formatter;
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

  async appendRow({ fecha, bolivares, dolares, especificacion, tipo = 'Salida' }, parsedData = null) {
    if (!this.initialized) await this.init();

    const sheetName = SheetsManager.getSheetNameForDate(fecha);
    logger.info(`Mes detectado: "${sheetName}"`);

    await this.ensureSheet(sheetName);

    const numCols = this.headerNames.length;
    const lastCol = String.fromCharCode(64 + numCols);

    const row = new Array(numCols).fill('');

    const ctx = {
      reference: parsedData?.referencia || (especificacion || '').replace(/^Ref:\s*/, '').split(' - ')[0] || '',
      concept: parsedData?.concepto || (especificacion || '').split(' - ').slice(1).join(' - ') || '',
      pagador: parsedData?.pagador || '',
      beneficiario: parsedData?.beneficiario || '',
      bancoEmisor: parsedData?.bancoEmisor || parsedData?.banco || '',
      bancoReceptor: parsedData?.bancoReceptor || '',
      receptorId: parsedData?.receptorId || '',
      nombreReceptor: parsedData?.nombreReceptor || '',
      cuentaOrigen: parsedData?.cuentaOrigen || '',
    };

    const fieldValues = { fecha, bolivares, dolares, especificacion, tipo };

    for (const [fieldName, config] of Object.entries(this.columns)) {
      const colIdx = config.col;
      if (colIdx === undefined || colIdx < 0 || colIdx >= numCols) continue;
      const val = fieldValues[fieldName] !== undefined ? fieldValues[fieldName] : ctx[fieldName] ?? null;
      row[colIdx] = this._formatValue(fieldName, val, ctx);
    }

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

    if (sheetName !== 'General' && this._existingSheets.includes('General')) {
      const generalSheetId = this._getSheetId('General');
      if (generalSheetId !== null) {
        try {
          await this.sheets.spreadsheets.batchUpdate({
            spreadsheetId: this.spreadsheetId,
            requestBody: {
              requests: [{ deleteSheet: { sheetId: generalSheetId } }],
            },
          });
          this._existingSheets = this._existingSheets.filter(s => s !== 'General');
          this._sheetIds.delete('General');
          logger.info('Hoja "General" eliminada tras primer pago');
        } catch (deleteErr) {
          logger.warn('No se pudo eliminar hoja "General"', { error: deleteErr.message });
        }
      } else {
        logger.warn('No se encontró el ID de la hoja "General", se omite eliminación');
      }
    }

    return {
      success: true,
      range: updatedRange,
      sheetName,
      data: row,
    };
  }

  async appendPayment(parsed, tasaBs, tipo = 'Salida') {
    const dolares = tasaBs ? (parsed.montoBolivares / tasaBs) : null;

    return this.appendRow({
      fecha: parsed.fecha,
      bolivares: parsed.montoBolivares,
      dolares: dolares !== null ? parseFloat(dolares.toFixed(2)) : null,
      especificacion: [
        `Ref: ${parsed.referencia || '?'}`,
        parsed.concepto || '',
      ].filter(Boolean).join(' - '),
      tipo,
    }, parsed);
  }
}
