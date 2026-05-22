/**
 * Parser multi-banco de Pago Móvil Venezolano
 *
 * Formatos reales soportados:
 *   - Banesco (app clásica + confirmación simple)
 *   - Mercantil Tpago
 *   - Banco de Venezuela / PagomóvilBDV
 *   - BBVA Provincial / Dinero Rápido
 *   - 100% Banco
 *   - Mercantil, BNC, Bancaribe, Exterior, etc.
 */

// ============================================================
// REGISTRO DE BANCOS
// ============================================================

const BANKS = [
  { id: 'banesco',    names: ['banesco', 'banesco banco universal'],
    label: 'Banesco',  emoji: '🏦' },
  { id: 'mercantil',  names: ['mercantil banco universal', 'mercantil', 'tpago'],
    label: 'Mercantil', emoji: '🏦' },
  { id: 'bdv',        names: ['pagomóvilbdv', 'pagomovilbdv', 'bdv', 'bdvapp', 'banco de venezuela'],
    label: 'Banco de Venezuela', emoji: '🏛️' },
  { id: '100banco',   names: ['100% banco', '100% pago móvil'],
    label: '100% Banco', emoji: '💯' },
  { id: 'provincial', names: ['bbva provincial', 'banco provincial', 'provincial', 'dinero rápido', 'dinero rapido'],
    label: 'BBVA Provincial', emoji: '🏛️' },
  { id: 'bnc',        names: ['bnc', 'banco nacional de crédito'],
    label: 'BNC', emoji: '🏛️' },
  { id: 'exterior',   names: ['banco exterior'],
    label: 'Banco Exterior', emoji: '🌎' },
  { id: 'bancaribe',  names: ['bancaribe', 'banco bancaribe'],
    label: 'Bancaribe', emoji: '🏦' },
  { id: 'tesoro',     names: ['banco del tesoro'],
    label: 'Banco del Tesoro', emoji: '🏛️' },
  { id: 'venezolano', names: ['venezolano de crédito', 'banco venezolano de crédito'],
    label: 'Banco Venezolano de Crédito', emoji: '🏦' },
  { id: 'banplus',    names: ['banplus'],
    label: 'Banplus', emoji: '🏦' },
  { id: 'bod',        names: ['bod', 'banco occidental de descuento'],
    label: 'BOD', emoji: '🏛️' },
];

// ============================================================
// LABELS POR CAMPO (ordenados por prioridad)
// ============================================================

const LABEL_PATTERNS = {
  REFERENCIA: [
    /^N[ÚU]MERO\s+DE\s+REFERENCIA/i,
    /^N[RO°º]\.?\s*(?:DE\s+)?REFERENCIA/i,
    /^N[ÚU]MERO\s+DE\s+OPERACI[OÓ]N/i,
    /^REFERENCIA/i,
    /^TRANSACCI[OÓ]N/i,
    /^OPERACI[OÓ]N/i,
    /^REF\b/i,
  ],
  MONTO: [
    /^MONTO\s+\(BS\.?\)/i,
    /^MONTO\s+EN\s+BOL[IÍ]VARES/i,
    /^MONTO\s+(DE\s+LA\s+)?OPERACI[OÓ]N/i,
    /^MONTO\b/i,
    /^TOTAL\b/i,
  ],
  FECHA: [
    /^FECHA\s+(Y\s+HORA\s+DEL\s+ENV[IÍ]O)?/i,
  ],
  TELEFONO_ORIGEN: [
    /^N[ÚU]MERO\s+CELULAR\s+(DE\s+)?ORIGEN/i,
    /^TEL[EÉ]FONO\s+ORIGEN/i,
    /^TEL[EÉ]FONO\s+CELULAR/i,
    /^ORIGEN\b/i,
    /^PAGADOR\b/i,
    /^N[ÚU]MERO\s+ORIGEN/i,
  ],
  TELEFONO_DESTINO: [
    /^N[ÚU]MERO\s+CELULAR\s+(DE\s+)?DESTINO/i,
    /^TEL[EÉ]FONO\s+DESTINO/i,
    /^DESTINO\b/i,
    /^BENEFICIARIO\b/i,
    /^N[ÚU]MERO\s+CELULAR\b/i,
    /^N[ÚU]MERO\s+CELULAR$/i,
  ],
  BANCO_RECEPTOR: [
    /^BANCO\s+DESTINO/i,
    /^BANCO\s+RECEPTOR/i,
    /^BANCO\b/i,
  ],
  CONCEPTO: [
    /^CONCEPTO/i,
  ],
  IDENTIFICACION: [
    /^IDENTIFICACI[OÓ]N\s+RECEPTOR/i,
    /^C[ÉE]DULA\s+BENEFICIARIO/i,
    /^C[ÉE]DULA\s+DE\s+IDENTIDAD/i,
    /^DOCUMENTO\s+DE\s+IDENTIDAD/i,
    /^IDENTIFICACI[OÓ]N\b/i,
    /^C[ÉE]DULA\b/i,
  ],
  NOMBRE: [
    /^NOMBRE\b/i,
  ],
  CUENTA_ORIGEN: [
    /^CUENTA\s+ORIGEN/i,
    /^CUENTA\s+PAGADORA/i,
  ],
};

const UI_LABELS = [
  /^(aceptar|listo|ok|confirmar|cancelar|volver|salir|continuar|atrás|atras)/i,
  /^(agregar\s+(a\s+)?pagos?\s+(frecuentes)?)/i,
  /^[Ee][)\]]\s*agregar/i,
  /^(compartir|enviar|imprimir|descargar)/i,
  /^(recibo|operaci[oó]n\s+exitosa|pago\s+realizado\s+exitosamente)/i,
  /^(el\s+dinero\s+fue\s+enviado)/i,
  /^(tu\s+\w+\s+fue\s+exitoso)/i,
  /^(comprobante\s+de\s+operaci[oó]n)/i,
  /^(crear\s+acceso\s+directo)/i,
  /^(volver\s+al\s+monedero)/i,
];

// ============================================================
// CLASE PRINCIPAL
// ============================================================

export class PagoMovilParser {

  static parse(rawText) {
    if (!rawText || typeof rawText !== 'string') return null;
    let text = rawText.trim();
    if (!this._isMobilePayment(text)) return null;

    const bancoDetectado = this._detectBank(text);
    const lines = text.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 2 && !this._isUI(l));

    const fecha = this._extractDate(lines);
    const montoBolivares = this._extractAmount(lines);
    const referencia = this._extractReference(lines);
    const concepto = this._extractConcept(lines);
    const pagador = this._extractPhone('ORIGEN', lines);
    const beneficiario = this._extractPhone('DESTINO', lines) || this._extractGenericPhone(lines);
    const bancoReceptor = this._extractBankReceptor(lines);
    const bancoEmisor = bancoDetectado?.nombre || null;
    const receptorId = this._extractId(lines);
    const nombreReceptor = this._extractName(lines);
    const cuentaOrigen = this._extractCuenta(lines);

    return {
      banco: bancoDetectado?.id || 'desconocido',
      fecha, montoBolivares, referencia, concepto,
      pagador, beneficiario,
      bancoEmisor, bancoReceptor,
      receptorId, nombreReceptor, cuentaOrigen,
      raw: text,
    };
  }

  static validate(parsed) {
    if (!parsed) return { valid: false, errors: ['No se reconoce como Pago Móvil'] };
    const errors = [];
    if (!parsed.fecha) errors.push('No se pudo extraer la fecha');
    if (parsed.montoBolivares === null || parsed.montoBolivares === undefined) errors.push('No se pudo extraer el monto');
    if (!parsed.referencia) errors.push('No se pudo extraer el número de referencia');
    return { valid: errors.length === 0, errors, data: parsed };
  }

  // ================================================================
  // BANK DETECTION
  // ================================================================

  static _detectBank(text) {
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    const header = lines.slice(0, 6).join('\n').toLowerCase();
    const lower = text.toLowerCase();

    // Prioridad 1: cabecera — gana el que aparece MÁS TEMPRANO
    let best = null;
    let bestPos = Infinity;
    for (const bank of BANKS) {
      for (const name of bank.names) {
        const pos = header.indexOf(name.toLowerCase());
        if (pos !== -1 && pos < bestPos) { bestPos = pos; best = bank; }
      }
    }
    if (best) return { id: best.id, nombre: best.label, emoji: best.emoji };

    // Prioridad 2: todo el texto — preferir match más largo
    let bestLen = 0;
    for (const bank of BANKS) {
      for (const name of bank.names) {
        if (lower.includes(name) && name.length > bestLen) { bestLen = name.length; best = bank; }
      }
    }
    return best ? { id: best.id, nombre: best.label, emoji: best.emoji } : null;
  }

  static _isMobilePayment(text) {
    const lower = text.toLowerCase();
    let count = 0;
    const signals = [
      'pago móvil', 'pago movil', 'pagomóvil', 'pagomovil',
      'tpago', 'operación exitosa', 'operacion exitosa',
      'pago realizado exitosamente',
      'monto de la operación', 'número de referencia',
      'nro. de referencia', 'comprobante de operación',
      'el dinero fue enviado', 'dinero rápido', 'dinero rapido',
      'banesco', 'mercantil', 'provincial', 'bbva',
      'banco de venezuela', 'bdv', '100% banco',
    ];
    for (const s of signals) { if (lower.includes(s)) count++; }
    return count >= 2 || (count >= 1 && (lower.includes('bs.') || lower.includes('referencia')));
  }

  // ================================================================
  // MATCHER
  // ================================================================

  static _matchLabel(lines, patterns) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (!match) continue;

        const afterLabel = line.slice(match[0].length).trim();

        // Caso 1: "Label: valor"
        const colonMatch = afterLabel.match(/^:\s*(.+)/);
        if (colonMatch) { const v = colonMatch[1].trim(); if (v && !this._isUI(v)) return v; }

        // Caso 2: "Label valor" sin colon en misma línea
        if (afterLabel && afterLabel.length > 1 && !afterLabel.startsWith(':')) {
          const lower = afterLabel.toLowerCase();
          // Rechazar si parece título/header de app
          const isTitle = /pago\s*m[oó]vil|pagom[oó]vil|operaci[oó]n\s*exitosa|comprobante/.test(lower);
          if (!isTitle && !this._looksLikeLabel(afterLabel) && !this._isUI(afterLabel)) {
            return afterLabel;
          }
        }

        // Caso 3: Label\nValor en siguiente línea
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (!next || this._looksLikeLabel(next)) break;
          if (this._isUI(next)) break;
          return next;
        }
        continue; // probar otro patrón en esta línea
      }
    }
    return null;
  }

  static _looksLikeLabel(line) {
    if (line.endsWith(':')) return true;
    for (const group of Object.values(LABEL_PATTERNS)) {
      for (const pat of group) { if (pat.test(line)) return true; }
    }
    return false;
  }

  static _isUI(text) {
    return UI_LABELS.some(p => p.test(text.trim()));
  }

  // ================================================================
  // EXTRACTORES
  // ================================================================

  static _extractDate(lines) {
    let val = this._matchLabel(lines, LABEL_PATTERNS.FECHA);
    if (val) {
      const m = val.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
      if (m) return this._fmtDate(m);
    }
    for (const l of lines) {
      const m = l.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
      if (m) return this._fmtDate(m);
    }
    return null;
  }

  static _fmtDate(m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = '20' + y;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  static _extractAmount(lines) {
    const val = this._matchLabel(lines, LABEL_PATTERNS.MONTO);
    if (val) { const m = val.match(/(?:Bs\.?\s*)?([\d.,]+)/); if (m) return this._parseVEN(m[1]); }
    for (const l of lines) {
      const m = l.match(/(?:Bs\.?\s*)([\d.,]+)/);
      if (m) return this._parseVEN(m[1]);
    }
    for (const l of lines) {
      if (/^\d{1,3}(?:\.\d{3})*,\d{2}$/.test(l)) return this._parseVEN(l);
    }
    return null;
  }

  static _extractReference(lines) {
    const val = this._matchLabel(lines, LABEL_PATTERNS.REFERENCIA);
    if (val) {
      const t = val.trim();
      if (/^\d{4,15}$/.test(t)) return t;
      const m = t.match(/(\d{6,15})/); if (m) return m[1];
    }
    for (const l of lines) {
      const m = l.match(/\b([1-9]\d{5,14})\b/);
      if (m) return m[1];
    }
    return null;
  }

  static _extractConcept(lines) {
    const c = this._matchLabel(lines, LABEL_PATTERNS.CONCEPTO);
    if (c) return this._cleanConcept(c);
    for (let i = 0; i < lines.length; i++) {
      if (/^CONCEPTO/i.test(lines[i])) {
        const p = []; for (let j = i + 1; j < lines.length; j++) {
          if (this._looksLikeLabel(lines[j])) break; p.push(lines[j]);
        }
        if (p.length) return this._cleanConcept(p.join(' '));
      }
    }
    return null;
  }

  static _cleanConcept(r) {
    if (!r) return null;
    let c = r.trim();
    for (const m of [/[Ee][)\]]?\s*agregar/i, /agregar\s+a\s+pagos/i, /aceptar/i, /listo/i, /ok/i]) {
      const idx = c.search(m); if (idx > 0) c = c.substring(0, idx).trim();
    }
    return c.length ? c : null;
  }

  static _extractPhone(type, lines) {
    const key = type === 'ORIGEN' ? 'TELEFONO_ORIGEN' : 'TELEFONO_DESTINO';
    const val = this._matchLabel(lines, LABEL_PATTERNS[key]);
    if (val) { const m = val.match(/(0\d{2,3})-?(\d{3,7})/); if (m) return `${m[1]}${m[2]}`; }
    return null;
  }

  static _extractGenericPhone(lines) {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].toLowerCase();
      if (l.includes('beneficiario') || l.includes('celular') || l.includes('teléfono') || l.includes('telefono')) {
        let m = lines[i].match(/(0(?:4\d{2}|2\d{2}))-?(\d{3,7})/);
        if (m) return `${m[1]}${m[2]}`;
        if (i + 1 < lines.length) {
          const ml = lines[i+1].match(/(0(?:4\d{2}|2\d{2}))-?(\d{3,7})/);
          if (ml && lines[i+1].length < 15) return `${ml[1]}${ml[2]}`;
        }
      }
    }
    for (const l of lines) {
      const m = l.trim().match(/^(0(?:4\d{2}|2\d{2}))-?(\d{3,7})$/);
      if (m) return `${m[1]}${m[2]}`;
    }
    return null;
  }

  static _extractBankReceptor(lines) {
    const val = this._matchLabel(lines, LABEL_PATTERNS.BANCO_RECEPTOR);
    if (val) return val.replace(/^\d{4}\s*-\s*/, '').trim();
    return null;
  }

  static _extractId(lines) {
    const val = this._matchLabel(lines, LABEL_PATTERNS.IDENTIFICACION);
    if (val) {
      const clean = val.replace(/^([VEJPGvejpg])[:,\s]+/, '$1');
      const m = clean.match(/[VEJPGvejpg]-?[\d.]+/);
      if (m) return m[0].replace(/\./g, '');
      if (/\d{6,}/.test(val)) return val.match(/\d{6,}/)[0];
    }
    const full = lines.join('\n');
    const m = full.match(/[VEJPGvejpg]-?\d{5,10}/);
    return m ? m[0].replace(/\./g, '') : null;
  }

  static _extractName(lines) { return this._matchLabel(lines, LABEL_PATTERNS.NOMBRE); }
  static _extractCuenta(lines) { return this._matchLabel(lines, LABEL_PATTERNS.CUENTA_ORIGEN); }

  // ================================================================
  // NÚMEROS
  // ================================================================

  static _parseVEN(str) {
    if (!str) return null;
    let s = str.trim();
    const hasComma = s.includes(',');
    const hasDot = s.includes('.');
    if (hasComma && hasDot) {
      if (s.indexOf(',') < s.indexOf('.')) { s = s.replace(/,/g, ''); }
      else { s = s.replace(/\./g, ''); s = s.replace(',', '.'); }
    } else if (hasComma) { s = s.replace(',', '.'); }
    else if (hasDot && (s.match(/\./g) || []).length > 1) { s = s.replace(/\./g, ''); }
    return parseFloat(s);
  }

  // ================================================================
  // FORMATO REVISIÓN
  // ================================================================

  static formatForReview(parsed, tasaBs) {
    if (!parsed) return '❌ No se pudieron extraer datos del comprobante.';
    const montoD = tasaBs ? (parsed.montoBolivares / tasaBs).toFixed(2) : 'N/A';
    const banco = BANKS.find(b => b.id === parsed.banco);
    const hdr = banco ? `${banco.emoji} *Banco:* ${banco.label}` : '';
    return [
      '📋 **Datos extraídos del Pago Móvil**', hdr, '',
      `📅 **Fecha:** ${parsed.fecha || '❓'}`,
      `💰 **Monto:** Bs. ${parsed.montoBolivares?.toFixed(2) || '❓'}`,
      `💵 **En dólares:** $${montoD} (tasa: Bs. ${tasaBs?.toFixed(2) || 'N/A'})`,
      `🔢 **Referencia:** ${parsed.referencia || '❓'}`,
      `📝 **Concepto:** ${parsed.concepto || '(sin concepto)'}`,
      `📱 **Origen:** ${parsed.pagador || parsed.cuentaOrigen || '❓'}`,
      `📱 **Destino:** ${parsed.beneficiario || '❓'}`,
      parsed.nombreReceptor ? `👤 **Receptor:** ${parsed.nombreReceptor}` : null,
      `🆔 **Cédula:** ${parsed.receptorId || '❓'}`,
      `🏦 **Banco emisor:** ${parsed.bancoEmisor || '❓'}`,
      `🏦 **Banco receptor:** ${parsed.bancoReceptor || '❓'}`,
    ].filter(Boolean).join('\n');
  }
}

// ================================================================
// PRUEBAS
// ================================================================

function runTests() {
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.log(`  ❌ ${name}: ${e.message}`); }};
  const a = (cond, msg) => { if (!cond) throw new Error(msg || 'Assertion'); };

  console.log('\n🧪 === PRUEBAS ===\n');

  // 1. BANESCO clásico
  console.log('\n📌 BANESCO (clásico)');
  const b1 = `Recibo
¡Operación Exitosa!
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
pago`.trim();
  t('detecta Banesco', () => { const d = PagoMovilParser._detectBank(b1); a(d?.id === 'banesco'); });
  t('parsea Banesco', () => {
    const p = PagoMovilParser.parse(b1);
    a(p.fecha === '2026-05-10'); a(p.montoBolivares === 6300); a(p.referencia === '061308215588'); a(p.concepto === 'pago');
  });
  t('validación', () => a(PagoMovilParser.validate(PagoMovilParser.parse(b1)).valid));

  // 2. TPAGO (Mercantil)
  console.log('\n📌 TPAGO (Mercantil)');
  const t2 = `¡Listo!
Tu Tpago fue exitoso
Monto (Bs.):
2.543,00
Nro. de referencia:
40227643
Fecha y hora del envío:
13/05/2026 a las 3:40:29 PM
Cuenta origen:
Cta. Ahorro *6127
Beneficiario:
0414-5145068
Documento de identidad:
V-24.527.534
Banco destino:
0134 - Banesco Banco Universal S.a.c.a.
Concepto:
yogurt`.trim();
  t('detecta Mercantil (tpago)', () => a(PagoMovilParser._detectBank(t2)?.id === 'mercantil'));
  t('parsea Tpago', () => {
    const p = PagoMovilParser.parse(t2);
    a(p.fecha === '2026-05-13'); a(p.montoBolivares === 2543); a(p.referencia === '40227643');
    a(p.beneficiario === '04145145068'); a(p.concepto === 'yogurt');
    a(['V24527534', 'V-24527534'].includes(p.receptorId));
  });

  // 3. BDV / PagomóvilBDV
  console.log('\n📌 BDV');
  const b3 = `Comprobante de operación
PagomóvilBDV Personas
Fecha: 17/05/2026
Operación: 006059869247
Identificación: 24527534
Origen: 0102****4024
Destino: 04145145068
Banco: 0134 - BANESCO
Concepto: pago`.trim();
  t('detecta BDV', () => a(PagoMovilParser._detectBank(b3)?.id === 'bdv'));

  // 4. 100% BANCO
  console.log('\n📌 100% BANCO');
  const c1 = `Transacción 100% Pago Móvil
PAGO REALIZADO EXITOSAMENTE
Transacción 10238
Fecha 15-04-2026 04:25:09 p.m
Cuenta Pagadora
0156****10201913269
Nombre
Edgar Alvarado
Cedula Beneficiario V:24527534
Teléfono Celular
04145145068
Banco Destino MERCANTIL
Concepto pago
Monto en Bolivares Bs.6,222.00
Tasa de Cambio Bs.478.58`.trim();
  t('detecta 100% Banco', () => a(PagoMovilParser._detectBank(c1)?.id === '100banco'));
  t('parsea 100% Banco', () => {
    const p = PagoMovilParser.parse(c1);
    a(p.fecha === '2026-04-15'); a(p.montoBolivares === 6222); a(p.referencia === '10238');
    a(p.beneficiario === '04145145068'); a(p.concepto === 'pago');
    a(['V24527534', 'V-24527534'].includes(p.receptorId));
    a(p.bancoReceptor?.toLowerCase().includes('mercantil'));
    a(p.nombreReceptor === 'Edgar Alvarado');
  });

  // 5. DINERO RÁPIDO (BBVA Provincial)
  console.log('\n📌 DINERO RÁPIDO (Provincial)');
  const d1 = `MARIA MARITZA LINARES
El dinero fue enviado
Bs.2.414,00
E Dinero Rápido
Banco: BANESCO
Número celular: 04145145068
Identificación: V24527534
Concepto: Pago
Fecha: 22/04/2026
Referencia 000005739`.trim();
  t('detecta Provincial', () => a(PagoMovilParser._detectBank(d1)?.id === 'provincial'));
  t('parsea Dinero Rápido', () => {
    const p = PagoMovilParser.parse(d1);
    a(p.fecha === '2026-04-22'); a(p.montoBolivares === 2414); a(p.referencia === '000005739');
    a(p.concepto === 'Pago'); a(p.beneficiario === '04145145068');
    a(p.bancoReceptor?.toLowerCase().includes('banesco'));
  });

  // 6. BANESCO simple
  console.log('\n📌 BANESCO (confirmación)');
  const s1 = `JOSE GERMAN CAMACHO VALERO
El dinero fue enviado
Banco: BANESCO
Número celular: 04145145068
Identificación: V24527534
Concepto: Pago
Fecha: 08/05/2026
Referencia: 000005695`.trim();
  t('detecta Banesco (fallback)', () => a(PagoMovilParser._detectBank(s1)?.id === 'banesco'));
  t('parsea Banesco simple', () => {
    const p = PagoMovilParser.parse(s1);
    a(p.fecha === '2026-05-08'); a(p.referencia === '000005695');
    a(['V24527534', 'V-24527534'].includes(p.receptorId));
  });

  // 7. NO PAGO MÓVIL
  console.log('\n📌 NO ES PAGO MÓVIL');
  t('USDT rechazado', () => a(PagoMovilParser.parse('Payment Successful\nPaid With USDT') === null));
  t('factura rechazada', () => a(PagoMovilParser.parse('Factura de electricidad') === null));
  t('texto vacío', () => a(PagoMovilParser.parse('') === null));
  t('null', () => a(PagoMovilParser.parse(null) === null));

  // 8. _parseVEN
  console.log('\n📌 _parseVEN');
  t('6.300,00', () => a(PagoMovilParser._parseVEN('6.300,00') === 6300));
  t('6,222.00 (intl)', () => a(PagoMovilParser._parseVEN('6,222.00') === 6222));
  t('2.543,00', () => a(PagoMovilParser._parseVEN('2.543,00') === 2543));
  t('500,00', () => a(PagoMovilParser._parseVEN('500,00') === 500));

  // RESULTADO
  const total = pass + fail;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`📊 ${pass}/${total} pruebas pasaron`);
  if (fail > 0) { console.log(`❌ ${fail} fallaron`); process.exit(1); }
  else console.log('✅ Todas las pruebas pasaron');
}

if (process.argv[1] && (process.argv[1].includes('parser') || process.argv.includes('--test'))) { runTests(); }
