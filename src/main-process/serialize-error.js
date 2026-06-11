// v2.1.10 A3 Phase 1 T08 — 跨进程错误序列化 / 反序列化
//
// 用途：worker → 主进程 message pipe 传 error 对象时保留：
//   - name / message / stack / code（SQLITE_BUSY / FileValidationError code 等）
//   - cause 链（Error.cause 嵌套 — Node 16.9+ 引入）
//   - FileValidationError 专属字段（detailLines / context — src/backend/file-service/common.js）
//
// spec §2.4 范式 + spec §16（self-review）扩展：
//   - 循环引用防护：cause 嵌套上限 10 层（超过返回 placeholder）
//   - SQLITE_* code 透传（DatabaseSync prepare/run 错的 err.code 是 SQLITE_BUSY / SQLITE_CONSTRAINT 等）
//   - native error 子类（TypeError / RangeError）通过 err.name 透传，反序列化为通用 Error
//     ⚠️ 反序列化后 instanceof TypeError = false，调用方需按 err.name 判断
//   - FileValidationError 也只能反序列化为 Error；调用方按 err.name === 'FileValidationError' + 字段判
//
// 测试覆盖 ≥ 6 case（tests/unit/main-process/serialize-error.test.js）：
//   1. 普通 Error
//   2. FileValidationError（含 detailLines / context）
//   3. SQLITE 错误（含 code）
//   4. 嵌套 cause（3 层）
//   5. 循环引用 / 超 10 层截断
//   6. stack 完整性（reverse 后 stack 字符串与原始一致）
//   + TypeError / 空入参 / 边界

'use strict';

const MAX_CAUSE_DEPTH = 10;

// serializeError(err) → JSON-safe object
//   depth 内部计数，外部 caller 不需要传
function serializeError(err, depth = 0) {
  if (err === null || err === undefined) return null;
  if (depth > MAX_CAUSE_DEPTH) {
    return {
      name: 'Error',
      message: '<cause chain too deep — truncated at depth ' + MAX_CAUSE_DEPTH + '>',
      stack: null,
      code: null,
      cause: null,
      detailLines: null,
      context: null,
      __truncated__: true,
    };
  }
  // 防御：非 Error 类型也尽量序列化（worker 可能 throw 字符串 / 对象）
  if (typeof err !== 'object') {
    return {
      name: 'Error',
      message: String(err),
      stack: null,
      code: null,
      cause: null,
      detailLines: null,
      context: null,
    };
  }
  const out = {
    name: typeof err.name === 'string' ? err.name : 'Error',
    message: typeof err.message === 'string' ? err.message : String(err),
    stack: typeof err.stack === 'string' ? err.stack : null,
    code: err.code !== undefined && err.code !== null ? String(err.code) : null,
    cause: err.cause ? serializeError(err.cause, depth + 1) : null,
    // FileValidationError 专属（src/backend/file-service/common.js）
    detailLines: Array.isArray(err.detailLines)
      ? err.detailLines.map((line) => String(line))
      : null,
    context: err.context && typeof err.context === 'object'
      ? safeCloneContext(err.context)
      : null,
    // 大表导入引擎整批拒绝错误专属（v3.0.4 PR-C）：结构化行级错误样本 + 总数 + 截断标志，
    //   供 pending session 跨 worker 边界还原报错 xlsx（collectedErrors 含 cells）。JSON 安全（一层 clone 兜底）。
    structuredImportErrors: err.structuredImportErrors && typeof err.structuredImportErrors === 'object'
      ? safeCloneStructuredImportErrors(err.structuredImportErrors)
      : null,
  };
  return out;
}

// 安全 clone structuredImportErrors（JSON.parse(JSON.stringify) 兜底；失败 → null，不阻断错误传递）。
function safeCloneStructuredImportErrors(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_e) {
    return null;
  }
}

// 安全 clone context（仅保留 JSON-safe primitive；函数 / Symbol / 循环引用直接丢弃）
//   不深拷嵌套对象（context 一般是浅扁平 — 来自 FileValidationError options.context spread）
function safeCloneContext(context) {
  const out = {};
  for (const key of Object.keys(context)) {
    const value = context[key];
    if (value === null || value === undefined) {
      out[key] = value;
      continue;
    }
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      out[key] = value;
      continue;
    }
    if (t === 'object') {
      // 一层 JSON 化兜底 — 循环引用直接丢
      try {
        out[key] = JSON.parse(JSON.stringify(value));
      } catch (_e) {
        out[key] = String(value);
      }
      continue;
    }
    // function / symbol / bigint 丢弃 — JSON 不支持
  }
  return out;
}

// deserializeError(serialized) → Error 实例
//   ⚠️ 反序列化后是普通 Error，instanceof FileValidationError = false（prototype chain 不可跨进程恢复）
//   调用方按 err.name 判断子类型
function deserializeError(serialized) {
  if (serialized === null || serialized === undefined) {
    return new Error('unknown worker error');
  }
  if (typeof serialized !== 'object') {
    return new Error(String(serialized));
  }
  const message = typeof serialized.message === 'string' ? serialized.message : 'unknown';
  const err = new Error(message);
  if (serialized.name && typeof serialized.name === 'string') {
    err.name = serialized.name;
  }
  if (serialized.stack && typeof serialized.stack === 'string') {
    err.stack = serialized.stack;
  }
  if (serialized.code !== null && serialized.code !== undefined) {
    err.code = serialized.code;
  }
  if (serialized.cause) {
    err.cause = deserializeError(serialized.cause);
  }
  if (Array.isArray(serialized.detailLines)) {
    err.detailLines = serialized.detailLines.slice();
  }
  if (serialized.context && typeof serialized.context === 'object') {
    err.context = { ...serialized.context };
  }
  if (serialized.structuredImportErrors && typeof serialized.structuredImportErrors === 'object') {
    err.structuredImportErrors = serialized.structuredImportErrors;
  }
  if (serialized.__truncated__) {
    err.__truncated__ = true;
  }
  return err;
}

module.exports = {
  serializeError,
  deserializeError,
  __test_only__: {
    MAX_CAUSE_DEPTH,
    safeCloneContext,
  },
};
