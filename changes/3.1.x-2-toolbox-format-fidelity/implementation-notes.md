# v3.1.2 Implementation Notes

## Baseline

- Goal/spec: `changes/3.1.x-2-toolbox-format-fidelity/spec.md`
- Initial plan: 严格在 v3.1.1 发布开发收尾后开始 v3.1.2；先用 probe 定位 `.xls` 缺口，再以项目自有 BIFF8 样式 overlay 与 XLSX reader 汇入统一载荷并逐条贯通路径矩阵。
- Done when: Spec B 所有明确要求均有测试或人工验收证据，完成 PR、自审至无 P3 Finding、合并和发布收尾。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| `.xls` 先用真实 BIFF8 fixture 做双解析器 probe | Spec B 4.4 明确要求，且当前 `.xls` 与 XLSX 使用不同读取层 | 直接假设 SheetJS `cellStyles` 等价支持所有样式 | 未过门禁前不编辑生产代码 |
| LibreOffice probe 使用独立临时 user profile | 默认 profile 在受限环境中无法初始化 | 把环境启动失败误报成格式能力缺失 | 探测可重复且不污染用户配置 |
| OOXML/BIFF8 低编号格式按物理权威分区 | 真实 SheetJS/Excel 文件会在 `5–8/23–26/41–44/50+` 写 locale 或自定义格式；仓库资产实际包含 id 41/56，BIFF8 自定义日期实际使用 id 60 | 一律把 `<164` 当 built-in，或让任意低 id 覆盖 canonical | 允许区间内物理格式优先；其余 `0–49` canonical 保护。BIFF8 只核对实际物理 FORMAT 的有值 cell，避免 id 14/37 locale 表示误拒 |
| `.xls` 与 `.xlsx` 同版交付，新增项目自有 BIFF8 样式 overlay | 用户明确要求一起实现；`xlsx` 与 `xlsx-js-style` 均无法暴露字体、边框、对齐 | 拒绝 `.xls`、要求另存 `.xlsx`、只保留可读取子集、运行时调用 LibreOffice | SheetJS 继续作为值层权威；BIFF8 scanner 只补格式元数据并严格校验坐标/XF |
| `.xls` 生产支持范围固定为 OLE/CFB BIFF8 | Excel 97–2003 是可验证的明确二进制契约；扩展名可能承载更旧 BIFF、加密或伪装 XML | 按扩展名“尽力读取”并静默默认样式 | 非 BIFF8/加密/损坏输入明确失败并提示转换 |
| 所有工具箱入口统一按 magic 路由，扩展名只用于提示 | 现有 merge 已按 magic，split 仍按扩展名；真实 `assets/中台退款订单.xls` 实际是 ZIP OOXML | 继续让 merge/split 读取同一文件时走不同 reader | 伪装 `.xls` 的 OOXML 进入 XLSX style-aware reader，标准 OLE/CFB 才进入 BIFF8 reader |
| BIFF8 `Theme` 与 palette/XFExt 一起解析成最终 ARGB | 真实 `assets/外汇交割表.xls` 含 Theme record 和大量 theme 色 XFExt | 维持原 Spec“BIFF8 不存在 theme”的错误假设 | 反向修正 Spec；未知必需颜色类型 fail-closed |
| `XFCRC` 与 `StandardWidth/DxGCol` 纳入 BIFF8 强校验 | 真实资产含 66 个 XF，存储 CRC `0xB94F84D8` 与规范算法一致；同时含精确标准列宽 | 忽略 CRC 后盲套可能过期的 XFExt；仅用整数 DefaultColWidth | CRC/数量不符 fail-closed；精确标准宽优先 |
| BIFF8 `.xls` 拆分扩展为多 Sheet 续页 | Spec 9.10 明确要求 `.xls` 单/多 Sheet 拆分，而既有 fallback 只读首 Sheet | 为保持旧实现而删减 `.xls` 路径矩阵 | 这是显式行为变更，需测试和版本说明 |
| BIFF8 Cell XF 当前渲染不动态继承 parent Style XF | MS-XLS 定义 Cell XF 保存完整当前格式；used-attribute flags 表达父样式未来修改时的联动 | 按 `fAtr*=0` 把 parent 字段混回 Cell XF | parent 只做血缘合法性；grid 层按整套 Cell XF 优先级选择 |
| 所有实际存在的 OOXML 元数据都严格解析并验证闭合 | 自审可复现截断 workbook 少处理 Sheet、截断 styles 把日期退成 General、截断 theme 串色 | 接受 SAX 已读前缀或用默认主题/样式兜底 | workbook/rels/worksheet/SST/styles/theme 任一存在但不完整即整文件失败；缺少可选 entry 才使用规范缺省 |
| OOXML 核心 part、关系类型和单元格载荷按完整契约失败关闭 | 独立故障注入复现 `urn:evil/styles` 可冒充样式关系，以及 `inlineStr + v` 等非法组合会把实际值投影为空 | 按 local-name/URI 后缀分类，或忽略与 `t` 不一致的 payload | 只接受 Transitional/Strict 完整 namespace/Relationship Type；重复 ZIP entry、错层节点、非法 type/payload 组合整文件失败 |
| foreign OOXML 扩展只在 workbook 直属 `extLst/ext` 内忽略 | 真实 Excel 模板含合法 `x15:workbookPr`；全局按 local-name 校验会误拒，而任意错层放行会重开 namespace spoof | 全部 foreign 同名拒绝，或全局忽略 foreign 同名 | 合法 x15 扩展可读；wrapper/sheets 错层、核心 namespace 错大小写仍 fail-closed |
| ST_Xstring 读写统一并以 UTF-16 code unit 做文本上限 | ExcelJS 会删除 NUL/C0/DEL、归一 CR，并把字面 `_xHHHH_` 交给消费者解码；超过 Excel 32,767 单元格上限时，现有兼容软件回放已复现截断或明确拒绝 | 静默删/截，或拒绝所有合法 escape/control 文本 | SST/inline/str 每个节点单次 decode；writer 保护字面 escape 后编码控制字符；32,768、未配对 surrogate、FFFE/FFFF 整批失败并带来源坐标 |
| 核心 OOXML metadata part 使用中央目录 + 运行时 byte 双重上限 | 38KB 高压缩 fixture 可把 styles 膨胀到 32MiB，修前单次 RSS 增约 53MB | 解压完整 Buffer/string 后再依赖 parser/样式预算 | workbook/rels/styles/theme 固定 16/16/32/8 MiB，上限前失败且不触碰共享 reader 默认契约 |
| 显式 OOXML 颜色不可回落黑/白 | 自审可复现 `theme=99`、`rgb=ZZZZZZ` 被静默变黑 | 把无法解释颜色当 `auto` | RGB/theme/indexed/tint/来源冲突严格校验，只有 `auto` 使用上下文 fallback |
| 普通拆分保持全部去重值，只有 Worker 有界 | 既有普通路径为无界列表；把 Worker 1000 上限误套普通文件会静默隐藏可选值 | 所有路径统一截断 1000 | 普通路径第 1001 项继续可见；超大文件 Worker 保持有界防 OOM |
| 日期降级只做中性成功提示与信息审计 | 用户明确要求“不标黄，不要进错误报告” | 把无法转换日期当失败或 warning/error report | 成功弹框显示总数和最多 20 条；`skipLogReport` 保持 true；活动日志以 info 记录同批样例 |
| 所有成功输出记录统一格式审计 | Spec 6.3/8.3 要求预计/实际样式数和验证结果可追溯 | 只记录输出路径/行数 | 合并、普通/Worker 单拆及多拆均写日期降级、projected/actual counts 和临时产物校验通过 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| LibreOffice 只用于构造可重复 BIFF8 测试文件，不作为应用运行时依赖 | 当前应用包未包含 LibreOffice，Windows 可用性不可保证 | 若选“运行时转换”，需重做依赖、打包、许可和离线验证 | 当前 probe 与生产实现隔离 |
| 两套现有解析器的共同缺口代表其公开返回契约限制，而非 BIFF8 文件中没有样式 | 两者分别读取同一 fixture 并返回相同缺口，SheetJS 源码仍解析部分 XF 字段但只暴露 fill | 若 BIFF8 record 无法稳定映射到 SheetJS cells，必须停止 `.xls` 输出 | 用项目自有 scanner 读取元数据；任何不一致 fail-closed |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 首次 probe 直接用默认 LibreOffice profile | 改用临时 profile 重跑 | 默认用户配置目录不可写导致启动失败 | 只修探测环境，不影响能力结果 | 不需 |
| 初始 probe 计划用等价转义规范化比较 BIFF8 numFmt | 最终改为低编号物理权威分区，并只对实际 record-defined FORMAT 的有值 cell 与 SheetJS `cell.z` 精确核对 | 宽泛规范化会隐藏真正 FORMAT 漂移；无物理 canonical built-in 又存在合法 locale 字符串差异 | 物理格式严格、canonical built-in 兼容，id 60/Date1904 与 id 14/37 均有正反测试 | 是 |
| 初始 Spec 要求现有依赖能力门禁失败后由用户选择降级/拒绝/转换 | 用户决定 `.xls` 与 `.xlsx` 一起实现，改为自有 BIFF8 样式元数据 overlay | 格式范围不能靠现有 SheetJS 返回值完整覆盖 | 扩大 v3.1.2 工程范围与测试矩阵，不改变格式保真目标 | 是 |
| 初始复核把 XF bit25 视为所有 XF 的 `fHasXFExt` | 按 MS-XLS 改为仅 Cell XF 双向校验；Style XF 同位是 `reserved2=0`，仍允许 XFExt | 真实 `外汇交割表.xls` 的 43 个 Style XF 扩展对应位均为 0，若全量套用会误拒 | 保留合法 Style XF 扩展并继续严格验证 CRC/index/duplicate；Cell XF 仍双向一致 | 是 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `node changes/3.1.x-2-toolbox-format-fidelity/probes/xls-capability-probe.js` | 退出码 2；`passingParsers=[]` | `.xls` 全量保真门禁未通过 |
| SheetJS `xlsx@0.18.5` BIFF8 回读 | 值、长编号、3 类 numFmt、填充、行列布局、公式缓存通过；字体/边框/对齐缺失 | 当前正式 `.xls` 读取依赖能力 |
| `xlsx-js-style@1.2.0` BIFF8 回读 | 与 SheetJS 相同，字体/边框/对齐缺失 | 排除只因使用了错误现有解析入口 |
| probe 日期格式观察 | `yyyy-mm-dd hh:mm:ss` → `yyyy\\-mm\\-dd\\ hh:mm:ss`，显示值仍为 `2026-07-29 12:34:56` | BIFF8 格式词法规范化与显示保真需分开判断 |
| v3.1.1 GitHub Release | tag/release/Windows workflow 与四项资产均完成；Setup 全量下载的 SHA512、SHA256 校验一致 | v3.1.2 开始门禁 |
| v3.1.2 toolbox 定向基线 | 现行路径相关测试 170/170 PASS；上一轮全量 release-check 为 unit 4101/4101、integration 2016/2016 | 后续行为差异的回归基线 |
| BIFF8 真实资产 record 核查 | `assets/外汇交割表.xls` 含 3407-byte Theme 和 43 个 XFExt；`assets/中台退款订单.xls` magic 为 ZIP OOXML | Theme 解析与 magic 路由不能省略 |
| 普通 XLSX 与 Worker 旧投影对拍 | `1.0: 1/1.0`、`001: 1/001`、`1E+20: plain/scientific`、17 位整数普通路径已舍入、inline rich text 普通拼接/Worker漏 run | 新契约必须把既有普通路径 `matchValue` 与精度安全的 output value 分成双轨 |
| 统一生产入口与路径矩阵定向测试 | merge、split scan、普通/Worker 单拆、多拆、分页均进入 `toolbox-format-operations` + 唯一 writer；异构匹配值跨独立 pass 重命中 | 关闭旧 `string[]`/by-name writer 旁路及 UI 可选但导出零命中 |
| BIFF8 XFCRC/扩展严格测试 | MsoCrc32Compute 初值 0、poly `0xAF`、MSB-first；真实 66 XF/43 XFExt 的存储与计算 CRC 均为 `0xB94F84D8`；缺失/孤立/count/CRC/flag/duplicate/index 全部 fail-closed | 防止过期或错位 XFExt 套到错误样式 |
| OOXML 元数据/颜色故障注入 | workbook/rels/SST/styles/theme/worksheet 截断、错层/包装、重复 ZIP entry/关系/r:id/path、错误或伪造 Relationship Type、非法 namespace、非法 cell type/payload、非法 font/fill/border 颜色均 fail-closed；最终严格解析定向测试 101/101 | 防止漏 Sheet、静默丢值、日期裸 serial、主题串色和非法颜色默认化 |
| 全仓 OOXML 真实资产回归 | 仓库 53 个 `.xlsx` 中 50 个有效文件全部通过 strict opener；3 个失败项均为已损坏 `.~` 锁文件 | 低 id locale/custom numFmt 与真实 x15 扩展兼容 |
| 低编号格式与 BIFF8 值域故障注入 | OOXML/BIFF8 `5–8/23–26/41–44/50+` 物理格式优先，受保护 id 14/22 冲突拒绝；真实 SheetJS id 60 + Date1904 0/1、id 14/37、压缩 Font、Number/Formula/RK/MulRK 非有限值与 BoolErr/special cache 全覆盖 | 防止日期系统错位、合法文件误拒和非法数值进入输出 |
| ST_Xstring/文本/日期极值回归 | `_x/_X` 字面量、NUL/C0/CR/DEL 经 CSV/XLSX 读写往返不变；32,768 UTF-16、FFFE/FFFF、未配对 surrogate 明确拒绝；date-like `1e309` 输出 canonical 文本且 XML 无 Infinity | 防止文本静默删尾/转义、Excel 修复文件和非法数值输出 |
| metadata 与单 cell 资源门禁 | workbook/rels/styles/theme 16/16/32/8 MiB 双重限制；32MiB 高压缩 styles 在 inflate 前拒绝，RSS 从修前约 +53MiB 降到约 +0.55MiB；SST/inline/v/f 有 raw/semantic 累积上限 | 防止小压缩包或单 cell 先击穿主进程内存 |
| 输出样式与拆分审计故障注入 | 临时 `styles.xml` 实际直属子节点数量必须与声明及 registry projected counts 完全一致；普通/Worker/多拆日志记录输入有效行数 | 防止伪造 count 绕过预算，以及日志只记命中行导致无法核对输入处置 |
| 新 style-aware 30 万行性能回放 | 两个 30 万行来源合并为 60 万行、拆分命中 10 万行；总耗时 108.9s，峰值 RSS 426MB，小于 800MB；日期/数字/文本/样式/布局/21 位 ID/非科学计数全部通过 | 证明生产入口未退回整表物化，并验证行数与格式守恒 |
| warning/审计定向回归 | renderer 展示最多 20 条并保持 `skipLogReport: true`；四类成功日志统一记录日期降级、样式预计/实际和校验通过 | 用户要求的“不标黄、不进错误报告”及发布审计 |
| 正式 `npm run release-check` | lint PASS；smoke PASS；unit 4309/4309 PASS（270 files）；integration 2051/2051 PASS（44 scripts） | 全仓发布门禁、30 万行流式路径、合并/拆分/分页/恢复与既有功能回归 |
| 最终重要变量扫描 | `npm run scan:vars` 成功刷新统计；`npm run check:vars -- --include-minor` 命中项均完成影响归类与对应测试复核 | 版本号 bump 与提 PR 前硬门禁；风险链路详见 PR body |
| 独立发布门禁 review | P0=0、P1=0、P2=0、P3=0；定向 225/225 PASS，lint PASS，`git diff --check` PASS | 代码、测试、Spec/文档和格式边界独立复核 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| BIFF8 scanner 对 cell record、XF 继承、Continue 和 palette 的完整覆盖 | RESOLVED | record fixture、真实资产与 overlay mismatch 故障注入已覆盖 | 无 |
| BIFF8 Theme/XFExt 最终颜色映射 | RESOLVED | 真实资产和最小 fixture 已覆盖 theme/palette/automatic/未知必需色 | 无 |
| Windows Excel/WPS 人工打开 | 发布门禁 | 实现后在 Windows 分别打开脱敏 fixture | 未签字不得合并 |
| 30 万行 XLSX 内存与耗时上限 | RESOLVED（自动门禁） | 新生产入口峰值 RSS 426MB，总耗时 108.9s；Windows 实机仍随发布资产复核 | 自动性能门禁不阻塞；实机人工项保留 |
