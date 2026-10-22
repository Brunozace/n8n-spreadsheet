import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Build only the protected web workflow. The two practice workflows stay untouched.
const root = new URL('../', import.meta.url);
const source = await readFile(new URL('core.mjs', root), 'utf8');
const core = source.slice(source.indexOf('export function processSales')).replace('export function', 'function').trim();
if (!core.startsWith('function processSales(rows)')) throw new Error('Unexpected core.mjs format');

const workflow = {
  id: 'salesWebPilotV1',
  name: '03 - Protected sales web pilot',
  active: false,
  nodes: [
    {
      id: 'bed60357-9916-46df-b945-603e28243be2',
      name: 'Private website request',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.2,
      position: [0, 240],
      webhookId: '37d6d8d5-0a83-46e5-974c-983229dbdc3c',
      parameters: {
        httpMethod: 'POST', path: 'sales-web', authentication: 'headerAuth',
        responseMode: 'responseNode', options: {},
      },
      notes: 'Bind a Header Auth credential: Name X-Pilot-Key; Value must match N8N_WEBHOOK_SECRET. No credential or secret is included in this export. Keep the n8n editor private.',
      notesInFlow: true,
    },
    {
      id: 'fb10e1c2-5d11-4341-9486-3ef49b61b487',
      name: 'Check sales',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [320, 240],
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: `${core}\n\nconst body = $input.first().json.body;\nif (!body || typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(body.requestId) || !Array.isArray(body.rows) || body.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {\n  throw new Error('Invalid website request');\n}\nreturn [{ json: { requestId: body.requestId, result: processSales(body.rows) } }];`,
      },
      notes: 'processSales is copied unchanged from core.mjs. Duplicate checks apply only within this upload.',
    },
    {
      id: 'cff98327-3f16-47dd-873b-e5331c3d1261',
      name: 'Return completed results',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.5,
      position: [640, 240],
      parameters: {
        respondWith: 'firstIncomingItem',
        options: {
          responseCode: 200, enableStreaming: false,
          responseHeaders: { entries: [{ name: 'Cache-Control', value: 'no-store' }] },
        },
      },
    },
  ],
  connections: {
    'Private website request': { main: [[{ node: 'Check sales', type: 'main', index: 0 }]] },
    'Check sales': { main: [[{ node: 'Return completed results', type: 'main', index: 0 }]] },
  },
  settings: {
    executionOrder: 'v1', executionTimeout: 60,
    saveDataErrorExecution: 'none', saveDataSuccessExecution: 'none',
    saveManualExecutions: false, saveExecutionProgress: false,
  },
  pinData: {}, tags: [],
};

await writeFile(new URL('03-web-upload.json', root), `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`Created ${fileURLToPath(new URL('03-web-upload.json', root))} (inactive, no credential bindings).`);
