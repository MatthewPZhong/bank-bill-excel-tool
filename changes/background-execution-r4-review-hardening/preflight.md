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
