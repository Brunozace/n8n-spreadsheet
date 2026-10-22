import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { processQuotation } from '../quotation-core.mjs';
import { createQuotationFixture, fixtureCell } from './quotation-fixture.mjs';

test('quotation retains decimal values, separates catalogs, and distinguishes blank FALTA from zero', () => {
  const input = createQuotationFixture(), original = structuredClone(input);
  const result = processQuotation(input);
  assert.deepEqual(input, original);
  assert.equal(result.summary.engine_count, 1);
  assert.equal(result.summary.part_records, 3);
  assert.equal(result.summary.parts_net_clp, 4100.5);
  assert.equal(result.summary.review_records, 0);
  assert.equal(result.summary.shortage_records, 1);
  assert.equal(result.summary.reported_shortage_units, 1);
  assert.equal(result.summary.unspecified_shortage_records, 1);
  assert.equal(result.parts[1].reported_shortage, null);
  assert.equal(result.parts[2].reported_shortage, 0);
  assert.equal(result.engines[0].quoted_vat_clp, 779.095);
  assert.equal(result.summary.formula_unverified_cells, 0);
  assert.deepEqual(result.issues, []);
  assert.equal(result.totals.find(t => t.source_sheet === 'RESUMEN' && t.source_cell === 'J20').value, -50.025);
  assert.equal(result.totals.find(t => t.source_sheet === 'RESUMEN' && t.source_cell === 'K25').value, 1131.06525);
});

test('quotation flags every duplicate ITEM within a sheet but permits repeated part numbers', () => {
  const input = createQuotationFixture();
  fixtureCell(input, 0, 'F18').value = ' a ';
  fixtureCell(input, 0, 'F19').value = 'A';
  const result = processQuotation(input);
  assert.deepEqual(result.issues.filter(i => i.code === 'duplicate_item').map(i => i.cell), ['F18', 'F19']);
  assert.equal(result.summary.review_records, 2);
  assert.equal(result.parts[2].status, 'ok');
  const other = structuredClone(input.sheets[0]); other.name = 'Second engine';
  for (const cell of other.cells) if (cell.address === 'F18') cell.value = 1;
  for (const cell of other.cells) if (cell.address === 'F19') cell.value = 2;
  input.sheets.push(other);
  assert.equal(processQuotation(input).issues.filter(i => i.code === 'duplicate_item').length, 2);
});

test('quotation independently audits stale cached formulas and retains original quoted amounts', () => {
  const input = createQuotationFixture();
  fixtureCell(input, 0, 'L31').value = 1500.25;
  const result = processQuotation(input);
  assert.equal(result.parts[0].unit_price_clp, 1250.25);
  assert.equal(result.parts[0].line_total_clp, 2500.5);
  assert.equal(result.summary.parts_net_clp, 4100.5);
  assert.ok(result.issues.some(i => i.cell === 'K18' && i.code === 'formula_stale' && i.expected_value === 1500.25));
  assert.ok(result.issues.some(i => i.sheet === 'RESUMEN' && i.cell === 'I12' && i.code === 'formula_stale'));
});

test('quotation uses resolved shared formula and preserves zero caches', () => {
  const input = createQuotationFixture();
  const cell = fixtureCell(input, 0, 'K18');
  cell.resolvedFormula = cell.formula; cell.formula = ''; cell.formulaType = 'shared';
  const noCharge = fixtureCell(input, 0, 'L31'); noCharge.value = 0;
  cell.value = 0; fixtureCell(input, 0, 'L18').value = 0;
  const result = processQuotation(input);
  assert.ok(!result.issues.some(i => i.cell === 'K18' && i.code !== 'subtotal_mismatch'));
  assert.equal(result.parts[0].unit_price_clp, 0);
  assert.ok(!result.issues.some(i => i.code === 'formula_missing_cache' && i.cell === 'K18'));
});

test('quotation reports unsupported formulas, absent caches, Excel errors and circular references', () => {
  const input = createQuotationFixture();
  fixtureCell(input, 0, 'K18').formula = 'WEBSERVICE("https://example.invalid/")';
  fixtureCell(input, 0, 'K19').value = null;
  fixtureCell(input, 0, 'K19').hasCachedValue = false;
  fixtureCell(input, 0, 'K20').value = { error: '#N/A' };
  fixtureCell(input, 0, 'K20').formula = 'K20';
  const result = processQuotation(input);
  assert.ok(result.summary.formula_unverified_cells >= 3);
  assert.ok(result.issues.some(i => i.code === 'formula_unverified' && i.cell === 'K18'));
  assert.ok(result.issues.some(i => i.code === 'formula_missing_cache' && i.cell === 'K19'));
  assert.ok(result.issues.some(i => i.code === 'formula_cached_error' && i.cell === 'K20'));
  assert.equal(result.parts[1].unit_price_clp, null);
  assert.equal(result.parts[2].unit_price_clp, null);
});

test('quotation validates quantities, shortage counts, prices and line totals without substituting missing values', () => {
  const input = createQuotationFixture();
  fixtureCell(input, 0, 'G18').value = 1.5;
  fixtureCell(input, 0, 'H18').value = -1;
  fixtureCell(input, 0, 'H19').value = 99;
  fixtureCell(input, 0, 'K20').value = '';
  fixtureCell(input, 0, 'L20').value = 20;
  const result = processQuotation(input);
  for (const code of ['invalid_quantity', 'invalid_shortage', 'shortage_above_quantity', 'invalid_price', 'line_total_mismatch', 'subtotal_mismatch']) assert.ok(result.issues.some(i => i.code === code), code);
  assert.equal(result.parts[2].unit_price_clp, null);
});

test('quotation shows missing summary and manual calculation warnings', () => {
  const input = createQuotationFixture(); input.sheets.pop(); input.calculation = { mode: 'manual', forceFullCalc: true };
  const result = processQuotation(input);
  assert.equal(result.summary.summary_found, false);
  for (const code of ['summary_missing', 'calculation_manual', 'calculation_requested']) assert.ok(result.issues.some(i => i.code === code));
});

test('quotation rejects unrecognized tables and does not treat the catalog as a second detail', () => {
  const input = createQuotationFixture();
  fixtureCell(input, 0, 'H17').value = 'Missing header';
  assert.throws(() => processQuotation(input), { code: 'INVALID_QUOTATION' });
  const other = createQuotationFixture(); fixtureCell(other, 0, 'J22').value = 'No boundary';
  assert.throws(() => processQuotation(other), { code: 'INVALID_QUOTATION' });
});

test('quotation function runs standalone in a restricted n8n-like VM', () => {
  const result = vm.runInNewContext(`(${processQuotation.toString()})(input)`, { input: createQuotationFixture() }, { timeout: 1000 });
  assert.equal(result.summary.part_records, 3);
  assert.equal(result.summary.issue_count, 0);
});

test('quotation rejects duplicate headers, empty details and an incomplete additional engine',()=>{
  const duplicate=createQuotationFixture();
  duplicate.sheets[0].cells.push({address:'M17',row:17,column:13,value:'P.UNITARIO'});
  assert.throws(()=>processQuotation(duplicate),{code:'INVALID_QUOTATION'});
  const empty=createQuotationFixture();empty.sheets[0].cells=empty.sheets[0].cells.filter(cell=>cell.row<18||cell.row>20);
  assert.throws(()=>processQuotation(empty),{code:'INVALID_QUOTATION'});
  const multiple=createQuotationFixture();const second=structuredClone(multiple.sheets[0]);second.name='Additional engine';
  second.cells.find(cell=>cell.address==='I17').value='Broken header';multiple.sheets.push(second);
  assert.throws(()=>processQuotation(multiple),{code:'INVALID_QUOTATION'});
});

test('quotation rejects wildcard lookups and approximate VLOOKUP instead of asserting verified results', () => {
  for (const formula of ['VLOOKUP("DEMO-*",$K$30:$L$32,2,FALSE)', 'VLOOKUP(I18,$K$30:$L$32,2,TRUE)', "'[external.xlsx]Sheet'!A1", 'SUM(A1:ZZZ999999)']) {
    const input = createQuotationFixture(); fixtureCell(input, 0, 'K18').formula = formula;
    assert.ok(processQuotation(input).issues.some(i => i.code === 'formula_unverified' && i.cell === 'K18'), formula);
  }
});
