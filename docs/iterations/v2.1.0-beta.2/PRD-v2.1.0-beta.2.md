# PRD — v2.1.0-beta.2 单据对账模块 UI 调整 + 场景管理隔离 + 窗口按钮 hit-test 修复

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft，待用户 review） |
| 目标版本 | `v2.1.0-beta.2` |
| 起始版本 | `v2.1.0-beta.1`（已 merge：PR #35/#36/#37，2026-05-11） |
| 起草日期 | 2026-05-11 |
| 起草人 | team-lead（PM 角色） |
| 状态 | draft |
| 关联文档 | `spec.md` / `tasks.md` / `log.md`（同目录） |
| 涉及模块 | 单据对账 ReconID 修复模块 + 全局窗口控件 + 银行对账单处理模块（场景管理共享改造） |
| 依赖 | v2.1.0-beta.1 已落地的 5 模块结构 + scenarios 表 + C4 dialog |

---

## 一、需求概述

v2.1.0-beta.1 ReconID 修复模块上线后，用户在试用过程中提出 **8 项改进点**，分两个维度：

1. **业务隔离 + 系统 bug**（高优先）
   - R1：场景管理列表跨模块未隔离（银行对账单 vs 单据对账看到同一锅）
   - R2：全局窗口右上角"最小化 / 最大化 / 关闭"按钮**点击无响应**

2. **UI 文案/布局精修**（低风险）
   - 3-1：ReconID 主面板结构对齐银行对账单模块（场景下拉移到场景管理按钮左侧）
   - 3-2：C4 dialog 单据匹配规则 3 勾选框单行排列
   - 3-3：C4 dialog "主从边都修复" 时 commonId 下拉宽度足够显示完整枚举
   - 3-4：C4 dialog 按钮文案 "新增 OR 分组" → "新增对账分组"；分组间 "OR" 文字去除，保留间距
   - 3-5：C4 dialog 标题 "新增/修改场景 — 单据对账修复" → "新增/修改场景"
   - 3-6：C4 dialog 左下两按钮平移右下 + 互换为 [确认 取消]

---

## 二、背景与目标

### 2.1 业务背景

- v2.1.0-beta.1（PR #35/#36/#37）上线后用户实际跑了几轮"单据对账修复"
- 在使用中暴露 8 个改进点；R1/R2 阻塞日常使用，3-1~3-6 影响易用性与一致性
- 用户期望在 beta.2 内一次性解决，再走 RC

### 2.2 用户价值

| 维度 | 改善 |
|---|---|
| 场景管理体感 | 两模块互不污染，新增/修改场景时类别选择不再混杂 |
| 窗口可用性 | 最小化/最大化/关闭按钮恢复工作（当前用户必须用 Cmd+M / Cmd+W 兜底） |
| UI 一致性 | ReconID 主面板与银行对账单模块视觉对齐，降低学习成本 |
| dialog 可读性 | 标题更简洁、按钮位置符合主流弹窗惯例（确认在左 + 文案缩减） |

### 2.3 目标

| 必做 | 不做 |
|---|---|
| ✅ 场景管理 UI 层 category 白名单过滤（DB 不动） | ❌ 给 scenarios 表加 module 列 / 改 schema |
| ✅ 窗口按钮 CSS hit-test 修复（`-webkit-app-region: no-drag`） | ❌ 改 BrowserWindow.frame 配置 / 改 IPC 链路 |
| ✅ 6 项 C4 dialog & ReconID 主面板 UI 精修 | ❌ 改 C1/C2/C3 dialog（仅 C4） |
| ✅ preview 全量重跑 + smoke 全绿 | ❌ 改业务引擎 / 改对账算法 |
| ✅ 版本号 bump 2.1.0-beta.1 → 2.1.0-beta.2 + 三件套 | ❌ 改 v1.5.x / v2.0.0 / v3.0.0 分支 |

### 2.4 明确不做

- 不改 scenarios 表 schema、不加 module 列、不写迁移
- 不动 C4 引擎（`c4-recon-id-fix.js`）/ IO（`recon-id-fix-io.js`）/ 输出格式
- 不动 C1/C2/C3 dialog 与对应业务流
- 不调整 BrowserWindow 配置（继续无边框 + 自定义 titlebar）
- 不调整模块切换下拉的项

---

## 三、需求拆解（8 项）

### 3.1 R1：场景管理跨模块隔离

**现状**（renderer.js:3717 / 3725 / renderer-dialogs.js:5390）：
- 银行对账单模块 "场景管理" 按钮 → `createScenariosManagerDialog()`
- ReconID 模块 "场景管理" 按钮 → 同一个 `createScenariosManagerDialog()`
- dialog 内 `desktopApi.scenarios.list()` 拉全表，4 个 category 一锅端
- "新增场景" 走 `createScenarioCategorySelectDialog`，4 选 1 全展示

**期望**：
- 银行对账单模块场景管理：列表仅含 C1/C2/C3（`extract-recon-id` / `offset-bill-mark` / `gateway-recon-join`）；点"新增场景"弹 3 选 1 类别窗口；C4 完全不可见
- ReconID 模块场景管理：列表仅含 C4（`recon-id-fix`）；点"新增场景"**直接进 C4 dialog**（跳过类别选择窗口）；C1/C2/C3 完全不可见
- dialog 标题统一为 `场景管理`（**不带后缀**，由用户从哪个按钮进入决定上下文）
- 类别选择窗口标题保持 `新增场景`

**实现方式**：UI 层白名单过滤；DB 不动。

### 3.2 R2：窗口按钮 hit-test 修复

**现状**（styles-gemini.css:79-80）：
- `.drag-region { position: absolute; inset: 0; -webkit-app-region: drag; }`
- `.window-actions` 只有 `z-index: 1`，**没有** `-webkit-app-region: no-drag`
- HTML class 写了 `no-drag` 但 CSS 没对应 rule
- 结果：drag 区在 hit-test 层面覆盖整个 window-bar，按钮被吞

**期望**：3 个按钮（最小化/最大化/关闭）点击都能触发对应行为。

**实现方式**：styles-gemini.css 加 `.no-drag` rule（同时给 `.window-actions` / `.window-btn` 兜底）。

### 3.3 3-1：ReconID 主面板对齐银行对账单模块

**现状**（index.html:214-243）：
- 行1 左：[场景管理]
- 行1 右：[导入文件] + [场景] label + [场景下拉 select] + [开始运行]
- 行2 左：[导出文件]
- 行2 右：[statusBox]

**期望**（对齐 bankStatementModulePanel index.html:186-211 + 移动场景下拉）：
- 行1 左：[场景下拉] + [场景管理]（场景下拉**在场景管理按钮左侧**）
- 行1 右：[导入文件] + [开始运行]
- 行2 左：[导出文件]
- 行2 右：[statusBox]

> "场景下拉收起" 一词无含义，不实现"自定义 dropdown panel"。保持原 `<select>` 控件。

### 3.4 3-2：C4 dialog 1v1/1v多/多v1 单行排列

**现状**（renderer-dialogs.js:6671-6687）：
3 个 `.scenario-config-c4-checkbox-item` 在 `.scenario-config-c4-checkboxes` 容器内，依赖 CSS flex-wrap 自动换行。若容器宽度不足或 CSS flex 设置不当会换行。

**期望**：3 个勾选框强制单行排列（不换行）。

### 3.5 3-3：C4 dialog commonId 下拉宽度

**现状**（renderer-dialogs.js:6847-6851，"主从边都修复"勾选后出现）：
- `<select class="scenario-config-input scenario-config-input-narrow" data-c4-common-id="source">`
- 选项：`主边单据 reconId` / `从边单据 reconId`
- `.scenario-config-input-narrow` 应有固定窄宽度，截断长选项文本

**期望**：宽度刚好能完整显示 `主边单据 reconId` / `从边单据 reconId`（≈ 文本宽 + 下拉箭头 16px）。

**实现方式**：移除 `scenario-config-input-narrow` class，沿用默认 `.scenario-config-input`（无宽度限制，浏览器按 max-content 自适应）；不加 `min-width` 兜底（用户明确本模块未来不新增枚举）。

### 3.6 3-4：C4 dialog "新增 OR 分组" 文案 + 分隔块

**现状**（renderer-dialogs.js:6699 / 6802）：
- 按钮文本 `+ 新增 OR 分组`
- 分组间渲染 `<div class="scenario-config-c4-recon-or-sep">OR</div>`

**期望**：
- 按钮文本改 `+ 新增对账分组`
- 分组间不渲染 "OR" 文字，但保留视觉间距（继续渲染 div 但不带文字，靠 `height: 8px` 纯空白）

### 3.7 3-5：C4 dialog 标题精简

**现状**（renderer-dialogs.js:5666-5670）：
```js
getCategoryDialogTitle(category, mode) {
  const label = getCategoryLabel(category);
  const modeLabel = mode === 'view' ? '查看场景' : (mode === 'edit' ? '修改场景' : '新增场景');
  return `${modeLabel} — ${label}`;
}
```
recon-id-fix 类别返回 `新增场景 — 单据对账修复`。

**期望**：recon-id-fix 类别只返回 `新增场景` / `修改场景` / `查看场景`（不带 ` — 类别后缀`）。
> 仅 C4，其他 3 类不变。

### 3.8 3-6：C4 dialog actions 按钮位置 + 顺序

**现状**（renderer-dialogs.js:5660-5666 + .dialog-actions 默认 CSS）：
- `getScenarioDialogActions(mode)` 返回 `[{kind:secondary,取消}, {kind:primary,确认}]`
- `.dialog-actions` 默认左对齐（左下角）

**期望**：
- **4 个场景配置 dialog（C1/C2/C3/C4）的 `.dialog-actions` 全部改右对齐（右下角）**
- 按钮顺序改为 `[确认, 取消]`（确认在左、取消在右）
- C1/C2/C3 也一并改（用户决定，保持 4 dialog 一致）

**实现方式**：改 `getScenarioDialogActions(mode)` 返回顺序 + 加 CSS `.scenario-config-card .dialog-actions { justify-content: flex-end; }`。一次性影响 4 个 scenario config dialog，不影响场景管理列表 dialog（不同 class）。

---

## 四、决策记录

### D1 — 版本号

- 当前 `2.1.0-beta.1` → 目标 `2.1.0-beta.2`
- 不走 `2.1.0-beta.1.1`（npm semver `beta.1.1` 合法但非主流；用户在第 2 轮确认改 beta.2）

### D2 — 拆 2 PR

- **PR-A**：业务隔离 + 窗口 bug（R1 + R2）— 风险最高，先发
- **PR-B**：6 项 UI 调整（3-1 ~ 3-6）— 风险低，PR-A merge 后接力

理由：R1 涉及 dialog factory 接口签名变化（接收 `allowedCategories`），影响面比 UI 文案改动大；分开便于审查与回滚。

### D3 — 场景管理隔离实现方式

UI 层白名单过滤，不动 DB。
- `createScenariosManagerDialog(allowedCategories: string[] | null)` 接收白名单
- `loadScenariosOrAlert()` 拉全表后内存过滤
- "新增场景" 类别选择窗口（`createScenarioCategorySelectDialog`）按白名单展示选项；**单类别时跳过类别选择窗口直接 open 对应配置 dialog**（ReconID 入口）
- dialog 标题统一为 `场景管理`（不带后缀；上下文由用户从哪个按钮进入区分）
- 类别选择窗口标题保持 `新增场景`

### D4 — actions 按钮范围（4 dialog 一致）

3-6 actions 改动从"仅 C4"扩大到"全部 4 个场景配置 dialog（C1/C2/C3/C4）"。
- 用户决定保持 4 dialog 一致性
- 改 `getScenarioDialogActions` + `.scenario-config-card .dialog-actions` CSS
- 不影响其他 dialog（场景管理列表、模板管理、确认弹窗等）

### D5 — 3-5 标题精简范围（仅 C4）

标题精简仅针对 C4 dialog（`recon-id-fix` 类别），C1/C2/C3 保留 ` — 类别名` 后缀。
- 用户决定：避免丢失"当前是哪个类别"的视觉提示对 C1/C2/C3 的负面影响
- C4 是单类别模块（不会与其他类别混），后缀冗余

### D6 — Round 2 8 项 UI 优化（用户实测后追加）

PR-A/PR-B 通过后用户实测反馈 8 项优化（详见 spec §七 / tasks PR-A Round 2 / log Round 2 章节）：

| # | 优化点 | 用户决策 |
|---|---|---|
| R2-1 | 删除按钮 ❌ 居中 | inline-flex + align-items:center + line-height:1 |
| R2-2 | "SubBizType 取值"去"（三选一）" | 直接去括号 |
| R2-3 | "场景名称"中线对齐 input | 移除 .scenario-config-label 全局 padding-top；仅多行 row 保留 |
| R2-4 | 分组序号"分组 N"同行 | .scenario-config-multi-seq 改 flex: 0 0 auto + white-space: nowrap |
| R2-5 | commonId 下拉宽度 | 固定 130px（覆盖 PR-B B3 的 max-content 自适应） |
| R2-6 | 场景管理右下加"完成"按钮 | 等同 × 关闭（closeAndReloadReconList） |
| R2-7 | 序号重编号范围 | **B 全部入口**（按列表内 1-based 顺序，dataset.id 保留真实 id） |
| R2-8 | 隐藏 优先级+是否启动 列范围 | **B 单类别入口（filter.length === 1）通用规则**，不仅 ReconID |

### D7 — Round 2 与 PR-A/PR-B 合并提交（方案 B 续）

Round 2 改动**不另开 PR-C**，与 PR-A/PR-B 合并到同一个 PR（一次提交、一次 merge）。
- 改动量：renderer-dialogs.js (5 处) + styles-gemini-extra.css (4 处)
- 无业务逻辑改动，仅 dialog HTML/render + CSS
- smoke 全绿，preview 重跑通过

---

## 五、风险与依赖

### 5.1 ⚠️ 关联功能 review（重要变量清单命中）

| 命中条目 | 层级 | 风险面 | review 要点 |
|---|---|---|---|
| `scenarios` 表 listScenarios | Important-skeleton（间接） | 改 UI 过滤不动 SQL，但要验"全表拉 + JS 过滤"性能（场景数 < 100，可接受） | 验证：手工同时创建 4 类各 2 条共 8 条场景，两个入口各看到 3 / 1 / 8 条（全表）的过滤正确 |
| `state.scenarioDraft.category` | Runtime-state | "新增场景"流程取消类别选择窗口的影响 | view/edit 模式时 dialog 已带 category，新增时类别需从入口传入；不影响 draft.category 含义 |
| `reloadReconIdFixScenarios` | Runtime-state | 主面板下拉刷新链路 | 隔离后主面板下拉仍从全表拉过滤 recon-id-fix 类，已实现的链路不变 |
| `VALID_CATEGORIES` | Critical | 不改 | 仅 UI 白名单不动后端枚举 |

### 5.2 风险等级

| 改动 | 风险 | 缓解 |
|---|---|---|
| R1 dialog factory 接口改 | 中（C1/C2/C3 也走同 manager dialog；银行对账单入口要传 3 类白名单） | 接口默认值兜底；银行对账单入口测试 + ReconID 入口测试 |
| R2 CSS rule 新增 | 低 | 启动 npm start 实测 3 个按钮 |
| 3-1 ~ 3-6 UI | 低（纯渲染层，无业务逻辑） | preview 全量重跑 + 人工验视 |

### 5.3 测试要求

- 前端改动 ⇒ memory `workflow_frontend_previews`：必须重跑对应 `npm run preview:*`
- PR-A：5 模块面板 preview + 场景管理 preview（两入口各一）
- PR-B：5 模块面板 preview + C4 dialog 截图 + 主面板 ReconID 截图
- 合并到 main 前 ⇒ memory `workflow_important_vars_check`：必须跑 `/check-vars`

---

## 六、文档三件套更新

合并到 main 前需更新：
- `CHANGELOG.md` — v2.1.0-beta.2 章节（8 项改动）
- `docs/VERSION_FEATURE_HISTORY.md` — 单据对账模块 UI 精修条目
- `docs/USER_GUIDE.md` — ReconID 模块章节的截图更新

---

## 七、实施记录

> 各 PR merge 归档后回写改动清单到此处。

（待 PR-A / PR-B 完成后填写）
