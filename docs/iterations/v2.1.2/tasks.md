# tasks — v2.1.2 任务拆分

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（2026-05-12，基于 spec v0.1） |
| 关联 spec | `spec.md` |
| 关联 PRD | `PRD-v2.1.2.md` |
| 工作分支 | `v2.1.2` |
| 起草人 | team-lead |
| 总任务数 | 19（T1：3，T2：12，T3：4） |

---

## 任务分组与依赖图

```
[T1 文案]                  [T2 后端]                        [T2 前端]              [T3 收尾]
  T1.1                       T2.1 (migrations)              T2.9 (HTML)
  T1.2                         ↓                              ↓                    T3.1 (version bump)
  T1.3 (preview)              T2.2 (columns.js)             T2.10 (renderer)        ↓
                                ↓                              ↓                    T3.2 (scan:vars)
                              T2.3 (reader)                   T2.11 (异常弹窗)        ↓
                              T2.4 (month-repo)               T2.12 (preload)        T3.3 (/check-vars)
                              T2.5 (run-repo)                                          ↓
                                ↓                                                    T3.4 (PR 草稿)
                              T2.6 (session+算法) ← 资金红线
                                ↓
                              T2.7 (writer)
                                ↓
                              T2.8 (IPC handler)
                                ↓
                              T2.13 (smoke A/B/C/D)
                              T2.14 (preview)
                              T2.15 (USER_GUIDE)
                              T2.16 (CHANGELOG + VFH)
```

---

## T1 — C4 dialog 文案变更

### T1.1：renderer-dialogs.js 文案替换（22 处）

- **文件**：`src/renderer-dialogs.js`
- **范围**：spec §2.2 表格列出的 22 处精确行号（5868 / 5872 / 5876 / 5878 / 5887 / 5888 / 5896 / 5899 / 5918 / 5922 / 5924 / 5927 / 5929 / 6867 / 6870 / 6874 / 6877 / 7420 / 7421 / 7425 / 7443 / 7458）
- **不动**：spec §2.4 列出的 6 处 C1/C2 dialog 文案 + 内部变量名 `billTypes / reconFields / reconGroups / billTypeSeqs`
- **完成证据**：
  - `grep -n "新增账单类型\|新增对账分组" src/renderer-dialogs.js` 结果只在 line 6497 / 6504（C2 dialog）出现，C4 区域 0 命中
  - `grep -n "新增对账字段\|新增对账内容分组" src/renderer-dialogs.js` 在 C4 区域有 2 处命中
- **commit message**：`[v2.1.2] feat(t1): C4 dialog 文案变更 — 账单类型→对账字段、对账字段→对账内容`
- **预估**：S（~30 分钟）

### T1.2：注释同步（2 处）

- **文件**：`src/renderer-dialogs.js`
- **行号**：7138 + 7237（spec §2.3）
- **完成证据**：grep 注释新文案有 2 处命中
- **commit message**：`[v2.1.2] docs(t1): C4 dialog 内部注释同步新文案`
- **预估**：XS（5 分钟，与 T1.1 同一 commit 也可）

### T1.3：preview 重跑（C4 4 张 + C1/C2 兜底）

- **文件**：4 张 C4 dialog preview（business / gateway / 1vN / 主从都修复）
- **完成证据**：
  - 4 张截图在 `assets/preview-recon-id-fix-*.png` 更新；diff 显示文案变更
  - C1/C2 dialog 兜底 preview 跑一遍，diff 应为 0（未误改）
- **commit message**：`[v2.1.2] chore(t1): C4 dialog preview 重跑（4 张截图）`
- **预估**：S（依赖 preview 脚本现状）

---

## T2 — 新模块「月度银行对账单BU回填校验」

### T2.1：SQLite migrations（3 张表）

- **文件**：`src/backend/database/migrations.js`
- **内容**：spec §3.4.1 / §3.4.2 / §3.4.3 三张 CREATE TABLE + 索引（IF NOT EXISTS 幂等）
- **完成证据**：
  - 启动 app → SQLite 浏览工具确认 3 张表存在 + 索引齐全
  - 重启 app → 不报"table already exists"（幂等）
- **commit message**：`[v2.1.2] feat(t2.1): SQLite migrations — bank_bu_recon_* 3 张表`
- **预估**：S
- **依赖**：—

### T2.2：columns.js 列定义常量

- **文件（新建）**：`src/backend/bank-bu-recon-db/columns.js`
- **导出**：
  - `PENDING_GUANLI_HEADERS`（Object.freeze 的 20 列原始表头数组）
  - `BANK_HEADERS`（Object.freeze 的 44 列原始表头数组）
  - `PENDING_GUANLI_DB_COLUMNS`（20 列 snake_case DB 列名数组，与 §3.4.1 字段对齐）
  - `BANK_DB_COLUMNS`（44 列 snake_case DB 列名数组）
  - `pendingHeaderToDbColumn(header)` / `bankHeaderToDbColumn(header)` 映射函数
- **完成证据**：
  - 单元自检：`PENDING_GUANLI_HEADERS.length === 20 && BANK_HEADERS.length === 44`
  - 表头与 spec §3.2 严格一致
- **commit message**：`[v2.1.2] feat(t2.2): bank-bu-recon-db/columns.js — 20+44 列定义常量`
- **预估**：S
- **依赖**：—（与 T2.1 平行）

### T2.3：导入 reader + validator

- **文件（新建）**：
  - `src/backend/bank-bu-recon-import/reader.js`（用 `xlsx`/SheetJS 读第一个 sheet 表头 + 数据）
  - `src/backend/bank-bu-recon-import/validator.js`（spec §3.11 表头校验）
- **行为**：
  - 读取参数：`{filePath, kind: 'pending' | 'bank'}`
  - 返回 `{ok, rows, errors}` — rows 已按 DB 列名映射好
  - 表头不匹配 → 抛 `FileValidationError`（参照 `src/backend/file-service/common.js`）
- **完成证据**：
  - 用 `assets/Pending数据管理.xlsx`（空数据） + `assets/银行对账单.xlsx`（空数据）测试 → ok=true, rows=[]
  - 故意删一列表头 → ok=false, error 文本精确指出列名
- **commit message**：`[v2.1.2] feat(t2.3): bank-bu-recon-import reader + validator`
- **预估**：M
- **依赖**：T2.2

### T2.4：month-repository

- **文件（新建）**：`src/backend/bank-bu-recon-db/month-repository.js`
- **导出函数**：
  - `listMonths(db)` → `[{yearMonth, pendingCount, bankCount, latestRun}]`
  - `getMonthMeta(db, yearMonth)` → `{pendingCount, bankCount}`
  - `clearMonth(db, yearMonth)` — 重新导入前清空（事务）
  - `insertPendingRows(db, yearMonth, rows)` — 批量插入（事务 + prepared stmt）
  - `insertBankRows(db, yearMonth, rows)` — 同上
  - `getPendingRows(db, yearMonth)` / `getBankRows(db, yearMonth)` — 用于对账算法读取
- **完成证据**：smoke 用例 A/B/C/D 跑通即视为 ok
- **commit message**：`[v2.1.2] feat(t2.4): bank-bu-recon-db/month-repository`
- **预估**：M
- **依赖**：T2.1 + T2.2

### T2.5：run-repository

- **文件（新建）**：`src/backend/bank-bu-recon-db/run-repository.js`
- **导出函数**：
  - `insertRun(db, {yearMonth, status, stats, anomalyReportPath, exportPath})` → runId
  - `listRuns(db, yearMonth)` → `[runs DESC]`
  - `getLatestRun(db, yearMonth)` → run 或 null
- **完成证据**：smoke 用例可读到运行记录
- **commit message**：`[v2.1.2] feat(t2.5): bank-bu-recon-db/run-repository`
- **预估**：S
- **依赖**：T2.1

### T2.6：session + 对账算法（**资金红线**）

- **文件（新建）**：`src/main-process/bank-bu-recon-session.js`
- **核心函数**：
  - `runReconciliation(yearMonth)` — spec §3.6 算法（伪码 → JS 实现）
  - `writeAnomalyReport(yearMonth, anomalies)` — spec §3.8 异常报告 .txt
  - `normalize(v)` — trim + 空值归一（spec §3.6）
- **算法关键点**（**逐字对照 spec §3.6 不打折扣**）：
  - 必须扫完全部异常再中断（不是发现 1 个就停）
  - Pending side / Bank side 各自检查重复
  - 1:1 通过后再做 BU 比较
- **完成证据**：
  - smoke 用例 A：全相等 → bu_diff_count=0
  - smoke 用例 B：部分差异 → bu_diff_count=2
  - smoke 用例 C：1:N → status=failed_anomaly + anomaly 内含具体行号
  - smoke 用例 D：N:1 → status=failed_anomaly
- **commit message**：`[v2.1.2] feat(t2.6): bank-bu-recon session + 严格 1:1 对账算法（资金红线）`
- **预估**：L（最复杂的一块，必须人工 review）
- **依赖**：T2.2 + T2.4 + T2.5
- **⚠️ 风险**：资金红线，PR review 必须人工跑真实数据样本验证

### T2.7：writer（差异表 + 异常报告）

- **文件（新建）**：`src/main-process/bank-bu-recon-writer.js`
- **导出**：
  - `writeDiffWorkbook({...})` — spec §3.7 exceljs 2-sheet 黄底差异表
  - `YELLOW_FILL` 常量复用 `src/main-process/exceljs-writer.js` 风格
- **完成证据**：
  - smoke 用例 B 生成的 xlsx 用 Excel 打开 → 2 sheet 各 5 行 + 黄底 2 行
  - 表头加粗 size 10
- **commit message**：`[v2.1.2] feat(t2.7): bank-bu-recon-writer — exceljs 2-sheet 差异表`
- **预估**：M
- **依赖**：T2.6

### T2.8：main.js IPC handler（8 个）

- **文件**：`src/main.js`（追加，参照 `pending:*` 风格）
- **handler 清单**（spec §3.5）：
  1. `bankBuRecon:months:list`
  2. `bankBuRecon:import:pick-month`
  3. `bankBuRecon:import:pick-files`
  4. `bankBuRecon:import:run`
  5. `bankBuRecon:run`
  6. `bankBuRecon:export`
  7. `bankBuRecon:status`
  8. `bankBuRecon:run:history`
- **完成证据**：
  - `grep "ipcMain.handle('bankBuRecon:" src/main.js` 8 个匹配
  - 每个 handler 都有 try/catch 包装 + 错误返回 `{error: ...}` 标准化结构
- **commit message**：`[v2.1.2] feat(t2.8): main.js IPC handler — bankBuRecon:* 8 个`
- **预估**：M
- **依赖**：T2.3 + T2.4 + T2.5 + T2.6 + T2.7

### T2.9：index.html 主菜单 + 模块面板

- **文件**：`index.html`
- **内容**：spec §3.9.1 HTML + §3.10 主菜单按钮
- **完成证据**：app 启动后能看到导航按钮和（hidden 状态的）模块面板
- **commit message**：`[v2.1.2] feat(t2.9): bank-bu-recon 主菜单按钮 + 模块面板 HTML`
- **预估**：S
- **依赖**：—

### T2.10：renderer.js 模块切换 + 状态机

- **文件**：`src/renderer.js`
- **内容**：spec §3.9.2 状态机 + button enabled/disabled 联动 + 月份 select 渲染 + 调用 8 个 IPC + 状态栏 spark + tone
- **完成证据**：
  - 手动测试：导入 → 运行 → 导出 全流程通
  - 故意构造 1:N 数据：异常中断流程通
- **commit message**：`[v2.1.2] feat(t2.10): renderer.js — bank-bu-recon 模块状态机`
- **预估**：L
- **依赖**：T2.8 + T2.9 + T2.12

### T2.11：异常弹窗 dialog

- **文件**：`src/renderer-dialogs.js`
- **内容**：新建 `createBankBuReconAnomalyDialog({anomalies, totalAnomalies, reportPath})`，复用 recon-id-fix 模块的 batch-error dialog 风格（spec §九.3 决策）
- **完成证据**：1:N / N:1 异常时弹出，显示前 20 条 + 「打开错误报告」按钮工作
- **commit message**：`[v2.1.2] feat(t2.11): bank-bu-recon 数据异常弹窗 dialog`
- **预估**：M
- **依赖**：T2.10

### T2.12：preload.js IPC 暴露

- **文件**：`src/preload.js`
- **内容**：在 `window.desktopApi` 上暴露 8 个 `bankBuRecon.*` 方法
- **完成证据**：renderer.js 可调用 `window.desktopApi.bankBuRecon.runReconciliation(...)` 不报 undefined
- **commit message**：`[v2.1.2] feat(t2.12): preload.js — bankBuRecon API 暴露`
- **预估**：XS
- **依赖**：T2.8

### T2.13：smoke 用例 A / B / C / D

- **文件**：`scripts/smoke-test.js`
- **内容**：spec §四 列出的 4 个用例 — A 全相等无差异 / B 部分 BU 差异 / C 1:N 异常 / D N:1 异常
- **完成证据**：`npm run smoke` 4 个用例全部通过 + 异常用例的 reportPath 实际生成 .txt
- **commit message**：`[v2.1.2] test(t2.13): smoke 用例 A/B/C/D — bank-bu-recon 全流程 + 资金红线`
- **预估**：M
- **依赖**：T2.6 + T2.7

### T2.14：preview script + 4 张截图

- **文件**：
  - `scripts/preview-bank-bu-recon.js`（新建）
  - `package.json` 加 `preview:bank-bu-recon` script
  - `assets/preview-bank-bu-recon-{initial,importing,result,anomaly}.png`（git 入库）
- **完成证据**：4 张截图都生成 + `git diff --stat assets/preview-bank-bu-recon-*` 显示新增
- **commit message**：`[v2.1.2] chore(t2.14): bank-bu-recon preview 入口 + 4 张截图`
- **预估**：M
- **依赖**：T2.10
- **⚠️ memory `workflow_frontend_previews`：前端 PR 前必须重跑这 4 张**

### T2.15：USER_GUIDE 章节

- **文件**：`docs/USER_GUIDE.md`
- **内容**：新增「月度银行对账单BU回填校验」章节（参照 Pending 模块章节风格）— 入口 / 月份选择 / 导入流程 / 运行 / 导出 / 异常处理截图
- **完成证据**：USER_GUIDE 目录追加新章节
- **commit message**：`[v2.1.2] docs(t2.15): USER_GUIDE — 新增月度银行对账单BU回填校验章节`
- **预估**：M
- **依赖**：T2.14（用 preview 截图）

### T2.16：CHANGELOG + VFH

- **文件**：`CHANGELOG.md` + `docs/VERSION_FEATURE_HISTORY.md`
- **内容**：v2.1.2 段落 — T1 文案 + T2 新模块
- **完成证据**：grep `2.1.2` 在 2 个文件里命中
- **commit message**：`[v2.1.2] docs(t2.16): CHANGELOG + VFH 更新 v2.1.2 段落`
- **预估**：S
- **依赖**：T1.* + T2.1-T2.15（最后总结）

---

## T3 — 收尾

### T3.1：version bump 2.1.1 → 2.1.2

- **文件**：`package.json`
- **完成证据**：`node -e "console.log(require('./package.json').version)"` 输出 `2.1.2`
- **commit message**：`[v2.1.2] chore(t3.1): version bump 2.1.1 → 2.1.2`
- **预估**：XS

### T3.2：npm run scan:vars

- **命令**：`npm run scan:vars`
- **完成证据**：
  - `docs/analysis/var-reference-stats.md` 重新生成
  - 评估新符号（spec §七）是否升格 `rules/important-variables.md`
- **commit message**：`[v2.1.2] chore(t3.2): npm run scan:vars 重新生成统计 + 升格评估`
- **预估**：S
- **依赖**：T2.* 全部完成

### T3.3：/check-vars skill

- **触发**：spec memory `workflow_important_vars_check` 硬节点（提 PR 前 + version bump + 合并 main 前）
- **完成证据**：skill 输出的「⚠️ 关联功能 review」段落已粘贴到 PR body 草稿
- **预估**：XS
- **依赖**：T3.1 + T3.2

### T3.4：PR 草稿

- **文件**：`docs/prs/待merge-PR #{N}.md`（N 待定，预计 43）
- **内容**：
  - Summary：T1 + T2 两块
  - Test plan：smoke A/B/C/D + 手动测试 checklist
  - 关联文档：PRD + spec + tasks
  - check-vars 输出（T3.3）
  - 资金红线提醒
- **完成证据**：PR 草稿文件创建，team-lead 等待用户「提 PR」指令
- **commit message**：`[v2.1.2] docs(pr-{N}): 起草 PR 草稿到 docs/prs/`
- **预估**：S
- **依赖**：T3.3
- **memory `workflow_no_tester_no_auto_pr`**：用户手动测试通过 + 显式说"提 PR"后才执行实际 `gh pr create`

---

## 工作量总览（粗估）

| 任务组 | 任务数 | 总预估 |
|---|---|---|
| T1 | 3 | XS + S + S ≈ 1h |
| T2 后端 (T2.1-T2.8) | 8 | S×3 + M×4 + L×1 ≈ 8-10h |
| T2 前端 (T2.9-T2.12) | 4 | S + L + M + XS ≈ 4-5h |
| T2 测试+文档 (T2.13-T2.16) | 4 | M×2 + S + M ≈ 4h |
| T3 | 4 | XS + S + XS + S ≈ 1h |
| **总计** | **23**（注：上面是 19 个 task ID，但实际 T2 拆成更细的子任务） | **~18-21h** |

---

## ⚠️ 风险与红线提醒

| 风险 | 应对 |
|---|---|
| **资金红线**：T2.6 严格 1:1 对账算法 | spec §3.6 伪码逐字对齐；smoke C/D 必须通过；PR review 人工跑真实数据样本 |
| **资金红线**：BU 比较 trim 语义（OPEN ISSUE #5） | normalize() 单元自检 + 用真实数据 BU 字段抽样验证 |
| **资金红线**：异常报告完整性 | T2.6 必须 dump 全部异常（不止前 20）到 .txt 报告 |
| Pending 模块同名风险 | T2 全部命名前缀 `bankBuRecon` / `bank_bu_recon` / `bank-bu-recon`，spec §八 已对齐 |
| 文档三件套漏更新 | T2.15 + T2.16 显式列出，commit message 自检 |
| preview 漏跑（memory `workflow_frontend_previews`） | T2.14 显式拆成独立 task |

---

## 执行顺序建议

按依赖图自上而下：

**阶段 1（后端骨架）**：T2.1 → T2.2 → (T2.3 ‖ T2.4 ‖ T2.5) → T2.6 → T2.7 → T2.8 + T2.12

**阶段 2（前端 UI）**：T2.9 → T2.10 → T2.11

**阶段 3（测试 + 文档）**：T2.13 → T2.14 → T2.15 → T2.16

**阶段 4（文案）**：T1.1 → T1.2 → T1.3（与阶段 1-3 完全独立，可任何时候插入）

**阶段 5（收尾）**：T3.1 → T3.2 → T3.3 → T3.4
