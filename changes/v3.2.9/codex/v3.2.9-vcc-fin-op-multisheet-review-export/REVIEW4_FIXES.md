# VCC v3.2.9 — 2026-09-18 第四轮评审修复

后续第五轮修复了系统 OP 末端取消问题，当前验证结果见 [第五轮修复记录](REVIEW5_FIXES.md)。本文保留第四轮的修复过程和当时证据。

针对 [2026-09-18 审查报告](review-2026-09-18.md) 的两个 P2 和一个 P3。三个问题均已独立复现并修复。分支仍为 `codex/v3.2.9-vcc-fin-op-multisheet-review-export`，HEAD 保持 `2ba9ef14fe972363b604955636cff0c9ac53700f`；工作区未提交、未推送、未发布。

本轮只修改两个源码文件和三个既有测试文件，见 [修复差异](evidence/review4-fixes/repair.patch)。修复前已核对第三轮门禁的 65 个文件指纹全部匹配；不覆盖其他功能的文档或已有改动。探针与测试仅使用临时工作簿和测试数据库。

## 修复内容

| 问题 | 修复 | 验证 |
| --- | --- | --- |
| 系统 OP 显示主体 `000123` 与原始数值 `123` 被误判不同 | 归属核验复用 `systemOpCellValues()` 的显示值解释，主体、部门、币种和账期与导入保持一致；账期仍按显示值优先、原值兜底。原始值逐列核验和 Writer 输出保持独立 | 真实 IPC → Service → Worker 导出成功；附页仍为数值 `123`、格式 `000000`、显示 `000123`，不改成主体文本。部门/币种使用自定义显示格式也通过 |
| 明细主体 `CNH` 被套用币种兼容而变成 `CNY` | 主体直接比较，只对统计币种、Pending 币种和流水币种执行历史币种兼容 | 同一结果同时存在 `CNH`、`CNY` 主体时分别导出，两个主体、15 张 Sheet、14 条附页记录，无合并或丢行 |
| 系统 OP 校验失败导致已扫描行数丢失 | Reader 在扫描阶段独立累计有效数据行，每 512 行上报进度，退出扫描时补报当前数量；调用方按“此前累计量 + 当前 Sheet 已读量”更新，业务解析失败和整组回滚不丢计数、不重复累计 | 9 条上月系统 OP + 1 条充值返回 `readRowCount=10`，保留系统组失败和充值成功；跨文件三张系统 OP Sheet + 充值统计 28 行；扫描中断只统计已完成的 4 行 |

为保证第一项的历史兼容，旧 `sheetjs-v1` 来源的布尔显示值继续使用旧 SheetJS 的 `TRUE/FALSE` 表示；当前导入默认显示规则不变。v1 数值格式主体和布尔主体均按原类型导出。历史错误值兼容、九币种快照、余额原始 token、原件 SHA/大小、行身份及内容哈希仍执行原核验。

读取计数调整不改变业务提交边界：系统 OP 有硬校验错误时，已解析的合法快照仍按原规则整组回滚。测试同时断言 `failed_validation`、`rolledBackCount` 和实际入库数量，未把读取进度当作导入成功数量。

## 回归与证据

- 报告原始探针复跑确认：两个合法主体场景均导出失败、旧目标不变；错误系统 OP Sheet 被漏计，汇总为 1 行。[导出修复前](evidence/review4-fixes/export-probe-before.txt) · [导入修复前](evidence/review4-fixes/import-probe-before.txt)
- 新增回归在未修复源码上 **11 项失败**，包括父用例统计；修复后的三个受改动测试文件 **37 项全部通过**。[失败记录](evidence/review4-fixes/regressions-before-fix.txt) · [通过记录](evidence/review4-fixes/changed-test-files.txt)
- 相关专项 **178 项通过、0 失败、0 跳过**，覆盖导入、系统 OP、mapper、共享投影、Review 导出、历史数据、真实 IPC、目标发布和 Dataset Writer。[日志](evidence/review4-fixes/targeted-tests.txt)
- 真实 IPC 回归对业务库启用禁止 DML 的触发器，并对比快照、`total_changes()` 和 `calculated` 状态；错误原始审计仍阻断发布，已有目标字节保留。
- 报告探针的成功版副本已独立执行通过：[导出探针](evidence/review4-fixes/export-subject-probe-after.js) 的两个主体场景各生成 8 张 Sheet、7 条附页记录，结果仍为 `calculated`；[读取计数探针](evidence/review4-fixes/import-read-count-probe-after.js) 返回 10 行，保留原有部分组成功状态。[导出日志](evidence/review4-fixes/export-probe-after.txt) · [读取计数日志](evidence/review4-fixes/import-probe-after.txt)。原审查报告及原失败断言探针不修改。
- 完整 `UNIT_TEST_CONCURRENCY=2 npm run release-check` **PASS，退出码 0**：lint、smoke 通过；单元 **7,389 PASS / 3 Windows skip**（共 7,392 项、831 个 suite、477 个测试文件）；集成 **53 个脚本 / 2,488 个断言全部通过**。[原始日志](evidence/review4-fixes/release-check.txt) · [机器摘要](evidence/review4-fixes/release-check-summary.json)
- 门禁结束后核对 65 个相关源码、测试和脚本文件的 [SHA-256 指纹](evidence/review4-fixes/source-fingerprint.json)，全部一致，没有清单外源码变化；`git diff --check` 通过。集成 runner 按既有规则更新 `rules/integration-test-policy.md` 的运行清单，保留该自动证据。

本轮未执行 Windows/reparse、原生 SaveAs/文件占用、Excel/WPS 人工对照、完整 PF01–PF05、完整生产冷/热启动和人工备份恢复，也未重跑专用 Electron/ASAR 探针。报告中的真实 Electron 记录属于修复前审查证据，不能表述为本轮改动后的实机验收。

## 关联功能 review

按 `.claude/skills/check-vars/SKILL.md` 比对本轮增删行和定义位置。字面命中 `SOURCE_TYPES`，但这里是 VCC 枚举，与清单登记的平盘同名变量不同，未改变任何来源枚举或顺序；其他修改未命中登记变量。

关联核查覆盖系统 OP 的新旧解析、原值保真、币种兼容、多 Sheet 读取计数、组级回滚、Dataset 原表重建及待确认导出，178 项专项和本轮完整项目门禁均通过。资金算法、来源成员身份、存储合同、任务互斥、取消/发布流程和旧 SST 修复均未改动；不新增平台或人工验收结论。
