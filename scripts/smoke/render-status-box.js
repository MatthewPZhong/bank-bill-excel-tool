// v2.1.7 round 2 R3 — 状态框「：」换行（全局规则）smoke
//   spec §8.4.4 / PRD §十三-R3
//
// 不能直接 require src/renderer.js（依赖 window / document / IPC bridge）
// 改用 spec §8.4.2 等价的 replace 规则单测 + 源码 grep 防 wiring 漏改

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

let passed = 0;
let failed = 0;
const failures = [];

function assertEq(actual, expected, label) {
  try {
    assert.deepStrictEqual(actual, expected);
    passed += 1;
  } catch (_e) {
    failed += 1;
    failures.push({ label, actual, expected });
  }
}

function assertTrue(cond, label) {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push({ label, actual: false, expected: true });
  }
}

// spec §8.4.2 锁定的等价 replace 规则
//   const text = (message === null || message === undefined) ? '' : String(message).replace(/：/g, '：\n');
function transformR3(message) {
  if (message === null || message === undefined) return '';
  return String(message).replace(/：/g, '：\n');
}

// =====================================================================
// R3-1：基础换行 — 中文「：」（U+FF1A）后追加 \n
// =====================================================================
function caseR3_basicTransform() {
  assertEq(transformR3('正在导入：xxx'), '正在导入：\nxxx', 'R3-1 基础换行：中文「：」后追加 \\n');
}

// =====================================================================
// R3-2：null / undefined 兜底空串（防 String(null) === 'null'）
// =====================================================================
function caseR3_nullUndefined() {
  assertEq(transformR3(null), '', 'R3-2 null 兜底空串');
  assertEq(transformR3(undefined), '', 'R3-2 undefined 兜底空串');
}

// =====================================================================
// R3-3：半角 ':' 不换行（避开 URL / timestamp / 账号 case）
// =====================================================================
function caseR3_halfWidthColonPreserved() {
  assertEq(transformR3('GET http://example.com:8080'), 'GET http://example.com:8080',
    'R3-3 半角冒号不换行（URL 场景）');
  assertEq(transformR3('2026-05-21T10:30:45'), '2026-05-21T10:30:45',
    'R3-3 半角冒号不换行（timestamp 场景）');
  assertEq(transformR3('账号 6222000000000001:client'), '账号 6222000000000001:client',
    'R3-3 半角冒号不换行（账号场景）');
}

// =====================================================================
// R3-4：多个「：」全部换行
// =====================================================================
function caseR3_multipleColons() {
  assertEq(transformR3('导入失败：表头错：实际 27 列'),
    '导入失败：\n表头错：\n实际 27 列',
    'R3-4 多个中文「：」全部换行');
}

// =====================================================================
// R3-5：混合中文+半角 — 仅中文「：」换行
// =====================================================================
function caseR3_mixedColons() {
  assertEq(transformR3('对账完成：共 100 条 (耗时 5:30)'),
    '对账完成：\n共 100 条 (耗时 5:30)',
    'R3-5 混合冒号：仅中文「：」换行，半角 5:30 保留');
}

// =====================================================================
// R3-6：边界 — 空字符串 / 数字 / 不含「：」
// =====================================================================
function caseR3_edgeCases() {
  assertEq(transformR3(''), '', 'R3-6 空字符串保持');
  assertEq(transformR3(42), '42', 'R3-6 数字 → 字符串');
  assertEq(transformR3('正常文案不含冒号'), '正常文案不含冒号', 'R3-6 不含「：」原样返回');
  assertEq(transformR3('：开头冒号'), '：\n开头冒号', 'R3-6 开头冒号');
  assertEq(transformR3('结尾冒号：'), '结尾冒号：\n', 'R3-6 结尾冒号也加 \\n');
}

// =====================================================================
// R3-7：源码 wiring 防漏改断言
//   1. renderer.js updateStatusBox 含 R3 replace 规则
//   2. styles.css 含 .status-box-text { white-space: pre-wrap }
//   3. setBizOpReconStatus hack 已删（不再 innerHTML = formatBizOpReconStatusHtml）
//   4. formatBizOpReconStatusHtml 函数定义保留（preview 内仍用）
// =====================================================================
function caseR3_wiringGrep() {
  const rendererSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer.js'), 'utf-8');
  const stylesSrc = fs.readFileSync(path.join(__dirname, '../../src/styles.css'), 'utf-8');
  const dialogsSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer-dialogs.js'), 'utf-8');

  // 1. updateStatusBox 含 replace（必须用中文「：」U+FF1A）
  assertTrue(/String\(message\)\.replace\(\/：\/g, '：\\n'\)/.test(rendererSrc),
    'R3-7-1 updateStatusBox 含 String(message).replace(/：/g, "：\\n")');
  // 2. CSS pre-wrap 全局
  assertTrue(/\.status-box-text\s*\{[^}]*white-space:\s*pre-wrap/.test(stylesSrc),
    'R3-7-2 styles.css .status-box-text { white-space: pre-wrap }');
  // 3. setBizOpReconStatus hack 已删（不再含 innerHTML = formatBizOpReconStatusHtml）
  //   函数内已不应有 textEl.innerHTML 调用
  const setBizOpFnMatch = rendererSrc.match(/function setBizOpReconStatus[\s\S]+?^}/m);
  assertTrue(setBizOpFnMatch && !/innerHTML\s*=\s*formatBizOpReconStatusHtml/.test(setBizOpFnMatch[0]),
    'R3-7-3 setBizOpReconStatus 函数内 hack 已删');
  // 4. formatBizOpReconStatusHtml 函数定义仍在（renderer-dialogs.js preview 内部用）
  assertTrue(/function formatBizOpReconStatusHtml\(/.test(dialogsSrc),
    'R3-7-4 formatBizOpReconStatusHtml 函数定义保留（preview 仍用）');
}

function runRenderStatusBoxSmokeTests() {
  caseR3_basicTransform();
  caseR3_nullUndefined();
  caseR3_halfWidthColonPreserved();
  caseR3_multipleColons();
  caseR3_mixedColons();
  caseR3_edgeCases();
  caseR3_wiringGrep();

  const total = passed + failed;
  if (failed === 0) {
    console.log(`[render-status-box] ${passed}/${total} smoke tests passed`);
  } else {
    console.error(`[render-status-box] ${passed}/${total} smoke tests passed, ${failed} failed:`);
    failures.forEach((f) => {
      console.error(`  - ${f.label}: actual=${JSON.stringify(f.actual)} expected=${JSON.stringify(f.expected)}`);
    });
    throw new Error('render-status-box smoke test failed');
  }
}

module.exports = { runRenderStatusBoxSmokeTests };
