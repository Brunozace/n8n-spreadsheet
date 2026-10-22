import ExcelJS from 'exceljs';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createServer } from '../server.mjs';
import { hashPassword } from '../lib/auth.mjs';

export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const ORIGIN = 'http://localhost:3000';
export const HEADERS = ['transaction_id','product','quantity','unit_price_clp'];
export const sample = JSON.parse(await fs.readFile(new URL('../sample-data.json',import.meta.url)));
export async function workbook(rows=sample, {headers=HEADERS,sheet='Sales'}={}) {
  const book=new ExcelJS.Workbook(); const tab=book.addWorksheet(sheet);
  tab.addRow(headers);
  for(const row of rows)tab.addRow(headers.map(h=>row[h]??null));
  return Buffer.from(await book.xlsx.writeBuffer());
}
export async function readWorkbook(buffer) {
  const book=new ExcelJS.Workbook(); await book.xlsx.load(buffer);
  const sheet=book.worksheets[0]; const headers=sheet.getRow(1).values.slice(1); const rows=[];
  sheet.eachRow((row,i)=>{if(i>1)rows.push(Object.fromEntries(headers.map((h,j)=>[h,row.getCell(j+1).value])));});
  return {book,sheet,headers,rows};
}
export async function listen(server) { server.listen(0,'127.0.0.1'); await once(server,'listening'); return `http://127.0.0.1:${server.address().port}`; }
export async function close(server) { if(!server)return; server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
export async function setup(overrides={}) {
  const workflow=JSON.parse(await fs.readFile(new URL('../03-web-upload.json',import.meta.url)));
  const execute=new Function('$input',workflow.nodes.find(n=>n.name==='Check sales').parameters.jsCode);
  const quoteWorkflow=JSON.parse(await fs.readFile(new URL('../04-quotation-review.json',import.meta.url)));
  const executeQuote=new Function('$input',quoteWorkflow.nodes.find(n=>n.name==='Review quotation').parameters.jsCode);
  const secret=process.env.N8N_TEST_WEBHOOK_SECRET || 'test-only-private-secret-32-characters-long';
  let backend, calls=0, url=process.env.N8N_TEST_WEBHOOK_URL;
  if(!url) {
    backend=http.createServer(async(req,res)=>{
      if(req.headers['x-pilot-key']!==secret) {res.writeHead(401);res.end();return;}
      try {
        const parts=[];for await(const part of req)parts.push(part);
        const body=JSON.parse(Buffer.concat(parts)); calls++;
        // Executes our generated workflow source, never formulas supplied by users.
        const value=(body.kind==='quotation'?executeQuote:execute)({first:()=>({json:{body}})})[0].json;
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));
      } catch {res.writeHead(500);res.end('Processing failed');}
    });
    url=await listen(backend);
  }
  const password='fictional-pilot-password';
  const hash=await hashPassword(password);
  const quoteUrl=process.env.N8N_TEST_QUOTATION_WEBHOOK_URL || new URL('/webhook/quotation-web',url).href;
  const server=createServer({users:{bruno:hash,cliente2:hash},n8nWebhookUrl:url,n8nQuotationWebhookUrl:quoteUrl,n8nWebhookSecret:secret,appOrigin:ORIGIN,secureCookie:false,production:false,quiet:true,maxJobsPerSession:20,uploadLimit:100,loginLimit:100,...overrides});
  const base=await listen(server);
  return {
    base,backend,server,url,quoteUrl,secret,password, live:Boolean(process.env.N8N_TEST_WEBHOOK_URL),get calls(){return calls;},
    async login(username='bruno') {
      const response=await fetch(base+'/api/login',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({username,password})});
      if(response.status!==200)throw new Error(`Login failed: ${await response.text()}`);
      return {cookie:response.headers.get('set-cookie').split(';')[0],...(await response.json())};
    },
    async stop(){await close(server);await close(backend);},
  };
}
export function upload(ctx,user,body,filename='ventas.xlsx',extra={}) {
  return fetch(ctx.base+'/api/upload',{method:'POST',headers:{Origin:ORIGIN,Cookie:user.cookie,'X-CSRF-Token':user.csrfToken,'X-Filename':encodeURIComponent(filename),'Content-Type':XLSX,...extra},body});
}
export function download(ctx,user,url) {return fetch(ctx.base+url,{headers:{Cookie:user.cookie}});}
export function uploadQuotation(ctx,user,body,filename='cotizacion.xlsx',extra={}) {
  return fetch(ctx.base+'/api/quotation/upload',{method:'POST',headers:{Origin:ORIGIN,Cookie:user.cookie,'X-CSRF-Token':user.csrfToken,'X-Filename':encodeURIComponent(filename),'Content-Type':XLSX,...extra},body});
}
export async function remove(ctx,user,id) {
  return fetch(ctx.base+'/api/results/'+id,{method:'DELETE',headers:{Origin:ORIGIN,Cookie:user.cookie,'X-CSRF-Token':user.csrfToken}});
}
