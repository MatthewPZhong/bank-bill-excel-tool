# VCC 多 Sheet 导入及待确认导出：第三次 Review

结论：上轮两个 P2 的原复现路径已关闭，但本轮确认另有 **1 个 P1、1 个 P2**，暂不建议合并。

## 审查边界

- 分支：`codex/v3.2.9-vcc-fin-op-multisheet-review-export`。
- HEAD / 本地 main：`2ba9ef14fe972363b604955636cff0c9ac53700f`。功能仍位于未提交工作区；审查包含相关 tracked 修改和 untracked 文件。
- 隔离快照：`/private/tmp/vcc-review3-20260918-03pkhge6`，记录 97 个覆盖文件的 SHA-256。
- 相对第二轮：18 个文件有变化；业务源码只变动 `xlsx-sheet-scanner.js`、`review-export-plan.js`。Spec / TechDoc 未变化。新出现的 `changes/archive-batch-lifecycle/` 文档不纳入本功能评审。
- 核对了本分支 `v3.2.9_VCC_Spec.md`、`v3.2.9_VCC_TechDoc.md`、`REREVIEW_FIXES.md` 及修复测试记录。
- 本轮未修改原工作区，未操作真实业务数据库，未提交、推送或修复。收尾复核 97 个原文件哈希均与快照一致，`git diff --check` 通过。

## P1：VCC 预检未提供 SST 临时目录，溢出缓存关闭时递归删除 cwd

位置：`src/backend/vcc-financial-op/workbook-import-plan.js:74-77`。

`inspectWorkbook()` 调用 `openRichWorkbook()` 时只指定 64 MiB 内存预算，没有传 `sstTempRoot`。共享 Reader 将该缺省值传给 `AdaptiveSharedStringsProvider`；后者通过 `path.resolve(String(tempRoot || ''))` 将缺省目录解析为进程 cwd。共享字符串超过预算后，缓存直接写入 cwd 的 `sst.bin` / `sst.idx`，`close()` 又执行 `rm(tempRoot, {recursive:true, force:true})`。

因此，用户选择较大共享字符串表进行预检，就可能删除工作目录下的无关文件。预检无需识别为业务 Sheet，无需确认导入。底层 Provider 的缺省行为在基线已存在，但本分支新增 VCC 调用缺少既有 Biz OP 调用提供的独立临时目录，首次将此路径接入 VCC。系统 OP 导入、Review 原件提取、Dataset 和 Review 回读也有同样缺参调用，应一并审查。

安全复现使用专门新建且仅含探针自有文件的临时 cwd，输入工作簿放在该 cwd 之外。没有在用户项目目录、业务数据目录或源码快照目录运行危险清理：

- 实际预算：67,108,864 bytes，没有降低生产阈值。
- 2,200 个各 32,000 字符的合法共享字符串；SST XML 70,435,364 bytes。
- Reader 成功扫描 2,200 行，`mode=disk`，spill root 等于牺牲 cwd。
- `close()` 后该 cwd 及标记文件均不存在。
- 主 Agent 再通过实际 `inspectWorkbook()` 入口验证：返回 `unrecognized` / 2,200 行，同时 cwd 和标记文件消失，外置输入文件仍在。

证据：

- [Reader 探针](review3-sst-cwd-probe.js)、[Reader 输出](review3-sst-cwd-probe-output.jsonl)
- [实际预检入口探针](review3-sst-preflight-probe.js)、[预检输出](review3-sst-preflight-probe-output.jsonl)

修复方向：每个读取任务持有独立、明确创建的 SST 临时目录，清理仅作用于该目录；共享层应拒绝缺失的临时目录，避免将 cwd 当作可删除目录。

## P2：历史合法系统 OP 错误单元格被误判为原始数据不一致

位置：`src/backend/vcc-financial-op/review-export-plan.js:308-311`，取值调用在第 369 行。

对于基线版本合法导入、已有 v1 原件绑定的系统 OP，在非计算列 `OP发生额` 中出现 `#DIV/0!` 错误单元格时，旧 `sheet_to_json(..., defval:'')` 在审计 `rawValues` / `displayValues` 中保存空字符串。本版共享 Reader 则返回错误码字符串。`validateRawFact()` 直接比较新读取值与旧审计值，导致整个待确认导出失败，即使原件 SHA/大小正确、系统快照内容哈希一致。

主 Agent 用 Git 基线 `2ba9ef14` 中实际的 `readSystemOpSnapshotCandidates()` 验证单 Sheet 样本：零校验错误、一个合法快照、原件 E2 为 `{t:'e', v:7, w:'#DIV/0!'}`、旧审计 E2 为 `''`。建立完整 v1 原件绑定并使用原样历史审计后，Manifest 准备成功，提取报 `vcc-review-validation-failed: S:1:2 原始列 5 不符`。

这与 TechDoc §8.3.1 的“历史合法非计算字段错误值输出错误码原文”以及 Spec RV09 不符。核验应按历史导入合同解释旧审计，输出继续保留原件错误码；不能把附页错误值改为空来绕过问题。

证据：

- [基线解析器及 v1 原件绑定复现](tests/unit/main-process/review3-legacy-bound-error.test.js)
- [实际失败日志](review3-legacy-bound-error.log)
- 先行兼容探针：[测试](tests/unit/main-process/review3-system-legacy-error.test.js)、[日志](review3-system-compatibility.log)

## 上轮问题回归

1. 富文本末尾 `<t/>` 导致核验哈希变化：原复现通过。普通富文本、注音、CDATA 样本也均通过；原始 XML body 交由既有 `cellValueFromBody()` 解释，输出仍使用语义值。
2. 系统 OP 布尔值被字符串化为 `1` / `0`：原复现通过；当前业务测试同时覆盖 TRUE/FALSE、公式缓存及输出布尔类型。

对应证据：[富文本原样本](review3-text-probe-output.jsonl)、[布尔值原样本](review3-system-compatibility.log)。

## 验证结果与限制

- 本次执行：Review export / IPC / target / Dataset 测试 **48 PASS**；Scanner 结构及既有 row-scanner 四方合同 **41 PASS**，共 89 项不重复测试通过。
- 富文本子集另外执行 12 项通过，已包含在上述 48 项内，不重复计数。
- 独立复现确认两个上轮问题关闭；新增错误兼容测试失败和 SST 目录删除结果是本轮缺陷证据，不属于上述通过数。
- 日志：[业务测试](review3-root-tests.log)、[Scanner 测试](review3-scanner-tests.log)、[富文本子集](review3-text-business-tests.log)。
- 对仓库提供的本轮 `release-check` 证据执行了当前源码匹配验证：61 个文件 SHA-256 全部一致；指纹清单和原始日志 SHA-256 均与 summary 一致。日志记录单测 7,351 PASS / 3 Windows skip、53 个集成脚本 / 2,488 个断言通过。这是已记录测试结果的核验，本次没有重跑完整 release-check。
- 未执行 Windows 安装、Excel/WPS 人工检查、完整 PF01–PF05、人工恢复演练；本次亦未重跑专用 Electron/ASAR 探针和百万行性能测试。上述自动化通过不能覆盖已复现缺陷或替代平台验收。
