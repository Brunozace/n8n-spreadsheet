/** Synthetic quotation only; never copy customer workbook content into fixtures. */
export function createQuotationFixture() {
  const sheet = { name: 'Motor DEMO', cells: [], merges: [] };
  const summary = { name: 'RESUMEN', cells: [], merges: [] };
  const put = (target, address, value, formula) => {
    const [, letters, row] = /^([A-Z]+)(\d+)$/.exec(address);
    const column = [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
    target.cells.push({ address, row: Number(row), column, value, ...(formula ? { formula, hasCachedValue: value !== null, formulaType: 'normal' } : {}) });
  };
  put(sheet, 'E12', 'Motor:'); put(sheet, 'F12', 'DEMO-1');
  put(sheet, 'E13', 'Serie:'); put(sheet, 'F13', 'SYNTHETIC-1');
  ['Grupo', 'ITEM', 'CANTIDAD', 'FALTA', 'NUMERO PARTE', 'DESCRIPCION', 'P.UNITARIO', 'TOTAL $'].forEach((value, i) => put(sheet, `${String.fromCharCode(69 + i)}17`, value));
  const details = [
    ['Filtros', 1, 2, 1, 'DEMO-A', 'Filtro de ejemplo', 1250.25, 2500.5],
    ['Sellos', 2, 3, null, 'DEMO-B', 'Sello de ejemplo', 400, 1200],
    ['Sellos', 3, 1, 0, 'DEMO-B', 'Sello de ejemplo repetido', 400, 400],
  ];
  details.forEach((values, i) => values.forEach((v, col) => {
    const row = 18 + i;
    put(sheet, `${String.fromCharCode(69 + col)}${row}`, v, col === 6 ? `VLOOKUP(I${row},$K$30:$L$32,2,FALSE)` : col === 7 ? `G${row}*K${row}` : undefined);
  }));
  put(sheet, 'J22', 'TOTAL NETO'); put(sheet, 'L22', 4100.5, 'SUM(L18:L21)');
  put(sheet, 'J23', 'IVA'); put(sheet, 'L23', 779.095, 'L22*19%');
  put(sheet, 'J24', 'TOTAL'); put(sheet, 'L24', 4879.595, 'L22+L23');
  put(sheet, 'K30', 'nombre de la pieza'); put(sheet, 'L30', 'Venta');
  put(sheet, 'K31', 'DEMO-A'); put(sheet, 'L31', 1250.25);
  put(sheet, 'K32', 'DEMO-B'); put(sheet, 'L32', 400);
  ['Serie', '', 'Reparación', 'Observación Repuestos', 'Total Neto', 'IVA', 'Total'].forEach((v, i) => put(summary, `${String.fromCharCode(69 + i)}11`, v));
  put(summary, 'E12', 'SYNTHETIC-1'); put(summary, 'G12', 'Mantención');
  put(summary, 'I12', 4100.5, "'Motor DEMO'!L22");
  put(summary, 'J12', 779.095, 'I12*0.19'); put(summary, 'K12', 4879.595, 'I12+J12');
  put(summary, 'J15', 'Total Repuestos'); put(summary, 'K15', 4879.595, 'SUM(K12:K14)');
  ['Serie', '', 'Mantención', 'Observación Servicio', 'Total Neto', 'Descuento', 'Total'].forEach((v, i) => put(summary, `${String.fromCharCode(69 + i)}19`, v));
  put(summary, 'E20', 'SYNTHETIC-1'); put(summary, 'I20', 1000.5);
  put(summary, 'J20', -50.025, '-(I20*5%)'); put(summary, 'K20', 950.475, 'I20+J20');
  put(summary, 'J23', 'Total Neto'); put(summary, 'K23', 950.475, 'SUM(K20:K22)');
  put(summary, 'J24', 'IVA'); put(summary, 'K24', 180.59025, 'K23*0.19');
  put(summary, 'J25', 'Total Servicio'); put(summary, 'K25', 1131.06525, 'K23+K24');
  return { sheets: [sheet, summary], calculation: { mode: 'auto', fullCalcOnLoad: false, forceFullCalc: false } };
}

export function fixtureCell(workbook, sheet, address) {
  const target = typeof sheet === 'number' ? workbook.sheets[sheet] : workbook.sheets.find(s => s.name === sheet);
  return target.cells.find(cell => cell.address === address);
}

export async function createQuotationXlsx(input = createQuotationFixture()) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  for (const source of input.sheets) {
    const sheet = workbook.addWorksheet(source.name);
    for (const cell of source.cells) sheet.getCell(cell.address).value = cell.formula ? { formula: cell.formula, result: cell.value } : cell.value;
    for (const merge of source.merges || []) sheet.mergeCells(merge);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
