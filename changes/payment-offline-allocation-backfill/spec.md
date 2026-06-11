# Spec — payment-offline-allocation-backfill 「Payment线下调拨订单回填处理」（中台调拨订单对账ID回填扩展）

> status: implemented（v3.0.4 分支，2026-06-11，commit 934148f..a3d7658；块 F F1-F7 全部入库——UI 三输入框/config 持久化/weekTag+FTA 地基/R5s2b 引擎/run 接线/输出收口，收尾文档批已落三件套/important-variables/backlog）
> owner: pzhong
> created: 2026-06-11
> updated: 2026-06-11（六项阻塞性澄清全部拍板回写）
> 目标版本：**v3.0.4**（2026-06-11 用户拍板：并入 v3.0.4 迭代，作为其块 F；迭代入口 `changes/v3.0.4/spec.md`；`bank-recon-output-fixes` 同迭代先行落地）
> 性质：🔴 **资金红线**（新引擎向银行对账单 ReconciliationId 写值）+ 新匹配引擎 + UI/配置 + run 数据源扩展。
> ✅ **实施门禁已解除：§10.1 六项阻塞性澄清已全部拍板（2026-06-11），F5 引擎可进入实现**。
> 调研方式：UI/导入链/引擎三路深查 agent + 三路对抗验证 agent + 集成交叉 agent（共实读核对 149 处 file:line 证据，三路方案均未被推翻，验证轮修正已全部并入本文）；周数算例由本机独立复算。

---

## 1. 需求（用户 2026-06-11 原文，含标注）

1. **UI**：在中台调拨订单对账ID回填的「请选择适用的银行渠道」页面新增勾选框「Payment线下调拨订单回填处理」，位于银行渠道下拉框下侧一行；勾选后另起一行，显示「银行渠道」文本+输入框+「地区」文本+「大账号」……（✅ Q1 已拍板：三组 label+输入框——银行渠道[如 BGL]/地区/大账号[如 202782001]，无第四组；「地区」参与**银行侧筛选**，见 F5 银行池三条件）
2. **订单侧**（导入中台调拨单表完成时）：筛选「收款账户（卡号）」=202782001 且「付款渠道」=BGL 的行；取「调拨单号」FTA 后接 8 位数字为判断日期，按其当年周数计算「订单对账周数号」。例：FTA202606021000477 → 20260602 → 2026 年第 23 周 → **2623**（YY+WW）。
3. **银行侧**（导入对账单时）：存在 MerchantId=202782001 且 FundType=FundTransfer-in 的行时，按 BillDate 计算「银行对账周数号」赋予该行。
4. **匹配**（全部计算完成后）：取 银行对账周数号 = 订单对账周数号 **+1** 的对账单与订单对账：
   - Credit Amount=收款金额 ∧ Currency=收款币种 ∧ BillDate **晚于** 交易时间 → 订单「渠道流水号」赋给对账单 ReconciliationId 并标黄；
   - 金额币种相等但 BillDate **早于** 交易时间 → 对账单入差错池，与其他订单做匹配；
   - 多候选 → 按 BillDate 与交易时间差额**就近匹配**（例：对账单 0601/0604 vs 订单 0530/0601 → 0601↔0530、0604↔0601）；
   - 匹配不上 → error-report。

## 2. 代码现状（出处，全部经两轮实读核验）

### 2.1 模块定位与 UI

- 「中台调拨订单对账ID回填」= 5 轮对账的 **R5 场景2**（builtin-fixed seed：funcCategory='platform-order'、subCategory='fund-transfer-backfill'、roundPhase=5、config 含 directions 双方向 + dateToleranceDays=1，`migrations.js:1500-1515`）；编排器按字面值分桶入 r5s2 桶（`reconciliation-orchestrator.js:69-70`）→ `r5-fund-transfer-backfill.js`。
- 「请选择适用的银行渠道」页面 = `createBuiltinFixedChannelManageDialog`（`renderer-dialogs.js:7256-7443`，标题字面值 `:7262`；入口=场景管理表格行「管理」按钮按 category 分流 `:6883-6888`）。⚠️ 该弹窗被**全部 9 个** builtin-fixed 场景共用（seed 8 条 + v2.1.13 迁移的提取调拨ID场景；`migrations.js:1397` 注释「插入 7 个」已过时勿照抄）——新增控件必须按 `config.subCategory==='fund-transfer-backfill'` 条件渲染。
- 弹窗现状：仅「银行渠道多选下拉 + 优先级」两组（`:7260-7285`）；渠道枚举来自 `channels:list` IPC（`main.js:3209-3215`）；**完全不读不写 config**（加载 IIFE `:7370-7390` 仅取 channels/applicableChannels/priority）；保存两段非原子 IPC：`setApplicableChannels`（`main.js:3195-3203`，成功直赋 `processingResult=null` `:3198`）+ `scenarios.update({priority})`（`main.js:3113-3124` → `updateScenario`，**已支持 fields.config 整体替换 config_json**，`scenarios-repository.js:414-418`，仅禁改 category/is_builtin）。
- 布局约束：弹窗宽度 `min(100%,564px)`（`styles-gemini-extra.css:3219-3223`，builtin-fixed 区块 `:3217-3278`）——三组 label+input **单行放不下**，展开行需独立多行布局。
- 既有「勾选展开」范式：C3 extraFee（HTML `renderer-dialogs.js:8105-8121` + change 联动 `:8288-8296`，取消勾选保留输入值）。
- 校验失败现范式 = alert + onConfirm **reopen 全新弹窗实例从 DB 回填**（`:7401-7421`）——多输入框下会丢用户草稿，需改 inline 校验。
- preview 入口已存在：`npm run preview:builtin-fixed-channel-manage`（`package.json:57` → `renderer-previews.js:819-831`）；preview:all 链 `package.json:92`。
- bundle 行为：config_json 随场景 bundle 导出自动携带（`main.js:3294-3312`）；导入端同名场景跳过不覆盖（`scenarios-bundle-import.js:133-147`），适用渠道全 resolve 失败会禁用场景（`:203-208`）。

### 2.2 中台调拨订单数据链

- 导入：`linked-table:import`（`main.js:11274`）→ detector `'zhongtai-dispatch-order'` → repoKey `'mid-allocation'`（映射 `main.js:11109`）→ `linked_mid_allocation`（keyHeader 调拨单号 / dateHeader 交易时间 / **raw_json 为数据真相**，`linked-table-repository.js:69-79`）；整表覆盖语义，4 列共用 INSERT **不可破坏**（`:196-218,331-334` 注释明令）。
- 26 列表头单一真相 `table-signatures.js:98-103`（与 `assets/中台调拨订单.xlsx` 实测逐列一致）。需求涉及列：调拨单号(idx0)、渠道流水号(idx3)、交易时间(idx4)、**收款账户（卡号）(idx6，全角括号；⚠️ 与 idx23「收款账号」易混拿错）**、收款金额(idx9)、收款币种(idx10)、付款渠道(idx22)。
- 读取双路径：流式有 transform 形参（`main.js:11348,11355`）；数组路径无钩子、inline 三元裁列（`:11366-11369`）——若导入时注入派生字段两路必须同改（口径红线 `linked-table-stream-source.js:5-11`）。
- 「导入完成时」既有 hook：ADM 派生（`main.js:11392-11447`；`readLinkedTableRows('mid-allocation')` 全 src/ 唯一调用点 `:11412`；`reconIdFixResult=null` 在成功 try 块内 `:11421`）。
- ⚠️ **stale 缺口（现状）**：mid-allocation 导入**不清 processingResult**（守卫严格 bank-deposit，`main.js:11448-11454`；注释 `:11450-11451` 明示「mid-allocation 不喂 run 不应清」——本功能恰好改变该前提）。先例：gateway-bill 导入清 `:11390`、按日期删除清 `:11264`、bank-deposit 清 `:11452-11454`。
- run 注入现状：bank-statement:run 只注入 gateway-bill / bank-deposit / refundOrderSession（各自 structuredClone，`main.js:3612,3617-3618`），不读 mid-allocation。

### 2.3 银行侧与既有引擎

- 44 列契约列名（`bank-statement-fields.js:9-54`，preload.js 顶部有 inline 副本须双写 `:5-7`）：BillDate(idx3)、MerchantId(idx7)、Currency(idx8)、**'Credit Amount'(idx9 含空格)**、ReconciliationId(idx11)、FundType(idx25)；44 列含「地区」列（`:16`，Q1 的「地区」输入框可能与之相关）。
- **FundType 拼写实证**：`assets/FundType枚举值.xlsx` 实测含 `'FundTransfer-in'`（大写 T），与需求原文及 R5s2 seed（`migrations.js:1508-1509`）一致；既有 `ADM_FUND_TYPES` 'Fundtransfer-out' 小写 t 变体不在资产表中，属**既有疑点**（`adm-bank-deposit-fields.js:24-26`），本功能取大写 T、不顺手改 ADM（记 backlog）。
- R5s2 现有匹配（`r5-fund-transfer-backfill.js`）：direction 池过滤（in 方向 bankPool 按 `FundType==='FundTransfer-in'` 过滤 `:162`）、merchantid/currency 全等 + 金额 `Math.round(*100)` 精确到分（`:65-84`）、Phase1 同日→Phase2 ±容差天数（候选按天数差升序**稳定排序**取 cand[0]，tie=原序 first-wins `:186-197`）、严格 1v1 `usedBankRowId`、**命中即覆盖写** ReconciliationId + record 标黄（`:126,142-150`）。
- 就近匹配先例：R5s4（`r5-refund-order-backfill.js:247-265,406-414,501-534`）bank 按 BillDate 升序 + dayDiff 升序贪心取最近；「筛后行必落三态、绝不静默消失」不变量（`:348-350`）。差错池（落选再匹配）**无完全先例**，最近结构 = R5s2 Phase1→Phase2 两阶段（`:165-198`）。
- 标黄链：modCollector.record → orchestrator mergeMods（`:170-177`）→ `_modifiedColumns` 必须 Set（`:127-129`）→ exceljs-writer 黄底（`exceljs-writer.js:158-165`）。内部字段机制：`_` 前缀 + INTERNAL_FIELDS（现 **10** 个成员，`exceljs-writer.js:34-47`），headers 投影写盘自动剥离。
- `_rowId` 全局唯一：注入 `bank-statement-io.js:87-90` + 多文件合并重编号在 `bank-statement-merge.js:74-78`（`important-variables.md:582` 指 main.js:11204 为陈旧行号）。
- error-report：makeWarningCollector → allWarnings（`orchestrator:178,219`）→ `writeErrorReportOutput`（`main.js:3691-3697`）；新 code 不补 `error-causes.js` CAUSE_MAP（`:11-45`）则「可能原因」列显示「未知错误」（`:47-49`）。**终态按 `changes/bank-recon-output-fixes/spec.md`（propose 未实施）书写**：F2 落 error-reports/{date}/、F3 第 3 列「对账ID」三级回退 enrich（warning 须带银行行 _rowId 才能被反查）。
- 防 stale 双保险已闭合：scenarios:update / set-applicable-channels 均清 processingResult（`main.js:3117-3119/:3198`）；export 前 scenariosSnapshot（含 config 序列化）比对不一致拒导出（`main.js:3572-3577,3670-3673`）。
- 周数/FTA：src/ 与 scripts/ 引擎区 **零既有实现**（全新增量，无冲突）；真实样本 `FTA202604280200028` 见 `scripts/smoke/recon-id-fix-engine.js:1125-1127`（佐证 FTA+8 位日期格式）；「前缀+N位数字」提取先例 = C1 `buildFeatureRegex`（`c1-extract-recon-id.js:29-38`），特征码常量范式 = `refund-backfill-fields.js:99-110`（Object.freeze + 启动期断言）。
- 易混模块声明：`jpm-dispatch-order-fix.js`（C4 流水线 JPM 调拨订单修复，消费 ADM 派生表）与本功能命名相近但**完全不同链路**（其 warnings 不进本 error-report）；本功能也不触碰 ADM 派生。

### 2.4 周数算例本机独立复算（2026-06-11，node）——✅ 已拍板 ISO 8601

| 日期 | ISO 8601 | Excel WEEKNUM(默认) | 说明 |
|---|---|---|---|
| 2026-06-02 | 2026-W23 | 23 | **需求例两种口径同值，无法区分算法** |
| 2026-01-01（周四） | 2026-W01 | 1 | 同值 |
| 2026-12-31（周四） | 2026-W53 | 53 | 同值（2026 是 ISO 53 周年） |
| **2027-01-01（周五）** | **2026-W53 → 2653** | **1 → 2701** | **分叉** |
| **2025-12-29（周一）** | **2026-W01 → 2601** | **53 → 2553** | **分叉** |

且「+1」做 YYWW 数字加法在年末必然失效（2653+1=2654 不存在）——必须用日期语义实现（见 F3/D2）。

## 3. 目标

- **必做**：F1-F7（UI 勾选与条件展开行 / config 持久化 / 周数+FTA 纯函数地基 / run 数据接线与缓存失效 / 匹配引擎 / 输出链收口 / 测试文档守卫）。
- **可不做（先单组）**：多组（多渠道×大账号）配置——schema 留升级空间（子对象→数组惰性迁移，先例 `scenarios-repository.js:131-135`）。
- **明确不做**：不改 R5s2 既有网关回填语义（directions/容差/覆盖规则零改动）；不动 ADM 派生与 JPM 链路；不改 `createInsertContext` 4 列共用 INSERT；不顺手改 ADM_FUND_TYPES 小写 t 既有疑点（记 backlog）；周数号不进 44 列输出契约（除非 Q4 拍板要求）。

## 4. 功能点

### F1 — UI：勾选行 + 条件展开行（`renderer-dialogs.js`）

- 在 `.builtin-fixed-priority-row` 闭合后追加：① 勾选行「Payment线下调拨订单回填处理」；② 默认隐藏的展开区（三组 label+input：银行渠道 / 地区 / 大账号），**独立多行布局**（564px 约束），显隐联动照 C3 extraFee 范式（取消勾选保留输入值）。
- gating：加载 IIFE 内 `scenarios.get` 返回后判 `config.subCategory==='fund-transfer-backfill'` 才显示；config 缓存进闭包供保存合并；**加载完成前禁用保存**（防竞态写空 config）。
- 校验：勾选时银行渠道/地区/大账号**三项全必填**（✅ Q1 拍板）；**inline 校验不关弹窗**（替代 alert+reopen 丢草稿范式）。输入框不预填生产值，placeholder 给示例（「如 BGL」「如 202782001」）。
- CSS 追加在 `styles-gemini-extra.css` builtin-fixed 区块末尾；preview：重跑既有入口 + 新增展开态 `preview:builtin-fixed-channel-manage-payment`（4 处范式 + preview:all 链）。

### F2 — 配置持久化与契约守卫（🔴）

- schema：`config.paymentOfflineBackfill = { enabled, bankChannel, region, bigAccount }`（老库无字段 fallback enabled=false；不改 seed 常量——marker 已写的库不会重 seed）。`region` **参与银行侧筛选**（F5 银行池第三条件），非仅记录展示（✅ Q1 拍板）。
- 保存：把 `:7433` 的 `update(scenarioId,{priority})` 扩为 `{priority, config: {...cachedConfig, paymentOfflineBackfill}}` **读-改-写浅合并**，维持两段 IPC 不加第三段；仅本场景携带 config 字段。
- 🔴 红线：合并**严禁丢失** funcCategory/subCategory/roundPhase/directions/dateToleranceDays（seed 契约 `migrations.js:1399-1413`）——丢任一字段场景静默掉出 r5s2 桶或引擎行为漂移。守卫双层：① main 进程对 builtin-fixed 的 config 更新加「必含 funcCategory/subCategory」最小校验（`main.js:3113-3124` handler 内；现状 serializeConfig 无任何 schema 防护）；② 单测断言「注入 paymentOfflineBackfill 后 bucketScenarios 分桶不变」（仿 `migrations-recon-round-seed.test.js:319`）。
- spec 注明：config 新字段随 bundle 自动流转；导入端同名跳过、渠道全失配禁用。

### F3 — 周数工具 + FTA 解析 + 字段常量（纯函数地基）

- 新模块 `src/main-process/scenario-engines/engine-week-utils.js`（独立于 engine-date-utils，保持后者纯日期语义；日期解析必须复用其 `toDate`，文件头明令禁自写解析）：
  - `parseFtaDate(调拨单号)`：`/^FTA(\d{8})/` 提取 + 合法日期校验，失败返回 null（特征码参数 Object.freeze 常量，仿 `refund-backfill-fields.js:99-110`）；
  - `weekTag(date) → 'YYWW'`：**订单侧/银行侧共用同一实现**（防口径漂移）；✅ Q2 已拍板口径 = **ISO 8601**（周一为周首，含首个周四的周为 W1），**YY 取 ISO week-year**（非日历年）；基准断言四元组写死：2026-06-02→`2623`、2026-01-01→`2601`、**2025-12-29→`2601`**、**2027-01-01→`2653`**；
  - `weekTagPlusOne(date)`：**「+1」用日期语义实现 = 判断日期+7 天所在周的 weekTag**，不做 YYWW 数字加法（§2.4 已证数字加法年末必错）；
  - 内部周数比较用 number（YY*100+WW），展示零填充 String。
- 新建 `src/constants/payment-offline-allocation-fields.js`（仿 refund-backfill-fields.js 含启动期断言）：锁死中台列名（**收款账户（卡号）idx6 全角括号**、付款渠道、调拨单号、交易时间、收款金额、收款币种、渠道流水号）与银行列名（MerchantId/FundType='FundTransfer-in' 大写 T/BillDate/'Credit Amount'/Currency/ReconciliationId），禁止引擎手敲。

### F4 — 数据接线与缓存失效（🔴）

- `bank-statement:run`（`main.js:3617` workingDepositRows 旁）：仅当 r5s2 场景 enabled **且** config.paymentOfflineBackfill.enabled 时 `workingMidRows = structuredClone(database.readLinkedTableRows('mid-allocation'))`（gating 防整表无谓载入；bank-deposit 65.7 万行 ~1.2GB 尖峰先例 `linked-table-repository.js:523-526` 注释）。
- `runReconciliation` 新入参 `midAllocationContext = { midAllocationRows }`（仿 refundContext `orchestrator:146-147,160,251-256`）。
- 编排器 **R5s2b 显式接线**（R5s2 块 `:210-222` 之后）：gating = r5s2Bucket 非空 ∧ `config?.paymentOfflineBackfill?.enabled===true` ∧ midRows 非空；显式传 `{bigAccount,bankChannel,region,excludeBankRowIds}` 进引擎 options（excludeBankRowIds = R5s2 块产出的已消费/已回填 bank `_rowId` 集合，✅ Q3 拍板「网关回填优先」；⚠️ 现状编排器只拣 directions/dateToleranceDays 两 key `:213-217`，**config 加 key 不会自动流入引擎**）；mergeMods + allWarnings + stats.r5s2bBackfilledCount + rounds.r5s2b（先例 `:281-297`）。
- 🔴 **mid-allocation 导入补清 processingResult**（`main.js:11405` 分支内、**独立于 ADM try 块**——ADM 抛错时 `:11421` 不执行）；同步改写守卫注释 `:11450-11451`（其前提被本功能改变）；验收项「先 run → 重导中台表 → 直接导出被拒」。
- 「订单对账周数号 / 银行对账周数号」均 **run 时现算不持久化**（订单侧引擎内由调拨单号派生；银行侧引擎内局部 `Map<_rowId, weekTag>`，不写行对象不碰 INTERNAL_FIELDS）——需求原文「导入完成时」按数据就绪语义解释（Q7 向用户确认）。✅ Q4 已拍板纯内部中间值——备选 B1（导入时 transform 注入 raw_json）/ B2（落 DB 列 + migration）**废弃不启用**。

### F5 — 匹配引擎 `r5-payment-offline-allocation-backfill.js`（🔴 资金红线核心）

纯函数 `(bankRows, midAllocationRows, options) → { modifications, warnings }`，骨架照搬 `r5-fund-transfer-backfill.js:98-205`：

🔒 **引擎不变量（✅ Q3 拍板：网关回填优先）**：R5s2 先跑（既有编排顺序天然支持）；编排器把 R5s2 已消费/已回填的 bank `_rowId` 集合经 `options.excludeBankRowIds` 传入 R5s2b，本引擎构建银行池时**剔除**这些行——两引擎零互相覆盖；单测含双引擎互斥断言（F7）。

1. **订单池**：收款账户（卡号）===bigAccount ∧ 付款渠道===bankChannel；逐行 parseFtaDate → 订单周数号；FTA 不合规的**筛中行**按三态不变量计 warning（不静默消失，仿 R5s4 `:348-350`），未筛中行跳过。
2. **银行池**（✅ Q1 拍板三条件）：MerchantId===bigAccount ∧ FundType==='FundTransfer-in' ∧ 地区列===region（均 normalizeCellValue 后全等）；构池前先剔除 excludeBankRowIds（Q3 不变量）；BillDate → 银行周数号。
3. **周数 join**：订单按周数号 Map 分组；银行行按「其周 = 订单周+1」查桶（weekTagPlusOne 日期语义）。
4. **主轮匹配**：'Credit Amount'↔收款金额（`Math.round(*100)` 分级精度沿 `:65-84`）∧ Currency↔收款币种（valuesEqual）∧ BillDate 晚于交易时间（✅ Q6 拍板：**日粒度、同日算晚于**——BillDate 取日 ≥ 交易时间取日；⚠️ 与 §1.4 需求例 0601↔0530 的「暗示同日不算」孤立解读相反，选项已标注冲突、用户知悉选定；差错池「早于」相应为严格小于，两池互斥分区完备）→ 候选按 |BillDate−交易时间| 天数差升序**稳定排序贪心**取最近（tie=原序 first-wins，沿 `:186-197` 既定口径；bank 行按 BillDate 升序消费，沿 R5s4 `:406-414`）；严格 1v1 usedSet。
5. **差错池**（✅ Q5 拍板）：金额币种相等但 BillDate（日）**严格早于**交易时间（日）→ 入引擎内差错池数组；主轮后二轮匹配：**范围 = 全部未被消费的订单（放宽周数约束，不限「周数+1」）**，条件 = 金额+币种相等 ∧ BillDate 晚于交易时间（Q6 同口径：同日算）∧ 就近贪心；**usedSet 与主轮共享**防重复消费；匹配成功同样回填+标黄（结构仿 Phase1/Phase2）。
6. **回填**：订单['渠道流水号'] → bank.ReconciliationId，标准写法 `nv=normalizeCellValue(...)`、`old!==nv` 才写 + record（自动标黄）；覆盖语义与 R5s2 对齐（命中即覆盖；✅ Q3 互斥拍板后「双引擎双写」场景消失，仅剩「原值来自其他来源非空」沿用命中即覆盖——D6 已确认）。
7. **warning**：collector `('r5-payment-offline-allocation-backfill','Payment线下调拨订单回填处理')`；code 连字符风格（payment-offline-no-order-match / payment-offline-multi-candidate / payment-offline-invalid-fta…），**银行侧 warning 必带 _rowId**（供 bank-recon-output-fixes F3 终态对账ID enrich 反查）；订单侧未匹配（若 Q8 要求）rowId=null + 专用字段。

### F6 — 输出链收口

- 标黄/写盘零改动（走既有 mergeMods→_modifiedColumns Set→exceljs-writer 链）。
- `error-causes.js` CAUSE_MAP 补全部新 code 条目。
- stats/rounds 新 key 进 processingResult → 状态框展示（可选，对照 hitScenarios 契约）。
- error-report 形态按 bank-recon-output-fixes 终态书写（error-reports/{date}/ + 对账ID列）。

### F7 — 测试 / 文档 / 守卫

- 基准单测**必含**：FTA202606021000477→2623（需求例）、FTA202604280200028（真实样本）、✅ ISO 口径跨年边界三元组写死断言（2026-01-01→2601 / 2025-12-29→2601 / 2027-01-01→2653）、+1 年末进位（日期语义）、双引擎互斥断言（✅ Q3：excludeBankRowIds 剔除后 R5s2 命中行绝不被 R5s2b 触碰）、Q6 同日算晚于边界断言（BillDate=交易日期 当日 → 算晚于、可匹配）。
- 引擎单测仿 `r5-fund-transfer-backfill.test.js`（行工厂 + 1v1 + tie-break + 三态审计）；orchestrator 行数守恒（modifiedRows+unmatchedRows===bankRows.length）+ midAllocationContext 注入（仿 refund 范式）；config 合并不掉桶断言；renderer-dialogs 源码字符串断言锁 gating（无 jsdom 既定范式 `renderer-dialogs-scenario-channel.test.js`）。
- integration：linked-table:import 清 processingResult 断言；smoke：scenario-end-to-end 扩展。收口 `npm run release-check` + 手测 /verify（勾选→导两表→run→导出：标黄/差错池/error-report 三出口 + stale 拒导出 + preview 截图）。
- 文档三件套 + `rules/important-variables.md` 升格新条目（paymentOfflineBackfill config / 新引擎 / weekTag）+ 顺手回写 `changes/linked-mid-allocation-date-column-migration/spec.md:3` 状态行（代码已实施，spec 仍写未实施）+ backlog 记 ADM_FUND_TYPES 小写 t 疑点。提 PR 前 `/check-vars` + `npm run scan:vars`。

## 5. 端到端数据流（终态）

```
UI 勾选+三输入（F1） → scenarios.update 浅合并 config_json（F2，自动清 processingResult）
→ 导入中台调拨单（现状链路不变；F4 补：导入成功清 processingResult）
→ 点「开始运行」bank-statement:run：按勾选 gating 读 mid 全表（F4）
→ runReconciliation(midAllocationContext) → 编排器 R5s2b（F4）
→ 引擎（F5）：订单池/银行池筛选 → 周数现算（F3）→ 周+1 join → 金额币种+晚于+就近贪心
→ 命中：渠道流水号→ReconciliationId+标黄（F6）；差错池二轮；未匹配→warnings
→ 导出：黄底主输出 + error-report（按 bank-recon-output-fixes 终态）
```

## 6. 影响范围与排期关系

### 6.1 代码

新增 3 文件（引擎 / week-utils / 字段常量）+ 改 6 文件（renderer-dialogs.js、styles-gemini-extra.css、main.js（run 注入 + 导入清缓存 + config 校验）、reconciliation-orchestrator.js、error-causes.js、renderer-previews.js/package.json preview 入口）。零 migration、零新表、零新 IPC（推荐方案下）。

### 6.2 check-vars 预命中（三路并集去重）

`runAllScenarios`/scenario-dispatcher（:184 Critical 🔴）、`unmatchedRows` 反向 filter 契约（:195 Critical 🔴）、`bankStatementSession`（:576）、`processingResult`（:596）、`refundOrderSession`（:605，同 handler 区域编辑勿误动 `main.js:11590` 批量清空）、`conditionsLogic`/`config_json.assign`（config 字段家族先例）、`INTERNAL_FIELDS`（:461）、`writeBankStatementOutput`（:877）、`state`/`elements`（renderer）、`updateStatusBox`/`hitScenarios`（若加状态框展示）。⚠️ 清单多处行号已陈旧（_rowId 重编号实在 bank-statement-merge.js:74-78、INTERNAL_FIELDS 实在 exceljs-writer.js:34），引用以代码为准并顺手刷新。

### 6.3 与其他 change 的排期关系

1. ✅ **`changes/bank-recon-output-fixes` 已拍板纳入 v3.0.4 同迭代并先行落地**（2026-06-11）——本功能 error-report 形态直接按其终态书写，无二次变更。
2. **`changes/size-startup-optimization` Part B**：无直接冲突（mid-allocation 属链接表非 run 级治理对象，§B.7 明示联动表留主库）；但 Part B 重度改 main.js/migrations.js，**排期错开编辑窗口**；本功能推荐的「零 migration」方案恰好规避 migrations.js 冲突。
3. ✅ **本功能已拍板并入 v3.0.4 迭代**（2026-06-11，用户指令多 spec 合并为一个迭代），作为迭代块 F；与 big-table 迁移等块**错开 main.js 编辑窗口串行集成**（main.js 含 NUL、git 视为二进制不可文本合并）。

## 7. 技术决策（推荐项，拍板见 §10.2）

| 决策 | 推荐 | 理由 |
|---|---|---|
| 挂载方式 | R5s2 的 config 子开关 + 新引擎文件 + 编排器 R5s2b 步骤（不新建独立场景） | UI 就长在该场景管理弹窗内；零 DB 迁移零 seed；父场景关闭子功能随之关闭语义合理 |
| 周数计算层 | run 时引擎内纯函数现算（不落 DB/raw_json） | 确定性派生无持久化价值；免 migration/双路径同步/存量回填；可单测 |
| 银行周数号形态 | 引擎内局部 Map（不写行对象） | 单次调用内消费，零写盘泄漏 |
| 订单 join | 全量载入 + 内存按周数号 Map 分组 | raw_json 内派生值无法 SQL 索引；readLinkedTableRows 先例现成；勾选 gating 控载入 |
| 就近匹配 | BillDate 升序 + dayDiff 升序稳定排序贪心，tie=原序 first-wins | R5s2/R5s4 双先例既定口径，需求例可复现，全局最优过重不可解释 |
| 「+1」实现 | 日期语义（判断日期+7 天所在周），禁 YYWW 数字加法 | §2.4 已证数字加法年末必错 |
| 周数工具归属 | 独立 engine-week-utils.js（复用 toDate） | date-utils 保持纯日期语义（三路分歧已裁定） |
| 字段常量 | 新建专属常量模块（不塞 adm-bank-deposit-fields） | 后者文件头红线只声明覆盖 ADM/JPM 四表 |

## 8. 风险（🔴 人工复核区）

1. **写错资金对账ID**：周数口径/FTA 解析/就近 tie-break 任一错 → 整批写错 ReconciliationId。缓解 = 基准断言矩阵（F7）+ 字段常量锁死 + 人工核对样本。
2. **与既有 R5s2 in 方向双写**：✅ 已拍板（Q3，2026-06-11）**网关回填优先**——R5s2 先跑，已消费/已回填 bank `_rowId` 经 excludeBankRowIds 剔除出新引擎银行池，写为引擎不变量 + 单测互斥断言；双写场景消失。
3. **config 整包覆盖**：UI 保存丢 seed 字段 → 场景静默掉桶（F2 双层守卫）。
4. **stale 资金数据**：mid-allocation 导入不清 processingResult（F4 必改 + 验收项）。
5. **跨年周错配**：✅ 已解决——Q2 拍板 ISO 8601 + ISO week-year，「+1」用日期语义（+7 天所在周）实现；基准四元组断言锁口径（F3/F7）。
6. **FundType 拼写**：取大写 T（资产表实证），上线前对真实导入数据抽样核对。
7. **差错池顺序耦合**：两轮 usedSet 共享与消费顺序 spec 固化，防同一订单重复消费。

## 9. 实施分期（3 PR 串行）

- **PR-1 后端地基** = F3 + F2(repo/main 侧守卫) + F4：纯函数+常量+接线+缓存失效，引擎入参先 no-op 空跑，验证数据通道闭合；全部单测/集成可覆盖，不含资金写入。
- **PR-2 引擎** = F5 + F6：资金红线核心，review 火力集中。**前置硬条件 = §10.1 六项澄清全部确认**。
- **PR-3 UI** = F1 + F2(弹窗侧) + 文档三件套：可与 PR-2 并行开发但后合；preview 回归必跑。

## 10. 待澄清 / 待拍板

### 10.1 🔴 阻塞性澄清（✅ 六项全部拍板，2026-06-11）

- [x] **Q1 UI 截断补全**（2026-06-11 拍板）：**三组输入框**（银行渠道/地区/大账号），无第四组；「地区」参与**银行侧筛选**——银行池三条件 = MerchantId=大账号 ∧ FundType=FundTransfer-in ∧ 地区列=地区输入值；勾选时三项全必填。
- [x] **Q2 周数口径**（2026-06-11 拍板）：**ISO 8601**（周一起点，含首个周四的周为 W1），**YY 取 ISO week-year**。基准四元组：2026-06-02→2623、2026-01-01→2601、**2025-12-29→2601**、**2027-01-01→2653**。
- [x] **Q3 双引擎互斥**（2026-06-11 拍板）：**网关回填优先**——R5s2 先跑（既有执行顺序）；已被 R5s2 消费/回填的银行行经 `excludeBankRowIds` 不进新引擎银行池，零互相覆盖（引擎不变量 + 单测互斥断言）。
- [x] **Q4 周数号可见性**（2026-06-11 拍板）：**纯内部匹配中间值**——run 时现算不持久化，不进导出文件/弹窗；备选 B1/B2 废弃。
- [x] **Q5 差错池语义**（2026-06-11 拍板）：**放宽周数约束**——二轮与全部未被消费的订单（不限「周数+1」）按 金额+币种+BillDate 晚于交易时间（Q6 同口径）+就近 再匹配；usedSet 跨两轮共享；匹配成功同样回填+标黄。
- [x] **Q6 「晚于」语义**（2026-06-11 拍板）：**同日算晚于 + 日粒度**（BillDate 取日 ≥ 交易时间取日）。⚠️ 与 §1.4 需求例 0601↔0530 的「暗示同日不算」孤立解读相反——AskUserQuestion 选项已显式标注冲突，用户知悉选定；需求例按就近规则孤立解读。差错池「早于」= 日粒度严格小于，两池互斥分区完备。

### 10.2 设计拍板（✅ 全部确认，2026-06-11，无异议项按推荐执行）

- [x] **D1 目标版本**：✅ **v3.0.4**（用户拍板并入 v3.0.4 迭代块 F；bank-recon-output-fixes 同迭代先行落地）
- [x] **D2 「+1」跨年实现**：✅ 日期语义（+7 天所在周）——ISO 口径已确认，基准四元组写死断言
- [x] **D3 挂载方式**：按推荐——R5s2 config 子开关 + R5s2b 步骤
- [x] **D4 FTA 不合规行**：按推荐——筛中行计 warning 不阻断，未筛中行静默跳过
- [x] **D5 error-report**：按推荐——仅对账单侧（带 _rowId）
- [x] **D6 ReconciliationId 原值非空**：✅ 已确认——Q3 互斥后双引擎双写场景消失，仅剩「原值来自其他来源非空」沿用命中即覆盖
- [x] **D7 输入框默认值**：按推荐——不预填生产值，placeholder 示例
- [x] **D8 多组配置**：按推荐——先单组，schema 留数组升级空间
