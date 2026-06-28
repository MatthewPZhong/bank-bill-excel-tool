---
pr: 81
version: v3.0.11
merged: (待合并)
integrated: false
---

# [v3.0.11] R5s3入桶Debit门槛 + 链接表导入框文件名换行 + 导出框去error-report + 资金对账导入/运行不阻塞

PR：https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/81 ｜ 分支 `v3.0.11`（基于 main）→ main。

1 项资金红线规则收紧 + 3 项体验/性能需求。team-lead 拆需求 0/1/2/3 委托 dev 实施 + team-lead 审 diff / release-check / 接缝核查 / preview 兜底。需求 3 异步化经确认「分批·导出独立」：本 PR 只交付**导入+运行不阻塞**，**导出流式化拆独立批次**。用户已手动测试通过。

Spec：`changes/r5s3-debit-zero-bucket-gate/spec.md` ｜ `changes/bank-statement-async-import-run/spec.md`。

## 一、改动清单（4 需求）

| # | 项 | 性质 | 核心改动 |
|---|----|------|---------|
| 需求0 | R5s3 中台加款单脏数据处理：银行行入桶加 Debit 门槛 | 🔴 资金红线 | `r5-platform-inbound-cleanup.js` 入桶循环顶端加 `parseNumber(bank['Debit Amount'])` 门槛（**口径B**：`null`(空/空白/非数字) 或 `0`(含 `0.00`/`-0`) 才入桶、真实非零借方排除；一级 `ReconciliationId`/二级 `ChannelOrderNo` 双桶一致）。= Credit 消歧 O-1「有值」对称取反。剔除文件列结构不变、仅命中行可能减少（有借方发生额的脏行不再被误当入金剔除）；`buildCleanupRow`/FundType 子串触发方向/默认配置不变，`modifications` 恒 `[]` |
| 需求1 | 链接表导入提醒框长文件名截断修复 | 🟢 前端 | `styles-gemini-extra.css` `.alert-message` 加 `overflow-wrap: anywhere; word-break: break-word;`，长文件名换行完整显示（未动共用 `.alert-card` 宽度，零外溢影响其它弹框） |
| 需求2 | 资金对账导出成功框移除 error-report 显示行 | 🟢 前端 | `renderer.js` `updateBankStatementUi` 已导出分支删 `\nerror-report：${ex.errorReportName}` 行；error-report 文件生成链路（`writeErrorReportOutput`→`error-reports/{date}/`）不动 |
| 需求3 批1+批2 | 资金对账「导入/运行」不阻塞 + 统一防重入锁 + 按钮禁用 | 🔴 资金红线 | **批1**：`main.js` 统一互斥锁 `bankStatementOperationLock`（import/run/export 一把锁 + finally 释放，争用返回「正在处理中…」）+ 导入 `setImmediate` 让出 + 进度通道 `bank-statement:import:progress`（preload `onImportProgress` + renderer `formatBankStatementImportProgress`）+ `state.bankStatementInflight` 按钮禁用闸。**批2**：run 数据准备步骤边界插 `yieldRun('prepare-clone-bank'/'prepare-gw'/'prepare-linked')`（🔴 不在 `structuredClone` 中途让出、不删 clone）。`processingResult` 末尾一次性赋值 + export snapshot 拒绝保留；**不碰任何 writer、产物 golden 字节级一致**。**导出流式化（批3+批4）拆独立批次** |

## 二、改动文件

- **代码**：`src/main-process/scenario-engines/r5-platform-inbound-cleanup.js`（需求0）/ `src/main.js`（需求3 op-lock + 导入让出/进度 + run yield）/ `src/preload.js`（需求3 `onImportProgress`）/ `src/renderer.js`（需求2 删 error-report + 需求3 按钮闸/进度）/ `src/styles-gemini-extra.css`（需求1）
- **测试**：`tests/unit/bank-statement-op-lock.test.js`（**新增**，源码接线 + 抽真实实现验三动作互斥/可重入）/ `tests/unit/main-process/scenario-engines/r5-platform-inbound-cleanup.test.js`（需求0 重做：多候选适配过门槛 + 门槛边界 + 门槛×fallback×1v1）/ `tests/unit/renderer-status-box-text.test.js`（需求2 断言反转）
- **Spec**：`changes/r5s3-debit-zero-bucket-gate/spec.md`（**新增**）/ `changes/bank-statement-async-import-run/spec.md`（**新增**，含批3+批4 导出流式化设计）
- **文档**：`CHANGELOG.md` / `docs/VERSION_FEATURE_HISTORY.md` / `docs/USER_GUIDE.md`（用户视角去术语）/ `docs/analysis/var-reference-stats.{md,json}`（scan:vars 刷新）/ `docs/previews/main-page.png`（preview 重渲染）

## 三、验证

- `npm run release-check` 全绿：**lint + smoke + unit 3218/3218 + integration 1728/1728（36 脚本）**。
- `check:vars` 无 Critical/Risk-sensitive 命中（Important-skeleton 1 `ipcRenderer` + Runtime-state 8：均为需求3 触及的会话态/IPC，op-lock 强化并发安全、未改 session 写入/清空时机，自查见 PR body「关联功能 review」）。
- `scan:vars` 已刷新；前端 preview 无回归；用户手动测试通过（大文件不卡、按钮禁用、文件名换行、导出框无 error-report、需求0 真实数据核对）。

## 四、codex review + self-review（review-fix，2026-06-28）

提 PR 后做了一轮 codex review（`codex exec review --base main`）+ 一轮 team-lead self-review，修复 2 项真问题：

- **P2（codex · 🔴 资金红线）run 数据准备 linked-table 读取原子性**：批2 原在 linked-table 多步读取间插 `prepare-gw`/`prepare-linked` 让出，而 `linked-table:import`/`delete-by-date-range` 不在 `bankStatementOperationLock` 内 → 并发改动会让 run 把「改动前 gw」与「改动后 deposit/mid/recon」拼成从未真实存在的状态、存错 `processingResult`。**修复**：移除这两处内嵌让出，linked-table 多步读取保持原子；保留 `prepare-clone-bank`（在 linked-table 读取之前、银行 session 受 op-lock 护，安全）。
- **P3（codex）导入按钮 UI 刷新复活**：中央 `updateBankStatementUi` 原无条件 `importBtn.disabled=false`，运行/导出期 UI 刷新（如切回本模块）会复活导入按钮 → 点导入被 op-lock 拒后其 finally 清掉共享 `bankStatementInflight` → 运行/导出按钮中途复活。**修复**：导入按钮 disabled 也受 `state.bankStatementInflight` 约束。
- self-review nit（非 bug，保留）：import handler op-lock acquire 后、`try` 前夹了不可能抛的进度转发器 IIFE；不可达故不改，记录备查。

修复后 `release-check` 复跑全绿；改动仅控制流 / UI 闸，产物零变化。

## 五、延后（独立批次）

资金对账「导出文件」流式化（需求 3 批3+批4 · 🔴 资金红线）：`ExcelJS.stream.xlsx.WorkbookWriter` + 分块让出 + golden 字节级一致校验，拆独立批次/PR。设计见 `changes/bank-statement-async-import-run/spec.md`。
