import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { extractQuotationWorkbook } from '../lib/quotation-reader.mjs';
import { extractSales, inspectArchive } from '../lib/spreadsheets.mjs';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const sheetXml = rows => `<worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`;
async function fixture({ sheets = [sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>Repuestos</t></is></c></row>')], shared, workbook, relationships, entries = {} } = {}) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('xl/workbook.xml', workbook ?? `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>${sheets.map((_, i) => `<sheet name="Motor ${i + 1}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="false"/></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', relationships ?? `<Relationships xmlns="${PKG}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  for (const [i, sheet] of sheets.entries()) zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheet);
  if (shared) zip.file('xl/sharedStrings.xml', shared);
  for (const [name, value] of Object.entries(entries)) zip.file(name, value);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
const read = buffer => extractQuotationWorkbook(buffer, 'cotizacion.xlsx');

test('Quotation reader preserves ExcelJS values, original bytes, merges and formula evidence', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Motor 3300');
  sheet.getCell('A1').value = '  Pieza A  ';
  sheet.getCell('B1').value = 0;
  sheet.getCell('C1').value = false;
  sheet.getCell('D1').value = { formula: 'B1*2', result: 0 };
  sheet.getCell('E1').value = { formula: 'SUM(B1:D1)' };
  sheet.mergeCells('A3:C3'); sheet.getCell('A3').value = 'Cotización';
  workbook.addWorksheet('RESUMEN').getCell('A1').value = { formula: "'Motor 3300'!D1", result: 0 };
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer()), before = Buffer.from(buffer);
  const result = await read(buffer), cells = new Map(result.sheets[0].cells.map(c => [c.address, c]));
  assert.deepEqual(buffer, before);
  assert.deepEqual(result.sheets.map(s => s.name), ['Motor 3300', 'RESUMEN']);
  assert.equal(cells.get('A1').value, '  Pieza A  ');
  assert.equal(cells.get('B1').value, 0); assert.equal(cells.get('C1').value, false);
  assert.deepEqual(cells.get('D1'), { address: 'D1', row: 1, column: 4, value: 0, formula: 'B1*2', hasCachedValue: true, formulaType: 'normal', formulaUnsupported: false });
  assert.equal(cells.get('E1').value, null); assert.equal(cells.get('E1').hasCachedValue, false);
  assert.deepEqual(result.sheets[0].merges, ['A3:C3']);
});

test('Namespace-prefixed XML, raw date/error/boolean values, inline rich text and Excel escapes survive', async () => {
  const xml = `<x:worksheet xmlns:x="${NS}"><x:sheetData><x:row r="2">
    <x:c r="A2" t="s"><x:v>0</x:v></x:c>
    <x:c r="B2" t="inlineStr"><x:is><x:r><x:t> Parte </x:t></x:r><x:rPh><x:t>IGNORE</x:t></x:rPh><x:r><x:t>B_x000A_C</x:t></x:r></x:is></x:c>
    <x:c r="C2" t="d"><x:v>2026-10-21T00:00:00Z</x:v></x:c>
    <x:c r="D2" t="e"><x:v>#REF!</x:v></x:c>
    <x:c r="E2" t="b"><x:v>1</x:v></x:c><x:c r="F2"/><x:c r="G2"><x:v/></x:c>
  </x:row></x:sheetData></x:worksheet>`;
  const shared = `<x:sst xmlns:x="${NS}"><x:si><x:r><x:t>A_x000D_</x:t></x:r><x:rPh><x:t>IGNORE</x:t></x:rPh><x:r><x:t>B_x005F_x000A_C</x:t></x:r></x:si></x:sst>`;
  const result = await read(await fixture({ sheets: [xml], shared }));
  assert.deepEqual(result.sheets[0].cells.map(c => c.value), ['A\rB_x000A_C', ' Parte B\nC', '2026-10-21T00:00:00Z', { excel_error: '#REF!' }, true, null, null]);
  assert.deepEqual(result.calculation, { mode: 'auto', fullCalcOnLoad: true, forceFullCalc: false });
});

test('Shared formulas expand safely while array and data-table formulas stay unsupported', async () => {
  const rows = `<row r="1">
    <c r="A1"><f t="shared" si="3" ref="A1:A2">B1*2</f><v>20</v></c>
    <c r="B1"><f t="array" ref="B1:B2">SUM(C1:C2)</f><v>9</v></c>
    <c r="C1"><f t="dataTable" ref="C1:C2"/><v>8</v></c>
    <c r="D1" t="str"><f>IF(1=1,&quot;&quot;,&quot;no&quot;)</f><v/></c>
    </row><row r="2"><c r="A2"><f t="shared" si="3"/><v>40</v></c></row>`;
  const { cells } = (await read(await fixture({ sheets: [sheetXml(rows)] }))).sheets[0];
  assert.deepEqual(cells.filter(c => c.formulaUnsupported).map(c => c.formulaType), ['array', 'dataTable']);
  assert.equal(cells[0].sharedIndex, 3); assert.equal(cells[0].sharedMaster, true);
  assert.equal(cells[0].resolvedFormula, 'B1*2'); assert.equal(cells[0].sharedRange, 'A1:A2');
  assert.equal(cells[4].sharedMaster, false); assert.equal(cells[4].formula, '');
  assert.equal(cells[4].resolvedFormula, 'B2*2');
  assert.equal(cells[4].value, 40); assert.equal(cells[4].hasCachedValue, true);
  assert.equal(cells[3].value, null); assert.equal(cells[3].hasCachedValue, false);
});

test('Shared expansion preserves absolute references, sheet names, quoted literals and numeric exponents', async () => {
  const formula = `SUM($A4,B$2,$C$3,'A1''part'!D4,Sheet1!E4,A1!F4,"A1 ""B2""",1E3)`;
  const rows = `<row r="4"><c r="D4"><f t="shared" si="0" ref="D4:E5">${formula.replaceAll('"', '&quot;')}</f><v>1</v></c></row><row r="5"><c r="E5"><f t="shared" si="0"/><v>999</v></c></row>`;
  const { cells } = (await read(await fixture({ sheets: [sheetXml(rows)] }))).sheets[0];
  assert.equal(cells[0].formula, formula);
  assert.equal(cells[1].formula, '');
  assert.equal(cells[1].resolvedFormula, `SUM($A5,C$2,$C$3,'A1''part'!E5,Sheet1!F5,A1!G5,"A1 ""B2""",1E3)`);
  assert.equal(cells[1].value, 999); // Saved cache is not recalculated or trusted.
  assert.equal(cells[1].formulaUnsupported, false);
});

test('Ambiguous, missing, unsafe or out-of-range shared formula references stay unsupported', async () => {
  for (const rows of [
    '<row r="1"><c r="A1"><f t="shared" si="0"/><v>4</v></c></row>',
    '<row r="1"><c r="A1"><f t="shared" si="0" ref="A1:B1">1+1</f></c><c r="B1"><f t="shared" si="0" ref="A1:B1">2+2</f></c></row>',
    '<row r="1"><c r="A1"><f t="shared" si="0" ref="A1:B1">[external.xlsx]Sheet1!A1</f></c><c r="B1"><f t="shared" si="0"/></c></row>',
    '<row r="1"><c r="A1"><f t="shared" si="0" ref="A1:B1">SUM(Table1[Price])</f></c><c r="B1"><f t="shared" si="0"/></c></row>',
  ]) {
    const { cells } = (await read(await fixture({ sheets: [sheetXml(rows)] }))).sheets[0];
    assert.ok(cells.every(cell => cell.formulaUnsupported));
    assert.ok(cells.every(cell => cell.resolvedFormula === undefined));
  }
  const rows = '<row r="1"><c r="B1"><f t="shared" si="1" ref="A1:B2">A1</f></c></row><row r="2"><c r="A2"><f t="shared" si="1"/></c><c r="C2"><f t="shared" si="1"/></c></row>';
  const { cells } = (await read(await fixture({ sheets: [sheetXml(rows)] }))).sheets[0];
  assert.equal(cells[0].formulaUnsupported, false);
  assert.equal(cells[1].formulaUnsupported, true); // Translating left would reference column zero.
  assert.equal(cells[2].formulaUnsupported, true); // Outside the master's declared shared range.
});

test('Formula acceptance is opt-in and the original Sales mode still rejects cached formulas', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Sales');
  sheet.addRow(['transaction_id', 'product', 'quantity', 'unit_price_clp']);
  sheet.addRow(['A', 'Pieza', 1, { formula: '2000+1000', result: 3000 }]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  await assert.rejects(inspectArchive(buffer), /fórmulas/);
  await assert.rejects(extractSales(buffer, 'ventas.xlsx'), /fórmulas/);
  assert.equal((await read(buffer)).sheets[0].cells.find(c => c.address === 'D2').formula, '2000+1000');
});

test('File extension, signature, size and damaged archives fail explicitly', async () => {
  const buffer = await fixture();
  for (const invalid of [Buffer.alloc(0), Buffer.from('Not Excel'), buffer.subarray(0, 30)]) await assert.rejects(read(invalid));
  for (const filename of ['a.xls', 'a.csv', '../a.xlsx', 'a\\b.xlsx', 'bad\n.xlsx']) await assert.rejects(extractQuotationWorkbook(buffer, filename), /extensión/);
  await assert.rejects(extractQuotationWorkbook(buffer, 'a.xlsx', { maxBytes: 10 }), error => error.status === 413);
});

test('Unsafe and external worksheet targets, reused targets, duplicate IDs and names fail', async () => {
  for (const target of ['../worksheets/sheet1.xml', 'worksheets/../worksheets/sheet1.xml', '/other/sheet1.xml', 'worksheets%2fsheet1.xml', 'worksheets/sheet1.xml?x', 'https://example.com/x.xml', 'worksheets\\sheet1.xml']) {
    const relationships = `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="${target}"/></Relationships>`;
    await assert.rejects(read(await fixture({ relationships })), /referencia|leer/i);
  }
  const external = `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml" TargetMode="External"/></Relationships>`;
  await assert.rejects(read(await fixture({ relationships: external })), /externa/);
  const repeated = `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  await assert.rejects(read(await fixture({ relationships: repeated })), /repetidas/);
  const duplicateNames = `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Motor" r:id="rId1"/><sheet name="MOTOR" r:id="rId2"/></sheets></workbook>`;
  await assert.rejects(read(await fixture({ workbook: duplicateNames })), /repetidas/);
  const reused = `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  await assert.rejects(read(await fixture({ sheets: [sheetXml(''), sheetXml('')], relationships: reused })), /repetida/);
});

test('Duplicate cells, duplicate rows, inconsistent row references and invalid values fail', async () => {
  for (const rows of [
    '<row r="1"><c r="A1"/><c r="A1"/></row>',
    '<row r="1"><c r="A1"/></row><row r="1"><c r="B1"/></row>',
    '<row r="1"><c r="A2"/></row>',
    '<row r="1"><c r="A1"><v>1</v><v>2</v></c></row>',
    '<row r="1"><c r="A1"><f>1</f><f>2</f></c></row>',
    '<row r="1"><c r="A1"><v>Infinity</v></c></row>',
    '<row r="1"><c r="A1"><v>1e999</v></c></row>',
    '<row r="1"><c r="A1" t="b"><v>yes</v></c></row>',
    '<row r="1"><c r="A1" t="s"><v>9</v></c></row>',
    '<row r="1"><c r="A1" t="unknown"><v>2</v></c></row>',
  ]) await assert.rejects(read(await fixture({ sheets: [sheetXml(rows)] })));
});

test('Missing row/cell coordinates infer physical positions without inventing values', async () => {
  const result = await read(await fixture({ sheets: [sheetXml('<row><c t="inlineStr"><is><t>A</t></is></c><c/><c><v>0</v></c></row><row><c><f>1+1</f></c></row>')] }));
  assert.deepEqual(result.sheets[0].cells.map(c => [c.address, c.value]), [['A1', 'A'], ['B1', null], ['C1', 0], ['A2', null]]);
});

test('10,000 nonempty physical rows applies across sheets, with blanks skipped and formulas counted', async () => {
  const rows = count => Array.from({ length: count }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>1</v></c></row>`).join('');
  const a = sheetXml(rows(5000)), b = sheetXml(rows(5000) + '<row r="90000"><c r="A90000"/></row>');
  assert.equal((await read(await fixture({ sheets: [a, b] }))).sheets.length, 2);
  await assert.rejects(read(await fixture({ sheets: [a, b, sheetXml('<row r="1"><c r="A1"><f>1+1</f></c></row>')] })), /10.000/);
});

test('Archive limits, macros, external parts and hostile XML protections remain active', async () => {
  for (const entries of [
    { 'xl/vbaProject.bin': 'macro' },
    { 'xl/externalLinks/externalLink1.xml': '<test/>' },
    { 'xl/embeddings/object.bin': 'object' },
    { 'custom.xml': '<!DOCTYPE x [<!ENTITY a "unsafe">]><x>&a;</x>' },
  ]) await assert.rejects(read(await fixture({ entries })));
  await assert.rejects(read(await fixture({ sheets: [sheetXml('<row r="1"><c r="BM1"><v>1</v></c></row>')] })), /64 columnas/);
  const fake = '<worksheet xmlns="https://untrusted.example/schema"><sheetData/></worksheet>';
  await assert.rejects(read(await fixture({ sheets: [fake] })), /XML no compatible/);
  const fakeFormula = `<worksheet xmlns="${NS}" xmlns:x="https://untrusted.example/schema"><sheetData><row r="1"><c r="A1"><x:f>1+1</x:f><v>2</v></c></row></sheetData></worksheet>`;
  await assert.rejects(read(await fixture({ sheets: [fakeFormula] })), /nombres no compatible/);
});
