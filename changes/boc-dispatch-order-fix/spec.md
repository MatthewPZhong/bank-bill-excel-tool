# Spec — boc-dispatch-order-fix BOC调拨订单修复（内置场景 + BOC链接表派生 + 修复引擎）

> status: implemented（v3.0.4 分支，2026-06-11，commit 934148f..a3d7658；块 E F1 种子/F2 两隐藏表派生/F3 修复引擎全部入库，收尾文档批已落三件套/important-variables/backlog）
> owner: pzhong
> created: 2026-06-11
> updated: 2026-06-11
> 目标版本：**v3.0.4**（分支已切出；本 change 为迭代块 E，迭代入口 `changes/v3.0.4/spec.md`；与同迭代 `bank-recon-output-fixes` 零代码文件交叉，见 §6）
> 性质：🔴 **资金红线**（对账修复行生成 / 金额转分匹配 / bank-deposit 落库白名单扩列）+ 新增 2 张隐藏 SQLite 表 + 内置写死场景种子。提 PR 前必跑 `/check-vars`；动 renderer 须回归 `npm run preview`。
> 来源：2026-06-11 用户三项需求（v3.0.4 迭代）+ 4 项歧义拍板；调研：3 探索 agent + 2 设计 agent（关键事实均经 file:line 实读核验）。

---

## 1. 背景与需求

用户提出 v3.0.4 迭代三项需求，整体为「JPM调拨订单修复」（v2.1.16-beta.5 需求4）与「ADM 隐藏派生表」（同版本 §5.3）两套既有范式的 BOC 镜像：

- **需求1**：「网关对账单修复-场景管理」新增第 2 个内置写死场景：序号 2 / 功能类别=网关对账单修复 / 场景名称=**BOC调拨订单修复**。
- **需求2**：新建**隐藏链接表 BOC链接表**——表头 = 外汇交割表 34 列（真实表头在原文件第 2 行）+ 3 新字段「分组」「调拨单号」「资金对账不平表链接ID」。导入外汇交割表后：①从 A3 按物理行序扫描「交易编号」连续段分组（2.2 前段）；②中台调拨 BOC 行单行金额匹配剔除（2.2 后段）；③组汇总金额匹配回填调拨单号（2.3）；④缺 BOC 银行数据时弹框引导导入，派生第二张隐藏表 **BOC调拨银行对账单表**（筛 Channel=BOC/地区=CN/Currency=USD/Credit Amount=0，Payment Detail 含「无折存款借记交易」时提取数字赋「银行单交易编号」）（2.4）；⑤交易编号↔银行单交易编号匹配，回填 ReconciliationId 到「资金对账不平表链接ID」（2.5）。完成后弹框提示；链接ID 有空值只写 log，前端不显示。
- **需求3**：**BOC调拨订单修复引擎**——导入资金对账不平表（gateway 模式）后运行该场景：渠道账单 channelName=BOC 行的 reconciliationId ↔ BOC链接表「资金对账不平表链接ID」整组匹配；全组命中后用组「调拨单号」找网关账单 OrderId 同值行，复制 N 份（N=组行数）写修复模板，Type=2 / Reference=组内行链接ID / Amount=组内行「货币1金额」；可导出另存为；匹配失败记 log + 前端展示。

### 1.1 用户已拍板的 4 项决策（2026-06-11）

| # | 歧义点 | 拍板 |
|---|--------|------|
| U1 | 中台调拨订单表无「交易日期」列（实际只有「交易时间」第5列、「业务日期」第19列） | 用**「交易时间」取日期部分**（与 `linked_mid_allocation.transaction_date` 现状口径一致） |
| U2 | 需求 2.4「银行对账单链接ID为空」弹框条件 | **先查链接表库 bank-deposit 已有 BOC 数据**，有则直接派生回填不弹框；缺数据才弹「导入/取消」引导框 |
| U3 | Payment Detail 数字提取规则 | **最长连续数字串**（并列取最先出现一段并记 log） |
| U4 | 跨三张源表的重算触发时机 | **外汇交割表导入→全量重建 BOC链接表**（2.2~2.5 全跑，2.5 用库内已有银行数据尽力回填）；**银行对账单表导入→重派生 BOC调拨银行对账单表 + 对现有 BOC链接表补做 2.5 回填**；**中台调拨订单表导入不触发**（调拨单号 stale 风险记入文档，见 §5-R4） |

## 2. 代码现状（出处）

### 2.1 内置场景种子与场景管理（需求1 的范本）

- JPM 写死场景：`JPM_DISPATCH_ORDER_SCENARIO`（`src/backend/database/migrations.js:1771-1779`）——category='gateway-recon-id-fix'、priority=3、config.subCategory 为引擎分流键、merchantId 收进 config（R-10 范式）。
- 种子函数 `ensureJpmDispatchOrderScenarioSeed`（`migrations.js:1800-1883`）：CHECK 含 'gateway-recon-id-fix' 前置校验 → 独立 marker（`jpm_dispatch_order_scenario_seeded`）短路、删除终态不复活 → `config_json LIKE` 定位已存在跳过不覆盖 → INSERT 硬编码 `enabled=0`（默认休眠）、`is_builtin=1`、`channel_id=1` → UNIQUE(channel_id,name) 冲突跳过 → 事务包裹 + marker 必写。`database.js:330` 启动链调用。
- 排序：`listScenarios` 按 `priority DESC, id ASC`（`scenarios-repository.js:170-222`）；网关 compact 视图直接用该顺序 idx+1 编号（`renderer-dialogs.js:6788-6802`）；builtin 置顶仅对 `builtin-fixed` 类生效，对 gateway 内置场景**无置顶**。
- 内置只读行判定按类别泛化：`isBuiltinGatewayScenario = isBuiltin && category==='gateway-recon-id-fix'`（`renderer-dialogs.js:6682`）→ 新 BOC 场景进列表**零前端改动**。
- 功能类别显示：config 不带 funcCategory → 回退 `SCENARIO_CATEGORY_LABELS['gateway-recon-id-fix']`=「网关对账单修复」，零前端改动。

### 2.2 隐藏链接表体系（需求2 的范本）

- ADM 隐藏表 `linked_adm_bank_deposit`：DDL 见 `migrations.js:2806-2828`（`ensureAdmBankDepositSupport`，幂等 CREATE IF NOT EXISTS + 事务）；repo 定义入 `LINKED_TABLE_DEFS` 但**不进 `ALL_TABLE_KEYS`**（`linked-table-repository.js:111-123`）→ 前端 `listLinkedTableMeta` 不可见、不写 `linked_table_meta`。
- 派生纯函数范本 `buildAdmRows`（`src/main-process/adm-bank-deposit-builder.js:154-192`）：筛选→构造→批次号→中台一对一消耗匹配（`matchAdmToMidAllocation` `:88-143`）；字段名经 `adm-bank-deposit-fields.js` FIELD_MAP 单一真相 + 模块加载期断言（`:76-83`）。
- SQL 下推范本 `readBankDepositAdmCandidates`（`linked-table-repository.js:531-547`）：`json_extract(raw_json,'$.Channel')` 过滤只物化候选子集。
- 导入 handler：`linked-table:import`（`src/main.js:11274-11467`）——detectTableType → `readLinkedRowsAsObjects`（`:11151-11197`）→ 小文件数组路径 `replaceLinkedTable` / 大文件流式 `replaceLinkedTableStreaming`（`:11353-11372`）→ ADM 派生块（`:11392-11445`，独立 try/catch，结果挂 `okResult.admDerive`）。
- renderer 弹框联动：`createLinkedTableManagerDialog` 内 `findAdmDerive` 取最后一个带 admDerive 的 result（`renderer-dialogs.js:6303-6308`），导入明细确认后链式弹框（`:6396-6414`）；0 行静默已有拍板（`changes/adm-derive-popup-only-when-data/spec.md`，落 `:6333`）。

### 2.3 三张源表签名与字段

- 外汇交割表 `FX_DELIVERY_SIGNATURE`（`src/constants/table-signatures.js:137-155`）：34 列、headerRowOffset=1（真实表头第 2 行）、第 9 列（idx 9）为空列以 `''` 占位、`l1MatchHeaders` 9 列锚点；含「交易编号」(0)、「货币1金额」(6)、「货币2金额」(8)、「到期日」(12)、「交易日期」(29)。repo 键 `'fx-delivery'→'fx-settlement'`（`main.js:11107-11114`）；对象化时空表头列被跳过不入对象（`main.js:11190`）→ raw_json 实际 33 个命名字段。
- 中台调拨订单表 `ZHONGTAI_DISPATCH_ORDER_SIGNATURE`（`table-signatures.js:94-109`）：26 列，含「调拨单号」(0)、「交易时间」(4)、「收款金额」(9)、「付款渠道」(22)；**无「交易日期」列**（→ 拍板 U1）。
- 银行对账单表（bank-deposit）：44 列签名（`table-signatures.js:183-194`）；落库白名单 `BANK_DEPOSIT_FIELDS` 仅 13 字段（`linked-table-repository.js:31-34`）。

### 2.4 🔴 关键缺口一：bank-deposit 白名单不含 Payment Detail

`BANK_DEPOSIT_FIELDS` 13 字段 = BizId/BillDate/ValueDate/Channel/地区/MerchantId/Currency/Credit Amount/Debit Amount/ReconciliationId/ChannelOrderNo/CustomerRef/FundType，**不含 `Payment Detail`**（44 列契约第 17 列，`constants/bank-statement-fields.js`）。需求 2.4 的「银行单交易编号」提取完全依赖该字段 → 必须扩为 14 字段。**存量已导入的 bank-deposit 行 raw_json 无此字段、无法 migration 补**，只能识别后引导重导（见 §4 F2.3 availability 三态）。

### 2.5 🔴 关键缺口二：流式导入路径丢物理行号

- 数组路径：`readRowsWithMetadata` 以 `blankrows:true` 全量读后 filter 全空行，但**保留物理行号 `rowNumbers`**（`src/backend/file-service/readers.js:254-273`）；现状 `readLinkedRowsAsObjects` 调用后丢弃 rowNumbers。空行造成的行号断档可还原分组分隔符。
- 流式路径：`streamLinkedRowsToInsert` 用 `isRowMeaningful` 跳过空行且 onRow 的 rowIdx 不透传（`src/main-process/linked-table-stream-source.js:44`）→ **流式拿不到行号**。
- `.xls`（OLE2）一律 `useStreaming=false`（`table-type-detector.js:293-307`）；但**单 sheet .xlsx 交割表会命中流式** → 必须显式排除（§4 F2.5）。
- 落库后的 `linked_fx_settlement` 不存空行/行号 → **分组扫描必须在导入解析阶段做，不能事后从 DB 重建**。

### 2.6 recon-id-fix 修复链路（需求3 的范本）

- 引擎分流：`recon-id-fix-engine.js:26-35` 按 `scenario.config.subCategory==='jpm-dispatch-order-fix'` 分流，第三参 `opts` 注入外部数据。
- run handler：`main.js:3994-4055`——session/subMode 校验 → `runOpts = isJpmScenario ? { admRows: database.readAdmBankDepositRows() } : {}`（`:4030-4031`）→ 返回 `{ status, stats, warnings }`（warnings 已透传 renderer，`:4046-4051`）。
- 输出行构造：`buildOutputRow(srcRow, overrides, 'gateway')`（`c4-recon-id-fix.js:588-604`）14 列逐列从 srcRow 同名取、overrides 优先；JPM 用 overrides 注入 `Type`（**number 2**）与 `Reference`（`jpm-dispatch-order-fix.js:226-237`）——网关账单源行 Type 列原始列名是超长名 `'Type(0:1对1,...'`，短名 `'Type'` 取不到，必须 override（同坑先例）。
- 导出：`recon-id-fix:export`（`main.js:4057-4168`）按 category 推导 subMode='gateway' → saveDialog 另存为 → `writeReconIdFixOutput`（`recon-id-fix-io.js:233-268`）按 `ORDER_REPAIR_FIELDS_GATEWAY` 14 列写「订单修复」sheet。**fixedRows 形态一致即可零改动复用**。
- 前端反馈：`runGatewayReconScenario`（`renderer.js:4445-4474`）结果弹 `createAlertDialog`，现状**只显示警告条数不显示文案**，且 0 命中兜底文案硬编码 JPM merchantId（`:4468`）；按既有决策本面板不写 `bankStatementStatusBox`（`:4392/:4465` 注释禁写）。
- 4 sheet 字段：`gateway-bill-recon-fields.js`——网关账单 31 列（含 `OrderId`）、渠道账单 16 列（含 `channelName`/`reconciliationId`）、修复输出 14 列。
- 日志：`appendActivityLogEntry`（`main.js:662-678`）→ `logs/{YYYY-MM}/{MM-DD}/{level}.log` JSON Lines。
- 测试先例：引擎单测 `tests/unit/main-process/scenario-engines/jpm-dispatch-order-fix.test.js`；种子单测 `tests/unit/backend/database/migrations-jpm-dispatch-order-seed.test.js`；集成脚本范式 `scripts/integration/v3.0.1-linked-gateway-upsert.js`。

## 3. 目标 / 明确不做

- **必做**：F1 BOC 内置场景种子；F2 两张隐藏表 + 派生管线 + 弹框引导 + 日志（含 BANK_DEPOSIT_FIELDS 13→14 🔴）；F3 BOC 修复引擎 + 分流注入 + 运行反馈改造；四组单测 + 1 集成脚本 + 手测清单。
- **明确不做**：不动 JPM 引擎与 C4 通用算法；不动 `listScenarios` 排序机制（序号 2 靠 priority=3 + id 序自然成立，老库插队记已知限制）；不动导出 writer 与 `recon-id-fix:export`（零改动复用）；中台调拨订单表导入不触发 BOC 重算（U4 拍板）；BOC 两张隐藏表不进链接表管理 UI、不可导出（纯后台表）；不迁移/回补存量 bank-deposit 缺失的 Payment Detail 数据（引导重导）。
- **发版三件套**（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）按惯例在版本收口时统一更新，不在中间 commit 做。

## 4. 功能点

### F1 — BOC 内置写死场景种子（需求1）

- **改动**：`migrations.js` 新增（紧跟 JPM 种子之后）：
  ```
  BOC_DISPATCH_ORDER_SCENARIO = {
    category: 'gateway-recon-id-fix', name: 'BOC调拨订单修复', priority: 3,
    config: { subCategory: 'boc-dispatch-order-fix', channelName: 'BOC' }   // 仿 R-10：参数收进 config，引擎读 config、常量兜底
  }
  BOC_DISPATCH_ORDER_SCENARIO_SEEDED_MARKER = 'boc_dispatch_order_scenario_seeded'
  ensureBocDispatchOrderScenarioSeed(db)   // 逐条复刻 migrations.js:1800-1883：CHECK 前置/独立 marker/LIKE 定位/enabled=0/is_builtin=1/channel_id=1/UNIQUE 冲突跳过/事务+marker
  ```
  `database.js` init 链在 `ensureJpmDispatchOrderScenarioSeed()`（`:330`）之后调用 → 新库 id 紧随 JPM → `priority DESC, id ASC` 下序号自然 = 2。
- **零前端改动**：compact 视图序号、只读操作列、「是否启动」开关、功能类别显示全部自动成立（§2.1）。
- **边界**：老库存在用户自建 gateway 场景 priority=3 且 id 更小时会插队（序号 2 非强保证）——与 JPM「priority 兜底值」同口径，PR 说明 + 手测覆盖，不扩置顶机制。
- **验收**：种子单测 6 案 + 排序案（§9.1）；手测场景管理列表序号 2 / 只读行 / 默认未启用。

### F2 — BOC链接表派生管线（需求2，两张隐藏表）

#### F2.1 DDL（`migrations.js` 新增 `ensureBocFxLinkSupport(db)`，幂等，仿 ADM）

```sql
CREATE TABLE IF NOT EXISTS linked_boc_fx_settlement (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_no TEXT,   -- 「交易编号」归一化纯数字串（2.5 匹配热列）
  group_no TEXT,         -- 「分组」（'1','2'…；2.2 剔除后 ''）
  allocation_no TEXT,    -- 「调拨单号」（2.3 回填，可空）
  recon_link_id TEXT,    -- 「资金对账不平表链接ID」（2.5 回填，可空）
  maturity_date TEXT,    -- 「到期日」归一 YYYY-MM-DD（匹配热列）
  source_row INTEGER,    -- 原文件物理行号（诊断）
  raw_json TEXT NOT NULL, imported_at TEXT NOT NULL
);  -- + idx(transaction_no), idx(group_no)
CREATE TABLE IF NOT EXISTS linked_boc_bank_deposit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_txn_no TEXT,      -- 「银行单交易编号」
  reconciliation_id TEXT, bill_date TEXT,
  raw_json TEXT NOT NULL, imported_at TEXT NOT NULL
);  -- + idx(bank_txn_no)
```

两表均**不进 `ALL_TABLE_KEYS`、不写 `linked_table_meta`**（隐藏红线，单测断言）。纯新增无破坏性 DDL。

#### F2.2 常量（新建 `src/constants/boc-fx-link-fields.js`，单一真相，仿 adm-bank-deposit-fields.js）

`BOC_CHANNEL_VALUE='BOC'`（中台「付款渠道」与银行 Channel 共用）；`BOC_BANK_FILTER={地区:'CN', Currency:'USD', creditAmountCents:0}`；`BOC_PAYMENT_DETAIL_KEYWORD='无折存款借记交易'`；`BOC_LINK_EXTRA_FIELDS=['分组','调拨单号','资金对账不平表链接ID']`；`BOC_BANK_EXTRA_FIELD='银行单交易编号'`；`BOC_LINK_HEADERS=[...FX_DELIVERY_SIGNATURE.expectedHeaders, ...新3字段]`；跨表 FIELD_MAP + **模块加载期断言**（交割表表头含 交易编号/货币2金额/到期日；`BANK_DEPOSIT_FIELDS` 含 'Payment Detail'——防白名单回退漂移）。

#### F2.3 builder（新建 `src/main-process/boc-fx-link-builder.js`，纯函数：不读 DB/不碰 FS/不依赖 Electron；logs 返回给 caller 统一写 activity log）

- 工具：`normalizeTransactionNo`（纯数字原样；`123.0`→`123`；空/含非数字/科学计数→`''`）、`toCents`（parseNumber 去千分位→×100 四舍五入；非数值 null）、`toIsoDate`（复用 `normalizeDateExportValue`，`normalizers.js:445`，取日期部分）、`extractLongestDigitRun`（最长连续数字串，并列取最先 + log）。
- **Step1 `scanFxGroups({objects, rowNumbers})`**：按物理行序遍历；「交易编号」归一化为空（含合计/页脚等非数字行）→ 关当前组、该行不入表；`rowNumbers` 断档（被过滤的全空行）→ 关组；连续纯数字段成组，组号 1,2,3… 仅在非空段递增。产出行 = 原 33 命名字段 + 分组/调拨单号=''/链接ID='' + 内部辅助键（__txnNo/__maturityIso/__sourceRow，落库前剥到热列）。
- **Step2.2+2.3 `matchBocToMidAllocation(bocRows, midRows)`**（一对一消耗，全部多解记 warning 不抛错）：
  - 候选 = 中台「付款渠道」='BOC' 行，预解析 `交易时间→日期部分`、`收款金额→分`（解析失败剔出候选 + warning）；
  - **2.2**：按中台行序遍历，找「分组非空 ∧ 到期日=候选日期 ∧ 货币2金额(分)=收款金额(分)」的 BOC 行；多命中行序优先取首 + log；命中行「分组」清空，该中台行消耗（不进 2.3）；
  - **2.3**：剩余组按分组汇总货币2金额（组内任一行金额非数值→整组放弃 + warning；组内到期日不一致→warning + 取首行）；与未消耗中台候选（同日期对齐）匹配；命中→该中台行「调拨单号」回填**组内所有行**，一组配一单（消耗）；多候选行序优先 + log；无命中组调拨单号留空。
- **Step2.4 `buildBocBankRows(candidates)`**：availability 三态——候选 0 行=`no-boc-rows`；候选有行但全部无 `Payment Detail` 自有键（旧 13 字段时代导入）=`missing-payment-detail`；否则 `ok` 并过滤 `地区='CN' ∧ Currency='USD' ∧ Credit Amount 转分=0`，Payment Detail 含关键词→提取最长数字串赋「银行单交易编号」（含关键词但无数字→'' + warning）。
- **Step2.5 `backfillBocReconLinkIds(rowsWithIds, bankRows)`**：bank_txn_no 索引（重复键留 id 最小行 + warning）；逐行以归一化交易编号查表，命中→「资金对账不平表链接ID」=该行 ReconciliationId，未命中→''；**幂等全量重算**（旧值被覆盖）；`unlinkedCount>0` → caller 写 warning 级 activity log（含行号/交易编号明细，**前端不显示**——需求 2.5 末句）。

#### F2.4 repository（`linked-table-repository.js` + `database.js` wrapper）

- 🔴 **`BANK_DEPOSIT_FIELDS` 13→14：插入 `'Payment Detail'`**。影响：bank-deposit raw_json 字段集扩大；ADM 派生行 `{...r}` 浅拷贝连带多带该字段（JPM 引擎全程 FIELD_MAP pick，核验无副作用）；**更新既有 13 字段断言单测**（`tests/unit/.../bank-deposit-import.test.js`）。
- 新增 defs：`'boc-fx-settlement'`（keyColumn=transaction_no, dateColumn=maturity_date）、`'boc-bank-deposit'`（keyColumn=bank_txn_no, dateColumn=bill_date），注释「绝不进 ALL_TABLE_KEYS」。
- 新增函数（仿 ADM 段 `:571-664`）：`readBankDepositBocCandidates`（json_extract 下推 Channel='BOC' 超集，地区/币种/金额终审在 builder）、`replaceBocFxLink`（整表覆盖，8 列 INSERT）、`readBocFxLinkRows`（ORDER BY id ASC，供引擎）、`readBocFxLinkRowsWithIds`、`writeBocFxLinkReconIds`（事务内按 id UPDATE raw_json+recon_link_id，比 ADM 位置配对更稳）、`replaceBocBankDeposit`、`readBocBankDepositRows`。

#### F2.5 main.js 导入钩子（`linked-table:import` handler，4 处）

1. **交割表强制数组路径**：`useStreamingPath = detected.streamingEligible && repoKey !== 'fx-settlement'`（🔴 守卫注释：BOC 分组依赖物理行号断档，流式 feed 过滤空行且不透传 rowIdx；交割表行数小无 OOM 风险）。
2. `readLinkedRowsAsObjects` 拆出 `readLinkedRowsAsObjectsWithMeta → {objects, rowNumbers}`（既有调用方零行为变化）。
3. **fx-settlement 派生块**（okResult 构造后，独立 try/catch，失败不阻断交割表导入本身）：scanFxGroups → matchBocToMidAllocation（中台数据经 `readLinkedTableRows('mid-allocation')`；无数据则 2.2/2.3 跳过、info log）→ `replaceBocFxLink` → `readBankDepositBocCandidates` → `buildBocBankRows` → `replaceBocBankDeposit`（无可用数据也重建为空表防 stale）→ `readBocFxLinkRowsWithIds` → `backfillBocReconLinkIds` → `writeBocFxLinkReconIds` → 汇总 logs 写 `appendActivityLogEntry` → `okResult.bocDerive = { created, total, groupCount, step22Removed, step23MatchedGroups, step23UnmatchedGroups, backfilled, unlinkedCount, needBankImport: availability!=='ok', bankMissingReason }`；异常 → `bocDerive={created:false, error}`。
4. **bank-deposit 派生块**（现有 ADM 块之后，独立 try/catch）：重派生 BOC调拨银行对账单表；若 `linked_boc_fx_settlement` 有行 → 补做 2.5 全量回填 → `okResult.bocBankDerive = { created, bankRowCount, backfilled, unlinkedCount }`。

#### F2.6 前端弹框链（`renderer-dialogs.js` 链接表管理弹框，仿 findAdmDerive 接在 ADM 链之后）

| 条件 | 行为 |
|---|---|
| `bocDerive.created && total>0 && !needBankImport` | `createAlertDialog('BOC链接表已生成', {skipLogReport:true})`（需求 2.5「弹出框提示已生成」） |
| `needBankImport`（U2 拍板） | `createConfirmDialog`：「BOC链接表已生成分组与调拨单号，但链接表库无可用的 BOC 银行对账单数据，无法回填资金对账不平表链接ID。是否现在导入 BOC 银行对账单？」导入→复用链接表管理导入流程（需求 2.4「从链接表管理里导入」）；取消→关闭。`missing-payment-detail` 时文案提示**重新导入**银行对账单表 |
| `total===0` | 静默（仿 ADM 0 行拍板） |
| `created:false` / `bocBankDerive` 失败 | 错误弹框（默认 error 上报） |
| bank-deposit 导入触发的补回填成功 | 静默（不打扰；见 §10 O1） |

「链接ID 为空的行」只落 activity log（F2.3 Step2.5），前端无任何显示。

### F3 — BOC调拨订单修复引擎（需求3）

#### F3.1 引擎（新建 `src/main-process/scenario-engines/boc-dispatch-order-fix.js`）

`runBocDispatchOrderFix({ sheets, bocLinkRows, scenario }) → { fixedRows, warnings, stats }`——纯函数：不读 DB/不写日志/不依赖 Electron；**入参只读**（sheets 三数组与 bocLinkRows 不被修改，单测快照断言）；链接表只读不回写（无 JPM writeAdmMatchFlags 类比物）；同输入必同输出。复用 `engine-utils`（normalizeCellValue/parseNumber/makeWarningCollector）+ `buildOutputRow`（c4）。

算法（渠道账单驱动，8 步）：

```
1. bocChannels = 渠道账单中 trim(channelName)===config.channelName||'BOC' 的行
   0 行 → warn boc-channel-not-found 早返回；bocLinkRows 空 → warn boc-link-table-empty 早返回
2. 建索引：linkGroups（仅分组非空行，按组聚合）；linkByReconId（链接ID→组集合）；channelByReconId
3. 按渠道行原序遍历：reconciliationId 空→计数跳过；未命中链接表→stats.channelUnlinked++（不告警，D6）；
   命中多组→warn link-id-ambiguous 相关组全失败（D7）；命中组已处理→跳过
4. 组级校验（任一失败→整组失败：warn + 不产出 + 不消耗任何渠道行）：
   组内调拨单号须一致且非空（group-allocation-inconsistent / group-allocation-missing）；
   调拨单号未被其他组用过（group-allocation-reused，D8 从严）
5. 组内逐行 1v1 试配：每行链接ID 非空（空→group-link-id-empty 整组失败）且能在渠道 BOC 行中找到
   未消耗、未被本组占用的同 reconciliationId 行（找不到→group-partial-match 整组失败）——需求3「依次开始匹配，
   全部匹配成功后」
6. 网关账单 OrderId===调拨单号 须唯一命中（0 命中 gw-orderid-not-found / 多命中 gw-orderid-multi-match
   均整组失败，D4 从严，区别于 JPM 取第一）
7. 提交：网关命中行复制 N 份（N=组行数），经 buildOutputRow overrides 注入
   Type=2（number）/ Reference=组内对应行链接ID / Amount=组内对应行「货币1金额」（原值透传，D10）；
   消耗渠道行与调拨单号
8. 返回 fixedRows / warnings（每条带 code + 中文 message，供前端直显——JPM 仅 code 的向后兼容增量）/ stats
```

stats：`channelTotal / channelBocTotal / channelEmptyReconId / channelUnlinked / linkRowTotal / linkGroupTotal / groupTouched / groupMatched / groupFailed / fixedRowCount`（`fixedRowCount` 键名必须保留，`renderer.js:4462` 消费）。

#### F3.2 匹配语义决策表（资金红线，从严）

| # | 决策点 | 拍板 |
|---|---|---|
| D1 | 渠道 BOC 行 ↔ 链接表行 1v1 消耗 | 是；组内同链接ID 出现 k 次须有 k 条同 reconId 渠道行 |
| D2 | 链接ID 为空的链接表行 | 不可匹配，所在组必然整组失败 |
| D3 | 组失败粒度 | 整组失败：不产出、不消耗已试配渠道行、记 log+warning |
| D4 | 网关 OrderId 命中数 | 唯一命中才生成；0/≥2 命中整组失败 |
| D5 | channelName 比较 | trim 后精确等值（大小写敏感），值从 config 读、常量兜底 |
| D6 | 渠道 BOC 行未命中链接表 | 只计数不告警（避免无关行刷屏） |
| D7 | 同链接ID 跨多组 | 数据异常，相关组全失败 |
| D8 | 两组共享调拨单号 | 第二组失败（同一网关行复制两轮属资金风险） |
| D9 | Type 写值 | number 2（JPM 先例 + writer 原样落数值格） |
| D10 | Amount 取值 | 「货币1金额」原值透传，不 parseNumber 改写（与源表一致） |
| D11 | 网关匹配加 MerchantId 过滤？ | 不加（需求未提；OrderId 等值唯一判据） |

#### F3.3 输出 14 列映射（ORDER_REPAIR_FIELDS_GATEWAY）

每组 N 份 = 同一网关命中行复制 N 份，仅 3 列经 overrides 行级注入：**Type**=2（源行只有超长列名 `'Type(0:...'`，短名取不到必须 override）、**Reference**=组内对应链接表行「资金对账不平表链接ID」、**Amount**=组内对应行「货币1金额」；其余 11 列（BillDate/Bank/MerchantId/OrderId/DataSource/OppBu/OriginBillSource/BillType/Currency/OriginBillBizId/ReconBillBizId）从网关源行同名复制。

#### F3.4 分流 / 注入 / 日志 / 前端反馈

- `recon-id-fix-engine.js`：JPM 分支后并列 `config.subCategory==='boc-dispatch-order-fix'` → `runBocDispatchOrderFix({sheets, bocLinkRows: opts.bocLinkRows||[], scenario})`。
- `main.js` run handler（`:4026-4051` 区段）：`isBocScenario` 判定 → `runOpts={bocLinkRows: database.readBocFxLinkRows()}`；run 后 warnings 非空 → `appendActivityLogEntry({level:'warning', domain:'boc-dispatch-order-fix', message:'[BOC调拨订单修复] 成功 X 组/失败 Y 组，Z 条警告', details: warnings.map(w=>w.message||w.code)})`（需求3「生成 log 记录」）。
- 导出零改动（§2.6）；新增字段常量文件 `src/constants/boc-dispatch-order-fields.js`（chChannelName/chReconId/gwOrderId/link 三字段/货币1金额 的 FIELD_MAP + 与 boc-fx-link-fields.js 的加载期对齐断言）。
- **前端唯一改动**（`renderer.js` runGatewayReconScenario 约 10 行）：①结果弹框逐条显示前 5 条 warning 中文 message（**手工 escape 后拼 `<br>`**，防 innerHTML 注入——警告含表格数据值），超 5 条尾缀「等 N 条，详见操作日志」；②0 命中兜底文案去 JPM merchantId 硬编码，改场景无关通用文案；③有警告时弹框带 logLevel:'warning' 上报。需求原文「报错记录显示在状态框里」按本面板既有决策（bankStatementStatusBox 禁写，`renderer.js:4392/:4465`）落到**运行结果弹框 + activity log**——见 §10 O2 待确认。

## 5. 边界情况与风险

**边界（实现必须覆盖，单测对应 §9.1）**：空交割表（仅标题+表头）→ 空表静默；尾部合计/页脚行（交易编号空或含非数字）→ 不入表不成组（需求 2.2 终止条件天然满足）；全空行分隔 → rowNumbers 断档识别；连续多个分隔行不产空组号；组内到期日不一致 → warning+首行优先；无中台数据 → 2.2/2.3 跳过、组调拨单号留空、2.4/2.5 照跑；金额含千分位/非数值、日期解析失败 → 剔候选+warning 不抛错；交易编号 `926181062.0` → 去尾零小数，科学计数法判非数字；一次多选 fx+bank 文件 → 两块各自触发、renderer 取最后一个 bocDerive；派生任一步抛错 → 表导入本身已成功、`created:false` 弹错误框。

**风险表**：

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | BANK_DEPOSIT_FIELDS 13→14（raw_json 字段集变化、ADM 行连带、存量数据缺字段） | 🔴 | 加载期断言 + missing-payment-detail 重导引导 + `/check-vars` + 更新既有断言单测 |
| R2 | 单 sheet .xlsx 交割表误入流式路径丢行号 | 🔴 | `repoKey!=='fx-settlement'` 显式守卫 + 手测专项 |
| R3 | 修复行生成属资金对账输出 | 🔴 | D1-D11 全从严（失败不产出）+ 全量 warning 审计 + 人工核对样本 |
| R4 | 中台重导后 BOC 调拨单号 stale（U4 拍板不触发） | 🟡 | CHANGELOG/USER_GUIDE 注明「中台更新后请重导交割表」 |
| R5 | 2.2/2.3 贪心行序匹配非全局最优（同日同额理论可错配） | 🟡 | 用户拍板行序优先；多解全记 warning log 可审计 |
| R6 | 序号 2 非强保证（老库 priority=3 用户场景插队） | 🟢 | PR 说明 + 手测 |
| R7 | warnings 数据值直插弹框 innerHTML | 🟡 | 复用既有手工 escape 范式（`renderer.js:4119-4125`） |

## 6. 影响范围

- **新建**（7 文件）：`src/constants/boc-fx-link-fields.js`、`src/constants/boc-dispatch-order-fields.js`、`src/main-process/boc-fx-link-builder.js`、`src/main-process/scenario-engines/boc-dispatch-order-fix.js`、4 个单测文件（§9.1）、`scripts/integration/v3.0.4-boc-dispatch-order-fix.js`、`docs/iterations/v3.0.4/manual-test-checklist.md`。
- **修改**（7 文件）：`migrations.js`（DDL + 种子）、`database.js`（init 链 + wrapper）、`linked-table-repository.js`（白名单 🔴 + defs + 6 函数）、`src/main.js`（import 钩子 ×2 + 数组路径守卫 + readLinkedRowsAsObjectsWithMeta + run 注入与日志；**含 NUL 字节，检索须 `grep -a`，编辑前确认目标行不含 NUL**）、`recon-id-fix-engine.js`（分流分支）、`renderer-dialogs.js`（弹框链）、`renderer.js`（运行反馈）。
- **零改动面**：导出链路（recon-id-fix-io.js / export handler）、preload.js、4 sheet 字段常量、场景管理 UI、C4/JPM 引擎、链接表管理列表（隐藏表不可见）、DB 既有表（纯新增 DDL）。
- **与 in-flight 变更关系**：`bank-recon-output-fixes`（C3/error-report 域）与本 change 零代码文件交叉（除 main.js 不同 hunk）；`linked-table-large-file-streaming` 已落地的流式路径被本 change 对 fx-settlement 显式绕开（守卫即契约）；`size-startup-optimization` Part B 的 run 级侧库迁出不含链接表（无冲突）。
- **对外契约变更（CHANGELOG 标注）**：银行对账单表（链接表）落库字段 +1（Payment Detail，需重导才生效）；新增隐藏表 2 张（DB 文件体积增量 ≈ 交割表 + BOC 银行候选行）。

## 7. 技术决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 分组扫描落点 | 导入解析阶段（objects+rowNumbers），非 DB 事后重建 | 落库不保留空行/行号（§2.5），唯一可行点 |
| 交割表路径 | 强制数组路径（排除流式） | 流式丢行号；交割表体量小无 OOM 风险 |
| 隐藏表语义 | 整表覆盖 + 不进 ALL_TABLE_KEYS/meta | 与 ADM 完全同范式，前端零感知 |
| 2.5 回填定位 | 按 id UPDATE（非 ADM 的位置配对） | 无重建错位风险 |
| builder 纯函数 + logs 上抛 | 不在 builder 内写日志 | 可单测；main.js 统一 appendActivityLogEntry |
| 引擎数据注入 | runOpts.bocLinkRows（仿 admRows） | 引擎不读 DB，保持纯函数 |
| 失败语义 | 整组失败不产出（比 JPM 取第一更严） | 资金红线：宁缺勿错；引擎头注释防后人「对齐 JPM」误改 |
| warnings 带中文 message | code+message 双字段 | 需求3 要求前端显示报错文案；对 JPM 结构向后兼容 |

## 8. 实施顺序（5 commits，一 task 一 commit）

1. **commit 1 = F2 数据层**：boc-fx-link-fields.js + boc-fx-link-builder.js + DDL/repository/database.js（含 🔴 白名单 13→14 与既有断言更新）+ builder/repo 单测——纯函数与库层先行，全绿后才接管线。
2. **commit 2 = F2 接线**：main.js 导入钩子（数组路径守卫 / WithMeta / fx 派生块 / bank 派生块）+ renderer-dialogs.js 弹框链 + preview 回归。
3. **commit 3 = F1 种子**：migrations.js 种子 + database.js init 链 + 种子单测。
4. **commit 4 = F3 引擎**：boc-dispatch-order-fields.js + 引擎 + 分流 + run 注入与日志 + renderer.js 反馈 + 引擎单测。
5. **commit 5 = 收口**：集成脚本 + 手测清单 + `npm run scan:vars` + `/check-vars` 产出 + spec 状态更新。

## 9. 测试与验收

### 9.1 单元测试（node:test，`npm run test:unit`）

- `tests/unit/main-process/boc-fx-link-builder.test.js`：normalizeTransactionNo（5 形态）；extractLongestDigitRun（最长/并列取首/无数字/全角不计）；scanFxGroups（单组/分隔行/空行断档/混合/尾部合计排除/空表/组号递增/source_row）；2.2（精确命中清分组/千分位/Excel 序列号日期/多候选行序优先/消耗后不进 2.3/非 BOC 渠道不参与）；2.3（组和命中回填全组/一组一单消耗/到期日不一致/金额非数值整组放弃/无中台数据）；buildBocBankRows（四条件各取负例/关键词提取/availability 三态）；backfill（命中/未命中''/重复键首行/幂等重算）。
- `tests/unit/backend/database/linked-table-boc.test.js`：migration 幂等；**隐藏红线断言**（不进 ALL_TABLE_KEYS、listLinkedTableMeta 不返回）；replace 覆盖语义 + ROLLBACK；按 id 回写；json_extract 下推三态；**BANK_DEPOSIT_FIELDS=14 断言**（同步更新既有 13 字段断言文件）。
- `tests/unit/main-process/scenario-engines/boc-dispatch-order-fix.test.js`（~17 案）：组全配（Type===2 number / Reference/Amount 行级 / 11 列同源行 / stats）；组半配（不消耗渠道行）；无调拨单号/不一致；OrderId 0 命中/多命中；链接ID 空；渠道无 BOC 行/链接表空早返回；1v1 消耗（k 行同链接ID 需 k 条渠道行）；跨组同链接ID；两组共享调拨单号；channelName trim/大小写；分组空行忽略；入参不可变快照；分流回归（boc/jpm/无 subCategory/business 四路）；stats 完整性。
- `tests/unit/backend/database/migrations-boc-dispatch-order-seed.test.js`：镜像 JPM 种子 6 案（fresh 字段/marker 短路/删除不复活/CHECK 未扩 skip/UNIQUE 冲突/marker 必写）+ 排序案（JPM→BOC 依次 seed 后 gateway 子集顺序 = [JPM, BOC]）。

### 9.2 集成（`npm run test:integration` 自动发现）

`scripts/integration/v3.0.4-boc-dispatch-order-fix.js`（仿 v3.0.1-linked-gateway-upsert 自跑断言范式）：临时 DB → 种子 → 经 repo 写 BOC链接表 fixture → XLSX 现造 4 sheet 不平表 → `readReconIdFixFile(file,'gateway')` → `runReconIdFix(scenario, sheets, {bocLinkRows})` → 断言 fixedRows/stats/warnings → `writeReconIdFixOutput({subMode:'gateway'})` → 读回断言 14 列表头 + Type=2 + Reference/Amount 行级值。

### 9.3 手测清单（`docs/iterations/v3.0.4/manual-test-checklist.md`，🔴 资金红线人工复核）

场景管理序号 2/只读行/默认休眠；fx→bank→fx 三序导入收敛一致；**单 sheet .xlsx 交割表确认走数组路径**；缺银行数据弹引导框（导入/取消两路）；missing-payment-detail 重导引导；activity log 出现 unlinked 明细且前端无感；启用场景→导入不平表→运行→弹框含失败文案→导出另存为→文件 14 列/Type=2/Reference/Amount 人工核对一份真实样本。

### 9.4 守卫

`npm run release-check` PASS；`npm run scan:vars` + `/check-vars`（预计命中：linked-table 域、scenarios 域、recon-id-fix 域条目）；`npm run preview` 回归（动了 renderer-dialogs.js/renderer.js）。

## 10. 决策点（✅ 全部拍板，2026-06-11）

| # | 决策点 | 拍板 |
|---|---|---|
| O1 | bank-deposit 导入触发的 BOC 补回填成功时是否弹提示 | ✅ 静默（错误才弹） |
| O2 | 需求3「报错记录显示在状态框里」的落点 | ✅ **运行结果弹框（逐条文案）+ activity log**（用户拍板：不动 `renderer.js:4392/:4465` 既有状态框禁写决策） |
| O3 | D10 Amount「货币1金额」取值 | ✅ 原值透传（与源表 byte 级一致），不 parseNumber 改写 |
| O4 | 2.2/2.3 金额匹配是否附加币种校验（货币2↔收款币种） | ✅ 不加（按需求字面，仅金额+日期匹配） |
