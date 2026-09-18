'use strict';

const path = require('node:path');

// 生产报告在预检阶段生成。原 producer key 与 job/文件名双向对应，不能换 key 绕过业务引用。
function positionReportSourceIdentity(filePath, producerArtifactKey) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
      || filePath.split(/[\\/]/).some((part) => part === '.' || part === '..')) return null;
  const reportDir = path.dirname(filePath);
  const jobDir = path.dirname(reportDir);
  const stagingRoot = path.dirname(jobDir);
  const jobId = path.basename(jobDir);
  if (path.basename(reportDir) !== 'anomaly-report'
      || path.basename(stagingRoot) !== 'import-staging'
      || path.basename(path.dirname(stagingRoot)) !== 'position-reconciliation'
      || path.basename(path.dirname(path.dirname(stagingRoot))) !== 'run-data'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)
      || ['.', '..'].includes(jobId) || typeof producerArtifactKey !== 'string') return null;
  const matched = /^source-import-anomaly-report(?::file-(0|[1-9][0-9]*))?$/.exec(producerArtifactKey);
  if (!matched || (matched[1] !== undefined && !Number.isSafeInteger(Number(matched[1]) + 1))) return null;
  const suffix = matched[1] === undefined ? '' : `_文件${Number(matched[1]) + 1}`;
  if (path.basename(filePath) !== `平盘来源异常数据_${jobId}${suffix}.xlsx`) return null;
  return { jobId, reportKey: `${jobId}:${producerArtifactKey}` };
}

module.exports = { positionReportSourceIdentity };
