const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BALANCE_SEED_GENERATION_METHODS,
  findPreviousBalanceSeed,
  getBalanceSeedFilePath,
  getBalanceSeedsDir,
  listBalanceSeedBankNames,
  readBalanceSeedRecords,
  splitTemplateName,
  upsertBalanceSeedRecord,
  writeBalanceSeedRecords
} = require('../../../src/backend/balance-seed-store');

let tmpRoot;

test.beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-seed-test-'));
});

test.afterEach(() => {
  if (tmpRoot) { fs.rmSync(tmpRoot, { recursive: true, force: true }); tmpRoot = null; }
});

// ========================================================================
// 常量
// ========================================================================

test.describe('BALANCE_SEED_GENERATION_METHODS 常量', () => {
  test('包含 statement / calculated / manual 三种', () => {
    assert.equal(BALANCE_SEED_GENERATION_METHODS.statement, '账单里的余额');
    assert.equal(BALANCE_SEED_GENERATION_METHODS.calculated, '通过发生额计算');
    assert.equal(BALANCE_SEED_GENERATION_METHODS.manual, '人工录入');
  });

  test('Object.freeze 锁死', () => {
    assert.ok(Object.isFrozen(BALANCE_SEED_GENERATION_METHODS));
  });
});

// ========================================================================
// splitTemplateName
// ========================================================================

test.describe('splitTemplateName', () => {
  test('单连字符 → bankName / location', () => {
    assert.deepEqual(splitTemplateName('工商-北京'), { bankName: '工商', location: '北京' });
  });

  test('无连字符 → 全为 bankName', () => {
    assert.deepEqual(splitTemplateName('工商银行'), { bankName: '工商银行', location: '' });
  });

  test('多连字符 → 取前 2 段', () => {
    const r = splitTemplateName('工商-北京-人民币');
    assert.equal(r.bankName, '工商');
    assert.equal(r.location, '北京');
  });

  test('空 / null → 空 bankName + location', () => {
    assert.deepEqual(splitTemplateName(''), { bankName: '', location: '' });
    assert.deepEqual(splitTemplateName(null), { bankName: '', location: '' });
    assert.deepEqual(splitTemplateName(undefined), { bankName: '', location: '' });
  });
});

// ========================================================================
// getBalanceSeedsDir / getBalanceSeedFilePath
// ========================================================================

test.describe('路径函数', () => {
  test('getBalanceSeedsDir = <root>/balance-seeds', () => {
    assert.equal(getBalanceSeedsDir(tmpRoot), path.join(tmpRoot, 'balance-seeds'));
  });

  test('getBalanceSeedFilePath = <root>/balance-seeds/<bank>.json', () => {
    assert.equal(
      getBalanceSeedFilePath(tmpRoot, '工商'),
      path.join(tmpRoot, 'balance-seeds', '工商.json')
    );
  });

  test('文件名 sanitize：剥非法字符（< > : " / \\ | ? *）', () => {
    const filePath = getBalanceSeedFilePath(tmpRoot, '工商/北京');
    assert.match(filePath, /工商-北京\.json$/);
  });

  test('空 bankName → unknown-bank 兜底', () => {
    const filePath = getBalanceSeedFilePath(tmpRoot, '');
    assert.match(filePath, /unknown-bank\.json$/);
  });
});

// ========================================================================
// listBalanceSeedBankNames
// ========================================================================

test.describe('listBalanceSeedBankNames', () => {
  test('目录不存在 → 空数组', () => {
    assert.deepEqual(listBalanceSeedBankNames(tmpRoot), []);
  });

  test('多个 *.json → 返回去扩展名的列表', () => {
    const dir = getBalanceSeedsDir(tmpRoot);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '工商.json'), '[]');
    fs.writeFileSync(path.join(dir, '建行.json'), '[]');
    fs.writeFileSync(path.join(dir, '其它.txt'), '[]'); // 非 json 跳过
    const r = listBalanceSeedBankNames(tmpRoot);
    assert.deepEqual(r.sort(), ['工商', '建行']);
  });
});

// ========================================================================
// readBalanceSeedRecords
// ========================================================================

test.describe('readBalanceSeedRecords', () => {
  test('文件不存在 → 空数组', () => {
    assert.deepEqual(readBalanceSeedRecords(tmpRoot, '工商'), []);
  });

  test('合法 JSON → 反序列化 + 字段归一', () => {
    const filePath = getBalanceSeedFilePath(tmpRoot, '工商');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([
      { merchantId: 'M001', currency: 'CNY', billDate: '2026-05-22', endBalance: 1000.5, templateName: '工商-北京' }
    ]));
    const r = readBalanceSeedRecords(tmpRoot, '工商');
    assert.equal(r.length, 1);
    assert.equal(r[0].merchantId, 'M001');
    assert.equal(r[0].endBalance, 1000.5);
  });

  test('过滤无效行（缺 merchantId / billDate / endBalance）', () => {
    const filePath = getBalanceSeedFilePath(tmpRoot, '工商');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([
      { merchantId: 'M001', currency: 'CNY', billDate: '2026-05-22', endBalance: 100 },
      { merchantId: '', currency: 'CNY', billDate: '2026-05-22', endBalance: 100 }, // 无 merchantId
      { merchantId: 'M002', currency: 'CNY', billDate: '', endBalance: 100 }, // 无 billDate
      { merchantId: 'M003', currency: 'CNY', billDate: '2026-05-22', endBalance: null } // 无 endBalance
    ]));
    const r = readBalanceSeedRecords(tmpRoot, '工商');
    assert.equal(r.length, 1);
  });

  test('文件非数组 → 空数组', () => {
    const filePath = getBalanceSeedFilePath(tmpRoot, '工商');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ not: 'array' }));
    assert.deepEqual(readBalanceSeedRecords(tmpRoot, '工商'), []);
  });

  test('文件损坏 → 抛 FileValidationError', () => {
    const filePath = getBalanceSeedFilePath(tmpRoot, '工商');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{not json');
    assert.throws(
      () => readBalanceSeedRecords(tmpRoot, '工商'),
      /本地余额种子文件损坏/
    );
  });

  test('"生成方式" 中文字段 / generationMethod 英文字段都支持', () => {
    const filePath = getBalanceSeedFilePath(tmpRoot, '工商');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify([
      { merchantId: 'M1', billDate: '2026-05-22', endBalance: 100, '生成方式': '账单里的余额' },
      { merchantId: 'M2', billDate: '2026-05-22', endBalance: 200, generationMethod: '通过发生额计算' }
    ]));
    const r = readBalanceSeedRecords(tmpRoot, '工商');
    assert.equal(r[0].generationMethod, '账单里的余额');
    assert.equal(r[1].generationMethod, '通过发生额计算');
  });
});

// ========================================================================
// writeBalanceSeedRecords
// ========================================================================

test.describe('writeBalanceSeedRecords', () => {
  test('写入 + 按 merchantId|currency|billDate 排序', () => {
    writeBalanceSeedRecords(tmpRoot, '工商', [
      { merchantId: 'M002', currency: 'CNY', billDate: '2026-05-22', endBalance: 200 },
      { merchantId: 'M001', currency: 'CNY', billDate: '2026-05-22', endBalance: 100 }
    ]);
    const r = readBalanceSeedRecords(tmpRoot, '工商');
    assert.equal(r[0].merchantId, 'M001');
    assert.equal(r[1].merchantId, 'M002');
  });

  test('自动创建目录', () => {
    const filePath = writeBalanceSeedRecords(tmpRoot, '新银行', [
      { merchantId: 'M', currency: 'CNY', billDate: '2026-05-22', endBalance: 1 }
    ]);
    assert.ok(fs.existsSync(filePath));
  });

  test('过滤无效行（与 read 同规则）', () => {
    writeBalanceSeedRecords(tmpRoot, '工商', [
      { merchantId: 'M001', billDate: '2026-05-22', endBalance: 100 },
      { merchantId: '', billDate: '2026-05-22', endBalance: 100 } // 无 merchantId
    ]);
    const r = readBalanceSeedRecords(tmpRoot, '工商');
    assert.equal(r.length, 1);
  });
});

// ========================================================================
// upsertBalanceSeedRecord
// ========================================================================

test.describe('upsertBalanceSeedRecord', () => {
  test('新记录 → status=success', () => {
    const r = upsertBalanceSeedRecord(tmpRoot, {
      templateName: '工商-北京',
      merchantId: 'M001',
      currency: 'CNY',
      billDate: '2026-05-22',
      endBalance: 100
    });
    assert.equal(r.status, 'success');
    assert.ok(r.filePath);
    assert.equal(r.record.merchantId, 'M001');
  });

  test('已存在 + overwrite=false → status=confirm-overwrite', () => {
    upsertBalanceSeedRecord(tmpRoot, {
      templateName: '工商-北京',
      merchantId: 'M001', currency: 'CNY', billDate: '2026-05-22', endBalance: 100
    });
    const r = upsertBalanceSeedRecord(tmpRoot, {
      templateName: '工商-北京',
      merchantId: 'M001', currency: 'CNY', billDate: '2026-05-22', endBalance: 200
    });
    assert.equal(r.status, 'confirm-overwrite');
    assert.equal(r.existingRecord.endBalance, 100);
    assert.equal(r.incomingRecord.endBalance, 200);
  });

  test('已存在 + overwrite=true → 覆盖成功', () => {
    upsertBalanceSeedRecord(tmpRoot, {
      templateName: '工商-北京',
      merchantId: 'M001', currency: 'CNY', billDate: '2026-05-22', endBalance: 100
    });
    const r = upsertBalanceSeedRecord(tmpRoot, {
      templateName: '工商-北京',
      merchantId: 'M001', currency: 'CNY', billDate: '2026-05-22', endBalance: 200,
      overwrite: true
    });
    assert.equal(r.status, 'success');
    assert.equal(r.record.endBalance, 200);
  });

  test('默认 generationMethod = 人工录入', () => {
    const r = upsertBalanceSeedRecord(tmpRoot, {
      templateName: '工商-北京',
      merchantId: 'M001', currency: 'CNY', billDate: '2026-05-22', endBalance: 100
    });
    assert.equal(r.record.generationMethod, '人工录入');
  });
});

// ========================================================================
// findPreviousBalanceSeed
// ========================================================================

test.describe('findPreviousBalanceSeed', () => {
  test('返回 billDate 严格小于 beforeBillDate 的最新记录', () => {
    writeBalanceSeedRecords(tmpRoot, '工商', [
      { merchantId: 'M001', currency: 'CNY', billDate: '2026-03-01', endBalance: 100 },
      { merchantId: 'M001', currency: 'CNY', billDate: '2026-04-01', endBalance: 200 },
      { merchantId: 'M001', currency: 'CNY', billDate: '2026-05-01', endBalance: 300 }
    ]);
    const r = findPreviousBalanceSeed(tmpRoot, {
      bankName: '工商',
      merchantId: 'M001',
      currency: 'CNY',
      beforeBillDate: '2026-05-01'
    });
    assert.equal(r.billDate, '2026-04-01');
    assert.equal(r.endBalance, 200);
  });

  test('无符合条件 → null', () => {
    writeBalanceSeedRecords(tmpRoot, '工商', [
      { merchantId: 'M001', currency: 'CNY', billDate: '2026-05-01', endBalance: 100 }
    ]);
    const r = findPreviousBalanceSeed(tmpRoot, {
      bankName: '工商', merchantId: 'M001', currency: 'CNY', beforeBillDate: '2026-04-01'
    });
    assert.equal(r, null);
  });

  test('文件不存在 → null', () => {
    const r = findPreviousBalanceSeed(tmpRoot, {
      bankName: 'no-bank', merchantId: 'M001', currency: 'CNY', beforeBillDate: '2026-05-01'
    });
    assert.equal(r, null);
  });

  test('匹配 merchantId + currency 复合 key', () => {
    writeBalanceSeedRecords(tmpRoot, '工商', [
      { merchantId: 'M001', currency: 'CNY', billDate: '2026-04-01', endBalance: 100 },
      { merchantId: 'M001', currency: 'USD', billDate: '2026-04-01', endBalance: 50 } // 不同 currency
    ]);
    const r = findPreviousBalanceSeed(tmpRoot, {
      bankName: '工商', merchantId: 'M001', currency: 'USD', beforeBillDate: '2026-05-01'
    });
    assert.equal(r.currency, 'USD');
    assert.equal(r.endBalance, 50);
  });
});
