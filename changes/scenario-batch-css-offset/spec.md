# Spec — 场景管理批量操作勾选列致表格大面积偏移

> 状态：**已实施（v3.0.0 PR-7，已发版）** ｜ 来源分支：`v2.1.16-beta.6` ｜ 目标版本：v3.0.0
> ✅ 回写 2026-06-15：原「待实施」状态行已 stale。实证落地 `src/renderer-dialogs.js:6700`（勾选列 3%）+ `src/styles-gemini-extra.css:2261`（合并重复 `.scenarios-col-name`）+ CHANGELOG v3.0.0 块D。
> 性质：纯前端 UX / 表格列布局，**不碰资金计算 / 对账逻辑**
> 缘起：在「场景管理」弹框点「批量操作」进入批量模式、勾选列出现后，整张表格列宽错位、大面积横向偏移；退出批量模式恢复正常

---

## 一、问题

「场景管理」弹框（`scenarios-manager`，`renderer-dialogs.js` 的 `createScenariosManagerDialog`）的表格 `.scenarios-table` 用 `table-layout: fixed; width: 100%`（`styles.css:2825-2828`）。普通模式下各数据列宽由**百分比**分配、总和约 100%；点「批量操作」进入批量模式后，最左侧多出一个**固定 32px**的勾选列（`scenarios-col-checkbox`），但其余百分比列宽**未做任何重算/补偿**。

在 `table-layout: fixed` 语义下，固定像素列先占满 32px，剩余宽度 `(容器宽 − 32px)` 再按各列百分比分配 → 每个百分比列的实际像素都被等比压缩，且原本"百分比总和≈100%"叠加 32px 固定列后**总意图宽度溢出容器约 32px（在 1140px 最大宽下 ≈ 2.8%）**。结果是批量模式下整张表所有列相对表头/相对普通模式**集体左移、错位**，视觉上「大面积偏移」；退出批量模式（勾选列 `display:none`）后恢复。

`setBatchMode`（`renderer-dialogs.js:6577`）切换 th/td 的 `display` 是同步的、本身无错位 bug——**真正缺的是「显示勾选列时同步让出其占用的列宽」这一步**。

---

## 二、根因（实证）

> 行号基线：分支 `v2.1.16-beta.6`（当前 HEAD）。

| 环节 | 事实 | 出处 |
|------|------|------|
| 表格布局 | `.scenarios-table { table-layout: fixed; width: 100%; }` —— fixed 布局下列宽由首行单元格宽度（含固定 px + 百分比）静态决定，**百分比 + 固定 px 混用会溢出** | `styles.css:2825-2828` |
| 弹框最大宽 | `.scenarios-manager-card { width: min(96vw, 1140px); }` —— 表格容器最大 1140px | `styles.css:2812-2813` |
| 勾选列 th | `<th class="scenarios-col-checkbox" style="width: 32px; …; display: none;">`（**内联固定 32px**，默认隐藏） | `renderer-dialogs.js:6468` |
| 勾选列 td | `<td class="scenarios-col-checkbox" style="width: 32px; …; ${checkboxDisplay}">`（**内联固定 32px**） | `renderer-dialogs.js:6560` |
| 批量模式切换 | `setBatchMode(next)`：`checkboxHeaderTh.style.display = inBatchMode ? '' : 'none'`（:6577）+ 逐行 `row-checkbox-cell` 切 display（:6584）——**只切显隐，无列宽重算** | `renderer-dialogs.js:6575-6593` |
| 其他列宽（th 内联，实际生效值） | th 内联宽度按视图模式三套分配（`idWidth`/`categoryWidth`/`nameWidth`/`actionsWidth` + `priorityTh` width 7% + `enabledTh` width 10%） | `renderer-dialogs.js:6422-6430` / `:6471-6476` |
| 其他列宽（CSS class 兜底，百分比） | id 5% / category 22% / name **30.94% `!important`** / priority 10% / actions 19.06% / enabled 13% —— **非 compact 累加 = 100%** | `styles.css:2843`/`2862`/`2868(!important)`/`2876`/`2882`/`2904` |
| 🔴 重复定义 | `styles-gemini-extra.css` 中 `.scenarios-col-name` **定义两次**：`:2251` `width: 30.94% !important` 与 `:2265` `width: 27.96%`（同选择器、不同值，相互覆盖且与 styles.css 冲突） | `styles-gemini-extra.css:2251` / `:2265` |
| name 列被钉死 | 代码注释自承：name 列被 `styles-gemini-extra.css .scenarios-col-name{width:30.94% !important}` 强制锁定、th 内联 `nameWidth` 在多数模式下**失效** | `renderer-dialogs.js:6425-6427`（注释） |
| 引入版本 | 勾选列由 v2.1.9（commit `2df26f6`）批量操作功能引入 —— **pre-existing，非 v3.0.0 新增** | `git log`（`2df26f6`） |

**根因一句话**：批量模式新增的勾选列用**固定 32px**，但表格是 `table-layout: fixed` + 其余列**百分比总和已≈100%**，显示勾选列时**未让出对应列宽**，固定 px 与百分比叠加溢出容器 ≈ 2.8% → 全列等比压缩、集体错位。`!important` + 重复定义放大了列宽口径的混乱。

---

## 三、修复方案

### 方案 A — 勾选列百分比化 + 其他列按比例补偿（✅ 推荐）

1. **勾选列改百分比**：把 `scenarios-col-checkbox` 的 th/td 内联宽度从 `32px` 改为约 **3%**（取整、便于补偿；32/1140 ≈ 2.8%，向上取 3% 更稳），与百分比列同口径，避免 fixed 布局下 px+% 混用溢出。
2. **其他列按比例补偿**：批量模式显示勾选列时，其余列总和需从 100% 降到约 **97%**（让出 3%）。两种落地选择（实施时二选一，倾向 b）：
   - (a) 静态：勾选列单独占一档，其余列百分比统一下调（如各列 ×0.97），保持相对比例；
   - (b) 维持其余列百分比不变、把勾选列 3% 视作"额外档"，靠 `width:100%` 的 fixed 表把溢出的 3% 在所有列间等比吸收——**但这恰是当前 bug 的成因**，故必须配合 (a) 真正下调，不能只靠浏览器吸收。
   - 推荐：**勾选列 3% + 其余列百分比各按 97/100 等比缩放**，使含勾选列时总和回到 100%。
3. **清理重复定义**：删除 `styles-gemini-extra.css` 中重复且取值冲突的 `.scenarios-col-name`（保留一处、统一为 styles.css 的 `30.94% !important` 或在实施时与 Dev 确认最终单一值），消除 `name` 列宽口径混乱，避免补偿计算被 `!important` 干扰。

> 该方案根治"px+% 混用溢出"，且批量/普通模式列宽都用同一套百分比口径。

### 方案 B — 批量模式 JS 动态重算列宽（备选）

`setBatchMode(true)` 时遍历所有列、把每列宽度按"是否含勾选列"动态重设（含勾选列时其余列 ×0.97），退出时还原。
- 缺点：列宽逻辑散落到 JS、与 CSS 双份维护；th 内联宽度已分三套视图模式，动态重算需覆盖全部分支，易遗漏。

### 方案 C — `table-layout: auto`（备选，最小改动但有副作用）

把 `.scenarios-table` 改 `table-layout: auto`，让浏览器按内容自适应列宽、固定 px 列不再溢出。
- 缺点：放弃 fixed 布局的稳定列宽，列宽随各行内容长度浮动，可能破坏现有"序号右移 21px / category 左对齐"等精调（`styles.css:2843-2912` 大量像素级精调依赖 fixed），回归面更大。

### 推荐

**方案 A**：根治、口径统一、回归面集中在"列宽百分比"一处；同时清理重复 `.scenarios-col-name` 定义。方案 B/C 留作 A 落地受阻时的退路。

---

## 四、影响面

- **纯前端 UX**，不碰资金计算 / 对账逻辑（资金红线 ✅ 不涉及）。
- 改动文件：
  - `src/styles.css`（`.scenarios-table` 各列百分比；可能新增/调整 `.scenarios-col-checkbox` 百分比）；
  - `src/renderer-dialogs.js`（勾选列 th/td 内联宽度 `32px` → 百分比，`:6468` / `:6560`；若走方案 A 静态补偿，其余列 th 内联宽度 `:6422-6430` 也需同步）；
  - `src/styles-gemini-extra.css`（删除重复 `.scenarios-col-name`，`:2251` / `:2265`）。
- **改后必须重跑 preview**：`npm run preview:scenarios-manager`（`package.json:56`，专属入口）。
  - 🔴 **盲点**：该 preview 默认渲染**非批量态**（勾选列 `display:none`），看不到偏移 → 偏移回归须靠 Electron 实跑批量模式，或为 preview 脚本补"批量态"变体（建议补一个 `scenarios-manager-batch` 入口）。
- `src/renderer-dialogs.js` 属**重要骨架文件** → 改后对照 `rules/important-variables.md` 跑 `/check-vars`（见 memory `workflow_important_vars_check`）。
- 前端改造提 PR 前必须重跑对应 preview（memory `workflow_frontend_previews`）。

---

## 五、验证

| 项 | 方法 |
|----|------|
| 复现 | Electron 打开「场景管理」→ 点「批量操作」→ 勾选列出现后整表列错位/横向偏移 |
| 修复后（批量进出无抖动） | 进入/退出批量模式，表格列**对齐表头、不偏移、不抖动**；勾选列正常显隐 |
| 各视图模式不变形 | 三套视图均验证：① 非 compact（资金对账主入口，含优先级 + 启用列）② compact 普通（业务 ReconID 修复，无优先级/无启用）③ gateway-recon-id-fix compact（无优先级、有启用）—— 进出批量模式列宽均不变形 |
| 无横向溢出 | 表格在 `1140px` 最大宽（`.scenarios-manager-card` 上限）下批量模式**无横向滚动条 / 无内容溢出** |
| preview 回归 | `npm run preview:scenarios-manager` 重渲染比对（非批量态不变形）；批量态靠 Electron 手测或新增 batch preview 入口 |
| 重复定义清理 | `styles-gemini-extra.css` 中 `.scenarios-col-name` 仅剩一处定义；`grep -c "scenarios-col-name" src/styles-gemini-extra.css` 校验 |

---

## 六、风险提示

- 纯前端 UX，不碰资金对账计算逻辑 → **资金红线 ✅ 不涉及**。
- `table-layout: fixed` 下 `styles.css:2843-2912` 有大量像素级精调（序号 margin-left:21px、category/name 左对齐、actions 按钮间距等），改列宽百分比时须确认这些精调在新百分比下仍成立（方案 A 只调宽度百分比、不动这些精调）。
- `name` 列的 `!important` + 重复定义是历史包袱（`renderer-dialogs.js:6425-6427` 注释已记录 th 内联 `nameWidth` 失效）：清理重复定义后，须确认 th 内联 `nameWidth`（compact 模式用 40%/30.94%）与最终单一 CSS 值的优先级关系符合预期，避免清理后 compact 模式 name 列宽反而变化。
- 改 `renderer-dialogs.js`（重要骨架）+ 全局 CSS → 提 PR 前 `/check-vars` + 重跑 `npm run preview:scenarios-manager`。
