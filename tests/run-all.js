// tests/run-all.js - Runs all test suites
const { execSync } = require('child_process');
const path = require('path');

console.log('====================================================');
console.log('    CLIPBOARD EXTENSION AUTOMATED TEST SUITE        ');
console.log('====================================================\n');

try {
  console.log('Running Manifest & Integrity Tests...');
  execSync(`node "${path.join(__dirname, 'test-manifest.js')}"`, { stdio: 'inherit' });

  console.log('Running IndexedDB & Archival Unit Tests...');
  execSync(`node "${path.join(__dirname, 'test-storage.js')}"`, { stdio: 'inherit' });

  console.log('Running Image Lifecycle & Blob DataURL Tests...');
  execSync(`node "${path.join(__dirname, 'test-images.js')}"`, { stdio: 'inherit' });

  console.log('Running Chrome Headless Browser Tests...');
  execSync(`node "${path.join(__dirname, 'test-chrome-headless.js')}"`, { stdio: 'inherit' });

  console.log('====================================================');
  console.log('  ✅ ALL TESTS PASSED SUCCESSFULLY! 100% READY!      ');
  console.log('====================================================');
} catch (err) {
  console.error('\n❌ Test execution failed.');
  process.exit(1);
}
