// v2.1.7 round 2 R3 — 状态框「：」换行（全局规则）smoke
//   spec §8.4.4 / PRD §十三-R3
//
// 不能直接 require src/renderer.js（依赖 window / document / IPC bridge）
// 改用 spec §8.4.2 等价的 replace 规则单测 + 源码 grep 防 wiring 漏改

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const acorn = require('acorn');

const readSource = (relative) => fs.readFileSync(path.join(__dirname, '../../src', relative), 'utf-8');
function findFunction(source, name) {
  let found = null;
  function visit(node) {
    if (!node || typeof node !== 'object' || found) return;
    if (node.type === 'FunctionDeclaration' && node.id.name === name) { found = source.slice(node.start, node.end); return; }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(acorn.parse(source, { ecmaVersion: 'latest' }));
  return found;
}

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
  // index.html 加载顺序：styles.css (disabled) → styles-gemini.css → styles-gemini-extra.css
  // R3 生效路径必须在 styles-gemini-extra.css；styles.css 仅作为 spec §8.4.2 文档参考
  const styleGeminiExtraSrc = fs.readFileSync(path.join(__dirname, '../../src/styles-gemini-extra.css'), 'utf-8');
  const dialogsSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer-dialogs.js'), 'utf-8');

  // 1. updateStatusBox 含 replace（必须用中文「：」U+FF1A）
  assertTrue(/String\(message\)\.replace\(\/：\/g, '：\\n'\)/.test(rendererSrc),
    'R3-7-1 updateStatusBox 含 String(message).replace(/：/g, "：\\n")');
  // 2a. spec §8.4.2 参考路径 src/styles.css 有规则（即使 disabled，文档参考）
  assertTrue(/\.status-box-text\s*\{[^}]*white-space:\s*pre-wrap/.test(stylesSrc),
    'R3-7-2a src/styles.css .status-box-text { white-space: pre-wrap }（spec §8.4.2 参考）');
  // 2b. 实际生效路径 styles-gemini-extra.css 必须有规则（index.html 加载的是 disabled styles.css → 必走 gemini-extra）
  assertTrue(/\.status-box-text\s*\{[^}]*white-space:\s*pre-wrap/.test(styleGeminiExtraSrc),
    'R3-7-2b styles-gemini-extra.css .status-box-text { white-space: pre-wrap }（实际生效路径）');
  // 3. setBizOpReconStatus hack 已删（不再含 innerHTML = formatBizOpReconStatusHtml）
  //   函数内已不应有 textEl.innerHTML 调用
  const bizRender = findFunction(readSource('renderer/controllers/biz-op-legacy.js'), 'render');
  assertTrue(bizRender && !/innerHTML\s*=\s*formatBizOpReconStatusHtml/.test(bizRender),
    'R3-7-3 BizOP 当前 render 内旧状态框 HTML hack 已删');
  // 4. formatBizOpReconStatusHtml 函数定义仍在（renderer-dialogs.js preview 内部用）
  assertTrue(/function formatBizOpReconStatusHtml\(/.test(dialogsSrc),
    'R3-7-4 formatBizOpReconStatusHtml 函数定义保留（preview 仍用）');
}

// =====================================================================
// B5 round 3：R3 wiring 漏接审计（spec §9.6.4）
//   全局 grep src/renderer.js，所有 .querySelector('.status-box-text') 后 .textContent =
//   应只出现在 updateStatusBox 函数内（容许 1 处）
//   spec 提到 updateStatusBox 大致 L519-538；改造后函数体可能略漂移，用动态定位
// =====================================================================
function caseB5_wiringAudit() {
  const rendererSrc = fs.readFileSync(path.join(__dirname, '../../src/renderer.js'), 'utf-8');
  const lines = rendererSrc.split('\n');

  // 1. 动态定位 updateStatusBox 函数体范围（从 'function updateStatusBox' 到下一个 '\n}' 顶级）
  let updateStartLine = -1;
  let updateEndLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^function updateStatusBox\(/.test(lines[i])) {
      updateStartLine = i + 1; // 1-based
      // 找匹配的闭合 '}'（基于缩进，function 顶级 → 闭合 '}' 顶格在第 0 列）
      for (let j = i + 1; j < lines.length; j++) {
        if (/^}/.test(lines[j])) {
          updateEndLine = j + 1; // 1-based
          break;
        }
      }
      break;
    }
  }
  assertTrue(updateStartLine > 0 && updateEndLine > 0,
    `B5-1 updateStatusBox 函数定位成功 (${updateStartLine}-${updateEndLine})`);

  // 2. 扫描所有 querySelector('.status-box-text') 后续 5 行内含 .textContent = 的位置
  const directWriteLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(".querySelector('.status-box-text')")) {
      for (let j = i; j < Math.min(i + 5, lines.length); j++) {
        if (/\.textContent\s*=/.test(lines[j])) {
          directWriteLines.push(j + 1); // 1-based
          break;
        }
      }
    }
  }

  // 3. updateStatusBox 函数体内允许 1 次（合法直写）；其它视为漏接
  const leakedOutside = directWriteLines.filter(
    (ln) => ln < updateStartLine || ln > updateEndLine
  );
  assertEq(leakedOutside, [],
    `B5-2 .status-box-text 直写 .textContent = 漏接审计：函数体外应 0 处（实际 ${leakedOutside.length} 处，行号 ${leakedOutside.join(', ')}）`);

  // 4. updateStatusBox 函数体内应至少 1 次（合法直写）
  const insideUpdate = directWriteLines.filter(
    (ln) => ln >= updateStartLine && ln <= updateEndLine
  );
  assertTrue(insideUpdate.length >= 1,
    `B5-3 updateStatusBox 函数体内至少 1 处合法直写（实际 ${insideUpdate.length} 处）`);

  // 5. spec §9.6.1 验证 3 个 'setXxxStatus' / 'updateXxxUi' 全部走 updateStatusBox
  //   grep 函数体内必须含 'updateStatusBox(' 调用
  const targetFns = [
    { file: 'biz-op-legacy.js', name: 'render', call: /ui\.status\(/, label: '业务 OP 状态投影' },
    { file: 'acquiring.js', name: 'render', call: /ui\.status\(/, label: '收单币种状态投影' },
    { file: 'bank-statement.js', name: 'updateBankStatementUi', call: /updateStatusBox\(/, label: '银行对账状态投影' },
    { file: 'recon-id-fix.js', name: 'updateReconIdFixUi', call: /updateStatusBox\(/, label: 'ReconID 状态投影' }
  ];
  for (const target of targetFns) {
    const controller = readSource(`renderer/controllers/${target.file}`);
    const body = findFunction(controller, target.name);
    const projection = target.name === 'render' ? body : findFunction(controller, 'updateStatusBox');
    const writer = target.name === 'render' ? body : findFunction(controller, 'writeStatusBox');
    // RR02 将临时读取错误与业务反馈分开保存，二者最终仍透传同一格式化入口。
    const reachesFormatter = target.name === 'render'
      ? /ui\.status\(/.test(projection || '')
      : /writeStatusBox\(element, text, tone\)/.test(projection || '')
        && /ui\.status\(element, text, tone\)/.test(writer || '');
    assertTrue(body && target.call.test(body) && reachesFormatter,
      `B5-4 ${target.label} 经注入的 ui.status 保持全局格式化`);
  }
  // G3 移植后控制器持有局部 UI 方法，根 composition 必须仍注入同一格式化入口。
  assertTrue(/const ui = \{ modalHost: domainModalHost, status: updateStatusBox/.test(rendererSrc)
    && /createBankStatementController\([\s\S]*?sharedReconSession, ui/.test(rendererSrc)
    && /createReconIdFixController\([\s\S]*?sharedReconSession, ui/.test(rendererSrc),
  'B5-5 Bank/Recon 两域的 ui.status 注入全局 updateStatusBox');
  assertTrue(/const domainUi = \{ modalHost, modalBridge, status: updateStatusBox/.test(rendererSrc)
    && /createBizOpLegacyController\([\s\S]*?ui: \{ \.\.\.domainUi/.test(rendererSrc)
    && /createAcquiringController\([\s\S]*?ui: \{ \.\.\.domainUi/.test(rendererSrc),
  'B5-6 BizOP/收单两域的 ui.status 注入全局 updateStatusBox');

}

function runRenderStatusBoxSmokeTests() {
  caseR3_basicTransform();
  caseR3_nullUndefined();
  caseR3_halfWidthColonPreserved();
  caseR3_multipleColons();
  caseR3_mixedColons();
  caseR3_edgeCases();
  caseR3_wiringGrep();
  caseB5_wiringAudit();

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
