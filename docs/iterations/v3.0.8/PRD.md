# PRD - 网银账单生成小助手 v3.0.8（工具箱合表拆表 / 场景管理体验 / 资金对账运行不阻塞 + 内存尖峰修复 / 未命中 sheet 布局 / BOC 修复行 Type / R5s3 两级 fallback）

| 项 | 值 |
|---|---|
| 版本 | v3.0.8 |
| 状态 | 初稿（待评审） |
| 模块 | 工具箱（合表/拆表）· 场景管理 · 资金对账数据处理（bank-statement / 5 轮对账编排）· 银行对账单输出 · BOC 调拨订单修复 · R5 场景3 引擎 |
| 实施方式 | team-lead 拆分委托 dev 分 W1~W6 工作流实施（W4=需求6+需求3 合并工作流，单 agent 顺序做） |
| 质量门 | `npm run release-check` 全绿（unit + integration + smoke）；🔴 资金红线需求 3/4/5/6/7 人工复核 + golden/等价回归 |
| 依赖 | 当前 `v3.0.7` 分支 → 切 `v3.0.8` 开发分支，bump `package.json.version → 3.0.8`；并入两份 v3.0.7 已定稿 spec（A=运行内存尖峰修复、B=R5s3 规则变更），版本 tag / commit / 注释统一用 `v3.0.8` |

> **来源事实源（唯一 truth）**：
> 1. 已批准 plan：`~/.claude/plans/3-0-8-3-0-8-1-xlsx-toasty-wozniak.md`（7 需求完整方案 + 资金红线汇总 + W1~W6 拆分）
> 2. spec A（需求6）：`changes/v3.0.7-run-linked-memory-fix/spec.md`（bank-deposit 消费方门控 + gateway-bill 按 Channel 过滤读）
> 3. spec B（需求7）：`changes/r5s3-channelorderno-fallback-inbound-substring/spec.md`（ChannelOrderNo 两级 fallback + FundType 子串判定，D-1~D-3 用户拍板）
>
> 本 PRD 以上述为唯一事实源；所有拍板结论原样转述，不自行发明语义。两份 spec 原标 v3.0.7，并入本迭代后版本对外口径统一为 v3.0.8。

---

## 一、需求概述

v3.0.8 集中处理 **7 项**需求 —— 5 项新反馈 + 2 份用户已定稿的 v3.0.7 资金红线修复 spec（并入本迭代一起发）：

1. **工具箱🧰（合表 / 拆表）** —— 脱离主对账流程的轻量 Excel 小工具。左下角新增🧰按钮 → 弹框：合并多个表头一致的表格为一张；按某字段的某些值拆分一张表为子集表。
2. **场景管理体验** —— 退役自带场景 C3（`gateway-recon-join`，**纯前端过滤退役**：列表 `refreshTable` 过滤不显示，`migrations.js` 完全不动、引擎/约束/seed/已有库记录全保留）+ 两大功能分组（「资金性质校验」「中台订单数据处理」）三角折叠、默认收纳。
3. **资金对账「开始运行」不阻塞** —— 主进程异步化 + 进度事件转发，消除运行期窗口「未响应」（不上 worker）。🔴 资金红线（对账 run 路径）。
4. **银行未命中场景 sheet 布局** —— 提醒独占 A1，表头 / 数据整体右移到 B 列起。🔴 输出口径。
5. **BOC 调拨修复行 Type 改值** —— 修复模板输出列 `Type` 由 `2 → 1`。🔴 资金红线。
6. **运行内存尖峰修复（并入 spec A）** —— bank-deposit 入金表加消费方门控（关退款场景时不读 ~1.2GB）+ gateway-bill 网关账单表按 Channel 过滤读（业务不变量：对账永远同 Channel），根治 Windows「开始运行」卡死。🔴 资金红线。
7. **R5s3 规则变更（并入 spec B）** —— 中台加款单脏数据处理引擎：ReconciliationId 主键匹配不上时用银行 ChannelOrderNo 兜底（两级 fallback）+ FundType 由精确判等 `'Inbound'` 改为子串包含判定（大小写不敏感）。🔴 资金红线。

> **需求 3 与需求 6 是同一痛点（「开始运行」卡顿/未响应）的两个治法，且改同一 `src/main.js` `bank-statement:run` handler，必须协同实施 —— 先做需求 6（减少大表载入）、后做需求 3（执行异步化），禁止拆开各改 handler。** 详见 §5.3 / §5.6。

---

## 二、背景与目标

### 2.1 背景

| 需求 | 为什么要做 | 用户 / 业务价值 | 当前问题 |
|------|-----------|----------------|----------|
| 1 工具箱 | 用户日常有大量「把几个同结构表格拼成一张」「按某列的某些值从一张表里抽出子集」的零碎 Excel 操作，目前要么手工复制粘贴、要么走主对账流程（杀鸡用牛刀）。 | 一个轻量入口一键完成合表 / 拆表，文件名带时间戳自动规范，免手工操作。 | 工具无此能力；主对账流程不适配纯 Excel 行级操作。 |
| 2 场景管理 | 场景管理弹框现为扁平长列表，自带场景 C3（与网关对账单按金额币种 1v1 匹配回填对账ID）实际已被新机制替代、不再推荐使用却仍占位；功能分组无折叠，用户找目标场景费力。 | 退役不推荐的 C3 减少误用；两大分组折叠 + 默认收纳，列表更清爽、聚焦常用场景。 | C3 仍显示可启用；列表扁平无分组折叠。 |
| 3 运行不阻塞 | 资金对账「开始运行」期间主进程同步跑完 R1-R5 全部轮次，渲染进程消息循环被阻塞 → Windows 标题栏显示「未响应」、窗口拖不动，用户误以为崩溃。 | 运行期窗口始终可响应、有进度反馈，体验不再「假死」。 | handler 同步执行、无让出、无进度事件。 |
| 4 未命中 sheet | 未命中场景 sheet 的 A1 是加粗中文提醒，但表头与数据也从 A 列起，提醒与数据列挤在同一列视觉上不清晰。 | A 列除 A1 留空、数据右移 B 列起，提醒独占首列，阅读更清楚。 | 提醒 A1 与表头/数据同列起。 |
| 5 BOC Type | BOC 调拨订单修复模板输出的 `Type` 列业务上应为 `1`，现写死 `2`，下游消费拿到错误的 Type 值。 | 修复模板 Type 与业务语义对齐。 | 写死 `2`（v3.0.4 D9 拍板值），业务确认应为 `1`。 |
| 6 内存尖峰 | 用户在 Windows 导入约 2862 行的普通渠道对账单（Channel=BOSH、地区=CN）后点「开始运行」极卡。已实测定位：导入本身很快（detect 28ms + read 184ms + merge 0.1ms，峰值 RSS 222MB），卡顿在「开始运行」阶段。根因是 `bank-statement:run` 每次无门控/无优化地全量读多张链接表：① bank-deposit 入金表整表读 + 深拷（代码自标注 65.7 万行 ~1.2GB RSS 尖峰），而关退款场景时这份数据一行都用不上（门控漏洞，非新引入）；② gateway-bill 网关账单表全量读 + 深拷，规模可达数百万行。 | 关退款场景时不再无谓载入 1.2GB；网关表只读本批涉及的 Channel 子集且不深拷 → 峰值内存大幅下降、「开始运行」秒回。 | bank-deposit 读取无消费方门控；gateway-bill 全量读 + `structuredClone` 深拷。 |
| 7 R5s3 | 业务方提出两处调整：① 中台加款单脏数据处理时，银行侧对账号（`ReconciliationId`）对不上就匹配失败、漏识别脏数据；希望再用银行 `ChannelOrderNo` 兜一道扩大识别面。② 触发条件精确判等 `FundType==='Inbound'` 太死，未来出现 `Inbound-VA` / `inbound-xxx` 等入金变体会被误判为「非入金」而误产剔除行。 | 两级 fallback 扩大脏数据识别面；子串判定防入金变体误剔除（资金红线，剔除清单错位 = 导出错误财务清单）。 | 对账号只认 `ReconciliationId` 单列；触发条件精确判等 `'Inbound'`。 |

### 2.2 目标（必做）

- **需求 1**：左下角🧰入口 → 工具箱弹框；合并表格（导入多文件即一气呵成另存为）+ 拆分表格（导入文件 → 选字段/值 → 导出子集）两条链路；文件名模板带时间戳；合表表头一致性校验。
- **需求 2**：场景管理弹框**纯前端过滤** C3 不显示（`refreshTable` 过滤 `category==='gateway-recon-join'`；后端引擎/约束/seed/已有库记录全不动，`migrations.js` 一行不改 → 更可回滚、零 migration 风险）；两大功能分组折叠收纳，默认 collapsed。
- **需求 3**：`bank-statement:run` handler 改 async + 阶段边界让出事件循环；编排器在轮次边界插 yield + 进度上报，实际边界 R1→R2(dispatcher)→R3.5→R4→R5（R5 内细分 s2@359 / s2b@404 / s3@423 / s4@448 子轮，R2 在 R1 与 R3.5 之间）（轮次顺序/引擎入参/数据逻辑零改动）；新增 `bank-statement:run:progress` 进度通道，前端订阅更新状态框。
- **需求 4**：未命中场景 sheet1 表头 / 数据列号整体 +1（右移 B 列起），A1 提醒不变；仅 sheet1，golden 回归更新。
- **需求 5**：`boc-dispatch-order-fix.js` Type `2 → 1` + 同步注释 + 单测断言 + golden；需用户最终确认 Type=1 业务语义。
- **需求 6**：bank-deposit 加 `refundBackfillEnabled` 门控（逐字镜像编排器 r5s4 分桶条件，关闭退款场景注入 `[]`）；新增 `readGatewayBillRowsByChannels` 仓储函数按 Channel 子集下推过滤读 + 删 gateway 深拷；处理三个陷阱（空/缺 Channel、归一化口径、跨轮无越界 Channel 需求）。
- **需求 7**：R5s3 引擎三处改动 —— 建双键索引（`bankByReconId` + `bankByChannelOrderNo`）；匹配循环两级严格优先级 fallback（一级 empty 才退二级、一级消歧失败不 fallback、二级同跑 Credit 消歧、usedBankRowId 跨两级共享）；触发条件改子串包含判定（大小写不敏感、空配置兜底全产）。
- **收尾**：版本 bump 3.0.8 + 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）+ `npm run scan:vars`（bump 前）+ `/check-vars`（提 PR / 合并前硬节点）+ `npm run release-check` 全绿 + previews 回归（需求 1/2）+ spec A/B 实施后归档 `changes/`。

### 2.3 明确不做（非目标）

- **需求 1**：合表不做表头「相似即对齐」（要求全相同，不同即报错停止）；拆表暂只支持单字段筛选（单选字段 + 多选值），不做多字段组合筛选；多选值产物为单文件（含全部选中值的行），不做「每个值一个文件」。不复用主对账模板 / 列映射 / 币种归一化（纯行级搬运）。
- **需求 2**：不删 C3 引擎（`c3-gateway-recon-join.js`）/ dispatcher case / CHECK 约束（`migrations.js:409`）/ seed（`migrations.js:378`）/ 已有库记录（**纯前端 UI 过滤隐藏，`migrations.js` 完全不动**，保证可回滚）；不改 R1 强制匹配（C3 是 R2 可选场景，与 R1 无关）。**新建场景下拉仍可建 C3**（实施期取舍，见 §十二 OPEN-2）。
- **需求 3**：不上 worker_threads（仅主进程 async + setImmediate 让出）；不改轮次顺序、引擎入参、任何数据匹配逻辑；进度只做状态框文案更新，不做百分比进度条精算。
- **需求 4**：仅改 sheet1「未命中场景」列布局；不动 sheet2「命中场景」（首列是「命中明细」，不涉及）；不改 A1 提醒文案、不改行号（仅右移列）。
- **需求 5**：不在 src/ 内增删任何按 `Type==值` 过滤的逻辑（Type 仅落输出 Excel 给下游，src/ 内无消费分支）；仅改写值 + 注释 + 测试断言。
- **需求 6**：bank-deposit 门控为字节级不变优化（退款场景关时编排器本就 no-op）；gateway 过滤读为「带业务不变量的优化」，非纯字节不变（若数据真有跨渠道键碰撞，过滤后会消除「跨渠道误匹配」——按业务定义那本就是错配、过滤结果才对，须等价测试 + 业务不变量双重背书）；不改任何轮次匹配算法。
- **需求 7**：不改 `buildCleanupRow`（剔除行结构/附言文案/加款单号取值）；不改配置 seed（`excludeFundType:'Inbound'` 字段名与值不变，语义从「等于」变「包含」只在引擎内实现）；`ChannelOrderNo` 只作匹配键、不进剔除行结构（漂移守卫单测不受影响）；一级消歧失败（no/multi-credit）不 fallback 到二级。

---

## 三、代码现状（必须有出处）

| 需求 | 相关文件 | 当前行为 | 已知限制 |
|------|---------|---------|---------|
| 1 | `index.html:407-435`（`#backgroundTool .background-tool-actions`，现 3 个 `palette-trigger`：🎨/📕/🔄）；`src/renderer.js` ~5990-6032（按钮 click 绑定区）；`src/renderer-dialogs.js`（`createModuleCabinetDialog` ~10550 复用 `modal-overlay/modal-card/openModal/closeModal`）；`src/preload.js`（`desktopApi` 暴露区）；`src/main.js`（`trackedIpcHandle` 注册区）；`file-service/readers.js`（`extractHeaders`:364 / `readRows`:148）/ `writers.js`（`writeWorkbookRows`:223） | 无工具箱入口；合表/拆表能力不存在；readers/writers 已具备表头提取、行读取、工作簿写出能力。 | 无独立 Excel 行级搬运链路。 |
| 2 | `src/backend/database/migrations.js:378`（C3 `category:'gateway-recon-join'` seed）/ `:405` `ensureScenariosSupport` / `:409` CHECK 约束含 `'gateway-recon-join'`；`src/renderer-dialogs.js:6746` `createScenariosManagerDialog` / `:6870` `renderRow` / `:6984` `refreshTable` / `:5621` `FUNC_CATEGORY_LABELS`（功能类别中文映射，同在 renderer-dialogs.js 内）；`src/renderer.js:5825` 仅是 `openModal(createScenariosManagerDialog([...]))` 调用点 | C3 在新库默认 seed（enabled=0，R2 可选场景）且在列表显示可启用；场景列表扁平无分组折叠。 | C3 仍可被误启用；无功能分组折叠。 |
| 3 | `src/main.js:3644` `trackedIpcHandle('bank-statement:run', ...)`（同步箭头函数）；`:12302` `createRunProgressForwarder`（收单已有进度转发范式）；`src/main-process/reconciliation-orchestrator.js:271` `runReconciliation`（同步，无 onProgress）；`src/preload.js:377` `onRunProgress`（收单通道已有）；`src/renderer.js` `runBankStatementInternal` ~4101 | run handler 同步执行 R1-R5，无让出、无进度事件 → 运行期主进程阻塞、窗口「未响应」。 | 大数据量运行期 UI 假死。 |
| 4 | `src/main-process/exceljs-writer.js:233-256`（sheet1「未命中场景」）：`:239` A1 提醒、`:250-251` 第 2 行表头 `headerRow2.getCell(idx+1)`、`:255` 第 3 行起数据 `r.getCell(colIdx+1)` | A1 提醒 + 表头/数据均从 A 列（第 1 列）起。 | 提醒与数据挤同列，视觉不清。 |
| 5 | `src/main-process/scenario-engines/boc-dispatch-order-fix.js:238`（`Type: 2`，注释 `:5` / `:20` 标 `Type=2 / D9`） | 修复模板输出行 `Type` 写死 number `2`（v3.0.4 D9 拍板）；Type 仅落输出 Excel 给下游，src/ 内无按 `Type==2` 过滤逻辑。 | Type 值与业务语义（应为 1）不符。 |
| 6 | `src/main.js:3677` `const workingGwRows = structuredClone(database.readLinkedTableRows('gateway-bill'))`；`:3682` `const workingDepositRows = structuredClone(database.readLinkedTableRows('bank-deposit') || [])`；`:3767` `refundContext.depositRows`；`src/backend/database/linked-table-repository.js:933`（bank-deposit 65.7 万行 ~1.2GB 自标注）/ `readBankDepositAdmCandidates` ~940（仓储范式）；`reconciliation-orchestrator.js:173`（r5s4 分桶条件）/ `:443` `if (r5s4Bucket.length)`（depositRows 唯一消费门控） | bank-deposit 整表读 + 深拷无门控（关退款场景时读了+拷了一行没用）；gateway-bill 整表读 + 深拷。旁边三处大表读取（`workingMidRows`/`workingReconRows`/`workingDispatchReconRows`）均已有消费方门控，唯独 bank-deposit 没有（自 v2.1.16-beta.4 起无条件读）。 | bank-deposit 无谓 ~1.2GB 尖峰；gateway-bill 数百万行全量读 + 深拷撑爆低配 Windows 内存。 |
| 7 | `src/main-process/scenario-engines/r5-platform-inbound-cleanup.js:34` `buildCleanupRow`、`:72-79` 建索引（仅按 `ReconciliationId` 单 Map）、`:84-133` 匹配循环（单/多候选 + Credit 方向消歧）、`:130` 触发条件 `normalizeCellValue(bankRow.FundType) !== excludeFundType`（精确判等 `'Inbound'`）；`reconciliation-orchestrator.js:421-431`（R5 场景3 调用，透传 `gwTradeType`/`excludeFundType`）；`migrations.js:1544-1556`（seed `gwTradeType:'Inbound-VA'`、`excludeFundType:'Inbound'`） | 银行行只按 `ReconciliationId` 建索引（空键跳过）；逐网关行用 `gw.reconciliationid` 取候选、多候选按 Credit Amount 方向消歧（0/≥2 条有值发警告并跳过）；严格 1v1（`usedBankRowId`）；触发条件精确判等 `'Inbound'`。 | 对账号只认 `ReconciliationId` 单列，漏识别；精确判等 `'Inbound'`，变体被误剔除。`FundType` 枚举当前 12 值中只有 `'Inbound'` 含 "Inbound" 子串 → 子串变更对现有数据零行为变化（防御性扩展）。`ChannelOrderNo` 不在 `CLEANUP_COPY_HEADERS`（C~O 13 列）里，只作匹配键。 |

---

## 四、术语

| 术语 | 含义 |
|------|------|
| 工具箱🧰 | 脱离主对账流程的轻量 Excel 合表/拆表小工具，左下角🧰按钮入口（需求1） |
| 合表 | 把多个表头完全相同的 Excel/CSV 合并为一张（首文件表头 + 各文件数据行追加），导入即一气呵成到另存为 |
| 拆表 | 按某一字段的某些值，从一张表里筛出含这些值的行，导出为子集表（单选字段 + 多选值 → 单文件） |
| 合表表头校验 | 合并前校验所有待合并文件表头完全相同（含列名、列序），不同即 `FileValidationError`、前端 alert 停止、不产文件 |
| C3（`gateway-recon-join`） | 自带场景「与网关对账单根据金额币种一对一匹配对账ID」，R2 可选场景；本迭代退役隐藏（保留后端引擎/约束，可回滚），与 R1 强制匹配无关 |
| 功能分组折叠 | 场景管理弹框按 `config.funcCategory` 把场景归为「资金性质校验」「中台订单数据处理」两大组，组标题行带 ▶/▼ 三角，默认收纳（collapsed） |
| 资金性质校验组 | `funcCategory ∈ {fund-nature-check, dbs-charge-fund-check}` 的场景集合 |
| 中台订单数据处理组 | `funcCategory==='platform-order'` 的场景集合 |
| run 进度通道 | 新增 IPC 通道 `bank-statement:run:progress`，主进程在轮次边界向渲染进程推送进度文案（需求3） |
| bank-deposit 消费方门控 | run 入口仅当退款回填场景启用时才读 bank-deposit 入金表，否则注入 `[]`（需求6 修复1） |
| gateway 按 Channel 过滤读 | run 入口只读本批银行单出现过的 Channel 子集的网关行（业务不变量：对账永远同 Channel），新增仓储 `readGatewayBillRowsByChannels`（需求6 修复2） |
| 业务不变量（同 Channel） | 跨渠道对账永远不存在 —— 一条 Channel=X 的银行行只会匹配 Channel=X 的网关行；需求6 修复2 的 load-bearing 前提（业务负责人已确认） |
| 两级 fallback | R5s3 匹配键优先级：用 `gw.reconciliationid` 先撞银行 `ReconciliationId`（一级），一级「查无此行」才退到撞银行 `ChannelOrderNo`（二级）；网关侧无独立渠道订单号字段，故两级都用 `gw.reconciliationid` 这一个值（需求7） |
| 一级消歧失败不 fallback | 一级 `ReconciliationId` 桶找到 ≥2 候选但 Credit 方向消歧失败（0/≥2 条 Credit）时视为数据脏，保持警告并跳过，不退到二级（D-3；fallback 只补「查无此行」不补「找到了但有歧义」） |
| FundType 子串判定 | R5s3 触发条件由「`FundType !== 'Inbound'` 才剔除」改为「`FundType` 不包含 `excludeFundType` 子串才剔除」，大小写不敏感（`ft.toLowerCase().includes(ex.toLowerCase())`），`ex===''` 兜底全产（需求7） |

---

## 五、功能详细描述

### 5.1 需求 1：工具箱🧰（合表 / 拆表）— 全新功能

#### 5.1.1 说明

- **输入**：合表 = 用户多选 ≥2 个表头一致的 Excel/CSV；拆表 = 用户单选 1 个 Excel/CSV + 选定字段 + 选定该字段的若干值。
- **输出**：合表 = 合并后单文件（另存为，默认名 `合并-{YYYYMMDDHHmm}.xlsx`）；拆表 = 子集单文件（另存为，默认名 `拆分-{选取字段的值拼接 sanitize}-{YYYYMMDDHHmm}.xlsx`）。
- **边界条件**：
  - 合表所有文件表头必须完全相同（列名 + 列序）；不同 → `FileValidationError` → 前端 alert 列差异并停止，不产文件。
  - 拆表多选值 → 单文件（含所有选中值的行）；文件名值用分隔符拼接后 `sanitizeFileName`。
  - 取消另存为对话框 → 不产文件、无报错。
  - 时间戳 `YYYYMMDDHHmm`（12 位）由 main 侧 helper 生成。

#### 5.1.2 影响范围

- 前端：`index.html`（加🧰按钮）、`src/renderer.js`（按钮 click → 打开工具箱弹框）、`src/renderer-dialogs.js`（新增 `createToolboxDialog` 主弹框 + `createSplitFieldPickerDialog` 拆表选字段弹框）、`src/styles-gemini-extra.css`（`.toolbox-card` 等样式 —— 注意：生效主题是 styles-gemini-extra.css）、preview 入口（新增弹框补 4 处约定）。
- 后端：`src/preload.js`（暴露 `desktopApi.toolbox`）、`src/main.js`（`trackedIpcHandle` 加 3 个 handler）、复用 `file-service`（readers/writers）。
- 对外接口影响：新增 3 个 IPC（`toolbox:merge` / `toolbox:split:read` / `toolbox:split:export`），不改既有接口。
- 兼容性影响：纯新增功能，对既有对账/导出链路零影响。

#### 5.1.3 交互与规则（权威细则）

**A. 入口**：`index.html` `#backgroundTool .background-tool-actions`（行 407-435，现 🎨/📕/🔄 三个 `palette-trigger`）追加第 4 个 `<button id="toolboxBtn" class="palette-trigger">🧰</button>`；`renderer.js` ~5990-6032 绑 click → `openModal(createToolboxDialog())`。

**B. 主弹框 `createToolboxDialog()`**（标题「工具箱」，复用 `modal-overlay/modal-card/dialog-*` + `openModal/closeModal`，参考 `createModuleCabinetDialog`）布局两行：

| 行 | 控件 | 行为 |
|----|------|------|
| 合并表格行 | `[导入文件]` 单按钮 | 点击 → 多选文件 → 表头校验 → 合并 → 另存为，**一气呵成**（无独立导出按钮） |
| 拆分表格行 | `[导入文件]` + 其正下方 `[导出文件]` | `[导入文件]` → 单选文件 → 读表头与各字段去重值 → 弹出选字段弹框；选定后 `[导出文件]` 可用 → 过滤导出另存为 |

**C. 拆表选字段弹框 `createSplitFieldPickerDialog({headers, valuesByField, onComplete, onCancel})`**：
- 单选下拉（选项 = 表头列名）；
- 多选下拉（选项 = 该字段去重值，随单选字段切换刷新）；
- `[完成]`（回传 `{field, values[]}`）/ `[取消]`（关闭不产）。
- **空值 / 空选边界**：① 某字段无去重值（该列全空 → `valuesByField[field]` 为空数组）时，该字段对应的多选下拉为空、不可选；② 用户未选任何值（`values=[]`）时 `[完成]` 禁用或点击提示「请至少选择一个值」，**不允许以空选导出**（否则过滤命中 0 行 → 导出空 sheet）。

**D. 后端 3 个 IPC**（`preload` 暴露 `desktopApi.toolbox`，`main.js` 用 `trackedIpcHandle` 注册）：
- `toolbox:merge`：`showOpenDialog`（多选）→ 各文件 `extractHeaders`（readers.js:364）校验全相同（不同 → `FileValidationError` → 前端 alert 停止）→ `readRows`（readers.js:148）合并（首文件表头 + 各文件数据行）→ `writeWorkbookRows`（经 file-service facade `file-service.js:810` 调用，不直接 require writers.js:223 实现）→ `showSaveDialog`（默认名 `合并-{YYYYMMDDHHmm}.xlsx`）。
- `toolbox:split:read`：`showOpenDialog`（单选）→ `extractHeaders` + `readRows` → 算各字段去重值 → 返回 `{sourceFilePath, headers, valuesByField}`。
- `toolbox:split:export`：`{sourceFilePath, field, values[]}` → `readRows` 过滤 `row[field] ∈ values` → `writeWorkbookRows` → `showSaveDialog`（默认名 `拆分-{values 拼接 sanitize}-{YYYYMMDDHHmm}.xlsx`）。

**E. 文件名模板**：
- 合并：`合并-YYYYMMDDHHmm.xlsx`
- 拆分：`拆分-{选取字段的值}-YYYYMMDDHHmm.xlsx`（多值拼接 + `sanitizeFileName`）

#### 5.1.4 UI Mockup

```
[主界面左下角 background-tool-actions]
  🎨  📕  🔄  🧰  ← 新增工具箱按钮

[工具箱弹框]
  ┌── 工具箱 ────────────────────────────┐
  │ 合并表格   [导入文件]                  │  ← 导入即一气呵成到另存为
  │ 拆分表格   [导入文件]                  │
  │            [导出文件]                  │  ← 在导入按钮正下方，选完字段后可用
  └────────────────────────────────────────┘

[拆表选字段弹框]（点拆分表格的[导入文件]后）
  ┌── 选择拆分字段 ──────────────────────┐
  │ 字段：[单选下拉 = 表头列名 ▾]          │
  │ 值：  [多选下拉 = 该字段去重值 ▾]      │
  │                        [完成] [取消]   │
  └────────────────────────────────────────┘
```

---

### 5.2 需求 2：场景管理 — 退役 C3 + 分组折叠

#### 5.2.1 说明

- **输入**：用户打开「场景管理」弹框（`renderer.js:5825` 调用点 → `createScenariosManagerDialog`，弹框定义在 `renderer-dialogs.js:6746`）。
- **输出**：列表不再出现 C3；其余场景按两大功能分组归类，组标题带三角，默认收纳。
- **边界条件**：C3 **纯前端 UI 过滤隐藏**（`migrations.js` 完全不动，引擎/dispatcher/CHECK 约束/seed/已有库记录全保留，可回滚、零 migration 风险）；折叠状态为前端临时状态（不持久化）。

#### 5.2.2 影响范围

- 前端：`src/renderer-dialogs.js`（`refreshTable` 过滤 C3 + 分组折叠渲染）、`src/styles-gemini-extra.css`（`.scenario-group-header`/`.scenario-group-toggle`/`.collapsed`）、preview 入口（回归）。
- 后端：**无**（实施期决策改为纯前端过滤退役，`migrations.js` 一行不改）。
- 对外接口影响：无。
- 兼容性影响：旧库 + 新库 C3 记录均保留（前端隐藏不删、seed 照常，可回滚）；C3 引擎/约束/seed 零改动。

#### 5.2.3 交互与规则

**A. 退役 C3**（`gateway-recon-join`，`migrations.js:378` seed，默认 enabled=0，R2 可选场景，与 R1 强制匹配无关）—— **纯前端过滤退役**（实施期决策，见 §十二实施记录）：
- 前端 `createScenariosManagerDialog`（renderer-dialogs.js:6746+，`refreshTable`）过滤 `category==='gateway-recon-join'` 不显示（实现落在 renderer-dialogs.js:7045 `scenariosRaw.filter`）；
- **后端 `migrations.js` 完全不动**（决策原因：纯前端过滤更可回滚、零 migration 风险；seed/CHECK/case 全保留，回滚只需撤一行前端 filter）；
- **不动**：c3 引擎（`c3-gateway-recon-join.js`）/ dispatcher case / CHECK 约束（`migrations.js:409`）/ seed（`migrations.js:378`，新库照常 seed C3，仅前端隐藏）/ 已有库记录（保留可回滚）。
- **已知取舍**：新建场景下拉（renderer-dialogs.js:8005）仍含 C3 选项、`createScenarioConfigDialogC3()`（renderer-dialogs.js:238）仍可达 —— 本迭代仅退役「列表展示」，不封「新建入口」（OPEN-2）。

**B. 分组折叠**（现状扁平表格 → 分组）：
- 改 `refreshTable` 按 `config.funcCategory` 分组：`fund-nature-check` + `dbs-charge-fund-check` → 「资金性质校验」；`platform-order` → 「中台订单数据处理」（中文映射见 `renderer-dialogs.js:5621` `FUNC_CATEGORY_LABELS`）；
- 插入分组标题行 + ▶/▼ 三角；子场景行按折叠态显隐；两组**默认 collapsed**；
- CSS 加 `.scenario-group-header`/`.scenario-group-toggle`/`.collapsed`；preview 回归。

#### 5.2.4 UI Mockup

```
[场景管理弹框 · 默认收纳]
  ▶ 资金性质校验            （组标题，默认折叠，点▶展开）
  ▶ 中台订单数据处理        （组标题，默认折叠）

[展开「资金性质校验」组后]
  ▼ 资金性质校验
      Ach Return …          [未启动] [管理]
      Wire Return …         [未启动] [管理]
      DBS-Charge资金校验      [已启用] [管理]
      …
  ▶ 中台订单数据处理

（C3「与网关对账单根据金额币种一对一匹配对账ID」不再出现）
```

---

### 5.3 需求 3：资金对账「开始运行」不阻塞（🔴 资金红线）

> **需求 3 与需求 6 改同一 `bank-statement:run` handler，必须协同实施 —— 先 6 后 3。** 见 §5.6 与 §八实施约束。

#### 5.3.1 说明

- **输入**：用户点「开始运行」（`bank-statement:run`）。
- **输出**：运行期窗口始终可响应；状态框随轮次推进更新进度文案；最终对账产物与改造前 **golden 字节一致**。
- **边界条件**：仅插 yield + 进度上报，轮次顺序 / 引擎入参 / 数据逻辑零改动；不上 worker。

#### 5.3.2 影响范围

- 后端：`src/main.js`（`bank-statement:run` handler 改 async + 阶段边界让出 + 进度转发器）、`src/main-process/reconciliation-orchestrator.js`（`runReconciliation` 改 async / 注入 `onProgress`，仅轮次边界插 yield + 上报）、`src/preload.js`（暴露 `bankStatement.onRunProgress`，仿收单）。
- 前端：`src/renderer.js`（`runBankStatementInternal` ~4101 订阅 `bank-statement:run:progress` 更新状态框，仿收单 `handleAcquiringBillCurrencyRun` 行 5340-5387）。
- 对外接口影响：新增进度通道 `bank-statement:run:progress`（单向 main→renderer）。
- 兼容性影响：结果零变化（golden 一致）。

#### 5.3.3 交互与规则

- `bank-statement:run` handler 改 **`async`**；阶段边界 `await new Promise(r => setImmediate(r))` 让出事件循环。
- `reconciliation-orchestrator.js` `runReconciliation` 改 async / 注入 `onProgress`，**在轮次边界**插 yield + 进度上报，实际边界顺序 **R1→R2(dispatcher)→R3.5→R4→R5**（R5 内细分子轮 s2@359 / s2b@404 / s3@423 / s4@448 须逐子轮各插一次，R2 在 R1 与 R3.5 之间）（轮次顺序、引擎入参、数据逻辑零改动）。
- 进度转发仿 `createRunProgressForwarder`（main.js:12302），新通道 `bank-statement:run:progress`；`preload` 暴露 `bankStatement.onRunProgress`；`renderer.js` `runBankStatementInternal` 订阅更新状态框（仿收单 `handleAcquiringBillCurrencyRun` 5340-5387）。

---

### 5.4 需求 4：银行未命中场景 sheet — 提醒 A1，数据右移 B 列（🔴 输出口径）

#### 5.4.1 说明

- **输入**：导出银行对账单处理结果（含未命中场景行）。
- **输出**：sheet1「未命中场景」A1 提醒不变；表头第 2 行、数据第 3 行均从 **B 列**起；A 列除 A1 留空。
- **边界条件**：仅 sheet1；行不变（只右移列）= 最小改动。

#### 5.4.2 影响范围

- 后端：`src/main-process/exceljs-writer.js`（`writeBankStatementOutput` sheet1 区，行 233-256）。
- 对外契约变更（🔴 CHANGELOG 标注）：未命中场景 sheet 列位整体右移一列（外部按 A 列解析的脚本需适配）。
- 零改动面：sheet2「命中场景」（首列「命中明细」不涉及）、A1 提醒文案、行号。

#### 5.4.3 交互与规则

- `exceljs-writer.js` sheet1「未命中场景」（行 233-256）：A1 提醒不变；表头 `headerRow2.getCell(idx+1) → idx+2`（行 251）、数据 `r.getCell(colIdx+1) → colIdx+2`（行 255）。
- 效果：A 列除 A1 留空，表头第 2 行 / 数据第 3 行均从 B 列起（仅右移列、行不变）。
- 范围：仅 sheet1（sheet2 命中场景首列是「命中明细」，不涉及）；golden 回归更新。

#### 5.4.4 UI Mockup

```
未命中场景 sheet：
  旧：                          新：
  A1: [提醒]                    A1: [提醒]
  A2: 列1 | B2: 列2 …           A2:（空） | B2: 列1 | C2: 列2 …
  A3: 数据 | B3: 数据 …          A3:（空） | B3: 数据 | C3: 数据 …
```

---

### 5.5 需求 5：BOC 调拨修复行 Type 改 1（🔴 资金红线）

#### 5.5.1 说明

- **输入**：运行 BOC 调拨订单修复引擎，产出修复模板行。
- **输出**：修复模板 `Type` 列写值 `1`（原 `2`）。
- **边界条件**：Type 仅落输出 Excel 给下游，src/ 内无按 `Type==2` 过滤逻辑；改值不影响匹配/组失败语义。

#### 5.5.2 影响范围

- 后端：`src/main-process/scenario-engines/boc-dispatch-order-fix.js`（`:238` Type 值 + `:5`/`:20` 注释）。
- 测试：单测断言（Type=1）+ golden 更新。
- 对外契约变更（🔴 CHANGELOG 标注）：BOC 修复模板 Type 由 2 → 1。

#### 5.5.3 交互与规则

- `boc-dispatch-order-fix.js:238` `Type: 2 → 1` + 同步注释（行 5/20「Type=2 / D9」改为 Type=1）。
- Type 落输出 Excel 给下游，src/ 内无按 `Type==2` 过滤逻辑。
- **需用户最终确认 Type=1 业务语义**；同步改单测断言 + golden。

---

### 5.6 需求 6：运行内存尖峰修复（并入 spec A）（🔴 资金红线）

> **与需求 3 改同一 handler，先做需求 6（减载入）、后做需求 3（异步化）。** spec 全文见 `changes/v3.0.7-run-linked-memory-fix/spec.md`。

#### 5.6.1 说明

- **输入**：用户点「开始运行」（`bank-statement:run`）。
- **输出**：关退款场景时 bank-deposit 不再无谓载入（注入 `[]`）；网关账单表只读本批银行单出现过的 Channel 子集且不深拷；对账结果与修复前一致（修复1 字节级不变、修复2 业务不变量等价）。
- **边界条件**：见三个陷阱（§5.6.3 B）。

#### 5.6.2 影响范围

- 后端：`src/main.js`（`:3682` bank-deposit 加门控、`:3677` gateway 改过滤读 + 删深拷）、`src/backend/database/linked-table-repository.js`（新增 `readGatewayBillRowsByChannels`，仿 `readBankDepositAdmCandidates` ~940）、`src/backend/database.js`（facade）。
- 对外接口影响：无（仓储内部函数）。
- 兼容性影响：修复1 字节级不变；修复2 带业务不变量（同 Channel），非纯字节不变（须等价测试背书）。

#### 5.6.3 交互与规则

**A. 修复 1 — bank-deposit 消费方门控**（`main.js:3682`）：加 `refundBackfillEnabled` 谓词，**逐字镜像**编排器 `bucketScenarios` 的 r5s4 分桶条件（`reconciliation-orchestrator.js:173`：`category==='builtin-fixed' && config.funcCategory==='platform-order' && config.subCategory==='refund-order-backfill'`）；关闭退款场景时注入 `[]` 替代 `structuredClone(readLinkedTableRows('bank-deposit'))`（曾 65.7 万行 ~1.2GB）。`dispatchScenarios`（main.js:3669）已是 enabled 过滤后集合，无须再判 enabled（与 `paymentOfflineEnabled`/`dbsChargeScenarioEnabled` 同范式）。**结果字节级不变**（退款场景关时编排器本就 no-op，注入 `[]` 与现状等价）。

**B. 修复 2 — gateway-bill 按 Channel 过滤读 + 不深拷**（`main.js:3677` + 新仓储 `readGatewayBillRowsByChannels`）：
- **业务不变量**（业务负责人已确认，load-bearing 前提）：跨渠道对账永远不存在 —— 一条 Channel=X 的银行行只会匹配 Channel=X 的网关行。
- 收集本批银行单出现的全部 Channel 值集合 S，只读 `Channel ∈ S` 的网关行。安全性：任一银行行 B 的合法网关对手 G 的 Channel = B.Channel ∈ S → 不漏任何合法匹配；唯一被滤掉的是「跨渠道匹配」（业务确认不存在）。
- `gwRows` 全程只读（R1/R2/R3.5/R5s2/R5s3 仅建索引/比对，modifications 只写 bankRows）+ 每次新解析 → 删 `structuredClone`。
- **三个陷阱必须实现**（spec §四）：
  1. **空 / 缺 Channel**：银行行 Channel 为空时 S 含空值；SQL `json_extract` 对「缺字段」返回 NULL（`NULL IN (...)` 恒 false）→ S 含空值时须额外 `OR json_extract(...) IS NULL` + `OR ... = ''`，覆盖「网关行缺 Channel 字段」与「Channel=空串」两种。
  2. **归一化一致**：S 内 Channel 值与网关 raw_json 存值同口径（trim、大小写敏感），与引擎 `normalizeCell` 对齐。
  3. **跨轮无越界 Channel 需求**：逐轮确认无哪一轮会用到「银行单未出现的 Channel」的网关行（R3.5 先过滤 DBS 银行行、无即 no-op；C3 按渠道批处理；R1/R5s2/R5s3 匹配键不含 Channel 但业务不变量下合法对手必同 Channel）。

> 🔴 **银行行 `structuredClone(bankStatementSession.rows)` 必须保留**（常驻 session、引擎原地改它）。

---

### 5.7 需求 7：R5s3 两级 fallback + FundType 子串（🔴 资金红线）

> spec 全文（含伪代码 D-1~D-3 / D-2~D-2c）见 `changes/r5s3-channelorderno-fallback-inbound-substring/spec.md`。用户 2026-06-16 逐条拍板 D-1~D-3。

#### 5.7.1 说明

- **输入**：R5 场景3（中台加款单脏数据处理）运行，网关行 + R4 后银行行。
- **输出**：扩大脏数据识别面（两级 fallback）；防入金变体误剔除（子串判定）；剔除模板（`中台加款单剔除模板-*.xlsx`）行正确。
- **边界条件**：一级消歧失败不 fallback；严格 1v1 跨两级共享；`ChannelOrderNo` 只作匹配键不进剔除行。

#### 5.7.2 影响范围

- 后端：`src/main-process/scenario-engines/r5-platform-inbound-cleanup.js`（唯一引擎改动，三处：建双键索引 / 匹配循环两级 fallback / 触发条件子串判定）。
- 测试：`r5-platform-inbound-cleanup.test.js`（改 3 + 新增 7，fixture 加可选 `channelOrderNo`）。
- 不动：`buildCleanupRow` / 配置 seed（`excludeFundType:'Inbound'` 字段名与值不变）。

#### 5.7.3 规则（用户拍板 truth）

**变更1：两级 fallback 匹配键**

| 编号 | 规则 |
|------|------|
| D-1 | 用网关同一个 `reconciliationid` 值，**优先**匹配银行 `ReconciliationId`；匹配不上**再**用同一个值匹配银行 `ChannelOrderNo`；两者都不上才算匹配失败（跳过该网关行）。网关侧无独立渠道订单号字段，故两级都用 `gw.reconciliationid` 这一个值。 |
| D-1a | **fallback 触发边界**：仅当一级 `ReconciliationId` 桶「无可用候选」（桶空 OR 候选已被前面网关行消费空，即 `pickFromCandidates` 返回 `skip:'empty'`）时，才退到 `ChannelOrderNo` 桶。 |
| D-3 | **一级桶消歧失败不 fallback**：一级桶找到 ≥2 候选但 Credit 方向消歧失败（0 或 ≥2 条 Credit 有值）时视为数据脏，保持 `no-credit-match`/`multi-credit-match` 警告并**跳过**，**不**退到 `ChannelOrderNo`。fallback 只补「查无此行」，不补「找到了但有歧义」。 |
| D-1b | **二级桶同样套用 Credit 方向消歧**：`ChannelOrderNo` 桶多候选时复用同一套消歧逻辑；二级警告复用同名 code（`no-credit-match`/`multi-credit-match`），message 补「(按 ChannelOrderNo 匹配)」标记；不新增 code。 |
| D-1c | **严格 1v1 跨两级共享**：`usedBankRowId` 在两级共用同一个 Set，一个银行行只能被消费一次。 |

**变更2：FundType 子串判定（大小写不敏感）**

| 编号 | 规则 |
|------|------|
| D-2 | 触发条件从「`FundType !== 'Inbound'` 才剔除」改为「`FundType` **不包含** `excludeFundType` 子串才剔除」（含子串 → 视为入金、不产剔除行）。 |
| D-2a | **大小写不敏感**：`inbound` / `INBOUND` / `Inbound` 任一形态都算命中子串、都不剔除。实现用 `ft.toLowerCase().includes(ex.toLowerCase())`。 |
| D-2b | **配置不变**：`excludeFundType` 字段名与 seed 值 `'Inbound'` 保持不变（`migrations.js:1553`），语义从「等于此值」变为「包含此子串」只在引擎内实现。 |
| D-2c | **空配置兜底**：`excludeFundType` 被清空（`ex===''`）时显式走「全部命中行都产剔除行」分支，与旧默认方向一致，避免 `includes('')` 恒真导致全不产的反转。 |

---

### 5.8 需求 8：使用手册补全 + 全册去技术术语（v3.0.8 第二轮追加）

> 第二轮追加需求。面向非技术财务 / 业务读者，文档侧改造，**不碰业务代码**。仅改 `docs/USER_GUIDE.md`（+ 沉淀 SOP 到 `knowledge/`）。

#### 5.8.1 说明

- **输入**：现状 `docs/USER_GUIDE.md` —— v3.0.4~v3.0.8 各功能章节虽已存在，但满是工程术语（IPC / handler / session / orchestrator / sheet / 字段 / 归一化 / 门控 / 轮次编号 R1/R5s3 等）；且「中台订单数据处理」功能组缺一个面向用户的总览导航（4 个子场景散落在正文各处，用户不知道它们同属一类、何时用哪个）；1.6 节缺银行对账单 46 列兼容性的用户侧说明。
- **输出**：① 1.4 节新增「中台订单数据处理」总览导航小节；② 全册技术术语清理为业务白话（核心禁用词全册清零）；③ 1.6.1 加银行对账单 46 列兼容说明。改后手册零术语、零功能信息丢失、章节零丢失。
- **边界条件**：
  - **只去术语、不删功能信息**（替换措辞，不删功能说明 / 不改资金敏感口径）。
  - **软件界面真实文字 / Excel 真实列名 / 渠道数据真值必须保留**（删了用户对不上屏幕 / 对不上数据），但旁边配中文解释（如 `Credit Amount`、`Remark-BU`、`ADM`、`Inbound-VA`、对账ID 作真实列名引用时保留）。
  - **历史 changelog / 版本注记不强行洗**（用户 2026-06-17 拍板：仅洗正文，历史流水账保留）。
  - 故障排查给维护人员的真实命令（`sqlite3` / `jq` / settings-key）保留，用「给维护人员看」括注隔离。

#### 5.8.2 影响范围

- 文档：`docs/USER_GUIDE.md`（全册术语清理 + 1.4 新增总览小节 + 1.6.1 加 46 列兼容说明）。
- 知识沉淀：`knowledge/user-guide-dejargon-playbook.md`（去术语 SOP，供后续每次写 / 改手册复用）。
- 业务代码 / 接口 / 数据：**零改动**（纯文档需求）。
- 兼容性影响：无（仅文档措辞）。

#### 5.8.3 交互与规则（权威细则）

**A. 1.4 新增「中台订单数据处理」总览导航小节**：用一句话讲清这一类（中台调拨 / 退款 / 线下调拨订单回填 + 中台加款单脏数据剔除）4 个场景各自的作用 + 何时用，并指向各自的详解小节；零术语；与另一组「资金性质校验」并列点出，让用户先建立「这是一组同类场景」的认知，再按「场景管理开启 → 准备中台订单数据 → 导入文件 → 开始运行 → 导出文件」统一操作。

**B. 全册技术术语清理（SOP 见 playbook）**：
- **执行流程**：6 段并行只读审查（按大节 `##` 切 ~6 段，每段一个只读 agent 产出精确 `old→new` 替换对，共约 567 处）→ 单 agent 串行应用（一个写者收全部替换对逐个改，跨段同词统一译法，禁止多 agent 并行写同一文件以免互相覆盖）→ grep 验证。
- **禁用词清单（出现即清）**：工程概念（IPC / handler / 接口·通道 / session·会话 / orchestrator·编排 / dispatcher·调度 / worker / async·异步 / 事件循环 / 谓词 / 门控 / normalize·归一化 / 下推 / 仓储·repository / structuredClone·深拷 / 内存尖峰 / 字节级 / golden / migration·迁移 / seed / 状态机 等）、数据结构（sheet / 字段 / 字段映射·列映射 / raw_json / json_extract）、内部标识（轮次编号 R1/R2/R3.5/R5s2/R5s3、「5 轮对账」、first-match-wins、builtin-fixed、scenario.category）、工程标记（🔴资金红线 / PR#NN / 「需求 N」 / 「D-1」 / 「OPEN-x」 / 版本需求编号）。
- **保留清单（保留 + 配中文解释）**：软件界面真实按钮 / 弹窗 / 场景名、Excel 真实列名、渠道 / 数据真值、给维护人员的真实命令。
- **统一译法**（保持全册一致，节选）：sheet→工作表；字段→列、字段映射 / 列映射→列的对应关系；FundType→资金性质；Channel→渠道；fallback→对不上时再用…兜一道；orchestrator·轮次→对账的某一步 / 运行流程；golden·字节一致→和以前结果一样；raw_json→原始数据。

**C. 1.6.1 加银行对账单 46 列兼容说明**：以用户能懂的话说明「新版渠道对账单从 44 列升到 46 列（多了合并相关两列），软件能正常识别并导入，多出的两列会被忽略、不影响对账结果」（与需求 9 的用户侧体感对应）。

#### 5.8.4 验收要点

- 核心禁用词 grep 全册清零（排除保留清单 + 已配解释项）。
- 章节零丢失：`##` 标题数 20 = 20（改前后一致）；`###` 标题数 135 → 136（仅 1.4 新增总览小节 +1，无丢失）。
- 代码围栏（```）数量为偶数（成对闭合，无破坏 markdown 结构）。
- 资金敏感章节（对账 / 退款 / 剔除 / 余额 / Type）信息完整、口径不被洗改变义。

---

### 5.9 需求 9：银行对账单模板 44 → 46 列（识别 + 字段下拉可选 + BU 回填兼容导入，不落库）（🔴 资金红线）

> 第二轮追加需求。`assets/银行对账单.xlsx`「渠道对账单」sheet 从 44 列升级到 46 列。用户决策：**识别 + 字段下拉可选 + BU 回填兼容导入忽略两列、不落库**（不碰 `bank_bu_recon_bank_imports` 数据库结构）。

#### 5.9.1 说明

- **输入**：新版 `assets/银行对账单.xlsx`「渠道对账单」sheet —— 在原 `'Transaction Description'` 列后插入「合并单号」「合并状态」两列，由 44 列变 46 列；旧版 44 列文件仍可能在用。
- **输出**：① 银行对账单识别（table-signatures）对新旧文件均能识别；② 银行对账单字段下拉（C3 场景配置等用到 `BANK_STATEMENT_FIELDS` 的下拉）可选到新增两列；③ 月度银行对账单 BU 回填校验兼容导入新版 46 列文件，**多出的「合并单号」「合并状态」两列被忽略、不写入数据库**（DB 列结构保持 44 列不动）。
- **边界条件 / 关键不变量**：
  - 🔴 **合并单号 / 合并状态不进 DB**（不碰 `bank_bu_recon_bank_imports` 列结构 / `columns.js` 的 `BANK_HEADERS` 保持 44 列）。
  - 🔴 **旧版 44 列文件行为完全不变**（识别 / 导入 / 回填零回归）。
  - 🔴 **Pending 数据管理导入保持严格校验**（列数必须相等 + 逐列名相等），不受本次宽容超集改动波及。
  - `release-check` 全绿。

#### 5.9.2 影响范围

- 字段定义：`src/constants/bank-statement-fields.js`（`BANK_STATEMENT_FIELDS` 44 → 46，在 `'Transaction Description'` 后插「合并单号」「合并状态」）；`src/preload.js`（暴露给渲染进程的 inline 副本逐项同步，与上面逐列一致）。
- 识别：`src/constants/table-signatures.js`（注释 44 → 46；`expectedHeaders` 复用 `[...BANK_STATEMENT_FIELDS]` 自动跟随；`signatureHeaders` 指纹列不变 → 新旧文件均可识别）。
- BU 回填导入：`src/backend/bank-bu-recon-import/validator.js`（`buildHeaderValidator` 加 `options.allowSupersetColumns`）、`src/backend/bank-bu-recon-import/reader.js`（改按列名定位取值）；`src/backend/bank-bu-recon-db/columns.js`（`BANK_HEADERS` 保持 44 列不动 = 不落库）。
- 测试：`tests/unit/constants/bank-statement-fields.test.js`（断言 46）、`tests/unit/backend/bank-bu-recon-import/validator.test.js`（宽容超集契约）、`tests/unit/backend/bank-bu-recon-import/header-superset-mapping.test.js`（新增，按列名映射）。
- 对外接口影响：无新接口。
- 兼容性影响：新版 46 列与旧版 44 列文件均可识别 / 导入；DB 结构与已落库数据零变化。

#### 5.9.3 交互与规则（权威细则）

**A. 字段定义 44 → 46（识别 + 下拉自动跟随）**：
- `BANK_STATEMENT_FIELDS` 在 `'Transaction Description'` 后插入「合并单号」「合并状态」共 46 项；`preload.js` inline 副本逐项同步（两处必须逐列一致，否则渲染进程下拉与主进程口径分叉）。
- `table-signatures.js` 银行对账单 / 入金表两处 `expectedHeaders: [...BANK_STATEMENT_FIELDS]` 自动跟随到 46；**`signatureHeaders` 指纹列保持不变**（`ReconciliationId` / `Credit Amount` / `Debit Amount` / `拆分信息` / `关联大账号`，均非新增两列）→ 指纹不变意味着新旧两版文件都能命中识别（指纹列在两版里都存在）。
- 字段下拉复用 `BANK_STATEMENT_FIELDS` 全枚举，自动多出「合并单号」「合并状态」两个可选项。

**B. BU 回填兼容导入（宽容超集 + 按列名取值 + 不落库）**：
- **校验（`validator.js` `allowSupersetColumns`）**：`buildHeaderValidator` 加第三参 `options.allowSupersetColumns`。
  - `false`（默认，Pending 用）：列数必须相等 + 逐列名相等 —— 行为完全不变、零回归。
  - `true`（银行对账单用）：不要求列数相等；要求模板列（`BANK_HEADERS` 44 列）每个都出现在文件表头里、且是文件表头的**有序子序列**（按模板顺序逐个在文件表头里依次往后找到，保持相对顺序、防乱序文件）；多出的列（合并单号 / 合并状态）忽略。`validateBankHeaders` 启用 `{ allowSupersetColumns: true }`，`validatePendingGuanliHeaders` 保持严格。
- **取值（`reader.js` 按列名定位）**：行映射改为按列名 → 文件表头索引（`headerIndexMap`）定位取值，**不再按固定列索引**。原因：46 列文件在中间插了两列，按固定索引会让 `Extra Information` / `Remark-BU` 等后移列整体错位（资金对账错列 = 红线事故）；按列名定位则两列插在哪都不影响其余列取值。
- **不落库（`columns.js` 不动）**：`BANK_HEADERS` 仍是 44 列、DB 列结构（`bank_bu_recon_bank_imports`）保持 44 列，合并单号 / 合并状态读到也不写入 → 数据库零变化。

#### 5.9.4 验收要点（见 §6.9 AC）

- 新版 46 列：识别命中 + 字段下拉可选到两列 + BU 回填导入成功且忽略两列不落库。
- 旧版 44 列：识别 / 导入 / 回填行为完全不变。
- Pending 严格校验不受波及。
- DB 列结构 / 已落库数据零变化。

---

## 六、验收标准

> 本章节共 **47 条** AC（8+5+4+3+3+6+8+4+6）。第二轮追加需求 8（6.8，4 条）/ 需求 9（6.9，6 条）。

### 6.1 需求 1：工具箱🧰 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC1-1 | 左下角 background-tool-actions 出现🧰按钮，点击打开「工具箱」弹框（含合并表格行 + 拆分表格行） |
| AC1-2 | 合并表格行点 `[导入文件]` → 多选 ≥2 表头一致文件 → 自动合并 → 另存为对话框默认名 `合并-{YYYYMMDDHHmm}.xlsx`；产物 = 首文件表头 + 各文件数据行 |
| AC1-3 | 合表表头不一致 → `FileValidationError` → 前端 alert 列差异并停止，不产文件 |
| AC1-4 | 拆分表格行点 `[导入文件]` → 单选文件 → 弹出选字段弹框（单选字段下拉 + 多选值下拉，值随字段切换刷新） |
| AC1-5 | 选字段弹框点 `[完成]` 回传 `{field, values[]}`；`[取消]` 关闭不产 |
| AC1-6 | 选完字段后 `[导出文件]` 可用 → 过滤 `row[field] ∈ values` → 另存为默认名 `拆分-{值拼接 sanitize}-{YYYYMMDDHHmm}.xlsx`；产物含全部选中值的行（单文件） |
| AC1-7 | 取消另存为对话框不产文件、无报错 |
| AC1-8 | 工具箱新弹框 preview 截图无布局回归（4 处 preview 入口已补） |

### 6.2 需求 2：场景管理 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC2-1 | 场景管理列表不再出现 C3「与网关对账单根据金额币种一对一匹配对账ID」 |
| AC2-2 | 列表按「资金性质校验」「中台订单数据处理」两组分组，组标题带 ▶/▼ 三角 |
| AC2-3 | 两组默认 collapsed（收纳）；点三角可展开/折叠对应组子场景 |
| AC2-4 | 纯前端过滤退役：新库 + 旧库 C3 记录均保留（seed 照常、不删），仅 `refreshTable` 过滤不显示（`migrations.js` 零改动，引擎/约束/seed 全保留，可回滚） |
| AC2-5 | 场景管理 preview 截图无布局回归 |

### 6.3 需求 3：运行不阻塞 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC3-1 | `bank-statement:run` 运行期窗口可响应（可拖动、不显示「未响应」） |
| AC3-2 | 运行期状态框随轮次推进更新进度文案（订阅 `bank-statement:run:progress`） |
| AC3-3 | 对账产物与改造前 **golden 字节一致**（轮次顺序/引擎入参/数据逻辑零改动） |
| AC3-4 | 编排器异步化后单测（轮次统计/顺序）全绿 |

### 6.4 需求 4：未命中 sheet 布局 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC4-1 | 未命中场景 sheet1：A1 提醒不变，表头第 2 行从 B 列起、数据第 3 行从 B 列起，A 列除 A1 留空 |
| AC4-2 | sheet2「命中场景」零变化（首列「命中明细」不右移） |
| AC4-3 | golden 回归更新且通过（仅 sheet1 列位变化） |

### 6.5 需求 5：BOC Type AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC5-1 | BOC 调拨订单修复模板行 `Type` 列写值 `1`（原 `2`） |
| AC5-2 | 单测断言 Type=1 通过；golden 更新通过 |
| AC5-3 | 匹配/组失败语义零变化（仅 Type 值改） |

### 6.6 需求 6：内存尖峰修复 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC6-1 | 关退款场景时 `workingDepositRows` 注入 `[]`（不读 bank-deposit）；门控谓词与 `bucketScenarios(...).r5s4.length>0` 一致（同源断言通过） |
| AC6-2 | 启用退款场景时照常读 bank-deposit、退款回填正常命中（行为不变） |
| AC6-3 | `readGatewayBillRowsByChannels` 仓储单测通过：只回指定 Channel 行 / 含空值时回「空串 + 缺字段」行、不含空值时不回 / 归一化口径一致 / 空集 → `[]` |
| AC6-4 | 全表读 vs 过滤读等价集成测试：两路喂同一 `runReconciliation`，产物（modifiedRows/modifications/stats/unmatchedRows）**逐字节相等** |
| AC6-5 | 「网关行只读」不变量：run 前后 gwRows `deepEqual`（证明删深拷安全） |
| AC6-6 | GUI 手测：关退款场景 + 只留 BOSH-CN → 导入 → 开始运行**秒回不卡**、结果与修复前一致；峰值内存大幅下降 |

### 6.7 需求 7：R5s3 fallback AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC7-1 | `FundType:'Inbound-VA'` 命中 → 0 条（子串而非等值，变更2 核心） |
| AC7-2 | 大小写不敏感：`'inbound'` / `'INBOUND'` 命中 → 0 条；`'outbound'` → 产（D-2a） |
| AC7-3 | ReconId 不上、ChannelOrderNo 上 → 产 1 条、加款单号=gw.orderid（变更1 fallback 命中） |
| AC7-4 | 两级都不上 → 0 条且无警告（静默 empty） |
| AC7-5 | ChannelOrderNo 桶多候选方向消歧：2 行(1 Credit 1 Debit) → 取 Credit 产 1 条；2 行都 Credit → `multi-credit-match`（带 ChannelOrderNo 标记）+ 不产（D-1b） |
| AC7-6 | 1v1 跨两级不重复消费：两条 gw 同 key、一条 bank 行 `ReconciliationId=key` 且 `channelOrderNo=key` → 第一条 gw 一级消费、第二条 gw 二级捞不到 → 1 条（D-1c） |
| AC7-7 | 🔴 红线锁：一级消歧失败不 fallback —— ReconId 桶 2 行都 Credit(multi-credit) + 存在干净 `channelOrderNo=key` 行 → 仍 0 条 + `multi-credit-match` 警告（锁 D-3） |
| AC7-8 | 空配置兜底：`excludeFundType` 清空（`ex===''`）→ 全部命中行都产剔除行（D-2c，不反转） |

### 6.8 需求 8：使用手册补全 + 全册去技术术语 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC8-1 | 1.4 节出现「中台订单数据处理」总览导航小节：一句话讲清 4 个子场景（中台调拨 / 退款 / 线下调拨回填 + 中台加款单脏数据剔除）各自作用 + 何时用，并指向各详解小节、与「资金性质校验」组并列点出；小节内零技术术语 |
| AC8-2 | 核心禁用词 grep 全册清零（排除保留清单 + 已配中文解释项）；软件界面名 / Excel 真实列名 / 渠道数据真值保留并配中文解释（删了用户对不上屏幕 / 对不上数据）；历史 changelog / 版本注记不强行洗 |
| AC8-3 | 章节零丢失：`##` 标题 20 = 20；`###` 标题 135 → 136（仅 1.4 新增 +1）；代码围栏（```）数量为偶数（成对闭合，markdown 结构未坏） |
| AC8-4 | 1.6.1 含银行对账单 46 列兼容说明（用户白话）；资金敏感章节（对账 / 退款 / 剔除 / 余额 / Type）信息完整、口径未被洗改变义；SOP 已沉淀 `knowledge/user-guide-dejargon-playbook.md` |

### 6.9 需求 9：银行对账单 44 → 46 列（识别 + 字段可选 + BU 兼容导入不落库）AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC9-1 | `BANK_STATEMENT_FIELDS` = 46 项，在 `'Transaction Description'` 后含「合并单号」「合并状态」；`preload.js` inline 副本逐项一致（单测 `bank-statement-fields.test.js` 断言 46 通过） |
| AC9-2 | 新版 46 列银行对账单 / 入金表识别命中（`table-signatures.js` `expectedHeaders` 复用 `BANK_STATEMENT_FIELDS` 自动跟随、`signatureHeaders` 指纹列不变）；旧版 44 列文件仍识别命中 |
| AC9-3 | 银行对账单字段下拉可选到「合并单号」「合并状态」两项 |
| AC9-4 | 月度银行对账单 BU 回填：导入新版 46 列文件校验通过（宽容超集：模板 44 列为文件表头有序子序列、多余两列忽略），导入成功；导入旧版 44 列文件行为完全不变（零回归） |
| AC9-5 | 🔴 不落库：合并单号 / 合并状态不写入 DB（`columns.js` `BANK_HEADERS` 保持 44 列、`bank_bu_recon_bank_imports` 列结构不变）；`reader.js` 按列名定位取值，`Extra Information` / `Remark-BU` 等后移列不错位（验证导入数据各列对得上） |
| AC9-6 | 🔴 Pending 数据管理导入保持严格校验（列数必须相等 + 逐列名相等），不受宽容超集波及；`release-check` 全绿（含 `validator.test.js` 宽容超集契约 + 新增 `header-superset-mapping.test.js` 按列名映射） |

---

## 七、手动测试清单

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 工具箱合表端到端 | 多选 ≥2 表头一致文件 | 点🧰 → 合并表格 [导入文件] | 一气呵成另存为 `合并-时间戳.xlsx`，内容 = 首表头 + 各文件数据行 |
| 工具箱合表表头不一致 | 多选表头不同文件 | 同上 | alert 列差异并停止，不产文件 |
| 工具箱拆表端到端 | 单选文件 + 选字段 + 多选值 | 点🧰 → 拆分表格 [导入文件] → 选字段弹框 → [导出文件] | 另存为 `拆分-值-时间戳.xlsx`，含全部选中值的行 |
| 内存尖峰修复（核心） | BOSH-CN 对账单 | 关退款场景、只留 BOSH-CN、已灌大量行 bank-deposit | 开始运行**秒回不卡**；结果表/状态框与修复前一致 |
| 退款回填仍正常 | 退款订单 + 入金表 | 启用退款场景 | 开始运行 → 退款回填正常命中 |
| 资金对账运行可响应 | 任意对账批次 | — | 运行全程窗口可响应 + 进度更新 |
| R5s3 fallback 命中 | 网关 reconciliationid 只与银行 ChannelOrderNo 对得上的样例 | R5 场景3 启用 | 产 `中台加款单剔除模板-*.xlsx`，加款单号/附言/C~O 正确 |
| BOC 修复行 Type | BOC 调拨订单修复运行 | 外汇交割表 + 中台调拨 + 网关已就绪 | 修复模板 Type=1 |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 场景管理折叠/退役 | 打开场景管理 | — | 两组默认收纳/可展开；C3 消失 |
| 未命中 sheet 布局 | 含未命中行的导出 | — | A1 提醒 + B 列数据，sheet2 不变 |
| 大网关表过滤读 | 多 Channel 大网关表 + BOSH 对账单 | — | R1/R2 命中数、ReconciliationId 回填、unmatched 与修复前完全一致，峰值内存降 |
| R5s3 子串大小写 | FundType=`inbound`/`INBOUND`/`Inbound-VA` | R5 场景3 启用 | 均不产剔除行；`outbound` 产 |
| 工具箱取消路径 | 取消另存为对话框 | — | 不产文件、无报错 |

### 7.3 不测项与原因

- 需求 4/5 列位与单值改动由 golden + 单测覆盖，不单独 GUI 手测视觉像素（preview/golden 已锁）。
- 需求 3 进度百分比精度不测（仅做文案更新，不做精算进度条）。
- 需求 6 修复1 字节级不变由编排器既有回归护栏 + 门控谓词断言覆盖，不构造 1.2GB 真实入金表手测内存绝对值（GUI 手测验「秒回 + 结果一致」即可）。

---

## 八、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更 | 无新表 / 无新字段 / 无 migration。需求6 新增仓储函数 `readGatewayBillRowsByChannels`（读路径，不改 schema）。 |
| 状态流转变更 | 需求3：`bank-statement:run` handler 由同步改 async + 新增进度通道 `bank-statement:run:progress`（单向 main→renderer）；轮次顺序/状态机零变化。需求2：场景管理新增前端临时折叠态（不持久化）。 |
| 权限 / 安全 | 无鉴权变更。需求1 工具箱 IPC 复用既有 file-service 读写，文件名经 `sanitizeFileName`；合表表头校验防误合不同结构表。 |
| 🔴 资金红线 | 需求 3/4/5/6/7 均涉对账 run 路径或输出口径：①需求6 改 run 入口数据准备（bank-deposit 门控谓词须逐字镜像 r5s4 条件；gateway 过滤读须等价测试背书）；②需求3 改 orchestrator 控制流（结果须 golden 一致）；③需求4 改未命中 sheet 列布局（golden）；④需求5 改 BOC 修复行 Type 值（用户确认语义 + golden/单测）；⑤需求7 改剔除清单匹配/触发（fallback 误命中 / 触发方向写反 / 1v1 重复消费三大风险，D-1a/D-1b/D-3 + 新增用例守护）。 |
| 回滚策略 | 需求2：C3 **纯前端 UI 过滤**（`migrations.js` 零改动，引擎/约束/seed/已有库记录全保留）→ 回滚 = 撤一行前端 filter 即可，无 migration 需回退、新旧库数据全无损。需求1/3：纯新增（工具箱）/控制流（async + 进度），回滚 = revert commit。需求4/5：单点值/列位改，回滚 = revert + 还 golden。需求6：门控 + 过滤读，回滚 = 恢复无条件全表读 + structuredClone。需求7：引擎三处改动，回滚 = revert 引擎 + 还单测。两份 spec 实施后归档 `changes/` 对应目录。 |

---

## 九、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | 需求2 新旧库 C3 记录均保留（纯前端过滤、`migrations.js` 零改动，可回滚）；需求6 门控/过滤读对启用退款场景/正常网关数据零行为变化；需求7 子串变更对现有 12 值 FundType 枚举零行为变化（仅 `'Inbound'` 含 "Inbound" 子串）；需求1 纯新增不影响既有链路。 |
| 性能 | 需求6：关退款场景时省 ~1.2GB bank-deposit 无谓载入；gateway 由全量读（可达数百万行）降为 Channel 子集读 + 删深拷 → 峰值内存大幅下降。需求3：运行期让出事件循环，UI 不阻塞（不增加总运行时长，仅消除假死）。 |
| 鲁棒性 | 需求1 合表表头校验防误合；拆表空集/取消路径安全。需求6 三个陷阱（空/缺 Channel、归一化口径、跨轮无越界 Channel）处理到位，否则漏匹配。需求7 一级消歧失败不 fallback、严格 1v1 跨两级共享、空配置兜底。 |

---

## 十、待澄清问题

- [ ] 需求5：Type=1 业务语义需用户最终确认（plan 已标「需用户最终确认」）。
- [ ] 需求6 修复2：实现时须逐轮钉死「无哪一轮会用到银行单未出现的 Channel 的网关行」（spec §四陷阱3 初判 R3.5/C3/R1/R5s2/R5s3 安全，实施时逐轮确认）。
- [ ] 需求1：拆表多选值文件名拼接的分隔符与超长截断策略（实施时定 sanitize 细则，避免文件名过长/非法字符）。

---

## 十一、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-16 | 初稿：依据已批准 plan + spec A（运行内存尖峰修复）+ spec B（R5s3 规则变更）撰写 v3.0.8 PRD，覆盖 7 需求（12 章范式，37 条 AC），资金红线标注需求 3/4/5/6/7，发版文档三件套待 bump 时统一更新。 |
| 2026-06-16 | team-lead 审查订正 7 处 file:line 出处/边界（FUNC_CATEGORY_LABELS、createScenariosManagerDialog、writeWorkbookRows facade、yield 轮次、门控谓词锚、拆表空值边界、AC 计数）。 |
| 2026-06-16 | Reverse Sync 订正与回填（PM）：①需求2 退役方式由「migrations 不 seed」改为**纯前端过滤退役**（`migrations.js` 零改动，更可回滚、零 migration 风险），订正 §一/§2.2/§2.3/§5.2/§6.2/§八/§九相关条目；②回填 §十二实施记录（7 commit 清单 + 4 项实施期取舍/增强：C3 退役边界 OPEN-2 / json_valid 守卫 / displayIndex 序号红线 / R5s3 全角括号）。 |
| 2026-06-17 | 发版后用户验收反馈 9 项（UI/输出/文档）+ 工程加固落地，PR #77 合入 main（codex review 1×P2 已修 + team-lead 自审无 P0-P2）。详见 §12.3 + 归档 `docs/prs/PR77-v3.0.8.md`。 |
| 2026-06-17 | 第二轮追加需求 8（使用手册补全 + 全册去技术术语）/ 需求 9（银行对账单 44→46 列：识别 + 字段可选 + BU 回填兼容导入不落库 🔴 资金红线）。续编号追加 §5.8/§5.9、§6.8/§6.9（AC 37→47），实施记录见 §12.4（Reverse Sync 回填，代码 / 手册已实施、release-check 全绿、用户手测通过；分支 `v3.0.8-userguide-bank-2cols`）。 |
| 2026-06-17 | 第二轮收尾追加 BUG2（场景管理弹窗用户自建 C3 误消失，前端过滤收窄为只隐藏自带 C3）/ BUG3（工具箱合并·拆分 30 万行 OOM 闪退·误报「文件为空」改流式：新增 `toolbox-stream-io.js` + 三 IPC 改流式 + 内存错误回真实文案，🔴 顺带修 `streaming-xlsx-reader.js` 读值正则·银行对账单导入复用）/ 工具箱弹窗尺寸微调。实施记录见 §12.5（Reverse Sync 回填，三项均已实施、release-check 全绿 unit 3040/3040、用户手测 BUG2/BUG3 通过）。 |

---

## 十二、实施记录

> 由 dev 分 W1~W6 工作流实施，team-lead `git diff`+`release-check`+`/check-vars` 核实。7 个 commit（`git log 28dab32..HEAD`，按提交逆序列出，倒序即实施顺序 bump→W1→…→W6）。

### 12.1 Commit 清单（逐条 hash + 标题）

| # | Hash | 标题 | 需求 |
|---|------|------|------|
| 1 | `4afd20f` | `[v3.0.8] bump 3.0.8 + PRD/TechDoc + 纳入 2 份资金红线 spec（运行内存尖峰 / R5s3 规则）` | 收尾（切分支/bump/纳 spec A/B/scan:vars） |
| 2 | `faf05b3` | `[v3.0.8] 需求5 BOC 调拨修复行 Type 2→1` | 5 |
| 3 | `0d64d03` | `[v3.0.8] 需求4 银行未命中 sheet 数据右移到 B 列` | 4 |
| 4 | `94a5170` | `[v3.0.8] 需求7 R5s3 两级 fallback（ReconId 主+ChannelOrderNo 兜底）+ FundType 子串判定` | 7 |
| 5 | `fdf5635` | `[v3.0.8] 需求6+3 开始运行卡顿根治：bank-deposit 消费方门控 + gateway 按 Channel 过滤读（删深拷）+ 资金对账异步化（轮次 yield + 进度事件，golden 字节不变）` | 6+3（W4 合并工作流，先 6 后 3） |
| 6 | `304c90a` | `[v3.0.8] 需求1 工具箱🧰 合表/拆表（3 IPC + 工具箱/选字段弹框 + 端到端测试 + preview）` | 1 |
| 7 | `9e67b56` | `[v3.0.8] 需求2 场景管理：退役 C3（前端隐藏，后端保留可回滚）+ 资金性质校验/中台订单两组三角折叠默认收纳` | 2 |

> 落地与 TECHDOC §二「W1 需求5 / W2 需求4 / W3 需求7 / W4 需求6+3 / W5 需求1 / W6 需求2」分工一致。需求6+3 按计划合并到单 commit（fdf5635）实施，先 6 减载入、后 3 异步化。

### 12.2 实施期取舍 / 增强（spec 外）

| 项 | 内容 | 性质 |
|----|------|------|
| ① C3 退役边界 | 需求2 退役方式由「migrations 不 seed」改为**纯前端过滤**（`renderer-dialogs.js:7045` `scenariosRaw.filter(s => s.category!=='gateway-recon-join')`，`migrations.js` 完全不动）。但退役仅作用于「场景管理列表展示」——**新建场景下拉仍含 C3 选项**（renderer-dialogs.js:8005）、`createScenarioConfigDialogC3()`（renderer-dialogs.js:238）仍可达，用户仍能新建 C3 场景。 | 已知取舍（OPEN-2），本迭代只退役展示、不封新建入口 |
| ② 需求6 加 `json_valid` 守卫 | 新仓储 `readGatewayBillRowsByChannels` 的 SQL 在 `json_extract` 求值前先 `json_valid(raw_json) AND (...)` 短路（linked-table-repository.js:992-995），把坏 JSON 行排除在 `json_extract` 之外，防单条坏行的 `json_extract` 报错崩整轮对账 run。原 TECHDOC §6.3a SQL 未含此守卫。 | spec 外防御性增强（防坏 JSON 崩 run） |
| ③ W6 displayIndex 序号红线修复 | 需求2 分组折叠重排列表时，序号列严格用 `scenario.displayIndex`（派发口径）而非分组后的列表位次（renderer-dialogs.js:7071-7079 标注 N3-1 一致性红线，`displayIndex` 缺失才回退位次）→ **分组不串号**（同一场景在分组前后序号显示值不变）。 | 红线修复（命中 `rules/important-variables.md` displayIndex 软约束） |
| ④ R5s3 二级标记用全角括号 | 需求7 二级（ChannelOrderNo）匹配的消歧警告 message 后缀，实现用**全角括号**「（按 ChannelOrderNo 匹配）」（r5-platform-inbound-cleanup.js:127），与 TECHDOC §11.3 草案的半角 `(按 ChannelOrderNo 匹配)` 不同（统一中文文案全角风格）。 | 文案细节订正 |

### 12.3 本轮用户验收反馈（发版后追加，9 项 UI/输出/文档 + 工程加固；PR #77 v3.0.8→main，2026-06-17 merged）

> 用户手测 v3.0.8 后提 9 项验收反馈，team-lead 直接实施 + 截图/单测验证 + codex review。归档 `docs/prs/PR77-v3.0.8.md`。

| # | Hash | 标题 | 反馈项 |
|---|------|------|------|
| 1 | `0e3e7db` | run handler 接缝 + 进度跨进程契约护栏单测 | 工程加固（补 handler 体接缝盲区测试） |
| 2 | `7c2d682` | release-check 加 ESLint no-undef 静态门 | 工程加固（拦跨作用域 not-defined） |
| 3 | `f5e4fa1` | 工具箱 + 场景管理弹窗 UI 验收调整 | #1-6,8 |
| 4 | `1b2055c` | 未命中场景 sheet 银行行数据整体上移一行 | #9（🔴 输出口径） |
| 5 | `c5a9270` | 使用手册 v3.0.8 + 文件名版本化 + 正文术语换 UI 文本 | #7 |
| 6 | `b4d5503` | [codex-fix] 拆分值浮动面板可滚动（P2 高基数列裁切） | #5 codex review |

9 项反馈明细：①去拆表「导出文件」按钮+选字段「完成」即一气呵成 ②拆表导入按钮缩到与合表一致 ③两导入按钮中线对齐左侧文本 ④工具箱弹框宽度 460→230px ⑤拆分值多选框 原生 select multiple→浮动勾选面板控件（复用 `new-account-currency-dropdown-*`，对齐场景管理「适用银行渠道」下拉） ⑥中台调拨订单回填管理页两勾选框并排一行 ⑦使用手册导出名版本化 `使用手册-v${app.getVersion()}.html`+版本头 v3.0.8+正文内部术语换 UI 文本（仅正文，历史 changelog 保留——用户拍板） ⑧工具箱所有 `window.alert`→应用内 `createAlertDialog`（有前端页面/可预览） ⑨未命中 sheet 银行行（表头+数据）整体上移一行、表头与 A1 提醒同处第 1 行。

**评审闭环**：codex review 命中 1× [P2]（#5 面板继承 `max-height:248px+overflow:hidden` 裁掉高基数列值无法选中）→ `b4d5503` 加 `overflow-y:auto` 修复；team-lead 自审无 P0-P2。release-check（lint+smoke+unit **2977/2977**+integration **1469**）+ CI smoke + 无冲突全绿 → 满足「无 P0-P2」merge。

### 12.4 v3.0.8 第二轮追加（2026-06-17）：需求 8 使用手册去术语 + 需求 9 银行对账单 44→46 列

> 本轮为 PR #77 合入 main 之后的第二轮迭代，分支 `v3.0.8-userguide-bank-2cols`（基于 `main`）。需求 8（文档）+ 需求 9（🔴 资金红线）代码 / 手册已实施完成、`release-check` 全绿、用户手动测试通过；本节为「实施后回填 spec 记录（Reverse Sync）」，对应 §5.8/§5.9、§6.8/§6.9。

**需求 8 — 使用手册补全 + 全册去技术术语（纯文档，不碰业务代码）**

| 项 | 落地内容 | 证据 |
|----|---------|------|
| ① 1.4 总览导航 | `docs/USER_GUIDE.md` 1.4 新增「📦 中台订单数据处理总览（一类场景的导航）」小节（行 604+），一句话讲清 4 个子场景作用 + 何时用、与「资金性质校验」组并列、零术语 | `### 📦 「中台订单数据处理」总览` @USER_GUIDE.md:604 |
| ② 全册去术语 | 6 段并行只读审查（按 `##` 大节切 ~6 段）共约 567 处 `old→new` 替换 → 单 agent 串行应用（跨段统一译法、禁止多 agent 并行写同一文件）→ grep 验证。核心禁用词全册清零；软件界面名 / Excel 真实列名 / 渠道数据真值保留并配中文解释；历史 changelog 不洗（用户拍板） | USER_GUIDE.md 全册改动（diff ~2331 行）；`##`=20、`###`=136、代码围栏 26（偶数） |
| ③ 1.6.1 兼容说明 | 1.6.1 加银行对账单 46 列兼容用户白话说明（与需求 9 用户侧体感对应） | — |
| SOP 沉淀 | `knowledge/user-guide-dejargon-playbook.md`（核心原则 / 禁用词清单 / 保留清单 / 统一译法表 / 执行流程 / 易错点） | `knowledge/user-guide-dejargon-playbook.md` |

验收（§6.8）：核心禁用词 grep 全册清零；`##` 标题 20=20、`###` 标题 135→136（仅 1.4 新增 +1，零丢失）；代码围栏偶数配对；资金敏感章节信息完整、口径未变义。

**需求 9 — 银行对账单 44→46 列（识别 + 字段可选 + BU 回填兼容导入，不落库 🔴 资金红线）**

> `assets/银行对账单.xlsx`「渠道对账单」sheet 在 `'Transaction Description'` 后插入「合并单号」「合并状态」，44→46 列。用户决策：识别 + 字段下拉可选 + BU 回填兼容导入忽略两列、**不落库**（不碰 `bank_bu_recon_bank_imports` 列结构）。

| 区块 | 文件:行 | 落地内容 |
|------|---------|---------|
| 字段定义 | `src/constants/bank-statement-fields.js`（「合并单号」:26 /「合并状态」:27，在 `'Transaction Description'`:25 之后；`BANK_STATEMENT_FIELDS` 44→46）；`src/preload.js:11`（inline 副本逐项同步、逐列一致） | 字段枚举升级，识别 / 下拉自动跟随 |
| 识别 | `src/constants/table-signatures.js`（注释「46 列」:36 / :179；银行对账单 `expectedHeaders:[...BANK_STATEMENT_FIELDS]`:41、入金表 :188 自动跟随；`signatureHeaders` 指纹列不变 :44，新旧文件均可识别） | 指纹列复用旧列 → 新旧 44/46 列文件都命中 |
| BU 回填校验 | `src/backend/bank-bu-recon-import/validator.js`（`buildHeaderValidator` 加 `options.allowSupersetColumns`:24-25；宽容超集分支 :39-78「模板列须为文件表头有序子序列、多余列忽略」；`validateBankHeaders` 启用 `{allowSupersetColumns:true}`:117；`validatePendingGuanliHeaders` 保持严格 :115） | 银行对账单宽容超集、Pending 严格零回归 |
| BU 回填取值 | `src/backend/bank-bu-recon-import/reader.js`（`buildRowMapper` 改按列名定位 `headerIndexMap` 取值 :59-65，注释 :37-40；防 `Extra Information`/`Remark-BU` 等后移列错位 = 资金对账错列红线） | 两列插在中间也不让其余列错位 |
| 不落库 | `src/backend/bank-bu-recon-db/columns.js`（`BANK_HEADERS` 保持 44 列、不含合并单号 / 合并状态；DB 列结构不动） | 合并单号 / 合并状态读到也不写入 DB |
| 测试 | `tests/unit/constants/bank-statement-fields.test.js`（断言 46，已改）；`tests/unit/backend/bank-bu-recon-import/validator.test.js`（宽容超集契约，已改）；`tests/unit/backend/bank-bu-recon-import/header-superset-mapping.test.js`（**新增**，按列名映射） | 46 字段 + 宽容超集 + 按列名映射三层守护 |

关键不变量：合并单号 / 合并状态不进 DB（`columns.js` 44 列不动）；旧版 44 列文件行为完全不变；Pending 严格校验不受波及；`release-check` 全绿。验收 AC 见 §6.9（新版 46 列识别 + 字段可选 + BU 兼容导入忽略两列、旧版 44 列回归、Pending 不受波及、不落库）。

> 实施事实核对：上述 file:line 由当前分支 `v3.0.8-userguide-bank-2cols` 工作树（`git diff --stat HEAD`）实测得到 —— 改动文件含 `docs/USER_GUIDE.md` / `src/constants/bank-statement-fields.js` / `src/constants/table-signatures.js` / `src/preload.js` / `src/backend/bank-bu-recon-import/{validator,reader}.js` / 两个改测 + 一个新增测。`src/backend/bank-bu-recon-db/columns.js` 的 `BANK_HEADERS` 维持 44 列、未在改动清单中（= 不落库已落实）。

### 12.5 v3.0.8 第二轮收尾（2026-06-17）：BUG2 场景管理自建 C3 / BUG3 工具箱大文件流式 / 工具箱弹窗尺寸

> 与 §12.4（需求 8/9）同属第二轮（分支 `v3.0.8-userguide-bank-2cols`）。本节为「实施后回填 spec 记录（Reverse Sync）」——三项均已实施完成、`release-check` 全绿（unit **3040/3040** + 34 集成脚本 + smoke 全模块 PASS）、用户手动测试 BUG2/BUG3 通过。版本号并入 3.0.8 不 bump。

**BUG2 — 场景管理弹窗用户自建 C3 在 v3.0.8 后误消失（🟢 体验回归修复，不涉资金口径）**

| 项 | 落地内容 | 证据 |
|----|---------|------|
| 根因 | v3.0.8 需求2（W6）退役自带 C3 时，前端过滤一刀切隐藏全部 `category==='gateway-recon-join'`，**误伤用户在 BOSH-CN 等渠道下自建的 C3 场景**（自建 C3 在场景管理列表看不到、无法启停 / 管理） | §12.2 ① OPEN-2 已知取舍的延伸（退役只针对自带 C3，不应波及自建 C3） |
| 修复 | `renderer-dialogs.js:7051` 过滤条件由 `s.category!=='gateway-recon-join'` 收窄为 `!(s.category === 'gateway-recon-join' && s.isBuiltin)` —— **仅隐藏「软件自带的 C3」（`isBuiltin=true`）、保留用户自建 C3（`isBuiltin=false`）可见可管理** | `scenariosRaw.filter((s) => !(s.category === 'gateway-recon-join' && s.isBuiltin))` @renderer-dialogs.js:7051 |
| 不动 | 运行口径 `hasC3Enabled` **未动**（已有库手动启用的 C3 仍照常运行）；后端 C3 引擎 / dispatcher case / CHECK 约束全保留；`isBuiltin` 来源 `scenarios-repository.rowToListItem → Number(row.is_builtin)===1` | 仅改「列表展示过滤」误伤面，不碰 migration / 引擎 / 运行口径 |

**BUG3 — 工具箱合并/拆分 30 万行 OOM 闪退 / 误报「文件为空」（🔴 涉资金红线复用文件）**

> 工具箱合并 / 拆分大文件（约 30 万行）时 SheetJS 全量读撞 V8 内存上限 → 进程闪退，或被旧实现统一吞成「文件为空或不可读」误导用户（文件明明有内容、只是太大）。改流式根治，**顺带修复一处被银行对账单导入复用的读值正则资金红线 bug**。

| 区块 | 文件:行 | 落地内容 |
|------|---------|---------|
| 流式读写模块（新增） | `src/main-process/toolbox-stream-io.js`（新增） | 读侧 `.xlsx` 复用自研 `readXlsxStreamed`（边解压 zip entry 边扫 `<row>`、内存恒定，:117）、`.csv`/`.xls` 回退全量 `readRows`（:124）；写侧 `ExcelJS.stream.xlsx.WorkbookWriter` 逐行 `addRow().commit()`（:322），决策① **by-name 格式输出与现状 `writeWorkbookRows` 完全一致**（numericFields/dateFields/textFields 按表头名套格式 + 表头 Courier New 10pt，与 `writers.js applyExportFieldFormats` 同源），决策② 超 `MAX_DATA_ROWS_PER_SHEET=1048575`（:55）自动开 sub-sheet (2)(3)（照搬 `acquiring-bill-currency-writer.js`） |
| 三 IPC 改流式 | `src/main.js`（`toolbox:merge`:12860 / `toolbox:split:read`:12908 / `toolbox:split:export`:12929） | 三 handler 改走 `toolbox-stream-io.js` 流式读写（handler 仅做 dialog + IO，纯变换委托模块） |
| 内存错误回真实文案 | `src/backend/file-service/readers.js`（`isMemoryError`:158-164 / 文案分支 :144-154） | 新增 `isMemoryError`（识别 `RangeError` / `Array buffer allocation failed` / `Invalid string length` / `Invalid array length` / V8 OOM 关键字），命中改回「文件过大」真实文案而非「文件为空或不可读」，引导用户拆分后再试 |
| 🔴 读值正则修复（资金红线） | `src/backend/pending-import/streaming-xlsx-reader.js`（`V_CONTENT_RE`:58，BUG3 注释 :54-57） | `V_CONTENT_RE` 由 `/<v>...<\/v>/` 改为 `/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/`，修复「`<v>` 带 `xml:space="preserve"` 属性的含首尾空格字符串单元格被旧裸标签正则漏匹配 → 读空」的**隐性丢值 bug**（裸 `<v>` 仍匹配，向后兼容）。⚠️ **该读取器被银行对账单导入复用** → 升级必读、建议真实数据回归（见 §12.6 红线提醒） |

**工具箱弹窗尺寸微调（🟢 体验，纯样式）**

| 项 | 落地内容 | 证据 |
|----|---------|------|
| 卡片宽 +16 | `.toolbox-card width` 由 `230` 改 `min(94vw, 246px)`（左右各 +8、外框宽 +16） | `width: min(94vw, 246px)` @styles-gemini-extra.css:3287 |
| 下沿 +15（口径 B） | `.toolbox-body padding` 由 `24px 28px 12px` 改 `24px 28px 27px`（padding-bottom 12→27）+ `.toolbox-card transform: translateY(7.5px)` —— overlay 垂直居中会把上沿上移 7.5，整体下移 7.5 抵消 → **上沿回到最原始基线不动、下沿净往下 +15**，卡片高净 +15 | `padding: 24px 28px 27px` @:3298 + `transform: translateY(7.5px)` @:3291 |

**🔴 第二轮收尾红线提醒（§12.6 与 §12.5 同源）**：BUG3 修复的 `streaming-xlsx-reader.js V_CONTENT_RE` 为**银行对账单导入复用**的读值热点 —— 修复后此前被读空的「含首尾空格 / `xml:space`」列会读到真实值，对账 / 校验输入可能随之变化（绝大多数列无首尾空格、不受影响）。**必须用真实银行对账单数据回归银行对账单导入读值**，确认无非预期口径变化。该提醒已并入 §6 验收口径与 TECHDOC §12.1 资金红线汇总。

---

## 附：发版文档清单（CLAUDE.md 约定，bump 3.0.8 时统一更新）

| 文档 | 待更新内容 |
|------|-----------|
| `CHANGELOG.md` | 工具箱合表/拆表（新功能）；场景管理退役 C3 + 分组折叠；资金对账运行不阻塞 + 进度提示；🔴 未命中 sheet 列右移（对外口径变更，外部按 A 列解析需适配）；🔴 BOC 修复模板 Type 2→1（对外口径变更）；运行内存优化（bank-deposit 门控 + gateway 过滤读）；R5s3 两级 fallback + FundType 子串判定 |
| `docs/VERSION_FEATURE_HISTORY.md` | v3.0.8 条目：7 需求摘要 + 资金红线提示 |
| `docs/USER_GUIDE.md` | 工具箱用法（合表/拆表步骤 + 文件名规则）；场景管理折叠操作；资金对账运行进度提示说明；R5s3 规则变更对剔除清单的影响说明 |
