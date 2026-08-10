'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createBusinessFlowResolver,
  normalizeIdentity
} = require('../../../src/main-process/archive-center/business-flow-resolver');

function createHarness() {
  const anchors = new Map();
  const calls = [];
  const archiveService = {
    async replayFlowBindIntents(identity) {
      calls.push({ type: 'replay', identity });
      return { ok: true, replayed: 0 };
    },
    async persistFlowBindIntent(payload) {
      calls.push({ type: 'persist-intent', payload });
      return { ok: true, status: 'persisted', intent: payload };
    },
    async findFlowAnchor(identity) {
      calls.push({ type: 'find', identity });
      return { ok: true, anchor: anchors.get(JSON.stringify(identity)) || null };
    },
    async bindFlowAnchor(payload) {
      calls.push({ type: 'bind', payload });
      const key = JSON.stringify({
        moduleId: payload.moduleId,
        identityType: payload.identityType,
        identityValue: payload.identityValue
      });
      const existing = anchors.get(key);
      if (existing && existing.parentRunId !== payload.parentRunId) {
        return { ok: false, message: 'conflict' };
      }
      const anchor = {
        moduleId: payload.moduleId,
        identityType: payload.identityType,
        identityValue: payload.identityValue,
        parentRunId: payload.parentRunId,
        sourceBatchId: payload.sourceBatchId
      };
      anchors.set(key, anchor);
      return { ok: true, anchor };
    }
  };
  return {
    anchors,
    archiveService,
    calls,
    resolver: createBusinessFlowResolver({
      archiveService,
      createParentRunId: () => 'parent-new'
    })
  };
}

test('显式 parent 优先，且不查询持久 anchor', async () => {
  const { resolver, calls } = createHarness();
  assert.deepEqual(await resolver.resolve({
    moduleId: 'statement-generator',
    startsNewFlow: false,
    explicitParentRunId: 'parent-explicit',
    identity: { type: 'business-run-id', value: 'run-1' }
  }), {
    parentRunId: 'parent-explicit',
    source: 'inherited',
    identity: null
  });
  assert.deepEqual(calls, []);
});

test('新流程先建立 parent，稳定业务 identity 可在后续任务恢复 parent', async () => {
  const { resolver, calls } = createHarness();
  const first = await resolver.resolve({
    moduleId: 'pending-reconciliation',
    startsNewFlow: true,
    identity: { type: 'business-run-id', value: 'run-42' }
  });
  assert.equal(first.source, 'new');
  await resolver.bind({
    moduleId: 'pending-reconciliation',
    parentRunId: first.parentRunId,
    sourceBatchId: 7,
    identities: [
      { type: 'business-run-id', value: 'run-42' },
      { type: 'business-run-id', value: 'run-42' }
    ]
  });
  const restored = await resolver.resolve({
    moduleId: 'pending-reconciliation',
    startsNewFlow: false,
    identity: { identityType: 'business-run-id', identityValue: 'run-42' }
  });
  assert.equal(restored.parentRunId, 'parent-new');
  assert.equal(restored.source, 'business-run');
  assert.equal(calls.filter((call) => call.type === 'bind').length, 1);
});

test('operation token 使用独立来源标签', async () => {
  const { resolver } = createHarness();
  await resolver.bind({
    moduleId: 'position-reconciliation-process',
    parentRunId: 'position-parent',
    sourceBatchId: 8,
    identities: [{ type: 'operation-token', value: 'op-1' }]
  });
  const restored = await resolver.resolve({
    moduleId: 'position-reconciliation-process',
    startsNewFlow: false,
    identity: { type: 'operation-token', value: 'op-1' }
  });
  assert.equal(restored.parentRunId, 'position-parent');
  assert.equal(restored.source, 'operation-token');
});

test('月份、文件 hash 和 renderer state 不能冒充稳定 identity', () => {
  for (const type of ['month', 'year-month', 'sha256', 'file-hash', 'renderer-state']) {
    assert.throws(
      () => normalizeIdentity({ type, value: 'same' }),
      /禁止使用不稳定业务身份/
    );
  }
});

test('锚点冲突 fail-closed，不回退新流程', async () => {
  const resolver = createBusinessFlowResolver({
    archiveService: {
      async replayFlowBindIntents() { return { ok: true, replayed: 0 }; },
      async persistFlowBindIntent() { throw new Error('unused'); },
      async findFlowAnchor() { return { ok: false, message: 'db unavailable' }; },
      async bindFlowAnchor() { throw new Error('unused'); }
    },
    createParentRunId: () => 'must-not-be-used'
  });
  await assert.rejects(
    resolver.resolve({
      moduleId: 'biz-op-recon',
      startsNewFlow: false,
      identity: { type: 'business-run-id', value: 'run-1' }
    }),
    /db unavailable/
  );
});

test('显式新流程不查询或继承相同 identity 的旧 anchor', async () => {
  const { resolver, calls } = createHarness();
  await resolver.bind({
    moduleId: 'pending-reconciliation',
    parentRunId: 'old-parent',
    sourceBatchId: 3,
    identities: [{ type: 'operation-token', value: 'retry-1' }]
  });
  calls.length = 0;
  const rerun = await resolver.resolve({
    moduleId: 'pending-reconciliation',
    startsNewFlow: true,
    identity: { type: 'operation-token', value: 'retry-1' }
  });
  assert.equal(rerun.parentRunId, 'parent-new');
  assert.equal(rerun.source, 'new');
  assert.equal(calls.some((call) => call.type === 'find'), false);
});

test('历史稳定 run 首次无 anchor 时建立并绑定新 parent，重建 resolver 后继承', async () => {
  const { resolver, archiveService } = createHarness();
  const first = await resolver.resolve({
    moduleId: 'biz-op-recon',
    startsNewFlow: false,
    identity: { type: 'business-run-id', value: 'historical-run-9' }
  });
  assert.deepEqual(first, {
    parentRunId: 'parent-new',
    source: 'new',
    identity: { identityType: 'business-run-id', identityValue: 'historical-run-9' }
  });
  await resolver.bind({
    moduleId: 'biz-op-recon',
    parentRunId: first.parentRunId,
    sourceBatchId: 19,
    identities: [first.identity]
  });
  const afterRestart = createBusinessFlowResolver({
    archiveService,
    createParentRunId: () => 'must-not-be-used'
  });
  const restored = await afterRestart.resolve({
    moduleId: 'biz-op-recon',
    startsNewFlow: false,
    identity: { type: 'business-run-id', value: 'historical-run-9' }
  });
  assert.equal(restored.parentRunId, 'parent-new');
  assert.equal(restored.source, 'business-run');
});

test('续接流程没有稳定 identity 时仍 fail-closed', async () => {
  const { resolver } = createHarness();
  await assert.rejects(
    resolver.resolve({ moduleId: 'biz-op-recon', startsNewFlow: false }),
    (error) => error.code === 'ARCHIVE_FLOW_IDENTITY_REQUIRED'
  );
});

test('startsNewFlow 必须显式，且新流程不能同时继承 parent', async () => {
  const { resolver } = createHarness();
  await assert.rejects(
    resolver.resolve({ moduleId: 'statement-generator' }),
    /startsNewFlow 必须显式/
  );
  await assert.rejects(
    resolver.resolve({
      moduleId: 'statement-generator',
      startsNewFlow: true,
      explicitParentRunId: 'old-parent'
    }),
    /不能同时继承/
  );
});
