# v3.2.5 E13-D Implementation Notes

## Baseline

- Goal/spec：[spec.md](./spec.md) §5/§6、[techdoc.md](./techdoc.md) §5、[implementation-sequence.md](./implementation-sequence.md) E13-D。
- Preflight：[e13-d-preflight.md](./e13-d-preflight.md)。
- Exact local parent：E13-C candidate `c0f55e1bc66d5606fab4468a7fb17b27e0649bf7`。
- Done when：Pending/BizOP 两条既有 big-table dispatcher 进入真实 Runtime capability；无 wrapper Worker，Parser topology、事务、幂等身份、取消和恢复零漂移；production/默认 IPC 保持关闭/legacy。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 复用 `createBigTableImportMatureBinding()` 注册两条 `existing-dispatch` policy | 现有 dispatcher 已包含 root engine Worker、Parser children、单 writer 与大事务；再包 native Worker 会重复 spawn/计费 | 新建 adapter Worker；复制 Parser Pool；重写 dispatcher | Runtime 只增加 policy/registry capability；默认 IPC 继续原 session 路径。 |
| admission 前复用 engine 的 `computeMaxParallel()` 并把 Governor 获批 childCount 冻结回传 | 只有相同 topology 算法才能避免 ResourceGovernor 计费和 engine 实际并行数分叉 | 固定 workerCount；engine admission 后再次自行扩容 | CompoundLease 覆盖 root+children；低内存降级后的数值是 engine 最终上限。 |
| Protocol envelope exact-7 `context` 是 engine 唯一任务身份 | 盲区扫描证明 Supervisor 验证 envelope，但旧 engine 原先消费另一份 caller `input.batchContext`，可造成 receipt/recovery 主键分叉 | 信任 caller 两份值会一致；静默以 input 覆盖 envelope；只比 operationKey | adapter 逐字段复核 caller 值并绑定 envelope context；不一致在启动 dispatcher/写 DB 前 fail closed。 |
| 两条 capability 的 production 保持 false | 冻结表曾写 true，但仓库长期策略、默认 IPC 与资金/恢复人工门禁均未关闭 | 以代码完成自动启用；改默认 IPC | 顶层 current Spec reverse-sync，冻结来源不改；effective mode 仍为 legacy。 |
| result validator 只接受 engine 精确五字段 | session 包装结果和 engine terminal 是不同合同；夹带/负数/不可能并行度不能变成成功证据 | 宽松对象校验；复用 session DTO | Runtime terminal 与既有 engine 结果精确对齐。 |

## Deviations

| 原合同/计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 冻结 Spec 将 Pending/BizOP `production.enabled` 写为 `true` | current authority 为 `false + legacy + PENDING_HUMAN_REVIEW` | 用户长期约束和仓库实际生产策略均禁止自动启用 | capability 可验证但不接管用户入口 | 是；冻结基线保留。 |
| 初版 adapter 直接透传 caller `input.batchContext` | 以 envelope exact-7 为 authority，匹配后再注入旧 engine | 初版完整回归后的 blindspot 发现两套任务身份可分叉 | 收紧幂等/恢复合同，不改业务 SQL、事务、行序或成功结果 | 是；Spec/TechDoc 已补精确约束。 |

## Evidence

| 证据 | 当前结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| E13-D + mature adapter 定向回归 | `16/16 PASS` | canonical policy、真实 Runtime、无 wrapper Worker、CompoundLease、真实取消/关机回滚、结果校验与 exact-7 身份反例。 |
| 完整单测 | `6824/6827 PASS`（`0 FAIL`、`3 SKIP`），日志 `logs/unit-tests/unit-20260830-235725.log` | 新共享 binding 后的全仓状态机、协议、资金与发布回归。 |
| 完整 integration | `2488/2488 PASS`（53 scripts，`361809 ms`） | Pending/BizOP engine migration/parity、单事务、行序以及全仓集成；runner 自动同步测试清单。 |
| Smoke | `npm run smoke` PASS | BizOP `171/171`、Acquiring `203/203`、场景/存储/Renderer 等全项目 smoke。 |
| ESLint/语法/diff | `npm run lint` PASS；`node --check` 与 `git diff --check` PASS | 源码装载、风格与补丁完整性。 |
| Production/human gate | 两 action `production.enabled=false`；默认 IPC 未切换；资金/恢复人工复核仍 pending | 自动测试不能授权 production。 |

## Blindspot / Reconciliation

- 输入→执行主键血缘固定为 envelope exact-7 `context` → mature adapter → engine `batchContext` →既有 task/run receipt；caller 不得提供第二套 batchId/taskRunId/operationKey。
- 未修改 Pending/BizOP 的 SQL、覆盖删除顺序、金额/币种、行序、ordered writer、事务、side DB、receipt 或 Recovery Hold。
- existing-dispatch 外层不 spawn；实际 topology 仍是一个 root engine Worker 加获批 Parser children。
- shutdown cancellation 继续依赖旧 Worker 的真实取消终态并回滚事务；Supervisor 不伪造 ACK，不重复 settle。
- 默认 IPC/session 继续 legacy；dormant capability 的绿色测试不等于生产启用。
- ⚠️ 资金红线，请人工复核：真实或脱敏 Pending/BizOP 重导样本需核对 batch/task 身份、覆盖删除、行数、金额/币种及恢复证据；自动化不能替代。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged Runtime 的 Worker/取消行为 | BLOCK（production） | R3.2.5 Windows CI/人工验证 | 不阻止 dormant capability；阻止 production。 |
| 真实大文件 RSS、低内存降级与重启恢复 | PROBE | R3.2.5 representative benchmark/观察 | 不阻止 production=false 合并。 |
| 资金/恢复人工样本签字 | BLOCK（production） | 资金/release owner | 不解除 legacy/effective gate。 |
| 最终 action manifest/provenance/checksum | PROBE | E13-G 重建 current authority | E13-G 前不得宣称 v3.2.5 package 完成。 |

按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项不得记录为 PASS。
