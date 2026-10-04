'use strict';

const os = require('node:os');
const { ResourceGovernorError } = require('./resource-lease');

// 同步传感器只返回资源指标；不接受或记录路径、业务行和账户信息。
function createMemorySampler({ freeMemory = os.freemem, now = Date.now } = {}) {
  return () => {
    try {
      const availableBytes = freeMemory();
      const sampledAt = now();
      if (!Number.isSafeInteger(availableBytes) || availableBytes < 0 ||
          !Number.isSafeInteger(sampledAt) || sampledAt < 0) throw new TypeError('采样数值无效');
      return Object.freeze({ availableBytes, sampledAt, commitAvailableBytes: null });
    } catch (_error) {
      throw new ResourceGovernorError('RESOURCE_MEMORY_SAMPLE_UNAVAILABLE', '无法取得有效的系统可用内存采样');
    }
  };
}

// heapUsed/external 属于调用线程；rss 属于整个 PID，不按 worker 求和。
function sampleProcessMemory({ memoryUsage = process.memoryUsage, pid = process.pid } = {}) {
  const usage = memoryUsage();
  return Object.freeze({
    pid,
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBufferBytes: usage.arrayBuffers === undefined ? null : usage.arrayBuffers
  });
}

module.exports = { createMemorySampler, sampleProcessMemory };
