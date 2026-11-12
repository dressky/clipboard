// tests/test-storage.js - Unit tests for ClipboardDatabase logic
const assert = require('assert');
const { MockIndexedDBFactory } = require('./mock-indexeddb');

// Setup environment globals for Node.js
global.indexedDB = new MockIndexedDBFactory();
global.navigator = {
  storage: {
    persist: async () => true
  }
};
global.Blob = class Blob {
  constructor(parts) {
    this.size = parts.reduce((acc, p) => acc + (typeof p === 'string' ? Buffer.byteLength(p) : (p.length || 0)), 0);
  }
};

const { ClipboardDatabase } = require('../lib/db.js');

async function runTests() {
  console.log('--- TEST 2: INDEXEDDB & BUSINESS LOGIC ---');
  const db = new ClipboardDatabase();
  await db.init();
  console.log('✓ Database initialized with persistent storage');

  // 1. Settings test
  const defaultMode = await db.getSetting('displayMode');
  assert.strictEqual(defaultMode, 'floating', 'Default displayMode should be floating');
  await db.setSetting('displayMode', 'sidepanel');
  assert.strictEqual(await db.getSetting('displayMode'), 'sidepanel', 'Should update setting');
  console.log('✓ Settings get/set verified');

  // 2. Add text items
  const item1 = await db.addItem({
    type: 'text',
    textPayload: 'Hello world',
    title: 'Hello'
  });
  assert(item1 && item1.id, 'Item 1 should have an ID');
  assert.strictEqual(item1.textPayload, 'Hello world');
  assert.strictEqual(item1.pinned, false);
  assert.strictEqual(item1.archived, false);
  console.log('✓ Text item addition verified');

  // 3. Deduplication of identical recent text
  const duplicate = await db.addItem({
    type: 'text',
    textPayload: 'Hello world',
    title: 'Hello'
  });
  assert.strictEqual(duplicate, null, 'Immediate duplicate text should not be duplicated');
  console.log('✓ Duplicate text prevention verified');

  // 4. Add image item (mock blob)
  const fakeImageBlob = { size: 1024 * 50, type: 'image/png' };
  const itemImg = await db.addItem({
    type: 'image',
    blob: fakeImageBlob,
    title: 'Test Photo'
  });
  assert(itemImg && itemImg.type === 'image');
  assert.strictEqual(itemImg.size, 1024 * 50);
  console.log('✓ Image item addition verified');

  // 5. Add video item
  const fakeVideoBlob = { size: 1024 * 1024 * 5, type: 'video/mp4' };
  const itemVid = await db.addItem({
    type: 'video',
    blob: fakeVideoBlob,
    title: 'Test Video'
  });
  assert(itemVid && itemVid.type === 'video');
  console.log('✓ Video item addition verified');

  // 6. Pinning test
  const pinnedItem = await db.togglePin(item1.id);
  assert.strictEqual(pinnedItem.pinned, true, 'Item should now be pinned');
  const checkPin = await db.getItem(item1.id);
  assert.strictEqual(checkPin.pinned, true);
  console.log('✓ Pin toggle verified');

  // 7. Search filter test
  const searchResults = await db.getItems({ search: 'Hello' });
  assert(searchResults.some(i => i.id === item1.id), 'Search for "Hello" should find item1');
  const noResults = await db.getItems({ search: 'NonExistentString123' });
  assert.strictEqual(noResults.length, 0, 'Search for non-existent text should return 0');
  console.log('✓ Search query filtering verified');

  // 8. Type filter test
  const imageResults = await db.getItems({ filter: 'image' });
  assert(imageResults.every(i => i.type === 'image'), 'Filter image should only return images');
  assert.strictEqual(imageResults.length, 1);
  console.log('✓ Category filtering verified');

  // 9. Tiered Archival test (> 50 items)
  console.log('Testing archival threshold with 55 items...');
  // Add 55 items
  for (let i = 0; i < 55; i++) {
    await db.addItem({
      type: 'text',
      textPayload: `Archival test message #${i}`,
      title: `Msg ${i}`
    });
  }

  // Check active items (should not exceed limit)
  await db.runArchival(50);
  const activeItems = await db.getItems({ filter: 'all', showArchived: false });
  const archivedItems = await db.getItems({ filter: 'archived' });
  
  assert(archivedItems.length > 0, 'Items beyond 50 should be moved to archive');
  console.log(`✓ Archival verified: ${activeItems.length} active items, ${archivedItems.length} archived items`);

  // Ensure pinned item was NOT archived
  const pinnedAfterArchival = await db.getItem(item1.id);
  assert.strictEqual(pinnedAfterArchival.pinned, true);
  assert.strictEqual(pinnedAfterArchival.archived, false, 'Pinned items must NEVER be archived');
  console.log('✓ Pinned items immunity to archival verified');

  // 10. Delete item (Trash)
  await db.deleteItem(itemImg.id);
  const deletedCheck = await db.getItem(itemImg.id);
  assert.strictEqual(deletedCheck, null, 'Deleted item should be null');
  console.log('✓ Item deletion (Trash) verified');

  // 11. Clear unpinned items
  await db.clearAll(false); // only unpinned
  const afterClear = await db.getItems({ filter: 'all' });
  assert.strictEqual(afterClear.length, 1, 'Only pinned item should remain after unpinned clear');
  assert.strictEqual(afterClear[0].id, item1.id);
  console.log('✓ Unpinned clearing verified (pinned item preserved)');

  // 12. Retention cleanup test (deletes old unpinned, keeps pinned & recent)
  const oldItem = await db.addItem({ type: 'text', textPayload: 'Old unpinned item', title: 'Old' });
  const recentItem = await db.addItem({ type: 'text', textPayload: 'Recent unpinned item', title: 'Recent' });
  // Backdate oldItem and pinned item1 by 40 days
  const fortyDaysAgo = Date.now() - 40 * 86400000;
  for (const id of [oldItem.id, item1.id]) {
    const rec = await db.getItem(id);
    rec.createdAt = fortyDaysAgo;
    await new Promise((resolve, reject) => {
      const tx = db.db.transaction('items', 'readwrite');
      const req = tx.objectStore('items').put(rec);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
  const removedCount = await db.runRetention(30);
  assert.strictEqual(removedCount, 1, 'Retention(30d) should delete exactly 1 old unpinned item');
  assert.strictEqual(await db.getItem(oldItem.id), null, 'Old unpinned item must be deleted');
  assert(await db.getItem(item1.id), 'Old pinned item must be preserved');
  assert(await db.getItem(recentItem.id), 'Recent unpinned item must be preserved');
  console.log('✓ Retention cleanup (pinned immunity & age threshold) verified');

  // 13. Excluded sites matching test
  assert.strictEqual(db.isExcluded('https://bank.example.com/login', ['example.com']), true, 'Subdomain should match domain');
  assert.strictEqual(db.isExcluded('https://www.example.com/', ['*.example.com']), true, 'Wildcard subdomain should match');
  assert.strictEqual(db.isExcluded('https://notexample.com/', ['example.com']), false, 'Different domain suffix must not match');
  assert.strictEqual(db.isExcluded('chrome://extensions', ['extensions']), false, 'Non-http(s) URLs must not match');
  assert.strictEqual(db.isExcluded('not a url', ['example.com']), false, 'Invalid URLs must return false');
  console.log('✓ Excluded sites matcher verified');

  // 14. Export / Import backup roundtrip test
  const backup = await db.exportAll();
  assert.strictEqual(backup.format, 'clipboard-local-backup');
  assert(Array.isArray(backup.items) && backup.items.length >= 2, 'Backup should contain current items');

  // Clear all, then re-import
  await db.clearAll(true);
  assert.strictEqual((await db.getItems({ filter: 'all' })).length, 0);
  const imp1 = await db.importAll(backup);
  assert.strictEqual(imp1.added, backup.items.length, 'All backed up items should be restored');
  const imp2 = await db.importAll(backup);
  assert.strictEqual(imp2.added, 0, 'Duplicate import should skip existing IDs');
  assert.strictEqual(imp2.skipped, backup.items.length);
  await assert.rejects(() => db.importAll({ format: 'wrong' }), /Неверный формат/);
  console.log('✓ Export / Import backup roundtrip & validation verified');

  // 15. Clear all items
  await db.clearAll(true);
  const finalItems = await db.getItems({ filter: 'all' });
  assert.strictEqual(finalItems.length, 0, 'Database should be completely empty');
  console.log('✓ Complete clear verified');

  console.log('🎉 ALL STORAGE & BUSINESS LOGIC TESTS PASSED!\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
