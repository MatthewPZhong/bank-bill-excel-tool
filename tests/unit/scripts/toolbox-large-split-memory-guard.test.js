'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assessScanMemoryGrowth,
  assessScanMemorySamples,
  collectMemorySamples,
  verifyMemoryGuardModel
} = require('../../../scripts/integration/toolbox-large-split-multi-sheet');

test('RSS 低信号同时要求固定包络与严格低于线性外推', () => {
  const sublinear = assessScanMemoryGrowth(8, 23, 3);
  const exactLinear = assessScanMemoryGrowth(8, 24, 3);
  const superlinear = assessScanMemoryGrowth(6, 29, 3);
  const envelopeBoundary = assessScanMemoryGrowth(8, 32, 3);

  assert.equal(sublinear.valid, true);
  assert.equal(sublinear.classification, 'bounded-low-signal');
  assert.equal(sublinear.sublinearLimitMB, 32);
  assert.equal(sublinear.strictlyBelowLinear, true);
  assert.equal(sublinear.sublinearWithinBudget, true);
  for (const rejected of [exactLinear, superlinear, envelopeBoundary]) {
    assert.equal(rejected.classification, 'bounded-low-signal');
    assert.equal(rejected.strictlyBelowLinear, false);
    assert.equal(rejected.sublinearWithinBudget, false);
  }
});

test('RSS 多样本保留独立中位裁决并以 paired margin 只新增拒绝，任一样本硬上限独立失败', () => {
  const stable = assessScanMemorySamples([7, 8, 8], [17, 23, 22], 3);
  const boundaryJitter = assessScanMemorySamples([9, 8, 8], [26, 24, 23], 3);
  const pairedMismatch = assessScanMemorySamples([20, 40, 100], [60, 120, 20], 3);
  const spike = assessScanMemorySamples([7, 8, 8], [17, 151, 22], 3);
  const measurableSpike = assessScanMemorySamples([49, 49, 49], [94, 150, 93], 3);

  assert.equal(stable.valid, true);
  assert.equal(stable.sampleCount, 3);
  assert.equal(stable.tier1DeltaMB, 8);
  assert.equal(stable.tier2DeltaMB, 22);
  assert.deepEqual(stable.budgetMarginsMB, [-15, -9, -10]);
  assert.deepEqual(stable.linearMarginsMB, [-4, -1, -2]);
  assert.equal(stable.budgetMarginMedianMB, -10);
  assert.equal(stable.linearMarginMedianMB, -2);
  assert.equal(stable.sublinearWithinBudget, true);
  assert.equal(stable.tier2WithinCeiling, true);
  assert.equal(boundaryJitter.tier1DeltaMB, 8);
  assert.equal(boundaryJitter.tier2DeltaMB, 24);
  assert.equal(boundaryJitter.classification, 'bounded-low-signal');
  assert.deepEqual(boundaryJitter.budgetMarginsMB, [-3.5, -8, -9]);
  assert.deepEqual(boundaryJitter.linearMarginsMB, [-1, 0, -1]);
  assert.equal(boundaryJitter.budgetMarginMedianMB, -8);
  assert.equal(boundaryJitter.linearMarginMedianMB, -1);
  assert.equal(boundaryJitter.strictlyBelowLinear, false);
  assert.equal(boundaryJitter.sublinearWithinBudget, false);
  assert.equal(assessScanMemoryGrowth(40, 60, 3).sublinearWithinBudget, true);
  assert.equal(pairedMismatch.tier1DeltaMB, 40);
  assert.equal(pairedMismatch.tier2DeltaMB, 60);
  assert.deepEqual(pairedMismatch.budgetMarginsMB, [14, 44, -146]);
  assert.deepEqual(pairedMismatch.linearMarginsMB, [0, 0, -280]);
  assert.equal(pairedMismatch.budgetMarginMedianMB, 14);
  assert.equal(pairedMismatch.linearMarginMedianMB, 0);
  assert.equal(pairedMismatch.sublinearWithinBudget, false);
  assert.equal(spike.tier2DeltaMB, 22);
  assert.equal(spike.sublinearWithinBudget, true);
  assert.equal(spike.tier2WithinCeiling, false);
  assert.equal(measurableSpike.sublinearWithinBudget, false);
  assert.equal(measurableSpike.tier2WithinCeiling, false);
});

test('RSS 对 16MB tier1 保护区与可测预算边界两侧对称追加两轮成对采样', () => {
  for (const scenario of [
    { initial: [9, 26], extra: [8, 24, 8, 23] },
    { initial: [16, 31], extra: [15, 30, 16, 31] }
  ]) {
    const calls = [];
    const results = scenario.extra.slice();
    const samples = collectMemorySamples(
      'tier1.xlsx',
      'tier2.xlsx',
      { deltaMB: scenario.initial[0] },
      { deltaMB: scenario.initial[1] },
      3,
      (filePath) => {
        calls.push(filePath);
        return { deltaMB: results.shift() };
      },
      () => {}
    );
    assert.deepEqual(calls, ['tier1.xlsx', 'tier2.xlsx', 'tier1.xlsx', 'tier2.xlsx']);
    assert.deepEqual(samples.tier1Samples, [scenario.initial[0], scenario.extra[0], scenario.extra[2]]);
    assert.deepEqual(samples.tier2Samples, [scenario.initial[1], scenario.extra[1], scenario.extra[3]]);
  }

  for (const scenario of [
    { initial: [50, 83], extra: [51, 84, 49, 82] },
    { initial: [50, 99], extra: [51, 100, 49, 98] }
  ]) {
    const calls = [];
    const results = scenario.extra.slice();
    const samples = collectMemorySamples(
      'tier1.xlsx',
      'tier2.xlsx',
      { deltaMB: scenario.initial[0] },
      { deltaMB: scenario.initial[1] },
      3,
      (filePath) => {
        calls.push(filePath);
        return { deltaMB: results.shift() };
      },
      () => {}
    );
    assert.deepEqual(calls, ['tier1.xlsx', 'tier2.xlsx', 'tier1.xlsx', 'tier2.xlsx']);
    assert.deepEqual(samples.tier1Samples, [scenario.initial[0], scenario.extra[0], scenario.extra[2]]);
    assert.deepEqual(samples.tier2Samples, [scenario.initial[1], scenario.extra[1], scenario.extra[3]]);
  }

  const logs = [];
  const stableWindowsSamples = collectMemorySamples(
    'tier1.xlsx',
    'tier2.xlsx',
    { deltaMB: 49 },
    { deltaMB: 94 },
    3,
    (filePath) => ({ deltaMB: filePath === 'tier1.xlsx' ? 49 : 94 }),
    (message) => logs.push(message)
  );
  assert.deepEqual(stableWindowsSamples.tier1Samples, [49, 49, 49]);
  assert.deepEqual(stableWindowsSamples.tier2Samples, [94, 94, 94]);
  assert.match(logs[0], /tier2=94MB，预算=89\.5MB/);
  assert.doesNotMatch(logs[0], /预算=90MB/);
  const stableWindowsAssessment = assessScanMemorySamples(
    stableWindowsSamples.tier1Samples,
    stableWindowsSamples.tier2Samples,
    3
  );
  assert.equal(stableWindowsAssessment.budgetMarginMedianMB, 4.5);
  assert.equal(stableWindowsAssessment.linearMarginMedianMB, -53);
  assert.equal(stableWindowsAssessment.sublinearWithinBudget, false);

  for (const initial of [[17, 32], [82, 130], [82, 148]]) {
    const samples = collectMemorySamples(
      'tier1.xlsx',
      'tier2.xlsx',
      { deltaMB: initial[0] },
      { deltaMB: initial[1] },
      3,
      () => { throw new Error('重采保护区外不应追加采样'); },
      () => {}
    );
    assert.deepEqual(samples, { tier1Samples: [initial[0]], tier2Samples: [initial[1]] });
  }
});

test('RSS 门禁拒绝低幅和高幅的精确线性增长', () => {
  const thresholdLinear = assessScanMemoryGrowth(9, 27, 3);
  const thresholdSublinear = assessScanMemoryGrowth(9, 26, 3);
  const lowMagnitudeLinear = assessScanMemoryGrowth(13, 39, 3);
  const highMagnitudeLinear = assessScanMemoryGrowth(32, 96, 3);
  const windowsMagnitudeLinear = assessScanMemoryGrowth(49, 147, 3);

  assert.equal(thresholdLinear.classification, 'measurable-growth');
  assert.equal(thresholdLinear.sublinearLimitMB, 29.5);
  assert.equal(thresholdLinear.strictlyBelowLinear, false);
  assert.equal(thresholdLinear.sublinearWithinBudget, false);
  assert.equal(thresholdSublinear.strictlyBelowLinear, true);
  assert.equal(thresholdSublinear.sublinearWithinBudget, true);
  assert.equal(lowMagnitudeLinear.classification, 'measurable-growth');
  assert.equal(lowMagnitudeLinear.sublinearLimitMB, 35.5);
  assert.equal(lowMagnitudeLinear.sublinearWithinBudget, false);
  assert.equal(highMagnitudeLinear.classification, 'measurable-growth');
  assert.equal(highMagnitudeLinear.sublinearWithinBudget, false);
  assert.equal(windowsMagnitudeLinear.sublinearLimitMB, 89.5);
  assert.equal(windowsMagnitudeLinear.strictlyBelowLinear, false);
  assert.equal(windowsMagnitudeLinear.sublinearWithinBudget, false);
});

test('RSS 门禁独立保留 150MB 硬上限与可测亚线性预算', () => {
  const sublinear = assessScanMemoryGrowth(20, 30, 3);
  const ceiling = assessScanMemoryGrowth(100, 150, 3);
  const observedBoundary = assessScanMemoryGrowth(82, 139, 3);
  const observedOverflow = assessScanMemoryGrowth(82, 140, 3);

  assert.equal(sublinear.sublinearWithinBudget, true);
  assert.equal(sublinear.tier1WithinCeiling, true);
  assert.equal(sublinear.tier2WithinCeiling, true);
  assert.equal(ceiling.sublinearWithinBudget, true);
  assert.equal(ceiling.tier2WithinCeiling, false);
  assert.equal(observedBoundary.sublinearLimitMB, 139);
  assert.equal(observedBoundary.sublinearWithinBudget, true);
  assert.equal(observedOverflow.sublinearWithinBudget, false);
});

test('RSS 门禁对非法输入失败关闭并通过内建模型自校验', () => {
  for (const args of [
    [-1, 10, 3],
    [6, Number.POSITIVE_INFINITY, 3],
    [6, 29, 1]
  ]) {
    const result = assessScanMemoryGrowth(...args);
    assert.equal(result.valid, false);
    assert.equal(result.sublinearWithinBudget, false);
  }
  for (const [tier1Samples, tier2Samples] of [
    [[], []],
    [[6, 7], [17, 18]],
    [[6, Number.NaN, 7], [17, 18, 19]],
    [[6, 7, 8], [17]]
  ]) {
    const result = assessScanMemorySamples(tier1Samples, tier2Samples, 3);
    assert.equal(result.valid, false);
    assert.equal(result.sublinearWithinBudget, false);
  }
  assert.doesNotThrow(() => verifyMemoryGuardModel());
});
