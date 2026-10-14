# Implementation Notes — v3.2.12 业务 OP 升级阻断启动修复

<!-- document-identity
 document-id: v3.2.12-fix-bizop-upgrade-startup/implementation-notes
 target-version: v3.2.12
 branch: fix/bizop-upgrade-startup
 baseline: 52b92b55c3d91f7a431ff62419e8712a6ed1774e
 revision: R2
-->

> 目标版本：v3.2.12 · 功能分支：`fix/bizop-upgrade-startup` · 基线：`v3.2.11`（`52b92b55`）
> 状态：R2 已实施（2026-10-06，用户确认按 R2 修改调度核心后开始），未提交。本文件在实施过程中增量更新，不覆盖已有内容；被替代的决定和假设保留原行并标注。

## Baseline

- Goal/spec：[spec.md](spec.md)（F1 准确诊断、F2 有界等待、F3 旧格式月度文件兼容）。
- Initial plan：[techdoc.md §九 实施顺序](techdoc.md#九实施顺序)。
- Done when：[spec.md §4.4](spec.md#44-完成标准)。
- 事实依据：[baseline-evidence.md](baseline-evidence.md)。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| D1 升级预检复用 `acquireBizOpPhaseLease` | 已具备“不可能满足立即拒绝、暂时占用排队 5 秒、原生截止时间”的语义，且有 5 个调用方和专门测试（TechDoc §1.1） | 在 upgrade-main 内另写等待逻辑；只把 `timeoutMs` 改为 5000 而保留 `reject` | 升级预检与其他业务 OP 阶段口径一致 |
| D2 ~~诊断采用“拒绝后快照”，不重构准入判定器~~（R1，已被 D2a 替代） | 诊断包需要尽快交付；改动只集中在 helper；~~时点差异只影响系统内存这一项~~（被 [S15](baseline-evidence.md#s15) 否定） | 结构化判定 `AdmissionDecisionV1`（改动调度器、内存准入、队列 3 个核心模块） | — |
| D2a 诊断以“判定记录”为准，另附标注过的“拒绝后现场”（R2；用户 2026-10-06 确认） | 评审指出、并经核实：超时错误不带候选额度，判定原因在 `evaluate`/`canAdmit` 中丢失（[S14](baseline-evidence.md#s14)）；`catch` 时的快照不等于判定时的现场（[S15](baseline-evidence.md#s15)）。诊断包很可能只有一两次机会拿到现场，原因必须可靠 | 只做拒绝后快照（给不出原因和超时候选）；完整的 `AdmissionDecisionV1`（要改返回类型和队列） | 改动扩大到 `memory-admission.js`、`resource-governor.js`；只增加可选记录，不改判定分支、返回值和错误码（TechDoc §3.2、§六） |
| D3 F3 只放宽第一轮扫描，并且只允许缺 v3.1.11 新增的两张表 | 第一轮不授权清理；原 provider 会补齐结构（已验证，[S11](baseline-evidence.md#s11)）；第二轮保持严格 | 扫描前给旧文件补表（会在只读检查阶段写文件）；两轮都放宽（会削弱清理授权） | 旧格式用户可以完成升级；补不齐时仍然 fail-closed |
| D4 不做启动恢复窗口（此前方案的 B 阶段） | 对“每次必现”的用户无法恢复可用性；要改动启动和退出主链路，验收面大（TechDoc §1.3） | 本分支同时实现 B | 资源问题仍会阻断启动，但能给出真实原因 |
| D5 外层错误码保持 `BIZOP_ACTIVATION_RESOURCE_UNAVAILABLE`，内部原因写入明细 | 已有测试、文档和用户认知都基于该码；新信息放在 `detailLines` 和 `cause` | 直接抛出 helper 的错误码 | 兼容现有判读方式 |
| D6 不改版本号、不打 tag、不发 Release；诊断包从分支经 `workflow_dispatch` 出 | 只发给报障用户；正式版本另行发布 | 发布预发布版本 | 推送分支需要另行授权 |
| D7 分支名使用 `fix/` 前缀 | 用户要求；仓库已有 `fix/concat-field-marker` 先例；CI 不依赖该前缀 | `codex/…` | 无 |
| D9 post-outbox 入口在存档控制器的包装处透传明细（R2） | post-outbox 包装丢掉了全部明细（[S13](baseline-evidence.md#s13)）；控制器就是包装边界，与 owner 入口用同一格式 | 改 `startup-failure.js`，让它递归读取 `cause`（会改变所有启动失败的展示方式）；只在 BizOP participant 内处理（控制器仍会丢掉） | 所有 post-outbox 钩子的失败弹窗都会多出原错误的明细（TechDoc §3.4） |
| D10 G1 回归纳入持续门禁（R2） | CI 此前只覆盖 G2（[S11](baseline-evidence.md#s11)）；单测不能代替正式装配下的启动链路 | 只靠单测加复现工具的人工对照 | 新增集成测试；`verify-windows-app.js` 多一个 G1 种子；复现工具只作证据，不作门禁（TechDoc §7.3） |
| D8 文档与代码在开发完成后一起提交，合入 `release/v3.2.12` | 用户决定（2026-10-06）；合入路径见 `AGENTS.md:69-71` | 先在分支上单独提交文档 | 开发期间文档只在工作区；提交和推送仍需授权（[TechDoc §八](techdoc.md#八交付)） |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| A1 Windows 上原 provider 也能补齐 G1 月度文件的结构 | macOS 验证通过；同一代码路径在 v3.1.11+ 中长期用于打开旧月份 | 第二轮仍报 `SCHEMA_INCOMPLETE`（fail-closed，不会误清理） | Windows 正式包“旧版本首次升级”验收（Spec §4.4） |
| A2 v3.0.13 之前不存在更老的、缺少基础 4 表的月度文件格式 | 本地标签中最早可核对的是 v3.0.13 | 这类文件第一轮仍按原规则失败 | 如出现，按 F1 明细另行处理 |
| A3 ~~从拒绝结算到 helper 的 `catch` 之间，活动、租约、队列不会实质变化~~（R2：**已失效**） | ~~两者之间只经过 Promise 微任务~~；实际上到期拒绝之后，同一个同步循环里还会继续授予（[S15](baseline-evidence.md#s15)） | 诊断与判定时的现场有偏差 | 由 D2a 的判定记录承担原因判断；拒绝后现场只作辅助并标注 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 夹具放在 `tests/fixtures/biz-op-v327/legacy-side-ddl-v3.1.10.sql` | 放在 `tests/fixtures/biz-op-v327-legacy-side-ddl-v3.1.10.sql` | 该目录现有业务 OP 夹具都是 `biz-op-v327-*` 平铺命名 | 无 | TechDoc 已同步 |
| T13/T14 分别写在 `memory-admission.test.js` 和 `resource-governor.test.js` | 都写在 `memory-admission.test.js` | 该文件已有带假时钟的内存准入夹具，能同时覆盖原因码和三处错误 | 无 | TechDoc 已同步 |
| 示例中低内存档的原因也是 `unbounded-growth` | 低内存档实际先命中 `heavy-active` | 低内存档要求独占，遇到任何重型外部活动先拒绝（基线 `memory-admission.js:105`），轮不到增长检查；T3 实测确认 | 明细文案与示例不同，判读不变 | Spec AC1.1、TechDoc §3.2/§3.3/T3 已同步 |
| helper 直接引用 `background-execution/memory-activity.js` | 改为经 `src/main-process/memory-activity.js` 门面引用 | 与 `memory-profiles.js` 的引用方式一致，共享同一份活动登记 | 无 | — |
| `evaluation-busy` 有单测 | 未单测 | 判定重入只在判定过程中同步发生，无法从外部稳定构造 | 该原因码只有文案映射没有测试 | TechDoc T13 已注明 |
| 本地先用开发模式跑一遍 `verify-windows-app.js`（T19） | 本机未跑通，改用复现工具做同一场景的真实启动对照 | 本机是 macOS，不在资格清单内，预检走兼容上限；本机 `os.freemem` 约 1.6 GB，减去 2 GiB 预留后兼容上限为 0，预检立即以 `stable-limit` 拒绝。这是环境限制，基线代码同样会拒绝；新明细一行就指出了原因 | T19 只能在 Windows CI 上执行 | TechDoc §7.3 已注明 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| [startup-scenarios-2026-10-06.json](evidence/traces/startup-scenarios-2026-10-06.json)（基线 v3.2.11） | S1–S4 成功；S5 及两次重启稳定报 `SCHEMA_INCOMPLETE`；所有预检现场为空 | P-SCHEMA 复现；P-RES 本地未复现 |
| [precheck-policy-probe.js](evidence/repro-harness/precheck-policy-probe.js)（基线） | 空闲获批 384 MiB；一个未退出载体即拒绝，文案与用户一致；载体退出后获批 | 用户报错的触发机制 |
| [side-db-upgrade-probe.js](evidence/repro-harness/side-db-upgrade-probe.js)（基线） | G1 文件两轮均失败；经当前 `openSideDb` 打开后两轮均通过，数据保留 | D3 的前提 |
| 评审核实（2026-10-06，只读） | 评审的 4 条意见都与基线代码一致：post-outbox 明细丢失、超时无候选额度、`catch` 快照时序、G1 无持续门禁（[S13](baseline-evidence.md#s13)–[S15](baseline-evidence.md#s15)、[S11](baseline-evidence.md#s11)） | D2a、D9、D10 的依据 |
| 新增与改写的单测（本地 macOS） | `biz-op-v327-upgrade.test.js` 36/36；`memory-admission.test.js` 28/28；`biz-op-v327-phase-admission.test.js` 8/8；`biz-op-v327-upgrade-resource.test.js` 16/16（T5 为评审后补测，见下一行）；`archive-center-controller.test.js` 与 `application-recovery.test.js` 67/67。F3 用例和 G1 集成脚本先在基线代码上确认失败，再确认通过 | T1–T19 中除 T19 外全部（T5 于评审后补齐） |
| `npm run release-check`（本地 macOS，2026-10-06） | 通过（exit 0）：lint、架构检查（788/788）、smoke 通过；单测 9620 条中 9616 通过、0 失败、4 条 Windows 专用用例跳过；84 个集成脚本全部通过，含新增的 `biz-op-legacy-side-db-upgrade` 2/2 | 完整本地门禁 |
| [g1-upgrade-r2-2026-10-06.json](evidence/traces/g1-upgrade-r2-2026-10-06.json)（真实 Electron 开发模式，模拟 win32/x64、16/5 GB） | 同一份 3.0.26 加 3 个 G1 月度文件的种子：v3.2.11 启动失败（`SCHEMA_INCOMPLETE`，停在 MIGRATING）；本分支 owner 与 post-outbox 两次预检均获批，到达 ACTIVE，窗口创建，旧文件全部回收 | AC3.1 在真实启动链路上的对照 |
| 实现评审（2026-10-06，外部只读） | 指出 T5 / AC1.2 没有持续测试：原 512 MiB 用例未装配内存准入，只覆盖 helper 的固定预算预检。已核实并补测：装配内存准入、申请未登记、兼容上限 512 MiB 时立即拒绝、零排队、外层码不变，明细含“实际候选额度：1024.0 MiB”和“调度器原因：stable-limit（兼容上限 512.0 MiB）”。评审另做的 G1 未 checkpoint WAL 验证结果为通过（本地未重复） | AC1.2；补测后已重跑完整 `release-check`，见下一行 |
| `npm run release-check` 复跑（补测后、提交前，2026-10-06） | 通过（exit 0）：单测 9621 条中 9617 通过、0 失败、4 条 Windows 专用跳过；84 个集成脚本全部通过 | 提交内容的最终本地门禁 |
| 门禁副作用 | `test:integration` 按约定自动重写 `rules/integration-test-policy.md` §七（清单与耗时）；该文件 §七 之外的用户未提交改动保持不变 | 提交时需一并确认 |
| Windows 正式包验收（T19） | **未执行**：需要推送后由 `build-windows.yml` 在 Windows 上运行 | AC3.5 的 Windows 部分、A1、U3 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| U1 用户机器上第一次预检时的实际阻塞项 | PROBE | 诊断包发给报障用户，收集对话框截图 | 不阻塞本分支合并；根因修复另起 C 阶段 |
| U2 报障用户是否有 G1 月度文件 | PROBE | 由诊断包的启动结果间接确认 | 不阻塞 |
| U3 Windows 下载体退出时序和句柄行为是否与 macOS 不同 | ASSUME（A1） | Windows 正式包验收 | 未完成前不宣布正式修复 |
