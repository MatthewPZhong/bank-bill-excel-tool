# tasks — v2.1.0-beta.1 单据对账 ReconID 修复模块

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft） |
| 目标版本 | `v2.1.0-beta.1` |
| 关联 PRD | `PRD-v2.1.0-beta.1.md` |
| 关联 spec | `spec.md` |
| 起草日期 | 2026-04-30 |
| 起草人 | team-lead（PM 角色） |

> 4 个 PR 各自的任务清单。颗粒度按"半小时-2 小时"。每条 task 注明验收证据要求。

---

<!-- 2026-04-30 决策回写：Q4=部分采纳（PR-A 新增 task A9 主面板场景选择下拉，原 8 task → 9 task） -->
## PR-A 骨架

> **目标**：模块入口可达 + 场景 CRUD 跑通 + DB schema 扩展完成；不含算法、不含文件 IO、不含输出。
> **预计工作量**：2-3 天 / 9 个 task（原 8 task；Q4 决策回写新增 A9）

### task A1：扩展 `scenarios.category` CHECK 约束（migration）

- 涉及文件：
  - `src/backend/database/migrations.js`（新增 `ensureScenariosCategoryReconIdFix(db)`）
  - `src/backend/database.js`（在 `runMigrations()` 链路中调用）
  - `src/backend/database/scenarios-repository.js`（`VALID_CATEGORIES` 追加 `'recon-id-fix'`）
- 实施要点：
  - 幂等检查：`SELECT sql FROM sqlite_master` 解析当前 CHECK，已含 `'recon-id-fix'` → no-op
  - BEGIN-RENAME-CREATE-INSERT-DROP-COMMIT 全包事务
  - 保留 `id` 自增序列（重建后 `SELECT id FROM scenarios` 必须与重建前一致）
- 验收证据：
  - `npm run smoke` 全绿
  - 新增 smoke 用例 `scripts/smoke/migrations-recon-id-fix.js`：A1 空库启动 / B1 含 v2.0.0-beta.3 builtin 老库启动 / C1 重复启动幂等
  - 手工：用 v2.0.0-beta.3 老库（含 3 builtin scenarios）启动新版，3 builtin 仍可见
- 关联 spec：§二

### task A2：`settings-repository.js` 模块持久化合法值追加

- 涉及文件：`src/backend/database/settings-repository.js:95`
- 实施要点：`CURRENT_MODULE_VALID` 数组追加 `'recon-id-fix'`
- 验收证据：
  - `npm run smoke` 通过
  - 手工：切到第 5 模块后重启，`current_module='recon-id-fix'` 正常持久化
- 关联 spec：§一.1

<!-- 2026-04-30 决策回写：Q4=部分采纳（A3 panel 新增 select#reconIdFixScenarioSelect） -->
### task A3：`index.html` 模块下拉新增第 5 项 + 新 panel

- 涉及文件：`index.html`
- 实施要点：
  - 第 41-44 行附近：模块下拉新增 `<button class="module-option" data-module="recon-id-fix">单据对账 ReconID 修复</button>`
  - 第 185 行附近：新增 `<section id="reconIdFixModulePanel" class="control-board module-panel recon-id-fix-board" hidden>` panel，结构 fork `bankStatementModulePanel`：
    - 控制行 1：左 ▶「场景管理」（id=`reconIdFixManageScenariosBtn`）/ 右 ▶「导入文件」（`reconIdFixImportBtn`） **「场景：<select id="reconIdFixScenarioSelect">」（Q4 新增）** 「开始运行」（`reconIdFixRunBtn`）
    - 控制行 2：左 ▶「导出文件」（`reconIdFixExportBtn`）/ 右 ▶ statusBox（`reconIdFixStatusBox`）
  - 场景 `<select>` 初始 disabled + 仅一个 placeholder `<option value="">请选择场景</option>`；后续由 task A9 的 reload 函数填充
- 验收证据：
  - `npm run preview` + 5 模块面板截图
  - 新增 preview state 名 `recon-id-fix-panel`，`scripts/render-preview.js` 注册
- 关联 spec：§一.1、§七

<!-- 2026-04-30 决策回写：Q4=部分采纳（elements 缓存 6 项 + state 加 reconIdFixScenarios 数组） -->
### task A4：`renderer.js` 模块切换 + state + elements + 按钮 binding 占位

- 涉及文件：`src/renderer.js`
- 实施要点：
  - `MODULES.reconIdFix = 'recon-id-fix'`
  - `setCurrentModule(moduleId)` 加分支：当 `moduleId === 'recon-id-fix'` 时显示新 panel，隐藏其他；切到本模块时调用 `reloadReconIdFixScenarios()`（task A9 的 reload）
  - `elements` 缓存 **6** 个 DOM（task A3 列出的 id；Q4 新增 `reconIdFixScenarioSelect`）
  - `state` 加 5 字段：`reconIdFixSession / reconIdFixResult / reconIdFixExport / reconIdFixSelectedScenarioId / reconIdFixScenarios`（前 4 初始 null，最后 1 个初始 `[]`）
  - 4 按钮 binding 占位（仅 alert "PR-B 落地" 提示；"场景管理"按钮直接调起 `createScenariosManagerDialog`）
- 验收证据：
  - `npm run smoke` 通过
  - GUI 实测：切换到第 5 模块 panel 显示正确，4 按钮可点（其中 3 个仅 alert 占位）
- 关联 spec：§六、§七、§一.1

### task A5：`createScenarioCategorySelectDialog` 三选一扩四选一

- 涉及文件：`src/renderer-dialogs.js:5525` 附近
- 实施要点：
  - 现有 3 个单选项加第 4 项「单据对账 ReconID 修复」（value=`'recon-id-fix'`）
  - 类别图标 / 副标题等装饰沿用 v2.0.0-beta.3 风格
- 验收证据：
  - `npm run preview:scenario-category-select` 截图含 4 项
- 关联 spec：§一.1

### task A6：`createScenariosManagerDialog` 表格"功能类别"列文案映射追加

- 涉及文件：`src/renderer-dialogs.js:5381` 附近
- 实施要点：
  - 找到现有 category → 显示名 映射（v2.0.0-beta.3 PR #33 已统一为 3 项）
  - 追加 `'recon-id-fix' → '单据对账修复'`
  - 编辑/查看时类别 → dialog 路由（`src/renderer-dialogs.js:65-67`）追加 `'recon-id-fix' → createScenarioConfigDialogC4`
- 验收证据：
  - `npm run preview:scenarios-manager` 截图含 C4 行（如有 mock 数据）
- 关联 spec：§一.1

### task A7：新增 `createScenarioConfigDialogC4` dialog factory（**核心**）

- 涉及文件：`src/renderer-dialogs.js`（新增约 600-800 行）
- 实施要点：
  - 5 行布局（详见 spec §八.1）
  - 行 2：3 勾选框 + 1v多 / 多v1 互斥逻辑（jQuery onchange）
  - 行 3：动态行 + 序号 +1 + 主/从联动字段下拉 + 7 op 下拉 + ❌ 删除 + 行内"新增"
  - 行 4：动态行 + 类型号下拉（动态 enum）+ 主从字段下拉 + ❌ + "新增"
  - 行 5：互斥勾选 + 主从都修复展开共同 ID 区 + SubBizType 三选一
  - 「识读场景规律」按钮 + tooltip（PR-A 仅占位 alert，PR-C 实装）
  - 「完成」→ 校验 + `desktopApi.scenarios.create / update`
  - 「取消」/「返回」→ 复用 v2.0.0-beta.3 PR #33 `state.scenarioDraft` 模式
  - mode='create'/'edit'/'view' 三态（view 时所有控件 disabled）
- 验收证据：
  - `npm run preview:scenario-config-c4` 新增 4 张截图（create / edit / 主从都修复 / SubBizType 三选一）
  - GUI 实测：从场景管理"新增场景"→ 类别选择"单据对账 ReconID 修复" → C4 dialog 5 行渲染正确，互斥逻辑工作
- 关联 spec：§八.1、§八.2

### task A8：`createScenarioConfirmDetailDialog` 增 C4 文本预览

- 涉及文件：`src/renderer-dialogs.js`（约 6436 行附近）
- 实施要点：在 switch case 中加 `case 'recon-id-fix'` → 按 PRD §七.2 模板渲染文本预览
- 验收证据：
  - `npm run preview:scenario-confirm-detail` 截图含 C4 模板
  - GUI 实测：C4 dialog 完成 → 弹"确认场景详情" → 文本预览内容与 dialog 字段一致
- 关联 spec：PRD §七.2

<!-- 2026-04-30 决策回写：Q4=部分采纳（新增 task A9 主页面场景选择下拉） -->
### task A9：主页面"场景"选择下拉框（**Q4 决策新增**）

> Q4 决策（2026-04-30）：主面板控制行 1 在「导入文件」与「开始运行」之间新增一个单选下拉，让用户在执行前选定要跑的 C4 场景。

- 涉及文件：
  - `src/renderer.js`（新增 `reloadReconIdFixScenarios()` + select 事件 binding + run 按钮联动 + reload 触发点接入）
  - `src/renderer-dialogs.js`（场景管理 dialog 关闭回调 / 4 个 `scenarios:*` 操作完成后调用 reload）
  - `index.html`（select 元素已由 task A3 提供，本任务仅复用）
- 实施步骤（5 步）：
  1. **获取场景列表**：`reloadReconIdFixScenarios()` 调 `desktopApi.scenarios.list()` → 按 `category === 'recon-id-fix'` filter → 写入 `state.reconIdFixScenarios`
  2. **渲染下拉**：清空 `<select id="reconIdFixScenarioSelect">` → 加 `<option value="">请选择场景</option>` → 按 `state.reconIdFixScenarios` 顺序追加 `<option value="{id}">{name}</option>`；空数组时 select disabled + placeholder 改为"请先在场景管理中创建场景"
  3. **下拉变更**：`select.onchange` → `state.reconIdFixSelectedScenarioId = parseInt(value, 10) || null` → 调 `updateReconIdFixRunBtnEnabled()`
  4. **场景列表变更后实时刷新**：场景管理 dialog 关闭时（不论用户做了什么）调 `reloadReconIdFixScenarios()`；同时 `scenarios:create / update / delete / toggle-enabled` 任一 IPC 成功后也 reload；reload 后若原选中 id 已不存在 → 置 null + 按钮 disable + statusBox 文案回退到"已选场景未选/初始"
  5. **联动「开始运行」按钮**：`updateReconIdFixRunBtnEnabled()` = 按 spec §七 按钮可用性表逻辑（`reconIdFixSession !== null && reconIdFixSelectedScenarioId !== null`）；`recon-id-fix:run` IPC 调用时把 `state.reconIdFixSelectedScenarioId` 作为 `scenarioId` 字段传入（PR-B task B12 接通时使用）
- 验收证据（5 步对应 5 项）：
  1. ✅ 切换到第 5 模块时，控件 console 打印命中 `desktopApi.scenarios.list()` + filter 结果
  2. ✅ `npm run preview:recon-id-fix-panel`（task A3 已注册）截图含 select；空场景态 + 含场景态各 1 张
  3. ✅ GUI 实测：选不同场景 → state 字段更新 + run 按钮 enable/disable 切换
  4. ✅ GUI 实测：在场景管理中"新增/编辑/删除/启用切换"任一操作 → 主面板下拉立即同步；删除当前选中场景 → 下拉回到"请选择场景"+ run 按钮 disable
  5. ✅ GUI 实测（PR-B 实施时再补）：选场景 → 导入文件 → 点开始运行 → main 进程接收到的 payload 含正确 scenarioId
- 关联 spec：§七、§一.1、PRD §三 D10 / D11 / 6.1

### PR-A 验收清单

- [ ] task A1-A9 全部 done
- [ ] `npm run smoke` 全绿（含 migrations-recon-id-fix.js 新 smoke）
- [ ] `npm run preview` + `npm run preview:all` 全部正常（含 5 个新 preview）
- [ ] `npm run check:vars` 输出"⚠️ 关联功能 review"段：命中 `MODULES` / `state` / `elements` / `dialog`（Runtime-state）+ `ipcRenderer`（Important-skeleton）+ `hasColumn` / migrations 新函数（Risk-sensitive）
- [ ] GUI 实测：5 模块切换正常 + 第 5 模块 4 按钮可点 + 场景管理 C4 类 CRUD 跑通（创建/编辑/查看/删除/启用切换）
- [ ] 老库迁移测：v2.0.0-beta.3 用户库（带 3 builtin）切到本版，3 builtin 仍可编辑可启用
- [ ] PRD §十六 PR-A 实施记录补全（草稿 / 初版 / 最终 + commit hash + 测试证据）

---

## PR-B 对账引擎

> **目标**：导入 4 sheet → 跑场景 → 导出 15 列「订单修复」文件全链路打通。
> **预计工作量**：4-5 天 / 13 个 task

### task B1：字段常量 `src/constants/recon-id-fix-fields.js`

- 涉及文件：`src/constants/recon-id-fix-fields.js`（新增）
- 实施要点：复制 spec §四四组常量 + 4 sheet 名常量
- 验收证据：
  - smoke 用例 `scripts/smoke/recon-id-fix-engine.js` 中 require 该常量并断言数组长度（18/23/22/15）
- 关联 spec：§四

### task B2：`recon-id-fix-io.js` 4 sheet 读 + 校验

- 涉及文件：`src/main-process/recon-id-fix-io.js`（新增）
- 实施要点：
  - `readReconIdFixFile(filePath)` 用 SheetJS 读 4 sheet
  - 用 `sheetToObjects` 模式（参考 v2.0.0-beta.3 `bank-statement-io.js`）
  - 4 sheet 缺一即 FileValidationError code='missing-sheet'
  - 各 sheet 表头与 spec §四常量严格比对（顺序+长度）
  - 「订单修复」sheet 仅取 headers 不取 rows
- 验收证据：
  - `scripts/smoke/recon-id-fix-io.js` 含 7 用例（4 sheet 各 1 + 列校验失败 + writer round-trip + 空命中）
- 关联 spec：§五.1

### task B3：`recon-id-fix-io.js` writer

- 涉及文件：`src/main-process/recon-id-fix-io.js`
- 实施要点：
  - `writeReconIdFixOutput({ fixedRows, savePath })` 用 `xlsx-js-style`（避免引入 exceljs；与 pending-session 一致）
  - 单 sheet `'订单修复'` + 表头 = `ORDER_REPAIR_FIELDS`
  - 表头字号 10pt（applyHeaderRowFont 模式）
  - `buildMainOutputFileName(scenarioName)` = `单据对账修复-YYYYMMDDHHmm-{sanitize(scenarioName)}.xlsx`
  - 复用 v2.0.0-beta.3 `sanitizeFileName` 的实现（控制字符/禁用字符/Windows 保留名/长度兜底）
- 验收证据：
  - smoke 测试 round-trip：写入 → 重新读取 → 数据一致
- 关联 spec：§五.1、§三

### task B4：`scenario-engines/c4-recon-id-fix.js` 主入口 + 7 条规则 + **Round 4 subset-sum 池子重写**

- 涉及文件：`src/main-process/scenario-engines/c4-recon-id-fix.js`
- 实施要点（**Round 4 重写**）：
  - `runC4Scenario(scenario, sheets) → { fixedRows, warnings, unmatchedRows, stats }`
  - 复用 `engine-utils.js`：`evaluateCondition` / `makeWarningCollector` / `normalizeCellValue`
  - 实现 R1-R7 七条规则（PRD §七.3.2）
  - 5 阶段：
    - `tryOneToOne(leftRows, rightRows, fieldPairs, billDateMode, ...)` — Step 1（strict）/ Step 2（±1day）共用
    - **Round 4**：`tryOneToManyPool(leftRows, rightRows, fieldPairs, billDateMode, ...)` — Step 3.1（strict）/ Step 3.2（±1day），改 subset-sum 语义
    - **Round 4**：`tryManyToOnePool(leftRows, rightRows, fieldPairs, billDateMode, ...)` — Step 3'.1 / Step 3'.2，对称 subset-sum
  - **Round 4 新增工具函数**：
    - `toCents(amount)` — 浮点 ×100 整数化避精度坑
    - `rowsMatchOtherFieldPairs(left, right, otherFieldPairs)` — 池子候选过滤"除 Amount 外其他对账字段 AND 全等"
    - `enumerateAmountSubsets(candidates, targetCents, maxSize=8, maxSolutions=64)` — DFS + 升序剪枝枚举所有解
    - `tieBreakSubsets(subsets, mainBillDate)` — 多解时按 spread → distToMain → size → firstIdx 字典序排序取首
  - 沿用 Round 3：`findAmountLockedPair(fieldPairs)` / `billDateMatches(L, R, mode)` / `parseBillDateMs(s)`
  - `collectUnmatchedRows(mainTyped, oppTyped, pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, matchRules, scenarioName)` 收集未配主从 + deriveReason
  - `lookupReconId`：直读 opCounterRow.reconId
  - `resolveSubBizType`：mode='auto' 查 reconResult；'manual*' 取手填
- 验收证据：
  - `scripts/smoke/recon-id-fix-engine.js` Round 4 重写：原 22 用例 + 7 个 Round 4 新增（subset-sum helpers + 用户用例 + 找不到子集 + 浮点精度 + 大候选集性能 + tieBreak 多解 + 多v1 对称）= 29 用例
- 关联 spec：§五.2 / §五.4 / §五.2.4 / §五.2.4.1

### task B5：`scenario-engines/c4-recon-id-fix.js` 5 条规则（主从都修复）— **Round 3 RB4 Type=0 / Round 4 subset-sum 命中后赋值**

- 涉及文件：同 task B4
- 实施要点：
  - 实现 RB1-RB5 五条规则（PRD §七.3.3）
  - **Round 3 修订**：`apply1vNAssignment` 在 mode='both' 分支中 right Type 由 `2` 改为 `0`（Decision 1）
  - **Round 4 沿用**：`apply1vNAssignment` / `applyNv1Assignment` 接收 subset-sum tieBreak 后的 chosen 子集（不再是全 candidates），逐行赋值
  - `computeCommonId(commonIdCfg, leftRow, rightRow)` = src.reconId + suffix（PR-B Q2=a 已落）
  - mode='both' 时同时往 fixedRows 推 leftRow 和 rightRow 两条
- 验收证据：
  - smoke 含 RB1/RB2/RB3/RB4 Type=0/RB5 用例（Round 4：RB2 / RB4 改为 subset-sum 命中场景）
- 关联 spec：§五.2.6

### task B6：`recon-id-fix-engine.js` 顶层入口

- 涉及文件：`src/main-process/recon-id-fix-engine.js`（新增，约 30 行）
- 实施要点：
  - `runReconIdFix(scenario, sheets)` 校验 category=='recon-id-fix'  → 调 `runC4Scenario`
  - 不接入 v2.0.0-beta.3 的 `scenario-dispatcher.js`（本模块单场景跑，不需要 first-match-wins）
- 验收证据：smoke 端到端用例（task B11）会覆盖
- 关联 spec：§五.2

### task B7：`main.js` IPC `recon-id-fix:import`

- 涉及文件：`src/main.js`（追加）
- 实施要点：
  - `dialog.showOpenDialog` → 选 .xlsx
  - 调 `readReconIdFixFile` → 落 `reconIdFixSession`
  - 重新导入清空 `reconIdFixResult`（资金红线）
  - FileValidationError 走 invalid 分支带 detailLines
- 验收证据：smoke + GUI 实测
- 关联 spec：§三、§六

### task B8：`main.js` IPC `recon-id-fix:run`

- 涉及文件：`src/main.js`
- 实施要点：
  - 校验 `reconIdFixSession` 存在 + scenarioId 是 C4 类
  - structuredClone 三个 sheet 的 rows（避免 in-place 污染）
  - 调 `runReconIdFix(scenario, clonedSheets)`
  - 落 `reconIdFixResult` + scenariosSnapshot（spec §十.2）
  - 返回 stats
- 验收证据：smoke + GUI 实测
- 关联 spec：§三、§六

### task B9：`main.js` IPC `recon-id-fix:export` + defense in depth — **Round 3 双文件输出**

- 涉及文件：`src/main.js`
- 实施要点（**Round 3 修订**）：
  - 校验 `reconIdFixResult` 存在
  - **资金红线 defense in depth**：重读 scenario + 比对 snapshot；不一致拒绝
  - **空命中 + 空 unmatched** → 返回 `status='empty'`，不弹 saveDialog
  - 至少一方非空 → 弹 saveDialog（用户选主文件保存路径）；timestamp 在 export 入口生成，主+unmatched 共用
  - 主文件非空 → 调 `writeReconIdFixOutput`
  - unmatched 非空 → 在主文件保存目录用 `buildUnmatchedReportFileName` 生成路径，调 `writeUnmatchedReport`
  - 返回 `{ status, mainFilePath?, mainFileName?, unmatchedFilePath?, unmatchedFileName?, rowCount, unmatchedCount }`
- 验收证据：smoke 含 4 用例（正常主+unmatched / 仅主 / 仅 unmatched / 都空 → empty / snapshot 不一致 / 用户取消）
- 关联 spec：§三、§五.4、§十

### task B10：`main.js` 4 IPC 入口同步清缓存（资金红线）

- 涉及文件：`src/main.js`
- 实施要点：
  - 在 `scenarios:create` / `scenarios:update` / `scenarios:delete` / `scenarios:toggle-enabled` 4 个 handler 已有 `processingResult = null` 之后追加 `reconIdFixResult = null`
- 验收证据：
  - smoke 用例：先 run 后改场景 → 再 export 拒绝
- 关联 spec：§十.1

### task B11：`main.js` IPC `recon-id-fix:session-status` + preload 暴露

- 涉及文件：`src/main.js` + `src/preload.js`
- 实施要点：
  - main.js: `recon-id-fix:session-status` handler 返回 4 字段
  - preload.js: 暴露 `desktopApi.reconIdFix.{import, run, export, sessionStatus}`
- 验收证据：renderer 启动时调用刷新 statusBox 不报错
- 关联 spec：§三、§十一

<!-- 2026-04-30 决策回写：Q4=部分采纳（B12 接通主面板下拉传 scenarioId） -->
### task B12：`renderer.js` 4 按钮接通 — **Round 3 statusBox 加 unmatched 档**

- 涉及文件：`src/renderer.js`
- 实施要点：
  - 「导入文件」→ `desktopApi.reconIdFix.import` + 错误提示 + statusBox 文案
  - 「开始运行」→ 取主面板"场景"下拉值 = `state.reconIdFixSelectedScenarioId` → `desktopApi.reconIdFix.run({ scenarioId })` + statusBox
  - 「导出文件」→ `desktopApi.reconIdFix.export` + saveDialog cancel/empty/ok 三态文案；**Round 3 status='ok' 时 statusBox 显示主+unmatched 双文件名**
  - statusBox 文案：
    - 已运行：`场景"X"运行完成；命中 N 行修复，M 行警告，K 行未匹配`（Round 3 加"K 行未匹配"档）
    - 已导出（仅主）：`已导出 mainFile`
    - 已导出（仅 unmatched）：`已导出未匹配 report unmatchedFile`
    - 已导出（双文件）：`已导出 mainFile / unmatchedFile`
- 验收证据：GUI 全链路 smoke
- 关联 spec：§七

### task B13：端到端 smoke — **Round 3 重写**

- 涉及文件：`scripts/smoke/recon-id-fix-end-to-end.js`
- 实施要点（**Round 3 重写**）：
  - 用例：5 阶段端到端 mode=main / opp / both（含 unmatched 输出）+ "基金"真实 fixture 全量回归
  - 真实 fixture 跑通后断言 `fixedRowCount + unmatchedRowCount = mainTyped.length + oppTyped.length`（每行最多被分配到主/未配两边之一，但 fixedRows 中 1v多 / 多v1 会展开多行）
- 验收证据：smoke 全过 + runner 注册
- 关联 spec：§九.2

### task B14：unmatched 报告 writer + smoke — **Round 3 新增**

- 涉及文件：
  - `src/main-process/recon-id-fix-io.js` — 新增 `writeUnmatchedReport` + `buildUnmatchedReportFileName`
  - `scripts/smoke/recon-id-fix-io.js` — 增 round-trip 用例 + 命名用例
- 实施要点：
  - `writeUnmatchedReport({ unmatchedRows, savePath })` — sheet 名"未匹配单据" / 6 列表头 / 字号 10pt
  - `buildUnmatchedReportFileName(scenarioName, timestamp)` — `单据对账修复-未匹配-{timestamp}-{sanitize(name)}.xlsx`
- 验收证据：
  - smoke 用例：写 → 重新读 → 6 列匹配 / 行数相等 / 表头字号 10pt
  - smoke 用例：unmatchedRows=[]时仍写空 sheet（仅表头）
- 关联 spec：§五.4

### task B15：C4 dialog Amount 字段对锁定 — **Round 3 新增（Decision 4）**

- 涉及文件：
  - `src/renderer-dialogs.js` — `createScenarioConfigDialogC4` 行 4 渲染 + 数据初始化
  - `src/backend/database/migrations.js` — 新增 `migrateC4ReconGroupsAmountLockedFieldPair(db)`
  - `src/backend/database.js` — 调用新 migration
  - `scripts/smoke/migrations-recon-id-fix.js` — 加 H 系列用例
- 实施要点：
  - `createDefaultScenarioConfig('recon-id-fix')` 改 reconGroups 默认值：
    `[{ leftTypeSeq:1, rightTypeSeq:1, fieldPairs: [{ leftField:'Amount', rightField:'Amount', locked: true }] }]`
  - dialog 渲染 reconGroups 时：`fp.locked === true` → leftField/rightField select 加 disabled + 隐藏 ❌ 删除按钮（无 `data-c4-rg-fp-action="remove"` 按钮渲染）
  - "+ 新增字段对"按钮 push 新 fieldPair 不带 locked 标记
  - "+ 新增 OR 分组"按钮 push 新 group 时**默认带 Amount 锁定 fieldPair 作为第一行**：
    `{ leftTypeSeq, rightTypeSeq, fieldPairs: [{ leftField:'Amount', rightField:'Amount', locked: true }] }`
  - migration `migrateC4ReconGroupsAmountLockedFieldPair`：
    1. 老 reconGroups 中 fieldPair 恰好 leftField=='Amount' && rightField=='Amount' 但无 locked → 加 `locked: true`
    2. 老 reconGroups 中无 Amount/Amount fieldPair → 在 fieldPairs 数组**头部插入** `{leftField:'Amount', rightField:'Amount', locked: true}`
    3. 已含 locked Amount/Amount → no-op（幂等）
- 验收证据：
  - smoke 用例 H1 / H2 / H3：3 种 migration 路径
  - GUI 实测：dialog 默认渲染 Amount 锁定行 + 锁定 select 不可改 + 删除按钮不可见 + + 新增字段对仍可工作 + + 新增 OR 分组带 Amount 锁定行
- 关联 spec：§一 1.2 / §八.1 / 数据模型 §八.2

### task B16：renderer.js statusBox 加 unmatched 档 — **Round 3 新增**

- 涉及文件：`src/renderer.js`
- 实施要点：
  - statusBox 文案在"已运行"档加 `K 行未匹配`
  - "已导出"档区分仅主 / 仅 unmatched / 双文件 三态
- 验收证据：GUI 实测
- 关联 spec：§七

### PR-B 验收清单

- [ ] task B1-B16 全部 done（**Round 3 加 B14/B15/B16**）
- [ ] `npm run smoke` 全绿（baseline 232 + Round 3 新增用例）
- [ ] PRD §十二 P0-1 ~ P0-10 全部手工验证通过（10 个资金红线场景）
- [ ] `npm run check:vars` 输出"⚠️ 关联功能 review"段：命中 `FileValidationError`（Critical）+ `state` / `dialog` / `ipcRenderer`（Runtime-state / Important-skeleton）+ migrations 新函数（Risk-sensitive）
- [ ] **真实 fixture「基金」场景**回归：`/Users/pzhong/Desktop/小助手-Debug/2.0.0/订单枚举表/单据对账导出不平.xlsx` 跑通后输出 fixedRows / unmatchedRows 与期望一致
- [ ] PRD §十六 PR-B 实施记录补全

---

## ~~PR-C 识读规律~~（**已取消** — 2026-05-09）

> **取消原因**：用户决策不再实施识读规律功能（dev round 1 完成 + 用户测试 1 个 UX bug 修复后改主意）
> **C1-C5 task 全部标 CANCELLED**；详见 PRD §十六 PR-C 取消段落
> **原计划**：「识读场景规律」按钮可用 → 自动填表（1.5-2 天 / 5 个 task）

<!-- 2026-04-30 决策回写：Q3=C（颜色冲突取"有数据 cell"最高频色）-->
### task C1：`recon-id-fix-infer.js` 颜色分组

- 涉及文件：`src/main-process/recon-id-fix-infer.js`（新增）
- 实施要点：
  - 引入 `exceljs`（v2.0.0-beta.3 PR #32a 已加依赖；本任务复用）
  - `groupRowsByCellColor(sheet, fields)` 用 ExcelJS row.eachCell 取 cell.fill.fgColor.argb
  - 同色行归到 Map<colorKey, rowObjects[]>
  - 'no-color' = ARGB undefined / 'FFFFFFFF' / fill 缺
  - **同行多色**（Q3=C 决策，2026-04-30）：
    1. 仅统计"有数据的 cell"（cell.value 非 null 且非空字符串）
    2. 统计这些 cell 的 ARGB 出现次数，按 desc 排序，取最高频色
    3. 平票 → 取第一个出现的色（稳定排序）
    4. 全部"有数据 cell"无色 → 归 'no-color'
  - 内部函数 `pickRowColor(row, fields)` 实现上述逻辑（spec §五.3 已落伪代码）
- 验收证据：
  - smoke `scripts/smoke/recon-id-fix-infer.js` 含 2 用例：
    - 1）fixture 文件解析颜色组（默认场景）
    - 2）单行多色冲突场景（mock：3 cell 红 / 2 cell 蓝 → 行色取红）
- 关联 spec：§五.3

### task C2：`recon-id-fix-infer.js` 例子合并 + 候选对账字段挖掘

- 涉及文件：同上
- 实施要点：
  - `mergeColorGroups(businessByColor, opponentByColor)` 同色主从边归一例
  - `mineReconFields(exampleGroups)`：
    - 对每个 (mainField, oppField) 二元组（23 × 22 = 506 候选对）
    - 对每个色组 = 该字段对在该组内"全等行对"占总行对的比例
    - 跨组聚合 = 全等率均值
    - 取 ≥ 0.8 阈值的候选对，按全等率 desc 排序
- 验收证据：
  - smoke 增 1 用例（fixture 推断出预期对账字段）
- 关联 spec：PRD §七.4

### task C3：`recon-id-fix-infer.js` 候选账单类型挖掘

- 涉及文件：同上
- 实施要点：
  - `mineBillTypes(exampleGroups)`：
    - 对每个色组主/从边各自找"组内固定取值的字段"
    - 跨组验证：该字段-值对在其他组都不出现 → 高区分度
    - 输出 `[{seq, side, conditions: [{field, op, value}]}]`
- 验收证据：
  - smoke 增 1 用例（fixture 推断出预期账单类型）
- 关联 spec：PRD §七.4

### task C4：`recon-id-fix:infer-rules` IPC + preload 暴露

- 涉及文件：`src/main.js` + `src/preload.js`
- 实施要点：
  - main.js: handler 调 `inferReconIdFixRules(filePath)`；filePath 未传则弹 dialog.showOpenDialog
  - preload.js: 暴露 `desktopApi.reconIdFix.inferRules`
- 验收证据：smoke 端到端用例
- 关联 spec：§三

### task C5：C4 dialog 接入「识读场景规律」按钮

- 涉及文件：`src/renderer-dialogs.js`（task A7 中 createScenarioConfigDialogC4）
- 实施要点：
  - PR-A 占位的 alert 替换为真实调用 `desktopApi.reconIdFix.inferRules()`
  - 返回 `{billTypes, reconFields}` → 调 dialog 内部"重渲染行 3 + 行 4"函数
  - 弹 toast"已自动填充"
  - 失败 → alert
  - tooltip 文案保持不变（PRD §三 D7）
- 验收证据：
  - GUI 实测：选 fixture 文件 → 自动填表正确
  - smoke 增 1 用例（mock inferRules 返回 + dialog state 更新）
- 关联 spec：§八.4

### PR-C 验收清单

- [ ] task C1-C5 全部 done
- [ ] `npm run smoke` 全绿（含 5 个识读用例）
- [ ] PRD §十二 P2-1 ~ P2-3 手工验证通过
- [ ] GUI 实测：fixture `单据对账导出不平-对平例子.xlsx` 识读后回填到 dialog 行 3/4 + 用户编辑后保存场景
- [ ] PRD §十六 PR-C 实施记录补全

---

## PR-D 收尾

> **目标**：文档三件套 + 版本号 bump + 整体回归 smoke。
> **预计工作量**：1 天 / 5 个 task

### task D1：版本号 bump

- 涉及文件：
  - `package.json` — `"version": "2.0.0"` → `"2.1.0-beta.1"`
  - `package-lock.json` — 同步两处（root + lockfileVersion 内 packages.""）
  - `CLAUDE.md` Branch Structure — `v2.0.0` 行版本号同步（如有）
- 验收证据：
  - `node -p "require('./package.json').version"` 输出 `2.1.0-beta.1`
- 关联 spec：§一.4

### task D2：CHANGELOG.md 新增 v2.1.0-beta.1 段

- 涉及文件：`CHANGELOG.md`（顶部插入新段）
- 实施要点：
  - 新增、变更、修复三块（如适用）
  - 5 模块全景图（4 已有 + 第 5 单据对账 ReconID 修复）
  - 4 PR 汇总（PR-A 骨架 / PR-B 对账引擎 / PR-C 识读规律 / PR-D 收尾）
- 验收证据：手工 review 文档
- 关联 spec：§一.4

### task D3：VERSION_FEATURE_HISTORY.md 新增 v2.1.0-beta.1 段

- 涉及文件：`docs/VERSION_FEATURE_HISTORY.md`
- 实施要点：
  - 新增「单据对账 ReconID 修复模块」段
  - 列出 7+5 规则 + 识读规律入口 + IPC channel
- 验收证据：手工 review 文档
- 关联 spec：§一.4

### task D4：USER_GUIDE.md 新增第 5 模块章节

- 涉及文件：`docs/USER_GUIDE.md`
- 实施要点：
  - 顶部版本号 → `v2.1.0-beta.1`
  - 模块总览：第 5 项「单据对账 ReconID 修复」
  - 新增 1.5 章节：
    - 1.5.1 模块用途
    - 1.5.2 配置场景（5 行 + 截图占位）
    - 1.5.3 对账匹配规则（1v1 / 1v多 / 多v1 三种语义图解）
    - 1.5.4 7+5 赋值规则（表格化）
    - ~~1.5.5 识读场景规律（fixture + tooltip 引用）~~ **DEPRECATED — PR-C 取消（2026-05-09），USER_GUIDE 跳过该节**
    - 1.5.5 输出文件格式（15 列说明）  ← 实际实施：原 1.5.6 上移
    - 1.5.6 常见错误（FileValidationError 5 种）  ← 实际实施：原 1.5.7 上移
- 验收证据：手工 review；截图占位等 PR-D 实施期间补
- 关联 spec：§一.4

### task D5：整体 smoke + check-vars + preview 回归 + git commit

- 涉及文件：—（操作类 task）
- 实施要点：
  - `npm run smoke` 全绿（统计：v2.0.0 GA 78 + v2.1.0 新 ~25 ≈ 103 用例）
  - `npm run check:vars` 输出完整"⚠️ 关联功能 review"段
  - `npm run preview` + `npm run preview:all` 全部正常（含 5 个新 preview）
  - `npm run scan:vars` 重新生成 `docs/analysis/var-reference-stats.md`
  - 新发现的 A-share 条目人工评估升格（spec §九）
- 验收证据：
  - 4 个命令都全绿
  - `docs/analysis/var-reference-stats.md` 有更新
- 关联 spec：—

### PR-D 验收清单

- [x] task D1-D5 全部 done
- [x] `npm run smoke` 全绿（272/272 PASS — 2 次复测一致）
- [x] `npm run check:vars` SKIPPED（PR-D 无 src/ 改动，符合脚本预期）
- [x] `npm run preview` + `npm run preview:all` 全部正常（45 个 preview）
- [x] `npm run scan:vars` 重生成报告（`docs/analysis/var-reference-stats.{md,json}`）
- [x] CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE 三件套全部更新
- [x] `package.json.version` = `2.1.0-beta.1`
- [x] PRD §十六 PR-D 实施记录补全（含 2026-05-11 用户手测通过 + fixture 脚本入仓 + baseline 漂移说明）
- [x] 新增 `scripts/test-v2.1.0-fund-fixture.js` 自动化 P0-5d（3 case PASS：基金 PP-only / 基金 PP+PR / FX 入账）
- [x] 用户手测 P1-1 ~ P1-9 + P0-9 stale-snapshot 文案全过
- [x] 提 PR：`v2.1.0 → main`（PR #37，2026-05-11）

---

## 跨 PR 通用约束

每个 PR 提交前：

1. ✅ 跑 `npm run smoke`
2. ✅ 跑 `npm run check:vars`（必须的硬节点：team-lead 提 PR 前 / 版本号 bump / 合并到受保护分支前）
3. ✅ 跑 `npm run preview`（前端改动 PR）
4. ✅ PRD §十六 实施记录草稿先填（commit `[v2.1.0-beta.1] docs(PR-X): 归档草稿（待 merge，integrated=false）`）
5. ✅ 草稿先放 `docs/prs/待merge-PR #N.md`
6. ✅ 提 PR 后 rename `docs/prs/PR{N}-v2.1.0-beta.1.md`
7. ✅ merge 后回写 PRD §十六（integrated=true）
