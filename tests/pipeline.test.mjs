import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setup,upload,download,remove,workbook,readWorkbook,sample,HEADERS,ORIGIN } from './helpers.mjs';

test(process.env.N8N_TEST_WEBHOOK_URL?'REAL n8n: protected upload → processing → all Excel downloads':'HTTP pipeline with generated workflow Code in an isolated test adapter (not real n8n)',async t=>{
  const ctx=await setup();t.after(()=>ctx.stop());
  const user=await ctx.login();const other=await ctx.login('cliente2');
  await t.test('No authentication cannot upload or download examples',async()=>{
    assert.equal((await fetch(ctx.base+'/downloads/sample.xlsx')).status,401);
    assert.equal((await upload(ctx,{cookie:'',csrfToken:''},await workbook())).status,401);
  });
  await t.test('Origin and CSRF are required',async()=>{
    assert.equal((await upload(ctx,user,await workbook(),'a.xlsx',{'X-CSRF-Token':'bad'})).status,403);
    assert.equal((await upload(ctx,user,await workbook(),'a.xlsx',{Origin:'https://elsewhere.example'})).status,403);
  });
  await t.test('Blank template and separate baseline sample download',async()=>{
    const template=await download(ctx,user,'/downloads/template.xlsx');assert.equal(template.status,200);
    const decoded=await readWorkbook(Buffer.from(await template.arrayBuffer()));assert.equal(decoded.sheet.name,'Sales');assert.deepEqual(decoded.headers,HEADERS);assert.equal(decoded.rows.length,0);
    const example=await download(ctx,user,'/downloads/sample.xlsx');assert.equal(example.status,200);
    const response=await upload(ctx,user,Buffer.from(await example.arrayBuffer()));
    assert.equal(response.status,200,await response.clone().text());const job=await response.json();
    assert.equal(job.summary.valid_sales_total_clp,53000);await remove(ctx,user,job.id);
  });
  for(const [file,valid,review,total] of [['sample-sales - Copy.xlsx',6,4,53000],['sample-sales.xlsx',7,3,61000]]) {
    await t.test(`${file}: 10 input / ${valid} valid / ${review} review / ${total} CLP, download all files`,async()=>{
      const original=await fs.readFile(new URL('../'+file,import.meta.url));
      const response=await upload(ctx,user,original,file);assert.equal(response.status,200,await response.clone().text());
      const job=await response.json();
      assert.deepEqual([job.summary.input_records,job.summary.valid_records,job.summary.review_records,job.summary.valid_sales_total_clp],[10,valid,review,total]);
      assert.match(job.summary.status,/review rows excluded/);
      for(const [key,count] of [['valid',valid],['review',review],['summary',1]]) {
        const response=await download(ctx,user,job.downloads[key]);assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),new RegExp(key+'\\.xlsx'));
        const decoded=await readWorkbook(Buffer.from(await response.arrayBuffer()));assert.equal(decoded.rows.length,count);
        if(key==='valid') {
          const expected=JSON.parse(await fs.readFile(new URL('../expected-results.json',import.meta.url))).valid;
          if(valid===7)expected.push({input_record:9,transaction_id:'V009',product:'Sándwich',quantity:2,unit_price_clp:4000,line_total_clp:8000});
          assert.deepEqual(decoded.rows,expected);
          assert.equal(decoded.rows.reduce((sum,r)=>sum+r.line_total_clp,0),total);
        }
        if(key==='review')assert.deepEqual(decoded.rows,job.review);
        if(key==='summary')assert.deepEqual(decoded.rows[0],job.summary);
      }
      const originalDownload=await download(ctx,user,job.downloads.original);assert.deepEqual(Buffer.from(await originalDownload.arrayBuffer()),original);
      assert.equal((await download(ctx,other,job.downloads.valid)).status,404);
      assert.equal((await remove(ctx,other,job.id)).status,404);
      assert.equal((await remove(ctx,user,job.id)).status,200);
      assert.equal((await download(ctx,user,job.downloads.valid)).status,404);
    });
  }
  await t.test('Correcting a baseline copy only: V009 price 4000 gives 61,000 CLP',async()=>{
    const rows=structuredClone(sample);rows.find(r=>r.transaction_id==='V009').unit_price_clp=4000;
    const response=await upload(ctx,user,await workbook(rows));assert.equal(response.status,200);const job=await response.json();
    assert.deepEqual([job.summary.valid_records,job.summary.review_records,job.summary.valid_sales_total_clp],[7,3,61000]);await remove(ctx,user,job.id);
  });
  await t.test('Every duplicate is held; repeated uploads do not deduplicate across runs',async()=>{
    const bytes=await workbook([{...sample[0],transaction_id:' dup '},{...sample[0],transaction_id:'DUP'},{...sample[0],transaction_id:'zero',unit_price_clp:0}]);
    for(let i=0;i<2;i++) {
      const response=await upload(ctx,user,bytes);assert.equal(response.status,200);const job=await response.json();
      assert.deepEqual([job.summary.valid_records,job.summary.review_records,job.summary.valid_sales_total_clp],[1,2,0]);
      assert(job.review.every(r=>r.issues.includes('Duplicate')));await remove(ctx,user,job.id);
    }
  });
  await t.test('All-valid data produces COMPLETE, safe text and a NO_ROWS review report',async()=>{
    const response=await upload(ctx,user,await workbook([{transaction_id:'TEXT',product:'=1+1',quantity:2,unit_price_clp:0}]));
    assert.equal(response.status,200);const job=await response.json();
    assert.equal(job.summary.status,'COMPLETE');assert.equal(job.summary.review_records,0);
    const valid=await readWorkbook(Buffer.from(await (await download(ctx,user,job.downloads.valid)).arrayBuffer()));
    assert.equal(valid.rows[0].product,'=1+1');assert.equal(valid.sheet.getCell('C2').type,3);
    const review=await readWorkbook(Buffer.from(await (await download(ctx,user,job.downloads.review)).arrayBuffer()));
    assert.equal(review.rows[0].status,'NO_ROWS');await remove(ctx,user,job.id);
  });
  await t.test('Bad files, missing columns/sheet, formula and oversize inputs return errors',async()=>{
    const invalids=[
      [Buffer.from('pretend Excel'),'bad.xlsx',400],
      [await workbook(),'bad.csv',400],
      [await workbook(sample,{headers:HEADERS.filter(h=>h!=='product')}),'missing.xlsx',400],
      [await workbook(sample,{sheet:'Other'}),'sheet.xlsx',400],
      [await workbook([{...sample[0],unit_price_clp:{formula:'4000',result:4000}}]),'formula.xlsx',400],
      [Buffer.alloc(5*1024*1024+1),'big.xlsx',413],
    ];
    for(const [bytes,name,status] of invalids) {
      const response=await upload(ctx,user,bytes,name);assert.equal(response.status,status,name);
      const body=await response.json();assert.equal(typeof body.error,'string');assert.equal(body.downloads,undefined);
    }
  });
  if(ctx.live) await t.test('Private n8n webhook refuses missing/wrong credential',async()=>{
    for(const headers of [{},{'X-Pilot-Key':'incorrect'}]) {
      const response=await fetch(ctx.url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({requestId:'auth-test',rows:sample})});
      assert([401,403].includes(response.status),`Expected auth failure, got ${response.status}`);
    }
  });
  await t.test('Logout discards all session downloads',async()=>{
    const response=await upload(ctx,user,await workbook());assert.equal(response.status,200);const job=await response.json();
    const logout=await fetch(ctx.base+'/api/logout',{method:'POST',headers:{Origin:ORIGIN,Cookie:user.cookie,'X-CSRF-Token':user.csrfToken}});assert.equal(logout.status,200);
    assert.equal((await download(ctx,user,job.downloads.valid)).status,401);
  });
});
