const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readOwnAccounts,
  writeOwnAccounts,
  sanitizeBankName
} = require('../../../src/backend/own-account-store');

let tmpRoot;

test.beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'own-account-test-'));
});

test.afterEach(() => {
  if (tmpRoot) { fs.rmSync(tmpRoot, { recursive: true, force: true }); tmpRoot = null; }
});

test.describe('sanitizeBankName', () => {
  test('合法字符不动', () => {
    assert.equal(sanitizeBankName('工商-北京'), '工商-北京');
  });

  test('非法字符替换为 -', () => {
    assert.equal(sanitizeBankName('工商/北京'), '工商-北京');
    assert.equal(sanitizeBankName('工商:北京'), '工商-北京');
  });

  test('空白合并为单 -', () => {
    assert.equal(sanitizeBankName('工商 北京'), '工商-北京');
  });

  test('空值 → unknown-bank', () => {
    assert.equal(sanitizeBankName(''), 'unknown-bank');
    assert.equal(sanitizeBankName(null), 'unknown-bank');
    assert.equal(sanitizeBankName(undefined), 'unknown-bank');
  });
});

test.describe('readOwnAccounts', () => {
  test('文件不存在 → 空数组', () => {
    assert.deepEqual(readOwnAccounts(tmpRoot, '工商'), []);
  });

  test('合法 JSON 数组 → 返回', () => {
    writeOwnAccounts(tmpRoot, '工商', [{ merchantId: 'OWN-001' }]);
    const r = readOwnAccounts(tmpRoot, '工商');
    assert.equal(r.length, 1);
    assert.equal(r[0].merchantId, 'OWN-001');
  });

  test('文件损坏 → 空数组', () => {
    const filePath = path.join(tmpRoot, 'own-accounts', '工商.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{bad');
    assert.deepEqual(readOwnAccounts(tmpRoot, '工商'), []);
  });

  test('文件非数组 → 空数组', () => {
    const filePath = path.join(tmpRoot, 'own-accounts', '工商.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({}));
    assert.deepEqual(readOwnAccounts(tmpRoot, '工商'), []);
  });
});

test.describe('writeOwnAccounts', () => {
  test('自动创建目录', () => {
    writeOwnAccounts(tmpRoot, '建行', [{ merchantId: 'OWN' }]);
    assert.ok(fs.existsSync(path.join(tmpRoot, 'own-accounts', '建行.json')));
  });

  test('写入空数组', () => {
    writeOwnAccounts(tmpRoot, '工商', []);
    assert.deepEqual(readOwnAccounts(tmpRoot, '工商'), []);
  });

  test('文件名 sanitize', () => {
    writeOwnAccounts(tmpRoot, '工商/北京', [{ merchantId: 'X' }]);
    assert.ok(fs.existsSync(path.join(tmpRoot, 'own-accounts', '工商-北京.json')));
  });
});
