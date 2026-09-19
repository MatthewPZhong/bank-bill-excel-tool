# Spec — 网关对账单链接表「批量导入 + 幂等累加 + 按日期删除」

> 状态：**已实施（v3.0.1，已发版）** ｜ 来源分支：`v3.0.0` ｜ 目标版本：**3.0.1**（先发 3.0.0，再开 3.0.1 做本需求）
> ✅ 回写 2026-06-15：原「需求定稿，待实施」状态行已 stale。实证落地 `linked-table-repository.js:458 upsertLinkedGatewayBill` + `migrations.js:2846`（schema 迁移）+ `main.js:11346 linked-table:delete-by-date-range` + CHANGELOG v3.0.1（集成 v3.0.1-linked-gateway-upsert 40 断言）。
> 性质：🔴 **资金红线** —— 链接表落库语义从「整表覆盖」改为「跨次幂等累加」，并放开 `reconciliationid` 唯一性。⚠️ 对账「消费标记」方案 2026-06-09 **已整体移除**（见 §九 变更记录）；对账读取口径**维持现状全表**，由此 reconid 跨期复用漏匹配风险 re-opened（见 §四 R-1）。
> 缘起：用户 2026-06-09 反馈「资金对账数据处理模块 → 链接表 → 网关对账单表库，同时导入 3 个同类型文件时只剩最后 1 个（前 2 个被静默覆盖）」，要求支持同类型批量导入。

---

## 〇、需求（用户 2026-06-09 拍板）

| 项 | 用户决策 |
|---|---|
| **累加范围** | 选项 2：**跨多次导入持续累加**（不再每次清空全表） |
| **落库语义** | 改为**幂等 upsert**：按字段判重，命中已存在则覆盖，未命中则追加 |
| **幂等键** | **`ReconBillBizId`**（不是 `reconciliationid`） |
| **`reconciliationid`** | **允许重复**（放开唯一性约束） |
| **导入完成提醒** | 本次**发生过**幂等覆盖 → 在导入完成框提醒「有 N 条被覆盖」；**没发生** → 不提醒 |
| **新增《删除》按钮** | 链接表管理界面加《删除》按钮 → 点击弹框 → 可选**数据日期范围** → 按范围删除数据 |
| **对账数据范围** | ⚠️ **消费标记方案已移除（2026-06-09）**：对账读取**维持现状全表**网关行，不加 `matched_flag`、不改编排器。reconid 跨期复用漏匹配作为已知风险 re-opened（§四 R-1），待用户确认接受或另议（§五 OPEN-7）。|
| **版本 / 范围** | **3.0.1** 分支；本期**只改网关对账单**一张链接表（OPEN-1/2 已定）；空 `ReconBillBizId` 行拒入库+计入提醒（OPEN-3）|

> 原始原话存档：
> - Q1（累加范围）：「按2来，支持根据字段做数据幂等覆盖，新增《删除》按钮，点击后弹出框，可选数据日期范围进行数据删除。」
> - Q2（重复主键）：「可重复 reconid，导入时发现重复 ReconBillBizId 即做幂等处理；如果有数据做过幂等处理，在导入完成框里做提醒；没有数据做过幂等处理即不做提醒。」

---

## 一、现状与根因（代码事实，带出处）

### 1.1 当前是「整表覆盖」，且以**单文件**为覆盖单位（这就是 bug 根源）

- 导入入口 `linked-table:import`（`src/main.js:11218`）：用户多选文件后 `for (const filePath of res.filePaths)` **逐个文件**独立处理（`main.js:11230`）。
- 每个文件各自调用 `replaceLinkedTable` / `replaceLinkedTableStreaming` 落库，二者均为**整表覆盖**：
  - `replaceLinkedTable`（`linked-table-repository.js:256`）：`DELETE FROM 表`（line 269）→ INSERT 本批。
  - `replaceLinkedTableStreaming`（`linked-table-repository.js:297`）：`DELETE FROM 表`（line 311）→ 流式 INSERT。
- 后果：同时多选 3 个网关对账单 → 文件 1 被文件 2 删、文件 2 被文件 3 删 → **库里只剩文件 3**；但 3 个文件在 `results` 里**都返回 `status:'ok'`**（`main.js:11310`），前端汇总显示「3 个成功」→ **静默丢数据**。

### 1.2 当前表结构不支持按 `ReconBillBizId` 幂等

`linked_gateway_bill` 建表（`src/backend/database/migrations.js:2674`）：

```sql
CREATE TABLE IF NOT EXISTS linked_gateway_bill (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_id TEXT,        -- 来自 raw_json['reconciliationid']
  bill_date TEXT,                -- 来自 raw_json['Billdate']
  raw_json TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
-- idx_linked_gateway_bill_recon ON (reconciliation_id)  ← 普通索引，非 UNIQUE
-- idx_linked_gateway_bill_date  ON (bill_date)
```

- **无 `recon_bill_biz_id` 列**，也无任何 UNIQUE 约束 → 无法直接做 `ON CONFLICT` upsert。
- `reconciliation_id` 仅普通索引（非 UNIQUE）—— 现状本就允许重复，与用户「reconid 可重复」一致，**无需改动唯一性**（它本来就不唯一）。

### 1.3 `ReconBillBizId` 的精确表头（取值口径）

- 网关对账单真实表头来自 `assets/网关对账单.xlsx`，登记在 `GATEWAY_RECON_SIGNATURE.expectedHeaders`（`src/constants/table-signatures.js:117-123`）。
- `ReconBillBizId` 在 idx 13（`table-signatures.js:119`），精确大小写 = **`ReconBillBizId`**（夹在小写 `originBillBizId` 与全小写 `reconciliationid` 之间——⚠️ 该表表头大小写极不规则，取值必须**逐字符精确匹配** `raw_json['ReconBillBizId']`，不可猜大小写）。
- ⚠️ 不要用 `src/constants/gateway-recon-fields.js`：那是 v2.0.0 旧硬编码，其注释（line 8）明说「列名与 xlsx 表头几乎全不一致」，**不是** linked 表 raw_json 的真实字段名。

### 1.4 对账引擎对 `reconciliationid` 的依赖（资金红线核心）

链接表 `gateway-bill` 的 raw_json 被 5 轮对账引擎消费，均以 `reconciliationid`（小写）为 join key：

- `r1-recon-id-match.js:11`：`reconciliationid === ReconciliationId`，**严格 1v1 匹配**。
- `r4-fund-nature-check.js`：按 `reconciliationid` 重新关联改写 FundType。
- `r5-platform-inbound-cleanup.js:86,121`：按 `reconciliationid` 1v1；**同一 reconid 命中多行候选时 →「无法唯一定位，跳过剔除（数据异常）」**。

> 🔴 **校准（2026-06-09 复核 R1/R5 源码后修正，原描述有误）**：R1/R5 的「同 reconid 多行=数据异常 / 取第一条」警告，针对的是**银行对账单**侧同 reconid 多行——二者算法都是「遍历网关行 → 拿 reconid 查银行索引 `bankByReconId`」（`r1-recon-id-match.js:85-96` / `r5-platform-inbound-cleanup.js:89-124`），**与网关对账单累加导入无直接关系**。
> 网关侧 reconid 重复的真实影响：R1/R5 按网关原序「先到先得」1v1 消费银行行，银行行被抢光后，后续同 reconid 网关行**静默跳过**（不报错不警告，`r1:87` / `r5:90`）。
> 且因幂等键是 `ReconBillBizId`，**累加导入的最终表内容 ≡ 把多文件拼成 1 个大文件整表覆盖**——不会比现状引入更多 reconid 重复。故 OPEN-4 的真正变量是「reconid 是否跨期全局唯一」，而非「累加 vs 覆盖」。

---

## 二、目标语义（改造后）

1. **落库 = 跨次幂等累加**（仅网关对账单，本期范围见 OPEN-2）：
   - 不再 `DELETE FROM` 全表。
   - 逐行按 `ReconBillBizId` upsert：DB 已存在同 `ReconBillBizId` → 覆盖该行（raw_json/reconciliation_id/bill_date/imported_at 全部重写）；不存在 → 追加。
   - 一次多选 N 个文件：循环内逐文件 upsert，N 个文件全部生效（互不覆盖，除非彼此含相同 `ReconBillBizId`）。
2. **导入完成提醒**：统计本次 upsert 中「命中已存在 `ReconBillBizId` 而覆盖」的条数 `overwriteCount`；`>0` 才在导入完成框提醒，`=0` 不提醒。
3. **新增《删除》按钮**：按 `bill_date` 数据日期范围删除 `linked_gateway_bill` 行，并重算 meta（rowCount / dataDateMin / dataDateMax）。
4. **对账读取口径维持现状**（消费标记方案 2026-06-09 移除）：对账仍读 `linked_gateway_bill` 全表（`readLinkedTableRows('gateway-bill')`），不加 `matched_flag`、不改编排器。⚠️ 因此「累加多期 + reconid 跨期复用 → R1/R5 漏匹配」**未被本期解决**（§四 R-1，re-opened）。

---

## 三、关键设计决策（待实施，逐条需确认）

### D1. Schema：新增 `recon_bill_biz_id`（幂等键）列 + UNIQUE 索引
- `migrations.js` `ensureLinkedTableSupport` 内：
  - 新建表 CREATE 加 `recon_bill_biz_id TEXT`。
  - **存量表幂等加列**：仿 line 2687 `business_date→transaction_date` 的 `hasColumn` 守卫范式，`ALTER TABLE linked_gateway_bill ADD COLUMN recon_bill_biz_id TEXT`（仅列不存在时）。
  - 加列后**回填**：`UPDATE linked_gateway_bill SET recon_bill_biz_id = json_extract(raw_json,'$.ReconBillBizId')`（一次性迁移）。
  - 建 `CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_gateway_bill_biz ON linked_gateway_bill(recon_bill_biz_id)`。⚠️ UNIQUE 见 R-2；建索引前空键存量行直接删（OPEN-8）。
  - ❌ **不再新增 `matched_flag` 列 / matched 索引**（消费标记移除）。
- **风险**：UNIQUE 索引在已有重复值时**建不起来**；迁移逻辑必须先清洗存量重复 + 空键，否则启动 migration 抛错（资金模块启动失败）。

### D2. 落库：新增 `upsertLinkedGatewayBill`（不复用 replaceLinkedTable）
- `replaceLinkedTable` / `replaceLinkedTableStreaming` 被 4 张表共用且语义是「整表覆盖」；**不能直接改**（会破坏 mid-allocation/fx-settlement/bank-deposit 的覆盖语义 + ADM 派生）。
- 新增网关专用 upsert 函数：`INSERT INTO linked_gateway_bill (...) VALUES (...) ON CONFLICT(recon_bill_biz_id) DO UPDATE SET raw_json=excluded.raw_json, reconciliation_id=excluded..., bill_date=excluded..., imported_at=excluded...`。
- 复用 `createInsertContext` 的归一化（normalizeKey / normalizeDateForRange）保证值口径一致。
- meta 计算改为「全表重算」（累加后 rowCount/dateMin/Max 不能再用单批增量，需 upsert 后 `SELECT COUNT(*)/MIN/MAX` 重算）。

### D3. 提醒统计：`overwriteCount`
- upsert 每行前用 `db.changes()` 或先 `SELECT 1 ... WHERE recon_bill_biz_id=?` 判断是 INSERT 还是 UPDATE；累计 `overwriteCount`。
- 经 IPC `results[].overwriteCount` 回传 → 前端导入完成框：`overwriteCount>0` 时追加一行提醒（文案待定）。

### D4. 删除按钮：UI + IPC + DB
- **UI**：链接表管理弹窗 `createLinkedTableManagerDialog`（`src/renderer-dialogs.js`）加《删除》按钮 → 弹日期范围选择框（起止 `bill_date`）。
- **IPC**：新增 `linked-table:delete-by-date-range`（main.js）→ 校验入参 → `DELETE FROM linked_gateway_bill WHERE bill_date BETWEEN ? AND ?` → 重算 meta → 返回删除行数。
- **前端回归**：改了 renderer-dialogs.js 必须重跑对应 `npm run preview`（见项目约定 workflow_frontend_previews）。

### D5. meta 与「整表覆盖」UI 文案
- 现 meta 单一 `source_file_name`（`linked_table_meta`）；累加后来源是多文件，`source_file_name` 语义变化（拼接 / 显示「N 个文件」/ 显示最近一次？）—— 待定（OPEN-5）。

### D6 / D7. ~~对账消费标记（只读未标记 + 命中回写）~~ —— 🗑 已移除（2026-06-09）
> 原 D6（对账读网关改「仅未标记」）+ D7（命中回写 `matched_flag`、`markGatewayBillMatched`、编排器收集命中行）整套消费标记方案**整体移除**。
> 对账读取**维持现状** `readLinkedTableRows('gateway-bill')` 全表，不新增 `readUnmatchedGatewayBillRows` / `markGatewayBillMatched`，不改 `reconciliation-orchestrator.js`，不触及资金状态机。
> ⚠️ 由此 reconid 跨期复用漏匹配风险 re-opened，见 §四 R-1 / §五 OPEN-7。

---

## 四、资金红线风险（必须人工复核）

| # | 风险 | 说明 | 处置 |
|---|------|------|------|
| **R-1** | 🔴 **升级（2026-06-09 reconid 已确认跨期复用）**：累加多期 → 同 reconid 多网关行 → R1/R5s2/R5s3 1v1「先到先得」漏匹配 | 全面核查：无引擎假设网关 reconid 唯一、无单值 Map 静默丢行（编排器 `reconciliation-orchestrator.js:164` 透传不去重）；但 R1(`r1-recon-id-match.js:81-102` 漏匹配)、R5s2(`r5-fund-transfer-backfill.js:161-206` 漏回填)、R5s3(`r5-platform-inbound-cleanup.js:85-125` 漏剔除) 均网关↔银行 1v1 单向消费——同 reconid 后续网关行抢不到银行行→**静默漏处理**（不报错）。R4 吃 R1 1v1 产物不受影响；C1/C2/R5s4 无关。**🔑 当前整表覆盖（单期）不触发；批量累加（多期）才触发。** | ✅ **已决（2026-06-09）：用户接受漏匹配（OPEN-7=A）**。消费标记移除，对账维持全表读取；累加多期 + reconid 跨期复用时 R1/R5 静默漏匹配，作为**已知限制**接受、本期不规避。实施时在导入提醒 / 用户文档适当告知；另建议确认「单期内 reconid 是否唯一」（若否，当前对账已在漏匹配）。 |
| **R-2** | 🔴 UNIQUE 索引建立 + 存量/导入数据中 `ReconBillBizId` 空值或重复 | 空字符串 `''` 在 UNIQUE 下会互相冲突（SQLite 仅多个 `NULL` 互不冲突，`''` 会冲突）；存量已有重复则 migration 建 UNIQUE 索引直接抛错 → **资金模块启动失败**。 | 定义空值行策略（跳过/报错/允许 NULL）；migration 先清洗存量重复。→ OPEN-3 |
| **R-3** | 🔴 「整表覆盖」语义消失，用户旧心智「重导=清空」失效 | 旧版重导即清空重来；改累加后，用户若想「换一批数据」必须先用《删除》按钮清。需 UI 明确告知语义已变。 | 导入完成框/管理界面文案明确「累加导入」；删除按钮显著。 |
| **R-4** | 流式路径事务 + upsert | 大文件走 `replaceLinkedTableStreaming`（655k 行级）。upsert 版需保留「事务跨 await + 中途 throw 全 ROLLBACK」红线（`linked-table-repository.js:290` 已实测 657,757 行回滚），不能退化为逐行自动提交。 | upsert 流式版沿用单事务骨架。 |

---

## 五、OPEN（停一下，待你确认）

| # | 问题 | 我的建议 |
|---|------|---------|
| **OPEN-1** | ✅ **已定：3.0.1**（用户 2026-06-09：先发 3.0.0，再开 3.0.1 做本需求）。 | — |
| **OPEN-2** | ✅ **已定：本期只改网关对账单**一张链接表。其它 3 张（中台调拨/外汇交割/银行入金，幂等键各不同，bank-deposit 牵动 ADM 派生）另立 spec。 | — |
| **OPEN-3** | ✅ **已定：空 `ReconBillBizId` 行拒绝入库 + 计入导入提醒**（防 UNIQUE 冲突 + 防脏数据）。 | — |
| **OPEN-4** | ✅ **已答（2026-06-09）：reconid 会跨期复用、非全局唯一。** 触发 §四 R-1（累加多期 → R1/R5s2/R5s3 漏匹配）。 | 见 R-1（消费标记移除后 re-opened）+ OPEN-7 |
| **OPEN-7** | ✅ **已定（2026-06-09）：A 接受漏匹配**。消费标记方案移除后，对账维持读全表；累加多期 + reconid 跨期复用导致的 R1/R5 漏匹配**作为已知限制被用户接受**，本期不做规避。批量累加定位＝「导入 / 存档不丢文件」。 | — |
| **OPEN-5** | 累加后 `source_file_name`（数据来源）怎么显示？ | 建议：显示「最近一次导入文件名 + 累计 N 个来源」 |
| **OPEN-6** | ✅ **已定（2026-06-09）：闭区间 [起,止] + 直接删（无二次确认）**。~~删除弹框内须显著提示「删除后不可恢复 + 将删约 N 行」（唯一一道确认）~~ → 🔄 **2026-06-09 后续 UI 迭代用户撤销该显著提示**：去红色警告框 + 计数显示，仅保留后台 count 门控防误删（详见 PRD §十一）。 | — |
| **OPEN-8（存量空键）** | ✅ **已定（2026-06-09）：建 UNIQUE 前空 `ReconBillBizId` 存量行直接删除**（与新导入空键拒入同口径）。🔴 不可逆，migration 记录删除行数。 | — |

---

## 六、实施任务拆分（需求已定稿，预估 5 个 task）

1. **migration**：加 `recon_bill_biz_id` 列 + 回填 + UNIQUE 索引 + 存量去重/空键清洗（D1 / R-2 / OPEN-8）。
2. **仓储·导入**：`upsertLinkedGatewayBill`（数组 + 流式两版）+ overwriteCount + 空键拒入计数 + meta 全表重算（D2 / D3 / R-4）。
3. **handler·导入**：`linked-table:import` 网关分支改走 upsert；`results[].overwriteCount` / `rejectedEmptyCount` 回传（D2 / D3）。
4. **删除**：`linked-table:delete-by-date-range` handler + DB 删除 + meta 重算（D4）。
5. **前端**：《删除》按钮 + 日期范围弹框（直接删，含「不可恢复 + 将删 N 行」提示）+ 导入完成框「覆盖 N / 拒入 M」提醒；重跑 preview（D4 / D5）。

> ❌ 原 task 4/5（对账消费标记 仓储 + 编排器）已随消费标记方案移除。
> 🔴 **不再触及对账编排器**（消费标记移除）；但 task1/2 改 schema + 落库语义仍是资金红线，提 PR 前必跑 `/check-vars`。

---

## 七、测试计划（待实施）

- **单测**：upsert 幂等性（同 ReconBillBizId 二次导入只 1 行且为新值）、overwriteCount 计数、空 ReconBillBizId 拒入计数、按日期删除 + meta 重算、UNIQUE 冲突/空键迁移。
- **集成**：多选 3 文件累加全进库；跨次导入累加；重复 ReconBillBizId 覆盖 + 提醒；删除日期范围。
- **资金红线评估（R-1，re-opened）**：消费标记移除后对账维持全表；用真实重复 reconid 样本跑 R1/R4/R5，**量化累加多期下的漏匹配程度**，供用户决策对账数据范围（OPEN-7）。
- `npm run release-check` 全绿 + 改前端后 `npm run preview` 对照。

---

## 八、重要变量影响（check-vars 预备，实施后须跑 /check-vars）

预计触及 `rules/important-variables.md`：
- `replaceLinkedTable` / `replaceLinkedTableStreaming`（落库语义变更）
- `linked_gateway_bill` 表结构（+ `recon_bill_biz_id` 幂等键；~~`matched_flag`~~ 已移除）/ `LINKED_TABLE_DEFS`
- `reconciliation_id` / `ReconBillBizId`（唯一性约束 + 新幂等键）
- `readLinkedTableRows`（对账取网关源**维持现状全表**，消费标记移除后不改）；`reconciliation-orchestrator` **不改**
- `reconIdFixResult`（若网关数据变更需联动清空，参照 bank-deposit 范式 `main.js:11347`）

> 实施提 PR 前必须跑 `/check-vars`（项目硬节点）。

---

## 九、变更记录

| 日期 | 变更 |
|------|------|
| 2026-06-09 | 需求定稿：批量导入 + 幂等累加 + 按日期删除 + （原）对账消费标记；OPEN-1~8 拍板 |
| 2026-06-09 | 🗑 **移除「对账消费标记」整套方案**（用户「对账消费标记有关的完全去掉」）：删 `matched_flag` 列/索引、D6/D7、`readUnmatchedGatewayBillRows`、`markGatewayBillMatched`、编排器命中回写、D2 重导标记边界、相关 task 4/5 与测试。本期范围收敛为 **批量导入 + 幂等累加 + 按日期删除**（不动对账编排器/状态机）。<br>⚠️ 副作用：消费标记原是解 reconid 跨期复用漏匹配的方案，移除后 **§四 R-1 漏匹配风险 re-opened**，对账数据范围处置回到未决（§五 OPEN-7），待用户决策。
