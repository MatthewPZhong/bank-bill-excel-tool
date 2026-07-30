# Spec B — 工具箱合并/拆分格式保真

> status: release-prepared
> scope: 工具箱“合并表格 / 按字段拆分”读取、行载荷、写入、Worker 与测试
> excludes: 资金匹配引擎、场景配置、数据库 schema
> updated: 2026-07-30

## 0. Task Brief

### Goal

- 工具箱合并/拆分产物在本 Spec 明确枚举范围内，保持单元格值类型、数字格式和静态基础样式与来源单元格一致。
- 数值日期继续以 Excel 原生日期序列和来源显示格式输出，不能裸显示序列号。
- 长账号、订单号和其它长数字不丢精度、不丢前导零。
- 最终可见纯数字不得使用科学计数法。
- 30 万行及以上 XLSX 路径继续流式处理，不因保留样式退回整表加载。

### Context

- 当前工具箱流式读取只传递 `string[]`，源单元格类型、`styleId`、`numFmt`、行高和列宽在写入前已经丢失。
- 当前 writer 按固定英文列名重新套数字/日期/文本格式，并硬编码表头字体，不是来源格式保真。
- 普通合并、普通拆分、多 Sheet Worker、单/多输出和自动分页存在不同入口；只修一条路径会产生行为分叉。
- XLSX 跨工作簿直接复制 theme index 会因主题不同产生串色。
- Excel 官方允许每个工作簿最多 65,490 个唯一单元格格式/样式；本工具需要更保守的应用安全预算。

### Constraints

- 本 PR 不修改 R3.5、R4、R5、资金匹配、场景配置或数据库。
- 保持现有文件选择顺序、Sheet/行顺序、表头一致性校验、拆分条件、文件命名、分页阈值、覆盖已有文件能力和日志口径。
- 不得复用或修改通用/pending 导入 reader 来承担新的样式契约；新增工具箱专用 style-aware 读取层，避免影响其他导入模块。
- XLSX 内存随共享字符串、唯一样式数和单行宽度增长，不得随总行数线性增长；CSV 保持现有全量路径，不在本 PR 宣称大文件内存保证。
- `.xls` 必须与 `.xlsx` 一起交付格式保真；现有依赖未暴露的 BIFF8 字体、边框和对齐由本 PR 新增的只读 BIFF8 样式元数据层补齐，不允许运行时依赖 LibreOffice 或静默降级。

### Done when

- XLSX 合并、普通拆分、Worker 拆分、多输出和自动分页都使用同一 `ToolboxCell` 契约。
- 日期、长数字、前导零、主题色、字体、填充、边框、对齐、行高和列宽通过 XML/回读/人工打开验收。
- 任一输出在 prepare/validate 阶段超过任一样式组件预算时，整次任务失败且不触碰正式目标。
- 低样式基数的 30 万行测试保持可接受内存；高样式基数按预算可观测地失败。
- BIFF8 `.xls` 通过与 XLSX 同口径的值、样式、日期、布局、路径矩阵和 Excel/WPS 验收；无法解析或无法与 SheetJS 值层一致对齐时整文件失败，不生成部分保真结果。

## 1. PR 边界

### 1.1 纳入

- 工具箱合并 reader / writer。
- 单文件和多文件拆分 reader / writer。
- 拆分成功后的有界 warning summary IPC/renderer 展示。
- 大文件与多 Sheet Worker 协议。
- 自动分页 Sheet。
- XLSX 样式、主题、日期系统和行列布局解析。
- CSV 词法值与默认样式。
- BIFF8 `.xls` 值读取、项目自有样式元数据 overlay、统一样式映射及全路径验收。
- 整批可回滚发布、样式预算、监控与测试。

### 1.2 明确排除

- 资金对账与任何 FundType/ReconciliationId 规则。
- 公式本身的复制；继续输出公式缓存值及其有效样式。
- 合并单元格、条件格式、批注、超链接、数据验证、冻结窗格、图片、图表、透视表和打印设置。
- 富文本 run 级字体、渐变填充、对角边框及其它未在 3.1 枚举的样式；这些对象可能影响最终可见效果，因此本 Spec 不宣称“完整视觉等价”。
- 改变表头、文件、Sheet、行和拆分结果的既有业务顺序。
- 把所有源 Sheet 的列宽混合到同一个输出 Sheet；列布局只能有一个基准。

## 2. 参与 Sheet 与布局基准

### 2.1 合并

参与顺序固定为：

```text
用户选择文件顺序 → 每个工作簿标签显示顺序
```

- Sheet state 为 `hidden` 或 `veryHidden` 时不参与合并。
- “非空 Sheet”定义：至少存在一行，其中至少一个单元格经以下规则后非空：

```text
null / undefined → ''
其他值 → String(value).trim()
```

- 数字 `0` 和布尔 `false` 是有意义值。
- 纯空格、只有样式、只有行高/列宽、只有合并区域但无值的 Sheet 仍为空。
- 公式按缓存结果判断；有非空缓存结果时属于非空。
- 只有表头、没有数据行的 Sheet 仍属于非空并参与既有表头校验。
- 合并的全局布局基准是上述顺序中第一个可见非空 Sheet。
- 每个被用户选中的输入文件都必须至少有一个可见非空 Sheet；任一输入文件不满足时，整次合并按既有空文件错误失败。不得仅因其它文件有数据就静默忽略该输入文件。

### 2.2 拆分

- XLSX 拆分继续保持现有多 Sheet 续页语义，包括当前隐藏 Sheet 的参与行为。
- BIFF8 `.xls` 拆分由既有“只处理首个 Sheet”扩展为与 XLSX 相同的多 Sheet 续页语义；这是本版为满足 `.xls` 全路径保真而明确引入的行为变更，必须写入版本说明和回归测试。
- 不得把合并的“跳过 hidden/veryHidden”规则静默套到拆分，否则会改变筛选结果和输出行数。
- 拆分布局基准是实际提供逻辑表头的第一个参与非空 Sheet。
- 如产品未来要求拆分也跳过隐藏 Sheet，必须另立行为变更 Spec 和验收。

### 2.3 输出布局

每个输出 Sheet 在提交表头行之前必须完成：

- `defaultColWidth`；
- `defaultRowHeight` 及 `customHeight` 语义；
- 基准列宽；
- 基准列隐藏状态；
- 基准列 outline/group；
- 表头行高、隐藏状态和 outline；
- 基准表头单元格的有效样式。

自动分页产生的每一页重复同一基准表头和列布局。

数据行：

- 保留各自来源行高、隐藏状态和 outline；
- 每个数据单元格使用自身来源的有效样式；
- 同一输出列允许不同来源样式并存；
- 非基准 Sheet 的列宽、列隐藏和列 outline 不覆盖全局基准。

## 3. 内部数据契约

### 3.1 `ToolboxCell`

每个显式单元格至少携带：

```javascript
{
  rawLexicalValue,
  cachedValue,
  cellType,
  decodedSemanticValue,
  matchValue,
  sourceStyleId,
  effectiveStyleRef: {
    sourceRegistryId,
    styleRef
  },
  isExplicitCell,
  sourceDateSystem,
  sourceFormat,
  sourceFile,
  sourceSheet,
  rowIndex,
  columnIndex
}
```

每个输入工作簿拥有一个 pass-local `SourceStyleRegistry` 和任务内唯一 `sourceRegistryId`；Cell 的复合 `effectiveStyleRef` 只引用该 registry 内的规范化不可变样式。Cell 不复制深样式对象，source registry 不跨线程共享。

每个输出工作簿另有独立 `OutputStyleRegistry`：

- Sheet/workbook 事件把 `sourceRegistryId → SourceStyleRegistry` resolver 提供给同一进程/Worker 内的 writer；
- writer 解引用源样式，按最终签名注册进当前输出 registry；
- 相同 `styleRef` 只有结合 `sourceRegistryId` 才有意义，不得跨工作簿直接比较整数；
- 样式去重和第 8 节预算只统计当前 `OutputStyleRegistry` 及 writer default/base 项；
- 多输出文件各自拥有 output registry，不共享预算计数。

`decodedSemanticValue` 是供兼容投影使用的语义值；`matchValue` 由唯一纯函数产生：

```javascript
toMatchValue(cell, projectionProfile) =
  normalizeCell(projectToolboxValue(cell, projectionProfile))
```

- XLSX 唯一权威 profile 是改造前“普通 XLSX 工具箱路径”实际使用的 `toolboxReadHeaderRowStreamed/toolboxStreamDataRows → normalizeCell` 投影；开发前先用旧代码生成 fixture golden。
- 当前 Worker 路径若与普通 XLSX golden 分叉，本次有意收敛到普通路径；该差异必须作为行为变更写入测试与版本说明，不能让实现自行二选一。
- CSV 与 `.xls` 分别用其改造前 fallback 路径生成独立 golden；它们不强行套 XLSX 数字解码细节。`.xls` 的新 BIFF8 style overlay 只能补充格式元数据，不得改变 SheetJS 值层产生的既有 `matchValue`。
- 它只用于表头比对、下拉去重和拆分筛选，不改变实际写出的 `outputValue`。
- 表头必须同时保留 `rawHeaderCells`（仅用于取得来源静态样式/来源坐标）与 `normalizedHeaders: string[]`（完全一致校验、字段 UI、列定位和实际写出的表头文本）。
- 为保持既有表头行为，输出表头值继续写 trim 后的 `normalizedHeaders[i]`，不改回 raw 空格/原类型；只把对应 raw header cell 的静态样式应用到该文本值。
- `split:read` 与 `split:export` 是两个独立 pass，但必须调用同一个 `toMatchValue`，确保 UI 返回的每个选项能在导出阶段重新命中。

StyleRegistry 中的静态基础样式至少包含：

- `numFmt`
- 字体名称、字号、粗体、斜体、下划线、删除线、vertAlign 和颜色
- pattern/solid 填充及前景/背景色
- 左、右、上、下边框样式及颜色
- 水平/垂直对齐
- 自动换行
- 文字旋转
- 缩进

不在上述清单的属性不允许静默宣称保真；必须按 1.2 的明确排除/降级测试处理。

### 3.2 行、列与 Sheet 元数据

逐行载荷还必须携带：

- 行高；
- 行隐藏；
- 行 outline/group；
- 行 style ref 与 `customFormat`；
- 来源文件、Sheet 和原始行号。

每个参与 Sheet 的元数据至少携带：

- 标签显示顺序和可见状态；
- `date1904`；
- `defaultColWidth`、`defaultRowHeight` 和 `customHeight`；
- 列宽、列隐藏、列 outline/group、列 style ref；
- 逻辑表头行位置；
- 来源主题/调色板解析结果。

### 3.3 有效样式解析

- 先把候选 XF 按 `xfId`、`applyNumberFormat/applyFont/applyFill/applyBorder/applyAlignment/applyProtection` 等 OOXML 语义解析为完整静态样式；不得把 row/column/cell 的缺失属性逐项随意拼成源文件不存在的混合样式。
- BIFF8 `.xls` 的 Cell XF 已保存当前完整格式属性；parent Style XF 与 used-attribute flags 只用于引用合法性、样式血缘及未来编辑联动语义校验，当前渲染不得按 flags 动态把 parent 属性混回 Cell XF。不得把 BIFF8 flags 当成 OOXML `apply*` 位。
- 样式来源优先级固定为：显式 cell XF → `customFormat` 行 XF → 列 XF → workbook default XF。具体冲突行为必须由 Excel fixture 与 XML 回读锁定。
- XLSX 的 theme color、indexed color 和 tint 必须解析成明确 ARGB 后再进入统一样式模型。
- OOXML 颜色只要显式声明，就必须满足唯一且可解释的来源：RGB 为 6/8 位十六进制、theme/indexed 位于有效范围、tint 位于 `[-1,1]`；冲突、未知属性或越界值整文件失败。仅 `auto` 颜色允许使用对应组件的上下文默认色，禁止把非法颜色静默伪装成黑色或白色。
- BIFF8 的内置/自定义 palette、automatic/system color、`Theme` record 中嵌入的 Office Open XML theme 与 `XFExt` 扩展色同样必须先解析为明确 ARGB；输出统一样式模型中禁止保留未解析的 theme index。
- OOXML `<numFmt>` 与 BIFF8 `Format` 使用同一低编号分区契约：`5–8`、`23–26`、`41–44`、`50+` 允许实际文件中的物理格式声明覆盖 locale/built-in 映射；其余 `0–49` 是 canonical built-in 保护区，物理声明只能与 canonical 语义一致，不得覆盖 14/22/45–47 等规范格式。
- 物理格式声明存在时以物理格式码为权威；BIFF8 只对实际 record-defined `Format` 的有值单元格与 SheetJS `cell.z` 做精确核对。没有物理 `Format` 的 canonical built-in 不得因 SheetJS 的 locale 字符串差异被误拒；Blank、行、列样式继续以 record 层为权威。
- 禁止把源 theme index 原样复制到使用另一主题的输出工作簿。
- 样式签名基于规范化后的最终有效样式，不基于源 `styleId`：
  - 不同文件的相同 `styleId` 不能视为同一风格；
  - 不同 `styleId` 解析后完全相同必须去重。
- 只保证源 XML 中显式存在且位于逻辑输出宽度内的空单元格保留静态样式。
- 源 XML 中不存在的隐式空白不物化，不得推断成 0、日期或格式化文本；它采用输出基准列与当前输出行的继承结果。非基准来源隐式空白未来录入时的样式不属于本 Spec 保真范围。

## 4. Reader 与 Worker

### 4.1 XLSX

新增工具箱专用 style-aware 流式 reader。每个独立处理 pass/reader 实例内，下列工作簿级对象只解析一次：

- `workbook.xml` / `workbookPr.date1904`
- workbook relationships
- `styles.xml`
- `theme`
- `sharedStrings`
- Sheet 可见状态和标签顺序
- Sheet 列元数据
- 行元数据
- 单元格 `t`、`s`、`v`、公式缓存值和原始数字词法

工具箱 XLSX reader 不得继续使用固定 1024 列的截断上限；必须按显式单元格坐标使用稀疏行载荷，支持 XLSX 合法列范围且内存只随当前行实际宽度增长。

约束：

- 不得退回 SheetJS 整表物化大 XLSX。
- 不得修改现有通用/pending 流式 reader 的返回契约，防止其它导入模块回归。
- 目标内存复杂度：

```text
O(共享字符串 + 唯一来源样式 + 单行列宽 + 输出样式字典)
```

- 不得宣称严格常量内存；样式和共享字符串本身允许增长并必须可观测。
- `toolbox:split:read` 与等待用户操作后的 `toolbox:split:export` 是两个独立 pass，可以重新打开源文件；本 PR 不新增跨 IPC 持久文件句柄/缓存 session。
- export 在同一 pass 内允许一次轻量 header preflight 后重新打开数据流，但不得第二次全量加载 SST/styles/theme；若 reader 能在同一流中继续则优先单次打开。
- ZIP 中实际存在的 `workbook.xml`、workbook relationships、worksheet、`sharedStrings.xml`、`styles.xml` 和 theme 必须使用严格 XML 解析并验证根元素、必需容器和完整闭合；截断或畸形 XML 不得把已读前缀当成合法工作簿。对应 entry 完全不存在时才允许按格式规范使用缺省值，entry 已存在但无效时必须失败。
- 工具箱 opener 必须在解压前按 ZIP 中央目录、并在读取流中按实际 byte 双重限制核心 metadata part：`workbook.xml` 16 MiB、`workbook.xml.rels` 16 MiB、`styles.xml` 32 MiB、theme 8 MiB。超过上限直接失败，禁止先解压为完整 Buffer/string 后再检查。
- 上述核心 ZIP entry 名必须唯一；同一路径存在重复 entry 时整文件失败，不能依赖 ZIP reader 的“第一项/最后一项”实现细节选择业务值或样式。
- workbook、worksheet、sharedStrings、styles 和 theme 只接受 OOXML Transitional/Strict 对应的完整 SpreadsheetML/DrawingML 命名空间；workbook relationships 只接受完整 package relationship 命名空间，Sheet `r:id` 只接受完整 Office relationship 命名空间。
- worksheet/styles/theme/sharedStrings 的 Relationship `Type` 必须精确命中 Transitional/Strict Office relationship 完整 URI；禁止用路径后缀、`endsWith` 或仅凭 Target 文件名分类。
- workbook 的 relationship id、Sheet `r:id`、解析后的 worksheet entry path 和 Sheet 名必须唯一；每个 Sheet 都必须指向存在的内部 worksheet relationship/entry。关系缺失、类型错误、外部 worksheet、重复关系或两个 Sheet 复用同一 worksheet entry 均整文件失败，禁止重复行或静默漏 Sheet。
- 只有 `workbook` 直属核心 `extLst/ext` 内的 foreign namespace payload 可以作为未知扩展忽略；其它层级的核心同名 foreign 元素、核心 namespace 错误大小写或错层核心元素仍必须失败。
- worksheet 单元格类型必须与载荷一致：`is` 仅允许用于 `t="inlineStr"`；`inlineStr` 不允许 `v` 或公式缓存；其它类型不允许 `is`；数值、布尔和日期缓存值必须符合声明词法；`t="e"` 必须有 `v` 且只接受 Excel 8 个标准错误码。任何不一致都整文件失败，不得把实际 payload 静默投影为空值。
- 已消费的整数、boolean、坐标与枚举属性必须区分“属性缺失”和“显式空值”；缺失时才可使用规范缺省，显式空白不得静默默认。
- OOXML SST、inline rich text 与 `t="str"` 使用 SpreadsheetML ST_Xstring 语义：每个独立 `<t>`/`<v>` 只解码一次，不跨 rich run 拼接 escape；writer 统一先保护字面 `_xHHHH_`/`_XHHHH_`，再编码 NUL/C0、CR 和 DEL。单元格语义文本按 UTF-16 code unit 最多 32,767；未配对代理项、`U+FFFE/U+FFFF` 或超长文本整批失败并报告来源坐标，禁止静默截断或删字符。
- reader 在 SAX 累积阶段对单个 `<v>`/`<t>` 使用 `7 × 32,767` 的保守 raw ST_Xstring 上限，对 rich run 累计语义长度使用 32,767 上限，对公式词法使用 8,192 上限；不得等到整 cell/整 Sheet 物化后才拒绝。

### 4.2 Worker

普通拆分和 Worker 拆分必须消费同一逻辑 `ToolboxCell` / 行元数据契约。

- Worker 内部执行 reader → filter → writer 并使用同形 `ToolboxRow + StyleRegistry/ref` 契约。
- parent ↔ Worker IPC 继续只传控制参数、节流进度、序列化错误和汇总结果；严禁逐行传输 row/cell/style。
- Worker message 数量和 payload 大小不得随总行数线性增长。
- 样式表和主题解析结果只在 Worker/当前 pass 内按工作簿缓存；Worker 内维护 `sourceRegistryId → SourceStyleRegistry` resolver，并为每个输出维护独立 `OutputStyleRegistry`。
- 普通路径、Worker、多输出和自动分页必须共用同一格式写入实现和同一预算检查。
- 任一路径失败都走第 5.3 节同一 prepare/publish/rollback 生命周期。

### 4.3 CSV

- CSV 没有来源样式、日期系统和行列布局。
- CSV 作为默认样式的伪 Sheet 参与既有文件/行顺序。
- 只保证原始词法值、长数字安全、前导零和禁止科学计数法。
- 不按表头猜测文本日期并强制转成 Excel 日期。
- CSV 继续使用现有整文件/整表加载，30 万行与 O(单行) 内存验收只适用于 XLSX；本 PR 不新增 CSV 文件大小限制，也不承诺大 CSV 不触发既有“文件过大”失败。
- 若未来需要大 CSV 保证，另立 streaming CSV reader Spec，覆盖 BOM、CRLF/LF、quoted newline、双引号转义、尾部空列和跨 chunk 状态机。

### 4.4 BIFF8 `.xls` reader 与样式 overlay

能力 probe 已确认当前 `xlsx@0.18.5` 与 `xlsx-js-style@1.2.0` 均能稳定读取 `.xls` 的值、公式缓存值、数字格式、填充、行列尺寸/隐藏/outline，但均不暴露字体、边框和对齐。本 PR 因此固定采用“双层读取”，不再把现有 `cellStyles` 返回值当作完整样式：

1. SheetJS 值层继续以 `raw:true/cellDates:false/cellNF:true/cellText:true/sheetStubs:true` 读取工作簿值、公式缓存值和既有匹配投影；
2. 项目自有只读 BIFF8 元数据层读取同一 OLE/CFB `Workbook`/`Book` stream；
3. 两层按 `BoundSheet8` 子流和零基 `{row,column}` 精确 overlay；
4. overlay 只补 `sourceStyleId`、有效样式所需 registry 元数据、显式空单元格和 Sheet/行/列布局，不覆盖 SheetJS 的值、类型、公式缓存值或 `matchValue`；
5. 任一有值单元格缺少预期 XF、Sheet offset/name 映射冲突、记录越界或两层坐标集合不一致时，整文件 fail-closed。

BIFF8 元数据层至少解析并建立边界校验：

- global 与 worksheet `BOF/EOF`、`BoundSheet8`、`Date1904`、`CodePage`；
- `Format`、`Font`、`Palette`、`XF`、`XFCRC`、`XFExt`、`Theme`；
- `Dimensions`、`DefaultRowHeight`、`DefaultColWidth`、`StandardWidth/DxGCol`、`ColInfo`、`Row`；
- `Blank`、`MulBlank`、`Number`、`RK`、`MulRK`、`Label`、`LabelSst`、`RString`、`BoolErr`、`Formula` 等带 XF 的 cell record；
- BIFF logical record 的 `Continue` 拼接和字符串边界；
- 文件加密标记、记录长度、worksheet offset 和 CFB stream 边界。
- 存在 `XFExt` 时必须存在 `XFCRC`，不存在 `XFExt` 时不得出现孤立 `XFCRC`；`XFCRC.cxfs` 必须与 XF 数量一致，并按 MS-OSHARED `MsoCrc32Compute`（多项式 normal `0xAF`、MSB-first、初值 0、无最终异或）顺序校验全部 XF payload。CRC 不一致时整文件失败，防止把过期扩展样式套到错误 XF。
- `fHasXFExt` 只属于 Cell XF，必须与该 Cell XF 的实际 `XFExt` 双向一致；Style XF 的同一 bit 是 `reserved2`，必须为 0，但 Style XF 仍可按规范拥有 `XFExt`。不得把 Cell XF 规则误套给 Style XF 并拒绝合法文件。
- BIFF8 `Format` 的低编号物理权威区间固定为 `5–8`、`23–26`、`41–44`、`50+`；其余 `0–49` canonical built-in 受到保护，冲突记录整文件失败。只有实际存在物理 `Format` 的有值单元格需要与 SheetJS `cell.z` 精确一致，未声明物理格式的 id 14/37 等 locale 表示差异不得误拒。
- `Number`、`Formula` numeric cache、`RK/MulRK` 的 `NaN/±Infinity` 必须失败；Formula special cache 与 `BoolErr` 的类型、reserved bytes、boolean/error 值域必须按 BIFF8 契约校验。`Font` 的压缩/未压缩 `ShortXLUnicodeString` 都必须按 flag 和边界解析。
- worksheet/macro Sheet 必须恰好包含一个 14-byte `Dimensions`。其行列范围按半开区间 `[rwMic,rwMac)` / `[colMic,colMac)` 解释，合法最大末端分别是 `65536` / `256`，空 Sheet 可为 `0,0,0,0`；reserved 非零、缺失、重复、反向或 Row/cell 超出范围均整文件失败。`Dimensions` 不限制只描述列布局的 `ColInfo`。
- `Row.reserved1` 和其它 reserved 位必须符合 BIFF8 契约，非零不得继续输出。
- 为兼容 LibreOffice 的 Excel 97 导出器，`ColInfo.colLast=256` 只作为“延伸到 BIFF8 最后一列”的终止哨兵接受，并在解析层立即规范化为闭区间末列 `255`；`firstColumn=256`、`colLast>256`、反向范围仍失败，任何下游输出不得创建第 257 列。

样式映射固定覆盖：

- 自定义/内置 `numFmt`；
- 字体名称、字号、粗斜体、下划线、删除线、vertAlign 和颜色；
- pattern/solid 填充和 palette 颜色；
- 左/右/上/下边框样式与颜色；
- 水平/垂直对齐、换行、旋转和缩进；
- grid 层按“显式 cell Cell XF → row 自定义 Cell XF → column Cell XF → workbook 默认 Cell XF”选择整套 XF；parent Style XF 只做合法性/血缘校验；
- 行高、行隐藏/outline、列宽、列隐藏/outline；
- `StandardWidth/DxGCol` 存在且有效时作为无 `ColInfo` 列的精确默认宽度，否则回退 `DefaultColWidth`；
- 合法的零宽列和 `DefaultRowHeight.fDyZero=1 + height=0` 不得因 falsy 判断回落为可见默认布局。OOXML 无法直接表达 BIFF8 `defaultColWidth=0` 时，统一等价投影为 BIFF8 全列 `0..255` 隐藏，再按后续显式 `ColInfo` 覆盖；显式 `coldx=0` 同样输出为隐藏列。默认隐藏行使用正数 `defaultRowHeight`（来源为 0 时取 15）+ `zeroHeight=1` 表达，禁止写出同版严格 reader 会拒绝的 `defaultRowHeight=0`；XLSX reader/统一模型必须继续识别该属性，隐式数据行继承默认隐藏状态。输出列上界仍固定为 BIFF8 第 256 列。
- 1900/1904 日期系统和公式缓存值。

输入边界：

- 本 Spec 的 `.xls` 指 OLE/CFB 中 BIFF8（Excel 97–2003）工作簿；扩展名不决定格式，必须按 magic 与 BOF version 验证。
- BIFF2–5、加密工作簿、损坏/截断记录、XML Spreadsheet 2003 伪装 `.xls` 以及无法解释的必需 `XFExt` 颜色类型必须返回明确错误，提示另存为标准 Excel 97–2003 `.xls` 或 `.xlsx`；不得生成默认样式结果。
- 运行时不得调用或要求安装 LibreOffice、Excel COM、WPS 或其它外部桌面程序；probe 中的 LibreOffice 只用于生成测试 fixture。
- `.xls` 保持现有整工作簿加载特性，本 PR 不对大 `.xls` 宣称流式或 30 万行内存保证；但 overlay 的索引必须限制为参与 Sheet 的显式 cell/row/column 元数据，不得保留重复原始 record buffer。
- `.xls` 输出仍为工具箱既有 `.xlsx` 产物；验收比较的是值、可见静态格式与布局等价，不要求输出继续为 BIFF8。

## 5. Writer

### 5.1 写入顺序

ExcelJS 流式 writer 在首行提交后不能可靠补齐列属性，因此固定顺序为：

1. 创建临时工作簿；
2. 创建 Sheet；
3. 写入基准列布局；
4. 写入基准表头行和表头样式；
5. 逐行写入数据值、行元数据和单元格样式；
6. 达到分页阈值时以同一顺序创建下一 Sheet；
7. 完成 writer；
8. 严格解析临时产物的 `[Content_Types].xml`、package root `_rels/.rels`、`workbook.xml`、
   `workbook.xml.rels`、`styles.xml` 和 workbook 声明的全部 worksheet，且必须完整闭合；
   `[Content_Types].xml` 必须包含正确的 `rels` Default；package root 必须恰有一个 internal
   `officeDocument` relationship 且规范化后指向 `xl/workbook.xml`；package root 与 workbook
   中全部 internal relationship 的规范化 Target 必须位于包内并指向实际存在的 ZIP part。
   同时复核 worksheet 与 Content Type/relationship/ZIP entry 形成严格闭包、无重复/缺失/游离
   声明，并精确核对 writer 返回的 Sheet 数、每页 `normalizedHeaders`、物理行数和数据行总数；
   结构扫描前后的整文件 size/hash 必须一致；
9. 所有输出均通过后，进入 5.3 的整批可回滚发布。

### 5.2 值与样式

- 单元格值类型和样式分别处理，不能为了复制样式把所有值转成字符串。
- 公式继续扁平化为缓存值，不复制公式表达式。
- 数值、布尔、错误值和文本按可支持的原生类型写入。
- 所有表头和数据文本写入前执行统一 ST_Xstring 安全编码与 32,767 UTF-16 code unit 上限检查；控制字符、CR/DEL 和字面 escape 必须往返不变，无法保真的 Unicode 非字符或未配对代理项整批失败，禁止截断。
- 写入样式对象必须来自规范化签名缓存，禁止每个单元格创建一份语义相同的新对象。
- 表头不再硬编码 Courier New 或按英文列名重套格式；使用基准来源样式。
- “禁止科学计数法”和长数字精度规则优先级高于来源 `General` 或显式科学计数 `numFmt`；其他视觉属性继续继承。

### 5.3 Prepare、发布、回滚与恢复

多个目标路径不存在文件系统级原子提交能力；本 Spec 的准确承诺是“先整批准备与校验，再可回滚发布”，不得写成“一次性原子替换”。

Prepare/validate：

- writer 的 generation temp 可沿用系统临时目录；正式发布前，每个已验证产物必须复制到目标目录
  同文件系统的 task staging 区，并再次校验大小/哈希或结构。publish 只从该 staging 区通过
  同目录 hardlink no-replace 协议发布，禁止退回会覆盖既有路径的普通 rename。
- writer 写后复核返回的 `byteSize + SHA-256` 是 generation 的验证身份；publication prepare
  必须重新计算并与该身份精确一致，随后 staging 也必须与同一身份一致。校验完成后即使仅发生
  “同大小换内容”，也必须拒绝发布。
- 这样合并入口可保持现有“先生成、后弹保存框”时序，不要求为了同目录 hardlink 提前改变 UI；
  跨文件系统 staging copy 失败仍属于 prepare 失败。
- 全部 writer、结构复核和样式预算均成功前，不触碰任何正式目标。
- prepare 失败只删除没有恢复价值的本任务生成文件，不改动用户已有文件。
- preflight 必须按统一 alias 规则对固定 index、journal、全部 target/staging/backup 建立全局闭包；
  任何跨项碰撞都须在 index/journal/staging 写入前零副作用拒绝。artifact 不得与上述路径重合，
  正式 target 也不得位于任一 artifact 的 generation 父目录内，避免发布成功后 finally 递归删掉
  正式结果。
- 生产环境中的 generation/target/staging 全文件哈希、staging copy、fsync 和恢复必须在
  单一 FIFO publication Worker 中执行，不得占用 Electron 主事件循环。主进程只负责对话框、
  排队、节流进度和结果处理；同一发布任务的 prepare 与 publish 必须在同一 Worker 生命周期
  连续完成。

Publish：

1. 预检目标路径互不重复，目标不存在或为可覆盖普通文件，父目录可写，并完成上述全局路径闭包；
   保留现有“覆盖全部”交互。
2. 在任何 staging byte 落盘前，先在固定
   `{userData}/toolbox-publish-journal-index.json` 原子登记 `preparing` intent；该条目必须包含
   `taskId / nonce / journalAbsolutePath / stagedAbsolutePaths / targetAbsolutePaths /
   backupAbsolutePaths`，使新进程仅凭固定恢复根即可定位 copy 中断产生的部分 staging，并固定
   后续恢复允许触碰的全部 task-managed 路径。
3. 在输出目录持久化 `status=preparing` 的外部任务 journal，记录已验证 generation 身份、
   原目标快照、staged/target/backup、阶段和每项状态；journal 自身使用临时文件 + rename 更新。
4. 复制全部 generation 到同目录 staging，逐文件 fsync 并用相同 size/hash 复核；再把 journal
   标记 `prepared`，最后把固定 index intent 原子更新为 `prepared`。只有 index 与外部 journal
   均完整 prepared 后才允许触碰正式目标。
5. 对已存在目标使用 `linkSync(target, backup)` 原子创建同目录 task-specific backup；若 backup
   已存在或文件系统不支持 hardlink，立即 fail-closed，禁止 fallback。link 及目录 fsync 后，
   必须用 `lstatSync(path, { bigint:true })` 取得精确 `dev + ino`，确认 source 与 backup 仍是
   同一普通文件后才允许 unlink source。`dev/ino` 不是 bigint、`ino <= 0` 或运行环境不支持精确
   identity 时一律 fail-closed 并保留两端；不得把默认 Number Stats 或无效 inode 当成可信相等。
   若 source 已被替换，保留两端并转人工恢复。link 后/unlink 前崩溃时，恢复可识别双 hardlink
   并保留原目标。
6. 对每个 staged 文件，在发布紧前统一断言 target 仍不存在，再调用
   `linkSync(staged, target)`；`EEXIST` 是 syscall 边界的原子 no-replace 失败，必须保留未知 target。
   link 及目录 fsync 后同样以精确 bigint `dev + ino` 复核 source/target，仅身份一致才 unlink
   staging；身份不可用或不支持 hardlink 必须 fail-closed，且不得退回 rename/copy 覆盖。目录
   fsync 和单项 size/hash 校验成功后，才更新该项 published 状态。rollback 的
   `backup → target` 恢复也必须复用同一 no-replace 原语。
7. 全部 staged 发布和单项 published 更新完成后，journal 仍保持未 committed；必须对整批
   target 再做一次 size + SHA-256 最终复核。任何单目标或先前已发布目标发生漂移，都进入现有
   rollback/manual-recovery，禁止返回 committed，且不得删除身份未知的外部改写内容。
8. 整批最终复核通过后才在外部 journal 标记 committed；随后删除 backup/staging，把固定 index
   原子更新为 `finalizing`，删除并 fsync 外部 journal，最后才从固定 index 移除任务。
   journal 删除失败时 finalizing intent 保留并重试；journal 已删除但 index 删除失败/崩溃时，
   新进程允许仅凭 finalizing intent 移除残留 index，绝不回滚 committed target。
   最终复核后不得再暴露可返回的测试 checkpoint，必须立即耐久写 committed；本协议通过原子
   no-replace、源/目标 inode 身份复核与 committed 前整批哈希收窄竞态，但不宣称提供跨进程文件锁
   或条件 unlink 意义上的绝对零窗口。
9. 单输出、普通拆分、大文件拆分和多输出全部复用同一异步 publish dispatcher；禁止主进程继续直接执行同步 publication core。

失败/恢复：

- 捕获到发布失败时，逆序清理本任务已发布的新文件并通过 no-replace 恢复所有旧文件 backup；
  恢复路径被并发创建时不得覆盖，必须保留 backup 并转人工恢复。
- `preparing` intent 的恢复只允许删除该 intent 中随机命名的 staging 和对应 journal，再移除
  index 条目；该阶段绝不触碰正式 target。即使 staging 只复制了一部分，也必须可由新进程发现
  并清理。
- 对所有带 `discoveryState` 的新式 index，恢复任何 journal 状态前必须严格校对
  `taskId / nonce / userDataDir / entry 数`，以及逐项 `stagedPath / targetPath / backupPath`
  与 index 锚点。任一不一致必须返回 manual-recovery，且在失败前不得触碰任何
  target/staging/backup。无 `discoveryState` 的存量 v1 index 因没有可信路径锚点，publish 与
  跨进程 recovery 一律 manual-only：只展示固定 index/journal 绝对路径，不得自动读取 journal
  后修改任何 target/staging/backup。
- `readIndex` 校验的全局 managed-path set 必须预先包含固定 indexPath 自身；任何新式
  journal/target/staging/backup 与固定 indexPath alias 的损坏或篡改，都须在读取恢复根阶段
  fail-closed，不能等到 journal 执行后才发现。
- prepared 取消前必须先把固定 index 耐久更新为 `cancelling`；完整 rollback 后必须先持久化
  `status=rolled-back` 并把固定 index 更新为 `rollback-finalizing`。两条路径都只允许按
  “逐个删除 staging 并 fsync 各自父目录 → 删除并 fsync journal → 最后移除 index”的顺序
  收尾；journal 删除失败或 journal 已删但 index 删除失败时，下次启动仍必须仅凭固定恢复根
  继续清理，禁止产生不可发现的孤儿 journal/staging。
- `finalizing` intent 只表示 committed target 已完成、backup/staging 已安全清理；恢复只允许
  删除仍存在且身份一致的 committed journal，再移除 index。journal 已不存在时可直接移除
  finalizing index，不得按“缺 journal”转人工恢复或回滚正式结果。
- 正式目标已经 durable committed 后，generation temp 目录清理属于独立收尾。`EPERM`、
  `EBUSY` 或其它删除异常只写入活动日志告警并保留临时目录，不得把成功结果改成 failed、
  不得提示用户重复发布，也不得进入业务错误报告。
- rollback 完整：清理无恢复价值的生成临时文件，返回失败。
- rollback 不完整：必须保留 journal 和仍有恢复价值的 backup，错误明确返回绝对恢复路径；不得为了“目录干净”删除用户旧文件的唯一副本。
- 进程崩溃可能在下次恢复前短暂留下部分 target；应用不得报告成功。下次启动或下一次工具箱任务必须先读取固定 index，逐一定位外部 journal 并完成回滚/收尾，再允许新任务；不得尝试扫描用户所有目录。
- publication Worker 若在未返回结果前异常退出，dispatcher 必须在同一 FIFO 队列项中先启动
  recovery Worker；自动恢复完成后才向调用方返回失败，后续排队任务不得越过恢复。若恢复本身
  失败，错误必须跨线程保留 `recoveryPaths` 与 `preserveTemporaryFiles`。
- 任一 `ToolboxPublicationManualRecoveryError` 必须默认
  `preserveTemporaryFiles=true`；可读 journal 的恢复路径还须包含 artifact/generation 绝对路径。
  该字段跨 Worker 序列化后由合并、多拆、大文件单拆、普通单拆四入口统一消费，人工恢复完成前
  不得由 main 的 finally 删除 generation 目录。
- 启动恢复失败时不得继续注册业务 IPC 或创建可操作窗口；启动失败对话框必须直接展示错误明细、
  人工恢复绝对路径和日志位置，随后退出，禁止把阻断推迟到用户下一次点击发布。
- index 指向的 journal 缺失/不可读时，保留 index 项并输出可操作的恢复错误，不能静默当作已成功；人工确认目标/backup 状态后才允许清除。
- 若产品要求“崩溃窗口内也绝不出现部分正式路径”，必须把输出契约改为单一结果目录/压缩包的原子 rename，另立 UI 与路径 Spec；本 PR 不暗示已做到。

## 6. 日期系统

### 6.1 内部模型

不得使用本地时区 `JS Date` 承载或转换 Excel 数值日期。

数值日期保存为：

```javascript
{
  rawSerialDecimal: '45292.5000000000',
  dateSystem: 1900 | 1904,
  numFmt
}
```

- `rawSerialDecimal` 是 canonical decimal string/十进制定点对象，JS `Number` 不得作为权威值；1904→1900 用十进制加法完成。
- 允许区间内存在物理 numFmt/Format 声明时必须先使用物理格式码；否则 built-in numFmt id 解析到 canonical 标准格式码，自定义格式保留原码。
- 唯一 `classifyExcelNumberFormat(code)` 必须正确跳过引号文本、反斜杠转义、颜色/条件段，并识别日期/时间 token、AM/PM 与 elapsed time；至少覆盖 built-in 14、22、45–47 和 `[h]:mm`。
- 只有“源类型为数值且有效 `numFmt` 分类为日期/时间”时，才按 Excel 数值日期处理。
- OOXML `t="d"` 解析为无时区 wall-clock calendar tuple：保留词法中的年月日时分秒，不因 `Z/±hh:mm` 在不同机器上平移显示值；用纯 Gregorian 算法转换为 1900 serial。超出 Excel `1900-01-01` 至 `9999-12-31` 可表示范围时，固定降级为 ISO 文本并进入第 6.3 节有界 warning summary，不得使用本地 `Date` 或自行丢值。

### 6.2 输出

- 输出工作簿统一使用 1900 日期系统。
- 1900 来源序列原样保留，包括 Excel 兼容序列 60。
- 1904 来源序列加 1462；小数日部分原样保留。
- 文本日期继续保持文本和原词法值。
- 数值日期继续写数值 serial，并复制来源日期/时间 `numFmt`。
- 数值日期完成 1904→1900 转换后若无法表示为有限 JS number，不得写出 `Infinity/NaN`；固定按 canonical decimal 文本 + `@` 安全降级，并进入同一中性 warning summary。
- UTC、Asia/Shanghai、America/New_York 三种时区运行时，输出 serial 和显示日期必须一致。
- 打开产物时不得裸显示 `45292` 等日期序列号。

### 6.3 日期安全降级告警

所有输出路径统一累计：

```javascript
{
  warningCount: 123,
  warningSamples: [
    {
      code: 'toolbox-date-text-fallback',
      sourceFileName,
      sourceSheet,
      cellRef,
      message
    }
  ]
}
```

- `warningCount` 统计全部降级单元格；`warningSamples` 最多保留前 20 条，内存有界，不含完整敏感路径。
- 单/多输出 success IPC 必须返回同一 `warningSummary`（零告警也返回 `{warningCount:0, warningSamples:[]}`）；renderer 在非零时只展示一次“共 N 个日期单元格按文本保留”，并允许查看最多 20 条样例。
- 活动日志记录总数和同一批样例；不得逐单元格弹窗或无限收集。
- 降级本身不把成功任务改为失败，但不得无提示静默发生。

## 7. 数字、长 ID 与科学计数法

- 原始数字词法在完成安全分类前不得经过 JavaScript `Number`。
- 文本单元格保持文本，包括前导零。
- 先用十进制算法把普通/科学词法转换为 canonical plain decimal，并计算整数位数、scale、有效数字数和值域。
- 只有同时满足以下条件才写 number + 非科学 `numFmt`：
  - 源单元格语义类型本来是 numeric；
  - 有效数字不超过 Excel 15 位精度；
  - 非零整数位数不超过 15；
  - 数值在 Excel 可表示范围内；
  - number 往返 canonical 结果不变；
  - 所需非科学格式码长度不超过 `TOOLBOX_MAX_GENERATED_NUMFMT_CHARS = 240`。
- 任一条件不满足，固定写 canonical decimal text + `numFmt='@'`；这是精度安全降级，不按列名猜“账号/订单号”。
- `1e-300`、`1e308`、`1e20` 等即使有效数字少，也必须按上述值域、整数位和格式码长度判定，不能强造数百字符 numFmt。
- 负数、小数和极小数的符号及小数位必须保留。
- 来源为 `General` 或显式科学格式、且安全分类后需要生成非科学 `numFmt` 时，小数位数必须取 canonical 小数部分去除词法尾零后的**有效小数位数**，不得直接使用原始 scale。`1200000.0`、`1200000.00` 等整数语义必须生成 `numFmt='0'`，不得生成会把整数显示成 `1200000.` 的 `0.#` / `0.##`；仍有有效小数位时继续使用相应数量的可选 `#`。240 字符格式安全门禁仍按修剪前的 canonical 原始 scale 计算，禁止因输出格式缩短而把既有 text 降级边界放宽为 number；数值、精度门禁和非科学计数要求均不变。
- 源 `numFmt='000000'` 等有语义的非科学格式继续保留。
- 源显式科学格式不得导致最终可见值使用 `E/e`。
- 如果源 Excel 自身已经把超过 15 位的输入值舍入，工具只能保留文件中实际存储的词法值，不宣称恢复录入前已丢失的数字。

## 8. 样式组件预算与 prepare 失败

### 8.1 应用预算

预算以“预计最终产物组件数”为唯一口径，必须包含 writer 自带 default/base 项：

```javascript
TOOLBOX_STYLE_BUDGETS = {
  cellXfs: 50_000,
  fonts: 480,
  fills: 240,
  borders: 10_000,
  customNumFmts: 180
}
```

- 上述均为应用安全预算，不等同于 Excel 官方硬上限。
- [Excel 官方规格](https://support.microsoft.com/en-us/office/excel-specifications-and-limits-1672b34d-7043-467e-8e27-269d656771c3)列出：唯一 cell format/style 65,490、fill style 256、每工作簿 font 512、number format 约 200–250（随语言版本变化）；应用预算为 writer/default 项预留余量。
- border 的 10,000 是防异常膨胀的应用预算，不声称是官方上限。
- `projectedFinalCounts` 在注册 default/base 组件后起算；每注册一个规范化新 component/XF 前检查，`<= budget` 可继续，`> budget` 立即失败。
- 唯一 cell XF 数按最终复合签名计，不按源 `styleId`；fonts/fills/borders/custom numFmts 分别按规范化 component 签名计。
- 多输出拆分按每个输出文件分别计数。
- 不再同时维护“应用有效样式数可到 50,000”与“writer 另加 base XF 后才算实际数”两套真相。

### 8.2 失败行为

任一输出超限时：

- 停止全部 writer；
- 因预算发生在 publish 前，不触碰正式目标；
- 删除没有恢复价值的本次生成临时文件；
- 返回明确错误，包含：
  - 目标输出文件；
  - 来源文件、Sheet、单元格；
  - 超限 component；
  - projected count；
  - 对应预算。

不得：

- 静默丢样式；
- 自动降级成固定默认样式；
- 只发布未超限的部分文件；
- 把 writer default/base 项排除在预算外。

### 8.3 写后复核

正式发布前严格解析每个临时 XLSX 的 `[Content_Types].xml`、workbook、relationships、
`xl/styles.xml` 与全部已声明 worksheet：

- 复核实际 `cellXfs`；
- 复核实际 fonts、fills、borders 和 custom numFmts 数量；
- 验证应用缓存与 writer 实际生成结果没有异常膨胀；
- 验证每个实际 component count 未超过对应应用预算；
- 验证 workbook 声明、worksheet relationship、Content Type 与 ZIP entry 一一对应，不存在重复、
  缺失或游离 worksheet；
- 验证每个 worksheet XML 完整闭合、每页表头与 `normalizedHeaders` 一致、实际 Sheet 数和数据行
  总数与 writer 计数一致；
- 生成验证摘要 `byteSize + SHA-256`，并由 publication prepare 重新比对，关闭校验后替换临时
  产物的时间窗口；
- 结构/样式扫描前后分别读取整文件 size/hash，两次身份不一致即失败；publication 在 staging
  rename 成正式目标后、写入单项 published 状态前再次核对目标 size/hash，并在全部输出发布后、
  journal committed 前对整批 target 再做一次 size/hash 最终复核，禁止把后续被改写的先前目标
  或最后瞬间漂移的 staging/target 报告为 committed；
- 任一复核失败仍属于 prepare 失败，不进入 publish。

活动日志记录：

- 输入/输出有效行数；
- `projectedFinalCounts` 峰值；
- `cellXfs/fonts/fills/borders/custom numFmts` 实际数量；
- 是否触发安全预算；
- 每个输出的临时校验结果。

## 9. 验收测试

### 9.1 Sheet 参与规则

- 首个可见 Sheet 只有格式无值、第二个有数据：第二个成为合并基准。
- hidden / veryHidden 有数据、后续可见 Sheet 有数据：合并取后者。
- 表头-only Sheet 属非空并参与表头校验。
- `0` / `false` 有意义；空格和 style-only 无意义。
- 拆分回归证明隐藏 Sheet 参与语义未改变。

### 9.2 布局

- 无显式 `<col>` / `<row ht>` 时，`defaultColWidth/defaultRowHeight` 正确。
- 每页在首行提交前写入基准列宽、隐藏和 outline。
- 自动分页第 2 页及以后布局与表头一致。
- 数据行高、隐藏和 outline 来自来源行。
- 非基准来源的列布局不覆盖基准。

### 9.3 样式身份与主题

- cell XF / row XF / column XF 冲突按 fixture 锁定优先级，禁止逐属性拼装。
- 两个 source registry 都产生 `styleRef=1` 但样式不同：复合引用正确解码，输出不串样式。
- 两文件相同 `styleId`、不同定义：不得串色。
- 两文件不同 `styleId`、相同定义：必须去重。
- 不同主题中相同 theme index：输出实际颜色正确。
- indexed color、tint、字体、填充、边框、对齐、换行和旋转正确。
- 显式空单元格保留样式，隐式空白不产生推断值。
- 条件格式、rich text run、渐变填充和对角边框按明确排除降级，不得在验收中宣称保真。
- BIFF8 `.xls` 的 cell/style XF 继承、used-attribute flags、custom palette、automatic color 和 `XFExt` 颜色解析后与 Excel 可见结果一致。
- OOXML/BIFF8 低编号格式分区覆盖 `5/8/23/26/41/44/50/56/60/163` 物理声明正例，以及 `14/22/45–47` 冲突负例；SheetJS Date1904 的 id 60 自定义日期和 id 61 `000000` 必须保留。
- workbook/rels/worksheet/sharedStrings/styles/theme 分别注入截断和畸形 XML，全部明确失败；截断 workbook 不得少处理 Sheet，截断日期 XF 不得退成 General，截断 theme 不得换成默认主题色。
- workbook/rels/styles/theme 分别覆盖中央目录超限和读取时实际 byte 超限；高压缩 32 MiB 级 metadata fixture 必须在 inflate 前失败。
- 重复 relationship id、重复 Sheet `r:id`、重复 worksheet entry path、缺失/非 worksheet/external relationship 均 fail-closed。
- font/fill/border 中显式非法 RGB、theme/indexed 越界、tint 越界及多种颜色来源冲突均 fail-closed；`auto` fallback 单独通过。
- BIFF8 两层 overlay 中 Sheet offset/name、坐标或 XF index 任一不一致时整文件失败，禁止回落到 SheetJS 的 fill-only 样式。

### 9.4 日期

- 1900 serial 59 / 60 / 61。
- 1904 serial 0 / 1。
- 含时间小数。
- 混合 1900 / 1904 来源。
- 三种 TZ 产物 serial 一致。
- 文本日期不转型。
- OOXML `t="d"` 在三种 TZ 下显示 wall-clock 不漂移；超范围时按固定文本降级，`warningCount` 全计数、samples 截断 20，success IPC/renderer/活动日志一致。
- `0 "m"` 等含字面量日期字母的数字格式不得误判为日期；覆盖 built-in 14/22/45–47、AM/PM 与 `[h]:mm`。
- 数值日期保持来源显示格式且不裸显示 serial。
- BIFF8 `Date1904` 为 0/1 的 fixture 分别覆盖边界 serial 和含时间小数；SheetJS 值层与 BIFF8 numFmt/date-system overlay 后不得发生二次日期偏移。
- date-like `1e309/-1e309` 不得在 worksheet XML 出现 `Infinity/NaN`，必须输出 canonical 文本 + `@` 并计入中性日期降级提示。

### 9.5 数字

- `1E+20`、`1e-7`。
- `1e-300`、`1e308`。
- `100000000000000000000` 与超长 scale 边界。
- 15 位和 16 位整数。
- 前导零。
- 负数。
- 多小数位。
- General 整数尾零词法：worksheet 原始 `<v>1200000.0</v>`、来源 `numFmt='General'` 时，输出必须保持 numeric `1200000`、可见值 `1200000` 且 `numFmt='0'`，不得生成 `0.#` 或显示末尾小数点；同时覆盖 `.00`、负数、零、非零有效小数和科学词法，并锁定 240/241 字符格式长度边界在尾零修剪前后保持相同的 number/text 分类。
- `numFmt='000000'`。
- 源显式科学格式。
- 同时检查 XML 单元格类型、原始值、`numFmt` 和 Excel/WPS 可见显示。
- SST/inline/`t=str` 分别覆盖 `_x/_X` escape 解码、字面 escape 保护、rich run 边界不串联、NUL/C0/CR/DEL 往返；文本 32,767 UTF-16 code unit 边界通过，32,768、未配对 surrogate、`U+FFFE/U+FFFF` 明确失败且正式目标零变化。
- `<v>/<t>` raw 上限、rich run 累计语义上限及 8,192 formula 上限在 SAX 累积阶段触发，不能先把超长 cell 物化到内存。

### 9.6 样式预算

- `projectedFinal cellXfs` 49,999 / 50,000 / 50,001 边界，包含 base/default XF。
- 用可注入小预算分别制造 font/fill/border/custom numFmt 超限，而 cellXfs 尚未超限。
- 多输出中仅一个文件超限，仍在 prepare 阶段整次失败且不触碰正式目标。
- 写后 `styles.xml` 每个实际 component count 与预算检查一致。

### 9.7 发布与恢复

- prepare success / validation failure / 0 命中 / 保存取消均清理所有可安全删除的 task 临时文件。
- 合法产物分别注入截断 `[Content_Types].xml`、workbook、worksheet、缺失分页 Sheet、错表头、
  少数据行和游离 worksheet；写后复核必须失败且不得发布。
- 删除 `_rels/.rels`、删除/篡改 `rels` Default、构造零个/多个/外部或错误 Target 的
  `officeDocument` relationship，以及在 package root/workbook relationships 中构造越界或
  指向不存在 part 的 internal Target；写后复核均必须 fail-closed 且不得发布。
- writer 校验完成后以同大小不同内容替换 generation，publication prepare 必须因 size/hash 身份
  不一致失败，正式目标保持原样。
- 在 writer 结构扫描与最终摘要之间同大小替换文件，前后 size/hash 必须检测漂移；在 staging
  发布后、journal published 状态前改写正式目标，任务不得返回 committed，且外部改写不明时
  必须保留 backup/journal 与人工恢复路径。
- prepare 时不存在的 target 若在 `publish:before-publish` 后或 `linkSync` 原语内部被并发创建，
  stage→target 必须以 `EEXIST` fail-closed，未知文件逐字节保留；target→backup 与
  rollback backup→target 也分别注入 syscall 边界并验证不覆盖未知路径。不支持 hardlink 时整批
  失败且不得 fallback；link 后替换 source 必须由 `dev + ino` 复核发现且不得 unlink 未知 source。
- hardlink 建立后分别注入 `ino=0` 和两个大于 `Number.MAX_SAFE_INTEGER`、经 Number 舍入会碰撞
  的相邻 inode；身份不可用时必须 fail-closed，相邻 64-bit identity 必须精确区分，未知 source
  不得被 unlink。
- 分别在 target→backup 与 stage→target 的 link 已耐久、source 尚未 unlink 时模拟崩溃；新进程
  必须识别同 inode 双链接，回滚旧 target 并清理 task-owned 重复链接。
- 单目标在 `publish:after-publish` 被无异常改写，以及多目标后续发布期间改写先前目标，均必须由
  committed 前整批最终复核发现。
- 分别在最后一项 `publish:after-publish` 与 `publish:before-final-target-verify` 模拟崩溃；
  两者 journal 均保持未 committed，新进程必须回滚旧目标，不能按 committed/finalizing 收尾。
- 单文件与多文件覆盖既有目标成功。
- 第 N 个正式文件 no-replace 发布失败时，新文件逆序清理、原文件从 backup 恢复。
- 注入 rollback 恢复失败时保留 recovery backup 与 journal，并向用户返回绝对路径。
- 在 `prepare:after-index-before-journal`、`prepare:after-preparing-journal`、部分 staging copy、
  `prepare:after-staged`、`prepare:after-journal` 分别模拟崩溃；新进程必须只通过固定 index 找到
  任务，删除部分/完整 staging 和 journal，保持正式目标逐字节不变。
- 模拟进程崩溃后，新进程只通过固定 `{userData}` index 找到任意外部目录 journal 并恢复；恢复前不报告上次成功。
- publication Worker 在正式目标 hardlink 发布后、journal 状态更新前异常退出：dispatcher 必须先运行
  recovery Worker 恢复旧目标，再向调用方报告失败；同一时刻排队的下一任务只能在恢复后开始。
- committed 后分别注入 journal 删除失败，以及 journal 已删但 index 删除失败；两种情况固定
  index 都必须保持 `finalizing` 可发现状态，下次恢复只做收尾且保留新正式目标。
- committed 成功返回后的 generation temp 删除分别注入 `EPERM` / `EBUSY`；四个入口仍返回
  success，只生成一条可观测活动日志告警，不显示黄色业务 warning、不写业务错误报告。
- prepared 取消和完整 rollback 分别注入 journal 删除失败；固定 index 必须保持 `cancelling` /
  `rollback-finalizing`，下一次恢复能完成收尾且不触碰外部 target。
- 多目标分别保存到不同目录时触发 prepared 取消；每个 staging 删除后都必须 fsync 对应父目录，
  再删除 journal/index。rollback 三个 terminal-intent/index/journal 收尾失败窗口返回的人工恢复
  路径都必须包含可读 journal 中的 artifact/generation 绝对路径。
- 崩溃后把新式 prepared journal 的 target 重定向到同目录、与 generated 同 hash 的 victim；
  恢复必须先因 index/journal 锚点不一致进入 manual-recovery，不得删除 victim，也不得触碰
  原 target、staging 或 backup。把同一 fixture 降为无 `discoveryState` 的 v1 后，publish/recovery
  必须 manual-only，并验证即使 journal 指向同 hash victim 也保持 index/journal/全部 managed file
  逐字节不变。
- 构造 target=固定 index、跨项 target=另一项 staging、artifact=target、target 位于 artifact
  generation 目录；全部必须在 index/journal/staging 写入前失败，正式结果与生成源均零变化。
- 用真实 publication Worker 发布大产物时主进程 heartbeat 持续运行；两个同时提交的
  publish/recover 作业严格 FIFO，最大并发为 1。
- 外部 journal 丢失/损坏时固定 index 不被静默清除，新任务被阻断并返回可操作错误。

### 9.8 匹配值双轨

- `rawHeaderCells` 只提供来源静态样式；实际表头文本继续写 `normalizedHeaders`，trim 行为不变。
- 普通 XLSX 旧路径先生成权威 golden；`1` / `1.0`、`001`、布尔、错误值、数值日期、文本日期的 `toMatchValue` 与其一致。
- 旧 Worker 若与普通 XLSX golden 分叉，修订后有意收敛到普通路径并用行为变更测试锁定；CSV/XLS 各自保持 fallback golden。
- `split:read` 返回的每个选项，在未修改源文件时都能被 `split:export` 命中原行。
- 输出值/类型变化不得反向污染 `matchValue`。
- `.xls` 加入 BIFF8 style overlay 前后，既有 fallback golden 的表头、下拉值、筛选命中和输出行集合完全一致。

### 9.9 Worker IPC

- parent→worker 只含控制参数；worker→parent 只含节流进度、错误和汇总结果。
- message 数量不随数据行数线性增长，payload 不含 rows/cells/styles。
- Worker 内部与普通路径使用同形复合 source ref；每个输出 registry 独立去重和计预算。

### 9.10 路径矩阵

- XLSX 合并。
- 普通单 Sheet 拆分。
- 多 Sheet Worker 拆分。
- 单输出和多输出。
- 自动分页。
- CSV 默认样式与词法值。
- 大 CSV 明确保持现有全量路径，不纳入 30 万行内存验收。
- BIFF8 `.xls` 合并、普通单/多 Sheet 拆分、单/多输出和自动分页；若现有 dispatch 对 `.xls` 不使用大文件 Worker，则测试必须锁定该既有分流，不能为凑矩阵伪造 Worker 路径。
- BIFF8 `.xls` fixture 至少覆盖所有列举 style component、Blank/MulBlank/RK/MulRK/Formula cell record、自定义 palette、XF 继承、隐藏 Sheet/行/列、1900/1904 和公式缓存值。
- BIFF2–5、FILEPASS 加密、损坏 BoundSheet offset、越界 record length、未知必需 `XFExt` 颜色类型和 overlay 坐标/XF 不一致均 fail-closed，正式目标零变化。

### 9.11 性能

- 30 万行 XLSX、低样式基数：记录峰值 RSS 和耗时，证明内存不随行数线性积累。
- 30 万行 XLSX、高样式基数：记录样式字典增长，并在预算处可控失败。
- 多文件混合主题与混合日期系统：不得回退整表加载。

## 10. 实施顺序

1. 保留 `.xls` capability probe 作为基线证据，并建立 BIFF8 record scanner/overlay 的独立 fixture 与 fail-closed 测试。
2. 建立 `ToolboxCell / ToolboxRow / ToolboxSheetMeta`、source/output registry 与复合 ref、普通 XLSX 权威 `toMatchValue` golden 和纯函数样式规范化测试。
3. 实现 XLSX 工作簿目录、样式、主题和日期系统一次性解析。
4. 实现 BIFF8 global/worksheet record scanner、XF/palette 有效样式解析及与 SheetJS 值层的严格 overlay。
5. 先分别贯通最小 XLSX 与 BIFF8 `.xls` 单 Sheet 拆分端到端，证明两者汇入同一 writer 且 `.xls` 匹配值不漂移。
6. 接入合并、普通多 Sheet、Worker 内部路径、多输出和自动分页。
7. 实现数字/date1904/`t=d`/主题或 palette ARGB/组件预算和写后 XML 复核。
8. 接入 CSV，并完成 `.xls` 全入口与非法/加密/损坏输入矩阵。
9. 统一单/多输出 publish helper、固定 journal index、外部 journal、rollback 与恢复。
10. 接入日期降级有界 summary、success IPC/renderer 和活动日志。
11. 执行路径矩阵、30 万行 XLSX 性能测试、Excel/WPS 人工打开验收。
12. 更新 CHANGELOG、版本历史和用户手册，执行 `npm run release-check` 与 `npm run check:vars`。

## 11. 风险与人工验收

### P0

- 把合并的可见过滤误套给拆分，导致隐藏 Sheet 数据静默丢失。
- 直接复制 theme index，跨工作簿颜色串线。
- 使用本地 `Date` 导致日期跨时区或 1900/1904 偏移。
- 只修普通路径，漏掉 Worker、多输出或分页路径。
- 任一输出失败却被报告为整批成功，或 rollback 不完整时删除了唯一 recovery backup。
- BIFF8 overlay 与 SheetJS 值层错位后仍继续输出，导致样式串行或值/格式错配。

### P1

- 把任一应用预算错写成 Excel 官方硬上限，或漏计 writer default/base 项。
- BIFF8 record scanner 漏处理 `Continue`、Mul* cell record、XF 继承或自定义 palette，却回落成默认样式。
- 样式签名按源 `styleId` 去重，造成不同工作簿样式误合并。
- 先转 Number 再恢复长数字，造成不可逆精度损失。

### 人工验收

- 使用包含真实日期、长账号、主题色/BIFF8 自定义 palette、隐藏行列和多样式的脱敏 `.xlsx` 与 BIFF8 `.xls` 工作簿。
- 分别用 Windows Excel 与 WPS 打开。
- 核对可见格式、日期、长数字、分页、隐藏布局和无修复提示。
- 自动 XML/回读测试不能替代最终 Excel/WPS 人工打开验收。

### 发布准备状态（2026-07-30）

- PR #104 与尾随小数点修复 PR #105 均已合入 `main`。
- 用户已明确确认人工验收通过；该确认作为 Windows Excel/WPS 人工门禁的签字证据，不扩写未提供的样本明细。
- 合并后干净依赖环境的 `release-check`、主页面对齐、重要变量扫描和生产依赖审计均已执行；正式 tag 与 GitHub Release 仍须由不可变 Windows 发布工作流完成。
- FAT 或部分网络盘不支持 hardlink 时仍按既定契约在改动正式目标前安全失败，不因人工验收而放宽或增加覆盖型 fallback。
