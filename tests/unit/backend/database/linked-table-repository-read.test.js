// v2.1.16-beta.2 T1：readLinkedTableRows（读回链接表整行）单测
//
// 覆盖：
//   - gateway-bill 还原 2 行：raw_json → 对象、字段完整（用真实网关表头）、顺序 = id ASC
//   - 损坏行（raw_json 非法 JSON）被跳过，仅返回好行（不抛错、不中断）
//   - fx-option（模板缺失 supported=false）返回 []（不查表）
//   - facade database.readLinkedTableRows 等价于仓储函数
//
// DB 搭建：复用与现有 linked-table-repository.test.js 相同方式（AppDatabase + init()）。
//   linked_gateway_bill 表（含 id INTEGER PRIMARY KEY AUTOINCREMENT / reconciliation_id /
//   bill_date / raw_json / imported_at）由 init() 内 ensureLinkedTableSupport migration 建好。
//   为精确控制 id 顺序与注入损坏行，直接用底层 INSERT 插入（不经 replaceLinkedTable —— 它必 JSON.stringify 无法产坏 json）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AppDatabase } = require('../../../../src/backend/database');
const linkedRepo = require('../../../../src/backend/database/linked-table-repository');

let appDb;
let db;
let tmpDir;

test.beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linked-read-'));
  appDb = new AppDatabase(path.join(tmpDir, 'test.sqlite'));
  appDb.init();
  db = appDb.db;
});

test.afterEach(() => {
  try { if (appDb && appDb.close) appDb.close(); } catch (_e) { /* ignore */ }
  if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

// 真实网关表头整行（字段名取自 table-signatures GATEWAY_RECON_SIGNATURE：全小写 reconciliationid / merchantid 等）。
function gatewayRow({ reconId, tradeType, billDate, merchantId, currency, amount, orderId }) {
  return {
    Billdate: billDate,
    Channel: 'GW',
    merchantid: merchantId,
    orderid: orderId,
    bussiness: 'biz',
    currency,
    amount,
    reconciliationid: reconId,
    TradeType: tradeType,
    'Credit/Debit': 'C',
    bookdate: billDate,
    账单状态: '已对账'
  };
}

// 底层插入一行 linked_gateway_bill（指定 raw_json 原文，可注入损坏 json）。
function insertGatewayRaw(rawJson, { reconId = '', billDate = '' } = {}) {
  db.prepare(
    'INSERT INTO linked_gateway_bill (reconciliation_id, bill_date, raw_json, imported_at) VALUES (?, ?, ?, ?)'
  ).run(reconId, billDate, rawJson, new Date().toISOString());
}

test.describe('linked-table-repository.readLinkedTableRows（v2.1.16-beta.2 T1）', () => {
  test('gateway-bill：还原 2 行，字段完整 + 顺序 = id ASC', () => {
    const row1 = gatewayRow({
      reconId: 'RC-1001', tradeType: 'AchReturn', billDate: '2026-03-10',
      merchantId: 'M001', currency: 'USD', amount: '100.00', orderId: 'ORD-1'
    });
    const row2 = gatewayRow({
      reconId: 'RC-1002', tradeType: 'FundTransfer-out', billDate: '2026-03-11',
      merchantId: 'M002', currency: 'EUR', amount: '-200.50', orderId: 'ORD-2'
    });
    insertGatewayRaw(JSON.stringify(row1), { reconId: 'RC-1001', billDate: '2026-03-10' });
    insertGatewayRaw(JSON.stringify(row2), { reconId: 'RC-1002', billDate: '2026-03-11' });

    const out = linkedRepo.readLinkedTableRows(db, 'gateway-bill');
    assert.equal(out.length, 2, '还原 2 行');

    // 顺序 = id ASC（先插的 RC-1001 在前）
    assert.equal(out[0].reconciliationid, 'RC-1001');
    assert.equal(out[1].reconciliationid, 'RC-1002');

    // 字段完整 + 真实表头键名（全小写 reconciliationid / merchantid / orderid / amount / currency / TradeType / Billdate）
    assert.deepEqual(out[0], row1, '第 1 行整行字段完整还原');
    assert.deepEqual(out[1], row2, '第 2 行整行字段完整还原');
    assert.equal(out[0].TradeType, 'AchReturn');
    assert.equal(out[1].TradeType, 'FundTransfer-out');
    assert.equal(out[0].Billdate, '2026-03-10');
    assert.equal(out[1].merchantid, 'M002');
  });

  test('损坏行（非法 JSON）被跳过，仅返回好行（不抛错）', () => {
    const good1 = gatewayRow({
      reconId: 'RC-2001', tradeType: 'WireReturn', billDate: '2026-03-12',
      merchantId: 'M201', currency: 'USD', amount: '10', orderId: 'ORD-201'
    });
    const good2 = gatewayRow({
      reconId: 'RC-2002', tradeType: 'Inbound-VA', billDate: '2026-03-13',
      merchantId: 'M202', currency: 'CNY', amount: '20', orderId: 'ORD-202'
    });
    insertGatewayRaw(JSON.stringify(good1), { reconId: 'RC-2001' });
    insertGatewayRaw('{坏json', { reconId: 'RC-BAD' });            // 损坏行夹在中间
    insertGatewayRaw(JSON.stringify(good2), { reconId: 'RC-2002' });

    let out;
    assert.doesNotThrow(() => { out = linkedRepo.readLinkedTableRows(db, 'gateway-bill'); }, '损坏行不抛错');
    assert.equal(out.length, 2, '仅 2 行好数据，损坏行被跳过');
    assert.deepEqual(out.map((r) => r.reconciliationid), ['RC-2001', 'RC-2002'], '顺序仍 id ASC，跳过中间损坏行');
  });

  test('raw_json 解析结果非对象（如 JSON 字面量数字 / null）也被跳过', () => {
    const good = gatewayRow({
      reconId: 'RC-3001', tradeType: 'AchReturn', billDate: '2026-03-14',
      merchantId: 'M301', currency: 'USD', amount: '1', orderId: 'ORD-301'
    });
    insertGatewayRaw('123', {});       // 合法 JSON 但是数字 → typeof !== 'object'，跳过
    insertGatewayRaw('null', {});      // 合法 JSON null → o 为假，跳过
    insertGatewayRaw(JSON.stringify(good), { reconId: 'RC-3001' });

    const out = linkedRepo.readLinkedTableRows(db, 'gateway-bill');
    assert.equal(out.length, 1, '仅 1 行对象，数字/null 行被跳过');
    assert.equal(out[0].reconciliationid, 'RC-3001');
  });

  test('空表 → 返回空数组', () => {
    assert.deepEqual(linkedRepo.readLinkedTableRows(db, 'gateway-bill'), []);
  });

  test('fx-option（模板缺失 supported=false）→ 返回 []（不查表）', () => {
    assert.deepEqual(linkedRepo.readLinkedTableRows(db, 'fx-option'), []);
  });

  test('未知 tableKey → 抛错（getDef 校验）', () => {
    assert.throws(() => linkedRepo.readLinkedTableRows(db, 'not-a-table'), /未知 tableKey/);
  });

  test('facade database.readLinkedTableRows 等价于仓储函数', () => {
    const row = gatewayRow({
      reconId: 'RC-4001', tradeType: 'HX_OUTBOUND', billDate: '2026-03-15',
      merchantId: 'M401', currency: 'HKD', amount: '99', orderId: 'ORD-401'
    });
    insertGatewayRaw(JSON.stringify(row), { reconId: 'RC-4001' });

    const viaFacade = appDb.readLinkedTableRows('gateway-bill');
    const viaRepo = linkedRepo.readLinkedTableRows(db, 'gateway-bill');
    assert.deepEqual(viaFacade, viaRepo);
    assert.equal(viaFacade.length, 1);
    assert.equal(viaFacade[0].reconciliationid, 'RC-4001');
    // facade 路径上 fx-option 也返回 []
    assert.deepEqual(appDb.readLinkedTableRows('fx-option'), []);
  });
});
