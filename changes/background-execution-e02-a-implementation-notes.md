# Background Execution E02-A Implementation Notes

> Normative contract remains the merged, self-contained, frozen package at
> `changes/background-execution-v3.2.x-contract-baseline/`. This file records
> implementation decisions and evidence only; it does not amend or override
> that contract.

## Goal / Scope

- 实现 `Policy/Schema/Registry → Protocol Validator → ExecutionSupervisor → Transport Adapters` 的最小公共层和 `background-execution:pure-compute-canary`。
- 仅提供 `commit.kind=none`、`lifetime=job` 的执行切片；不接 DB、ResourceGovernor、AdmissionQueue、ServiceHost、recovery、TaskLifecycle、`src/main.js` 或真实业务 action。
- pure-compute canary 保持 `production.enabled=false`，只由 unit/integration/packaged-path probe 显式调用。

## Decisions / Deviations

| 项目 | 决定与证据 | 影响 |
| --- | --- | --- |
| Runtime Schema | 最终合同的 Policy/Protocol Schema 逐字节固化到 `src/main-process/background-execution/schemas/`；生产模块只 require bundled `src` 路径，测试用 SHA-256 与合同基线对齐 | `package.json build.files=src/**/*` 可携带 Schema；运行时不读取 `changes/` |
| JSON Schema validator | 项目没有可用的 Draft 2020-12 runtime dependency；本 PR 不修改依赖，采用受控的冻结 JS evaluator。编译时递归审计每个 Schema 节点，未知 keyword、外部/unresolved `$ref`、未知 format 直接拒绝 | 当前实际 keyword 集完整支持；未来 Schema 扩张若先于 validator 支持会在启动/测试期 fail closed，不会静默忽略 |
| 支持边界 | 覆盖当前 Schema 使用的 `$ref/$defs`、`allOf/anyOf/oneOf/not/if-then-else`、`additionalProperties/propertyNames/properties`、`const/enum/type/required`、字符串/数组/对象/数值上下界、`uniqueItems/pattern/date-time` | 不是通用 JSON Schema 引擎；新增 keyword/format 必须显式实现并增加 mutation self-test，或后续经依赖评审迁到 Ajv 8 |
| Registry | 完整 policy document 在任何 normalize/extract 前先按原对象执行 JSON-safe、bundled Schema 与 semantic 校验；保留 root metadata 和原 property key，并要求 property/actionKey identity。`production.effectiveMode` 两条规则以及 pure/durable canary action-specific identity 均机械移植冻结 Python validator；canary identity 只在对应 own action 存在时执行，合法 subset registry 不被强制补 action。Protocol/sequence 共用唯一 `policyForAction`：只接受固定 data-method registry，或 plain snapshot 的 own-enumerable data `actions`/action；Proxy/accessor/inherited action fail closed | 注册失败不再被 normalization 静默修复；pure canary 的 entry/result/resource profile 均静态解析；plain-object registry 只读取 own data descriptor 的非 nullish value，不触发 getter/inherited fallback；native Map/Set 固定调用 prototype API，own `get/has` shadow 零调用拒绝 |
| Protocol truth | 公共 Job/Service envelope 只由 bundled Protocol Schema 验证；导出 `validateJobEnvelope(envelope, expectedJobRoute)` 与 `validateServiceControlEnvelope(envelope, expectedServiceRoute)`，默认对 known action、exact route/generation fail closed；adapter-normalized event 直接构造完整 public envelope。所有公开 validate/parse/serialize 路径自行按 compact JSON 计数并固定上限 `262144`，`maxBytes` 只能收紧，调用方 `serializedBytes` 不参与信任决策；sequence validator/tracker 的公共输入也先取 descriptor-safe owned snapshot | exact context、operationKey identity、payload wrapper、UTF-8 bytes 与独立 direction seq 保持单一真相，不产生 adapter 私有 wire schema；raw Buffer 在 parse 前先过固定 byte gate，sequence getter/Proxy 不执行 |
| JSON wire safety | object/array 递归使用 `Reflect.ownKeys` fail closed：拒绝 symbol、非枚举/非 JSON own key、accessor、`toJSON`、稀疏数组、非索引数组键、非 plain object，以及 NaN/Infinity、undefined、BigInt、function、循环引用；Buffer 在 JSON parse 前按 bytes 限制并用 fatal UTF-8 解码 | 本 PR 只定义 canonical JSON wire domain，不声称与 Electron/Node structured clone 的整个值域等价；未来若引入二进制/transferable，必须通过新合同扩展。当前路径不调用 getter，错误 code/path 稳定 |
| JSON equality | Schema `const/enum/uniqueItems` 共用 JSON value equality：object property 次序无关、array 次序相关、有限 number 以 JSON 数值语义比较，因此 `0` 与 `-0` 相等 | 不再借用 Node object identity/deep-strict 语义冒充 JSON Schema equality；三类 keyword 不会产生不同判断 |
| Operation bodies / SafeError | policy-aware gate 在 owned envelope 上验证 progress/result/error/critical/receipt/cancel/cancellation；`job:error/unit:error` 只接受 exact `{code,message,stage,detailLines}`，禁止 stack/cause/额外键，执行 UTF-8 byte ceiling、非空字符串、`maxErrorItems` 与 `finance-safe-v1`。唯一文本检查同时覆盖敏感 key 和带 `=`/`:`/`：` 的中英文 value 标签（账号、订单号、ReconID、金额明细、原始行）；用户目录以 root path segment 识别，覆盖 `=`/`:`/`[`/`file://` 后的 `/Users`/`/home` 与 Windows 正反斜杠，并把 `file://localhost/Users/...`、`file://localhost/home/...` 先归一为本地根路径后走同一判定。`detailLines` 复用 dense plain-array own-data gate。内部 adapter/spawn/timeout/cleanup/diagnostic Error 与 diagnostic callback 均经同一检查脱敏 | inbound progress/SafeError 对敏感 body fail closed；本地 Error/diagnostic 不扩展公共 shape，也不携带 stack/cause/context；普通 `rawRow parser failed`、`order processing failed`、`/opt`、`/var`、`C:\Program Files\...`、普通 HTTP 与非本地 file URL 等非敏感文本保持可观测 |
| Supervisor start/result | 公共面严格提供 `execute/cancel/inspect/closeService/stopAcceptingNewJobs/shutdown`；整个 execute request 在 adapter.start 前使用 own-data/exact-type/JSON-safe gate 并取 owned snapshot，callback descriptor 单独验证。`job:start` send 调用前进入窄化 `dispatching` 因果窗口，允许该同步调用栈内合法 progress/terminal，adapter.start 真 pre-start 仍拒绝，send throw 独立成为 adapter error。unit/result/error 均使用 owned deep-frozen canonical snapshot；function/`validate` 必须同步返回 `true`/`{valid:true}`，`assertValid` 以不抛为成功，任何 thenable 均 fail closed | 不丢同步 legacy dispatcher event，也不扩大到任意 pre-start；getter 型 actionKey 在 JSON-safe gate 前不会执行；E02-A `closeService` 确定性 unsupported |
| Registry binding snapshot | freeze 时由 Registry 一次性解析 entry/adapter/result-validator 并捕获 key→implementation：JSON config 深拷贝冻结，callable 使用已绑定 facade；Supervisor 只读 `getBinding()` | freeze 后 live Map/property 替换不改变已发布的执行实现；plain `{get,has}` facade 在 Registry/runtime 一致拒绝，static registry Proxy 在任何反射前零 trap 拒绝 |
| Cancellation | Supervisor 记录 cancel command `pending/dispatching/sent`、canonical ACK `none/acknowledged` 与 adapter-private terminal evidence；ACK body 只允许冻结 fixture 的 `{cancellation:{scope:'job'}}`，拒绝 unsolicited/duplicate ACK。ACK 只证明 exchange，不参与 execution outcome；`job:error` 只在 adapter/entry-owned 终态证据已交付时归为 cancelled，无论有无 ACK 的 unrelated `EXECUTOR_FAILED` 均为 failed。Existing-dispatch 先记录 dispatcher terminal observation，并将 legacy cancel invocation 延后一轮 microtask：已排队 terminal 先观察时不再调用底层 cancel/建立证据；同步 void cancel 自己触发、随后排队的 rejection 仍由返回点私有证据归为 cancelled，且不伪造 ACK。异步 cancel 与 dispatcher terminal 独立竞速，不把 reject 缓存在可能永不 settle 的 cancel Promise 后。Worker canary 由 entry binding 私有声明 `CANARY_CANCELLED` 终态 code，adapter 只在已发送 cancel 后上报该证据。cooperative cancel 已调用且无独立 terminate 时不二次 cancel冒充 force-stop | CancelReasonV1 始终保持 owned 对象 shape；私有证据不进入 public wire、没有第二份 cancellation schema；公开 cancel 只接受 `user-cooperative`，shutdown 使用独立内部路径处理 `shutdown-only` |
| Settle / cleanup / metrics | first terminal 只关闭一次 settle gate；ExecutionResult 必须等 listener/terminate/close/诊断收口的有界 pipeline 完成后才 resolve。terminate 与 close 分别 exactly-once，terminate 按 policy timeout，即使其悬挂也继续独立 close；失败保留到 shutdown `errors/leakedTransports`。jobId/worker tuple 从首次接受起永久 tombstone。progress rate limit 按 job/direction 使用 1000ms sliding window，恰好 1000ms 旧样本释放 | E02-A 无 ResourceGovernor/lease，因此 release 阶段为空；shutdown 保持有界和权威 report 字段，不写 Task 状态，不会因新 attempt 覆盖旧 transport |
| Adapter boundary | public ExistingDispatchAdapter 严格为 `.start(request, emit)/cancel(handle, reason)/close(handle)`，与 Supervisor 内部 `ready/send/close/terminate` transport bridge 分层；inline/existing 共用 guarded terminal bridge。正常 existing close 只 detach，真实 cancel/force-stop 才 await 底层 cancel/terminate 并映射真实 CancelResult。Worker 同时监听/解绑 `messageerror`，pre-ready 拒绝 ready，post-ready 单路径上报。UtilityProcess `ready` 等待 `spawn`，spawn 前 error/exit 拒绝，`kill()===false` 稳定报错，kill 后有界等待 exit | 公共层不反向依赖业务模块；异常到达 adapter/protocol error 而不悬空；packaged worker 使用 `require.resolve()` 的 `src` 内入口 |
| RFC 3339 | `date-time` 先验证真实日历日/时区边界；`:60` 仅在时区归一后的 6 月 30 日或 12 月 31 日 `23:59` 接受 | 支持合法 leap-second 表达，拒绝普通时刻 `:60` 和如 2 月 29 日的非法日期 |

## Evidence

| 检查 | 当前结果 | 覆盖 |
| --- | --- | --- |
| E02-A targeted unit | `93/93 PASS` | Schema keyword audit/self-test/JSON equality/RFC3339、policy raw-document/semantic/canary identity/subset/descriptor/binding/proxy 负例、23/11 message fixtures、5/24 sequence fixtures、固定 protocol byte cap、Reflect-own-key/invalid-UTF-8、统一 policy lookup/sequence snapshot、Map/Set shadow、SafeError detailLines/finance-safe 中英文 value/用户路径与 localhost file URL、四类 adapter（含 Worker messageerror、entry-owned cancel evidence、hanging cancel Promise、void legacy terminal-before-ACK 与同 tick terminal/cancel 顺序）、Supervisor request/start/cancel/settle/tombstone/progress/result/shutdown/diagnostic 竞态 |
| pure-compute integration | `9/9 PASS` | 实际 Worker spawn、deterministic result、shutdown-only 内部取消、public cancel 拒绝、production gate、packaged path、权威 shutdown report |
| existing error/worker integration | `18/18 PASS` + `40/40 PASS` | 既有 `serialize-error` round-trip 合同与 v2.1.10 worker dispatch/crash/cancel/progress 集成未回归 |
| repository unit | `5695/5696 PASS`、0 fail、1 skip | 356 个 unit 文件的全量回归；新测试由递归 runner 自动发现 |
| repository integration | 49/49 scripts、`2419/2419 PASS` | pure-compute canary 被 integration runner 自动发现；runner 已机械同步 `rules/integration-test-policy.md` |
| release-check | PASS | 最终独立重跑的 lint、smoke、unit 与 integration 全链通过；其中 unit `5695/5696`、integration `2419/2419`。本轮前一次 release-check 的既有 Windows controlled-rehearsal privacy allowlist 用例出现一次非确定性失败，随后隔离 `1/1 PASS`，最终 release-check 中亦通过；更早一轮观察到的既有 Toolbox RSS 样本波动也已在最终链路 `31/31 PASS` |
| repository smoke / ESLint | PASS / PASS | important-variable Critical 命中要求的 smoke，以及完整 lint gate |
| targeted ESLint / diff check | PASS | E02-A 源码、测试、integration script lint；无 whitespace error；integration script 由 runner 自动发现，无需手写注册 |
| important-variable check | REVIEWED（命中时工具按设计 exit 2）；Critical `freezeWorkerBatchContext`、Runtime-state `state` | 只调用现有 exact-seven validator，未增删/放宽 context，未接 TaskLifecycle/recovery；命中的 `state` 是 Supervisor job/unit-local 状态字段，不是 `src/renderer.js` 单例，不影响模板/当前模块/导出可用性联动；full unit/integration/smoke 与 release-check 已通过 |
| bundled Schema hash | Policy `e5a584903d8c88b1f6cce00cbe5e308796bed331ca476458833eb9c448f99ae8`；Protocol `d3f38eab7f0f5793fccc6d6f042199172c071887e386349d2559435565a99a43` | bundled bytes 与最终合同基线逐字节一致 |
| packaged-input checker | EXPECTED LOCAL WORKTREE FAILURE | checker 比较 `git diff HEAD`，所以已暂存但尚未提交的 E02-A `src` 仍属于 tracked dirty；用户既有未跟踪 `assets/清结算自有账户表.xlsx` 也命中 `build.files`，本任务不触碰该 asset。权威复跑位置是包含 E02-A PR commit 的 clean checkout/CI；合并前可在独立 clean worktree 或 CI 验证；该失败不代表 runtime 从 `changes/` 取 Schema |

## Remaining Unknowns

| 未知 | 分级/处理 | 合并影响 |
| --- | --- | --- |
| Windows Setup/portable 中 worker/schema 的真实 asar 路径、artifact 内容与退出行为 | PROBE：E02-A 仅证明 build.files 与 `require.resolve` packaged-path 模式；需 Windows packaged artifact/asar 人工或 CI probe | 不阻塞 test-only canary 合并；是任何 production enablement 的硬门禁 |
| 四类真实业务 action 的 legacy dispatcher payload/取消细节 | PROBE：本 PR 只验证 generic adapter 与 pure canary，不迁移 action | 由各版本 migration PR 用 action-specific fixture 闭合 |
| Electron utility process 的实际 packaged spawn-ready/kill 细节 | PROBE：单测按 Electron 36 API 使用注入 transport，当前 E02-A 未引入 ServiceHost 或产品入口 | 不阻塞 generic adapter；接入真实 utility action/production enablement 前必须做 packaged probe |
| 完整 Windows build-input/package gate | PROBE：当前本地工作树包含尚未提交的 E02-A `src`，且用户既有未跟踪 asset 命中 `build.files`，因此 `check:packaged-inputs` 按设计无法通过 | 在包含 PR commit 的独立 clean worktree/CI 权威复跑；不得删除或改动用户 asset，无需产品选择 |
