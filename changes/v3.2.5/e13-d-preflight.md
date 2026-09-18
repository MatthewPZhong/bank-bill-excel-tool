# v3.2.5 E13-D Preflight — Pending/BizOP Mature Adapters

## Goal / Context / Constraints / Done when

- Goal：把 `pending:import`、`biz-op:import-flow` 的既有 big-table dispatcher 注册为统一
  Protocol/Resource/Lifecycle capability，证明无额外 spawn，事务、幂等、取消和恢复语义零漂移。
- Context：E02-D 已提供 `createBigTableImportMatureBinding()` 与真实 engine dispatcher；当前
  `background-execution/runtime.js` 尚未注册这两条 policy/adapter，相关 seam 只被单测使用。
- Constraints：不改默认 IPC，不复制 Parser Pool，不改 SQL/删除链/ordered writer/chunk/reducer，
  不让 Supervisor 和既有 dispatcher 重复 settle；production 与资金/恢复人工门禁保持关闭。
- Done when：两条 policy、adapter、topology 和 result validator 进入真实 runtime；真实 runtime
  通过 engine import、CompoundLease、取消回滚、无 wrapper Worker 与 legacy 入口静态回归。

## Unknowns Register

| 未知 | 分类 | 现场证据 | 决策 |
| --- | --- | --- | --- |
| 是否需要新 Worker/新 Parser Pool | BLOCK → CLOSED | `big-table-import-dispatch.js` 已直接启动 root engine Worker，并由 engine 决定 Parser children | 复用 existing-dispatch binding；禁止 native wrapper。 |
| 实际 runtime 是否已注册 adapter | PROBE → CLOSED | runtime policy/adapter registry 不含 Pending/BizOP；`mature-action-adapters.js` 仅在测试/barrel 使用 | 增加真实 policy、adapterRegistry 与相同 topology inspector。 |
| 是否切换现有 IPC | BLOCK → CLOSED | Pending/BizOP session 还承担留底、侧库、失败报告与 legacy 结果转换；生产人工门禁未关闭 | 本切片只注册 dormant capability；默认 IPC 继续直达原 session/dispatcher。 |
| 结果合同是什么 | PROBE → CLOSED | engine 精确返回 `monthKey,fileCount,totalImported,deletedCount,maxParallel` | 增加 exact result validator，不把 session 包装结果误当 engine result。 |
| topology 如何计费 | PROBE → CLOSED | adapter 的 `inspectBigTableImportTopology()` 与 engine 共用 `computeMaxParallel()` | admission 前复用同一 inspector；Governor 可降级且把获批 child 数冻结回传 engine。 |
| envelope 与旧 engine 的任务身份是否可能分叉 | PROBE → CLOSED | Supervisor 只验证 envelope exact-7 `context`；既有 engine 消费 caller-supplied `input.batchContext` | adapter 将已验证 context 绑定为 engine 唯一 batchContext；caller 同时提供时必须逐字段一致，分叉在 dispatcher 启动前 fail closed。 |
| 冻结 Spec 的 production=true 是否可沿用 | BLOCK → CLOSED | 当前长期门禁明确 production 关闭；现有 `MATURE_ACTION_PRODUCTION` 两项均 false | 顶层 current Spec reverse-sync 为 false；冻结基线保留历史不改。 |

## Risk-first Plan

1. 先注册 exact false-gated policy/adapter/topology/validator，保持 IPC 不变。
2. 用真实 runtime + 真实 engine fixture 证明无 wrapper Worker与单事务写入。
3. 复跑既有真实取消回滚、Pending/BizOP migration/parity 与完整允许门禁。
4. 记录资金/恢复人工门禁与 Windows/真实大文件证据为 R3.2.5 remaining gate。

按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`；不得把它们记为 PASS。
