// 工具箱迁移后的静态边界与布局约束。
// 业务行为由 scripts/renderer-lifecycle/fixtures/toolbox.js 的生产工厂测试验证；
// 原文件中固定变量名、回调嵌套位置、重挂父 DOM 和 syncUi 调用次数不再是验收依据。
// 输入/字段/token/行计数/文件名保留在真实 DOM fixture 和对应 backend 单测中。

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createToolboxDialogs } = require('../../src/renderer/dialogs/toolbox');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'src/renderer/dialogs/toolbox.js'), 'utf8');
const dialogs = fs.readFileSync(path.join(root, 'src/renderer-dialogs.js'), 'utf8');

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `应存在 ${name}`);
  const end = src.indexOf('\n    function ', start + 1);
  return end < 0 ? src.slice(start) : src.slice(start, end);
}

describe('工具箱工厂的实际导出与调用边界', () => {
  test('工厂只接入 scoped API、modalBridge 和明确 UI 服务，保留三个兼容入口', () => {
    const exported = createToolboxDialogs({ api: {}, modalBridge: {}, ui: {} });
    for (const name of ['createToolboxDialog', 'createSplitFieldPickerDialog', 'createMultipleSplitFieldPickerDialog', 'validateRowsInput']) {
      assert.equal(typeof exported[name], 'function');
    }
    assert.match(dialogs, /__toolboxDialogs\.createToolboxDialogs\(\{[\s\S]*?api:\s*dialogApis\?\.toolbox, modalBridge/);
    assert.doesNotMatch(source, /desktopApi\./);
  });

  test('迁移后只有宿主挂载弹窗，领域工厂不写 modalRoot 或通过原生 alert 反馈', () => {
    assert.doesNotMatch(source, /modalRoot/);
    assert.doesNotMatch(source, /window\.alert\(/);
    assert.doesNotMatch(source, /openModal\(overlay\)/);
    for (const name of ['createToolboxDialog', 'createSplitFieldPickerDialog', 'createMultipleSplitFieldPickerDialog']) {
      assert.doesNotMatch(dialogs, new RegExp(`function ${name}\\(`), `${name} 不保留第二份实现`);
    }
  });

  test('经典脚本加载顺序满足宿主、桥接、工具箱工厂、旧兼容门面、装配入口', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const scripts = ['src/renderer/modal-host.js', 'src/renderer/modal-bridge.js', 'src/renderer/dialogs/toolbox.js', 'src/renderer-dialogs.js', 'src/renderer.js'];
    const loaded = Array.from(html.matchAll(/<script[^>]+src="(?:\.\/)?([^"]+)"/g), (match) => match[1]);
    let previous = -1;
    for (const script of scripts) {
      const index = loaded.indexOf(script);
      assert.ok(index > previous, `脚本顺序：${script}`);
      previous = index;
    }
  });
});

describe('工具箱既有可见结构与可访问性', () => {
  const toolbox = sliceFunction(source, 'createToolboxDialog');
  const picker = sliceFunction(source, 'createSplitFieldPickerDialog');
  const multiple = sliceFunction(source, 'createMultipleSplitFieldPickerDialog');

  test('状态框保留 aria-live、纯文字等待提示和合并/拆分双入口', () => {
    assert.match(toolbox, /class="status-box toolbox-status-box"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/);
    assert.match(toolbox, /class="status-box-text">等待操作<\/span>/);
    const markup = /class="status-box toolbox-status-box"[\s\S]*?<\/div>/.exec(toolbox);
    assert.ok(markup);
    assert.doesNotMatch(markup[0], /<svg/);
    assert.ok(toolbox.includes('toolbox-merge-row'));
    assert.ok(toolbox.includes('toolbox-split-row'));
    assert.doesNotMatch(toolbox, /data-action="split-export"/);
  });

  test('值多选保留浮动勾选面板，按行与多文件入口存在', () => {
    for (const className of ['new-account-currency-dropdown-panel', 'toolbox-split-values-dropdown-btn', 'new-account-currency-option']) {
      assert.ok(picker.includes(className), className);
    }
    assert.doesNotMatch(picker, /<select class="toolbox-split-picker-values"/);
    assert.ok(picker.includes('data-field="split-by-rows"'));
    assert.ok(picker.includes('data-field="multiple-files-enabled"'));
    assert.ok(multiple.includes('data-action="add-group"'));
    assert.ok(multiple.includes('toolbox-split-delete-group'));
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

  test('renderer.js 绑定 toolboxBtn click → 宿主预检后构建工具箱', () => {
    assert.ok(/elements\.toolboxBtn[\s\S]*?addEventListener\('click'[\s\S]*?openModal\(\(\) => createToolboxDialog\(\)\)/.test(rendererSrc),
      'toolboxBtn click 应延迟构建，忙碌拒绝时不提前创建副作用');
  });

  test('renderer.js preview dispatch 含 toolbox / toolbox-split-field-picker 两分支', () => {
    assert.ok(rendererSrc.includes("previewModal === 'toolbox'"), '应有 toolbox preview 分支');
    assert.ok(rendererSrc.includes("previewModal === 'toolbox-split-field-picker'"), '应有 toolbox-split-field-picker preview 分支');
  });
});

describe('v3.1.13 工具箱状态框布局合同', () => {
  const STYLES_PATH = path.join(__dirname, '..', '..', 'src', 'styles-gemini-extra.css');
  const styles = fs.readFileSync(STYLES_PATH, 'utf8');

  test('状态框宽度严格为 2 × 72px 标签宽度，并跨两行', () => {
    assert.match(styles, /\.toolbox-body\s*\{[\s\S]*?--toolbox-label-width:\s*72px;/);
    assert.match(
      styles,
      /\.toolbox-status-box\s*\{[\s\S]*?grid-row:\s*1 \/ 3;[\s\S]*?width:\s*calc\(var\(--toolbox-label-width\) \+ var\(--toolbox-label-width\)\)/
    );
  });

  test('状态框与两枚 36px 导入按钮共享两条 36px grid 行', () => {
    assert.match(styles, /\.toolbox-body\s*\{[\s\S]*?grid-template-rows:\s*36px 36px;/);
    assert.match(styles, /\.toolbox-merge-row\s*\{\s*grid-row:\s*1;\s*\}/);
    assert.match(styles, /\.toolbox-split-row\s*\{\s*grid-row:\s*2;\s*\}/);
  });
});

describe('v3.0.19 合并 handler 多 Sheet 编排与临时资源生命周期', () => {
  const MAIN_PATH = path.join(__dirname, '..', '..', 'src', 'main.js');
  const mainSource = fs.readFileSync(MAIN_PATH, 'utf8');
  const mergeStart = mainSource.indexOf("trackedIpcHandle('toolbox:merge'");
  const splitStart = mainSource.indexOf("ipcMain.handle('toolbox:split:read'", mergeStart);
  const mergeHandler = mainSource.slice(mergeStart, splitStart);

  test('合并入口委托 strict multi-sheet orchestrator，IPC 名保持不变', () => {
    assert.ok(mergeStart >= 0 && splitStart > mergeStart, '应定位 toolbox:merge handler');
    assert.ok(mergeHandler.includes('toolboxMergeFilesToXlsx({'));
    assert.ok(mergeHandler.includes('filePaths,'));
    assert.ok(mergeHandler.includes("sheetBaseName: 'COMMON'"));
  });

  test('临时目录由 try/finally 在成功、取消保存和失败路径统一 best-effort 清理', () => {
    const tempIdx = mergeHandler.indexOf("fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-'))");
    const tryIdx = mergeHandler.indexOf('try {', tempIdx);
    const finallyIdx = mergeHandler.indexOf('} finally {', tryIdx);
    const cleanupIdx = mergeHandler.indexOf('cleanupToolboxTemporaryDirectory(tempDir);', finallyIdx);
    assert.ok(tempIdx >= 0 && tryIdx > tempIdx && finallyIdx > tryIdx && cleanupIdx > finallyIdx);
  });

  test('用户目标文件通过统一可恢复发布 helper 落盘，不直接复制覆盖', () => {
    assert.match(mergeHandler, /const publishMergeArtifacts = async \(artifacts\) => \{/);
    assert.match(
      mergeHandler,
      /const publication = await publishToolboxArtifacts\(\s*'merge'\s*,\s*artifacts,/
    );
    assert.match(mergeHandler, /publishResult = await publishMergeArtifacts\(\[\{/);
    assert.match(mergeHandler, /publisher: \(artifacts\) => publishMergeArtifacts\(/);
    assert.ok(!mergeHandler.includes('fs.copyFileSync(tempPath, saveResult.filePath)'));
  });

  test('成功日志包含文件、输入 sheet、数据行和输出 sheet 四类计数', () => {
    assert.ok(mergeHandler.includes('writeRes.fileCount'));
    assert.ok(mergeHandler.includes('writeRes.inputSheetCount'));
    assert.ok(mergeHandler.includes('writeRes.dataRowCount'));
    assert.ok(mergeHandler.includes('writeRes.sheetCount'));
  });
});
