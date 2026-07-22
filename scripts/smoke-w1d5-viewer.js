#!/usr/bin/env node

const { createServer } = require('node:http');
const { createReadStream, existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { extname, join, normalize, resolve } = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = resolve(__dirname, '..');
const VIEWER_PORT = Number(process.env.W1D5_VIEWER_PORT || 4173);
const DEVTOOLS_PORT = Number(process.env.W1D5_DEVTOOLS_PORT || 9222);
const DEVTOOLS_URL = process.env.W1D5_DEVTOOLS_URL || `http://127.0.0.1:${DEVTOOLS_PORT}`;
const AUTOSTART = process.env.W1D5_SMOKE_AUTOSTART !== '0';
const TARGET_URL = process.env.W1D5_VIEWER_URL || `http://127.0.0.1:${VIEWER_PORT}/viewer/w1d5-empty-room-viewer.html`;

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
]);

function capabilityGap(message) {
  const error = new Error(`CAPABILITY_GAP: ${message}`);
  error.capabilityGap = true;
  return error;
}

async function fetchOk(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

function startStaticServer() {
  return new Promise((resolveServer, reject) => {
    const server = createServer((request, response) => {
      const parsedUrl = new URL(request.url, TARGET_URL);
      if (parsedUrl.pathname === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }
      const relativePath = decodeURIComponent(parsedUrl.pathname).replace(/^\/+/, '') || 'viewer/w1d5-empty-room-viewer.html';
      const filePath = normalize(resolve(REPO_ROOT, relativePath));
      if (!filePath.startsWith(`${REPO_ROOT}/`)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }
      if (!existsSync(filePath)) {
        response.writeHead(404);
        response.end('Not found');
        return;
      }
      response.writeHead(200, {
        'content-type': MIME_TYPES.get(extname(filePath)) || 'application/octet-stream',
      });
      createReadStream(filePath).pipe(response);
    });
    server.on('error', error => {
      if (error.code === 'EADDRINUSE') {
        reject(capabilityGap(`viewer port ${VIEWER_PORT} is already in use and ${TARGET_URL} is not reachable`));
      } else {
        reject(error);
      }
    });
    server.listen(VIEWER_PORT, '127.0.0.1', () => resolveServer(server));
  });
}

function findChrome() {
  const candidates = [
    process.env.W1D5_CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate));
}

async function waitForDevTools(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fetchOk(`${DEVTOOLS_URL}/json/version`)) return;
    await wait(250);
  }
  throw capabilityGap(`Chrome DevTools did not become reachable at ${DEVTOOLS_URL}`);
}

async function startChrome() {
  const chromePath = findChrome();
  if (!chromePath) {
    throw capabilityGap('no Chrome/Chromium binary found; set W1D5_CHROME_PATH or provide W1D5_DEVTOOLS_URL');
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'w1d5-smoke-chrome-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${DEVTOOLS_PORT}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ];
  const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.on('exit', code => {
    if (code !== null && code !== 0 && stderr) {
      console.error(stderr.trim());
    }
  });

  try {
    await waitForDevTools();
    return {
      async close() {
        if (!child.killed) child.kill('SIGTERM');
        await new Promise(resolveClose => {
          child.once('exit', resolveClose);
          setTimeout(resolveClose, 2500);
        });
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      },
    };
  } catch (error) {
    child.kill('SIGTERM');
    rmSync(userDataDir, { recursive: true, force: true });
    if (stderr) {
      throw capabilityGap(`${error.message}; Chrome stderr: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
    }
    throw error;
  }
}

async function ensureDependencies() {
  const cleanups = [];
  if (!await fetchOk(TARGET_URL)) {
    if (!AUTOSTART || process.env.W1D5_VIEWER_URL) {
      throw capabilityGap(`viewer is not reachable at ${TARGET_URL}`);
    }
    const server = await startStaticServer();
    cleanups.push(() => server.close());
  }

  if (!await fetchOk(`${DEVTOOLS_URL}/json/version`)) {
    if (!AUTOSTART || process.env.W1D5_DEVTOOLS_URL) {
      throw capabilityGap(`Chrome DevTools is not reachable at ${DEVTOOLS_URL}`);
    }
    const chrome = await startChrome();
    cleanups.push(() => chrome.close());
  }
  return async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
  };
}

async function openPage() {
  const response = await fetch(`${DEVTOOLS_URL}/json/new?${encodeURIComponent(TARGET_URL)}`, { method: 'PUT' });
  if (!response.ok) {
    throw new Error(`DevTools new page failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const events = [];

  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result || {});
      return;
    }
    events.push(message);
  });

  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      resolve({
        events,
        send(method, params = {}) {
          const id = nextId++;
          ws.send(JSON.stringify({ id, method, params }));
          return new Promise((commandResolve, commandReject) => {
            pending.set(id, { resolve: commandResolve, reject: commandReject });
          });
        },
        close() {
          ws.close();
        },
      });
    });
    ws.addEventListener('error', reject);
  });
}

function wait(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function main() {
  const cleanup = await ensureDependencies();
  const page = await openPage();
  const client = await connect(page.webSocketDebuggerUrl);
  try {
    await client.send('Runtime.enable');
    await client.send('Log.enable');
    await client.send('Page.enable');
    await wait(4000);

    const result = await client.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(() => {
        const viewport = document.querySelector('#viewport');
        const canvas = viewport && viewport.querySelector('canvas');
        if (!canvas) return { ok: false, reason: 'missing canvas' };
        canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 160, clientY: 160, pointerId: 1 }));
        canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 230, clientY: 190, pointerId: 1 }));
        canvas.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 230, clientY: 190, pointerId: 1 }));
        canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 }));
        const dataUrlLength = canvas.toDataURL('image/png').length;
        return {
          ok: true,
          canvasCount: viewport.querySelectorAll('canvas').length,
          canvasWidth: canvas.width,
          canvasHeight: canvas.height,
          dataUrlLength,
          traceRows: document.querySelectorAll('#trace li').length,
          hasFixtureTrace: Boolean(document.body.textContent.match(/scene-fixture-point-001/)),
          hasPipeTrace: Boolean(document.body.textContent.match(/scene-pipe-enclosure-001/)),
        };
      })()`,
    });

    const consoleProblems = client.events.filter(event => {
      if (event.method === 'Runtime.exceptionThrown') return true;
      if (event.method === 'Log.entryAdded') {
        return ['error', 'warning'].includes(event.params.entry.level)
          && !/favicon|DevTools|GL Driver Message.*ReadPixels/.test(event.params.entry.text || '');
      }
      return false;
    });

    const value = result.result?.value;
    console.log(JSON.stringify({
      targetUrl: TARGET_URL,
      devToolsUrl: DEVTOOLS_URL,
      result: value,
      consoleProblemCount: consoleProblems.length,
      consoleProblems: consoleProblems.map(event => {
        if (event.method === 'Runtime.exceptionThrown') {
          const details = event.params.exceptionDetails;
          return `${details.text}: ${details.exception?.description || details.exception?.value || ''}`;
        }
        return event.params?.entry?.text || event.method;
      }),
    }, null, 2));
    if (!value?.ok || value.dataUrlLength < 5000 || value.traceRows < 11 || !value.hasFixtureTrace || !value.hasPipeTrace || consoleProblems.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    client.close();
    await cleanup();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
