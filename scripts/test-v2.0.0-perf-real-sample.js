#!/usr/bin/env node
/* eslint-disable no-console */
// v2.0.0 T12 端到端性能测试（真实样本 2602 + 2603 月）
//
// 样本：
//   /Users/pzhong/Downloads/正常归档Pending账单-2602/*.xlsx （5 文件 ~183MB）
//   /Users/pzhong/Downloads/正常归档Pending账单-2603/*.xlsx （5 文件 ~221MB）
//
// 场景：
//   T12-1  2602 多文件合并导入（spawn worker child process，带 --max-old-space-size=8192）
//   T12-2  2603 多文件合并导入
//   T12-4  对账 2026-02 vs 2026-03（match=order_no / compare=金额,币种,业务BU）
//   T12-5  导出单月差异 xlsx
//   T12-6  导出汇总差异 xlsx（单 run 模式，作为 sanity）
//
// 性能目标（PRD §九）：
//   单月导入 < 5 分钟
//   对账 SQL < 1 分钟
//
// 运行：node scripts/test-v2.0.0-perf-real-sample.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { openPendingDb } = require('../src/backend/pending-db');
const monthRepo = require('../src/backend/pending-db/month-repository');
const ruleRepo = require('../src/backend/pending-db/rule-repository');
const diffRepo = require('../src/backend/pending-db/diff-repository');
const engine = require('../src/backend/pending-reconcile/engine');
const writer = require('../src/backend/pending-export/writer');

const SAMPLE_2602 = '/Users/pzhong/Downloads/正常归档Pending账单-2602';
const SAMPLE_2603 = '/Users/pzhong/Downloads/正常归档Pending账单-2603';
const WORKER_SCRIPT = path.resolve(__dirname, '../src/backend/pending-import/worker.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-perf-'));
const DB_PATH = path.join(TMP, 'tool-data-pending.sqlite');

function listXlsx(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.xlsx'))
    // 过滤掉手工测试留下的副产物：报错导出 / 差异导出 / Excel 打开的临时锁文件 / 备份文件
    .filter((f) => !f.startsWith('pending-import-errors-'))
    .filter((f) => !f.startsWith('月度Pending差异'))
    .filter((f) => !f.startsWith('.~') && !f.startsWith('~$'))
    .filter((f) => !f.includes('-backup-'))
    .sort()
    .map((f) => path.join(dir, f));
}

function formatMs(ms) {
  if (ms < 1000) return `${ms} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(2)} 秒`;
  const min = Math.floor(sec / 60);
  const restSec = (sec - min * 60).toFixed(1);
  return `${min} 分 ${restSec} 秒`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function runImportInWorker({ dbPath, yearMonth, files }) {
  return new Promise((resolve) => {
    const jobMeta = { dbPath, yearMonth, files, archivePath: null };
    const t0 = Date.now();
    let lastProgress = null;
    const worker = spawn(process.execPath, [
      '--max-old-space-size=8192',
      WORKER_SCRIPT,
      JSON.stringify(jobMeta)
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdoutBuf = '';
    let stderrBuf = '';
    const events = [];

    worker.stdout.on('data', (chunk) => {
      stdoutBuf += chunk.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (_e) { ev = { type: 'raw', line }; }
        events.push(ev);
        if (ev.type === 'progress') {
          lastProgress = ev;
          const suffix = ev.totalInserted != null ? `累计入库 ${ev.totalInserted.toLocaleString()}` : `${ev.rowsProcessed || 0} 行`;
          process.stdout.write(`\r  进度: ${ev.file} ${suffix}`);
        }
      }
    });
    worker.stderr.on('data', (chunk) => { stderrBuf += chunk.toString(); });

    worker.on('error', (err) => resolve({ ok: false, error: err.message, durationMs: Date.now() - t0 }));
    worker.on('close', (code) => {
      if (stdoutBuf.trim()) {
        try { events.push(JSON.parse(stdoutBuf.trim())); } catch (_e) { /* ignore */ }
      }
      process.stdout.write('\n');
      const durationMs = Date.now() - t0;
      if (code === 0) {
        const complete = events.find((e) => e.type === 'complete');
        resolve({ ok: true, durationMs, rowCount: complete ? complete.rowCount : 0, sourceFiles: complete ? complete.sourceFiles : [] });
      } else {
        const errEv = events.find((e) => e.type === 'error');
        resolve({ ok: false, durationMs, code, errors: errEv ? errEv.errors : [], stderr: stderrBuf.trim() });
      }
    });
  });
}

let pass = 0;
let fail = 0;
let warn = 0;
function checkResult(label, ok, detail = '') {
  if (ok === true) { console.log('  ✓', label, detail ? `— ${detail}` : ''); pass += 1; }
  else if (ok === 'warn') { console.log('  ⚠', label, detail ? `— ${detail}` : ''); warn += 1; }
  else { console.log('  ✗', label, detail ? `— ${detail}` : ''); fail += 1; }
}

async function main() {
  console.log('===========================================');
  console.log('v2.0.0 T12 真实样本性能测试');
  console.log('===========================================');
  console.log('tempdir:', TMP);
  console.log('DB:', DB_PATH);
  console.log('');

  if (!fs.existsSync(SAMPLE_2602) || !fs.existsSync(SAMPLE_2603)) {
    console.error('样本目录不存在，请确认路径');
    process.exit(2);
  }

  const files2602 = listXlsx(SAMPLE_2602);
  const files2603 = listXlsx(SAMPLE_2603);
  const size2602 = files2602.reduce((acc, f) => acc + fs.statSync(f).size, 0);
  const size2603 = files2603.reduce((acc, f) => acc + fs.statSync(f).size, 0);

  console.log('样本盘点：');
  console.log(`  2026-02: ${files2602.length} 个文件 (${formatBytes(size2602)})`);
  files2602.forEach((f) => console.log(`    - ${path.basename(f)} (${formatBytes(fs.statSync(f).size)})`));
  console.log(`  2026-03: ${files2603.length} 个文件 (${formatBytes(size2603)})`);
  files2603.forEach((f) => console.log(`    - ${path.basename(f)} (${formatBytes(fs.statSync(f).size)})`));
  console.log('');

  // === 预配置规则 ===
  const db = openPendingDb(TMP);
  const matchFields = ['order_no'];
  const compareFields = ['金额', '币种', '业务BU'];
  ruleRepo.upsertRule(db, { matchFields, compareFields });
  console.log(`规则: match=${JSON.stringify(matchFields)}, compare=${JSON.stringify(compareFields)}`);
  console.log('');

  // === T12-1: 2602 导入 ===
  console.log('[T12-1] 2026-02 多文件合并导入');
  const import2602 = await runImportInWorker({ dbPath: DB_PATH, yearMonth: '2026-02', files: files2602 });
  if (!import2602.ok) {
    console.log('  ✗ 导入失败:');
    console.log('    code:', import2602.code);
    console.log('    errors count:', Array.isArray(import2602.errors) ? import2602.errors.length : 'N/A');
    if (Array.isArray(import2602.errors) && import2602.errors.length > 0) {
      console.log('    errors (first 5):', JSON.stringify(import2602.errors.slice(0, 5), null, 2));
      const byKind = {};
      for (const e of import2602.errors) { byKind[e.severity || '?'] = (byKind[e.severity || '?'] || 0) + 1; }
      console.log('    errors by severity:', JSON.stringify(byKind));
    }
    if (import2602.stderr) console.log('    stderr:', import2602.stderr.slice(0, 2000));
    process.exit(1);
  }
  const rps2602 = Math.round((import2602.rowCount / import2602.durationMs) * 1000);
  console.log(`  耗时: ${formatMs(import2602.durationMs)}  行数: ${import2602.rowCount.toLocaleString()}  吞吐: ${rps2602.toLocaleString()} 行/秒`);
  checkResult('2602 导入 < 5 分钟', import2602.durationMs < 5 * 60 * 1000, formatMs(import2602.durationMs));
  checkResult('2602 行数 > 0', import2602.rowCount > 0, `${import2602.rowCount} 行`);

  // === T12-2: 2603 导入 ===
  console.log('');
  console.log('[T12-2] 2026-03 多文件合并导入');
  const import2603 = await runImportInWorker({ dbPath: DB_PATH, yearMonth: '2026-03', files: files2603 });
  if (!import2603.ok) {
    console.log('  ✗ 导入失败:', JSON.stringify(import2603.errors || import2603.stderr || import2603.error));
    process.exit(1);
  }
  const rps2603 = Math.round((import2603.rowCount / import2603.durationMs) * 1000);
  console.log(`  耗时: ${formatMs(import2603.durationMs)}  行数: ${import2603.rowCount.toLocaleString()}  吞吐: ${rps2603.toLocaleString()} 行/秒`);
  checkResult('2603 导入 < 5 分钟', import2603.durationMs < 5 * 60 * 1000, formatMs(import2603.durationMs));
  checkResult('2603 行数 > 0', import2603.rowCount > 0, `${import2603.rowCount} 行`);

  // 验证 DB 状态
  console.log('');
  console.log('[DB-state] 入库后一致性自检');
  const m2602Count = monthRepo.countRowsInMonth(db, '2026-02');
  const m2603Count = monthRepo.countRowsInMonth(db, '2026-03');
  // listMonths 返回字符串数组 [lower..upper desc]
  const months = monthRepo.listMonths(db);
  checkResult('2026-02 count 一致', m2602Count === import2602.rowCount, `${m2602Count} vs import=${import2602.rowCount}`);
  checkResult('2026-03 count 一致', m2603Count === import2603.rowCount, `${m2603Count} vs import=${import2603.rowCount}`);
  checkResult('listMonths 含两月', months.includes('2026-02') && months.includes('2026-03'), months.join(','));

  // === T12-4: reconcile ===
  console.log('');
  console.log('[T12-4] 对账运算 2026-02 vs 2026-03');
  const t_recon0 = Date.now();
  const reconcileResult = engine.runReconciliation(db, {
    upperMonth: '2026-02',
    lowerMonth: '2026-03',
    rule: { matchFields, compareFields }
  });
  const reconDurMs = Date.now() - t_recon0;
  console.log(`  实际耗时: ${formatMs(reconDurMs)}`);
  console.log(`  差异统计: new=${reconcileResult.statNew.toLocaleString()} / missing=${reconcileResult.statMissing.toLocaleString()} / changed=${reconcileResult.statChanged.toLocaleString()}`);
  checkResult('对账 < 1 分钟', reconDurMs < 60 * 1000, formatMs(reconDurMs));
  checkResult('差异统计字段存在', typeof reconcileResult.statNew === 'number' && typeof reconcileResult.statMissing === 'number' && typeof reconcileResult.statChanged === 'number');

  // === T12-5: 单月导出 ===
  console.log('');
  console.log('[T12-5] 导出单月差异 xlsx');
  const singleOut = path.join(TMP, 'diff-single.xlsx');
  const t_exp0 = Date.now();
  const singleRes = writer.exportSingleRun(db, reconcileResult.runId, singleOut);
  const expDurMs = Date.now() - t_exp0;
  const singleSize = fs.existsSync(singleOut) ? fs.statSync(singleOut).size : 0;
  console.log(`  耗时: ${formatMs(expDurMs)}  文件: ${singleOut}  大小: ${formatBytes(singleSize)}`);
  console.log(`  writer 返回: status=${singleRes.status}  rowCount=${singleRes.rowCount}`);
  checkResult('单月导出成功', singleRes.status === 'success');
  checkResult('差异 xlsx 文件存在', singleSize > 0, formatBytes(singleSize));
  checkResult('writer rowCount 对得上', singleRes.rowCount === reconcileResult.statNew + reconcileResult.statMissing + reconcileResult.statChanged);

  // === T12-6: 汇总导出（只有 1 run，作 sanity） ===
  console.log('');
  console.log('[T12-6] 导出汇总差异 xlsx');
  const aggrOut = path.join(TMP, 'diff-aggregate.xlsx');
  const t_aggr0 = Date.now();
  const aggrRes = writer.exportAggregate(db, aggrOut);
  const aggrDurMs = Date.now() - t_aggr0;
  const aggrSize = fs.existsSync(aggrOut) ? fs.statSync(aggrOut).size : 0;
  console.log(`  耗时: ${formatMs(aggrDurMs)}  文件: ${aggrOut}  大小: ${formatBytes(aggrSize)}`);
  console.log(`  writer 返回: status=${aggrRes.status}  runsCount=${aggrRes.runsCount}`);
  checkResult('汇总导出成功', aggrRes.status === 'success');
  checkResult('汇总 xlsx 存在', aggrSize > 0, formatBytes(aggrSize));

  db.close();

  // === 汇总报告 ===
  console.log('');
  console.log('===========================================');
  console.log('性能汇总');
  console.log('===========================================');
  const totalRows = import2602.rowCount + import2603.rowCount;
  const totalImportMs = import2602.durationMs + import2603.durationMs;
  console.log(`总数据量: ${totalRows.toLocaleString()} 行 (2602=${import2602.rowCount.toLocaleString()} + 2603=${import2603.rowCount.toLocaleString()})`);
  console.log(`导入总耗时: ${formatMs(totalImportMs)} (平均吞吐 ${Math.round(totalRows / totalImportMs * 1000).toLocaleString()} 行/秒)`);
  console.log(`  2602: ${formatMs(import2602.durationMs)} / ${import2602.rowCount.toLocaleString()} 行`);
  console.log(`  2603: ${formatMs(import2603.durationMs)} / ${import2603.rowCount.toLocaleString()} 行`);
  console.log(`对账耗时: ${formatMs(reconDurMs)} (${(reconDurMs / (totalRows / 1000000)).toFixed(0)} ms/百万行)`);
  console.log(`单月导出耗时: ${formatMs(expDurMs)} / 差异 ${singleRes.rowCount.toLocaleString()} 条 / 文件 ${formatBytes(singleSize)}`);
  console.log(`汇总导出耗时: ${formatMs(aggrDurMs)} / 文件 ${formatBytes(aggrSize)}`);
  console.log('');
  console.log(`Total: ${pass} pass / ${fail} fail / ${warn} warn`);

  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  process.exit(2);
});
