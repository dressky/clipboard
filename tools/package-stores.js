// tools/package-stores.js - Automated packager for Chrome Web Store & Firefox AMO
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(DIST)) {
  fs.mkdirSync(DIST, { recursive: true });
}

// Runtime paths included in store packages (relative to extension root)
const INCLUDE_PATHS = [
  'background',
  'content',
  'fonts/Tiny5Mono-Regular.woff2',
  'fonts/Tiny5Mono-Bold.woff2',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
  'icons/pixel',
  'lib',
  'ui'
];

// CRC32 table for ZIP generation
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function collectFiles(rootDir, relPaths) {
  const entries = [];
  function walk(rel) {
    const abs = path.join(rootDir, rel);
    if (!fs.existsSync(abs)) return;
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) {
        walk(rel + '/' + name);
      }
    } else if (stat.isFile()) {
      entries.push({
        name: rel.replace(/\\/g, '/'),
        data: fs.readFileSync(abs),
        mtime: stat.mtime
      });
    }
  }
  for (const p of relPaths) {
    walk(p.replace(/\\/g, '/'));
  }
  return entries;
}

function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const yr = Math.max(1980, d.getFullYear()) - 1980;
  const dosTime = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F);
  const dosDate = ((yr & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
  return { dosTime, dosDate };
}

// Pure-Node POSIX ZIP writer (always uses '/' separators, required by Firefox AMO & Chrome Web Store)
function writeZip(outPath, entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const compressed = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const { dosTime, dosDate } = dosDateTime(entry.mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034B50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014B50, 0);
    centralHeader.writeUInt16LE(0x0314, 4); // UNIX + v2.0
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054B50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  fs.writeFileSync(outPath, Buffer.concat([...localParts, centralBuf, eocd]));
}

console.log('====================================================');
console.log('    STORE PACKAGING AUTOMATION (CHROME & FIREFOX)   ');
console.log('====================================================\n');

const baseFiles = collectFiles(ROOT, INCLUDE_PATHS);
const manifestPath = path.join(ROOT, 'manifest.json');
const manifestMtime = fs.statSync(manifestPath).mtime;
const chromeManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

// 1. Chrome Web Store build
const chromeZip = path.join(DIST, `clipboard-chrome-v${chromeManifest.version}.zip`);
if (fs.existsSync(chromeZip)) fs.unlinkSync(chromeZip);

writeZip(chromeZip, [
  ...baseFiles,
  { name: 'manifest.json', data: Buffer.from(JSON.stringify(chromeManifest, null, 2) + '\n', 'utf8'), mtime: manifestMtime }
]);
console.log(`✓ Chrome Web Store build ready: ${chromeZip} (${(fs.statSync(chromeZip).size / 1024).toFixed(1)} KB)`);

// 2. Firefox Add-on (AMO) build
const firefoxManifest = JSON.parse(JSON.stringify(chromeManifest));

firefoxManifest.browser_specific_settings = {
  gecko: {
    id: 'clipboard-local-private@dressky.github.io',
    strict_min_version: '140.0',
    data_collection_permissions: {
      required: ['none']
    }
  },
  gecko_android: {
    strict_min_version: '142.0'
  }
};

// Firefox MV3 loads background scripts in a non-worker page without importScripts()
firefoxManifest.background = {
  scripts: [
    'lib/db.js',
    'background/service-worker.js'
  ]
};

// Remove Chrome-only fields
firefoxManifest.permissions = firefoxManifest.permissions.filter(p => p !== 'sidePanel');
delete firefoxManifest.side_panel;
delete firefoxManifest.minimum_chrome_version;

const firefoxZip = path.join(DIST, `clipboard-firefox-v${chromeManifest.version}.zip`);
if (fs.existsSync(firefoxZip)) fs.unlinkSync(firefoxZip);

writeZip(firefoxZip, [
  ...baseFiles,
  { name: 'manifest.json', data: Buffer.from(JSON.stringify(firefoxManifest, null, 2) + '\n', 'utf8'), mtime: manifestMtime }
]);
console.log(`✓ Firefox AMO build ready: ${firefoxZip} (${(fs.statSync(firefoxZip).size / 1024).toFixed(1)} KB)`);

console.log('\n====================================================');
console.log('  🎉 BOTH PRODUCTION BUILDS PACKAGED SUCCESSFULLY!   ');
console.log('====================================================');
