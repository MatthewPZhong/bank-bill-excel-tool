# E11-A ReconFix Service Implementation Notes

## Baseline

- Goal/spec: `changes/background-execution-v3.2.x-contract-baseline/changes/3.2.4/{spec,techdoc}.md` 的 E11-A。
- Initial plan: `changes/background-execution-e11-a-recon-fix-service/preflight.md`。
- Done when: production-false 真实 Service capability 覆盖 import/standard/BOC，只读 golden 与 state invalidation/close/crash/resource probes 通过，live 保持 legacy。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| E11-A 不依赖 E11-P0，继续实施 | 冻结 PR 顺序把 E11-A 放在 E11-P0 前；Platform Contract 的 JPM BLOCK 明确不阻止只读 action；standard/BOC 当前不调用 ADM mutation | 等 E11-P0 后再建 Service；在本 PR 预埋 JPM DTO/schema | 本 PR 不含任何 JPM reader/no-op/receipt/inspector 行为 |
| 复用 Main-only ServiceHost/ResourceGovernor | 平台已实现 BaseLease、PersistentReservation replacement、generation、busy、close/crash release | 模块自建 Worker owner/Governor；在 Main 新建大 state | Service 只新增业务 Worker/state，Main 仍只有平台小型 lifecycle state |
| BOC Worker 按路径只读主库 | BOC linked rows 可能超过协议上限；`DatabaseSync(...,{readOnly:true})` 能强制只读 | Main 读取整表并通过 postMessage；复制 BOC 表到另一个 DTO/spool | Worker 内形成 linked evidence 与计算输入；command 保持有界 |
| 所有 state 变更走 persistent-state-replace | Platform Contract 要求候选在 grant→adopted→adopt-ack 后才能公布 revision | 先换 state 再补 reservation；仅 import reservation、run 原地改 | admission/reject 时旧 state 保持；revision 只在 ack 后公开 |
| 两个 action 共用 canonical static service binding | 冻结 fixture 的 `service.serviceKey` 均为 `service.recon-fix`；既有 Registry 以 `staticKeys.serviceKeys` 和共享 executable 判定 capability 一致性 | 新增 service descriptor/registry 方言 | runtime 只注册 `serviceKeys: ['service.recon-fix']`，两个 entryKey 绑定同一 frozen worker entry |
| 引擎返回值在进入 Service 状态前结构化克隆 | C4/BOC 旧引擎的部分行为 null-prototype，canonical JSON 按平台合同必须是 plain JSON | 改动旧引擎的对象构造；放宽 canonical JSON | Service 拥有独立 plain JSON；golden digest 证明字段/金额/币种/行数未变 |
| 仅对有界 DTO 的五个 SHA-256 字段放行 finance-safe value | 通用隐私规则会把偶然含 12 位数字的随机摘要误判为完整账号；既有 validator binding 支持精确 delegate | 整体关闭 `finance-safe-v1`；允许任意字符串 | 只有值匹配 64 位小写 hex 且 key 在白名单时放行 |
| public import summary 对账号型文件名脱敏 | 账单文件名可能本身是完整账号，不得因 Main 已知路径就绕过 `finance-safe-v1` | 为任意 fileName 添加 privacy delegate；删除 Worker 私有原名 | 仅 bounded DTO 返回 `[redacted by finance-safe-v1]`；Service 私有 session 仍保留原名供后续 E11-C |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| export/resultHandle 的公共消费延后 E11-C | 本 PR scope 明确禁止 export；E11-A 验收只含只读 golden/state invalidation | 不能从 Main 导出 managed result（符合 production false/live legacy） | 不添加临时大 DTO；E11-C 复用 Worker 私有 result |
| BOC 坏 JSON 继续 legacy skip 语义 | 本 PR禁止改变 ReconFix 算法/业务语义；E11-P0 的 hard-fail 只针对 JPM ADM | 只读 BOC evidence 不会新增拒绝 | golden 锁定；如后续业务决定改变，独立 PR |

## Deviations

无。

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Preflight 仓库与合同检查 | E11-A 无 E11-P0 硬依赖；无 BLOCK | 冻结顺序、范围防越界 |
| Node read-only SQLite probe | SELECT 成功；INSERT 以 `ERR_SQLITE_ERROR` 拒绝 | BOC Worker 不可写主库 |
| `node --test tests/unit/main-process/recon-id-fix-service.test.js` | 6/6 PASS | canonical policy、standard/BOC golden、busy/stale/revision、scenario/BOC evidence 失效、JPM 阻断、有界 DTO、真实 Worker close/crash/generation/lease 回收 |
| ReconFix/Platform 联合定向单测 | 126/126 PASS | ReconFix engine/IO、C4/BOC 1:1 和金额语义、policy registry 无回归 |
| `v3.0.4-boc-dispatch-order-fix.js` | 31/31 PASS | BOC 整组失败、Reference/Amount/Type、行数与输出契约 |
| `recon-id-fix-end-to-end` smoke | 6/6 PASS | standard import/run/output 旧链路 golden；live 仍走 legacy |
| `toolbox-background-generation.test.js` | 10/10 PASS | runtime 新增两个 production-false policy 后既有 one-shot action 与 shutdown 不回归 |
| `benchmark-recon-fix-service.js --rows=5000` | 10,000 输入行；7,619,275-byte XLSX；import/final reservations=15,120,576/15,124,288 bytes；Main DTO=512 bytes；最新整进程 RSS peak delta=312,262,656 bytes（多次观测 304,889,856..317,997,056） | 总量核对不只看 15 MB final reservation：Base 64 MiB + Phase 192 MiB + old/new state 声明 replacement envelope=298,680,320 bytes；实测 peak 另含 Worker/JIT、XLSX 解析和 allocator 开销。属本机 local-only probe，不是 production enable 证据 |
| `node --check` 全部新增/修改 JS | PASS | 静态语法检查 |
| 手工 important-variable 对照 | 命中 BOC 调拨订单修复链（Risk-sensitive 资金红线）与 ReconFix `unmatchedRows` 同名隔离项；未修改 live `reconIdFixSession/reconIdFixResult` | 需在合并/发布前由资金负责人做真实样本人工复核；本 PR production false |

## Blindspot Pass

- 入口/旁路：只有 non-production runtime 可执行新 capability；live IPC/Main globals 零改动，继续 legacy。
- 边界/失败：exact-key command、absolute path、subMode/category、stale revision、busy、JPM 均 fail closed；resource reject 不公布候选状态。
- 状态生命周期：import 清 result；scenario/BOC hash 变化先 adopt invalidation 再计算；close/crash 清空 Worker 私有 state 并使 generation 前进。
- 兼容/可观测：policy 与 canonical fixture 逐字段一致；Main 只见 generation/revision/digest/count/handle，不见 rows。
- 隐私：SHA-256 仅在精确 key/format 下放行；完整账号型 fileName 在 public DTO 脱敏，原名不离开 Worker 私有 state。
- 测试缺口：Windows packaged Worker + SQLite WAL/read-only 尚未在本机验证，保持 production false 并列为 enable gate。

## Reconciliation Blindspot Pass

- 主键血缘：standard 仍用 legacy sheet 行；BOC 仍依 `ORDER BY id ASC` 的 raw JSON 原序，未新增或重解释业务键。
- 金额/币种/1:1：不改 C4/BOC engine；standard/BOC digest golden 和 BOC 31 断言通过。
- 幂等/重复：E11-A 纯读，不产生 DB mutation/receipt；相同 evidence 可重算，但每次采用都需新 PersistentReservation/revision。
- 部分失败：BOC 整组失败规则不变；新状态未准入则旧状态保持，evidence 已变更时先锁定清除旧 result。
- 行数守恒/资损可观测：DTO summary 只输出 fixed/warning/unmatched count 与 canonical digest；完整行仍仅在 Worker 私有 state。BOC 为 Risk-sensitive 资金红线，仍需资金负责人人工真实样本复核。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged 下 Worker read-only DB/WAL 行为 | PROBE | 本 PR 只能做当前平台 probe；production enable 前补 Windows gate | 不阻止 production-false 合并，阻止 production enable |
| 真实资金样本的 BOC 行级人工复核 | 人工门禁 | 资金负责人在合并/发布前核对 Reference/Amount/Type/整组失败 | 未复核不得 production enable |
