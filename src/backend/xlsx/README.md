# XLSX 公共基础设施

本目录持有 XLSX 解析机制；业务 adapter 选择 reader、sheet/row 策略、资源预算与业务错误映射。调用方取得 workbook 后负责在 `finally` 中 `await close()`。当前实现来自 v3.2.9 的机制提取，未改变格式容忍规则，也未改善 legacy 的全量内存问题。

## 入口与能力

| 实际入口 | 能力与限制 | 调用责任 |
| --- | --- | --- |
| `legacy/streaming-xlsx-reader.js` | `readXlsxStreamed`、行/cell/XML helper；完整 ZIP Buffer、JSZip 和 SST 全量加载，sheet1 行扫描流式；正整数 maxRows 才截断，返回 `{rowCount,truncated}` | 业务保留 colCount、maxRows、手写投影；onRow 同步调用且忽略 Promise 返回值 |
| `legacy/entry-size-preflight.js` | 对实际读取 worksheet 和 SST 做 2^31 字节预检；确定超限报 XLSX_ENTRY_TOO_LARGE，预检自身失败保持旧放行分支 | 调用方传入真实 sheetEntryNames；不扩大到未读取页 |
| `rich-workbook.js` | `openRichWorkbook` 支持声明页（含隐藏页），默认 maxSheets=4096；`openSingleSheetRichWorkbook` 在 styles/SST 前拒绝非单声明页 | 保留 date1904、styles 与 lexical；onRow/onCellLexical 必须同步，thenable 拒绝；禁止并发 scan 和关闭后 scan |
| `shared-strings-provider.js` | Memory/Adaptive provider；公共缺省 64 MiB、LRU 8192；缺 entry 返回空内存 provider | 业务显式传入有效预算与 tempRoot，null/undefined 差异保持原合同 |
| `zip-reader.js`、`workbook-parts.js` | ZIP entry、workbook/relationships/metadata/SST 解析及原有限额 | Toolbox 任务装配保留在 `../toolbox-format/xlsx-pass.js` |
| `excel-text.js`、`ooxml-namespaces.js`、`number-date.js`、`model.js`、`style-registry.js`、`xlsx-sheet-scanner.js` | 文本、OOXML、日期/数字、模型、样式与 worksheet 扫描；Source/OutputStyleRegistry 均保留 | 不包含业务列映射、数据库、归档或发布策略 |

允许依赖本目录、Node 标准库、既有 yauzl/sax/jszip；legacy 预检额外允许 `../file-service/common.js` 的错误类。不允许依赖 Pending、Position、Toolbox 等业务目录、main-process、数据库或业务 writer/session。不要在本目录增加业务聚合 index。

## 预算、关闭和临时资源

Position adaptive 由本域 constants 显式传 64 MiB/8192，保留 preserveSstOnClose，strictClose=false；VCC workbook adaptive 64 MiB/8192、strictClose=false。它们未设置 cacheMaxBytes，不继承 rich 的严格关闭。

BizOP import、RAW 读取和输出验证分别保留 32 MiB/8192、32 MiB 字节缓存与 strictClose=true。RAW 单页、输出 validator 多页，不互换。VCC review plan 为 64 MiB/8192、64 MiB 字节缓存；workbook-import-plan、system-op-importer、dataset-writer、review-validator 四点为 64 MiB/8192，未提供 cacheMaxBytes；均由 rich 固定 strictClose=true。覆盖参数及 tempRoot 沿用各业务 adapter，精确配置合同见 [G4 Spec §4](../../../changes/v3.2.10/codex/v3.2.10-shared-xlsx-infrastructure/spec.md)。

未跨预算不创建 spill。需要 spill 时必须提供非空目录，目录以独占 mkdir 创建，文件以 wx+ 创建并保存 dev/inode；不能接管既存目录、符号链接或其他任务目录。close 先关句柄，再核对登记文件和目录身份，仅 unlink 自有文件、rmdir 空目录；不递归删除。preserveOnClose 和 strictClose 保持不同语义。严格关闭失败保留资源和错误；重复关闭仍返回原错误。rich close 缓存 Promise，按 SST → ZIP 尝试全部关闭并汇总失败，构建失败也沿原链收口。

公共 provider 只拥有自己登记的资源。强制 worker terminate 后的任务级回收仍归原任务所有者；不能扫描删除缺少任务归属证明的目录。资源收口不改变既有业务取消重检或真实退出屏障。

## 兼容入口与迁移

以下旧路径仅单向转发新实现：

- `pending-import/streaming-xlsx-reader.js`、`pending-import/xlsx-size-preflight.js`。
- `xlsx-rich-reader.js`、`position-reconciliation-import/shared-strings-provider.js`。
- `big-table-import/zip-reader.js` 与前述六个 `toolbox-format` 叶子文件。

`toolbox-format/xlsx-pass.js` 仍是 Toolbox 装配，转发既有 workbook/relationship/SST helpers；不能整体退役。`toolbox-format/index.js` 的旧聚合导出保持兼容，生产机制消费者直接引用本目录，Toolbox 业务装配消费者仍引用本域。

旧函数、导出对象与错误 constructor 指向同一实现；PositionSharedStringsError、BigTableImportError、ToolboxXlsxFormatError 名称与 code 是历史兼容合同，不代表公共目录可以反向加载相应业务。

生产调用方按 L1/L2/S1/R1–R4/T1 及全仓搜索扩展清单迁移。测试和历史 scripts 可暂留旧入口；删除任何 shim 前须全仓（含 tests/scripts）引用归零、保留兼容证据并同步 G8 退役登记。新生产消费者必须走本目录，不得为图方便新增旧入口依赖。

## 验证与当前规则

- reader 差异、非法关系、同步 callback、close/错误：`tests/unit/backend/xlsx/*-contract.test.js`、`legacy-compatibility.test.js`。
- 预算和调用链：`tests/unit/backend/xlsx/consumer-options.test.js`。
- 旧新 identity 与叶子闭包：`tests/unit/backend/xlsx/infrastructure-compatibility.test.js`。
- 资源归属：`tests/unit/backend/shared-strings-ownership.test.js`。
- 跨业务真实 XLSX / 私有临时目录 / 生产依赖方向：`scripts/integration/shared-xlsx-boundary.js`。

本分支没有 G8 正式检查器/配置，以上行为和边界检查独立执行；`ARCH-XLSX-INFRA` 和旧 API 新生产入边禁令的 G8 激活归后续集成负责。当前证据、兼容清点、G6 函数职责合并点、未执行平台验收及回退见 [G4 实施记录](../../../changes/v3.2.10/codex/v3.2.10-shared-xlsx-infrastructure/implementation-notes.md)。
