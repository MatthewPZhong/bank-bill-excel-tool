'use strict';

const POSITION_IMPORT_PROTOCOL_VERSION = 1;
const POSITION_SST_MEMORY_BUDGET_BYTES = 64 * 1024 * 1024;
const POSITION_SST_LRU_MAX_ENTRIES = 8192;
const POSITION_IMPORT_MAX_ERROR_DETAILS = 100;
const POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST = Object.freeze([
  'fund-transfer',
  'test-payment',
  'gateway-inbound',
  'gateway-outbound'
]);
const POSITION_IMPORT_MAINTENANCE_BATCH_SIZE = 10000;
const POSITION_IMPORT_PROGRESS_ROW_INTERVAL = 4000;
const POSITION_IMPORT_PROGRESS_HEARTBEAT_MS = 750;
const POSITION_IMPORT_NON_CANCELLABLE_STAGES = Object.freeze([
  'summarizing',
  'committing'
]);

const POSITION_IMPORT_ENGINES = Object.freeze({
  STREAMING: 'streaming',
  LEGACY_WORKER: 'legacy-worker',
  DISABLED: 'disabled'
});

const POSITION_IMPORT_COMMANDS = Object.freeze({
  // 单遍导入：一次解析直接写库，事务等写入授权后提交。
  BANK_IMPORT: 'BANK_IMPORT',
  SOURCE_IMPORT: 'SOURCE_IMPORT',
  // 账户表经用户确认后的整表替换。
  ACCOUNT_APPLY: 'ACCOUNT_APPLY',
  // 以下四个为 v3.2.22 之前的两段式导入与结构迁移命令，已停用（导入进程收到即拒绝）；
  // 常量保留给尚未启用的后台 managed 导入适配器引用（见 knowledge/backlog.md B37）。
  BANK_PREPARE: 'BANK_PREPARE',
  BANK_APPLY: 'BANK_APPLY',
  SOURCE_PREPARE_AND_APPLY: 'SOURCE_PREPARE_AND_APPLY',
  ENSURE_LARGE_IMPORT_INDEXES: 'ENSURE_LARGE_IMPORT_INDEXES',
  DELETE_BANK: 'DELETE_BANK',
  DELETE_SOURCE: 'DELETE_SOURCE',
  REBUILD_FUND_TRANSFER_MAPPING: 'REBUILD_FUND_TRANSFER_MAPPING'
});

const POSITION_IMPORT_MESSAGE_TYPES = Object.freeze({
  START_JOB: 'START_JOB',
  PROGRESS: 'PROGRESS',
  PREFLIGHT_READY: 'PREFLIGHT_READY',
  APPLY_GRANTED: 'APPLY_GRANTED',
  APPLY_REJECTED: 'APPLY_REJECTED',
  FILE_COMMITTED: 'FILE_COMMITTED',
  COMPLETE: 'COMPLETE',
  FATAL: 'FATAL',
  CANCEL: 'CANCEL',
  CANCEL_ACK: 'CANCEL_ACK'
});

// 启动即写库的命令：必须带持久归属（批次或操作）才允许启动导入进程。
// 单遍导入（BANK_IMPORT / SOURCE_IMPORT）的归属随写入授权下发，不在此列。
const POSITION_IMPORT_MUTATING_COMMANDS = Object.freeze([
  POSITION_IMPORT_COMMANDS.ACCOUNT_APPLY,
  POSITION_IMPORT_COMMANDS.DELETE_BANK,
  POSITION_IMPORT_COMMANDS.DELETE_SOURCE,
  POSITION_IMPORT_COMMANDS.REBUILD_FUND_TRANSFER_MAPPING
]);

function isPositionImportMutatingCommand(command) {
  return POSITION_IMPORT_MUTATING_COMMANDS.includes(String(command || ''));
}

function normalizePositionImportEngine(value = process.env.POSITION_IMPORT_ENGINE) {
  const normalized = String(value || '').trim().toLowerCase();
  return Object.values(POSITION_IMPORT_ENGINES).includes(normalized)
    ? normalized
    : POSITION_IMPORT_ENGINES.DISABLED;
}

function normalizePositionStreamingSourceTypes(
  value = process.env.POSITION_STREAMING_SOURCE_TYPES,
  { engine = normalizePositionImportEngine() } = {}
) {
  if (engine !== POSITION_IMPORT_ENGINES.STREAMING) return new Set();
  const configured = String(value || '').trim();
  const values = configured
    ? configured.split(',').map((item) => item.trim()).filter(Boolean)
    : POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST;
  const allowed = new Set(POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST);
  return new Set(values.filter((item) => allowed.has(item)));
}

function isPositionImportCancellationLocked(stage) {
  return POSITION_IMPORT_NON_CANCELLABLE_STAGES.includes(
    String(stage || '').trim()
  );
}

module.exports = {
  POSITION_IMPORT_PROTOCOL_VERSION,
  POSITION_SST_MEMORY_BUDGET_BYTES,
  POSITION_SST_LRU_MAX_ENTRIES,
  POSITION_IMPORT_MAX_ERROR_DETAILS,
  POSITION_IMPORT_STREAMING_SOURCE_ALLOWLIST,
  POSITION_IMPORT_MAINTENANCE_BATCH_SIZE,
  POSITION_IMPORT_PROGRESS_ROW_INTERVAL,
  POSITION_IMPORT_PROGRESS_HEARTBEAT_MS,
  POSITION_IMPORT_NON_CANCELLABLE_STAGES,
  POSITION_IMPORT_ENGINES,
  POSITION_IMPORT_COMMANDS,
  POSITION_IMPORT_MUTATING_COMMANDS,
  POSITION_IMPORT_MESSAGE_TYPES,
  isPositionImportMutatingCommand,
  isPositionImportCancellationLocked,
  normalizePositionImportEngine,
  normalizePositionStreamingSourceTypes
};
