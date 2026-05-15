# Spec — v2.1.5 技术规格

> 关联 `PRD-v2.1.5.md` / `tasks.md`（同目录）
> 文档版本：
> - v0.3（2026-05-15 fix1：§3.5 fix1.2 场景下拉默认选第 1 个 + §4.8 fix1.1 C3 条件 row 列宽固定）
> - v0.2（2026-05-15 重写：N3 由 C4/gateway-recon-id-fix 修正为 C3/gateway-recon-join）
> - v0.1（2026-05-15 起草）
>
> ⚠️ **v0.2 重写说明**：本 spec v0.1 起草时误把 N3 定位到「对账单 ReconID 修复」模块的 gateway 子模式（C4 / `createScenarioConfigDialogC4` / `c4-recon-id-fix.js`）。v0.2 起更正：
> - 真正模块：**银行对账单处理**（`bankStatementProcess`）
> - 真正场景类型：**`gateway-recon-join`**（label「提取ReconId-From 网关」）
> - 真正 dialog：**`createScenarioConfigDialogC3`**（`src/renderer-dialogs.js:5980-6122`）
> - 真正引擎：**`runC3Scenario`**（`src/main-process/scenario-engines/c3-gateway-recon-join.js`）
> - 真正 dispatcher 入口：`src/main-process/scenario-engines/index.js:19` 的 `case 'gateway-recon-join'`
>
> N1（模块名加空格）/ N2（场景下拉空状态）的目标文件 / 行号定位不变。

---

## 一、改动总览

| 模块 | 改动类型 | 文件 |
|---|---|---|
| N1 模块名加空格 | 文字字面替换 | `src/renderer.js` / `src/main.js` / `src/backend/usage-stats.js` |
| N2 场景下拉空状态 | UI 行为简化 | `src/renderer.js` |
| N3 C3「条件」栏 — UI | dialog 新增行 + 渲染 / 事件 | `src/renderer-dialogs.js`（`createScenarioConfigDialogC3`） |
| N3 C3「条件」栏 — 默认配置 | 新建场景默认值 | `src/renderer-dialogs.js`（`createDefaultScenarioConfig('gateway-recon-join')`） |
| N3 C3「条件」栏 — 校验 | 校验函数补 conditions 分支 | `src/renderer-dialogs.js`（`validateScenarioDraft` 的 `'gateway-recon-join'` 分支） |
| N3 C3「条件」栏 — confirm 预览 | 预览段追加 conditions | `src/renderer-dialogs.js`（`buildScenarioConfirmDetailHtml` 的 `'gateway-recon-join'` 分支） |
| N3 C3「条件」栏 — 引擎接入 | runC3Scenario 入口新增 Step 0 + evalCondition helper | `src/main-process/scenario-engines/c3-gateway-recon-join.js` |

---

## 二、N1：模块名加空格

### 2.1 改动清单

| 文件 | 行号 | Before | After |
|---|---|---|---|
| `src/renderer.js` | 63 | `name: '对账单ReconID修复'` | `name: '对账单 ReconID 修复'` |
| `src/main.js` | 3136 | `trackedIpcHandle('recon-id-fix:import', '对账单ReconID修复', '导入文件', ...)` | `trackedIpcHandle('recon-id-fix:import', '对账单 ReconID 修复', '导入文件', ...)` |
| `src/main.js` | 3187 | `trackedIpcHandle('recon-id-fix:run', '对账单ReconID修复', '开始运行', ...)` | `trackedIpcHandle('recon-id-fix:run', '对账单 ReconID 修复', '开始运行', ...)` |
| `src/main.js` | 3202 | `` `场景 "${scenario.name}" 不是对账单ReconID修复类，无法运行` `` | `` `场景 "${scenario.name}" 不是对账单 ReconID 修复类，无法运行` `` |
| `src/main.js` | 3238 | `trackedIpcHandle('recon-id-fix:export', '对账单ReconID修复', '导出文件', ...)` | `trackedIpcHandle('recon-id-fix:export', '对账单 ReconID 修复', '导出文件', ...)` |
| `src/backend/usage-stats.js` | 31 | `'单据对账ReconID修复': ['导入文件', '开始运行', '导出文件'],` | `'对账单 ReconID 修复': ['导入文件', '开始运行', '导出文件'],` |

### 2.2 不动清单（关键约束）

- `src/renderer.js:62` `module.id = 'recon-id-fix'`：**不动**（数十处 IPC 引用 + DB schema CHECK 约束）
- `scenario.category` 字段值：`'recon-id-fix'` / `'gateway-recon-id-fix'`：**不动**（DB 历史数据兼容）
- IPC channel name `'recon-id-fix:xxx'`：**不动**（preload 暴露名 + main.js handler 名）
- `src/renderer.js:56` 注释 `// 对账单ReconID修复模块`：不强制刷（注释属历史痕迹，不影响代码行为）
- `.usage-stats.txt` 历史 `[单据对账ReconID修复]` section：保留为孤儿（用户已确认不做 migration）

### 2.3 影响：usage-stats 写盘行为

`src/backend/usage-stats.js:49-64 defaultStats()` 在每次启动 / parse 失败时由 `FUNCTION_REGISTRY` 重建 `stats.modules`；改 key 后下次 flush 时新文件结构包含：

```
[对账单 ReconID 修复]
导入文件=N
开始运行=N
导出文件=N
小计=...
```

**`writeStatsFile()` 行为已确认**（用户已说明）：按 `FUNCTION_REGISTRY` 顺序输出，旧 key `'单据对账ReconID修复'` 自动不出现，无需额外清理代码。事实上 ReconID 模块从未成功计数过，旧 section 字段值全为 0，无有效数据丢失。

---

## 三、N2：场景下拉空状态优化

### 3.1 当前实现（`src/renderer.js:3570-3608`）

```javascript
function renderReconIdFixScenarioSelect() {
  const select = elements.reconIdFixScenarioSelect;
  if (!select) return;
  const hasCategory = state.reconIdFixBillCategory === 'business' || state.reconIdFixBillCategory === 'gateway';
  if (!hasCategory) {
    select.innerHTML = '<option value=""></option>';     // 档 1：保留
    select.disabled = true;
    select.value = '';
    return;
  }
  const scenarios = Array.isArray(state.reconIdFixScenarios) ? state.reconIdFixScenarios : [];
  if (scenarios.length === 0) {
    select.innerHTML = '<option value="">请先在场景管理中创建场景</option>';   // 档 2：改
    select.disabled = true;
    select.value = '';
    return;
  }
  const opts = ['<option value="">请选择场景</option>']                          // 档 3：改（删占位）
    .concat(scenarios.map((s) => {
      const idStr = String(s.id);
      const name = String(s.name || '');
      const escapedName = name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return `<option value="${idStr}">${escapedName}</option>`;
    }))
    .join('');
  select.innerHTML = opts;
  select.disabled = false;
  const desired = state.reconIdFixSelectedScenarioId !== null
    ? String(state.reconIdFixSelectedScenarioId)
    : '';
  select.value = desired;
}
```

### 3.2 v2.1.5 改后

```javascript
function renderReconIdFixScenarioSelect() {
  const select = elements.reconIdFixScenarioSelect;
  if (!select) return;
  const hasCategory = state.reconIdFixBillCategory === 'business' || state.reconIdFixBillCategory === 'gateway';
  if (!hasCategory) {
    // 档 1：账单类别为空 → 真空白（不变）
    select.innerHTML = '<option value=""></option>';
    select.disabled = true;
    select.value = '';
    return;
  }
  const scenarios = Array.isArray(state.reconIdFixScenarios) ? state.reconIdFixScenarios : [];
  if (scenarios.length === 0) {
    // 档 2：v2.1.5 N2 改 — 真空白（去掉"请先在场景管理中创建场景"提示）
    select.innerHTML = '<option value=""></option>';
    select.disabled = true;
    select.value = '';
    return;
  }
  // 档 3：v2.1.5 N2 改 — 直接列 scenarios（去掉"请选择场景"占位项）
  const opts = scenarios.map((s) => {
    const idStr = String(s.id);
    const name = String(s.name || '');
    const escapedName = name
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    return `<option value="${idStr}">${escapedName}</option>`;
  }).join('');
  select.innerHTML = opts;
  select.disabled = false;
  // ⚠️ 注意：select.value 设置规则保持不变（用户未主动选时为 ''）；
  //   但去掉占位项后，HTML <select> 默认会选中第 1 个 <option> 显示 — 这与「未选状态」矛盾
  //   解决方案：用 select.selectedIndex = -1 显式置为"未选中"（HTML 标准用法，无可见占位项）
  const desired = state.reconIdFixSelectedScenarioId !== null
    ? String(state.reconIdFixSelectedScenarioId)
    : '';
  if (desired === '') {
    select.selectedIndex = -1;
  } else {
    select.value = desired;
  }
}
```

### 3.3 关键技术点

- HTML `<select>` 元素默认会选中第一个 `<option>` 进行显示。v2.1.4 版本通过 `<option value="">请选择场景</option>` 充当"空值占位项"，select.value="" 时显示该项；v2.1.5 删占位项后必须用 `select.selectedIndex = -1` 显式置为"未选中"，否则 select 会显示 `scenarios[0].name` 但 `select.value = scenarios[0].id`，与 state 不一致
- 下游 `updateReconIdFixUi`、`onScenarioChange` 等函数均依赖 `state.reconIdFixSelectedScenarioId !== null` 判断是否选中场景；与 select.value 无直接耦合，本次改动安全

### 3.4 dev 阶段确认点

- [x] dev 阶段需手动验证 `select.selectedIndex = -1` 在 Electron 36 渲染时的视觉效果（应显示空白）
- [x] dev 阶段需 grep `state.reconIdFixSelectedScenarioId` 用法，确认无任何代码假设 select.value 与 state 一一映射
- [x] dev 阶段需检查 v2.1.0-beta.3 T11 段（`src/renderer.js:3637-3642`）的「按钮 disabled」分支是否仍正常（应仍正常 — 不依赖 select 的占位项）

### 3.5 v0.3 fix1.2 修订（2026-05-15 用户测试反馈）

**问题**：v0.2 档 3 设计为 `select.selectedIndex = -1`（HTML 标准未选状态），用户必须主动点开下拉才能选场景；用户期望加载后**自动选第 1 个**。

**修复方案**：
- **不在 `renderReconIdFixScenarioSelect` 里改 state**（render 函数应纯，避免循环触发 reload）
- 改 `reloadReconIdFixScenarios`（src/renderer.js 第 3528-3568 行附近）：scenarios 加载完成后，如果 `state.reconIdFixSelectedScenarioId === null && scenarios.length > 0` → 自动设 `state.reconIdFixSelectedScenarioId = scenarios[0].id`
- 下游 `refreshReconIdFixStatus()` 在 `reloadReconIdFixScenarios` 末尾统一触发（与用户手动选场景副作用一致）
- `renderReconIdFixScenarioSelect` 末尾的 `if (desired === '') select.selectedIndex = -1;` 兜底分支可删（reloadReconIdFixScenarios 已保证 scenarios 非空时 state 必有值）

**Before（v0.2，spec §3.2）**：

```javascript
// reloadReconIdFixScenarios 末段
if (state.reconIdFixSelectedScenarioId !== null
    && !state.reconIdFixScenarios.some((s) => s.id === state.reconIdFixSelectedScenarioId)) {
  state.reconIdFixSelectedScenarioId = null;
}
// （没有自动选第 1 个）
```

**After（v0.3 fix1.2）**：

```javascript
// reloadReconIdFixScenarios 末段
if (state.reconIdFixSelectedScenarioId !== null
    && !state.reconIdFixScenarios.some((s) => s.id === state.reconIdFixSelectedScenarioId)) {
  state.reconIdFixSelectedScenarioId = null;
}
// v2.1.5 fix1.2：scenarios 加载完成后，如果当前未选场景且列表非空 → 自动选第 1 个
if (state.reconIdFixSelectedScenarioId === null && state.reconIdFixScenarios.length > 0) {
  state.reconIdFixSelectedScenarioId = state.reconIdFixScenarios[0].id;
}
```

**renderReconIdFixScenarioSelect 末段简化（After）**：

```javascript
// 同步 select.value 与 state（reloadReconIdFixScenarios fix1.2 已保证 scenarios 非空时
// state.reconIdFixSelectedScenarioId 必有值，此处直接 select.value = desired 即可）
const desired = state.reconIdFixSelectedScenarioId !== null
  ? String(state.reconIdFixSelectedScenarioId)
  : '';
select.value = desired;
```

**回归路径覆盖**：
- `renderReconIdFixScenarioSelect` 共 2 个 caller：reloadReconIdFixScenarios（行 3565）和 onCategoryChange 类别清空分支（行 3744 — scenarios 已强制清空，走档 1/2）。fix1.2 后 desired==='' 路径只剩档 1/2，本身已 `select.value = ''` 即可，无需 selectedIndex=-1
- 删完所有场景再加 1 个 → reloadReconIdFixScenarios 重跑 → 自动选这个新加的

---

## 四、N3：C3「提取ReconId-From 网关」场景「条件」栏

### 4.1 数据结构

#### 4.1.1 scenario.config.conditions（DB JSON blob 内字段）

```javascript
config.conditions = [
  {
    side: '网关',          // '网关' | '银行'
    field: 'BillDate',     // 字符串：side='网关' 时取自 GATEWAY_RECON_FIELDS（31 列）；side='银行' 时取自 BANK_STATEMENT_FIELDS_FOR_C3（45 项）
    op: '等于',            // SCENARIO_CONDITION_OPS 之一
    value: '2026-04-01'    // 字符串；op = '空值' / '非空值' 时忽略
  },
  // ... AND 关系，多条目同时满足
]
```

- 字段命名沿用 C1 的 `field / op / value`，新增 `side`
- 顺序：用户在 dialog 中添加的顺序（数组顺序无业务语义）
- DB 持久化：直接 JSON 序列化进 `scenarios.config` 列（已是 JSON blob，scenarios-repository.js 已通过 JSON.stringify/parse 透传，无 schema 变更）

#### 4.1.2 默认值（`createDefaultScenarioConfig` 修订）

`src/renderer-dialogs.js:5719-5724` 当前：

```javascript
if (category === 'gateway-recon-join') {
  return {
    reconFields: [{ seq: 1, gwField: '', bankField: '' }],
    assign: { gwField: '', bankField: '' }
  };
}
```

v2.1.5 改为：

```javascript
if (category === 'gateway-recon-join') {
  return {
    // v2.1.5 N3：柔性默认 — 空数组（不强制添加首行；区别于 C1 默认 1 行）
    conditions: [],
    reconFields: [{ seq: 1, gwField: '', bankField: '' }],
    assign: { gwField: '', bankField: '' }
  };
}
```

#### 4.1.3 dialog 初始化兜底（旧 scenario 兼容）

`src/renderer-dialogs.js:5990-5993` 当前：

```javascript
if (!Array.isArray(config.reconFields) || config.reconFields.length === 0) {
  config.reconFields = [{ seq: 1, gwField: '', bankField: '' }];
}
if (!config.assign) config.assign = { gwField: '', bankField: '' };
```

v2.1.5 在该段后追加：

```javascript
// v2.1.5 N3：旧 v2.1.4 scenario 无 conditions 字段 → 默认空数组（不过滤）
if (!Array.isArray(config.conditions)) {
  config.conditions = [];
}
```

#### 4.1.4 引擎兜底（无 conditions 时全通过）

```javascript
// runC3Scenario 入口（详 §4.5）
const conditions = Array.isArray(config.conditions) ? config.conditions : [];
// conditions.length === 0 → gwConditions/bankConditions 各为空 → filter 全通过
```

### 4.2 UI — dialog 接入点

#### 4.2.1 插入位置

`src/renderer-dialogs.js:5999-6038` `dialog.innerHTML` 模板。在「优先级」行（行 6009-6012）之后、「对账字段」行（行 6013-6019）之前插入新行：

```javascript
dialog.innerHTML = `
  <div class="dialog-header">...</div>
  <div class="dialog-body scenario-config-body">
    <!-- 行 1：场景名称（既有） -->
    <div class="scenario-config-row">
      <span class="scenario-config-label">场景名称</span>
      <input ... data-field="name" ... >
    </div>
    <!-- 行 2：优先级（既有） -->
    <div class="scenario-config-row">
      <span class="scenario-config-label">优先级 <span class="scenario-config-tooltip" title="3 = 最高，0 = 最低">ⓘ</span></span>
      <input ... data-field="priority" ... >
    </div>
    <!-- 行 3：v2.1.5 N3 新增 — 条件 -->
    <div class="scenario-config-row scenario-config-row-multi">
      <span class="scenario-config-label">条件 <span class="scenario-config-tooltip" title="同时满足全部条件才进入提取（AND）">ⓘ</span></span>
      <div class="scenario-config-multi-wrap">
        <div class="scenario-config-multi-rows" data-multi="c3-conditions"></div>
        ${isReadonly ? '' : '<button class="text-action small" type="button" data-action="add-c3-condition">+ 新增条件</button>'}
      </div>
    </div>
    <!-- 行 4：对账字段（原行 3） -->
    <div class="scenario-config-row scenario-config-row-multi">
      <span class="scenario-config-label">对账字段</span>
      ...
    </div>
    <!-- 行 5：对账成立后赋值（原行 4） -->
    <div class="scenario-config-row">
      <span class="scenario-config-label">对账成立后赋值</span>
      ...
    </div>
  </div>
`;
```

#### 4.2.2 单条件行渲染函数

```javascript
function renderC3ConditionRow(cd, idx, totalCount) {
  const fields = cd.side === '银行' ? BANK_STATEMENT_FIELDS_FOR_C3 : GATEWAY_RECON_FIELDS;
  const valueHidden = !opNeedsValue(cd.op);
  return `
    <div class="scenario-config-multi-row" data-c3-cond-row="${idx}">
      <select class="scenario-config-input scenario-config-input-narrow" data-c3-cond-field="side" ${isReadonly ? 'disabled' : ''}>
        <option value="网关"${cd.side === '网关' ? ' selected' : ''}>网关</option>
        <option value="银行"${cd.side === '银行' ? ' selected' : ''}>银行</option>
      </select>
      <select class="scenario-config-input" data-c3-cond-field="field" ${isReadonly ? 'disabled' : ''}>
        <option value="">请选择字段</option>
        ${renderScenarioOptions(fields, cd.field)}
      </select>
      <select class="scenario-config-input scenario-config-input-narrow" data-c3-cond-field="op" ${isReadonly ? 'disabled' : ''}>
        ${renderScenarioOptions(SCENARIO_CONDITION_OPS, cd.op || '等于')}
      </select>
      <input class="scenario-config-input" type="text" data-c3-cond-field="value" ${isReadonly ? 'disabled' : ''} value="${escapeHtml(cd.value || '')}" placeholder="值" ${valueHidden ? 'style="visibility:hidden"' : ''}>
      ${isReadonly ? '' : '<button class="icon-close-small" type="button" data-c3-cond-action="remove" title="删除">×</button>'}
    </div>
  `;
}

function renderC3Conditions() {
  const container = dialog.querySelector('[data-multi="c3-conditions"]');
  if (!container) return;
  const total = config.conditions.length;
  container.innerHTML = config.conditions.map((cd, idx) => renderC3ConditionRow(cd, idx, total)).join('');
}

renderC3Conditions();   // 首次渲染（条件为空时容器内为空字符串，由「+ 新增条件」按钮承担继续添加）
```

#### 4.2.3 事件绑定（参考 C1 §6237-6271）

```javascript
const condContainer = dialog.querySelector('[data-multi="c3-conditions"]');

condContainer?.addEventListener('change', (event) => {
  if (isReadonly) return;
  const ctl = event.target.closest('[data-c3-cond-field]');
  if (!ctl) return;
  const row = ctl.closest('.scenario-config-multi-row');
  const idx = Number(row?.dataset.c3CondRow);
  const f = ctl.dataset.c3CondField;
  if (!Number.isFinite(idx) || !config.conditions[idx]) return;
  config.conditions[idx][f] = ctl.value;
  // 关键：side / op 切换需重渲（side 切换重新拉字段下拉枚举 + 清空 field；op 切换隐藏/显示 value）
  if (f === 'side') {
    config.conditions[idx].field = '';   // 清空 field 当前值（防御切换后旧字段名残留）
    renderC3Conditions();
  } else if (f === 'op') {
    renderC3Conditions();
  }
});

condContainer?.addEventListener('input', (event) => {
  if (isReadonly) return;
  const input = event.target.closest('input[data-c3-cond-field="value"]');
  if (!input) return;
  const row = input.closest('.scenario-config-multi-row');
  const idx = Number(row?.dataset.c3CondRow);
  if (Number.isFinite(idx) && config.conditions[idx]) {
    config.conditions[idx].value = input.value;
  }
});

condContainer?.addEventListener('click', (event) => {
  if (isReadonly) return;
  const removeBtn = event.target.closest('button[data-c3-cond-action="remove"]');
  if (!removeBtn) return;
  const row = removeBtn.closest('.scenario-config-multi-row');
  const idx = Number(row?.dataset.c3CondRow);
  if (Number.isFinite(idx)) {
    // v2.1.5 N3 柔性校验：可删完所有条件
    config.conditions.splice(idx, 1);
    renderC3Conditions();
  }
});

dialog.querySelector('[data-action="add-c3-condition"]')?.addEventListener('click', () => {
  if (isReadonly) return;
  config.conditions.push({ side: '网关', field: '', op: '等于', value: '' });
  renderC3Conditions();
});
```

### 4.3 校验规则

`src/renderer-dialogs.js:5841-5846` `validateScenarioDraft` 的 `'gateway-recon-join'` 分支：

```javascript
} else if (draft.category === 'gateway-recon-join') {
  const c = draft.config || {};
  // 既有：reconFields + assign 校验
  if (!Array.isArray(c.reconFields) || c.reconFields.length === 0) errors.push('对账字段至少需要 1 行');
  else if (c.reconFields.some((r) => !r.gwField || !r.bankField)) errors.push('对账字段每行两端都不能为空');
  const a = c.assign || {};
  if (!a.gwField || !a.bankField) errors.push('对账成立后赋值的两端都不能为空');

  // v2.1.5 N3 新增：conditions 柔性校验
  //   conditions.length === 0 → 通过（视为不过滤）
  //   ≥ 1 行 → 每行 side / field 必填；非"空值/非空值" op 的 value 必填；side 与 field 一致性校验
  const conds = Array.isArray(c.conditions) ? c.conditions : [];
  if (conds.length > 0) {
    conds.forEach((cd, idx) => {
      const rowLabel = `条件 #${idx + 1}`;
      if (cd.side !== '网关' && cd.side !== '银行') {
        errors.push(`${rowLabel} 的"侧"必填（网关 / 银行）`);
        return;
      }
      if (!cd.field || String(cd.field).trim() === '') {
        errors.push(`${rowLabel} 的"字段"不能为空`);
        return;
      }
      // side 与 field 一致性（防御左一切换未清空 + 手改 DB）
      const validFields = cd.side === '网关' ? GATEWAY_RECON_FIELDS : BANK_STATEMENT_FIELDS_FOR_C3;
      if (!validFields.includes(cd.field)) {
        errors.push(`${rowLabel} 的"字段" ${cd.field} 不在 ${cd.side} 字段列表中`);
        return;
      }
      if (opNeedsValue(cd.op) && (cd.value === '' || cd.value === undefined)) {
        errors.push(`${rowLabel} 非"空值/非空值"操作的"值"不能为空`);
      }
    });
  }
}
```

### 4.4 confirm 预览段

`src/renderer-dialogs.js:7424-7427` `buildScenarioConfirmDetailHtml` 的 `'gateway-recon-join'` 分支当前：

```javascript
} else if (draft.category === 'gateway-recon-join') {
  html += `<div class="scenario-confirm-detail-section">
    <span class="scenario-confirm-detail-label">对账字段（AND）：</span>
    <ul>${(c.reconFields || []).map((r) => `<li>网关 ${escapeHtml(r.gwField)} = 银行 ${escapeHtml(r.bankField)}</li>`).join('')}</ul>
  </div>`;
  const a = c.assign || {};
  html += `<div class="scenario-confirm-detail-section">
    <span class="scenario-confirm-detail-label">赋值：</span>网关 ${escapeHtml(a.gwField || '')} → 银行 ${escapeHtml(a.bankField || '')}
  </div>`;
}
```

v2.1.5 改为（在「对账字段」段之前插入 conditions 段，仅当 ≥ 1 行时渲染）：

```javascript
} else if (draft.category === 'gateway-recon-join') {
  // v2.1.5 N3：conditions 段（仅当 ≥ 1 行时渲染）
  const conds = Array.isArray(c.conditions) ? c.conditions : [];
  if (conds.length > 0) {
    html += `<div class="scenario-confirm-detail-section">
      <span class="scenario-confirm-detail-label">条件（AND）：</span>
      <ul>${conds.map((cd) =>
        `<li>${escapeHtml(cd.side)} ${escapeHtml(cd.field)} ${escapeHtml(cd.op)}${opNeedsValue(cd.op) ? ' ' + escapeHtml(String(cd.value || '')) : ''}</li>`
      ).join('')}</ul>
    </div>`;
  }
  // 既有 reconFields + assign 段
  html += `<div class="scenario-confirm-detail-section">
    <span class="scenario-confirm-detail-label">对账字段（AND）：</span>
    <ul>${(c.reconFields || []).map((r) => `<li>网关 ${escapeHtml(r.gwField)} = 银行 ${escapeHtml(r.bankField)}</li>`).join('')}</ul>
  </div>`;
  const a = c.assign || {};
  html += `<div class="scenario-confirm-detail-section">
    <span class="scenario-confirm-detail-label">赋值：</span>网关 ${escapeHtml(a.gwField || '')} → 银行 ${escapeHtml(a.bankField || '')}
  </div>`;
}
```

### 4.5 引擎接入

`src/main-process/scenario-engines/c3-gateway-recon-join.js`。

#### 4.5.1 新增 `evalCondition` helper（顶部 require 段附近）

需要新增包装函数，因为 `engine-utils.js evaluateCondition` 直接取 `row[condition.field]`，不会走银行侧虚拟字段计算（`getBankRowValueForC3`）。

```javascript
const {
  ensureRowId,
  evaluateCondition,        // ← 新增 require
  isEmptyValue,
  makeModificationCollector,
  makeWarningCollector,
  normalizeCellValue,
  parseNumber,
  valuesEqual
} = require('./engine-utils');

const { BANK_STATEMENT_VIRTUAL_AMOUNT_ABS } = require('../../constants/bank-statement-fields');

// v2.1.5 N3：包装 evaluateCondition 以支持银行侧虚拟字段「发生额绝对值」
//   - useC3BankValueGetter: false → 网关侧，直接调 evaluateCondition(row, cd)
//   - useC3BankValueGetter: true  → 银行侧，先用 getBankRowValueForC3(row, cd.field) 取值再代入临时 row 调 evaluateCondition
function evalCondition(row, cd, { useC3BankValueGetter = false } = {}) {
  if (!cd || !cd.field) return true;   // 防御：未配置 field 视为通过
  if (!useC3BankValueGetter) {
    return evaluateCondition(row, cd);
  }
  // 银行侧：包装一层把虚拟字段计算结果注入临时 row
  const value = getBankRowValueForC3(row, cd.field);
  // value 可能是 number（虚拟字段）/ 字符串 / undefined；evaluateCondition 内部 normalizeCellValue 会兜底
  const wrappedRow = { [cd.field]: value };
  return evaluateCondition(wrappedRow, cd);
}
```

#### 4.5.2 `runC3Scenario` 入口新增 Step 0

`src/main-process/scenario-engines/c3-gateway-recon-join.js:48-114` 当前 `runC3Scenario` 直接对 `bankRows` forEach + `gwRows.filter`。v2.1.5 在校验段（行 67-90）通过后、`bankRows.forEach` 之前（行 92 上方）插入 Step 0：

```javascript
function runC3Scenario(scenario, bankRows, gwRows) {
  const warningCollector = makeWarningCollector(scenario.id, scenario.name);
  const modCollector = makeModificationCollector();
  const config = scenario.config || {};
  const reconFields = config.reconFields || [];
  const assign = config.assign || {};

  if (!Array.isArray(gwRows) || gwRows.length === 0) {
    /* 既有 — no-gateway-rows warning + return */
  }
  if (reconFields.length === 0) {
    /* 既有 — invalid-config warning + return */
  }
  if (!assign.gwField || !assign.bankField) {
    /* 既有 — invalid-config warning + return */
  }

  // ===== v2.1.5 N3：Step 0 — 按 conditions 拆分两侧 + 行级过滤（AND 关系）=====
  //   - 兜底：cfg.conditions 缺失 / 空数组 → gwConditions/bankConditions 各为空 → 不过滤（向下兼容 v2.1.4）
  //   - 网关侧条件用 evalCondition(row, cd, { useC3BankValueGetter: false })
  //   - 银行侧条件用 evalCondition(row, cd, { useC3BankValueGetter: true })（支持虚拟字段「发生额绝对值」）
  const conditions = Array.isArray(config.conditions) ? config.conditions : [];
  const gwConditions = conditions.filter((c) => c && c.side === '网关' && c.field);
  const bankConditions = conditions.filter((c) => c && c.side === '银行' && c.field);

  const gwRowsFiltered = gwConditions.length === 0
    ? gwRows
    : gwRows.filter((row) => gwConditions.every((c) => evalCondition(row, c, { useC3BankValueGetter: false })));
  const bankRowsFiltered = bankConditions.length === 0
    ? bankRows
    : bankRows.filter((row) => bankConditions.every((c) => evalCondition(row, c, { useC3BankValueGetter: true })));

  // ===== Step 2（既有循环；改用过滤后的子集）=====
  bankRowsFiltered.forEach((bankRow, index) => {
    const rowId = ensureRowId(bankRow, index);
    const matched = gwRowsFiltered.filter((gwRow) => gwMatchesBank(gwRow, bankRow, reconFields));
    if (matched.length === 0) return;
    /* 后续 multi-match warning + assign 写值 — 既有逻辑零修改 */
  });

  return {
    lockedRowIds: modCollector.listLockedRowIds(),
    modifications: modCollector.listModifications(),
    warnings: warningCollector.list()
  };
}
```

**改动差异**：
- L1：新增 require `evaluateCondition`（来自 engine-utils.js）
- L2：新增 helper `evalCondition`（包装虚拟字段处理）
- L3：runC3Scenario 入口新增 Step 0 段（约 12 行）
- L4：`bankRows.forEach` → `bankRowsFiltered.forEach`
- L5：`gwRows.filter(...)` → `gwRowsFiltered.filter(...)`

**零修改**：
- `gwMatchesBank` / `getBankRowValueForC3` / assign 写值循环（资金红线）

#### 4.5.3 module.exports 同步暴露 `evalCondition`

```javascript
module.exports = {
  evalCondition,    // v2.1.5 N3 新增（暴露给 smoke）
  getBankRowValueForC3,
  gwMatchesBank,
  runC3Scenario
};
```

### 4.6 dispatcher 检查

`src/main-process/scenario-engines/index.js:19` 当前已有：

```javascript
case 'gateway-recon-join':
  return runC3Scenario(scenario, bankRows, gwRows);
```

**dispatcher 不需要改动**（runC3Scenario 签名不变）。

### 4.7 ⚠️ 边界确认点（PRD §十 待确认 1 / 2）

#### 边界 1：银行侧虚拟字段处理

- dialog 字段下拉枚举源 `BANK_STATEMENT_FIELDS_FOR_C3` 包含虚拟字段「发生额绝对值」
- 引擎运行时银行侧条件必须走 `getBankRowValueForC3` 取值（与既有 `gwMatchesBank` 中 reconFields 银行侧虚拟字段处理一致）
- spec §4.5.1 已实现 `evalCondition({ useC3BankValueGetter: true })` 包装

**dev 阶段确认**：用户拍板"网关侧不走 getBankRowValueForC3"（getBankRowValueForC3 只处理银行侧字段，网关侧字段直接 `row[field]` 取值即可）。

#### 边界 2：side / field 一致性校验

- spec §4.3 已实现 dialog 保存时 alert 校验
- 防御场景：用户左一切换后忘记重选 field（应已被左一切换时清空），或手改 DB
- **dev 阶段确认**：是否同步在引擎入口做防御性 sanitize？PM 拟**不做**（dialog 校验已防御；引擎容错为「字段不存在 → undefined → 过滤掉该行」，行为可预期）

### 4.8 v0.3 fix1.1 修订（2026-05-15 用户测试反馈）

**问题**：v0.2 实现复用 `.scenario-config-multi-row` flex 布局；左一切「网关」时左二字段 select 因 `GATEWAY_RECON_FIELDS` 含 30+ 字符的字段名（`'Type(0:1对1,1:1对多,2:多对1,3:多对1（轧差合并)'`）撑大 select 宽度，导致整行宽度比左一切「银行」时（`BANK_STATEMENT_FIELDS_FOR_C3` 最长 23 字符 `Transaction Description`）更宽 — 切换瞬间 row 宽度肉眼可见跳变，UX 不一致。

**修复方案**：
1. 给 C3 「条件」row 加专属 class `scenario-config-c3-cond-row`（grid 布局）
2. 左二字段 select 加专属 class `scenario-config-c3-cond-field`（固定宽度 240px + ellipsis）
3. **不复用** `.scenario-config-multi-row` — 避免影响 reconFields / billTypes 行的既有 flex 布局

**Before（v0.2，spec §4.2.2）**：

```html
<div class="scenario-config-multi-row" data-c3-cond-row="${idx}">
  <select class="scenario-config-input scenario-config-input-narrow" data-c3-cond-field="side">...</select>
  <select class="scenario-config-input" data-c3-cond-field="field">...</select>  <!-- flex:1 + min-width:0，被超长 option 撑开 -->
  <select class="scenario-config-input scenario-config-input-narrow" data-c3-cond-field="op">...</select>
  <input class="scenario-config-input" type="text" data-c3-cond-field="value" ...>
  <button class="icon-close-small" data-c3-cond-action="remove">×</button>
</div>
```

**After（v0.3 fix1.1）**：

```html
<div class="scenario-config-c3-cond-row" data-c3-cond-row="${idx}">
  <select class="scenario-config-input scenario-config-input-narrow" data-c3-cond-field="side">...</select>
  <select class="scenario-config-input scenario-config-c3-cond-field" data-c3-cond-field="field">...</select>
  <select class="scenario-config-input scenario-config-input-narrow" data-c3-cond-field="op">...</select>
  <input class="scenario-config-input" type="text" data-c3-cond-field="value" ...>
  <button class="icon-close-small" data-c3-cond-action="remove">×</button>
</div>
```

**新增 CSS（src/styles.css + src/styles-gemini-extra.css 两套主题同步）**：

```css
/* C3 条件 row — grid 列宽固定 */
.scenario-config-c3-cond-row {
  display: grid;
  grid-template-columns: 100px 240px 100px minmax(0, 1fr) 22px;
  gap: 8px;
  align-items: center;
  padding: 4px 6px;
  background: rgba(0, 0, 0, 0.02);  /* gemini 主题用 rgba(60, 64, 67, 0.04) */
  border-radius: 4px;
}

.scenario-config-c3-cond-field {
  flex: 0 0 240px;
  width: 240px;
  min-width: 0;
  text-overflow: ellipsis;
  overflow: hidden;
}
```

**事件绑定 selector 同步（renderer-dialogs.js c3 闭包内 3 处 closest）**：

- `closest('.scenario-config-multi-row')` → `closest('.scenario-config-c3-cond-row')`（change / input / click 三个事件 handler 同步改）

**回归路径**：
- `closest` selector 与 row 专属 class 一致，事件路径未中断
- reconFields / billTypes / assign 行仍用 `.scenario-config-multi-row` flex 布局，零影响

**视觉验证**：
- preview 重跑 `scenario-config-c3.png` 对照（CLAUDE.md memory `workflow_frontend_previews`）
- 切左一「网关」↔「银行」时 row 宽度无肉眼可见跳变
- 即使选超长字段 `Type(0:1对1,...)`，select 闭合状态 ellipsis 截断；下拉打开时 option 完整可见

---

## 五、关联功能 review 预判（Important Variables）

| 变量 | 层级 | 命中点 |
|---|---|---|
| `MODULE_REGISTRY.reconIdFix.name` | Important-skeleton（v2.1.4 升格 + v2.1.5 修订） | N1 |
| `state.reconIdFixSelectedScenarioId` | Runtime-state | N2（select.value / selectedIndex 与 state 一致性） |
| `scenario.config` JSON blob | Risk-sensitive（资金算法链路） | N3（新增 conditions 字段） |
| `evaluateCondition` (engine-utils.js) | Important-skeleton | N3（运行时复用，无修改） |
| `runC3Scenario` (c3-gateway-recon-join.js) | **Critical（资金对账引擎入口）** | N3（入口新增 Step 0 + bankRows/gwRows 替换为过滤后子集） |
| `gwMatchesBank` (c3-gateway-recon-join.js) | Critical | N3（**零修改**，仅入参 gwRows 改为 gwRowsFiltered） |
| `getBankRowValueForC3` (c3-gateway-recon-join.js) | Important-skeleton | N3（**零修改**，新增 helper evalCondition 复用） |
| `FUNCTION_REGISTRY` (usage-stats.js) | Important-skeleton | N1 |
| `trackedIpcHandle` 第 2 参 | Important-skeleton | N1 |

**进入 PR 阶段前必须跑 `/check-vars`**（按 CLAUDE.md 硬节点）。

---

## 六、Smoke 测试拓展（拟定）

`scripts/smoke-test.js` 增加 Case：

| Case | 输入 | 期望 |
|---|---|---|
| RECON-ID-FIX-NAME-1 | 启动应用 + 进对账单 ReconID 修复模块跑导入/运行/导出各 1 次 + 关闭 | `.usage-stats.txt` 包含 `[对账单 ReconID 修复]` section + 3 个 fnKey 各 ≥ 1 |
| RECON-ID-FIX-NAME-2 | 旧 `.usage-stats.txt` 含 `[单据对账ReconID修复]` section（全 0）启动 + 跑 1 次 + 关闭 | 输出文件中旧 section 不再出现，新 section 出现 |
| RECON-ID-FIX-SCENARIO-EMPTY | 渲染 select：账单类别 = gateway + scenarios = [] | `select.innerHTML === '<option value=""></option>'`，disabled = true |
| RECON-ID-FIX-SCENARIO-WITH-DATA | 渲染 select：账单类别 = gateway + scenarios = [{id:1,name:'A'}] | `select.innerHTML` 仅含 `<option value="1">A</option>`（无占位），select.selectedIndex === -1 |
| C3-COND-1 | C3 场景 `config.conditions = [{side:'网关',field:'Currency',op:'等于',value:'HKD'}]` + gwRows 2 行（HKD/USD）+ bankRows 2 行 | gwRowsFiltered 仅 1 行（HKD）；bankRowsFiltered 不变；assign 写入按过滤后子集进行 |
| C3-COND-2 | `[{side:'网关',Currency,等于,HKD},{side:'银行',Currency,等于,HKD}]` AND | gwRowsFiltered 仅留 HKD；bankRowsFiltered 仅留 Currency=HKD |
| C3-COND-VIRTUAL | 银行侧条件 `[{side:'银行',field:'发生额绝对值',op:'等于',value:'100'}]` + bankRows 含 \|Credit-Debit\|=100 行 | 引擎走 `getBankRowValueForC3`，过滤后命中该行 |
| C3-COND-EMPTY | C3 场景 `config.conditions = []` 或 undefined | 不过滤，gwRows / bankRows 全集进入既有循环 |
| C3-COND-LEGACY | C3 场景 v2.1.4 旧 DB 数据（无 conditions 字段） | 引擎兜底 `[]`，行为与 v2.1.4 完全一致 |
| C3-COND-OP-EMPTY | 条件 `[{side:'网关',field:'Bank',op:'空值',value:''}]` | 命中 Bank 字段为空字符串/undefined 的行 |

---

## 七、回滚策略

- N1：revert 4 个文件修改（`renderer.js:63` + `main.js:3136/3187/3202/3238` + `usage-stats.js:31`）；旧 `.usage-stats.txt` 中 v2.1.5 写盘的新 section `[对账单 ReconID 修复]` 在回滚后变孤儿（与 v2.1.5 的旧 section 孤儿对称），无需 migration
- N2：revert `renderer.js:3570-3608`
- N3：revert `renderer-dialogs.js`（`createDefaultScenarioConfig` + `createScenarioConfigDialogC3` + `validateScenarioDraft` + `buildScenarioConfirmDetailHtml`）+ `c3-gateway-recon-join.js`（require / evalCondition helper / runC3Scenario Step 0 / module.exports）；DB 中已写入的 `config.conditions` 字段在 v2.1.4 引擎中**不被读取**，无需 migration（向下兼容）

---

## 八、文档版本号

- `package.json`：2.1.4 → 2.1.5（已 bump，team-lead 已操作）
- `CHANGELOG.md`：发版前补 v2.1.5 段（PM 阶段不改）
- `docs/VERSION_FEATURE_HISTORY.md`：发版前补 v2.1.5 条目（PM 阶段不改）
- `docs/USER_GUIDE.md`：发版前更新（PM 阶段不改）— 顶部版本号 + §1.5 段补「v2.1.5 起模块名加空格 + ReconID 场景下拉空状态优化」+ §1.4「银行对账单处理」段补「提取ReconId-From 网关」场景新增「条件」栏说明

---

## 九、PRD 评审意见（技术角度）

### 9.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---|---|
| §5.1 N1 模块名加空格 | 字面替换 6 处 + bug 修复（usage-stats key 不匹配），技术风险低 |
| §5.2 N2 场景下拉空状态 | 单函数改造 ~15 行；注意 `select.selectedIndex = -1` HTML 标准用法 |
| §5.3 N3 C3 dialog「条件」栏 — UI | 模式 + 渲染 + 事件参考 C1（既有实现）+ 复用 `SCENARIO_CONDITION_OPS` / `opNeedsValue`，工时可控 |
| §5.3 N3 — 默认配置 + 校验 + confirm 预览 + dialog 兜底 | renderer-dialogs.js 内 4 处既有 `'gateway-recon-join'` 分支均需修订；改动均为分支内追加，零侵入既有 C1/C2/C4 |
| §5.3 N3 — 引擎接入 | runC3Scenario 入口新增 Step 0（约 12 行）+ evalCondition helper（约 10 行）；不动 `gwMatchesBank` / `getBankRowValueForC3` 核心逻辑（资金红线零回归） |

### 9.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 | N3 银行侧虚拟字段「发生额绝对值」必须走 `getBankRowValueForC3`（与既有 reconFields 处理一致） | spec §4.5.1 新增 `evalCondition({ useC3BankValueGetter })` 包装；待用户拍板（PRD §十 待确认 1） |
| R-2 | N3 side / field 一致性校验防御「左一切换未清空」+「手改 DB」 | spec §4.3 在 dialog 保存时 alert 校验；引擎入口不做防御性 sanitize（容错语义清晰）；待用户拍板（PRD §十 待确认 2） |
| R-3 | N1 usage-stats.js 旧 section 处理 | 用户已确认 `writeStatsFile` 按 FUNCTION_REGISTRY 顺序输出，旧 key 自动不出现，无需额外清理代码 |
| R-4 | N3 C3 引擎是资金对账链路 → Critical | 改动仅在入口插入 Step 0 + 替换循环入参；核心写值逻辑零修改；smoke 必跑既有 C3 用例 + 4 个新 C3-COND-* 用例；PR 必须人工复核 |

### 9.3 与 PRD 的差异

无（spec 完全按 PRD 落地，仅在 §4.7 提出 2 个边界确认点供用户拍板）。

---

## 十、Open Technical Questions

- [x] **Q1**（同 PRD §十 待确认 1）：N3 银行侧虚拟字段「发生额绝对值」运行时走 `getBankRowValueForC3` 吗？— ✅ 用户确认按 dev 方案：**走**（spec §4.5.1 已实现 `evalCondition({ useC3BankValueGetter: true })` 包装；2026-05-15 拍板）
- [x] **Q2**（同 PRD §十 待确认 2）：side / field 一致性校验在 dialog 保存时同步弹 alert？— ✅ 用户确认按 dev 方案：**弹 alert 拦住保存**（spec §4.3 已实现校验段；2026-05-15 拍板）
