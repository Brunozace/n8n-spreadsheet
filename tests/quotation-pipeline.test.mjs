import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { setup,uploadQuotation,upload,download,remove,workbook } from './helpers.mjs';
import { createQuotationFixture,createQuotationXlsx,fixtureCell } from './quotation-fixture.mjs';
import { extractQuotationWorkbook } from '../lib/quotation-reader.mjs';
import { processQuotation } from '../quotation-core.mjs';
import { validateQuotationResult } from '../lib/quotation-results.mjs';

async function read(bytes) { const book=new ExcelJS.Workbook(); await book.xlsx.load(bytes); return book; }
function noFormulas(book) { for(const sheet of book.worksheets) sheet.eachRow(row=>row.eachCell(cell=>assert.notEqual(cell.type,ExcelJS.ValueType.Formula))); }
test(process.env.N8N_TEST_WEBHOOK_URL?'REAL n8n quotation upload to Excel downloads':'Quotation HTTP path with workflow Code adapter (not real n8n)', async t=>{
  const ctx=await setup();t.after(()=>ctx.stop());
  const user=await ctx.login(), other=await ctx.login('cliente2');
  await t.test('Auth, CSRF, file type, size and incomplete columns fail with no success receipt',async()=>{
    const original=await createQuotationXlsx();
    assert.equal((await uploadQuotation(ctx,{cookie:'',csrfToken:''},original)).status,401);
    assert.equal((await download(ctx,{cookie:''},'/downloads/quotation-sample.xlsx')).status,401);
    assert.equal((await uploadQuotation(ctx,user,original,'file.xlsx',{'X-CSRF-Token':'bad'})).status,403);
    const missing=createQuotationFixture();fixtureCell(missing,0,'I17').value='unknown';
    for(const [bytes,name,status] of [[Buffer.from('not Excel'),'a.xlsx',400],[original,'a.xls',400],[await workbook(),'sales.xlsx',400],[await createQuotationXlsx(missing),'missing.xlsx',400],[Buffer.alloc(5*1024*1024+1),'large.xlsx',413]]) {
      const response=await uploadQuotation(ctx,user,bytes,name);assert.equal(response.status,status,await response.clone().text());
      const body=await response.json();assert.equal(typeof body.error,'string');assert.equal(body.downloads,undefined);
    }
  });
  await t.test('Complete decimal quotation, three safe reports, exact original and session isolation',async()=>{
    const original=await createQuotationXlsx(); const response=await uploadQuotation(ctx,user,original);
    assert.equal(response.status,200,await response.clone().text());const job=await response.json();
    assert.deepEqual([job.summary.engine_count,job.summary.part_records,job.summary.review_records,job.summary.parts_net_clp],[1,3,0,4100.5]);
    assert.deepEqual([job.summary.shortage_records,job.summary.reported_shortage_units,job.summary.unspecified_shortage_records],[1,1,1]);
    const reports={};
    for(const key of ['parts','review','summary']) {
      const response=await download(ctx,user,job.downloads[key]);assert.equal(response.status,200);
      reports[key]=await read(Buffer.from(await response.arrayBuffer()));noFormulas(reports[key]);
    }
    assert.equal(reports.parts.getWorksheet('Repuestos').rowCount,4);
    assert.equal(reports.parts.getWorksheet('Faltantes declarados').rowCount,2);
    assert.equal(reports.parts.getWorksheet('Repuestos').getCell('I2').value,1250.25);
    assert.equal(reports.parts.getWorksheet('Repuestos').getCell('H3').value,null);
    assert.equal(reports.parts.getWorksheet('Repuestos').getCell('H4').value,0);
    assert.equal(reports.review.getWorksheet('Alertas').getCell('A2').value,'NO_ROWS');
    assert.equal(reports.summary.getWorksheet('Motores').getCell('I2').value,4100.5);
    assert.equal(reports.summary.getWorksheet('Motores').getCell('J2').value,779.095);
    assert.deepEqual(Buffer.from(await (await download(ctx,user,job.downloads.original)).arrayBuffer()),original);
    assert.equal((await download(ctx,other,job.downloads.parts)).status,404);
    assert.equal((await download(ctx,user,`/api/results/${job.id}/files/valid.xlsx`)).status,404);
    await remove(ctx,user,job.id);assert.equal((await download(ctx,user,job.downloads.parts)).status,404);
  });
  await t.test('Sample downloads contain fictional data and use the quotation workflow',async()=>{
    const response=await download(ctx,user,'/downloads/quotation-sample.xlsx');assert.equal(response.status,200);
    const bytes=Buffer.from(await response.arrayBuffer());
    const result=await uploadQuotation(ctx,user,bytes);assert.equal(result.status,200,await result.clone().text());
    const job=await result.json();assert.equal(job.summary.engine_count,2);assert.equal(job.summary.part_records,6);assert.equal(job.summary.formula_unverified_cells,0);
    assert.equal((await upload(ctx,user,bytes)).status,400);await remove(ctx,user,job.id);
  });
  await t.test('Duplicate ITEM, stale and unsupported formulas are reviewable, and customer text is inert',async()=>{
    const input=createQuotationFixture();
    fixtureCell(input,0,'F18').value=' same ';fixtureCell(input,0,'F19').value='SAME';
    fixtureCell(input,0,'J18').value='=HYPERLINK("https://example.invalid","text")';
    fixtureCell(input,0,'K18').formula='WEBSERVICE("https://example.invalid")';
    fixtureCell(input,0,'L32').value=600;
    for(let attempt=0;attempt<2;attempt++) {
      const response=await uploadQuotation(ctx,user,await createQuotationXlsx(input));assert.equal(response.status,200,await response.clone().text());
      const job=await response.json();assert.equal(job.issues.filter(i=>i.code==='duplicate_item').length,2);
      assert(job.issues.some(i=>i.code==='formula_unverified'));assert(job.issues.some(i=>i.code==='formula_stale'));
      assert.equal(job.parts[0].unit_price_clp,1250.25);
      const reports=await read(Buffer.from(await(await download(ctx,user,job.downloads.parts)).arrayBuffer()));noFormulas(reports);
      assert.equal(reports.getWorksheet('Repuestos').getCell('F2').value,fixtureCell(input,0,'J18').value);
      await remove(ctx,user,job.id);
    }
  });
  await t.test('Missing summary and workbook-level warnings still produce usable review reports',async()=>{
    const input=createQuotationFixture();input.sheets.pop();
    const response=await uploadQuotation(ctx,user,await createQuotationXlsx(input));assert.equal(response.status,200,await response.clone().text());
    const job=await response.json();assert.equal(job.summary.summary_found,false);assert(job.issues.some(i=>i.code==='summary_missing'));await remove(ctx,user,job.id);
  });
  if(ctx.live) await t.test('Private quotation webhook requires its credential',async()=>{
    const response=await fetch(ctx.quoteUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert([401,403].includes(response.status));
  });
  await t.test('User-supplied quotation: read-only upload, exact original, all downloaded workbooks', {skip:!process.env.QUOTATION_TEST_FILE},async()=>{
    const file=process.env.QUOTATION_TEST_FILE;
    const original=await fs.readFile(file), before=createHash('sha256').update(original).digest('hex');
    const response=await uploadQuotation(ctx,user,original,'customer-quotation.xlsx');assert.equal(response.status,200,await response.clone().text());
    const job=await response.json();
    assert.deepEqual([job.summary.engine_count,job.summary.part_records,job.summary.shortage_records,job.summary.reported_shortage_units,job.summary.unspecified_shortage_records],[3,314,27,77,287]);
    assert.equal(job.summary.formula_cells,1024);assert.equal(job.summary.formula_unverified_cells,0);
    assert.deepEqual(job.engines.map(e=>e.part_records),[80,84,150]);assert.equal(job.summary.review_records,1);
    for(const key of ['parts','review','summary']) {
      const report=await read(Buffer.from(await(await download(ctx,user,job.downloads[key])).arrayBuffer()));noFormulas(report);
      if(key==='parts') {
        const sheet=report.getWorksheet('Repuestos');assert.equal(sheet.rowCount,315);assert.equal(report.getWorksheet('Faltantes declarados').rowCount,28);
        job.parts.forEach((part,i)=>{
          for(const [column,key] of [['A','sheet'],['B','row'],['C','item'],['E','part_number'],['F','description'],['G','quantity'],['H','reported_shortage'],['I','unit_price_clp'],['J','line_total_clp']]) assert.equal(sheet.getCell(`${column}${i+2}`).value??'',part[key]??'');
        });
      }
      if(key==='review') assert.equal(report.getWorksheet('Alertas').rowCount,job.issues.length+1);
      if(key==='summary') assert.equal(report.getWorksheet('Motores').rowCount,4);
    }
    assert.deepEqual(Buffer.from(await(await download(ctx,user,job.downloads.original)).arrayBuffer()),original);
    assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'),before);
    await remove(ctx,user,job.id);
  });
});

test('Quotation completion rejects receipt-only, altered counts, missing parts and wrong request',async()=>{
  const input=await extractQuotationWorkbook(await createQuotationXlsx(),'test.xlsx');
  const result=processQuotation(input);const payload={requestId:'test',kind:'quotation',result};
  assert.equal(validateQuotationResult(payload,'test',input),result);
  for(const modify of [p=>{p.requestId='other';},p=>{p.result.summary.part_records++;},p=>{p.result.parts.pop();},p=>{delete p.result.engines;}]) {
    const altered=structuredClone(payload);modify(altered);assert.throws(()=>validateQuotationResult(altered,'test',input));
  }
  assert.throws(()=>validateQuotationResult({requestId:'test',received:true},'test',input));
});
