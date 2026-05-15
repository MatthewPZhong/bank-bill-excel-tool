# Tasks — v2.1.5 任务拆分

> 关联 `PRD-v2.1.5.md` / `spec.md`（同目录）
> 文档版本：v0.3（2026-05-15 fix1：用户测试反馈追加 T6 fix1.1 C3 条件 row 列宽固定 + T7 fix1.2 场景下拉自动选第 1 个）<br>v0.2（2026-05-15 重写：N3 由 C4/gateway-recon-id-fix 修正为 C3/gateway-recon-join，子任务重新拆分）
>
> 工作分支：`v2.1.5`（基于 main `f7358ec`，已切出）
> PR 计划：单 PR — `v2.1.5 → main`（3 块改动 + 2 个 fix1 修订，规模适中，无需拆分）

---

## 任务执行顺序

```
T0 (PM/spec) ──→ T1.1 ─→ T1.2 ─→ T1.3 ─→ T1.4   (N1 模块名字面替换 — 4 子任务)
                                            │
                                            └─→ T2 (N2 场景下拉)
                                                  │
                                                  └─→ T3.1 ─→ T3.2 ─→ T3.3 ─→ T3.4 ─→ T3.5  (N3 — 5 子任务)
                                                                                          │
                                                                                          └─→ T4 (smoke + preview + check-vars)
                                                                                                │
                                                                                                ├─→ T6 (fix1.1 CSS) ─→ T7 (fix1.2 reload) ─→ docs(fix1) ─→ preview refresh   ← v0.3 用户测试反馈
                                                                                                │
                                                                                                └─→ T0' (version bump) ─→ T5' (docs 三件套 + PR 草稿) ─→ T5 (PR 提交)
                                                                                                              │
                                                                                                              └─→ self-review (I1 preview fixture + M1-M6 docs)   ← v0.3 独立 reviewer 反馈
```

**并行度建议**：
- T1.1 / T1.2 / T1.3 / T1.4 可并行（独立文件；T1.2/T1.3 都改 main.js 需注意冲突，T1.4 改 usage-stats.js 完全独立）
- T2 独立（renderer.js 单函数）
- T3 各子任务依赖：T3.1（默认配置）→ T3.2（dialog UI 行 + 数据流）→ T3.3（dialog 校验）→ T3.4（confirm 预览）→ T3.5（引擎接入）

---

## T0 — PM/spec 拍板（本任务）

**Owner**：team-lead（PM）

**Input**：用户需求文本（v2.1.5 3 点需求）+ 范围更正反馈（N3 由 C4 修正为 C3）

**Output**：
- `docs/iterations/v2.1.5/PRD-v2.1.5.md`（v0.2 重写）
- `docs/iterations/v2.1.5/spec.md`（v0.2 重写）
- `docs/iterations/v2.1.5/tasks.md`（v0.2 重写，本文）
- `package.json` bump 2.1.4 → 2.1.5（已 bump）

**Verify**：
- [x] 三件套已生成（v0.2 重写完成）
- [x] 用户对 PRD §十 / spec §十 待澄清问题（Q1 / Q2）确认拍板（2026-05-15 拍板：Q1 走 / Q2 弹）
- [x] 分支已切到 `v2.1.5`，基于 main

**当前状态**：v0.2 重写完成，等待用户拍板待澄清问题后进入 Dev 阶段

---

## T1 — N1 模块名加空格（4 子任务）

### T1.1 — renderer 模块名字面替换

**Owner**：dev

**Input**：spec §2.1 第 1 行

**Output**：
- `src/renderer.js:63` `MODULE_REGISTRY.reconIdFix.name`：`'对账单ReconID修复'` → `'对账单 ReconID 修复'`

**改动类型**：字面替换 1 处

**新建辅助函数**：无

**Verify**：
- [x] grep `'对账单ReconID修复'` 在 `src/renderer.js` 应 0 命中（注释除外）
- [x] `npm start` 后主页面左上角模块切换按钮显示「对账单 ReconID 修复」（含 2 空格）
- [x] `npm run preview` 重跑（CLAUDE.md memory `workflow_frontend_previews`）

**关联功能 review 命中预判**：
- ⚠️ `MODULE_REGISTRY.reconIdFix.name`（v2.1.4 升格 Important-skeleton）

**估时**：10 min

---

### T1.2 — main.js trackedIpcHandle moduleKey 字面替换

**Owner**：dev

**Input**：spec §2.1 第 2/3/5 行

**Output**：
- `src/main.js:3136` `trackedIpcHandle('recon-id-fix:import', '对账单ReconID修复', ...)` → `'对账单 ReconID 修复'`
- `src/main.js:3187` `trackedIpcHandle('recon-id-fix:run', '对账单ReconID修复', ...)` → `'对账单 ReconID 修复'`
- `src/main.js:3238` `trackedIpcHandle('recon-id-fix:export', '对账单ReconID修复', ...)` → `'对账单 ReconID 修复'`

**改动类型**：字面替换 3 处

**新建辅助函数**：无

**Verify**：
- [x] grep `'对账单ReconID修复'` 在 `src/main.js` 应 0 命中（注释除外）
- [x] 跑应用 → 进对账单 ReconID 修复模块 → 跑导入/运行/导出 → 关闭 → 检查 `<storageRoot>/.usage-stats.txt`，应有 `[对账单 ReconID 修复]` section + 3 个 fnKey 各 ≥ 1

**关联功能 review 命中预判**：
- ⚠️ `trackedIpcHandle` 第 2 参（Important-skeleton）

**估时**：10 min

---

### T1.3 — main.js error message 字符串字面替换

**Owner**：dev

**Input**：spec §2.1 第 4 行

**Output**：
- `src/main.js:3202`：`场景 "${scenario.name}" 不是对账单ReconID修复类，无法运行` → `场景 "${scenario.name}" 不是对账单 ReconID 修复类，无法运行`

**改动类型**：字面替换 1 处

**新建辅助函数**：无

**Verify**：
- [x] 在 gateway session 中跑「开始运行」选择 business 场景（或反之）→ 弹错时显示新文案（含空格）
- [x] grep `'对账单ReconID修复'` 在 `src/main.js` 应 0 命中（与 T1.2 一并验证）

**估时**：5 min

---

### T1.4 — usage-stats.js FUNCTION_REGISTRY key 修复 long-standing bug

**Owner**：dev

**Input**：spec §2.1 第 6 行 + spec §2.3

**Output**：
- `src/backend/usage-stats.js:31`：`'单据对账ReconID修复': ['导入文件', '开始运行', '导出文件'],` → `'对账单 ReconID 修复': ['导入文件', '开始运行', '导出文件'],`

**改动类型**：字面替换 1 处（key 名）

**新建辅助函数**：无

**Verify**：
- [x] grep `'单据对账ReconID修复'` 在 `src/backend/usage-stats.js` 应 0 命中
- [x] 启动新 DB 应用 → 进对账单 ReconID 修复模块跑 1 次 → 关闭 → cat `.usage-stats.txt`，应包含 `[对账单 ReconID 修复]` section + 3 个 fnKey 至少各 1
- [x] 旧 DB（含历史 `[单据对账ReconID修复]` section）启动 v2.1.5 → 跑 1 次 → 关闭 → cat 文件：旧 section 不再出现，新 section 出现（smoke U15 round-trip 已防回归）

**关联功能 review 命中预判**：
- ⚠️ `FUNCTION_REGISTRY`（Important-skeleton；本次修 long-standing bug 即修复了"对账单 ReconID 修复"模块的 calc 链路）

**风险提醒**：
- ⚠️ **资金 / 计费**：usage-stats 是「计数」，不是「资金」算法；属 Risk-sensitive 但非 Critical。但仍需在 PR body 「⚠️ 关联功能 review」段落中显式标注

**估时**：15 min

---

## T2 — N2 场景下拉空状态优化

**Owner**：dev

**Input**：spec §三

**Output**：
- `src/renderer.js:3570-3608` `renderReconIdFixScenarioSelect`：
  - 档 2 改为 `<option value=""></option>`（去掉「请先在场景管理中创建场景」文案）
  - 档 3 改为直接列 scenarios（去掉「请选择场景」占位项）+ 用 `select.selectedIndex = -1` 显式置未选

**改动类型**：单函数 ~15 行改造

**新建辅助函数**：无

**Verify**：
- [x] 主面板「账单类别」选 gateway + DB 该类别下无场景 → 场景下拉显示真空白 + disabled
- [x] 主面板「账单类别」选 gateway + DB 有 ≥ 1 场景 → 场景下拉直接列 scenarios ~~select 显示空白（selectedIndex = -1），未主动选时「开始运行」按钮 disabled~~ — **v0.3 fix1.2 翻转：自动选第 1 个场景 + 按钮 enable**（详见 spec §3.5）
- [x] 旧 v2.1.4 用户 DB 启动 → 行为按上述两档分流（fix1.2 后旧 DB 也自动选第 1 个）
- [x] grep `state.reconIdFixSelectedScenarioId` 用法，确认无任何代码假设 select.value 与 state 一一映射

**关联功能 review 命中预判**：
- ⚠️ `state.reconIdFixSelectedScenarioId`（Runtime-state；select.value / selectedIndex 与 state 一致性）

**估时**：30 min

---

## T3 — N3 C3「条件」栏（5 子任务）

### T3.1 — DB 默认配置 + dialog 兜底

**Owner**：dev

**Input**：spec §4.1.2 + §4.1.3

**Output**：
- `src/renderer-dialogs.js:5719-5724` `createDefaultScenarioConfig('gateway-recon-join')` 返回值新增 `conditions: []` 字段
- `src/renderer-dialogs.js:5990-5993` `createScenarioConfigDialogC3` 函数顶部 config 归一化段后追加旧 v2.1.4 兜底：

  ```javascript
  if (!Array.isArray(config.conditions)) {
    config.conditions = [];
  }
  ```

**改动类型**：默认配置 +1 字段；dialog 入口归一化 ~3 行

**新建辅助函数**：无

**Verify**：
- [x] 新建 C3 场景 → draft.config.conditions === []
- [x] 旧 v2.1.4 DB 中已存在的 C3 scenario（无 config.conditions）打开 dialog → config.conditions 自动初始化为 []（smoke C3-COND-LEGACY 已覆盖）
- [x] v2.1.5 创建带 conditions 的 scenario → 重新打开 dialog 显示原 conditions

**估时**：15 min

---

### T3.2 — Dialog UI 行 + 数据流（DOM + 渲染 + 事件）

**Owner**：dev

**Input**：spec §4.2

**Output**：
- `src/renderer-dialogs.js:5999-6038` `createScenarioConfigDialogC3` `dialog.innerHTML` 模板：在「优先级」与「对账字段」之间插入「条件」栏 DOM（spec §4.2.1）
- 函数内新增辅助：
  - `renderC3ConditionRow(cd, idx, totalCount)` — 单行渲染（spec §4.2.2）
  - `renderC3Conditions()` — 整体列表渲染（容器 `[data-multi="c3-conditions"]`）
- 函数内绑定事件：
  - `change` 事件 — `side` 切换重渲 + 清空 field；`op` 切换隐藏/显示 value；其它字段同步到 `config.conditions[idx][f]`
  - `input` 事件 — value 输入同步到 `config.conditions[idx].value`
  - `click` 行末 × — splice 删除（柔性，可删完）
  - 「+ 新增条件」按钮 click — push 默认条件 + 重渲

**改动类型**：dialog 模板插入新行（~12 行 HTML） + 2 个内部辅助函数（~30 行）+ 4 段事件绑定（~40 行）

**新建辅助函数**：是（2 个，均在 `createScenarioConfigDialogC3` 闭包内）

**Verify**：
- [x] 场景管理 → 新增 C3 场景 → 配置 dialog 在「优先级」与「对账字段」之间显示「条件」label + 空容器 + 「+ 新增条件」按钮（默认 0 条）
- [x] 点「+ 新增条件」加 1 条，左一默认「网关」+ 左二字段下拉 31 列
- [x] 左一切到「银行」→ 左二字段下拉重渲 45 项 + 当前值清空
- [x] 左三切「空值/非空值」→ 右值输入框 hidden
- [x] 行末「×」始终显示，点击删除该行（含删完最后一行的合法性）
- [x] ~~CSS 样式与既有 multi-row（如 C1 的 conditions / 既有 C3 的 reconFields）一致（沿用 `.scenario-config-row-multi` / `.scenario-config-multi-rows` 类）~~ — **v0.3 fix1.1 翻转：改用专属 class `.scenario-config-c3-cond-row`（grid 布局）+ `.scenario-config-c3-cond-field`（240px 固定）**，避免 GATEWAY_RECON_FIELDS 超长字段名（'Type(0:1对1...)'）撑大 row 宽度（详见 spec §4.8）

**估时**：1.5h

---

### T3.3 — Dialog 校验（柔性 + side/field 一致性）

**Owner**：dev

**Input**：spec §4.3

**Output**：
- `src/renderer-dialogs.js:5841-5846` `validateScenarioDraft` 内 `'gateway-recon-join'` 分支末尾追加 conditions 校验段（spec §4.3）：
  - conditions.length === 0 → 通过（柔性）
  - ≥ 1 行 → 每行 side 必填、field 必填、非「空值/非空值」op 的 value 必填、side 与 field 一致性

**改动类型**：校验函数分支内追加 ~25 行

**新建辅助函数**：无

**Verify**：
- [x] 保存空 conditions → 校验通过（柔性）
- [x] 任一行 field 空 → alert 报错
- [x] 任一行非空值/非空值 op 的 value 空 → alert 报错
- [x] side='网关' 但 field='Currency'（Currency 不在 GATEWAY_RECON_FIELDS）→ alert 报错"字段 Currency 不在网关字段列表中"
- [x] side='银行' 但 field='Bank'（Bank 不在 BANK_STATEMENT_FIELDS_FOR_C3）→ alert 报错

**估时**：30 min

---

### T3.4 — Scenario confirm 预览段

**Owner**：dev

**Input**：spec §4.4

**Output**：
- `src/renderer-dialogs.js:7424-7427` `buildScenarioConfirmDetailHtml` 的 `'gateway-recon-join'` 分支：
  - 在「对账字段」段之前插入 conditions 段
  - 仅当 `conditions.length >= 1` 时渲染（避免空数组渲染空列表）

**改动类型**：分支内追加 ~10 行

**新建辅助函数**：无

**Verify**：
- [x] 配置 ≥ 1 条 conditions → 保存前 confirm 弹窗显示「条件（AND）：网关 BillDate 等于 2026-04-01；银行 Currency 包含 USD」类似列表
- [x] conditions 为空 → confirm 弹窗中无 conditions 段（只显示原有的对账字段 + 赋值）

**估时**：20 min

---

### T3.5 — 运行时引擎接入（runC3Scenario Step 0 + evalCondition helper）

**Owner**：dev

**Input**：spec §4.5

**Output**：
- `src/main-process/scenario-engines/c3-gateway-recon-join.js:11-19` require 段新增 `evaluateCondition`（来自 engine-utils.js）
- `src/main-process/scenario-engines/c3-gateway-recon-join.js:32` 后新增 `evalCondition(row, cd, { useC3BankValueGetter })` helper（spec §4.5.1，约 10 行）
- `src/main-process/scenario-engines/c3-gateway-recon-join.js:48-114` `runC3Scenario` 入口：
  - 在校验段（gwRows 空 / reconFields 空 / assign 空）通过后、`bankRows.forEach` 之前插入 Step 0 段（spec §4.5.2，约 12 行）
  - `bankRows.forEach` → `bankRowsFiltered.forEach`
  - `gwRows.filter(...)` → `gwRowsFiltered.filter(...)`
- `src/main-process/scenario-engines/c3-gateway-recon-join.js:123-127` `module.exports` 暴露 `evalCondition`

**改动类型**：引擎入口插入 ~25 行 + module.exports +1 entry

**新建辅助函数**：是（`evalCondition`）

**Verify**：
- [x] C3 场景 `config.conditions = [{side:'网关',field:'Currency',op:'等于',value:'HKD'}]` + gwRows 2 行（HKD/USD）→ gwRowsFiltered 仅 1 行（HKD），bankRowsFiltered 不变；assign 写入按过滤后子集进行（smoke C3-COND-1 已覆盖）
- [x] C3 场景 `config.conditions = [{side:'银行',field:'发生额绝对值',op:'等于',value:'100'}]` + bankRows 含 \|Credit-Debit\|=100 行 → 引擎走 `getBankRowValueForC3`，过滤后命中（smoke C3-COND-VIRTUAL 已覆盖）
- [x] C3 场景 `config.conditions = []`（或 undefined）→ 不过滤，行为同 v2.1.4（smoke C3-COND-EMPTY + C3-COND-LEGACY 已覆盖）
- [x] 跑既有 smoke 全套（C3 用例）→ 全绿（旧 fixture 默认无 conditions，兜底空数组等价于不过滤）— 31/31 PASS

**关联功能 review 命中预判**：
- ⚠️ `runC3Scenario`（**Critical** — 资金对账引擎入口）
- ⚠️ `scenario.config` JSON blob（Risk-sensitive — 新增 conditions 字段）
- ⚠️ `evaluateCondition`（Important-skeleton — 复用，无修改）
- ⚠️ `getBankRowValueForC3`（Important-skeleton — 复用，无修改）
- ⚠️ `gwMatchesBank`（Critical — 零修改，仅入参子集化）

**风险提醒**：
- ⚠️ **资金 / 算法**：本次过滤段插在 `bankRows.forEach` 之前，过滤后才进入 join 比对；`gwMatchesBank` / assign 写值循环**完全不动**，零回归
- ⚠️ 配置错误（field 拼写错）→ 行被过滤 → assign 写入数减少，属配置层面影响而非算法回归
- ⚠️ **dev 阶段必须跑既有 smoke 全套**确认零回归，新增 6 个 C3-COND-* case（spec §六）

**估时**：1h

---

## T4 — Smoke + Preview + check-vars + 文档同步

**Owner**：team-lead

**Input**：T1-T3 完成

**Output**：
- `scripts/smoke-test.js` 新增 10 个 case（spec §六）：
  - RECON-ID-FIX-NAME-1（usage-stats key 修复后能成功计数）
  - RECON-ID-FIX-NAME-2（旧 section 不再出现）
  - RECON-ID-FIX-SCENARIO-EMPTY（场景下拉真空白）
  - RECON-ID-FIX-SCENARIO-WITH-DATA（场景下拉无占位项 + selectedIndex = -1）
  - C3-COND-1（单条件过滤）
  - C3-COND-2（多条件 AND 过滤）
  - C3-COND-VIRTUAL（银行侧虚拟字段）
  - C3-COND-EMPTY（空 conditions 不过滤）
  - C3-COND-LEGACY（旧 DB 兜底）
  - C3-COND-OP-EMPTY（空值操作）
- `npm run preview` 重跑（如主页面有 ReconID 模块名变化 → N1 涉及）
- `npm run preview:account`（如 dialog preview 入口存在；C3 dialog 是否有独立 preview 需确认）
- ⚠️ 如 C3 dialog 无独立 preview 入口，需补（按 CLAUDE.md memory `workflow_frontend_previews`）— 与 v2.1.4 模块收纳弹窗 preview 接入方式参考
- `/check-vars` 跑通，输出 PR body 「⚠️ 关联功能 review」段落
- `npm run scan:vars` 重生成自动统计报告

**Verify**：
- [x] `npm run smoke` 全绿（scenario-engines 31/31 + usage-stats 61/61 + 全套）
- [x] check-vars 命中变量与 spec §五预判一致（含 `runC3Scenario` Critical 命中 — `dialog` 按 important-variables.md:262 备注判定可忽略）
- [x] PR body 段落已生成（PR #49 已提交 + self-review-2 已修正命中描述）

**估时**：1.5h

---

## T6 — fix1.1：C3 条件 row 列宽固定（v0.3 用户测试反馈）

**Owner**：dev

**Input**：spec §4.8

**Output**：
- `src/renderer-dialogs.js` `createScenarioConfigDialogC3`：
  - `renderC3ConditionRow` 模板 row 的 class 由 `scenario-config-multi-row` → `scenario-config-c3-cond-row`（专属）
  - 左二字段 select 加 class `scenario-config-c3-cond-field`
  - 3 个事件 handler（change / input / click）的 `closest('.scenario-config-multi-row')` 同步改为 `closest('.scenario-config-c3-cond-row')`
- `src/styles.css` 末段加 2 个 CSS 规则（grid 列宽固定 + ellipsis）
- `src/styles-gemini-extra.css` 末段加同样 2 个 CSS 规则（背景色用 `rgba(60, 64, 67, 0.04)` 与 gemini 主题一致）

**改动类型**：dialog DOM class + CSS 规则（无 JS 逻辑改动）

**新建辅助函数**：无

**Verify**：
- [x] 切左一「网关」↔「银行」时 row 宽度无肉眼可见跳变
- [x] 即使选超长字段 `Type(0:1对1,1:1对多,2:多对1,3:多对1（轧差合并)`，select 闭合状态 ellipsis 截断
- [x] 下拉打开时 option 完整可见
- [x] reconFields / billTypes / assign 行不受影响（仍用 `.scenario-config-multi-row` flex 布局）
- [x] `npm run preview:scenario-config-c3` 重跑确认视觉（self-review I1 后 fixture 注入 3 行 conditions 可视化验证 — 188563→212186 字节）

**关联功能 review 命中预判**：
- 无（仅 CSS + class name 改动；不涉及 important variables）

**估时**：30 min

---

## T7 — fix1.2：场景下拉自动选第 1 个（v0.3 用户测试反馈）

**Owner**：dev

**Input**：spec §3.5

**Output**：
- `src/renderer.js` `reloadReconIdFixScenarios`（约第 3528-3568 行）：在「当前已选 id 已不存在 → 置 null」段后追加：

  ```javascript
  if (state.reconIdFixSelectedScenarioId === null && state.reconIdFixScenarios.length > 0) {
    state.reconIdFixSelectedScenarioId = state.reconIdFixScenarios[0].id;
  }
  ```

- `src/renderer.js` `renderReconIdFixScenarioSelect`（约第 3608-3620 行）：删末尾 `if (desired === '') select.selectedIndex = -1;` 兜底分支，简化为 `select.value = desired;`

**改动类型**：reload 函数加自动选第 1 个 + render 函数简化

**新建辅助函数**：无

**Verify**：
- [x] 进对账单 ReconID 修复模块 + 账单类别选 business/gateway + 场景管理有场景 → 场景下拉自动显示第 1 个
- [x] 状态栏显示该场景对应的 ready/idle 状态（`refreshReconIdFixStatus` 在 reload 末端联动）
- [x] 删完所有场景再加 1 个 → 下拉自动选这个新加的（reloadReconIdFixScenarios 重跑）
- [x] 类别清空 → renderReconIdFixScenarioSelect 走档 1 真空白（与 v0.2 相同）

**关联功能 review 命中预判**：
- ⚠️ `state.reconIdFixSelectedScenarioId`（Runtime-state）— state 写入路径增加（reload 自动选第 1 个）；下游 `updateReconIdFixUi` / `refreshReconIdFixStatus` / `handleReconIdFixRun` 均依赖此 state，本次改动让 state 不再为 null when scenarios 非空，下游分支「未选场景按钮 disabled」分支只在 scenarios 为空（档 1/2）时进入

**估时**：20 min

---

## T5 — PR 准备 + 自查（用户明确说「提 PR」后由 team-lead 执行）

**Owner**：team-lead

**Input**：T0-T4 完成 + 用户手动测试反馈通过

**Output**：
- `docs/prs/待merge-PR #N.md` 草稿
- PR 标题：`v2.1.5: 对账单 ReconID 修复模块名空格化 + 场景下拉空状态优化 + C3 提取ReconId-From 网关场景新增条件栏`
- PR body 含「⚠️ 关联功能 review」段落（特别标注 `runC3Scenario` Critical 命中 + 资金红线零修改证明）
- check-vars 已二次跑（合并到 main 前的硬节点）

**Verify**：
- [x] `git diff main..v2.1.5` 文件清单覆盖 spec §一表中所有条目
- [x] CHANGELOG / VFH / USER_GUIDE 三件套已更新（在 T5 之前作为最后一个 commit — `8fdd327`）
- [ ] Codex 自动 review 0 Critical + 0 Important（如有 Important 必须修复）— 待 PR #49 merge 前 GitHub Actions 触发 + reviewer 复核确认

**估时**：1h

---

## 总估时

| 阶段 | 估时 |
|---|---|
| N1 字面替换（T1.1 + T1.2 + T1.3 + T1.4） | 40 min |
| N2 场景下拉（T2） | 30 min |
| N3 默认配置 + dialog 兜底（T3.1） | 15 min |
| N3 dialog UI 行 + 数据流（T3.2） | 1.5h |
| N3 dialog 校验（T3.3） | 30 min |
| N3 confirm 预览（T3.4） | 20 min |
| N3 引擎接入（T3.5） | 1h |
| Smoke + Preview + check-vars（T4） | 1.5h |
| fix1.1 C3 条件 row 列宽固定（T6，v0.3 追加） | 30 min |
| fix1.2 场景下拉自动选第 1 个（T7，v0.3 追加） | 20 min |
| PR 准备（T5） | 1h |
| **总计** | **~8.5h**（含 self-review，不含手动测试 + Codex round 复盘） |

---

## 退出标准（Definition of Done）

- ✅ 所有 T1-T5 完成 + 单元 Verify 通过
- ✅ `npm run smoke` 全绿（含 10 个新 case）
- ✅ `npm run preview` / `preview:account` / dialog preview（如有）三组截图通过对照
- ✅ Codex 自动 review 0 Critical + 0 Important
- ✅ `/check-vars` 输出已贴入 PR body（特别标注 runC3Scenario Critical）
- ✅ PR 自评轮次 ≥ 1 轮
- ✅ 用户手动测试反馈：3 块改动行为符合预期
- ✅ 等用户明确说「提 PR」后 team-lead 才走 PR（CLAUDE.md memory `workflow_no_tester_no_auto_pr`）

---

## OPEN ISSUES（拍板状态）

| # | 议题 | 当前状态 | 拍板 |
|---|---|---|---|
| O1 | N1 业务OP数据核对是否一并改名 | ✅ 用户已撤回 | 不改 |
| O2 | N1 .usage-stats.txt 历史数据 migration | ✅ 用户已确认 | 不做（writeStatsFile 按 FUNCTION_REGISTRY 顺序输出，旧 key 自动不出现） |
| O3 | N1 IPC channel name 是否改名 | ✅ 已默认 | 不改（preload + DB schema 依赖） |
| O4 | N2 scenarios 为空时 select.disabled 是否保留 | ✅ 已默认 | 保留 true |
| O5 | N2 有 scenarios 但用户未选时 select 默认显示 | ✅ 已默认 → ✅ **v0.3 fix1.2 修订** | selectedIndex = -1（HTML 标准未选状态） → **改为「自动选第 1 个」**（用户测试反馈） |
| O6 | N3 v2.1.5 范围是否包含运行时 | ✅ 用户已选 A | 包含 |
| O7 | N3 校验严格程度 | ✅ 用户已选 a | 柔性（conditions 可 0 行）|
| O8 | N3 字段枚举源歧义 | ✅ C3 模块无歧义 | 直接复用 GATEWAY_RECON_FIELDS（31）+ BANK_STATEMENT_FIELDS_FOR_C3（45） |
| O9 | N3 银行侧虚拟字段「发生额绝对值」运行时是否走 `getBankRowValueForC3`？ | ✅ 拍板：走 dev 方案（用户 2026-05-15 确认） | spec §4.5.1 `evalCondition({ useC3BankValueGetter: true })` 包装 |
| O10 | N3 side / field 一致性校验是否在 dialog 保存时同步弹 alert？ | ✅ 拍板：弹 dev 方案（用户 2026-05-15 确认） | spec §4.3 dialog 保存时 alert 校验 |
| O11 | N3 C3 条件 row 列宽切「网关↔银行」时不一致（v0.3 fix1.1） | ✅ 已默认 | grid 布局列宽固定（spec §4.8） |

---

## 实施记录

> Dev 阶段每完成一个 task 后在下方追加 commit 哈希 + 简述。
