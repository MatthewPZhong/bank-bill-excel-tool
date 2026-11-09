'use strict';

// v3.2.16 模板管理【余额管理】：按渠道 / 普通模板的可见范围、只改余额并转为人工录入、乐观并发核对与删除单条。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BalanceSeedManagementError,
  buildBalanceSeedActivityLog,
  deleteOwnerSeed,
  listOwnerSeeds,
  resolveSeedOwner,
  updateOwnerSeed
} = require('../../../src/main-process/balance-seed-management');
const { getBalanceSeedFilePath } = require('../../../src/backend/balance-seed-store');

// 渠道「招商银行-上海」含两个子模板；普通模板「招商银行-北京」与渠道同银行段；「汇丰-香港」另一银行段。
function createFakeDatabase() {
  const channels = [{ id: 7, name: '招商银行-上海' }];
  const templates = [
    { id: 1, name: '招商银行-上海-子模板-1', channelId: 7, channelName: '招商银行-上海' },
    { id: 2, name: 'CMB-SH-OLD', channelId: 7, channelName: '招商银行-上海' },
    { id: 3, name: '招商银行-北京', channelId: null, channelName: null },
    { id: 4, name: '汇丰-香港', channelId: null, channelName: null }
  ];
  return {
    getStatementChannel: (id) => channels.find((channel) => channel.id === Number(id)) || null,
    listStatementChannels: () => channels.map((channel) => ({ ...channel })),
    listTemplates: () => templates.map((template) => ({ ...template })),
    getTemplate: (id) => {
      const template = templates.find((item) => item.id === Number(id));
      return template ? { ...template } : null;
    }
  };
}

function seed(merchantId, currency, billDate, endBalance, templateName, generationMethod = '通过发生额计算') {
  return { merchantId, currency, billDate, endBalance, templateName, '生成方式': generationMethod, updatedAt: `${billDate}T00:00:00.000Z` };
}

function setupStorage(t, seeds = {}) {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-seed-management-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  for (const [bankName, records] of Object.entries(seeds)) {
    const filePath = getBalanceSeedFilePath(storageRoot, bankName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
  }
  return storageRoot;
}

function readSeedFile(storageRoot, bankName) {
  return JSON.parse(fs.readFileSync(getBalanceSeedFilePath(storageRoot, bankName), 'utf8'));
}

const CMB_SEEDS = [
  seed('1001', 'CNY', '2026-10-01', 100, '招商银行-上海'),
  seed('1001', 'CNY', '2026-10-02', 150, '招商银行-上海', '人工录入'),
  seed('1002', 'USD', '2026-09-30', 20.5, 'CMB-SH-OLD', '账单里的余额'),
  seed('2001', 'CNY', '2026-10-01', 999, '招商银行-北京'),
  // 早期没有写入者、生成方式与更新时间的旧记录：读取时生成方式按人工录入。
  { merchantId: '3001', currency: 'CNY', billDate: '2026-08-01', endBalance: 1 },
  // 写入者已改名或删除（不是任何现有渠道 / 模板）的遗留记录。
  seed('4001', 'CNY', '2026-07-31', 8, '招商银行-旧名'),
  // 写入者仍存在，但其现在的归属读另一份种子文件（汇丰.json），生成按账号读本文件时它仍会被读到。
  seed('5001', 'CNY', '2026-07-30', 9, '汇丰-香港')
];

test('渠道可见渠道名与全部子模板写入的种子、空写入者与遗留写入者记录，同银行段其他模板的不可见；按账号升序、日期降序', (t) => {
  const storageRoot = setupStorage(t, { 招商银行: CMB_SEEDS });
  const result = listOwnerSeeds({ database: createFakeDatabase(), storageRoot, owner: { kind: 'channel', id: 7 } });

  assert.deepEqual(result.owner, {
    kind: 'channel', id: 7, name: '招商银行-上海', bankName: '招商银行', seedFileName: '招商银行.json'
  });
  assert.deepEqual(
    result.records.map((record) => [record.merchantId, record.billDate, record.endBalance, record.generationMethod]),
    [
      ['1001', '2026-10-02', 150, '人工录入'],
      ['1001', '2026-10-01', 100, '通过发生额计算'],
      ['1002', '2026-09-30', 20.5, '账单里的余额'],
      ['3001', '2026-08-01', 1, '人工录入'],
      ['4001', '2026-07-31', 8, '通过发生额计算'],
      ['5001', '2026-07-30', 9, '通过发生额计算']
    ]
  );
});

test('普通模板只看到自己写入的、空写入者与遗留写入者记录；属于渠道的模板、不存在的选项与非法选项被拒', (t) => {
  const storageRoot = setupStorage(t, { 招商银行: CMB_SEEDS });
  const database = createFakeDatabase();
  const result = listOwnerSeeds({ database, storageRoot, owner: { kind: 'template', id: 3 } });
  assert.deepEqual(result.records.map((record) => record.merchantId), ['2001', '3001', '4001', '5001']);

  assert.deepEqual(listOwnerSeeds({ database, storageRoot, owner: { kind: 'template', id: 4 } }).records, []);

  for (const [owner, code] of [
    [{ kind: 'template', id: 1 }, 'BALANCE_SEED_OWNER_IN_CHANNEL'],
    [{ kind: 'channel', id: 99 }, 'BALANCE_SEED_OWNER_NOT_FOUND'],
    [{ kind: 'template', id: 99 }, 'BALANCE_SEED_OWNER_NOT_FOUND'],
    [{ kind: 'bank', id: 1 }, 'BALANCE_SEED_OWNER_INVALID'],
    [{ kind: 'channel', id: '7x' }, 'BALANCE_SEED_OWNER_INVALID'],
    [null, 'BALANCE_SEED_OWNER_INVALID']
  ]) {
    assert.throws(() => resolveSeedOwner(database, owner), (error) => {
      assert.ok(error instanceof BalanceSeedManagementError);
      assert.equal(error.code, code);
      return true;
    });
  }
});

test('修改只改余额：生成方式转为人工录入、写入者改为渠道名，其他记录不变', (t) => {
  const storageRoot = setupStorage(t, { 招商银行: CMB_SEEDS });
  const database = createFakeDatabase();
  const owner = { kind: 'channel', id: 7 };
  const [, , target] = listOwnerSeeds({ database, storageRoot, owner }).records;
  const now = new Date('2026-11-08T12:00:00.000Z');

  const result = updateOwnerSeed({
    database,
    storageRoot,
    now,
    payload: {
      owner,
      key: { merchantId: '1002', currency: 'USD', billDate: '2026-09-30' },
      expected: target,
      endBalance: '1,234.56'
    }
  });

  assert.equal(result.status, 'success');
  assert.equal(result.changed, true);
  assert.equal(result.previous.endBalance, 20.5);
  assert.deepEqual(result.record, {
    merchantId: '1002',
    currency: 'USD',
    billDate: '2026-09-30',
    endBalance: 1234.56,
    generationMethod: '人工录入',
    templateName: '招商银行-上海',
    updatedAt: now.toISOString()
  });

  const stored = readSeedFile(storageRoot, '招商银行');
  const updated = stored.find((record) => record.merchantId === '1002');
  assert.deepEqual(updated, {
    merchantId: '1002', currency: 'USD', billDate: '2026-09-30', endBalance: 1234.56,
    templateName: '招商银行-上海', '生成方式': '人工录入', updatedAt: now.toISOString()
  });
  // 其他记录内容不变；旧记录按种子库既有写入口径补齐空写入者、人工录入与空更新时间（与补录、生成写入一致）。
  const byKey = (a, b) => `${a.merchantId}${a.billDate}`.localeCompare(`${b.merchantId}${b.billDate}`);
  const others = stored.filter((record) => record.merchantId !== '1002').sort(byKey);
  const expectedOthers = CMB_SEEDS.filter((record) => record.merchantId !== '1002' && record.merchantId !== '3001')
    .concat([{ merchantId: '3001', currency: 'CNY', billDate: '2026-08-01', endBalance: 1, templateName: '', '生成方式': '人工录入', updatedAt: '' }])
    .sort(byKey);
  assert.deepEqual(others, expectedOthers);
});

test('余额未变时不写文件；非数字余额被拒且不写文件', (t) => {
  const storageRoot = setupStorage(t, { 招商银行: CMB_SEEDS });
  const database = createFakeDatabase();
  const owner = { kind: 'channel', id: 7 };
  const filePath = getBalanceSeedFilePath(storageRoot, '招商银行');
  const before = fs.readFileSync(filePath, 'utf8');
  const target = listOwnerSeeds({ database, storageRoot, owner }).records[1];
  const key = { merchantId: target.merchantId, currency: target.currency, billDate: target.billDate };

  const unchanged = updateOwnerSeed({ database, storageRoot, payload: { owner, key, expected: target, endBalance: '100.00' } });
  assert.equal(unchanged.status, 'success');
  assert.equal(unchanged.changed, false);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);

  for (const endBalance of ['', 'abc', '1e3', null]) {
    assert.throws(
      () => updateOwnerSeed({ database, storageRoot, payload: { owner, key, expected: target, endBalance } }),
      (error) => error.code === 'BALANCE_SEED_BALANCE_INVALID'
    );
  }
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

test('期间被改过、已不存在或对当前选项不可见的种子返回 conflict，不写文件', (t) => {
  const storageRoot = setupStorage(t, { 招商银行: CMB_SEEDS });
  const database = createFakeDatabase();
  const channelOwner = { kind: 'channel', id: 7 };
  const filePath = getBalanceSeedFilePath(storageRoot, '招商银行');
  const before = fs.readFileSync(filePath, 'utf8');
  const target = listOwnerSeeds({ database, storageRoot, owner: channelOwner }).records[1];
  const key = { merchantId: target.merchantId, currency: target.currency, billDate: target.billDate };

  const staleCases = [
    { ...target, endBalance: 101 },
    { ...target, updatedAt: '2026-11-01T00:00:00.000Z' },
    { ...target, generationMethod: '人工录入' },
    { ...target, templateName: 'CMB-SH-OLD' },
    null
  ];
  for (const expected of staleCases) {
    const updated = updateOwnerSeed({ database, storageRoot, payload: { owner: channelOwner, key, expected, endBalance: '5' } });
    assert.equal(updated.status, 'conflict');
    assert.equal(updated.message, '余额种子已变化，请刷新后重试');
    const deleted = deleteOwnerSeed({ database, storageRoot, payload: { owner: channelOwner, key, expected } });
    assert.equal(deleted.status, 'conflict');
  }

  const missing = updateOwnerSeed({
    database, storageRoot,
    payload: { owner: channelOwner, key: { ...key, billDate: '2026-10-03' }, expected: target, endBalance: '5' }
  });
  assert.equal(missing.status, 'conflict');

  // 「招商银行-北京」写入的种子对渠道不可见；带着正确原值也不能经渠道修改或删除。
  const beijingSeed = listOwnerSeeds({ database, storageRoot, owner: { kind: 'template', id: 3 } }).records[0];
  const beijingKey = { merchantId: beijingSeed.merchantId, currency: beijingSeed.currency, billDate: beijingSeed.billDate };
  assert.equal(updateOwnerSeed({
    database, storageRoot, payload: { owner: channelOwner, key: beijingKey, expected: beijingSeed, endBalance: '5' }
  }).status, 'conflict');
  assert.equal(deleteOwnerSeed({
    database, storageRoot, payload: { owner: channelOwner, key: beijingKey, expected: beijingSeed }
  }).status, 'conflict');

  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
});

test('删除只删一条；删到空时文件为空数组；同键重复记录拒绝处理', (t) => {
  const storageRoot = setupStorage(t, {
    汇丰: [seed('9001', 'HKD', '2026-10-01', 10, '汇丰-香港')],
    招商银行: CMB_SEEDS
  });
  const database = createFakeDatabase();

  const channelOwner = { kind: 'channel', id: 7 };
  const target = listOwnerSeeds({ database, storageRoot, owner: channelOwner }).records[0];
  const result = deleteOwnerSeed({
    database, storageRoot,
    payload: {
      owner: channelOwner,
      key: { merchantId: target.merchantId, currency: target.currency, billDate: target.billDate },
      expected: target
    }
  });
  assert.equal(result.status, 'success');
  assert.equal(result.previous.endBalance, 150);
  const remaining = readSeedFile(storageRoot, '招商银行');
  assert.equal(remaining.length, CMB_SEEDS.length - 1);
  assert.ok(!remaining.some((record) => record.merchantId === '1001' && record.billDate === '2026-10-02'));

  const hsbcOwner = { kind: 'template', id: 4 };
  const [only] = listOwnerSeeds({ database, storageRoot, owner: hsbcOwner }).records;
  deleteOwnerSeed({
    database, storageRoot,
    payload: { owner: hsbcOwner, key: { merchantId: '9001', currency: 'HKD', billDate: '2026-10-01' }, expected: only }
  });
  assert.equal(fs.readFileSync(getBalanceSeedFilePath(storageRoot, '汇丰'), 'utf8'), '[]\n');

  const duplicatedRoot = setupStorage(t, {
    汇丰: [seed('9001', 'HKD', '2026-10-01', 10, '汇丰-香港'), seed('9001', 'HKD', '2026-10-01', 11, '汇丰-香港')]
  });
  const duplicated = listOwnerSeeds({ database, storageRoot: duplicatedRoot, owner: hsbcOwner }).records[0];
  assert.throws(
    () => deleteOwnerSeed({
      database, storageRoot: duplicatedRoot,
      payload: { owner: hsbcOwner, key: { merchantId: '9001', currency: 'HKD', billDate: '2026-10-01' }, expected: duplicated }
    }),
    (error) => error.code === 'BALANCE_SEED_DUPLICATE'
  );
});

test('种子文件不存在时列表为空；文件损坏时抛出原有的损坏提示', (t) => {
  const storageRoot = setupStorage(t);
  const database = createFakeDatabase();
  assert.deepEqual(listOwnerSeeds({ database, storageRoot, owner: { kind: 'channel', id: 7 } }).records, []);

  const filePath = getBalanceSeedFilePath(storageRoot, '招商银行');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '{ broken', 'utf8');
  assert.throws(
    () => listOwnerSeeds({ database, storageRoot, owner: { kind: 'channel', id: 7 } }),
    (error) => error.name === 'FileValidationError' && /余额种子文件损坏/.test(error.message)
  );
});

test('活动日志记录所属、种子文件、键、原值与新值、原生成方式与原写入者', () => {
  const previous = {
    merchantId: '1002', currency: '', billDate: '2026-09-30', endBalance: 20.5,
    generationMethod: '账单里的余额', templateName: '', updatedAt: ''
  };
  const base = { ownerLabel: '渠道「招商银行-上海」', filePath: '/data/balance-seeds/招商银行.json', previous };
  assert.deepEqual(buildBalanceSeedActivityLog('update', {
    ...base,
    record: { ...previous, endBalance: 30, generationMethod: '人工录入', templateName: '招商银行-上海' }
  }), {
    message: '修改余额种子成功',
    details: [
      '所属：渠道「招商银行-上海」',
      '种子文件：/data/balance-seeds/招商银行.json',
      '账户号：1002',
      '币种：（空）',
      '日期：2026-09-30',
      '余额：20.5 → 30',
      '生成方式：账单里的余额 → 人工录入',
      '原写入者：（空）'
    ]
  });
  assert.deepEqual(buildBalanceSeedActivityLog('delete', base).details.slice(-3), [
    '余额：20.5',
    '生成方式：账单里的余额',
    '原写入者：（空）'
  ]);
  assert.equal(buildBalanceSeedActivityLog('delete', base).message, '删除余额种子成功');
});
