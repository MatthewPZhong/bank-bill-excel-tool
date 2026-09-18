# VCC v3.2.9 再次审查 — 2026-09-18

结论：上次 **2 个 P2、1 个 P3 的原复现均已关闭**；扩展复审确认另有 **1 个 P2：系统 OP 读取结束后收到取消，仍提交尚未写入的快照**。建议修复后再合并。该取消问题在第四轮修复前也存在，不是本次修复引入的回归。

## 审查范围

- 分支：`codex/v3.2.9-vcc-fin-op-multisheet-review-export`；HEAD / 本地 main 均为 `2ba9ef14fe972363b604955636cff0c9ac53700f`，功能仍在未提交工作区。
- 对照 [Spec R3](v3.2.9_VCC_Spec.md)、[TechDoc R3](v3.2.9_VCC_TechDoc.md)、[上次审查](review-2026-09-18.md) 和 [第四轮修复记录](REVIEW4_FIXES.md)。Spec / TechDoc 未变。
- 本次快照：`/private/tmp/vcc329-rereview-r3v4hp8h`；上次快照：`/private/tmp/vcc329-review-20260918-4enb6g65`。
- 相比上次，仅两个源码文件有变化：`review-export-plan.js`、`system-op-importer.js`；三个测试文件有变化：`multisheet-import.test.js`、`vcc-financial-op-review-ipc.test.js`、`vcc-financial-op-review-legacy-error.test.js`。其余变化为修复文档和门禁证据。
- 复审集中检查主体识别、原值核验、历史来源、读取计数及相邻取消边界。没有修改实现或操作真实业务数据库；只新增本报告及证据。原工作区 2,512 个快照文件在审查期间未变。

## [P2] Reader 关闭期间收到取消后，系统 OP 仍开始事务并提交

位置：[system-op-importer.js:879](../../../../src/backend/vcc-financial-op/system-op-importer.js#L879)，范围 879–881 行。

`importSystemOpWorkbookGroup()` 在读取、解析完成后执行 `await workbook.close()`。关闭过程会让出事件循环，取消可能在此时送达；恢复执行后没有重新检查 `options.shouldCancel()`，直接调用同步 `importSystemOpGroup()`。后者不处理取消，因此仍开启业务事务、写入有效快照；如果系统 OP 是最后一个类型组，整个导入返回 `success`。

复现输入为一个含完整九币种主体的系统 OP Sheet。在最后一次 `reading` 进度后通过 `setImmediate` 异步设置取消标志，使用真实 Reader、真实资源关闭和 SQLite，仅包装入口记录事件，没有人为延迟关闭或替换扫描/提交实现。主审独立复跑确认：

```text
last-reading      cancelled=false  snapshots=0
close-start       cancelled=false  snapshots=0
cancel-delivered  cancelled=true   snapshots=0
close-complete    cancelled=true   snapshots=0
BEGIN IMMEDIATE   cancelled=true   snapshots=0
complete          cancelled=true   snapshots=1
```

实际返回 `status=success`、`insertedCount=1`。此时取消已经生效，当前有效快照事务尚未开始，不能按“已提交数据保留”解释。该探针模拟 Worker 事件循环接收取消后的标志变化，未声称执行了人工 UI 点击或真实 Worker IPC 投递。

对照：Spec §2.4 IE07 / AC09 要求取消时停止未提交及尚未执行的工作，并准确保留既有提交范围。建议在资源关闭后、进入同步系统 OP 提交前复核取消，并沿用现有 `vcc-import-cancelled` 和 `partialCommitted` 收口；已经完成的其他类型组应继续保留。

证据：

- [异步关闭取消探针](evidence/review-2026-09-18-rereview/import-async-close-cancel-probe.js)
- [主审独立复跑输出](evidence/review-2026-09-18-rereview/root-import-async-close-cancel.txt)：期望快照数 0，实际 1，断言失败。
- [第四轮修复前对照输出](evidence/review-2026-09-18-rereview/import-async-close-cancel-before-review4.txt)：同一窗口也成立，确认缺陷此前已存在。
- [中段取消与读取进度探针](evidence/review-2026-09-18-rereview/import-progress-cancel-probe.js)、[独立输出](evidence/review-2026-09-18-rereview/root-import-progress-cancel.txt)：第 512 行取消正常终止、快照数 0；1,026 行完整读取按 `[512, 1024, 1026]` 上报。失败集中在末端取消窗口。

## 上次三个问题复核

| 上次问题 | 本次结果 |
| --- | --- |
| 系统 OP 数值主体 `123`、显示 `000123` 导出失败 | 原样本真实 handler → Service → Worker 导出成功，8 张 Sheet、7 条附页记录；回归测试同时检查数值 123、格式 `000000` 和显示 `000123` 保留 |
| 主体 `CNH` 被当作币种归一为 `CNY` | 原样本导出成功；当前回归同时覆盖 `CNH` 与 `CNY` 两个主体，未合并或漏行 |
| 9 行失败系统 OP 加 1 行充值仅统计 1 行 | 原样本现在统计 10 行，系统组仍为 `failed_validation`、充值成功，批次仍为 `completed_with_errors` |

本次执行的原复现日志：[导出](evidence/review-2026-09-18-rereview/original-export-cases.txt)、[导入计数](evidence/review-2026-09-18-rereview/original-import-case.txt)。导出后结果仍为 `calculated`。

主体修复仍独立检查原始值；错误审计、原件哈希破坏、错误计算字段仍会拒绝导出。旧来源布尔显示兼容通过显式 `legacySheetJsDisplay` 启用，没有改变当前导入默认语义。

## 本次验证与验收边界

- 六个相关测试文件 **98 PASS / 0 FAIL / 0 SKIP**：[原始日志](evidence/review-2026-09-18-rereview/focused-tests.txt)。覆盖多 Sheet、系统 OP、Review IPC、历史原值、导出和输出目标。
- 另外六个完整 prepare → extract → write → validate 导出样本全部通过：零值主体、负数格式主体、公式缓存主体、当前布尔主体、账期原值兜底、未绑定历史来源。检查附页数量、原类型/格式、公式剥离及业务库无写入。见 [探针](evidence/review-2026-09-18-rereview/export-boundary-rereview.js)、[日志](evidence/review-2026-09-18-rereview/export-boundary-rereview.txt)。
- 新取消探针的失败属于本轮缺陷证据，不计入上述 PASS 数。
- 对第四轮完整门禁记录核对了 65 个源码/测试/脚本指纹，全部与当前实现一致；指纹文件和门禁日志 SHA-256 均与摘要一致。已有记录为单元 7,389 PASS / 3 Windows skip、53 个集成脚本 / 2,488 个断言通过。**本次未重新运行完整 release-check**。
- 本次没有重跑专用 Electron/ASAR 探针；上次真实 Electron 结果属于修复前证据。Windows 安装版、原生 SaveAs/占用、Excel/WPS、完整 PF01–PF05、生产完整冷/热启动和人工恢复仍未验收，不能据此宣称整版可发布。
- `git diff --check` 通过；无源码修复、提交或推送。来源指纹、范围和结果见 [review-summary.json](evidence/review-2026-09-18-rereview/review-summary.json)。

本次相关测试命令，在隔离快照中执行：

```sh
GIT_DIR=/Users/pzhong/Desktop/Project/bank-bill-excel-tool/.git node --test --test-concurrency=2 \
  tests/unit/backend/vcc-financial-op/multisheet-import.test.js \
  tests/unit/backend/vcc-financial-op/system-op-importer.test.js \
  tests/unit/main-process/vcc-financial-op-review-ipc.test.js \
  tests/unit/main-process/vcc-financial-op-review-legacy-error.test.js \
  tests/unit/main-process/vcc-financial-op-review-export.test.js \
  tests/unit/main-process/vcc-financial-op-review-target.test.js
```

取消问题可从项目根目录执行以下探针，仅创建临时输入与测试数据库；当前实现会因“应为 0、实际 1 个快照”而退出失败：

```sh
node --test changes/3.2.9/codex/v3.2.9-vcc-fin-op-multisheet-review-export/evidence/review-2026-09-18-rereview/import-async-close-cancel-probe.js
```
