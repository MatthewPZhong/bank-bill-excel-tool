'use strict';
// 只用已冻结的五个修复前文件进行对照；不改写工作区。
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const root = process.cwd();
const before = path.join(__dirname, 'before/source');
const files = new Set(["src/main-process/background-execution/admission-queue.js","src/main-process/background-execution/resource-governor.js","src/main-process/background-execution/memory-admission.js","src/main-process/background-execution/memory-activity.js","src/main-process/execution-descriptors/memory-profiles.js"]);
const original = Module._extensions['.js'];
Module._extensions['.js'] = function(module, filename) {
  const relative = path.relative(root, filename);
  if (files.has(relative)) return module._compile(fs.readFileSync(path.join(before, relative), 'utf8'), filename);
  return original(module, filename);
};
