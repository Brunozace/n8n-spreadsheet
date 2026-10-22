import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { processSales } from './core.mjs';
const sample = JSON.parse(await fs.readFile(new URL('./sample-data.json', import.meta.url)));
let count = 0;
const check = (name,fn) => {fn(); count++; console.log('PASS '+name);};
const row = {transaction_id:'A',product:'Item',quantity:2,unit_price_clp:1000};
check('Sample: 6 valid, 4 review, CLP 53000',()=>{
  const r=processSales(sample); assert.equal(r.valid.length,6); assert.equal(r.review.length,4); assert.equal(r.summary.valid_sales_total_clp,53000); assert.match(r.summary.status,/INCOMPLETE/);
});
check('Both duplicate occurrences excluded, case and whitespace insensitive',()=>{
  const r=processSales([row,{...row,transaction_id:' a '}]); assert.equal(r.valid.length,0); assert.equal(r.review.length,2); assert.equal(r.summary.valid_sales_total_clp,0);
});
check('Missing price is not treated as zero',()=>assert.equal(processSales([{...row,unit_price_clp:null}]).review.length,1));
check('Explicit zero price is valid',()=>assert.equal(processSales([{...row,unit_price_clp:0}]).valid.length,1));
check('Ambiguous numbers rejected',()=>{
  for(const value of ['1.000','1,000','1e3','CLP 1000',true,'',Infinity,1.5]) assert.equal(processSales([{...row,unit_price_clp:value}]).review.length,1);
});
check('Plain numeric strings normalized',()=>assert.equal(processSales([{...row,quantity:' 2 ',unit_price_clp:'1000'}]).summary.valid_sales_total_clp,2000));
check('Empty and wrong-schema input fail clearly',()=>{assert.throws(()=>processSales([]),/No sales/);assert.throws(()=>processSales([{}]),/No sales/);assert.throws(()=>processSales([{price:1}]),/Missing column/);});
check('Unsafe multiplication rejected',()=>assert.equal(processSales([{...row,unit_price_clp:Number.MAX_SAFE_INTEGER}]).review.length,1));
check('Unsafe accumulation fails',()=>assert.throws(()=>processSales([{...row,quantity:1,unit_price_clp:Number.MAX_SAFE_INTEGER},{...row,transaction_id:'B'}]),/Total exceeds/));
check('Input preserved and repeat runs deterministic',()=>{const before=JSON.stringify(sample);const a=processSales(sample);assert.deepEqual(a,processSales(sample));assert.equal(JSON.stringify(sample),before);});
for(const file of ['01-demo.json','02-upload.json']) {
  const w=JSON.parse(await fs.readFile(new URL(file,import.meta.url)));
  check(file+' embedded code and connections',()=>{
    const names=new Set(w.nodes.map(n=>n.name));assert.equal(names.size,w.nodes.length);assert.equal(w.active,false);
    for(const [from,outputs] of Object.entries(w.connections)) {assert(names.has(from));for(const c of outputs.main.flat())assert(names.has(c.node));}
    const code=w.nodes.find(n=>n.name==='Check sales').parameters.jsCode;
    const execute=new Function('$input',code);
    assert.deepEqual(execute({all:()=>sample.map(json=>({json}))})[0].json,processSales(sample));
    for(const name of ['Valid sales','Needs review','Summary']) {
      const branch=new Function('$input',w.nodes.find(n=>n.name===name).parameters.jsCode);
      assert(branch({first:()=>({json:processSales(sample)})}).length>0);
    }
  });
}
console.log(`${count} checks passed. n8n import and binary nodes still require a live n8n run.`);
