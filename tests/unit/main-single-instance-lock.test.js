'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mainSource = fs.readFileSync(path.resolve(__dirname, '../../src/main.js'), 'utf8');

test.describe('Electron single-instance guard', () => {
  test('normal app startup acquires a process-wide lock before whenReady', () => {
    assert.match(mainSource, /app\.requestSingleInstanceLock\(\)/);
    assert.match(mainSource, /if \(hasSingleInstanceLock\) app\.whenReady\(\)/);
    assert.match(mainSource, /if \(!hasSingleInstanceLock\)\s*\{\s*app\.quit\(\)/);
  });

  test('second instance restores and focuses the existing main window', () => {
    assert.match(mainSource, /app\.on\('second-instance',[\s\S]*mainWindow\.isMinimized\(\)[\s\S]*mainWindow\.restore\(\)/);
    assert.match(mainSource, /app\.on\('second-instance',[\s\S]*mainWindow\.show\(\)[\s\S]*mainWindow\.focus\(\)/);
  });

  test('isolated preview and startup measurement may bypass the production lock', () => {
    assert.match(mainSource, /requireSingleInstanceLock\s*=\s*!process\.env\.APP_CAPTURE_PATH/);
  });
});
