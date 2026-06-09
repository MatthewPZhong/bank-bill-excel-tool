# PRD - 网银账单小助手 v3.0.0

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.0 |
| 日期 | 2026-06-08 |
| 作者 | PM |
| 状态 | 初稿（待评审） |
| 模块 | 资金对账数据处理（bank-statement-process）、链接表管理（linked-table） |
| 依赖 | 已合并 PR#65（基线 commit `cf7edec`，含 ADM 重建双触发 + 退款 session 生命周期收紧）；本迭代分支从 `main`（含 v2.1.16-beta.6 全部内容） |
| 风险等级 | 🔴 高（含资金红线：C3/退款"数据就绪"判据写反致**静默漏对账**；链接表整表覆盖落库 + ADM 派生 OOM；Runtime-state `bankStatementSession`/`gatewayReconSession`/`refundOrderSession`） |

---

## 一、需求概述

本迭代分四大块，共 7 项需求：

**块 A — 资金对账模块弹框/状态框治理（需求 1/2a/2b/3）**

1. **需求 1：状态框「渠道-地区」前缀** —— 导入银行对账单后，状态框文件名前加「渠道-地区」前缀（唯一组合 `CITI-HK:文件名`；多组合全列出 `CITI-HK、JPM-US:文件名`），让用户一眼看出对账单属于哪个银行哪个地区。
2. **需求 2a：去明细确认框 + 失败信息并入状态框** —— 去掉导入后那个与状态框信息重合的明细确认框，把失败/跳过信息并入状态框。
3. **需求 2b：C3 提醒改向链接表网关对账单** —— C3（网关核销）取数 v2.1.16-beta.2 已切到链接表 `gateway-bill`，但导入后/运行点的两处提醒仍引导导入"资金对账不平结果表"（落 `gatewayReconSession` 死数据，引擎不消费），用户照做仍对不上账、且可能**静默漏对账**。改为提醒导入链接表网关对账单，"导入文件"调起链接表导入对话框。
4. **需求 3：退款回填提醒对齐 C3 + 候选预检 + 运行点提醒** —— 退款回填提醒样式与 C3 不统一、缺运行点提醒。统一为：导入框两按钮「导入文件 / 稍后再说」+ 运行点三选一框「导入文件 / 直接运行 / 取消」；新增退款候选预检（本批无 `FundType=Ach Return` 行则不提醒）；运行点链式编排（退款先于 C3 但互不吞）。

**块 B — 链接表大文件流式导入**

5. **块 B：链接表大文件流式导入** —— 用户导入 65.7 万行渠道账单（147MB）报"文件为空或不可读"。根因是 SheetJS 全量读 OOM 被误 catch 成 read-error。复用项目现成流式引擎 `readXlsxStreamed`（实测 12.4s / 385MB 读出 657,758 行）改造表头识别 + 落库链路。

> **块 B 性质**：🔴 资金红线 + 数据红线（链接表整表覆盖 + ADM 派生）。其 OPEN（O-1~O-6）用户 2026-06-08 已**按推荐采纳**（O-2 值口径 diff 为实施硬前提），建议块 B 作为独立 PR 组实施。

**块 C — R5 场景3 Credit/Debit 方向匹配（资金红线修复）**

6. **R5 场景3 Credit/Debit 方向匹配** —— R5 场景3「中台加款单脏数据处理」引擎 `r5-platform-inbound-cleanup.js:99` 在同 ReconciliationId 多候选时**无脑取 `cand[0]`、不看金额方向**，同 reconid 一 Credit 一 Debit 时结果不可控（可能选错行 → 剔除清单错位 → 导出错误财务清单）。改为**多候选时取 `Credit Amount` 有值的行**；0 行或 ≥2 行 Credit 有值则跳过 + 收集警告（不阻断导出）。

> **块 C 性质**：🔴 资金红线（剔除清单错位）。OPEN（O-1~O-6）用户 2026-06-08 已逐条拍板（见 `changes/r5s3-credit-debit-direction-match/spec.md`），作 **PR-6** 纳入本迭代。

**块 D — 场景管理批量操作 CSS 偏移修复（纯前端 UX）**

7. **场景管理批量操作勾选列致表格大面积偏移** —— 「场景管理」弹框点「批量操作」进入批量模式、勾选列出现后，整张表格列宽错位、大面积横向偏移；退出批量模式恢复。根因是表格 `table-layout:fixed` + 其余列百分比总和已≈100%，新增勾选列用**固定 32px**且显示时未让出列宽，px+% 叠加溢出容器 ≈2.8% → 全列等比压缩错位。修复=勾选列百分比化（~3%）+ 其余列按比例补偿保持总和=100% + 清理 `styles-gemini-extra.css` 重复 `.scenarios-col-name` 定义。

> **块 D 性质**：纯前端 UX / 表格列布局，**不碰资金计算**。属 **pre-existing**（勾选列由 v2.1.9 commit `2df26f6` 引入，非 v3.0.0），作 **PR-7** 纳入本迭代（见 §5.8 + `changes/scenario-batch-css-offset/spec.md`）。

---

## 二、背景与目标

### 2.1 背景

「资金对账数据处理」模块近期把多条数据源切到了链接表（C3 网关行在 v2.1.16-beta.2 T1 切到 `linked_gateway_bill`），但导入后的状态框/确认框/提醒链路没同步治理，逐项问题如下：

| 来源 | 当前问题 | 业务/用户价值 |
|------|---------|--------------|
| 需求 1 | 状态框只显示文件名 + 行数，看不出对账单属于哪个银行哪个地区 | 多渠道/多地区混合作业时无法快速识别数据归属 |
| 需求 2a | 导入后弹一个明细确认框，与状态框信息重合；且失败/跳过信息只在该框里、被关掉就没了 | 减少冗余弹框打扰；失败/跳过信息沉淀到常驻状态框 |
| 需求 2b | C3 取数已切链接表，提醒仍引导导入"资金不平表"（死数据）；🔴 用户照做后链接表 `gateway-bill` 实际为空 → C3 网关 join **静默 no-op、不报错** → **以为对了账，实际 C3 没做** | 堵住"静默漏对账"资金风险；把用户引向有效操作 |
| 需求 3 | 退款回填提醒是单按钮样式、与 C3 不统一；缺运行点提醒；无候选预检（本批没有退款行也会弹） | 提醒体验对齐 C3；减少无候选时的误打扰；运行点兜底防漏跑退款 |
| 块 B | 65.7 万行真实数据被误报"文件为空" → 用户无法导入大文件渠道账单 | 解锁大文件链接表导入（项目已有验证过的流式范式可复用） |

### 2.2 目标

- **需求 1**：状态框前缀 = 银行对账单数据 `Channel`（第 15 列）+ `地区`（第 16 列）去重组合；唯一组合显示 `CITI-HK:文件名`，多组合全列出 `CITI-HK、JPM-US:文件名`；多文件合并按合并全集计算。
- **需求 2a**：删除导入后明细确认框；失败/跳过信息以**纯文本**并入状态框（含纯失败批次也要渲染）。
- **需求 2b**：两处提醒的「数据就绪判据」从 `gatewayReconSession` 改向链接表 `gateway-bill` 行数；"导入文件"按钮改调链接表导入对话框 `linkedTable.import()`；判据严格 `>0`，IPC 异常按"未就绪"保守处理（防漏对账）。
- **需求 3**：退款导入提醒/运行点提醒对齐 C3 框结构；新增候选预检（`FundType=Ach Return` 计数）；运行点链式编排（退款"直接运行"只跳退款、C3 仍单独提醒）。
- **块 B**：复用 `readXlsxStreamed`，让 detector 表头识别 + 落库链路流式化，65.7 万行可成功导入；值口径与 SheetJS 逐格一致（OPEN 待拍板后实施）。

### 2.3 明确不做

- **不删** `gatewayReconSession` / `gateway-recon:import` 死链（需求 2b 仅改提醒方向，死链清理另案，避免一次动太多 Runtime-state）。详见 §五 2b O-2(a)。
- **不改** C3 对账计算本身（仍用链接表 `gateway-bill`）、不改 ReconID 修复链路（`reconIdFixSession`，独立链路）。
- **不改** `createConfirmDialog`（renderer-dialogs.js:341，复用其两按钮/三按钮能力）。
- ~~**不做** R5-S3 Credit/Debit 方向匹配（用户拍板「继续放着」）~~ → **已反转**：用户 2026-06-08 拍板 O-1 ~ O-6，**纳入本迭代作 PR-6**（见 §5.7 + `changes/r5s3-credit-debit-direction-match/`）。
- **文档三件套**（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）本迭代节奏内不强制更新，留待 3.0.0 转正统一更新（沿用 beta 惯例）。

---

## 三、代码现状（必须有出处）

> 行号基线 = commit `cf7edec`（PR#65 已 merge）。`src/main.js` 含 NUL 字节，grep 须加 `-a`。

| 需求 | 相关文件 | 当前行为 | 已知限制 |
|------|---------|---------|---------|
| 需求 1 | `renderer.js:3398-3400` | 状态框文本拼接：`已导入：${bs.fileName}（${bs.rowCount} 行）`，多文件合并显示「N 个文件合并（M 行）」 | 无渠道/地区前缀 |
| 需求 1 | `renderer.js:584` `updateStatusBox` | 状态框文案入口；对**全角「：」**（U+FF1A）后强制换行，半角 `:` 不动 | 前缀若用全角冒号会触发非预期换行（须用半角 `:`） |
| 需求 1 | `main.js:3839` `bank-statement:session-status` | 透出 `hasBankStatement` / `bankStatementFileName` / `bankStatementRowCount` / `bankStatementSourceFileCount` 等 | 未透出渠道-地区组合，前端无数据可拼前缀 |
| 需求 1 | `src/backend/database/channel-enum-repository.js:54` `recordFromBankStatementRows` | 已有从银行对账单行提取 `Channel-地区` 的拼接口径（Channel 空跳过；地区空只产出 `Channel`，不生成 `JPM-` 脏值） | 该口径耦合在"写枚举"逻辑里，需抽纯函数复用 |
| 需求 2a | `renderer.js:3534` `handleBankStatementBatchImport` | 批量导入成功后弹明细确认框 `createAlertDialog(buildBatchImportSummaryHtml(...))`；其 onConfirm 里触发"退款优先互斥提醒" | 明细框与状态框信息重合；失败/跳过信息仅在该框、关掉即丢；纯失败批次（无 bank ok）路径不刷新状态框 |
| 需求 2a | `renderer.js:3364` `updateBankStatementUi` | 渲染状态框主文案 + tone | 未承载失败/跳过摘要 |
| 需求 2b | `main.js:3606` C3 取数 | `const workingGwRows = structuredClone(database.readLinkedTableRows('gateway-bill'))`；无数据返回 `[]`，下游各轮自然 no-op | 数据源已切链接表，但提醒未跟着改向 |
| 需求 2b | `renderer.js:3589` `maybePromptGatewayReconImport` | 导入后 C3 提醒；判据 `if (state.gatewayReconSession) return`；"导入文件" onConfirm 调死链 `handleBankStatementImportGatewayRecon`（`gateway-recon:import`，只落 `gatewayReconSession` 不写链接表）；保留 `c3CandidateCount` 预检 | 判据看的是"导没导资金不平表"（死数据），引导动作落死链 → 🔴 静默漏对账 |
| 需求 2b | `renderer.js:3712` `shouldPromptGatewayReconAtRun` | 运行点提醒判据，同样 `if (state.gatewayReconSession) return false` + `c3CandidateCount` 预检 | 同上 |
| 需求 2b | `renderer.js:3683-3702`（在 `handleBankStatementRun` 内，函数起点 :3675） | 运行点 C3 三选一框（导入/直接运行/取消），onConfirm 调死链 | 同上 |
| 需求 2b | `main.js:3856` `bank-statement:c3-candidate-count` | 统计本批银行侧 C3 候选行数（只读查询） | 与网关数据源无关，仍有效，保留 |
| 需求 3 | `renderer.js:3611` `maybePromptRefundOrderImport(results)` | 导入后退款提醒；判据 = 启用退款场景（按 `name==='中台退款订单回填'`）+ 本批未识别退款表（`results` 无 `tableKey==='zhongtai-refund-order'` 且 `status==='ok'`）；**现用 `createAlertDialog` 单按钮**（仅提示"请补充导入后再运行"，无导入入口） | ① 样式与 C3 不统一（单按钮 vs 两/三按钮）；② **无候选预检**（本批没有 Ach Return 行也会弹）；③ **无运行点提醒**（用户跳过导入框后运行不会再提醒） |
| 需求 3 | `src/main-process/scenario-engines/r5-refund-order-backfill.js:6`（业务语义注释） | 退款参与对账条件：银行 `FundType=Ach Return`（且未被 R4 改写） ↔ 退款 `状态=SUBMITTED` | 退款候选预检的判据依据（`FundType==='Ach Return'`） |
| 需求 3 | `main.js:295` `let refundOrderSession = null` | 退款 session（`{ fileName, rows, importedAt }`）；beta.6 需求 C 已开通，批量识别到退款表时落 session；run 注入 `refundContext.refundOrderRows`；为 null 时注入 `[]` no-op | session-status **未透出 `hasRefundOrder`**，前端运行点无就绪信号可判 |
| 需求 3 | `renderer.js:3675` `handleBankStatementRun` | 运行入口；现仅做 C3 运行点提醒（`shouldPromptGatewayReconAtRun` → 三选一框）→ `runBankStatementInternal()` | 无退款运行点提醒；无退款→C3 链式编排 |
| 需求 3 | `renderer-dialogs.js:341` `createConfirmDialog` | 支持 `{ message, confirmText, cancelText, onConfirm, onCancel, middleText, onMiddle }`；`middleText` 存在则渲染三按钮 | 现成可复用，无需改造 |
| 块 B | `main.js:11151` `linked-table:import` handler | 多选 Excel → `detectTableType` 识别 → `readLinkedRowsAsObjects` 全量读 → 裁列 → `replaceLinkedTable` 整表覆盖 | 全量读 65.7 万行 OOM |
| 块 B | `main.js:11222` `readLinkedRowsAsObjects(filePath, signature, sheetName)` | SheetJS 全量读 → 对象数组（detector L1/L2 + expectedHeaders zip 校验） | 🔴 OOM 瓶颈点（读侧） |
| 块 B | `src/backend/file-service/readers.js:111`（dense）/ `:367`（listSheetNames） | `XLSX.readFile` 全量读进内存 | 1.72GB sheet / 2900 万单元格撞 V8 字符串/堆上限 |
| 块 B | `src/main-process/table-type-detector.js:208/221/244` | 异常 catch 后统一返回 `status:'read-error'` | OOM 异常被吞成 read-error |
| 块 B | `main.js:11184` | read-error 时硬编码报"文件为空或不可读" | 🔴 误报（文件实际不空） |
| 块 B | `src/backend/database/linked-table-repository.js:187` `replaceLinkedTable` | 已是"事务内 DELETE 全表 + 逐行 prepared INSERT + 边插边算日期范围 + upsert meta" | 天然流式友好，但只吃完整数组（需加流式接口） |
| 块 B | `main.js:11244-11259`（ADM 重建） | bank-deposit **或** mid-allocation 任一变更都触发 ADM 全量重建（两表全量 `readLinkedTableRows` 读回内存 + `buildAdmRows` + `replaceAdmBankDeposit` + 清 `reconIdFixResult`） | 🔴 块 B 流式落库后，两条路径都会触发 ADM 全量重建 → 次生 OOM |
| 块 B | `src/backend/pending-import/streaming-xlsx-reader.js` `readXlsxStreamed` | JSZip + nodeStream + StringDecoder 增量解码，逐行回调 `onRow(rowArray, rowIdx)`，内存恒定；导出 `parseRowXml/parseCellBody/readSharedStrings/lettersToIndex` 原语 | 硬编码只读 `sheet1.xml`（detector 现扫所有 sheet，需确认链接表单 sheet 约定或补多 sheet 支持） |
| 块 B | `src/backend/database.js` `getLinkedTableMeta(key)` | 查单行 `linked_table_meta`（含 `rowCount`，不读全表） | 需求 2b 与块 B 共用：轻量查行数 |
| 块 B | `src/preload.js:382` `linkedTable` | 暴露 `linkedTable.list()` / `linkedTable.import()` | 需求 2b 需补 `linkedTable.rowCount(key)` |
| 块 D | `src/styles.css:2825-2828` `.scenarios-table` | `table-layout: fixed; width: 100%` | fixed 布局下固定 px 列 + 百分比列混用会溢出 |
| 块 D | `renderer-dialogs.js:6468`（th）/ `:6560`（td） | 勾选列 `scenarios-col-checkbox` 内联 `width: 32px`（th 默认 `display:none`） | 固定 px，显示时未让出列宽 |
| 块 D | `renderer-dialogs.js:6575-6593` `setBatchMode` | 切换勾选列 th/td 的 `display`（同步无错位） | **无列宽重算** → 32px + 百分比≈100% 溢出 ≈2.8% → 全列错位 |
| 块 D | `styles.css:2843/2862/2868(!important)/2876/2882/2904` | 其余列百分比：id 5%/category 22%/name 30.94%`!important`/priority 10%/actions 19.06%/enabled 13%（非 compact 累加=100%） | 与勾选列 32px 叠加溢出 |
| 块 D | `styles-gemini-extra.css:2251` / `:2265` | `.scenarios-col-name` **重复定义两次**（`30.94% !important` vs `27.96%`，取值冲突） | name 列宽口径混乱（`renderer-dialogs.js:6425-6427` 注释自承 th 内联失效） |

---

## 四、术语

| 术语 | 含义 |
|------|------|
| C3 | 场景类别 `gateway-recon-join`（网关对账单赋值银行对账单 / 网关核销），`scenario-engines/index.js:27` |
| 链接表 `gateway-bill` | 网关对账单链接表（`linked_gateway_bill`），C3 网关行的真实数据源（v2.1.16-beta.2 起） |
| `gatewayReconSession` | 旧"资金对账不平结果表"导入 session（`main.js:267`）；已是**死路径**（无引擎消费数据，仅 UI 状态/提醒门控） |
| `refundOrderSession` | 中台退款订单导入 session（`main.js:295`）；beta.6 已开通，run 注入真实退款行 |
| `bankStatementSession` | 资金对账银行对账单进程级 session（`main.js:266`）；含合并多文件 rows，`_rowId` 全局唯一 |
| 退款候选行 | 银行对账单中 `FundType==='Ach Return'` 的行（退款回填参与对账的银行侧条件，`r5-refund-order-backfill.js:6`） |
| C3 候选行 | 本批银行对账单中满足"已启用 C3 场景银行条件"的行（`countC3BankCandidates`，`main.js:3856`） |
| ADM 重建 | bank-deposit / mid-allocation 任一变更后，重算 Channel=ADM 的派生链接表（`buildAdmRows` → `replaceAdmBankDeposit`），并清 `reconIdFixResult`（`main.js:11244-11259`） |
| 渠道-地区组合 | `Channel`（第 15 列）+ `地区`（第 16 列）拼成 `CITI-HK` 形态；Channel 空跳过、地区空只产出 `Channel` |
| `readXlsxStreamed` | 项目现成流式 xlsx 读引擎（`streaming-xlsx-reader.js`），逐行回调、内存恒定 |
| OOM | Out Of Memory，V8 堆/字符串长度上限溢出 |

---

## 五、功能详细描述

### 5.1 需求 1：状态框「渠道-地区」前缀

#### 5.1.1 说明

- **输入**：`bankStatementSession.rows`（合并全集）的 `Channel`（第 15 列）+ `地区`（第 16 列）。
- **输出**：状态框文件名前缀。
  - 0 个组合（无 Channel）→ 无前缀，兜底原文案。
  - 1 个组合 → `CITI-HK:文件名（M 行）`。
  - 多个组合 → `CITI-HK、JPM-US:文件名（M 行）`（全列出，组合间用顿号 `、`，去重 + 稳定排序）。
- **边界条件**：
  - Channel 空 → 跳过该行（不产出组合）。
  - 地区空 → 只产出 `Channel`（不生成 `CITI-` 这种带短横的脏值）。
  - 多文件合并 → rows 是合并全集，组合按全集去重。
  - 🔴 **换行陷阱**：前缀用**半角 `:`**、组合间用 `、`，避开 `updateStatusBox`（renderer.js:584）对全角「：」的自动换行。

#### 5.1.2 影响范围

- 前端：`renderer.js`（state 接 `channelRegions` + 拼前缀）。
- 后端：`main.js`（session-status 增字段）+ `channel-enum-repository.js`（抽纯函数）+ `database.js`（facade 透传）。
- 数据库：无。
- 对外接口影响：`bank-statement:session-status` 出参新增 `bankStatementChannelRegions: string[]`（增量，向下兼容）。
- 兼容性影响：无（纯展示增强）。

#### 5.1.3 UI Mockup

```
现状：
  已导入：渠道账单_2026-06-08.xlsx（657758 行）

需求 1 后（唯一组合）：
  CITI-HK:渠道账单_2026-06-08.xlsx（657758 行）

需求 1 后（多组合）：
  CITI-HK、JPM-US:渠道账单_2026-06-08.xlsx（657758 行）

需求 1 后（多文件合并 + 多组合）：
  CITI-HK、JPM-US:3 个文件合并（657758 行）
```

---

### 5.2 需求 2a：去明细框 + 失败信息并入状态框

#### 5.2.1 说明

- **输入**：`handleBankStatementBatchImport` 拿到的 `results`（per-file 批量明细）。
- **输出**：
  - 删除导入后明细确认框。
  - 失败/跳过信息以**纯文本**并入状态框（状态框是 `textContent`，不能用 HTML）。
- **边界条件**：
  - 原明细框 onConfirm 里的"退款优先互斥触发"副作用须**迁移**到 `handleBankStatementBatchImport` 成功路径末尾（状态框刷新后再弹提醒），否则去框即丢副作用。
  - 🔴 **纯失败批次**（无任何 bank ok）：现路径才刷新状态框，去框后须新增分支——无 bank ok 也渲染 issues（但不改 mode、不清 export）。
  - **清除时机**：进入新动作（开头/run/export/导网关成功）须清旧 issues，避免上一批失败摘要残留。

#### 5.2.2 影响范围

- 前端：`renderer.js`（删明细框调用、抽 `buildImportIssuesSummary` 纯函数、新增 state `bankStatementImportIssues`、`updateBankStatementUi` 追加摘要、迁移退款触发副作用）。
- 后端：无。
- 数据库：无。
- 对外接口影响：无。
- 兼容性影响：`buildBatchImportSummaryHtml` 删调用后变 dead code，本迭代**保留**（避免牵连）；`escapeHtml` 保留（多处用）。

#### 5.2.3 UI Mockup

```
状态框（含跳过 + 失败）：
  CITI-HK:渠道账单.xlsx（120 行）
  跳过 2 个：未识别表头的文件A、文件B
  失败 1 个：文件C（读取失败：...）        ← failed.length>0 时 tone 升 error
```

---

### 5.3 需求 2b：C3 提醒改向链接表网关对账单

#### 5.3.1 说明

- **输入**：链接表 `gateway-bill` 的 `rowCount`（经新 IPC `linked-table:row-count` → `getLinkedTableMeta('gateway-bill').rowCount`，单行 meta 不读全表）+ 现有 `c3CandidateCount`。
- **输出**：
  - 数据就绪判据：从 `state.gatewayReconSession` 门控 → 改查 `gateway-bill rowCount>0 则不提醒`。**严格 `>0`**；IPC 异常按"未就绪"（保守多提醒，防漏对账）。`c3CandidateCount` 预检保留。
  - C3 框结构不变（导入框两按钮 / 运行点三选一）；文案改"请在链接表管理导入网关对账单"。
  - "导入文件"按钮 onConfirm 改调 `window.desktopApi.linkedTable.import()`（不再调死链 `handleBankStatementImportGatewayRecon`）。
- **边界条件**：
  - 🔴 判据**严格 `>0`**：链接表空才提醒；`>0` 不提醒。判据写反 = 静默漏对账。
  - IPC 异常 → 按"未就绪"处理（宁可多提醒，不可漏对账）。
  - `gatewayReconSession` / `gateway-recon:import` 死链本迭代**不删**（O-2(a)）。

#### 5.3.2 影响范围

- 前端：`renderer.js`（`maybePromptGatewayReconImport` :3589 / `shouldPromptGatewayReconAtRun` :3712 判据 + onConfirm + 文案）。
- 后端：`main.js`（新 IPC `linked-table:row-count`，仿 `linked-table:list` :11139）。
- preload：`preload.js`（暴露 `linkedTable.rowCount(key)`）。
- 数据库：无（复用 `getLinkedTableMeta`）。
- 对外接口影响：新增 IPC `linked-table:row-count`（增量）。
- 兼容性影响：无。

#### 5.3.3 UI Mockup

```
导入后 C3 提醒（两按钮，文案改向链接表）：
  ┌─────────────────────────────────────────┐
  │  ⚠ 已启用「资金对账不平」类场景，         │
  │     C3 需要网关对账单。                    │
  │     请在「链接表管理」导入网关对账单。     │
  │                                           │
  │     [导入文件]        [稍后再说]          │
  └─────────────────────────────────────────┘
       │
       └─ 导入文件 → linkedTable.import()（链接表导入对话框）

运行点 C3 提醒（三选一，保留）：
  [导入文件]   [直接运行]   [取消]
```

---

### 5.4 需求 3：退款回填提醒对齐 C3 + 候选预检 + 运行点提醒

#### 5.4.1 说明

- **输入**：本批 `results` + 退款候选数（新 IPC `bank-statement:refund-candidate-count` = 数 `normalizeCellValue(FundType)==='Ach Return'`）+ `refundOrderSession` 就绪信号（经 session-status 新增 `hasRefundOrder` 透出）。
- **输出**：
  - **导入后提醒**（`maybePromptRefundOrderImport` :3611）：`createAlertDialog` 单按钮 → `createConfirmDialog`（导入文件 / 稍后再说，对齐 C3）；判据加候选预检门控（候选=0 不弹）；"导入文件"→ `closeModal()` + `handleBankStatementBatchImport()`（调起《导入对账单》批量导入，不续跑）。
  - **运行点提醒**（新 `shouldPromptRefundAtRun()`，仿 `shouldPromptGatewayReconAtRun`）：退款场景 enabled + 未导退款表（`!hasRefundOrder`）+ 退款候选>0 → 运行点弹三选一框。
  - **运行点编排（链式）**：退款先于 C3 但互不吞——退款"直接运行"只跳退款、继续查 C3。
- **边界条件**：
  - 🔴 候选预检：本批无 `Ach Return` 候选 → 不弹（导入框 + 运行点都不弹）。
  - 🔴 就绪判据：`hasRefundOrder` 来自 `refundOrderSession!==null`（PR#65 已收紧其生命周期：单文件导入清 `main.js:3492`、batch 本批未导退款表则清 `:11422` → 严格绑定"本批有效导入"，判就绪可靠）。
  - 导入后互斥（退款优先于 C3）保持。

#### 5.4.2 影响范围

- 前端：`renderer.js`（`maybePromptRefundOrderImport` 改框 + 加预检；新增 `shouldPromptRefundAtRun`；改 `handleBankStatementRun` 编排；抽出 `proceedToGwCheck`）。
- 后端：`main.js`（新 IPC `bank-statement:refund-candidate-count`，仿 c3-candidate-count :3856；session-status :3839 增 `hasRefundOrder`；抽 `countRefundBankCandidates`）。
- preload：暴露 `bankStatement.refundCandidateCount()`。
- 数据库：无。
- 对外接口影响：新增 IPC `bank-statement:refund-candidate-count`；`session-status` 增 `hasRefundOrder`（增量）。
- 兼容性影响：无。

#### 5.4.3 UI Mockup + 运行点编排流

```
导入后退款提醒（两按钮，对齐 C3）：
  ┌─────────────────────────────────────────┐
  │  ⚠ 已启用「中台退款订单回填」场景，       │
  │     但本次未导入「中台退款订单表」。       │
  │                                           │
  │     [导入文件]        [稍后再说]          │
  └─────────────────────────────────────────┘
       └─ 导入文件 → handleBankStatementBatchImport()（《导入对账单》批量导入，不续跑）

运行点编排（退款先于 C3，互不吞）：
  handleBankStatementRun():
    if shouldPromptRefundAtRun():
        弹退款三选一框:
          导入文件 → handleBankStatementBatchImport()   // 不续跑
          直接运行 → proceedToGwCheck()                 // ★只跳退款，继续查 C3
          取消     → return
        return
    proceedToGwCheck()

  proceedToGwCheck():   // 承载原 C3 dialog#2 逻辑（2b 改造后）
    if shouldPromptGatewayReconAtRun():
        弹 C3 三选一框:
          导入文件 → linkedTable.import()               // 不续跑
          直接运行 → runBankStatementInternal()
          取消     → return
        return
    runBankStatementInternal()
```

---

### 5.5 块 B：链接表大文件流式导入

#### 5.5.1 说明

> **前置：spec① `linked_mid_allocation` 列名迁移（business_date → transaction_date）**
>
> 块 B 流式落库 mid-allocation 依赖列名对齐。当前 committed schema 的日期列已是 `transaction_date`（`migrations.js:2690` 建表 / `linked-table-repository.js:74`、`:200` `dateColumn`），但**跑过中间 beta 构建并导入过中台调拨订单表**的机器（开发机 + 部分 beta 测试者）本地 DB 残留旧列名 `business_date`（`CREATE TABLE IF NOT EXISTS` 不迁移已存在表，`migrations.js:2654/2687` 自述「幂等 no-op」），导致 INSERT 报错 `table linked_mid_allocation has no column named transaction_date`、整文件导入失败（成功 0 失败 1）。
>
> **`main` 线上从未发布过 `business_date` → 正式版用户不受影响**；仅受影响者为上述中间 beta 构建机器。块 B 流式落库链路同样依赖 `transaction_date` 列存在，否则大文件 mid-allocation 落库也会撞同一报错。故 **块 B 实施第一步先做一段幂等 `RENAME COLUMN` 防御迁移**（详见 §5.5.4），把残留旧列名就地对齐，再做后续流式改造。详见 `changes/linked-mid-allocation-date-column-migration/spec.md`。

- **输入**：用户在链接表管理多选大文件（实测样本：渠道账单 147MB / 657,758 行 × 44 列）。
- **输出**：流式落库（行数 = 657,757，去表头），detector 不 OOM，导入成功。
- **边界条件 / 改造点**：
  - 改造点 1（detector 表头识别）：65 万行在 detector 阶段（`detectInSheet → readSheetMeaningfulRows → readRowsWithMetadata` 全量读）就 OOM，走不到落库。表头识别只需前几行 → 用 `readXlsxStreamed` 读前 N 行（读到表头/前 ~20 行即终止流）做 L1 表头匹配 + L2 列宽守卫 + ambiguous 判定。
  - 改造点 2（落库链路 `main.js:11214-11224` + repository）：`readLinkedRowsAsObjects(全量)` → 新增"流式 replace"路径——事务内 DELETE 全表 → `readXlsxStreamed` 逐行回调（表头行校验 44 列签名；数据行裁列后 `INSERT.run(...)` 边插边算日期范围）→ 提交 → upsert meta。`linked-table-repository.js` 需新增接受"行迭代/回调"的 `replaceLinkedTableStreaming`（或重构 `replaceLinkedTable` 抽事务骨架）。
- **🔴 与需求 2b 协调**：2b 的 C3"导入文件"调 `linkedTable.import()`，块 B 改的是该入口**内部读取**，调用方不变，不冲突；块 B 应在 2b 之后或同期。

#### 5.5.2 影响范围

- 后端：`src/main-process/table-type-detector.js`（表头识别流式）+ `src/main.js`（落库链路）+ `src/backend/database/linked-table-repository.js`（流式 replace 接口）+ 可能 `readers.js`（流式变体）+ 可能 `streaming-xlsx-reader.js`（多 sheet / 提前终止）。
- 前端：无（调用方 `linkedTable.import()` 不变）。
- 数据库：无 schema 变更（仍整表覆盖 + meta）。
- 对外接口影响：无（IPC 签名不变）。
- 兼容性影响：值口径必须与 SheetJS 逐格一致（R-1，最高风险，见 §六）。

#### 5.5.3 UI Mockup

```
现状（误报）：
  导入结果：成功 0 失败 1
  渠道账单_2026-06-08_319151.xlsx：文件为空或不可读   ← 误报

块 B 后：
  导入结果：成功 1 失败 0
  渠道账单_2026-06-08_319151.xlsx → 网关对账单（657757 行）
```

#### 5.5.4 块 B 前置：spec① `linked_mid_allocation` 列名迁移

- **触发位置**：`migrations.js:2656 ensureLinkedTableSupport` 内、`linked_mid_allocation` 建表语句（`:2685/2687`）**之前**。
- **迁移逻辑**：用既有 `hasColumn` helper（`migrations.js:10`）做**严格双条件门控**——「旧列 `business_date` 存在 ∧ 新列 `transaction_date` 不存在」时才执行 `ALTER TABLE linked_mid_allocation RENAME COLUMN business_date TO transaction_date;`，否则 no-op。
- **幂等性**：迁移在每次启动的幂等迁移链中运行；正常 DB（已是 `transaction_date`）双条件不满足 → 直接跳过、不报错。SQLite `RENAME COLUMN`（3.25.0+）自动同步索引 `idx_linked_mid_allocation_date` 对该列的引用，无需重建索引（开发机已实测）。
- **数据**：那 17 行旧测试数据无需保留（导入逻辑「整表 DELETE + 重新 INSERT」，`linked-table-repository.js:221`，下次导入即覆盖）。
- **范围**：仅此一处迁移；不动其余 4 张链接表（gateway-bill / fx-settlement / bank-deposit / adm schema 均正常）、不改 INSERT / 读取逻辑（代码侧 `transaction_date` 已是正确目标态）。
- 🔴 触及**资金对账链接表 schema 迁移**（本表是 JPM 调拨订单修复 + ADM 派生的数据源 `readLinkedTableRows('mid-allocation')` / `buildAdmRows`）；列名对齐后下游读取链路不变。详见 `changes/linked-mid-allocation-date-column-migration/spec.md`。

---

### 5.6 PR-5：ADM 派生弹框溢出修复（方案 A 全局弹框 CSS）

#### 5.6.1 说明

- **现状**：ADM 派生「部分成功未匹配」弹框（`buildAdmDeriveHtml`，`renderer-dialogs.js:6309`）把未匹配明细**逐行平铺**进 `createAlertDialog` 的消息体，最多渲染 50 行（`ADM_UNMATCHED_DISPLAY_LIMIT = 50`，`renderer-dialogs.js:6305`）、每条约 2 视觉行。当未匹配行多（实测用例 57 行 → 显示前 50 行 ≈ 100+ 视觉行）时，告警卡片高度远超视口。根因是 `.alert-card`（`styles.css:1380`）**无 `max-height` / `overflow` / 非 flex column**，`.modal-overlay`（`styles.css:853`）垂直居中且自身不滚动 ⇒ 超高内容把底部「确认」按钮**挤出可视区、不可见不可点**，弹框无法关闭。
- **需求（方案 A — 结构性 CSS 根治）**：把告警卡片改成「头(图标) + 可滚动消息 + 固定按钮」的**有界 flex 列**——卡片限高、消息区内部滚动、确认按钮固定可见。一次修复**所有**走 `createAlertDialog` / `createConfirmDialog` 的过高弹框（含本迭代块 A 新增/改造的 C3、退款提醒框，以及导入明细汇总、错误报告等存量长内容弹框）。
- **边界条件**：
  - 🔴 **影响面（blast radius）= 全局**：所有 `.alert-card` 弹框（`createAlertDialog` / `createConfirmDialog` / 导出范围框等）。须回归**短内容**弹框不被异常拉伸/留白/变形。
  - 跨视口：小窗口高度（如 700px）下确认按钮仍须在视口内。
  - 保留「仅显示前 N 行」注脚（避免一次塞太多 DOM）。
- **排期**：作为 **PR-5**，安排在**块 A 弹框改造（PR-1~PR-4）之后**做——这样块 A 新增的提醒框已落地，PR-5 一次 `npm run preview` 即可覆盖所有弹框（含新提醒框）的短/长内容回归。
- 详见 `changes/adm-derive-dialog-overflow/spec.md`（方案 A 细节）。

#### 5.6.2 影响范围

- 前端：`styles.css`（`.alert-card` / `.alert-message` / `.dialog-actions` 三处规则；`.alert-body { display:contents }` 现状是规则生效前提，无需改）。
- 后端：无。
- 数据库：无。
- 对外接口影响：无。
- 兼容性影响：🔴 **纯前端 UX，不碰资金对账计算逻辑（资金红线不涉及）**；但改的是**全局共用弹框 CSS**，影响面广，提 PR 前必须重跑 `npm run preview`（memory `workflow_frontend_previews`）。

#### 5.6.3 UI Mockup

```
现状（57 行未匹配 → 卡片超高）：
  ┌──────────────────────────────┐  ← 卡片顶部被裁出视口上沿
  │ ⚠ ADM 派生部分成功，以下未匹配：│
  │ • 批次… ｜ … → 错误码           │
  │ …（100+ 视觉行）…              │
  │                              │
  └──────────────────────────────┘  ← 底部「确认」按钮被挤出视口、点不到 ✗

PR-5 后（方案 A 有界滚动 + 固定按钮）：
  ┌──────────────────────────────┐
  │ ⚠ ADM 派生部分成功，以下未匹配：│  ← 头部固定
  │ ┌──────────────────────────┐ │
  │ │ • 批次… ｜ … → 错误码      │↕│  ← 消息区内部滚动（overflow-y:auto）
  │ │ …（可滚动）…             │ │
  │ └──────────────────────────┘ │
  │            [确认]            │  ← 按钮固定可见可点 ✓
  └──────────────────────────────┘
```

---

### 5.7 PR-6（块 C）：R5 场景3 Credit/Debit 方向匹配

#### 5.7.1 说明

- **现状**：R5 场景3「中台加款单脏数据处理」引擎 `runRound5PlatformInboundCleanup`（`src/main-process/scenario-engines/r5-platform-inbound-cleanup.js`）在同 ReconciliationId 候选多行时，`:99` **无脑取 `cand[0]`（按银行对账单行序）、不读 `Credit Amount`/`Debit Amount`**。同 reconid 一 Credit 一 Debit 时，命中哪一行完全取决于行序，结果不可控 → 可能选错行 → `buildCleanupRow` 拷贝错误行的附言/13 列 → 剔除清单错位 → 导出错误财务清单（🔴 资金红线）。当前 `:96-97` 仅在多候选时 push `multi-bank-match-inbound` 警告、仍取第一条。
- **需求（规则 R-1/R-2 + O 决策定稿）**：
  - **R-1**：候选多行时，**取 `Credit Amount` 有值的那一行**（而非 `cand[0]`）。
  - **R-2**：≥2 行 `Credit Amount` 都有值 → 跳过该 reconid 不产出 + 收集警告（不阻断导出）。
- **已固化 O 决策**（用户 2026-06-08 拍板，详见 `changes/r5s3-credit-debit-direction-match/spec.md`）：
  - **O-1**「Credit 有值」= `parseNumber(b['Credit Amount']) !== null && !== 0`（空、`0`、`0.00`、不可解析 → 无值，复用 engine-utils `parseNumber`）。
  - **O-2** 0 行 Credit 有值 → **跳过该 reconid 不产出 + 收集警告**（`no-credit-match`），不阻断。
  - **O-3** 报错语义 = **仅收集警告**（severity warning，进 warnings/errorReport），**不阻断导出**。
  - **O-4** 方向规则**仅在多候选时**做消歧（单候选 `cand.length===1` 维持现状取它）。
  - **O-5** 业务确认**不存在「多 gw + 多 bank」场景** → 不处理多 gw 抢 bank；现有单测 `r5-platform-inbound-cleanup.test.js:181-199`「2 gw 各配 1 bank」须删/改。
  - **O-6** 报错粒度 = 按 reconid 收集警告（沿用 `multi-bank-match-inbound` 模式，新增 `no-credit-match` / `multi-credit-match` 两码）。
- **边界条件**：
  - 🔴 多候选选中行变化 = `buildCleanupRow` 拷贝来源变化 → 导出内容随之变化（资金红线，须人工复核样本）。
  - 所有异常分支**只收集警告、不 abort 导出**（改动收敛在引擎单文件内，不溢出到 orchestrator/导出链）。
  - 单候选维持现状（不强制单行 Debit 也筛掉/报警）。

#### 5.7.2 影响范围

- 后端：`src/main-process/scenario-engines/r5-platform-inbound-cleanup.js`（唯一业务改动文件，改候选选择块）。
- 测试：`tests/unit/.../r5-platform-inbound-cleanup.test.js`（删/改 `:181-199` multi-bank case + 新增方向消歧 case）。
- 数据库：无。
- 对外接口影响：无（引擎纯函数，签名不变）。
- 兼容性影响：🔴 资金红线——剔除清单内容在"多候选 1Credit1Debit"场景下结果变化（从行序依赖 → 确定取 Credit 行）；`multi-bank-match-inbound` 警告语义被新码取代。

#### 5.7.3 UI Mockup / 行为示意

```
同 ReconciliationId=R001 候选 2 行：
  行A: Credit Amount=1000, Debit Amount=（空）
  行B: Credit Amount=（空）, Debit Amount=1000

现状（无脑取 cand[0]）：
  → 取行序第一条（可能是行B Debit 行）→ 剔除清单错位 ✗

PR-6 后（多候选取 Credit 有值行）：
  → creditCand=[行A] → 取行A（Credit 行）✓

异常场景：
  2 行 Credit 都有值 → 跳过 R001 + 警告 multi-credit-match（不阻断导出）
  0 行 Credit 有值   → 跳过 R001 + 警告 no-credit-match（不阻断导出）
```

---

### 5.8 PR-7（块 D）：场景管理批量操作勾选列致表格大面积偏移

#### 5.8.1 说明

- **现状**：「场景管理」弹框（`scenarios-manager`，`createScenariosManagerDialog`）表格 `.scenarios-table` 用 `table-layout: fixed; width: 100%`（`styles.css:2825-2828`），普通模式各数据列宽由**百分比**分配、非 compact 累加=100%（id 5% + category 22% + name 30.94%`!important` + priority 10% + actions 19.06% + enabled 13%）。点「批量操作」进入批量模式后，最左多出**固定 32px**的勾选列 `scenarios-col-checkbox`（th `renderer-dialogs.js:6468` / td `:6560` 内联 `width:32px`），但 `setBatchMode`（`:6575-6593`）只切勾选列 th/td 的 `display`、**未重算其余列宽**。`table-layout:fixed` 下固定 px 列先占 32px、剩余宽按百分比分配，32px + 百分比≈100% 叠加**溢出容器约 32px（1140px 最大宽下 ≈2.8%）** → 全列等比压缩、相对表头集体左移错位（大面积偏移）；退出批量模式（勾选列 `display:none`）恢复。
- **需求（方案 A — 勾选列百分比化 + 其余列补偿）**：
  - 勾选列内联宽度 `32px` → 百分比 **~3%**（向上取整、稳）；
  - 批量模式显示勾选列时，其余列总和从 100% 下调到 ~97%（各列按 97/100 等比缩放），使含勾选列时总和回到 100%；
  - 清理 `styles-gemini-extra.css` 重复且取值冲突的 `.scenarios-col-name` 定义（`:2251` `30.94% !important` vs `:2265` `27.96%`），统一为单一值、消除列宽口径混乱。
- **边界条件**：
  - 三套视图模式都不能变形：① 非 compact（资金对账主入口，含优先级 + 启用）② compact 普通（业务 ReconID，无优先级/无启用）③ gateway-recon-id-fix compact（无优先级、有启用）。
  - `name` 列被 `styles-gemini-extra.css .scenarios-col-name{width:30.94% !important}` 强制锁定、th 内联 `nameWidth` 在多数模式下失效（`renderer-dialogs.js:6425-6427` 注释自承）→ 清理重复定义后须确认 compact 模式 name 列宽不反向变化。
  - `table-layout:fixed` 下 `styles.css:2843-2912` 有大量像素级精调（序号 margin-left:21px、category/name 左对齐、actions 按钮间距）→ 改宽度百分比不得破坏这些精调。
- **属性**：**pre-existing**（勾选列由 v2.1.9 commit `2df26f6` 引入，**非 v3.0.0 新增**）。作 **PR-7** 纳入本迭代。

#### 5.8.2 影响范围

- 前端：`styles.css`（`.scenarios-table` 各列百分比 + 勾选列百分比）+ `renderer-dialogs.js`（勾选列 th/td 内联宽度 `32px`→百分比，`:6468`/`:6560`；方案 A 静态补偿时其余列 th 内联宽度 `:6422-6430` 同步）+ `styles-gemini-extra.css`（删重复 `.scenarios-col-name`）。
- 后端：无。数据库：无。对外接口影响：无。
- 兼容性影响：**纯前端 UX，不碰资金计算（资金红线不涉及）**；改后必须重跑 `npm run preview:scenarios-manager`（`package.json:56` 专属入口）。🔴 **盲点**：该 preview 默认渲染**非批量态**（勾选列 `display:none`、看不到偏移）→ 批量态偏移须靠 Electron 实跑或新增 batch preview 变体。`renderer-dialogs.js` 属重要骨架 → `/check-vars`。

#### 5.8.3 UI Mockup

```
现状（批量模式 — 勾选列 32px 未让出列宽 → 全列左移错位）：
  ┌──┬─────┬──────────┬────────┬──────┬────┐  ← 表头
  │☑ │序号 │ 功能类别 │ 场景名称│ … │启用│
  ├──┼─────┼──────────┼────────┼──────┼────┤
  │ ☐ │ 1  │…数据列相对表头整体左移 ~32px…→溢出│ ✗
  └──┴─────┴──────────┴────────┴──────┴────┘   ← 内容溢出 1140px 容器

PR-7 后（勾选列 3% + 其余列 ×0.97 → 总和=100%，无溢出）：
  ┌──┬─────┬──────────┬────────┬──────┬────┐
  │☑ │序号 │ 功能类别 │ 场景名称│ … │启用│
  ├──┼─────┼──────────┼────────┼──────┼────┤
  │ ☐ │ 1  │ 数据列对齐表头、不偏移、不溢出     │ ✓
  └──┴─────┴──────────┴────────┴──────┴────┘
```

---

## 六、验收标准

> 本章节共 **37 条** AC（需求 1：4；需求 2a：4；需求 2b：4；需求 3：6；块 B：6（含 spec① 前置迁移）；PR-5：4；PR-6（块 C R5 方向匹配）：5；PR-7（块 D 场景管理批量偏移）：4）。

### 6.1 需求 1：状态框前缀 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC1-1 | 导入唯一渠道-地区组合的对账单 → 状态框显示 `CITI-HK:文件名（M 行）` |
| AC1-2 | 导入多渠道-地区组合 → 状态框显示 `CITI-HK、JPM-US:文件名（M 行）`（全列出、去重、稳定序） |
| AC1-3 | 多文件合并 → 前缀按合并全集去重；地区空只产出 `Channel`，Channel 空不产出该组合 |
| AC1-4 | 0 个组合（无 Channel）→ 无前缀，兜底原文案；前缀用半角 `:` 不触发换行（`renderer-status-box-text` 护栏通过） |

### 6.2 需求 2a：去框 + issues 并入状态框 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC2a-1 | 导入后**不再弹**明细确认框 |
| AC2a-2 | 含跳过/失败的批次 → 状态框主文案后追加「跳过 N 个：…／失败 N 个：…」（纯文本），`failed.length>0` 时 tone 升 error |
| AC2a-3 | 纯失败批次（无 bank ok）→ 状态框仍渲染 issues（不改 mode、不清 export） |
| AC2a-4 | 退款优先互斥提醒副作用未丢（迁移到成功路径末尾，状态框刷新后再弹）；进入新动作（run/export/导网关）清旧 issues |

### 6.3 需求 2b：C3 改向链接表 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC2b-1 | 启用 C3 + 链接表 `gateway-bill` 空 + 本批有银行候选 → 导入后 & 运行点提醒"请在链接表管理导入网关对账单" |
| AC2b-2 | 启用 C3 + 链接表 `gateway-bill` 有数据（rowCount>0）→ **不弹**；未启用 C3 → 不弹；c3 候选=0 → 不弹 |
| AC2b-3 | C3 提醒"导入文件"→ 调起链接表导入对话框（`linkedTable.import()`），不再调死链 |
| AC2b-4 | IPC `linked-table:row-count` 异常 → 按"未就绪"处理（仍提醒，保守防漏对账） |

### 6.4 需求 3：退款对齐 + 预检 + 运行点编排 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC3-1 | 启用退款 + 未导退款表 + 有 `Ach Return` 候选 → 导入后弹两按钮框（导入文件/稍后再说） |
| AC3-2 | 同上条件 → 运行点弹三选一框（导入文件/直接运行/取消） |
| AC3-3 | 导了退款表 / 无 `Ach Return` 候选 / 未启用退款场景 → 不弹（导入后 + 运行点均不弹） |
| AC3-4 | 退款"导入文件"→ 调起《导入对账单》批量导入（不续跑） |
| AC3-5 | 运行点"直接运行"→ 只跳退款，继续 `proceedToGwCheck`；**若 C3 缺数据仍弹 C3 提醒** |
| AC3-6 | 退款互斥优先于 C3（导入后提醒顺序：退款优先） |

### 6.5 块 B：大文件流式导入 AC

| AC 编号 | 验收条件 |
|---------|---------|
| ACB-1 | 真实 65.7 万行样本导入链接表 → 不再报"文件为空或不可读"，导入成功 |
| ACB-2 | 落库行数 = 657,757（去表头），日期范围 min/max 正确，meta 更新 |
| ACB-3 | 🔴 值口径：流式 parser 与 SheetJS 对中等链接表**逐格 diff 一致**（日期/数字精度/前导零/空格），纳入单测 |
| ACB-4 | 🔴 整表覆盖原子性：流式落库中途失败 → 整体回滚（不留半表） |
| ACB-5 | 🔴 落库后 ADM 派生（bank-deposit 或 mid-allocation 触发）不崩（次生 OOM 已缓解，见块 B OPEN O-3） |
| ACB-6 | 🔴 spec① 前置迁移：残留 `business_date` 旧表 DB 启动后列就地改名为 `transaction_date`、索引引用同步；正常 DB（已 `transaction_date`）跑迁移 no-op 不报错；用例文件重导落库成功 |

### 6.6 PR-5：ADM 弹框溢出（方案 A 全局弹框 CSS）AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC5-1 | ADM 多行未匹配（≥50 行）弹框：底部「确认」按钮**可见可点**，弹框可正常关闭 |
| AC5-2 | 消息区内部滚动（`.alert-message overflow-y:auto`），头部图标 + 底部按钮固定不随内容滚动 |
| AC5-3 | 短内容 alert / confirm / 导出范围框 + 块 A 新增的 C3/退款提醒框**布局不变形**（不被异常拉伸/留白），`npm run preview` 相关入口重渲染比对一致 |
| AC5-4 | 小窗口高度（如 700px）下确认按钮仍在视口内（`.alert-card max-height: calc(100vh - 56px)` 生效） |

### 6.7 PR-6（块 C）：R5 场景3 Credit/Debit 方向匹配 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC6-1 | 同 reconid 多候选、**恰 1 行 `Credit Amount` 有值**（`parseNumber !== null && !== 0`）→ 取该 Credit 行（断言加款单号/附言/13 列来自 Credit 行，非 cand[0]） |
| AC6-2 | 同 reconid 多候选、**0 行 Credit 有值**（全 Debit / Credit 全空）→ **跳过该 reconid 不产出剔除行 + 收集警告 `no-credit-match`，不阻断导出** |
| AC6-3 | 同 reconid 多候选、**≥2 行 Credit 有值** → **跳过 + 收集警告 `multi-credit-match`，不阻断导出** |
| AC6-4 | **单候选**（cand.length===1）→ 维持现状取它（Debit 单行不被筛掉、不报警）；导出主链路无 abort（O-3 仅警告） |
| AC6-5 | O-5：现有单测 `r5-platform-inbound-cleanup.test.js:181-199`「2 gw 各配 1 bank」已删/改（业务确认不存在多 gw+多 bank）；`Credit Amount`=`0`/`''`/`'0.00'`/`'1,234.5'` 按 O-1 口径正确判定有值/无值 |

### 6.8 PR-7（块 D）：场景管理批量操作 CSS 偏移 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC7-1 | 「场景管理」点「批量操作」进入批量模式、勾选列出现 → 表格列**对齐表头、不偏移、不抖动**；退出批量模式恢复正常（进出无残留错位） |
| AC7-2 | 三套视图模式批量模式均不变形：① 非 compact（含优先级+启用）② compact 普通（无优先级/无启用）③ gateway-recon-id-fix compact（无优先级、有启用） |
| AC7-3 | 批量模式下表格在 `1140px` 最大宽（`.scenarios-manager-card` 上限）**无横向滚动条 / 无内容溢出**；勾选列宽口径为百分比（与其余列同口径） |
| AC7-4 | `styles-gemini-extra.css` 中 `.scenarios-col-name` 仅剩**一处**定义（重复+冲突定义已清理）；清理后 compact 模式 name 列宽不反向变化 |

---

## 七、手动测试清单

> 🔴 资金红线场景**必须** Electron 实跑（提醒框为运行期 `openModal`，无 preview script）。

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| C3 链接表空提醒 | 导入银行对账单（含 C3 候选行） | 启用 C3 + 链接表 `gateway-bill` 空 | 导入后 & 运行点都提醒"请在链接表管理导入网关对账单" |
| C3 链接表有数据不弹 | 同上 | 启用 C3 + `gateway-bill` rowCount>0 | 不弹 |
| C3 导入文件跳转 | 点"导入文件" | C3 提醒弹出 | 调起链接表导入对话框 |
| 退款导入后两按钮框 | 导入银行对账单（含 Ach Return 行，不带退款表） | 启用退款场景 | 弹两按钮框（导入文件/稍后再说） |
| 退款运行点三选一 | 点"开始运行" | 启用退款 + 未导退款表 + 有候选 | 弹三选一框 |
| 退款"直接运行"跳退款仍弹 C3 | 退款运行点选"直接运行" | 退款 + C3 都缺数据 | 跳退款后**仍弹 C3 提醒** |
| 退款无候选不弹 | 导入不含 Ach Return 行的对账单 | 启用退款场景 | 导入后 + 运行点均不弹 |
| 块 B 大文件导入 | 真实 657,758 行渠道账单（147MB） | 链接表管理 | 导入成功、落库 657,757 行、不报"文件为空" |
| 块 B 值口径 diff | 中等链接表（SheetJS 能读） | — | 流式 ↔ SheetJS 逐格一致 |
| 块 B ADM 派生不崩 | 块 B 落库 bank-deposit 后 | 已有 mid-allocation | ADM 重建完成不 OOM |
| 块 B spec① 前置迁移 | 残留 `business_date` 旧表 DB 启动 + 用例文件重导 | 中间 beta 构建机器 | 列改名 `transaction_date`、落库成功；正常 DB 启动 no-op 不报错 |
| PR-5 ADM 弹框溢出修复 | 导入 `渠道账单_2026-05-20_568603-用例.xlsx` 触发 ADM「部分未匹配」框（≥50 行未匹配） | 块 A 弹框改造已落地 | 确认按钮可见可点、消息区内部滚动、弹框可关闭 |
| PR-6 R5 方向匹配（资金红线） | 真实样本：同 reconid 一 Credit 一 Debit 行 | 启用 R5 场景3 | 剔除清单取 Credit 行（非 cand[0]）；2 行 Credit 都有值/0 行 Credit → 跳过 + 警告但导出不被阻断；人工复核剔除清单内容正确 |
| PR-7 场景管理批量偏移 | 「场景管理」点「批量操作」进入批量模式 | 资金对账主入口（非 compact） | 勾选列出现后表格列对齐表头、不偏移/不溢出；退出批量模式恢复 |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 状态框单组合前缀 | 导入唯一渠道-地区对账单 | — | `CITI-HK:文件名` |
| 状态框多组合前缀 | 导入多渠道-地区对账单 | — | `CITI-HK、JPM-US:文件名`（半角冒号、不换行） |
| 状态框多文件合并前缀 | 批量导入多份对账单 | — | 前缀按合并全集去重 |
| 状态框失败/跳过摘要 | 批量导入含失败/跳过文件 | — | 状态框追加摘要，tone 升 error（有失败时） |
| 纯失败批次状态框 | 批量全失败 | — | 状态框渲染 issues（不改 mode） |
| 去框验证 | 任意批量导入 | — | 不弹明细确认框 |
| C3 IPC 异常保守 | 模拟 `row-count` IPC 失败 | 启用 C3 | 仍提醒（按未就绪） |
| PR-5 短内容弹框不变形 | 触发短内容 alert / confirm / 导出范围框 + C3/退款提醒框 | 方案 A 已落地 | 布局不被异常拉伸/留白，`npm run preview` 比对一致 |
| PR-5 跨视口按钮可见 | 小窗口高度（如 700px）触发超高 ADM 框 | 方案 A 已落地 | 确认按钮仍在视口内 |
| PR-7 各视图模式批量不变形 | 三套视图（非 compact / compact 普通 / gateway-recon-id-fix compact）分别进出批量模式 | — | 各模式列宽均不变形、勾选列正常显隐 |
| PR-7 preview 回归 | `npm run preview:scenarios-manager` 重渲染 | PR-7 已落地 | 非批量态布局不变形（批量态偏移须 Electron 实跑，preview 默认非批量态盲点） |

### 7.3 不测项与原因

- **单元测试覆盖的纯函数**（`extractChannelRegionCombos` / `buildImportIssuesSummary` / `countRefundBankCandidates` / 块 B 值口径 diff）由 `npm run test:unit` 覆盖，手测不重复。
- **`createConfirmDialog` 三按钮渲染**已有 beta.6 验证（PR#33），不重复测其 DOM 结构。
- **块 B 单事务 SQLite 承受力**（65 万行 WAL/锁）属性能验证，归块 B OPEN O-4 评估，不在常规手测内。

---

## 八、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更 | 无 schema 变更。块 B 仍走链接表整表覆盖 + `linked_table_meta`（结构不变）。 |
| 状态流转变更 | 🔴 **Runtime-state**：①`bankStatementSession`（需求 1 读 rows 提取组合，**只读**）；②`gatewayReconSession`（需求 2b 从判据中**移除其门控作用**，但不改其写入/清空时机、不删 session）；③`refundOrderSession`（需求 3 经 session-status 透出 `hasRefundOrder`，**只读**，依赖 PR#65 已收紧的生命周期）。本迭代对三个 session 均**只读不改写入/清空逻辑**。 |
| 权限 / 安全 | 不涉及鉴权/敏感数据。块 B 读用户本地 Excel（与现状一致）。 |
| 回滚策略 | 块 A 四需求均为前端提醒/状态框 + 增量 IPC，回滚 = revert 对应 PR（无 schema/数据迁移，无残留）。块 B 回滚 = revert 流式落库路径，恢复 SheetJS 全量读（大文件回到 OOM 误报现状，但不损坏已落库数据，因整表覆盖单事务原子）。 |

---

## 九、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | 所有新增 IPC（`linked-table:row-count` / `bank-statement:refund-candidate-count`）+ session-status 新增字段均为增量，老调用方不受影响；前端 state 接新字段时按缺省兜底。 |
| 性能 | 🔴 块 B：65.7 万行流式导入实测 12.4s / 385MB RSS（vs 现状 OOM）；ADM 派生次生 OOM 须在 O-3 评估缓解。需求 2b 行数查询走 `linked_table_meta` 单行 meta，不读全表（避免 65 万行读盘）。 |
| 鲁棒性 | 🔴 C3/退款"就绪"判据严格（`rowCount>0` / `refundOrderSession!==null`）；IPC 异常按"未就绪"保守处理（宁多提醒不漏对账）。块 B 整表覆盖全程单事务，失败整体回滚。 |

---

## 十、待澄清问题

### 块 A

- [x] 需求 1 前缀格式：唯一组合 `CITI-HK:文件名`，多组合全列出 `CITI-HK、JPM-US:文件名`（已拍板）
- [x] 需求 2a 失败信息去向：并入状态框（已拍板）
- [x] 需求 2b C3 提醒方向：改向链接表网关对账单，"导入文件"调 `linkedTable.import()`（已拍板）
- [x] 需求 3 退款"导入文件"：调起《导入对账单》批量导入（已拍板）
- [x] 退款预检：本批无 Ach Return 候选则不提醒（已拍板）
- [x] 运行点"直接运行"范围：只跳退款、C3 仍单独提醒（链式编排，已拍板）
- [ ] **确认链接表管理「导入」在 renderer 的调用与结果反馈**（C3/退款"导入文件"复用 `linkedTable.import()`，需确认其返回结果是否需要在调用方反馈给用户、是否需要刷新状态框）—— 实施前 Dev 确认

### 块 B（OPEN，🔴 实施前需用户逐条拍板，不替用户定）

- [ ] **O-1**：统一流式 vs 大文件阈值分支（推荐：值口径验证通过后统一流式，免双路径维护）
- [ ] **O-2**：值口径一致性验证策略（推荐：中等文件 SheetJS↔流式 逐格 diff 入单测）—— **最高风险，实施硬前提**
- [ ] **O-3**：bank-deposit / mid-allocation 派生 ADM 的 65 万行内存（R-3）；🔴 PR#65 后 `main.js:11244-11259` 改为**两源任一变更都触发 ADM 全量重建**，块 B 的 O-3 须覆盖 mid-allocation 入口（原 spec 只标 bank-deposit）—— 可能拆另案
- [ ] **O-4**：65 万行单事务 INSERT vs 分批（与整表覆盖原子性冲突，推荐：单事务 + 确认 SQLite 承受力）
- [ ] **O-5**：detector 多 sheet vs 流式引擎单 sheet（`readXlsxStreamed` 硬编码只读 sheet1.xml；确认链接表单 sheet 约定 / 补多 sheet 支持）
- [ ] **O-6**：顺带修误导报错文案（read-error 细分，区分"真空文件"与"OOM 读失败"）

### 与上游 plan 的发现（需 team-lead 确认）

- [ ] **退款提醒现状与 plan 描述不一致**：plan 写"退款提醒现 `createAlertDialog` 单按钮"，实测 beta.6 的 `maybePromptRefundOrderImport`（renderer.js:3611-3614）**确实是 `createAlertDialog` 单按钮**（带 `{ logLevel:'info', skipLogReport:true }`，仅提示无导入入口）—— plan 描述准确，需求 3 改为 `createConfirmDialog` 成立。
- [ ] **`refundOrderSession` 尚未单独升格入 `rules/important-variables.md`**：当前 Runtime-state 层只有 `bankStatementSession` / `gatewayReconSession` / `processingResult` 三条，`refundOrderSession`（main.js:295，beta.6 已开通真实退款数据流）**未单独成条**。本迭代需求 3 依赖其生命周期判就绪 → 建议 team-lead 评估在本迭代将 `refundOrderSession` 升格入表（见 TechDoc §N+5）。
- [ ] **ADM 重建触发范围**：PR#65 后已确认是 bank-deposit **或** mid-allocation 任一变更都触发（main.js:11244-11259 代码 + 注释实证），plan 的 PR#65 影响评估描述准确；块 B O-3 须同步覆盖两条路径。

---

## 十一、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-08 | 初稿（基于已批准 plan `3-0-0-1-flickering-haven.md` + 两份 spec + beta.6 文档格式参照；行号基线 cf7edec） |
| 2026-06-08 | 块 A（需求 1/2a/2b/3）已实施完成。纳入两个新决策：①spec②「ADM 派生弹框溢出」定方案 A（全局 `.alert-card` CSS 改有界滚动+固定按钮）作为 **PR-5**（块 A 弹框改造后做、一次 preview 覆盖所有弹框含新提醒框）→ 新增 §5.6 + §6.6（4 条 AC）+ §七手测；②spec①「`linked_mid_allocation` 列名迁移 business_date→transaction_date」并入**块 B 作前置步骤**（块 B 实施第一步先做幂等 RENAME 防御迁移）→ 补 §5.5.1 前置说明 + §5.5.4 + AC ACB-6 + §七手测 |
| 2026-06-08 | **决策反转 + 块 C 纳入**：①用户拍板 R5 场景3 Credit/Debit 方向匹配 O-1~O-6（原 §五"明确不做"反转），新增**块 C / PR-6**（多候选取 Credit 有值行；0 行或 ≥2 行跳过+警告不阻断）→ 新增 §5.7 + §6.7（5 条 AC，AC 总数 28→33）+ §一概述块 C + §七 P0 手测；②块 B OPEN O-1~O-6 用户**按推荐采纳**（O-2 值口径 diff 为实施硬前提、O-3 覆盖 bank-deposit+mid-allocation 双触发、O-6 顺带修"文件为空"误报文案），spec 状态→已确认（待实施）；③Reverse Sync：`changes/c3-gateway-recon-prompt-fix`（已实施 PR-3）、`changes/adm-derive-dialog-overflow`（已实施 PR-5 方案A）、`changes/r5s3-credit-debit-direction-match`（已确认待实施 PR-6）、`changes/linked-table-large-file-streaming`（已确认待实施）状态行已校正 |
| 2026-06-08 | **块 D 纳入（PR-7）**：场景管理批量操作勾选列致表格大面积偏移（pre-existing，勾选列由 v2.1.9 commit `2df26f6` 引入）。根因 = `.scenarios-table` `table-layout:fixed` + 其余列百分比≈100% 叠加勾选列固定 32px 溢出 ≈2.8%，`setBatchMode` 显示勾选列时未让出列宽。方案 A = 勾选列百分比化(~3%) + 其余列按 97/100 补偿 + 清理 `styles-gemini-extra.css` 重复 `.scenarios-col-name` 定义。纯前端 UX 不碰资金计算 → 新增 §一概述块 D + §三代码现状 5 行 + §5.8 + §6.8（4 条 AC，AC 总数 33→37）+ §七 P0/P1 手测；详见 `changes/scenario-batch-css-offset/spec.md` |

---

## 十二、实施记录

> 由 PR merged + 归档后自动追加，PM 不需要手动填写。

（暂无）
</content>
</invoke>
