---
pr: 47
version: v2.1.4
branch: v2.1.4
base: main
status: open
integrated: false
created: 2026-05-14
---

# PR #47 — [v2.1.4] feat: 工具栏 emoji 化 + 模块收纳弹窗 + ReconID 账单类别默认 gateway

## Summary

v2.1.3 之后追加 patch 迭代，4 块 UI/UX 改动 + 顺手修 v2.1.2/v2.1.3 遗留 bug。OPEN ISSUES 7 项（O1-O7）+ V1 版本号格式全部拍板（PRD §五）。

### 四块主要改动

| # | 改动 | 文件影响 |
|---|---|---|
| T1 | 使用手册按钮换皮，文字按钮 → 圆形 emoji 📕（与 🎨 统一） | `index.html` 一行 |
| T2 | USER_GUIDE 版本号 v2.1.1 → v2.1.4 + §一 模块列表补 7 业务OP数据核对（v2.1.3 漏更新）+ §1.8 新增「主界面工具栏与模块收纳」+ §1.5 末追加 v2.1.4 默认 gateway 说明 | `docs/USER_GUIDE.md` |
| T3 | 新增 🔄 小助手功能收纳弹窗（双区域 + 完成/取消 两阶段提交 + ➡️/⬅️ 移动 + HTML5 拖拽排序 + 视觉宽度排序）；落库 `app_settings.enabled_modules` | ~10 文件 |
| T4 | 对账单 ReconID 修复账单类别默认 gateway（删占位项 + 历史空值 DB 写回） | `index.html` + `src/renderer.js` |

### Fix1（用户验收后反馈 5 点 / O6 撤回）

| Fix | 改动 |
|---|---|
| F1.1 | 弹窗双区域左右内缩 28px 对齐标题 + 高度 -32px |
| F1.2 | **撤回 O6 "即时落库"**，改为「完成/取消」两阶段提交（取消还原到打开前） |
| F1.3 | ➡️/⬅️ 上移到与第一行 item 顶部平行 |
| F1.4 | 再次点击同一选中行 → 取消选中（toggle） |
| F1.5 | 闲置区排序改为视觉宽度（CJK×2 + 其他×1）— "月度银行对账单BU回填校验"(24) 现在排在 "月度 Pending 数据核对"(21) 之后 |

### ⚠️ 顺手修 v2.1.2/v2.1.3 遗留 bug

**`CURRENT_MODULE_VALID` 枚举漏更新**：在 v2.1.0-beta.1 写定后只列 5 个模块 ID。v2.1.2 新增 `bank-bu-recon` + v2.1.3 新增 `biz-op-recon` 时只动了 renderer 端 `MODULES` 常量，没同步 backend 校验枚举 → 用户切到这两个模块时 `setCurrentModule` 会抛 `Invalid current_module`。

本次提炼 `ALL_MODULE_IDS` 全集（7 个 ID），让 `CURRENT_MODULE_VALID` 与 `setEnabledModules` 校验共用。

**附带文档遗漏**：USER_GUIDE 顶部"版本：v2.1.1"字段在 v2.1.2/v2.1.3 dev 时漏刷；§一 模块清单在 v2.1.3 漏补第 7 个"业务OP数据核对"。本次一并修订。

---

## 新增内容

### 用户可见

- 主页面右下角新增 🔄「小助手功能收纳」按钮（紧贴 📕）
- 「使用手册」从文字按钮 → 圆形 emoji 📕（与左侧 🎨 统一视觉）
- 进入「对账单ReconID修复」模块 → 主面板「账单类别」默认显示「网关对账单」（不再需要先选）
- 左上角模块切换菜单默认只展示 3 个（网银账单生成 / 银行对账单处理 / 对账单ReconID修复），用户通过 🔄 弹窗自定义启用模块及顺序

### 内部

- **新增 IPC（2 个 plain handler）**：
  - `settings:get-enabled-modules` — 启动时拉取启用列表（首次自动 seed 默认值）
  - `settings:set-enabled-modules` — 模块收纳弹窗「完成」按钮一次性落库
  - `window.desktopApi.settings.getEnabledModules` / `setEnabledModules` 暴露
- **app:get-info 扩展**：返回新增 `enabledModules` 字段（renderer 启动一次性拉到，省一个 IPC round-trip）
- **新增 settings repo 函数**：`getEnabledModules(db)` / `setEnabledModules(db, list)` + `ALL_MODULE_IDS` / `DEFAULT_ENABLED_MODULES` 常量
- **renderer.js 启动 fallback**：若持久化 `current_module` 不在 `enabled_modules` 启用列表中，自动切到启用列表第 1 个 + 写回 DB
- **顶部模块切换菜单**：从 `index.html` 静态 7 个 button 改为运行时动态渲染（`renderTopModuleSwitcher`）+ event delegation 一次绑定
- **新增弹窗工厂**：`createModuleCabinetDialog` in `src/renderer-dialogs.js`（含 `visualLength` helper）
- **新增 preview**：`preview:module-cabinet` script + `applyModuleCabinetPreviewState` + 串入 `preview:all` 链

---

## ⚠️ 关联功能 review（check-vars 报告）

本次改动触及以下重要变量，已对照 `rules/important-variables.md` 自查：

- **Critical 命中**：0
- **Important-skeleton 命中 2**：`settingsRepository` / `ipcRenderer` — 均已对齐
- **Runtime-state 命中 3**：`state` / `elements` / `MODULES`+`setCurrentModule` — 均已对齐
- **Risk-sensitive 命中**：0

**`rules/important-variables.md` v5 → v6 升格 2 条 Important-skeleton**：
- `enabled_modules` 全链路（跨 ≥ 5 文件：main.js / preload.js / database.js / settings-repository.js / renderer.js / renderer-dialogs.js / renderer-previews.js）
- `ALL_MODULE_IDS`（settings-repository.js 7 模块全集 anchor，被 `CURRENT_MODULE_VALID` + `setEnabledModules` 共用）

---

## 影响范围

### 文件改动清单（22 项 + 4 项新文件）

| 文件 | 改动 |
|---|---|
| `index.html` | 📕 换皮 + 🔄 按钮新增 + select 默认 gateway + 静态 module-option 删除 |
| `package.json` | 版本 2.1.3 → 2.1.4 + `preview:module-cabinet` script + `preview:all` 链 |
| `src/main.js` | 2 个 IPC handler + `app:get-info` 加 enabledModules |
| `src/preload.js` | settings 块加 `getEnabledModules` / `setEnabledModules` |
| `src/backend/database.js` | facade `getEnabledModules` / `setEnabledModules` |
| `src/backend/database/settings-repository.js` | `ALL_MODULE_IDS` / `DEFAULT_ENABLED_MODULES` / `getEnabledModules` / `setEnabledModules` + 修 `CURRENT_MODULE_VALID` |
| `src/renderer.js` | state.enabledModules + renderTopModuleSwitcher + startup fallback + event delegation + ReconID 默认 gateway |
| `src/renderer-dialogs.js` | `createModuleCabinetDialog` 工厂（含 visualLength + 完成/取消 两阶段 + toggle 选中） |
| `src/renderer-previews.js` | `applyModuleCabinetPreviewState` |
| `src/styles-gemini-extra.css` | `.module-cabinet-*` 样式（Clear theme 主） |
| `src/styles.css` | General theme 备用样式 |
| `Clear/styles-gemini-extra.css` | 独立 preview HTML 备用样式 |
| `docs/USER_GUIDE.md` | 顶部版本号 v2.1.1 → v2.1.4 + §一 补第 7 模块 + §1.5 末追加 + §1.8 新增 |
| `CHANGELOG.md` / `docs/VERSION_FEATURE_HISTORY.md` | v2.1.4 段（新增 / 变更 / 修复 / 内部 / Fix1 修订小节） |
| `rules/important-variables.md` | v5 → v6 升格 2 条 |
| `docs/analysis/var-reference-stats.{md,json}` | `npm run scan:vars` 重生成 |
| `docs/previews/main-page.png` / `module-switcher-open.png` | 重跑 |
| **新文件** | `docs/iterations/v2.1.4/{PRD,spec,tasks}.md` + `docs/previews/module-cabinet.png` |

### 不在本次范围

- 不动现有 7 个模块的内部对账逻辑 / 算法 / smoke case
- 不动 saveUserGuideBtn 的 click handler（仅外观换皮）
- 不动 v1.5.x / v2.0.0 / v3.0.0 等其他分支

---

## Test plan

### 自动测试

- [x] `npm run smoke` — 全绿（含 `bank-bu-recon 41/41` + `biz-op-recon 154/154`，197+ case）
- [x] `npm run preview` — 主页 visual 通过（🎨/📕/🔄 三圆形按钮）
- [x] `npm run preview:module-cabinet` — 弹窗 visual 通过（Fix1 五点）
- [x] `npm run preview:module-switcher-open` — 左上角菜单只显示 3 个启用模块
- [x] `npm run scan:vars` — 76 files / 761 top-level / A-share 137
- [x] `/check-vars` — Critical 0 / Important 2 已对齐 / Runtime-state 3 已对齐 / Risk-sensitive 0

### 手动验证（用户已验收）

- [x] 默认启动 → 左上角菜单显示 3 个模块，切换正常
- [x] 进对账单ReconID修复 → 主面板"账单类别"默认显示「网关对账单」，按钮可用
- [x] 点 📕 → 触发 USER_GUIDE.md 导出（行为不变）
- [x] 点 🔄 → 弹"小助手功能收纳"弹窗
- [x] 选闲置某项 + ➡️ → 该项移到启用区末尾（弹窗内）
- [x] 选启用某项 + ⬅️ → 移到闲置区（弹窗内）
- [x] 拖拽启用区某项 → 顺序变更（弹窗内）
- [x] 点击同一行 2 次 → 取消选中（Fix1.4）
- [x] 点「完成」→ 落库 + 关弹窗 + 左上角菜单同步刷新
- [x] 点「取消」/× / overlay 外部 → 还原到打开前（Fix1.2）
- [x] 启用区只剩 1 → ⬅️ disabled（O3）
- [x] 把当前激活模块 ⬅️ 到闲置 + 完成 → 自动切到启用区第 1 个（O4）
- [x] 闲置区排序：业务OP / 新开 / **Pending** / **BU 校验**（Fix1.5）

### PR-CI 必跑

- [ ] CI 上 smoke 通过
- [ ] preview:all 全部生成（无新 preview 漏跑）

---

## OPEN ISSUES 拍板记录（详见 PRD §五）

| # | 议题 | 拍板 |
|---|---|---|
| O1 | 闲置区从启用区收回时排序方式 | A=按视觉宽度重排（Fix1.5 调整为视觉宽度） |
| O2 | DB `recon_id_fix_bill_category` 空值时启动写回 'gateway' | A=写回 |
| O3 | 启用区是否允许减到 0 | A=禁止，至少 1 个 |
| O4 | 当前激活模块被移到闲置时 | A=自动切到启用区第 1 个 |
| O5 | 拖拽手柄视觉 | A=⋮⋮ |
| ~~O6~~ | ~~弹窗"取消/确认"按钮~~ | **Fix1.2 撤回** → 改为完成/取消 两阶段提交 |
| O7 | 🔄 按钮 tooltip 文案 | A="小助手功能收纳" |
| V1 | v2.1.4 版本号格式 | 直接 2.1.4（无 beta） |

---

## 风险提醒（⚠️ 人工复核要点）

- ⚠️ **状态机改动**：左上角模块切换菜单由 `state.enabledModules` 驱动；启动 fallback `current_module` 不在启用列表 → 自动切第 1 个 + 写回 DB
- ⚠️ **数据迁移**：首次启动 `app_settings.enabled_modules` 自动 seed 默认 3 个模块；幂等
- ⚠️ **`CURRENT_MODULE_VALID` 修复**：纯收紧 → 放松的修改（5 模块 → 7 模块），不会引入新 break
- ⚠️ **撤回 O6 拍板**：v0.1 设计的"即时落库"v0.2 改为"完成/取消"两阶段提交（Fix1.2）

---

## 关联文档

- `docs/iterations/v2.1.4/PRD-v2.1.4.md` — 产品需求文档（含 Fix1 修订记录）
- `docs/iterations/v2.1.4/spec.md` — 技术规格
- `docs/iterations/v2.1.4/tasks.md` — 任务拆分
- `rules/important-variables.md` — v5 → v6 升格记录

---

## Reviewer 复核重点

1. **Fix1.2 撤回 O6 是否合适**：v0.1 即时落库与 v0.2 完成/取消 两种模式的交互对比；当前选「完成/取消」与现有项目其他弹窗（如 v2.1.2 BU 月份选择 / v2.1.3 业务OP 导出对话框）保持一致
2. **`ALL_MODULE_IDS` 升格 Important-skeleton 是否过度**：单文件定义但跨多处校验共用（与 BIZ_OP_HEADERS / FLOW_HEADERS 同性质）
3. **`enabled_modules` JSON 数组持久化方案是否需要 schema 演进策略**：当前 sanitize 已处理"非法 ID + 解析失败 + 空数组"三种异常，回退默认值
4. **拖拽视觉反馈是否够清晰**：HTML5 原生 draggable + `is-dragging` 透明度 + `is-drag-over` 顶部蓝线
