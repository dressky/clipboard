// lib/db.js - Local Persistent IndexedDB Database Engine for Clipboard Extension

const DB_NAME = 'LocalClipboardDB';
const DB_VERSION = 1;

class ClipboardDatabase {
  constructor() {
    this.db = null;
    this._initPromise = null;
  }

  async init() {
    if (this.db) return this.db;
    if (this._initPromise) return this._initPromise;

    this._initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Items store
        if (!db.objectStoreNames.contains('items')) {
          const itemStore = db.createObjectStore('items', { keyPath: 'id' });
          itemStore.createIndex('createdAt', 'createdAt', { unique: false });
          itemStore.createIndex('type', 'type', { unique: false });
          itemStore.createIndex('pinned', 'pinned', { unique: false });
          itemStore.createIndex('archived', 'archived', { unique: false });
          itemStore.createIndex('lastUsedAt', 'lastUsedAt', { unique: false });
        }

        // Settings store
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
      };

      request.onsuccess = async (event) => {
        this.db = event.target.result;

        // Request persistent storage so Chrome never deletes data on low disk/reboot
        if (navigator.storage && navigator.storage.persist) {
          try {
            await navigator.storage.persist();
          } catch (e) {
            console.warn('Could not request persistent storage:', e);
          }
        }

        // Initialize default settings if missing
        await this._ensureDefaultSettings();
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('IndexedDB open error:', event.target.error);
        reject(event.target.error);
      };
    });

    return this._initPromise;
  }

  async _ensureDefaultSettings() {
    const defaults = {
      displayMode: 'floating', // 'floating' | 'sidepanel' | 'popup'
      autoCapture: true,       // Auto-capture Ctrl+C copy events
      maxActiveItems: 50,      // First 50 are active, older are archived
      compressionEnabled: true,
      theme: 'system',         // 'system' | 'dark' | 'light'
      retentionDays: 0,        // Auto-delete unpinned items older than N days (0 = never)
      excludedSites: []        // Hostnames where auto-capture is disabled
    };

    for (const [key, value] of Object.entries(defaults)) {
      const existing = await this.getSetting(key);
      if (existing === undefined) {
        await this.setSetting(key, value);
      }
    }
  }

  async getSetting(key) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async setSetting(key, value) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readwrite');
      const store = tx.objectStore('settings');
      const req = store.put({ key, value });
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async getAllSettings() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('settings', 'readonly');
      const store = tx.objectStore('settings');
      const req = store.getAll();
      req.onsuccess = () => {
        const result = {};
        for (const item of req.result || []) {
          result[item.key] = item.value;
        }
        resolve(result);
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Generate unique ID
  _generateId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'cb_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
  }

  // Compress image to WebP using OffscreenCanvas
  async _compressImageBlob(blob, maxWidth = 1200, quality = 0.75) {
    try {
      if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
        return blob;
      }
      const bitmap = await createImageBitmap(blob);
      let { width, height } = bitmap;
      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0, width, height);
      const compressedBlob = await canvas.convertToBlob({ type: 'image/webp', quality });
      return compressedBlob || blob;
    } catch (err) {
      console.warn('Image compression fallback:', err);
      return blob;
    }
  }

  // Helper to reliably convert Blob to Data URL in ANY environment (DOM, Service Worker, Node)
  async _blobToDataUrl(blob) {
    if (!blob) return null;

    // 1. Try FileReader if available in this environment
    if (typeof FileReader !== 'undefined') {
      try {
        const res = await new Promise((resolve) => {
          try {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          } catch (e) {
            resolve(null);
          }
        });
        if (res) return res;
      } catch (err) {}
    }

    // 2. Reliable Fallback: ArrayBuffer chunked btoa conversion (works in Service Workers & Workers)
    try {
      if (blob.arrayBuffer) {
        const buffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        const b64 = (typeof btoa !== 'undefined') ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64');
        return `data:${blob.type || 'image/png'};base64,${b64}`;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  // Create thumbnail data URL for fast gallery rendering
  async _createThumbnail(blob, size = 180) {
    try {
      if (typeof createImageBitmap !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
        const bitmap = await createImageBitmap(blob);
        let { width, height } = bitmap;
        const scale = Math.min(size / width, size / height, 1);
        const thumbW = Math.max(1, Math.round(width * scale));
        const thumbH = Math.max(1, Math.round(height * scale));

        const canvas = new OffscreenCanvas(thumbW, thumbH);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, thumbW, thumbH);
        const thumbBlob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.70 });
        const dataUrl = await this._blobToDataUrl(thumbBlob || blob);
        if (dataUrl) return dataUrl;
      }
    } catch (e) {
      console.warn('Thumbnail generation error, using blob data URL fallback:', e);
    }
    // Reliable fallback: convert original blob directly to data URL so previewUrl is NEVER null
    return await this._blobToDataUrl(blob);
  }

  async addItem(data) {
    await this.init();

    // Check for exact duplicates in recent active text items to prevent spam
    if (data.type === 'text' && data.textPayload) {
      const recent = await this.getRecentTextItems(5);
      const isDuplicate = recent.some(r => r.textPayload === data.textPayload);
      if (isDuplicate) {
        return null; // Don't duplicate exact consecutive text
      }
    }

    const id = this._generateId();
    const now = Date.now();
    let size = 0;
    let previewUrl = null;

    if (data.blob) {
      size = data.blob.size;
      if (data.type === 'image') {
        previewUrl = await this._createThumbnail(data.blob);
      }
    } else if (data.textPayload) {
      size = new Blob([data.textPayload]).size;
    }

    let title = data.title || '';
    if (!title) {
      if (data.type === 'text') {
        title = data.textPayload.trim().slice(0, 80).replace(/\s+/g, ' ');
      } else if (data.type === 'image') {
        title = `Фотография (${Math.round(size / 1024)} КБ)`;
      } else if (data.type === 'video') {
        title = `Видео (${(size / (1024 * 1024)).toFixed(1)} МБ)`;
      } else {
        title = 'Запись буфера';
      }
    }

    const item = {
      id,
      type: data.type || 'text',
      title,
      textPayload: data.textPayload || '',
      blob: data.blob || null,
      mimeType: data.mimeType || (data.blob ? data.blob.type : 'text/plain'),
      size,
      previewUrl,
      pinned: false,
      archived: false,
      createdAt: now,
      lastUsedAt: now,
      sourceUrl: data.sourceUrl || '',
      metadata: data.metadata || {}
    };

    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const req = store.add(item);
      req.onsuccess = () => resolve(item);
      req.onerror = () => reject(req.error);
    });

    // Run archival check in background
    const maxActive = (await this.getSetting('maxActiveItems')) || 50;
    this.runArchival(maxActive).catch(err => console.warn('Archival error:', err));

    // Run retention cleanup at most once per hour
    const days = Number(await this.getSetting('retentionDays')) || 0;
    if (days > 0 && Date.now() - (this._lastRetention || 0) > 3600000) {
      this._lastRetention = Date.now();
      this.runRetention(days).catch(err => console.warn('Retention error:', err));
    }

    return item;
  }

  // Delete unpinned items older than N days. Pinned items are never removed.
  async runRetention(days) {
    await this.init();
    const limit = Number(days) || 0;
    if (limit <= 0) return 0;
    const threshold = Date.now() - limit * 86400000;
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const req = store.openCursor();
      let removed = 0;
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const it = cursor.value;
          if (!it.pinned && it.createdAt < threshold) {
            cursor.delete();
            removed++;
          }
          cursor.continue();
        } else {
          resolve(removed);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  // True if the page URL belongs to a host from the exclusion list.
  // Patterns: "example.com" (also matches subdomains) or "*.example.com".
  isExcluded(url, patterns) {
    if (!url || !Array.isArray(patterns) || patterns.length === 0) return false;
    let host;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      host = u.hostname.toLowerCase().replace(/^www\./, '');
    } catch (e) {
      return false;
    }
    return patterns.some(raw => {
      const p = String(raw || '').trim().toLowerCase().replace(/^\*\./, '').replace(/^www\./, '');
      return p && (host === p || host.endsWith('.' + p));
    });
  }

  // Full backup of items as plain JSON (blobs are stored as data URLs)
  async exportAll() {
    await this.init();
    const items = await new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readonly');
      const req = tx.objectStore('items').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const out = [];
    for (const it of items) {
      const copy = { ...it };
      delete copy.blob;
      if (it.blob) copy.blobData = await this._blobToDataUrl(it.blob);
      out.push(copy);
    }
    return {
      format: 'clipboard-local-backup',
      version: 1,
      exportedAt: Date.now(),
      items: out
    };
  }

  // Merge a backup produced by exportAll(). Existing ids are kept untouched.
  async importAll(data) {
    await this.init();
    if (!data || data.format !== 'clipboard-local-backup' || !Array.isArray(data.items)) {
      throw new Error('Неверный формат файла резервной копии');
    }
    let added = 0;
    let skipped = 0;
    for (const raw of data.items) {
      if (!raw || !raw.id || !raw.type) { skipped++; continue; }
      if (await this.getItem(raw.id)) { skipped++; continue; }
      const item = { ...raw, blob: null };
      delete item.blobData;
      if (raw.blobData) {
        try {
          const res = await fetch(raw.blobData);
          item.blob = await res.blob();
        } catch (e) {
          skipped++;
          continue;
        }
      }
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('items', 'readwrite');
        const req = tx.objectStore('items').put(item);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      added++;
    }
    return { added, skipped };
  }

  async getRecentTextItems(limit = 5) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const index = store.index('createdAt');
      const req = index.openCursor(null, 'prev');
      const results = [];

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && results.length < limit) {
          if (cursor.value.type === 'text') {
            results.push(cursor.value);
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  // Tiered Archival: Items beyond the active limit (e.g. 50) become archived
  async runArchival(activeLimit = 50) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const index = store.index('createdAt');
      const req = index.openCursor(null, 'prev');
      
      let nonPinnedActiveCount = 0;
      const itemsToArchive = [];

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const item = cursor.value;
          // Pinned items are NEVER archived
          if (!item.pinned && !item.archived) {
            nonPinnedActiveCount++;
            if (nonPinnedActiveCount > activeLimit) {
              itemsToArchive.push(item);
            }
          }
          cursor.continue();
        } else {
          // Process items that exceeded the active limit
          this._processArchivalBatch(itemsToArchive).then(resolve).catch(reject);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async _processArchivalBatch(items) {
    if (!items.length) return;
    const compressionEnabled = (await this.getSetting('compressionEnabled')) !== false;

    for (const item of items) {
      item.archived = true;

      // If compression is enabled and item is an image, compress to WebP
      if (compressionEnabled && item.type === 'image' && item.blob) {
        try {
          const compressedBlob = await this._compressImageBlob(item.blob, 1000, 0.70);
          item.blob = compressedBlob;
          item.size = compressedBlob.size;
          item.mimeType = 'image/webp';
        } catch (e) {
          console.warn('Archival image compression failed for', item.id, e);
        }
      }

      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('items', 'readwrite');
        const store = tx.objectStore('items');
        const req = store.put(item);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }
  }

  async getItems({ filter = 'all', search = '', showArchived = false, limit = 100 } = {}) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const index = store.index('createdAt');
      const req = index.openCursor(null, 'prev');
      const results = [];

      const query = (search || '').toLowerCase().trim();

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && results.length < limit) {
          const item = cursor.value;

          // Archived filter
          if (filter === 'archived') {
            if (!item.archived) {
              cursor.continue();
              return;
            }
          } else if (filter === 'pinned') {
            if (!item.pinned) {
              cursor.continue();
              return;
            }
          } else {
            // Standard views: hide archived unless showArchived is explicitly true
            if (item.archived && !showArchived) {
              cursor.continue();
              return;
            }
          }

          // Type filter
          if (filter === 'text' && item.type !== 'text') {
            cursor.continue();
            return;
          }
          if (filter === 'image' && item.type !== 'image') {
            cursor.continue();
            return;
          }
          if (filter === 'video' && item.type !== 'video') {
            cursor.continue();
            return;
          }

          // Search query matching
          if (query) {
            const matchTitle = (item.title || '').toLowerCase().includes(query);
            const matchContent = (item.textPayload || '').toLowerCase().includes(query);
            const matchMime = (item.mimeType || '').toLowerCase().includes(query);
            if (!matchTitle && !matchContent && !matchMime) {
              cursor.continue();
              return;
            }
          }

          // If blob is present, convert to ObjectURL for previewing in the current page
          // (previewUrl is already present as dataURL)
          results.push(item);
          cursor.continue();
        } else {
          // Sort results: pinned items first, then by createdAt desc
          results.sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return b.createdAt - a.createdAt;
          });
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getItem(id) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async togglePin(id) {
    await this.init();
    const item = await this.getItem(id);
    if (!item) return null;

    item.pinned = !item.pinned;
    // Pinned items cannot be archived
    if (item.pinned) {
      item.archived = false;
    }

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const req = store.put(item);
      req.onsuccess = () => resolve(item);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteItem(id) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async touchItem(id) {
    await this.init();
    const item = await this.getItem(id);
    if (!item) return null;
    item.lastUsedAt = Date.now();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const req = store.put(item);
      req.onsuccess = () => resolve(item);
      req.onerror = () => reject(req.error);
    });
  }

  async clearAll(includePinned = false) {
    await this.init();
    if (includePinned) {
      return new Promise((resolve, reject) => {
        const tx = this.db.transaction('items', 'readwrite');
        const store = tx.objectStore('items');
        const req = store.clear();
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    }

    // Clear only unpinned items
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readwrite');
      const store = tx.objectStore('items');
      const req = store.openCursor();

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          if (!cursor.value.pinned) {
            cursor.delete();
          }
          cursor.continue();
        } else {
          resolve(true);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getStats() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('items', 'readonly');
      const store = tx.objectStore('items');
      const req = store.openCursor();

      const stats = {
        totalCount: 0,
        textCount: 0,
        imageCount: 0,
        videoCount: 0,
        pinnedCount: 0,
        archivedCount: 0,
        totalSizeBytes: 0
      };

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const item = cursor.value;
          stats.totalCount++;
          stats.totalSizeBytes += (item.size || 0);

          if (item.type === 'text') stats.textCount++;
          else if (item.type === 'image') stats.imageCount++;
          else if (item.type === 'video') stats.videoCount++;

          if (item.pinned) stats.pinnedCount++;
          if (item.archived) stats.archivedCount++;

          cursor.continue();
        } else {
          resolve(stats);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }
}

// Export singleton instance
const db = new ClipboardDatabase();
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ClipboardDatabase, db };
} else if (typeof globalThis !== 'undefined') {
  globalThis.ClipboardDB = db;
}
