import path from 'node:path';
import { SaxesParser } from 'saxes';
import { inspectArchive, SpreadsheetError } from './spreadsheets.mjs';

const MAIN = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);
const DOCUMENT_RELS = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const fail = message => { throw new SpreadsheetError(message); };
const attribute = (tag, name) => Object.values(tag.attributes).find(a => a.local === name && a.uri === '')?.value;
const isMain = (tag, name) => tag.local === name && MAIN.has(tag.uri);
const decodeText = value => value.replace(/_x([0-9a-f]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
const numberPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function parseXml(xml, root, handlers) {
  if (!xml) fail('Falta un componente del libro Excel.');
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0;
  parser.on('doctype', () => fail('No se admite este tipo de documento XML.'));
  parser.on('opentag', tag => {
    if (depth++ === 0 && !root(tag)) fail('El libro contiene un componente XML no compatible.');
    handlers.opentag?.(tag, depth);
  });
  parser.on('closetag', tag => { handlers.closetag?.(tag, depth); depth--; });
  parser.on('text', text => handlers.text?.(text));
  parser.on('cdata', text => handlers.text?.(text));
  try { parser.write(xml).close(); }
  catch (error) {
    if (error instanceof SpreadsheetError) throw error;
    fail('No se pudo leer la estructura del libro Excel.');
  }
}

function coordinate(ref) {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(ref ?? '');
  if (!match) fail('El libro contiene una referencia de celda no válida.');
  const column = [...match[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const row = Number(match[2]);
  if (column > 64 || row > 100001) fail('Usa hasta 64 columnas y ubica los datos dentro de las primeras 100.001 filas.');
  return { row, column };
}

function columnLetters(column) {
  let letters = '';
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + (n - 1) % 26) + letters;
  return letters;
}

function booleanAttribute(value) {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  fail('El libro contiene una opción de cálculo no válida.');
}

function readWorkbook(parts) {
  const sheets = [], names = new Set(), ids = new Set(), calculation = {};
  let hasCalculation = false;
  parseXml(parts.get('xl/workbook.xml'), tag => isMain(tag, 'workbook'), {
    opentag(tag, depth) {
      if (isMain(tag, 'sheet') && depth === 3) {
        const name = decodeText(attribute(tag, 'name') ?? '');
        const id = Object.values(tag.attributes).find(a => a.local === 'id' && DOCUMENT_RELS.has(a.uri))?.value;
        if (!name || name.length > 31 || !id || names.has(name.toLocaleLowerCase('en-US')) || ids.has(id)) fail('El libro contiene hojas sin nombre, repetidas o referencias no válidas.');
        names.add(name.toLocaleLowerCase('en-US')); ids.add(id); sheets.push({ name, id });
        if (sheets.length > 64) fail('El libro contiene demasiadas hojas para este piloto (máximo 64).');
      }
      if (isMain(tag, 'calcPr') && depth === 2) {
        if (hasCalculation) fail('El libro contiene opciones de cálculo repetidas.');
        hasCalculation = true;
        const mode = attribute(tag, 'calcMode');
        if (mode !== undefined) calculation.mode = mode;
        for (const name of ['fullCalcOnLoad', 'forceFullCalc']) {
          const value = attribute(tag, name);
          if (value !== undefined) calculation[name] = booleanAttribute(value);
        }
      }
    },
  });
  if (!sheets.length) fail('El archivo no contiene hojas de cálculo.');
  const relationships = new Map();
  parseXml(parts.get('xl/_rels/workbook.xml.rels'), tag => tag.local === 'Relationships' && tag.uri === PACKAGE_RELS, {
    opentag(tag, depth) {
      if (tag.local !== 'Relationship' || tag.uri !== PACKAGE_RELS || depth !== 2) return;
      const id = attribute(tag, 'Id');
      if (!id || relationships.has(id)) fail('El libro contiene referencias de hojas repetidas o no válidas.');
      relationships.set(id, { target: attribute(tag, 'Target'), type: attribute(tag, 'Type'), mode: attribute(tag, 'TargetMode') });
    },
  });
  const usedPaths = new Set();
  for (const sheet of sheets) {
    const rel = relationships.get(sheet.id);
    if (!rel || rel.mode && rel.mode !== 'Internal' || ![...DOCUMENT_RELS].some(uri => rel.type === uri + '/worksheet')) fail('El libro contiene una hoja externa o de un tipo no compatible.');
    const target = rel.target;
    if (!target || /[\\%?#\x00-\x20:]/.test(target) || target.split('/').includes('..')) fail('La referencia a una hoja no es válida.');
    const sheetPath = path.posix.normalize(target.startsWith('/') ? target.slice(1) : 'xl/' + target);
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(sheetPath) || !parts.has(sheetPath) || usedPaths.has(sheetPath)) fail('La referencia a una hoja no es válida o está repetida.');
    usedPaths.add(sheetPath); sheet.path = sheetPath;
  }
  return { sheets, calculation };
}

function readSharedStrings(parts) {
  if (!parts.has('xl/sharedStrings.xml')) return [];
  const shared = [];
  let inString = false, phoneticDepth = 0, textDepth = 0, value = '';
  parseXml(parts.get('xl/sharedStrings.xml'), tag => isMain(tag, 'sst'), {
    opentag(tag, depth) {
      if (isMain(tag, 'si') && depth === 2) { inString = true; value = ''; }
      if (inString && isMain(tag, 'rPh')) phoneticDepth = depth;
      if (inString && !phoneticDepth && isMain(tag, 't')) textDepth = depth;
    },
    text(text) { if (textDepth) value += text; },
    closetag(tag, depth) {
      if (depth === textDepth) textDepth = 0;
      if (depth === phoneticDepth) phoneticDepth = 0;
      if (isMain(tag, 'si') && depth === 2) { shared.push(decodeText(value)); inString = false; }
    },
  });
  return shared;
}

function cellValue(cell, shared) {
  if (cell.type === 'inlineStr') return cell.hasInline ? decodeText(cell.inline) : null;
  if (!cell.hasValue || cell.raw === '') return null;
  if (cell.type === 's') {
    if (!/^\d+$/.test(cell.raw)) fail('El libro contiene una referencia de texto no válida.');
    const index = Number(cell.raw);
    if (!Number.isSafeInteger(index) || index >= shared.length) fail('El libro contiene una referencia de texto no válida.');
    return shared[index];
  }
  if (cell.type === 'n') {
    if (!numberPattern.test(cell.raw.trim())) fail('El libro contiene un número no válido.');
    const value = Number(cell.raw);
    if (!Number.isFinite(value)) fail('El libro contiene un número no válido.');
    return value;
  }
  if (cell.type === 'b') {
    if (cell.raw !== '0' && cell.raw !== '1') fail('El libro contiene un valor lógico no válido.');
    return cell.raw === '1';
  }
  if (cell.type === 'e') return { excel_error: decodeText(cell.raw) };
  // ISO dates and string results remain strings. Do not apply number formats,
  // execute formulas, or reinterpret saved values as corrected input.
  return decodeText(cell.raw);
}

// Expand OOXML shared references without evaluating any expression. The narrow
// lexer keeps quoted text and sheet names intact; unfamiliar syntax stays
// unsupported. The quotation calculator separately validates its own grammar.
function translateSharedFormula(formula, rowDelta, columnDelta) {
  let result = '', offset = 0;
  while (offset < formula.length) {
    const rest = formula.slice(offset), first = rest[0];
    if (first === '"' || first === "'") {
      let end = offset + 1, closed = false;
      while (end < formula.length) {
        if (formula[end] !== first) { end++; continue; }
        if (formula[end + 1] === first) { end += 2; continue; }
        end++; closed = true; break;
      }
      if (!closed || first === "'" && !/^\s*!/.test(formula.slice(end))) return null;
      result += formula.slice(offset, end); offset = end; continue;
    }
    const reference = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*)(?![A-Za-z0-9_.])/.exec(rest);
    if (reference && !/^\s*[!(]/.test(rest.slice(reference[0].length))) {
      const oldColumn = [...reference[2].toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
      const column = oldColumn + (reference[1] ? 0 : columnDelta);
      const row = Number(reference[4]) + (reference[3] ? 0 : rowDelta);
      if (column < 1 || column > 64 || row < 1 || row > 100001) return null;
      result += `${reference[1]}${columnLetters(column)}${reference[3]}${row}`;
      offset += reference[0].length; continue;
    }
    const token = /^(?:\s+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_\\][A-Za-z0-9_.\\]*|[+\-*/^%(),:=<>!])/.exec(rest);
    if (!token) return null;
    result += token[0]; offset += token[0].length;
  }
  return result;
}

function expandSharedFormulas(cells) {
  const groups = new Map();
  for (const cell of cells) if (cell.formulaType === 'shared' && cell.sharedIndex !== undefined) {
    if (!groups.has(cell.sharedIndex)) groups.set(cell.sharedIndex, []);
    groups.get(cell.sharedIndex).push(cell);
  }
  for (const group of groups.values()) {
    const masters = group.filter(cell => cell.sharedMaster || cell.formula !== '');
    if (masters.length !== 1) continue;
    const master = masters[0];
    if (!master.formula || !master.sharedRange) continue;
    let start, end;
    try {
      const [a, b, extra] = master.sharedRange.split(':');
      if (extra !== undefined) continue;
      start = coordinate(a); end = coordinate(b ?? a);
    } catch { continue; }
    const inside = cell => cell.row >= start.row && cell.row <= end.row && cell.column >= start.column && cell.column <= end.column;
    if (start.row > end.row || start.column > end.column || !inside(master)) continue;
    for (const cell of group) {
      if (!inside(cell)) continue;
      const resolved = translateSharedFormula(master.formula, cell.row - master.row, cell.column - master.column);
      if (resolved === null) continue;
      cell.resolvedFormula = resolved;
      cell.formulaUnsupported = false;
    }
  }
}

function readSheet(parts, sheet, shared, state) {
  const cells = [], merges = [], seen = new Set(), rows = new Set(), nonemptyRows = new Set();
  let row = 0, previousColumn = 0, cell = null, field = null, phoneticDepth = 0;
  let sheetDataDepth = 0, rowDepth = 0, cellDepth = 0, inlineDepth = 0;
  parseXml(parts.get(sheet.path), tag => isMain(tag, 'worksheet'), {
    opentag(tag, depth) {
      if (isMain(tag, 'sheetData') && depth === 2) sheetDataDepth = depth;
      if (sheetDataDepth && isMain(tag, 'row') && depth === sheetDataDepth + 1) {
        const rawRow = attribute(tag, 'r');
        row = rawRow === undefined ? row + 1 : Number(rawRow);
        if (rawRow !== undefined && !/^[1-9]\d*$/.test(rawRow) || !Number.isInteger(row) || row < 1 || row > 100001 || rows.has(row)) fail('El libro contiene filas repetidas o números de fila no válidos.');
        rows.add(row); previousColumn = 0; rowDepth = depth;
      }
      if (rowDepth && isMain(tag, 'c') && depth === rowDepth + 1) {
        const ref = attribute(tag, 'r') ?? `${columnLetters(previousColumn + 1)}${row}`;
        const position = coordinate(ref);
        if (position.row !== row || seen.has(ref)) fail('El libro contiene celdas repetidas o referencias de fila inconsistentes.');
        seen.add(ref); previousColumn = position.column; cellDepth = depth;
        const type = attribute(tag, 't') ?? 'n';
        if (!['n', 's', 'str', 'inlineStr', 'b', 'e', 'd'].includes(type)) fail('El libro contiene un tipo de celda no compatible.');
        cell = { address: ref, row, column: position.column, type, raw: '', inline: '', hasValue: false, hasInline: false };
      }
      if (cell && depth === cellDepth + 1) {
        if (['v', 'f', 'is'].includes(tag.local) && !MAIN.has(tag.uri)) fail('El libro contiene una celda con un espacio de nombres no compatible.');
        if (isMain(tag, 'v')) {
          if (cell.hasValue) fail('El libro contiene valores repetidos en una celda.');
          cell.hasValue = true; field = { name: 'v', depth };
        }
        if (isMain(tag, 'f')) {
          if ('formula' in cell) fail('El libro contiene fórmulas repetidas en una celda.');
          cell.formula = ''; cell.formulaType = attribute(tag, 't') ?? 'normal';
          cell.formulaUnsupported = cell.formulaType !== 'normal';
          if (cell.formulaType === 'shared') {
            const si = attribute(tag, 'si');
            if (si !== undefined && /^\d+$/.test(si) && Number.isSafeInteger(Number(si))) cell.sharedIndex = Number(si);
            cell.sharedMaster = Boolean(attribute(tag, 'ref'));
            if (attribute(tag, 'ref') !== undefined) cell.sharedRange = attribute(tag, 'ref');
          }
          field = { name: 'f', depth };
        }
        if (isMain(tag, 'is')) { cell.hasInline = true; inlineDepth = depth; }
      }
      if (cell && inlineDepth && isMain(tag, 'rPh')) phoneticDepth = depth;
      if (cell && inlineDepth && !phoneticDepth && isMain(tag, 't')) field = { name: 't', depth };
      if (isMain(tag, 'mergeCell') && depth === 3) {
        const ref = attribute(tag, 'ref');
        const [start, end, extra] = (ref ?? '').split(':');
        const a = coordinate(start), b = coordinate(end ?? start);
        if (extra !== undefined || a.row > b.row || a.column > b.column) fail('El libro contiene una combinación de celdas no válida.');
        merges.push(ref);
      }
    },
    text(text) {
      if (!cell || !field) return;
      if (field.name === 'v') cell.raw += text;
      if (field.name === 'f') cell.formula += text;
      if (field.name === 't') cell.inline += text;
    },
    closetag(tag, depth) {
      if (field?.depth === depth) field = null;
      if (depth === phoneticDepth) phoneticDepth = 0;
      if (depth === inlineDepth) inlineDepth = 0;
      if (cell && isMain(tag, 'c') && depth === cellDepth) {
        const value = cellValue(cell, shared);
        const result = { address: cell.address, row: cell.row, column: cell.column, value };
        if ('formula' in cell) {
          Object.assign(result, { formula: cell.formula, hasCachedValue: value !== null, formulaType: cell.formulaType, formulaUnsupported: cell.formulaUnsupported });
          if ('sharedIndex' in cell) result.sharedIndex = cell.sharedIndex;
          if ('sharedMaster' in cell) result.sharedMaster = cell.sharedMaster;
          if ('sharedRange' in cell) result.sharedRange = cell.sharedRange;
        }
        if (value !== null && value !== '' || 'formula' in cell) nonemptyRows.add(row);
        cells.push(result); cell = null; cellDepth = 0;
      }
      if (depth === rowDepth) rowDepth = 0;
      if (depth === sheetDataDepth) sheetDataDepth = 0;
    },
  });
  state.rows += nonemptyRows.size;
  if (state.rows > 10000) fail('El máximo es de 10.000 filas con contenido por archivo.');
  expandSharedFormulas(cells);
  return { name: sheet.name, cells, merges };
}

/** Read bounded OOXML values and formula evidence. This function never evaluates
 * formulas, changes the supplied buffer, or writes customer data to disk. */
export async function extractQuotationWorkbook(buffer, filename, { maxBytes = 5 * 1024 * 1024 } = {}) {
  if (typeof filename !== 'string' || !/\.xlsx$/i.test(filename) || /[\x00-\x1f/\\]/.test(filename)) fail('Selecciona un archivo con extensión .xlsx.');
  if (!Buffer.isBuffer(buffer) || !buffer.length) fail('El archivo está vacío o no es un archivo Excel.');
  if (buffer.length > maxBytes) throw new SpreadsheetError('El archivo supera el tamaño máximo permitido.', 413);
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) fail('El contenido no corresponde a un archivo .xlsx.');
  const parts = await inspectArchive(buffer, { allowFormulas: true });
  const { sheets, calculation } = readWorkbook(parts);
  const shared = readSharedStrings(parts), state = { rows: 0 };
  return { sheets: sheets.map(sheet => readSheet(parts, sheet, shared, state)), calculation };
}
