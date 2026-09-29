'use strict';
// 合成数据性能对比：每种布局在独立 Node 进程中生成并验证，记录墙钟与进程峰值 RSS。
// 用法：node scripts/benchmark-vcc-financial-op-result-workbook.js [主体数=6] [每主体额外Pending行=1000]
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');

async function child() {
  const { DatabaseSync } = require('node:sqlite');
  const { writeRunWorkbooks } = require('../src/main-process/vcc-financial-op-writer');
  const { writeResultWorkbook } = require('../src/main-process/vcc-financial-op-result-workbook-writer');
  const [mode, dbPath, directory, runIdText, subjectsText] = process.argv.slice(3);
  const subjects = JSON.parse(subjectsText), db = new DatabaseSync(dbPath, { readOnly: true });
  const startedAt = performance.now();
  try {
    db.exec('BEGIN DEFERRED');
    const outputPaths = mode === 'baseline' ? subjects.map((_subject, index) => path.join(directory, `old-${index}.xlsx`))
      : [path.join(directory, 'new.xlsx')];
    const result = await (mode === 'baseline' ? writeRunWorkbooks : writeResultWorkbook)({
      db, runId: Number(runIdText), assetsDir: path.resolve(__dirname, '../assets'), outputPaths });
    db.exec('COMMIT');
    console.log(JSON.stringify({ mode, wallMs: Math.round(performance.now() - startedAt),
      maxRssKiB: process.resourceUsage().maxRSS, files: result.filePaths.length,
      outputBytes: result.filePaths.reduce((sum, file) => sum + fs.statSync(file).size, 0),
      ...(result.metrics ? { writerMetrics: result.metrics } : {}) }));
  } finally { db.close(); }
}

function measure(mode, f) {
  return new Promise((resolve, reject) => {
    const worker = spawn(process.execPath, [__filename, '--child', mode, f.dbPath, f.dir,
      String(f.run.id), JSON.stringify(f.subjects)], { cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    worker.stdout.on('data', (data) => { stdout += data; });
    worker.stderr.on('data', (data) => { stderr += data; });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`${mode} failed: ${stderr}\n${stdout}`));
      else { try { resolve(JSON.parse(stdout.trim().split('\n').at(-1))); } catch (error) { reject(error); } }
    });
  });
}

async function benchmark() {
  const { createResultExportFixture } = require('../tests/helpers/vcc-result-export');
  const subjects = Number(process.argv[2] || 6), rows = Number(process.argv[3] || 1000);
  if (!Number.isSafeInteger(subjects) || subjects < 1 || subjects > 30
      || !Number.isSafeInteger(rows) || rows < 0 || rows > 10000) throw new Error('合成性能样本范围：主体1—30，额外Pending行0—10000');
  const cleanup = [];
  try {
    const f = await createResultExportFixture({ after: (fn) => cleanup.push(fn) }, {
      subjects: Array.from({ length: subjects }, (_unused, index) => `主体${String(index + 1).padStart(2, '0')}`)
    });
    const insert = f.db.prepare(`INSERT INTO vcc_fin_op_pending_summary_rows
      (run_id,subject,channel_name,currency_mismatch,flow_currency,pending_currency,recon_type,flow_amount,pending_amount)
      VALUES (?,?,?,0,'USD','USD','VCC_clearing_credit','0','0')`);
    f.db.exec('BEGIN');
    for (const subject of f.subjects) for (let i = 0; i < rows; i += 1) insert.run(f.run.id, subject, `CHANNEL-${i}`);
    f.db.exec('COMMIT');
    const before = await measure('baseline', f), after = await measure('subject-sheets-v1', f);
    const evidence = { measuredAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
      node: process.version, subjects, extraPendingRowsPerSubject: rows,
      method: '独立 Node 进程；合成 run；包含写出和文件回读校验；峰值为整个子进程 RSS，不是 V8 heap 或受控512MiB准入的实测上限',
      before, after };
    const output = path.resolve(__dirname, `../outputs/vcc-financial-op-result-performance-${subjects}-${rows}.json`);
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence, null, 2)); console.log(output);
  } finally { for (const fn of cleanup.reverse()) await fn(); }
}
(process.argv[2] === '--child' ? child() : benchmark()).catch((error) => { console.error(error); process.exitCode = 1; });
