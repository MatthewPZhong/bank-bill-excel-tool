---
pr_number: 41
title: "[v2.1.1] patch — PDF 整体移除 + C4 dialog 文案优化 + BillDate ±N 可配置 + tooltip + C3 按钮文案"
base: main
head: v2.1.1
created: 2026-05-12
integrated: false
---

# PR #41 — [v2.1.1] patch 迭代

| 字段 | 值 |
|---|---|
| 起源版本 | `main` 当前 `2.1.0-beta.3`（PR #40 已合并，2026-05-12，commit `363fee6`） |
| 目标版本 | `main` 升至 `2.1.1` |
| 分支 | `v2.1.1 → main` |
| 起草日期 | 2026-05-12 |
| commits | 9（PM 1 + T1-T6 主 task 8） |
| 改动量 | src 7 文件 / +81 / -321（PDF 整体移除主导净删 240 行）+ smoke 3 文件 + docs 三件套 + preview 4 张 |
| 关联文档 | `docs/iterations/v2.1.1/{PRD-v2.1.1.md, spec.md, tasks.md}` |

---

## 一、概述

v2.1.0-beta.3 之后的 patch 迭代，4 项独立改动：

1. **T1（破坏性）** — PDF 整体移除：删 `pdfjs-dist` + `tesseract.js` 依赖 + `pdf-worker.js` 子进程 + readers.js PDF 分支 + main.js dialog filter + USER_GUIDE PDF 说明；`SUPPORTED_EXTENSIONS` 删 `.pdf`
2. **T2-1** — C4 dialog "匹配规则" → "匹配模式" + 3 勾选框 "主边/从边"（business 子模式；gateway 不动）
3. **T2-2** — C4 引擎 BillDate ±N 可配置（取代硬编码 ±1day）+ dialog UI（勾选框 + 1-999 输入框 + tooltip）+ smoke 扩展
4. **T3** — "修复结果输出" / "订单修复ID取值" 双 tooltip
5. **T4** — "跳过 C3 直接运行" → "直接运行"
6. **T5+T6** — smoke 全过 + preview 4 张重跑 + 文档三件套 + version bump 2.1.0-beta.3 → 2.1.1

---

## 二、改动总览（commit 列表）

| Commit | Task | 描述 |
|---|---|---|
| 0cf0e4a | PM | PRD + spec + tasks 起草（docs/iterations/v2.1.1/） |
| 424b4fb | T1 | PDF 整体移除（破坏性变更）— 7 文件 / +19 / -500 / 删 4 deps + 17 传递依赖 + 删 pdf-worker.js + readers PDF helper + common.js SUPPORTED_EXTENSIONS / scenarios.js 删 pdfMatchedRows smoke 用例 |
| fc13c1f | T2-1 | C4 dialog "匹配规则" → "匹配模式" + 3 勾选框 "主边 X v Y 从边"（business 子模式；gateway 不动）— 1 文件 / +4 / -4 |
| f1bab6d | T4 | "跳过 C3 直接运行" → "直接运行"（renderer.js:3299）— 1 文件 / +1 / -1 |
| 1572aa0 | T3 | "修复结果输出" / "订单修复ID取值" tooltip — renderer-dialogs.js:6855 加 `.scenario-config-tooltip` ⓘ + business/gateway 双文案 — 1 文件 / +1 / -1 |
| afa8c73 | T2-2 引擎 | BillDate ±N — c4-recon-id-fix.js: billDateMatches(L, R, mode, days=1) 参数化 + 5 处调用传 cfg._billDateDays + runC4Scenario 解析 cfg.billDateRange + smoke business 44/44 / gateway 13/13 — 3 文件 / +147 / -11 |
| 0c8e875 | T2-2 UI | BillDate ±N — dialog UI 勾选框 + 数字输入 (1-999) + tooltip + validateScenarioDraft 校验 + createDefaultScenarioConfig 默认 + dialog event binding — 1 文件 / +40 / -1 |
| 1b3c5b8 | T2-2 layout | BillDate 区独立一行（行 2.5）+ 4 张 C4 preview 重跑（CSS scenario-config-row-mutex 是 column 布局，wrap 难看 → 抽出独立 row） |
| 234d22c | T5+T6 | 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）+ version bump 2.1.0-beta.3 → 2.1.1 |

---

## 三、关键改动

### 3.1 PDF 整体移除（T1）

⚠️ **破坏性变更**：v2.1.0 及之前用户若仍用 PDF 导入会被破坏。CHANGELOG 显著标记 BREAKING。

**移除清单**：

- 依赖：`pdfjs-dist@^5.5.207` / `tesseract.js@^7.0.0` / `@tesseract.js-data/chi_sim@^1.0.0` / `@tesseract.js-data/eng@^1.0.0` （`npm install` 自动同步 lockfile，17 packages removed）
- 文件：`src/backend/file-service/pdf-worker.js`（整文件删除）
- readers.js：
  - 删 `readPdfRows` 函数
  - 删 `shouldStopPdfMatchedRows` / `shouldSkipPdfMatchedRow` helpers
  - 删 `readMatchedRows` 中 `isPdfFile` 参数及内部 PDF 分支
  - 删 `readRowsWithMetadata` 调用 collectMatchedRows 时传 isPdfFile
  - 删 `execFileSync` import（仅 PDF worker 用）
- common.js：`SUPPORTED_EXTENSIONS` 删 `.pdf`（Critical 变量）
- main.js：dialog filter `Excel / CSV / PDF` → `Excel / CSV` + extensions 删 `pdf`
- scripts/smoke/scenarios.js：删 `pdfMatchedRows` 专用 smoke 用例
- USER_GUIDE.md line 21：删 pdf 类型说明
- CHANGELOG.md：v2.1.1 段 BREAKING 标记

### 3.2 C4 dialog 文案优化（T2-1 + T3）

**T2-1 文案改名**（renderer-dialogs.js:6824-6836，business 子模式）：

| 位置 | 改前 | 改后 |
|---|---|---|
| label | 匹配规则 | 匹配模式 |
| checkbox 1 | 主边单据 1 v 1 从边单据 | 主边 1 v 1 从边 |
| checkbox 2 | 主边单据 1 v 多 从边单据 | 主边 1 v 多 从边 |
| checkbox 3 | 主边单据 多 v 1 从边单据 | 主边 多 v 1 从边 |

gateway 子模式（`网关 X v Y 渠道`）保持不变。

**不改**：SubBizType 区 / confirm dialog / error toast 中的 "主边单据/从边单据"（用户拍范围）。

**T3 tooltip**（renderer-dialogs.js:6855）：

```
business 子模式 "修复结果输出" tooltip：
  "指定 ReconID 修复结果写到哪一侧的单据：仅写主边 / 仅写从边 / 主从都写。
   Type 字段会自动标记（1=主边, 2=从边, 3=双向）。"

gateway 子模式 "订单修复ID取值" tooltip：
  "指定网关账单与渠道账单两侧的修复 ID 取自哪一侧的 reconciliationId
   （可选追加 suffix）。"两侧都修复" 时会同时写入两侧。"
```

复用项目现有 `.scenario-config-tooltip` CSS class（已有 styles.css:2900 + styles-gemini-extra.css:2205 定义）。

### 3.3 BillDate ±N 可配置（T2-2）

⚠️ **资金红线** — C4 引擎匹配算法改动，必须人工复核。

#### 算法语义（选项 A）

| 配置 | Step 1（严格）| Step 2/3.2/3'.2（容错）|
|---|---|---|
| 不勾选（缺省） | BillDate 必须相等 | BillDate ±**1** 天（与历史 ±1day 一致，零回归） |
| 勾选 days=N | 同上 | BillDate ±**N** 天（N=1-999） |

Step 1 strict 严格匹配阶段**永远保留**，不受 BillDate ±N 配置影响。

#### 实现

- **billDateMatches**：`billDateMatches(L, R, mode, days = 1)` — days 参数化（默认 1 兼容老调用）
- 改用 `Math.abs(lDate - rDate) <= days * 86400 * 1000`（旧版 `===` → 新版 `<=`，行为差异仅在字符串不同但日期相同的 edge case，新版修复隐性 bug）
- 5 处 billDateMatches 调用点都传 `cfg._billDateDays`
- runC4Scenario 入口：解析 `scenario.config.billDateRange.{enabled, days}` → 注入 `cfg._billDateDays`（不写盘）

#### dialog UI

C4 dialog "匹配模式" 下方独立一行：

```
匹配模式
  ☐ 主边 1v1 从边  ☐ 主边 1v多 从边  ☐ 主边 多v1 从边
BillDate 日期范围 ⓘ
  ☐ BillDate ± [3] Days
```

- 勾选框 `data-c4-bill-date-range-enabled`
- 数字输入 `data-c4-bill-date-range-days`（width 3em / min=1 / max=999）
- 默认 `{ enabled: false, days: 3 }`（勾选后初次显示 3）
- tooltip ⓘ 文案：`"默认 BillDate 容错范围 ±1 天... 勾选后可调整容错窗口为 ±N 天（N=1-999），用于跨日扎单场景。严格匹配阶段不受影响。"`

#### config 兼容

老 scenario.config 无 `billDateRange` 字段：
- 路由层 default `{ enabled: false, days: 3 }`（不写盘）
- 引擎按 enabled=false → days=1（与历史 ±1day 行为零回归）

不需要 DB schema migration（config_json 是 JSON BLOB）。

#### smoke 扩展

- `scripts/smoke/recon-id-fix-engine.js`：billDateMatches 加 4 个 days 单测 + 端到端 `runBillDateRangeWithNDays` 3 sub-case → 业务子模式 44/44 PASS
- `scripts/smoke/recon-id-fix-engine-gateway.js`：Case 9/10/11 BillDate ±N → 网关子模式 13/13 PASS

### 3.4 C3 按钮文案（T4）

`src/renderer.js:3299` `middleText: '跳过 C3 直接运行'` → `'直接运行'`

`message` 主提示保持不变（已把 C3 译成"资金对账不平"）。

---

## 四、测试

### 4.1 smoke（npm run smoke）

✅ **全 14 子套 PASS**：

```
constants sanity: 4/4 PASS
scenario-engines: 23/23 PASS
scenarios-repository: 7/7 PASS
migrations-recon-id-fix: 19/19 PASS
recon-id-fix-scenario-ipc: 11/11 PASS
recon-id-fix-engine: 44/44 PASS    ← +1 BillDate ±N (vs 43)
recon-id-fix-engine-gateway: 13/13 PASS    ← +3 BillDate ±N (vs 10)
recon-id-fix-io: 13/13 PASS
recon-id-fix-ipc-handlers: 21/21 PASS
recon-id-fix-end-to-end: 6/6 PASS
scenario-dispatcher: 15/15 PASS
exceljs-writer: 3/3 PASS
bank-statement-io: 13/13 PASS
scenario-end-to-end: 23/23 PASS
error-causes: 39/39 PASS
usage-stats: 41/41 PASS
```

注：scenarios.js 删 pdfMatchedRows 用例后未独立列入显示（包含在 scenarios 套件内）。

### 4.2 preview 回归

✅ 4 张 C4 dialog 截图重跑（含 BillDate 区）：

- `docs/previews/scenario-config-c4.png`（business）
- `docs/previews/scenario-config-c4-both.png`（business mode=both）
- `docs/previews/scenario-config-c4-gateway.png`（gateway）
- `docs/previews/scenario-config-c4-gateway-1vN.png`（gateway 1v多 网关账单选项禁用态）

### 4.3 待手动回归（合并前必须）

- [ ] **xlsx 导入**：用 .xlsx 文件导入「银行对账单处理」→ 跑场景 → 验证正常（PDF 路径已断）
- [ ] **BillDate ±N 不勾选**：创建一个 C4 场景，不勾 BillDate → 跑跨日 1 天 fixture → 应当命中（与 main 基线行为一致）
- [ ] **BillDate ±N 勾选 N=5**：创建一个 C4 场景，勾 BillDate + days=5 → 跑跨 3 天 fixture → 应当扩大命中
- [ ] **BillDate ±N 勾选 N=1**：创建一个 C4 场景，勾 BillDate + days=1 → 跑跨 3 天 fixture → 应当不命中
- [ ] **tooltip**：C4 dialog 鼠标 hover ⓘ 看到 "修复结果输出" / "BillDate 日期范围" 两个 tooltip
- [ ] **C3 按钮文案**：启用 C3 类场景 + 不导入 gw 文件 + 点开始运行 → 三选一 dialog 中间按钮为"直接运行"

---

## 五、风险与人工复核要点

### 5.1 资金红线（CLAUDE.md 永久规则 #7）

⚠️ **T2-2 BillDate ±N 是资金对账核心算法改动**：

- 不勾选保证零回归（仍按 ±1day 跑）— smoke + 老 config 兼容已验证
- 勾选 + N 扩大容错 → 可能命中本不该匹配的单 → **数据失真风险**
- smoke 已覆盖 N=1 / N=5 + 跨日；建议合并前手动测试跨月（28→2）/ 跨年
- 老场景零回归（不勾选 billDateRange.enabled=false）

### 5.2 兼容性破坏（PDF）

⚠️ **T1 移除 PDF**：

- v2.1.0 及之前用户用 PDF 导入会被破坏
- CHANGELOG.md 顶部 BREAKING 标记
- USER_GUIDE.md line 21 删 PDF 类型说明
- 用户重装后 tesseract 训练数据目录可能仍残留（不主动清理用户数据）

### 5.3 Critical 变量改动

⚠️ **`SUPPORTED_EXTENSIONS`**（`rules/important-variables.md` Critical 层）：

- 从 `['.xlsx', '.xls', '.csv', '.pdf']` → `['.xlsx', '.xls', '.csv']`
- 同步项已全部覆盖：reader 实现 ✓ / main.js dialog filter ✓ / USER_GUIDE 文案 ✓

详见 §六 check-vars 输出。

### 5.4 合并前必读

- [ ] main 当前版本 `2.1.0-beta.3` → 合后变 `2.1.1`（package.json + package-lock.json 已 bump）
- [ ] CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE 三件套已同步
- [ ] 手动回归 6 项见 §4.3 必须完成

---

## 六、check-vars 输出

> 基准：`git diff main...v2.1.1 -- 'src/'`（7 文件 / +81 / -321）
> 时间：2026-05-12

### ⚠️ 关联功能 review（check-vars 自动生成）

本次改动触及以下重要变量：

- **Critical**: `SUPPORTED_EXTENSIONS` / `FileValidationError`
  - **`SUPPORTED_EXTENSIONS`**：从 `['.xlsx', '.xls', '.csv', '.pdf']` 删为 `['.xlsx', '.xls', '.csv']`；已同步 reader 实现 + main.js dialog filter + USER_GUIDE ✅
  - **`FileValidationError`**：仅删除一处 PDF 错误抛出实例（readers.js:39 `'PDF 文件无法识别或不可读'`），未改类定义 / schema ✅
- **Important-skeleton**: `normalizeCell`
  - 8 处删除均在 PDF helper（`shouldStopPdfMatchedRows` / `shouldSkipPdfMatchedRow`）中；未改实现 ✅
- **Risk-sensitive**: `isRowMeaningful`
  - 1 处删除在 PDF 分支中（`return blankrows ? rows : rows.filter((row) => isRowMeaningful(row));`）；未改实现 ✅

**未命中**：Runtime-state（`dialog` 仅匹配 renderer-dialogs.js 局部变量，按表项备注忽略）/ Minor。

### 升格候选（不阻断合并）

- **`billDateMatches`**（`c4-recon-id-fix.js`）— 跨 3 文件（含 smoke business + gateway）
- 语义命中 Risk-sensitive（资金对账核心匹配算法）
- 建议下次 scan-vars 后人工评估是否升格入 Risk-sensitive 段

### 必跑

- [x] `npm run smoke` 全 14 子套 PASS
- [ ] 手动回归 6 项见 §4.3

---

## 七、文档三件套

| 文档 | 状态 |
|---|---|
| CHANGELOG.md | ✅ 新增 v2.1.1 段（BREAKING + 新增 + 变更 + 移除 + Critical 变量改动） |
| VERSION_FEATURE_HISTORY.md | ✅ 补 v2.1.1 段 |
| USER_GUIDE.md | ✅ L21 删 pdf；L596 文案改"匹配模式"；L665 表头 + 新增"行 2.5 BillDate 日期范围"；L668 "修复结果输出" 加 v2.1.1 tooltip 说明 |

---

## 八、合并后下一步

v2.1.1 为 patch GA 版本，合并后：

1. **拉新 tag**：`git tag v2.1.1 main` + `git push origin v2.1.1`（用户操作）
2. **打包发布**：`npm run dist:win` / `npm run dist:win:portable`（如需）
3. **后续迭代**：v2.1.2 / v2.2.0 待用户决定（无强制路线）

---

## 九、PR 草稿状态

- 起草日期：2026-05-12
- 起草节点：Dev 完成 + smoke + preview + 文档三件套 + check-vars 已跑
- **等用户测试 + 明确说"提 PR"** 后 team-lead 执行 `gh pr create`
