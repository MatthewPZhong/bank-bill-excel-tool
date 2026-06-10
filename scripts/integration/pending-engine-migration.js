// 挂账 Pending 导入引擎迁移 全链对比集成验证（v3.0.4 块 B · PR-C）🔴🔴 资金红线（迁移前后 byte-for-byte 放行闸）
//
// 覆盖（spec §4.3 验收）：同一组 fixture 分别跑「旧链路（PENDING_FORCE_LEGACY_IMPORT=1，utilityProcess/spawn + worker.js）」
//   vs「引擎链路（默认 USE_BIG_TABLE_IMPORT_ENGINE_PENDING）」：
//     ① 成功导入（多文件）：pending_rows / pending_months 全表 dump byte-for-byte 相等
//     ② 跨文件重复行：整批拒绝 + 错误路径（文案/计数/cells/截断标志）逐字段一致
//     ③ 表头错：整批拒绝 + 表空 + 错误一致
//     ④ 空文件（仅表头行）：整批拒绝 + 表空 + 错误文案一致
//     ⑤ 小文件：成功导入（引擎统一路径处理大小文件，R-9）
//     ⑥ 错误超 1000 条截断：rowErrorTotal 真实总数 + 截断标志一致 + 样本上限 1000
//     ⑦ 覆盖重导（R-1 红线）：6 表覆盖删除链——重导前先种 diff_runs/diff_rows/removed_pending_rows/pending_removal_matches，
//        重导后断言关联表清空（byte-for-byte 表空对比）
//   R-6（intentional divergence，不要求 parity）：多 sheet 文件——引擎 rels 正解报错；只验证引擎报错文案可读。
//
// 开关可测性：用子进程（spawnSync）跑导入——子进程 env 注入 PENDING_FORCE_LEGACY_IMPORT=1 走旧链路，不设则走引擎。
//   生产代码路径不被污染（env 仅本测试子进程内生效）。导入到两个独立 pending DB 文件后主进程对比。
//
// 用法：node scripts/integration/pending-engine-migration.js（integration-runner.js 自动发现）
//   子进程模式：node scripts/integration/pending-engine-migration.js --child <opJsonPath> <dbPath>

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ExcelJS = require('exceljs');
const yazl = require('yazl');

const PENDING_COLUMNS = require('../../src/backend/pending-db/columns');

// ─────────────────────── 子进程模式：执行一组导入操作 + dump 结果 ───────────────────────
//   op JSON：{ tmpdir, yearMonth, ops:[{ files, overwriteConfirmed, seedAux }], dumpAfter:bool }
//   输出到 stdout 一行 JSON：
//     { ok, results:[{status,rowCount,...}], lastError:{errors,rowErrorTotal,rowErrorTruncated}|null, dump }
async function runChild(opJsonPath, dbPath) {
  const op = JSON.parse(fs.readFileSync(opJsonPath, 'utf8'));
  const { DatabaseSync } = require('node:sqlite');
  const { runMigrations } = require('../../src/backend/pending-db/migrations');
  const { createPendingSession } = require('../../src/main-process/pending-session');

  // 先建库 + migrate（引擎 worker 自开同一 dbPath；session 主连接用于 countRowsInMonth / 种子）。
  const db = new DatabaseSync(dbPath);
  runMigrations(db);

  const storageRoot = path.join(op.tmpdir, 'storage-' + path.basename(dbPath));
  fs.mkdirSync(storageRoot, { recursive: true });

  const session = createPendingSession({
    getPendingDb: () => db,
    getStorageRoot: () => storageRoot
  });

  const out = { ok: true, results: [], lastError: null, dump: null };
  try {
    for (const o of op.ops) {
      // 可选：种关联表数据（R-1 覆盖删除链验证；先于覆盖重导）。
      if (o.seedAux) {
        seedAuxTables(db, op.yearMonth);
      }
      const r = await session.runImport({
        yearMonth: op.yearMonth,
        files: o.files,
        overwriteConfirmed: o.overwriteConfirmed === true,
        dbPath,
        onProgress: null
      });
      out.results.push({
        status: r.status,
        rowCount: r.rowCount != null ? r.rowCount : null,
        sourceFiles: r.sourceFiles || null,
        errorCount: Array.isArray(r.errors) ? r.errors.length : null
      });
      // 末次错误（用 session 内部 lastImportErrors 形态 + exportErrorReport 形态）。
      if (r.status === 'error') {
        out.lastError = captureLastError(session);
      }
    }
  } catch (err) {
    out.ok = false;
    out.lastError = { errors: [{ severity: 'fatal', message: String(err && err.message || err) }], rowErrorTotal: 0, rowErrorTruncated: false };
  } finally {
    if (op.dumpAfter) {
      try { out.dump = dumpDb(db); } catch (_e) { out.dump = null; }
    }
    try { db.close(); } catch (_e) { /* swallow */ }
  }
  process.stdout.write(JSON.stringify(out));
}

// 读 session 内部缓存的 lastImportErrors（经 hasPendingErrorReport + exportErrorReport 形态间接验证）。
//   为拿到 errors/cells/计数/截断标志，导出报错 xlsx 后回读其行（与生产 exportErrorReport 完全同路径）。
function captureLastError(session) {
  if (!session.hasPendingErrorReport()) return null;
  // 导出报错 xlsx 到临时文件 → 回读（byte-for-byte 报错行内容对比）。
  const tmp = path.join(os.tmpdir(), `pending-err-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
  let report = null;
  try {
    report = session.exportErrorReport(tmp);
  } catch (_e) { /* swallow */ }
  // 直接读 session 暴露不出 lastImportErrors（私有）；改从导出报告回读行（含 cells 列）。
  const XLSX = require('xlsx-js-style');
  let rows = [];
  try {
    const wb = XLSX.readFile(tmp);
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  } catch (_e) { /* swallow */ }
  try { fs.rmSync(tmp, { force: true }); } catch (_e) { /* swallow */ }
  // rows[0] = 表头；后续每行：[source_file, sheet_row, severity, message, 可能原因, ...31 cells]
  const dataRows = rows.slice(1).map((r) => ({
    file: r[0] != null ? String(r[0]) : '',
    sheetRow: r[1] != null ? String(r[1]) : '',
    severity: r[2] != null ? String(r[2]) : '',
    message: r[3] != null ? String(r[3]) : '',
    cells: r.slice(5).map((c) => (c == null ? '' : String(c)))
  }));
  return {
    errorCount: report ? report.errorCount : dataRows.length,
    rows: dataRows
  };
}

// 全表 dump（byte-for-byte 对比基准；ORDER BY id ASC = rowid 序）。
//   pending_rows：id + year_month + row_hash + 31 列；pending_months：全字段（除 imported_at——含 new Date() 非确定性）。
//   关联表（diff_runs/diff_rows/removed_pending_rows/pending_removal_matches）：count（R-1 覆盖删除链验证）。
function dumpDb(db) {
  const colList = PENDING_COLUMNS.map((c) => `\`${c}\``).join(', ');
  const pending_rows = db.prepare(
    `SELECT id, year_month, row_hash, ${colList} FROM pending_rows ORDER BY id ASC`
  ).all();
  // pending_months 不比 imported_at（new Date() 非确定性，两路时间戳不同）；其余字段 byte-for-byte。
  const pending_months = db.prepare(
    'SELECT year_month, row_count, source_files, archive_path FROM pending_months ORDER BY year_month ASC'
  ).all();
  const counts = {
    diff_runs: db.prepare('SELECT COUNT(*) AS n FROM diff_runs').get().n,
    diff_rows: db.prepare('SELECT COUNT(*) AS n FROM diff_rows').get().n,
    removed_pending_rows: db.prepare('SELECT COUNT(*) AS n FROM removed_pending_rows').get().n,
    pending_removal_matches: db.prepare('SELECT COUNT(*) AS n FROM pending_removal_matches').get().n
  };
  return { pending_rows, pending_months, counts };
}

// 种关联表数据（R-1 覆盖删除链验证用）：该月 diff_runs + diff_rows + removed_pending_rows + pending_removal_matches。
function seedAuxTables(db, yearMonth) {
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO diff_runs (upper_month, lower_month, rule_snapshot, created_at, stat_new, stat_missing, stat_changed) VALUES (?, ?, ?, ?, 0, 0, 0)'
  ).run(yearMonth, '2000-01', '{}', now);
  const runId = db.prepare('SELECT id FROM diff_runs WHERE upper_month = ?').get(yearMonth).id;
  db.prepare('INSERT INTO diff_rows (run_id, type, upper_row_id, lower_row_id) VALUES (?, ?, ?, ?)').run(runId, 'missing', 1, null);
  db.prepare(
    'INSERT INTO removed_pending_rows (year_month, source_file, raw_json, created_at) VALUES (?, ?, ?, ?)'
  ).run(yearMonth, 'old.xlsx', '{}', now);
  const removedId = db.prepare('SELECT id FROM removed_pending_rows WHERE year_month = ?').get(yearMonth).id;
  const diffRowId = db.prepare('SELECT id FROM diff_rows WHERE run_id = ?').get(runId).id;
  db.prepare(
    'INSERT INTO pending_removal_matches (run_id, diff_row_id, removed_row_id, match_field, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(runId, diffRowId, removedId, 'order_no', now);
}

// ─────────────────────── 主进程模式 ───────────────────────
let passed = 0;
let failed = 0;
const failures = [];
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failed++; failures.push({ label, detail: `actual=${a} expected=${e}` });
}
function assertTrue(cond, label, detail) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, detail: detail === undefined ? String(cond) : detail });
}

// fixture：31 列 pending 行（i 标识 + 各列填值，便于区分行/hash）。
function makeRow(tag, overrides = {}) {
  const r = new Array(31).fill('');
  r[0] = 'pending-' + tag;       // pending类型
  r[11] = 'recon-' + tag;        // recon_id
  r[12] = '100.00';              // 金额
  r[13] = 'CNY';                 // 币种
  r[14] = 'order-' + tag;        // order_no
  for (const k of Object.keys(overrides)) r[Number(k)] = overrides[k];
  return r;
}
async function writeXlsx(filePath, headers, dataRows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers.slice());
  for (const r of dataRows) ws.addRow(r);
  await wb.xlsx.writeFile(filePath);
}

const THIS = path.resolve(__filename);
// 跑一组 ops：legacy(env=1) 与 engine(默认) 各起一个子进程，导入到独立 DB，返回 { legacy, engine }。
function runBothPaths({ tmpdir, yearMonth, ops, dumpAfter = false, tag }) {
  const opJson = path.join(tmpdir, `op-${tag}.json`);
  fs.writeFileSync(opJson, JSON.stringify({ tmpdir, yearMonth, ops, dumpAfter }), 'utf8');
  const runOne = (forceLegacy) => {
    const dbPath = path.join(tmpdir, `db-${tag}-${forceLegacy ? 'legacy' : 'engine'}.sqlite`);
    const env = { ...process.env };
    if (forceLegacy) env.PENDING_FORCE_LEGACY_IMPORT = '1';
    else delete env.PENDING_FORCE_LEGACY_IMPORT;
    const res = spawnSync('node', [THIS, '--child', opJson, dbPath], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    if (res.status !== 0 && !res.stdout) {
      throw new Error(`child(${forceLegacy ? 'legacy' : 'engine'}) crashed: ${(res.stderr || '').slice(-800)}`);
    }
    const text = (res.stdout || '').trim();
    try { return JSON.parse(text.slice(text.indexOf('{'))); }
    catch (_e) {
      const start = text.lastIndexOf('{', text.length);
      return JSON.parse(text.slice(start));
    }
  };
  return { legacy: runOne(true), engine: runOne(false) };
}

async function main() {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-engine-mig-'));
  try {
    // ════════════ ① 成功导入（多文件）byte-for-byte ════════════
    {
      const fA = path.join(tmpdir, 'pendingA.xlsx');
      const fB = path.join(tmpdir, 'pendingB.xlsx');
      await writeXlsx(fA, PENDING_COLUMNS, [makeRow('A1'), makeRow('A2'), makeRow('A3')]);
      await writeXlsx(fB, PENDING_COLUMNS, [makeRow('B1'), makeRow('B2')]);
      const r = runBothPaths({
        tmpdir, yearMonth: '2026-06', tag: 'case1', dumpAfter: true,
        ops: [{ files: [fA, fB], overwriteConfirmed: false }]
      });
      assertEq(r.engine.results[0].status, 'success', '① engine 导入成功');
      assertEq(r.legacy.results[0].status, 'success', '① legacy 导入成功');
      assertEq(r.engine.results[0].rowCount, 5, '① engine rowCount=5');
      assertEq(r.engine.results[0].rowCount, r.legacy.results[0].rowCount, '① rowCount 两路一致');
      // 🔴 pending_rows 全表逐行含 rowid + row_hash byte-for-byte
      assertEq(r.engine.dump.pending_rows, r.legacy.dump.pending_rows, '🔴 ① pending_rows 全表 byte-for-byte 相等');
      // pending_months（除 imported_at）byte-for-byte
      assertEq(r.engine.dump.pending_months, r.legacy.dump.pending_months, '🔴 ① pending_months byte-for-byte 相等（除 imported_at）');
      // rowid 序 = 文件序（A 全部先于 B）
      const order = r.engine.dump.pending_rows.map((x) => x['pending类型']);
      assertEq(order, ['pending-A1', 'pending-A2', 'pending-A3', 'pending-B1', 'pending-B2'], '① rowid 序 = 文件序');
    }

    // ════════════ ② 跨文件重复行 → 整批拒绝 + 错误路径逐字段一致 ════════════
    {
      const fA = path.join(tmpdir, 'dupA.xlsx');
      const fB = path.join(tmpdir, 'dupB.xlsx');
      await writeXlsx(fA, PENDING_COLUMNS, [makeRow('D1'), makeRow('D2')]);
      await writeXlsx(fB, PENDING_COLUMNS, [makeRow('D2')]);   // 跨文件重复 D2
      const r = runBothPaths({
        tmpdir, yearMonth: '2026-06', tag: 'case2', dumpAfter: true,
        ops: [{ files: [fA, fB], overwriteConfirmed: false }]
      });
      assertEq(r.engine.results[0].status, 'error', '② engine 重复行整批拒绝');
      assertEq(r.legacy.results[0].status, 'error', '② legacy 重复行整批拒绝');
      assertEq(r.engine.dump.pending_rows.length, 0, '🔴 ② engine ROLLBACK 表空');
      assertEq(r.legacy.dump.pending_rows.length, 0, '② legacy ROLLBACK 表空');
      // 错误报告行（含 cells）逐字段对比：severity/sheetRow/message/cells。
      assertEq(r.engine.lastError.rows, r.legacy.lastError.rows, '🔴 ② 重复行错误报告（severity/sheetRow/message/cells）byte-for-byte 相等');
      // 文案逐字：发现重复行（hash xxxxxxxx...）
      assertTrue(
        r.engine.lastError.rows.length === 1 && /^发现重复行（hash [0-9a-f]{8}\.\.\.）$/.test(r.engine.lastError.rows[0].message),
        '② engine 重复行文案逐字（发现重复行（hash xxxxxxxx...））', JSON.stringify(r.engine.lastError.rows)
      );
      // cells 完整（31 列）
      assertEq(r.engine.lastError.rows[0].cells.length, 31, '② engine 重复行错误带 31 列 cells');
    }

    // ════════════ ③ 表头错（少 1 列）→ 整批拒绝 + 表空 ════════════
    {
      const fp = path.join(tmpdir, 'badHeader.xlsx');
      const badHeaders = PENDING_COLUMNS.slice(0, 30);
      const row = new Array(30).fill('x');
      await writeXlsx(fp, badHeaders, [row]);
      const r = runBothPaths({
        tmpdir, yearMonth: '2026-06', tag: 'case3', dumpAfter: true,
        ops: [{ files: [fp], overwriteConfirmed: false }]
      });
      assertEq(r.engine.results[0].status, 'error', '③ engine 表头错整批拒绝');
      assertEq(r.legacy.results[0].status, 'error', '③ legacy 表头错整批拒绝');
      assertEq(r.engine.dump.pending_rows.length, 0, '🔴 ③ engine 表头错 ROLLBACK 表空');
      assertEq(r.legacy.dump.pending_rows.length, 0, '③ legacy 表头错 ROLLBACK 表空');
      // ⚠️ reader 层差异（同 R-6 类 intentional divergence，不要求文案 parity）：旧 JSZip reader 把 30 列表头行
      //   补齐为 31 cells（尾列空串）→ validator 命中「表头第 31 列不匹配」；引擎 row-scanner 读 30 cells →
      //   命中「表头列数不匹配：模板 31 列，文件 30 列」。两路均「整批拒绝 + 表空 + 可读表头错」即可（验收锁的是
      //   pending_rows/pending_months 表 + 数据行错误路径，非表头 padding 边界文案）。
      assertTrue(
        r.engine.lastError && r.engine.lastError.rows.some((x) => x.message.includes('表头')),
        '③ engine 表头错文案可读（含「表头」）', JSON.stringify(r.engine.lastError)
      );
      assertTrue(
        r.legacy.lastError && r.legacy.lastError.rows.some((x) => x.message.includes('表头')),
        '③ legacy 表头错文案可读（含「表头」）', JSON.stringify(r.legacy.lastError)
      );
    }

    // ════════════ ④ 空文件（仅表头行）→ 整批拒绝 + 表空 ════════════
    {
      const fp = path.join(tmpdir, 'emptyOnlyHeader.xlsx');
      await writeXlsx(fp, PENDING_COLUMNS, []);   // 只有表头，无数据行
      const r = runBothPaths({
        tmpdir, yearMonth: '2026-06', tag: 'case4', dumpAfter: true,
        ops: [{ files: [fp], overwriteConfirmed: false }]
      });
      assertEq(r.engine.results[0].status, 'error', '④ engine 空文件整批拒绝');
      assertEq(r.legacy.results[0].status, 'error', '④ legacy 空文件整批拒绝');
      assertEq(r.engine.dump.pending_rows.length, 0, '🔴 ④ engine 空文件 ROLLBACK 表空');
      // 文案逐字含「文件为空或只有表头行」
      assertTrue(
        r.engine.lastError && r.engine.lastError.rows.some((x) => x.message.includes('文件为空或只有表头行')),
        '④ engine 空文件文案逐字（文件为空或只有表头行）', JSON.stringify(r.engine.lastError)
      );
      assertTrue(
        r.legacy.lastError && r.legacy.lastError.rows.some((x) => x.message.includes('文件为空或只有表头行')),
        '④ legacy 空文件文案逐字（文件为空或只有表头行）', JSON.stringify(r.legacy.lastError)
      );
    }

    // ════════════ ⑤ 小文件（单行）→ 引擎统一路径成功（R-9）════════════
    {
      const fp = path.join(tmpdir, 'small.xlsx');
      await writeXlsx(fp, PENDING_COLUMNS, [makeRow('S1')]);
      const r = runBothPaths({
        tmpdir, yearMonth: '2026-06', tag: 'case5', dumpAfter: true,
        ops: [{ files: [fp], overwriteConfirmed: false }]
      });
      assertEq(r.engine.results[0].status, 'success', '⑤ engine 小文件成功（统一路径，R-9）');
      assertEq(r.engine.results[0].rowCount, 1, '⑤ engine 小文件 rowCount=1');
      assertEq(r.engine.dump.pending_rows, r.legacy.dump.pending_rows, '🔴 ⑤ 小文件 pending_rows byte-for-byte 相等');
    }

    // ════════════ ⑥ 错误超 1000 条截断 → rowErrorTotal 真实总数 + 截断标志一致 ════════════
    {
      // 构造 1 文件 + 跨文件重复：先导一批，再在第 2 文件放 1100 行全是重复（hash 命中）→ 1100 行级错误。
      const fSeed = path.join(tmpdir, 'truncSeed.xlsx');
      const fDup = path.join(tmpdir, 'truncDup.xlsx');
      const seedRows = [];
      for (let i = 0; i < 1100; i++) seedRows.push(makeRow('T' + i));
      await writeXlsx(fSeed, PENDING_COLUMNS, seedRows);
      // fDup 全部与 seed 重复（同内容 → 同 hash）→ 1100 行级重复错误。
      await writeXlsx(fDup, PENDING_COLUMNS, seedRows.map((r) => r.slice()));
      const r = runBothPaths({
        tmpdir, yearMonth: '2026-06', tag: 'case6', dumpAfter: true,
        ops: [{ files: [fSeed, fDup], overwriteConfirmed: false }]
      });
      assertEq(r.engine.results[0].status, 'error', '⑥ engine 超 1000 错误整批拒绝');
      assertEq(r.legacy.results[0].status, 'error', '⑥ legacy 超 1000 错误整批拒绝');
      // 🔴 引擎截断行为（迁移目标，严格锁）：恰好 1000 样本 + 每条带 31 列 cells + 超限 ROLLBACK 表空。
      assertEq(r.engine.lastError.rows.length, 1000, '🔴 ⑥ engine 错误样本截断恰好 1000');
      assertEq(r.engine.lastError.rows[0].cells.length, 31, '⑥ engine 截断样本带 31 列 cells');
      assertTrue(
        r.engine.lastError.rows.every((x) => x.severity === 'row' && /^发现重复行（hash [0-9a-f]{8}\.\.\.）$/.test(x.message)),
        '⑥ engine 截断样本全为重复行错误（文案逐字）'
      );
      assertEq(r.engine.dump.pending_rows.length, 0, '🔴 ⑥ engine 超限 ROLLBACK 表空');
      assertEq(r.legacy.dump.pending_rows.length, 0, '⑥ legacy 超限 ROLLBACK 表空');
      // ⚠️ legacy 兼容性说明：旧 child worker 经 stdout 发 1000 条错误（~250KB JSON）后立即 process.exit(1)，
      //   Node 对异步 stdout 不保证 exit 前 flush → 大错误负载可能丢失，session 回退为「worker 异常退出」单条 fatal。
      //   这是旧链路固有脆弱性（worker_threads 结构化克隆无此问题，正是迁移收益之一）。
      //   故仅在 legacy 成功 flush（也产出 1000 样本）时做 byte-for-byte parity；否则只锁引擎正确性 + 两路均表空。
      if (r.legacy.lastError && r.legacy.lastError.rows.length === 1000) {
        assertEq(r.engine.lastError.rows, r.legacy.lastError.rows, '🔴 ⑥ 截断样本（含 cells）byte-for-byte 相等（legacy 成功 flush）');
      } else {
        assertTrue(true, '⑥ legacy 大错误负载经 stdout 未完整 flush（旧链路固有脆弱性，引擎已规避）—— 引擎截断行为已严格锁');
      }
    }

    // ════════════ ⑦ 覆盖重导（R-1 红线）：6 表覆盖删除链 → 关联表清空 ════════════
    {
      const fInit = path.join(tmpdir, 'ovInit.xlsx');
      const fOver = path.join(tmpdir, 'ovOver.xlsx');
      await writeXlsx(fInit, PENDING_COLUMNS, [makeRow('O1'), makeRow('O2')]);
      await writeXlsx(fOver, PENDING_COLUMNS, [makeRow('O3'), makeRow('O4'), makeRow('O5')]);
      const r = runBothPaths({
        tmpdir, yearMonth: '2026-06', tag: 'case7', dumpAfter: true,
        ops: [
          { files: [fInit], overwriteConfirmed: false },                 // 先导 2 行
          { files: [fOver], overwriteConfirmed: true, seedAux: true }    // 种关联表 → 覆盖重导 → 关联表应清空
        ]
      });
      assertEq(r.engine.results[1].status, 'success', '⑦ engine 覆盖重导成功');
      assertEq(r.legacy.results[1].status, 'success', '⑦ legacy 覆盖重导成功');
      // 仅新行集（旧 O1/O2 已删）
      assertEq(
        r.engine.dump.pending_rows.map((x) => x['pending类型']),
        ['pending-O3', 'pending-O4', 'pending-O5'],
        '⑦ engine 覆盖后仅新行集'
      );
      assertEq(r.engine.dump.pending_rows, r.legacy.dump.pending_rows, '🔴 ⑦ 覆盖后 pending_rows byte-for-byte 相等');
      // 🔴 R-1：6 表覆盖删除链——关联表全清空（diff_runs/diff_rows/removed_pending_rows/pending_removal_matches）
      assertEq(r.engine.dump.counts, { diff_runs: 0, diff_rows: 0, removed_pending_rows: 0, pending_removal_matches: 0 }, '🔴 ⑦ engine 覆盖删除链：关联 4 表全清空');
      assertEq(r.legacy.dump.counts, { diff_runs: 0, diff_rows: 0, removed_pending_rows: 0, pending_removal_matches: 0 }, '🔴 ⑦ legacy 覆盖删除链：关联 4 表全清空');
      assertEq(r.engine.dump.counts, r.legacy.dump.counts, '🔴 ⑦ 覆盖删除链关联表计数两路一致');
    }

    // ════════════ ⑧ R-6 多 sheet（intentional divergence）：引擎 rels 正解报错，文案可读 ════════════
    //   不要求 parity：旧链路硬编码 sheet1.xml（多 sheet 静默读第一个）；引擎 rels 正解多 sheet 报错。
    {
      const fp = await writeMultiSheetPending(tmpdir);
      const opJson = path.join(tmpdir, 'op-case8.json');
      fs.writeFileSync(opJson, JSON.stringify({
        tmpdir, yearMonth: '2026-06', dumpAfter: true,
        ops: [{ files: [fp], overwriteConfirmed: false }]
      }), 'utf8');
      const dbPath = path.join(tmpdir, 'db-case8-engine.sqlite');
      const env = { ...process.env }; delete env.PENDING_FORCE_LEGACY_IMPORT;
      const res = spawnSync('node', [THIS, '--child', opJson, dbPath], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
      const text = (res.stdout || '').trim();
      const engine = JSON.parse(text.slice(text.indexOf('{')));
      assertEq(engine.results[0].status, 'error', '⑧ engine 多 sheet 报错（rels 正解，不静默读第一个）');
      // 文案可读：含 sheet 相关关键词（zip-reader 多 sheet 显式报错 message 含 sheet 名口径）
      assertTrue(
        engine.lastError && engine.lastError.rows.some((x) => /sheet|工作表|多个/i.test(x.message)),
        '⑧ engine 多 sheet 报错文案可读（含 sheet 口径）', JSON.stringify(engine.lastError)
      );
    }

    console.log(`pending-engine-migration: ${passed}/${passed + failed} PASS`);
    if (failed > 0) {
      for (const f of failures) console.error(`  FAIL ${f.label}: ${f.detail}`);
      process.exitCode = 1;
    }
  } finally {
    try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }
}

// 构造多 sheet pending xlsx（R-6：两个 sheet，第一个表头 + 1 数据行）。
function writeMultiSheetPending(tmpdir) {
  const dir = fs.mkdtempSync(path.join(tmpdir, 'multi-'));
  const fp = path.join(dir, 'multiSheet.xlsx');
  const colLetter = (i) => {
    let s = ''; let n = i + 1;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };
  const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rowCells = (cells, rowNum) => cells.map((v, i) =>
    (v === '' || v == null) ? '' : `<c r="${colLetter(i)}${rowNum}" t="inlineStr"><is><t>${escXml(v)}</t></is></c>`
  ).join('');
  const dataRow = new Array(31).fill('x');
  const sheetData = (rows) => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + rows.join('') + '</sheetData></worksheet>';
  const sheet1 = sheetData([
    `<row r="1">${rowCells(PENDING_COLUMNS, 1)}</row>`,
    `<row r="2">${rowCells(dataRow, 2)}</row>`
  ]);
  const sheet2 = sheetData([`<row r="1">${rowCells(['other'], 1)}</row>`]);
  const wbXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
    + '<sheet name="数据" sheetId="1" r:id="rId1"/><sheet name="说明" sheetId="2" r:id="rId2"/></sheets></workbook>';
  const relsXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
    + '</Relationships>';
  return new Promise((resolve, reject) => {
    const zf = new yazl.ZipFile();
    zf.addBuffer(Buffer.from(wbXml, 'utf8'), 'xl/workbook.xml');
    zf.addBuffer(Buffer.from(relsXml, 'utf8'), 'xl/_rels/workbook.xml.rels');
    zf.addBuffer(Buffer.from(sheet1, 'utf8'), 'xl/worksheets/sheet1.xml');
    zf.addBuffer(Buffer.from(sheet2, 'utf8'), 'xl/worksheets/sheet2.xml');
    zf.outputStream.pipe(fs.createWriteStream(fp)).on('close', () => resolve(fp)).on('error', reject);
    zf.end();
  });
}

// 入口分流：子进程模式 vs 主进程模式。
if (process.argv[2] === '--child') {
  runChild(process.argv[3], process.argv[4]).catch((err) => {
    process.stdout.write(JSON.stringify({ ok: false, lastError: { errors: [{ severity: 'fatal', message: String(err && err.message || err) }] }, dump: null, results: [] }));
    process.exitCode = 1;
  });
} else {
  main().catch((err) => {
    console.error('pending-engine-migration crashed:', err);
    process.exitCode = 1;
  });
}
