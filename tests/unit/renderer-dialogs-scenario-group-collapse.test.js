// v3.0.8 需求2（W6）：场景管理「退役 C3 + 分组三角折叠」前端源码断言
//
// renderer-dialogs.js 是 10000+ 行的浏览器 IIFE（依赖 DOM + deps 注入），无 jsdom 单测脚手架，
// 故沿用本仓既有范式（renderer-dialogs-scenario-channel.test.js / renderer-dialogs-toolbox.test.js）：
// 用源码字符串断言锁定关键交互/边界，防止后续重构无意回退。
// 可视布局（默认两组收纳 + C3 消失）由 preview 截图 docs/previews/scenarios-manager.png 把关；
// 展开/折叠端到端行为由手动测试把关（preview harness 同步 click 会扰动 modal 生命周期，无法稳定截图展开态）。
//
// 锁定要点（对齐 PRD v3.0.8 §5.2 + AC2-1..AC2-3；团队 W6 决策：仅前端过滤隐藏，零 migration 改动）：
//   A. 退役自带 C3：refreshTable 渲染前过滤「category==='gateway-recon-join' 且 isBuiltin」不显示。
//      v3.0.8 fix（用户拍板）：只隐藏软件自带的 C3，保留用户自建 C3（isBuiltin=false）可见可管理，
//      不再一刀切隐藏全部 gateway-recon-join（避免误伤用户在 BOSH-CN 等渠道下自建的 C3）。
//   B. 分组：两大功能分组「资金性质校验」(fund-nature-check + dbs-charge-fund-check) /
//      「中台订单数据处理」(platform-order)，组名复用 FUNC_CATEGORY_LABELS。
//   C. 三角折叠：分组标题行 ▶/▼ + 子场景行按折叠态显隐，两组默认 collapsed；点三角 toggle。

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const DIALOGS_PATH = path.join(__dirname, '..', '..', 'src', 'renderer-dialogs.js');
const source = fs.readFileSync(DIALOGS_PATH, 'utf8');

// 截取 createScenariosManagerDialog 函数体（从其声明到下一个同缩进 4 空格顶层 function 之前），
// 缩小断言作用域，避免误命中文件别处同名字符串。
function sliceScenariosManagerDialog(src) {
  const startToken = 'function createScenariosManagerDialog(';
  const startIdx = src.indexOf(startToken);
  assert.ok(startIdx >= 0, '源码应包含 createScenariosManagerDialog 工厂');
  const after = src.indexOf('\n    function ', startIdx + startToken.length);
  return after >= 0 ? src.slice(startIdx, after) : src.slice(startIdx);
}

const dialogSrc = sliceScenariosManagerDialog(source);

describe('W6-A：退役自带 C3（仅前端过滤隐藏，零 migration 改动；用户自建 C3 保留）', () => {
  test('refreshTable 渲染前只过滤「自带 C3」（gateway-recon-join 且 isBuiltin），用户自建 C3 不过滤', () => {
    // 关键过滤行：
    //   const scenarios = scenariosRaw.filter((s) => !(s.category === 'gateway-recon-join' && s.isBuiltin));
    // 必须含 isBuiltin 条件（否则会一刀切隐藏用户自建 C3 — v3.0.8 修复前的 bug）。
    assert.ok(
      /\.filter\(\s*\(s\)\s*=>\s*!\(\s*s\.category\s*===\s*'gateway-recon-join'\s*&&\s*s\.isBuiltin\s*\)\s*\)/.test(dialogSrc),
      'refreshTable 应只过滤掉「自带 C3」（category==="gateway-recon-join" 且 isBuiltin），保留用户自建 C3'
    );
    // 防回退：不得再出现一刀切的 s.category !== 'gateway-recon-join'（会误伤用户自建 C3）。
    assert.ok(
      !/\.filter\(\s*\(s\)\s*=>\s*s\.category\s*!==\s*'gateway-recon-join'\s*\)/.test(dialogSrc),
      '不得用一刀切过滤 s.category !== "gateway-recon-join"（会隐藏用户自建 C3）'
    );
  });

  test('过滤发生在补 config / 白名单 / 渠道过滤之前（用 scenariosRaw → scenarios 命名）', () => {
    // 先 load 到 scenariosRaw，过滤自带 C3 得到 scenarios，后续链路全部基于已剔除自带 C3 的 scenarios。
    assert.ok(
      dialogSrc.includes('const scenariosRaw = await loadScenariosOrAlert();'),
      'refreshTable 应先 load 到 scenariosRaw'
    );
    const filterIdx = dialogSrc.indexOf("s.category === 'gateway-recon-join' && s.isBuiltin");
    const builtinConfigIdx = dialogSrc.indexOf(".filter((s) => s.category === 'builtin-fixed')");
    assert.ok(filterIdx >= 0 && builtinConfigIdx >= 0 && filterIdx < builtinConfigIdx,
      '自带 C3 过滤应早于 builtin-fixed 补 config（确保自带 C3 不参与任何后续渲染分支）');
  });

  test('不触碰后端：本前端改动不引入 migrations / 引擎 / dispatcher 改动（注释明确可回滚红线）', () => {
    // 退役策略注释应说明「仅隐藏软件自带的 C3」「后端全不动」「保留用户自建 C3 可见可管理」。
    assert.ok(/仅隐藏「软件自带的 C3」|只过滤自带 C3|只隐藏自带列表项/.test(dialogSrc),
      '应注明退役策略为仅隐藏软件自带的 C3（可回滚）');
    assert.ok(/保留用户自建 C3/.test(dialogSrc),
      '应注明保留用户自建 C3 可见可管理');
  });
});

describe('W6-B：两大功能分组（组名复用 FUNC_CATEGORY_LABELS）', () => {
  test('定义 SCENARIO_GROUP_DEFS：资金性质校验组含 fund-nature-check + dbs-charge-fund-check', () => {
    assert.ok(dialogSrc.includes('const SCENARIO_GROUP_DEFS = ['), '应定义 SCENARIO_GROUP_DEFS');
    assert.ok(
      /key:\s*'fund-nature-check'[\s\S]*?funcCategories:\s*\[\s*'fund-nature-check'\s*,\s*'dbs-charge-fund-check'\s*\]/.test(dialogSrc),
      '资金性质校验组应归并 fund-nature-check + dbs-charge-fund-check'
    );
  });

  test('中台订单数据处理组 = platform-order', () => {
    assert.ok(
      /key:\s*'platform-order'[\s\S]*?funcCategories:\s*\[\s*'platform-order'\s*\]/.test(dialogSrc),
      '中台订单数据处理组应为 platform-order'
    );
  });

  test('组名复用 FUNC_CATEGORY_LABELS（避免硬编码漂移）', () => {
    assert.ok(
      dialogSrc.includes("label: FUNC_CATEGORY_LABELS['fund-nature-check']")
      && dialogSrc.includes("label: FUNC_CATEGORY_LABELS['platform-order']"),
      'SCENARIO_GROUP_DEFS 的 label 应取自 FUNC_CATEGORY_LABELS'
    );
  });

  test('getScenarioGroupKey：无 funcCategory（含 C1/C2/无 funcCategory 的 builtin-fixed）→ null（扁平）', () => {
    assert.ok(dialogSrc.includes('function getScenarioGroupKey(scenario)'), '应有 getScenarioGroupKey');
    // funcCategory 缺失 → return null（扁平显示，不强制分组）
    assert.ok(
      /function getScenarioGroupKey\(scenario\)\s*\{[\s\S]*?if\s*\(!funcCategory\)\s*return null;/.test(dialogSrc),
      'getScenarioGroupKey 对无 funcCategory 的场景返回 null（扁平）'
    );
  });
});

describe('W6-C：三角折叠 + 默认收纳', () => {
  test('两组默认 collapsed：collapsedGroups 初始含全部分组 key', () => {
    assert.ok(
      dialogSrc.includes('const collapsedGroups = new Set(SCENARIO_GROUP_DEFS.map((g) => g.key));'),
      'collapsedGroups 应初始化为全部分组 key（两组默认收纳）'
    );
  });

  test('分组标题行带 ▶/▼ 三角 + data-action="toggle-group"', () => {
    assert.ok(dialogSrc.includes('function renderGroupHeaderRow('), '应有 renderGroupHeaderRow');
    assert.ok(dialogSrc.includes("scenario-group-header"), '分组标题行应有 .scenario-group-header class');
    assert.ok(
      /const triangle = collapsed \? '▶' : '▼';/.test(dialogSrc),
      '折叠态用 ▶、展开态用 ▼'
    );
    assert.ok(dialogSrc.includes('data-action="toggle-group"'), '标题行三角按钮带 data-action="toggle-group"');
    assert.ok(dialogSrc.includes('class="scenario-group-toggle"'), '应有 .scenario-group-toggle 按钮');
  });

  test('分组标题行 colspan 跟随可见列数（checkbox+id+category+name+actions 基础 5 列 + 优先级/启用）', () => {
    assert.ok(dialogSrc.includes('function getScenarioTableColSpan()'), '应有 getScenarioTableColSpan');
    assert.ok(
      /return 5 \+ \(isCompactView \? 0 : 1\) \+ \(showEnabledCol \? 1 : 0\);/.test(dialogSrc),
      'colspan = 5 + (非compact 的优先级列) + (showEnabledCol 的启用列)'
    );
  });

  test('子场景行标记 data-group + scenario-group-row，初始折叠态加 .collapsed', () => {
    assert.ok(
      /tr\.dataset\.group = groupKey;[\s\S]*?tr\.classList\.add\('scenario-group-row'\);[\s\S]*?if \(collapsedGroups\.has\(groupKey\)\) tr\.classList\.add\('collapsed'\);/.test(dialogSrc),
      'renderRow 对分组子行应打 data-group + scenario-group-row，并按 collapsedGroups 加 .collapsed'
    );
  });

  test('refreshTable 分组渲染：扁平场景先渲染，再每组插标题 + 子行；空组不渲标题', () => {
    assert.ok(
      dialogSrc.includes('const flatScenarios = visible.filter((s) => getScenarioGroupKey(s) === null);'),
      '应先取无分组（扁平）场景'
    );
    assert.ok(
      dialogSrc.includes('tbody.appendChild(renderGroupHeaderRow(group.key, group.label, collapsed));'),
      '应为每个非空组渲染分组标题行'
    );
    assert.ok(
      /if \(members\.length === 0\) return;/.test(dialogSrc),
      '空组（无场景）不渲分组标题'
    );
  });

  test('🔴 N3-1 红线：序号列用 scenario.displayIndex（派发口径），不用分组重排位置序数', () => {
    // 分组只改渲染顺序，序号必须仍是 scenarios-repository 渠道内 builtin-fixed 优先 1-based displayIndex，
    // 与 run 状态框 / 命中场景行报表共享同一口径（否则状态框「场景 N」与 UI 序号串号 → N3-1 修复失效）。
    assert.ok(
      /const displayNumberOf = \(scenario, fallbackPos\) =>\s*\n?\s*Number\.isFinite\(Number\(scenario\.displayIndex\)\)\s*\?\s*Number\(scenario\.displayIndex\)\s*:\s*fallbackPos;/.test(dialogSrc),
      '应定义 displayNumberOf：优先 scenario.displayIndex，缺失才回退位次'
    );
    assert.ok(
      dialogSrc.includes('renderRow(scenario, displayNumberOf(scenario, fallbackPos), null)')
      && dialogSrc.includes('renderRow(scenario, displayNumberOf(scenario, fallbackPos), group.key)'),
      '扁平行与分组子行的序号都走 displayNumberOf（统一派发口径）'
    );
    // 防回退：tbody.appendChild 渲染调用不得直接把递增位置序数当序号传入（须经 displayNumberOf）。
    assert.ok(
      !/appendChild\(renderRow\(scenario, displayIndex,/.test(dialogSrc),
      '渲染调用不得直接用位置序数 displayIndex 作为序号（会破坏 N3-1 一致性）'
    );
  });

  test('toggleScenarioGroup：翻转 collapsedGroups + 子行 .collapsed + 三角字符', () => {
    assert.ok(dialogSrc.includes('function toggleScenarioGroup(groupKey)'), '应有 toggleScenarioGroup');
    assert.ok(
      /tr\.classList\.toggle\('collapsed', willCollapse\);/.test(dialogSrc),
      'toggle 时子行按 willCollapse 切换 .collapsed'
    );
    assert.ok(
      /triangle\.textContent = willCollapse \? '▶' : '▼';/.test(dialogSrc),
      'toggle 时三角字符随折叠态翻转'
    );
  });

  test('tbody click 委托优先处理 toggle-group（先于 row-action 行操作）', () => {
    assert.ok(
      /const groupToggle = event\.target\.closest\('\[data-action="toggle-group"\]'\);[\s\S]*?toggleScenarioGroup\(groupToggle\.dataset\.group\);[\s\S]*?return;/.test(dialogSrc),
      'tbody click handler 应先识别 toggle-group 并调 toggleScenarioGroup'
    );
  });
});
