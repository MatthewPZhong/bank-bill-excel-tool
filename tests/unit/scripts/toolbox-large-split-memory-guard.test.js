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

test('RSS 低信号用三次中位数抗抖动，但任一样本触及硬上限仍失败', () => {
  const stable = assessScanMemorySamples([7, 8, 8], [17, 23, 22], 3);
  const spike = assessScanMemorySamples([7, 8, 8], [17, 151, 22], 3);

  assert.equal(stable.valid, true);
  assert.equal(stable.sampleCount, 3);
  assert.equal(stable.tier1DeltaMB, 8);
  assert.equal(stable.tier2DeltaMB, 22);
  assert.equal(stable.sublinearWithinBudget, true);
  assert.equal(stable.tier2WithinCeiling, true);
  assert.equal(spike.tier2DeltaMB, 22);
  assert.equal(spike.sublinearWithinBudget, true);
  assert.equal(spike.tier2WithinCeiling, false);
});

test('RSS 仅在首次 tier1 为低信号时追加两轮成对隔离采样', () => {
  const calls = [];
  const results = [7, 22, 8, 21];
  const lowSignal = collectMemorySamples(
    'tier1.xlsx',
    'tier2.xlsx',
    { deltaMB: 8 },
    { deltaMB: 23 },
    (filePath) => {
      calls.push(filePath);
      return { deltaMB: results.shift() };
    }
  );
  assert.deepEqual(calls, ['tier1.xlsx', 'tier2.xlsx', 'tier1.xlsx', 'tier2.xlsx']);
  assert.deepEqual(lowSignal.tier1Samples, [8, 7, 8]);
  assert.deepEqual(lowSignal.tier2Samples, [23, 22, 21]);

  const measurable = collectMemorySamples(
    'tier1.xlsx',
    'tier2.xlsx',
    { deltaMB: 9 },
    { deltaMB: 26 },
    () => { throw new Error('可测分支不应追加采样'); }
  );
  assert.deepEqual(measurable, { tier1Samples: [9], tier2Samples: [26] });
});

test('RSS 门禁拒绝低幅和高幅的精确线性增长', () => {
  const thresholdLinear = assessScanMemoryGrowth(9, 27, 3);
  const thresholdSublinear = assessScanMemoryGrowth(9, 26, 3);
  const lowMagnitudeLinear = assessScanMemoryGrowth(13, 39, 3);
  const highMagnitudeLinear = assessScanMemoryGrowth(32, 96, 3);

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
