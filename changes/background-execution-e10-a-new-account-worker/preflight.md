# E10-A NewAccount generation core / one-shot Worker Preflight

## Task Brief

- Goal：把 NewAccount 单工作簿生成的业务规则收敛到唯一 core，并提供 `thread-single/job` one-shot Worker 能力。
- Context：父链为已审查 E09-D `7beb80e8151c77dbd659d4192178b07663674009`；当前 live IPC 仍由 legacy handler 生成并直接写正式输出。
- Constraints：只做 E10-A。Worker 只接小型账户 DTO、冻结模板 identity、日期配置和 task staging `generationPath`；不接 final target；不做 E10-B copy/Publisher，不启用 production，不做 R3.2.3。
- Done when：legacy 与 Worker 共用日期/必填/账户/币种/记录/文件名 core；Worker 只对白名单模板工作，写一个 staging workbook 后回读验证；Main contract/technical validation 保持 bounded；crash/cancel/late message 不产生 artifact handle；focused/golden/lifecycle/recovery/integration/smoke/static 与 event-loop/RSS 证据通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| E10-A 只含 generation core/Worker，E10-B 才含 async copy/Publisher | frozen `changes/background-execution-v3.2.x-contract-baseline/changes/3.2.3/{spec.md,techdoc.md}` §9/§11 | 本 PR 不发布、不复制、不改变 `lastGeneratedExports` 的 managed 语义 |
| `new-account:generate` 冻结为 `thread-single/job/native/main-settlement/production=false` | frozen spec §3 | policy 必须保持 `effectiveMode=legacy/effectiveWorkerCount=0` |
| legacy 业务规则集中在 `src/main.js` 的 `buildNewAccountBillDates`、currency/account normalization、record/name 构造 | `src/main.js:3589-3679,12895-13037` | 平移后 main/Worker 必须引用同一实现，不能复制算法 |
| legacy 模板唯一入口为应用内 `assets/余额账单模版.xlsx` | `src/main.js:getBalanceTemplatePath` | Worker 仅接受冻结 allowlist path + snapshot/hash；不接受用户模板路径 |
| writer 保留模板首 sheet、精确 header 顺序、字段格式和 watermark | `src/backend/file-service/writers.js:writeBalanceWorkbook` | Worker 复用既有 writer，业务回读校验 sheet/header/records/date/account/currency |
| task staging 已有 non-symlink/realpath/hardlink ownership validator | `src/main-process/statement-worker/staging-ownership.js` | E10-A 复用同一 ownership 规则，清理仅限已验证的 Main-owned staging path |
| shared Supervisor 已覆盖 cancel/crash/late terminal transport 收口 | `src/main-process/background-execution/{supervisor.js,runtime.js}` 与 toolbox lifecycle tests | 新 Worker 使用 Protocol v1 canonical host，不新增旁路协议 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Worker DTO/结果是否会因账户或日期跨度无界膨胀 | 盲区 | 高 | 容易 | legacy 无显式数量上限 | PROBE | 构造边界 DTO 与 10 年记录数测试 | contract 限制 DTO 字节、账户/币种/预计记录数；legacy live 不新增限制 |
| 模板在 Main 快照后、Worker 读取期间被替换 | 已知未知 | 高 | 一般 | frozen spec 要求 path/snapshot；仅 metadata 快照不足以抵抗同 metadata 内容替换 | PROBE | before/after stat + sha256/tamper 测试 | Worker 校验 allowlist canonical path、snapshot、hash，并在写后复核 |
| staging 路径碰撞/链接替换及失败清理权限 | 盲区 | 高 | 一般 | Statement 已有 ownership validator | PROBE | symlink/hardlink/collision/outside/crash tests | Main 先证 missing ownership；Worker 使用 exclusive create 语义；Main 仅清理验证过的 staging path |
| 日期边界是否要改 UTC 算法 | 隐性偏好 | 高 | 一般 | legacy 是本地日历；冻结验收要求等价 | ASSUME | legacy/Worker 昨日、超过 10 年边界 golden | 保留 legacy 本地日历语义，不静默改时区口径 |
| E10-A 是否应接入 live IPC | 已知未知 | 高 | 容易 | release strategy 要求独立 flag，production=false，E10-B 尚无 Publisher | PROBE | static source-selector test | 只注册 dormant policy/runtime；live IPC 继续 legacy |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 抽取唯一 generation core 和 exact bounded contract | 日期/账户/币种/记录/文件名等价；DTO 有界 | legacy golden + contract 反例 | 推翻 Worker 输入设计 | 保持 legacy handler 调原 helper，缩回纯函数抽取 |
| 2 | 加模板 identity 与 staging ownership guard | allowlist/TOCTOU/清理权限 | tamper/symlink/collision tests | 阻断 Worker 写入 | fail closed，不开放任意路径 |
| 3 | 接入 Protocol v1 one-shot Worker/policy/runtime | cancel/crash/late message/资源释放 | real Worker lifecycle + shutdown/recovery tests | 不允许 runtime 注册 | 保持 policy dormant，不接 live |
| 4 | 写 workbook 并 Worker 业务回读、Main 技术复核 | sheet/header/行数/日期/账户/币种/file hash 血缘 | Worker/legacy projection golden + tamper tests | 不返回 artifact handle | 删除受权 staging 文件并报错 |
| 5 | 静态/集成/smoke/event-loop/RSS 与盲区复核 | legacy、平台和性能不回归 | focused/integration/smoke/node-check/diff-check | 不结案 | 收缩到最后通过的 commit |

## Blindspot / reconciliation 直接 checklist

- 入口旁路：live handler 与 dormant Worker 是否都调用唯一 core；不存在 Worker final target/Publisher/copy。
- 数据契约：exact keys、DTO bytes、账户/币种/日期/预计记录数、结果 manifest bytes。
- 生命周期：collision、cancel、Worker crash、late message、shutdown、restart orphan staging 的权限边界。
- 数据血缘：输入账户顺序 × 日期升序 × 去重币种顺序，输出行数严格等于各账户 `天数 × 币种数` 总和。
- 金额：只生成余额行，`期末余额=0`，其余余额为空；不引入汇率/舍入/借贷方向。
- 日期：开户日到昨日（含首尾）；晚于昨日拒绝；总天数超过 3650 拒绝。
- 币种/账户：不 fallback、不跨账户归并；多账户文件名仍为 `多账号-多币种`；单账户只暴露末四位。
- 输出：首 sheet、精确列序、记录数、有序日期/账户/币种 digest、文件名、模板 hash 可解释。
- 人工门禁：NewAccount 日期、账户、币种和输出记录属于冻结资金红线，自动化不能替代人工复核；Windows packaged 仍留 R3.2.3。
