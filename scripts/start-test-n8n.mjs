import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_ROOT = path.join(ROOT, '.test-runtime');
const RUNTIME_FILE = path.join(RUNTIME_ROOT, 'runtime.json');
const OWNERSHIP_LABEL = 'sales-pilot.disposable-test';
const NAME_PATTERN = /^sales-pilot-test-[0-9]+-[a-f0-9]{8}$/;

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, windowsHide: true, ...options });
    let output = '';
    child.stdout?.on('data', data => { output += data; });
    child.stderr?.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} exited with code ${code}.\n${output.slice(-12000)}`)));
  });
}

async function docker(args) { return run('docker', args); }
async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function inspectOwned(kind, name, token) {
  try {
    const result = JSON.parse(await docker([kind, 'inspect', name]))[0];
    const labels = kind === 'container' ? result.Config.Labels : result.Labels;
    return labels?.[OWNERSHIP_LABEL] === token;
  } catch { return false; }
}

export async function stopDisposableN8n(runtime) {
  if (!NAME_PATTERN.test(runtime?.name ?? '') || !/^[a-f0-9]{32}$/.test(runtime?.ownershipToken ?? '')) {
    throw new Error('Refusing cleanup: not a recognized disposable test runtime.');
  }
  const ownedDirectory = path.resolve(RUNTIME_ROOT, runtime.name);
  if (path.resolve(runtime.directory) !== ownedDirectory || path.dirname(ownedDirectory) !== RUNTIME_ROOT) {
    throw new Error('Refusing cleanup outside this project’s disposable test directory.');
  }
  for (const name of [runtime.name, `${runtime.name}-credentials`, `${runtime.name}-workflow`, `${runtime.name}-publish`]) {
    if (await inspectOwned('container', name, runtime.ownershipToken)) await docker(['rm', '-f', name]);
  }
  if (await inspectOwned('volume', runtime.name, runtime.ownershipToken)) await docker(['volume', 'rm', runtime.name]);
  await rm(ownedDirectory, { recursive: true, force: true });
  try {
    const saved = JSON.parse(await readFile(RUNTIME_FILE, 'utf8'));
    if (saved.name === runtime.name && saved.ownershipToken === runtime.ownershipToken) await rm(RUNTIME_FILE);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function startDisposableN8n() {
  try {
    await readFile(RUNTIME_FILE);
    throw new Error('A disposable test runtime is already recorded. Run node scripts/start-test-n8n.mjs --stop first, or use npm run test:live -- --reuse.');
  } catch (error) { if(error.code !== 'ENOENT') throw error; }
  // Always derive the version from the deployment file: this tests the shipped runtime.
  const compose = await readFile(path.join(ROOT, 'compose.yaml'), 'utf8');
  const image = compose.match(/image:\s*(n8nio\/n8n@sha256:[a-f0-9]{64})/)?.[1];
  if (!image) throw new Error('compose.yaml must pin an n8n image by digest.');
  const name = `sales-pilot-test-${Date.now()}-${randomBytes(4).toString('hex')}`;
  const directory = path.join(RUNTIME_ROOT, name);
  const secret = randomBytes(32).toString('hex');
  const ownershipToken = randomBytes(16).toString('hex');
  const runtime = { name, directory, ownershipToken, image, secret };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(RUNTIME_FILE, JSON.stringify(runtime, null, 2), { mode: 0o600 });
  const workflow = JSON.parse(await readFile(path.join(ROOT, '03-web-upload.json'), 'utf8'));
  const quoteWorkflow = JSON.parse(await readFile(path.join(ROOT, '04-quotation-review.json'), 'utf8'));
  const credentialId = 'disposablePilotHeader';
  workflow.nodes.find(node => node.type === 'n8n-nodes-base.webhook').credentials = {
    httpHeaderAuth: { id: credentialId, name: 'Disposable test header' },
  };
  // The source export stays inactive and credential-free. Only this isolated copy is published.
  workflow.active = false;
  quoteWorkflow.active = false;
  quoteWorkflow.nodes.find(node=>node.type==='n8n-nodes-base.webhook').credentials=structuredClone(workflow.nodes.find(node=>node.type==='n8n-nodes-base.webhook').credentials);
  await writeFile(path.join(directory, 'workflow.json'), JSON.stringify([workflow,quoteWorkflow]), { mode: 0o600 });
  await writeFile(path.join(directory, 'credentials.json'), JSON.stringify([{
    id: credentialId, name: 'Disposable test header', type: 'httpHeaderAuth',
    data: { name: 'X-Pilot-Key', value: secret },
  }]), { mode: 0o600 });
  await writeFile(path.join(directory, 'runtime.env'), [
    `N8N_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`,
    'N8N_DIAGNOSTICS_ENABLED=false',
    'N8N_PERSONALIZATION_ENABLED=false',
    'N8N_VERSION_NOTIFICATIONS_ENABLED=false',
    'N8N_SECURE_COOKIE=false',
    'N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true',
    'N8N_LOG_LEVEL=warn',
    'N8N_PAYLOAD_SIZE_MAX=20',
    'EXECUTIONS_TIMEOUT=60',
    'EXECUTIONS_TIMEOUT_MAX=60',
    'EXECUTIONS_DATA_SAVE_ON_ERROR=none',
    'EXECUTIONS_DATA_SAVE_ON_SUCCESS=none',
    'EXECUTIONS_DATA_SAVE_ON_PROGRESS=false',
    'EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=false',
    'EXECUTIONS_DATA_PRUNE=true',
    'EXECUTIONS_DATA_MAX_AGE=1',
    'EXECUTIONS_DATA_HARD_DELETE_BUFFER=1',
    '',
  ].join('\n'), { mode: 0o600 });
  const common = [
    '--label', `${OWNERSHIP_LABEL}=${ownershipToken}`,
    '--env-file', path.join(directory, 'runtime.env'),
    '--volume', `${name}:/home/node/.n8n`,
    '--volume', `${directory}:/fixture:ro`,
  ];
  try {
    await docker(['volume', 'create', '--label', `${OWNERSHIP_LABEL}=${ownershipToken}`, name]);
    const importCredentialsLog = await docker(['run', '--rm', '--name', `${name}-credentials`, ...common, image, 'import:credentials', '--input=/fixture/credentials.json']);
    const importWorkflowLog = await docker(['run', '--rm', '--name', `${name}-workflow`, ...common, image, 'import:workflow', '--input=/fixture/workflow.json']);
    const publishLog = await docker(['run', '--rm', '--name', `${name}-publish`, ...common, image, 'publish:workflow', `--id=${workflow.id}`]);
    const quotePublishLog = await docker(['run', '--rm', '--name', `${name}-publish`, ...common, image, 'publish:workflow', `--id=${quoteWorkflow.id}`]);
    await writeFile(path.join(directory, 'setup.log'), [importCredentialsLog, importWorkflowLog, publishLog, quotePublishLog].join('\n'));
    await docker(['run', '-d', '--name', name, ...common, '--publish', '127.0.0.1::5678', '--memory', '1g', '--pids-limit', '200', image]);
    const mapping = await docker(['port', name, '5678/tcp']);
    const port = mapping.match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (!port) throw new Error(`Could not find loopback port for ${name}.`);
    runtime.url = `http://127.0.0.1:${port}/webhook/sales-web`;
    runtime.quotationUrl = `http://127.0.0.1:${port}/webhook/quotation-web`;
    runtime.editorUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${runtime.editorUrl}/healthz/readiness`, { signal: AbortSignal.timeout(2000) });
        if (response.ok) break;
      } catch {}
      await sleep(1000);
    }
    const ready = await fetch(`${runtime.editorUrl}/healthz/readiness`, { signal: AbortSignal.timeout(5000) });
    if (!ready.ok) throw new Error('Disposable n8n failed its readiness check.');
    // A health check alone cannot prove that the webhook and Code runner work.
    let response;
    for (let attempt = 0; attempt < 15; attempt++) {
      response = await fetch(runtime.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pilot-Key': secret },
      body: JSON.stringify({ requestId: randomUUID(), rows: [{ transaction_id: 'SMOKE', product: 'Test', quantity: 2, unit_price_clp: 300 }] }),
      signal: AbortSignal.timeout(65000),
      });
      if (response.status !== 404) break;
      await response.arrayBuffer();
      await sleep(1000);
    }
    const result = await response.json();
    if (!response.ok || result.result?.summary?.valid_sales_total_clp !== 600) {
      throw new Error(`Disposable webhook smoke test failed (HTTP ${response.status}).`);
    }
    await writeFile(RUNTIME_FILE, JSON.stringify(runtime, null, 2), { mode: 0o600 });
    return runtime;
  } catch (error) {
    try { error.message += `\nDisposable n8n log:\n${(await docker(['logs', name])).slice(-6000)}`; } catch {}
    try { error.message += `\nSetup log:\n${(await readFile(path.join(directory, 'setup.log'), 'utf8')).slice(-4000)}`; } catch {}
    try { await stopDisposableN8n(runtime); } catch (cleanupError) { error.message += `\nCleanup: ${cleanupError.message}`; }
    throw error;
  }
}

export { RUNTIME_FILE };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--stop')) {
    const runtime = JSON.parse(await readFile(RUNTIME_FILE, 'utf8'));
    await stopDisposableN8n(runtime);
    console.log('Removed the disposable n8n container, volume and private temporary files.');
  } else {
    const runtime = await startDisposableN8n();
    console.log(`Disposable n8n ready at ${runtime.editorUrl}.`);
    console.log('Private test configuration saved to .test-runtime/runtime.json; never commit or share it.');
    console.log('Stop and delete this test runtime with: node scripts/start-test-n8n.mjs --stop');
  }
}
