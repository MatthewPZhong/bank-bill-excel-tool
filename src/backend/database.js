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
  ensureAcquiringBillCurrencyRunsSideDbPath,
  // v3.0.5 PR-4（Part B Phase 2）：bank-bu / biz-op runs 表加 side_db_rel_path 列（侧库镜像）
  ensureBankBuReconRunsSideDbPath,
  ensureBizOpReconRunsSideDbPath,
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
  // v3.0.4 块 E 需求1：BOC 调拨订单修复写死场景独立补种（默认休眠 enabled=0，category=gateway-recon-id-fix）
  ensureBocDispatchOrderScenarioSeed,
  // v3.0.6 需求3（T9）：DBS-Charge 资金校验写死场景独立补种（默认 enabled=1，category=builtin-fixed → R3.5）
  ensureDbsChargeFundCheckScenarioSeed,
  // v3.0.6 需求3（T9）：每次启动幂等 DELETE 已废弃 charge-outbound 内置孤儿（含级联删关联表，无 marker；不删用户/DBS-Charge 场景）
  retireChargeOutboundOrphans,
  // v2.1.16-beta.2 §FundType：一次性修存量 config 错拼 'Ach Ruturn' → 'Ach Return'
  ensureFundTypeAchReturnConfigMigration,
  // v2.1.10 N4-cont-2 T30：diff_rows FK ON DELETE CASCADE 改造
  ensureDiffRowsCascadeMigration_v2_1_10,
  // v2.1.16 阶段一 A3：链接表持久化建表（v2.1.16-beta.3 ②：含入金表 linked_bank_deposit）
  ensureLinkedTableSupport,
  // v2.1.16-beta.5 需求3：ADM 银行对账单隐藏表建表（独立幂等迁移）
  ensureAdmBankDepositSupport,
  ensureFundTransferReconSupport,
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
    // v2.1.2 T2：月度银行对账单BU回填校验模块 3 张表
    // 与其他迁移完全独立，调用顺序无依赖；放在最末尾即可
    this.ensureBankBuReconTablesSupport();
    // v3.0.5 PR-4（Part B Phase 2）：bank_bu_recon_runs 加 side_db_rel_path 列（侧库镜像；NULL=历史主库 run）
    //   必须在 ensureBankBuReconTablesSupport 之后（依赖 runs 表已存在）；轻量加列幂等
    this.ensureBankBuReconRunsSideDbPath();
    // v2.1.12 需求1 T-vcc-1：VCC业务OP计算模块 2 张表 + 2 索引（与现有 5 模块表完全隔离，调用顺序无依赖）
    this.ensureVccOpCalcTablesSupport();
    // v2.1.3 T1：业务OP数据核对模块 4 张表（imports / flow_imports / runs / diff_rows）
    // 与 v2.1.2 bank_bu_recon_* 完全独立，调用顺序无依赖
    this.ensureBizOpReconTablesSupport();
    // v3.0.5 PR-4（Part B Phase 2）：biz_op_recon_runs 加 side_db_rel_path 列（侧库镜像；NULL=历史主库 run）
    //   必须在 ensureBizOpReconTablesSupport 之后（依赖 runs 表已存在）；轻量加列幂等
    this.ensureBizOpReconRunsSideDbPath();
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
    // v3.0.5 PR-3（Part B Phase 1）：runs.side_db_rel_path 列（per-月侧库元数据；NULL=历史主库 run 双源过渡）
    //   必须在 ensureAcquiringBillCurrencyTablesSupport 之后（依赖 runs 表已存在）；轻量加列幂等
    this.ensureAcquiringBillCurrencyRunsSideDbPath();
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
    // v3.0.6 需求1：调拨对账单隐藏表（紧随 ADM 表；幂等 CREATE IF NOT EXISTS，无依赖、不进 ALL_TABLE_KEYS）
    this.ensureFundTransferReconSupport();
    // v3.0.4 块 E 需求2：BOC 链接表两张隐藏表（紧随 ADM 表；幂等 CREATE IF NOT EXISTS，无依赖、不进 ALL_TABLE_KEYS）
    this.ensureBocFxLinkSupport();
    // v2.1.16-beta.3 ①：Channel 枚举字典表（纯审计沉淀；幂等 CREATE IF NOT EXISTS，无依赖）
    this.ensureChannelEnumSupport();
    // v3.0.5 PR-2（Part B Phase 0 / B-D6）：一次性 VACUUM 主库（止血回收历史删除空洞）
    //   必须在所有 ensure*Support / migrate* 之后（VACUUM 重建文件，之后再 ANALYZE 重统计）
    //   迁移式幂等：标志位已写则跳过；成功才写标志、磁盘不足/失败不写标志 → 下次重试。
    //   ⚠️ 同步阻塞，15GB 预期分钟级；本阶段无用户可见进度框（窗口在 init 完成后才建，Phase 3 未做）。
    try {
      const vacuumResult = this.runOneTimeVacuumIfNeeded();
      if (vacuumResult && vacuumResult.status === 'vacuumed') {
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
      // already-done：稳态正常路径（每次启动重复触达）→ 静默，不打 log 防噪音
    } catch (vacuumErr) {
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

  // v3.0.5 PR-4（Part B Phase 2）：bank_bu_recon_runs 加 side_db_rel_path 列（侧库镜像）
  ensureBankBuReconRunsSideDbPath() {
    return ensureBankBuReconRunsSideDbPath(this.db);
  }

  // v2.1.12 需求1 T-vcc-1：VCC业务OP计算模块 2 张表（runs / run_files）+ 2 索引
  ensureVccOpCalcTablesSupport() {
    return ensureVccOpCalcTablesSupport(this.db);
  }

  // v2.1.3 T1：业务OP数据核对模块 4 张表（imports / flow_imports / runs / diff_rows）
  ensureBizOpReconTablesSupport() {
    return ensureBizOpReconTablesSupport(this.db);
  }

  // v3.0.5 PR-4（Part B Phase 2）：biz_op_recon_runs 加 side_db_rel_path 列（侧库镜像）
  ensureBizOpReconRunsSideDbPath() {
    return ensureBizOpReconRunsSideDbPath(this.db);
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

  // v3.0.5 PR-3（Part B Phase 1）：runs.side_db_rel_path 列 migration — 启动期幂等 ADD COLUMN（per-月侧库元数据）
  ensureAcquiringBillCurrencyRunsSideDbPath() {
    return ensureAcquiringBillCurrencyRunsSideDbPath(this.db);
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
