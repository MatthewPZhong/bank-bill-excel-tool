// v2.1.9 SR-log-1 (T32h)：替换 console.warn → appendModuleLog 双写
const { appendModuleLog } = require('../logger');

function getSetting(db, settingKey) {
  const row = db
    .prepare(`
      SELECT setting_value AS settingValue
      FROM app_settings
      WHERE setting_key = ?
    `)
    .get(settingKey);

  return row ? row.settingValue : null;
}

function setSetting(db, settingKey, settingValue) {
  const now = new Date().toISOString();
  db
    .prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE
      SET setting_value = excluded.setting_value,
          updated_at = excluded.updated_at
    `)
    .run(settingKey, settingValue, now);
}

function getEnumConfig(db) {
  const raw = getSetting(db, 'enum_config');

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function setEnumConfig(db, enumConfig) {
  setSetting(db, 'enum_config', JSON.stringify(enumConfig));
}

function getBackgroundConfig(db) {
  const raw = getSetting(db, 'background_config');

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function setBackgroundConfig(db, backgroundConfig) {
  setSetting(db, 'background_config', JSON.stringify(backgroundConfig));
}

// v2.1.15 W4：弃用 General 风格，UI 风格恒为 'Clear'。
//   - 移除「切换页面风格」入口与 setUiStyle 写链路（不再有任何路径写入 'General'）。
//   - 持久化兼容：老库 ui_style 可能存了 'General'（或其它历史/非法值），
//     getUiStyle 一律无声归一为 'Clear'，不抛错，不让老用户报错。
const UI_STYLE_KEY = 'ui_style';
const UI_STYLE_DEFAULT = 'Clear';

function getUiStyle(db) {
  // 历史上 ui_style 可能为 'General' / 非法值；W4 起一律视为 'Clear'（无声兜底）。
  const value = getSetting(db, UI_STYLE_KEY);
  return value === 'Clear' ? 'Clear' : UI_STYLE_DEFAULT;
}

function ensureUiStyleDefault(db) {
  // 始终把 ui_style 收敛为 'Clear'：未写则 seed；老库存了 'General'/非法值则就地迁移为 'Clear'。
  const stored = getSetting(db, UI_STYLE_KEY);
  if (stored !== UI_STYLE_DEFAULT) {
    setSetting(db, UI_STYLE_KEY, UI_STYLE_DEFAULT);
  }
  return UI_STYLE_DEFAULT;
}

// v2.1.4：9 个主模块的 ID 全集（renderer 端 MODULES 常量必须与此一致；新增模块时两边都要加）
//   修复历史 bug — v2.1.2 新增 bank-bu-recon、v2.1.3 新增 biz-op-recon 时忘了同步 CURRENT_MODULE_VALID 枚举，
//   导致用户切到这两个模块时 setCurrentModule 抛 "Invalid current_module"
//   v2.1.12 需求1 新增 vcc-op-calc 时再次踩同一坑（dev d2050b0 漏注册），前端开工前补回（spec §8.1）
const ALL_MODULE_IDS = Object.freeze([
  'statement-generator',
  'new-account-generator',
  'pending-reconciliation',
  'bank-statement-process',
  'recon-id-fix',            // v2.1.0-beta.1 PR-A 新增
  'bank-bu-recon',           // v2.1.2 新增
  'biz-op-recon',            // v2.1.3 新增
  'acquiring-bill-currency', // v2.1.6 新增
  'vcc-op-calc'              // v2.1.12 需求1 新增
]);

const CURRENT_MODULE_KEY = 'current_module';
const CURRENT_MODULE_VALID = ALL_MODULE_IDS;
const CURRENT_MODULE_DEFAULT = 'statement-generator';

function getCurrentModule(db) {
  const value = getSetting(db, CURRENT_MODULE_KEY);
  if (value && CURRENT_MODULE_VALID.includes(value)) {
    return value;
  }
  return null;
}

function setCurrentModule(db, moduleId) {
  if (!CURRENT_MODULE_VALID.includes(moduleId)) {
    throw new Error(
      `Invalid current_module: ${moduleId}, must be one of ${CURRENT_MODULE_VALID.join(' | ')}`
    );
  }
  setSetting(db, CURRENT_MODULE_KEY, moduleId);
}

// v2.1.0-beta.3 T4：对账单ReconID修复模块「账单类别」持久化（business / gateway / null）
const RECON_ID_FIX_BILL_CATEGORY_KEY = 'recon_id_fix_bill_category';
const RECON_ID_FIX_BILL_CATEGORY_VALID = ['business', 'gateway'];

function getReconIdFixBillCategory(db) {
  const value = getSetting(db, RECON_ID_FIX_BILL_CATEGORY_KEY);
  if (value && RECON_ID_FIX_BILL_CATEGORY_VALID.includes(value)) {
    return value;
  }
  return null;
}

function setReconIdFixBillCategory(db, category) {
  if (category === null || category === '' || category === undefined) {
    setSetting(db, RECON_ID_FIX_BILL_CATEGORY_KEY, '');
    return;
  }
  if (!RECON_ID_FIX_BILL_CATEGORY_VALID.includes(category)) {
    throw new Error(
      `Invalid recon_id_fix_bill_category: ${category}, must be one of ${RECON_ID_FIX_BILL_CATEGORY_VALID.join(' | ')} | null`
    );
  }
  setSetting(db, RECON_ID_FIX_BILL_CATEGORY_KEY, category);
}

// v2.1.4 T3：左上角模块切换按钮的启用列表（JSON 数组，元素为 ALL_MODULE_IDS 子集）
const ENABLED_MODULES_KEY = 'enabled_modules';
const DEFAULT_ENABLED_MODULES = Object.freeze([
  'statement-generator',
  'bank-statement-process',
  'recon-id-fix'
]);

function getEnabledModules(db) {
  const raw = getSetting(db, ENABLED_MODULES_KEY);
  if (!raw) {
    // 首次启动 seed 默认值（幂等）
    setSetting(db, ENABLED_MODULES_KEY, JSON.stringify(DEFAULT_ENABLED_MODULES));
    return [...DEFAULT_ENABLED_MODULES];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
  } catch (error) {
    // 解析失败 → 回退默认值（不抛错，避免阻断启动）
    // round 1 self-review M6：异常 fallback 路径加日志便于排查"启用列表自动重置"问题
    // v2.1.9 SR-log-1：替换 console.warn → 日志上报
    appendModuleLog({
      level: 'warning',
      source: 'main',
      domain: 'settings-repository',
      message: '[settings-repository] enabled_modules JSON 解析失败，回退默认值',
      details: [
        `raw=${JSON.stringify(raw)}`,
        `reason=${error && error.message ? error.message : String(error)}`
      ],
      stack: error && error.stack ? error.stack : undefined
    });
    setSetting(db, ENABLED_MODULES_KEY, JSON.stringify(DEFAULT_ENABLED_MODULES));
    return [...DEFAULT_ENABLED_MODULES];
  }
  // 过滤非法 ID + 去重 + 保留顺序
  const seen = new Set();
  const sanitized = parsed.filter((id) => {
    if (typeof id !== 'string' || !ALL_MODULE_IDS.includes(id)) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  // 若 sanitize 后为空（DB 内全是非法 ID）→ 回退默认值，避免锁死 UI
  if (sanitized.length === 0) {
    // round 1 self-review M6：destructive 覆盖前打 warn
    // v2.1.9 SR-log-1：替换 console.warn → 日志上报
    appendModuleLog({
      level: 'warning',
      source: 'main',
      domain: 'settings-repository',
      message: '[settings-repository] enabled_modules sanitize 后为空（全是非法 ID），回退默认值',
      details: [`raw=${JSON.stringify(raw)}`]
    });
    setSetting(db, ENABLED_MODULES_KEY, JSON.stringify(DEFAULT_ENABLED_MODULES));
    return [...DEFAULT_ENABLED_MODULES];
  }
  return sanitized;
}

function setEnabledModules(db, moduleList) {
  if (!Array.isArray(moduleList)) {
    throw new Error('enabled_modules must be an array');
  }
  const seen = new Set();
  const sanitized = [];
  moduleList.forEach((id) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`Invalid enabled_modules entry: ${JSON.stringify(id)}, must be non-empty string`);
    }
    if (!ALL_MODULE_IDS.includes(id)) {
      throw new Error(
        `Invalid module id: ${id}, must be one of ${ALL_MODULE_IDS.join(' | ')}`
      );
    }
    if (seen.has(id)) return;  // 静默去重
    seen.add(id);
    sanitized.push(id);
  });
  if (sanitized.length === 0) {
    throw new Error('enabled_modules must not be empty');  // PRD B1：至少保留 1 个
  }
  setSetting(db, ENABLED_MODULES_KEY, JSON.stringify(sanitized));
}

// v2.1.9 N1-settings (T32b)：收单单据 idle 清理阈值（5-180 分钟，默认 30；硬编码 → settings 化）
//   spec.md §13.2 / tasks.md T32b / 资金红线：范围外值会让 idle cleanup 永不触发（>180）或过于频繁（<5）
//   migration `ensureAcquiringBillIdleCleanupMinutesSetting` 启动期 seed 默认 30；本仓暴露 get/set 接口
const ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY = 'acquiring_bill_idle_cleanup_minutes';
const ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT = 30;
const ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_MIN = 5;
const ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_MAX = 180;

function getAcquiringBillIdleCleanupMinutes(db) {
  const raw = getSetting(db, ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY);
  if (raw == null || raw === '') return ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT;
  // 范围外（包括外部直接改 DB 写入非法值）→ 不报错，回退默认（资金红线兜底：never let cleanup never trigger）
  if (n < ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_MIN || n > ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_MAX) {
    return ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT;
  }
  return n;
}

function setAcquiringBillIdleCleanupMinutes(db, minutes) {
  const n = Number(minutes);
  if (!Number.isInteger(n)) {
    throw new Error(`acquiring_bill_idle_cleanup_minutes 必须是整数，收到：${JSON.stringify(minutes)}`);
  }
  if (n < ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_MIN || n > ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_MAX) {
    throw new Error(
      `acquiring_bill_idle_cleanup_minutes 必须在 ${ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_MIN}-${ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_MAX} 分钟范围内，收到：${n}`
    );
  }
  setSetting(db, ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY, String(n));
}

// v2.1.10 A4 T18：收单单据 SQL JOIN chunked 分批 size（行/批）
//   spec §3.2 拍板默认 100000；范围 [10000, 1000000]（1w-100w）
//   选 10w 理由：cancel 响应 < 5s + 内存峰值 < 200MB + 进度回调粒度适中
//   高级用户可调（sqlite3 直改 settings 表 + 重启）；UI 暂不暴露
//   migration `ensureAcquiringBillChunkSizeSetting` 启动期 seed 默认 100000；本仓暴露 get/set
//   getter 范围外值 → 回退默认 100000（资金红线兜底；不能让 chunked 永远跑不动 / 1 行 1 批 OOM）
const ACQUIRING_BILL_CHUNK_SIZE_KEY = 'acquiring_bill_chunk_size';
const ACQUIRING_BILL_CHUNK_SIZE_DEFAULT = 100000;
const ACQUIRING_BILL_CHUNK_SIZE_MIN = 10000;
const ACQUIRING_BILL_CHUNK_SIZE_MAX = 1000000;

function getAcquiringBillChunkSize(db) {
  const raw = getSetting(db, ACQUIRING_BILL_CHUNK_SIZE_KEY);
  if (raw == null || raw === '') return ACQUIRING_BILL_CHUNK_SIZE_DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return ACQUIRING_BILL_CHUNK_SIZE_DEFAULT;
  // 范围外 → 不报错，回退默认（资金红线兜底）
  if (n < ACQUIRING_BILL_CHUNK_SIZE_MIN || n > ACQUIRING_BILL_CHUNK_SIZE_MAX) {
    return ACQUIRING_BILL_CHUNK_SIZE_DEFAULT;
  }
  return n;
}

function setAcquiringBillChunkSize(db, size) {
  const n = Number(size);
  if (!Number.isInteger(n)) {
    throw new Error(`acquiring_bill_chunk_size 必须是整数，收到：${JSON.stringify(size)}`);
  }
  if (n < ACQUIRING_BILL_CHUNK_SIZE_MIN || n > ACQUIRING_BILL_CHUNK_SIZE_MAX) {
    throw new Error(
      `acquiring_bill_chunk_size 必须在 ${ACQUIRING_BILL_CHUNK_SIZE_MIN}-${ACQUIRING_BILL_CHUNK_SIZE_MAX} 范围内，收到：${n}`
    );
  }
  setSetting(db, ACQUIRING_BILL_CHUNK_SIZE_KEY, String(n));
}

// v2.1.12 β.1-T3：收单单据多 worker write-splitting 的 worker 数（M）
//   spec §4 D29（默认上限 4，settings 可调）+ D33（OOM 防御默认 2，高级可调 4）
//   - 默认 2：D33 OOM 兜底（低配机器 M worker × ~800MB peak）；高级用户可上调到 4（POC 甜点）
//   - 范围 [1, 8]：1 = 等价单 worker（彻底关闭多 worker）；8 = 上限（POC：M=8 几乎不再涨且 RSS 高）
//   - main.js handler 读此值后还会再做 D29 CPU clamp（os.cpus-2）+ D33 内存降级；本 getter 只管 settings 持久值
//   - migration `ensureAcquiringBillWorkerCountSetting` 启动期 seed 默认 2；本仓暴露 get/set
//   - getter 范围外值 → 回退默认 2（资金红线兜底；不能让非法值 0/-1 让多 worker 路径崩或 OOM）
//   - UI 暂不暴露（T-b1-4 评估 settings UI）；高级用户 sqlite3 直改 + 重启
const ACQUIRING_BILL_WORKER_COUNT_KEY = 'acquiring_bill_worker_count';
const ACQUIRING_BILL_WORKER_COUNT_DEFAULT = 2;
const ACQUIRING_BILL_WORKER_COUNT_MIN = 1;
const ACQUIRING_BILL_WORKER_COUNT_MAX = 8;

function getAcquiringBillWorkerCount(db) {
  const raw = getSetting(db, ACQUIRING_BILL_WORKER_COUNT_KEY);
  if (raw == null || raw === '') return ACQUIRING_BILL_WORKER_COUNT_DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return ACQUIRING_BILL_WORKER_COUNT_DEFAULT;
  // 范围外（含外部直接改 DB 写入非法值，如 0 / -1 / 99 / 'abc'）→ 不报错，回退默认（资金红线兜底）
  if (n < ACQUIRING_BILL_WORKER_COUNT_MIN || n > ACQUIRING_BILL_WORKER_COUNT_MAX) {
    return ACQUIRING_BILL_WORKER_COUNT_DEFAULT;
  }
  return n;
}

function setAcquiringBillWorkerCount(db, count) {
  const n = Number(count);
  if (!Number.isInteger(n)) {
    throw new Error(`acquiring_bill_worker_count 必须是整数，收到：${JSON.stringify(count)}`);
  }
  if (n < ACQUIRING_BILL_WORKER_COUNT_MIN || n > ACQUIRING_BILL_WORKER_COUNT_MAX) {
    throw new Error(
      `acquiring_bill_worker_count 必须在 ${ACQUIRING_BILL_WORKER_COUNT_MIN}-${ACQUIRING_BILL_WORKER_COUNT_MAX} 范围内，收到：${n}`
    );
  }
  setSetting(db, ACQUIRING_BILL_WORKER_COUNT_KEY, String(n));
}

// v2.1.10 N4-cont-1 T22 (Phase 4)：收单单据 raw_json idle 自动清理保留窗口（默认 7 天）
//   spec §4.1.2 单键 + 范围 [1, 30] 天 + 范围外回退 7
//   - 仅清「对账成功」（不在 acquiring_bill_currency_diff_rows 中）且 imported_at < N 天前的 bill_imports.raw_json
//   - 差异行 raw_json 永远保留（writer.js:184 重导差异 xlsx 依赖）
//   - getter 范围外回退默认（资金红线兜底：clearStaleSuccessfulRawJson 永不能用非法 retention 误清正常数据）
//   - 沿用 v2.1.9 N1-settings 范式（getAcquiringBillIdleCleanupMinutes / setAcquiringBillIdleCleanupMinutes）
const ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY = 'acquiring_bill_raw_json_retention_days';
const ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT = 7;
const ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MIN = 1;
const ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MAX = 30;

function getAcquiringBillRawJsonRetentionDays(db) {
  const raw = getSetting(db, ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY);
  if (raw == null || raw === '') return ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT;
  // 范围外（含外部直接改 DB 写入非法值，如 0 / -1 / 31 / 'abc'）→ 不报错，回退默认（资金红线兜底）
  if (n < ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MIN || n > ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MAX) {
    return ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT;
  }
  return n;
}

function setAcquiringBillRawJsonRetentionDays(db, days) {
  const n = Number(days);
  if (!Number.isInteger(n)) {
    throw new Error(`acquiring_bill_raw_json_retention_days 必须是整数，收到：${JSON.stringify(days)}`);
  }
  if (n < ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MIN || n > ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MAX) {
    throw new Error(
      `acquiring_bill_raw_json_retention_days 必须在 ${ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MIN}-${ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MAX} 天范围内，收到：${n}`
    );
  }
  setSetting(db, ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY, String(n));
}

// v3.0.3 PR-D（W5）：OneDrive 导出目录提示防重标记
//   spec acquiring-import-recon-perf §9.4 — 工作目录落在 OneDrive 同步路径时启动后单次 toast 提示，
//   提示后置 '1' 防止每次启动重复打扰；用户在 OneDrive 设置中排除目录后本标记不影响（仅控制提示次数）。
//   值语义：'1' = 已提示过；null / 其它 = 未提示（hasShownWinOneDriveStorageNotice 仅判 === '1'）。
//   范式沿用本仓既有单键 get/set（不走 settings UI；无范围校验，仅布尔语义）。
const WIN_ONEDRIVE_STORAGE_NOTICE_SHOWN_KEY = 'win_onedrive_storage_notice_shown';
const LAST_IMPORT_DIRECTORY_GLOBAL_KEY = 'last_import_directory';
const LAST_IMPORT_DIRECTORY_PREFIX = 'last_import_directory:';

function hasShownWinOneDriveStorageNotice(db) {
  return getSetting(db, WIN_ONEDRIVE_STORAGE_NOTICE_SHOWN_KEY) === '1';
}

function markWinOneDriveStorageNoticeShown(db) {
  setSetting(db, WIN_ONEDRIVE_STORAGE_NOTICE_SHOWN_KEY, '1');
}

function buildLastImportDirectoryKey(scope) {
  const s = String(scope || '').trim();
  return s ? `${LAST_IMPORT_DIRECTORY_PREFIX}${s}` : LAST_IMPORT_DIRECTORY_GLOBAL_KEY;
}

// 候选目录序列：scoped 优先、global 兜底（去重）。调用方逐个做存在性校验，
// scoped 目录已被删除而 global 仍有效时才能回落到 global
function getLastImportDirectoryCandidates(db, scope = '') {
  const candidates = [];
  const scopedKey = buildLastImportDirectoryKey(scope);
  if (scopedKey !== LAST_IMPORT_DIRECTORY_GLOBAL_KEY) {
    const scoped = getSetting(db, scopedKey);
    if (scoped) candidates.push(scoped);
  }
  const global = getSetting(db, LAST_IMPORT_DIRECTORY_GLOBAL_KEY);
  if (global && !candidates.includes(global)) candidates.push(global);
  return candidates;
}

function getLastImportDirectory(db, scope = '') {
  const candidates = getLastImportDirectoryCandidates(db, scope);
  return candidates.length > 0 ? candidates[0] : null;
}

function setLastImportDirectory(db, scope, directory) {
  const dir = String(directory || '').trim();
  if (!dir) return;
  const scopedKey = buildLastImportDirectoryKey(scope);
  if (scopedKey !== LAST_IMPORT_DIRECTORY_GLOBAL_KEY) setSetting(db, scopedKey, dir);
  setSetting(db, LAST_IMPORT_DIRECTORY_GLOBAL_KEY, dir);
}

function listAccountMappings(db, templateId) {
  return db
    .prepare(`
      SELECT
        id,
        bank_account_id AS bankAccountId,
        clearing_account_id AS clearingAccountId,
        no_currency AS noCurrency,
        currency,
        row_index AS rowIndex
      FROM account_mappings
      WHERE template_id = ?
      ORDER BY row_index ASC, id ASC
    `)
    .all(templateId);
}

function saveAccountMappings(db, templateId, mappings) {
  const now = new Date().toISOString();
  db.exec('BEGIN');

  try {
    db.prepare('DELETE FROM account_mappings WHERE template_id = ?').run(templateId);

    const insertStatement = db.prepare(`
      INSERT INTO account_mappings (
        template_id, bank_account_id, clearing_account_id, no_currency, currency, row_index, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    mappings.forEach((mapping, index) => {
      insertStatement.run(
        templateId,
        mapping.bankAccountId,
        mapping.clearingAccountId,
        mapping.noCurrency ? 1 : 0,
        mapping.currency || '',
        index,
        now,
        now
      );
    });

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  ALL_MODULE_IDS,
  DEFAULT_ENABLED_MODULES,
  ensureUiStyleDefault,
  getBackgroundConfig,
  getCurrentModule,
  getEnabledModules,
  getEnumConfig,
  getReconIdFixBillCategory,
  getSetting,
  getUiStyle,
  listAccountMappings,
  saveAccountMappings,
  setBackgroundConfig,
  setCurrentModule,
  setEnabledModules,
  setEnumConfig,
  setReconIdFixBillCategory,
  setSetting,
  // v2.1.9 N1-settings (T32b)：idle cleanup 阈值
  getAcquiringBillIdleCleanupMinutes,
  setAcquiringBillIdleCleanupMinutes,
  ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_KEY,
  ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_DEFAULT,
  ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_MIN,
  ACQUIRING_BILL_IDLE_CLEANUP_MINUTES_MAX,
  // v2.1.10 A4 T18：chunked 分批 size
  getAcquiringBillChunkSize,
  setAcquiringBillChunkSize,
  ACQUIRING_BILL_CHUNK_SIZE_KEY,
  ACQUIRING_BILL_CHUNK_SIZE_DEFAULT,
  ACQUIRING_BILL_CHUNK_SIZE_MIN,
  ACQUIRING_BILL_CHUNK_SIZE_MAX,
  // v2.1.12 β.1-T3：多 worker write-splitting worker 数（D29/D33）
  getAcquiringBillWorkerCount,
  setAcquiringBillWorkerCount,
  ACQUIRING_BILL_WORKER_COUNT_KEY,
  ACQUIRING_BILL_WORKER_COUNT_DEFAULT,
  ACQUIRING_BILL_WORKER_COUNT_MIN,
  ACQUIRING_BILL_WORKER_COUNT_MAX,
  // v2.1.10 N4-cont-1 T22 (Phase 4)：raw_json idle 自动清理保留窗口
  getAcquiringBillRawJsonRetentionDays,
  setAcquiringBillRawJsonRetentionDays,
  ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_KEY,
  ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_DEFAULT,
  ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MIN,
  ACQUIRING_BILL_RAW_JSON_RETENTION_DAYS_MAX,
  // v3.0.3 PR-D（W5）：OneDrive 导出目录提示防重标记
  hasShownWinOneDriveStorageNotice,
  markWinOneDriveStorageNoticeShown,
  WIN_ONEDRIVE_STORAGE_NOTICE_SHOWN_KEY,
  buildLastImportDirectoryKey,
  getLastImportDirectory,
  getLastImportDirectoryCandidates,
  setLastImportDirectory,
  LAST_IMPORT_DIRECTORY_GLOBAL_KEY,
  LAST_IMPORT_DIRECTORY_PREFIX,
};
