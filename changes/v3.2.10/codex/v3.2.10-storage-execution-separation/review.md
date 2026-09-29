# G6 实施审查与交付状态

当前结论：VCC A1/A2/A3、Acquiring B0/B2 与原范围迁移已实现并取得专项证据；用户确认的 B3 Main 最小锁修复已实施，正式回归由 4 项 RED 转为 11/11 PASS，独立末审无新增阻断缺陷。全部改动未提交、未集成。针对最终 Main 的完整门禁已通过（exit 0），G2 共享 prepared 包装器的既有清理缺口和平台未验收项单列，不将本次修复称为全域生命周期闭合。

## 审查范围与代码状态

分支 `codex/v3.2.10-storage-execution-separation`，独立 worktree，HEAD `11086a3cbf632a30adbcfa796e4cd81810c5aef9`。源码/测试/模块说明见[含新增文件的完整差异](evidence/g6-code.diff)及[文件 SHA256 快照](evidence/final-code-state.json)。主工作区设计原件未改；用户确认后，仅功能 worktree 的 Spec D8/AC-08、TechDoc §4.4 和补充方案同步批准范围。

审查依据为本目录 [Spec](spec.md)、[TechDoc](techdoc.md)和[总索引切片完成标准](../../README.md#slice-completion)。根 AGENTS 已链接两个模块 README；每个切片的职责、调用方、行为、测试与现行规则入口分别记入[实施索引](implementation-notes.md)、[VCC 切片记录](vcc-slice-notes.md)和[B0 切片记录](b0-slice-notes.md)。

## AC 与已取得证据

| AC | 当前结论 | 核心证据 |
| --- | --- | --- |
| G6-AC-01 | 通过 | 冷加载只允许两纯合同、definitions 与 node:crypto，禁止 IO/Excel/DB/worker |
| G6-AC-02 | 通过 | 固定普通/Pending/CHANNEL hash 及 raw 版本 fixture，旧新中文错误与优先级 |
| G6-AC-03 | 通过 | writer/review plan 复用纯模块，旧导出对象 identity，无重复实现 |
| G6-AC-04 | 通过 | 旧仓储 worker wrapper 删除；25 个保留函数正文与 SQL 完全一致；新计划/service 装配 |
| G6-AC-05 | 通过 | 45 项 service/contract 单测与真实 M=2/4 单/多 worker 物理顺序集成 |
| G6-AC-06 | executor/service/session 专项通过 | B0 26/26、真实 OOM 首错复验、部分 merge/cleanup 双失败与取消→partial→resume 集成 |
| G6-AC-07 | 文件合同及本次 Main 排他性修复通过 | C1、caller 根/无关文件/未派发 part/其他 run diff 保留；真实 pool idle/active failure 不提前清所属锁 |
| G6-AC-08 | 原迁移和批准的 Main 修复专项通过；共享包装器基线限制另列 | 正式 Main run/resume 注册体 11/11，原始 idle/active 四个反例关闭；不把直接 onAbandon 回归称为共享 wrapper 全部异常路径验收 |

## 独立审查发现与处置

1. B0 初版真实 `error → exit` 同栈竞态会丢失 OOM 首错。已通过同步登记首错修复；新增真实 8 MiB Worker OOM 回归由 RED 转 PASS，独立原探针复验与 HEAD 错误文本相同。见[独立报告](evidence/b0-independent-review.md)、[修复后对照](evidence/b0-error-exit-priority-fixed.txt)。初版 25/25 证据保留，最终为 26/26。
2. B2 机械提取中间态曾误删旧仓储区块，直接加载失败。已恢复原保留函数并限定替换旧 wrapper；独立审查核对 25 个函数正文与 SQL 一致，224 组参数/错误/返回/进度/事务差分全部等价。见[独立报告](evidence/b2-independent-review.md)、[差分输出](evidence/b2-differential-probe.txt)。
3. **本轮已关闭：Main failureListener 无归属释放全局锁。** 用户于 2026-09-20 确认[最小方案](b3-lock-fix-proposal.md)后，删除该 release 并保留所属 prepare 的 finally/onAbandon。最终 Main 为 3 增 6 删，listener 其余正文精确等价；正式回归修复前 7/11、四项失败，修复后 11/11 PASS。见[RED](evidence/b3-main-lock-red.txt)、[PASS](evidence/b3-main-lock-tests.txt)及[独立末审](evidence/b3-main-lock-independent-review.md)。
4. **独立基线限制：G2 共享 prepared 包装器的准备后异常清理。** 实际 Main wrapper 的第二 Hold gate 或 Archive initialize 抛错位于 cleanup wrapper 外，会使 `onAbandon=0 / execute=0 / inFlight=true`，阻止后继请求。该行为不由本补丁引入、不破坏同 tempDir 排他性，但属于真实可用性缺口；详见同一份[独立报告](evidence/b3-main-lock-independent-review.md)。没有修改此共享框架或将其列为通过。

## manifest 判定更正与证据边界

首次交付把[旧独立 manifest 检查](evidence/manifest-check.txt)误记为 PASS；原日志实际是 `E13-G Action Manifest drift`，现明确更正。当前生成器比较当前 67 action 与已发布 v3.2.5 的 54 action 快照；完整 unit 的既有入口在历史提交复验冻结快照。

本轮直接 `--write` 会改写历史 action/策略语义，审计拒绝该结果，已按写前 SHA256 和 HEAD 恢复仅本次写入的四个文件，见[恢复记录](evidence/b3-manifest-historical-restore.json)。改用同生成器独立输出，比较 HEAD Main 与当前 Main 的当前政策产物；该证据只说明本次补丁的语义差异，不冒充仓内历史快照直接 gate 通过。[独立对照](evidence/manifest-main-differential/audit.json)已通过：三份产物字节一致，coverage 只有 Main hash 不同；145 个本地依赖指纹不变，四份仓内历史 JSON 与 HEAD 一致。两组生成与 check-only 均 PASS（402/402 surfaces），证据方式与历史 gate 明确区分。

## 完整门禁结果

首次 `UNIT_TEST_CONCURRENCY=2 npm run release-check` 已退出 1。全量 lint、smoke 通过；509 个 unit 文件共 8,158 项，8,113 通过、41 失败、4 跳过；全量 integration 因前序失败未启动。39 个失败有磁盘不足直接证据；另外 2 个 Supervisor 终态断言定向重跑 2/2 PASS，但原始 cause 未输出，不能以重跑覆盖完整门禁失败。见[旧完整日志](evidence/release-check.txt)、[逐项分类](evidence/release-failure-analysis.md)和[重跑记录](evidence/release-pending-cancel-recheck.txt)。

最终 Main 修复后完整命令 **PASS，exit 0**，见[新完整日志](evidence/release-check-after-main-fix.txt)与[结构化结果](evidence/release-check-after-main-fix-result.json)。lint、smoke PASS；510 个 unit 文件共 8,169 项，8,165 通过、0 失败、4 平台跳过；61 个 integration 脚本全部通过，汇总 2,593 项断言。E13-G 历史提交复验也在本轮 unit 中通过。完整 runner 自动更新集成清单，第七节以外规则不变。旧失败结果和过程证据保持原样。

## 集成与平台边界

G4 已确认 VCC 文件按函数职责合并：G4 负责 reader imports/预算，G6 负责 hash/lineage；当前未合入 G4。G8 配置尚不存在，本次没有伪造 active 或新增例外。没有 schema/hash/持久化版本变更，未改变 action authority 或已发布历史策略。

正式 Main 回归执行实际注册体和真实 pool/线程/SQLite；侧库业务桥接、Archive 查询、文件结算和 Electron 通知为替身。Windows 文件占用、Electron 实际 GUI 对账/取消/续跑、Excel/WPS、安装包和 release 组合验证均未执行，与本机自动证据分别记录。提交、推送、合并、开 PR、升版及发布等待后续明确指令。
