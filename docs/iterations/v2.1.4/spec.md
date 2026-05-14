# Spec — v2.1.4 技术规格

> 关联 `PRD-v2.1.4.md` / `tasks.md`（同目录）
> 文档版本：v0.1（2026-05-14 起草），v0.2 修订标注（2026-05-15 round 2 self-review I-new-4）
>
> ⚠️ **v0.2 修订（Fix1）**：本 spec 起草于 v2.1.4 v0.1，记录的部分技术细节已被 Fix1（v0.2）撤回 / 修订：
> - **§3.3 / §3.6 弹窗交互模式**：v0.1 设计"即时落库"（O6） → Fix1.2 撤回，改为「完成/取消」两阶段提交；最终实现见 `src/renderer-dialogs.js:7657` `confirmBtn.addEventListener` + `cancelAndClose`
> - **§3.6 闲置区排序规则**：v0.1 设计 `String.length` 升序（O1） → Fix1.5 修订，改为视觉宽度（CJK×2 + 其他×1）；最终实现见 `src/renderer-dialogs.js:7690` `visualLength` helper
> - **§3.7 CSS 布局**：v0.1 未规划 footer / inline error 行；Fix1.1 + round 1/2 self-review 追加 `.module-cabinet-footer` + `.module-cabinet-error` + `.modal-overlay.is-committing`
> - 完整修订记录见 `PRD-v2.1.4.md §八 Round Fix1` + `CHANGELOG.md` Fix1 段

---

## 一、改动总览

| 模块 | 改动类型 | 文件 |
|---|---|---|
| T1 工具栏 📕 按钮 | UI 微调（CSS 类替换） | `index.html` |
| T2 USER_GUIDE 版本 + 新功能段 | 文档改动 | `docs/USER_GUIDE.md` |
| T3 模块收纳弹窗 | 新增功能 | `index.html` / `src/renderer.js` / `src/renderer-dialogs.js` / `src/preload.js` / `src/main.js` / `src/backend/database/settings-repository.js` / `src/renderer-previews.js` |
| T4 ReconID 账单类别默认 | UI + 初始化逻辑 | `index.html` / `src/renderer.js` |

---

## 二、T1：使用手册按钮换皮

### 2.1 HTML 改动（`index.html:340`）

**Before**：
```html
<button id="saveUserGuideBtn" class="text-action background-guide-btn" type="button">使用手册</button>
```

**After**：
```html
<button
  id="saveUserGuideBtn"
  class="palette-trigger"
  type="button"
  aria-label="使用手册"
  title="使用手册"
>
  <span class="palette-trigger-emoji" aria-hidden="true">📕</span>
</button>
```

### 2.2 CSS

- 复用 `.palette-trigger` + `.palette-trigger-emoji` 已有类，无需新增样式
- 旧类 `text-action background-guide-btn` 若无其他引用可清理；若被其他模块复用则保留 CSS 定义但移除本元素引用
- 检查 `src/styles.css` / `Clear/styles*.css` / `General/styles*.css` 是否有 `background-guide-btn` 专属规则，本元素不再用即可

### 2.3 JS（不变）

`src/renderer.js:4607` 处 click handler 不动，因为 `#saveUserGuideBtn` ID 不变。

---

## 三、T3：模块收纳弹窗

### 3.1 数据模型

#### 3.1.1 持久化（SQLite `app_settings`）

```
setting_key   = 'enabled_modules'
setting_value = JSON string，e.g. '["statement-generator","bank-statement-process","recon-id-fix"]'
```

- 数组元素：MODULES 常量里的 `id` 字段
- 顺序：数组顺序 = 左上角切换按钮展示顺序
- 闲置区：实时计算 `Object.values(MODULES).map(m => m.id).filter(id => !enabledModules.includes(id))`，再按 `MODULES[id].name.length` 升序排（tie-break 用 MODULES 声明顺序）

#### 3.1.2 默认值（首次启动 / DB 无该 key）

```javascript
const DEFAULT_ENABLED_MODULES = Object.freeze([
  'statement-generator',     // 网银账单生成
  'bank-statement-process',  // 银行对账单处理
  'recon-id-fix'             // 对账单ReconID修复
]);
```

闲置区默认（按 name.length 升序）：
- `biz-op-recon` (8)
- `new-account-generator` (10)
- `bank-bu-recon` (12)
- `pending-reconciliation` (15)

#### 3.1.3 Renderer state

```javascript
// src/renderer.js state 块新增字段
state.enabledModules = [];  // 启动时由 IPC 拉取
```

### 3.2 Backend — `src/backend/database/settings-repository.js` + `src/backend/database.js`

#### 3.2.1 关联 bug 修复（顺手）

`CURRENT_MODULE_VALID` 在 v2.1.0-beta.1 写定后只含 5 个模块 ID，**v2.1.2 新增 `bank-bu-recon` + v2.1.3 新增 `biz-op-recon` 时忘了同步**，导致用户切到这两个模块时 `setCurrentModule` 抛 `Invalid current_module`。本次 v2.1.4 必须并入修复（否则收纳弹窗启用这两个模块后切换会直接报错）。

提炼 7 个模块 ID 全集为 `ALL_MODULE_IDS`，`CURRENT_MODULE_VALID` 与 `enabled_modules` 校验共用：

```javascript
const ALL_MODULE_IDS = Object.freeze([
  'statement-generator',
  'new-account-generator',
  'pending-reconciliation',
  'bank-statement-process',
  'recon-id-fix',          // v2.1.0-beta.1 PR-A
  'bank-bu-recon',         // v2.1.2 新增（v2.1.4 补入校验）
  'biz-op-recon'           // v2.1.3 新增（v2.1.4 补入校验）
]);
const CURRENT_MODULE_VALID = ALL_MODULE_IDS;  // 修复 v2.1.2/v2.1.3 漏更新
```

#### 3.2.2 新增 `enabled_modules` 持久化

```javascript
const ENABLED_MODULES_KEY = 'enabled_modules';
const DEFAULT_ENABLED_MODULES = Object.freeze([
  'statement-generator',
  'bank-statement-process',
  'recon-id-fix'
]);

function getEnabledModules(db) {
  const raw = getSetting(db, ENABLED_MODULES_KEY);
  if (!raw) {
    // 首次启动 seed 默认值（幂等）
    setSetting(db, ENABLED_MODULES_KEY, JSON.stringify(DEFAULT_ENABLED_MODULES));
    return [...DEFAULT_ENABLED_MODULES];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
  } catch (_error) {
    setSetting(db, ENABLED_MODULES_KEY, JSON.stringify(DEFAULT_ENABLED_MODULES));
    return [...DEFAULT_ENABLED_MODULES];
  }
  const seen = new Set();
  const sanitized = parsed.filter((id) => {
    if (typeof id !== 'string' || !ALL_MODULE_IDS.includes(id)) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (sanitized.length === 0) {
    setSetting(db, ENABLED_MODULES_KEY, JSON.stringify(DEFAULT_ENABLED_MODULES));
    return [...DEFAULT_ENABLED_MODULES];
  }
  return sanitized;
}

function setEnabledModules(db, moduleList) {
  if (!Array.isArray(moduleList)) throw new Error('enabled_modules must be an array');
  const seen = new Set();
  const sanitized = [];
  moduleList.forEach((id) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`Invalid enabled_modules entry: ${JSON.stringify(id)}, must be non-empty string`);
    }
    if (!ALL_MODULE_IDS.includes(id)) {
      throw new Error(`Invalid module id: ${id}, must be one of ${ALL_MODULE_IDS.join(' | ')}`);
    }
    if (seen.has(id)) return;
    seen.add(id);
    sanitized.push(id);
  });
  if (sanitized.length === 0) {
    throw new Error('enabled_modules must not be empty');  // PRD B1
  }
  setSetting(db, ENABLED_MODULES_KEY, JSON.stringify(sanitized));
}

module.exports = {
  // ... 既有 export ...
  ALL_MODULE_IDS,
  DEFAULT_ENABLED_MODULES,
  getEnabledModules,
  setEnabledModules
};
```

#### 3.2.3 AppDatabase facade（`src/backend/database.js`）

```javascript
getEnabledModules() {
  return settingsRepository.getEnabledModules(this.db);
}
setEnabledModules(moduleList) {
  return settingsRepository.setEnabledModules(this.db, moduleList);
}
```

### 3.3 Main process — `src/main.js`

新增 2 个 IPC handler，放在 `settings:set-recon-id-fix-bill-category` handler 之后（接 `database.getEnabledModules / setEnabledModules` facade）。**IPC 命名沿用项目 kebab-case 惯例**：`settings:get-enabled-modules` / `settings:set-enabled-modules`。返回 schema 与 `set-current-module` 一致：`{ status: 'ok' | 'failed', enabledModules, message? }`。

```javascript
ipcMain.handle('settings:get-enabled-modules', () => {
  try {
    return { status: 'ok', enabledModules: database.getEnabledModules() };
  } catch (error) {
    return { status: 'failed', message: String(error && error.message ? error.message : error) };
  }
});
ipcMain.handle('settings:set-enabled-modules', (_event, moduleList) => {
  try {
    database.setEnabledModules(moduleList);
    // round 1 self-review M5：return DB 真值（getEnabledModules）而非入参 moduleList，
    // setEnabledModules 内部 sanitize 会去重，避免 renderer 缓存与 DB 偏离
    return { status: 'ok', enabledModules: database.getEnabledModules() };
  } catch (error) {
    return { status: 'failed', message: String(error && error.message ? error.message : error) };
  }
});
```

### 3.4 Preload — `src/preload.js`

`settings` 块新增 2 个 API：

```javascript
// v2.1.4 T3：左上角模块切换按钮的启用列表
getEnabledModules: () => ipcRenderer.invoke('settings:get-enabled-modules'),
setEnabledModules: (moduleList) => ipcRenderer.invoke('settings:set-enabled-modules', moduleList)
```

调用方式：`window.desktopApi.settings.getEnabledModules()`（注意 `settings` 子对象）。返回 `{ status: 'ok', enabledModules: [...] } | { status: 'failed', message: '...' }`。

### 3.5 HTML — 🔄 按钮（弹窗 DOM 由 JS 动态创建）

#### 3.5.1 🔄 按钮（写在 `index.html`，紧跟 `#saveUserGuideBtn`）

```html
<button
  id="moduleCabinetBtn"
  class="palette-trigger"
  type="button"
  aria-label="小助手功能收纳"
  title="小助手功能收纳"
>
  <span class="palette-trigger-emoji" aria-hidden="true">🔄</span>
</button>
```

#### 3.5.2 弹窗 DOM 创建方式：动态构造，挂到 `#modalRoot`

⚠️ **项目惯例**（参照 `src/renderer-dialogs.js` 现有工厂、`Clear/confirm.html` 等模板）：
- 所有弹窗都用 JS 动态创建，append 到 body 末尾的 `<div id="modalRoot">`
- CSS 类沿用 `.modal-overlay` + `.modal-card` + `.dialog-header` + `.dialog-title`
- 不在 `index.html` 写死弹窗静态 DOM

弹窗结构（由 `openModuleCabinetDialog` 工厂构造，对应 DOM 树如下）：

```
<div class="modal-overlay">                            ← 半透明蒙层 + 居中
  <div class="modal-card module-cabinet-card">         ← 弹窗主体
    <div class="dialog-header">
      <div class="dialog-title">小助手功能收纳</div>
      <button class="icon-close" aria-label="关闭">×</button>
    </div>
    <div class="module-cabinet-body">                  ← grid: 1fr 80px 1fr
      <section class="module-cabinet-section">
        <h3 class="module-cabinet-section-title">闲置功能</h3>
        <ul class="module-cabinet-list" data-region="idle" role="listbox"></ul>
      </section>
      <div class="module-cabinet-controls">
        <button class="module-cabinet-control" data-action="enable" aria-label="移到启用功能">➡️</button>
        <button class="module-cabinet-control" data-action="disable" aria-label="移到闲置功能">⬅️</button>
      </div>
      <section class="module-cabinet-section">
        <h3 class="module-cabinet-section-title">启用功能</h3>
        <ul class="module-cabinet-list" data-region="enabled" role="listbox"></ul>
      </section>
    </div>
  </div>
</div>
```

每个 list 项也由 JS 动态创建（见 §3.6）。

### 3.6 Renderer — 弹窗逻辑（写在 `src/renderer-dialogs.js`，工厂模式）

#### 3.6.1 入口 + 静态 DOM 缓存

唯一在 `index.html` 静态存在的是 `#moduleCabinetBtn`（触发按钮）。其它弹窗 DOM 在工厂内部 `createElement` 创建。

```javascript
// src/renderer.js elements 块新增（仅触发按钮）
moduleCabinetBtn: document.getElementById('moduleCabinetBtn'),

// 事件绑定（启动时）
// round 1 self-review M5：API 路径修正为 window.desktopApi.settings.setEnabledModules（preload 把 IPC 暴露在 settings 子对象下）
// 返回 schema { status: 'ok' | 'failed', enabledModules, message? }，非 { success: bool }
elements.moduleCabinetBtn.addEventListener('click', () => {
  openModal(createModuleCabinetDialog({
    enabledModules: state.enabledModules,
    allModules: Object.values(MODULES),
    onCommit: async (nextEnabledIds) => {
      const result = await window.desktopApi.settings.setEnabledModules(nextEnabledIds);
      if (!result || result.status !== 'ok') {
        console.warn('persist enabledModules failed:', result && result.message);
        return false;
      }
      // round 1 self-review M5：用 IPC 返回的 DB 真值刷 state（sanitize 后可能去重）
      state.enabledModules = Array.isArray(result.enabledModules) && result.enabledModules.length > 0
        ? [...result.enabledModules]
        : [...nextEnabledIds];
      // O4 拍板：若 currentModule 被移出启用列表 → 自动切到启用区第 1 个
      if (!state.enabledModules.includes(state.currentModule)) {
        setCurrentModule(state.enabledModules[0], { persist: true });
      }
      renderTopModuleSwitcher();
      return true;
    }
  }));
});
```

#### 3.6.2 弹窗 state（工厂内部闭包）

```javascript
const moduleCabinetState = {
  selectedRegion: null,   // 'idle' | 'enabled' | null
  selectedModuleId: null,
  dragSourceId: null      // HTML5 drag 中临时记录
};
```

#### 3.6.3 关键函数（工厂内部）

```javascript
// 工厂入口（在 src/renderer-dialogs.js 暴露给 renderer）
function openModuleCabinetDialog({ getEnabledModules, getAllModules, onEnabledModulesChange }) {
  let enabledIds = [...getEnabledModules()];      // 工作副本（提交时调 onEnabledModulesChange）
  const allModules = getAllModules();              // [{id, name}, ...]
  const cabinetState = {
    selectedRegion: null,
    selectedModuleId: null,
    dragSourceId: null
  };

  // 构造 DOM
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const card = document.createElement('div');
  card.className = 'modal-card module-cabinet-card';
  // ...（header / body / 两个 list / 中间 controls）...
  overlay.appendChild(card);
  document.getElementById('modalRoot').appendChild(overlay);

  function close() {
    overlay.remove();
  }
  // overlay 点击外部关闭
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  // close btn
  closeBtn.addEventListener('click', close);

  renderLists();  // 首次渲染
  return { close };  // 给外部留个手柄
}

// 渲染两个列表（每次列表变更后调用）
function renderModuleCabinetLists() {
  const enabledIds = state.enabledModules || [];
  const allIds = Object.values(MODULES).map((m) => m.id);
  const enabledSet = new Set(enabledIds);
  // 闲置区：按 name.length 升序，tie-break 用 MODULES 声明顺序
  const idleIds = allIds
    .filter((id) => !enabledSet.has(id))
    .sort((a, b) => {
      const la = getModuleName(a).length;
      const lb = getModuleName(b).length;
      if (la !== lb) return la - lb;
      return allIds.indexOf(a) - allIds.indexOf(b);
    });
  renderModuleCabinetList(elements.moduleCabinetIdleList, idleIds, 'idle');
  renderModuleCabinetList(elements.moduleCabinetEnabledList, enabledIds, 'enabled');
  updateModuleCabinetControls();
}

// 渲染单个区域
function renderModuleCabinetList(ulEl, ids, region) {
  ulEl.innerHTML = '';
  ids.forEach((id) => {
    const li = document.createElement('li');
    li.className = 'module-cabinet-item';
    li.dataset.moduleId = id;
    li.dataset.region = region;
    li.setAttribute('role', 'option');
    li.tabIndex = 0;

    const label = document.createElement('span');
    label.className = 'module-cabinet-item-label';
    label.textContent = getModuleName(id);
    li.appendChild(label);

    if (region === 'enabled') {
      // 右区域 — 拖拽手柄
      const handle = document.createElement('span');
      handle.className = 'module-cabinet-drag-handle';
      handle.textContent = '⋮⋮';
      handle.setAttribute('aria-label', '拖拽排序');
      handle.draggable = false;  // 拖拽由 li 整体承担
      li.draggable = true;
      li.appendChild(handle);

      li.addEventListener('dragstart', handleModuleCabinetDragStart);
      li.addEventListener('dragover', handleModuleCabinetDragOver);
      li.addEventListener('drop', handleModuleCabinetDrop);
      li.addEventListener('dragend', handleModuleCabinetDragEnd);
    }

    li.addEventListener('click', () => selectModuleCabinetItem(region, id));
    ulEl.appendChild(li);
  });
  // 渲染后同步高亮选中
  if (moduleCabinetState.selectedRegion === region) {
    highlightSelectedModuleCabinetItem(ulEl, moduleCabinetState.selectedModuleId);
  }
}

function getModuleName(id) {
  const entry = Object.values(MODULES).find((m) => m.id === id);
  return entry ? entry.name : id;
}

function selectModuleCabinetItem(region, id) {
  moduleCabinetState.selectedRegion = region;
  moduleCabinetState.selectedModuleId = id;
  // 清空另一区域的高亮
  highlightSelectedModuleCabinetItem(
    region === 'idle' ? elements.moduleCabinetIdleList : elements.moduleCabinetEnabledList,
    id
  );
  highlightSelectedModuleCabinetItem(
    region === 'idle' ? elements.moduleCabinetEnabledList : elements.moduleCabinetIdleList,
    null
  );
  updateModuleCabinetControls();
}

function highlightSelectedModuleCabinetItem(ulEl, selectedId) {
  ulEl.querySelectorAll('.module-cabinet-item').forEach((li) => {
    if (li.dataset.moduleId === selectedId) {
      li.classList.add('is-selected');
    } else {
      li.classList.remove('is-selected');
    }
  });
}

function updateModuleCabinetControls() {
  const enabledCount = (state.enabledModules || []).length;
  // ➡️ 仅在左侧有选中时可用
  elements.moduleCabinetMoveToEnabledBtn.disabled =
    moduleCabinetState.selectedRegion !== 'idle';
  // ⬅️ 仅在右侧有选中 + 启用区 ≥ 2 时可用（PRD B1）
  elements.moduleCabinetMoveToIdleBtn.disabled =
    moduleCabinetState.selectedRegion !== 'enabled' || enabledCount <= 1;
}

// ➡️ click
async function handleMoveToEnabled() {
  if (moduleCabinetState.selectedRegion !== 'idle') return;
  const id = moduleCabinetState.selectedModuleId;
  if (!id) return;
  const next = [...(state.enabledModules || []), id];
  await persistEnabledModules(next);
  moduleCabinetState.selectedModuleId = null;
  moduleCabinetState.selectedRegion = null;
  renderModuleCabinetLists();
  renderTopModuleSwitcher();  // 立即刷新左上角
}

// ⬅️ click
async function handleMoveToIdle() {
  if (moduleCabinetState.selectedRegion !== 'enabled') return;
  const id = moduleCabinetState.selectedModuleId;
  if (!id) return;
  const enabled = state.enabledModules || [];
  if (enabled.length <= 1) return;  // 防御：保留 1 个
  const next = enabled.filter((eid) => eid !== id);
  await persistEnabledModules(next);
  // PRD B2：若 current_module 不在 next 里，自动切到 next[0]
  if (state.currentModule === id) {
    await switchModule(next[0]);  // 复用既有 switchModule
  }
  moduleCabinetState.selectedModuleId = null;
  moduleCabinetState.selectedRegion = null;
  renderModuleCabinetLists();
  renderTopModuleSwitcher();
}

// 持久化 helper（v0.1 设计；v0.2 round 1 M5 后实际逻辑已合并入 §3.6.1 onCommit 回调）
// API 修正：window.desktopApi.setEnabledModules → window.desktopApi.settings.setEnabledModules
// 返回 schema 修正：result.success → result.status === 'ok'
async function persistEnabledModules(next) {
  const result = await window.desktopApi.settings.setEnabledModules(next);
  if (!result || result.status !== 'ok') {
    console.error('[persistEnabledModules] failed:', result && result.message);
    return;
  }
  // round 1 M5：用 DB 真值刷 state
  state.enabledModules = Array.isArray(result.enabledModules) && result.enabledModules.length > 0
    ? [...result.enabledModules]
    : [...next];
}

// HTML5 drag/drop（仅右区域行内排序）
function handleModuleCabinetDragStart(ev) {
  const li = ev.currentTarget;
  moduleCabinetState.dragSourceId = li.dataset.moduleId;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', li.dataset.moduleId);
  li.classList.add('is-dragging');
}

function handleModuleCabinetDragOver(ev) {
  ev.preventDefault();  // 允许 drop
  ev.dataTransfer.dropEffect = 'move';
  const target = ev.currentTarget;
  // 视觉：在 hover 的行边缘加 indicator（可选）
  target.classList.add('is-drag-over');
}

async function handleModuleCabinetDrop(ev) {
  ev.preventDefault();
  const targetLi = ev.currentTarget;
  targetLi.classList.remove('is-drag-over');
  const draggedId = moduleCabinetState.dragSourceId;
  const targetId = targetLi.dataset.moduleId;
  if (!draggedId || !targetId || draggedId === targetId) return;
  const enabled = [...(state.enabledModules || [])];
  const fromIdx = enabled.indexOf(draggedId);
  const toIdx = enabled.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) return;
  enabled.splice(fromIdx, 1);
  // 插入到 target 位置（如果是从上往下拖，插入到 target 之后；从下往上拖，插入到 target 之前）
  const insertIdx = fromIdx < toIdx ? toIdx : toIdx;
  enabled.splice(insertIdx, 0, draggedId);
  await persistEnabledModules(enabled);
  renderModuleCabinetLists();
  renderTopModuleSwitcher();
}

function handleModuleCabinetDragEnd(ev) {
  ev.currentTarget.classList.remove('is-dragging');
  elements.moduleCabinetEnabledList.querySelectorAll('.is-drag-over').forEach((li) => {
    li.classList.remove('is-drag-over');
  });
  moduleCabinetState.dragSourceId = null;
}
```

#### 3.6.4 工厂内部主要 helper（renderLists / handleMove / handleDrop）

```javascript
function renderLists() {
  const enabledSet = new Set(enabledIds);
  // 闲置区：按 name.length 升序，tie-break 用 allModules 顺序
  const idleIds = allModules
    .filter((m) => !enabledSet.has(m.id))
    .sort((a, b) => {
      if (a.name.length !== b.name.length) return a.name.length - b.name.length;
      return allModules.indexOf(a) - allModules.indexOf(b);
    })
    .map((m) => m.id);
  renderRegionList(idleListEl, idleIds, 'idle');
  renderRegionList(enabledListEl, enabledIds, 'enabled');
  updateControlsDisabled();
}

function updateControlsDisabled() {
  moveEnableBtn.disabled = cabinetState.selectedRegion !== 'idle';
  moveDisableBtn.disabled = cabinetState.selectedRegion !== 'enabled' || enabledIds.length <= 1;
}

async function commit(next) {
  const ok = await onEnabledModulesChange(next);
  if (!ok) return false;
  enabledIds = [...next];
  cabinetState.selectedRegion = null;
  cabinetState.selectedModuleId = null;
  renderLists();
  return true;
}

async function handleMoveToEnabled() {
  if (cabinetState.selectedRegion !== 'idle' || !cabinetState.selectedModuleId) return;
  await commit([...enabledIds, cabinetState.selectedModuleId]);
}

async function handleMoveToIdle() {
  if (cabinetState.selectedRegion !== 'enabled' || !cabinetState.selectedModuleId) return;
  if (enabledIds.length <= 1) return;
  await commit(enabledIds.filter((id) => id !== cabinetState.selectedModuleId));
}

async function handleDrop(draggedId, targetId) {
  if (!draggedId || !targetId || draggedId === targetId) return;
  const next = [...enabledIds];
  const fromIdx = next.indexOf(draggedId);
  const toIdx = next.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) return;
  next.splice(fromIdx, 1);
  next.splice(toIdx, 0, draggedId);  // 插入到 target 位置
  await commit(next);
}
```

#### 3.6.5 左上角切换按钮渲染逻辑改造

定位 `renderTopModuleSwitcher`（或等价函数，需要 grep `MODULES` 在 renderer.js 渲染处）。改为：

```javascript
function renderTopModuleSwitcher() {
  // 只渲染 state.enabledModules 中的 ID，按其顺序
  const enabledIds = state.enabledModules || [];
  // ... 渲染 DOM（沿用既有结构，只过滤+排序）...
}
```

#### 3.6.6 启动初始化（`initializeApp` 等）

```javascript
// 启动时拉取启用列表（在 currentModule 加载前）
const enabledResult = await window.desktopApi.getEnabledModules();
if (enabledResult && enabledResult.success) {
  state.enabledModules = enabledResult.data;
} else {
  // 兜底：用 DEFAULT_ENABLED_MODULES（renderer 端硬编码同样列表）
  state.enabledModules = ['statement-generator', 'bank-statement-process', 'recon-id-fix'];
}

// PRD B3：如果 currentModule 不在启用列表里，fallback 到第一个
if (!state.enabledModules.includes(state.currentModule)) {
  state.currentModule = state.enabledModules[0];
  // 写回持久化
  await window.desktopApi.setCurrentModule(state.currentModule);
}
```

### 3.7 CSS（新增样式块，附在 `src/styles.css` 或对应风格文件）

```css
/* v2.1.4 T3：小助手功能收纳弹窗 */
.module-cabinet-panel {
  width: 720px;
  height: 480px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}
.module-cabinet-body {
  display: grid;
  grid-template-columns: 1fr 80px 1fr;
  gap: 12px;
  flex: 1;
  overflow: hidden;
  padding: 16px;
}
.module-cabinet-section {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color, #d0d7de);
  border-radius: 8px;
  background: var(--surface-bg, #fff);
  overflow: hidden;
}
.module-cabinet-section-title {
  font-size: 14px;
  font-weight: 600;
  padding: 8px 12px;
  margin: 0;
  background: var(--surface-header-bg, #f6f8fa);
  border-bottom: 1px solid var(--border-color, #d0d7de);
}
.module-cabinet-list {
  list-style: none;
  margin: 0;
  padding: 4px;
  flex: 1;
  overflow-y: auto;
}
.module-cabinet-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
}
.module-cabinet-item:hover {
  background: var(--hover-bg, rgba(0, 0, 0, 0.04));
}
.module-cabinet-item.is-selected {
  background: var(--selected-bg, rgba(33, 136, 255, 0.15));
}
.module-cabinet-item.is-dragging {
  opacity: 0.5;
}
.module-cabinet-item.is-drag-over {
  border-top: 2px solid var(--accent-color, #2188ff);
}
.module-cabinet-drag-handle {
  cursor: grab;
  color: var(--muted-color, #6e7681);
  letter-spacing: -2px;
}
.module-cabinet-controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.module-cabinet-control {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 1px solid var(--border-color, #d0d7de);
  background: var(--surface-bg, #fff);
  font-size: 20px;
  cursor: pointer;
}
.module-cabinet-control:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.module-cabinet-control:not(:disabled):hover {
  background: var(--hover-bg, #f0f3f6);
}
```

> 注：`Clear/` 和 `General/` 两个风格各自要有等价样式（沿用项目惯例）。

### 3.8 Preview

`src/renderer-previews.js` 新增 preview 入口 `previewModuleCabinet`（生成 PNG 截图给 README）。`package.json` scripts 加 `"preview:module-cabinet": "node scripts/render-preview.js module-cabinet"`（如果 render-preview.js 支持参数化）。

---

## 四、T4：对账单ReconID修复账单类别默认值

### 4.1 HTML（`index.html:286`）

**Before**：
```html
<select id="reconIdFixBillCategorySelect" ...>
  <option value="">请选择账单类别</option>
  <option value="business">单据对账单</option>
  <option value="gateway">网关对账单</option>
</select>
```

**After**：
```html
<select id="reconIdFixBillCategorySelect" ...>
  <option value="business">单据对账单</option>
  <option value="gateway" selected>网关对账单</option>
</select>
```

### 4.2 初始化逻辑（`src/renderer.js:4417` 附近）

定位当前段：

```javascript
// v2.1.0-beta.3 T4：从持久化恢复对账单ReconID修复模块「账单类别」
const persistedCategory = await window.desktopApi.getReconIdFixBillCategory();
state.reconIdFixBillCategory = persistedCategory || '';
elements.reconIdFixBillCategorySelect.value = state.reconIdFixBillCategory;
```

改为：

```javascript
// v2.1.4 T4：账单类别默认 'gateway'；DB 空值时也写回 gateway 保持一致
const persistedCategory = await window.desktopApi.getReconIdFixBillCategory();
if (!persistedCategory) {
  state.reconIdFixBillCategory = 'gateway';
  await window.desktopApi.setReconIdFixBillCategory('gateway');  // 写回 DB
} else {
  state.reconIdFixBillCategory = persistedCategory;
}
elements.reconIdFixBillCategorySelect.value = state.reconIdFixBillCategory;
// 初始化 UI（按持久化值触发等价于"用户首次选了 gateway"的副作用）
await refreshReconIdFixForCategory(state.reconIdFixBillCategory);  // 复用既有刷新函数
```

> `refreshReconIdFixForCategory` 是占位名，实际函数名要找到现 `handleReconIdFixBillCategoryChange` 中拉 scenario / enable 按钮的核心动作并提炼。

### 4.3 v2.1.0-beta.3 T11 "账单类别为空时按钮 disabled" 分支

定位 `src/renderer.js:3637-3642` 段：

```javascript
// v2.1.0-beta.3 T11 修订：账单类别为空时也保持所有按钮显示（按 beta.2 结构），仅 disabled
```

**保持不动**。新的初始化逻辑保证 `state.reconIdFixBillCategory` 启动后必为 'business' 或 'gateway'，永不为空，所以这段分支事实上不会再走（保留作为防御代码）。

### 4.4 风险点：handleReconIdFixBillCategoryChange

当前 handler（`src/renderer.js:3654`）支持切换到空值（点击占位项）。本次删除占位项后，用户在 UI 上无法切到空，但 handler 内部"空值清空 session"分支可保留作为防御。**不改 handler**。

---

## 五、关联功能 review 预判（Important Variables）

| 变量 | 层级 | 命中点 |
|---|---|---|
| `MODULES` (renderer.js:38) | Important-skeleton | T3 新增 `enabled_modules` 持久化引用其 id |
| `state.currentModule` | Runtime-state | T3 启动时若不在启用列表需 fallback |
| `state.reconIdFixBillCategory` | Runtime-state | T4 初始化逻辑改造 |
| `app_settings.current_module` key | Persistence | T3 启动 fallback 时写回 |
| `app_settings.recon_id_fix_bill_category` key | Persistence | T4 启动写回 gateway |
| 新增 `app_settings.enabled_modules` key | Persistence（新增） | T3 整个生命周期 |

进入 PR 阶段前必须跑 `/check-vars`（按 CLAUDE.md 硬节点 #1）。

---

## 六、Smoke 测试拓展（拟定）

`scripts/smoke-test.js` 增加 Case：

| Case | 输入 | 期望 |
|---|---|---|
| ENABLED-MODULES-1 | 新 DB 启动 | `app_settings.enabled_modules` 被 seed 为 3 个默认值 |
| ENABLED-MODULES-2 | 写入 `enabled_modules = ["recon-id-fix"]`，启动 | renderer 拉到 `['recon-id-fix']`，currentModule fallback 到 'recon-id-fix' |
| ENABLED-MODULES-3 | 写入非法 JSON `"not-json"`，启动 | 回退默认值且不抛错 |
| ENABLED-MODULES-4 | `setEnabledModules([])` | 抛 `enabled_modules must not be empty` |
| ENABLED-MODULES-5 | `setEnabledModules(['statement-generator','statement-generator','recon-id-fix'])` | 去重后落库为 `['statement-generator','recon-id-fix']` |
| RECON-ID-FIX-DEFAULT-1 | 旧 DB `recon_id_fix_bill_category=''` 启动 | DB 被写回 'gateway'，UI 默认 gateway |
| RECON-ID-FIX-DEFAULT-2 | 旧 DB `recon_id_fix_bill_category='business'` 启动 | 保持 'business'（不强制覆盖） |

---

## 七、回滚策略

- T1：直接 revert HTML 一行
- T3：
  - DB 已 seed 的 `enabled_modules` key 可保留（不影响旧版本，旧版本不读它）
  - HTML/JS 改动 revert 即可
- T4：
  - HTML revert
  - 初始化逻辑 revert（DB 内已被写回 'gateway' 的旧空值不会自动回退到空 — 这是单向迁移，回滚后旧用户进 UI 看到默认 'gateway'，行为与新版一致；如严格要求回退则需手写迁移把 'gateway' 改回 ''）

---

## 八、文档版本号

- `package.json`：2.1.3 → 2.1.4（已 bump；patch 级别直接正式版，与 v2.1.1/v2.1.2/v2.1.3 惯例一致）
- `CHANGELOG.md`：发版前补 v2.1.4 段
- `docs/VERSION_FEATURE_HISTORY.md`：发版前补 v2.1.4 条目
- `docs/USER_GUIDE.md`：顶部 `版本：v2.1.1` → `版本：v2.1.4`；§1.5 末追加一句 v2.1.4 默认 gateway；§1.7 后新增 §1.8 主界面工具栏与模块收纳
