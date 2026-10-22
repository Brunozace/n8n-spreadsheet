import { readFile, writeFile } from 'node:fs/promises';
import { processQuotation } from '../quotation-core.mjs';

const root=new URL('../',import.meta.url);
const workflow=JSON.parse(await readFile(new URL('03-web-upload.json',root),'utf8'));
workflow.id='quotationWebPilotV1';
workflow.name='04 - Protected quotation review';
const [trigger,code,response]=workflow.nodes;
trigger.id='1a247430-0267-4bf9-a943-dc1f1138318a';
trigger.webhookId='c6a5de2b-3381-4d96-98b4-19f4d25f28a3';
trigger.parameters.path='quotation-web';
code.id='e7c5b45a-1cf9-42fb-9c88-416297a6014e';
code.name='Review quotation';
code.notes='Quotation layout and safe formula auditing from quotation-core.mjs. Stored values are preserved. No Excel automation, purchases, inventory writes, or customer file changes.';
code.parameters.jsCode=`${processQuotation.toString()}\n\nconst body=$input.first().json.body;\nif (!body || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(body.requestId) || body.kind !== 'quotation' || !Array.isArray(body.workbook?.sheets)) throw new Error('Invalid website request');\ntry {\n  return [{json:{requestId:body.requestId,kind:'quotation',result:processQuotation(body.workbook)}}];\n} catch(error) {\n  if(error.code !== 'INVALID_QUOTATION') throw error;\n  return [{json:{requestId:body.requestId,kind:'quotation',error:{code:'INVALID_QUOTATION',message:error.message}}}];\n}`;
response.id='a130a01e-9c72-4ca5-8636-b714b0907dfe';
workflow.connections={
  [trigger.name]:{main:[[{node:code.name,type:'main',index:0}]]},
  [code.name]:{main:[[{node:response.name,type:'main',index:0}]]},
};
await writeFile(new URL('04-quotation-review.json',root),JSON.stringify(workflow,null,2)+'\n');
console.log('Created 04-quotation-review.json (inactive; no credential bindings).');
