// background/service-worker.js - Central coordinator for Clipboard Extension

if (typeof importScripts === 'function') {
  importScripts('../lib/db.js');
}

// Register Context Menus on installation
chrome.runtime.onInstalled.addListener(async () => {
  await createMenus();
  await runStartupMaintenance();
});

chrome.runtime.onStartup.addListener(async () => {
  await createMenus();
  await runStartupMaintenance();
});

// Apply auto-delete (retention) rules once per browser start
async function runStartupMaintenance() {
  try {
    const days = Number(await db.getSetting('retentionDays')) || 0;
    if (days > 0) await db.runRetention(days);
  } catch (err) {
    console.warn('Startup maintenance error:', err);
  }
}

// True if auto-capture is disabled for the page the content script runs on
async function isCaptureBlocked(sender) {
  const url = sender && sender.tab ? sender.tab.url : '';
  const excluded = (await db.getSetting('excludedSites')) || [];
  return db.isExcluded(url, excluded);
}

async function createMenus() {
  try {
    await chrome.contextMenus.removeAll();

    chrome.contextMenus.create({
      id: 'cb-root',
      title: 'Clipboard',
      contexts: ['all']
    });

    chrome.contextMenus.create({
      id: 'cb-open',
      parentId: 'cb-root',
      title: 'Открыть Clipboard (Alt+V)',
      contexts: ['all']
    });

    chrome.contextMenus.create({
      id: 'cb-sep1',
      parentId: 'cb-root',
      type: 'separator',
      contexts: ['all']
    });

    chrome.contextMenus.create({
      id: 'cb-save-selection',
      parentId: 'cb-root',
      title: 'Сохранить выделение',
      contexts: ['selection']
    });

    chrome.contextMenus.create({
      id: 'cb-save-image',
      parentId: 'cb-root',
      title: 'Сохранить картинку в Clipboard',
      contexts: ['image']
    });

    chrome.contextMenus.create({
      id: 'cb-save-video',
      parentId: 'cb-root',
      title: 'Сохранить видео в Clipboard',
      contexts: ['video']
    });

    chrome.contextMenus.create({
      id: 'cb-save-link',
      parentId: 'cb-root',
      title: 'Сохранить ссылку в Clipboard',
      contexts: ['link']
    });
  } catch (err) {
    console.warn('Error creating context menus:', err);
  }
}

// Handle Context Menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  try {
    switch (info.menuItemId) {
      case 'cb-open':
        await openClipboardUI(tab);
        break;

      case 'cb-save-selection':
        if (info.selectionText && info.selectionText.trim()) {
          const item = await db.addItem({
            type: 'text',
            textPayload: info.selectionText.trim(),
            sourceUrl: tab?.url || '',
            title: info.selectionText.trim().slice(0, 60)
          });
          if (item && tab?.id) {
            sendToast(tab.id, '✓ Текст сохранен в Clipboard');
          }
        }
        break;

      case 'cb-save-image':
        if (info.srcUrl) {
          await handleSaveImage(info.srcUrl, tab);
        }
        break;

      case 'cb-save-video':
        if (info.srcUrl) {
          await handleSaveVideo(info.srcUrl, tab);
        }
        break;

      case 'cb-save-link':
        if (info.linkUrl) {
          const item = await db.addItem({
            type: 'link',
            textPayload: info.linkUrl,
            sourceUrl: tab?.url || '',
            title: info.linkUrl
          });
          if (item && tab?.id) {
            sendToast(tab.id, '✓ Ссылка сохранена в Clipboard');
          }
        }
        break;
    }
  } catch (err) {
    console.error('Context menu handler error:', err);
    if (tab?.id) {
      sendToast(tab.id, 'Ошибка сохранения: ' + err.message, 'error');
    }
  }
});

// Safe tabs.sendMessage helper using callbacks to guarantee chrome.runtime.lastError is consumed
// This completely prevents Chrome from logging "Uncaught (in promise) Error: Could not establish connection. Receiving end does not exist."
function safeSendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    if (!tabId) {
      resolve(null);
      return;
    }
    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          // Explicit check of chrome.runtime.lastError marks error as handled in Chrome C++ core
          resolve(null);
        } else {
          resolve(response);
        }
      });
    } catch (e) {
      resolve(null);
    }
  });
}

// Save image from URL to local IndexedDB
async function handleSaveImage(srcUrl, tab) {
  try {
    let blob;
    if (srcUrl.startsWith('data:')) {
      const resp = await fetch(srcUrl);
      blob = await resp.blob();
    } else if (srcUrl.startsWith('blob:')) {
      // Blob URLs cannot be fetched across origins by service worker, delegate to page context
      throw new Error('Blob URL requires page context');
    } else {
      const resp = await fetch(srcUrl, { credentials: 'omit' });
      blob = await resp.blob();
    }

    if (!blob || blob.size === 0) {
      throw new Error('Пустое изображение');
    }

    const item = await db.addItem({
      type: 'image',
      blob,
      mimeType: blob.type || 'image/png',
      sourceUrl: tab?.url || srcUrl,
      title: `Фото (${Math.round(blob.size / 1024)} КБ)`
    });

    if (item && tab?.id) {
      sendToast(tab.id, '✓ Фото сохранено в Clipboard');
    }
  } catch (err) {
    console.warn('Direct fetch of image failed, attempting tab script grab:', err);
    if (tab?.id) {
      try {
        const response = await safeSendMessageToTab(tab.id, { type: 'GRAB_IMAGE_FROM_PAGE', srcUrl });
        if (response && response.dataUrl) {
          const res = await fetch(response.dataUrl);
          const b = await res.blob();
          await db.addItem({
            type: 'image',
            blob: b,
            mimeType: b.type || response.mimeType || 'image/png',
            sourceUrl: tab.url,
            title: `Фото (${Math.round(b.size / 1024)} КБ)`
          });
          sendToast(tab.id, '✓ Фото сохранено в Clipboard');
        } else {
          sendToast(tab.id, 'Не удалось сохранить фото из-за защиты страницы', 'error');
        }
      } catch (e) {
        sendToast(tab.id, 'Ошибка доступа к изображению', 'error');
      }
    }
  }
}

// Save video from URL to local IndexedDB
async function handleSaveVideo(srcUrl, tab) {
  try {
    const resp = await fetch(srcUrl);
    const blob = await resp.blob();

    const item = await db.addItem({
      type: 'video',
      blob,
      mimeType: blob.type || 'video/mp4',
      sourceUrl: tab?.url || srcUrl,
      title: `Видео (${(blob.size / (1024 * 1024)).toFixed(1)} МБ)`
    });

    if (item && tab?.id) {
      sendToast(tab.id, '✓ Видео сохранено в Clipboard');
    }
  } catch (err) {
    console.warn('Direct fetch of video failed, saving video link reference:', err);
    const item = await db.addItem({
      type: 'video',
      textPayload: srcUrl,
      sourceUrl: tab?.url || srcUrl,
      title: 'Видео ссылка (' + srcUrl.slice(0, 40) + '...)'
    });
    if (item && tab?.id) {
      sendToast(tab.id, '✓ Ссылка на видео сохранена в Clipboard');
    }
  }
}

// Open UI based on user configuration with automatic fallback
async function openClipboardUI(tab) {
  if (!tab || !tab.id) {
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = activeTab;
    } catch (e) {}
  }

  if (!tab) {
    openStandaloneWindow();
    return;
  }

  const url = tab.url || '';
  const isRestrictedUrl = !url || 
    url.startsWith('chrome://') || 
    url.startsWith('chrome-extension://') || 
    url.startsWith('moz-extension://') ||
    url.startsWith('resource://') ||
    url.startsWith('jar:') ||
    url.startsWith('edge://') || 
    url.startsWith('about:') ||
    url.startsWith('view-source:') ||
    url.startsWith('devtools://');

  const displayMode = (await db.getSetting('displayMode')) || 'floating';

  // If on restricted Chrome system pages (where content scripts can never run) or user prefers sidepanel
  if (isRestrictedUrl || displayMode === 'sidepanel') {
    if (chrome.sidePanel && tab.windowId) {
      try {
        await chrome.sidePanel.open({ windowId: tab.windowId });
        return;
      } catch (e) {
        console.warn('Sidepanel open error:', e);
      }
    }
    // Fallback: standalone window
    openStandaloneWindow();
    return;
  }

  // 1. Try sending message to existing content script
  const resp1 = await safeSendMessageToTab(tab.id, { type: 'TOGGLE_FLOATING_PANEL' });
  if (resp1 && resp1.success) {
    return;
  }

  // 2. Dynamically inject content script
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/content-script.js']
    });
    
    // Wait a brief tick for initialization
    await new Promise(r => setTimeout(r, 80));
    const resp2 = await safeSendMessageToTab(tab.id, { type: 'TOGGLE_FLOATING_PANEL' });
    if (resp2 && resp2.success) {
      return;
    }
  } catch (injectErr) {
    // If injection or secondary message fails, open standalone window safely without unhandled error
    console.warn('Script injection failed:', injectErr);
  }

  openStandaloneWindow();
}

function openStandaloneWindow() {
  try {
    chrome.windows.create({
      url: chrome.runtime.getURL('ui/panel.html'),
      type: 'popup',
      width: 480,
      height: 620
    });
  } catch (e) {
    console.error('Failed to open standalone window:', e);
  }
}

// Keyboard shortcut (Alt+V) handler
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-clipboard') {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await openClipboardUI(tab);
    } catch (e) {
      openStandaloneWindow();
    }
  }
});

// Toast notification sender helper
function sendToast(tabId, message, level = 'success') {
  if (!tabId) return;
  safeSendMessageToTab(tabId, {
    type: 'SHOW_TOAST',
    message,
    level
  });
}

// Message router for Content Scripts and Extension Pages
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'AUTO_CAPTURE_TEXT': {
          const autoCapture = (await db.getSetting('autoCapture')) !== false;
          if (autoCapture && await isCaptureBlocked(sender)) {
            sendResponse({ success: false, reason: 'excluded site' });
            break;
          }
          if (autoCapture && message.text && message.text.trim()) {
            const item = await db.addItem({
              type: 'text',
              textPayload: message.text.trim(),
              sourceUrl: sender.tab?.url || '',
              title: message.text.trim().slice(0, 60)
            });
            sendResponse({ success: true, item });
          } else {
            sendResponse({ success: false, reason: 'disabled or empty' });
          }
          break;
        }

        case 'AUTO_CAPTURE_IMAGE': {
          const itemType = message.itemType === 'video' ? 'video' : 'image';
          if (!message.manual && await isCaptureBlocked(sender)) {
            sendResponse({ success: false, reason: 'excluded site' });
            break;
          }
          if (message.dataUrl) {
            try {
              // Deduplication check: if recent active image matches size within 15 seconds
              if (itemType === 'image') {
                const recent = await db.getItems({ filter: 'image', limit: 1 });
                if (recent.length > 0 && Math.abs((recent[0].size || 0) - (message.size || 0)) < 10) {
                  const timeDiff = Date.now() - recent[0].createdAt;
                  if (timeDiff < 15000) {
                    sendResponse({ success: true, duplicate: true });
                    break;
                  }
                }
              }

              const res = await fetch(message.dataUrl);
              const blob = await res.blob();
              const defaultTitle = itemType === 'video'
                ? `Видео (${(blob.size / (1024 * 1024)).toFixed(1)} МБ)`
                : `Фото (${Math.round(blob.size / 1024)} КБ)`;
              const item = await db.addItem({
                type: itemType,
                blob,
                mimeType: message.mimeType || blob.type || (itemType === 'video' ? 'video/mp4' : 'image/png'),
                sourceUrl: sender.tab?.url || '',
                title: message.title || defaultTitle
              });
              sendResponse({ success: true, item });
            } catch (imgErr) {
              sendResponse({ success: false, error: imgErr.message });
            }
          } else {
            sendResponse({ success: false, error: 'Empty dataUrl' });
          }
          break;
        }

        case 'ADD_ITEM': {
          const item = await db.addItem(message.payload);
          sendResponse({ success: true, item });
          break;
        }

        case 'GET_ITEMS': {
          const items = await db.getItems(message.params || {});
          const sanitized = items.map(it => {
            const copy = { ...it };
            copy.hasBlob = !!it.blob;
            delete copy.blob;
            return copy;
          });
          sendResponse({ success: true, items: sanitized });
          break;
        }

        case 'GET_ITEM_BLOB': {
          const it = await db.getItem(message.id);
          if (it && it.blob) {
            const dataUrl = await db._blobToDataUrl(it.blob);
            sendResponse({ success: true, dataUrl, mimeType: it.mimeType, title: it.title });
          } else {
            sendResponse({ success: false, error: 'Not found or no blob' });
          }
          break;
        }

        case 'TOGGLE_PIN': {
          const item = await db.togglePin(message.id);
          sendResponse({ success: true, item });
          break;
        }

        case 'DELETE_ITEM': {
          await db.deleteItem(message.id);
          sendResponse({ success: true });
          break;
        }

        case 'CLEAR_ALL': {
          await db.clearAll(message.includePinned || false);
          sendResponse({ success: true });
          break;
        }

        case 'GET_STATS': {
          const stats = await db.getStats();
          sendResponse({ success: true, stats });
          break;
        }

        case 'GET_SETTINGS': {
          const settings = await db.getAllSettings();
          sendResponse({ success: true, settings });
          break;
        }

        case 'SET_SETTING': {
          await db.setSetting(message.key, message.value);
          sendResponse({ success: true });
          break;
        }

        case 'GET_CAPABILITIES': {
          sendResponse({
            success: true,
            sidePanelSupported: Boolean(chrome.sidePanel && chrome.sidePanel.open)
          });
          break;
        }

        case 'OPEN_SIDEPANEL': {
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab && chrome.sidePanel && chrome.sidePanel.open) {
              await chrome.sidePanel.open({ windowId: tab.windowId });
              sendResponse({ success: true });
            } else {
              openStandaloneWindow();
              sendResponse({ success: true, fallback: 'window' });
            }
          } catch (e) {
            openStandaloneWindow();
            sendResponse({ success: true, fallback: 'window' });
          }
          break;
        }

        case 'OPEN_UI': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          await openClipboardUI(tab);
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (err) {
      console.error('Service worker message handling error:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true;
});
