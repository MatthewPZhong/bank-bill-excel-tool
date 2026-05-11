# spec — v2.1.0-beta.2 ReconID 模块 UI 精修 + 场景管理隔离 + 窗口按钮修复

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft） |
| 目标版本 | `v2.1.0-beta.2` |
| 关联 PRD | `PRD-v2.1.0-beta.2.md` |
| 关联 tasks | `tasks.md` |
| 起草日期 | 2026-05-11 |
| 起草人 | team-lead（PM 角色） |

> 本文档落到文件级 + 符号级 + 行号级（基线：v2.1.0-beta.1 已 merge 状态）。

---

## 一、改动文件清单（汇总）

### 1.1 PR-A：业务隔离 + 窗口 bug（约 4 文件）

| 文件 | 改动 | 风险 |
|---|---|---|
| `src/styles-gemini.css` | 新增 `.no-drag { -webkit-app-region: no-drag; }` rule + `.window-actions` / `.window-btn` 兜底 | 低 |
| `src/renderer-dialogs.js` | `createScenariosManagerDialog` 接收 `allowedCategories` 参数；内部过滤 list / 类别选择；`createScenarioCategorySelectDialog` 接收白名单；ReconID 入口"新增场景"调用点判断单类别跳过类别选择 | 中 |
| `src/renderer.js` | 两个入口（`bankStatementScenarioBtn` / `reconIdFixManageScenariosBtn`）调用时传入对应白名单 | 低 |
| `src/renderer-previews.js`（按需） | 新模块场景管理 preview 状态：两个入口各拍一份 | 低 |

### 1.2 PR-B：6 项 UI 调整（约 3 文件）

| 文件 | 改动 | 涉及需求 |
|---|---|---|
| `index.html` | reconIdFixModulePanel 重排：行 1 左 cell = [场景下拉 + 场景管理]，行 1 右 cell = [导入文件 + 开始运行] | 3-1 |
| `src/renderer-dialogs.js` | (a) C4 dialog 标题特例 (3-5) (b) "+ 新增 OR 分组" 文案 (3-4a) (c) OR 分隔 div 去文字 (3-4b) (d) commonId-source select 移除 narrow class (3-3) (e) `getScenarioDialogActions` 改 [确认 取消] 顺序 (3-6) | 3-3/3-4/3-5/3-6 |
| `src/styles-gemini-extra.css` | (a) `.scenario-config-c4-checkboxes` flex-wrap:nowrap (3-2) (b) `.scenario-config-card .dialog-actions` 右对齐（影响 4 dialog） (3-6) (c) `.scenario-config-c4-recon-or-sep` 去文字 + `height: 8px` (3-4b) | 3-2/3-4b/3-6 |
| `src/renderer-previews.js`（按需） | C4 dialog preview 状态确认覆盖 "主从边都修复" 子态截图 | 3-3 |

---

## 二、PR-A 详细设计

### 2.1 R1：场景管理 category 白名单

#### 2.1.1 接口变更：`createScenariosManagerDialog`

`src/renderer-dialogs.js:5390` 当前签名：
```js
function createScenariosManagerDialog() { /* ... */ }
```

改为：
```js
function createScenariosManagerDialog(allowedCategories = null) {
  // null | undefined | 空数组 → 不过滤（向后兼容）
  const filter = Array.isArray(allowedCategories) && allowedCategories.length > 0
    ? allowedCategories
    : null;
  // ...
}
```

> 用户决策：标题统一"场景管理"无后缀，故无 titleSuffix 参数。

#### 2.1.2 列表过滤

`loadScenariosOrAlert` 内（renderer-dialogs.js:5381-5388）保持不变；在 `refreshTable` 渲染前过滤：
```js
async function refreshTable() {
  const scenarios = await loadScenariosOrAlert();
  if (scenarios === null) return;
  const filtered = filter
    ? scenarios.filter((s) => filter.includes(s.category))
    : scenarios;
  tbody.innerHTML = '';
  filtered.forEach((scenario) => tbody.appendChild(renderRow(scenario)));
}
```

#### 2.1.3 标题（不变）

dialog HTML 模板（renderer-dialogs.js:5395-5396）保持原写法：
```html
<div class="dialog-title">场景管理</div>
```
> 用户决策：标题不带后缀，两个入口的 dialog 标题相同。

#### 2.1.4 新增场景类别选择窗口

`createScenarioCategorySelectDialog`（renderer-dialogs.js:5552）当前签名：
```js
function createScenarioCategorySelectDialog() { /* 固定 4 选 1 */ }
```

改为：
```js
function createScenarioCategorySelectDialog(allowedCategories = null) {
  const effectiveCategories = allowedCategories || ['extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'recon-id-fix'];
  // 单类别 → 跳过此窗口，直接进入对应配置弹窗
  if (effectiveCategories.length === 1) {
    state.scenarioDraft = { mode: 'create', category: effectiveCategories[0] };
    closeModal();
    openScenarioConfigByCategory(effectiveCategories[0]);
    return null;  // 不再弹此窗口
  }
  // 多类别 → 渲染选项时过滤
  // ...
}
```

> 注：`closeModal() + openScenarioConfigByCategory` 路径需确认 modal stack 行为；可能需要改为返回新 dialog 实例直接替换。

实际更稳的方案：在调用点（`tbody.querySelector('[data-action="add-scenario"]').click`，renderer-dialogs.js:5540）做判断：
```js
dialog.querySelector('[data-action="add-scenario"]').addEventListener('click', () => {
  if (filter && filter.length === 1) {
    // 单类别入口（ReconID）：跳过类别选择，直接 open 对应配置 dialog
    state.scenarioDraft = { mode: 'create', category: filter[0] };
    closeModal();
    openScenarioConfigByCategory(filter[0]);
  } else {
    // 多类别入口（银行对账单）：弹类别选择窗，按白名单过滤展示
    openModal(createScenarioCategorySelectDialog(filter));
  }
});
```

> 注意：`closeModal()` 必须先调用，再 `openScenarioConfigByCategory`，否则 modal stack 出现两层（场景管理列表 + C4 dialog）。这是单类别入口区别于多类别入口的关键交互——ReconID 入口"新增场景"会**关闭场景管理列表 + 直接进 C4 dialog**。

#### 2.1.5 两个入口的调用点

`src/renderer.js:3717-3719` 银行对账单入口：
```js
elements.bankStatementScenarioBtn.addEventListener('click', () => {
  openModal(createScenariosManagerDialog([
    'extract-recon-id', 'offset-bill-mark', 'gateway-recon-join'
  ]));
});
```

`src/renderer.js:3724-3728` ReconID 入口：
```js
if (elements.reconIdFixManageScenariosBtn) {
  elements.reconIdFixManageScenariosBtn.addEventListener('click', () => {
    openModal(createScenariosManagerDialog(['recon-id-fix']));
  });
}
```

### 2.2 R2：窗口按钮 hit-test

#### 2.2.1 CSS 新增 rule

`src/styles-gemini.css` 在 `.window-actions` rule 之后（L80 附近）追加：
```css
.no-drag,
.window-actions,
.window-btn {
  -webkit-app-region: no-drag;
}
```

> 给 `.no-drag` / `.window-actions` / `.window-btn` 三重兜底，保证按钮一定不被 drag 区罩住。

#### 2.2.2 验证

启动 `npm start`，依次点击：
- 最小化 → 窗口最小化到 dock
- 最大化 → 窗口铺满；按钮文本变 `❐`；再点恢复，文本变 `□`
- 关闭 → 窗口关闭，进程退出

---

## 三、PR-B 详细设计

### 3.1 需求 3-1：ReconID 主面板布局对齐

`index.html:214-243` 重排 `reconIdFixModulePanel`：

**改前**：
```html
<div class="control-row">
  <div class="cell left">
    <button id="reconIdFixManageScenariosBtn" ...>场景管理</button>
  </div>
  <div class="cell right">
    <div class="pending-action-pair recon-id-fix-action-row">
      <button id="reconIdFixImportBtn" ...>导入文件</button>
      <label class="recon-id-fix-scenario-label" for="reconIdFixScenarioSelect">场景</label>
      <select id="reconIdFixScenarioSelect" ...>...</select>
      <button id="reconIdFixRunBtn" ...>开始运行</button>
    </div>
  </div>
</div>
```

**改后**：
```html
<div class="control-row">
  <div class="cell left">
    <div class="recon-id-fix-scenario-row">
      <label class="recon-id-fix-scenario-label" for="reconIdFixScenarioSelect">场景</label>
      <select id="reconIdFixScenarioSelect" ...>...</select>
      <button id="reconIdFixManageScenariosBtn" ...>场景管理</button>
    </div>
  </div>
  <div class="cell right">
    <div class="pending-action-pair">
      <button id="reconIdFixImportBtn" ...>导入文件</button>
      <button id="reconIdFixRunBtn" ...>开始运行</button>
    </div>
  </div>
</div>
```

行 2（导出文件 / statusBox）保持不变。

CSS 同步 `src/styles-gemini-extra.css`：
- `.recon-id-fix-scenario-row` flex 横向 + gap
- 移除原 `.recon-id-fix-action-row` 内的 label/select 样式（如果有专属样式，移到新 `.recon-id-fix-scenario-row` 下）

### 3.2 需求 3-2：1v1/1v多/多v1 单行

`src/styles-gemini-extra.css` 加：
```css
.scenario-config-c4-checkboxes {
  display: flex;
  flex-wrap: nowrap;
  gap: 16px;  /* 或现状 gap，单确认不换行 */
  align-items: center;
}
```

如果当前已有 `.scenario-config-c4-checkboxes` rule，叠加 `flex-wrap: nowrap`。

### 3.3 需求 3-3：commonId 下拉宽度

`src/renderer-dialogs.js:6848` 现状用 `.scenario-config-input-narrow`（`flex: 0 0 100px; width: 100px;` 强制 100px → "主边单据 reconId" 截断）。

**实施**：移除 `scenario-config-input-narrow` class，仅保留 `.scenario-config-input`：
```js
<select class="scenario-config-input" data-c4-common-id="source" ...>
```

`.scenario-config-input` 默认无宽度限制（仅有 `padding: 6px 10px` + 字体），select 元素按 `max-content` 自动展开，宽度 ≈ 最长 option 文本宽 + padding 12px + 下拉箭头 ~16px。

**不加 `min-width` 兜底**（用户决定：本模块未来不新增枚举）。

### 3.4 需求 3-4：文案 + OR 分隔

#### 3.4.1 按钮文案

`src/renderer-dialogs.js:6699`：
```js
${isReadonly ? '' : '<button class="text-action small" type="button" data-c4-action="add-recon-group">+ 新增对账分组</button>'}
```
（原 `+ 新增 OR 分组` 改为 `+ 新增对账分组`）

#### 3.4.2 OR 分隔

`src/renderer-dialogs.js:6802`：
```js
const orSeparatorHtml = gIdx > 0 ? '<div class="scenario-config-c4-recon-or-sep" aria-hidden="true"></div>' : '';
```
（去除 `OR` 文字，保留 div）

CSS `src/styles-gemini-extra.css` 调整 `.scenario-config-c4-recon-or-sep`（现状 L2436-2441：`font-weight:600; color:#999; text-align:center; padding:4px 0; font-size:12px`，加上文字本身高度 ≈ 20-24px）：
```css
.scenario-config-c4-recon-or-sep {
  height: 8px;        /* 纯空白间距 */
  /* 移除 font-weight / color / text-align / padding / font-size */
}
```

> 8px 实际效果：约一个汉字高度的 1/2，跟一行 `.scenario-config-row` 的 padding-top（8px）相同；分组之间像两行内容自然衔接的过渡。

### 3.5 需求 3-5：dialog 标题精简（仅 C4）

`src/renderer-dialogs.js:5666-5670` 改：
```js
function getCategoryDialogTitle(category, mode) {
  const modeLabel = mode === 'view' ? '查看场景' : (mode === 'edit' ? '修改场景' : '新增场景');
  if (category === 'recon-id-fix') {
    return modeLabel;  // C4 不加类别后缀
  }
  const label = getCategoryLabel(category);
  return `${modeLabel} — ${label}`;
}
```

### 3.6 需求 3-6：actions 按钮位置 + 顺序（4 dialog 全改）

> 用户决策：C1/C2/C3/C4 全部改成 [确认 取消] 右下，保持 4 dialog 一致。

#### 3.6.1 顺序（全局改）

`src/renderer-dialogs.js:58-66` 改 `getScenarioDialogActions`：
```js
function getScenarioDialogActions(mode) {
  if (mode === 'view') {
    return [{ kind: 'secondary', action: 'back', text: '返回' }];
  }
  return [
    { kind: 'primary', action: 'confirm', text: '确认' },
    { kind: 'secondary', action: 'cancel', text: '取消' }
  ];
}
```

> 仅顺序互换（confirm 在前），4 个 dialog 都受影响（C1/C2/C3/C4）。view 模式不变。

#### 3.6.2 位置（4 dialog 共用 class）

4 个 scenario config dialog 都带 `scenario-config-card` class（renderer-dialogs.js:5860/6011/6340/6659 验证）。

CSS `src/styles-gemini-extra.css` 加：
```css
.scenario-config-card .dialog-actions {
  justify-content: flex-end;
}
```

> 影响范围确认：
> - ✅ C1/C2/C3/C4 dialog（modal-card.scenario-config-card）— 改右对齐
> - ❌ 场景管理列表 dialog（modal-card.scenarios-manager-card）— 不受影响（"新增场景"按钮保持左下）
> - ❌ 其他 dialog（模板管理、确认弹窗等）— 不受影响

---

## 四、IPC / DB / 文件路径不变项

- `desktopApi.scenarios.list/get/create/update/delete/toggleEnabled` 全不动
- `scenarios` 表结构不动
- `CURRENT_MODULE_VALID` 不动
- BrowserWindow 配置不动
- ReconID 引擎/IO/输出格式不动

---

## 五、preview 改动清单

| preview 状态 | 是否新增 | 文件 |
|---|---|---|
| 主页面 5 模块面板 | 重跑（panel 改了） | `npm run preview` |
| ReconID 主面板 | 重跑（panel 重排） | `scripts/render-preview.js` 中现有 `recon-id-fix-panel` 状态 |
| 银行对账单场景管理 | 重跑（标题改了） | 现有 `bank-statement-scenarios-manager` 状态 |
| ReconID 场景管理（新隔离形态） | **新增** preview 状态 `recon-id-fix-scenarios-manager` | `scripts/render-preview.js` |
| C4 dialog（新增模式） | 重跑（标题 + 按钮 + 文案） | 现有 C4 dialog 状态 |
| C4 dialog（主从边都修复子态） | 重跑（commonId 下拉宽度） | 现有状态 |
| 窗口按钮 | 不通过 preview 验证（preview 没鼠标点击）；用 `npm start` 手测 | — |

---

## 六、smoke 改动清单

- `npm run smoke` 整体跑通即可，**无需新增 smoke 用例**（无业务逻辑改动）
- 如有现有 smoke 涉及 dialog factory 调用形式，可能要适配新签名（默认值兜底应该 OK）

---

## 七、Round 2 优化（8 项）

> 用户实测 PR-A/PR-B 通过后追加的 UI 优化。所有改动只涉及 `renderer-dialogs.js` (5 处) + `styles-gemini-extra.css` (4 处)。

### 7.1 R2-1 删除按钮 × 居中（CSS）

`.icon-close-small`（styles-gemini-extra.css:2188）追加：
```css
display: inline-flex;
align-items: center;
justify-content: center;
line-height: 1;
padding: 0;
```

### 7.2 R2-2 SubBizType 文案

`renderer-dialogs.js:6903`：`SubBizType 取值（三选一）` → `SubBizType 取值`

### 7.3 R2-3 场景名称中线对齐

`.scenario-config-label`（styles-gemini-extra.css:2099）移除 `padding-top: 6px`；新增：
```css
.scenario-config-row-multi .scenario-config-label {
  padding-top: 6px;  /* 仅多行 row 保留顶端对齐 */
}
```

### 7.4 R2-4 分组序号同行

`.scenario-config-multi-seq`（styles-gemini-extra.css:2164）：`flex: 0 0 36px` → `flex: 0 0 auto; white-space: nowrap;`

### 7.5 R2-5 commonId 下拉宽度 155px

新增 CSS：
```css
.scenario-config-c4-output select[data-c4-common-id="source"] {
  flex: 0 0 155px;
  width: 155px;
}
```

> **注意 flex 覆盖**：`.scenario-config-input` 默认 `flex: 1; min-width: 0`（styles-gemini-extra.css:2122-2131），会让 select 填满父容器剩余空间——单纯 `width` 不生效，**必须用 `flex: 0 0 155px` 同时覆盖 flex-grow/shrink/basis**。
>
> 数值演进：130px（首版猜测，太窄）→ 155px（用户实测后 +25px，刚好留点呼吸）。

### 7.6 R2-6 场景管理右下"完成"按钮

`createScenariosManagerDialog` 内：
- HTML footer 改 `<div class="dialog-actions scenarios-manager-footer">` 加 `<button data-action="finish">完成</button>`
- click handler：`dialog.querySelector('[data-action="finish"]').addEventListener('click', closeAndReloadReconList)`
- CSS 新增 `.scenarios-manager-footer { justify-content: space-between; }`

### 7.7 R2-7 序号 = 列表内 1-based 顺序

`renderRow(scenario)` → `renderRow(scenario, displayIndex)`：
- `<td class="scenarios-col-id">${displayIndex}</td>`（不再用 scenario.id）
- `tr.dataset.id = String(scenario.id)`（保留真实 id 用于 IPC 调用）

`refreshTable` 内：
```js
visible.forEach((scenario, idx) => {
  tbody.appendChild(renderRow(scenario, idx + 1));
});
```

### 7.8 R2-8 单类别入口隐藏 优先级 + 是否启动 列

入口判断：`isCompactView = Array.isArray(filter) && filter.length === 1`

- thead：`priorityTh` / `enabledTh` 在 compact 模式下为空字符串
- renderRow 同步条件渲染 `priorityTd` / `enabledTd`
- 其他列宽度按比例放大（id 5%→6%, category 22%→28%, name 30.94%→40%, actions 19.06%→26%）

### 7.9 R2-10 字段对"+ 新增字段对"按钮文案精简

`renderer-dialogs.js:6851`：`+ 新增字段对` → `新增`（与"账单类型"行内的"新增"按钮风格一致）

### 7.10 R2-11 "新增"按钮仅每组第一行保留

账单类型 + 对账字段两类多行容器内，"新增"按钮原本每一行都渲染（视觉冗余）；改为仅每组第一行（cIdx === 0 / fpIdx === 0）保留。

- `renderer-dialogs.js:6730`（账单类型 conditionsHtml）：`isReadonly ? '' : <button>` → `isReadonly || cIdx !== 0 ? '' : <button>`
- `renderer-dialogs.js:6851`（对账字段 addBtnHtml）：`isReadonly ? '' : <button>` → `isReadonly || fpIdx !== 0 ? '' : <button>`

> 锁定的 Amount 行通常 fpIdx === 0，仍保留"新增"入口；删除按钮 × 不受影响（独立条件）。

### 7.11 R2-12 账单类型 + 对账字段所有下拉框左右边界垂直对齐（CSS Grid）

#### 设计

把原 flex 布局改为 CSS Grid，让 header 行（bt-header / group-header）与内容行（condition-row / fieldpair）**共享 grid 列定义**，select 自动左右边界对齐。

#### 账单类型 grid

```css
.scenario-config-c4-bt-header,
.scenario-config-c4-condition-row {
  display: grid;
  grid-template-columns: 36px minmax(0, 1fr) 100px minmax(0, 1fr) 22px 60px;
  /* col 1: #N | col 2: side/field | col 3: op | col 4: value | col 5: × | col 6: 新增 */
  gap: 8px;
  align-items: center;
}
```

bt-header 元素通过 class / attribute selector 显式锚定：multi-seq → col 1, side → col 2, × → col 5。
condition-row 元素同理：field → col 2, op → col 3, value → col 4, × → col 5, 新增 → col 6。

`.scenario-config-c4-conditions` 移除 `padding-left: 10px`（grid col 1 已经留 36px 顶替）。

#### 对账字段 grid

```css
.scenario-config-c4-recon-group-header,
.scenario-config-c4-recon-fieldpair {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr) 60px minmax(0, 1fr) 22px 60px;
  /* col 1: "分组N 左："/spacer | col 2: leftTypeSeq/leftField | col 3: "vs 右："/"=" | col 4: rightTypeSeq/rightField | col 5: × | col 6: ""/新增 */
}
```

#### HTML 配套改动

- group-header：把 `<span>分组 N</span><span>左：</span>` 合并为单 span `<span>分组 N 左：</span>`，让其占 col 1
- fieldpair：第一个元素加 `<span aria-hidden="true" class="scenario-config-c4-recon-fieldpair-spacer"></span>` 占 col 1，让 leftField 落到 col 2

#### nowrap 防换行

小列内文字（如 "vs 右：" 占 60px、"新增" 占 60px）容易竖排；给关键 span / button 加 `white-space: nowrap`。

### 7.12 R2-13 Amount 锁定行的左右边界与其他 fieldpair 对齐

原 `.scenario-config-c4-recon-fieldpair-locked` 用 `padding: 4px 6px + border-left: 3px` 表达"锁定行"的视觉区分，但这两个属性都占用布局空间，让锁定行的 grid 内容向右偏移 ~9px，破坏 R2-12 的 grid 列对齐。

**修复**：改用 `box-shadow: inset 3px 0 0` 模拟左侧装饰条 + 保留 background；移除 padding。

```css
.scenario-config-c4-recon-fieldpair-locked {
  background: rgba(60, 64, 67, 0.04);
  box-shadow: inset 3px 0 0 rgba(60, 64, 67, 0.25);
}
```

> `box-shadow inset` 不占布局空间（仅绘制在元素内部），与 padding/border 不同；锁定行的 grid 内容位置与普通 fieldpair 完全一致。

**重要**：本次仅修复**视觉对齐**，**未解锁 Amount 业务规则**——locked 行 select 仍 disabled，option 仍只有 'Amount'，引擎 c4-recon-id-fix.js 依赖未动。用户反馈"Amount 行状态改为可编辑"经调研实为对齐诉求（非业务解锁）。

### 7.13 R3 Round 3 微调（7 项）— **实施完成 v2（2026-05-11）**

> 第 1 轮 R3 (R3-1~R3-4) 用户验收后整批回滚，第 2 轮重新分步实施 R3-1~R3-7。最终代码 = 下表 7 项。

| # | spec 设计 | 实施位置 |
|---|---|---|
| R3-1 | "=" 居中 | `.scenario-config-vs-arrow { text-align: center }` |
| R3-2 | 场景名称 input 1/4 宽 | `.scenario-config-row > input[data-field="name"] { flex: 0 0 180px }` |
| R3-3 | statusBox 两端对齐导入/开始运行 | `.recon-id-fix-board #reconIdFixStatusBox { width: 292px; max-width: 292px }`（= 2*140+12 gap） |
| R3-4 | 导出文件平移至场景管理下侧 + 按钮统一 140px | `cell.left { justify-content: flex-end }` + `#reconIdFixManageScenariosBtn / #reconIdFixExportBtn { min-width: 140px }` |
| R3-5 | 场景下拉 3/4 | min-width 160→120, max-width 220→165 |
| R3-6 | 整体右移 + 距离调整 | transform translateX：[场景管理]/[导出文件] **100px**、[pending-action-pair]/[statusBox] **74px**；grid 保持 1fr:1.4fr 让 [场景下拉] 不动；最终 [场景管理 右]↔[导入文件 左] 距离 = 80px (1.5 × 原距离的 1/2) |
| R3-7 | 状态框初始文本统一 | index.html L242 + renderer.js L3512 都改 "欢迎使用小助手" |

> Round 2 用户测试通过后，进一步优化点。仅 CSS + HTML 文本改动，无业务逻辑改动。

#### R3-1 "=" 居中
`.scenario-config-vs-arrow` 加 `text-align: center;`，让 "=" 在 fieldpair grid col 3（60px）内居中。

#### R3-2 场景名称 input 宽度
新增 rule：
```css
.scenario-config-row > input[data-field="name"] {
  flex: 0 0 180px;
  width: 180px;
  max-width: 180px;
}
```
覆盖 `.scenario-config-input { flex: 1 }`。4 个 dialog 共用（attribute selector）。

#### R3-3 ReconID 主面板布局

```css
.recon-id-fix-board .cell.left { justify-content: flex-end; }
.recon-id-fix-board .cell.right { justify-content: flex-start; }
.recon-id-fix-board .pending-action-pair { justify-content: flex-start; }
.recon-id-fix-board #reconIdFixManageScenariosBtn,
.recon-id-fix-board #reconIdFixExportBtn { min-width: 140px; }
```

效果：
- row 1 cell.left [scenario-row] + row 2 cell.left [export-btn] 右边界对齐 → 导出文件按钮在场景管理按钮正下方
- row 1 cell.right [pending-action-pair] + row 2 cell.right [statusBox] 左边界对齐 → 状态框左边界 = 导入文件按钮左边界
- 场景管理 / 导出文件 / 导入文件 / 开始运行 4 按钮 `min-width: 140px` 统一

#### R3-4 场景下拉宽度

```css
.recon-id-fix-board .recon-id-fix-scenario-select {
  min-width: 120px;  /* 160 * 3/4 */
  max-width: 165px;  /* 220 * 3/4 */
}
```

### 7.14 验证

- ✅ smoke 全绿
- ✅ preview 重跑：scenarios-manager（含完成按钮 + 序号 1/2/3）/ scenario-config-c4 / scenario-config-c4-both（含分组序号同行 + commonId 155px + "新增"按钮文案）
- ✅ Round 2 用户实测全部通过
