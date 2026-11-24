'use strict';

// v3.2.22 B57 / B58：工具箱合表、按字段拆分（单值 / 多文件）的确认前冻结、父目录身份与发布前输入核对。
//   夹具见 tests/helpers/toolbox-main-handlers.js（执行 Main 原始 prepare / execute 与发布 wrapper，文件读写与发布器为真实实现）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { assertFilePlanFresh } = require('../../../src/main-process/archive-center/file-plan');
const { captureTargetParentIdentity } = require('../../../src/main-process/archive-center/target-parent-identity');
const { prepareIpcTaskInvocation } = require('../../../src/main-process/archive-center/ipc-task-contract');
const { pathsAlias } = require('../../../src/main-process/toolbox-target-identity');
const {
  CASES, MULTI_PAYLOAD, caseOverrides, casePayload, duringFullPlanSampling, firstColumn, loadHandlers, setup: setupFixture,
  generators, simulateUnreliableParentIdentity
} = require('../../helpers/toolbox-main-handlers');

const setup = (t) => setupFixture((fn) => t.after(fn));
const { mergeToolboxFilesToXlsx, exportToolboxFilter, exportToolboxMultiFilters } = generators;

// ---------- B57：多文件拆分在覆盖确认前冻结全部目标 ----------

for (const change of ['created', 'replaced']) {
  test(`多文件拆分：覆盖确认期间目标被${change === 'created' ? '新建' : '替换'}时拒绝，不覆盖任何文件（B57）`, async (t) => {
    const env = setup(t);
    const existing = path.join(env.output, 'A.xlsx');
    const fresh = path.join(env.output, 'B.xlsx');
    fs.writeFileSync(existing, 'old-A');
    const { calls, run } = loadHandlers(env, {
      showMessageBox: () => {
        if (change === 'created') fs.writeFileSync(fresh, 'foreign-B');
        else {
          fs.writeFileSync(`${existing}.tmp`, 'foreign-A');
          fs.renameSync(`${existing}.tmp`, existing);
        }
        return { response: 1 };
      }
    });
    const { prepared, result } = await run('toolbox:split:export', { ...MULTI_PAYLOAD, sourceFilePath: env.source });
    assert.equal(prepared.proceed, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'ARCHIVE_TARGET_CHANGED');
    assert.equal(calls.dialogs.length, 1);
    assert.equal(calls.dialogs[0].detail, 'A.xlsx', '冲突只列冻结时已存在的目标');
    assert.equal(calls.publication, 0);
    assert.equal(fs.readFileSync(existing, 'utf8'), change === 'created' ? 'old-A' : 'foreign-A');
    if (change === 'created') assert.equal(fs.readFileSync(fresh, 'utf8'), 'foreign-B');
    else assert.equal(fs.existsSync(fresh), false);
  });
}

test('多文件拆分：确认后沿用确认前冻结的同一 FilePlan，prepare 之后新建目标由生命周期核对拒绝（B57）', async (t) => {
  const env = setup(t);
  fs.writeFileSync(path.join(env.output, 'A.xlsx'), 'old-A');
  const { contracts, calls } = loadHandlers(env);
  const contract = contracts.get('toolbox:split:export');
  const raw = await contract.prepare({}, { ...MULTI_PAYLOAD, sourceFilePath: env.source });
  assert.equal(raw.proceed, true);
  const prepared = await prepareIpcTaskInvocation(contract, {}, [{ ...MULTI_PAYLOAD, sourceFilePath: env.source }]);
  assert.equal(calls.dialogs.length, 2);
  assert.deepEqual(prepared.filePlan.outputs.map((item) => item.targetSnapshot.exists), [true, false]);
  const sameAuthority = await prepareIpcTaskInvocation({ prepare: async () => raw, execute() {} }, {}, []);
  assert.equal(sameAuthority.filePlan, raw.filePlan, '契约层直接沿用已冻结的计划');
  fs.writeFileSync(path.join(env.output, 'B.xlsx'), 'foreign-B');
  assert.throws(() => assertFilePlanFresh(prepared.filePlan), { code: 'ARCHIVE_TARGET_CHANGED' });
});

test('合表与单值拆分：保存框返回即冻结 FilePlan（B57）', async (t) => {
  const env = setup(t);
  const { contracts } = loadHandlers(env, {
    showImportOpenDialog: async () => ({ canceled: false, filePaths: [env.source] })
  });
  const merge = await contracts.get('toolbox:merge').prepare({});
  const split = await contracts.get('toolbox:split:export').prepare({}, { sourceFilePath: env.source, splitReadToken: 't',
    field: 'Name', values: ['A'] });
  for (const prepared of [merge, split]) {
    assert.equal(prepared.proceed, true);
    assert.ok(Object.isFrozen(prepared.filePlan));
    assert.equal(prepared.filePlan.outputs[0].targetSnapshot.exists, false);
    assert.ok(prepared.filePlan.outputs[0].targetParentIdentity);
  }
});

// 先冻结目标、再访问输入：别名检查（pathsAlias）逐个访问输入期间，外部新建 / 替换目标即拒绝，不覆盖对方文件
for (const kind of Object.keys(CASES)) {
  for (const change of ['created', 'replaced']) {
    test(`${kind}：访问输入期间目标被${change === 'created' ? '新建' : '替换'}时拒绝，不覆盖对方文件（B57）`, async (t) => {
      const env = setup(t);
      const target = path.join(env.output, CASES[kind].targets[0]);
      if (change === 'replaced') fs.writeFileSync(target, 'confirmed-old');
      let touched = false;
      const { calls, run } = loadHandlers(env, caseOverrides(env, kind, {
        pathsAlias: (fsImpl, left, right) => {
          if (!touched) {
            touched = true;
            fs.writeFileSync(`${target}.tmp`, 'foreign');
            fs.renameSync(`${target}.tmp`, target);
          }
          return pathsAlias(fsImpl, left, right);
        }
      }));
      const { prepared, result } = await run(CASES[kind].channel, casePayload(env, kind));
      assert.equal(touched, true, '前置：别名检查访问了输入');
      assert.equal(prepared.proceed, false);
      assert.equal(result.code, 'ARCHIVE_TARGET_CHANGED', JSON.stringify(result));
      assert.equal(calls.publication, 0);
      assert.equal(fs.readFileSync(target, 'utf8'), 'foreign');
    });
  }
}

// ---------- B58-T4：父目录身份统一由包装层从冻结 FilePlan 传给发布器 ----------

for (const kind of Object.keys(CASES)) {
  test(`${kind}：发布前目标父目录被同路径替换时发布器拒绝，不写入新目录、不结算（B58-T4）`, async (t) => {
    const env = setup(t);
    const moved = path.join(env.root, 'out-moved');
    const { calls, run } = loadHandlers(env, caseOverrides(env, kind, {
      beforePublish: async () => {
        fs.renameSync(env.output, moved);
        fs.mkdirSync(env.output);
        fs.writeFileSync(path.join(env.output, 'new-owner.txt'), 'keep-new-owner');
      }
    }));
    const { prepared, result } = await run(CASES[kind].channel, casePayload(env, kind));
    // 前提：冻结时拿到可靠的目录身份；拿不到时按 D3 只核对路径（由下方受控用例验证），不在此断言拒绝
    if (!prepared.filePlan.outputs.every((output) => output.targetParentIdentity.identityReliable)) {
      t.skip('临时卷给不出可靠的目录身份，按 D3 退回路径核对');
      return;
    }
    assert.equal(calls.publication, 1);
    calls.publicationOptions.targets.forEach((target, index) => {
      assert.deepEqual(target.expectedTargetParentIdentity, prepared.filePlan.outputs[index].targetParentIdentity);
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'TOOLBOX_PUBLICATION_TARGET_PARENT_CHANGED', JSON.stringify(result));
    assert.equal(calls.settle, 0);
    assert.deepEqual(fs.readdirSync(env.output), ['new-owner.txt']);
    for (const name of CASES[kind].targets) assert.equal(fs.existsSync(path.join(moved, name)), false);
  });

  test(`${kind}：目标与父目录未变时照常发布并结算`, async (t) => {
    const env = setup(t);
    const { calls, run } = loadHandlers(env, caseOverrides(env, kind));
    const { result } = await run(CASES[kind].channel, casePayload(env, kind));
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(calls.settle, 1);
    const expected = { merge: [['Name', 'A', 'B']], single: [['Name', 'A']], multiple: [['Name', 'A'], ['Name', 'B']] }[kind];
    for (const [index, name] of CASES[kind].targets.entries()) {
      assert.deepEqual(await firstColumn(path.join(env.output, name)), expected[index]);
    }
  });
}

// 父目录身份的可靠性按首次冻结为准（D2、D3）：首次采样不可靠、访问输入后恢复可靠时，目录与目标都未变即照常导出；
//   一直不可靠时同路径替换的目录只核对路径，按 v3.2.3 兼容约定照常发布（不因文件系统能力未知误伤）
for (const kind of Object.keys(CASES)) {
  test(`${kind}：父目录身份首次采样不可靠、之后恢复时照常导出（B57）`, async (t) => {
    const env = setup(t);
    const simulated = simulateUnreliableParentIdentity(env.output, 1);
    t.after(simulated.restore);
    const { calls, run } = loadHandlers(env, caseOverrides(env, kind));
    const { prepared, result } = await run(CASES[kind].channel, casePayload(env, kind));
    assert.equal(simulated.state.count, 1, '前置：首次采样被模拟为不可靠');
    assert.equal(prepared.proceed, true, JSON.stringify(prepared.result));
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(calls.settle, 1);
  });

  // 多文件拆分的暂存目录就在目标目录里，替换目录即移走暂存产物、发布按产物缺失失败，不适用此场景
  if (kind !== 'multiple') test(`${kind}：父目录身份一直不可靠时同路径替换的目录只核对路径、照常发布（D3）`, async (t) => {
    const env = setup(t);
    const simulated = simulateUnreliableParentIdentity(env.output);
    t.after(simulated.restore);
    const moved = path.join(env.root, 'out-moved');
    const { calls, run } = loadHandlers(env, caseOverrides(env, kind, {
      beforePublish: async () => {
        fs.renameSync(env.output, moved);
        fs.mkdirSync(env.output);
      }
    }));
    const { prepared, result } = await run(CASES[kind].channel, casePayload(env, kind));
    assert.ok(prepared.filePlan.outputs.every((output) => output.targetParentIdentity.identityReliable === false), '前置：冻结的身份不可靠');
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(calls.settle, 1);
    // 发布回执（.toolbox-publish-*.journal.json）由结算后确认清理，这里只看正式输出
    assert.deepEqual(fs.readdirSync(env.output).filter((name) => !name.startsWith('.toolbox-publish-')).sort(), [...CASES[kind].targets].sort());
  });

  test(`${kind}：访问输入期间目标被建成文件夹时报目标变化（B57）`, async (t) => {
    const env = setup(t);
    const target = path.join(env.output, CASES[kind].targets[0]);
    let touched = false;
    const { calls, run } = loadHandlers(env, caseOverrides(env, kind, {
      pathsAlias: (fsImpl, left, right) => {
        if (!touched) {
          touched = true;
          fs.mkdirSync(target);
        }
        return pathsAlias(fsImpl, left, right);
      }
    }));
    const { prepared, result } = await run(CASES[kind].channel, casePayload(env, kind));
    assert.equal(touched, true, '前置：别名检查访问了输入');
    assert.equal(prepared.proceed, false);
    assert.equal(result.code, 'ARCHIVE_TARGET_CHANGED', JSON.stringify(result));
    assert.equal(calls.publication, 0);
    assert.equal(fs.statSync(target).isDirectory(), true);
  });
}

// 完整计划沿用先冻结的输出证据、不重新采样：返回的计划携带用户确认时的目标版本（Codex 第三轮 P1、P3，第四轮 P2 ×2、P3）
const captureParentIdentity = (directory) => captureTargetParentIdentity(fs, path.join(directory, 'probe.xlsx'));
for (const kind of Object.keys(CASES)) {
  test(`${kind}：完整计划采样时目标目录被临时换成有同名文件的另一处、随后换回：计划仍是确认时的目标版本，之后再换过去时核对拒绝（B57）`, async (t) => {
    const env = setup(t);
    const other = path.join(env.root, 'out-other');
    const parked = path.join(env.root, 'out-parked');
    fs.mkdirSync(other);
    for (const name of CASES[kind].targets) fs.writeFileSync(path.join(other, name), 'unconfirmed');
    const confirmedParent = captureParentIdentity(env.output);
    const sampling = duringFullPlanSampling(() => {
      fs.renameSync(env.output, parked);
      fs.renameSync(other, env.output);
      return () => {
        fs.renameSync(env.output, other);
        fs.renameSync(parked, env.output);
      };
    });
    const { run } = loadHandlers(env, caseOverrides(env, kind, { normalizeFilePlanV1: sampling.normalizeFilePlanV1 }));
    const { prepared } = await run(CASES[kind].channel, casePayload(env, kind), { prepareOnly: true });
    assert.equal(sampling.state.calls, 1, '前置：完整计划采样期间目录被换过');
    assert.equal(prepared.proceed, true, JSON.stringify(prepared.result));
    assert.ok(prepared.filePlan.outputs.every((output) => output.targetSnapshot.exists === false
      && JSON.stringify(output.targetParentIdentity) === JSON.stringify(confirmedParent)), '计划携带确认时的目标证据');
    fs.renameSync(env.output, parked);
    fs.renameSync(other, env.output);
    assert.throws(() => assertFilePlanFresh(prepared.filePlan), { code: /^ARCHIVE_TARGET_(PARENT_)?CHANGED$/ });
    for (const name of CASES[kind].targets) assert.equal(fs.readFileSync(path.join(env.output, name), 'utf8'), 'unconfirmed');
  });

  test(`${kind}：只有完整计划采样时父目录身份暂时不可靠：计划仍带先冻结的可靠身份，照常导出（B57）`, async (t) => {
    const env = setup(t);
    if (!captureParentIdentity(env.output).identityReliable) {
      t.skip('前提不满足：临时卷给不出可靠的目录身份');
      return;
    }
    let simulated = null;
    const sampling = duringFullPlanSampling(() => {
      simulated = simulateUnreliableParentIdentity(env.output);
      return () => simulated.restore();
    });
    t.after(() => simulated && simulated.restore());
    const { calls, run } = loadHandlers(env, caseOverrides(env, kind, { normalizeFilePlanV1: sampling.normalizeFilePlanV1 }));
    const { prepared, result } = await run(CASES[kind].channel, casePayload(env, kind));
    assert.equal(sampling.state.calls, 1, '前置：完整计划采样期间身份被模拟为不可靠');
    assert.ok(prepared.filePlan.outputs.every((output) => output.targetParentIdentity.identityReliable), '沿用首次冻结的可靠身份');
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(calls.settle, 1);
  });

  test(`${kind}：父目录身份首次不可靠、完整计划采样时可靠、发布时又不可靠：按首次冻结只核对路径，照常导出（B57）`, async (t) => {
    const env = setup(t);
    let first = null;
    const freezing = duringFullPlanSampling(() => {
      first = simulateUnreliableParentIdentity(env.output);
      return () => first.restore();
    }, { targetsOnly: true });
    t.after(() => first && first.restore());
    let later = null;
    t.after(() => later && later.restore());
    const { calls, run } = loadHandlers(env, caseOverrides(env, kind, {
      normalizeFilePlanV1: freezing.normalizeFilePlanV1,
      beforePublish: async () => {
        later = simulateUnreliableParentIdentity(env.output);
      }
    }));
    const { prepared, result } = await run(CASES[kind].channel, casePayload(env, kind));
    assert.ok(freezing.state.calls === 1 && first.state.count > 0, '前置：首次冻结的身份不可靠');
    assert.ok(later, '前置：发布前已把目录身份模拟为不可靠（按首次冻结的不可靠身份只核对路径，不再按 dev/ino 比较）');
    assert.ok(prepared.filePlan.outputs.every((output) => output.targetParentIdentity.identityReliable === false), '沿用首次冻结的不可靠身份');
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(calls.settle, 1);
  });

  test(`${kind}：完整计划规范化时目标目录被移走、之后又移回：报目标变化（中文提示），不透传系统错误（B57）`, async (t) => {
    const env = setup(t);
    const parked = path.join(env.root, 'out-parked');
    const sampling = duringFullPlanSampling(() => {
      fs.renameSync(env.output, parked);
      return () => fs.renameSync(parked, env.output);
    });
    const { calls, run } = loadHandlers(env, caseOverrides(env, kind, { normalizeFilePlanV1: sampling.normalizeFilePlanV1 }));
    const { prepared, result } = await run(CASES[kind].channel, casePayload(env, kind));
    assert.equal(sampling.state.calls, 1);
    assert.equal(prepared.proceed, false);
    assert.equal(result.code, 'ARCHIVE_TARGET_CHANGED', JSON.stringify(result));
    assert.match(result.message, /输出目标在任务确认后已变化/);
    assert.equal(calls.publication, 0);
  });

  test(`${kind}：别名检查访问路径时目标目录被移走：报目标变化（中文提示），不返回原始系统错误（B57）`, async (t) => {
    const env = setup(t);
    let moved = false;
    const { calls, run } = loadHandlers(env, caseOverrides(env, kind, {
      pathsAlias: (fsImpl, left, right) => {
        if (!moved) {
          moved = true;
          fs.renameSync(env.output, path.join(env.root, 'out-moved'));
        }
        return pathsAlias(fsImpl, left, right);
      }
    }));
    const { prepared, result } = await run(CASES[kind].channel, casePayload(env, kind));
    assert.equal(moved, true, '前置：别名检查期间移走了目标目录');
    assert.equal(prepared.proceed, false);
    assert.equal(result.code, 'ARCHIVE_TARGET_CHANGED', JSON.stringify(result));
    assert.match(result.message, /输出目标在任务确认后已变化/);
    assert.equal(calls.publication, 0);
  });
}

// ---------- B58-T3：生成前后源文件被替换时不形成正式输出 ----------

for (const kind of Object.keys(CASES)) {
  for (const stage of ['before-generation', 'after-generation']) {
    test(`${kind}：${stage === 'before-generation' ? '生成前' : '生成后、发布前'}源文件被替换时不发布（B58-T3）`, async (t) => {
      const env = setup(t);
      const replaceSource = () => {
        fs.writeFileSync(`${env.source}.tmp`, 'Name,Amount\nA,999\nB,2\n');
        fs.renameSync(`${env.source}.tmp`, env.source);
      };
      const wrap = (generate) => async (...args) => {
        if (stage === 'before-generation') replaceSource();
        const generated = await generate(...args);
        if (stage === 'after-generation') replaceSource();
        return generated;
      };
      const { calls, contracts, execute } = loadHandlers(env, caseOverrides(env, kind, {
        toolboxMergeFilesToXlsx: wrap(mergeToolboxFilesToXlsx),
        exportToolboxFilter: wrap(exportToolboxFilter),
        exportToolboxMultiFilters: wrap(exportToolboxMultiFilters)
      }));
      const contract = contracts.get(CASES[kind].channel);
      const prepared = await prepareIpcTaskInvocation(contract, {}, casePayload(env, kind) ? [casePayload(env, kind)] : []);
      assert.equal(prepared.proceed, true);
      // 生命周期在 execute 前已核对过冻结计划；之后的替换只能由读取 / 发布边界发现
      assertFilePlanFresh(prepared.filePlan);
      const result = await execute(contract, prepared);
      assert.equal(result.status, 'failed');
      assert.equal(result.code, kind === 'merge' ? 'ARCHIVE_INPUT_CHANGED' : 'TOOLBOX_SPLIT_READ_CONTEXT_STALE', JSON.stringify(result));
      assert.equal(calls.publication, 0);
      assert.equal(calls.settle, 0);
      assert.deepEqual(fs.readdirSync(env.output).filter((name) => !name.startsWith('.')), []);
    });
  }
}

test('normalizeFilePlanV1 reuseFrozenOutputsOf：沿用本进程冻结的同一组输出证据，来源不明或输出不一致时拒绝', (t) => {
  const env = setup(t);
  const { normalizeFilePlanV1 } = require('../../../src/main-process/archive-center/file-plan');
  const output = { filePath: path.join(env.output, 'result.xlsx'), role: 'output', sourceOperation: 'toolbox:merge:output' };
  const input = { filePath: env.source, role: 'input', sourceOperation: 'toolbox:merge:input' };
  const frozen = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [], outputs: [output] });
  fs.writeFileSync(output.filePath, 'created-after-freeze');
  const plan = normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [input], outputs: [output] }, { reuseFrozenOutputsOf: frozen });
  assert.equal(plan.outputs, frozen.outputs, '不重新采样');
  assert.throws(() => assertFilePlanFresh(plan), { code: 'ARCHIVE_TARGET_CHANGED' });
  for (const [label, outputs, source] of [
    ['来源不是冻结计划', [output], { ...frozen }],
    ['输出数量不同', [output, { ...output, filePath: path.join(env.output, 'other.xlsx') }], frozen],
    ['路径不同', [{ ...output, filePath: path.join(env.output, 'other.xlsx') }], frozen],
    ['来源操作不同', [{ ...output, sourceOperation: 'toolbox:split:output' }], frozen]
  ]) {
    assert.throws(() => normalizeFilePlanV1({ version: 1, allocation: 'eager', inputs: [input], outputs }, { reuseFrozenOutputsOf: source }),
      { code: 'ARCHIVE_FILE_PLAN_INVALID' }, label);
  }
});
