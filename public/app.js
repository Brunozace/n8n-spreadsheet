'use strict';

const byId = id => document.getElementById(id);
const integers = new Intl.NumberFormat('es-CL');
const pesos = new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 });
const PAGE_SIZE = 20;
const issueTranslations = new Map([
  ['Missing or invalid transaction ID', 'Falta el identificador de la venta o su formato no es válido.'],
  ['Duplicate transaction ID: review all occurrences', 'Identificador duplicado: revisa todas sus apariciones en este archivo.'],
  ['Missing or invalid product', 'Falta el producto o su formato no es válido.'],
  ['Quantity must be a positive whole number', 'La cantidad debe ser un número entero mayor que cero.'],
  ['Price must be a nonnegative whole CLP amount', 'El precio debe ser un monto entero en CLP, igual o mayor que cero. No puede estar vacío.'],
  ['Line total exceeds safe integer range', 'El total de esta venta supera el rango numérico permitido.']
]);
let session = null;
let currentResult = null;
let page = 0;
let selectedFile = null;
let processing = false;
let expiryTimer = null;

function showError(id, message) {
  const element = byId(id);
  element.textContent = message;
  element.hidden = false;
  if (element.hasAttribute('tabindex')) element.focus();
}

function hideMessage(id) {
  byId(id).hidden = true;
  byId(id).textContent = '';
}

async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  let data;
  try { data = await response.json(); } catch {
    throw new Error('El servicio no entregó una respuesta válida. Inténtalo nuevamente.');
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
    byId('sales-file').value = '';
    updateSelectedFile();
    return;
  }
  const mb = (session.maxUploadBytes || 5 * 1024 * 1024) / (1024 * 1024);
  byId('file-limits').textContent = `Excel .xlsx · Hasta ${integers.format(mb)} MB · 10.000 registros`;
  document.querySelectorAll('.ttl-minutes').forEach(element => { element.textContent = integers.format(session.resultTtlMinutes || 15); });
}

function clearResult() {
  currentResult = null;
  page = 0;
  clearInterval(expiryTimer);
  expiryTimer = null;
  byId('results').hidden = true;
  byId('review-body').replaceChildren();
  for (const kind of ['valid', 'review', 'summary', 'original']) byId(`download-${kind}`).removeAttribute('href');
}

function updateSelectedFile() {
  const label = byId('selected-file');
  label.textContent = selectedFile ? `${selectedFile.name} · ${integers.format(Math.ceil(selectedFile.size / 1024))} KB` : 'Ningún archivo seleccionado';
  label.classList.toggle('has-file', Boolean(selectedFile));
}

function setProcessing(value) {
  processing = value;
  byId('upload-button').disabled = value;
  byId('sales-file').disabled = value;
  byId('logout').disabled = value;
  byId('upload-spinner').hidden = !value;
  byId('upload-button-arrow').hidden = value;
  byId('upload-button-text').textContent = value ? 'Revisando tu planilla…' : 'Revisar planilla';
  byId('upload-form').setAttribute('aria-busy', String(value));
}

function safeDownloadUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) throw new Error('No pudimos obtener los enlaces de descarga. Vuelve a intentarlo.');
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error('El enlace de descarga no es válido.');
  return url.pathname + url.search;
}

function displayValue(value) {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function valueNode(value, className) {
  const node = document.createElement('span');
  const text = displayValue(value);
  node.className = text === null ? 'cell-missing' : (className || '');
  node.textContent = text === null ? 'Vacío' : text;
  return node;
}

function renderReview() {
  const rows = currentResult.review;
  const start = page * PAGE_SIZE;
  const fragment = document.createDocumentFragment();
  for (const row of rows.slice(start, start + PAGE_SIZE)) {
    let original = {};
    try { original = JSON.parse(row.original_row_json) || {}; } catch { /* Keep missing data visibly empty. */ }
    const tr = document.createElement('tr');
    const ordinal = document.createElement('td');
    ordinal.dataset.label = 'Registro';
    ordinal.textContent = String(row.input_record);
    const identity = document.createElement('td');
    identity.dataset.label = 'ID / Producto';
    identity.append(valueNode(original.transaction_id, 'cell-id'), valueNode(original.product, 'cell-product'));
    const quantity = document.createElement('td');
    quantity.dataset.label = 'Cantidad';
    quantity.append(valueNode(original.quantity));
    const price = document.createElement('td');
    price.dataset.label = 'Precio CLP';
    price.append(valueNode(original.unit_price_clp));
    const issues = document.createElement('td');
    issues.dataset.label = 'Motivo de revisión';
    const list = document.createElement('ul');
    list.className = 'issue-list';
    for (const issue of String(row.issues || '').split('; ').filter(Boolean)) {
      const item = document.createElement('li');
      item.textContent = issueTranslations.get(issue) || issue;
      list.append(item);
    }
    issues.append(list);
    tr.append(ordinal, identity, quantity, price, issues);
    fragment.append(tr);
  }
  byId('review-body').replaceChildren(fragment);
  byId('review-count').textContent = `${integers.format(rows.length)} ${rows.length === 1 ? 'registro' : 'registros'}`;
  byId('review-empty').hidden = rows.length !== 0;
  byId('review-table-wrap').hidden = rows.length === 0;
  byId('review-pagination').hidden = rows.length <= PAGE_SIZE;
  byId('previous-page').disabled = page === 0;
  byId('next-page').disabled = start + PAGE_SIZE >= rows.length;
  byId('page-info').textContent = rows.length ? `${integers.format(start + 1)}–${integers.format(Math.min(start + PAGE_SIZE, rows.length))} de ${integers.format(rows.length)} registros` : '';
}

function renderResult(result, filename) {
  const summary = result?.summary;
  if (!result?.id || !summary || !Array.isArray(result.review) || !['input_records', 'valid_records', 'review_records', 'valid_sales_total_clp'].every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0) || result.review.length !== summary.review_records || summary.input_records !== summary.valid_records + summary.review_records || !Number.isFinite(Date.parse(result.expiresAt))) {
    throw new Error('No recibimos un resultado completo. La revisión no se considera finalizada. Inténtalo nuevamente.');
  }
  const links = {};
  for (const kind of ['valid', 'review', 'summary', 'original']) links[kind] = safeDownloadUrl(result.downloads?.[kind]);
  currentResult = result;
  page = 0;
  byId('metric-input').textContent = integers.format(summary.input_records);
  byId('metric-valid').textContent = integers.format(summary.valid_records);
  byId('metric-review').textContent = integers.format(summary.review_records);
  byId('metric-total').textContent = pesos.format(summary.valid_sales_total_clp);
  byId('result-filename').textContent = `Archivo revisado: ${filename}`;
  byId('result-status').textContent = summary.review_records ? 'Con registros por revisar' : 'Todos los registros válidos';
  byId('result-status').classList.toggle('needs-review', summary.review_records > 0);
  for (const kind of ['valid', 'review', 'summary', 'original']) byId(`download-${kind}`).href = links[kind];
  byId('download-original').download = filename;
  const expiry = new Date(result.expiresAt);
  byId('expires-notice').textContent = `Descarga tus archivos antes del ${expiry.toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' })} (hora de tu dispositivo). Después se eliminarán automáticamente.`;
  renderReview();
  byId('results').hidden = false;
  expiryTimer = setInterval(() => {
    if (Date.now() >= expiry.getTime()) {
      clearResult();
      hideMessage('upload-status');
      byId('deletion-notice').textContent = 'El tiempo de descarga terminó. Los archivos y resultados temporales ya no están disponibles. Puedes volver a subir la planilla para revisarla otra vez.';
      byId('deletion-notice').hidden = false;
    }
  }, 1000);
  byId('results-title').focus({ preventScroll: true });
  byId('results').scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
}

byId('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  hideMessage('login-error');
  byId('login-button').disabled = true;
  const password = byId('password').value;
  try {
    const data = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: byId('username').value, password }) });
    setSession(data);
    byId('sales-file').focus();
  } catch (error) {
    showError('login-error', error instanceof TypeError ? 'No pudimos conectar con el servicio. Revisa tu conexión e inténtalo nuevamente.' : error.message);
  } finally {
    byId('password').value = '';
    byId('login-button').disabled = false;
  }
});

byId('logout').addEventListener('click', async () => {
  if (processing) return;
  try {
    await request('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken } });
    setSession(null);
    hideMessage('upload-error');
    hideMessage('upload-status');
    hideMessage('deletion-notice');
    byId('username').focus();
  } catch (error) { showError('upload-error', error.message); }
});

byId('sales-file').addEventListener('change', event => {
  selectedFile = event.target.files[0] || null;
  updateSelectedFile();
  hideMessage('upload-error');
});

for (const name of ['dragenter', 'dragover']) byId('drop-zone').addEventListener(name, event => {
  event.preventDefault();
  if (!processing) byId('drop-zone').classList.add('drag-over');
});
for (const name of ['dragleave', 'drop']) byId('drop-zone').addEventListener(name, event => {
  event.preventDefault();
  byId('drop-zone').classList.remove('drag-over');
});
byId('drop-zone').addEventListener('drop', event => {
  if (processing) return;
  if (event.dataTransfer.files.length !== 1) return showError('upload-error', 'Selecciona un solo archivo .xlsx por revisión.');
  selectedFile = event.dataTransfer.files[0];
  byId('sales-file').files = event.dataTransfer.files;
  updateSelectedFile();
  hideMessage('upload-error');
});

byId('upload-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (processing || !session) return;
  hideMessage('upload-error');
  hideMessage('upload-status');
  hideMessage('deletion-notice');
  if (!selectedFile) return showError('upload-error', 'Selecciona una planilla .xlsx para continuar.');
  if (!/\.xlsx$/i.test(selectedFile.name)) return showError('upload-error', 'Solo se aceptan archivos Excel .xlsx. No se aceptan CSV, XLS ni archivos con macros.');
  if (!selectedFile.size) return showError('upload-error', 'El archivo está vacío. Selecciona una planilla con datos.');
  if (selectedFile.size > (session.maxUploadBytes || 5 * 1024 * 1024)) return showError('upload-error', `El archivo supera el límite de ${integers.format((session.maxUploadBytes || 5 * 1024 * 1024) / (1024 * 1024))} MB. Divide los datos en archivos más pequeños.`);
  const priorId = currentResult?.id;
  clearResult();
  const file = selectedFile;
  setProcessing(true);
  byId('upload-status').textContent = 'Estamos validando y procesando tu archivo. Espera hasta ver los resultados; recibir el archivo no significa que la revisión esté completa.';
  byId('upload-status').hidden = false;
  try {
    if (priorId) await request(`/api/results/${encodeURIComponent(priorId)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': session.csrfToken } }).catch(() => {});
    const result = await request('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-Filename': encodeURIComponent(file.name), 'X-CSRF-Token': session.csrfToken },
      body: file
    });
    renderResult(result, file.name);
    byId('upload-status').textContent = 'Revisión completada. Tus resultados y los tres reportes están disponibles abajo.';
  } catch (error) {
    hideMessage('upload-status');
    clearResult();
    const message = error instanceof TypeError ? 'Se perdió la conexión con el servicio. No podemos confirmar que la revisión haya terminado. Inténtalo nuevamente.' : error.message;
    if (session) showError('upload-error', message);
    else showError('login-error', 'Tu sesión terminó. Vuelve a ingresar para revisar tu planilla.');
  } finally { setProcessing(false); }
});

byId('previous-page').addEventListener('click', () => { if (currentResult && page > 0) { page--; renderReview(); } });
byId('next-page').addEventListener('click', () => { if (currentResult && (page + 1) * PAGE_SIZE < currentResult.review.length) { page++; renderReview(); } });

byId('delete-results').addEventListener('click', async () => {
  if (!currentResult || !session) return;
  byId('delete-results').disabled = true;
  try {
    await request(`/api/results/${encodeURIComponent(currentResult.id)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': session.csrfToken } });
    clearResult();
    hideMessage('upload-status');
    byId('deletion-notice').textContent = 'Los archivos y resultados de esta revisión se eliminaron del servicio. Las copias que descargaste siguen en tu dispositivo.';
    byId('deletion-notice').hidden = false;
    byId('sales-file').focus();
  } catch (error) { showError('upload-error', error.message); }
  finally { byId('delete-results').disabled = false; }
});

request('/api/session').then(setSession).catch(error => {
  setSession(null);
  showError('login-error', error instanceof TypeError ? 'No pudimos conectar con el servicio. Revisa tu conexión e inténtalo nuevamente.' : error.message);
});
