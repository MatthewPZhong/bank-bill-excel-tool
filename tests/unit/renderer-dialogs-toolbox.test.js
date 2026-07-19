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
//   T4 拆表一气呵成（v3.0.8 用户要求 #1）：splitRead 成功弹选字段弹框；选字段「完成」即在 onComplete 内 splitExport，
//      去掉独立「导出文件」按钮；缺源文件/字段/值 → 应用内弹框提示（不调 IPC）
//   T5 选字段弹框（v3.0.8 用户要求 #5）：值多选改「按钮 + 浮动勾选面板」控件（new-account-currency-*，对齐适用银行渠道下拉）；
//      空值字段 → 下拉 disabled
//   T6 选字段弹框边界②：未选值 → [完成] disabled（selectedValues.size===0）；
//      工具箱反馈（用户要求 #8）走应用内弹框 createAlertDialog（有前端页面/可预览），不再用原生 window.alert

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

describe('T2/T3 合表：一气呵成 + 结果分流 + 应用内弹框', () => {
  const fn = sliceFunction(source, 'createToolboxDialog');

  test('合并表格行调 desktopApi.toolbox.merge()', () => {
    assert.ok(fn.includes('desktopApi.toolbox.merge('), '合表应调 desktopApi.toolbox.merge()');
  });

  test('success → 弹保存路径（result.filePath）', () => {
    assert.ok(/合并完成[\s\S]*?result\.filePath/.test(fn), '合表成功应弹保存路径');
  });

  test('failed → message + detailLines 拼进弹框（表头不一致差异可见）', () => {
    assert.ok(fn.includes('result.detailLines'), 'failed 分支应拼 detailLines（表头不一致差异）');
  });

  test('cancelled 静默（不弹框）—— 有显式 cancelled 短路', () => {
    assert.ok(fn.includes("status === 'cancelled'"), '应对 cancelled 短路静默');
  });

  // v3.0.8（用户要求 #8）：工具箱反馈改走应用内弹框（createAlertDialog，有前端页面/可预览），不再用原生 window.alert。
  test('反馈走应用内弹框 showToolboxAlert（createAlertDialog），不再用原生 window.alert', () => {
    assert.ok(fn.includes('function showToolboxAlert('), '应定义 showToolboxAlert 助手（封装 createAlertDialog）');
    assert.ok(fn.includes('createAlertDialog('), 'showToolboxAlert 应走应用内 createAlertDialog');
    assert.ok(!/window\.alert\(/.test(fn), '工具箱不应再出现原生 window.alert( 调用（已全改应用内弹框）');
  });
});

describe('T4 拆表一气呵成：导入弹选字段框 + 完成即导出（无独立导出按钮）', () => {
  const fn = sliceFunction(source, 'createToolboxDialog');

  test('拆表调 desktopApi.toolbox.splitRead()', () => {
    assert.ok(fn.includes('desktopApi.toolbox.splitRead('), '拆表导入应调 splitRead()');
  });

  test('splitRead 成功 → 打开选字段弹框 createSplitFieldPickerDialog', () => {
    assert.ok(fn.includes('createSplitFieldPickerDialog('), 'splitRead 成功应弹选字段弹框');
  });

  test('选字段弹框传 headers / valuesByField / onComplete / onCancel', () => {
    assert.ok(/createSplitFieldPickerDialog\(\{[\s\S]*?headers[\s\S]*?valuesByField[\s\S]*?onComplete[\s\S]*?onCancel/.test(fn),
      '选字段弹框应传 headers/valuesByField/onComplete/onCancel');
  });

  // v3.0.8（用户要求 #1）：去掉独立「导出文件」按钮 → splitExport 在选字段「完成」回调 onComplete 内一气呵成触发。
  test('无独立「导出文件」按钮（split-export）；splitExport 在 onComplete 内触发', () => {
    assert.ok(!fn.includes('data-action="split-export"'), '不应再有独立「导出文件」按钮');
    assert.ok(!fn.includes('splitExportBtn'), '不应再引用 splitExportBtn（按钮已删）');
    const completeMatch = fn.match(/onComplete:\s*async \(\{ field, values(?:, mode, groups)? \}(?: = \{\})?\)/);
    const completeIdx = completeMatch ? completeMatch.index : -1;
    const exportIdx = fn.indexOf('desktopApi.toolbox.splitExport(');
    assert.ok(completeIdx >= 0, 'onComplete 应为 async（内部一气呵成导出）');
    assert.ok(exportIdx > completeIdx, 'splitExport 应在 onComplete 回调内触发（完成即导出）');
  });

  test('splitExport 入参用选字段回调的 {源文件, field, values}', () => {
    assert.ok(fn.includes('desktopApi.toolbox.splitExport('), '拆表应调 splitExport()');
    assert.ok(/sourceFilePath:\s*result\.sourceFilePath/.test(fn), 'splitExport 入参 sourceFilePath = result.sourceFilePath');
    assert.ok(/values:\s*selectedValues/.test(fn), 'splitExport 入参 values = selectedValues');
  });

  test('缺源文件/字段/值 → 应用内弹框提示 + return 不调 IPC', () => {
    const guardIdx = fn.indexOf('!result.sourceFilePath ||');
    const exportIdx = fn.indexOf('desktopApi.toolbox.splitExport(');
    assert.ok(guardIdx >= 0, '导出应有「缺源文件/字段/值」前置守卫');
    assert.ok(exportIdx >= 0, '应存在 splitExport 调用');
    assert.ok(guardIdx < exportIdx, '前置守卫应在 splitExport 调用之前');
    const guardBlock = fn.slice(guardIdx, exportIdx);
    assert.ok(/showToolboxAlert\([^)]*选择/.test(guardBlock), '守卫命中应用内弹框提示选择字段与值');
    assert.ok(/return;/.test(guardBlock), '守卫命中应 return（不调 IPC）');
  });
});

describe('v3.0.17 多文件拆分契约', () => {
  const toolboxFn = sliceFunction(source, 'createToolboxDialog');
  const pickerFn = sliceFunction(source, 'createSplitFieldPickerDialog');
  const multiFn = sliceFunction(source, 'createMultipleSplitFieldPickerDialog');

  test('单文件旧请求保持 sourceFilePath/field/values，多文件请求使用 mode/groups', () => {
    assert.match(toolboxFn, /sourceFilePath:\s*result\.sourceFilePath,[\s\S]*?field,[\s\S]*?values:\s*selectedValues/);
    assert.match(toolboxFn, /mode:\s*'multiple',[\s\S]*?groups:\s*multipleGroups/);
  });

  test('入口默认不勾选，多文件视图支持新增、删除和最多 8 组', () => {
    assert.ok(pickerFn.includes('需要拆分成多个文件'));
    assert.ok(multiFn.includes('data-action="add-group"'));
    assert.ok(multiFn.includes('toolbox-split-delete-group'));
    assert.ok(multiFn.includes('groups.length >= 8'));
  });

  test('新组继承字段但文件名和值为空，完成回传多文件分组', () => {
    assert.match(multiFn, /fileName:\s*'',\s*fieldIndex:\s*previous \? previous\.fieldIndex : 0,\s*selectedValues:\s*new Set\(\)/);
    assert.ok(multiFn.includes("onComplete({ mode: 'multiple', groups: normalizedGroups })"));
  });

  test('文件名校验覆盖非法字符、系统保留名及大小写不敏感重复', () => {
    assert.ok(multiFn.includes('文件名包含系统不允许的字符'));
    assert.ok(multiFn.includes('文件名是系统保留名称'));
    assert.ok(multiFn.includes("toLocaleLowerCase('en-US')"));
  });
});

describe('T5/T6 选字段弹框：浮动勾选面板控件 + 空值/空选边界', () => {
  const fn = sliceFunction(source, 'createSplitFieldPickerDialog');

  // v3.0.8（用户要求 #5）：值多选改「按钮 + 浮动勾选面板」控件（与场景管理「适用银行渠道」下拉同款）。
  test('值多选改用 new-account-currency 浮动勾选面板控件（非原生 select multiple）', () => {
    assert.ok(fn.includes('new-account-currency-dropdown-panel'), '值多选应用 new-account-currency 浮动面板');
    assert.ok(fn.includes('toolbox-split-values-dropdown-btn'), '值多选应有下拉按钮 toolbox-split-values-dropdown-btn');
    assert.ok(fn.includes('new-account-currency-option'), '面板项应复用 new-account-currency-option 勾选项');
    assert.ok(!/<select class="toolbox-split-picker-values"/.test(fn), '不应再用原生 select multiple 值多选框');
  });

  test('边界①：字段去重值为空 → 下拉按钮 disabled', () => {
    assert.ok(/valuesDropdownBtn\.disabled\s*=\s*currentValuesList\.length === 0/.test(fn),
      '空值字段应禁用下拉按钮（valuesDropdownBtn.disabled = currentValuesList.length===0）');
  });

  test('边界②：选中值数为 0 → [完成] 禁用（不允许空选导出）', () => {
    assert.ok(/completeBtn\.disabled\s*=\s*selectedValues\.size === 0/.test(fn),
      '未选值应禁用 [完成]（completeBtn.disabled = selectedValues.size===0）');
  });

  test('字段单选 change → 刷新值列表（refreshValues）', () => {
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

describe('v3.0.19 合并 handler 多 Sheet 编排与临时资源生命周期', () => {
  const MAIN_PATH = path.join(__dirname, '..', '..', 'src', 'main.js');
  const mainSource = fs.readFileSync(MAIN_PATH, 'utf8');
  const mergeStart = mainSource.indexOf("trackedIpcHandle('toolbox:merge'");
  const splitStart = mainSource.indexOf("trackedIpcHandle('toolbox:split:read'", mergeStart);
  const mergeHandler = mainSource.slice(mergeStart, splitStart);

  test('合并入口委托 strict multi-sheet orchestrator，IPC 名保持不变', () => {
    assert.ok(mergeStart >= 0 && splitStart > mergeStart, '应定位 toolbox:merge handler');
    assert.ok(mergeHandler.includes('toolboxMergeFilesToXlsx({'));
    assert.ok(mergeHandler.includes('filePaths,'));
    assert.ok(mergeHandler.includes("sheetBaseName: 'COMMON'"));
  });

  test('临时目录由 try/finally 在成功、取消保存和失败路径统一清理', () => {
    const tempIdx = mergeHandler.indexOf("fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-'))");
    const tryIdx = mergeHandler.indexOf('try {', tempIdx);
    const finallyIdx = mergeHandler.indexOf('} finally {', tryIdx);
    const cleanupIdx = mergeHandler.indexOf("fs.rmSync(tempDir, { recursive: true, force: true });", finallyIdx);
    assert.ok(tempIdx >= 0 && tryIdx > tempIdx && finallyIdx > tryIdx && cleanupIdx > finallyIdx);
  });

  test('用户目标文件通过原子发布 helper 落盘，不直接复制覆盖', () => {
    assert.ok(mergeHandler.includes('toolboxPublishMergedWorkbook(tempPath, saveResult.filePath)'));
    assert.ok(!mergeHandler.includes('fs.copyFileSync(tempPath, saveResult.filePath)'));
  });

  test('成功日志包含文件、输入 sheet、数据行和输出 sheet 四类计数', () => {
    assert.ok(mergeHandler.includes('writeRes.fileCount'));
    assert.ok(mergeHandler.includes('writeRes.inputSheetCount'));
    assert.ok(mergeHandler.includes('writeRes.dataRowCount'));
    assert.ok(mergeHandler.includes('writeRes.sheetCount'));
  });
});
