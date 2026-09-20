# Spec｜v3.2.10 共用 XLSX 基础设施（G4）

| 项目 | 内容 |
| --- | --- |
| 目标版本 / 治理优先级 | `3.2.10` / P2 |
| 计划功能分支 | `codex/v3.2.10-shared-xlsx-infrastructure`；本次未创建 |
| 集成分支 | `release/v3.2.10`；基线复核与集成要求见[总索引](../../README.md) |
| 代码与开发起点 | 正式附注标签 `v3.2.9`，`main@11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 日期 / 修订 | 2026-09-20 / v1 |
| 状态 | 本稿设计，未实施、未执行实现验收 |
| 配套 | [TechDoc](techdoc.md)；[模块耦合审查](../../../architecture-coupling/2026-09-20/review.md) |

## 1. 目标与固定决策

将已被多个业务使用的 XLSX 解析机制放入 `src/backend/xlsx/`，由业务 adapter 选择读取器、资源预算和业务行处理方式。新目录是现有进程内的公共代码模块，无新进程、服务或数据库。

| 决策 | 本稿固定设计 |
| --- | --- |
| D1 | 分别迁移 legacy 行读取器、rich workbook 读取器和其公共依赖；保留两条读取路线。 |
| D2 | SST provider 从 Position 目录迁出，临时目录、缓存预算、错误和关闭合同逐调用方保留。 |
| D3 | 为保证新基础设施不反向依赖业务目录，一并提取通用 ZIP、OOXML 元数据、样式、文本和扫描机制。Toolbox 的任务装配留原处。 |
| D4 | 旧路径通过单向 re-export 保持兼容，不能保留第二份实现。既有错误 constructor、name、code 和公开符号名称保持。 |
| D5 | 不统一 sheet 数、行截断、数字投影、同步/异步回调或预算；不承诺提取后全部读取均为有界内存。 |

## 2. 已核实的现状和问题

- [rich reader:5](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/xlsx-rich-reader.js:5) 同时依赖 big-table-import、toolbox-format 与 Position SST provider，BizOP/VCC 因此间接载入其他业务命名空间。
- [Position SST provider:7](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/position-reconciliation-import/shared-strings-provider.js:7) 的解析机制依赖 Toolbox，其默认预算来自 Position constants；临时资源清理已包含独占创建、identity 校验等必要保护，搬移不能简化。
- [legacy reader:217](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/pending-import/streaming-xlsx-reader.js:217) 被账单、Toolbox、Linked Table、Acquiring、VCC OP、旧 BizOP 多处使用。它仍会读完整 ZIP 和完整共享字符串表，只有 sheet 行扫描部分流式；`maxRows` 不能限制前两者的内存。
- [xlsx-pass.js:226](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/toolbox-format/xlsx-pass.js:226) 包含可共用的 workbook/relationship/SST 解析，也包含 ToolboxXlsxPass 装配；只移动上层 reader 会留下传递反向依赖。

## 3. 用户可见行为与非目标

读取相同文件时，各业务的行数、行序、金额/日期/币种、错误码与导出内容保持当前合同。页面、IPC、文件选择、模板、归档身份和处理状态不变。本项不新增可配置的“通用读取模式”，不让用户在两条 reader 路线间选择。

不扩大支持格式、不修订已有 OOXML 严格性、不改变公式缓存解释，不把 legacy 数字的 `parseFloat → String` 投影替换为 rich lexical 保真。不引入统一单 sheet 限制，也不将多个 sheet 结果自动拼接。CSV 与业务 normalizer 留原模块。超大 XLSX 的算法优化、旧 reader 全量内存问题是后续性能项，不以本项完成宣称解决。

## 4. 读取合同

### 4.1 legacy 读取路线

`readXlsxStreamed(filePath, onRow, { colCount=31, maxRows=0 })` 的返回值继续为 `{rowCount,truncated}`。`onRow(cells,rowIndex)` 同步调用，行号保持一基、包含表头，回调返回 Promise 不会被等待；不得在重构中改成异步背压合同。

`maxRows` 只有正整数时启用截断，其余值沿用无限制；缺少 SST 时 `readSharedStrings()` 返回 null。列字母、XML unescape、空单元格、inline strings、shared strings 和数字转换沿用当前规则。Acquiring 的手写 reader 可继续复用 helper，但不能强制改用默认 parseRowXml。

entry-size preflight 的阈值仍为 2,147,483,648 字节；检查对象沿用调用方实际使用的 sheet 与 SST。确认超限仍报 `XLSX_ENTRY_TOO_LARGE`。当前 preflight 自身读取失败会继续交给旧解析路径，本项原样保留，不能将它写成已实现统一失败关闭。

### 4.2 rich workbook 路线

`openRichWorkbook` 保留声明 sheet 列表（含隐藏页）、date1904、样式来源校验和顺序扫描。默认 maxSheets=4096；`openSingleSheetRichWorkbook` 在读取 styles/SST 前拒绝声明 sheet 数不等于 1 的文件，隐藏页也计入。

scan 返回 Promise，但 onRow/onCellLexical 必须是同步回调；返回 thenable 时按原 TypeError 拒绝，不等待。legacy 则忽略 callback Promise，两者不能混同。并发 scan、close 后 scan、无效页索引按原错误拒绝。close 返回缓存的 Promise，先关 SST 再关 ZIP；任一关闭失败沿用 AggregateError。构建失败也必须完成原资源回收链，不吞关闭失败或将失败转换为成功。

### 4.3 各消费方的有效资源配置

以下是基线有效值，调用方现有覆盖能力继续保留。重构后通过本域 adapter 显式传递，不能用一个“统一默认”覆盖它们。

| 消费方 / 路线 | SST 内存预算 / LRU | 字节缓存 / 关闭 | 临时目录归属 |
| --- | --- | --- | --- |
| Position / adaptive provider | 缺省 64 MiB / 8192 entries；原 options 可覆盖 | cacheMaxBytes 未设置；strictClose=false；保留 preserveSstOnClose | 调用方提供 sstTempRoot；缺省空路径不解释为 cwd |
| VCC 导入 / adaptive provider | 缺省 64 MiB / 8192；原 options 可覆盖 | cacheMaxBytes 未设置；strictClose=false | 显式路径或 tmp 下 vcc-fin-op-sst UUID 目录 |
| BizOP 导入 / rich single-sheet | 缺省 32 MiB / 8192；原 options 可覆盖 | 字节缓存缺省 32 MiB；strictClose=true | candidateDir 下既有 SST 路径 |
| BizOP RAW 导出 / rich single-sheet；输出验证 / rich 多页 | 32 MiB / 8192 | 字节缓存 32 MiB；strictClose=true | task tempDirectory 下 sst-raw / sst-actual UUID 路径 |
| VCC review plan / rich | 64 MiB / 8192 | 字节缓存 64 MiB；strictClose=true | rich 默认 tmp 下 rich-xlsx-sst UUID 路径 |
| VCC workbook-import-plan、system-op-importer、dataset-writer、review-validator / rich | 64 MiB / 8192 | cacheMaxBytes 未显式设置，沿用 provider 原缺省；strictClose=true | rich 默认 tmp 下 rich-xlsx-sst UUID 路径；各调用点原 cancelToken/关闭行为分别保持 |
| legacy reader | 完整 ZIP / SST 仍全量加载 | 不接入 adaptive provider | 不新增 SST spill 目录 |

## 5. SST 临时资源和错误合同

- 未超过内存预算不创建 spill 目录；未提供非空路径却需要 spill 时沿用错误，不回退 cwd。
- 只独占创建新的 tempRoot，保留目录及文件 identity；已存在目录、符号链接、其他任务目录不能接管。文件以独占方式创建。
- close 先关闭句柄，再仅清理 identity 匹配的已登记文件，最后尝试删除空目录；不能递归删除调用者目录、无关文件或替换后的路径。
- preserveOnClose、strictClose 的差异保持；严格关闭不能确认句柄关闭时保留资源与错误。重复 close 维持原错误合同。
- 既有 PositionSharedStringsError 等历史符号会随实现迁入公共模块并由旧路径转发。保留其类型和 code 是兼容要求，不表示公共模块仍可反向 import Position。
- 取消继续使用各 reader 的既有 token 及业务的关闭后检查；不因公共 reader 返回或 finally 开始就宣布真实资源已经释放。

## 6. 验收条件

| 编号 | 验收条件 |
| --- | --- |
| G4-AC-01 | 新 xlsx 公共模块及其依赖闭包不引用业务目录或 main-process；旧路径只向新实现单向转发。 |
| G4-AC-02 | legacy 的行值、顺序、截断、同步 callback、空 SST 和数字投影与基线相同；能力说明不虚报有界内存。 |
| G4-AC-03 | rich 的隐藏页/单页/多页、1904 日期、样式与 lexical 结果及非法关系错误与基线相同。 |
| G4-AC-04 | 所有消费方保留预算、LRU、cacheMaxBytes、strictClose、preserveOnClose 和 tempRoot 的有效配置与覆盖合同。 |
| G4-AC-05 | spill 独占创建、替换路径、无关文件、close 失败和重复 close 保持资源所有权与错误行为。 |
| G4-AC-06 | 取消/构建失败/扫描失败后按原顺序收口；不得留下新引入的资源泄漏或提前报告成功。 |
| G4-AC-07 | 旧导出与新路径对应同一函数/constructor，现有错误码、name 和已依赖的 instanceof 判定保持。 |
| G4-AC-08 | 各业务调用方逐组迁移且可整组回退，无数据库/持久化格式迁移；旧业务路径新增反向引用被 G8 阻止。 |

## 7. 施工与完成边界

先冻结两条 reader 的差异 fixture；再迁通用叶子依赖、ZIP/metadata/SST 与旧路径转发；随后迁 legacy/rich 入口及逐组调用方，最后激活 G8 边界。不能仅完成目录移动就认为本项验收完成。

不依赖 G1/G2/G7。与 G6 并行时按 VCC reader、hash/lineage 的明确职责合并。没有新持久化格式，回退同时恢复公共实现、旧入口和已迁消费者；先按现有任务退出屏障关资源。实现测试和 Windows/Excel/WPS 验收见 TechDoc，本次仅交付设计。

本次文档补充统一交付要求：每个切片均按[切片完成标准](../../README.md#slice-completion)验收，并按[实施记录与状态要求](../../README.md#slice-record)区分本稿设计 AC、实际实施进度与已取得的验证证据；本补充不改变上述业务验收条件。
