// 业务 OP 旧格式月度文件升级集成验证（真实 run-data-store、原 provider、TaskLifecycle 和 worker）。
//   覆盖：
//   - v3.0.13–v3.1.10 建的月度文件（G1：4 张表、无 archive_* 列、无触发器）与当前格式文件同时存在时，
//     按启动顺序先 owner（quiesceOnly）、再 post-outbox 续跑，能升级到 ACTIVE；
//   - 原 provider 补齐 G1 结构后第二轮严格扫描通过，两个月度文件及 -wal/-shm 全部回收；
//   - 主库非目标数据和外部原件保持不变；
//   - G1 文件另含未知表时第一轮照旧阻断，stage 不推进，文件不被改写或删除。
//
// G1 文件用当时的原始 DDL（tests/fixtures/biz-op-v327-legacy-side-ddl-v3.1.10.sql）建库；
// 当前 openSideDb 只会建出新格式，覆盖不到从旧版本直接升级的用户。
// 所有数据在自建临时目录生成，运行结束关闭 runtime/数据库并清理。
// 用法：node scripts/integration/biz-op-legacy-side-db-upgrade.js

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { createUpgradeHost, seedLegacy, seedLegacyG1Month } = require('../../tests/helpers/biz-op-v327-upgrade');
const { directoryDurabilityCapability } = require('../../tests/helpers/durable-directory-tests');
const { TABLES } = require('../../src/main-process/biz-op-v327/upgrade-legacy');

const cases = [];
// 升级提交依赖真实目录 fsync；宿主不支持时生产同样拒绝提交，这里明确 SKIP 而不是模拟成功。
const scenario = (name, run) => cases.push({ name, run, requiresDurability: true });
const digest = (filePath) => createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

async function withUpgradeHost(work) {
  const cleanup = [];
  try {
    const f = await createUpgradeHost({ after(callback) { cleanup.push(callback); } });
    await work(f);
  } finally {
    const errors = [];
    for (const callback of cleanup.reverse()) {
      try { await callback(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, '集成夹具资源清理失败');
  }
}

scenario('G1 与当前格式月度文件按 owner → post-outbox 顺序升级到 ACTIVE，旧文件全部回收、非目标数据保留', () => withUpgradeHost(async (f) => {
  const { oldFile, external } = seedLegacy(f);
  const { file: g1File } = seedLegacyG1Month({ root: f.root, month: '2026-07' });
  const externalSha = digest(external);

  const owner = await f.module.activation.run({ quiesceOnly: true });
  assert.equal(owner.status, 'pending', JSON.stringify(owner));
  assert.equal(f.module.catalog.control().mode, 'MIGRATING');

  const postOutbox = await f.module.retryRecovery();
  assert.equal(postOutbox.ready, true, JSON.stringify(postOutbox));
  assert.equal(f.module.catalog.control().mode, 'ACTIVE');
  assert.equal(f.db.prepare('SELECT phase FROM biz_op_v327_activation').get().phase, 'ACTIVE');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_activation_stages').get().n, 5);

  const reclaimed = f.db.prepare('SELECT file_name FROM biz_op_v327_activation_files WHERE reclaimed=1 ORDER BY file_name').all()
    .map((row) => row.file_name).filter((name) => !/-(wal|shm)$/.test(name));
  assert.deepEqual(reclaimed, ['month-2026-07.sqlite', 'month-2026-08.sqlite']);
  for (const file of [g1File, oldFile]) for (const suffix of ['', '-wal', '-shm']) {
    assert.equal(fs.existsSync(file + suffix), false, `${suffix || '主文件'} 应已回收`);
  }
  for (const table of TABLES) assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(digest(external), externalSha);
  assert.equal(f.db.prepare('SELECT value FROM preserve_settings').get().value, 'unchanged');
  f.module.assertBusinessEnabled();
}));

scenario('G1 月度文件含未知表时第一轮阻断，stage 停在 MIGRATING，文件与主库数据不变', () => withUpgradeHost(async (f) => {
  seedLegacy(f);
  const { file: g1File } = seedLegacyG1Month({ root: f.root, month: '2026-07' });
  const { DatabaseSync } = require('node:sqlite');
  const writer = new DatabaseSync(g1File); writer.exec('CREATE TABLE unrelated(value TEXT)'); writer.close();
  const before = digest(g1File);

  await assert.rejects(f.module.activation.run({ quiesceOnly: true }), { code: 'BIZOP_LEGACY_SCHEMA_UNKNOWN' });
  assert.equal(f.db.prepare('SELECT phase FROM biz_op_v327_activation').get().phase, 'MIGRATING');
  assert.equal(f.module.catalog.control().mode, 'MIGRATING');
  assert.equal(digest(g1File), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_recon_imports').get().n, 1);
  assert.equal(f.db.prepare('SELECT value FROM preserve_settings').get().value, 'unchanged');
}));

async function run() {
  console.log('==== 业务 OP 旧格式月度文件升级集成验证 ====');
  console.log(`宿主真实目录 fsync 能力：${directoryDurabilityCapability.capability}${directoryDurabilityCapability.errorCode ? ` (${directoryDurabilityCapability.errorCode})` : ''}`);
  let passed = 0; let skipped = 0; const failures = [];
  for (const entry of cases) {
    if (entry.requiresDurability && directoryDurabilityCapability.capability !== 'supported') {
      skipped += 1; console.log(`SKIP ${entry.name}`); continue;
    }
    try { await entry.run(); passed += 1; console.log(`PASS ${entry.name}`); }
    catch (error) { failures.push({ name: entry.name, error }); console.error(`FAIL ${entry.name}: ${error.stack || error}`); }
  }
  console.log(`\n==== ${passed}/${cases.length - skipped} PASS ====`);
  if (skipped) console.log(`SKIP ${skipped}/${cases.length}；跳过项不计入 PASS，未执行的平台成功路径不属于本轮验证结果。`);
  if (failures.length) {
    console.error('FAILURES');
    for (const failure of failures) console.error(`  - ${failure.name}: ${failure.error.message}`);
    process.exitCode = 1;
  }
}

run().catch((error) => { console.error('FAILURES\n业务 OP 旧格式月度文件升级集成异常：', error); process.exitCode = 1; });
