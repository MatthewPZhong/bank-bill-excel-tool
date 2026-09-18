# E09-B Statement Interactions Implementation Notes

## Baseline

- Goal/spec：frozen v3.2.3 Spec §3～§6、§10～§13；TechDoc §2～§5、§8、§10～§12；仅 E09-B pending interaction + waiting-user。
- Exact base：`ddac924bba79fd920e85580bde9865b850ee9dff`（E09-A review-ready exact head）。旧 E09-B 历史 base `04b6ca3f1e87c0ddcda4d709fbc95d4a39eba6ad` 及三提交 `88edf636` → `4318ad61` → `654393e9` 仅作为按序 cherry-pick 来源。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：真实 pending reservation adoption、bounded opaque token、TTL/single-use/stale/invalidation/release、同 TaskRun continuation lock/phase闭环均有定向证据；live/production与资金语义不变。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 仅接 `big-account` interaction，继续保留 manual/scope 后续门禁 | frozen sequence 把 generation/manual seed 分别放 E09-C/D | 本轮提前实现 generation/seed | E09-B 不产生 artifact 或持久资金 mutation |
| token registry 与 private context 只在 Statement Worker | Platform/Main ownership与P0隐私合同 | Main Map 保存 rows/draft；Renderer 回传 rows | Main/Renderer 只见 bounded token/public prompt |
| waiting-user Main coordinator dormant、owner API 注入 | live handler/TaskLifecycle enable 不属于本 PR，但锁生命周期必须形成可测试合同 | 直接修改 current live handler | production路径零变化，后续接线复用同一 coordinator |
| 大账号 prompt 与回填按 legacy account block 语义构造 | 同一文件可能有多个重复 header block；按文件一行会错配资金归属 | 每个文件只选一个账号；复制金额算法 | 复用 `buildMappedRows`，仅移植 block 边界与 MerchantId/Currency 注入；continuation 重新读取并核对 candidate digest |
| 新 interaction 先建立同 owner、递增 revision、精确引用旧 reservation 的 tentative candidate，仅在 candidate adopt-ack 后原子替换旧 token | frozen Spec/TechDoc 要求候选失败时旧 token 仍有效；Governor/Host 已有 tentative replacement 原子点 | 先 release/ack 旧 token；两个 published token 并存；非原子失败补偿 | `maxOutstanding=1` 按替换后投影计费；拒绝/revoke/timeout 只清理 candidate，旧 token 保持 published；adopt-ack 同时切换 reservation 与 token authority |
| token `prepare` 阶段先构造最终 public projection/result | Ultra finding 证明合法大 prompt 可在 adopt 后才触发 240 KiB 上限 | grant 后再裁剪；提高 public 上限 | 任何 pending-interaction resource request 前即稳定拒绝，public DTO 不裁剪、不泄露 private rows |
| 显式 waiting-user cancel 复用既有 `statement:resolve-big-account` action 的 exact command | 不新增第六 action，不关闭整代；Worker 才能权威校验并释放自己的 token | Main 只删 coordinator record；关闭 generation 代偿 | full public token identity 校验，release-ack 后返回 bounded cancel result；同 owner/同 token 幂等 |
| waiting-user public facade 只保留 `cancelInteraction()` 取消入口 | 全仓检索证明无 `invalidate()` 真实调用方，原入口仅凭 `taskRunId + tokenId` 删记录，可跳过 Worker exact cleanup/release-ack | 保留无 ack invalidation；关闭 generation 代偿 | facade 删除 `invalidate()`；partial token、错 owner、无 receipt 均 fail closed；`forgetCancelled()` 仅在 exact receipt 已将状态推进到 `cancelled` 后删除本地终态记录 |
| post-grant 异常保存 exact tentative tombstone，等待 Host revoke 后回声 release | tentative reservation 只能由 Main 发起 revoke，Worker 直接 release 会违反 platform FSM | Worker 主动 release tentative；依赖 crash 清理 | token/persistent 两条 grant 异常均单终态、revoke/release/ack、同 generation 继续 |
| continuation phase 失败且 lock 补偿失败进入 cleanup-required | 盲目回到 waiting-user 会遗失仍持有的 lock | 无条件复位后重新 acquire | 保存首个 phase error 与 exact owner/lock；同 owner 只先重试 release，确认后下一 job 才能重获 |
| E09-B draft/candidate 全程使用 E09-A 的 `sessionOwner + templateCatalog + sources[].templateRef/sourceIdentity` | 新 E09-A 已冻结 parent/child/filename mapping 与 layered duplicate/TOCTOU 合同；旧单 template/sessionKey 会丢失资金血缘 | 机械保留旧 E09-B 单 template request；按 catalog 顺序猜 source template | prompt owner 与逐来源 mapper 分离；private context、digest、file entry 均保留 exact lineage，direct 与 interaction source 可在同一 parent session 共存 |
| continuation 先消费 token authority，再做任何 source resolver/I/O | generation/revision/purpose/TTL/choice/template evidence 可在 Worker 内存权威直接判定；失败不应触碰来源或申请资源 | 先 realpath/stat/read，再发现 token stale；用 fallback 掩盖缺字段 | `beginConsume` 直接使用已验证 `continuation.importEvidence.sessionOwner`；成功后才重新解析完整 source identity，失败释放 consuming token并保留旧 state |
| 大账号 assignment 过滤 rows 时继续携带 mapper 产生的 split/bill stats 与 sourceRows | E09-C warning/审计依赖这些数组元数据；只保留 issues/rowMetas 会静默吞掉可审计处置 | 回填后丢弃 metadata；重新计算金额或 warning | 只克隆既有 `amountSplitMatchStats`、`billSplitMatchStats`、`sourceRows`，不改变金额、行筛选或币种算法 |
| actual big-account choice 纳入 token store 的同步原子 claim | Ultra Round 2 证明结构合法但未授权的 assignment 原先会先把 token 置为 consuming，再触发 source I/O | Service 在消费 token 后另做 rows/options 校验；失败时释放 token 或增加第二 authority | token identity/evidence/domain、exact row coverage、option membership 全部成功后才记录 frozen `claimedChoice` 并进入 consuming；Service 只消费 claim 结果，非法 choice 保持 published且可合法 retry |
| waiting-user cleanup receipt 按 exact kind 映射两种终态 | app crash/quit 的 frozen lifecycle 是 TaskRun interrupted + Renderer recovery-required，不能伪装成用户取消 | 两种 receipt 固定写 cancelled；用无 ack invalidate 删除 waiting record | exact bounded `interaction-cancelled` → cancelled，`interaction-crash-cleaned` → interrupted/recovery-required；`forgetInterrupted` 仅清理已由 exact receipt 落盘的该 token 终态证据 |
| pending-interaction replacement 只扩展既有 exact tentative replacement 合同 | Review 证明 release-first 会在 candidate admission 失败时丢失仍应有效的旧 authority；phase-extension replacement 继续禁止 | 新建通用事务/FSM；关闭 generation 代偿 | schema 仅允许 `pending-interaction-create.replacesReservationId`；Host 要求同 owner/current/published old，Governor 要求同 kind；不扩大 E09-C live action |
| 平台 request matrix prose 与 protocol schema 同步扩展 pending-interaction replacement | 原 E00 prose 仍将该字段冻结为 `null`，会与修复后的 schema/Host 形成双合同 | 只改 schema 而保留旧 prose；放宽 phase-extension | platform contract 与 E00 TechDoc 明确同 owner、递增 revision、exact current、published old、adopt-ack 原子切换及失败保留旧 token；phase-extension 仍只能 `null` |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| E09-A 旧 template evidence 缺候选字段仍合法 | additive E09-B contract；E09-A tests | 若强制字段会破坏 non-interactive import | 兼容 tests；只在明确 interaction mapping 时要求候选 |
| public prompt 的 `fileName` 使用 source resource identity，不使用 canonical path | Renderer 隐私合同禁止 path；resource identity 已是 bounded Main-issued identity | 暴露 basename/path | UI 可区分来源但拿不到 Worker 私有路径 |
| `resource:release.reason` 使用 platform 已冻结的 `job-failed` 表示 job/interaction cancel | platform schema 没有 `token-cancelled` enum，真实 Host 会在 schema gate 关闭 generation | 扩大 platform reason enum | 不改 platform contract；token disposition 由 Worker 私有 completion/tombstone 精确区分 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 旧 E09-B 以单 template/sessionKey 表示整个 import | restack 后遵守 E09-A 逐来源 template/source lineage | exact base 已收紧合同，机械移植会覆盖 parent/child/filename mapping 与 layered identity | 仅修复兼容表达，不改变 frozen E09-B public token/waiting-user/资金语义 | 已同步本 notes/preflight；frozen v3.2.3 Spec/TechDoc 本就要求复核模板/mapping/source evidence，无需改文 |
| 旧实现先释放旧 interaction reservation，再申请新 token | 改为 candidate-first tentative replacement，candidate adopt-ack 后再原子关闭旧 token | release-first 违反 frozen replacement 失败语义，且无可靠非原子补偿 | big-account 真实 Service 改用共享 helper；scope-generation 仅在 purpose-generic token store/共享替换 seam 上取证，不提前启用 E09-C action | frozen Spec/TechDoc 已要求 candidate-first，无需改文；同步本 notes/preflight |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 2026-08-30 最终 v3.2.3 tip 传播 | 已将 `v3.2.3` merge tip `a59319ff6544547b5c1071a3a5785e5c8d28133d`（#193 exact head `8c69d8f755ae8bc95b1a6891d063e5796c99ae5d`）以第二父合入 E09-B，本地 ancestry merge commit 为 `f5ef2e716db12fe254168c0dde263ec9d2d549d1`，无内容冲突。replacement 核心门禁 `115/115 PASS`，Supervisor + E09-P0 + E09-A 相邻回归 `115/115 PASS`，Statement pipeline `45/45 PASS`，`npm run smoke` PASS | 旧 #197 绿色 CI 不再代偿最终 #193 stack；新精确父链保留 candidate-first replacement、旧 token continuation、金额/币种/Workbook 既有语义与 production=false |
| restack + Ultra Round 2 后 E09-B + E09-A 定向 unit/真实 Worker probes | 串行 `39/39 PASS`（E09-B `18/18`、E09-A `21/21`） | mixed parent/child lineage、token-first evidence/choice tamper 在 source resolver/resource request 前拒绝且合法 retry；exact row coverage/options、crash interrupted receipt/duplicate/wrong-token/bounded forget；双 source cancel、600 accounts pre-grant reject、token adoption timeout、post-grant cleanup、零交易、cleanup-required、旧 state 原子保留。默认并行组合曾在本轮逻辑前出现一次不可复现 `transport-lost`，单文件与串行全绿，未据此放宽合同或增加业务防御 |
| Token replacement review 定向核心集 | `115/115 PASS`（Governor、ServiceHost、Schema、E09-B；其中 E09-B `20/20`） | pending candidate 拒绝保留 old lease；跨 job exact owner/revision/adopt-ack 原子采用；big-account/scope-generation 同 purpose seam；candidate 清理后 old token 仍可执行 continuation；cross-purpose/release-first fail closed。修复中曾有一次 cancel 测试 `transport-lost`，精确单测与其后两次完整 E09-B 均未复现，保持为已披露时序观察 |
| Token replacement review 相邻回归 | `114/114 PASS`（Supervisor、E09-P0 三文件、E09-A）；protocol-validator `26/26 PASS` | service detach/revoke、legacy金额 golden、session persistent replacement、production=false/legacy/0、pending replacement 正向 schema 与 phase-extension replacement 反例 |
| Token replacement review 静态检查 | PASS | 8 个 changed JS/test 的 ESLint 与 `node --check`；两份 protocol schema 逐字节相等、3 个 changed JSON parse；`git diff --check` |
| E09-P0 + ServiceHost/Governor/Supervisor 定向 unit | `179/179 PASS` | reservation FSM、TTL/single-use/stale/tamper、lock/phase、privacy/bounded DTO、四金额/余额/current-all golden 与 production gate |
| `scripts/integration/statement-generation-pipeline.js` | `45/45 PASS` | 既有金额/借贷/余额生成 pipeline 未回归 |
| `npm run smoke` | PASS | 全仓 smoke 与 Statement 外相邻模块无回归 |
| changed JS ESLint | PASS | 8 个实现 JS 文件与 2 个 Statement 测试使用共享只读 `NODE_PATH` 通过；首次缺 `globals` 是隔离 worktree 依赖解析问题，不是 lint finding |
| changed JS `node --check` | PASS | 10 个 changed JS 语法检查 |
| changed JSON parse | N/A（0 files） | 本 restack 无 JSON 改动 |
| `git diff --check` | PASS | whitespace/patch 完整性 |
| blindspot-pass | 已枚举 import/continuation/cancel/status/wrong-action 入口，以及 prepare/grant/private-insert/adopt-ack/published/consuming/releasing/released、replacement/stale/expiry/crash/late ack 状态 | token-first stale/invalid choice 均无 source/resource side effect；actual choice 与 single-use 同步 claim；crash receipt 不降级 cancelled；replacement candidate rejection/revoke/timeout 不删除旧 published authority，matching adopt-ack 才原子替换同 kind old reservation/token；未发现 release-first 或无 ack public 旁路 |
| reconciliation-blindspot-pass | 资金红线保持人工复核；四金额、双非零/零发生额、MerchantId/账户、币种/余额/current-all golden，mixed lineage、未授权/重复 token、single-use/partial cleanup、split/bill warning metadata 与两 block 行数守恒均有自动证据 | 未授权 MerchantId/Currency 在任何来源读取前拒绝且不耗 token；E09-B 只复用 production mapper并回填，不实现 Publisher/generation/seed settlement，不自动声明资金正确 |

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
