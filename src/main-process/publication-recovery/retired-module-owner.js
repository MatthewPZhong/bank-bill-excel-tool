'use strict';

const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { freezeWorkerBatchContext } = require('../archive-center/worker-batch-context');

// v3.2.20 下线「业务OP数据核对」（BizOP v327）后的遗留发布 journal：旧版导出在发布中途退出、
//   未重新启动旧版就升级时，共享发布恢复索引里会留下 `biz-op-v327-export-<taskRunId>` 记录。
//   新版不再有 BizOP 领域事实，不能证明收尾或回滚是否正确；本 owner 只识别、一律 defer：
//   journal、staging、备份与目标文件原样保留给回退旧版收尾，启动发布恢复不再因 owner 未知而中止。
//   共享发布器对 defer 记录的既有失败关闭合同不变：记录存在期间新的发布仍会被拒绝（提示见 dispatch）。
//   旧版已标为 manual-recovery 的记录（旧版回滚自身失败）同样 defer，但用单独代码：旧版也无法自动收尾，只能按恢复路径人工处理。
const RETIRED_PUBLICATION_OWNER_ID = 'retired-module-publication';
const RETIRED_PUBLICATION_DEFER_CODE = 'PUBLICATION_RECOVERY_RETIRED_MODULE';
const RETIRED_PUBLICATION_MANUAL_CODE = 'PUBLICATION_RECOVERY_RETIRED_MODULE_MANUAL';
const BIZOP_V327_TASK_PREFIX = 'biz-op-v327-export-';
const BIZOP_V327_MODULE_ID = 'biz-op-recon';
const BIZOP_V327_EXPORT_TASK_KEYS = Object.freeze([
  'bizOpReconV327:export:op-raw',
  'bizOpReconV327:export:flow-raw',
  'bizOpReconV327:export:op-check',
  'bizOpReconV327:export:flow-check',
  'bizOpReconV327:export:result-full',
  'bizOpReconV327:export:result-diff',
  'bizOpReconV327:export:errors'
]);

function ownerError(code, record, cause) {
  return Object.assign(new Error(`已下线模块发布 ${record.taskId} 的归属证据不一致`), {
    code, cause, preserveTemporaryFiles: true, recoveryPaths: [record.journalPath].filter(Boolean)
  });
}

// 与旧版 BizOP owner 相同的身份前提：taskId 前缀、index 与 journal 的 exact-7 batchContext 一致、
//   taskRunId 即 taskId 后缀、taskKey 属于 BizOP v327 导出。前缀命中但证据不一致时失败关闭，不猜测归属。
function retiredContext(record) {
  const taskId = String(record && record.taskId || '');
  if (!taskId.startsWith(BIZOP_V327_TASK_PREFIX)) return null;
  const evidence = [record.indexEntry, record.journal].filter(Boolean);
  if (!evidence.length) throw ownerError('PUBLICATION_RECOVERY_OWNER_UNKNOWN', record);
  let context = null;
  for (const item of evidence) {
    if (!item.batchContext) throw ownerError('PUBLICATION_RECOVERY_OWNER_UNKNOWN', record);
    let frozen;
    try { frozen = freezeWorkerBatchContext(item.batchContext, { required: true }); }
    catch (cause) { throw ownerError('PUBLICATION_RECOVERY_OWNER_CONFLICT', record, cause); }
    if (context && !isDeepStrictEqual(context, frozen)) throw ownerError('PUBLICATION_RECOVERY_OWNER_CONFLICT', record);
    context = frozen;
  }
  if (context.moduleId !== BIZOP_V327_MODULE_ID || !BIZOP_V327_EXPORT_TASK_KEYS.includes(context.taskKey)
      || context.taskRunId !== taskId.slice(BIZOP_V327_TASK_PREFIX.length)) {
    throw ownerError('PUBLICATION_RECOVERY_OWNER_CONFLICT', record);
  }
  return context;
}

function identityFor(record, context) {
  return Object.freeze({
    ownerId: RETIRED_PUBLICATION_OWNER_ID, publisherTaskId: record.taskId,
    taskRunId: context.taskRunId, batchId: context.batchId, operationKey: context.operationKey,
    proofDigest: crypto.createHash('sha256').update(JSON.stringify(context)).digest('hex'),
    legacyProofKind: 'retired-bizop-v327-batch-context'
  });
}

function createRetiredModulePublicationOwner() {
  return Object.freeze({
    id: RETIRED_PUBLICATION_OWNER_ID,
    async identify(record) {
      const context = retiredContext(record);
      return context ? identityFor(record, context) : 'not-owned';
    },
    async authorize(record, _request, identity) {
      const context = retiredContext(record);
      if (!context || !isDeepStrictEqual(identityFor(record, context), identity)) {
        return { disposition: 'reject', identity, permission: null, code: 'PUBLICATION_RECOVERY_OWNER_UNKNOWN' };
      }
      return { disposition: 'defer', identity, permission: null,
        code: record.journalStatus === 'manual-recovery' ? RETIRED_PUBLICATION_MANUAL_CODE : RETIRED_PUBLICATION_DEFER_CODE };
    },
    async acquireObservation() { return null; }
  });
}

module.exports = {
  BIZOP_V327_EXPORT_TASK_KEYS,
  BIZOP_V327_TASK_PREFIX,
  RETIRED_PUBLICATION_DEFER_CODE,
  RETIRED_PUBLICATION_MANUAL_CODE,
  RETIRED_PUBLICATION_OWNER_ID,
  createRetiredModulePublicationOwner
};
