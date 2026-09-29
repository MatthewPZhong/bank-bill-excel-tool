# G4 实现审查记录

审查对象为独立 worktree `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-shared-xlsx-infrastructure` 中尚未提交的 G4 生产差异；基线及 HEAD 为 `11086a3cbf632a30adbcfa796e4cd81810c5aef9`。审查日期 2026-09-20。审查方承担 reader 合同测试，未编写或修改本轮生产实现；本次只读检查生产代码和证据，另行写入本报告。

结论：未发现本轮提取或消费者迁移引入的行为缺陷。发现的 1 处 legacy 能力说明遗漏已由主任务修正并经本审查复核关闭；G8 集成、Windows/Excel/WPS 验收及完整门禁结果仍须按各自证据报告，不能由本审查替代。

## 发现与处理

| 编号 | 级别 / 状态 | 位置与证据 | 影响及最小处理 |
| --- | --- | --- | --- |
| G4-R-01 | 低风险说明项 / 已修复并复核 | 初审 `src/backend/xlsx/legacy/streaming-xlsx-reader.js:215` 的 maxRows 注释写“内存/耗时只取决于前 N 行”，与后续完整读取 ZIP/SST 不符 | 主任务已改为仅限制 sheet 行扫描，并注明 ZIP/SST 前置全量内存不受 maxRows 约束；本审查重读 210–220 行确认。仅注释变化，无需重跑行为测试。 |

本条为对已迁入公共模块说明的审查，不表示本轮引入新的内存行为或已经解决 legacy 全量内存限制。

## 核查方法与结果

1. 使用 `git show 11086a3c:<原文件>` 与实际新文件比对；仅将 relative `require(...)` 的模块路径归一化，其余文本保持不变。
2. 六个叶子模块（excel-text、ooxml-namespaces、number-date、model、style-registry、xlsx-sheet-scanner）、ZIP、rich-workbook 和 entry-size-preflight 在上述归一化后逐字一致。
3. legacy reader 的实现逐字一致，非 import 差异仅为顶部及 maxRows 入口的内存能力注释。SST provider 唯一非 import 机制差异是将 Position constants 来源改为公共本地 64 MiB/8192 常量，并替换 constructor 默认参数的引用名；已核对原 Position constants 值相同。
4. `workbook-parts.js` 从 `TOOLBOX_MAX_SHARED_STRINGS_UNCOMPRESSED_BYTES` 到 class 前的 helper 正文与基线逐字一致；`ToolboxXlsxPass` class、open 函数及原 exports 正文与基线逐字一致。抽取未遗漏私有解析 helper，也未将 Toolbox 装配迁入公共层。
5. 检查所有 `src/backend/xlsx` 中 require：除 Node 标准库、jszip/sax/yauzl、本目录外，仅 legacy preflight 引用显式允许的 `file-service/common`；该 common 无后续 require。未发现传递反向业务依赖。
6. 全 `src` 搜索旧 reader/provider/ZIP/六个叶子路径，未发现残留生产 require；搜索剩余命中为历史解释注释。Toolbox 的装配入口和 index 兼容聚合依职责保留。
7. 逐一核对 Position、VCC adaptive、BizOP import/RAW/validator、VCC review plan 及 R4 四点迁移差异。变更限定为中性 import 和有效默认值的显式表达；业务投影、错误映射、取消桥接、finally close、关闭后业务检查均未改动。

## 有效选项与兼容核查

| 调用组 | 核查结果 |
| --- | --- |
| Position S1 | `undefined` 由本域 constants 显式补 64 MiB/8192；`null`、字符串值继续原样到 provider 做 Number/安全整数校验。`preserveSstOnClose`、cancelToken、sstTempRoot 保留；未增 cacheMaxBytes/strictClose。 |
| VCC S1 | 同样只对 `undefined` 补 64 MiB/8192；保留原 UUID tempRoot、未传 cancelToken/cacheMaxBytes/strictClose/preserve 的合同。 |
| BizOP R1 | 原 memory/cache 的 `??` 仍接受 null 后使用缺省；LRU 仅 `undefined` 补 8192，null 仍拒绝。32 MiB 缺省和 options 覆盖顺序均保留。 |
| BizOP R2 | RAW 仍单页、validator 仍多页；32 MiB 内存与字节缓存、8192 LRU、单独 sst-raw/sst-actual 子目录和 validator 的 expected.pages.length 保留。 |
| VCC R3/R4 | R3 显式 cacheMaxBytes=64 MiB；R4 四点保持 cacheMaxBytes 未传。所有点维持 64 MiB、补显式8192；dataset-writer 未新增取消 token，其他原取消桥接保持。 |
| legacy | 未接入 adaptive provider。Acquiring 仅换 xmlUnescape 来源，未切换成默认 parseRowXml；VCC OP/旧 BizOP 的手写解析与 guard 保留。 |
| 旧入口 | reader、preflight、provider、ZIP、六个叶子是单向 module.exports 转发；Toolbox 原 helper 导出引用公共同一函数，旧 constructor/name/code/instanceof 兼容保持。 |

上述默认值核查同时参考已实际执行的 [消费者基线合同](consumer-options-baseline.tap)，6/6 PASS；最终运行结果归主任务整体验证记录。测试通过不能替代本节对 null/undefined、传参与未传差异的源码核对。

## AC 与证据边界

| AC | 本轮审查判定 / 证据 |
| --- | --- |
| G4-AC-01 | 公共闭包与单向兼容成立；G8 正式 active 配置在本基线不存在，后续集成仍待完成。 |
| G4-AC-02 | reader 行值/行序/maxRows/同步 callback/空 SST/数字投影差异已冻结；说明遗漏 G4-R-01 已修正并复核。 |
| G4-AC-03 | 隐藏页提前拒绝、sheet 顺序、1904、样式归属、非法关系和 lexical 合同测试通过。 |
| G4-AC-04 | 逐调用组 options diff 未见语义变化，缺省值来源去业务化符合 Spec；完整消费者动态证据以主任务最终运行记录为准。 |
| G4-AC-05 | provider 资源管理正文未变；独占创建、身份校验和 strict/preserve 分支保持，既有与新增资源测试见 [X2 证据](x2-sst.log)。 |
| G4-AC-06 | 构建失败清理、同步 callback 拒绝后的收口、取消后 caller await close、close 顺序/双失败/重复 cached Promise 测试通过；普通取消不是强制 terminate 或 Windows 文件占用验收。 |
| G4-AC-07 | 新旧对象/函数/错误 constructor identity 用例通过；helper exports 原样保留。 |
| G4-AC-08 | 规定调用组和额外生产消费者已迁入公共路径，未新增持久化格式；正式 G8 禁令激活与跨分支合入未完成。 |

[reader-contracts.log](reader-contracts.log) 记录先以 `git archive 11086a3c` 固定源码运行 20/20，再对新公共入口和 identity 运行 22/22，补边界后最终 26/26 PASS。该证据由本审查方实际执行；临时基线树已清理。

## 历史快照脚本的诊断边界

独立重新 `git archive` 提取精确基线的 src/scripts/changes，运行 `node <baseline>/scripts/check-background-execution-manifest.js`，未传 `--write`。结果 exitCode=1、`E13-G Action Manifest drift`，见 [baseline-manifest.log](baseline-manifest.log)。因此当前同类 gate 失败不能归因于 G4；本次未修历史快照，也不将该失败改写为 PASS。

## 剩余事项

- 主任务汇总最终生产内容的 release-check、测试及集成结果；本审查没有替代或预判完整门禁。
- G8 正式 active 配置和旧入口新增生产入边禁令需后续集成；G6 VCC 重叠文件仍按 reader options 与 hash/lineage 函数职责合并。
- Windows 占用/关闭/spill、强制 worker terminate 与 Excel/WPS 验收未在本机 reader 测试中完成，不能据此宣称发布就绪。

## 完整日志核对补充

首轮全量 unit 结束后，实际 5 处失败已定位为 worktree 内缺少 node_modules 直接路径（历史快照依赖链接及 NSIS 模板读取）。其中历史 E13-G 测试的错误是 MODULE_NOT_FOUND，不能与上文额外直接执行当前快照脚本所得的 Action Manifest drift 混为一项。已补本地依赖 symlink；定向复验及最终完整门禁以实施记录为准。此环境处理不改变上述生产代码审查结论。

进一步核对历史gate测试的checkout流程后，确认该脚本应在HISTORICAL_E13_G_REF执行（见 `tests/unit/main-process/background-execution/manifest-coverage-e13-g.test.js:263`）。将它直接用于当前main与旧产物比对的漂移不构成当前门禁缺陷。补依赖链接后，该正式历史gate已通过。上述额外诊断的失败输出继续保留作来源记录，不作为发布阻塞项。

## 最终验证状态补充

完整验证发现额外未收口项，不能只依据上述源码审查宣布完成：全量集成59/61脚本通过，归档集成被实际磁盘不足准入阻断，Toolbox大拆分RSS门禁143MiB超过133MiB预算；完整release-check在工作盘仅剩392MiB后中止（exit130），有2条unit失败定向未复现。最终状态、全部日志、健康环境下的基线内存对照义务见 [主实施记录](../implementation-notes.md#最终验证与剩余事项) 与 [验证摘要](verification-summary.json)。本报告没有将未完成的整体门禁改为PASS。
