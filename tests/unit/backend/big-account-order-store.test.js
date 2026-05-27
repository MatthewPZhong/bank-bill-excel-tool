const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readBigAccountOrder, writeBigAccountOrder } = require('../../../src/backend/big-account-order-store');

let tmpRoot;

test.beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baorder-test-'));
});

test.afterEach(() => {
  if (tmpRoot) { fs.rmSync(tmpRoot, { recursive: true, force: true }); tmpRoot = null; }
});

test.describe('readBigAccountOrder', () => {
  test('文件不存在 → null', () => {
    assert.equal(readBigAccountOrder(tmpRoot, 'tpl-1'), null);
  });

  test('合法 assignments → 返回 order 对象', () => {
    writeBigAccountOrder(tmpRoot, 'tpl-1', {
      assignments: [
        { rowIndex: 0, merchantId: 'M001', currency: 'CNY' },
        { rowIndex: 1, merchantId: 'M002', currency: 'USD' }
      ]
    });
    const r = readBigAccountOrder(tmpRoot, 'tpl-1');
    assert.equal(r.templateId, 'tpl-1');
    assert.equal(r.assignments.length, 2);
    assert.equal(r.assignments[0].merchantId, 'M001');
  });

  test('过滤无 merchantId 的行', () => {
    writeBigAccountOrder(tmpRoot, 'tpl-1', {
      assignments: [
        { rowIndex: 0, merchantId: 'M001', currency: 'CNY' },
        { rowIndex: 1, merchantId: '', currency: 'USD' }
      ]
    });
    const r = readBigAccountOrder(tmpRoot, 'tpl-1');
    assert.equal(r.assignments.length, 1);
  });

  test('包含 fileCount + files → 也回读', () => {
    writeBigAccountOrder(tmpRoot, 'tpl-1', {
      assignments: [{ rowIndex: 0, merchantId: 'M001', currency: 'CNY' }],
      fileCount: 2,
      files: [
        {
          fileIndex: 0, accountCount: 1,
          accounts: [{ merchantId: 'M001', currency: 'CNY' }]
        }
      ]
    });
    const r = readBigAccountOrder(tmpRoot, 'tpl-1');
    assert.equal(r.fileCount, 2);
    assert.equal(r.files.length, 1);
    assert.equal(r.files[0].accounts.length, 1);
  });

  test('文件损坏 → null', () => {
    const filePath = path.join(tmpRoot, 'big-account-orders', 'tpl-1.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{bad');
    assert.equal(readBigAccountOrder(tmpRoot, 'tpl-1'), null);
  });

  test('assignments 非数组 → null', () => {
    const filePath = path.join(tmpRoot, 'big-account-orders', 'tpl-1.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ templateId: 'x', assignments: null }));
    assert.equal(readBigAccountOrder(tmpRoot, 'tpl-1'), null);
  });
});

test.describe('writeBigAccountOrder', () => {
  test('自动创建目录', () => {
    writeBigAccountOrder(tmpRoot, 'tpl-1', { assignments: [] });
    assert.ok(fs.existsSync(path.join(tmpRoot, 'big-account-orders', 'tpl-1.json')));
  });

  test('data 直接是数组（向下兼容）→ 当作 assignments', () => {
    writeBigAccountOrder(tmpRoot, 'tpl-1', [
      { rowIndex: 0, merchantId: 'M001', currency: 'CNY' }
    ]);
    const r = readBigAccountOrder(tmpRoot, 'tpl-1');
    assert.equal(r.assignments.length, 1);
  });

  test('updatedAt 写入', () => {
    writeBigAccountOrder(tmpRoot, 'tpl-1', { assignments: [] });
    const parsed = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'big-account-orders', 'tpl-1.json'), 'utf8'));
    assert.ok(parsed.updatedAt.length > 0);
  });
});
