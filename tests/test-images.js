// tests/test-images.js - Verifies full image lifecycle: creation, retrieval, thumbnailing, base64 dataUrl conversion
const assert = require('assert');
const path = require('path');
const { MockIndexedDBFactory } = require('./mock-indexeddb');

// Setup environment globals for Node.js
global.indexedDB = new MockIndexedDBFactory();
global.navigator = {
  storage: {
    persist: async () => true
  }
};
global.btoa = (str) => Buffer.from(str, 'binary').toString('base64');

class MockBlob {
  constructor(parts = [], options = {}) {
    this.type = options.type || 'image/png';
    this._parts = parts;
    this.size = parts.reduce((acc, p) => acc + (typeof p === 'string' ? Buffer.byteLength(p) : (p.length || 0)), 0);
  }
  async arrayBuffer() {
    const buffers = this._parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p));
    const combined = Buffer.concat(buffers);
    return combined.buffer.slice(combined.byteOffset, combined.byteOffset + combined.byteLength);
  }
}
global.Blob = MockBlob;

const { ClipboardDatabase } = require('../lib/db.js');

async function runImageTests() {
  console.log('--- TEST: IMAGE LIFECYCLE & THUMBNAIL INTEGRITY ---');

  const db = new ClipboardDatabase();
  await db.init();

  // 1. Create mock PNG blob
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
  const mockBlob = new MockBlob([pngHeader], { type: 'image/png' });

  // 2. Add image item
  console.log('1. Adding image item...');
  const added = await db.addItem({
    type: 'image',
    blob: mockBlob,
    mimeType: 'image/png',
    sourceUrl: 'https://example.com/photo.png',
    title: 'Тестовое фото'
  });

  assert(added, 'Item must be created');
  assert.strictEqual(added.type, 'image');
  assert(added.id, 'Item must have an id');
  assert(added.previewUrl && added.previewUrl.startsWith('data:image/'), 'PreviewUrl must be a valid Data URL');
  console.log('✓ Image added successfully with thumbnail previewUrl');

  // 3. Query items with filter: 'image'
  console.log('2. Querying images filter...');
  const images = await db.getItems({ filter: 'image' });
  assert(images.length >= 1, 'Should find at least 1 image');
  assert.strictEqual(images[0].type, 'image');
  assert(images[0].previewUrl, 'Image in getItems must have previewUrl');
  console.log('✓ Image filter query verified');

  // 4. Retrieve raw item with blob
  console.log('3. Getting full raw item with blob...');
  const retrieved = await db.getItem(added.id);
  assert(retrieved, 'Item must exist');
  assert(retrieved.blob, 'Blob must be preserved in IndexedDB');
  assert.strictEqual(retrieved.blob.size, mockBlob.size);
  console.log('✓ Full image retrieval with binary blob verified');

  // 5. Test _blobToDataUrl conversion
  console.log('4. Converting Blob to DataURL...');
  const dataUrl = await db._blobToDataUrl(retrieved.blob);
  assert(dataUrl && dataUrl.startsWith('data:image/png;base64,'), 'DataUrl must be base64 PNG');
  console.log('✓ Blob to DataURL conversion verified');

  console.log('🎉 ALL IMAGE TESTS PASSED!\n');
}

runImageTests().catch(err => {
  console.error('❌ Image tests failed:', err);
  process.exit(1);
});
