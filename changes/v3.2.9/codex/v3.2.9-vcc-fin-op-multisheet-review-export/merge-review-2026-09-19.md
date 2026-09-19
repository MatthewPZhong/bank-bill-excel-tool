# VCC 多工作表复核导出合入 release/v3.2.9

日期：2026-09-19。结论：已处理文本冲突，并修复真实归档预分配与 VCC 成员清单持久化之间的导入阻塞；最终验证结果见下表。本记录仅针对本地分支集成，不代表完整发布验收通过。

## 范围与提交边界

- 源分支 `codex/v3.2.9-vcc-fin-op-multisheet-review-export`，原 HEAD `2ba9ef14fe972363b604955636cff0c9ac53700f`。提交 179 项 VCC 实现、测试、文档及证据；另精确纳入 REVIEW3_FIXES 引用的两份 ignored 日志。源内容树 `21ebb669b177c09256d16f3240f8f117355a3da5`。
- 目标 `release/v3.2.9`，合并前 HEAD `0b36ecb6c368760237fb9756768739d0bcfad223`。候选合并、回归和导出只使用隔离副本及合成数据。
- 源工作区的 16 项无关设计资料保持未提交：账户映射原型 13 项，存档批次生命周期前置分析 3 项。源工作区保持原分支，不切换到 release。
- release 原有 18 项未提交改动逐文件保留，作为验证叠加层，不纳入合并提交；它们与本次合并没有文件重叠。
- 114 份功能文档和历史证据从 `changes/3.2.9/codex/v3.2.9-vcc-fin-op-multisheet-review-export/` 归档到本目录，内容保持原样。两个验证脚本的默认证据输出目录同步为 `changes/v3.2.9/...`。
- 最新源复审的 67 个指纹、第五轮完整门禁的 65 个实现/测试/脚本指纹均匹配；这只说明源证据对应当前源内容，不能替代本轮集成验证。

## 文本冲突与兼容性

`archive-task-policy-registry.test.js` 同时保留 release 的新入口和 VCC 待确认表导出入口：总计 271 个 IPC，reserve 71、no-file 63、exclude 134、support 3。

`rules/integration-test-policy.md` 的冲突仅是自动生成的历史执行统计。保留 release 表格；VCC 源分支自己的完整门禁仍保存在本目录的第五轮修复证据中。没有把不同运行、不同范围的统计拼成一次完整门禁。

待确认表导出继续为 `support-action / user-document-export`，不分配正式结果归档批次；正式结果导出沿用 release 的原 owner ACK、耐久 completion 和永久删除保护。一个原件的多个 VCC 来源分别建立 hold，仍在使用的来源保护共享原件；共享 Writer、SST 缓存清理及按行拆分链路通过专项验证。

## 本次发现并修复的导入阻塞

真实 `reserveFileTaskBatch()` 在创建 input artifact 时已写入 `aliasKey`、`sourceSnapshot`，有期望指纹时还写入 `expectedSha256`、`expectedSizeBytes`。源实现的 `persistInputArtifactMetadata()` 只接受空 metadata 或与 VCC 成员清单完全相等的 metadata，因此 Main `beforeStart` 中的首次成员持久化返回 `vcc-import-handoff-mismatch`，业务导入尚未开始就失败。此前用直接创建 artifact 的夹具无法覆盖这一边界。

合并提交中修复该方法：区分既有 FilePlan 身份与业务成员，首次只附加完整业务成员，保留文件身份；禁止成员请求覆盖四个身份字段；已有成员后必须整体深度相等，拒绝局部修改、扩充、缺失或版本变化；同一批文件仍在一个事务中写入和回读，后续文件失败回滚前面写入。源分支原始实现快照未改写，修复位于 release 合并提交。

新增真实预分配链路回归，不使用直接 `addArtifact` 替代预分配。修复前复现、修复后及回滚验证的日志与脚本见本轮证据目录。

## 本轮验证

结果索引：[checks.json](evidence/merge-2026-09-19/checks.json)。最终相关检查使用 Node 24.13.0。

| 检查 | 结果 |
| --- | --- |
| lint、smoke | PASS |
| 修复后相关单元测试 | 73 个文件，1,111/1,111 PASS，无失败或跳过 |
| 新增真实 FilePlan handoff 回归 | 14/14 PASS，已包含于上述 1,111 项；独立运行也通过 |
| 同一新回归在修复前候选运行 | 预期失败：首次持久化报 `vcc-import-handoff-mismatch`，两项父用例失败；原始失败日志保留 |
| 修复后 10 个集成脚本 | 共 475 项断言全部 PASS |
| Electron/ASAR 导出 | PASS；在 handoff 持久化修复前执行，所覆盖导出代码未变 |
| 两个验证脚本、持久化修复与新增测试的 ESLint；代码差异空白检查 | PASS |

10 个集成脚本包含 VCC 有效结果、调整归档链、破坏性状态链和历史模板导出，以及 Biz OP 自动错误报告、报告保留期、归档永久删除、按行拆分到永久删除、多输入拆分回读和平盘数据一致性。新增回归覆盖所有四个 FilePlan 身份键的覆盖拒绝；一个混合工作簿的两类来源分别建立 hold，永久删除预检返回 `ARCHIVE_BATCH_BUSINESS_HELD`。


Electron 验证使用 Electron 36.9.5、内嵌 Node 22.19.0、ExcelJS 4.4.0，通过 preload → IPC handler → Service → Worker 导出 2 主体、15 Sheets、14 条原表附页记录，导出后仍为 `calculated`；之后归档并成功导出两份正式结果。ASAR 模板同内容跨 inode 缓存和篡改拒绝通过。该脚本使用隔离 HTML 调用桥接 API及 stub 原生 SaveAs，不等同于完整业务 Main 或人工结果页交互验收。

## 门禁与平台边界

本轮未重跑完整 `release-check`。源分支第五轮历史完整门禁为 7,394 PASS / 3 Windows skip、53 个集成脚本 / 2,488 断言；此前 release 完整单测的 1 项 Main 子进程超时失败也保留原始记录，不能用本轮专项结果抹去。Windows 安装版、原生 SaveAs/文件占用、Excel/WPS、完整 PF01–PF05、生产冷/热启动和人工恢复未验收。

历史日志和 patch 的空白原样保留，生产代码与本次新增测试另做差异空白检查。此次仅本地提交与合并，无推送、PR、升版或发布。
