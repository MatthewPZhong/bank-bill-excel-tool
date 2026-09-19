# v3.2.5 E13-F Implementation Notes

## Baseline

- Goal/spec：[spec.md](./spec.md) §3.2/§5、[techdoc.md](./techdoc.md) §5、
  [implementation-sequence.md](./implementation-sequence.md) E13-F。
- Preflight：[e13-f-preflight.md](./e13-f-preflight.md)。
- Exact local parent：E13-E candidate `4d2536187a8e8abcd74a674377fa18bc23859285`。
- Done when：`position:import` existing-dispatch capability 进入真实 Runtime；四 intent 的 topology、Main-owned
  authority、durable grant、取消/恢复与 compact result 可审计；production/默认 IPC 保持 false/legacy。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 直接复用原 Position dispatcher，不新增外层 utility process | 原 dispatcher 已拥有 prepare/apply/grant/recovery、fallback 与 critical protocol | wrapper process；复制 dispatcher；调用业务 core 绕过 transport | 真实进程、事务、checkpoint 与 recovery owner 保持原样。 |
| current compound childrenMax=1，intent 级 child=0/1 | source root 等待 Main grant 时最多并发一个 schema process；其他路径仅 root 或顺序 schema→apply | 沿用冻结 4；所有 intent 申领 1；禁止 zero-child compound | ResourceGovernor 精确计量真实并发；Supervisor 接受 0 但仍拒绝负数与超上限。 |
| exact-5 operation 与 exact-7 File Task owner 共有五字段必须一致 | Supervisor receipt 与 worker mutation/checkpoint 不能使用两套身份 | 只比较 operationKey；由 adapter 生成 batchId；信任 caller 分叉 owner | identity 在 dispatcher/DB mutation 前 fail closed。 |
| caller 只提交 files 或 prepared selector + owner，所有路径/DB/checkpoint/token 由 Main 注入 | prepared preflight 与当前 checkpoint 是 mutation authority；caller 透传会绕过 freshness/kind 约束 | 直接传 preflight/sideDb/checkpoint/token；依赖未来 route 自觉 | adapter 要求绝对 Main-owned路径、完整 preflight evidence、kind 和 operation token。 |
| source durable grant 采用精确 allowlist | grant 跨越 process 边界并授权持久 mutation，provider 附加字段不可泄露或获得隐式语义 | 原样透传 provider object；只检查 token | manifest/schema/checkpoint/owner 完全匹配后才返回六类字段。 |
| cancel 以真实 ACK/terminal 为准，并在 schema/grant 后重查 job-level 请求 | raw `cancel()` true 只表示消息已投递；committing 可 `accepted=false` | posted 即 acknowledged；拒绝即时取消后继续 apply；authorizer 返回后继续 grant | protected 当前单元可完成，但下一安全点不再启动 mutation/grant。 |
| production 与默认 IPC 保持 false/legacy | Main 仍拥有 FilePlan/pending/receipt/人工确认，且 Windows、真实样本、资金/恢复门禁未关闭 | capability 绿色即自动切路 | 本阶段只提供可验证 dormant seam，不改变用户行为。 |

## Deviations

| 原计划/冻结证据 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| `position:import.resources.compound.childrenMax=4` | current childrenMax=1，intent child=0/1 | current dispatcher 最多只在 source grant 期间并发一个 schema process | 修正资源声明，不改变 dispatcher | 是；冻结基线保留。 |
| adapter 泛称映射 cancel | 区分 posted、CANCEL_ACK accepted true/false 与可识别 terminal | protected committing 会拒绝即时取消，posted 不能证明取消完成 | 收紧 lifecycle 证据，不改原 cancel 协议 | 是。 |
| prepared/apply authority 未细化 | 输入收窄为 selector/owner，Main 注入 preflight/side DB/checkpoint/token | 直接透传可绕过 kind/freshness/owner | dormant capability 更严格；未来 route 必须显式接入 Main authority | 是。 |

## Evidence

| 证据 | 当前结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Unknowns/preflight | 已完成；dormant implementation 无未决 BLOCK | 真实 topology、identity、selector/grant、cancel 与 production gate 已定。 |
| E13-F 定向 | 核心 `12/12 PASS`；E13-F/mature/runtime/合同最终组合 `36/36 PASS` | policy/runtime、zero/one child、四 intent 核心绑定、owner/selector/grant、privacy、取消 safe point、非法 preflight/checkpoint/count evidence。 |
| 扩大与完整回归 | 完整单测 `6848/6851 PASS`（`0 FAIL`、`3 SKIP`），日志 `logs/unit-tests/unit-20260831-020452.log`；53 个 integration 脚本 `2488/2488 PASS`（`264007 ms`）；smoke PASS；完整 ESLint、变更 JS `node --check`、`git diff --check` PASS | 首次全量单测仅发现 registry 期望漏列新 action（`1 FAIL`），精确 `10/10 PASS` 后最终全量复跑 `0 FAIL`；未把失败快照作为绿灯。 |
| 历史/Windows 契约 | R3.2.4 历史 exact evidence PASS；Windows build contract `6/8 PASS`、`2 SKIP` | 两个 skip 是只允许专用 Windows 环境显式开启的真实 packaged canary，不得宣称 Windows 实机 PASS。 |
| Blindspot / reconciliation | 已修复 prepared evidence 先验证、绝对 Main-owned 路径、protected schema 后安全点、等待 authorizer 取消后禁发 grant，以及显式负数/非整数 result count 不得静默归零 | 不改 SQL、匹配、金额/币种、行序、事务、checkpoint 或默认 route；production、Windows、真实资金/恢复仍为人工门禁。 |
| 重要变量人工 review | 命中 Critical `freezeWorkerBatchContext` 消费链与 Risk-sensitive Position import/side-DB/checkpoint 合同；exact-seven 字段/校验函数本身未改，Position SQL/side-DB mutation/金额币种/行序/事务未改 | 按用户要求未运行 `check-vars`/`scan:vars`；production 前仍需资金/恢复人工复核。 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Main managed route authority 注入与 FilePlan/pending/receipt 全链路 | BLOCK（production） | 后续独立 route enablement + R3.2.5 人工复核 | 不阻止 dormant E13-F；阻止 production。 |
| `run:import-result` 静态 binding 与实际非-dispatch入口的 provenance | PROBE | E13-G manifest/AST 重建 | E13-G 前不得宣称最终 coverage 完成。 |
| Windows packaged utility/child fallback、真实 Position 文件与取消/恢复 | BLOCK（production） | R3.2.5 Windows/真实样本/人工验证 | 不解除 effective legacy。 |
| 账号映射、checkpoint/幂等、资金与恢复样本签字 | BLOCK（production） | 资金/release owner 人工复核 | 自动测试不得替代人工红线。 |

按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`；这些项目不得记录为 PASS。
