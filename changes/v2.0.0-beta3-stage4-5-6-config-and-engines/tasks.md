# Tasks — v2.0.0-beta.3 PR #31：算法引擎

> 实施途中按方案 A 切分：仅算法引擎部分作为 PR #31，UI 部分 + 调度 + IO 全部归 PR #32。

## Task 1 — 字段常量
- 涉及文件：
  - `src/constants/bank-statement-fields.js`（新文件，44 列 + 虚拟"发生额绝对值"）
  - `src/constants/gateway-recon-fields.js`（新文件，31 列）
- 状态：done

## Task 2 — 算法引擎共享 utils
- 涉及文件：`src/main-process/scenario-engines/engine-utils.js`（新文件）
- 操作：normalizeCellValue / parseNumber / evaluateCondition（7 操作符）/ ensureRowId / makeWarningCollector / makeModificationCollector / valuesEqual
- 状态：done

## Task 3 — C1 提取 ReconId 算法
- 涉及文件：`src/main-process/scenario-engines/c1-extract-recon-id.js`
- 操作：buildFeatureRegex + runC1Scenario（特征/其他字段双模式 + 多字段值一致性 + 原值非空 warn）
- 状态：done

## Task 4 — C2 冲销账单打标算法
- 涉及文件：`src/main-process/scenario-engines/c2-offset-bill-mark.js`
- 操作：classifyRowsByBillTypes + 笛卡尔配对 + AND 比对 + 一对多/多对一报错 + 写打标值
- 状态：done

## Task 5 — C3 资金对账 join 算法
- 涉及文件：`src/main-process/scenario-engines/c3-gateway-recon-join.js`
- 操作：getBankRowValueForC3（含发生额绝对值计算）+ 4 字段 AND join + 多行取首 + 写赋值字段
- 状态：done

## Task 6 — 算法入口
- 涉及文件：`src/main-process/scenario-engines/index.js`
- 操作：runScenario(scenario, bankRows, gwRows?) 按 category 分发
- 状态：done

## Task 7 — 算法单元测试
- 操作：18 个边界单测（C1 8 + C2 4 + C3 5 + 入口 1）
- 验证：18/18 PASS
- 状态：done

## Task 8 — smoke + check-vars
- 操作：`npm run smoke` + `npm run check:vars`（确认未退化）
- 状态：done

## Task 9 — 提 PR #31
- 操作：commit + push + gh pr create + Codex review 处理
- 状态：todo

## 移到 PR #32 的工作（不在本 PR 范围）

| 工作 | 原 task ID |
|---|---|
| C1/C2/C3 配置弹窗 dialog factory | 8/9/10 |
| 确认场景详情弹窗 | 11 |
| 接入 PR #30 占位 | 12 |
| CSS 表单布局 | 13 |
| preview state 补充 | 14 |
