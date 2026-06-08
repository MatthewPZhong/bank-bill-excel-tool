// v3.0.0 需求3 🔴🔴 资金红线：退款提醒对齐 C3 + 候选预检 + 运行点链式编排 单测护栏
//
// 覆盖两类：
//   A. countRefundBankCandidates 纯函数行为（FundType=Ach Return 计数 / 空 / 归一化 / 非候选）
//      —— 退款候选预检的数据依据（r5-refund-order-backfill.js:6 业务语义：银行 FundType=Ach Return 行）。
//   B. renderer.js + preload.js + main.js 源码 grep 护栏，锁关键不变量：
//      ① 退款导入后提醒改用 createConfirmDialog（不再是 createAlertDialog 单按钮）
//      ② shouldPromptRefundAtRun 存在（退款运行点判据，仿 shouldPromptGatewayReconAtRun）
//      ③ 🔴 编排：handleBankStatementRun 退款先于 C3（shouldPromptRefundAtRun 早于 proceedToGwCheck 出现）
//      ④ 🔴 退款「直接运行」onMiddle 调 proceedToGwCheck（★只跳退款继续查 C3）而非 runBankStatementInternal
//      ⑤ proceedToGwCheck 函数存在（承载原 C3 dialog#2 逻辑）
//      ⑥ 候选预检门控接入（导入后 + 运行点均用 refundCandidateCount）
//      ⑦ preload + main 链路（refund-candidate-count IPC + hasRefundOrder 透出 + countRefundBankCandidates 调用）
//   取函数策略：renderer.js 顶层有浏览器副作用（performance.now / window），整文件 require 会抛错；
//      故按花括号配对从源码字符串切出目标函数体做局部断言（参考 renderer-c3-gateway-ready-guard.test.js 同款范式）。

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_PATH = path.join(__dirname, '..', '..', 'src', 'renderer.js');
const PRELOAD_PATH = path.join(__dirname, '..', '..', 'src', 'preload.js');
const MAIN_PATH = path.join(__dirname, '..', '..', 'src', 'main.js');

const source = fs.readFileSync(RENDERER_PATH, 'utf8');
const preloadSource = fs.readFileSync(PRELOAD_PATH, 'utf8');
// main.js 含 NUL 字节 → 用 latin1 读（utf8 会替换为 U+FFFD，破坏 grep）。
const mainSource = fs.readFileSync(MAIN_PATH, 'latin1');

const refundEngine = require('../../src/main-process/scenario-engines/r5-refund-order-backfill');
const { countRefundBankCandidates } = refundEngine;

// 从源码切出 `(async )?function ${fnName}(...) { ... }` 整段（花括号配对）。
function extractFunctionSource(src, fnName) {
  const signature = `function ${fnName}(`;
  let start = src.indexOf(signature);
  if (start === -1) throw new Error(`未在源码找到 ${fnName} 定义`);
  const asyncPrefix = 'async ';
  if (src.slice(start - asyncPrefix.length, start) === asyncPrefix) {
    start -= asyncPrefix.length;
  }
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(start, i);
}

// 去掉 `//` 行注释（保留代码），用于「不再调 X」类断言——避免命中注释里出现的函数名。
function stripLineComments(src) {
  return src.split('\n').map((line) => {
    const idx = line.indexOf('//');
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
}

// ===== A. countRefundBankCandidates 纯函数行为 =====

describe('countRefundBankCandidates（退款候选预检 = FundType 归一后 === Ach Return）', () => {
  test('0 候选：空数组 / null / undefined → 0', () => {
    assert.strictEqual(countRefundBankCandidates([]), 0);
    assert.strictEqual(countRefundBankCandidates(null), 0);
    assert.strictEqual(countRefundBankCandidates(undefined), 0);
  });

  test('N 候选：精确计数 FundType=Ach Return 行', () => {
    const rows = [
      { FundType: 'Ach Return' },
      { FundType: 'Ach Return' },
      { FundType: 'Payment' },
      { FundType: 'Ach Return' }
    ];
    assert.strictEqual(countRefundBankCandidates(rows), 3);
  });

  test('FundType 归一化：首尾空格被 trim 后仍计数（normalizeCellValue）', () => {
    const rows = [
      { FundType: '  Ach Return  ' },
      { FundType: 'Ach Return\t' },
      { FundType: '\nAch Return' }
    ];
    assert.strictEqual(countRefundBankCandidates(rows), 3);
  });

  test('大小写敏感：Ach Return 大小写不符不计（与引擎严格等值口径一致）', () => {
    const rows = [
      { FundType: 'ach return' },
      { FundType: 'ACH RETURN' },
      { FundType: 'Ach return' }
    ];
    assert.strictEqual(countRefundBankCandidates(rows), 0);
  });

  test('非 Ach Return / 缺字段 / null 值 → 不计', () => {
    const rows = [
      { FundType: 'Payment' },
      { FundType: '' },
      { FundType: null },
      { FundType: undefined },
      {},                       // 无 FundType 字段
      null,                     // 行本身为 null（防御）
      { OtherField: 'Ach Return' }  // 字段名不对
    ];
    assert.strictEqual(countRefundBankCandidates(rows), 0);
  });

  test('混合：候选与噪音并存 → 只数 Ach Return', () => {
    const rows = [
      { FundType: 'Ach Return', amt: 1 },
      { FundType: 'Refund', amt: 2 },
      { FundType: ' Ach Return ', amt: 3 },
      { FundType: 'Ach Returns', amt: 4 },   // 多个 s，非精确等值
      { FundType: 'Ach Return', amt: 5 }
    ];
    assert.strictEqual(countRefundBankCandidates(rows), 3);
  });
});

// ===== B. renderer 编排 + 预检 源码护栏 =====

describe('退款导入后提醒：createAlertDialog 单按钮 → createConfirmDialog（v3.0.0 需求3）', () => {
  const importFn = extractFunctionSource(source, 'maybePromptRefundOrderImport');

  test('① 改用 createConfirmDialog（导入文件 / 稍后再说），不再用 createAlertDialog 单按钮', () => {
    assert.ok(importFn.includes('createConfirmDialog'),
      'maybePromptRefundOrderImport 应改用 createConfirmDialog');
    const code = stripLineComments(importFn);
    assert.ok(!code.includes('createAlertDialog'),
      'maybePromptRefundOrderImport 代码不得再用 createAlertDialog 单按钮');
    assert.ok(importFn.includes("confirmText: '导入文件'") && importFn.includes("cancelText: '稍后再说'"),
      '应为「导入文件 / 稍后再说」两按钮（对齐 C3）');
  });

  test('① 候选预检门控：本批无退款候选则不弹（refundCandidateCount > 0 才弹）', () => {
    assert.ok(importFn.includes('refundCandidateCount()'),
      'maybePromptRefundOrderImport 应调 refundCandidateCount() 做候选预检');
    assert.ok(/!\(rc\.candidateCount\s*>\s*0\)\)\s*return false/.test(importFn),
      '候选预检应在 candidateCount<=0 时 return false（不弹）');
  });

  test('① 「导入文件」onConfirm → closeModal() + handleBankStatementBatchImport()（不续跑）', () => {
    const idx = importFn.indexOf('onConfirm');
    assert.ok(idx !== -1, 'createConfirmDialog 应带 onConfirm');
    const after = importFn.slice(idx);
    assert.ok(/closeModal\(\);\s*await\s+handleBankStatementBatchImport\(\);/.test(after),
      'onConfirm 应 closeModal() 后调 handleBankStatementBatchImport()（不续跑）');
  });
});

describe('退款运行点判据 shouldPromptRefundAtRun（v3.0.0 需求3：仿 shouldPromptGatewayReconAtRun）', () => {
  test('② shouldPromptRefundAtRun 函数存在', () => {
    assert.ok(/async\s+function\s+shouldPromptRefundAtRun\s*\(/.test(source),
      '应存在 async function shouldPromptRefundAtRun');
  });

  // v3.0.0 需求3（PR-4 bug 修订）：就绪判据从前端缓存 state.refundOrderSession 改为实时查
  //   isRefundOrderReady()（纯退款表批次缓存滞后 → 运行点误判重复弹）。
  test('② 判据三要素：退款 enabled + !isRefundOrderReady() + 候选>0', () => {
    const fn = extractFunctionSource(source, 'shouldPromptRefundAtRun');
    assert.ok(/if\s*\(\s*await\s+isRefundOrderReady\(\)\s*\)\s*return false/.test(fn),
      '应有 if (await isRefundOrderReady()) return false（main 端 session 已就绪 = 不提醒）');
    const code = stripLineComments(fn);
    assert.ok(!code.includes('state.refundOrderSession'),
      '🔴 PR-4 bug 修订：shouldPromptRefundAtRun 不得再用前端缓存 state.refundOrderSession 作就绪门控（会滞后误判）');
    assert.ok(fn.includes("s.name === '中台退款订单回填'"),
      '应判退款场景 enabled（name=中台退款订单回填）');
    assert.ok(fn.includes('refundCandidateCount()') && /candidateCount\s*>\s*0/.test(fn),
      '应做退款候选预检（refundCandidateCount > 0）');
  });
});

describe('proceedToGwCheck 抽出（v3.0.0 需求3：承载原 C3 dialog#2 逻辑）', () => {
  test('⑤ proceedToGwCheck 函数存在', () => {
    assert.ok(/async\s+function\s+proceedToGwCheck\s*\(/.test(source),
      '应存在 async function proceedToGwCheck');
  });

  test('⑤ proceedToGwCheck 内承载 C3 运行点逻辑（shouldPromptGatewayReconAtRun + 无提醒则 runBankStatementInternal）', () => {
    const fn = extractFunctionSource(source, 'proceedToGwCheck');
    assert.ok(fn.includes('shouldPromptGatewayReconAtRun()'),
      'proceedToGwCheck 应调 shouldPromptGatewayReconAtRun()');
    assert.ok(fn.includes('runBankStatementInternal()'),
      'proceedToGwCheck 无 C3 提醒分支应调 runBankStatementInternal()');
  });
});

describe('🔴🔴 运行点链式编排：退款先于 C3、互不吞（v3.0.0 需求3 资金红线核心）', () => {
  const runFn = extractFunctionSource(source, 'handleBankStatementRun');

  test('③ handleBankStatementRun 中 shouldPromptRefundAtRun 早于 proceedToGwCheck（退款先于 C3）', () => {
    const idxRefund = runFn.indexOf('shouldPromptRefundAtRun()');
    const idxGw = runFn.indexOf('proceedToGwCheck()');
    assert.ok(idxRefund !== -1, 'handleBankStatementRun 应调 shouldPromptRefundAtRun()');
    assert.ok(idxGw !== -1, 'handleBankStatementRun 应调 proceedToGwCheck()');
    assert.ok(idxRefund < idxGw,
      '🔴 退款判据 shouldPromptRefundAtRun 必须先于 proceedToGwCheck 出现（退款先于 C3）');
  });

  test('④ 🔴 退款三选一框 onMiddle（直接运行）调 proceedToGwCheck —— 而非 runBankStatementInternal', () => {
    // 切出退款 createConfirmDialog 段（从退款文案起到该 dialog 的 onMiddle 区）做精确断言。
    const refundDialogStart = runFn.indexOf('中台退款订单回填');
    assert.ok(refundDialogStart !== -1, 'handleBankStatementRun 应含退款三选一框文案');
    const onMiddleIdx = runFn.indexOf('onMiddle', refundDialogStart);
    assert.ok(onMiddleIdx !== -1, '退款三选一框应带 onMiddle（直接运行）');
    // onMiddle 回调体到下一个属性/闭合前
    const onMiddleBody = runFn.slice(onMiddleIdx, runFn.indexOf('}));', onMiddleIdx));
    assert.ok(onMiddleBody.includes('proceedToGwCheck()'),
      '🔴 退款「直接运行」onMiddle 必须调 proceedToGwCheck()（只跳退款、继续查 C3）');
    assert.ok(!onMiddleBody.includes('runBankStatementInternal()'),
      '🔴 退款「直接运行」onMiddle 不得直接调 runBankStatementInternal()（否则 C3 缺数据被静默跳过 = 漏对账）');
  });

  test('④ 退款三选一框 onConfirm（导入文件）调 handleBankStatementBatchImport（不续跑）', () => {
    const refundDialogStart = runFn.indexOf('中台退款订单回填');
    const onConfirmIdx = runFn.indexOf('onConfirm', refundDialogStart);
    const onMiddleIdx = runFn.indexOf('onMiddle', refundDialogStart);
    assert.ok(onConfirmIdx !== -1 && onConfirmIdx < onMiddleIdx, '退款框应带 onConfirm 且在 onMiddle 之前');
    const onConfirmBody = runFn.slice(onConfirmIdx, onMiddleIdx);
    assert.ok(onConfirmBody.includes('handleBankStatementBatchImport()'),
      '退款「导入文件」onConfirm 应调 handleBankStatementBatchImport()');
  });

  test('③ 无退款提醒分支：handleBankStatementRun 末尾直接 await proceedToGwCheck()', () => {
    const code = stripLineComments(runFn);
    assert.ok(/await\s+proceedToGwCheck\(\);/.test(code),
      'handleBankStatementRun 无退款提醒时应直接 await proceedToGwCheck()');
  });
});

describe('preload + main 链路（v3.0.0 需求3：refund-candidate-count + hasRefundOrder）', () => {
  test('⑦ preload 暴露 refundCandidateCount → invoke("bank-statement:refund-candidate-count")', () => {
    assert.ok(/refundCandidateCount:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('bank-statement:refund-candidate-count'\)/.test(preloadSource),
      'preload 应暴露 refundCandidateCount: () => ipcRenderer.invoke("bank-statement:refund-candidate-count")');
  });

  test('⑦ main.js 注册 refund-candidate-count handler 且调 countRefundBankCandidates', () => {
    assert.ok(mainSource.includes("ipcMain.handle('bank-statement:refund-candidate-count'"),
      "main.js 应注册 ipcMain.handle('bank-statement:refund-candidate-count', ...)");
    assert.ok(mainSource.includes('countRefundBankCandidates(bankStatementSession.rows)'),
      'refund-candidate-count handler 应调 countRefundBankCandidates(bankStatementSession.rows)');
  });

  test('⑦ main.js session-status 透出 hasRefundOrder: refundOrderSession !== null', () => {
    assert.ok(/hasRefundOrder:\s*refundOrderSession\s*!==\s*null/.test(mainSource),
      'session-status 应透出 hasRefundOrder: refundOrderSession !== null');
  });

  test('⑦ main.js require r5 引擎的 countRefundBankCandidates', () => {
    assert.ok(/const\s*\{\s*countRefundBankCandidates\s*\}\s*=\s*require\([^)]*r5-refund-order-backfill[^)]*\)/.test(mainSource),
      'main.js 应从 r5-refund-order-backfill 引擎 require countRefundBankCandidates');
  });

  test('⑦ renderer state 接收 hasRefundOrder → state.refundOrderSession', () => {
    assert.ok(/state\.refundOrderSession\s*=\s*status\.hasRefundOrder\s*\?\s*\{\s*ready:\s*true\s*\}\s*:\s*null/.test(source),
      'refreshBankStatementStatus 应据 status.hasRefundOrder 赋 state.refundOrderSession');
  });
});
