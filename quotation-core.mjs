/**
 * Audit the supported repair quotation layout without changing any source data.
 * Self contained so the exact same function can run inside the n8n Code node.
 * Formula evaluation is deliberately limited; it never invokes JavaScript code.
 */
export function processQuotation(workbook) {
  const EPSILON = 0.01;
  const issues = [];
  const issueKeys = new Set();
  const parts = [];
  const engines = [];
  const totals = [];
  const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase().replace(/\s+/g, ' ');
  const text = value => value === null || value === undefined ? '' : String(value).trim();
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const blank = value => value === null || value === undefined || value === '';
  const invalid = message => { const error = new Error(message); error.code = 'INVALID_QUOTATION'; throw error; };
  const columnNumber = letters => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const columnName = n => { let result = ''; while (n > 0) { n--; result = String.fromCharCode(65 + n % 26) + result; n = Math.floor(n / 26); } return result; };
  const coordinate = address => { const m = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/i.exec(address); if (!m) throw new Error('Referencia de celda no compatible.'); const col = columnNumber(m[1]), row = Number(m[2]); if (col > 16384 || row > 1048576) throw new Error('Referencia fuera de Excel.'); return { col, row, address: `${m[1].toUpperCase()}${row}` }; };
  const addIssue = (severity, code, sheet, cell, message, extra = {}) => {
    const key = `${code}\u0000${sheet}\u0000${cell}`;
    if (!issueKeys.has(key)) { issueKeys.add(key); issues.push({ severity, code, sheet, cell, message, ...extra }); }
  };
  if (!workbook || !Array.isArray(workbook.sheets) || workbook.sheets.length === 0) invalid('No se encontraron hojas para analizar.');
  if (workbook.sheets.length > 50) invalid('La cotización excede el límite de 50 hojas.');
  const sheets = new Map();
  const sheetsByName = new Map();
  let cellCount = 0;
  for (const sheet of workbook.sheets) {
    if (!sheet || typeof sheet.name !== 'string' || !Array.isArray(sheet.cells)) invalid('La estructura de la cotización no es válida.');
    const cells = new Map(), rows = new Map();
    for (const cell of sheet.cells) {
      if (++cellCount > 200000) invalid('La cotización tiene demasiadas celdas.');
      const pos = coordinate(cell.address || `${columnName(cell.column)}${cell.row}`);
      const entry = { ...cell, address: pos.address, row: pos.row, column: pos.col };
      cells.set(pos.address, entry);
      if (!rows.has(pos.row)) rows.set(pos.row, new Map());
      rows.get(pos.row).set(pos.col, entry);
    }
    const data = { name: sheet.name, cells, rows };
    if (sheetsByName.has(sheet.name.toLowerCase())) invalid('Hay nombres de hoja repetidos.');
    sheets.set(sheet.name, data); sheetsByName.set(sheet.name.toLowerCase(), data);
  }
  const get = (sheet, row, col) => sheet.cells.get(`${columnName(col)}${row}`);
  const value = (sheet, row, col) => get(sheet, row, col)?.value ?? null;
  const formulaCell = cell => !!cell && (typeof cell.formula === 'string' || !!cell.formulaType || !!cell.formulaUnsupported);

  // A small parser, not eval(): literals, cell/range references, arithmetic,
  // percentages, SUM and exact VLOOKUP. Unknown syntax fails closed.
  const formulaMemo = new Map();
  const inProgress = new Set();
  let evaluationSteps = 0;
  const unsupported = message => { throw new Error(message); };
  const numeric = result => {
    if (result === null) return 0; // Excel arithmetic with an actually blank cell.
    if (typeof result !== 'number' || !Number.isFinite(result)) unsupported('La fórmula usa un valor no numérico.');
    return result;
  };
  const checked = result => { if (typeof result === 'number' && !Number.isFinite(result)) unsupported('La fórmula produce un número no finito.'); return result; };
  function evaluateCell(sheet, address, depth = 0) {
    if (++evaluationSteps > 1000000 || depth > 80) unsupported('La fórmula excede el límite de complejidad.');
    const key = `${sheet.name}\u0000${address}`;
    const cached = formulaMemo.get(key);
    if (cached) { if (cached.error) unsupported(cached.error); return cached.value; }
    const cell = sheet.cells.get(address);
    if (!cell) return null;
    if (!formulaCell(cell)) {
      if (cell.value && typeof cell.value === 'object') unsupported('La celda contiene un error o un valor no compatible.');
      return cell.value ?? null;
    }
    if (inProgress.has(key)) unsupported('La fórmula contiene una referencia circular.');
    const formula = cell.resolvedFormula ?? cell.formula;
    if (cell.formulaUnsupported || typeof formula !== 'string' || !formula) unsupported('La fórmula no se pudo interpretar de forma segura.');
    if (formula.length > 4096) unsupported('La fórmula excede el límite de longitud.');
    inProgress.add(key);
    try {
      const result = parseFormula(formula, sheet, depth + 1);
      if (result && typeof result === 'object') unsupported('La fórmula devuelve un rango, no un valor.');
      formulaMemo.set(key, { value: result });
      return result;
    } catch (error) { formulaMemo.set(key, { error: error.message }); throw error; }
    finally { inProgress.delete(key); }
  }
  function parseFormula(formula, currentSheet, depth) {
    const source = formula.replace(/^=/, '');
    let index = 0, tokens = 0;
    const whitespace = () => { while (/\s/.test(source[index] || '') && index < source.length) index++; };
    const take = character => { whitespace(); if (source[index] === character) { index++; return true; } return false; };
    const referenceValue = ref => {
      if (ref.range) return ref;
      return evaluateCell(ref.sheet, ref.start.address, depth + 1);
    };
    function parseReference() {
      whitespace();
      const start = index;
      let sheet = currentSheet;
      let sheetName = null;
      if (source[index] === "'") {
        index++; let name = '', closed = false;
        while (index < source.length) {
          if (source[index] === "'") { if (source[index + 1] === "'") { name += "'"; index += 2; } else { index++; closed = true; break; } }
          else name += source[index++];
        }
        if (!closed || !take('!')) unsupported('Referencia de hoja no compatible.');
        sheetName = name;
      } else {
        const qualified = /^([A-Za-z_\u00c0-\u024f][A-Za-z0-9_.\u00c0-\u024f]*|\d+)!/.exec(source.slice(index));
        if (qualified) { sheetName = qualified[1]; index += qualified[0].length; }
      }
      if (sheetName !== null) { sheet = sheetsByName.get(sheetName.toLowerCase()); if (!sheet) unsupported('La fórmula referencia una hoja que no está disponible.'); }
      const ref = /^\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}(?![A-Za-z0-9_])/.exec(source.slice(index));
      if (!ref) { if (sheetName !== null) unsupported('Referencia de celda no compatible.'); index = start; return null; }
      index += ref[0].length;
      const first = coordinate(ref[0]);
      if (take(':')) {
        whitespace(); const last = /^\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}(?![A-Za-z0-9_])/.exec(source.slice(index));
        if (!last) unsupported('Rango no compatible.'); index += last[0].length;
        const end = coordinate(last[0]);
        if (end.row < first.row || end.col < first.col || (end.row - first.row + 1) * (end.col - first.col + 1) > 20000) unsupported('El rango excede el límite permitido.');
        return { range: true, sheet, start: first, end };
      }
      return { range: false, sheet, start: first };
    }
    function primary() {
      if (++tokens > 2048) unsupported('La fórmula excede el límite de complejidad.');
      whitespace();
      if (take('(')) { const result = expression(); if (!take(')')) unsupported('Paréntesis incompletos.'); return result; }
      if (source[index] === '"') {
        index++; let result = '';
        while (index < source.length) { if (source[index] === '"') { if (source[index + 1] === '"') { result += '"'; index += 2; } else { index++; return result; } } else result += source[index++]; }
        unsupported('Texto de fórmula incompleto.');
      }
      const fn = /^([A-Za-z][A-Za-z0-9_.]*)\s*\(/.exec(source.slice(index));
      if (fn) {
        index += fn[0].length;
        const name = fn[1].toUpperCase();
        if (!['SUM', 'VLOOKUP'].includes(name)) unsupported(`Función no compatible: ${name}.`);
        const args = [];
        if (!take(')')) { do { args.push(expression()); if (args.length > 255) unsupported('Demasiados argumentos.'); } while (take(',')); if (!take(')')) unsupported('Argumentos de fórmula no compatibles.'); }
        if (name === 'SUM') {
          let result = 0;
          for (const arg of args) {
            if (arg?.range) { for (let row = arg.start.row; row <= arg.end.row; row++) for (let col = arg.start.col; col <= arg.end.col; col++) { const v = evaluateCell(arg.sheet, `${columnName(col)}${row}`, depth + 1); if (typeof v === 'number') result += v; } }
            else if (typeof arg === 'number') result += arg;
            else if (arg !== null) unsupported('SUM contiene un argumento no numérico.');
          }
          return checked(result);
        }
        if (args.length !== 4 || !args[1]?.range || !Number.isInteger(args[2]) || args[2] < 1 || args[3] !== 0) unsupported('Solo se admite VLOOKUP con coincidencia exacta y cuatro argumentos.');
        const [lookup, range, output] = args;
        if (output > range.end.col - range.start.col + 1) unsupported('La columna VLOOKUP está fuera del rango.');
        if (typeof lookup === 'string' && /[?*~]/.test(lookup)) unsupported('VLOOKUP con comodines requiere revisión en Excel.');
        for (let row = range.start.row; row <= range.end.row; row++) {
          const key = evaluateCell(range.sheet, `${columnName(range.start.col)}${row}`, depth + 1);
          const matches = typeof key === typeof lookup && (typeof key === 'string' ? key.toLowerCase() === lookup.toLowerCase() : key === lookup);
          if (matches) return evaluateCell(range.sheet, `${columnName(range.start.col + output - 1)}${row}`, depth + 1) ?? 0;
        }
        unsupported('VLOOKUP no encuentra el número de parte en su catálogo.');
      }
      const ref = parseReference();
      if (ref) return referenceValue(ref);
      whitespace();
      const literal = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/.exec(source.slice(index));
      if (literal) { index += literal[0].length; return checked(Number(literal[0])); }
      const boolean = /^(TRUE|FALSE)(?![A-Za-z0-9_])/i.exec(source.slice(index));
      if (boolean) { index += boolean[0].length; return boolean[1].toUpperCase() === 'TRUE' ? 1 : 0; }
      unsupported('Sintaxis de fórmula no compatible.');
    }
    function unary() { if (take('+')) return numeric(unary()); if (take('-')) return -numeric(unary()); let result = primary(); while (take('%')) result = numeric(result) / 100; return result; }
    // Exponentiation is outside the supported quotation grammar.
    function power() { return unary(); }
    function multiply() { let result = power(); for (;;) { if (take('*')) result = checked(numeric(result) * numeric(power())); else if (take('/')) { const divisor = numeric(power()); if (divisor === 0) unsupported('División por cero.'); result = checked(numeric(result) / divisor); } else return result; } }
    function expression() { let result = multiply(); for (;;) { if (take('+')) result = checked(numeric(result) + numeric(multiply())); else if (take('-')) result = checked(numeric(result) - numeric(multiply())); else return result; } }
    const result = expression(); whitespace();
    if (index !== source.length) unsupported('La fórmula contiene sintaxis no compatible.');
    return result;
  }

  let formulaCells = 0, unverifiedFormulas = 0;
  for (const sheet of sheets.values()) for (const cell of sheet.cells.values()) {
    if (!formulaCell(cell)) continue;
    formulaCells++;
    const hasValue = cell.hasCachedValue !== false && !blank(cell.value);
    if (!hasValue) addIssue('error', 'formula_missing_cache', sheet.name, cell.address, 'La fórmula no tiene un resultado guardado. Abra el original en Excel, recalcule y guarde una copia.');
    else if (cell.value && typeof cell.value === 'object') addIssue('error', 'formula_cached_error', sheet.name, cell.address, 'El resultado guardado de la fórmula contiene un error de Excel.');
    try {
      const expected = evaluateCell(sheet, cell.address);
      if (!hasValue || (cell.value && typeof cell.value === 'object')) { unverifiedFormulas++; continue; }
      const equal = typeof expected === 'number' && typeof cell.value === 'number' ? Math.abs(expected - cell.value) <= EPSILON : expected === cell.value;
      if (!equal) addIssue('error', 'formula_stale', sheet.name, cell.address, 'El resultado guardado no coincide con el cálculo independiente. Se conserva el valor guardado.', { stored_value: number(cell.value) ?? text(cell.value), expected_value: number(expected) ?? text(expected) });
    } catch (error) {
      unverifiedFormulas++;
      addIssue('warning', 'formula_unverified', sheet.name, cell.address, `No se pudo verificar esta fórmula: ${error.message}`);
    }
  }
  if (workbook.calculation?.mode === 'manual') addIssue('warning', 'calculation_manual', '', '', 'El libro está configurado para cálculo manual. Recalcule y guarde en Excel antes de enviar la cotización.');
  if (workbook.calculation?.fullCalcOnLoad || workbook.calculation?.forceFullCalc) addIssue('warning', 'calculation_requested', '', '', 'El libro solicita un recálculo al abrirse. Los importes mostrados son los guardados en el archivo.');

  const role = value => {
    const name = normalize(value).replace(/[.$:]/g, '').trim();
    if (name === 'GRUPO') return 'group';
    if (name === 'ITEM' || name === 'ÍTEM') return 'item';
    if (name === 'CANT' || name === 'CANTIDAD') return 'quantity';
    if (name === 'FALTA') return 'shortage';
    if (name === 'NUMERO PARTE' || name === 'NUMERO DE PARTE') return 'part';
    if (name === 'DESCRIPCION') return 'description';
    if (name === 'PUNITARIO' || name === 'P UNITARIO' || name === 'PRECIO UNITARIO') return 'price';
    if (name === 'TOTAL') return 'total';
    return null;
  };
  const findMetadata = (sheet, header, label) => {
    for (const [rowNumber, row] of sheet.rows) if (rowNumber < header) for (const [col, cell] of row) if (normalize(cell.value).replace(/[: ]/g, '') === label) {
      for (let next = col + 1; next <= col + 5; next++) { const candidate = value(sheet, rowNumber, next); if (!blank(candidate) && normalize(candidate).replace(/[: ]/g, '') !== label) return text(candidate); }
    }
    return '';
  };
  const addTotal = (key, label, sheet, cell) => {
    if (!cell) return;
    totals.push({ key, label, value: number(cell.value), source_sheet: sheet.name, source_cell: cell.address, status: number(cell.value) === null || issues.some(i => i.sheet === sheet.name && i.cell === cell.address) ? 'review' : 'ok' });
  };
  for (const sheet of sheets.values()) {
    let headerRow = null, columns = null;
    let candidateRow = null;
    for (const [rowNumber, row] of [...sheet.rows].sort((a, b) => a[0] - b[0])) {
      const found = {};
      let duplicateHeader = false;
      for (const [col, cell] of row) { const field = role(cell.value); if (field) {if(found[field]) duplicateHeader=true; found[field] = col;} }
      if (Object.keys(found).length >= 4 && found.item && found.quantity) candidateRow ??= rowNumber;
      if (['group', 'item', 'quantity', 'shortage', 'part', 'description', 'price', 'total'].every(key => found[key])) {
        if(duplicateHeader) invalid('La tabla de repuestos contiene encabezados repetidos. Cada columna requerida debe aparecer una sola vez.');
        headerRow = rowNumber; columns = found; break;
      }
    }
    if (!headerRow) {
      if (candidateRow !== null) invalid('Una tabla de repuestos tiene encabezados incompletos. Se requieren Grupo, ITEM, CANT o CANTIDAD, FALTA, NUMERO PARTE, DESCRIPCION, P.UNITARIO y TOTAL $.');
      if (normalize(sheet.name) !== 'RESUMEN' && [...sheet.cells.values()].some(cell => !blank(cell.value))) addIssue('warning','sheet_not_extracted',sheet.name,'','Esta hoja no contiene una tabla de repuestos compatible; sus filas no se incluyen en el detalle.');
      continue;
    }
    const sortedRows = [...sheet.rows.keys()].filter(row => row > headerRow).sort((a, b) => a - b);
    const subtotalRow = sortedRows.find(row => [...sheet.rows.get(row).values()].some(cell => ['TOTAL NETO', 'SUBTOTAL', 'SUB TOTAL'].includes(normalize(cell.value))));
    if (!subtotalRow) invalid('Una tabla de repuestos no tiene TOTAL NETO después del detalle. No se puede separar con seguridad de su catálogo de precios.');
    const sheetParts = [];
    for (const row of sortedRows.filter(row => row < subtotalRow)) {
      const raw = Object.fromEntries(Object.entries(columns).map(([key, col]) => [key, value(sheet, row, col)]));
      if (Object.values(raw).every(blank)) continue;
      if (parts.length >= 10000) invalid('La cotización supera el máximo de 10.000 registros de repuestos.');
      const item = { sheet: sheet.name, row, item: text(raw.item), group: text(raw.group), part_number: text(raw.part), description: text(raw.description), quantity: number(raw.quantity), reported_shortage: number(raw.shortage), unit_price_clp: number(raw.price), line_total_clp: number(raw.total), status: 'ok', issues: [] };
      const report = (field, code, message, severity = 'error') => addIssue(severity, code, sheet.name, `${columnName(columns[field])}${row}`, message);
      if (!item.item) report('item', 'missing_item', 'Falta el ITEM de este repuesto.');
      if (!item.part_number) report('part', 'missing_part_number', 'Falta el número de parte.');
      if (!item.description) report('description', 'missing_description', 'Falta la descripción del repuesto.');
      if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) report('quantity', 'invalid_quantity', 'La cantidad debe ser un número entero mayor que cero, dentro del rango seguro.');
      if (item.unit_price_clp === null || item.unit_price_clp < 0) report('price', 'invalid_price', 'El precio unitario debe ser un número no negativo. Un precio vacío no equivale a cero.');
      if (item.line_total_clp === null || item.line_total_clp < 0) report('total', 'invalid_line_total', 'El total de la fila debe ser un número no negativo.');
      if (!blank(raw.shortage) && (!Number.isSafeInteger(item.reported_shortage) || item.reported_shortage < 0)) report('shortage', 'invalid_shortage', 'FALTA debe ser un entero no negativo dentro del rango seguro, o quedar vacío cuando no se conoce.');
      if (item.reported_shortage !== null && item.quantity !== null && item.reported_shortage > item.quantity) report('shortage', 'shortage_above_quantity', 'FALTA es mayor que la cantidad de la fila; confirme ambas cantidades.');
      if (item.quantity !== null && item.unit_price_clp !== null && item.line_total_clp !== null && Math.abs(item.quantity * item.unit_price_clp - item.line_total_clp) > EPSILON) report('total', 'line_total_mismatch', 'El total guardado no coincide con cantidad × precio unitario.');
      sheetParts.push(item); parts.push(item);
    }
    const ids = new Map();
    for (const part of sheetParts) { const id = normalize(part.item); if (id) { if (!ids.has(id)) ids.set(id, []); ids.get(id).push(part); } }
    for (const group of ids.values()) if (group.length > 1) for (const part of group) addIssue('error', 'duplicate_item', sheet.name, `${columnName(columns.item)}${part.row}`, 'El ITEM está repetido dentro de esta hoja. Se señalan todas sus apariciones.');
    const net = get(sheet, subtotalRow, columns.total);
    const quotedNet = number(net?.value);
    if (quotedNet === null) addIssue('error', 'invalid_subtotal', sheet.name, `${columnName(columns.total)}${subtotalRow}`, 'TOTAL NETO no tiene un importe numérico guardado.');
    if (sheetParts.every(part => part.line_total_clp !== null) && quotedNet !== null) {
      const expected = sheetParts.reduce((sum, part) => sum + part.line_total_clp, 0);
      if (Math.abs(expected - quotedNet) > EPSILON) addIssue('error', 'subtotal_mismatch', sheet.name, net.address, 'TOTAL NETO no coincide con la suma de los totales guardados del detalle.', { stored_value: quotedNet, expected_value: expected });
    } else addIssue('warning', 'subtotal_unverified', sheet.name, `${columnName(columns.total)}${subtotalRow}`, 'No se puede conciliar el subtotal porque hay importes faltantes o no numéricos.');
    const following = sortedRows.filter(row => row > subtotalRow && row <= subtotalRow + 5);
    const vatRow = following.find(row => [...sheet.rows.get(row).values()].some(cell => normalize(cell.value) === 'IVA'));
    const totalRow = following.find(row => [...sheet.rows.get(row).values()].some(cell => normalize(cell.value) === 'TOTAL'));
    const engine = findMetadata(sheet, headerRow, 'MOTOR') || sheet.name;
    const serial = findMetadata(sheet, headerRow, 'SERIE');
    const record = { sheet: sheet.name, engine, serial, part_records: sheetParts.length, review_records: 0, shortage_records: 0, reported_shortage_units: 0, unspecified_shortage_records: 0, quoted_net_clp: quotedNet, quoted_vat_clp: vatRow ? number(value(sheet, vatRow, columns.total)) : null, quoted_total_clp: totalRow ? number(value(sheet, totalRow, columns.total)) : null };
    engines.push(record);
    addTotal(`engine_${engines.length}_net`, `Motor ${engine} · Repuestos netos`, sheet, net);
    if (vatRow) addTotal(`engine_${engines.length}_vat`, `Motor ${engine} · IVA registrado`, sheet, get(sheet, vatRow, columns.total));
    if (totalRow) addTotal(`engine_${engines.length}_total`, `Motor ${engine} · Total registrado`, sheet, get(sheet, totalRow, columns.total));
  }
  if (!engines.length) invalid('No se encontró una tabla de cotización compatible. Se requieren Grupo, ITEM, CANT o CANTIDAD, FALTA, NUMERO PARTE, DESCRIPCION, P.UNITARIO, TOTAL $ y TOTAL NETO.');
  if (!parts.length) invalid('Las tablas de cotización no contienen repuestos. Agrega filas de detalle debajo de los encabezados.');
  const summarySheet = [...sheets.values()].find(sheet => normalize(sheet.name) === 'RESUMEN');
  if (summarySheet) {
    let section = 'Resumen';
    let headers = null;
    for (const [rowNumber, row] of [...summarySheet.rows].sort((a, b) => a[0] - b[0])) {
      const all = [...row.values()];
      if (all.some(cell => normalize(cell.value) === 'TOTAL NETO') && all.some(cell => normalize(cell.value) === 'TOTAL')) {
        section = all.some(cell => normalize(cell.value).includes('DESCUENTO')) ? 'Servicio' : 'Repuestos';
        headers = all.filter(cell => ['TOTAL NETO', 'IVA', 'TOTAL', 'DESCUENTO'].includes(normalize(cell.value))).map(cell => ({ column: cell.column, label: text(cell.value) }));
        continue;
      }
      if (headers && headers.some(header => number(value(summarySheet, rowNumber, header.column)) !== null || formulaCell(get(summarySheet, rowNumber, header.column)))) {
        const serieCell = all.find(cell => cell.column < headers[0].column && !blank(cell.value));
        const matchingEngine = engines.find(engine => engine.serial && engine.serial === text(serieCell?.value));
        // A line has at least two numeric financial columns. Single amount rows
        // below each table are handled as labelled section totals instead.
        if (headers.filter(header => number(value(summarySheet, rowNumber, header.column)) !== null || formulaCell(get(summarySheet, rowNumber, header.column))).length >= 2) {
          for (const header of headers) addTotal(`summary_${rowNumber}_${header.column}`, `${section} · ${matchingEngine ? `Motor ${matchingEngine.engine}` : `Fila ${rowNumber}`} · ${header.label}`, summarySheet, get(summarySheet, rowNumber, header.column));
          continue;
        }
      }
      for (const cell of all) {
        const label = normalize(cell.value);
        if (!['TOTAL REPUESTOS', 'TOTAL SERVICIO', 'TOTAL NETO', 'IVA'].includes(label)) continue;
        const next = get(summarySheet, rowNumber, cell.column + 1);
        if (next && (typeof next.value === 'number' || formulaCell(next))) addTotal(`summary_${next.address}`, `${section} · ${text(cell.value)}`, summarySheet, next);
      }
    }
  } else addIssue('warning', 'summary_missing', '', '', 'No se encontró la hoja RESUMEN. Se muestra el detalle de los motores disponibles.');

  const issuesByRow = new Map();
  for (const issue of issues) if (/^[A-Z]+\d+$/.test(issue.cell)) {
    const key = `${issue.sheet}\u0000${coordinate(issue.cell).row}`;
    if (!issuesByRow.has(key)) issuesByRow.set(key, []);
    issuesByRow.get(key).push(issue);
  }
  for (const part of parts) {
    const relevant = issuesByRow.get(`${part.sheet}\u0000${part.row}`) || [];
    part.issues = [...new Set(relevant.map(issue => `${issue.cell}: ${issue.message}`))];
    part.status = part.issues.length ? 'review' : 'ok';
  }
  const shortages = parts.filter(part => Number.isSafeInteger(part.reported_shortage) && part.reported_shortage > 0);
  for (const engine of engines) {
    const list = parts.filter(part => part.sheet === engine.sheet);
    engine.review_records = list.filter(part => part.status === 'review').length;
    engine.shortage_records = list.filter(part => Number.isSafeInteger(part.reported_shortage) && part.reported_shortage > 0).length;
    engine.reported_shortage_units = list.reduce((sum, part) => sum + (Number.isSafeInteger(part.reported_shortage) && part.reported_shortage > 0 ? part.reported_shortage : 0), 0);
    engine.unspecified_shortage_records = list.filter(part => part.reported_shortage === null).length;
  }
  return {
    summary: { engine_count: engines.length, part_records: parts.length, review_records: parts.filter(part => part.status === 'review').length, shortage_records: shortages.length, reported_shortage_units: engines.reduce((sum, engine) => sum + engine.reported_shortage_units, 0), unspecified_shortage_records: engines.reduce((sum, engine) => sum + engine.unspecified_shortage_records, 0), parts_net_clp: engines.every(engine => engine.quoted_net_clp !== null) ? engines.reduce((sum, engine) => sum + engine.quoted_net_clp, 0) : null, issue_count: issues.length, formula_cells: formulaCells, formula_unverified_cells: unverifiedFormulas, summary_found: !!summarySheet },
    engines, parts, shortages, issues, totals,
  };
}
