# E09-A Statement Service Unknowns Preflight

## Task Brief

- Goal：仅实现 frozen v3.2.3 sequence 的 E09-A：由长驻 native `thread-single` Statement Service Worker 唯一持有 import/session/revision 大状态，并通过真实 Service Control reservation handshake 原子采用候选 session。
- Context：本次 restack 精确 base 为 E09-P0 三轮闭环 `c392b297f3dde5702e6b49a34787443b9ccf005a`；旧 E09-A 的两笔独有提交从旧 P0 base 分叉，按原顺序移植；live IPC 继续 legacy。
- Constraints：Main 不接收或解析业务行；只持 `serviceGeneration`、`sessionRevision`、bounded DTO 和 source/template resource identity。E09-B token/waiting-user、E09-C generation/Publisher、E09-D manual seed、NewAccount 与 production enable 均不做。不得复制金额算法，不运行 `release-check`、`check-vars`、`scan:vars`。
- Done when：真实 `ServiceHost/Supervisor/Worker entry` 覆盖两次 import 的 batch/revision 稳定演进、grant/adopt-ack 前不可见、reject/adopt failure 保留旧 session、取消/替换失败/crash/bounded status；legacy live 与 production=false 静态门禁、四金额/币种/current-all characterization 不漂移；定向 unit/integration、`node --check`、ESLint、`git diff --check` 通过或如实记录环境阻断。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 隔离 worktree/branch 从 P0 exact head 创建且初始干净 | `/private/tmp/bbet-v323-e09a-restack.20260829a`；`codex/v3.2.3-e09-a-statement-service-restacked`；初始 HEAD `c392b297f3dde5702e6b49a34787443b9ccf005a` | 不改写原 E09-A 分支；只顺序移植 `df22be5b`、`04b6ca3f` 与必要兼容证据 |
| P0 closure 新增 overwrite exact union、legacy mismatch sanitize、240/256 KiB、alias/privacy、六 globals 与 current/all golden | P0 contracts/probe/golden 三组 tests；`git range-diff` 的第一笔仅出现预期 P0 contract 叠加，第二笔补丁等价 | E09-A import/status union 不得放宽 interaction-required；overwrite 仍仅允许 `statement:resolve-manual-balance` |
| E09-P0 已冻结 `STATEMENT_RESOURCE_CONTRACT`、strict public/status DTO、deterministic footprint 与 legacy golden | `src/main-process/statement-worker/{contracts,state-footprint,probe-state-builder}.js`；三组 E09-P0 tests | E09-A 必须直接复用，不能另造预算、DTO 或金额实现 |
| Platform `ServiceHost` 已实现真实 `persistent-state-replace` request/grant/adopted/adopt-ack 与 governor atomic replacement | `src/main-process/background-execution/service-host.js#processResourceRequest/#processAdopted`；resource governor replacement tests | Worker 必须走 Service Control；不得直接持 governor 或本地假 ack |
| frozen policy 的五个 `statement:*` 共用 `service.statement`、native `thread-single`、service lifetime，production 均 false/effective legacy/0 | canonical `policy-registry.v3.2.x.json`；v3.2.3 Spec §3 | entry 必须可被同一 service profile 解析；live/flag 不切换 |
| 现有金额、币种、row metadata 由 `file-service.buildMappedRows` 生成；session append/current/all 已有单一实现 | `src/backend/file-service.js#buildMappedRows`；`src/main-process/statement-session.js` | Worker 组合/调用这些 production functions，不复制金额算法 |
| legacy picker/file evidence 已冻结 regular-file source snapshot，execute 前由 FilePlan freshness guard 复核 | `src/main.js#captureStatementSourceSelections/#buildStatementInputFilePlanItems/#runWithStatementConfirmedSourceSnapshots` | managed import request 只携 source identity/snapshot；Worker 自己在解析前后 fail closed 复核 |
| E09-P0 明确大账号与 manual balance private context 属后续 token seam | E09-P0 preflight/implementation notes；v3.2.3 PR sequence | 本轮只保留 Service 私有 future seam/blocked 结果，不创建 token Map、UI 或 continuation |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| managed import 的最小输入如何同时证明 source/template evidence 且不把业务行送回 Main | 数据所有权/公共契约 | 高 | 一般 | legacy FilePlan snapshot；P0 public/private split；TechDoc §5 | PROBE | strict request validator + Worker 内真实文件读取测试；协议捕获递归扫描 rows/path/private | Job 只传 opaque `resourceId` + stat snapshot，template 只传 canonical config snapshot+digest；Worker 通过私有 resource resolver 获取路径，重算 digest 并在读前后复核 source |
| E09-A 是否需要接管全部 legacy parent/filename/big-account import 分支 | 范围/主流程 | 高 | 一般 | frozen sequence 将 token/interaction 放 E09-B；live仍legacy | PROBE | 对照 Spec PR sequence 与现有 handler branching | 本轮实现 non-interactive import/session adoption core；需要大账号/manual balance 的候选明确 blocked/private seam，不发明交互 |
| reservation reject/adopt failure 时 Worker 如何知道失败并清理 candidate | 状态生命周期 | 高 | 一般 | ServiceHost `resource:reject` 与 adopted exchange；adopt-ack后 replacement 才权威 | PROBE | 真实 governor reject + fault adapter 丢弃/篡改 adopted 的 Supervisor integration | candidate 仅保存在 active job draft；reject/error/cancel丢弃；只有匹配 adopt-ack 后一次性替换 state/revision |
| cancellation 到达 parse 与 reservation 等待阶段的语义 | 并发/失败 | 高 | 容易 | policy capability=`shutdown-only`，Supervisor 支持 `job:cancel/cancel:ack` | PROBE | Worker entry fault hooks/large gated builder 的真实 cancel test | adoption 前取消安全丢弃；已发 adopted 后不伪称 cancelled，等待 authoritative ack/失败 |
| Service crash 后下一代 generation/revision 初值 | 生命周期/兼容 | 中 | 容易 | TechDoc §8：内存 session 不恢复；ServiceHost generation 单调 | PROBE | 同一 Supervisor 强制 terminate 后再次 import/status | generation 增长，新 Worker `sessionRevision=0`；不扫描已发布文件 |
| entry/batch ID 是否需要跨 crash 稳定 | 身份语义 | 中 | 容易 | Spec 只要求 session 内 currentBatchId/entryIds/stable order；session不可恢复 | ASSUME | 对 legacy helper与crash contract取证 | generation 内单调、采用后稳定；crash后旧ID随session一起失效，不做持久化 |
| 现有 policy result validator 仅接受 interaction-required，如何承载 E09-A success summary | 冻结合同/协议 | 高 | 一般 | P0 notes 明确只冻结 interaction result；E09-A需要 bounded summary | PROBE | 扩展同一 action-specific validator并走真实 Protocol/Supervisor | 只为 `statement:import` 增 exact `imported`/`status` bounded result；保留既有 interaction validator与 finance-safe delegate |

## BLOCK 问题

没有需要用户重新选择的 E09-A BLOCK。真实资金样本、Windows packaged 长驻与 production enable 是既有人工/发布门禁，不通过自动测试关闭。

## 已执行或计划执行的 PROBE

1. 已核验 restack exact branch/base/worktree、两笔旧提交拓扑与 canonical Statement policy。
2. 已沿 `file:import` picker → FilePlan evidence → `buildMappedRows` → session append 数据流取证。
3. 计划用真实 `createExecutionSupervisor`、`createServiceHost`、`createResourceGovernor` 与 native Worker entry 执行两次 import、reject/adopt failure、cancel/crash/status。
4. 计划捕获所有 Job/Service Control envelope 与 public result，递归证明无 `detailRows`、prepared rows、private context；status 不公开路径。
5. 计划复跑 E09-P0 legacy golden，证明四金额、币种与 current/all characterization 未漂移。

## 保守假设

- generation 内 entry/batch identity 只需稳定且唯一，不承诺跨 Service crash 恢复；依据是 frozen contract 明确 session 不跨 crash 恢复。
- E09-A 的 production-shape import 只接 non-interactive candidate；大账号/manual balance 上下文保留为 Worker 私有 blocked seam。若后续 E09-B 冻结 continuation 输入，复用本 session/revision，不反向扩张本轮公开 DTO。
- template snapshot 由 Main 从既有 DB 配置读取属于小型 evidence DTO；Worker 对 digest、exact shape 与 source headers复核。Main 不读取源文件业务行，Job 协议不传绝对路径。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 冻结 import request/result/status 与 source/template evidence validator | Main/协议无业务行和private context；证据可重算 | strict正反 tests、byte/privacy tests | 公共边界不可信则停止 runtime | 只保留 preflight，不接 entry |
| 2 | 实现 Worker-private candidate/session state 与现有 mapper/session helper组合 | 金额/币种/row metadata不复制；ID/order/revision稳定 | 真实source workbook两次import characterization | 会推翻 adoption层，停止接ServiceHost | 收缩为纯Worker unit，不改平台 |
| 3 | 实现 Service Control reservation replacement state machine | grant/adopt-ack前不可见；失败保留旧state | 真实Host/Governor integration + handshake trace | 原子性不成立则阻断E09-A | 删除entry接线，保留contract/probe |
| 4 | 补 cancel、reject、adopt fault、crash/status | 生命周期与bounded可观测性 | Supervisor/Worker fault matrix | 不关闭对应门禁 | 明确保持blocked，不扩大fallback |
| 5 | 回归 legacy golden与静态production gate | live/资金/current-all零漂移 | E09-P0 tests、policy/static rg、lint/check | 不提交 | 回退越界源码 |
| 6 | blindspot与reconciliation自检、记录证据 | 入口旁路/资损红线/人工门禁透明 | evidence-based checklist | 保留未解决项并停止 | 不宣称review/merge ready |
