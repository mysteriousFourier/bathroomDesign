#!/usr/bin/env node

const TARGET_URL = process.env.W1D5_VIEWER_URL || 'http://127.0.0.1:4173/viewer/w1d5-empty-room-viewer.html';
const DEVTOOLS_URL = process.env.W1D5_DEVTOOLS_URL || 'http://127.0.0.1:9222';

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
  const page = await openPage();
  const client = await connect(page.webSocketDebuggerUrl);
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

  client.close();
  const value = result.result?.value;
  console.log(JSON.stringify({
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
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
