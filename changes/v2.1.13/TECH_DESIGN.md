# v2.1.13 技术方案（TechDoc）

> 配套 PRD：`changes/v2.1.13/PRD.md`
> 所有行号基于 v2.1.13 分支创建时（= main @ 2.1.12）的代码事实。

## 0. 关键技术约束

- **执行引擎按 `category` 字符串分派**：`src/main-process/scenario-engines/index.js:10-24` `runScenario(scenario, bankRows, gwRows)`：
  - `extract-recon-id` → `runC1Scenario`
  - `offset-bill-mark` → `runC2Scenario`
  - `gateway-recon-join` → `runC3Scenario`
  - default → throw "未知 category"
  → 新 category `builtin-fixed` 必须显式加路由，否则运行报错（D-5 的实现关键）。
- **SQLite 不支持 ALTER CHECK**：扩展 category 枚举须**重建表**，范式见 `migrations.js:544-588 ensureScenariosCategoryReconIdFix`。
- **renderer-dialogs.js 单文件 ~5000 行**：多个前端任务都改它，并行会冲突 → 前端任务**串行**或用 worktree 隔离。

## 1. 数据层

### 1.1 migrations.js

**(a) 新增 `ensureScenariosCategoryBuiltinFixed(db)`** — 照搬 `ensureScenariosCategoryReconIdFix` 重建表范式，CHECK 枚举追加 `'builtin-fixed'`（最终 6 值）。幂等判据：`sqlite_master.sql.includes("'builtin-fixed'")`。在 `database.js init()` 调用链末尾追加（在 `ensureScenariosCategoryGatewayReconIdFix` 之后）。

**(b) 新增 `ensureScenarioApplicableChannelsTable(db)`** — 多对多关联表：
```sql
CREATE TABLE IF NOT EXISTS scenario_applicable_channels (
  scenario_id INTEGER NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  channel_id  INTEGER NOT NULL REFERENCES channels(id)  ON DELETE CASCADE,
  PRIMARY KEY (scenario_id, channel_id)
);
```
语义：表中**无任何行**视为「适用全部渠道」（默认全选）；有行则按行限定。

**(c) seed 迁移 `ensureBuiltinFixedScenarioMigration(db)`** — 幂等，把已存在的内置提取场景归入 builtin-fixed：
- 定位：`category='extract-recon-id' AND name='从银行对账单的信息里提取对账ID' AND is_builtin=1`
- 改：`category='builtin-fixed'`、`priority=0`、`channel_id=1`（通用）
- 若用户已删该场景（D14 内置可删）→ no-op，不复活。
- ⚠️ 同步修改 `BUILTIN_SCENARIOS[0]`（migrations.js:314-344）：`category: 'builtin-fixed'`、`priority: 0`，使新库 seed 直接落 builtin-fixed。

### 1.2 scenarios-repository.js

- `VALID_CATEGORIES`（11-19）追加 `'builtin-fixed'`。
- 新增适用渠道读写（或拆 `scenario-applicable-channels-repository.js`）：
  - `getApplicableChannelIds(db, scenarioId) → number[]`（空数组=全部）
  - `setApplicableChannelIds(db, scenarioId, channelIds[])`（事务：DELETE 旧 + INSERT 新；空数组=清空=全部）
- `deleteScenario`（377-387）：builtin-fixed 应**不可删**（同 is_builtin 保护，已有 is_builtin=1 拦截即可）。
- 排序：listScenarios（162-183）当前 `ORDER BY priority DESC, id ASC`。builtin-fixed priority=0 会排末尾，但需求要它「序号 1」置顶 → **在前端渲染层置顶**（见 3.3），不改后端排序以免影响其他逻辑。

### 1.3 database.js facade + IPC + preload

- `AppDatabase`（840-875）加 `getScenarioApplicableChannels(id)` / `setScenarioApplicableChannels(id, ids)`。
- main 端 IPC：`scenarios:get-applicable-channels` / `scenarios:set-applicable-channels`。
- preload（118-145）`desktopApi.scenarios` 加对应方法。

## 2. 执行引擎

### 2.1 runScenario 加 builtin-fixed 路由（scenario-engines/index.js:10-24）
```js
if (scenario.category === 'builtin-fixed') {
  // 当前 builtin-fixed 唯一形态 = extractByFeature 提取（D-5：保留功能）
  if (scenario.config && scenario.config.extractByFeature) return runC1Scenario(scenario, bankRows);
  throw new Error(`builtin-fixed 场景无法识别的 config 形态: ${scenario.name}`);
}
```

### 2.2 dispatcher 适用渠道（scenario-dispatcher.js）✅ 定稿：跨渠道生效
- 现状：运行渠道 X 时 `listByChannelIdAndCategory(db, X, cat)` 只取 channel_id=X 的场景。
- builtin-fixed channel_id=1，运行 X≠1 时按现逻辑取不到。
- **实现**：dispatcher 额外取「`scenario_applicable_channels` 含 X，或该场景无任何关联行（=适用全部）」的 builtin-fixed 场景并入执行集。新增查询 `listBuiltinFixedForChannel(db, channelId)`。
- 注意：写死场景启用开关（enabled）仍生效；disabled 不执行。去重：若运行渠道恰为通用(1)，避免与按 channel_id=1 拉到的 builtin-fixed 重复。

## 3. 前端（renderer.js / renderer-dialogs.js / index.html / styles）

### 3.1 A1 镜像对调
- 给 `bankStatementModulePanel` 加 `layout-mirrored`：最简在 index.html:271 的 class 上加；或在 renderer.js `setCurrentModule` 切到该模块时加。推荐 **index.html 静态加**（与 bankBuRecon/vccOpCalc 一致）。
- 验证：rtl 不破坏按钮交互/状态框（参考已用 layout-mirrored 的 bankBuRecon）。

### 3.2 A2 ReconID 去银行渠道
- renderer-dialogs.js:6104-6115 渠道下拉块（`.scenario-channel-filter-wrapper`）：`isCompactView ? 'display:none' : ''`（isCompactView 已在 6084 定义 = filter.length===1 = ReconID 入口）。
- refreshTable（6246-6254）渠道过滤：compact 视图下跳过渠道过滤（或固定 activeChannelId 不影响 ReconID，因其按 category 白名单已过滤）。

### 3.3 D-2/D-4 builtin-fixed 列表渲染（renderRow 6171-6198 + refreshTable 6246-6262）
- `getCategoryLabel`（5545-5547）：`builtin-fixed` 返回 `银行对账单赋值自身`（= B3 改名后的 offset-bill-mark label，按需求"仅文本"）。
- refreshTable 排序：把 builtin-fixed 场景置顶（displayIndex 从 1 起），其余随后。
- renderRow 对 builtin-fixed：优先级列显示 `0`；执行操作列**仅**「管理」按钮（去掉转移/删除）；保留启用 checkbox；序号正常取置顶后的 displayIndex（=1）。
- builtin-fixed 仅在「通用」渠道可见：refreshTable 渠道过滤时 builtin-fixed 仅当 activeChannelId===1 显示。

### 3.4 D-3 管理弹窗（多选适用渠道）
- 新建 `createBuiltinFixedChannelManageDialog(scenarioId)`：标题/左上「请选择适用银行渠道」；中间多选下拉（左侧「银行渠道」label，枚举=`desktopApi.channels.list()`，默认全选）；右下「保存」「返回」。
- 保存：`desktopApi.scenarios.setApplicableChannels(id, ids)`（全选时存空=全部）。
- **抽公共多选下拉**：现多选下拉内联在 createBigAccountRow（2086-2189）。抽 `createFloatingMultiSelectDropdown({options, selected, onChange})` 复用，CSS 复用 `.new-account-currency-dropdown-*` / `.big-account-currency-floating-panel`（styles-gemini-extra.css:1554-1672）。

### 3.5 C 复制场景
- C1/C2/C3/C4 header（7434/7814/7128/8267 各一处，结构同）：在 `.icon-close` 前插入 `复制场景` 文本 + `选择` 按钮（`data-action="copy-scenario"`）。建议抽 header 渲染或统一注入。
- 新建 `createCopyScenarioDialog({ module, currentCategory })`：
  - 银行对账单处理：左窄下拉（银行渠道，`channels.list()`）+ 右宽下拉（该渠道下场景名，默认空）。
  - ReconID 修复：单下拉（同 currentCategory 的其他场景，默认空）。
  - 选定 → `desktopApi.scenarios.get(srcId)` → 深拷贝 `config` 灌入 `state.scenarioDraft.config`，关闭弹窗并刷新当前配置弹窗（C5 语义：不覆盖 name）。
- 数据：list 不含 config（scenarios-repository:111-126），需对选中项调 `scenarios.get`。

### 3.6 D-1 移除 extract-recon-id 新建选项
- ALL_CATEGORY_OPTIONS（6698-6704）删除 `{ value:'extract-recon-id', ... }`（6699）。
- 注意：openScenarioConfigByCategory（174-185）对 extract-recon-id→C1 的路由**保留**（builtin-fixed 执行需要，且历史场景查看/复制需要）。

### 3.7 B 文本
- renderer-dialogs.js:5535/5536（LABELS）、6700/6701（OPTIONS，6701 因 D-1 可能整项删除）。
- renderer.js:50（模块名去空格）；usage-stats.js:30 key（同步去空格，注意是否影响统计聚合 key 兼容）。

## 4. 收尾
- **preview 回归**：`preview:bank-statement-panel` `preview:scenarios-manager` `preview:scenario-config-c1~c4` `preview:recon-id-fix-panel` `preview:pending-panel`。新增弹窗（复制场景、写死场景管理）建议补 preview 入口（4 处登记：package.json scripts、render-modal-preview、renderer.js previewModal 分支、renderer-previews.js apply 函数）。
- **文档三件套**：CHANGELOG.md / docs/VERSION_FEATURE_HISTORY.md / docs/USER_GUIDE.md。
- **版本**：package.json → `2.1.13-beta.1`。
- **变量检查**：`npm run scan:vars` + `/check-vars`（版本 bump / 提 PR / 合并前）。
- **测试**：`npm run release-check`（unit + integration + smoke）。新增数据层/引擎逻辑补 unit；执行语义补 integration。

## 5. 重点回归（功能正确性）
1. 「从银行对账单提取对账ID」运行后仍能提取（C1 提取逻辑经 builtin-fixed 路由生效）。
2. 适用渠道多选后，对应渠道运行能命中该写死场景（若 §三确认跨渠道生效）。
3. 场景 bundle 导出/导入兼容 builtin-fixed + 多对多表。
