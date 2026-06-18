# 版本功能变更清单

说明：

- 本文档按版本号整理 `新增 / 变更 / 移除` 功能点。
- 内容以 [CHANGELOG.md](../CHANGELOG.md) 为事实来源整理。
- 以后每次版本迭代，需同时更新：
- `CHANGELOG.md`
- `docs/VERSION_FEATURE_HISTORY.md`
- `docs/USER_GUIDE.md`

## v3.0.9（2026-06-18）

v3.0.9 集中 **1 项**核心需求（无并入 spec）：**工具箱「按字段值拆分」支持 800MB / ~700 万行多 sheet 大文件**。新建一条隔离的、worker 化的、内存有界的工具箱大文件拆分通道，复用 `big-table-import/` yauzl 流式原语（`zip-reader.js` / `row-scanner.js`），🔴 绝不碰 `streaming-xlsx-reader.js`（隔离资金红线复用文件）、🚩 前端零改动（回传契约 `valuesByField={field:string[]}` 逐字节一致）、小文件路径零回归（路由 fail-closed）。

**新增**

- 工具箱大文件按字段拆分隔离 worker 通道（`src/backend/toolbox-xlsx-stream/` 5 模块 + `src/main-process/` 2 模块）：① `multi-sheet-reader.js`（T1）多 sheet 当一张逻辑表流式读（复用 `openZipWithEntries`/`locateSheets`/`loadSharedStrings`/`scanSheetRows`，绕 `openWorkbook` 多 sheet 拒绝，续页语义 = 重复表头跳过 / 列数超表头报错）；② `bounded-values-accumulator.js`（T2）每列封顶 N=1000 有界去重 + 全局 maxTotalDistinct=200000，回传 `string[]` 同契约；③ `split-scan-fields.js`/`split-export-filter.js`（T3）扫字段 + 按值过滤流式写（peek 表头 O(1) 早退 + `writeRowsStreamed` 超 104 万行自动分 sheet）；④ `large-split-worker.js`+`toolbox-large-split-dispatch.js`（T4）worker_threads 隔离（`maxOldGenerationSizeMb=4096`）+ sharedStrings 护栏（>~1.2GB 可解释拒绝）+ heapUsed>~3GB 主动拒；⑤ `toolbox-large-split-router.js`（T5）`shouldUseLargeChannel` 只用 `collectEntrySizes` 判定（不解压、禁用全读 buffer 的 `readXlsxSheetMetaLite`），多 sheet 或单 worksheet ≥1.5GB → 大通道，否则 fail-closed。

**变更**

- `main.js` 工具箱两 handler（`toolbox:split:read`/`toolbox:split:export`）加大通道路由分叉（T6，唯一改动的既有 src 文件）：命中走 `dispatchLargeSplit`（worker），否则走现有小文件分支（一字未改、行为不变）；export 临时大文件改 `try/finally` 可靠清理。

**修复**

- B20 工具箱拆分成功路径临时目录不清理（split:export 半，随 T6 顺带修）：`toolbox:split:export` 各路径统一 `finally rmSync` 清临时 xlsx（`toolbox:merge` 半本迭代不碰、仍留 backlog）。

**已知限制（前端零改动的代价）**：OPEN-1 高基数列下拉只显前 ~1000 值无截断提示（按字段拆通常用低基数维度，影响有限）；OPEN-2 sharedStrings >~1.2GB 全唯一长文本文件 v1 可解释拒绝；OPEN-3 进度走后端 log、无进度条/cancel UI。

**无对外契约变更**（前端零改动 + 小文件零回归 + 回传契约逐字节一致）。

## v3.0.8（2026-06-16）

v3.0.8 迭代：共 **7 项**——5 项新反馈 + 2 份并入的 v3.0.7 资金红线修复 spec（team-lead 拆分委托 dev 分 W1~W6 实施，W4=需求6+需求3 合并工作流）。① 需求1 工具箱🧰（合表/拆表）——主界面左下角新增🧰按钮 → 脱离主对账流程的轻量 Excel 小工具：合并多个表头一致的表为一张（导入即一气呵成另存为 `合并-YYYYMMDDHHmm.xlsx`）、按某字段的某些值从一张表拆出子集（导入 → 选字段/值 → 导出 `拆分-值-YYYYMMDDHHmm.xlsx`），3 个 IPC（`toolbox:merge`/`toolbox:split:read`/`toolbox:split:export`）复用 file-service 读写，对既有链路零影响；② 需求2 场景管理退役 C3（`gateway-recon-join`，前端隐藏 + 新库不 seed，后端引擎/约束/已有库记录全保留可回滚）+ 两大功能分组（「资金性质校验」「中台订单数据处理」）三角折叠、默认收纳；③ 需求3 资金对账「开始运行」不阻塞（🔴 资金红线）——`bank-statement:run` 改 async + 轮次边界让出事件循环（不上 worker）+ 新增进度通道 `bank-statement:run:progress`，消除运行期窗口「未响应」，对账产物 golden 字节不变；④ 需求4 银行未命中场景 sheet 数据右移 B 列（🔴 对外口径变更）——sheet1 提醒独占 A1、表头/数据整体右移 B 列起；⑤ 需求5 BOC 调拨修复行 Type 2→1（🔴 资金红线/下游契约变更）——修复模板输出列 `Type` 由 `2` 改 `1`；⑥ 需求6 运行内存尖峰修复（🔴 资金红线，并入 spec A）——bank-deposit 入金表加消费方门控（关退款场景不读 ~1.2GB、注入 `[]`）+ gateway-bill 按 Channel 子集下推过滤读 + 删深拷（新增仓储 `readGatewayBillRowsByChannels`），根治 Windows「开始运行」卡死；⑦ 需求7 R5s3 两级 fallback + FundType 子串（🔴 资金红线，并入 spec B）——中台加款单脏数据处理引擎：`ReconciliationId` 匹配不上时用 `ChannelOrderNo` 兜底（两级 fallback、严格 1v1 跨两级共享、一级消歧失败不 fallback）+ 触发条件由精确判等 `FundType==='Inbound'` 改子串包含判定（大小写不敏感），防 `Inbound-VA` 等入金变体被误剔除。质量门 `npm run release-check` 全绿（unit + integration + smoke）。⚠️ 资金红线：需求 3/4/5/6/7 均涉对账 run 路径或输出口径，已人工复核 + golden/等价回归。

### v3.0.8 第二轮追加（2026-06-17，版本号并入 3.0.8 不 bump · 分支 `v3.0.8-userguide-bank-2cols`）

PR #77 合入 main 后第二轮迭代，**5 项**——① 迭代1 使用手册去技术术语 + 总览导航 + 46 列兼容说明（需求8，纯文档）；② 迭代2 银行对账单 44→46 列（需求9，🔴 资金红线，识别 + 字段下拉可选 + BU 回填兼容导入·不落库）；③ BUG2 场景管理弹窗用户自建 C3 误消失修复；④ BUG3 工具箱合并/拆分大文件（30 万行）OOM 闪退 / 误报「文件为空」改流式修复（🔴 顺带修 `streaming-xlsx-reader.js` 读值正则，银行对账单导入复用、升级必读）；⑤ 工具箱弹窗尺寸微调。`npm run release-check` 全绿（unit **3040/3040** + 34 集成脚本 + smoke 全模块 PASS）+ 用户手动测试 BUG2/BUG3 通过。

**🔴 对外契约变更（升级必读，详见 CHANGELOG「v3.0.8 第二轮追加 · 🔴 对外契约变更」段）**

- ① 银行对账单模板 44→46 列（迭代2 · 🔴 资金红线）：「渠道对账单」sheet 在 `'Transaction Description'` 后加「合并单号」「合并状态」；软件识别 + 字段下拉可选 + BU 回填兼容导入忽略两列、不落库（新旧 44/46 列文件均识别、宽容超集校验、按列名取值防后移列错位、`bank_bu_recon_bank_imports` 列结构不动）；旧版 44 列文件行为不变、Pending 严格校验零波及。
- ② `streaming-xlsx-reader.js` 读值正则修复（含首尾空格字符串不再被读空）（BUG3 顺带 · 🔴 资金红线 · 影响银行对账单导入读值）：`V_CONTENT_RE` 改为容忍 `<v>` 任意属性（`xml:space="preserve"` 的含首尾空格单元格旧版被读空、本次修复，裸 `<v>` 仍匹配向后兼容）；该读取器被银行对账单导入复用 → 升级后此前读空的含首尾空格列会读到真实值，**建议真实数据回归银行对账单导入读值**。
- ③ 工具箱合并/拆分大文件改流式（30 万行不再闪退）（BUG3 · 🟡 性能）：SheetJS 全量读 → 流式读 + `WorkbookWriter` 流式写，输出与现状完全一致、超 104 万行自动分 sheet、csv/xls 回退；无对外列契约 / 文件名规则变化。

**新增**

- 迭代2 银行对账单 44→46 列（🔴 资金红线）：`BANK_STATEMENT_FIELDS` 44→46（「合并单号」「合并状态」插在 `'Transaction Description'` 后）+ `preload.js` inline 副本逐列同步；`table-signatures.js` `expectedHeaders` 复用自动跟随、`signatureHeaders` 指纹列不变（新旧均识别）；`validator.js` 加 `allowSupersetColumns`（银行宽容超集、Pending 严格零回归）；`reader.js` 改按列名 `headerIndexMap` 取值（防后移列错位）；`columns.js BANK_HEADERS` 保持 44 列不动=不落库。`assets/银行对账单.xlsx` 升级 + `header-superset-mapping.test.js` 新增 + 改 2 测。
- 流式 Excel 读写模块 `toolbox-stream-io.js`（BUG3 载体）：读侧 `.xlsx` 复用 `readXlsxStreamed`（内存恒定）、`.csv`/`.xls` 回退全量；写侧 `ExcelJS.stream.xlsx.WorkbookWriter` 逐行写 + by-name 格式（与 `writeWorkbookRows` 一致）+ 超 `1048575` 行自动开 sub-sheet。`main.js` 三 IPC（`toolbox:merge`/`toolbox:split:read`/`toolbox:split:export`）改走流式。

**变更**

- 迭代1 使用手册 `docs/USER_GUIDE.md` 全册去技术术语 + 1.4 总览导航 + 1.6.1 银行 46 列兼容说明（🟢 纯文档）：约 567 处技术术语 → 业务白话（6 段并行只读审查 → 单 agent 串行应用 → grep 验证，核心禁用词全册清零；软件界面名 / Excel 真实列名 / 渠道数据真值保留并配中文解释；历史 changelog 不洗——用户拍板）；SOP 沉淀 `knowledge/user-guide-dejargon-playbook.md`；零业务代码改动。
- 工具箱弹窗尺寸微调（🟢 体验）：`.toolbox-card width` 230→`min(94vw, 246px)`（左右各 +8）+ `.toolbox-body padding-bottom` 12→27 + `.toolbox-card transform: translateY(7.5px)`（口径 B：下沿净 +15、上沿不动，卡片高净 +15）；纯样式、preview 回归。

**修复**

- BUG2 场景管理弹窗用户自建 C3 在 v3.0.8 后误消失（🟢 体验回归 · `renderer-dialogs.js:7051`）：需求2 退役自带 C3 时前端过滤一刀切隐藏全部 `gateway-recon-join`，误伤用户自建 C3。过滤由 `s.category!=='gateway-recon-join'` 收窄为 `!(s.category === 'gateway-recon-join' && s.isBuiltin)`——仅隐藏自带 C3（`isBuiltin=true`）、保留用户自建 C3 可见可管理；运行口径 `hasC3Enabled` 未动（已有库手动启用的 C3 仍运行）。
- BUG3 工具箱合并/拆分 30 万行 OOM 闪退 / 误报「文件为空」（🔴 涉资金红线复用文件）：改流式（新增 `toolbox-stream-io.js` + 三 IPC 改流式）+ `readers.js` 内存错误（`isMemoryError`）回「文件过大」真实文案 + 🔴 顺带修 `streaming-xlsx-reader.js V_CONTENT_RE` 读值正则（含首尾空格字符串不再读空，银行对账单导入复用，向后兼容、建议真实数据回归——详见对外契约②）。

### 🔴 对外契约变更（升级必读，详见 CHANGELOG v3.0.8「对外契约变更」段）

- ① BOC 调拨订单修复模板 `Type` 列 2→1（需求5 · 🔴 资金红线 · 下游契约变更）：`boc-dispatch-order-fix.js` 修复模板输出行 `Type` 由写死 `2`（v3.0.4 块 E D9 拍板值）改为 `1`（业务确认）。`Type` 仅落输出 Excel 给下游、src/ 内无按 `Type==值` 过滤逻辑，但下游按 Type=2 解析 BOC 修复模板的脚本/流程需适配 Type=1；匹配/组失败语义零变化。
- ② 资金对账「未命中场景」sheet 列位整体右移一列（需求4 · 🔴 输出口径变更）：sheet1「未命中场景」由「A1 提醒 + 表头/数据均从 A 列起」改为「A1 提醒独占首列 + 表头第 2 行/数据第 3 行均从 B 列起、A 列除 A1 留空」；外部按 A 列解析未命中场景表头/数据的脚本需整体右移一列。仅 sheet1；sheet2「命中场景」零变化；A1 提醒文案、行号不变。
- ③ 资金对账 run 入口 gateway 网关账单改「按 Channel 过滤读」（对账口径：消除跨渠道误匹配）（需求6 · 🔴 资金红线 · 带业务不变量的优化）：`bank-statement:run` 不再全量读网关账单表，改为只读本批银行单出现过的 Channel 子集（新增仓储 `readGatewayBillRowsByChannels`，下推 SQL 过滤 + 处理空/缺 Channel + 归一化口径对齐）。load-bearing 业务不变量（业务负责人已确认）：跨渠道对账永远不存在——Channel=X 的银行行只匹配 Channel=X 的网关行。不漏任何合法匹配；唯一被滤掉的是「跨渠道匹配」（业务定义那本是错配）→ 对账口径上消除跨渠道误匹配（非纯字节不变，已等价测试 + 业务不变量双重背书）。bank-deposit 门控（关退款场景注入 `[]`）为字节级不变优化。

### 新增

- 需求1 工具箱🧰（合表/拆表）：左下角 `background-tool-actions` 加第 4 个 🧰 按钮 → `createToolboxDialog` 弹框。合并表格 = 多选 ≥2 表头完全一致（列名 + 列序）文件 → 一致性校验（不同 → `FileValidationError` → alert 列差异并停止、不产文件）→ 合并（首文件表头 + 各文件数据行）→ 另存为 `合并-{YYYYMMDDHHmm}.xlsx`，一气呵成无独立导出按钮。拆分表格 = 单选文件 → `createSplitFieldPickerDialog`（单选字段 + 多选值、值随字段切换、空选不可导出）→ `[导出文件]` 过滤 `row[field] ∈ values` → 另存为 `拆分-{值拼接 sanitize}-{YYYYMMDDHHmm}.xlsx`（多选值 → 单文件含全部选中值的行）。3 个 IPC 复用 file-service `extractHeaders`/`readRows`/`writeWorkbookRows` + 端到端测试 + preview（4 处入口）。不做表头相似对齐 / 多字段组合筛选 / 一值一文件 / 复用主对账模板列映射币种归一化。
- 需求3 资金对账运行进度通道（🔴 资金红线）：新增单向 IPC `bank-statement:run:progress`（main→renderer，仿收单 `createRunProgressForwarder`），`preload` 暴露 `bankStatement.onRunProgress`，`renderer.js` `runBankStatementInternal` 订阅更新状态框；编排器 `runReconciliation` 改 async、轮次边界（R1→R2→R3.5→R4→R5 含 s2/s2b/s3/s4 子轮）插 yield + 进度上报。
- 需求6 网关账单按 Channel 过滤读仓储（🔴 资金红线）：`linked-table-repository.js` 新增 `readGatewayBillRowsByChannels`（仿 `readBankDepositAdmCandidates`），按 Channel 子集下推 SQL 过滤读；三个陷阱——空/缺 Channel（S 含空值时额外 `OR json_extract(...) IS NULL OR ...=''`）/ 归一化口径与引擎 `normalizeCell` 对齐 / 逐轮确认无越界 Channel 需求。`src/backend/database.js` 加 facade。

### 变更

- 需求2 场景管理退役 C3 + 分组折叠：前端 `createScenariosManagerDialog`（`refreshTable`/`renderRow`）过滤 `category==='gateway-recon-join'` 不显示；`migrations.js` `ensureScenariosSupport` 对新库不再 seed C3。不动 C3 引擎/dispatcher case/CHECK 约束/旧库已有记录（仅 UI 隐藏 + 新库不 seed，可回滚，与 R1 强制匹配无关）。按 `config.funcCategory` 归两组（`fund-nature-check`+`dbs-charge-fund-check`→「资金性质校验」、`platform-order`→「中台订单数据处理」），组标题带 ▶/▼ 三角、默认 collapsed（折叠态前端临时、不持久化）；CSS 加 `.scenario-group-header`/`.scenario-group-toggle`/`.collapsed`，preview 回归。
- 需求3 资金对账「开始运行」不阻塞（🔴 资金红线 · golden 字节不变）：`bank-statement:run` handler 改 async + 阶段边界 `await new Promise(r => setImmediate(r))` 让出；`reconciliation-orchestrator.js` `runReconciliation` 改 async / 注入 `onProgress`、仅轮次边界插 yield + 进度上报（轮次顺序/引擎入参/数据匹配逻辑零改动），消除运行期主进程阻塞致「未响应」。不上 worker_threads；进度只做状态框文案更新。
- 需求4 银行未命中场景 sheet 数据右移 B 列（🔴 输出口径，详见对外契约②）：`exceljs-writer.js` sheet1「未命中场景」表头 `getCell(idx+1)→idx+2`、数据 `getCell(colIdx+1)→colIdx+2`（仅右移列、行不变），A1 提醒不变、A 列除 A1 留空。仅 sheet1，golden 回归更新。
- 需求5 BOC 调拨修复行 Type 2→1（🔴 资金红线，详见对外契约①）：`boc-dispatch-order-fix.js` 修复模板输出列 `Type: 2 → 1` + 同步注释 + 单测断言 + golden 更新；匹配/组失败语义零变化。
- 需求6 运行内存尖峰修复（🔴 资金红线 · 并入 spec A，详见对外契约③）：① bank-deposit 消费方门控——`main.js` run 入口加 `refundBackfillEnabled` 谓词（逐字镜像编排器 r5s4 分桶条件），关退款场景注入 `[]` 替代 `structuredClone(readLinkedTableRows('bank-deposit'))`（曾 65.7 万行 ~1.2GB），退款场景关时编排器本就 no-op、结果字节级不变；② gateway-bill 按 Channel 过滤读 + 删深拷——收集本批银行单 Channel 集合 S、只读 `Channel ∈ S` 网关行，`gwRows` 全程只读 → 删 `structuredClone(readLinkedTableRows('gateway-bill'))`。🔴 银行行 `structuredClone(bankStatementSession.rows)` 必须保留（常驻 session、引擎原地改）。根治 Windows 导入约 2862 行普通渠道对账单（Channel=BOSH、CN）后点「开始运行」极卡（卡在 run 阶段全量读多张链接表）。
- 需求7 R5s3 两级 fallback + FundType 子串判定（🔴 资金红线 · 并入 spec B）：`r5-platform-inbound-cleanup.js` 三处——① 建双键索引（`bankByReconId`+`bankByChannelOrderNo`）；② 两级 fallback——网关同一 `reconciliationid` 值优先撞银行 `ReconciliationId`（一级），一级「查无此行」才退撞 `ChannelOrderNo`（二级）；🔴 一级消歧失败（0/≥2 条 Credit）不 fallback（保持 `no-credit-match`/`multi-credit-match` 警告并跳过——只补「查无此行」不补「有歧义」），二级同套 Credit 消歧（警告补「(按 ChannelOrderNo 匹配)」标记），`usedBankRowId` 跨两级共享严格 1v1；③ 触发条件由「`FundType !== 'Inbound'` 才剔除」改「`FundType` 不包含 `excludeFundType` 子串才剔除」（大小写不敏感 `ft.toLowerCase().includes(ex.toLowerCase())`，`ex===''` 显式走全产分支防 `includes('')` 恒真反转）。不动 `buildCleanupRow`/配置 seed（`excludeFundType:'Inbound'` 字段名与值不变）/`ChannelOrderNo` 只作匹配键。对现有 12 值 FundType 枚举零行为变化（仅 `'Inbound'` 含 "Inbound" 子串）。

## v3.0.7（2026-06-16）

v3.0.7 迭代：资金对账数据处理模块 体验/产出优化 + 一项 CI 打包红线修复——① 需求1 状态框文案重排（纯展示：「已处理」按「渠道-地区」分组多行、移除「N 警告」尾巴、新增「中台加款单脏数据处理」(R5场景3) +「中台退款订单回填」(R5场景4) 两行命中数，启用即显示含「0 条命中」）；② 需求2 面板简化 +「导入文件」通用入口（🔴 资金红线：删「导入不平表」及其「导出文件」网关按钮对，「导入对账单」改名「导入文件」并升级为按表头识别 + Channel 二次路由的通用导入——ADM/BOC/JPM-US 44 列文件落 `linked_bank_deposit` 链接表供 R1-R5 / R5 退款二跳消费、含常规渠道则走主处理；状态框合并跨两行增高、按钮零位移）；③ 需求3 命中明细格式重排（纯展示：结果文件命中明细 `字段名:旧值→新值`，数字→中文双引号 `"v"` / 否则→半角尖括号 `<v>`，多条 `; ` 单行连接、关闭 wrapText 不撑高行）；④ dist-size 守卫阈值校准（🔴 CI/打包红线：`check-dist-size` asar 上限 25MB→70MB，修复 main 自 v3.0.5 起 build 作业因 `app.asar≈57.5MB` 超阈值 `exit 1`）。质量门 `npm run release-check` 全绿（unit 2858 / integration 31 脚本 1424 用例 / smoke 全模块 PASS）。⚠️ 资金红线：仅需求2「导入文件」改了链接表数据来源（R1-R5 / R5 退款二跳）；需求1/3 纯展示/格式，不改对账值/匹配/派生。

### 🔴 对外契约变更（升级必读，详见 CHANGELOG v3.0.7「对外契约变更」段）

- ① 「导入对账单」改名「导入文件」并升级为通用导入入口（需求2）：id/handler/IPC 不变，升级为「识别+路由+落库桥接」——44 列文件先按 `BANK_STATEMENT` 识别再读 Channel 二次路由：非空 Channel 全 ∈ {ADM,BOC,JPM-US} → 整文件走 bank-deposit 链接表导入（+ ADM/BOC 派生，JPM-US 行落 `linked_bank_deposit` 供 R5 退款二跳）；含常规渠道 → 照旧 R1-R5 主处理。链接表是 R1-R5 / R5 退款二跳的数据来源，落库后仍进主处理；「链接表管理」入口与功能不变（两入口并存）。
- ② 退款回填务必「一次多选」导入退款单 + 银行单（🔴 资金红线操作约束）：分两次导入（先退款单后银行单）会触发既有「导入新银行单清空退款 session」逻辑 → run 时退款池空 → 退款回填静默失败、无文件产出；需求1 新增「中台退款订单回填:0 条命中」可作运行时自检信号。

### 新增

- 需求1 状态框命中提醒扩展（纯展示）：「已处理」改用 `stats.channelRegionHits` 按「渠道-地区」分组多行（渠道-地区口径复用 `channelEnumRepository.extractChannelRegionCombos`，旧数据缺字段回退 `hitScenarios` 旧格式不抛错）；新增「中台加款单脏数据处理」(R5场景3) +「中台退款订单回填」(R5场景4) 两行（场景启用即显示含「0 条命中」，`r5s3Enabled`/`r5s4Enabled` 门控）。
- 「导入文件」通用导入路由专项集成测试 `scripts/integration/bank-statement-universal-import-routing.js`。

### 变更

- 需求2 面板简化 +「导入文件」入口（🔴 资金红线）：删原 row2 两个网关按钮（导入不平表 / 导出文件，含 renderer DOM 缓存/事件/导出 disabled 网关分支清理）；「导入对账单」→「导入文件」（详见对外契约①）；原 row2(场景管理)+row3(链接表/状态框) 合并为单 control-row（2 列×2 行 grid），状态框跨两行 + `align-self:stretch` → 垂直高度由 110px 增至 ≈176px（上沿对齐场景管理、下沿对齐原下沿；场景管理/链接表管理/开始运行/导入文件 零位移，像素级实测复核）。
- 需求3 命中明细模板重排（纯展示）：结果文件命中明细 `字段名:旧值→新值`（`wrapHitValue`：trim 后含 `/\d/` → 中文双引号 `"v"`、否则 → 半角尖括号 `<v>`）；多条 `; ` 单行连接、命中明细单元格关闭 `wrapText` 不撑高行；OPEN-7 跨期提醒 append 由 `\n` 改 `; `。
- dist-size 守卫阈值（🔴 CI/打包红线）：`scripts/check-dist-size.js` `MAX_ASAR_BYTES` 25MB→70MB（实测 `app.asar≈57.5MB` + 余量），修复 main 自 v3.0.5 起 build 作业 "Check dist size" `exit 1`（PR 跳过 build job 故未暴露）；纯配置常量、零运行时改动、不删依赖、保留防回归。

### 移除

- 资金对账面板「导入不平表」及其右侧「导出文件」网关按钮对（网关 ReconID 修复仍可经「对账单 ReconID 修复」模块使用，后端零改动）。

## v3.0.6（2026-06-16）

v3.0.6 迭代：资金对账数据处理模块，三需求 + 一项退役（team-lead 拆分委托 dev 分 T1~T11 实施）——① 需求1 调拨对账单派生（「链接表管理」导入「中台调拨订单」后自动派生隐藏表「调拨对账单」，一行中台单 → FundTransfer-in / out 两行）；② 需求2 中台调拨订单对账ID回填「数据来源二选一」（R5 场景2 新增勾选框「对账数据来源为中台调拨单表」，默认勾选，勾选用调拨对账单回填、取消沿用网关对账单）；③ 需求3 DBS-Charge 资金校验（原全渠道「Charge转outbound」整体重写为 DBS 专属，对账编排新增 R3.5 轮）；④ charge-outbound 退役（非 DBS 渠道不再 charge→outbound，v3.0.4 块 G「多 Charge 取 Debit 最大行」移除，旧库每次启动幂等删除）。质量门 `npm run release-check` 全绿（unit 2803 / integration 30 脚本 / smoke 全模块 PASS）。⚠️ 多处资金红线：需求1 派生表是需求2 / 需求3 的数据来源（大账号按方向取卡号、全角括号列名漂移=大账号全空）；需求2 / 需求3 均改写银行 `ReconciliationId`（需求3 还改 `FundType`）；需求3 R3.5 在 R4 前演化 `bankRows` 同一引用（叠加链跨轮保留）。

### 🔴 对外契约变更（升级必读，详见 CHANGELOG v3.0.6「对外契约变更」段）

- ① 非 DBS 渠道不再有 charge→outbound（charge-outbound 退役）（需求3）：原全渠道「Charge转outbound」子场景（含 v3.0.4 块 G「同 ReconciliationId 多 Charge 取 Debit 最大行」边界）整体退役，全渠道不再发生 charge→outbound 改写；改由仅 `Channel=DBS` 生效的 R3.5 承接。存量非 DBS 渠道升级后原被改写的行保持 `Charge`，下游 `outbound→HX-out` 链行数减少；旧库 `charge-outbound` 条目每次启动幂等 DELETE（含级联删关联表）。
- ② 「中台调拨订单对账ID回填」默认数据源由网关对账单改为调拨对账单（需求2）：R5 场景2「请选择适用的银行渠道」弹窗新增「对账数据来源为中台调拨单表」勾选框，默认勾选。勾选（含老库无字段缺省）→ 用需求1 派生的调拨对账单与银行 `FundType=FundTransfer-in/out` 行按日期[同日优先+±1天兜底]+大账号+金额+币种匹配回填 `ReconciliationId`；取消 → 沿用原 R5s2 网关对账单。存量用户升级后默认走调拨对账单，依赖网关的需取消勾选，且须先导入「中台调拨订单」派生出数据源。
- ③ 新增 R3.5「DBS-Charge 资金校验」轮次（默认启用，改写 DBS 银行行 `ReconciliationId` + `FundType`）（需求3）：编排 R3 后 R4 前新增 R3.5，默认启用（写死场景 seed `enabled=1`）。触发=`Channel=DBS`；步骤1 调拨对账单（付收渠道=DBS）↔DBS 银行单按大账号+金额+币种 1v1 匹配，命中标 `FundTransfer-in/out` + 赋 `ReconciliationId`、同 `ReconID` 其他 DBS 行归 `Charge`；步骤2 剩余 Charge/outbound 候选与同 `ReconID` 网关 amount/currency 相等→outbound、未命中→Charge（语义翻转）。`chargeSiblingsScope` 默认 `dbs-only`；DBS 空/调拨对账单空时整体 no-op。

### 新增

- **需求1 调拨对账单派生**（🔴 资金红线）：「链接表管理」导入「中台调拨订单」后自动派生隐藏表「调拨对账单」（`linked_fund_transfer_recon`，不进 `ALL_TABLE_KEYS`/`linked_table_meta` 隐藏红线，与 BOC 两张派生表同构）。派生纯函数 `buildFundTransferReconRows`（仿 `adm-bank-deposit-builder.js`）：一行中台调拨订单 → FundTransfer-in + out 两行，字段经 `FT_RECON_FIELD_MAP` 常量单一真相取（中台源列含全角括号，半角化即取空 → 大账号全空资金红线）——调拨单号 / `BillDate`(交易时间) / `ReconID`(渠道流水号) / 付款账号 / 收款账号 / 付收渠道 / 金额 / 币种，in 行取收款侧、out 行取付款侧。🔴 决策 D1：大账号 `big_account` 派生阶段即按方向固化（in=收款卡号 / out=付款卡号），下游匹配引擎零方向分支。导入成功提示追加「已生成 N 条调拨对账单」（N=中台单行数×2）。
- **需求3 DBS-Charge 资金校验引擎**（🔴🔴 资金红线核心）：对账编排新增 R3.5（`runDbsChargeFundCheck`），整体替换全渠道 charge→outbound，仅 `Channel=DBS` 生效，【对称模型】：步骤1 调拨对账单（付收渠道=DBS && `big_account` 非空）↔DBS 银行行按 `big_account`+金额+币种严格 1v1（多候选取原序首行+warning），命中标 `FundTransfer-in/out`+赋 `ReconciliationId`、同 `ReconID` 其他行归 `Charge`（🔴 两阶段化：in/out 行 `ReconID` 相同，拆「阶段A 先匹配标记入保护集 → 阶段B 再归并」防覆盖）；步骤2 剩余 `FundType∈{Charge,outbound}` 候选与同 `ReconID` 网关 amount/currency 相等→outbound、未命中→`Charge`（语义翻转）。`chargeSiblingsScope` 默认 `dbs-only`；改写 `ReconciliationId`+`FundType` 标黄留痕。写死场景 `DBS-Charge资金校验`（`funcCategory='dbs-charge-fund-check'`=R3.5 分流键 / `subCategory` 同字面=seed 幂等键，区别于已退役 `'charge-outbound'`），默认 `enabled=1`，独立 marker 补种。

### 变更

- **需求2 中台调拨订单对账ID回填「数据来源二选一」**（🔴 资金红线）：新引擎 `runRound5FundTransferReconBackfill`（与原 R5s2 同口径，唯一差异对手方=调拨对账单 `reconRows`）：调拨对账单 `fund_type=FundTransfer-out/in` 行 ↔ R4 后银行同值行，命中回填调拨对账单 `ReconID` 进银行 `ReconciliationId`（标黄）；两方向独立；金额绝对值精确到分（复用 `bankAmountAbs`）；日期两阶段（同日优先消费 → 未命中 recon 用 `±dateToleranceDays` 兜底、天数差升序）；严格 1v1（`usedBankRowId`）。编排器二选一 gating：`config.reconSourceMid !== false`（默认勾选，老库缺省视为勾选）→ 勾选路注入 `fundTransferReconContext.reconRows` 走新引擎；`=== false` → 取消路沿用 `runRound5FundTransferBackfill`（网关 `gwRows` 逐字保留）。seed 默认 `reconSourceMid: true`。UI 勾选框「对账数据来源为中台调拨单表」仅 `subCategory==='fund-transfer-backfill'` 场景显示（与 Payment 行同 gating），加载口径 `reconSourceMid !== false`。
- **charge-outbound 退役（需求3 配套）**（🔴 资金红线）：R4 资金性质校验内置子场景 5→4（移除 `charge-outbound` 及 v3.0.4 块 G「仅转 Debit Amount 最大行」边界），R4 退化为纯叠加链（其余四子场景 Ach Return / Wire Return / HX-out / HX-in 零变化）；旧库孤儿 `charge-outbound` 条目由 `retireChargeOutboundOrphans` 每次启动幂等 DELETE（含级联删关联表）。

## v3.0.5（2026-06-15）

v3.0.5 迭代：三大块、约 5 个 PR 串行合入——① 体积 / DB 治理 + 启动优化（Part A 打包瘦身 + Part B Phase0~4：备份治理 + 主库一次性 VACUUM 止血 + acquiring / biz-op / bank-bu 对账 run 级数据迁 per-月侧库 + 启动窗口先行 + 守卫固化）；② 外汇交割表 + 银行入金表「整表覆盖 → 幂等累加」合并导入 + 跨期重复命中提醒（🔴🔴 资金红线）；③ 中台退款订单回填规则增强 R1~R6 + 输出模板扩列 O1~O4（🔴 资金红线）。质量门 `npm run release-check` 全绿（unit 2673 / integration 30 脚本（含 OPEN-7 跨期命中 e2e + acquiring / biz-op / bank-bu 三套侧库 parity byte-for-byte + linked-fx 合并等价性 + refund codex 修复专项）/ smoke 全模块 PASS）。⚠️ 多处资金红线：块 ② 入金表 / 外汇交割表落库由覆盖改累加 + BOC 调拨单号全量重算 + export 新增回写命中标记写路径 + 删除扩展三表（不可逆）；块 ③ R1~R6 匹配规则面扩张 + S4 容差方向收紧 + R6 DTD 美式 MDY 解析 + 模板列契约 14→31；块 ① 三模块对账 run 级数据存储位置变更 + 主库一次性 VACUUM（升级首启执行）。

### 🔴 对外契约变更（升级必读，详见 CHANGELOG v3.0.5「对外契约变更」段）

- ① 外汇交割表 / 银行对账单入金表导入「整表覆盖 → 幂等累加」（块 ②）：外汇交割表（键=交易编号）/ 入金表（键=`BizId`）由每次清空全表改为按幂等键跨次累加（同键覆盖 / 新键追加 / 空键拒入计数）；一次多选 N 文件不再只剩最后一个；不再随导入清空，只保留某批数据须改用「按日期范围删除」；导入完成框显示「覆盖 N / 拒入 N」。🔴 `BizId` 行级唯一性以覆盖计数为观测口径。
- ② 外汇交割表导入全量重算所有组（含历史组）BOC 调拨单号 + 组号每次重编号（块 ②）：累加语义下任意外汇交割表导入基于全库重算分组 / 调拨单号 / 链接ID 并重编号 1..N；中台调拨订单表两次导入间变动则历史组调拨单号随下次外汇交割表导入刷新；升级首启清空两张 BOC 派生表并引导重导外汇交割表恢复。
- ③ 「按日期范围删除」由仅网关扩展到三表（块 ②）：删除弹框加「目标表」下拉（网关 / 外汇交割表 / 入金表）；删除后联动重建派生 + 清理悬挂命中标记；不可逆，沿用网关防误删门控。
- ④ 跨期重复命中提醒（OPEN-7）+ 入金表新增 `last_hit_run` / `last_hit_at` 标记列（块 ②）：累加后历史残留入金行被对账再次命中时输出端追加「疑似历史残留」提醒（口径=所有以入金表为来源的命中：matchJpmUs + R3 / R5 / R6）；🔴 资金对账数据处理导出成功后新增回写入金表命中标记的写路径，写入失败仅 warning 不阻断产物，同批反复运行 / 导出不误报。
- ⑤ 中台退款订单回填输出模板 14→31 列 + 新增「命中类型」列 + 命中详情文案变化（块 ③）：sheet1 14→31（固定 6 + 银行 10 + 中台 15，银行侧加 `Payment Detail`），sheet2 12→13；新增「命中类型」列（精准 / 模糊）；删「匹配成功:」前缀；S4 改固定文案「命中唯一值:退款提交日期+大账号+金额+币种」——按列序 / 列名解析的外部脚本需适配。
- ⑥ 中台退款订单回填 S4 容差 10→21 天 + 改单向 + R6 原单日期按美式 MDY 解析（块 ③）：S4 由 ±10 双向改单向 `0 ≤ BillDate − valueDate ≤ 21`（银行早于退款提交日期不再命中、走报错）；R1 正则 `T54SWIC` → `T54[A-Z]{4}`（命中仍严格等值）；新增 R2 / R3 / R5 / R6 四条二跳命中路径。🔴 R6 原单日期 token（`DTD05/21/2026`）按美式 `mm/dd/yyyy`（MDY）解析，建议用真实退款单核验。
- ⑦ acquiring / biz-op / bank-bu 对账 run 级数据落 per-月侧库（存储位置变化）+ 打包瘦身 build.files 白名单（块 ①）：三模块 run 级批量数据由主库改写各模块侧库 `{userData}/run-data/{模块}/month-{YYYY-MM}.sqlite`，主库只留 run 元数据，对账算法 / 差异表 byte-for-byte 零改动；升级首启执行一次性主库 VACUUM 止血（迁移式幂等、磁盘×1.2 前置检查）。打包 `build.files` 改白名单（仅留 `docs/USER_GUIDE.md`，排除 previews / iterations / analysis / prs / scripts / CHANGELOG / README / app-icon-source）+ `@napi-rs/canvas` 移 devDependencies + `check-dist-size.js` 守卫。

### 新增

- **块 ② 外汇交割表 + 银行对账单入金表「覆盖 → 幂等累加」合并导入**（🔴🔴 资金红线）：bank-deposit 累加全仿 v3.0.1 网关先例（migration `biz_id` 列回填 + 去重 + UNIQUE，65 万行全 SQL 侧幂等可重入；`upsertLinkedBankDeposit` 数组 + 流式内存恒定双路；ADM / BOC bank 派生触发与缓存清理零改动）；fx-settlement 累加（交易编号单键，合计行非数字文本归一为空拒入）+ BOC 派生改 DB 全量重算（新增 `orig_group_no`；per-file scan + offset 续编 = 文件边界=组边界 → 全库 upsert → `orig_group_no` 聚合全局重编号 → 重跑 `matchBocToMidAllocation` 逻辑零改动 → 2.2 后 compact 展示组号连续）；跨期重复命中提醒（入金表新增 `last_hit_run` / `last_hit_at`，export 成功后三步时序回写、失败仅 warning）；删除三表化（IPC 加 `tableKey` 缺省网关、白名单三表各走日期列、删后联动重建 + 清悬挂标记）；前端导入完成框「覆盖 N / 拒入 N」+ 删除弹框「目标表」下拉。
- **块 ③ 中台退款订单回填规则增强 R1~R6 + 输出扩列 O1~O4**（🔴 资金红线）：基于 387 行真实样本（HK 196 / US 191）。R1 JPM-HK 提取正则 `T54SWIC` → `/T54[A-Z]{4}\d{6}/`（前缀 SWIC / LCIC / CCBT，仍严格等值）；R2 新层 S2b（限 JPM，payNo 二跳取入金 CustomerRef + 守卫黑名单归一 + 长度≥6 + token 边界后与 bank 附言包含匹配，独立成层防拖垮 165 主流）；R3 JPM-HK CustomerRef 二跳回落（`matchCustomerRefTwoHop` 共享）；R4 S4 单向 `0≤BillDate−valueDate≤21`（`signedDayDiff` + 三态 `classifyS4Window`，不动 `dayDiffWithin`）；R5 新层 S3b（Drawee Name + 附言 DESC DATE ↔ 入金 ValueDate sameDay）；R6 新层 S3c（附言 DTD 美式 MDY + FOR 金额含千分位 + 币种 ↔ 入金二跳，抢 S4 前）；O1 新增「命中类型」列（层属性透传）；O2 删「匹配成功:」前缀 + S4 固定文案；O3+O4 `REFUND_BANK_COLUMNS` 9→10 + 新增 `REFUND_RO_COLUMNS` 15 → 模板 14→31 / sheet2 12→13 + 启动断言；depIndex 双 Map 索引（`ordOf` 行优先一致，4 条二跳 O(n)→O(1)）。codex 资金红线复审修复 6 项（depIndex 行序 / R2 token 边界 + 黑名单归一 / R6 金额千分位 / R6 DTD 美式 MDY / R4 三态报错 / depIndex 空批早退）。

### 变更

- **块 ① 体积与启动性能优化（Part A 打包瘦身 + Part B 主库治理 + 启动窗口先行）**（🔴 资金红线 / DB 迁移 / 启动时序）：PR-1 Part A 打包瘦身（`build.files` 白名单封堵宽 glob 复发 + `@napi-rs/canvas` 移 devDependencies + `check-dist-size.js` 守卫 asar≤25MB / 禁止路径 / 必需文件反向保护 + CI 显式 step，安装包 135MB→≤90MB）；PR-2 Phase0 备份治理（保留最近 2 份 + PROTECTED 双保险）+ 主库一次性 VACUUM 止血（迁移式幂等 / 磁盘×1.2 前置检查 / VACUUM 后 `wal_checkpoint(TRUNCATE)`）；PR-3 Phase1 acquiring 三表迁 per-月侧库（新增 `run-data-store.js`，三表 DDL byte-for-byte 平移 + monthKey 正则防注入 + 孤儿扫描，`runCheckCore` git diff 空、parity 19/19）；Phase2 biz-op + bank-bu 推广侧库（防主库从其余模块复发膨胀，算法零改动 parity bank-bu 17/17 + biz-op 16/16，biz-op 月初 T-2 跨月用「月末 D 冗余副本」方案）；Phase3 启动窗口先行（`whenReady` 立即建窗 loading 态 + register*Handlers 上移，点击到可见 ≤300ms 实测建窗 ~90ms / 总 ~713ms，回退开关 `DEFERRED_WINDOW_STARTUP=0`）；Phase4 守卫固化（新增 `rules/run-scoped-data-policy.md` 对账 run 级数据禁写主库规则 + important-variables 升格侧库符号）。

## v3.0.4（2026-06-11）

v3.0.4 迭代：七块、单 PR 合入 main——① 块 A JSZip 崩点止血 + 链接表报错可见性；② 块 B 挂账 pending 导入迁移大表引擎；③ 块 C 业务OP biz-op 流水侧导入迁移引擎；④ 块 D 银行对账输出三点修复；⑤ 块 E BOC调拨订单修复；⑥ 块 F Payment线下调拨订单回填；⑦ 块 G Charge转outbound 多行行为收紧。质量门 `npm run release-check` 全绿（unit 2390 / integration 含 BOC 集成 + parity pending 45 / biz-op flow 47 + 收单回归锁 45 / smoke 全模块 PASS）。⚠️ 多处资金红线：块 B/C 入库真理源 + pending 6 表覆盖删除链；块 D F1 输出金额符号翻转；块 E 修复行生成 + bank-deposit 白名单 13→14；块 F 向 ReconciliationId 写值；块 G R4 FundType 改写语义收紧。

### 🔴 对外契约变更（升级必读，详见 CHANGELOG v3.0.4「对外契约变更」段）

- ① C3 Extra Fee 列数值符号翻转（块 D F1）：差额由写原值改为写相反数，三出口（主输出/命中明细/命中场景行报表）同步——存量 C3 场景升级后同输入产出相反符号。
- ② 错误报告与命中场景行报表目录互换 + 错误报告第 3 列「行号」→「对账ID」（块 D F2+F3）：错误报告改落 `error-reports/{date}/`、命中场景行改落 `bank-statement-process/{date}/`；按旧路径读取 / 按列名解析的外部脚本需适配。
- ③ 银行对账单表（链接表）落库字段 13→14（块 E）：新增 `Payment Detail`，存量数据需重新导入银行对账单表才支持 BOC 回填。
- ④ BOC链接表调拨单号 stale（块 E）：中台调拨订单表重导后调拨单号不自动重算，需重导外汇交割表。
- ⑤ pending / biz-op flow 导入换引擎（块 B/C）：回退开关 `USE_BIG_TABLE_IMPORT_ENGINE_PENDING` / `USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW`；多 sheet 文件由静默读第一个改为明确报错；错误超 1000 截断计数语义随引擎变化。
- ⑥ ≥2GB 单 entry 文件导入改为明确中文报错（块 A）：上限 2147483648，不再抛 JSZip 天书错误。
- ⑦ Charge转outbound 多行行为收紧（块 G）：同 ReconciliationId 多条 Charge 行由逐条全转改为仅转 Debit Amount 最大行（并列取原序首行）——存量多行场景 FundType 改写行数减少，下游 HX-out 链随之减少。

### 新增

- **块 A JSZip 崩点止血 + 报错可见性**（🟡 防御护栏）：入口尺寸预检（yauzl 读中央目录无符号 entry 尺寸，3 落点，≥2^31 弹明确中文错误，fail-open 不误伤）+ 链接表导入失败落 error 级 activity log + C3/运行前两入口消费返回值弹 per-file 失败明细。
- **块 B pending 挂账导入迁移大表引擎**（🔴🔴 资金红线）：契约模块（31 列全列 / 6 表覆盖删除链逐字平移 / 月元数据 COMMIT 前原子 / sha 去重 / 1000 上限）+ 共享 dispatch（`resourceLimits` 4096）+ 回退开关 `USE_BIG_TABLE_IMPORT_ENGINE_PENDING` + parity 45 断言（legacy vs 引擎 byte-for-byte）。
- **块 C biz-op flow 流水侧导入迁移引擎**（🔴 资金红线）：flow 契约（28 列全列 / 3 条 date 级覆盖删除 / validateFlowRow 三态）+ 回退开关 `USE_BIG_TABLE_IMPORT_ENGINE_BIZOP_FLOW`（业务OP 侧 OPEN-1 不迁）+ parity 47 断言。
- **块 E BOC调拨订单修复**（🔴 资金红线）：F1 内置写死场景「BOC调拨订单修复」（序号 2 / 默认休眠 / 独立 marker）；F2 两张隐藏链接表（外汇交割表分组 → 中台调拨匹配调拨单号 → 银行单 Channel=BOC 派生「银行单交易编号」→ 按 id 幂等回填对账ID；🔴 BANK_DEPOSIT_FIELDS 13→14；交割表强制数组路径防丢物理行号）；F3 整组匹配修复引擎 `runBocDispatchOrderFix`（D1-D11 全从严 / 整组失败不产出 / Type=2 / Reference+Amount 行级 override）。
- **块 F Payment线下调拨订单回填处理**（🔴 资金红线）：R5s2 弹窗按 subCategory 条件渲染勾选行 + 三输入框（银行渠道/地区/大账号，inline 校验不关弹窗 / placeholder 不预填 / 加载完成前禁保存）；config 浅合并保留 seed 五字段；ISO 8601 周数 + FTA 解析（四元组锁口径）；R5s2b 引擎（三条件银行池 / 周+1 日期语义 join / Q6 同日算晚于 / 差错池二轮放宽周数）；🔴 网关回填优先互斥（`usedBankRowIds` + `excludeBankRowIds` union）；mid-allocation 导入清 processingResult 防 stale。

### 变更

- **引擎扩展包 E1-E5**（块 B/C 共同前置 · PR-B）：契约可选扩展（不声明 = 引擎行为与 v3.0.3 完全一致，收单契约一字不改）——E1 多语句覆盖删除 / E2 COMMIT 前事务内收尾 / E3 空文件整批拒绝 / E4 错误上限 1000 + cells 捕获 / E5 写侧跨文件去重 Set；收单回归锁 45 + 19 断言全绿（合并门）。
- **块 D F1 C3 Extra Fee 写盘取相反数**（🔴 资金红线）：差额写入银行行 `Extra Fee` 取相反数（匹配语义不变，DS1-DS9 零改动全过）。
- **块 D F2 两类产物目录互换**：错误报告 → `error-reports/`、命中场景行 → `bank-statement-process/`（`exportRootDir` 本体未动）。
- **块 D F3 错误报告第 3 列「行号」→「对账ID」**：三级回退 reconciliationId → reconId → rowId → ''，io 层按 `_rowId` enrich 覆盖 modifiedRows + unmatchedRows 全集。
- **块 G Charge转outbound 多行取 Debit Amount 最大行**（🔴 资金红线）：R4 charge-outbound 子场景同桶多条 Charge 行仅转 Debit Amount 最大行（转分比较 / 并列取原序首行 / 单行桶不变 / 其余四子场景维持全转 / 桶级 target 初始快照预选防双网关行误转次大行）。

## v3.0.3（2026-06-10）

v3.0.3 迭代：四个块、10 个 PR，分属三个领域——① 块 A 收单单据模块导入/对账性能批次；② 块 B 资金对账数据处理模块状态框「渠道:场景序号」明细；③ 块 C USER_GUIDE 重点补缺 6 章节 + 口语化；④ 块 D 通用大表导入引擎（导入侧）抽取 + 收单首迁（W4 达成）。质量门 `npm run release-check` 全绿（unit 2179 / integration 22 脚本（1086 断言）/ smoke 全模块 PASS）。⚠️ 多处资金红线：块 A 收单导入是金额/币种入库真理源 + 对账 SQL（以同 fixture 全流程 byte-for-byte 为放行闸）；块 D 导入链路整体换引擎（四方 harness + 全链 34 断言 byte-for-byte + 单行回退开关三重放行闸）；块 B 改资金对账处理模块展示层 + hitScenarios 统计结构（带 fallback 兼容旧落库数据）。

### 新增

- **通用大表导入引擎（导入侧）+ 收单首迁**（块 D · 🔴 资金红线 · PR-G1/G2/H）：把收单 yauzl + 手写字节扫描解析、rels 正解 sheet 定位、prepared INSERT 管道、大事务/整批拒绝/peek 预检/覆盖导入/checkpoint 等机械部分抽成带契约参数的共享库（`src/backend/big-table-import/`），收单作为首个迁移用户。PR-G1 引擎核心：zip-reader rels 正解定位唯一 sheet（多 sheet 显式报错）+ 🔴 row-scanner 单遍字节状态机（Buffer 扫 `<row` + 白名单 ref 串直接定位 + 仅取值局部解码）+ contract 三层防护，50w 解析段 4.26s vs P1b 9.87s = 2.32x、四方 harness（sax≡手写全列≡P1b≡引擎）全等。PR-G2 管道 + worker 化：多文件并行解析 → 按文件序单写 INSERT（rowid 序=串行 byte-for-byte）、4-worker 3.06x、cancel<5s、PRAGMA 第 5 处契约、内存闸。PR-H 收单迁移接线：契约模块 contract-flow（白名单 `{0,6,28,29}`）/contract-bill（全列）、session dispatch 引擎 worker（接口对 `main.js` 不变）、🔴 单行回退开关 `USE_BIG_TABLE_IMPORT_ENGINE`、新旧全链对比集成脚本 34 断言（六场景逐行含 rowid + 报错逐字符 byte-for-byte）、50w 端到端 11.2s→7.3s（1.53x）、导入全程主进程零阻塞（W4 达成）。
- **资金对账数据处理模块状态框「渠道:场景序号」明细**（块 B · 🟡 展示层 + hitScenarios 统计结构 · PR-E）：状态框原 `场景 1、3` 在多渠道下有歧义。hitScenarios 增加 `channelId`/`channelName`（双维派发路径），去重键改 `` `${channelId}:${scenario.id}` ``（场景×渠道多对多不再吞并，`scenarioHitCount` 原语义不变）；状态框汇总行括号内按渠道分组换行（`已处理：45 行命中（场景\nJPM:1、3\nCITI:2），3 警告`），旧数据无 `channelName` 回退旧格式；🔴 legacy 单维路径结构不变（21+ 测试 0 regression）；防爆框护栏 `#bankStatementStatusBox` 加 `max-height: 140px` + 滚动，preview 已回归。
- **USER_GUIDE 重点补缺 6 章节 + 口语化**（块 C · 🟢 纯文档 · PR-F）：新增「数据备份与恢复 / 设置参数指南 / 错误排查与日志 / 链接表管理详解 / 场景管理通用指南 / Windows 性能建议」6 章；§1.4 术语段口语化改写（保留 ⭐/🔴 标记惯例）。

### 变更

- **收单单据模块导入/对账性能批次**（块 A · 🔴 资金红线 · PR-A~D + PR-P1）：PR-A flow 表 `raw_json` 永久停写（O-1 决议，列保留恒写 `''`、无 migration、存量行不动）+ bill 模板键列下标预计算 → 50w 行 flow 导入段实测 6.36x。PR-B 收单索引瘦身 v2 迁移（DROP 4 冗余索引 + 建 2 covering 索引）→ 对账统计段实测 5.2x（3 次 JOIN 合 1 + COALESCE 空集守卫）。PR-C PRAGMA 契约补齐 `temp_store=MEMORY`（两处 worker）+ 收单导入 COMMIT 后 `wal_checkpoint(TRUNCATE)`（Windows 写放大 W2）+ 对账多 worker 启用阈值 30w 行（O-2 决议直接合入）。PR-D Windows OneDrive 存储检测提示（一次性提醒，W5/O-3 决议：检测提示 + 文档）。PR-P1 解析列白名单裁剪 + 直接定位（flow 4/48 列），解析段 1.20x 收口（O-5 五次修订：实测天花板 ~1.4x，性能债务转引擎 PR-G 字节层）。

## v3.0.2（2026-06-10）

v3.0.2 迭代：3 项需求分属三个模块——① 业务OP数据核对「导入流水表」批量多选导入 + 回滚 v3.0.1 左列右移；② 「对账单 ReconID 修复」改名「对账单修复」（纯 UI 文案）；③ 网关对账单修复场景配置新增「修复订单字段取值」+「修复订单ID取值」启用开关（含用户修订：字段取值限定「网关1v1渠道」模式 + 两功能 row 改垂直布局）。质量门 `npm run release-check` 全绿（unit 2085 / integration 19 脚本（1011 断言）/ smoke 全过）。⚠️ 两处资金红线：需求1b 流水批量导入单事务合并、单次 clearByDate；需求3 字段取值赋值不污染原始行 + 分组 seq 全程 Number + idEnabled=false 保留原值。

### 新增

- **业务OP数据核对「导入流水表」批量多选导入**（需求1b · 🔴 资金红线）：「导入流水表」从单文件改为「先选日期 → 一次多选多个流水表 → 合并入库到该日期」（多文件 = 该日期完整流水快照，与「重导替换该日期」一致）。🔴 worker / 同步 fallback 两条路径均**单进程单事务合并、单次 `clearByDate`**（首个数据行触发只清一次、各文件累加 INSERT，绝不循环调用 `runFlowImport` 致互相覆盖丢数据）；任一文件任一行校验失败整批拒绝（全 ROLLBACK，聚合错误报告标注来源文件名）；单文件行为零回归；完成框报「导入 N 个文件共 M 行」+「会替换该日期已有流水」。IPC `pickFlowFile`/`runFlowImport` 改 `filePaths`（数组）；业务OP 文件（`kind='bizOp'`）不在范围、不动。
- **网关对账单修复「修复订单字段取值」**（需求3 · 🔴 资金红线）：网关子模式新增/修改场景对话框新增「修复订单字段取值」（独立开关 `config.fieldValue.enabled`，默认关，可与「修复订单ID取值」同时启用）。多行规则 = 主分组 + 网关字段「取」从分组 + 渠道字段；对账匹配成功后把从边渠道字段值赋给主边网关字段，叠加进订单修复导出（14 列 `ORDER_REPAIR_FIELDS_GATEWAY` 模板，目标列落 14 列内才体现）。🔴 helper `applyFieldValueOverrides` 只写新建 overrides 不污染 `mainRow`/`oppRow`；分组 seq 全程 Number（`Set<Number>.has` 误存字符串会静默失效，UI 归一 + 引擎 `Number()` + 校验三道防线）。config_json 自由 JSON 承载，无需 DB migration、不 bump bundleVersion（旧场景缺省零回归）。**（用户修订）限定「网关1v1渠道」模式**：勾选 1v多 / 多v1 时字段取值不可用（UI 开关自动禁用 + 灰显 + 「仅"网关1v1渠道"模式可用」提示 + 自动取消启用；校验拦截；引擎入口 gate 强制 `fieldValue.enabled=false`，`apply1vN`/`applyNv1` 不做字段取值，双重防御）。**（用户修订）UI 垂直布局**：两个 gateway row 改垂直布局——标题行（label + tooltip + 启用开关）在上、内容（radio / 规则行）在下。

### 变更

- **「对账单 ReconID 修复」改名「对账单修复」**（需求2 · 🟢 纯前端文案）：模块显示名 +「单据对账修复」「网关对账单修复」两个场景类别 label 去「ReconID」字样；内部 id（`recon-id-fix`/`gateway-recon-id-fix`）/ IPC 模块标识 / usage-stats 统计 key（`FUNCTION_REGISTRY` `'对账单 ReconID 修复'` 与 `trackedIpcHandle` 第二参 3 处配对）/ scenario category / DB schema CHECK 全部不动（沿用 v2.1.14 先例，零风险、统计连续）。
- **网关「订单修复ID取值」改名「修复订单ID取值」+ 启用开关**（需求3 · 🔴 资金红线）：原「订单修复ID取值」行改名 +「启用该功能」开关（`config.output.idEnabled`，默认启用=保持现有必填）；取消勾选跳过 Reference 赋值与校验、三选一 radio + commonId 灰显，导出保留网关账单原 Reference 值（不把 Reference 放进 overrides → `buildOutputRow` 取 srcRow 原值，比清空安全）。

### 移除

- **业务OP数据核对左列「整体右移」回滚**（需求1a · 🟢 纯 UI）：删除 v3.0.1 需求2 给该模块左列加的 `#bizOpReconModulePanel .cell.left > * { transform: translateX(85.5px) }` 平移规则，左列两元素回到平移前位置；保留同段其它 v3.0.1 样式（`.gateway-recon-picker-card`/`.linked-table-delete-range-card`）不动。

## v3.0.1（2026-06-09）

v3.0.1 迭代：资金对账数据处理模块 1 项资金红线增强（需求1）+ 3 项 UI 修复（需求2/3/4）。质量门 `npm run release-check` 全绿（unit 2075 / integration 19 脚本 / smoke 全过）。本迭代与另一资金对账工作流（需求5「R5-2 覆盖非空原值告警移除」）并行落地，需求5 由该线定稿（见 PRD §十一/§十二）。

### 新增

- **网关对账单链接表批量导入 + 跨次幂等累加**（需求1 · 🔴 资金红线）：网关对账单落库从「整表覆盖」改为按幂等键 `ReconBillBizId` 跨次累加（一次多选多个文件不再互相覆盖丢数据）。含 schema 迁移（`recon_bill_biz_id` 列 + UNIQUE 索引 + 存量空键/重复键清洗）、网关专用 `upsertLinkedGatewayBill`（数组 + 流式，单事务全 ROLLBACK 红线保留）、导入完成框「覆盖 N / 拒入 M」提醒、链接表管理新增《删除》按钮（按数据日期范围闭区间删除，直接删、无二次确认，后台计数门控防误删；红色警告框经用户 UI 迭代去掉）。⚠️ 已知限制：对账维持读全表，累加多期 + reconid 跨期复用的 R1/R5 漏匹配作为已知限制被接受（PRD §十 Q7=A）。

### 变更

- **ADM 派生提醒仅在派生出数据时弹**（需求4）：导入不含 `Channel='ADM'` 行的银行对账单表时不再误弹「ADM银行对账单链接表已创建」（`buildAdmDeriveHtml` 加 `total` 守卫，后端不动）。
- **业务OP数据核对左列右移**（需求2 · 纯 UI）：BU 下拉 + 导出差异按钮整体右移 D/2+12=85.5px（专属 `#bizOpReconModulePanel` 选择器，右列与另 3 个 `.pending-board` 模块不受影响）。

### 修复

- **网关对账单修复「场景选择弹框」样式错乱**（需求3 · 纯 UI）：对齐窄弹框范式，专属 `gateway-recon-picker-card` class + CSS（标题 16px、加内边距），逻辑零改。

## v3.0.0（2026-06-09）

v2.1.16-beta.6 转正 v3.0.0。四大块 7 项需求：块 A 资金对账模块弹框/状态框治理、块 B 链接表大文件流式导入、块 C R5 场景3 Credit/Debit 方向匹配、块 D 场景管理批量 CSS 偏移修复。质量门 `npm run release-check` 全绿（unit 2061 / integration 18 脚本 / smoke 全过）。

### 新增

- **链接表大文件流式导入**（块 B · 🔴🔴 资金+数据红线）：65.7 万行 / 147MB 渠道账单原报"文件为空或不可读"（SheetJS 全量读 OOM），改用流式引擎 `readXlsxStreamed` 全链路改造——detector 表头识别流式化（+ `readXlsxSheetMetaLite` 替代 listSheetNames 的 ~3.9GB OOM）、落库 `replaceLinkedTableStreaming`（单事务整表覆盖逐行喂入）、ADM 派生 `readBankDepositAdmCandidates`（Channel=ADM SQL 下推过滤，消 ~1.2GB 读回尖峰）。实测落库 657,757 行、内存有界不 OOM、值口径与现状逐格一致。
- **状态框「渠道-地区」前缀**（块 A 需求 1）：导入银行对账单后状态框文件名前加 `渠道-地区` 前缀（唯一 `CITI-HK:文件名` / 多组合全列出）。

### 变更

- **去导入明细确认框**（块 A 需求 2a）：删与状态框重合的明细框，失败/跳过信息并入常驻状态框。
- **C3 提醒改向链接表网关对账单**（块 A 需求 2b · 🔴 防静默漏对账）：C3「数据就绪判据」从 `gatewayReconSession` 改向链接表 `gateway-bill` 行数（严格 >0）+「导入文件」改调链接表导入。
- **退款回填提醒对齐 C3**（块 A 需求 3）：导入/运行点提醒统一 C3 框结构 + 候选预检（无 `Ach Return` 不提醒）+ 运行点链式编排。
- **R5 场景3 Credit/Debit 方向匹配**（块 C · 🔴 防剔除清单错位）：同 ReconciliationId 多候选改取 `Credit Amount` 有值行；0 或 ≥2 行跳过 + 警告不阻断。

### 修复

- **场景管理批量勾选列表格偏移**（块 D · 纯前端）：勾选列百分比化 + 其余列按比例补偿（总和=100%）+ 清重复 CSS。
- **链接表/预加工导入 read-error 误报文案**（块 B / O-6）：区分真空文件 / 不可读 / OOM-读失败。

## 2.1.16-beta.3（2026-06-07）

v2.1.16「资金对账数据处理」**阶段三·中台退款回填前置基础设施 + 引擎设计**。交付 ①Channel 枚举沉淀、②银行对账单入金表链接库两块可用功能 + ③中台退款订单回填引擎设计文档（仅设计不实现）。①② 是 ③ 的前置依赖。质量门 `npm run release-check` 全绿（unit 1768 / integration 952 / smoke 全过）+ team-lead 端到端自测 21/21 + 用户手测入金表导入通过。

### 新增

- 银行对账单入金表链接库（②· 🔴 数据红线）：「链接表管理」新增第 5 个表库「银行对账单入金表」，模板取 `银行对账单.xlsx`，存 C~N+FundType 共 13 字段（`linked_bank_deposit`，整表覆盖）；复用现有「导入」按钮，新增 `BANK_DEPOSIT_SIGNATURE` 仅进 `LINKED_IMPORT_SIGNATURES`、`ALL_TABLE_SIGNATURES` 不含它（与主表同构 44 列隔离防 ambiguous）；导入按 13 字段名裁列（裁列在 44 列校验后 + 加载期 assert ⊆ `BANK_STATEMENT_FIELDS`）
- Channel 枚举沉淀（①）：导入银行对账单后去重沉淀 `Channel` / `<Channel>-<地区>` 两类值（`channel_enum_values`，UNIQUE 去重 + seen_count 累加），供后续 ③ JPM 分支 + 审计，纯沉淀无 UI；地区空只落 channel 不生成脏值、Channel 空跳过、沉淀失败 `appendActivityLogEntry` warning 不阻断导入
- ③ 中台退款订单回填引擎设计文档（仅设计）：4 基数×4 策略决策矩阵 + JPM-HK/US 双分支 + 数据筛选/统一回填/命中详情/双 sheet 导出，集成 = R5 场景4，12 条歧义经用户确认；本版不实现代码，作后续实现蓝本

> 阶段三·beta.3 收口：①② 前置基础设施落地测通过，③ 引擎完成详细设计待实现。

## 2.1.16-beta.2（2026-06-07）

v2.1.16「资金对账数据处理」能力扩建的**阶段二·5 轮对账核心引擎**（beta.1 地基层已随 PR#61 合并 main）。在「资金对账数据处理」预加工流程里对银行对账单跑 **5 轮对账**（R1 对账ID 1v1 匹配 → R2 复用现有 first-match-wins dispatcher → R3 占位透传 → R4 资金性质校验 → R5 中台订单数据处理），产出改写后银行对账单 + 中台加款单剔除文件；网关数据从链接表 `linked_gateway_bill` 读回。⚠️ 多处资金红线（R4 改 `FundType`、R5 场景2 回填 `ReconciliationId`、R5 场景3 剔除行、FundType 枚举改错拼）。质量门 `npm run release-check` 全绿（unit 1731 / integration 952 / smoke 全过）。⚠️ 本版用户仅手测「场景管理列表 UI」，5 轮端到端 + Q1 网关 TradeType 真实取值核对等留待下版一起测（清单见 `changes/v2.1.16-beta.2/TASKS.md`）。

### 新增

- 5 轮对账编排器（🔴 资金红线 · `reconciliation-orchestrator.js`）：`runReconciliation` 串联 R1→R2→R3→R4→R5，按 `funcCategory`/`subCategory` 分桶内置场景，跨 5 轮累积标黄列；返回 `{modifiedRows,unmatchedRows,modifications,errorReport,stats,platformCleanupRows,rounds}`，行数守恒 `modifiedRows+unmatchedRows=bankRows`；不改 `scenario-dispatcher.js`（R2 仍复用其 first-match-wins）
- R1 对账ID匹配引擎（`r1-recon-id-match.js`）：`reconciliationid===ReconciliationId` 大小写敏感 1v1 匹配，产 `matchedGwRows`/`pairs`；不改字段、不产 modification、不标黄
- R4 资金性质校验引擎（🔴 资金红线 · `r4-fund-nature-check.js`）：「R1 匹配网关行 × R3 全量银行行」按 reconid 关联，5 可插拔 handler 按 priority 改 `FundType`（Ach Return / Wire Return / Charge→outbound / HX-out / HX-in，判定条件 config 化复用 `evaluateCondition`）；**唯一允许同一行多次改 FundType** 的轮次（叠加链），改写行标黄不进 N5 报表；⚠️ 网关 TradeType 真实取值 / priority 顺序待用户核对、已 config 化可调
- R5 场景2「中台调拨订单对账ID回填」（🔴 资金红线 · `r5-fund-transfer-backfill.js`）：网关 `FundTransfer-out/in` ↔ R4 后银行同 `FundType` 回填 `ReconciliationId`（两方向独立）；`merchantid/currency` + **发生额绝对值 `|Credit−Debit|` vs `|amount|` 精确到分** + 日期两阶段（同日 → ±1day）；严格 1v1、覆盖发 warn 仍写、tie-break 同日优先；复用 `normalizeDateExportValue`（新建 `engine-date-utils.js`）
- R5 场景3「中台加款单脏数据处理」（🔴 资金红线 · `r5-platform-inbound-cleanup.js` + `constants/platform-cleanup-template-fields.js`）：网关 `Inbound-VA` ↔ R4 后银行行按 reconid 1v1 命中、`FundType!='Inbound'` 时生成剔除行（加款单号=网关 `orderid`、附言=`<R4 后 FundType>，中台加款单已关闭。`、C~O 13 列拷贝银行行）；15 列模板单一真相 + C~O ⊆ `BANK_STATEMENT_FIELDS` 守卫
- 中台加款单剔除文件导出（🔴 资金红线 · `platform-cleanup-writer.js` + `bank-statement-io.js`）：启用场景3 有剔除行 → 与银行对账单同目录输出 `中台加款单剔除模板-YYYY_MM_DD_HHMM.xlsx`（主输出为空落 `exportRootDir`）；writer 仿 `scenario-hit-rows-writer.js`（15 列加粗 + watermark）；graceful 失败不阻塞主流程；无剔除行不生成
- 网关数据源 `readLinkedTableRows`（`linked-table-repository.js` + `database.js` facade）：从链接表读回整行（解析 `raw_json` 还原真实表头、`ORDER BY id ASC`、损坏行跳过），编排器网关行从 `structuredClone(database.readLinkedTableRows('gateway-bill'))` 取——R2/C3 网关源由 `gatewayReconSession` 切链接表；`fx-option` 返空
- 5 轮对账内置场景 seed migration（`migrations.js` + `database.js`）：`ensureReconRoundBuiltinScenariosSeed` 插 5 R4 + 2 R5 内置 `builtin-fixed` 场景（config 带 `funcCategory`/`subCategory`/`roundPhase`/`priority`/`involvedFiles`），幂等定位键 `config_json LIKE '%"subCategory":"X"%'` 已存在跳过不覆盖；排在 `ensureScenariosCategoryBuiltinFixed` 之后

### 变更

- 场景管理列表「功能类别」按业务分组显示（前端 · `renderer-dialogs.js`）：builtin-fixed 列表「功能类别」列按 `config.funcCategory` 映射——`fund-nature-check`→「资金性质校验」、`platform-order`→「中台订单数据处理」（旧称「中台订单校验」更名）；无 `funcCategory` 的既有场景回退既有标签（`'银行对账单赋值自身'`）不回归；实际展示列保持 6 列（序号 / 功能类别 / 场景名称 / 优先级 / 执行操作 / 是否启动）
- FundType 枚举补值 + 修错拼（🔴 资金红线 · `assets/FundType枚举值.xlsx` + 一次性 migration）：补 `Ach Return` / `HX-in` / `HX-out`（R4 子场景改写目标值）；修错拼 `Ach Ruturn → Ach Return`（一次性 migration 迁移存量 config 旧值，引用面低风险）；`InternelFundTransfer → Internal` 本版不改；`loadFundTypeEnum` 读出新值、存量 config 不破坏

> 阶段二·beta.2 收口：5 轮对账核心引擎 + R4 资金性质校验 + R5 中台订单数据处理 + 中台加款单剔除导出。⚠️ 本版未做端到端手测（用户 2026-06-07 拍板仅测场景管理 UI，其余下版一起测，清单见 `changes/v2.1.16-beta.2/TASKS.md`）。

## 2.1.16-beta.1（2026-06-07）

v2.1.15 之后「资金对账数据处理」能力扩建的**阶段一·地基层**（表头自动识别 + 链接表持久化 + 批量导入合并对账 + 自带写死场景优先级）。仅落地基与数据通路，资金性质校验 + 5 轮对账引擎 + 网关 reader 留待阶段二。⚠️ 批量导入「多银行对账单合并对账」涉及对账数据集合并（资金红线）。

### 新增

- 「导入对账单」改多选批量导入（🔴 资金红线）：一次多选 Excel，逐文件按表头自动识别表类型并路由（银行对账单读行；中台退款订单 / 入账原始订单本阶段开关默认关跳过；歧义 / 未识别 / 读取失败逐条记明细，不整批回滚）。**多份银行对账单 = 合并对账（不覆盖）**：第一个建 session、后续校验表头完全一致才追加，合并后统一重编号 `_rowId`（跨文件全局唯一）保证行锁不串行
- 链接表管理导入持久化：「链接表管理」导入由 v2.1.14 占位改为真正落库——网关对账单 / 中台调拨订单 / 外汇交割表 3 表库整表覆盖写入（键列 + 日期范围列 + 整行 raw_json）+ 元数据（数据日期范围 / 行数 / 来源 / 更新日期）；外汇期权表本阶段占位（模板缺失，导入拒绝）
- 自带写死场景「管理」弹窗加优先级输入框：原优先级固定 0，现可调该内置场景在 dispatcher 执行顺序中的优先级
- 表头自动识别地基：以特征表头列为签名识别表类型（唯一命中 / 歧义 / 未识别 / 读取失败四态），按 scope 分预处理表 / 链接表两候选子集

### 变更

- 链接表「中台调拨订单」数据日期范围用「交易时间」（每行均有值），不用「业务日期」（空值率高）；DB 列名建表即对齐 `transaction_date`（链接表 v2.1.16 全新引入、无存量、零迁移）

> 阶段二待续：资金性质校验 + 5 轮对账引擎 + 网关 reader + 外汇期权表模板与表库。

## 2.1.15（2026-06-07）

v2.1.14 之后 1 轮迭代，5 个工作项（性能 + 网关对账单赋值增强 + 入口整合 + 主题精简）。⚠️ ①②③ 资金红线；② 为破坏性变更。

### 新增

- 网关账单字段运行时读 xlsx 表头（🔴 资金红线 + **破坏性**）：C3「网关对账单赋值银行对账单」的「网关账单字段」下拉枚举改读 `assets/网关对账单.xlsx` 表头（新增 `gateway-recon-headers-loader.js` + IPC，复用 C2 FundType 模式）；缺失降级旧硬编码、剔除 `__CUSTOM__`。**破坏性**：新表头与旧硬编码几乎全不一致，存量 C3 场景引用旧字段名需重配
- C3 差额写入 `Extra Fee` + 标黄（🔴 资金红线）：勾选「金额不一致」匹配成功后，差额写入银行行 `Extra Fee` 并标黄；原值=差额则只锁定不标黄；assign 与 Extra Fee 写盘解耦、1v1 红线不变
- 「网关对账单修复」入口：「资金对账数据处理」模块「场景管理」弹窗内新增入口，打开 ReconID 修复模块的网关场景管理（复用 `createScenariosManagerDialog(['gateway-recon-id-fix'])`），仅资金对账入口显示

### 变更

- 收单「写差异文件」提速（🔴 资金红线 · 输出不变）：`writeDiffWorkbook` 由 LIMIT/OFFSET 深分页改为游标遍历（新增 `iterateDiffRowsByDateRange`），消除整月单 segment 的 O(N²)；50 万差异行实测 ~61.6s→5.2s（≈11.9x），新旧 xlsx 逐行逐列对拍一致

### 移除

- 调色盘「切换页面风格」+ 弃用 General 风格：删调色盘风格切换 UI + General 链路；老库 `ui_style='General'` 启动迁移 Clear；`src/styles.css` 文件保留不删

## 2.1.14（2026-06-07）

v2.1.13 之后 1 轮**纯前端迭代**（不涉及后端）：① 应用主标题「网银账单小助手」→「清结算小助手」（含启动失败弹窗 / 安装包 `productName`）；② 模块「银行对账单处理」→「资金对账数据处理」（仅显示名，`module.id` 不变）；③ 该模块面板改 control-row 三行布局 + 新增「导入不平表」按钮（复用现有不平结果表导入）与「链接表管理」入口；④ 新增「链接表管理」弹窗（4 表库骨架，UI 占位）；⑤ 场景配置弹窗微调（C2「自己输入」/ C2·C3 标题不加粗 / C2 赋值下拉缩窄 / 去 # 序号）；⑥ assets 模板入库。纯前端、无业务逻辑变更。

### 新增

- 链接表管理弹窗（UI 骨架）：「资金对账数据处理」面板新增入口，列 4 张链接表库（网关对账单 / 中台调拨订单表库 / 外汇期权表库 / 外汇交割表库），导入占位不持久化
- 导入不平表按钮（复用现有 `importGatewayRecon` IPC）：面板主动入口导入「资金对账不平结果表」
- 场景配置 C2「自己输入」：「银行对账单赋值自身」赋值 FundType 值下拉加「自己输入」→ 切文本输入框（可填枚举外的值）
- assets 模板入库：中台加款单剔除模板 / 中台调拨订单 / 中台退款订单 / 中台退款订单回填模板 / 入账原始订单 / 外汇交割表vPayment / 网关对账单

### 变更

- 应用改名：标题 / 启动失败弹窗 / `package.json` description + `build.productName`「网银账单小助手」→「清结算小助手」（`appId` 不变）
- 模块改名：「银行对账单处理」→「资金对账数据处理」（仅 `name`，`module.id='bank-statement-process'` 及引用 / DB schema / 统计 key 不变）
- 资金对账数据处理面板重构：control-row 三行（左两组导入/导出 + 状态框，右三按钮「开始运行 / 场景管理 / 链接表管理」）；左侧每组按钮往两侧张开各 14px
- 场景配置弹窗微调（C2/C3）：标题「— 类别名」后缀不加粗；C2 赋值两下拉缩窄 160px（C3 保持原宽）；去账单类型 #x.x + 对账字段 #x 序号

### 工具

- 修复 `check-vars` skill 的 `src/**/*.js` pathspec glob 坑（漏 src/ 顶层文件），改为 `-- src/` 筛 `.js`

## 2.1.13（2026-06-06）

v2.1.12 之后 1 轮迭代，围绕「银行对账单处理 / 对账单 ReconID 修复」两个场景模块的场景管理体验重构 + 跨渠道写死场景 + Win 端字体可读性：① 新增「自带写死场景」(builtin-fixed) 内置类别（前端无新建入口、仅「通用」渠道可见、序号固定 / 优先级 0 / 执行操作仅「管理」，原内置「从银行对账单的信息里提取调拨订单对账ID」归入此类，可通过「管理」弹窗多选「适用银行渠道」**跨渠道生效**，默认全选 = 全渠道）；② 新增「复制场景」（配置弹窗右上角从同类别其他场景复制配置，覆盖 config、不覆盖名称）；③ 银行对账单处理模块面板沿中线左右镜像；④ 一批文本改名；⑤ Win 端（仅 Windows + 默认 Clear 主题）页面文本英文/数字改 Courier New、中文改 Noto Sans SC（思源黑体随应用打包），大标题保留原字体，macOS 不受影响。⚠️ 资金/对账红线护栏：builtin-fixed 路由复用原 C1 提取逻辑、提取结果 byte-for-byte 不变；DB 新增 category 枚举 + 多对多关联表均为幂等迁移、老库不破坏。

### 新增

- **自带写死场景（builtin-fixed）类别**（业务规则 · UI · 引擎 · DB / `category=builtin-fixed`）：新增内置场景类别，前端无展示入口（不出现在「新建类别」下拉），仅在「银行对账单处理」模块的「通用」渠道可见，序号固定（置顶）、优先级 0、执行操作列仅「管理」按钮（无转移/删除）、保留启用勾选；原内置「从银行对账单的信息里提取调拨订单对账ID」由 `extract-recon-id` 归入此类；执行引擎 `runScenario` 新增 `builtin-fixed` 路由（按 config 形态复用原 C1 `extractByFeature` 提取逻辑，提取结果不变）
- **场景适用银行渠道（多对多）**（业务规则 · UI · 引擎 · DB / `scenario_applicable_channels` 关联表）：自带写死场景可通过「管理」弹窗多选「适用银行渠道」——默认全选 = 对全部渠道生效（无任何关联行 = 适用全部）；运行某渠道时，适用列表含该渠道、或为空，则该写死场景纳入执行（跨渠道生效）；dispatcher 在通用阶段按「行 matchedChannel 是否在适用列表内」逐行过滤候选行，保持 priority 0 兜底语义不变、只缩小候选行集
- **复制场景**（UI · 配置复用）：新增/修改场景的 C1–C4 配置弹窗右上角新增「复制场景 / 选择」入口，可从同类别其他场景复制配置——覆盖 config，不覆盖场景名称；「银行对账单处理」按「银行渠道 + 场景」两级下拉选择来源，「对账单 ReconID 修复」按「场景」单选

### 变更

- 银行对账单处理模块主面板沿中线左右镜像布局（与 v2.1.12 VCC 模块面板镜像同款手法）
- 对账单 ReconID 修复模块场景管理去掉「银行渠道」下拉与「管理」（按 category 隔离、不引入渠道维度），复制场景按「场景」单选
- 文本改名（UI 文案，DB category / 统计 key 均不变）：功能类别「提取ReconId-From 网关」→「网关对账单赋值银行对账单」（`gateway-recon-join`）；功能类别「银行对账单字段赋值」→「银行对账单赋值自身」（`offset-bill-mark`）；模块「月度 Pending 数据核对」→「月度Pending数据核对」（去空格）
- Windows 端字体（仅 Windows + 默认 Clear 主题）：所有页面文本英文/数字改 Courier New 等宽、中文改 Noto Sans SC（思源黑体随应用打包，字体定义见 `src/fonts.css` 本地子集），大标题保留原比例字体；机制为字符级 fallback；macOS 不受影响
- C3「网关对账单赋值银行对账单」配置弹窗微调：金额不一致勾选项文本加粗；勾选后右侧显示说明文本「输入框的差额用于网关账单与银行对账单的金额比对」，原「网关对账单金额 + 输入框 = 银行对账单金额」公式行下移
- 多项弹窗 UI 微调：复制场景弹窗 / 适用渠道弹窗 / 类别选择下拉的宽度、居中、按钮间距等
- 数据/技术：DB 新增 `scenarios.category` 枚举值 `builtin-fixed`（重建 CHECK 约束 5→6 值，幂等）+ 原内置提取场景迁移成 `builtin-fixed` / priority 0 / channel_id=1（config 不变）；新增 `scenario_applicable_channels` 多对多表（scenario_id × channel_id，幂等，缺表兜底全渠道生效）

### 移除

- 移除「提取ReconId-From Self」（`extract-recon-id`）新建类别选项：原场景已归入自带写死场景，新建场景的「类别」下拉不再列出该项

## 2.1.12（2026-06-01）

v2.1.12 α（PR #56）之后的 β 性能架构阶段，三块互相独立的大文件/大计算量提速，全部 🔴 资金红线 byte-for-byte 守恒：β.1 收单对账 multi-worker（大数据量 JOIN 对账并行）+ β.2 bizOp（业务OP数据核对）导入流式 + worker 化（百万行 xlsx 导入不 OOM）+ 收单导入解析器 sax→手写字节扫描（收单单据币种校验导入提速）。⚠️ 3 个🔴资金红线（三块各一）：① β.1 diff_rows 多 worker 与单 worker byte-for-byte 一致 ② β.2 worker 内五条资金红线（整批拒绝 / D+1 原子替换 / bu_name 改写 / 失败报告 / flow 跨 BU 清）全保住 ③ 收单导入新旧 reader 全行 SHA1 完全一致。质量门：`npm run release-check` 全绿（unit 1473 / integration 952 / smoke 全过）；三块均合成数据 byte-for-byte 已充分验证，真实大文件由用户手测把关（合并门槛硬要求）。提 PR 后经 self-review + reviewer 评论修复 5 问题（β.1 资金 C1/C2 + β.2 I1/I2/I3 + MW cancelToken），均补回归测试。

### 新增

- **β.1 收单对账 multi-worker write-splitting**（🔴资金红线）：`acquiringBillCurrency` 对账 stage 4'（`INSERT INTO diff_rows SELECT … JOIN …`）500万行单 worker 慢，多 worker 并行直跑撞 SQLite WAL single-writer → SQLITE_BUSY。方案 plan-b（POC 拍板）= 主进程按 OFFSET/LIMIT 拆 N chunk → M worker 并行 `SELECT JOIN`（只读 WAL 并发不冲突）→ 各 worker 写自己的 temp db → 主进程按 chunkIndex 升序 ATTACH 汇总 INSERT（顺序不变量）；50万行实测 **2.3–2.7x**（M=4，前提 chunk 数 >> worker 数）；决策 D29（默认 worker 2 / 上限 4 / `cpus-2`）/D30(plan-b)/D31(**<100万行或 chunk<worker→回退单 worker**)/D32(每模块独立 pool)/D33(默认 2、`freemem<2GB`→1)/D34(流式进度)/D-β-1(resume→单 worker)；自适应分片目标 chunk ≈ 4×worker（下界 2000）；新增 settings `acquiring_bill_worker_count`（默认 2 / 范围 1-8 / 幂等 migration）；🔴 diff_rows 多 worker 与单 worker byte-for-byte 一致、失败仅清本 run diff 不留半套数据（contract 20 例 + 嵌套 worker 拓扑集成测试）；合并门槛 = 500万真实数据手测
- **β.2 bizOpRecon（业务OP数据核对）导入流式 + worker 化**（🔴资金红线）：SheetJS `XLSX.readFile` 全量进内存，百万行 xlsx 撞 V8 512MB 静默返回空；新增流式 reader `reader-streamed.js`（JSZip + SAX 扫 `<row>`，复用 `streaming-xlsx-reader`，镜像 SheetJS 语义 / 真实行号 / 表头校验）+ 导入移入 child-process worker `import-worker.js`（`utilityProcess.fork` / Node `spawn` fallback，边流式读边分批 INSERT 不堆数组）；IPC 改调 worker（传 dbPath 与 acquiring worker 同库 WAL 并发，`onProgress` 透传 renderer），无 dbPath 回退旧同步；🔴 worker 内五条资金红线（整批拒绝 ROLLBACK / (date,BU)+D+1 替换原子事务 / `bu_name` 改写 / 失败报告 xlsx worker emit→主进程写 / flow 跨 BU 清）；reader contract 11 + worker contract 10；合并门槛 = 真实大文件手测
- **收单导入解析器 sax→手写字节扫描**（🔴资金红线）：profile POC 定位收单导入 50万行 122s、解析占 ~90%（非 insert/raw_json）；POC 实测纯解析 sax→手写 8.7x(50万)/9.1x(100万)，JSZip 在 100万行（~3.8GB 解压）崩 yauzl OK → 最优架构 = yauzl(保留)+手写扫描、**不引入 JSZip**；新建 `reader-handrolled.js`，`reader.js` 纯追加导出 helper 作基线 + 一行回滚，生产路径 `acquiring-bill-currency-session.js:16` 单行 require 切换；🔴🔴 数字 cell 取 `<v>` 原文本逐字对齐 sax（**绝不 parseFloat** 否则 `"1000.00"`→`"1000"` 改金额，改写专用 `parseAcquiringRowXml` 不复用含 parseFloat 的 `parseRowXml`）；**实测端到端 5.6x（122s→22s/50万，500万外推 ~20min→~3.8min）**、内存更低；🔴 双层资金闸 = contract 18 例（sharedStrings / number cell / 稀疏行 / 中文实体 / 表头错 / peek）+ 真实规模 scalediff（50万/100万行全行 SHA1 + importedCount + monthKey 完全一致）

### 变更

- 收单导入默认解析器由 sax 切到手写字节扫描（`acquiring-bill-currency-session.js:16` 单行切换；`reader.js` 保留一行回滚恢复 sax）
- bizOpRecon（业务OP数据核对）导入默认走 worker 化入口（流式 reader + child-process worker）；无 dbPath 自动回退旧同步
- β.1 多 worker 回滚：settings `acquiring_bill_worker_count=1` 即全程单 worker
- 测试基线：unit 1390 → **1473 case**（β.1 contract 20 + β.2 reader 11 / worker 10 + 收单导入 contract 18 + worker pool / settings worker_count + self-review/review 回归 6：C1/C2 temp·resume + I1/I2/I3 + MW cancel）；integration **952 断言**（含 β.1 嵌套 worker 拓扑）；smoke 0 regression

### α/β 收口

- **v2.1.12 β（本版）**：β.1 收单对账 multi-worker + β.2 bizOp 导入流式 worker 化 + 收单导入 sax→手写；全部纯性能架构提速、对用户行为透明（更快、结果不变）
- **🔴 合并门槛**：三块均为🔴资金红线，合成 fixture 已证 byte-for-byte，真实大文件由用户手测把关（① 收单对账 ≥100万行多 worker vs 单 worker 一致 ② bizOp 真实大文件导入五条红线 ③ 收单导入入库金额/币种抽样对原文件）

## 2.1.12-alpha.1（2026-05-31）

v2.1.11 之后 1 轮迭代（α 阶段 = 业务 + 收尾），2 个用户需求 + 1 个提示修正 + 1 批收尾清债：需求1（**新功能** 第 6 个模块「VCC业务OP计算」`vcc-op-calc` — 仅导入流水对账单、按月聚合发生额出/入、期末OP = 期初OP + 发生额、落库 + 显示余额、JSZip 流式 reader 支持百万行级大文件）+ 需求5（C3「提取ReconId-From 网关」场景 extra fee 额外费用匹配）+ 需求6（资金对账不平跳过提示加数据侧候选行预检）+ 收尾批（SR-log-1 删旧双写 / I6 bundle C2 防御测试 / I7 important-variables 升格）。⚠️ 2 个🔴资金红线（需求1 发生额求和 + 期末OP；需求5 改 C3 网关核销金额匹配）+ 1 个🔴破坏性变更（SR-log-1 停旧 activity log 写入、历史文件保留不删）。

### 新增

- **需求1 第 6 个模块「VCC业务OP计算」**（**新功能** · `module.id = vcc-op-calc` / 🔴资金红线）：UI 复用第 4 模块「月度银行对账单BU回填校验」面板/按钮/状态框样式，仅「导出差异」→「显示余额」；输入仅「流水对账单」xlsx（28 列，复用第 5 模块 `FLOW_COLUMN_DEFS` 结构），按「出入方向」对「对账金额」求和、月份取「账单日期」；业务语义 `发生额 = 发生额入 − 发生额出`、`期末OP = 期初OP + 发生额`（期初OP 用户手填上月 OP）；2 张新 DB 表 + FK（`vcc_op_calc_runs` 按月汇总 + `vcc_op_calc_run_files` 逐文件明细，金额列 TEXT，**不落流水原始行**，允许同月多 run、显示余额取最新）+ 2 索引；6 个 IPC（pick-files / scan / compute-amounts / save / list-months / get，资金类用 `trackedIpcHandle`）+ scan 进度事件（每 5 万行）；**JSZip 流式 reader（弃 SheetJS/exceljs）**——实测 78.7 万行/811MB worksheet，SheetJS 超 V8 单字符串 512MB 硬上限静默返回空、exceljs 又因 zip data descriptor 报 `invalid signature`，改 JSZip 走 central directory + SAX 扫 `<row>` + 多 sheet 定位 + 损坏文件提示 + 进度回调（实测 7.8s / RSS 778MB 优于 exceljs 16.9s / 2GB）；session 流式聚合（合并 scan+compute 一次读、不存全量行、内存恒定）；前端 MODULES 第 6 项 + `vccOpCalcState` + 3 dialog（F1 月份确认 / F2 计算框点计算即调 save 后端整数分算 endOp 原子落库、前端不自算 / F3 显示余额按月查月末 OP）+ 主面板镜像布局 + 4 处 preview 入口；后端 gap 修复 `ALL_MODULE_IDS` 补 `'vcc-op-calc'`（避免重蹈 v2.1.2/2.1.3 漏注册 `Invalid module id` 历史 bug，默认隐藏经🔄收纳弹窗启用）；🔴 资金红线护栏 = **整数分精度**（乘 100 转整数分求和最后除回，规避浮点漂移）+ **混币种全量合并求和**（所有币种不分币种合并 = 跨币种金额合计、非货币余额，已确认）+ **整批拒绝**（出入方向非法/多月份混杂/非数字行 → 整批拒绝 + 错误报告）+ session 单测 17 case（正/负/小数/空）+ **真实大文件核销发生额 2,223,798.77**

### 变更

- **需求5 C3「提取ReconId-From 网关」场景 extra fee 额外费用匹配**（🔴资金红线 · 业务规则 · UI · 引擎 / `category=gateway-recon-join`）：C3 场景新增/修改弹窗左下加勾选框「网关对账单金额与银行对账单不一致」，勾选后出现「网关对账单金额 +」`[输入框]`「= 银行对账单金额」，匹配时网关订单金额 + extra fee 后再与银行对账单金额比对；config 新增嵌套 `extraFee:{enabled:false,amount:0}`（与 v2.1.8 N2 `assign` 成组语义一致）；🔴 引擎方案 A1 = fee **仅作用于"银行侧字段 = 发生额绝对值"那个字段对**（零歧义，避免多金额对场景错配），该对网关值 `+fee` 后比银行值、其余 reconField 不变；🔴 允许正负（代数 `gw+fee=bank`，正=加/负=减）+ 允许小数 + 加法处 `Math.round((gw+fee)*100)/100` 归一到分（规避浮点）+ 4 字符仅视觉宽度不硬 maxlength；🔴 undefined→null 双防御（`runC3Scenario` 内算 fee 缺失→null + 引擎入口 `Number.isFinite(fee)?fee:null` 兜底，防旧调用不传 fee 致 `gwNum+undefined=NaN` 大面积回归）；旧场景惰性兜底无 migration（缺 `extraFee` 即关、旧 bundle 自动兜底）；校验勾选后 amount 必填+必须数字、未勾不校验；🔴 绝对不变量 = fee 未勾/=0 时与 v2.1.11 **byte-for-byte 一致**、1v1 严格消费红线不动；护栏 = 单测 DS1-DS9（含零回归 byte-for-byte）+ smoke C3 extra fee 端到端 + **真实网关+银行账单端到端人工核对核销**（合并前硬要求）
- **需求6 资金对账不平跳过提示加数据侧候选行预检**：银行对账单模块两处 C3 提示弹窗（导入后 `maybePromptGatewayReconImport` / 运行时 `shouldPromptGatewayReconAtRun`）现状只判"是否启用 C3 场景"（场景维度），即使启用 C3 但本次导入数据无任何能命中该类场景的行时仍弹「将跳过」；修复 = 现有启用判断后追加"数据侧候选行存在性"判断（启用 C3 AND 数据存在 ≥1 条命中 `gateway-recon-join` 场景 conditions 的行才弹）；新增只读 helper `countC3BankCandidates`（与 C3 引擎 conditions 语义完全一致）+ 1 IPC（main 查 session C3 候选行数）+ renderer 双 gate；边界：预检"无候选行"≠"不运行 C3"只是"不提示跳过"，不碰资金红线
- **I6 bundle 旧结构 C2 端到端防御测试**：补 `scenarios-bundle-ipc.test.js` 构造旧结构 bundle（v2/v3 含 C2 `category`+`billTypes≥1`+`conditions`+`reconFields`）→ 导入升级 → 断言 config 字段完整 + 能被 `runC2Scenario` 消费
- **I7 important-variables 升格**：`rules/important-variables.md` 新增 `config.billTypes`（C2 命中筛选数组 ≥1，归 Risk-sensitive ⚠️资金红线，与 `runC2Scenario` 同层）+ `config.conditions` 独立条目并与 `conditionsLogic` 交叉引用（此前 `billTypes` 仅在描述行内、`check:vars` 扫不到）；重跑 `npm run scan:vars` 刷新自动统计
- **测试基线**：unit 1338 → **1390 case / 327 suites**（vcc session 17 + reader 流式 / c3 extra fee DS1-9 + 零回归 / ALL_MODULE_IDS 8→9 / bundle C2 防御）；integration 943 → **952 断言 / 16 脚本**；smoke 0 regression

### 移除

- **SR-log-1 删 `app_activity_log.txt` 旧双写**（🔴破坏性变更 · 删数据红线护栏）：`logger.js` `appendActivityRecord` 移除旧 txt 写入，仅保留新结构 `appendStructuredLog`（`logs/{YYYY-MM}/{MM-DD}/{level}.log` JSON Lines）；`initializeActivityLog` 不再建/写 `app_activity_log.txt`、启动日志改走结构化日志；返回值改新 jsonl 路径；🔴 **停止新写入但保留历史文件不删**（老用户/脚本可能直接读旧 txt，删除 = 删数据事故；护栏 = 只停写不删，v2.1.11 及更早历史记录可继续查阅）

### α/β 收口

- **v2.1.12 α（本版）**：需求1 VCC 模块 + 需求5 extra fee + 需求6 提示预检 + 收尾批（SR-log-1 / I6 / I7）
- **不做边界（α）**：VCC 不导出 Excel（仅显示余额）/ 不跨月汇总；extra fee 仅 C3 不含 C4；biz-op-recon 第 5 模块流式改造（保留全量行 join、回归风险高）独立子任务评估、本版不含

## 2.1.11（2026-05-29）

v2.1.10 之后 1 轮迭代（β 范围），3 个用户追加需求（性能主线 A3-multi-worker / F5-cont 另起 spec）：T1（单元测试运行日志 — 终端 `N/N PASS` + 落盘带时间戳日志）+ T2（**新功能** pending 月度移除核对 — 导入移除归档文件入库 + 对账后自动用对账规则把移除数据与 `missing` 行匹配 + 导出 2 张新 sheet）+ T3（C2「银行对账单字段赋值」3 项增强 — 账单类型多条件 AND / FundType 严格下拉 / 对账字段可空）。⚠️ 1 个资金/对账红线护栏（T2 匹配复用对账规则 matchFields + compareFields + 数值归一化）+ 1 个向后兼容迁移（T3 C2 单条件→多条件惰性迁移）。质量收尾：3 路 adversarial self-review + SR-FIX round 1。

### 新增

- **T2 pending 月度移除核对**（**新功能** / 数据核对 · 导出契约）：「月度 Pending 数据核对」模块导入流程上叠加移除核对——导入某月数据成功后弹「是否核对移除pending数据」；选「否」流程零变化，选「是」导入「移除归档 Pending 账单」xlsx 入库（关联该月，作后续对账"上月"/`missing` 来源）；新增 DB 表 `removed_pending_rows`（全 46 列 raw_json + 6 索引列）+ `pending_removal_matches`（对账后匹配结果），幂等 migration、不动现有 `pending_rows`/`diff_rows`/`diff_runs`；新建 `removed-reader.js`（取第一个 sheet + 46 列表头映射）+ `removal-match.js`（对账后自动用对账规则 `matchFields` 多轮 fallback 配对 + `compareFields` 内容核对，与 `engine.js` 同语义）；导出（仅单 run）追加最右 2 sheet——「missing核对移除」（末列「移除核对状态」三态：`核对无误` / `核对有差异：字段(missing值≠移除值)` / `missing有_移除无`）+ 条件 sheet「移除有_missing无」（未配对移除行还原 46 列）；🔴 资金红线护栏 = 复用对账规则语义 + 数值字段归一化 + unit/integration/manual 三层
- **T1 单元测试运行日志**（测试基建）：`npm run test:unit` 解析 `node --test` 输出，终端打印仿 integration-runner 的 `==== N/N PASS ====` + 每文件用例数/耗时；每次运行落盘 `logs/unit-tests/unit-<YYYYMMDD-HHmmss>.log`（gitignore）；退出码透传语义不变、`release-check` 串联不变；reverse sync 修正根 `CLAUDE.md` "No unit test framework" 过时表述

### 变更

- **T3 C2「银行对账单字段赋值」3 项增强**（业务规则 · UI · 引擎 / 类目 `offset-bill-mark`）：① 账单类型支持多筛选条件 AND 全满足（`billTypes` 由 `[{seq,field,op,value}]` → `[{seq,conditions:[…]}]`；条件行加「新增」按钮插空白条件行；按 seq 分组 + 子序号 `#1.1`/`#1.2`；引擎改 AND 全满足才归类）；② 字段 = `FundType` 时值改严格单选下拉（仅枚举、运行时读 `assets/FundType枚举值.xlsx`，缺失降级文本输入），作用于条件行 + 赋值行；③ 对账字段放开非空校验，允许留空/删到 0 行（与引擎 `reconFields=0` 对齐）；④ 老单条件场景读取时惰性迁移为多条件结构（向后兼容、配置不丢、引擎入口兜底归一化）；已跑 `/check-vars` + `npm run preview:scenario-config-c2`

### 修复（SR-FIX round 1）

- 🔴 C1 资金红线：removal-match 数值字段比较前统一数值归一化（复用 `engine-utils` `isNumericFieldName`+`parseNumber`），修复"100" vs "100.00" / 千分位串系统性失配导致同一笔同时误报两张 sheet
- 🟡 I1 对账完成文案追加移除核对摘要（匹配 N 条/未匹配 M 条）；I4 `DELETE pending_removal_matches` 挪进与 INSERT 同一事务保原子性；I5 FundType 严格下拉保留旧值为 disabled option 防误覆盖
- 手测修复：markValue 校验误报；「移除核对状态」列接入 compareFields 逐字段内容核对、输出差异字段明细

### 测试

- unit 1338 case / integration 943 断言（新增 `pending-removal-reconcile.js`；C2 多条件/迁移覆盖在 unit）/ smoke 0 regression

### α/β 收口

- **v2.1.11 β（本版）**：T1 + T2 + T3 三个用户追加需求
- **v2.1.11 后续 Phase（另起 spec）**：性能主线 A3-multi-worker（多 worker 并行）+ F5-cont（C4 算法重写）

## 2.1.10（2026-05-29 — 已发布 / PR #54 merged 2026-05-28T15:48:39Z）

v2.1.9 之后 1 轮迭代（β 范围），4 主线：A3（runCheck 跨进程化 — worker_threads + 独立 DB + 跨进程错误回传）+ A4（SQL JOIN chunked 分批 — chunk size 10w + cancel chunk 边界）+ N4-cont-1（raw_json 体积治理 — 7 天保留 + idle 自动 + sentinel `''` v0.3）+ N4-cont-2（FK CASCADE — `diff_rows` 2 FK ON DELETE CASCADE + 8-status migration）。⚠️ 2 个🔴破坏性（N4-cont-2 DB schema 不可逆 + N4-cont-1 raw_json 不可逆清空）+ 3 个资金红线护栏 + 5 个 important-variables v12 升格。

### 新增

- **A3 runCheck 跨进程化**（架构级）：worker_threads + 独立 DatabaseSync 连接（D24=a 验证）+ 6 条 PRAGMA 强制；新建 run-check-worker.js + run-check-worker-pool.js + serialize-error.js；提取 runCheckCore 共用；setupIdleCleanupTimer 加 isBusy 守卫 + 30s grace；cancel 5 阶段间检查 + ROLLBACK；worker crash 自动 cold-start + op lock 释放 + Notification；主进程 event loop lag 65.7ms → 1.3ms（48.7x）/ worker cold-start ~11ms / IPC ~0.010ms
- **A4 SQL JOIN chunked 分批**（性能 + cancel 响应）：insertDiffRowsByJoinChunked 替代单条大 SQL；chunk 10w（spec §3.2 选定）+ 独立事务边界；runs.chunk_progress 列 + setRunChunkProgress / getRunChunkProgress；resume IPC handler 暴露（UI v2.1.11+）；cancel < 0.01ms 同步抛；chunked vs non-chunked 0.99x **byte-for-byte 一致**
- **N4-cont-1 raw_json idle 自动清理**（体积治理）：clearStaleSuccessfulRawJson 单 SQL UPDATE WHERE id NOT IN diff_rows + imported_at < N 天；settings 单键 retention_days（默认 7 / 范围 1-30 / 范围外回退）；复用 v2.1.9 N1' idle 30min cleanup 计时器追加回调；用户无感 0 UI（D27=N/A）；差异行 raw_json 永远保留；失败 graceful；目标 6 月体积 ~24GB → ~8GB（~99% 节省）；**v0.3 sentinel `''`**（v0.2 原 NULL 与 v2.1.8 N4 NOT NULL 冲突）
- **N4-cont-2 FK CASCADE 改造**（DB schema 不可逆）：acquiring_bill_currency_diff_rows.bill_import_id + run_id 加 ON DELETE CASCADE；ensureDiffRowsCascadeMigration_v2_1_10 + 8-status state machine（沿用 v2.1.9 N5 范式）+ 复用 v2.1.9 SR-backup-1 createBackupFn 注入；跨版本 v2.1.7/v2.1.8/v2.1.9 → v2.1.10 一步迁；PRAGMA foreign_key_check 0 violation 是 hard requirement；失败 ROLLBACK + 备份保留

### 变更

- **runCheck IPC 路径** main.js:10758-10785：直调 → workerPool.dispatchRunCheck；onProgress 改 worker 内部 forward；notifyResult / releaseOpLock 路径保留
- **setupIdleCleanupTimer** main.js:11155-11178：加 `runCheckWorkerPool.isBusy()` 守卫（spec §2.3.2）+ N4-cont-1 raw_json cleanup 回调追加（独立 try/catch + activity log）
- **rules/important-variables.md** v11 → v12：升格 5 条（Critical 4 + Important-skeleton 1）+ 更新 1 条（bill_imports.raw_json 扩 N4-cont-1 sentinel 语义）
- **集成测试** 9 脚本 / ≥ 497 case → **15 脚本 / 809 case**（v2.1.10 新增 5 脚本 / 164 case：a3-phase1 + a3-phase2 + a4-phase3 + n4-cont-1-phase4 + n4-cont-2-phase5）

### 修复（SR-FIX）

- **N4-cont-1 sentinel v0.3 修订**：原 v0.2 SET raw_json = NULL → Phase 4 T28 集成发现违反 v2.1.8 N4 NOT NULL 约束 → 用户拍板 Option A 改 SET raw_json = ''；所有 idempotent 守卫 / SQL 查询从 IS NOT NULL 改 != ''（commit 740fdc8）

### α/β 收口

- **v2.1.10 β（本版）**：4 主线如上
- **v2.1.11+ 继续延期**：A4 resume UI / N4-cont-1 settings UI / chunk size settings 化 / SR-log-1 双写删旧 / F5-cont C4 ILP

## 2.1.9（2026-05-27 — 待发布草稿）

v2.1.8 之后 1 轮迭代（α 范围），9 项主题：N5（银行渠道区分场景 — 🔴 资金红线 + DB schema 破坏性 migration）+ N6（状态框换行修复）+ N7（场景模板按渠道导入/导出 — 新 bundle 类型）+ SR-backup-1（sqlite VACUUM INTO 备份基建）+ G1-cont（单元测试 37 文件全量铺）+ SR-policy-1（integration-runner 清单自动同步）+ N1-settings（idle 阈值 settings 化）+ N4 重构（migration 备份切到新 API）+ SR-log-1（全局告警日志化 + JSON Lines）。⚠️ 1 个🔴破坏性（Sheet 3 主输出撤除 → 独立报表）+ 3 个资金红线护栏。

### 新增

- **N5 银行对账单按"银行渠道"区分场景**（🔴 资金红线 + 破坏性 migration）：channels 表 + 「通用」内置（id=1, is_builtin=1, 不可删不可改名）+ scenarios.channel_id FK ON UPDATE CASCADE；启动期 N5 migration（VACUUM INTO 备份 → 事务建表/加列/backfill 通用）；场景管理顶部「银行渠道」过滤 + 「管理」按钮 + createChannelManagerDialog；场景行「转移」按钮（搬运语义）；footer 「批量操作」+ 勾选列 + 批量转移/删除；dispatcher 双维 first-match-wins（专属优先 + 通用兜底，spec §2.1）；导入按 `<Channel>-<地区>` 匹配 → 未命中走通用兜底但保留原始 channelKey
- **N5 Sheet 3 拆出**（🔴 对外契约）：v2.1.8 N3-2 主输出 Sheet 3 撤除 → 独立报表 `命中场景行-{原文件 basename}-{timestamp}.xlsx` 落 `error-reports/{date}/`；列 = 44 原 + 匹配渠道/匹配状态/命中场景
- **N7 场景模板按渠道导入/导出**：独立 `scenarioBundleVersion=1` 与 `bundleVersion=4` 互认隔离；多选导出单文件多渠道；导入二阶段（needs-confirm → apply）+ 缺失渠道弹框 + 同名场景跳过；事务包裹
- **N6 状态框换行修复**：renderer.js 删冒号后冗余 \n（仅 2 行）；updateStatusBox 内层不动；其他 5 模块零外溢
- **SR-backup-1 sqlite 安全备份**：`src/backend/database/backup.js` 用 `VACUUM INTO`（POC 后 spec 反向同步，DatabaseSync.backup 不存在）；label 白名单防 SQL 注入 + tmp atomic rename
- **N4 重构**：N4 migration 备份切到新 createBackupFn（删 fs.copyFileSync + wal_checkpoint）；备份路径前缀 / 标志位 / 9 字段裁剪不变（v2.1.8 已发契约护栏）
- **N1-settings idle 阈值 settings 化**（D21=c 修订）：v2.1.8 硬编码 30min 改 settings 表 `acquiring_bill_idle_cleanup_minutes`（默认 30 / 范围 5-180）；启动期 loadIdleCleanupMsFromSettings 读取 + getter 兜底；**不做 UI** — 用户用 sqlite3 改 settings 表 + 重启生效
- **SR-policy-1 integration-runner 自动同步**：in-place 编辑 `rules/integration-test-policy.md §七`（全 PASS 才写）+ 时间戳东八区 + stdout
- **SR-log-1 全局告警日志化**（数据待 Phase 8.8 完成定稿）：preload reportLog + main IPC + renderer wrapper hijack + main 49 处 console.error 改造 + 新结构 `logs/{YYYY-MM}/{MM-DD}/{level}.log`（永久保留）+ JSON Lines + 双写兼容 app_activity_log.txt
- **G1-cont 单元测试全量铺**（数据待 Phase 1.5 完成定稿）：第 1 层 13 + 第 2 层 24 = 37 文件；累计 case 目标 ≥ 400（v2.1.8 baseline 123）

### 变更

- **N5 spec Reverse Sync 三轮**：v0.6 VACUUM INTO + v0.7 channelId 字段 + 不渲染删除按钮 + v0.8 createAppSettingsDialog 新建 + N4 调用方契约 + regex 兼容
- **集成测试改造**：`bank-statement-hit-scenario-sheet.js` 26 → `*-report.js` 44 case；6 脚本 / 324 断言
- **tasks T18/T26 笔误**：实际接入 main.js:3077（dispatcher） + main.js:3140（独立报表）

### α/β 拆分

- **v2.1.9 α**（本版）：9 主题如上
- **v2.1.10 β**（拆出）：A3 worker 跨进程化 + A4 SQL chunked + N4-cont-1 raw_json 治理 + N4-cont-2 FK CASCADE 改造
- **v2.1.11+ 继续延期**：F5-cont（C4 ILP 重写） / N5-channels-scale（虚拟滚动评估）

## 2.1.8（2026-05-26）

v2.1.7 之后 15 commit 收敛，6 项主题：F5（C4 算法重设 4/5 根因）+ G1（单元测试框架建立）+ N1→N1' v0.7（cleanup 改 idle 30min 触发 + 差异保留 + FK 反向同步）+ N2（C3「自取值」）+ N3（银行对账场景号修复 + Sheet 3）+ N4（差异表 29→12 列瘦身 + 破坏性 migration）+ v2.1.7-cleanup（10 项 minor）。⚠️ 2 个🔴破坏性（N4 raw_json 删 17 字段 + N4 输出契约 29→12）+ 3 个资金红线护栏 + 7 个 important-variables v11 升格。

### 新增

- **F5 C4 manyToOne 算法重设**（🔴 资金红线，4/5 根因）：BillDate 数字日期 fix + maxSize 动态档位 + 复合排序 + currency 等值过滤；TEST2.xlsx 28→43 行；根因 #5 subset-sum 剪枝延期 v2.1.9
- **G1 单元测试框架**：Node 22+ 原生 `node:test`（零 devDep）+ `tests/unit/` + `npm run test:unit` 28 suites / 123 case；G1 全量铺延期 v2.1.9
- **N1' (v0.7) cleanup idle 30min 触发 + 差异保留**（🔴 FK 反向同步）：3 层触发（idle 主 + before-quit 兜底 + 进入模块崩溃恢复）+ `cleanupAfterRunBackground` 加 `includeDiff=false` 仅清 flow（bill 因 FK 必须保留 + diff/runs 也保留作有效数据 + 元数据）
- **N2 C3「自取值」**：第二下拉新增 `__CUSTOM__` + 静态字符串输入框；DB migration 给历史场景加 `mode='direct'`；引擎 `mode='custom'` 分支
- **N3-1/N3-2 银行对账场景号修复 + Sheet 3「命中场景行」**：dispatcher `hitScenarios` 带 `displayIndex`；writer 可选 `includeHitScenarioSheet`；INTERNAL_FIELDS 加 `_hitScenarioDisplayIndex`
- **N4 收单差异表 29→12 列瘦身**（🔴 破坏性）：模版 9 列 + 单据_对账币种 + 流水侧 2 列 = 12；DB 破坏性 migration `ensureBillRawJsonV2Slim`（自动备份 → 事务 rewrite → 标志位），**永久删 17 字段**（ReconBillBizId / 公司主体 / 业务部门 / 对手部门 / 订单创建来源 / 财务BU / 账单类型 / 业务子类型 / 交易类型 / 对账子类型 / 单据状态 / 用户编号 / 账户号 / 账户类型 / remark / 创建时间 / 完成时间）

### 变更

- **F5 (T08) Reverse Sync F5-D4**：reader 入口 → c4 引擎入口（资金红线扩面收敛）
- **N1 → N1' Reverse Sync** β 方案降级为退出兜底，主触发改 idle 30min
- **N1' v0.9 FK 反向同步**：smoke caseP FK 错误 → bill_imports 必须连带保留
- **N4 输出契约破坏性变更**：3 轮 Reverse Sync（v0.8 → v0.9 → v0.10）后稳定收敛
- **`cleanupAfterRunBackground` 签名**：新增 `includeDiff = false` 参数；默认安全（仅清 flow）
- **v2.1.7 minor 10 项收尾**：8 已修 + 2 不可修记录

### 移除

- **N4 差异表输出 17 列**：ReconBillBizId / 公司主体 / 业务部门 / 对手部门 / 订单创建来源 / 财务BU / 账单类型 / 业务子类型 / 交易类型 / 对账子类型 / 单据状态 / 用户编号 / 账户号 / 账户类型 / remark / 创建时间 / 完成时间（仅输出 + DB raw_json 同步删除）

## 2.1.7（2026-05-21）

v2.1.6 之后 7 轮迭代收敛，50 commit。6 项主功能（F1-F4 / F6-F8）+ R3 状态框中文「：」全局换行 + B5 全局 wiring 加固 + B4 CSS flex/grid 嵌套 4 round 收敛。F5（C4 BillDate 数字日期 + 算法重设）延期 v2.1.8 与 A3（worker_threads）联合主题。5 资金红线（F2/F4/F7-A1/F8/R5）+ 4 全局影响（F7-A1/R3/B5/F4）+ 10 important-variables 升格。

### 新增

- **F1 C1 提取ReconId-From Self AND/OR 切换**（⚠️ R5 三层护栏）：dialog "条件" label 下方 AND/OR radio；新建默认 AND / 老 scenario fallback OR；引擎 fallback OR 保 v2.1.6 行为
- **F2 C3 提取ReconId-From 网关 1v1 化**（🚨 资金红线）：`usedGwRowIdx` Set 单向消费 gw 池，避免一笔网关被多笔银行重复"幽灵核销"
- **F4 「账单打标」→ 「银行对账单字段赋值」**：类目名 + 子 row 名「打标值」→「赋值」+ 默认空 + 校验放宽（账单类型 ≥ 1 / 对账字段允许 0）+ 衍生方案 A 无条件赋值
- **F6 收单单据币种校验进度提示**：导入文件 / 6 阶段运行业务化文案 + setImmediate 让 IPC 送达
- **F7-A1 全局 SQLite PRAGMA**（⚠️ 全局影响）：WAL + NORMAL + 64MB cache + 256MB mmap；用户备份 DB 必须同时备份 `*-wal` + `*-shm` 旁文件（USER_GUIDE §5.1）
- **F7-A2 source_file 索引 + ANALYZE**
- **F7-B1 完成系统通知**：macOS 通知中心 / Windows 任务栏原生
- **F8 银行账单结果第 2 sheet「未命中场景行」**（🚨 资金红线 baseline）：dispatcher 反向 filter `unmatchedRows` + writer 第 2 sheet；`modifiedRows` 完全不动
- **knowledge 沉淀**：`knowledge/css-flex-grid-overflow-pitfalls.md` — flex/grid 嵌套穿透 max-height 必修两条线（每层 min-height: 0 + grid 父 grid-template-rows: 1fr）

### 变更

- **R3 状态框中文「：」全局自动换行 + B5 wiring 全局加固**：3 处 setStatus 漏接修复 + smoke 新增 wiring 审计断言防再漏；C-1 self-review fix 删 `#bizOpReconStatusBox` ID specificity 覆盖
- **大账号确认页 4 round 收敛**：F3 文件名 grid 3 列 + B2 multi 字母 + B3 单 grid 表格 + B4 真根因 `grid-template-rows: 1fr`（DevTools 实测锁定）

### 文档

- PRD/spec/tasks v0.11/v0.9/v0.8（含 §二十三 50 commit 实施记录 + spec 反向同步 3 处）
- `rules/important-variables.md` v9 升格 10 条（Critical 3 + Important-skeleton 2 + Risk-sensitive 5）
- USER_GUIDE §五 v2.1.7 新增能力

## 2.1.6（2026-05-18）

v2.1.5 之后追加 patch 迭代，2 块独立改动：**Module A 个人痕迹元数据**（package.json author/copyright/publisherName + 跨库 watermark + 启动 log 头 + 构建时 git short SHA）+ **Module B 新增模块「收单单据币种校验」**（独立第 8 个主模块，按月对比收单流水表 vs 收单流水单据表币种 + 差异表 29 列对比区 1 对 1 输出）。OPEN ISSUE 全部拍板（PRD §六）。

### 新增

- **Module A 个人痕迹**（无业务影响）：
  - package.json author 对象化 + electron-builder 注入 Windows 文件属性 publisher = `pzhong`
  - 跨库 `applyWatermark()` 在 8 个 writer 共 17 处调用前注入 `lastModifiedBy = 'pzhong'`
  - 启动 log 头新增一行 `crafted by pzhong (pzhong1212@gmail.com) · build {sha}`
  - 构建脚本 `scripts/gen-build-info.js` + prebuild 钩子注入 git short SHA
- **Module B 新增「收单单据币种校验」模块**（⚠️ 资金红线）：
  - 主导航第 8 个独立面板（月份下拉 + 4 按钮 + 状态栏）
  - 按月组织：导入收单流水表（多 xlsx）+ 导入收单流水单据表（多 xlsx）
  - 关联键：流水 `对账主Id` ↔ 单据 `主对账Id`，1:1 严格关系
  - 币种判定：`LOWER + TRIM` 归一后比较（`usd` ≡ `USD`）
  - 流水金额入库 ABS（`recon_amount_abs`）
  - 差异表输出 29 列 = 单据原 26 列 + 末尾 3 列对比区（`单据_对账币种` / `流水币种` / `流水金额绝对值`）
  - 仅含差异行（不一致 + 缺失）；一致行 + unmatched 不入差异表
  - 1 对 1 输出：每个输入单据 xlsx → 1 个差异 xlsx；0 差异行也输出仅表头版
  - 4 张 SQLite 表（`acquiring_bill_currency_{flow_imports,bill_imports,runs,diff_rows}`）+ 5 索引 + UNIQUE(month_key, recon_main_id)
  - 7 个 IPC（`acquiringBillCurrency:*` 命名空间）
- smoke 用例新增 `scripts/smoke/acquiring-bill-currency.js`：A-G 7 case + A1 watermark 集成 = 26 assert
- reader 选型：ExcelJS streaming 4.4.0 race bug → 改 SheetJS dense

## 2.1.5（2026-05-15）

v2.1.4 之后追加 patch 迭代，3 块独立改动：N1 对账单 ReconID 修复模块名加空格 + 修 usage-stats long-standing bug；N2 对账单 ReconID 修复场景下拉空状态统一；N3 银行对账单处理 C3「提取ReconId-From 网关」场景配置 dialog 新增「条件」栏。OPEN ISSUE 全部拍板（PRD §十）。

### 新增

- **N3 — 银行对账单处理 C3「提取ReconId-From 网关」场景新增「条件」栏**（PRD §5.3）：`createScenarioConfigDialogC3` 在「优先级」与「对账字段」之间插入「条件」栏 + 行级 AND 预过滤
  - 条件行：`[侧↓ 网关/银行] [字段↓] [操作↓] [值] [×]`，操作沿用 `SCENARIO_CONDITION_OPS`（7 项）；左一切「网关/银行」时左二字段下拉重渲并清空
  - 字段枚举源：网关 → `GATEWAY_RECON_FIELDS`（31 列）；银行 → `BANK_STATEMENT_FIELDS_FOR_C3`（45 项含虚拟「发生额绝对值」）
  - **柔性校验**：conditions 可 0 行（兼容旧场景）；≥ 1 行时 side/field 必填 + 非空值/非空值 op 的 value 必填 + side 与 field 一致性校验
  - **AND 语义**（区别于 C1 的 OR）；运行时引擎 `runC3Scenario` 入口加 Step 0 拆分 + 过滤 `gwRows` / `bankRows` 后传入既有比对循环；银行侧虚拟字段「发生额绝对值」由新增包装函数 `evalCondition(row, cd, { useC3BankValueGetter })` 走 `getBankRowValueForC3` 计算
  - DB 兼容：v2.1.4 旧 scenario `config.conditions` 缺失 → 引擎兜底 `[]`，无需 migration
  - confirm 预览段在 conditions ≥ 1 行时追加文案

### 变更

- **N1 — 对账单 ReconID 修复模块名加空格**（PRD §5.1）：`对账单ReconID修复` → `对账单 ReconID 修复`（ReconID 前后各加一个空格）
  - 改动 6 处字面：`MODULE_REGISTRY.reconIdFix.name` + 3 处 `trackedIpcHandle` moduleKey + 1 处 error message + `usage-stats.js` `FUNCTION_REGISTRY` key
  - 不动：`module.id = 'recon-id-fix'` / `scenario.category` 字段值 / IPC channel name（preload + DB schema 依赖）
- **N2 — 对账单 ReconID 修复场景下拉空状态统一**（PRD §5.2）：3 档行为简化
  - 档 1（账单类别空）：保持真空白下拉 + disabled
  - 档 2（账单类别非空 + 0 场景）：改为真空白下拉（去掉「请先在场景管理中创建场景」提示文案）
  - 档 3（账单类别非空 + ≥ 1 场景）：去掉「请选择场景」占位项；fix1.2 修订：scenarios 加载完成后**自动选第 1 个枚举值**（撤回 v0.2 `selectedIndex = -1` 设计）

### 修复

- **⚠️ N1 顺手修 usage-stats long-standing bug**（PRD §2.1）：`FUNCTION_REGISTRY` 注册 key `'单据对账ReconID修复'`（多了"单据"两字）与 `trackedIpcHandle` 第 2 参 `'对账单ReconID修复'` 不匹配 → 防御性静默丢弃 → 对账单 ReconID 修复模块从 v2.1.0-beta.1 起统计计数全部丢失。本版改 registry key 为 `'对账单 ReconID 修复'` 全链路一致 + 与 N1 改后的模块名对齐
  - 旧 `.usage-stats.txt` `[单据对账ReconID修复]` section 在 v2.1.5 启动后下次 flush 时不再被写入；事实上历史 section 字段值全为 0，无有效数据丢失，未做 migration

### 内部

- 引擎接入：`c3-gateway-recon-join.js` 新增 `evalCondition` helper + `runC3Scenario` 入口 Step 0；模块导出 `evalCondition`
- dialog 数据流：`createDefaultScenarioConfig('gateway-recon-join')` 加 `conditions: []`；`validateScenarioDraft` + `buildScenarioConfirmDetailHtml` 的 `'gateway-recon-join'` 分支
- fix1.1 — C3 条件 row 列宽固定：CSS 加 `.scenario-config-c3-cond-row` grid 布局（`100px / 240px / 100px / 1fr / 22px`）+ `.scenario-config-c3-cond-field` 240px 固定列；不复用 `.scenario-config-multi-row` flex 避免影响 reconFields / billTypes 行；两套主题 `src/styles.css` + `src/styles-gemini-extra.css` 同步加规则
- fix1.2 — 场景下拉默认选第 1 个：`reloadReconIdFixScenarios` 末尾检测未选 + 自动赋 `state.reconIdFixSelectedScenarioId = scenarios[0].id`；下游 `refreshReconIdFixStatus` 触发；`renderReconIdFixScenarioSelect` 末尾 `selectedIndex = -1` 兜底分支删除
- smoke：`scenario-engines.js` 新增 8 case（C3 conditions 7 op + AND + 0 条件 + 银行虚拟字段，全 31 case）+ `usage-stats.js` 新增 3 case（FUNCTION_REGISTRY key 注册 + 旧 section 不再写入 + 三 fnKey 累加，全 61 case）
- preview：8 张重跑入库（main-page / module-cabinet / module-switcher-open / account-mapping / recon-id-fix-panel + business + gateway / scenario-config-c3）

### 不影响

- 不动 C1 / C2 / C4 dialog（仅 C3）
- 不动 C3 引擎核心 `gwMatchesBank` / assign / `getBankRowValueForC3` 写值逻辑
- 不动 IPC channel `'recon-id-fix:xxx'` / `scenario.category` 字段值（DB 兼容）
- 不动 v1.5.x / v2.0.0 / v3.0.0 等其他分支
- 业务OP数据核对模块名保持原状（用户已撤回该项）

## 2.1.4（2026-05-14）

v2.1.3 之后追加 patch 迭代：主页面工具栏小改 + 新增「小助手功能收纳」弹窗 + 对账单ReconID修复账单类别默认 gateway + 顺手修 v2.1.2/v2.1.3 遗留的 `CURRENT_MODULE_VALID` 枚举漏更新 bug。4 块改动 OPEN ISSUES 7 项 + V1 版本号格式全部拍板。

### 新增

- **小助手功能收纳弹窗**（PRD T3）：主页面右下角 🔄 按钮 → 弹窗双区域（闲置 / 启用）+ ➡️/⬅️ 移动 + 启用区行末 ⋮⋮ 拖拽手柄 + 两阶段提交（Fix1.2 修订）
  - 持久化：SQLite `app_settings.enabled_modules`（JSON 数组）；首次启动 seed 默认 3 个启用模块（网银账单生成 / 银行对账单处理 / 对账单ReconID修复）；点「完成」一次性落库，点「取消」/×/overlay 外部 丢弃所有变更
  - 启用区至少保留 1 个（O3）+ 当前激活模块被移出时自动切到启用区第 1 个（O4）
  - 闲置区始终按**视觉宽度**升序展示（Fix1.5 修订 — 撤回原 v0.1 O1 String.length 排序；CJK 字符算 2，其它算 1，让"月度银行对账单BU回填校验" 24 排在 "月度 Pending 数据核对" 21 之后）
- **左上角模块切换菜单**改为按 enabled_modules 动态渲染（旧版静态 7 个 button → 动态按启用列表生成 + event delegation）

### 变更

- **使用手册按钮换皮**（PRD T1）：文字按钮 → 圆形 emoji 📕（与左侧 🎨 统一），class 由 `text-action background-guide-btn` 改为 `palette-trigger`；点击行为不变
- **对账单ReconID修复账单类别默认 gateway**（PRD T4）：删占位项「请选择账单类别」+ 默认 selected 「网关对账单」+ DB 历史空值启动写回 gateway（O2）；旧用户已选的 business 不强制覆盖
- **USER_GUIDE 版本号 + 模块列表**：顶部 v2.1.1 → v2.1.4（v2.1.2/v2.1.3 写正文时漏更新顶部版本号字段，本次一并修订）+ §一 模块列表补齐第 7 个"业务OP数据核对（v2.1.3 新增）"（v2.1.3 漏同步）+ §一 加 v2.1.4 收纳说明 + §1.5 末追加 + §1.8 新增「主界面工具栏与模块收纳」章节

### 修复

- **⚠️ 关联 bug 修复**：`src/backend/database/settings-repository.js` 的 `CURRENT_MODULE_VALID` 在 v2.1.0-beta.1 写定后只列 5 模块 ID，v2.1.2 / v2.1.3 新增 `bank-bu-recon` / `biz-op-recon` 时只动 renderer 没同步 backend 校验 → 用户切到这两个模块 `setCurrentModule` 抛 Invalid current_module。本次提炼 `ALL_MODULE_IDS` 全集 7 ID，`CURRENT_MODULE_VALID` 与 `setEnabledModules` 校验共用

### 内部

- IPC：`settings:get-enabled-modules` / `settings:set-enabled-modules`（2 plain handler）；`app:get-info` 扩展返回 `enabledModules`
- settings-repository.js：`ALL_MODULE_IDS` + `DEFAULT_ENABLED_MODULES` 常量 + `getEnabledModules` / `setEnabledModules` 函数
- AppDatabase facade：`getEnabledModules` / `setEnabledModules` 方法
- renderer.js：`renderTopModuleSwitcher` 函数 + startup currentModule fallback + state.enabledModules
- renderer-dialogs.js：`createModuleCabinetDialog` 工厂
- CSS：`src/styles-gemini-extra.css` 加 `.module-cabinet-*` 样式块（含 grid 布局 / 选中 / 拖拽视觉反馈）
- preview：新增 `preview:module-cabinet` + `applyModuleCabinetPreviewState` + 加入 `preview:all` 链
- smoke：未拓展（本迭代仅 UI / state 改动，资金/对账算法零变更）

### 未改动

- 既有 7 个模块对账逻辑 / 算法 / smoke case
- v1.5.x / v2.0.0 / v3.0.0 等其他分支

### Fix1 修订（v0.2 — 2026-05-14 用户验收后反馈）

- **弹窗布局**：左右区域内缩对齐标题（28px padding）+ 高度 -32px
- **撤回 O6 "即时落库"**：改两阶段提交（完成 / 取消）；取消还原到打开弹窗前数据
- **➡️/⬅️ 上移**：与第一行 item 顶部平行
- **toggle 选中**：再次点击同一选中行取消选中
- **闲置区排序**：由 String.length 改为视觉宽度（CJK×2 + 其他×1），修正"月度银行对账单BU回填校验" 应排在 "月度 Pending 数据核对" 之后的感知问题
- USER_GUIDE §1.8.2 + §1.8.5 同步更新

---

## 2.1.3（2026-05-13）

v2.1.2 之后追加 patch 迭代：**新增模块「业务OP数据核对」**。每日 T-2/T-1 业务OP + T-1 流水对账单 → 「T-2 期末 + 当日流水 = 计算 T-1 OP」对账规则 → 逐行精准比对（epsilon=1e-2）+ 1:N 精准标差异 + 账户增减检测。OPEN ISSUE 18 项全部拍板（PRD §6.1）。

### 新增

- **新模块「业务OP数据核对」**：每日维度对账模块（第 5 个主模块）
  - 主菜单第 5 个入口 + 模块面板 3 按钮（导入文件 / 开始运行 / 导出差异）+ BU 单选下拉框
  - 「导入文件」→ 业务OP 日期对话框（年±1 / 月 1-12 / 日 1-31 三下拉不联动）→ 文件选择 → 校验通过 INSERT，失败弹错误报告对话框；第 1 日导入完成弹「续导确认」；多日后自动进入流水对账单导入流程
  - 「开始运行」→ 对账日期对话框（仅"三件齐"日期 = T-1/T-2 业务OP + T-1 流水按 BU 过滤齐全）→ 4 步对账算法
  - 「导出差异」→ 两 radio（单日 / 区间）→ 另存为对话框 → 写入用户指定路径
  - 数据库：4 张表（`biz_op_recon_imports/_flow_imports/_runs/_diff_rows`），共主 DB；与 v2.1.2 完全独立
  - **资金红线**：
    - 业务OP 双重校验（#1 拍板 B + #5 整批拒绝）：`发生额 == 入 - 出` AND `期末 == 期初 + 发生额`，epsilon=1e-2；任一不过整批拒绝 + 失败报告 xlsx
    - 流水出入方向枚举（#3 拍板）：仅「入」/「出」，入=+ 出=-；其他视为脏数据 → 整批拒绝
    - 多 OP 行精准标差异（#6 拍板 A）：同账户号 N 条 T-1 行各自独立比（v0.3 fix2.4：差异表无颜色高亮）
    - BU 比较语义（#7 拍板 C）：`normalizeBu = String(v).trim().toLowerCase()`，与 v2.1.2 一致
    - 重新导入清空旧 runs + diff_rows（#15 拍板 A）：避免"旧 runId 套到新数据上"
  - 差异表字段：业务OP 原 23 列 + 4 新增字段（比对T-2日 / 同账户号多个OP / 比对测算金额 / 测算金额差额）
  - **fix1+fix2 UI 微调**（v0.3 — 2026-05-13 手动测试回归）：BU 下拉空白占位切换 + option label 去行计数 + 业务OP/流水日期 dialog 默认值 = 系统日期-1 + 校验失败状态栏文字（去 ErrorReportDialog）+ **差异表无黄底**（#10 拍板回滚为 E）+ BU 行 CSS 宽度对齐
  - **fix4 资金红线 bug 修复**（v0.4 — 2026-05-13）：multi_op_account_count 在 onlyInT1 路径漏算（详见 PRD §3.5.4）；smoke 新增 Case I（I-1/I-2/I-3，15 assertion）防回归
  - **fix5 PRD 拍板修订**（v0.5 — 2026-05-13）：多 OP 账户 N 行全进差异表（不论相等/不相等），原"相等行不进表"规则回滚；`compareT1OpWithComputed` 相等多 OP 分支 push diffRows，meta = 相等/空/是；进表条件扩展为 `比对T-2日 非空 OR 比对测算金额 == 不相等 OR 同账户号多个OP == 是`；smoke 新增 Case J 防回归。便于资金审计逐行追溯。
  - **fix6 PRD #14 拍板回滚**（v0.6 — 2026-05-13）：区间导出由 N sheet 改单 sheet「差异」（所有日期合并）。按 data_date + 账户号排序；**不加新列**，依靠原表 Billdate 区分；`writeDateRangeDiffWorkbook` 重写 + 写 `console.warn` 日志告警 Billdate ≠ data_date（不弹 UI）；smoke 新增 Case K 防回归（sheet 数 > 1 / 表头列 > 27 / 排序失序均失败）。DB schema + session 层 + 单日 writer 均不变。
  - **round 1 self-review 修订**（v0.7 — 2026-05-14，PR #45 提 PR 后 reviewer agent 反馈）：1 critical（C1 资金红线 `clearByDateBu` LOWER+TRIM 与 `getRowsByDateBu` 对齐）+ 3 important（I1 13 个 v2.1.3 新符号升格 `rules/important-variables.md` Critical 2/Important-skeleton 4/Risk-sensitive 7 共 13 条；I2 落库前 BU trim 归一；I3 `computeT1Op` T-2 NaN end_balance 加 console.warn + summary 新增 `t2AnomalyAccountCount` 字段 + DB schema 新增字段 + 状态栏「T-2 异常 W 个」）+ 5 minor（M2 `AMOUNT_EPSILON` 提取到 columns.js 等）+ 3 新 smoke（Case L T-2 NaN 防回归 / Case M C1 大小写防回归 / Case N I2 BU trim 防回归）。known issue：v2.1.2 月度BU 模块 `createBankBuReconFileImportPromptDialog` UX 对齐留 KI-1 给下一 round。
  - **round 2 self-review 修订**（v0.8 — 2026-05-14，round 1 完成后再过 reviewer agent）：0 critical + 3 important（R2-I1 状态栏文案 `t2AnomalyAccountCount` 仅 > 0 显示「T-2 异常 W 个」；R2-I2 PRD §3.5.5 关键不变量补"部分 NaN 容错路径"描述 — 同账户号多行仅全 NaN 才标 anomaly，任一 valid 不退化；R2-I3 smoke Case L↔M swap + 新 Case O I2 BU trim 边界扩展）+ 5 minor（R2-M1 spec §三 IPC 表删假 handler `pick-biz-op-date` / `pick-flow-date`；R2-M2 `computeT1Op` 函数签名 spec ↔ code 对齐为 `(t2OpRows, flowAggMap)` 返回 `{ map, anomalyAccountSet }`；R2-M3 console.warn 文案 spec 跟 code 走；R2-M4 `subOneDay` 双源说明 + 升格 Risk-sensitive；R2-M5 `AMOUNT_EPSILON` spec §5.0 描述位置同步 columns.js）。rules/important-variables.md v2 → v3。
  - **round 3 self-review 修订**（v0.9 — 2026-05-14，round 2 完成后 Codex 自动 review 反馈）：1 P1 ⚠️ 资金红线（流水重导清该 date 所有 BU 的 runs/diff_rows — `runFlowImportAsync` 事务内新增 `clearRunsAndDiffsByDate(db, date)` 调用；按 date 跨所有 BU 清，与业务OP 重导按 (date, BU) 单 BU 清的 `clearRunsAndDiffsByDateBu` 区分语义不可混；smoke Case P 防回归）+ 2 P2（lockfile 同步 2.1.3 顶层 version 字段 / usage-stats 接入 `FUNCTION_REGISTRY` 注册「业务OP数据核对」+ 共 15 个 `bizOpRecon:*` IPC，5 个核心 action 用 `trackedIpcHandle` 包装 + 10 个 query/dialog/helper 保持 plain）+ 1 P3（`package.json:71` `preview:all` script 串入 `preview:biz-op-recon`）。rules/important-variables.md v3 → v4：升格 3 条（`runFlowImportAsync` Critical / `clearRunsAndDiffsByDate` Risk-sensitive / `clearRunsAndDiffsByDateBu` Risk-sensitive）。
  - **round 4 self-review 修订**（v0.10 — 2026-05-14，round 3 完成后 Codex 自动 review 反馈）：1 P1 ⚠️ 资金红线（业务OP 重导清下一日 (date+1, BU) runs/diff_rows — `runBizOpImportAsync` 事务追加 `clearRunsAndDiffsByDateBu(db, addOneDay(date), bu)` 调用 + 新增 `addOneDay(date)` helper UTC 实现避免时区抢跑；业务OP 某日数据双角色：当天 T-1 + 下一日 T-2 输入，漏清下一日 → stale 差异表 = 资金事故；与 round 3 P1 流水跨 BU 清**互补**：业务OP 单 BU 跨 2 日清 / 流水跨 BU 单日清；smoke Case Q 防回归）+ USER_GUIDE 流水汇总性质解释段（用户明确要求："流水对账单业务上就是该日所有部门的流水汇总"，BU-A/BU-B 共用同一份流水文件按 normalizeBu 过滤 — 这是流水重导跨 BU 清的根因；与 round 4 P1 业务OP 跨 2 日清说明合并到 USER_GUIDE §1.7.x 重导规则小节）。rules/important-variables.md v4 → v5：升格 2 条（`runBizOpImportAsync` Critical 与 `runFlowImportAsync` 对齐 / `addOneDay` Risk-sensitive 与 `subOneDay` 对齐）。
  - **round 5 self-review 修订**（v0.10.1 — 2026-05-14，round 4 完成后 Codex 自动 review 反馈）：1 P3 — 5 处归档文档残留旧口径"17 IPC trackedIpcHandle"，全部统一改为"5 tracked + 10 plain = 15 IPC"。无代码改动 / 无 smoke 改动 — 纯文档口径回填。
- **IPC**：新增 15 个 `bizOpRecon:*` handler；preload 暴露 `window.desktopApi.bizOpRecon.*`
- **smoke**：新增 8 用例（A 核心 / B 多 OP / C 账户号差 / D 流水累加 / E 整批拒绝 / F 区间导出 / G BU 隔离 / H 重新导入清空）+ helper/validator 单测，资金红线全覆盖

### 不影响

- v2.1.2 4 个老模块（月度银行对账单BU回填校验 + 对账单ReconID修复 + 银行对账单处理 + 月度 Pending 数据核对）+ 新开账户 + 网银账单生成 主模块**完全保留原状**

## 2.1.2（2026-05-13）

v2.1.1 之后追加 patch 迭代：**C4 dialog 文案变更** + **新增模块「月度银行对账单BU回填校验」**。资金红线（OPEN ISSUE #10 v0.5 → v0.8 重新拍板）：1:1 / 1:N / N:1 视为对账成功；N:M 视为数据异常 → 跳过 + 写入差异表 Sheet 3「异常」（不中断运行）。BU 比较（OPEN ISSUE #5 v0.9）：trim + toLowerCase + 空值归一（容忍 `Flowmore` vs `FlowMore` 大小写差异）。

### 新增

- **新模块「月度银行对账单BU回填校验」**：T-1 月 Pending 数据管理 + 银行对账单导入 → 1:1 / 1:N / N:1 对账成功 → 3-sheet 差异 Excel 导出（Pending / 银行对账单 / 异常）。
  - 主菜单入口 + 模块面板 3 按钮（导入文件 / 开始运行 / 导出差异）
  - 「导入文件」→ 月份对话框 → 文件提示 + 选择 ×2
  - 「开始运行」→ 月份选择对话框（仅 ready 月份）→ 触发对账
  - 「导出差异」→ 选指定月份 / 所有月份汇总 → 另存为对话框 → 写入用户指定路径
  - **资金红线**：1:1/1:N/N:1 视为正常匹配（精准标差异子对：仅标 BU 不等的子对）；N:M（双侧 ≥2）跳过 BU 比较 + 写入第 3 个「异常」sheet（不中断运行）
  - 资金红线对账（v0.8）：Pending.主对账单号 ↔ 银行对账单.ReconciliationId — 1:1 / 1:N / N:1 视为成功；N:M 视为异常（写 Sheet 3，不中断）
  - BU 比较语义（v0.9）：`normalizeBu = String(v).trim().toLowerCase()`（空值 → ''），加大小写归一化（容忍 `Flowmore` vs `FlowMore`）；对账单号匹配 `normalizeKey = String(v).trim()` 仍区分大小写
  - 差异表 sheet：Pending（20 列）+ 银行对账单（44 列）；BU 差异行整行 `FFFFFF00` 黄底
  - **v0.8 已删除**纯文本异常报告（旧 `error-reports/.txt` 设计）；N:M 异常改写入差异表第 3 sheet「异常」（不中断运行）
  - SQLite 主 DB 新增 3 张表（pending_imports / bank_imports / runs）；与 Pending 模块独立 DB 完全隔离
- **10 个 IPC handler**（`bankBuRecon:*`）+ preload API 暴露

### 变更

- **版本号**：2.1.1 → 2.1.2
- **C4 dialog 文案变更**（仅 ReconID 修复 / `isReconIdFixCategory` 分支）：
  - 「账单类型」→「对账字段」（dialog label / 按钮 / 错误消息 / 确认弹窗）
  - 「对账字段」→「对账内容」（同上）
  - 不动：内部变量名 / data 属性 / C1/C2/C3 dialog 同名文案
- **smoke 扩展**：A-E + F-H + I 覆盖导入回归 + 5 normalize 单测 = 36 assert（v0.8 修订；v0.9 BU 大小写归一；PR #43 Codex P1/F3 资金红线 regression）
- **preview 入口**：新增 4 张截图脚本

## 2.1.1（2026-05-12）

v2.1.0-beta.3 之后追加 patch 迭代：**PDF 整体移除**（破坏性变更）+ C4 dialog 文案优化 + **BillDate ±N 可配置** + tooltip + 按钮文案。6 个主 task / 8 个实现 commit / 单 PR 合并（PR #41 累计 17 commit，含 PM + 实现 + PR 草稿 + 用户反馈 fix + PR review round-1/2/3 fix + self-review-final fix）。

### ⚠️ 破坏性变更

- **PDF 导入功能整体移除**：完全卸下 `pdfjs-dist` + `tesseract.js`（含 OCR 训练数据）+ `pdf-worker.js` 子进程 + readers.js PDF 分支 + main.js dialog filter + `SUPPORTED_EXTENSIONS` 删 `.pdf`。安装包减小 ~25 MB。v2.1.0 及之前用户若用 PDF 导入会被破坏。

### 新增

- **C4 引擎 BillDate ±N 可配置**：取代硬编码 ±1day；`scenario.config.billDateRange = { enabled, days }`；不勾选保持现状（零回归）；勾选 + N 替换 Step 2/3.2/3'.2 容错窗口；用于跨日扎单对账场景。
- **C4 dialog "BillDate 日期范围" 区**：勾选框 + 输入框（1-999）+ tooltip ⓘ；独立一行渲染在"匹配模式" 下方。
- **C4 dialog "修复结果输出" / "订单修复ID取值" tooltip**：解释输出方向 + commonId 取值语义。

### 变更

- **C4 dialog 文案精简**（business 子模式）：
  - "匹配规则" → "匹配模式"
  - 3 个勾选框文案 "主边单据 X v Y 从边单据" → "主边 X v Y 从边"
  - gateway 子模式（"网关 X v Y 渠道"）保持不变
- **银行对账单处理 C3 提醒 dialog 按钮文案**：`跳过 C3 直接运行` → `直接运行`（不暴露内部代号）
- **smoke 扩展**：billDateMatches 加 4 个 days 单测；engine + engine-gateway 各加 BillDate ±N 端到端用例 + PR #41 review fix defensive fallback 用例（business **45/45**，gateway **13/13**）
- **preview 重跑**：4 张 C4 dialog 截图

### 移除

- `pdfjs-dist` / `tesseract.js` / `@tesseract.js-data/chi_sim` / `@tesseract.js-data/eng`（4 dep + 17 传递依赖）
- `src/backend/file-service/pdf-worker.js`（整文件）
- `readers.js`：`readPdfRows` / `shouldStopPdfMatchedRows` / `shouldSkipPdfMatchedRow` / `isPdfFile` 参数
- `scripts/smoke/scenarios.js`：`pdfMatchedRows` 用例
- USER_GUIDE.md：line 21 PDF 类型说明

---

## 2.1.0-beta.3（2026-05-11）

v2.1.0-beta.2 之后追加迭代：将"单据对账 ReconID 修复"模块扩展为 **对账单ReconID修复** 通用模块，下挂"单据对账单"（已有）+ "网关对账单"（新增）两个子模式，共用 C4 dialog + 引擎骨架 + IO 层；主面板新增"账单类别"一级筛选下拉。13 个 task / 5 个 commit / 单 PR 合并。

### 新增

- **对账单ReconID修复 — 网关对账单子模式**：新增 `scenario.category = 'gateway-recon-id-fix'`（与已有 `recon-id-fix` 并列）；scenarios.category CHECK 约束扩 5 值（幂等迁移函数 `ensureScenariosCategoryGatewayReconIdFix`）。
- **网关子模式 4 sheet 字段常量**：网关账单 31 列 / 渠道账单 16 列 / 订单修复 14 列（无 SubBizType）/ 对账结果 19 列；preload inline 副本同步。
- **主面板"账单类别"下拉**：枚举 `网关对账单 / 单据对账单`（初始空）；位置 = 原"场景"位置；持久化到 `app_settings.recon_id_fix_bill_category`；切换时级联清空 + 重新过滤场景下拉。
- **主面板行 2 wrapper**：[场景下拉 + 场景管理 + 导出文件] 同行，账单类别空时隐藏；"场景"从行 1 下移至与"导出文件"同行。
- **C4 dialog 双模式化**：函数内部从 draft.category 推导 subMode，9 处 mode-switch（匹配规则勾选框文案 / 字段下拉枚举源 / 标签文案 / 输出选项文本 / commonId-source 下拉枚举 / "网关账单"radio 在 1v多/多v1 时禁用 / SubBizType 取值栏整段不渲染 / locked fieldPair 默认值按 mode 选字段名 / errors + 预览文案）。
- **网关子模式引擎写值规则**：
  - 1v1：双 Type=0 + Reference 按 dialog "订单修复ID取值"选项决定（main=网关.reconciliationId / opp=渠道.reconciliationId / both=按 commonId.source）；
  - **1v多 拆账**：输入 1 笔网关丢弃 + 输出 n 笔（基于 mainRow 数据，Type=1 / Amount=对应渠道.receiveAmount / Reference 按选项）；
  - **多v1**：输出 n 笔（基于对应 mainRow，Type=2 / Amount 保持原值 / Reference 按选项）；
  - 全局约束：每笔渠道账单全局只能被一次消费；
  - 输出列：gateway 14 列（无 SubBizType），business 仍 15 列。
- **IO 双模式化**：reader/writer 按 subMode 选 sheet 名 + 字段常量；文件名前缀切换（业务 `单据对账修复-...` / 网关 `网关对账修复-...`）；session.subMode vs scenario.category 一致性校验。
- **网关引擎 fixture 化单测**：基线 6 用例（1v1×3 / 1v多 拆账 / 多v1 / 全局约束）+ constants sanity；PR #39 review 期间扩至 9 用例（mode='both' suffix 拼接 / source='' 空值 / UI 默认 config）→ 10/10 PASS；注册到 npm run smoke。
- **网关子模式 preview**：4 张新截图（主面板 business/gateway + dialog 默认/1v多 禁用）。

### 变更

- **版本号**：2.1.0-beta.2 → 2.1.0-beta.3。
- **主面板模块下拉项文本**：`单据对账 ReconID 修复` → `对账单ReconID修复`；module.id 保留 `recon-id-fix` 不变。
- **场景管理列表"功能类别"**：单据对账修复 → 单据对账单修复；网关对账修复 → 网关对账单修复。
- **算法层适配 gateway 字段名**：`findAmountLockedPair` 优先按 `locked === true` 识别 + 字段名 fallback；池子算法用 `amountPair.leftField/rightField` 取 cents（不再硬编码 'Amount'）；引擎入口对 gateway 渠道行做 createTime→BillDate 字段映射。
- **C4 dialog commonId 区域增强**：取值来源下拉新增空值 option（空值时 suffix 必填，校验失败弹错误框返回 dialog 保留编辑）；gateway 子模式同样渲染"加上 + 输入框"，Reference = source.reconciliationId + suffix（source='' 时仅 suffix）。
- **renderer-dialogs.js helper 抽取**：`isReconIdFixCategory(category)` / `reconIdFixModeFromCategory(category)`；9 处单一 category 判断统一替换。
- **主面板布局精修**（9 个 fix commit）：账单类别为空时保持 beta.2 完整布局 + 行 2 始终显示；场景管理保持行 1；下拉固定 165px；CSS grid 3 列严格对齐 + statusBox/pending-pair 等宽 292px；label/select 样式同模式（.select-label / .template-select 48px pill）；账单类别空时场景下拉真空白；5 元素整体微调左移；错误框去 "• " 前缀。
- **smoke 新增 2 用例**：mode='both' + suffix 拼接 / source='' 空值 + 仅 suffix（self-review P0 回归保护）。

### 修复（PR #39 review round 1-3 + self-review 收尾）

- **dispatcher C4 集合过滤**（P1）：`filterOutReconIdFix` 用 C4_CATEGORIES 集合（含 `gateway-recon-id-fix`），防 gateway 子模式场景误入银行对账 dispatcher。
- **状态隔离修复**（P2）：`clearResultCacheForCategory` + 删除场景刷新分支用 ReconID 子模式集合识别，防误清/误刷新银行对账模块。
- **新增 IPC `recon-id-fix:clear-session`**（P2）：切换账单类别清 main 端 session/result，防旧 session 回流。
- **UI 默认 config gateway 引擎匹配修复**（P1）：`createDefaultScenarioConfig` + "+ 新增对账分组" + 归一化 ensure 三处按 subMode 决定 `rightField`；新增 migration `migrateGatewayReconIdFixFieldPairs` 修复 DB 旧场景。
- **smoke 回归保护**：gateway smoke 6 用例 → 10 用例（含 mode='both' suffix / source='' 空值 / UI 默认 config 进引擎匹配）；ipc-handlers 20 → 21（clear-session T21）；migrations 15 → 19（H5/H6 migrateGatewayReconIdFixFieldPairs 用例 — 主路径 / 幂等 / 非 gateway 不动 / 防御性 unlocked 不动）；dispatcher smoke 扩展 gateway 剔除。

### 未改动

- C1/C2/C3 dialog 业务逻辑；C3 网关对账 join 模块与本次"网关对账ReconID修复"完全不同的模块（仅字段列名相同）。
- 单据子模式（business）现有 C4 引擎默认路径：输出 byte-for-byte 与 v2.1.0-beta.2 一致。
- BrowserWindow 配置 / module.id `recon-id-fix` / scenarios 表列结构与 UNIQUE 约束（仅扩 CHECK 枚举值）。

## 2.1.0-beta.2（2026-05-11）

v2.1.0-beta.1 用户实测后的 UI 精修 + 场景管理跨模块隔离 + 窗口控制按钮 hit-test 修复迭代。39 项改动 / 4 轮用户测试迭代（PR-A 业务隔离 / PR-B 6 项 UI / Round 2 13 项 / Round 3 v2 8 项），单 PR 合并提交。

### 新增

- **场景管理跨模块隔离**：dialog factory 接收白名单参数 + helper 让 11 处 reopen 链路透传白名单 + 全局状态 `state.activeScenarioListFilter`。
- **类别选择窗按入口过滤**：单类别入口（如 ReconID）跳过类别选择窗，直接进对应配置 dialog。
- **场景管理 dialog 右下"完成"按钮**：关闭 + 刷新主面板下拉。
- **场景管理 dialog 序号 1-based 顺序**：序号 = 列表内顺序，dataset.id 保留真实 id 用于 IPC。
- **单类别入口 compact 模式**：filter.length === 1 时隐藏 优先级 + 是否启动 列。

### 变更

- ReconID 主面板布局重排（行 1 左 [场景下拉 + 场景管理] / 右 [导入文件 + 开始运行]；导出文件按钮平移至场景管理下方；transform translateX 整体右移 + 缩距）。
- 状态框宽度固定 292px，左对齐导入文件 + 右对齐开始运行；初始文本统一 "欢迎使用小助手"。
- 场景下拉宽度收窄至 3/4。
- 4 个 scenario config dialog actions 顺序改 `[确认 取消]` 右下对齐。
- C4 dialog 大量 UI 精修：标题省略类别后缀、label 简化、勾选框单行、按钮文案、grid 对齐、Amount 锁定行视觉对齐、"="居中、场景名称 input 宽度、各类间距与防换行调整。

### 修复

- 全局窗口最小化 / 最大化 / 关闭按钮无响应（hit-test 被拖拽区域罩住，CSS 单 rule 修复）。
- 场景管理跨模块未隔离（v2.1.0-beta.1 遗留 bug）。

### 未改动

- ReconID 业务引擎 / 5 阶段算法 / 7+5 赋值规则。
- C1/C2/C3 dialog 业务逻辑。
- scenarios 表 schema / IPC 通道 / BrowserWindow 配置。

---

## 2.1.0-beta.1（2026-05-11）

新增**第 5 个顶级模块「单据对账 ReconID 修复」**（C4 类场景）。基于 4 sheet xlsx 跑用户配置的对账场景，按 5 阶段算法 + 7+5 条赋值规则修复主从单据，输出「订单修复」与「未匹配单据」双文件。整个迭代分 3 PR 实施。

### 新增

#### 单据对账 ReconID 修复模块

- **「单据对账 ReconID 修复」顶级模块**：第 5 个 module-panel + module-switcher 第 5 项；4 按钮（场景管理 / 导入文件 / 开始运行 / 导出文件）+ 主面板「场景」单选下拉（控制行 1，「导入文件」与「开始运行」之间）+ statusBox 6 状态文案（含 unmatched 档）。模块入口与现有 4 模块完全独立。
- **5 阶段算法（Round 4 subset-sum 重构 + Round 5 Step 2 微调）**：`runC4Scenario(scenario, sheets) → { fixedRows, warnings, unmatchedRows, stats }`。Step 1 同 BillDate + 全部对账字段 AND 全等 1v1 严格；Step 2 BillDate ±1day 容错 1v1（多候选 4 阶 tie-break 选 1 + 双向一致性校验）；Step 3.1/3.2 池子 1v多（subset-sum + 其他对账字段 AND 全等过滤候选 + size ≥ 2 + DFS 全遍历找全局最优 + 4 阶 tie-break：spread → distToMain → size → firstIdx）；Step 3'.1/3'.2 池子 多v1 对称。BillDate 字段名主从 sheet 都叫 `BillDate`；浮点 Amount ×100 整数化避精度坑。
- **7+5 赋值规则**：mode='main'/'opp' 单边修复 R1-R7（R1 主边 1v1 / R2 主边 多v1 Type=2 / R3 从边 1v1 / R4 从边 1v多 / R5/R6 SubBizType 自动查 reconResult / R7 SubBizType 手填覆盖）；mode='both' 主从都修复 RB1-RB5（RB1 1v1 双 Type=0 + 共同 ID / RB2 多v1 主 Type=2 从 Type=0 / RB3 同 RB1 / **RB4 1v多 双 Type=0**（Round 3 修订）/ RB5 复用主从单边 SubBizType 路径）。
- **C4 类场景配置弹窗（5 行布局）**：行 1 场景名 / 行 2 单据匹配规则（3 勾选框：1v1 / 1v多 / 多v1，1v多 与 多v1 互斥）/ 行 3 账单类型（动态行：序号 + 主/从联动字段下拉 + 7 op 下拉 + ❌ + 「+ 新增」）/ 行 4 对账字段（动态行：分组 block + Amount/Amount 锁定 + 组内 AND + 组间 OR + 「+ 新增字段对」/「+ 新增 OR 分组」）/ 行 5 修复结果输出（互斥勾选「主边/从边/主从都修复」+ 主从都修复展开共同 ID 区 + SubBizType 三选一互斥：自动查 / 主边手填 / 从边手填）。
- **未匹配单据告警 report（Round 3 新增）**：算法跑完后未配主从行单独写 unmatched.xlsx（sheet 名「未匹配单据」+ 6 列：场景名 / 单据来源 / OrderId / BillDate / Amount / 未配原因），随主文件一并由 `recon-id-fix:export` IPC 一次返回 `mainFilePath + unmatchedFilePath`。文件名联动主名（`{用户主文件 stem}-未匹配.xlsx`，同目录）。
- **共同 ID 拼接（PR-B Q2=a 决策修订）**：mode='both' 共同 ID = `源端单据.reconId + 输入框文本`（原方案 `src.OrderId + suffix` 改为 `src.reconId + suffix`）；下拉 option 文案"主边/从边单据 ID"改为"主边/从边单据 reconId"。
- **C4 dialog Amount 字段对锁定（Round 3 新增）**：reconGroups 默认带 `Amount/Amount` 锁定 fieldPair 作为第一行，select disabled + 隐藏 ❌ 删除按钮；新增 OR 分组也默认带 Amount 锁定行。Migration `migrateC4ReconGroupsAmountLockedFieldPair` 老库无损升级（3 路径）。
- **4 个 IPC channel**：`recon-id-fix:import` / `recon-id-fix:run` / `recon-id-fix:export` / `recon-id-fix:session-status`，全部走 main 进程内存 session（不持久化）；preload 暴露 `desktopApi.reconIdFix.{import, run, export, sessionStatus}`。
- **资金红线 defense in depth（双层防御）**：第一层 — 4 个 `scenarios:*` IPC 入口主动按 category 分流清缓存（'recon-id-fix' 清 reconIdFixResult；C1/C2/C3 清 processingResult；未知 category 双清 + warn 兜底）；第二层 — `recon-id-fix:export` 入口被动校验 `scenariosSnapshot`（`stableJsonStringify` 递归按 key 排序避免 SQLite round-trip 误判 stale），不一致 → 拒导出 + alert 让用户重新跑场景。`bank-statement:run` / `bank-statement:export` / dispatcher 入口 `filterOutReconIdFix` defense in depth 排除 C4。
- **scenarios 表 CHECK 约束扩 4 值 + reconGroups 数据迁移**：CHECK `category IN ('extract-recon-id', 'offset-bill-mark', 'gateway-recon-join', 'recon-id-fix')`（migration `ensureScenariosCategoryReconIdFix` 走 RENAME-CREATE-INSERT-DROP-COMMIT 重建表，幂等）+ migration `migrateC4ReconGroupsStructure`（reconFields[] → reconGroups[]，按 leftTypeSeq+rightTypeSeq 聚合 fieldPairs，仅扫 category='recon-id-fix'，幂等三连 smoke 验证）。
- **类别选择 / 场景管理对话框扩展**：`createScenarioCategorySelectDialog` 三选一扩四选一；`createScenariosManagerDialog` 「功能类别」列追加 `'recon-id-fix' → '单据对账修复'`；编辑/查看类别 → dialog 路由追加 `'recon-id-fix' → createScenarioConfigDialogC4`。
- **新增 4 sheet 字段常量**：`src/constants/recon-id-fix-fields.js` — `RECON_RESULT_FIELDS`（18 列）/ `BUSINESS_BILL_FIELDS`（23 列，主边）/ `OPPONENT_BILL_FIELDS`（22 列，从边）/ `ORDER_REPAIR_FIELDS`（15 列，输出）+ 4 sheet 名常量；preload 同步 inline 一份副本（preload sandbox 不允许 require）。
- **fixture 入库**：`samples/单据对账导出不平.xlsx`（真实场景）/ `samples/单据对账导出不平-对平例子.xlsx`（识读规律样本，PR-C 取消后保留备查）。

### 变更

- **版本号 bump**：`2.0.0` → `2.1.0-beta.1`。
- **`scenarios.category` CHECK 约束**：3 值 → 4 值（新增 `'recon-id-fix'`）；`scenarios-repository.js: VALID_CATEGORIES` 3 → 4；`updateScenario` 显式拒绝改 `category` / `is_builtin`。
- **renderer state 扩展**：`state.reconIdFix{Session,Result,Export,SelectedScenarioId,Scenarios}` 5 字段；`MODULES.reconIdFix = 'recon-id-fix'`；`elements` 缓存 6 个新 DOM；`setCurrentModule(moduleId)` 加分支调 `reloadReconIdFixScenarios()`。
- **`current_module` 持久化合法值追加**：`settings-repository.js: CURRENT_MODULE_VALID` 数组追加 `'recon-id-fix'`，切到第 5 模块后重启可保留模块选择。
- **`scenario-dispatcher.js`**：dispatcher 入口加 `filterOutReconIdFix` 过滤（C4 不走 first-match-wins 调度）+ 返回 stats 加 `skippedC4Count`（资金红线 defense in depth）。
- **使用统计**：`src/backend/usage-stats.js: FUNCTION_REGISTRY` 加 C4 模块（IPC + 按钮埋点）。
- **测试脚本新增 6 件套（108 用例）**：`migrations-recon-id-fix`（15 / 含 reconGroups 迁移 G1-G5 + Amount 锁定 H1-H3）/ `recon-id-fix-engine`（43 / 含 subset-sum helpers + 多解 tie-break + 浮点精度 + 大候选集性能 + 多v1 对称 + Round 5 Step 2 微调 6 用例）/ `recon-id-fix-io`（13 / 含 round-trip + writeUnmatchedReport + buildUnmatchedReportFileName 联动签名）/ `recon-id-fix-ipc-handlers`（20 / 含 P3-A 默认名 + P3-B 联动 + P3-C 同语义同 snapshot + 资金红线 stale-snapshot T12/T13）/ `recon-id-fix-end-to-end`（6 / 5 阶段端到端 mode=main/opp/both + 基金 fixture 全量回归）/ `recon-id-fix-scenario-ipc`（11 / scenarios:* 4 IPC 按 category 分流清缓存）。

### v2.1.0-beta.1 系列 PR 汇总

- **PR-A 骨架**（PR #35，merged 2026-04-30，commit `6e5ebaf`）：模块入口 + 场景 CRUD + DB schema 扩展 + C4 dialog 骨架 + 类别选择四选一 + 资金红线分流 + 18 用例 smoke。9 task / 35 改动文件。
- **PR-B 对账引擎**（PR #36，merged 2026-05-09，commit `844d1d5`）：4 sheet IO + 5 阶段算法 + subset-sum 池子 + 7+5 规则 + 4 IPC + unmatched 双文件 + scenariosSnapshot defense in depth + reconGroups Q1=B 决策回写 + Amount 锁定 Round 3 + Round 4 subset-sum 重写 + Round 5 Step 2 多候选 tie-break。16 task / 28 改动文件 / 7 轮 review。
- **PR-D 收尾**（本 PR）：版本号 bump + 文档三件套 + 整体 smoke / preview / check-vars / scan-vars 回归。5 task。
- ~~**PR-C 识读规律**~~（已取消，2026-05-09）：用户决策不再实施识读规律自动填表功能；§三 D7 / §六 F3 / §七.1 / §七.4 / §十.2 等章节标 DEPRECATED 保留历史决策痕迹。

### 明确不做

- 不预置 builtin C4 场景（区别于 v2.0.0-beta.3 的 3 个 builtin）；
- 不复用 `scenario-dispatcher.js` 调度（本模块单场景独占跑，无 first-match-wins）；
- 不接入大模型；识读规律功能整体取消；
- 主输出无标黄需求（区别于 v2.0.0-beta.3 银行对账单处理），用 `xlsx-js-style` 写出（不引入 exceljs writer）；
- 浮点精度处理：Amount ×100 整数化做 subset-sum，不依赖二进制浮点；
- BillDate 字段名固定为 `BillDate`（主从 sheet 都叫这个）。

---

## 2.0.0（GA 2026-04-30）

### 新增

- **错误报告加「可能原因」列**：3 个模块（生成网银账单 / 月度 Pending / 银行对账单处理）的 error-report 文件统一加「可能原因」字段，口语化文案（如 `多个字段抓到的对账ID不一致，无法判断该用哪个` / `一对多匹配，可能有重复数据`）。统一映射表覆盖 22+ 已知 code，未知 code fallback。
- **隐藏 `.usage-stats.txt`**：`~/Documents/网银账单生成小助手/.usage-stats.txt` 记录软件使用统计（打开次数 + 各模块各功能使用次数 + 总计），dot prefix 隐藏，关闭 + 每 5 分钟混合写盘。

### 变更

- **版本号**：`2.0.0-beta.3` → `2.0.0` GA 正式版。
- **所有导出表头字号统一 10pt**：4 处 writer 同步；`pending-session.js` 从 `xlsx`（CE 不支持 styles 写出）切到 `xlsx-js-style`。
- **使用手册另存为简化**：仅 `.html` + `.txt` 两种格式，默认 HTML。

### v2.0.0 系列收官说明

本版本为 v2.0.0 GA 正式版，包含 v2.0.0-beta.1 / beta.2 / beta.3 / beta.4 全部已交付功能。详见各 beta 版本段落（下文）。

---

## 2.0.0-beta.3

### 新增

- **「银行对账单处理」顶级模块**：第 4 个 module-panel + 切换器项；4 按钮（场景管理 / 导入文件 / 开始运行 / 导出文件）+ statusBox 5 状态文案动态展示；模块入口与 v1.x 主面板、Pending 模块完全独立。
- **3 类场景调度器（C1/C2/C3 + first-match-wins）**：`runAllScenarios(bankRows, gwRows, scenarios)` 全局行锁；按 `priority desc, id asc` 排序；返回 stats `{ totalRows, hitRowCount, scenarioHitCount, hitScenarioIds, warningCount, skippedC3Count }`。
- **C1 场景（提取ReconId-From Self）**：根据特征/其他字段提取 `ReconciliationId`；多字段值不一致 → error-report，不写入。
- **C2 场景（账单打标）**：双类型行配对（一一对应 CustomerRef + Credit==Debit）；一对多 / 多对一 → error-report；rightType 行字段被打标。
- **C3 场景（提取ReconId-From 网关）**：与「资金对账不平结果表」按 4 字段 AND 匹配（含发生额绝对值虚拟字段）；多匹配取首条 + warn；未导入 gw 文件时整类被过滤 + `skippedC3Count` 提示。
- **3 个内置场景**：默认存在，可编辑、可禁用、可删除；不提供"恢复出厂"（C1/C2 默认启用，C3 默认禁用）。
- **场景管理表（6 列 CRUD + toggle）**：`序号 / 功能类别 / 场景名称 / 优先级 / 执行操作 / 是否启动`；toggle 实时写库；序号取最小未用 ID（gap-filling）。
- **4 个场景配置弹窗**：`createScenarioConfigDialogC1 / C2 / C3 / createScenarioConfirmDetailDialog`（创建/编辑/查看三模式共用）；通过 renderer-side `state.scenarioDraft` 跨弹窗共享状态。
- **xlsx 标黄输出（exceljs）**：命中场景的行入主输出，被修改单元格黄底（FFFFFF00 ARGB）；非修改行不导出；error-report 独立 xlsx 产物。
- **导出文件支持另存为**：原生 saveDialog 选保存路径；文件命名 `银行对账单-YYYYMMDDHHmm-处理结果.xlsx`（统一格式）。
- **5 个 IPC channel**：`bank-statement:import / gateway-recon:import / bank-statement:run / bank-statement:export / bank-statement:session-status`；session 仅 main 进程内存。
- **`scenarios` 表 + 6 IPC channel**：CRUD + toggle-enabled；migrations 包含 builtin seed + 名称同步迁移 `ensureBuiltinScenarioNamesUpdate`。
- **资金对账文件提示时机**：导入银行对账单成功后，若启用了 C3 类场景且未导入 gw 文件 → 立即弹 confirmDialog（"导入文件 / 稍后再说"）。
- **状态框换行展示（white-space: pre-line）**：导入双文件 / 已导出含 error-report 时分行；命中场景以序号显示在 `（场景 1、3）`。

### 变更

- **版本号 bump**：`2.0.0-beta.2` → `2.0.0-beta.3`。
- **运行 / 导出成功 alert 移除**：内容直接写入状态框；failed / cancelled 仍走 alert。
- **状态框 5 状态优先级**：已导出 > 已处理 > 已导入双文件 > 已导入单文件 > 初始。
- **导出默认目录改用户另存为**：原 `Documents/网银账单生成小助手/bank-statement-process/{date}/` 自动落盘 → 改 saveDialog 让用户选；error-report 仍走默认目录。

### 移除

- **覆盖原 ID warning**：C1 `overwrite-existing-recon-id` + C3 `overwrite-existing-value` 不再产生 error-report 记录。⚠️ 资金红线提醒：原值非空被覆盖时无 warning 痕迹，需依赖 modifications 列表追踪。

---

## 2.0.0-beta.2

### 新增

- **页面风格切换（Clear / General 二选一）**：调色板顶部新增「切换页面风格」下拉 + 「应用」按钮，二次确认后即时切换（不 reload）。Clear = v2.0.0 全新主线（来自 Claude Design 38 份 HTML 设计稿）；General = v2.0.0-beta.1 之前的旧风格（向下兼容）。猫猫 GIF 跨风格保留（D8）。
- **SQLite `app_settings.ui_style` 字段（数据底座）**：存储 UI 风格（`'Clear'` | `'General'`），默认 `'Clear'`；首次启动若不存在则自动写入（D4 升级迁移）。
- **风格切换 IPC + preload API**：`settings:get-ui-style` / `settings:set-ui-style`；renderer 通过 `desktopApi.settings.{getUiStyle, setUiStyle}` 调用；`app:get-info` 返回体扩 `uiStyle` 字段。
- **风格-背景色联动（D16）**：Clear 默认背景 `#ffffff`，General 默认 `#efe8da`；切风格时仅当当前色是"另一风格默认色"（魔法值）时自动同步，不覆盖用户自定义颜色。
- **preview 脚本支持双风格**：`APP_PREVIEW_STYLE=clear|general npm run preview:all` 输出到 `docs/previews/<name>.png` 或 `docs/previews/_general/<name>.png` 两套截图（35×2 张）。

### 变更

- **版本号 bump**：`2.0.0-beta.1` → `2.0.0-beta.2`。
- **HTML 结构对齐 Clear**：`index.html` 基线整体重写（DOM 对照 `Clear/main.html` + `Clear/pending.html` 重组）；同时保留所有现有控件 ID 与 JS handler 不变。
- **dialog factory 双套适配**：alert / confirm / export-scope / remember-order-mismatch / 大账号管理 / 模板管理 / 拆分合并账单 / 账户映射 / 大账号选择 / 顺序提取 / Pending 系列对话框 / 调色板等全套 dialog 在 Clear 风格下视觉重写；General 风格通过条件渲染节点退化（5 类：`.gemini-gradient` / `.status-spark` / `.module-switcher-icon` SVG / `.select-shell` / `.alert-body+icon`）保持原视觉。
- **状态框 SVG-spark 装饰保留**：`updateStatusBox` / `setStatus` / `setNewAccountStatus` / `setPendingStatus` 改为写 `.status-box-text` 子节点（避免 textContent 整体覆盖清掉 spark）。
- **执行操作列 4 个 dialog**：Clear 风格表格列宽固定（`table-layout: fixed`）消除编辑/view 切换时的列位移；按钮组左对齐 + 第一个按钮 `padding-left: 0`，"修改"按钮左缘对齐"执行操作"列头。
- **Clear 风格右下角 Version 字体**：等宽（Courier New）。

### 移除

- 死代码 `legacyCreateBigAccountManagerDialog` + `legacyCreateTemplateManagerDialog`（共 -444 行）。其余 17 个 legacy 函数因运行时间接依赖暂保留。

---

## 2.0.0-beta.1

### 新增

- **顶部模块切换按钮改下拉（3 选 1）**：原二选切换器追加第 3 项 `月度 Pending 数据核对`。首次启动默认 `网银账单生成`，切模式不持久化（关闭重开仍回首项）。三个模块容器互不影响，切换时仅 hide/show。
- **全新顶级模块「月度 Pending 数据核对」**：独立业务链路 `导入 → 入库 → 规则化对账 → 差异落库 → 导出 xlsx`，覆盖财务/运营每月比对 Pending 数据的核心痛点。布局两行：第一行 `规则管理 / 导入文件 / 开始运行`；第二行 `导出差异 + 状态框`。对现有两个模块零侵入。
- **独立 SQLite 数据库 `tool-data-pending.sqlite`**：与主 DB 隔离；5 表幂等 schema（`rule` 单行全局 / `pending_months` / `pending_rows` 31 列中文原名 + row_hash / `diff_runs` / `diff_rows`）+ 5 索引。删除该文件即可完全清空 Pending 模块数据，主 DB 不受影响。
- **Pending 模板 31 列固定表头**（打包内置 `assets/Pending.xlsx`）：启动时读一次缓存整个会话期间复用。关键列 `pending资金类型` 允许任意文本（含空值）；导出差异按**实际出现值**动态分 sheet。
- **规则管理（单条全局）**：两组多选下拉——`对账字段`（JOIN key，至少选 1 项）+ `对账内容`（比对字段，可空）。全部选项来自 31 列表头。保存走"完成 → 二次确认 → upsert"覆盖当前规则；每次运算 JSON 快照随差异 record 存档做历史回溯。
- **多文件合并导入**：一次可选 N 个 xlsx 归为同一月份。child process 解析（带 `--max-old-space-size=8192`），主进程 `webContents.send` 转发 progress 事件到状态栏实时显示"正在导入 {YYYY-MM}：{file}（已处理 N 行）"。
- **严格校验链**：表头顺序 + 内容严格一致（任一不一致整批拒绝）→ 全月行级 hash 去重（SHA-1 + SOH 分隔符）。行级冲突整批 rollback，状态栏提示"导入失败，发现 N 条重复行，点击导出报错文件"；点击导出 xlsx 错误报告（schema = source_file / sheet_row / severity / message + 31 原列）。
- **覆盖前自动留底 xlsx**：同月重复导入 → 弹"{year}-{month} 已有 N 行"确认；确认覆盖前先把旧月全行写 `Documents/网银账单生成小助手/pending-archives/{YYYY-MM}/{YYYY-MM}-backup-{YYYYMMDDThhmmss}.xlsx`。写入阶段 `BEGIN → deleteMonth → 批量 INSERT → COMMIT`，失败 `ROLLBACK`。
- **开始运行（对账引擎）**：选两月 → 二次确认 → 相邻校验（跨年 `2025-12 ↔ 2026-01` 算相邻；不相邻弹 alert 并保留已选）→ benchmark 外推预计时间（固定采样 10000 行，精度 ±20%）→ 三段 SQL 产出 `new / missing / changed`。全部 SQL 用 `IS / IS NOT` 处理 NULL 友好；`changed` 按值严格相等（字符串 `===`，OT-8 不做 hash），由规则设计者保证上游数据清洗一致。
- **状态栏完成文案**：无差异 `对账完成：{下月} vs {上上月} 无差异。`；有差异 `对账完成：{下月} vs {上上月} 找出 N 条差异（X 新增 / Y 消失 / Z 变更），可点击"导出差异"另存。`。对账中 + 导入成功态挂 `data-tone="success"`；报错态挂 `data-tone="error"` + `.is-clickable`（视觉红框 + 鼠标手势反馈）。
- **导出差异 xlsx（单月选 run / 汇总取最新）**：
  - 单月：Sheet1 `汇总`（31 原列 + `diff_type` + compareFields 动态展开的 `{col}_before` / `{col}_after`）+ Sheet2~N 按 `pending资金类型` 实际出现值动态分 sheet。`changed` 行 31 列用下月 / `_before`=上上月、`_after`=下月；`new` 行 31 列用下月，`_before` / `_after` 空；`missing` 行 31 列用上上月，`_before` / `_after` 空。
  - 汇总：每 `(upper, lower)` 对取最新 run；Sheet1 `按月维度区别汇总`（最老 → 最新，空行 + 月份 label 隔开）+ Sheet2 `汇总`（扁平）。compareFields 取所有 run 的并集展开为列。
  - 第 1 行表头字体 `Courier New`（延续 v1.5.3 约定），数据区字体不变；sheet 名走 `sanitizeSheetName` 防非法字符。

### 变更

- **资金敏感修复：diff_runs 排序 tie-breaker**：`ORDER BY created_at DESC` 末尾加 `, id DESC`（AUTOINCREMENT 单调）。原因：`Date.toISOString()` 毫秒精度在同毫秒多次 run 时无法保证稳定排序 → 用户"导出最新 run"可能误取旧 run。修复后 reconcile 测试连跑 5 次 23/23 全绿。
- **renderer state 扩展**：`state.pending` 统一管理 `rule / months / latestRunResult / latestRunId / importing / importingText / currentYearMonth / running / runningText / errorReportAvailable / errorMessage / lastImportSummary`。状态栏文案按 UI 态分支映射。
- **新增 15 个 IPC + preload 暴露 `window.desktopApi.pending`**：`columns / rule:{get,save} / months:list / import:{pick-files,start,progress} / error:export-report / reconcile:{benchmark,run} / diff:{runs-list,runs-for-month-pair,latest-run-for,export-single,export-aggregate}`。
- **测试脚本新增 4 件套**（85 断言）：`test:v2.0.0:pending-import`（21 / 7 场景）/ `pending-session`（19 / 5）/ `pending-reconcile`（23 / 7，含手工 4×4 资金敏感样本）/ `pending-export`（22 / 2）。
- **版本号 bump**：`1.5.3` → `2.0.0-beta.1`。

### 明确不做

- 不支持 CSV / PDF 导入（仅 xlsx）；
- 不支持单月差异总条数超过 1,048,576 行（XLSX 单 sheet 上限）；
- 不提供规则"多条具名库"（单条全局；历史 run 保存 JSON 快照做回溯）；
- 不自动运行（必须手动点"开始运行"）；
- 不支持非相邻月份对账；
- 不修改现有"网银账单生成"和"新开账户余额账单生成"两个模块的业务逻辑。

## 1.5.3

### 新增

- **主页面「模板」下拉改为「模式」**：label 文本由「模板」改为「模式」，下拉值域收窄为两条——`制作网银账单`（默认选中，内部隐式使用 v1.5.2 的 `__FILENAME_MAPPING__`）和 `导出月度余额账单`（R1 新增）。真实模板与虚拟 ID 不再出现在主页面下拉，仅在「导出月度余额账单」模式的弹窗内出现。`制作网银账单` 模式下所有 v1.5.2 行为保留不变。
- **导出月度余额账单模式（R1）**：新增独立导出入口，点击「导出余额」弹出「请选择需要导出月度余额账单的银行渠道」对话框（模板下拉默认选中 `全部银行渠道`，另含全部普通模板；年份范围 = 近 10 年 ~ 今年+1；月份必须主动选）。完成后装配月度余额 records → 写入临时 xlsx → 再由系统保存对话框另存。文件命名 `月度余额账单-{模板名 or "全部银行渠道"}-{YYYY-MM}.xlsx`，单文件单 sheet 合并所有模板/大账号/币种；表头固定取自 `assets/余额账单模版.xlsx`，模板未提供的字段空字符串补位。
- **Q2 最新余额定义**：优先取 `billDate === 月末最后一日` 的 seed；无则按 `billDate ≤ 月末最后一日` 取最大的一条（兜底）；全部 seeds `billDate > 月末` 或完全无 seed 则跳过该大账号（不报错）。多币种大账号按币种拆多行。
- **按钮可用/禁用矩阵**：`导出月度余额账单` 模式下 `导入文件 / 导出明细 / 账户映射` 置灰禁用；`导入模板 / 模板管理 / 导出余额` 可用。E1/E2/E3 校验（模板空 / 时间空 / 两者都空）通过 `createAlertDialog` 弹框，确认后重开弹窗保留已填值；E4 所选范围无余额记录时弹「所选模板在 {年}年{月}月的月末及更早均无余额记录，无法生成月度余额账单」。
- **自有账号合并入大账号表（R2）**：`template_big_accounts` 表新增列 `account_nature TEXT NOT NULL DEFAULT 'client'`（取值 `'client' | 'own'`）。导入银行账号信息 Excel 后，客资 + 自有都进入「维护大账号」对话框 tbody（UI 不加颜色/标识区分；view 态下 own 行 merchantView 前加 `[自有] ` 前缀，input 值保持裸 merchantId）。
- **§3.1 自有账户隔离规则（跨需求一致性约束）**：自有账户**仅在 R1「导出月度余额账单」场景参与**，其它所有场景（大账号排序、大账号选择弹框、明细账单生成、大账号检测、字段固定分配、余额管理、账户映射等）一律过滤。实现：SQL 层软过滤（`getTemplateBigAccounts` 默认只返客资；R1 装配链路显式传 `{ includeOwn: true }`）+ 维护大账号对话框初始化改走独立 IPC `big-account:get-with-own` 拿含自有的完整列表。
- **历史 own-accounts/*.json 启动迁移（D15/D16）**：启动时执行一次性幂等迁移，按 bankName 匹配模板展平 `{merchantId, currency}` 写入 `template_big_accounts`（nature='own'），冲突保留已有记录并写 `[CONFLICT]` 日志。迁移幂等 flag = `app_settings.own_accounts_migration_v1_5_3_done='1'`。迁移日志独立写 `{storageRoot}/own-accounts-migration-v1.5.3.log`。原 `own-accounts/*.json` 文件**保留不删除**，作为回退兼容。迁移失败不阻塞启动（D15），状态栏以 error tone 显示告警；orphan bankName 跳过不告警（D16）。
- **导出 xlsx 表头字体统一为 Courier New（R3）**：明细（COMMON）、余额（BALANCE）、月度余额、多模板合并文件、新开账户模块导出的 xlsx **第 1 行表头**字体统一改为 Courier New（字号/颜色/粗体/合并单元格属性保持原样）。数据区字体不变；**无 CJK 回退链**（Q10 决策，CJK 渲染依赖系统字体替换，风险由用户承担）。新依赖 `xlsx-js-style@^1.2.0`，仅在 `writers.js` 局部 `require`（其它文件仍用 `xlsx`）以减少打包体积增长；合并场景需在 `mergeGeneratedXlsxFiles` 内部局部 shadow 为 `xlsx-js-style` 并补一次字体注入，否则合并产物 styles.xml 会被 xlsx 社区版 writer 重建为 Calibri。报错 xlsx / error-reports 字体不改。
- **账单拆分合并浮点精度修复（R4/D17 hotfix）**：`buildMappedRows` 合并分支 `net = sumCredit - sumDebit` 结果套 `roundAmount(...)` 强制 2 位小数 round，吃掉 IEEE 754 浮点噪声。`2377.49 + 178.31 = 2555.80`、`65572.01 + 4917.90 = 70489.91`、`(0.1 + 0.2) - 0.3 = 0`（静默跳过合并组）等场景现在稳定输出精确值。初稿方案 `roundAmountHighPrecision`（12 位）对样本 2 不收敛，改用 `roundAmount`（2 位）覆盖全部样本。

### 变更

- **主页面 state 新增 `mode` / `monthlyBalanceReady` / `monthlyBalancePreview`**；`selectedTemplateId` 默认值改为 `FILENAME_MAPPING_TEMPLATE_ID`。`updateTemplateSelect` 重写为只同步下拉 value ↔ `state.mode`；option 改为静态 HTML（不再遍历 `state.templates` 构造）。
- **`handleExportBalance` 按 `state.mode` 三路分流**：月度余额模式未装配 → 弹月度余额导出对话框；已装配 → 调系统保存对话框另存；制作网银账单模式 → 保留 v1.5.2 原链路。切模式时清前端 `monthlyBalanceReady / preview`，后端 `lastGeneratedExports.monthlyBalance` session 保留。
- **新增 IPC**：`monthly-balance:assemble` / `monthly-balance:export` / `big-account:get-with-own`。`preload.js` 新增 `window.desktopApi.monthlyBalance = { assemble, export }` 和 `window.desktopApi.bigAccount.getWithOwn`。
- **Bundle v3 透明扩展**：`SUPPORTED_BUNDLE_VERSION` 保持 `v3` 不升 v4。bundle 导出项 `bigAccounts[].accountNature` 字段可选携带（v1.5.2 读时忽略向后兼容；新版读旧 bundle 时缺省 `'client'`）。`groupBigAccountRows` 分组 key 扩展为 `merchantId::accountNature`，防止 client + own 同 merchantId 被错误合并。
- **`saveMappings` 透传 `accountNature`**：白名单校验 `'client' | 'own'`，非法/缺省默认 `'client'`；`expandBigAccountConfigurations` / `validateTemplateConfiguration` / `buildCompatibleBigAccounts` 同样保留字段。
- **SQL 过滤一致性（§3.1 落地）**：`listTemplates / getTemplate / listChildTemplates` 的 `bigAccountCount` 子查询加 `AND ba.account_nature = 'client'`；维护大账号对话框 `bigAccountCount` 不含自有，但 tbody 初始化另走 `big-account:get-with-own` 拿全量。
- **新开账户模块导出表头字体变为 Courier New**（D14 决策接受的副作用）：`new-account:generate` 共用 `writeBalanceWorkbook`，字体注入自动生效。

### 废弃保留

- `src/backend/own-account-store.js` + `big-account:save-own-accounts` IPC + `preload.js:bigAccount.saveOwnAccounts`：前端不再单独依赖，但过渡期**并行写**（json + 数据库同时写）以兼容旧代码路径（Q6）。原 `own-accounts/*.json` 文件保留不删除，作为 v1.5.2 回退兼容 fallback。

## 1.5.2

### 新增

- **按表头自动识别模板**：主页面「模板」下拉顶部新增虚拟枚举值「按文件名映射模板」并设为**默认**选中。导入时系统遍历所有模板，用 `matchesTemplateHeaders(filePath, template)` 逐个试表头自动匹配——用户无需在映射管理中配置任何字段（原映射管理对话框中的「按文件名映射模板」输入框模块**已删除**）。0 命中报 `FILENAME_MAPPING_NO_MATCH`、≥2 命中报 `FILENAME_MAPPING_AMBIGUOUS`，均**整批截断本次导入**；唯一命中直接按该模板解析（不再有 HEADER_MISMATCH 报错）。`filenameFixedField` 数据层保留不动（DB 列、Repo/IPC/Bundle 透传均在，只是 UI 删除，未来可能重新启用）。
- **表头唯一性校验**：导入模板文件时新表头与已有模板全量比较，完全相同则拒绝（`TEMPLATE_HEADERS_DUPLICATE`）；Bundle 导入时每个 entry 校验，重复则跳过并写 activity log 警告。确保按表头自动识别不会命中多个完全相同的模板。
- **多模板合并导出**：多个文件匹配到不同模板时，每组按各自模板独立生成（银行名称 / 所在地各自正确），合并为汇总文件：`{模板数量}-COMMON-{日期范围}.xlsx` / `{模板数量}-BALANCE-{日期范围}.xlsx`。合并方式为直接复制单元格保留格式，session 只 append 一次。
- **大账号确认页「单个账号匹多个文件」（M:1 映射）**：「提取大账号顺序」按钮右侧新增「单个账号匹多个文件」勾选框（**默认不勾选**）+ 编辑和完成**合并为 1 个 toggle 按钮**。勾选时不发生文本平移（visibility 占位），编辑态勾选 block 位置不变。完成后排序：uncovered 在前保持原序，covered 在后按组 a→z 排（组内按原文件顺序）。编辑还原：点编辑恢复原排序，保留已有映射供修改（不清空 multiGroups）。已映射 block 不参与「提取大账号顺序」，确认弹窗不显示已映射 block。左侧文件名左边新增字母列。勾选粒度 = **block**：同一文件的多个 block 可独立归属不同组或不归属任何组；支持"先左后右"与"先右后左"两种操作顺序。对话框主「完成」按 block 粒度把 `multiGroups` 展开为多条 `assignments`（key = `rowIndex`，同组多条 rowIndex 共享 MerchantId + Currency），与 1:1 部分合并后发送给后端。
- **主 / 子模板名校验**：映射关系管理「完成」按钮前置执行"子名.includes(主名)"字符串校验；勾选「设为子模板」+ 选中主模板时若当前模板名不包含主模板名，弹出提醒框「子模板与主模板模板名匹配不上，请检查。」，**整个 save 流程被阻断**，用户确认后重新打开对话框。未勾「设为子模板」或未选主模板时不触发校验。

### 变更

- **模板数据结构**：`templates` 表新增 `filename_fixed_field TEXT NOT NULL DEFAULT ''` 列（数据层保留，UI 已删除输入框）；`listTemplates` / `getTemplate` / `listChildTemplates` / `listTemplateBundleEntries` 的 SELECT 追加 `t.filename_fixed_field AS filenameFixedField`；新增 `saveTemplateFilenameFixedField(db, templateId, value)` 仓储方法。
- **Bundle v4 透明扩展**：`SUPPORTED_BUNDLE_VERSION` 保持 `4` **不升 v5**。`filenameFixedField` 作为 v4 schema 下的透明扩展字段由 bundle 自动携带；旧 v4 bundle 导入时回退为空串；`bundleVersion > 4` 仍然拒绝。Bundle 导入时新增表头唯一性校验，重复 entry 跳过 + 日志警告。
- **大账号确认页 row 结构扩展**：`buildBigAccountSelectionRows` 每 row 追加 `fileIndex` 字段；前端新增状态机 `multiMode / multiEditing / multiGroups / pendingGroup`。
- **大账号确认页 UI**："导出当前文件"更名为"导出**当前批次文件**"；"导出所有"更名为"导出**所有批次文件**"。
- **固定模式与 M:1 互斥**：`rememberCheckbox` 与 `ba-multi-mode-checkbox` 双向 `disabled` 互斥；mode 切换时清空 `multiGroups / pendingGroup`。
- 新增 IPC `template:save-filename-fixed-field`；`preload.js` `templates` 对象追加 `saveFilenameFixedField`。
- **虚拟 ID 短路 helper**：`main.js` 与 `renderer.js` 各自定义 `isFilenameMappingMode(templateId)` helper，避免虚拟 ID 流入真实 DB 查询。

### 移除

- 映射关系管理对话框中的「按文件名映射模板」输入框模块（配置 filenameFixedField 的 UI 已删除，数据层保留）

## 1.5.1

### 新增

- **主/子模板**：模板可声明为「主模板」或「子模板」。映射关系管理 dialog header 新增「设为主模板」「设为子模板」checkbox，互斥逻辑；选「设为子模板」时出现主模板下拉框。模板管理页面新增「模板管理」标题；主模板行带 ▶/▼ 展开折叠按钮，子模板缩进显示。
- 主页面模板下拉框自动过滤子模板（只显示主模板）；文件导入时按 headers 精确匹配候选模板，在大账号选定后重建 rows。
- **账户映射按模板隔离**：`account_mappings` 表重建，以 `(template_id, bank_account_id)` 为联合唯一键；同一银行账号在不同模板下可配置不同映射。首次打开账户映射会检测迁移 flag 并弹「迁移分配对话框」引导用户将旧数据分配到具体模板。
- **账户映射 UI 调整**：表头文案「网银大账号ID」→「网银账单账户号」、「清结算系统大账号ID」→「清结算系统银行账号」；执行操作列编辑/完成切换交互，按钮左对齐；币种 ⓘ tooltip 展示说明文本；提取大账号顺序时如检测到桥接匹配 + 多币种会弹提醒框。
- **Bundle v4**：模板包导出/导入支持主/子模板关系（`parentTemplateKey`）和账户映射（`accountMappings`）。`SUPPORTED_BUNDLE_VERSION = 4`。导入时三阶段还原（模板 → 父子关系 → 账户映射）。
- **重复判定增强**：文件导入按「路径 > 文件名 > 内容（SHA-256 哈希）」三维度判重，提示框显示重复原因。

### 变更

- 移除账户映射弹框的 `noCurrency` checkbox，改为根据币种输入框值自动判断。
- 重复判定对话框改为两按钮（覆盖旧记录 / 取消本次导入），移除「保留两份」选项。
- 账户映射缺失不再阻断导入。
- Bundle v3 向下兼容（缺失字段默认空值）；`bundleVersion > 4` 的 bundle 仍然拒绝。
- `template:get-mappings` / `listAccountMappings` / `saveAccountMappings` / `listTemplates` / `listTemplateBundleEntries` 等 DB 层方法签名扩展 `templateId` / `isParent` / `parentTemplateId` 等参数。

### 移除

- 账户映射弹框的 `noCurrency` checkbox。

## 1.5.0

### 新增

- **发生额精度提升到小数点后 12 位**：`Credit Amount` / `Debit Amount` / 发生额 / 余额均支持最多 12 位小数，原始值有几位就保留几位，不补零。Excel 导出默认数字格式；有效数字超过 15 位时自动切换为文本格式保持精度。
- **「提取大账号顺序」功能**：网银账单解析大账号确认页左下角新增按钮，自动从文件识别账户号并在「确认大账号顺序」弹出页展示，支持双输入框编辑 + 精准匹配校验。「完成」按钮按条件覆盖右侧大账号顺序表。
- **「记住顺序」持久化增强**：固定模式下勾选「记住顺序」会持久化「文件个数 + 各文件账户数与账户号 + 排序」。下次导入按文件个数和账户匹配自动回显；文件数不匹配时切回「账号顺序不固定」模式；账户信息匹配不上时弹提醒框供用户选择「变更配置」或「确认」。
- **英文日期格式解析**：支持 `DD Mon YYYY`（`09 Apr 2026`）、`Month DD YYYY`（`April 9, 2026`）、以及「逗号 + 时间 + AM/PM」形式（`09 Apr 2026, 06:26:26 PM`）。
- **导入模板包同名覆盖确认**：`template:import-bundle` 在循环前扫描同名模板，用 Electron 原生 `dialog.showMessageBox` 弹确认框，避免静默覆盖。
- **使用手册导出格式扩展**：支持 `txt` / `md` / `html` 三种格式。HTML 使用 `marked` 库渲染 Markdown 后保存（新增 `marked` 依赖）。
- **指定账单实现功能**：按正负号 / 按字段区分发生额有值时出现「指定账单实现功能」勾选框 + 多选账单序号下拉。副区域有值未勾选指定时全部 Credit/Debit 禁用；勾选指定时被指定行禁用、未指定行保留行级 Credit/Debit 直接映射。

### 变更

- **模块名称**：新开账户模块按钮文本由「新开账户生成网银账单」改为「新开账户余额账单生成」。
- **大账号确认页重构**：页面标题和文案统一；主页面左右面板支持同步滚动。
- **提取大账号顺序弹框**：DOM 重构为 `.extract-scroll-container`，改为单滚动条。
- **大账号选择对话框条件单滚动条 + 文本化**：勾选「记住顺序」时切为单滚动条 + 右面板文本化只读显示；取消勾选恢复双滚动条 + checkbox 列表。
- **映射字段列位置固定**：`.concat-field-picker` / `.mapping-field-editor > button[hidden]` / `.bill-split-group-btn[hidden]` 改用 `visibility: hidden + pointer-events: none` 保留占位空间，不再因 `display: none` 导致列平移。
- **映射字段下拉框宽度固定**：`.mapping-select` 固定 `min-width: 260px; max-width: 260px`，长文本在下拉框内截断显示。
- **按正负号下拉框宽度**：`.bill-split-sub-row .mapping-select` 由 `min-width: 200px` 改为 `min-width: 260px; max-width: 260px`。
- **映射互斥补全**：发生额互斥由单向改为完整 3 选 1（按字段区分 / 按正负号 / 均无），修正空值误判为激活的 bug。
- **拼接字段预览文本截断**：移除 `.concat-preview` 的 `max-width: 200px` 硬限，截断阈值由 40 字符提升到 120 字符。
- **六列表格 UI 优化**：账单序号表头不换行；行级「完成」后 4 个 select 改为纯文本显示（表格 `table-layout: fixed` 防抖）；账单序号列抬头/数字缩进（`padding-left` 1em/2em）；维护大账号币种校验失败改为弹框提醒，不再只在状态栏显示。
- **主页面初始状态框文本**：启动文本由「已加载内置枚举表：COMMON枚举.xlsx」改为「欢迎使用小助手」。
- `roundAmount` 新增高精度版本，保留原实现兜底短精度路径。

### 移除

- 六列表格的「发生额」列（合并/拆分场景下不再需要）。

## 1.4.9

### 新增

- 映射关系管理新增「账单拆分合并管理」分组：`是否拆分/合并明细账单`（默认 `否`） + `复用模块字段的映射关系`（默认 `是`）两行开关。
- 启用 `是否拆分/合并明细账单` 时，与 `Credit Amount` / `Debit Amount` 直接映射、`按正负号拆分的发生额`、`按字段区分发生额` 形成 **四方互斥**。
- 新增「拆分/合并账单映射关系设置」弹框（宽度 `80vw`），用于在 `复用模块字段的映射关系 = 否` 时为非金额字段单独配置映射；右上角 `导入当前映射关系` 按钮可从主模板复制配置（自动排除 `Currency` / `Credit Amount` / `Debit Amount`）。
- 新增「拆分/合并账单映射关系管理」弹框：包含 `合并账单` 勾选框、`需要拆分成几份账单` 数字输入 + `拆` 按钮、六列表格（`账单序号` / `Currency` / `Credit Amount` / `Debit Amount` / `发生额` / `执行操作`）和副区域「拆分/合并账单——发生额映射关系管理」。
- 弹框二的合并账单 picker 为 checkbox-panel 多选样式；删除合并组内的拆分行时，会先弹出受影响合并组列表的二次确认（外科手术式解散）。
- 弹框二支持行级落库：`需要拆分成几份账单` 输入数字 N 后点 `拆` 生成 N 行，每一行的 `完成` 按钮单独锁定该行；行变只读后按钮变成 `编辑`，再点可解锁继续修改。
- 导入流程新增按弹框二配置展开 N 行输出的能力（`expandBillSplitForRow`），并按 `merged_group_seq` 分组求净值合并输出（`applyBillSplitMergeForRow`）。
- 新增 4 张 DB 表：`template_bill_split_meta` / `template_bill_split_mappings` / `template_bill_split_rows` / `template_bill_split_amount_rules`，配套 10 个 IPC handlers。
- 多文件导入时新增「以下文件全部未命中拆分/合并规则，请检查规则配置：…」聚合告警，与 1.4.8 的「按字段区分发生额」全部未命中告警平行独立。
- `Drawee Name` / `Payee Name` / `Drawee CardNo` / `Payee CardNo` 在拆分场景下按每个拆分行自己的收支方向独立分配，`reuseModuleMapping` 为 `是` / `否` 两条路径行为一致。

### 变更

- 单行拆分行的 `Credit Amount` 与 `Debit Amount` 同时为 0、或合并组净值为 0 时改为 **静默过滤** 不输出，不再报错或弹提示；合并组 `Currency` 不一致时仍然报错 `BILL_MERGE_CURRENCY_MISMATCH` 阻断导入。
- `bundleVersion` 升级到 `3`，导出 entry 新增 `billSplitMappings` / `billSplitRows` / `billSplitAmountRules` / `billSplitMeta` 四个字段；旧 `bundleVersion = 2` 的 bundle 按 4 张表的默认值兼容；`bundleVersion > 3` 仍然拒绝。
- `template:get-mappings` IPC 返回值补齐 `billSplitGroupFields` / `billSplitMappings` / `billSplitRows` / `billSplitAmountRules` / `billSplitMeta` 5 个字段，修复冷启动后首次打开「拆分/合并账单映射关系管理」弹框只显示初始页面的 bug。

### 移除

- 无

## 1.4.8

### 新增

- 映射关系管理新增 `按字段区分发生额` 配置项（归入 `ADVANCED_MAPPING_FIELDS`，放分组末尾），下拉选项为空白（默认）/ `是`；选 `是` 时右侧出现 `发生额映射关系管理` 按钮。
- 启用 `按字段区分发生额` 时，与 `Credit Amount` / `Debit Amount` 直接映射、`按正负号拆分的发生额` 形成 **三方互斥**：选 `是` 自动清空并禁用另外三行；切回空白时按钮隐藏，弹框配置草稿独立保留，再切回 `是` 时回显。
- 新增「发生额映射关系管理」弹框：固定 2 行规则——一行 `当 [字段] 的值为 [输入] 时，[字段] 映射为 Credit Amount`，一行映射为 `Debit Amount`；4 个下拉框选项来自 `template.headers`，排除 `自己输入` / `需要拼接字段` 特殊值；同行内 `条件字段 ≠ 目标字段`。
- 条件值匹配规则：默认按字面值精确匹配（整串、大小写敏感、源值先 trim、不做数字归一化）；输入 `/pattern/flags` 形式按正则匹配，支持 `i` / `g` / `m` / `s` / `u` 等 JS RegExp flags；不支持多值，多值场景请用 `/^(C|CR|Credit)$/` 这类正则分组代替。
- 新增 DB 表 `template_amount_split_rules` 和 IPC `template:get-amount-split-rules` / `template:save-amount-split-rules`。
- 多文件导入时新增「以下文件全部未命中收支规则，请检查规则配置：…」聚合告警；按文件独立判定 + 跨文件聚合后弹一个合并告警框。
- 新增 `bundleVersion` 顶层字段（v2），导出 entry 包含 `amountSplitRules`；导入时 `bundleVersion > 当前支持版本` 被拒绝（v1.4.8 自身不会触发，为后续版本预埋）。

### 变更

- `saveMappings` 签名扩展为 6 参，最后一个参数 `amountSplitRules`（`null` = 保留原值，`[]` = 清空）。
- 无效正则保存时报错 `正则表达式语法错误`；同行内条件字段等于目标字段时报错。

### 移除

- 无

## 1.4.7

### 新增

- 大账号选择对话框重写为左右分栏布局：左侧按文件顺序展示，右侧按勾选序位展示，并新增搜索定位与勾选序号回显。
- 多账号账单导入新增 **账号顺序固定 / 不固定** 模式：固定模式下要求一次勾选全部大账号且按指定顺序导入，并支持「记住顺序」在下次导入时回显配置。
- 日期解析支持 BNI 点号时间格式 `HH.MM.SS`、Excel 日期序列号被字符串化后的解析（如 PAB-CN 的 `46102`）；`DD-MM-YY` 不歧义场景下 fallback 到 `MM-DD-YY`（`month > 12` 时）；`YYMMDD` 优先于 Excel 序列号识别。
- CSV 导入新增纯文本解析器 `parseCsvText`：所有值保持字符串、不过 `xlsx` 的类型推断，解决 20 位以上长数字（交易流水号）后几位被截断为 0 的问题；支持引号包裹 / 转义引号 / CRLF / LF / UTF-8 BOM。

### 变更

- 大账号对话框：`remember` 复选框在不固定模式下灰显而非隐藏；切换搜索关键字时重置选中索引；模式切换时清空搜索状态；初始化期间禁用交互；报错后保留对话框供用户重新设定。
- 新开账户模块的导出文件命名规则适配单 / 多账号场景。
- 新开账户余额账单的最晚日期改为「到昨天」。
- 全部账号 0 笔交易时直接报错 `没有账号存在交易数据`，不再进入大账号选择；修复 `identifyAccountBlocks` 空块 fallback 假块的问题。
- `MerchantId` 自动去除中间空格（如 `NRA 7101 2023 0223 63` → `NRA71012023022363`）。
- `Currency` 字段从映射对话框的多选拼接里排除，下拉不再出现 `需要拼接字段` 选项。
- `splitTemplateName` 修复多段 `-` 时的所在地取值：`BNI-ID-SG` 模板的 location 取第二段 `ID`，不再是 `ID-SG`。
- 修复 `rowsWithEmptyBlocks` 未持久化导致固定模式校验失败、空块 `sourceRowNumber` 回退值错误、元数据行被误当成数据行导出的问题。
- `xlsx` / `xls` 文件不受 CSV parser 改动影响，仍走 `XLSX` 库读取。

### 移除

- 移除映射对话框的日期格式下拉（`dateFormatSelect` 变量及 `saveMappings` 内 `dateFormat: dateFormatSelect.value` 一并删除）。

## 1.4.6

### 新增

- 新增「导入银行账号信息」入口：从 Excel 解析客资账号写入大账号表，自有账号写入独立 JSON 存储。
- 新增「余额管理」弹窗：按 `大账号 + 币种 + 日期 + 余额附加值 + 备注` 维护余额附加值；附加值会在余额导出时按 `MerchantId + Currency + BillDate` 累加注入到生成的余额账单。
- 新增 IPC channels：`bigAccount` 系列 + `balanceAdjustment` 系列。

### 变更

- 维护大账号弹窗的币种输入框小写自动转大写；多币种浮动面板溢出修复（`overflow-y: auto`）。
- 模板选择框启动时显示 `请选择模板` 占位符；未选模板时阻断导入操作；删除模板时清理相关缓存。
- 新开账户余额账单改为开户日到今天 **逐日生成**（上限 3650 天），不再只输出开户日和月末日。
- `维护大账号` / `账户映射` 等弹窗按钮新增文本溢出保护样式（`.primary-btn.small` 等）。

### 移除

- 无

## 1.4.5

### 新增

- 新开账户模块的多币种下拉新增固定搜索框，支持按币种代码、显示标签和中文名进行模糊匹配。
- 新增账号行现在会在 `银行账号` 文本右侧显示 `删除` 按钮，可直接删除当前行。

### 变更

- 新开账户模块中，`所在地` 输入框宽度缩窄为原来的三分之二，`币种` 列相应扩宽。
- 新开账户模块单币种下拉在未选择时改为空白占位，不再显示 `请选择币种`。
- 新开账户模块的多币种下拉在点击面板外空白处时会收起，并保留当前勾选结果与位序。

### 移除

- 无

## 1.4.4

### 新增

- 背景调色盘按钮右侧新增 `使用手册` 文本按钮，可将内置 `docs/USER_GUIDE.md` 另存为 `使用手册.md`。

### 变更

- 新开账户模块中的单币种输入改回下拉选择；勾选 `多币种账户` 后，币种控件会切换为带数字位序的多选下拉，并支持点击面板外空白处收起且保留已勾选结果。
- 新开账户模块在单币种切换到多币种时，会自动把原单一币种带入多选列表并标记为 `1.`；切回单币种时，会回填当前顺序中的第一个币种。
- 账户映射弹窗中的 `网银大账户ID` 文案统一改为 `网银大账号ID`，并同步更新相关校验报错文案。
- 账户映射弹窗中，`清结算系统大账号ID` 输入框宽度调整为与左侧输入框一致；其右侧新增 `删除` 文本按钮，`有账户号无币种` 勾选框移动到 `删除` 右侧。
- 版本迭代时需要固定同步更新的文档清单扩展为：`CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md`。

### 移除

- 无

## 1.4.1

### 新增

- 网银账单生成模块支持导入 `PDF` 文件，覆盖表格式 PDF、扫描版图片型 PDF 和多页跨页续表 PDF。
- 映射关系管理支持多选源字段，并在保存时弹出多选顺序确认弹窗。
- `MerchantId = 自己输入` 场景支持多行大账号 / 币种分配弹窗，并可通过 `固定` 保存当前分配顺序和值。
- 新开账户模块支持通过 `银行账号` 右侧的文本按钮 `新增` 继续追加完整账号行。

### 变更

- 当 `MerchantId` 为固定映射且不为 `自己输入` 时，`Currency` 现在允许为空，导出的明细和余额账单也会保留空币种值。
- 应用中的币种输入统一升级为“文字输入 + 全量下拉 + 虚影补全”交互。
- 新开账户模块在多账号场景下会将所有账号合并导出为 1 份 `NEW_BALANCE` 文件，文件名中的账号部分固定写为 `多账号`。
- 左上角 GIF 缩小为当前尺寸的一半。

### 移除

- 无

## 1.4.0

### 新增

- 无

### 变更

- 这是一次内部治理与结构重构版本；之前的主要功能、导出结果和前端 UI 保持不变。
- `scripts/smoke-test.js` 按能力拆分为多个 smoke 场景与公共支持模块，继续保留 `npm run smoke` 入口。
- `src/backend/file-service.js` 拆分为文件读取清洗、标准化、行映射与写出等后端子模块，对外 API 保持原样。
- `src/backend/database.js` 拆分为迁移、模板仓储和设置仓储等内部模块，`AppDatabase` 继续作为门面层对外提供原有方法。
- `src/main.js` 中的账单导入会话和导出聚合逻辑被提取到独立模块，主进程入口更聚焦于装配和流程协调。
- 渲染层中的弹窗工厂与 preview 逻辑拆到独立脚本中，界面布局、按钮位置、文案与交互顺序保持不变。

### 移除

- 无

## 1.3.5

### 新增

- 网银账单生成模块支持一次导入多个原始账单文件。
- 同一模板在当前软件打开期间已导入过 2 次及以上时，点击 `导出明细` / `导出余额` 会弹出“导出当前文件”或“导出所有”的选择框。

### 变更

- 混合币种账单不再因为 `Currency` 多值而无法生成余额账单；系统会按币种分别计算余额，再把所有币种结果整合到同一个余额文件、同一个 sheet 中导出。
- “导出当前文件”明确表示“当前这次导入批次”，“导出所有”明确表示“当前软件打开后该模板导入过的全部文件”；统计范围只按模板，不再按大账号 / 币种拆分。
- 导出所有时，多个大账号和多个币种会整合到同一个 COMMON / BALANCE 文件里，导出文件名不再带大账号。
- 主模块余额文件命名中的 `Balance` 统一改为 `BALANCE`。

### 移除

- 无

## 1.3.4

### 新增

- 无

### 变更

- 修复多大账号模式下，导出明细和余额文件中的 `MerchantId / Currency` 会严格使用本次选中的 `大账号 / 币种` 组合，不再把内部固定标记写进导出文件。
- 原始网银账单自动清洗增加表尾汇总区过滤，`总收入笔数 / 总收入金额 / 总支出笔数 / 总支出金额` 之后的汇总行不再进入明细和余额链路。
- 收紧日期兜底解析，`0 / 1 / 0.00` 这类值不再被错误标准化成日期；首次确实缺少上一账单日余额时，会重新触发补录提示。

### 移除

- 无

## 1.3.3

### 新增

- 无

### 变更

- 映射关系管理中，`MerchantId` 选择 `自己输入` 后改为直接由“维护大账号”接管 `MerchantId + Currency`；当只维护出 1 条 `大账号 / 币种` 组合时，导入时会自动直通，不再弹选择框。
- `Currency` 行全局移除 `自己输入` 选项；在 `MerchantId=自己输入` 模式下，`Currency` 行直接隐藏，最终值取自“维护大账号”里的币种配置。
- 映射关系管理保存失败时，系统会先弹出错误提示，确认后回到原编辑内容继续修改，不再丢失当前草稿。
- 收掉了 `MerchantId / Currency` “选择自己输入后必须填写内容”的旧强校验实现，并兼容历史上使用固定 `MerchantId / Currency` 的模板配置。

### 移除

- `Currency` 的“自己输入”能力。

## 1.3.2

### 新增

- 新增版本功能变更清单文档 `docs/VERSION_FEATURE_HISTORY.md`。

### 变更

- 模板管理弹窗中，`执行操作` 标题与行内按钮组重新做了左边界对齐，底部 `导入模板文件 / 导出模板文件` 调整为右对齐按钮组。
- 模板管理中的单固定大账号摘要改为直接显示完整账户号，超长时省略显示并支持原生 tooltip 查看完整值。
- “维护大账号”弹窗新增行内 `完成 / 修改 / 删除` 状态切换，并优化多币种摘要显示规则；`修改 / 删除` 按钮组与 `执行操作` 标题左边界对齐。
- “维护大账号”弹窗中的多币种下拉改为浮层式渲染，修复展开内容被遮挡的问题。
- “新开账户生成网银账单”模块中，`银行名称 / 所在地 / 币种 / 银行账号 / 开户日期` 五个字段标签整体向右微调一个汉字宽度。

### 移除

- 无

## 1.3.1

### 新增

- 启动失败时新增系统错误框提示，并将异常记录到 `app_activity_log.txt`。

### 变更

- 修复 `1.3.0` 老版本用户升级后可能无法启动的问题；数据库迁移改为先补齐 `template_key`，再创建唯一索引。
- 补充 smoke test，覆盖旧数据库迁移和启动失败兜底行为。

### 移除

- 无

## 1.3.0

### 新增

- 网银账单生成模块支持直接导入原始网银账单，并自动定位真实表头、清理前置脏数据行、左侧脏列和右侧空尾列。
- 映射关系管理新增 `按正负号拆分的发生额`。
- 模板管理页新增 `大账号` 列、`重命名`、`导入模板文件`、`导出模板文件`。
- 新增模板库同步文件 `文档/网银账单生成小助手/templates/template-library.json`。

### 变更

- `BillDate` / `ValueDate` 导入后会自动清理时分秒、补全年月日位数，并按统一日期格式导出。
- `MerchantId` 支持维护多个“大账号 + 币种”配置，并在导入时选择本次使用的组合。

### 移除

- 无

## 1.2.13

### 新增

- 无

### 变更

- 模板管理页面中，模板列表 `执行操作` 列的行内按钮文案恢复为 `修改`；主界面入口按钮仍保持为 `模板管理`。
- 同步刷新用户使用文档，使文档内容与 `1.2.13` 的界面和导出规则一致。

### 移除

- 无

## 1.2.12

### 新增

- 无

### 变更

- “新开账户生成网银账单”模块中，“多币种账户”文案的第二行“账户”调整为居中显示。

### 移除

- 无

## 1.2.11

### 新增

- 无

### 变更

- 统一 `Credit Amount` / `Debit Amount` 同时为 `0` 或空值时的过滤规则，这类记录会同时从明细账单和余额账单中过滤。
- 补充 smoke test，防止“明细已过滤但余额未过滤”的分叉行为再次出现。

### 移除

- 无

## 1.2.10

### 新增

- `Balance` 映射新增固定选项 `通过发生额计算`。
- 本地余额种子文件新增 `生成方式` 字段，用于区分 `账单里的余额`、`通过发生额计算` 和 `人工录入`。

### 变更

- 应用运行时所有面向用户的“模版”文案统一为“模板”。
- “新开账户生成网银账单”模块中，“多币种账户”复选框文案调整为上下两行显示。
- `app_activity_log.txt` 统一改为写入 `文档/网银账单生成小助手/`。

### 移除

- 无

## 1.2.9

### 新增

- 网银账单生成模块新增本地余额种子机制。
- 新增“因首次导入余额，请导入上一个账单日余额用于余额校验”提示状态；点击状态框可补录上一账单日日期和余额。
- 新增独立用户说明文档 `docs/USER_GUIDE.md`。

### 变更

- 余额种子文件按银行拆分保存在 `文档/网银账单生成小助手/balance-seeds/`，并支持重复录入确认覆盖。
- 当模板启用了 `Balance` 时，`MerchantId` 成为余额链路必填项。

### 移除

- 无

## 1.2.8

### 新增

- 映射关系弹窗底部新增“根据发生额做映射的户名 / 账户号”规则。
- 导出明细前新增 `Credit Amount` 与 `Debit Amount` 不能同时有值的强校验。
- 应用首次启动时会创建 `app_activity_log.txt` 记录关键操作与报错。

### 变更

- “映射关系设置”统一更名为“映射关系管理”。
- “新开账户生成网银账单”模块优化多币种下拉框宽度，开户日期默认显示为空白。
- 新生成余额账单命名规则调整为 `银行名称-所在地-银行账号-币种-NEW_BALANCE.xlsx`。
- 报错文件命名规则调整为 `YYYYMMDD-HHMMSS-模版名-错误步骤.txt`。

### 移除

- 无

## 1.2.7

### 新增

- 无

### 变更

- “新开账户生成网银账单”模块在多币种账户场景下，导出文件名中的币种段固定输出为 `多币种`。

### 移除

- 无

## 1.2.6

### 新增

- “新开账户生成网银账单”模块新增多币种账户模式，可从 `币种映射表.xlsx` 的 C 列多选币种并批量生成多行账单。

### 变更

- “新开账户生成网银账单”模块中的开户日期默认显示为空白。
- 调色盘面板尺寸调整为 `6.8cm * 6.8cm`，“导入背景文件”按钮改为单行显示。

### 移除

- 无

## 1.2.5

### 新增

- 新增 `npm run icon:sync` 图标同步脚本。

### 变更

- Windows 安装包、portable 可执行文件、桌面快捷方式和任务栏窗口图标统一改为自定义应用图标。

### 移除

- 无

## 1.2.4

### 新增

- 无

### 变更

- 修复余额账单在“同一账单日期存在多条余额记录”场景下的推导逻辑，优先按 `上一余额 + Credit Amount - Debit Amount` 匹配期末余额。

### 移除

- 无

## 1.2.3

### 新增

- 无

### 变更

- 明细账单导出时不再保留 `Balance` 列。

### 移除

- 从明细账单导出中移除 `Balance` 列。

## 1.2.2

### 新增

- `Currency` 映射新增“自己输入”。

### 变更

- 明细账单导出时保留 `Balance` 列但不再输出该列数据。
- 若 `Credit Amount` 与 `Debit Amount` 同时为 0 或空值，对应记录不会写入导出的明细账单，并会在状态提示和报错文件中说明。
- `Balance` 字段在导入转换时会像收支字段一样清洗，仅保留数字和 `.` 后按数值参与余额账单计算。
- “新开账户生成网银账单”模块的导出文件命名规则调整为 `银行名称-所在地-银行账号-币种-新开银行账户余额录入-最早日期~最晚日期.xlsx`。

### 移除

- 无

## 1.2.1

### 新增

- 内置 `assets/币种映射表.xlsx`，用于非英文币种自动替换。

### 变更

- 网银账单生成模块主界面按钮文案调整为“模版管理”。
- `Credit Amount` / `Debit Amount` 导出前会清洗为仅保留数字和 `.`，并按数值格式写出。
- `Currency` 若不是纯英文，会模糊匹配映射表 A/B 列并替换为 C 列英文简称；匹配失败时保留原值导出并生成报错文件。

### 移除

- 无

## 1.2.0

### 新增

- 新增“新开账户生成网银账单”模块。
- 所有用户侧报错统一生成详细报错文件，状态框在有报错时支持点击导出。

### 变更

- 明细导出文件命名规则调整为 `模版名-COMMON-最早账单日期~最晚账单日期.xlsx`。
- 映射关系设置允许多个模版字段指向同一映射字段。
- `Channel` 从映射弹窗移除并改为固定取模版名称 `-` 前的值。
- `MerchantId` 新增“自己输入”模式并贯穿明细、余额及相关取值链路。
- 微调“新开账户生成网银账单”模块底部布局。

### 移除

- 从映射弹窗中移除 `Channel` 的手动映射项。

## 1.1.1

### 新增

- 无

### 变更

- 余额账单模板固定读取 `assets/余额账单模版.xlsx` 当前版本，不再回退到其他路径。
- 明细账单导出改为始终输出完整模版字段；未映射或源值为空时，字段保留且单元格留空。
- 余额账单导出改为按余额模板第一行字段动态补齐列，模板第二行及之后的旧示例数据会在写入前清空。
- 更新 smoke test，覆盖“未映射字段仍保留空列”和“余额模板额外字段保留空列”的导出场景。

### 移除

- 移除余额模板的路径回退逻辑。

## 1.1.0

### 新增

- 将 `COMMON枚举.xlsx` 作为应用内置资源随安装包分发，启动后自动加载。

### 变更

- 状态框改为展示内置枚举加载状态，不再承担枚举表导入入口。
- 更新运行说明与打包配置，移除 `init:enum` 启动前置步骤。
- 调整 smoke test，改为校验内置 `COMMON枚举.xlsx`。

### 移除

- 移除首次导入枚举表的运行依赖。
- 移除 `init:enum` 启动前置流程。

## 1.0.9

### 新增

- 无

### 变更

- 固定导出格式：`Credit Amount`、`Debit Amount` 输出为数字格式。
- 固定导出格式：`BillDate`、`ValueDate` 输出为日期格式。
- 固定导出格式：`MerchantId`、`Channel` 输出为文本格式。

### 移除

- 无

## 1.0.8

### 新增

- 新增账户映射弹窗预览图脚本。

### 变更

- 将“管理模版”和“账户映射”按钮调整为横向并排居中显示。

### 移除

- 无

## 1.0.7

### 新增

- 新增“账户映射”按钮和账户映射弹窗。
- 新增网银大账户ID校验规则。

### 变更

- 导出时若模板映射字段中存在 `MerchantId`，会按账户映射表把对应单元格值替换为清结算系统大账户ID。

### 移除

- 无

## 1.0.6

### 新增

- 无

### 变更

- 左上角 GIF 调整为距上方和左侧各 `0.5cm`，尺寸改为 `1.5cm * 1.5cm`。

### 移除

- 无

## 1.0.5

### 新增

- 无

### 变更

- 主标题字栈调整为以 `OpenAI Sans` 为首选、中文无衬线字体为回退。

### 移除

- 无

## 1.0.4

### 新增

- 无

### 变更

- 继续放大主标题“网银账单小助手”字号。

### 移除

- 无

## 1.0.3

### 新增

- 无

### 变更

- 主标题文案调整为“网银账单小助手”，并进一步增大字号。
- 左上角 GIF 调整为距上方和左侧各 `1cm`，尺寸改为 `2cm * 2cm`。

### 移除

- 无

## 1.0.2

### 新增

- 新增左上角固定循环 GIF 展示。
- 新增界面预览图生成脚本。

### 变更

- 主页面标题更新为“网银账单生成小助手”，字体调整为微软雅黑 Light 加粗并增加字间距。
- 管理模版弹窗移除标题文本，仅保留关闭按钮。
- 枚举表改为首次运行后由用户导入并持久化。
- 状态框首屏提示“请导入网银账单枚举表”，并支持点击状态框导入或覆盖枚举表。
- 仅允许导入文件名带有“枚举”的 `.xlsx` 作为枚举表，空文件或不可读文件会在状态框提示。
- 右下角版本文案改为 `Version`，字体调整为 `Courier New`。

### 移除

- 移除管理模版弹窗标题文本。
- 移除根目录静态读取枚举表的逻辑。

## 1.0.1

### 新增

- 新增 Windows `portable` 免安装打包目标。
- 新增 `npm run dist:win:portable` 和 `npm run dist:win:setup` 脚本。

### 变更

- `npm run dist:win` 默认同时生成安装版和免安装版。
- GitHub Actions 同时上传 `windows-installer` 和 `windows-portable-exe`。
- 为 Windows 主进程补充 `AppUserModelId` 设置。

### 移除

- 无

## 1.0.0

### 新增

- 初始化 Electron 桌面端应用骨架，支持 Windows 10 / 11。
- 实现自定义窗口栏、拖拽窗口、最小化 / 最大化 / 关闭。
- 实现模版导入、模版列表管理、映射关系设置与删除确认。
- 实现基于 SQLite 的模版和映射关系持久化。
- 实现 Excel / CSV 导入校验、COMMON 枚举加载、账单转换和 Excel 导出。
- 实现按日期生成输出目录与日志文件。
- 在页面右下角显示应用版本号。
- 补充版本迭代说明和版本回溯文档。

### 变更

- 无

### 移除

- 无
