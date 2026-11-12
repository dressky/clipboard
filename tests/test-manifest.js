// tests/test-manifest.js - Automated Manifest, Source Hygiene & Store ZIP Verification
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const zlib = require('zlib');

const EXT_DIR = path.join(__dirname, '..');
console.log('--- TEST 1: MANIFEST, HYGIENE & DIST ZIP INTEGRITY ---');

// Helper: parse ZIP entries without external tools
function readZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const map = new Map();
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034B50) {
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 30, off + 30 + nameLen);
    const dataStart = off + 30 + nameLen + extraLen;
    const compData = buf.subarray(dataStart, dataStart + compSize);
    const raw = method === 8 ? zlib.inflateRawSync(compData) : compData;
    map.set(name, raw);
    off = dataStart + compSize;
  }
  return map;
}

// 1. Read manifest.json
const manifestPath = path.join(EXT_DIR, 'manifest.json');
assert(fs.existsSync(manifestPath), 'manifest.json must exist');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// 2. Validate MV3 fields
assert.strictEqual(manifest.manifest_version, 3, 'Must be Manifest V3');
assert(manifest.name, 'Extension must have a name');
assert(manifest.version, 'Extension must have a version');
assert(manifest.description && manifest.description.length <= 132, 'Description must exist and be <= 132 chars');
assert(manifest.homepage_url && manifest.homepage_url.startsWith('https://'), 'homepage_url must be HTTPS');
console.log('✓ Manifest V3 metadata valid:', manifest.name, 'v' + manifest.version);

// 3. Validate permissions
const requiredPerms = ['storage', 'unlimitedStorage', 'contextMenus', 'clipboardRead', 'clipboardWrite', 'activeTab', 'tabs', 'scripting', 'sidePanel'];
requiredPerms.forEach(perm => {
  assert(manifest.permissions.includes(perm), `Missing permission: ${perm}`);
});
console.log(`✓ Permissions verified (all ${requiredPerms.length} permissions present)`);

// 4. Validate icons exist and are valid PNGs
assert(manifest.icons, 'icons definition missing');
[16, 32, 48, 128].forEach(size => {
  const iconRel = manifest.icons[String(size)];
  assert(iconRel, `Icon size ${size} not declared in manifest`);
  const iconPath = path.join(EXT_DIR, iconRel);
  assert(fs.existsSync(iconPath), `Icon file ${iconPath} does not exist`);
  const buf = fs.readFileSync(iconPath);
  assert.strictEqual(buf[0], 0x89);
  assert.strictEqual(buf[1], 0x50);
  assert.strictEqual(buf[2], 0x4E);
  assert.strictEqual(buf[3], 0x47);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  assert.strictEqual(w, size, `Icon ${size} width mismatch: ${w}`);
  assert.strictEqual(h, size, `Icon ${size} height mismatch: ${h}`);
  console.log(`✓ Icon ${size}x${size} valid PNG (${buf.length} bytes)`);
});

// 5. Validate background service worker & Firefox importScripts guard
assert(manifest.background && manifest.background.service_worker, 'Background service worker not declared');
const swPath = path.join(EXT_DIR, manifest.background.service_worker);
assert(fs.existsSync(swPath), `Service worker file ${swPath} does not exist`);
const swSource = fs.readFileSync(swPath, 'utf8');
assert(/typeof\s+importScripts\s*===\s*['"]function['"]/.test(swSource), 'service-worker.js must guard importScripts for Firefox background.scripts');
console.log('✓ Service worker file & Firefox importScripts guard verified');

// 6. Validate content scripts & UI files exist and contain no unsafe innerHTML
assert(Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0, 'content_scripts missing');
manifest.content_scripts.forEach(cs => {
  (cs.js || []).forEach(jsFile => {
    const p = path.join(EXT_DIR, jsFile);
    assert(fs.existsSync(p), `Content script ${jsFile} does not exist`);
    const src = fs.readFileSync(p, 'utf8');
    assert(!/\.innerHTML\s*=/.test(src), `${jsFile} must not assign .innerHTML directly`);
  });
});
const panelJsSrc = fs.readFileSync(path.join(EXT_DIR, 'ui', 'panel.js'), 'utf8');
assert(!/\.innerHTML\s*=/.test(panelJsSrc), 'ui/panel.js must not assign .innerHTML directly');
const csSrc = fs.readFileSync(path.join(EXT_DIR, 'content', 'content-script.js'), 'utf8');
assert(/!e\.ctrlKey\s*&&\s*!e\.metaKey/.test(csSrc), 'content-script.js Alt+V shortcut must ignore Ctrl/Meta modifiers');
const panelCssSrc = fs.readFileSync(path.join(EXT_DIR, 'ui', 'panel.css'), 'utf8');
assert(/@media\s*\(min-width:\s*450px\)/.test(panelCssSrc), 'ui/panel.css must expand beyond 440x580 in side panel and standalone window');
console.log('✓ Content scripts & UI JS/CSS verified (no unsafe innerHTML assignments, responsive sizing, safe shortcut)');

// 7. Validate UI entry points
assert(manifest.action && manifest.action.default_popup, 'default_popup missing');
assert(fs.existsSync(path.join(EXT_DIR, manifest.action.default_popup)), 'Popup HTML missing');
assert(manifest.side_panel && manifest.side_panel.default_path, 'side_panel missing');
assert(fs.existsSync(path.join(EXT_DIR, manifest.side_panel.default_path)), 'Side panel HTML missing');
console.log('✓ UI entry points verified');

// 8. Validate fonts & web_accessible_resources
const fontPath = path.join(EXT_DIR, 'fonts', 'Tiny5Mono-Regular.woff2');
assert(fs.existsSync(fontPath), 'Tiny5Mono font file must exist');
const war = (manifest.web_accessible_resources || []).flatMap(r => r.resources || []);
war.forEach(res => {
  if (!res.includes('*')) {
    assert(fs.existsSync(path.join(EXT_DIR, res)), `Declared web_accessible_resource missing: ${res}`);
  }
});
console.log('✓ Fonts and web_accessible_resources verified');

// 9. Validate Commands
assert(manifest.commands && manifest.commands['toggle-clipboard'], 'toggle-clipboard command missing');
assert.strictEqual(manifest.commands['toggle-clipboard'].suggested_key.default, 'Alt+V');
console.log('✓ Shortcut verified (Alt+V)');

// 10. Validate packaged store ZIPs if present
const chromeZipPath = path.join(EXT_DIR, 'dist', `clipboard-chrome-v${manifest.version}.zip`);
const firefoxZipPath = path.join(EXT_DIR, 'dist', `clipboard-firefox-v${manifest.version}.zip`);

if (fs.existsSync(chromeZipPath)) {
  const cEntries = readZipEntries(chromeZipPath);
  for (const name of cEntries.keys()) {
    assert(!name.includes('\\'), `Chrome ZIP entry contains backslash: ${name}`);
  }
  assert(cEntries.has('manifest.json'), 'Chrome ZIP must contain manifest.json');
  assert(cEntries.has('background/service-worker.js'), 'Chrome ZIP must contain background/service-worker.js');
  console.log(`✓ Chrome store ZIP verified (${cEntries.size} entries, POSIX '/' paths)`);
}

if (fs.existsSync(firefoxZipPath)) {
  const fEntries = readZipEntries(firefoxZipPath);
  for (const name of fEntries.keys()) {
    assert(!name.includes('\\'), `Firefox ZIP entry contains backslash: ${name}`);
  }
  assert(fEntries.has('manifest.json'), 'Firefox ZIP must contain manifest.json');
  const ffManifest = JSON.parse(fEntries.get('manifest.json').toString('utf8'));
  assert(ffManifest.browser_specific_settings && ffManifest.browser_specific_settings.gecko, 'Firefox manifest missing gecko block');
  assert(ffManifest.browser_specific_settings.gecko.id, 'Firefox manifest missing gecko.id');
  assert.deepStrictEqual(
    ffManifest.browser_specific_settings.gecko.data_collection_permissions,
    { required: ['none'] },
    'Firefox manifest missing data_collection_permissions: { required: ["none"] }'
  );
  assert.deepStrictEqual(
    ffManifest.background.scripts,
    ['lib/db.js', 'background/service-worker.js'],
    'Firefox background.scripts must include lib/db.js before background/service-worker.js'
  );
  assert(!ffManifest.permissions.includes('sidePanel'), 'Firefox manifest must not include sidePanel permission');
  assert(!ffManifest.side_panel, 'Firefox manifest must not include side_panel');
  assert(!ffManifest.minimum_chrome_version, 'Firefox manifest must not include minimum_chrome_version');
  console.log(`✓ Firefox AMO ZIP verified (${fEntries.size} entries, POSIX '/' paths, valid AMO manifest)`);
}

console.log('🎉 ALL MANIFEST & PACKAGE INTEGRITY CHECKS PASSED!\n');
