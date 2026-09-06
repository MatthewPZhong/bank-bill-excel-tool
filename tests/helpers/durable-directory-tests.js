'use strict';
const test = require('node:test');
const os = require('node:os');
const { fsyncDirectory } = require('../../src/main-process/background-execution/durable-file');
const capability = fsyncDirectory(os.tmpdir());

// 不模拟持久化成功。此类成功路径在具备真实目录屏障的 CI 宿主执行；不支持时明确 SKIP。
function durableDirectoryTest(name, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  return test(name, { ...options, skip: capability.capability === 'supported' ? options.skip
    : `宿主目录 fsync 不支持 (${capability.errorCode})；生产仍拒绝提交，成功路径由 POSIX CI 验证` }, callback);
}
module.exports = { durableDirectoryTest, directoryDurabilityCapability: capability };
