# PRD — v2.1.4 迭代：主页面工具栏微调 + 模块收纳 + ReconID 账单类别默认值

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（2026-05-14 起草） |
| 目标版本 | `v2.1.4`（patch） |
| 起始版本 | `v2.1.3`（PR #46 已合并 main，2026-05-14，merge commit `e4c3abe`） |
| 起草日期 | 2026-05-14 |
| 起草人 | team-lead（PM 角色） |
| 状态 | 起草中，等待用户拍板 |
| 关联文档 | `spec.md` / `tasks.md`（同目录） |
| 涉及模块 | 主页面工具栏（背景调色 + 使用手册按钮区）、左上角模块切换、对账单ReconID修复主面板 |
| 工作分支 | `v2.1.4`（基于 main `e4c3abe` 切出，PR 向 `v2.1.4 → main`） |
| 依赖 | v2.1.3（含 7 个主模块的完整骨架） |

---

## 一、需求概述

v2.1.4 包含 4 块独立改动：

1. **T1 — 使用手册按钮换皮**：把右下角「使用手册」文字按钮（`#saveUserGuideBtn`）改成圆形 emoji 按钮 📕，样式与左侧 🎨 按钮（`#backgroundPaletteBtn`）一致。点击行为/导出 USER_GUIDE.md 流程不变。
2. **T2 — 使用手册版本号刷到 v2.1.4 + 补 v2.1.4 新功能段**：当前 `docs/USER_GUIDE.md` 顶部「版本：v2.1.1」字段滞后（v2.1.2/v2.1.3 写了内容但没刷顶部版本号）；本次刷到 v2.1.4，并新增「主界面工具栏与模块收纳（v2.1.4 新增）」一节，介绍 🎨/📕/🔄 三按钮 + 收纳弹窗 + ReconID 默认 gateway 行为变化。
3. **T3 — 新增「小助手功能收纳」弹窗（📕 右侧 🔄 按钮）**：用户可调整主页面左上角模块切换按钮里展示哪些模块、按什么顺序展示。双区域（闲置/启用）+ ➡️/⬅️ 移动 + 启用区拖拽排序 + 落库到 SQLite。
4. **T4 — 对账单ReconID修复账单类别默认值改为「网关对账单」**：删除主面板「账单类别」下拉的占位项 `请选择账单类别`，默认选中 `网关对账单`（gateway）。

---

## 二、背景与目标

### 2.1 业务背景

- **背景 T1/T2**：当前「使用手册」按钮是文字按钮，与左侧圆形 🎨 emoji 按钮视觉不统一。同时 USER_GUIDE 顶部「版本：v2.1.1」字段是 v2.1.1 写完后没人维护遗留下来的（v2.1.2/v2.1.3 内容已补到正文，但版本号字段没刷），本次必须把版本号同步到 v2.1.4 + 补 v2.1.4 自身的新功能段。
- **背景 T3**：v2.1.3 起项目已有 7 个模块（网银账单生成、新开账户余额账单生成、月度 Pending 数据核对、银行对账单处理、对账单ReconID修复、月度银行对账单BU回填校验、业务OP数据核对）。左上角模块切换按钮固定展示所有 7 个，但实际不同用户/不同业务场景下只会用其中几个，且常用模块的展示顺序也因人而异。需要让用户自己收纳。
- **背景 T4**：v2.1.0-beta.3 引入「账单类别」下拉时按"必选不默认"设计，主面板进来要先选才能用。实际用户 95% 以上场景是网关对账单（gateway），先选这步成了无谓的多余动作。

### 2.2 用户价值

| 维度 | 改善 |
|---|---|
| 视觉统一 | 工具栏右下角两个按钮都改成圆形 emoji 风格 |
| 模块定制 | 用户可隐藏不用的模块、把常用模块拖到前面，减少切换噪声 |
| 默认值优化 | 95% 高频场景免去"选一下账单类别"这一步 |

### 2.3 目标（必做 / 不做对照）

| 必做 | 不做 |
|---|---|
| ✅ T1：使用手册按钮改成圆形 emoji 📕，复用 🎨 按钮的 CSS 类（圆形 + emoji 居中） | ❌ 不动 saveUserGuideBtn 的 click handler（导出 USER_GUIDE.md 的逻辑不变） |
| ✅ T2：`docs/USER_GUIDE.md` 顶部版本号 `v2.1.1` → `v2.1.4` + 新增「主界面工具栏与模块收纳（v2.1.4 新增）」段 | ❌ 不重写 v2.1.2/v2.1.3 既有章节（仅补 v2.1.4 增量 + 在 §1.5 末追加"v2.1.4 起账单类别默认网关对账单"一句） |
| ✅ T3：新增 🔄 按钮（📕 右侧），样式与 🎨/📕 一致；弹窗双区域 + 移动 + 拖拽 + 落库 | ❌ 不引入新依赖（不用 SortableJS，原生 HTML5 drag/drop） |
| ✅ T3：启用区行内拖拽排序，松手即落库（不需要"保存"按钮二次确认） | ❌ 不引入"恢复默认"按钮（用户可手动调回，避免误触清空收纳） |
| ✅ T3：落库到 `app_settings` 表，`setting_key = 'enabled_modules'`，`setting_value = JSON.stringify(['statement-generator','bank-statement-process','recon-id-fix'])` | ❌ 不新建 module_visibility 表（杀鸡用牛刀） |
| ✅ T3：首次启动（DB 无该 key 时）默认值 = 启用 3 个 + 闲置 4 个，按规则排序 | ❌ 不在主面板加任何"快速收纳"入口（仅通过 🔄 进入） |
| ✅ T4：删除 `<option value="">请选择账单类别</option>`，默认选中 gateway | ❌ 不改 business/gateway 两个子模式的内部逻辑 |

---

## 三、需求详述

### 3.1 T1 — 使用手册按钮换皮 📕

**当前现状**（`index.html:329-340`）：

```html
<button id="backgroundPaletteBtn" class="palette-trigger" type="button" aria-label="背景调色盘" title="背景调色盘">
  <span class="palette-trigger-emoji" aria-hidden="true">🎨</span>
</button>
<button id="saveUserGuideBtn" class="text-action background-guide-btn" type="button">使用手册</button>
```

**改动**：
- `#saveUserGuideBtn` 改为与 `#backgroundPaletteBtn` 同结构：使用 `palette-trigger` CSS 类（或新增同样圆形样式的类，复用尺寸/底色/居中规则）
- 内部放 `<span class="palette-trigger-emoji" aria-hidden="true">📕</span>`
- 保留 `aria-label="使用手册"` + `title="使用手册"` 提供 a11y 与 tooltip
- 不动 `src/renderer.js:4607` click handler（仍触发 USER_GUIDE 导出）

### 3.2 T2 — 使用手册版本号刷到 v2.1.4 + 补新功能段

#### 3.2.1 现状

`docs/USER_GUIDE.md:3` 顶部字段：
```markdown
版本：`v2.1.1`
```

但正文已经覆盖到 v2.1.3：
- §1.6 月度银行对账单BU回填校验（v2.1.2 新增） — 行 861-941
- §1.7 业务OP数据核对（v2.1.3 新增） — 行 943-998+

即 v2.1.2 / v2.1.3 两轮迭代写了正文但忘了刷顶部版本号字段。

#### 3.2.2 v2.1.4 改动

1. **顶部版本号字段**：`v2.1.1` → `v2.1.4`
2. **新增章节 §1.8「主界面工具栏与模块收纳（v2.1.4 新增）」**：放在 §1.7 业务OP数据核对之后，内容包括：
   - 工具栏右下角三个圆形按钮：🎨 背景调色盘 / 📕 使用手册 / 🔄 小助手功能收纳
   - 🔄 收纳弹窗操作说明（双区域 / ➡️/⬅️ / 拖拽排序 / 默认列表 / 至少保留 1 个启用）
   - 落库提醒：`app_settings.enabled_modules` 持久化
3. **§1.5 对账单ReconID修复 末尾追加一句**：「v2.1.4 起主面板「账单类别」默认选「网关对账单」（不再需要先选）」

#### 3.2.3 与发版三件套的关系

- `CHANGELOG.md`：新增 v2.1.4 段，写 4 块改动（含 USER_GUIDE 刷版本号）
- `docs/VERSION_FEATURE_HISTORY.md`：新增 v2.1.4 条目
- `docs/USER_GUIDE.md`：**本次必须改**（顶部版本号 + §1.8 新增 + §1.5 追加一句）

### 3.3 T3 — 「小助手功能收纳」弹窗

#### 3.3.1 入口

📕 按钮右侧新增 `#moduleCabinetBtn` 圆形 emoji 按钮，emoji = 🔄，`aria-label="小助手功能收纳"`，`title="小助手功能收纳"`。样式与 🎨/📕 完全一致（同 CSS 类）。

#### 3.3.2 弹窗结构

```
┌─────────────────────────────────────────────────────────────┐
│ 小助手功能收纳                                       [ × ]   │  ← 标题栏（左上角文字 + 右上角关闭）
├──────────────────────────┬────┬──────────────────────────┤
│  闲置功能                │    │  启用功能                │
│  ────────────────────    │    │  ────────────────────    │
│  ○ 业务OP数据核对        │    │  ○ 网银账单生成      ⋮   │  ← 行末 ⋮ 是拖拽手柄
│  ○ 新开账户余额账单生成  │ ➡️ │  ○ 银行对账单处理    ⋮   │
│  ○ 月度银行对账单BU回填校│    │  ○ 对账单ReconID修复 ⋮   │
│  ○ 月度 Pending 数据核对 │ ⬅️ │                          │
│                          │    │                          │
└──────────────────────────┴────┴──────────────────────────┘
```

- 整体：modal overlay，居中显示，宽 720px / 高 480px（响应式可滚动）
- 左区域表头：「闲置功能」（黑底白字或 muted 灰色）
- 右区域表头：「启用功能」（同样式）
- 中间两个按钮垂直排列：上「➡️」（移到右）、下「⬅️」（移到左）
- 左右两个列表：单选（点击行高亮），可垂直滚动
- 右侧每行末尾有拖拽手柄（如 ⋮⋮ 或 ☰ 图标）

#### 3.3.3 默认值（首次安装/`enabled_modules` key 不存在时）

| 区域 | 顺序 | 模块 ID | 模块名 |
|---|---|---|---|
| 启用 | 1 | `statement-generator` | 网银账单生成 |
| 启用 | 2 | `bank-statement-process` | 银行对账单处理 |
| 启用 | 3 | `recon-id-fix` | 对账单ReconID修复 |
| 闲置 | 1 | `biz-op-recon` | 业务OP数据核对（视觉宽度 14） |
| 闲置 | 2 | `new-account-generator` | 新开账户余额账单生成（视觉宽度 20） |
| 闲置 | 3 | `pending-reconciliation` | 月度 Pending 数据核对（视觉宽度 21，含 2 个空格） |
| 闲置 | 4 | `bank-bu-recon` | 月度银行对账单BU回填校验（视觉宽度 24） |

**闲置区排序规则**：~~按模块 `name.length` 升序（中文/英文/空格/数字按 JS `String.length` 一视同仁，即 UTF-16 code unit 数）~~ → **Fix1.5 修订**改为按**视觉宽度**升序（CJK 字符算 2，其他算 1）。同长度/同视觉宽度时按 MODULES 声明顺序作 tie-break。

> ⚠️ **以下 §3.3.4 / §3.3.5 / §3.3.6 为 v0.1 设计快照**。Fix1 round（v0.2）对若干行为做了撤回/修订，最终行为以本 PRD §八「Round Fix1」 + USER_GUIDE §1.8 + spec.md 顶部 v0.2 修订 Note 为准。下表行末标记 [v0.1] = 历史方案、[Fix1] = 当前生效方案。

#### 3.3.4 交互规则

| 动作 | 行为 | 修订标记 |
|---|---|---|
| 点击左/右区域内某一行 | 选中该行（高亮）；另一区域选中态清空（单选语义） | [v0.1 + Fix1.4 补 toggle] 再次点击同一选中行 → 取消选中 |
| 点击 ➡️ | 把左侧选中行移到右区域**末尾**；左区清空选中态 | [Fix1.2] 仅修改本地 workingEnabled，**不**触发落库 |
| 点击 ⬅️ | 把右侧选中行移到左区域；右区清空选中态 | [Fix1.2 + Fix1.5] 仅本地变更；左区按**视觉宽度**重排（非操作时序） |
| 拖拽右侧行末手柄 | HTML5 原生 drag/drop，松手时把该行插入到放下位置 | [Fix1.2] 仅本地变更 |
| 点击「完成」 | 一次性调 onCommit 写 DB + 关弹窗；左上角菜单同步刷新 | [Fix1.2] 新增 |
| 点击「取消」/ × / overlay 外部 | 丢弃所有本地变更 + 关弹窗（还原到打开前） | [Fix1.2] 撤回 v0.1 "即时落库" 设计 |

#### 3.3.5 边界规则（v0.2 已全部拍板，见 §五 OPEN ISSUES）

| 编号 | 边界 | 最终拍板 |
|---|---|---|
| B1 | 启用区是否允许清空到 0 | **禁止**（O3 拍板）。仅剩 1 个时 ⬅️ disabled |
| B2 | 当前激活模块被移到闲置 | **自动切换**到启用区第一个（O4 拍板） |
| B3 | `current_module` 持久化与启用列表不一致 | 启动时 fallback 到启用列表第一个（round 1 self-review I1 修复：fallback 直接调 IPC 写回 DB，绕过 setCurrentModule 内部 guard） |
| B4 | 闲置区移到启用是否按长度重排 | ~~不重排（v0.1）~~ → **按视觉宽度重排**（Fix1.5 拍板，与首次默认值规则一致） |
| B5 | 新模块上线时如何进入 | 新模块默认进入**闲置区末尾**；启动时 `getEnabledModules` sanitize 自动过滤非启用列表中的旧 ID |

#### 3.3.6 落库 schema

```javascript
// app_settings 表
setting_key = 'enabled_modules'
setting_value = JSON.stringify(['statement-generator','bank-statement-process','recon-id-fix'])  // 启用列表的顺序数组
```

**只持久化启用列表**，闲置区由 `MODULES 全集 - enabled_modules` 实时算出。

闲置区的展示顺序：
- ~~旧模块（曾经在 enabled_modules 里、被 ⬅️ 移出的）：按移出时序追加；这里有个细节 — 简化方案是**每次启动都按"模块名长度"重排闲置区**（用户在弹窗里调整时也按长度展示）。**拟采用简化方案**：闲置区始终按 `name.length` 升序，⬅️ 把右侧选中追加到左区时也立即按长度重新排序~~ → **Fix1.5 修订**：闲置区始终按**视觉宽度**升序（CJK×2 + 其他×1），⬅️ 把右侧选中追加到左区时也按视觉宽度重排，详见 §3.3.3 排序规则。

> ~~**拍板 #1**：B4 调整为"⬅️ 把右侧选中追加到左区时，按 `name.length` 升序重新排序"（与默认值一致，避免持久化闲置区时序）。**待用户确认**~~ → **Fix1.5 已拍板**：按视觉宽度升序（见 §五 OPEN ISSUES 表 O1）。

### 3.4 T4 — 对账单ReconID修复账单类别默认值改为「网关对账单」

#### 3.4.1 当前现状

`index.html:286`：
```html
<select id="reconIdFixBillCategorySelect">
  <option value="">请选择账单类别</option>
  <option value="business">单据对账单</option>
  <option value="gateway">网关对账单</option>
</select>
```

#### 3.4.2 改动

```html
<select id="reconIdFixBillCategorySelect">
  <option value="business">单据对账单</option>
  <option value="gateway" selected>网关对账单</option>
</select>
```

- 删除 `<option value="">请选择账单类别</option>`
- 给 `value="gateway"` 加 `selected` 属性

#### 3.4.3 持久化恢复联动（关键风险点）

`src/renderer.js:4417` 段当前从 `state.reconIdFixBillCategory` 持久化恢复账单类别，逻辑：
- 持久化为空（`''` 或 `null`）→ 主面板 select 设为空值 → 走 v2.1.0-beta.3 T11"账单类别为空时"分支（按钮 disabled、场景行隐藏）
- 持久化为 `'business'` / `'gateway'` → 主面板 select 设为对应值

**v2.1.4 拍板拟定**：
- DB 中 `recon_id_fix_bill_category` 持久化为空 → 主面板 select 默认 `'gateway'` + 触发"等价于用户首次选了 gateway"的初始化（即立刻填充 scenario + enable 按钮）
- DB 中已有非空值 → 沿用持久化值（不强制覆盖用户的旧选择）

**风险**：v2.1.0-beta.3 T11 多处分支假设"账单类别可以为空"。删除空选项后，主面板上 UI 层无法再切到空（select 默认非空），但 DB 还可能存空值（历史用户数据）。`handleReconIdFixBillCategoryChange` 等 handler 不必改，仅初始化时把"DB 空值"翻译成"UI 默认 gateway 且写回 DB"。

> **拍板 #2**：DB 已有空值时启动初始化要不要**写回 'gateway'**？拟**写回**（让 DB 状态与 UI 状态保持一致）。**待用户确认**。

---

## 四、影响范围

### 4.1 文件改动清单

| 文件 | 改动 | 备注 |
|---|---|---|
| `index.html` | 改 `#saveUserGuideBtn` 为圆形 emoji 📕；删 `<option value="">请选择账单类别</option>` 占位 + 给 gateway 加 selected | T1 + T4 |
| `index.html` | 新增 `#moduleCabinetBtn` 圆形 emoji 🔄 按钮（📕 右侧） | T3 |
| `index.html` | 新增模块收纳弹窗 DOM（overlay + 双区域） | T3 |
| `src/renderer.js` | 新增 `state.enabledModules` 缓存 + 弹窗 DOM 缓存 + 弹窗交互 handler | T3 |
| `src/renderer.js` | 改 `renderTopModuleSwitcher`（左上角切换按钮渲染）按 `state.enabledModules` 过滤+排序 | T3 |
| `src/renderer.js` | 改 `state.reconIdFixBillCategory` 初始化逻辑：DB 空值时默认 gateway + 写回 | T4 |
| `src/renderer-dialogs.js` | 新增 `openModuleCabinetDialog` 工厂（或放在 renderer.js 也行） | T3 |
| `src/preload.js` | 新增 IPC：`settings:getEnabledModules` / `settings:setEnabledModules` | T3 |
| `src/main.js` | 新增 IPC handler：`settings:getEnabledModules` / `settings:setEnabledModules` | T3 |
| `src/backend/database/settings-repository.js` | 新增 `getEnabledModules(db)` / `setEnabledModules(db, list)` | T3 |
| `src/renderer-previews.js` | 新增弹窗 preview（`npm run preview:module-cabinet`） | T3 |
| `package.json` | bump 2.1.3 → 2.1.4（直接正式版，patch 级别，与 v2.1.1/v2.1.2/v2.1.3 一致） | 已 bump |
| `CHANGELOG.md` | 新增 v2.1.4 段 | 发版前 |
| `docs/VERSION_FEATURE_HISTORY.md` | 新增 v2.1.4 条目 | 发版前 |
| `docs/USER_GUIDE.md` | 顶部版本号 v2.1.1 → v2.1.4 + §1.5 末追加一句 + 新增 §1.8 主界面工具栏与模块收纳 | T2（修订后） |
| `docs/iterations/v2.1.4/{PRD,spec,tasks}.md` | 新建 | 本次 |

### 4.2 关联功能 review（Important Variables 命中预判）

待执行 `/check-vars` 后填充。预计命中：
- `MODULES`（renderer.js:38）— Critical / Important-skeleton 级，因为 enabled_modules 持久化引用其 id
- `state.currentModule` / `state.reconIdFixBillCategory` — Runtime-state
- `current_module` / `recon_id_fix_bill_category` app_settings key — Persistence

### 4.3 不在本次范围

- 不动现有 7 个模块的内部逻辑
- 不动 saveUserGuideBtn 的 click handler
- 不动 v1.5.x / v2.0.0 / v3.0.0 等其他分支
- 不动 smoke test 既有 case（新增 case 可能补 1-2 条）

---

## 五、OPEN ISSUES 拍板记录

✅ **全部拍板完成（2026-05-14）**

| # | 议题 | 拍板 | 备注 |
|---|---|---|---|
| ~~O1~~ | ~~闲置区从启用区收回时排序方式~~ | ~~A=按 name.length 重排~~ → **Fix1.5 修订改为按视觉宽度（CJK×2 + 其他×1）** | v2.1.4 v0.2 Fix1.5：用户感知"月度银行对账单BU回填校验"(视觉宽度 24) 应排在"月度 Pending 数据核对"(视觉宽度 21) 之后；String.length 是 UTF-16 code unit，混排中英文时与视觉感受不符 |
| O2 | DB `recon_id_fix_bill_category` 持久化空值时启动写回 'gateway' | **A=写回** | DB 与 UI 状态一致 |
| O3 | 启用区是否允许减到 0 | **A=禁止，至少 1 个** | ⬅️ 在启用区 ≤ 1 时 disabled |
| O4 | 当前激活模块被移到闲置时 | **A=自动切到启用区第 1 个** | 复用既有 `switchModule` |
| O5 | 拖拽手柄视觉 | **A=⋮⋮**（双竖三点字符） | 无 icon 依赖 |
| ~~O6~~ | ~~弹窗是否需要"取消/确认"按钮~~ | ~~A=不需要，即时落库~~ → **Fix1 v0.2 撤回，改 B=需要，关弹窗时统一落库** | v2.1.4 v0.2 Fix1：用户验收后反馈"应该支持取消还原"，撤回原 v0.1 拍板。改为「完成」按钮一次性落库 + 「取消」/×/overlay 外部 丢弃变更 |
| O7 | 🔄 按钮 tooltip 文案 | **A="小助手功能收纳"** | 与弹窗标题一致 |
| V1 | v2.1.4 版本号格式 | **直接 2.1.4**（无 beta） | 与 v2.1.1/v2.1.2/v2.1.3 patch 惯例一致 |

---

## 六、风险提醒（⚠️ 人工复核）

- ⚠️ **状态机**：左上角模块切换按钮由 `state.enabledModules` 驱动，T3 落地后需保证：(1) DB 空值时 fallback 默认列表；(2) MODULES 常量新增模块时自动并入闲置区；(3) 当前 `current_module` 不在新启用列表时自动切到第一个启用
- ⚠️ **数据迁移**：现有用户 DB 不会有 `enabled_modules` key，首次启动需要 seed 默认值（启动时若 key 不存在，按 §3.3.3 默认值写入）。这一步必须是幂等的
- ⚠️ **兼容性**：T4 删除"请选择账单类别"占位后，UI 层不再可能为空；但 `recon_id_fix_bill_category` 持久化历史空值需在初始化时迁移（写回 gateway）。需 smoke 验证旧 DB

---

## 七、实施计划

### 7.1 阶段划分

| 阶段 | 内容 | 拆 PR？ |
|---|---|---|
| Phase 1 | T1 + T2 + T4（小改动 3 件，单独 PR 或与 T3 合并） | 拟与 T3 合并为 1 PR |
| Phase 2 | T3（弹窗 + 落库 + 拖拽 + 默认值 seed） | 合并入同一 PR |
| Phase 3 | 文档三件套更新（CHANGELOG / VFH） + preview + smoke + check-vars | 同一 PR |

**初步建议**：本次 v2.1.4 整体作为**单 PR** 提交（4 块改动总规模小），PR 标题 `v2.1.4: 工具栏 emoji 化 + 模块收纳弹窗 + ReconID 账单类别默认 gateway`。

### 7.2 验收测试

| 用例 | 期望 |
|---|---|
| 启动应用 → 左上角切换按钮 | 默认只展示 3 个启用模块（网银账单生成 / 银行对账单处理 / 对账单ReconID修复），顺序固定 |
| 点 📕 按钮 | 仍触发 USER_GUIDE.md 导出（同 v2.1.3 行为） |
| 点 🔄 按钮 | 弹出收纳弹窗，左侧 4 个闲置，右侧 3 个启用 |
| 左侧选「业务OP数据核对」+ ➡️ | 该模块移到右侧末尾；关弹窗后左上角切换出现新模块；下次启动顺序保留 |
| 右侧拖拽「对账单ReconID修复」到第 1 行 | 排序在弹窗本地维护（Fix1.2 修订两阶段提交）；点「完成」后一次性落库 + 关弹窗 + 左上角第一个变成对账单ReconID修复；下次启动顺序保留 |
| 右侧选「网银账单生成」+ ⬅️（启用区还有 ≥2 个） | 移到左侧；左侧按视觉宽度重排（Fix1.5 修订 — CJK×2 + 其他×1） |
| 右侧只剩 1 个 + 选中 + ⬅️ | ⬅️ 按钮 disabled，移动失败 |
| 进入对账单ReconID修复模块 | 主面板「账单类别」默认显示「网关对账单」，按钮可用，不再需要先选 |
| 旧 DB（recon_id_fix_bill_category=''）+ 启动 | 主面板默认 gateway + DB 写回 'gateway' |

---

## 八、实施记录（Dev 阶段回填）

### Round 1（2026-05-14） — HTML 改动 + spec 修订

**改动文件**：
- `index.html` — 3 处：使用手册按钮换皮（📕）/ 新增 🔄 模块收纳按钮 / 账单类别下拉删占位项 + gateway 默认 selected
- `package.json` — version `2.1.3` → `2.1.4`（直接正式版，patch 级，对齐 v2.1.1/v2.1.2/v2.1.3 惯例）
- `docs/iterations/v2.1.4/{PRD,spec,tasks}.md` — 三件套起草
- `docs/iterations/v2.1.4/spec.md` — §3.5/3.6 reverse sync 修订（弹窗 DOM 从静态 HTML 改为 JS 工厂 + `modal-overlay/modal-card` 类对齐项目惯例）
- `docs/previews/main-page.png` — `npm run preview` 重跑，三个圆形按钮 🎨 / 📕 / 🔄 视觉验证通过

**OPEN ISSUES 拍板**：O1-O7（功能行为）+ V1（版本号 → 直接 2.1.4） 全部 A 选项落定。

### Round 2（2026-05-14） — Backend：settings repo + IPC + 顺手修关联 bug

**改动文件**：
- `src/backend/database/settings-repository.js` — 提炼 `ALL_MODULE_IDS` 全集（7 个模块 ID）；新增 `ENABLED_MODULES_KEY` + `DEFAULT_ENABLED_MODULES` + `getEnabledModules` / `setEnabledModules` 函数；**顺手修 `CURRENT_MODULE_VALID` 从 5 模块扩到 7 模块**（v2.1.2/v2.1.3 漏更新枚举 bug）
- `src/backend/database.js` — AppDatabase facade 加 `getEnabledModules` / `setEnabledModules`
- `src/preload.js` — `settings` 块新增 `getEnabledModules` / `setEnabledModules`（kebab-case IPC channel）
- `src/main.js` — 注册 `settings:get-enabled-modules` + `settings:set-enabled-modules` 2 个 plain IPC handler

**⚠️ 关联 bug 修复（v2.1.2/v2.1.3 遗留）**：
- 现状：`CURRENT_MODULE_VALID` 在 v2.1.0-beta.1 写定后只列 5 个模块 ID，v2.1.2 新增 `bank-bu-recon` + v2.1.3 新增 `biz-op-recon` 时只动 renderer 端 `MODULES` 常量，没同步 backend 校验枚举
- 影响：用户切到 `bank-bu-recon` / `biz-op-recon` 时 `setCurrentModule` 会抛 "Invalid current_module"（实际项目能跑可能是被 IPC 错误处理吞了 / 或这两个模块 setCurrentModule 路径之前没真实被走到）
- 修复：将 `CURRENT_MODULE_VALID` 引用 `ALL_MODULE_IDS`（统一 7 模块全集），同时 `setEnabledModules` 也用 `ALL_MODULE_IDS` 校验，保证两边一致
- 风险评估：纯收紧 → 放松的修改（原本会抛错 → 改为允许），不会引入新 break

**验证**：
- `npm run smoke` → 全绿（含 `bank-bu-recon 41/41` + `biz-op-recon 154/154`），无回归
- 新功能 smoke case 留到 Round 6（T10）补

### Round 3（2026-05-14） — Renderer：弹窗工厂 + 启动联动 + 顶部切换动态化

**改动文件**：
- `src/renderer.js`
  - 新增 `state.enabledModules` 字段（启动由 `info.enabledModules` 注入）
  - 新增 `renderTopModuleSwitcher()` 函数（按 `state.enabledModules` 动态渲染左上角模块菜单）
  - `initialize()` 改造：拉 `info.enabledModules` → 注入 state → 渲染顶部菜单；若 `info.currentModule` 不在启用列表 → 切到 `enabledModules[0]` + `persist=true` 自动写回 DB
  - 左上角模块菜单事件绑定从静态 7 button forEach 改为 event delegation（一次绑定）
  - 新增 `elements.moduleCabinetBtn` cache + `createModuleCabinetDialog` 解构
  - `🔄` 按钮 click handler：弹出收纳弹窗 + `onCommit` 回调（写库 → 更新 state → fallback currentModule → renderTopModuleSwitcher）
  - **T4 JS 部分**：`reconIdFixBillCategory` 初始化 DB 空值 → 默认 `'gateway'` + 写回（O2 拍板）
- `index.html`
  - `#moduleSwitcherMenu` 容器静态 7 个 button 全部删除 → 留空容器（动态填充）
- `src/renderer-dialogs.js` — 新增 `createModuleCabinetDialog` 工厂（~150 行）：
  - 双区域 + 单选 + ➡️/⬅️ + 行内 HTML5 drag/drop 拖拽排序 + 即时落库
  - 启用区至少保留 1（O3）+ 关闭按钮 + overlay 点外关闭

**验证**：
- `npm run preview` → 主页面 OK，底部 🎨/📕/🔄 三圆形按钮显示
- `npm run preview:module-switcher-open` → 左上角菜单只显示 3 个启用模块（与默认 `enabled_modules` 一致）

### Round 4（2026-05-14） — CSS 弹窗样式

**改动文件**：
- `src/styles-gemini-extra.css`（**Clear theme 默认主样式**，index.html 实际加载）— 新增 `.module-cabinet-*` 100+ 行样式块（modal 720px / grid 1fr 80px 1fr / section / list / item hover+selected+dragging+drag-over / 拖拽手柄 / 控制按钮）
- `src/styles.css`（General theme 备用）— 同步新增样式块
- `Clear/styles-gemini-extra.css`（独立 preview HTML 用，主应用不加载）— 同步样式以备将来独立 HTML preview

**Reverse sync 修订（spec）**：
- 第一版 CSS 误加到 `src/styles.css`（实际是 General theme，Clear 默认下不生效）→ 第二版补到 `src/styles-gemini-extra.css`，弹窗布局立即正确

**验证**：
- `npm run preview:module-cabinet`（新 preview 入口）→ 弹窗 visual 通过：标题/×、左侧 4 个闲置（按 name.length 升序：业务OP 8 / 新开 10 / 月度银行 12 / 月度Pending 15）、右侧 3 个启用（默认顺序）、中间 ➡️/⬅️ 圆形按钮、启用项末尾拖拽手柄 ⋮⋮

### Round 5（2026-05-14） — USER_GUIDE.md 修订

**改动文件**：
- `docs/USER_GUIDE.md`
  - 顶部 `版本：v2.1.1` → `版本：v2.1.4`（v2.1.2/v2.1.3 写正文时漏更新顶部字段，本次一并修订）
  - §1.5 对账单ReconID修复 末尾追加 v2.1.4 默认 gateway 说明段
  - §1.7 后新增 §1.8「主界面工具栏与模块收纳（v2.1.4 新增）」整章（5 节：工具栏三按钮 / 收纳弹窗 / 默认值 / 约束 / 持久化 / Preview 参考）

### Round 6（2026-05-14） — Preview + 文档三件套

**改动文件**：
- `src/renderer-previews.js` — 新增 `applyModuleCabinetPreviewState` + deps 加 `createModuleCabinetDialog` + return 暴露
- `src/renderer.js` — 解构 `applyModuleCabinetPreviewState` + 传 `createModuleCabinetDialog` 入 deps + dispatch 加 `module-cabinet` 分支
- `package.json` — `preview:module-cabinet` script + 加入 `preview:all` 链尾
- `CHANGELOG.md` — 新增 v2.1.4 段（新增 / 变更 / 修复 / 内部 / 未改动 / smoke / 关联功能 review）
- `docs/VERSION_FEATURE_HISTORY.md` — 新增 v2.1.4 段

### Round 7（2026-05-14） — `/check-vars` + 升格 + 自查

**`/check-vars` 报告**：
- Critical 命中 0 处
- Important-skeleton 命中 2 处：`settingsRepository` / `ipcRenderer` — 均已对齐
- Runtime-state 命中 3 处：`state` / `elements` / `MODULES`+`setCurrentModule` — 均已对齐
- Risk-sensitive 命中 0 处
- Minor 知会 0 处

**升格入表**（rules/important-variables.md v5 → v6）：
- 新增 Important-skeleton 条目 `enabled_modules` 全链路（跨 ≥ 5 文件：main.js / preload.js / database.js / settings-repository.js / renderer.js / renderer-dialogs.js / renderer-previews.js）
- 新增 Important-skeleton 条目 `ALL_MODULE_IDS`（settings-repository.js 单文件 anchor，但承担 7 模块全集职责，被 `CURRENT_MODULE_VALID` + `setEnabledModules` 共用，与 `BIZ_OP_HEADERS` 同性质入表）

**自查结论**：本迭代仅 UI / state / IPC 改动，无对账规则 / 资金算法变动。Critical / Risk-sensitive 零命中。可进入手动测试阶段。

### Round Fix1（2026-05-14，用户验收后反馈 5 点）

**用户反馈原文**：
> 1. 闲置功能的最左侧往内平移至最左侧与左上角文本"小助手功能收纳"最左侧对齐，启用功能的最右侧往内平移相同距离；两栏最下侧边界往上平移 32px
> 2. 小助手功能收纳右下角新增"完成"和"取消"按钮，点击"取消"按钮即还原成点击 🔄 按钮之前的数据
> 3. "➡️"按钮向上平移至平行第一行模块，"⬅️"同步一起平移
> 4. 再次点击选中行数据时，取消选中状态
> 5. "月度银行对账单BU回填校验"的位置需要在"月度 Pending 数据核对"的下方，因为"月度银行对账单BU回填校验"的长度更长

**5 点拍板（v0.2 修订）**：

| Fix | 改动 | 拍板 |
|---|---|---|
| F1.1 | 弹窗两区域左右内缩对齐标题"小助手功能收纳" + 高度 -32px | CSS `padding: 6px 28px 0 28px` + `min-height: 360 → 328` + list `min-height 280 → 248` |
| F1.2 | 撤回 O6 "即时落库"，改为两阶段提交 | 弹窗内 ➡️/⬅️/拖拽 只改本地 workingEnabled；「完成」一次性 onCommit + 关；「取消」/×/overlay 外部 = 丢变更 + 关 |
| F1.3 | ➡️/⬅️ 上移到与第一行 item 顶部平行 | CSS `.module-cabinet-controls { justify-content: flex-start; align-self: start; padding-top: 37px; }` |
| F1.4 | 再次点击同一选中行 → 取消选中（toggle） | click handler 内判断 `isSameSelected` → 清空 selectedRegion/selectedModuleId |
| F1.5 | 闲置区排序由 `String.length` 改为视觉宽度（CJK×2 + 其他×1） | 新增 `visualLength` helper；`buildSortedIdle` sort 比较器改用 visualLength |

**改动文件**：
- `src/renderer-dialogs.js` — `createModuleCabinetDialog` 工厂完全重写（添加 footer DOM / cancelAndClose / confirmBtn 调 onCommit / toggle click / visualLength helper / 拖拽改本地不调 onCommit）
- `src/styles-gemini-extra.css` — `.module-cabinet-body` padding 28px 内缩 + `min-height: 328` + `.module-cabinet-list` min-height 248 + `.module-cabinet-controls` align-self start + padding-top 37 + 新增 `.module-cabinet-footer { justify-content: flex-end }`
- `docs/USER_GUIDE.md` §1.8.2 + §1.8.5 — 文案改"即时落库"为"完成/取消"+ "按 name.length"改为"按视觉宽度"
- `docs/iterations/v2.1.4/PRD-v2.1.4.md` §五 OPEN ISSUES O6 撤回标记
- `CHANGELOG.md` + `docs/VERSION_FEATURE_HISTORY.md` — v2.1.4 段补 Fix1 修订小节

**复算视觉宽度（验证用户预期）**：
- 业务OP数据核对 = 6×2 + 2 = **14**（最短）
- 新开账户余额账单生成 = 10×2 = **20**
- 月度 Pending 数据核对 = 6×2 + 7×1 + 2×1（空格） = **21**
- 月度银行对账单BU回填校验 = 11×2 + 2×1 = **24**（最长）
- 排序：业务OP（14） < 新开（20） < Pending（21） < **BU 校验（24）** ✓ 符合用户预期

**验证证据**：
- `npm run preview:module-cabinet` → 五点视觉验证通过（弹窗截图）
- onCommit 调用方（`src/renderer.js` 🔄 按钮 click handler）无需改动 — 签名不变，只是调用时机从"多次"变为"完成时一次"
- 不破坏既有行为：「O3 至少保留 1」、「O4 fallback currentModule」、「O5 拖拽手柄 ⋮⋮」、「拖拽排序 HTML5 drag/drop」均保持不变

### 归档完成（2026-05-14）

**PR #47 已合并到 main**：
- Merge commit: `f7358ecf0d7da542bbd2ddeaff82c7452f546c90`
- Merged at: 2026-05-14T18:05:08Z
- PR URL: https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/47
- 草稿 `docs/prs/待merge-PR #47.md` 已重命名为 `docs/prs/PR47-v2.1.4.md` + frontmatter `integrated: true`

**Self-review 全程汇总（6 轮）**：

| Round | 触发 | Commit | Finding |
|---|---|---|---|
| 1 | 内部 reviewer | `75fe791` | 4 Important + 6 Minor — fallback 写回 / footer CSS / inline error / committing guard / IPC return / 文档同步 |
| 2 | 内部 reviewer 复核 | `a617780` | 1 Important + 5 Minor — committing 视觉禁用 / try-finally / 主段同步 / spec verify Note |
| 3 | Codex 自动 review | `49c98cc` | 2 finding (P2 + P3) — package-lock 版本号 / PRD §3.3 主体 Fix1 标记 |
| 4 | 内部 reviewer 复核 round 3 | `c7dc3de` | 2 Minor — §3.3.6 警示语扩展 + §3.3.3 默认值表视觉宽度同步 |
| 5 | Codex 复核 round 4 | `88f80a1` | 1 P3 — spec.md 3 处 IPC 旧 API/return 残留 |
| 6 | Codex 复核 round 5 | `c1893d6` | 1 P3 — spec/tasks 8 处 v0.1 旧示例（name.length / 旧 IPC schema）|

- **Critical / Risk-sensitive 零命中**全程
- 代码层面 round 1-2 完成主要 fix，round 3-6 全是文档同步残留（"剥洋葱"）
- 后端改动顺手修了 v2.1.2/v2.1.3 遗留 bug：`CURRENT_MODULE_VALID` 5 → 7 模块（提炼 `ALL_MODULE_IDS` 全集）

**`rules/important-variables.md` v5 → v6**：升格 2 条 Important-skeleton（`enabled_modules` 全链路 + `ALL_MODULE_IDS` 7 模块全集 anchor）
