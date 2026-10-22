import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { extractSales,blankTemplate,sampleWorkbook,createReports,inspectArchive } from '../lib/spreadsheets.mjs';
import { processSales } from '../core.mjs';
import { workbook,readWorkbook,sample,HEADERS } from './helpers.mjs';
import JSZip from 'jszip';

test('Both supplied workbooks read correctly, including namespace-prefixed XML',async()=>{
  for(const [file,valid,review,total] of [['sample-sales - Copy.xlsx',6,4,53000],['sample-sales.xlsx',7,3,61000]]) {
    const buffer=await fs.readFile(new URL('../'+file,import.meta.url)); const before=Buffer.from(buffer);
    const result=processSales(await extractSales(buffer,file));
    assert.deepEqual([result.summary.input_records,result.valid.length,result.review.length,result.summary.valid_sales_total_clp],[10,valid,review,total]);
    assert.deepEqual(buffer,before);
  }
});
test('Blank template contains only required headers on Sales; sample is separate baseline',async()=>{
  const template=await blankTemplate();const data=await readWorkbook(template);
  assert.equal(data.sheet.name,'Sales'); assert.deepEqual(data.headers,HEADERS);assert.equal(data.rows.length,0);
  await assert.rejects(extractSales(template,'template.xlsx'),/No hay registros/);
  const expected=JSON.parse(await fs.readFile(new URL('../expected-results.json',import.meta.url)));
  assert.deepEqual(processSales(await extractSales(await sampleWorkbook(),'sample.xlsx')),expected);
});
test('Reject invalid extension, fake ZIP, empty, truncated and oversized files',async()=>{
  const valid=await workbook();
  for(const buffer of [Buffer.alloc(0),Buffer.from('x'),Buffer.from('not an xlsx'),valid.subarray(0,100)])await assert.rejects(extractSales(buffer,'bad.xlsx'));
  await assert.rejects(extractSales(valid,'bad.csv'),/extensión/);
  await assert.rejects(extractSales(valid,'good.xlsx',{maxBytes:10}),error=>error.status===413);
});
test('Reject missing sheet, missing/duplicate headers, formulas with cached values',async()=>{
  await assert.rejects(extractSales(await workbook(sample,{sheet:'Ventas'}),'a.xlsx'),/Sales/);
  await assert.rejects(extractSales(await workbook(sample,{headers:HEADERS.filter(h=>h!=='product')}),'a.xlsx'),/product/);
  await assert.rejects(extractSales(await workbook(sample,{headers:[...HEADERS,'product']}),'a.xlsx'),/únicos/);
  await assert.rejects(extractSales(await workbook([{...sample[0],quantity:{formula:'1+1',result:2}}]),'a.xlsx'),/fórmulas/);
});
test('Maximum 10,000 extracted rows is enforced after blank rows are skipped',async()=>{
  const rows=Array.from({length:10001},(_,i)=>({...sample[0],transaction_id:'R'+i}));
  await assert.rejects(extractSales(await workbook(rows),'limit.xlsx'),/10.000/);
  rows.pop();assert.equal((await extractSales(await workbook(rows),'limit.xlsx')).length,10000);
});
test('Duplicate, whitespace, missing price, zero price and numeric rules stay unchanged',async()=>{
  const rows=[{...sample[0],transaction_id:' duP '},{...sample[0],transaction_id:'DUP'}, {...sample[0],transaction_id:'zero',unit_price_clp:0},{...sample[0],transaction_id:'missing',unit_price_clp:null},{...sample[0],transaction_id:'bad',quantity:1.5}];
  const result=processSales(await extractSales(await workbook(rows),'rules.xlsx'));
  assert.equal(result.valid.length,1);assert.equal(result.review.length,4);assert.equal(result.summary.valid_sales_total_clp,0);
  assert.equal(result.review.filter(r=>r.issues.includes('Duplicate')).length,2);
});
test('Exported customer strings remain text, never formulas; values match exact expected reports',async()=>{
  const suspicious=['=1+1','+SUM(A1:A2)','-1+2','@SUM(1,2)'];
  const rows=suspicious.map((product,i)=>({transaction_id:'T'+i,product,quantity:1,unit_price_clp:0}));
  rows.push({...rows[0],transaction_id:'=customer-id',quantity:0});
  const result=processSales(rows);const reports=await createReports(result);
  for(const [name,expected] of [['valid.xlsx',result.valid],['review.xlsx',result.review],['summary.xlsx',[result.summary]]]) {
    const loaded=await readWorkbook(reports[name]);assert.deepEqual(loaded.rows,expected);
    const parts=await inspectArchive(reports[name]);
    for(const [file,xml] of parts)if(file.startsWith('xl/worksheets/'))assert.doesNotMatch(xml,/<(?:\w+:)?f(?:\s|>)/);
  }
  const loaded=await readWorkbook(reports['valid.xlsx']);
  assert.deepEqual(loaded.rows.map(r=>r.product),suspicious);
});
test('No-row reports use NO_ROWS marker, not fabricated sales',async()=>{
  const result=processSales([{...sample[0],quantity:-1}]);const loaded=await readWorkbook((await createReports(result))['valid.xlsx']);
  assert.equal(loaded.rows[0].status,'NO_ROWS');
});
test('Archive safeguards reject macros, external workbook links, XML declarations and oversized expansion',async()=>{
  const original=await workbook();
  for(const [entry,content,message] of [
    ['xl/vbaProject.bin','macro',/macros/],
    ['xl/externalLinks/externalLink1.xml','<test/>',/vínculos externos/],
    ['custom.xml','<!DOCTYPE test [<!ENTITY x "unsafe">]><test>&x;</test>',/XML/],
    ['large.bin',Buffer.alloc(16*1024*1024+1),/descomprimirlo/],
    ['deep.xml','<x>'.repeat(129)+'</x>'.repeat(129),/complejo/],
  ]) {
    const zip=await JSZip.loadAsync(original);zip.file(entry,content);
    const bytes=await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
    await assert.rejects(extractSales(bytes,'hostile.xlsx'),message);
  }
});
test('Unlabelled data, merged cells, header-only input and invalid XML numbers are explicit errors',async()=>{
  const buffer=await workbook();const decoded=await readWorkbook(buffer);
  decoded.sheet.getCell('E2').value='extra without header';
  await assert.rejects(extractSales(Buffer.from(await decoded.book.xlsx.writeBuffer()),'extra.xlsx'),/sin encabezado/);
  decoded.sheet.getCell('E2').value=null;decoded.sheet.mergeCells('A2:A3');
  await assert.rejects(extractSales(Buffer.from(await decoded.book.xlsx.writeBuffer()),'merge.xlsx'),/combinadas/);
  const zip=await JSZip.loadAsync(buffer);const xml=await zip.file('xl/worksheets/sheet1.xml').async('string');
  zip.file('xl/worksheets/sheet1.xml',xml.replace('<v>2500</v>','<v> </v>'));
  await assert.rejects(extractSales(await zip.generateAsync({type:'nodebuffer'}),'badnumber.xlsx'),/número no válido/);
});
test('OOXML text escapes and literal escape-looking identifiers survive extraction and export',async()=>{
  const zip=await JSZip.loadAsync(await workbook([{...sample[0],product:'PRODUCT_TOKEN'}]));
  const shared=await zip.file('xl/sharedStrings.xml').async('string');
  zip.file('xl/sharedStrings.xml',shared.replace('PRODUCT_TOKEN','A_x000D_B_x005F_x000A_C'));
  const rows=await extractSales(await zip.generateAsync({type:'nodebuffer'}),'escaped.xlsx');
  assert.equal(rows[0].product,'A\rB_x000A_C');
  rows[0].product+='\u0000';
  const result=processSales(rows);const files=await createReports(result);
  assert.deepEqual((await readWorkbook(files['valid.xlsx'])).rows,result.valid);
});
