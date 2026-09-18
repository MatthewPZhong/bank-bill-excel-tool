# VCC v3.2.9 第三轮评审修复记录

后续第四轮又修复了三个问题，当前验证结果见 [第四轮修复记录](REVIEW4_FIXES.md)。本文保留第三轮的修复过程和当时证据。

日期：2026-09-18。分支：`codex/v3.2.9-vcc-fin-op-multisheet-review-export`。基线：`2ba9ef14fe972363b604955636cff0c9ac53700f`。本轮针对 [第三轮报告](evidence/review3-fixes/review3-report.md) 的一个 P1 和一个 P2，两个结论均已独立复现并修复。

相对第三轮评审快照，修改四个源码文件、一个既有测试文件，新增两个测试文件，见 [修复差异](evidence/review3-fixes/repair.patch)。保留已有功能和修复；不修改用户业务数据库、金额算法、历史审计或结果状态，不提交、推送或发布。

## P1：SST 缓存目录所有权

原实现把缺省目录解析为进程 cwd，超过共享字符串内存预算后直接向 cwd 写缓存，关闭时递归删除 cwd。通过实际 `inspectWorkbook()` 入口，在只含探针自有文件的牺牲目录中复现：64 MiB 生产预算、2,200 个各 32,000 字符的字符串、SST XML 70,435,364 bytes，预检返回说明页也会删除牺牲目录。没有在项目或用户数据目录触发危险清理。

修复分三处：

- Rich Reader 在调用方未指定目录时，为每个读取实例分配独立的随机路径；只在真实溢出时创建。所有使用该 Reader 的 VCC 预检、系统 OP、原件提取、Dataset/Review 回读及性能脚本统一获得保护。
- Provider 不再把缺省或空路径解释为 cwd；需要 spill 而未提供目录时拒绝。目录通过非递归、独占创建取得所有权，缓存文件使用 `wx+`，已有目录及同路径并发任务不能被接管。清理前核对目录和缓存文件身份，只逐个删除自己创建的文件，再删除空目录；不做递归删除。部分创建失败也按已取得的所有权清理，身份变化或未知文件导致的清理失败会保留数据，重复 `close()` 不会伪报成功。
- 旧 VCC Reader 去掉成功和失败路径中的重复递归清理，统一由 Provider 管理缓存，避免错误处理重新删除未取得所有权的目录。

原有显式任务目录、内存和 LRU 预算、`preserveOnClose`、严格关闭错误语义保持；Biz OP 的 SST 测试观察点改为单文件删除，仍验证输出文件、打开的 spool 和来源文件都保留。

修复后再次通过相同的真实 64 MiB 预检：工作目录、标记文件及原件全部保留，恰好创建一个私有 spill 目录并完成清理。[实际探针](evidence/review3-fixes/sst-preflight-probe.js) · [修复前原始记录](evidence/review3-fixes/sst-preflight-before-original.jsonl) · [修复后记录](evidence/review3-fixes/sst-preflight-after.jsonl)

## P2：历史系统 OP 错误单元格

经旧版本单 Sheet / SheetJS 解析合法导入的非计算列错误，在旧 `rawValues`、`displayValues` 中均为空；新 Reader 返回错误码。原先直接比较会把未变化的原件误判为数据不一致。

修复在只读导出清单中记录来源对应的审计合同。只有经原件身份核验的旧来源、原件确为原生错误单元格、两份旧审计均为显式空字符串时，才应用 SheetJS 的历史空值解释。附页仍通过 `rawCell()` 输出原始错误码文本，公式缓存不转成公式。

主体、币种、部门、账期和财务余额中的错误继续拒绝；原件 SHA/大小、九币种快照、业务归属和余额校验保留。非空旧审计、与空审计不符的普通文本、新版 v2 来源被清空的审计也继续失败。此兼容不写回或重新生成历史审计。

新增回归使用仍保留的旧 SheetJS 解析入口，验证 v1 原件绑定、原生错误、错误公式缓存、写入和回读，确认输出包含 `#DIV/0!` / `#N/A` 且业务库 `total_changes()`、系统快照不变。另外用 Git 基线中的实际旧解析器重复报告原探针，见 [独立探针](evidence/review3-fixes/legacy-bound-error-probe.js)、[原始失败记录](evidence/review3-fixes/legacy-error-before-original.log) 和 [本轮通过记录](evidence/review3-fixes/legacy-error-after.log)。

## 验证与交付范围

- 两个新增测试文件在未修复快照上执行：27 项中 15 通过、12 失败，包含父用例统计；在修复后全部 27 项通过。[修复前](evidence/review3-fixes/regressions-before-fix.txt) · [修复后](evidence/review3-fixes/new-regressions.txt)
- 相关专项 **240 项通过，0 失败、0 跳过**，覆盖 VCC 多 Sheet、系统 OP、Review/IPC/发布、Dataset，以及共享 SST 的 Biz OP 与平盘导入/导出。[日志](evidence/review3-fixes/targeted-tests.txt)
- 完整 `UNIT_TEST_CONCURRENCY=2 npm run release-check` **PASS，退出码 0**：lint、smoke 通过；单元 **7,378 PASS / 3 Windows skip**（7,381 项、831 个 suite、477 个测试文件）；集成 **53 个脚本 / 2,488 个断言全部通过**。[原始日志](evidence/review3-fixes/release-check.txt) · [机器摘要](evidence/review3-fixes/release-check-summary.json)
- 门禁结束后核对 [65 个相关源码、测试和脚本文件的 SHA-256 清单](evidence/review3-fixes/source-fingerprint.json)，全部一致，没有清单外源码变化。集成 runner 按既有规则自动更新 `rules/integration-test-policy.md` 的运行清单；不回滚该自动证据，也不覆盖其他任务的文档。
- Windows 安装版、Excel/WPS、完整 VCC PF01–PF05 与人工恢复演练仍未执行；本轮没有重跑专用 Electron/ASAR 探针或共享 Writer 百万行测量。64 MiB SST 预检和 Biz OP 大 SST 回归只证明各自读取/清理路径，不替代完整性能或平台验收。

## 关联功能 review

按 `.claude/skills/check-vars/SKILL.md` 对本轮修复相对第三轮快照的增删行及定义位置检查。字面命中 `SOURCE_TYPES`，但此处引用 VCC 定义，不是清单中平盘同名枚举；没有修改其定义、来源顺序或业务分类。其余修改没有命中登记变量。

共享 Provider 同时影响 VCC、Biz OP 和平盘，因此关联检查复用 `rules/important-variables.md` 中“**主库隔离与原始值不变**”及“**进度与取消真实性**”要求，覆盖原始值往返、SST 溢出、取消、读写失败、并发目录占用、部分创建、身份替换和保留模式。240 项专项和本轮完整 `release-check` 均通过，平盘侧库一致性集成检查为 38/38。业务金额、1:1 匹配、存储迁移、事务和提交门禁没有改动，不新增这些模块的人工验收结论。
