import ExcelJS from 'exceljs';
import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import fs from 'node:fs/promises';
import path from 'node:path';

export const HEADERS = ['transaction_id', 'product', 'quantity', 'unit_price_clp'];
export class SpreadsheetError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status = 400) => { throw new SpreadsheetError(message, status); };

// Inspect and bound decompression BEFORE reading the workbook. No ZIP files
// are extracted to disk. Count actual bytes as well as the advertised ZIP sizes.
export function inspectArchive(buffer, {allowFormulas = false} = {}) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, {lazyEntries: true, validateEntrySizes: true, strictFileNames: true}, (error, zip) => {
      if (error) return reject(new SpreadsheetError('El archivo no es un Excel .xlsx válido o está dañado.'));
      const names = new Set(), parts = new Map(); let total = 0, declared = 0, cells = 0, entries = 0;
      let settled = false;
      const stop = error => { if (!settled) { settled = true; zip.close(); reject(error instanceof SpreadsheetError ? error : new SpreadsheetError('No se pudo leer el archivo Excel. Comprueba que no esté dañado ni protegido.')); } };
      zip.on('error', stop);
      zip.on('end', () => {
        if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) return stop(new SpreadsheetError('El archivo no tiene el formato de un libro .xlsx.'));
        if (!settled) { settled = true; resolve(parts); }
      });
      zip.on('entry', entry => {
        try {
          if (++entries > 1000 || names.has(entry.fileName)) fail('El libro tiene demasiados componentes o componentes repetidos.');
          names.add(entry.fileName);
          declared += entry.uncompressedSize;
          if (declared > 32 * 1024 * 1024 || entry.uncompressedSize > 16 * 1024 * 1024) fail('El libro es demasiado grande al descomprimirlo. Usa una copia más simple, con valores.');
          if (entry.generalPurposeBitFlag & 1) fail('No se admiten archivos Excel cifrados.');
          if (/vbaProject|externalLinks\/|embeddings\//i.test(entry.fileName)) fail('No se admiten macros, vínculos externos ni objetos incrustados. Guarda una copia .xlsx con valores.');
          if (/\/$/.test(entry.fileName)) { zip.readEntry(); return; }
          const xml = /\.(xml|rels)$/.test(entry.fileName);
          const sheet = /^xl\/worksheets\/[^/]+\.xml$/.test(entry.fileName);
          const parser = xml ? new SaxesParser({xmlns:true}) : null;
          const chunks = [];
          let depth=0, elements=0;
          parser?.on('doctype', () => fail('No se admite este tipo de documento XML.'));
          parser?.on('opentag', tag => {
            if(++depth>128 || ++elements>1000000)fail('El documento XML es demasiado complejo para este piloto.');
            if (tag.local === 'f' && sheet && !allowFormulas) fail('El archivo contiene fórmulas. Copia y pega solo los valores en un libro nuevo antes de subirlo.');
            if (tag.local === 'c' && sheet) {
              if (++cells > 250000) fail('El libro contiene demasiadas celdas. El límite es 250.000 celdas.');
              const ref = tag.attributes.r?.value || '';
              const parts = /^([A-Z]+)(\d+)$/.exec(ref);
              if (parts) {
                const col = [...parts[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
                if (col > 64 || Number(parts[2]) > 100001) fail('Usa hasta 64 columnas y ubica los datos dentro de las primeras 100.001 filas.');
              }
            }
          });
          parser?.on('closetag', () => { depth--; });
          parser?.on('error', stop);
          zip.openReadStream(entry, (error, stream) => {
            if (error) return stop(error);
            stream.on('error', stop);
            if (xml) stream.setEncoding('utf8');
            stream.on('data', chunk => {
              try {
                total += Buffer.byteLength(chunk);
                if (total > 32 * 1024 * 1024) fail('El archivo excede el tamaño descomprimido permitido.');
                parser?.write(chunk);
                if (xml) chunks.push(chunk);
              } catch (error) { stream.destroy(); stop(error); }
            });
            stream.on('end', () => {
              if (settled) return;
              try { parser?.close(); if (xml) parts.set(entry.fileName,chunks.join('')); if (!settled) zip.readEntry(); } catch (error) { stop(error); }
            });
          });
        } catch (error) { stop(error); }
      });
      zip.readEntry();
    });
  });
}

function parseXML(xml, handlers) {
  if (!xml) fail('Falta un componente del libro Excel.');
  const parser = new SaxesParser({xmlns:true});
  for (const [event,fn] of Object.entries(handlers)) parser.on(event,fn);
  parser.write(xml).close();
}
const attr = (tag,name) => Object.values(tag.attributes).find(a=>a.local===name)?.value;
const columnNumber = letters => [...letters].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0);
const decodeExcelText = value => value.replace(/_x([0-9a-f]{4})_/gi,(_,hex)=>String.fromCharCode(parseInt(hex,16)));
// Excel uses _xHHHH_ escapes. Escape literal lookalikes first; never let the
// writer drop control characters or reinterpret literal customer identifiers.
const encodeExcelText = value => value.replace(/_x[0-9a-f]{4}_/gi,match=>'_x005F_'+match.slice(1))
  .replace(/[\x00-\x08\x0b-\x0f\x10-\x1f\x7f\ud800-\udfff\ufffe\uffff]/g,char=>'_x'+char.charCodeAt(0).toString(16).toUpperCase().padStart(4,'0')+'_');

// Namespace-aware OOXML reader. Using stored values matches n8n rawData and
// also supports namespace-prefixed files generated by spreadsheet exporters.
function readSales(parts) {
  let sheetId;
  parseXML(parts.get('xl/workbook.xml'), {opentag(tag) {
    if (tag.local==='sheet' && attr(tag,'name')==='Sales') sheetId=attr(tag,'id');
  }});
  if (!sheetId) fail('Falta la hoja Sales. Usa ese nombre exacto.');
  let target;
  parseXML(parts.get('xl/_rels/workbook.xml.rels'), {opentag(tag) {
    if(tag.local==='Relationship' && attr(tag,'Id')===sheetId && attr(tag,'TargetMode')!=='External') target=attr(tag,'Target');
  }});
  if (!target) fail('La hoja Sales no se puede leer.');
  const sheetPath=path.posix.normalize(target.startsWith('/')?target.slice(1):'xl/'+target);
  if(!sheetPath.startsWith('xl/worksheets/')) fail('La referencia a la hoja Sales no es válida.');
  const shared=[]; let sharedText='', inText=false, phonetic=false;
  if(parts.has('xl/sharedStrings.xml')) parseXML(parts.get('xl/sharedStrings.xml'), {
    opentag(tag) { if(tag.local==='si')sharedText=''; if(tag.local==='rPh')phonetic=true; if(tag.local==='t'&&!phonetic)inText=true; },
    text(text) { if(inText)sharedText+=text; },
    closetag(tag) { if(tag.local==='t')inText=false; if(tag.local==='rPh')phonetic=false; if(tag.local==='si')shared.push(decodeExcelText(sharedText)); }
  });
  const rows=new Map(); let cell, field, rowIndex=0, previousColumn=0;
  parseXML(parts.get(sheetPath), {
    opentag(tag) {
      if(tag.local==='mergeCell')fail('La hoja Sales contiene celdas combinadas. Usa una tabla simple sin combinar celdas.');
      if(tag.local==='row') { rowIndex=Number(attr(tag,'r')||rowIndex+1); previousColumn=0; if(!Number.isInteger(rowIndex)||rowIndex<1||rowIndex>100001)fail('Número de fila no admitido.'); }
      if(tag.local==='c') {
        const ref=attr(tag,'r'); const match=ref && /^([A-Z]+)(\d+)$/.exec(ref);
        if(ref&&!match)fail('Referencia de celda no válida.');
        const col=match?columnNumber(match[1]):previousColumn+1; previousColumn=col;
        if(col>64 || (match && Number(match[2])!==rowIndex))fail('La estructura de celdas no es válida para este piloto.');
        cell={col,type:attr(tag,'t')||'n',value:'',inline:''};
      }
      if(cell && ['v','t'].includes(tag.local))field=tag.local;
    },
    text(text) { if(cell&&field==='v')cell.value+=text; if(cell&&field==='t')cell.inline+=text; },
    closetag(tag) {
      if(['v','t'].includes(tag.local))field=null;
      if(tag.local==='c'&&cell) {
        let value=null;
        if(cell.type==='inlineStr')value=decodeExcelText(cell.inline);
        else if(cell.type==='s'&&cell.value!=='') {
          const i=Number(cell.value); if(!Number.isInteger(i)||i<0||i>=shared.length)fail('Referencia de texto no válida.'); value=shared[i];
        } else if(cell.value!=='') {
          if(cell.type==='n') {
            if(!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(cell.value.trim()))fail('El libro contiene un número no válido.');
            value=Number(cell.value); if(!Number.isFinite(value))fail('El libro contiene un número no válido.');
          }
          else if(cell.type==='b')value=cell.value==='1';
          else if(cell.type==='e')value={excel_error:cell.value};
          else value=decodeExcelText(cell.value);
        }
        if(!rows.has(rowIndex))rows.set(rowIndex,new Map());
        if(rows.get(rowIndex).has(cell.col))fail('El libro contiene celdas repetidas.');
        rows.get(rowIndex).set(cell.col,value); cell=null;
      }
    }
  });
  return rows;
}

export async function extractSales(buffer, filename, {maxBytes = 5 * 1024 * 1024} = {}) {
  if (typeof filename !== 'string' || !/\.xlsx$/i.test(filename) || /[\x00-\x1f/\\]/.test(filename)) fail('Selecciona un archivo con extensión .xlsx.');
  if (!buffer.length) fail('El archivo está vacío.');
  if (buffer.length > maxBytes) fail('El archivo supera el tamaño máximo permitido.', 413);
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) fail('El contenido no corresponde a un archivo .xlsx.');
  const sheet = readSales(await inspectArchive(buffer));
  const headers = [];
  for(const [col,value] of sheet.get(1)||[]) headers[col-1]=value;
  const missing = HEADERS.filter(header => !headers.includes(header));
  if (missing.length) fail('Faltan columnas en la fila 1: ' + missing.join(', ') + '.');
  const seen = new Set();
  for (const header of headers) {
    if (header === null || header === undefined) continue;
    if (typeof header !== 'string' || !header.trim() || header.length > 128 || seen.has(header)) fail('Los encabezados deben ser textos únicos y no vacíos (máximo 128 caracteres).');
    seen.add(header);
  }
  const rows = [];
  for (const [rowNumber,row] of [...sheet].sort((a,b)=>a[0]-b[0])) {
    if (rowNumber === 1) continue;
    const record = Object.create(null); let nonempty = false;
    for(const [col,value] of row) if(value!==null && !headers[col-1]) fail('Hay datos en una columna sin encabezado. Agrega el encabezado en la fila 1.');
    headers.forEach((header, i) => {
      if (header === null || header === undefined) return;
      const value = row.get(i+1) ?? null;
      if (value !== null && value !== '') nonempty = true;
      record[header] = value;
    });
    if (!nonempty) continue;
    if (JSON.stringify(record).length > 30000) fail('Un registro contiene demasiado texto para el informe de revisión (máximo 30.000 caracteres por registro).');
    rows.push(record);
    if (rows.length > 10000) fail('El máximo es de 10.000 registros extraídos por archivo.');
  }
  if (!rows.length) fail('No hay registros en Sales. Agrega ventas debajo de los encabezados.');
  return rows;
}

function book(sheetName, columns, rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Ventas claras';
  const sheet = workbook.addWorksheet(sheetName, {views:[{state:'frozen',ySplit:1}]});
  sheet.columns = columns.map(([key,width]) => ({header:key,key,width}));
  for (const row of rows) {
    const added = sheet.addRow(columns.map(([key]) => typeof row[key]==='string' ? encodeExcelText(row[key]) : row[key] ?? null));
    added.eachCell(cell => {
      // Assign only scalar values. A string beginning with =, +, - or @ stays
      // an OOXML string; never give ExcelJS a {formula:...} customer object.
      if (typeof cell.value === 'string') cell.numFmt = '@';
      else if (typeof cell.value === 'number') cell.numFmt = '#,##0';
      else if (cell.value !== null) throw new Error('Report contains a non-scalar value');
      cell.alignment = {vertical:'top', wrapText:true};
    });
  }
  const header = sheet.getRow(1);
  header.height = 32;
  header.eachCell(cell => { cell.font = {bold:true,color:{argb:'FFFFFFFF'}}; cell.fill = {type:'pattern',pattern:'solid',fgColor:{argb:'FF123F47'}}; cell.alignment={vertical:'middle',wrapText:true}; });
  sheet.autoFilter = {from:{row:1,column:1},to:{row:Math.max(1,sheet.rowCount),column:columns.length}};
  sheet.pageSetup = {orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0};
  return workbook;
}
export async function blankTemplate() {
  const workbook = book('Sales', HEADERS.map(h=>[h,h==='product'?34:24]), []);
  workbook.getWorksheet('Sales').getColumn(1).numFmt = '@';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
export async function sampleWorkbook() {
  const sample = JSON.parse(await fs.readFile(new URL('../sample-data.json', import.meta.url), 'utf8'));
  return Buffer.from(await book('Sales', HEADERS.map(h=>[h,h==='product'?34:24]), sample).xlsx.writeBuffer());
}
export async function createReports(result) {
  const specs = {
    'valid.xlsx': ['Valid sales', [['input_record',16],['transaction_id',24],['product',34],['quantity',16],['unit_price_clp',24],['line_total_clp',24]], result.valid],
    'review.xlsx': ['Needs review', [['input_record',16],['transaction_id',24],['issues',64],['original_row_json',90]], result.review],
    'summary.xlsx': ['Summary', [['input_records',18],['valid_records',18],['review_records',18],['valid_sales_total_clp',26],['currency',14],['status',62],['calculation',72]], [result.summary]],
  };
  const reports = {};
  for (let [filename, [name,columns,rows]] of Object.entries(specs)) {
    if (!rows.length) { columns=[['status',20],['note',60]]; rows=[{status:'NO_ROWS',note:'Este informe no contiene registros.'}]; }
    reports[filename] = Buffer.from(await book(name,columns,rows).xlsx.writeBuffer());
  }
  return reports;
}
