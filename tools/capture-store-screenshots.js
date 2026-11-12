// tools/capture-store-screenshots.js - Captures real 1280x800 Chrome Web Store & Firefox AMO screenshots
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const EXT_PATH = path.join(__dirname, '..');
const OUT_DIR = path.join(EXT_PATH, 'screenshots');
const TEMP_PROFILE = path.join(EXT_PATH, '.temp-profile');
const PORT = 9224;

function findBrowser() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROME,
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1248', 'chrome-win64', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p));
}

function getTargets(retries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); } catch (e) {
            if (n <= 0) reject(e); else setTimeout(() => attempt(n - 1), 350);
          }
        });
      }).on('error', () => {
        if (n <= 0) reject(new Error('Chromium debugging port timeout'));
        else setTimeout(() => attempt(n - 1), 350);
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
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { ws.close(); }
    });
    ws.onerror = reject;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else res(msg.result);
      }
    };
  });
}

(async () => {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error('No Chromium binary found.');
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (fs.existsSync(TEMP_PROFILE)) fs.rmSync(TEMP_PROFILE, { recursive: true, force: true });
  fs.mkdirSync(TEMP_PROFILE, { recursive: true });

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <title>Workspace — Demo Page</title>
  <style>
    body { margin: 0; min-height: 100vh; font-family: system-ui, -apple-system, sans-serif; background: #0e1017; color: #c0caf5; display: flex; align-items: center; justify-content: center; }
    .card { width: 640px; padding: 32px; border-radius: 12px; background: #161822; border: 1px solid #292e42; }
    h1 { margin: 0 0 12px; font-size: 22px; color: #fff; }
    p { margin: 0 0 18px; color: #8b93b8; line-height: 1.6; }
    textarea { width: 100%; height: 96px; padding: 12px; border-radius: 8px; border: 1px solid #414868; background: #0b0d13; color: #c0caf5; font-family: monospace; font-size: 13px; box-sizing: border-box; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Заметка по релизу</h1>
    <p>Нажмите Alt+V, чтобы открыть локальную историю буфера обмена и вставить текст, ссылку или медиафайл.</p>
    <textarea placeholder="Поле для вставки из буфера..."></textarea>
  </div>
</body>
</html>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const testPort = server.address().port;

  const proc = spawn(browserPath, [
    '--headless=new',
    '--disable-gpu',
    '--window-size=1280,800',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${TEMP_PROFILE}`,
    `--load-extension=${EXT_PATH}`,
    '--no-first-run',
    '--no-default-browser-check',
    `http://127.0.0.1:${testPort}/`
  ], { stdio: 'ignore' });

  try {
    let targets = [];
    let swTarget = null;
    for (let i = 0; i < 20; i++) {
      targets = await getTargets(5);
      swTarget = targets.find(t => t.type === 'service_worker' && t.url?.endsWith('/background/service-worker.js'));
      if (swTarget) break;
      await new Promise(r => setTimeout(r, 350));
    }
    if (!swTarget) throw new Error('Service worker failed to start');

    const swCdp = await connectCdp(swTarget.webSocketDebuggerUrl);
    await swCdp.send('Runtime.enable');

    // Open extension panel tab and seed sample items
    const tabRes = await swCdp.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const tab = await chrome.tabs.create({ url: chrome.runtime.getURL('ui/panel.html') });
        return tab.id;
      })()`
    });
    swCdp.close();

    const extOrigin = swTarget.url.replace(/\/background\/service-worker\.js.*$/, '');
    let extTarget = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250));
      const t = await getTargets(5);
      extTarget = t.find(x => x.type === 'page' && x.url?.startsWith(`${extOrigin}/ui/panel.html`));
      if (extTarget) break;
    }
    if (!extTarget) throw new Error('Extension panel tab not found');

    const extCdp = await connectCdp(extTarget.webSocketDebuggerUrl);
    await extCdp.send('Page.enable');
    await extCdp.send('Runtime.enable');
    await extCdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await extCdp.send('Page.bringToFront');

    await extCdp.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        for (let i = 0; i < 30; i++) {
          if (document.readyState === 'complete' && document.getElementById('items-feed')) break;
          await new Promise(r => setTimeout(r, 100));
        }
        // Generate sample terminal artwork PNG blob
        const c = document.createElement('canvas');
        c.width = 240; c.height = 150;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#0b0700'; ctx.fillRect(0, 0, 240, 150);
        ctx.strokeStyle = '#ffb000'; ctx.lineWidth = 3; ctx.strokeRect(8, 8, 224, 134);
        ctx.fillStyle = '#ffb000'; ctx.font = 'bold 16px monospace';
        ctx.fillText('> CLIPBOARD v1.2', 24, 62);
        ctx.fillStyle = '#c98a00'; ctx.font = '12px monospace';
        ctx.fillText('LOCAL • ZERO TELEMETRY', 24, 92);
        const dataUrl = c.toDataURL('image/png');

        await chrome.runtime.sendMessage({
          type: 'AUTO_CAPTURE_IMAGE',
          itemType: 'image',
          dataUrl,
          mimeType: 'image/png',
          title: 'terminal-preview.png (18 КБ)'
        });

        const addQuick = async (val) => {
          const inp = document.getElementById('quick-text-input');
          const btn = document.getElementById('quick-add-btn');
          inp.value = val;
          btn.click();
          await new Promise(r => setTimeout(r, 150));
        };
        await addQuick('git status --short && npm test');
        await addQuick('Релиз v1.2.0: поддержка Chrome и Firefox, данные хранятся только локально.');
        await addQuick('https://github.com/dressky/clipboard');

        await new Promise(r => setTimeout(r, 400));
        const pinBtns = document.querySelectorAll('.action-pin-btn');
        if (pinBtns.length > 0) pinBtns[0].click();
        await new Promise(r => setTimeout(r, 2700));

        // Center the popup frame cleanly on the 1280x800 store showcase canvas
        const st = document.createElement('style');
        st.textContent = 'html, body { width: 100% !important; height: 100% !important; display: flex; align-items: center; justify-content: center; background: #070500 !important; } .app-container { width: 540px !important; height: 680px !important; border: 1px solid #ffb000; border-radius: 10px; box-shadow: 0 0 40px rgba(255, 176, 0, 0.22); }';
        document.head.appendChild(st);
        await new Promise(r => setTimeout(r, 150));
      })()`
    });

    const popupShot = await extCdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, 'store-popup-1280x800.png'), Buffer.from(popupShot.data, 'base64'));
    console.log('✓ Saved screenshots/store-popup-1280x800.png');
    extCdp.close();

    // Capture Alt+V floating overlay on demo page
    const pageTarget = targets.find(t => t.type === 'page' && t.url?.startsWith(`http://127.0.0.1:${testPort}`));
    const cdp = await connectCdp(pageTarget.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.bringToFront');
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
    await new Promise(r => setTimeout(r, 500));

    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 1, key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 1, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 1, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 });
    await new Promise(r => setTimeout(r, 1700));

    const overlayShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, 'store-overlay-1280x800.png'), Buffer.from(overlayShot.data, 'base64'));
    console.log('✓ Saved screenshots/store-overlay-1280x800.png');
    cdp.close();
  } finally {
    try { proc.kill('SIGKILL'); } catch (e) {}
    try { server.close(); } catch (e) {}
    setTimeout(() => {
      try { fs.rmSync(TEMP_PROFILE, { recursive: true, force: true }); } catch (e) {}
    }, 500);
  }
})();
