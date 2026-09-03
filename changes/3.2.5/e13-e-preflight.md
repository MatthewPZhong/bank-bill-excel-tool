# v3.2.5 E13-E Preflight — Acquiring Mature Adapters

## Goal / Context / Constraints / Done when

- Goal：把 `acquiring:import`、`acquiring:run-new-eligible`、
  `acquiring:run-single-or-resume` 的既有 dispatcher 注册为统一 Protocol/Resource/Lifecycle
  capability，并证明 import pool、multiworker gate、single/resume、side-DB mirror、取消与结果合同零漂移。
- Context：Acquiring import 已有 root engine Worker + Parser Pool；run 已有长驻
  `runCheckWorkerPool`，其内部仅在全新 run、workerCount>1、有 dbPath 且通过 D31 行数/chunk gate
  时再起子 worker。当前 Runtime 尚未注册三条 mature adapter policy。
- Constraints：不改默认 IPC，不新增 wrapper Worker，不复制 Parser Pool，不改 SQL、金额/币种、
  行序、事务、runId、chunk、output intent、side-DB mirror 或 resume owner transfer；production、
  资金与恢复人工门禁保持关闭。
- Done when：三条 policy、adapter、topology 与 result validator 进入真实 Runtime；定向测试证明
  Main-owned identity、真实 gate、CompoundLease、单/多 worker 分类、resume 强制单 worker、取消和
  side-DB mirror 等价；默认 IPC/production 不变。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| import 实际 topology 是 root engine Worker + Parser children，默认并行上限 4 | `big-table-import-dispatch.js`、`big-table-import/pipeline.js#computeMaxParallel` | 复用 shared dispatch handle；compound childrenMax=4；不得再包 Worker。 |
| run root Worker 由 singleton pool 长驻，子 worker 只在 D31 gate 通过后创建 | `run-check-worker-pool.js`、`acquiring-bill-currency-session.js#runCheckCore` | adapter close 不得每 job shutdown pool；force terminate 才关闭；gate 必须 admission 前用相同证据复核。 |
| 当前设置允许 workerCount 1～8，Main 再做 CPU/2GB 内存 clamp | `settings-repository.js`、`main.js` run handler | `run-new-eligible` childrenMax/requestedMaxWorkers 必须为 8，旧 fixture 的 4 已与 current tree 冲突。 |
| resume 永远走 root Worker 单 worker，small/forced-single 也不会创建 nested child | `runCheckCore` 的 `!isResume && workerCount > 1 && dbPath` 硬 gate | `run-single-or-resume` 必须 `compound=null`；不能伪申领 1 个不存在的 child。 |
| run 的 Protocol policy 是 exact-5 operation context，但旧 worker receipt/progress 使用 exact-7 batchContext | canonical fixture、`worker-operation-context.js`、Main run/resume handler | adapter 要求 input.batchContext exact-7，并逐字段匹配两者共有的 exact-5 identity；不能让两套 taskRunId/operationKey 分叉。 |
| `runCheckViaSideDb`/`resumeRunCheck` 在 worker terminal 后维护主库 mirror | `acquiring-bill-currency-run-data.js` | adapter 必须调用现有 wrapper，不能只调 pool promise，否则会丢主库 runs mirror。 |
| legacy resume 由 Main 以 `prepareRunResume/assertRunResumeFresh` 冻结 DB source、progress、owner、output intent，且持久 chunkSize 优先 | `acquiring-bill-currency-run-data.js`、Main resume handler | mature adapter 只能接受 runId selector，并以 Main authority 重新准备；不得采信 caller 嵌套 resume plan。 |
| 默认 IPC 仍承担 op lock、File Task、artifact settlement、owner transfer 与人工 gate | `main.js` run/import/resume tracked handlers | E13-E 仅注册 dormant capability；不在本切片自动切路。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| run-new 的真实 nested child 上限是 4 还是 8 | 已知未知 | 高 | 容易 | 设置明确允许 8，Main 只按 CPU/内存 clamp | PROBE → CLOSED | 静态调用链 + 8-worker topology 单测 | current authority=8；冻结历史 fixture 不改，E13-G 重建 current fixture。 |
| single/resume 是否需要 compound lease | 盲区 | 高 | 容易 | hard gate 证明该路径只有 pool root Worker | PROBE → CLOSED | topology inspector 反例 + runtime lease 指标 | `compound=null`，phase 只计 root Worker。 |
| operation exact-5 如何承接旧 exact-7 receipt owner | 盲区 | 高 | 一般 | Main 现有 File Task 同时拥有 operation/batch context | PROBE → CLOSED | 身份一致/分叉反例 | exact-7 继续作为旧 dispatcher owner；其共有五字段必须匹配 envelope exact-5。 |
| pool cancel 是否能宣称立即 ACK | 已知未知 | 高 | 容易 | `cancel()` 的 true 只证明 message 已投递；真实终态由 CancelError 返回 | PROBE → CLOSED | cancel-before-start / active / post-commit fault tests | 返回未 ACK；只在真实 CancelError 后报告 cancellation terminal。 |
| resumePlan 中的 dbPath/progress/output 是否可由 caller 直接透传 | 盲区 | 高 | 一般 | 原草案把整个 plan 放入 input，会绕过 Main DB authority 与持久 chunkSize 规则 | PROBE → CLOSED | Main resume 调用链 + authority/owner/output 反例 | caller 只给 `resumeRunId`；adapter 重新 prepare/freshness，owner/output 完全匹配且持久 chunkSize 优先。 |
| adapter close 是否应 shutdown singleton pool | 盲区 | 中 | 容易 | legacy pool 跨 run 复用并有 idle cleanup/before-quit owner | PROBE → CLOSED | 两次顺序 dispatch 与 runtime shutdown 测试 | 普通 close no-op；force terminate 才 shutdown；App 原 before-quit 责任不变。 |
| dormant capability 是否可自动接管 IPC | 隐性偏好 | 高 | 困难 | production/人工门禁均未关闭 | BLOCK → CLOSED | 当前 production snapshot | 不切换；保持 `false + legacy + PENDING_HUMAN_REVIEW`。 |

## 保守假设

- R3.2.5 前没有新入口绕过现有 tracked handler；若后续启用 managed route，必须在独立变更中把
  op lock、File Task/FilePlan、resume owner transfer、artifact settlement 和通知语义一并接入并重验。
- `runCheckWorkerPool` 同时只容纳一个 active job 的既有不变量继续由业务 op lock 与 pool 自身校验保护；
  本 adapter 不扩大并发槽位。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 反向同步 current Spec/TechDoc | childrenMax=8、single 无 child、exact-5/7 identity 不再静默冲突 | 文档与代码测试共同锁定 | 错误资源声明会推翻实现 | 仅回退 current 文档 delta，冻结基线不动。 |
| 2 | 注册 false-gated policy/validator | capability/effective strategy 分离、结果 fail closed | registry/runtime 单测 | policy 不可运行或误启用 | 删除新增 registry 项，默认 IPC 无影响。 |
| 3 | 实现 module-specific binding | 不新增 spawn、Main-owned DB/identity、side-DB mirror、pool lifetime | 注入测试 + 真实小样本 | 身份/镜像/取消任一漂移则停止 | 保持 capability dormant；不切 IPC。 |
| 4 | gate/topology/fault 回归 | D31、8-worker upper bound、single/resume、cancel/close | 定向 + 相关既有回归 | 资源或恢复证据不足，不进入 E13-F | 回退 E13-E commit，不影响 E13-A～D。 |

按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`；不得把它们记录为 PASS。
