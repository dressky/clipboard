// ui/panel.js - Main UI controller for Popup, Side Panel & Management

document.addEventListener('DOMContentLoaded', async () => {
  const db = window.ClipboardDB;
  if (!db) {
    console.error('Database module not loaded');
    return;
  }

  await db.init();

  // State
  let currentFilter = 'all';
  let searchQuery = '';
  let itemsList = [];

  // DOM Elements
  const feed = document.getElementById('items-feed');
  const searchInput = document.getElementById('search-input');
  const searchClearBtn = document.getElementById('search-clear-btn');
  const filterBtns = document.querySelectorAll('.filter-btn');
  const quickTextInput = document.getElementById('quick-text-input');
  const quickAddBtn = document.getElementById('quick-add-btn');
  const storageStatsLabel = document.getElementById('storage-stats-label');
  const toastEl = document.getElementById('app-toast');

  // Modals
  const settingsModal = document.getElementById('settings-modal');
  const openSettingsBtn = document.getElementById('open-settings-btn');
  const closeSettingsBtn = document.getElementById('settings-close-btn');
  const openSidepanelBtn = document.getElementById('open-sidepanel-btn');

  const mediaModal = document.getElementById('media-modal');
  const mediaModalTitle = document.getElementById('media-modal-title');
  const mediaModalBody = document.getElementById('media-modal-body');
  const mediaModalClose = document.getElementById('media-modal-close');

  const sidePanelSupported = Boolean(typeof chrome !== 'undefined' && chrome.sidePanel && chrome.sidePanel.open);
  if (!sidePanelSupported && openSidepanelBtn) {
    openSidepanelBtn.style.display = 'none';
  }

  // Settings inputs
  const settingDisplayMode = document.getElementById('setting-display-mode');
  const settingAutoCapture = document.getElementById('setting-auto-capture');
  const settingMaxActive = document.getElementById('setting-max-active');
  const settingCompression = document.getElementById('setting-compression');
  const settingRetention = document.getElementById('setting-retention');
  const settingExcluded = document.getElementById('setting-excluded');
  const exportBtn = document.getElementById('export-btn');
  const importInput = document.getElementById('import-input');
  const clearUnpinnedBtn = document.getElementById('clear-unpinned-btn');
  const clearAllBtn = document.getElementById('clear-all-btn');

  // CRT power-on animation
  playPixelEntrance(document.querySelector('.app-container'));

  // Auto-sync system clipboard (both images and text) when autoCapture is enabled
  try {
    const autoCaptureEnabled = (await db.getSetting('autoCapture')) !== false;
    if (autoCaptureEnabled && navigator.clipboard) {
      if (navigator.clipboard.read) {
        try {
          const clipItems = await navigator.clipboard.read();
          for (const it of clipItems) {
            const imgType = it.types.find(t => t.startsWith('image/'));
            if (imgType) {
              const blob = await it.getType(imgType);
              if (blob && blob.size > 0) {
                const recentImgs = await db.getItems({ filter: 'image', limit: 1 });
                const mime = blob.type || 'image/png';
                const isDup = recentImgs.length > 0 && recentImgs[0].size === blob.size && recentImgs[0].mimeType === mime;
                if (!isDup) {
                  await db.addItem({
                    type: 'image',
                    blob,
                    mimeType: mime,
                    title: `Фото (${Math.round(blob.size / 1024)} КБ)`
                  });
                }
              }
            }
          }
        } catch (imgErr) {}
      }

      if (navigator.clipboard.readText) {
        const clipText = await navigator.clipboard.readText();
        if (clipText && clipText.trim()) {
          await db.addItem({
            type: 'text',
            textPayload: clipText.trim(),
            title: clipText.trim().slice(0, 60)
          });
        }
      }
    }
  } catch (e) {}

  // Load Initial Data
  await loadSettingsIntoForm();
  await refreshFeed();
  await updateStats();

  // File Upload input listener
  const fileUploadInput = document.getElementById('file-upload-input');
  if (fileUploadInput) {
    fileUploadInput.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      for (const file of files) {
        const isImg = file.type.startsWith('image/');
        const isVid = file.type.startsWith('video/');
        if (isImg || isVid) {
          await db.addItem({
            type: isImg ? 'image' : 'video',
            blob: file,
            mimeType: file.type,
            title: file.name ? file.name.slice(0, 60) : (isImg ? 'Фото' : 'Видео')
          });
          showToast(isImg ? '✓ Фото сохранено' : '✓ Видео сохранено');
        }
      }
      fileUploadInput.value = '';
      await refreshFeed();
      await updateStats();
    });
  }

  // Paste listener for Ctrl+V image insertion
  window.addEventListener('paste', async (e) => {
    if (e.clipboardData && e.clipboardData.items) {
      for (const it of e.clipboardData.items) {
        if (it.type.startsWith('image/')) {
          const file = it.getAsFile();
          if (file) {
            await db.addItem({
              type: 'image',
              blob: file,
              mimeType: file.type,
              title: file.name ? file.name.slice(0, 50) : `Фото (${Math.round(file.size / 1024)} КБ)`
            });
            showToast('✓ Фото сохранено из буфера');
            await refreshFeed();
            await updateStats();
          }
        }
      }
    }
  });

  // Drag and Drop files onto popup
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files) {
      for (const file of e.dataTransfer.files) {
        if (file.type.startsWith('image/') || file.type.startsWith('video/')) {
          const isImg = file.type.startsWith('image/');
          await db.addItem({
            type: isImg ? 'image' : 'video',
            blob: file,
            mimeType: file.type,
            title: file.name ? file.name.slice(0, 60) : (isImg ? 'Фото' : 'Видео')
          });
          showToast(isImg ? '✓ Фото добавлено' : '✓ Видео добавлено');
          await refreshFeed();
          await updateStats();
        }
      }
    }
  });

  // Search listeners
  searchInput.addEventListener('input', (e) => {
    searchQuery = e.target.value;
    searchClearBtn.style.display = searchQuery ? 'block' : 'none';
    refreshFeed();
  });

  searchClearBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchQuery = '';
    searchClearBtn.style.display = 'none';
    refreshFeed();
  });

  // Filter navigation
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      refreshFeed();
    });
  });

  // Quick manual add
  quickAddBtn.addEventListener('click', handleQuickAdd);
  quickTextInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleQuickAdd();
  });

  async function handleQuickAdd() {
    const text = quickTextInput.value.trim();
    if (!text) return;
    await db.addItem({
      type: 'text',
      textPayload: text,
      title: text.slice(0, 50)
    });
    quickTextInput.value = '';
    showToast('✓ Запись добавлена');
    await refreshFeed();
    await updateStats();
  }

  // Refresh Feed
  async function refreshFeed() {
    try {
      itemsList = await db.getItems({
        filter: currentFilter,
        search: searchQuery,
        showArchived: currentFilter === 'archived'
      });
      renderFeed();
    } catch (err) {
      console.error('Error refreshing feed:', err);
    }
  }

  // Update storage & count stats
  async function updateStats() {
    try {
      const stats = await db.getStats();
      const mb = (stats.totalSizeBytes / (1024 * 1024)).toFixed(1);
      storageStatsLabel.textContent = `${stats.totalCount} зап. • ${mb} МБ`;
    } catch (e) {
      storageStatsLabel.textContent = '';
    }
  }

  // DOM helper to avoid innerHTML with dynamic values
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

  // Render cards
  function renderFeed() {
    if (!feed) return;

    feed.textContent = '';

    if (itemsList.length === 0) {
      const empty = el('div', { className: 'empty-state' });
      if (searchQuery) {
        empty.textContent = 'Ничего не найдено';
      } else {
        empty.appendChild(document.createTextNode('История буфера пуста.'));
        empty.appendChild(document.createElement('br'));
        empty.appendChild(document.createTextNode('Копируйте текст (Ctrl+C) или сохраняйте картинки через ПКМ!'));
      }
      feed.appendChild(empty);
      return;
    }

    itemsList.forEach(item => {
      const card = document.createElement('div');
      card.className = `feed-card ${item.pinned ? 'is-pinned' : ''} ${item.archived ? 'is-archived' : ''}`;
      card.dataset.id = item.id;

      // Enable Drag and Drop for media
      if (item.type === 'image' || item.type === 'video') {
        card.setAttribute('draggable', 'true');
        card.addEventListener('dragstart', (e) => handleDragStart(e, item));
      }

      const dateStr = formatTimestamp(item.createdAt);

      const metaLeft = el('div', { className: 'card-meta-left' }, [
        el('span', { className: 'type-badge', textContent: item.type }),
        el('span', { textContent: dateStr }),
        item.pinned ? el('span', { className: 'badge-pinned' }, [
          el('img', { src: '../icons/pixel/png/pin-active.png', className: 'pixel-icon-xs', alt: '' }),
          ' ЗАКРЕП'
        ]) : null,
        item.archived ? el('span', { className: 'badge-archived' }, [
          el('img', { src: '../icons/pixel/png/archive.png', className: 'pixel-icon-xs', alt: '' }),
          ' АРХИВ'
        ]) : null
      ]);

      const trashIcon = el('img', { src: '../icons/pixel/png/trash.png', className: 'pixel-icon-action trash-icon', alt: 'del' });
      const delBtn = el('button', {
        className: 'action-btn action-delete-btn',
        title: 'Удалить в корзину',
        dataset: { action: 'delete' }
      }, [trashIcon]);

      const pinBtn = el('button', {
        className: `action-btn action-pin-btn ${item.pinned ? 'active' : ''}`,
        title: item.pinned ? 'Открепить' : 'Закрепить',
        dataset: { action: 'pin' }
      }, [
        el('img', {
          src: `../icons/pixel/png/${item.pinned ? 'pin-active.png' : 'pin.png'}`,
          className: 'pixel-icon-action',
          alt: 'pin'
        })
      ]);

      const cardTop = el('div', { className: 'card-top' }, [
        metaLeft,
        el('div', { className: 'card-actions' }, [pinBtn, delBtn])
      ]);

      let contentEl;
      if (item.type === 'image') {
        contentEl = el('div', { className: 'card-media-content', title: 'Нажмите для увеличения' }, [
          el('img', { src: item.previewUrl || '', className: 'card-thumbnail', alt: 'Фото' }),
          el('div', { className: 'card-media-details' }, [
            el('span', { className: 'media-title', textContent: item.title || '' }),
            el('span', {
              className: 'media-size',
              textContent: `${Math.round(item.size / 1024)} КБ ${item.archived ? '• сжато (WebP)' : ''}`
            }),
            el('span', { className: 'drag-hint', textContent: '⠿ Перетащить в чат / форму (Drag & Drop)' })
          ])
        ]);
      } else if (item.type === 'video') {
        contentEl = el('div', { className: 'card-media-content', title: 'Нажмите для просмотра видео' }, [
          el('div', { className: 'card-video-box' }, [
            el('img', { src: '../icons/pixel/png/video.png', className: 'pixel-icon', style: { width: '24px', height: '24px' }, alt: '' })
          ]),
          el('div', { className: 'card-media-details' }, [
            el('span', { className: 'media-title', textContent: item.title || '' }),
            el('span', { className: 'media-size', textContent: `${(item.size / (1024 * 1024)).toFixed(1)} МБ` }),
            el('span', { className: 'drag-hint', textContent: '⠿ Перетащить файл (Drag & Drop)' })
          ])
        ]);
      } else {
        contentEl = el('div', {
          className: 'card-text-content',
          title: 'Нажмите для копирования',
          textContent: item.textPayload || ''
        });
      }

      const copyLabel = item.type === 'image' ? 'КОПИРОВАТЬ ФОТО' : (item.type === 'video' ? 'СКАЧАТЬ ВИДЕО' : 'КОПИРОВАТЬ');
      const footerActions = el('div', { className: 'card-footer-actions' }, [
        el('button', { className: 'btn-copy-item', dataset: { action: 'copy' } }, [
          el('img', { src: '../icons/pixel/png/clipboard.png', className: 'pixel-icon-xs', alt: '' }),
          ` ${copyLabel}`
        ])
      ]);

      card.appendChild(cardTop);
      card.appendChild(contentEl);
      card.appendChild(footerActions);

      // Interactive trash hover effect
      delBtn.addEventListener('mouseenter', () => {
        trashIcon.src = '../icons/pixel/png/trash-open.png';
      });
      delBtn.addEventListener('mouseleave', () => {
        trashIcon.src = '../icons/pixel/png/trash.png';
      });

      // Event handlers
      card.addEventListener('click', async (e) => {
        if (e.target.closest('[data-action="pin"]')) {
          e.stopPropagation();
          await db.togglePin(item.id);
          await refreshFeed();
          await updateStats();
        } else if (e.target.closest('[data-action="delete"]')) {
          e.stopPropagation();
          await db.deleteItem(item.id);
          await refreshFeed();
          await updateStats();
          showToast('Запись удалена');
        } else if (e.target.closest('[data-action="copy"]')) {
          e.stopPropagation();
          await handleCopyItem(item);
        } else if (e.target.closest('.card-media-content')) {
          e.stopPropagation();
          openMediaModal(item);
        } else if (e.target.closest('.card-text-content')) {
          e.stopPropagation();
          await handleCopyItem(item);
        }
      });

      feed.appendChild(card);

      // Lazy load image preview if thumbnail data is missing
      if (item.type === 'image' && !item.previewUrl) {
        db.getItem(item.id).then(full => {
          if (full && full.blob) {
            const url = URL.createObjectURL(full.blob);
            const imgEl = card.querySelector('.card-thumbnail');
            if (imgEl) {
              imgEl.onload = () => URL.revokeObjectURL(url);
              imgEl.onerror = () => URL.revokeObjectURL(url);
              imgEl.src = url;
            } else {
              URL.revokeObjectURL(url);
            }
          }
        }).catch(() => {});
      }
    });
  }

  // Drag and Drop
  async function handleDragStart(e, item) {
    try {
      e.dataTransfer.effectAllowed = 'copy';
      const fullItem = await db.getItem(item.id);
      if (fullItem && fullItem.blob) {
        const ext = fullItem.type === 'image' ? (fullItem.blob.type.includes('webp') ? 'webp' : 'png') : 'mp4';
        const file = new File([fullItem.blob], `clipboard_${item.id}.${ext}`, { type: fullItem.blob.type });
        if (e.dataTransfer.items && e.dataTransfer.items.add) {
          e.dataTransfer.items.add(file);
        }
      }
    } catch (err) {
      console.warn('DragStart error:', err);
    }
  }

  // Copy Item
  async function handleCopyItem(item) {
    if (item.type === 'text' || item.type === 'link') {
      try {
        await navigator.clipboard.writeText(item.textPayload || '');
        await db.touchItem(item.id);
        showToast('✓ Текст скопирован в буфер');
      } catch (err) {
        showToast('Ошибка копирования текста');
      }
    } else if (item.type === 'image') {
      try {
        const fullItem = await db.getItem(item.id);
        if (fullItem && fullItem.blob) {
          let pngBlob = fullItem.blob;
          if (pngBlob.type !== 'image/png') {
            pngBlob = await convertBlobToPng(pngBlob);
          }

          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': pngBlob })
          ]);
          await db.touchItem(item.id);
          showToast('✓ Фото скопировано! Нажмите Ctrl+V для вставки');
        }
      } catch (err) {
        console.error('Image clipboard copy error:', err);
        showToast('Не удалось скопировать фото в буфер');
      }
    } else if (item.type === 'video') {
      try {
        const fullItem = await db.getItem(item.id);
        if (fullItem && fullItem.blob) {
          const url = URL.createObjectURL(fullItem.blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `video_${item.id}.mp4`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          showToast('✓ Видео сохранено на диск');
        } else if (item.textPayload) {
          await navigator.clipboard.writeText(item.textPayload);
          showToast('✓ Ссылка на видео скопирована');
        }
      } catch (err) {
        showToast('Ошибка при экспорте видео');
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

  // Open Media Modal
  async function openMediaModal(item) {
    const fullItem = await db.getItem(item.id);
    if (!fullItem) return;

    mediaModalTitle.textContent = fullItem.title;
    mediaModalBody.textContent = '';

    if (fullItem.type === 'image') {
      let src = fullItem.previewUrl;
      if (fullItem.blob) {
        src = URL.createObjectURL(fullItem.blob);
      }
      if (src && (/^data:image\//i.test(src) || /^blob:/i.test(src))) {
        mediaModalBody.appendChild(el('img', { src, alt: 'Фото' }));
      }
    } else if (fullItem.type === 'video') {
      if (fullItem.blob) {
        const videoUrl = URL.createObjectURL(fullItem.blob);
        const videoEl = el('video', {
          controls: true,
          autoplay: true,
          style: { maxWidth: '100%', maxHeight: '360px' }
        }, [
          el('source', { src: videoUrl, type: fullItem.mimeType || 'video/mp4' }),
          'Ваш браузер не поддерживает видео'
        ]);
        mediaModalBody.appendChild(videoEl);
      } else if (fullItem.textPayload) {
        const isSafeHttp = /^https?:\/\//i.test(fullItem.textPayload);
        if (isSafeHttp) {
          mediaModalBody.appendChild(el('div', { style: { textAlign: 'center', padding: '20px' } }, [
            el('p', { style: { marginBottom: '10px' }, textContent: 'Видео по внешней ссылке:' }),
            el('a', {
              href: fullItem.textPayload,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: { color: '#2563eb', wordBreak: 'break-all' },
              textContent: fullItem.textPayload
            })
          ]));
        } else {
          mediaModalBody.appendChild(el('div', {
            style: { textAlign: 'center', padding: '20px' },
            textContent: 'Некорректная ссылка'
          }));
        }
      }
    }

    mediaModal.style.display = 'flex';
  }

  function closeMediaModal() {
    mediaModal.style.display = 'none';
    mediaModalBody.querySelectorAll('img[src^="blob:"], source[src^="blob:"]').forEach(node => URL.revokeObjectURL(node.src));
    mediaModalBody.textContent = '';
  }

  mediaModalClose.addEventListener('click', closeMediaModal);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (mediaModal.style.display !== 'none') closeMediaModal();
    else if (settingsModal.style.display !== 'none') settingsModal.style.display = 'none';
  });

  if (openSidepanelBtn) {
    openSidepanelBtn.addEventListener('click', async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && chrome.sidePanel && chrome.sidePanel.open) {
          await chrome.sidePanel.open({ windowId: tab.windowId });
          window.close();
        }
      } catch (e) {
        console.warn('Side panel open error:', e);
      }
    });
  }

  // Settings Handlers
  openSettingsBtn.addEventListener('click', async () => {
    await loadSettingsIntoForm();
    settingsModal.style.display = 'flex';
  });

  closeSettingsBtn.addEventListener('click', () => {
    settingsModal.style.display = 'none';
  });

  async function loadSettingsIntoForm() {
    const settings = await db.getAllSettings();
    if (settingDisplayMode) {
      const spOpt = settingDisplayMode.querySelector('option[value="sidepanel"]');
      if (spOpt && !sidePanelSupported) {
        spOpt.hidden = true;
        spOpt.disabled = true;
      }
      const mode = settings.displayMode || 'floating';
      settingDisplayMode.value = (!sidePanelSupported && mode === 'sidepanel') ? 'floating' : mode;
    }
    if (settingAutoCapture) settingAutoCapture.checked = settings.autoCapture !== false;
    if (settingMaxActive) settingMaxActive.value = settings.maxActiveItems || 50;
    if (settingCompression) settingCompression.checked = settings.compressionEnabled !== false;
    if (settingRetention) settingRetention.value = Number(settings.retentionDays) || 0;
    if (settingExcluded) settingExcluded.value = (settings.excludedSites || []).join('\n');
  }

  settingRetention.addEventListener('change', async () => {
    const v = Math.max(0, Math.min(3650, parseInt(settingRetention.value, 10) || 0));
    settingRetention.value = v;
    await db.setSetting('retentionDays', v);
    if (v > 0) {
      const removed = await db.runRetention(v);
      if (removed) { await refreshFeed(); await updateStats(); }
    }
    showToast('✓ Срок хранения сохранен');
  });

  settingExcluded.addEventListener('change', async () => {
    const list = settingExcluded.value.split('\n').map(x => x.trim()).filter(Boolean);
    await db.setSetting('excludedSites', list);
    showToast('✓ Список исключений сохранен');
  });

  exportBtn.addEventListener('click', async () => {
    try {
      const data = await db.exportAll();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `clipboard-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      showToast(`✓ Экспортировано записей: ${data.items.length}`);
    } catch (err) {
      showToast('Ошибка экспорта');
    }
  });

  importInput.addEventListener('change', async () => {
    const file = importInput.files && importInput.files[0];
    importInput.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const res = await db.importAll(data);
      await refreshFeed();
      await updateStats();
      showToast(`✓ Импортировано: ${res.added}, пропущено: ${res.skipped}`);
    } catch (err) {
      showToast(err && err.message ? err.message : 'Ошибка импорта');
    }
  });

  settingDisplayMode.addEventListener('change', async () => {
    await db.setSetting('displayMode', settingDisplayMode.value);
    showToast('✓ Настройка сохранена');
  });

  settingAutoCapture.addEventListener('change', async () => {
    await db.setSetting('autoCapture', settingAutoCapture.checked);
    showToast('✓ Настройка сохранена');
  });

  settingMaxActive.addEventListener('change', async () => {
    const val = parseInt(settingMaxActive.value, 10) || 50;
    await db.setSetting('maxActiveItems', val);
    showToast('✓ Порог архивации обновлен');
  });

  settingCompression.addEventListener('change', async () => {
    await db.setSetting('compressionEnabled', settingCompression.checked);
    showToast('✓ Настройка сжатия сохранена');
  });

  clearUnpinnedBtn.addEventListener('click', async () => {
    if (confirm('Очистить все незакрепленные записи?')) {
      await db.clearAll(false);
      await refreshFeed();
      await updateStats();
      showToast('✓ Незакрепленные записи удалены');
    }
  });

  clearAllBtn.addEventListener('click', async () => {
    if (confirm('ВНИМАНИЕ: Очистить ВСЮ историю, включая закрепленные записи?')) {
      await db.clearAll(true);
      await refreshFeed();
      await updateStats();
      showToast('✓ Вся история полностью очищена');
    }
  });

  // Toast
  function showToast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.style.display = 'block';
    setTimeout(() => {
      toastEl.style.display = 'none';
    }, 2200);
  }

  // Helpers
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

  // CRT power-on animation (driven by CSS, see .crt-boot)
  function playPixelEntrance(targetElement) {
    if (!targetElement) return;
    targetElement.classList.remove('crt-boot');
    void targetElement.offsetWidth;
    targetElement.classList.add('crt-boot');
    setTimeout(() => targetElement.classList.remove('crt-boot'), 1500);
  }
});
