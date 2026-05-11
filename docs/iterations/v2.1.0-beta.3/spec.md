# spec — v2.1.0-beta.3 ReconID 模块改造：新增网关对账单子模式 + 主面板账单类别筛选

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft） |
| 目标版本 | `v2.1.0-beta.3` |
| 关联 PRD | `PRD-v2.1.0-beta.3.md` |
| 关联 tasks | `tasks.md` |
| 起草日期 | 2026-05-11 |
| 起草人 | team-lead（PM 角色） |
| 基线 | `v2.1.0-beta.2`（PR #38 merged，commit 95802fa） |

> 本文档落到文件级 + 符号级 + 行号级（基线：v2.1.0-beta.2）。
> 行号在 Dev 实施过程中可能小幅漂移（±5 行）；漂移后以符号名/上下文为准。

---

## 一、改动文件清单

### 1.1 新增（5）

| 文件 | 用途 |
|---|---|
| `src/constants/gateway-bill-recon-fields.js` | gateway 模式 4 sheet 字段常量（网关账单 31 / 渠道账单 16 / 订单修复 14 / 对账结果 19）+ sheet 名常量 |
| `scripts/smoke/recon-id-fix-engine-gateway.js` | gateway 模式引擎 fixture 化单测（6 用例） |
| `docs/iterations/v2.1.0-beta.3/PRD-v2.1.0-beta.3.md` | ✅ 已存在（本次起草） |
| `docs/iterations/v2.1.0-beta.3/spec.md` | ✅ 本文档 |
| `docs/iterations/v2.1.0-beta.3/tasks.md` | 任务清单（同目录） |

### 1.2 修改（~12）

| 文件 | 改动要点 | 涉及 R |
|---|---|---|
| `index.html` | 模块下拉项文本 + reconIdFixModulePanel 布局重排（账单类别下拉 + 场景下拉下移） | R1 / R2 |
| `src/renderer.js` | `MODULES.reconIdFix.name` 改文本；state 新增 `reconIdFixBillCategory`；scenarios 过滤逻辑按 category 联动；级联清空；持久化加载 | R1 / R2 / R3 / R7 |
| `src/renderer-dialogs.js` | `createScenarioConfigDialogC4` 加 `mode` 参数；mode-switch 文案/枚举/禁用；`openScenarioConfigByCategory` 路由 `gateway-recon-id-fix`；类别选择窗白名单支持新 category | R3 / R4 |
| `src/renderer-previews.js` | 新增 ReconID 主面板 + C4 dialog mode=gateway 的 preview 状态 | R2 / R4 |
| `src/preload.js` | inline `GATEWAY_BILL_FIELDS` / `CHANNEL_BILL_FIELDS` / `ORDER_REPAIR_FIELDS_GATEWAY` 副本 | R6 |
| `src/main-process/scenario-engines/c4-recon-id-fix.js` | `runC4Scenario(scenario, sheets, mode='business')` 加 mode 参数；网关模式分支（Type/Reference/拆账） | R5 |
| `src/main-process/recon-id-fix-engine.js` | `runReconIdFix` 内按 `scenario.category` 路由 mode | R5 |
| `src/main-process/recon-id-fix-io.js` | reader/writer 加 mode 参数；mode=gateway 时切换 sheet 名 + 列常量 | R5 / R6 |
| `src/main.js` | IPC handler `recon-id-fix:*` 调用引擎时传 mode；settings 读写 `recon_id_fix_bill_category` | R5 / R7 |
| `src/backend/database/scenarios-repository.js` | `VALID_CATEGORIES` (L11-17) 加 `'gateway-recon-id-fix'` | R3 |
| `src/backend/database/migrations.js` | 新增幂等迁移函数 `ensureScenariosCategoryGatewayReconIdFix`，沿用 v2.1.0-beta.1 PR-A `ensureScenariosCategoryReconIdFix` (L486-L530) 模板，扩 CHECK 约束到 5 值 | R3 |
| `src/backend/database.js` | 在现有 `ensureScenariosCategoryReconIdFix` 调用之后加 `ensureScenariosCategoryGatewayReconIdFix` 调用 | R3 |
| `package.json` / `package-lock.json` | version `2.1.0-beta.2` → `2.1.0-beta.3` | R8 |
| `CHANGELOG.md` / `docs/VERSION_FEATURE_HISTORY.md` / `docs/USER_GUIDE.md` | 发版三件套 | R8 |

---

## 二、详细设计

### 2.1 R1：模块文本重命名

#### 2.1.1 `MODULES.reconIdFix.name`

`src/renderer.js:56-60`：
```js
// 改前
reconIdFix: {
  id: 'recon-id-fix',
  name: '单据对账 ReconID 修复'
}

// 改后
reconIdFix: {
  id: 'recon-id-fix',                 // 保留不动（数十处引用）
  name: '对账单ReconID修复'             // 新文案
}
```

> ⚠️ `module.id` = `recon-id-fix` 与单据模式 `scenario.category` = `recon-id-fix` **字面相同**，是 v2.1.0-beta.1 的历史决策。本次保留歧义，在引擎/dialog 顶部注释明确"module=模块标识，category=sub-mode 标识，二者作用域不同"。

#### 2.1.2 主面板模块下拉项 HTML

`index.html:45`：
```html
<!-- 改前 -->
<button class="module-option" type="button" data-module="recon-id-fix">单据对账 ReconID 修复</button>

<!-- 改后 -->
<button class="module-option" type="button" data-module="recon-id-fix">对账单ReconID修复</button>
```

> `data-module="recon-id-fix"` 保留不动（与 module.id 联动）。

### 2.2 R2：主面板布局重构

#### 2.2.1 reconIdFixModulePanel HTML

`index.html:215-240` 现状：
```html
<section id="reconIdFixModulePanel" ...>
  <div class="...">
    <div class="recon-id-fix-scenario-row">
      <label for="reconIdFixScenarioSelect">场景</label>
      <select id="reconIdFixScenarioSelect" disabled>...</select>
      <button id="reconIdFixManageScenariosBtn">场景管理</button>
    </div>
    <div class="...">
      <button id="reconIdFixImportBtn">导入文件</button>
      <button id="reconIdFixRunBtn" disabled>开始运行</button>
    </div>
    <button id="reconIdFixExportBtn" disabled>导出文件</button>
    <div id="reconIdFixStatusBox" class="status-box">...</div>
  </div>
</section>
```

改后：
```html
<section id="reconIdFixModulePanel" ...>
  <div class="...">
    <!-- 行 1：账单类别下拉（新增；位置 = 原"场景"位置） -->
    <div class="recon-id-fix-bill-category-row">
      <label for="reconIdFixBillCategorySelect">账单类别</label>
      <select id="reconIdFixBillCategorySelect" class="recon-id-fix-bill-category-select">
        <option value="">请选择账单类别</option>
        <option value="business">单据对账单</option>
        <option value="gateway">网关对账单</option>
      </select>
    </div>

    <!-- 行 2：导入文件 + 开始运行（不变） -->
    <div class="...">
      <button id="reconIdFixImportBtn">导入文件</button>
      <button id="reconIdFixRunBtn" disabled>开始运行</button>
    </div>

    <!-- 行 3：场景下拉 + 场景管理 + 导出文件（场景从原行 1 下移） -->
    <div class="recon-id-fix-scenario-row" hidden>
      <label for="reconIdFixScenarioSelect">场景</label>
      <select id="reconIdFixScenarioSelect" class="recon-id-fix-scenario-select" disabled>...</select>
      <button id="reconIdFixManageScenariosBtn" class="secondary-btn">场景管理</button>
      <button id="reconIdFixExportBtn" class="secondary-btn" disabled>导出文件</button>
    </div>

    <!-- 行 4：状态（不变） -->
    <div id="reconIdFixStatusBox" class="status-box">...</div>
  </div>
</section>
```

**关键约束**（2026-05-11 reverse sync 修订，按用户反馈"账单类别为空也要显示其他按钮 + 其他前端结构同 beta.2"）：
- 账单类别下拉初始 = ""（空 option，placeholder）
- **行 2 wrapper 始终显示**（不再按账单类别 hidden）；所有元素（场景下拉 / 场景管理 / 导出文件 / 导入文件 / 开始运行）始终在视觉上可见
- 账单类别为空时：所有功能按钮 disabled（导入文件 / 开始运行 / 导出文件 / 场景管理 / 场景下拉），由 `updateReconIdFixPanelVisibility` 统一控制
- 账单类别选定后：按 beta.2 默认态恢复（导入文件 enable / 场景管理 enable / 其他按钮按 session/result 状态决定）

#### 2.2.2 CSS（src/styles-gemini-extra.css 或同等位置）

新增：
```css
.recon-id-fix-bill-category-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.recon-id-fix-bill-category-select {
  /* 宽度对齐场景下拉 */
  width: 240px;
}
```

### 2.3 R3：scenario.category 枚举 + 场景管理隔离

#### 2.3.1 `openScenarioConfigByCategory` 加新路由

`src/renderer-dialogs.js:70-78` 现状：
```js
function openScenarioConfigByCategory(category) {
  if (category === 'extract-recon-id') return openModal(createScenarioConfigDialogC1());
  if (category === 'offset-bill-mark') return openModal(createScenarioConfigDialogC2());
  if (category === 'gateway-recon-join') return openModal(createScenarioConfigDialogC3());
  if (category === 'recon-id-fix') return openModal(createScenarioConfigDialogC4());
  // ...
}
```

改后：
```js
function openScenarioConfigByCategory(category) {
  if (category === 'extract-recon-id') return openModal(createScenarioConfigDialogC1());
  if (category === 'offset-bill-mark') return openModal(createScenarioConfigDialogC2());
  if (category === 'gateway-recon-join') return openModal(createScenarioConfigDialogC3());
  if (category === 'recon-id-fix') return openModal(createScenarioConfigDialogC4('business'));
  if (category === 'gateway-recon-id-fix') return openModal(createScenarioConfigDialogC4('gateway'));
  // ...
}
```

> 同样的路由调整需同步 `src/renderer-dialogs.js` 中的其他调用点：L5695 / L5730 / L5805 / L7263（这 4 处 `if (category === 'recon-id-fix')` 分支需检查是否要扩展到 gateway）。

#### 2.3.2 `createScenarioCategorySelectDialog` 白名单扩展

`src/renderer-dialogs.js:5552`（v2.1.0-beta.2 改造点）现状：
```js
const effectiveCategories = allowedCategories || ['extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'recon-id-fix'];
```

改后：
```js
const effectiveCategories = allowedCategories || ['extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'recon-id-fix', 'gateway-recon-id-fix'];
```

> 默认全枚举里 **必须包含** `gateway-recon-id-fix`，否则不传 allowedCategories 时新类别看不到。

#### 2.3.3 renderer.js 入口传白名单（动态）

`src/renderer.js:3728-3732` 现状（v2.1.0-beta.2 落地）：
```js
elements.reconIdFixManageScenariosBtn.addEventListener('click', () => {
  openModal(createScenariosManagerDialog(['recon-id-fix']));
});
```

改后：
```js
elements.reconIdFixManageScenariosBtn.addEventListener('click', () => {
  const cat = state.reconIdFixBillCategory; // 'business' | 'gateway' | null
  if (!cat) return; // 账单类别为空时按钮 disabled，理论上不会触发
  const targetCategory = cat === 'gateway' ? 'gateway-recon-id-fix' : 'recon-id-fix';
  openModal(createScenariosManagerDialog([targetCategory]));
});
```

#### 2.3.4 scenarios 过滤逻辑

`src/renderer.js:3414` 现状：
```js
state.reconIdFixScenarios = result.scenarios.filter((s) => s.category === 'recon-id-fix');
```

改后：
```js
const cat = state.reconIdFixBillCategory;
const targetCategory = cat === 'gateway' ? 'gateway-recon-id-fix' : (cat === 'business' ? 'recon-id-fix' : null);
state.reconIdFixScenarios = targetCategory
  ? result.scenarios.filter((s) => s.category === targetCategory)
  : [];
```

#### 2.3.5 scenarios DB 校验与迁移（2026-05-11 reverse sync 修订）

**JS 层白名单**（`src/backend/database/scenarios-repository.js:11-17`）：
```js
// 改前
const VALID_CATEGORIES = [
  'extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'recon-id-fix'
];

// 改后（追加 1 项）
const VALID_CATEGORIES = [
  'extract-recon-id', 'offset-bill-mark', 'gateway-recon-join',
  'recon-id-fix',
  'gateway-recon-id-fix'  // v2.1.0-beta.3
];
```

**SQLite CHECK 约束扩展**（`src/backend/database/migrations.js`）：

现状（`ensureScenariosCategoryReconIdFix` L486-L530，v2.1.0-beta.1 PR-A 落地）已把 CHECK 从 3 值扩到 4 值。本次新增 `ensureScenariosCategoryGatewayReconIdFix`，沿用同一模板扩到 5 值：

```js
// migrations.js 新增（紧接 ensureScenariosCategoryReconIdFix 之后）
function ensureScenariosCategoryGatewayReconIdFix(db) {
  const tableSqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'"
  ).get();
  if (!tableSqlRow || !tableSqlRow.sql) return;
  if (tableSqlRow.sql.includes("'gateway-recon-id-fix'")) return; // 已扩，no-op

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE scenarios RENAME TO scenarios_old;');
    db.exec(`
      CREATE TABLE scenarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK (category IN (
          'extract-recon-id',
          'offset-bill-mark',
          'gateway-recon-join',
          'recon-id-fix',
          'gateway-recon-id-fix'
        )),
        name TEXT NOT NULL,
        priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        config_json TEXT NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (name)
      );
    `);
    db.exec(`
      INSERT INTO scenarios
        (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      SELECT id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at
      FROM scenarios_old;
    `);
    db.exec('DROP TABLE scenarios_old;');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  // ...
  ensureScenariosCategoryGatewayReconIdFix
};
```

**database.js 调用顺序**（紧接 `ensureScenariosCategoryReconIdFix(db)` 之后）：
```js
ensureScenariosSupport(db);
ensureScenariosCategoryReconIdFix(db);
ensureScenariosCategoryGatewayReconIdFix(db);  // 新增（v2.1.0-beta.3）
// ...
```

**幂等性 + 资金红线**：
- 幂等：`sqlite_master.sql.includes("'gateway-recon-id-fix'")` → no-op；多次启动只触发一次重建
- 事务保护：BEGIN / RENAME / CREATE / INSERT / DROP / COMMIT，失败 ROLLBACK
- 无损迁移：id / 列结构 / UNIQUE (name) / 默认值 / 历史数据完全保留
- 风险：极低（与 v2.1.0-beta.1 PR-A `ensureScenariosCategoryReconIdFix` 同模板，PR #37/#38 已实战验证）

**回滚兼容性**：用户用本版本创建过 `gateway-recon-id-fix` 场景后回滚到 v2.1.0-beta.2 → 启动会失败（旧版 CHECK 不含新枚举值，但数据已是新值）。**接受此限制**（与 v2.1.0-beta.1 → beta.0 回滚行为一致；release notes 注明）。

> `src/backend/database/settings-repository.js:97` `CURRENT_MODULE_VALID` 含 `'recon-id-fix'` — **这是 module.id 白名单，本次保留 `recon-id-fix`，此处不动**。

### 2.4 R4：C4 dialog 参数化（mode）

#### 2.4.1 函数签名

`src/renderer-dialogs.js:6633`：
```js
// 改前
function createScenarioConfigDialogC4() { /* ... */ }

// 改后
function createScenarioConfigDialogC4(mode = 'business') {
  // mode 沿 dialog 闭包传递，影响：
  // - 字段下拉枚举源（billTypes 主/从字段）
  // - 匹配规则勾选框文案（L6741-L6749）
  // - "修复结果输出" 标签文本 + 子选项文本/枚举（L6768, L6904-L6920）
  // - SubBizType 取值栏显示/隐藏（L6928-L6940）
  // - 输出 sheet 列模板
  // ...
}
```

#### 2.4.2 mode-switch 差异点（细化 PRD §3.4）

| 位置 | mode='business'（保留现状） | mode='gateway'（新增） |
|---|---|---|
| **L6740-L6750 匹配规则勾选框文案** | `主边单据 1 v 1 从边单据` / `主边单据 1 v 多 从边单据` / `主边单据 多 v 1 从边单据` | `网关 1 v 1 渠道` / `网关 1 v 多 渠道` / `网关 多 v 1 渠道` |
| **匹配规则互斥（L5812 / L6967-L6970）** | oneToMany 与 manyToOne 互斥 | 同（互斥逻辑不变，仅文案变；data-c4-match 属性 key 保留 `oneToMany`/`manyToOne` 不动，避免改 schema） |
| **L5677/L5698 billTypes 初始值 + 字段下拉枚举源** | `BUSINESS_BILL_FIELDS`(side='main') / `OPPONENT_BILL_FIELDS`(side='opp') | `GATEWAY_BILL_FIELDS`(side='main') / `CHANNEL_BILL_FIELDS`(side='opp') |
| **L6768 "修复结果输出" 标签** | `修复结果输出` | `订单修复ID取值` |
| **L6904 / L6908 / L6912 选项 span 文本** | `主边单据` / `从边单据` / `主从边都修复` | `网关账单` / `渠道账单` / `自取值` |
| **L6919-L6920 commonId-source 下拉枚举** | `<option value="main">主边单据 reconId</option>` / `<option value="opp">从边单据 reconId</option>` | `<option value="main">网关账单ReconID</option>` / `<option value="opp">渠道账单ReconID</option>`（option value="main"/"opp" 不变；显示文本切换） |
| **commonId-source 内容文本（"主从边共同的 ..."）** | 保留原文 | **去掉"主从边共同的"** 字样 |
| **"网关账单"选项可用性（gateway only）** | n/a | 勾选 `网关 1v多` 或 `网关 多v1` 时 → "网关账单"radio + `<select>` 禁用（CSS class `is-disabled` + disabled 属性）；勾选 `网关 1v1` 时 → enabled |
| **L6928-L6940 SubBizType 取值栏** | 显示（保留 v2.1.0-beta.2 行为） | **整段 DOM 不渲染**（不只是 hidden）— 减少 dialog 高度 |
| **L5884 errors 文案** | `修复结果输出方向必填（主边 / 从边 / 主从都修复）` | `订单修复ID取值必填（网关账单 / 渠道账单 / 自取值）` |
| **L5895-L5901 SubBizType 校验** | 保留 | **跳过**（mode=gateway 时不校验 SubBizType） |
| **dialog 标题** | `新增/修改场景` | `新增/修改场景`（不变，与 PRD §3.4 一致） |

#### 2.4.3 mode 持久化到 scenario config

scenario 编辑保存时，category 路径：
- mode='business' → scenario.category = `'recon-id-fix'`（保持现状）
- mode='gateway' → scenario.category = `'gateway-recon-id-fix'`

scenario 加载时（编辑现有场景，`renderer-dialogs.js:6042` / `:6371` / `:6615` / `:7228` 的 `onConfirm: () => openScenarioConfigByCategory(draft.category)` 路径）按 category 自动路由 mode。

### 2.5 R5：引擎扩展（网关模式匹配）

#### 2.5.1 顶层入口路由

`src/main-process/recon-id-fix-engine.js:9-20` 现状：
```js
function runReconIdFix(scenario, sheets) {
  if (scenario.category !== 'recon-id-fix') {
    throw new Error(`runReconIdFix: scenario.category 必须是 recon-id-fix，当前为 ${scenario.category}`);
  }
  // ...
  return runC4Scenario(scenario, sheets);
}
```

改后：
```js
function runReconIdFix(scenario, sheets) {
  const mode = scenario.category === 'gateway-recon-id-fix' ? 'gateway'
             : scenario.category === 'recon-id-fix' ? 'business'
             : null;
  if (!mode) {
    throw new Error(`runReconIdFix: scenario.category 必须是 recon-id-fix | gateway-recon-id-fix，当前为 ${scenario.category}`);
  }
  if (!sheets || !Array.isArray(sheets.businessBills) || !Array.isArray(sheets.opponentBills)) {
    throw new Error('runReconIdFix: sheets.businessBills / opponentBills 必须是数组');
  }
  return runC4Scenario(scenario, sheets, mode);
}
```

> sheets 接口保留 `businessBills` / `opponentBills` 命名，避免改链路；语义上 gateway 模式 businessBills=网关账单、opponentBills=渠道账单。

#### 2.5.2 `runC4Scenario` 加 mode 参数

`src/main-process/scenario-engines/c4-recon-id-fix.js`：
- 函数签名加 `mode='business'`
- subset-sum / BillDate ±1day 容错 / 候选过滤 / tie-break 算法 **完全保留**（mode 共用骨架）
- 写值环节按 mode 分支：

```js
// 1v1 写值
if (mode === 'business') {
  // 现有逻辑：双 Type=0；reference/commonId 按 commonIdSource
} else { // gateway
  // 双 Type=0；Reference 按 dialog 的"订单修复ID取值"选项
  // - 选项=main(网关账单)：取 mainRow.reconciliationId
  // - 选项=opp(渠道账单)：取 oppRow.reconciliationId
  // - 选项=both(自取值-网关)：取 mainRow.reconciliationId
  // - 选项=both(自取值-渠道)：取 oppRow.reconciliationId（具体由 commonIdSource 'main'/'opp' 决定）
}
```

```js
// 1v多 写值（multi 是 n 笔渠道）
if (mode === 'business') {
  // 现有 RB4：双 Type=0；reference/commonId 按规则
} else { // gateway
  // 关键变化：输入 1 笔网关丢弃 + 输出 n 笔网关
  // 新 helper：splitGatewayOneToMany(mainRow, oppRows, scenario)
  //   for (let i = 0; i < oppRows.length; i++) {
  //     const splitRow = { ...mainRow };          // 深拷贝其他字段
  //     splitRow.Type = 1;                          // 拆出的均为 Type=1
  //     splitRow.Amount = oppRows[i].receiveAmount; // 取对应渠道 receiveAmount
  //     splitRow.Reference = computeReference(splitRow, oppRows[i], scenario, mode);
  //     fixedRows.push(splitRow);
  //   }
  //   // 原 mainRow 不入 fixedRows
}
```

```js
// 多v1 写值（n 笔网关 ↔ 1 笔渠道）
if (mode === 'business') {
  // 现有 RB2：主 Type=2 / 从 Type=0
} else { // gateway
  // n 笔网关 Type=2；Amount 保持原值；Reference 按规则
  for (const mainRow of mainRows) {
    const fixed = { ...mainRow, Type: 2, Reference: computeReference(mainRow, oppRow, scenario, mode) };
    fixedRows.push(fixed);
  }
}
```

#### 2.5.3 Reference 计算函数

新增 `computeReferenceGateway(srcRow, pairedRow, scenario)`（c4-recon-id-fix.js 内 helper）：
```js
function computeReferenceGateway(mainRow, oppRow, scenario) {
  // dialog 的"订单修复ID取值"选项三选一：
  //  - output.target === 'main'     → 取网关账单（mainRow）的 reconciliationId
  //  - output.target === 'opp'      → 取渠道账单（oppRow）的 reconciliationId
  //  - output.target === 'both'     → 自取值；commonId.source 决定取哪边
  //      - commonId.source === 'main' → mainRow.reconciliationId
  //      - commonId.source === 'opp'  → oppRow.reconciliationId
  const cfg = scenario.config || {};
  const tgt = (cfg.output && cfg.output.target) || 'main';
  if (tgt === 'main') return mainRow.reconciliationId || '';
  if (tgt === 'opp') return oppRow.reconciliationId || '';
  // tgt === 'both'（自取值）
  const src = cfg.output && cfg.output.commonId && cfg.output.commonId.source;
  if (src === 'opp') return oppRow.reconciliationId || '';
  return mainRow.reconciliationId || ''; // 默认 main
}
```

> ⚠️ 注意 scenario.config schema 的兼容性：
> - mode='business' 的 `output.target` 取 `'main' | 'opp' | 'both'`（保留现状）
> - mode='business' 的 `output.commonId.source` 取 `'main' | 'opp'`（保留）
> - mode='gateway' 复用同 schema，仅语义不同（`main` = 网关账单 / `opp` = 渠道账单）

#### 2.5.4 全局约束实现

"每笔渠道账单全局只能被一次匹配组使用"——通过 `pairedRight: Set<rowIdx>` 跟踪（c4-recon-id-fix.js 现有实现已有 pairedLeft/pairedRight 跨 step 共享）。**算法骨架不变**，仅 1v多 时拆出的 n 笔渠道均加入 pairedRight 集合。

### 2.6 R6：字段常量 + preload 同步

#### 2.6.1 新增 `src/constants/gateway-bill-recon-fields.js`

```js
// v2.1.0-beta.3：网关对账单 ReconID 修复模式的 4 sheet 字段常量
// fixture 来源：资金对账导出不平.xlsx（根目录）
//
// ⚠️ 同步提醒：Electron sandbox 限制 preload require 自定义模块，
//   src/preload.js 顶部 inline 了一份副本。本文件改动必须同步更新 preload.js。

const GATEWAY_BILL_FIELDS = Object.freeze([
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type(0:1对1,1:1对多,2:多对1,3:多对1（轧差合并)', 'Reference', 'Currency', 'Amount',
  'OriginBillBizId', 'ReconBillBizId', 'reconciliationId', 'tradeType', 'clientId', 'name',
  'cardNo', '真实渠道', '清算网络', '对账批次号', 'createTime', 'finishTime',
  'LOriginalId', 'remark1', 'remark2', 'bookdate', 'valuedate', 'fileId', 'AccountRef'
]);

const CHANNEL_BILL_FIELDS = Object.freeze([
  'channelName', 'merchantId', 'reconciliationId', 'channelOrderNo', 'name', 'cardNo',
  'currency', 'requestAmount', 'receiveAmount', 'extraFee', '清算网络', 'createTime',
  'finishTime', 'additionInfo', 'remark', 'COriginalId'
]);

const ORDER_REPAIR_FIELDS_GATEWAY = Object.freeze([
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type', 'Reference', 'Currency', 'Amount', 'OriginBillBizId', 'ReconBillBizId'
]);

const RECON_RESULT_FIELDS_GATEWAY = Object.freeze([
  '账单日期', '支付渠道', '业务类型', '交易类型', '对账结果', 'reconId',
  '业务订单号', '业务订单金额', '业务方币种', '渠道账号', '渠道订单号',
  '渠道订单金额', '渠道币种', '业务订单交易完成时间', '渠道订单交易完成时间',
  '差错类型', '备注', '业务方原始账单ID', '渠道方原始账单ID'
]);

const GATEWAY_BILL_SHEET_NAME = '网关账单';
const CHANNEL_BILL_SHEET_NAME = '渠道账单';
const ORDER_REPAIR_SHEET_NAME_GATEWAY = '订单修复';
const RECON_RESULT_SHEET_NAME_GATEWAY = '对账结果';

module.exports = {
  GATEWAY_BILL_FIELDS,
  CHANNEL_BILL_FIELDS,
  ORDER_REPAIR_FIELDS_GATEWAY,
  RECON_RESULT_FIELDS_GATEWAY,
  GATEWAY_BILL_SHEET_NAME,
  CHANNEL_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME_GATEWAY,
  RECON_RESULT_SHEET_NAME_GATEWAY
};
```

> `GATEWAY_BILL_FIELDS` 与现有 `src/constants/gateway-recon-fields.js::GATEWAY_RECON_FIELDS`（C3 用）**列名完全相同**。**不复用**（避免跨模块耦合）；本次新建独立常量，注释提醒"与 GATEWAY_RECON_FIELDS 列名相同但分属两个模块，未来不要相互引用"。

#### 2.6.2 preload.js 同步

参考 `src/preload.js` 现有 inline 副本（v2.0.0-beta.3 引入 GATEWAY_RECON_FIELDS / v2.1.0-beta.1 引入 BUSINESS_BILL_FIELDS / OPPONENT_BILL_FIELDS），追加：

```js
// v2.1.0-beta.3：网关对账单 ReconID 修复模式字段（与 src/constants/gateway-bill-recon-fields.js 同步）
const GATEWAY_BILL_FIELDS = Object.freeze([ /* 同上 */ ]);
const CHANNEL_BILL_FIELDS = Object.freeze([ /* 同上 */ ]);
const ORDER_REPAIR_FIELDS_GATEWAY = Object.freeze([ /* 同上 */ ]);

// 暴露给 renderer
// （window.desktopApi 已通过 contextBridge 暴露 scenariosApi/templatesApi 等，
//  本次仅需通过 IPC 透传字段数据，不直接暴露常量）
```

> preload.js 暴露 API：renderer 通过 IPC 获取字段列表（避免直接暴露常量），与 v2.1.0-beta.1 的 `scenariosApi.getFields(type)` 风格保持一致；type 新增 `'gatewayBill'` / `'channelBill'`。

### 2.7 R7：账单类别持久化

#### 2.7.1 SQLite settings key

`src/backend/database/settings-repository.js`：无需改 schema（app_settings 是通用 K-V 表）。

新增逻辑常量：
```js
const SETTINGS_KEYS = {
  RECON_ID_FIX_BILL_CATEGORY: 'recon_id_fix_bill_category'
};
```

#### 2.7.2 IPC handler（src/main.js）

新增 / 复用通用 `app:get-setting` / `app:set-setting` handler（如已存在则复用）。

#### 2.7.3 renderer 启动加载 + 切换持久化

`src/renderer.js`：
```js
// state 新增
state.reconIdFixBillCategory = null; // 'business' | 'gateway' | null

// 启动加载（initializeApp 内）
const cat = await window.desktopApi.settings.get('recon_id_fix_bill_category');
if (cat === 'business' || cat === 'gateway') {
  state.reconIdFixBillCategory = cat;
  // 同步 UI 选中态
  if (elements.reconIdFixBillCategorySelect) {
    elements.reconIdFixBillCategorySelect.value = cat;
  }
  // 触发 scenarios 重新 filter
  await refreshReconIdFixScenarios();
}

// 切换持久化
elements.reconIdFixBillCategorySelect.addEventListener('change', async (e) => {
  const newCat = e.target.value || null;
  state.reconIdFixBillCategory = newCat;
  await window.desktopApi.settings.set('recon_id_fix_bill_category', newCat || '');
  // 级联：清空已选场景 + 清空 import session + 切换 UI 显示
  state.reconIdFixSelectedScenarioId = null;
  state.reconIdFixExport = null;
  await refreshReconIdFixScenarios();
  updateReconIdFixPanelVisibility(); // 控制按钮 disabled 状态（2026-05-11 reverse sync：行 2 不再 hidden，仅按钮 disabled）
});
```

### 2.8 R8：版本号 bump + 文档三件套

- `package.json` → `"version": "2.1.0-beta.3"`
- `package-lock.json` → 跑 `npm install --package-lock-only`（或手动改 root version）
- `CHANGELOG.md`：新增条目（参考 v2.1.0-beta.2 节）
- `docs/VERSION_FEATURE_HISTORY.md`：补 v2.1.0-beta.3 章节
- `docs/USER_GUIDE.md`：新增"对账单ReconID修复 — 网关对账单子模式"操作指引

---

## 三、状态机 / 级联

### 3.1 主面板"账单类别"切换的级联清空

```
账单类别切换（business ↔ gateway / business ↔ null / gateway ↔ null）
  ↓
1. state.reconIdFixBillCategory ← 新值
2. state.reconIdFixSelectedScenarioId ← null（清当前场景）
3. state.reconIdFixExport ← null（清 renderer-only 导出文案）
4. 后端 import session: scenarios.clearImportSession()（如已 import）
5. refreshReconIdFixScenarios()（按新 category 重新 filter）
6. updateReconIdFixPanelVisibility()（按钮 disabled 状态切换；2026-05-11 reverse sync：行 2 始终 visible，不再按账单类别 hidden）
7. 持久化 settings
```

> ⚠️ v2.1.0-beta.2 PR #38 教训：场景管理 dialog 关闭时不能误清 `reconIdFixExport`（需明确 `scenariosChanged:false`）。本次账单类别切换是 **真的需要清** 的场景，无歧义。

### 3.2 场景管理按钮可用性

```
state.reconIdFixBillCategory === null → 按钮 disabled
state.reconIdFixBillCategory === 'business' → 按钮 enabled，传 ['recon-id-fix']
state.reconIdFixBillCategory === 'gateway'  → 按钮 enabled，传 ['gateway-recon-id-fix']
```

### 3.3 编辑场景时账单类别的反向同步

编辑现有场景时：
- 场景 category=`recon-id-fix` → 隐式 mode='business'
- 场景 category=`gateway-recon-id-fix` → 隐式 mode='gateway'
- dialog 内 mode 由 `createScenarioConfigDialogC4(mode)` 决定，不允许在 dialog 内改 mode

---

## 四、测试矩阵

### 4.1 业务回归（business 模式，必须零回归）

| 项 | 用例 | 验收 |
|---|---|---|
| 现有 C4 场景加载 | 启动 → 账单类别选 `单据对账单` → 场景下拉看到所有 category=`recon-id-fix` 场景 | 与 v2.1.0-beta.2 行为一致 |
| 现有 C4 dialog | 编辑场景：勾选框/文案/SubBizType 取值栏 | 与 v2.1.0-beta.2 行为一致 |
| 现有 C4 引擎 | 跑历史 fixture（samples/单据对账导出不平.xlsx） | 输出 byte-for-byte 一致 |
| smoke recon-id-fix-engine.js | `node scripts/smoke/recon-id-fix-engine.js` | 退出码 0 + 全 PASS |

### 4.2 网关模式新功能

| 项 | 用例 | 验收 |
|---|---|---|
| 主面板布局 | 行 1 = 账单类别下拉；行 3 = 场景+管理+导出 同行 | 视觉 + preview 截图 |
| 账单类别持久化 | 选 gateway → 关闭 → 重启 → 仍是 gateway | DB app_settings 验证 |
| dialog mode=gateway | 文案/枚举/禁用 | 与 PRD §3.4 一致 |
| 引擎 1v1（3 选项各 1） | 见 PRD §6.2 单测 1/2/3 | 单测全绿 |
| 引擎 1v多（拆账） | 见 PRD §6.2 单测 4 | 单测全绿 |
| 引擎 多v1（保 Amount） | 见 PRD §6.2 单测 5 | 单测全绿 |
| 全局约束 | 见 PRD §6.2 单测 6 | 单测全绿 |
| 输出 sheet 列数 | 14 列（不含 SubBizType） | 输出文件 cat 验证 |

### 4.3 跨模式切换

| 用例 | 验收 |
|---|---|
| business → gateway → business：场景下拉前后切换无串位 | 各 category 仅显示对应场景 |
| 账单类别切换时清空当前 export 状态 | 切换后 export 按钮 disabled |

---

## 五、风险点与回归保护

### 5.1 高风险

1. **C4 引擎修改可能误伤 business 模式**：所有 mode 分支必须有显式 `if (mode === 'gateway')` 分支，business 路径走默认 else 保留原代码不动
2. **1v多 拆账输入丢弃**：业务方期望"原 1 笔丢弃 + 输出 n 笔"，引擎需特别处理 fixedRows.push 时不要把 mainRow 加入
3. **scenario.config schema 复用**：mode='business' 和 mode='gateway' 共用 schema，仅语义不同；存档场景互换 mode 加载可能解析错误（防御：mode 由 scenario.category 推导，不允许 mode 与 category 不匹配）

### 5.2 中风险

1. **preload inline 副本同步**：常量改动忘记同步 preload → renderer 拿不到字段（运行时报错）
2. **scenarios DB 加新 category 值，回到 v2.1.0-beta.2 / main 启动会兼容失败**：DB 不动 schema 但数据可能多出新枚举值；v2.1.0-beta.2 dispatcher 看到未知 category 应当忽略（防御：DB schema 不加 CHECK 约束）

### 5.3 低风险

1. CSS 布局重排影响其他模块（行 3 共用 class 名注意命名空间）
2. preview 截图差异（仅新增 panel/dialog，业务 panel 不变）

---

## 六、Dev 实施节奏（与 tasks.md 对齐）

按 task 顺序推进，每 task 提交一个 commit（message：`[v2.1.0-beta.3] <动作>(task-X): <一句话>`）。

具体 task 拆分见 `tasks.md`。

---

> **下一步**：用户 review spec.md → 起草 tasks.md → 启动 Dev。
