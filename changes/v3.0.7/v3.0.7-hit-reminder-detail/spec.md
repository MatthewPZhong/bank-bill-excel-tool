# Spec — v3.0.7 增量：命中提醒扩展 + 命中明细格式/布局（手测反馈）

> 来源：v3.0.7 手测反馈（2026-06-16）。性质：**纯展示 / 输出格式**，🔴 绝不改任何对账值 / 匹配 / 派生逻辑。
> 目标版本：3.0.7（随主线一起提 PR）。

## 〇、决策（用户已拍板）

| # | 项 | 决定 |
|---|----|------|
| A | run 命中提醒 | 状态框「开始运行」后**新增两行**：「中台加款单脏数据处理」(R5s3) +「中台退款订单回填」(R5s4) 命中数。**显示条件 = 对应场景启用就显示（含「0 条命中」）**。 |
| B | 命中明细格式 | `字段名:旧→新值`（字段名 = 原始英文列名，裸写不包裹；箭头全角 `→`；含数字→中文双引号 `""`、否则→尖括号 `<>`；`wrapHitValue` 规则不变）。 |
| C | 命中明细布局 | **单行紧凑**：多条用 `; ` 连成一行（无换行）；命中明细单元格 `wrapText` 关闭 → **不再撑高行**。 |
| D | 值省略 | **不省略**（完整显示）。 |
| — | 资金红线回归 | **方案C：不改代码** → 文档写明「退款回填务必**一次多选**导入退款单 + 银行单」。 |

## 一、改动文件

- `src/main-process/reconciliation-orchestrator.js`（A：`stats` 新增 `r5s3Enabled`/`r5s4Enabled` = 对应 bucket.length > 0）
- `src/renderer.js`（A：`updateBankStatementUi` 状态框追加两行，按 enabled 决定是否出现）
- `src/main-process/exceljs-writer.js`（B/C：`buildHitDetail` 加字段名前缀 + `→` + `; ` 连接；命中明细单元格 `wrapText:false`；OPEN-7 跨期提醒 append 去掉 `\n`）
- 测试：`tests/unit/main-process/exceljs-writer-dual-sheet.test.js` + orchestrator/renderer 相关单测

## 二、资金红线

- 三需求均纯展示 / 格式：**不动** `modifiedRows` / 匹配 / 派生 / 任何对账值。命中明细只改文本拼接 + 单元格样式；状态框只读 `stats` 的只读统计字段。
- 回归选择不改代码：用户须知「退款回填一次多选导入」。否则**分两次**导 JPM-US 会触发 PR#65「导入新银行单清退款 session」逻辑（`main.js:12098`），run 时退款池空 → 退款回填静默失败、无文件。需求 A 的「0 条命中」展示可作为运行时自检信号（跑了但没命中 = 退款没进）。

## 三、验证

- `npm run release-check`（PASS/FAIL 唯一真相）。
- 命中明细新格式以单测断言锁定（字段名前缀 / `→` / `; ` 单行无 `\n` / 数字 `""` / 英文 `<>`）。
- `/check-vars`（提 PR 前）。
- 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）含本增量 + 回归须知（发版前统一更新）。
