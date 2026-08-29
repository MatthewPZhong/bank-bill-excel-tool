# E10-A NewAccount generation core / one-shot Worker Preflight

## Task Brief

- Goal：把 NewAccount 单工作簿生成的业务规则收敛到唯一 core，并提供 `thread-single/job` one-shot Worker 能力；readback 全阶段必须在冻结 5 秒 cooperative timeout 内真实响应 shutdown cancel。
- Context：父链为已审查 E09-D `7beb80e8151c77dbd659d4192178b07663674009`；当前 live IPC 仍由 legacy handler 生成并直接写正式输出。
- Constraints：只做 E10-A。Worker 只接小型账户 DTO、冻结模板 identity、日期配置和 task staging `generationPath`；不接 final target；不做 E10-B copy/Publisher，不启用 production，不做 R3.2.3。
- Done when：legacy 与 Worker 共用日期/必填/账户/币种/记录/文件名 core；Worker 只对白名单模板工作，写一个 staging workbook 后回读验证；Main contract/technical validation 保持 bounded；250k 的 readFile 后、row/evidence batching 与 terminal 前取消均稳定 `cancelled`、Main-only cleanup；focused/golden/lifecycle/recovery/integration/smoke/static 与 event-loop/RSS 证据通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| E10-A 只含 generation core/Worker，E10-B 才含 async copy/Publisher | frozen `changes/background-execution-v3.2.x-contract-baseline/changes/3.2.3/{spec.md,techdoc.md}` §9/§11 | 本 PR 不发布、不复制、不改变 `lastGeneratedExports` 的 managed 语义 |
| `new-account:generate` 冻结为 `thread-single/job/native/main-settlement/production=false` | frozen spec §3 | policy 必须保持 `effectiveMode=legacy/effectiveWorkerCount=0` |
| legacy 业务规则集中在 `src/main.js` 的 `buildNewAccountBillDates`、currency/account normalization、record/name 构造 | `src/main.js:3589-3679,12895-13037` | 平移后 main/Worker 必须引用同一实现，不能复制算法 |
| legacy 模板唯一入口为应用内 `assets/余额账单模版.xlsx` | `src/main.js:getBalanceTemplatePath` | Worker 仅接受冻结 allowlist path + snapshot/hash；不接受用户模板路径 |
| writer 保留模板首 sheet、精确 header 顺序、字段格式和 watermark | `src/backend/file-service/writers.js:writeBalanceWorkbook` | Worker 复用既有 writer，业务回读校验 sheet/header/records/date/account/currency |
| task staging 已有 non-symlink/realpath/hardlink ownership validator | `src/main-process/statement-worker/staging-ownership.js` | E10-A 复用同一 ownership 规则，清理仅限已验证的 Main-owned staging path |
| shared Supervisor 负责发 shutdown cancel 与终态收口，但同步 XLSX 阶段必须由模块主动让出 Worker 消息循环 | `src/main-process/background-execution/{supervisor.js,runtime.js}`；Reviewer P2 真实 runtime 失败回放 | 新 Worker 使用 Protocol v1 canonical host；模块在重型阶段间和 `job:done` 前提供 cancellation safepoint，不修改全局 Supervisor 语义 |
| `MAX_RECORDS=250000` 与静态 `PhaseLease.memoryBytes=256 MiB` 不匹配 | Reviewer 真实 Worker 探针：29,192 行 RSS delta 467,648,512 bytes，60,416 行 572,456,960 bytes | 不得降低业务上限掩盖准入低估；必须在 Worker spawn 前按可验证输出行数动态申请 |
| `resources.profile` 已是 Registry 静态引用，Supervisor 在 `adapter.start()` 前获取 PhaseLease | `execution-policy-registry.js` 的 `resourceProfileRegistry/getBinding`；`supervisor.js:start/acquireSimpleJobResources` | E10 可绑定 Main-only 同步纯 estimator，不改 Protocol/Schema；其他 action 保持静态 phase |
| row-only `448 MiB + 4096 bytes/row` 仍低估合法业务形状 | 本机高预算真实 Worker：250,000 短文本 reservation 1,493,762,048、RSS delta 1,761,820,672；60,416 最大合法 CJK 文本 reservation 717,225,984、RSS delta 1,881,407,488 | estimator 必须从已验证 DTO 计算每行实际重复文本的 UTF-8/UTF-16、记录/单元格结构及 writer/readback 多份驻留，不得只提高统一 per-row 常量 |
| 合法业务 digest 会被通用 full-account gate 误杀 | 250,000 短文本真实 Worker 完成 workbook 后以 `PROTOCOL_PRIVACY_VIOLATION` 收口；另有 4 行真实输入可稳定生成含 17 位数字串的 `recordsSha256` | 只能在 E10 result validator 上按 exact JSON pointer + lowercase 64hex + 冻结父 shape 最小放行；不得修改全局账号检测或通用 digest key 集合 |
| readback 内只有整体结束后的 safepoint，250k 正常任务可越过 cooperative timeout | 第二替代 Reviewer：workbook 已写盘，shutdown 约 4997 ms 到达，最终 `cancel-timeout/transport-lost`；本机阶段 probe：`XLSX.readFile` 3197 ms、`sheet_to_json` 566 ms、row normalize 5 ms、actual/expected evidence 1758/1986 ms | 不能把 readback 当一个同步阶段；必须在不可分割段前后立即 yield/check，并把长循环拆为有界批次，保持落盘业务回读与四 digest |
| 流式回读消除了合法边界的单段5秒假设 | 真实250k回读：workbook open后row scan约884ms、expected evidence约299ms、artifact hash约73ms；六场景/五阶段shutdown为11–16ms；最终复跑60,416最大文本正常Worker 2867ms | actual worksheet按ZIP stream读取、row/evidence各1024行一批；Supervisor 5秒、Writer、Protocol均不改 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Worker DTO/结果是否会因账户或日期跨度无界膨胀 | 盲区 | 高 | 容易 | legacy 无显式数量上限 | PROBE | 构造边界 DTO 与 10 年记录数测试 | contract 限制 DTO 字节、账户/币种/预计记录数；legacy live 不新增限制 |
| 模板在 Main 快照后、Worker 读取期间被替换 | 已知未知 | 高 | 一般 | frozen spec 要求 path/snapshot；仅 metadata 快照不足以抵抗同 metadata 内容替换 | PROBE | before/after stat + sha256/tamper 测试 | Worker 校验 allowlist canonical path、snapshot、hash，并在写后复核 |
| staging 路径碰撞/链接替换及失败清理权限 | 盲区 | 高 | 一般 | Statement 已有 ownership validator | PROBE | symlink/hardlink/collision/outside/crash tests | Main 先证 missing ownership；Worker 使用 exclusive create 语义；Main 仅清理验证过的 staging path |
| 日期边界是否要改 UTC 算法 | 隐性偏好 | 高 | 一般 | legacy 是本地日历；冻结验收要求等价 | ASSUME | legacy/Worker 昨日、超过 10 年边界 golden | 保留 legacy 本地日历语义，不静默改时区口径 |
| E10-A 是否应接入 live IPC | 已知未知 | 高 | 容易 | release strategy 要求独立 flag，production=false，E10-B 尚无 Publisher | PROBE | static source-selector test | 只注册 dormant policy/runtime；live IPC 继续 legacy |
| 真实 Worker 的同步 XLSX 生成是否会阻塞 shutdown-only `job:cancel` 直到 `job:done` | 状态生命周期盲区 | 高 | 容易 | 原实现只在同步阶段间读 `signal.aborted`，但 Worker 无机会处理 cancel message | PROBE | 等 `control.ready/state=running` 后立即 shutdown 的真实 runtime 回归 | 修复前稳定得到 `completed` 且 staging 残留；改为 write 前后/readback 后/terminal 前 async safepoint，取消时仅 Main/client 清理 |
| 准入前能否与实际 `records.length` 使用同一计数口径 | 数据契约 | 高 | 容易 | contract 已内联计算“各账户开户日至昨日天数 × 币种数”，core 以相同组合造行，但尚未共享函数 | PROBE | 提取 contract 纯函数，golden/property 对照 core 实际行数 | estimator 和 input limit 共用唯一投影；不把计数字段加入冻结 DTO |
| 保守内存 envelope 如何既覆盖 workbook/readback 又不对小任务一律按 250,000 行预留 | 容量 | 高 | 容易 | v1 两个短文本点支持 row slope，但250k/最大文本反例证明统一 4096 bytes/row 不足 | PROBE | 确定性shape边界单测 + 250k短文本/60,416最大文本真实 benchmark | v1 row-only 已推翻；v2 按 record/cell overhead、实际 UTF-8/UTF-16 writer/readback copies 与固定 safety 估算，0..250,000/overflow fail closed |
| 如何在不物化 records 的前提下精确描述合法文本 shape | 数据契约 | 高 | 容易 | bounded DTO 已含规范化 bankName/location/bankAccount/currencies/openingDate，输出每行另有固定 10-byte 日期和 9 cells | PROBE | 把共享行数 projector 扩为 shape projector，并与实际 records 的行数、UTF-8/UTF-16 文本总量做 property/golden 对照 | Main admission 只遍历账户/币种配置，按 `天数 × 币种` 安全整数累计实际重复文本；不构造业务 rows |
| writer/readback 同驻留的保守倍率如何校准 | 容量 | 高 | 容易 | 250k 短文本主要暴露记录/单元格结构，60,416 最大 CJK 文本主要暴露多份字符串/XML/readback 驻留 | PROBE | 两个真实反例分别校准结构项和文本项，确定性模型再向上留固定 safety 与可解释 copies | 使用独立 record/cell overhead、writer/readback UTF-8/UTF-16 copies 和固定 safety；真实 RSS 只作方向性覆盖证据，Windows gate保留 |
| E10 digest 最小放行是否会扩大其他 action/路径或接受 schema-invalid 结果 | 隐私/合同 | 高 | 容易 | Protocol 已从 action-specific result validator 读取 `allowFinanceSafeValue`；Statement/MPT 已有局部 delegate 范式 | PROBE | 每个 exact path、近邻 path、大小写/长度错误、同名异路径、schema invalid 与真实 Worker completed | delegate 只挂在 `validateNewAccountGenerationResult`，父对象必须通过拆出的冻结 artifact/evidence validator；最终 result validator仍独立 fail closed |
| 单次 `XLSX.readFile` 在最大合法文本形状是否可能独自达到 5 秒 | 状态生命周期盲区 | 高 | 一般 | 已消除：60,416旧readFile为1267ms，但250k已达3197ms，不能据此外推跨平台；生产readback不再调用`XLSX.readFile` | PROBE→RESOLVED | 用既有ZIP reader定位sheet，实际worksheet XML按stream分批扫描 | 不改timeout；无单段全workbook materialize |
| canonical businessEvidence 能否分批且与现有 `canonicalSha256(array)` byte-for-byte 一致 | 数据/审计合同 | 高 | 容易 | 已证实：0/1/2051 property及真实250k/60,416四digest均与旧canonical oracle一致 | PROBE→RESOLVED | 共享incremental canonical-array hasher；每个row仍使用相同JSON scalar、逗号、括号和顺序 | 只改变内存/编排，不改变四digest |
| test-only stage hook 是否会扩大 public/protocol surface | 测试边界 | 中 | 容易 | 已证实：独立WorkerData MessagePort注入；contract/result/static Registry没有stage字段 | PROBE→RESOLVED | 真实Worker精确暂停；static test锁定generation contract不含hook | 端口只在测试entry options存在，不进入canonical envelope |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 抽取唯一 generation core 和 exact bounded contract | 日期/账户/币种/记录/文件名等价；DTO 有界 | legacy golden + contract 反例 | 推翻 Worker 输入设计 | 保持 legacy handler 调原 helper，缩回纯函数抽取 |
| 2 | 加模板 identity 与 staging ownership guard | allowlist/TOCTOU/清理权限 | tamper/symlink/collision tests | 阻断 Worker 写入 | fail closed，不开放任意路径 |
| 3 | 接入 Protocol v1 one-shot Worker/policy/runtime，在同步 XLSX 阶段间与终态前让出消息循环 | cancel/crash/late message/资源释放；shutdown cancel 不得被 `job:done` 覆盖 | real Worker lifecycle + running-shutdown cancel-wins/recovery tests | 不允许 runtime 注册或取消终态可伪报成功 | 保持 policy dormant，不接 live；不泛化 Supervisor |
| 4 | 写 workbook 并 Worker 业务回读、Main 技术复核 | sheet/header/行数/日期/账户/币种/file hash 血缘 | Worker/legacy projection golden + tamper tests | 不返回 artifact handle | 删除受权 staging 文件并报错 |
| 5 | 静态/集成/smoke/event-loop/RSS 与盲区复核 | legacy、平台和性能不回归 | focused/integration/smoke/node-check/diff-check | 不结案 | 收缩到最后通过的 commit |
| 6 | 共享行数投影、动态 resource profile 与 spawn 前准入 | MAX_RECORDS 与实际业务行数不变；低内存/并发不越 system reserve | 0/typical/29,192/60,416/250,000、overflow、低 budget no-spawn、并发 lease 不超预算 | OOM/侵占 reserve 或过度预留 | 保留 production=false；estimator/profile 绑定可单独回滚 |
| 7 | 把共享 projector 扩为 shape-aware 文本/单元格 envelope | 短文本 250k 与最大合法文本不能低估；小任务不按最大 shape 收费 | exact row/cell/UTF-8/UTF-16 projection、Unicode/边界/overflow、两个真实 RSS 反例均被 reservation 覆盖 | 继续存在 reserve 侵占/OOM 风险 | production 保持 false；模型常量可独立向上校准，不改 MAX_RECORDS/业务输出 |
| 8 | 在 E10 result validator 增加 exact-path digest delegate | 合法 digest 不误杀，账号/普通字符串与其他 action 仍 fail closed | 5 个允许 path、近邻 path/错误值/schema invalid、含数字串 digest 的真实 Worker completed | 正常 Worker 可伪报 transport-lost或隐私边界扩大 | 只撤回 validator property；不动全局 finance-safe gate |
| 9 | 把 readback 改为可协作取消的 async 编排 | 读取真实落盘 XLSX、sheet/header/rowCount/四 digest 不变；任一长窗口小于 5 秒并可观测 cancel | 250k/60,416阶段计时；旧同步 digest等价；readFile后/row/evidence/terminal取消；真实250k多轮shutdown | 任一合法阶段仍可触发cancel-timeout，或golden/digest漂移 | 不改Supervisor/timeout/Writer；不可分割 readFile 若不满足则收缩到可终止隔离方案 |

## Blindspot / reconciliation 直接 checklist

- 入口旁路：live handler 与 dormant Worker 是否都调用唯一 core；不存在 Worker final target/Publisher/copy。
- 数据契约：exact keys、DTO bytes、账户/币种/日期/预计记录数、结果 manifest bytes。
- 资源准入：预计行数与实际 records 守恒；估算公式、常量、上下界和overflow可审计；无法容纳的任务不创建 Worker，并发 active usage 不超 Governor memory budget/system reserve。
- 资源 shape：逐账户/币种/日期累计的实际规范化 UTF-8/UTF-16 与 SheetJS XML 单元格编码是否与输出文本守恒；Unicode/控制字符、256/64 字段上限、9-cell 固定形状和 writer/readback 多份驻留是否全部计入。
- 隐私 gate：只允许 `/payload/result/artifact/templateSha256` 与 `businessEvidence` 四个冻结 digest path；近邻路径、同名异路径、普通字符串、错误大小写/长度和 schema-invalid 仍拒绝。
- 生命周期：collision、cancel、Worker crash、late message、shutdown、restart orphan staging 的权限边界；真实 running Worker 的 shutdown cancel 必须胜过尚未发送的 `job:done`。
- readback 取消：`readFile`、sheet materialize、row normalize、actual/expected 四 digest 每个窗口均有界；每批 yield 后先检查 signal；取消结果不得携带 artifact/result，Main cleanup 恰好一次且 staging/final=0。
- 数据血缘：输入账户顺序 × 日期升序 × 去重币种顺序，输出行数严格等于各账户 `天数 × 币种数` 总和。
- 金额：只生成余额行，`期末余额=0`，其余余额为空；不引入汇率/舍入/借贷方向。
- 日期：开户日到昨日（含首尾）；晚于昨日拒绝；总天数超过 3650 拒绝。
- 币种/账户：不 fallback、不跨账户归并；多账户文件名仍为 `多账号-多币种`；单账户只暴露末四位。
- 输出：首 sheet、精确列序、记录数、有序日期/账户/币种 digest、文件名、模板 hash 可解释。
- 人工门禁：NewAccount 日期、账户、币种和输出记录属于冻结资金红线，自动化不能替代人工复核；Windows packaged 仍留 R3.2.3。
