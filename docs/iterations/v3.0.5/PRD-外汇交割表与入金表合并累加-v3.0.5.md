# PRD - 网银账单小助手 v3.0.5「外汇交割表 + 银行对账单入金表 覆盖→幂等累加合并导入（含跨期重复命中提醒）」

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.5 |
| 日期 | 2026-06-15 |
| 作者 | PM |
| 状态 | 定稿可实施（spec OPEN-1~7 全闭环，2026-06-15 全部拍板） |
| 模块 | 资金对账数据处理 → 链接表库（fx-settlement / bank-deposit）落库语义 + 跨期重复命中提醒 |
| 来源 spec | `changes/linked-fx-bank-deposit-merge-import/spec.md`（✅ 全部拍板，OPEN-1~7 全闭环） |
| 先例 | v3.0.1 网关对账单同款改造（`changes/linked-gateway-bill-batch-idempotent/spec.md`）——本 change 范式全盘复用 |
| 依赖 / 协调 | `refund-backfill-rules-v2`（同版本；OPEN-7b 的 R3/R5/R6 命中 hook 由其落地时接入，代码顺序 **linked-fx 先**）；`size-startup-optimization` 剩余 Phase（同版本，无代码耦合） |

> 🔴🔴 **资金红线大改造**：本期把链接表库「外汇交割表 fx-settlement」+「银行对账单入金表 bank-deposit」的落库语义从「整表覆盖 `replaceLinkedTable`（DELETE 全表 + INSERT）」改为「跨次幂等 upsert 累加」（仿网关 v3.0.1），并新增「跨期重复命中提醒」机制。**累加写错 = 资金对账数据源错**（漏行 / 多行 / 覆盖合法行）；migration 触碰实测 65.7 万行存量入金表；BOC 派生组号每次 fx 导入全量重编号；export 新增回写链接表的写路径。每一处资金敏感点本文均以 🔴🔴 高亮，实现与评审必须逐条人工复核。

---

## 一、需求概述

本文件描述 **1 项资金红线改造**（含 1 个 bug 修复 + 1 套新机制）：

> **一句话**：把链接表库的「外汇交割表 fx-settlement / `linked_fx_settlement`」与「银行对账单入金表 bank-deposit / `linked_bank_deposit`」从「整表覆盖」改成「跨次幂等 upsert 累加」（同键覆盖、新键追加、空键拒入、meta 全表重算，仿网关 v3.0.1），同时新增「跨期重复命中提醒」机制（累加后历史月份残留行被对账再次命中时，在输出端给出可见提醒）。**顺带修复 bug**：一批多选 N 个同类型文件时只剩最后一个（前 N-1 个被静默整表覆盖，但前端显示「N 个成功」）。

**改造对象表（三张链接表落库语义对照）**：

| 链接表（repo key / 物理表） | 现状落库语义 | 本期改造后 | 幂等键（OPEN） |
|---|---|---|---|
| **网关对账单** `gateway-bill` / `linked_gateway_bill` | ✅ 已是「跨次幂等累加 upsert」（v3.0.1 落地） | **不改行为**（仅内核泛化重构，parity 锁定字节不变） | `ReconBillBizId`（已有） |
| **外汇交割表** `fx-settlement` / `linked_fx_settlement` | ❌ 整表覆盖 `replaceLinkedTable`（DELETE+INSERT） | **改累加** + BOC 派生表「全量重算 + 组号重编号」 | **交易编号单键** `normalizeTransactionNo(交易编号)`（OPEN-2） |
| **银行对账单入金表** `bank-deposit` / `linked_bank_deposit` | ❌ 整表覆盖（流式 / 数组双路） | **改累加**（数组 + 流式双路 upsert，65 万行内存恒定） | **`BizId`** `BANK_DEPOSIT_FIELDS[0]`（OPEN-1） |
| 中台调拨订单 `mid-allocation` / `linked_mid_allocation` | 整表覆盖 | **维持覆盖不改**（§2.3 明确不做） | —（不引入幂等键） |

> 派生表连锁（隐藏表，不在前端弹窗）：fx-settlement 累加 → `linked_boc_fx_settlement`（BOC 链接表）改「增量进组 + DB 全量重匹配 + 组号重编号」；bank-deposit 累加 → `linked_adm_bank_deposit`（ADM）与 `linked_boc_bank_deposit`（BOC bank）自动以「全库行」为输入重建（消费方天然兼容累加，逻辑零改动，仅输入变多）。

---

## 二、背景与目标

### 2.1 背景

#### 2.1.1 为什么要做 —— 多选覆盖 bug 根因（与网关 v3.0.1 同根因）

- 链接表导入入口 `linked-table:import`（`src/main.js:11372`）多选文件后逐文件落库：`for (const filePath of res.filePaths)`（`src/main.js:11384`）。
- **除 gateway-bill 走 upsert 外，其余表走整表覆盖**（`src/main.js:11468-11484`）：
  - `isGatewayBill` 为真 → `upsertLinkedGatewayBill(Streaming)`（幂等累加）；
  - 否则 → `replaceLinkedTable(repoKey, ...)`（数组路径）/ `replaceLinkedTableStreaming`（流式路径）—— 二者均 `DELETE FROM 表` + INSERT（`linked-table-repository.js:290` 数组版 DELETE / `:332` 流式版 DELETE）。
- **后果（资金红线 bug）**：一批多选 N 个同类型 fx / bank-deposit 文件 → 文件 1 被文件 2 删、文件 2 被文件 3 删 → 库里只剩文件 N；但 N 个文件在 `results` 里**都返回 `status:'ok'`**（`src/main.js:11486` okResult），前端汇总显示「N 个成功」→ **静默丢数据**。用户 2026-06-11 指示「（外汇交割表与链接表库银行对账单）两个都改成合并，落 spec」。

#### 2.1.2 网关 v3.0.1 先例已沉淀完整范式（本期全盘复用）

| 范式件 | 出处（file:line） |
|---|---|
| upsert 内核（ON CONFLICT DO UPDATE + 先 SELECT 判覆盖计数 + 空键拒入） | `buildGatewayUpsertContext`（`linked-table-repository.js:368`） |
| meta 全表重算（COUNT(*) + MIN/MAX 日期，累加后不可用单批增量） | `recomputeGatewayMeta`（`linked-table-repository.js:406`） |
| 数组版 + 流式版双路 upsert（事务跨 await，throw 即 ROLLBACK） | `upsertLinkedGatewayBill`（`:458`）/ `upsertLinkedGatewayBillStreaming`（`:492`） |
| 按日期范围 count/delete（ISO 格式硬守卫 + 删后 meta 重算） | `countGatewayBillByDateRange`（`:423`）/ `deleteGatewayBillByDateRange`（`:434`）；IPC `src/main.js:11327`/`:11346` |
| migration：键列回填（`TRIM(json_extract)`）+ 存量去重（保留 MAX(id)）+ 删空键 + UNIQUE 索引 + 同步 meta | `migrations.js:2846-2868`（v3.0.1 网关段代码本体；含前置注释从 :2837 起） |
| 前端覆盖提醒（overwriteCount / rejectedEmptyCount 回传导入完成框） | `src/main.js:11494-11497`（okResult 注入） |

#### 2.1.3 当前问题汇总

1. 占位级 bug：多选同类型文件静默丢前 N-1 个（§2.1.1）。
2. 旧心智「重导=清空」对 fx / bank-deposit 仍生效，但用户已要求改累加，需 UI 明确告知语义已变。
3. 累加后历史月份残留行仍参与对账匹配（读取口径不收窄），缺少「这条是上一期已命中过的残留行，疑似漏删」的可见提醒（OPEN-7 新机制）。

### 2.2 目标

1. **fx-settlement / bank-deposit 落库 = 跨次幂等累加**：不再 `DELETE FROM` 全表；同幂等键覆盖为最新值、新键追加、空键拒入并计数；meta 全表重算；`source_file_name` = 最后一次导入文件名（gateway 同款）。
2. **一批多选 N 个同类型文件**：逐文件 upsert，最终库内容 ≡ 把 N 个文件拼成 1 个大文件导入（同键后者覆盖前者，按文件顺序）。
3. **BOC 派生链在合并语义下正确**：任意一次 fx 导入后，BOC 链接表反映**全库**交割数据的分组 + 调拨单号 + 链接ID（全量重算 + 组号重编号）；bank-deposit 导入后 ADM / BOC bank 派生基于全库候选重建。
4. **删除按日期范围支持三张表**（gateway / fx / bank-deposit），删除后联动重建相应派生表并清相关缓存。
5. **导入完成框**对两表显示「幂等覆盖 N 条 / 空键拒入 N 条」（发生才显示，仿 gateway D3）。
6. **跨期重复命中提醒**（OPEN-7）：累加表残留行被对账再次命中时，输出端给出可见提醒（§5.4）。

### 2.3 明确不做（本期范围外，契约维持）

1. **mid-allocation（中台调拨订单表）不改合并**——维持整表覆盖 `replaceLinkedTable`，维持 v3.0.4 契约④「mid 导入不触发 BOC 重算」（`src/main.js:11601` mid-allocation 分支仅重建 ADM、绝不触发 BOC 重匹配）。
2. **网关对账单逻辑零改动**——仅把 upsert 内核泛化（参数化重构），行为**字节不变**，parity 锁定（既有 v3.0.1 单测 + 集成 40 断言全过）。
3. **对账引擎匹配读取口径维持全表**——不引入硬性消费排除 / 日期窗（用 §5.4 软提醒 + §5.3 删除管理范围替代）。`readLinkedTableRows('bank-deposit')`（`src/main.js:3646`）/ `('gateway-bill')`（`:3641`）继续读全表。
4. **fx-option（外汇期权表）仍不落库**（模板缺失，detector 标 unsupported，`table-signatures.js:162` FX_OPTION_SIGNATURE）。

---

## 三、代码现状（必须有出处）

| 主题 | 相关文件（file:line） | 当前行为 | 已知限制 / 改造点 |
|------|---------|---------|---------|
| 导入 handler 分流 | `src/main.js:11468-11484` | 仅 `isGatewayBill`（`:11449`）走 upsert；其余表走 `replaceLinkedTable(Streaming)` 整表覆盖 | fx / bank-deposit 分支须换 upsert（T4） |
| 导入 handler 注释 | `src/main.js:11182-11183` / `:11370-11371` | 注释明写「gateway 幂等累加，其余 3 张整表覆盖」 | 注释须同步改（fx/bank-deposit 也累加） |
| 整表覆盖（数组） | `replaceLinkedTable`（`linked-table-repository.js:277`，DELETE `:290`） | DELETE 全表 + 单事务 INSERT；4 张表共用 | 🔴 不能改它（mid 仍用）；fx/bank-deposit 改调 upsert |
| 整表覆盖（流式） | `replaceLinkedTableStreaming`（`:318`，DELETE `:332`） | DELETE 全表 + 流式 INSERT；65 万行单事务跨 await 已实测 657,757 行 ROLLBACK | bank-deposit 流式分支改调流式 upsert |
| 网关 upsert 内核 | `buildGatewayUpsertContext`（`:368`）/ `recomputeGatewayMeta`（`:406`） | 网关专用（硬编码 `ReconBillBizId` / `getDef('gateway-bill')`） | T2 泛化为参数化内核，gateway/bank-deposit/fx 共用，禁复制第二份 |
| 网关 upsert 双路 | `upsertLinkedGatewayBill`（`:458`）/ `upsertLinkedGatewayBillStreaming`（`:492`） | 数组 + 流式，返回 overwriteCount/rejectedEmptyCount + 全表重算 meta | T2 产出 bank-deposit 双路 + fx 数组版同范式 |
| 删除 count/delete | `countGatewayBillByDateRange`（`:423`）/ `deleteGatewayBillByDateRange`（`:434`） | 硬编码 gateway（`getDef('gateway-bill')` + `bill_date`） | T2 参数化 tableKey（白名单三表，各自 dateColumn） |
| 删除 IPC | `count-by-date-range`（`src/main.js:11327`）/ `delete-by-date-range`（`:11346`，trackedIpcHandle） | 硬调 `database.countGatewayBillByDateRange` / `deleteGatewayBillByDateRange`；ISO 格式硬守卫 `:11334`/`:11353` | T4 加 `tableKey` 参数（缺省 gateway-bill 向后兼容） |
| 删除派生联动 | `src/main.js:11358-11363`（删 gateway 后 `processingResult=null`） | 仅网关：删后清 processingResult | T4 扩 fx（联动删 BOC + 重匹配）/ bank-deposit（重建 ADM+BOC bank + 清缓存 + 清命中标记） |
| 入金表白名单裁列 | `BANK_DEPOSIT_FIELDS`（`linked-table-repository.js:35`，14 字段；`BizId`=`[0]`）/ `pickBankDepositFields`（`:51`） | 14 字段白名单 pick（含 Payment Detail），裁列在 upsert 前 | `BizId` 自始在白名单 → 存量 raw_json 可回填（OPEN-1） |
| 入金表体量 | `linked-table-repository.js:545` 注释 | 实测 65.7 万行 → ~1.2GB RSS 尖峰 | 🔴 migration 必须 SQL 侧完成；upsert 流式版内存恒定（R-6） |
| fx 主表 schema | `migrations.js:2890-2901` | `transaction_no`（来自「交易编号」，**普通索引非 UNIQUE** `:2900`）+ `transaction_date` + raw_json；合计/页脚行整行落库 | T1 加 UNIQUE（键列回填 + 去重 + 删空键） |
| bank-deposit 主表 schema | `migrations.js:2908-2918` | `reconciliation_id`（普通索引）+ `bill_date` + raw_json | T1 加 `biz_id` 列 + UNIQUE + `last_hit_run`/`last_hit_at` 列 |
| 键归一口径 | `normalizeKey`（`linked-table-repository.js:227`，`String().trim()`）/ `normalizeTransactionNo`（`boc-fx-link-builder.js:32`） | 网关 `normalizeKey`；BOC 派生交易编号专用归一（去尾零 / 非数字→空） | fx 主表幂等键用 `normalizeTransactionNo`（与 BOC 派生同口径） |
| fx detector 签名 | `FX_DELIVERY_SIGNATURE`（`table-signatures.js:137`，dateColumn=`交易日期` `:152`，l1MatchHeaders `:149`） | 34 列，第 0 行标题、表头第 1 行；第 9 列空列占位 | 不改 |
| bank-deposit detector 签名 | `BANK_DEPOSIT_SIGNATURE`（`table-signatures.js:183`，dateColumn=`BillDate` `:191`） | 44 列同构主表，仅在 `LINKED_IMPORT_SIGNATURES`（`:224`）| 不改 |
| fx 强制数组路径 | `src/main.js:11450-11454`（`useStreamingPath = detected.streamingEligible && repoKey !== 'fx-settlement'`） | fx 永不走流式（BOC 分组需物理行号断档） | 守卫保持；fx 仅数组版 upsert |
| BOC 派生编排 | `src/main.js:11511-11587`（fx 落库成功后全跑 2.2~2.5） | scan→matchBocToMidAllocation→`replaceBocFxLink`（整表覆盖）→buildBocBankRows→replaceBocBankDeposit→backfill→writeBocFxLinkReconIds | T3/T4 改「增量进组 + 全量重匹配 + 重编号」 |
| BOC scan 分组 | `scanFxGroups`（`boc-fx-link-builder.js:88`） | 按物理行号断档 / 非数字交易编号切组，组号 1..N 文件内递增 | 续编：`offset = MAX(orig_group_no)`，本文件组号 += offset |
| BOC 中台匹配 | `matchBocToMidAllocation`（`boc-fx-link-builder.js:143`，2.2 单行剔除 `:174` 清空「分组」`:191`，2.3 组汇总 `:206`） | 全候选与全组一对一消耗；2.2 命中行清空「分组」→ 原始组号不可从现库恢复 | 输入从「本文件行」改「全库行」；新增 `orig_group_no` 锚点 |
| BOC 整表覆盖落库 | `replaceBocFxLink`（`linked-table-repository.js:735`，DELETE `:747`） | DELETE 全表 + INSERT 8 列；BOC 链接表只反映最后一个文件 | T3 改 upsert（按交易编号键，新增 UNIQUE）+ orig_group_no |
| BOC 读回 | `readBocFxLinkRows`（`:784`）/ `readBocFxLinkRowsWithIds`（`:799`，[{id,row}] ORDER BY id ASC） | 全表读，供 2.5 回填 / 修复引擎 | 全量重匹配读全库 BOC 行（ORDER BY id ASC 行序） |
| bank-deposit 派生候选 | `readBankDepositAdmCandidates`（`:552`，Channel='ADM' 下推）/ `readBankDepositBocCandidates`（`:713`，Channel='BOC' 下推） | json_extract 下推过滤，仅物化候选子集 | 累加后自动以全库候选重建，逻辑零改动 |
| BOC 派生表 schema | `migrations.js:2965-2994`（`ensureBocFxLinkSupport`，`linked_boc_fx_settlement` / `linked_boc_bank_deposit`） | v3.0.4 新表，存量极少；隐藏表不写 meta | T1 加 `orig_group_no` + 键 UNIQUE + 清空两表（OPEN-3） |
| 对账场景4 数据源 | `src/main.js:3646`（`workingDepositRows = structuredClone(readLinkedTableRows('bank-deposit'))`） | 全表读喂引擎 depositRows | 累加后输入变多，读取口径不收窄 |
| 场景4 JPM-US 桥接 | `matchJpmUs`（`r5-refund-order-backfill.js:183`，命中详情 `:96` `匹配命中详情`） | 按 ReconId/ChannelOrderNo 命中入金表行取 CustomerRef 比对 bank | OPEN-7b「入金表残留行被命中」主入口（注入提醒） |
| 主输出命中明细 | `exceljs-writer.js:243`（`hitHeaders = [HIT_DETAIL_HEADER, ...headers]`，命中明细列 `:259-263`） | sheet2「命中场景」首列命中明细 | OPEN-7 主输出银行行命中明细提醒注入点 |
| 删除弹框 | `renderer-dialogs.js:6526` 附近（标题写死「删除网关对账单数据」） | 无表选择 | T6 加「目标表」下拉（三表） |

> 说明：`linked-table-repository.js` / `boc-fx-link-builder.js` / `r5-refund-order-backfill.js` / `table-signatures.js` / `migrations.js`（v3.0.1 段 + 链接表建表段 + BOC 段）/ `exceljs-writer.js`（命中明细段）/ `src/main.js`（导入 handler 11160-11700 + 删除 handler + 对账数据源段）均已逐行核对；`BANK_DEPOSIT_FIELDS[0]='BizId'` 经 `linked-table-repository.js:36` 确认；fx 交易编号唯一性以 spec §3.2.1 实测（`20260513即期结售汇交易明细.xls` 24 行全唯一）为据。
> ⚠️ **T1/T2 落地顺手修源码 stale 注释**：`BANK_DEPOSIT_FIELDS` 自 v3.0.4 加 `Payment Detail` 后实为 **14 字段**（数组 `linked-table-repository.js:36-38` 14 元素），但内联注释 `linked-table-repository.js:48/50/101/891` 仍写「13 字段」——dev 落 T1/T2 时顺手改 13→14，避免照注释写错裁列断言（D-4，与文档无关）。

---

## 四、术语

| 术语 | 含义 |
|------|------|
| 幂等键 | 跨次导入判重的列。gateway=`ReconBillBizId`；bank-deposit=`BizId`（OPEN-1）；fx=`normalizeTransactionNo(交易编号)`（OPEN-2）。同键二次导入覆盖为最新值，不新增行 |
| 空键拒入 | 幂等键归一后为空字符串的行不入库并计数（防 UNIQUE 冲突 + 防脏数据）。三表均以**幂等键本身归一为空**判定：fx=交易编号归一为空（合计/页脚行交易编号列为非数字文本 → `normalizeTransactionNo` 返回 '' → 拒入；⚠️ fx 主表无「调拨单号」列，`table-signatures.js:141-147`，不可按调拨单号判空键）；bank-deposit=BizId 空；gateway=ReconBillBizId 空（spec §3.2.1） |
| 累加（幂等 upsert） | 落库不再 `DELETE FROM` 全表；`INSERT ... ON CONFLICT(幂等键) DO UPDATE`：同键覆盖、新键追加、历史保留。N 个文件多选 = 拼成 1 个大文件导入 |
| meta 全表重算 | 累加后 rowCount / 日期范围不能用单批增量算，须 `COUNT(*)` 全表 + `MIN/MAX(日期列)` 全表（排除 null/空串）。仿 `recomputeGatewayMeta` |
| 全量重算（BOC） | 任意一次 fx 导入后，读全库 BOC 行重跑 2.2/2.3 中台匹配（含历史组）。中台数据在两次 fx 导入间变过 → 历史组调拨单号随之刷新 |
| 组号重编号 | 全量重匹配前按 `orig_group_no` 聚合后按行序（ORDER BY id ASC）全局重编号 1..N（消除空洞）。**组号每次 fx 导入会变**（OPEN-5 已接受） |
| 原始组号 `orig_group_no` | BOC 链接表新增列：scan 时刻的组归属，**永不被 2.2/2.3 改写**（现有 `group_no` 退化为「匹配后展示分组」）。全量重匹配的前提 |
| 跨期残留（行） | 累加后历史月份仍留在 `linked_bank_deposit` 的入金表行。读取口径不收窄 → 它们仍参与对账匹配 |
| 命中标记 | `linked_bank_deposit` 专用列 `last_hit_run`（上次命中所属对账运行标识）+ `last_hit_at`（命中时间）。export 成功后回写；用于「跨期重复命中提醒」（OPEN-7c，不动 65.7 万行 raw_json） |

---

## 五、功能详细描述

### 5.1 bank-deposit 累加（全仿 gateway 先例）

#### 5.1.1 说明

- **幂等键 = `BizId`**（`BANK_DEPOSIT_FIELDS[0]`，`linked-table-repository.js:36`；OPEN-1 已定）。自 13 字段时代就在白名单 → 存量 raw_json 可回填；与网关 `ReconBillBizId` 同族。
- 🔴🔴 **`ReconciliationId` 不可用作幂等键**：R1/R5 引擎注释证实银行侧同 reconid 多行 = 合法数据异常（同一笔多行），用 `ReconciliationId` 做 UNIQUE 会静默互相覆盖丢行。**必须用 `BizId`**。
- **migration（T1，仿 v3.0.1，全 SQL 侧）**：`linked_bank_deposit` 加 `biz_id` 列 → `UPDATE ... SET biz_id = TRIM(json_extract(raw_json,'$.BizId'))` → 删空键行 → 同键去重保留 `MAX(id)` → 建 UNIQUE 索引 `idx_linked_bank_deposit_biz`。幂等可重入（仿 `migrations.js:2846-2868` 网关范式）。🔴🔴 资金数据不可逆删除 → `appendModuleLog`（warning）记删除行数；删除后同步 `linked_table_meta`（rowCount/日期范围，仿 `:2860-2866`）。
- **仓储（T2）**：`buildGatewayUpsertContext`（`:368`）/ `recomputeGatewayMeta`（`:406`）泛化为参数化内核（表 def + 幂等键列 + 键取值函数），gateway / bank-deposit / fx **共用同一份**，🔴 禁止复制粘贴第二份（防口径漂移）；产出 `upsertLinkedBankDeposit`（数组版）+ `upsertLinkedBankDepositStreaming`（流式版，🔴🔴 保持 65 万行内存恒定约束，单事务跨 await throw 即 ROLLBACK，仿 `:492`）。裁列 `pickBankDepositFields`（`:51`）在 upsert 前调用，不变。
- **main.js（T4）**：bank-deposit 分支（`src/main.js:11479-11484` 数组路径 / `:11468-11470` 流式路径）由 `replaceLinkedTable(Streaming)` 换 `upsertLinkedBankDeposit(Streaming)`；`okResult`（`:11486`）回传 `overwriteCount / rejectedEmptyCount`；**既有派生触发与缓存清理零改动**（ADM 派生 `:11606-11641`、BOC bank 派生 `:11645-11685`、`processingResult=null` `:11695-11697`）。

#### 5.1.2 累加语义（与 gateway 完全一致）

```
逐行 upsert（BizId 幂等键）：
  · BizId 归一后为空 → rejectedEmptyCount += 1，不入库；
  · DB 已存在同 BizId → 覆盖该行（raw_json/reconciliation_id/bill_date/imported_at 全部重写），overwriteCount += 1；
  · DB 无该 BizId → 追加。
落库后 recompute*Meta 全表重算 rowCount / 日期范围；source_file_name = 本次导入文件名。
一批多选 N 个 bank-deposit 文件：循环内逐文件 upsert，N 个文件全部生效（除非彼此含相同 BizId）。
```

> 🔴🔴 R-1（资金红线）：BizId 选作幂等键的前提是**行级唯一**。上线后导入完成框覆盖计数是观测口径（异常大 = 键选错信号）；建议实施前用真实银行对账单抽样核 BizId 重复率。

### 5.2 fx 累加 + BOC 全量重算重编号（核心难点）

#### 5.2.1 主表 `linked_fx_settlement` 累加（键 = 交易编号单键）

- **幂等键 = `normalizeTransactionNo(交易编号)`**（`boc-fx-link-builder.js:32`，与 BOC 派生同口径；number 须经 `normalizeCellValue` String 化，9 位纯数字无科学计数风险）。OPEN-2 实测 `20260513即期结售汇交易明细.xls` 24 数据行交易编号**全唯一**（distinct 24/24）。
- **空键拒入 = 交易编号归一为空**：合计/页脚行=末行（交易编号列="生成日期:YYYYMMDD" 为非数字文本、渠道流水号空）→ `normalizeTransactionNo` 对其返回 '' → 以**交易编号归一为空**判定空键拒入并计数（=幂等键本身为空，与 gateway/bank-deposit 同口径）。⚠️ **fx 主表无「调拨单号」列**（`table-signatures.js:141-147` FX 签名 expectedHeaders 不含此列；调拨单号是 BOC 派生表/中台字段）→ 不可按调拨单号判 fx 行空键（对 fx 原始行恒空会全表拒入）（spec §3.2.1）。
- **migration（T1）**：fx 体量小 → JS 层全表读 → 按定稿键重算 `transaction_no` 键列 → 删空键 → 去重保留 `MAX(id)` 兜底 → 建 UNIQUE 索引（单事务，幂等可重入）。
- **upsert 仅数组版**（fx 永不走流式，`src/main.js:11454` 守卫保持）：`src/main.js:11482-11484` 的 fx 分支由 `replaceLinkedTable('fx-settlement', ...)` 换 `upsertLinkedFxSettlement(rows, ...)`（共用 T2 泛化内核）。
- 🔴🔴 **主表无任何 DB 读取消费方**：全仓 `readLinkedTableRows('fx-settlement')` 零命中；主表作用 = meta 行数/日期范围展示 + raw_json 留底。**真正的资金链路在派生表 `linked_boc_fx_settlement`**。R-3：若拒入合计行，主表不再留底（现状留底），影响仅 meta 行数与 raw_json 留底完整性（已核实无 DB 消费方）。

#### 5.2.2 BOC 链接表 `linked_boc_fx_settlement`：增量进组 + DB 全量重匹配 + 重编号

> 现状：BOC 派生在导入时刻基于**内存中的本文件** objects+rowNumbers 进行（`src/main.js:11514` scanFxGroups），产物 `replaceBocFxLink`**整表覆盖**（`linked-table-repository.js:747` DELETE 全表）→ BOC 链接表只反映最后一个文件。改造后须反映**全库**。

**新增列 `orig_group_no`（原始组号）**：scan 时刻的组归属，**永不被 2.2/2.3 改写**（现有 `group_no` 退化为「匹配后展示分组」）。这是全量重匹配的前提（2.2 命中行会清空「分组」`boc-fx-link-builder.js:191`，原始组号不可从现库恢复）。

**每次 fx 导入的派生流程（T3/T4）：**

1. 对**本文件** `scanFxGroups`（物理行号分组逻辑零改动，`boc-fx-link-builder.js:88`）；组号续编：`offset = SELECT MAX(CAST(orig_group_no AS INTEGER))`，本文件组号 += offset（全局不冲突）。
2. scan 产物按主表幂等键（交易编号同口径）**upsert 进 BOC 表**（新增 UNIQUE 索引）：同键覆盖（迁移到新组，id 不变 → 行序稳定），新键追加。替换 `replaceBocFxLink` 整表覆盖。
3. **全量重匹配 + 重编号**（OPEN-5）：读全库 BOC 行（`readBocFxLinkRowsWithIds` `:799`，`ORDER BY id ASC` 作行序优先口径）→ 按 `orig_group_no` 聚合后**按行序全局重编号 1..N**（消除空洞）→ 重置 `分组 = 重编号后组号`、`调拨单号 = ''` → 重跑 `matchBocToMidAllocation`（2.2+2.3 逻辑零改动，输入从「本文件行」变「全库行」）→ 整批写回。
4. 2.4（`buildBocBankRows` + `replaceBocBankDeposit`）与 2.5（`backfillBocReconLinkIds` 全量回填 `boc-fx-link-builder.js:321`）**照旧**。

> 🔴🔴 **语义变化（OPEN-5 已接受，R-2）**：mid-allocation 导入仍**不**触发重匹配（维持 v3.0.4 契约④）；但**任意一次 fx 导入会全量重算所有组（含历史组）的调拨单号**——中台数据在两次 fx 导入间变过则历史组调拨单号随之刷新。组号每次重编号，跨次活动日志组号会变。下游 BOC 修复引擎（`boc-dispatch-order-fix.js`）按「分组」聚合整组匹配，组号值本身无跨表业务含义（仅组内一致标识），故重编号不破坏修复引擎语义。

#### 5.2.3 BOC 派生表 migration（OPEN-3）

migration（T1）内**清空 `linked_boc_fx_settlement` + `linked_boc_bank_deposit`**（存量原始组号不可恢复）；首次启动后引导用户重导一次外汇交割表全量恢复（沿用 needBankImport 弹框链文案，`src/main.js:11577` bocDerive.needBankImport）。BOC 链接表加 `orig_group_no` 列 + 交易编号键 UNIQUE 索引。

### 5.3 删除按日期范围扩展（OPEN-4，三表下拉）

- **IPC（T4）**：`count-by-date-range`（`src/main.js:11327`）/ `delete-by-date-range`（`:11346`）加 `tableKey` 参数（缺省 `gateway-bill` 向后兼容）；白名单 = 三张表，逐表走各自 dateColumn（gateway=`bill_date`、fx=`transaction_date`、bank-deposit=`bill_date`）。仓储 `countGatewayBillByDateRange` / `deleteGatewayBillByDateRange`（`:423`/`:434`）参数化为接受 tableKey。ISO 格式硬守卫（`:11334`/`:11353`）保持。
- **前端（T6）**：删除弹框（`renderer-dialogs.js:6526`）加「目标表」下拉（默认网关；标题随选择切换），其余交互不变。
- 🔴🔴 **删除后的派生联动（必须，R-5）**：
  - **删 fx 行** → 按被删行的 `transaction_no` 集合**联动删 BOC 表同键行**（⚠️ 不能按日期删 BOC 表：其日期列是到期日 `maturity_date`）→ 全量重匹配 + 重编号（复用 5.2.2 第 3/4 步）。
  - **删 bank-deposit 行** → 重建 ADM + BOC bank 派生 + 2.5 全量回填 → 清 `processingResult` + `reconIdFixResult` + **同步清 OPEN-7 命中标记中指向被删 BizId 的项**（防悬挂）。
  - **删 gateway-bill 行**为不变（`src/main.js:11358-11363` 现状）。
  - 派生联动重建必须与删除在**一致事务边界**完成，禁止「删了主表、派生表 stale」中间态。

### 5.4 OPEN-7 跨期重复命中提醒机制（7a / 7b / 7c）

> 目标：累加后历史月份残留行仍参与对账匹配（读取口径不收窄，§2.3-3）；不硬排除，而是**标记 + 再次命中时提醒**，让用户看见「这条是上一期已命中过的残留行，疑似漏删」。

**机制骨架（T5）：**

1. **持久字段（7c）**：落 `linked_bank_deposit` 专用列 `last_hit_run`（TEXT，上次命中所属对账运行标识）+ `last_hit_at`（命中时间），键 = BizId（OPEN-1 幂等键）。🔴🔴 **不动 65.7 万行 raw_json**（避免全表改写），列由 T1 migration 加。
2. **命中口径（7b）= 所有以入金表为来源的命中**：
   - 现有 **R5 场景4 JPM-US 桥接**（`matchJpmUs` `r5-refund-order-backfill.js:183`）：作为桥接促成一条成功回填的入金表行；
   - `refund-backfill-rules-v2` 新增的 **R3（HK CustomerRef 二跳）/ R5（Drawee+DESC DATE）/ R6（附言原单日期金额）** 二跳——⚠️ **R3/R5/R6 的命中点 hook 由 refund-backfill 落地时一并接入本机制**（跨 spec 契约，见 refund spec §2.8 D12；本期只接现有 matchJpmUs，预留 hook 接口）。
3. **运行标识防同批误报**：标识取「当期银行对账单导入会话 id / 时间戳」（每次 run 用同一新导入会话即同一 id）。命中时若该行 `last_hit_run` 非空 **且 ≠ 当前运行标识** → 判定「跨期重复命中」→ 写提醒；随后更新该行 `last_hit_run = 当前标识`。**同批重复 run/export 标识相同 → 不误报**。
4. **写入时机（7a）= `bank-statement:export` 成功后回写**（run 可反复执行不写；export = 用户对该批命中的权威确认）。🔴🔴 **这是 export → 链接表的新增写路径**（export 现在会 mutate `linked_bank_deposit`），R-8：须保证标记写入失败**不影响导出产物落地**（标记是观测增强，非资金数据），且与删除（§5.3）联动清理被删 BizId 的标记防悬挂。
5. **提醒出口**（对应用户原话）：
   - 命中来自 R5 场景4 → **中台退款回填文件**对应回填行的 `匹配命中详情`（`r5-refund-order-backfill.js:96`）追加「⚠️ 桥接入金表行 BizId=… 此前于 [last_hit_at] 已被命中，疑似历史残留」。
   - 命中来自主对账链 → **主输出「命中明细」**（`exceljs-writer.js:243` 首列 HIT_DETAIL_HEADER）对应行追加同款提醒。

**三子项一句话**：**7a** 写入时机 = export 成功后；**7b** 命中口径 = 所有入金表来源命中（matchJpmUs + refund R3/R5/R6）；**7c** 字段载体 = 专用列 `last_hit_run`/`last_hit_at`（不动 raw_json）。

### 5.5 前端导入完成框计数（T6）

- 导入完成框 per-file 明细：fx / bank-deposit 两表新增「本次幂等覆盖 N 条」「空键拒入 N 条」（发生才显示，文案同 gateway D3，`src/main.js:11494-11497` okResult 范式）。
- BOC 派生弹框链（`renderer-dialogs.js:6362-6507`）**零结构改动**。
- 删除弹框成功文案随 tableKey 显示表名。
- 🔴 前端改造（`renderer-dialogs.js`）提 PR 前必须重跑对应 `npm run preview`（项目约定 workflow_frontend_previews）。

---

## 六、验收标准（AC，按 T1~T7 / 三表 / OPEN-7 分组可勾选）

### 6.1 T1 migration AC

| AC 编号 | 验收条件 |
|---------|---------|
| [ ] AC-T1-1 | `linked_bank_deposit` 加 `biz_id` 列 + 回填 `TRIM(json_extract(raw_json,'$.BizId'))` + 删空键 + 去重保留 MAX(id) + UNIQUE 索引；幂等可重入（二次启动不报错、不重复删） |
| [ ] AC-T1-2 | bank-deposit migration 全 SQL 侧完成（不 JS 全表读 65 万行）；删除后同步 `linked_table_meta`（rowCount/日期范围）；删除行数写 appendModuleLog(warning) |
| [ ] AC-T1-3 | `linked_fx_settlement` 键列 `transaction_no` 按 `normalizeTransactionNo` 重算 + 删空键 + 去重保留 MAX(id) + UNIQUE 索引（JS 层全表重算，单事务幂等可重入） |
| [ ] AC-T1-4 | `linked_boc_fx_settlement` 加 `orig_group_no` 列 + 交易编号键 UNIQUE 索引 |
| [ ] AC-T1-5 | migration 清空 `linked_boc_fx_settlement` + `linked_boc_bank_deposit`（OPEN-3）；首启引导重导交割表 |
| [ ] AC-T1-6 | `linked_bank_deposit` 加 `last_hit_run` + `last_hit_at` 列（不改 raw_json） |

### 6.2 T2 仓储 upsert 内核泛化 AC

| AC 编号 | 验收条件 |
|---------|---------|
| [ ] AC-T2-1 | upsert 内核泛化为参数化（表 def + 幂等键列 + 键取值函数），gateway/bank-deposit/fx 共用同一份；🔴 无第二份复制实现（grep 验证） |
| [ ] AC-T2-2 | `upsertLinkedBankDeposit`（数组版）：同键覆盖（overwriteCount）、新键追加、空键拒入（rejectedEmptyCount）、meta 全表重算 |
| [ ] AC-T2-3 | `upsertLinkedBankDepositStreaming`（流式版）：单事务跨 await，中途 throw 全 ROLLBACK；65 万行内存恒定 |
| [ ] AC-T2-4 | `upsertLinkedFxSettlement`（数组版，无流式）：同键覆盖、交易编号归一为空拒入、meta 全表重算 |
| [ ] AC-T2-5 | 删除 count/delete 参数化 tableKey（白名单三表，各自 dateColumn）；缺省 gateway-bill 向后兼容 |

### 6.3 T3 BOC upsert + 重匹配重编号 AC

| AC 编号 | 验收条件 |
|---------|---------|
| [ ] AC-T3-1 | BOC 表 upsert（交易编号键 + orig_group_no）：组号续编 offset = MAX(orig_group_no)；同键覆盖 id 不变 |
| [ ] AC-T3-2 | 全量重匹配读全库 BOC 行（ORDER BY id ASC）→ 按 orig_group_no 聚合 → 全局重编号 1..N（无空洞） |
| [ ] AC-T3-3 | 重匹配前重置 `分组`/`调拨单号` → 重跑 matchBocToMidAllocation（2.2+2.3 逻辑字节不变） |
| [ ] AC-T3-4 | 「重置-重匹配」幂等：同输入两次结果一致；2.2 剔除后 orig_group_no 不变 |

### 6.4 T4 main.js 导入/删除 AC

| AC 编号 | 验收条件 |
|---------|---------|
| [ ] AC-T4-1 | bank-deposit 数组 + 流式分支换 upsert；fx 数组分支换 upsert（fx 守卫保持永不流式） |
| [ ] AC-T4-2 | fx 导入触发 BOC 全量重算 + 重编号（替换 replaceBocFxLink 整表覆盖） |
| [ ] AC-T4-3 | 删除 handler 扩 tableKey；删 fx 联动删 BOC 同 transaction_no 行 + 重匹配重编号 |
| [ ] AC-T4-4 | 删 bank-deposit 重建 ADM+BOC bank + 清 processingResult/reconIdFixResult + 清命中标记 |
| [ ] AC-T4-5 | bank-deposit 既有派生（ADM/BOC bank）+ 缓存清理零回归 |

### 6.5 T5 OPEN-7 机制 AC

| AC 编号 | 验收条件 |
|---------|---------|
| [ ] AC-T5-1 | 7a：命中标记仅在 `bank-statement:export` 成功后回写（run 不写）；标记写入失败不影响导出产物落地 |
| [ ] AC-T5-2 | 7b：matchJpmUs 命中入金表行纳入命中标记；R3/R5/R6 hook 接口预留（refund-backfill 接入） |
| [ ] AC-T5-3 | 7c：命中标记落 last_hit_run/last_hit_at 专用列，不改 raw_json |
| [ ] AC-T5-4 | 同批 run/export（同运行标识）→ 不误报；跨运行标识再次命中 → 产提醒 |
| [ ] AC-T5-5 | 提醒注入：场景4 命中 → 退款回填文件命中详情；主对账链命中 → 主输出命中明细 |

### 6.6 T6 前端 AC

| AC 编号 | 验收条件 |
|---------|---------|
| [ ] AC-T6-1 | 导入完成框 fx/bank-deposit 显示「幂等覆盖 N / 空键拒入 N」（发生才显示） |
| [ ] AC-T6-2 | 删除弹框「目标表」下拉（三表）+ 标题/成功文案随表切换 |
| [ ] AC-T6-3 | 改 renderer-dialogs.js 后重跑对应 `npm run preview` 对照 |

### 6.7 三表语义 + OPEN-7 + 回归 AC（合并等价性 / 幂等 / parity）

| AC 编号 | 验收条件 |
|---------|---------|
| [ ] AC-X-1 | **合并等价性**：多选 3 个 fx 文件 → 库内容 ≡ 三文件拼接为 1 个大文件导入；BOC 表含全部文件组。⚠️ 断言分两类：① **调拨单号 / 链接ID 必须 byte 等价**（资金语义硬约束）；② **组号允许「同分组聚类等价」而非数值逐一相等**（因 OPEN-5 组号每次重编号 1..N，多文件按文件序 upsert 与拼成 1 大文件按物理行序导入的行序通常一致但非定义保证，断言过严会锁死实现） |
| [ ] AC-X-2 | **幂等重导**：同 fx / bank-deposit 文件重导 → 行数不变；overwriteCount = 行数 |
| [ ] AC-X-3 | 🔴🔴 **gateway parity 零回归**：泛化重构后 gateway upsert 行为字节不变（既有 v3.0.1 单测 + 集成 40 断言全过） |
| [ ] AC-X-4 | mid-allocation 维持整表覆盖 + 不触发 BOC 重算（契约④） |
| [ ] AC-X-5 | `npm run release-check` 全绿（unit + integration + smoke）+ `/check-vars` 通过 |

---

## 七、手动测试清单

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| 多选 3 文件累加（fx） | 一批多选 3 个外汇交割表 | 库空 | 三文件全进库；BOC 表含全部文件组（组号 1..N 连续）；与单大文件导入等价 |
| 多选 3 文件累加（bank-deposit） | 一批多选 3 个银行对账单入金表 | 库空 | 三文件全进库（按 BizId 累加）；ADM/BOC bank 派生基于全库重建 |
| 同文件重导（fx） | 同一 fx 文件导两次 | 已导一次 | 行数不变；导入完成框「幂等覆盖 = 行数」；BOC 组号重编号一致 |
| 同文件重导（bank-deposit） | 同一 bank-deposit 文件导两次 | 已导一次 | 行数不变；overwriteCount = 行数 |
| 删日期段联动（fx） | 删某 transaction_date 段 | 已导多期 fx | BOC 表联动缩减 + 重匹配后调拨单号正确 + 组号重编号 |
| 删日期段联动（bank-deposit） | 删某 bill_date 段 | 已导多期 | ADM/BOC bank 重建 + processingResult/reconIdFixResult 清空 + 命中标记清理 |
| export 后再 run 提醒 | 跨期残留入金表行作 JPM-US 桥接命中 → export → 次月再 run | 已 export 一次 | 退款回填文件命中详情含「⚠️ 此前已被命中，疑似历史残留」 |
| 65 万行 migration 启动 | 含 65.7 万行存量 bank-deposit 的库首次升级启动 | v3.0.4 库 | 启动成功（全 SQL 侧）；记录耗时；biz_id 回填 + UNIQUE 建成 |
| 空键拒入（fx 合计行） | 含合计/页脚行（交易编号列为非数字文本"生成日期:..."）的 fx 文件 | — | 合计行交易编号归一为空 → 拒入并计数；导入完成框「空键拒入 N」 |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| fx + bank-deposit + mid 混选 | 一批多选三类文件 | — | 派生链最终态正确（fx→BOC 全量重算，bank-deposit→ADM/BOC bank，mid 整表覆盖不触发 BOC） |
| 同批 run/export 不误报 | 同一批数据反复 run/export | — | 命中标记运行标识相同 → 无「跨期重复命中」误报 |
| 删 BizId 后标记清理 | 删除含已标记命中的 bank-deposit 行 | 已 export 标记过 | 命中标记中指向被删 BizId 的项同步清理，无悬挂 |
| gateway parity | 网关多选 + 重导 + 删日期 | — | 行为与 v3.0.1 完全一致（泛化重构零回归） |
| BOC 组号跨次变化可见 | 两次 fx 导入间改中台数据 | — | 历史组调拨单号刷新；组号重编号（活动日志组号变，符合 OPEN-5） |

### 7.3 不测项与原因

- **65 万行级 migration 启动耗时**仅手测（无 CI 大数据集）—— 真实体量数据集不入库，自动化无法覆盖。
- **多文件并发导入**不测 —— UI 串行触发（`for` 循环 `src/main.js:11384`），无并发入口。
- **BOC 修复引擎自身逻辑**不新增案 —— `boc-dispatch-order-fix.js` 逻辑零改动，靠既有 25 案锁定。
- **fx 交易编号跨期全局唯一性**仅单文件单日（20260513）证实 —— migration 去重保留 MAX(id) 作兜底；跨文件真撞键靠 UNIQUE 前去重日志可见（R-7）。

---

## 八、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更 | `linked_bank_deposit` +`biz_id`(UNIQUE) +`last_hit_run` +`last_hit_at`；`linked_fx_settlement` `transaction_no` 普通索引→UNIQUE；`linked_boc_fx_settlement` +`orig_group_no` + 交易编号 UNIQUE；清空两张 BOC 派生表 |
| 落库语义变更 | fx / bank-deposit：整表覆盖 → 跨次幂等累加（🔴🔴 资金对账数据源语义变更，旧心智「重导=清空」失效，UI 须明确告知） |
| 状态流转变更 | BOC 派生组号每次 fx 导入重编号 1..N（OPEN-5）；export 成功后回写命中标记（新增 export→链接表写路径） |
| 权限 / 安全 | 不涉及鉴权；处理资金对账数据（交割 / 银行入金 / 调拨），属敏感资金数据 |
| 回滚策略 | migration 幂等可重入但**数据删除不可逆**（空键 / 去重旧行 / 清空 BOC 表）；无快速回滚，须实施前真实数据验证 |

> 🔴🔴 **资金红线高亮汇总**（实现 + 评审逐条复核）：
> 1. **累加写错 = 资金对账源错**：幂等键选错 / 空键判定错 / meta 重算错 → 漏行、多行、覆盖合法行，直接污染对账匹配。bank-deposit 用 `BizId`（非 ReconciliationId）、fx 用交易编号（交易编号归一为空拒入；fx 主表无调拨单号列）是硬约束。
> 2. **migration 触碰 65.7 万行存量**：必须全 SQL 侧（不 JS 全表读）；单事务幂等可重入；删除不可逆须记日志 + 同步 meta；启动耗时须实测。
> 3. **BOC 派生组号每次 fx 导入全量重编号**：跨次组号会变（OPEN-5 已接受），须纳入 CHANGELOG 契约变更说明。
> 4. **export 新增回写链接表写路径**（OPEN-7 7a）：export 现在会 mutate `linked_bank_deposit`（命中标记）；标记写入失败不得影响导出产物落地；与删除联动清理防悬挂。
> 5. **gateway parity 必须字节不变**：泛化重构不得改网关任何行为，parity 锁定。

---

## 九、已确认决议（spec OPEN-1~7 全列✅，2026-06-15）

| # | 问题 | 状态 |
|---|------|------|
| OPEN-1 | bank-deposit 幂等键 | ✅ **`BizId`**（`BANK_DEPOSIT_FIELDS[0]`，存量 raw_json 可回填；待数据复核行级唯一 R-1） |
| OPEN-2 | fx 幂等键口径 + 合计行去留 | ✅ **交易编号单键**：`normalizeTransactionNo(交易编号)`（实测 24 行全唯一、9 位数字）；合计/页脚=末行交易编号列为非数字文本 → **交易编号归一为空拒入** + 计数（fx 主表无调拨单号列，空键判据用幂等键本身为空）；migration 去重保留 MAX(id) 兜底 |
| OPEN-3 | BOC 派生表存量 | ✅ migration 清空 `linked_boc_fx_settlement` + `linked_boc_bank_deposit` + 引导重导交割表（原始组号不可恢复） |
| OPEN-4 | 删除扩展 | ✅ 删除弹框加「目标表」下拉（三表）+ IPC 加 `tableKey` 参数；fx 删除按 transaction_no 联动删 BOC 行 |
| OPEN-5 | BOC 重匹配 | ✅ 接受「任意 fx 导入全量重算所有组（含历史组）调拨单号」+ 组号每次重编号 1..N |
| OPEN-6 | 版本 | ✅ **v3.0.5**（与 size-startup-optimization 剩余 Phase + refund-backfill-rules-v2 同版本；原拟 3.0.7 作废） |
| OPEN-7 | 跨期残留行提醒 | ✅ 维持全表读取 + 跨期重复命中提醒机制：<br>**7a** = **export 成功后**写命中标记（run 不写）；<br>**7b** = **所有以入金表为来源的命中**（现有 matchJpmUs 桥接 + refund-backfill-rules-v2 新增 R3/R5/R6 二跳，后者 hook 随 refund 接入）；<br>**7c** = **`linked_bank_deposit` 专用列 `last_hit_run`/`last_hit_at`**（不动 65.7 万行 raw_json） |

---

## 十、跨 change 协调（refund-backfill-rules-v2）

| 协调项 | 内容 |
|------|------|
| 代码顺序 | 🔴 **linked-fx 先实施**（本 change 是 refund-backfill-rules-v2 的硬前置；用户 2026-06-15 拍板，spec §标题行 + §九变更记录） |
| OPEN-7b 命中 hook | refund-backfill-rules-v2 新增 R3（HK CustomerRef 二跳）/ R5（Drawee+DESC DATE）/ R6（附言原单日期金额）的命中点，**由 refund-backfill 落地时一并接入本机制的命中标记 hook**（本期只接现有 matchJpmUs，预留 hook 接口；见 refund spec §2.8 D12） |
| 命中详情字段共改 | 退款回填文件 `匹配命中详情`（`r5-refund-order-backfill.js:96`）字段两个 change 共改——linked-fx 追加「跨期残留提醒」段，refund 追加 R3/R5/R6 命中段，须协调不互相覆盖 |
| 入金表读取口径 | 两 change 都依赖 `readLinkedTableRows('bank-deposit')`（`src/main.js:3646`）全表读；linked-fx 累加后输入变多、refund 新增二跳消费方——读取口径维持全表，二者一致 |

---

## 十一、非功能性要求 + 变更记录

### 11.1 非功能性要求

| 类别 | 要求 |
|------|------|
| 性能 | 🔴🔴 bank-deposit 流式 upsert 须保持内存恒定（65.7 万行/解压 1.72GB，R-6）；migration 全 SQL 侧；BOC 全量重匹配走内存（组内匹配，避免 O(n²) 全表笛卡尔） |
| 鲁棒性 | 空入参（无 fx/无 bank-deposit 行）→ 返回空结果不报错；upsert 中途 throw → 全 ROLLBACK 旧累加数据完好；命中标记写入失败不影响导出产物 |
| 幂等性 | migration 幂等可重入（列存在即跳过 ALTER；去重/删空键二次启动 no-op）；同输入「重置-重匹配-重编号」结果一致 |
| 向下兼容 | 删除 IPC `tableKey` 缺省 gateway-bill；mid-allocation / 网关 / fx-option 行为零回归 |

### 11.2 文档三件套（发版前统一更新，T7）

- `CHANGELOG.md`（含落库语义变更 + BOC 组号契约变更 + export 新增写路径说明）
- `docs/VERSION_FEATURE_HISTORY.md`
- `docs/USER_GUIDE.md`（累加导入心智、删除按日期段管理、跨期重复命中提醒解读）

### 11.3 变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-15 | 初稿定稿：基于 spec `linked-fx-bank-deposit-merge-import`（OPEN-1~7 全闭环）撰写完整 PRD —— fx/bank-deposit 整表覆盖→幂等累加（仿网关 v3.0.1）+ BOC 全量重算重编号 + 删除三表下拉 + OPEN-7 跨期重复命中提醒（7a export 后写标记 / 7b 所有入金表来源命中 / 7c 专用列 last_hit_run/last_hit_at）；目标版本 v3.0.5；与 refund-backfill-rules-v2 跨 change 协调（linked-fx 先）。本版仅 PRD，不实施代码 |
| 2026-06-15（定稿评审修订） | 🔴 **修正 fx 空键判据**：术语表 / §5.2.1 / AC-T2-4 / §九 OPEN-2 由「调拨单号空拒入」改「交易编号归一为空拒入」——fx 主表无「调拨单号」列（`table-signatures.js:141-147`），按调拨单号判会全表拒入；改用幂等键本身（交易编号）为空判，与 gateway/bank-deposit 同口径（已回写 spec §3.2.1）。统一 §2.1.2 migration 段引用 `2837-2868`→`2846-2868`（代码本体）。补 §三 stale 注释提醒（`BANK_DEPOSIT_FIELDS` 13→14） |

---

## 十二、实施记录

> 本节为「实施过程沉淀」（team-lead 要求边实施边回写），记录已落地批次的功能闭环、与原设计的偏差、实施期新增拍板点。**状态：进行中**（截至 2026-06-15，批次 1 / 2a / 2b / T6 / 批次3〔OPEN-7〕/ 批次4 T6a 已完成；**T6b / T6c / 批次5〔删除联动重建 + 前端删除弹框 + 文档三件套 + parity/集成补齐〕进行中/待实施**）。改动均为工作区未提交状态，逐条对照 `git diff` 核对，技术细节见同目录 TechDoc 实施记录。
>
> 测试现状：`npm run test:unit` 全程递增全绿——`2511 → 2519`（T5a）`→ 2542`（T5b-1）`→ 2547`（T5b-2）`→ 2548`（T5c）`→ 2561`（批次4 T6a，`logs/unit-tests/unit-20260615-135509.log` 实测 `2561/2561 PASS`）；smoke 全过。

### 12.1 批次总览（已实施）

| 批次 | 对应 Task | 功能 | 状态 |
|---|---|---|---|
| 批次1 | T1/T2（部分） | bank-deposit 入金表「整表覆盖 → 按 BizId 幂等累加」（migration + 仓储双路 upsert + 导入路由） | ✅ 完成 |
| 批次2a | T1/T2 | fx 主表「整表覆盖 → 按交易编号幂等累加」（migration + 仓储数组 upsert + 导入路由） | ✅ 完成 |
| 批次2b | T1/T3 | BOC 派生表「单文件内存派生 + 整表覆盖 → 增量进组 + DB 全量重匹配 + 重编号」 | ✅ 完成（含 codex 对抗审查 4 修复） |
| 批次（T6 子项） | T6（部分） | 前端导入完成框「覆盖 N / 拒入 N」从 gateway-only 泛化到三表 | ✅ 完成 |
| 批次3 | T5（OPEN-7） | 跨期重复命中提醒机制（专用列 + 命中收集 + export 三步时序 + 提醒注入） | ✅ 完成（含 codex 对抗审查 3 修复） |
| 批次4 | T6（部分，T6a） | 仓储删除三表化（count 泛化 + bank-deposit/fx 按日期删除 + fx 联动删 BOC） | ✅ 完成 |
| **T6b** | T4/T6 | **删除 handler 路由扩 tableKey + 删除后派生联动重建（fx 重匹配重编号 / bank-deposit 重建 ADM·BOC bank + 清缓存 + 清命中标记）抽取** | ⏳ **进行中** |
| **T6c** | T6 | **前端删除弹框「目标表」下拉（三表）+ 标题/成功文案随表切换 + 重跑 preview** | ⏳ **进行中** |
| **批次5** | T7 | **gateway parity 锁 + 集成补齐（合并等价性 / 幂等重导 / 删除联动 / OPEN-7 跨期）+ 文档三件套 + `/check-vars`** | 🔜 待实施 |

### 12.2 批次1：bank-deposit 入金表幂等累加（功能 + 拍板落实）

- **功能闭环**：入金表导入由「整表覆盖（多选 N 文件只剩最后一个 = 静默丢数据 bug）」改为「按 `BizId` 幂等累加」——同 BizId 覆盖为最新值、新 BizId 追加、空 BizId 拒入并计数；落库后 meta（rowCount / 日期范围）全表重算；数组路径与流式路径（65.7 万行内存恒定）双路均改。
- **拍板落实**：幂等键 = `BizId`（OPEN-1），**非** `ReconciliationId`（银行侧同 reconid 多行是合法数据异常，做 UNIQUE 会静默互相覆盖丢行——AC §5.1.1 红线）。
- **与原设计一致**：migration 全 SQL 侧（不 JS 全表读 65 万行）；既有 ADM / BOC bank 派生触发与缓存清理零改动（累加后自动以全库行重建）。
- **资金红线观测口径**：migration 建 UNIQUE 前清洗存量（删空键 + 去重保留 id 最大）写 `appendModuleLog(warning)`；上线后导入完成框 `overwriteCount` 异常大 = 键选错信号（R-1）。

### 12.3 批次2a：fx 主表幂等累加（拍板落实 + 偏差）

- **功能闭环**：fx 主表由整表覆盖改为「按 `normalizeTransactionNo(交易编号)` 幂等累加」（仅数组版，fx 永不流式——BOC 分组需物理行号断档守卫保持）。
- **拍板落实**：① OPEN-2 单键（实测 24 行全唯一）；② 空键拒入口径 = **交易编号归一为空**（合计/页脚行交易编号列为「生成日期:YYYYMMDD」非数字文本，归一返回空）——定稿评审已纠正「调拨单号空」措辞（fx 主表无调拨单号列）。
- **实施期偏差/拍板（写入 backlog B17，TechDoc 详述）**：fx 的幂等键列与展示键列同为 `transaction_no`（`idKeyColumn === keyColumn`），泛化内核 `buildLinkedUpsertContext` 无条件拼列名 → fx 得到 `INSERT (transaction_no, transaction_no, ...)` **重复列名**。实测 node:sqlite 容忍且第 1 个占位符（归一后幂等键）生效 → **当前 fx 幂等正确（2547 单测 + 端到端真过）**，但依赖未文档化实现细节（🔴 资金红线脆弱点）。已沉淀 backlog B17（下次动 `buildLinkedUpsertContext` 时收敛去重），本期不改实现。

### 12.4 批次2b：BOC 派生表全量重算重编号（拍板落实 + codex 4 修复）

- **功能闭环**：BOC 链接表派生从「单文件内存 scan + 整表覆盖（只反映最后一个文件）」改为「**增量进组 + DB 全量重匹配 + 组号重编号 1..N**」——任意一次 fx 导入后 BOC 表反映**全库**交割数据的分组 + 调拨单号 + 链接ID。
- **拍板落实**：① OPEN-3 migration 清空两张 BOC 派生表 + 加 `orig_group_no` + UNIQUE + 引导重导；② OPEN-5 接受「任意 fx 导入全量重算所有组（含历史组）调拨单号 + 组号每次重编号」；③ 文件边界 = 组边界（scan 组号在现有最大 `orig_group_no` 之上 offset 续编）。
- **与原设计一致**：`matchBocToMidAllocation`（2.2/2.3）逻辑字节不变，输入从「本文件行」变「全库行」；2.4/2.5 照旧。
- **🔴 实施期 codex 对抗审查发现并修复 4 个问题**（详见 TechDoc 实施记录，PRD 仅列结论）：
  - **C1（Critical → 确认实现正确，仅补测）**：跨文件分组等价性——确认真实导出文件均含 footer/合计行作组边界，per-file scan + offset 续编与「拼成一个大文件」等价；补「无 footer 裸文件分别 scan → 2 独立组」防回归边界测。
  - **I2（Important）**：`replaceBocFxLink`（保留的旧整表覆盖函数，删除联动会用）与批次2b 新 schema 不兼容 → 升级为 `INSERT OR REPLACE` 9 列含 `orig_group_no` + 空键拒入。
  - **I3（Important）**：BOC migration 三件事若同绑一个 `hasColumn(orig_group_no)` 守卫，半迁移态（已加列但缺 UNIQUE）会跳过补建 → UNIQUE 永不建。改为列添加+清空绑 `hasColumn`、UNIQUE 用独立 `PRAGMA index_list` 守卫自愈。
  - **M4（Minor）**：2.2 清空单行组的「分组」会留组号空洞 → 在 2.2/2.3 后对「分组非空」行再 compact 一次，使展示组号连续 1..N 无空洞（只改展示分组，不碰 `orig_group_no` / 调拨单号 / 匹配逻辑）。

### 12.5 批次（T6 子项）：前端导入完成框提醒泛化

- **功能闭环**：导入完成框「本次幂等覆盖 N / 空键拒入 N」提醒从 **gateway-only** 泛化到**三表**（gateway-bill / bank-deposit / fx-settlement），各自按各自键名（`ReconBillBizId` / `BizId` / `交易编号`）弹独立提醒，发生才显示。
- **与原设计一致**：gateway 文案字节不变（parity）；BOC 派生弹框链零结构改动。

### 12.6 批次3：OPEN-7 跨期重复命中提醒（拍板落实 + codex 3 修复）

- **功能闭环**：累加后历史月份残留入金表行仍参与对账匹配（读取口径不收窄），被对账再次命中时在退款回填文件给出「⚠️ 此前已被命中，疑似历史残留」提醒；命中标记落 `linked_bank_deposit` 专用列 `last_hit_run`/`last_hit_at`（不动 65.7 万行 raw_json）。
- **拍板落实（7a/7b/7c 三子项）**：
  - **7a** 写入时机 = **`bank-statement:export` 成功后**回写（run 可反复执行不写；export = 对该批命中的权威确认）。runId = `bankStatementSession.importedAt`（同批 run/export 稳定，重导刷新 → 跨期判定成立）。
  - **7b** 命中口径 = **以入金表为来源的命中**；本期落地 `matchJpmUs`（R5 场景4 JPM-US 桥接），refund-backfill-rules-v2 的 R3/R5/R6 二跳 hook **随该 change 接入**（本期预留收集字段 + 仓储 + 注入骨架）。
  - **7c** 载体 = 专用列（migration 加列，绝不进 UNIQUE、绝不动 raw_json、upsert ON CONFLICT 不碰这两列 → 重导覆盖同 BizId 时标记保留不被洗）。
- **与原设计一致**：引擎保持纯函数（不读 DB），命中 BizId 经返回值上抛；export 阶段三步严格时序「写盘前读旧 marker 判跨期 + 注入 → 写盘 → 写盘后回写新 marker」。
- **🔴 实施期 codex 对抗审查发现并修复 3 个问题**（详见 TechDoc）：
  - **Critical**：退款文件写失败仍 mark → 用户同批重试时 marker 已=当前 runId，跨期提醒永久丢失。改为「`open7Markable`（判定+注入成功）**且** `refundBackfillReport` 非 null（产物成功落盘）」才推进 runId。
  - **Important**：marker 读取 unguarded + IN 参数上限风险。改为 chunk ≤900 分批 + 局部 try/catch 不阻断 export（marker 失败仅 warning）。
  - **Minor**：注入直接 mutate 缓存行 → append 非幂等（重 export 重复追加同一提醒）。改为导出前对回填行浅拷贝再注入。
- **子项口径**：7a = export 成功后写标记；7b = 以入金表为来源命中（本期 matchJpmUs，R3/R5/R6 待 refund 接入）；7c = 专用列。

### 12.7 批次4：仓储删除三表化（T6a，已完成）

- **功能闭环（仓储层）**：① count 预览泛化 `countLinkedByDateRange(db, tableKey, ...)` + gateway 薄封装委托（parity）+ fx/bank-deposit count 封装；② `deleteBankDepositByDateRange`（删前同事务收集 `deletedBizIds` 供后续清命中标记 / 派生重建）；③ `deleteFxByDateRange`（**单事务**联动删 BOC：按 `transaction_no IN` 被删交易编号、**绝不按 maturity_date/日期** chunk ≤900、返回 `deletedTxnNos`）。
- **拍板落实**：OPEN-4 fx 删除按 transaction_no 联动删 BOC 行；count 与 delete 共用同一 WHERE（`buildDateRangeWhere`，预览=实删）。
- **明确边界（标注「进行中」）**：本批**仅仓储层 + 单测**；删除 handler 路由扩 `tableKey`、删除后「全量重匹配重编号 / 重建 ADM·BOC bank + 清 `processingResult`/`reconIdFixResult` + 清命中标记」的接线在 **T6b（进行中）**；前端删除弹框「目标表」下拉在 **T6c（进行中）**。

### 12.8 实施期新增 backlog（沉淀，本期不改实现）

| 编号 | 内容 | 性质 | 触发实施 |
|---|---|---|---|
| **B17**（P2） | `buildLinkedUpsertContext` 给 fx 拼出重复列名 SQL（`idKeyColumn===keyColumn===transaction_no`）；实测 node:sqlite 容忍且第 1 个值生效 → 当前正确但依赖未文档化行为 | 🔴 资金红线脆弱点 | 下次动 `buildLinkedUpsertContext` / fx upsert 时收敛去重 |
| **B18**（P3） | 导入 fx rematch BOC 链接表后未清 `reconIdFixResult`（BOC 修复结果可能 stale）；OPEN-4 删除 fx 已做对（清 `reconIdFixResult`），导入 fx 既有缺口未修 | 边缘场景缺口 | 下次动导入 fx 派生 / BOC 修复链路时 |

> 两条均已记入 `knowledge/backlog.md`；B18 是既有缺口（非本期引入），OPEN-4 删除 fx 路径已规避。

### 12.9 实测验证记录（OPEN-7 第一期 export）

- 第一期 export 实测：`matchJpmUs` 桥接命中 **47 个入金表行**并正确写 `last_hit_run` 标记；退款回填文件 **65 命中 = 47 入金表桥接**（CustomerRef，OPEN-7 标记）**+ 18 S4 模糊**（BillDate，非入金表来源不标记）——印证 7b「仅以入金表为来源的命中才标记」口径正确（S4 模糊命中不属入金表来源，不写标记）。
