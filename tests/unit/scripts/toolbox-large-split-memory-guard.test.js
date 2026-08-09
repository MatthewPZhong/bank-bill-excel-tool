'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  assessScanMemoryGrowth,
  verifyMemoryGuardModel
} = require('../../../scripts/integration/toolbox-large-split-multi-sheet');

test('RSS 低信号采用固定包络，不用噪声基线计算比值', () => {
  const boundedNoise = assessScanMemoryGrowth(6, 29, 3);
  const overflow = assessScanMemoryGrowth(6, 33, 3);

  assert.equal(boundedNoise.valid, true);
  assert.equal(boundedNoise.classification, 'bounded-low-signal');
  assert.equal(boundedNoise.sublinearLimitMB, 32);
  assert.equal(boundedNoise.sublinearWithinBudget, true);
  assert.equal(overflow.classification, 'bounded-low-signal');
  assert.equal(overflow.sublinearWithinBudget, false);
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
  assert.doesNotThrow(() => verifyMemoryGuardModel());
});
