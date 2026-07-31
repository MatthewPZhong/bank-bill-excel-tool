# v3.1.3 Preflight

## Goal

将平盘银行对账单和五类链接原始表的导入、删除及链接派生重建迁移到有界内存的
`utilityProcess` 流程，避免百万级 Excel 使 Electron main 退出。

## Context

- 基线：`main@db43294`，版本 `3.1.2`。
- 目标版本：`3.1.3`。
- 最终契约：[spec.md](./spec.md)。
- 真实网关出账五文件共 1,339,185 行，位于
  `/Users/pzhong/Desktop/小助手-Debug/3.1.3/2026/出账原始订单/`。

## Constraints

- 银行全批原子、普通来源逐文件部分成功、账户确认后整表替换的事务语义不变。
- 不修改匹配算法、来源主键、状态过滤、金额/币种/日期或派生规则。
- Electron main 不得持有随行数增长的完整行、主键、冲突、派生或 shared strings 集合。
- 新引擎失败不得回退到 Electron main 的 `XLSX.readFile`。
- 本版不承诺百万级运行和导出。

## Done When

以 Spec 第 17 节 AC-01 至 AC-21 为准；自动测试不能替代真实资金数据人工复核。

## Confirmed Facts

| 事实 | 证据 |
| --- | --- |
| 旧 reader 在 main 中全量 `XLSX.readFile` 并物化 rows | `src/main-process/position-reconciliation/readers.js` |
| 普通来源导入后整表读取、整表派生和整表重建链接 | `PositionReconciliationStore.applySourceImport/rebuildLinkedRows` |
| 真实五文件仍可用于压力回放 | 2026-07-30 文件系统只读检查 |
| 正式侧库结构完整且不存在 `(source_row_id, leg_index)` 重复 | 隔离副本 `quick_check=ok`；590 links / 590 sources / 0 duplicate groups |
| 当前依赖已包含 `yauzl`、`sax`、`xlsx` | `package.json` |

## Unknowns Register

| 未知 | 分类 | 影响 | 处置 |
| --- | --- | --- | --- |
| 真实样本全部 cell form 是否与流式 decoder 等价 | PROBE | 对应 sourceType 生产门禁 | PR-B parity 扫描；未证明即 fail closed |
| 300 万行下 main/worker RSS 和磁盘放大系数 | PROBE | 发布性能和磁盘门禁 | PR-E benchmark，超门槛不得放大 heap |
| Windows utilityProcess、取消和文件锁行为 | PROBE | Windows 发布验收 | PR-E Windows 实机验证 |
| 真实资金数据派生和范围替换逐笔正确性 | BLOCK（发布前） | 资金红线 | 自动化完成后由业务负责人抽样复核 |

## Conservative Assumptions

- `3.1.2` 发布收尾未改变平盘导入业务契约；以当前 `main` 重新生成 characterization。
- 现有未跟踪文件均为用户资料，不纳入或清理。
- feature gate 在各 sourceType parity 通过前保持关闭，不做自动 fallback。

