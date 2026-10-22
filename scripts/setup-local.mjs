// Run with: node --env-file=.env scripts/setup-local.mjs
// Installs missing website workflows only in this project's localhost Compose
// pilot. Existing workflow IDs are never overwritten by this helper.
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {run} from './start-test-n8n.mjs';
import {readConfig} from '../lib/config.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=readConfig();
if (!['localhost','127.0.0.1'].includes(new URL(config.appOrigin).hostname) || config.production) throw new Error('This helper only supports the localhost pilot.');
const editor=`http://127.0.0.1:${process.env.N8N_EDITOR_PORT||5679}`;
const compose=args=>run('docker',['compose',...args]);
const directory=path.join(root,'.tmp',`local-setup-${randomUUID()}`);
let stopped=false;
try {
  await compose(['config','--quiet']);
  await compose(['up','-d','--wait','n8n']);
  // n8n's list command uses its logger; warn-level logging hides the list.
  const listing=await compose(['exec','-T','-e','N8N_LOG_LEVEL=info','n8n','n8n','list:workflow']);
  const entries=listing.split(/\r?\n/).filter(line=>/^[A-Za-z0-9_-]+\|/.test(line)).map(line=>({id:line.slice(0,line.indexOf('|')),name:line.slice(line.indexOf('|')+1).trim()}));
  const ids=new Set(entries.map(entry=>entry.id));
  const names=new Set(entries.map(entry=>entry.name));
  const workflows=[];
  const credentialId=`pilotWeb-${randomUUID()}`;
  for(const filename of ['03-web-upload.json','04-quotation-review.json']) {
    const workflow=JSON.parse(await readFile(path.join(root,filename),'utf8'));
    // The editor may assign a new ID during a manual import; its name still
    // identifies the shipped workflow. Never install a second copy in that case.
    if(ids.has(workflow.id) || names.has(workflow.name)) {console.log(`Kept existing workflow ${workflow.name}.`);continue;}
    workflow.nodes.find(node=>node.type==='n8n-nodes-base.webhook').credentials={httpHeaderAuth:{id:credentialId,name:'Private website header'}};
    workflow.active=false;
    workflows.push(workflow);
  }
  if(workflows.length) {
    await mkdir(directory,{recursive:true,mode:0o700});
    await writeFile(path.join(directory,'credentials.json'),JSON.stringify([{id:credentialId,name:'Private website header',type:'httpHeaderAuth',data:{name:'X-Pilot-Key',value:config.n8nWebhookSecret}}]),{mode:0o600});
    await writeFile(path.join(directory,'workflows.json'),JSON.stringify(workflows),{mode:0o600});
    await compose(['stop','web','n8n']);stopped=true;
    const common=['run','--rm','--no-deps','-T','--volume',`${directory}:/pilot-setup:ro`,'n8n'];
    await compose([...common,'import:credentials','--input=/pilot-setup/credentials.json']);
    await compose([...common,'import:workflow','--input=/pilot-setup/workflows.json']);
    for(const workflow of workflows) {await compose([...common,'publish:workflow',`--id=${workflow.id}`]);console.log(`Installed ${workflow.name} in the localhost pilot.`);}
  }
  await compose(['up','-d','--build','--wait']);stopped=false;
  // Synthetic smoke only; never send the user's quotation during setup.
  const {quotationSample}=await import('../lib/quotation-results.mjs');
  const {extractQuotationWorkbook}=await import('../lib/quotation-reader.mjs');
  const workbook=await extractQuotationWorkbook(await quotationSample(),'example.xlsx');
  for(const [endpoint,body,check] of [
    ['sales-web',{requestId:'local-setup-sales',rows:[{transaction_id:'SETUP',product:'Fictional example',quantity:2,unit_price_clp:300}]},result=>result?.summary?.valid_sales_total_clp===600],
    ['quotation-web',{requestId:'local-setup-quotation',kind:'quotation',workbook},result=>result?.summary?.engine_count===2&&result?.summary?.part_records===6],
  ]) {
    let response,payload;
    for(let attempt=0;attempt<15;attempt++) {
      response=await fetch(`${editor}/webhook/${endpoint}`,{method:'POST',headers:{'Content-Type':'application/json','X-Pilot-Key':config.n8nWebhookSecret},body:JSON.stringify(body),signal:AbortSignal.timeout(65000)});
      try {payload=await response.json();} catch {payload=null;}
      if(![404,502,503].includes(response.status))break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    if(!response.ok || !check(payload?.result)) throw new Error(`${endpoint} is not ready (HTTP ${response.status}). Check its credential binding and publication in the local editor. Existing workflows were not overwritten.`);
    console.log(`Verified private ${endpoint} webhook with fictional data.`);
  }
  console.log(`Ready: ${config.appOrigin}/quotation.html — use your existing pilot login.`);
} finally {
  // Delete only this helper's exact owned directory, never a caller-supplied path.
  if(path.dirname(directory)===path.join(root,'.tmp') && path.basename(directory).startsWith('local-setup-')) await rm(directory,{recursive:true,force:true});
  if(stopped) {try {await compose(['up','-d','--wait']);} catch {console.error('Restart the pilot with docker compose up -d --wait.');}}
}
