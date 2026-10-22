import ExcelJS from 'exceljs';

const number = value => value === null || (typeof value === 'number' && Number.isFinite(value));
const text = value => typeof value === 'string' && value.length <= 32767;
const count = value => Number.isSafeInteger(value) && value >= 0;

// Validate the response contract before showing success or retaining any files.
// Business rules and formula auditing run in the private n8n workflow.
export function validateQuotationResult(payload, requestId, workbook) {
  const fail = () => { throw new Error('Invalid quotation completion'); };
  const result = payload?.result;
  if (payload?.requestId !== requestId || payload?.kind !== 'quotation' || !result) fail();
  const {summary, engines, parts, shortages, issues, totals} = result;
  if (!summary || ![engines,parts,shortages,issues,totals].every(Array.isArray) ||
      engines.length < 1 || engines.length > workbook.sheets.length || !parts.length || parts.length > 10000 ||
      shortages.length > parts.length || issues.length > 250000 || totals.length > 10000) fail();
  for (const key of ['engine_count','part_records','review_records','shortage_records','unspecified_shortage_records','issue_count','formula_cells','formula_unverified_cells']) {
    if (!count(summary[key])) fail();
  }
  if (!number(summary.parts_net_clp) || !number(summary.reported_shortage_units) || typeof summary.summary_found !== 'boolean' ||
      summary.engine_count !== engines.length || summary.part_records !== parts.length || summary.issue_count !== issues.length ||
      summary.shortage_records !== shortages.length || summary.formula_unverified_cells > summary.formula_cells) fail();
  const sheets = new Map(workbook.sheets.map(sheet => [sheet.name, sheet]));
  const locations = new Map(workbook.sheets.map(sheet => [sheet.name, new Set(sheet.cells.map(cell => cell.address))]));
  const rows = new Map(workbook.sheets.map(sheet => [sheet.name,new Set(sheet.cells.map(cell => cell.row))]));
  const keys = new Set();
  for (const part of parts) {
    if (!part || !sheets.has(part.sheet) || !rows.get(part.sheet).has(part.row) || !['ok','review'].includes(part.status) ||
        !['item','group','part_number','description'].every(key => text(part[key])) ||
        !['quantity','reported_shortage','unit_price_clp','line_total_clp'].every(key => number(part[key])) ||
        !Array.isArray(part.issues) || !part.issues.every(text) || (part.status === 'review') !== (part.issues.length > 0)) fail();
    const key = `${part.sheet}\0${part.row}`;
    if (keys.has(key)) fail();
    keys.add(key);
  }
  const expectedShortages = parts.filter(part => Number.isSafeInteger(part.reported_shortage) && part.reported_shortage > 0);
  if (summary.review_records !== parts.filter(part => part.status === 'review').length ||
      summary.unspecified_shortage_records !== parts.filter(part => part.reported_shortage === null).length ||
      JSON.stringify(shortages) !== JSON.stringify(expectedShortages) ||
      summary.reported_shortage_units !== expectedShortages.reduce((sum,part) => sum+part.reported_shortage,0)) fail();
  const engineNames = new Set();
  for (const engine of engines) {
    if (!engine || !sheets.has(engine.sheet) || engineNames.has(engine.sheet) || !text(engine.engine) || !text(engine.serial) ||
        !['part_records','review_records','shortage_records','unspecified_shortage_records'].every(key => count(engine[key])) ||
        !['reported_shortage_units','quoted_net_clp','quoted_vat_clp','quoted_total_clp'].every(key => number(engine[key]))) fail();
    engineNames.add(engine.sheet);
    const own = parts.filter(part => part.sheet === engine.sheet);
    if (engine.part_records !== own.length || engine.review_records !== own.filter(part => part.status === 'review').length ||
        engine.shortage_records !== own.filter(part => Number.isSafeInteger(part.reported_shortage) && part.reported_shortage > 0).length) fail();
  }
  if (parts.some(part => !engineNames.has(part.sheet))) fail();
  for (const issue of issues) {
    if (!issue || !['error','warning'].includes(issue.severity) || !(sheets.has(issue.sheet) || issue.sheet === '' && issue.cell === '') ||
        !text(issue.cell) || (issue.cell && !/^[A-Z]{1,3}[1-9]\d*$/.test(issue.cell)) || !text(issue.code) || !text(issue.message)) fail();
    for (const key of ['stored_value','expected_value']) {
      if (issue[key] !== undefined && !number(issue[key]) && !text(issue[key]) && typeof issue[key] !== 'boolean') fail();
    }
  }
  for (const total of totals) {
    if (!total || !text(total.key) || !text(total.label) || !number(total.value) || !['ok','review'].includes(total.status) ||
        !locations.get(total.source_sheet)?.has(total.source_cell)) fail();
  }
  return result;
}

// Preserve literal OOXML escape patterns and controls. All customer values are
// scalar strings/numbers: ExcelJS never receives a customer formula object.
const excelText = value => value.replace(/_x[0-9a-f]{4}_/gi, match => '_x005F_'+match.slice(1))
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,char => `_x${char.charCodeAt(0).toString(16).padStart(4,'0')}_`);
function addSheet(book, name, columns, rows) {
  const sheet = book.addWorksheet(name,{views:[{state:'frozen',ySplit:1}]});
  sheet.columns = columns.map(([key,header,width=22])=>({key,header,width}));
  for (const row of rows) {
    const added = sheet.addRow(columns.map(([key]) => typeof row[key] === 'string' ? excelText(row[key]) : row[key] ?? null));
    added.eachCell(cell => {
      if (typeof cell.value === 'string') cell.numFmt = '@';
      else if (typeof cell.value === 'number') cell.numFmt = '#,##0.00';
      else if (typeof cell.value !== 'boolean' && cell.value !== null) throw new Error('Non-scalar quotation export');
      cell.alignment = {vertical:'top',wrapText:true};
    });
  }
  sheet.getRow(1).height = 32;
  sheet.getRow(1).eachCell(cell=>{
    cell.font={bold:true,color:{argb:'FFFFFFFF'}};
    cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF123F47'}};
    cell.alignment={vertical:'middle',wrapText:true};
  });
  sheet.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,sheet.rowCount),column:columns.length}};
  sheet.pageSetup={orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0};
  return sheet;
}
const partColumns = [
  ['sheet','Hoja',30],['row','Fila',10],['item','Ítem',12],['group','Grupo',20],
  ['part_number','Número de parte',24],['description','Descripción',44],['quantity','Cantidad',14],
  ['reported_shortage','Falta declarada',18],['unit_price_clp','Precio unitario CLP',24],
  ['line_total_clp','Total cotizado CLP',24],['status','Estado',18],['issues','Motivos de revisión',72],
];
const exportPart = part => ({...part,status:part.status==='review'?'Revisar':'Sin alertas',issues:part.issues.join('\n')});
const makeBook = () => { const book=new ExcelJS.Workbook(); book.creator='Revisión de cotizaciones'; return book; };
export async function createQuotationReports(result) {
  const parts=makeBook(), review=makeBook(), summary=makeBook();
  addSheet(parts,'Repuestos',partColumns,result.parts.map(exportPart));
  addSheet(parts,'Faltantes declarados',partColumns,result.shortages.map(exportPart));
  addSheet(parts,'Cómo usar', [['note','Nota',110]], [
    {note:'Solo se muestran faltantes positivos ya declarados en FALTA. Una celda vacía no significa cero ni disponibilidad confirmada.'},
    {note:'Revisa las alertas antes de comprar. Este informe no modifica inventario, precios ni el archivo original.'},
  ]);
  const issueColumns=[['severity','Nivel',14],['sheet','Hoja',30],['cell','Celda',12],['code','Código',30],['message','Qué revisar',90],['stored_value','Valor guardado',28],['expected_value','Valor comprobado',28]];
  addSheet(review,'Alertas',issueColumns,result.issues.length ? result.issues : [{severity:'NO_ROWS',message:'No se encontraron alertas con las comprobaciones compatibles. Esto no confirma precios comerciales ni disponibilidad.'}]);
  addSheet(summary,'Motores',[
    ['sheet','Hoja',30],['engine','Motor',22],['serial','Serie',24],['part_records','Repuestos',16],
    ['review_records','Repuestos con alertas',24],['shortage_records','Líneas con falta declarada',28],
    ['reported_shortage_units','Unidades con falta declarada',30],['unspecified_shortage_records','Falta no especificada',24],
    ['quoted_net_clp','Neto cotizado CLP',24],['quoted_vat_clp','IVA guardado CLP',24],['quoted_total_clp','Total guardado CLP',24],
  ],result.engines);
  addSheet(summary,'Importes del archivo',[
    ['label','Concepto',64],['value','Importe guardado CLP',26],['source_sheet','Hoja',30],['source_cell','Celda',14],['status','Estado',16],
  ],result.totals.map(total=>({...total,status:total.status==='review'?'Revisar':'Sin alertas'})));
  addSheet(summary,'Lectura', [['label','Concepto',42],['value','Valor / explicación',110]], [
    {label:'Repuestos',value:result.summary.part_records},
    {label:'Repuestos con alertas',value:result.summary.review_records},
    {label:'Alertas en todo el libro',value:result.summary.issue_count},
    {label:'Fórmulas guardadas',value:result.summary.formula_cells},
    {label:'Fórmulas no verificadas',value:result.summary.formula_unverified_cells},
    {label:'Neto cotizado de repuestos CLP',value:result.summary.parts_net_clp},
    {label:'Importes originales',value:'Los importes son valores guardados en el libro, incluidos los que tienen alertas. No constituyen un total validado para cobro.'},
    {label:'Comprobación de fórmulas',value:'Se contrastan fórmulas compatibles con sus valores guardados. No se ejecuta Excel ni se reemplazan los importes.'},
    {label:'IVA y descuentos',value:'Se leen los ya presentes en la cotización. No se agregan tasas, cargos ni descuentos nuevos.'},
    {label:'Datos faltantes',value:'Las celdas vacías permanecen vacías. No se inventan valores; una FALTA vacía significa no especificada.'},
  ]);
  const reports={};
  for(const [filename,book] of [['repuestos.xlsx',parts],['revision.xlsx',review],['resumen.xlsx',summary]]) reports[filename]=Buffer.from(await book.xlsx.writeBuffer());
  return reports;
}

// Fictional, reusable example. No customer information is shipped with the app.
export async function quotationSample() {
  const book=makeBook();
  for(const [index,name] of ['Motor DEMO-A','Motor DEMO-B'].entries()) {
    const sheet=book.addWorksheet(name);
    sheet.getCell('E5').value='COTIZACIÓN DE EJEMPLO — DATOS FICTICIOS';
    sheet.getCell('E8').value='MOTOR'; sheet.getCell('F8').value=`DEMO-${index?'B':'A'}`;
    sheet.getCell('E9').value='SERIE'; sheet.getCell('F9').value=`FICTICIA-${index+1}`;
    ['Grupo','ITEM','CANT','FALTA','NUMERO PARTE','DESCRIPCION','P.UNITARIO','TOTAL $'].forEach((v,i)=>{sheet.getRow(17).getCell(i+5).value=v;});
    const rows=[['Filtros',1,2,1,'DEMO-001','Filtro de ejemplo',1250.5],['Sellos',2,3,null,'DEMO-002','Sello de ejemplo',750],['Varios',3,1,0,'DEMO-003','Pieza de ejemplo',0]];
    rows.forEach((row,i)=>{ row.forEach((v,j)=>{sheet.getRow(18+i).getCell(5+j).value=v;}); sheet.getCell(`L${18+i}`).value={formula:`G${18+i}*K${18+i}`,result:row[2]*row[6]}; });
    sheet.getCell('J22').value='TOTAL NETO'; sheet.getCell('L22').value={formula:'SUM(L18:L20)',result:4751};
    sheet.getCell('J23').value='IVA'; sheet.getCell('L23').value={formula:'L22*19%',result:902.69};
    sheet.getCell('J24').value='TOTAL'; sheet.getCell('L24').value={formula:'L22+L23',result:5653.69};
    sheet.getColumn('J').width=40; for(const col of ['E','F','G','H','I','K','L']) sheet.getColumn(col).width=22;
    sheet.getRow(17).font={bold:true}; sheet.views=[{state:'frozen',ySplit:17}];
  }
  const sum=book.addWorksheet('RESUMEN');
  ['Serie','Reparación','Observacion Repuestos',null,'Total Neto','IVA','Total'].forEach((v,i)=>{sum.getRow(11).getCell(5+i).value=v;});
  for(const [index,name] of ['Motor DEMO-A','Motor DEMO-B'].entries()) {
    const row=12+index;
    sum.getCell(`E${row}`).value=`FICTICIA-${index+1}`; sum.getCell(`F${row}`).value=name;
    for(const [col,source,value] of [['I','L22',4751],['J','L23',902.69],['K','L24',5653.69]]) sum.getCell(`${col}${row}`).value={formula:`'${name}'!${source}`,result:value};
  }
  sum.getCell('J15').value='TOTAL REPUESTOS'; sum.getCell('K15').value={formula:'SUM(K12:K13)',result:11307.38};
  sum.getColumn('F').width=30; for(const col of ['E','G','I','J','K'])sum.getColumn(col).width=24;
  return Buffer.from(await book.xlsx.writeBuffer());
}
