# VCC v3.2.9 复审修复记录

日期：2026-09-18。分支：`codex/v3.2.9-vcc-fin-op-multisheet-review-export`。基线：`2ba9ef14fe972363b604955636cff0c9ac53700f`。

后续第三轮评审与修复见 [REVIEW3_FIXES.md](REVIEW3_FIXES.md)。本文 PASS 和指纹保留为第二轮候选证据，不代表后续修改后的完整门禁结果。

本轮修复 [复审报告](evidence/rereview-fixes/rereview-report.md) 的两个 P2。相对于复审快照，仅修改两个源码文件和两个测试文件；保留此前功能及修复，不修改历史哈希、金额算法、存储合同或用户业务数据库。

## 修复

| 问题 | 修复方式 | 回归结果 |
| --- | --- | --- |
| 富文本末尾自闭合空 run 导致历史哈希不一致 | 在同一次工作表扫描中保留当前 cell 的原始 XML body，直接交给既有 `cellValueFromBody()`；删除从 SAX 文本事件推测旧 token 的逻辑。附页仍使用完整语义文本 | 自闭合空 run、显式空 run、多段文本、注音、CDATA、CDATA 实体字面值和 XML 注释均可导出；历史 ID、哈希及 hash 版本不变 |
| 系统 OP 布尔原值被当成字符串 `1` / `0` 比较 | 系统 OP 全列核验统一复用导入时的 `systemOpCellValues()`，保留 number / boolean / date / text 的原类型语义；Writer 继续使用原件单元格类型 | 普通 TRUE/FALSE 及布尔公式缓存均通过；附页回读为布尔类型且没有生成公式，系统快照不变 |

词法审计仅在明细来源提取时启用，沿用原明细 Reader 的 UTF-8 编码。窗口只保留当前未结束的 cell 和读取块，不收集整个 Sheet；单 cell 原始 XML 设有 16,777,216 个 UTF-16 code unit 的明确预算，超限报错，不静默截断。系统 OP 和未启用审计的共享 Reader 路径继续使用原来的解析流程。

实现及测试见 [修复差异](evidence/rereview-fixes/repair.patch)：

- [共享 Sheet Scanner](../../../../src/backend/toolbox-format/xlsx-sheet-scanner.js)：提供同次扫描的原始 body，保持语义读取不变。
- [Review Planner](../../../../src/backend/vcc-financial-op/review-export-plan.js)：复用原导入取值与系统 OP 类型转换。
- [Review 导出回归](../../../../tests/unit/main-process/vcc-financial-op-review-export.test.js)：实际导入、计算、提取、写入、回读及无业务 DML 验证。
- [Scanner 边界回归](../../../../tests/unit/toolbox-format-xlsx-structure.test.js)：1 / 5 / 64 字节及整块输入，覆盖 BOM、中文、代理对、XML 特殊文本和空 cell。

## 验证

- 修复前新增业务回归：9 项中 2 通过、7 失败（包含父级用例统计），复现两项报告问题及扩展文本边界。[原始输出](evidence/rereview-fixes/regressions-before-fix.txt)
- 修复后相关专项：**168 项通过，0 失败、0 跳过**。覆盖多 Sheet 导入、系统 OP、待确认表、数据管理原表、IPC、目标发布、共享 Scanner 与旧 Reader 四方合同。[原始输出](evidence/rereview-fixes/targeted-tests.txt)
- 导出测试验证每个原件仅扫描一次、数据库 `total_changes()` 不变、历史哈希和系统快照不变；使用 SheetJS 独立检查生成文件的原文和布尔类型。
- 当前候选的 61 个源码、测试和脚本文件已记录 [指纹](evidence/rereview-fixes/source-fingerprint.json)。门禁结束后逐一核对一致，无清单外源码、测试或脚本变更。本轮相对复审快照的修复范围为其中 4 个文件。
- 完整 `UNIT_TEST_CONCURRENCY=2 npm run release-check`：**通过，退出码 0**。lint、smoke 通过；单元 7,351 通过、0 失败、3 项 Windows 专用跳过（共 7,354 项）；53 个集成脚本、2,488 项断言全部通过。见 [结果摘要](evidence/rereview-fixes/release-check-summary.json) 和 [完整日志](evidence/rereview-fixes/release-check.txt)。
- `git diff --check` 通过。

专项计数与完整门禁有重合，不相加作为独立测试总数。原有 [首次修复记录](REVIEW_FIXES.md) 与 [首次实施记录](IMPLEMENTATION_REPORT.md) 的日志、指纹及数字保留为历史证据，不能代替本轮验证。

## 关联检查与边界

按项目 check-vars 规则只扫描本轮源码差异：未命中实际的 Critical / Important / Runtime-state / Risk-sensitive 注册变量。文本匹配的 `SOURCE_TYPES` 属于 VCC 本地枚举，注册表同名项属于 Position 模块；`undefined`、`let`、`includes` 是说明文字或语言标识，不属于被修改的注册变量。

关联路径已覆盖旧明细读取、共享 XML 解析、系统 OP 类型、待确认表写入及回读。没有修改导入合同、持久来源绑定、schema/guard 或正式模板。

Windows 安装版、Excel/WPS 人工核对、完整 PF01–PF05 与人工恢复演练仍待执行；本轮未重跑专用 Electron/ASAR 探针和原有共享 Writer 百万行测量。未提交、推送或发布。
