// v3.0.8 需求3（运行不阻塞）：资金对账 run 进度事件「跨进程契约」护栏。
//
// 进度链路三跳，任一跳字段/通道对不上 → 用户看不到进度（或退回「未响应」观感）：
//   main 编排器 onProgress({ round })  ─┐
//   main handler  onProgress({ stage }) ─┤→ 内联 forwarder 发到通道 'bank-statement:run:progress'
//                                        └→ preload onRunProgress(ipcRenderer.on 同名通道)
//                                           → renderer formatBankStatementRunProgress(ev) 按 ev.round/ev.stage 取文案
//
// 本测试把「编排器实际 emit 的每个 round」「handler 实际 emit 的每个 stage」与「renderer 文案表的 key」做**跨文件比对**：
//   编排器新增一个轮次却忘了在 renderer 加文案 → 该轮进度空白 → 本测试红（而不是等手测才发现）。
//   通道名三处（main send / preload on / preload removeListener）也钉死一致。
// 形态沿用仓库既有范式 renderer-status-box-text.test.js：纯源码文本断言，不引 DOM / 不模拟 Electron。

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SRC_DIR = path.join(__dirname, '..', '..', 'src');
// 读源 + 剥 NUL（main.js 含 NUL 字节，见 memory reference_mainjs_nul_grep；其余文件剥除无副作用）。
const readSrc = (rel) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8').replace(/\u0000/g, '');
const rendererSrc = readSrc('renderer.js');
const preloadSrc = readSrc('preload.js');
const mainSrc = readSrc('main.js');
const orchSrc = readSrc(path.join('main-process', 'reconciliation-orchestrator.js'));

const RUN_PROGRESS_CHANNEL = 'bank-statement:run:progress';

// 从 `const XXX_LABELS = { ... };` 切出对象字面块（到首个 '};'）。
function sliceLabelBlock(src, declMarker) {
  const i = src.indexOf(declMarker);
  assert.ok(i >= 0, `源码应包含 ${declMarker}`);
  const close = src.indexOf('};', i);
  assert.ok(close > i, `${declMarker} 应有闭合 '};'`);
  return src.slice(i, close);
}
// key 在 label 块里是否作为对象键存在（兼容裸键 R1: 与带引号键 'R3.5':）。
const keyInBlock = (block, key) => block.includes(`${key}:`) || block.includes(`'${key}':`);

// 提取所有实际调用点的参数字面值：matchCall('yieldTick', orchSrc) → ['R1','R2',...]（去重，保序）。
function extractCallArgs(fnName, src) {
  const re = new RegExp(`${fnName}\\(\\s*'([^']+)'\\s*\\)`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

describe('需求3 进度契约：renderer formatBankStatementRunProgress 形态', () => {
  test('formatBankStatementRunProgress 存在且同时识别 ev.stage 与 ev.round 两类事件', () => {
    assert.ok(rendererSrc.includes('function formatBankStatementRunProgress(ev)'), 'renderer 必须定义 formatBankStatementRunProgress(ev)');
    assert.ok(
      rendererSrc.includes('if (ev.stage && STAGE_LABELS[ev.stage]) return STAGE_LABELS[ev.stage];'),
      '格式化器必须按 ev.stage 取 STAGE_LABELS 文案'
    );
    assert.ok(
      rendererSrc.includes('if (ev.round && ROUND_LABELS[ev.round]) return ROUND_LABELS[ev.round];'),
      '格式化器必须按 ev.round 取 ROUND_LABELS 文案'
    );
  });
});

describe('需求3 进度契约：编排器 emit 的每个 round 在 renderer 都有文案（跨文件）', () => {
  test('编排器 yieldTick 轮次集合非空且每个都命中 renderer ROUND_LABELS', () => {
    const rounds = extractCallArgs('yieldTick', orchSrc);
    assert.ok(rounds.length >= 7, `编排器应在 ≥7 个轮次边界 emit（实测 ${rounds.length}：${rounds.join(',')}）`);
    const roundBlock = sliceLabelBlock(rendererSrc, 'const ROUND_LABELS = {');
    const missing = rounds.filter((r) => !keyInBlock(roundBlock, r));
    assert.strictEqual(
      missing.length,
      0,
      `编排器 emit 的轮次 [${missing.join(', ')}] 在 renderer ROUND_LABELS 无文案 → 该轮进度空白。请在 renderer 补对应文案。`
    );
  });
});

describe('需求3 进度契约：handler emit 的每个 stage 在 renderer 都有文案（跨文件）', () => {
  test('handler yieldRun 阶段集合非空且每个都命中 renderer STAGE_LABELS', () => {
    const stages = extractCallArgs('yieldRun', mainSrc);
    assert.ok(stages.length >= 1, `handler 应在 ≥1 个数据准备阶段 emit（实测 ${stages.length}：${stages.join(',')}）`);
    const stageBlock = sliceLabelBlock(rendererSrc, 'const STAGE_LABELS = {');
    const missing = stages.filter((s) => !keyInBlock(stageBlock, s));
    assert.strictEqual(
      missing.length,
      0,
      `handler emit 的阶段 [${missing.join(', ')}] 在 renderer STAGE_LABELS 无文案 → 该阶段进度空白。请在 renderer 补对应文案。`
    );
  });
});

describe('需求3 进度契约：run:progress 通道名三处一致（main send ↔ preload on/removeListener）', () => {
  test('main.js 内联 forwarder 发到 bank-statement:run:progress', () => {
    assert.ok(
      mainSrc.includes(`event.sender.send('${RUN_PROGRESS_CHANNEL}', { ...ev, phase: 'run' });`),
      `main forwarder 必须发到 '${RUN_PROGRESS_CHANNEL}'`
    );
  });

  test('preload 在同名通道 on + removeListener，并暴露 bankStatement.onRunProgress', () => {
    assert.ok(preloadSrc.includes(`ipcRenderer.on('${RUN_PROGRESS_CHANNEL}', wrapped);`), `preload 必须 ipcRenderer.on('${RUN_PROGRESS_CHANNEL}')`);
    assert.ok(
      preloadSrc.includes(`ipcRenderer.removeListener('${RUN_PROGRESS_CHANNEL}', wrapped);`),
      `preload 退订必须用同名通道 removeListener('${RUN_PROGRESS_CHANNEL}')`
    );
    assert.ok(preloadSrc.includes('onRunProgress: (listener) =>'), 'preload 必须暴露 onRunProgress(listener) 订阅 API');
  });

  test('renderer 经 desktopApi.bankStatement.onRunProgress 订阅并喂给格式化器', () => {
    assert.ok(rendererSrc.includes('api.onRunProgress((ev) =>'), 'renderer 必须订阅 onRunProgress');
    assert.ok(rendererSrc.includes('const text = formatBankStatementRunProgress(ev);'), 'renderer 订阅回调必须把事件喂给 formatBankStatementRunProgress');
  });
});
