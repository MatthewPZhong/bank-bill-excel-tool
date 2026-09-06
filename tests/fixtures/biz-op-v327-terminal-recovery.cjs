'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createHost } = require('../helpers/biz-op-v327-host');
const { writeXlsx, opRow } = require('../helpers/biz-op-v327-xlsx');

const [root, terminal, cut, holdFlag, phase] = process.argv.slice(2);
const evidencePath = path.join(root, 'evidence.json');
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const plain = (value) => JSON.parse(JSON.stringify(value));
function facts(f, taskId) {
  const task = f.module.catalog.task(taskId);
  return plain({ status: task.status, failureCode: task.failureCode,
    receipt: f.module.catalog.receipt(taskId),
    publicationReceipt: terminal === 'succeeded' ? f.module.publication.fact(taskId).receipt : null,
    counters: f.db.prepare('SELECT * FROM biz_op_v327_version_counters').all(),
    heads: f.db.prepare('SELECT * FROM biz_op_v327_input_heads').all() });
}
function prepared(f) {
  return f.db.prepare("SELECT COUNT(*) AS n FROM background_execution_recovery_observation_attempts WHERE status='prepared'").get().n;
}

(async () => {
  let context; let taskId; let unavailable = false; let armed = false; let anchored = false;
  let healthyCalls = 0; let firstObservation = null; let before;
  const saved = phase === 'recover' ? JSON.parse(fs.readFileSync(evidencePath)) : null;
  if (saved) { taskId = saved.taskId; before = saved.before; }
  const hooks = [];
  const f = await createHost({ after(fn) { hooks.push(fn); } }, {
    root: path.join(root, 'app'), keep: true, transientAttempts: 3,
    beforeBootstrap(value) { context = value; },
    wrapInspector(inspect) { return (source) => {
      if (source.taskRunId === taskId) {
        if (unavailable) throw Object.assign(new Error('临时 I/O 故障'), { code: 'TEST_TRANSIENT' });
        healthyCalls += 1;
        // 在回调外断言，避免断言异常被平台当作临时 I/O 错误重试后吞掉。
        firstObservation ||= { facts: facts(context, taskId), prepared: prepared(context),
          holds: context.db.prepare("SELECT COUNT(*) AS n FROM background_execution_recovery_holds WHERE status='active'").get().n };
      }
      return inspect(source);
    }; },
    wrapRecoveryOwner(owner) { return { ...owner, reserveObservationAnchor(input) {
      const result = owner.reserveObservationAnchor(input);
      if (armed && input.scope.taskRunId === taskId) {
        anchored = true;
        if (cut === 'anchor') process.exit(75);
      }
      return result;
    } }; },
    wrapRecoveryControl(control) { return { runInControlTransaction(work) {
      return control.runInControlTransaction((tx) => {
        const result = work(tx);
        // 真退出到已执行写入、尚未 COMMIT 的窗口；新进程由 SQLite 回滚。
        if (armed && anchored && cut === 'bundle') process.exit(76);
        return result;
      });
    } }; }
  });
  async function assertConverged(evidence) {
    if (phase !== 'recover' || cut !== 'retry') {
      assert.ok(firstObservation, '恢复必须真的执行 Inspector');
      assert.deepEqual(firstObservation.facts, evidence.before);
      assert.equal(firstObservation.holds, 1);
      assert.equal(firstObservation.prepared, 0, 'Inspector 前必须先原子完成旧 anchor');
    }
    assert.deepEqual(facts(f, taskId), evidence.before);
    assert.equal(prepared(f), 0); assert.equal(f.module.recovery.openObligations(), false);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM biz_op_v327_read_pins WHERE task_run_id=?').get(taskId).n, 0);
    assert.equal(sha(evidence.input), evidence.inputHash);
    if (terminal === 'succeeded') {
      assert.equal(f.module.publication.record(taskId).acknowledged, 1);
      assert.equal(f.module.publication.record(taskId).cleanup_completed, 1);
      assert.equal(sha(evidence.target), evidence.targetHash);
    }
    assert.equal((await f.module.recovery.run()).ready, true);
    assert.deepEqual(facts(f, taskId), evidence.before);
  }
  if (phase === 'recover') {
    assert.equal(f.bootstrap.ready, true);
    if (cut !== 'retry') assert.ok(healthyCalls > 0, '重启必须真的进入 Inspector');
    await assertConverged(saved);
    for (const hook of hooks.reverse()) await hook();
    process.stdout.write('原 Task/receipt/版本保持，来源收敛，重复恢复通过\n');
    return;
  }
  const input = path.join(root, 'input.xlsx');
  await writeXlsx(input, { kind: 'OP', rowCount: 1, row: () => opRow(terminal === 'failed' ? { end: '999' } : {}) });
  const controller = new AbortController();
  const imported = await f.run([input], { signal: controller.signal, afterWorker(value) {
    taskId = value.taskRunId;
    if (terminal === 'cancelled') controller.abort();
  } });
  let target;
  if (terminal === 'succeeded') {
    // PR4 接入该分支；真实 Publisher 已提交，仅注入本地 ACK 写入故障。
    const { request } = require('../helpers/biz-op-v327-export');
    assert.equal(imported.status, 'ok');
    f.outputRoot = path.join(root, 'exports'); fs.mkdirSync(f.outputRoot);
    f.db.exec(`CREATE TEMP TRIGGER fail_ack BEFORE UPDATE OF acknowledged ON biz_op_v327_publications
      WHEN NEW.acknowledged=1 BEGIN SELECT RAISE(FAIL,'临时 ACK 写入故障'); END`);
    const result = await request(f, 'OP_CHECK', imported.receipt.outcome.datasets[0].datasetId);
    assert.equal(result.status, 'ok'); taskId = result.taskRunId; target = path.join(f.outputRoot, 'op-check.xlsx');
    assert.equal(f.module.publication.record(taskId).acknowledged, 0);
    f.db.exec('DROP TRIGGER fail_ack');
  } else assert.equal(imported.status, terminal === 'failed' ? 'error' : 'cancelled');
  before = facts(f, taskId); assert.equal(before.status, terminal);
  const evidence = { taskId, before, input, inputHash: sha(input), target, targetHash: target ? sha(target) : null };
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  unavailable = true;
  if (holdFlag === 'true') {
    assert.equal((await f.module.recovery.run()).ready, false);
    assert.equal(prepared(f), 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM background_execution_recovery_holds WHERE status='active' AND task_run_id=?").get(taskId).n, 1);
  }
  armed = true;
  const failed = await f.module.recovery.run();
  assert.equal(cut, 'retry', '故障窗口必须已真实退出');
  assert.equal(failed.ready, false); assert.equal(prepared(f), 0);
  assert.deepEqual(facts(f, taskId), before);
  armed = false; unavailable = false;
  const recovered = await f.module.recovery.run(); assert.equal(recovered.ready, true, JSON.stringify(recovered));
  assert.ok(healthyCalls > 0, '依赖恢复后必须真的进入 Inspector');
  await assertConverged(evidence);
  process.exit(73);
})().catch((error) => { process.stderr.write(error.stack + '\n'); process.exit(1); });
