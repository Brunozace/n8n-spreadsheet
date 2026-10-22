// Dependency-free validation core, shared with both n8n Code nodes.
export function processSales(rows) {
  const headers = ['transaction_id', 'product', 'quantity', 'unit_price_clp'];
  if (!Array.isArray(rows) || !rows.length || rows.every(r => !Object.keys(r || {}).length)) {
    throw new Error('No sales rows found. Use the Sales sheet with headers in row 1.');
  }
  if (rows.length > 10000) throw new Error('Starter limit: 10,000 rows per file.');
  const keys = new Set(rows.flatMap(r => Object.keys(r || {})));
  const missing = headers.filter(h => !keys.has(h));
  if (missing.length) throw new Error('Missing column(s): ' + missing.join(', '));
  const text = v => typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : '';
  const integer = v => {
    if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
    if (typeof v !== 'string' || !/^-?\d+$/.test(v.trim())) return null;
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : null;
  };
  const counts = new Map();
  for (const row of rows) {
    const id = text(row.transaction_id).toUpperCase();
    if (id) counts.set(id, (counts.get(id) || 0) + 1);
  }
  const valid = [], review = [];
  let total = 0;
  rows.forEach((row, i) => {
    const id = text(row.transaction_id), product = text(row.product);
    const quantity = integer(row.quantity), price = integer(row.unit_price_clp);
    const issues = [];
    if (!id) issues.push('Missing or invalid transaction ID');
    if (id && counts.get(id.toUpperCase()) > 1) issues.push('Duplicate transaction ID: review all occurrences');
    if (!product) issues.push('Missing or invalid product');
    if (quantity === null || quantity <= 0) issues.push('Quantity must be a positive whole number');
    if (price === null || price < 0) issues.push('Price must be a nonnegative whole CLP amount');
    const lineTotal = quantity !== null && price !== null ? quantity * price : null;
    if (lineTotal !== null && !Number.isSafeInteger(lineTotal)) issues.push('Line total exceeds safe integer range');
    // Input record ordinal, not Excel row number: extraction may skip empty rows.
    if (issues.length) review.push({input_record: i + 1, transaction_id: id, issues: issues.join('; '), original_row_json: JSON.stringify(row)});
    else {
      if (!Number.isSafeInteger(total + lineTotal)) throw new Error('Total exceeds safe integer range. No report produced.');
      total += lineTotal;
      valid.push({input_record: i + 1, transaction_id: id, product, quantity, unit_price_clp: price, line_total_clp: lineTotal});
    }
  });
  return {valid, review, summary: {
    input_records: rows.length, valid_records: valid.length, review_records: review.length,
    valid_sales_total_clp: total, currency: 'CLP',
    status: review.length ? 'INCOMPLETE: review rows excluded from total' : 'COMPLETE',
    calculation: 'quantity x unit_price_clp; no tax, discounts or refunds added'
  }};
}
