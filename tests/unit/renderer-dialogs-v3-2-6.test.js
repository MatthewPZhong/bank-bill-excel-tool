'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const source = fs.readFileSync(path.join(__dirname, '../../src/renderer-dialogs.js'), 'utf8');
const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });

function nodes(root) {
  const out = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type) out.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(root);
  return out;
}
const all = nodes(ast);
function fn(name, root = all) {
  const result = root.find((n) => n.type === 'FunctionDeclaration' && n.id.name === name);
  assert.ok(result, name);
  return result;
}
function text(node) { return source.slice(node.start, node.end); }
function compile(node, deps) {
  return Function(...Object.keys(deps), `return (${text(node)});`)(...Object.values(deps));
}
const escapeHtml = compile(fn('escapeHtml'), {});

function harness({ extraction, cancellation, completion } = {}) {
  const scope = nodes(fn('createBigAccountSelectionDialog'));
  function eventHandler(objectName) {
    const call = scope.find((n) => n.type === 'CallExpression'
      && n.callee.type === 'MemberExpression' && n.callee.object.name === objectName
      && n.callee.property.name === 'addEventListener' && n.arguments[0].value === 'click');
    assert.ok(call, objectName);
    return text(call.arguments[1]);
  }
  const h = {
    dialog: {}, extractOrderBtn: {}, doneBtn: {},
    payload: { contextId: 'current-context' }, overlay: { name: 'selection' },
    currentFileRows: [{ index: 0 }], checkedOrder: [{ merchantId: 'M001', currency: 'USD' }],
    rememberCheckbox: { checked: false }, calls: [], statuses: [], current: null,
    desktopApi: { files: {
      extractBigAccountOrder: async (payload) => { h.calls.push(['extract', payload]); return extraction(); },
      cancelBigAccountSelection: async (contextId) => { h.calls.push(['cancel', contextId]); return cancellation(); },
      completeBigAccountSelection: async (payload) => { h.calls.push(['complete', payload]); return completion(); }
    } },
    escapeHtml,
    createAlertDialog: (message, options = {}) => {
      const button = { classList: { add() {} } };
      return { message, options, querySelector: () => button };
    },
    openModal: (overlay) => { h.current = overlay; },
    closeModal: () => { h.current = null; },
    setStatus: (...args) => h.statuses.push(args),
    applyStatementResult: (result) => h.calls.push(['apply', result]),
    elements: { modalRoot: { contains: (overlay) => h.current === overlay } }
  };
  const helpers = ['syncSelectionActionButtons', 'showUnmaintainedBigAccountAlert', 'cancelUnmaintainedImport']
    .map((name) => text(fn(name, scope))).join('\n');
  const actions = Function('h', `
    const { ${Object.keys(h).join(', ')} } = h;
    let selectionBusy = false, selectionTerminating = false, selectionClosed = false;
    let multiMode = false, multiEditing = false, currentMode = 'unfixed';
    ${helpers}
    return { extract: ${eventHandler('extractOrderBtn')}, done: ${eventHandler('doneBtn')} };
  `)(h);
  return { h, ...actions };
}

const missing = {
  status: 'error', errorCode: 'BIG_ACCOUNT_NOT_MAINTAINED',
  unmaintainedAccounts: [
    { merchantId: 'M<002>', fileName: '<账单>.xlsx', fileOrdinal: 0, blockOrdinal: 1, sourceRowNumber: 8 },
    { merchantId: 'M<002>', fileName: '另一份.xlsx', fileOrdinal: 1, blockOrdinal: 0, sourceRowNumber: 3 }
  ]
};

test('实际提取事件：全批未维护提示转义并保留位置，确认只取消当前上下文', async () => {
  let resolveExtract;
  const { h, extract, done } = harness({
    extraction: () => new Promise((resolve) => { resolveExtract = resolve; }),
    cancellation: () => ({ status: 'success' })
  });
  const pending = extract();
  assert.equal(h.dialog.inert, true);
  await extract();
  await done();
  assert.equal(h.calls.length, 1);
  resolveExtract(missing);
  await pending;
  assert.match(h.current.message, /M&lt;002&gt;/);
  assert.doesNotMatch(h.current.message, /<账单>|M<002>/);
  assert.match(h.current.message, /另一份.xlsx/);
  assert.equal(h.doneBtn.disabled, true);
  assert.equal(h.extractOrderBtn.disabled, true);
  await h.current.options.onConfirm();
  assert.deepEqual(h.calls.map((call) => call[0]), ['extract', 'cancel']);
  assert.equal(h.calls[1][1], 'current-context');
  assert.equal(h.current, null);
  await done();
  assert.equal(h.calls.length, 2, '取消后不能再提交或覆盖历史结果');
});

test('取消失败可重试，期间不能恢复导入；not-active 作为已结束', async () => {
  let attempts = 0;
  const { h, extract, done } = harness({
    extraction: () => missing,
    cancellation: () => { if (++attempts === 1) throw new Error('临时断开'); return { status: 'not-active' }; }
  });
  await extract();
  await h.current.options.onConfirm();
  assert.match(h.current.message, /临时断开/);
  assert.equal(h.current.options.confirmText, '重试取消');
  await done();
  assert.equal(h.calls.filter((c) => c[0] === 'complete').length, 0);
  await h.current.options.onConfirm();
  assert.equal(h.current, null);
  assert.equal(attempts, 2);
});

test('普通未识别仍能返回手动完成；完成请求期间禁止再次提交和提取', async () => {
  let resolveComplete;
  const { h, extract, done } = harness({
    extraction: () => ({ status: 'error', failedRows: [{ index: 0, fileName: '原文件.xlsx' }] }),
    completion: () => new Promise((resolve) => { resolveComplete = resolve; })
  });
  await extract();
  assert.match(h.current.message, /提取不到大账号信息/);
  h.current.options.onConfirm();
  assert.equal(h.current, h.overlay);
  assert.equal(h.doneBtn.disabled, false);
  const pending = done();
  await done();
  await extract();
  assert.deepEqual(h.calls.map((c) => c[0]), ['extract', 'complete']);
  resolveComplete({ status: 'success' });
  await pending;
  assert.deepEqual(h.calls.map((c) => c[0]), ['extract', 'complete', 'apply']);
});

test('提取 IPC 拒绝提供可见错误，保留手选窗口', async () => {
  const { h, extract } = harness({ extraction: () => { throw new Error('读取失败'); } });
  await extract();
  assert.match(h.current.message, /读取失败/);
  assert.equal(h.doneBtn.disabled, false);
  h.current.options.onConfirm();
  assert.equal(h.current, h.overlay);
});

test('C2 真实渲染函数展示两个操作符、只读禁用，确认详情保留选择及旧默认', () => {
  const scope = nodes(fn('createScenarioConfigDialogC2'));
  const render = fn('renderReconFields', scope);
  const renderScenarioOptions = compile(fn('renderScenarioOptions'), { escapeHtml });
  const config = {
    billTypes: [{ seq: 1 }, { seq: 2 }],
    reconFields: [{ seq: 1, leftType: 1, leftField: 'Ref', op: '包含', rightType: 2, rightField: 'Ref' }],
    markValue: { type: 2, field: 'Ref', value: '值' }
  };
  const container = {};
  const deps = { config, reconContainer: container, isReadonly: false, renderScenarioOptions, C2_RECON_OPS: ['等于', '包含'], BANK_STATEMENT_FIELDS: ['Ref'] };
  compile(render, deps)();
  const select = container.innerHTML.match(/<select[^>]*data-multi-field="op"[\s\S]*?<\/select>/)[0];
  assert.equal((select.match(/<option/g) || []).length, 2);
  assert.match(select, /value="包含" selected/);
  assert.doesNotMatch(select, /multiple|disabled/);
  compile(render, { ...deps, isReadonly: true })();
  assert.match(container.innerHTML, /data-multi-field="op"[^>]*disabled/);
  const detail = compile(fn('buildScenarioConfirmDetailHtml'), {
    escapeHtml, opNeedsValue: () => true, getCategoryLabel: () => '银行对账单赋值自身'
  });
  assert.match(detail({ category: 'offset-bill-mark', config }), /Ref 包含 类型#2/);
  delete config.reconFields[0].op;
  assert.match(detail({ category: 'offset-bill-mark', config }), /Ref 等于 类型#2/);
});
