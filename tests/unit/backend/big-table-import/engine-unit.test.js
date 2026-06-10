'use strict';
// 大表导入引擎 engine 单元测试（v3.0.3 块 D · PR-G2）🔴🔴 资金红线（整批拒绝 / 跨月 / 覆盖 / 契约可选字段）
//
// 覆盖：
//   - 错误累积整批拒绝：含坏行文件 → ROLLBACK 后表空 + 错误列表上限语义
//   - contract 可选字段（deleteSqlForOverwrite）校验：overwrite 缺声明 → ContractValidationError 拒绝启动
//   - validateContract 先行（漏配必需列拒绝启动；本 PR 复用 PR-G1 contract.test 已锁，这里测 engine 入口拒绝）
//   - PRAGMA 第 5 处契约：openDbWithPragma verify
//
// 全程真实 worker 拓扑（engine.importFiles 调 pipeline 起解析子 worker），不 mock。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const engine = require('../../../../src/backend/big-table-import/engine');
const fx = require('./_fixtures');

// 临时目录（DB + 契约模块 + xlsx）。
function mkDir() { return fx.mkTmpDir('btie-engine-'); }

// 建 t 表的临时 DB。
function mkDb(dir) {
  const dbPath = path.join(dir, 'test.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, d TEXT, k TEXT NOT NULL, a TEXT, UNIQUE(k));');
  db.close();
  return dbPath;
}

// 写测试契约模块（可被 worker require + engine 主侧 require）。
//   withOverwrite=true 时声明 deleteSqlForOverwrite + deleteParamsFromMonthKey。
function writeContract(dir, { withOverwrite = false } = {}) {
  const p = path.join(dir, `contract-${withOverwrite ? 'ow' : 'plain'}.js`);
  fs.writeFileSync(p, `'use strict';
module.exports = {
  expectedHeaders: ['日期', '主键', '金额'],
  valueColumnWhitelist: null,
  validateHeaders(cells) {
    const ok = cells[0] === '日期' && cells[1] === '主键' && cells[2] === '金额';
    return ok ? { ok: true } : { ok: false, error: '表头不匹配', detailLines: ['实际: ' + cells.join(',')] };
  },
  mapRow({ values }) {
    const key = String(values[1] || '').trim();
    if (!key) return { error: { reason: '主键为空' } };
    return { params: [values[0], key, values[2]] };
  },
  insertSql: 'INSERT INTO t (d, k, a) VALUES (?, ?, ?)',
  requiredColumns: [0, 1, 2],
  monthKeyOf({ values }) {
    const m = String(values[0] || '').match(/^(\\d{4})[-/](\\d{1,2})/);
    return m ? m[1] + '-' + String(m[2]).padStart(2, '0') : null;
  }${withOverwrite ? `,
  deleteSqlForOverwrite: 'DELETE FROM t WHERE d LIKE ?',
  deleteParamsFromMonthKey(mk) { return [mk + '%']; }` : ''}
};
`, 'utf8');
  return p;
}

function countRows(dbPath) {
  const db = new DatabaseSync(dbPath);
  const n = db.prepare('SELECT COUNT(*) AS c FROM t').get().c;
  db.close();
  return n;
}

test.describe('engine 整批拒绝 / 错误累积', () => {
  test.after(() => fx.cleanupTmpDirs());

  test('含坏行文件（主键空）→ ROLLBACK 后表空，BigTableImportError 含错误明细', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const contractModulePath = writeContract(dir);
    // 文件含 1 个坏行（主键空）+ 2 个好行 → 整批拒绝（资金红线：任一行错不入任何行）。
    const files = [await fx.writeFixtureExcelJS({
      rows: [
        ['日期', '主键', '金额'],
        ['2026-03-01', 'K1', '10'],
        ['2026-03-02', '', '20'],     // 坏行：主键空
        ['2026-03-03', 'K3', '30']
      ]
    })];

    let err = null;
    try {
      await engine.importFiles({ dbPath, files, contractModulePath, contractOptions: {}, monthKey: '2026-03' });
    } catch (e) { err = e; }

    assert.ok(err, '含坏行应抛错');
    assert.equal(err.name, 'BigTableImportError', '错误类型 BigTableImportError');
    assert.match(err.message, /整批未导入/, 'message 含整批未导入');
    assert.ok(Array.isArray(err.detailLines) && err.detailLines.some((l) => /主键为空/.test(l)), 'detailLines 含坏行原因');
    assert.equal(countRows(dbPath), 0, '🔴 ROLLBACK 后表空（不入任何行）');
  });

  test('单文件错误达上限 100 → worker 早退（明细 ≤ 100 + 整批拒绝表空）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const contractModulePath = writeContract(dir);
    // 造 150 个坏行（主键空）。worker 内 MAX_COLLECTED_ERRORS=100 达上限即 __stopParsing 早退
    //   （与收单 reader-handrolled 早退语义一致）→ rowErrorTotal 停在 100，明细 100 条。
    const rows = [['日期', '主键', '金额']];
    for (let i = 0; i < 150; i++) rows.push(['2026-03-01', '', '10']);
    const files = [await fx.writeFixtureExcelJS({ rows })];

    let err = null;
    try {
      await engine.importFiles({ dbPath, files, contractModulePath, contractOptions: {}, monthKey: '2026-03' });
    } catch (e) { err = e; }

    assert.ok(err && err.name === 'BigTableImportError');
    const detailErrLines = err.detailLines.filter((l) => /第 \d+ 行/.test(l));
    assert.ok(detailErrLines.length <= 100, `错误明细行 ≤ 100（实际 ${detailErrLines.length}）`);
    assert.equal(countRows(dbPath), 0, '整批拒绝表空');
  });

  test('多文件累计错误超上限 100 → engine 跨文件截断 + 标注总数', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const contractModulePath = writeContract(dir);
    // 2 文件各 80 坏行（单文件 80 < 100 不触发 worker 早退）→ engine 跨文件累计 160 → collectedErrors 截 100。
    const mkBad = (n) => {
      const rows = [['日期', '主键', '金额']];
      for (let i = 0; i < n; i++) rows.push(['2026-03-01', '', '10']);
      return rows;
    };
    const files = [
      await fx.writeFixtureExcelJS({ rows: mkBad(80) }),
      await fx.writeFixtureExcelJS({ rows: mkBad(80) })
    ];

    let err = null;
    try {
      await engine.importFiles({ dbPath, files, contractModulePath, contractOptions: {}, monthKey: '2026-03' });
    } catch (e) { err = e; }

    assert.ok(err && err.name === 'BigTableImportError');
    const detailErrLines = err.detailLines.filter((l) => /第 \d+ 行/.test(l));
    assert.ok(detailErrLines.length <= 100, `跨文件错误明细行截到 ≤ 100（实际 ${detailErrLines.length}）`);
    assert.ok(err.detailLines.some((l) => /共 \d+ 条错误/.test(l)), 'detailLines 含「共 N 条错误」截断说明（跨文件累计 160 > 100）');
    assert.equal(countRows(dbPath), 0, '整批拒绝表空');
  });

  test('跨月行 → 整批拒绝（monthKey 校验）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const contractModulePath = writeContract(dir);
    const files = [await fx.writeFixtureExcelJS({
      rows: [
        ['日期', '主键', '金额'],
        ['2026-03-01', 'K1', '10'],
        ['2026-04-01', 'K2', '20']    // 跨月（期望 2026-03）
      ]
    })];

    let err = null;
    try {
      await engine.importFiles({ dbPath, files, contractModulePath, contractOptions: {}, monthKey: '2026-03' });
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'BigTableImportError', '跨月应抛错');
    assert.ok(err.detailLines.some((l) => /跨月份混杂/.test(l)), 'detailLines 含跨月混杂');
    assert.equal(countRows(dbPath), 0, '跨月整批拒绝表空');
  });
});

test.describe('engine 契约可选字段 deleteSqlForOverwrite 校验', () => {
  test.after(() => fx.cleanupTmpDirs());

  test("mode='overwrite' 但契约未声明 deleteSqlForOverwrite → ContractValidationError 拒绝启动", async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const contractModulePath = writeContract(dir, { withOverwrite: false });   // 无 deleteSqlForOverwrite
    const files = [await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '10']] })];

    let err = null;
    try {
      await engine.importFiles({ dbPath, files, contractModulePath, contractOptions: {}, mode: 'overwrite', monthKey: '2026-03' });
    } catch (e) { err = e; }
    assert.ok(err, "overwrite 缺 deleteSqlForOverwrite 应拒绝启动");
    assert.equal(err.name, 'ContractValidationError', '错误类型 ContractValidationError（拒绝启动级）');
    assert.match(err.message, /deleteSqlForOverwrite/, 'message 指明缺字段');
  });

  test("mode='append' 不要求 deleteSqlForOverwrite（可选字段缺省合法）", async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const contractModulePath = writeContract(dir, { withOverwrite: false });
    const files = [await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '10']] })];
    const res = await engine.importFiles({ dbPath, files, contractModulePath, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    assert.equal(res.totalImported, 1, 'append 模式无 deleteSqlForOverwrite 正常导入');
    assert.equal(countRows(dbPath), 1);
  });

  test("mode='overwrite' 声明 deleteSqlForOverwrite → 先 DELETE 旧月再导", async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const contractModulePath = writeContract(dir, { withOverwrite: true });

    // 先 append 2 行（旧数据）。
    const f1 = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'OLD1', '10'], ['2026-03-02', 'OLD2', '20']] });
    await engine.importFiles({ dbPath, files: [f1], contractModulePath, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    assert.equal(countRows(dbPath), 2, '旧数据 2 行');

    // overwrite 重导 1 行新数据 → 先删 2026-03 旧行再导。
    const f2 = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-05', 'NEW1', '99']] });
    const res = await engine.importFiles({ dbPath, files: [f2], contractModulePath, contractOptions: {}, mode: 'overwrite', monthKey: '2026-03' });
    assert.equal(res.deletedCount, 2, '删除旧 2 行');
    assert.equal(res.totalImported, 1, '导入新 1 行');
    const db = new DatabaseSync(dbPath);
    const ks = db.prepare('SELECT k FROM t ORDER BY id ASC').all().map((r) => r.k);
    db.close();
    assert.deepEqual(ks, ['NEW1'], '🔴 行集正确替换（旧 OLD1/OLD2 删除，仅留 NEW1）');
  });
});

test.describe('engine PRAGMA 第 5 处契约 verify', () => {
  test.after(() => fx.cleanupTmpDirs());

  test('openDbWithPragma 设置清单 + verify 通过（journal_mode/synchronous/cache_size/mmap_size/temp_store）', () => {
    const dir = mkDir();
    const dbPath = path.join(dir, 'pragma.sqlite');
    new DatabaseSync(dbPath).close();   // 建空库
    const db = engine.openDbWithPragma(dbPath);
    try {
      const read = (name) => {
        const row = db.prepare(`PRAGMA ${name}`).get();
        return row[Object.keys(row)[0]];
      };
      assert.equal(String(read('journal_mode')).toLowerCase(), 'wal', 'journal_mode=wal');
      assert.equal(Number(read('synchronous')), 1, 'synchronous=NORMAL(1)');
      assert.equal(Number(read('cache_size')), -65536, 'cache_size=-65536');
      assert.equal(Number(read('mmap_size')), 268435456, 'mmap_size=268435456');
      assert.equal(Number(read('temp_store')), 2, 'temp_store=MEMORY(2)');
      assert.equal(Number(read('busy_timeout')), 30000, 'busy_timeout=30000');
      // 与导出的 PRAGMA_EXPECTED 一致
      assert.equal(engine.PRAGMA_EXPECTED.temp_store, 2, 'PRAGMA_EXPECTED.temp_store=2');
    } finally {
      db.close();
    }
  });
});
