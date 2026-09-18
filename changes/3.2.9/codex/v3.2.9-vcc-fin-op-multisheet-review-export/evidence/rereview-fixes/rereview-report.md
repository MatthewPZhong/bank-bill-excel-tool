# VCC v3.2.9 再次审查

结论：上轮五项问题的原始复现路径均已修复；扩展验证发现两个 P2，其中富文本空 run 是本轮修复引入的回归。建议继续修复后再合并。

审查分支：`codex/v3.2.9-vcc-fin-op-multisheet-review-export`。HEAD 与本地 main 均为 `2ba9ef14fe972363b604955636cff0c9ac53700f`，功能仍未提交。本次使用独立快照，重点比较上轮快照后的五个源码文件及相应测试；Spec/TechDoc R3 未变。结束时原工作区 85 个修改/新增文件的 SHA-256 与快照一致，没有源码修复或真实业务库写入。

## [P2] 富文本末尾空 run 清空旧哈希核验值

位置：`src/backend/toolbox-format/xlsx-sheet-scanner.js:1254`；消费处 `src/backend/vcc-financial-op/review-export-plan.js:383–384`。

Pending 备注使用合法内联富文本 `<is><r><t>第一段</t></r><r><t/></r></is>`。原导入 Reader、Rich Reader 与独立 SheetJS 回读均得到“第一段”，五组导入均 success，计算成功且原件未变。相同样本交给上一轮 planner/extractor 能通过，本轮却报 `archive-row-integrity-failure`。

旧 `lastCollectedText()` 跳过自闭合 `<t/>`，新增词法回调却在其关闭事件把 `lastTextLexical` 改为空串，随后按空串重算历史内容哈希。需要保留旧导入对于自闭合节点的采集语义，同时保持完整原文输出，不能修改历史 hash。

对照：TechDoc §7.3 按原 hash 版本核验、§7.4 原始值与核验副本分离。

复现命令：`node rereview-text-probe.js`。

主审独立前后对照输出：`rereview-root-text-comparison.log`，`trailing_selfclosing` 显示 `previous: PASS`、当前失败。rPh 注音与 CDATA 也仍有同类历史 token 不一致，但上轮已失败，作为同一问题的补充边界，不另计 finding。

## [P2] 系统 OP 的布尔单元格被误判为原值不一致

位置：`src/backend/vcc-financial-op/review-export-plan.js:365–369`。

系统 OP 非计算审计列“OP发生额”含普通 Excel 布尔值 true 时，现有导入接受完整九币种主体，存入的 `rawValues[4]` 为 true。Review 提取除日期、文本外一律使用原始 token，得到字符串 `1`；`validateRawFact()` 再比较 `String(true)` 和 `1`，报 `vcc-review-validation-failed: S:1:2 原始列 5 不符`，整次导出中止。

应按系统 OP 导入的布尔语义核验，并保持输出的布尔类型。该问题属于本轮新增发现，未声称由本轮修复引入。

对照：TechDoc §8.3.1 明确保留原件布尔类型和值；Spec §3.6/RV09。

复现命令：`node --test tests/unit/main-process/rereview-system-boolean.test.js`。主审独立输出 `rereview-root-boolean.log`：1 个测试失败，导入成功，提取失败。

## 上轮问题复核

| 上轮问题 | 本轮结果 |
| --- | --- |
| CRLF 文本哈希不一致 | 原 CRLF 及 str/shared/inline 回归通过；另发现上述空 run 回归 |
| OOXML t=d 日期无法导入 | 原探针通过，新旧完整快照及 rawValues 对照通过 |
| 第 221 行系统 OP 表头被拒绝 | 原探针通过，混合类型导入成功 |
| 第 222 行明细表头无法重建导出 | 原探针通过，raw/check 都导出 1 行 |
| NULL 来源关联绕过原件校验 | 原探针现在抛 vcc-review-source-unavailable；真正历史来源回归通过 |

## 验证与边界

- 主审执行 Review 导出、IPC、target、dataset writer 相关四个测试文件：39/39 通过，日志 `rereview-root-tests.log`。
- 子审执行系统导入、多 Sheet 及上轮两条独立导入探针：44/44 通过。
- 文本相关两文件：18/18 通过，与主审 Review 测试有重合，不重复累加。
- 主审独立复跑两个新发现的探针，均确认；旧 dataset/header 与来源关系探针也独立复跑。
- 核对修复记录的 60 个源文件/测试/脚本指纹：全部吻合；保存的 release-check 原始日志 SHA-256 与摘要吻合。这是对已有证据的核对，本次没有重新运行完整 release-check。
- 原工作区 `git diff --check` 通过，85 个审查文件内容未变。
- 未执行 Windows 安装版、Excel/WPS 人工验收、完整 PF01–PF05 或人工恢复演练；不以专项自动化替代这些验收。
