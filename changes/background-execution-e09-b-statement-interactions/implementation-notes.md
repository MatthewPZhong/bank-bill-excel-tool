# E09-B Statement Interactions Implementation Notes

## Baseline

- Goal/spec：frozen v3.2.3 Spec §3～§6、§10～§13；TechDoc §2～§5、§8、§10～§12；仅 E09-B pending interaction + waiting-user。
- Exact base：`04b6ca3f1e87c0ddcda4d709fbc95d4a39eba6ad`。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：真实 pending reservation adoption、bounded opaque token、TTL/single-use/stale/invalidation/release、同 TaskRun continuation lock/phase闭环均有定向证据；live/production与资金语义不变。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 仅接 `big-account` interaction，继续保留 manual/scope 后续门禁 | frozen sequence 把 generation/manual seed 分别放 E09-C/D | 本轮提前实现 generation/seed | E09-B 不产生 artifact 或持久资金 mutation |
| token registry 与 private context 只在 Statement Worker | Platform/Main ownership与P0隐私合同 | Main Map 保存 rows/draft；Renderer 回传 rows | Main/Renderer 只见 bounded token/public prompt |
| waiting-user Main coordinator dormant、owner API 注入 | live handler/TaskLifecycle enable 不属于本 PR，但锁生命周期必须形成可测试合同 | 直接修改 current live handler | production路径零变化，后续接线复用同一 coordinator |
| 大账号 prompt 与回填按 legacy account block 语义构造 | 同一文件可能有多个重复 header block；按文件一行会错配资金归属 | 每个文件只选一个账号；复制金额算法 | 复用 `buildMappedRows`，仅移植 block 边界与 MerchantId/Currency 注入；continuation 重新读取并核对 candidate digest |
| 新 interaction 先 release/ack 旧 token 再申请新 reservation | 单 Service 一个重 token，session mutation 必须使旧 token 失效 | 超限报错或并存两个 token | mutation race 保持 one-owner/one-token，旧 context 在新 request 前已删除 |
| token `prepare` 阶段先构造最终 public projection/result | Ultra finding 证明合法大 prompt 可在 adopt 后才触发 240 KiB 上限 | grant 后再裁剪；提高 public 上限 | 任何 pending-interaction resource request 前即稳定拒绝，public DTO 不裁剪、不泄露 private rows |
| 显式 waiting-user cancel 复用既有 `statement:resolve-big-account` action 的 exact command | 不新增第六 action，不关闭整代；Worker 才能权威校验并释放自己的 token | Main 只删 coordinator record；关闭 generation 代偿 | full public token identity 校验，release-ack 后返回 bounded cancel result；同 owner/同 token 幂等 |
| post-grant 异常保存 exact tentative tombstone，等待 Host revoke 后回声 release | tentative reservation 只能由 Main 发起 revoke，Worker 直接 release 会违反 platform FSM | Worker 主动 release tentative；依赖 crash 清理 | token/persistent 两条 grant 异常均单终态、revoke/release/ack、同 generation 继续 |
| continuation phase 失败且 lock 补偿失败进入 cleanup-required | 盲目回到 waiting-user 会遗失仍持有的 lock | 无条件复位后重新 acquire | 保存首个 phase error 与 exact owner/lock；同 owner 只先重试 release，确认后下一 job 才能重获 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| E09-A 旧 template evidence 缺候选字段仍合法 | additive E09-B contract；E09-A tests | 若强制字段会破坏 non-interactive import | 兼容 tests；只在明确 interaction mapping 时要求候选 |
| public prompt 的 `fileName` 使用 source resource identity，不使用 canonical path | Renderer 隐私合同禁止 path；resource identity 已是 bounded Main-issued identity | 暴露 basename/path | UI 可区分来源但拿不到 Worker 私有路径 |
| `resource:release.reason` 使用 platform 已冻结的 `job-failed` 表示 job/interaction cancel | platform schema 没有 `token-cancelled` enum，真实 Host 会在 schema gate 关闭 generation | 扩大 platform reason enum | 不改 platform contract；token disposition 由 Worker 私有 completion/tombstone 精确区分 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 无 | 无 behavior-changing deviation | 实现始终限制在 E09-B dormant seam | 不影响 frozen 后续序列 | 不需要 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 修复后 E09-B 定向 unit/真实 Worker probes | `15/15 PASS` | 双 source initial/continuation cancel、600 accounts pre-grant reject、token adoption timeout、post-grant token/persistent cleanup、显式 cancel、零交易、cleanup-required |
| E09-B + E09-A + E09-P0 + ServiceHost/Governor/Supervisor 定向 unit | `208/208 PASS` | reservation FSM、TTL/single-use/stale/tamper、mutation invalidation、candidate digest、lock/phase、同 TaskRun/new job、privacy/bounded DTO、production gate |
| `scripts/integration/statement-generation-pipeline.js` | `45/45 PASS` | 既有金额/借贷/余额生成 pipeline 未回归 |
| changed JS ESLint | PASS | 7 个实现 JS 文件与 E09-B 测试无 lint 问题 |
| changed JS `node --check` | PASS | 语法检查 |
| `git diff --check` | PASS | whitespace/patch 完整性 |
| blindspot-pass | 已复核入口旁路、source alias、grant/adopt 可见性、mutation/expiry/cancel/crash/quit、late release ack、partial lock cleanup | 修复 post-terminal request、tentative owner、consumed/cancel tombstone disposition 与 cleanup-required；未发现可解除人工门禁的新证据 |
| reconciliation-blindspot-pass | 资金红线保持人工复核；自动证据证明 mapper 单一来源、零交易 fail closed、两 block 行守恒与 token evidence | 不改变非零金额/币种/余额算法，不生成 artifact，不自动声明资金正确 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged/真实大文件token峰值 | BLOCK（人工/发布门禁） | Release owner | 阻断 production enable，不阻断 dormant E09-B |
| 真实资金大账号多block逐行复核 | REVIEW | 资金负责人/独立Reviewer | 自动测试不能解除人工门禁 |
| live TaskLifecycle/Renderer wiring、E09-C/D | 后续 frozen sequence | 后续 Dev/Reviewer | 不属于本 PR |
| 真实银行特殊 header/大文件/跨多文件人工样本 | REVIEW | 资金负责人/独立 Ultra Reviewer | 自动 repeated-header empty/zero 已覆盖；真实样本仍阻断 production enable，不阻断 dormant E09-B review |

## Important Variables Review

- 触及 Statement `serviceGeneration`、`sessionRevision`、`activePhase`、pending-interaction TTL/budget/single-use 与 persistent reservation replacement 等风险敏感状态。
- 关联功能 review：Statement import/session revision、ServiceHost reservation adoption/release、waiting-user TaskRun/phase/business-lock、source/template evidence、public DTO privacy/bounds。
- 未改五个 canonical action 的 `production=false / effectiveMode=legacy / effectiveWorkerCount=0`；按任务约束未运行 `check-vars`、`scan:vars`。
