# tasks — v2.1.1 patch 迭代

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft） |
| 目标版本 | `v2.1.1` |
| 关联 PRD | `PRD-v2.1.1.md` |
| 关联 spec | `spec.md` |
| 起草日期 | 2026-05-12 |
| 起草人 | team-lead（PM 角色） |
| 工作分支 | `v2.1.1` |
| PR 计划 | 单 PR：`v2.1.1 → main` |

> 7 个 task，约 2-3 天完成。task 顺序按依赖关系排列。
> 每完成 1 个 task 提交 1 个 commit：`[v2.1.1] <动作>(tx-task-name): <一句话>`

---

## T1：PDF 整体移除

- **涉及文件**（7+）：
  - 删除 `src/backend/file-service/pdf-worker.js`
  - 改 `src/backend/file-service/readers.js`（删 readPdfRows + shouldStopPdfMatchedRows + shouldSkipPdfMatchedRow + isPdfFile 参数 + PDF 分支）
  - 改 `src/backend/file-service/common.js`（`SUPPORTED_EXTENSIONS` 删 `.pdf`）
  - 改 `src/main.js`（删 dialog filter PDF 项 line 2584-2585）
  - 改 `package.json`（删 4 个 PDF/tesseract deps line 118/119/122/123）
  - `npm install` 重生成 `package-lock.json`
  - 改 `docs/USER_GUIDE.md`（删 line 21 pdf 类型）
- **实施要点**：
  - 按 spec §2.1 顺序操作；删 deps 后必须跑 `npm install`
  - 跑 `npm run smoke` 全 14 子套必须 PASS
  - 必须验证：导入 .xlsx / .csv / .xls 正常；选择 .pdf 文件时 dialog filter 不再出现
- **验收证据**：
  - `git status` 无 pdf 相关残留（`grep -rn "pdfjs\|tesseract\|pdf-worker\|isPdfFile" src/` 应空）
  - `npm run smoke` PASS
  - 启动 Electron + 导入 .xlsx 正常
- **关联 spec**：§2.1
- **预计工作量**：0.5 天
- **风险**：⚠️ **破坏性变更**。CHANGELOG 必须显著说明（T7）
- **Critical 变量改动**：`SUPPORTED_EXTENSIONS`（重要变量清单）— 提 PR 前 /check-vars 必须命中并 review

---

## T2-1：C4 dialog "匹配模式" 区文案改名

- **涉及文件**：
  - `src/renderer-dialogs.js`
- **实施要点**：
  - line 6824：`<span class="scenario-config-label">匹配规则</span>` → `匹配模式`
  - line 6828 / 6832 / 6836：business 子模式 3 个勾选框文案 `主边单据 X v Y 从边单据` → `主边 X v Y 从边`
  - gateway 子模式（`网关 X v Y 渠道`）不动
  - **不改**：line 5851 / 5958-5962 / 7042-7047 / 7393 等其他"主边单据/从边单据"出现处
- **验收证据**：
  - `git diff` 应仅 4 行（标签 1 + 3 勾选框文案）
  - 启动 Electron + 打开 C4 dialog（business 子模式）→ 看到新文案
  - smoke 全过
- **关联 spec**：§2.2
- **预计工作量**：0.1 天
- **风险**：低（纯文案）

---

## T2-2：BillDate ±N 可配置（核心算法改动）

⚠️ **资金红线** — 资金对账核心匹配算法改动，必须人工复核 + 完整 smoke 回归

- **涉及文件**（4+）：
  - `src/renderer-dialogs.js`（C4 dialog 新增 BillDate 区 UI + 校验 + tooltip）
  - `src/main-process/scenario-engines/c4-recon-id-fix.js`（`billDateMatches` + 调用链加 `days` 参数）
  - `src/main-process/recon-id-fix-engine.js`（`runReconIdFix` 解 `scenario.config.billDateRange`）
  - `scripts/smoke/recon-id-fix-engine.js` + `recon-id-fix-engine-gateway.js`（新增各 3 用例）
- **实施步骤**（建议拆 2 个 commit）：
  - **commit 1**：引擎接入（`billDateMatches` 加 `days` 形参 + 沿调用链传递 + `runC4Scenario` 默认 days=1 兼容老 config）+ smoke 6 用例
  - **commit 2**：dialog UI（勾选框 + 输入框 + tooltip + 校验）+ preview
- **实施要点**：
  - 引擎：保留 `billDateMode='strict' / '±Nday'` 两阶段；只把硬编码 `86400000`（1 天）改为 `days * 86400000`
  - 默认值：老 config 缺 `billDateRange` 字段 → `{enabled: false, days: 1}` 默认（保留现状 ±1day 容错）
  - dialog 默认显示值：勾选后输入框默认 **3**（PRD §3.3.3）
  - 校验：1-999 正整数；非法值阻止保存
  - tooltip 文案见 spec §2.3.4
- **验收证据**：
  - smoke `recon-id-fix-engine` + `-gateway` 各新增 3 用例（不勾选、N=1、N=5）全过
  - 跨月用例：BillDate 2026-04-28 vs 2026-05-02（差 4 天），N=5 命中 / N=3 不命中
  - 启动 Electron + dialog 勾选 BillDate + 输入 5 + 跑 → 看到扩大命中；不勾选回归 ±1day
  - 老 scenario（无 billDateRange 字段）跑全部 smoke 用例零回归
- **关联 spec**：§2.3
- **预计工作量**：0.8 天
- **风险**：⚠️ 高 — 资金对账核心算法

---

## T3：tooltip 两处

- **涉及文件**：
  - `src/renderer-dialogs.js`
- **实施要点**：
  - line 6855 附近：现 `<span class="scenario-config-label">${isGatewayMode ? '订单修复ID取值' : '修复结果输出'}</span>` 加 tooltip ⓘ
  - 文件顶部新增 2 个常量 `BUSINESS_TOOLTIP` / `GATEWAY_TOOLTIP`（文案见 spec §2.4）
  - 复用原生 `title` 属性或现有 tooltip 组件（如有）
- **验收证据**：
  - hover 鼠标在 ⓘ 上看到 tooltip
  - 切换 business / gateway 子模式时 tooltip 文案对应切换
- **关联 spec**：§2.4
- **预计工作量**：0.2 天
- **风险**：低

---

## T4："跳过 C3 直接运行" 按钮文案

- **涉及文件**：
  - `src/renderer.js`
- **实施要点**：
  - line 3299：`middleText: '跳过 C3 直接运行'` → `middleText: '直接运行'`
- **验收证据**：
  - 启动 Electron + 启用 C3 类场景 + 不导入 gw 文件 + 点开始运行 → 弹三选一 dialog 中间按钮文案为"直接运行"
- **关联 spec**：§2.5
- **预计工作量**：0.05 天
- **风险**：低（一行改）

---

## T5：smoke + preview + 手动回归

- **涉及文件**：
  - `scripts/smoke/recon-id-fix-engine.js`（已在 T2-2 扩用例）
  - `scripts/smoke/recon-id-fix-engine-gateway.js`（已在 T2-2 扩用例）
  - 4 张 C4 preview PNG（`docs/previews/scenario-config-c4*.png`）
- **实施要点**：
  - `npm run smoke` 全 14 子套必须 PASS
  - `npm run preview:scenario-config-c4`（或对应命令）重跑 4 张 C4 dialog 截图
  - 手动回归（按 PRD §6.3）
- **验收证据**：
  - smoke 输出 "smoke test passed"
  - `git diff docs/previews/` 显示 4 张 PNG 已更新
  - 手动测试通过单
- **关联 spec**：§五 + memory [[workflow_frontend_previews]]
- **预计工作量**：0.3 天

---

## T6：文档三件套 + version bump

- **涉及文件**：
  - `package.json` + `package-lock.json`（version 2.1.0-beta.3 → 2.1.1）
  - `CHANGELOG.md`
  - `docs/VERSION_FEATURE_HISTORY.md`
  - `docs/USER_GUIDE.md`（PDF 章节删 + BillDate ±N 章节加）
- **实施要点**：
  - CHANGELOG 顶部新增 v2.1.1 段：
    - **BREAKING**：移除 PDF 导入支持（pdfjs-dist + tesseract.js 整套卸下）
    - 新增：BillDate ±N 可配置（C4 引擎）
    - 优化：C4 dialog 匹配模式文案 / 修复结果输出 + 订单修复ID取值 tooltip / "跳过 C3 直接运行" → "直接运行"
  - VERSION_FEATURE_HISTORY 表格补 v2.1.1 行
  - USER_GUIDE：
    - line 21 删 pdf
    - 新增章节"BillDate 日期范围设置"
- **验收证据**：
  - `package.json` version 字段 = `2.1.1`
  - CHANGELOG 顶部 v2.1.1 段完整
  - VERSION_FEATURE_HISTORY 含 v2.1.1
  - USER_GUIDE 无 pdf 字样
- **关联 spec**：§六
- **预计工作量**：0.3 天

---

## T7：/check-vars + 起 PR 草稿

- **触发节点**：
  - team-lead 提 PR 前（按 memory [[workflow_no_tester_no_auto_pr]]）
  - 合并到 main 前
  - version bump 时
- **涉及文件**：
  - `docs/prs/待merge-PR #N.md`（PR 草稿）
- **实施要点**：
  - 跑 `/check-vars` skill：预期命中 `SUPPORTED_EXTENSIONS` (Critical) + 可能 `templateRepository` / `state` 等
  - 起 PR 草稿到 `docs/prs/待merge-PR #N.md`（PR # 实际 by gh）
  - body 包含 check-vars 输出 + 完整 commit 表 + 风险与人工复核项 + 测试矩阵
  - 等用户明确说"提 PR" → `gh pr create` + 改名草稿
- **验收证据**：
  - check-vars 输出含 `SUPPORTED_EXTENSIONS` 命中 + review 状态
  - PR 草稿落盘
- **关联**：memory [[workflow_archive_pr_draft]] + [[workflow_important_vars_check]]
- **预计工作量**：0.2 天

---

## 任务依赖

```
T1 (PDF 移除) ─┐
T2-1 (文案)   ─┼─→ T5 (smoke + preview) ─→ T6 (文档 + bump) ─→ T7 (check-vars + PR)
T2-2 (BillDate) ┤
T3 (tooltip) ─┤
T4 (按钮)    ─┘
```

T1 / T2-1 / T2-2 / T3 / T4 互相独立，可并行（但同一 dev 串行最稳）。
T5 必须等前 5 个完成（依赖 smoke 含新用例 / preview 含新 UI）。
T6 必须等 T5 完成。
T7 最后跑。

---

## 实施过程记录（占位）

> Dev 执行时反向同步更新本节。
