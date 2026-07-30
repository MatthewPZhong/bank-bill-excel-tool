# v3.1.2 Implementation Notes

## Baseline

- Goal/spec: `changes/3.1.x-2-toolbox-format-fidelity/spec.md`
- Initial plan: 严格在 v3.1.1 发布开发收尾后开始 v3.1.2；先用 probe 定位 `.xls` 缺口，再以项目自有 BIFF8 样式 overlay 与 XLSX reader 汇入统一载荷并逐条贯通路径矩阵。
- Done when: Spec B 所有明确要求均有测试或人工验收证据，完成 PR、自审至无 P3 Finding、合并和发布收尾。

### v3.1.2 发布收尾 Preflight（2026-07-30）

- Goal: 将已合入 `main` 的 v3.1.2 以不可变 tag 发布，公开回读全部更新资产，并把发布事实归档回仓库。
- Context: PR #104 合并提交为 `e5a999c`，PR #105 合并提交为 `05c3dbf`；用户已明确确认人工验收通过；开始收尾时远端不存在 `v3.1.2` tag 或同名 Release。
- Constraints: tag 必须等于 `v${package.json.version}` 并精确指向创建时最新 `origin/main`；正常发布不得覆盖同名 tag/Release。若首次 tag workflow 在创建 Release/资产前失败，只有在再次确认同名 Release 不存在后，才允许把该失败触发 tag 重建到修复后的最新 `main`；任何已有 Release/资产都必须中止恢复。不得纳入工作区既有未跟踪文件；发布后只接受 Setup、Setup blockmap、portable 和 `latest.yml` 四项约定资产。
- Done when: 发布准备记录合入 `main`，Windows Release workflow 全绿，Release 为 stable/latest 且四项资产可公开回读，`latest.yml` 与 Setup SHA-512/大小一致，最终 tag、workflow、资产摘要和状态回写仓库。

| 未知 | 影响 | 处理 | 当前决定 |
| --- | --- | --- | --- |
| `v3.1.2` tag/Release 是否已存在 | 高 | PROBE | GitHub 与 refs 均确认不存在，可以创建一次 |
| 合并后的源码是否仍通过完整门禁 | 高 | PROBE | 干净 `npm ci` 后重跑全部发布门禁 |
| 人工 Excel/WPS 门禁是否签字 | 高 | RESOLVED | 用户于 2026-07-30 明确确认“人工验收通过”；不虚构未提供的样本明细 |
| FAT/部分网络盘不支持 hardlink | 中 | ASSUME（显式 fail-closed） | 保留既有安全失败边界，不增加覆盖型 fallback，不阻断 NTFS 正式包发布 |
| 生产在线升级 canary | 中 | 发布后人工项 | 技术 Release 先按不可变流程完成；公告前仍遵循 Windows Release Runbook |

BLOCK 问题：无。tag/Release 缺失、版本和当前 `main` 均已由只读探针确认。

### Windows staging fsync 发布修复 Preflight（2026-07-30）

- Goal: 修复正式 Windows workflow 中 staging 文件落盘刷新稳定返回 `EPERM`，恢复 v3.1.2 不可变发布链。
- Context: Release run `30567689697` 已通过 tag/main 校验，在 `release-check` 的 publication 单测中 46 项失败；共同根因均为 `fsyncFile` 把 staging 文件以只读 `r` 句柄打开。
- Constraints: 只调整本任务刚复制、后续待发布的 staging 文件句柄权限；文件内容、哈希、目录 fsync 兼容、hardlink no-replace、journal/index 状态机、回滚和人工恢复边界不得改变。
- Done when: 定向测试模拟 Windows 对只读 staging fd 的 `fsync` 返回 `EPERM` 并要求可写句柄；publication 全矩阵、完整 `release-check`、重要变量检查与 Windows workflow 通过。

| 未知 | 影响 | 处理 | 当前决定 |
| --- | --- | --- | --- |
| `EPERM` 来自目录还是普通文件句柄 | 高 | RESOLVED | 日志栈精确落在 `fsyncFile(...entry.stagedPath)`，不是已有容错的 `fsyncDirectory` |
| 是否应忽略 staging 文件 `fsync` 的 `EPERM` | 高 | BLOCK/拒绝 | 文件耐久化失败不能当成功；继续 fail-closed |
| Windows 所需最小权限 | 高 | PROBE | 只把 staging `openSync` 从 `r` 改为 `r+`，测试模拟只读 fd 失败 |
| 只读来源文件是否受影响 | 低 | ASSUME | `copyFileSync` 后刷新的是任务 staging，不改来源；若目标目录无法创建可写 staging，仍在触碰正式目标前失败 |
| 首轮失败 tag 如何恢复 | 高 | RESOLVED | run `30567689697` 未进入构建、Release 或资产步骤；热修合入并通过最新 `main` Windows 构建后，再次确认 Release 404，删除失败 tag 并在修复后的最新 `main` 重建；若 Release/资产存在则中止 |

BLOCK 问题：无。不得采用“忽略普通文件 fsync EPERM”的放宽方案。

### PR #104 复审修复 Preflight（2026-07-30）

- Goal: 关闭输出结构校验 fail-open、prepare 阶段不可发现残留和 Electron 主进程同步发布三个已确认 Finding。
- Context: 修复基线为 PR #104 `069ead0e04d565ca0945b3b296cc9e3f95f34c30`；普通/Worker 候选上限差异及 XLSX 物理 `width="0"` 拒绝不属于本轮 Finding。
- Constraints: 不改变工具箱用户流程、合并/拆分业务顺序和既有输入兼容范围；保持崩溃恢复 fail-closed；大文件校验/发布不得重新线性占用主进程内存或阻塞主事件循环；合并继续暂停。
- Done when: 损坏/少行/错表头/缺 Sheet/验证后变异均不得发布；任何 staging byte 落盘前任务已可由固定恢复根发现；大文件 hash/copy/recovery 不在 Electron 主事件循环执行；定向故障注入、heartbeat、30 万行回放、`release-check` 与 `check-vars` 通过，Windows Excel/WPS 人工门禁仍保留。

| 已确认事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 写后校验只严格解析 `styles.xml` | `src/main-process/toolbox-output-writer.js:719`；截断 workbook/worksheet、缺 Sheet、错表头和少行故障注入仍通过 | 必须严格扫描 workbook/rels/全部声明 worksheet，并把预期 Sheet/表头/行数作为校验输入 |
| 发布元数据丢弃 writer 已验证摘要 | `src/main-process/toolbox-output-publication.js:517`；校验后替换 generation 仍可 committed | 验证时 size/hash 必须绑定 prepare 与 staging，禁止重新信任已变化的 generation |
| staging 先于 journal/index 产生 | `src/main-process/toolbox-output-publication.js:1038-1079`；after-staged/after-journal crash 后固定 index 为空 | 固定恢复根中的 preparing intent 必须先于任何 staging 写入 |
| 发布核心同步执行全文件 I/O | `hashFileSync`、`copyFileSync`、`fsyncSync`；256 MiB 覆盖探针事件循环停顿约 1.04 秒 | O(file-size) 工作必须移出 Electron 主线程；短 rename/journal 临界区也需由同一串行作业保护 |

| 未知 | 影响 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- |
| 现有 strict XLSX pass 能否以有界内存完成输出结构、表头和行数复核 | 高 | PROBE | 对 0 行、分页、截断和 30 万行产物做流式回读 | 优先复用，不另造第二套 OOXML parser |
| preparing index 扩展能否兼容现有 v1 index/journal | 高 | PROBE | 旧 entry 回放 + 四个 prepare crash checkpoint | 旧 entry 按既有 prepared 语义读取；新 entry 显式记录 preparing 状态和清理路径 |
| Worker 调度如何保持发布全生命周期串行并兼容打包 | 高 | PROBE | 盘点所有 main 调用点、现有 worker 模式和打包产物；新增并发/heartbeat 测试 | 生产 O(file-size) 路径使用单队列 Worker；同步核心保留给故障注入单测 |
| strict validation 与 publication 之间如何防止 TOCTOU | 高 | PROBE | 校验后替换 generation，prepare 必须拒绝 | publication artifact 必须携带并强校验 validated size/hash |

BLOCK 问题：无。以上未知均可由仓库证据和故障注入消除，不需要改变用户流程或新增业务选择。

### General 尾随小数点回归 Preflight（2026-07-30）

- Goal: 修复工具箱合并后，来源为 General、底层数字词法带无效尾零时，整数金额被显示为带末尾小数点的问题。
- Context: 用户真实来源单元格保存为 `<v>1200000.0</v>`，来源可见值为 `1200000`；v3.1.2 writer 生成 `numFmt='0.#'` 后，合并结果可见值变为 `1200000.`。
- Constraints: 不通过 JavaScript `Number` 推导精度；不改变 numeric/text 安全分类、canonical 值、`matchValue`、金额值、行选择、样式继承优先级或发布链路；只修正 General/显式科学格式自动生成的非科学数字格式码。
- Done when: `.0/.00` 整数语义生成 `numFmt='0'`，非零有效小数继续保留所需可选位；纯函数、合并端到端和三份真实来源回放通过，规格与 v3.1.2 发布文档同步。

| 已确认事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 目标来源两行的 OOXML 原始值均为 `1200000.0`、样式为 General | `Fund_transfer_apply_1784944566043.xlsx` 的 `Sheet1!J3/J151` | 来源显示语义是整数，不能把词法尾零变成可见标点 |
| 原合并结果把两行写为 numeric `1200000`，但套用 `0.#` | `合并-202607301111.xlsx` 的 `COMMON!J3/J151` | 根因在生成的 `numFmt`，不是金额数值被改写 |
| 原合并结果共有 12,997 个整数单元格使用 `0.#` | OOXML/SheetJS 审计：H 列 5,697、J 列 7,300 | 修复必须覆盖通用生成逻辑，不能只特判渠道流水号或某一列 |

| 未知 | 影响 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- |
| 去除词法尾零是否会损失 General 来源的可见小数 | 高 | PROBE | `.0/.00`、`12.50`、`12.05`、`0.0100`、负数和科学词法纯函数矩阵 | 只去除 canonical 小数部分末尾的 `0`；中间零和非零有效小数保留 |
| 修复是否改变金额值、匹配值或非科学计数安全门禁 | 高 | PROBE | 合并端到端同时断言 output value、formatted value、numFmt | 只改变自动生成的 `numFmt`；其它分类结果与数据路径不变 |
| 真实三文件合并是否仍保持行数并消除末尾点 | 高 | PROBE | 用用户三份来源生成临时结果并核对目标两行与全表 `0.#` 整数计数 | 已回放；不覆盖用户源文件或原合并文件 |

BLOCK 问题：无。全部未知均可由现有契约、定向测试和只读真实样本回放消除。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| General/科学格式输出 `numFmt` 使用有效 scale，安全门禁仍使用原始 scale | `1200000.0` 的 canonical 数值为整数，原始 scale=1 生成 `0.#` 会显示末尾小数点；独立复核同时发现若直接用缩短后的格式长度做门禁，会让 241 字符边界由 text 变 number | 特判金额列/渠道流水号；恢复为 General；先转 Number 再猜小数位；用 effective scale 同时放宽格式安全门禁 | `.0/.00` 的实际格式变 `0`；240 字符门禁仍按 `scale + 2` 计算，保留既有 numeric/text 分类。有效小数、数值、精度门禁和非 General 语义格式不变 |
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
| BIFF8 `Dimensions` 作为唯一半开 used-range 契约校验 | 独立边界审计证明原 scanner 完全忽略 `Dimensions`，损坏范围仍会继续输出 | 继续忽略，或把 `rwMac/colMac` 当闭区间 | worksheet/macro 要求恰好一个 `Dimensions`；合法末端 65536/256，Row/cell 越界失败 |
| LibreOffice `ColInfo.colLast=256` 只按终止哨兵兼容 | LibreOffice Excel 97 导出器会用 `8..256` 覆盖剩余列，但转回 OOXML 不产生第 257 列 | 把 256 当真实列号，或拒绝 LibreOffice 标准 BIFF8 | 解析层立即规范化为 255；其它越界继续失败，writer 上界测试锁定 256 个 OOXML 列 |
| BIFF8 零宽/默认隐藏按可见语义等价投影 | `DefColWidth/StandardWidth/coldx=0` 与 `DefaultRowHeight hidden+0` 合法，旧 writer 的 `>0` 判断会静默改成可见 | 静默回退到默认宽高，或拒绝合法文件 | 全列默认零宽投影为 BIFF8 0..255 隐藏；默认隐藏行输出正高度 + `zeroHeight=1`，同版 reader 可再读；显式列覆盖，隐式数据行继承隐藏 |
| 仅在 `zeroHeight` 输出路径补 ExcelJS 4.4 streaming 属性透传 | ExcelJS 公开 properties 与内部 xform 均丢弃 `zeroHeight`；提交后重写大 XLSX 会破坏流式内存目标 | 写 `defaultRowHeight=0`、整包 JSZip 重写、放弃默认隐藏 | package-lock 锁定私有入口；普通 Sheet 继续调用原方法，定向测试锁定零高度与普通路径 roundtrip |
| 所有实际存在的 OOXML 元数据都严格解析并验证闭合 | 自审可复现截断 workbook 少处理 Sheet、截断 styles 把日期退成 General、截断 theme 串色 | 接受 SAX 已读前缀或用默认主题/样式兜底 | workbook/rels/worksheet/SST/styles/theme 任一存在但不完整即整文件失败；缺少可选 entry 才使用规范缺省 |
| OOXML 核心 part、关系类型和单元格载荷按完整契约失败关闭 | 独立故障注入复现 `urn:evil/styles` 可冒充样式关系，以及 `inlineStr + v` 等非法组合会把实际值投影为空 | 按 local-name/URI 后缀分类，或忽略与 `t` 不一致的 payload | 只接受 Transitional/Strict 完整 namespace/Relationship Type；重复 ZIP entry、错层节点、非法 type/payload 组合整文件失败 |
| foreign OOXML 扩展只在 workbook 直属 `extLst/ext` 内忽略 | 真实 Excel 模板含合法 `x15:workbookPr`；全局按 local-name 校验会误拒，而任意错层放行会重开 namespace spoof | 全部 foreign 同名拒绝，或全局忽略 foreign 同名 | 合法 x15 扩展可读；wrapper/sheets 错层、核心 namespace 错大小写仍 fail-closed |
| ST_Xstring 读写统一并以 UTF-16 code unit 做文本上限 | ExcelJS 会删除 NUL/C0/DEL、归一 CR，并把字面 `_xHHHH_` 交给消费者解码；超过 Excel 32,767 单元格上限时，现有兼容软件回放已复现截断或明确拒绝 | 静默删/截，或拒绝所有合法 escape/control 文本 | SST/inline/str 每个节点单次 decode；writer 保护字面 escape 后编码控制字符；32,768、未配对 surrogate、FFFE/FFFF 整批失败并带来源坐标 |
| 核心 OOXML metadata part 使用中央目录 + 运行时 byte 双重上限 | 38KB 高压缩 fixture 可把 styles 膨胀到 32MiB，修前单次 RSS 增约 53MB | 解压完整 Buffer/string 后再依赖 parser/样式预算 | workbook/rels/styles/theme 固定 16/16/32/8 MiB，上限前失败且不触碰共享 reader 默认契约 |
| 显式 OOXML 颜色不可回落黑/白 | 自审可复现 `theme=99`、`rgb=ZZZZZZ` 被静默变黑 | 把无法解释颜色当 `auto` | RGB/theme/indexed/tint/来源冲突严格校验，只有 `auto` 使用上下文 fallback |
| 普通拆分保持全部去重值，只有 Worker 有界 | 既有普通路径为无界列表；把 Worker 1000 上限误套普通文件会静默隐藏可选值 | 所有路径统一截断 1000 | 普通路径第 1001 项继续可见；超大文件 Worker 保持有界防 OOM |
| 日期降级只做中性成功提示与信息审计 | 用户明确要求“不标黄，不要进错误报告” | 把无法转换日期当失败或 warning/error report | 成功弹框显示总数和最多 20 条；`skipLogReport` 保持 true；活动日志以 info 记录同批样例 |
| 所有成功输出记录统一格式审计 | Spec 6.3/8.3 要求预计/实际样式数和验证结果可追溯 | 只记录输出路径/行数 | 合并、普通/Worker 单拆及多拆均写日期降级、projected/actual counts 和临时产物校验通过 |
| 写后校验复用 strict XLSX pass，并单独严格校验 Content Types | 现有 strict pass 已能有界解析 workbook/rels/styles/theme/worksheet；PR Review 复现旧校验只看 entry 名和 styles | 用 ExcelJS/SheetJS 整本回读，或再造一套 worksheet parser | 全部声明 worksheet 逐页扫描到闭合；额外拒绝 Content Types 损坏、Sheet/relationship/ZIP entry 不一致、游离 worksheet、错表头和行数漂移 |
| writer 的 size/hash 成为 publication 的强身份 | 仅在 writer 校验后重新 hash 但不比对旧摘要，会给验证后变异重新背书 | 只比较文件大小，或信任路径未变化 | 四个生产入口都携带 `byteSize + sha256`；prepare 在任何 staging/index 写入前重算并精确比较，staging 再与同一身份核对 |
| 固定 index 的 preparing intent 先于外部 journal/staging | 原顺序在 staging 或 journal 已存在但固定 index 尚未登记时崩溃，新进程无法发现 | 扫描全部用户输出目录寻找孤儿文件 | index 记录 nonce、journal/staged/target 绝对路径和 discovery state；preparing 恢复只清本任务 staging/journal，绝不触碰 target |
| publication 全生命周期由单 FIFO Worker 串行执行 | 256 MiB 探针证明同步 hash/copy 会阻塞 Electron 主线程约 1 秒；prepare 与 publish 不能跨 Worker 丢失 runtime/预留状态 | 在主线程改为分段 async stream，或让 prepare/publish 使用不同 Worker | 主进程只排队/收结果；worker transport crash 后同一队列项先启动恢复 Worker，再失败；业务错误保留原核心在线回滚语义 |
| 启动恢复失败直接阻断应用启动并展示恢复路径 | 独立复核发现 helper 只记日志后吞错，窗口和 IPC 仍会注册，用户直到发布阶段才知道恢复根损坏 | 仅设置工具箱运行时 blocked flag | 恢复错误重新抛给既有 startup failure 链；对话框/启动日志显示 detailLines、去重 recoveryPaths 和日志路径，随后退出 |
| publication FIFO 覆盖 worker 的真实退出生命周期 | `worker.terminate()` 返回 Promise；若仅调用不等待，error/done Promise 会在旧 worker exit 前结算，recovery/下一任务可抢跑 | 只把 JS 作业 Promise 串行，不管 worker teardown | 每个 job 建立 exit barrier；done、business error、transport error 都在旧 worker `exit` 后才结算，异常恢复和下一任务严格后继 |
| 写后复核使用前后整文件身份，正式发布后再验目标 | 对抗探针可在 worksheet 扫描后、最终 hash 前同大小换文件并取得“已验证”摘要；也可在 staging 最后校验后改写并被 committed | 只依赖单次末尾 hash，或只在发布前校验 staging | 结构扫描前后 size/hash 必须相同；publication prepare 继续重算，staging 发布后、published journal 前再核对正式目标 identity |
| 输出 OPC worksheet 声明必须形成严格闭包 | 额外 worksheet Override/relationship 不被 workbook Sheet 使用时，旧 strict pass 会忽略 | 只验证 workbook 实际引用的正常路径 | Content Types worksheet Override、workbook worksheet relationship、ZIP worksheet entry 与 Sheet 声明精确一一对应；任何悬空/游离声明失败 |
| 输出 OPC 从 worksheet 闭包扩展为 package/workbook 全关系闭包 | writer 仅验证 workbook 侧 worksheet 时，缺失 `_rels/.rels`、错误 `rels` Default、错误/重复 `officeDocument` 或其它悬空 internal relationship 仍可能通过 | 只检查固定 ZIP entry 名存在；只验证 worksheet relationship | 严格解析 package root relationships；要求唯一 internal `officeDocument → xl/workbook.xml`；校验正确 `rels` Default；package/workbook 全部 internal Target 规范化后必须位于包内且实际存在 |
| committed 清理使用 durable finalizing intent | Review 的 no-orphan 门禁高于初版“index 移除后 journal 仅 best-effort”承诺 | 简单反转为先删 journal（会留下 index 指向缺失 journal并阻断启动） | backup/stage 清完后 index→finalizing；删 journal；最后删 index。journal 存在/已删除两种崩溃状态都可从固定根安全收尾，绝不回滚新 target |
| committed 后 generation temp 清理失败不反转成功 | 正式目标已耐久提交后，finally 中 `rmSync` 的 `EPERM/EBUSY` 若继续抛出，会把实际成功显示为失败并诱发重复发布 | 把 temp 清理与事务 commit 绑定；静默吞错且无审计 | 清理 helper 捕获删除异常并写活动日志 warning，四个入口保持 success；残留 temp 可后续人工清理，不进入业务错误报告 |
| 正式发布与回滚恢复统一使用 hardlink no-replace | 实测 `lstat` 后普通 rename 仍可在 syscall 内覆盖并发创建的 target；target→backup 与 backup→target 同样存在覆盖窗口；默认 Number Stats 还会舍入 64-bit inode 或把 `ino=0` 误当可信 | 继续用检查+rename；hardlink 失败后 fallback rename；用默认 Number `dev/ino`；宣称 Node 提供原生 `RENAME_NOREPLACE` | stage→target、target→backup、backup→target 均 `linkSync + fsync + bigint dev/ino 复核 + unlink`；`ino<=0`、identity 不精确、`EEXIST`/不支持均 fail-closed，无覆盖式 fallback；link 后/source unlink 前崩溃可恢复 |
| 新式 index 的路径清单同时是全局 managed-path 闭包 | probe 可令 target 指向固定 index，或令第二 target 等于第一 staging，造成恢复根自覆盖/结构中毒 | 只做 target-target 去重和“随机路径当前不存在”检查 | addIndex 前统一比较 index/journal/全部 target-stage-backup alias；artifact 碰撞及 target 落在 generation 父目录也零副作用拒绝 |
| 无锚点 legacy v1 一律 manual-only | 同 hash victim probe 证明旧 journal 可把未知文件当 generated 删除并把 backup 覆盖过去；index 没有独立真相可安全迁移 | 为兼容而继续自动 publish/recover；从同一不可信 journal 反推锚点 | publish/recover 均只返回 index/journal 人工路径，不读 journal 后触碰 managed file；安全优先于未发布协议的自动兼容 |
| prepared 取消与 rollback 也使用 durable terminal intent | 注入 journal 删除失败时，旧顺序先删 index 会留下永不可发现的孤儿 journal；多目录 staging 删除不 fsync 还可能在掉电后复现 | index 先删、journal best-effort；复用 committed finalizing 语义；只 fsync journal 所在目录 | cancel 先写 `cancelling`，逐个删除 staging 并 fsync 各父目录；rollback 完成后写 `rollback-finalizing`；两者均删/fsync journal 后最后删 index |
| 人工恢复错误默认保留并展示 generation | 业务型 ManualRecovery 经真实 worker 返回时原错误未设置 `preserveTemporaryFiles`，main 四入口会执行 finally 删除临时目录；rollback terminal 收尾错误虽保留目录却未把 artifact 路径展示给用户 | 只在 worker transport+recovery 双失败时设置；依赖调用点猜测错误名；只返回 journal/index | ManualRecovery 构造器统一设 true；可读 journal 的三处 rollback 收尾错误统一返回 index + artifact/target/backup/staging/journal；现有跨 worker 序列化与四入口统一保留开关生效 |

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
| 初版 BIFF8 scanner 未解析 `Dimensions`，且 writer 丢弃合法零布局 | 增加唯一 Dimensions 半开区间校验、Row reserved 校验和零布局等价投影 | 独立 BIFF8 边界审计发现损坏 used-range 会通过、零宽/默认隐藏会静默变可见 | 增加解析、writer→strict reader roundtrip 与 LibreOffice 产物回归；不改变工具箱业务值/行选择 | 是 |
| 初版发布顺序为“staging → 外部 journal → 固定 index” | 改为“固定 preparing intent → 外部 preparing journal → staging/复核 → journal prepared → index prepared” | PR Review 证明前两种崩溃窗口无法从固定恢复根发现 | 新版 index entry 增加 discovery state/nonce/路径清单；后续对抗 probe 又证明旧 v1 无锚点自动恢复不安全，因此 v1 最终收敛为 manual-only；Spec 5.3 已反向同步 | 是 |
| 初版发布核心在 Electron 主进程同步执行 | 保留同步、可故障注入的事务核心，但生产入口通过 FIFO Worker dispatcher 调用 | 大产物多轮 hash/copy 会冻结 UI；单纯把 generation 放 Worker 不覆盖最终另存为 | 四个 publish 调用点和启动恢复均 await 异步 dispatcher；worker 异常退出先恢复，错误字段跨线程保留 | 是 |
| 初版 committed 收尾先移除固定 index、再 best-effort 删除 journal | 增加 durable `finalizing` 状态并把固定 index 改为最后删除；同一 no-orphan 规则随后扩展到 `cancelling` 与 `rollback-finalizing` | Review 明确要求任一残留都能从固定恢复根发现；简单换序会制造缺 journal 阻断；后续 probe 证明 cancel/rollback 仍会留下孤儿 | 三种 terminal intent 都先固定恢复职责、再删 journal、最后删 index；legacy v1 不自动升级 | 是 |
| staging 文件以只读 `r` 句柄执行 `fsync` | 仅该 staging 文件改用 `r+`，目录句柄和哈希读取仍为只读 | Windows `FlushFileBuffers` 对只读普通文件句柄返回 `EPERM`；忽略该错误会放宽耐久性 | Windows 可完成文件刷新；文件字节、摘要、状态机和失败关闭规则不变 | 是 |
| 发布 tag 一经推送即不重建 | 首轮 workflow 在任何 Release/资产生成前失败后，把该 tag 视为失败触发器；仅在热修合入、最新 `main` Windows 构建通过且 Release 再次确认为不存在时重建到修复后的 `main` | 原 tag 指向不含 Windows 修复的提交，无法产出可用 v3.1.2；保留旧 tag 或重复运行都会继续失败 | 只移动未发布 tag，不覆盖 GitHub Release 或资产；旧/新 commit、失败/成功 run 和恢复检查全部留档 | 是 |

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
| 初版 `npm run release-check` | 当时源码状态 lint PASS；smoke PASS；unit 4316/4316 PASS（270 files，日志 `logs/unit-tests/unit-20260730-053747.log`）；integration 2051/2051 PASS（44 scripts） | 保留 PR #104 复审前的历史门禁血缘；最终证据见下方最新行 |
| 初版重要变量扫描 | 当时源码状态 `npm run scan:vars` 成功刷新 240 files / 3031 top-level names；`npm run check:vars -- --include-minor` 未命中重要变量 | 保留历史扫描血缘；最终源码扫描结果见下方最新行 |
| 独立发布门禁 review | 初次 P0=0、P1=0、P2=0、P3=0；后续 BIFF8 边界与零布局对抗 review 的 Finding、修复和最终结论在下两行保留完整血缘 | 代码、测试、Spec/文档和格式边界独立复核 |
| BIFF8 merge 前补充边界审计 | 首轮发现 P2×2、P3×1：缺少 Dimensions 校验、合法零布局丢失、Row reserved1 未校验；另由真实 LibreOffice 文件复现 `ColInfo.colLast=256` 哨兵 | 合并前对真实生成器兼容、最大行列和隐藏布局做二次收口；修复后须重新执行全量门禁和独立 review |
| 零布局补丁二次 review | 发现并修复 P1×1、P2×1、失败路径 P3×1：`Number(null)` 误写 0；BIFF8 hidden+0 缺 `zeroHeight`；兼容层若在文件流创建后安装失败会残留半文件。交叉空 Dimensions 的 P3 因无规范 MUST 已撤回，未扩大拒绝范围。最终独立复审 P0=0、P1=0、P2=0、P3=0；定向 65/65、工具箱矩阵 285/285、完整 release-check 均通过 | 显式判缺失；统一传递 `defaultRowHidden`；输出正高度 + `zeroHeight=1`；兼容层在创建文件流前安装并包装错误；writer→strict reader、默认隐藏下显式可见行和普通路径均有回归 |
| PR #104 Review 有效 Finding 定向回归 | 联合定向测试 109/109 PASS；其中 writer 严格校验 22/22、publication core 28/28、worker dispatcher 3/3、启动失败 2/2，另含错误序列化、main 接线与 renderer 回归 | 截断 Content Types/workbook/worksheet、缺 Sheet/错表头/少行/游离 worksheet、验证后同大小变异、preparing 五窗口、真实目标 rename 后 worker crash 回滚、FIFO、heartbeat、启动恢复失败阻断与路径展示 |
| PR #104 二次对抗复核补充 | writer 25/25 PASS、publication core 31/31 PASS、dispatcher 6/6 PASS（最终联合/全量数字待下次门禁刷新） | 扫描前后同大小换文件、rename 后 target 漂移、悬空 Content Type/relationship、finalizing 两个崩溃窗口、worker exit barrier |
| PR #104 publication syscall/恢复根对抗 probe | 普通 rename 的 stage→target、target→backup、backup→target 均可在检查后覆盖未知文件；legacy v1 同 hash victim 被自动改写；跨项 managed path 可覆盖固定 index；cancel/rollback journal 删除失败会成为不可发现孤儿 | 直接推翻“紧前 lstat 足够”“v1 自动兼容安全”“committed finalizing 已覆盖全部 no-orphan”的假设，并驱动 Spec 反向同步 |
| publication no-replace/legacy/path/no-orphan 定向回归 | publication core 50/50 PASS；连同真实 worker dispatch、serialize-error 和 main 四入口接线共 82/82 PASS | 三个 link syscall 边界、两处 link→unlink crash、source 替换、hardlink 不支持、legacy manual-only victim、固定 index 自身保留、全局路径闭包、generation 目录保护、cancelling/rollback-finalizing、ManualRecovery 临时目录保护跨 worker |
| PR #104 最终 OPC/成功清理补充回归 | writer strict OPC 29/29 PASS；main/renderer 临时目录保留、清理与成功语义 42/42 PASS；连同 publication/dispatcher/错误序列化联合最终 149/149 PASS | `_rels/.rels`、`rels` Default、唯一 internal `officeDocument → workbook`、package/workbook internal Target 闭包，以及 committed 后 `EPERM/EBUSY` 清理只告警不反转 success |
| publication 最终 inode/耐久性对抗复审 | 发现 P2×1：默认 Number `dev/ino` 可因 `ino=0` 或 64-bit 舍入误删替换 source；P3×2：cancel 未 fsync 每个 staging 目录、rollback 三个收尾错误未展示 generation；用户手册 hardlink 提示由并行主审同步 | 驱动 bigint identity fail-closed、跨目录取消耐久化与人工恢复路径闭包；所有 Finding 均有确定性故障注入 |
| publication 精确身份/取消耐久性/恢复路径补充回归 | publication core 54/54 PASS | `ino=0` fail-closed、超过安全整数的相邻 inode 精确区分、跨目录 staging 取消逐目录 fsync、rollback 三个收尾失败窗口展示 generation 路径 |
| 最终重要变量与 smoke 门禁 | `scan:vars` 刷新 242 files / 3077 top-level names；`check:vars -- --include-minor` 命中既有 `normalizeCell`、`serializeError` 两项 Important-skeleton；`npm run smoke` 全部 PASS | `normalizeCell` 的 Excel/CSV/PDF 读写放大面未回归；serializeError stack/cause/FileValidationError/ManualRecovery 新字段双向契约由完整单测与 smoke 覆盖 |
| PR #104 最终 `npm run release-check` | 冻结源码状态 lint PASS；smoke PASS；unit 4376/4376 PASS（272 files，日志 `logs/unit-tests/unit-20260730-095713.log`）；integration 2051/2051 PASS（44 scripts，总耗时 309139ms） | 覆盖严格 OPC、54 项 publication 故障注入、Worker FIFO/heartbeat、30 万行流式回放与全仓既有功能；该行是提交依据 |
| General 尾零纯函数与合并端到端回归 | 定向 22/22 PASS；覆盖 `.0/.00`、零/负数、中间零、非零有效小数、正负科学词法、非 General 语义格式，以及原始格式长度 240/241 的 number/text 边界 | 防止再次按原始 scale 生成 `0.#`，同时锁定 numeric 值、格式输出及既有安全降级类型 |
| 用户三文件真实回放与修复前后对拍 | 合并 27,716 行；目标 `COMMON!J3/J151` 均为 numeric `1200000`、显示 `1200000`、`numFmt='0'`。修复前后 Sheet 与 `A1:Z27717` 范围一致，逐格对拍 564,238 个单元格的类型/值/公式差异为 0；仅 12,997 个格式由 `0.#` 变为 `0` | 真实来源边界、全表影响面、目标两行显示、业务值零差异与行数守恒；源文件和原结果未改动 |
| General 尾零修复最终重要变量检查 | `npm run scan:vars` 刷新 242 files / 3078 top-level names；`npm run check:vars -- --include-minor` PASS，本次唯一 `src/` 改动未命中 Critical / Important-skeleton / Runtime-state / Risk-sensitive / Minor | 不需要追加关联功能 review；仍以工具箱定向矩阵、真实回放和全量门禁作为行为证据 |
| General 尾零修复最终 `npm run release-check` | 最终源码状态 lint PASS；smoke PASS；unit 4378/4378 PASS（272 files，日志 `logs/unit-tests/unit-20260730-125849.log`）；integration 2051/2051 PASS（44 scripts，总耗时 298728ms） | 覆盖全部既有功能，并包含新增纯函数、240/241 门禁边界和真实 OOXML `<v>1200000.0</v>` 合并回归 |
| 独立 review 的格式长度 P3 收口 | 首轮发现 effective scale 若同时参与 240 字符门禁会把极端尾零由 text 变 number；改为输出/门禁双尺度后，`1.0e-237` 保持 number，`1.0e-238` 与 239 位小数零保持 text + `@`。两位独立 reviewer 最终均确认 P0/P1/P2/P3=0；88,000 组尾零/指数/长度边界词法与基线分类对拍 `outputType/reason` 零差异；工具箱定向矩阵 62/62 PASS | 关闭确定性的 numeric/text 契约漂移，最终实现、测试和行为文档一致 |
| 合并与人工验收状态 | PR #104 合并提交 `e5a999c`，PR #105 合并提交 `05c3dbf`；用户于 2026-07-30 明确确认人工验收通过 | 代码已进入 `main`；Windows Excel/WPS 人工发布门禁按用户签字关闭，不补写未提供的样本明细 |
| 合并后干净环境发布门禁 | `npm ci` 成功；`npm run release-check`：lint/smoke PASS、unit 4378/4378 PASS（272 files，日志 `logs/unit-tests/unit-20260730-132526.log`）、integration 2051/2051 PASS（44 scripts，总耗时 297113ms）；`verify:main-panel-alignment` 6/6 PASS，最大中心误差 0.0039 CSS px | 证明最终合并源码树保持全量回归与主页面几何契约；随后仅修改发布文档与自动刷新报告 |
| 合并后重要变量与生产依赖审计 | `scan:vars` 刷新 242 files / 3078 top-level names；`check:vars -- --include-minor` 因 `src/` 相对 HEAD 无改动而安全跳过；`npm audit --omit=dev` 保留既有 9 条生产依赖告警（0 critical、7 high、2 moderate），相对 v3.1.1 无生产依赖图变更 | 重要变量硬节点已执行；既有依赖告警继续作为独立治理项，不在发布收尾阶段无评审升级依赖 |
| 首轮正式 Windows Release workflow | run `30567689697`：tag/main 校验与依赖安装通过；`release-check` 在 unit 阶段 4322/4369 PASS、46 FAIL，全部失败链路共同落到 staging 普通文件 `fsync` 的 `EPERM`；构建与 Release 步骤均未执行 | 证明无同名 Release/资产被部分发布，并锁定 Windows 普通文件句柄权限缺口 |
| Windows staging fd 定向回归 | `node --test tests/unit/toolbox-output-publication.test.js` → 55/55 PASS；新增测试在 staging fd 为只读时模拟 Windows `EPERM`，并断言实际执行 `fsync` 的唯一 staging mode 为 `r+` | 防止再次用只读 fd 调用 `FlushFileBuffers`，同时覆盖完整 publication 状态机与故障注入矩阵 |
| Windows staging fd 热修完整发布门禁 | `npm run release-check`：lint/smoke PASS、unit 4379/4379 PASS（272 files，日志 `logs/unit-tests/unit-20260730-140540.log`）、integration 2051/2051 PASS（44 scripts，总耗时 291525ms） | 覆盖新增 Windows fd 契约、全部 publication 故障注入、30 万行流式路径及全仓既有功能 |
| Windows staging fd 热修重要变量门禁 | `npm run scan:vars` → 242 files / 3078 top-level names；`npm run check:vars -- --include-minor` PASS，本次唯一 `src/` 改动未命中重要变量 | 发布/合并硬节点已执行；无需追加重要变量关联功能清单 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| BIFF8 scanner 对 cell record、XF 继承、Continue 和 palette 的完整覆盖 | RESOLVED | record fixture、真实资产与 overlay mismatch 故障注入已覆盖 | 无 |
| BIFF8 Theme/XFExt 最终颜色映射 | RESOLVED | 真实资产和最小 fixture 已覆盖 theme/palette/automatic/未知必需色 | 无 |
| Windows Excel/WPS 人工打开 | RESOLVED | 用户于 2026-07-30 明确确认人工验收通过；不扩写未提供的样本明细 | 发布门禁已关闭 |
| 30 万行 XLSX 内存与耗时上限 | RESOLVED（自动门禁） | 新生产入口峰值 RSS 426MB，总耗时 108.9s；Windows 实机仍随发布资产复核 | 自动性能门禁不阻塞；实机人工项保留 |
| Windows/网络盘输出目录是否支持同目录 hardlink | ASSUME（显式 fail-closed） | Windows NTFS 发布回放必须覆盖；不支持 hardlink 的 FAT/部分网络盘由错误路径明确拒绝，禁止 fallback | 不影响文件安全；支持范围需在发布验收/用户文档中确认 |

## Reconciliation Blindspot Pass（General 尾随小数点修复后）

- 输入到输出的数据选择、金额数值、币种、方向和匹配口径未变；本轮只修正 General/显式科学格式安全数字自动生成的 `numFmt`，不改变 canonical、`matchValue` 或 numeric/text 分类。
- 每个 writer emit 行只计一次，输出按 `Sheet ×（表头 1 行 + 数据行）` 流式回读；0 数据行仍要求一页表头，分页总数据行必须与 writer 计数精确一致。
- generation 的校验身份贯穿 prepare/staging，正式目标只在 index/journal 均 prepared 后改动；异常退出、部分 copy、部分 hardlink 发布和外部篡改都有互斥去向与故障注入。
- “临时产物校验：通过”只在严格 Content Types/workbook/rels/全部 worksheet/styles、行数和摘要均通过后写入；启动恢复失败同时进入日志和用户可见启动阻断。
- 本轮命中金额**可见格式**资金红线，但未改变金额值、账号/主体/币种、金额方向、匹配主键或记账幂等规则；用户三文件回放已核对目标两行、全表影响计数和 27,716 行守恒。用户已于 2026-07-30 明确确认 Windows Excel/WPS 人工验收通过，该资金可见格式发布门禁已关闭。
