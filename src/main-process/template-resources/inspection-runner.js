'use strict';

// 设置 → 模板文件：启动受限的模板检查 Worker（inspection-worker.js），并把各种失败转换为带分类的错误：
//   超出堆上限：文件本身过于复杂，判为不通过（结果可缓存）；
//   其余失败（超时、低内存任务占用、Worker 无法启动或启动后加载失败、任务意外抛错）都是运行环境问题，
//   标为 transient（稍后重试，不缓存）。文件内容的问题由检查任务以契约结果返回，不走这里。
// 同一时间只运行一个检查 Worker：每个检查都会复制文件字节并占用一份堆上限，并发叠加会抵消上限的意义。
//   名额在 Worker 真正退出（exit）后才释放，超时被终止的 Worker 也要等到退出。

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { memoryCarrierAdmission } = require('../background-execution/memory-activity');

const WORKER_PATH = path.join(__dirname, 'inspection-worker.js');
const DEFAULT_INSPECTION_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  timeoutMs: 60 * 1000
});
const MAX_CONCURRENT_INSPECTIONS = 1;

class TemplateInspectionError extends Error {
  constructor(message, { transient = true, code = '' } = {}) {
    super(message);
    this.name = 'TemplateInspectionError';
    this.code = code;
    this.transient = transient;
  }
}

const errorText = (error) => (error && error.message ? String(error.message) : '未知错误');

const queue = [];
let running = 0;

function pump() {
  while (running < MAX_CONCURRENT_INSPECTIONS && queue.length) {
    const job = queue.shift();
    running += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      running -= 1;
      pump();
    };
    startInspection(job.payload, job.limits, release).then(job.resolve, job.reject);
  }
}

function startInspection(payload, limits, release) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = memoryCarrierAdmission(null).observe(new Worker(WORKER_PATH, {
        workerData: payload,
        resourceLimits: {
          maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
          maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb
        }
      }));
    } catch (error) {
      release();
      reject(new TemplateInspectionError(`模板检查暂时无法启动：${errorText(error)}，请稍后重试`, { code: error && error.code }));
      return;
    }
    let settled = false;
    let timer = null;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(reject, new TemplateInspectionError(
        `读取模板超时（超过 ${Math.round(limits.timeoutMs / 1000)} 秒），请稍后重试`,
        { code: 'template-inspection-timeout' }
      ));
    }, limits.timeoutMs);
    worker.once('message', (message) => {
      if (message && message.ok) {
        finish(resolve, message.result);
        return;
      }
      const error = (message && message.error) || {};
      finish(reject, new TemplateInspectionError(`模板检查未完成：${error.message || '未知错误'}，请稍后重试`, { code: error.code }));
    });
    worker.once('error', (error) => {
      if (error && error.code === 'ERR_WORKER_OUT_OF_MEMORY') {
        finish(reject, new TemplateInspectionError(
          `模板过于复杂：读取时超出 ${limits.maxOldGenerationSizeMb} MB 内存上限（数据验证、合并单元格、定义名称等范围过大），请精简后再导入`,
          { transient: false, code: 'template-inspection-out-of-memory' }
        ));
        return;
      }
      finish(reject, new TemplateInspectionError(`模板检查暂时无法完成：${errorText(error)}，请稍后重试`, { code: error && error.code }));
    });
    worker.once('exit', (code) => {
      release();
      finish(reject, new TemplateInspectionError(`模板检查意外结束（退出码 ${code}），请稍后重试`, { code: 'template-inspection-exit' }));
    });
  });
}

// payload：{ task: 'inspect' | 'values', resource: { id, type, headerRow }, bytes, context }
function runTemplateInspection(payload, { limits = DEFAULT_INSPECTION_LIMITS } = {}) {
  return new Promise((resolve, reject) => {
    queue.push({ payload, limits, resolve, reject });
    pump();
  });
}

// 诊断与测试用：正在运行（含已返回结果、尚未退出）与排队中的检查数。
function inspectionStats() {
  return { running, queued: queue.length };
}

module.exports = {
  DEFAULT_INSPECTION_LIMITS,
  MAX_CONCURRENT_INSPECTIONS,
  TemplateInspectionError,
  inspectionStats,
  runTemplateInspection
};
