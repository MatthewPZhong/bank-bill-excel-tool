# G6 仓储、执行编排与纯校验分离实施记录

唯一切片索引；设计依据 [Spec](spec.md)、[TechDoc](techdoc.md)，完成标准见[总索引 §6.2–§6.4](../../README.md#slice-completion)。设计审查状态与下面实现/验证/集成状态相互独立。

## 代码与资料边界

- 分支：`codex/v3.2.10-storage-execution-separation`。
- 独立 worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-storage-execution-separation`。
- 基线及当前 HEAD：`11086a3cbf632a30adbcfa796e4cd81810c5aef9`（本地 main / v3.2.9）；本任务不提交、推送、合并、开 PR、升版或发布。
- 初始主工作区仅有未跟踪设计/审查目录。G6 Spec/TechDoc、总索引、审查修订和必要 G4/G8 参考从用户提供的主工作区绝对路径复制，原件未修改。原设计快照保留来源；2026-09-20 用户确认后，本功能分支 Spec D8/AC-08、TechDoc §4.4 和 B3 补充方案已同步新增批准范围。主工作区原件未修改，当前进度以本文件为准。
- 依赖使用主工作区已有 `node_modules` 的本地符号链接；没有安装/升版依赖。测试只使用自建临时目录与 SQLite/Excel fixture，不读取真实业务数据。
- 平台：macOS，Node v25.8.0。未集成任何其他 G 项；G8 机器配置尚未接入，不能登记为 active。

## 决策与协作

- 按用户要求先完成 B0 并取得真实退出证据，再迁移 Acquiring service。
- G4 任务确认：G4 独占 VCC review-export-plan/dataset-writer 的 rich reader 与公共机制 imports、effective reader options/预算配置；G6 独占 hash/lineage 正文及 imports。集成时同时保留两组 imports，reader 新入口为 `src/backend/xlsx`。当前没有跨分支合并。
- SQL、逐 chunk 事务、partial/resume、C1 受管旧 part 写前重建及固定目录顺序复用保持设计合同；B0 的提前结束修复单独记录，不称为“行为全部不变”。

## 切片状态

| 切片 | 实现 | 验证 | 集成 | 证据/五项记录 |
| --- | --- | --- | --- | --- |
| A1 hash/version fixture | 已实现 | 通过（70/70 提取前基线） | 未集成 | [VCC 五项记录](vcc-slice-notes.md) |
| A2/A3 纯合同及调用方迁移 | 已实现 | 通过（78/78 单测、226/226 管线） | 未集成 | [VCC 五项记录](vcc-slice-notes.md) |
| B0 真实退出屏障 | 已实现 | 通过（最终 26/26、lint、独立 OOM 首错复核） | 未集成 | [B0 五项记录](b0-slice-notes.md) |
| B1 SQL/行序/失败基线 | 已实现 | SQL/文件合同通过；Main 锁修复专项通过 | 未集成 | 下文及 B3.1 证据 |
| B2 计划/service/session | 已实现 | 通过（45/45 单测、14/14 真实管线） | 未集成 | 下文 |
| B3 调用清点与恢复闭环 | 原范围迁移与批准的 Main 修复已实现 | 本功能专项及完整门禁通过；G2 共享包装器基线限制另列 | 未集成 | 下文 B3.1；不声称全域生命周期闭合 |

## B1：先锁定既有业务与参数合同

- 代码状态：HEAD 基线、未迁移 repository/session/service；新增参数 fixture。
- 职责与边界：旧 repository wrapper 仍拥有计划、executor 调用和失败清理，session 仍拥有 gate/partial/resume。
- 调用方与兼容：全仓清点进行中；旧入口尚未删除。
- 业务行为：G6-AC-05/06/07；参数顺序、chunkSize 数值字符串、truthy runId/monthKey、路径不 trim 与旧错误文案固定为基线；不新增默认值。
- 验证：`node --test tests/unit/main-process/acquiring-multiworker-contract.test.js`，21/21 PASS，[日志](evidence/b1-baseline-contract.txt)；`node --test tests/unit/main-process/acquiring-multiworker-service.test.js`，14/14 PASS，[日志](evidence/b1-baseline-parameters.txt)。后者在 B1 仍驱动旧 wrapper，后续只切 service 装配保留 fixture。
- 当前规则入口：遵守根 AGENTS/CODEX 与 `rules/run-scoped-data-policy.md`，未改变侧库 DDL、路径或存储语义；此时没有已落地的新 service 边界。
- 剩余项：同 tempDir 顺序复用 Main 锁全链核查；service 迁移后的回归；部分 merge/cleanup 失败与真实 resume 集成；人读 README、根导航和 G8 未集成状态随实施更新。

### B1 后续取证

- 新集成脚本 `scripts/integration/acquiring-worker-boundary.js` 在 service 未迁移、B0 正在实现的 worktree 上 14/14 PASS：[迁移前过程日志](evidence/b1-pre-service-integration.txt)。覆盖真实 XLSX 导入/导出、M=2/4 行序、固定 caller 目录 C1、取消→partial→resume，以及 SQLite trigger 制造第一 chunk 已 COMMIT、后续 merge/cleanup 双失败→原错/残留→resume。该日志不是最终代码验收，也不作为未修改 executor 的基线证据；最终收口须再跑。
- Main 锁取证已发现 idle pool failure 无所属身份释放当前 prepare 锁。已形成[补充方案](b3-lock-fix-proposal.md)，首次交付时待用户确认；用户后续已确认并按 B3.1 修复。原反例及当时按 TechDoc §4.3 阻断验收的证据保留。


## B2：仓储计划与应用 service

- 代码状态：本分支 HEAD `11086a3c` + 未提交差异。B0 先取得 25/25 初次证据后才开始 service 迁移；独立审查发现 B0 OOM 首错竞态后已修复并取得最终 26/26 证据，再跑真实管线。最终文件快照和完整可评审差异见最终验证章节。
- 职责与边界：旧仓储 `insertDiffRowsByJoinMultiWorker` → 新仓储 `buildMultiworkerPlan`/`cleanupFailedMultiworkerRun` + 应用 `createAcquiringMultiworkerService().insertDiffRows`；session 唯一装配 repository/executor。SQL 与事务属于仓储，worker 生命周期属于 executor，失败清理调用顺序属于 service，run 状态/资源/目录归属仍在 session。仓储不再调用 worker 宿主；保留 `archive-center/worker-batch-context` 的纯冻结合同，不将它误称为 worker executor。
- 调用方与兼容：唯一直接生产调用 session 已切换，`acquiring-multiworker-contract.test.js` 全部 8 处直接调用已切到测试显式装配；AppDatabase 无 facade，scripts 无旧接口直接入边；pool/worker/run-data/nested integration 随 session 间接迁移。仓储不保留转发或 executor 注入后门；仅错误文案保留旧函数名。VCC 兼容导出另见其切片记录。
- 业务行为：G6-AC-04/05/06。保留 SQL 字节、列序、COUNT 与参数校验顺序、数值字符串 chunkSize、0 行不开 worker、reader progress 不是提交、逐 chunk 合并事务、失败 cleanup 原错误优先、partial/resume。无 schema、hash、持久化版本或 IPC 变更。没有新增 service timeout、重试或隐式默认。
- 验证：`node --test tests/unit/main-process/acquiring-multiworker-service.test.js tests/unit/main-process/acquiring-multiworker-contract.test.js` → 45/45 PASS，[日志](evidence/b2-service-contract.txt)；`node scripts/integration/acquiring-worker-boundary.js` → 14/14 PASS，[最终管线日志](evidence/b2-b3-final-integration.txt)。独立旧新差分覆盖 224 组成功/异常/参数/清理组合，另验保留函数正文与 SQL 完全一致，见[独立报告](evidence/b2-independent-review.md)与[224 组差分输出](evidence/b2-differential-probe.txt)。
- 当前规则入口：根 [AGENTS.md](../../../../AGENTS.md) → [Acquiring README](../../../../src/backend/acquiring-bill-currency-db/README.md) 的“当前入口和职责”“失败顺序、调用前提和当前验证边界”。`rules/run-scoped-data-policy.md` 无需改写，因主/侧库职责、DDL/路径与生命周期均未改变。G8 配置不存在，未激活，不新建临时例外。
- 实施中间失败：机械提取第一次匹配到同名说明区，独立直接加载发现 `insertRun is not defined`；已从 HEAD 仅恢复被误选的既有仓储函数并精确替换旧 wrapper，保留函数与 HEAD 逐一比较一致。最终测试在修正后通过，不把中间态当最终证据。
- 剩余项与回退：首次交付的 B3 Main 锁归属问题已按后续 B3.1 最小修复关闭；G2 共享包装器基线限制、正式组合/平台验收另列。回退必须整体恢复旧仓储 wrapper、session 和测试装配；B0 已批准的退出修复不得因职责回退退化成提前释放资源。

## B3：调用清点、恢复和受管目录合同（首次交付记录，后续处置见 B3.1）

- 实现状态：原设计范围的 session 切换、旧仓储接口删除和测试迁移已实现；没有修改 Main/pool。验证状态：部分通过。集成状态：未集成。
- 职责与边界：生产路径 Main → run-data → pool → worker/session → service → repository/executor 只保留一条执行链。Main 提供 `storageRoot/.mw-tmp`；session 仅回收自行 makeTempDir 的私有外层根；executor 只写前重建/结束清理本次派发的精确 part + 三类 sidecar。路径存在或名称匹配不是归属授权。
- 调用方与兼容：旧仓储生产函数和导出归零，旧名字只剩保留错误文本及断言。未启用的 background acquiring adapter 为 `production=false`，不借本次改造启用；全部 caller 目录前提仍需 Main 锁闭合。相同 tempDir 不支持活跃调用并行。
- 业务行为：G6-AC-07/08 及 AC-06 的恢复部分。C1 受管旧 part 精确重建保留；取消后 partial/-1、merge 与 cleanup 双失败保原错/允许已有 COMMIT 残留、resume 从 0 清当前 run 再单 worker 重跑均通过真实管线。已有 contract A7 保证其他 run diff 不被失败清理误删；caller 标记/子目录/未派发旧 part 在成功、取消、失败后都不变。
- 验证：上述 45/45 与 14/14 已通过；[锁归属真实探针](evidence/b3-lock-ownership-probe.cjs)及[输出](evidence/b3-lock-ownership-probe.txt)复现 `hadActiveJob=false` 的 idle pool failure 清掉下一轮 prepare 锁。进一步实际重复 dispatch 得到第一个执行完成但 caller Promise pending。该探针退出 0 只表示取证完成，不表示验收 PASS；没有证据声称两个实际 MW 组同时写同一 part。
- 当前规则入口：Acquiring README 明确现有调用前提与已知缺口，根导航已补齐。G8 尚未接入；后续 G8 配置登记不能替代业务锁与退出验证。
- 剩余与回退：依 TechDoc §4.3，B1/B3 的全部调用链验收未闭合。已形成[最小锁修复方案](b3-lock-fix-proposal.md)，向用户提出是否纳入 Main 锁修复；授权前保留原源码。已提供[待批准补丁](evidence/b3-proposed-lock-fix.diff)和[真实 idle pool 的方案实验](evidence/b3-proposed-lock-fix-probe.txt)，该实验只修改内存源码字符串，不代表实际 Main 已修复。其余切片不因此撤回。整体回退 service/repository/session 装配，不更改数据库文件。

## B3.1：用户确认后的 Main 最小锁修复

- 父切片：B3；2026-09-20 用户回复“确认”，授权已准备的最小补丁及必要回归。设计依据为 Spec D8/AC-08、TechDoc §4.4 和[已确认方案](b3-lock-fix-proposal.md)。
- 当前状态：已实现；正式 Main 回归 11/11 PASS、定向 ESLint PASS、完整门禁 exit 0；未集成。上文 B3 原始问题与待确认记录保留为首次交付过程证据，本节负责后续处置状态。
- 职责与边界：去除 failureListener 对全局锁的无归属释放；取得锁的 prepare 仍通过其幂等 release closure 在 execute finally/onAbandon 释放。pool 只汇报失败，保留日志、通知和 partial 兜底。
- 调用方与兼容：run/resume prepare+execute、cancel handler、import/export/cleanup 的锁调用链逐一审查；IPC 参数、状态/通知、SQL、part 命名与 pool 调度协议不变。
- 业务行为：旧 idle worker 失败不得释放下一 prepare 的锁；active failure/正常/取消仍通过所属 finally 释放；旧 owner 重复调用不得清下一锁。
- 验证：`node --test tests/unit/main-process/acquiring-main-lock-ownership.test.js`，修复前 7/11、4 项 RED；应用最小补丁后 11/11 PASS。见[RED](evidence/b3-main-lock-red.txt)、[最终正式回归](evidence/b3-main-lock-tests.txt)、[ESLint](evidence/b3-main-lock-eslint.txt)、[源码指纹](evidence/b3-main-lock-file-sha256.txt)及[独立审查](evidence/b3-main-lock-independent-review.md)。实际 Main run/resume prepare+execute、cancel handler、failureListener 在 VM 装配；真实 pool/线程/SQLite，侧库桥接、Archive 查询、文件结算和 Electron 通知为明确替身，不等于 GUI 或共享 wrapper 全域验收。
- 当前规则入口：根 AGENTS → Acquiring README 的“失败顺序、调用前提和当前验证边界”已改为所属 prepare 释放锁的现行协议，并链接正式 Main 回归和 G2 基线限制；数据库存储规则无变化。G8 未集成。获批前实验与本次真实 Main 回归分开保留。
- 独立基线限制：共享 runArchiveAwareOperation 在 prepare 成功后的第二 gate/initialize 抛错时可能未调用 onAbandon，使锁继续保留；该路径不由本补丁引入、不扩大同 tempDir 并发能力，属于 G2 通用 prepared 清理范围，单列证据，不宣称共享包装器所有异常闭合。

## 最终验证与未执行边界

- [包含新增源码/测试的完整差异](evidence/g6-code.diff)、[最终文件 SHA256](evidence/final-code-state.json)、[审查报告](review.md)；设计原件是引用快照，当前实现/验证/集成状态以本记录为准。

- **更正首次交付的 manifest 判定：**[原始日志](evidence/manifest-check.txt)实际为 `E13-G Action Manifest drift`，首次记录和答复误写 PASS，现已更正。该命令用当前 67 action 与已发布 v3.2.5 的 54 action 快照直接比较；现有 unit gate 在历史提交复验冻结快照。本轮直接 `--write` 的产物同样改变 action/策略语义，审计未通过；已按写前 SHA256 和 HEAD 恢复本次四份历史 JSON，[恢复证据](evidence/b3-manifest-historical-restore.json)。后续使用原生成器独立输出对照修复前后当前政策产物，不修改历史策略或 action authority，不将临时生成检查通过写为历史快照直接检查通过。
- 本轮安全 manifest 差分已通过：[实际生成器隔离脚本](evidence/manifest-main-differential.js)、[原始输出](evidence/manifest-main-differential.txt)、[审计](evidence/manifest-main-differential/audit.json)。同一现行政策下 HEAD Main 与当前 Main 生成的三份产物字节相同，coverage 仅 `sourceHashes["src/main.js"]` 不同；两组各自 check-only PASS（402/402 surfaces、74 legacy pairs、13 production enabled），145 个本地依赖对比期间不变。四份仓内历史 JSON 均保持 HEAD，未启用任何新生产策略。这是本次补丁的独立当前语义对照，不代表旧历史快照直接 gate 已通过。
- 最终生产嵌套 worker 路径：`node scripts/integration/v2.1.12-beta-multiworker-nested.js`，8 项通过、0 失败，[日志](evidence/final-nested-worker.txt)；`node scripts/integration/acquiring-side-db-parity.js`，19/19 PASS，[日志](evidence/final-acquiring-side-db.txt)。两者覆盖 pool→worker→session 及主/侧库路径，没有对 Main 锁缺口作通过推断。
- 最终 Acquiring 生产代码定向 ESLint 与全工作树 `git diff --check` 通过，[lint 日志](evidence/final-lint.txt)；VCC lint 见 VCC 记录。
- 首次默认并发 `npm run release-check` 已停止（退出 143），原因是完整 unit 输出超过 5 分钟未推进，未取得最终结果；[原日志](evidence/release-check-default-concurrency-incomplete.txt)、[已核实并停止的本次测试进程记录](evidence/release-check-restart.json)保留。只停止本 worktree 的进程，没有处理其他功能任务。最终代码固定后按仓库支持的 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 重跑，已自然结束，退出 **1**：全量 lint、smoke 通过；unit **8,113 / 8,158 通过，41 失败，4 跳过**，耗时约 13 分 57 秒（unit 阶段）。由于 `&&` 短路，全量 integration 未启动。[完整日志](evidence/release-check.txt)、[结构化结果](evidence/release-check-result.json)。
- 门禁失败逐项核对：39 项有直接磁盘不足证据（34 项 ENOSPC、3 项真实磁盘预算拒绝、1 项 SQLite FULL、1 项 manifest 子进程 Git 复制失败）；另 2 项 Pending Supervisor 为 `failed` 与 `cancelled` 状态断言差异，原始日志未带内部 cause，不能统称为 ENOSPC。这两项在约 1.9 GiB 可用空间下定向重跑 2/2 PASS，[原始重跑记录](evidence/release-pending-cancel-recheck.txt)；测试、adapter、Supervisor、dispatcher 与 HEAD 同源，原失败根因仍未确认，不能替换完整门禁失败。详见[失败分类](evidence/release-failure-analysis.md)。先前 Position 3 项隔离运行当前与 HEAD 均通过，见[对照日志](evidence/release-position-maintenance-failure.txt)，不能替换本次完整门禁失败。未扩大清理其他任务临时目录，也未放宽磁盘或恢复规则。
- 用户确认 Main 修复后的 `UNIT_TEST_CONCURRENCY=2 npm run release-check` **完整通过，exit 0**：[本轮完整日志](evidence/release-check-after-main-fix.txt)、[结构化结果](evidence/release-check-after-main-fix-result.json)。lint/smoke PASS；510 个 unit 文件，8,169 项中 8,165 PASS、0 FAIL、4 平台 SKIP；61 个 integration 脚本全部通过，汇总 2,593 项断言（旧 nested worker 脚本不提供统一计数，但 exit 0）。unit 约 516.5 秒，integration 约 530.5 秒。前轮 41 FAIL 原始记录保留，不覆盖。
- 完整集成 runner 自动更新 `rules/integration-test-policy.md` 的第七节清单：新增本功能 14 项集成入口并刷新实测计数/耗时；第七节以外规则正文与 HEAD 一致，未修改门禁标准。
- Windows 文件占用、Electron/Acquiring 对账/取消/续跑 GUI、Excel/WPS、安装包和 release 组合验收未执行。本次未声称正式发布就绪，也没有提交、推送、合并、开 PR、升版或发布。
