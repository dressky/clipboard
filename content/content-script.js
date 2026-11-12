// content/content-script.js - In-page controller, auto-capture & floating palette (Amber Terminal & Tiny5Mono)

(function () {
  let shadowRoot = null;
  let hostElement = null;
  let isOpen = false;
  let currentFilter = 'all';
  let searchQuery = '';
  let itemsList = [];
  let selectedIndex = 0;
  let lastActiveInput = null;
  let sidePanelSupported = true;

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null) continue;
        if (k === 'className') node.className = v;
        else if (k === 'textContent') node.textContent = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k in node && k !== 'list') node[k] = v;
        else node.setAttribute(k, v);
      }
    }
    if (children) {
      for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
      }
    }
    return node;
  }

  // Track active input elements before user opens the palette
  document.addEventListener('focusin', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) {
      if (e.target.type !== 'password') {
        lastActiveInput = e.target;
      }
    }
  }, true);

  // 1. In-page Hotkey listener for Alt+V (supports both English and Russian layouts)
  window.addEventListener('keydown', (e) => {
    if (e.altKey && (e.code === 'KeyV' || e.key.toLowerCase() === 'v' || e.key.toLowerCase() === 'м')) {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    }
  }, true);

  // 2. Auto-capture text on copy event
  document.addEventListener('copy', (e) => {
    try {
      const activeEl = document.activeElement;
      if (activeEl && activeEl.tagName === 'INPUT' && activeEl.type === 'password') {
        return; // Never capture passwords
      }

      const selectedText = window.getSelection() ? window.getSelection().toString() : '';
      if (selectedText && selectedText.trim().length > 0) {
        chrome.runtime.sendMessage({
          type: 'AUTO_CAPTURE_TEXT',
          text: selectedText.trim()
        }).catch(() => {});
      }
    } catch (err) {
      // Ignore copy capture errors
    }
  });

  // 3. Listen to messages from background service worker
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'TOGGLE_FLOATING_PANEL':
        togglePanel();
        sendResponse({ success: true, isOpen });
        break;

      case 'SHOW_TOAST':
        showToast(message.message, message.level);
        sendResponse({ success: true });
        break;

      case 'GRAB_IMAGE_FROM_PAGE':
        handleGrabImageFromPage(message.srcUrl, sendResponse);
        return true;
    }
  });

  // Grab image from page context (supports blob: URLs, CDN images & canvas fallback)
  async function handleGrabImageFromPage(srcUrl, sendResponse) {
    try {
      // 1. In page context, fetch works directly for blob: URLs and same-origin or CORS images
      const resp = await fetch(srcUrl);
      const blob = await resp.blob();
      if (blob && blob.size > 0) {
        const reader = new FileReader();
        reader.onloadend = () => {
          sendResponse({ dataUrl: reader.result, mimeType: blob.type || 'image/png' });
        };
        reader.onerror = () => tryCanvasFallback();
        reader.readAsDataURL(blob);
        return;
      }
    } catch (fe) {
      // Direct fetch failed, continue to canvas fallback
    }

    tryCanvasFallback();

    function tryCanvasFallback() {
      try {
        const imgs = Array.from(document.querySelectorAll('img'));
        const img = imgs.find(i => i.src === srcUrl || i.currentSrc === srcUrl);
        if (img && img.complete && img.naturalWidth > 0) {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const dataUrl = canvas.toDataURL('image/png');
          sendResponse({ dataUrl, mimeType: 'image/png' });
          return;
        }
      } catch (e) {
        // Canvas tainted or failed
      }
      sendResponse({ dataUrl: null });
    }
  }

  // Toast Notification
  function showToast(text, level = 'success') {
    ensureHostCreated();
    const toast = document.createElement('div');
    toast.className = `cb-toast ${level}`;
    toast.textContent = text;
    shadowRoot.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.2s ease-out';
      setTimeout(() => toast.remove(), 250);
    }, 2400);
  }

  // Ensure Shadow DOM Host exists with Amber Terminal styles & Tiny5Mono font
  function ensureHostCreated() {
    if (!hostElement) {
      hostElement = document.createElement('div');
      hostElement.id = 'clipboard-mvp-host';
      hostElement.style.cssText = 'position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; overflow: visible; pointer-events: none;';
      document.documentElement.appendChild(hostElement);

      shadowRoot = hostElement.attachShadow({ mode: 'open' });

      const fontReg = chrome.runtime.getURL('fonts/Tiny5Mono-Regular.woff2');
      const fontBold = chrome.runtime.getURL('fonts/Tiny5Mono-Bold.woff2');

      const styleEl = document.createElement('style');
      styleEl.textContent = `
        @font-face {
          font-family: 'Tiny5Mono';
          src: url('${fontReg}') format('woff2');
          font-weight: 400;
          font-style: normal;
        }
        @font-face {
          font-family: 'Tiny5Mono';
          src: url('${fontBold}') format('woff2');
          font-weight: 700;
          font-style: normal;
        }

        /* Pixel Icon System */
        .pixel-icon, .pixel-icon-header, .pixel-icon-btn, .pixel-icon-tab, .pixel-icon-action, .pixel-icon-inline, .pixel-icon-xs {
          image-rendering: pixelated;
          image-rendering: -moz-crisp-edges;
          image-rendering: crisp-edges;
          vertical-align: middle;
          display: inline-block;
          flex-shrink: 0;
        }
        .pixel-icon-header { width: 16px; height: 16px; margin-right: 4px; }
        .pixel-icon-btn { width: 16px; height: 16px; display: block; }
        .pixel-icon-tab { width: 14px; height: 14px; margin-right: 4px; }
        .pixel-icon-action { width: 16px; height: 16px; display: block; transition: transform 0.1s ease; }
        .pixel-icon-action:hover { transform: scale(1.15); }
        .pixel-icon-inline { width: 14px; height: 14px; margin-right: 4px; }
        .pixel-icon-xs { width: 12px; height: 12px; margin-right: 3px; }

        .cb-pinned-badge { display: inline-flex; align-items: center; font-family: 'Tiny5Mono', monospace; font-size: 10px; font-weight: 700; color: #ff8a80; background: rgba(229, 57, 53, 0.15); border: 1px solid rgba(229, 57, 53, 0.35); padding: 1px 5px; border-radius: 3px; letter-spacing: 0.03em; }
        .cb-archived-badge { display: inline-flex; align-items: center; font-family: 'Tiny5Mono', monospace; font-size: 10px; font-weight: 700; color: #a87300; background: #1f1503; border: 1px solid #6b4809; padding: 1px 5px; border-radius: 3px; letter-spacing: 0.03em; }

        :host { all: initial; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 13px; line-height: 1.5; color: #ffb000; }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .cb-toast { font-family: 'Tiny5Mono', monospace; position: fixed; bottom: 24px; right: 24px; z-index: 2147483647; padding: 10px 18px; border-radius: 8px; font-size: 13px; font-weight: 700; box-shadow: 0 8px 24px rgba(0,0,0,0.6); display: flex; align-items: center; gap: 8px; pointer-events: none; animation: cbFadeIn 0.2s cubic-bezier(.22,.8,.3,1); background-color: #1f1503; color: #ffb000; border: 1px solid #c98a00; }
        .cb-toast.error { background-color: #261a1d; color: #ff8a95; border-color: #f24d5c; }
        @keyframes cbFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

        .cb-backdrop { position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(11, 7, 0, 0.72); backdrop-filter: blur(5px); z-index: 2147483646; display: flex; align-items: center; justify-content: center; pointer-events: auto; }
        .cb-modal { width: 550px; max-width: 94vw; max-height: 86vh; background: #130d02; border-radius: 12px; box-shadow: 0 20px 48px rgba(0,0,0,0.8), 0 0 0 1px #6b4809; display: flex; flex-direction: column; overflow: hidden; border: 1px solid #6b4809; pointer-events: auto; position: relative; }

        /* Header */
        .cb-header { padding: 12px 18px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #3a2605; background: rgba(19, 13, 2, 0.95); flex-shrink: 0; }
        .cb-header-left { display: flex; align-items: center; gap: 8px; }
        .cb-title-area { font-family: 'Tiny5Mono', monospace; display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 16px; color: #ffffff; letter-spacing: 0.04em; text-shadow: 0 2px 8px rgba(255, 176, 0, 0.35); }
        .cb-offline-pill { font-family: 'Tiny5Mono', monospace; font-size: 10px; background: #2a1a02; color: #ffb000; border: 1px solid #c98a00; padding: 2px 6px; border-radius: 4px; font-weight: 700; letter-spacing: 0.03em; }
        .cb-header-stats { font-family: 'Tiny5Mono', monospace; font-size: 11px; color: #c98a00; background: #1f1503; border: 1px solid #6b4809; padding: 2px 6px; border-radius: 4px; }
        .cb-header-right { display: flex; align-items: center; gap: 6px; }

        .cb-btn-icon { background: #130d02; border: 1px solid #6b4809; cursor: pointer; padding: 4px 7px; border-radius: 5px; color: #c98a00; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; min-width: 26px; min-height: 26px; transition: all 0.15s; }
        .cb-btn-icon:hover { background-color: #1f1503; border-color: #ffb000; color: #ffffff; }
        .cb-close-btn { background: none; border: none; cursor: pointer; padding: 4px 8px; border-radius: 6px; color: #c98a00; font-size: 16px; transition: all 0.15s; }
        .cb-close-btn:hover { background: #1f1503; color: #ffffff; }

        /* Search Bar */
        .cb-search-area { padding: 8px 18px; border-bottom: 1px solid #3a2605; background: #0b0700; position: relative; flex-shrink: 0; }
        .cb-search-input { width: 100%; padding: 8px 30px 8px 12px; border: 1px solid #6b4809; border-radius: 6px; font-size: 13px; background: #080500; color: #ffb000; outline: none; transition: all 0.15s; }
        .cb-search-input:focus { border-color: #ffb000; box-shadow: 0 0 0 2px rgba(255, 176, 0, 0.18); }
        .cb-search-input::placeholder { color: #7a5400; }
        .cb-search-clear { position: absolute; right: 26px; top: 50%; transform: translateY(-50%); background: none; border: none; color: #c98a00; cursor: pointer; font-size: 13px; }
        .cb-search-clear:hover { color: #ffffff; }

        /* Filter Pills - Perfect Grid aligned with Search */
        .cb-filters { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; padding: 8px 18px; border-bottom: 1px solid #3a2605; background: #130d02; flex-shrink: 0; box-sizing: border-box; width: 100%; }
        .cb-filter-pill { font-family: 'Tiny5Mono', monospace; height: 28px; padding: 0 4px; display: inline-flex; align-items: center; justify-content: center; text-align: center; border-radius: 6px; font-size: 11px; font-weight: 700; border: 1px solid #6b4809; background: #1f1503; color: #c98a00; cursor: pointer; white-space: nowrap; letter-spacing: 0.03em; transition: all 0.15s; box-sizing: border-box; width: 100%; }
        .cb-filter-pill:hover { background: #2a1a02; border-color: #c98a00; color: #ffb000; }
        .cb-filter-pill.active { background: #ffb000; color: #0b0700; border-color: #ffb000; }

        /* Quick Add Area */
        .cb-quick-add-area { padding: 8px 18px; background: #0b0700; border-bottom: 1px solid #3a2605; flex-shrink: 0; }
        .cb-quick-add-input-wrapper { display: flex; gap: 6px; }
        .cb-quick-input { flex: 1; padding: 7px 10px; border: 1px solid #6b4809; border-radius: 5px; font-size: 12px; background: #080500; color: #ffb000; outline: none; }
        .cb-quick-input:focus { border-color: #ffb000; }
        .cb-btn-primary { font-family: 'Tiny5Mono', monospace; padding: 6px 12px; background: #ffb000; color: #0b0700; border: none; border-radius: 5px; font-size: 11px; font-weight: 700; cursor: pointer; white-space: nowrap; letter-spacing: 0.03em; transition: all 0.15s; }
        .cb-btn-primary:hover { background: #ffd061; }

        /* Items List */
        .cb-list { flex: 1; overflow-y: auto; padding: 12px 18px; display: flex; flex-direction: column; gap: 8px; min-height: 200px; max-height: 440px; background: #0b0700; }
        .cb-empty { padding: 45px 20px; text-align: center; color: #a87300; font-size: 13px; line-height: 1.6; }

        /* Item Card */
        .cb-item { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; background: #130d02; border: 1px solid #6b4809; border-radius: 6px; cursor: pointer; transition: all 0.15s ease; position: relative; flex-shrink: 0; }
        .cb-item:hover, .cb-item.selected { background: #1f1503; border-color: #ffb000; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4); }
        .cb-item.is-pinned { border-left: 3px solid #ffb000; background: rgba(42, 26, 2, 0.25); }
        .cb-item.is-archived { opacity: 0.7; border-style: dashed; }

        .cb-card-top { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #c98a00; }
        .cb-card-meta-left { display: flex; align-items: center; gap: 6px; }
        .cb-type-tag { font-family: 'Tiny5Mono', monospace; font-size: 9px; text-transform: uppercase; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: #2a1a02; color: #ffb000; border: 1px solid #c98a00; letter-spacing: 0.04em; }

        .cb-card-actions { display: flex; align-items: center; gap: 4px; }
        .cb-card-action-btn { background: #080500; border: 1px solid #6b4809; cursor: pointer; padding: 3px 5px; border-radius: 4px; color: #c98a00; display: inline-flex; align-items: center; justify-content: center; min-width: 24px; min-height: 24px; transition: all 0.15s; }
        .cb-card-action-btn:hover { background-color: #1f1503; border-color: #ffb000; color: #ffb000; }
        .cb-card-action-btn.active { color: #ffb000; }

        .cb-item-text { font-size: 12px; color: #ffb000; white-space: pre-wrap; word-break: break-word; max-height: 65px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; line-height: 1.5; cursor: pointer; }

        .cb-media-preview { display: flex; align-items: center; gap: 10px; margin-top: 2px; cursor: pointer; }
        .cb-thumb-img { width: 72px; height: 50px; object-fit: cover; border-radius: 5px; border: 1px solid #6b4809; background: #080500; }
        .cb-video-thumb-box { width: 72px; height: 50px; border-radius: 5px; background: #080500; color: #ffb000; border: 1px solid #6b4809; display: flex; align-items: center; justify-content: center; font-size: 18px; }
        .cb-media-info { display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: #c98a00; }
        .cb-media-info strong { font-size: 12px; color: #ffb000; }
        .cb-drag-handle { font-family: 'Tiny5Mono', monospace; cursor: grab; font-size: 10px; color: #ffb000; padding: 2px 5px; border-radius: 4px; background: #1f1503; border: 1px solid #6b4809; user-select: none; width: fit-content; margin-top: 2px; }
        .cb-drag-handle:active { cursor: grabbing; }

        .cb-card-footer-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 2px; padding-top: 4px; border-top: 1px solid #3a2605; }
        .cb-btn-insert { font-family: 'Tiny5Mono', monospace; background: #080500; color: #ffb000; border: 1px solid #6b4809; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; cursor: pointer; letter-spacing: 0.03em; display: inline-flex; align-items: center; gap: 4px; transition: all 0.15s; }
        .cb-btn-insert:hover { background: #ffb000; color: #0b0700; border-color: #ffb000; }

        /* Footer */
        .cb-footer { padding: 8px 18px; border-top: 1px solid #3a2605; background: #130d02; display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: #c98a00; flex-shrink: 0; }
        .cb-storage-stats { font-family: 'Tiny5Mono', monospace; font-size: 11px; color: #ffb000; }
        .cb-footer-hint { font-family: 'Tiny5Mono', monospace; font-size: 10px; color: #c98a00; }
        kbd { font-family: 'Tiny5Mono', monospace; font-size: 10px; background: #1f1503; border: 1px solid #6b4809; padding: 1px 4px; border-radius: 3px; color: #ffb000; }

        /* Submodals (Settings & Media Lightbox) */
        .cb-submodal-backdrop { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(11, 7, 0, 0.85); backdrop-filter: blur(4px); display: flex; align-items: center; justify-content: center; z-index: 1000; }
        .cb-submodal-content { width: 92%; max-width: 440px; background: #130d02; border-radius: 8px; border: 1px solid #6b4809; box-shadow: 0 16px 36px rgba(0, 0, 0, 0.8); display: flex; flex-direction: column; overflow: hidden; }
        .cb-submodal-header { padding: 12px 14px; border-bottom: 1px solid #3a2605; background: rgba(19, 13, 2, 0.95); display: flex; align-items: center; justify-content: space-between; }
        .cb-submodal-header h3 { font-family: 'Tiny5Mono', monospace; font-size: 13px; font-weight: 700; color: #ffffff; }
        .cb-submodal-body { padding: 14px; display: flex; flex-direction: column; gap: 10px; max-height: 420px; overflow-y: auto; }

        .cb-setting-item { display: flex; flex-direction: column; gap: 4px; }
        .cb-setting-label { font-size: 11px; font-weight: 600; color: #ffb000; }
        .cb-setting-select, .cb-setting-number { padding: 6px 8px; border: 1px solid #6b4809; border-radius: 5px; background: #080500; color: #ffb000; font-size: 11px; outline: none; }
        .cb-setting-select:focus, .cb-setting-number:focus { border-color: #ffb000; }
        .cb-setting-checkbox-label { display: flex; align-items: center; gap: 6px; font-size: 11px; cursor: pointer; color: #ffb000; }
        .cb-setting-hint { font-size: 10px; color: #c98a00; }
        .cb-setting-divider { border: none; border-top: 1px solid #3a2605; margin: 4px 0; }
        .cb-setting-actions { display: flex; flex-direction: column; gap: 6px; }
        .cb-btn-danger { font-family: 'Tiny5Mono', monospace; padding: 6px; background: rgba(242, 77, 92, 0.15); color: #ff8a95; border: 1px solid rgba(242, 77, 92, 0.4); border-radius: 5px; font-size: 11px; font-weight: 700; cursor: pointer; }
        .cb-btn-danger:hover { background: rgba(242, 77, 92, 0.25); border-color: #f24d5c; }
        .cb-btn-danger-outline { font-family: 'Tiny5Mono', monospace; padding: 6px; background: none; border: 1px solid #6b4809; color: #c98a00; border-radius: 5px; font-size: 11px; font-weight: 700; cursor: pointer; }
        .cb-btn-danger-outline:hover { border-color: #f24d5c; color: #ff8a95; }
        .cb-privacy-note { font-size: 10px; color: #c98a00; background: #080500; border: 1px solid #3a2605; padding: 8px 10px; border-radius: 5px; line-height: 1.4; }
        .cb-privacy-badge { font-family: 'Tiny5Mono', monospace; color: #ffb000; font-weight: 700; display: inline-flex; align-items: center; margin-right: 4px; }

        .cb-media-modal-body { padding: 14px; display: flex; align-items: center; justify-content: center; max-height: 380px; overflow: auto; background: #080500; }
        .cb-media-modal-body img { max-width: 100%; max-height: 340px; object-fit: contain; border-radius: 5px; }
        .cb-media-modal-body video { max-width: 100%; max-height: 340px; border-radius: 5px; }

        /* ===== AMBER TERMINAL THEME + ANIMATIONS ===== */
        :host { color: #ffb000; font-family: 'Tiny5Mono', monospace; font-size: 14px; }
        *, *::before, *::after { border-radius: 0 !important; font-family: 'Tiny5Mono', monospace; }
        .cb-modal { background: #130d02; border: 1px solid #ffb000; box-shadow: 0 0 28px rgba(255,176,0,.3), 0 20px 48px rgba(0,0,0,.8); text-shadow: 0 0 5px rgba(255,176,0,.5); }
        .cb-modal::after { content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 50; background: repeating-linear-gradient(0deg, rgba(0,0,0,.26) 0 1px, transparent 1px 3px); box-shadow: inset 0 0 60px rgba(0,0,0,.6); }
        .cb-modal::before { content: ""; position: absolute; left: 0; right: 0; top: -80px; height: 80px; pointer-events: none; z-index: 49; background: linear-gradient(180deg, transparent, rgba(255,176,0,.07), transparent); animation: cbRefresh 7s linear infinite; }
        .cb-backdrop { background: rgba(8,5,0,.8); backdrop-filter: none; }
        .cb-header, .cb-footer { background: #130d02; border-color: #6b4809; }
        .cb-title-area { color: #ffb000; text-shadow: 0 0 8px rgba(255,176,0,.8); }
        .cb-title-area::before { content: "> "; }
        .cb-title-area::after { content: "\\2588"; margin-left: 5px; font-size: 12px; animation: cbBlink 1.06s steps(1) infinite; }
        .cb-offline-pill { background: #2a1a02; border: 1px solid #c98a00; color: #ffb000; }
        .cb-btn-icon, .cb-card-action-btn, .cb-filter-pill, .cb-btn-insert { background: #130d02; border: 1px solid #6b4809; color: #c98a00; transition: background .12s steps(3), color .12s steps(3), border-color .12s, box-shadow .12s; }
        .cb-btn-icon:hover, .cb-card-action-btn:hover, .cb-filter-pill:hover { background: #130d02; border-color: #ffb000; color: #ffb000; box-shadow: 0 0 8px rgba(255,176,0,.35); }
        .cb-filter-pill.active, .cb-btn-primary, .cb-btn-insert:hover { background: #ffb000; color: #0b0700; border-color: #ffb000; text-shadow: none; }
        .cb-btn-icon:active, .cb-card-action-btn:active, .cb-filter-pill:active, .cb-btn-primary:active, .cb-btn-insert:active { transform: translate(1px,1px); filter: brightness(1.5); }
        .cb-search-area, .cb-filters, .cb-quick-add-area { background: #0b0700; border-color: #3a2605; }
        .cb-search-input, .cb-quick-input, .cb-setting-select, .cb-setting-number { background: #080500; border: 1px solid #6b4809; color: #ffb000; caret-color: #ffb000; }
        .cb-search-input:focus { border-color: #ffb000; box-shadow: none; animation: cbGlow 1.8s ease-in-out infinite; }
        .cb-list { background: #0b0700; }
        .cb-item { background: #130d02; border: 1px solid #6b4809; transition: border-color .12s, box-shadow .12s, background .12s, transform .12s steps(3); }
        .cb-item:hover, .cb-item.selected { background: #1f1503; border-color: #ffb000; box-shadow: 0 0 12px rgba(255,176,0,.25); transform: translateX(2px); }
        .cb-item-text::before { content: "> "; color: #c98a00; }
        .cb-item.selected .cb-item-text::after { content: "\\2588"; margin-left: 3px; animation: cbBlink 1s steps(1) infinite; }
        .cb-type-tag { background: #2a1a02; color: #ffb000; border: 1px solid #c98a00; }
        .cb-pinned-badge { color: #0b0700; background: #ffb000; border: none; text-shadow: none; }
        .cb-thumb-img { border: 1px solid #6b4809; filter: sepia(1) saturate(2.5) hue-rotate(-12deg) brightness(.95); }
        .cb-video-thumb-box { border: 1px solid #6b4809; }
        .cb-card-footer-actions { border-top: 1px dashed #6b4809; }
        .cb-storage-stats { color: #ffb000; }
        .cb-submodal-content { background: #130d02; border: 1px solid #ffb000; box-shadow: 0 0 24px rgba(255,176,0,.25); animation: cbCrtOn .4s cubic-bezier(.2,.7,.2,1) both; }
        .cb-submodal-header { background: #130d02; border-color: #6b4809; color: #ffb000; }
        .cb-submodal-backdrop { background: rgba(8,5,0,.82); backdrop-filter: none; }
        .cb-toast { background: #1f1503; color: #ffb000; border: 1px solid #ffb000; box-shadow: 0 0 14px rgba(255,176,0,.35); animation: cbToastIn .28s steps(5) both; }
        .cb-list::-webkit-scrollbar { width: 8px; } .cb-list::-webkit-scrollbar-track { background: #080500; } .cb-list::-webkit-scrollbar-thumb { background: #6b4809; } .cb-list::-webkit-scrollbar-thumb:hover { background: #ffb000; }
        .pixel-icon, .pixel-icon-header, .pixel-icon-btn, .pixel-icon-tab, .pixel-icon-action, .pixel-icon-inline, .pixel-icon-xs {
          filter: drop-shadow(0 0 3px rgba(255, 176, 0, .28));
        }

        /* Boot sequence */
        .cb-modal.crt-boot { animation: cbCrtOn .6s cubic-bezier(.2,.7,.2,1) both; transform-origin: center; }
        .crt-boot .cb-title-area { animation: cbType .7s steps(10) .5s both; }
        .crt-boot .cb-search-area, .crt-boot .cb-filters, .crt-boot .cb-quick-add-area { animation: cbLineIn .3s steps(5) .35s both; }
        .crt-boot .cb-item { animation: cbLineIn .32s steps(6) both; }
        .crt-boot .cb-item:nth-child(1) { animation-delay: .55s; } .crt-boot .cb-item:nth-child(2) { animation-delay: .63s; }
        .crt-boot .cb-item:nth-child(3) { animation-delay: .71s; } .crt-boot .cb-item:nth-child(4) { animation-delay: .79s; }
        .crt-boot .cb-item:nth-child(n+5) { animation-delay: .87s; }
        @keyframes cbCrtOn { 0% { transform: scale(.2,.004); filter: brightness(5); } 35% { transform: scale(1,.004); filter: brightness(3.5); } 70% { transform: scale(1,1.03); filter: brightness(1.7); } 100% { transform: none; filter: none; } }
        @keyframes cbLineIn { from { opacity: 0; clip-path: inset(0 100% 0 0); transform: translateX(-8px); } to { opacity: 1; clip-path: inset(0 0 0 0); transform: none; } }
        @keyframes cbType { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
        @keyframes cbBlink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
        @keyframes cbRefresh { to { transform: translateY(800px); } }
        @keyframes cbGlow { 0%, 100% { box-shadow: 0 0 0 rgba(255,176,0,0); } 50% { box-shadow: 0 0 10px rgba(255,176,0,.45); } }
        @keyframes cbToastIn { from { opacity: 0; transform: translateY(8px) skewX(-10deg); } to { opacity: 1; transform: none; } }
        @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
      `;
      shadowRoot.appendChild(styleEl);
    }
  }

  // Toggle Panel
  function togglePanel() {
    if (isOpen) {
      closePanel();
    } else {
      openPanel();
    }
  }

  async function openPanel() {
    ensureHostCreated();
    isOpen = true;
    try {
      const cap = await chrome.runtime.sendMessage({ type: 'GET_CAPABILITIES' });
      if (cap && cap.success) {
        sidePanelSupported = Boolean(cap.sidePanelSupported);
      }
    } catch (e) {}
    renderModal();

    // Auto-sync system clipboard (both images and text)
    try {
      if (navigator.clipboard) {
        if (navigator.clipboard.read) {
          try {
            const clipItems = await navigator.clipboard.read();
            for (const it of clipItems) {
              const imgType = it.types.find(t => t.startsWith('image/'));
              if (imgType) {
                const blob = await it.getType(imgType);
                if (blob && blob.size > 0) {
                  const reader = new FileReader();
                  reader.onloadend = async () => {
                    if (reader.result) {
                      await chrome.runtime.sendMessage({
                        type: 'AUTO_CAPTURE_IMAGE',
                        dataUrl: reader.result,
                        size: blob.size,
                        mimeType: blob.type || 'image/png',
                        title: `Фото (${Math.round(blob.size / 1024)} КБ)`
                      }).catch(() => {});
                      await loadItems();
                      await updateStats();
                    }
                  };
                  reader.readAsDataURL(blob);
                }
              }
            }
          } catch (imgErr) {}
        }

        if (navigator.clipboard.readText) {
          const clipText = await navigator.clipboard.readText();
          if (clipText && clipText.trim()) {
            await chrome.runtime.sendMessage({
              type: 'AUTO_CAPTURE_TEXT',
              text: clipText.trim()
            }).catch(() => {});
          }
        }
      }
    } catch (e) {}

    await loadItems();
    await updateStats();
  }

  function closePanel() {
    isOpen = false;
    const modal = shadowRoot ? shadowRoot.querySelector('.cb-backdrop') : null;
    if (modal) modal.remove();
  }

  // Render Modal UI skeleton
  function renderModal() {
    const oldBackdrop = shadowRoot.querySelector('.cb-backdrop');
    if (oldBackdrop) oldBackdrop.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'cb-backdrop';
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closePanel();
    });

    const notepadUrl = chrome.runtime.getURL('icons/pixel/png/clipboard.png');
    const pinUrl = chrome.runtime.getURL('icons/pixel/png/pin.png');
    const archiveUrl = chrome.runtime.getURL('icons/pixel/png/archive.png');
    const gearUrl = chrome.runtime.getURL('icons/pixel/png/gear.png');
    const imageIconUrl = chrome.runtime.getURL('icons/pixel/png/image.png');
    const sidepanelUrl = chrome.runtime.getURL('icons/pixel/png/sidepanel.png');

    const closeBtn = el('button', { className: 'cb-close-btn', id: 'cb-close-x', title: 'Закрыть (Esc)', textContent: '✕' });
    const sidepanelBtn = el('button', {
      className: 'cb-btn-icon',
      id: 'cb-sidepanel-btn',
      title: 'Открыть в боковой панели (Side Panel)',
      style: sidePanelSupported ? null : { display: 'none' }
    }, [el('img', { src: sidepanelUrl, className: 'pixel-icon pixel-icon-btn', alt: 'Side Panel' })]);
    const settingsBtn = el('button', { className: 'cb-btn-icon', id: 'cb-settings-btn', title: 'Настройки' }, [
      el('img', { src: gearUrl, className: 'pixel-icon pixel-icon-btn', alt: '⚙' })
    ]);

    const searchInput = el('input', {
      type: 'text',
      className: 'cb-search-input',
      id: 'cb-search-field',
      placeholder: 'Поиск по истории... (Esc для выхода)',
      autofocus: true,
      autocomplete: 'off'
    });
    const searchClear = el('button', {
      className: 'cb-search-clear',
      id: 'cb-search-clear',
      style: { display: 'none' },
      title: 'Очистить',
      textContent: '✕'
    });

    const filterDefs = [
      { id: 'all', label: 'ВСЕ' },
      { id: 'text', label: 'ТЕКСТ' },
      { id: 'image', label: 'ФОТО' },
      { id: 'video', label: 'ВИДЕО' },
      { id: 'pinned', label: ' ЗАКРЕП', icon: pinUrl },
      { id: 'archived', label: ' АРХИВ', icon: archiveUrl }
    ];
    const filterButtons = filterDefs.map(def => el('button', {
      className: `cb-filter-pill${def.id === currentFilter ? ' active' : ''}`,
      dataset: { filter: def.id }
    }, [
      def.icon ? el('img', { src: def.icon, className: 'pixel-icon pixel-icon-tab', alt: '' }) : null,
      def.label
    ]));

    const filePicker = el('input', { type: 'file', id: 'cb-file-picker', accept: 'image/*,video/*', style: { display: 'none' } });
    const quickInput = el('input', { type: 'text', className: 'cb-quick-input', id: 'cb-quick-input', placeholder: 'Добавить запись вручную...' });
    const quickAddBtn = el('button', { className: 'cb-btn-primary', id: 'cb-quick-add-btn', textContent: 'ДОБАВИТЬ' });

    const modalEl = el('div', { className: 'cb-modal' }, [
      el('div', { className: 'cb-header' }, [
        el('div', { className: 'cb-header-left' }, [
          el('div', { className: 'cb-title-area' }, [
            el('img', { src: notepadUrl, className: 'pixel-icon pixel-icon-header', alt: '' }),
            el('span', { textContent: 'CLIPBOARD' })
          ]),
          el('span', { className: 'cb-header-stats', id: 'cb-header-stats', textContent: '...' })
        ]),
        el('div', { className: 'cb-header-right' }, [sidepanelBtn, settingsBtn, closeBtn])
      ]),
      el('div', { className: 'cb-search-area' }, [searchInput, searchClear]),
      el('div', { className: 'cb-filters' }, filterButtons),
      el('div', { className: 'cb-quick-add-area' }, [
        el('div', { className: 'cb-quick-add-input-wrapper' }, [
          el('label', {
            className: 'cb-btn-icon',
            style: { cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
            title: 'Загрузить фото/видео с диска'
          }, [
            filePicker,
            el('img', { src: imageIconUrl, className: 'pixel-icon', style: { width: '16px', height: '16px' }, alt: '📁' })
          ]),
          quickInput,
          quickAddBtn
        ])
      ]),
      el('div', { className: 'cb-list', id: 'cb-items-container' }, [
        el('div', { className: 'cb-empty', textContent: 'Загрузка данных...' })
      ]),
      el('div', { className: 'cb-footer' }, [
        el('span', { className: 'cb-storage-stats', id: 'cb-footer-stats', textContent: '0 зап. • 0 МБ' }),
        el('span', { className: 'cb-footer-hint' }, [
          el('kbd', { textContent: '↑' }),
          el('kbd', { textContent: '↓' }),
          ' Навигация • ',
          el('kbd', { textContent: 'Enter' }),
          ' Вставить • ',
          el('kbd', { textContent: 'Esc' }),
          ' Закрыть'
        ])
      ]),
      el('div', { id: 'cb-submodal-slot' })
    ]);

    backdrop.appendChild(modalEl);
    shadowRoot.appendChild(backdrop);

    // Refresh rate adaptive pixel entrance
    playPixelEntrance(modalEl);

    // Close button
    closeBtn.addEventListener('click', closePanel);

    // Search events
    setTimeout(() => searchInput.focus(), 60);

    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      searchClear.style.display = searchQuery ? 'block' : 'none';
      loadItems();
    });

    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchQuery = '';
      searchClear.style.display = 'none';
      loadItems();
    });

    // Keyboard navigation
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closePanel();
        e.preventDefault();
      } else if (e.key === 'ArrowDown') {
        selectedIndex = Math.min(selectedIndex + 1, itemsList.length - 1);
        updateSelectionHighlight();
        e.preventDefault();
      } else if (e.key === 'ArrowUp') {
        selectedIndex = Math.max(selectedIndex - 1, 0);
        updateSelectionHighlight();
        e.preventDefault();
      } else if (e.key === 'Enter') {
        if (itemsList[selectedIndex]) {
          handleItemAction(itemsList[selectedIndex]);
        }
        e.preventDefault();
      }
    });

    // Filter pills
    const pills = backdrop.querySelectorAll('.cb-filter-pill');
    pills.forEach(pill => {
      pill.addEventListener('click', () => {
        pills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        currentFilter = pill.dataset.filter;
        loadItems();
      });
    });

    // Quick Add
    quickAddBtn.addEventListener('click', handleQuickAdd);
    quickInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleQuickAdd();
    });

    // File Picker upload listener
    if (filePicker) {
      filePicker.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        for (const file of files) {
          const isImg = file.type.startsWith('image/');
          const isVid = file.type.startsWith('video/');
          if (isImg || isVid) {
            const reader = new FileReader();
            reader.onloadend = async () => {
              if (reader.result) {
                await chrome.runtime.sendMessage({
                  type: 'AUTO_CAPTURE_IMAGE',
                  itemType: isImg ? 'image' : 'video',
                  manual: true,
                  dataUrl: reader.result,
                  size: file.size,
                  mimeType: file.type,
                  title: file.name || (isImg ? 'Фото' : 'Видео')
                }).catch(() => {});
                showToast(`✓ ${isImg ? 'Фото' : 'Видео'} сохранено`);
                await loadItems();
                await updateStats();
              }
            };
            reader.readAsDataURL(file);
          }
        }
        filePicker.value = '';
      });
    }

    // Paste listener (Ctrl+V) for photos and text into floating modal
    backdrop.addEventListener('paste', async (e) => {
      const items = e.clipboardData ? e.clipboardData.items : [];
      for (const it of items) {
        if (it.type.startsWith('image/')) {
          const file = it.getAsFile();
          if (file) {
            e.preventDefault();
            const reader = new FileReader();
            reader.onloadend = async () => {
              if (reader.result) {
                await chrome.runtime.sendMessage({
                  type: 'AUTO_CAPTURE_IMAGE',
                  manual: true,
                  dataUrl: reader.result,
                  size: file.size,
                  mimeType: file.type || 'image/png',
                  title: `Вставлено фото (${Math.round(file.size / 1024)} КБ)`
                }).catch(() => {});
                showToast('✓ Фото вставлено в Clipboard');
                await loadItems();
                await updateStats();
              }
            };
            reader.readAsDataURL(file);
            break;
          }
        }
      }
    });

    // Drag-and-drop listener for external files
    backdrop.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    backdrop.addEventListener('drop', async (e) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files || []);
      for (const file of files) {
        const isImg = file.type.startsWith('image/');
        const isVid = file.type.startsWith('video/');
        if (isImg || isVid) {
          const reader = new FileReader();
          reader.onloadend = async () => {
            if (reader.result) {
              await chrome.runtime.sendMessage({
                type: 'AUTO_CAPTURE_IMAGE',
                itemType: isImg ? 'image' : 'video',
                manual: true,
                dataUrl: reader.result,
                size: file.size,
                mimeType: file.type,
                title: file.name || (isImg ? 'Фото' : 'Видео')
              }).catch(() => {});
              showToast(`✓ ${isImg ? 'Фото' : 'Видео'} сохранено`);
              await loadItems();
              await updateStats();
            }
          };
          reader.readAsDataURL(file);
        }
      }
    });

    // Sidepanel button
    if (sidepanelBtn) {
      sidepanelBtn.addEventListener('click', async () => {
        closePanel();
        try {
          await chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
        } catch (e) {}
      });
    }

    // Settings button
    if (settingsBtn) {
      settingsBtn.addEventListener('click', openSettingsModal);
    }
  }

  // Quick Manual Add
  async function handleQuickAdd() {
    const input = shadowRoot.querySelector('#cb-quick-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    try {
      const res = await chrome.runtime.sendMessage({
        type: 'ADD_ITEM',
        payload: {
          type: 'text',
          textPayload: text,
          title: text.slice(0, 50)
        }
      });
      if (res && res.success) {
        input.value = '';
        showToast('✓ Запись добавлена');
        await loadItems();
        await updateStats();
      }
    } catch (err) {
      showToast('Ошибка при добавлении записи', 'error');
    }
  }

  // Update storage & count stats
  async function updateStats() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_STATS' });
      if (res && res.success && res.stats) {
        const mb = (res.stats.totalSizeBytes / (1024 * 1024)).toFixed(1);
        const text = `${res.stats.totalCount} зап. • ${mb} МБ`;
        const headerStats = shadowRoot.querySelector('#cb-header-stats');
        if (headerStats) headerStats.textContent = text;
        const footerStats = shadowRoot.querySelector('#cb-footer-stats');
        if (footerStats) footerStats.textContent = text;
      }
    } catch (e) {}
  }

  // Load items from service worker
  async function loadItems() {
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_ITEMS',
        params: {
          filter: currentFilter,
          search: searchQuery,
          showArchived: currentFilter === 'archived'
        }
      });

      if (response && response.success) {
        itemsList = response.items || [];
        selectedIndex = 0;
        renderItemsList();
      }
    } catch (err) {
      console.error('Failed to load items:', err);
    }
  }

  // Render items inside list container
  function renderItemsList() {
    const container = shadowRoot.querySelector('#cb-items-container');
    if (!container) return;

    container.textContent = '';

    if (itemsList.length === 0) {
      const emptyEl = el('div', { className: 'cb-empty' });
      if (searchQuery) {
        emptyEl.textContent = 'Ничего не найдено';
      } else {
        emptyEl.appendChild(document.createTextNode('История буфера пуста.'));
        emptyEl.appendChild(document.createElement('br'));
        emptyEl.appendChild(document.createTextNode('Копируйте текст (Ctrl+C) или сохраняйте картинки через ПКМ!'));
      }
      container.appendChild(emptyEl);
      return;
    }

    const notepadUrl = chrome.runtime.getURL('icons/pixel/png/clipboard.png');
    const pinUrl = chrome.runtime.getURL('icons/pixel/png/pin.png');
    const pinActiveUrl = chrome.runtime.getURL('icons/pixel/png/pin-active.png');
    const trashUrl = chrome.runtime.getURL('icons/pixel/png/trash.png');
    const trashOpenUrl = chrome.runtime.getURL('icons/pixel/png/trash-open.png');
    const archiveUrl = chrome.runtime.getURL('icons/pixel/png/archive.png');
    const videoIconUrl = chrome.runtime.getURL('icons/pixel/png/video.png');

    itemsList.forEach((item, index) => {
      const card = document.createElement('div');
      card.className = `cb-item ${index === selectedIndex ? 'selected' : ''} ${item.pinned ? 'is-pinned' : ''} ${item.archived ? 'is-archived' : ''}`;
      card.dataset.id = item.id;

      // Enable Drag and drop for media
      if (item.type === 'image' || item.type === 'video') {
        card.setAttribute('draggable', 'true');
        card.addEventListener('dragstart', (e) => handleDragStart(e, item));
      }

      const dateStr = formatTimestamp(item.createdAt);

      const metaLeft = el('div', { className: 'cb-card-meta-left' }, [
        el('span', { className: 'cb-type-tag', textContent: item.type }),
        el('span', { textContent: dateStr }),
        item.pinned ? el('span', { className: 'cb-pinned-badge' }, [
          el('img', { src: pinActiveUrl, className: 'pixel-icon-xs', alt: '' }),
          ' ЗАКРЕП'
        ]) : null,
        item.archived ? el('span', { className: 'cb-archived-badge' }, [
          el('img', { src: archiveUrl, className: 'pixel-icon-xs', alt: '' }),
          ' АРХИВ'
        ]) : null
      ]);

      const trashIcon = el('img', { src: trashUrl, className: 'pixel-icon-action trash-icon', alt: 'del' });
      const delBtn = el('button', {
        className: 'cb-card-action-btn cb-delete-btn',
        title: 'Удалить',
        dataset: { action: 'delete' }
      }, [trashIcon]);

      const pinBtn = el('button', {
        className: `cb-card-action-btn ${item.pinned ? 'active' : ''}`,
        title: item.pinned ? 'Открепить' : 'Закрепить',
        dataset: { action: 'pin' }
      }, [
        el('img', {
          src: item.pinned ? pinActiveUrl : pinUrl,
          className: 'pixel-icon-action',
          alt: 'pin'
        })
      ]);

      const cardTop = el('div', { className: 'cb-card-top' }, [
        metaLeft,
        el('div', { className: 'cb-card-actions' }, [pinBtn, delBtn])
      ]);

      let thumbImg = null;
      let contentEl;
      if (item.type === 'image') {
        thumbImg = el('img', { src: item.previewUrl || '', className: 'cb-thumb-img', alt: 'Фото' });
        contentEl = el('div', { className: 'cb-media-preview', title: 'Нажмите для увеличения' }, [
          thumbImg,
          el('div', { className: 'cb-media-info' }, [
            el('strong', { textContent: item.title || '' }),
            el('span', { textContent: `${Math.round(item.size / 1024)} КБ ${item.archived ? '• сжато (WebP)' : ''}` }),
            el('span', { className: 'cb-drag-handle', textContent: '⠿ ПЕРЕТАЩИТЬ' })
          ])
        ]);
      } else if (item.type === 'video') {
        contentEl = el('div', { className: 'cb-media-preview', title: 'Нажмите для просмотра видео' }, [
          el('div', { className: 'cb-video-thumb-box' }, [
            el('img', { src: videoIconUrl, className: 'pixel-icon', style: { width: '24px', height: '24px' }, alt: '' })
          ]),
          el('div', { className: 'cb-media-info' }, [
            el('strong', { textContent: item.title || '' }),
            el('span', { textContent: `${(item.size / (1024 * 1024)).toFixed(1)} МБ` }),
            el('span', { className: 'cb-drag-handle', textContent: '⠿ ПЕРЕТАЩИТЬ' })
          ])
        ]);
      } else {
        contentEl = el('div', {
          className: 'cb-item-text',
          title: 'Нажмите для вставки или копирования',
          textContent: item.textPayload || ''
        });
      }

      const actionLabel = lastActiveInput
        ? 'ВСТАВИТЬ В ПОЛЕ'
        : (item.type === 'image' ? 'КОПИРОВАТЬ ФОТО' : (item.type === 'video' ? 'СКАЧАТЬ ВИДЕО' : 'КОПИРОВАТЬ'));
      const footerEl = el('div', { className: 'cb-card-footer-actions' }, [
        el('button', { className: 'cb-btn-insert', dataset: { action: 'insert' } }, [
          el('img', { src: notepadUrl, className: 'pixel-icon-xs', alt: '' }),
          ` ${actionLabel}`
        ])
      ]);

      card.appendChild(cardTop);
      card.appendChild(contentEl);
      card.appendChild(footerEl);

      // Interactive trash lid hover
      delBtn.addEventListener('mouseenter', () => {
        trashIcon.src = trashOpenUrl;
      });
      delBtn.addEventListener('mouseleave', () => {
        trashIcon.src = trashUrl;
      });

      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-action="pin"]')) {
          e.stopPropagation();
          togglePinItem(item.id);
        } else if (e.target.closest('[data-action="delete"]')) {
          e.stopPropagation();
          deleteItem(item.id);
        } else if (e.target.closest('.cb-media-preview')) {
          e.stopPropagation();
          openMediaModal(item);
        } else {
          handleItemAction(item);
        }
      });

      container.appendChild(card);

      // Lazy load image preview if thumbnail data is missing
      if (item.type === 'image' && !item.previewUrl && thumbImg) {
        (async () => {
          try {
            const res = await chrome.runtime.sendMessage({ type: 'GET_ITEM_BLOB', id: item.id });
            if (res && res.success && res.dataUrl) {
              thumbImg.src = res.dataUrl;
            }
          } catch (e) {}
        })();
      }
    });
  }

  function updateSelectionHighlight() {
    const cards = shadowRoot.querySelectorAll('.cb-item');
    cards.forEach((card, idx) => {
      if (idx === selectedIndex) {
        card.classList.add('selected');
        card.scrollIntoView({ block: 'nearest' });
      } else {
        card.classList.remove('selected');
      }
    });
  }

  async function handleDragStart(e, item) {
    try {
      e.dataTransfer.effectAllowed = 'copy';
      const res = await chrome.runtime.sendMessage({ type: 'GET_ITEM_BLOB', id: item.id });
      if (res && res.success && res.dataUrl) {
        const resp = await fetch(res.dataUrl);
        const blob = await resp.blob();
        const ext = item.type === 'image' ? (blob.type.includes('webp') ? 'webp' : 'png') : 'mp4';
        const file = new File([blob], `clipboard_${item.id}.${ext}`, { type: blob.type });

        if (e.dataTransfer.items && e.dataTransfer.items.add) {
          e.dataTransfer.items.add(file);
        }
      }
    } catch (err) {
      console.warn('DragStart error:', err);
    }
  }

  async function handleItemAction(item) {
    if (item.type === 'text' || item.type === 'link') {
      const text = item.textPayload || '';
      if (lastActiveInput && document.contains(lastActiveInput)) {
        insertTextIntoElement(lastActiveInput, text);
        closePanel();
        showToast('✓ Текст вставлен в поле');
      } else {
        try {
          await navigator.clipboard.writeText(text);
          closePanel();
          showToast('✓ Текст скопирован в буфер обмена');
        } catch (e) {
          fallbackCopyText(text);
          closePanel();
          showToast('✓ Текст скопирован');
        }
      }
    } else if (item.type === 'image') {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'GET_ITEM_BLOB', id: item.id });
        if (res && res.success && res.dataUrl) {
          const resp = await fetch(res.dataUrl);
          const rawBlob = await resp.blob();
          
          let pngBlob = rawBlob;
          if (rawBlob.type !== 'image/png') {
            pngBlob = await convertBlobToPng(rawBlob);
          }

          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': pngBlob })
          ]);

          closePanel();
          showToast('✓ Фото скопировано! Нажмите Ctrl+V для вставки');
        }
      } catch (err) {
        console.error('Image clipboard copy error:', err);
        closePanel();
        showToast('Ошибка копирования фото в буфер', 'error');
      }
    } else if (item.type === 'video') {
      try {
        if (item.textPayload) {
          await navigator.clipboard.writeText(item.textPayload);
          closePanel();
          showToast('✓ Ссылка на видео скопирована в буфер');
        } else {
          const res = await chrome.runtime.sendMessage({ type: 'GET_ITEM_BLOB', id: item.id });
          if (res && res.success && res.dataUrl) {
            const a = document.createElement('a');
            a.href = res.dataUrl;
            a.download = `video_${item.id}.mp4`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            closePanel();
            showToast('✓ Видео сохранено на диск');
          }
        }
      } catch (err) {
        closePanel();
        showToast('Ошибка при работе с видео', 'error');
      }
    }
  }

  function convertBlobToPng(blob) {
    return new Promise((resolve) => {
      const objUrl = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          canvas.toBlob((b) => resolve(b || blob), 'image/png');
        } catch (e) {
          resolve(blob);
        } finally {
          URL.revokeObjectURL(objUrl);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        resolve(blob);
      };
      img.src = objUrl;
    });
  }

  function insertTextIntoElement(el, text) {
    el.focus();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const start = el.selectionStart || 0;
      const end = el.selectionEnd || 0;
      const val = el.value || '';
      el.value = val.substring(0, start) + text + val.substring(end);
      el.selectionStart = el.selectionEnd = start + text.length;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (el.isContentEditable) {
      document.execCommand('insertText', false, text);
    }
  }

  function fallbackCopyText(text) {
    const t = document.createElement('textarea');
    t.value = text;
    t.style.position = 'fixed';
    t.style.left = '-9999px';
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    document.body.removeChild(t);
  }

  async function togglePinItem(id) {
    const res = await chrome.runtime.sendMessage({ type: 'TOGGLE_PIN', id });
    if (res && res.success) {
      await loadItems();
      await updateStats();
    }
  }

  async function deleteItem(id) {
    const res = await chrome.runtime.sendMessage({ type: 'DELETE_ITEM', id });
    if (res && res.success) {
      await loadItems();
      await updateStats();
      showToast('Запись удалена');
    }
  }

  // Settings Submodal
  async function openSettingsModal() {
    const slot = shadowRoot.querySelector('#cb-submodal-slot');
    if (!slot) return;

    let settings = {};
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (res && res.success) settings = res.settings || {};
    } catch (e) {}

    const lockUrl = chrome.runtime.getURL('icons/pixel/png/lock.png');

    const closeBtn = el('button', { className: 'cb-close-btn', id: 'cb-submodal-close', textContent: '✕' });

    const modeOptions = [
      el('option', { value: 'floating', textContent: 'Всплывающее окно на странице' }),
      sidePanelSupported ? el('option', { value: 'sidepanel', textContent: 'Боковая панель Chrome (Side Panel)' }) : null,
      el('option', { value: 'popup', textContent: 'Попап в тулбаре браузера' })
    ];
    const modeSelect = el('select', { id: 'cb-set-display-mode', className: 'cb-setting-select' }, modeOptions);
    const currentMode = settings.displayMode || 'floating';
    modeSelect.value = (!sidePanelSupported && currentMode === 'sidepanel') ? 'floating' : currentMode;

    const autoCap = el('input', { type: 'checkbox', id: 'cb-set-auto-capture', checked: settings.autoCapture !== false });
    const maxAct = el('input', {
      type: 'number',
      id: 'cb-set-max-active',
      min: '10',
      max: '500',
      value: String(settings.maxActiveItems || 50),
      className: 'cb-setting-number'
    });
    const comp = el('input', { type: 'checkbox', id: 'cb-set-compression', checked: settings.compressionEnabled !== false });
    const retention = el('input', {
      type: 'number',
      id: 'cb-set-retention',
      min: '0',
      max: '3650',
      value: String(Number(settings.retentionDays) || 0),
      className: 'cb-setting-number'
    });
    const excluded = el('textarea', {
      id: 'cb-set-excluded',
      rows: 3,
      className: 'cb-setting-number',
      style: { width: '100%', resize: 'vertical' },
      placeholder: 'bank.example.com',
      value: (settings.excludedSites || []).join('\n')
    });

    const clearUnpinnedBtn = el('button', { className: 'cb-btn-danger', id: 'cb-btn-clear-unpinned', textContent: 'Очистить незакрепленные' });
    const clearAllBtn = el('button', { className: 'cb-btn-danger-outline', id: 'cb-btn-clear-all', textContent: 'Очистить ВСЮ историю' });

    const submodal = el('div', { className: 'cb-submodal-backdrop' }, [
      el('div', { className: 'cb-submodal-content' }, [
        el('div', { className: 'cb-submodal-header' }, [
          el('h3', { textContent: 'НАСТРОЙКИ CLIPBOARD' }),
          closeBtn
        ]),
        el('div', { className: 'cb-submodal-body' }, [
          el('div', { className: 'cb-setting-item' }, [
            el('label', { className: 'cb-setting-label', textContent: 'Где открывать по умолчанию:' }),
            modeSelect
          ]),
          el('div', { className: 'cb-setting-item' }, [
            el('label', { className: 'cb-setting-checkbox-label' }, [
              autoCap,
              el('span', { textContent: 'Автосохранение при копировании (Ctrl+C в браузере)' })
            ])
          ]),
          el('div', { className: 'cb-setting-item' }, [
            el('label', { className: 'cb-setting-label', textContent: 'Порог активных записей перед архивацией:' }),
            maxAct,
            el('small', { className: 'cb-setting-hint', textContent: 'Записи старше этого количества сжимаются (WebP для фото) и уходят в архив.' })
          ]),
          el('div', { className: 'cb-setting-item' }, [
            el('label', { className: 'cb-setting-checkbox-label' }, [
              comp,
              el('span', { textContent: 'Сжатие архивных фото в WebP для экономии диска' })
            ])
          ]),
          el('div', { className: 'cb-setting-item' }, [
            el('label', { className: 'cb-setting-label', textContent: 'Автоудаление незакрепленных записей (дней, 0 = никогда):' }),
            retention,
            el('small', { className: 'cb-setting-hint', textContent: 'Закрепленные записи не удаляются никогда.' })
          ]),
          el('div', { className: 'cb-setting-item' }, [
            el('label', { className: 'cb-setting-label', textContent: 'Не сохранять автоматически на сайтах (по одному в строке):' }),
            excluded,
            el('small', { className: 'cb-setting-hint', textContent: 'Подходят и поддомены. Ручное сохранение через меню работает везде.' })
          ]),
          el('hr', { className: 'cb-setting-divider' }),
          el('div', { className: 'cb-setting-actions' }, [clearUnpinnedBtn, clearAllBtn]),
          el('div', { className: 'cb-privacy-note' }, [
            el('span', { className: 'cb-privacy-badge' }, [
              el('img', { src: lockUrl, className: 'pixel-icon-xs', alt: '' }),
              ' 100% ЛОКАЛЬНО:'
            ]),
            ' Все записи сохраняются на вашем диске в хранилище браузера и защищены от стирания при перезагрузке ПК. Ни один байт не отправляется в сеть.'
          ])
        ])
      ])
    ]);

    slot.textContent = '';
    slot.appendChild(submodal);

    closeBtn.addEventListener('click', () => submodal.remove());
    submodal.addEventListener('click', (e) => {
      if (e.target === submodal) submodal.remove();
    });

    // Setting inputs listeners
    modeSelect.addEventListener('change', async () => {
      await chrome.runtime.sendMessage({ type: 'SET_SETTING', key: 'displayMode', value: modeSelect.value });
      showToast('✓ Настройка сохранена');
    });

    autoCap.addEventListener('change', async () => {
      await chrome.runtime.sendMessage({ type: 'SET_SETTING', key: 'autoCapture', value: autoCap.checked });
      showToast('✓ Настройка сохранена');
    });

    maxAct.addEventListener('change', async () => {
      const v = parseInt(maxAct.value, 10) || 50;
      await chrome.runtime.sendMessage({ type: 'SET_SETTING', key: 'maxActiveItems', value: v });
      showToast('✓ Порог архивации обновлен');
    });

    comp.addEventListener('change', async () => {
      await chrome.runtime.sendMessage({ type: 'SET_SETTING', key: 'compressionEnabled', value: comp.checked });
      showToast('✓ Настройка сжатия сохранена');
    });

    retention.addEventListener('change', async () => {
      const v = Math.max(0, Math.min(3650, parseInt(retention.value, 10) || 0));
      retention.value = v;
      await chrome.runtime.sendMessage({ type: 'SET_SETTING', key: 'retentionDays', value: v });
      showToast('✓ Срок хранения сохранен');
    });

    excluded.addEventListener('change', async () => {
      const list = excluded.value.split('\n').map(x => x.trim()).filter(Boolean);
      await chrome.runtime.sendMessage({ type: 'SET_SETTING', key: 'excludedSites', value: list });
      showToast('✓ Список исключений сохранен');
    });

    clearUnpinnedBtn.addEventListener('click', async () => {
      if (confirm('Очистить все незакрепленные записи?')) {
        await chrome.runtime.sendMessage({ type: 'CLEAR_ALL', includePinned: false });
        submodal.remove();
        await loadItems();
        await updateStats();
        showToast('✓ Незакрепленные записи удалены');
      }
    });

    clearAllBtn.addEventListener('click', async () => {
      if (confirm('ВНИМАНИЕ: Очистить ВСЮ историю, включая закрепленные записи?')) {
        await chrome.runtime.sendMessage({ type: 'CLEAR_ALL', includePinned: true });
        submodal.remove();
        await loadItems();
        await updateStats();
        showToast('✓ Вся история полностью очищена');
      }
    });
  }

  // Open Media Modal Lightbox
  async function openMediaModal(item) {
    const slot = shadowRoot.querySelector('#cb-submodal-slot');
    if (!slot) return;

    let mediaNode = null;
    if (item.type === 'video' && item.textPayload) {
      const isSafeHttp = /^https?:\/\//i.test(item.textPayload);
      mediaNode = isSafeHttp
        ? el('div', { style: { textAlign: 'center', padding: '20px' } }, [
            el('p', { style: { marginBottom: '10px' }, textContent: 'Видео по внешней ссылке:' }),
            el('a', {
              href: item.textPayload,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: { color: '#ffb000', wordBreak: 'break-all' },
              textContent: item.textPayload
            })
          ])
        : el('div', { style: { textAlign: 'center', padding: '20px' }, textContent: 'Некорректная ссылка' });
    } else {
      const res = await chrome.runtime.sendMessage({ type: 'GET_ITEM_BLOB', id: item.id });
      if (!res || !res.success || !res.dataUrl) return;

      if (item.type === 'image' && /^data:image\//i.test(res.dataUrl)) {
        mediaNode = el('img', { src: res.dataUrl, alt: 'Фото' });
      } else if (item.type === 'video' && /^data:video\//i.test(res.dataUrl)) {
        mediaNode = el('video', {
          controls: true,
          autoplay: true,
          style: { maxWidth: '100%', maxHeight: '340px' }
        }, [
          el('source', { src: res.dataUrl, type: res.mimeType || 'video/mp4' }),
          'Ваш браузер не поддерживает видео'
        ]);
      }
    }

    if (!mediaNode) return;

    const closeBtn = el('button', { className: 'cb-close-btn', id: 'cb-media-close', textContent: '✕' });
    const submodal = el('div', { className: 'cb-submodal-backdrop' }, [
      el('div', { className: 'cb-submodal-content' }, [
        el('div', { className: 'cb-submodal-header' }, [
          el('h3', { textContent: item.title || '' }),
          closeBtn
        ]),
        el('div', { className: 'cb-media-modal-body' }, [mediaNode])
      ])
    ]);

    slot.textContent = '';
    slot.appendChild(submodal);

    const closeMedia = () => {
      const vid = submodal.querySelector('video');
      if (vid) vid.pause();
      submodal.remove();
    };
    closeBtn.addEventListener('click', closeMedia);
    submodal.addEventListener('click', (e) => {
      if (e.target === submodal) closeMedia();
    });
  }

  function escapeHtml(str) {
    return str.replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  function formatTimestamp(ts) {
    const date = new Date(ts);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return timeStr;
    return `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${timeStr}`;
  }

  // Pixel Block Materialize / Entrance Animation (Adaptive to monitor refresh rate)
  // CRT power-on animation (driven by CSS, see .crt-boot)
  function playPixelEntrance(targetElement) {
    if (!targetElement) return;
    targetElement.classList.remove('crt-boot');
    void targetElement.offsetWidth;
    targetElement.classList.add('crt-boot');
    setTimeout(() => targetElement.classList.remove('crt-boot'), 1500);
  }
})();