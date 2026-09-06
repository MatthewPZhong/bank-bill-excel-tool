'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const { parentPort } = require('node:worker_threads');
const { createCanonicalEventEmitter } = require('../background-execution/adapters/canonical-event-emitter');
const { validateEnvelope } = require('../background-execution/protocol-validator');
const { createDirectionSequenceTracker } = require('../background-execution/sequence-tracker');
const { ACTIONS, fail } = require('./contracts');
const { createBizOpPayloadStore } = require('./payload-store');
const { runImportPipeline } = require('./import-pipeline');

let emit;
let terminal = false;
let cancelled = false;
const sequence = createDirectionSequenceTracker();
function safePoint() { if (cancelled) fail('BIZOP_CANCELLED', '业务 OP 任务已取消'); }
async function validateCandidate(input, envelope) {
  const handle = await fs.promises.open(input.planPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    if ((await handle.stat()).size > 65536) fail('BIZOP_PLAN_INVALID');
    bytes = await handle.readFile();
  } finally { await handle.close(); }
  if (bytes.length > 65536 || createHash('sha256').update(bytes).digest('hex') !== input.planDigest) fail('BIZOP_PLAN_INVALID');
  const plan = JSON.parse(bytes);
  if (plan.taskRunId !== envelope.context.value.taskRunId || plan.operationKey !== envelope.operationKey) fail('BIZOP_PLAN_OWNER_INVALID');
  if (plan.phase === 'xlsx-import-v1' && envelope.actionKey === 'biz-op-v327:import-candidate') {
    const payloadStore = createBizOpPayloadStore({ userDataDir: plan.userDataDir });
    const result = await runImportPipeline({ payloadStore, taskRunId: plan.taskRunId, intentDigest: plan.intentDigest,
      candidateRef: plan.candidateRef, reportRef: plan.reportRef, files: plan.files,
      options: plan.options, planDigest: input.planDigest, cancelToken: { get cancelled() { return cancelled; } } });
    return { ...result, planDigest: input.planDigest };
  }
  // 保留 PR1b 的最小候选验证入口，独立覆盖目录提交/进程崩溃合同。
  if (plan.phase !== 'candidate-validation' || !['biz-op-v327:import-candidate', 'biz-op-v327:run-candidate'].includes(envelope.actionKey)) {
    fail('BIZOP_PHASE_NOT_IMPLEMENTED', '该阶段尚未启用');
  }
  safePoint();
  const target = path.join(plan.candidateDirectory, 'part-000001.sqlite');
  await fs.promises.copyFile(plan.originalPath, target, fs.constants.COPYFILE_EXCL);
  safePoint();
  const url = pathToFileURL(target);
  url.searchParams.set('mode', 'ro'); url.searchParams.set('immutable', '1');
  const db = new DatabaseSync(url.href, { readOnly: true });
  let rowCount;
  try {
    const integrity = db.prepare('PRAGMA quick_check').get();
    if (Object.values(integrity)[0] !== 'ok') fail('BIZOP_CANDIDATE_SQLITE_INVALID');
    rowCount = db.prepare('SELECT COUNT(*) AS n FROM candidate_rows').get().n;
  } finally { db.close(); }
  const hasher = createHash('sha256');
  for await (const chunk of fs.createReadStream(target)) { safePoint(); hasher.update(chunk); }
  return { contractVersion: 1, candidateRef: plan.candidateRef, planDigest: input.planDigest,
    rowCount, sha256: hasher.digest('hex') };
}
function sendFailure(error) {
  if (terminal || !emit) return;
  terminal = true;
  emit('job:error', { error: { code: /^BIZOP_[A-Z_]+$/.test(error.code || '') ? error.code : 'BIZOP_CANDIDATE_FAILED',
    message: '业务 OP 候选处理未完成', stage: 'execute', detailLines: [] } });
  parentPort.close();
}
parentPort.on('message', (message) => {
  try {
    const envelope = validateEnvelope(message);
    sequence.observe(envelope);
    if (envelope.direction !== 'command' || !ACTIONS[envelope.actionKey]) fail('BIZOP_COMMAND_INVALID');
    if (envelope.operation === 'job:start' && !emit) {
      emit = createCanonicalEventEmitter(envelope, (event) => parentPort.postMessage(event));
      validateCandidate(envelope.payload.input, envelope).then((result) => {
        if (terminal) return;
        terminal = true;
        emit('job:done', { result });
        parentPort.close();
      }, sendFailure);
    } else if (envelope.operation === 'job:cancel' && emit && !terminal) {
      cancelled = true;
      emit('cancel:ack', { cancellation: { scope: 'job' } });
    } else fail('BIZOP_COMMAND_INVALID');
  } catch (error) { if (emit) sendFailure(error); else throw error; }
});
