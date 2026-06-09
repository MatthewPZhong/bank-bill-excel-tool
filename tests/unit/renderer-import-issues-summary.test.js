// v3.0.0 需求2a：buildImportIssuesSummary（renderer.js）行为单测
//
// 背景：去掉导入后明细确认框，改把 per-file 失败/跳过信息提炼成「纯文本」摘要并入状态框。
//   buildImportIssuesSummary(results) 是自包含纯函数（仅依赖入参 + 全局 Array/String/filter/map/join，
//   无 DOM / 无 IPC / 无闭包依赖），可单独抽取执行验证行为。
//
// 取函数策略：renderer.js 顶层有 performance.now()/window 等浏览器副作用，整文件 require 会立即抛错；
//   故从源码字符串按花括号配对切出该函数体，用 new Function 实例化执行（测真实源码行为，不触发顶层副作用）。
//   配套：少量源码 grep 锁「半角冒号防换行」「状态口径」关键不变量（与 renderer-status-box-text.test.js 同款护栏）。

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_PATH = path.join(__dirname, '..', '..', 'src', 'renderer.js');
const source = fs.readFileSync(RENDERER_PATH, 'utf8');

// 从源码切出 `function buildImportIssuesSummary(results) { ... }` 整段（花括号配对）
function extractFunctionSource(src, fnName) {
  const signature = `function ${fnName}(`;
  const start = src.indexOf(signature);
  if (start === -1) throw new Error(`未在 renderer.js 找到 ${fnName} 定义`);
  // 从签名后第一个 '{' 起做花括号配对
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

// 实例化：new Function 返回该纯函数（注入到一个返回它的工厂里）
function loadBuildImportIssuesSummary() {
  const fnSource = extractFunctionSource(source, 'buildImportIssuesSummary');
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${fnSource}\nreturn buildImportIssuesSummary;`);
  return factory();
}

const buildImportIssuesSummary = loadBuildImportIssuesSummary();

describe('buildImportIssuesSummary — 行为（v3.0.0 需求2a）', () => {
  test('全 ok（无跳过无失败）→ 空摘要、hasFailed=false', () => {
    const r = buildImportIssuesSummary([
      { status: 'ok', tableKey: 'bank-statement', fileName: 'A.xlsx' }
    ]);
    assert.strictEqual(r.text, '');
    assert.strictEqual(r.hasFailed, false);
  });

  test('空数组 / 非数组 → 空摘要、hasFailed=false（缺省兜底）', () => {
    for (const input of [[], null, undefined, 'x', 123]) {
      const r = buildImportIssuesSummary(input);
      assert.strictEqual(r.text, '', `输入 ${JSON.stringify(input)} 应得空 text`);
      assert.strictEqual(r.hasFailed, false);
    }
  });

  test('纯跳过（status=disabled）→ 「跳过 N 个: 文件…」、hasFailed=false', () => {
    const r = buildImportIssuesSummary([
      { status: 'disabled', fileName: '文件A.xlsx' },
      { status: 'disabled', fileName: '文件B.csv' }
    ]);
    assert.strictEqual(r.text, '跳过 2 个: 文件A.xlsx、文件B.csv');
    assert.strictEqual(r.hasFailed, false);
    // 🔴 半角冒号防换行：标签后不得出现全角「：」
    assert.ok(!r.text.includes('个：'), '跳过摘要标签后必须用半角冒号');
  });

  test('纯失败（read-error/invalid/ambiguous/unrecognized）→ 「失败 N 个: 文件: 原因」、hasFailed=true', () => {
    const r = buildImportIssuesSummary([
      { status: 'read-error', fileName: '文件C.xlsx' },
      { status: 'invalid', fileName: '文件D.xlsx', message: '校验未通过' }
    ]);
    // read-error 无 message → 取 statusLabel；invalid 有 message → 取 message
    assert.strictEqual(r.text, '失败 2 个: 文件C.xlsx: 文件读取失败、文件D.xlsx: 校验未通过');
    assert.strictEqual(r.hasFailed, true);
    // 🔴 文件内与标签后都用半角冒号
    assert.ok(!r.text.includes('个：'), '失败摘要标签后必须用半角冒号');
  });

  test('混合（跳过 + 失败）→ 两段以 \\n 分隔、跳过在前失败在后、hasFailed=true', () => {
    const r = buildImportIssuesSummary([
      { status: 'ok', tableKey: 'bank-statement', fileName: 'OK.xlsx' },
      { status: 'disabled', fileName: 'Skip.xlsx' },
      { status: 'read-error', fileName: 'Fail.xlsx' }
    ]);
    assert.strictEqual(
      r.text,
      '跳过 1 个: Skip.xlsx\n失败 1 个: Fail.xlsx: 文件读取失败'
    );
    assert.strictEqual(r.hasFailed, true);
    // 两段必须用 \n 分隔（CSS white-space: pre-wrap 渲染换行）
    assert.ok(r.text.includes('\n'), '跳过/失败两段应以 \\n 分隔');
  });

  test('失败原因口径：message > statusLabel > status（与 buildBatchImportSummaryHtml 一致）', () => {
    // 未知 status 且无 message → 回落到 status 字面
    const r = buildImportIssuesSummary([
      { status: 'some-unknown-status', fileName: 'X.xlsx' }
    ]);
    assert.strictEqual(r.text, '失败 1 个: X.xlsx: some-unknown-status');
    assert.strictEqual(r.hasFailed, true);
  });

  test('ok 与 disabled 之外其余状态一律计入失败（含 ambiguous/unrecognized）', () => {
    const r = buildImportIssuesSummary([
      { status: 'ambiguous', fileName: 'amb.xlsx' },
      { status: 'unrecognized', fileName: 'unk.xlsx' }
    ]);
    assert.strictEqual(
      r.text,
      '失败 2 个: amb.xlsx: 表头命中多张表，无法判定、unk.xlsx: 未识别为预处理表'
    );
    assert.strictEqual(r.hasFailed, true);
  });
});

// 源码 grep 护栏（锁关键不变量，与 renderer-status-box-text.test.js 同款）
describe('buildImportIssuesSummary — 源码护栏', () => {
  test('返回 { text, hasFailed } 结构', () => {
    assert.ok(/return\s*\{\s*text:\s*parts\.join\('\\n'\)\s*,\s*hasFailed:/.test(source),
      'buildImportIssuesSummary 应返回 { text: parts.join("\\n"), hasFailed: ... }');
  });

  test('跳过 = status===disabled；失败 = 非 ok 非 disabled（与明细框口径一致）', () => {
    assert.ok(source.includes("r.status === 'disabled'"),
      '跳过判据应为 status===disabled');
    assert.ok(source.includes("r.status !== 'ok' && r.status !== 'disabled'"),
      '失败判据应为 非 ok 非 disabled');
  });

  test('🔴 摘要标签用半角冒号（`跳过 ${...} 个: `/`失败 ${...} 个: `，非全角「：」）', () => {
    assert.ok(source.includes('跳过 ${skipped.length} 个: '),
      '跳过标签应用半角冒号');
    assert.ok(source.includes('失败 ${failed.length} 个: '),
      '失败标签应用半角冒号');
    assert.ok(!source.includes('跳过 ${skipped.length} 个：'),
      '跳过标签不得用全角「：」（会被 updateStatusBox 自动换行）');
    assert.ok(!source.includes('失败 ${failed.length} 个：'),
      '失败标签不得用全角「：」');
  });
});

// 状态框追加逻辑护栏（updateBankStatementUi 主文案后追加 issues + failed 升 error）
describe('updateBankStatementUi — issues 追加护栏（v3.0.0 需求2a）', () => {
  test('主文案后以 \\n 追加 issues.text', () => {
    assert.ok(source.includes('text = `${text}\\n${issues.text}`'),
      'updateBankStatementUi 应把 issues.text 以 \\n 追加在主文案后');
  });

  test('issues.hasFailed → tone 升 error', () => {
    assert.ok(/if\s*\(issues\.hasFailed\)\s*tone\s*=\s*'error';/.test(source),
      'issues.hasFailed 为真时 tone 应升 error');
  });

  test('明细确认框已删（不再 createAlertDialog(buildBatchImportSummaryHtml(...))）', () => {
    assert.ok(!/createAlertDialog\(buildBatchImportSummaryHtml\(/.test(source),
      '导入明细确认框调用应已删除（buildBatchImportSummaryHtml 不再传给 createAlertDialog）');
  });

  test('退款/C3 副作用迁移到 handleBankStatementBatchImport 成功路径（仍保留触发）', () => {
    assert.ok(source.includes('const refundPrompted = await maybePromptRefundOrderImport(results);'),
      '退款提醒触发应保留（迁移到成功路径末尾）');
    assert.ok(source.includes('if (!refundPrompted) maybePromptGatewayReconImport();'),
      'C3 提醒与退款互斥触发应保留');
  });
});
