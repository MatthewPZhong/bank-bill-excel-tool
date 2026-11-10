# TechDoc — 工具箱合并 / 拆分提速

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.16（暂定，用户未指定） |
| 功能分支 | `perf/toolbox-merge-split-speed`，基于正式标签 `v3.2.15`（`5b5caf7b`） |
| 日期 | 2026-11-09 – 2026-11-10 |
| 状态 | 已实现，待 PR 审查与 Windows 真实文件回归（B76） |
| 依据 | 用户反馈：从 3.0.18 升级后工具箱合并、拆分明显变慢；用户要求处理速度快于 3.0.18。无业务语义或契约变更，不另立 spec |
| 格式来源 | `changes/v3.2.16/feat/mapping-feature-filter/techdoc.md` 的章节组织（按本任务规模精简） |

以符号名为准，行号会随后续提交变化。

## 一、目标与范围

只做等价提速：合并、拆分（单值 / 多文件 / 读字段）以及共用同一扫描器的 VCC、BizOP 输出复核、模板资源、头寸对账读取，输出文件内容、报错文案、样式预算与校验行为不变。目标：同机同文件下四项操作都快于 v3.0.18。

分两轮实施：第一轮（T1–T6）替换 sax、缓存写入样式；第二轮（T7–T13）加快路径、削减逐单元格分配、数值分类提速、复核只构造表头行、共享空行样式、读字段免第二次扫描、加大解压分块。

不在范围：写后整份复核的必要性、ExcelJS 写出本身、发布与存档阶段（登记 B75）。

## 二、根因

在同一台机器、同一份 10 万行 × 20 列 xlsx 上对比 v3.0.18 与 v3.2.15 的同一代码路径（不含对话框、发布、存档）：合并 2×10 万行 7.3s → 66.1s，读字段 1.5s → 11.1s，单值拆分 1.8s → 14.3s，8 份多文件拆分 2.0s → 15.6s。v3.1.1 → v3.1.2 同一组 2×2 万行合并 1.5s → 16.6s，跳变点在 v3.1.2 格式保真（`12f977f6`、`57a3b4d6`）。CPU profile 结论：

1. 读取：`xlsx-sheet-scanner.js` 用 `sax.createStream(true, { xmlns: true })` 逐字符解析，sax 自身约占扫描 60%；共享字符串表同样走 sax。
2. 写入：`toolbox-output-writer.js` 每个单元格都调用 `OutputStyleRegistry.register`（规范化 + canonical JSON 签名 + deepFreeze），且每格持有新的样式对象，ExcelJS 的 `addStyleModel` 按对象身份去重的 WeakMap 永不命中，每格重新渲染字体 / 边框 / 填充 XML。两者约占写入 80%。
3. 写后复核：`commitAndValidate` 用同一扫描器整份重读输出，放大了第 1 项。
4. v3.2.11（`641c574d`）起拆分读取分「元数据」「字段值」两次全量扫描，GUI 读字段要等两次。

第一轮后（同机、模块已预加载、只计操作本身）读字段仍为 3.0.18 的 2.7 倍。第二轮剖析：每个单元格 4 个标签事件，每个事件都构造属性对象、做大小写 / 命名空间 / 父子校验，之后再分配 context、cell 输入对象和样式引用对象（约占读取 80%；解压本身只要 80ms）；每个数值单元格 3–4 次正则解析（解码判定、分类、double 往返、两次规范比较）；`classifyExcelNumberFormat` 对同一格式串反复剥离分类；写后复核为每行构造冻结行 / 单元格模型，实际只看表头。

## 三、技术决策

| 编号 | 决策 | 原因 |
| --- | --- | --- |
| T1 | 新增 `src/backend/xlsx/strict-xml-tokenizer.js`，按标记块（`indexOf` + charCode 循环）扫描，替换 `scanXlsxSheet` 与 `loadToolboxSharedStrings` 中的 sax | 热路径只需 strict + xmlns 的事件子集；事件形状、命名空间作用域、实体表（复用 `sax.ENTITIES`，因调用方未开 strictEntities）、出错前吐出已累积文本、错误文案（含 Line/Column/Char）、Buffer 编码探测与 XML 声明编码校验、`position` / `startTagPosition` 全部按 sax 1.6 行为复刻，包括其怪癖（xmlns 模式下重复属性去重失效、`<!` 后接引号吞没剩余内容、实体表原型链查找） |
| T2 | 扫描器的事件处理逻辑一行不改，只把注册方式改为具名函数、位置字段由 `parser._parser.*` 改为 `parser.*`；语法错误统一经 `failParser` 翻译，处理器抛出的错误原样失败 | 原 sax 'error' 事件只承载 sax 自身错误，处理器异常经 write 抛出，两条路径的映射与原来一致 |
| T3 | sax 的 64K 缓冲上限只在每次 write 结束时抽查；新实现在未完成的单个标记、注释、处理指令、DOCTYPE、实体名超过同一上限时确定性报错，文本与 CDATA 同样按 64K 分段吐出 | 不能为保证完全同步的抽查时机而放开无界缓冲；对照测试中 70K 属性 / 注释 / 文本 / CDATA 与 sax 结果一致 |
| T4 | 写入端按（来源注册表对象, styleRef, 数字格式覆盖）缓存输出样式（`cachedOutputStyle`），首次出现照常调用 `registerOutputStyle` | `SourceStyleRegistry` 条目只增不改，且注册表从不移出解析表；首次出现顺序不变，预算校验、样式编号与 `projectedStyleCounts` 完全相同；解析失败沿原路径抛同一错误 |
| T5 | 输出样式的 numFmt / font / fill / border / alignment 齐全时，同一输出样式的单元格共享一个 ExcelJS 样式对象（`sharedCellStyleFor`），否则退回逐格 `applyExcelJsStyle` | 齐全时 `applyExcelJsStyle` 会覆盖行 / 列合并来的全部键，行列样式也从不含 protection，最终样式与行列无关；共享后命中 ExcelJS WeakMap，首次出现顺序不变，styleId 与 styles.xml 不变 |
| T6 | `defaultProjectCell` 不再逐格 `require('../backend/xlsx/model')`，首次加载成功后复用模块引用；原包住调用的 try/catch 保留 | 逐格模块解析约占写入阶段 16%；加载失败仍每次重试，语义不变 |
| T7 | 词法扫描器增加可选快路径钩子（`leadCodes` / `match` / `apply`）：根元素内遇到指定首字母的标记时，由调用方只读匹配当前缓冲区内完整的标记，命中则整段跳过逐事件处理、先吐出已累积文本再调用 `apply`；仍打开的元素（行开标签）照常压入标签栈，闭合标签走通用路径。工作表扫描接管 `<row …>`（属性限精确拼写的白名单或已绑定前缀属性、不重复、不声明命名空间、值为 ASCII 字母数字与 `.:+-`）与 `<c r s t/>`、`<c r s t><v>文本</v></c>`（属性仅限精确小写 r/s/t、值为字母数字；文本不含 `<`、`&` 且不超过 4096）；其余形态、状态（嵌套、收集中、前缀元素、CDATA、实体、公式、内联字符串、大小写变体、重复属性、默认命名空间不合法、`onCellLexical` 审计）一律回退 | 白名单形态在逐事件路径上只会经过「开始行 / 开始单元格 → 开始缓存值 → 追加文本 → 收尾」这几个已抽成共享函数的步骤，大小写、命名空间与父子结构校验必然通过，错误种类、文案、context 与先后顺序不变。`scanXlsxSheet` 内部选项 `fastPath: false` 仅供开 / 关对照测试 |
| T8 | 逐单元格削减：纯 ASCII 坐标手写解析（非 ASCII 仍走原正则，`toUpperCase` 可能把 ß 展开）；样式属性原文 → XF 号只缓存成功结果（至多 4096 条）；每格照常由 `effectiveStyleRef` 算出实际样式引用，再按该引用缓存冻结样式引用与 numFmt（条数不超过来源样式数，行样式引用同理）；解码改为按位传参、出错才构造 context；单元格可变状态整表复用；行内单元格用数组 + 递增判重；扫描器专用的冻结 cell / row 构造函数复用共享样式引用，单元格已按列递增时跳过原实现的 Map 去重与排序；规范元素名的大小写校验结果预置；属性循环改用 `Object.keys` | 缓存键是解析后的样式引用而非 XF 组合，内存不随行 / 单元格 / 列 XF 的组合增长；行样式引用与原实现一样不查样式内容；构造结果与 `createToolboxCell` / `createToolboxRow` 字段、键顺序、取值、冻结状态一致（无坐标单元格顺延到 16384 时仍交给原构造函数按原样报错） |
| T9 | `number-date`：常见「正负号 + 整数 + 可选小数」词法手写解析，其余仍走原正则；规范比较去正则；`classifyExcelNumberFormat` 按格式串有界缓存（结果本就冻结）；数值解码只解析一次（`classifyNumericLexical`）；有效数字 ≤ 15、整数位 ≤ 15、小数位 ≤ 20 时 double 往返判定直接成立（DBL_DIG），范围外仍重新解析比较。`excel-text`：无 `_` 时解码跳过正则替换，无需转义时编码直接返回原串 | DBL_DIG：15 位有效数字网格的相对间距（≥ 1e-15）大于 double 的 ulp（≈ 2.2e-16），且最短往返表示不长于原值，故正规数范围内必然往返不变；以 v3.2.15 原实现作对照逐值比较 |
| T10 | `loadToolboxSharedStrings` 用同一钩子接管 `<si><t>文本</t></si>` 与 `<si><t xml:space="preserve">文本</t></si>`（文本不含 `<`、`&`、不超过 4096），语义动作复用原 t 解码与 si 交付，出错仍经 `finish(error)` | 同 T7 |
| T11 | `scanXlsxSheet` 新增 `rowCallbackLimit`：只把前 N 行交给 `onRow`，其后各行照常严格解析、解码、样式校验与计数，在无逐 cell 审计与行字节预算时不构造模型对象；写后复核（`validateGeneratedWorkbookStructure`）只取表头，设为 1。`emitRow` 不再为每格分配投影记录（改为本次调用内的局部数组，不跨行持有已写出的单元格）；输出样式缓存随 release / abort 清空；`projectToolboxMatchValues` 一次遍历；读字段累加器预先展开字段数组 | 复核原本只在首行取表头，其余行回调为空操作；解析、解码与计数路径不变，失败条件不变 |
| T11b | `emitRow` 对没有行样式的数据行，把 ExcelJS 新建行自带的空样式 `{}` 换成同一个冻结空对象 | ExcelJS 提交行时按样式对象身份缓存 `addStyleModel`，每行新建的 `{}` 每次都未命中、重新登记（8 份拆分中 20208 次，换后 216 次）；内容相同，样式编号与登记顺序不变；有行样式（customFormat）的行仍按原路径逐行设置 |
| T12 | GUI 读字段（v2）：主进程给元数据扫描传入与字段取值相同的预算（单字段 5 万个值 / 4MB），Worker 在同一次扫描里按 `scanSplitFieldValues` 的口径（matchValues、首次出现顺序、计费公式）预取各字段可选值，另设合计 4MB 上限；任一上限超出的字段整列放弃。选字段时命中预取直接返回（仍校验字段属于表头并重新核对源文件快照），未命中照旧单独扫描 | 返回结构与单独扫描相同（含 executionMode），Renderer IPC 不变；预取不改变元数据结果；放弃的字段在单独扫描时照常按原预算报错 |
| T13 | 工作表与共享字符串的流式读取改用 `zip-reader.openZipEntryReadStream`：对 yauzl 打开的普通 deflate 条目按 yauzl 3.x `openReadStreamLowLevel` 的同一管线自行解压（`decompress:false` 取原始数据，本地文件头校验仍由 yauzl 完成；读流 / 解压错误按原方式 setImmediate 转发、销毁后不再转发；`validateEntrySizes` 时断言解压字节数；destroy 断开管线并销毁原始读流），只把解压输出分块由 16KB 调到 64KB；其余情况（假 zip、stored、加密）照旧调用 `openReadStream` | 剖析显示扫描等待解压约占 12%：解析每处理完 16KB 就要等解压线程送来下一块（10 万行约 4700 次往返），加大读缓冲无效，只有加大分块有效。原管线在声明大小不符时报的「got at least N」取决于分块：其解压输出在累计 16KB 整数倍与每个原始数据块处理完处切块，本管线只放大前者，故 N = min(声明大小后的下一个 16KB 整数倍, 本块结束位置)，并先交付原管线在越界前会交付的同一前缀、下一轮事件循环再报错，报错文案与报错前已解析的行与原管线一致 |

## 四、改动文件

| 文件 | 改动 |
| --- | --- |
| `src/backend/xlsx/strict-xml-tokenizer.js` | 新增，T1、T3；T7 快路径钩子 |
| `src/backend/xlsx/xlsx-sheet-scanner.js` | T2：去掉 sax，接入词法扫描器；T7 行 / 单元格快路径与共享的开始行 / 单元格 / 缓存值函数；T8；T11 `rowCallbackLimit` |
| `src/backend/xlsx/workbook-parts.js` | `loadToolboxSharedStrings` 由 `stream.pipe(sax)` 改为 data/end 喂入词法扫描器；处理器仍全部经 `finish` 收口。workbook.xml / rels 等小文件仍用 sax；T10 |
| `src/backend/xlsx/zip-reader.js` | T13：`openZipEntryReadStream` |
| `src/backend/xlsx/model.js` | T8：`createScannedToolboxCell` / `createScannedToolboxRow`，导出 `freezeToolboxStyleRef` |
| `src/backend/xlsx/number-date.js`、`excel-text.js` | T9 |
| `src/main-process/toolbox-output-writer.js` | T4–T6；T11（复核 `rowCallbackLimit: 1`、`emitRow` 投影缓冲） |
| `src/main-process/toolbox-format-io.js`、`toolbox.js` | T11：匹配值一次投影、读字段累加器 |
| `src/main-process/toolbox-split-scan.js`、`toolbox-split-read-owner.js` | T12 |
| `src/backend/xlsx/README.md` | 登记新文件、快路径与 `rowCallbackLimit` 的使用约束 |
| `tests/unit/backend/xlsx/strict-xml-tokenizer.test.js` | 新增：与 sax 逐事件对照（边界构造、非法与截断输入、固定种子随机变异；字符串 / UTF-8 / UTF-16 与多种切块）；快路径钩子的事件、位置与压栈 |
| `tests/unit/backend/xlsx/xlsx-sheet-scanner-fast-path.test.js` | 新增：快路径开 / 关在常见、近邻、出错形态与固定种子随机工作表上逐行一致（多种切块）；`rowCallbackLimit` 语义；400 种等价行 / 单元格 XF 组合只解析一次实际样式 |
| `tests/unit/backend/xlsx/number-text-fast-path.test.js` | 新增：内嵌 v3.2.15 原实现，逐值对照十进制解析、规范比较、数值输出分类、格式分类缓存与 ST_Xstring 编解码 |
| `tests/unit/backend/xlsx/model-scanned-constructors.test.js` | 新增：扫描器专用构造函数与通用构造函数逐字段一致 |
| `tests/unit/backend/xlsx/zip-entry-stream.test.js` | 新增：与 yauzl `openReadStream` 对照读出内容、声明大小偏小 / 偏大时的报错文案与报错前已交付字节数、非 yauzl zip 回退 |
| `tests/unit/main-process/toolbox-split-scan-prefetch.test.js` | 新增：预取字段与单独扫描一致、超出单字段 / 合计上限整列放弃 |
| `tests/unit/main-process/toolbox-split-read-owner.test.js` | 新增预取复用用例（不再起第二个 Worker、源文件变化仍失效）；原「显式补扫」「并发合并」用例去掉预取后继续覆盖单独扫描路径 |

## 五、验证

等价性（对照基线均为 v3.2.15 源码，脚本在会话草稿区，未入库）：

- 词法层：随机变异 14.5 万例 + 第二轮复跑 6 万例（约 45% 为 sax 报错样本，随机切块、字符串与 Buffer 输入）+ 定向边界 74 例 × 5 种编码 × 7 种切块，事件序列、位置字段与首个错误完整文案全部一致。
- 扫描器层：变异工作表 630 例 + 第二轮 900 例（含 6 个仓库夹具、2 万行文件与富格式文件，开 / 关 `onCellLexical`），逐行输出与错误（含 context.parserMessage）一致；快路径近邻语料 6000 例（见第七节，任意切块，随机开 / 关 `onCellLexical`、行字节预算与 `rowCallbackLimit`）一致；变异 sharedStrings.xml 500 + 1100 例一致。
- 数值与文本：随机十进制 / 文本 60 万例，`parseDecimalLexical`、`decimalComparable`、`classifyNumericOutput`（多种格式）、`classifyNumericLexical`、`addIntegerToDecimal`、ST_Xstring 编解码逐值一致。
- ZIP 层：对工作表与共享字符串条目随机改压缩字节、清零片段、改中央目录声明大小，2 万行 600 例 + 10 万行 100 例，读取结果、报错文案（含「got at least」数值）与报错前已解析行数一致。
- 输出层：同一输入分别用基线与新代码生成合并（含分页）、单值拆分、多文件拆分产物，解包逐条目比较（仅 `docProps/core.xml` 的生成时间戳不同）：ExcelJS 生成的 2 万行文件、随机样式富格式 xlsx（行列样式、隐藏页、续页、富文本、公式、错误值、长数字）、SheetJS 写出的 xls、带 BOM 的 csv 及三者混合合并，全部一致。

耗时（macOS、Node，同一份 10 万行 × 20 列 xlsx；模块预加载后只计操作本身，不含对话框 / Worker 启动 / 发布 / 存档；v3.0.18 与本分支交替运行各 7 次取中位数，v3.2.15 为单次）：

| 操作 | v3.0.18 | v3.2.15 | 本分支 |
| --- | --- | --- | --- |
| 读字段（单次扫描全部字段） | 1005ms | 7967ms | 788ms |
| GUI 读字段（元数据 + 选字段取值） | 一次扫描约 1000ms | 两次扫描约 15.3s | 676ms（取值来自预取） |
| 单值拆分（命中 1 万行） | 1033ms | 9929ms | 850ms |
| 8 份多文件拆分（共 2 万行） | 1244ms | 12099ms | 1071ms |
| 合并 2×10 万行 | 5764ms | 59097ms | 4858ms |

峰值 RSS（同口径单次）：读字段 371 / 304 / 291MB，单值拆分 335 / 265 / 268MB，8 份拆分 363 / 292 / 283MB，合并 524 / 372 / 367MB（依次为 v3.0.18 / v3.2.15 / 本分支），未高于 v3.2.15。

测试命令与结果（2026-11-10，本分支工作区）：

| 命令 | 结果 |
| --- | --- |
| `node --test` 新增 / 修改的单测（tokenizer、快路径开关对照、数值文本对照、构造函数、ZIP 条目流、预取、split read owner） | 全部 PASS |
| `npm run test:unit` | 10008/10012 PASS，4 项按平台跳过，0 失败（638 个文件；含两轮 Codex 审查修复后的复跑） |
| `npm run test:integration` | 98 个脚本、3431/3431 PASS；`toolbox-split-read-compatibility.js` 增加预取 / 补扫两种路径（12 → 18 例），`toolbox-csv-admission.js` 增加预取用例（17 → 18 例），runner 回写 `rules/integration-test-policy.md` 第七章 |
| `npm run lint` | PASS |

集成脚本调整：`toolbox-split-read-compatibility.js`、`toolbox-csv-admission.js`、`toolbox-biff8-admission.js` 及其公共夹具 `tests/helpers/toolbox-rows-csv.js` 中专门验证「字段补扫 Worker 准入」的用例改为显式去掉预取（`withoutPrefetch`），继续覆盖补扫路径；另加预取路径用例。

未执行：`npm run release-check`（非 PR-ready 阶段）、GUI 与 Windows 打包版实测（B76）。

## 六、兼容与回滚

- 无数据、对外契约、依赖或迁移变化；sax 仍是依赖（workbook.xml、relationships、styles 等小文件继续使用）。Renderer IPC 不变；拆分读取 Worker 的元数据结果多出内部字段 `prefetchedValues`，只由主进程 owner 消费。
- T13 复刻的是 yauzl 3.x（当前锁定 3.3.0）的内部解压管线；升级 yauzl 须重跑 `zip-entry-stream.test.js`。
- 预取使元数据扫描 Worker 多持有至多 4MB 字段值（计费口径同单独取值扫描，单独取值 Worker 本就持有同量）；主进程会话缓存同样不超过 4MB，低于原 8 个字段缓存的上限。
- 回滚：还原上述源码文件即可，无持久化状态。

## 七、实施记录

- 对照中发现并修复两处偏差：收尾阶段把未闭合注释当作根内文本吐出；按 XML 规范去重重复属性（sax 在 xmlns 模式下实际不去重，已改为按 sax 行为保留后者）。
- 第二轮起初用替换 `zlib.createInflateRaw` 的方式试加大分块，测得无收益；后查明该导出不可写、替换从未生效。改为自建管线实测：加大读缓冲（highWaterMark）无效，加大解压分块有效（10 万行等待 118ms → 73ms），据此实施 T13。输出文件哈希本身只占约 10ms，未改。
- 第二轮对照语料扩充：工作表近邻变异（属性顺序 / 引号 / 空白、大小写与重复属性、非 ASCII 与小写坐标、`<v/>`、CDATA、实体、超长文本、前缀元素、行内重绑默认命名空间、未绑定前缀行属性、乱序与顺延到 16384 的单元格）在 1–1e9 字节任意切块下逐行对比 v3.2.15；共享字符串加入空 t、`xml:space` 变体、转义孤立代理项与超长文本。
- 提交 `343a494d` 后 Codex 只读审查一轮，P2：生效样式缓存按（cell / 行 / 列 XF、customFormat）组合作键，行样式与单元格样式都多时条数近似相乘且常驻（1000 行 × 1000 列、1001 个等价 XF 的流式扫描，GC 后堆增长约 120 MiB，v3.2.15 无此缓存）。改为按解析后的样式引用缓存（T8），同一场景堆增长降到约 1 MiB；补回归测试，对拍与比速复跑无差异、无退化。
- 修复提交 `671f25cc` 后 Codex 对整个分支再审一轮，上一条确认已修复；新 P2：`emitRow` 复用的闭包级投影缓冲只覆写前缀，宽行之后写窄行时历史行尾部的单元格（含文本）一直被 writer 持有，release 后也不释放。改为每次调用的局部数组，并在 release / abort 时清空输出样式缓存；补 WeakRef + 强制 GC 的回归测试（旧实现失败、新实现通过），输出对拍与比速复跑无差异、无退化。
- 修复提交 `89eb1698` 后 Codex 对整个分支第三轮审查：无新发现（其定向复跑相关单测与拆分读取兼容、共享 XLSX 边界集成脚本均通过；未跑 release-check 与 Windows 验证）。
- 未覆盖：Windows 打包版与用户真实文件的耗时回归（B76）；发布存档阶段的耗时（B75）。
