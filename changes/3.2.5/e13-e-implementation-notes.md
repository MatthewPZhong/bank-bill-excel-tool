# v3.2.5 E13-E Implementation Notes

## Baseline

- Goal/spec：[spec.md](./spec.md) §3.2/§6、[techdoc.md](./techdoc.md) §5、
  [implementation-sequence.md](./implementation-sequence.md) E13-E。
- Preflight：[e13-e-preflight.md](./e13-e-preflight.md)。
- Exact local parent：E13-D candidate `dbcdddefdf69bcb98ed3816d61cde22216f219c0`。
- Done when：三条 Acquiring existing-dispatch capability 进入真实 Runtime；import pool、run gate、
  single/resume、side-DB mirror、取消和结果合同零漂移；production/默认 IPC 保持关闭/legacy。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| import 复用 shared big-table handle，run 复用 singleton `runCheckWorkerPool` 与 run-data wrapper | 两条既有执行器已拥有真实 Worker/事务/side-DB mirror；adapter 只应治理，不应重写 | native wrapper Worker；直接调用业务 core；只调用 pool 丢 mirror | 进程拓扑、SQL、事务与 mirror 责任保持原样。 |
| `run-new-eligible` 的 current childrenMax/requestedMaxWorkers 为 8 | 设置允许 1～8，Main 按 CPU/内存 clamp 后可合法传 8 | 沿用历史 fixture 的 4；静默把 5～8 降成 4；超过 4 fail closed | Governor 能精确覆盖现行最大 nested topology；E13-G 重建 current fixture。 |
| `run-single-or-resume` 不声明 compound topology | 该路径 hard gate 永远不创建 nested child；root Worker 已由 phase 计费 | 申领 1 个虚构 child；把 resume 归入 multiworker policy | 资源指标不重复计费，resume 仍强制单 worker。 |
| run adapter 绑定 exact-5 envelope 与 exact-7 legacy batch owner 的共有字段 | 旧 worker/progress 需要 batchId/batchNumber，但 Supervisor policy 只验证 operation exact-5 | 丢弃 exact-7；信任 caller 两套值；只比较 operationKey | identity 分叉在 dispatcher/DB 写入前 fail closed。 |
| resume 只接受 runId selector，并从 Main authority 重新准备当前 plan | blindspot 发现 caller-supplied `resumePlan.dbPath/progress/outputIntent` 可绕过 DB source、owner freshness 与持久 chunkSize 规则 | 直接透传嵌套 plan；只校验 runId；依赖未来 route 自觉 | adapter 重新执行 prepare/freshness，要求 persisted exact-7 owner 和 output intent 与当前任务一致，持久 chunkSize 优先。 |
| 普通 terminal close 不关闭 singleton pool，force terminate 才 shutdown | pool 跨 run 复用，App before-quit/idle cleanup 是既有 owner | 每 job terminal shutdown；adapter 永不支持 hard stop | 保留 warm pool/idle 行为；超时仍可强制终止。 |
| 三条 capability production 保持 false | Windows、真实大样本、资金/恢复人工门禁未关闭 | 以 capability 绿色自动接管 IPC | 默认 handler、op lock、File Task 与用户行为不变。 |

## Deviations

| 原计划/冻结证据 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| `run-new-eligible.resources.compound.childrenMax=4` | current authority=8 | current settings/Main 可合法选择 8；资源声明不能低报实际 topology | 只修资源上限，不改变 workerCount 计算或算法 | 是；冻结基线保留。 |
| `run-single-or-resume` 声明 compound child | `compound=null` | 真实 hard gate 证明 small/resume/forced-single 无 nested child | 消除虚假 child 计费，不改变 root Worker | 是；冻结基线保留。 |
| run policy 只说明 exact-5 operation context | 同时要求 legacy exact-7 batchContext 的共有五字段一致 | 旧 progress/receipt 持久化仍需要 batchId/batchNumber | 收紧 identity，不改变 owner transfer | 是。 |
| 草案直接接受完整 `resumePlan` | 输入改为 `resumeRunId`，adapter 用 Main-owned DB source 重建 plan | 完整 plan 含 dbPath/progress/output authority，且会跳过 legacy 持久 chunkSize 优先规则 | 收紧 dormant capability；默认 IPC 不变，未来 managed route 必须先完成 owner transfer | 是。 |

## Evidence

| 证据 | 当前结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Unknowns/preflight | 已完成，0 个 dormant-implementation BLOCK | 真实 topology、identity、pool lifetime、mirror 与 production gate 已定。 |
| E13-E 定向 | `12/12 PASS` | policy/runtime、真实 Parser Worker/side DB、D31 分类、resume authority/owner/output/chunkSize、mirror、privacy validator。 |
| 重点扩大回归 | `227/227 PASS` | E13-D/E13-E mature adapters、Policy Registry、ResourceGovernor、Supervisor、Acquiring run-data/multiworker/pool 组合保持兼容。 |
| 完整单测 | `6836/6839 PASS`（`0 FAIL`、`3 SKIP`），日志 `logs/unit-tests/unit-20260831-005448.log` | 431 个单测文件；首次隔离运行暴露 action 清单与合同 revision 测试未同步，并因错误依赖树出现历史/Windows 环境失败；修复真实同步缺口并切换到 lockfile 精确 `app-builder-lib 26.15.7` 后完整复跑全绿。 |
| 全量 integration | 53 个脚本、`2488/2488 PASS`（`282902 ms`） | Acquiring、big-table、side DB、recovery、statement/toolbox 与历史端到端合同均通过；runner 自动耗时清单未纳入提交。 |
| Smoke | `npm run smoke` PASS | Acquiring `203/203`、progress `34/34`、pragma `27/27`，以及其余场景/存储/渲染 smoke 全绿。 |
| 静态复核 | 全部变更 JS `node --check` PASS；focused ESLint PASS；`git diff --check` PASS | 无语法、lint 或 whitespace 阻断；最终提交前再复核 staged diff。 |
| Blindspot / reconciliation final pass | dormant implementation 无未关闭 BLOCK；修复 caller resume authority 透传、exact-5/7 owner 分叉、output intent/chunkSize 漂移与结果路径 privacy allowlist | 新增查询仅为 bill 行数只读 gate；匹配、金额/币种、行序、事务、side→Main mirror、cancel/recovery 与默认入口零漂移；资金/恢复人工门禁保持。 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged Worker/pool close/cancel | BLOCK（production） | R3.2.5 Windows CI/人工验证 | 不阻止 dormant capability；阻止 production。 |
| 30 万+真实 run 的 RSS、8-worker 上限与低内存降级 | PROBE | R3.2.5 representative benchmark/观察 | 未完成前 effective strategy 仍 legacy。 |
| 资金/恢复人工样本签字 | BLOCK（production） | 资金/release owner | 不解除 production false。 |
| current manifest/fixture/checksum | PROBE | E13-G 重建并跑 current validation | E13-G 前不得宣称 v3.2.5 package 完成。 |

按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项不得记录为 PASS。
