'use strict';

// 设置 → 模板文件：启动受限的模板检查 Worker（inspection-worker.js），并把各种失败转换为带分类的错误：
//   超出内存上限：文件本身过于复杂，判为不通过（结果可缓存）；
//   超时、低内存任务占用、Worker 无法启动：运行环境问题，标为 transient（稍后重试，不缓存）。

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { memoryCarrierAdmission } = require('../background-execution/memory-activity');

const WORKER_PATH = path.join(__dirname, 'inspection-worker.js');
const DEFAULT_INSPECTION_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  timeoutMs: 60 * 1000
});

class TemplateInspectionError extends Error {
  constructor(message, { transient = false, code = '' } = {}) {
    super(message);
    this.name = 'TemplateInspectionError';
    this.code = code;
    this.transient = transient;
  }
}

const errorText = (error) => (error && error.message ? String(error.message) : '未知错误');

// payload：{ task: 'inspect' | 'values', resource: { id, type, headerRow }, bytes, context }
function runTemplateInspection(payload, { limits = DEFAULT_INSPECTION_LIMITS } = {}) {
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
      reject(new TemplateInspectionError(`模板检查暂时无法启动：${errorText(error)}，请稍后重试`, { transient: true, code: error && error.code }));
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
        { transient: true, code: 'template-inspection-timeout' }
      ));
    }, limits.timeoutMs);
    worker.once('message', (message) => {
      if (message && message.ok) {
        finish(resolve, message.result);
        return;
      }
      const error = (message && message.error) || {};
      finish(reject, new TemplateInspectionError(`模板检查失败：${error.message || '未知错误'}`, { transient: Boolean(error.syscall), code: error.code }));
    });
    worker.once('error', (error) => {
      if (error && error.code === 'ERR_WORKER_OUT_OF_MEMORY') {
        finish(reject, new TemplateInspectionError(
          `模板过于复杂：读取时超出 ${limits.maxOldGenerationSizeMb} MB 内存上限（数据验证、合并单元格、定义名称等范围过大），请精简后再导入`,
          { code: 'template-inspection-out-of-memory' }
        ));
        return;
      }
      finish(reject, new TemplateInspectionError(`模板检查异常：${errorText(error)}`, { transient: Boolean(error && error.syscall), code: error && error.code }));
    });
    worker.once('exit', (code) => {
      finish(reject, new TemplateInspectionError(`模板检查意外结束（退出码 ${code}），请稍后重试`, { transient: true, code: 'template-inspection-exit' }));
    });
  });
}

module.exports = {
  DEFAULT_INSPECTION_LIMITS,
  TemplateInspectionError,
  runTemplateInspection
};
