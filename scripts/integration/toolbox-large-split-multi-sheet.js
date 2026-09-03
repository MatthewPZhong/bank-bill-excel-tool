// 工具箱「按字段值拆分」大文件多 sheet 隔离 worker 通道 —— 端到端集成测试（v3.0.9 需求 1 / T7）
//
// 这是【唯一】跨 main ↔ dispatch ↔ worker ↔ backend 接缝的真端到端测试。
//
// 为什么必须有这条（feedback_multiagent_seam_gap）：
//   v3.0.9 大文件拆分通道跨 6 个新模块 + main.js，跨「主进程 ↔ worker_threads」进程边界协作：
//     main.js 路由 → toolbox-large-split-dispatch（new Worker）→ large-split-worker（薄壳）
//       → split-scan-fields / split-export-filter（T3 纯逻辑）
//         → multi-sheet-reader（T1，yauzl 流式多 sheet）+ bounded-values-accumulator（T2，封顶 N）
//         → writeRowsStreamed（写路径，超 104 万行自动分 sheet）。
//   逐文件 review / 小数据单测看不见「真多 sheet 大文件跨进程接缝」的内存恒定 + 值正确 + 命中数正确 +
//   dispatch→worker→backend 链是否真通。本脚本用【运行时程序生成的多 sheet 大 xlsx】端到端验证。
//
// 覆盖（两部分）：
//   A. 直驱 backend 模块（不经 worker，以便在本进程内采样内存）：大规模 + 内存恒定。
//      - 程序生成跨 ≥3 个物理 sheet 的 .xlsx（writeRowsStreamed 流式写，含低基数列 channel + 高基数列 seq
//        + 已知命中行数）；scanFields 断言低基数列去重集合精确、高基数列封顶 N=1000；exportFilter 断言
//        matchedCount = 注入命中数，产物用 multi-sheet-reader readback（避免 SheetJS 全量读大输出再 OOM）；
//        分两档规模采样 scanFields 期间 RSS 增量，断言「内存增量有界、不随行数线性增长」。
//      - 规模：分两档 50 万 / 150 万行跨 3 物理 sheet（在 stdout 注明）。700 万级由 PRD §7 P0 手测覆盖。
//   B. 真 worker 拓扑（dispatch↔worker 接缝，小规模即可）：
//      - 真 dispatchLargeSplit（内部 new Worker）跑 scanFields → 断言 done→resolve 的 {headers,valuesByField}
//        正确；再跑 exportFilter → 断言 {matchedCount} 正确、产物可 readback。证明 main.js 走的那条
//        dispatch→worker→backend 链真通（T6 接的就是这个）。
//
// 🔴 约束（rules/integration-test-policy.md）：
//   - stdout 末尾 `N/N PASS`；全过 exit 0，任一失败 exit 1 + 打印 FAILURES。
//   - 所有 tmp 文件 mkdtemp 建、跑完 rmSync 删（不留大文件、不进 git）。
//   - 不 require electron（纯 node 跑）；worker 部分用真 dispatch（它内部 new Worker）。
//
// 用法：node scripts/integration/toolbox-large-split-multi-sheet.js
//      可调规模（默认 50 万 / 150 万）：
//        TBX_T7_TIER1_ROWS=500000 TBX_T7_TIER2_ROWS=1500000 node scripts/integration/toolbox-large-split-multi-sheet.js

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// ── 被测模块（全部纯 node，绝不 require electron）─────────────────────────────────────────────
// 写路径（生成多 sheet 大夹具 + 写命中行；超 104 万行自动分物理 sheet）。
const { writeRowsStreamed } = require('../../src/main-process/toolbox-stream-io');
// T3 纯逻辑（直驱 backend：在本进程采样内存）。
const { scanFields } = require('../../src/backend/toolbox-xlsx-stream/split-scan-fields');
const { exportFilter } = require('../../src/backend/toolbox-xlsx-stream/split-export-filter');
// T1 多 sheet 流式读（用作 readback：避免 SheetJS 全量读大输出再 OOM）。
const { streamLogicalTableRows } = require('../../src/backend/toolbox-xlsx-stream/multi-sheet-reader');
// 路由 + 中央目录探针（验证生成的多 sheet 夹具确实被判为大通道 + 数物理 sheet 数）。
const { shouldUseLargeChannel } = require('../../src/main-process/toolbox-large-split-router');
const { collectEntrySizes } = require('../../src/backend/pending-import/xlsx-size-preflight');
// T4 真 dispatch（B 部分：内部 new Worker，跑真 worker 拓扑）。
const { dispatchLargeSplit } = require('../../src/main-process/toolbox-large-split-dispatch');

// ── 默认规模（CI 可接受：两档总耗时目标低几十秒）──────────────────────────────────────────────
//   50 万 / 150 万行跨 3 物理 sheet。700 万级由 PRD §7 P0 手测覆盖（此处只需「足够大到证明流式 + 触发
//   输出分 sheet + 能采样内存恒定」，不真跑 700 万分钟级）。
const TIER1_ROWS = Number(process.env.TBX_T7_TIER1_ROWS || 500000);
const TIER2_ROWS = Number(process.env.TBX_T7_TIER2_ROWS || 1500000);

// 列结构：刻意全用「非 by-name 特殊字段」列名（避开 toolbox-stream-io 的 NUMERIC/DATE/TEXT 格式化分组），
//   使 writeRowsStreamed 原样写值、normalizeCell readback 与写入值逐字节一致，便于精确断言去重集合 / 命中内容。
//   rowKey  普通列（行序标识，用于 readback 内容校验）
//   channel 低基数列（取值 ∈ 固定小集合，作拆分字段）
//   seq     高基数列（每行唯一，验证有界累加器封顶 N=1000 不爆）
//   note    填充列
const HEADERS = ['rowKey', 'channel', 'seq', 'note'];
const CHANNELS = ['ALIPAY', 'WECHAT', 'UNION', 'PAYPAL', 'STRIPE']; // 5 个低基数取值（去重集合已知）
const SPLIT_FIELD = 'channel';
const SPLIT_VALUE = 'ALIPAY'; // 拆分目标值（命中行数 = 注入数，预先算好）

const WORKSHEET_RE = /^xl\/worksheets\/sheet\d+\.xml$/;

// ── 断言 harness（rules/integration-test-policy.md 模板）──────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];
function assertTrue(cond, label) {
  if (cond) { passed += 1; return; }
  failed += 1;
  failures.push({ label });
}
function assertEq(actual, expected, label) {
  if (actual === expected) { passed += 1; return; }
  failed += 1;
  failures.push({ label, actual, expected });
}

function rssBytes() {
  return process.memoryUsage().rss;
}
function mb(bytes) {
  return Math.round(bytes / 1024 / 1024);
}

// RSS 是 OS 级驻留集快照，受 GC、allocator 分页提交/回收与 MB 取整影响。增长判据分两类：
//   - tier1 <= 8MB：基线落在测量噪声量级；tier2 必须同时留在固定 32MB 低信号包络内，
//     且严格低于按行数比得到的线性外推。单次低信号不能直接证明亚线性。
//   - tier1 > 8MB：已有可测信号，同时计算相对预算（半线性外推 + 24MB）和绝对增长预算
//     （tier1 + 57MB），取两者较小值；tier2 还必须严格低于按行数比得到的线性外推。
//     24MB 是既有 8MB 噪声单位的 3 倍，覆盖两台 Windows runner 四组成对样本所需的
//     20.5/21/22.5/22.5MB 相对噪声；57MB 锁定既有 82→139MB PASS / 82→140MB FAIL 边界。
// 采样策略与增长分类独立：首次 tier1 <= 16MB 时均位于 RSS 重采保护区，保留三组成对样本；
// 此外，首对样本属于 measurable-growth 且 tier2 距亚线性预算边界两侧不超过 8MB 时，
// 扩展到五组成对样本，降低单个 Windows runner 量化/allocator 抖动对边界裁决的影响。
// 多样本保留 tier1 / tier2 独立中位样本裁决，但独立中位会丢失成对关系；其预算 margin 只允许
// 落在 Math.round(MB) 的理论传播误差内。每一对的预算 margin / 线性 margin 仍严格取中位数作为
// 必要条件，因此稳定预算越界不能借独立中位取整容差翻为 PASS。
// 任何原始样本仍须逐个通过 150MB 绝对上限。
// 禁止同时抬高 tier1、压低 tier2；那会把 rowsRatio=3 的 13→39MB 精确线性增长误判为通过。
// 两档仍在独立 --expose-gc 子进程采样，绝对 150MB 上限保持独立门禁。
const SCAN_DELTA_CEILING_MB = 150;
const RSS_MEASUREMENT_NOISE_MB = 8;
const RSS_MB_ROUNDING_ERROR_MB = 0.5;
const LOW_SIGNAL_TIER1_MAX_MB = RSS_MEASUREMENT_NOISE_MB;
const LOW_SIGNAL_TIER2_CEILING_MB = RSS_MEASUREMENT_NOISE_MB * 4;
const MEASURABLE_GROWTH_RELATIVE_NOISE_MB = RSS_MEASUREMENT_NOISE_MB * 3;
const MEASURABLE_GROWTH_ABSOLUTE_BUDGET_DELTA_MB = 57;
const RSS_RESAMPLE_PROTECTION_MAX_MB = RSS_MEASUREMENT_NOISE_MB * 2;
const RSS_BUDGET_BOUNDARY_RESAMPLE_MB = RSS_MEASUREMENT_NOISE_MB;
const RSS_LOW_SIGNAL_SAMPLE_COUNT = 3;
const RSS_BUDGET_BOUNDARY_SAMPLE_COUNT = 5;
const SUBLINEAR_FRACTION_OF_LINEAR = 0.5;
const SCAN_MEMORY_PROBE_MODE = '--scan-memory-probe';
const SCAN_MEMORY_RESULT_PREFIX = '__TBX_SCAN_MEMORY__';

function assessScanMemoryGrowth(tier1DeltaMB, tier2DeltaMB, rowsRatio) {
  const valid = Number.isFinite(tier1DeltaMB)
    && Number.isFinite(tier2DeltaMB)
    && Number.isFinite(rowsRatio)
    && tier1DeltaMB >= 0
    && tier2DeltaMB >= 0
    && rowsRatio > 1;
  if (!valid) {
    return {
      valid: false,
      tier1WithinCeiling: false,
      tier2WithinCeiling: false,
      sublinearWithinBudget: false,
      classification: 'invalid'
    };
  }

  const lowSignal = tier1DeltaMB <= LOW_SIGNAL_TIER1_MAX_MB;
  const linearProjectedMB = tier1DeltaMB * rowsRatio;
  const relativeBudgetMB = lowSignal
    ? LOW_SIGNAL_TIER2_CEILING_MB
    : tier1DeltaMB * rowsRatio * SUBLINEAR_FRACTION_OF_LINEAR
      + MEASURABLE_GROWTH_RELATIVE_NOISE_MB;
  const absoluteGrowthBudgetMB = lowSignal
    ? LOW_SIGNAL_TIER2_CEILING_MB
    : tier1DeltaMB + MEASURABLE_GROWTH_ABSOLUTE_BUDGET_DELTA_MB;
  const effectiveBudgetMB = Math.min(relativeBudgetMB, absoluteGrowthBudgetMB);
  const strictlyBelowLinear = tier2DeltaMB < linearProjectedMB;
  return {
    valid: true,
    tier1WithinCeiling: tier1DeltaMB < SCAN_DELTA_CEILING_MB,
    tier2WithinCeiling: tier2DeltaMB < SCAN_DELTA_CEILING_MB,
    sublinearWithinBudget: tier2DeltaMB <= effectiveBudgetMB && strictlyBelowLinear,
    classification: lowSignal ? 'bounded-low-signal' : 'measurable-growth',
    relativeBudgetMB,
    absoluteGrowthBudgetMB,
    effectiveBudgetMB,
    // 兼容既有调用方；新日志与测试显式使用 effectiveBudgetMB。
    sublinearLimitMB: effectiveBudgetMB,
    linearProjectedMB,
    strictlyBelowLinear
  };
}

function getIndependentMedianBudgetRoundingToleranceMB(assessment, rowsRatio) {
  if (!assessment.valid) return 0;
  if (assessment.classification === 'bounded-low-signal') {
    return RSS_MB_ROUNDING_ERROR_MB;
  }
  const relativeToleranceMB = RSS_MB_ROUNDING_ERROR_MB
    * (1 + rowsRatio * SUBLINEAR_FRACTION_OF_LINEAR);
  const absoluteToleranceMB = RSS_MB_ROUNDING_ERROR_MB * 2;
  if (assessment.relativeBudgetMB < assessment.absoluteGrowthBudgetMB) {
    return relativeToleranceMB;
  }
  if (assessment.absoluteGrowthBudgetMB < assessment.relativeBudgetMB) {
    return absoluteToleranceMB;
  }
  return Math.max(relativeToleranceMB, absoluteToleranceMB);
}

function assessScanMemorySamples(tier1Samples, tier2Samples, rowsRatio) {
  const validSamples = Array.isArray(tier1Samples)
    && Array.isArray(tier2Samples)
    && tier1Samples.length > 0
    && tier1Samples.length === tier2Samples.length
    && tier1Samples.length % 2 === 1
    && tier1Samples.every((value) => Number.isFinite(value) && value >= 0)
    && tier2Samples.every((value) => Number.isFinite(value) && value >= 0);
  if (!validSamples) {
    return {
      ...assessScanMemoryGrowth(Number.NaN, Number.NaN, rowsRatio),
      sampleCount: 0,
      tier1Samples: [],
      tier2Samples: [],
      tier1DeltaMB: null,
      tier2DeltaMB: null,
      pairedSamples: [],
      budgetMarginsMB: [],
      linearMarginsMB: [],
      budgetMarginMedianMB: null,
      linearMarginMedianMB: null,
      independentBudgetMarginMB: null,
      independentBudgetRoundingToleranceMB: null
    };
  }

  const median = (values) => {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const pairedSamples = tier1Samples.map((tier1DeltaMB, index) => {
    const tier2DeltaMB = tier2Samples[index];
    const assessment = assessScanMemoryGrowth(tier1DeltaMB, tier2DeltaMB, rowsRatio);
    return {
      tier1DeltaMB,
      tier2DeltaMB,
      classification: assessment.classification,
      relativeBudgetMB: assessment.relativeBudgetMB,
      absoluteGrowthBudgetMB: assessment.absoluteGrowthBudgetMB,
      effectiveBudgetMB: assessment.effectiveBudgetMB,
      sublinearLimitMB: assessment.sublinearLimitMB,
      linearProjectedMB: assessment.linearProjectedMB,
      budgetMarginMB: tier2DeltaMB - assessment.effectiveBudgetMB,
      linearMarginMB: tier2DeltaMB - assessment.linearProjectedMB
    };
  });
  if (pairedSamples.some((sample) => !Number.isFinite(sample.budgetMarginMB)
      || !Number.isFinite(sample.linearMarginMB))) {
    return {
      ...assessScanMemoryGrowth(Number.NaN, Number.NaN, rowsRatio),
      sampleCount: 0,
      tier1Samples: [],
      tier2Samples: [],
      tier1DeltaMB: null,
      tier2DeltaMB: null,
      pairedSamples: [],
      budgetMarginsMB: [],
      linearMarginsMB: [],
      budgetMarginMedianMB: null,
      linearMarginMedianMB: null,
      independentBudgetMarginMB: null,
      independentBudgetRoundingToleranceMB: null
    };
  }
  const tier1DeltaMB = median(tier1Samples);
  const tier2DeltaMB = median(tier2Samples);
  const assessment = assessScanMemoryGrowth(tier1DeltaMB, tier2DeltaMB, rowsRatio);
  const budgetMarginsMB = pairedSamples.map((sample) => sample.budgetMarginMB);
  const linearMarginsMB = pairedSamples.map((sample) => sample.linearMarginMB);
  const budgetMarginMedianMB = median(budgetMarginsMB);
  const linearMarginMedianMB = median(linearMarginsMB);
  const independentBudgetMarginMB = tier2DeltaMB - assessment.effectiveBudgetMB;
  const independentBudgetRoundingToleranceMB = getIndependentMedianBudgetRoundingToleranceMB(
    assessment,
    rowsRatio
  );
  return {
    ...assessment,
    // 独立中位样本只吸收 Math.round(MB) 的理论传播误差；paired margin 仍严格执行原预算，
    // 避免稳定越界或错配样本借取整容差造成假 PASS。
    // 绝对硬上限检查每一个原始样本，不能被中位数隐藏。
    sublinearWithinBudget: assessment.valid
      && assessment.strictlyBelowLinear
      && independentBudgetMarginMB <= independentBudgetRoundingToleranceMB
      && budgetMarginMedianMB <= 0
      && linearMarginMedianMB < 0,
    strictlyBelowLinear: assessment.valid
      && assessment.strictlyBelowLinear
      && linearMarginMedianMB < 0,
    tier1WithinCeiling: assessment.valid
      && tier1Samples.every((value) => value < SCAN_DELTA_CEILING_MB),
    tier2WithinCeiling: assessment.valid
      && tier2Samples.every((value) => value < SCAN_DELTA_CEILING_MB),
    sampleCount: tier1Samples.length,
    tier1Samples: tier1Samples.slice(),
    tier2Samples: tier2Samples.slice(),
    tier1DeltaMB,
    tier2DeltaMB,
    pairedSamples,
    budgetMarginsMB,
    linearMarginsMB,
    budgetMarginMedianMB,
    linearMarginMedianMB,
    independentBudgetMarginMB,
    independentBudgetRoundingToleranceMB
  };
}

function verifyMemoryGuardModel() {
  const lowSignalSublinear = assessScanMemoryGrowth(8, 23, 3);
  const lowSignalLinear = assessScanMemoryGrowth(8, 24, 3);
  const lowSignalSuperlinear = assessScanMemoryGrowth(6, 29, 3);
  const lowSignalEnvelopeBoundary = assessScanMemoryGrowth(8, 32, 3);
  const thresholdLinear = assessScanMemoryGrowth(9, 27, 3);
  const thresholdSublinear = assessScanMemoryGrowth(9, 26, 3);
  const lowMagnitudeLinear = assessScanMemoryGrowth(13, 39, 3);
  const mediumBoundary = assessScanMemoryGrowth(32, 72, 3);
  const mediumOverflow = assessScanMemoryGrowth(32, 73, 3);
  const highMagnitudeLinear = assessScanMemoryGrowth(32, 96, 3);
  const windowsBoundary = assessScanMemoryGrowth(49, 97, 3);
  const windowsOverflow = assessScanMemoryGrowth(49, 98, 3);
  const windowsLinear = assessScanMemoryGrowth(49, 147, 3);
  const lowSignalOverflow = assessScanMemoryGrowth(6, 33, 3);
  const measurableSublinear = assessScanMemoryGrowth(20, 30, 3);
  const measurableNoiseBoundary = assessScanMemoryGrowth(82, 139, 3);
  const measurableNoiseOverflow = assessScanMemoryGrowth(82, 140, 3);
  const absoluteCeilingOnly = assessScanMemoryGrowth(100, 150, 3);
  const invalidRatio = assessScanMemoryGrowth(6, 29, 1);
  const nonFiniteDelta = assessScanMemoryGrowth(6, Number.POSITIVE_INFINITY, 3);
  const medianLowSignal = assessScanMemorySamples([7, 8, 8], [17, 23, 22], 3);
  const hiddenHardLimitSpike = assessScanMemorySamples([7, 8, 8], [17, 151, 22], 3);
  const hiddenTier1HardLimitSpike = assessScanMemorySamples([49, 150, 49], [94, 94, 93], 3);
  const stableWindowsSamples = assessScanMemorySamples([49, 49, 49], [94, 94, 94], 3);
  const latestWindowsRunnerSamples = assessScanMemorySamples([48, 49, 49], [93, 96, 96], 3);
  const rankInversionJitter = assessScanMemorySamples([48, 49, 48], [96, 97, 97], 3);
  const stableRankInversionOverflow = assessScanMemorySamples([48, 48, 48], [97, 97, 97], 3);
  const pairedMismatchRegression = assessScanMemorySamples([20, 40, 100], [60, 120, 20], 3);
  const invalidSamples = assessScanMemorySamples([7, 8], [17, 22], 3);
  const valid = lowSignalSublinear.valid
    && lowSignalSublinear.classification === 'bounded-low-signal'
    && lowSignalSublinear.strictlyBelowLinear
    && lowSignalSublinear.sublinearWithinBudget
    && !lowSignalLinear.strictlyBelowLinear
    && !lowSignalLinear.sublinearWithinBudget
    && !lowSignalSuperlinear.strictlyBelowLinear
    && !lowSignalSuperlinear.sublinearWithinBudget
    && !lowSignalEnvelopeBoundary.strictlyBelowLinear
    && !lowSignalEnvelopeBoundary.sublinearWithinBudget
    && thresholdLinear.valid
    && !thresholdLinear.strictlyBelowLinear
    && !thresholdLinear.sublinearWithinBudget
    && thresholdSublinear.valid
    && thresholdSublinear.strictlyBelowLinear
    && thresholdSublinear.sublinearWithinBudget
    && lowMagnitudeLinear.classification === 'measurable-growth'
    && !lowMagnitudeLinear.strictlyBelowLinear
    && !lowMagnitudeLinear.sublinearWithinBudget
    && mediumBoundary.effectiveBudgetMB === 72
    && mediumBoundary.sublinearWithinBudget
    && mediumOverflow.effectiveBudgetMB === 72
    && !mediumOverflow.sublinearWithinBudget
    && highMagnitudeLinear.valid
    && !highMagnitudeLinear.sublinearWithinBudget
    && windowsBoundary.relativeBudgetMB === 97.5
    && windowsBoundary.absoluteGrowthBudgetMB === 106
    && windowsBoundary.effectiveBudgetMB === 97.5
    && windowsBoundary.sublinearWithinBudget
    && !windowsOverflow.sublinearWithinBudget
    && !windowsLinear.sublinearWithinBudget
    && lowSignalOverflow.valid
    && !lowSignalOverflow.sublinearWithinBudget
    && measurableSublinear.valid
    && measurableSublinear.sublinearWithinBudget
    && measurableNoiseBoundary.valid
    && measurableNoiseBoundary.sublinearWithinBudget
    && measurableNoiseOverflow.valid
    && !measurableNoiseOverflow.sublinearWithinBudget
    && absoluteCeilingOnly.sublinearWithinBudget
    && !absoluteCeilingOnly.tier2WithinCeiling
    && !invalidRatio.valid
    && !invalidRatio.sublinearWithinBudget
    && !nonFiniteDelta.valid
    && !nonFiniteDelta.sublinearWithinBudget
    && medianLowSignal.valid
    && medianLowSignal.sampleCount === RSS_LOW_SIGNAL_SAMPLE_COUNT
    && medianLowSignal.tier1DeltaMB === 8
    && medianLowSignal.tier2DeltaMB === 22
    && medianLowSignal.sublinearWithinBudget
    && hiddenHardLimitSpike.sublinearWithinBudget
    && !hiddenHardLimitSpike.tier2WithinCeiling
    && hiddenTier1HardLimitSpike.sublinearWithinBudget
    && !hiddenTier1HardLimitSpike.tier1WithinCeiling
    && stableWindowsSamples.budgetMarginMedianMB === -3.5
    && stableWindowsSamples.linearMarginMedianMB === -53
    && stableWindowsSamples.sublinearWithinBudget
    && latestWindowsRunnerSamples.tier1DeltaMB === 49
    && latestWindowsRunnerSamples.tier2DeltaMB === 96
    && latestWindowsRunnerSamples.budgetMarginMedianMB === -1.5
    && latestWindowsRunnerSamples.linearMarginMedianMB === -51
    && latestWindowsRunnerSamples.sublinearWithinBudget
    && rankInversionJitter.independentBudgetMarginMB === 1
    && rankInversionJitter.independentBudgetRoundingToleranceMB === 1.25
    && rankInversionJitter.budgetMarginMedianMB === 0
    && rankInversionJitter.linearMarginMedianMB === -48
    && rankInversionJitter.sublinearWithinBudget
    && stableRankInversionOverflow.independentBudgetMarginMB === 1
    && stableRankInversionOverflow.budgetMarginMedianMB === 1
    && !stableRankInversionOverflow.sublinearWithinBudget
    && pairedMismatchRegression.tier1DeltaMB === 40
    && pairedMismatchRegression.tier2DeltaMB === 60
    && assessScanMemoryGrowth(40, 60, 3).sublinearWithinBudget
    && pairedMismatchRegression.budgetMarginMedianMB === 6
    && pairedMismatchRegression.linearMarginMedianMB === 0
    && !pairedMismatchRegression.sublinearWithinBudget
    && !invalidSamples.valid
    && !invalidSamples.sublinearWithinBudget;
  if (!valid) {
    throw new Error('内存门禁判据自校验失败：低信号、双预算边界、线性反例、绝对上限或非法输入未按预期裁决');
  }
}

// 生成跨多物理 sheet 的大 .xlsx（writeRowsStreamed 流式写，内存恒定）。
//   maxRowsPerSheet 给「小于单 sheet 行数」的值 → 自动开物理 sub-sheet (2)(3)... → 产出 ≥3 个
//   xl/worksheets/sheetN.xml（真多物理 sheet，触发多 sheet 续页 + 大通道路由）。
//   返回 { hitCount }（channel===SPLIT_VALUE 的行数 = 已知命中数；预先精确计数）。
async function genMultiSheetXlsx(filePath, rowCount, perSheet) {
  let hitCount = 0;
  await writeRowsStreamed({
    savePath: filePath,
    normalizedHeaders: HEADERS,
    sheetBaseName: 'COMMON',
    maxRowsPerSheet: perSheet, // 强制分物理 sheet（生成端用，非生产路径；生产 exportFilter 不传用默认 104 万）
    writeDataRows: async (emit) => {
      for (let i = 0; i < rowCount; i += 1) {
        const channel = CHANNELS[i % CHANNELS.length];
        if (channel === SPLIT_VALUE) hitCount += 1;
        // seq 每行唯一（高基数）；rowKey 行序标识；note 填充。
        emit([`R${i}`, channel, `S${i}`, 'fill']);
      }
    }
  });
  return { hitCount };
}

// 数物理 worksheet 数（中央目录，不解压、不读文件体）。
async function countWorksheets(filePath) {
  const sizes = await collectEntrySizes(filePath);
  return [...sizes.entries()].filter(([n]) => WORKSHEET_RE.test(n)).length;
}

// 用 T1 multi-sheet-reader 做 readback（流式、内存恒定；不 SheetJS 全量读大输出）。
//   返回 { headers, dataRowCount, allMatchSplitValue, channelColSeen }
//     headers            readback 到的表头（应与 HEADERS 一致）
//     dataRowCount       数据行数（多 sheet 续页：输出分 sheet 的重复表头被 reader 跳过，故 = 命中数）
//     allMatchSplitValue 所有数据行的 channel 列是否都 = SPLIT_VALUE（命中内容正确）
//     channelColSeen     readback 行里出现过的 channel 去重值集合（应只含 SPLIT_VALUE）
async function readbackHits(filePath) {
  let headers = null;
  let dataRowCount = 0;
  let allMatchSplitValue = true;
  const channelColSeen = new Set();
  const channelIdx = HEADERS.indexOf(SPLIT_FIELD);
  await streamLogicalTableRows(filePath, {
    onHeaderRow: (h) => { headers = h; },
    onDataRow: (vals) => {
      dataRowCount += 1;
      const v = vals[channelIdx] == null ? '' : String(vals[channelIdx]).trim();
      channelColSeen.add(v);
      if (v !== SPLIT_VALUE) allMatchSplitValue = false;
    }
  });
  return { headers, dataRowCount, allMatchSplitValue, channelColSeen };
}

// 采样 scanFields 执行期间的 RSS 增量（隔离「扫描核心」的增量内存——与生成端 ExcelJS 的进程基线无关）。
//   返回 { beforeMB, peakMB, deltaMB, scanMs, valuesByField }
//   deltaMB = 扫描期峰值 RSS − 扫描前 RSS：这才是「流式扫描核心」自身的增量内存（应有界、不随行数线性涨）。
async function scanWithMemorySampling(filePath) {
  if (global.gc) { try { global.gc(); } catch (_e) { /* swallow */ } }
  await new Promise((r) => setTimeout(r, 80)); // 让基线稳定
  const before = rssBytes();
  let peak = before;
  const sampler = setInterval(() => {
    const m = rssBytes();
    if (m > peak) peak = m;
  }, 25);
  if (sampler && typeof sampler.unref === 'function') sampler.unref();
  const t0 = Date.now();
  let scan;
  try {
    scan = await scanFields(filePath, null);
  } finally {
    peak = Math.max(peak, rssBytes());
    clearInterval(sampler);
  }
  return {
    beforeMB: mb(before),
    peakMB: mb(peak),
    deltaMB: mb(peak - before),
    scanMs: Date.now() - t0,
    valuesByField: scan.valuesByField,
    headers: scan.headers
  };
}

function scanInIsolatedProcess(filePath) {
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', __filename, SCAN_MEMORY_PROBE_MODE, filePath],
    { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error(
      `独立 RSS 采样子进程失败（exit=${result.status}）\n${result.stderr || result.stdout || ''}`
    );
  }
  const payloadLine = String(result.stdout || '')
    .split(/\r?\n/)
    .find((line) => line.startsWith(SCAN_MEMORY_RESULT_PREFIX));
  if (!payloadLine) {
    throw new Error('独立 RSS 采样子进程未返回结构化结果');
  }
  return JSON.parse(payloadLine.slice(SCAN_MEMORY_RESULT_PREFIX.length));
}

function formatMemoryMB(value) {
  if (!Number.isFinite(value)) return String(value);
  return Object.is(value, -0) ? '0' : String(value);
}

function formatSignedMemoryMB(value) {
  if (!Number.isFinite(value)) return String(value);
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${formatMemoryMB(value)}`;
}

function collectMemorySamples(
  fileT1,
  fileT2,
  scan1,
  scan2,
  rowsRatio,
  runIsolatedScan = scanInIsolatedProcess,
  log = console.log
) {
  const tier1Samples = [scan1.deltaMB];
  const tier2Samples = [scan2.deltaMB];
  const inTier1Protection = Number.isFinite(scan1.deltaMB)
      && scan1.deltaMB >= 0
      && scan1.deltaMB <= RSS_RESAMPLE_PROTECTION_MAX_MB;
  const firstAssessment = assessScanMemoryGrowth(scan1.deltaMB, scan2.deltaMB, rowsRatio);
  const budgetBoundaryDistanceMB = firstAssessment.valid
    && firstAssessment.classification === 'measurable-growth'
    ? Math.abs(scan2.deltaMB - firstAssessment.effectiveBudgetMB)
    : Number.POSITIVE_INFINITY;
  const inBudgetBoundaryProtection = budgetBoundaryDistanceMB <= RSS_BUDGET_BOUNDARY_RESAMPLE_MB;
  if (inTier1Protection || inBudgetBoundaryProtection) {
    const targetSampleCount = inBudgetBoundaryProtection
      ? RSS_BUDGET_BOUNDARY_SAMPLE_COUNT
      : RSS_LOW_SIGNAL_SAMPLE_COUNT;
    const additionalSampleRounds = targetSampleCount - 1;
    if (inTier1Protection) {
      log(`   tier1 首次增量 ${scan1.deltaMB}MB 位于 RSS 重采保护区（≤${RSS_RESAMPLE_PROTECTION_MAX_MB}MB），`
        + `追加${additionalSampleRounds}轮成对隔离采样并取 paired margin 中位数...`);
    } else {
      log(`   首对可测样本距 effective 预算边界 ${formatMemoryMB(budgetBoundaryDistanceMB)}MB`
        + `（tier2=${formatMemoryMB(scan2.deltaMB)}MB，relative预算=${formatMemoryMB(firstAssessment.relativeBudgetMB)}MB，`
        + `absolute预算=${formatMemoryMB(firstAssessment.absoluteGrowthBudgetMB)}MB，effective预算=${formatMemoryMB(firstAssessment.effectiveBudgetMB)}MB，`
        + `保护带±${RSS_BUDGET_BOUNDARY_RESAMPLE_MB}MB），`
        + `追加${additionalSampleRounds}轮成对隔离采样并取 paired margin 中位数...`);
    }
    while (tier1Samples.length < targetSampleCount) {
      tier1Samples.push(runIsolatedScan(fileT1).deltaMB);
      tier2Samples.push(runIsolatedScan(fileT2).deltaMB);
    }
  }
  return { tier1Samples, tier2Samples };
}

async function run() {
  console.log('==== 工具箱大文件按字段拆分 · 多 sheet 隔离 worker 通道 端到端验证 ====');
  console.log(`规模：A 部分两档 ${TIER1_ROWS.toLocaleString()} / ${TIER2_ROWS.toLocaleString()} 行（跨 3 物理 sheet）；`
    + 'B 部分真 worker 小规模。700 万级由 PRD §7 P0 手测覆盖。\n');

  // 判据本身先做确定性自校验，防止为消除 CI 波动而把门禁放宽成恒通过。
  verifyMemoryGuardModel();
  console.log('内存门禁自校验：8→23MB 通过、8→24MB 拒绝；9→26MB 通过、9→27MB 与 13→39MB 严格线性拒绝；32→72MB 通过、32→73/96MB 拒绝；49→97MB 通过、49→98/147MB 拒绝；交错 [48,49,48]→[96,97,97] 通过、稳定 48→97MB 拒绝；82→139MB 通过、82→140MB 拒绝；150MB 任一样本绝对上限独立拒绝。\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-large-split-t7-'));

  try {
    // 每档刻意用 perSheet ≈ rows/3 + 余量，确保跨 3 个物理 sheet（既测多 sheet 续页，又不至 sheet 过多拖慢）。
    const tier1PerSheet = Math.ceil(TIER1_ROWS / 3) + 1;
    const tier2PerSheet = Math.ceil(TIER2_ROWS / 3) + 1;

    // ============================================================
    // A. 直驱 backend：大规模 + 内存恒定（不经 worker，本进程采样内存）
    // ============================================================
    console.log('── A. 直驱 backend 模块（大规模 + 内存恒定）──────────────────────');

    // ─ A 档 1：生成 + 路由 + scanFields（含内存采样）+ exportFilter + readback ─
    const fileT1 = path.join(tmpDir, 'tier1.xlsx');
    console.log(`A1 生成 tier1 多 sheet 夹具（${TIER1_ROWS.toLocaleString()} 行，perSheet=${tier1PerSheet.toLocaleString()}）...`);
    const { hitCount: hit1 } = await genMultiSheetXlsx(fileT1, TIER1_ROWS, tier1PerSheet);
    const ws1 = await countWorksheets(fileT1);
    const size1 = (fs.statSync(fileT1).size / 1024 / 1024).toFixed(1);
    console.log(`   物理 sheet 数=${ws1}，文件大小=${size1}MB，注入命中数（channel=${SPLIT_VALUE}）=${hit1.toLocaleString()}`);

    assertTrue(ws1 >= 3, `A1 夹具跨 ≥3 个物理 sheet（实际 ${ws1}）`);
    assertEq(await shouldUseLargeChannel(fileT1), true, 'A1 多 sheet 夹具被路由判为大通道（shouldUseLargeChannel=true）');

    // scanFields（直驱 + 内存采样）。
    const scan1 = scanInIsolatedProcess(fileT1);
    console.log(`   scanFields：${scan1.scanMs}ms，RSS 扫描前=${scan1.beforeMB}MB 峰值=${scan1.peakMB}MB 增量=${scan1.deltaMB}MB`);
    // 表头正确。
    assertEq(JSON.stringify(scan1.headers), JSON.stringify(HEADERS), 'A1 scanFields 表头 = 注入表头');
    // 低基数列：去重集合 = 注入的固定小集合（精确，未截断）。
    assertEq(
      JSON.stringify((scan1.valuesByField[SPLIT_FIELD] || []).slice().sort()),
      JSON.stringify(CHANNELS.slice().sort()),
      `A1 低基数列「${SPLIT_FIELD}」去重集合 = 注入的 ${CHANNELS.length} 个取值（精确、未截断）`
    );
    // 高基数列：封顶 N=1000（不爆——50 万唯一值不会全部进内存）。
    assertEq((scan1.valuesByField.seq || []).length, 1000, 'A1 高基数列「seq」封顶 N=1000（有界累加器不爆）');

    // exportFilter（直驱）：命中数 = 注入命中数；产物 multi-sheet-reader readback 校验。
    const outT1 = path.join(tmpDir, 'tier1-out.xlsx');
    const exp1 = await exportFilter({ filePath: fileT1, field: SPLIT_FIELD, values: [SPLIT_VALUE], savePath: outT1 });
    console.log(`   exportFilter：matchedCount=${exp1.matchedCount.toLocaleString()}`);
    assertEq(exp1.matchedCount, hit1, `A1 exportFilter matchedCount = 注入命中数（${hit1.toLocaleString()}）`);
    const rb1 = await readbackHits(outT1);
    assertEq(JSON.stringify(rb1.headers), JSON.stringify(HEADERS), 'A1 产物 readback 表头 = 注入表头');
    assertEq(rb1.dataRowCount, hit1, `A1 产物 readback 数据行数 = 命中数（${hit1.toLocaleString()}）`);
    assertTrue(rb1.allMatchSplitValue, `A1 产物所有行 channel 列均 = ${SPLIT_VALUE}（命中内容正确，仅含命中值行）`);
    assertEq(
      JSON.stringify([...rb1.channelColSeen]),
      JSON.stringify([SPLIT_VALUE]),
      `A1 产物 channel 列去重值仅含 {${SPLIT_VALUE}}（未混入其它渠道）`
    );

    // ─ A 档 2：更大规模（150 万行），重点验证内存恒定（扫描增量不随行数线性涨）+ 大输出分 sheet ─
    const fileT2 = path.join(tmpDir, 'tier2.xlsx');
    console.log(`A2 生成 tier2 多 sheet 夹具（${TIER2_ROWS.toLocaleString()} 行，perSheet=${tier2PerSheet.toLocaleString()}）...`);
    const { hitCount: hit2 } = await genMultiSheetXlsx(fileT2, TIER2_ROWS, tier2PerSheet);
    const ws2 = await countWorksheets(fileT2);
    const size2 = (fs.statSync(fileT2).size / 1024 / 1024).toFixed(1);
    console.log(`   物理 sheet 数=${ws2}，文件大小=${size2}MB，注入命中数=${hit2.toLocaleString()}`);
    assertTrue(ws2 >= 3, `A2 夹具跨 ≥3 个物理 sheet（实际 ${ws2}）`);

    const scan2 = scanInIsolatedProcess(fileT2);
    console.log(`   scanFields：${scan2.scanMs}ms，RSS 扫描前=${scan2.beforeMB}MB 峰值=${scan2.peakMB}MB 增量=${scan2.deltaMB}MB`);
    assertEq((scan2.valuesByField.seq || []).length, 1000, 'A2 高基数列「seq」封顶 N=1000（150 万行同样不爆）');
    assertEq(
      JSON.stringify((scan2.valuesByField[SPLIT_FIELD] || []).slice().sort()),
      JSON.stringify(CHANNELS.slice().sort()),
      `A2 低基数列「${SPLIT_FIELD}」去重集合 = 注入的 ${CHANNELS.length} 个取值`
    );

    // ── 内存恒定断言（两档对比 + 绝对上限）──────────────────────────────────────────────
    //   行数从 tier1 涨到 tier2。流式扫描核心的「扫描期 RSS 增量」应保持有界、不随行数线性增长
    //   （高基数列封顶 N=1000 + sharedStrings 全量但与「值基数」而非「行数」相关）。
    const rowsRatio = TIER2_ROWS / TIER1_ROWS;
    const memorySamples = collectMemorySamples(fileT1, fileT2, scan1, scan2, rowsRatio);
    const memoryAssessment = assessScanMemorySamples(
      memorySamples.tier1Samples,
      memorySamples.tier2Samples,
      rowsRatio
    );
    // (1) 绝对上限：任一档扫描期 RSS 增量 < 150MB（流式核心；全量 readRows 此规模会撑到 GB 级）。
    assertTrue(
      memoryAssessment.valid && memoryAssessment.tier1WithinCeiling,
      `A 内存恒定·绝对上限：tier1 所有 RSS 增量 [${memoryAssessment.tier1Samples.join(', ')}]MB < ${SCAN_DELTA_CEILING_MB}MB`
    );
    assertTrue(
      memoryAssessment.valid && memoryAssessment.tier2WithinCeiling,
      `A 内存恒定·绝对上限：tier2 所有 RSS 增量 [${memoryAssessment.tier2Samples.join(', ')}]MB < ${SCAN_DELTA_CEILING_MB}MB`
    );
    // (2) 亚线性：两档由独立子进程成对采样。首次 tier1 在 16MB RSS 重采保护区时保留三组；
    //     首对 measurable-growth 样本距预算边界两侧不超过 8MB 时扩展到五组。每对先算
    //     预算/线性 margin，再取 margin 中位数。增长分类、32MB 低信号包络、预算本身与
    //     16MB tier1 重采保护不变；可测档继续使用 relative/absolute 双预算的较小值。
    console.log(`   内存恒定对比：行数 ×${rowsRatio.toFixed(1)}；RSS 中位增量 tier1=${memoryAssessment.tier1DeltaMB}MB → tier2=${memoryAssessment.tier2DeltaMB}MB`
      + `（样本数=${memoryAssessment.sampleCount}，tier1=[${memoryAssessment.tier1Samples.join(', ')}]MB，tier2=[${memoryAssessment.tier2Samples.join(', ')}]MB）`
      + `（${memoryAssessment.classification}，relative预算=${formatMemoryMB(memoryAssessment.relativeBudgetMB)}MB，`
      + `absolute预算=${formatMemoryMB(memoryAssessment.absoluteGrowthBudgetMB)}MB，effective预算=${formatMemoryMB(memoryAssessment.effectiveBudgetMB)}MB，`
      + `独立中位预算 margin=${formatSignedMemoryMB(memoryAssessment.independentBudgetMarginMB)}MB`
      + `/取整容差≤${formatMemoryMB(memoryAssessment.independentBudgetRoundingToleranceMB)}MB，`
      + `paired effective预算 margin 中位数=${formatSignedMemoryMB(memoryAssessment.budgetMarginMedianMB)}MB，`
      + `paired 线性 margin 中位数=${formatSignedMemoryMB(memoryAssessment.linearMarginMedianMB)}MB）`);
    assertTrue(
      memoryAssessment.valid && memoryAssessment.sublinearWithinBudget,
      `A 内存恒定·亚线性：${memoryAssessment.classification} 的 tier2 RSS 中位增量 ${memoryAssessment.tier2DeltaMB}MB`
        + `；独立中位预算 margin ${formatSignedMemoryMB(memoryAssessment.independentBudgetMarginMB)}MB`
        + ` ≤ 取整容差 ${formatMemoryMB(memoryAssessment.independentBudgetRoundingToleranceMB)}MB`
        + `；paired effective预算 margin 中位数 ${formatSignedMemoryMB(memoryAssessment.budgetMarginMedianMB)}MB ≤ 0MB`
        + `，paired 线性 margin 中位数 ${formatSignedMemoryMB(memoryAssessment.linearMarginMedianMB)}MB < 0MB`
        + `（relative预算 ${formatMemoryMB(memoryAssessment.relativeBudgetMB)}MB，absolute预算 ${formatMemoryMB(memoryAssessment.absoluteGrowthBudgetMB)}MB，`
        + `effective预算 ${formatMemoryMB(memoryAssessment.effectiveBudgetMB)}MB，线性外推 ${formatMemoryMB(memoryAssessment.linearProjectedMB)}MB）`
    );

    // ── A3：大输出分 sheet（验证命中子集写出时 writeRowsStreamed 自动分物理 sheet + readback 正确）──
    //   生产路径下命中子集 >104 万行才会分 sheet（700 万级才触发，由手测覆盖）；此处用「全命中 + 小
    //   maxRowsPerSheet」确定性触发同一条 writeRowsStreamed 分 sheet 写路径（与单测同手法，CI 快）。
    console.log('A3 输出分 sheet 验证（全命中 + 小 maxRowsPerSheet 确定性触发 writeRowsStreamed 分物理 sheet）...');
    const fileAllHit = path.join(tmpDir, 'all-hit.xlsx');
    const ALL_HIT_ROWS = 2500;
    const OUT_PER_SHEET = 1000; // 2500/1000 → 输出应 ≥3 物理 sheet
    await writeRowsStreamed({
      savePath: fileAllHit,
      normalizedHeaders: HEADERS,
      sheetBaseName: 'COMMON',
      maxRowsPerSheet: OUT_PER_SHEET,
      writeDataRows: async (emit) => {
        for (let i = 0; i < ALL_HIT_ROWS; i += 1) emit([`R${i}`, SPLIT_VALUE, `S${i}`, 'fill']);
      }
    });
    const outAllHit = path.join(tmpDir, 'all-hit-out.xlsx');
    const expAll = await exportFilter({
      filePath: fileAllHit, field: SPLIT_FIELD, values: [SPLIT_VALUE],
      savePath: outAllHit, maxRowsPerSheet: OUT_PER_SHEET
    });
    assertEq(expAll.matchedCount, ALL_HIT_ROWS, `A3 全命中 matchedCount = ${ALL_HIT_ROWS}`);
    const outWs = await countWorksheets(outAllHit);
    console.log(`   输出物理 sheet 数=${outWs}（${ALL_HIT_ROWS}/${OUT_PER_SHEET} → 期望 ≥3）`);
    assertTrue(outWs >= 3, `A3 命中子集超单 sheet 阈值时输出分了物理 sheet（实际 ${outWs} 个）`);
    const rbAll = await readbackHits(outAllHit);
    assertEq(rbAll.dataRowCount, ALL_HIT_ROWS, `A3 分 sheet 输出 readback 数据行数 = ${ALL_HIT_ROWS}（重复表头被 reader 跳过，跨 sheet 计数正确）`);
    assertTrue(rbAll.allMatchSplitValue, 'A3 分 sheet 输出所有行内容正确');

    // ============================================================
    // B. 真 worker 拓扑（dispatch ↔ worker 接缝；小规模即可）
    // ============================================================
    console.log('\n── B. 真 worker 拓扑（真 dispatchLargeSplit → new Worker → backend）──────');
    const fileWorker = path.join(tmpDir, 'worker-src.xlsx');
    const WORKER_ROWS = 6000; // 小规模：足以跨 3 物理 sheet + seq 超 N=1000 验证封顶
    const workerPerSheet = 2100; // 6000/2100 → 3 物理 sheet
    const { hitCount: hitW } = await genMultiSheetXlsx(fileWorker, WORKER_ROWS, workerPerSheet);
    const wsW = await countWorksheets(fileWorker);
    console.log(`B 生成 worker 夹具（${WORKER_ROWS} 行，物理 sheet 数=${wsW}，注入命中数=${hitW}）...`);
    assertTrue(wsW >= 3, `B worker 夹具跨 ≥3 物理 sheet（实际 ${wsW}）`);

    // B1：真 worker 跑 scanFields → done resolve 的 {headers, valuesByField} 正确。
    console.log('B1 真 worker scanFields（new Worker → done→resolve）...');
    const dScan = dispatchLargeSplit({ op: 'scanFields', filePath: fileWorker });
    const wScan = await dScan.promise;
    assertTrue(wScan && typeof wScan === 'object', 'B1 worker scanFields 返回对象');
    assertEq(JSON.stringify(wScan.headers), JSON.stringify(HEADERS), 'B1 worker scanFields headers 正确（跨进程回传无损）');
    assertEq(
      JSON.stringify((wScan.valuesByField[SPLIT_FIELD] || []).slice().sort()),
      JSON.stringify(CHANNELS.slice().sort()),
      `B1 worker scanFields 低基数列「${SPLIT_FIELD}」去重集合正确`
    );
    assertEq((wScan.valuesByField.seq || []).length, 1000, 'B1 worker scanFields 高基数列封顶 N=1000（跨进程同契约）');
    // 🚩 前端零改动契约锁：valuesByField 只含 {field:string[]}，不含 truncated / distinctSeen 元数据。
    const hasTruncatedMeta = Object.values(wScan.valuesByField).some(
      (v) => !Array.isArray(v)
    ) || ('truncated' in wScan.valuesByField) || ('distinctSeen' in wScan.valuesByField);
    assertTrue(!hasTruncatedMeta, 'B1 worker 回传 valuesByField 仅 {field:string[]}，不含 truncated/distinctSeen 元数据（🚩 前端零改动契约锁）');

    // B2：真 worker 跑 exportFilter → done resolve 的 {matchedCount} 正确 + 产物可 readback。
    console.log('B2 真 worker exportFilter（new Worker → done→resolve + 产物 readback）...');
    const outWorker = path.join(tmpDir, 'worker-out.xlsx');
    const dExp = dispatchLargeSplit({
      op: 'exportFilter',
      filePath: fileWorker,
      field: SPLIT_FIELD,
      values: [SPLIT_VALUE],
      savePath: outWorker,
      batchContext: {
        batchId: 902,
        batchNumber: 'integration-toolbox-902',
        taskRunId: 'integration-toolbox-large-split',
        taskKey: 'toolbox:split:export',
        moduleId: 'toolbox',
        parentRunId: 'integration-toolbox-parent-902',
        operationKey: 'toolbox:split:export:integration-toolbox-large-split'
      }
    });
    const wExp = await dExp.promise;
    assertEq(wExp.matchedCount, hitW, `B2 worker exportFilter matchedCount = 注入命中数（${hitW}）`);
    assertTrue(fs.existsSync(outWorker), 'B2 worker exportFilter 产物文件已写出');
    const rbW = await readbackHits(outWorker);
    assertEq(rbW.dataRowCount, hitW, `B2 worker 产物 readback 数据行数 = 命中数（${hitW}）`);
    assertTrue(rbW.allMatchSplitValue, `B2 worker 产物所有行 channel 列均 = ${SPLIT_VALUE}（dispatch→worker→backend 链端到端正确）`);
    assertEq(JSON.stringify(rbW.headers), JSON.stringify(HEADERS), 'B2 worker 产物 readback 表头正确');

    // ── 汇总 ───────────────────────────────────────────────────────────────────────────────
    const total = passed + failed;
    console.log(`\n==== ${passed}/${total} PASS ====`);
    if (failed > 0) {
      console.error('\nFAILURES:');
      failures.forEach((f) => {
        console.error(`  - ${f.label}`);
        if ('actual' in f) {
          console.error(`      actual:   ${JSON.stringify(f.actual)}`);
          console.error(`      expected: ${JSON.stringify(f.expected)}`);
        }
      });
      process.exit(1);
    }
  } finally {
    // 🔴 跑完删 tmp（不留大文件、不进 git）。
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* swallow */ }
  }
}

async function main() {
  if (process.argv[2] === SCAN_MEMORY_PROBE_MODE) {
    const filePath = process.argv[3];
    if (!filePath) throw new Error('独立 RSS 采样缺少文件路径');
    const result = await scanWithMemorySampling(filePath);
    process.stdout.write(`${SCAN_MEMORY_RESULT_PREFIX}${JSON.stringify(result)}\n`);
    return;
  }
  await run();
}

if (require.main === module) {
  main().catch((e) => { console.error('FATAL', e && e.stack ? e.stack : e); process.exit(1); });
}

module.exports = {
  assessScanMemoryGrowth,
  assessScanMemorySamples,
  collectMemorySamples,
  verifyMemoryGuardModel
};
