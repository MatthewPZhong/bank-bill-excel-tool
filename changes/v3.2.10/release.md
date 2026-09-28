# v3.2.10 发布与集成记录

G1–G8 已合入，本轮从 `9a38b96b1b8006c5851535d0c1e586bbaeb63f10` 加已有审查修复接手正式发布。第 15 轮复审未发现新增可确认必改项，RR14-01 在列明范围内关闭；R15-O1 保留为精度观察。下方历史记录保留各自时点的提交、验证和未完成状态，不用后来结果改写历史审查。

## 2026-09-28 正式发布执行

用户在核实 v3.2.9 的 PR、main 检查、附注标签和发布审批流程后要求“执行”，授权本轮升版、提交、推送 release、创建并合并 PR、正式标签及对外发布。针对本轮真实账单/资金结果、Windows 安装包及 Excel/WPS 人工验收，用户明确回复“已人工验收”；记录为用户确认，不冒充本 Agent 独立执行。

| 项目 | 当前证据 / 状态 |
| --- | --- |
| 正式基线 | `v3.2.9` → `11086a3cbf632a30adbcfa796e4cd81810c5aef9`；接手时远端 main 仍为该提交，已包含于 release 历史 |
| 发布范围 | G1–G8 原选定源提交及 R1–R14 审查修复；R15 无新增必改项，不扩修 R15-O1 |
| 版本文档 | `package.json` / `package-lock.json` 升为 `3.2.10`，同步 CHANGELOG、版本功能历史和使用手册 |
| 人工验收 | USER_CONFIRMED：用户确认本轮真实账单/资金结果、Windows 安装包及 Excel/WPS 已人工验收 |
| 自动验证 | 升版前已有 9429 单测 PASS、4 项 Windows 条件跳过、68/68 集成；正式候选将重新运行完整门禁，旧结果不代替最终提交检查 |
| 远端流程 | 推送同名 release 并创建 PR 到 main；要求 smoke-test/build 通过，合并后复核最终 main，再创建附注标签并审批 production-release |
| 最终发布证据 | 候选提交、PR、main 合并提交、标签、工作流及资产的结果随执行另行归档于 [本轮发布目录](publication/2026-09-28/)，未执行阶段不预填通过 |

原工作区 5,331 个既有文件及主工作区 865 个 dirty 文件已记录内容指纹，见 [接手快照](publication/2026-09-28/start-manifest.json)。已集成源分支、依赖和合并提交见下方集成记录；正式发布前逐项验证祖先及当前内容。发版后结果保存在本轮独立记录和 PR/Release，不为补勾选改写已发布提交或移动标签。

### PR 候选的 CI 环境隔离修复

首个已提交候选为 `4e91073756ea73b19093c60a930ecb32215b94f5`，已推送并建立 [PR #240](https://github.com/MatthewPZhong/bank-bill-excel-tool/pull/240)。按真实 PR 环境设置 `ARCHITECTURE_BASE_REF=11086a3c…` 后，架构检查和 smoke 通过，但三项 CLI fixture 测试失败：两个回归文件的临时 Git 仓库继承了真实仓库的比较提交，因该提交不存在而以输入错误退出。原 R14/R15 本地门禁未设置此外部比较变量，因此旧 PASS 不能覆盖此组合。

已独立复现三项失败，只补齐三个测试文件的子进程环境隔离：临时仓库默认使用自身 HEAD，显式测试传入的比较/checkout 身份继续生效。生产检查器、CI 对真实提交的校验、全部正反例断言和业务源码保持。旧完整门禁在确认失败后中止，旧远端 run `36437354076` 取消，均不计为 PASS；修复后的新提交重新执行完整门禁及远端检查。[失败记录](publication/2026-09-28/preliminary-4e910737/reason.json)。

### Windows 全量单测启动器修复

`bfd396d7` 本地单测为 9429 PASS、0 FAIL、4 项 Windows 条件跳过；Windows run `36438526098` 的 lint、架构检查和 smoke 通过，随后启动单测时抛出 `spawn ENAMETOOLONG`。577 个测试路径形成 34,656 字符参数，超过 Windows 进程启动上限。远端单测尚未运行、build 未执行，不能把此 run 计为业务测试通过。

启动器改为把 `tests/unit/**/*.test.js` 原样传给 Node 原生匹配，继续使用原并发/覆盖率参数、子进程隔离、日志汇总和退出码。新旧发现方式在修复点均匹配同一组 577 文件，新增回归后均为 578 文件；真实子进程验证包含嵌套及中文路径、排除辅助文件、失败退出码和覆盖率。新增 3 项加原 11 项全部通过，lint 通过；生产业务源码未改。[验证](publication/2026-09-28/unit-discovery-verification.json)、[集合对照](publication/2026-09-28/unit-discovery-comparison.json)、[Node 22 原生匹配文档](https://github.com/nodejs/node/blob/v22.23.2/doc/api/test.md#running-tests-from-the-command-line)。

旧候选本地集成在 Windows 失败明确后中止，完整门禁未计为通过；新候选重新运行本地及 Windows 全量门禁。[旧候选记录](publication/2026-09-28/preliminary-bfd396d7/reason.json)。

### Windows 路径身份与测试平台假设修复

`7a7368f1` 的完整本地门禁为 9432 PASS、4 项 Windows 条件跳过、68/68 集成 PASS，1712 个输入未漂移；[该候选结果](publication/2026-09-28/candidate-7a7368f1/local-final-verification.json)独立保留。Windows run `36440891592` 已真正启动单测，实时日志确认了临时目录身份、路径分隔符和文件删除共享模式相关失败，尚未结束的运行不计为 PASS。

- 架构历史守卫原先按 `realpathSync` 返回字符串比较仓库根；同一目录的大小写/短路径拼写可能不同。改用文件系统返回的 `bigint dev/ino` 判断目录身份，继续拒绝借用父仓库的子目录。真实大小写别名探针对照：修复前输入错误，修复后通过；子目录对照前后均拒绝。目录别名、active 防降级及真实临时 Git 历史回归保留。
- 纯合同冷加载允许集改用 `path.join`；XLSX 消费方观测按 `path.basename`/本机分隔符核对来源，不放宽允许依赖、SST 预算或私有目录约束。
- 非 strict SST 测试不再假定 Windows 一定拒绝删除打开文件。通过确定性注入分别验证清理成功和清理拒绝，strict 分支继续要求关闭未确认时报错并保留文件；生产 provider 未改。

受影响的 8 个测试文件集合共 112 项全部通过、0 跳过。旧运行的完整 Windows 日志最终为 9388 PASS、44 FAIL、4 SKIP；最后两项失败属于场景边界测试的相对路径分隔符断言，现统一为仓库 `/` 格式，原有 3 项回归全部通过。中间候选 `b1f3dbe4` 本地单测 9435 PASS、0 FAIL、4 SKIP；为补齐最后一处断言而中止集成和对应 Windows CI，未记为完整通过。新候选仍须通过完整本地及 Windows 门禁，业务源码和架构边界配置不变。[专项证据](publication/2026-09-28/windows-compatibility-verification.json)。

## 2026-09-28 第 15 轮复审结论同步（文档变更）

依据[第 15 轮审查](reviews/2026-09-28-release-rereview-r15/review.md)：本轮未发现新增可确认的必改问题。RR14-01 在原始 6 个案例、真实 20 个 Renderer 边界代表及新增 8 个 finally/helper 路径的范围内关闭；不将该结论扩展为所有 JavaScript 语义或 G8 合同的完备证明。

R15-O1 按已知保守精度观察保留：字面量空数组 `for…of []` 内的外层标签跳转不会执行，但当前分析仍保留该路径，导致两个合法 scoped API 样例被拒绝。此行为已经确认；现有契约未明确承诺空迭代次数精度，当前生产 Renderer 未发现对应结构，因此本轮不列为必改项，也不计作安全样例正确通过。本次不扩修或变更分析精度契约。

审查方本轮新执行架构单测 655/655 PASS、正式 CLI 31 active、0 pending/partial、0 违规、0 stale；旧数组 14 例、覆盖顺序 8 例及共享/绑定 62 例保持预期，已有保守拒绝单列。完整 `release-check` 在第 15 轮未重跑：核对 1,711 个输入集合、SHA-256 及 HEAD 完全匹配后，复用 R14 修复于 2026-09-28 17:19:43–17:39:54 +08:00 的结果（9429 单测 PASS、0 FAIL、4 项 Windows 条件跳过，68/68 集成脚本 PASS）。

本次接收结论时再次核对当前候选与上述门禁输入完全一致，仅更新版本索引、本记录及 G8 实施记录；源码、测试、机器配置和历史审查材料保持。未重新执行测试，未提交、推送或发布。Electron GUI、真实 Main 全流程、Windows/安装包、Excel/WPS 和资金人工验收仍待实际验证。[本次核对](reviews/2026-09-28-release-r15-closeout/verification.json)。

## 2026-09-28 第十四轮独立审查修复（未提交）

RR14-01：区分进入 do 首轮与到达具体写入。按 break/continue 的目标和执行顺序保留可能跳过写入时的旧来源，沿 helper 调用点传播；写入前后、body/test、内层跳转、label、finally 和共同读取路径都有安全对照。

新增 34 项 VM/静态回归，准确修复起点 15 FAIL / 19 PASS，最终全部通过；架构 655/655 PASS，正式 CLI 31 active、0 pending/partial、0 诊断、0 stale。实际 20 个 Renderer 边界原反例产生 scope 诊断，安全对照零诊断。原始 6 例/12 次 VM、覆盖顺序 8 例、RR12 数组 14 例和共享/绑定 62 例保持预期，已有保守拒绝单列。

`UNIT_TEST_CONCURRENCY=2 npm run release-check` 重跑 PASS：9429 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过。1711 个输入及 HEAD 未漂移；开始 2026-09-28T17:19:43.887250+08:00，结束 2026-09-28T17:39:54.344494+08:00。

[修复报告](reviews/2026-09-28-release-r14-repair/repair.md)、[验证汇总](reviews/2026-09-28-release-r14-repair/verification.json)、[增量补丁](reviews/2026-09-28-release-r14-repair/incremental.patch)。生产业务源码保持，未提交、推送或发布；没有进行平台及真实业务人工验收。

## 2026-09-28 第十三轮独立审查修复（未提交）

RR13-01：唯一 helper 调用时点不证明必执行。成员快照沿调用链保留分支未进入时的旧来源；可证明晚于先前写入的后续确定覆盖才能清除旧候选。控制语句的必执行位置、共同分支、捕获旧别名及无条件替换均有安全对照。

新增 32 项回归，准确修复起点 16 FAIL / 16 PASS，最终 32 PASS；架构 621/621 PASS，正式 CLI 31 active、0 诊断、0 stale。实际 20 个 Renderer 边界配置下，原条件反例 1 条 scope 诊断，安全对照零诊断。RR12 的 14 个数组样例与 62 个共享/绑定用例保持原结果。

`UNIT_TEST_CONCURRENCY=2 npm run release-check` 重跑 PASS：9395 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过。1710 个输入及 HEAD 未漂移。开始 2026-09-28T16:33:19.646795+08:00，结束 2026-09-28T16:50:50.044266+08:00。

[修复报告](reviews/2026-09-28-release-r13-repair/repair.md)、[验证汇总](reviews/2026-09-28-release-r13-repair/verification.json)、[增量补丁](reviews/2026-09-28-release-r13-repair/incremental.patch)。本轮未修改生产业务源码，未提交、推送或发布；平台及人工验收不在此结论内。

## 2026-09-23 第十二轮独立审查修复（未提交）

RR12-01：数组身份比较不再提前展开内容；元素读取保留原求值链。普通 helper 使用唯一调用位置核对写入与重排顺序。原违规和安全样例均可正常分析。

新增 12 项回归，准确修复起点 10 FAIL（RangeError）/ 2 PASS，最终 12 PASS；架构 589/589 PASS，正式 CLI 31 active、0 诊断、0 stale。保留实际 20 个 Renderer 边界的 8 个数组样例全部无异常：7 项符合正反预期、1 项既有保守拒绝继续单列。62 个共享解析和绑定用例保持原结果。

`UNIT_TEST_CONCURRENCY=2 npm run release-check` 重跑 PASS：9363 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过。1709 个输入及 HEAD 未漂移。开始 2026-09-23T14:44:29.241195+08:00，结束 2026-09-23T15:05:10.069504+08:00。

[修复报告](reviews/2026-09-23-release-r12-repair/repair.md)、[验证汇总](reviews/2026-09-23-release-r12-repair/verification.json)、[增量补丁](reviews/2026-09-23-release-r12-repair/incremental.patch)。本轮未修改生产业务源码，未提交、推送或发布；平台及人工验收不在此结论内。

## 2026-09-23 第十一轮独立审查修复（未提交）

RR11-01/02 已修复父对象的非空证明误传给 IPC 子成员，以及数组重排遗漏其他固定槽位已知写入来源。新增 11 项回归，修复起点 5 FAIL / 6 PASS，最终全部通过。

| 验证 | 当前候选结果 |
| --- | --- |
| 完整门禁 | `UNIT_TEST_CONCURRENCY=2 npm run release-check`：PASS，2026-09-23 10:32:54–10:50:35（Asia/Shanghai） |
| 架构专项 / CLI | 577/577 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 / 集成 | 9351 项单测通过、0 失败、4 项 Windows 条件跳过，68/68 集成脚本通过 |
| 实际配置 | 20 个 Renderer 边界配置下的父成员及数组重排正反例符合预期 |
| 输入 | 1708 个门禁输入及 HEAD 未漂移 |

[修复报告](reviews/2026-09-23-release-r11-repair/repair.md)、[验证汇总](reviews/2026-09-23-release-r11-repair/verification.json)、[增量补丁](reviews/2026-09-23-release-r11-repair/incremental.patch)。本轮修复仅涉及 G8 Renderer 检查器、测试与说明；生产源码、机器配置、历史材料保持。没有提交、推送或发布。

## 2026-09-23 第十轮独立审查修复（未提交）

RR10-01/02 已修复嵌套 AND/OR/nullish 的合法注入误报，以及工厂内部扩容数组经 spread 后的对象来源漏报。未知分支保留来源，参数按声明函数与参数名绑定；合并候选时来源取并集、真值/非空证明取交集。新增 84 项回归，准确起点 38 FAIL / 46 PASS，最终全部通过。

| 验证 | 本轮候选结果 |
| --- | --- |
| 完整门禁 | `UNIT_TEST_CONCURRENCY=2 npm run release-check`：PASS，2026-09-23 02:53:40–03:14:31（Asia/Shanghai）；沙箱外隔离测试环境 |
| 架构专项 / CLI | 566/566 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 | 9340 PASS、0 FAIL、4 项 Windows 条件跳过 |
| 全量集成 | 68/68 脚本 PASS；Renderer lifecycle 233/233 |
| 实际配置 / 共享探针 | 保留 20 个 Renderer boundary 的 6 个真实 AST 场景符合预期；56 项共享正反例保持 |
| 相邻独立复核 | 同一组 6 例在最终源码上符合预期，已纳入新增 84 项回归 |
| 输入 | 1707 个门禁输入及 HEAD 未漂移 |

[修复报告](reviews/2026-09-23-release-r10-repair/repair.md)、[验证汇总](reviews/2026-09-23-release-r10-repair/verification.json)、[相邻复核](reviews/2026-09-23-release-r10-repair/r10-adjacent-review/review.md)、[增量补丁](reviews/2026-09-23-release-r10-repair/incremental.patch)。初版门禁为继续修复已确认问题而主动停止，不作为 PASS；上表来自最终冻结候选的完整重跑。生产源码、共享 checker、机器配置和历史材料保持。本轮仅关闭列明反例，不代表全部 G8 合同、产品或平台验收完成；所有修复未提交。

## 2026-09-22 第九轮独立审查修复（未提交）

RR9-01/02 已修复 AND 短路产生 undefined 的默认来源，以及数组 mutator 静态 spread 的插入来源。保留确定真值、旧别名和独立实例安全对照；Preload 对象的真值证明不扩大完整 API 的注入权限。新增 50 项回归，起点 27 FAIL / 23 PASS，修复后全部通过。

| 验证 | 本轮候选结果 |
| --- | --- |
| 完整门禁 | `UNIT_TEST_CONCURRENCY=2 npm run release-check`：PASS，2026-09-22 19:41:10–20:00:20（Asia/Shanghai）；沙箱外隔离测试环境 |
| 架构专项 / CLI | 482/482 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 | 9256 PASS、0 FAIL、4 项 Windows 条件跳过 |
| 全量集成 | 68/68 脚本 PASS；Renderer lifecycle 233/233 |
| 实际配置 / 共享探针 | 20 个 Renderer 边界下 6 个原始及对照场景符合预期；50 项共享正反例保持 |
| 输入 | 1706 个门禁输入及 HEAD 未漂移 |

[修复报告](reviews/2026-09-22-release-r9-repair/repair.md)、[验证汇总](reviews/2026-09-22-release-r9-repair/verification.json)、[增量补丁](reviews/2026-09-22-release-r9-repair/incremental.patch)。只修正 Renderer 检查器，生产业务、共享 scanner、机器配置和历史材料保持。本轮为修复自检，不扩展为任意动态语义或全部 G8 合同已闭环；未执行修复后独立复审、产品/平台人工验收或发布。

## 2026-09-22 第八轮独立审查修复（未提交）

RR8-01/02 已修复 IPC 默认来源和固定数组槽位身份漏报。IPC 字段不能仅凭来源标签排除 undefined；数组以分配位置及调用帧区分实例，按读取时点选择槽位，旧别名和浅复制保持分离。新增 46 项回归，起点 34 FAIL / 12 PASS，修复后全部通过。前轮固定槽位观察已纳入本轮关闭范围。

| 验证 | 本轮候选结果 |
| --- | --- |
| 完整门禁 | `UNIT_TEST_CONCURRENCY=2 npm run release-check`：PASS，2026-09-22 18:06:12–18:27:32（Asia/Shanghai）；沙箱外隔离测试环境 |
| 架构专项 / CLI | 432/432 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 | 9206 PASS、0 FAIL、4 项 Windows 条件跳过 |
| 全量集成 | 68/68 脚本 PASS，Renderer lifecycle 233/233 |
| 输入与保护 | 1705 个门禁输入及 HEAD 未漂移；792 个生产源码、542 个历史证据和主工作区 865 个 dirty 文件保持 |

IPC 形状未声明时，即使 VM stub 恰好提供某字段，默认候选仍保守保留。共享 44 例中一个旧合法预期的同步 invoke stub 与 Electron Promise 合同不符，异步对照确认会触发其他频道默认值，当前拒绝有证据；详见[修复报告](reviews/2026-09-22-release-r8-repair/repair.md)。[验证汇总](reviews/2026-09-22-release-r8-repair/verification.json)、[增量补丁](reviews/2026-09-22-release-r8-repair/incremental.patch)。本轮为修复自检，未执行修复后独立复审或产品/平台人工验收，未提交或发布。

## 2026-09-22 第七轮独立审查修复（未提交）

RR7-01 已修复触发默认参数时丢失默认对象来源的问题。省略、缺失成员或 undefined 正确启用默认表达式，显式提供的其他对象保持独立；默认表达式在被调用函数环境及本次调用身份下求值。新增 30 项回归，在起点检查器上 18 FAIL / 12 PASS，修复后全部通过。R7 留存的数组元素替换观察仍未关闭，不纳入默认参数问题的关闭结论。

| 验证 | 本轮候选结果 |
| --- | --- |
| 完整门禁 | `UNIT_TEST_CONCURRENCY=2 npm run release-check`：PASS，2026-09-22 16:37:31–16:56:01（Asia/Shanghai）；在沙箱外使用隔离测试环境 |
| 架构专项 / CLI | 386/386 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 | 9160 PASS、0 FAIL、4 项 Windows 条件跳过 |
| 全量集成 | 68/68 脚本 PASS，Renderer lifecycle 233/233 |
| 输入与保护 | 1704 个门禁输入及 HEAD 未漂移；792 个生产源码、462 个历史证据和主工作区 865 个 dirty 文件保持 |

[修复报告](reviews/2026-09-22-release-r7-repair/repair.md)、[验证汇总](reviews/2026-09-22-release-r7-repair/verification.json)、[增量补丁](reviews/2026-09-22-release-r7-repair/incremental.patch)。本轮为修复自检；修复后独立复审、真实产品 Main、Windows/安装包、Excel/WPS 和资金人工验收未执行。未提交或发布。

## 2026-09-22 第六轮独立审查修复（未提交）

RR6-01/02 已修复参数解构不按调用时点读取替换成员，以及数组/原型经 helper 参数改写后仍被视为原生比较的两项漏报。参数身份与能力检查分阶段求值，原生比较证明保留成员 selector 及有限返回来源；旧别名、不同实例和合法函数值比较保持。新增 40 项回归，在起点检查器上 23 FAIL / 17 PASS，修复后全部通过。

| 验证 | 本轮候选结果 |
| --- | --- |
| 完整门禁 | UNIT_TEST_CONCURRENCY=2 npm run release-check：PASS，2026-09-22 15:19:39–15:38:20（Asia/Shanghai） |
| 架构专项 / CLI | 356/356 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 | 9130 PASS、0 FAIL、4 项 Windows 条件跳过 |
| 全量集成 | 68/68 脚本 PASS，Renderer lifecycle 233/233 |
| 输入与保护 | 1703 个门禁输入及 HEAD 未漂移；792 个生产源码、374 个历史证据和主工作区 865 个 dirty 文件保持 |

[修复报告](reviews/2026-09-22-release-r6-repair/repair.md)、[验证汇总](reviews/2026-09-22-release-r6-repair/verification.json)、[增量补丁](reviews/2026-09-22-release-r6-repair/incremental.patch)。本轮为修复自检；修复后独立复审、真实产品 Main、Windows/安装包、Excel/WPS 和资金人工验收未执行。未提交或发布。

## 2026-09-22 第五轮独立审查修复（未提交）

RR5-01/02 已修复静态成员替换后的别名身份漏报，以及原生 includes/indexOf 的函数值比较误报。对象身份按读取和已知调用时序解析；旧别名、不同实例与原生比较保持合法，自定义同名方法、改写数组和真实恢复回调仍检查。新增 46 项回归，在起点检查器上 23 FAIL / 23 PASS，修复后全部通过。

| 验证 | 本轮候选结果 |
| --- | --- |
| 完整门禁 | UNIT_TEST_CONCURRENCY=2 npm run release-check：PASS，2026-09-22 14:01:31–14:19:51（Asia/Shanghai） |
| 架构专项 / CLI | 316/316 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 | 9090 PASS、0 FAIL、4 项 Windows 条件跳过 |
| 全量集成 | 68/68 脚本 PASS，Renderer lifecycle 233/233 |
| 输入与保护 | 1702 个门禁输入及 HEAD 未漂移；792 个生产源码、295 个历史证据和主工作区 865 个 dirty 文件保持 |

[修复报告](reviews/2026-09-22-release-r5-repair/repair.md)、[验证汇总](reviews/2026-09-22-release-r5-repair/verification.json)、[增量补丁](reviews/2026-09-22-release-r5-repair/incremental.patch)。本轮为修复自检，独立复审、真实产品 Main、Windows/安装包、Excel/WPS 及资金人工验收未执行。未提交或发布。

## 2026-09-22 第四轮独立审查修复（未提交）

RR4-01～03 已补齐工厂组合身份、不同静态调用实例区分和 G1 已解释回调入口授权检查；真实共享对象继续追踪，未放宽机器授权配置。新增 33 项回归在起点工具上 21 FAIL / 12 PASS，修复后全部通过。原三个 Renderer 越权反例各报一条诊断，安全对照与独立多实例例均无诊断；真实源码副本中的 reduce 在 prepare 入口被拒绝，未执行真实恢复 IO。

| 验证 | 当前修复候选结果 |
| --- | --- |
| 完整门禁 | UNIT_TEST_CONCURRENCY=2 npm run release-check：PASS，2026-09-22 11:43:25–12:00:05（Asia/Shanghai） |
| 架构专项 / CLI | 270/270 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 | 9044 PASS、0 FAIL、4 项 Windows 条件跳过（9048 total、828 suites） |
| 全量集成 | 68/68 脚本 PASS；有计数用例 2901/2901，另 1 个脚本无用例计数 |
| 保护 | 1701 个门禁输入及 HEAD 无漂移；792 个 src、216 个历史证据、主工作区 865 个 dirty 文件保持 |

[修复报告](reviews/2026-09-22-release-r4-repair/repair.md)、[验证汇总](reviews/2026-09-22-release-r4-repair/verification.json)、[本轮增量](reviews/2026-09-22-release-r4-repair/incremental.patch)。本轮是修复自检，独立复审及真实产品 Main、Windows/安装包、Excel/WPS、资金人工验收未执行；未提交或发布。

## 2026-09-22 第三轮独立审查修复（未提交）

RR3-01～05 的反例及本地工厂返回后的别名写入已关闭；业务生产文件和机器授权配置未变化。新增 33 项回归在修复前版本上 26 FAIL / 7 PASS，修复后全部通过。完整实际配置的原始探针分别拒绝违规路径并保留安全对照。

| 验证 | 当前修复候选结果 |
| --- | --- |
| 完整门禁 | UNIT_TEST_CONCURRENCY=1 npm run release-check：PASS，2026-09-22 01:45:20–02:09:31（Asia/Shanghai） |
| 架构专项 / CLI | 237/237 PASS；31 active、0 pending/partial、0 诊断、0 stale |
| 全量单测 | 9011 PASS、0 FAIL、4 项 Windows 条件跳过（9015 total，828 suites） |
| 全量集成 | 68/68 脚本 PASS；计数用例 2901/2901，另 1 个脚本无用例计数 |
| 输入与保护 | 1700 个门禁输入、HEAD 未漂移；792 个 src/、135 个原审查/修复证据、主工作区 865 个 dirty 文件保持 |

[完整证据与修复边界](reviews/2026-09-22-release-r3-repair/repair.md)、[验证汇总](reviews/2026-09-22-release-r3-repair/verification.json)、[本轮增量](reviews/2026-09-22-release-r3-repair/incremental.patch)。本轮为修复自检，尚未独立复审；真实产品 Main、Windows/安装包、Excel/WPS 和资金人工验收未执行。没有提交、推送或正式发布。

## 2026-09-21—22 第二轮独立审查修复（未提交）

- RR2-01～05：补齐静态数组回调传播、bound factory 预绑定参数、对象别名写入、initialInfo 递归数据合同，以及 G1 当前内部恢复入口。仅改变检查器/配置/测试，保留上轮生产修复。
- 新增 34 项回归，架构专项 204/204 PASS；原审查的确认反例原样重跑均产生违规诊断。真实 CLI 为 31 active、0 pending/partial、0 诊断、0 stale。
- `UNIT_TEST_CONCURRENCY=1 npm run release-check`：2026-09-21 23:59:32—2026-09-22 00:19:13（Asia/Shanghai），exit 0；8978 项单测通过、0 失败、4 项 Windows 条件跳过；68/68 集成脚本通过，有计数合计 2901/2901；Renderer 生命周期 233/233。
- 1699 个冻结门禁输入及 HEAD 未漂移；792 个 src/ 文件、79 个既有证据文件、主工作区 865 个 dirty 文件全部保持。集成策略清单由成功 runner 自动刷新。

[修复报告](reviews/2026-09-21-release-r2-repair/repair.md)、[验证摘要](reviews/2026-09-21-release-r2-repair/verification.json)、[完整日志](reviews/2026-09-21-release-r2-repair/release-check.log)。本轮五项反例已关闭，仍保留报告列明的静态覆盖限制；修复后独立复审、真实 Main、Windows/安装包、Excel/WPS 和资金人工验收未完成。未提交、推送或发布。

## 2026-09-21 第一轮独立审查修复（历史验证，未提交）

- R1：退款／C3 确认使用具体 modal handle 的 `submitted` 结果关闭，只有关闭成功且句柄／控制器仍有效才继续业务；真实 Electron 组合回归覆盖四条按钮路径与关闭被拒情况。
- R2：对齐实际 G1–G8 入口、消费者和能力；G5 按真实调用追踪，G7 按目标与具名导出装配，Renderer 按准确 API／面板／服务登记。补齐独立探针发现的回调与能力转发漏报。诊断从 2195 归零，31 active、0 pending/partial、0 stale；只保留两条固定基线扩展 worker SCC 例外。
- 最终 `UNIT_TEST_CONCURRENCY=1 npm run release-check`：2026-09-21 22:21:50—22:45:10（Asia/Shanghai），exit 0；lint／架构／smoke PASS；单测 8944 通过、0 失败、4 项 Windows 条件跳过；集成 68/68 脚本通过，有计数合计 2901/2901。Renderer 生命周期 233/233，架构专项 170/170。
- 1698 个受验代码／配置／测试输入及 HEAD 均保持；原审查 24 文件、主工作区 865 个既有 dirty 文件 SHA-256 均保持。`rules/integration-test-policy.md` 由成功 runner 自动同步。

证据：[完整日志](reviews/2026-09-21-release-repair/release-check.log)、[验证摘要](reviews/2026-09-21-release-repair/verification.json)、[激活映射](reviews/2026-09-21-release-repair/activation-ledger.json)、[独立增量复核](reviews/2026-09-21-release-repair/independent-review/review.md)。本次没有提交、推送、升版、标签或发布；真实产品 Main 全流程、Windows／安装包、Excel／WPS 及既有 G3 资金人工复核仍未完成。

## application-recovery 合入

本次按用户要求，将 `codex/v3.2.10-application-recovery` 合入 `release/v3.2.10`，范围为 G1 应用恢复阶段与共享发布恢复授权。G2—G8 未因本次合并被标为完成。本记录只确认本地集成，不代表正式发布或平台人工验收通过。

| 项目 | 实际记录 |
| --- | --- |
| 上一正式基线 | `v3.2.9` → `11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 合并前 release | `11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 功能分支 | `codex/v3.2.10-application-recovery` |
| 功能提交 | `856c9dce8ae4c381229e37b5b236e2e2f776921d` |
| 合并方式 | `--no-ff`，无冲突；先完成验证，再创建合并提交 |
| release 工作区 | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |
| 实际内容 | 源工作区 148 个文件冻结后提交，包含 63 个代码、测试、脚本及规则文件，其余为设计、审查与验证材料 |
| 内容一致性 | 148/148 文件与冻结内容一致；验证前的合并树与功能提交完全一致；最终合并仅额外加入本文和本次验证证据 |
| 范围外操作 | 未推送、未开 PR、未合入 main、未升版、未创建标签或发布 |

源分支原本没有独有提交，本次先核对其未提交实现与既有审查/门禁快照，再提交完整模块成果。主工作区保持 `main`，未修改其文件；源分支提交后工作区干净。原 [实施记录](codex/v3.2.10-application-recovery/implementation-notes.md)、[验证摘要](codex/v3.2.10-application-recovery/evidence/verification-summary.json)和[独立审查](codex/v3.2.10-application-recovery/review-2026-09-20.md)保留实施、审查时点的“未提交/未集成”历史描述，后续本地集成状态以本文及 Git 合并历史为准。

## 验证与证据

本次验证在独立 release 工作区执行，复用现有依赖，仅使用测试创建的临时数据。机器记录见 [merge-validation.json](codex/v3.2.10-application-recovery/evidence/merge-into-release/merge-validation.json)。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| `npm run lint` | PASS，exit 0 | [lint.log](codex/v3.2.10-application-recovery/evidence/merge-into-release/lint.log) |
| `npm run smoke` | PASS，exit 0 | [smoke.log](codex/v3.2.10-application-recovery/evidence/merge-into-release/smoke.log) |
| `node scripts/integration/application-recovery-governance.js` | 4/4 PASS，exit 0 | [application-recovery-governance.log](codex/v3.2.10-application-recovery/evidence/merge-into-release/application-recovery-governance.log) |
| 功能内容与既有门禁快照比对 | 63/63 文件 SHA-256 一致 | [source-snapshot.json](codex/v3.2.10-application-recovery/evidence/source-snapshot.json) |
| 既有独立审查输入比对 | 86/86 原输入 SHA-256 一致 | [input-manifest.json](codex/v3.2.10-application-recovery/evidence/review-2026-09-20/input-manifest.json) |
| 既有完整门禁 | 记录为 PASS：8167 单测通过、0 失败、4 项 Windows 条件跳过，61/61 集成脚本通过；本次未重新运行 | [release-check-final.log](codex/v3.2.10-application-recovery/evidence/release-check-final.log) |

既有完整门禁日志 SHA-256 为 `1558ae58418e94e3db39727df47b6ff2f5c6d9c8b752422b006bf1b22e29fb32`，与独立审查时记录一致。此次目标 release 原为同一基线，没有其他模块组合差异；代码、测试及规则与已验证快照完全一致，因此复用完整门禁证据，没有将本次局部运行写成新的完整门禁 PASS。

## 保留的验收边界

- 真实 Electron 冷启动、Windows 文件锁/安装包/平台耐久性、Excel/WPS 人工验收未执行，4 项 Windows 条件跳过仍保留。
- 既有独立 manifest 检查器的现行 67 actions 与历史冻结 54 actions 冲突已在基线复现，属于完整门禁之外的既有问题；证据见 [manifest-baseline-triage.json](codex/v3.2.10-application-recovery/evidence/manifest-baseline-triage.json)。本次未重写历史发布证据。
- 后续纳入其他模块、修改代码或准备正式发布时，按最终候选及适用规则重新执行受影响检查与正式交付门禁。

## G4/G6/G5 三模块合入

本次继续按用户指定范围，从已包含 G1 的 `5ccbf3f022488026f725a5111be00422a04ce221` 出发，按 G4 → G6 → G5 顺序本地合并。三个源工作区的实现原本均未提交；先冻结并核对既有审查摘要，再分别提交本模块源码、测试、设计和证据。其他模块、旧版本及相邻需求的设计副本没有纳入提交。

| 模块 | 功能分支 | 功能提交 | 合并提交 |
| --- | --- | --- | --- |
| G4 共用 XLSX 基础设施 | `codex/v3.2.10-shared-xlsx-infrastructure` | `a4d91d173945cc42fcd9593f56504060c98f9d47` | `fd1c95edc239fb544b58c762b8d6eb4e9cb8f401` |
| G6 存储与执行分离 | `codex/v3.2.10-storage-execution-separation` | `ed1cb2d73418fe1279cac96acd91090492555be3` | `dffd6e2aceea8caea3aecc7396cb025a1c693e47` |
| G5 BizOP 查询与归档边界 | `codex/v3.2.10-bizop-query-boundaries` | `e4389aafb07fc3d40c74af106abb2875981d07eb` | `49ac95a80bf884a0bfdc2f53ecbfdb4dd982819e` |

三个合并均为 `--no-ff`。组合源码候选是 `49ac95a80bf884a0bfdc2f53ecbfdb4dd982819e`，其历史包含上述三个功能提交及既有 G1 合并。当前仍为本地集成，未推送、未合入 main、未升版或发布。

### 内容核对与冲突处理

- G4 原独立审查输入 121/121 文件摘要匹配；G6 最终源码快照 23/23 匹配；G5 实施清单 18/18 与独立审查输入 63/63 匹配。
- 实际提交范围分别为 148、109、57 个文件。合并后除明确组合的 AGENTS、生成清单、VCC 两文件和 Main 外，其余模块文件逐字节保持各自冻结内容，见 [内容比对](evidence/merge-g4-g5-g6/composition-audit.json)。
- 源码均自动合并，没有人工选择一侧覆盖另一侧。VCC `review-export-plan.js` 与 `vcc-financial-op-dataset-writer.js` 同时保留 G4 的 reader 路径/有效预算与 G6 的纯 hash/血缘合同；Main 同时保留 G1 恢复装配与 G6 所属 prepare 释放锁的修复。两边原补丁均能在组合内容上通过只读反向适用检查，见 [重叠补丁核验](evidence/merge-g4-g5-g6/overlap-audit.json)。
- 实际冲突仅为 `AGENTS.md` 的模块导航和 `rules/integration-test-policy.md` 的自动生成章节。导航保留全部已落地模块；测试规则第七节以前正文逐字相同，最终清单交给组合集成 runner 全通过后自动刷新，不手填通过数字或放宽规则。
- 主工作区保持 `main@11086a3c`，86 个原未跟踪文件摘要及状态不变。三个源分支已跟踪文件干净，分别保留 8、39、32 个不属于本次模块提交的未跟踪设计副本；这些副本的内容未改变，见 [工作区保留核验](evidence/merge-g4-g5-g6/workspace-preservation.json)。

### 本次组合验证

本次针对组合源码 `49ac95a80bf884a0bfdc2f53ecbfdb4dd982819e` 重新运行 `UNIT_TEST_CONCURRENCY=2 npm run release-check`，**完整 PASS，exit 0**。执行环境为 macOS arm64 / Node v25.8.0，使用独立 release 工作区及测试自行创建的临时文件/数据库。运行时间为 2026-09-20 21:58:30—22:25:08（Asia/Shanghai），约 26 分 38 秒。

| 检查 | 本次实际结果 |
| --- | --- |
| lint | PASS |
| smoke | PASS |
| 完整单测 | 523 个文件，8306 项中 8302 PASS、0 FAIL、0 CANCELLED、4 SKIP |
| 全量集成 | 64/64 脚本通过，runner 可解析的断言汇总为 2657/2657；未提供统一计数的脚本仍按实际 exit 0 判定 |
| G1 应用恢复集成 | 4/4 PASS |
| G4 共享 XLSX 边界集成 | 51/51 PASS |
| G5 BizOP 查询边界集成 | 9/9 PASS |
| G6 Acquiring worker 边界集成 | 14/14 PASS |
| 测试清单 | runner 在全部集成通过后自动更新第七节，规则正文保持不变 |

完整日志见 [release-check.log](evidence/merge-g4-g5-g6/release-check.log)，退出码、时间、计数及日志摘要见 [release-check-result.json](evidence/merge-g4-g5-g6/release-check-result.json)。这次是合并后组合的完整运行，不是汇总各分支旧结果。后续记录提交仅更新本文、版本索引、验证证据和 runner 生成的测试清单；源码、测试、执行脚本及依赖配置的对象保持被测候选一致，见 [validated-input-objects.json](evidence/merge-g4-g5-g6/validated-input-objects.json)。

### 仍保留的边界

- G2/G3/G7/G8 未纳入，尤其 G8 的架构规则尚未在此组合激活。G5 TechDoc 对 G8 TechDoc 的相对链接随 G8 后续集成才在 release 可用，现可从[主工作区 G8 设计](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md)查阅；未为修复链接混入其他分支的设计副本。
- G6 已记录的共享 prepared 包装器第二 gate / initialize 异常未调用 onAbandon 的基线缺口仍属于 G2 后续范围，本次没有把它当作已修复。
- 完整自动门禁不替代 Windows 文件占用/安装包、Electron 真实 GUI 对账/取消/续跑、Excel/WPS 人工验收；本次未进行这些平台验收。
- 原各模块 Spec/TechDoc、实施与审查记录保留其原时点的“未提交/未集成”描述，当前集成事实以本文与 Git 历史为准。现行 67 actions 与历史 54 actions 的独立 manifest 上下文差异继续沿用原证据说明，没有改写历史冻结产物。

## G2 business-task-adapters 合入

2026-09-21，按用户要求将 `codex/v3.2.10-business-task-adapters` 合入既有 release；之前 G1/G4/G5/G6 成果全部保留。源工作区以 G1 合并提交 `5ccbf3f022488026f725a5111be00422a04ce221` 为固定依赖，交付实现原本未提交。本次将本模块 114 个文件冻结提交，保留该工作区 29 个无关未跟踪设计副本。

| 项目 | 实际记录 |
| --- | --- |
| 合并前 release | `320d20df68bdeb175060ed37513a2fe5f23436bc` |
| G2 功能提交 | `3e203858ea49fc2935f5ab847de8af7f793d356a` |
| 合并提交 / 受验组合 | `8b12a6d5fd71b70ade58b9b6e7a347e29dbe8d05` |
| 合并方式 | `--no-ff`；代码自动合并，导航及生成清单冲突按下述方式处理 |
| release 工作区 | `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` |

### 本批内容与组合核验

- G2 最新启动补测快照 46/46 SHA-256 与冻结源一致；其旧完整门禁及后续 63/63 集成记录作为来源证据保留，不冒充此次组合运行。
- Main 自动合并结果精确等于 G2 Main 加上既有 G6 worker failure listener 锁所有权修复。公共任务入口迁入 task adapter 与 prepared resource scope，G1 恢复依赖保留；第二 gate / Archive initialize 抛错后的 onAbandon 收口由 G2 对应回归覆盖。
- 除 AGENTS、版本索引、测试清单和 Main 外，G2 110 个文件逐字节一致；此前 release 的 317 个非交集文件保持原内容。见 [组合核验](evidence/merge-g2/composition-audit.json)。
- 仅两处冲突：`AGENTS.md` 同时保留 XLSX 与任务适配器入口；`integration-test-policy.md` 第七节前的规则正文一致，先保留 release 旧生成清单，最终由全部集成通过后的 runner 自动刷新。版本索引同步所有已集成模块。
- 主工作区保持 `main@11086a3c`，原 97 个未跟踪文件的内容不变；G2 源工作区的 114 个模块文件和 29 个范围外设计副本均保持冻结字节。见 [工作区保留核验](evidence/merge-g2/workspace-preservation.json)。

### 本批组合验证

`UNIT_TEST_CONCURRENCY=2 npm run release-check` 对上述合并提交完整执行，**PASS，exit 0**。环境为 macOS arm64 / Node v25.8.0；2026-09-21 00:07:51—00:26:03（Asia/Shanghai），约 18 分 12 秒。

| 检查 | 本次实际结果 |
| --- | --- |
| lint / smoke | 全部 PASS |
| 完整单测 | 530 个文件，8439 项中 8435 PASS、0 FAIL、0 CANCELLED、4 Windows 条件 SKIP、0 TODO |
| 全量集成 | 66/66 脚本通过；可解析的断言汇总 2664/2664，单个未输出计数的历史脚本按 exit 0 判定 |
| G2 prepared 资源回归 | 第二 gate、Archive initialize、adapter 构建、生命周期拒绝、延迟 cleanup / exit tail 等实际入口测试通过 |
| G2 task-adapter recovery | 4/4 PASS |
| G2 production Position startup recovery | 3/3 PASS |
| G1 / G4 / G5 / G6 专项集成 | 应用恢复 4/4、共享 XLSX 51/51、BizOP 查询边界 9/9、Acquiring worker 边界 14/14，均 PASS |

四项跳过为真实 Windows PowerShell/CIM 及 packaged canary 场景；具体名称见 [单测摘要](evidence/merge-g2/unit-summary.json)。

完整日志见 [release-check.log](evidence/merge-g2/release-check.log)，运行环境、起止时间、退出码及摘要见 [release-check-result.json](evidence/merge-g2/release-check-result.json)。记录提交仅同步版本状态、证据和 runner 生成的测试清单，源码、测试、执行脚本及依赖对象与受验组合一致，见 [validated-input-objects.json](evidence/merge-g2/validated-input-objects.json)。

### 本批状态与验收边界

- 当前已集成 G1/G2/G4/G5/G6；G3/G7/G8 未纳入。G2 的 `ARCH-TASK-ADAPTER` 机器规则激活仍待 G8 后续联合验收，现有 composition 单测和完整门禁不代替该激活。
- 上批记录中归属 G2 的 prepare 后第二 gate / initialize 资源清理缺口已由本批实现及对应回归承接；上方旧记录保留其当时状态。
- 真实 Electron 进程强杀与 GUI、Windows 文件锁及安装包、Excel/WPS 人工验收未执行；确定性 Node 恢复集成不等同这些平台验收。
- G2 原 Spec/TechDoc、实施与审查证据保留历史“未提交/未集成”及分轮验证描述，当前集成事实以本节和 Git 历史为准。原独立 manifest 现行与历史 actions 上下文差异保持原记录。
- 本次仅本地合并，未推送、未开 PR、未合入 main、未升版、未创建标签或发布。

## G3 Renderer / G7 execution-descriptors 合入

2026-09-21，按用户要求将以下两个分支依次合入既有 `release/v3.2.10`。合并前 release 为 `1c0051ed1f98434aabf6bd82150de716059dc982`，已包含 G1/G2/G4/G5/G6；源实现均为工作区差异，本次先固定各模块内容再合并。

| 模块 | 功能分支 | 功能提交 | 合并提交 |
| --- | --- | --- | --- |
| G3 Renderer 状态与弹窗边界 | `codex/v3.2.10-renderer-boundaries` | `611af431493668df02fff98bdcda0b47c4080f20` | `a85dbee2021c9e810f0274d66c3d027474c4a1c8` |
| G7 执行与归档描述符 | `codex/v3.2.10-execution-descriptors` | `6a7d23c4ea062f90021fc670e8a1654ad8d2ad26` | `9602a1fa482203e11bfde8cd6a73b8f552243d95` |

两次合并均使用 `--no-ff`，组合受验候选为 `9602a1fa482203e11bfde8cd6a73b8f552243d95`。当前已纳入 G1—G7，G8 未纳入。本批仅本地集成，未推送、未开 PR、未合入 main、未升版或创建标签。

### 内容、冲突与证据保护

- G3 冻结提交 188 个模块文件；最新第四轮复审的 3,100 项输入中，源码/测试/脚本无漂移，仅实施记录后来接收复审结论。G7 冻结提交 243 个模块文件，最终门禁源码快照 133/133 匹配。见 [来源证据核对](evidence/merge-g3-g7/source-evidence-audit.json)。
- 代码与测试自动合并；实际冲突仅为根 AGENTS 模块导航、版本索引和集成测试自动生成清单。导航同时保留所有模块，版本索引按 release 当前状态更新；政策第七节前正文一致，最终清单由全部集成通过后的 runner 自动生成。
- 五个 G3/既有模块交叉测试，以及两个 G3/G7 交叉测试，双方补丁均可在组合内容上通过只读反向适用检查。合并候选中 G3 的 180 个、G7 的 238 个非交集文件与冻结源逐字节一致。见 [组合核验](evidence/merge-g3-g7/composition-audit.json)、[G3 交叉补丁](evidence/merge-g3-g7/g3-overlap-check.json)、[G7 交叉补丁](evidence/merge-g3-g7/g7-overlap-check.json)。
- 主工作区保持 `main@11086a3c`，原 130 个未跟踪文件内容不变；G3/G7 源工作区分别保留 2/6 个范围外设计副本。见 [工作区保留核验](evidence/merge-g3-g7/workspace-preservation.json)。
- G3 实施记录原有 77 个证据文件位于被忽略的临时目录，本批逐字节归档约 17 MB，并仅调整实施记录中的 77 处证据链接。旧失败、被拒绝的运行、历史补丁和原始输出均保留，未改写为 PASS。G7 TechDoc 的 G8 设计引用改为主工作区既有设计路径，没有混入 G8 文件。归档清单见 [manifest.json](evidence/merge-g3-g7/g3-worktree-evidence/manifest.json)。

### 本批组合验证

`UNIT_TEST_CONCURRENCY=1 npm run release-check` 对上述组合完整执行，**PASS，exit 0**。macOS arm64 / Node v25.8.0；2026-09-21 10:47:39—11:13:35（Asia/Shanghai），约 25 分 56 秒。

| 检查 | 本次实际结果 |
| --- | --- |
| lint / smoke | 全部 PASS |
| 完整单测 | 551 个文件，8777 项中 8773 PASS、0 FAIL、0 CANCELLED、4 Windows 条件 SKIP、0 TODO |
| 全量集成 | 68/68 脚本通过；runner 可解析断言汇总 2874/2874，未输出计数的历史脚本按 exit 0 判定 |
| G3 隔离 Electron lifecycle | 206/206 PASS，真实 DOM/生产工厂，受控业务 API |
| G7 execution-descriptor governance | 4/4 PASS，真实载体及既有装配/授权合同 |
| G3 既有单测缺口 | 1024 个真实 Task 来源通过（约 84 秒）；R3.2.4 原提交/PR 历史 evidence 复验通过（约 87 秒） |
| 当前 manifest 独立校验 | 402/402 PASS、74 legacy pairs、13 production enabled；批准基线未改 |

G3 早先完整门禁因磁盘风险被自动审批拒绝。本次先确认无其他大型测试并发，在已获准的合并组合上采用单文件串行单测，并在剩余磁盘低于 2 GiB 时仅终止本次测试进程组。开始余量 7.396 GiB，本轮最低观测 6.583 GiB，保护未触发；没有排除此前的两项测试。旧失败/拒绝记录保留，新 PASS 只对应本次组合。四项跳过仍为真实 Windows PowerShell/CIM 和 packaged canary；具体名称见 [单测摘要](evidence/merge-g3-g7/unit-summary.json)。

完整日志见 [release-check.log](evidence/merge-g3-g7/release-check.log)，环境、起止时间、退出码、计数与磁盘保护记录见 [release-check-result.json](evidence/merge-g3-g7/release-check-result.json)。后续记录提交仅同步文档链接、版本状态、证据及 runner 生成清单；源码、测试、执行脚本、页面入口、lint 与依赖配置对象保持受验候选一致，见 [validated-input-objects.json](evidence/merge-g3-g7/validated-input-objects.json)。

### 当前仍未完成的验收

- **G3 记录的资金相关人工复核仍未执行。** R01 来源绑定修复的自动化使用合成 Excel、真实 parser/session 和内存 SQLite；需人工核对界面确认账期、输入期初、Main snapshot、逐文件明细和落库 receipt 的一致性，不能据自动测试宣称真实资金数据已验收。原要求见 [G3 实施记录的资金复核说明](codex/v3.2.10-renderer-boundaries/implementation-notes.md#资金人工复核与剩余门禁)。
- 隔离 Electron 工厂使用受控 API，不等于产品 Main 两阶段写入、模板库同步、Task/日志的完整端到端验收；Windows/Excel/WPS/安装包及真实用户数据故障恢复人工验收未执行。G3 第四轮额外三项独立探针因执行器异常未完成的记录保留，不计为通过。
- G8 未集成；`ARCH-TASK-ADAPTER`、`ARCH-DESCRIPTOR-COMPOSITION` 等机器规则的激活及联合验收仍待后续。当前自动测试不代替规则激活。
- 原各模块文档中的“未提交/未集成”和分轮验证保留其原时点含义；当前 Git 集成与组合验证以本节为准。G7 当前 manifest 检查独立通过，早期 manifest 历史差异记录不追溯改写。


## G8 architecture-guardrails 合入

本次按用户要求将 `codex/v3.2.10-architecture-guardrails` 合入现有 `release/v3.2.10`。**本地 Git 合并完成；组合门禁失败；G8 领域激活未完成。** 没有把 source 分支上的检查器测试通过当作 G1–G8 组合通过，也没有通过修改配置、扩大例外或跳过架构步骤掩盖失败。

| 项目 | 实际记录 |
| --- | --- |
| 合并前 release | `e0d6e51b9d07896ac333e5e68900261202935808` |
| 来源分支 | `codex/v3.2.10-architecture-guardrails` |
| 本次冻结的功能提交 | `9a1d8aee5ac8cfb27c816167a8cf3d6a4baff802` |
| 合并提交 / 验证候选 | `f8fd640586f9119b091148151e1beb48f9552c5d` |
| 合并方式 | `--no-ff`；唯一冲突为 AGENTS.md 的追加导航，保留双方内容 |
| 来源范围 | 137 项源码、配置、CI、测试、设计和历史证据；18 项最新受验代码指纹一致 |
| 业务源码 | 相对合并前 release，`src/` 与 `index.html` 无变化 |
| 版本及发布 | 仅本地合并；未推送、未开 PR、未合入 main、未升版、未打标签或发布 |

来源分支原来仍指向 v3.2.9，G8 实现和第五轮修复在未提交工作区。本次先冻结其实际内容并提交；其他治理项设计、架构审查副本等未纳入。原始日志和历史 patch 按字节保留，其已有空白不改写；实际代码、配置和文档通过空白检查。来源的各轮「未提交／未集成」保留当时含义，当前集成状态以本节为准。

### 验证结果

执行环境为 macOS arm64 / Node v25.8.0；所有命令以 release worktree 为 cwd，仅使用检查器及合成测试数据。时间、退出码和完整命令见 [verification.json](evidence/merge-g8/verification.json)。

| 检查 | 本次实际结果 |
| --- | --- |
| `UNIT_TEST_CONCURRENCY=1 npm run release-check` | **FAIL，exit 1**；lint 通过，在 check:architecture 阶段停止 |
| smoke / 全量 unit / integration | 本轮 release-check 因前序失败未执行；不引用旧候选 PASS 代替 |
| G8 架构专项套件 | **143/143 PASS**，0 fail / 0 skip，包含真实 Git 历史、CLI 及各轮修复回归 |
| 候选架构 CLI | **FAIL，exit 1**；765/765 文件可解析，2195 条静态诊断 |
| 规则状态 | active 2、pending 0、partial 29；111 条 stale 历史例外待审计清理 |

日志：[release-check](evidence/merge-g8/release-check.log)、[143 项专项](evidence/merge-g8/architecture-tests.log)、[架构检查](evidence/merge-g8/architecture-check.log)；机器报告：[architecture-check.json](evidence/merge-g8/architecture-check.json)、[分类摘要](evidence/merge-g8/diagnostic-summary.json)。后续记录提交只修改文档和证据，受验代码对象见 [validated-input-objects.json](evidence/merge-g8/validated-input-objects.json)。

### 尚未闭合的组合边界

2195 条诊断按规则为：ARCH-BIZOP-QUERY 1485、ARCH-STATIC-COVERAGE 542、ARCH-RENDERER-SCOPE 109、ARCH-DESCRIPTOR-COMPOSITION 38、ARCH-TASK-ADAPTER 19、ARCH-PUBLICATION-RECOVERY-ENTRY 2。**这些是检查器输出，不能等同于相同数量的已确认业务缺陷。**

已确认需进一步归因和对齐的内容：

- BizOP Q3 保护整份 import-main.js / delete-preview.js，检查器沿模块依赖扩展；现有 import-main 的公共 policy 装配会进一步到达其他领域仓储，出现大量跨领域 DB 诊断。需要区分实际读取调用与静态整模块依赖，不能直接把这些仓储都加入例外。
- Renderer 的机器登记仍包含早期工厂 global、参数和 API 清单；当前实现使用的 scoped namespace、ui 对象及实际工厂装配与登记不一致。需按 G3 合同逐项核验，不以放开完整 API 代替修复。
- G7 的实际 composition / policy / archivePolicies 装配与早期登记不一致；G1 授权恢复入口和 G2 通用编排的相关诊断也待逐项判定。
- 三个配置内引用的测试路径在当前树不存在：publication-recovery-entrypoints.test.js、controller-contract.test.js、modal-host-integration.test.js。需与实际领域测试建立对应；文件存在本身不等于行为验收通过。

本次只做已授权分支合并及验证，未对上述跨 G1–G7 的机器契约和生产装配另行改写。下一阶段应在固定集成候选上逐项归因，按各领域合同修正配置／检查器／实际违规、补充必要反例、清理失效例外，再完成激活与完整 release-check。G8 第五轮修复后的独立复审也仍未执行。

### 工作区保护与验收边界

- 主工作区仍为 `main@11086a3c`；本次开始时记录的 865 个 dirty 文件哈希全部保持。
- 来源 137 项冻结文件全部保持，未纳入提交的其他来源材料保持；release 中仅 AGENTS.md 和 integration-test-policy.md 因保留既有集成内容与来源不同，其余 135 项一致。
- G1–G8 的来源提交均为合并候选祖先。清单及保护报告见 [input-manifest.json](evidence/merge-g8/input-manifest.json)、[source-commit.json](evidence/merge-g8/source-commit.json)、[workspace-preservation.json](evidence/merge-g8/workspace-preservation.json)。
- G3 资金人工复核、真实产品 Main 端到端、Windows workflow／安装包、Excel/WPS 和实际数据故障恢复验收仍未完成；本次检查器测试不能替代这些验收。
