'use strict';

const byId = id => document.getElementById(id);
const numbers = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 2 });
const amounts = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PAGE_SIZE = 20;
const DOWNLOAD_KINDS = ['parts', 'review', 'summary', 'original'];
let session = null;
let currentResult = null;
let selectedFile = null;
let processing = false;
let partsPage = 0;
let issuesPage = 0;
let expiryTimer = null;

function showMessage(id, message) {
  const element = byId(id);
  element.textContent = message;
  element.hidden = false;
  if (element.hasAttribute('tabindex')) element.focus({ preventScroll: true });
}

function hideMessage(id) {
  byId(id).hidden = true;
  byId(id).textContent = '';
}

function textValue(value) {
  if (value === null || value === undefined || value === '') return 'No especificado';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? numbers.format(value) : textValue(value);
}

function moneyValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? amounts.format(value) : textValue(value);
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  let data;
  try { data = await response.json(); } catch {
    throw new Error('El servicio no entregó una respuesta válida. No podemos confirmar que la revisión haya terminado. Inténtalo nuevamente.');
  }
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/login') setSession(null);
    throw new Error(typeof data.error === 'string' ? data.error : 'No pudimos completar la solicitud. Inténtalo nuevamente.');
  }
  return data;
}

function setSession(data) {
  session = data?.authenticated ? data : null;
  byId('session-loading').hidden = true;
  byId('login-section').hidden = Boolean(session);
  byId('workspace').hidden = !session;
  byId('logout').hidden = !session;
  if (!session) {
    clearResult();
    selectedFile = null;
    byId('quotation-file').value = '';
    updateSelectedFile();
    return;
  }
  const mb = (session.maxUploadBytes || 5 * 1024 * 1024) / (1024 * 1024);
  byId('file-limits').textContent = `Excel .xlsx · Hasta ${numbers.format(mb)} MB · 10.000 filas con contenido`;
  document.querySelectorAll('.ttl-minutes').forEach(element => { element.textContent = numbers.format(session.resultTtlMinutes || 15); });
}

function clearResult() {
  currentResult = null;
  partsPage = 0;
  issuesPage = 0;
  clearInterval(expiryTimer);
  expiryTimer = null;
  byId('results').hidden = true;
  for (const id of ['parts-body', 'issues-list', 'engine-cards', 'totals-list']) byId(id).replaceChildren();
  for (const kind of DOWNLOAD_KINDS) byId(`download-${kind}`).removeAttribute('href');
  byId('parts-search').value = '';
  byId('status-filter').value = 'all';
  byId('engine-filter').replaceChildren(new Option('Todos los motores', ''));
}

function updateSelectedFile() {
  byId('selected-file').textContent = selectedFile ? `${selectedFile.name} · ${numbers.format(Math.ceil(selectedFile.size / 1024))} KB` : 'Ningún archivo seleccionado';
  byId('selected-file').classList.toggle('has-file', Boolean(selectedFile));
}

function setProcessing(value) {
  processing = value;
  for (const id of ['upload-button', 'quotation-file', 'logout', 'delete-results']) byId(id).disabled = value;
  byId('upload-spinner').hidden = !value;
  byId('upload-button-arrow').hidden = value;
  byId('upload-button-text').textContent = value ? 'Leyendo y revisando tu cotización…' : 'Revisar cotización';
  byId('upload-form').setAttribute('aria-busy', String(value));
}

function safeDownloadUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) throw new Error('No recibimos los enlaces de descarga. La revisión no se considera completa.');
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/results/')) throw new Error('El enlace de descarga no es válido. Vuelve a subir la cotización.');
  return url.pathname + url.search;
}

function sourceLabel(sheet, cell) {
  return [sheet, cell].filter(value => value !== null && value !== undefined && value !== '').map(String).join(' · ') || 'Archivo';
}

function renderEngines() {
  const fragment = document.createDocumentFragment();
  for (const engine of currentResult.engines) {
    const card = node('article', 'engine-card');
    card.append(node('p', 'engine-sheet', textValue(engine.sheet)), node('h4', '', textValue(engine.engine)), node('p', 'engine-serial', `Serie: ${textValue(engine.serial)}`));
    const counts = node('dl', 'engine-counts');
    for (const [label, value, className] of [['Repuestos', engine.part_records, ''], ['Por revisar', engine.review_records, engine.review_records ? 'needs-review' : ''], ['Unidades faltantes', engine.reported_shortage_units, ''], ['Filas con faltantes', engine.shortage_records, '']]) {
      const entry = node('div');
      entry.append(node('dt', '', label), node('dd', className, numberValue(value)));
      counts.append(entry);
    }
    card.append(counts);
    const money = node('dl', 'engine-amounts');
    for (const [label, value] of [['Neto informado', engine.quoted_net_clp], ['IVA informado', engine.quoted_vat_clp], ['Total informado', engine.quoted_total_clp]]) {
      const entry = node('div');
      entry.append(node('dt', '', label), node('dd', '', moneyValue(value)));
      money.append(entry);
    }
    card.append(money);
    if (engine.unspecified_shortage_records) card.append(node('p', 'engine-unknown', `${numbers.format(engine.unspecified_shortage_records)} filas sin cantidad de faltantes especificada.`));
    fragment.append(card);
  }
  byId('engine-cards').replaceChildren(fragment);
}

function renderTotals() {
  const fragment = document.createDocumentFragment();
  for (const total of currentResult.totals) {
    const item = node('div', 'total-item');
    item.append(node('h4', '', textValue(total.label)), node('span', 'total-value', moneyValue(total.value)), node('span', 'total-source', sourceLabel(total.source_sheet, total.source_cell)));
    if (['review', 'unverified', 'error', 'missing'].includes(total.status)) item.append(node('span', 'total-review', 'Revisa los avisos de este importe.'));
    fragment.append(item);
  }
  byId('totals-list').replaceChildren(fragment);
  byId('totals-list').hidden = currentResult.totals.length === 0;
  byId('totals-empty').hidden = currentResult.totals.length !== 0;
}

function normalized(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es-CL');
}

function filteredParts() {
  if (!currentResult) return [];
  const search = normalized(byId('parts-search').value.trim());
  const sheet = byId('engine-filter').value;
  const status = byId('status-filter').value;
  return currentResult.parts.filter(part => {
    if (sheet && part.sheet !== sheet) return false;
    if (status === 'review' && part.status !== 'review') return false;
    if (status === 'shortages' && !(typeof part.reported_shortage === 'number' && part.reported_shortage > 0)) return false;
    return !search || normalized([part.part_number, part.description, part.group, part.item, part.sheet].map(textValue).join(' ')).includes(search);
  });
}

function tableCell(label) {
  const cell = node('td');
  cell.dataset.label = label;
  return cell;
}

function numericCell(label, value, currency = false) {
  const cell = tableCell(label);
  const missing = value === null || value === undefined || value === '';
  cell.append(node('span', missing ? 'cell-missing' : 'cell-number', currency ? moneyValue(value) : numberValue(value)));
  return cell;
}

function updatePagination(prefix, currentPage, count) {
  const start = currentPage * PAGE_SIZE;
  byId(`${prefix}-pagination`).hidden = count === 0;
  byId(`${prefix}-previous`).disabled = currentPage === 0;
  byId(`${prefix}-next`).disabled = start + PAGE_SIZE >= count;
  byId(`${prefix}-page-info`).textContent = count ? `${numbers.format(start + 1)}–${numbers.format(Math.min(start + PAGE_SIZE, count))} de ${numbers.format(count)}` : '';
}

function renderParts() {
  const parts = filteredParts();
  partsPage = Math.min(partsPage, Math.max(0, Math.ceil(parts.length / PAGE_SIZE) - 1));
  const fragment = document.createDocumentFragment();
  for (const part of parts.slice(partsPage * PAGE_SIZE, (partsPage + 1) * PAGE_SIZE)) {
    const row = node('tr');
    const origin = tableCell('Origen');
    origin.append(node('span', 'cell-source', textValue(part.sheet)), node('span', 'cell-secondary', `Fila ${textValue(part.row)} · Ítem ${textValue(part.item)}`));
    const identity = tableCell('Repuesto');
    identity.append(node('span', 'cell-id', textValue(part.part_number)), node('span', 'cell-description', textValue(part.description)));
    if (part.group) identity.append(node('span', 'cell-secondary', textValue(part.group)));
    const status = tableCell('Revisión de fila');
    status.append(node('span', `row-status${part.status === 'review' ? ' needs-review' : ''}`, part.status === 'review' ? 'Por revisar' : 'Sin avisos de fila'));
    if (part.issues.length) {
      const reasons = node('ul', 'issue-list');
      for (const issue of part.issues) reasons.append(node('li', '', textValue(issue)));
      status.append(reasons);
    }
    row.append(origin, identity, numericCell('Cantidad', part.quantity), numericCell('Falta', part.reported_shortage), numericCell('Unitario CLP', part.unit_price_clp, true), numericCell('Total CLP', part.line_total_clp, true), status);
    fragment.append(row);
  }
  byId('parts-body').replaceChildren(fragment);
  byId('parts-empty').hidden = parts.length !== 0;
  byId('parts-table-wrap').hidden = parts.length === 0;
  byId('parts-count').textContent = `${numbers.format(parts.length)} de ${numbers.format(currentResult.parts.length)}`;
  updatePagination('parts', partsPage, parts.length);
}

function renderIssues() {
  const issues = currentResult.issues;
  const fragment = document.createDocumentFragment();
  for (const issue of issues.slice(issuesPage * PAGE_SIZE, (issuesPage + 1) * PAGE_SIZE)) {
    const item = node('li');
    const location = node('div', 'issue-location', sourceLabel(issue.sheet, issue.cell));
    location.append(node('span', `issue-level${issue.severity === 'error' ? ' error' : ''}`, issue.severity === 'error' ? 'Requiere revisión' : 'Advertencia'));
    const description = node('div', 'issue-description');
    description.append(node('p', '', textValue(issue.message)));
    const values = node('div', 'issue-values');
    if (Object.hasOwn(issue, 'stored_value')) values.append(node('span', '', `Guardado en Excel: ${numberValue(issue.stored_value)}`));
    if (Object.hasOwn(issue, 'expected_value')) values.append(node('span', '', `Referencia de la comprobación: ${numberValue(issue.expected_value)}`));
    if (values.childElementCount) description.append(values);
    item.append(location, description);
    fragment.append(item);
  }
  byId('issues-list').replaceChildren(fragment);
  byId('issues-list').start = issuesPage * PAGE_SIZE + 1;
  byId('issues-count').textContent = `${numbers.format(issues.length)} avisos`;
  byId('issues-empty').hidden = issues.length !== 0;
  updatePagination('issues', issuesPage, issues.length);
}

function validateResult(result) {
  const summary = result?.summary;
  const countKeys = ['engine_count', 'part_records', 'review_records', 'shortage_records', 'unspecified_shortage_records', 'issue_count', 'formula_cells', 'formula_unverified_cells'];
  const complete = result?.kind === 'quotation' && typeof result.id === 'string' && summary && countKeys.every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0)
    && ['engines', 'parts', 'shortages', 'issues', 'totals'].every(key => Array.isArray(result[key]))
    && typeof summary.reported_shortage_units === 'number' && Number.isFinite(summary.reported_shortage_units) && summary.reported_shortage_units >= 0
    && (summary.parts_net_clp === null || (typeof summary.parts_net_clp === 'number' && Number.isFinite(summary.parts_net_clp)))
    && summary.engine_count === result.engines.length && summary.part_records === result.parts.length && summary.issue_count === result.issues.length && summary.shortage_records === result.shortages.length
    && summary.review_records === result.parts.filter(part => part.status === 'review').length
    && result.parts.every(part => part && Array.isArray(part.issues) && ['ok', 'review'].includes(part.status))
    && Number.isFinite(Date.parse(result.expiresAt)) && Date.parse(result.expiresAt) > Date.now();
  if (!complete) throw new Error('No recibimos un resultado completo. La revisión no se considera finalizada. Inténtalo nuevamente.');
  const links = {};
  for (const kind of DOWNLOAD_KINDS) links[kind] = safeDownloadUrl(result.downloads?.[kind]);
  return links;
}

function renderResult(result, filename) {
  const links = validateResult(result);
  currentResult = result;
  partsPage = 0;
  issuesPage = 0;
  const summary = result.summary;
  for (const [id, value] of [['engines', summary.engine_count], ['parts', summary.part_records], ['review', summary.review_records], ['shortages', summary.reported_shortage_units]]) byId(`metric-${id}`).textContent = numbers.format(value);
  byId('metric-net').textContent = moneyValue(summary.parts_net_clp);
  byId('result-filename').textContent = `Archivo leído: ${filename}`;
  byId('result-status').textContent = summary.issue_count ? `${numbers.format(summary.issue_count)} avisos para revisar` : 'Lectura sin avisos detectados';
  byId('result-status').classList.toggle('needs-review', summary.issue_count > 0);
  byId('formula-notice').textContent = summary.formula_cells
    ? `Se encontraron ${numbers.format(summary.formula_cells)} celdas con fórmulas; ${numbers.format(summary.formula_unverified_cells)} no se pudieron comprobar. Contrastamos las fórmulas compatibles con sus resultados guardados. Los importes originales se conservan; esto no reemplaza el recálculo en Excel.`
    : 'Los importes son los valores guardados en el archivo. Esta lectura no aprueba la cotización ni modifica tu planilla.';
  byId('shortage-notice').textContent = summary.unspecified_shortage_records
    ? `${numbers.format(summary.unspecified_shortage_records)} filas no especifican cuántas unidades faltan. No se cuentan como cero ni se incluyen en las unidades faltantes declaradas.`
    : 'Las unidades faltantes declaradas solo incluyen cantidades expresamente informadas y válidas en FALTA.';
  for (const kind of DOWNLOAD_KINDS) byId(`download-${kind}`).href = links[kind];
  byId('download-original').download = filename;
  const options = document.createDocumentFragment();
  options.append(new Option('Todos los motores', ''));
  for (const engine of result.engines) options.append(new Option(`${engine.sheet}${engine.engine && engine.engine !== engine.sheet ? ` · ${engine.engine}` : ''}`, engine.sheet));
  byId('engine-filter').replaceChildren(options);
  renderEngines();
  renderTotals();
  renderParts();
  renderIssues();
  const expiry = new Date(result.expiresAt);
  byId('expires-notice').textContent = `Descarga los archivos antes del ${expiry.toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })} (hora de tu dispositivo). Después dejarán de estar disponibles.`;
  clearInterval(expiryTimer);
  expiryTimer = setInterval(() => {
    if (Date.now() >= expiry.getTime()) {
      clearResult();
      hideMessage('upload-status');
      showMessage('deletion-notice', 'Terminó el tiempo de descarga. Los archivos y resultados temporales ya no están disponibles. Puedes volver a subir la cotización.');
    }
  }, 1000);
  byId('results').hidden = false;
  byId('results-title').focus({ preventScroll: true });
  byId('results').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
}

byId('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  hideMessage('login-error');
  byId('login-button').disabled = true;
  try {
    const data = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: byId('username').value, password: byId('password').value }) });
    setSession(data);
    byId('quotation-file').focus();
  } catch (error) {
    showMessage('login-error', error instanceof TypeError ? 'No pudimos conectar con el servicio. Revisa tu conexión e inténtalo nuevamente.' : error.message);
  } finally {
    byId('password').value = '';
    byId('login-button').disabled = false;
  }
});

byId('logout').addEventListener('click', async () => {
  if (processing || !session) return;
  byId('logout').disabled = true;
  try {
    await request('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken } });
    setSession(null);
    for (const id of ['upload-error', 'upload-status', 'deletion-notice']) hideMessage(id);
    byId('username').focus();
  } catch (error) { showMessage('upload-error', error.message); }
  finally { byId('logout').disabled = false; }
});

byId('quotation-file').addEventListener('change', event => {
  selectedFile = event.target.files[0] || null;
  updateSelectedFile();
  hideMessage('upload-error');
});

for (const eventName of ['dragenter', 'dragover']) byId('drop-zone').addEventListener(eventName, event => {
  event.preventDefault();
  if (!processing) byId('drop-zone').classList.add('drag-over');
});
for (const eventName of ['dragleave', 'drop']) byId('drop-zone').addEventListener(eventName, event => {
  event.preventDefault();
  byId('drop-zone').classList.remove('drag-over');
});
byId('drop-zone').addEventListener('drop', event => {
  if (processing) return;
  if (event.dataTransfer.files.length !== 1) return showMessage('upload-error', 'Selecciona un solo archivo .xlsx por revisión.');
  selectedFile = event.dataTransfer.files[0];
  byId('quotation-file').files = event.dataTransfer.files;
  updateSelectedFile();
  hideMessage('upload-error');
});

byId('upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (processing || !session) return;
  for (const id of ['upload-error', 'upload-status', 'deletion-notice']) hideMessage(id);
  if (!selectedFile) return showMessage('upload-error', 'Selecciona una cotización .xlsx para continuar.');
  if (!/\.xlsx$/i.test(selectedFile.name)) return showMessage('upload-error', 'Solo se aceptan archivos Excel .xlsx. No se aceptan XLS, CSV ni archivos con macros.');
  if (!selectedFile.size) return showMessage('upload-error', 'El archivo está vacío. Selecciona una cotización con datos.');
  if (selectedFile.size > (session.maxUploadBytes || 5 * 1024 * 1024)) return showMessage('upload-error', `El archivo supera el límite de ${numbers.format((session.maxUploadBytes || 5 * 1024 * 1024) / (1024 * 1024))} MB.`);
  const priorId = currentResult?.id;
  clearResult();
  const file = selectedFile;
  const csrfToken = session.csrfToken;
  setProcessing(true);
  showMessage('upload-status', 'Estamos leyendo las hojas y revisando los datos. Espera a ver los resultados: recibir el archivo no significa que la revisión esté completa.');
  try {
    if (priorId) await request(`/api/results/${encodeURIComponent(priorId)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } }).catch(() => {});
    if (!session) throw new Error('Tu sesión terminó. Vuelve a ingresar.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 125000);
    let result;
    try {
      result = await request('/api/quotation/upload', { method: 'POST', headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-Filename': encodeURIComponent(file.name), 'X-CSRF-Token': csrfToken }, body: file, signal: controller.signal });
    } finally { clearTimeout(timeout); }
    renderResult(result, file.name);
    showMessage('upload-status', 'Lectura completada. Los reportes están disponibles abajo; revisa los avisos antes de usar los importes.');
  } catch (error) {
    hideMessage('upload-status');
    clearResult();
    const message = error.name === 'AbortError' ? 'La revisión demoró más de lo esperado. No podemos confirmar que haya terminado. Inténtalo nuevamente.' : error instanceof TypeError ? 'Se perdió la conexión con el servicio. No podemos confirmar que la revisión haya terminado. Inténtalo nuevamente.' : error.message;
    if (session) showMessage('upload-error', message);
    else showMessage('login-error', 'Tu sesión terminó. Vuelve a ingresar para revisar la cotización.');
  } finally { setProcessing(false); }
});

for (const id of ['parts-search', 'engine-filter', 'status-filter']) byId(id).addEventListener(id === 'parts-search' ? 'input' : 'change', () => {
  if (!currentResult) return;
  partsPage = 0;
  renderParts();
});
byId('parts-previous').addEventListener('click', () => { if (currentResult && partsPage > 0) { partsPage--; renderParts(); } });
byId('parts-next').addEventListener('click', () => { if (currentResult && (partsPage + 1) * PAGE_SIZE < filteredParts().length) { partsPage++; renderParts(); } });
byId('issues-previous').addEventListener('click', () => { if (currentResult && issuesPage > 0) { issuesPage--; renderIssues(); } });
byId('issues-next').addEventListener('click', () => { if (currentResult && (issuesPage + 1) * PAGE_SIZE < currentResult.issues.length) { issuesPage++; renderIssues(); } });

byId('delete-results').addEventListener('click', async () => {
  if (!currentResult || !session || processing) return;
  const resultId = currentResult.id;
  setProcessing(true);
  byId('upload-button-text').textContent = 'Eliminando archivos…';
  try {
    await request(`/api/results/${encodeURIComponent(resultId)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': session.csrfToken } });
    clearResult();
    hideMessage('upload-status');
    showMessage('deletion-notice', 'Los archivos y resultados de esta revisión se eliminaron del servicio. Las copias descargadas siguen en tu dispositivo.');
    byId('quotation-file').focus();
  } catch (error) { showMessage('upload-error', error.message); }
  finally { setProcessing(false); }
});

request('/api/session').then(setSession).catch(error => {
  setSession(null);
  showMessage('login-error', error instanceof TypeError ? 'No pudimos conectar con el servicio. Revisa tu conexión e inténtalo nuevamente.' : error.message);
});
