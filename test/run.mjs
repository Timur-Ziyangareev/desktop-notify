/*
 * Runs test/harness.html in a disposable Edge window over CDP.
 *
 *   node test/run.mjs
 *
 * Exits 0 when every check passes, 1 otherwise. The harness needs a real
 * browser: OfflineAudioContext and Notification are the point of the plugin.
 */

import http from 'node:http';
import { createReadStream, existsSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname, join, normalize } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = normalize(join(HERE, '..'));
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = Number(process.env.PORT || 8798);
const DEBUG_PORT = Number(process.env.CDP_PORT || 9223);
const PROFILE = join(process.env.TEMP || '.', 'desktop-notify-' + Date.now());
const PROFILE_TAG = basename(PROFILE);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

// ESM has no require; create one bound to this module.
const require_ = createRequire(import.meta.url);

function loadUndici() {
  const paths = [
    process.env.UNDICI_PATH,
    'C:/Users/timur_m1pc/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/dist/node_modules/undici'
  ].filter(Boolean);
  for (const path of paths) {
    try {
      return require_(path);
    } catch (error) { /* try the next one */ }
  }
  throw new Error('undici not found; set UNDICI_PATH');
}

const { WebSocket, fetch } = loadUndici();

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  const target = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (!target.startsWith(ROOT) || !existsSync(target)) {
    response.writeHead(404).end('not found');
    return;
  }
  const info = await stat(target);
  if (!info.isFile()) {
    response.writeHead(404).end('not a file');
    return;
  }
  response.writeHead(200, {
    'Content-Type': MIME[extname(target)] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  createReadStream(target).pipe(response);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTarget(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((entry) => entry.type === 'page' && entry.url.startsWith(url));
      if (page) return page;
    } catch (error) { /* browser still starting */ }
    await sleep(300);
  }
  throw new Error('page target did not appear');
}

function killBrowser() {
  try {
    const out = execSync(
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${PROFILE_TAG}*' } | Select-Object -ExpandProperty ProcessId`,
      { shell: 'powershell.exe', encoding: 'utf8' }
    );
    for (const line of out.split(/\r?\n/)) {
      const id = Number(line.trim());
      if (Number.isSafeInteger(id) && id > 0) {
        try { execSync(`taskkill /PID ${id} /T /F`, { stdio: 'ignore' }); } catch (error) { /* gone */ }
      }
    }
  } catch (error) { /* nothing to kill */ }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { rmSync(PROFILE, { recursive: true, force: true }); break; } catch (error) { /* locked by a dying process */ }
  }
}

const pending = new Map();
let socket;

function send(method, params) {
  const id = pending.size + 1 + Math.floor(Math.random() * 1000);
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 20000);
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result && result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || 'evaluation failed');
  }
  return result && result.result ? result.result.value : undefined;
}

let code = 1;
try {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${PORT}/test/harness.html`;

  spawn(EDGE, [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2',
    '--window-size=1100,900',
    url
  ], { detached: true, stdio: 'ignore' }).unref();

  const page = await waitForTarget(url, Date.now() + 30000);
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch (error) { return; }
    if (message.id === undefined) return;
    const handler = pending.get(message.id);
    if (!handler) return;
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message.result);
  });

  await send('Runtime.enable', {});
  await send('Page.enable', {});

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await evaluate('window.__DONE__ === true')) break;
    await sleep(250);
  }
  if (!(await evaluate('window.__DONE__ === true'))) throw new Error('harness did not finish');

  const results = await evaluate('JSON.stringify(window.__RESULTS__)');
  const parsed = JSON.parse(results);
  let failed = 0;
  for (const item of parsed) {
    if (!item.ok) failed += 1;
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ' — ' + item.detail : ''}`);
  }
  console.log(`\n${parsed.length - failed}/${parsed.length} passed`);
  code = failed === 0 ? 0 : 1;
} catch (error) {
  console.error('runner failed:', error && error.message ? error.message : error);
} finally {
  try { if (socket) socket.close(); } catch (error) { /* ignore */ }
  server.close();
  killBrowser();
}
process.exit(code);
