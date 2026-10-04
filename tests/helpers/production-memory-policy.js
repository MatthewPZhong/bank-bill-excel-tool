'use strict';
// 测试专用装配：执行真实生产策略源码，只替换静态清单、平台事实与内存采样。
// 不向生产工厂新增运行时放行参数，也不修改全局 process 或 require 缓存。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadProductionMemoryProfiles({ qualification, runtime = process, sampleMemory, sourceIdentity } = {}) {
  const filename = path.resolve(__dirname, '../../src/main-process/execution-descriptors/memory-profiles.js');
  const localRequire = createRequire(filename);
  const dependencies = new Map();
  if (qualification !== undefined) dependencies.set('./memory-qualification.json', qualification);
  if (sampleMemory) dependencies.set('../background-execution/memory-telemetry', { createMemorySampler: () => sampleMemory });
  if (sourceIdentity) dependencies.set('./memory-evidence', { ...localRequire('./memory-evidence'), sourceIdentity });
  const module = { exports: {} };
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports', '__filename', '__dirname', 'process'], { filename })(
    (name) => dependencies.has(name) ? dependencies.get(name) : localRequire(name),
    module, module.exports, filename, path.dirname(filename), runtime
  );
  return module.exports;
}
module.exports = { loadProductionMemoryProfiles };
