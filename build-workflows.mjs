import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { processSales } from './core.mjs';
const sample = JSON.parse(await fs.readFile(new URL('./sample-data.json', import.meta.url)));
const coreCode = processSales.toString() + '\nreturn [{json: processSales($input.all().map(item => item.json))}];';
function node(name, type, parameters, position, version = 1) {
  return {id: randomUUID(), name, type: 'n8n-nodes-base.' + type, typeVersion: version, position, parameters};
}
function build(upload) {
  const nodes = [], connections = {};
  const connect = (from, to) => {
    connections[from] ??= {main:[[]]};
    connections[from].main[0].push({node:to,type:'main',index:0});
  };
  if (upload) {
    const form = node('Upload practice spreadsheet', 'formTrigger', {
      formTitle:'Sales spreadsheet check',
      formDescription:'Upload sample-sales.xlsx. Return to the n8n editor to inspect and download the results.',
      formFields:{values:[{fieldLabel:'data',fieldType:'file',multipleFiles:false,acceptFileTypes:'.xlsx',requiredField:true}]},
      responseMode:'onReceived',options:{buttonLabel:'Check spreadsheet',respondWithOptions:{values:{respondWith:'text',formSubmittedText:'File received. Return to the n8n editor to check whether processing succeeded and download the reports.'}}}
    }, [0,300], 2.2);
    form.webhookId = randomUUID();
    nodes.push(form);
    const extract = node('Read Sales sheet','extractFromFile',{operation:'xlsx',binaryPropertyName:'data',options:{sheetName:'Sales',headerRow:true,includeEmptyCells:true,rawData:true}},[240,300]);
    extract.alwaysOutputData = true;
    nodes.push(extract);
    connect(form.name, extract.name); connect(extract.name, 'Check sales');
  } else {
    nodes.push(node('Start demo','manualTrigger',{},[0,300]));
    nodes.push(node('Practice sales','code',{mode:'runOnceForAllItems',jsCode:'return '+ JSON.stringify(sample) + '.map(row => ({json:row}));'},[240,300],2));
    connect('Start demo','Practice sales'); connect('Practice sales','Check sales');
  }
  nodes.push(node('Check sales','code',{mode:'runOnceForAllItems',jsCode:coreCode},[480,300],2));
  [['valid','Valid sales',80],['review','Needs review',300],['summary','Summary',520]].forEach(([key,label,y])=>{
    const jsCode = key === 'summary'
      ? 'return [{json: $input.first().json.summary}];'
      : `const rows = $input.first().json.${key};\nreturn (rows.length ? rows : [{status:'NO_ROWS', note:'This report contains no ${key} records.'}]).map(row => ({json:row}));`;
    nodes.push(node(label,'code',{mode:'runOnceForAllItems',jsCode},[740,y],2));
    nodes.push(node('Download '+label,'convertToFile',{operation:'xlsx',binaryPropertyName:'data',options:{fileName:key+'.xlsx',headerRow:true,sheetName:label,compression:true}},[1000,y],1.1));
    connect('Check sales',label); connect(label,'Download '+label);
  });
  return {name:upload?'02 - Upload a sales spreadsheet':'01 - Sales automation demo',nodes,connections,active:false,settings:{executionOrder:'v1'},pinData:{},tags:[]};
}
for (const [name,upload] of [['01-demo.json',false],['02-upload.json',true]]) {
  await fs.writeFile(new URL(name, import.meta.url),JSON.stringify(build(upload),null,2));
}
await fs.writeFile(new URL('expected-results.json',import.meta.url),JSON.stringify(processSales(sample),null,2));
