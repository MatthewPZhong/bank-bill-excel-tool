const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureBankAccountSnapshotSupport,
  ensureAccountMappingCurrencySupport,
  ensureAccountMappingTemplateSupport,
  ensureAmountSplitRulesSupport,
  // v2.1.12/E03-B：VCC业务OP计算 run/files + save operation receipt
  ensureVccOpCalcTablesSupport,
  ensureBillSplitMergeSupport,
  ensureBillSplitTargetSeqSupport,
  ensureBillSplitFeeBillSupport,
  ensureBillSplitRowFilterSupport,
  ensureBillSplitFeeFieldMappingSupport,
  ensureParentTemplateSupport,
  ensureStatementChannelSupport,
  hasPendingStatementChannelMigration,
  ensureScenariosSupport,
  ensureScenariosCategoryReconIdFix,
  ensureScenariosCategoryGatewayReconIdFix,
  migrateGatewayReconIdFixFieldPairs,
  migrateC4ReconGroupsStructure,
  migrateC4ReconGroupsAmountLockedFieldPair,
  ensureC3GwFieldCurrencyCaseRevert,
  ensureC3AssignAddMode,
  ensureArchiveVccDefaultRetention,
  ensureSchemaV2_1_9_N5,
  ensureScenariosNameUniqueByChannelId,
  // v2.1.13 D-3/D-4：自带写死场景 builtin-fixed 数据层迁移
  ensureScenariosCategoryBuiltinFixed,
  ensureBuiltinFixedScenarioNameUpdate,
  ensureBuiltinFixedScenarioMigration,
  ensureScenarioApplicableChannelsTable,
  // v2.1.16-beta.2 §8：5 轮对账 R4/R5 内置场景 seed（5 R4 + 2 R5）
  ensureReconRoundBuiltinScenariosSeed,
  // v3.1.1：canonical 调拨回填 owner 幂等恢复 + 全渠道归一
  ensureFundTransferBackfillCanonicalOwner,
  // v2.1.16-beta.4 ③：中台退款订单回填场景独立补种（默认休眠 enabled=0）
  ensureRefundBackfillScenarioSeed,
  // v2.1.16-beta.5 需求4：JPM 调拨订单修复写死场景独立补种（默认休眠 enabled=0，category=gateway-recon-id-fix）
  ensureJpmDispatchOrderScenarioSeed,
  // v3.0.4 块 E 需求1：BOC 调拨订单修复写死场景独立补种（默认休眠 enabled=0，category=gateway-recon-id-fix）
  ensureBocDispatchOrderScenarioSeed,
  // v3.0.6 需求3（T9）：DBS-Charge 资金校验写死场景独立补种（默认 enabled=1，category=builtin-fixed → R3.5）
  ensureDbsChargeFundCheckScenarioSeed,
  // v3.0.6 需求3（T9）：每次启动幂等 DELETE 已废弃 charge-outbound 内置孤儿（含级联删关联表，无 marker；不删用户/DBS-Charge 场景）
  retireChargeOutboundOrphans,
  // v2.1.16-beta.2 §FundType：一次性修存量 config 错拼 'Ach Ruturn' → 'Ach Return'
  ensureFundTypeAchReturnConfigMigration,
  // v3.0.10 需求1：R4 方向守卫 config 字段补种（无 marker 幂等补缺失 requireBankZeroField，绝不覆盖用户值）
  ensureR4DirectionGuardConfigMigration,
  // v3.0.23：四个内置 R4 场景严格匹配说明幂等刷新
  ensureR4StrictDescriptionMigration,
  // v2.1.16 阶段一 A3：链接表持久化建表（v2.1.16-beta.3 ②：含入金表 linked_bank_deposit）
  ensureLinkedTableSupport,
  // v2.1.16-beta.5 需求3：ADM 银行对账单隐藏表建表（独立幂等迁移）
  ensureAdmBankDepositSupport,
  // v3.2.4 E11-P0：JPM ADM 同库 operation receipt schema
  ensureReconFixOperationReceiptSupport,
  ensureFundTransferReconSupport,
  // v3.0.4 块 E 需求2：BOC 链接表两张隐藏表建表（独立幂等迁移；不进 ALL_TABLE_KEYS）
  ensureBocFxLinkSupport,
  // v2.1.16-beta.3 ①：Channel 枚举字典表建表
  ensureChannelEnumSupport,
  // v3.0.12 功能2（批A）：账户映射管理全局表建表（中台调拨单账户号 → 清结算系统银行账号）
  ensureFundTransferAccountMappingSupport,
  ensurePreFundReconciliationRunMetadataSupport,
  ensureDuplicateInboundMatchRunMetadataSupport,
  ensureTemplateResourceVersionSupport,
  ensureBuiltinScenarioNamesUpdate,
  ensureTemplateBigAccountNatureSupport,
  ensureTemplateCurrencyBigAccountSupport,
  ensureTemplateDateFormatSupport,
  ensureTemplateFilenameFixedFieldSupport,
  ensureTemplateFeatureFilterSupport,
  ensureTemplatePreprocessRowFilterSupport,
  ensureTemplateKeySupport,
  ensureTemplateMappingEnhancements,
  hasColumn
} = require('./database/migrations');
const { ensureVccFinancialOpTablesSupport } = require('./vcc-financial-op-db/migrations');
const { upgradeVccStorageFile } = require('./vcc-financial-op-db/storage-upgrade');
const { registerVccStorageWriteCapability, assertVccStorageContract } = require('./vcc-financial-op-db/storage-contract');
const scenariosRepository = require('./database/scenarios-repository');
const settingsRepository = require('./database/settings-repository');
const templateRepository = require('./database/template-repository');
// v3.2.15：网银账单渠道（取代主模板）
const statementChannelRepository = require('./database/statement-channel-repository');
const channelsRepository = require('./database/channels-repository');
// v2.1.16 阶段一 A3：链接表持久化仓储
const linkedTableRepository = require('./database/linked-table-repository');
// v2.1.16-beta.3 ①：Channel 枚举字典仓储
const channelEnumRepository = require('./database/channel-enum-repository');
// v3.0.12 功能2（批A）：账户映射管理仓储（全局：中台调拨单账户号 → 清结算系统银行账号）
const fundTransferAccountMappingRepository = require('./database/fund-transfer-account-mapping-repository');
const preFundReconciliationRunRepository = require('./database/pre-fund-reconciliation-run-repository');
const duplicateInboundMatchRunRepository = require('./database/duplicate-inbound-match-run-repository');
const templateResourceRepository = require('./database/template-resource-repository');
const bankAccountRepository = require('./database/bank-account-repository');
const { createBackup: createBackupImpl } = require('./database/backup');
// v2.1.9 SR-log-1 (T32h)：替换 console.error → appendModuleLog 双写
const { appendModuleLog } = require('./logger');
const {
  runStartupPhaseSync,
  startStartupPhase
} = require('./startup-phase');

// v3.0.5 PR-2（Part B Phase 0 / B-D6）：一次性 VACUUM 主库标志位 + 磁盘安全余量比例
//   标志位沿用 settings-repository 单键布尔范式（值 '1' = 已执行；缺失 = 未执行）。
const ONE_TIME_VACUUM_FLAG_KEY = 'db_one_time_vacuum_v3_0_5_done';
//   安全前置：VACUUM 临时需约 DB 文件大小的双倍峰值，要求剩余磁盘 ≥ DB 大小 × 1.2 才执行。
const VACUUM_DISK_HEADROOM_RATIO = 1.2;

// 字节数转人类可读字符串（仅用于 activity log 可读性，非精确换算）
function formatBytesForLog(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return String(bytes);
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(2)} ${units[i]}`;
}

function normalizeAccountMappingScope(scope) {
  if (scope && typeof scope === 'object') {
    const channelId = Number(scope.channelId || 0);
    if (channelId > 0) return { channelId, templateId: null };
    return { channelId: null, templateId: Number(scope.templateId || 0) };
  }
  return { channelId: null, templateId: Number(scope || 0) };
}

class AppDatabase {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  init(options = {}) {
    const onStartupPhase = typeof options.onStartupPhase === 'function'
      ? options.onStartupPhase
      : null;
    try {
    runStartupPhaseSync('database-open', () => {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      // 启动尚未开放业务入口；先用专用连接完成 v2 → v3，再创建 Main 写连接。
      upgradeVccStorageFile(this.dbPath);
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec('PRAGMA foreign_keys = ON;');
    // v2.1.7 F7-A1：全局 SQL 调优
    //   PRAGMA 顺序固定：foreign_keys → journal_mode(WAL) → synchronous(NORMAL) → cache_size → mmap_size → temp_store
    //   ⚠️ synchronous=NORMAL 必须在 WAL 之后（DELETE/FULL 模式下 NORMAL 不安全；spec §7.3 关键不变量）
    //   journal_mode=WAL 持久化在 DB 元数据，首次启动后即生效；产生 *.sqlite-wal + *.sqlite-shm 旁文件（用户备份提示见 USER_GUIDE §DB 备份）
    this.db.exec('PRAGMA journal_mode = WAL;');        // 读写并发更好；崩溃恢复保留
    this.db.exec('PRAGMA synchronous = NORMAL;');      // WAL 下安全 + 性能 2-3 倍
    this.db.exec('PRAGMA cache_size = -65536;');       // 64MB 页缓存（负数 = KB；-65536 = 64MB）
    this.db.exec('PRAGMA mmap_size = 268435456;');     // 256MB 内存映射（64-bit 环境）
      this.db.exec('PRAGMA temp_store = MEMORY;');       // v3.0.3 PR-C（W1）：临时表/排序驻内存，避开 Windows %TEMP% 落盘 + Defender 过滤链（4 处 PRAGMA 同步，加在 mmap_size 之后）
      this.db.prepare('SELECT 1 AS sqlite_ready').get();
    }, { onRecord: onStartupPhase });

    runStartupPhaseSync('database-migrations', () => {
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
    this.ensureBillSplitFeeBillSupport();
    this.ensureBillSplitRowFilterSupport();
    this.ensureBillSplitFeeFieldMappingSupport();
    this.ensureParentTemplateSupport();
    this.ensureTemplateFilenameFixedFieldSupport();
    this.ensureTemplateFeatureFilterSupport();
    this.ensureTemplatePreprocessRowFilterSupport();
    this.ensureAccountMappingTemplateSupport();
    this.ensureTemplateBigAccountNatureSupport();
    this.ensureTemplateCurrencyBigAccountSupport();
    // v3.2.15：主/子模板一次性转为渠道；必须在 ensureParentTemplateSupport 与
    //   ensureAccountMappingTemplateSupport 之后（依赖旧标记列与模板级账户映射）。
    this.runStatementChannelMigration();
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
    this.ensureC3GwFieldCurrencyCaseRevert();
    // v2.1.8 N2：给 'gateway-recon-join' assign 对象补 mode='direct' + customValue=''
    //   必须在 ensureC3GwFieldCurrencyCaseRevert 之后（先修 currency 大小写再扩字段，互不影响）
    this.ensureC3AssignAddMode();
    this.ensureBuiltinScenarioNamesUpdate();
    // v2.1.9 N5：channels 表 + scenarios.channel_id FK + backfill 到「通用」
    //   🔴 资金红线 + 破坏性 schema 变更（不可逆）；首次启动自动备份 DB 到 <dbDir>/backups/
    //   幂等：app_settings.n5_channels_migrated = 'true' 跳过
    //   必须在 ensureScenariosSupport 系列之后（依赖 scenarios 表已存在）
    //   失败处理：try-catch + 日志输出状态（启动不阻塞，下次重试）
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
    // v3.1.1：调拨回填场景同时承载全局日期策略，删除不再是终态。
    // 已有单 owner 只清空历史适用渠道；缺失按完整 seed 恢复为 disabled；重复不自动合并。
    this.ensureFundTransferBackfillCanonicalOwner();
    // v2.1.16-beta.4 ③：中台退款订单回填场景独立补种（默认休眠 enabled=0，🔴 资金红线）
    //   独立 marker(refund_backfill_scenario_seeded) 绕开全局 marker 短路 —— 旧库已 seed 既有 7 条且
    //   recon_round_builtin_scenarios_seeded=true 时本函数仍能补种退款场景；新库走幂等定位为已存在跳过。
    //   必须在 ensureReconRoundBuiltinScenariosSeed 之后（同前置：CHECK 已扩到含 'builtin-fixed'）。
    this.ensureRefundBackfillScenarioSeed();
    // v2.1.16-beta.5 需求4：JPM 调拨订单修复写死场景独立补种（默认休眠 enabled=0，🔴 资金红线）
    //   前置：scenarios CHECK 已含 'gateway-recon-id-fix'（ensureScenariosCategoryGatewayReconIdFix 早已扩枚举）。
    //   独立 marker(jpm_dispatch_order_scenario_seeded) 绕开全局 marker 短路 —— 旧库也能补种。
    this.ensureJpmDispatchOrderScenarioSeed();
    // v3.0.4 块 E 需求1：BOC 调拨订单修复写死场景独立补种（默认休眠 enabled=0，🔴 资金红线）
    //   必须在 ensureJpmDispatchOrderScenarioSeed() 之后 —— 新库 id 紧随 JPM，
    //   `priority DESC, id ASC` 下 BOC 排在 JPM 之后（场景管理网关 compact 序号自然 = 2）。
    //   独立 marker(boc_dispatch_order_scenario_seeded) 绕开全局 marker 短路 —— 旧库也能补种。
    this.ensureBocDispatchOrderScenarioSeed();
    // v3.0.6 需求3（T9）：DBS-Charge 资金校验写死场景独立补种（默认 enabled=1，🔴 资金红线 — 改写 ReconciliationId + FundType）
    //   前置：scenarios CHECK 已含 'builtin-fixed'（ensureScenariosCategoryBuiltinFixed 已扩枚举）。
    //   独立 marker(dbs_charge_fund_check_scenario_seeded) 绕开全局 marker 短路 —— 旧库也能补种；
    //   funcCategory/subCategory='dbs-charge-fund-check' → 编排器 R3.5 桶（reconciliation-orchestrator.bucketScenarios）。
    this.ensureDbsChargeFundCheckScenarioSeed();
    // v3.0.6 需求3（T9）：每次启动幂等 DELETE 已废弃 charge-outbound 内置孤儿场景（🔴 资金红线 + 破坏性 — 仅删内置孤儿）。
    //   原全渠道 charge→outbound 已退役（重写为 DBS-Charge / R3.5）+ R4 引擎 charge-outbound 分支已于 T10 删除，
    //   旧库残留的 charge-outbound 内置场景指向已不存在的引擎分支 → 彻底 DELETE（含级联删 scenario_applicable_channels）。
    //   去 marker（旧实现脆弱：UPDATE 0 行也写 marker → 中间态污染则永久跳过）；每次幂等执行，无孤儿则 no-op。
    //   WHERE 严格限 is_builtin+builtin-fixed+subCategory='charge-outbound'，绝不误删 DBS-Charge/用户场景。
    this.retireChargeOutboundOrphans();
    // v2.1.16-beta.2 §FundType：一次性修存量 config 错拼 'Ach Ruturn' → 'Ach Return'（🔴 资金红线 — FundType 枚举值）
    //   必须在 scenarios 相关迁移之后（依赖 scenarios 表已存在、内置场景已 seed）。
    //   幂等：执行一次后 config 不再含 'Ach Ruturn'；绝大多数库无引用 → no-op（精确性防护）。
    this.ensureFundTypeAchReturnConfigMigration();
    // v3.0.10 需求1：R4 方向字段历史兼容补种；v3.0.23 当前引擎已改为 subCategory 固定口径。
    //   必须在 scenarios 相关迁移之后（依赖 scenarios 表已存在、内置 R4 场景已 seed）。
    //   无 marker：每次启动幂等补回缺失的 requireBankZeroField；绝不覆盖用户已改的值（已存在则跳过）。
    this.ensureR4DirectionGuardConfigMigration();
    // v3.0.23：只刷新四个内置 R4 场景的固定严格匹配说明，不改其它配置。
    this.ensureR4StrictDescriptionMigration();
    // v3.2.20：月度银行对账单BU回填校验 / 业务OP数据核对 / 收单单据币种校验已下线，
    //   不再建表或迁移其旧表；已有表与数据保留原样（不 DROP、不改写）。
    // v2.1.12/E03-B：VCC业务OP计算 run/files + save operation receipt（加法迁移）
    this.ensureVccOpCalcTablesSupport();
    // v3.1.6：VCC财务OP校验独立持久化空间（导入审计、有效事实、快照、运行及归档）。
    this.ensureVccFinancialOpTablesSupport();
    if (this.db.prepare("SELECT 1 FROM pragma_function_list WHERE name='vcc_storage_write_capability_v2'").get()) {
      this.db.close(); this.db = null;
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-65536; PRAGMA mmap_size=268435456; PRAGMA temp_store=MEMORY;');
      assertVccStorageContract(this.db);
      registerVccStorageWriteCapability(this.db);
    }
    // v3.2.18：存档「VCC财务OP校验」保留期限默认 15 天（一次性 marker；已有显式设置保留）
    ensureArchiveVccDefaultRetention(this.db);
    // v2.1.16 阶段一 A3：链接表持久化（meta + 3 张数据表；期权表模板缺失暂不建）
    //   与其他 ensure*TablesSupport 并列，无依赖，放最后（ANALYZE 之前）
    //   幂等：CREATE TABLE / INDEX IF NOT EXISTS，纯新增无破坏性
    this.ensureLinkedTableSupport();
    // v2.1.16-beta.5 需求3：ADM 银行对账单隐藏表（紧随 linked 表；幂等 CREATE IF NOT EXISTS，无依赖、不进 ALL_TABLE_KEYS）
    this.ensureAdmBankDepositSupport();
    // v3.2.4 E11-P0：receipt 与 ADM mutation 必须共享当前主库事务域。
    this.ensureReconFixOperationReceiptSupport();
    // v3.0.6 需求1：调拨对账单隐藏表（紧随 ADM 表；幂等 CREATE IF NOT EXISTS，无依赖、不进 ALL_TABLE_KEYS）
    this.ensureFundTransferReconSupport();
    // v3.0.4 块 E 需求2：BOC 链接表两张隐藏表（紧随 ADM 表；幂等 CREATE IF NOT EXISTS，无依赖、不进 ALL_TABLE_KEYS）
    this.ensureBocFxLinkSupport();
    // v2.1.16-beta.3 ①：Channel 枚举字典表（纯审计沉淀；幂等 CREATE IF NOT EXISTS，无依赖）
    this.ensureChannelEnumSupport();
    // v3.0.12 功能2（批A）：账户映射管理全局表（幂等 CREATE IF NOT EXISTS，无依赖、不进 ALL_TABLE_KEYS；批B 才接对账）
    this.ensureFundTransferAccountMappingSupport();
    this.ensurePreFundReconciliationRunMetadataSupport();
      this.ensureDuplicateInboundMatchRunMetadataSupport();
      // v3.2.13：设置 → 模板文件用户版本（幂等 CREATE IF NOT EXISTS，纯新增）
      this.ensureTemplateResourceVersionSupport();
      // v3.2.15：设置 → 账户管理的清结算系统银行账户表（幂等 CREATE IF NOT EXISTS，纯新增）
      this.ensureBankAccountSnapshotSupport();
    }, { onRecord: onStartupPhase });

    const finishVacuumPhase = startStartupPhase('database-vacuum', onStartupPhase);
    // v3.0.5 PR-2（Part B Phase 0 / B-D6）：一次性 VACUUM 主库（止血回收历史删除空洞）
    //   必须在所有 ensure*Support / migrate* 之后（VACUUM 重建文件，之后再执行有界 optimize）
    //   迁移式幂等：标志位已写则跳过；成功才写标志、磁盘不足/失败不写标志 → 下次重试。
    //   ⚠️ 同步阻塞，15GB 预期分钟级；本阶段无用户可见进度框（窗口在 init 完成后才建，Phase 3 未做）。
    try {
      const vacuumResult = this.runOneTimeVacuumIfNeeded();
      if (vacuumResult && vacuumResult.status === 'vacuumed') {
        finishVacuumPhase('success');
        appendModuleLog({
          level: 'info',
          source: 'main',
          domain: 'migration',
          message: '[Phase0 VACUUM] 主库一次性优化完成（首次升级止血）',
          details: [
            `优化前体积: ${formatBytesForLog(vacuumResult.sizeBefore)}`,
            `优化后体积: ${formatBytesForLog(vacuumResult.sizeAfter)}`,
            `耗时: ${(vacuumResult.durationMs / 1000).toFixed(1)}s`
          ]
        });
      } else if (vacuumResult && vacuumResult.status === 'insufficient-disk') {
        finishVacuumPhase('skipped');
        appendModuleLog({
          level: 'warning',
          source: 'main',
          domain: 'migration',
          message: '[Phase0 VACUUM] 磁盘剩余空间不足，跳过本次优化（不写标志位，下次启动重试）',
          details: [
            `当前主库体积: ${formatBytesForLog(vacuumResult.sizeBefore)}`,
            `所需剩余空间(×1.2): ${formatBytesForLog(vacuumResult.requiredFree)}`,
            `实际剩余空间: ${formatBytesForLog(vacuumResult.freeBytes)}`
          ]
        });
      } else if (vacuumResult && vacuumResult.status === 'failed') {
        finishVacuumPhase('failed', { error: vacuumResult.error });
        appendModuleLog({
          level: 'error',
          source: 'main',
          domain: 'migration',
          message: '[Phase0 VACUUM] 优化失败（不写标志位，下次启动重试）',
          details: [
            vacuumResult.error && vacuumResult.error.message
              ? vacuumResult.error.message
              : String(vacuumResult.error)
          ],
          stack: vacuumResult.error && vacuumResult.error.stack ? vacuumResult.error.stack : undefined
        });
      }
      if (vacuumResult && vacuumResult.status === 'already-done') {
        finishVacuumPhase('skipped');
      }
      if (!vacuumResult || ![
        'vacuumed',
        'insufficient-disk',
        'failed',
        'already-done'
      ].includes(vacuumResult.status)) {
        finishVacuumPhase('skipped');
      }
      // already-done：稳态正常路径（每次启动重复触达）→ 静默，不打 log 防噪音
    } catch (vacuumErr) {
      finishVacuumPhase('failed', { error: vacuumErr });
      // 防御：runOneTimeVacuumIfNeeded 自身异常也不阻塞启动，下次重试
      appendModuleLog({
        level: 'error',
        source: 'main',
        domain: 'migration',
        message: '[Phase0 VACUUM] unexpected failure (启动不阻塞，下次启动重试)',
        details: [vacuumErr && vacuumErr.message ? vacuumErr.message : String(vacuumErr)],
        stack: vacuumErr && vacuumErr.stack ? vacuumErr.stack : undefined
      });
    }

    // v3.1.12：有界增量统计。错误必须上抛并进入统一启动失败路径。
    runStartupPhaseSync('database-optimize', () => {
      this.db.exec('PRAGMA optimize=0x10002;');
    }, { onRecord: onStartupPhase });
    } catch (error) {
      // Closing drops connection-local functions even when a migration rolled back.
      try { this.close(); } catch (closeError) { error.closeError = closeError; }
      throw error;
    }
  }

  close() {
    const db = this.db;
    if (!db) return;
    db.close();
    if (this.db === db) this.db = null;
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

  ensureBillSplitFeeBillSupport() {
    return ensureBillSplitFeeBillSupport(this.db);
  }

  ensureBillSplitRowFilterSupport() {
    return ensureBillSplitRowFilterSupport(this.db);
  }

  ensureBillSplitFeeFieldMappingSupport() {
    return ensureBillSplitFeeFieldMappingSupport(this.db);
  }

  ensureParentTemplateSupport() {
    return ensureParentTemplateSupport(this.db);
  }

  ensureTemplateFilenameFixedFieldSupport() {
    return ensureTemplateFilenameFixedFieldSupport(this.db);
  }

  ensureTemplateFeatureFilterSupport() {
    return ensureTemplateFeatureFilterSupport(this.db);
  }

  ensureTemplatePreprocessRowFilterSupport() {
    return ensureTemplatePreprocessRowFilterSupport(this.db);
  }

  ensureAccountMappingTemplateSupport() {
    return ensureAccountMappingTemplateSupport(this.db);
  }

  ensureStatementChannelSupport() {
    return ensureStatementChannelSupport(this.db, (label) => this.createBackup(label));
  }

  hasPendingStatementChannelMigration() {
    return hasPendingStatementChannelMigration(this.db);
  }

  // v3.2.15：失败时回滚并记日志，启动不阻塞，旧标记保留到下次启动重试（同 N5 迁移的处理）；
  //   旧标记保留期间网银账单导入与月度余额装配被阻断（hasPendingStatementChannelMigration，PR #246 审查）。
  //   转换结果逐条写入活动日志：模板名银行段 / 所在地段与渠道不同的模板改按渠道名输出，种子文件不搬移（D5）。
  runStatementChannelMigration() {
    let result;
    try {
      result = this.ensureStatementChannelSupport();
    } catch (error) {
      result = { status: 'migration-failed', error };
    }
    const errorMessage = (error) => (error && error.message ? error.message : String(error));
    if (result.status === 'migrated') {
      appendModuleLog({
        level: 'info',
        source: 'main',
        domain: 'migration',
        message: '[migration v3.2.15] 主模板已转为渠道',
        details: [
          `备份：${result.backupPath || '(none)'}`,
          `渠道：${result.channelCount} 个（新建 ${result.createdChannelCount} 个）`,
          `归入渠道的模板：${result.templateCount} 个`,
          `合并到渠道的账户映射：${result.mergedMappingCount} 条`,
          `待处理的账户映射冲突：${result.conflictCount} 个账户号`,
          ...result.outputChanges.map((change) => {
            const parts = [];
            if (change.fromBankName !== change.toBankName) parts.push(`银行段 ${change.fromBankName || '(空)'} → ${change.toBankName || '(空)'}`);
            if (change.fromLocation !== change.toLocation) parts.push(`所在地 ${change.fromLocation || '(空)'} → ${change.toLocation || '(空)'}`);
            return `模板「${change.templateName}」改按渠道「${change.channelName}」输出：${parts.join('，')}；原银行段的余额种子与余额调整不会自动搬移`;
          })
        ]
      });
    } else if (result.status === 'backup-failed' || result.status === 'migration-failed') {
      appendModuleLog({
        level: 'error',
        source: 'main',
        domain: 'migration',
        message: result.status === 'backup-failed'
          ? '[migration v3.2.15] 备份失败，主模板未转为渠道，下次启动重试；完成前暂停网银账单导入与月度余额装配'
          : '[migration v3.2.15] 主模板转为渠道失败，已回滚，下次启动重试；完成前暂停网银账单导入与月度余额装配',
        details: [
          `备份：${result.backupPath || '(none)'}`,
          errorMessage(result.error)
        ],
        stack: result.error && result.error.stack ? result.error.stack : undefined
      });
    }
    // v1.5.1 账户映射迁移标记：渠道迁移把子模板映射移到渠道层后，若已无普通模板持有模板级映射则清除（每次启动核对，幂等）。
    try {
      if (statementChannelRepository.settleLegacyAccountMappingMigration(this.db)) {
        appendModuleLog({
          level: 'info',
          source: 'main',
          domain: 'migration',
          message: '[migration v3.2.15] 旧账户映射迁移标记已清除：普通模板均无待分配的模板级映射（渠道子模板的映射已在渠道层）'
        });
      }
    } catch (error) {
      appendModuleLog({
        level: 'warning',
        source: 'main',
        domain: 'migration',
        message: '[migration v3.2.15] 核对旧账户映射迁移标记失败，下次启动重试',
        details: [errorMessage(error)]
      });
    }
    return result;
  }

  // v1.5.3 需求 R2：自有账号合并入大账号表 — 幂等 schema 迁移
  ensureTemplateBigAccountNatureSupport() {
    return ensureTemplateBigAccountNatureSupport(this.db);
  }

  // v3.2.16：MerchantId「原始账单仅有币种无账户号」的 币种 → 大账号 配置表
  ensureTemplateCurrencyBigAccountSupport() {
    return ensureTemplateCurrencyBigAccountSupport(this.db);
  }

  // v2.1.12/E03-B：VCC业务OP计算 run/files + save operation receipt
  ensureVccOpCalcTablesSupport() {
    return ensureVccOpCalcTablesSupport(this.db);
  }

  // v3.1.6：VCC财务OP校验表（与旧 VCC业务OP计算完全隔离）。
  ensureVccFinancialOpTablesSupport() {
    return ensureVccFinancialOpTablesSupport(this.db, { autoUpgradeEmptyV1: true });
  }

  // v3.0.3 PR-D（W5）：OneDrive 导出目录提示防重标记 facade
  //   工作目录落在 OneDrive 同步路径时启动后单次提示；'1' = 已提示过。
  hasShownWinOneDriveStorageNotice() {
    return settingsRepository.hasShownWinOneDriveStorageNotice(this.db);
  }

  markWinOneDriveStorageNoticeShown() {
    return settingsRepository.markWinOneDriveStorageNoticeShown(this.db);
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

  listTemplates() {
    return templateRepository.listTemplates(this.db);
  }

  getTemplate(templateId) {
    return templateRepository.getTemplate(this.db, templateId);
  }

  // ===== v3.2.15 网银账单渠道（与对账模块的 listChannels / deleteChannel 等无关）=====
  listStatementChannels() {
    return statementChannelRepository.listChannels(this.db);
  }

  getStatementChannel(channelId) {
    return statementChannelRepository.getChannel(this.db, channelId);
  }

  // 生成前输出名称核对用：不属于渠道的普通模板与全部渠道的身份和名称。
  listStatementOutputOwners() {
    return statementChannelRepository.listOutputOwners(this.db);
  }

  getStatementChannelByName(name) {
    return statementChannelRepository.getChannelByName(this.db, name);
  }

  renameStatementChannel(channelId, name) {
    return statementChannelRepository.renameChannel(this.db, channelId, name);
  }

  deleteStatementChannel(channelId) {
    return statementChannelRepository.deleteChannel(this.db, channelId);
  }

  listStatementChannelTemplates(channelId) {
    return statementChannelRepository.listTemplateIdsByChannel(this.db, channelId)
      .map((item) => templateRepository.getTemplate(this.db, item.id))
      .filter(Boolean);
  }

  createChildTemplate(channelId, { sourceFileName, headers }) {
    const created = statementChannelRepository.createChildTemplate(this.db, channelId, { sourceFileName, headers });
    return { ...created, template: templateRepository.getTemplate(this.db, created.templateId) };
  }

  listStatementChannelAccountMappingConflicts(channelId = null) {
    return statementChannelRepository.listChannelAccountMappingConflicts(this.db, channelId);
  }

  countStatementChannelAccountMappingConflicts(channelId) {
    return statementChannelRepository.countChannelAccountMappingConflicts(this.db, channelId);
  }

  resolveStatementChannelAccountMappingConflicts(channelId, choices) {
    return statementChannelRepository.resolveChannelAccountMappingConflicts(this.db, channelId, choices);
  }

  listEffectiveAccountMappings(template) {
    return statementChannelRepository.listEffectiveAccountMappings(this.db, template);
  }

  // 模板包导入：按包内容恢复渠道、归属与渠道账户映射（§5.3）。
  //   channels：[{ name, accountMappings, accountMappingConflicts }]；legacyChannelSources：[{ name, sources }]（v≤4 主/子转为渠道，合并并登记冲突）。
  //   assignments：[{ templateId, channelName | null }]。单个事务内完成。
  restoreTemplateBundleStatementChannels({ channels = [], legacyChannelSources = [], assignments = [] }) {
    const db = this.db;
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      const channelIdByName = new Map();
      const resolveChannelId = (name) => {
        if (!channelIdByName.has(name)) {
          channelIdByName.set(name, statementChannelRepository.getOrCreateChannelId(db, name, now).channelId);
        }
        return channelIdByName.get(name);
      };
      let conflictCount = 0;
      for (const channel of channels) {
        const channelId = resolveChannelId(channel.name);
        statementChannelRepository.writeChannelAccountMappingRows(db, channelId, channel.accountMappings || [], now);
        statementChannelRepository.replaceChannelAccountMappingConflicts(db, channelId, channel.accountMappingConflicts || [], now);
        conflictCount += statementChannelRepository.countChannelAccountMappingConflicts(db, channelId);
      }
      for (const legacy of legacyChannelSources) {
        const channelId = resolveChannelId(legacy.name);
        // 已有渠道的映射与待处理冲突一并作为来源（与启动迁移相同），包里未涉及的冲突不会被清掉。
        const sources = [
          ...statementChannelRepository.listChannelExistingSources(db, channelId, legacy.name),
          ...(legacy.sources || [])
        ];
        conflictCount += statementChannelRepository
          .replaceChannelAccountMappingsFromSources(db, channelId, sources, now).conflictCount;
      }
      for (const assignment of assignments) {
        const channelId = assignment.channelName ? resolveChannelId(assignment.channelName) : null;
        statementChannelRepository.setTemplateChannel(db, assignment.templateId, channelId);
        if (channelId) db.prepare('DELETE FROM account_mappings WHERE template_id = ?').run(Number(assignment.templateId));
      }
      db.exec('COMMIT');
      return { channelCount: channelIdByName.size, conflictCount };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
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

  // v3.2.18：模板管理【更新】只替换表头，其余配置保留
  updateTemplateHeaders(templateId, { expectedHeaders, headers, sourceFileName }) {
    return templateRepository.updateTemplateHeaders(this.db, templateId, { expectedHeaders, headers, sourceFileName });
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

  getTemplateCurrencyBigAccounts(templateId) {
    return templateRepository.getTemplateCurrencyBigAccounts(this.db, templateId);
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

  // v3.2.18：【特征值管理】即时保存特征值列表；已保存映射的特征值引用（main / split）
  saveTemplateFeatureFilters(templateId, featureFilters) {
    return templateRepository.saveTemplateFeatureFilters(this.db, templateId, featureFilters);
  }

  listTemplateFeatureFilterReferences(templateId, featureFilterMappingValue, options = {}) {
    return templateRepository.listTemplateFeatureFilterReferences(this.db, templateId, featureFilterMappingValue, options);
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

  setBillSplitFeeBillRow(templateId, seqNo) {
    return templateRepository.setBillSplitFeeBillRow(this.db, templateId, seqNo);
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

  restoreBillSplitEditableConfig(templateId, snapshot) {
    return templateRepository.restoreBillSplitEditableConfig(this.db, templateId, snapshot);
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

  getDarkModeSchedule() {
    return settingsRepository.getDarkModeSchedule(this.db);
  }

  setDarkModeSchedule(config) {
    return settingsRepository.setDarkModeSchedule(this.db, config);
  }

  getDarkModeLightness() {
    return settingsRepository.getDarkModeLightness(this.db);
  }

  setDarkModeLightness(lightness) {
    return settingsRepository.setDarkModeLightness(this.db, lightness);
  }

  getAutoUpdateEnabled() {
    return settingsRepository.getAutoUpdateEnabled(this.db);
  }

  setAutoUpdateEnabled(enabled) {
    return settingsRepository.setAutoUpdateEnabled(this.db, enabled);
  }

  getReleaseNotesAcknowledgedVersion() {
    return settingsRepository.getReleaseNotesAcknowledgedVersion(this.db);
  }

  setReleaseNotesAcknowledgedVersion(version) {
    return settingsRepository.setReleaseNotesAcknowledgedVersion(this.db, version);
  }

  getReleaseNotesLastUpgrade() {
    return settingsRepository.getReleaseNotesLastUpgrade(this.db);
  }

  recordReleaseNotesUpgrade(upgrade) {
    return settingsRepository.recordReleaseNotesUpgrade(this.db, upgrade);
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

  // v3.2.15：scope 为 { templateId } 或 { channelId }；传数字视为模板（兼容旧调用）。
  listAccountMappings(scope) {
    const normalized = normalizeAccountMappingScope(scope);
    if (normalized.channelId) {
      return statementChannelRepository.listChannelAccountMappings(this.db, normalized.channelId);
    }
    return settingsRepository.listAccountMappings(this.db, normalized.templateId);
  }

  // v3.2.15：含渠道层账户映射。
  countAllAccountMappings() {
    const row = this.db.prepare(`
      SELECT
        (SELECT COUNT(1) FROM account_mappings)
        + (SELECT COUNT(1) FROM statement_channel_account_mappings) AS cnt
    `).get();
    return row ? Number(row.cnt) : 0;
  }

  saveAccountMappings(scope, mappings) {
    const normalized = normalizeAccountMappingScope(scope);
    if (normalized.channelId) {
      return statementChannelRepository.saveChannelAccountMappings(this.db, normalized.channelId, mappings);
    }
    return settingsRepository.saveAccountMappings(this.db, normalized.templateId, mappings);
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

  // v3.1.1：canonical 调拨回填 owner 修复迁移 facade。
  ensureFundTransferBackfillCanonicalOwner() {
    return ensureFundTransferBackfillCanonicalOwner(this.db);
  }

  // v2.1.16-beta.4 ③：中台退款订单回填场景独立补种（默认休眠 enabled=0，🔴 资金红线）
  ensureRefundBackfillScenarioSeed() {
    return ensureRefundBackfillScenarioSeed(this.db);
  }

  // v2.1.16-beta.5 需求4：JPM 调拨订单修复写死场景独立补种（默认休眠 enabled=0，🔴 资金红线）
  ensureJpmDispatchOrderScenarioSeed() {
    return ensureJpmDispatchOrderScenarioSeed(this.db);
  }

  // v3.0.4 块 E 需求1：BOC 调拨订单修复写死场景独立补种（默认休眠 enabled=0，🔴 资金红线）
  ensureBocDispatchOrderScenarioSeed() {
    return ensureBocDispatchOrderScenarioSeed(this.db);
  }

  // v3.0.6 需求3（T9）：DBS-Charge 资金校验写死场景独立补种（默认 enabled=1，🔴 资金红线 → R3.5）
  ensureDbsChargeFundCheckScenarioSeed() {
    return ensureDbsChargeFundCheckScenarioSeed(this.db);
  }

  // v3.0.6 需求3（T9）：每次启动幂等 DELETE 已废弃 charge-outbound 内置孤儿场景（含级联删关联表，🔴 资金红线 + 破坏性，不删用户/DBS-Charge 场景）
  retireChargeOutboundOrphans() {
    return retireChargeOutboundOrphans(this.db);
  }

  // v2.1.16-beta.2 §FundType：一次性修存量 config 错拼 'Ach Ruturn' → 'Ach Return'（🔴 资金红线）
  ensureFundTypeAchReturnConfigMigration() {
    return ensureFundTypeAchReturnConfigMigration(this.db);
  }

  // v3.0.10 方向字段历史兼容补种（无 marker 幂等补缺失，绝不覆盖用户值）。
  ensureR4DirectionGuardConfigMigration() {
    return ensureR4DirectionGuardConfigMigration(this.db);
  }

  // v3.0.23：只刷新四个内置 R4 场景 config.function，其它字段保持。
  ensureR4StrictDescriptionMigration() {
    return ensureR4StrictDescriptionMigration(this.db);
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

  ensureC3GwFieldCurrencyCaseRevert() {
    return ensureC3GwFieldCurrencyCaseRevert(this.db);
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

  // v3.0.5 需求1：银行对账单入金表「按 BizId 幂等 upsert」（数组版，同步）——累加不整表覆盖。
  //   返回 { upserted, overwriteCount, rejectedEmptyCount, rowCount, dataDateMin, dataDateMax, updatedAt }。
  upsertLinkedBankDeposit(rows, options) {
    return linkedTableRepository.upsertLinkedBankDeposit(this.db, rows, options || {});
  }

  // v3.0.5 需求1：银行对账单入金表「按 BizId 幂等 upsert」（流式版，async）。
  //   🔴🔴 资金红线（R-6）：65.7 万行单事务跨 await；feedRows 中途 throw → ROLLBACK，表保持调用前状态。
  upsertLinkedBankDepositStreaming(feedRows, options) {
    return linkedTableRepository.upsertLinkedBankDepositStreaming(this.db, feedRows, options || {});
  }

  // v3.0.5 需求2：外汇交割表「按交易编号幂等 upsert」（仅数组版，同步；fx 永不流式）——累加不整表覆盖。
  //   返回 { upserted, overwriteCount, rejectedEmptyCount, rowCount, dataDateMin, dataDateMax, updatedAt }。
  upsertLinkedFx(rows, options) {
    return linkedTableRepository.upsertLinkedFx(this.db, rows, options || {});
  }

  // v3.0.5 需求（OPEN-7 / T5a）：银行对账单入金表「跨期重复命中提醒」命中标记读（bizIds → Map<bizId,{last_hit_run,last_hit_at}>）。
  readBankDepositHitMarkers(bizIds) {
    return linkedTableRepository.readBankDepositHitMarkers(this.db, bizIds);
  }

  // v3.0.5 需求（OPEN-7 / T5a）：命中标记写（bizIds 批量 UPDATE last_hit_run/last_hit_at，仅已存在行；返回 { marked }）。
  markBankDepositHits(bizIds, runId, atIso) {
    return linkedTableRepository.markBankDepositHits(this.db, bizIds, runId, atIso);
  }

  // v3.0.5 需求（OPEN-7 / T5a）：命中标记清（bizIds 批量置 NULL；本批不接线，OPEN-4 删除联动批次4 接入；返回 { cleared }）。
  clearBankDepositHitMarkersByBizIds(bizIds) {
    return linkedTableRepository.clearBankDepositHitMarkersByBizIds(this.db, bizIds);
  }

  // v3.0.1 需求1 / task4：按数据日期范围统计将删行数（只读，前端删除弹框预览「将删约 N 行」）。
  countGatewayBillByDateRange(startDate, endDate) {
    return linkedTableRepository.countGatewayBillByDateRange(this.db, startDate, endDate);
  }

  // v3.0.1 需求1 / task4：🔴 资金红线——按数据日期闭区间删除网关对账单行（不可逆，单事务，删后 meta 全表重算）。
  deleteGatewayBillByDateRange(startDate, endDate, options) {
    return linkedTableRepository.deleteGatewayBillByDateRange(this.db, startDate, endDate, options || {});
  }

  // v3.0.5 OPEN-4（T6a）：按 transaction_date 闭区间统计 fx 将删行数（只读预览，前端删除弹框「将删约 N 行」）。
  countFxByDateRange(startDate, endDate) {
    return linkedTableRepository.countFxByDateRange(this.db, startDate, endDate);
  }

  // v3.0.5 OPEN-4（T6a）：按 bill_date 闭区间统计 bank-deposit 将删行数（只读预览）。
  countBankDepositByDateRange(startDate, endDate) {
    return linkedTableRepository.countBankDepositByDateRange(this.db, startDate, endDate);
  }

  // v3.0.5 OPEN-4（T6a）：🔴🔴 资金红线——按 transaction_date 闭区间删除外汇交割表行（不可逆，单事务）+ 联动删 BOC 派生表
  //   （按 transaction_no IN 被删行的交易编号，绝不按 maturity_date/日期）。返回含 deletedTxnNos / bocDeleted（T6b 派生重建用）。
  deleteFxByDateRange(startDate, endDate, options) {
    return linkedTableRepository.deleteFxByDateRange(this.db, startDate, endDate, options || {});
  }

  // v3.0.5 OPEN-4（T6a）：🔴 资金红线——按 bill_date 闭区间删除银行对账单入金表行（不可逆，单事务，删后 meta 全表重算）。
  //   返回含 deletedBizIds（T6b 用于清 OPEN-7 命中标记 / ADM·BOC bank 派生重建）。
  deleteBankDepositByDateRange(startDate, endDate, options) {
    return linkedTableRepository.deleteBankDepositByDateRange(this.db, startDate, endDate, options || {});
  }

  // v2.1.16-beta.2 T1：读回某 tableKey 全部整行（raw_json → 对象，字段名 = 真实表头）；
  //   fx-option 返回 []；损坏行跳过。供 5 轮对账编排器取网关数据源（'gateway-bill'）。
  readLinkedTableRows(tableKey) {
    return linkedTableRepository.readLinkedTableRows(this.db, tableKey);
  }

  // v3.0.14 前置资金对账：持久化网关账单游标，避免全表对象数组常驻内存。
  iterateGatewayBillRows() {
    return linkedTableRepository.iterateGatewayBillRows(this.db);
  }

  listGatewayBillSourceTags() {
    return linkedTableRepository.listGatewayBillSourceTags(this.db);
  }

  getGatewayBillRawJsonById(rowId) {
    return linkedTableRepository.getGatewayBillRawJsonById(this.db, rowId);
  }

  // v3.0.0 块 B / PR-3：ADM 派生内存优化 facade（Channel=ADM 下推过滤 / 轻量存在性探测）
  readBankDepositAdmCandidates() {
    return linkedTableRepository.readBankDepositAdmCandidates(this.db);
  }

  // v3.0.7 需求6：网关账单表按 Channel 集合下推过滤读 facade（业务不变量=对账同渠道；防 300 万行全量尖峰）。
  //   供 bank-statement:run 取网关数据源（替代 readLinkedTableRows('gateway-bill') 全量读 + 深拷）。
  readGatewayBillRowsByChannels(channels) {
    return linkedTableRepository.readGatewayBillRowsByChannels(this.db, channels);
  }

  // v3.0.23：银行对账运行一次读取 exactRows + C3 大小写不敏感候选池。
  //   v3.2.22：options.outOfPoolDiagnostic 时同一次扫描另把 R5s2 缺渠道诊断候选交给其 collect（见仓储同名函数注释）。
  readGatewayBillRowPoolsByChannels(channels, options) {
    return linkedTableRepository.readGatewayBillRowPoolsByChannels(this.db, channels, options);
  }

  // v3.2.22：R5s2 缺渠道诊断按暂存的候选 id 回读网关行（逐行回调，不累积）。
  readGatewayBillRowsByIds(ids, onRow) {
    return linkedTableRepository.readGatewayBillRowsByIds(this.db, ids, onRow);
  }

  hasLinkedTableRows(tableKey) {
    return linkedTableRepository.hasLinkedTableRows(this.db, tableKey);
  }

  // v2.1.16-beta.5 需求3：ADM 银行对账单隐藏表 facade（建表 + 仓储三函数转发）
  ensureAdmBankDepositSupport() {
    return ensureAdmBankDepositSupport(this.db);
  }

  // v3.2.4 E11-P0：JPM ADM operation receipt 加法 schema。
  ensureReconFixOperationReceiptSupport() {
    return ensureReconFixOperationReceiptSupport(this.db);
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

  // v3.0.6 需求1：调拨对账单隐藏表 facade（建表 + 仓储两函数转发）
  ensureFundTransferReconSupport() {
    return ensureFundTransferReconSupport(this.db);
  }

  // 调拨对账单整表覆盖写入（rows = buildFundTransferReconRows 产物，每单 in/out 两行）；7 列 INSERT，整表重建
  replaceFundTransferReconRows(rows, options) {
    return linkedTableRepository.replaceFundTransferReconRows(this.db, rows, options || {});
  }

  // 读回调拨对账单全部整行（raw_json → 对象）；供需求2/3 引擎匹配；损坏行跳过
  readFundTransferReconRows() {
    return linkedTableRepository.readFundTransferReconRows(this.db);
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

  // v3.0.5 批次2b：BOC链接表幂等 upsert（按 transaction_no，同键覆盖 id 不变，含 orig_group_no）
  upsertBocFxLink(rows) {
    return linkedTableRepository.upsertBocFxLink(this.db, rows);
  }

  // v3.0.5 批次2b：取现有最大 orig_group_no（scan offset 续编用）
  getMaxBocFxOrigGroupNo() {
    return linkedTableRepository.getMaxBocFxOrigGroupNo(this.db);
  }

  // v3.0.5 批次2b：读全库 BOC 行供全量重匹配（[{ id, row }]，row 注入 __origGroup 辅助键，按 id ASC）
  readBocFxLinkRowsForRematch() {
    return linkedTableRepository.readBocFxLinkRowsForRematch(this.db);
  }

  // v3.0.5 批次2b：全量重匹配后按 id 回写 group_no/allocation_no + raw_json（不碰 recon_link_id/orig_group_no）
  writeBocFxLinkGroupRematch(rowsWithIds) {
    return linkedTableRepository.writeBocFxLinkGroupRematch(this.db, rowsWithIds);
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

  // v3.0.12 功能2（批A）：账户映射管理 facade（建表 + 仓储三函数转发）。
  //   全局对照表「中台调拨单账户号 → 清结算系统银行账号」；批B 才把 getFundTransferAccountMappingMap 喂给调拨派生。
  ensureFundTransferAccountMappingSupport() {
    return ensureFundTransferAccountMappingSupport(this.db);
  }

  ensurePreFundReconciliationRunMetadataSupport() {
    return ensurePreFundReconciliationRunMetadataSupport(this.db);
  }

  ensureDuplicateInboundMatchRunMetadataSupport() {
    return ensureDuplicateInboundMatchRunMetadataSupport(this.db);
  }

  ensureTemplateResourceVersionSupport() {
    return ensureTemplateResourceVersionSupport(this.db);
  }

  ensureBankAccountSnapshotSupport() {
    return ensureBankAccountSnapshotSupport(this.db);
  }

  // v3.2.15：设置 → 账户管理的清结算系统银行账户表 facade（原文件由账户管理服务管理）
  readBankAccountSnapshot() {
    return bankAccountRepository.readSnapshot(this.db);
  }

  listBankAccountChannels() {
    return bankAccountRepository.listChannels(this.db);
  }

  countBankAccountRows(options) {
    return bankAccountRepository.countRows(this.db, options);
  }

  listBankAccountRows(options) {
    return bankAccountRepository.listRows(this.db, options);
  }

  replaceBankAccountSnapshot(payload) {
    return bankAccountRepository.replaceSnapshot(this.db, payload);
  }

  // v3.2.13：设置 → 模板文件用户版本 facade（版本元数据、当前指针与变更记录；文件由模板服务管理）
  listScenarioConfigs() {
    return scenariosRepository.listScenarioConfigs(this.db);
  }

  listTemplateResourceVersions() {
    return templateResourceRepository.listVersions(this.db);
  }

  listTemplateResourceStates() {
    return templateResourceRepository.listStates(this.db);
  }

  commitTemplateResourceVersion(payload) {
    return templateResourceRepository.commitVersion(this.db, payload);
  }

  setTemplateResourceCurrentVersion(payload) {
    return templateResourceRepository.setCurrentVersion(this.db, payload);
  }

  deleteTemplateResourceVersion(payload) {
    return templateResourceRepository.deleteVersion(this.db, payload);
  }

  appendTemplateResourceChange(change) {
    return templateResourceRepository.appendChange(this.db, change);
  }

  listTemplateResourceChanges(limit, resourceIds) {
    return templateResourceRepository.listChanges(this.db, limit, resourceIds);
  }

  createPreFundReconciliationRunMirror(payload) {
    return preFundReconciliationRunRepository.createRunMirror(this.db, payload);
  }

  createLegacyPreFundReconciliationRunMirror(payload) {
    return preFundReconciliationRunRepository.createLegacyRunMirror(this.db, payload);
  }

  finishPreFundReconciliationRunMirror(mirrorId, summary) {
    return preFundReconciliationRunRepository.finishRunMirror(this.db, mirrorId, summary);
  }

  failPreFundReconciliationRunMirror(mirrorId, error) {
    return preFundReconciliationRunRepository.failRunMirror(this.db, mirrorId, error);
  }

  markPreFundReconciliationRunMirrorUnavailable(mirrorId, status, message) {
    return preFundReconciliationRunRepository.markRunMirrorUnavailable(
      this.db,
      mirrorId,
      status,
      message
    );
  }

  getPreFundReconciliationRunMirror(mirrorId) {
    return preFundReconciliationRunRepository.getRunMirror(this.db, mirrorId);
  }

  getPreFundReconciliationRunMirrorByTaskRun(taskRunId) {
    return preFundReconciliationRunRepository.getRunMirrorByArchiveTaskRunId(this.db, taskRunId);
  }

  acknowledgePreFundReconciliationRunMirror(mirrorId, taskRunId) {
    return preFundReconciliationRunRepository.acknowledgeArchiveTerminal(
      this.db,
      mirrorId,
      taskRunId
    );
  }

  listPreFundReconciliationRunMirrors() {
    return preFundReconciliationRunRepository.listRunMirrors(this.db);
  }

  createDuplicateInboundMatchRunMirror(payload) {
    return duplicateInboundMatchRunRepository.createRunMirror(this.db, payload);
  }

  createCommittedDuplicateInboundMatchRunMirror(payload) {
    return duplicateInboundMatchRunRepository.createCommittedRunMirror(this.db, payload);
  }

  finishDuplicateInboundMatchRunMirror(mirrorId, summary) {
    return duplicateInboundMatchRunRepository.finishRunMirror(this.db, mirrorId, summary);
  }

  failDuplicateInboundMatchRunMirror(mirrorId, error) {
    return duplicateInboundMatchRunRepository.failRunMirror(this.db, mirrorId, error);
  }

  markDuplicateInboundMatchRunMirrorUnavailable(mirrorId, status, message) {
    return duplicateInboundMatchRunRepository.markRunMirrorUnavailable(
      this.db,
      mirrorId,
      status,
      message
    );
  }

  getDuplicateInboundMatchRunMirror(mirrorId) {
    return duplicateInboundMatchRunRepository.getRunMirror(this.db, mirrorId);
  }

  listDuplicateInboundMatchRunMirrors() {
    return duplicateInboundMatchRunRepository.listRunMirrors(this.db);
  }

  getDuplicateInboundMatchRecoveryAuditByOperation(actionKey, operationKey, taskRunId) {
    return duplicateInboundMatchRunRepository.getRecoveryAuditByOperation(
      this.db, actionKey, operationKey, taskRunId
    );
  }

  getDuplicateInboundMatchRecoveryAuditBySource(sourceRef) {
    return duplicateInboundMatchRunRepository.getRecoveryAuditBySource(this.db, sourceRef);
  }

  listFundTransferAccountMappings() {
    return fundTransferAccountMappingRepository.listMappings(this.db);
  }

  saveFundTransferAccountMappings(mappings) {
    return fundTransferAccountMappingRepository.saveMappings(this.db, mappings);
  }

  getFundTransferAccountMappingMap() {
    return fundTransferAccountMappingRepository.getMappingMap(this.db);
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

  // v3.0.7 需求2d（🔴🔴 资金红线）：判定 44 列银行对账单文件是否为「入金表」（Channel 二次路由谓词）。
  //   不依赖 db；逐行 Channel+地区 判定（ADM/BOC 按裸 Channel 忽略地区，JPM 仅 US），
  //   命中 → 落 bank-deposit 链接表；否则 → 走 R1-R5 预处理。bank-deposit 文件判定的唯一真相。
  isBankDepositChannelFile(rows) {
    return channelEnumRepository.isBankDepositChannelFile(rows);
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

  // v3.0.5 PR-2（Part B Phase 0 / B-D6）：一次性 VACUUM 主库（止血，回收历史删除空洞）
  //
  // 背景（spec size-startup-optimization §B.1）：本机主库 15GB，freelist_count 2,407,169 页
  //   ≈ 9.86GB（61%）为删除后未回收空洞；全代码无空间回收机制（VACUUM 仅出现在备份 VACUUM INTO）。
  //   注意：这只是「止血」——结构性解法是 run 级数据出主库（Phase 1/2），第二次 VACUUM 顺延下一版本收口到 MB 级。
  //
  // 迁移式幂等（B-D6）：app_settings 单键标志位 db_one_time_vacuum_v3_0_5_done = '1'，
  //   沿用 settings-repository 既有单键布尔范式（hasShownWinOneDriveStorageNotice / markWinOneDriveStorageNoticeShown）。
  //   - 已写标志位 → 永久跳过（status='already-done'）。
  //   - 成功执行后才写标志位；任何失败路径都不写 → 下次启动重试。
  //
  // 安全前置（fail-open，新增项）：VACUUM 需要约「当前 DB 文件大小」的临时双倍峰值空间，
  //   这里要求剩余磁盘 ≥ 当前 DB 文件大小 × 1.2，不足则跳过（status='insufficient-disk'）+ **不写标志位**（下次重试）。
  //
  // ⚠️ VACUUM 不能在事务内执行；DatabaseSync 是同步 API → 本调用会阻塞主进程（15GB 预期分钟级）。
  //   本阶段窗口在 init 完成后才创建（Phase 3 未做），无用户可见进度框 —— 沿用 N5/N4-cont-2 既有「无提示、
  //   窗口延后出现」的升级首启口径（详见 PR 汇报「UI 提示落点」说明）。
  //
  // 入参（均可注入，便于单测）：
  //   - diskCheck()：返回剩余可用磁盘字节数；默认用 fs.statfsSync(dbDir)。抛错则视为「无法判断」→ fail-open 放行。
  //   - flagKey：标志位 key（默认 ONE_TIME_VACUUM_FLAG_KEY）。
  // 返回：{ status, ... }，由调用方据此写 activity log。
  runOneTimeVacuumIfNeeded(options = {}) {
    if (!this.db) throw new Error('AppDatabase.runOneTimeVacuumIfNeeded: db 未初始化');
    const flagKey = options.flagKey || ONE_TIME_VACUUM_FLAG_KEY;

    // 幂等：标志位已写 → 永久跳过
    if (settingsRepository.getSetting(this.db, flagKey) === '1') {
      return { status: 'already-done' };
    }

    // 当前 DB 文件大小（VACUUM 前）
    let sizeBefore = 0;
    try {
      sizeBefore = fs.statSync(this.dbPath).size;
    } catch (_e) {
      sizeBefore = 0; // 取不到（极少数）→ 后续磁盘检查放行
    }

    // 安全前置：剩余磁盘 ≥ DB 文件大小 × 1.2，不足则跳过且不写标志（fail-open：检查本身失败也放行）
    const requiredFree = Math.ceil(sizeBefore * VACUUM_DISK_HEADROOM_RATIO);
    let freeBytes = null;
    try {
      const diskCheck =
        typeof options.diskCheck === 'function'
          ? options.diskCheck
          : () => {
              const stat = fs.statfsSync(path.dirname(this.dbPath));
              return stat.bavail * stat.bsize;
            };
      freeBytes = diskCheck();
    } catch (_e) {
      freeBytes = null; // 无法判断磁盘 → fail-open 放行
    }
    if (freeBytes != null && Number.isFinite(freeBytes) && freeBytes < requiredFree) {
      return {
        status: 'insufficient-disk',
        sizeBefore,
        requiredFree,
        freeBytes,
      };
    }

    // 执行 VACUUM（不能在事务内；同步阻塞）
    const startedAt = Date.now();
    try {
      this.db.exec('VACUUM;');
      // WAL 模式下 VACUUM 写入 WAL，主库文件大小要等 checkpoint 才回收。
      // 主动 wal_checkpoint(TRUNCATE) 让磁盘空间「即时减负」（PRD §5.2 止血目标）；
      // TRUNCATE 失败不影响正确性（下次自然 checkpoint），仅吞掉不让其打断成功路径。
      try {
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      } catch (_ckptErr) { /* swallow：checkpoint 失败不影响 VACUUM 正确性 */ }
    } catch (vacuumErr) {
      // 失败不写标志 → 下次启动重试
      return { status: 'failed', sizeBefore, error: vacuumErr };
    }
    const durationMs = Date.now() - startedAt;

    let sizeAfter = sizeBefore;
    try {
      sizeAfter = fs.statSync(this.dbPath).size;
    } catch (_e) {
      sizeAfter = sizeBefore;
    }

    // 成功 → 写标志位（永久跳过后续启动）
    settingsRepository.setSetting(this.db, flagKey, '1');

    return {
      status: 'vacuumed',
      sizeBefore,
      sizeAfter,
      durationMs,
      freeBytes,
      requiredFree,
    };
  }
}

module.exports = {
  AppDatabase,
  // v3.0.5 PR-2（Part B Phase 0 / B-D6）：一次性 VACUUM 标志位 key（单测 + main.js 可引用）
  ONE_TIME_VACUUM_FLAG_KEY
};
