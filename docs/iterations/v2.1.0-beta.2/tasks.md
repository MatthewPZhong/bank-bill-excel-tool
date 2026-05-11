# tasks — v2.1.0-beta.2 ReconID 模块 UI 精修 + 场景管理隔离 + 窗口按钮修复

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft） |
| 目标版本 | `v2.1.0-beta.2` |
| 关联 PRD | `PRD-v2.1.0-beta.2.md` |
| 关联 spec | `spec.md` |
| 起草日期 | 2026-05-11 |
| 起草人 | team-lead（PM 角色） |

> 2 个 PR、共约 12 个 task。每条 task 注明涉及文件、实施要点、验收证据。

---

## PR-A：业务隔离 + 窗口 bug

> **目标**：场景管理两模块互相独立 + 窗口右上角按钮恢复工作。
> **预计工作量**：0.5-1 天 / 5 个 task。
> **优先级**：阻塞日常使用，先发。

### task A1：`createScenariosManagerDialog` 接收 `allowedCategories` 参数

- 涉及文件：`src/renderer-dialogs.js:5390-5548`
- 实施要点：
  - 函数签名改为 `createScenariosManagerDialog(allowedCategories = null)`
  - `filter = Array.isArray(allowedCategories) && allowedCategories.length > 0 ? allowedCategories : null`
  - 标题保持 `场景管理`（**不动**，无后缀）
  - `refreshTable` 内对 scenarios 做 `filter ? .filter(...) : scenarios` 过滤
  - 不传参时行为与之前等价（兜底）
- 验收证据：
  - 改前后 dialog 顶部仍显示 `场景管理`（无后缀）
  - 创建 4 类各 2 条共 8 条场景，传 `['extract-recon-id','offset-bill-mark','gateway-recon-join']` 后看到 6 条；传 `['recon-id-fix']` 看到 2 条；不传参看到全部 8 条
- 关联 spec：§2.1.1 / §2.1.2 / §2.1.3

### task A2：`createScenarioCategorySelectDialog` 处理白名单（单类别跳过）

- 涉及文件：`src/renderer-dialogs.js:5552-5598` + `createScenariosManagerDialog` 内调用点（L5540）
- 实施要点：
  - `createScenarioCategorySelectDialog(allowedCategories = null)` 接受白名单
  - 选项渲染时按白名单过滤（仅展示允许的类别）
  - 调用点（add-scenario click handler）判断：白名单长度 = 1 时 `closeModal() + state.scenarioDraft = {mode:'create', category:...} + openScenarioConfigByCategory(...)`；不弹类别选择窗口
  - 类别选择窗口标题保持 `新增场景`（不动）
- 验收证据：
  - 银行对账单入口点"新增场景" → 弹窗显示 3 类（不显示 recon-id-fix）；标题`新增场景`
  - ReconID 入口点"新增场景" → **不弹**类别选择窗口，**直接关闭场景管理列表 + 打开 C4 dialog**
- 关联 spec：§2.1.4

### task A3：renderer.js 两个入口传白名单

- 涉及文件：`src/renderer.js:3717-3728`
- 实施要点：
  - `bankStatementScenarioBtn` 调用传 `['extract-recon-id','offset-bill-mark','gateway-recon-join']`
  - `reconIdFixManageScenariosBtn` 调用传 `['recon-id-fix']`
- 验收证据：
  - 两入口的"场景管理"窗口标题都为 `场景管理`（无后缀）
  - 两入口列表互不包含对方场景：银行对账单看 C1/C2/C3，ReconID 看 C4
- 关联 spec：§2.1.5

### task A4：CSS 加 `-webkit-app-region: no-drag`

- 涉及文件：`src/styles-gemini.css` L80 附近
- 实施要点：
  - 追加 rule：
    ```css
    .no-drag,
    .window-actions,
    .window-btn {
      -webkit-app-region: no-drag;
    }
    ```
- 验收证据：
  - `npm start` 启动后，最小化 / 最大化 / 关闭 3 个按钮都能正确响应
  - 最大化按钮文本能正确 toggle `□` ↔ `❐`
- 关联 spec：§2.2

### task A5：preview 重跑 + 新增 ReconID 场景管理 preview 状态

- 涉及文件：`scripts/render-preview.js`（如需新增状态）
- 实施要点：
  - 跑 `npm run preview`（5 模块面板 + 场景管理两入口）
  - 如缺少 `recon-id-fix-scenarios-manager` preview 状态，按现有 `bank-statement-scenarios-manager` fork
  - 截图验证两入口列表过滤生效（标题相同，内容互不相交）
- 验收证据：
  - `npm run preview` 输出 PNG 文件全部更新
  - 视觉验视两入口的列表内容差异（标题同为"场景管理"）
- 关联 spec：§5

---

## PR-B：6 项 UI 调整

> **目标**：ReconID 主面板对齐银行对账单 + C4 dialog 6 处文案/布局/按钮调整。
> **预计工作量**：1 天 / 7 个 task。
> **优先级**：低风险，PR-A merge 后接力。

### task B1：ReconID 主面板布局对齐（需求 3-1）

- 涉及文件：`index.html:214-243` + `src/styles-gemini-extra.css`
- 实施要点：
  - 行 1 左 cell：包一个 `.recon-id-fix-scenario-row`，依次放 `<label> + <select> + <button>`
  - 行 1 右 cell：保留 `.pending-action-pair`，仅含 [导入文件 + 开始运行]
  - 行 2 不动
  - CSS 新增 `.recon-id-fix-scenario-row { display: flex; align-items: center; gap: 8px; }`
  - 如原 `.recon-id-fix-action-row` 内的 label/select 有专属样式，迁移到新 row 名下
- 验收证据：
  - preview 输出与 `bankStatementModulePanel` 视觉对齐（行 1 左场景下拉 + 场景管理；行 1 右导入文件 + 开始运行）
- 关联 spec：§3.1

### task B2：1v1/1v多/多v1 单行排列（需求 3-2）

- 涉及文件：`src/styles-gemini-extra.css`
- 实施要点：
  - `.scenario-config-c4-checkboxes` 加 `display: flex; flex-wrap: nowrap; gap: 16px; align-items: center;`
  - 如已有该 rule，叠加 `flex-wrap: nowrap`
- 验收证据：
  - C4 dialog 新增模式下 3 勾选框横向单行；窗口宽度变化时不换行
- 关联 spec：§3.2

### task B3：commonId 下拉宽度（需求 3-3）

- 涉及文件：`src/renderer-dialogs.js:6848-6851`
- 实施要点：
  - 移除 commonId-source select 上的 `scenario-config-input-narrow` class，改为仅 `scenario-config-input`（默认宽度按 max-content 自适应）
  - 不加 `min-width` 兜底（用户决定本模块未来不新增枚举）
- 验收证据：
  - C4 dialog 勾选"主从边都修复"，下方出现的 commonId 下拉完整显示 `主边单据 reconId` / `从边单据 reconId`（不截断）
- 关联 spec：§3.3

### task B4：按钮文案 + OR 分隔（需求 3-4）

- 涉及文件：`src/renderer-dialogs.js:6699` + `:6802` + `src/styles-gemini-extra.css:2436-2441`
- 实施要点：
  - L6699 文案 `+ 新增 OR 分组` → `+ 新增对账分组`
  - L6802 `<div class="scenario-config-c4-recon-or-sep">OR</div>` 改 `<div class="scenario-config-c4-recon-or-sep" aria-hidden="true"></div>`（去文字，加 aria-hidden）
  - CSS `.scenario-config-c4-recon-or-sep` 改为：`height: 8px;`，**移除** `font-weight / color / text-align / padding / font-size`
- 验收证据：
  - 新增 2 个对账分组后，分组间无 "OR" 文字，间距 = 8px（约 1/2 汉字高，等于 dialog 行 padding-top）
  - 按钮文案显示 "+ 新增对账分组"
- 关联 spec：§3.4

### task B5：dialog 标题精简（需求 3-5，仅 C4）

- 涉及文件：`src/renderer-dialogs.js:5666-5670`
- 实施要点：
  - `getCategoryDialogTitle` 增加 `if (category === 'recon-id-fix') return modeLabel;` 分支
- 验收证据：
  - C4 新增模式标题 `新增场景`
  - C4 修改模式标题 `修改场景`
  - C1/C2/C3 标题保留 ` — 类别名` 后缀（不受影响）
- 关联 spec：§3.5

### task B6：actions 按钮位置 + 顺序（需求 3-6，4 dialog 全改）

- 涉及文件：`src/renderer-dialogs.js:58-66` + `src/styles-gemini-extra.css`
- 实施要点：
  - **改 `getScenarioDialogActions(mode)` 互换顺序**：
    ```js
    return [
      { kind: 'primary', action: 'confirm', text: '确认' },
      { kind: 'secondary', action: 'cancel', text: '取消' }
    ];
    ```
  - view 模式仍单按钮 [返回]，不变
  - CSS 加 `.scenario-config-card .dialog-actions { justify-content: flex-end; }`（4 dialog 共用 class，一次性改）
- 验收证据：
  - C1/C2/C3/C4 dialog **全部** 新增/修改模式下，右下角依次显示 [确认 取消]
  - 点 [确认] 走原 save 流程；点 [取消] 走原 cancel 流程
  - 场景管理列表 dialog（modal-card.scenarios-manager-card）的"新增场景"按钮位置**不受影响**（仍左下）
  - 模板管理 / 确认弹窗等其他 dialog **不受影响**
- 关联 spec：§3.6

### task B7：preview 重跑 + 视觉验视

- 涉及文件：`scripts/render-preview.js`（如需新状态）
- 实施要点：
  - 跑 `npm run preview`
  - C4 dialog 截图覆盖：新增模式默认态 + 主从边都修复子态 + 多个对账分组态
  - ReconID 主面板截图（对齐验视）
- 验收证据：
  - PNG 视觉对齐 PRD 描述
- 关联 spec：§5

---

## 公共收尾（PR-B merge 后做）

### task C1：版本号 bump + 文档三件套

- 涉及文件：
  - `package.json` `version: 2.1.0-beta.1` → `2.1.0-beta.2`
  - `CHANGELOG.md` 新增 v2.1.0-beta.2 章节（8 项改动）
  - `docs/VERSION_FEATURE_HISTORY.md` 单据对账模块条目下追加 v2.1.0-beta.2 UI 精修说明
  - `docs/USER_GUIDE.md` 截图章节按 preview 输出更新
- 验收证据：3 文档 + package.json 同步更新；git status 干净

### task C2：`/check-vars` + `npm run scan:vars` 刷新

- 命令：
  - `npm run scan:vars` 重新生成 `docs/analysis/var-reference-stats.{md,json}`
  - `/check-vars` 输出 PR body 可粘贴的"⚠️ 关联功能 review"段落
- 验收证据：粘贴到 PR body

---

## PR-A Round 2：8 项 UI 优化

> Round 1 用户测试通过后的优化项。无业务逻辑改动，仅 CSS + dialog HTML/render 调整。
> 涉及文件 2 个：`src/renderer-dialogs.js` (5 处) + `src/styles-gemini-extra.css` (4 处)。
> 与 PR-A/PR-B 合并提交（用户决策方案 B）。

### task R2-1：删除按钮 × 居中（CSS）

- 涉及文件：`src/styles-gemini-extra.css:2188`
- 实施要点：`.icon-close-small` 追加 `display: inline-flex; align-items: center; justify-content: center; line-height: 1; padding: 0;`
- 验收证据：账单类型 # / 对账分组 # 行右侧删除 × 按钮：字符在 22×22 框内居中
- 关联 spec：§7.1

### task R2-2：SubBizType 去括号文案

- 涉及文件：`src/renderer-dialogs.js:6903`
- 实施要点：`SubBizType 取值（三选一）` → `SubBizType 取值`
- 验收证据：C4 dialog 勾选"主从边都修复"时下方分类标题显示为"SubBizType 取值"
- 关联 spec：§7.2

### task R2-3：场景名称中线对齐

- 涉及文件：`src/styles-gemini-extra.css:2099-2105`
- 实施要点：移除 `.scenario-config-label` 的 `padding-top: 6px`；新增 `.scenario-config-row-multi .scenario-config-label { padding-top: 6px }`
- 验收证据：4 个 dialog 的"场景名称"label 与右侧 input 中线对齐；"账单类型"/"对账字段"等多行 row 的 label 仍顶端对齐
- 关联 spec：§7.3

### task R2-4：分组序号同行

- 涉及文件：`src/styles-gemini-extra.css:2164`
- 实施要点：`.scenario-config-multi-seq` `flex: 0 0 36px` → `flex: 0 0 auto`；新增 `white-space: nowrap`
- 验收证据：C4 dialog 的"分组 2"/"分组 N"序号文本与"左：" 在同一行（不换行）
- 关联 spec：§7.4

### task R2-5：commonId 下拉宽度 155px

- 涉及文件：`src/styles-gemini-extra.css`（新增 rule）
- 实施要点：`.scenario-config-c4-output select[data-c4-common-id="source"] { flex: 0 0 155px; width: 155px; }`
  - **注意**：必须用 `flex: 0 0 155px` 覆盖 `.scenario-config-input` 默认的 `flex: 1`，否则 select 在 flex 容器内填满剩余空间，width 失效
  - 数值演进：130（猜测）→ 155（用户实测 +25px）
- 验收证据：C4 dialog 勾选"主从边都修复"时下方下拉宽度 = 155px（"主边单据 reconId" + 箭头 + 少许呼吸空间）
- 关联 spec：§7.5

### task R2-10：字段对按钮文案精简

- 涉及文件：`src/renderer-dialogs.js:6851`
- 实施要点：`+ 新增字段对` → `新增`（与同 dialog 内"账单类型"行的"新增"按钮风格统一）
- 验收证据：C4 dialog 内"对账字段"分组下右侧按钮文本为"新增"
- 关联 spec：§7.9

### task R2-11："新增"按钮仅每组第一行保留

- 涉及文件：`src/renderer-dialogs.js:6730 + :6851`
- 实施要点：
  - 账单类型 conditionsHtml：`isReadonly ? '' : <button>` → `isReadonly || cIdx !== 0 ? '' : <button>`
  - 对账字段 addBtnHtml：`isReadonly ? '' : <button>` → `isReadonly || fpIdx !== 0 ? '' : <button>`
- 验收证据：
  - 账单类型 #1 有 ≥ 2 条 condition 时，仅第 1 条右侧有"新增"，后续行无
  - 对账字段 分组 1 有 ≥ 2 条 fieldPair 时，仅第 1 条（通常是锁定 Amount 行）右侧有"新增"，后续行无
  - 删除按钮 × 不受影响（仍按 `length <= 1` 条件控制）
- 关联 spec：§7.10

### task R2-12：账单类型 + 对账字段所有下拉框左右边界垂直对齐

- 涉及文件：
  - `src/styles-gemini-extra.css`（bt-header / condition-row / conditions / group-header / fieldpair 5 处 rule + nowrap 兜底）
  - `src/renderer-dialogs.js`（group-header 合并 label + fieldpair 加 spacer）
- 实施要点：
  - 账单类型 grid：`36px minmax(0,1fr) 100px minmax(0,1fr) 22px 60px`
    - bt-header 元素通过 class/attribute selector 锚定到 col 1/2/5
    - condition-row 元素锚定到 col 2/3/4/5/6
    - `.scenario-config-c4-conditions` 移除 `padding-left: 10px`
  - 对账字段 grid：`90px minmax(0,1fr) 60px minmax(0,1fr) 22px 60px`
    - group-header 5 元素按 auto-flow 排到 col 1-5（HTML 合并 "分组 N" + "左：" 为单 span）
    - fieldpair 6 元素按 auto-flow 排到 col 1-6（HTML 加 spacer 占 col 1）
  - 关键 span/button 加 `white-space: nowrap` 防小列内文字竖排
- 验收证据：
  - 账单类型：bt-header [side] 与 condition-row [field] 左右边界完全对齐
  - 对账字段：group-header [leftTypeSeq] 与 fieldpair [leftField] 左右边界对齐；[rightTypeSeq] 与 [rightField] 对齐
  - 各行 × 和 新增 按钮位置上下对齐
  - "vs 右："、"新增" 单行显示不竖排
- 关联 spec：§7.11

### task R3-6：整体右移 + 缩小场景管理↔导入文件距离

- 涉及文件：`src/styles-gemini-extra.css`
- 实施要点（v2，最终方案）：
  - 保留 grid 默认 1fr:1.4fr（不改 control-row 比例，让 [场景下拉] 完全保持 R3-5 末态位置）
  - 用 transform translateX 单独右移 4 个元素：
    - `#reconIdFixManageScenariosBtn, #reconIdFixExportBtn { transform: translateX(100px) }`
    - `.recon-id-fix-board .pending-action-pair, #reconIdFixStatusBox { transform: translateX(74px) }`
  - 最终 [场景管理 右]↔[导入文件 左] 距离 = 80px
- 验收证据：实测通过 — 场景下拉位置完全不变，其他元素整体右移，按钮↔导入文件距离合理
- 关联 spec：§7.13 R3-6

### task R3-7：状态框初始文本统一为"欢迎使用小助手"

- 涉及文件：
  - `index.html` ReconID statusBox（L242）
  - `src/renderer.js` updateReconIdFixUi 默认分支（L3512）
- 实施要点：把"请先点击'场景管理'配置场景，再选择场景并导入文件" → "欢迎使用小助手"（与网银账单 / 银行对账单模块一致）
- 验收证据：每次打开软件后 ReconID 主面板 statusBox 默认显示 "欢迎使用小助手"
- 关联 spec：§7.13 R3-7

### task R3-8：C4 dialog label 简化

- 涉及文件：`src/renderer-dialogs.js:6732`
- 实施要点：`<span class="scenario-config-label">单据匹配规则</span>` → `<span class="scenario-config-label">匹配规则</span>`
- 验收证据：C4 新增/修改场景 dialog 第 2 行 label 显示 "匹配规则"
- 关联 spec：§7.13 R3-8

---

### task R2-13：Amount 锁定行左右边界对齐（视觉）

- 涉及文件：`src/styles-gemini-extra.css`（`.scenario-config-c4-recon-fieldpair-locked` rule）
- 调研：用户反馈"Amount 行状态改为可编辑"经追问确认为**对齐诉求**，非业务解锁；引擎 c4-recon-id-fix.js 强依赖 Amount/Amount 锁定（findAmountLockedPair / 池子 1v多 / 多v1 子集和算法），**不能解锁业务**
- 实施要点：
  - `padding: 4px 6px + border-left: 3px solid ...` → `box-shadow: inset 3px 0 0 ...`
  - `box-shadow inset` 不占布局空间，让 locked 行的 grid 内容位置与普通 fieldpair 完全一致
  - 保留 background（浅灰）+ 装饰条视觉（3px inset shadow）
- 验收证据：
  - Amount 锁定行的 [Amount▾] 与下面 [Currency▾] 左右边界完全对齐
  - 锁定行视觉区分仍存在（浅灰背景 + 左侧 3px 装饰条）
  - select 仍 disabled、option 仍只有 'Amount'（业务行为不变）
- 关联 spec：§7.12

---

## PR-A Round 3 v2：7 项微调 — **实施完成（2026-05-11）**

> 第 1 轮 R3 整批回滚后，用户重新分步实施 R3-1~R3-5 + 新增 R3-6 (距离调整) + R3-7 (状态框文本)。
> 涉及文件：`src/styles-gemini-extra.css` + `index.html` + `src/renderer.js`。
> 与 PR-A/PR-B/Round 2 合并提交。
>
> 新增 task R3-6 / R3-7（R3-1~R3-5 task 描述见上方原章节）：

### task R3-1："=" 居中

- 涉及文件：`src/styles-gemini-extra.css`（`.scenario-config-vs-arrow` rule）
- 实施要点：加 `text-align: center;`，让 "=" 在 fieldpair grid col 3（60px）内水平居中
- 验收证据：C4 dialog 对账分组内 "=" 显示在 [leftField] 与 [rightField] 中间
- 关联 spec：§7.13 R3-1

### task R3-2：场景名称 input 宽度收窄至 1/4

- 涉及文件：`src/styles-gemini-extra.css`（新增 rule）
- 实施要点：
  ```css
  .scenario-config-row > input[data-field="name"] {
    flex: 0 0 180px;
    width: 180px;
    max-width: 180px;
  }
  ```
- 验收证据：4 个 dialog（C1/C2/C3/C4）的"场景名称" input 宽度都是 180px
- 关联 spec：§7.13 R3-2

### task R3-3：ReconID 主面板布局重排

- 涉及文件：`src/styles-gemini-extra.css`（4 处 rule）
- 实施要点：
  - `.recon-id-fix-board .cell.left { justify-content: flex-end; }` — 让 [scenario-row] 和 [export-btn] 右对齐
  - `.recon-id-fix-board .cell.right { justify-content: flex-start; }` — 让 [pending-action-pair] 和 [statusBox] 左对齐
  - `.recon-id-fix-board .pending-action-pair { justify-content: flex-start; }` — pending-action-pair 内部也左对齐
  - `.recon-id-fix-board #reconIdFixManageScenariosBtn, ... #reconIdFixExportBtn { min-width: 140px; }` — 统一按钮尺寸
- 验收证据：
  - 导出文件按钮在场景管理按钮正下方（右边界对齐）
  - 状态框左边界 = 导入文件按钮左边界
  - 4 个按钮（场景管理 / 导出文件 / 导入文件 / 开始运行）大小一致
- 关联 spec：§7.13 R3-3

### task R3-4：场景下拉宽度收窄至 3/4

- 涉及文件：`src/styles-gemini-extra.css`（`.recon-id-fix-board .recon-id-fix-scenario-select` rule）
- 实施要点：`min-width: 160→120; max-width: 220→165` (3/4 缩放)
- 验收证据：场景下拉视觉宽度收窄约 25%
- 关联 spec：§7.13 R3-4

### task R2-6：场景管理右下"完成"按钮

- 涉及文件：`src/renderer-dialogs.js:5414-5417 + 5540` + `src/styles-gemini-extra.css`（新增 rule）
- 实施要点：
  - HTML footer 加 `<button data-action="finish">完成</button>`，去掉 `dialog-actions left` 的 `left` class
  - click handler：`dialog.querySelector('[data-action="finish"]').addEventListener('click', closeAndReloadReconList)`
  - CSS 新增 `.scenarios-manager-footer { justify-content: space-between; }`
- 验收证据：场景管理 dialog 右下角"完成"按钮可见可点；点击后关闭 dialog 回主页面 + 主面板下拉刷新
- 关联 spec：§7.6

### task R2-7：序号 = 列表内 1-based 顺序

- 涉及文件：`src/renderer-dialogs.js:5421-5448`
- 实施要点：
  - `renderRow(scenario, displayIndex)` 接受第 2 个参数
  - `<td class="scenarios-col-id">${displayIndex}</td>`（不再用 scenario.id）
  - `tr.dataset.id = String(scenario.id)` 保留真实 id 用于 IPC（管理 / 删除 / 切换启用）
  - refreshTable 调用：`visible.forEach((scenario, idx) => tbody.appendChild(renderRow(scenario, idx + 1)))`
- 验收证据：
  - 银行对账单入口列表序号 1, 2, 3（不论真实 scenarios.id 是多少）
  - ReconID 入口列表序号 1（不再是 5）
  - "管理" / "删除" / "切换启用" 仍正常工作（用真实 id）
- 关联 spec：§7.7

### task R2-8：单类别入口隐藏 优先级 + 是否启动 列

- 涉及文件：`src/renderer-dialogs.js:5410-5448`
- 实施要点：
  - `isCompactView = Array.isArray(filter) && filter.length === 1`
  - thead：priorityTh / enabledTh 在 compact 模式为空字符串
  - renderRow 同步条件渲染 priorityTd / enabledTd
  - 其他列宽度按比例放大（id 5%→6%, category 22%→28%, name 30.94%→40%, actions 19.06%→26%）
- 验收证据：
  - 银行对账单入口（filter.length=3）：列表显示完整 6 列
  - ReconID 入口（filter.length=1）：列表显示 4 列（无优先级、无是否启动）
- 关联 spec：§7.8

### task R2-9：preview 重跑 + 用户实测

- 涉及命令：
  - `npm run preview:scenarios-manager`（验证序号 + 完成按钮）
  - `npm run preview:scenario-config-c4` / `:scenario-config-c4-both`（验证分组序号同行）
- 用户实测项（preview 截图无法验证）：
  - R2-1 删除按钮 × 居中
  - R2-2 SubBizType 文案
  - R2-5 commonId 130px
- 验收证据：smoke 全绿 + 用户回 OK
