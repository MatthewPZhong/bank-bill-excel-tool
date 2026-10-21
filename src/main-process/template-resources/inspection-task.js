'use strict';

// 设置 → 模板文件：模板检查任务本体（契约检查、结构描述、运行时口径取值）。
//   正式环境只在受限 Worker（inspection-worker.js）中执行；拆成独立模块便于单测在进程内复用同一逻辑。

const { inspectContract } = require('./contracts');
const { describeWorkbook, parseRuntimeValues } = require('./workbook-structure');

function errorPayload(error) {
  return {
    message: error && error.message ? String(error.message) : '未知错误',
    code: error && error.code ? String(error.code) : '',
    syscall: error && typeof error.syscall === 'string' ? error.syscall : ''
  };
}

// payload：{ task: 'inspect' | 'values', resource: { id, type, headerRow }, bytes, context }
async function runInspectionTask({ task, resource, bytes, context = {} }) {
  const buffer = Buffer.from(bytes);
  if (task === 'values') return { values: parseRuntimeValues(resource.id, buffer) };
  const references = context.references || {};
  const contract = await inspectContract(resource.id, buffer, {
    builtinSheetNames: context.builtinSheetNames,
    currentValues: context.currentValues || [],
    references: {
      fundTypeValues: new Set(references.fundTypeValues || []),
      gatewayFields: new Set(references.gatewayFields || [])
    }
  });
  // 结构描述只在契约检查通过时进行：未通过的文件不会被保存，也就不再多读一遍。
  let structure = null;
  let describeError = null;
  if (context.describe && contract.ok) {
    try {
      structure = describeWorkbook(buffer, resource);
    } catch (error) {
      describeError = errorPayload(error);
    }
  }
  return { contract, structure, describeError };
}

module.exports = {
  errorPayload,
  runInspectionTask
};
