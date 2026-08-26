# R4 Review Hardening — Unknowns Preflight

## Task Brief

- Goal: 修复 v3.2.0 堆叠审查确认的 5 个 non-blocking P3，不扩大产品行为面。
- Context: 基线为 Draft PR #174 的组合快照 `0ab11a2f`；四个 mature action 与 VCC Parser Pipeline 仍保持 production disabled。
- Constraints: 不改变 Renderer/public IPC、资金金额/方向/月/币种/begin-end OP、operation identity 或唯一性合同；不新增依赖；不运行 `check-vars`/`scan:vars`；不远端 merge。
- Done when: Worker termination 成为资源释放屏障；被取代的 Parser scan 被取消且外部取消仍有效；Receipt `run_id` 普通索引存在；canary 对报告前进程退出快速失败；TechDoc 与运行时物理表名一致且合同包校验链同步；定向测试和 `release-check` 通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| big-table `finish()` 未等待 `worker.terminate()`，且 handle 无 `close()` | `src/main-process/big-table-import-dispatch.js`；`existing-dispatch-adapter.js`；`supervisor.js` | 必须暴露同一个 termination Promise 给 close/terminate，不能改变业务终态协议 |
| Session generation 只拒绝旧结果，Pipeline 已支持 `AbortSignal` | `src/main-process/vcc-op-calc-session.js`；`vcc-op-calc/parser-pipeline.js` | 取消应在 Session 组合，不另造 Worker 协议 |
| 默认 VCC IPC 仍走 `streamScanAndCompute` | `src/main.js`；E03-A implementation notes | 保持 production disabled 与默认 legacy 入口 |
| Inspector 按 `run_id` 查询，Receipt 表无对应索引 | `operation-receipt-repository.js`；`migrations.js` | 只加普通索引，不把 `run_id` 升级为唯一合同 |
| canary 等报告的第一循环不检查进程退出 | `scripts/run-windows-packaged-background-canary.ps1` | 新错误必须保持 safe-code/privacy 边界，不读取 stdout/stderr |
| 冻结 TechDoc 使用不存在的 `vcc_op_runs`，运行时使用 `vcc_op_calc_runs` | 3.2.0 TechDoc、migration 与 E03-B notes | 修正文档，不创建别名表；同步 published validation/hash evidence |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| termination Promise 拒绝时是否会形成未处理拒绝或重复 terminate | 状态生命周期 | 中 | 容易 | legacy 调用方只消费业务 promise，Supervisor 会消费 close | PROBE | fake Worker 返回受控 resolve/reject Promise，断言共享 identity 与调用一次 | 原 Promise附 noop rejection observer，close/terminate 仍看到原始拒绝 |
| Session 发起 supersession 后旧调用应返回 cancel 还是 superseded | 内部契约 | 中 | 容易 | 现有 generation 测试冻结 `VCC_COMPUTE_SCAN_SUPERSEDED` | PROBE | 受控 Pipeline 监听 signal，并验证第二 scan/clearCache/外部 signal | Session 发起的 abort 保持 superseded；调用方 abort 保持 pipeline cancellation |
| `run_id` 是否允许多个 Receipt | 幂等/数据模型 | 高 | 一般 | Inspector 显式检查 associated Receipt 数量，合同未授权唯一 | PROBE | PRAGMA index_list/index_info | 只建 non-unique index |
| Windows 快速退出动态测试如何在 macOS release-check 中保持稳定 | 平台测试 | 中 | 容易 | 当前合同测试跨平台运行，真实 PowerShell 只在 Windows 可用 | PROBE | 全平台静态顺序断言 + Windows-only pwsh 受控进程探针 | 非 Windows skip 动态探针；Windows CI 执行真实路径 |
| TechDoc 修改是否使冻结包证据链失配 | 文档完整性 | 中 | 容易 | `validation-report.json` 与 `PACKAGE-SHA256SUMS.txt` 记录 TechDoc hash | PROBE | 运行包 validator 并重建/校验 checksum | 同步 published report 与 checksum；历史 manifest hash保持 non-normative |

## BLOCK 问题

- 无。所有会改变方案的未知均可由仓库内低成本 probe 消除。

## 保守假设

- 以一个 top-of-stack hardening PR 收敛 5 项审查修复，避免改写和重排既有 Draft PR；失效时可按文件拆分，代码行为不受影响。
- 本机不是 Windows，真实 packaged/PowerShell 动态证据由 Windows CI 补齐；本地必须通过静态合同与所有跨平台测试。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | Worker termination barrier + fake Worker/Supervisor test | 资源租约不得早于真实 Worker 退出 | 终态 pending 时 lease 仍 active；resolve 后释放；terminate 一次 | 推翻 P3-01 方案 | 收缩为 handle-level shared promise，不改 Supervisor |
| 2 | Session-owned Parser controller + cancellation tests | 旧 scan 不占资源、不覆盖新 snapshot，外部取消保持 | old signal aborted、错误语义稳定、new controller 不被 old finally 清除 | 推翻 P3-02 方案 | 仅在 Parser seam 内回滚，不触默认 IPC |
| 3 | Receipt index + migration/资金 golden tests | 不改变唯一性、金额或原子提交 | index non-unique/run_id；既有 golden 全通过 | 若唯一性假设错误则停止 | 删除新增普通索引即可 |
| 4 | Canary fast failure + static/Windows dynamic contract | 提前退出快速可观测且不泄露信息 | safe code、等待时间、源码顺序 | 仅影响 Windows 工具链 | 保留静态守卫，动态探针 Windows-only |
| 5 | TechDoc/report/checksum 同步与全量验证 | 规范与运行时物理表唯一真相一致 | validator、checksum、docs contract、release-check | 文档包不可重新分发 | 不触运行时；修复证据链后再打包 |

## PR #183 一次性 Conflict-Resolution Final Gate（2026-08-27）

### Task Brief

- Goal：把 #182 exact head 作为第二父合入 #183，消除堆叠冲突，并仅授权该双父 merge commit 的一次自动 `pull_request/synchronize` 全量 final gate。
- Context：#183 原始 head `962e4ae1549035d4eb875dbfb19417c19d1f95f6` 的 opened run `32953558996` 已取消；第一次 repair head `ce599e206894f3683b748254068dd750479ffc74` 因 PR conflict 未触发 workflow。#182 exact head 为 `d7d96938196a61a36892c40721cdba56992a14a8`。
- Constraints：不运行本地 `release-check`、`check-vars` 或 `scan:vars`；不手工 rerun、`workflow_dispatch`、admin 绕过、合并 main、删除分支或启用 production；资金/恢复人工红线保持 open。
- Done when：#183 只新增一个冲突消解 merge commit；远端仅在 PR #183、same-repo、R4→R3、`synchronize`、`run_attempt == 1`、PR commits=5 时运行；checkout 后验证 exact event head、`HEAD^1=ce599e20` 与 `HEAD^2=d7d96938`；其他 final invocation 在 release-check 前稳定失败。

### 已确认事实与 Unknowns Register

| 事实/未知 | 类型 | 影响 | 处理 | 当前决定 |
| --- | --- | --- | --- | --- |
| `pull_request/synchronize` 会携带当前 PR head SHA，但没有可依赖的已冻结 previous-head expression | 事件合同 | 高 | PROBE | checkout 继续绑定 `github.event.pull_request.head.sha`；授权前置条件用精确 PR/branch/base/repo/action/attempt/commit count，checkout 后验证两个 exact parent |
| 同一 head 无法在自身 workflow 中预先硬编码自身 commit SHA | 完整性 | 中 | ASSUME | 不伪造自引用 SHA；push 后将真实新 SHA登记为 reviewed head，并由监控只读核对 |
| 仅 action=`synchronize` 会把未来 push 一并放行 | 重复执行 | 高 | PROBE | 固定 `pull_request.commits == 5` 且 exact 双父；本次后续新增提交使前置或血缘门禁失败 |
| #182 与 #183 同时修改 evidence docs 与 E05-C tests | 堆叠拓扑 | 中 | PROBE | 实际仅两份 evidence docs 文本冲突；E05-C tests 自动合并，`src/` 无冲突。merge commit 以 #182 exact head 为第二父，避免内容等价但血缘分叉 |

无新增产品、资金、数据模型或公开接口 BLOCK；远端 final gate PASS 仍是合并前硬证据。

## PR #183 Windows Unit Repair Final Gate Attempt #6（2026-08-27）

### Task Brief

- Goal：修复 attempt #5 在 Windows full unit 暴露的 20 个 leaf failure，并只授权修复提交的一次自动 final gate。
- Context：run `32995472567` 在 exact head `f87f2b2994e86b75d350f64eec53252fe24a67b6` 上进入 `npm run release-check`；lint 与 smoke 已通过后，unit 为 `6154/6176 PASS`、20 fail、2 skip，build 因 `needs: smoke-test` 跳过。
- Constraints：不运行本地 `release-check`、`check-vars` 或 `scan:vars`；不 rerun、`workflow_dispatch`、admin 绕过或额外 push；不改变金额、币种、主键、sequence、receipt、Recovery Hold、production selector 或人工资金/恢复门禁。
- Done when：20 个失败按四个同源组全部收口；生产默认仍使用真实 directory `fsync` 并在 unsupported 时 fail closed；文本合同跨 LF/CRLF 一致；本地定向与 full unit 通过；attempt #6 仅允许 PR #183、same-repo、R4→R3、synchronize、run attempt 1、PR commits=6，且新 head 的唯一父为 `f87f2b29`。

### 已确认事实与 Unknowns Register

| 事实/未知 | 类型 | 影响 | 处理 | 当前决定 |
| --- | --- | --- | --- | --- |
| 13 个 MPT leaf failure 都发生在 Main 发布 parser outcome sidecar；Parser Worker spool 已使用 supported test barrier | 平台/状态边界 | 高 | PROBE | `writeParserOutcome` 增加与 spool writer 同型的可注入 barrier；managed test wrapper 注入 supported，生产未传参数时继续使用真实 `fsyncDirectory` |
| 4 个 Toolbox leaf failure的 Route DB 本体 barrier 已注入，但 manifest 的 `writeFileAtomicDurable` 捕获了模块内真实 barrier | 平台/持久化 | 高 | PROBE | manifest 原子写显式复用 Route DB seal 的同一个 barrier；unsupported 仍由 `assertDirectoryDurable` 拒绝 |
| 1 个 Renderer static contract 与 2 个 evidence test 只在 CRLF checkout 漂移 | 兼容性 | 中 | PROBE | 源码定位接受 `CRLF/LF`；evidence hash 以 LF canonical text 为权威，并新增 CRLF parity test |
| 测试 barrier 是否可能进入产品调用 | 资金/恢复 | 高 | PROBE | seam 仅为可选内部依赖；normal call 缺省真实 barrier，另加 deterministic unsupported fail-closed test；production policy 仍 disabled |
| Windows runner 是否完整消除 20 个失败 | 外部平台证据 | 高 | BLOCK（合并前） | 仅由 attempt #6 的自然 synchronize CI 回答；失败不得 rerun、绕过或 merge |

### 风险优先计划

| 顺序 | 步骤 | 保护的不变量 | 成功证据 | 失败处置 |
| --- | --- | --- | --- | --- |
| 1 | 绑定 20 个 leaf failure 到四个同源组 | 不把 job 名称误判为 smoke 失败；不盲改业务 | 远端 `not ok` 列表与 13/4/1/2 计数一致 | 停止扩散修复，继续取精确错误证据 |
| 2 | 修复 barrier test seam 与 CRLF 合同 | 真实 unsupported 仍 fail closed；receipt/金额/行数不变 | core四组85/85；最终组合90/92（2个Windows-only skip）；新增supported/unsupported barrier tests | 回滚对应 seam，不动 production policy |
| 3 | full unit、validator、静态合同与 blindspot review | 无跨模块、证据或 gate 漂移 | full unit 0 fail；validator PASS；workflow exact lineage PASS | 不提交/不 push |
| 4 | 单提交、单 push attempt #6 | attempt #5 失败不可改写；未来 push/rerun稳定拒绝 | commits=6、`HEAD^1=f87f2b29`、保留其 exact 双父 | 任一漂移暂停并重新请求授权 |
