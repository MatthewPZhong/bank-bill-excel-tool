// v3.0.8 需求1：工具箱🧰 前端弹框（createToolboxDialog / createSplitFieldPickerDialog）源码断言
//
// renderer-dialogs.js 是 10000+ 行的浏览器 IIFE（依赖 DOM + deps 注入），无 jsdom 单测脚手架，
// 故沿用本仓既有范式（renderer-dialogs-scenario-channel.test.js）：用源码字符串断言锁定关键交互/边界，
// 防止后续重构无意回退。可视布局 + 端到端行为由 preview 截图（docs/previews/toolbox*.png）
// + 主进程纯逻辑单测（main-process/toolbox.test.js）+ 手动测试把关。
//
// 锁定要点（对齐 PRD v3.0.8 §5.1.3 权威细则 + AC1-1..AC1-8）：
//   T1 入口/导出：两个工厂存在且挂到 createRendererDialogs return（renderer.js 按钮 click + preview 可取得）
//   T2 IPC 契约：合表/拆表两步分别调 desktopApi.toolbox.merge / splitRead / splitExport
//   T3 合表成功弹保存路径、failed 拼 detailLines、cancelled 静默
//   T4 拆表两步：splitRead 成功弹选字段弹框；导出前缺源文件/字段/值 → alert 提示先导入选字段（不调 IPC）
//   T5 选字段弹框边界①：空值字段（valuesByField[f] 空）→ 多选框 disabled
//   T6 选字段弹框边界②：未选值 → [完成] disabled（不允许空选导出）

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIALOGS_PATH = path.join(__dirname, '..', '..', 'src', 'renderer-dialogs.js');
const source = fs.readFileSync(DIALOGS_PATH, 'utf8');

// 截取单个函数体（从 `function NAME(` 到下一个顶层 `    function ` 之前），缩小断言作用域、避免误命中别处。
function sliceFunction(src, name) {
  const startToken = `function ${name}(`;
  const startIdx = src.indexOf(startToken);
  assert.ok(startIdx >= 0, `源码应包含 ${name} 工厂`);
  // 下一个同缩进（4 空格）函数声明作为结束锚（两个工厂彼此相邻，足够区分）
  const after = src.indexOf('\n    function ', startIdx + startToken.length);
  return after >= 0 ? src.slice(startIdx, after) : src.slice(startIdx);
}

describe('T1 工具箱弹框工厂存在且导出', () => {
  test('createToolboxDialog / createSplitFieldPickerDialog 均有定义', () => {
    assert.ok(source.includes('function createToolboxDialog('), 'createToolboxDialog 工厂应存在');
    assert.ok(source.includes('function createSplitFieldPickerDialog('), 'createSplitFieldPickerDialog 工厂应存在');
  });

  test('两个工厂挂到 createRendererDialogs 的 return（供 renderer.js 按钮 click + preview 调用）', () => {
    // return { ... createToolboxDialog, createSplitFieldPickerDialog, ... } —— 用工厂前缀的成员引用判定
    const returnIdx = source.lastIndexOf('return {');
    assert.ok(returnIdx >= 0, '应存在 createRendererDialogs 的 return 块');
    const returnBlock = source.slice(returnIdx);
    assert.ok(/\bcreateToolboxDialog,/.test(returnBlock), 'return 应导出 createToolboxDialog');
    assert.ok(/\bcreateSplitFieldPickerDialog,/.test(returnBlock), 'return 应导出 createSplitFieldPickerDialog');
  });
});

describe('T2/T3 合表：一气呵成 + 结果分流', () => {
  const fn = sliceFunction(source, 'createToolboxDialog');

  test('合并表格行调 desktopApi.toolbox.merge()', () => {
    assert.ok(fn.includes('desktopApi.toolbox.merge('), '合表应调 desktopApi.toolbox.merge()');
  });

  test('success → 弹保存路径（result.filePath）', () => {
    assert.ok(/合并完成[\s\S]*?result\.filePath/.test(fn), '合表成功应 alert 保存路径');
  });

  test('failed → message + detailLines 拼进 alert（表头不一致差异可见）', () => {
    assert.ok(fn.includes('result.detailLines'), 'failed 分支应拼 detailLines（表头不一致差异）');
  });

  test('cancelled 静默（不弹框）—— 有显式 cancelled 短路', () => {
    assert.ok(fn.includes("status === 'cancelled'"), '应对 cancelled 短路静默');
  });
});

describe('T4 拆表两步：导入弹选字段框 + 导出前置校验', () => {
  const fn = sliceFunction(source, 'createToolboxDialog');

  test('拆表第一步调 desktopApi.toolbox.splitRead()', () => {
    assert.ok(fn.includes('desktopApi.toolbox.splitRead('), '拆表导入应调 splitRead()');
  });

  test('splitRead 成功 → 打开选字段弹框 createSplitFieldPickerDialog', () => {
    assert.ok(fn.includes('createSplitFieldPickerDialog('), 'splitRead 成功应弹选字段弹框');
  });

  test('选字段弹框传 headers / valuesByField / onComplete / onCancel', () => {
    assert.ok(/createSplitFieldPickerDialog\(\{[\s\S]*?headers[\s\S]*?valuesByField[\s\S]*?onComplete[\s\S]*?onCancel/.test(fn),
      '选字段弹框应传 headers/valuesByField/onComplete/onCancel');
  });

  test('拆表第二步调 desktopApi.toolbox.splitExport({sourceFilePath,field,values})', () => {
    assert.ok(fn.includes('desktopApi.toolbox.splitExport('), '拆表导出应调 splitExport()');
    assert.ok(/sourceFilePath:\s*splitSourceFilePath/.test(fn), 'splitExport 入参应含 sourceFilePath');
    assert.ok(/field:\s*splitSelectedField/.test(fn), 'splitExport 入参应含 field');
    assert.ok(/values:\s*splitSelectedValues/.test(fn), 'splitExport 入参应含 values');
  });

  test('未先导入+选字段（缺源文件/字段/值任一）→ alert 提示先导入选字段，且 return 不调 IPC', () => {
    // 守卫必须在 splitExport 调用之前出现，且命中时 alert + return
    const guardIdx = fn.indexOf('!splitSourceFilePath || !splitSelectedField || splitSelectedValues.length === 0');
    const exportIdx = fn.indexOf('desktopApi.toolbox.splitExport(');
    assert.ok(guardIdx >= 0, '导出应有「缺源文件/字段/值」前置守卫');
    assert.ok(exportIdx >= 0, '应存在 splitExport 调用');
    assert.ok(guardIdx < exportIdx, '前置守卫应在 splitExport 调用之前');
    const guardBlock = fn.slice(guardIdx, exportIdx);
    assert.ok(/window\.alert\([^)]*先[\s\S]*?导入/.test(guardBlock), '守卫命中应 alert 提示先导入选字段');
    assert.ok(/return;/.test(guardBlock), '守卫命中应 return（不调 IPC）');
  });
});

describe('T5/T6 选字段弹框：空值字段 + 空选边界', () => {
  const fn = sliceFunction(source, 'createSplitFieldPickerDialog');

  test('边界①：字段去重值为空 → 多选框 disabled', () => {
    // valuesSelect.disabled = values.length === 0;
    assert.ok(/valuesSelect\.disabled\s*=\s*values\.length === 0/.test(fn),
      '空值字段应禁用多选框（valuesSelect.disabled = values.length===0）');
  });

  test('边界②：选中值数为 0 → [完成] 禁用（不允许空选导出）', () => {
    // completeBtn.disabled = getSelectedValues().length === 0;
    assert.ok(/completeBtn\.disabled\s*=\s*getSelectedValues\(\)\.length === 0/.test(fn),
      '未选值应禁用 [完成]（completeBtn.disabled = getSelectedValues().length===0）');
  });

  test('字段单选 change → 刷新值多选框（refreshValues）', () => {
    assert.ok(/fieldSelect\.addEventListener\('change',\s*refreshValues\)/.test(fn),
      '字段下拉 change 应刷新值列表');
  });

  test('完成回传 {field, values}（onComplete）', () => {
    assert.ok(/onComplete\(\{\s*field:\s*currentFieldName\(\),\s*values\s*\}\)/.test(fn),
      '[完成] 应回传 {field, values}');
  });

  test('完成时空选兜底提示「请至少选择一个值」', () => {
    assert.ok(fn.includes('请至少选择一个值'), '空选时应提示「请至少选择一个值」');
  });
});

describe('T7 入口按钮与 preview 注册（renderer 侧静态校验）', () => {
  const RENDERER_PATH = path.join(__dirname, '..', '..', 'src', 'renderer.js');
  const rendererSrc = fs.readFileSync(RENDERER_PATH, 'utf8');
  const HTML_PATH = path.join(__dirname, '..', '..', 'index.html');
  const htmlSrc = fs.readFileSync(HTML_PATH, 'utf8');

  test('index.html 有 #toolboxBtn（🧰）按钮', () => {
    assert.ok(htmlSrc.includes('id="toolboxBtn"'), 'index.html 应含 #toolboxBtn');
    assert.ok(htmlSrc.includes('🧰'), 'index.html 应含 🧰 emoji');
  });

  test('renderer.js 绑定 toolboxBtn click → openModal(createToolboxDialog())', () => {
    assert.ok(/elements\.toolboxBtn[\s\S]*?addEventListener\('click'[\s\S]*?openModal\(createToolboxDialog\(\)\)/.test(rendererSrc),
      'toolboxBtn click 应 openModal(createToolboxDialog())');
  });

  test('renderer.js preview dispatch 含 toolbox / toolbox-split-field-picker 两分支', () => {
    assert.ok(rendererSrc.includes("previewModal === 'toolbox'"), '应有 toolbox preview 分支');
    assert.ok(rendererSrc.includes("previewModal === 'toolbox-split-field-picker'"), '应有 toolbox-split-field-picker preview 分支');
  });
});
