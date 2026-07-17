// v3.0.9 子任务 T4：工具箱「按字段值拆分」大文件隔离 worker —— worker_threads 入口（薄壳）。
//
// 职责（TechDoc v3.0.9 §六 T4 + §四 4.3 worker 消息协议 + §三② sharedStrings 护栏）：
//   让 scanFields / exportFilter / exportMultiFilters（T3 纯逻辑）在「隔离 worker 进程域」内执行，使 700 万行级
//   大文件按字段拆分不在主进程 / 渲染进程内 OOM，主进程仅通过 message pipe 收 done/error。
//   本文件是被 new Worker(...) 直接拉起的薄壳；主侧 dispatch 接线见
//   src/main-process/toolbox-large-split-dispatch.js（照搬 big-table-import-dispatch.js 范式）。
//
// 进程边界（🔴 纯 Node，worker 安全）：
//   - 不访问任何 Electron API；只 require：
//       ./split-scan-fields（T3）/ ./split-export-filter（T3）—— 读路径全走 T1 multi-sheet-reader
//         的 yauzl 流式解析，绝不 require 隔离铁律禁区的 pending-import 银行专表流式读取器；
//       ../pending-import/xlsx-size-preflight（collectEntrySizes，纯 yauzl）—— sharedStrings 护栏；
//       ../../main-process/serialize-error（serializeError，通用工具，与 engine-worker-entry 同口径）。
//   - team-lead 已核 toolbox-xlsx-stream 整链 electron-free（T3 头注已记）。
//
// Message 协议（TechDoc §4.3，照搬 engine-worker-entry.js 范式）：
//   主 → worker：
//     { type:'run', jobId, op:'scanFields'|'exportFilter'|'exportMultiFilters', filePath, field?, values?, savePath?, groups? }
//     { type:'cancel', jobId }   — 置 activeCancelToken.cancelled（T1 reader 每行检查 → __stopParsing 早退）
//     { type:'close' }           — process.exit(0)（dispatch finish 时主动发，与 big-table-import 一致）
//   worker → 主：
//     { type:'progress', jobId, payload }   — 进度（v1 无 UI，最终接 activity log；OPEN-3）
//     { type:'log', jobId, entry }          — 日志透传
//     { type:'done', jobId, result }        — scanFields / 单文件过滤 / 多文件过滤结果
//     { type:'error', jobId, error: serializeError(err) }  — 主侧 deserializeError 还原（保 name/message/detailLines）
//
// 约束：本文件不写业务逻辑（全部委托 T3）；只做「收消息 → 护栏 → 调 T3 → 回 done/error」+ cancelToken 维护。

'use strict';

const { parentPort, isMainThread } = require('node:worker_threads');

// ── sharedStrings 护栏阈值（TechDoc §三② / OPEN-T4，具名常量便于实施期按真实数据微调）──────────
//   解析前读 xl/sharedStrings.xml 的 uncompressedSize；超此上限 → 抛可解释错误（failed 文案），
//   不进解析（否则 sharedStrings 全量驻内存可达 GB 级 → V8 OOM 硬崩，用户只见进程消失）。
//   ~1.2GB = 1288490188 字节（1.2 * 1024^3 取整）。
const SHARED_STRINGS_UNCOMPRESSED_LIMIT = 1288490188; // ~1.2 GB

//   worker 内 heapUsed 监控阈值——解析途中 heapUsed 超此上限 → 置 OOM 标志 + 主动抛可解释错误兜底，
//   防 sharedStrings 之外的病态数据（极宽表 / 异常累加）把 V8 堆撑爆硬崩。~3GB = 3221225472 字节。
const HEAP_USED_LIMIT_BYTES = 3221225472; // ~3 GB

//   heapUsed 采样间隔（毫秒）。
const HEAP_MONITOR_INTERVAL_MS = 1000;

const SHARED_STRINGS_ENTRY = 'xl/sharedStrings.xml';

// sharedStrings 超阈值错误——dispatch 用 deserializeError 还原后由 main.js handler 归一 failed（不产文件）。
//   name/message 固定，便于上层按 name 识别（不依赖 instanceof，跨进程 prototype 不可恢复）。
class ToolboxSharedStringsTooLargeError extends Error {
  constructor(uncompressedSize) {
    super('文件文本量过大，超出处理能力');
    this.name = 'ToolboxSharedStringsTooLargeError';
    const sizeGb = (Number(uncompressedSize) / (1024 * 1024 * 1024)).toFixed(2);
    this.detailLines = [
      `文件内文本表（sharedStrings）解压后约 ${sizeGb} GB，超出当前拆分通道的处理上限（约 1.2 GB）。`,
      '该文件文本基数过高，暂不支持按字段值拆分；请减少文本列或拆分文件后重试。'
    ];
  }
}

// worker heapUsed 超阈值错误——同样固定 name，便于上层识别 + 文案可解释。
class ToolboxWorkerMemoryLimitError extends Error {
  constructor(heapUsedBytes) {
    super('文件数据量过大，超出处理能力');
    this.name = 'ToolboxWorkerMemoryLimitError';
    const usedGb = (Number(heapUsedBytes) / (1024 * 1024 * 1024)).toFixed(2);
    this.detailLines = [
      `处理过程中内存占用约 ${usedGb} GB，超出当前拆分通道的处理上限（约 3 GB）。`,
      '该文件数据量过大，暂不支持按字段值拆分；请拆分文件后分批重试。'
    ];
  }
}

// 已是「可解释错误」（自带 name + detailLines）则不再被 heap 兜底覆盖。
function isExplainedError(err) {
  if (!err || typeof err !== 'object') return false;
  return Array.isArray(err.detailLines) && err.detailLines.length > 0;
}

// ── sharedStrings 护栏：解析前读中央目录尺寸，超阈值即抛（不进解析）──────────────────────────────
//   用 collectEntrySizes（yauzl 读中央目录、不解压、不读文件体）—— 与路由探针同一不 OOM 的能力。
//   预检自身异常（zip 打不开 / 无 sharedStrings entry / yauzl 报错）→ 不拦（放行让 T3 按原方式报原错），
//   与 xlsx-size-preflight 的 fail-open 哲学一致：护栏只拦「确定超限」，绝不引入新误伤面。
//   依赖注入 collectEntrySizes（缺省取 xlsx-size-preflight）便于主线程单测 mock（worker 块内不可被外部 mock）。
async function assertSharedStringsUnderLimit(filePath, deps = {}) {
  const collectEntrySizes = typeof deps.collectEntrySizes === 'function'
    ? deps.collectEntrySizes
    : require('../pending-import/xlsx-size-preflight').collectEntrySizes;

  let sizes;
  try {
    sizes = await collectEntrySizes(filePath);
  } catch (_e) {
    return; // fail-open：读不了中央目录 → 放行
  }
  if (!sizes || typeof sizes.get !== 'function') return;
  const sstSize = sizes.get(SHARED_STRINGS_ENTRY);
  if (typeof sstSize === 'number' && Number.isFinite(sstSize) && sstSize >= SHARED_STRINGS_UNCOMPRESSED_LIMIT) {
    throw new ToolboxSharedStringsTooLargeError(sstSize);
  }
}

// 非 worker 环境（被普通 require / isMainThread）防御性 return：仅导出元信息 / 纯函数（供单测），
//   不挂 message 监听、不起 heap 监控（参考 engine-worker-entry.js 的 `if (!isMainThread && parentPort)` 守卫）。
if (!isMainThread && parentPort) {
  // 与 engine-worker-entry 一致：worker 内 warning 重定向到 stderr（保持 worker 日志整洁的范式）。
  process.on('warning', (warning) => {
    try {
      const name = warning && warning.name ? String(warning.name) : '';
      const msg = warning && warning.message ? String(warning.message) : '';
      process.stderr.write(`(node:toolbox-large-split-worker) ${name}: ${msg}\n`);
    } catch (_e) { /* swallow */ }
  });

  // serializeError 复用项目现有（与 engine-worker-entry.js 同口径）；require 失败时退化为最小序列化，
  //   保证错误仍能跨进程回传（不因工具缺失而静默丢错）。
  let serializeError;
  try {
    serializeError = require('../../main-process/serialize-error').serializeError;
  } catch (_e) {
    serializeError = function fallback(err) {
      if (!err) return null;
      return {
        name: err.name || 'Error',
        message: err.message || String(err),
        stack: err.stack || null,
        code: err.code != null ? String(err.code) : null,
        detailLines: Array.isArray(err.detailLines) ? err.detailLines.slice() : null
      };
    };
  }

  const { scanFields } = require('./split-scan-fields');
  const { exportFilter, exportMultiFilters } = require('./split-export-filter');

  // 当前 job 的取消令牌（透传给三种作业 → T1 reader 每行检查）；cancel message 置位。
  let activeCancelToken = null;
  let activeJobId = null;

  // ── heapUsed 监控：解析途中超阈值 → 置标志 + 触发回调兜底（防 V8 OOM 硬崩）──────────────────────
  //   返回 { stop }：作业结束 clearInterval。
  function startHeapMonitor(onOverLimit) {
    let timer = null;
    try {
      timer = setInterval(() => {
        let heapUsed = 0;
        try { heapUsed = process.memoryUsage().heapUsed; } catch (_e) { return; }
        if (heapUsed >= HEAP_USED_LIMIT_BYTES) {
          try { onOverLimit(heapUsed); } catch (_e) { /* swallow */ }
        }
      }, HEAP_MONITOR_INTERVAL_MS);
      // 不阻止进程退出（监控是兜底，不应延长 worker 生命周期）。
      if (timer && typeof timer.unref === 'function') timer.unref();
    } catch (_e) { /* swallow */ }
    return {
      stop() {
        if (timer) { try { clearInterval(timer); } catch (_e) { /* swallow */ } timer = null; }
      }
    };
  }

  parentPort.on('message', async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'cancel') {
      // 仅当未带 jobId 或匹配当前作业时置位（与 engine-worker-entry.js 一致）。
      if (activeCancelToken && (!msg.jobId || msg.jobId === activeJobId)) {
        activeCancelToken.cancelled = true;
      }
      return;
    }

    if (msg.type === 'close') {
      process.exit(0);
      return;
    }

    if (msg.type !== 'run') return;

    const { jobId, op, filePath, field, values, savePath, groups } = msg;
    activeJobId = jobId;
    activeCancelToken = { cancelled: false };

    // heapUsed 超阈值 → 置 cancelToken.cancelled（让 T1 reader 在下一行尽快早退）+ 记录 oom 字节数，
    //   作业 catch 后据此抛 ToolboxWorkerMemoryLimitError（比等 V8 OOM 硬崩可解释得多）。
    let heapOverLimitBytes = 0;
    const heapMonitor = startHeapMonitor((heapUsed) => {
      heapOverLimitBytes = heapUsed;
      if (activeCancelToken) activeCancelToken.cancelled = true; // 主动停掉正在跑的解析
    });

    try {
      // 🔴 sharedStrings 护栏：在调拆分作业之前先查（超阈值不进解析）。
      await assertSharedStringsUnderLimit(filePath);

      let result;
      if (op === 'scanFields') {
        result = await scanFields(filePath, activeCancelToken);
      } else if (op === 'exportFilter') {
        result = await exportFilter({
          filePath,
          field,
          values,
          savePath,
          cancelToken: activeCancelToken
        });
      } else if (op === 'exportMultiFilters') {
        result = await exportMultiFilters({
          filePath,
          groups,
          cancelToken: activeCancelToken
        });
      } else {
        throw new Error(`未知的拆分作业类型 op=${String(op)}`);
      }

      // 若解析期间 heapUsed 曾超阈值（导致 cancelToken 被置位提前结束）→ 报内存上限错误（兜底，不返回半成品）。
      if (heapOverLimitBytes > 0) {
        throw new ToolboxWorkerMemoryLimitError(heapOverLimitBytes);
      }

      parentPort.postMessage({ type: 'done', jobId, result });
    } catch (err) {
      // 若 catch 到的错误是因 heapUsed 超阈值触发的提前取消（且非可解释错误）→ 归一为内存上限错误。
      const finalErr = (heapOverLimitBytes > 0 && !isExplainedError(err))
        ? new ToolboxWorkerMemoryLimitError(heapOverLimitBytes)
        : err;
      parentPort.postMessage({ type: 'error', jobId, error: serializeError(finalErr) });
    } finally {
      heapMonitor.stop();
      activeCancelToken = null;
      activeJobId = null;
    }
  });
}

module.exports = {
  __workerScriptPath: __filename,
  // 供单测：sharedStrings 护栏纯函数（依赖注入 collectEntrySizes）+ 阈值 / 错误类。
  assertSharedStringsUnderLimit,
  isExplainedError,
  SHARED_STRINGS_UNCOMPRESSED_LIMIT,
  HEAP_USED_LIMIT_BYTES,
  SHARED_STRINGS_ENTRY,
  ToolboxSharedStringsTooLargeError,
  ToolboxWorkerMemoryLimitError
};
