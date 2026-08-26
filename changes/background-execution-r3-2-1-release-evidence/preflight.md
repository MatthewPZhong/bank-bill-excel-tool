# R3.2.1 Release Evidence — Preflight

## Task Brief

- Goal：为冻结的 `R3.2.1 | release evidence | action独立 enable/rollback` 建立可机器校验、可审计的 7-action production snapshot，不改变任何生产业务路径。
- Context：E04-A/E04-B/E05-A/E05-P0/E05-B 已落 capability；E04-C 第二 Writer probe 已拒绝生产实现；E05-C representative Parser Pool 改善仅 0.57%，结论为 `DOWNGRADE / KEEP PRODUCTION DISABLED`。
- Constraints：5 个 v3.2.1 native action 保持 `production.enabled=false`、live legacy、effective worker 0；`toolbox:split-large` / `toolbox:publish` 保留 inherited canonical production state；不改金额、币种、receipt、sequence、Publisher 或 Recovery Hold 语义；不实现第二 Writer；本 PR Dev、人工触发与 `workflow_dispatch` 均不运行/重跑 `release-check`；冻结 snapshot 记录的是 final PR opening 前的 `PENDING_REMOTE_REQUIRED_CI`。PR #182 的 automatic attempt #2 后续在 Windows 运行满 6 小时被平台取消，follow-up 只修复跨平台测试隔离并跑定向测试；按 release owner 最新约束，#182 不再运行 `release-check`，全量 `release-check` 只允许在 v3.2.1 最后一张 PR #183 的远端 CI 执行一次。hard gate 在该最终证据成功前保持 open，且不授权 main/tag/production enable；不运行 `check-vars` 或 `scan:vars`。
- Done when：snapshot 对每个 action 独立给出 current policy、live disposition/effective mode/worker count、enable 决定、禁用/保留原因、rollback、证据引用和 Windows/人工/资金恢复门禁；validator 能同时发现 policy drift、证据漂移、跨 action 代偿和门禁误报；定向测试、affected ESLint/语法与 `git diff --check` 通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 精确基线为 `4598b9c67787ef1736831a186a199bd6fe9ae626`。 | `git rev-parse HEAD`。 | snapshot 固定本次 review base，不接受来源含混。 |
| 5 个 native policy 由运行时代码聚合，当前均为 `false / legacy / 0`。 | `src/main-process/background-execution/runtime.js`、Toolbox/PreFund `policies.js`。 | validator 直接读取代码 authority，不把 benchmark 结果写回 policy。 |
| inherited `toolbox:split-large` / `toolbox:publish` 的 canonical snapshot 是 `true / thread-single / 1 / recovery proven`。 | v3.2.x canonical policy fixture。 | 本 PR 只引用并校验，不改写 inherited production state。 |
| E04-C 第二 Writer 只存在于已丢弃 probe，combined gate 已失败。 | v3.2.1 implementation notes §E04-C。 | 不创建第二 Writer、shard planner、生产 path 或 benchmark framework。 |
| E05-C representative 改善 0.57%，small 改善 33.04%；native E00 admission 实际 Parser count 为 1。 | tracked E05-C benchmark JSON/Markdown 与 implementation notes。 | representative gate 不得由 small fixture 代偿；decision 固定 downgrade/disabled。 |
| policy schema 的 `evidenceStatus` 没有 `benchmark-fail`。 | Platform Contract schema。 | 失败结论只记录在 release decision/reasons/evidence refs，不伪造 policy pass/fail 枚举。 |
| Windows packaged、Excel/WPS、真实进程终止、资金与恢复人工证据仍未闭合。 | R3.2.0、E04、E05 implementation notes。 | snapshot 必须保留 `NOT_RUN` / `PENDING_HUMAN_REVIEW`，自动测试不得升级。 |
| `package.json.version` 为 `3.1.14`，R3.2.0 release-evidence 未 bump 产品版本。 | `package.json` 与 R3.2.0 release-evidence commit。 | 本证据 PR 不 bump，不更新 release 用户文档三件套。 |
| local `release-check` attempt #1 在 `c9e89db7` 失败；release owner 仅为开 final PR 授权 automatic required CI attempt #2。 | release-owner 授权、tracked release snapshot与`.github/workflows/build-windows.yml`。 | 锁定same-repo `opened`、head branch、target base、PR head SHA和`run_attempt == 1`；错误base及final branch `workflow_dispatch`/synchronize/rerun必须skip。 |
| PR #182 automatic attempt #2 在 Windows unit 阶段触发真实目录 `fsync` unsupported，随后测试进程未退出并在 6 小时上限被取消。 | Actions run `32932672610`；E05-A/B/C spool 日志；Windows `fsyncDirectory` 平台返回。 | 生产 `ready` 发布仍必须 fail closed；只能隔离测试宿主能力，不能把 unsupported 降级成成功。#182 follow-up 不得重跑全量 `release-check`。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| inherited policy 与本版本 native runtime 不在同一代码聚合器中，如何避免误判。 | 已知未知 | 高 | 容易 | canonical fixture 包含 7 action；runtime 只包含 5 native action。 | PROBE | validator 分源读取 canonical fixture与 native policy exports。 | snapshot 明示 `policyAuthority`；两组分别校验，禁止用缺席 runtime 推导 inherited disabled。 |
| action-independent 是否需要新通用运行时模块。 | 盲区 | 中 | 容易 | 需求仅为 release evidence，业务 runtime 无缺口。 | ASSUME | 先以只读 JSON + CLI validator + unit tamper cases 验证。 | 不改 `src/`；证据工具只读生产 authority。 |
| benchmark 证据如何防止内容漂移。 | 已知未知 | 高 | 容易 | E05-C 有 tracked JSON；E04-C raw probe 未跟踪，但 raw hash与摘要已冻结在 notes。 | PROBE | 对 tracked 文件校验 SHA-256；对 E04-C 校验 notes 中冻结指标/hash。 | evidence ref 同时包含 stable ID、repo source和内容断言。 |
| 是否需要产品版本或用户文档更新。 | 隐性偏好 | 低 | 容易 | 既有 R3.2.0 release evidence 未 bump，本 PR 无用户行为变化。 | ASSUME | 检查 repo release convention 与当前 diff。 | 不 bump、不改三件套；若后续负责人要求版本迭代，三件套必须一起更新。 |
| 如何在 Windows 不支持目录 `fsync` 时验证 spool schema/顺序/receipt，同时保留生产 fail-closed。 | 已知未知 | 高 | 容易 | 生产 Writer 已支持 `fsyncDirectory` 注入；真实 Worker 默认加载生产 barrier。 | PROBE | 直接 Writer 注入 supported test barrier；显式测试 Worker 预加载同等 barrier；另用默认生产实现跑真实平台分支测试。 | 只在 `tests/unit/shared` 建 test seam；生产 `src/` 零改动。默认实现 supported 时发布，unsupported 时必须清理并抛 `PREFUND_SPOOL_DURABILITY_UNAVAILABLE`。 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 冻结 7-action snapshot schema 与 authority 分层。 | inherited state、native false gate、canonical enum。 | validator 对实际 authority 全匹配。 | 会误开/误关 action 或伪造 policy。 | 只保留 notes，不接收 snapshot。 |
| 2 | 建立 evidence refs 与 gate/decision 独立校验。 | 不跨 action 代偿；E04-C/E05-C fail 保真。 | tamper tests 分别击穿 enable、benchmark、gate、rollback。 | release 文档可能漂移或误报 PASS。 | 收缩到更严格的固定 release schema。 |
| 3 | 运行定向验证与两类 blindspot pass。 | 入口、状态、恢复、资金/审计边界。 | unit、CLI、lint/syntax、diff-check；人工边界仍 open。 | 不能作为最终 PR 证据。 | 保持所有 native disabled，不触碰产品路径。 |
| 4 | 完成 notes 与本地提交。 | Evidence/Remaining Unknowns 可复现。 | clean tree、精确 base/HEAD。 | 交付不可审计。 | Dev不push/merge；release owner开PR后仅由required CI按授权运行attempt #2。 |
| 5 | PR #182 follow-up 隔离 Windows 测试宿主能力。 | 生产 durability fail-closed、Worker 生命周期、资源准入、资金/receipt合同。 | E05-A/B/C、Toolbox Route/generation、mature adapter定向测试及全量unit正常通过且进程退出；affected static checks通过。 | 若修改生产 barrier会形成伪durability；若资源探针或Worker残留泄漏会再次耗尽CI。 | 仅保留test seam、确定性测试预算与真实平台回归；#182不运行全量`release-check`。 |
| 6 | PR #183 一次性 conflict-resolution synchronize final gate。 | attempt #4 因 PR 堆叠冲突未启动；waiver 不得扩散到后续 push。 | PR #183 / same-repo / R4→R3 / synchronize / attempt 1 / commits 5；exact checkout 后验证 `HEAD^1=ce599e20`、`HEAD^2=d7d96938`。 | 任一 tuple 或双父 lineage 漂移必须在 release-check 前失败；远端失败/取消不允许重跑。 | 只撤回本次 waiver；保持 hard gate open、native production disabled、main/tag未授权。 |
