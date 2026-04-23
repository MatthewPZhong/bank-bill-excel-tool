# Spec — v2.0.0（月度 Pending 数据核对）

> status: apply（PRD v1 定稿，TechDoc v0 完成，待动代码）
> owner: Dev + team
> created: 2026-04-23

## 目标

v2.0.0 第一个需求：新增顶级模块 **月度 Pending 数据核对**。

- 多文件 xlsx 导入 → 按月入库（独立 `tool-data-pending.sqlite`）
- 规则管理（单条全局：对账字段 + 对账内容）
- 对账运算（相邻月份）→ 三类差异（new / missing / changed）→ 落库（保留所有历史 run）
- 导出差异 xlsx（单月选 run，汇总取每月最新 run）

## 范围

### 包含
- 新增 15 个文件（见 TechDoc §二）
- 修改 7 个文件（顶部模块切换 UI 由按钮改下拉；renderer/preload/main 扩 IPC 与 state；CSS 补样式；规则 / 导入 / 对账 / 导出对话框）
- 文档三件套同步（CHANGELOG + VERSION_FEATURE_HISTORY + USER_GUIDE）

### 不包含
- CSV / PDF 导入
- 规则多条具名库
- 单月差异超 105 万行场景
- 非相邻月份对账
- 现有两个模块的业务逻辑修改

## 关联文档

- PRD（v1 定稿）：`docs/iterations/v2.0.0/PRD-v2.0.0.md`
- TechDoc（v0）：`docs/iterations/v2.0.0/TechDoc-v2.0.0.md`
- 任务列表：`changes/v2.0.0/tasks.md`
- 测试清单：`changes/v2.0.0/test-spec.md`
- 实施日志：`changes/v2.0.0/log.md`

## 关键决策（从 PRD §十 摘取）

| # | 决策 |
|---|---|
| OT-1 | Pending 模板 31 列（非用户最初口误的 15 列）|
| OT-2 | 顶部下拉选择不跨启动记忆 |
| OT-3 | 差异 xlsx 表头延续 v1.5.3 Courier New |
| OT-5 | benchmark 固定取样 10000 行，精度 ±20% 可接受 |
| OT-6 | 报错文件 xlsx 格式 |
| OT-8 | changed 比对按值严格相等（非 hash）|
| OT-9 | `pending资金类型` 值枚举校验 {提现/退票/充值}，非枚举整批拒绝 |
| OT-10 | 单月导出支持选 run；汇总取每月最新 run |

## 关键风险（TechDoc §1.2 摘取）

| # | 风险 | 应对 |
|---|---|---|
| R-T1 | 300 万行 SQLite INSERT 性能超 3 分钟 | 批量 transaction + pragma 优化；若仍超汇报用户放宽到 5 分钟 |
| R-T2 | child worker 传 300 万行 JSON 撑爆 IPC | worker 直接写 SQLite，IPC 只传进度/错误元数据 |
| R-T3 | 31 列文本 × 几百万行磁盘大 | 仅 match_fields 动态建索引 |
| R-T4 | 对账 SQL 空值处理 | 用 `IS NOT` 替代 `!=` |
| R-T8 | 规则变更后旧 run 导出兼容 | run 级 rule_snapshot JSON 快照 |

## 验收

PRD §六 的 21 条 AC 全部通过；PRD §七的 P0（13 条）全跑；P1（8 条）至少跑 5 条（含 P1-1 大文件性能）。

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-04-23 | spec 建立；PRD v1 定稿；TechDoc v0 就绪 |
