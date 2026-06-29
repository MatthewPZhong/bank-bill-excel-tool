// v3.0.12 PR#82 codex-P2-3（🔴 数据丢失）：账户映射管理弹窗「加载完成前/失败 → 禁用『完成』」守卫的源码断言。
//
// renderer-dialogs.js 是 10000+ 行浏览器 IIFE（依赖 DOM + deps 注入），无 jsdom 单测脚手架，
// 故沿用本仓既有范式（tests/unit/renderer-dialogs-payment-offline-backfill.test.js 的 F2「加载守卫」组）：
// 用源码字符串断言锁定关键实现，防后续重构无意回退；配套行为由 main 侧 op-lock + 仓储测试 + preview + 手测把关。
//
// 锁定点（对应竞态：list() 未完成/失败时点「完成」→ save([]) → 仓储整表删重插 → 清空已配映射）：
//   ① 初始禁用：setDoneEnabled(false) 在异步 list() 之前同步执行（原生 disabled = 拦点击 + 视觉禁用态）。
//   ② 成功路：list() status==='success'（含合法空数组）→ loadMappings + loaded=true + setDoneEnabled(true)。
//   ③ 失败路：catch/非 success → 不再静默留空表，showNestedAlert 提示 + 「完成」保持禁用（无 setDoneEnabled(true)）。
//   ④ 防御纵深：done click handler 开头 if (!loaded) return（即便禁用态被绕过也不写空覆盖）。
//   ⑤ 合法空不误伤：成功分支无 result.mappings.length 门槛 → 空数组同样启用、可有意存空。

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIALOGS_PATH = path.join(__dirname, '..', '..', 'src', 'renderer-dialogs.js');
const source = fs.readFileSync(DIALOGS_PATH, 'utf8');

// 切出 createFundTransferAccountMappingDialog 工厂体（到下一个工厂 createRememberOrderMismatchDialog 前），
// 避免断言误命中文件其他位置的同名片段。
function extractDialogBody() {
  const start = source.indexOf('function createFundTransferAccountMappingDialog()');
  assert.ok(start >= 0, '应能定位 createFundTransferAccountMappingDialog 工厂');
  const end = source.indexOf('function createRememberOrderMismatchDialog(', start);
  assert.ok(end > start, '应能定位 createFundTransferAccountMappingDialog 工厂结束位置');
  return source.slice(start, end);
}

const dialogBody = extractDialogBody();

// 异步加载块（loadMappings([]) 起到 done 按钮 addEventListener 前）—— 用于「失败路不启用」的局部断言。
function extractLoadBlock() {
  const start = dialogBody.indexOf('loadMappings([]);');
  const end = dialogBody.indexOf("doneBtn.addEventListener('click'", start);
  assert.ok(start >= 0 && end > start, '应能定位异步加载 IIFE 块');
  return dialogBody.slice(start, end);
}
const loadBlock = extractLoadBlock();

describe('P2-3：账户映射弹窗加载守卫（禁用『完成』防 save([]) 清空）', () => {
  test('① 初始禁用：setDoneEnabled(false) 同步先于异步 list()，setter 用原生 disabled', () => {
    // setter：doneBtn.disabled = !enabled（原生 disabled → 拦点击 + .primary-btn:disabled 视觉禁用态）
    assert.ok(
      /function setDoneEnabled\(enabled\)\s*\{[\s\S]*?doneBtn\.disabled\s*=\s*!enabled/.test(dialogBody),
      'setDoneEnabled 应用原生 doneBtn.disabled = !enabled'
    );
    assert.ok(dialogBody.includes('let loaded = false;'), '应有 loaded 加载标志，初始 false');
    // 初始禁用调用，且位置在异步加载块之前（同步先禁用）
    const disableIdx = dialogBody.indexOf('setDoneEnabled(false)');
    const loadIdx = dialogBody.indexOf('loadMappings([]);');
    assert.ok(disableIdx >= 0, '应有 setDoneEnabled(false) 初始禁用调用');
    assert.ok(disableIdx < loadIdx, '初始禁用应在异步回填之前同步执行');
  });

  test('② 成功路：status===success（含空数组）→ loadMappings + loaded=true + setDoneEnabled(true)', () => {
    assert.ok(
      /if\s*\(result\s*&&\s*result\.status\s*===\s*'success'\)\s*\{[\s\S]*?loadMappings\(result\.mappings\)[\s\S]*?loaded\s*=\s*true[\s\S]*?setDoneEnabled\(true\)/.test(loadBlock),
      '成功分支应顺序执行 loadMappings(result.mappings) → loaded=true → setDoneEnabled(true)'
    );
  });

  test('③ 失败路：catch→result=null，非 success 分支 showNestedAlert 提示且不启用「完成」', () => {
    // catch 把 result 置 null（流向 else 失败分支），不再静默吞进空表
    assert.ok(
      /catch\s*\(_err\)\s*\{\s*result\s*=\s*null/.test(loadBlock),
      'list() 抛错应 result=null 落入失败分支（不静默留空表）'
    );
    // 失败 else 分支：有 showNestedAlert，且**没有** setDoneEnabled(true)（保持禁用）
    const elseIdx = loadBlock.indexOf('} else {');
    assert.ok(elseIdx >= 0, '应有失败 else 分支');
    const elseBlock = loadBlock.slice(elseIdx);
    assert.ok(/showNestedAlert\(/.test(elseBlock), '失败分支应 showNestedAlert 提示（不静默）');
    assert.ok(
      !elseBlock.includes('setDoneEnabled(true)'),
      '失败分支绝不启用「完成」（保持禁用，杜绝 save([]) 清空映射）'
    );
    assert.ok(
      !elseBlock.includes('loaded = true'),
      '失败分支绝不置 loaded=true（防御纵深守卫同步生效）'
    );
  });

  test('④ 防御纵深：done click handler 开头 if (!loaded) return', () => {
    assert.ok(
      /doneBtn\.addEventListener\('click',\s*async\s*\(\)\s*=>\s*\{\s*if\s*\(!loaded\)\s*return/.test(dialogBody),
      'done 点击处理应以 if (!loaded) return 兜底（即便禁用态被绕过也不 save 空表）'
    );
  });

  test('⑤ 合法空不误伤：成功分支无 result.mappings.length 门槛（空数组同样启用、可有意存空）', () => {
    const successIdx = loadBlock.indexOf("result.status === 'success'");
    const elseIdx = loadBlock.indexOf('} else {');
    const successBlock = loadBlock.slice(successIdx, elseIdx > successIdx ? elseIdx : undefined);
    assert.ok(
      !/result\.mappings\.length/.test(successBlock),
      '成功分支不得按 mappings.length 门控启用（否则成功返回空表被误锁）'
    );
  });

  test('回归：旧「静默留空表」实现已移除', () => {
    assert.ok(!dialogBody.includes('静默：保留空表'), '不应再有「静默：保留空表」的旧实现');
  });
});
