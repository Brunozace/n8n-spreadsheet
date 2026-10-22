import { readFile } from 'node:fs/promises';
import { RUNTIME_FILE, run, startDisposableN8n, stopDisposableN8n } from './start-test-n8n.mjs';

const keep = process.argv.includes('--keep');
const reuse = process.argv.includes('--reuse');
let runtime;
let stopping = false;

async function cleanup() {
  if (!runtime || stopping) return;
  stopping = true;
  await stopDisposableN8n(runtime);
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    try { await cleanup(); } finally { process.exit(130); }
  });
}

try {
  runtime = reuse ? JSON.parse(await readFile(RUNTIME_FILE, 'utf8')) : await startDisposableN8n();
  console.log('Running HTTP upload/download checks against a real, disposable n8n instance.');
  await run(process.execPath, ['--test', 'tests/pipeline.test.mjs','tests/quotation-pipeline.test.mjs'], {
    env: { ...process.env, N8N_TEST_WEBHOOK_URL: runtime.url, N8N_TEST_QUOTATION_WEBHOOK_URL: runtime.quotationUrl, N8N_TEST_WEBHOOK_SECRET: runtime.secret },
    stdio: 'inherit',
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (runtime && keep && !process.exitCode) {
    console.log('Disposable runtime retained for local browser checks. Private configuration: .test-runtime/runtime.json.');
    console.log('Delete it afterwards: node scripts/start-test-n8n.mjs --stop');
  } else {
    await cleanup();
  }
}
