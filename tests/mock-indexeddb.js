// tests/mock-indexeddb.js - In-memory mock for IndexedDB to test ClipboardDatabase in Node.js

class MockIndex {
  constructor(store, indexName, keyPath) {
    this.store = store;
    this.indexName = indexName;
    this.keyPath = keyPath;
  }

  openCursor(range, direction = 'next') {
    return this.store.openCursor(range, direction, this.keyPath);
  }
}

class MockObjectStore {
  constructor(name, keyPath) {
    this.name = name;
    this.keyPath = keyPath;
    this.data = new Map();
    this.indexes = new Map();
  }

  createIndex(name, keyPath, options) {
    const idx = new MockIndex(this, name, keyPath);
    this.indexes.set(name, idx);
    return idx;
  }

  index(name) {
    return this.indexes.get(name);
  }

  _clone(item) {
    if (!item) return item;
    const copy = { ...item };
    if (item.metadata) copy.metadata = { ...item.metadata };
    return copy;
  }

  add(item) {
    const req = { onsuccess: null, onerror: null, result: null };
    const key = item[this.keyPath];
    if (this.data.has(key)) {
      setTimeout(() => {
        if (req.onerror) req.onerror({ target: { error: new Error('Key already exists') } });
      }, 0);
    } else {
      this.data.set(key, this._clone(item));
      req.result = key;
      setTimeout(() => {
        if (req.onsuccess) req.onsuccess({ target: { result: key } });
      }, 0);
    }
    return req;
  }

  put(item) {
    const req = { onsuccess: null, onerror: null, result: null };
    const key = item[this.keyPath];
    this.data.set(key, this._clone(item));
    req.result = key;
    setTimeout(() => {
      if (req.onsuccess) req.onsuccess({ target: { result: key } });
    }, 0);
    return req;
  }

  get(key) {
    const req = { onsuccess: null, onerror: null, result: null };
    const item = this.data.get(key);
    req.result = item ? this._clone(item) : undefined;
    setTimeout(() => {
      if (req.onsuccess) req.onsuccess({ target: { result: req.result } });
    }, 0);
    return req;
  }

  getAll() {
    const req = { onsuccess: null, onerror: null, result: null };
    const items = Array.from(this.data.values()).map(i => JSON.parse(JSON.stringify(i)));
    req.result = items;
    setTimeout(() => {
      if (req.onsuccess) req.onsuccess({ target: { result: items } });
    }, 0);
    return req;
  }

  delete(key) {
    const req = { onsuccess: null, onerror: null, result: null };
    this.data.delete(key);
    setTimeout(() => {
      if (req.onsuccess) req.onsuccess({ target: { result: undefined } });
    }, 0);
    return req;
  }

  clear() {
    const req = { onsuccess: null, onerror: null, result: null };
    this.data.clear();
    setTimeout(() => {
      if (req.onsuccess) req.onsuccess({ target: { result: undefined } });
    }, 0);
    return req;
  }

  openCursor(range, direction = 'next', sortKey = null) {
    const req = { onsuccess: null, onerror: null, result: null };
    let items = Array.from(this.data.values()).map(i => JSON.parse(JSON.stringify(i)));

    if (sortKey) {
      items.sort((a, b) => {
        const valA = a[sortKey] || 0;
        const valB = b[sortKey] || 0;
        return direction === 'prev' ? valB - valA : valA - valB;
      });
    }

    let currentIndex = 0;

    const makeCursor = () => {
      if (currentIndex >= items.length) return null;
      const currentItem = items[currentIndex];

      return {
        value: currentItem,
        key: currentItem[this.keyPath],
        continue: () => {
          currentIndex++;
          const nextCursor = makeCursor();
          setTimeout(() => {
            if (req.onsuccess) req.onsuccess({ target: { result: nextCursor } });
          }, 0);
        },
        delete: () => {
          this.data.delete(currentItem[this.keyPath]);
        }
      };
    };

    setTimeout(() => {
      if (req.onsuccess) {
        req.onsuccess({ target: { result: makeCursor() } });
      }
    }, 0);

    return req;
  }
}

class MockDatabase {
  constructor(name) {
    this.name = name;
    this.objectStoreNames = {
      stores: new Map(),
      contains: (s) => this.objectStoreNames.stores.has(s)
    };
  }

  createObjectStore(name, { keyPath }) {
    const store = new MockObjectStore(name, keyPath);
    this.objectStoreNames.stores.set(name, store);
    return store;
  }

  transaction(storeNames, mode) {
    const name = Array.isArray(storeNames) ? storeNames[0] : storeNames;
    const store = this.objectStoreNames.stores.get(name);
    return {
      objectStore: () => store
    };
  }
}

class MockIndexedDBFactory {
  constructor() {
    this.databases = new Map();
  }

  open(name, version) {
    const req = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null };

    setTimeout(() => {
      let db = this.databases.get(name);
      let isNew = !db;
      if (isNew) {
        db = new MockDatabase(name);
        this.databases.set(name, db);
      }

      req.result = db;

      if (isNew && req.onupgradeneeded) {
        req.onupgradeneeded({ target: { result: db } });
      }

      if (req.onsuccess) {
        req.onsuccess({ target: { result: db } });
      }
    }, 0);

    return req;
  }
}

module.exports = { MockIndexedDBFactory };
