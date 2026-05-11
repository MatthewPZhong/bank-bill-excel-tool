# Changelog

## 2.1.0-beta.1 - 2026-04-30

新增 **第 5 个顶级模块「单据对账 ReconID 修复」**（C4 类场景）。基于 4 sheet xlsx（业务部门账单 / 对手部门账单 / 对账结果 / 订单修复模板）跑用户配置的对账场景，按 5 阶段算法（1v1 严格 → 1v1 ±1day → 池子 1v多 同日 → 池子 1v多 ±1day → 池子 多v1 同日 → 池子 多v1 ±1day）跑 7+5 条赋值规则后导出「订单修复」与「未匹配单据」双文件。整个迭代分 3 PR 实施（PR-A 骨架 / PR-B 对账引擎 / PR-D 收尾）。

### 新增

- **「单据对账 ReconID 修复」顶级模块**：`index.html` 增加第 5 个 module-panel + module-switcher 下拉项；4 按钮（场景管理 / 导入文件 / 开始运行 / 导出文件）+ 主面板「场景」单选下拉（控制行 1，「导入文件」与「开始运行」之间）+ statusBox 6 状态文案（初始/已选场景/已导入/已运行/已导出/empty 双文件 + warnings + unmatched 档）。
- **C4 类场景配置弹窗 `createScenarioConfigDialogC4`（5 行布局）**：行 1 场景名 / 行 2 单据匹配规则（3 勾选框，1v多 与 多v1 互斥）/ 行 3 账单类型（动态行：序号 + 主/从联动字段下拉 + 7 op 下拉 + ❌ + 「+ 新增」）/ 行 4 对账字段（动态行：分组 block + Amount 字段对锁定 + 组内 AND + 组间 OR + 「+ 新增字段对」/「+ 新增 OR 分组」）/ 行 5 修复结果输出（互斥勾选「主边/从边/主从都修复」+ 主从都修复展开共同 ID 区 `主.reconId + suffix` + SubBizType 三选一互斥：自动查 / 主边手填 / 从边手填）。
- **5 阶段算法（subset-sum 池子）**：`runC4Scenario(scenario, sheets) → { fixedRows, warnings, unmatchedRows, stats }`。Step 1 同 BillDate + 全部对账字段 AND 全等 1v1 严格；Step 2 BillDate ±1day 容错 1v1（多候选 4 阶 tie-break 选 1 + 双向一致性校验）；Step 3.1/3.2 池子 1v多（subset-sum + 其他对账字段 AND 全等 + size ≥ 2，subset-sum 多解 spread → distToMain → size → firstIdx 4 阶 tie-break，DFS 全遍历找全局最优 + 升序剪枝 + top-k 后缀剪枝 + 启发式提前终止 + hardCeiling=5M）；Step 3'.1/3'.2 池子 多v1 对称。BillDate 字段名主从 sheet 都叫 `BillDate`；浮点 Amount ×100 整数化避精度坑。
- **7+5 赋值规则**：mode='main'/'opp' 单边修复 R1-R7（R1 主边 1v1 / R2 主边 多v1 Type=2 / R3 从边 1v1 / R4 从边 1v多 / R5 主边 SubBizType 自动查 reconResult / R6 从边 SubBizType 自动查 / R7 主/从边 SubBizType 手填覆盖）；mode='both' 主从都修复 RB1-RB5（RB1 1v1 双 Type=0 + 共同 ID / RB2 多v1 主 Type=2 从 Type=0 / RB3 1v1 同 RB1 / **RB4 1v多 双 Type=0**（Round 3 修订，原主 0/从 2 → 双 0）/ RB5 SubBizType 复用主从单边路径）。
- **未匹配单据告警 report（Round 3 新增）**：算法跑完后未配主从行单独写 unmatched.xlsx（sheet 名「未匹配单据」+ 6 列：场景名 / 单据来源 / OrderId / BillDate / Amount / 未配原因），随主文件一并导出由 `recon-id-fix:export` IPC 一次返回 `mainFilePath + unmatchedFilePath`。文件名 P3-A/P3-B 修订（Round 5）：fixedRows 空 + unmatched 非空 → saveDialog 默认 unmatched 名（`单据对账修复-未匹配-{ts}-{name}.xlsx`），用户选什么就写什么；fixedRows + unmatched 都非空 → saveDialog 默认主名，unmatched 联动 `{用户主文件 stem}-未匹配.xlsx` 同目录。
- **4 个 IPC channel + preload 暴露**：`recon-id-fix:import` / `recon-id-fix:run` / `recon-id-fix:export` / `recon-id-fix:session-status`；preload 暴露 `desktopApi.reconIdFix.{import, run, export, sessionStatus}`。
- **资金红线 defense in depth（双层防御）**：第一层 — 4 个 `scenarios:*` IPC 入口主动按 category 分流清缓存（'recon-id-fix' 清 reconIdFixResult；C1/C2/C3 清 processingResult；未知 category 双清 + warn 兜底）；第二层 — `recon-id-fix:export` 入口被动校验 `scenariosSnapshot`（`stableJsonStringify` 递归按 key 排序避免 SQLite round-trip 误判 stale）+ run 时实写 snapshot；不一致 → 拒导出 + alert 让用户重新跑场景。`bank-statement:run` / `bank-statement:export` / dispatcher 入口 `filterOutReconIdFix` defense in depth 排除 C4。
- **C4 dialog Amount 字段对锁定（Round 3 新增）**：reconGroups 默认带 `Amount/Amount` 锁定 fieldPair 作为第一行，select disabled + 隐藏 ❌ 删除按钮；新增 OR 分组也默认带 Amount 锁定行；migration `migrateC4ReconGroupsAmountLockedFieldPair` 老库无损升级（3 路径：已含 locked → no-op / 含 Amount/Amount 但无 locked → 加 locked / 无 Amount/Amount → 头部插入锁定行）。
- **scenarios 表 CHECK 约束扩 4 值 + reconGroups 数据迁移**：CHECK `category IN ('extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'recon-id-fix')`（migration `ensureScenariosCategoryReconIdFix` 走 RENAME-CREATE-INSERT-DROP-COMMIT 重建表，幂等）+ migration `migrateC4ReconGroupsStructure`（PR-B Q1=B 决策回写：reconFields[] → reconGroups[]，按 leftTypeSeq+rightTypeSeq 聚合 fieldPairs，仅扫 category='recon-id-fix'，幂等三连 smoke 验证）。
- **类别选择对话框扩四选一**：`createScenarioCategorySelectDialog` 三选一扩四选一，新增「单据对账 ReconID 修复」选项 + 类别图标 + 副标题。`createScenariosManagerDialog` 「功能类别」列文案映射追加 `'recon-id-fix' → '单据对账修复'`；编辑/查看时类别 → dialog 路由（`renderer-dialogs.js:65-67`）追加 `'recon-id-fix' → createScenarioConfigDialogC4`。
- **fixture 入库**：`samples/单据对账导出不平.xlsx` / `samples/单据对账导出不平-对平例子.xlsx`，便于真实 fixture 回归（基金 80/30/50/0 / FX 中台入金 96/36/60/18 / FX 入账 113/44/69/25）。
- **3 个新 preview**：`recon-id-fix-panel` / `scenario-config-c4` / `scenario-config-c4-both`（`scripts/render-modal-preview.js` 注册）。

### 变更

- **版本号**：`2.0.0` → `2.1.0-beta.1`。
- **`scenarios.category` CHECK 约束**：3 值 → 4 值（新增 `'recon-id-fix'`）；老库无损迁移由 `ensureScenariosCategoryReconIdFix` 处理。
- **`scenarios-repository.js: VALID_CATEGORIES`**：3 → 4；`updateScenario` 显式拒绝改 `category` / `is_builtin`（self-review round 3 P3-B）。
- **renderer state 扩展**：`state.reconIdFix{Session,Result,Export,SelectedScenarioId,Scenarios}` 5 字段；`MODULES.reconIdFix = 'recon-id-fix'`；`elements` 缓存 6 个新 DOM；`setCurrentModule(moduleId)` 加分支调 `reloadReconIdFixScenarios()`。
- **`scenario-dispatcher.js`**：dispatcher 入口加 `filterOutReconIdFix` 过滤（C4 不走 first-match-wins 调度）+ 返回 stats 加 `skippedC4Count`（资金红线 defense in depth）。
- **使用统计**：`src/backend/usage-stats.js: FUNCTION_REGISTRY` 加 C4 模块（5 项 IPC + 4 按钮埋点）。
- **smoke 增量**：scripts/smoke 新增 `migrations-recon-id-fix`（15 用例）/ `recon-id-fix-engine`（43 用例）/ `recon-id-fix-io`（13 用例）/ `recon-id-fix-ipc-handlers`（20 用例）/ `recon-id-fix-end-to-end`（6 用例）/ `recon-id-fix-scenario-ipc`（11 用例）合计 **272 PASS**（v2.0.0 GA baseline 78 + Pending/scenarios 既有 + v2.1.0 新增 ~115）。

### v2.1.0-beta.1 PR 汇总

- **PR-A 骨架（PR #35，merged 2026-04-30，commit `6e5ebaf`）**：模块入口可达 + 场景 CRUD + DB schema 扩展（CHECK 4 值 / VALID_CATEGORIES / current_module 持久化）+ C4 dialog 5 行布局（含 Amount 锁定 + 4 数据完整性校验）+ 类别选择四选一 + 资金红线分流（4 个 scenarios:* IPC 按 category 清缓存 + dispatcher filterOutReconIdFix）+ 18 用例 smoke。9 task / 35 改动文件。
- **PR-B 对账引擎（PR #36，merged 2026-05-09，commit `844d1d5`）**：4 sheet IO + 5 阶段算法 + subset-sum 池子（DFS 全遍历 + 4 阶 tie-break + 双向一致性 + 浮点精度修复）+ 7+5 规则 + 4 个 recon-id-fix:* IPC + unmatched 双文件输出 + scenariosSnapshot stableJsonStringify defense in depth + reconGroups Q1=B / commonId Q2=a 决策回写 + Amount 锁定 Round 3 + Round 4 subset-sum 重写 + Round 5 Step 2 多候选 tie-break + 用户用例 FTA202604280200028 ↔ 202604271439325696974017228 命中验证。16 task / 28 改动文件 / 7 轮 review（Round 1-5 + Codex round 1-4 + self-review round 5）。
- **PR-D 收尾（本 PR）**：版本号 bump + 文档三件套 + 整体 smoke / preview / check-vars / scan-vars 回归。5 task。
- ~~**PR-C 识读规律**（已取消，2026-05-09）~~：dev round 1 完成（278/278 PASS）+ 用户测试发现 alert 关闭后误回主页面 bug；修复后用户改变需求决定整体取消。工作树 PR-C 改动全部回退；§三 D7 / §六 F3 识读按钮段 / §七.1 识读按钮段 / §七.4 识读规律算法 / §十.2 识读误判风险等章节标 DEPRECATED 保留历史决策痕迹。

## 2.0.0 - 2026-04-30

v2.0.0 GA 正式版（去 beta）。本版本为 v2.0.0-beta 系列收官，包含 beta.1 ~ beta.4 全部产物 + 本次 beta.4 两项收尾功能。

### 新增（v2.0.0-beta.4）

- **错误报告加「可能原因」列**：3 个模块（生成网银账单 / 月度 Pending / 银行对账单处理）的 error-report 文件统一加「可能原因」字段，文案口语化（如 `多个字段抓到的对账ID不一致，无法判断该用哪个` / `一对多匹配，可能有重复数据`）。统一映射表 `src/backend/file-service/error-causes.js` 覆盖 22+ 已知 code，未知 code fallback `未知错误`。
- **隐藏 `.usage-stats.txt`**：`~/Documents/网银账单生成小助手/.usage-stats.txt`（dot prefix 隐藏）记录软件打开次数 + 各模块各功能使用次数 + 模块小计 + 总操作次数。`关闭时 flush + 每 5 分钟自动 flush` 混合写盘，原子写入（tmp → rename）。

### 变更（v2.0.0-beta.4）

- **版本号**：`2.0.0-beta.3` → `2.0.0`（GA 正式版，去 beta）。
- **所有导出表头字号统一 10pt**：4 处 writer（exceljs-writer.js / pending-export/writer.js / pending-session.js / writers.js 已既有）；pending-session.js 从 `xlsx`（CE）切到 `xlsx-js-style` 以支持 styles 写出。
- **使用手册另存为简化**：仅保留 `.html` + `.txt` 两种格式，默认 HTML（filter 第一项 + `defaultPath '使用手册.html'`）；去除 `.md` 选项（用户决策——使用手册不应让用户拿到原 markdown）。
- **smoke 增量**：scripts/smoke 新增 `error-causes`（39 用例）+ `usage-stats`（40 用例），合计 157 PASS。

### v2.0.0 GA 系列总览（beta.1 → beta.4 全部产物）

- **beta.1**：模块切换器（3 选 1）+ 月度 Pending 数据核对模块（独立 SQLite + 31 列固定表头 + 多文件合并导入 + 行级 hash 去重 + benchmark 外推预计时间）
- **beta.2**：页面风格切换（Clear / General）+ 双套 CSS + dialog factory 双风格适配
- **beta.3**：银行对账单处理模块（C1/C2/C3 三类场景 + first-match-wins 调度 + xlsx 标黄输出 + 4 dialog factory + 用户样例 dry-run + UX 8 项调整）
- **beta.4**：本次

## 2.0.0-beta.3 - 2026-04-29

新增**银行对账单处理模块**：导入银行对账单 xlsx → 配置场景规则 → 自动 first-match-wins 调度 → 标黄输出修改单元格。整个模块横跨 4 个 PR（#29 数据底座 / #30 模块入口 + 场景管理 / #31 算法引擎 / #32a 调度+IO+IPC / #32b 配置弹窗 + 闭环 + 发版）。

### 新增

- **「银行对账单处理」顶级模块**：`index.html` 增加第 4 个 module-panel + module-switcher 下拉项；4 按钮（场景管理 / 导入文件 / 开始运行 / 导出文件）+ statusBox 5 状态文案（初始/已导入/已处理/已导出 4 主态 + skip/error tone）。
- **3 类场景调度器（C1/C2/C3）**：first-match-wins 全局行锁；按 `priority desc, id asc` 排序；同一行被高优先级场景锁后，低优先级跳过；返回 `{ modifiedRows, modifications, errorReport, stats: { totalRows, hitRowCount, scenarioHitCount, hitScenarioIds, warningCount, skippedC3Count } }`。
- **C1 场景（提取ReconId-From Self）**：根据特征/其他字段提取 ReconciliationId（条件 + 特征码 + 数字位数 + 总长度 / 复制其他字段值）；多字段值不一致 → error-report，不写入。
- **C2 场景（账单打标）**：双类型行配对（一一对应同 CustomerRef + Credit==Debit）；一对多 / 多对一 → error-report；正常配对 → 双方都进 lockedRowIds，rightType 行字段被打标。
- **C3 场景（提取ReconId-From 网关）**：与「资金对账不平结果表」按 4 字段 AND 匹配（含发生额绝对值虚拟字段）；多匹配取首条 + warn；未导入 gw 文件时整类被过滤 + skippedC3Count 提示。
- **3 个内置场景（默认存在，可编辑、可禁用、可删除；不提供"恢复出厂"）**：`从银行对账单的信息里提取对账ID`（C1，启用）/ `outbound改标为outbound Fail`（C2，启用）/ `与网关对账单根据金额币种一对一匹配对账ID`（C3，禁用）。
- **6 列场景管理表（CRUD + toggle）**：`序号 / 功能类别 / 场景名称 / 优先级 / 执行操作 / 是否启动`。toggle 实时写库；序号取最小未用 ID（gap-filling）；内置场景可编辑、可禁用、可删除（不提供"恢复出厂"）。
- **4 个场景配置弹窗**：`createScenarioConfigDialogC1 / C2 / C3 / createScenarioConfirmDetailDialog`（创建/编辑/查看三模式共用）；状态由 renderer-side `state.scenarioDraft` 跨弹窗共享。
- **xlsx 标黄输出**：仅命中场景的行入主输出，被修改的单元格用 exceljs 黄底（FFFFFF00 ARGB）；非修改行不导出。文件命名 `银行对账单-YYYYMMDDHHmm-处理结果.xlsx`（统一格式，不含场景名）；用户通过原生 saveDialog 选保存路径（另存为）。
- **error-report 独立产物**：warnings 单独 xlsx 落 `Documents/网银账单生成小助手/bank-statement-process/{date}/{ts}-error-report.xlsx`，与主输出独立（即使 modifiedRows 为空也会写）。
- **44 列银行对账单 + 31 列资金对账文件 schema**：列名固定，导入时严格校验顺序与列名；任一不一致 → invalid 状态返回 detailLines 提示用户。
- **5 个 IPC channel**：`bank-statement:import` / `gateway-recon:import` / `bank-statement:run` / `bank-statement:export` / `bank-statement:session-status`，全部走 main 进程内存 session（不持久化）。
- **scenarios 表 + 6 IPC channel**：`scenarios:list / get / create / update / delete / toggle-enabled`；`scenarios-repository.js` 提供 CRUD + `calculateNextScenarioId`；migrations 含 builtin seed + 名称同步迁移 `ensureBuiltinScenarioNamesUpdate`（处理 v2.0.0-beta.3 内部场景重命名）。
- **资金对账文件提示时机**：导入银行对账单成功后，若启用了 C3 类场景且未导入 gw 文件 → 立即弹 confirmDialog 询问"导入文件 / 稍后再说"。

### 变更

- **版本号 bump**：`2.0.0-beta.2` → `2.0.0-beta.3`。
- **状态框文案**（renderer.js `updateBankStatementUi`）：5 状态优先级（已导出 > 已处理 > 已导入双文件 > 已导入单文件 > 初始）；已导入/已导出标签后内容换行展示（CSS `#bankStatementStatusBox .status-box-text { white-space: pre-line }`）；命中场景以序号显示在 `（场景 1、3）`；skipped C3 提示并入状态框（` · 跳过 N 个对账不平场景`）。
- **运行 / 导出成功 不再弹 alert**：内容直接写入状态框；failed / cancelled 仍走 alert。

### 移除

- **覆盖原 ID warning 删除**：C1 `overwrite-existing-recon-id` + C3 `overwrite-existing-value` 不再产生 error-report 记录（用户 UX 决策：原值非空被覆盖时直接覆盖，无 warning 痕迹）。⚠️ 资金红线提醒：dispatcher first-match-wins 若导致非预期覆盖，将无追溯痕迹，需依赖 modifications 列表本身追踪。

### 测试

- **smoke 78/78 PASS**：scenario-engines 23 + scenarios-repository 5 + scenario-dispatcher 11 + exceljs-writer 3 + bank-statement-io 13 + scenario-end-to-end 23（PR #32b 新增 E2E）。
- **E2E smoke**：mock bankRows + gwRows + 3 场景 → dispatcher → exceljs writer → 读回 xlsx 验证 ReconciliationId / FundType 写入 + 黄底；first-match-wins / skippedC3Count / error-report 路径独立全覆盖。

## 2.0.0-beta.2 - 2026-04-28

新增 **页面风格切换**（`Clear` / `General` 二选一），默认 Clear。设计稿来自 `Clear/` 38 份 HTML（Claude Design）。整个迭代分 6 阶段实施：数据底座 → HTML 重构 → CSS 双套切换 → UI 切换器 → dialog factory 适配 → preview 双风格。

### 阶段 1：数据底座 + 版本号 bump

- **新增 SQLite `app_settings.ui_style` 字段**：键值对存储 UI 风格（`'Clear'` | `'General'`），默认 `'Clear'`。`src/backend/database/settings-repository.js` 新增 `getUiStyle / setUiStyle / ensureUiStyleDefault`；`src/backend/database.js` facade 暴露同名方法。
- **升级迁移 `ensureUiStyleDefault`**：`src/main.js` 在 `database.init()` 后调用，若 `ui_style` 不存在则写 `'Clear'`（D4：升级用户首次启动强制切 Clear）。
- **新增 IPC `settings:get-ui-style` / `settings:set-ui-style`**：`src/main.js:registerAppHandlers` 注册；`app:get-info` 返回体加 `uiStyle` 字段（renderer 启动时一次拿，避免二次 IPC roundtrip）。
- **preload 暴露 `desktopApi.settings.{getUiStyle, setUiStyle}`**：`src/preload.js` `contextBridge.exposeInMainWorld` 加 `settings` namespace。
- **版本号 bump**：`package.json.version` `2.0.0-beta.1` → `2.0.0-beta.2`（按 PRD-v2.0.0-beta.2 §三 D12：spec 锁定后第一次 commit 时 bump）。

### 阶段 2：HTML 结构对齐 Clear

- **`index.html` 基线整体重写**：DOM 结构对照 Clear/main.html、pending.html 重组（保留主面板 / Pending 面板 / 新开账户面板 三个 module-panel + module-switcher 下拉）；同时保留猫猫 GIF（D8 决策）。
- **新增"切换页面风格"调色板下拉 + 应用按钮**：`<select id="paletteStyleSelect">` + `<button id="paletteStyleConfirmBtn">应用</button>`，从调色板面板顶部入口（`palette-panel-style-row`）触发风格切换。

### 阶段 3：双风格 CSS 切换机制（D15 简化方案）

- **三 link 切换**：`<link id="cssGeneral">` + `<link id="cssClear">` + `<link id="cssClearExtra">`，`cssGeneral.disabled / cssClear.disabled / cssClearExtra.disabled` 三状态布尔切换实现完全 cascade 隔离（D15：放弃 PRD 原方案的"全 selector 加 `body[data-style]` 前缀"双保险，工作量减少 ~80% 安全等价）。
- **退化规则**：`src/styles.css` 末尾追加 5 类条件渲染节点的 General 退化（`.gemini-gradient` 重置 / `.status-spark display:none` / `.module-switcher-icon::before content:"🔁"` / `.select-shell display:contents` / `.alert-body display:contents` + `.alert-icon display:none`）。
- **`applyUiStyle(style)`**：`src/renderer.js` 新增；启动时 `info.uiStyle` 决定初始；用户切换时 `desktopApi.settings.setUiStyle` 持久化 → applyUiStyle 立即切（不 reload）。
- **D16 风格-背景色联动**（reverse sync）：`CLEAR_BACKGROUND_COLOR = '#ffffff'` vs `DEFAULT_BACKGROUND_COLOR = '#efe8da'`；`ensureBackgroundColorMatchesStyle()` 启动时仅当 colorHex 是"另一风格默认色"（魔法值）时重置，不覆盖用户自定义颜色。阶段 4 用户主动切风格时同样应用。

### 阶段 4：UI 切换器 + 提醒框

- **调色板"切换页面风格"下拉 + "应用"按钮**：`handlePaletteStyleConfirm` 弹 `createConfirmDialog`（D9 二次确认）；取消回滚下拉值（D10）；确认后写 SQLite + applyUiStyle + 联动背景色。
- **状态保持**：`updateStatusBox` / `setStatus` / `setNewAccountStatus` / `setPendingStatus` 全部改为写 `.status-box-text` 子节点（避免 `.textContent` 整体覆盖清掉 `.status-spark` SVG 装饰）。
- **每次打开调色板时下拉重置为 Clear**（D5）：`openBackgroundPalette` 强制 `paletteStyleSelect.value = 'Clear'`；改下拉但不点确认 → 关闭面板不写 DB。

### 阶段 5：dialog factory 双套适配（增量收尾）

由用户增量"怪怪的"反馈驱动的循环修复，多 commit 累计。涉及：

- **alert/confirm 类**：`createAlertDialog` / `createConfirmDialog` / `createExportScopeDialog` / `createRememberOrderMismatchDialog` 加 `.alert-body` 包裹 + Clear SVG 圆圈/三角警告图标；General 风格通过 `alert-body { display:contents }` + `alert-icon { display:none }` 退化。
- **多币种下拉 / Currency picker** Clear 适配。
- **拆分/合并账单 picker**：勾选合并账单后右侧"请选择账单序号"下拉框 Clear 样式补全；按字段区分发生额单选下拉框对齐上方下拉框左缘。
- **大账号选择 + 顺序提取对话框**：renderer 输出 dual-class（src 长名 + 设计师短名），删除 styles-gemini-extra.css 内冲突的长名 alias（cascade 后定义胜，避免覆盖设计师原版）；确认大账号顺序弹窗 DOM 重写为扁平 `.extract-order-body / .extract-order-row / .eo-idx / .eo-name / .text-action.eo-edit`，1:1 对齐 `Clear/extract-order.html`。
- **维护大账号币种行**：Clear css 补 `.big-account-currency-editor` flex row + ghost transparent border + 表格 `table-layout: fixed` 列 40/30/30%（消除编辑/view 切换列位移）；输入框宽 70px，多币种 dropdown 160px。
- **Pending 模块面板 + 系列对话框**（reconcile / export / rule confirm / import month）Clear 风格补全。
- **执行操作列 4 个 dialog 列宽固定**：`.manager-card / .account-card / .bill-split-rows-table` 全部加 `table-layout: fixed`；按钮组容器（`.manager-row-actions` / `.big-account-row-actions` / `.row-actions` / `.account-mapping-action-cell` / `.bill-split-row-actions`）改左对齐 + 第一个按钮 `padding-left: 0`，让"修改"按钮左缘对齐"执行操作"列头文字左缘。
- **映射关系管理 Clear 布局对齐 General**：表格 `table-layout: fixed` 30/70 列宽；`.mapping-field-editor` 改 flex row + flex-wrap，`.mapping-select` flex:1 让按钮回 select 右侧同行，`.concat-field-picker` flex-basis:100% 强制换行到独立行。
- **主面板模板管理 / 账户映射按钮分布**：button-stack 加 `flex-wrap:nowrap` + max-width:260（与 select 等宽），两按钮 `flex:1 / min-width:0` 等分；`padding-right:14px` hack 让账户映射按钮右缘对齐 select caret 右缘。
- **新开账户行操作按钮**：新增 = 蓝色 / 删除 = 红色。
- **Clear 调色板尺寸**：选取颜色框对齐 General 大小。
- **Clear 风格右下角 Version 字体**：改 Courier New 等宽。
- **小细节**：`.bill-split-sub-row label` selector 修正（原 `.bill-split-sub-label` 与 renderer 输出不匹配，导致两行下拉框未对齐）；定位大账号搜索框宽度 200px 重新声明（被 `.mapping-text-input` 兜底 width:100% 覆盖修复）+ `margin-left: auto` 让搜索框组推到 footer 右下角。
- **死代码删除**：`legacyCreateBigAccountManagerDialog` + `legacyCreateTemplateManagerDialog`（共 -444 行）；其余 17 个 legacy 函数因运行时间接依赖未删（grep 匹配虽为 0 但实测点击失效，已回滚）。

### 阶段 6：preview 双风格适配

- **`render-modal-preview.js` / `render-preview.js` / `render-account-mapping-preview.js` / `render-template-manager-preview.js` 4 个脚本支持 `APP_PREVIEW_STYLE` env**：默认（或 `clear`）→ `docs/previews/<name>.png`；`general` → `docs/previews/_general/<name>.png`。
- **`src/main.js` preview 模式注入 ui_style**：`database.ensureUiStyleDefault()` 之后若 env `APP_PREVIEW_STYLE` 存在则 `setUiStyle` 强制覆盖。
- **双风格 35×2 截图全量产出**：`npm run preview:all` 默认跑 Clear，`APP_PREVIEW_STYLE=general npm run preview:all` 跑 General。

### 实施记录文件

- `docs/iterations/v2.0.0-beta.2/PRD-v2.0.0-beta.2.md` 877 行（v1 定稿，OT-1 ~ OT-7 全部 closed + 16 决策 D1 ~ D16 + 23 验收 AC + 6 阶段实施计划）
- `docs/iterations/v2.0.0-beta.2/TechDoc-v2.0.0-beta.2.md` 578 行（§4.3 D15 简化方案重写）

## 2.0.0-beta.1 - 2026-04-23

- **顶部模块切换按钮改下拉（3 选 1）**：`index.html` 的 `moduleSwitcherMenu` 追加第 3 项 `月度 Pending 数据核对`；`src/renderer.js:MODULES` 扩 `pendingReconciliation`；`setCurrentModule` 从二选改三选（按 id 查字典取 name + 三 panel 联动）。首次启动默认 `网银账单生成`，切模式不持久化（关闭重开仍默认首项）。
- **新增顶级模块「月度 Pending 数据核对」**：完整链路 `导入 → 入库 → 规则化对账 → 差异落库 → 导出 xlsx`，用户每月比对"上上月"与"上月"两份 Pending 数据自动找出 `new / missing / changed` 三类差异。布局两行：第一行 `规则管理 / 导入文件 / 开始运行`；第二行 `导出差异 + 状态框`。独立于现有"网银账单生成"和"新开账户余额账单生成"模块，零改现有业务逻辑。
- **独立 SQLite 数据文件 `tool-data-pending.sqlite`**：避免污染主 DB。`src/backend/pending-db.js` 门面 + `pending-db/migrations.js` 幂等 5 表（`rule` 单行全局 / `pending_months` / `pending_rows` 含 31 列中文原名 + row_hash / `diff_runs` / `diff_rows`）+ 5 索引（`idx_pending_rows_hash UNIQUE(year_month, row_hash)` 等）。启动序列 `openPendingDb(userDataDir)` try-catch 不阻塞主流程。
- **Pending 模板 31 列固定表头**（`assets/Pending.xlsx`）：`pending类型 / pending资金类型 / 账单类型 / billDate / valueDate / 平账账期 / 业务BU / 对手业务BU / 财务BU / 主体 / 对账类型 / recon_id / 金额 / 币种 / order_no / acc_id / finish_time / 穿透ID / channel / merchant_id / bank_ref / 对账明细ID / 对账单ID / PendingBizId / 备注 / 计算金额 / 计算币种 / 是否拆分Pending / 穿透节点ID / 业务部门（流水）/ 主体（流水）`。关键列 `pending资金类型` 允许任意文本（含空值；**OT-9 初稿的 {提现/退票/充值} 枚举校验在 2026-04-24 Reverse Sync 中撤销**，原因：真实样本出现 `入金` 等其他值，枚举不可穷举；导出差异按实际值动态分 sheet）。
- **规则管理（单条全局）**：`规则管理` 按钮弹两 `<select multiple>` 下拉（对账字段 + 对账内容，选项来源 31 列表头）。对账字段至少选 1 项；对账内容可空（空时 changed 恒 0）。保存走"完成 → 二次确认 → upsert"，`rule` 表单行（`id = '__GLOBAL__'`）。历史差异 record 保存"规则 JSON 快照"（`diff_runs.rule_snapshot`）做回溯，不影响新运算。
- **多文件合并导入（child process + ExcelJS 流式 INSERT + 留底 + 行级冲突检测）**：`src/backend/pending-import/worker.js` 是 xlsx 解析 child process 入口，`src/main-process/pending-session.js` 主进程 spawn 时带 `--max-old-space-size=8192`。**xlsx 解析库用 `exceljs@^4.4.0`**（原 `xlsx@0.18.5` 对 30 万行 + inline string 大文件读取为空，Reverse Sync 切换 ExcelJS）。多文件选完 → 弹年月选择 → worker 严格校验每个文件表头（顺序 + 内容，任一不一致整批拒绝）→ **流式 INSERT**（边读边写 DB，不在内存累积 allRows；跨文件 hash 去重 Set 占 ~120MB / 300 万行）→ 全月行级 hash 冲突整批 rollback 并缓存错误（错误上限 1000 条防 emit 巨型 JSON 撑爆 stdout 管道）；状态框支持"点击导出报错文件"（xlsx 格式，schema = source_file / sheet_row / severity / message + 31 原列）。worker 事件流 progress / error / complete，主进程 `webContents.send('pending:import:progress', ev)` 转发到渲染层状态栏实时显示"正在导入 {YYYY-MM}：{file}（累计入库 N 行）"。
- **覆盖前自动留底 xlsx**：同月重复导入 → 弹"{year}-{month} 已有 N 行数据"确认框；确认覆盖前先把旧月全行导出为 `Documents/网银账单生成小助手/pending-archives/{YYYY-MM}/{YYYY-MM}-backup-{YYYYMMDDThhmmss}.xlsx`（`src/main-process/pending-session.js:archiveExistingMonth`），然后 worker 内 `BEGIN → deleteMonth → 批量 INSERT → upsertMonthMeta → COMMIT`，失败 `ROLLBACK`。
- **对账引擎（资金敏感红线）**：`src/backend/pending-reconcile/engine.js:runReconciliation` 三段 SQL：
  - `new`: lower 有 + upper 无（`NOT EXISTS`）
  - `missing`: upper 有 + lower 无（`NOT EXISTS`，对偶）
  - `changed`: INNER JOIN on matchFields + compareFields 任一 `IS NOT`
  - match 阶段用 `=`（**v2.0.0-beta.2 Reverse Sync**：原设计用 `IS` 做 NULL-friendly；实测 EXPLAIN QUERY PLAN 下 `IS` 和 `=` planner 生成相同 SEARCH COVERING INDEX 计划，但 `=` 语义明确不依赖启发式。语义变更：match key 为 NULL 的行**不再匹配另一 NULL 行**—— 业务上 match key 缺失本就是无效对账行）。compare 阶段 `changed` 保留 `IS NOT`（row 级 filter 性能影响小，保留 NULL-safe 语义）；`ensureMatchIndex` lazy `CREATE INDEX IF NOT EXISTS`（名字用 matchFields 的 SHA-1 哈希，避免长名）。`changed` 按值严格相等（字符串 `===` 比较，OT-8 不做 hash；`金额="100.00"` vs `金额="100"` 视为不等，由规则设计者保证上游数据清洗一致）。
- **benchmark 性能修复**：`src/backend/pending-reconcile/benchmark.js:estimateRunTimeMs` 采样 SQL 前先调 `ensureMatchIndex` 建 `(year_month, matchFields)` 复合索引（否则 121 万行 × 121 万行 NOT EXISTS subquery O(n²) 全表扫描，实测卡 15+ 分钟）。建索引 ~2 秒，之后 reconcile 采样 ~0.4 秒。真实样本 243.68 万行实测对账 **2.85 秒**（PRD 目标 < 1 分钟，超 22×）。
- **相邻月校验（跨年也算相邻）**：开始运行弹窗选两月份 → 二次确认 → 相邻校验（`2025-12 ↔ 2026-01` 算相邻）；不相邻弹 alert 并重开弹窗保留已选值。
- **benchmark 预计时间**：`src/backend/pending-reconcile/benchmark.js:estimateRunTimeMs` 固定取样 10000 行 NOT EXISTS JOIN，`(total/sampleRowsActual) × sampleMs` 线性外推（精度 ±20%）。状态栏显示"正在对账 {lower} vs {upper}，预计 {N} 秒..."。
- **差异 xlsx 导出（单月选 run / 汇总取最新 run）**：`src/backend/pending-export/writer.js:exportSingleRun + exportAggregate`。
  - 单月：`Sheet1 = 汇总`（31 原列 + `diff_type` + 按规则 compareFields 动态展开的 `{col}_before` / `{col}_after`，共 31 + 1 + 2n 列）+ `Sheet2~N` 按 `pending资金类型` 实际出现值动态分 sheet（OT-9 枚举约束保证只会有提现/退票/充值）；`changed` 行 31 原列用 lower / `_before` 填 upper 值 / `_after` 填 lower 值；`new` 行 31 列用 lower / `_before`、`_after` 为空；`missing` 行 31 列用 upper / `_before`、`_after` 为空。
  - 汇总：每 `(upper, lower)` 对取最新 run；`Sheet1 = 按月维度区别汇总`（最老 → 最新，空行 + 月份 label 隔开）+ `Sheet2 = 汇总`（扁平）。compareFields 取所有 run 的**并集**展开为列，某 run 缺失的列留空。
  - 表头第 1 行字体写死 `Courier New`（延续 v1.5.3 R3 `applyHeaderRowFont`，数据区字体不变，**无 CJK 回退链**）；sheet 名字走 `sanitizeSheetName` 防非法字符。
- **资金敏感修复：diff_runs 排序 tie-breaker**：`src/backend/pending-db/diff-repository.js` 的 `listAllRuns / listRunsForMonthPair / getLatestRunForMonthPair` `ORDER BY created_at DESC` 末尾加 `, id DESC`。原因：`new Date().toISOString()` 毫秒精度；同毫秒多次 run 时单列 ORDER BY 不稳定，用户"导出最新 run"可能误取旧 run。AUTOINCREMENT id 单调，作为第二级稳定排序后 pending-reconcile 测试连跑 5 次 23/23 全绿（此前偶发失败）。
- **新增 IPC + preload 暴露（15 个）**：`pending:columns` / `pending:rule:{get,save}` / `pending:months:list` / `pending:import:{pick-files,start,progress}` / `pending:error:export-report` / `pending:reconcile:{benchmark,run}` / `pending:diff:{runs-list,runs-for-month-pair,latest-run-for,export-single,export-aggregate}`。`src/preload.js` 挂 `window.desktopApi.pending = { getColumns, getRule, saveRule, listMonths, pickFiles, startImport, exportErrorReport, onImportProgress, reconcile: { benchmark, run }, diff: { listAllRuns, listRunsForMonthPair, getLatestRunForMonthPair, exportSingle, exportAggregate } }`。

### 变更

- **renderer state 扩展**：`state.pending = { rule, months, latestRunResult, latestRunId, importing, importingText, currentYearMonth, running, runningText, errorReportAvailable, errorMessage, lastImportSummary, errorReportPath }`。状态栏文案分支覆盖：未设置规则 / 已设置无数据 / 已导入未运行 / 导入中 / 导入成功 / 对账中 / 对账完成（有差异 / 无差异）/ 报错（表头 / 重复行 / 资金类型不合法 / 其他行级）。报错态下状态栏挂 `.is-clickable` + `data-tone="error"` → 鼠标手势反馈 + 边框色变红（复用 v1.5.3 `styles.css:361,374` 约定）；导入/对账成功挂 `data-tone="success"`。
- **资源打包**：`assets/Pending.xlsx` 通过 `electron-builder.files: ["assets/**/*"]` 自动打进安装包，运行时读取其第 1 行作为 31 列常量缓存（`pending-db/columns.js` Object.freeze，启动时读一次整个会话期间不刷新）。
- **版本号 bump**：`package.json.version` 从 `1.5.3` → `2.0.0-beta.1`。
- **依赖新增**：`exceljs@^4.4.0`（仅 Pending 模块 worker 读 xlsx 用；现有两个模块继续用 `xlsx` + `xlsx-js-style`）。
- **测试脚本新增 5 个**：`test-v2.0.0-pending-import.js`（21 断言 / 7 场景）/ `pending-session.js`（19 断言 / 5 场景）/ `pending-reconcile.js`（23 断言 / 7 场景，含 T1 手工 4×4 资金敏感样本）/ `pending-export.js`（22 断言 / 2 场景）/ **`pending-perf-real-sample.js`（15 断言 / 6 场景，真实样本 243.68 万行端到端）**。`package.json` 加对应 `test:v2.0.0:pending-*` script。

### 风险与回滚

- **资金敏感**：Pending 数据含金额 / 币种 / 资金类型。本次实现已用"覆盖前留底 xlsx"缓解误覆盖风险；"最新 run"排序加 tie-breaker 防止导出错数据。
- **数据回滚**：删除 `{userData}/tool-data-pending.sqlite` 即可清空 Pending 模块全部数据（主 DB 不受影响）。
- **代码隔离**：Pending 模块全部代码在 `src/backend/pending-db/` / `src/backend/pending-import/` / `src/backend/pending-reconcile/` / `src/backend/pending-export/` / `src/main-process/pending-session.js` / `src/renderer-pending.js` 新文件，主 DB 代码零改动。

## 1.5.3 - 2026-04-22

- **主页面「模板」下拉改为「模式」**：`index.html:47` 的 `<label>` 文本由「模板」改为「模式」；下拉值域收窄为两条——`制作网银账单`（默认选中，内部隐式固定为 `__FILENAME_MAPPING__`）和 `导出月度余额账单`（R1 新增）。真实模板与虚拟 ID 不再出现在主页面下拉，仅在「导出月度余额账单」模式的弹窗内出现（`src/renderer.js:updateTemplateSelect`）。`__FILENAME_MAPPING__` / 具体模板选择 / v1.5.2 行为在「制作网银账单」模式下完全保留。
- **新增「导出月度余额账单」模式**：在该模式下点击「导出余额」弹出 `createMonthlyBalanceExportDialog`（`src/renderer-dialogs.js`），含标题「请选择需要导出月度余额账单的银行渠道」+ 模板下拉（`全部银行渠道` 默认选中 + 普通模板列表）+ 年月选择器（年份范围 = 近 10 年 ~ 今年+1；月份必须主动选）+ 完成按钮。完成后后端走 `monthly-balance:assemble` 装配 records 并写入临时 xlsx，再由 `monthly-balance:export` 弹系统保存对话框另存；文件命名 `月度余额账单-{模板名 or "全部银行渠道"}-{YYYY-MM}.xlsx`，单文件单 sheet 合并全部模板/大账号/币种。
- **月度余额装配规则（Q2 最新余额定义）**：对每个大账号 × 币种，优先取 `billDate === 月末最后一日` 的 seed；无则按 `billDate ≤ 月末最后一日` 取最大的一条（兜底）；全部 seeds `billDate > 月末` 或完全无 seed → **跳过该大账号**（不报错）。表头固定取自 `assets/余额账单模版.xlsx`，模板未提供的字段空字符串补位。详见 `src/main-process/monthly-balance.js:assembleMonthlyBalance + toBalanceRows`。
- **按钮可用/禁用矩阵**：`导出月度余额账单` 模式下 `importFileBtn / exportDetailBtn / accountMappingBtn` 置灰禁用；`importTemplateBtn / manageTemplateBtn / exportBalanceBtn` 可用。`setExportAvailability` 在月度余额模式下短路返回，避免外部调用误覆盖按钮状态（`src/renderer.js:applyStatementModeSideEffects`）。
- **自有账号合并入大账号表**：`template_big_accounts` 表新增列 `account_nature TEXT NOT NULL DEFAULT 'client'`（取值 `'client' | 'own'`；`src/backend/database/migrations.js:ensureTemplateBigAccountNatureSupport`）。`parseBankAccountExcel` 返回值保持不变，但「维护大账号」对话框 tbody 现同时渲染 `clientAccounts + ownAccounts`（UI 不加颜色/标识区分，仅在 tr 的 `dataset.accountNature` 携带）；view 态下 `own` 行在 merchantView 前加 `[自有] ` 前缀（不写进 input 值）。`saveMappings` 落库时透传每条 `accountNature` 字段，白名单校验 `'client' | 'own'`，非法/缺省默认 `'client'`。
- **§3.1 自有账户隔离规则（跨需求一致性约束）**：自有账户**仅在 R1「导出月度余额账单」场景参与**，其它场景一律过滤。实现：`getTemplateBigAccounts(db, templateId, { includeOwn = false } = {})` 默认 `includeOwn=false`，R1 装配链路显式传 `{ includeOwn: true }`。`listTemplates / getTemplate / listChildTemplates` 的 `bigAccountCount` / `singleBigAccountMerchantId` 子查询统一加 `AND ba.account_nature = 'client'`——维护大账号对话框初始化另走独立 IPC `big-account:get-with-own`（`src/preload.js:bigAccount.getWithOwn`）拿含自有的完整列表供 UI 展示。`groupBigAccountRows`（`utils.js`）分组 key 扩展为 `merchantId::accountNature`，防止 client + own 同 merchantId 被错误合并。
- **历史 own-accounts/*.json 启动迁移（D15/D16）**：新增 `src/backend/database/own-accounts-migration.js:runOwnAccountsMigration`，在 `app.whenReady` 启动序列里（`database.init()` 之后）执行一次性迁移。按 bankName 展开 `{merchantId, currencies}` 写入所有 `splitTemplateName(name).bankName === bankName` 匹配的模板，nature='own'，`INSERT OR IGNORE`；冲突保留已有记录并写 `[CONFLICT]` 日志。迁移幂等 flag = `app_settings.own_accounts_migration_v1_5_3_done='1'`。迁移日志独立写 `{storageRoot}/own-accounts-migration-v1.5.3.log`（ISO 时间戳 + `[INFO]/[OK]/[CONFLICT]/[WARN]/[ERROR]` 前缀）。原 `own-accounts/*.json` **保留不删除**，作为回退兼容；`big-account:save-own-accounts` IPC + `own-account-store.js` 同步并行保留（Q6 过渡期兼容）。
- **D15 迁移失败不阻塞启动**：`runOwnAccountsMigration` 外层包 try/catch 返回 `{ status: 'done' | 'already-done' | 'failed', stats, error? }`；失败不抛异常、不阻塞应用加载。`lastOwnAccountsMigrationError` 缓存失败文案，`app:get-info` 返回给 renderer；`initialize` 末尾追加判断，若非空则 `setStatus(info.ownAccountsMigrationError, 'error')` 覆盖默认欢迎文案。损坏 json / 非 array 主动抛错（不沿用 `readOwnAccounts` 吞异常），确保能被外层 catch 捕获。
- **D16 orphan bankName 跳过不告警**：json 对应 bankName 在数据库里找不到任何模板时，整份 json 跳过 + `[WARN] orphan bankName: {bankName}, skipped ({N} accounts)` 日志，`status` 仍为 `'done'`，**不触发** D15 状态栏告警。
- **明细/余额/合并/月度余额/新开账户模块导出 xlsx 表头字体统一为 Courier New**（决策 D14 = B）：新增依赖 `xlsx-js-style@^1.2.0`（仅 `src/backend/file-service/writers.js` 切 `require('xlsx')` → `require('xlsx-js-style')`，其它文件保持 `xlsx`，减少打包体积增长）。writers 内部新增 `applyHeaderRowFont(worksheet, headerRowIndex = 0)`：遍历表头行每个 cell，`cell.s.font.name = 'Courier New'` 硬编码（**无 CJK 回退链**，Q10 决策），保留原有 `font.bold` / `font.sz` / `font.color` / `fill` / `border`。`writeWorkbookRows` + `writeBalanceWorkbook` 各补调一次；数据区字体不变；报错 xlsx / error-reports 不改。
- **合并文件字体补调**（TechDoc §4.3.2 fallback）：`src/main.js:mergeGeneratedXlsxFiles` 内部局部 shadow `const XLSXStyle = require('xlsx-js-style')`（避免改全局 `xlsx` 影响其它非合并路径），`writeFile` 之前补一次内联表头 Courier New 注入。实测社区版 `xlsx` 读回 `cell.s` 会丢失 `font.name`，浅拷贝 `{ ...cell }` 即使保留字段也无用；须在 merge 出口重写字体，否则合并产物 styles.xml 会被 xlsx 社区版 writer 重建为 Calibri。
- **账单拆分合并浮点精度 hotfix**（D17 = A，2026-04-22）：`src/backend/file-service.js:buildMappedRows` 合并分支把 `net = sumCredit - sumDebit` 结果套 `roundAmount(...)`（`Number(value.toFixed(2))`）。此前纯 JS 浮点 `+` / `-` 会导致 `2377.49 + 178.31 = 2555.7999999999997`、`65572.01 + 4917.90 = 70489.90999999999` 等噪声泄露到导出 xlsx 的 Debit Amount 列。2 位小数对资金是精确而非降精度。初稿方案 `roundAmountHighPrecision`（`toFixed(12)`）对样本 2 仍不收敛（IEEE 754 在 12 位精度处仍保留尾巴），改用 `roundAmount`（`toFixed(2)`）覆盖全部样本。`net === 0` 判定同步变精确（`(0.1+0.2-0.3)` 合并组静默跳过）。

### 变更

- **主页面 state 新增 `mode` / `monthlyBalanceReady` / `monthlyBalancePreview`**（`src/renderer.js`）；`selectedTemplateId` 默认值改为 `FILENAME_MAPPING_TEMPLATE_ID`（「制作网银账单」内部隐式默认）。`updateTemplateSelect` 重写为只同步下拉 value ↔ `state.mode`，并调 `applyStatementModeSideEffects()`；option 改为静态 HTML（不再遍历 `state.templates` 构造）。`templateSelect` change listener 改为切模式 + 重置月度余额 ready 标记 + 调 side effects。
- **`handleExportBalance` 按 `state.mode` 三路分流**：月度余额模式未装配 → 弹 `createMonthlyBalanceExportDialog`；已装配 → 调 `window.desktopApi.monthlyBalance.export()` 弹系统保存对话框；制作网银账单模式 → 保留 v1.5.2 原 `files.exportBalance()` 链路。
- **新增 IPC**：`monthly-balance:assemble`（payload `{ templateScope: 'all'|'single', templateName, year, month }` 或兼容 `'__ALL_BANKS__'`；返回 `{ status: 'ready' | 'empty' | 'error', ... }`；E1/E2/E3 校验分支 errorCode=`MONTHLY_BALANCE_INVALID_INPUT` 不走 `createErrorResult`，避免误触发错误报告）、`monthly-balance:export`（从 `lastGeneratedExports.monthlyBalance` 读，未装配/文件丢失/用户取消/成功四分支）、`big-account:get-with-own`（维护大账号对话框初始化专用，返回含自有的完整列表）。`preload.js` 新增 `window.desktopApi.monthlyBalance = { assemble, export }` 和 `window.desktopApi.bigAccount.getWithOwn`。
- **`lastGeneratedExports` 新增 `monthlyBalance: null`**（`src/main.js`）；`clearGeneratedExports` 保留 `monthlyBalance`（R1 session 独立于 `statementImportSessions`）。切模式时清前端 `monthlyBalanceReady / preview`，后端 session 保留（用户重走装配链路时覆盖）。
- **Bundle v3 透明扩展**：`SUPPORTED_BUNDLE_VERSION` 保持 `v3` 不升 v4。`listTemplateBundleEntries` 独立再查一次 `getTemplateBigAccounts(..., {includeOwn:true})` → `groupBigAccountRows`，bundle 导出项 `bigAccounts[].accountNature` 字段可选携带（v1.5.2 读时忽略向后兼容；新版读旧 bundle 时缺省 `'client'`）。
- **`createBigAccountManagerDialog` tbody 初始化**：从原 `clientAccounts` 单类渲染改为 `[...client.map(nature=client), ...own.map(nature=own)]` 合并渲染；`pendingOwnAccounts` 仍保留供 `saveOwnAccounts` IPC 过渡兼容（并行写 json + DB）。`createBigAccountRow` tr 带 `dataset.accountNature`；新增内部 `setMerchantViewText(merchantId)` 处理 view 态下 own 行的 `[自有] ` 前缀；merchantInput 的 input 事件在 view 态下 value 始终保持裸 merchantId。`[data-action="done"]` 收集 `nextBigAccounts` 时读 `row.dataset.accountNature` → `accountNature` 字段；`balance-management` 往返重建 bigAccounts 时从裸 merchantId 取避免被前缀污染。
- **`expandBigAccountConfigurations` / `validateTemplateConfiguration` / `buildCompatibleBigAccounts`** 保留 `accountNature` 字段（白名单校验 + 展平 `(merchantId, currency)` 时同样保留）。
- **R4 import 重命名**：`src/backend/file-service.js` 顶部把 `roundAmountHighPrecision` 替换为 `roundAmount`（只取 2 位版本），合并分支注释改"2026-04-22 更正"版本说明为何改用 2 位小数（12 位无法收敛 `65572.01 + 4917.90` 场景）。
- **新开账户模块导出表头字体也变为 Courier New**（D14 决策接受的副作用）：`new-account:generate` 链路共用 `writeBalanceWorkbook`，Courier New 自动生效；用户已知情并确认。

### 废弃保留

- `src/backend/own-account-store.js`：源文件保留（未改代码），作为 v1.5.2 回退兼容 fallback。
- `src/main.js:big-account:save-own-accounts` IPC handler：前端不再单独依赖，但在 T2.9 决策下**并行写**（json + 数据库同时写），作为过渡期兼容层（Q6）。未来 major 版本可下线。
- `src/preload.js:bigAccount.saveOwnAccounts`：同上。

## 1.5.2 - 2026-04-16

- **按表头自动识别模板**：主页面「模板」下拉顶部新增 `__FILENAME_MAPPING__` 虚拟枚举值「按文件名映射模板」并设为**默认选中**（`src/renderer.js:updateTemplateSelect`）。导入时系统遍历所有模板，用 `matchesTemplateHeaders(filePath, template)` 逐个试表头自动匹配——用户**无需**在映射关系管理中配置任何"文件名固定字段"（原映射管理对话框中的「按文件名映射模板」输入框模块已删除）。0 命中报 `FILENAME_MAPPING_NO_MATCH`、≥2 命中报 `FILENAME_MAPPING_AMBIGUOUS`，均**整批截断**（当次导入的所有文件全部不入库）；唯一命中直接按该模板解析（不再有 HEADER_MISMATCH 报错）。`filenameFixedField` 数据层保留不动（DB 列、Repo/IPC/Bundle 透传均在，只是 UI 删除，未来可能重新启用）。
- **表头唯一性校验**：导入模板文件时新表头与已有模板全量比较，完全相同则拒绝（`TEMPLATE_HEADERS_DUPLICATE`）；Bundle 导入时每个 entry 校验，重复则跳过并写 activity log 警告。确保按表头自动识别不会命中多个完全相同的模板。
- **多模板合并导出**：多个文件匹配到不同模板时，每组按各自模板独立生成（银行名称 / 所在地各自正确），最终合并为汇总文件：`{模板数量}-COMMON-{日期范围}.xlsx` / `{模板数量}-BALANCE-{日期范围}.xlsx`。合并方式为直接复制单元格保留格式，session 只 append 一次。
- **大账号确认页「单个账号匹多个文件」（M:1 映射）**：「提取大账号顺序」按钮右侧新增勾选框「单个账号匹多个文件」（**默认不勾选**）+ 编辑和完成**合并为 1 个 toggle 按钮**。勾选时不发生文本平移（visibility 占位），编辑态勾选 block 位置不变。**完成后排序**：uncovered 在前保持原序，covered 在后按组 a→z 排（组内按原文件顺序）。**编辑还原**：点编辑恢复原排序，保留已有映射供修改（不清空 multiGroups）。已映射 block 不参与「提取大账号顺序」，确认弹窗不显示已映射 block。左侧文件名左边新增字母列。勾选粒度 = **block**：同一文件的多个 block 可归属不同组或不归属任何组；未参与 M:1 的 block 沿用旧 1:1 勾选流程。对话框主「完成」按 block 粒度展开 `multiGroups` 为多条 `assignments`（key = `rowIndex`），同组多条 rowIndex 共享 MerchantId+Currency，与 1:1 部分合并后发送给后端。
- **主/子模板名校验**：映射关系管理「完成」按钮点击时前置执行"子名.includes(主名)"字符串校验；勾选「设为子模板」+ 选中主模板时若当前模板名不包含主模板名，弹提醒框阻断 `saveMappings` / `setParentStatus` / `setChildParent` 全部调用，用户确认后重开对话框。未勾「设为子模板」或未选主模板时不触发。
- **UI 变更**："导出当前文件"更名为"导出**当前批次文件**"；"导出所有"更名为"导出**所有批次文件**"。

### 变更

- **模板数据结构**：`templates` 表追加 `filename_fixed_field` 列（数据层保留）；`listTemplates` / `getTemplate` / `listChildTemplates` / `listTemplateBundleEntries` 的 SELECT 均追加 `t.filename_fixed_field AS filenameFixedField`；`buildTemplateSummaryFromRow` / `buildTemplateSummary` 均透传该字段；新增 `saveTemplateFilenameFixedField(db, templateId, value)` 仓储方法。
- **Bundle v4 透明扩展**：`SUPPORTED_BUNDLE_VERSION` 保持 `4` 不升 v5。`filenameFixedField` 作为 v4 schema 下的新增透明字段由 bundle 自动携带；`readTemplateBundleFile` 对无字段的旧 v4 bundle 回退为空串。**v1.5.1 用户导入 v1.5.2 导出的 bundle 不会报错，该字段被自然忽略**；`bundleVersion > 4` 仍然拒绝。
- **大账号确认页 row 结构**：`buildBigAccountSelectionRows` 每 row 追加 `fileIndex` 字段（可视化辅助用，状态机 key 仍为 `rowIndex`）；前端状态机（`multiMode / multiEditing / multiGroups / pendingGroup` 四个 let 变量 + 一组 helper）按 block 粒度展开 assignments。
- **固定模式与 M:1 互斥**：`rememberCheckbox` 与 `ba-multi-mode-checkbox` 双向 `disabled` 互斥；mode 切换（fixed ↔ unfixed）时清空 `multiGroups` / `pendingGroup`。
- 新增 IPC：`template:save-filename-fixed-field`（payload `{templateId, value}`，返回 `{status:'success'}`，错误码 `TEMPLATE_ID_INVALID` / `TEMPLATE_FILENAME_FIXED_FIELD_SAVE_FAILED`）；`preload.js` `templates` 对象追加 `saveFilenameFixedField`。

## 1.5.1 - 2026-04-13

- **主/子模板**：`templates` 表新增 `parent_template_id`（nullable FK, ON DELETE SET NULL）+ `is_parent`（INTEGER DEFAULT 0）两列。映射关系管理 dialog header 新增「设为主模板」「设为子模板」checkbox，互斥逻辑；选「设为子模板」时出现主模板下拉框。模板管理页面新增「模板管理」标题；主模板行有 ▶/▼ 展开折叠按钮，子模板缩进显示。
- 主页面模板下拉框按 `.filter(!parentTemplateId)` 过滤掉子模板；文件导入时 `matchFileToTemplate` 按 headers 精确匹配候选模板，通过 `parentProvisionalEntries` 暂存匹配结果 + `rebuildMatchedTemplateFileEntries` 在大账号选定后重建 rows。重新进入映射管理页时根据 DB 的 `isParent` / `parentTemplateId` 正确回显 checkbox 状态。
- **账户映射按模板隔离**：`account_mappings` 表重建——新增 `template_id`（NOT NULL FK）、UNIQUE 约束改为 `(template_id, bank_account_id)` 联合唯一。事务保护（BEGIN/ROLLBACK）；多模板时旧记录复制给每个模板，设 `account_mapping_migration_pending` flag。首次打开账户映射检测 flag 弹「迁移分配对话框」引导用户分配旧数据。模板下拉框传 `state.templates` 全量列表（含子模板），可选子模板配置映射。
- **账户映射 UI 调整**：表头文案「网银大账号ID」→「网银账单账户号」、「清结算系统大账号ID」→「清结算系统银行账号」；执行操作列新增编辑/完成切换交互，按钮左对齐（`text-align: left`）；币种 ⓘ tooltip（`z-index: 9999` 防遮挡）；移除 `noCurrency` checkbox 改为自动检测（`currencyInput.value.trim() !== ''`）；提取大账号顺序时检测桥接匹配 + 多币种会弹提醒框；账户映射缺失不再阻断导入。
- **Bundle v4**：`SUPPORTED_BUNDLE_VERSION = 4`。导出时 `buildTemplateLibraryPayload` 追加 `parentTemplateKey` + `accountMappings`；导入时三阶段还原（模板 → 父子关系 → 账户映射）。v3 向下兼容（缺失字段默认空值），`bundleVersion > 4` 仍然拒绝。
- **重复判定增强**：`computeFileHash` 计算文件 SHA-256；`resolveImportFileSelection` 三维度判重：路径 > 文件名 > 内容。重复时对话框改为两按钮（覆盖旧记录 / 取消本次导入），移除「保留两份」；提示框显示重复原因。
- `template:get-mappings` / `listAccountMappings` / `saveAccountMappings` / `listTemplates` / `listChildTemplates` / `listTemplateBundleEntries` 等 DB 层方法签名扩展 `templateId` / `isParent` / `parentTemplateId` 等新增参数；`preload.js` 的 `accountMappings` 增加 `templateId` 透传。

## 1.5.0 - 2026-04-12

- **发生额精度提升到小数点后 12 位**：`Credit Amount` / `Debit Amount` / 发生额 / 余额均支持保留最多 12 位小数。原始值有几位就保留几位，不补零。Excel 导出默认数字格式；有效数字超过 15 位时自动切换为文本格式以保持精度。新增 `roundAmount` 高精度版本，保留原实现兜底短精度路径。
- **网银账单解析大账号确认重构**：页面标题和文案统一；新增「提取大账号顺序」按钮（左下角），自动识别文件里的账户号并在弹出的「确认大账号顺序」页面展示提取结果。提取行支持双输入框编辑 + 精准匹配校验，提取失败时弹提醒。「完成」按钮按条件覆盖右侧大账号顺序表。主页面左右面板支持同步滚动。
- **「记住顺序」持久化增强**：固定模式下勾选「记住顺序」会持久化「文件个数 + 各文件的账户数与账户号 + 排序」。下次导入时按文件个数和账户匹配自动回显配置；文件数不匹配时切回「账号顺序不固定」模式；账户信息匹配不上时弹提醒框，用户可选「变更配置」重新设置或「确认」返回主页面。
- **模块名称变更**：新开账户模块按钮文本由「新开账户生成网银账单」改为「新开账户余额账单生成」。
- **英文日期格式解析**：`stripDateTimeSuffix` 新增「逗号 + 时间 + AM/PM」正则；`parseEnglishMonthDateCandidate` 新增 `DD Mon YYYY` 和 `Month DD YYYY` 两个 pattern。支持 `09 Apr 2026, 06:26:26 PM` / `April 9, 2026` 等输入。
- **导入模板包同名覆盖确认**：`template:import-bundle` handler 在循环前扫描同名模板，使用 Electron 原生 `dialog.showMessageBox` 弹出确认框，避免静默覆盖。
- **使用手册导出格式扩展**：支持 `txt` / `md` / `html` 三种格式。HTML 格式使用 `marked` 库渲染 Markdown 后保存为 HTML（新增 `marked` 依赖）。
- **提取大账号顺序弹框单滚动条**：DOM 重构为 `.extract-scroll-container`（`overflow-y: auto`），删除双滚动条同步代码。
- **大账号选择对话框条件单滚动条 + 文本化**：DOM 重构为 `.ba-scroll-container`。勾选「记住顺序」时切为单滚动条 + 右面板文本化只读显示；取消勾选恢复双滚动条 + checkbox 列表。
- **指定账单实现功能**：`template_bill_split_meta` 表新增 `signed_amount_target_seq_nos` 和 `by_field_amount_target_seq_nos` 两列。前端在「按正负号」/「按字段区分」有值时出现「指定账单实现功能」勾选框 + 多选账单序号下拉。副区域有值且未勾选指定时全部 Credit/Debit 禁用；勾选指定时被指定行禁用、未指定行保留行级 Credit/Debit 直接映射。六列表删除「发生额」列改为五列。`file-service.js` 按指定/未指定分别走副区域逻辑和行级直接映射。
- **映射字段列位置固定**：`.concat-field-picker` / `.mapping-field-editor > button[hidden]` / `.bill-split-group-btn[hidden]` 改用 `visibility: hidden + pointer-events: none` 保留占位，不再因 `display: none` 导致列平移。按钮文本始终填充以保持正确宽度。`.mapping-select` 固定 `min-width: 260px; max-width: 260px`。
- **映射互斥补全**：`applyAmountSplitMutualExclusion` 重写为完整 3 选 1 互斥（按字段区分 / 按正负号 / 均无）。修正 `getSelectValues(select)[0] !== ''` 空值误判为激活的 bug，改为 `signedAmountSelect.value !== ''`。
- **按正负号下拉框宽度修复**：`.bill-split-sub-row .mapping-select` 由 `min-width: 200px` 改为 `min-width: 260px; max-width: 260px`。
- **拼接字段预览文本截断**：移除 `.concat-preview` 的 `max-width: 200px` 硬限，截断阈值从 40 字符提到 120 字符。
- **弹框 2 六列表格 UI 优化**：账单序号表头不换行（`white-space: nowrap`）；行级「完成」后 4 个 select 隐藏改为纯文本 `<span class="bill-split-row-view-text">`（`min-height: 44px; line-height: 44px`），表格 `table-layout: fixed`；账单序号列 `padding-left` 抬头右移 1em、数字右移 2em；维护大账号币种校验失败改为 `openModal(createAlertDialog(...))` 弹框提醒，不再只在状态栏显示。
- **主页面初始状态框文本**：启动时文本由「已加载内置枚举表：COMMON枚举.xlsx」改为「欢迎使用小助手」。

## 1.4.9 - 2026-04-09

- 映射关系管理新增「账单拆分合并管理」分组（`createMappingDialog` 内 `BILL_SPLIT_GROUP_FIELDS` 两行）：`是否拆分/合并明细账单`（默认 `否`） + `复用模块字段的映射关系`（默认 `是`）。
- 启用 `是否拆分/合并明细账单` 时，与 `Credit Amount` / `Debit Amount` 直接映射、`按正负号拆分的发生额`、`按字段区分发生额` 形成 **四方互斥**；该开关启用后会自动清空并禁用 `Currency` / `Credit Amount` / `Debit Amount` / `按正负号拆分的发生额` / `按字段区分发生额` 五行。
- 新增 `拆分/合并账单映射关系设置` 弹框（`createBillSplitMappingsDialog`，宽度 `80vw`）：用于在 `复用模块字段的映射关系 = 否` 时为非金额字段单独配置映射；右上角 `导入当前映射关系` 按钮可从主模板复制（自动排除 `Currency` / `Credit Amount` / `Debit Amount`），若弹框已有配置先弹二次确认。`Balance` 字段枚举值与主表格一致（`无` / `通过发生额计算` / headers，无拼接字段选项）。
- 新增 `拆分/合并账单映射关系管理` 弹框（`createBillSplitRowsDialog`）：右上角 `合并账单` 勾选框 + checkbox-panel 多选 picker；标题下方 `需要拆分成几份账单` 数字输入 + `拆` 按钮（宽度 71px）生成 N 行；六列表格（`账单序号` / `Currency` / `Credit Amount` / `Debit Amount` / `发生额` / `执行操作`）支持行级 `完成 / 编辑 / 删除`；副区域 `拆分/合并账单——发生额映射关系管理` 内嵌 `按正负号拆分的发生额` 和 `按字段区分发生额` 二选一互斥；右下角 `完成` 按钮（语义等同 × 关闭）。
- 删除合并组内的拆分行时，会先调用 `template:preview-delete-bill-split-row` 预览受影响的合并组，并弹出二次确认对话框（外科手术式解散：删除该行并解散所有受影响合并组）。
- 新增 4 张 DB 表：`template_bill_split_meta`（按正负号拆分配置） / `template_bill_split_mappings`（弹框 1 字段映射） / `template_bill_split_rows`（六列表格行数据，含 `row_status` 和 `merged_group_seq`） / `template_bill_split_amount_rules`（弹框 2 副区域的按字段区分规则，独立于主模板的同名表）。
- 新增 10 个 IPC：`template:get-bill-split-config` / `save-bill-split-mappings` / `save-bill-split-row-count` / `save-bill-split-row` / `preview-delete-bill-split-row` / `delete-bill-split-row` / `save-bill-split-merge-group` / `clear-bill-split-merge-groups` / `save-bill-split-amount-rules` / `save-bill-split-meta`。
- 导入流程：`buildMappedRows` 新增 `billSplitMerge` 入参 + `expandBillSplitForRow`（按弹框 2 N 行配置展开） + `applyBillSplitMergeForRow`（按 `merged_group_seq` 分组求净值，按 `Σ(Credit) − Σ(Debit)` 方向填入 `Credit Amount` 或 `Debit Amount`）。
- 单行拆分行 `Credit Amount` 和 `Debit Amount` 同时为 0、或合并组净值为 0 时 **静默过滤** 不输出，不报错；合并组 `Currency` 不一致时仍然报错 `BILL_MERGE_CURRENCY_MISMATCH` 阻断导入。
- `复用模块字段的映射关系 = 否` 时，`expandBillSplitForRow` 通过 `billSplitMappingByTargetField` 用弹框 1 的映射重新计算非金额字段；`Drawee Name` / `Payee Name` / `Drawee CardNo` / `Payee CardNo` 在 post-process 阶段按每个拆分行自己的收支方向独立分配（`reuse=true` 路径同样按 per-split-row 方向分配）。
- 多文件导入时新增 `以下文件全部未命中拆分/合并规则，请检查规则配置：…` 聚合告警，沿用 v1.4.8 的链路实现（`collectUnmatchedBillSplitFiles` + `unmatchedBillSplitFiles` 字段）。
- `bundleVersion` 升级到 `3`，导出 entry 新增 `billSplitMappings` / `billSplitRows` / `billSplitAmountRules` / `billSplitMeta` 四个字段；旧 `bundleVersion = 2` 的 bundle 按 4 张表的默认值兼容；`bundleVersion > 3` 的 bundle 仍然拒绝。
- `template:get-mappings` IPC 返回值补齐 `billSplitGroupFields` / `billSplitMappings` / `billSplitRows` / `billSplitAmountRules` / `billSplitMeta` 5 个字段，修复冷启动后首次打开 `拆分/合并账单映射关系管理` 弹框只显示初始页面的 bug。

## 1.4.8 - 2026-04-07

- 映射关系管理新增 `按字段区分发生额` 配置项（归入 `ADVANCED_MAPPING_FIELDS`，放分组末尾），下拉选项为空白（默认）/ `是`；选 `是` 时右侧出现 `发生额映射关系管理` 按钮。
- 启用 `按字段区分发生额` 时，与 `Credit Amount` / `Debit Amount` 直接映射、`按正负号拆分的发生额` 形成 **三方互斥**：选 `是` 自动清空并禁用另外三行；切回空白时按钮隐藏，弹框配置草稿独立保留，再切回 `是` 时回显。
- 新增 `发生额映射关系管理` 弹框：固定 2 行规则——第一行 `当 [字段] 的值为 [输入] 时，[字段] 映射为 Credit Amount`，第二行映射为 `Debit Amount`；4 个下拉框选项来自 `template.headers`，排除 `自己输入` / `需要拼接字段` 特殊值；同行内 `条件字段 ≠ 目标字段`，跨行可同字段；`完成` 按钮直接落库，校验失败保留弹框开放、不丢失已填字段。
- 条件值匹配规则：默认按字面值精确匹配（整串、大小写敏感、源值先 trim、不做数字归一化，`1.0 ≠ 1`）；输入 `/pattern/flags` 形式按正则匹配，使用 `regex.test`，支持 `i` / `g` / `m` / `s` / `u` 等 JS RegExp flags；不支持多值，多值场景请用 `/^(C|CR|Credit)$/` 这类正则分组代替；无效正则保存时报错 `正则表达式语法错误`。
- 新增 DB 表 `template_amount_split_rules`（迁移幂等），新增 IPC `template:get-amount-split-rules` / `template:save-amount-split-rules`；`saveMappings` 签名扩展为 6 参，最后一个参数 `amountSplitRules`（`null` = 保留原值，`[]` = 清空）。
- `buildMappedRows` 新增按字段区分发生额的匹配分支，导入时按规则计算 `Credit Amount` / `Debit Amount`；命中失败的行 `Credit Amount` / `Debit Amount` 留空，不阻断导入。
- 多文件导入时新增 `以下文件全部未命中收支规则，请检查规则配置：…` 聚合告警；按文件独立判定 + 跨文件聚合后弹一个合并告警框。
- 新增 `bundleVersion` 顶层字段（v2），导出 entry 包含 `amountSplitRules`；导入时 `bundleVersion > SUPPORTED_BUNDLE_VERSION` 被拒绝（v1.4.8 自身不会触发，为后续版本预埋）。

## 1.4.7 - 2026-04-07

- 大账号选择对话框重写为左右分栏布局：左侧按文件顺序展示，右侧按勾选序位展示，并新增搜索定位与勾选序号回显。
- 多账号账单导入新增 **账号顺序固定 / 不固定** 模式：固定模式下要求一次勾选全部大账号且按指定顺序导入，并支持「记住顺序」在下次导入时回显配置。
- 新开账户模块的导出文件命名规则适配单 / 多账号场景。
- 修复 `rowsWithEmptyBlocks` 未持久化导致固定模式校验失败、空块 `sourceRowNumber` 回退值错误、元数据行被误当成数据行导出的问题。
- 大账号对话框：`remember` 复选框在不固定模式下灰显而非隐藏；切换搜索关键字时重置选中索引；模式切换时清空搜索状态；初始化期间禁用交互；报错后保留对话框供用户重新设定。
- 日期解析增强：支持 BNI 点号时间格式 `HH.MM.SS`；支持 Excel 日期序列号被字符串化后的解析（如 PAB-CN 的 `46102`）；`DD-MM-YY` 不歧义场景下 fallback 到 `MM-DD-YY`（`month > 12` 时）；`YYMMDD` 优先于 Excel 序列号识别。
- 全部账号 0 笔交易时直接报错 `没有账号存在交易数据`，不再进入大账号选择；修复 `identifyAccountBlocks` 空块 fallback 假块的问题。
- 新开账户余额账单的最晚日期改为「到昨天」。
- `MerchantId` 自动去除中间空格（如 `NRA 7101 2023 0223 63` → `NRA71012023022363`）。
- CSV 导入改用纯文本解析器 `parseCsvText`：所有值保持字符串、不过 `xlsx` 的类型推断，解决 20 位以上长数字（交易流水号）后几位被截断为 0 的问题；支持引号包裹 / 转义引号 / CRLF / LF / UTF-8 BOM。`xlsx` / `xls` 文件不受影响，仍走 `XLSX` 库读取。
- `Currency` 字段从映射对话框的多选拼接里排除（`isCurrencyField` 判断），下拉不再出现 `需要拼接字段` 选项。
- `splitTemplateName` 修复多段 `-` 时的所在地取值：`BNI-ID-SG` 模板的 location 取第二段 `ID`，不再是 `ID-SG`。
- 移除映射对话框的日期格式下拉（`dateFormatSelect` 变量及 `saveMappings` 内 `dateFormat: dateFormatSelect.value` 一并删除）。

## 1.4.6 - 2026-03-27

- 维护大账号弹窗的币种输入框小写自动转大写；多币种浮动面板溢出修复（`overflow-y: auto`）。
- 模板选择框启动时显示 `请选择模板` 占位符；未选模板时阻断导入操作；删除模板时清理相关缓存。
- 新增「导入银行账号信息」入口（`bank-account-import.js`）：从 Excel 解析客资账号写入大账号表，自有账号写入独立 JSON 存储（`own-account-store.js`）。
- 新增「余额管理」弹窗：按 `大账号 + 币种 + 日期 + 余额附加值 + 备注` 维护余额附加值（`balance-adjustment-store.js`）；附加值会在余额导出时按 `MerchantId + Currency + BillDate` 累加注入到生成的余额账单。
- 新开账户余额账单改为开户日到今天 **逐日生成**（上限 3650 天），不再只输出开户日和月末日。
- `维护大账号` / `账户映射` 等弹窗按钮新增文本溢出保护样式（`.primary-btn.small` 等）。
- 新增 IPC channels：`bigAccount` 系列 + `balanceAdjustment` 系列。

## 1.4.5 - 2026-03-24

- “新开账户生成网银账单”模块中，`所在地` 输入框宽度缩窄为原来的三分之二，`币种` 列相应扩宽。
- 新开账户模块单币种下拉在未选择时改为空白占位，不再显示 `请选择币种`。
- 新开账户模块多币种下拉增加固定搜索框，支持按币种代码、显示标签和中文名做模糊匹配；点击面板外空白处会收起下拉并保留当前勾选结果与位序。
- 点击首行 `新增` 后生成的新账号行，现在会在相同位置显示 `删除` 文本按钮，并支持直接删除当前行。
- 修复了新生成账号行在 `银行账号` 文本右侧空白区域误触发新增行的问题。

## 1.4.4 - 2026-03-24

- 背景调色盘按钮右侧新增 `使用手册` 文本按钮；点击后可将内置 `docs/USER_GUIDE.md` 另存为 `使用手册.md`。
- “新开账户生成网银账单”模块中的单币种输入改回下拉选择；勾选 `多币种账户` 后切换为带数字位序的多选下拉，并支持点击空白处收起且保留已勾选结果。
- 新开账户模块在单币种切换为多币种时，会把原单一币种自动带入多选列表并标记为 `1.`；切回单币种时，会回填当前多币种顺序中的第一个币种。
- 账户映射弹窗中的 `网银大账户ID` 文案统一改为 `网银大账号ID`，并同步调整了相关校验报错文案。
- 账户映射弹窗中，`清结算系统大账号ID` 输入框宽度收窄为与左侧输入框一致；其右侧新增 `删除` 文本按钮，`有账户号无币种` 勾选框移动到 `删除` 右侧。
- 账户映射弹窗支持直接删除当前行，且删除后的行不会再被意外保存回映射结果。
- 以后版本迭代的固定文档同步清单明确扩展为：`CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md`。

## 1.4.1 - 2026-03-19

- 网银账单生成模块新增 `PDF` 导入能力，支持表格式 PDF、扫描版图片型 PDF，以及多页跨页续表 PDF；解析后的数据会继续走现有模板映射、明细导出和余额导出链路。
- 映射关系管理支持多选源字段映射；当某个模板字段选了多个源字段时，点击 `完成` 会先弹出顺序确认弹窗，并按用户确认的顺序直接拼接输出。
- 当模板中的 `MerchantId` 是固定映射且不是 `自己输入` 时，`Currency` 现在允许留空；生成的明细和余额账单会保留空币种值。
- `MerchantId = 自己输入` 的导入场景升级为多行大账号 / 币种分配弹窗，支持逐行选择、顺序保存，以及使用 `固定` 将当前分配结果持久保存到模板。
- 应用中的币种输入统一升级为“文字输入 + 全量下拉 + 虚影补全”交互；用户可输入前缀后用键盘右方向键接受建议值。
- “新开账户生成网银账单”模块支持在 `银行账号` 字段右侧通过文本按钮 `新增` 追加完整账号行；多个账号会合并生成一份 `NEW_BALANCE` 文件，文件名中的账号部分改为 `多账号`。
- 左上角 GIF 尺寸缩小为原来的一半。
- 开发侧补充了 PDF 解析 worker，并扩展了模板映射与固定分配的数据结构，以支撑 `1.4.1` 新能力。

## 1.4.0 - 2026-03-18

- 这是一次内部治理与结构重构版本，不引入新的用户功能，也不调整现有前端界面。
- 将 `scripts/smoke-test.js` 按能力拆成独立 smoke 场景与公共支持模块，保留 `npm run smoke` 入口不变。
- 将 `src/backend/file-service.js` 拆分为读取清洗、标准化、写出等后端子模块，并保持现有对外 API、导出结构和业务行为不变。
- 将 `src/backend/database.js` 拆分为迁移、模板仓储、设置仓储等内部模块，继续由 `AppDatabase` 作为门面层对外提供原有方法。
- 将主进程中的账单导入会话与导出聚合逻辑拆到独立模块中，`src/main.js` 更聚焦于装配和流程协调。
- 将渲染层的弹窗工厂与 preview 逻辑拆到独立脚本中，保持现有 UI、文案、布局和交互顺序不变。

## 1.3.5 - 2026-03-16

- 网银账单生成模块现在支持一次选择多个原始账单文件导入；同一批次文件会合并生成当前批次的明细和余额结果。
- 混合币种账单不再因为 `Currency` 多值而无法生成余额账单；系统会按币种分别计算余额，并将所有币种结果整合到同一个余额文件、同一个 sheet 中导出。
- 当同一模板在当前软件打开期间已导入过 2 次及以上时，点击 `导出明细` 或 `导出余额` 会先弹出选择框，让用户决定导出“当前文件”还是“全部”结果；这个统计范围只按模板，不再按大账号 / 币种拆开。
- `导出所有明细` / `导出所有余额` 会把同一模板在当前软件打开期间导入过的多个大账号、多个币种结果整合到同一个文件中；此时导出文件名不再带大账号。
- 主模块余额文件命名中的 `Balance` 统一改为 `BALANCE`。

## 1.3.4 - 2026-03-16

- 修复多大账号模式下导出明细和余额时 `MerchantId` 可能错误写成 `__MULTI_BIG_ACCOUNT__` 的问题；当前导出文件内容会严格使用所选中的 `大账号 / 币种` 组合。
- 原始网银账单自动清洗新增表尾汇总区过滤：遇到 `总收入笔数 / 总收入金额 / 总支出笔数 / 总支出金额` 这类汇总标题后，会停止继续读取后续行，避免把汇总区误当成真实交易明细。
- 收紧日期兜底解析，不再把 `"0"`、`"1"`、`"0.00"` 这类短数字或金额样式值错误识别成日期，修复了由此派生出的 `BillDate=2000-01-01` 假明细和余额记录。
- 首次导入且确实缺少上一账单日余额时，余额链路会重新进入“补录上一账单日余额”提示，而不是被误生成的假账单绕过。

## 1.3.3 - 2026-03-12

- 映射关系管理中，`MerchantId` 选择 `自己输入` 后将直接进入“维护大账号”模式，由维护的大账号配置接管 `MerchantId + Currency`；`Currency` 行在该模式下隐藏，并且全局移除了 `自己输入` 选项。
- 导入账单时，如果维护大账号后只得到 1 条 `大账号 / 币种` 组合，系统会直接使用，不再额外弹出选择框；若存在多条组合，仍会提示选择本次使用的组合。
- 映射关系管理点击 `完成` 后如果保存失败，现在会先弹出错误提示；点击确认后会回到原编辑内容，保留当前草稿继续修改，不再丢失已编辑数据。
- 收掉了 `MerchantId / Currency` “选择自己输入后必须填写内容”的旧强校验实现，并兼容历史上使用固定 `MerchantId / Currency` 的模板配置。

## 1.3.2 - 2026-03-12

- 新增 `docs/VERSION_FEATURE_HISTORY.md`，按版本号整理 `新增 / 变更 / 移除` 功能点，并约定后续每次版本迭代同步更新。
- 模板管理弹窗布局优化：`执行操作` 列标题与行内按钮组重新做了左边界对齐，底部 `导入模板文件 / 导出模板文件` 调整为右对齐按钮组。
- 模板管理中的 `大账号` 摘要改为在单固定大账号场景直接显示完整账户号；超长时使用省略显示，并支持原生 tooltip 查看完整值。
- “维护大账号”弹窗新增行内 `完成 / 修改 / 删除` 状态切换；已保存行默认以完成态展示，未完成行不允许直接整体保存，`修改 / 删除` 按钮组与 `执行操作` 标题左边界对齐。
- “维护大账号”弹窗中的多币种下拉改为浮层式渲染，修复展开内容被表格容器遮挡的问题。
- “新开账户生成网银账单”模块中，`银行名称 / 所在地 / 币种 / 银行账号 / 开户日期` 五个字段标签整体向右微调一个汉字宽度。

## 1.3.1 - 2026-03-12

- 修复了 `1.3.0` 在旧版本用户升级后可能无法启动的问题：数据库迁移现已先补齐 `template_key` 列，再创建唯一索引，避免窗口创建前直接报错。
- 启动链路新增兜底错误提示；若数据库初始化或启动前同步失败，应用会记录到 `app_activity_log.txt` 并直接弹出系统错误框，而不是只留下后台进程。
- 补充了 smoke test，覆盖旧数据库迁移和启动失败兜底行为。

## 1.3.0 - 2026-03-12

- 网银账单生成模块现在支持直接导入原始网银账单：系统会在第一个 sheet 中自动定位与当前模板一致的真实表头，清理表头前脏数据行、左侧脏列和右侧空尾列，再继续生成明细和余额账单。
- 映射关系管理新增 `按正负号拆分的发生额` 辅助映射，可将单列正负号发生额自动拆分到 `Credit Amount` / `Debit Amount`。
- `BillDate` / `ValueDate` 统一增加日期标准化：会自动清理时分秒、补全年月日位数，并按 `YYYY-MM-DD`、`YYYY/MM/DD`、`YYYYMMDD` 规则输出和设置单元格格式。
- 模板管理页新增 `大账号` 列、`重命名` 操作、`导入模板文件` / `导出模板文件` 按钮；映射关系管理中，`MerchantId` 支持维护多个“大账号 + 币种”配置，并在导入时选择本次使用的组合。
- 新增模板库同步文件 `文档/网银账单生成小助手/templates/template-library.json`；新增、删除、修改模板后会自动同步，并支持 JSON 模板包导入导出。

## 1.2.13 - 2026-03-11

- “模板管理”页面中模板列表 `执行操作` 列的行内按钮文案已从 `模板管理` 恢复为 `修改`；主界面入口按钮仍保持为 `模板管理`。
- 刷新并同步了用户使用文档，当前文档内容与 `1.2.13` 版本界面和导出规则保持一致。

## 1.2.12 - 2026-03-11

- “新开账户生成网银账单”模块中，“多币种账户”文案的第二行“账户”调整为居中显示，优化多币种勾选区排版。

## 1.2.11 - 2026-03-11

- 修复了 `Credit Amount` 与 `Debit Amount` 同时为 `0` 或空值的明细仍可能进入余额账单生成链路的问题；现在这类记录会同时从导出的明细账单和余额账单中过滤。
- 统一了无效发生额行的过滤规则，并补充 smoke test 覆盖，避免“明细已过滤但余额未过滤”的分叉行为再次出现。

## 1.2.10 - 2026-03-11

- 应用运行时所有面向用户的“模板”文案已统一。
- `Balance` 映射新增固定选项 `通过发生额计算`；启用后会按 `上一账单日余额 + Credit Amount 汇总 - Debit Amount 汇总` 生成余额账单，并沿用现有状态框补录上一账单日余额的交互。
- 本地余额种子文件新增 `生成方式` 字段，用于区分 `账单里的余额`、`通过发生额计算` 和 `人工录入`；余额账单生成成功后会自动写入本地余额种子。
- “新开账户生成网银账单”模块中，“多币种账户”复选框文案调整为上下两行显示。
- `app_activity_log.txt` 统一改为写入 `文档/网银账单生成小助手/`，删除旧版 exe 文件夹后仍可保留运行日志。

## 1.2.9 - 2026-03-11

- 网银账单生成模块新增本地余额种子机制：当同一账单日出现多个余额且当前文件无法取得上一账单日余额时，系统会优先读取本地余额文件参与校验。
- 新增“因首次导入余额，请导入上一个账单日余额用于余额校验”提示状态；点击状态框可补录上一账单日日期和余额，保存后立即重试当前余额校验。
- 余额种子文件按银行拆分保存在 `文档/网银账单生成小助手/balance-seeds/`，记录键固定为 `MerchantId + Currency + BillDate`，重复录入时支持确认覆盖。
- 当模板启用了 `Balance` 时，`MerchantId` 现在成为余额链路必填项；缺少映射或导入值为空都会阻止余额账单生成。
- 新增独立用户说明文档 `docs/USER_GUIDE.md`，补充两个模块、余额补录、本地余额种子、报错文件与导出规则的完整操作说明。

## 1.2.8 - 2026-03-11

- “映射关系设置”统一更名为“映射关系管理”；映射弹窗底部新增“根据发生额做映射的户名 / 账户号”两条规则，可按 `Credit Amount` / `Debit Amount` 将 `Payee Name`、`Payee Cardno`、`Drawee Name`、`Drawee CardNo` 定向映射到不同来源字段。
- 导出明细前新增强校验：若某条记录的 `Credit Amount` 与 `Debit Amount` 同时有值，将中止导出并生成详细报错文件。
- “新开账户生成网银账单”模块优化了多币种下拉框宽度，开户日期默认显示为空白；新生成余额账单命名规则调整为 `银行名称-所在地-银行账号-币种-NEW_BALANCE.xlsx`。
- 报错文件命名规则调整为 `YYYYMMDD-HHMMSS-模版名-错误步骤.txt`。
- 应用首次启动时会在根目录创建 `app_activity_log.txt`，按日期和时间戳记录关键操作与报错。

## 1.2.7 - 2026-03-10

- “新开账户生成网银账单”模块在多币种账户场景下，导出文件名中的币种段固定输出为 `多币种`。

## 1.2.6 - 2026-03-10

- “新开账户生成网银账单”模块新增多币种账户模式：币种输入可切换为多选下拉框，选项取自 `币种映射表.xlsx` 的 C 列，按勾选币种批量生成多行账单。
- “新开账户生成网银账单”模块中的开户日期默认显示为空白。
- 调色盘面板尺寸调整为 `6.8cm * 6.8cm`，“导入背景文件”按钮改为单行显示。

## 1.2.5 - 2026-03-10

- 新增 `npm run icon:sync` 图标同步脚本，可由 PNG 自动生成打包用与运行时共用的应用图标资源。
- Windows 安装包、portable 可执行文件、桌面快捷方式和任务栏窗口图标统一改为自定义应用图标。

## 1.2.4 - 2026-03-10

- 修复余额账单在“同一账单日期存在多条余额记录”场景下的推导逻辑，优先按 `上一余额 + Credit Amount - Debit Amount` 匹配期末余额。

## 1.2.3 - 2026-03-10

- 明细账单导出时不再保留 `Balance` 列。

## 1.2.2 - 2026-03-10

- 明细账单导出时保留 `Balance` 列但不再输出该列数据。
- 若 `Credit Amount` 与 `Debit Amount` 同时为 0 或空值，对应记录不会写入导出的明细账单，并会在状态提示和报错文件中说明。
- `Balance` 字段在导入转换时会像收支字段一样清洗，仅保留数字和 `.` 后按数值参与余额账单计算。
- `Currency` 映射新增“自己输入”，填写后该模板涉及 `Currency` 的所有取值均固定使用该文本。
- “新开账户生成网银账单”模块的导出文件命名规则调整为 `银行名称-所在地-银行账号-币种-新开银行账户余额录入-最早日期~最晚日期.xlsx`。

## 1.2.1 - 2026-03-10

- 网银账单生成模块主界面按钮文案调整为“模版管理”。
- `Credit Amount` / `Debit Amount` 导出前会清洗为仅保留数字和 `.`，并按数值格式写出。
- 内置 `assets/币种映射表.xlsx`；`Currency` 若不是纯英文，则会模糊匹配映射表 A/B 列并替换为 C 列英文简称，匹配失败时保留原值导出并生成报错文件。

## 1.2.0 - 2026-03-10

- 明细导出文件命名规则调整为 `模版名-COMMON-最早账单日期~最晚账单日期.xlsx`，单日账单不再附加 `~`。
- 映射关系设置允许多个模版字段指向同一映射字段；`Channel` 从映射弹窗移除并改为固定取模版名称 `-` 前的值；`MerchantId` 新增“自己输入”模式并贯穿明细、余额及相关取值链路。
- 所有用户侧报错统一生成详细报错文件，状态框在有报错时支持点击导出。
- 新增“新开账户生成网银账单”模块，支持基于余额账单模版生成开户日及截至今日所有月末零余额账单，并导出对应 xlsx。
- 微调“新开账户生成网银账单”模块底部布局，状态框左边界与“币种”输入框对齐，按钮组保持右侧位置。

## 1.1.1 - 2026-03-10

- 余额账单模板固定读取 `assets/余额账单模版.xlsx` 当前版本，不再回退到其他路径。
- 明细账单导出改为始终输出完整模版字段；未映射或源值为空时，字段保留且单元格留空。
- 余额账单导出改为按余额模板第一行字段动态补齐列，模板第二行及之后的旧示例数据会在写入前清空。
- 更新 smoke test，覆盖“未映射字段仍保留空列”和“余额模板额外字段保留空列”的导出场景。

## 1.1.0 - 2026-03-10

- 将 `COMMON枚举.xlsx` 作为应用内置资源随安装包分发，启动后自动加载，不再要求用户首次导入枚举表。
- 状态框改为展示内置枚举加载状态，不再承担枚举表导入入口。
- 更新运行说明与打包配置，移除 `init:enum` 启动前置步骤。
- 调整 smoke test，改为校验内置 `COMMON枚举.xlsx`，避免测试脚本覆盖正式枚举文件。

## 1.0.9 - 2026-03-09

- 写死导出格式规则：`Credit Amount`、`Debit Amount` 输出为数字格式。
- 写死导出格式规则：`BillDate`、`ValueDate` 输出为日期格式。
- 写死导出格式规则：`MerchantId`、`Channel` 输出为文本格式。

## 1.0.8 - 2026-03-09

- 将“管理模版”和“账户映射”按钮调整为横向并排居中显示。
- 新增账户映射弹窗预览图脚本，可单独生成账户映射页面截图。

## 1.0.7 - 2026-03-09

- 新增“账户映射”按钮和账户映射弹窗，支持维护网银大账户ID与清结算系统大账户ID文本映射。
- 新增网银大账户ID校验：不能为空、不可重复、仅支持 1-64 位字母、数字、下划线、中划线。
- 导出时若模板映射字段中存在 `MerchantId`，会按账户映射表把对应单元格值替换为清结算系统大账户ID。

## 1.0.6 - 2026-03-09

- 左上角 GIF 调整为距上方和左侧各 0.5cm，尺寸改为 1.5cm * 1.5cm。

## 1.0.5 - 2026-03-09

- 参考 OpenAI 官方品牌页的字体说明，将主标题切换为以 `OpenAI Sans` 为首选、中文无衬线字体为回退的标题字栈。

## 1.0.4 - 2026-03-09

- 继续放大主标题“网银账单小助手”字号，提升页面识别度。

## 1.0.3 - 2026-03-09

- 主标题文案调整为“网银账单小助手”，并进一步增大字号。
- 左上角 GIF 调整为距上方和左侧各 1cm，尺寸改为 2cm * 2cm。

## 1.0.2 - 2026-03-09

- 主页面标题更新为“网银账单生成小助手”，字体调整为微软雅黑 Light 加粗并增加字间距。
- 新增左上角固定循环 GIF 展示。
- 管理模版弹窗移除标题文本，仅保留关闭按钮。
- 枚举表改为首次运行后由用户导入并持久化，废弃根目录静态读取逻辑。
- 状态框首屏提示“请导入网银账单枚举表”，并支持点击状态框导入或覆盖枚举表。
- 仅允许导入文件名带有“枚举”的 `.xlsx` 作为枚举表，空文件或不可读文件会在状态框提示。
- 右下角版本文案改为 `Version`，字体调整为 `Courier New`。
- 新增界面预览图生成脚本。

## 1.0.1 - 2026-03-09

- 新增 Windows `portable` 免安装打包目标，可生成直接运行的单文件 `exe`。
- 新增 `npm run dist:win:portable` 和 `npm run dist:win:setup` 脚本。
- 调整 `npm run dist:win`，默认同时生成安装版和免安装版。
- GitHub Actions 现在同时上传 `windows-installer` 和 `windows-portable-exe` 产物。
- 为 Windows 主进程补充 `AppUserModelId` 设置，提升便携版系统集成兼容性。

## 1.0.0 - 2026-03-09

- 初始化 Electron 桌面端应用骨架，支持 Windows 10 / 11。
- 实现自定义窗口栏、拖拽窗口、最小化 / 最大化 / 关闭。
- 实现模版导入、模版列表管理、映射关系设置与删除确认。
- 实现基于 SQLite 的模版和映射关系持久化。
- 实现 Excel / CSV 导入校验、COMMON 枚举加载、账单转换和 Excel 导出。
- 实现按日期生成输出目录与日志文件。
- 在页面右下角显示应用版本号。
- 补充版本迭代说明和版本回溯文档。
