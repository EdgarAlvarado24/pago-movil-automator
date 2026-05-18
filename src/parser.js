/**
 * Parser de Pago Móvil Banesco (formato real de la app)
 * Extrae datos del texto OCR de un comprobante de la app Banesco
 *
 * Formato real (app Banesco):
 *
 *   Recibo
 *   ¡Operación Exitosa!
 *   En breve le llegará un SMS con el resultado de la operación.
 *
 *   NÚMERO DE REFERENCIA
 *   061308215588
 *
 *   FECHA
 *   10/05/2026 12:34:23PM
 *
 *   NÚMERO CELULAR DE ORIGEN
 *   04**-***5068
 *
 *   NÚMERO CELULAR DE DESTINO
 *   0424-5813136
 *
 *   IDENTIFICACIÓN RECEPTOR
 *   V-12340600
 *
 *   BANCO EMISOR
 *   BANESCO BANCO UNIVERSAL S.A.C.A.
 *
 *   BANCO RECEPTOR
 *   BANCO PROVINCIAL
 *
 *   MONTO DE LA OPERACIÓN
 *   Bs. 6.300,00
 *
 *   CONCEPTO
 *   pago
 */

export class PagoMovilParser {
  /**
   * Parsea el texto OCR de un comprobante de Pago Móvil Banesco
   * @param {string} rawText - Texto extraído de la imagen vía OCR
   * @returns {object|null} Datos parseados o null si no se reconoce
   */
  static parse(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      return null;
    }

    const text = rawText.trim();

    // Verificar que sea un Pago Móvil Banesco
    if (!this._isMobilePayment(text)) {
      return null;
    }

    const result = {
      fecha: this._extractDate(text),
      montoBolivares: this._extractAmount(text),
      referencia: this._extractReference(text),
      concepto: this._extractConcept(text),
      pagador: this._extractOriginPhone(text),
      beneficiario: this._extractDestPhone(text),
      bancoEmisor: this._extractIssuingBank(text),
      bancoReceptor: this._extractReceivingBank(text),
      receptorId: this._extractReceptorId(text),
      raw: text,
    };

    return result;
  }

  /**
   * Valida que los datos mínimos estén presentes
   */
  static validate(parsed) {
    if (!parsed) return { valid: false, errors: ['No se reconoce como Pago Móvil Banesco'] };

    const errors = [];

    if (!parsed.fecha) errors.push('No se pudo extraer la fecha');
    if (parsed.montoBolivares === null || parsed.montoBolivares === undefined) errors.push('No se pudo extraer el monto');
    if (!parsed.referencia) errors.push('No se pudo extraer el número de referencia');

    return {
      valid: errors.length === 0,
      errors,
      data: parsed,
    };
  }

  static _isMobilePayment(text) {
    const keywords = [
      'operación exitosa', 'operacion exitosa',
      'recibo', 'pago móvil', 'pago movil',
      'banesco', 'monto de la operación', 'monto de la operacion',
    ];
    const lower = text.toLowerCase();
    // Buscar Banesco + al menos otra palabra clave
    const hasBanesco = lower.includes('banesco');
    const hasOtherKeyword = keywords.some(k => lower.includes(k));
    return hasBanesco || hasOtherKeyword;
  }

  // Labels conocidos del formato Banesco (en orden de aparición típico)
  static KNOWN_LABELS = [
    'NÚMERO DE REFERENCIA',
    'FECHA',
    'NÚMERO CELULAR DE ORIGEN',
    'NÚMERO CELULAR DE DESTINO',
    'IDENTIFICACIÓN RECEPTOR',
    'IDENTIFICACION RECEPTOR',
    'BANCO EMISOR',
    'BANCO RECEPTOR',
    'MONTO DE LA OPERACIÓN',
    'MONTO DE LA OPERACION',
    'CONCEPTO',
    'REFERENCIA',
    'MONTO',
    'PAGADOR',
    'BENEFICIARIO',
    'CEDULA',
    'CÉDULA',
    'BANCO',
    'COMISIÓN',
    'COMISION',
    'TOTAL',
    'Pago Móvil',
    'Pago Movil',
    'Operación Exitosa',
    'Operacion Exitosa',
    'Recibo',
    'Agregar a Pagos Frecuentes',
    'Agregar a Pagos',
    'Aceptar',
    'E) Agregar a Pagos Frecuentes',
    'E) Agregar a Pagos',
  ];

  /**
   * Normaliza una línea: elimina espacios extra, estandariza
   */
  static _normalizeLine(line) {
    return line.replace(/\s+/g, ' ').trim();
  }

  /**
   * Verifica si una línea es un label conocido de Banesco
   */
  static _isKnownLabel(line) {
    const nLine = this._normalizeLine(line).toUpperCase();
    // Quitar signos de puntuación para comparar
    const cleanLine = nLine.replace(/[^A-ZÁÉÍÓÚÑ0-9\s]/g, '').trim();
    return this.KNOWN_LABELS.some(label => {
      const cleanLabel = label.toUpperCase().replace(/[^A-ZÁÉÍÓÚÑ0-9\s]/g, '').trim();
      return cleanLine === cleanLabel;
    });
  }

  /**
   * Extrae texto entre un label y el siguiente label conocido
   */
  static _extractFieldAfterLabel(text, labelRegex, multiline = false) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    for (let i = 0; i < lines.length; i++) {
      if (labelRegex.test(lines[i])) {
        const valueLines = [];
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j];
          // Si es otro label conocido o texto vacío, parar
          if (this._isKnownLabel(line)) break;
          if (!multiline) {
            return line;
          }
          valueLines.push(line);
        }
        if (multiline) {
          return valueLines.join(' ').trim() || null;
        }
      }
    }
    return null;
  }

  static _extractDate(text) {
    // Formato: FECHA\n10/05/2026 12:34:23PM
    // o FECHA\n10/05/2026
    const dateVal = this._extractFieldAfterLabel(text, /^FECHA$/i);
    if (dateVal) {
      // Extraer solo la fecha (DD/MM/AAAA)
      const match = dateVal.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
      if (match) {
        let [day, month, year] = match[1].split('/');
        if (year.length === 2) year = '20' + year;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      }
    }

    // Fallback: buscar cualquier fecha en el texto
    const match = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (match) {
      let [_, day, month, year] = match;
      if (year.length === 2) year = '20' + year;
      return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }

    return null;
  }

  static _extractAmount(text) {
    // MONTO DE LA OPERACIÓN\nBs. 6.300,00
    const amountLine = this._extractFieldAfterLabel(text, /^MONTO\s+(DE\s+LA\s+)?OPERACIÓN/i);

    if (amountLine) {
      const match = amountLine.match(/(?:Bs\.?\s*)?([\d.,]+)/);
      if (match) {
        return this._parseVenezuelanNumber(match[1]);
      }
    }

    // Fallback: buscar Bs. X.XXX,XX en todo el texto
    const match = text.match(/(?:Bs\.?\s*)([\d.,]+)/);
    if (match) {
      return this._parseVenezuelanNumber(match[1]);
    }

    return null;
  }

  static _extractReference(text) {
    // NÚMERO DE REFERENCIA\n061308215588
    const ref = this._extractFieldAfterLabel(text, /^NÚMERO\s+(DE\s+)?REFERENCIA/i);
    if (ref) {
      const match = ref.match(/(\d{6,})/);
      if (match) return match[1];
    }

    // Fallback
    const match = text.match(/(\d{10,15})/);
    return match ? match[1] : null;
  }

  static _extractConcept(text) {
    // CONCEPTO\npago
    // CONCEPTO\nPago de servicios
    const concept = this._extractFieldAfterLabel(text, /^CONCEPTO$/i, true);
    if (concept) return this._cleanConcept(concept);

    // Fallback: después de MONTO, buscar texto que no parezca label
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (let i = 0; i < lines.length; i++) {
      if (/^CONCEPTO$/i.test(lines[i])) {
        for (let j = i + 1; j < lines.length; j++) {
          const line = lines[j];
          // Si es un label conocido, parar
          if (this._looksLikeLabel(line) || /^(aceptar|agregar|ok|listo)/i.test(line)) {
            break;
          }
          // Si es texto normal (no label)
          if (!this._looksLikeLabel(line) && line.length > 0) {
            return line.trim();
          }
        }
      }
    }

    // Último recurso: buscar "CONCEPTO" seguido de texto
    const match = text.match(/CONCEPTO\s*\n+([^\n]+)/i);
    if (match) {
      return this._cleanConcept(match[1].trim());
    }

    return null;
  }

  /**
   * Limpia el concepto: elimina texto de UI/OCR que se cuela
   * Ej: "pago E) Agregar a Pagos Frecuentes" → "pago"
   */
  static _cleanConcept(rawConcept) {
    if (!rawConcept) return null;

    let concept = rawConcept.trim();

    // Eliminar cualquier texto después de UI markers
    const uiMarkers = [
      /[Ee][)][\s]*agregar/i,
      /agregar\s+a\s+pagos/i,
      /aceptar/i,
      /listo/i,
      /ok/i,
    ];

    for (const marker of uiMarkers) {
      const idx = concept.search(marker);
      if (idx > 0) {
        concept = concept.substring(0, idx).trim();
      }
    }

    return concept.length > 0 ? concept : null;
  }

  static _extractOriginPhone(text) {
    // NÚMERO CELULAR DE ORIGEN\n04**-***5068
    const phone = this._extractFieldAfterLabel(text, /^NÚMERO\s+CELULAR\s+(DE\s+)?ORIGEN/i);
    return phone || null;
  }

  static _extractDestPhone(text) {
    // NÚMERO CELULAR DE DESTINO\n0424-5813136
    const phone = this._extractFieldAfterLabel(text, /^NÚMERO\s+CELULAR\s+(DE\s+)?DESTINO/i);
    return phone || null;
  }

  static _extractIssuingBank(text) {
    // BANCO EMISOR\nBANESCO BANCO UNIVERSAL S.A.C.A.
    const bank = this._extractFieldAfterLabel(text, /^BANCO\s+EMISOR/i);
    return bank || null;
  }

  static _extractReceivingBank(text) {
    // BANCO RECEPTOR\nBANCO PROVINCIAL
    const bank = this._extractFieldAfterLabel(text, /^BANCO\s+RECEPTOR/i);
    return bank || null;
  }

  static _extractReceptorId(text) {
    // IDENTIFICACIÓN RECEPTOR\nV-12340600
    const id = this._extractFieldAfterLabel(text, /^IDENTIFICACIÓN\s+RECEPTOR/i);
    return id || null;
  }

  /**
   * Convierte número en formato venezolano (6.300,00) a float
   */
  static _parseVenezuelanNumber(str) {
    if (!str) return null;
    let s = str.trim();

    // Si tiene coma decimal (formato venezolano)
    if (s.includes(',')) {
      s = s.replace(/\./g, '');  // quitar puntos de miles
      s = s.replace(',', '.');   // coma → punto decimal
    } else if (s.includes('.') && (s.match(/\./g) || []).length > 1) {
      // Múltiples puntos = formato venezolano sin coma (ej: "1.500")
      s = s.replace(/\./g, '');
    }

    return parseFloat(s);
  }

  /**
   * Formatea datos parseados para mostrar en revisión
   */
  static formatForReview(parsed, tasaBs) {
    if (!parsed) return '❌ No se pudieron extraer datos del comprobante.';

    const montoDolares = tasaBs ? (parsed.montoBolivares / tasaBs).toFixed(2) : 'N/A';

    return [
      '📋 **Datos extraídos del Pago Móvil**',
      '',
      `📅 **Fecha:** ${parsed.fecha || '❓ No detectada'}`,
      `💰 **Monto:** Bs. ${parsed.montoBolivares?.toFixed(2) || '❓'}`,
      `💵 **En dólares:** $${montoDolares} (tasa: Bs. ${tasaBs?.toFixed(2) || 'N/A'})`,
      `🔢 **Referencia:** ${parsed.referencia || '❓ No detectada'}`,
      `📝 **Concepto:** ${parsed.concepto || '(sin concepto)'}`,
      `📱 **Origen:** ${parsed.pagador || '❓'}`,
      `📱 **Destino:** ${parsed.beneficiario || '❓'}`,
      `🏦 **Banco emisor:** ${parsed.bancoEmisor || '❓'}`,
      `🏦 **Banco receptor:** ${parsed.bancoReceptor || '❓'}`,
    ].join('\n');
  }
}

// === Pruebas inline ===
function runTests() {
  const sampleText = `
Recibo
¡Operación Exitosa!
En breve le llegará un SMS con el resultado de la operación.

NÚMERO DE REFERENCIA
061308215588

FECHA
10/05/2026 12:34:23PM

NÚMERO CELULAR DE ORIGEN
04**-***5068

NÚMERO CELULAR DE DESTINO
0424-5813136

IDENTIFICACIÓN RECEPTOR
V-12340600

BANCO EMISOR
BANESCO BANCO UNIVERSAL S.A.C.A.

BANCO RECEPTOR
BANCO PROVINCIAL

MONTO DE LA OPERACIÓN
Bs. 6.300,00

CONCEPTO
pago
  `.trim();

  console.log('=== Test 1: Parseo formato app Banesco ===');
  const parsed = PagoMovilParser.parse(sampleText);
  console.log(JSON.stringify(parsed, null, 2));

  console.log('\n=== Test 2: Validación ===');
  const validation = PagoMovilParser.validate(parsed);
  console.log('Válido:', validation.valid);
  if (!validation.valid) console.log('Errores:', validation.errors);

  console.log('\n=== Test 3: Formato para revisión ===');
  console.log(PagoMovilParser.formatForReview(parsed, 508.60));

  console.log('\n=== Test 4: No es Pago Móvil ===');
  const notPayment = PagoMovilParser.parse('Factura de electricidad...');
  console.log('Resultado:', notPayment);

  console.log('\n=== Test 5: Concepto multi-línea ===');
  const multiConcept = `
Recibo
¡Operación Exitosa!

NÚMERO DE REFERENCIA
1234567890

FECHA
13/05/2026 04:30:00PM

MONTO DE LA OPERACIÓN
Bs. 1.200,00

CONCEPTO
Pago de servicios
profesionales
  `.trim();
  const parsed2 = PagoMovilParser.parse(multiConcept);
  console.log('Concepto:', parsed2?.concepto);

  const allPassed = validation.valid && parsed !== null && notPayment === null;
  console.log('\n' + (allPassed ? '✅ Todas las pruebas pasaron' : '❌ Fallaron pruebas'));
}

if (process.argv[1] && (process.argv[1].includes('parser') || process.argv.includes('--test'))) {
  runTests();
}
