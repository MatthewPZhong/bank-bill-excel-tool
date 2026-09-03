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
  assert.equal(sublinear.effectiveBudgetMB, 32);
  assert.equal(sublinear.strictlyBelowLinear, true);
  assert.equal(sublinear.sublinearWithinBudget, true);
  for (const rejected of [exactLinear, superlinear, envelopeBoundary]) {
    assert.equal(rejected.classification, 'bounded-low-signal');
    assert.equal(rejected.strictlyBelowLinear, false);
    assert.equal(rejected.sublinearWithinBudget, false);
  }
});

test('RSS 多样本仅对独立中位组合应用 MB 取整传播容差，paired margin 与硬上限保持严格', () => {
  const stable = assessScanMemorySamples([7, 8, 8], [17, 23, 22], 3);
  const boundaryJitter = assessScanMemorySamples([9, 8, 8], [26, 24, 23], 3);
  const pairedMismatch = assessScanMemorySamples([20, 40, 100], [60, 120, 20], 3);
  const spike = assessScanMemorySamples([7, 8, 8], [17, 151, 22], 3);
  const measurableSpike = assessScanMemorySamples([49, 49, 49], [94, 150, 93], 3);
  const tier1Spike = assessScanMemorySamples([49, 150, 49], [94, 94, 93], 3);
  const latestWindowsRunner = assessScanMemorySamples([48, 49, 49], [93, 96, 96], 3);
  const rankInversionJitter = assessScanMemorySamples([48, 49, 48], [96, 97, 97], 3);
  const stableRankInversionOverflow = assessScanMemorySamples([48, 48, 48], [97, 97, 97], 3);

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
  assert.deepEqual(boundaryJitter.budgetMarginsMB, [-11.5, -8, -9]);
  assert.deepEqual(boundaryJitter.linearMarginsMB, [-1, 0, -1]);
  assert.equal(boundaryJitter.budgetMarginMedianMB, -9);
  assert.equal(boundaryJitter.linearMarginMedianMB, -1);
  assert.equal(boundaryJitter.strictlyBelowLinear, false);
  assert.equal(boundaryJitter.sublinearWithinBudget, false);
  assert.equal(assessScanMemoryGrowth(40, 60, 3).sublinearWithinBudget, true);
  assert.equal(pairedMismatch.tier1DeltaMB, 40);
  assert.equal(pairedMismatch.tier2DeltaMB, 60);
  assert.deepEqual(pairedMismatch.budgetMarginsMB, [6, 36, -137]);
  assert.deepEqual(pairedMismatch.linearMarginsMB, [0, 0, -280]);
  assert.equal(pairedMismatch.budgetMarginMedianMB, 6);
  assert.equal(pairedMismatch.linearMarginMedianMB, 0);
  assert.equal(pairedMismatch.sublinearWithinBudget, false);
  assert.equal(spike.tier2DeltaMB, 22);
  assert.equal(spike.sublinearWithinBudget, true);
  assert.equal(spike.tier2WithinCeiling, false);
  assert.equal(measurableSpike.sublinearWithinBudget, true);
  assert.equal(measurableSpike.tier2WithinCeiling, false);
  assert.equal(tier1Spike.sublinearWithinBudget, true);
  assert.equal(tier1Spike.tier1WithinCeiling, false);
  assert.equal(latestWindowsRunner.tier1DeltaMB, 49);
  assert.equal(latestWindowsRunner.tier2DeltaMB, 96);
  assert.deepEqual(latestWindowsRunner.budgetMarginsMB, [-3, -1.5, -1.5]);
  assert.deepEqual(latestWindowsRunner.linearMarginsMB, [-51, -51, -51]);
  assert.equal(latestWindowsRunner.budgetMarginMedianMB, -1.5);
  assert.equal(latestWindowsRunner.linearMarginMedianMB, -51);
  assert.equal(latestWindowsRunner.sublinearWithinBudget, true);
  assert.equal(rankInversionJitter.tier1DeltaMB, 48);
  assert.equal(rankInversionJitter.tier2DeltaMB, 97);
  assert.equal(rankInversionJitter.effectiveBudgetMB, 96);
  assert.equal(rankInversionJitter.independentBudgetMarginMB, 1);
  assert.equal(rankInversionJitter.independentBudgetRoundingToleranceMB, 1.25);
  assert.deepEqual(rankInversionJitter.budgetMarginsMB, [0, -0.5, 1]);
  assert.deepEqual(rankInversionJitter.linearMarginsMB, [-48, -50, -47]);
  assert.equal(rankInversionJitter.budgetMarginMedianMB, 0);
  assert.equal(rankInversionJitter.linearMarginMedianMB, -48);
  assert.equal(rankInversionJitter.sublinearWithinBudget, true);
  assert.equal(stableRankInversionOverflow.independentBudgetMarginMB, 1);
  assert.equal(stableRankInversionOverflow.independentBudgetRoundingToleranceMB, 1.25);
  assert.equal(stableRankInversionOverflow.budgetMarginMedianMB, 1);
  assert.equal(stableRankInversionOverflow.linearMarginMedianMB, -47);
  assert.equal(stableRankInversionOverflow.sublinearWithinBudget, false);
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
    { initial: [50, 91], extra: [51, 92, 49, 90] },
    { initial: [50, 107], extra: [51, 108, 49, 106] }
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
  assert.match(logs[0], /tier2=94MB，relative预算=97\.5MB，absolute预算=106MB，effective预算=97\.5MB/);
  const stableWindowsAssessment = assessScanMemorySamples(
    stableWindowsSamples.tier1Samples,
    stableWindowsSamples.tier2Samples,
    3
  );
  assert.equal(stableWindowsAssessment.budgetMarginMedianMB, -3.5);
  assert.equal(stableWindowsAssessment.linearMarginMedianMB, -53);
  assert.equal(stableWindowsAssessment.sublinearWithinBudget, true);

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

test('RSS 可测档取 relative/absolute 双预算较小值并拒绝精确线性增长', () => {
  const thresholdLinear = assessScanMemoryGrowth(9, 27, 3);
  const thresholdSublinear = assessScanMemoryGrowth(9, 26, 3);
  const lowMagnitudeLinear = assessScanMemoryGrowth(13, 39, 3);
  const mediumBoundary = assessScanMemoryGrowth(32, 72, 3);
  const mediumOverflow = assessScanMemoryGrowth(32, 73, 3);
  const highMagnitudeLinear = assessScanMemoryGrowth(32, 96, 3);
  const windowsBoundary = assessScanMemoryGrowth(49, 97, 3);
  const windowsOverflow = assessScanMemoryGrowth(49, 98, 3);
  const windowsMagnitudeLinear = assessScanMemoryGrowth(49, 147, 3);

  assert.equal(thresholdLinear.classification, 'measurable-growth');
  assert.equal(thresholdLinear.relativeBudgetMB, 37.5);
  assert.equal(thresholdLinear.absoluteGrowthBudgetMB, 66);
  assert.equal(thresholdLinear.effectiveBudgetMB, 37.5);
  assert.equal(thresholdLinear.strictlyBelowLinear, false);
  assert.equal(thresholdLinear.sublinearWithinBudget, false);
  assert.equal(thresholdSublinear.strictlyBelowLinear, true);
  assert.equal(thresholdSublinear.sublinearWithinBudget, true);
  assert.equal(lowMagnitudeLinear.classification, 'measurable-growth');
  assert.equal(lowMagnitudeLinear.effectiveBudgetMB, 43.5);
  assert.equal(lowMagnitudeLinear.strictlyBelowLinear, false);
  assert.equal(lowMagnitudeLinear.sublinearWithinBudget, false);
  assert.equal(mediumBoundary.relativeBudgetMB, 72);
  assert.equal(mediumBoundary.absoluteGrowthBudgetMB, 89);
  assert.equal(mediumBoundary.effectiveBudgetMB, 72);
  assert.equal(mediumBoundary.sublinearWithinBudget, true);
  assert.equal(mediumOverflow.sublinearWithinBudget, false);
  assert.equal(highMagnitudeLinear.classification, 'measurable-growth');
  assert.equal(highMagnitudeLinear.sublinearWithinBudget, false);
  assert.equal(windowsBoundary.relativeBudgetMB, 97.5);
  assert.equal(windowsBoundary.absoluteGrowthBudgetMB, 106);
  assert.equal(windowsBoundary.effectiveBudgetMB, 97.5);
  assert.equal(windowsBoundary.sublinearWithinBudget, true);
  assert.equal(windowsOverflow.sublinearWithinBudget, false);
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
  assert.equal(observedBoundary.relativeBudgetMB, 147);
  assert.equal(observedBoundary.absoluteGrowthBudgetMB, 139);
  assert.equal(observedBoundary.effectiveBudgetMB, 139);
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
