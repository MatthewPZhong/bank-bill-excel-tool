# v3.2.5 E13-G Preflight — Manifest / AST Coverage 与策略快照

## Goal / Context / Constraints / Done when

- Goal：以当前生产入口、Action/Task binding、Runtime policy 与发布注册表为权威，建立可执行的
  Action Manifest、静态 coverage、Capability Inventory 和 Effective Production Strategy Snapshot。
- Context：E13-C 已把真实 Acquiring copy/regenerate binding 从历史 60 对修正为 59 对；E13-A～F
  又新增了 dormant capability。E13-G 盲区复核进一步发现冻结 Spec 明确延后的
  `pre-fund:bank-import`、`pre-fund:run` 未被旧 action inventory 独立表达，因此 current authority
  应为“移除 1 条 stale Acquiring pair、补入 2 条 PreFund pair”的 54 actions / 61 pairs。
- Constraints：不能靠重算 checksum、放宽 AST gate 或把 capability 等同 production；不能伪称
  `position-reconciliation:run:import-result` 已经路由到 Position adapter；人工资金/恢复红线必须保持
  `PENDING_HUMAN_REVIEW`；不运行 `release-check`、`check-vars` 或 `scan:vars`。
- Done when：当前 54 个 canonical action 和 61 个 legacy pair 均有独立静态证据；Runtime 的 36 个
  capability、16 个 legacy-only action 与 2 个 platform canary action 全量入表；coverage=100%；策略快照逐 action 如实显示
  legacy/0 worker；负向 mutant fail closed；current-tree validation 29/29、package checksum 69/69。

## 已确认事实

| 事实 | 当前证据 | 对方案的约束 |
| --- | --- | --- |
| 生产 binding 为 54 actions / 61 pairs / 54 bound / 68 unbound | `action-task-binding-registry.js` contract digest `5c9ee534…9ff2` | 独立 authority 必须走受控 revision，旧 60-pair fixture 与中间 52-action snapshot 均不得继续充当 current authority。 |
| Runtime 当前注册 36 个 policy | `BACKGROUND_EXECUTION_POLICIES` | Capability Inventory 必须覆盖这 36 个，并显式列出其余 16 个 legacy-only action和 2 个 platform canary action。 |
| PreFund bank import/run 是冻结 Spec 明确列出的延后入口 | `spec.md` §7 E13-G 与真实 TaskPolicy keys `pre-fund-reconciliation:import-bank`、`pre-fund-reconciliation:run` | 两者必须各自拥有 canonical action、legacy pair 与 effective legacy 策略，不能由 MPT/export action 代偿。 |
| 36 个 policy 全部 `production.enabled=false`、effective legacy、worker=0 | 当前 policy 对象 | Snapshot 不得把已实现 worker/pool 写成生产启用。 |
| `position-reconciliation:run:import-result` 仍是 legacy Main handler | E13-F preflight 与当前 Main 调用链 | Handler provenance 与 capability provenance 必须分栏，不能伪造 adapter route。 |
| 当前树校验为 26/29 | `current-tree-validation-before.json` | 失败集中在 binding/provenance authority、authority anchor、manifest hash coverage；其余 26 项仍通过。 |
| Contract Authority v1 支持受控语义变化 | validator `evaluate_authority_transition()` | 当前 revision 必须从 1 精确升为 2、`genesis=false`，人工状态仍 PENDING。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 当前决定 |
| --- | --- | --- | --- | --- |
| 旧 60-pair fixture 是否可以直接覆盖 | 合同边界 | 高 | PROBE → CLOSED | 不把旧 report 改写成历史 PASS；current authority 走 rev2，报告记录 merge-base rev1。 |
| 54 actions 是否都必须拥有 Runtime policy | 范围 | 高 | PROBE → CLOSED | 否；36 capability + 16 legacy-only + 2 platform canary，但六个 coverage surface 必须 54/54。 |
| handler coverage 能否从 binding snapshot 自生 | 证据独立性 | 高 | PROBE → CLOSED | 不能；使用模块私有 54-action/61-pair静态 inventory，再与生产 binding exact 比较。 |
| PreFund MPT/export 是否可代表 bank import/run | 入口旁路 | 高 | PROBE → CLOSED | 不能；四者对应不同 Main/TaskPolicy 入口，补入两个独立 legacy-only action，并用反例测试锁定。 |
| capability policy 是否证明默认 IPC 已切路 | 入口旁路 | 高 | PROBE → CLOSED | 不能；handler route 一律按当前 legacy Main 证据记录，Capability 单独表达 dormant seam。 |
| benchmark/feature flag 缺失时如何展示 | 发布语义 | 中 | ASSUME（保守） | featureFlag=false、threshold=null、benchmarkEvidenceId 取 policy；缺值不推导启用。 |
| 资金/恢复人工复核能否由 validation 代替 | 红线 | 高 | BLOCK（production） | 不能；rev2 technical PASS 仍 mergeReady=false、productionEnablementAllowed=false。 |

## 风险优先计划

| 顺序 | 步骤 | 证明/保护 | 失败处理 |
| --- | --- | --- | --- |
| 1 | 建立独立 action/pair inventory 与 coverage core | 阻断 forward snapshot 自授权、重复/缺失/替换 | 任一集合差异 fail closed。 |
| 2 | 生成 Capability 与 Effective Strategy 两份快照 | 阻断 capability=production 的错误推导 | 字段/集合/production mismatch fail closed。 |
| 3 | 加入 handler/FilePlan/Registry/Inspector/Publisher 负向 mutants | 验证六个 surface 100% 且关键恢复/发布引用完整 | mutant 未失败则不进入 authority 更新。 |
| 4 | 受控更新 rev2 authority、provenance、文档与报告 | 让 current tree 29/29，而非伪造 checksum | transition/文档/hash 任一失败则停止。 |
| 5 | 最后重建 package checksum | 只对已通过语义 gate 的最终 bytes 做完整性证明 | 69/69 前不进入 R3.2.5。 |

按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目不得记录为 PASS。
