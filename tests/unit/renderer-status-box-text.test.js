// v2.1.9 N6 (T31-T32, D18=a)：updateBankStatementUi 4 状态文案外层不再带冒号后 `\n`
//   设计意图：内层 updateStatusBox `String(message).replace(/：/g, '：\n')` 统一处理 → 外层不能重复 \n
//   spec.md §7.3 / tasks.md T31
//
// 单元测试形态：grep 银行对账单文案模板字符串 — 不引 DOM / 不模拟 Electron renderer
//   仅校验 `已导出：\n` / `已导入：\n` 模式从源文件消失（v2.1.7 round 2 R3 内层设计的前提）
//   配套：preview 截图回归（手测验视觉）

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RENDERER_PATH = path.join(__dirname, '..', '..', 'src', 'renderer.js');
// GitHub Windows runner 会把 checkout 转为 CRLF；源码截取统一按 LF 处理，避免平台换行影响测试边界。
const source = fs.readFileSync(RENDERER_PATH, 'utf8').replace(/\r\n?/g, '\n');

function loadReconStatusRefresh({ sessionStatus }) {
  const start = source.indexOf('async function refreshReconIdFixStatus(');
  const endMarker = '\n}\n\n// 主面板"场景"下拉刷新';
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, '应能提取 refreshReconIdFixStatus');
  const functionSource = source.slice(start, end + 2);
  const statusWrites = [];
  const uiUpdates = [];
  const context = {
    window: { desktopApi: { reconIdFix: { sessionStatus } } },
    state: {
      reconIdFixSession: { fileName: 'old.xlsx' },
      reconIdFixResult: { fixedRowCount: 9 }
    },
    elements: { reconIdFixStatusBox: {} },
    updateReconIdFixUi(options) {
      uiUpdates.push(options);
    },
    updateStatusBox(_element, message, tone) {
      statusWrites.push({ message, tone });
    },
    console: { error() {} }
  };
  require('node:vm').runInNewContext(
    `${functionSource}\nthis.refreshReconIdFixStatusForTest = refreshReconIdFixStatus;`,
    context
  );
  return {
    refresh: context.refreshReconIdFixStatusForTest,
    state: context.state,
    statusWrites,
    uiUpdates
  };
}

describe('模块初始化状态框保持欢迎文案', () => {
  test('对账单修复自动同步固定静默成功文案，用户动作仍使用默认更新', () => {
    assert.match(
      source,
      /reloadReconIdFixScenarios\(\{[\s\S]*?scenariosChanged: false,[\s\S]*?updateStatus: false[\s\S]*?\}\)/
    );
    assert.match(source, /async function refreshReconIdFixStatus\(\{ updateStatus = true \} = \{\}\)/);
    assert.match(source, /function updateReconIdFixUi\(\{ updateStatus = true \} = \{\}\)/);
    assert.match(source, /if \(updateStatus\) updateStatusBox\(elements\.reconIdFixStatusBox, text, tone\)/);
    assert.match(source, /await refreshReconIdFixStatus\(\);/);
    assert.doesNotMatch(source, /updateStatus: enteringModule/);
  });

  test('对账单修复静默成功会同步 session 和按钮，但不直接写状态框', async () => {
    const harness = loadReconStatusRefresh({
      sessionStatus: async () => ({
        status: 'ok',
        hasFile: true,
        fileName: '账单.xlsx',
        sheetCounts: { business: 7, opp: 6 },
        hasResult: false
      })
    });

    assert.equal(await harness.refresh({ updateStatus: false }), true);
    assert.equal(harness.state.reconIdFixSession.fileName, '账单.xlsx');
    assert.deepEqual(harness.uiUpdates, [{ updateStatus: false }]);
    assert.deepEqual(harness.statusWrites, []);
  });

  test('对账单修复失败结果和 Promise reject 均越过静默模式显示错误', async () => {
    const failed = loadReconStatusRefresh({
      sessionStatus: async () => ({ status: 'failed', message: '数据库忙' })
    });
    assert.equal(await failed.refresh({ updateStatus: false }), false);
    assert.equal(failed.state.reconIdFixSession, null);
    assert.equal(failed.state.reconIdFixResult, null);
    assert.deepEqual(failed.uiUpdates, [{ updateStatus: false }]);
    assert.deepEqual(failed.statusWrites, [{
      message: '对账单修复状态读取失败：数据库忙',
      tone: 'error'
    }]);

    const empty = loadReconStatusRefresh({
      sessionStatus: async () => null
    });
    assert.equal(await empty.refresh({ updateStatus: false }), false);
    assert.deepEqual(empty.statusWrites, [{
      message: '对账单修复状态读取失败',
      tone: 'error'
    }]);

    const rejected = loadReconStatusRefresh({
      sessionStatus: async () => { throw new Error('IPC 中断'); }
    });
    assert.equal(await rejected.refresh({ updateStatus: false }), false);
    assert.deepEqual(rejected.statusWrites, [{
      message: '对账单修复状态读取失败：IPC 中断',
      tone: 'error'
    }]);
  });

  test('场景读取失败也有独立错误投影，不会被静默 session 同步吞掉', () => {
    assert.match(source, /let scenarioReadFailed = false;/);
    assert.match(source, /scenarioReadFailed = true;[\s\S]*?scenarioReadFailure = result;/);
    assert.match(source, /if \(scenarioReadFailed && elements\.reconIdFixStatusBox\)/);
    assert.match(source, /对账单修复场景读取失败/);
  });
});

describe('updateBankStatementUi — N6 状态框换行修复 (v2.1.9 T31)', () => {
  test('外层文案 `已导出：` 后不再有 \\n（删冗余）', () => {
    // 模板字面量 `已导出：\n${...}` 在源码中应为 0 命中
    const matches = source.match(/已导出：\\n/g) || [];
    assert.strictEqual(matches.length, 0,
      `源文件还存在 ${matches.length} 处 \`已导出：\\n\`，应删除（内层 updateStatusBox 已统一处理）`);
  });

  test('外层文案 `已导入：` 后不再有 \\n（删冗余）', () => {
    const matches = source.match(/已导入：\\n/g) || [];
    assert.strictEqual(matches.length, 0,
      `源文件还存在 ${matches.length} 处 \`已导入：\\n\`，应删除`);
  });

  test('外层文案仍含「已导出：」「已导入：」字符串（仅删 \\n，不删字面）', () => {
    assert.ok(source.includes('已导出：${ex.mainFileName}'),
      '源文件应保留 `已导出：${ex.mainFileName}` 模板字面');
    // v3.0.0 需求1：「已导入：」后注入半角冒号的「渠道-地区」前缀 channelRegionPrefix（前缀为空时兜底原文案）。
    //   字面随之变为 `已导入：${channelRegionPrefix}${bs.fileName}`；下方仍校验「已导入：」+ 文件名变量未被删。
    assert.ok(source.includes('已导入：${channelRegionPrefix}${bs.fileName}'),
      '源文件应保留 `已导入：${channelRegionPrefix}${bs.fileName}` 模板字面（v3.0.0 需求1 前缀注入）');
  });

  // v3.0.0 需求1 护栏：前缀分隔必须用半角 ':'、组合间顿号 '、'，绝不用全角「：」
  //   （updateStatusBox 对全角「：」自动补 \n 会把前缀与文件名打断到两行）。
  test('渠道-地区前缀使用半角冒号（channelRegionPrefix 用 `:` 不用全角「：」）', () => {
    assert.ok(source.includes("`${combos.join('、')}:`"),
      "前缀拼接应为 `${combos.join('、')}:`（半角冒号 + 顿号），避免全角「：」触发自动换行");
    // 前缀字面中不得出现全角「：」（否则 updateStatusBox 会在前缀后强制换行）
    assert.ok(!source.includes("${combos.join('、')}："),
      '前缀拼接不得使用全角「：」（会被 updateStatusBox 自动换行打断「前缀+文件名同行」）');
  });

  // v3.0.11 需求2：导出成功框不再显示 error-report（删该显示行；文件仍照常生成）。
  //   `\n不平账结果表：` 等其它行间换行不受影响，保留。
  test('error-report 显示行已移除（v3.0.11 需求2）；`\\n不平账结果表：` 行间换行保留', () => {
    assert.ok(!source.includes('error-report：${ex.errorReportName}'),
      'v3.0.11 需求2：导出成功框 error-report 显示行应已删除（文件仍生成，仅不在状态框展示）');
    assert.ok(source.includes('\\n不平账结果表：${gw.fileName}'),
      '`\\n不平账结果表：` 行间换行应保留');
  });

  test('updateStatusBox 内层 `String(message).replace(/：/g, "：\\n")` 设计保留（v2.1.7 R3 不动）', () => {
    // 内层处理冒号→换行的逻辑必须仍在文件里（否则单换行依赖会失效）
    assert.ok(source.includes("String(message).replace(/：/g, '：\\n')"),
      'updateStatusBox 内层 replace `：` → `：\\n` 必须保留（v2.1.7 round 2 R3 §8.4.2 设计）');
  });
});

// v3.0.7 需求1a：「已处理」分支改用 channelRegionHits 多行分组展示（渠道-地区:n条（场景名…））
describe('updateBankStatementUi 已处理分支 — channelRegionHits 渲染（v3.0.7 需求1a）', () => {
  test('refreshBankStatementStatus 解析 channelRegionHits（向后兼容空数组兜底）', () => {
    assert.ok(source.includes('channelRegionHits: Array.isArray(status.processingStats?.channelRegionHits)'),
      'state.processingResult 应解析 status.processingStats.channelRegionHits（Array.isArray 守卫）');
    assert.ok(source.includes('? status.processingStats.channelRegionHits.slice()'),
      '应 slice 拷贝 channelRegionHits（向后兼容旧持久化/旧 main → []）');
  });

  test('已处理分支按 channelRegionHits 非空走新格式 `渠道-地区:n条（场景名）`', () => {
    assert.ok(source.includes('const crHits = Array.isArray(pr.channelRegionHits) ? pr.channelRegionHits : [];'),
      '已处理分支应读 pr.channelRegionHits 并守卫');
    // 每行格式：`${h.channelRegion}:${rowCount}条${namePart}`（半角冒号防换行）
    assert.ok(source.includes('return `${h.channelRegion}:${Number(h.rowCount) || 0}条${namePart}`;'),
      '每个 hit 应渲染为 `渠道-地区:n条（场景名…）`（半角冒号）');
    // 🔴 分组冒号必须半角，不得全角「：」
    assert.ok(!source.includes('${h.channelRegion}：'),
      'channelRegionHits 分组冒号不得用全角「：」（会被 updateStatusBox 强制换行打断）');
  });

  test('channelRegionHits 为空 → 回退现有 hitScenarios 旧格式（不删旧分支）', () => {
    // 旧 hitScenarios 分组逻辑必须仍在文件里（else 回退分支）
    assert.ok(source.includes('const arr = Array.isArray(pr.hitScenarios) ? pr.hitScenarios : [];'),
      '回退分支应保留 hitScenarios 解析');
    assert.ok(source.includes("idsText = `（场景\\n${lines.join('\\n')}）`;"),
      '回退分支应保留旧 channelName 分组格式');
  });
});

// v3.0.7 需求1c：「已处理」分支移除「，N 警告」尾巴；tone 固定 success（不再因警告转 error）
describe('updateBankStatementUi 已处理分支 — 移除警告 + tone 固定（v3.0.7 需求1c）', () => {
  test('源码不再出现 `，${pr.warningCount} 警告` 尾巴', () => {
    assert.ok(!source.includes('，${pr.warningCount} 警告'),
      '已处理分支应移除「，N 警告」尾巴（警告仍写 error-report，不进状态框文案）');
  });

  test('已处理分支 tone 不再因 warningCount 转 error', () => {
    assert.ok(!source.includes("tone = pr.warningCount > 0 ? 'error' : 'success';"),
      '已处理分支不得再用 `tone = pr.warningCount > 0 ? error : success`（需固定 success）');
  });
});

// v3.0.7 需求1b：「已导出」分支按存在性追加 加款单剔除文件 / 中台回填文件 各占一行
describe('updateBankStatementUi 已导出分支 — 附带产物追加（v3.0.7 需求1b）', () => {
  test('handleBankStatementExport 捕获 platformCleanupName / refundBackfillName 进 state.bankStatementExport', () => {
    assert.ok(source.includes('platformCleanupName: result.platformCleanupName || null'),
      'export ok 分支应捕获 platformCleanupName');
    assert.ok(source.includes('refundBackfillName: result.refundBackfillName || null'),
      'export ok 分支应捕获 refundBackfillName');
  });

  test('已导出分支按存在性追加两行（行间 \\n + 全角「：」与 error-report 同款）', () => {
    assert.ok(source.includes('if (ex.platformCleanupName) text += `\\n加款单剔除文件：${ex.platformCleanupName}`;'),
      '已导出分支应在 platformCleanupName 存在时追加「加款单剔除文件：…」行');
    assert.ok(source.includes('if (ex.refundBackfillName) text += `\\n中台回填文件：${ex.refundBackfillName}`;'),
      '已导出分支应在 refundBackfillName 存在时追加「中台回填文件：…」行');
  });
});

// v3.0.7 需求2a（C2）：两个网关按钮的 DOM 缓存 / 事件绑定 / 导出 disabled 网关分支删除；handleReconIdFixExport 保留
describe('需求2a — 网关按钮清理护栏（v3.0.7 C2）', () => {
  test('DOM 缓存删除：bankStatementGatewayReconImportBtn / ExportBtn 不再 getElementById', () => {
    assert.ok(!source.includes("getElementById('bankStatementGatewayReconImportBtn')"),
      'bankStatementGatewayReconImportBtn DOM 缓存应删除');
    assert.ok(!source.includes("getElementById('bankStatementGatewayReconExportBtn')"),
      'bankStatementGatewayReconExportBtn DOM 缓存应删除');
  });

  test('事件绑定删除：两网关按钮 addEventListener 不再存在', () => {
    assert.ok(!source.includes('elements.bankStatementGatewayReconImportBtn.addEventListener'),
      '导入不平表按钮事件绑定应删除');
    assert.ok(!source.includes('elements.bankStatementGatewayReconExportBtn.addEventListener'),
      '网关导出按钮事件绑定应删除');
  });

  test('updateBankStatementExportButtonsDisabled 网关分支删除（不再设 GatewayReconExportBtn.disabled）', () => {
    assert.ok(!source.includes('elements.bankStatementGatewayReconExportBtn.disabled'),
      'updateBankStatementExportButtonsDisabled 应移除网关导出按钮 disabled 分支');
  });

  test('handleBankStatementGatewayReconImport 函数删除（宿主按钮已删）', () => {
    assert.ok(!source.includes('async function handleBankStatementGatewayReconImport()'),
      'handleBankStatementGatewayReconImport 函数应删除');
  });

  test('🔴 保留项：handleReconIdFixExport / handleBankStatementGatewayReconRun 仍定义', () => {
    assert.ok(source.includes('async function handleReconIdFixExport()'),
      'handleReconIdFixExport 必须保留（ReconID 修复面板共用）');
    assert.ok(source.includes('async function handleBankStatementGatewayReconRun()'),
      'handleBankStatementGatewayReconRun 必须保留（row1 mode 路由仍引用，非本契约删除项）');
    assert.ok(source.includes('elements.reconIdFixExportBtn.addEventListener'),
      'reconIdFixExportBtn → handleReconIdFixExport 绑定必须保留');
  });
});
