# Spec — 外汇交割表 + 银行对账单表（链接表）「整表覆盖 → 幂等合并累加」

> 状态：**✅ 全部拍板（2026-06-15）**——OPEN-1~7 全闭环。OPEN-2 数据证实交易编号全唯一→单键（§3.2.1）；OPEN-7 子项：**7a=export 成功后写标记 / 7b=所有入金表来源命中（含 R3/R5/R6）/ 7c=专用列 last_hit_run/last_hit_at**。⚠️ 用户拍板本 change **作为 refund-backfill-rules-v2 的硬前置先实施**（代码顺序 linked-fx → refund）。
> 来源分支：`v3.0.4` ｜ 目标版本：**3.0.5**（✅ 2026-06-15 用户改：并入在产 v3.0.5，与 `size-startup-optimization`（剩 Phase 2/3/4）+ `refund-backfill-rules-v2` 同版本发；原拍板 3.0.7 作废）｜ 性质：🔴🔴 **资金红线**。
> 缘起：用户 2026-06-11 指示「（外汇交割表与链接表库银行对账单）两个都改成合并，落 spec」。
> 先例：v3.0.1 网关对账单同款改造（`changes/linked-gateway-bill-batch-idempotent/spec.md`），范式尽量全盘复用。

---

## 〇、需求与已拍板决策

| 项 | 内容 / 决策 |
|---|---|
| 改造对象 | 链接表库 2 张表：**外汇交割表**（`fx-settlement` / `linked_fx_settlement`）、**银行对账单表**（`bank-deposit` / `linked_bank_deposit`） |
| 落库语义 | 整表覆盖 `replaceLinkedTable` → **跨次幂等 upsert 累加**（同键覆盖、新键追加、不再清空全表），仿 gateway-bill v3.0.1 |
| **OPEN-1** bank-deposit 幂等键 | ✅ **`BizId`**（`BANK_DEPOSIT_FIELDS[0]`，存量 raw_json 可回填）。⚠️ 前提待数据复核：BizId 行级唯一（见 R-1） |
| **OPEN-2** fx 幂等键口径 | ✅ **单键（2026-06-15 拍板）**：`20260513即期结售汇交易明细.xls` 实测——24 数据行「交易编号」**全唯一**（9 位纯数字 number 类型）；合计行=末行（交易编号列="生成日期:YYYYMMDD" 非数字、渠道流水号空）→ make-or-break 解除。**键 = `normalizeTransactionNo(交易编号)`（number 须 String 化）+ 空键(交易编号归一为空)拒入计数**；migration 去重保留 id 最大兜底（见 §3.2.1 + §五 OPEN-2）。⚠️ 注：fx 主表无「调拨单号」列（`table-signatures.js:141-147` FX 签名 expectedHeaders 不含此列，调拨单号是 BOC 派生/中台字段），故空键判据用「交易编号归一为空」（=幂等键本身为空，与 gateway/bank-deposit 口径一致；合计行交易编号列为非数字文本→`normalizeTransactionNo` 返回 ''） |
| **OPEN-3** BOC 派生表存量 | ✅ **migration 清空两张 BOC 派生表 + 引导重导交割表**（存量原始组号不可恢复） |
| **OPEN-4** 删除扩展 | ✅ **删除弹框加「目标表」下拉**（三表）+ IPC 加 `tableKey` 参数；fx 删除按 transaction_no 联动删 BOC 行 |
| **OPEN-5** BOC 重匹配 | ✅ **接受「任意 fx 导入全量重算所有组（含历史组）调拨单号」+ 组号每次重编号 1..N** |
| **OPEN-6** 版本 | ✅ **3.0.5**（2026-06-15 改：并入在产 `v3.0.5` 分支，与 size-startup-optimization 剩余 Phase + refund-backfill-rules-v2 同版本；原拍板 3.0.7 作废） |
| **OPEN-7** 跨期残留行 | ✅ 读取口径维持全表 + 跨期重复命中提醒机制（§3.6）。子项已定（2026-06-15）：**7a** 命中标记写入时机=**export 成功后**；**7b** 口径=**所有以入金表为来源的命中**（matchJpmUs + refund 的 R3/R5/R6 二跳，R3/R5/R6 hook 随 refund-backfill 一并接入）；**7c** 载体=**专用列 `last_hit_run`/`last_hit_at`** |
| 前端提醒 | 导入完成框对两表显示「幂等覆盖 N 条 / 空键拒入 N 条」（仿 gateway D3） |

---

## 一、现状与根因（代码事实，带出处）

### 1.1 两表均整表覆盖，多选同类型文件 = 只剩最后一个（与网关 v3.0.1 bug 同根因）

> ⚠️ **本节 `src/main.js` 行号已 stale（待回写 spec）**：以 PRD/TechDoc 现状表的更新行号为准——`linked-table:import` 实为 `src/main.js:11372`（非 11363）、导入分流分支 `:11468-11484`（非 11459-11475，`isGatewayBill` 判断 `:11449`）、fx 强制数组守卫 `:11450-11454`（非 11445）。`linked-table-repository.js` 的 `replaceLinkedTable:277` / DELETE `:290` / `replaceLinkedTableStreaming:318` / DELETE `:332` 行号正确。

- 导入入口 `linked-table:import`（`src/main.js:11363`）多选后逐文件落库；除 gateway-bill 走 upsert 外，**其余表走 `replaceLinkedTable` / `replaceLinkedTableStreaming` 整表覆盖**（`src/main.js:11459-11475`；`linked-table-repository.js:277` 的 `DELETE FROM 表` + INSERT）。
- fx-settlement 被 v3.0.4 块 E 强制走数组路径不流式（`src/main.js:11445`，BOC 分组需要物理行号）；bank-deposit 物理单 sheet `.xlsx` 时走流式覆盖。
- 后果：一批多选 N 个同类型文件 → 前 N-1 个被静默覆盖，但 results 全部 `status:'ok'` → 前端显示「N 个成功」。

### 1.2 网关 v3.0.1 先例已沉淀完整范式（本次直接复用）

| 范式件 | 出处 |
|---|---|
| upsert 内核（ON CONFLICT DO UPDATE + 先 SELECT 判覆盖计数 + 空键拒入） | `buildGatewayUpsertContext`（`linked-table-repository.js:368`） |
| meta 全表重算（COUNT(*) + MIN/MAX 日期，不可用单批增量） | `recomputeGatewayMeta`（`linked-table-repository.js:406`） |
| 数组版 + 流式版双路 upsert（事务跨 await，throw 即 ROLLBACK） | `upsertLinkedGatewayBill` / `upsertLinkedGatewayBillStreaming`（`linked-table-repository.js:458/492`） |
| 按日期范围 count/delete（ISO 格式硬守卫 + 删后 meta 重算） | `countGatewayBillByDateRange` / `deleteGatewayBillByDateRange`（`linked-table-repository.js:423/434`）；IPC `src/main.js:11318/11337` |
| migration：键列回填（TRIM(json_extract)）+ 存量去重 + 删空键 + UNIQUE 索引 | `migrations.js` v3.0.1 段 |
| 前端覆盖提醒（overwriteCount / rejectedEmptyCount 回传导入完成框） | `src/main.js:11485-11488` |

### 1.3 fx-settlement 特殊性（本次复杂度的全部来源）

1. **主表 schema**（`migrations.js:2882`）：`transaction_no`（来自「交易编号」，**普通索引非 UNIQUE**，`migrations.js:2890`）+ `transaction_date` + raw_json。落库键口径 `normalizeKey`＝`String().trim()`（`linked-table-repository.js:227`），**合计/页脚行也整行落库**。
2. **主表无任何 DB 读取消费方**：全仓 grep `readLinkedTableRows('fx-settlement')` 零命中；主表作用 = meta 行数/日期范围展示 + raw_json 留底。**真正的资金链路在派生表 `linked_boc_fx_settlement`**。
3. **BOC 派生依赖文件内物理行号**：`scanFxGroups`（`boc-fx-link-builder.js:88`）按「交易编号非数字 → 关组」「物理行号断档（空行被过滤）→ 关组」切组，组号 1..N 文件内递增。派生在导入时刻基于**内存中的本文件** objects+rowNumbers 进行（`src/main.js:11502-11530`），产物 `replaceBocFxLink` **整表覆盖**（`linked-table-repository.js:747`）→ BOC 链接表只反映最后一个文件。
4. **中台匹配是一对一消耗语义**：`matchBocToMidAllocation`（`boc-fx-link-builder.js:143`）把全部中台 BOC 候选与全部组做 2.2 单行剔除 + 2.3 组汇总匹配，候选 `consumed` 状态仅存在于单次运行内存中。**2.2 命中行会把「分组」清空**（`boc-fx-link-builder.js:191`）→ 落库后的 `group_no` 是匹配后状态，**原始组号不可从现库恢复**。
5. **派生表已有热列**（`migrations.js:2959`）：`transaction_no / group_no / allocation_no / recon_link_id / maturity_date / source_row`——离「可从 DB 重算」只差「原始组号」一列。
6. **下游消费**：BOC 修复引擎只读 `readBocFxLinkRows()`（`src/main.js:4093`、`scenario-engines/boc-dispatch-order-fix.js`），按「分组」聚合整组匹配；**组号值本身无跨表业务含义，仅作组内一致标识**。
7. **⚠️ make-or-break 未知项（OPEN-2 待数据）**：「交易编号」是否**文件内行级唯一**未经证实。2.3 组汇总按组求和 `货币2金额`（`boc-fx-link-builder.js:211`）暗示一组可含多行，但每行是否各自独立交易编号待证。**若同一文件内多行共享同一交易编号 → 用它作 upsert 幂等键会合并掉合法行 = 静默丢数据**（见 §3.2.1 / R-7）。

### 1.4 bank-deposit 特殊性（消费方天然兼容累加）

1. **schema**（`migrations.js:2899`）：`reconciliation_id`（普通索引）+ `bill_date` + raw_json（14 字段白名单裁列 `BANK_DEPOSIT_FIELDS`，`linked-table-repository.js:35`）。
2. **消费方全部是全表读，逻辑无需改**：
   - R5 场景4 中台退款回填：`readLinkedTableRows('bank-deposit')`（`src/main.js:3641`）→ 作为 `depositRows` 喂引擎；其中 **JPM-US 桥接查找** `matchJpmUs`（`r5-refund-order-backfill.js:183`）按 ReconId/ChannelOrderNo 命中入金表行取 CustomerRef 比对——这是「残留行被命中」的主入口（OPEN-7）。
   - ADM 派生：`readBankDepositAdmCandidates()`（Channel='ADM' 下推，`src/main.js:11603`）→ `replaceAdmBankDeposit` 全量重建；
   - BOC bank 派生：`readBankDepositBocCandidates()`（Channel='BOC' 下推，`src/main.js:11638`）→ `replaceBocBankDeposit` 全量重建 + 2.5 全量回填。
   - 累加后这些派生**自动以「全库行」为输入重建**，语义正确，仅输入变多。
3. **幂等键 = `BizId`（OPEN-1 已定）**：`BANK_DEPOSIT_FIELDS[0]`，自 13 字段时代就在白名单 → 存量可回填；与网关 `ReconBillBizId` 同族。⚠️ `ReconciliationId` 不可用（R1/R5 引擎注释证实银行侧同 reconid 多行 = 数据异常，做 UNIQUE 会静默互相覆盖）。
4. **体量**：实测 65.7 万行（`linked-table-repository.js:545` 注释）→ migration 必须 SQL 侧完成（gateway 先例口径），不可 JS 全表读。

### 1.5 「按日期范围删除」现状仅网关

- IPC `linked-table:count-by-date-range` / `delete-by-date-range` **硬编码网关函数**（`src/main.js:11329/11348`）；
- 前端弹框标题写死「删除网关对账单数据」（`renderer-dialogs.js:6526`），无表选择。

### 1.6 存量数据状态

| 表 | 存量 | migration 难点 |
|---|---|---|
| `linked_fx_settlement` | v2.1.16 起存在；单文件覆盖产物，含合计/非数字行；体量小 | 键归一口径取决于 OPEN-2；体量小可 JS 层全表重算 |
| `linked_bank_deposit` | 65.7 万行级 | 必须 SQL 侧：`TRIM(json_extract(raw_json,'$.BizId'))` 回填 + 删空键 + 去重（保留 id 最大）+ UNIQUE 索引（gateway 先例同款） |
| `linked_boc_fx_settlement` / `linked_boc_bank_deposit` | v3.0.4（2026-06-11 发布）新表，存量极少 | OPEN-3：migration 直接清空两张表，引导重导交割表恢复 |

---

## 二、目标语义（改造后）

1. **fx-settlement / bank-deposit 落库 = 跨次幂等累加**：不再 `DELETE FROM` 全表；同幂等键覆盖为最新值、新键追加、空键拒入并计数；meta 全表重算；`source_file_name` = 最后一次导入文件名（gateway 同款）。
2. **一批多选 N 个同类型文件**：逐文件 upsert，最终库内容 ≡ 把 N 个文件拼成 1 个大文件导入（同键后者覆盖前者，按文件顺序）。⚠️ **主表层面**（gateway/bank-deposit/fx）此等价无条件成立（按幂等键 upsert，与「组」无关）；**BOC 派生层**的组聚类等价以「各文件含 footer/合计行作组分隔」为前提（文件边界=组边界，用户 2026-06-15 拍板，详见 §3.2.2 文件边界段）。
3. **BOC 派生链在合并语义下正确**：任意一次 fx 导入后，BOC 链接表反映**全库**交割数据的分组 + 调拨单号 + 链接ID；bank-deposit 导入后 ADM / BOC bank 派生基于全库候选重建。
4. **删除按日期范围**支持三张表，删除后联动重建相应派生表并清相关缓存。
5. **导入完成框**对两表显示幂等覆盖 / 空键拒入计数（发生才显示）。
6. **跨期重复命中提醒**（OPEN-7）：累加表残留行被对账再次命中时，输出端给出可见提醒（§3.6）。

---

## 三、设计方案

### 3.1 bank-deposit 合并（全仿 gateway 先例）

- **migration**（仿 v3.0.1）：`linked_bank_deposit` 加 `biz_id` 列 → SQL 回填 `TRIM(json_extract(raw_json,'$.BizId'))` → 删空键行 → 同键去重保留 `id` 最大 → 建 UNIQUE 索引。幂等可重入。
- **仓储**：`buildGatewayUpsertContext` / `recomputeGatewayMeta` 泛化为参数化内核（表 def + 幂等键列 + 键取值函数），gateway / bank-deposit / fx 共用，**禁止复制粘贴第二份**（防口径漂移）；产出 `upsertLinkedBankDeposit`（数组版）+ `upsertLinkedBankDepositStreaming`（流式版，保持 65 万行内存恒定约束）。裁列 `pickBankDepositFields` 在 upsert 前不变。
- **main.js**：bank-deposit 分支由 `replaceLinkedTable(Streaming)` 换 upsert 双路；`okResult` 回传 `overwriteCount / rejectedEmptyCount`；**既有派生触发与缓存清理零改动**（ADM `main.js:11597`、BOC bank `main.js:11636`、`processingResult/reconIdFixResult` 清空）。

### 3.2 fx-settlement 合并（核心难点：BOC 派生改「DB 全量重算」）

#### 3.2.1 主表 `linked_fx_settlement`（键口径 = OPEN-2，待数据）

- 候选键 = 「交易编号」，候选归一口径 `normalizeTransactionNo`（`boc-fx-link-builder.js:32`，与 BOC 派生同口径）。
- **🟡 阻塞点已解除（2026-06-15 真实数据）**：`20260513即期结售汇交易明细.xls` 实测 24 数据行交易编号**全唯一**（distinct 24/24），9 位纯数字（number 类型，需 `normalizeCellValue` String 化，无科学计数风险）；调拨单号为组键（4 组 12/7/2/3 行，一组多行共享，**不可作行键**）。
  - **结论（✅ 2026-06-15 用户拍板单键）** → 用 `normalizeTransactionNo(交易编号)` 作幂等键；合计/页脚行=末行（交易编号列="生成日期:20260513" 为非数字文本、渠道流水号空）→ 以**交易编号归一为空**判定空键拒入 + 计数（=幂等键本身为空，与 gateway/bank-deposit 先例同口径）。⚠️ **fx 主表无「调拨单号」列**（`table-signatures.js:141-147` FX 签名 expectedHeaders 不含此列；调拨单号是 BOC 派生表/中台字段，`boc-fx-link-builder.js` 派生时才赋值）→ 不可按「调拨单号空」判 fx 行空键（对 fx 原始行恒空会全表拒入）；合计行交易编号列为 "生成日期:..." 文本，`normalizeTransactionNo` 对其返回 ''（含非数字字符）→ 自然落入空键拒入。
  - ⚠️ **残留风险**：仅单文件单日（20260513）证实；交易编号系单笔交易 ID（设计上唯一），但跨文件/跨期全唯一仅此一例佐证，实施期 migration 去重保留 id 最大作兜底（同键真撞则保留最新，不丢行靠 UNIQUE 前的去重日志可见）。
- migration：体量小 → JS 层全表读 → 按定稿键重算键列 → 删空键 → 去重保留 id 最大 → 建 UNIQUE 索引（单事务，幂等可重入）。
- upsert 仅数组版（fx 永不走流式，`main.js:11445` 守卫保持）。

#### 3.2.2 BOC 链接表 `linked_boc_fx_settlement`：「单文件内存派生 + 整表覆盖」→「增量进组 + DB 全量重匹配 + 重编号」

**新增列 `orig_group_no`（原始组号）**：scan 时刻的组归属，**永不被 2.2/2.3 改写**；现有 `group_no` 退化为「匹配后展示分组」。这是全量重匹配的前提（§1.3-4）。

**🔴 文件边界 = 组边界（用户 2026-06-15 拍板，codex review C1）**：BOC 派生采用「**per-file scan + offset 续编**」——每个导入文件独立 `scanFxGroups`，组号在现有最大 `orig_group_no` 之上续编。语义是「**一笔 BOC 调拨不跨导出文件**」（文件边界即组边界）。
- 前提：真实导出文件均含 footer/合计行（交易编号列为「生成日期:YYYYMMDD」非数字文本）作组分隔，故文件内末组与下一文件首组天然分隔；即便某文件为「无 footer 裸文件」，offset 续编也保证跨文件不会坍缩成一组（per-file scan 起点组号从 offset+1 起）。
- 「合并等价性」（§二-2 / §七测试）口径据此限定：**多选 N 文件导入 ≡ 把 N 个各含 footer 的文件拼成一个大文件导入**（大文件内 footer 行天然分隔成 N 段，与 per-file scan 等价）；BOC 调拨单号 / 链接ID byte 等价、组聚类等价。**裸文件（无 footer）拼接**与「分别导入」的差异由 per-file offset 续编兜住（分别导入恒为独立组；拼接成无分隔大文件则会被 scan 当作一组——但真实导出文件不存在此形态）。

**每次 fx 导入的派生流程：**

1. 对**本文件** `scanFxGroups`（物理行号分组逻辑零改动）；组号续编：`offset = SELECT MAX(CAST(orig_group_no AS INTEGER))`，本文件组号 += offset（全局不冲突，文件边界=组边界）。
2. scan 产物按主表幂等键（OPEN-2 同口径）**upsert 进 BOC 表**（新增 UNIQUE 索引）：同键覆盖（迁移到新组，id 不变 → 行序稳定），新键追加。
3. **全量重匹配 + 重编号**（OPEN-5）：读全库 BOC 行（`ORDER BY id ASC` 作行序优先口径）→ 按 `orig_group_no` 聚合后**按行序全局重编号**（消除 orig_group_no 空洞）→ 重置 `分组 = 重编号后组号`、`调拨单号 = ''` → 重跑 `matchBocToMidAllocation`（2.2+2.3 逻辑零改动，输入从「本文件行」变「全库行」）→ **2.2 之后对剩余「分组非空」行再 compact 一次（codex review M4）使展示组号连续 1..N 无空洞**（2.2 清空单行组会留洞）→ 整批写回。compact 只改展示「分组」，不碰 `orig_group_no` / 调拨单号 / matchBocToMidAllocation 逻辑。
4. 2.4（`buildBocBankRows` + `replaceBocBankDeposit`）与 2.5（`backfillBocReconLinkIds` 全量回填）**照旧**。

**🔴 语义变化（OPEN-5 已接受）**：mid-allocation 导入仍**不**触发重匹配（维持 v3.0.4 契约④）；但**任意一次 fx 导入会全量重算所有组（含历史组）的调拨单号**——中台数据在两次 fx 导入间变过则历史组调拨单号随之刷新。组号每次重编号，跨次活动日志组号会变。

#### 3.2.3 BOC 派生表 migration（OPEN-3 已定）

migration 内**清空 `linked_boc_fx_settlement` + `linked_boc_bank_deposit`**；首次启动后引导用户重导一次外汇交割表全量恢复。升级说明 + 弹框引导（沿用 needBankImport 弹框链文案）。

### 3.3 删除按日期范围扩展（OPEN-4 已定）

- IPC `count-by-date-range` / `delete-by-date-range` 加 `tableKey` 参数（缺省 `gateway-bill` 向后兼容）；白名单 = 三张表，逐表走各自 dateColumn（gateway=bill_date、fx=transaction_date、bank-deposit=bill_date）。
- 前端删除弹框加「目标表」下拉（默认网关；标题随选择切换），其余交互不变。
- **删除后的派生联动（🔴 必须）**：
  - 删 fx 行 → 按被删行的 `transaction_no` 集合**联动删 BOC 表同键行**（⚠️ 不能按日期删 BOC 表：其日期列是到期日 `maturity_date`）→ 全量重匹配 + 重编号（复用 3.2.2 第 3/4 步）。
  - 删 bank-deposit 行 → 重建 ADM + BOC bank 派生 + 2.5 全量回填 → 清 `processingResult` + `reconIdFixResult` + **同步清 OPEN-7 命中标记中指向被删 BizId 的项**。
  - 删 gateway-bill 行为不变。

### 3.4 前端提醒

- 导入完成框 per-file 明细：两表新增「本次幂等覆盖 N 条」「空键拒入 N 条」（发生才显示，文案同 gateway D3）。
- BOC 派生弹框链（`renderer-dialogs.js:6362-6507`）**零结构改动**。
- 删除弹框成功文案随 tableKey 显示表名。

### 3.6 跨期重复命中提醒机制（OPEN-7 已定方向，子项 7a/7b/7c 待确认）

> 目标：累加后历史月份残留行仍参与对账匹配（读取口径不收窄）；不硬排除，而是**标记 + 再次命中时提醒**，让用户看见「这条是上一期已命中过的残留行，疑似漏删」。

**机制骨架（推荐实现）：**

1. **新增持久字段**（落 `linked_bank_deposit` 专用列，避免改 65 万行 raw_json）：`last_hit_run`（TEXT，上次命中所属对账运行标识）+ `last_hit_at`（命中时间）。键 = BizId（OPEN-1 幂等键）。
2. **命中口径**：bank-deposit 行被某次对账**成功使用**即记一次命中——
   - R5 场景4：作为 JPM-US 桥接（`matchJpmUs`）促成一条成功回填的入金表行；
   - 主对账链：若后续确认还有别的场景以入金表行为命中来源，同口径纳入（7b 待确认范围）。
3. **运行标识防同批误报**：标识取「当期银行对账单导入会话 id / 时间戳」（每次 run 用同一新导入会话即同一 id）。命中时若该行 `last_hit_run` 非空 **且 ≠ 当前运行标识** → 判定「跨期重复命中」→ 写提醒；随后更新该行 `last_hit_run = 当前标识`。**同批重复 run/export 标识相同 → 不误报**。
4. **写入时机**：在 **`bank-statement:export` 成功后**回写命中标记（export = 用户对该批命中的权威确认；run 可反复执行）。⚠️ 这是 export → 链接表的**新增写路径**（🔴 export 现在会改 bank-deposit 表）。
5. **提醒出口**（对应用户原话）：
   - 命中来自 R5 场景4 → **中台退款回填文件**对应回填行的 `匹配命中详情`（`r5-refund-order-backfill.js:96`）追加「⚠️ 桥接入金表行 BizId=… 此前于 [last_hit_at] 已被命中，疑似历史残留」。
   - 命中来自主对账链 → **主输出「命中明细」**（`exceljs-writer.js:243`）对应行追加同款提醒。

**子项已定（2026-06-15）**：**7a** 写入时机=**export 成功后**（run 可反复执行不写；export=对该批命中的权威确认）；**7b** 命中口径=**所有以入金表为来源的命中**——含现有 matchJpmUs(R5场景4 桥接) + refund-backfill-rules-v2 新增的 R3(HK CustomerRef二跳)/R5(Drawee+DESC DATE)/R6(附言原单日期金额) 二跳；⚠️ R3/R5/R6 的命中点由 refund-backfill 落地时一并接入本提醒机制（跨 spec 契约，见 refund spec §2.8 D12）；**7c** 字段载体=**`linked_bank_deposit` 专用列 `last_hit_run`/`last_hit_at`**（不动 65.7 万行 raw_json）。

### 3.5 明确不做（本期范围外）

1. mid-allocation（中台调拨订单表）不改合并——维持整表覆盖与 U4「mid 导入不触发 BOC 重算」契约。
2. 网关对账单逻辑零改动（仅内核泛化重构，行为字节不变，parity 锁定）。
3. 对账引擎匹配**读取口径维持全表**——不引入硬性消费排除 / 日期窗（用 §3.6 软提醒 + §3.3 删除管理范围替代）。
4. fx-option（外汇期权表）仍不落库。

---

## 四、风险（🔴 需人工复核）

| # | 风险 | 说明与缓解 |
|---|---|---|
| R-1 | **bank-deposit BizId 若非行级唯一 = 静默丢数据**（资金红线） | OPEN-1 选 BizId 的前提是行级唯一。上线后导入完成框覆盖计数是观测口径（异常大 = 键选错信号）；建议实施前用真实银行对账单抽样核 BizId 重复率。 |
| R-2 | **BOC 调拨单号全量重算语义变化**（资金红线，OPEN-5 已接受） | 任意 fx 导入刷新历史组调拨单号；组号每次重编号。已纳入 CHANGELOG 契约变更说明。 |
| R-3 | **fx 合计行去留取决于 OPEN-2** | 合计行交易编号列为非数字文本 → 归一为空 → 拒入；主表不再留底（现状留底）；已核实主表无 DB 消费方，影响仅 meta 行数与 raw_json 留底完整性。 |
| R-4 | **累加后跨期数据进入对账引擎** | 缓解三重：§3.6 跨期重复命中提醒（可见性）+ §3.3 删除按日期范围（可清理）+ 用户操作规范。读取口径不收窄（§3.5-3）。 |
| R-5 | **删除不可逆扩展到两张表 + 派生联动**（资金红线） | 复用 gateway 防误删门控（ISO 硬守卫 + count 成功才允许删）；派生联动重建必须与删除在一致事务边界完成，禁止「删了主表、派生表 stale」中间态。 |
| R-6 | **migration 触碰 65 万行存量表** | bank-deposit migration 全 SQL 侧，单事务 + 幂等可重入；启动耗时需实测。 |
| R-7 | **fx 交易编号唯一性未证实**（资金红线，阻塞 OPEN-2） | §1.3-7：若文件内多行共享交易编号，用作幂等键会合并合法行。**实施前必须用真实数据证实唯一性**，否则改复合键。 |
| R-8 | **OPEN-7：export 新增回写链接表的写路径**（资金红线） | export 现在会 mutate `linked_bank_deposit`（命中标记）；须保证标记写入失败不影响导出产物落地（标记是观测增强，非资金数据），且与删除（§3.3）联动清理被删 BizId 的标记防悬挂。 |

---

## 五、OPEN 拍板项

| # | 问题 | 状态 |
|---|---|---|
| OPEN-1 | bank-deposit 幂等键 | ✅ `BizId`（待数据复核行级唯一，R-1） |
| OPEN-2 | fx 幂等键口径 + 合计行去留 | ✅ **单键（2026-06-15 拍板）**：① 交易编号 = 9 位纯数字（number 类型）；② 合计/页脚=末行，交易编号列="生成日期:YYYYMMDD"（非数字）、渠道流水号空；③ 24 行**全唯一**（make-or-break 解除）。→ **键 = `normalizeTransactionNo(交易编号)` + 交易编号归一为空拒入**（fx 主表无调拨单号列，空键判据用幂等键本身为空，与 gateway/bank-deposit 同口径）。 |
| OPEN-3 | BOC 派生表存量 | ✅ migration 清空 + 引导重导 |
| OPEN-4 | 删除扩展 | ✅ 弹框加目标表下拉 + IPC 加 tableKey + fx 联动删 BOC |
| OPEN-5 | BOC 全量重匹配 + 组号 | ✅ 接受全量重算 + 每次重编号 1..N |
| OPEN-6 | 版本/分支 | ✅ 3.0.5（2026-06-15 改：并入在产 v3.0.5；原 3.0.7 作废） |
| OPEN-7 | 跨期残留行处理 | ✅ 维持全表 + 重复命中提醒机制（§3.6）。子项已定（2026-06-15）：<br>**7a** = **export 成功后**写标记；<br>**7b** = **所有以入金表为来源的命中**（matchJpmUs + refund R3/R5/R6；后者随 refund-backfill 接入）；<br>**7c** = **专用列 `last_hit_run`/`last_hit_at`**。 |

---

## 六、任务拆分（小批次，一 task 一 commit）

| Task | 内容 | 主要文件（≤5/task） |
|---|---|---|
| T1 | migration：两主表键列归一回填 + 去重 + 删空键 + UNIQUE；bank-deposit 加 `last_hit_run/last_hit_at`；BOC 表加 `orig_group_no` + 键 UNIQUE + 清空两张派生表 | `migrations.js` |
| T2 | 仓储：upsert 内核泛化（gateway/bank-deposit/fx 共用）+ meta 全表重算泛化 + bank-deposit 双路 upsert + fx 数组 upsert + 删除 count/delete 参数化 | `linked-table-repository.js`、`database.js` |
| T3 | 仓储 + builder：BOC 表 upsert（orig_group_no）+「重置-重匹配-重编号」读写函数 + rematch 编排纯函数 | `linked-table-repository.js`、`boc-fx-link-builder.js` |
| T4 | main.js：导入 handler 两表换 upsert + fx 派生改全量重算 + 删除 handler 扩 tableKey + 删除派生联动与缓存清理 | `src/main.js`、`src/preload.js` |
| T5 | OPEN-7 机制：命中标记读写仓储 + export 回写 + 场景4/主输出提醒注入 | `linked-table-repository.js`、`src/main.js`、`r5-refund-order-backfill.js`、`exceljs-writer.js` |
| T6 | 前端：导入完成框两表覆盖/拒入提醒 + 删除弹框表选择与文案 | `renderer-dialogs.js` |
| T7 | 测试 + 文档：单测/集成补齐（§七）+ parity 锁 gateway 零变化 + CHANGELOG 等三件套 + `/check-vars` | `tests/`、`scripts/integration/`、docs |

---

## 七、测试计划

**单测（`tests/unit/`）**：
- 仓储：bank-deposit / fx upsert 数组版（同键覆盖、新键追加、空键拒入计数、meta 全表重算）；bank-deposit 流式版事务 ROLLBACK；删除参数化三表 + 联动删 BOC 行；migration 幂等可重入（含存量去重保留 id 最大、BOC 表清空、新列回填）。
- builder：组号偏移续编 + 重编号；「重置-重匹配」幂等（同输入两次结果一致）；跨文件组与中台候选一对一消耗（同日同金额不重复回填）；2.2 剔除后 `orig_group_no` 不变。
- OPEN-7：同批 run/export 不误报；跨运行标识再次命中产提醒；删 BizId 后标记清理无悬挂。
- gateway parity：泛化重构后 gateway upsert 行为字节不变（既有 v3.0.1 单测全过）。

**集成（`scripts/integration/`）**：
- 一批多选 3 个 fx 文件（各含 footer/合计行）→ 库内容 ≡ 三文件拼接（拼接大文件内 footer 行天然分隔成 3 段）；BOC 表含全部文件组；调拨单号 / 链接ID 与「单大文件导入」结果 byte 等价、组聚类等价（合并等价性断言）。⚠️ 文件边界=组边界（用户 2026-06-15 拍板，§3.2.2）：另需 1 案验证「两个无 footer 裸文件分别 scan(offset 续编) → 2 个独立 orig_group」防回归；2.2 清空单行组后剩余展示组号 compact 连续 1..N（M4）。
- fx + bank-deposit + mid 混选导入 → 派生链最终态正确。
- 同文件重复导入 → 行数不变（幂等）、overwriteCount = 行数。
- 删 fx 日期段 → BOC 表联动缩减 + 重匹配后调拨单号正确；删 bank-deposit 日期段 → ADM/BOC bank 重建 + processingResult 清空。
- OPEN-7：跨期残留入金表行作 JPM-US 桥接 → 退款回填文件命中详情含提醒。

**覆盖范围说明**：BOC 修复引擎（boc-dispatch-order-fix）自身逻辑零改动，仅靠既有 25 案锁定；mid 导入不触发重算（契约④）维持，不新增案。
**未覆盖与原因**：65 万行级 migration 启动耗时仅手测（无 CI 大数据集）；多文件并发导入（UI 串行触发，无并发入口）。

---

## 八、变更记录

- 2026-06-11：初稿（草案待拍板，OPEN-1~7 全开）。
- 2026-06-15：用户拍板 OPEN-1（BizId）/3（清空重导）/4（目标表下拉）/5（全量重算+重编号）/6（3.0.7）；OPEN-2 改为待真实数据定（新增 R-7 交易编号唯一性阻塞点）；OPEN-7 由「维持全表」升级为「维持全表 + 跨期重复命中提醒机制」（新增 §3.6 + R-8 + T5），子项 7a/7b/7c 待确认。
- 2026-06-15（晚）：① **OPEN-6 版本改 3.0.7 → 3.0.5**（用户拍板：与 size-startup-optimization 剩余 Phase + refund-backfill-rules-v2 统一并入在产 v3.0.5）；② **OPEN-2 数据已到**（`20260513即期结售汇交易明细.xls`）——交易编号 24 行全唯一、9 位数字、合计行=末行调拨单号空，make-or-break 解除，建议单键待确认；③ 新增下游联动 spec `refund-backfill-rules-v2`（其 R2/R3/R5/R6 新增「入金表为命中来源」入口，OPEN-7b 命中口径需相应扩展，见该 spec §2.8 / D12）。
- 2026-06-15（夜）：✅ **OPEN-2 + OPEN-7a/7b/7c 全部拍板，本 change 全闭环可实施**——OPEN-2=交易编号单键；7a=export 成功后写标记；7b=所有入金表来源命中（含 refund R3/R5/R6，其 hook 随 refund-backfill 接入）；7c=专用列 last_hit_run/last_hit_at。用户拍板**本 change 作为 refund-backfill-rules-v2 硬前置先实施**（代码顺序 linked-fx → refund）。状态 拍板中 → 全部拍板。
- 2026-06-15（定稿评审）：🔴 **修正 OPEN-2 空键判据措辞**——原稿写「调拨单号空拒入」，但代码实证 fx 主表无「调拨单号」列（`table-signatures.js:141-147` FX 签名不含此列，调拨单号是 BOC 派生/中台字段）→ 按调拨单号判 fx 行空键会全表拒入。改为「**交易编号归一为空**拒入」（=幂等键本身为空，与 gateway/bank-deposit 同口径；合计行交易编号列为非数字文本 → `normalizeTransactionNo` 返回 '' → 自然拒入）。结论等价（合计行两者皆空），仅判据列从不存在的调拨单号改为存在且为幂等键本身的交易编号。同步 §0/§3.2.1/§五 OPEN-2/R-3。
