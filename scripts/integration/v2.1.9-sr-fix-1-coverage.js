// v2.1.9 SR-FIX-1 自动化覆盖集成测试
//
// 目标：补齐 PR #53 SR-FIX-1 修复后的 4 类未覆盖自动化（避免手测）
//   Case A — C3 真实 44 列 fixture 1v1 红线（spec §16.2 不变量 #1）
//             dispatcher per-channel batch 在真实银行字段下严格 1v1，3 行同金额各拿不同 gw Reference
//   Case B — 老库升级路径（v2.1.8 → N5 + UNIQUE 串行 + 重启幂等）
//             ensureSchemaV2_1_9_N5 + ensureScenariosNameUniqueByChannelId 双 migration 落地 + skipped 幂等
//   Case C — N7 跨 channel 同名场景 import 实际路径（spec §16.3 R1/R2/R3 + bundle parse 防御）
//             同 channel 同名 friendly error；跨 channel 同名允许；bundle parse + detectBundleType 错误用例
//   Case D — D16=b writer 列 label 实际渲染（spec §5.2 + §16.5）
//             _hitChannelId → channels label 反查 + 老 caller 兼容回退 _hitChannelKey
//
// 风格：参考 scripts/integration/v2.1.9-n5-migration.js（bootstrapV218Schema helper +
//       assertEq/assertTrue/assertThrows）+ scripts/integration/v2.1.9-n5-end-to-end.js
//       （dispatcher + writer 端到端 + ExcelJS readback）。
//
// 用法：node scripts/integration/v2.1.9-sr-fix-1-coverage.js
//      npm run test:integration

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');

const migrations = require('../../src/backend/database/migrations');
const channelsRepo = require('../../src/backend/database/channels-repository');
const scenariosRepo = require('../../src/backend/database/scenarios-repository');
const { createBackup } = require('../../src/backend/database/backup');
const { runAllScenarios } = require('../../src/main-process/scenario-dispatcher');
const {
  writeScenarioHitRows,
  REPORT_SHEET_NAME,
  SUFFIX_HEADERS,
} = require('../../src/main-process/scenario-hit-rows-writer');
const {
  serializeScenarioBundle,
  parseScenarioBundle,
  detectBundleType,
  SUPPORTED_SCENARIO_BUNDLE_VERSION,
} = require('../../src/backend/scenarios-bundle-io');
// v2.1.9 SR-FIX-1 round 3（spec §16.3.5）：bundle import 主体提取到独立 module
//   Case F 直接 require 走真实代码路径（取代 round 2 手写 sham 模拟）
const {
  applyScenarioBundleImport,
} = require('../../src/main-process/scenarios-bundle-import');
const { BANK_STATEMENT_FIELDS } = require('../../src/constants/bank-statement-fields');

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

// 复用 v2.1.9-n5-migration.js 同款 helper：构造 v2.1.8 老库 schema（仅 app_settings + scenarios with UNIQUE(name)）
function bootstrapV218Schema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  migrations.ensureScenariosSupport(db);
}

// 构造一条 44 列银行行（仅填关键字段；其余空字符串，模拟生产 reader 输出）
function buildBankRow(rowId, overrides) {
  const row = { _rowId: rowId };
  BANK_STATEMENT_FIELDS.forEach((f) => { row[f] = ''; });
  return Object.assign(row, overrides);
}

// 加载 enabled scenarios 含 channelId / displayIndex（与 dispatcher legacy/dual 入参契约一致）
function loadEnabledScenariosWithChannel(db) {
  const rows = db.prepare(`
    SELECT id, category, name, priority, enabled, channel_id, config_json
    FROM scenarios WHERE enabled = 1
    ORDER BY priority DESC, id ASC
  `).all();
  return rows.map((row, idx) => ({
    id: row.id,
    category: row.category,
    name: row.name,
    priority: row.priority,
    enabled: row.enabled === 1,
    channelId: row.channel_id,
    config: JSON.parse(row.config_json),
    displayIndex: idx + 1,
  }));
}

// 插 1 条 C3 场景（reconFields + assign），channelId 显式传入；用低层 SQL 绕开 createScenario 的 channel_id 默认值兜底
function insertC3Scenario(db, { name, priority, channelId, reconFields, assign }) {
  const config = { reconFields, assign };
  const now = new Date().toISOString();
  const maxRow = db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM scenarios').get();
  const nextId = (Number(maxRow && maxRow.max_id) || 0) + 1;
  db.prepare(`
    INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
    VALUES (?, 'gateway-recon-join', ?, ?, 1, ?, 0, ?, ?, ?)
  `).run(nextId, name, priority, JSON.stringify(config), channelId, now, now);
  return nextId;
}

async function run() {
  console.log('==== v2.1.9 SR-FIX-1 自动化覆盖集成验证 ====');

  // ============================================================
  // Case A — C3 真实 44 列 fixture 1v1 红线（spec §16.2 不变量 #1）
  //   目标：dispatcher per-channel batch 在真实银行字段 fixture 下 3 行同金额 bank
  //         严格各拿 1 条 gw Reference（不共费、不漏）。
  //   构造：通用渠道（id=1，N5 内置）+ 工商-上海（id=2，测试新建）
  //         工商-上海 下挂 1 个 C3（reconFields Amount + MerchantId + Channel + Currency 严格匹配；
  //         assign Reference→ReconciliationId）
  //   bankRows: 3 行 Channel=工商, 地区=上海, MerchantId=M001, Currency=CNY, Credit Amount=100
  //   gwRows:   3 行 Amount=100, MerchantId=M001, Channel=工商, Currency=CNY, Reference 各不同 (A/B/C)
  //   断言：modifiedRows=3 + 3 行 ReconciliationId 排序 sort 后 === [REF-A, REF-B, REF-C]
  //         每行 _hitChannelId === 2（专属工商-上海），且严格 1v1，不共费
  // ============================================================
  {
    const tmpdir = setupTmpDir('sr-fix-1-caseA-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);
      // 跑 N5 migration 建 channels 表（含通用 id=1）+ scenarios.channel_id 列 + backfill
      const n5 = migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      assertEq(n5.status, 'migrated', 'CaseA.N5 migration status=migrated');

      // 建工商-上海专属渠道 (id 大概率=2)
      const gsChan = channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' });
      assertTrue(gsChan && gsChan.id > 1, `CaseA.工商-上海 渠道创建 (id=${gsChan && gsChan.id})`);

      // 插 1 条专属 C3 场景：reconFields = Amount + MerchantId + Channel + Currency；assign Reference→ReconciliationId
      //   注意：gw 侧字段是 gw 行任意 column 名（Reference / Amount / MerchantId / Channel / Currency）
      //         bank 侧字段必须是 BANK_STATEMENT_FIELDS 列出的 44 列之一（Credit Amount / MerchantId / Channel / Currency）
      const c3Id = insertC3Scenario(db, {
        name: 'GS-SH-C3-真实1v1',
        priority: 2,
        channelId: gsChan.id,
        reconFields: [
          { seq: 1, gwField: 'Amount',     bankField: 'Credit Amount' },
          { seq: 2, gwField: 'MerchantId', bankField: 'MerchantId' },
          { seq: 3, gwField: 'Channel',    bankField: 'Channel' },
          { seq: 4, gwField: 'Currency',   bankField: 'Currency' },
        ],
        assign: { gwField: 'Reference', bankField: 'ReconciliationId', mode: 'direct', customValue: '' },
      });

      const scenarios = loadEnabledScenariosWithChannel(db);
      // 仅保留本次新建的 C3 + N5 backfill 后内置通用场景（其余可能命中污染断言）
      //   过滤策略：只保留刚插的 C3（id == c3Id），其余内置 disable 数据已被 enabled filter（loadEnabledScenariosWithChannel 已 WHERE enabled=1）
      //   N5 backfill 后内置 3 个 scenarios.channel_id=1（通用）；这里不 disable，由 dispatcher 不命中（其 conditions/reconFields 与本测试 bankRows 不匹配）保护
      assertTrue(scenarios.some((s) => s.id === c3Id), 'CaseA.scenarios 含本次新建 C3');

      // 构造 3 行真实 44 列银行行 — 同 Channel + 地区 + MerchantId + Currency + 金额
      const bankRows = [
        buildBankRow('R1', { Channel: '工商', 地区: '上海', MerchantId: 'M001', Currency: 'CNY', 'Credit Amount': 100 }),
        buildBankRow('R2', { Channel: '工商', 地区: '上海', MerchantId: 'M001', Currency: 'CNY', 'Credit Amount': 100 }),
        buildBankRow('R3', { Channel: '工商', 地区: '上海', MerchantId: 'M001', Currency: 'CNY', 'Credit Amount': 100 }),
      ];
      // 验证 buildBankRow 真填了 44 列
      assertEq(Object.keys(bankRows[0]).length, BANK_STATEMENT_FIELDS.length + 1, 'CaseA.bankRow 含 44 列 + _rowId');

      // 构造 3 行 gw 行：金额/MerchantId/Channel/Currency 完全相同，Reference 各不同
      const gwRows = [
        { Amount: 100, MerchantId: 'M001', Channel: '工商', Currency: 'CNY', Reference: 'REF-A' },
        { Amount: 100, MerchantId: 'M001', Channel: '工商', Currency: 'CNY', Reference: 'REF-B' },
        { Amount: 100, MerchantId: 'M001', Channel: '工商', Currency: 'CNY', Reference: 'REF-C' },
      ];

      // 跑 dispatcher 双维路径（deps 必传 channelsRepo + db）
      const result = runAllScenarios(bankRows, gwRows, scenarios, { channelsRepo, db });

      assertEq(result.modifiedRows.length, 3, 'CaseA.modifiedRows=3（3 行全命中）');
      assertEq(result.unmatchedRows.length, 0, 'CaseA.unmatchedRows=0');
      assertEq(result.modifiedRows.length + result.unmatchedRows.length, 3, 'CaseA.完整性 mod+unmatched=total');

      // 红线核心：3 行 ReconciliationId 各不相同，sort 后 = [REF-A, REF-B, REF-C]（严格 1v1，不共费）
      const reconIds = result.modifiedRows.map((r) => r.ReconciliationId).sort();
      assertEq(reconIds, ['REF-A', 'REF-B', 'REF-C'], 'CaseA.3 行 ReconciliationId 严格 1v1 = [REF-A, REF-B, REF-C]');

      // 每行 _hitChannelId === gsChan.id（专属工商-上海命中，非通用兜底）
      result.modifiedRows.forEach((r, idx) => {
        assertEq(r._hitChannelId, gsChan.id, `CaseA.modifiedRows[${idx}]._hitChannelId=工商-上海 id`);
        assertEq(r._matchStatus, '命中', `CaseA.modifiedRows[${idx}]._matchStatus=命中`);
        assertEq(r._fallbackChannelId, null, `CaseA.modifiedRows[${idx}]._fallbackChannelId=null（专属命中无 fallback）`);
        assertEq(r._hitScenarioId, c3Id, `CaseA.modifiedRows[${idx}]._hitScenarioId=本次 C3 id`);
      });

      // 验证 stats.hitScenarios 含且仅含本次 C3
      assertTrue(result.stats.hitScenarios.some((s) => s.id === c3Id), 'CaseA.stats.hitScenarios 含本次 C3');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case B — 老库升级路径（v2.1.8 → N5 + UNIQUE 串行 + 重启幂等）
  //   覆盖 3 子场景：
  //     B1：首次升级 — N5 + UNIQUE 双 migration 串行 → status='migrated' / 标志位写 / 备份命名正确
  //     B2：重启幂等 — 再跑两个 migration → 双 status='skipped' + 表结构 / 行数据 0 变化
  //     B3：跨场景串行 — 老库 + 先 N5（OK）→ 不跑 UNIQUE → schema 仍 UNIQUE(name) → 此时 UNIQUE migration 调用应成功 + 改 schema
  // ============================================================

  // B1 — 首次升级 + 双 migration 串行
  {
    const tmpdir = setupTmpDir('sr-fix-1-caseB1-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);  // 此时 scenarios.sql 含 UNIQUE (name)

      // 跑 N5 migration
      const n5Res = migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      assertEq(n5Res.status, 'migrated', 'CaseB1.N5 status=migrated');
      assertTrue(typeof n5Res.backupPath === 'string' && fs.existsSync(n5Res.backupPath),
        'CaseB1.N5 备份文件存在');
      assertTrue(/tool-data-bak-pre-N5-\d{8}T\d{6}\.sqlite$/.test(n5Res.backupPath),
        `CaseB1.N5 备份路径格式 = pre-N5-{ts} (actual=${n5Res.backupPath})`);

      // 跑 UNIQUE migration
      const uniqRes = migrations.ensureScenariosNameUniqueByChannelId(db, (label) => createBackup(db, label, backupDir));
      assertEq(uniqRes.status, 'migrated', 'CaseB1.UNIQUE status=migrated');
      assertTrue(typeof uniqRes.backupPath === 'string' && fs.existsSync(uniqRes.backupPath),
        'CaseB1.UNIQUE 备份文件存在');
      assertTrue(/tool-data-bak-pre-scenarios-unique-migration-\d{8}T\d{6}\.sqlite$/.test(uniqRes.backupPath),
        `CaseB1.UNIQUE 备份路径格式 = pre-scenarios-unique-migration-{ts} (actual=${uniqRes.backupPath})`);

      // 验证 schema：含 UNIQUE (channel_id, name)
      const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'").get().sql;
      assertTrue(/UNIQUE\s*\(\s*channel_id\s*,\s*name\s*\)/i.test(tableSql),
        `CaseB1.scenarios DDL 含 UNIQUE (channel_id, name) (actual=${tableSql})`);
      // 同时验证旧的 UNIQUE (name) 已不存在
      assertTrue(!/UNIQUE\s*\(\s*name\s*\)/i.test(tableSql.replace(/UNIQUE\s*\(\s*channel_id\s*,\s*name\s*\)/gi, '')),
        'CaseB1.scenarios DDL 不再含全表 UNIQUE (name)');

      // 验证两个标志位都写入
      const n5Marker = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key='n5_channels_migrated'").get();
      assertEq(n5Marker && n5Marker.setting_value, 'true', 'CaseB1.n5_channels_migrated=true');
      const uniqMarker = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key='n5_scenarios_unique_migrated'").get();
      assertEq(uniqMarker && uniqMarker.setting_value, 'true', 'CaseB1.n5_scenarios_unique_migrated=true');

      // 验证两个备份文件都在 backupDir 下
      const backupFiles = fs.readdirSync(backupDir);
      assertTrue(backupFiles.some((f) => /pre-N5-/.test(f)), 'CaseB1.备份目录含 pre-N5 文件');
      assertTrue(backupFiles.some((f) => /pre-scenarios-unique-migration-/.test(f)), 'CaseB1.备份目录含 pre-scenarios-unique-migration 文件');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // B2 — 重启幂等：再跑两个 migration → skipped + 表结构 / 行数据 0 变化
  {
    const tmpdir = setupTmpDir('sr-fix-1-caseB2-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);

      // 第一次：跑两个 migration（必须按顺序 — UNIQUE 依赖 N5 已加 channel_id 列）
      migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      migrations.ensureScenariosNameUniqueByChannelId(db, (label) => createBackup(db, label, backupDir));

      // 快照：表 sql + scenarios 行 + channels 行 + 备份文件清单
      const sqlBefore = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'").get().sql;
      const scenariosBefore = db.prepare('SELECT id, name, channel_id FROM scenarios ORDER BY id').all();
      const channelsBefore = db.prepare('SELECT * FROM channels ORDER BY id').all();
      const backupsBefore = fs.readdirSync(backupDir).sort();

      // 第二次：再跑两个 migration → 期望 skipped 且 0 变化
      const n5Again = migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      assertEq(n5Again.status, 'skipped', 'CaseB2.第二次 N5 status=skipped');
      assertEq(n5Again.backupPath, undefined, 'CaseB2.skipped 不返 backupPath');

      const uniqAgain = migrations.ensureScenariosNameUniqueByChannelId(db, (label) => createBackup(db, label, backupDir));
      assertEq(uniqAgain.status, 'skipped', 'CaseB2.第二次 UNIQUE status=skipped');

      const sqlAfter = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'").get().sql;
      const scenariosAfter = db.prepare('SELECT id, name, channel_id FROM scenarios ORDER BY id').all();
      const channelsAfter = db.prepare('SELECT * FROM channels ORDER BY id').all();
      const backupsAfter = fs.readdirSync(backupDir).sort();

      assertEq(sqlAfter, sqlBefore, 'CaseB2.重启后 scenarios 表 sql 0 变化');
      assertEq(scenariosAfter, scenariosBefore, 'CaseB2.重启后 scenarios 行 0 变化');
      assertEq(channelsAfter, channelsBefore, 'CaseB2.重启后 channels 行 0 变化');
      assertEq(backupsAfter, backupsBefore, 'CaseB2.skipped 不产生新备份');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // B3 — 跨场景串行：先 N5 → 不跑 UNIQUE → schema 仍 UNIQUE(name) → UNIQUE migration 调用成功 + 改 schema
  {
    const tmpdir = setupTmpDir('sr-fix-1-caseB3-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);

      // 仅跑 N5（不跑 UNIQUE）
      const n5Res = migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      assertEq(n5Res.status, 'migrated', 'CaseB3.N5 status=migrated');

      // 检验 schema 仍是 UNIQUE(name)（UNIQUE migration 未跑）
      const sqlMid = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'").get().sql;
      assertTrue(/UNIQUE\s*\(\s*name\s*\)/i.test(sqlMid),
        'CaseB3.仅 N5 后 schema 仍是 UNIQUE(name)');
      assertTrue(!/UNIQUE\s*\(\s*channel_id\s*,\s*name\s*\)/i.test(sqlMid),
        'CaseB3.仅 N5 后 schema 未含 UNIQUE(channel_id, name)');
      // 标志位 UNIQUE 未写
      const uniqMarkerBefore = db.prepare("SELECT setting_value FROM app_settings WHERE setting_key='n5_scenarios_unique_migrated'").get();
      assertEq(uniqMarkerBefore, undefined, 'CaseB3.UNIQUE 标志位未写（仅 N5）');

      // 再跑 UNIQUE migration → 应 migrated 且改 schema
      const uniqRes = migrations.ensureScenariosNameUniqueByChannelId(db, (label) => createBackup(db, label, backupDir));
      assertEq(uniqRes.status, 'migrated', 'CaseB3.UNIQUE 二步走 status=migrated');

      const sqlAfter = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'").get().sql;
      assertTrue(/UNIQUE\s*\(\s*channel_id\s*,\s*name\s*\)/i.test(sqlAfter),
        'CaseB3.二步走 UNIQUE 改完 含 UNIQUE(channel_id, name)');

      // 二步走后再跑一次 — 应 skipped-already-composite 或 skipped（视实现）
      const uniqAgain = migrations.ensureScenariosNameUniqueByChannelId(db, (label) => createBackup(db, label, backupDir));
      assertEq(uniqAgain.status, 'skipped', 'CaseB3.二步走完再跑 status=skipped');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case C — N7 跨 channel 同名场景 import 实际路径（spec §16.3 R1/R2/R3 + bundle parse 防御）
  //   测试 1：同 channel 同名 → friendly error（createScenario）
  //          跨 channel 同名 → 允许并存（UPDATE channel_id 模拟 N7 import 路径）
  //   测试 2：bundle-io serialize + parse + detectBundleType（生产 N7 路径解析契约）
  //   测试 3：bundle parse 错误用例（非 JSON / 缺 scenarioBundleVersion / 超出 SUPPORTED）
  // ============================================================
  {
    const tmpdir = setupTmpDir('sr-fix-1-caseC-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);
      migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      migrations.ensureScenariosNameUniqueByChannelId(db, (label) => createBackup(db, label, backupDir));

      // 测试 1：跨 channel 同名场景允许（spec §16.3 R1/R2/R3）
      //   实施路径模拟生产「N7 import」：scenariosRepo.createScenario（默认 channel_id=NULL）
      //   → scenariosRepo.transferScenarios([id], channelId) 显式补 channel_id（与 main.js IPC 一致）
      //   注：scenariosRepo.createScenario 不直接接收 channelId 入参（生产由 UI/IPC 后 transfer），
      //       为了断言「同 channel 同名 friendly error」必须先 transfer 到 channel 把 channel_id 写实
      //       否则 SQLite 复合 UNIQUE (channel_id, name) 中 NULL 不参与去重，UNIQUE 不触发
      const scenarioConfig = {
        conditionsLogic: 'AND',
        conditions: [{ field: 'BillType', op: '等于', value: 'A' }],
        extractByOtherField: { field: 'BizOrderId' },
      };

      // v2.1.9 SR-FIX-1 round 2 F1：createScenario 现在接受 channelId 入参 → 直接落 channel_id
      //   不再需要 transferScenarios 二次 UPDATE 补 channel_id

      // 1.1 第一次 createScenario 落通用 (id=1)
      const createRes1 = scenariosRepo.createScenario(db, {
        category: 'extract-recon-id',
        name: '对账场景',
        priority: 1,
        enabled: true,
        config: scenarioConfig,
        channelId: 1,
      });
      assertTrue(createRes1 && createRes1.id > 0, 'CaseC.1.1 第一次 createScenario 落库');
      const inserted1 = db.prepare('SELECT channel_id, name FROM scenarios WHERE id=?').get(createRes1.id);
      assertEq(inserted1.channel_id, 1, 'CaseC.1.1 直接落 channel_id=1（通用）');
      assertEq(inserted1.name, '对账场景', 'CaseC.1.1 name 保留');

      // 1.2 第二次 createScenario 同 channel 同 name → 直接 friendly error（F1 后行为）
      //   原（F1 前）：createScenario 不写 channel_id → 落 NULL → 不撞 UNIQUE → transferScenarios 才触发
      //   F1 后：createScenario 接 channelId 入参 → 直接落 (channel_id=1, name='对账场景') → 撞 UNIQUE
      //          → scenarios-repository 内 catch 改写为 friendly error
      assertThrows(
        () => scenariosRepo.createScenario(db, {
          category: 'extract-recon-id',
          name: '对账场景',
          priority: 1,
          enabled: true,
          config: scenarioConfig,
          channelId: 1,
        }),
        'CaseC.1.2 同 channel 同名 createScenario 直接抛 friendly error（F1 修订）',
        /在该渠道下已存在/
      );

      // 1.3 建工商-上海渠道
      const gsChan = channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' });
      assertTrue(gsChan && gsChan.id > 1, `CaseC.1.3 工商-上海 建立 (id=${gsChan.id})`);

      // 1.4 跨 channel 同名场景 — F1 后直接 createScenario(channelId=gsChan.id) 即可
      //     spec §6.3.2 + D39：复合 UNIQUE (channel_id, name) 允许跨渠道同名
      const createRes2 = scenariosRepo.createScenario(db, {
        category: 'extract-recon-id',
        name: '对账场景',
        priority: 1,
        enabled: true,
        config: scenarioConfig,
        channelId: gsChan.id,
      });
      const inserted2 = db.prepare('SELECT channel_id, name FROM scenarios WHERE id=?').get(createRes2.id);
      assertEq(inserted2.channel_id, gsChan.id, 'CaseC.1.4 createScenario(channelId=gsChan.id) 直接落对应 channel');
      assertEq(inserted2.name, '对账场景', 'CaseC.1.4 跨 channel 同名 落库 name 保留');

      // 1.5 验证 listScenarios 返 2 条同名场景，channelId 不同
      const all = scenariosRepo.listScenarios(db);
      const sameName = all.filter((s) => s.name === '对账场景');
      assertEq(sameName.length, 2, 'CaseC.1.5 跨 channel 同名 对账场景 存在 2 条');
      const channelIds = sameName.map((s) => s.channelId).sort();
      assertEq(channelIds, [1, gsChan.id].sort(), 'CaseC.1.5 跨 channel 同名 channelId 不同（[1, 工商-上海id]）');

      // 1.6 findByChannelAndName 跨 channel 同名查询仅返指定 channel 的记录（spec §16.3 R3）
      const findGeneral = scenariosRepo.findByChannelAndName(db, 1, '对账场景');
      assertTrue(findGeneral && findGeneral.id === createRes1.id,
        `CaseC.1.6 findByChannelAndName(1, '对账场景') 返通用记录 (id=${createRes1.id})`);
      const findGs = scenariosRepo.findByChannelAndName(db, gsChan.id, '对账场景');
      assertTrue(findGs && findGs.id === createRes2.id,
        `CaseC.1.6 findByChannelAndName(${gsChan.id}, '对账场景') 返工商-上海记录 (id=${createRes2.id})`);
      assertTrue(findGeneral.id !== findGs.id, 'CaseC.1.6 跨 channel 查询返回不同 id');

      // 测试 2：bundle-io serialize + parse + detectBundleType（N7 生产路径契约）
      const channels = channelsRepo.listChannels(db);
      const scenariosByChannel = {};
      channels.forEach((ch) => {
        scenariosByChannel[ch.id] = scenariosRepo.listAllByChannelId(db, ch.id);
      });
      const bundleJson = serializeScenarioBundle(channels, scenariosByChannel, '2.1.9');
      assertTrue(typeof bundleJson === 'string' && bundleJson.length > 0, 'CaseC.2.1 serializeScenarioBundle 返非空字符串');
      // 必须是合法 JSON
      let parsed;
      try { parsed = JSON.parse(bundleJson); passed++; }
      catch (e) { failed++; failures.push({ label: 'CaseC.2.2 bundleJson 是合法 JSON', actual: e.message, expected: 'parse 不抛' }); }
      assertEq(parsed.scenarioBundleVersion, SUPPORTED_SCENARIO_BUNDLE_VERSION,
        'CaseC.2.2 bundleJson.scenarioBundleVersion = SUPPORTED');
      assertEq(parsed.appVersion, '2.1.9', 'CaseC.2.2 bundleJson.appVersion=2.1.9');
      assertTrue(Array.isArray(parsed.channels), 'CaseC.2.2 bundleJson.channels 是数组');

      // detectBundleType
      assertEq(detectBundleType(parsed), 'scenarios', 'CaseC.2.3 detectBundleType=scenarios');

      // parseScenarioBundle 再读回
      const bundle = parseScenarioBundle(bundleJson);
      assertEq(bundle.scenarioBundleVersion, SUPPORTED_SCENARIO_BUNDLE_VERSION, 'CaseC.2.4 parseScenarioBundle.scenarioBundleVersion');
      assertEq(bundle.appVersion, '2.1.9', 'CaseC.2.4 parseScenarioBundle.appVersion');
      assertTrue(Array.isArray(bundle.channels) && bundle.channels.length === channels.length,
        `CaseC.2.4 parseScenarioBundle.channels 数 = listChannels (${channels.length})`);

      // 测试 3：bundle parse 错误用例
      // 3.1 非 JSON
      assertThrows(
        () => parseScenarioBundle('not-a-json-{{'),
        'CaseC.3.1 非 JSON 抛错',
        /场景模板文件格式错误/
      );
      // 3.2 缺 scenarioBundleVersion
      assertThrows(
        () => parseScenarioBundle(JSON.stringify({ channels: [] })),
        'CaseC.3.2 缺 scenarioBundleVersion 抛错',
        /scenarioBundleVersion/
      );
      // 3.3 scenarioBundleVersion > SUPPORTED
      assertThrows(
        () => parseScenarioBundle(JSON.stringify({ scenarioBundleVersion: 99, channels: [] })),
        'CaseC.3.3 scenarioBundleVersion=99 超出 SUPPORTED 抛错',
        /高于当前应用支持的版本/
      );
      // 3.4 scenarioBundleVersion < 1
      assertThrows(
        () => parseScenarioBundle(JSON.stringify({ scenarioBundleVersion: 0, channels: [] })),
        'CaseC.3.4 scenarioBundleVersion=0 不合法 抛错',
        /版本号非法/
      );
      // 3.5 detectBundleType 入参非 object
      assertThrows(
        () => detectBundleType(null),
        'CaseC.3.5 detectBundleType(null) 抛',
        /必须是对象/
      );
      // 3.6 detectBundleType 两个 key 都没
      assertThrows(
        () => detectBundleType({ foo: 1 }),
        'CaseC.3.6 detectBundleType 两 key 都没 抛',
        /无法识别 bundle 类型/
      );
      // 3.7 detectBundleType 两个 key 都有
      assertThrows(
        () => detectBundleType({ scenarioBundleVersion: 1, bundleVersion: 4 }),
        'CaseC.3.7 detectBundleType 两 key 都有 抛',
        /同时含/
      );

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case D — D16=b writer 列 label 实际渲染（spec §5.2 + §16.5）
  //   验证 writeScenarioHitRows 把 _hitChannelId 反查 channels label 写入「匹配渠道」列。
  //   3 条 modifiedRows：
  //     row A：_hitChannelId=2（工商-上海，专属命中）→ 期望 '工商-上海'
  //     row B：_hitChannelId=1（通用兜底）+ _hitChannelKey='招商-北京'（行未匹配渠道但通用命中）→ 期望 '通用'
  //     row C：_hitChannelId=1（通用本身命中）+ _hitChannelKey='通用' → 期望 '通用'
  //   兼容性：opts.channels 不传 → 「匹配渠道」回退 row._hitChannelKey（老 caller / D16=a 兼容路径）
  // ============================================================
  {
    const tmpdir = setupTmpDir('sr-fix-1-caseD-');
    const reportDir = path.join(tmpdir, 'reports');
    try {
      // 准备 channels Array（与生产 listChannels 输出结构一致，含 label）
      const channels = [
        { id: 1, name: '通用',     ownerLocation: '通用', isBuiltin: true,  sortOrder: 0, label: '通用' },
        { id: 2, name: '工商',     ownerLocation: '上海', isBuiltin: false, sortOrder: 1, label: '工商-上海' },
      ];

      // 构造 3 条 modifiedRows（模拟 dispatcher 输出 metadata）
      // 用 BANK_STATEMENT_FIELDS 真实字段 + dispatcher 注入的 _ 前缀 metadata
      const baseRow = {};
      BANK_STATEMENT_FIELDS.forEach((f) => { baseRow[f] = ''; });

      const rowA = Object.assign({}, baseRow, {
        _rowId: 'A',
        Channel: '工商', 地区: '上海', MerchantId: 'M001', Currency: 'CNY', 'Credit Amount': 100,
        _hitChannelId: 2,
        _hitChannelKey: '工商-上海',
        _matchStatus: '命中',
        _hitScenarioId: 10,
        _hitScenarioDisplayIndex: 1,
        _hitScenarioName: '工行 C3',
      });
      const rowB = Object.assign({}, baseRow, {
        _rowId: 'B',
        Channel: '招商', 地区: '北京', MerchantId: 'M002', Currency: 'CNY', 'Credit Amount': 200,
        _hitChannelId: 1,
        _hitChannelKey: '招商-北京',
        _matchStatus: '兜底',
        _hitScenarioId: 20,
        _hitScenarioDisplayIndex: 1,
        _hitScenarioName: '通用 C3',
        _fallbackChannelId: 1,
      });
      const rowC = Object.assign({}, baseRow, {
        _rowId: 'C',
        Channel: '通用', 地区: '通用', MerchantId: 'M003', Currency: 'CNY', 'Credit Amount': 300,
        _hitChannelId: 1,
        _hitChannelKey: '通用',
        _matchStatus: '命中',
        _hitScenarioId: 21,
        _hitScenarioDisplayIndex: 2,
        _hitScenarioName: '通用 C2',
      });

      const modifiedRows = [rowA, rowB, rowC];

      // 跑 writer — 传 channels 启用 D16=b 渠道 label 反查
      const wr = await writeScenarioHitRows(
        modifiedRows,
        '/path/to/银行对账单-test.xlsx',
        { reportDir, timestamp: '20260527T120000', headers: BANK_STATEMENT_FIELDS, channels }
      );
      assertEq(wr.status, 'ok', 'CaseD.writer status=ok');
      assertEq(wr.rowCount, 3, 'CaseD.writer rowCount=3');
      assertEq(wr.fileName, '命中场景行-银行对账单-test-20260527T120000.xlsx',
        'CaseD.writer fileName 规范');
      assertTrue(fs.existsSync(wr.filePath), 'CaseD.独立报表文件存在');

      // readback
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(wr.filePath);
      const sheetNames = wb.worksheets.map((s) => s.name);
      assertEq(sheetNames, [REPORT_SHEET_NAME], 'CaseD.sheet 名 = 命中场景行');

      const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
      // 表头长度 = 44 + 3
      assertEq(sheet.columnCount, BANK_STATEMENT_FIELDS.length + 3,
        `CaseD.列数 = ${BANK_STATEMENT_FIELDS.length} + 3`);

      // 表头精确：44 列银行字段 + ['匹配渠道', '匹配状态', '命中场景']
      const headerValues = sheet.getRow(1).values.slice(1);  // ExcelJS 1-based
      const expectedHeaders = BANK_STATEMENT_FIELDS.concat(SUFFIX_HEADERS);
      assertEq(headerValues, expectedHeaders, 'CaseD.表头 = BANK_STATEMENT_FIELDS + SUFFIX_HEADERS');
      assertEq(SUFFIX_HEADERS, ['匹配渠道', '匹配状态', '命中场景'], 'CaseD.SUFFIX_HEADERS 序');

      const lastBase = BANK_STATEMENT_FIELDS.length;
      // 行 A（sheet row 2）
      const row2 = sheet.getRow(2);
      assertEq(row2.getCell(lastBase + 1).value, '工商-上海', 'CaseD.行A 匹配渠道=工商-上海（_hitChannelId=2 反查）');
      assertEq(row2.getCell(lastBase + 2).value, '命中', 'CaseD.行A 匹配状态=命中');
      assertEq(row2.getCell(lastBase + 3).value, '[1] 工行 C3', 'CaseD.行A 命中场景=[1] 工行 C3');

      // 行 B（sheet row 3）— 兜底命中通用：匹配渠道写'通用'（不是原 _hitChannelKey '招商-北京'）
      const row3 = sheet.getRow(3);
      assertEq(row3.getCell(lastBase + 1).value, '通用', 'CaseD.行B 匹配渠道=通用（_hitChannelId=1 反查 label）');
      assertEq(row3.getCell(lastBase + 2).value, '兜底', 'CaseD.行B 匹配状态=兜底');
      assertEq(row3.getCell(lastBase + 3).value, '[1] 通用 C3', 'CaseD.行B 命中场景=[1] 通用 C3');

      // 行 C（sheet row 4）— 通用本身命中
      const row4 = sheet.getRow(4);
      assertEq(row4.getCell(lastBase + 1).value, '通用', 'CaseD.行C 匹配渠道=通用（_hitChannelId=1 反查 label）');
      assertEq(row4.getCell(lastBase + 2).value, '命中', 'CaseD.行C 匹配状态=命中');
      assertEq(row4.getCell(lastBase + 3).value, '[2] 通用 C2', 'CaseD.行C 命中场景=[2] 通用 C2');

      // 验证内部 _ 前缀字段未泄漏
      const leaks = headerValues.filter((h) => typeof h === 'string' && h.startsWith('_'));
      assertEq(leaks.length, 0, 'CaseD.无 _ 前缀内部字段泄漏到表头');

      // tmp 原子写残留
      assertTrue(!fs.existsSync(`${wr.filePath}.tmp`), 'CaseD.atomic write tmp 已清理');

      // -------- 兼容性回归：opts.channels 不传 → 「匹配渠道」回退 row._hitChannelKey（D16=a 老行为） --------
      const wr2 = await writeScenarioHitRows(
        modifiedRows,
        '/path/to/银行对账单-test2.xlsx',
        { reportDir, timestamp: '20260527T130000', headers: BANK_STATEMENT_FIELDS }
        // 注意：不传 channels
      );
      assertEq(wr2.status, 'ok', 'CaseD.compat writer status=ok（不传 channels）');
      const wb2 = new ExcelJS.Workbook();
      await wb2.xlsx.readFile(wr2.filePath);
      const sheet2 = wb2.getWorksheet(REPORT_SHEET_NAME);
      // 行 A 回退到 _hitChannelKey='工商-上海'（与 channels label 一致，但走的是回退路径）
      assertEq(sheet2.getRow(2).getCell(lastBase + 1).value, '工商-上海',
        'CaseD.compat 行A 匹配渠道=_hitChannelKey 回退（工商-上海）');
      // 行 B 回退到 _hitChannelKey='招商-北京'（与 D16=b 反查 '通用' 不同 — 验证回退路径生效）
      assertEq(sheet2.getRow(3).getCell(lastBase + 1).value, '招商-北京',
        'CaseD.compat 行B 匹配渠道=_hitChannelKey 回退（招商-北京，非通用 label）');
      // 行 C 回退到 _hitChannelKey='通用'
      assertEq(sheet2.getRow(4).getCell(lastBase + 1).value, '通用',
        'CaseD.compat 行C 匹配渠道=_hitChannelKey 回退（通用）');
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case E — F1 端到端（spec §16.3.2）：createScenario(channelId) → dispatcher 命中
  //   spec §16.3.2 P1：原 createScenario 不写 channel_id → 落 NULL →
  //   listByChannelIdAndCategory(WHERE channel_id=?) 不匹配 NULL → 新建场景
  //   在 dispatcher 永远不命中（v2.1.9 N5 核心功能完全失效）
  //
  //   测试覆盖：
  //     E.1 createScenario(channelId=工商-上海.id) → listByChannelIdAndCategory 返 1 条
  //         + runAllScenarios 调度命中工商-上海 行（_hitChannelId=工商-上海 id）
  //     E.2 createScenario(不传 channelId)（兜底通用 id=1）→ 行未 matched 任何 channel
  //         走兜底路径命中通用场景（验证 F1 兜底链路 - 不破坏未 matched 兜底）
  // ============================================================
  {
    const tmpdir = setupTmpDir('sr-fix-1-caseE-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);
      // 跑双 migration：N5 + UNIQUE
      migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      migrations.ensureScenariosNameUniqueByChannelId(db, (label) => createBackup(db, label, backupDir));

      // E.1：建工商-上海渠道 → createScenario(channelId=gsChan.id) → 验证 list + dispatcher 命中
      const gsChan = channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' });
      assertTrue(gsChan && gsChan.id > 1, `CaseE.1.0 工商-上海建立 (id=${gsChan.id})`);

      // F1 修订：createScenario 直接接受 channelId 入参（不再需要 transferScenarios 二次 UPDATE）
      //   插一个 C1 (extract-recon-id) 场景，仅工商-上海 enabled
      const c1Res = scenariosRepo.createScenario(db, {
        category: 'extract-recon-id',
        name: 'GS-SH-C1-extract',
        priority: 2,
        enabled: true,
        config: {
          conditionsLogic: 'AND',
          conditions: [{ field: 'CustomerRef', op: '包含', value: 'AFT' }],
          extractByOtherField: { field: 'CustomerRef' },
        },
        channelId: gsChan.id,  // ★ F1 核心：直接传 channelId
      });
      assertTrue(c1Res && c1Res.id > 0, 'CaseE.1.1 createScenario(channelId=gsChan.id) 返 id');

      // 直查 DB 验证 channel_id 落对
      const dbRow = db.prepare('SELECT channel_id, name FROM scenarios WHERE id=?').get(c1Res.id);
      assertEq(dbRow.channel_id, gsChan.id, 'CaseE.1.2 DB row channel_id=gsChan.id（不是 NULL）');

      // listByChannelIdAndCategory(gsChan.id, 'extract-recon-id') 应返 1 条（F1 修复前为 0）
      const listByGs = scenariosRepo.listByChannelIdAndCategory(db, gsChan.id, 'extract-recon-id');
      const matchGs = listByGs.filter((s) => s.id === c1Res.id);
      assertEq(matchGs.length, 1, 'CaseE.1.3 listByChannelIdAndCategory(gsChan.id) 返本场景 1 条');

      // 跑 dispatcher：bankRow Channel=工商, 地区=上海 → 匹配工商-上海 → 阶段 A 命中 C1
      const bankRow = buildBankRow('R1', {
        Channel: '工商', 地区: '上海', MerchantId: 'M001', Currency: 'CNY', CustomerRef: 'AFT123456789',
      });
      const scenariosForDispatch = loadEnabledScenariosWithChannel(db);
      const dispatchResult = runAllScenarios([bankRow], null, scenariosForDispatch, { channelsRepo, db });

      // 至少有 1 行命中（含本次新建 C1）
      assertTrue(dispatchResult.modifiedRows.length >= 1,
        `CaseE.1.4 dispatcher modifiedRows >= 1 (实际=${dispatchResult.modifiedRows.length})`);
      const hitC1Row = dispatchResult.modifiedRows.find((r) => r._hitScenarioId === c1Res.id);
      assertTrue(!!hitC1Row, `CaseE.1.4 找到 _hitScenarioId=${c1Res.id} 的行 — 证明本场景被 dispatcher 调度`);
      if (hitC1Row) {
        assertEq(hitC1Row._hitChannelId, gsChan.id, 'CaseE.1.5 _hitChannelId=gsChan.id（专属命中 - 非通用兜底）');
        assertEq(hitC1Row._matchStatus, '命中', 'CaseE.1.5 _matchStatus=命中（非兜底）');
      }

      // E.2：createScenario 不传 channelId → 兜底通用（id=1）→ 行未 matched 渠道时走 fallback 命中
      const c1GeneralRes = scenariosRepo.createScenario(db, {
        category: 'extract-recon-id',
        name: 'GENERAL-C1-fallback',
        priority: 1,
        enabled: true,
        config: {
          conditionsLogic: 'AND',
          conditions: [{ field: 'CustomerRef', op: '包含', value: 'GENFB' }],
          extractByOtherField: { field: 'CustomerRef' },
        },
        // 不传 channelId → F1 兜底落 channel_id=1（通用）
      });
      const dbRowGeneral = db.prepare('SELECT channel_id FROM scenarios WHERE id=?').get(c1GeneralRes.id);
      assertEq(dbRowGeneral.channel_id, 1, 'CaseE.2.1 不传 channelId → 兜底落 channel_id=1（通用）');

      // 构造未 matched 渠道的 bank 行（招商-广州 不在 channels 表）
      const bankRowGeneral = buildBankRow('R2', {
        Channel: '招商', 地区: '广州', MerchantId: 'M999', Currency: 'USD', CustomerRef: 'GENFB-001',
      });
      const dispatchResultGeneral = runAllScenarios([bankRowGeneral], null, loadEnabledScenariosWithChannel(db), { channelsRepo, db });
      const hitGeneralRow = dispatchResultGeneral.modifiedRows.find((r) => r._hitScenarioId === c1GeneralRes.id);
      assertTrue(!!hitGeneralRow, 'CaseE.2.2 未 matched channel 行通过通用兜底命中 (F1 兜底链路验证)');
      if (hitGeneralRow) {
        assertEq(hitGeneralRow._matchStatus, '兜底', 'CaseE.2.3 _matchStatus=兜底（未 matched → 走 fallback）');
        assertEq(hitGeneralRow._hitChannelId, 1, 'CaseE.2.3 _hitChannelId=1（通用命中）');
      }

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // ============================================================
  // Case F — F2 + F2-cont 端到端（spec §16.3.3 + §16.3.5）：applyScenarioBundleImport 真实端到端
  //   round 3（spec §16.3.5）抽 main.js 局部函数 → src/main-process/scenarios-bundle-import.js
  //   独立 module，本 case 直接 require 走真实代码路径（取代 round 2 手写 sham 模拟）。
  //
  //   覆盖矩阵：
  //     F.0 sanity — scenariosRepo + findByChannelAndName 直查（round 2 既有底层验证保留）
  //     F.1 核心 — 通用「对账场景」存在 + bundle 导入工商-上海「对账场景」→ importedCount=1 +
  //                工商-上海 channel_id 正确 + 通用渠道场景不变（round 3 主要 bug 修复路径）
  //     F.2 反证 — bundle 导入到通用渠道 + 通用已有同名 → findByChannelAndName 跳过 +
  //                conflicts+1 + importedCount=0
  //     F.3 缺失渠道 + confirmCreateMissingChannels=false → 整 channel 跳过（conflicts reason=channel-missing）
  //     F.4 缺失渠道 + confirmCreateMissingChannels=true → createdChannels+1 + scenarios 落入新 channel
  // ============================================================

  // 构造 applyScenarioBundleImport 的 deps（4 个子 case 共用）
  function makeDeps(db) {
    return {
      db,
      listChannels: () => channelsRepo.listChannels(db),
      getBuiltinGeneralChannel: () => channelsRepo.getBuiltinGeneral(db),
      createChannel: (payload) => channelsRepo.createChannel(db, payload),
      findScenarioByChannelAndName: (channelId, name) => scenariosRepo.findByChannelAndName(db, channelId, name),
      createScenario: (payload) => scenariosRepo.createScenario(db, payload),
    };
  }

  // F.0 — sanity check：scenariosRepo + findByChannelAndName 直查（round 2 底层验证保留）
  {
    const tmpdir = setupTmpDir('sr-fix-1-caseF0-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);
      migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      migrations.ensureScenariosNameUniqueByChannelId(db, (label) => createBackup(db, label, backupDir));

      // 前置：通用渠道已有「对账场景」
      const sGeneral = scenariosRepo.createScenario(db, {
        category: 'extract-recon-id',
        name: '对账场景',
        priority: 1,
        enabled: true,
        config: { conditions: [{ field: 'X', op: '等于', value: 'A' }], extractByOtherField: { field: 'X' } },
        channelId: 1,
      });
      assertTrue(sGeneral && sGeneral.id > 0, 'CaseF.0.1 通用渠道「对账场景」创建成功');

      // 建工商-上海渠道
      const gsChan = channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' });
      assertTrue(gsChan && gsChan.id > 1, `CaseF.0.2 工商-上海渠道建立 (id=${gsChan.id})`);

      // findByChannelAndName(gsChan.id, '对账场景') 应返 null（工商-上海下没有同名）
      const existingInGs = scenariosRepo.findByChannelAndName(db, gsChan.id, '对账场景');
      assertEq(existingInGs, null,
        'CaseF.0.3 工商-上海无「对账场景」→ findByChannelAndName 返 null（channel 内查重）');

      // 反证：通用渠道下查「对账场景」应返 sGeneral
      const existingInGeneral = scenariosRepo.findByChannelAndName(db, 1, '对账场景');
      assertTrue(existingInGeneral && existingInGeneral.id === sGeneral.id,
        'CaseF.0.4 通用渠道查「对账场景」返 sGeneral');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // F.1 — round 3 主要 bug 路径：通用已有「对账场景」+ bundle 导入工商-上海「对账场景」
  //   round 2 决策（保留 INSERT + UPDATE 两步走）+ F1 让 createScenario 默认 channel_id=1
  //   → INSERT 撞通用 UNIQUE → friendly error → UPDATE 永远到不了 → importedCount=0（bug）
  //   round 3 修复（createScenario 直接传 channelId + 删 UPDATE）→ importedCount=1
  {
    const tmpdir = setupTmpDir('sr-fix-1-caseF1-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);
      migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      migrations.ensureScenariosNameUniqueByChannelId(db, (label) => createBackup(db, label, backupDir));

      // 前置：通用渠道已有「对账场景」+ 建工商-上海渠道
      const sGeneral = scenariosRepo.createScenario(db, {
        category: 'extract-recon-id',
        name: '对账场景',
        priority: 1,
        enabled: true,
        config: { conditions: [{ field: 'X', op: '等于', value: 'A' }], extractByOtherField: { field: 'X' } },
        channelId: 1,
      });
      const gsChan = channelsRepo.createChannel(db, { name: '工商', ownerLocation: '上海' });

      // 构造 bundle：channels=[{ name:工商, ownerLocation:上海, isBuiltin:0, scenarios:[{ name:对账场景 }] }]
      const bundle = {
        scenarioBundleVersion: 1,
        appVersion: '2.1.9-test',
        channels: [
          {
            name: '工商',
            ownerLocation: '上海',
            isBuiltin: 0,
            scenarios: [
              {
                category: 'extract-recon-id',
                name: '对账场景',
                sortOrder: 0,
                enabled: 1,
                configJson: { conditions: [{ field: 'X', op: '等于', value: 'B' }], extractByOtherField: { field: 'X' } },
              },
            ],
          },
        ],
      };

      // 调真实 module — round 2 bug：会抛 friendly error；round 3 修复后 importedCount=1
      const result = applyScenarioBundleImport(bundle, { confirmCreateMissingChannels: true }, makeDeps(db));

      // 关键断言：F1+F2 协同修复后核心断言
      assertEq(result.importedCount, 1, 'CaseF.1.1 importedCount=1（round 2 bug 时此处=0 或抛错）');
      assertEq(result.conflicts, [], 'CaseF.1.1 conflicts=[]（无冲突）');
      assertEq(result.createdChannels, [], 'CaseF.1.1 createdChannels=[]（工商-上海前置已建）');

      // 工商-上海下「对账场景」存在 + channel_id 正确
      const gsScenario = scenariosRepo.findByChannelAndName(db, gsChan.id, '对账场景');
      assertTrue(gsScenario && gsScenario.id > 0, 'CaseF.1.2 工商-上海「对账场景」已落库');
      assertEq(gsScenario.channelId, gsChan.id, 'CaseF.1.2 工商-上海「对账场景」channel_id=gsChan.id');

      // 通用渠道原「对账场景」不变（不被破坏）
      const generalScenario = scenariosRepo.findByChannelAndName(db, 1, '对账场景');
      assertTrue(generalScenario && generalScenario.id === sGeneral.id,
        'CaseF.1.3 通用渠道原「对账场景」未被破坏');
      assertEq(generalScenario.channelId, 1, 'CaseF.1.3 通用「对账场景」channel_id 仍 = 1');

      // 库内现有 2 条「对账场景」（通用 1 条 + 工商-上海 1 条）
      const all = db.prepare('SELECT id, channel_id, name FROM scenarios WHERE name=?').all('对账场景');
      assertEq(all.length, 2, 'CaseF.1.4 库内有 2 条「对账场景」（跨渠道同名）');
      const channelIds = all.map((r) => r.channel_id).sort((a, b) => a - b);
      assertEq(channelIds, [1, gsChan.id].sort((a, b) => a - b),
        'CaseF.1.4 两条分别在通用 + 工商-上海');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // F.2 — 反证：bundle 导入到通用渠道 + 通用已有同名场景 → findByChannelAndName 跳过
  {
    const tmpdir = setupTmpDir('sr-fix-1-caseF2-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);
      migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      migrations.ensureScenariosNameUniqueByChannelId(db, (label) => createBackup(db, label, backupDir));

      // 前置：通用渠道已有「对账场景」
      scenariosRepo.createScenario(db, {
        category: 'extract-recon-id',
        name: '对账场景',
        priority: 1,
        enabled: true,
        config: { conditions: [{ field: 'X', op: '等于', value: 'A' }], extractByOtherField: { field: 'X' } },
        channelId: 1,
      });

      // 构造 bundle：channels=[{ 通用渠道, scenarios:[{ name: 对账场景 }] }]
      const bundle = {
        scenarioBundleVersion: 1,
        appVersion: '2.1.9-test',
        channels: [
          {
            name: '通用',
            ownerLocation: '通用',
            isBuiltin: 1,
            scenarios: [
              {
                category: 'extract-recon-id',
                name: '对账场景',
                sortOrder: 0,
                enabled: 1,
                configJson: { conditions: [{ field: 'X', op: '等于', value: 'B' }], extractByOtherField: { field: 'X' } },
              },
            ],
          },
        ],
      };

      const result = applyScenarioBundleImport(bundle, { confirmCreateMissingChannels: false }, makeDeps(db));

      // 关键断言：通用「对账场景」已存在 → findByChannelAndName 命中 → 跳过
      assertEq(result.importedCount, 0, 'CaseF.2.1 importedCount=0（已有同名跳过）');
      assertEq(result.conflicts.length, 1, 'CaseF.2.1 conflicts.length=1');
      assertEq(result.conflicts[0].reason, 'name-duplicate', 'CaseF.2.1 reason=name-duplicate');
      assertEq(result.conflicts[0].scenario, '对账场景', 'CaseF.2.1 scenario=对账场景');
      assertEq(result.conflicts[0].channel, '通用-通用', 'CaseF.2.1 channel label=通用-通用');
      assertEq(result.createdChannels, [], 'CaseF.2.1 createdChannels=[]（不创建渠道）');

      // 库内通用渠道下「对账场景」仍只有 1 条（不被重复 INSERT）
      const all = db.prepare('SELECT id FROM scenarios WHERE channel_id=1 AND name=?').all('对账场景');
      assertEq(all.length, 1, 'CaseF.2.2 通用「对账场景」仍只有 1 条（不重复 INSERT）');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // F.3 — bundle 缺失渠道 + confirmCreateMissingChannels=false → 整 channel 跳过
  {
    const tmpdir = setupTmpDir('sr-fix-1-caseF3-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);
      migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      migrations.ensureScenariosNameUniqueByChannelId(db, (label) => createBackup(db, label, backupDir));

      // 库内无招商-深圳渠道；bundle 含此渠道下 2 个 scenarios
      const bundle = {
        scenarioBundleVersion: 1,
        appVersion: '2.1.9-test',
        channels: [
          {
            name: '招商',
            ownerLocation: '深圳',
            isBuiltin: 0,
            scenarios: [
              {
                category: 'extract-recon-id',
                name: '招商对账场景-1',
                sortOrder: 0,
                enabled: 1,
                configJson: { conditions: [{ field: 'X', op: '等于', value: 'A' }], extractByOtherField: { field: 'X' } },
              },
              {
                category: 'extract-recon-id',
                name: '招商对账场景-2',
                sortOrder: 1,
                enabled: 1,
                configJson: { conditions: [{ field: 'X', op: '等于', value: 'B' }], extractByOtherField: { field: 'X' } },
              },
            ],
          },
        ],
      };

      const result = applyScenarioBundleImport(bundle, { confirmCreateMissingChannels: false }, makeDeps(db));

      assertEq(result.importedCount, 0, 'CaseF.3.1 importedCount=0（缺失渠道 + 未确认创建 → 全跳）');
      assertEq(result.createdChannels, [], 'CaseF.3.1 createdChannels=[]（不创建渠道）');
      assertEq(result.conflicts.length, 2, 'CaseF.3.1 conflicts.length=2（2 个 scenarios 全跳）');
      result.conflicts.forEach((c, idx) => {
        assertEq(c.reason, 'channel-missing', `CaseF.3.2 conflicts[${idx}].reason=channel-missing`);
        assertEq(c.channel, '招商-深圳', `CaseF.3.2 conflicts[${idx}].channel=招商-深圳`);
      });

      // 库内招商-深圳渠道不存在
      const noChan = channelsRepo.findByNameAndLocation(db, '招商', '深圳');
      assertEq(noChan, null, 'CaseF.3.3 库内招商-深圳渠道仍不存在');

      // 库内无招商对账场景
      const cnt = db.prepare('SELECT COUNT(*) AS cnt FROM scenarios WHERE name LIKE ?').get('招商对账场景-%');
      assertEq(cnt.cnt, 0, 'CaseF.3.4 库内无招商对账场景');

      try { db.close(); } catch (_) {}
    } finally {
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  // F.4 — bundle 缺失渠道 + confirmCreateMissingChannels=true → 创建渠道 + 落 scenarios
  {
    const tmpdir = setupTmpDir('sr-fix-1-caseF4-');
    const dbPath = path.join(tmpdir, 'tool-data.sqlite');
    const backupDir = path.join(tmpdir, 'backups');
    try {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA foreign_keys = ON;');
      bootstrapV218Schema(db);
      migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
      migrations.ensureScenariosNameUniqueByChannelId(db, (label) => createBackup(db, label, backupDir));

      // 库内无招商-深圳渠道；bundle 含此渠道下 1 个 scenario
      const bundle = {
        scenarioBundleVersion: 1,
        appVersion: '2.1.9-test',
        channels: [
          {
            name: '招商',
            ownerLocation: '深圳',
            isBuiltin: 0,
            scenarios: [
              {
                category: 'extract-recon-id',
                name: '招商-深圳对账',
                sortOrder: 0,
                enabled: 1,
                configJson: { conditions: [{ field: 'X', op: '等于', value: 'A' }], extractByOtherField: { field: 'X' } },
              },
            ],
          },
        ],
      };

      const result = applyScenarioBundleImport(bundle, { confirmCreateMissingChannels: true }, makeDeps(db));

      assertEq(result.importedCount, 1, 'CaseF.4.1 importedCount=1（确认创建 + scenario 落库）');
      assertEq(result.conflicts, [], 'CaseF.4.1 conflicts=[]');
      assertEq(result.createdChannels.length, 1, 'CaseF.4.1 createdChannels.length=1');
      assertEq(result.createdChannels[0].name, '招商', 'CaseF.4.2 createdChannels[0].name=招商');
      assertEq(result.createdChannels[0].ownerLocation, '深圳', 'CaseF.4.2 createdChannels[0].ownerLocation=深圳');
      assertTrue(Number.isFinite(result.createdChannels[0].id) && result.createdChannels[0].id > 1,
        `CaseF.4.2 createdChannels[0].id 是正整数 (实际=${result.createdChannels[0].id})`);

      // 渠道真在库
      const newChan = channelsRepo.findByNameAndLocation(db, '招商', '深圳');
      assertTrue(newChan && newChan.id === result.createdChannels[0].id,
        'CaseF.4.3 库内招商-深圳渠道已建（id 与返值一致）');

      // 场景落到新渠道下
      const sc = scenariosRepo.findByChannelAndName(db, newChan.id, '招商-深圳对账');
      assertTrue(sc && sc.id > 0, 'CaseF.4.4 招商-深圳「招商-深圳对账」已落库');
      assertEq(sc.channelId, newChan.id, 'CaseF.4.4 招商-深圳场景 channel_id=新渠道 id');

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

if (require.main === module) {
  run().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });
}
