const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  ensureAccountMappingCurrencySupport,
  ensureAccountMappingTemplateSupport,
  ensureAcquiringBillCurrencyTablesSupport,
  ensureAmountSplitRulesSupport,
  ensureBankBuReconTablesSupport,
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
  ensureAcquiringBillCurrencyRunsChunkProgress,
  ensureBillRawJsonV2Slim,
  ensureSchemaV2_1_9_N5,
  ensureScenariosNameUniqueByChannelId,
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
    //   PRAGMA 顺序固定：foreign_keys → journal_mode(WAL) → synchronous(NORMAL) → cache_size → mmap_size
    //   ⚠️ synchronous=NORMAL 必须在 WAL 之后（DELETE/FULL 模式下 NORMAL 不安全；spec §7.3 关键不变量）
    //   journal_mode=WAL 持久化在 DB 元数据，首次启动后即生效；产生 *.sqlite-wal + *.sqlite-shm 旁文件（用户备份提示见 USER_GUIDE §DB 备份）
    this.db.exec('PRAGMA journal_mode = WAL;');        // 读写并发更好；崩溃恢复保留
    this.db.exec('PRAGMA synchronous = NORMAL;');      // WAL 下安全 + 性能 2-3 倍
    this.db.exec('PRAGMA cache_size = -65536;');       // 64MB 页缓存（负数 = KB；-65536 = 64MB）
    this.db.exec('PRAGMA mmap_size = 268435456;');     // 256MB 内存映射（64-bit 环境）
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
    // v2.1.2 T2：月度银行对账单BU回填校验模块 3 张表
    // 与其他迁移完全独立，调用顺序无依赖；放在最末尾即可
    this.ensureBankBuReconTablesSupport();
    // v2.1.3 T1：业务OP数据核对模块 4 张表（imports / flow_imports / runs / diff_rows）
    // 与 v2.1.2 bank_bu_recon_* 完全独立，调用顺序无依赖
    this.ensureBizOpReconTablesSupport();
    // v2.1.6 T4：收单单据币种校验模块 4 张表（flow_imports / bill_imports / runs / diff_rows）
    // 与 v2.1.2/v2.1.3 完全独立，调用顺序无依赖
    this.ensureAcquiringBillCurrencyTablesSupport();
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

  // v2.1.3 T1：业务OP数据核对模块 4 张表（imports / flow_imports / runs / diff_rows）
  ensureBizOpReconTablesSupport() {
    return ensureBizOpReconTablesSupport(this.db);
  }

  // v2.1.6 T4：收单单据币种校验模块 4 张表（flow_imports / bill_imports / runs / diff_rows）
  ensureAcquiringBillCurrencyTablesSupport() {
    return ensureAcquiringBillCurrencyTablesSupport(this.db);
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

  // v2.1.10 A4 T19：runs.chunk_progress 列 migration — 启动期幂等 ADD COLUMN
  ensureAcquiringBillCurrencyRunsChunkProgress() {
    return ensureAcquiringBillCurrencyRunsChunkProgress(this.db);
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

  setUiStyle(style) {
    return settingsRepository.setUiStyle(this.db, style);
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
