// 模板管理【余额管理】（v3.2.16）集成验证：真实 AppDatabase（渠道、子模板、普通模板）+ 真实余额种子文件
//   ① 渠道选项只列渠道名与其子模板写入的种子；同银行段的普通模板只列自己的；种子由生成链路的同一写入函数写入
//   ② 修改余额：文件中该条变为人工录入、写入者为渠道名，其他记录不变；生成链路按人工录入查找锚点时读到新值
//   ③ 列表读取后种子被生成覆盖（计算种子）：修改与删除都返回 conflict，文件保留生成写入的值
//   ④ 删除：只删所选一条；生成链路查前一日种子时退回到更早的记录；普通模板的种子不受影响
//   ⑤ 渠道改名后按新名称的银行段读取（与生成时的输出身份一致）；旧银行段里渠道与子模板写入的种子成为遗留，
//      在读该文件的普通模板下可见（生成仍会按账号读到它们）
//   活动日志由 Main 的 IPC 包装调用 buildBalanceSeedActivityLog（单测覆盖），本脚本验证数据与文件。
//
// 用法：node scripts/integration/balance-seed-management.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../src/backend/database');
const {
  findPreviousBalanceSeed,
  getBalanceSeedFilePath,
  readBalanceSeedRecords,
  upsertBalanceSeedRecord
} = require('../../src/backend/balance-seed-store');
const {
  deleteOwnerSeed,
  listOwnerSeeds,
  updateOwnerSeed
} = require('../../src/main-process/balance-seed-management');

const CALCULATED = '通过发生额计算';
const MANUAL = '人工录入';

function writeSeed(storageRoot, templateName, merchantId, currency, billDate, endBalance, generationMethod = CALCULATED) {
  const result = upsertBalanceSeedRecord(storageRoot, {
    templateName, merchantId, currency, billDate, endBalance, generationMethod, overwrite: true
  });
  assert.equal(result.status, 'success');
}

function keyOf(record) {
  return { merchantId: record.merchantId, currency: record.currency, billDate: record.billDate };
}

function summarize(records) {
  return records.map((record) => [record.merchantId, record.billDate, record.endBalance, record.generationMethod, record.templateName]);
}

async function run() {
  console.log('==== 模板管理【余额管理】 集成验证 ====');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'balance-seed-management-'));
  const storageRoot = path.join(temporary, 'documents');
  const userData = path.join(temporary, 'userData');
  fs.mkdirSync(storageRoot, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  const database = new AppDatabase(path.join(userData, 'tool-data.sqlite'));
  database.init();

  const headers = ['交易日期', '账号', '币种', '发生额'];
  const defineTemplate = (name) => database.upsertTemplate({ name, sourceFileName: `${name}.xlsx`, headers });
  const owner = defineTemplate('招商银行-上海');
  const channelId = database.saveMappings(owner.id, [], [], [], undefined, null, { channelAssignment: { mode: 'create' } })
    .channelAssignment.channelId;
  const child = defineTemplate('招商银行-上海-子模板-1');
  database.saveMappings(child.id, [], [], [], undefined, null, { channelAssignment: { mode: 'join', channelId } });
  const beijing = defineTemplate('招商银行-北京');
  const channelOwner = { kind: 'channel', id: channelId };
  const beijingOwner = { kind: 'template', id: beijing.id };
  const seedFile = getBalanceSeedFilePath(storageRoot, '招商银行');

  // 生成链路写入的种子：渠道（输出名为渠道名）、迁移前子模板（写入者为子模板名）、同银行段普通模板。
  writeSeed(storageRoot, '招商银行-上海', 'M001', 'USD', '2026-09-01', 1000);
  writeSeed(storageRoot, '招商银行-上海', 'M001', 'USD', '2026-09-02', 1010);
  writeSeed(storageRoot, '招商银行-上海', 'M001', 'USD', '2026-09-03', 1020);
  writeSeed(storageRoot, '招商银行-上海-子模板-1', 'M002', 'CNY', '2026-08-31', 500, '账单里的余额');
  writeSeed(storageRoot, '招商银行-北京', 'B001', 'CNY', '2026-09-01', 7000);

  const results = [];
  const cases = [
    ['① 渠道与普通模板各自只列自己写入的种子，渠道包含迁移前子模板写入的种子', () => {
      const channelList = listOwnerSeeds({ database, storageRoot, owner: channelOwner });
      assert.equal(channelList.owner.name, '招商银行-上海');
      assert.equal(channelList.owner.seedFileName, '招商银行.json');
      assert.deepEqual(summarize(channelList.records), [
        ['M001', '2026-09-03', 1020, CALCULATED, '招商银行-上海'],
        ['M001', '2026-09-02', 1010, CALCULATED, '招商银行-上海'],
        ['M001', '2026-09-01', 1000, CALCULATED, '招商银行-上海'],
        ['M002', '2026-08-31', 500, '账单里的余额', '招商银行-上海-子模板-1']
      ]);
      assert.deepEqual(summarize(listOwnerSeeds({ database, storageRoot, owner: beijingOwner }).records), [
        ['B001', '2026-09-01', 7000, CALCULATED, '招商银行-北京']
      ]);
      assert.throws(
        () => listOwnerSeeds({ database, storageRoot, owner: { kind: 'template', id: child.id } }),
        (error) => error.code === 'BALANCE_SEED_OWNER_IN_CHANNEL'
      );
    }],
    ['② 修改余额后该条为人工录入、写入者为渠道名，生成链路按人工录入找锚点时读到新值', () => {
      const target = listOwnerSeeds({ database, storageRoot, owner: channelOwner }).records
        .find((record) => record.billDate === '2026-09-02');
      const otherBefore = readBalanceSeedRecords(storageRoot, '招商银行').filter((record) => record.billDate !== '2026-09-02');
      const result = updateOwnerSeed({
        database, storageRoot,
        payload: { owner: channelOwner, key: keyOf(target), expected: target, endBalance: '1,005.25' }
      });
      assert.equal(result.status, 'success');
      assert.equal(result.filePath, seedFile);
      const stored = readBalanceSeedRecords(storageRoot, '招商银行');
      const updated = stored.find((record) => record.merchantId === 'M001' && record.billDate === '2026-09-02');
      assert.deepEqual([updated.endBalance, updated.generationMethod, updated.templateName], [1005.25, MANUAL, '招商银行-上海']);
      const otherAfter = stored.filter((record) => record.billDate !== '2026-09-02');
      assert.deepEqual(otherAfter, otherBefore);
      const anchor = findPreviousBalanceSeed(storageRoot, {
        bankName: '招商银行', merchantId: 'M001', currency: 'USD', beforeBillDate: '2026-09-05', generationMethod: MANUAL
      });
      assert.deepEqual([anchor.billDate, anchor.endBalance], ['2026-09-02', 1005.25]);
    }],
    ['③ 列表读取后种子被生成覆盖：修改与删除返回 conflict，文件保留生成写入的值', () => {
      const target = listOwnerSeeds({ database, storageRoot, owner: channelOwner }).records
        .find((record) => record.billDate === '2026-09-03');
      writeSeed(storageRoot, '招商银行-上海', 'M001', 'USD', '2026-09-03', 1030);
      const before = fs.readFileSync(seedFile, 'utf8');
      const updated = updateOwnerSeed({
        database, storageRoot,
        payload: { owner: channelOwner, key: keyOf(target), expected: target, endBalance: '1' }
      });
      const deleted = deleteOwnerSeed({ database, storageRoot, payload: { owner: channelOwner, key: keyOf(target), expected: target } });
      assert.deepEqual([updated.status, deleted.status], ['conflict', 'conflict']);
      assert.equal(fs.readFileSync(seedFile, 'utf8'), before);
      const stored = readBalanceSeedRecords(storageRoot, '招商银行')
        .find((record) => record.merchantId === 'M001' && record.billDate === '2026-09-03');
      assert.equal(stored.endBalance, 1030);
    }],
    ['④ 删除只删所选一条，生成链路查前一日种子退回更早记录，普通模板的种子不受影响', () => {
      const target = listOwnerSeeds({ database, storageRoot, owner: channelOwner }).records
        .find((record) => record.billDate === '2026-09-03');
      const result = deleteOwnerSeed({ database, storageRoot, payload: { owner: channelOwner, key: keyOf(target), expected: target } });
      assert.equal(result.status, 'success');
      assert.equal(result.previous.endBalance, 1030);
      const previous = findPreviousBalanceSeed(storageRoot, {
        bankName: '招商银行', merchantId: 'M001', currency: 'USD', beforeBillDate: '2026-09-04'
      });
      assert.deepEqual([previous.billDate, previous.endBalance], ['2026-09-02', 1005.25]);
      assert.deepEqual(summarize(listOwnerSeeds({ database, storageRoot, owner: beijingOwner }).records), [
        ['B001', '2026-09-01', 7000, CALCULATED, '招商银行-北京']
      ]);
      assert.equal(readBalanceSeedRecords(storageRoot, '招商银行').length, 4);
    }],
    ['⑤ 渠道改名后按新名称的银行段读取，旧银行段的渠道与子模板种子在同文件的普通模板下可见', () => {
      database.renameStatementChannel(channelId, '招行-上海');
      const renamed = listOwnerSeeds({ database, storageRoot, owner: channelOwner });
      assert.deepEqual([renamed.owner.name, renamed.owner.seedFileName, renamed.records.length], ['招行-上海', '招行.json', 0]);
      assert.deepEqual(summarize(listOwnerSeeds({ database, storageRoot, owner: beijingOwner }).records), [
        ['B001', '2026-09-01', 7000, CALCULATED, '招商银行-北京'],
        ['M001', '2026-09-02', 1005.25, MANUAL, '招商银行-上海'],
        ['M001', '2026-09-01', 1000, CALCULATED, '招商银行-上海'],
        ['M002', '2026-08-31', 500, '账单里的余额', '招商银行-上海-子模板-1']
      ]);
      writeSeed(storageRoot, '招行-上海', 'M001', 'USD', '2026-09-10', 2000);
      assert.deepEqual(summarize(listOwnerSeeds({ database, storageRoot, owner: channelOwner }).records), [
        ['M001', '2026-09-10', 2000, CALCULATED, '招行-上海']
      ]);
    }]
  ];

  try {
    for (const [label, body] of cases) {
      try {
        await body();
        results.push({ label, ok: true });
        console.log(`PASS ${label}`);
      } catch (error) {
        results.push({ label, ok: false, error });
        console.log(`FAIL ${label}\n  ${error && error.stack ? error.stack : error}`);
      }
    }
  } finally {
    try { database.close(); } catch (_error) { /* 已关闭 */ }
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  const passed = results.filter((item) => item.ok).length;
  console.log(`\n==== ${passed}/${results.length} PASS ====`);
  if (passed !== results.length) {
    console.error('FAILURES:');
    results.filter((item) => !item.ok).forEach((item) => console.error(`  - ${item.label}: ${item.error && item.error.message}`));
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
