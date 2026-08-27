# E09-A Statement Service Implementation Notes

## Baseline

- Goal/spec：frozen v3.2.3 Spec §3、§5、§6、§8、§10～§13；TechDoc §1、§2、§5、§8、§10～§12；仅 E09-A import/session/revision。
- Exact base：`e67fba5788996275759001c777dc8c80804d972c`。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：Worker-only state、真实 Service Control atomic reservation adoption、bounded Main/protocol DTO、failure/crash/cancel evidence与legacy资金characterization均满足任务要求；production/live保持false/legacy。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 复用 E09-P0 contract/footprint 与现有 `buildMappedRows`/statement-session helper | P0与frozen TechDoc要求单一合同和金额真相 | 另写DTO/footprint/金额转换 | E09-A仅组合所有权与adoption，不改变资金算法 |
| managed input只携source resource evidence与template canonical snapshot/digest | Main可持resource identity与小型DTO但不得解析业务行 | Main预解析`detailRows`后发Worker；Worker信任未校验config | Worker在读前/后校验source，在采用前复核template digest |
| session candidate只在匹配`resource:adopt-ack`后替换 | ServiceHost/Governor的replacement adoption是权威资源边界 | grant即采用；先改session再补reservation；失败清空旧session | reject/adopt失败/取消均可丢candidate并保留旧state |
| Job 协议仅传 opaque `resourceId` + stat snapshot | 硬边界允许 Main 持资源 identity，但路径不应出现在 bounded result/status/control trace | 在 import request 携绝对路径 | Worker entry 从私有 `statementSourceRoot` 解析资源，并拒绝越界 resource ID |
| adoption timeout 按 Host 的 `resource:revoke` → Worker `resource:release` → `release-ack` 收口 | 真实 ServiceHost 在 grant 后未收到 adopted 时会撤销 tentative reservation | 伪造 adopt-ack 或本地超时替换 state | 旧 persistent reservation/session 保持权威，同一 Service 可继续 status |
| attached service job 的取消终态证据由 ServiceHost 按 job 隔离桥接 | native Worker adapter 只承载长驻 Service，不能把 carrier 级 cancel 状态直接归给某个 attached job | 把任意 `job:error` 或 raw Worker cancel 标记泛化为 cancelled | 仅 exact job 的 cancel 成功派发后、对应 cancellation error 交给 Supervisor 前设置私有证据 |
| pending admission 取消后保留一个 exact request tombstone | Host 仍必须结算已在途的原 request reject，或 grant 后 revoke/release | 忽略所有 activeJob 为空时的 stale control；取消时强关 generation | 只接受相同 jobRef/controlId/requestId 的一次 response；late grant 继续按 exact grant/reservation/revoke control 收口 |
| Worker 私有 resolver 按 resolved canonical path 判重 | 不同公开 resourceId 可解析到同一文件，重复读取会破坏单次 import 的 file identity | 只按公开 resourceId 判重；读后再去重 | `a.xlsx`/`./a.xlsx`/`sub/../a.xlsx` 在任何文件读取、candidate mutation、resource request 前 fail closed |
| E09-A template evidence 不含 `selectedBigAccount` | 大账号选择上下文属 E09-B，不应成为公开 Job DTO | 允许 Main 传已选大账号 | 需选择的 mapping 一律返回 `STATEMENT_BIG_ACCOUNT_INTERACTION_BLOCKED`；mapper 的参数仅在 Worker 内部固定为 `null` |
| 本轮不接 live IPC | frozen E09-A任务明确live继续legacy且production false | shadow双写或feature切换 | production path与Renderer行为零变化 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| entry/batch identity无需跨Service crash恢复 | frozen Spec/TechDoc明确内存session crash后不恢复 | 若未来要求恢复，需持久session artifact与新合同 | E09-A crash test锁定丢失；未来版本先改Spec |
| E09-A只采用无需用户交互的candidate | E09-B单独负责token/waiting-user；用户硬边界禁止新UI/token Map | 复杂legacy import暂不能managed | 返回明确blocked result/private seam；live仍legacy |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| source identity 中携路径 | 公开 Job 输入只携 opaque `resourceId` + snapshot，路径仅在 Worker 私有 resolver 中存在 | blindspot pass 将“Main/协议/status 无路径”收紧为全协议 trace 无路径 | 更小的公开面；live 未接线 | 否，属 E09-A 实现收紧，未改 frozen 语义 |
| 通过篡改 adopted 消息测 adopt failure | 让真实 Worker 在指定 grant 不发 adopted，验证 Host adoption-timeout revoke/release 链 | 这是真实 Host 的冻结失败路径，且不需要伪造不可达协议角色 | 同时验证 tentative reservation 清理与旧 session 保留 | 否，与 P0/TechDoc 一致 |
| import result 返回完整 session `entryIds` | 返回 `entryCount` 与本次 bounded `importedEntryIds`，并在 resource request 前预构造/校验 result | session 可经多次合法 import 超过单次 1024 source 上限；旧 shape 会在 adopt-ack 后校验失败，造成状态已采用但 job 失败 | 不新增 session 文件数限制；Main 仍只接收 bounded count/本次 IDs | 否，落实 Spec 的 bounded DTO 与原子采用要求 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| branch/base/worktree preflight | `codex/v3.2.3-e09-a-statement-service`；初始实现 parent 与 merge-base 为 `e67fba5788996275759001c777dc8c80804d972c`；review follow-up 从 clean HEAD `df22be5b14fe99524e38c8de890e0af16f5eaa35` 开始 | 防错误worktree、base与外部漂移 |
| 必需文档/skills完整读取 | AGENTS、unknowns-first、implementation-notes、blindspot-pass、reconciliation checklist、frozen v3.2.3 Spec/TechDoc/sequence、E09-P0 preflight/notes | 边界、workflow与人工红线 |
| E09-A + E09-P0 定向 Node tests | 44/44 pass，0 fail/skip | 真实 Supervisor/ServiceHost/native Worker 两次 import；跨 1024 文件 session 的 bounded result；canonical path alias 在读取/申请资源前拒绝；attached shutdown cancel 的 exact late reject/grant 两种结算时序、旧 revision 保留、lease/dependency 归零且无 generation crash；其余 template、adoption、crash、bounded/privacy 与四金额/币种/current-all golden |
| ServiceHost/Supervisor/Governor 定向回归 | 149/149 pass，0 fail/skip | persistent replacement、adoption timeout、service generation/crash/close 的平台不变量 |
| `node --check` | 8 个受影响 JS/test 全部 pass | ServiceHost、Worker entry、service state machine、contracts、tests 语法 |
| 定向 ESLint | 使用主仓库 read-only `node_modules` 复跑 pass，0 warning/error | 当前隔离 worktree无本地 `node_modules`；Node tests/ESLint均以 read-only `NODE_PATH` 解析既有依赖，不安装或修改依赖 |
| whitespace 检查 | exact base 至当前 diff 的 `git diff --check` pass | 所有 E09-A 与 reviewer follow-up 改动均纳入检查 |
| blindspot pass | 无 live import 接线；Main/background index 无 Statement Worker require；全 protocol trace 递归拒绝 rows/path/private keys 且不含绝对 source path | 入口旁路、所有权泄漏、局部成功冒充整体成功 |
| reconciliation blindspot pass | 实际调用既有 `buildMappedRows`/statement-session helpers，未新增金额计算；legacy golden 覆盖四金额路径、币种 alias、current/all、balance/manual seed | 输入边界、行序/entry-batch identity、数量对账、资金语义不漂移 |

## Blindspot / Reconciliation Findings

- 入口：仅 dormant `runtime-bindings.js` 将五个 frozen entry key 指向同一 native Worker；`src/main.js` 和 background runtime 未引用，因此 live IPC 继续 legacy。
- 所有权：`fileEntries/detailRows/rowMetas/issues/batches/currentBatchId/stableSummary` 仅存在 Worker state/candidate；Main 方向仅有 generation/revision/counts/IDs 的 bounded snapshot 和 Service Control identity，template evidence 不包含 `selectedBigAccount`。
- 原子性：candidate 在 `resource:request` 前建好，但只有匹配 grant 的 `resource:adopt-ack` 能一次性替换 `state`；reject、stale source、canonical alias、取消、adoption timeout 均不修改旧 revision。pending cancel tombstone 仅结算原 exact request/grant，不放宽其他 stale control。
- 不可达状态：未为并行 job、多 pending interaction 或 E09-B/C/D 角色增加抽象；thread-single 的 busy gate 与冻结 Host 状态机为权威。
- 资金/对账：源文件 stat 读前/后一致性、template digest、session replacement、entry/batch stable order 都在采用前封闭；四金额和币种语义仍由现有 production mapper 唯一决定。
- 关键变量：未改 legacy `statementImportSessions`、`lastFileImportContext`、amount/date/currency constants 或 `FileValidationError`；新 revision/result contract 由 exact validator 与真实 Supervisor done gate 覆盖。遵守任务要求，未运行 variables 扫描脚本。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 真实业务大文件/parser峰值与Windows packaged长驻/app quit | BLOCK（人工/发布门禁） | Release owner在Windows与批准脱敏样本验证 | 阻断Statement production enable |
| 金额/币种/current-all资金语义人工复核 | REVIEW | 独立Reviewer/资金负责人 | 自动测试不可解除production门禁 |
| E09-B token/waiting-user、E09-C generation、E09-D seed settlement | 后续frozen sequence | 后续独立Dev/Reviewer | 不属于E09-A，不得提前实现 |

## Manual Gates

- 资金红线：四金额路径、币种 mapping/alias、current/all 范围、balance/manual seed 由独立 Reviewer/资金负责人人工复核；自动 golden 不替代签字。
- Windows packaged：长驻 Worker 启动、app quit/cooperative close、crash 后资源释放和 RSS 峰值需人工验证。
- 大样本：只能使用经批准的脱敏 statement 验证 parser/预算，不在本轮自动化测试中扩张数据范围。
- 启用门禁：所有 Statement action 保持 `production.enabled=false`、`effectiveMode=legacy`、`effectiveWorkerCount=0`；E09-A 不解锁 production。
