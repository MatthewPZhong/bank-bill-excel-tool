const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureAccountMappingCurrencySupport,
  ensureAccountMappingTemplateSupport,
  ensureAcquiringBillCurrencyTablesSupport,
  // v3.0.3 PR-B（acquiring-import-recon-perf P0-3）：收单两表索引瘦身 + covering 升级（老库迁移）
  ensureAcquiringBillCurrencyIndexSlimV2,
  ensureAmountSplitRulesSupport,
  ensureBankBuReconTablesSupport,
  // v2.1.12 需求1 T-vcc-1：VCC业务OP计算模块 2 张表 + 2 索引
  ensureVccOpCalcTablesSupport,
  ensureBillSplitMergeSupport,
  ensureBillSplitTargetSeqSupport,
  ensureParentTemplateSupport,
  ensureScenariosSupport,
  ensureScenariosCategoryReconIdFix,
  ensureScenariosCategoryGatewayReconIdFix,
  migrateGatewayReconIdFixFieldPairs,
  migrateC4ReconGroupsStructure,
  migrateC4ReconGroupsAmountLockedFieldPair,
  ensureC3GwFieldCurrencyCaseFix,
  ensureC3AssignAddMode,
  ensureAcquiringBillCurrencyRunsCleanupPending,
  ensureAcquiringBillIdleCleanupMinutesSetting,
  // v2.1.10 A4 T18 / T19：chunked 分批 size settings + runs.chunk_progress 列
  ensureAcquiringBillChunkSizeSetting,
  // v2.1.12 β.1-T3：多 worker write-splitting worker 数 settings seed（D29/D33）
  ensureAcquiringBillWorkerCountSetting,
  ensureAcquiringBillCurrencyRunsChunkProgress,
  // v2.1.10 N4-cont-1 T22 (Phase 4)：raw_json idle 自动清理保留窗口 settings
  ensureAcquiringBillCurrencyRawJsonRetentionSettings,
  ensureBillRawJsonV2Slim,
  ensureSchemaV2_1_9_N5,
  ensureScenariosNameUniqueByChannelId,
  // v2.1.13 D-3/D-4：自带写死场景 builtin-fixed 数据层迁移
  ensureScenariosCategoryBuiltinFixed,
  ensureBuiltinFixedScenarioNameUpdate,
  ensureBuiltinFixedScenarioMigration,
  ensureScenarioApplicableChannelsTable,
  // v2.1.16-beta.2 §8：5 轮对账 R4/R5 内置场景 seed（5 R4 + 2 R5）
  ensureReconRoundBuiltinScenariosSeed,
  // v2.1.16-beta.4 ③：中台退款订单回填场景独立补种（默认休眠 enabled=0）
  ensureRefundBackfillScenarioSeed,
  // v2.1.16-beta.5 需求4：JPM 调拨订单修复写死场景独立补种（默认休眠 enabled=0，category=gateway-recon-id-fix）
  ensureJpmDispatchOrderScenarioSeed,
  // v2.1.16-beta.2 §FundType：一次性修存量 config 错拼 'Ach Ruturn' → 'Ach Return'
  ensureFundTypeAchReturnConfigMigration,
  // v2.1.10 N4-cont-2 T30：diff_rows FK ON DELETE CASCADE 改造
  ensureDiffRowsCascadeMigration_v2_1_10,
  // v2.1.16 阶段一 A3：链接表持久化建表（v2.1.16-beta.3 ②：含入金表 linked_bank_deposit）
  ensureLinkedTableSupport,
  // v2.1.16-beta.5 需求3：ADM 银行对账单隐藏表建表（独立幂等迁移）
  ensureAdmBankDepositSupport,
  // v3.0.4 块 E 需求2：BOC 链接表两张隐藏表建表（独立幂等迁移；不进 ALL_TABLE_KEYS）
  ensureBocFxLinkSupport,
  // v2.1.16-beta.3 ①：Channel 枚举字典表建表
  ensureChannelEnumSupport,
  ensureBuiltinScenarioNamesUpdate,
  ensureTemplateBigAccountNatureSupport,
  ensureTemplateDateFormatSupport,
  ensureTemplateFilenameFixedFieldSupport,
  ensureTemplateKeySupport,
  ensureTemplateMappingEnhancements,
  hasColumn
} = require('./database/migrations');
const { ensureBizOpReconTablesSupport } = require('./biz-op-recon-db/migrations');
const scenariosRepository = require('./database/scenarios-repository');
const settingsRepository = require('./database/settings-repository');
const templateRepository = require('./database/template-repository');
const channelsRepository = require('./database/channels-repository');
// v2.1.16 阶段一 A3：链接表持久化仓储
const linkedTableRepository = require('./database/linked-table-repository');
// v2.1.16-beta.3 ①：Channel 枚举字典仓储
const channelEnumRepository = require('./database/channel-enum-repository');
const { createBackup: createBackupImpl } = require('./database/backup');
// v2.1.9 SR-log-1 (T32h)：替换 console.error → appendModuleLog 双写
const { appendModuleLog } = require('./logger');

class AppDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  init() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA foreign_keys = ON;');
    // v2.1.7 F7-A1：全局 SQL 调优（影响 bank-bu-recon / biz-op-recon / acquiring-bill-currency 三套业务引擎）
    //   PRAGMA 顺序固定：foreign_keys → journal_mode(WAL) → synchronous(NORMAL) → cache_size → mmap_size → temp_store
    //   ⚠️ synchronous=NORMAL 必须在 WAL 之后（DELETE/FULL 模式下 NORMAL 不安全；spec §7.3 关键不变量）
    //   journal_mode=WAL 持久化在 DB 元数据，首次启动后即生效；产生 *.sqlite-wal + *.sqlite-shm 旁文件（用户备份提示见 USER_GUIDE §DB 备份）
    this.db.exec('PRAGMA journal_mode = WAL;');        // 读写并发更好；崩溃恢复保留
    this.db.exec('PRAGMA synchronous = NORMAL;');      // WAL 下安全 + 性能 2-3 倍
    this.db.exec('PRAGMA cache_size = -65536;');       // 64MB 页缓存（负数 = KB；-65536 = 64MB）
    this.db.exec('PRAGMA mmap_size = 268435456;');     // 256MB 内存映射（64-bit 环境）
    this.db.exec('PRAGMA temp_store = MEMORY;');       // v3.0.3 PR-C（W1）：临时表/排序驻内存，避开 Windows %TEMP% 落盘 + Defender 过滤链（4 处 PRAGMA 同步，加在 mmap_size 之后）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_key TEXT,
        name TEXT NOT NULL UNIQUE,
        source_file_name TEXT NOT NULL,
        headers_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS template_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        template_field TEXT NOT NULL,
        mapped_field TEXT NOT NULL,
        mapped_fields_json TEXT NOT NULL DEFAULT '[]',
        row_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
        UNIQUE(template_id, row_index)
      );

      CREATE TABLE IF NOT EXISTS template_big_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        merchant_id TEXT NOT NULL,
        currency TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        account_nature TEXT NOT NULL DEFAULT 'client',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
        UNIQUE(template_id, merchant_id, currency)
      );

      CREATE TABLE IF NOT EXISTS template_fixed_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id INTEGER NOT NULL,
        merchant_id TEXT NOT NULL,
        currency TEXT NOT NULL,
        row_index INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
        UNIQUE(template_id, row_index)
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bank_account_id TEXT NOT NULL UNIQUE,
        clearing_account_id TEXT NOT NULL,
        no_currency INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT '',
        row_index INTEGER NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.ensureTemplateKeySupport();
    this.ensureTemplateMappingEnhancements();
    this.ensureAccountMappingCurrencySupport();
    this.ensureTemplateDateFormatSupport();
    this.ensureAmountSplitRulesSupport();
    this.ensureBillSplitMergeSupport();
    this.ensureBillSplitTargetSeqSupport();
    this.ensureParentTemplateSupport();
    this.ensureTemplateFilenameFixedFieldSupport();
    this.ensureAccountMappingTemplateSupport();
    this.ensureTemplateBigAccountNatureSupport();
    this.ensureScenariosSupport();
    // v2.1.0-beta.1 PR-A：扩 CHECK 约束到 4 值（含 'recon-id-fix'）
    // 必须在 ensureScenariosSupport 之后；幂等检查 sqlite_master.sql 含 'recon-id-fix' → no-op
    this.ensureScenariosCategoryReconIdFix();
    // v2.1.0-beta.3：扩 CHECK 约束到 5 值（含 'gateway-recon-id-fix'）
    // 必须在 ensureScenariosCategoryReconIdFix 之后；幂等检查 sqlite_master.sql 含 'gateway-recon-id-fix' → no-op
    this.ensureScenariosCategoryGatewayReconIdFix();
    // v2.1.0-beta.3 PR #39 self-review P1-1：修复 v2.1.0-beta.3 早期测试期创建的 gateway 场景
    // fieldPairs locked 行 rightField='Amount' → 'receiveAmount'（dialog 已修但 DB 旧数据需迁移）
    // 必须在 ensureScenariosCategoryGatewayReconIdFix 之后；幂等：rightField 已是 receiveAmount → no-op
    this.migrateGatewayReconIdFixFieldPairs();
    // v2.1.0-beta.1 PR-B（Q1=B 决策回写，2026-04-30）：把 C4 类 config_json 老 reconFields[]
    // 结构迁移成 reconGroups[]（详见 migrations.js: migrateC4ReconGroupsStructure）。
    // 必须在 ensureScenariosCategoryReconIdFix 之后（依赖 CHECK 已扩到 4 值）。
    this.migrateC4ReconGroupsStructure();
    // v2.1.0-beta.1 PR-B Round 3（Decision 4 回写，2026-05-09）：给 C4 reconGroups 强制带 Amount 锁定字段对
    // 必须在 migrateC4ReconGroupsStructure 之后（依赖 reconGroups 结构已就位）。
    this.migrateC4ReconGroupsAmountLockedFieldPair();
    this.ensureC3GwFieldCurrencyCaseFix();
    // v2.1.8 N2：给 'gateway-recon-join' assign 对象补 mode='direct' + customValue=''
    //   必须在 ensureC3GwFieldCurrencyCaseFix 之后（先修 currency 大小写再扩字段，互不影响）
    this.ensureC3AssignAddMode();
    this.ensureBuiltinScenarioNamesUpdate();
    // v2.1.9 N5：channels 表 + scenarios.channel_id FK + backfill 到「通用」
    //   🔴 资金红线 + 破坏性 schema 变更（不可逆）；首次启动自动备份 DB 到 <dbDir>/backups/
    //   幂等：app_settings.n5_channels_migrated = 'true' 跳过
    //   必须在 ensureScenariosSupport 系列之后（依赖 scenarios 表已存在）
    //   失败处理：参考 ensureBillRawJsonV2Slim — try-catch + console.log 输出状态（启动不阻塞，下次重试）
    try {
      const n5Result = this.ensureSchemaV2_1_9_N5();
      if (n5Result && n5Result.status === 'migrated') {
        // v2.1.9 SR-log-1：替换 console.log → 日志上报（info 级别 — migration 成功审计）
        appendModuleLog({
          level: 'info',
          source: 'main',
          domain: 'migration',
          message: '[migration N5] channels 表 + scenarios.channel_id 已建',
          details: [
            `backup=${n5Result.backupPath || '(none)'}`,
            `columnAdded=${n5Result.columnAdded}`
          ]
        });
      } else if (n5Result && n5Result.status === 'backup-failed') {
        // v2.1.9 SR-log-1：替换 console.error → 日志上报
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'migration',
          message: '[migration N5] 备份失败，schema 未改动，下次启动重试',
          details: [n5Result.error && n5Result.error.message ? n5Result.error.message : String(n5Result.error)],
          stack: n5Result.error && n5Result.error.stack ? n5Result.error.stack : undefined
        });
      } else if (n5Result && n5Result.status === 'migration-failed') {
        // v2.1.9 SR-log-1：替换 console.error → 日志上报
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'migration',
          message: '[migration N5] 事务失败已回滚',
          details: [
            `备份保留: ${n5Result.backupPath || '(none)'}`,
            n5Result.error && n5Result.error.message ? n5Result.error.message : String(n5Result.error)
          ],
          stack: n5Result.error && n5Result.error.stack ? n5Result.error.stack : undefined
        });
      }
    } catch (n5Err) {
      // v2.1.9 SR-log-1：替换 console.error → 日志上报
      appendModuleLog({
        level: 'error',
        source: 'main',
        domain: 'migration',
        message: '[migration N5] unexpected failure (启动不阻塞，下次启动重试)',
        details: [n5Err && n5Err.message ? n5Err.message : String(n5Err)],
        stack: n5Err && n5Err.stack ? n5Err.stack : undefined
      });
    }
    // v2.1.9 SR-FIX-1 (spec §16.3 🔴 资金红线 + 破坏性 schema 变更)：
    //   scenarios.name UNIQUE 全表 → (channel_id, name) 复合 UNIQUE
    //   必须在 ensureSchemaV2_1_9_N5 之后（依赖 scenarios.channel_id 列 + backfill 全部完成）
    //   幂等：app_settings.n5_scenarios_unique_migrated='true' 跳过
    //   失败处理：try-catch + 日志上报；启动不阻塞，下次重试
    try {
      const uniqueResult = this.ensureScenariosNameUniqueByChannelId();
      if (uniqueResult && uniqueResult.status === 'migrated') {
        appendModuleLog({
          level: 'info',
          source: 'main',
          domain: 'migration',
          message: '[migration SR-FIX-1] scenarios.name UNIQUE 已切换到 (channel_id, name) 复合',
          details: [`backup=${uniqueResult.backupPath || '(none)'}`]
        });
      } else if (uniqueResult && uniqueResult.status === 'backup-failed') {
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'migration',
          message: '[migration SR-FIX-1] 备份失败，schema 未改动，下次启动重试',
          details: [uniqueResult.error || '(no error message)']
        });
      } else if (uniqueResult && uniqueResult.status === 'conflict-detected') {
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'migration',
          message: '[migration SR-FIX-1] 同 channel_id 下重名冲突（理论不应发生），需用户介入',
          details: [
            `备份保留: ${uniqueResult.backupPath || '(none)'}`,
            uniqueResult.error || '(no error message)'
          ]
        });
      } else if (uniqueResult && uniqueResult.status === 'migration-failed') {
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'migration',
          message: '[migration SR-FIX-1] 事务失败已回滚',
          details: [
            `备份保留: ${uniqueResult.backupPath || '(none)'}`,
            uniqueResult.error || '(no error message)'
          ]
        });
      }
    } catch (uniqueErr) {
      appendModuleLog({
        level: 'error',
        source: 'main',
        domain: 'migration',
        message: '[migration SR-FIX-1] unexpected failure (启动不阻塞，下次启动重试)',
        details: [uniqueErr && uniqueErr.message ? uniqueErr.message : String(uniqueErr)],
        stack: uniqueErr && uniqueErr.stack ? uniqueErr.stack : undefined
      });
    }
    // v2.1.13 D-3/D-4：自带写死场景（builtin-fixed）数据层迁移
    //   1) 扩 category CHECK 5→6 值（含 'builtin-fixed'；重建表保留 channel_id + 复合 UNIQUE）
    //      必须在 ensureScenariosNameUniqueByChannelId（SR-FIX-1）之后 —— 依赖最终态表结构
    //   2) 内置提取场景归类为 builtin-fixed / priority 0（依赖 1 的 CHECK 已扩）
    //   3) 场景-渠道多对多关联表（依赖 channels 表 + scenarios 重建已完成）
    this.ensureScenariosCategoryBuiltinFixed();
    this.ensureBuiltinFixedScenarioNameUpdate();
    this.ensureBuiltinFixedScenarioMigration();
    this.ensureScenarioApplicableChannelsTable();
    // v2.1.16-beta.2 §8：5 轮对账 R4/R5 内置场景 seed（5 R4 + 2 R5，🔴 资金红线）
    //   必须在 ensureScenariosCategoryBuiltinFixed 之后（依赖 category CHECK 已扩到含 'builtin-fixed'）。
    //   幂等：凭 is_builtin + builtin-fixed + config.subCategory 定位，已存在跳过不覆盖；
    //         marker(recon_round_builtin_scenarios_seeded) 保证删除终态不复活。
    this.ensureReconRoundBuiltinScenariosSeed();
    // v2.1.16-beta.4 ③：中台退款订单回填场景独立补种（默认休眠 enabled=0，🔴 资金红线）
    //   独立 marker(refund_backfill_scenario_seeded) 绕开全局 marker 短路 —— 旧库已 seed 既有 7 条且
    //   recon_round_builtin_scenarios_seeded=true 时本函数仍能补种退款场景；新库走幂等定位为已存在跳过。
    //   必须在 ensureReconRoundBuiltinScenariosSeed 之后（同前置：CHECK 已扩到含 'builtin-fixed'）。
    this.ensureRefundBackfillScenarioSeed();
    // v2.1.16-beta.5 需求4：JPM 调拨订单修复写死场景独立补种（默认休眠 enabled=0，🔴 资金红线）
    //   前置：scenarios CHECK 已含 'gateway-recon-id-fix'（ensureScenariosCategoryGatewayReconIdFix 早已扩枚举）。
    //   独立 marker(jpm_dispatch_order_scenario_seeded) 绕开全局 marker 短路 —— 旧库也能补种。
    this.ensureJpmDispatchOrderScenarioSeed();
    // v2.1.16-beta.2 §FundType：一次性修存量 config 错拼 'Ach Ruturn' → 'Ach Return'（🔴 资金红线 — FundType 枚举值）
    //   必须在 scenarios 相关迁移之后（依赖 scenarios 表已存在、内置场景已 seed）。
    //   幂等：执行一次后 config 不再含 'Ach Ruturn'；绝大多数库无引用 → no-op（精确性防护）。
    this.ensureFundTypeAchReturnConfigMigration();
    // v2.1.2 T2：月度银行对账单BU回填校验模块 3 张表
    // 与其他迁移完全独立，调用顺序无依赖；放在最末尾即可
    this.ensureBankBuReconTablesSupport();
    // v2.1.12 需求1 T-vcc-1：VCC业务OP计算模块 2 张表 + 2 索引（与现有 5 模块表完全隔离，调用顺序无依赖）
    this.ensureVccOpCalcTablesSupport();
    // v2.1.3 T1：业务OP数据核对模块 4 张表（imports / flow_imports / runs / diff_rows）
    // 与 v2.1.2 bank_bu_recon_* 完全独立，调用顺序无依赖
    this.ensureBizOpReconTablesSupport();
    // v2.1.6 T4：收单单据币种校验模块 4 张表（flow_imports / bill_imports / runs / diff_rows）
    // 与 v2.1.2/v2.1.3 完全独立，调用顺序无依赖
    this.ensureAcquiringBillCurrencyTablesSupport();
    // v3.0.3 PR-B（P0-3）：收单两表旧 4 索引 → 2 covering（老库就地迁移；新库建表段已直接建 v2，
    //   本函数幂等 no-op）。必须在 ensureAcquiringBillCurrencyTablesSupport 之后（依赖两表已存在）。
    this.ensureAcquiringBillCurrencyIndexSlimV2();
    // v2.1.8 N1：给 acquiring_bill_currency_runs 加 cleanup_pending 列（β 方案：cleanup 移出对账链路）
    //   必须在 ensureAcquiringBillCurrencyTablesSupport 之后（依赖 runs 表已存在）
    this.ensureAcquiringBillCurrencyRunsCleanupPending();
    // v2.1.9 N1-settings (T32b)：idle cleanup 阈值 settings 化（seed default=30）
    //   依赖 app_settings 表存在（启动 init 时第一段 CREATE TABLE IF NOT EXISTS 已建）
    //   幂等：INSERT OR IGNORE → 用户已改值不被覆盖
    this.ensureAcquiringBillIdleCleanupMinutesSetting();
    // v2.1.10 A4 T18：chunked 分批 size settings（seed default=100000）
    //   同 N1-settings 范式：依赖 app_settings 表 + INSERT OR IGNORE 不覆盖用户已改
    this.ensureAcquiringBillChunkSizeSetting();
    // v2.1.12 β.1-T3：多 worker write-splitting worker 数 settings（seed default=2 — D33 OOM 兜底）
    //   同 A4 T18 范式：依赖 app_settings 表 + INSERT OR IGNORE 不覆盖用户已改
    this.ensureAcquiringBillWorkerCountSetting();
    // v2.1.10 N4-cont-1 T22 (Phase 4)：raw_json idle 自动清理保留窗口 settings（seed default=7 天）
    //   同 N1-settings + A4 T18 范式：依赖 app_settings 表 + INSERT OR IGNORE 不覆盖用户已改
    //   spec §八.3：与 N4-cont-2 顺序无关；任意顺序都不冲突（settings 与 schema 互不影响）
    this.ensureAcquiringBillCurrencyRawJsonRetentionSettings();
    // v2.1.10 A4 T19：runs.chunk_progress 列（chunked 进度 JSON 序列化）
    //   必须在 ensureAcquiringBillCurrencyRunsCleanupPending 之后（依赖 runs 表 + 列扩展顺序）
    //   幂等：hasColumn 检查避免重复 ADD COLUMN
    this.ensureAcquiringBillCurrencyRunsChunkProgress();
    // v2.1.8 N4：差异表瘦身 — bill_imports.raw_json 一次性 rewrite 仅保留 9 模版字段
    //   🔴 资金红线 + 破坏性 migration；首次启动自动备份 DB 到 <dbDir>/backups/
    //   幂等：app_settings.acquiring_bill_raw_json_v2_migrated = 'true' 跳过
    //   必须在 ensureAcquiringBillCurrencyTablesSupport 之后（依赖 bill_imports 表已存在）
    try {
      const result = this.ensureBillRawJsonV2Slim();
      // 仅在实际改了数据时打日志（'migrated-empty' = 空表首次启动，无业务意义不打）
      if (result && result.status === 'migrated') {
        // v2.1.9 SR-log-1：替换 console.log → 日志上报
        appendModuleLog({
          level: 'info',
          source: 'main',
          domain: 'migration',
          message: '[migration N4] bill_imports.raw_json slim done',
          details: [
            `rows=${result.rowsAffected}`,
            `backup=${result.backupPath || '(none)'}`
          ]
        });
      } else if (result && result.status === 'backup-failed') {
        // v2.1.9 SR-log-1：替换 console.error → 日志上报
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'migration',
          message: '[migration N4] backup failed, migration aborted, will retry next launch',
          details: [result.error && result.error.message ? result.error.message : String(result.error)],
          stack: result.error && result.error.stack ? result.error.stack : undefined
        });
      } else if (result && result.status === 'batch-failed') {
        // v2.1.9 SR-log-1：替换 console.error → 日志上报
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'migration',
          message: `[migration N4] batch rewrite failed at row ${result.totalRewritten}`,
          details: [result.error && result.error.message ? result.error.message : String(result.error)],
          stack: result.error && result.error.stack ? result.error.stack : undefined
        });
      }
    } catch (n4Err) {
      // v2.1.9 SR-log-1：替换 console.error → 日志上报
      appendModuleLog({
        level: 'error',
        source: 'main',
        domain: 'migration',
        message: '[migration N4] unexpected failure (启动不阻塞，下次启动重试)',
        details: [n4Err && n4Err.message ? n4Err.message : String(n4Err)],
        stack: n4Err && n4Err.stack ? n4Err.stack : undefined
      });
    }
    // v2.1.10 N4-cont-2 T30：diff_rows FK ON DELETE CASCADE 改造（🔴 资金红线 + 不可逆 DB schema）
    //   必须在 ensureAcquiringBillCurrencyTablesSupport 之后（依赖 diff_rows / runs / bill_imports 表已存在）
    //   也必须在 ensureBillRawJsonV2Slim (v2.1.8 N4) 之后（避免 N4 重写 raw_json 期间 schema 改动冲突）
    //   N4-cont-1 settings (上面 ensureAcquiringBillCurrencyRawJsonRetentionSettings) 与本 migration 顺序无关
    //   （spec §八.3：settings INSERT OR IGNORE 与 schema rebuild 互不影响；固定为 settings 在前便于排查）
    //   失败处理：try-catch + 4 status 分别日志上报；启动不阻塞，下次重试（参考 v2.1.9 N5 范式）
    try {
      const n4Cont2Result = this.ensureDiffRowsCascadeMigration_v2_1_10();
      if (n4Cont2Result && n4Cont2Result.status === 'migrated') {
        appendModuleLog({
          level: 'info',
          source: 'main',
          domain: 'migration',
          message: '[migration N4-cont-2] diff_rows FK 已加 ON DELETE CASCADE',
          details: [
            `backup=${n4Cont2Result.backupPath || '(none)'}`,
            `rowsMigrated=${n4Cont2Result.rowsAffected}`,
            `statusReached=${n4Cont2Result.statusReached}`
          ]
        });
      } else if (n4Cont2Result && n4Cont2Result.status === 'backup-failed') {
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'migration',
          message: '[migration N4-cont-2] 备份失败，schema 未改动，下次启动重试',
          details: [n4Cont2Result.error || '(no error message)']
        });
      } else if (n4Cont2Result && n4Cont2Result.status === 'conflict-detected') {
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'migration',
          message: '[migration N4-cont-2] 行数对账失败 (rebuild new ≠ old)，需用户介入',
          details: [
            `备份保留: ${n4Cont2Result.backupPath || '(none)'}`,
            n4Cont2Result.error || '(no error message)'
          ]
        });
      } else if (n4Cont2Result && n4Cont2Result.status === 'migration-failed') {
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'migration',
          message: '[migration N4-cont-2] 事务失败已回滚',
          details: [
            `备份保留: ${n4Cont2Result.backupPath || '(none)'}`,
            `statusReached: ${n4Cont2Result.statusReached || '(none)'}`,
            n4Cont2Result.error || '(no error message)'
          ]
        });
      }
      // skipped / skipped-no-table / skipped-already-cascaded / skipped-no-flag-table：静默
      //   - skipped 是稳态正常路径（每次启动重复触达 → 不打 log 防噪音）
      //   - skipped-no-* 是极少数边界 → 不阻塞且无操作意义
    } catch (n4Cont2Err) {
      appendModuleLog({
        level: 'error',
        source: 'main',
        domain: 'migration',
        message: '[migration N4-cont-2] unexpected failure (启动不阻塞，下次启动重试)',
        details: [n4Cont2Err && n4Cont2Err.message ? n4Cont2Err.message : String(n4Cont2Err)],
        stack: n4Cont2Err && n4Cont2Err.stack ? n4Cont2Err.stack : undefined
      });
    }
    // v2.1.16 阶段一 A3：链接表持久化（meta + 3 张数据表；期权表模板缺失暂不建）
    //   与其他 ensure*TablesSupport 并列，无依赖，放最后（ANALYZE 之前）
    //   幂等：CREATE TABLE / INDEX IF NOT EXISTS，纯新增无破坏性
    this.ensureLinkedTableSupport();
    // v2.1.16-beta.5 需求3：ADM 银行对账单隐藏表（紧随 linked 表；幂等 CREATE IF NOT EXISTS，无依赖、不进 ALL_TABLE_KEYS）
    this.ensureAdmBankDepositSupport();
    // v3.0.4 块 E 需求2：BOC 链接表两张隐藏表（紧随 ADM 表；幂等 CREATE IF NOT EXISTS，无依赖、不进 ALL_TABLE_KEYS）
    this.ensureBocFxLinkSupport();
    // v2.1.16-beta.3 ①：Channel 枚举字典表（纯审计沉淀；幂等 CREATE IF NOT EXISTS，无依赖）
    this.ensureChannelEnumSupport();
    // v2.1.7 F7-A2：启动期 ANALYZE — 让规划器统计所有索引（含 idx_acquiring_bill_currency_bill_source_file）
    //   必须在所有 ensure*Support / migrate* 之后（否则统计的是旧 schema）
    //   ANALYZE 幂等可重复；用户 DB 体量下开销 < 100ms（spec §7.9）
    this.db.exec('ANALYZE;');
  }

  hasColumn(tableName, columnName) {
    return hasColumn(this.db, tableName, columnName);
  }

  ensureTemplateKeySupport() {
    return ensureTemplateKeySupport(this.db);
  }

  ensureTemplateMappingEnhancements() {
    return ensureTemplateMappingEnhancements(this.db);
  }

  ensureAccountMappingCurrencySupport() {
    return ensureAccountMappingCurrencySupport(this.db);
  }

  ensureTemplateDateFormatSupport() {
    return ensureTemplateDateFormatSupport(this.db);
  }

  ensureAmountSplitRulesSupport() {
    return ensureAmountSplitRulesSupport(this.db);
  }

  ensureBillSplitMergeSupport() {
    return ensureBillSplitMergeSupport(this.db);
  }

  ensureBillSplitTargetSeqSupport() {
    return ensureBillSplitTargetSeqSupport(this.db);
  }

  ensureParentTemplateSupport() {
    return ensureParentTemplateSupport(this.db);
  }

  ensureTemplateFilenameFixedFieldSupport() {
    return ensureTemplateFilenameFixedFieldSupport(this.db);
  }

  ensureAccountMappingTemplateSupport() {
    return ensureAccountMappingTemplateSupport(this.db);
  }

  // v1.5.3 需求 R2：自有账号合并入大账号表 — 幂等 schema 迁移
  ensureTemplateBigAccountNatureSupport() {
    return ensureTemplateBigAccountNatureSupport(this.db);
  }

  // v2.1.2 T2：月度银行对账单BU回填校验模块 3 张表（pending_imports / bank_imports / runs）
  ensureBankBuReconTablesSupport() {
    return ensureBankBuReconTablesSupport(this.db);
  }

  // v2.1.12 需求1 T-vcc-1：VCC业务OP计算模块 2 张表（runs / run_files）+ 2 索引
  ensureVccOpCalcTablesSupport() {
    return ensureVccOpCalcTablesSupport(this.db);
  }

  // v2.1.3 T1：业务OP数据核对模块 4 张表（imports / flow_imports / runs / diff_rows）
  ensureBizOpReconTablesSupport() {
    return ensureBizOpReconTablesSupport(this.db);
  }

  // v2.1.6 T4：收单单据币种校验模块 4 张表（flow_imports / bill_imports / runs / diff_rows）
  ensureAcquiringBillCurrencyTablesSupport() {
    return ensureAcquiringBillCurrencyTablesSupport(this.db);
  }

  // v3.0.3 PR-B（P0-3）：收单两表旧 4 索引 → 2 covering（老库就地迁移，幂等）
  ensureAcquiringBillCurrencyIndexSlimV2() {
    return ensureAcquiringBillCurrencyIndexSlimV2(this.db);
  }

  ensureAcquiringBillCurrencyRunsCleanupPending() {
    return ensureAcquiringBillCurrencyRunsCleanupPending(this.db);
  }

  // v2.1.9 N1-settings (T32b)：idle cleanup 阈值 settings 化 — seed default=30 + 暴露 get/set 接口
  ensureAcquiringBillIdleCleanupMinutesSetting() {
    return ensureAcquiringBillIdleCleanupMinutesSetting(this.db);
  }

  getAcquiringBillIdleCleanupMinutes() {
    return settingsRepository.getAcquiringBillIdleCleanupMinutes(this.db);
  }

  setAcquiringBillIdleCleanupMinutes(minutes) {
    return settingsRepository.setAcquiringBillIdleCleanupMinutes(this.db, minutes);
  }

  // v2.1.10 A4 T18：chunked 分批 size — seed default=100000 + 暴露 get/set 接口
  ensureAcquiringBillChunkSizeSetting() {
    return ensureAcquiringBillChunkSizeSetting(this.db);
  }

  getAcquiringBillChunkSize() {
    return settingsRepository.getAcquiringBillChunkSize(this.db);
  }

  setAcquiringBillChunkSize(size) {
    return settingsRepository.setAcquiringBillChunkSize(this.db, size);
  }

  // v2.1.12 β.1-T3：多 worker write-splitting worker 数 — seed default=2（D33）+ 暴露 get/set
  ensureAcquiringBillWorkerCountSetting() {
    return ensureAcquiringBillWorkerCountSetting(this.db);
  }

  getAcquiringBillWorkerCount() {
    return settingsRepository.getAcquiringBillWorkerCount(this.db);
  }

  setAcquiringBillWorkerCount(count) {
    return settingsRepository.setAcquiringBillWorkerCount(this.db, count);
  }

  // v2.1.10 A4 T19：runs.chunk_progress 列 migration — 启动期幂等 ADD COLUMN
  ensureAcquiringBillCurrencyRunsChunkProgress() {
    return ensureAcquiringBillCurrencyRunsChunkProgress(this.db);
  }

  // v2.1.10 N4-cont-1 T22 (Phase 4)：raw_json idle 自动清理保留窗口 settings — seed default=7 + 暴露 get/set
  ensureAcquiringBillCurrencyRawJsonRetentionSettings() {
    return ensureAcquiringBillCurrencyRawJsonRetentionSettings(this.db);
  }

  getAcquiringBillRawJsonRetentionDays() {
    return settingsRepository.getAcquiringBillRawJsonRetentionDays(this.db);
  }

  setAcquiringBillRawJsonRetentionDays(days) {
    return settingsRepository.setAcquiringBillRawJsonRetentionDays(this.db, days);
  }

  // v3.0.3 PR-D（W5）：OneDrive 导出目录提示防重标记 facade
  //   工作目录落在 OneDrive 同步路径时启动后单次提示；'1' = 已提示过。
  hasShownWinOneDriveStorageNotice() {
    return settingsRepository.hasShownWinOneDriveStorageNotice(this.db);
  }

  markWinOneDriveStorageNoticeShown() {
    return settingsRepository.markWinOneDriveStorageNoticeShown(this.db);
  }

  // v2.1.8 N4 → v2.1.9 N4 重构 (T32e, D22=a)：差异表瘦身 migration
  //   原 v2.1.8 实现：内部 fs.copyFileSync(dbPath, backupPath) — 大库阻塞 / WAL 不一致 / 失败无回滚
  //   v2.1.9 改造：注入 createBackup 函数 → migration 复用 SR-backup-1 sqlite VACUUM INTO（与 N5 同 backup 体系）
  //   备份路径仍是 <dbDir>/backups/tool-data-bak-pre-N4-{timestamp}.sqlite（行为不变）
  //   标志位 / raw_json 字段裁剪 / 事务流程全部不变（v2.1.8 N4 已发代码契约保护）
  ensureBillRawJsonV2Slim() {
    return ensureBillRawJsonV2Slim(this.db, this.dbPath, (label) => this.createBackup(label));
  }

  // v2.1.9 N5：channels 表 + scenarios.channel_id FK + backfill 到「通用」
  //   传 createBackup 函数给 migration（事务外执行 SR-backup-1 sqlite VACUUM INTO）
  //   返回 { status, backupPath?, columnAdded?, error? }
  ensureSchemaV2_1_9_N5() {
    return ensureSchemaV2_1_9_N5(this.db, (label) => this.createBackup(label));
  }

  // v2.1.9 SR-FIX-1 (spec §16.3) facade：scenarios.name UNIQUE 全表 → (channel_id, name)
  //   注入 createBackup 函数 → migration 复用 SR-backup-1 sqlite VACUUM INTO（与 N5 同 backup 体系）
  ensureScenariosNameUniqueByChannelId() {
    return ensureScenariosNameUniqueByChannelId(this.db, (label) => this.createBackup(label));
  }

  // v2.1.10 N4-cont-2 T30：diff_rows FK ON DELETE CASCADE 改造 facade
  //   传 createBackup 函数给 migration（事务外执行 SR-backup-1 sqlite VACUUM INTO）
  //   注入 dbPath 第二参（保持与 ensureBillRawJsonV2Slim 同签名；本函数当前未用 dbPath 但保留契约）
  //   返回 { status, backupPath?, error?, statusReached?, rowsAffected? }
  ensureDiffRowsCascadeMigration_v2_1_10() {
    return ensureDiffRowsCascadeMigration_v2_1_10(
      this.db,
      this.dbPath,
      (label) => this.createBackup(label)
    );
  }

  listTemplates() {
    return templateRepository.listTemplates(this.db);
  }

  getTemplate(templateId) {
    return templateRepository.getTemplate(this.db, templateId);
  }

  listChildTemplates(parentTemplateId) {
    return templateRepository.listChildTemplates(this.db, parentTemplateId);
  }

  setParentStatus(templateId, isParent) {
    return templateRepository.setParentStatus(this.db, templateId, isParent);
  }

  setChildParent(templateId, parentTemplateId) {
    return templateRepository.setChildParent(this.db, templateId, parentTemplateId);
  }

  getTemplateByKey(templateKey) {
    return templateRepository.getTemplateByKey(this.db, templateKey);
  }

  getTemplateByName(name) {
    return templateRepository.getTemplateByName(this.db, name);
  }

  upsertTemplate({ templateKey = '', name, sourceFileName, headers }) {
    return templateRepository.upsertTemplate(this.db, { templateKey, name, sourceFileName, headers });
  }

  renameTemplate(templateId, nextName) {
    return templateRepository.renameTemplate(this.db, templateId, nextName);
  }

  deleteTemplate(templateId) {
    return templateRepository.deleteTemplate(this.db, templateId);
  }

  // v1.5.2 需求 3：保存模板的文件名固定字段
  saveTemplateFilenameFixedField(templateId, value) {
    return templateRepository.saveTemplateFilenameFixedField(this.db, templateId, value);
  }

  getTemplateBigAccounts(templateId, options = {}) {
    return templateRepository.getTemplateBigAccounts(this.db, templateId, options);
  }

  getTemplateMappings(templateId) {
    return templateRepository.getTemplateMappings(this.db, templateId);
  }

  // v1.5.3 R2 round 3：options.preserveOwn 透传到 repository（默认 true，调用方未显式接管 own 时保留 own）
  saveMappings(templateId, mappings, bigAccounts = [], fixedAssignments = [], dateFormat, amountSplitRules = null, options = {}) {
    return templateRepository.saveMappings(
      this.db,
      templateId,
      mappings,
      bigAccounts,
      fixedAssignments,
      dateFormat,
      amountSplitRules,
      options
    );
  }

  getAmountSplitRules(templateId) {
    return templateRepository.getAmountSplitRules(this.db, templateId);
  }

  saveAmountSplitRules(templateId, rules) {
    return templateRepository.saveAmountSplitRules(this.db, templateId, rules);
  }

  listTemplateBundleEntries() {
    return templateRepository.listTemplateBundleEntries(this.db);
  }

  getBillSplitMappings(templateId) {
    return templateRepository.getBillSplitMappings(this.db, templateId);
  }

  saveBillSplitMappings(templateId, mappings) {
    return templateRepository.saveBillSplitMappings(this.db, templateId, mappings);
  }

  getBillSplitRows(templateId) {
    return templateRepository.getBillSplitRows(this.db, templateId);
  }

  saveBillSplitRowCount(templateId, nextN) {
    return templateRepository.saveBillSplitRowCount(this.db, templateId, nextN);
  }

  saveBillSplitRow(templateId, row) {
    return templateRepository.saveBillSplitRow(this.db, templateId, row);
  }

  deleteBillSplitRow(templateId, seqNo) {
    return templateRepository.deleteBillSplitRow(this.db, templateId, seqNo);
  }

  saveBillSplitMergeGroup(templateId, seqNos) {
    return templateRepository.saveBillSplitMergeGroup(this.db, templateId, seqNos);
  }

  clearBillSplitMergeGroups(templateId) {
    return templateRepository.clearBillSplitMergeGroups(this.db, templateId);
  }

  getBillSplitAmountRules(templateId) {
    return templateRepository.getBillSplitAmountRules(this.db, templateId);
  }

  saveBillSplitAmountRules(templateId, rules) {
    return templateRepository.saveBillSplitAmountRules(this.db, templateId, rules);
  }

  getBillSplitMeta(templateId) {
    return templateRepository.getBillSplitMeta(this.db, templateId);
  }

  saveBillSplitMeta(templateId, meta) {
    return templateRepository.saveBillSplitMeta(this.db, templateId, meta);
  }

  getSetting(settingKey) {
    return settingsRepository.getSetting(this.db, settingKey);
  }

  setSetting(settingKey, settingValue) {
    return settingsRepository.setSetting(this.db, settingKey, settingValue);
  }

  getEnumConfig() {
    return settingsRepository.getEnumConfig(this.db);
  }

  setEnumConfig(enumConfig) {
    return settingsRepository.setEnumConfig(this.db, enumConfig);
  }

  getBackgroundConfig() {
    return settingsRepository.getBackgroundConfig(this.db);
  }

  setBackgroundConfig(backgroundConfig) {
    return settingsRepository.setBackgroundConfig(this.db, backgroundConfig);
  }

  getUiStyle() {
    return settingsRepository.getUiStyle(this.db);
  }

  ensureUiStyleDefault() {
    return settingsRepository.ensureUiStyleDefault(this.db);
  }

  getCurrentModule() {
    return settingsRepository.getCurrentModule(this.db);
  }

  setCurrentModule(moduleId) {
    return settingsRepository.setCurrentModule(this.db, moduleId);
  }

  // v2.1.0-beta.3 T4：对账单ReconID修复模块「账单类别」持久化
  getReconIdFixBillCategory() {
    return settingsRepository.getReconIdFixBillCategory(this.db);
  }

  setReconIdFixBillCategory(category) {
    return settingsRepository.setReconIdFixBillCategory(this.db, category);
  }

  // v2.1.4 T3：左上角模块切换按钮的启用列表
  getEnabledModules() {
    return settingsRepository.getEnabledModules(this.db);
  }

  setEnabledModules(moduleList) {
    return settingsRepository.setEnabledModules(this.db, moduleList);
  }

  listAccountMappings(templateId) {
    return settingsRepository.listAccountMappings(this.db, templateId);
  }

  countAllAccountMappings() {
    const row = this.db.prepare('SELECT COUNT(1) AS cnt FROM account_mappings').get();
    return row ? Number(row.cnt) : 0;
  }

  saveAccountMappings(templateId, mappings) {
    return settingsRepository.saveAccountMappings(this.db, templateId, mappings);
  }

  // v2.0.0-beta.3：场景 CRUD（银行对账单处理模块）
  ensureScenariosSupport() {
    return ensureScenariosSupport(this.db);
  }

  ensureScenariosCategoryReconIdFix() {
    return ensureScenariosCategoryReconIdFix(this.db);
  }

  ensureScenariosCategoryGatewayReconIdFix() {
    return ensureScenariosCategoryGatewayReconIdFix(this.db);
  }

  // v2.1.13 D-3/D-4：自带写死场景（builtin-fixed）数据层迁移
  ensureScenariosCategoryBuiltinFixed() {
    return ensureScenariosCategoryBuiltinFixed(this.db);
  }

  ensureBuiltinFixedScenarioNameUpdate() {
    return ensureBuiltinFixedScenarioNameUpdate(this.db);
  }

  ensureBuiltinFixedScenarioMigration() {
    return ensureBuiltinFixedScenarioMigration(this.db);
  }

  ensureScenarioApplicableChannelsTable() {
    return ensureScenarioApplicableChannelsTable(this.db);
  }

  // v2.1.16-beta.2 §8：5 轮对账 R4/R5 内置场景 seed（5 R4 + 2 R5，🔴 资金红线）
  ensureReconRoundBuiltinScenariosSeed() {
    return ensureReconRoundBuiltinScenariosSeed(this.db);
  }

  // v2.1.16-beta.4 ③：中台退款订单回填场景独立补种（默认休眠 enabled=0，🔴 资金红线）
  ensureRefundBackfillScenarioSeed() {
    return ensureRefundBackfillScenarioSeed(this.db);
  }

  // v2.1.16-beta.5 需求4：JPM 调拨订单修复写死场景独立补种（默认休眠 enabled=0，🔴 资金红线）
  ensureJpmDispatchOrderScenarioSeed() {
    return ensureJpmDispatchOrderScenarioSeed(this.db);
  }

  // v2.1.16-beta.2 §FundType：一次性修存量 config 错拼 'Ach Ruturn' → 'Ach Return'（🔴 资金红线）
  ensureFundTypeAchReturnConfigMigration() {
    return ensureFundTypeAchReturnConfigMigration(this.db);
  }

  migrateGatewayReconIdFixFieldPairs() {
    return migrateGatewayReconIdFixFieldPairs(this.db);
  }

  // v2.1.0-beta.1 PR-B（Q1=B 决策，2026-04-30）：C4 reconFields[] → reconGroups[] 迁移
  migrateC4ReconGroupsAmountLockedFieldPair() {
    return migrateC4ReconGroupsAmountLockedFieldPair(this.db);
  }

  migrateC4ReconGroupsStructure() {
    return migrateC4ReconGroupsStructure(this.db);
  }

  ensureC3GwFieldCurrencyCaseFix() {
    return ensureC3GwFieldCurrencyCaseFix(this.db);
  }

  ensureC3AssignAddMode() {
    return ensureC3AssignAddMode(this.db);
  }

  ensureBuiltinScenarioNamesUpdate() {
    return ensureBuiltinScenarioNamesUpdate(this.db);
  }

  listScenarios() {
    return scenariosRepository.listScenarios(this.db);
  }

  getScenario(id) {
    return scenariosRepository.getScenario(this.db, id);
  }

  createScenario(payload) {
    return scenariosRepository.createScenario(this.db, payload);
  }

  updateScenario(id, fields) {
    return scenariosRepository.updateScenario(this.db, id, fields);
  }

  deleteScenario(id) {
    return scenariosRepository.deleteScenario(this.db, id);
  }

  toggleScenarioEnabled(id, enabled) {
    return scenariosRepository.toggleScenarioEnabled(this.db, id, enabled);
  }

  // v2.1.9 N5 Phase 5 T23：批量转移场景到目标渠道（单条 = 长度 1）
  //   payload: { scenarioIds: number[], targetChannelId: number }
  //   底层事务包裹；任何 id 不存在或目标渠道不存在 → 整批回滚抛错
  transferScenarios(scenarioIds, targetChannelId) {
    return scenariosRepository.transferScenarios(this.db, scenarioIds, targetChannelId);
  }

  // v2.1.9 N5 Phase 5 T23：批量删除场景（DB 层 is_builtin=1 保护）
  //   payload: { scenarioIds: number[] }
  //   底层事务包裹；任何 id 命中内置场景 → 整批回滚抛错
  batchDeleteScenarios(scenarioIds) {
    return scenariosRepository.batchDelete(this.db, scenarioIds);
  }

  // v2.1.9 N7 Phase 7 T29：按渠道拉全部场景（含 disabled + 全 category），导出 bundle 用
  listAllScenariosByChannelId(channelId) {
    return scenariosRepository.listAllByChannelId(this.db, channelId);
  }

  // v2.1.9 SR-FIX-1 round 2 F2（spec §16.3.3）：按 (channel_id, name) 查场景
  //   - N7 bundle import 路径同 channel 内查重依赖此 API（applyScenarioBundleImport 替换
  //     原「全表 SELECT WHERE name = ?」逻辑 → 跨 channel 同名场景被错误跳过的 bug 修复）
  //   - 返回完整 detail（含 config）便于 caller 决定 skip / overwrite
  //   - 返 null 表示该 channel 内无同名场景（可安全插入）
  findScenarioByChannelAndName(channelId, name) {
    return scenariosRepository.findByChannelAndName(this.db, channelId, name);
  }

  // v2.1.13 D-3：自带写死场景适用银行渠道（多对多）读写
  //   get 返回 channel_id 数组（空 = 适用全部渠道）；set 覆盖式（空数组 = 清空 = 全部）
  getScenarioApplicableChannels(scenarioId) {
    return scenariosRepository.getApplicableChannelIds(this.db, scenarioId);
  }

  setScenarioApplicableChannels(scenarioId, channelIds) {
    return scenariosRepository.setApplicableChannelIds(this.db, scenarioId, channelIds);
  }

  // v2.1.13 PR#58 P2-1：无事务版覆盖写（bundle import 已在外层事务内 → 不能再 BEGIN）
  //   caller 须保证已开启外层事务；ids 由 caller 处理成合法正整数去重数组（这里不再校验/去重）
  setScenarioApplicableChannelsInTx(scenarioId, channelIds) {
    const ids = Array.isArray(channelIds)
      ? [...new Set(channelIds.map((c) => Number(c)).filter((c) => Number.isFinite(c) && c > 0))]
      : [];
    return scenariosRepository.applyApplicableChannelIdsInTx(this.db, Number(scenarioId), ids);
  }

  // v2.1.13 D-3/D-5：dispatcher 取对指定渠道生效的 builtin-fixed 场景（含 config）
  listBuiltinFixedScenariosForChannel(channelId) {
    return scenariosRepository.listBuiltinFixedForChannel(this.db, channelId);
  }

  // v2.1.9 N5：channels CRUD（银行渠道）
  //   底层 schema 在 ensureChannelsTable 建表；「通用」内置渠道 id=1 不可删不可改名
  //   findByNameAndLocation 是 dispatcher hot path（每行调度都查渠道）
  listChannels() {
    return channelsRepository.listChannels(this.db);
  }

  getChannelById(id) {
    return channelsRepository.getChannelById(this.db, id);
  }

  findChannelByNameAndLocation(name, ownerLocation) {
    return channelsRepository.findByNameAndLocation(this.db, name, ownerLocation);
  }

  getBuiltinGeneralChannel() {
    return channelsRepository.getBuiltinGeneral(this.db);
  }

  createChannel(payload) {
    return channelsRepository.createChannel(this.db, payload || {});
  }

  updateChannel(id, fields) {
    return channelsRepository.updateChannel(this.db, id, fields || {});
  }

  deleteChannel(id) {
    return channelsRepository.deleteChannel(this.db, id);
  }

  // v2.1.16 阶段一 A3：链接表持久化 facade
  ensureLinkedTableSupport() {
    return ensureLinkedTableSupport(this.db);
  }

  // 读全部 4 个 tableKey 元数据（前端弹窗渲染 4 行；期权表恒返回空 meta）
  listLinkedTableMeta() {
    return linkedTableRepository.listLinkedTableMeta(this.db);
  }

  getLinkedTableMeta(tableKey) {
    return linkedTableRepository.getLinkedTableMeta(this.db, tableKey);
  }

  // 整表覆盖写入（rows = { [表头名]: 值 } 对象数组）；fx-option 抛「模板缺失」
  replaceLinkedTable(tableKey, rows, options) {
    return linkedTableRepository.replaceLinkedTable(this.db, tableKey, rows, options || {});
  }

  // v3.0.0 块 B / PR-2：大文件链接表流式整表覆盖（async；caller 经 feedRows(insertOne) 在事务内逐行喂入，内存恒定）。
  //   🔴🔴 数据红线：整表覆盖（DELETE 全表 + 单事务跨 await）；feedRows 中途 throw → ROLLBACK 旧数据完好。
  replaceLinkedTableStreaming(tableKey, feedRows, options) {
    return linkedTableRepository.replaceLinkedTableStreaming(this.db, tableKey, feedRows, options || {});
  }

  // v3.0.1 需求1 / task2：网关对账单「按 ReconBillBizId 幂等 upsert」（数组版，同步）——累加不整表覆盖。
  //   返回 { upserted, overwriteCount, rejectedEmptyCount, rowCount, dataDateMin, dataDateMax, updatedAt }。
  upsertLinkedGatewayBill(rows, options) {
    return linkedTableRepository.upsertLinkedGatewayBill(this.db, rows, options || {});
  }

  // v3.0.1 需求1 / task2：网关对账单「按 ReconBillBizId 幂等 upsert」（流式版，async）。
  //   🔴🔴 资金红线（R-4）：单事务跨 await；feedRows 中途 throw → ROLLBACK，表保持调用前状态。
  upsertLinkedGatewayBillStreaming(feedRows, options) {
    return linkedTableRepository.upsertLinkedGatewayBillStreaming(this.db, feedRows, options || {});
  }

  // v3.0.1 需求1 / task4：按数据日期范围统计将删行数（只读，前端删除弹框预览「将删约 N 行」）。
  countGatewayBillByDateRange(startDate, endDate) {
    return linkedTableRepository.countGatewayBillByDateRange(this.db, startDate, endDate);
  }

  // v3.0.1 需求1 / task4：🔴 资金红线——按数据日期闭区间删除网关对账单行（不可逆，单事务，删后 meta 全表重算）。
  deleteGatewayBillByDateRange(startDate, endDate, options) {
    return linkedTableRepository.deleteGatewayBillByDateRange(this.db, startDate, endDate, options || {});
  }

  // v2.1.16-beta.2 T1：读回某 tableKey 全部整行（raw_json → 对象，字段名 = 真实表头）；
  //   fx-option 返回 []；损坏行跳过。供 5 轮对账编排器取网关数据源（'gateway-bill'）。
  readLinkedTableRows(tableKey) {
    return linkedTableRepository.readLinkedTableRows(this.db, tableKey);
  }

  // v3.0.0 块 B / PR-3：ADM 派生内存优化 facade（Channel=ADM 下推过滤 / 轻量存在性探测）
  readBankDepositAdmCandidates() {
    return linkedTableRepository.readBankDepositAdmCandidates(this.db);
  }

  hasLinkedTableRows(tableKey) {
    return linkedTableRepository.hasLinkedTableRows(this.db, tableKey);
  }

  // v2.1.16-beta.5 需求3：ADM 银行对账单隐藏表 facade（建表 + 仓储三函数转发）
  ensureAdmBankDepositSupport() {
    return ensureAdmBankDepositSupport(this.db);
  }

  // ADM 表整表覆盖写入（rows = 13+6 字段对象数组）；6 列 INSERT，整表重建 = 匹配标志归零
  replaceAdmBankDeposit(rows, options) {
    return linkedTableRepository.replaceAdmBankDeposit(this.db, rows, options || {});
  }

  // 读回 ADM 表全部整行（raw_json → 对象）；供 JPM 引擎三段匹配；损坏行跳过
  readAdmBankDepositRows() {
    return linkedTableRepository.readAdmBankDepositRows(this.db);
  }

  // JPM run 阶段整批幂等重写 ADM 行匹配标志 / 资金对账ID（可重入）
  writeAdmMatchFlags(admRows) {
    return linkedTableRepository.writeAdmMatchFlags(this.db, admRows);
  }

  // v3.0.4 块 E 需求2：BOC 链接表两张隐藏表 facade（建表 + 仓储函数转发）
  ensureBocFxLinkSupport() {
    return ensureBocFxLinkSupport(this.db);
  }

  // 银行对账单 Channel=BOC 候选子集（json_extract 下推，仅物化候选；地区/币种/金额终审在 builder）
  readBankDepositBocCandidates() {
    return linkedTableRepository.readBankDepositBocCandidates(this.db);
  }

  // BOC链接表整表覆盖写入（8 列 INSERT，热列从内部辅助键取，raw_json 剥辅助键）
  replaceBocFxLink(rows) {
    return linkedTableRepository.replaceBocFxLink(this.db, rows);
  }

  // 读回 BOC链接表业务行（raw_json → 对象，按 id ASC）；供 BOC 引擎数据源
  readBocFxLinkRows() {
    return linkedTableRepository.readBocFxLinkRows(this.db);
  }

  // 读回 BOC链接表行（携带 DB id）：[{ id, row }]；供 2.5 backfill 按 id 回写
  readBocFxLinkRowsWithIds() {
    return linkedTableRepository.readBocFxLinkRowsWithIds(this.db);
  }

  // 2.5 回填：按 id UPDATE raw_json + recon_link_id 列（幂等全量重算，无位置错位）
  writeBocFxLinkReconIds(rowsWithIds) {
    return linkedTableRepository.writeBocFxLinkReconIds(this.db, rowsWithIds);
  }

  // BOC调拨银行对账单表整表覆盖写入（5 列 INSERT，整行存 raw_json）
  replaceBocBankDeposit(rows) {
    return linkedTableRepository.replaceBocBankDeposit(this.db, rows);
  }

  // 读回 BOC调拨银行对账单表全部行（raw_json → 对象，按 id ASC）
  readBocBankDepositRows() {
    return linkedTableRepository.readBocBankDepositRows(this.db);
  }

  // v2.1.16-beta.3 ①：Channel 枚举字典 facade（纯审计沉淀，不删/不改对账数据）
  ensureChannelEnumSupport() {
    return ensureChannelEnumSupport(this.db);
  }

  // 导入银行对账单成功后沉淀 Channel / Channel-地区 枚举（去重 upsert）。
  //   内部已有事务；调用方（main.js handler）应再包一层 try-catch 防沉淀失败阻断导入。
  recordChannelEnumFromBankStatement(rows) {
    return channelEnumRepository.recordFromBankStatementRows(this.db, rows);
  }

  // 按 value_type（'channel' / 'channel-region'）列出枚举值（供后续引擎读库 + 审计）。
  listChannelEnumValues(valueType) {
    return channelEnumRepository.listChannelEnumValues(this.db, valueType);
  }

  // v3.0.0 需求1：从银行对账单行抽取唯一「渠道-地区」组合（纯函数，供 session-status 透出状态框前缀）。
  //   不依赖 db；与枚举沉淀同拼接口径（Channel 空跳过 / 地区空只产 channel / 去重 + 排序）。
  extractChannelRegionCombos(rows) {
    return channelEnumRepository.extractChannelRegionCombos(rows);
  }

  // SR-backup-1 (v2.1.9)：sqlite 安全备份 API（VACUUM INTO）
  // 用法：const backupPath = appDb.createBackup('pre-N5');
  //   - label：仅支持 [A-Za-z0-9_-]（用于文件名 + 防 SQL 注入）
  //   - 备份落 <dbDir>/backups/tool-data-bak-{label}-{timestamp}.sqlite
  createBackup(label) {
    if (!this.db) throw new Error('AppDatabase.createBackup: db 未初始化');
    const backupDir = path.join(path.dirname(this.dbPath), 'backups');
    return createBackupImpl(this.db, label, backupDir);
  }
}

module.exports = {
  AppDatabase
};
