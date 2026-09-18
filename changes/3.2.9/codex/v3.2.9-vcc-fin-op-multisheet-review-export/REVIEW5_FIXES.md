# VCC v3.2.9 — 第五轮复审修复

完成验证：2026-09-19（Asia/Shanghai）。

针对 [2026-09-18 再次审查报告](review-2026-09-18-rereview.md) 的一个 P2。已独立复现并修复：系统 OP 读取完成、Reader 正在异步关闭时收到取消，原实现仍会提交尚未写入的快照。上一轮的三个问题保持关闭。

分支为 `codex/v3.2.9-vcc-fin-op-multisheet-review-export`，HEAD 仍为 `2ba9ef14fe972363b604955636cff0c9ac53700f`。修复前核对第四轮门禁的 65 个相关文件指纹，全部匹配。本轮只修改 `system-op-importer.js` 和既有 `multisheet-import.test.js`；见 [本轮差异](evidence/review5-fixes/repair.patch)。没有提交、推送、发布或操作用户业务数据库。

## 问题与修复

原代码在 `await workbook.close()` 恢复后，直接继续读取下一个文件或调用同步提交函数。关闭期间事件循环已经接收到取消，业务事务却尚未开始，不能把随后写入的快照解释为已提交数据。

现在每个系统 OP 工作簿完成关闭后，立即复用既有 `throwIfCancelled()` 检查。取消已生效时抛出 `vcc-import-cancelled`，由 Import Service 沿既有路径收口：

- 当前尚未提交的系统 OP 快照不进入有效数据集，也不生成快照提交尝试。
- 不再打开后续系统 OP 文件，不再执行后续类型组。
- 已成功提交的其他类型数据保留，`partialCommitted` 如实返回。
- Reader 的真实关闭先完成；关闭失败仍按原规则传播，不用取消状态掩盖清理错误。

同步提交前没有新增异步等待。旧单 Sheet 同步路径、金额算法、事务边界、来源 hold、存储合同及取消信号传递方式均未修改。

## 复现与回归

报告原始探针在修复前独立复跑失败：取消在 `close-start` 与 `close-complete` 之间送达，最终返回 `success`、写入 1 个快照。修复后相同探针通过，返回 `vcc-import-cancelled`，有效快照为 0。[修复前日志](evidence/review5-fixes/cancel-probe-before.txt) · [修复后日志](evidence/review5-fixes/cancel-probe-after.txt)

修复后日志仍可见取消后的 `BEGIN IMMEDIATE`，这是 `failImportBatch()` 更新失败记录的收口事务；不是系统快照提交事务。系统快照与快照尝试均未写入，取消结果不能描述为整个业务库完全无 DML。

新增回归使用真实 XLSX Reader、真实异步关闭和 SQLite；只包装读取入口记录事件，不延迟关闭、不替换扫描或提交实现。覆盖：

1. 仅系统 OP：关闭期间异步取消，当前快照为 0，`partialCommitted=false`。
2. 充值已提交、系统 OP 取消、通道未执行：充值记录逐字段保持，系统快照为 0，`partialCommitted=true`，后续通道不读取。
3. 两个系统 OP 文件：第一个关闭期间取消，第二个不再打开。
4. 最后一次读取进度同步取消：仍先完成 Reader 关闭，再返回取消错误。

这 4 个场景在未修复源码上共 **5 项失败**（包含父用例统计）；修复后受改动测试文件 **15 项全部通过**。[失败记录](evidence/review5-fixes/regressions-before-fix.txt) · [通过记录](evidence/review5-fixes/multisheet-regressions.txt)

报告的相邻进度/取消探针也已复跑通过：1,026 行按 `[512, 1024, 1026]` 上报；第 512 行取消和末端取消均不写入快照。[探针日志](evidence/review5-fixes/progress-cancel-probe-after.txt)

10 个关联测试文件 **178 PASS / 0 FAIL / 0 SKIP**，覆盖多 Sheet、系统 OP、普通明细、Service、写 Worker、来源绑定、Review IPC、历史原值和输出目标。[专项日志](evidence/review5-fixes/targeted-tests.txt)

## 工程门禁与边界

完整 `UNIT_TEST_CONCURRENCY=2 npm run release-check` **PASS，退出码 0**：lint、smoke 通过；单元 **7,394 PASS / 3 Windows skip**（共 7,397 项、831 个 suite、477 个测试文件）；集成 **53 个脚本 / 2,488 项断言全部通过**。[完整日志](evidence/review5-fixes/release-check.txt) · [机器摘要](evidence/review5-fixes/release-check-summary.json)

门禁后复核 [65 个相关源码、测试和脚本文件的 SHA-256](evidence/review5-fixes/source-fingerprint.json)，全部一致，没有清单外源码变化；`git diff --check` 通过。集成 runner 按既有规则更新 `rules/integration-test-policy.md`，保留其本轮运行记录。单元约 733 秒、集成约 489 秒，均为本次实际执行结果。

按 `.claude/skills/check-vars/SKILL.md` 核查本轮增删行与 `rules/important-variables.md`：`throwIfCancelled`、`shouldCancel`、取消错误码及 `partialCommitted` 未命中登记变量，也未修改其定义。关联回归检查读取/关闭时序、当前组写入、前组保留、后续工作停止及失败收口。

本轮取消复现是在实际异步事件循环中设置取消标志；未宣称执行了人工 UI 点击或真实 Worker IPC 取消投递。未重跑专用 Electron/ASAR 探针；Windows 安装版、原生另存为/文件占用、Excel/WPS、完整 PF01–PF05、生产冷/热启动和人工恢复仍未验收。
