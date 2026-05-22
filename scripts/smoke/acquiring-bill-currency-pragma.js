// v2.1.7 F7 — 收单单据币种校验 SQL 调优 + 完成系统通知 smoke
//   F7-A1：全局 PRAGMA 应用断言（spec §7.6.1）
//   F7-A2：source_file 索引存在 + ANALYZE 已跑（spec §7.6.2）
//   F7-B1：notifyAcquiringBillCurrencyResult 通知函数桩测试（spec §7.6.3）
//
// 不依赖 Electron 运行；F7-B1 通过 mock Notification 验证文案 + 截断 + isSupported=false 兜底

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { AppDatabase } = require('../../src/backend/database');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    passed += 1;
  } catch (_e) {
    failed += 1;
    failures.push({ label, actual, expected });
  }
}

function assertTrue(cond, label) {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push({ label, actual: false, expected: true });
  }
}

function setupTmpDb() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'abc-pragma-'));
  const appDb = new AppDatabase(path.join(tmpdir, 't.sqlite'));
  appDb.init();
  const cleanup = () => {
    try { appDb.db.close(); } catch (_e) { /* swallow */ }
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  };
  return { tmpdir, appDb, cleanup };
}

// =====================================================================
// F7-A1：PRAGMA 应用断言（spec §7.6.1）
//   启动后查询 journal_mode / synchronous / cache_size / mmap_size
// =====================================================================
function caseF7A1_pragmaApplied() {
  const { appDb, cleanup } = setupTmpDb();
  try {
    const db = appDb.db;
    const journalMode = db.prepare('PRAGMA journal_mode;').get();
    const synchronous = db.prepare('PRAGMA synchronous;').get();
    const cacheSize = db.prepare('PRAGMA cache_size;').get();
    const mmapSize = db.prepare('PRAGMA mmap_size;').get();

    // node:sqlite PRAGMA return shape: { journal_mode: 'wal' } / { synchronous: 1 } 等
    assertEq(String(journalMode.journal_mode).toLowerCase(), 'wal', 'F7-A1 journal_mode = wal');
    assertEq(Number(synchronous.synchronous), 1, 'F7-A1 synchronous = NORMAL (1)');
    assertEq(Number(cacheSize.cache_size), -65536, 'F7-A1 cache_size = -65536 (64MB)');
    assertEq(Number(mmapSize.mmap_size), 268435456, 'F7-A1 mmap_size = 268435456 (256MB)');

    // foreign_keys 仍 ON（旧 PRAGMA 不丢）
    const foreignKeys = db.prepare('PRAGMA foreign_keys;').get();
    assertEq(Number(foreignKeys.foreign_keys), 1, 'F7-A1 foreign_keys 保留 ON');
  } finally {
    cleanup();
  }
}

// =====================================================================
// F7-A1 旁路文件：WAL 模式下应产生 *.sqlite-wal / *.sqlite-shm
//   触发一次写事务后落盘
// =====================================================================
function caseF7A1_walSideFiles() {
  const { tmpdir, appDb, cleanup } = setupTmpDb();
  try {
    const db = appDb.db;
    // 触发一次写事务（任意小表 insert）→ WAL 文件应出现
    const ts = new Date().toISOString();
    db.prepare(`INSERT INTO acquiring_bill_currency_bill_imports
      (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('2026-05', 's.xlsx', 1, 'M1', 'USD', 'USD', '{}', ts);

    const walPath = path.join(tmpdir, 't.sqlite-wal');
    const shmPath = path.join(tmpdir, 't.sqlite-shm');
    assertTrue(fs.existsSync(walPath), 'F7-A1 WAL 旁文件 tool-data.sqlite-wal 存在');
    assertTrue(fs.existsSync(shmPath), 'F7-A1 WAL 旁文件 tool-data.sqlite-shm 存在');
  } finally {
    cleanup();
  }
}

// =====================================================================
// F7-A2：source_file 索引存在 + ANALYZE 已跑（spec §7.6.2）
// =====================================================================
function caseF7A2_indexAndAnalyze() {
  const { appDb, cleanup } = setupTmpDb();
  try {
    const db = appDb.db;
    // 索引存在
    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='index'
        AND name='idx_acquiring_bill_currency_bill_source_file'
    `).all();
    assertEq(indexes.length, 1, 'F7-A2 idx_acquiring_bill_currency_bill_source_file 存在');

    // ANALYZE 已跑 → sqlite_stat1 含行
    const stat1 = db.prepare("SELECT COUNT(*) AS c FROM sqlite_stat1").get();
    assertTrue(stat1.c > 0, 'F7-A2 sqlite_stat1 含行（ANALYZE 已跑）');
  } finally {
    cleanup();
  }
}

// =====================================================================
// F7-A2 EXPLAIN QUERY PLAN：listAllDiffRowsByRun / listSourceFilesByRun 命中新索引
// =====================================================================
function caseF7A2_explainQueryPlan() {
  const { appDb, cleanup } = setupTmpDb();
  try {
    const db = appDb.db;
    // 注入 bill 行（让 stat 反映索引选择性）+ ANALYZE
    const ts = new Date().toISOString();
    for (let i = 1; i <= 20; i++) {
      db.prepare(`INSERT INTO acquiring_bill_currency_bill_imports
        (month_key, source_file, source_row_index, recon_main_id, settle_currency, settle_currency_norm, raw_json, imported_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('2026-05', `bill-${(i % 3) + 1}.xlsx`, i, `M${i}`, 'USD', 'USD', '{}', ts);
    }
    db.exec('ANALYZE;');

    // listAllDiffRowsByRun ORDER BY source_file ASC → 必命中 source_file 索引
    const plan1 = db.prepare(`EXPLAIN QUERY PLAN
      SELECT b.raw_json, b.source_file
      FROM acquiring_bill_currency_bill_imports b
      ORDER BY b.source_file ASC, b.source_row_index ASC`).all();
    const plan1Text = plan1.map(p => p.detail).join(' | ');
    assertTrue(/idx_acquiring_bill_currency_bill_source_file/.test(plan1Text),
      `F7-A2 ORDER BY source_file 命中新索引 (plan: ${plan1Text})`);

    // listSourceFilesByRun SELECT DISTINCT source_file → 必命中
    const plan2 = db.prepare(`EXPLAIN QUERY PLAN
      SELECT DISTINCT source_file FROM acquiring_bill_currency_bill_imports
      WHERE month_key = ? ORDER BY source_file ASC`).all('2026-05');
    const plan2Text = plan2.map(p => p.detail).join(' | ');
    assertTrue(/idx_acquiring_bill_currency_bill_source_file/.test(plan2Text),
      `F7-A2 SELECT DISTINCT source_file 命中新索引 (plan: ${plan2Text})`);
  } finally {
    cleanup();
  }
}

// =====================================================================
// F7-B1：Notification 调用桩测试（spec §7.6.3）
//   不依赖 Electron — 把 notify helper 的等价实现内联（spec 已锁定行为）
//   通过 mock Notification 验证：
//   1. success 文案 title='「收单单据币种校验」' body='2026-05 对账完成（共 42 行差异）'
//   2. error 文案 body 长度 ≤ 200（macOS 截断）
//   3. isSupported() = false 时 no-op 不抛错
// =====================================================================
function caseF7B1_notificationStub() {
  // 与 main.js notifyAcquiringBillCurrencyResult 等价的本地实现（spec §7.5.2 锁定行为）
  function makeNotifier(NotificationCtor) {
    return function notify(monthKey, kind, payload) {
      try {
        if (!NotificationCtor || typeof NotificationCtor.isSupported !== 'function' || !NotificationCtor.isSupported()) return;
        const title = '「收单单据币种校验」';
        let body;
        if (kind === 'success') {
          const mismatch = (payload && typeof payload.mismatchRows === 'number') ? payload.mismatchRows : 0;
          body = `${monthKey} 对账完成（共 ${mismatch} 行差异）`;
        } else {
          const msg = (payload && payload.message) ? String(payload.message) : '未知错误';
          body = `对账失败：${msg}`.slice(0, 200);
        }
        new NotificationCtor({ title, body }).show();
      } catch (_e) { /* swallow */ }
    };
  }

  // case 1: success 文案
  {
    const calls = [];
    const MockNotification = function (opts) {
      calls.push(opts);
      this.show = () => {};
    };
    MockNotification.isSupported = () => true;
    const notify = makeNotifier(MockNotification);
    notify('2026-05', 'success', { mismatchRows: 42 });
    assertEq(calls.length, 1, 'F7-B1-1 success 触发 Notification 1 次');
    assertEq(calls[0].title, '「收单单据币种校验」', 'F7-B1-1 title 含模块前缀');
    assertEq(calls[0].body, '2026-05 对账完成（共 42 行差异）', 'F7-B1-1 body 完整文案');
  }
  // case 2: success 但 mismatchRows 缺失 → 默认 0
  {
    const calls = [];
    const MockNotification = function (opts) { calls.push(opts); this.show = () => {}; };
    MockNotification.isSupported = () => true;
    makeNotifier(MockNotification)('2026-05', 'success', {});
    assertEq(calls[0].body, '2026-05 对账完成（共 0 行差异）', 'F7-B1-2 mismatchRows 缺失 fallback 0');
  }
  // case 3: error 文案 + body 截断 ≤ 200
  {
    const calls = [];
    const MockNotification = function (opts) { calls.push(opts); this.show = () => {}; };
    MockNotification.isSupported = () => true;
    const longMsg = 'X'.repeat(300);
    makeNotifier(MockNotification)('2026-05', 'error', { message: longMsg });
    assertEq(calls.length, 1, 'F7-B1-3 error 触发 Notification 1 次');
    assertEq(calls[0].title, '「收单单据币种校验」', 'F7-B1-3 error title 同 success');
    assertTrue(calls[0].body.length <= 200, `F7-B1-3 body 长度 ≤ 200（实际 ${calls[0].body.length}）`);
    assertTrue(calls[0].body.startsWith('对账失败：XXX'), 'F7-B1-3 body 以"对账失败："开头');
  }
  // case 4: error 但 message 缺失 → 默认"未知错误"
  {
    const calls = [];
    const MockNotification = function (opts) { calls.push(opts); this.show = () => {}; };
    MockNotification.isSupported = () => true;
    makeNotifier(MockNotification)('2026-05', 'error', null);
    assertEq(calls[0].body, '对账失败：未知错误', 'F7-B1-4 message 缺失 fallback "未知错误"');
  }
  // case 5: isSupported=false → no-op 不抛错 + 不调 ctor
  {
    const calls = [];
    const MockNotification = function (opts) { calls.push(opts); this.show = () => {}; };
    MockNotification.isSupported = () => false;
    let threw = false;
    try {
      makeNotifier(MockNotification)('2026-05', 'success', { mismatchRows: 5 });
    } catch (_e) { threw = true; }
    assertEq(threw, false, 'F7-B1-5 isSupported=false 不抛错');
    assertEq(calls.length, 0, 'F7-B1-5 isSupported=false 不调 Notification ctor');
  }
  // case 6: Notification 为 null/undefined → no-op 不抛错
  {
    let threw = false;
    try {
      makeNotifier(null)('2026-05', 'success', { mismatchRows: 1 });
      makeNotifier(undefined)('2026-05', 'error', { message: 'x' });
    } catch (_e) { threw = true; }
    assertEq(threw, false, 'F7-B1-6 Notification=null/undefined 不抛错（极端环境兜底）');
  }
  // case 7: 验证 main.js 含 notifyAcquiringBillCurrencyResult 名 + Notification destructure
  //   防 wiring 漏改：grep 源码字符串
  {
    const mainSource = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf-8');
    assertTrue(/function notifyAcquiringBillCurrencyResult\(monthKey, kind, payload\)/.test(mainSource),
      'F7-B1-7 main.js 定义 notifyAcquiringBillCurrencyResult');
    // destructure 形式：const { ..., Notification } = require('electron');
    //   Notification 在 destructure 大括号内，require('electron') 在右侧
    assertTrue(/const \{[^}]*\bNotification\b[^}]*\} = require\('electron'\)/.test(mainSource),
      'F7-B1-7 main.js electron destructure 含 Notification');
    // 触发点：success + error 两处调用
    const successCallCount = (mainSource.match(/notifyAcquiringBillCurrencyResult\(monthKey, 'success'/g) || []).length;
    const errorCallCount = (mainSource.match(/notifyAcquiringBillCurrencyResult\(monthKey, 'error'/g) || []).length;
    assertEq(successCallCount, 1, 'F7-B1-7 main.js success 触发点 = 1 处');
    assertEq(errorCallCount, 1, 'F7-B1-7 main.js error 触发点 = 1 处');
  }
}

function runAcquiringBillCurrencyPragmaSmokeTests() {
  caseF7A1_pragmaApplied();
  caseF7A1_walSideFiles();
  caseF7A2_indexAndAnalyze();
  caseF7A2_explainQueryPlan();
  caseF7B1_notificationStub();

  const total = passed + failed;
  if (failed === 0) {
    console.log(`[acquiring-bill-currency-pragma] ${passed}/${total} smoke tests passed`);
  } else {
    console.error(`[acquiring-bill-currency-pragma] ${passed}/${total} smoke tests passed, ${failed} failed:`);
    failures.forEach((f) => {
      console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`);
    });
    throw new Error('acquiring-bill-currency-pragma smoke test failed');
  }
}

module.exports = { runAcquiringBillCurrencyPragmaSmokeTests };
