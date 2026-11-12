// tests/test-chrome-headless.js - Real Chromium E2E test (Service Worker, Popup UI, IndexedDB persistence, Alt+V overlay)
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const EXT_PATH = path.join(__dirname, '..');
const TEST_PROFILE = path.join(EXT_PATH, '.test-profile');
const PORT = 9223;

function findBrowser() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROME,
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p));
}

function getTargets(retries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            if (n <= 0) reject(e);
            else setTimeout(() => attempt(n - 1), 400);
          }
        });
      }).on('error', () => {
        if (n <= 0) reject(new Error('Chromium debugging port did not respond in time'));
        else setTimeout(() => attempt(n - 1), 400);
      });
    };
    attempt(retries);
  });
}

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = [];

    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      onEvent(fn) {
        listeners.push(fn);
      },
      close() {
        ws.close();
      }
    });
    ws.onerror = reject;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    };
  });
}

(async () => {
  console.log('--- TEST 4: REAL CHROMIUM HEADLESS E2E ---');
  const browserPath = findBrowser();
  if (!browserPath) {
    console.log('No Chromium/Edge binary found, skipping browser E2E test.');
    process.exit(0);
  }
  console.log('Using browser:', browserPath);

  if (fs.existsSync(TEST_PROFILE)) fs.rmSync(TEST_PROFILE, { recursive: true, force: true });
  fs.mkdirSync(TEST_PROFILE, { recursive: true });

  // Local HTTP test page for content script / Alt+V testing
  const testServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><title>Clipboard E2E Page</title></head><body><input id="demo-input" type="text" /></body></html>');
  });
  await new Promise(r => testServer.listen(0, '127.0.0.1', r));
  const testPort = testServer.address().port;

  const args = [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${TEST_PROFILE}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
    '--no-default-browser-check',
    `http://127.0.0.1:${testPort}/`
  ];

  const chromeProc = spawn(browserPath, args, { stdio: 'ignore' });
  let exitCode = 0;

  try {
    // Poll until extension service worker registers
    let targets = [];
    let swTarget = null;
    for (let i = 0; i < 20; i++) {
      targets = await getTargets(5);
      swTarget = targets.find(t =>
        t.type === 'service_worker' &&
        t.url &&
        t.url.startsWith('chrome-extension://') &&
        t.url.endsWith('/background/service-worker.js')
      );
      if (swTarget) break;
      await new Promise(r => setTimeout(r, 350));
    }

    assert(swTarget, 'Extension service_worker target (/background/service-worker.js) did not load');
    const extOrigin = swTarget.url.replace(/\/background\/service-worker\.js.*$/, '');
    console.log('✓ Extension Service Worker active:', swTarget.url);

    // 1. Verify popup UI (ui/panel.html) loads and persists items in IndexedDB via Service Worker chrome.tabs.create
    const swCdp = await connectCdp(swTarget.webSocketDebuggerUrl);
    await swCdp.send('Runtime.enable');
    const tabRes = await swCdp.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('ui/panel.html') });
        return { id: tab.id, url: tab.url || tab.pendingUrl };
      })()`
    });
    assert(!tabRes.exceptionDetails, `Service worker chrome.tabs.create threw: ${JSON.stringify(tabRes.exceptionDetails)}`);
    swCdp.close();

    let extPageTarget = null;
    let lastTargets = [];
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      lastTargets = await getTargets(5);
      extPageTarget = lastTargets.find(t => t.url && t.url.startsWith(`${extOrigin}/ui/panel.html`) && t.type === 'page');
      if (extPageTarget) break;
    }
    assert(extPageTarget, `Extension UI page target not found. tabRes=${JSON.stringify(tabRes)} targets=${JSON.stringify(lastTargets.map(t => ({ type: t.type, url: t.url })))}`);

    const extCdp = await connectCdp(extPageTarget.webSocketDebuggerUrl);
    const errors = [];
    const watchErrors = (cdpClient) => {
      cdpClient.onEvent((ev) => {
        if (ev.method === 'Runtime.exceptionThrown') {
          errors.push(ev.params?.exceptionDetails?.text || 'Runtime exception');
        } else if (ev.method === 'Runtime.consoleAPICalled' && ev.params?.type === 'error') {
          errors.push(ev.params.args?.map(a => a.value || a.description).join(' ') || 'Console error');
        }
      });
    };
    watchErrors(extCdp);
    await extCdp.send('Page.enable');
    await extCdp.send('Runtime.enable');

    const addResult = await extCdp.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        for (let i = 0; i < 40; i++) {
          if (location.href.includes('/ui/panel.html') && document.readyState === 'complete' && document.getElementById('quick-text-input') && document.getElementById('quick-add-btn')) break;
          await new Promise(r => setTimeout(r, 100));
        }
        const input = document.getElementById('quick-text-input');
        const btn = document.getElementById('quick-add-btn');
        if (!input || !btn) return { error: 'Panel UI inputs missing', href: location.href, readyState: document.readyState, bodyLen: document.body?.innerHTML?.length || 0 };
        input.value = 'E2E_CLIPBOARD_ITEM_42';
        btn.click();
        let feedText = '';
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 100));
          feedText = document.getElementById('items-feed')?.innerText || '';
          if (feedText.includes('E2E_CLIPBOARD_ITEM_42')) break;
        }
        return { feedText, stats: document.getElementById('storage-stats-label')?.textContent };
      })()`
    });

    assert(!addResult.exceptionDetails, `Panel evaluation threw: ${JSON.stringify(addResult.exceptionDetails)}`);
    assert(addResult.result?.value, `Panel evaluation returned no value: ${JSON.stringify(addResult)}`);
    assert(!addResult.result.value.error, `Panel evaluation error: ${JSON.stringify(addResult.result.value)}`);
    assert(addResult.result.value.feedText.includes('E2E_CLIPBOARD_ITEM_42'), `Added item must appear in panel feed; got: ${addResult.result.value.feedText}`);
    console.log('✓ Popup UI rendered & saved item to IndexedDB:', addResult.result.value.stats);
    extCdp.close();

    // 2. Connect to HTTP test page and trigger Alt+V floating overlay
    const pageTarget = targets.find(t => t.type === 'page' && t.url.startsWith(`http://127.0.0.1:${testPort}`));
    assert(pageTarget, 'Test page target not found');
    const cdp = await connectCdp(pageTarget.webSocketDebuggerUrl);
    watchErrors(cdp);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.bringToFront');
    // Navigate test page after extension initialization so content-script.js is guaranteed injected
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${testPort}/` });
    await cdp.send('Runtime.evaluate', {
      awaitPromise: true,
      expression: `(async () => {
        for (let i = 0; i < 30; i++) {
          if (location.href.startsWith('http://127.0.0.1:') && document.readyState === 'complete') break;
          await new Promise(r => setTimeout(r, 100));
        }
      })()`
    });
    await new Promise(r => setTimeout(r, 300));
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 1, key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 1, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 });

    const overlayResult = await cdp.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 100));
          const h = document.getElementById('clipboard-mvp-host');
          if (h && h.shadowRoot && (h.shadowRoot.querySelector('#cb-items-container')?.textContent || '').includes('E2E_CLIPBOARD_ITEM_42')) break;
        }
        const host = document.getElementById('clipboard-mvp-host');
        if (!host || !host.shadowRoot) return { opened: false, readyState: document.readyState, href: location.href };
        const text = host.shadowRoot.querySelector('#cb-items-container')?.textContent || '';
        const title = host.shadowRoot.querySelector('.cb-title-area')?.textContent || '';
        return { opened: true, title: title.trim(), hasItem: text.includes('E2E_CLIPBOARD_ITEM_42') };
      })()`
    });

    assert(!overlayResult.exceptionDetails, `Overlay evaluation threw: ${JSON.stringify(overlayResult.exceptionDetails)}`);
    assert(overlayResult.result?.value?.opened, `Alt+V must open #clipboard-mvp-host Shadow DOM overlay. got=${JSON.stringify(overlayResult.result?.value)} errors=${JSON.stringify(errors)}`);
    assert(overlayResult.result?.value?.hasItem, `Floating overlay must display persisted item from IndexedDB. got=${JSON.stringify(overlayResult.result.value)}`);
    console.log('✓ Alt+V floating overlay opened in Shadow DOM with persisted item');

    assert.strictEqual(errors.length, 0, `Unexpected browser errors: ${errors.join('; ')}`);
    console.log('✓ Zero browser console/runtime exceptions');
    cdp.close();
    console.log('🎉 ALL CHROMIUM E2E VERIFICATION CHECKS PASSED!\n');
  } catch (err) {
    console.error('❌ Browser verification failed:', err);
    exitCode = 1;
  } finally {
    try { chromeProc.kill('SIGKILL'); } catch (e) {}
    try { testServer.close(); } catch (e) {}
    setTimeout(() => {
      try { fs.rmSync(TEST_PROFILE, { recursive: true, force: true }); } catch (e) {}
      process.exit(exitCode);
    }, 600);
  }
})();
