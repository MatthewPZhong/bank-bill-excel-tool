# G4 共用 XLSX 基础设施实施记录

本文件是 X0–X4 的唯一切片索引；需求与行为合同见 [Spec](spec.md)，职责/迁移设计见 [TechDoc](techdoc.md)，完成标准见[总索引 §6.2–6.4](../../README.md#slice-completion)。设计文档原样复制自用户给出的主工作区，文档内“未实施”为原设计时点；当前实现、验证、集成状态以本记录为准。

**当前结果（2026-09-20 复验）：X0–X4 已实现；本地完整 `release-check` 已通过，单测8151通过/0失败/4项Windows跳过，61/61集成脚本通过，已报告断言汇总2630/2630。平台验收及G6/G8/release集成仍未完成。前轮失败保留于历史章节，最新证据见末尾复验记录。**

## 工作区与边界

- 分支：`codex/v3.2.10-shared-xlsx-infrastructure`。
- worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-shared-xlsx-infrastructure`。
- 基线与当前 HEAD：`11086a3cbf632a30adbcfa796e4cd81810c5aef9`（本地 main / v3.2.9）；所有本次改动未提交，验证须结合 dirty 差异。下列切片统一继承该代码状态；最终对应 [代码差异](evidence/code.diff) 与 [逐文件哈希快照](evidence/final-source-snapshot.json)，验证结束后逐文件复核无漂移。
- 主工作区现有未跟踪设计及其他功能工作区保持原状；不提交、推送、合并、开 PR、升版或发布。
- 实测环境：macOS，Node v25.8.0；依赖复用主工作区 node_modules。首轮 Node 向上解析可运行大部分测试，但历史快照/NSIS测试要求worktree内存在node_modules路径；已增加指向既有依赖的本地symlink，未安装或修改依赖。

## Decisions 与并行归属

- 原样提取两类 reader 和公共闭包，原入口只转发同一个 module.exports。SST 缺省 64 MiB / 8192 由公共实现自有常量提供，业务 adapter 显式保留自身有效配置；不引入 profile 或 errorFactory。
- legacy 头部“内存常数”注释与实际实现不符，本次更正说明：完整 ZIP/SST 全量加载，maxRows 只约束行扫描；算法不变。
- 生产调用清点超出设计列举的消费者时，同组迁移 import，保留业务函数与原样 projection。
- 已向 G6“实施存储与执行分离”任务协调：G4 负责 VCC reader/helper imports 及 reader options；G6 负责 hash/lineage 提取与对应 imports。重叠为 review-export-plan.js、dataset-writer.js 等文件的不同函数职责；当前不跨分支合并。
- G8 在本基线不存在。按总索引 §6.2 运行本分支闭包/弃用入口检查，后续由 G8 维护 ARCH-XLSX-INFRA 和 deprecatedEntrypoints 的正式 active 配置；不伪造已集成状态。

## 切片进度

| 切片 | 本次范围 | 实现状态 | 验证状态 | 集成状态 |
| --- | --- | --- | --- | --- |
| X0 | 基线 reader/provider/options 差异冻结 | 已实现 | 通过 | 未集成 |
| X1 | 六个叶子、ZIP、workbook-parts 与 Toolbox 装配 | 已实现 | 通过 | 未集成 |
| X2 | SST provider 与旧入口 | 已实现 | 通过 | 未集成 |
| X3 | legacy/rich/preflight 与 L1/L2/S1 | 已实现 | 部分通过（本地自动门禁通过；平台待验） | 未集成 |
| X4 | R1–R4/T1、扩展消费者及边界验证 | 已实现 | 部分通过（本地自动门禁通过；平台待验） | 未集成 |

### X0：基线冻结

- 职责与边界：只增加行为 fixture，不改变原责任归属；以固定基线运行差异 fixture。
- 调用方与兼容：清点生产、测试、scripts 入口；保留旧路径兼容测试。实际 options 清单由消费者证据记录。
- 业务行为：G4-AC-02/03/04/07；预算、null/undefined 差异和 callback 同步语义分别冻结。
- 验证：提取前 `node --test tests/unit/backend/shared-strings-ownership.test.js tests/unit/backend/pending-import/streaming-xlsx-reader.test.js tests/unit/backend/pending-import/xlsx-size-preflight.test.js tests/unit/main-process/biz-op-v327-export-sst.test.js` 36/36 PASS，见 [x0-baseline.log](evidence/x0-baseline.log)。另对固定 `git archive 11086a3c` 源码运行同一 reader fixture 20/20 PASS、同一 consumer options fixture 8/8 PASS，见 [reader-contracts.log](evidence/reader-contracts.log)、[consumer-options-baseline.tap](evidence/consumer-options-baseline.tap)。
- 当前规则入口：本切片不变更生产职责，暂无新模块规则；后续 X1–X4 统一由根 AGENTS 导读到 xlsx/README。
- 剩余与回退：无未完成的基线冻结项；仅回退本切片测试文件，无持久化变更。

### X1：公共叶子与 Workbook parts

- 职责与边界：`toolbox-format/{excel-text,ooxml-namespaces,number-date,model,style-registry,xlsx-sheet-scanner}`、`big-table-import/zip-reader` 的正文移至 `src/backend/xlsx/`。`workbook-parts` 持有原 xlsx-pass class 前 helper；`ToolboxXlsxPass/openToolboxXlsxPass` 留在原域装配。
- 调用方与兼容：旧叶子/ZIP 整体 re-export；xlsx-pass 保留原 helper 导出，生产 helper 消费者由 X4 迁移。shim 删除须全仓 tests/scripts 引用归零及兼容证据。
- 业务行为：G4-AC-01/03/07；XML、样式、限额、数字、错误类与所有原导出保持。
- 验证：提取前后专项均 125/125 PASS，见 [基线](evidence/x1-baseline.log)、[提取后](evidence/x1-after-extraction.log)；identity/闭包 10/10 PASS，见 [x1-compatibility.log](evidence/x1-compatibility.log)；归一化依赖路径后正文逐字相同，见 [x1-extraction-integrity.log](evidence/x1-extraction-integrity.log)。
- 当前规则入口：建立 `src/backend/xlsx/README.md` 并在根 AGENTS 增加导读；G8 尚未接入。
- 剩余与回退：X4 迁移生产消费者；回退同步恢复正文、shim 和已迁调用方。

### X2：SST provider

- 职责与边界：`xlsx/shared-strings-provider.js` 唯一持有 Memory/Adaptive provider、spill 句柄和路径 identity；公共层不读取 Position constants。业务 adapter 负责 tempRoot/预算选择。
- 调用方与兼容：原 Position 路径转发整个导出对象，错误 constructor identity 保持；S1/R1–R4 迁移见后续切片。
- 业务行为：G4-AC-04/05/06/07；独占创建、strict/preserve、重复 close、Number 转换、缺 entry、取消、错误优先级保持 Spec §5。
- 验证：`node --test tests/unit/backend/xlsx/shared-strings-contract.test.js tests/unit/backend/shared-strings-ownership.test.js` 21/21 PASS，见 [x2-sst.log](evidence/x2-sst.log)；覆盖替换目录/文件、无关文件、构建/取消、部分创建、fd 关闭失败及重复 close。
- 当前规则入口：xlsx/README 的资源所有权、错误与关闭章节；run-scoped-data-policy 无需更新，没有新的业务存储生命周期；G8 未接入。
- 剩余与回退：Windows 真实占用另行验收；强制 worker terminate 仍由原任务所有者回收，公共 provider 不负责跨任务清扫。回退须同时恢复消费者及旧路径。

### X3：legacy/rich/preflight 与 L1/L2/S1

- 职责与边界：公共入口分别为 `xlsx/legacy/streaming-xlsx-reader.js`、`xlsx/legacy/entry-size-preflight.js`、`xlsx/rich-workbook.js`；公共层没有业务预算来源，S1 的 Position/VCC adapter 负责显式预算与临时路径。两类 reader 独立保留，Acquiring/BizOP/VCC OP 手写 projection 留本域。
- 调用方与兼容：L1 三处、L2 三处、S1 两处及搜索补充的 Pending worker 均切到公共路径。旧路径保留同一对象转发，无第二实现；全仓引用、历史 scripts、测试迁移见 [consumer-inventory.json](evidence/consumer-inventory.json)。
- 业务行为：G4-AC-02/04/06/08；legacy 同步 callback 不等待 Promise、数字 parseFloat→String、无效 maxRows 不截断；rich 同步 callback 拒绝 thenable、close 缓存 Promise、single-sheet 提前拒绝。S1 原 `undefined` 默认与 `null` 校验、preserve 与取消保持。
- 验证：新增 reader 合同 26/26 PASS，S1 与业务 options 在基线及当前各 8/8 PASS；迁移专项 78/78 PASS；完整门禁已在后续复验通过，平台验收仍待完成；见末尾复验章节。
- 当前规则入口：根 AGENTS → `src/backend/xlsx/README.md` 的入口/能力、预算/资源与兼容章节。run-scoped-data-policy 无需更新，未改变业务存储生命周期；正式 G8 未接入。
- 剩余与回退：Windows 关闭/文件占用未执行；回退同时恢复本切片正文、旧 shim、L1/L2/S1 imports 与 options，不单独复制旧 reader 正文。

### X4：rich/Toolbox 消费者、全量入边与跨业务验证

- 职责与边界：R1 import、R2 RAW/validator、R3 review plan、R4 四处均直接使用 `xlsx/rich-workbook.js`；Toolbox assembly 保持本域，格式 writer 与其他业务消费者通过中性 leaves 获取机制。`toolbox-format/index.js` 保留历史聚合导出但生产代码不再从它获取公共机制。
- 调用方与兼容：迁移设计规定全部组并扩展 BigTable、Pending、Toolbox大文件worker/router、新账户、重复入账与报告writer等现有使用点。详见消费者清单；旧生产 API 入边归零，旧 xlsx-pass 的 Toolbox装配及本域聚合兼容转发是明确合法用法。
- 业务行为：G4-AC-01/03/04/06/08；R2 RAW 单页与输出 validator 多页、R3 显式 cache 64MiB 与 R4 cache 未提供、signal/cancelToken 桥接、业务关闭后取消重检均保持；无 IPC/schema/金额或输出列变化。
- 验证：`node scripts/integration/shared-xlsx-boundary.js` 51/51 PASS，见 [shared-xlsx-boundary.log](evidence/shared-xlsx-boundary.log)，覆盖5条真实业务链、低预算spill、取消、await close、真实子进程自然退出、全部12个公共模块闭包与禁止旧生产 API 入边正反例。普通取消/自然退出不等同强制 worker terminate；完整门禁的前轮失败/中止与后续通过分别保留，当前剩余项见末尾复验章节。
- 当前规则入口：xlsx/README同步全部生产迁移、shim退休条件和代表测试；根AGENTS仅新增导航。G8尚未集成，本分支集成测试使用AST检查literal require/require.resolve与运行时模块闭包；不等同G8完整静态规则和历史防倒退。正式ARCH-XLSX-INFRA/deprecatedEntrypoints由G8集成时登记。
- 剩余与回退：release/G6/G8组合与Windows/Excel/WPS仍待后续验收；没有执行合并。回退按已迁组连同公共实现与兼容转发整体回退，先等原任务退出屏障，禁止扩大目录清理。

## 验证期间的发现

- 只读独立实现审查发现 legacy 入口剩余“maxRows 内存/耗时只取决于前 N 行”的旧注释。已同步更正为仅限制sheet行扫描；ZIP/SST仍完整加载，算法不变。审查报告见 [implementation-review.md](evidence/implementation-review.md)。
- 首轮全unit结果为8134通过、5失败、4跳过。五处实际失败均为worktree缺少本地node_modules路径，影响历史snapshot的依赖链接和NSIS模板读取；Node向上解析不能覆盖这些直接路径访问。已补本地依赖symlink并定向复验，保留初次失败日志 [unit-initial.log](evidence/unit-initial.log)，不修改测试来规避。
- 调查期间额外直接执行当前 `scripts/check-background-execution-manifest.js` 发现 E13-G Action Manifest drift；在纯 `git archive 11086a3c` 源码复现相同漂移，见 [baseline-manifest.log](evidence/baseline-manifest.log)。进一步核对 `manifest-coverage-e13-g.test.js:263` 后确认，该脚本针对已发布E13-G冻结快照，正式测试会checkout历史ref复验；直接拿当前main执行会与历史产物不匹配。这是诊断时执行上下文不适用，不是当前生产缺陷，也不是首轮全unit实际失败原因。补依赖路径后的正式历史gate已通过；未改历史authority/快照。完整release-check结论仍以实际退出码为准。

## 首次完整验证与当时剩余事项（历史记录）

**首次运行时：实现 X0–X4 已落地，专项通过，但完整门禁未完成。以下保留当时失败与中止，不代表最新结果。** 原机器可读记录见 [verification-summary-before-retry.json](evidence/verification-summary-before-retry.json)，最新结果见 [verification-summary.json](evidence/verification-summary.json)。代码差异包含 Git 尚未跟踪的新文件，共92个代码/测试/模块说明/根导读文件；差异 SHA-256 为 `c65b1e27b184876413878b0b299676bfdafb47076576a6b370028060bf78f86a`。后续只更新实施与证据文档，源码哈希未变。

| 检查 | 实际结果 | 证据与边界 |
| --- | --- | --- |
| lint / smoke | PASS | 最终 `release-check.log` 的 lint、smoke 已完成，随后进入 unit；不单独代称整门禁通过。 |
| X0–X4 专项 | PASS | reader基线20项、消费者基线8项；X1原专项125项、兼容10项；reader26项；SST/ownership21项；消费者8项、迁移专项78项；跨业务集成51项。各组存在覆盖重叠，不把数字相加当总数。 |
| 首轮全量unit（诊断轮） | 8134通过、5失败、4跳过 | 5处为本地node_modules路径缺失；见 [unit-initial.log](evidence/unit-initial.log)。该轮不是最终全部测试集合。 |
| 依赖路径修复后的定向复验 | 16通过、0失败、2跳过，exit 0 | [dependency-layout-recheck.log](evidence/dependency-layout-recheck.log)；2项为条件性Windows检查。 |
| `UNIT_TEST_CONCURRENCY=4 npm run release-check` | **未通过 / 中止，exit 130** | [release-check.log](evidence/release-check.log)。unit已观察到2项失败，尚未产生完整unit摘要；工作盘仅剩392MiB时对准确识别的G4进程组发送SIGINT停止，不能将部分通过写为完整PASS。 |
| `npm run test:integration` | **59/61脚本通过，2失败，exit 1** | [integration.log](evidence/integration.log)，全部61脚本已执行；runner因失败未更新集成清单。 |
| `git diff --check` / 最终源码哈希 | PASS / 无漂移 | 源码、测试与AGENTS未在冻结后改变。 |

完整unit已观察到的两个失败为 Position“真实过滤行报告业务删除后永久删除”及 BankBU“cleanup外部lock连续shutdown”。相同用例在当前G4与精确11086a3c基线分别定向运行，四次均1/1 PASS，见 [gate-failure-probes.log](evidence/gate-failure-probes.log)。BankBU路径不使用G4 reader，存在1000ms固定关闭deadline；原完整运行在中止前未输出末尾错误栈，因此仅登记“定向未复现/尚无G4行为回归证据”，不确定归因为负载，也不覆盖原失败。

两个失败集成脚本：

1. `archive-center-permanent-delete`：运行至15/52断言后，Position实际磁盘准入报“平盘导入可用磁盘空间不足，未修改现有数据”。
2. `toolbox-large-split-multi-sheet`：30/31断言通过；50万→150万行的RSS增量为76→143MiB，tier2超过effective预算133MiB约10MiB。输出sheet/命中计数和真实worker段通过，但内存门禁仍失败；未放宽预算，未将其解释为已证明的环境噪声，也未做性能升级声明。

停止时工作盘总460GiB、可用392MiB（100%）；停止G4验证后一次观测803MiB。见 [environment-stop.txt](evidence/environment-stop.txt)。没有删除其他任务或用户数据来换取空间。已结束的基线探针私有树由各自finally清理；后续资源清理继续只针对可证明为本次所有的目录。

### 首次运行待办及本轮处置

- **原BLOCK｜本机验证环境，已复验关闭**：前轮磁盘不足实际触发准入。本轮起始可用约1.9GiB，归档和两项unit定向通过，随后完整 `release-check` exit 0；结束可用约11.2GiB。未清理其他任务或用户数据。
- **原PROBE｜Toolbox内存门禁，本轮未复现**：同Node/依赖/脚本/默认规模串行对照中，G4与11086a3c均31/31通过；G4在完整门禁内再次31/31通过。未改代码或预算。原143>133MiB失败保留；这些证据支持本轮通过，不证明前轮失败的具体成因。
- **未执行平台验收**：Windows文件占用/关闭/spill、Excel/WPS代表性导出、专门的强制worker terminate平台回收验收；当前为macOS，普通取消/子进程自然退出不能替代。
- **未集成**：G6 VCC重叠文件按函数职责合并，G8登记并激活正式边界，release组合验证。尚未提交/推送/合并/开PR/升版/发布，均等待后续明确指令。



## 2026-09-20 定向复验与完整门禁重跑（已完成）

用户明确要求重试前轮剩余的磁盘准入、Toolbox 内存与完整门禁三项。本轮未改生产代码、测试、参数或门禁阈值；启动前复核92个源码快照文件无漂移，可用磁盘约1.9GiB。本任务内大型验证串行执行，完整unit使用已有 `UNIT_TEST_CONCURRENCY=2` 配置。原失败/中止日志保留，不由后续PASS覆盖。

- 前轮失败的Position/BankBU用例及相关Position场景：3/3 PASS，exit 0；[定向unit](evidence/retry-unit-cases.log)。
- 归档永久删除：52/52 PASS，exit 0；[归档复验](evidence/retry-archive-center-permanent-delete.log)。
- Toolbox默认50万/150万行：G4 31/31 PASS，RSS增量95/134MiB、effective预算152MiB；精确11086a3c基线31/31 PASS，RSS增量91/136MiB、effective预算148MiB。两边测试脚本逐字一致，Node v25.8.0、同一依赖、NODE_OPTIONS与规模覆盖变量均未设置，均串行运行。见[G4](evidence/retry-toolbox-large-split-multi-sheet.log)、[基线](evidence/retry-toolbox-baseline.log)、[基线环境与退出码](evidence/retry-toolbox-baseline.json)。本轮未复现原143>133MiB失败，不能据单次成对通过断言原失败必然由环境引起。
- `UNIT_TEST_CONCURRENCY=2 npm run release-check`：**PASS，exit 0**。本地时间20:34:46至20:55:51，约21分06秒；lint/smoke通过，完整unit为8155项、8151通过、0失败、4项Windows条件性跳过（512文件，702175.664167ms）；61/61集成脚本通过，已报告断言汇总2630/2630（541693ms）。其中归档52/52、Toolbox大文件50/50、多Sheet拆分31/31、公共XLSX边界51/51均在此完整命令内通过。[门禁日志](evidence/retry-release-check.log)、[运行环境与实际退出码](evidence/retry-release-check.json)。

- 最终复核92个源码/测试/模块说明/AGENTS文件与前轮快照完全一致，[code.diff](evidence/code.diff)的SHA-256保持不变；[复验哈希记录](evidence/retry-final-snapshot.json)绑定新日志。`git diff --check`通过，暂存区为空。
- runner全PASS后按既有规则自动刷新 `rules/integration-test-policy.md` §七，登记本轮61个脚本与2630项已报告断言；相较前轮，这是唯一新增的受Git跟踪文件改动，见[清单差异](evidence/retry-policy.diff)。生产代码和测试没有因重试而修改。

独立证据一致性核查通过：92个源码文件、5份复验日志、code.diff及自动清单哈希匹配，数字与退出码一致。61个脚本中 `v2.1.12-beta-multiworker-nested` 为 exit 0但不报告断言计数；2630来自其余60个脚本的可解析计数，不能推断为全部内部断言数量。

### 当前剩余事项

本地自动门禁已完成；实现状态仍为已实现、集成状态仍为未集成。Windows文件占用/关闭/spill、Excel/WPS代表性导出、专门的强制worker terminate平台回收验收未执行；4项跳过分别涉及PowerShell snapshot/cleanup、真实CIM文件祖先枚举及2项packaged canary。G6 VCC函数职责合并、G8正式边界激活及release组合验证仍待后续明确指令。未提交、推送、合并、开PR、升版或发布。
