'use strict';

// v3.2.22 B57 / B58：工具箱合表、按字段拆分（单值 / 多文件）的确认前冻结、父目录身份与发布前输入核对。
//   夹具见 tests/helpers/toolbox-main-handlers.js（执行 Main 原始 prepare / execute 与发布 wrapper，文件读写与发布器为真实实现）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { assertFilePlanFresh } = require('../../../src/main-process/archive-center/file-plan');
const { prepareIpcTaskInvocation } = require('../../../src/main-process/archive-center/ipc-task-contract');
const { pathsAlias } = require('../../../src/main-process/toolbox-target-identity');
const {
  CASES, MULTI_PAYLOAD, caseOverrides, casePayload, firstColumn, loadHandlers, setup: setupFixture, generators
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
