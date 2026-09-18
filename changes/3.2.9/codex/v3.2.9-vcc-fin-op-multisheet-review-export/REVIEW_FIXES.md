# VCC v3.2.9 评审修复记录

日期：2026-09-18。分支：`codex/v3.2.9-vcc-fin-op-multisheet-review-export`。基线：`2ba9ef14fe972363b604955636cff0c9ac53700f`。

本文保留首次评审修复及当时验证结果。后续复审新增问题的修复与最新验证见 [复审修复记录](REREVIEW_FIXES.md)。

本次依据 [原评审报告](evidence/review-fixes/review-report.md) 修复五项 P2，保留既有未提交功能。源码共涉及五个文件；没有改金额算法、数据库状态、存储版本、历史内容哈希或原始文件。

## 修复与回归

| 原报告 | 修复 | 本次验证 |
| --- | --- | --- |
| 1. Pending CRLF 备注误报原件损坏 | 同一次 Sheet 扫描保留 XML 实体解码后的原始 token，按原导入解析规则重建哈希核验值；导出继续使用完整语义文本 | str、共享字符串、内联字符串三种编码均覆盖 CRLF、字面 `_x000d_`、XML 特殊字符；最终 XLSX 用 SheetJS 独立回读并比对手写预期，数据库 ID/哈希/版本不变 |
| 2. 系统 OP 的 `t="d"` 日期失效 | 按既有 SheetJS `cellDates:false` 合同逐格转换 raw/display，不把日期分量对象写入 rawMatrix；Review 重建复用该日期转换 | 旧、新 Reader 的完整快照哈希及 rawValues 相同，九币种正常导入；日期型原件可继续生成待确认附页并保留 ISO 原值 |
| 3. 系统 OP 提交重套前 220 行限制 | 提交在全 Sheet 读取中验证预检 headerRow 和唯一正式表头，直接使用实际定位；旧单表 Reader 入口不变 | 系统 OP 表头第 221 行的混合工作簿，各类型均提交成功，无误过滤或意外部分成功 |
| 4. 原表重建漏传表头定位 | 从持久 artifact 验证成员的 Sheet、结构版本、顺序及 headerRow，明细与系统原表重建共同使用 | 充值表头第 222 行、系统表头第 221 行时，原表/校验表四种输出均成功；篡改持久 headerRow 后拒绝重建，不回退猜测 |
| 5. NULL 来源 ID 绕过原件校验 | 在认定 legacy/fallback 前检查同一导入审计的来源记录、hold，以及已有存档证据的 artifact 成员；不能仅按 NULL ID 降级 | NULL 外键、清空绑定字段、删除来源但保留 artifact 证据均拒绝；真正没有绑定的历史系统快照和 Pending 48/46 列 fallback 仍通过 |

文本解析器增加的是可选、同步的 `onCellLexical` 审计回调，不改变既有 ToolboxCell 的语义值。回调只保留当前行所需的校验值，不增加第二次业务扫描，不生成百万行数组。

来源检查和重建均只读；不能通过导出修复来源关系、按文件名换绑或用 fallback 隐藏已绑定原件损坏。没有打开或修改用户业务数据库，测试均使用临时 SQLite/XLSX。

## 实现位置

- [共享 XML 扫描器](../../../../src/backend/toolbox-format/xlsx-sheet-scanner.js) 与 [Rich Reader](../../../../src/backend/xlsx-rich-reader.js)：可选词法审计回调。
- [系统 OP Importer](../../../../src/backend/vcc-financial-op/system-op-importer.js)：日期合同与显式表头定位。
- [Review Planner](../../../../src/backend/vcc-financial-op/review-export-plan.js)：原哈希重建、日期核验与历史来源证据检查。
- [数据管理 Writer](../../../../src/main-process/vcc-financial-op-dataset-writer.js)：验证并传递持久 Sheet 成员。

## 本次检查

- 相关专项：**144 项通过，0 失败、0 跳过**，覆盖系统导入、明细多 Sheet、原表重建、Review 全链路、IPC/目标发布与共享 XML 解析器。见 [原始输出](evidence/review-fixes/targeted-tests.txt)。
- 修复前后对照：将最终两组回归文件和 fixture 放入独立临时测试目录，只读引用原评审快照的源码，22 项中 12 通过、10 失败（含父级用例统计），能触发本轮修复的问题；同一批用例在当前代码通过。见 [修复前原始输出](evidence/review-fixes/regressions-before-fix.txt)。
- 当前候选的 60 个源文件/测试/脚本指纹：[清单](evidence/review-fixes/source-fingerprint.json)。门禁结束后逐一核对一致，无清单外的源码、测试或脚本变更。
- 完整工程门禁：`UNIT_TEST_CONCURRENCY=2 npm run release-check` **通过，退出码 0**。lint、smoke 通过；单元 7,337 通过、0 失败、3 项 Windows 专用跳过（共 7,340 项）；53 个集成脚本、2,488 项断言全部通过。见 [结果摘要](evidence/review-fixes/release-check-summary.json) 和 [完整输出](evidence/review-fixes/release-check.txt)。
- `git diff --check` 通过。

以上专项计数与全量门禁存在重合，不相加作为独立测试总数。此前实施记录的 Electron/ASAR、百万行组件测量与 7,325 项单元门禁是修复前证据，本次未将其冒称为新执行结果。

## 关联功能 review

本轮按项目 check-vars 规则命中 Risk-sensitive 的 `vcc_fin_op_import_sources` 审计血缘项。规则原文：

> v1 source 只允许按持久 artifactId 直查，并复核 artifact 所属 batch.taskRunId/sourceOperation/SHA/size；不得仅凭 path、metadata、文件名或 ordinal 换绑；只有 null-ID 历史 v0 可走命名 legacy 兼容

本轮校验使用持久 artifactId、原导入审计和验证过的成员；NULL ID 只有在不存在其他绑定证据且历史原值完整可验时才走 legacy。额外扫描命中的 `SOURCE_TYPES` 是 VCC 本地枚举，与注册表中 Position 模块的同名符号无关；未修改 Position 枚举或逻辑。

本轮未改 schema/guard、启动恢复或 hold 释放机制；相关自动回归由本次工程门禁覆盖。Windows 安装版、Excel/WPS 人工核对、完整 PF01–PF05 和人工恢复演练仍未执行。未提交、推送或发布。
