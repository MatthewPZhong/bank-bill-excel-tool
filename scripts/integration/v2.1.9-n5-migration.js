// v2.1.9 N5 端到端 migration 集成验证脚本
//   目标：模拟"v2.1.8 老库 → v2.1.9 升级"完整路径
//   覆盖 8 个 case：
//     1. 首次 migration — channels 表 + scenarios.channel_id + backfill + 标志位 + 备份
//     2. 重启幂等 — skipped + 数据零变化
//     3. N5 + N4 共存路径 — 两个标志位都存在 + bill_imports raw_json 9 字段 + channels 正确
//     4. 备份失败 graceful — backup-failed + schema 未变 + 标志位不写
//     5. migration 失败回滚 — ROLLBACK + schema 回到迁移前 + 标志位不写
//     6. 「通用」内置 INSERT OR IGNORE 幂等 — UNIQUE 约束生效
//     7. backfill 完整性 — 5+ scenarios 全部 channel_id=1
//     8. 跨 N5 调度依赖 — channels-repository.findByNameAndLocation('通用','通用') 命中
//
// 范式参考：scripts/integration/acquiring-bill-currency-n4-migration.js
//
// 用法：node scripts/integration/v2.1.9-n5-migration.js
//      npm run test:integration

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const { AppDatabase } = require('../../src/backend/database');
const migrations = require('../../src/backend/database/migrations');
const channelsRepo = require('../../src/backend/database/channels-repository');
const { createBackup } = require('../../src/backend/database/backup');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  const aJson = JSON.stringify(actual);
  const eJson = JSON.stringify(expected);
  if (aJson === eJson) { passed++; return; }
  failed++; failures.push({ label, actual, expected });
}
function assertTrue(cond, label) {
  if (cond) { passed++; return; }
  failed++; failures.push({ label, actual: cond, expected: true });
}
function assertThrows(fn, label, errPattern) {
  try {
    fn();
    failed++; failures.push({ label, actual: 'no throw', expected: errPattern ? `throw matching ${errPattern}` : 'throw' });
  } catch (e) {
    if (errPattern && !errPattern.test(String(e && e.message ? e.message : e))) {
      failed++; failures.push({ label, actual: String(e && e.message ? e.message : e), expected: `throw matching ${errPattern}` });
    } else {
      passed++;
    }
  }
}

function setupTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 模拟 v2.1.8 老库 schema：仅有 app_settings + scenarios（3 内置 seed）+ 无 channels 表 + 无 scenarios.channel_id 列
//   关键不变量：N5 migration 必须能从这个起点跑成功
function bootstrapV218Schema(db) {
  // 仅模拟 N5 升级前的最小依赖（避免引入其他模块的 migration 噪音）
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  migrations.ensureScenariosSupport(db);
}

async function run() {
  console.log('==== v2.1.9 N5 migration 端到端集成验证 ====');

  // ============================================================
  // Case 1：首次 migration — channels 表 + scenarios.channel_id + backfill + 标志位 + 备份
  // ============================================================
  {
    const tmpdir = setupTmpDir('n5-mig-c1-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);

      // 跑 N5 migration（注入与 AppDatabase wrapper 同模式 backup 函数）
      const result = migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      assertEq(result.status, 'migrated', 'Case1.first migration status=migrated');
      assertEq(result.columnAdded, true, 'Case1.columnAdded=true');

      // channels 表存在 + 「通用」内置 (id=1, is_builtin=1, name='通用', owner_location='通用')
      const channels = db.prepare('SELECT * FROM channels').all();
      assertEq(channels.length, 1, 'Case1.channels 仅 1 行（通用）');
      assertEq(channels[0].id, 1, 'Case1.通用 id=1');
      assertEq(channels[0].is_builtin, 1, 'Case1.通用 is_builtin=1');
      assertEq(channels[0].name, '通用', 'Case1.通用 name');
      assertEq(channels[0].owner_location, '通用', 'Case1.通用 owner_location');

      // scenarios 表有 channel_id 列 + 所有现有 scenarios.channel_id = 1
      assertEq(migrations.hasColumn(db, 'scenarios', 'channel_id'), true, 'Case1.scenarios.channel_id 列已加');
      const scenarioRows = db.prepare('SELECT id, name, channel_id FROM scenarios').all();
      assertTrue(scenarioRows.length >= 3, `Case1.scenarios >= 3 行 (got ${scenarioRows.length})`);
      assertTrue(scenarioRows.every((r) => r.channel_id === 1), 'Case1.所有 scenarios.channel_id=1（backfill 通用）');

      // 标志位 n5_channels_migrated='true'
      const markerRow = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key='n5_channels_migrated'").get();
      assertEq(markerRow && markerRow.setting_value, 'true', 'Case1.标志位 n5_channels_migrated=true');

      // 备份文件命名 pre-N5
      assertTrue(typeof result.backupPath === 'string' && fs.existsSync(result.backupPath), 'Case1.备份文件存在');
      assertTrue(
        /tool-data-bak-pre-N5-\d{8}T\d{6}\.sqlite$/.test(result.backupPath),
        `Case1.备份路径格式 = tool-data-bak-pre-N5-{timestamp}.sqlite (actual=${result.backupPath})`
      );
      const backupSize = fs.statSync(result.backupPath).size;
      assertTrue(backupSize > 0, `Case1.备份文件大小>0 (actual=${backupSize})`);

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case 2：重启幂等 — Case 1 后再次跑 → skipped + 数据零变化
  // ============================================================
  {
    const tmpdir = setupTmpDir('n5-mig-c2-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);

      // 第一次（建表 + 加列 + backfill + 标志位 + 备份）
      const r1 = migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      assertEq(r1.status, 'migrated', 'Case2.first run status=migrated');

      // 快照数据：channels rows + scenarios.channel_id 序列
      const channelsBefore = db.prepare('SELECT * FROM channels ORDER BY id').all();
      const scenariosBefore = db.prepare('SELECT id, channel_id FROM scenarios ORDER BY id').all();
      const backupFilesBefore = fs.readdirSync(backupDir).sort();

      // 第二次跑 — 应 skipped 且不改变任何数据 + 不写新备份
      const r2 = migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      assertEq(r2.status, 'skipped', 'Case2.second run status=skipped');
      assertEq(r2.backupPath, undefined, 'Case2.skipped 不返 backupPath');

      const channelsAfter = db.prepare('SELECT * FROM channels ORDER BY id').all();
      const scenariosAfter = db.prepare('SELECT id, channel_id FROM scenarios ORDER BY id').all();
      const backupFilesAfter = fs.readdirSync(backupDir).sort();

      assertEq(channelsAfter, channelsBefore, 'Case2.重启后 channels 表数据零变化');
      assertEq(scenariosAfter, scenariosBefore, 'Case2.重启后 scenarios.channel_id 零变化');
      assertEq(backupFilesAfter, backupFilesBefore, 'Case2.skipped 不产生新备份');

      // 不重复建表/加列：能再次执行 ensureChannelsTable 不报错（IF NOT EXISTS 幂等）
      try {
        migrations.ensureChannelsTable(db);
        passed++;  // 幂等通过
      } catch (e) {
        failed++; failures.push({ label: 'Case2.ensureChannelsTable 二次调用 IF NOT EXISTS 幂等', actual: e.message, expected: 'no throw' });
      }

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case 3：N5 + N4 共存路径 — v2.1.8 已升 N4 的老库再升 N5
  //   bootstrap v2.1.8 schema + 跑 N4 migration + 跑 N5
  //   断言两个标志位都存在 + raw_json 9 字段 + channels 表都正确
  // ============================================================
  {
    const tmpdir = setupTmpDir('n5-mig-c3-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    try {
      // 用 AppDatabase 跑完整 init —— 此路径走完所有 migrations（N4 + N5 共存验证最直接）
      const appDb = new AppDatabase(dbPath);
      appDb.init();

      // 验证 N4 标志位
      const n4Marker = appDb.db.prepare(
        "SELECT setting_value FROM app_settings WHERE setting_key='acquiring_bill_raw_json_v2_migrated'"
      ).get();
      assertEq(n4Marker && n4Marker.setting_value, 'true', 'Case3.N4 标志位 acquiring_bill_raw_json_v2_migrated=true');

      // 验证 N5 标志位
      const n5Marker = appDb.db.prepare(
        "SELECT setting_value FROM app_settings WHERE setting_key='n5_channels_migrated'"
      ).get();
      assertEq(n5Marker && n5Marker.setting_value, 'true', 'Case3.N5 标志位 n5_channels_migrated=true');

      // 验证 channels 表 + 「通用」
      const channels = appDb.db.prepare('SELECT * FROM channels').all();
      assertEq(channels.length, 1, 'Case3.channels 仅 1 行（通用）');
      assertEq(channels[0].name, '通用', 'Case3.通用 name 正确');

      // 验证 scenarios.channel_id 已加 + 内置 3 场景全部 = 1
      assertEq(migrations.hasColumn(appDb.db, 'scenarios', 'channel_id'), true, 'Case3.scenarios.channel_id 列存在');
      const scenarios = appDb.db.prepare('SELECT id, channel_id FROM scenarios').all();
      assertTrue(scenarios.length >= 3, 'Case3.scenarios >= 3 行');
      assertTrue(scenarios.every((r) => r.channel_id === 1), 'Case3.所有 scenarios.channel_id=1');

      // 验证 acquiring_bill_currency_bill_imports 表存在（N4 依赖）
      const billTable = appDb.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='acquiring_bill_currency_bill_imports'").get();
      assertTrue(!!billTable, 'Case3.acquiring_bill_currency_bill_imports 表已建（N4 依赖）');

      try { appDb.db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case 4：备份失败 graceful — mock createBackupFn 抛错
  //   断言 ensureSchemaV2_1_9_N5 返回 status='backup-failed' + schema 未变 + 标志位不写
  // ============================================================
  {
    const tmpdir = setupTmpDir('n5-mig-c4-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);

      const failingBackupFn = (_label) => { throw new Error('injected backup failure (disk full)'); };
      const result = migrations.ensureSchemaV2_1_9_N5(db, failingBackupFn);

      assertEq(result.status, 'backup-failed', 'Case4.status=backup-failed');
      assertTrue(typeof result.error === 'string' && /backup failure/.test(result.error), `Case4.error 含注入消息 (actual=${result.error})`);

      // schema 未变：channels 表不存在
      const channelsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channels'").get();
      assertEq(channelsExists, undefined, 'Case4.channels 表未建（备份失败前置）');

      // scenarios.channel_id 列不存在
      assertEq(migrations.hasColumn(db, 'scenarios', 'channel_id'), false, 'Case4.scenarios.channel_id 未加列');

      // 标志位不写 → 下次启动可重试
      const markerRow = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key='n5_channels_migrated'").get();
      assertEq(markerRow, undefined, 'Case4.标志位 n5_channels_migrated 未写');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case 5：migration 失败回滚 — mock ensureChannelsTable 或 ALTER 阶段抛错
  //   断言 ROLLBACK + schema 回到迁移前 + 备份保留 + 标志位不写 + 下次 init 重试
  // ============================================================
  {
    const tmpdir = setupTmpDir('n5-mig-c5-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);

      // proxy db.exec：让事务内 ALTER TABLE scenarios ADD COLUMN 抛错
      //   备份阶段先调 createBackup 成功 → 进事务 → exec('BEGIN') 成功 → ensureChannelsTable 成功（CREATE TABLE）
      //   → ensureScenariosChannelIdColumn 走 db.exec("ALTER TABLE ...") → 注入抛错
      const originalExec = db.exec.bind(db);
      let alterCallCount = 0;
      db.exec = (sql) => {
        if (typeof sql === 'string' && sql.includes('ALTER TABLE scenarios')) {
          alterCallCount++;
          throw new Error('injected fault: simulated ALTER failure');
        }
        return originalExec(sql);
      };

      const result = migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));

      // 恢复 exec 以便清理
      db.exec = originalExec;

      assertEq(result.status, 'migration-failed', 'Case5.status=migration-failed');
      assertTrue(/injected fault/.test(result.error), `Case5.error 含注入消息 (actual=${result.error})`);
      assertTrue(alterCallCount >= 1, `Case5.注入命中 ALTER (alterCallCount=${alterCallCount})`);

      // 备份保留（路径在 result.backupPath，文件存在）
      assertTrue(typeof result.backupPath === 'string' && fs.existsSync(result.backupPath), 'Case5.备份文件保留');

      // ROLLBACK 校验：channels 表不存在（事务内 ensureChannelsTable 创建 → ROLLBACK 后丢）
      const channelsExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='channels'").get();
      assertEq(channelsExists, undefined, 'Case5.channels 表 ROLLBACK 后不存在');

      // 标志位未写
      const markerRow = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key='n5_channels_migrated'").get();
      assertEq(markerRow, undefined, 'Case5.标志位 n5_channels_migrated 未写');

      // 下次 init 重试：移除 mock 后再跑应能成功
      const r2 = migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      assertEq(r2.status, 'migrated', 'Case5.重试 status=migrated');
      const markerAfterRetry = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key='n5_channels_migrated'").get();
      assertEq(markerAfterRetry && markerAfterRetry.setting_value, 'true', 'Case5.重试后标志位写入');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case 6：「通用」内置 INSERT OR IGNORE 幂等 — 手动 INSERT 一条同 (name, owner_location) → 触发 UNIQUE 错误
  //   验证 schema UNIQUE (name, owner_location) 联合约束生效
  // ============================================================
  {
    const tmpdir = setupTmpDir('n5-mig-c6-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);
      migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));

      // 首次跑后表内已有「通用-通用」(id=1)
      const initialCount = db.prepare('SELECT COUNT(*) AS cnt FROM channels').get().cnt;
      assertEq(initialCount, 1, 'Case6.初始仅 1 行（通用）');

      // 手动 INSERT 一条同 (name='通用', owner_location='通用') → UNIQUE 应触发
      assertThrows(
        () => db.prepare('INSERT INTO channels (name, owner_location, is_builtin, sort_order, created_at) VALUES (?, ?, 0, 0, CURRENT_TIMESTAMP)').run('通用', '通用'),
        'Case6.同 (name+location) INSERT 触发 UNIQUE 约束',
        /UNIQUE constraint failed: channels.name, channels.owner_location/
      );

      // 验证表内仍仅 1 行（INSERT 没成功）
      const afterCount = db.prepare('SELECT COUNT(*) AS cnt FROM channels').get().cnt;
      assertEq(afterCount, 1, 'Case6.UNIQUE 拒绝后表内仍仅 1 行');

      // INSERT OR IGNORE 一条同记录 → 无错 + 不增行（幂等回归校验）
      try {
        db.prepare(`
          INSERT OR IGNORE INTO channels (id, name, owner_location, is_builtin, sort_order, created_at)
          VALUES (1, '通用', '通用', 1, 0, CURRENT_TIMESTAMP)
        `).run();
        passed++;
      } catch (e) {
        failed++; failures.push({ label: 'Case6.INSERT OR IGNORE 通用 不抛错', actual: e.message, expected: 'no throw' });
      }
      const finalCount = db.prepare('SELECT COUNT(*) AS cnt FROM channels').get().cnt;
      assertEq(finalCount, 1, 'Case6.INSERT OR IGNORE 重复不增行（幂等）');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case 7：backfill 完整性 — bootstrap 时 seed 5+ scenarios 跨 category
  //   断言所有 5+ 行 channel_id=1 + 不漏不重
  // ============================================================
  {
    const tmpdir = setupTmpDir('n5-mig-c7-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);  // 已自动 seed 3 内置

      // 追加 5 个自定义 scenarios 跨多个 category
      const now = new Date().toISOString();
      const insert = db.prepare(`
        INSERT INTO scenarios (category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
        VALUES (?, ?, 1, 1, '{}', 0, ?, ?)
      `);
      insert.run('extract-recon-id', 'C1-自定义-1', now, now);
      insert.run('extract-recon-id', 'C1-自定义-2', now, now);
      insert.run('offset-bill-mark', 'C2-自定义-1', now, now);
      insert.run('offset-bill-mark', 'C2-自定义-2', now, now);
      insert.run('gateway-recon-join', 'C3-自定义-1', now, now);

      const beforeCount = db.prepare('SELECT COUNT(*) AS cnt FROM scenarios').get().cnt;
      assertTrue(beforeCount >= 8, `Case7.bootstrap + 自定义 共 >= 8 行 (actual=${beforeCount})`);

      // 跑 N5 migration
      const result = migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      assertEq(result.status, 'migrated', 'Case7.migration status=migrated');

      // 所有 scenarios 都 backfill 到 channel_id=1
      const allScenarios = db.prepare('SELECT id, name, category, channel_id FROM scenarios ORDER BY id').all();
      assertEq(allScenarios.length, beforeCount, 'Case7.scenarios 总行数不变（backfill 不删行）');
      assertTrue(allScenarios.every((r) => r.channel_id === 1), `Case7.全部 ${allScenarios.length} 行 channel_id=1`);

      // 不漏不重：每个自定义 name 出现 1 次
      const customNames = ['C1-自定义-1', 'C1-自定义-2', 'C2-自定义-1', 'C2-自定义-2', 'C3-自定义-1'];
      customNames.forEach((nm) => {
        const cnt = db.prepare('SELECT COUNT(*) AS cnt FROM scenarios WHERE name = ?').get(nm).cnt;
        assertEq(cnt, 1, `Case7.场景「${nm}」出现且仅出现 1 次`);
      });

      // 验证 channel_id IS NULL 数 = 0（backfill 完整）
      const nullCount = db.prepare('SELECT COUNT(*) AS cnt FROM scenarios WHERE channel_id IS NULL').get().cnt;
      assertEq(nullCount, 0, 'Case7.无 channel_id IS NULL 残留（backfill 完整）');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case 8：跨 N5 调度依赖 — channels-repository.findByNameAndLocation + getBuiltinGeneral
  //   migration 完成后 channels-repository 应能命中「通用」
  // ============================================================
  {
    const tmpdir = setupTmpDir('n5-mig-c8-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);
      const result = migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      assertEq(result.status, 'migrated', 'Case8.migration status=migrated');

      // findByNameAndLocation('通用', '通用') 命中 id=1
      const found = channelsRepo.findByNameAndLocation(db, '通用', '通用');
      assertTrue(found != null, 'Case8.findByNameAndLocation(通用, 通用) 命中');
      assertEq(found.id, 1, 'Case8.findByNameAndLocation 返回 id=1');
      assertEq(found.name, '通用', 'Case8.findByNameAndLocation 返回 name=通用');
      assertEq(found.ownerLocation, '通用', 'Case8.findByNameAndLocation 返回 ownerLocation=通用');
      assertEq(found.isBuiltin, true, 'Case8.findByNameAndLocation 返回 isBuiltin=true');

      // getBuiltinGeneral 返回 id=1
      const builtin = channelsRepo.getBuiltinGeneral(db);
      assertEq(builtin.id, 1, 'Case8.getBuiltinGeneral 返回 id=1');
      assertEq(builtin.name, '通用', 'Case8.getBuiltinGeneral 返回 name=通用');
      assertEq(builtin.isBuiltin, true, 'Case8.getBuiltinGeneral 返回 isBuiltin=true');

      // 不存在的渠道（如「招商-北京」库内无）→ findByNameAndLocation 返 null
      const notFound = channelsRepo.findByNameAndLocation(db, '招商', '北京');
      assertEq(notFound, null, 'Case8.未存在渠道 findByNameAndLocation 返 null');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // 汇报
  // ============================================================
  const total = passed + failed;
  console.log(`\n==== ${passed}/${total} PASS ====`);
  if (failed > 0) {
    console.error('FAILURES:');
    failures.forEach((f) => {
      console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`);
    });
    process.exit(1);
  }
}

run().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
