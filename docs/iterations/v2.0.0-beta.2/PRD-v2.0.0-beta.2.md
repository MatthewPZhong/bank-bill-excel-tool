# PRD - 网银账单小助手 v2.0.0-beta.2

> **版本：v1（定稿）**
> v0 草稿的 OT-1 ~ OT-7 已全部 closed（用户 2026-04-27 锁定决策），同时新增 D8 ~ D14（详见 §三）。
> 本版本可作为 Dev 阶段输入；§五 / §六 / §七 / §九 中标"待 OT-X 决策"的章节已全部细化。
> 颗粒度从 v0 的 B（HTML 双套）**降级**为 A（仅切 CSS + 局部条件渲染）。

| 项目 | 内容 |
|------|------|
| 版本 | v2.0.0-beta.2（v1 定稿） |
| 日期 | 2026-04-27 |
| 作者 | PM |
| 状态 | 定稿（OT 全部 closed） |
| 模块 | 跨模块基础设施：UI 风格切换（颗粒度 A：单 HTML + 双 CSS）+ 升级迁移 |
| 依赖 | 2.0.0-beta.1（PR #25 已 merged 到 main，commit `5308b24`）|
| 基版本 | 2.0.0-beta.1（v2.0.0 分支）|

---

## 一、需求概述

本次 v2.0.0-beta.2 包含 **1 项基础设施需求**（用户原始 2 条中第 1 条已取消，详见 D1）：

1. **新增"切换页面风格"下拉框** —— 调色板面板新增单选下拉，枚举 `Clear` / `General`，下拉默认显示固定 "Clear"；选定后点确认按钮才弹二次确认提醒框；确认后写入 SQLite + 立即热切换；升级用户首次启动 `ui_style` 为空时自动写 `'Clear'`。
   - 颗粒度 **A（仅切 CSS + 局部条件渲染）**——HTML 结构基线对齐 Clear，General 通过 CSS selector / `data-style="general"` 适配（详见 D6 / D6.1）。
   - 设计稿源：`Clear/` 文件夹（38 个 HTML + 2 个 styles-gemini\*.css），由 Claude Design 提供。
   - 当前（2.0.0-beta.1 及之前）所有页面命名为 `General` 风格；新增 `Clear` 风格作为本次默认。

> **被取消的需求**：调色板"重置"按钮右侧"调色盘"勾选框 —— 用户 2026-04-27 确认取消（D1）。

---

## 二、背景与目标

### 2.1 背景

**R1 — 双风格支持需求**

- 用户希望一套应用可在两种视觉风格之间切换：现有 `General` 风格（`src/styles.css` 沿用至 v2.0.0-beta.1）和新增 `Clear` 风格（Claude Design 提供，源在 `Clear/`）。
- Clear/ 当前为**纯静态稿**（38 个 HTML + 2 个 CSS），未接入 Electron 应用，需要工程化集成。
- 业务考量：v0 一度倾向颗粒度 B（HTML 双套）以便最大灵活性，但工作量过大，且 Clear/ 设计稿与现有 DOM 结构差异**主要在视觉层**（猫 GIF emoji 替换、标题加 gemini-gradient span、icon 用 SVG 替代 emoji 等），决定降级为颗粒度 A：**HTML 单一基线（对齐 Clear），CSS 双套切换**。

**R1 — 目标**：
- 用户可在调色板页面切换风格（仅 1 个入口，不在主界面塞额外按钮）
- 选择持久化到 `app_settings` 表（与现有 `background_config` 同样机制）
- 已安装 2.0.0-beta.1 的用户升级到 beta.2 后**首次启动若 `ui_style` 为空 → 写 'Clear'**（统一默认值）
- Clear 风格需覆盖现有所有 36 个 preview 截图所对应的页面/对话框，通过 preview 双风格对比验证

### 2.2 目标

- 调色板面板新增"切换页面风格"单选下拉，枚举值 `Clear` / `General`，下拉默认显示固定 "Clear"（D5）
- 切换交互：用户选定下拉值后**点确认按钮**才弹二次确认提醒框（D9）→ 确认 → 写 SQLite + 立即热切换（D10）；取消 → 下拉值回滚到 "Clear"（D5 + D10），DB 不写入
- 切换持久化到 `app_settings` 表，setting_key = `ui_style`，setting_value ∈ `{Clear, General}`（D3）
- 升级迁移：beta.1 → beta.2 首次启动时若 `ui_style` 为空 → 写入 `'Clear'`（D4）
- Clear 风格资产从 `Clear/` 集成到 `src/`：CSS 双套（D2 保留 Gemini 文件名），HTML 结构基线统一为 Clear（D6 + D6.1）
- 猫猫 GIF（`assets/cat-meme.gif`）两种风格都保留（D8）：HTML 用 `<img class="corner-gif" src="./assets/cat-meme.gif">`，CSS 各自调位置/阴影
- v2.0.0-beta.2 之后所有前端结构改动需**默认基于 Clear 结构 + 同步双套 CSS 维护**（见 §九 工程约束）

### 2.3 明确不做

- ~~调色板"重置"按钮右侧"调色盘"勾选框 + 页面上侧调色盘~~ —— 用户 2026-04-27 取消（D1）
- 不做风格切换的过渡动画（直接重新加载样式即可）
- 不做 General 风格独立 HTML 模板（颗粒度 A：与 Clear 共用同一 DOM 树）
- 不为 `Clear` 风格新增设计资产以外的功能（不补按钮、不改流程）
- 不做风格"自定义"/"用户自调"功能（仅枚举 2 选 1）
- 不做 v3.0.0 相关需求

---

## 三、决策记录

> 用户在 2026-04-27 的对话中已逐条确认。OT-1 ~ OT-7 全部 closed，并新增 D8 ~ D14。

| ID | 决策 | 用户原话 / 来源 | 落地位置 |
|----|------|----------------|---------|
| D1 | 需求 #1（"重置"按钮右侧"调色盘"勾选框 + 页面上侧调色盘）**取消** | 用户回复："这个需求取消" | §2.3、§五（不出现该功能） |
| D2 | Clear 风格保留 Gemini 文件名约定（CSS：`styles-gemini.css` + `styles-gemini-extra.css`），仅枚举值用 "Clear" | 用户回复："保留 Gemini 文件名仅枚举值用 Clear" | §六、§9.x |
| D3 | 风格切换持久化存 **SQLite**（与 `database.getBackgroundConfig()` 同样机制，即 `app_settings` 表 KV）| `src/main.js:1290` 显示 `getBackgroundConfig()` 走 `setting_key = background_config`；用户认可同样机制（KV 表 + 新 setting_key=`ui_style`）| §六（数据模型） |
| D4 | 升级用户（2.0.0-beta.1 → beta.2）首次启动若 `ui_style` 为空 → 写 `'Clear'`（一次性迁移） | 用户回复："是的" | §F4 / §6.4 / §AC3-x |
| **D5** | "切换页面风格"下拉框默认显示 = **永远显示 "Clear"**（即下拉作为"切回 Clear 的入口"使用，不反映当前实际风格）| 用户 2026-04-27 锁定（OT-2 子项）："永远显示 Clear" | §F1 / §6.1 / §7.1 |
| **D6** | 颗粒度 = **A（仅切 CSS + 局部条件渲染）**——非 B（OT-5 用户由 B **降级** 为 A） | 用户回复："A，不是 B" | §F5 / §五 / §九 |
| **D6.1** | HTML 结构**基线用 Clear 的**——renderer 对齐 Clear 的 id/class；General 风格通过 CSS selector + `data-style="general"` body 属性适配 | 用户 2026-04-27：把 General 当 Clear 的"override"看 | §F5 / §六 / §九 |
| D7 | PR #25（表头 10pt + Pending preview 链路扩充）先合到 main（已完成 2026-04-27，merge commit `5308b24`） | git log + 用户对话确认 | §依赖 |
| **D8** | 猫猫 GIF（`assets/cat-meme.gif`）**两种风格都保留**——Clear 设计稿 emoji `🐱`（`Clear/main.html:19` 是 `<div class="corner-gif-slot">🐱</div>`）替换回 `<img class="corner-gif" src="./assets/cat-meme.gif">`；两种风格通过 CSS 微调外观（阴影/边框/位置），**同一 `<img>` 节点** | 用户回复："两种风格都保留猫猫" | §F7（新增）/ §6.7 |
| **D9** | "切换页面风格"下拉选定后**点确认按钮才弹提醒框**——不在失焦/选择/合上时直接弹（破坏性操作要二次确认）| 用户回复："点确认按钮才弹" | §F1 / §F2 / §6.2 / §AC1-x |
| **D10** | 提醒框点取消 → 下拉框值回滚到 "Clear"（因 D5 永远显示 Clear，"回滚"无视觉变化）；点确认 → 写入 SQLite + **立即重新加载样式生效**（不全页 reload）| 用户回复："取消回到 Clear，确认写入并立即生效" | §F2 / §6.2 / §7.4 |
| **D11** | Clear/ 没画的 UI（"切换页面风格"下拉框 + 风格切换提醒框 + alert/confirm 等）**放宽验收**——不要求像素级一致，按 `styles-gemini-extra.css` 现有 token（颜色/圆角/字号）自行实现，保持风格统一 | 用户回复："Clear 没画的 UI 不要求像素级一致" | §6.1 / §6.2 / §AC4-x |
| **D12** | 版本号 bump 时机：**spec 锁定后第一次 commit 时 bump**——即 PM v1 PRD 落地后 Dev 第一次 src 改动 commit 时把 `package.json.version` `2.0.0-beta.1` → `2.0.0-beta.2`，同时按 `workflow_docs_update` 更新三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）+ 跑 `npm run scan:vars` + `/check-vars` | 用户回复（OT-4）：方案 B | §九 实施计划 / 阶段 1 |
| **D13** | Clear 资产清洗：集成 HTML 时**剥离 inline style="font-weight:500" + data-cc-id="cc-X"** 等设计辅助标记，只保留语义 class（class 名以 Clear 现有为基线）| 用户回复（OT-6）：清洗 inline style + data-cc-id | §F6 / §6.6 / TechDoc §五 |
| **D14** | Clear/ 资产命名错误（如 `Clear/index.html` 实际是 Pending 导出差异弹窗）按**内容对应**（不按文件名）——PM/Dev 集成时画一张 mapping 表（Clear/<file> ↔ 现有 dialog/page），存档于本 PRD §6.6 / TechDoc §五。命名问题不阻塞 Dev，后续跟 designer 沟通 | 用户回复（OT-7）：按内容对应 | §6.6 mapping 表 |
| **D15**（reverse sync）| **CSS 隔离机制简化**：原方案要求 `styles.css` (2617 行 / 417 selector) + `styles-gemini.css/extra.css` (1461 行) **全量加** `body[data-style="..."]` 前缀作"双保险"。Dev 阶段 3 实施前发现：`<link>.disabled` 已经实现 CSS 引擎层级的完全隔离（disabled stylesheet 不参与 cascade，与启用 stylesheet 无任何重叠），加前缀冗余。降级为：(1) 两份 CSS 都不加前缀（直接拷自 Clear/）；(2) `styles.css` 末尾追加 5-10 条 General 退化规则（仅针对条件渲染节点 `.gemini-gradient` `.status-spark` `.module-switcher-caret` `.module-switcher-icon svg` `.select-shell`）；(3) 风格切换通过 `cssGeneral.disabled / cssClear.disabled / cssClearExtra.disabled` 三状态布尔切换。工作量减少 ~80%，安全等价 | 用户回复（reverse sync 2026-04-27）：B 简化方案 | §12.3 任务 / TechDoc §4.3 重写 |
| **D16**（reverse sync）| **风格-背景色联动**：阶段 3 实施后发现 `applyBackgroundSettings`（`src/renderer.js:1393-1404`）用 inline style 覆盖 `body.background`，优先级高于 CSS 文件的 `--bg`，导致 Clear 风格的 `#ffffff` 白色基调被 SQLite `background_config.colorHex='#efe8da'` 强制覆盖（视觉看不出风格差异）。联动方案：(1) Clear 风格默认色 = `#ffffff`（新增常量 `CLEAR_BACKGROUND_COLOR`）；(2) General 风格默认色 = `#efe8da`（沿用 `DEFAULT_BACKGROUND_COLOR`）；(3) 启动时仅当 colorHex 是"另一风格默认色"（魔法值）时重置，不覆盖用户自定义颜色（如 `#abcdef`）；(4) 阶段 4 用户主动切风格时同样应用此联动逻辑。实施分两步：阶段 3 启动联动（本 commit）+ 阶段 4 切换联动 | 用户回复（2026-04-27）：A 方案联动 | §F1 / §F7 / §12.3 + 12.4 |

---

## 四、代码现状（必须有出处）

| 关注点 | 相关文件 | 当前行为 | 已知限制 |
|------|---------|---------|---------|
| 单套 HTML 入口 | `index.html`（204 行） | 顶级 `<html>` `<link rel="stylesheet" href="./src/styles.css">`；`<body>` 全部布局直接写在内（`#appShell` 根容器）| 颗粒度 A 下需要：(a) 重构 DOM 对齐 Clear 结构（标题加 `<span class="gemini-gradient">`、模块切换 icon 用 SVG、添加 `corner-gif-slot` 但保留猫 GIF 等）；(b) `<body>` 加 `data-style="clear|general"` 属性 |
| 单套 CSS 入口 | `src/styles.css`（2617 行）| 唯一全局样式文件 | 与 `Clear/styles-gemini.css`（403 行）+ `Clear/styles-gemini-extra.css`（36KB，1132 行）功能重叠；颗粒度 A 下 styles.css 需重写为 General 风格的 selector，**Clear 风格用新引入的 styles-gemini.css** |
| 调色板面板 DOM | `index.html:171-194` | `<section id="backgroundPalettePanel" class="palette-panel" hidden>` 含光谱画布 + 选色器 + 操作按钮 | 没有"切换页面风格"下拉位 → 需要新增 DOM（详见 §6.1） |
| 调色板"重置"按钮 | `index.html:188` `<button id="backgroundResetBtn" class="palette-action danger-text">重置</button>` | 当前唯一左侧按钮 | D1 取消，"重置"右侧不再加勾选框；"切换页面风格"下拉位置见 §6.1 / §7.1（左上角） |
| 调色板入口函数 | `src/renderer.js:1402-1409` `openBackgroundPalette()` | 控制 `state.isBackgroundPaletteOpen` + 显示 `elements.backgroundPalettePanel` | 增加下拉后需要在打开时重置下拉值为 "Clear"（D5）|
| Clear 主界面 DOM 差异 | `Clear/main.html:1-95` | `corner-gif-slot` div 装 emoji 🐱、标题 `<span class="gemini-gradient">网银账单小助手</span>`、模块切换 icon 改 `<svg>` Gemini 钻石、状态栏 `<span class="status-spark"><svg>...`、`select` 外包 `<div class="select-shell">` | 需要节点级条件渲染（D6 局部条件渲染） |
| `app_settings` 表结构 | `src/backend/database.js:79-83` `CREATE TABLE IF NOT EXISTS app_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL)` | 通用 KV 表 | **不需要新增字段**，新增 `setting_key = 'ui_style'` 即可 |
| settings 通用读写 | `src/backend/database/settings-repository.js:1-24` `getSetting / setSetting` | 已暴露通用 `getSetting / setSetting`，并为 `background_config` / `enum_config` 各包了一层 | 直接复用 `getSetting('ui_style') / setSetting('ui_style', 'Clear'\|'General')` 或新增 `getUiStyle / setUiStyle` 包装（**TechDoc §二 决定**）|
| 启动时初始化 | `src/main.js:8837-8907` `app.whenReady()` → `database.init()` → `pendingDb` open → `runOwnAccountsMigration` | DB 已 init 后可调 `ensureUiStyleDefault(database)` | 接入位置：`database.init()` 之后、`createWindow()` 之前 |
| `app:get-info` IPC | `src/main.js:2627-2641` 返回 `{ version, hasEnum, ..., backgroundConfig, ownAccountsMigrationError }` | renderer 启动早期调用拿到 backgroundConfig 等初始数据 | 增加 `uiStyle` 字段返回（renderer 启动时即应用对应 CSS） |
| renderer 初始化 | `src/renderer.js:2967-3050` `initialize()` 早期调 `desktopApi.app.getInfo()` | 拿到 `info.backgroundConfig` 后立即 `applyBackgroundSettings()` | 同样模式：拿 `info.uiStyle` → `document.body.dataset.style = uiStyle.toLowerCase()` + 决定加载哪份 CSS |
| Preview 链路总入口 | `package.json:scripts.preview:all`（v2.0.0-beta.1 已扩到 36 张） | 单 General 风格 | 双风格 preview：preview 脚本支持 `APP_PREVIEW_STYLE=clear\|general`（默认 clear），单 HTML 用两套 CSS 渲染（详见 §九 阶段 6）|
| Clear/ 静态稿 | `Clear/*.html`（38 个）+ `Clear/styles-gemini.css`（12KB）+ `Clear/styles-gemini-extra.css`（36KB）| Claude Design 交付的纯静态 reskin，含 inline `style="font-weight:500"` + `data-cc-id="cc-X"`（如 `Clear/index.html:9, 19-20`）；部分文件命名与现有 preview 不一致（如 `Clear/index.html` 实际是 Pending 导出差异） | 需要清洗（D13）+ 命名 mapping（D14）|

---

## 五、术语

| 术语 | 含义 |
|------|------|
| 风格 / UI Style | 页面视觉风格枚举值，`{Clear, General}` 二选一 |
| General | 当前（2.0.0-beta.1 及之前）所有页面所采用的风格 |
| Clear | 本次新增的风格，资产源 `Clear/`；CSS 文件名保留 Gemini 命名（`styles-gemini.css` + `styles-gemini-extra.css`，D2）；枚举值/UI 文案统一用 "Clear" |
| 颗粒度 A | 风格切换时**仅切 CSS + 局部条件渲染节点**（D6）；HTML 结构基线统一对齐 Clear，General 通过 CSS selector / `data-style` 属性适配 |
| `data-style` | `<body data-style="clear|general">` 属性，CSS 通过 `body[data-style="general"] .xxx { ... }` 适配 General 风格 |
| 切换提醒框 | 用户在调色板下拉里改风格、点"确认切换"按钮后弹出的二次确认框（D9）|
| 升级迁移 | 已安装 2.0.0-beta.1 的用户，首次启动 beta.2 时检查 `ui_style` 是否为空，空则写 `'Clear'`（D4）|
| Preview 链路 | `package.json:scripts.preview:*` + `scripts/render-modal-preview.js` + `src/renderer-previews.js` 组成的截图链路；本次需要扩展为双风格（`APP_PREVIEW_STYLE` 切换）|
| 局部条件渲染 | DOM 中少数节点（标题 gradient span、模块切换 icon SVG、状态栏 spark SVG 等）依赖 `data-style` 用 `[data-style="clear"]:before` / 子元素 hide-show 实现，不在 JS 里 if-else（详见 §6.5）|

### 5.1 Clear/ vs preview 文件名对照（命名 mapping，D14 落地）

`Clear/` 38 个 HTML 文件 vs `docs/previews/` 36 张 PNG，名字差异 + 内容映射：

**命名差异 / 文件名错误**（11 项，按 D14 "按内容对应"）：

| Clear/ 文件名 | 实际内容（按 head/body） | 对应 preview 名 / 现有 dialog factory | 处理 |
|--------------|------------------------|---------------------------------|------|
| `Clear/index.html` | "Pending 导出差异" 弹窗（head 标 `Pending 导出差异 · Gemini`） | `pending-export-runs.png` / `createPendingExportDialog` | **按内容对应**（D14），renderer-pending.js 的 export-runs 弹窗集成时参考此文件 |
| `Clear/main.html` | 主界面 | `main-page.png` | 命名差异（OK） |
| `Clear/main-module-switcher-open.html` | 模块切换器展开 | `module-switcher-open.png` | 命名差异（OK） |
| `Clear/palette-statement.html` | 网银账单生成模块的调色板 | `statement-palette.png` | 命名差异（顺序对调） |
| `Clear/palette-new-account.html` | 新开账户余额生成模块的调色板 | `new-account-palette.png` | 同上 |
| `Clear/big-account.html` | 大账号管理对话框 | `big-account-manager.png` | 同上 |
| `Clear/big-account-dropdown.html` | 大账号管理 + 下拉展开 | `big-account-manager-dropdown.png` | 同上 |
| `Clear/balance-addon.html` | 月度余额附加项管理 | `balance-addon-manager.png` | 同上 |
| `Clear/mapping.html` | 字段映射对话框 | `mapping-dialog.png` | 同上 |
| `Clear/alert.html` | 通用 alert 弹窗（无对应 preview） | 对应 renderer-dialogs.js `createAlertDialog` | Clear 设计稿，preview 没有但有 dialog factory |
| `Clear/confirm.html` | 通用 confirm 弹窗（无对应 preview） | 对应 renderer-dialogs.js `createConfirmDialog` | 同上 |

**完全同名**（27 项）：`account-mapping` / `account-mapping-editing` / `account-mapping-migration` / `amount-split-rules` / `big-account-selection` / `big-account-selection-multi` / `bill-split-mappings` / `bill-split-rows` / `export-scope` / `extract-order` / `manual-balance-seed` / `monthly-balance-export` / `new-account` / `new-account-currency-dropdown` / `new-account-multi` / `pending-export-runs` / `pending-import-month` / `pending-panel` / `pending-panel-error` / `pending-panel-importing` / `pending-panel-initial` / `pending-reconcile` / `pending-rule-confirm` / `pending-rule-dialog` / `remember-order-mismatch` / `template-manager` / `template-rename`

**Clear 没画的 UI（D11 放宽验收，Dev 自补）**：
- "切换页面风格"下拉框（`paletteStyleSelect`）
- 风格切换提醒框（"确认从 X 切换到 Y" 二次确认框 — 复用 `createConfirmDialog`）
- alert/confirm 通用弹窗（D11：参考 `Clear/alert.html` `Clear/confirm.html` 已提供风格基线）

---

## 六、功能清单

| 编号 | 功能 | 摘要 | 阻塞 OT |
|------|------|------|---------|
| F1 | 调色板新增"切换页面风格"下拉 + "确认切换"按钮 | 调色板左上角加 `<select>` + 旁边"确认切换"按钮，下拉永远显示 "Clear"（D5）；点按钮弹提醒框（D9）| ✅ closed |
| F2 | 风格切换提醒框 | 复用 `createConfirmDialog`，点"确认切换"打开；确认 → 写 SQLite + 热切换；取消 → 下拉回滚到 "Clear" | ✅ closed |
| F3 | SQLite `app_settings` 增 `ui_style` 记录 | KV 表写 `ui_style` setting_key（不改表结构），TS 类型 enum；默认 `'Clear'` | ✅ closed |
| F4 | 升级迁移：首次启动若 `ui_style` 空 → 写 `'Clear'` | beta.1 用户升级 beta.2 后启动逻辑里检查并写默认 | ✅ closed |
| F5 | 双风格 CSS 切换机制（颗粒度 A） | 单 HTML 树（基线 Clear）+ 双 CSS 文件 + `<body data-style="clear\|general">` 切换 | ✅ closed |
| F6 | Clear 风格资产集成 | 38 个 HTML 转工程化 DOM 模板（清洗 inline style + data-cc-id，D13）+ 2 个 CSS 文件搬到 `src/`；命名差异按内容对应（D14）| ✅ closed |
| **F7（新增）** | 猫猫 GIF 跨风格保留 | `<img class="corner-gif" src="./assets/cat-meme.gif">` 单节点，CSS 各自调位置/阴影/边框（D8）| ✅ closed |

### 6.1 F1：调色板新增"切换页面风格"下拉 + 确认按钮

**位置**：调色板面板顶部新增一行，与既有 `palette-panel-body`（光谱画布）和 `palette-panel-actions`（重置/导入/完成）分开。

**DOM 设计**（基于 D5 + D9）：

```html
<section id="backgroundPalettePanel" class="palette-panel" hidden aria-label="背景设置">
  <div class="palette-panel-style-row">
    <label for="paletteStyleSelect" class="palette-style-label">切换页面风格</label>
    <select id="paletteStyleSelect" class="palette-style-select">
      <option value="Clear" selected>Clear</option>
      <option value="General">General</option>
    </select>
    <button id="paletteStyleConfirmBtn" class="palette-action solid" type="button">确认切换</button>
  </div>
  <div class="palette-panel-body">
    <!-- 既有光谱画布等 -->
  </div>
  <div class="palette-panel-actions">
    <button id="backgroundResetBtn" class="palette-action danger-text">重置</button>
    <!-- D1 取消 - 不在此处加勾选框 -->
    <div class="palette-panel-actions-right">…</div>
  </div>
</section>
```

**默认显示值**（D5 锁定）：

> 下拉**永远显示 "Clear"**（即下拉作为"切回 Clear 的入口"使用，不反映当前实际风格）。
> - 调色板每次打开（`openBackgroundPalette()`）时强制把 `paletteStyleSelect.value = 'Clear'`
> - 用户切到 General 后再次打开调色板，下拉仍显示 Clear（不显示当前实际值）
> - 这是用户明确要求的 UX：下拉不是"风格指示器"而是"切风格的入口"

**Clear 没画此下拉**（D11）：
按 `Clear/styles-gemini-extra.css` 现有 token（`--chip-bg` / `--radius-md` / `--pill` 等）自行实现样式，不要求像素级与 designer 稿一致。

### 6.2 F2：风格切换提醒框

**触发器（D9 锁定）**：用户在 `paletteStyleSelect` 改值后**必须点"确认切换"按钮**才弹提醒框。失焦/选定/合上下拉**都不触发**。

**用户原话**：「下拉框选定后点确认按钮才弹提醒框，符合"破坏性操作要二次确认"原则」。

**预设流程**（D9 + D10 锁定）：

```
1. 用户打开调色板 → paletteStyleSelect.value = 'Clear'（D5 强制）
2. 用户改 select 值（任意：Clear ↔ General） → 不触发
3. 用户点 "确认切换" 按钮 → 取 select.value 为 newStyle
4. 弹 createConfirmDialog："确认切换页面风格到 {newStyle}？切换后页面将立即生效。"
   - confirmText: "确认切换"
   - cancelText: "取消"
5a. 确认 → ipcRenderer.invoke('settings:setUiStyle', newStyle) → 写 SQLite
    → renderer 立即热切换样式（详见 §7.4）→ document.body.dataset.style 变化 → 关闭提醒框
5b. 取消 → 关闭提醒框 → paletteStyleSelect.value = 'Clear'（D10 回滚到 Clear，因 D5 永远显示 Clear，无视觉变化）
```

**热切换实现**（D10 + §7.4）：
- **不全页 reload**（避免丢调色板光谱画布等运行时状态）
- 通过修改 `document.body.dataset.style = newStyle.toLowerCase()` 触发 CSS selector 重新匹配
- 同时切换两个 `<link>` 节点的 `disabled` 属性（详见 TechDoc §四）
- 切换后 status box 提示"已切换到 {newStyle} 风格"

**Clear 没画此提醒框**（D11）：
**复用现有 `createConfirmDialog`**（`src/renderer-dialogs.js:86-103`），样式天然继承当前风格（Clear/`alert-card` 已提供基线）；不需要为切换提醒框单独画稿。

### 6.3 F3：SQLite `app_settings` 增 `ui_style` 记录

**改动范围**：**不改表结构**（`app_settings` 已有 KV 形式，`src/backend/database.js:79-83`）。

**新增 setting_key**：

| setting_key | setting_value 类型 | 取值 | 默认 |
|-------------|-------------------|------|------|
| `ui_style` | `TEXT`（已有） | `'Clear'` / `'General'`（严格匹配，其它值 fallback 到 `'Clear'`）| `'Clear'`（D4 / D5）|

**封装函数**（参考 `getBackgroundConfig` / `setBackgroundConfig` 模式）：

```js
// src/backend/database/settings-repository.js
function getUiStyle(db) {
  const raw = getSetting(db, 'ui_style');
  return raw === 'General' ? 'General' : 'Clear';  // 鲁棒性 fallback
}
function setUiStyle(db, style) {
  const safe = style === 'General' ? 'General' : 'Clear';
  setSetting(db, 'ui_style', safe);
}
```

`src/backend/database.js` facade 暴露：
```js
getUiStyle()  // 返回 'Clear' | 'General'
setUiStyle(style)
```

### 6.4 F4：升级迁移：首次启动若 `ui_style` 空 → 写 `'Clear'`

**触发位置**：`src/main.js:8837 app.whenReady()` 内 `database.init()` 之后、`createWindow()` 之前调用 `ensureUiStyleDefault(database)`。

**迁移逻辑**：

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

**特殊场景**：
- 全新安装：`current = null` → 写 `Clear`
- beta.1 升级到 beta.2：`current = null`（beta.1 没存过）→ 写 `Clear`（D4 = 是）
- 用户在 beta.2 切到 General 后又升级（未来 beta.3）：`current = 'General'` → 不动（保持用户选择）
- 用户在 beta.2 损坏了 DB（`ui_style` 值非法如 `'XYZ'`）：`getUiStyle()` 鲁棒性 fallback 为 `'Clear'`，但 DB 中仍是损坏值；下一次切换会被覆盖

### 6.5 F5：双风格 CSS 切换机制（颗粒度 A 实施）

**核心架构**（D6 + D6.1 锁定）：

```
单 HTML 入口（index.html，结构基线对齐 Clear）
  ├── <body data-style="clear|general">（启动时由 renderer 注入）
  ├── <link id="cssGeneral" rel="stylesheet" href="./src/styles.css" disabled>
  └── <link id="cssClear" rel="stylesheet" href="./src/styles-gemini.css">
       <link id="cssClearExtra" rel="stylesheet" href="./src/styles-gemini-extra.css">
```

**HTML 节点改造（基线对齐 Clear）**：renderer 对齐 Clear 的 id/class，需要改造 5 类节点（详见 §7.5）：

| 节点 | 现有（General）| Clear 设计稿 | 改造方案 |
|------|---------------|--------------|---------|
| 主标题 `.page-title` | `<h1 class="page-title">网银账单小助手</h1>`（`index.html:27`）| `<h1 class="page-title"><span class="gemini-gradient">网银账单小助手</span></h1>`（`Clear/main.html:22`）| 改为带 span 嵌套；General CSS 给 `.gemini-gradient { -webkit-background-clip: initial; -webkit-text-fill-color: var(--text); }` 让渐变在 General 下退化为纯色 |
| 模块切换 icon | `<span class="module-switcher-icon">🔁</span>`（`index.html:32`）| `<span class="module-switcher-icon"><svg>...Gemini 钻石渐变</svg></span>`（`Clear/main.html:27-29`）| 改为 SVG；General CSS `body[data-style="general"] .module-switcher-icon svg { display: none; }` + `.module-switcher-icon::before { content: "🔁"; }` |
| 模块切换 caret | 无（`index.html:31-34` 无 caret）| `<span class="module-switcher-caret">▾</span>`（`Clear/main.html:31`）| 加 caret span；General CSS hide：`body[data-style="general"] .module-switcher-caret { display: none; }` |
| 状态栏 spark | `<div id="statusBox">欢迎使用小助手</div>`（`index.html:73`）| `<div class="status-box"><span class="status-spark"><svg>...</svg></span> 欢迎使用小助手</div>`（`Clear/main.html:69-74`）| 加 status-spark span；General CSS hide |
| 猫猫 GIF（D8 关键）| `<img class="corner-gif" src="./assets/cat-meme.gif">`（`index.html:24`）| `<div class="corner-gif-slot">🐱</div>`（`Clear/main.html:19`，emoji 仅设计稿用）| **保留 `<img>` 节点**（D8），CSS 双套各自调位置/阴影/边框；不退化为 emoji |

**CSS 切换策略**（详见 TechDoc §四）：

推荐 **策略 (a)：两份 link 同时挂载，通过 `disabled` 属性切换**。
- 两份 CSS 都 link 但 `disabled=true` 的不生效
- 切换时改 disabled 属性（renderer 一行 JS）
- 优点：最快热切换、零网络延迟、保留 Electron 渲染层缓存
- 缺点：DOM 多挂一份 link 节点（可忽略）

**`data-style` 属性的作用**：
- 两份 CSS 都用 `body[data-style="..."]` 前缀写 selector，实现 CSS 层级的强制隔离（避免共用 selector 时相互影响）
- 局部条件渲染（如上表 5 类节点）通过 `body[data-style="general"] X { display: none; }` 在 CSS 实现，**不在 JS 写 if-else**

### 6.6 F6：Clear 风格资产集成

**资产清单 + 集成方式**（D2 + D13 + D14）：

| Clear/ 资产 | 集成位置 | 处理动作 |
|------------|---------|----------|
| `Clear/styles-gemini.css`（12KB，403 行）| `src/styles-gemini.css`（D2 保留 Gemini 命名）| 直接拷贝；如有项目专属文件路径（如 `./assets/cat-meme.gif`）需对齐 |
| `Clear/styles-gemini-extra.css`（36KB，1132 行）| `src/styles-gemini-extra.css` | 同上 |
| `Clear/*.html`（38 个 HTML 设计稿）| **不直接拷贝**——作为 Dev 实现 DOM 树 / dialog factory 的视觉参考 | 按 §5.1 mapping 表对应到现有 `index.html` / `src/renderer-dialogs.js` 的 createXxx 函数 |

**Clear/ HTML 集成的清洗规则（D13 锁定）**：

集成时**剥离以下设计辅助标记**：
1. **inline `style="font-weight:500"`** —— 全部移到 CSS（已在 styles-gemini-extra.css 中定义，class 已自带）
2. **`data-cc-id="cc-X"`** —— 设计工具标记，工程化集成时去除
3. **冗余 `style=""`** —— 仅保留必要的 inline style（理论上无）

集成时**保留**：
- 语义 class 名（如 `.modal-card`、`.dialog-header`、`.alert-card` 等，与 styles-gemini-extra.css 对应）
- 必要的 ARIA 属性（`aria-label`、`aria-hidden` 等）
- SVG 元素（如 `gemini-gradient` 渐变定义）

**命名错误的处理（D14 锁定）**：

按 §5.1 mapping 表落地："按内容对应"集成。例如：
- `Clear/index.html` → 按内容是 Pending 导出差异，集成到 `createPendingExportDialog` 时参考此文件
- `Clear/main.html` → 集成到 `index.html` 主界面 + `src/renderer.js` setCurrentModule 适配

**Designer 沟通**（不阻塞 Dev）：
PM 后续与 designer 沟通命名问题（如 `Clear/index.html` 应重命名为 `pending-export-runs.html`），不影响本次实施。

### 6.7 F7（新增）：猫猫 GIF 跨风格保留（D8）

**用户原话**：「两种风格都保留猫猫 GIF」。

**实现**（D8 锁定）：

```html
<!-- index.html 结构（同一节点，两风格共用） -->
<img class="corner-gif" src="./assets/cat-meme.gif" alt="gif" />
```

**CSS 双套差异**：

```css
/* src/styles.css (General) - 现有样式保留 */
.corner-gif {
  position: fixed;
  top: 56px; left: 20px;
  width: 64px; height: 64px;  /* General 风格: 大尺寸，无阴影 */
  /* ... */
}

/* src/styles-gemini.css (Clear) - 参考 Clear/styles-gemini.css:90-104 */
body[data-style="clear"] .corner-gif {
  width: 40px; height: 40px;  /* Clear 风格: 小尺寸，圆角 chip */
  border-radius: 12px;
  background: var(--chip-bg);
  box-shadow: var(--shadow-sm);
  pointer-events: none;
  z-index: 2;
  object-fit: cover;
}
```

> 注意：`Clear/styles-gemini.css:90-104` 中 `.corner-gif` 与 `.corner-gif-slot` 同样的样式适用——保留对 `.corner-gif` 的样式，并删除对 emoji 包装 `.corner-gif-slot` 的依赖。

---

## 七、详细设计

### 7.1 调色板面板布局变化（F1）

**当前**（`index.html:171-194`）：

```
┌───────────────────────────────────────┐
│  [光谱画布]                            │
│                                        │
├───────────────────────────────────────┤
│ [重置]            [导入背景文件] [完成] │
└───────────────────────────────────────┘
```

**v2.0.0-beta.2**（D1 取消勾选框，D5 + D9 锁定下拉显示永远 Clear + 确认按钮）：

```
┌────────────────────────────────────────────────┐
│ 切换页面风格 [Clear ▾]  [确认切换]               │  ← F1 新增
│                                                  │
│  [光谱画布]                                      │
│                                                  │
├────────────────────────────────────────────────┤
│ [重置]               [导入背景文件] [完成]        │
└────────────────────────────────────────────────┘
```

> "重置"右侧无新增控件（D1）；"切换页面风格"下拉 + "确认切换"按钮位于面板顶部新增 row。
> 下拉打开（每次 `openBackgroundPalette()`）时强制重置为 "Clear"（D5）。

### 7.2 切换提醒框结构（F2，复用 createConfirmDialog）

```
┌──────────────────────────────────────┐
│  切换页面风格                          │
├──────────────────────────────────────┤
│  确认切换页面风格到 {newStyle}？        │
│                                       │
│  切换后页面将立即生效（无需重启）。      │
│                                       │
│           [取消]    [确认切换]         │
└──────────────────────────────────────┘
```

实现：直接调 `createConfirmDialog({ message, confirmText: '确认切换', cancelText: '取消', onConfirm })`。

### 7.3 风格切换的运行时流程（F2 + F5 全链路）

```
1. 用户打开调色板（openBackgroundPalette()）
   → paletteStyleSelect.value = 'Clear'（D5 强制 reset）
2. 用户改 select 值（如 Clear → General）
   → 不触发任何 handler
3. 用户点"确认切换"按钮（D9）
   → 取 select.value = 'General'
   → 弹 createConfirmDialog（§7.2）
4. 用户点"确认切换"
   → ipcRenderer.invoke('settings:setUiStyle', 'General')
5. main process: settingsRepository.setUiStyle(db, 'General') → DB 写入
   → 返回 { ok: true }
6. renderer 收到成功 → 立即热切换：
   a. document.body.dataset.style = 'general'
   b. document.getElementById('cssGeneral').disabled = false;
      document.getElementById('cssClear').disabled = true;
      document.getElementById('cssClearExtra').disabled = true;
   c. (无需 reload；条件渲染节点的 CSS selector 自动重新匹配)
7. 关闭提醒框 + status box 提示"已切换到 General 风格"
8. 用户点"取消"分支：关闭提醒框 + paletteStyleSelect.value = 'Clear'（D10 回滚，无视觉变化）
```

### 7.4 启动时风格选择

```
[main] app.whenReady()
  → database.init()
  → ensureUiStyleDefault(database)        // F4：beta.1 升级写 Clear
  → ipcMain handlers 注册
  → mainWindow.loadFile('index.html')

[renderer] index.html 加载
  → 两份 link 都挂载，但 cssGeneral.disabled=true（默认）
  → renderer.js initialize()
  → const info = await desktopApi.app.getInfo()  // 含 uiStyle 字段
  → applyUiStyle(info.uiStyle)
       a. document.body.dataset.style = info.uiStyle.toLowerCase()
       b. 根据值切换两份 link 的 disabled
       c. 局部条件渲染由 CSS selector 自动适配
  → 后续既有逻辑（applyBackgroundSettings 等）
```

> 关键：CSS link 在 `<head>` 同时挂载两份，启动时按 `info.uiStyle` 切 disabled；首次加载延迟可忽略（两份 CSS 总计 ~50KB，与 `src/styles.css` 2617 行同量级）。

### 7.5 升级迁移序列图

```
[beta.1 用户] → 启动 beta.2
   |
   v
[main] app.whenReady → database.init
   |
   v
[main] ensureUiStyleDefault
   |
   ├─ getSetting('ui_style')  →  null（beta.1 没存过）
   |
   v
[main] setSetting('ui_style', 'Clear')
   |
   ├─ activity log 记录 "[v2.0.0-beta.2] 升级迁移：ui_style 默认设为 Clear"
   |
   v
[main] mainWindow.loadFile('index.html')
   |
   v
[renderer] desktopApi.app.getInfo()  →  { uiStyle: 'Clear', ... }
   |
   v
[renderer] applyUiStyle('Clear')
   → body.dataset.style = 'clear'
   → cssClear / cssClearExtra 启用，cssGeneral 禁用
```

### 7.6 5 类条件渲染节点的 CSS 实现

```css
/* src/styles.css（General）—— 重写后引入 data-style selector */
body[data-style="general"] .gemini-gradient {
  /* General: 渐变退化为单色 */
  -webkit-background-clip: initial;
  -webkit-text-fill-color: var(--text);
  background: none;
}

body[data-style="general"] .module-switcher-icon svg {
  display: none;
}
body[data-style="general"] .module-switcher-icon::before {
  content: "🔁";
  font-size: 14px;
}

body[data-style="general"] .module-switcher-caret {
  display: none;
}

body[data-style="general"] .status-spark {
  display: none;
}

/* corner-gif：General 用大尺寸 + 无阴影 */
body[data-style="general"] .corner-gif {
  width: 64px; height: 64px;
  /* 无 chip-bg / 无 shadow-sm */
}
```

```css
/* src/styles-gemini.css（Clear）—— 默认即 Clear 样式，但用 data-style 加 selector 防止 General 状态泄漏 */
body[data-style="clear"] .gemini-gradient {
  background: linear-gradient(92deg, var(--g-blue), var(--g-purple), var(--g-pink), var(--g-yellow));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
body[data-style="clear"] .corner-gif {
  width: 40px; height: 40px;
  border-radius: 12px;
  background: var(--chip-bg);
  box-shadow: var(--shadow-sm);
}
/* ... */
```

---

## 八、数据模型

### 8.1 SQLite 变更

**结论：不增加表，不增加列；仅新增 1 条 setting_key + 启动时一次性迁移逻辑。**

| 项 | 内容 |
|----|------|
| 表 | `app_settings`（已存在，无 schema 变更）|
| 新 setting_key | `ui_style` |
| value 取值 | `'Clear'` / `'General'`（字符串严格匹配）|
| 默认值 | `'Clear'`（D4 / D5）|
| 迁移逻辑 | F4 启动时检查并写默认（`ensureUiStyleDefault`，幂等）|

### 8.2 状态流转

**main process**（启动时）：
- `ensureUiStyleDefault(database)` 一次性迁移
- `getInfo` IPC handler 返回 `uiStyle` 字段（`getSetting('ui_style')` 鲁棒性 fallback 到 'Clear'）

**renderer state**：
- `state.uiStyle: 'Clear' | 'General'` —— `initialize()` 拿到 `info.uiStyle` 后写入；切换时由提醒框确认 onConfirm 写 main 后立即更新 state + body data-style

### 8.3 IPC 接口

```
'settings:getUiStyle'        → main returns 'Clear' | 'General'
'settings:setUiStyle' (style) → main writes db, returns { success: true }
```

`src/preload.js` 暴露：
```js
window.desktopApi.settings.getUiStyle()
window.desktopApi.settings.setUiStyle(style)
```

也可以扩展现有 `app:get-info` 直接返回 `uiStyle` 字段（避免启动多一次 IPC，TechDoc 决定）。

### 8.4 回滚策略

- **代码回滚**：删除 F1~F7 改动 → 回到 beta.1 单 General 风格（HTML 改造已对齐 Clear，回滚需要还原 `index.html` + `styles.css`）
- **数据回滚**：用户在 beta.2 写过 `ui_style` 后回退到 beta.1，beta.1 不读 `ui_style`，无影响（KV 表多余 key 无害）
- **极端场景**：用户 Clear 风格遇 bug → 切到 General 应一致工作（设计目标，AC 验收）→ 见 §九 风险

---

## 九、验收标准

> 本章节共 **23 条** AC（OT 全部 closed 后从 v0 的 N 条扩到 23 条）。

### 9.1 风格切换 UI AC（F1 + F2）

| AC 编号 | 验收条件 |
|---------|---------|
| AC1-1 | 调色板面板左上角显示"切换页面风格"下拉，枚举 `Clear` / `General` |
| AC1-2 | 调色板每次打开（点 🎨 按钮 / `openBackgroundPalette()`），下拉值强制显示 "Clear"（D5）|
| AC1-3 | 用户改下拉值（如 Clear → General）**不触发**任何弹框 / 网络请求 |
| AC1-4 | 用户点"确认切换"按钮 → 弹 createConfirmDialog（D9 触发器） |
| AC1-5 | 提醒框点确认 → 写 SQLite + 立即热切换 + status box 提示"已切换到 X 风格"（D10）|
| AC1-6 | 提醒框点取消 → DB 不写 + 下拉值回滚到 "Clear"（D10）|
| AC1-7 | "重置"按钮右侧**没有任何新增控件**（D1 验收口径）|

### 9.2 风格持久化 AC（F3 + F4）

| AC 编号 | 验收条件 |
|---------|---------|
| AC2-1 | 切换风格后 `app_settings.ui_style` 写入新值 |
| AC2-2 | 关闭并重启 app，新风格应保持（不回退）|
| AC2-3 | `ui_style` 仅接受 `'Clear'` / `'General'`，其他值 `getUiStyle` fallback 为 `'Clear'`（鲁棒性）|

### 9.3 升级迁移 AC（F4）

| AC 编号 | 验收条件 |
|---------|---------|
| AC3-1 | 全新安装 beta.2：`ui_style` = 'Clear'（默认 D4）+ activity log 有迁移记录 |
| AC3-2 | beta.1 用户升级到 beta.2：首次启动后 `ui_style` 自动写 'Clear' + activity log 有迁移记录（D4）|
| AC3-3 | beta.2 用户切到 General → 升级（未来 beta.3）：`ui_style` 保持 'General'，不被强制覆盖 |
| AC3-4 | DB 损坏（`ui_style` 值为 `'XYZ'`）：`getUiStyle` 返回 `'Clear'`（fallback），不影响启动 |

### 9.4 双风格 CSS 切换 AC（F5 + F6 + F7）

| AC 编号 | 验收条件 |
|---------|---------|
| AC4-1 | Clear 风格下，36 个 preview 截图 + 5 类条件渲染节点（标题 gradient / 模块 icon SVG / caret / status-spark / corner-gif）渲染结果与 `Clear/*.html` 设计稿视觉一致（D11 放宽：不要求像素级，按 token 一致即可）|
| AC4-2 | General 风格下，所有页面/对话框与 beta.1 视觉一致（5 类节点的 General 适配通过 `body[data-style="general"]` selector 工作）|
| AC4-3 | 两风格切换后所有功能（导入/导出/对账等）行为一致（仅外观差异）|
| AC4-4 | 猫猫 GIF（`.corner-gif`）在两种风格下都显示原 `<img src="./assets/cat-meme.gif">`，CSS 微调外观（D8）|
| AC4-5 | Clear 资产集成 HTML 中**不出现** inline `style="font-weight:500"` 或 `data-cc-id` 属性（D13）|

### 9.5 Preview 链路 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC5-1 | `npm run preview:all` 可加 `APP_PREVIEW_STYLE=clear|general` 环境变量产出对应风格截图 |
| AC5-2 | 默认 `npm run preview:all` 产出 Clear 风格 36 张（与 designer 稿对齐）|
| AC5-3 | `APP_PREVIEW_STYLE=general npm run preview:all` 产出 General 风格 36 张（与 beta.1 一致）|

### 9.6 切换提醒框 UX AC（D9 + D10 + D11）

| AC 编号 | 验收条件 |
|---------|---------|
| AC6-1 | 用户改 select 值后**仅在点"确认切换"按钮时**弹提醒框，失焦/合上/选定都不触发（D9）|
| AC6-2 | 提醒框样式按当前 `body[data-style]` 风格自适应（复用 createConfirmDialog，CSS 自动跟随；D11）|
| AC6-3 | 切换提醒框有取消按钮，点取消后 select.value 回到 "Clear"（D10）|

---

## 十、待澄清问题

> **全部 closed**（2026-04-27 用户锁定）。新出现的疑点见 §十 末尾"PM v1 起草过程发现"。

| OT | 内容 | 状态 | 最终决策 |
|----|------|------|---------|
| OT-1 | "切换页面风格"下拉的触发提醒框时机 | ✅ closed | **D9**：选定后**点确认按钮才弹** |
| OT-2 | 提醒框点取消时下拉是否回滚 + D5 含义 | ✅ closed | **D5 + D10**：下拉**永远显示 "Clear"**；取消回滚到 "Clear"（无视觉变化）|
| OT-3 | Clear/ 设计稿没有"切换页面风格"下拉 + alert/confirm 通用稿 | ✅ closed | **D11**：放宽验收，按 token 自补 UI；切换提醒框复用 `createConfirmDialog` |
| OT-4 | `package.json.version` 何时 bump | ✅ closed | **D12**：spec 锁定后第一次 commit 时 bump |
| OT-5 | 颗粒度 B 双套结构的实现路径 | ✅ closed（**降级**）| **D6 + D6.1**：从 B 降为 **A（仅切 CSS + 局部条件渲染）**；HTML 基线对齐 Clear |
| OT-6 | Clear/ HTML inline style + data-cc-id 处理 | ✅ closed | **D13**：清洗 inline style + data-cc-id |
| OT-7 | `Clear/index.html` 等命名错误 | ✅ closed | **D14**：按内容对应（不按文件名）；mapping 表见 §5.1 |

> **PM v1 起草过程发现的新疑点**：**无**。

---

## 十一、风险

### 11.1 重要风险（高亮）

| 编号 | 风险 | 等级 | 缓解 |
|------|------|------|------|
| **R-1** | **HTML 结构改造（基线对齐 Clear）会破坏现有 General 视觉**：`src/styles.css` 的 selector 多数会失效（如旧版 `.module-switcher-trigger > span` 因新增 caret/icon SVG 节点而错位） | ⚠️ Critical | 阶段 2 全量重写 `src/styles.css` selector 加 `body[data-style="general"]` 前缀 + `npm run preview:all APP_PREVIEW_STYLE=general` 与 beta.1 截图逐张对比 |
| **R-2** | **热切换样式风险**（D10）：通过 `link.disabled` 切换 vs reload 整页 vs 替换 link href —— 选错会丢运行时状态 / 渲染抖动 | ⚠️ Important | TechDoc §四 选定 (a) 双 link + disabled 方案；阶段 4 PoC 验证无抖动 |
| **R-3** | **颗粒度 A 工作量降但仍要警觉**：从 B 的"38×2 = 76 套"降到 A 的"1 套 HTML + 2 套 CSS"，但条件渲染 5 类节点 + dialog factory 也需要双套 selector 适配 | ⚠️ Important | 阶段 5 dialog factory 逐个适配；按 §5.1 mapping 表 review |
| **R-4** | **升级迁移可回滚性**：用户从 Clear 切回 General 必须功能等价（zero-regression）| ⚠️ Important | AC4-2 验收 General 风格不退化；PR 集成前跑 `APP_PREVIEW_STYLE=general` smoke + preview 全量 |
| **R-5** | **Preview 链路双跑**：36 → 72 张截图，每次前端改动需双倍跑 | Important | 复用 `package.json:scripts.preview:all` 模式；preview 脚本支持 `APP_PREVIEW_STYLE` 环境变量切换；CI/Dev 默认只跑当前风格，PR 前跑双倍 |
| **R-6** | **数据丢失风险（升级迁移）**：F4 写默认值不会冲刷已有值，但需验证"覆盖逻辑只在 null/empty 时触发" | Minor | F4 实现里严格判 `current == null \|\| current === ''`；测试覆盖 AC3-3 |
| **R-7** | **Clear/ 资产清洗不彻底**：`Clear/index.html` 等设计稿满地 inline `style="font-weight:500"` + `data-cc-id`，集成时漏清会污染线上 | Minor | D13 + AC4-5 lint 检查；Dev 集成前过 grep `data-cc-id` / `font-weight:500` 都不应出现 |

### 11.2 资金/敏感数据无影响

本次需求**不涉及资金、订单、库存、权限、状态机、迁移敏感数据**——纯 UI 风格切换，无业务逻辑变更。

---

## 十二、实施计划

> 阶段拆分原则：每个阶段产出可独立验证证据（smoke / preview / 手动测试），按 D6 = A 方案重写。

### 12.1 阶段 1：数据底座 + 版本号 bump（D12）

**任务**：F3 + F4 + 三件套同步 + scan:vars

| 序号 | 任务 | 涉及文件 | 验证方式 |
|------|------|---------|---------|
| 1 | `settings-repository.js` 加 `getUiStyle / setUiStyle` 包装 | `src/backend/database/settings-repository.js` | 单测：写入 / 读出 / 默认值 |
| 2 | `database.js` facade 暴露 `getUiStyle / setUiStyle` | `src/backend/database.js` | 同上 |
| 3 | `main.js` 注册 IPC `settings:getUiStyle` `settings:setUiStyle`（也可扩 `app:get-info` 返回 `uiStyle`）| `src/main.js` | smoke + 手动 ipc 验证 |
| 4 | `preload.js` 暴露 `desktopApi.settings.getUiStyle / setUiStyle` | `src/preload.js` | renderer console 调用验证 |
| 5 | `main.js` 启动时调 `ensureUiStyleDefault`（F4 升级迁移）| `src/main.js`（位置：`app.whenReady` 内 `database.init()` 后）| 测试场景：模拟 beta.1 用户 db 启动 |
| 6 | **bump `package.json.version` 2.0.0-beta.1 → 2.0.0-beta.2**（D12 触发点）| `package.json` | 启动 app 看版本号显示 |
| 7 | 三件套同步：CHANGELOG + VERSION_FEATURE_HISTORY + USER_GUIDE | 三个 .md | diff 过 |
| 8 | `npm run scan:vars` + `/check-vars` 关联功能 review | `docs/analysis/var-reference-stats.{md,json}` | scan 报告无新 A-share 漏网 |

**产出**：阶段 1 完成后，可手动通过 console 测试 `setUiStyle('Clear')` `getUiStyle()` 链路；不影响任何现有功能（CSS / HTML 未动）。

**Commit 粒度**：1 commit `[v2.0.0-beta.2] feat(settings): 新增 ui_style + 升级迁移 + 版本号 bump`

### 12.2 阶段 2：HTML 结构对齐 Clear

**任务**：F5 + F6 的 HTML 部分 + F7 猫猫 GIF（D8）

**核心改动**：把 `index.html` 重构为对齐 `Clear/main.html` 的结构。

| 序号 | 任务 | 涉及文件 | 验证方式 |
|------|------|---------|---------|
| 1 | 主标题加 `<span class="gemini-gradient">网银账单小助手</span>` 嵌套 | `index.html:27` | DOM diff |
| 2 | 模块切换 icon 改 `<svg>` Gemini 钻石（保留 emoji 作为 General 后备）+ 加 `<span class="module-switcher-caret">▾</span>` | `index.html:30-39` | DOM diff |
| 3 | 状态栏加 `<span class="status-spark"><svg>...</svg></span>` 包装 | `index.html:73`（含 `#newAccountStatusBox` `#pendingStatusBox` 等同步加）| DOM diff |
| 4 | 猫猫 GIF 保持 `<img class="corner-gif" src="./assets/cat-meme.gif">`（**不**退化为 emoji，D8）| `index.html:24` | 视觉确认两风格都有猫 |
| 5 | `<body data-style="clear">` 默认属性（renderer initialize 后会覆盖）| `index.html:13` | DOM diff |
| 6 | `select` 外包 `<div class="select-shell">`（如适用）| `index.html:49` 等 | Clear 视觉验收 |

**风险（最高阶段）**：所有现有 General 风格 selector 失效，需要阶段 3 同步重写 CSS。

**Commit 粒度**：1 commit `[v2.0.0-beta.2] refactor(html): index.html 基线对齐 Clear 结构`

### 12.3 阶段 3：双风格 CSS 切换机制

**任务**：F5 的 CSS 部分 + F7 CSS 双套

> **D15 简化**：原任务 3 / 4 "全量加 body[data-style] 前缀"已废弃，降级为"styles.css 末尾追加退化规则"。详见 §三 D15。

| 序号 | 任务 | 涉及文件 | 验证方式 |
|------|------|---------|---------|
| 1 | 拷贝 Clear/styles-gemini.css → src/styles-gemini.css（**不**加前缀，直接用）| 新文件 | 文件存在 |
| 2 | 拷贝 Clear/styles-gemini-extra.css → src/styles-gemini-extra.css（同上）| 新文件 | 文件存在 |
| 3 | **styles.css 末尾追加 5-10 条 General 退化规则**（D15 取代原"全量加前缀"）：`.gemini-gradient` 渐变 reset / `.status-spark { display:none }` / `.module-switcher-caret { display:none }` / `.module-switcher-icon svg { display:none }` + `::before content:"🔁"` / `.select-shell { display:contents }` | `src/styles.css` | preview:main-page (general) 与 beta.1 视觉无明显差异 |
| 4 | ~~styles-gemini.css 加前缀~~ —— **D15 废弃**，不需要 | — | — |
| 5 | index.html `<head>` 双 link 挂载（cssGeneral 默认 disabled，cssClear / cssClearExtra 默认启用）| `index.html:11` | DOM 检查 |
| 6 | renderer.js initialize 拿到 info.uiStyle 后调用 applyUiStyle()：切 dataset + 切 3 link.disabled | `src/renderer.js`（新增 applyUiStyle）| 手动测试 |

**Commit 粒度**：1 commit（D15 简化后单步可完成）

### 12.4 阶段 4：UI 切换器 + 提醒框（F1 + F2）

**任务**：F1 调色板下拉 + 确认按钮 + F2 提醒框

| 序号 | 任务 | 涉及文件 | 验证方式 |
|------|------|---------|---------|
| 1 | 调色板新增 `<div class="palette-panel-style-row">` 含下拉 + 确认按钮 | `index.html:171-194` | DOM diff |
| 2 | renderer 绑定按钮点击 → 取下拉值 → 调 createConfirmDialog | `src/renderer.js`（新增 handlePaletteStyleConfirm）| 手动 |
| 3 | onConfirm: 调 ipc setUiStyle + 切 body dataset.style + 切 link.disabled | `src/renderer.js`（同上） | 手动 + DB 检查 |
| 4 | onCancel: select.value = 'Clear'（D10 回滚） | 同上 | 手动 |
| 5 | openBackgroundPalette() 强制 reset select.value = 'Clear'（D5）| `src/renderer.js:1402-1409` | 手动 |
| 6 | 给 palette-panel-style-row + palette-style-select + 确认按钮 写两风格 CSS（D11 自补） | `src/styles.css` + `src/styles-gemini-extra.css` | preview:statement-palette 双风格 |

**Commit 粒度**：1 commit

### 12.5 阶段 5：dialog factory 双套适配（按 §5.1 mapping）

**任务**：F6 的 dialog factory 部分 + Clear 资产清洗（D13）

| 序号 | 任务 | 涉及文件 | 验证方式 |
|------|------|---------|---------|
| 1 | createPendingExportDialog 对齐 Clear/index.html 结构 | `src/renderer-dialogs.js`（pendingExport-runs 部分）| preview:pending-export-runs 双风格 |
| 2 | 大账号管理对齐 Clear/big-account.html | 同上 | preview:big-account-manager 双风格 |
| 3 | 字段映射对齐 Clear/mapping.html | 同上 | preview:mapping-dialog 双风格 |
| 4 | createAlertDialog / createConfirmDialog 对齐 Clear/alert.html / confirm.html | `src/renderer-dialogs.js:67-103` | 手动 + visual diff |
| 5 | 其它 dialog 按 §5.1 mapping 逐个适配 | `src/renderer-dialogs.js` | preview 全量 |
| 6 | lint 检查：grep `font-weight:500` `data-cc-id` 都应为 0（D13 验收 AC4-5）| 全量 .js / .html | grep |

**Commit 粒度**：可分 3~5 commits（按 dialog 分组）

### 12.6 阶段 6：preview 适配 + 验证

**任务**：preview 脚本支持 `--style` 参数 + 重渲所有截图

| 序号 | 任务 | 涉及文件 | 验证方式 |
|------|------|---------|---------|
| 1 | `scripts/render-modal-preview.js` 支持 `APP_PREVIEW_STYLE` env（默认 clear）| `scripts/render-modal-preview.js` | 命令行测试 |
| 2 | 同样改 `scripts/render-preview.js` `render-account-mapping-preview.js` `render-template-manager-preview.js` | 全部 4 个 render 脚本 | 同上 |
| 3 | preview 启动时通过 main.js 读 env `APP_PREVIEW_STYLE` 强制设置 ui_style | `src/main.js`（preview 模式分支）| preview 截图风格正确 |
| 4 | `npm run preview:all`（默认 Clear）跑出 36 张 | `docs/previews/*.png` | 视觉验收 |
| 5 | `APP_PREVIEW_STYLE=general npm run preview:all` 跑出 General 36 张（保存到独立目录或 _general 后缀） | 同上 | 与 beta.1 对比 |
| 6 | smoke 双风格各跑一次 | `npm run smoke` | 不破 |

**Commit 粒度**：2 commits（脚本扩展 + preview 重渲）

---

## 十三、手动测试清单

### 13.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| P0-1 全新安装首次启动 | 首次启动 beta.2 | userData 无 ui_style | 自动加载 Clear 风格；DB ui_style='Clear'；activity log 有迁移记录 |
| P0-2 beta.1 升级到 beta.2 | 升级 + 启动 | userData 有 beta.1 数据但无 ui_style | 自动写 ui_style='Clear'；加载 Clear 风格 |
| P0-3 调色板打开下拉值固定 Clear | 任意状态打开调色板（点 🎨）| 当前 ui_style=General | 下拉值显示 "Clear"（D5）|
| P0-4 切换 Clear → General | 调色板 → 选 General → 点确认按钮 → 提醒框确认 | 当前 ui_style=Clear | 弹提醒框 → 确认 → 立即切换（不 reload）→ DB ui_style='General' → 加载 General 风格 |
| P0-5 切换 General → Clear | 反向 | 当前 ui_style=General | 同上反向 |
| P0-6 切换提醒框取消（D10 回滚）| 改下拉 → 点确认按钮 → 提醒框点取消 | — | DB 不写 + 下拉值回到 "Clear" |
| P0-7 改下拉但不点确认按钮 | 选 General 但不点确认 → 关闭调色板 | — | DB 不写；再次打开调色板下拉显示 "Clear"（D5）|
| P0-8 关闭重启风格保持 | P0-4 后关闭 app → 重启 | DB ui_style='General' | 启动加载 General 风格 |
| P0-9 双风格功能等价（导入文件） | Clear 下导入 → 切 General → 导入相同文件 | 两风格下导入相同 .xlsx | 导入成功率/结果一致 |
| P0-10 猫猫 GIF 跨风格 | 切两种风格 | — | 两种风格都显示 cat-meme.gif（D8）|

### 13.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| P1-1 双风格 preview 截图 36×2 | `npm run preview:all` Clear + General | — | 各 36 张全过；Clear 与 designer 稿视觉一致；General 与 beta.1 一致 |
| P1-2 所有对话框双风格点开 | 大账号管理 / 字段映射 / 模板管理 / 余额附加项 / Pending 全套 | — | 双风格视觉无错位 |
| P1-3 所有按钮双风格点击 | 主界面所有按钮 | — | hover / disabled 状态在两风格下一致 |
| P1-4 DB 损坏 fallback | 手动写 `ui_style='XYZ'` 启动 | — | 启动加载 Clear（fallback）|
| P1-5 局部条件渲染节点 | 标题 gradient / 模块 icon / caret / status-spark / corner-gif | 两风格各开一次 | General 风格下 5 类节点退化为简单形态；Clear 风格下显示 SVG/渐变 |

### 13.3 不测项与原因

- 风格切换性能（热切换 < 100ms，无需测）
- 风格切换动画（明确不做）
- 自定义风格（明确不做）

---

## 十四、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | beta.1 用户升级 beta.2 后所有现有功能零退化（升级路径必须工作）|
| 性能 | 风格切换热切换 < 200ms（不 reload）；启动时双 link 加载延迟 < 50ms |
| 鲁棒性 | DB ui_style 损坏（值非 Clear/General）→ 自动 fallback 到 Clear |
| 可观测 | 升级迁移日志写 `app_activity_log.txt`（"[v2.0.0-beta.2] 升级迁移：ui_style 默认设为 Clear"）|
| 工程约束 | **每次前端改动必须同步双套 CSS 维护**（写入 `rules/coding-style.md` 或 `CLAUDE.md`）|
| Preview 链路 | `APP_PREVIEW_STYLE=clear|general npm run preview:all` 命令产出对应风格 36 张截图 |
| 资产清洗 | Clear 集成 HTML 中**不出现** inline `style="font-weight:500"` 或 `data-cc-id`（D13）|

---

## 十五、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-04-27 | v0 初稿（PM 起草，OT-1 ~ OT-7 待用户回复）|
| 2026-04-27 | **v1 定稿**：用户锁定 OT-1 ~ OT-7 全部 closed + 新增 D8 ~ D14；颗粒度从 B 降为 A；§五 / §六 / §七 / §九 全部细化；新增 F7 猫猫 GIF；§九 实施计划重写为 6 阶段（基于 A 方案）；AC 从 v0 的 N 条扩到 23 条 |

---

## 十六、实施记录

> 由 PR merged + 归档后自动追加，PM 不需要手动填写。
