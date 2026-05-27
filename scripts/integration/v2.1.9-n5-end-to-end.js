// v2.1.9 N5 双维调度 + 独立报表端到端集成验证脚本
//   目标：模拟实际银行对账单从导入到处理到独立报表生成的完整链路
//   复用 dispatcher (scenario-dispatcher.runAllScenarios) + writer (scenario-hit-rows-writer.writeScenarioHitRows)
//
// 覆盖 6 个 case：
//   1. 专属命中 + 通用未触发 — 工商-上海 专属规则命中，不走通用
//   2. 专属未命中 → 通用兜底命中 — 工商-上海 专属未命中，通用规则命中
//   3. 未匹配渠道 → 通用兜底 — 库内无的招商-北京，通用规则命中
//   4. 全未命中 → Sheet 2 — 所有规则都不命中，行进 unmatchedRows
//   5. 独立报表写入 — 3 行 mixed → writer 输出 + readback 验证列结构
//   6. first-match-wins 不变量 — 1 行同时满足专属 + 通用，仅命中专属（priority 高的）
//
// 用法：node scripts/integration/v2.1.9-n5-end-to-end.js
//      npm run test:integration

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');

const migrations = require('../../src/backend/database/migrations');
const channelsRepo = require('../../src/backend/database/channels-repository');
const { createBackup } = require('../../src/backend/database/backup');
const { runAllScenarios } = require('../../src/main-process/scenario-dispatcher');
const {
  writeScenarioHitRows,
  REPORT_SHEET_NAME,
  SUFFIX_HEADERS,
} = require('../../src/main-process/scenario-hit-rows-writer');

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

function setupTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 通用环境构造：bootstrap N5 schema + 建「工商-上海」渠道
//   不调用 ensureScenariosSupport 内置 seed —— 测试场景需要纯净起点，由测试函数自己 insert scenarios
function setupNS5Env() {
  const tmpdir = setupTmpDir('n5-e2e-');
  const dbPath = path.join(tmpdir, 'tool-data.sqlite');
  const backupDir = path.join(tmpdir, 'backups');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  // 仅建 app_settings —— 跳过 ensureScenariosSupport seed（避免内置 3 场景污染断言）
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL CHECK (category IN ('extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'recon-id-fix', 'gateway-recon-id-fix')),
      name TEXT NOT NULL,
      priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      config_json TEXT NOT NULL,
      is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (name)
    );
  `);
  // 直接调 ensureSchemaV2_1_9_N5 建 channels 表 + 加 channel_id 列 + backfill
  const r = migrations.ensureSchemaV2_1_9_N5(db, (label) => createBackup(db, label, backupDir));
  if (r.status !== 'migrated') {
    throw new Error(`setupNS5Env: ensureSchemaV2_1_9_N5 failed → ${JSON.stringify(r)}`);
  }
  return { tmpdir, dbPath, db, backupDir };
}

function cleanupEnv(env) {
  try { env.db.close(); } catch (_) {}
  try { fs.rmSync(env.tmpdir, { recursive: true, force: true }); } catch (_) {}
}

// 插场景（构造 C1 extract-recon-id 场景，用 extractByOtherField 直接复制字段值到 ReconciliationId）
//   conditions 用 '等于' 操作符 + extractByOtherField 单字段（最直接的命中场景）
//   返回插入 scenario 的 id
function insertScenario(db, { name, priority, channelId, conditionField, conditionValue, extractField }) {
  const config = {
    conditionsLogic: 'AND',
    conditions: [{ field: conditionField, op: '等于', value: conditionValue }],
    extractByOtherField: { field: extractField },
  };
  const now = new Date().toISOString();
  // calculateNextScenarioId 取下一个未占用 id —— 简化版直接用 MAX+1
  const maxRow = db.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM scenarios').get();
  const nextId = (Number(maxRow && maxRow.max_id) || 0) + 1;
  db.prepare(`
    INSERT INTO scenarios (id, category, name, priority, enabled, config_json, is_builtin, channel_id, created_at, updated_at)
    VALUES (?, 'extract-recon-id', ?, ?, 1, ?, 0, ?, ?, ?)
  `).run(nextId, name, priority, JSON.stringify(config), channelId, now, now);
  return nextId;
}

// 从 scenarios 表拉 enabled 场景的完整 detail（含 channel_id + displayIndex）
//   排序与 scenarios-repository.listScenarios 一致：priority DESC + id ASC
//   返字段：{ id, category, name, priority, enabled, channelId, config, displayIndex }
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

async function run() {
  console.log('==== v2.1.9 N5 双维调度 + 独立报表 端到端集成验证 ====');

  // ============================================================
  // Case 1：专属命中 + 通用未触发
  //   建「工商-上海」+ 在其下建 1 个 C1（BillType=A）+ 通用下另建 1 个 C1（BillType=A）
  //   构造 1 行 Channel='工商' 地区='上海' BillType='A' → 命中专属
  //   断言：modifiedRows 含 1 行 + _hitChannelKey=工商-上海 + _matchStatus=命中
  //         + _matchedChannelId=工商上海id + _hitScenarioId=专属场景id（不是通用）
  // ============================================================
  {
    const env = setupNS5Env();
    try {
      const gsChan = channelsRepo.createChannel(env.db, { name: '工商', ownerLocation: '上海' });
      const dedicatedId = insertScenario(env.db, {
        name: 'GS-SH-提取业务订单号', priority: 2, channelId: gsChan.id,
        conditionField: 'BillType', conditionValue: 'A', extractField: 'BizOrderId',
      });
      const generalId = insertScenario(env.db, {
        name: '通用-提取业务订单号', priority: 1, channelId: 1,
        conditionField: 'BillType', conditionValue: 'A', extractField: 'CustomerRef',
      });

      const scenarios = loadEnabledScenariosWithChannel(env.db);
      const bankRows = [
        { _rowId: 'R1', Channel: '工商', 地区: '上海', BillType: 'A', BizOrderId: 'BIZ-001', CustomerRef: 'CUST-001', ReconciliationId: '' },
      ];

      const result = runAllScenarios(bankRows, null, scenarios, { channelsRepo, db: env.db });

      assertEq(result.modifiedRows.length, 1, 'Case1.modifiedRows 1 行');
      assertEq(result.unmatchedRows.length, 0, 'Case1.unmatchedRows 0 行');
      assertEq(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length, 'Case1.完整性 mod+unmatched=total');
      const row = result.modifiedRows[0];
      assertEq(row._hitChannelKey, '工商-上海', 'Case1._hitChannelKey=工商-上海');
      assertEq(row._matchStatus, '命中', 'Case1._matchStatus=命中');
      assertEq(row._matchedChannelId, gsChan.id, 'Case1._matchedChannelId=工商上海id');
      assertEq(row._hitScenarioId, dedicatedId, 'Case1._hitScenarioId=专属id（不是通用）');
      assertTrue(row._hitScenarioId !== generalId, 'Case1.专属场景命中而非通用场景');
      assertEq(row._fallbackChannelId, null, 'Case1._fallbackChannelId=null（专属命中无 fallback）');
      // 副作用：ReconciliationId 应被覆盖为 BizOrderId 值（专属 extractField=BizOrderId）
      assertEq(row.ReconciliationId, 'BIZ-001', 'Case1.ReconciliationId=BizOrderId 值');
    } finally {
      cleanupEnv(env);
    }
  }

  // ============================================================
  // Case 2：专属未命中 → 通用兜底命中
  //   工商-上海 专属规则不命中（BillType=A）+ 通用规则命中（BillType=B）
  //   构造 1 行 Channel='工商' 地区='上海' BillType='B'
  //   断言：modifiedRows 含此行 + _matchStatus=命中 + _hitScenarioId=通用场景id
  // ============================================================
  {
    const env = setupNS5Env();
    try {
      const gsChan = channelsRepo.createChannel(env.db, { name: '工商', ownerLocation: '上海' });
      const dedicatedId = insertScenario(env.db, {
        name: 'GS-SH-A', priority: 2, channelId: gsChan.id,
        conditionField: 'BillType', conditionValue: 'A', extractField: 'BizOrderId',
      });
      const generalId = insertScenario(env.db, {
        name: '通用-B', priority: 1, channelId: 1,
        conditionField: 'BillType', conditionValue: 'B', extractField: 'CustomerRef',
      });

      const scenarios = loadEnabledScenariosWithChannel(env.db);
      const bankRows = [
        { _rowId: 'R1', Channel: '工商', 地区: '上海', BillType: 'B', BizOrderId: 'BIZ-002', CustomerRef: 'CUST-002', ReconciliationId: '' },
      ];

      const result = runAllScenarios(bankRows, null, scenarios, { channelsRepo, db: env.db });

      assertEq(result.modifiedRows.length, 1, 'Case2.modifiedRows 1 行');
      assertEq(result.unmatchedRows.length, 0, 'Case2.unmatchedRows 0 行');
      const row = result.modifiedRows[0];
      assertEq(row._hitChannelKey, '工商-上海', 'Case2._hitChannelKey=工商-上海');
      assertEq(row._matchStatus, '命中', 'Case2._matchStatus=命中（行匹配到了渠道）');
      assertEq(row._matchedChannelId, gsChan.id, 'Case2._matchedChannelId=工商上海id（行匹配渠道仍是专属）');
      assertEq(row._hitScenarioId, generalId, 'Case2._hitScenarioId=通用场景id（专属未命中走通用兜底）');
      assertTrue(row._hitScenarioId !== dedicatedId, 'Case2.专属场景未命中');
      // _fallbackChannelId 反映：行匹配的是专属但命中了通用 → 记录通用 id
      assertEq(row._fallbackChannelId, 1, 'Case2._fallbackChannelId=1（专属匹配但通用命中）');
      // 副作用：ReconciliationId = CustomerRef 值（通用 extractField=CustomerRef）
      assertEq(row.ReconciliationId, 'CUST-002', 'Case2.ReconciliationId=CustomerRef 值');
    } finally {
      cleanupEnv(env);
    }
  }

  // ============================================================
  // Case 3：未匹配渠道 → 通用兜底
  //   库内无招商-北京 + 通用规则命中
  //   构造 1 行 Channel='招商' 地区='北京' BillType='X'
  //   断言：_matchStatus='兜底' + _hitChannelKey=招商-北京（保留原值）
  //         + _matchedChannelId=null + _hitScenarioId=通用场景id
  // ============================================================
  {
    const env = setupNS5Env();
    try {
      const generalId = insertScenario(env.db, {
        name: '通用-X', priority: 1, channelId: 1,
        conditionField: 'BillType', conditionValue: 'X', extractField: 'CustomerRef',
      });

      const scenarios = loadEnabledScenariosWithChannel(env.db);
      const bankRows = [
        { _rowId: 'R1', Channel: '招商', 地区: '北京', BillType: 'X', BizOrderId: '', CustomerRef: 'CUST-X', ReconciliationId: '' },
      ];

      const result = runAllScenarios(bankRows, null, scenarios, { channelsRepo, db: env.db });

      assertEq(result.modifiedRows.length, 1, 'Case3.modifiedRows 1 行');
      const row = result.modifiedRows[0];
      assertEq(row._hitChannelKey, '招商-北京', 'Case3._hitChannelKey=招商-北京（保留原值）');
      assertEq(row._matchStatus, '兜底', 'Case3._matchStatus=兜底（行匹配不到渠道）');
      assertEq(row._matchedChannelId, null, 'Case3._matchedChannelId=null');
      assertEq(row._hitScenarioId, generalId, 'Case3._hitScenarioId=通用场景id');
      assertEq(row._fallbackChannelId, null, 'Case3._fallbackChannelId=null（matchedChannel 为空就不算 fallback，只是直接走通用）');
      assertEq(row.ReconciliationId, 'CUST-X', 'Case3.ReconciliationId=CustomerRef 值');
    } finally {
      cleanupEnv(env);
    }
  }

  // ============================================================
  // Case 4：全未命中 → 进 unmatchedRows
  //   构造 1 行所有规则都不命中（BillType=Z）+ 通用规则只命中 X
  //   断言：行进 unmatchedRows + 不进 modifiedRows + mod + unmatched = total
  // ============================================================
  {
    const env = setupNS5Env();
    try {
      const generalId = insertScenario(env.db, {
        name: '通用-X', priority: 1, channelId: 1,
        conditionField: 'BillType', conditionValue: 'X', extractField: 'CustomerRef',
      });

      const scenarios = loadEnabledScenariosWithChannel(env.db);
      const bankRows = [
        { _rowId: 'R1', Channel: '招商', 地区: '北京', BillType: 'Z', BizOrderId: '', CustomerRef: 'CUST-Z', ReconciliationId: '' },
      ];

      const result = runAllScenarios(bankRows, null, scenarios, { channelsRepo, db: env.db });

      assertEq(result.modifiedRows.length, 0, 'Case4.modifiedRows 0 行');
      assertEq(result.unmatchedRows.length, 1, 'Case4.unmatchedRows 1 行');
      assertEq(result.modifiedRows.length + result.unmatchedRows.length, bankRows.length, 'Case4.完整性 mod+unmatched=total');
      const row = result.unmatchedRows[0];
      assertEq(row._hitChannelKey, '招商-北京', 'Case4.unmatched._hitChannelKey=招商-北京');
      assertEq(row._matchStatus, '兜底', 'Case4.unmatched._matchStatus=兜底（行无匹配渠道）');
      assertEq(row._matchedChannelId, null, 'Case4.unmatched._matchedChannelId=null');
      // unmatched 行不应有 _hitScenarioId
      assertEq(row._hitScenarioId, undefined, 'Case4.unmatched 行无 _hitScenarioId');
      // 原始字段保留
      assertEq(row.BillType, 'Z', 'Case4.unmatched 原始字段 BillType 保留');
      assertEq(row.ReconciliationId, '', 'Case4.unmatched ReconciliationId 不被覆盖');
    } finally {
      cleanupEnv(env);
    }
  }

  // ============================================================
  // Case 5：独立报表写入 — 3 行 mixed（专属命中 / 通用兜底 / 全未命中）→ dispatcher → writer → readback
  //   v2.1.9 D16=b（2026-05-27 用户拍板）：「匹配渠道」列改用 _hitChannelId 反查 channels.label
  //     - 行 1（专属命中）：匹配渠道 = '工商-上海'（专属 channel label）
  //     - 行 2（兜底通用）：匹配渠道 = '通用'（命中通用 → label='通用'，不是原始 '招商-北京'）
  //   验证：
  //     - 文件落 opts.reportDir / 命名 `命中场景行-{basename}-{timestamp}.xlsx`
  //     - Sheet 名「命中场景行」+ 列数 = headers + 3
  //     - 行 1：匹配渠道='工商-上海' / 匹配状态='命中' / 命中场景=`[N] 名`
  //     - 行 2：匹配渠道='通用' / 匹配状态='兜底' / 命中场景=`[N] 通用名`
  //     - unmatched 行不写本报表
  // ============================================================
  {
    const env = setupNS5Env();
    const reportDir = path.join(env.tmpdir, 'reports');
    try {
      const gsChan = channelsRepo.createChannel(env.db, { name: '工商', ownerLocation: '上海' });
      const dedicatedId = insertScenario(env.db, {
        name: 'GS-SH-A', priority: 2, channelId: gsChan.id,
        conditionField: 'BillType', conditionValue: 'A', extractField: 'BizOrderId',
      });
      const generalId = insertScenario(env.db, {
        name: '通用-X', priority: 1, channelId: 1,
        conditionField: 'BillType', conditionValue: 'X', extractField: 'CustomerRef',
      });

      const scenarios = loadEnabledScenariosWithChannel(env.db);
      const headers = ['Channel', '地区', 'BillType', 'BizOrderId', 'CustomerRef', 'ReconciliationId'];
      const bankRows = [
        { _rowId: 'R1', Channel: '工商', 地区: '上海', BillType: 'A', BizOrderId: 'BIZ-001', CustomerRef: '', ReconciliationId: '' },
        { _rowId: 'R2', Channel: '招商', 地区: '北京', BillType: 'X', BizOrderId: '', CustomerRef: 'CUST-X', ReconciliationId: '' },
        { _rowId: 'R3', Channel: '建行', 地区: '深圳', BillType: 'Z', BizOrderId: '', CustomerRef: '', ReconciliationId: '' },
      ];

      const result = runAllScenarios(bankRows, null, scenarios, { channelsRepo, db: env.db });
      assertEq(result.modifiedRows.length, 2, 'Case5.modifiedRows 2 行（R1+R2）');
      assertEq(result.unmatchedRows.length, 1, 'Case5.unmatchedRows 1 行（R3）');

      // v2.1.9 D16=b：验证 dispatcher 写入 _hitChannelId
      const r1Modified = result.modifiedRows.find((r) => r._rowId === 'R1');
      const r2Modified = result.modifiedRows.find((r) => r._rowId === 'R2');
      assertEq(r1Modified._hitChannelId, gsChan.id, 'Case5.R1._hitChannelId=专属（工商-上海）');
      assertEq(r2Modified._hitChannelId, 1, 'Case5.R2._hitChannelId=通用（兜底命中）');

      // 找到 displayIndex 用于断言文案
      const dedicatedScenario = scenarios.find((s) => s.id === dedicatedId);
      const generalScenario = scenarios.find((s) => s.id === generalId);
      const dedicatedDi = dedicatedScenario.displayIndex;
      const generalDi = generalScenario.displayIndex;

      // 跑 writer — 传 channels 启用 D16=b 渠道 label 反查
      const channelsList = channelsRepo.listChannels(env.db);
      const wr = await writeScenarioHitRows(
        result.modifiedRows,
        '/tmp/银行对账单-2026-05.xlsx',
        { reportDir, timestamp: '20260527T120000', headers, channels: channelsList }
      );
      assertEq(wr.status, 'ok', 'Case5.writer status=ok');
      assertEq(wr.rowCount, 2, 'Case5.writer rowCount=2');
      assertEq(wr.fileName, '命中场景行-银行对账单-2026-05-20260527T120000.xlsx', 'Case5.writer fileName 规范');
      assertTrue(fs.existsSync(wr.filePath), 'Case5.独立报表文件存在');
      assertTrue(wr.filePath.startsWith(reportDir), 'Case5.文件落在 opts.reportDir');

      // readback
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(wr.filePath);
      const sheetNames = wb.worksheets.map((s) => s.name);
      assertEq(sheetNames, [REPORT_SHEET_NAME], 'Case5.Sheet 名 = 命中场景行');
      const sheet = wb.getWorksheet(REPORT_SHEET_NAME);
      // 列数 = headers + 3
      assertEq(sheet.columnCount, headers.length + 3, `Case5.列数=${headers.length}+3`);
      // 表头最后 3 列
      const lastBase = headers.length;
      assertEq(sheet.getRow(1).getCell(lastBase + 1).value, '匹配渠道', 'Case5.列 N+1=匹配渠道');
      assertEq(sheet.getRow(1).getCell(lastBase + 2).value, '匹配状态', 'Case5.列 N+2=匹配状态');
      assertEq(sheet.getRow(1).getCell(lastBase + 3).value, '命中场景', 'Case5.列 N+3=命中场景');

      // 行 2（excel 1-based，row 1 是表头；R1 在数据行 1 = sheet row 2）
      // 由于 modifiedRows 顺序按 dispatcher 处理顺序（保留 bankRows 顺序），R1 是 modifiedRows[0]
      // v2.1.9 D16=b：R1 命中专属 → 匹配渠道='工商-上海'
      const row2 = sheet.getRow(2);
      assertEq(row2.getCell(lastBase + 1).value, '工商-上海', 'Case5.row2 匹配渠道=工商-上海（专属 label）');
      assertEq(row2.getCell(lastBase + 2).value, '命中', 'Case5.row2 匹配状态=命中');
      assertEq(row2.getCell(lastBase + 3).value, `[${dedicatedDi}] GS-SH-A`, `Case5.row2 命中场景=[${dedicatedDi}] GS-SH-A`);

      // 行 3 = R2 (兜底命中通用)
      // v2.1.9 D16=b：R2 实际命中通用 → 匹配渠道='通用'（不是原始 '招商-北京'）
      const row3 = sheet.getRow(3);
      assertEq(row3.getCell(lastBase + 1).value, '通用', 'Case5.row3 匹配渠道=通用（兜底命中通用 label）');
      assertEq(row3.getCell(lastBase + 2).value, '兜底', 'Case5.row3 匹配状态=兜底');
      assertEq(row3.getCell(lastBase + 3).value, `[${generalDi}] 通用-X`, `Case5.row3 命中场景=[${generalDi}] 通用-X`);

      // R3（unmatched）不应在报表里
      // 报表行数 = 1 表头 + 2 modified = 3
      assertEq(sheet.rowCount, 3, 'Case5.报表 rowCount=3（1 表头 + 2 命中）');

      // SUFFIX_HEADERS 常量保护
      assertEq(SUFFIX_HEADERS, ['匹配渠道', '匹配状态', '命中场景'], 'Case5.SUFFIX_HEADERS 序');

      // 内部 _ 前缀字段不泄漏
      const headerVals = sheet.getRow(1).values.slice(1);
      const leaks = headerVals.filter((h) => typeof h === 'string' && h.startsWith('_'));
      assertEq(leaks.length, 0, 'Case5.无 _ 前缀内部字段泄漏');

      // tmp 文件原子写无残留
      assertTrue(!fs.existsSync(`${wr.filePath}.tmp`), 'Case5.atomic write tmp 已清理');
    } finally {
      cleanupEnv(env);
    }
  }

  // ============================================================
  // Case 6：first-match-wins 不变量 — 1 行同时满足专属 + 通用 2 个场景
  //   只命中专属（priority 高的 / 阶段 A 优先），不会双重命中 + scenarios 数组只含 1 项
  //   断言：stats.hitScenarios 含 1 项 = 专属场景；modifications 同一行只发生 1 次
  // ============================================================
  {
    const env = setupNS5Env();
    try {
      const gsChan = channelsRepo.createChannel(env.db, { name: '工商', ownerLocation: '上海' });
      // 专属：BillType=A → ReconciliationId 写 BizOrderId
      const dedicatedId = insertScenario(env.db, {
        name: 'GS-SH-A', priority: 2, channelId: gsChan.id,
        conditionField: 'BillType', conditionValue: 'A', extractField: 'BizOrderId',
      });
      // 通用：BillType=A → ReconciliationId 写 CustomerRef
      const generalId = insertScenario(env.db, {
        name: '通用-A', priority: 3, channelId: 1,  // 通用 priority 更高（验证阶段 A 优先而非全局 priority 优先）
        conditionField: 'BillType', conditionValue: 'A', extractField: 'CustomerRef',
      });

      const scenarios = loadEnabledScenariosWithChannel(env.db);
      const bankRows = [
        { _rowId: 'R1', Channel: '工商', 地区: '上海', BillType: 'A', BizOrderId: 'BIZ-001', CustomerRef: 'CUST-001', ReconciliationId: '' },
      ];

      const result = runAllScenarios(bankRows, null, scenarios, { channelsRepo, db: env.db });

      assertEq(result.modifiedRows.length, 1, 'Case6.modifiedRows 1 行（不重复）');
      assertEq(result.stats.hitScenarios.length, 1, 'Case6.stats.hitScenarios 仅 1 个场景');
      assertEq(result.stats.hitScenarios[0].id, dedicatedId, 'Case6.命中专属（阶段 A 优先）');
      // ReconciliationId 是专属 extractField=BizOrderId（不是通用 CustomerRef）
      assertEq(result.modifiedRows[0].ReconciliationId, 'BIZ-001', 'Case6.ReconciliationId 由专属场景写入');
      // 该行仅 1 次修改（不会被通用再覆盖一次）
      const r1Mods = result.modifications.filter((m) => m.rowId === 'R1');
      assertEq(r1Mods.length, 1, 'Case6.R1 仅 1 次 modification');
      assertEq(r1Mods[0].scenarioId, dedicatedId, 'Case6.R1 modification 来源=专属场景');
      // 通用场景的 id 不出现在 hitScenarios
      assertTrue(!result.stats.hitScenarios.some((s) => s.id === generalId), 'Case6.通用场景未命中');
      // 行 metadata 反映专属命中
      assertEq(result.modifiedRows[0]._hitScenarioId, dedicatedId, 'Case6._hitScenarioId=专属');
      assertEq(result.modifiedRows[0]._fallbackChannelId, null, 'Case6._fallbackChannelId=null（专属命中无 fallback）');
    } finally {
      cleanupEnv(env);
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
