'use strict';
// 大表导入引擎 — 契约可选扩展包 E1-E5 单元测试（v3.0.4 PR-B）🔴🔴 资金红线
//
// 🔴 铁律：契约不声明新 hook ⇒ 引擎行为与现状 byte-for-byte 一致（每个扩展均测「声明/不声明」两态，
//   不声明态 = 现有行为回归断言）。
//
// 覆盖：
//   E1 多语句覆盖删除 deleteForOverwrite：声明（多语句多表 changes 累加）/ 不声明（回退单串 deleteSqlForOverwrite）
//   E2 事务内收尾 finalizeForCommit：声明（COMMIT 前事务内执行 + 中途失败整批 ROLLBACK 不残留）/ 不声明（无收尾）
//   E3 空文件整批拒绝 rejectEmptyFiles：声明（仅表头文件 → 整批拒绝 + 文案）/ 不声明（空文件成功 0 行）
//   E4 错误捕获增强 maxCollectedErrors/captureRowValues：声明（覆盖上限 + 错误带 cells）/ 不声明（100 截断 + 无 cells）
//   E5 写侧跨文件去重 dedupeKeyOf：声明（跨文件重复行 → 行级错误整批拒绝 + 文案）/ 不声明（无去重）
//
// 全程真实 worker 拓扑（engine.importFiles 调 pipeline 起解析子 worker），不 mock。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const engine = require('../../../../src/backend/big-table-import/engine');
const fx = require('./_fixtures');

function mkDir() { return fx.mkTmpDir('btie-ext-'); }

// 建 t 表（含 meta 表供 E2 finalize 写月元数据）。
function mkDb(dir) {
  const dbPath = path.join(dir, 'test.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, d TEXT, k TEXT, a TEXT);');
  db.exec('CREATE TABLE t_meta (month_key TEXT PRIMARY KEY, row_count INTEGER, source_files TEXT);');
  db.exec('CREATE TABLE t_aux (id INTEGER PRIMARY KEY AUTOINCREMENT, month_key TEXT);');
  db.close();
  return dbPath;
}

// 写测试契约模块（可被 worker require + engine 主侧 require）。
//   opts 控制各扩展声明与否（不声明 = 字段不出现在导出对象 → 引擎走现状路径）。
function writeContract(dir, opts = {}) {
  const tag = Object.keys(opts).filter((k) => opts[k]).join('_') || 'plain';
  const p = path.join(dir, `contract-${tag}-${Math.random().toString(36).slice(2, 8)}.js`);

  const lines = [];
  lines.push("'use strict';");
  lines.push('module.exports = {');
  lines.push("  expectedHeaders: ['日期', '主键', '金额'],");
  lines.push('  valueColumnWhitelist: null,');
  lines.push('  validateHeaders(cells) {');
  lines.push("    const ok = cells[0] === '日期' && cells[1] === '主键' && cells[2] === '金额';");
  lines.push("    return ok ? { ok: true } : { ok: false, error: '表头不匹配', detailLines: [] };");
  lines.push('  },');
  lines.push('  mapRow({ values }) {');
  lines.push("    const key = String(values[1] || '').trim();");
  lines.push("    if (!key) return { error: { reason: '主键为空' } };");
  lines.push('    return { params: [values[0], key, values[2]] };');
  lines.push('  },');
  lines.push("  insertSql: 'INSERT INTO t (d, k, a) VALUES (?, ?, ?)',");
  lines.push('  requiredColumns: [0, 1, 2],');
  lines.push('  monthKeyOf({ values }) {');
  lines.push("    const m = String(values[0] || '').match(/^(\\d{4})[-/](\\d{1,2})/);");
  lines.push("    return m ? m[1] + '-' + String(m[2]).padStart(2, '0') : null;");
  lines.push('  }');

  // E1 单串覆盖删除（不声明 deleteForOverwrite 时的回退路径基线）。
  if (opts.singleDelete) {
    lines[lines.length - 1] += ',';
    lines.push("  deleteSqlForOverwrite: 'DELETE FROM t WHERE d LIKE ?',");
    lines.push('  deleteParamsFromMonthKey(mk) { return [mk + \"%\"]; }');
  }
  // E1 多语句覆盖删除：删 t（按月）+ t_aux（按月）两条，顺序敏感。
  if (opts.multiDelete) {
    lines[lines.length - 1] += ',';
    lines.push('  deleteForOverwrite(mk) {');
    lines.push('    return [');
    lines.push("      { sql: 'DELETE FROM t_aux WHERE month_key = ?', params: [mk] },");
    lines.push("      { sql: 'DELETE FROM t WHERE d LIKE ?', params: [mk + \"%\"] }");
    lines.push('    ];');
    lines.push('  }');
  }
  // E2 事务内收尾：写 t_meta 月元数据（与行 INSERT 同事务）。
  if (opts.finalize) {
    lines[lines.length - 1] += ',';
    lines.push('  finalizeForCommit({ totalImported, sourceFiles }) {');
    lines.push('    return [');
    lines.push("      { sql: 'INSERT OR REPLACE INTO t_meta (month_key, row_count, source_files) VALUES (?, ?, ?)',");
    lines.push("        params: ['2026-03', totalImported, sourceFiles.join(',')] }");
    lines.push('    ];');
    lines.push('  }');
  }
  // E2 故障注入：finalize 返回非法 SQL（验证中途失败整批 ROLLBACK 不残留）。
  if (opts.finalizeBad) {
    lines[lines.length - 1] += ',';
    lines.push('  finalizeForCommit() {');
    lines.push("    return [{ sql: 'INSERT INTO no_such_table (x) VALUES (?)', params: [1] }];");
    lines.push('  }');
  }
  // E3 空文件整批拒绝。
  if (opts.rejectEmpty) {
    lines[lines.length - 1] += ',';
    lines.push('  rejectEmptyFiles: true,');
    lines.push("  formatEmptyFileError(sourceFile) { return sourceFile + '：文件为空或只有表头行'; }");
  }
  // F1（PR #71 SR）批级空数据整批拒绝（写循环结束 totalImported===0 → 批级错误，区别于 E3 per-file）。
  if (opts.rejectEmptyBatch) {
    lines[lines.length - 1] += ',';
    lines.push('  rejectEmptyBatch: true,');
    lines.push("  formatEmptyBatchError() { return '文件无有效数据行'; }");
  }
  // E4 错误上限覆盖 + 捕获 cells。
  if (opts.maxErrors) {
    lines[lines.length - 1] += ',';
    lines.push(`  maxCollectedErrors: ${opts.maxErrors}`);
  }
  if (opts.captureRowValues) {
    lines[lines.length - 1] += ',';
    lines.push('  captureRowValues: true');
  }
  // E5 写侧去重：key = 整行拼接。
  if (opts.dedupe) {
    lines[lines.length - 1] += ',';
    lines.push("  dedupeKeyOf({ values }) { return [values[0], values[1], values[2]].join('|'); },");
    lines.push("  formatDuplicateError({ key }) { return '发现重复行（key ' + key + '）'; }");
  }
  // E5 cells 缺口补丁：cellsOf 从 params 逆推 cells（写侧去重/INSERT 错误带 cells）。
  //   本测试契约 mapRow 的 params = [values[0], values[1], values[2]]（即 d/k/a 三列），cellsOf 直接返回 params。
  if (opts.cellsOf) {
    lines[lines.length - 1] += ',';
    lines.push('  cellsOf({ params }) { return Array.isArray(params) ? params.slice() : []; }');
  }

  lines.push('};');
  fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return p;
}

function queryAll(dbPath, sql) {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare(sql).all();
  db.close();
  return rows;
}
function countRows(dbPath, table = 't') {
  return queryAll(dbPath, `SELECT COUNT(*) AS c FROM ${table}`)[0].c;
}

// ───────────────────────────── E1 多语句覆盖删除 ─────────────────────────────
test.describe('E1 多语句覆盖删除 deleteForOverwrite', () => {
  test.after(() => fx.cleanupTmpDirs());

  test('声明 deleteForOverwrite（多语句多表）→ 按顺序逐条删除，deletedCount=各语句 changes 之和', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, { multiDelete: true });

    // 预置：t 2 行 + t_aux 3 行（均 2026-03）。
    const db = new DatabaseSync(dbPath);
    db.exec("INSERT INTO t (d, k, a) VALUES ('2026-03-01','OLD1','1'),('2026-03-02','OLD2','2')");
    db.exec("INSERT INTO t_aux (month_key) VALUES ('2026-03'),('2026-03'),('2026-03')");
    db.close();

    const f = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-05', 'NEW1', '9']] });
    const res = await engine.importFiles({ dbPath, files: [f], contractModulePath: cm, contractOptions: {}, mode: 'overwrite', monthKey: '2026-03' });

    assert.equal(res.deletedCount, 5, '🔴 deletedCount = t(2) + t_aux(3) 各语句 changes 之和');
    assert.equal(countRows(dbPath, 't_aux'), 0, 't_aux 旧月行已删');
    const ks = queryAll(dbPath, 'SELECT k FROM t ORDER BY id').map((r) => r.k);
    assert.deepEqual(ks, ['NEW1'], '🔴 t 旧行删除仅留新行');
  });

  test('不声明 deleteForOverwrite（回退单串 deleteSqlForOverwrite）→ 行为不变（现状回归）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, { singleDelete: true });

    const f1 = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'OLD1', '1'], ['2026-03-02', 'OLD2', '2']] });
    await engine.importFiles({ dbPath, files: [f1], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    assert.equal(countRows(dbPath), 2);

    const f2 = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-05', 'NEW1', '9']] });
    const res = await engine.importFiles({ dbPath, files: [f2], contractModulePath: cm, contractOptions: {}, mode: 'overwrite', monthKey: '2026-03' });
    assert.equal(res.deletedCount, 2, '单串路径 deletedCount=2（现状语义）');
    const ks = queryAll(dbPath, 'SELECT k FROM t ORDER BY id').map((r) => r.k);
    assert.deepEqual(ks, ['NEW1']);
  });

  test("overwrite 两种删除声明皆缺 → ContractValidationError 拒绝启动", async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, {});   // 既无 deleteForOverwrite 也无 deleteSqlForOverwrite
    const f = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '1']] });
    let err = null;
    try {
      await engine.importFiles({ dbPath, files: [f], contractModulePath: cm, contractOptions: {}, mode: 'overwrite', monthKey: '2026-03' });
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'ContractValidationError', '拒绝启动');
    assert.match(err.message, /deleteForOverwrite|deleteSqlForOverwrite/);
  });
});

// ───────────────────────────── E2 事务内收尾 ─────────────────────────────
test.describe('E2 事务内收尾 finalizeForCommit', () => {
  test.after(() => fx.cleanupTmpDirs());

  test('声明 finalizeForCommit → COMMIT 前事务内执行，月元数据落库（rowCount/sourceFiles）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, { finalize: true });
    const f = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '1'], ['2026-03-02', 'K2', '2']] });
    const res = await engine.importFiles({ dbPath, files: [f], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    assert.equal(res.totalImported, 2);
    const meta = queryAll(dbPath, "SELECT * FROM t_meta WHERE month_key = '2026-03'");
    assert.equal(meta.length, 1, '月元数据已落库');
    assert.equal(meta[0].row_count, 2, '🔴 rowCount = totalImported');
    assert.match(meta[0].source_files, /fixture\.xlsx/, 'sourceFiles 含文件名');
  });

  test('finalizeForCommit 中途失败 → 整批 ROLLBACK，行与月元数据均不残留（资金敏感 R-3）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, { finalizeBad: true });
    const f = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '1']] });
    let err = null;
    try {
      await engine.importFiles({ dbPath, files: [f], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    } catch (e) { err = e; }
    assert.ok(err, 'finalize 失败应抛错');
    assert.match(err.message, /事务内收尾失败/, 'message 标明收尾失败');
    assert.equal(countRows(dbPath), 0, '🔴 ROLLBACK 后行不残留（有行无元数据中间态被撤销）');
    assert.equal(countRows(dbPath, 't_meta'), 0, '🔴 月元数据不残留');
  });

  test('不声明 finalizeForCommit → 无收尾，元数据表空（现状回归）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, {});
    const f = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '1']] });
    const res = await engine.importFiles({ dbPath, files: [f], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    assert.equal(res.totalImported, 1);
    assert.equal(countRows(dbPath, 't_meta'), 0, '无 finalize ⇒ 元数据表空');
  });
});

// ───────────────────────────── E3 空文件整批拒绝 ─────────────────────────────
test.describe('E3 空文件整批拒绝 rejectEmptyFiles', () => {
  test.after(() => fx.cleanupTmpDirs());

  test('声明 rejectEmptyFiles + 仅表头文件 → 整批拒绝 + formatEmptyFileError 文案 + 表空', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, { rejectEmpty: true });
    // 文件 A 有数据行，文件 B 仅表头（空）→ 整批拒绝（含 A 的行也不入库）。
    const fA = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '1']] });
    const fB = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额']] });
    let err = null;
    try {
      await engine.importFiles({ dbPath, files: [fA, fB], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'BigTableImportError', '空文件应整批拒绝');
    assert.match(err.message, /文件为空或只有表头行/, '文案来自 formatEmptyFileError');
    assert.equal(countRows(dbPath), 0, '🔴 整批 ROLLBACK 表空（A 的行也不入）');
  });

  test('不声明 rejectEmptyFiles + 仅表头文件 → 成功导入 0 行（现状回归）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, {});
    const fB = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额']] });
    const res = await engine.importFiles({ dbPath, files: [fB], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    assert.equal(res.totalImported, 0, '空文件不声明 ⇒ 成功 0 行（现状）');
    assert.equal(countRows(dbPath), 0);
  });
});

// ───────────────────────────── F1 批级空数据整批拒绝（PR #71 SR · 🔴 数据丢失回归修复）─────────────────────────────
test.describe('F1 批级空数据整批拒绝 rejectEmptyBatch', () => {
  test.after(() => fx.cleanupTmpDirs());

  test('🔴 overwrite 模式 + 全空批 → DELETE 随空批 ROLLBACK，已有数据完好（数据丢失回归）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    // 多语句覆盖删除 + 批级空拒绝（仿 flow：date 级删 + rejectEmptyBatch）。
    const cm = writeContract(dir, { multiDelete: true, rejectEmptyBatch: true });

    // 预置：t 2 行（2026-03）——模拟「该 date 已有数据」。
    const db = new DatabaseSync(dbPath);
    db.exec("INSERT INTO t (d, k, a) VALUES ('2026-03-01','OLD1','1'),('2026-03-02','OLD2','2')");
    db.close();

    // overwrite 导入「仅表头空文件」→ 引擎事务头 DELETE 旧 2 行，但写循环 totalImported===0 → 批级拒绝 ROLLBACK。
    const fEmpty = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额']] });
    let err = null;
    try {
      await engine.importFiles({ dbPath, files: [fEmpty], contractModulePath: cm, contractOptions: {}, mode: 'overwrite', monthKey: '2026-03' });
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'BigTableImportError', '全空批应整批拒绝');
    assert.match(err.message, /文件无有效数据行/, '文案来自 formatEmptyBatchError');
    assert.equal(err.structuredImportErrors.kind, 'emptyBatch', '🔴 kind=emptyBatch（session 据此还原旧 rejected 形态）');
    // 🔴 数据丢失回归核心：DELETE 与零行 INSERT 同事务 ROLLBACK 撤销，旧 2 行完好。
    assert.equal(countRows(dbPath), 2, '🔴 overwrite 全空批 ROLLBACK：已有数据完好（DELETE 撤销）');
    const ks = queryAll(dbPath, 'SELECT k FROM t ORDER BY id').map((r) => r.k);
    assert.deepEqual(ks, ['OLD1', 'OLD2'], '🔴 原数据逐行完好（OLD1/OLD2 未丢）');
  });

  test('多文件部分空不拒（rejectEmptyBatch 批级语义）：[空文件, 有数据文件] → 成功导入有数据文件', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, { rejectEmptyBatch: true });
    // 文件 A 空（仅表头），文件 B 有数据 → 批级总和 > 0 → 不拒（与 E3 per-file 区分：rejectEmptyFiles 会拒）。
    const fA = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额']] });
    const fB = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '1']] });
    const res = await engine.importFiles({ dbPath, files: [fA, fB], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    assert.equal(res.totalImported, 1, '🔴 批级语义：部分文件空不拒，有数据文件正常导入');
    assert.equal(countRows(dbPath), 1, 'B 的 1 行入库');
  });

  test('不声明 rejectEmptyBatch + 全空批 → 成功导入 0 行（现状回归，行为零变化）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, {});   // 不声明 rejectEmptyBatch / rejectEmptyFiles
    const fEmpty = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额']] });
    const res = await engine.importFiles({ dbPath, files: [fEmpty], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    assert.equal(res.totalImported, 0, '不声明 ⇒ 全空批成功 0 行（现状）');
    assert.equal(countRows(dbPath), 0);
  });
});

// ───────────────────────────── E4 错误捕获增强 ─────────────────────────────
test.describe('E4 错误捕获增强 maxCollectedErrors / captureRowValues', () => {
  test.after(() => fx.cleanupTmpDirs());

  // 造 N 个坏行（主键空）。
  function badRows(n) {
    const rows = [['日期', '主键', '金额']];
    for (let i = 0; i < n; i++) rows.push(['2026-03-01', '', String(i)]);
    return rows;
  }

  test('声明 maxCollectedErrors=1000 → 200 坏行不截到 100（错误明细 > 100）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, { maxErrors: 1000 });
    const f = await fx.writeFixtureExcelJS({ rows: badRows(200) });
    let err = null;
    try {
      await engine.importFiles({ dbPath, files: [f], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'BigTableImportError');
    const detailErrLines = err.detailLines.filter((l) => /第 \d+ 行/.test(l));
    assert.ok(detailErrLines.length > 100, `上限覆盖到 1000 后明细 > 100（实际 ${detailErrLines.length}）`);
    assert.equal(countRows(dbPath), 0, '整批拒绝表空');
  });

  test('不声明 maxCollectedErrors → 200 坏行截到 100（现状回归）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, {});
    const f = await fx.writeFixtureExcelJS({ rows: badRows(200) });
    let err = null;
    try {
      await engine.importFiles({ dbPath, files: [f], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'BigTableImportError');
    const detailErrLines = err.detailLines.filter((l) => /第 \d+ 行/.test(l));
    assert.ok(detailErrLines.length <= 100, `默认上限 100（实际 ${detailErrLines.length}）`);
  });

  test('声明 captureRowValues → 错误记录附原始 cells（经 formatBatchError 暴露）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    // 用带 formatBatchError 的契约把 cells 透出到 detailLines 验证。
    const p = path.join(dir, `contract-cells-${Math.random().toString(36).slice(2, 8)}.js`);
    fs.writeFileSync(p, `'use strict';
module.exports = {
  expectedHeaders: ['日期', '主键', '金额'],
  valueColumnWhitelist: null,
  validateHeaders(cells) { return (cells[0]==='日期'&&cells[1]==='主键'&&cells[2]==='金额') ? {ok:true} : {ok:false,error:'表头不匹配'}; },
  mapRow({ values }) { const k=String(values[1]||'').trim(); if(!k) return {error:{reason:'主键为空'}}; return {params:[values[0],k,values[2]]}; },
  insertSql: 'INSERT INTO t (d, k, a) VALUES (?, ?, ?)',
  requiredColumns: [0,1,2],
  monthKeyOf({ values }) { const m=String(values[0]||'').match(/^(\\d{4})[-/](\\d{1,2})/); return m? m[1]+'-'+String(m[2]).padStart(2,'0') : null; },
  captureRowValues: true,
  formatBatchError({ collectedErrors }) {
    const lines = collectedErrors.map((e) => '行' + e.rowIndex + ' cells=' + JSON.stringify(e.cells));
    return { message: '导入失败（带cells）', detailLines: lines };
  }
};
`, 'utf8');
    const f = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-09', '', '77']] });
    let err = null;
    try {
      await engine.importFiles({ dbPath, files: [f], contractModulePath: p, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'BigTableImportError');
    const cellsLine = err.detailLines.find((l) => /cells=/.test(l));
    assert.ok(cellsLine, '错误记录附带 cells');
    assert.match(cellsLine, /2026-03-09/, '🔴 cells 含本行原始值');
    assert.match(cellsLine, /"77"/, 'cells 含金额原始值');
  });

  test('不声明 captureRowValues → 错误记录不带 cells（现状回归）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const p = path.join(dir, `contract-nocells-${Math.random().toString(36).slice(2, 8)}.js`);
    fs.writeFileSync(p, `'use strict';
module.exports = {
  expectedHeaders: ['日期', '主键', '金额'],
  valueColumnWhitelist: null,
  validateHeaders(cells) { return (cells[0]==='日期'&&cells[1]==='主键'&&cells[2]==='金额') ? {ok:true} : {ok:false,error:'表头不匹配'}; },
  mapRow({ values }) { const k=String(values[1]||'').trim(); if(!k) return {error:{reason:'主键为空'}}; return {params:[values[0],k,values[2]]}; },
  insertSql: 'INSERT INTO t (d, k, a) VALUES (?, ?, ?)',
  requiredColumns: [0,1,2],
  monthKeyOf({ values }) { const m=String(values[0]||'').match(/^(\\d{4})[-/](\\d{1,2})/); return m? m[1]+'-'+String(m[2]).padStart(2,'0') : null; },
  formatBatchError({ collectedErrors }) {
    const hasCells = collectedErrors.some((e) => e.cells !== undefined);
    return { message: '导入失败', detailLines: ['hasCells=' + hasCells] };
  }
};
`, 'utf8');
    const f = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-09', '', '77']] });
    let err = null;
    try {
      await engine.importFiles({ dbPath, files: [f], contractModulePath: p, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'BigTableImportError');
    assert.ok(err.detailLines.includes('hasCells=false'), '🔴 不声明 captureRowValues ⇒ 错误记录无 cells 字段');
  });
});

// ───────────────────────────── E5 写侧跨文件去重 ─────────────────────────────
test.describe('E5 写侧跨文件去重 dedupeKeyOf', () => {
  test.after(() => fx.cleanupTmpDirs());

  test('声明 dedupeKeyOf + 跨文件重复行 → 命中记行级错误（整批拒绝）+ formatDuplicateError 文案', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, { dedupe: true });
    // 文件 A 与 文件 B 含同一行（同 key）→ B 中重复 → 行级错误 → 整批拒绝。
    const fA = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '10']] });
    const fB = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '10'], ['2026-03-02', 'K2', '20']] });
    let err = null;
    try {
      await engine.importFiles({ dbPath, files: [fA, fB], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'BigTableImportError', '跨文件重复应整批拒绝');
    assert.ok(err.detailLines.some((l) => /发现重复行（key/.test(l)), '🔴 文案来自 formatDuplicateError');
    assert.equal(countRows(dbPath), 0, '🔴 整批 ROLLBACK 表空');
  });

  test('声明 dedupeKeyOf 但无重复 → 全部导入成功（去重不误伤）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, { dedupe: true });
    const fA = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '10']] });
    const fB = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-02', 'K2', '20']] });
    const res = await engine.importFiles({ dbPath, files: [fA, fB], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    assert.equal(res.totalImported, 2, '无重复全部入库');
    assert.equal(countRows(dbPath), 2);
  });

  test('不声明 dedupeKeyOf + 跨文件重复行 → 无去重（现状回归，重复行均入库）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeContract(dir, {});
    const fA = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '10']] });
    const fB = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '10']] });
    const res = await engine.importFiles({ dbPath, files: [fA, fB], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    assert.equal(res.totalImported, 2, '🔴 无 dedupeKeyOf ⇒ 重复行不拦截（现状）');
    assert.equal(countRows(dbPath), 2);
  });
});

// ─────────────── E5 cells 缺口补丁：写侧行级错误（去重命中 / INSERT 失败）从 params 逆推 cells ───────────────
//   team-lead 预检发现：引擎写侧 dedupe/INSERT 错误的 batch 项只有 params/rowR/dedupeKey，拿不到原始 cells
//   （mapRow 阶段错误已带 cells，但写侧错误本来不带）。补 cellsOf({params})=>cells hook：captureRowValues +
//   cellsOf 声明时，写侧行级错误也附整行 cells（pending 重复行报错 xlsx 需要，对齐旧链路 worker.js:127）。
//   🔴 铁律：不声明 cellsOf ⇒ 写侧行级错误不带 cells（行为零变化，收单契约未声明仍 byte-for-byte）。
test.describe('E5 cells 缺口补丁 cellsOf（写侧去重/INSERT 错误附 cells）', () => {
  test.after(() => fx.cleanupTmpDirs());

  // 用带 formatBatchError + cellsOf 的契约把写侧去重错误的 cells 透出到 detailLines 验证。
  function writeDedupeCellsContract(dir, withCellsOf) {
    const p = path.join(dir, `contract-dedupe-cells-${withCellsOf ? 'on' : 'off'}-${Math.random().toString(36).slice(2, 8)}.js`);
    const cellsOfLine = withCellsOf
      ? '  cellsOf({ params }) { return Array.isArray(params) ? params.slice() : []; },'
      : '';
    fs.writeFileSync(p, `'use strict';
module.exports = {
  expectedHeaders: ['日期', '主键', '金额'],
  valueColumnWhitelist: null,
  validateHeaders(cells) { return (cells[0]==='日期'&&cells[1]==='主键'&&cells[2]==='金额') ? {ok:true} : {ok:false,error:'表头不匹配'}; },
  mapRow({ values }) { return {params:[values[0],values[1],values[2]]}; },
  insertSql: 'INSERT INTO t (d, k, a) VALUES (?, ?, ?)',
  requiredColumns: [0,1,2],
  monthKeyOf({ values }) { const m=String(values[0]||'').match(/^(\\d{4})[-/](\\d{1,2})/); return m? m[1]+'-'+String(m[2]).padStart(2,'0') : null; },
  captureRowValues: true,
  dedupeKeyOf({ values }) { return [values[0],values[1],values[2]].join('|'); },
  formatDuplicateError({ key }) { return '发现重复行（key ' + key + '）'; },
${cellsOfLine}
  formatBatchError({ collectedErrors }) {
    const lines = collectedErrors.map((e) => '行' + e.rowIndex + ' hasCells=' + (e.cells !== undefined) + ' cells=' + JSON.stringify(e.cells === undefined ? null : e.cells));
    return { message: '导入失败（写侧cells）', detailLines: lines };
  }
};
`, 'utf8');
    return p;
  }

  test('声明 cellsOf + 写侧去重命中 → 重复行错误附整行 cells（从 params 逆推）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeDedupeCellsContract(dir, true);
    const fA = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '10']] });
    const fB = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '10']] });
    let err = null;
    try {
      await engine.importFiles({ dbPath, files: [fA, fB], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'BigTableImportError', '跨文件重复整批拒绝');
    const cellsLine = err.detailLines.find((l) => /hasCells=true/.test(l));
    assert.ok(cellsLine, '🔴 写侧去重错误附 cells（hasCells=true）');
    assert.match(cellsLine, /2026-03-01/, '🔴 cells 含本行原始日期值');
    assert.match(cellsLine, /"K1"/, 'cells 含本行原始主键值');
    assert.match(cellsLine, /"10"/, 'cells 含本行原始金额值');
    // 同时 structuredImportErrors 也带 cells（pending session 还原路径走此字段）。
    assert.ok(err.structuredImportErrors, 'error 挂 structuredImportErrors');
    const dup = (err.structuredImportErrors.collectedErrors || []).find((e) => /发现重复行/.test(e.reason));
    assert.ok(dup && Array.isArray(dup.cells) && dup.cells.length === 3, '🔴 structuredImportErrors 重复行带 3 列 cells');
  });

  test('不声明 cellsOf + 写侧去重命中 → 重复行错误不带 cells（现状回归，铁律）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    const cm = writeDedupeCellsContract(dir, false);
    const fA = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '10']] });
    const fB = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '10']] });
    let err = null;
    try {
      await engine.importFiles({ dbPath, files: [fA, fB], contractModulePath: cm, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'BigTableImportError');
    assert.ok(err.detailLines.some((l) => /hasCells=false/.test(l)), '🔴 不声明 cellsOf ⇒ 写侧去重错误无 cells（行为零变化）');
  });

  test('声明 cellsOf 但不声明 captureRowValues → 写侧错误仍不带 cells（cellsOf 仅在 captureRowValues 时生效）', async () => {
    const dir = mkDir();
    const dbPath = mkDb(dir);
    // 契约声明 cellsOf 但不声明 captureRowValues：引擎 captureRowValuesWrite=false ⇒ cellsOfFn=null。
    const p = path.join(dir, `contract-cellsonly-${Math.random().toString(36).slice(2, 8)}.js`);
    fs.writeFileSync(p, `'use strict';
module.exports = {
  expectedHeaders: ['日期', '主键', '金额'],
  valueColumnWhitelist: null,
  validateHeaders(cells) { return (cells[0]==='日期'&&cells[1]==='主键'&&cells[2]==='金额') ? {ok:true} : {ok:false,error:'表头不匹配'}; },
  mapRow({ values }) { return {params:[values[0],values[1],values[2]]}; },
  insertSql: 'INSERT INTO t (d, k, a) VALUES (?, ?, ?)',
  requiredColumns: [0,1,2],
  monthKeyOf({ values }) { const m=String(values[0]||'').match(/^(\\d{4})[-/](\\d{1,2})/); return m? m[1]+'-'+String(m[2]).padStart(2,'0') : null; },
  dedupeKeyOf({ values }) { return [values[0],values[1],values[2]].join('|'); },
  formatDuplicateError({ key }) { return '发现重复行（key ' + key + '）'; },
  cellsOf({ params }) { return Array.isArray(params) ? params.slice() : []; },
  formatBatchError({ collectedErrors }) {
    const lines = collectedErrors.map((e) => 'hasCells=' + (e.cells !== undefined));
    return { message: '导入失败', detailLines: lines };
  }
};
`, 'utf8');
    const fA = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '10']] });
    const fB = await fx.writeFixtureExcelJS({ rows: [['日期', '主键', '金额'], ['2026-03-01', 'K1', '10']] });
    let err = null;
    try {
      await engine.importFiles({ dbPath, files: [fA, fB], contractModulePath: p, contractOptions: {}, mode: 'append', monthKey: '2026-03' });
    } catch (e) { err = e; }
    assert.ok(err && err.name === 'BigTableImportError');
    assert.ok(err.detailLines.every((l) => /hasCells=false/.test(l)), '🔴 cellsOf 仅在 captureRowValues 开启时生效（防御无关联性）');
  });
});
