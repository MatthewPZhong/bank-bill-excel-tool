const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readBigAccountMode, writeBigAccountMode } = require('../../../src/backend/big-account-mode-store');

let tmpRoot;

test.beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baomode-test-'));
});

test.afterEach(() => {
  if (tmpRoot) { fs.rmSync(tmpRoot, { recursive: true, force: true }); tmpRoot = null; }
});

test.describe('readBigAccountMode', () => {
  test('文件不存在 → unfixed（默认）', () => {
    assert.equal(readBigAccountMode(tmpRoot, 'tpl-1'), 'unfixed');
  });

  test('合法文件 mode=fixed → fixed', () => {
    writeBigAccountMode(tmpRoot, 'tpl-1', 'fixed');
    assert.equal(readBigAccountMode(tmpRoot, 'tpl-1'), 'fixed');
  });

  test('合法文件 mode=unfixed → unfixed', () => {
    writeBigAccountMode(tmpRoot, 'tpl-1', 'unfixed');
    assert.equal(readBigAccountMode(tmpRoot, 'tpl-1'), 'unfixed');
  });

  test('文件损坏 → unfixed 默认（不抛错）', () => {
    const filePath = path.join(tmpRoot, 'big-account-modes', 'tpl-1.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{bad');
    assert.equal(readBigAccountMode(tmpRoot, 'tpl-1'), 'unfixed');
  });

  test('mode 是其他值 → unfixed', () => {
    const filePath = path.join(tmpRoot, 'big-account-modes', 'tpl-1.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ mode: 'other-mode' }));
    assert.equal(readBigAccountMode(tmpRoot, 'tpl-1'), 'unfixed');
  });
});

test.describe('writeBigAccountMode', () => {
  test('写入 fixed', () => {
    writeBigAccountMode(tmpRoot, 'tpl-1', 'fixed');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'big-account-modes', 'tpl-1.json'), 'utf8'));
    assert.equal(parsed.mode, 'fixed');
    assert.equal(parsed.templateId, 'tpl-1');
  });

  test('mode 非 fixed/unfixed → 归一为 unfixed', () => {
    writeBigAccountMode(tmpRoot, 'tpl-1', 'random');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'big-account-modes', 'tpl-1.json'), 'utf8'));
    assert.equal(parsed.mode, 'unfixed');
  });

  test('updatedAt 自动写入', () => {
    writeBigAccountMode(tmpRoot, 'tpl-1', 'fixed');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'big-account-modes', 'tpl-1.json'), 'utf8'));
    assert.ok(parsed.updatedAt.length > 0);
  });

  test('templateId 数字 → 转字符串', () => {
    writeBigAccountMode(tmpRoot, 123, 'fixed');
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'big-account-modes', '123.json'), 'utf8'));
    assert.equal(parsed.templateId, '123');
  });
});
