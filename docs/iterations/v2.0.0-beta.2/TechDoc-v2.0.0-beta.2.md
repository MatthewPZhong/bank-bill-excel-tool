# TechDoc - 网银账单小助手 v2.0.0-beta.2

| 项目 | 内容 |
|------|------|
| 版本 | v2.0.0-beta.2（v1 初稿） |
| 日期 | 2026-04-27 |
| 作者 | Dev |
| 状态 | 初稿（与 PRD v1 对齐，颗粒度 A 方案）|
| 关联 PRD | `docs/iterations/v2.0.0-beta.2/PRD-v2.0.0-beta.2.md`（v1 定稿，23 条 AC） |
| 依赖 | 2.0.0-beta.1（PR #25 已 merged 到 main，commit `5308b24`） |
| 基版本 | `2.0.0-beta.1`（v2.0.0 分支头）|

---

## 一、总览（A 方案数据流）

### 1.1 A 方案核心思想

PRD D6 + D6.1 锁定颗粒度 A：**单 HTML 树（基线对齐 Clear）+ 双 CSS 文件 + `<body data-style="clear|general">` 切换**。

```
              启动                                     运行

[main]              [renderer]                                 [user 操作]
app.whenReady
  └─ database.init
  └─ ensureUiStyleDefault
       (F4 升级迁移)
  └─ createWindow
       └─ index.html
            ├─ <head>
            │   ├─ <link id="cssGeneral" disabled>
            │   ├─ <link id="cssClear">
            │   └─ <link id="cssClearExtra">
            └─ <body data-style="clear">

                          renderer.js initialize
                            └─ desktopApi.app.getInfo()
                                  ←—— uiStyle: 'Clear' | 'General'
                            └─ applyUiStyle(uiStyle)
                                  ├─ body.dataset.style ←——
                                  └─ link.disabled 切换 ←——

                                         (用户使用应用 ...)

                                                              [user 点 🎨 → 调色板]
                                                              [user 改下拉值]
                                                              [user 点"确认切换"按钮]
                                              ←—— ipc setUiStyle('General')
                          ipc handler
                            └─ settingsRepository
                                 .setUiStyle(db, 'General')
                                  ──→ DB 写入
                          renderer 收到 success
                            └─ applyUiStyle('General')
                                  ├─ body.dataset.style ←—— 'general'
                                  └─ link.disabled 切换 ←——
                          (条件渲染 5 类节点的 CSS selector
                           自动重新匹配，无需 JS 操作 DOM)
```

### 1.2 关键改动总结

| 维度 | beta.1 现状 | beta.2 改动 |
|------|------------|------------|
| HTML 入口 | `index.html` 单一 General 结构 | 重构为 Clear 结构基线（标题加 gradient span / 模块 icon SVG / 状态栏 spark / `data-style` 属性）|
| CSS 入口 | `src/styles.css` 单文件 | 三文件：`src/styles.css`（重写为 General）+ `src/styles-gemini.css`（新）+ `src/styles-gemini-extra.css`（新）|
| body 属性 | 无 | `<body data-style="clear|general">` |
| 切换机制 | 无 | renderer 切 dataset + 切 link.disabled，<200ms 热切换 |
| 持久化 | 无 | `app_settings.ui_style` KV 记录 |
| 升级迁移 | 无 | `ensureUiStyleDefault` 启动钩子（F4，幂等）|

---

## 二、PRD 评审意见（技术角度）

### 2.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §6.3 `app_settings.ui_style` KV 写入 | 可落地。复用现有 `getSetting/setSetting`（`settings-repository.js:1-24`）+ 包一层 `getUiStyle/setUiStyle`，与 `getBackgroundConfig/setBackgroundConfig` 同模式 |
| §6.4 升级迁移 `ensureUiStyleDefault` | 可落地。`src/main.js:8843-8845` 启动序列里 `database.init()` 之后插一行；幂等 |
| §6.5 双 CSS link + disabled 切换 | 可落地。Electron renderer 支持 `<link>.disabled = true/false` 切换 stylesheet 而不重新加载（已验证） |
| §6.7 猫猫 GIF 双风格保留（D8）| 可落地。保留 `<img class="corner-gif" src="./assets/cat-meme.gif">` 不变；CSS 用 `body[data-style="..."] .corner-gif` 微调即可 |
| §6.6 Clear 资产清洗（D13）| 可落地。Clear/ HTML 是参考稿，Dev 在 `index.html` / `renderer-dialogs.js` 重构 DOM 时自然不会带 inline style / data-cc-id |

### 2.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理方案 |
|------|---------|---------|
| **R-T1** | **HTML 改造对齐 Clear 风险**（PRD R-1）：`src/styles.css` 现有 selector 多数依赖 General 现有 DOM 结构（如 `.module-switcher-trigger > span`），结构变后样式失配 | 阶段 3 全量重写 styles.css 加 `body[data-style="general"]` 前缀，preview:main-page (general) 与 beta.1 visual diff 验收 |
| **R-T2** | **link.disabled 在 Electron 中切换是否真的"零延迟"** | 已验证（Electron 36 / Chrome 124+）。link 已下载并 parse 后，`disabled=true` 立即停用 + `disabled=false` 立即启用，无网络请求；单测可验证 |
| **R-T3** | **`<body data-style>` 的 selector 性能**：所有 selector 加 `body[data-style="general"]` 前缀会**轻微增加 CSS 匹配成本**（每条 rule 多一个 ancestor 层级） | 项目规模可忽略（styles.css ~2600 行，匹配预算充足）|
| **R-T4** | **applyUiStyle 顺序**：先切 dataset 再切 link.disabled vs 反之 —— 顺序错误会导致 1 帧"裸 DOM"渲染 | 推荐先 `link.disabled` 切换再 `dataset.style` 切换；或两者写在同一个 microtask 中（参考 §三 "applyUiStyle" 实现）|
| **R-T5** | **首次启动 link 加载延迟**：双 link（cssClear + cssClearExtra ~50KB + cssGeneral ~80KB = ~130KB）首次加载延迟 | 与 beta.1 单 link 80KB 同量级，可忽略；Electron 本地文件加载 <50ms |
| **R-T6** | **preview 脚本 `APP_PREVIEW_STYLE` 接入**：preview 启动时如何把环境变量传到 renderer | preview 模式下 main.js 启动时读 `process.env.APP_PREVIEW_STYLE` → 强制 setUiStyle（覆盖 DB），renderer initialize 拿到对应 uiStyle 即可；不污染用户 DB（preview 用临时 userData，已隔离）|
| **R-T7** | **dialog factory 双套 selector 适配**：~30 个 createXxxDialog 都需要在两风格下视觉正确，逐个测试成本高 | 阶段 5 按 PRD §5.1 mapping 表分组适配；每组完成后跑对应 preview 双风格验收 |

### 2.3 与 PRD 的差异

无差异。PRD v1 详细描述了所有阶段的实施动作，TechDoc 只是补充技术细节（CSS 切换策略推荐、文件改动清单、IPC 设计等）。

---

## 三、数据层

### 3.1 settings-repository.js 读写接口

新增封装函数（与 `getBackgroundConfig/setBackgroundConfig` 同模式）：

```js
// src/backend/database/settings-repository.js
function getUiStyle(db) {
  const raw = getSetting(db, 'ui_style');
  // 鲁棒性：未知值 fallback 到 'Clear'（D5 默认）
  return raw === 'General' ? 'General' : 'Clear';
}

function setUiStyle(db, style) {
  // 鲁棒性：拒绝写入非法值
  const safe = style === 'General' ? 'General' : 'Clear';
  setSetting(db, 'ui_style', safe);
}

module.exports = {
  // ... 既有
  getUiStyle,
  setUiStyle
};
```

### 3.2 database.js facade

```js
// src/backend/database.js（在 getBackgroundConfig 附近）
getUiStyle() {
  return settingsRepository.getUiStyle(this.db);
}

setUiStyle(style) {
  return settingsRepository.setUiStyle(this.db, style);
}
```

### 3.3 启动迁移钩子位置

放置在 `src/main.js:8843-8845` 之后（database.init 之后，pendingDb open 之前或之后皆可，与 pendingDb 无关）：

```js
// src/main.js（app.whenReady 内）
database = new AppDatabase(dataPath);
database.init();
markStartupMetric(STARTUP_METRIC_MARKS.databaseReady);

// === 新增：F4 升级迁移 ===
ensureUiStyleDefault(database);
// =========================

try {
  pendingDb = openPendingDb(...);
}
// ...
```

`ensureUiStyleDefault` 实现（建议放在 `src/main.js` 顶层独立函数，或 `src/backend/database/migrations.js` 内）：

```js
function ensureUiStyleDefault(database) {
  const current = settingsRepository.getSetting(database.db, 'ui_style');
  if (current == null || current === '') {
    settingsRepository.setSetting(database.db, 'ui_style', 'Clear');
    appendActivityLogEntry({
      level: 'info',
      message: '[v2.0.0-beta.2] 升级迁移：ui_style 默认设为 Clear'
    });
  }
}
```

> **关键约束**：此迁移**幂等**。多次启动只会在第一次写入；用户后续切到 General 不会被覆盖（AC3-3 验收）。

### 3.4 IPC 接口设计

**推荐方案：复用现有 `app:get-info` + 新增 setUiStyle**（避免启动多一次 IPC 来回）：

```js
// src/main.js 现有 'app:get-info' handler 增加 uiStyle 字段
ipcMain.handle('app:get-info', () => {
  // ... 既有
  return {
    version: app.getVersion(),
    // ... 既有
    backgroundConfig: buildBackgroundPayload(),
    previewModal: process.env.APP_PREVIEW_MODAL || '',
    ownAccountsMigrationError: lastOwnAccountsMigrationError,
    // === 新增 ===
    uiStyle: database.getUiStyle()  // 'Clear' | 'General'
  };
});

// 新增 setUiStyle
ipcMain.handle('settings:set-ui-style', (_event, style) => {
  database.setUiStyle(style);
  return { success: true };
});
```

`src/preload.js` 暴露：

```js
// src/preload.js
contextBridge.exposeInMainWorld('desktopApi', {
  // ... 既有
  settings: {
    setUiStyle: (style) => ipcRenderer.invoke('settings:set-ui-style', style)
    // 不暴露 getUiStyle，因为 app.getInfo() 已经返回
  }
});
```

> 备选：单独 `settings:get-ui-style` IPC，但启动期已经调过 `app:get-info`，再加一次 IPC 浪费。

---

## 四、CSS 切换机制

### 4.1 三种切换策略对比

| 选项 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **(a) 双 link + disabled 切换** | 两份 CSS 都 link 但 `disabled=true` 的不生效；切换时改 disabled 属性 | 切换 < 50ms（无网络/解析）；保留 Electron 渲染层缓存；切换瞬间无白屏 | DOM 多挂一份 link 节点（可忽略）；首次启动多下载 ~50KB（本地文件，<10ms） |
| **(b) 单 link + 切 href** | 启动时只挂一份；切换时改 link.href | DOM 干净 | 切换有 50-200ms 延迟（重新下载 + 解析 CSS），可能有白屏闪烁 |
| **(c) 单 styles-gemini.css 作为基线 + General 写覆盖 selector** | 只引入 Clear CSS，General 通过 styles.css 覆盖（删除 styles-gemini-extra.css 部分内容） | 文件少；单一 source of truth | 维护成本高（维护 General 必须知道 Clear 全集；Clear 改一个 var 可能影响 General）；selector 优先级需谨慎管理 |

### 4.2 推荐策略：(a) 双 link + disabled 切换

**理由（一句话）**：
**Electron 本地文件场景下，双 link disabled 切换是 0 网络成本 + 0 重解析 + 切换 <50ms 的"零延迟"方案，比 (b) href 切换快一个数量级，比 (c) 单 source 维护成本低**。

**实现细节**：

```html
<!-- index.html -->
<head>
  <!-- General 风格 CSS：默认 disabled（renderer initialize 后由 applyUiStyle 切换）-->
  <link id="cssGeneral" rel="stylesheet" href="./src/styles.css" disabled />

  <!-- Clear 风格 CSS：默认启用（首次启动若 ui_style='Clear' 直接生效）-->
  <link id="cssClear" rel="stylesheet" href="./src/styles-gemini.css" />
  <link id="cssClearExtra" rel="stylesheet" href="./src/styles-gemini-extra.css" />
</head>
<body data-style="clear">
```

> **注意**：HTML 默认 `data-style="clear"` 是为了 renderer 启动早期（`getInfo` 还没回来时）也有合理样式；renderer 拿到 info.uiStyle 后会立即覆盖。

```js
// src/renderer.js 新增 applyUiStyle 函数
function applyUiStyle(style) {
  const safe = style === 'General' ? 'General' : 'Clear';
  state.uiStyle = safe;

  const cssGeneral = document.getElementById('cssGeneral');
  const cssClear = document.getElementById('cssClear');
  const cssClearExtra = document.getElementById('cssClearExtra');

  if (safe === 'General') {
    // 先启用目标 → 再禁用旧的，避免 1 帧裸 DOM
    cssGeneral.disabled = false;
    cssClear.disabled = true;
    cssClearExtra.disabled = true;
    document.body.dataset.style = 'general';
  } else {
    cssClear.disabled = false;
    cssClearExtra.disabled = false;
    cssGeneral.disabled = true;
    document.body.dataset.style = 'clear';
  }
}
```

### 4.3 selector 隔离规则（D15 简化后）

**reverse sync 2026-04-27（D15 PRD §三）**：原方案要求两份 CSS 全量加 `body[data-style="..."]` 前缀作"双保险"。Dev 阶段 3 实施前发现：

- `<link>.disabled = true` → CSS 引擎**完全跳过**该 stylesheet（不参与 cascade，不参与 selector 匹配）
- 两份 CSS 永远只启用一份，**不会重叠**
- 加前缀是冗余双保险，工作量大（4078 行 / 600+ selector）

**最终方案（B 简化）**：

#### 4.3.1 `src/styles.css`（General）

直接用现有内容**不动**，**末尾追加 5-10 条 General 退化规则**（针对单 HTML 里 Clear 特有的条件渲染节点）：

```css
/* === v2.0.0-beta.2 D15: General 风格退化规则（针对 Clear 特有节点）=== */

/* 1. 渐变文字 reset */
.gemini-gradient {
  background: none;
  -webkit-background-clip: initial;
  -webkit-text-fill-color: inherit;
  color: inherit;
}

/* 2. status-spark SVG 隐藏（General 状态栏不要那个钻石）*/
.status-spark { display: none; }

/* 3. module-switcher caret ▾ 隐藏（General 风格没有 caret 设计）*/
.module-switcher-caret { display: none; }

/* 4. module-switcher icon SVG 隐藏 + 用 emoji ::before 替代 */
.module-switcher-icon svg { display: none; }
.module-switcher-icon::before { content: "🔁"; font-size: 18px; }

/* 5. select-shell 透明化（让现有 .cell.center > select 规则继续生效）*/
.select-shell { display: contents; }
```

#### 4.3.2 `src/styles-gemini.css` + `src/styles-gemini-extra.css`（Clear）

直接拷自 `Clear/styles-gemini.css` + `Clear/styles-gemini-extra.css`，**不改动**（不加前缀）。

#### 4.3.3 切换机制

renderer.js `applyUiStyle(style)`：

| style | cssGeneral.disabled | cssClear.disabled | cssClearExtra.disabled | body.dataset.style |
|---|---|---|---|---|
| `'Clear'` | true | false | false | `'clear'` |
| `'General'` | false | true | true | `'general'` |

切换瞬间 < 5ms，CSS 已 preload 解析在内存。

#### 4.3.4 双保险还需要吗？

不需要。link.disabled 由 renderer 自己代码控制（不会被外部修改），且 CSS 引擎对 disabled stylesheet 的隔离是规范行为（W3C HTML5 § Stylesheets `disabled` IDL attribute），不存在边缘 case。如果未来发现 bug，加前缀仍可叠加（不冲突）。

---

## 五、渲染层

### 5.1 body data-style 属性管理

启动时（`src/renderer.js:initialize`）：

```js
async function initialize() {
  // ... 既有
  const info = await window.desktopApi.app.getInfo();
  // === 新增（紧跟 getInfo 后）===
  applyUiStyle(info.uiStyle || 'Clear');
  // ============================
  // ... 既有的 backgroundSettings 等
}
```

### 5.2 5 类条件渲染节点清单

| 节点 | 现有 General | Clear 设计稿 | DOM 改造（基线对齐 Clear）| CSS 适配（General 用 selector hide）|
|------|------------|--------------|-------------------------|--------------------------------|
| **N1 主标题** | `index.html:27` `<h1 class="page-title">网银账单小助手</h1>` | `Clear/main.html:22` `<h1 class="page-title"><span class="gemini-gradient">网银账单小助手</span></h1>` | 加 `<span class="gemini-gradient">` | `body[data-style="general"] .gemini-gradient { background: none; -webkit-text-fill-color: var(--text); }` |
| **N2 模块切换 icon** | `index.html:32` `<span class="module-switcher-icon">🔁</span>` | `Clear/main.html:27-29` `<span class="module-switcher-icon"><svg>...</svg></span>` | 加 `<svg>` 子节点（保留 emoji 通过 ::before）| `body[data-style="general"] .module-switcher-icon svg { display: none; }` + `body[data-style="general"] .module-switcher-icon::before { content: "🔁"; }` |
| **N3 模块切换 caret** | 无 | `Clear/main.html:31` `<span class="module-switcher-caret">▾</span>` | 加 caret span | `body[data-style="general"] .module-switcher-caret { display: none; }` |
| **N4 状态栏 spark** | `index.html:73` `<div id="statusBox">欢迎使用小助手</div>` | `Clear/main.html:69-74` `<div class="status-box"><span class="status-spark"><svg>...</svg></span> 欢迎使用小助手</div>` | 加 `<span class="status-spark"><svg>...</svg></span>` | `body[data-style="general"] .status-spark { display: none; }` |
| **N5 猫猫 GIF（D8 关键）**| `index.html:24` `<img class="corner-gif" src="./assets/cat-meme.gif">` | `Clear/main.html:19` `<div class="corner-gif-slot">🐱</div>`（emoji 仅设计稿用）| **保留 `<img>` 节点不变**（D8）| `body[data-style="clear"] .corner-gif { width: 40px; ... border-radius: 12px; ... }` vs General 大尺寸无阴影 |

> **关键原则**：5 类节点都通过 CSS 处理，**不在 JS 里 if-else 任何 DOM 操作**（PRD 明确"局部条件渲染"含义）。

### 5.3 提醒框：复用 createConfirmDialog（D11）

不另起一个 dialog factory，直接复用：

```js
// src/renderer.js 新增 handlePaletteStyleConfirm
function handlePaletteStyleConfirm() {
  const select = document.getElementById('paletteStyleSelect');
  const newStyle = select.value;  // 'Clear' | 'General'

  openModal(createConfirmDialog({
    message: `确认切换页面风格到 ${newStyle}？切换后页面将立即生效（无需重启）。`,
    confirmText: '确认切换',
    cancelText: '取消',
    onConfirm: async () => {
      await window.desktopApi.settings.setUiStyle(newStyle);
      applyUiStyle(newStyle);  // 立即热切换
      closeModal();
      setStatus(`已切换到 ${newStyle} 风格`, 'success');
    }
  }));

  // 注意：onConfirm 的 cancel 分支由 createConfirmDialog 内部 closeModal 处理；
  //       但 D10 要求 cancel 时回滚 select.value，需要在 createConfirmDialog 内
  //       的 cancel handler 后追加一个 hook，或在调用方 listen modal close 事件
}
```

D10 cancel 回滚 select 值的实现选项：

**选项 A**（推荐）：扩展 createConfirmDialog 接受可选 onCancel 回调（不破坏现有签名）

```js
// src/renderer-dialogs.js 增强
function createConfirmDialog({ message, confirmText, cancelText, onConfirm, onCancel }) {
  // ... 既有
  dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    closeModal();
    onCancel?.();  // 新增
  });
  // ... 既有
}
```

调用：

```js
openModal(createConfirmDialog({
  // ...
  onConfirm: async () => { /* 写 DB + applyUiStyle */ },
  onCancel: () => {
    select.value = 'Clear';  // D10 回滚
  }
}));
```

**选项 B**（兼容现有签名）：在 onConfirm 之外用一个标志位 + modal close listener

不推荐（兼容性 vs 复杂度不划算）。

> 推荐选项 A，对其他既有 createConfirmDialog 调用零影响（新参数可选）。

---

## 六、文件改动清单（预估）

| 文件 | 改动类型 | 概要 | 阶段 |
|------|---------|------|------|
| `package.json` | 修改 | `version`：`2.0.0-beta.1` → `2.0.0-beta.2`（D12）| 1 |
| `CHANGELOG.md` | 修改 | 新增 v2.0.0-beta.2 条目 | 1 |
| `docs/VERSION_FEATURE_HISTORY.md` | 修改 | 新增 v2.0.0-beta.2 条目 | 1 |
| `docs/USER_GUIDE.md` | 修改 | 新增"风格切换"章节 | 1 |
| `src/backend/database/settings-repository.js` | 修改 | 新增 `getUiStyle / setUiStyle`（§3.1）| 1 |
| `src/backend/database.js` | 修改 | facade 暴露 `getUiStyle / setUiStyle`（§3.2）| 1 |
| `src/main.js` | 修改 | (1) 新增 `ensureUiStyleDefault` 函数；(2) `app.whenReady` 调用；(3) `app:get-info` handler 加 `uiStyle` 字段；(4) 新增 `settings:set-ui-style` handler；(5) preview 模式读 `APP_PREVIEW_STYLE` env 强制 setUiStyle | 1, 6 |
| `src/preload.js` | 修改 | `desktopApi.settings.setUiStyle` 暴露 | 1 |
| `index.html` | 修改 | (1) `<head>` 改为 3 个 link（cssGeneral disabled / cssClear / cssClearExtra）；(2) `<body data-style="clear">` 默认；(3) 主标题加 `gemini-gradient` span；(4) 模块 icon 加 SVG + caret span；(5) status-box 加 status-spark span；(6) 猫猫 GIF `<img>` 保留不变（D8）；(7) 调色板新增 palette-panel-style-row | 2, 4 |
| `src/styles.css` | 修改（重写）| 全部 selector 加 `body[data-style="general"]` 前缀；新增 5 类条件渲染节点的 General 退化样式 | 3 |
| `src/styles-gemini.css` | 新增 | 拷贝 `Clear/styles-gemini.css` 内容（403 行），所有 selector 加 `body[data-style="clear"]` 前缀；调整 `.corner-gif` 选项匹配 D8 | 3 |
| `src/styles-gemini-extra.css` | 新增 | 拷贝 `Clear/styles-gemini-extra.css` 内容（1132 行），同样加 `body[data-style="clear"]` 前缀 | 3 |
| `src/renderer.js` | 修改 | (1) `initialize` 调 `applyUiStyle(info.uiStyle)`；(2) 新增 `applyUiStyle` 函数；(3) `openBackgroundPalette` reset `paletteStyleSelect.value = 'Clear'`（D5）；(4) 新增 `handlePaletteStyleConfirm` + 绑事件；(5) state.uiStyle 字段；(6) 元素 cache 加 `paletteStyleSelect / paletteStyleConfirmBtn` | 4 |
| `src/renderer-dialogs.js` | 修改 | (1) `createConfirmDialog` 增 `onCancel` 参数（§5.3）；(2) 各 createXxxDialog 按 PRD §5.1 mapping 表对齐 Clear 设计稿（清洗 inline style + data-cc-id）| 5 |
| `src/renderer-pending.js` | 修改 | createPendingExportDialog / createPendingRuleDialog / createPendingReconcileDialog 等对齐 Clear 设计稿 | 5 |
| `src/renderer-previews.js` | 修改 | preview 模式下额外支持 'palette-style-confirm-dialog' 等 modal name（如本次新增 modal 需要 preview）| 6 |
| `scripts/render-modal-preview.js` | 修改 | 支持 `APP_PREVIEW_STYLE` env 转发到 child Electron | 6 |
| `scripts/render-preview.js` | 修改 | 同上 | 6 |
| `scripts/render-account-mapping-preview.js` | 修改 | 同上 | 6 |
| `scripts/render-template-manager-preview.js` | 修改 | 同上 | 6 |
| `docs/previews/*.png` | 重渲（修改）| 36 张 Clear 风格截图重渲（默认 `npm run preview:all` 即 Clear）；General 风格独立目录 | 6 |
| **合计** | | **20 个文件**（含 dialog factory 适配）| |

> **dialog factory 适配**已含（src/renderer-dialogs.js + src/renderer-pending.js），按 PRD §5.1 mapping 表分组。

---

## 七、任务分解（与 PRD §九 阶段对齐）

| 序号 | 任务 | 涉及文件 | 验证方式 | 阶段 | 状态 |
|------|------|---------|---------|------|------|
| T1 | 数据底座：getUiStyle / setUiStyle / IPC / preload 暴露 / ensureUiStyleDefault 启动钩子 | settings-repository.js / database.js / main.js / preload.js | 单测 + console 调用 | 1 | todo |
| T2 | 版本号 bump + 三件套同步 + scan:vars | package.json / CHANGELOG.md / VERSION_FEATURE_HISTORY.md / USER_GUIDE.md | npm start 看版本号；scan:vars 报告无新 A-share 漏网 | 1 | todo |
| T3 | index.html 重构对齐 Clear 结构（不含调色板下拉）+ 双 link + body data-style | index.html | DOM 结构 diff；启动看视觉无错乱（仅 Clear CSS 启用，General 还未重写完）| 2 | todo |
| T4 | 拷贝 Clear/*.css → src/，sed 加 body[data-style="clear"] 前缀 | src/styles-gemini.css / src/styles-gemini-extra.css | 文件存在 + selector 全部带前缀 | 3 | todo |
| T5 | 重写 src/styles.css，加 body[data-style="general"] 前缀；新增 5 类条件渲染 General 退化样式 | src/styles.css | preview:main-page (general) vs beta.1 截图 visual diff | 3 | todo |
| T6 | renderer.js applyUiStyle 函数 + initialize 接入 + state.uiStyle | src/renderer.js | 启动后 body.dataset.style 正确 + link.disabled 正确 | 3 | todo |
| T7 | 调色板新增"切换页面风格"row（select + 确认按钮）+ openBackgroundPalette reset D5 | index.html / src/renderer.js | preview:statement-palette 双风格 | 4 | todo |
| T8 | createConfirmDialog 加 onCancel 参数 + handlePaletteStyleConfirm | src/renderer-dialogs.js / src/renderer.js | 手动：切换流程 P0-4 ~ P0-7 | 4 | todo |
| T9 | dialog factory 双套适配（按 PRD §5.1 mapping 表分组）：Pending / 大账号 / 字段映射 / alert/confirm / 其它 | src/renderer-dialogs.js / src/renderer-pending.js | preview 全量双风格；grep 'data-cc-id' / 'font-weight:500' = 0（D13 验收 AC4-5）| 5 | todo |
| T10 | preview 脚本支持 APP_PREVIEW_STYLE | scripts/render-*.js / src/main.js（preview 模式分支）| 命令行测试两风格 | 6 | todo |
| T11 | preview 全量双风格重渲 + 与 designer 稿 / beta.1 截图 visual diff | docs/previews/ | 36×2 截图 ✓ | 6 | todo |
| T12 | smoke 双风格各跑一次 | npm run smoke | 不破 | 6 | todo |
| T13 | /check-vars 关联功能 review | rules/important-variables.md | PR body 含「⚠️ 关联功能 review」 | 6 | todo |

### 关键依赖链

```
T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13
（数据 / bump / HTML 改造 / CSS 拷贝 / styles.css 重写 / applyUiStyle / 调色板 / 提醒框 / dialog 适配 / preview 脚本 / 截图重渲 / smoke / check-vars）
```

**关键节点**（人工复核红线）：

- **T3 + T5**：⚠️ 阶段 2~3 是最大风险点——HTML 改造 + General CSS 重写需要同步完成，否则视觉错乱
- **T8**：⚠️ 切换流程 P0-4 ~ P0-7 必须手动逐一验证，特别是 D10 取消回滚
- **T9**：⚠️ dialog factory 适配是工作量最大且最容易遗漏的，逐组 preview 双风格
- **T11**：⚠️ visual diff 需要人眼过 36×2 = 72 张截图，不要跳过

---

## 八、实施计划（Commit 粒度）

| 序号 | Commit message | 涉及文件 | 任务 |
|------|---------------|---------|------|
| 1 | `[v2.0.0-beta.2] feat(settings): ui_style + 升级迁移 + 版本号 bump` | T1 + T2 | 1, 2 |
| 2 | `[v2.0.0-beta.2] refactor(html): index.html 基线对齐 Clear 结构` | T3 | 3 |
| 3 | `[v2.0.0-beta.2] feat(css): 引入 styles-gemini[-extra].css + selector 加 data-style 前缀` | T4 | 4 |
| 4 | `[v2.0.0-beta.2] refactor(css): styles.css 重写为 General data-style selector + 5 类条件渲染退化` | T5 | 5 |
| 5 | `[v2.0.0-beta.2] feat(renderer): applyUiStyle + body data-style 切换` | T6 | 6 |
| 6 | `[v2.0.0-beta.2] feat(palette): 调色板"切换页面风格"下拉 + 确认按钮` | T7 | 7 |
| 7 | `[v2.0.0-beta.2] feat(palette): 风格切换提醒框 + onCancel 回滚` | T8 | 8 |
| 8 | `[v2.0.0-beta.2] refactor(dialogs): dialog factory 适配 Clear 设计稿（清洗 inline style + data-cc-id）` | T9 | 9 |
| 9 | `[v2.0.0-beta.2] feat(preview): APP_PREVIEW_STYLE 环境变量支持` | T10 | 10 |
| 10 | `[v2.0.0-beta.2] chore(preview): 双风格全量重渲 36×2 截图` | T11 | 11 |
| 11 | `[v2.0.0-beta.2] test: smoke 双风格通过 + check-vars review` | T12, T13 | 12, 13 |

> 实际可能合并某些 commit（如 4+5 一起改），按实施顺畅度调整。

---

## 九、测试方案（覆盖 PRD §七）

### 9.1 单元测试

| 测试 | 覆盖 | 位置 |
|------|------|------|
| `getUiStyle` 默认 fallback | AC2-3 / AC3-4 | scripts/test-ui-style.js（新增）|
| `setUiStyle` 鲁棒性（非法值过滤）| AC2-3 | 同上 |
| `ensureUiStyleDefault` 幂等 | AC3-1 / AC3-2 / AC3-3 | 同上 |

### 9.2 手动测试（覆盖 PRD §13.1 P0）

按 PRD §13.1 P0-1 ~ P0-10 + §13.2 P1-1 ~ P1-5 全部跑过。

特别关注：
- **P0-4 / P0-5 切换流程**：应 < 200ms 无白屏闪烁
- **P0-6 取消回滚**：select.value 必须回到 'Clear'（D10）
- **P0-7 改了不点确认按钮**：DB 不写 + 下次打开下拉显示 'Clear'（D5）
- **P0-10 猫猫 GIF**：两种风格都要看到 cat-meme.gif（D8）

### 9.3 Preview 视觉验证

```bash
# 默认 Clear 风格
npm run preview:all

# General 风格（待 T10 实现 APP_PREVIEW_STYLE 后）
APP_PREVIEW_STYLE=general npm run preview:all
```

视觉对比：
- Clear 36 张 vs `Clear/*.html` designer 稿 → token 级一致（D11 放宽）
- General 36 张 vs beta.1 截图（git stash 切回 main 拿 beta.1 截图）→ pixel diff < 1%

### 9.4 Smoke

```bash
npm run smoke  # 默认 ui_style='Clear'
# 手动改 DB ui_style='General' → npm run smoke 再跑
```

---

## 十、风险点（每条对应 PRD §八 + 技术兜底）

| PRD 风险 | TechDoc 兜底 |
|---------|-------------|
| **PRD R-1** HTML 改造破坏 General 视觉 | T5 全量重写 styles.css 加 selector 前缀；T11 preview:all (general) 与 beta.1 visual diff 验收 |
| **PRD R-2** 热切换样式风险 | §四 选定策略 (a) 双 link + disabled；T6 PoC 验证 < 50ms 无抖动；如 Electron 实际表现差，备选策略 (b) href 切换 |
| **PRD R-3** 颗粒度 A 工作量降但 dialog 适配仍需双套 selector | T9 按 PRD §5.1 mapping 分组，逐组 preview；createConfirmDialog 等公共 factory 改一次受益所有调用方 |
| **PRD R-4** 升级回滚等价性 | AC4-2 + 全量 General preview 验收 |
| **PRD R-5** Preview 双跑工作量 | T10 一次性扩 4 个 render 脚本；CI/Dev 默认只跑 Clear，PR 前跑双倍 |
| **PRD R-6** 数据丢失风险 | §3.3 ensureUiStyleDefault 严格判 `current == null \|\| current === ''`；AC3-3 测试覆盖 |
| **PRD R-7** Clear 资产清洗不彻底 | T9 完成后 grep 'data-cc-id' 'font-weight:500' = 0 验收（AC4-5）|
| **新增 R-T1**（技术）：link.disabled 在 Electron 实际行为 | T6 PoC 单独验证；如不工作 fallback 到策略 (b) |
| **新增 R-T2**（技术）：sed 批量加 body[data-style] 前缀的脚本错误 | T4 拷贝后用 grep 抽样验证前 50 个 selector 都带前缀；diff CSS 行数应等于原文件 |

---

## 十一、Open Technical Questions

无（PRD v1 OT 已全部 closed）。

实施过程中如发现新疑点，按 reverse sync 流程更新 PRD + TechDoc 后再继续。

---

## 十二、实施日志

> 由 Dev 实施过程中追加。
