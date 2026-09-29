# TechDoc｜v3.2.10 共用 XLSX 基础设施（G4）

| 项目 | 内容 |
| --- | --- |
| 目标版本 / 计划分支 | `3.2.10` / `codex/v3.2.10-shared-xlsx-infrastructure`（未创建） |
| 基线 | 正式附注标签 `v3.2.9`，`main@11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 日期 / 状态 | 2026-09-20 / v1 设计；未实施、未执行测试 |
| 需求 | [Spec](spec.md)，G4-AC-01～G4-AC-08 |
| 集成 / 依赖 | `release/v3.2.10` 基线与集成要求见[总索引](../../README.md)；无其他治理项硬前置，G8 消费本项边界 |

## 1. 模块落点与提取范围

下表右列均为拟新增文件；迁移现有实现并调整内部 import，不重写解析算法。迁移同时保留原路径导出，原调用方不需要一次性全部切换。

| 现有位置 | 新位置及职责 |
| --- | --- |
| `src/backend/pending-import/streaming-xlsx-reader.js` | `src/backend/xlsx/legacy/streaming-xlsx-reader.js`：legacy parser 与流扫描入口。 |
| `src/backend/pending-import/xlsx-size-preflight.js` | `src/backend/xlsx/legacy/entry-size-preflight.js`：原 entry size 预检。 |
| `src/backend/xlsx-rich-reader.js` | `src/backend/xlsx/rich-workbook.js`：rich workbook 资源组合及扫描入口。 |
| `src/backend/position-reconciliation-import/shared-strings-provider.js` | `src/backend/xlsx/shared-strings-provider.js`：内存/adaptive provider、spill 所有权与关闭。 |
| `src/backend/big-table-import/zip-reader.js` | `src/backend/xlsx/zip-reader.js`：完整迁入当前通用 ZIP/entry API，保留 BigTableImportError 等旧符号。 |
| `src/backend/toolbox-format/xlsx-pass.js` 中 class 之前的 workbook/relationship/metadata/SST helper | `src/backend/xlsx/workbook-parts.js`：解析与限额校验；不含 ToolboxXlsxPass/openToolboxXlsxPass。 |
| `src/backend/toolbox-format/` 下 `excel-text.js`、`ooxml-namespaces.js`、`number-date.js`、`model.js`、`style-registry.js`、`xlsx-sheet-scanner.js` | 对应 `src/backend/xlsx/` 下同名文件：逐文件原样提取公共机制及其闭包。Source/OutputStyleRegistry 均保留。 |

`toolbox-format/xlsx-pass.js` 保留 ToolboxXlsxPass、openToolboxXlsxPass 的装配逻辑，改用中性模块并转发既有 helper 导出。其他表中旧文件缩成兼容 re-export。Toolbox writer、业务 projection 选择、Position/VCC/BizOP 行映射仍留本域。新目录不增加聚合所有业务的 index.js。

目标依赖：

```text
业务 adapter / 旧路径 shim
  ├─ xlsx/legacy/streaming-xlsx-reader → legacy/entry-size-preflight
  └─ xlsx/rich-workbook
        ├─ zip-reader
        ├─ workbook-parts → xlsx-sheet-scanner + excel-text + ooxml-namespaces
        ├─ style-registry → number-date + ooxml-namespaces
        └─ shared-strings-provider → workbook-parts + excel-text
             xlsx-sheet-scanner → model + number-date + excel-text + ooxml-namespaces
```

允许 Node 标准库、既有 `yauzl`/`sax`/`jszip`，legacy preflight 继续使用 `file-service/common` 的 FileValidationError。禁止新目录 import pending-import、position-reconciliation-import、toolbox-format、业务 DB/writer/session 或 main-process。XLSX 是 IO 基础设施，可以使用 fs；G8 不应将其误设成 G6 的纯模块规则。

## 2. 公共接口与兼容方式

### 2.1 legacy（原签名整体迁移）

```js
readXlsxStreamed(filePath, onRow, { colCount = 31, maxRows = 0 } = {});
// Promise<{rowCount, truncated}>, onRow(cells, oneBasedRowIndex) 同步
parseRowXml(rowXml, colCount, sharedStrings);
parseCellBody(body, type, sharedStrings);
lettersToIndex(letters);
xmlUnescape(text);
readSharedStrings(zip); // Promise<Array<string> | null>
```

保留旧导出集合。读取整个 Buffer/JSZip/SST 的现状不变，不能因 maxRows 早停而声称峰值内存受 maxRows 约束。entry-size-preflight 保留原导出和参数；超限与预检自身错误分支严格按基线迁移，不引入新的更宽或更窄的格式容忍规则。

### 2.2 rich workbook（原签名整体迁移）

```js
openRichWorkbook(filePath, options = {}, singleSheet = false);
openSingleSheetRichWorkbook(filePath, options = {});
// options: maxSheets, sstTempRoot, memoryBudgetBytes,
//          lruMaxEntries, cacheMaxBytes, cancelToken
// frozen result:
// {sheet, sheets, date1904, sharedStrings, close,
//  getCellStyle, scanSheet, scan}
```

`scanSheet(index,onRow,onSheetMeta,onCellLexical)`、`scan(onRow)`、close 返回 Promise；行/lexical 回调必须同步，onRow 或 onCellLexical 返回 thenable 时抛原 TypeError，不 await。onSheetMeta 的既有调用语义原样迁移，不顺带统一所有回调。这与 legacy 忽略 callback Promise 的行为不同。调用者取得 workbook 后仍必须在 finally await close；rich 内部 strictClose 固定 true，不开放新开关。maxSheets 的安全整数校验仍为 1～4096；单页检查必须早于 styles/SST，避免错误文件引入不必要分配。

metadata 限额保持 workbook 16 MiB、relationships 16 MiB、styles 32 MiB、theme 8 MiB；SST uncompressed 限额保持 1,200,000,000 字节。现有样式预算 cellXfs=50000、fonts=480、fills=240、borders=10000、customNumFmts=180，及文本/数字 lexical 限额原值不变。原 TOOLBOX_* 导出名称继续可用，本项不批量改名。

### 2.3 SST provider（原签名，默认来源去业务化）

```js
new MemorySharedStringsProvider(values = []);
new AdaptiveSharedStringsProvider({
  tempRoot, memoryBudgetBytes = 64 * 1024 * 1024,
  lruMaxEntries = 8192, preserveOnClose = false,
  cacheMaxBytes, strictClose = false
} = {});
loadSharedStringsProvider(zip, entry, options = {});
// options 包含上述项与 sourceFile / cancelToken
// get(index) -> string | undefined; close() -> Promise<void>
```

INDEX_RECORD_BYTES=12、LENGTH_PREFIX_BYTES=4 和 provider 全部既有公开导出保留。默认值在新公共实现中明确定义，不从 Position constants 读取；Position adapter 继续使用本域 constants 显式传入自己的有效值。其他消费者按 Spec 表显式构造 effective options，不改变 null/undefined、Number 转换和原 options 覆盖优先级。

为减小迁移风险，原 PositionSharedStringsError 的实现原样迁入公共文件，旧路径导出同一 constructor；name=`PositionSharedStringsError`、code=`position-import-parser-parity-unproven`、detailLines 复制规则保持。本次不新增 errorFactory/profile 框架，不通过包一层新 Error 破坏 instanceof/cause。其他 Toolbox/BigTable 错误采用同样原则。路径归属转为公共，历史名称是兼容合同。

缺 entry 仍返回空 MemorySharedStringsProvider，不创建目录。Memory close 的清空数组行为、Adaptive metrics 与所有权字段含义保留。不得在迁移中“优化”为跨 workbook 全局 SST 缓存。

## 3. 资源时序和异常矩阵

| 阶段 / 故障 | 处理约束 |
| --- | --- |
| ZIP 打开、重复 entry、workbook/relationship 验证 | 保持旧顺序及首错误；构建 catch 经同一个 close 收口。 |
| SST 由内存切 disk | 目录 mkdir mode 0700，非 recursive；文件 wx+ mode 0600，记录 dev/inode identity。先前已存在的路径不能接管。 |
| append / decode / scan 失败 | 按旧调用链抛错并 await 已取得资源的 close；不把空结果当成功。 |
| 取消到达 | 扫描沿用 token；业务原有关闭后取消重检仍保留。普通取消测试与强制 terminate 清理测试分别记录。 |
| SST fd close 失败 | 保持 strictClose 分支；严格模式保留 spill，不清可能仍被占用文件。 |
| 文件或目录被替换 / 插入无关文件 | 只删除身份匹配的登记文件；空目录才 rmdir；错误可见，不 recursive rm。 |
| preserveOnClose=true | 保持原保留行为，不把公共模块统一 close 解释为删除所有 spill。 |
| rich close 多次调用 | 返回同一 cached Promise；SST 与 ZIP 都尝试关闭，汇总真实失败。 |
| 旧 shim + 新路径同进程加载 | Node module cache 指向同一实现与 constructor；不创建两套 registry、provider 或事件监听。 |

provider 只能保证自己已登记资源的清理；强制 worker terminate 的任务级回收仍由现有任务所有者负责。若测试发现既有平台级泄漏，单列缺陷与证据，不靠本次移文件宣称修复，也不能删除弱血缘目录补救。

## 4. 调用方迁移清单

| 组 | 既有入口 | 迁移方式与保持点 |
| --- | --- | --- |
| L1 | `src/backend/file-service/readers.js`、`src/main-process/toolbox-stream-io.js`、`src/main-process/linked-table-stream-source.js` | 直接指向新 legacy reader；各自 colCount/maxRows、首行与列投影保持。 |
| L2 | `src/backend/acquiring-bill-currency-import/reader-handrolled.js`、`src/backend/vcc-op-calc-import/reader.js`、`src/backend/biz-op-recon-import/reader-streamed.js` | 只切 helper 来源；保留手写解析差异、旧 BizOP guard 及业务转换。 |
| S1 | `src/backend/position-reconciliation-import/xlsx-reader.js`、`src/backend/vcc-financial-op/workbook-reader.js` | 直接指向公共 provider；逐项保持 budget/LRU/cache/strict/preserve/temp 路径。 |
| R1 | `src/main-process/biz-op-v327/import-pipeline.js` | rich single-sheet；保持业务 adapter 对表头、空行、候选文件和取消的判定。 |
| R2 | `src/main-process/biz-op-v327/export-source.js`、`src/main-process/biz-op-v327/export-validator.js` | RAW 原件逐文件使用 openSingleSheetRichWorkbook；export-validator 使用多页 openRichWorkbook，maxSheets 来自 expected.pages.length。两者不互换，RAW 输出不改 lexical 合同。 |
| R3 | `src/backend/vcc-financial-op/review-export-plan.js` | rich；保留 signal 到 cancelToken 的桥接与既有行血缘处理，与 G6 改同文件时合并 import 职责。 |
| R4 | `src/backend/vcc-financial-op/workbook-import-plan.js:74`、`src/backend/vcc-financial-op/system-op-importer.js:859`、`src/main-process/vcc-financial-op-dataset-writer.js:953`、`src/main-process/vcc-financial-op-review-validator.js:154` | 这四个既有 rich 调用点也必须迁移。各自 64 MiB 内存预算、8192 默认 LRU、cacheMaxBytes 未显式提供、strictClose=true、rich 默认临时根；不能误套 R3 显式 64 MiB cache 或 S1 adaptive 的关闭规则。逐点保留已有 cancelToken、构建/扫描/关闭及错误传播。 |
| T1 | `src/backend/toolbox-format/xlsx-pass.js` 及依赖公共叶子文件的 consumers | 任务装配留本域，机制改中性路径；不修改格式保真、输出预算或任务执行路径。 |

实施前以固定基线静态搜索扩充实际消费者清单，记录新增分支调用方。各组完成后生产代码不再从旧业务路径取得本项共用 API；旧路径保留用于过渡测试/历史工具，并加入 G8 单向兼容允许项，禁止新增生产消费者。移除 shim 须全仓（含 tests/scripts）引用归零并有对应验证，本版不以删除全部 shim 为完成前提。

## 5. 实施任务和完成顺序

| 阶段 | 具体交付 | 对应验收 |
| --- | --- | --- |
| X0 | 固定 legacy/rich 差异、各调用方 effective options 与错误快照 | G4-AC-02、G4-AC-03、G4-AC-04、G4-AC-07 |
| X1 | 提取 6 个叶子机制、ZIP 与 workbook-parts，旧路径转发；Toolbox 装配改依赖 | G4-AC-01、G4-AC-03、G4-AC-07 |
| X2 | 提取 SST provider，完成内存/落盘/关闭/身份替换测试 | G4-AC-04、G4-AC-05、G4-AC-06、G4-AC-07 |
| X3 | 提取 legacy/rich 入口与 preflight，切 L1/L2/S1 | G4-AC-02、G4-AC-04、G4-AC-06、G4-AC-08 |
| X4 | 切 R1/R2/R3/R4/T1，逐组输出与资源回归，激活 G8 无反向依赖规则 | G4-AC-01、G4-AC-03、G4-AC-04、G4-AC-06、G4-AC-08 |

每阶段可独立验证和回退。禁止只提取 rich-workbook 后让它仍 import Position/Toolbox 就标记 AC-01 完成；必须连同传递依赖闭包完成。新旧调用方并存期间只允许同一实现的单向转发，不允许双读做生产比对或双写输出。

## 6. 测试计划（未执行）

已有回归：`tests/unit/backend/pending-import/streaming-xlsx-reader.test.js`、`xlsx-size-preflight.test.js`（同目录）、`tests/unit/backend/shared-strings-ownership.test.js`、`tests/unit/toolbox-format-shared-strings-structure.test.js`、`tests/unit/main-process/biz-op-v327-export-sst.test.js`。路径移动时保留至少一组旧入口兼容用例，其他用例指向新实现。

拟新增下列测试；fixture 从已提交的最小样本或测试现场构造，不使用用户业务文件：

| 拟新增测试 | 必须覆盖 | AC |
| --- | --- | --- |
| `tests/unit/backend/xlsx/legacy-compatibility.test.js` | 行序、列宽、空 SST、inline/escape、数字 lexical 与 legacy 差异、maxRows 无效值、同步 callback | G4-AC-02、G4-AC-07 |
| `tests/unit/backend/xlsx/rich-workbook-contract.test.js` | 含隐藏页的单页拒绝、sheet顺序、重复/外部/缺失关系、1904、样式归属、close后/并发scan拒绝、构建和双关闭失败、onRow/onCellLexical thenable 拒绝 | G4-AC-03、G4-AC-06、G4-AC-07 |
| `tests/unit/backend/xlsx/consumer-options.test.js` | 上述每组及 R4 四个独立调用点的 effective options 与现有覆盖值；区分未传 cacheMaxBytes 和 R3 的显式值，确认 legacy 未偷偷接入 adaptive | G4-AC-04 |
| `tests/unit/backend/xlsx/shared-strings-contract.test.js` | 跨预算落盘、空tempRoot/已存在目录拒绝、替换identity、无关文件、fd失败、strict/preserve差异、重复close、旧新constructor同一 | G4-AC-05、G4-AC-06、G4-AC-07 |
| `scripts/integration/shared-xlsx-boundary.js` | 代表性账单/Toolbox/Position/VCC/BizOP真实调用链逐组等价；取消及真实退出后检查测试私有目录；无反向依赖 | G4-AC-01～G4-AC-08 |

输出比较采用业务行/列/值/类型、sheet元数据和原已有 lexical/样式合同，不直接要求包含随机 UUID/ZIP 时间戳的二进制逐字节一致。测试环境固定旧新相同输入和参数，禁止修改输出格式来迎合快照。

正式交付前运行最终代码的 release-check；文件占用、取消、关闭与 spill 目录行为须补 Windows 验收，代表性导出在 Excel/WPS 验证。上述是实施验收要求，本次文档没有产生新的测试 PASS 或性能数据。

## 7. 回退与剩余边界

无 schema、业务 hash 或持久化版本变化。回退以 X 阶段和已迁调用组为单位，恢复对应函数来源与 import，并遵守当前退出屏障；不得只恢复旧 shim 内容造成新旧实现各一份。临时资源清理仍按 ownership，不把回退升级为全目录清扫。

本稿的 reader 家族、提取闭包、路径、默认值和兼容策略已确定。实现时若发现新增业务调用方，只补清单并沿用其已存在合同；若需要改格式/预算/取消或预检失败语义，应先修订对应 Spec，不能当作目录重构附带变更。

## 8. 切片实施记录与规则同步（文档补充）

沿用本稿既有阶段及任务 ID，按[切片完成标准](../../README.md#slice-completion)逐项交付。优先复用本功能目录已有的 `implementation-notes.md` / `verification.md`；首次实施且没有适用记录时建立 `implementation-notes.md`，使用[实施记录与状态要求](../../README.md#slice-record)中的最小字段，避免同一事实多处维护。设计 AC 和测试计划与实际迁移状态、执行结果分别记录，本次不建立实施记录占位文件。

按[各治理项现行规则入口映射](../../README.md#current-rule-entrypoints)同步本切片影响的规则正文和入口链接。只有职责已在实际生产调用路径落地的模块才能记为现行入口，尚未实现的模块继续标为拟新增；不影响规则时，在切片记录中写明无需更新及原因。本次为文档要求补充，不表示生产实现、边界激活或验证已经完成。
