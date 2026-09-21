'use strict';

// 只记录公开 TaskPolicy 表面；callable 标记仅证明注册，行为须另外执行样例。
function snapshotArchivePolicies(policies) {
  return [...policies].sort((left, right) => left.channel.localeCompare(right.channel, 'en')).map((policy) => (
    Object.fromEntries(Object.keys(policy).sort().map((key) => [
      key,
      typeof policy[key] === 'function' ? '[callable]' : policy[key]
    ]))
  ));
}

// 调用方显式传入 policies，后续 descriptor 聚合结果可复用同一基线探针。
async function observeArchiveBehavior(policy, scenario) {
  const args = structuredClone(scenario.args || []);
  const effects = [];
  if (Object.hasOwn(scenario, 'flowEvidence')) {
    const invocationIndex = scenario.hook === 'resultFlowIdentities' ? 2 : 0;
    const invocation = args[invocationIndex] || {};
    args[invocationIndex] = invocation;
    invocation.resolveFlowEvidence = async (identityType) => {
      effects.push({ resolveFlowEvidence: identityType });
      return structuredClone(scenario.flowEvidence);
    };
  }
  if (scenario.preparedResolver) {
    const invocation = args[0] || {};
    args[0] = invocation;
    invocation.prepared = invocation.prepared || {};
    invocation.prepared.filePlanResolver = ({ taskRun }) => {
      effects.push({ taskRun });
      return { inputFiles: [], outputFiles: [], taskRunId: taskRun.taskRunId };
    };
  }
  if (scenario.preRecoveryFresh) {
    const invocation = args[0] || {};
    args[0] = invocation;
    invocation.prepared = invocation.prepared || {};
    invocation.prepared.assertPreRecoveryFresh = () => {
      effects.push({ assertPreRecoveryFresh: true });
      if (scenario.preRecoveryFresh === 'reject') {
        const error = new Error('测试中的来源已变化');
        error.code = 'BASELINE_SOURCE_CHANGED';
        throw error;
      }
    };
  }
  try {
    if (typeof policy[scenario.hook] !== 'function') {
      throw new TypeError(`缺少归档 hook：${scenario.hook}`);
    }
    return { value: await policy[scenario.hook](...args), effects };
  } catch (error) {
    return { error: { name: error.name, code: error.code || null }, effects };
  }
}

module.exports = { snapshotArchivePolicies, observeArchiveBehavior };
