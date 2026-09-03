'use strict';

// 单元测试需独立验证schema、顺序、输出等价、receipt与生命周期，不能依赖宿主目录fsync能力。
// 专用故障与真实平台用例继续覆盖生产fail-closed屏障；本preload只由显式包装的Worker加载。
const durableFile = require('../../../src/main-process/background-execution/durable-file');

durableFile.fsyncDirectory = function supportedDirectoryFsyncForUnitTest() {
  return Object.freeze({ capability: 'supported' });
};
