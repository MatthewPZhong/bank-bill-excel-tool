// v2.1.12-beta POC(收单导入) — 干净基准：直接跑真实 prod 导入路径计时（不 replicate，避免 harness bug）
// 用法：node scripts/poc/v2.1.12-acquiring-import-clean-timing.js <fixturePath>
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { AppDatabase } = require('../../src/backend/database');
const session = require('../../src/main-process/acquiring-bill-currency-session');

async function main() {
  const fixture = process.argv[2];
  if (!fixture || !fs.existsSync(fixture)) { console.error('需要 fixture 路径'); process.exit(1); }
  const sizeMB = (fs.statSync(fixture).size / 1024 / 1024).toFixed(1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acq-clean-'));
  const dbPath = path.join(dir, 'tool-data.sqlite');
  const db = new AppDatabase(dbPath);
  db.init();

  let lastRss = 0;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > lastRss) lastRss = rss;
  }, 200);

  console.log(`\n真实 prod 路径 session.importFlowFiles —— fixture ${sizeMB}MB`);
  const t0 = performance.now();
  let result;
  try {
    result = await session.importFlowFiles({
      db: db.db,
      monthKey: process.argv[3] || '2026-03', // fixture 生成器用 2026-03
      filePaths: [fixture],
      onProgress: () => {}
    });
  } catch (e) {
    // monthKey 必填时回退：peek 一次
    console.log('importFlowFiles 需 monthKey，尝试 detected：', e && e.message);
    process.exit(2);
  }
  const ms = performance.now() - t0;
  clearInterval(sampler);

  const imported = result && (result.totalImported || result.importedCount) || 0;
  console.log('================ 真实导入基准 ================');
  console.log(`导入行数        : ${imported}`);
  console.log(`总耗时          : ${(ms / 1000).toFixed(2)} s`);
  console.log(`吞吐            : ${Math.round(imported / (ms / 1000))} 行/秒`);
  console.log(`峰值 RSS        : ${(lastRss / 1024 / 1024).toFixed(0)} MB`);
  console.log(`外推 500万行    : ≈ ${(ms / 1000 * (5000000 / Math.max(imported, 1))).toFixed(0)} s`);

  try { db.db.close(); } catch (_e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}
main().catch((e) => { console.error(e); process.exit(1); });
