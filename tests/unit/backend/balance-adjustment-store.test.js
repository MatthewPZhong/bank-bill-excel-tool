const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readBalanceAdjustments,
  writeBalanceAdjustments,
  resolveBalanceAdjustment
} = require('../../../src/backend/balance-adjustment-store');

let tmpRoot;

test.beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-adj-test-'));
});

test.afterEach(() => {
  if (tmpRoot) { fs.rmSync(tmpRoot, { recursive: true, force: true }); tmpRoot = null; }
});

// ========================================================================
// readBalanceAdjustments
// ========================================================================

test.describe('readBalanceAdjustments', () => {
  test('文件不存在 → 空数组', () => {
    assert.deepEqual(readBalanceAdjustments(tmpRoot, '工商'), []);
  });

  test('合法 JSON → 反序列化', () => {
    writeBalanceAdjustments(tmpRoot, '工商', [
      { merchantId: 'M001', currency: 'CNY', effectiveDate: '2026-05-22', adjustmentValue: 100.5 }
    ]);
    const r = readBalanceAdjustments(tmpRoot, '工商');
    assert.equal(r.length, 1);
    assert.equal(r[0].merchantId, 'M001');
    assert.equal(r[0].adjustmentValue, 100.5);
  });

  test('过滤无效行（缺 merchantId / effectiveDate / adjustmentValue）', () => {
    writeBalanceAdjustments(tmpRoot, '工商', [
      { merchantId: 'M001', currency: 'CNY', effectiveDate: '2026-05-22', adjustmentValue: 100 },
      // 写后被 normalize；下面手动写入非法行
    ]);
    // 直接写入非法 JSON 测试 read 过滤
    const filePath = path.join(tmpRoot, 'balance-adjustments', '工商.json');
    fs.writeFileSync(filePath, JSON.stringify([
      { merchantId: '', currency: '', effectiveDate: '2026-05-22', adjustmentValue: 100 },
      { merchantId: 'M002', currency: '', effectiveDate: '', adjustmentValue: 100 },
      { merchantId: 'M003', currency: '', effectiveDate: '2026-05-22', adjustmentValue: null },
      { merchantId: 'M004', currency: '', effectiveDate: '2026-05-22', adjustmentValue: 50 }
    ]));
    const r = readBalanceAdjustments(tmpRoot, '工商');
    assert.equal(r.length, 1);
    assert.equal(r[0].merchantId, 'M004');
  });

  test('文件损坏 → 空数组（不抛错）', () => {
    const filePath = path.join(tmpRoot, 'balance-adjustments', '工商.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{bad json');
    assert.deepEqual(readBalanceAdjustments(tmpRoot, '工商'), []);
  });

  test('非数组 → 空数组', () => {
    const filePath = path.join(tmpRoot, 'balance-adjustments', '工商.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{}');
    assert.deepEqual(readBalanceAdjustments(tmpRoot, '工商'), []);
  });
});

// ========================================================================
// writeBalanceAdjustments
// ========================================================================

test.describe('writeBalanceAdjustments', () => {
  test('正常写入 + 自动创建目录', () => {
    writeBalanceAdjustments(tmpRoot, '建行', [
      { merchantId: 'M001', currency: 'CNY', effectiveDate: '2026-05-22', adjustmentValue: 100 }
    ]);
    const r = readBalanceAdjustments(tmpRoot, '建行');
    assert.equal(r.length, 1);
  });

  test('日期格式归一：2026/5/22 → 2026-05-22', () => {
    writeBalanceAdjustments(tmpRoot, '建行', [
      { merchantId: 'M001', currency: 'CNY', effectiveDate: '2026/5/22', adjustmentValue: 100 }
    ]);
    const r = readBalanceAdjustments(tmpRoot, '建行');
    assert.equal(r[0].effectiveDate, '2026-05-22');
  });

  test('updatedAt 自动写入当前时间', () => {
    writeBalanceAdjustments(tmpRoot, '建行', [
      { merchantId: 'M001', currency: 'CNY', effectiveDate: '2026-05-22', adjustmentValue: 100 }
    ]);
    const r = readBalanceAdjustments(tmpRoot, '建行');
    assert.ok(r[0].updatedAt.length > 0);
  });

  test('文件名 sanitize：剥非法字符（/）', () => {
    writeBalanceAdjustments(tmpRoot, '工商/北京', [
      { merchantId: 'M001', currency: 'CNY', effectiveDate: '2026-05-22', adjustmentValue: 100 }
    ]);
    // 用 sanitize 后名读出
    const r = readBalanceAdjustments(tmpRoot, '工商/北京');
    assert.equal(r.length, 1);
  });

  test('空 bankName → unknown-bank', () => {
    writeBalanceAdjustments(tmpRoot, '', [
      { merchantId: 'M001', currency: 'CNY', effectiveDate: '2026-05-22', adjustmentValue: 100 }
    ]);
    assert.ok(fs.existsSync(path.join(tmpRoot, 'balance-adjustments', 'unknown-bank.json')));
  });
});

// ========================================================================
// resolveBalanceAdjustment
// ========================================================================

test.describe('resolveBalanceAdjustment', () => {
  test('累加所有 ≤ dateLabel 的同 merchant+currency 调整', () => {
    const adjustments = [
      { merchantId: 'M001', currency: 'CNY', effectiveDate: '2026-03-01', adjustmentValue: 100 },
      { merchantId: 'M001', currency: 'CNY', effectiveDate: '2026-04-01', adjustmentValue: 200 },
      { merchantId: 'M001', currency: 'CNY', effectiveDate: '2026-06-01', adjustmentValue: 999 } // 在 dateLabel 之后
    ];
    const sum = resolveBalanceAdjustment(adjustments, {
      merchantId: 'M001', currency: 'CNY', dateLabel: '2026-05-01'
    });
    assert.equal(sum, 300);
  });

  test('无匹配 → 0', () => {
    const adjustments = [
      { merchantId: 'M001', currency: 'CNY', effectiveDate: '2026-03-01', adjustmentValue: 100 }
    ];
    const sum = resolveBalanceAdjustment(adjustments, {
      merchantId: 'M002', currency: 'CNY', dateLabel: '2026-05-01'
    });
    assert.equal(sum, 0);
  });

  test('过滤 currency 不匹配', () => {
    const adjustments = [
      { merchantId: 'M001', currency: 'CNY', effectiveDate: '2026-03-01', adjustmentValue: 100 },
      { merchantId: 'M001', currency: 'USD', effectiveDate: '2026-03-01', adjustmentValue: 50 }
    ];
    const sum = resolveBalanceAdjustment(adjustments, {
      merchantId: 'M001', currency: 'CNY', dateLabel: '2026-05-01'
    });
    assert.equal(sum, 100);
  });

  test('effectiveDate 严格 ≤ dateLabel（边界包含）', () => {
    const adjustments = [
      { merchantId: 'M', currency: 'CNY', effectiveDate: '2026-05-01', adjustmentValue: 50 }
    ];
    const sum = resolveBalanceAdjustment(adjustments, {
      merchantId: 'M', currency: 'CNY', dateLabel: '2026-05-01'
    });
    assert.equal(sum, 50);
  });

  test('adjustmentValue null → 兜底 0（不累加）', () => {
    const adjustments = [
      { merchantId: 'M', currency: 'CNY', effectiveDate: '2026-03-01', adjustmentValue: null },
      { merchantId: 'M', currency: 'CNY', effectiveDate: '2026-04-01', adjustmentValue: 100 }
    ];
    const sum = resolveBalanceAdjustment(adjustments, {
      merchantId: 'M', currency: 'CNY', dateLabel: '2026-05-01'
    });
    assert.equal(sum, 100);
  });
});
