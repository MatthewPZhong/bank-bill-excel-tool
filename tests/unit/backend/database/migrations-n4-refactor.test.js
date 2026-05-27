// v2.1.9 N4 重构 (T32e-f, D22=a)：ensureBillRawJsonV2Slim 切换到 createBackupFn
//   spec.md §14.1 / tasks.md T32e
//
// 测试覆盖：
//   1. createBackupFn 缺失（v2.1.8 老调用方兼容） → 跳过备份分支，标志位仍写
//   2. createBackupFn 正常 → 被调用 + 返回 backupPath 被传递
//   3. createBackupFn 抛错 → status='backup-failed' + 标志位不写
//   4. 标志位 / raw_json 9 字段裁剪逻辑不变（与 v2.1.8 N4 行为一致）

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DatabaseSync } = require('node:sqlite');
const { ensureBillRawJsonV2Slim } = require('../../../../src/backend/database/migrations');
const { TEMPLATE_BILL_HEADERS } = require('../../../../src/backend/acquiring-bill-currency-db/columns');

function setupTempDbWithBill() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'n4-refactor-test-'));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS acquiring_bill_currency_bill_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month_key TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_row_index INTEGER NOT NULL,
      recon_main_id TEXT NOT NULL,
      settle_currency TEXT,
      settle_currency_norm TEXT,
      raw_json TEXT NOT NULL,
      imported_at TEXT NOT NULL
    );
  `);
  // 插一行带 26+ 字段的旧 raw_json（含模版 9 字段 + 17 非模版字段）
  const fullObj = {
    // 9 模版字段
    '账单日期': '2026-05-01',
    'originBillBizId': 'O1',
    '单据类型': 'BILL',
    '主对账Id': 'M1',
    '业务订单号': 'ORDER1',
    '对账金额': '100',
    '对账币种': 'USD',
    'valueDate': '2026-05-02',
    'channel': 'CH1',
    // 17 非模版字段
    'ReconBillBizId': 'R1', '公司主体': 'CA', '业务部门': 'D1', '对手部门': 'D2',
    '订单创建来源': 'S1', '财务BU': 'BU1', '账单类型': 'T1', '业务子类型': 'ST1',
    '交易类型': 'TT1', '对账子类型': 'RST1', '单据状态': 'PAID', '用户编号': 'U1',
    '账户号': 'A1', '账户类型': 'AT1', 'remark': 'NOTE', '创建时间': 'TS1', '完成时间': 'TS2',
  };
  db.prepare(`
    INSERT INTO acquiring_bill_currency_bill_imports
    (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
    VALUES ('2026-05', 'fake.xlsx', 1, 'X1', 'USD', 'usd', ?, ?)
  `).run(JSON.stringify(fullObj), new Date().toISOString());

  const cleanup = () => {
    try { db.close(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, dir, dbPath, cleanup };
}

describe('ensureBillRawJsonV2Slim — v2.1.9 N4 重构 (T32e)', () => {
  test('createBackupFn 被调用并传入 "pre-N4" label', () => {
    const ctx = setupTempDbWithBill();
    let callCount = 0;
    let receivedLabel = null;
    const fakeBackupPath = path.join(ctx.dir, 'mock-backup.sqlite');
    fs.writeFileSync(fakeBackupPath, 'mock backup content');
    try {
      const r = ensureBillRawJsonV2Slim(ctx.db, ctx.dbPath, (label) => {
        callCount++;
        receivedLabel = label;
        return fakeBackupPath;
      });
      assert.strictEqual(callCount, 1, 'createBackupFn 应被调用 1 次');
      assert.strictEqual(receivedLabel, 'pre-N4', 'label 应为 "pre-N4"（保持 v2.1.8 备份路径前缀契约）');
      assert.strictEqual(r.status, 'migrated');
      assert.strictEqual(r.backupPath, fakeBackupPath, 'backupPath 应透传 createBackupFn 返回值');
    } finally {
      ctx.cleanup();
    }
  });

  test('createBackupFn 抛错 → status=backup-failed + 标志位不写 + 数据未动', () => {
    const ctx = setupTempDbWithBill();
    try {
      const r = ensureBillRawJsonV2Slim(ctx.db, ctx.dbPath, () => {
        throw new Error('injected backup failure');
      });
      assert.strictEqual(r.status, 'backup-failed');
      assert.ok(typeof r.error === 'string' && r.error.includes('injected backup failure'));
      // 标志位不写
      const marker = ctx.db.prepare(`SELECT setting_value FROM app_settings WHERE setting_key='acquiring_bill_raw_json_v2_migrated'`).get();
      assert.strictEqual(marker, undefined, '失败时标志位不应写入');
      // 数据未动（raw_json 仍 26 字段）
      const row = ctx.db.prepare(`SELECT raw_json FROM acquiring_bill_currency_bill_imports WHERE recon_main_id='X1'`).get();
      const obj = JSON.parse(row.raw_json);
      assert.ok('remark' in obj, '失败时数据未瘦身（remark 仍在）');
      assert.strictEqual(Object.keys(obj).length, 26, '失败时仍 26 字段');
    } finally {
      ctx.cleanup();
    }
  });

  test('createBackupFn 缺失（v2.1.8 老调用方兼容） → 跳过备份分支但 migration 继续', () => {
    const ctx = setupTempDbWithBill();
    try {
      const r = ensureBillRawJsonV2Slim(ctx.db, ctx.dbPath); // 缺第三参
      assert.strictEqual(r.status, 'migrated', '缺 createBackupFn 不应阻塞 migration');
      assert.strictEqual(r.backupPath, null, 'backupPath 应为 null');
      // 数据已瘦身（migration 正常跑）
      const row = ctx.db.prepare(`SELECT raw_json FROM acquiring_bill_currency_bill_imports WHERE recon_main_id='X1'`).get();
      const obj = JSON.parse(row.raw_json);
      assert.strictEqual(Object.keys(obj).length, 9, '已瘦身到 9 字段');
    } finally {
      ctx.cleanup();
    }
  });

  test('migration 数据瘦身到 9 字段（与 v2.1.8 N4 行为一致）', () => {
    const ctx = setupTempDbWithBill();
    const fakeBackupPath = path.join(ctx.dir, 'mock-backup.sqlite');
    fs.writeFileSync(fakeBackupPath, 'x');
    try {
      const r = ensureBillRawJsonV2Slim(ctx.db, ctx.dbPath, () => fakeBackupPath);
      assert.strictEqual(r.status, 'migrated');
      assert.strictEqual(r.rowsAffected, 1);
      const row = ctx.db.prepare(`SELECT raw_json FROM acquiring_bill_currency_bill_imports WHERE recon_main_id='X1'`).get();
      const obj = JSON.parse(row.raw_json);
      const keys = Object.keys(obj).sort();
      assert.deepStrictEqual(keys, TEMPLATE_BILL_HEADERS.slice().sort(),
        '瘦身后字段应严格等于 TEMPLATE_BILL_HEADERS');
    } finally {
      ctx.cleanup();
    }
  });

  test('标志位逻辑：第二次跑 already-migrated', () => {
    const ctx = setupTempDbWithBill();
    const fakeBackupPath = path.join(ctx.dir, 'mock-backup.sqlite');
    fs.writeFileSync(fakeBackupPath, 'x');
    let secondCallCount = 0;
    try {
      const r1 = ensureBillRawJsonV2Slim(ctx.db, ctx.dbPath, () => fakeBackupPath);
      assert.strictEqual(r1.status, 'migrated');
      const r2 = ensureBillRawJsonV2Slim(ctx.db, ctx.dbPath, () => {
        secondCallCount++;
        return fakeBackupPath;
      });
      assert.strictEqual(r2.status, 'already-migrated');
      assert.strictEqual(secondCallCount, 0, '幂等跳过不应调 createBackupFn');
    } finally {
      ctx.cleanup();
    }
  });
});
