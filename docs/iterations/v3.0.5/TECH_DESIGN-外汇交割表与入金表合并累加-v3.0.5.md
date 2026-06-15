# TechDoc - 网银账单小助手 v3.0.5「外汇交割表 + 银行对账单入金表：整表覆盖 → 幂等累加 + OPEN-7 跨期命中提醒」

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.5 |
| 日期 | 2026-06-15 |
| 作者 | 软件架构师（实现蓝本；spec OPEN-1~7 全闭环可实施） |
| 状态 | 定稿（设计蓝本，进入实现以本文 + spec 为准） |
| 关联 spec | `changes/linked-fx-bank-deposit-merge-import/spec.md`（✅ 全部拍板 OPEN-1~7 全闭环） |
| 先例 | v3.0.1 网关对账单「批量导入 + 幂等累加 + 按日期删除」（`changes/linked-gateway-bill-batch-idempotent/spec.md`，范式全盘复用） |
| 性质 | 🔴🔴 **资金对账红线**：链接表落库语义从「整表覆盖」改「跨次幂等累加」；新增 export → 链接表写路径（OPEN-7） |
| 下游协调 | `refund-backfill-rules-v2`（同 v3.0.5；R3/R5/R6 新增「入金表为命中来源」入口，其命中点 hook 由该 change 落地时接入本机制 OPEN-7b——跨 spec 契约，见 `docs/iterations/v3.0.5/TECH_DESIGN-中台退款订单回填规则增强-v3.0.5.md` §D12） |

> 🔴 本文件是**实现蓝本**，文中 JS 片段均为**设计示意（伪代码 / 骨架），标注「设计示意非最终实现」**，进入实现版本由 dev 落地 + 补单测。所有代码现状描述均带 `file:line` 出处。
>
> 🔴🔴 **资金红线高亮约定**：凡 🔴🔴 标记段落为「资金对账数据正确性 / 不可逆删除 / 新增写路径」核心，**实施 + review 必须逐条人工复核**。

---

## 〇、一句话与目标版本

把链接表库的「外汇交割表 `fx-settlement` / `linked_fx_settlement`」+「银行对账单入金表 `bank-deposit` / `linked_bank_deposit`」从「整表覆盖（`replaceLinkedTable` 的 `DELETE FROM` 全表 + INSERT）」改成「跨次幂等 upsert 累加」（仿网关 v3.0.1），并新增「跨期重复命中提醒（OPEN-7）」机制。

**修复 bug**：一批多选 N 个同类型文件，前 N-1 个被静默覆盖，但前端 results 全部 `status:'ok'` → 显示「N 个成功」（与网关 v3.0.1 同根因）。现状根因见 spec §1.1：`src/main.js:11468-11484` 只有 `isGatewayBill` 走 upsert，fx-settlement / bank-deposit 走 `replaceLinkedTable` / `replaceLinkedTableStreaming`（`linked-table-repository.js:290` 的 `DELETE FROM ${def.table}` + INSERT）。

**目标版本 v3.0.5**：与 `size-startup-optimization`（剩 Phase 2/3/4）+ `refund-backfill-rules-v2` 同版本发；原拟 3.0.7 作废（spec OPEN-6）。本 change 作为 refund-backfill-rules-v2 的**硬前置先实施**（代码顺序 linked-fx → refund）。

---

## 一、PRD（spec）评审意见（技术角度）

### 1.1 可直接落地的部分

| spec 要点 | 架构师评审 |
|---------|---------|
| §3.1 bank-deposit 全仿 gateway 先例（migration + upsert 双路 + 全表重算 meta） | ✅ 可直接落地。bank-deposit 与 gateway schema 同构（`id/key/date/raw_json/imported_at`），消费方全部全表读（`readLinkedTableRows('bank-deposit')`，`src/main.js:3646`），累加后语义天然正确（spec §1.4-2）。幂等键 `BizId` 自 13 字段时代即在白名单 `BANK_DEPOSIT_FIELDS[0]`（`linked-table-repository.js:35`）→ 存量 raw_json 可回填。 |
| §3.1 upsert 内核泛化（gateway/bank-deposit/fx 共用，禁复制第二份） | ✅ 强烈赞同。现状 `buildGatewayUpsertContext`（`linked-table-repository.js:368`）+ `recomputeGatewayMeta`（:406）已是范式件，但**硬编码 `gateway-bill` 与 `obj.ReconBillBizId`**。参数化为「表 def + 幂等键取值函数」三表共用，避免口径漂移（§二 + §三 + §五）。 |
| §3.2.1 fx 主表单键（交易编号）+ 空键拒入 | ✅ 可落地。交易编号归一口径 `normalizeTransactionNo`（`boc-fx-link-builder.js:32`）已存在且与 BOC 派生同口径（纯数字串化，number 入参 String 化无科学计数风险）。合计行=末行（交易编号列为非数字文本）→ 以**交易编号归一为空**判空键拒入（=幂等键本身为空；fx 主表无调拨单号列，详见 §4.1；spec §3.2.1 OPEN-2）。 |
| §3.2.2 BOC 派生「单文件内存派生 + 整表覆盖」→「增量进组 + DB 全量重匹配 + 重编号」 | ✅ 可落地但为本 change 复杂度全部来源。需新增 `orig_group_no` 列承载「scan 时刻组归属，永不被 2.2/2.3 改写」（spec §1.3-4：现状 `matchBocToMidAllocation` 的 2.2 命中会清空「分组」，`boc-fx-link-builder.js:191`，原始组号不可从现库恢复）。全量重匹配输入从「本文件行」变「全库行」，`matchBocToMidAllocation` 算法零改动（§四）。 |
| §3.3 删除按日期范围扩三表 + IPC 加 tableKey | ✅ 可落地。现状 `countGatewayBillByDateRange` / `deleteGatewayBillByDateRange`（`linked-table-repository.js:423/434`）+ IPC（`src/main.js:11327/11346`）硬编码网关；参数化白名单三表，逐表走各自 dateColumn（§七）。 |
| §3.6 OPEN-7 跨期命中提醒（专用列 + export 回写 + 提醒注入） | ✅ 可落地，机制清晰。专用列 `last_hit_run/last_hit_at` 落 `linked_bank_deposit`（不动 65.7 万行 raw_json）；命中入口 `matchJpmUs`（`r5-refund-order-backfill.js:183`）+ refund R3/R5/R6 二跳（后者 hook 由 refund-backfill 接入）；提醒注入 `r5-refund-order-backfill.js:96` 命中详情 + 主输出 `exceljs-writer.js:243` 命中明细（§六）。 |

### 1.2 技术意见 / 风险提醒（与 spec 风险表对应）

| 编号 | 架构师评审 | 处理 |
|------|---------|------|
| A-1 🔴🔴 | bank-deposit BizId 若非行级唯一 = 静默丢数据（spec R-1） | 实施前用真实银行对账单抽样核 BizId 重复率；migration 去重保留 id 最大兜底；上线后导入完成框 overwriteCount 异常大 = 键选错信号（§三 + §九）。 |
| A-2 🔴🔴 | fx 交易编号唯一性仅单文件单日（20260513）证实（spec R-7 / OPEN-2 残留风险） | migration 去重保留 id 最大 + 去重日志可见；upsert 同键覆盖 = 保留最新；建 UNIQUE 前去重 → 不阻塞启动（§五）。 |
| A-3 🔴🔴 | BOC 调拨单号全量重算每次 fx 导入触发，组号每次重编号跨次会变（spec R-2 / OPEN-5 已接受） | 纳入 CHANGELOG 契约变更说明 + USER_GUIDE；组号值无跨表业务含义（spec §1.3-6，仅组内一致标识）→ 重编号不破坏下游（§四）。 |
| A-4 🔴🔴 | OPEN-7 export 新增回写 `linked_bank_deposit` 的写路径（spec R-8） | 标记写入失败不影响导出产物落地（标记是观测增强非资金数据，graceful try/catch）；与删除联动清理被删 BizId 标记防悬挂（§六 + §七）。 |
| A-5 🔴 | 65.7 万行入金表 migration 触碰存量（spec R-6） | bank-deposit migration 全 SQL 侧 + 单事务 + 幂等可重入；启动耗时手测（§五 + §九未覆盖项）。 |
| A-6 🔴 | gateway parity：泛化重构不得改网关行为（字节不变） | 泛化内核以 gateway 现状为基准回归；既有 v3.0.1 单测全过为 parity 锁（§九）。 |
| A-7 🟠 | 删除联动派生重建必须与删除在一致事务边界，禁止「删主表、派生 stale」中间态（spec R-5） | fx 删除 → 联动删 BOC 同 `transaction_no` → 全量重匹配重编号；bank-deposit 删除 → 重建 ADM+BOC bank + 清缓存 + 清 OPEN-7 标记（§七）。 |

### 1.3 与 spec 的差异

无功能性差异。技术上把 spec §3.x 设计骨架细化为：① upsert 内核 / meta 重算 / 删除三件套**参数化泛化**（一份内核三表共用）；② fx BOC 派生抽出「重置-重匹配-重编号」纯函数编排（builder 内，便于幂等单测）；③ OPEN-7 命中标记读写收敛为专用仓储函数（读 + 写 + 删时清理三件）。行为以 spec §二「目标语义」逐条为验收基线。

---

## 二、涉及文件清单（精确到函数）

| 文件 | 改动类型 | 概要 | Task |
|------|---------|------|------|
| `src/backend/database/migrations.js` | 修改 | `ensureLinkedTableSupport` 内三块：① `linked_fx_settlement` JS 层全表重算键列回填+删空键+去重保留 id 最大+建 UNIQUE；② `linked_bank_deposit` 加 `biz_id`（SQL 回填）+ 删空键 + 去重 + UNIQUE，再加 `last_hit_run/last_hit_at`；③ `ensureBocFxLinkSupport`（`migrations.js:2965`）加 `orig_group_no` 列 + `transaction_no` UNIQUE + **清空两张派生表**（`linked_boc_fx_settlement` / `linked_boc_bank_deposit`）。范式：v3.0.1 网关段 `migrations.js:2846-2868` | T1 |
| `src/backend/database/linked-table-repository.js` | 修改 | ① **upsert 内核泛化** `buildUpsertContext(db, tableKey, keyExtractor, importedAt)`（由 `buildGatewayUpsertContext` :368 提炼）；② **meta 重算泛化** `recomputeLinkedMeta(db, tableKey, sourceFileName, importedAt)`（由 `recomputeGatewayMeta` :406 提炼）；③ 新增 `upsertLinkedBankDeposit` + `upsertLinkedBankDepositStreaming`、`upsertLinkedFxSettlement`（仅数组版）；④ `countLinkedByDateRange` / `deleteLinkedByDateRange` 参数化（由 :423/:434 提炼）；⑤ BOC：`upsertBocFxLink`（替代 `replaceBocFxLink` :735 的整表覆盖）+ `resetAndRematchBocFxLink` 全量重匹配重编号编排 + `deleteBocFxLinkByTxnNos`；⑥ OPEN-7：`markBankDepositHits` / `clearBankDepositHitsByBizIds` / `readBankDepositHitMeta`。`pickBankDepositFields`（:51）不变 | T2/T3/T5 |
| `src/backend/database.js` | 修改 | AppDatabase facade 暴露上述新仓储函数（与现状 `upsertLinkedGatewayBill` 等同范式转发） | T2/T3/T5 |
| `src/main-process/boc-fx-link-builder.js` | 修改 | `scanFxGroups`（:88）加「组号偏移续编」入参（`offset`）；新增 `rematchAllBocGroups(allRows)` 纯函数（按 `orig_group_no` 聚合 → 行序全局重编号 1..N → 重置「分组/调拨单号」→ 调 `matchBocToMidAllocation` :143 逻辑零改动）；`normalizeTransactionNo`（:32）不变 | T3 |
| `src/main.js` | 修改 | ① 导入 handler（:11468-11484）：bank-deposit 换 upsert 双路、fx 换 upsert 数组版；② fx 派生块（:11511-11587）改「全量重算所有组」（scan 本文件 → upsert 进 BOC → resetAndRematch 全库 → 2.4/2.5 照旧）；③ 删除 handler（:11327/11346）扩 `tableKey` 参数 + 派生联动；④ export handler（:3704）成功后回写 OPEN-7 命中标记；⑤ run handler（:3666）透传命中收集器（产命中 BizId 清单）。⚠️ `src/main.js` 含 NUL，grep 须 `-a` | T4/T5 |
| `src/preload.js` | 修改 | `count-by-date-range` / `delete-by-date-range` 透传 `tableKey` 参数（白名单已在 main 校验，preload 仅转发） | T4 |
| `src/main-process/scenario-engines/r5-refund-order-backfill.js` | 修改 | 引擎产出命中 refund 行时**收集「桥接入金表行 BizId」**（`matchJpmUs` :183 命中的 dep 行 BizId）→ 经返回值上抛；命中详情（`buildBackfillRow` :96 的 `匹配命中详情`）在 export 回写检测到跨期命中时追加提醒文案（提醒注入点在 export 阶段，引擎仅产 BizId） | T5 |
| `src/main-process/exceljs-writer.js` | 修改（⏳ 预留，本期可不实改） | 主输出「命中明细」sheet2（:243 `hitHeaders`，:259 `buildHitDetail`，数据源 `processingResult.modifications`）对「以入金表行为命中来源」的行追加跨期提醒文案。⚠️ 本期唯一入金表来源命中=matchJpmUs，其产物是**退款回填文件**行（非主输出命中明细），故本期不经此注入点；此处为 refund R3/R5/R6 二跳预留（详见 §6.4 范围说明） | T5（预留） |
| `src/renderer-dialogs.js` | 修改 | 导入完成框对 fx/bank-deposit 显示「幂等覆盖 N / 空键拒入 N」（仿 gateway D3）；删除弹框加「目标表」下拉（三表，标题随选切换，`renderer-dialogs.js:6526` 写死标题改动态） | T6 |
| `tests/unit/**` + `scripts/integration/**` | 新增/修改 | §九 测试矩阵 | T7 |
| `CHANGELOG.md` / `docs/VERSION_FEATURE_HISTORY.md` / `docs/USER_GUIDE.md` | 修改 | 文档三件套（契约变更：累加语义 + BOC 重编号 + 删除三表 + OPEN-7） | T7 |

---

## 三、bank-deposit 累加方案 🔴🔴（全仿 gateway 先例）

### 3.1 幂等键 = BizId（OPEN-1）

- 取值口径：`bizId = normalizeKey(obj.BizId)`，`normalizeKey`（`linked-table-repository.js:155`）= `String(value).trim()`，与 migration 回填 `TRIM(json_extract(raw_json,'$.BizId'))` 字节一致（防存量键与 upsert 键漂移）。
- `BizId` = `BANK_DEPOSIT_FIELDS[0]`（`linked-table-repository.js:35`），自 13 字段时代即在白名单 → 存量行 raw_json 必含该字段 → SQL 侧可回填（§五）。
- ⚠️ **不可用 `ReconciliationId`**：R1/R5 引擎注释证实银行侧同 reconid 多行 = 数据异常（spec §1.4-3），做 UNIQUE 会静默互相覆盖。

🔴🔴 **资金红线 A-1**：BizId 选键前提是行级唯一。若同一银行对账单内多行共享同一 BizId → upsert 会合并掉合法行 = 静默丢数据。上线后导入完成框 `overwriteCount` 异常大（远超历史重叠预期）即键选错信号；实施前必须用真实银行对账单抽样核 BizId 重复率。

### 3.2 upsert SQL（设计示意非最终实现）

```javascript
// 【设计示意非最终实现】泛化 upsert 内核（替代 buildGatewayUpsertContext，三表共用）
// keyExtractor(obj) → 幂等键字符串（gateway: obj.ReconBillBizId / bank-deposit: obj.BizId / fx: normalizeTransactionNo(交易编号)）
// keyColumnInDb     → 幂等键 DB 列（gateway: recon_bill_biz_id / bank-deposit: biz_id / fx: transaction_no）
function buildUpsertContext(db, tableKey, { keyExtractor, idKeyColumn }, importedAt) {
  const def = getDef(tableKey);
  // DO UPDATE 不写幂等键列本身（它是 ON CONFLICT 判定键，不变）
  const upsertSql = `
    INSERT INTO ${def.table} (${idKeyColumn}, ${def.keyColumn}, ${def.dateColumn}, raw_json, imported_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(${idKeyColumn}) DO UPDATE SET
      ${def.keyColumn} = excluded.${def.keyColumn},
      ${def.dateColumn} = excluded.${def.dateColumn},
      raw_json = excluded.raw_json,
      imported_at = excluded.imported_at
  `;
  const upsertStmt = db.prepare(upsertSql);
  const existsStmt = db.prepare(`SELECT 1 FROM ${def.table} WHERE ${idKeyColumn} = ? LIMIT 1`);
  const counters = { upserted: 0, overwriteCount: 0, rejectedEmptyCount: 0 };

  const upsertOne = (row) => {
    const obj = row && typeof row === 'object' ? row : {};
    const idKey = normalizeKey(keyExtractor(obj)); // 空键拒入（与 migration 删空键同口径）
    if (idKey === '') { counters.rejectedEmptyCount += 1; return; }
    const keyValue = normalizeKey(obj[def.keyHeader]);
    const dateIso = normalizeDateForRange(obj[def.dateHeader]);
    const rawJson = JSON.stringify(obj);
    const existed = existsStmt.get(idKey) !== undefined; // 先 SELECT 判 INSERT/UPDATE（.changes 区分不了）
    upsertStmt.run(idKey, keyValue, dateIso, rawJson, importedAt);
    if (existed) counters.overwriteCount += 1;
    counters.upserted += 1;
  };
  return { upsertOne, counters };
}
```

> 🔴 现状 `buildGatewayUpsertContext`（`linked-table-repository.js:368`）在 DO UPDATE 不写 `recon_bill_biz_id` 本身——泛化后同口径（不写 `idKeyColumn`）。gateway 改用 `keyExtractor=(o)=>o.ReconBillBizId, idKeyColumn='recon_bill_biz_id'` 调泛化内核 → 行为字节不变（A-6 parity）。

### 3.3 流式版 65 万行内存恒定 + 事务 ROLLBACK 🔴🔴

bank-deposit 物理单 sheet `.xlsx` 走流式（`src/main.js:11459` `useStreamingPath` = `detected.streamingEligible && repoKey !== 'fx-settlement'`），须保持 spec R-6 内存恒定约束：

```javascript
// 【设计示意非最终实现】结构照抄 upsertLinkedGatewayBillStreaming（linked-table-repository.js:492）
// 去掉 DELETE、insertOne→upsertOne、meta 换全表重算；单事务跨 await 全程开启
async function upsertLinkedBankDepositStreaming(db, feedRows, options = {}) {
  if (typeof feedRows !== 'function') throw new Error('需要 feedRows 回调');
  const importedAt = new Date().toISOString();
  const ctx = buildUpsertContext(db, 'bank-deposit',
    { keyExtractor: (o) => o.BizId, idKeyColumn: 'biz_id' }, importedAt);
  db.exec('BEGIN');
  let metaState;
  try {
    await feedRows(ctx.upsertOne);                       // 事务全程开启；caller 边流式读 xlsx 边逐行 upsertOne
    metaState = recomputeLinkedMeta(db, 'bank-deposit', normalizeSourceFileName(options), importedAt);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_e) { /* no active txn */ }
    throw error;                                          // 🔴🔴 中途任意 throw → ROLLBACK，旧累加数据完好
  }
  return { tableKey: 'bank-deposit', ...ctx.counters, ...metaState, updatedAt: importedAt };
}
```

🔴🔴 **资金红线 A-5**：node:sqlite `DatabaseSync` 单进程单连接同步 API，`BEGIN` 开启的事务在 `await feedRows(...)`（event loop 让出读盘/解压 stream）期间依然保持开启（现状 `replaceLinkedTableStreaming` 已实测 657,757 行单事务回滚，`linked-table-repository.js:311-318` 注释）。upsert 流式版**不得退化为逐行自动提交**。`pickBankDepositFields`（:51）裁列在 upsert 前不变（spec §3.1）——caller 经 `transform=pickBankDepositFields`（`src/main.js:11446`）。

### 3.4 meta 全表重算

```javascript
// 【设计示意非最终实现】泛化 meta 重算（替代 recomputeGatewayMeta，三表共用）
function recomputeLinkedMeta(db, tableKey, sourceFileName, importedAt) {
  const def = getDef(tableKey);
  const rowCount = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${def.table}`).get().c) || 0;
  const range = db.prepare(
    `SELECT MIN(${def.dateColumn}) AS mn, MAX(${def.dateColumn}) AS mx FROM ${def.table} WHERE ${def.dateColumn} IS NOT NULL AND ${def.dateColumn} != ''`
  ).get();
  const state = { rowCount, dataDateMin: range && range.mn != null ? range.mn : null, dataDateMax: range && range.mx != null ? range.mx : null };
  upsertLinkedTableMeta(db, tableKey, state, sourceFileName, importedAt); // 现状函数（:242）不变
  return state;
}
```

> 累加后 rowCount / 日期范围**不能用单批增量**（spec D2 / §1.2 网关先例）：rowCount = COUNT(*) 全表（含 date 为 null 行）；日期范围 = MIN/MAX(dateColumn) 排除 null/空串。`source_file_name` = 最后一次导入文件名（gateway 同款）。

### 3.5 main.js 导入分支（既有派生零改动）

bank-deposit 分支由 `replaceLinkedTable(Streaming)` 换 upsert 双路（`src/main.js:11468-11484`）；`okResult` 回传 `overwriteCount / rejectedEmptyCount`。**既有派生触发与缓存清理零改动**：ADM 派生（`src/main.js:11606-11614`，基于全库 `readBankDepositAdmCandidates` :552 重建）、BOC bank 派生（fx 派生块内 `readBankDepositBocCandidates` :713）、`reconIdFixResult = null`（:11617）、`processingResult` 清空。累加后这些派生自动以「全库行」为输入重建，语义正确，仅输入变多（spec §1.4-2）。

---

## 四、fx-settlement 累加 + BOC 全量重算 🔴🔴

### 4.1 主表 `linked_fx_settlement`（交易编号单键，OPEN-2）

- 幂等键 = `normalizeTransactionNo(交易编号)`（`boc-fx-link-builder.js:32`，与 BOC 派生同口径）。number 入参经 `normalizeCellValue` String 化（9 位纯数字，无科学计数风险）。
- **空键拒入口径 = 交易编号归一为空**（=幂等键本身为空，与 gateway/bank-deposit 同口径）：合计/页脚行=末行（交易编号列="生成日期:YYYYMMDD" 为非数字文本、渠道流水号空），`normalizeTransactionNo` 对该文本返回 ''（含非数字字符）→ 以**交易编号归一为空**判空键拒入 + 计数即可覆盖合计行。⚠️ **fx 主表无「调拨单号」列**（`table-signatures.js:141-147` FX 签名 expectedHeaders 不含此列；调拨单号是 BOC 派生表/中台字段，`boc-fx-link-builder.js` 派生时才赋值）→ **不可按「调拨单号空」判 fx 行空键**（对 fx 原始行恒空会全表拒入）。spec §3.2.1 已同口径回写为「交易编号归一为空」。
- 仅数组版（fx 永不走流式，`src/main.js:11454` `repoKey !== 'fx-settlement'` 守卫保持——BOC 分组需物理行号断档，spec §1.3-3 / `src/main.js:11450-11453` 注释）。

```javascript
// 【设计示意非最终实现】fx upsert（仅数组版，复用泛化内核）
function upsertLinkedFxSettlement(db, rows, options = {}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const importedAt = new Date().toISOString();
  const ctx = buildUpsertContext(db, 'fx-settlement',
    { keyExtractor: (o) => normalizeTransactionNo(o['交易编号']), idKeyColumn: 'transaction_no' }, importedAt);
  db.exec('BEGIN');
  let metaState;
  try {
    for (const row of safeRows) ctx.upsertOne(row);
    metaState = recomputeLinkedMeta(db, 'fx-settlement', normalizeSourceFileName(options), importedAt);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch (_e) {} throw error; }
  return { tableKey: 'fx-settlement', ...ctx.counters, ...metaState, updatedAt: importedAt };
}
```

> ⚠️ 仓储现状不 require `boc-fx-link-builder`（避免循环依赖，`linked-table-repository.js:691` 注释；builder require 本文件）。`normalizeTransactionNo` 须在仓储内**就地内联**一份同口径实现（与 builder `:32` 保持一致，加单测锁两份字节一致），或把 `normalizeTransactionNo` 下沉到无依赖的工具模块由两边 require。**推荐后者**（单一真相，防漂移）——实现时定。

### 4.2 BOC 链接表：增量进组 + DB 全量重匹配 + 重编号

**新增列 `orig_group_no`（原始组号）**：scan 时刻的组归属，**永不被 2.2/2.3 改写**；现有 `group_no` 退化为「匹配后展示分组」。这是全量重匹配的前提（spec §1.3-4：现状 2.2 命中行 `matchBocToMidAllocation` 把「分组」清空 `boc-fx-link-builder.js:191`，原始组号不可从现库恢复）。

**每次 fx 导入的派生流程（替代现状 `src/main.js:11511-11541` 的「单文件 scan + replaceBocFxLink 整表覆盖」）：**

1. **本文件** `scanFxGroups`（物理行号分组逻辑零改动，`boc-fx-link-builder.js:88`）；组号续编：`offset = SELECT MAX(CAST(orig_group_no AS INTEGER)) FROM linked_boc_fx_settlement`，本文件组号 += offset（全局不冲突）。
2. scan 产物按主表幂等键（`transaction_no`，OPEN-2 同口径）**upsert 进 BOC 表**（`upsertBocFxLink`，替代 `replaceBocFxLink` :735 整表覆盖；BOC 表新增 `transaction_no` UNIQUE）：同键覆盖（迁移到新组，id 不变 → 行序稳定），新键追加。`orig_group_no` 写 scan 续编后的组号。
3. **全量重匹配 + 重编号**（OPEN-5）：读全库 BOC 行（`readBocFxLinkRowsWithIds` :799 `ORDER BY id ASC` 作行序优先口径）→ 调 `rematchAllBocGroups` → 整批写回。
4. 2.4（`buildBocBankRows` :262 + `replaceBocBankDeposit` :841）与 2.5（`backfillBocReconLinkIds` :321 全量回填 + `writeBocFxLinkReconIds` :816）**照旧**。

```javascript
// 【设计示意非最终实现】rematchAllBocGroups —— builder 内纯函数（全量重匹配重编号）
// allRows = readBocFxLinkRowsWithIds 产物 [{ id, row }]（已含 orig_group_no）
function rematchAllBocGroups(allRows, midRows) {
  const list = Array.isArray(allRows) ? allRows : [];
  // 1) 按 orig_group_no 聚合（永不被改写的 scan 时刻组归属）
  const byOrig = new Map();
  for (const it of list) {
    const og = normalizeCellValue(it.row[FIELD_MAP.linkGroup_orig]); // orig_group_no
    if (!byOrig.has(og)) byOrig.set(og, []);
    byOrig.get(og).push(it);
  }
  // 2) 按行序（id ASC）全局重编号 1..N（消除空洞）：组首次出现序 = 新组号
  const origToNew = new Map();
  let nextNo = 0;
  const rows = []; // 仅 row 视图，供 matchBocToMidAllocation 原地改
  for (const it of list) { // list 已 ORDER BY id ASC
    const og = normalizeCellValue(it.row[FIELD_MAP.linkGroup_orig]);
    if (!origToNew.has(og)) { nextNo += 1; origToNew.set(og, String(nextNo)); }
    // 3) 重置：分组 = 重编号后组号；调拨单号 = ''（重匹配前清空）
    it.row[FIELD_MAP.linkGroup] = origToNew.get(og);
    it.row[FIELD_MAP.linkAllocationNo] = '';
    rows.push(it.row);
  }
  // 4) 重跑 2.2+2.3（matchBocToMidAllocation 逻辑零改动，输入从「本文件行」变「全库行」）
  const matchRet = matchBocToMidAllocation(rows, midRows);
  return { rows: list, logs: matchRet.logs }; // list 内 row 已被原地改
}
```

> 🔴 **行序优先口径**：`ORDER BY id ASC`（`readBocFxLinkRowsWithIds` :800）= upsert 累加顺序（同键覆盖 id 不变保稳，新键 AUTOINCREMENT 递增）。组号重编号取「组首次出现序」→ 1..N 连续无空洞。`matchBocToMidAllocation`（:143）内部按 `rows` 数组序遍历（行序优先取首，:174/:206）——输入行序由 `rematchAllBocGroups` 按 id ASC 喂入，与现状单文件物理行序口径一致（同组内 + 跨组均稳定）。

🔴🔴 **资金红线 A-3 语义变化（OPEN-5 已接受）**：mid-allocation 导入仍**不**触发重匹配（维持 v3.0.4 契约④，`src/main.js:11601` mid 入口仅重建 ADM 不碰 BOC fx）；但**任意一次 fx 导入会全量重算所有组（含历史组）的调拨单号**——中台数据在两次 fx 导入间变过则历史组调拨单号随之刷新。组号每次重编号，跨次活动日志组号会变。组号值无跨表业务含义（spec §1.3-6，仅组内一致标识，下游 `boc-dispatch-order-fix.js` 按「分组」聚合整组匹配）→ 重编号不破坏下游。

### 4.3 同日同金额一对一消耗不重复回填

`matchBocToMidAllocation`（:143）的 2.2 单行剔除 + 2.3 组汇总匹配均以候选 `consumed` 状态（:168/:174/:228）实现一对一消耗。`rematchAllBocGroups` 每次基于全库行 + 全量 midRows 重跑，候选 `consumed` 仅存在于单次运行内存（spec §1.3-4）→ 全量重算天然幂等：同输入两次结果一致（§九 单测锁）。同日同金额多候选「按物理行序取首」（:184/:235 warning + 取首）→ 不重复回填。

### 4.4 累加后 BOC 全量重匹配内存 / 复杂度上界（资金红线相邻评估）

> ⚠️ 现状 fx 体量小（spec §1.6 单文件覆盖产物），但**本期改累加后 `readBocFxLinkRowsWithIds` 全量重匹配会把「全库」BOC 行读回内存**（不再只本文件）。须给上界，即便结论是「可接受」。

- **行数量级**：fx 交割表每文件每期约数百行（实测 `20260513` 单文件 24 数据行；BOC 渠道行是其子集）。长期累加（数十期 × 每期数百行）→ BOC 全库行数预估 **万级以内**（远小于 bank-deposit 的 65.7 万行）。全量重匹配读回内存的 `[{id,row}]` 万级数组 + 全量 midRows（中台调拨订单，同量级）→ 内存尖峰 **MB 级，可接受**（无流式必要）。
- **复杂度**：`matchBocToMidAllocation` 的 2.2 是「每候选 × 全行」线性扫（`boc-fx-link-builder.js:174-182`），2.3 是「每组 × 候选」。累加后行数 n 与候选数 m 同步增长 → 最坏 **O(n×m)**（非 O(n²) 全表笛卡尔，因 2.3 按组聚合后只比同组）。万级行 × 万级候选最坏 1e8 次比较——单次 fx 导入触发，非热路径，**可接受但建议实测**；若未来 fx 体量异常增长（如单期数万行），需评估是否引入按日期/金额索引剪枝。
- **缓解**：BOC 全量重匹配走内存（组内匹配），避免 O(n²) 全表笛卡尔（PRD §11.1）；上界纳入 §九未覆盖项手测观察（无 CI 大 fx 数据集）。

---

## 五、migration 设计 🔴🔴（gateway 范式 + 幂等可重入）

三块迁移落在**两个独立函数 / 两个独立事务**（database.js 顺序调用 `:523` ensureLinkedTableSupport → `:525` ensureAdmBankDepositSupport → `:527` ensureBocFxLinkSupport）：
- **fx（§5.2）+ bank-deposit（§5.1）两块** 在 `ensureLinkedTableSupport`（`migrations.js:2808`，自有 BEGIN/COMMIT/ROLLBACK，:2920/2922 附近）。
- **BOC 块（§5.3）** 在 `ensureBocFxLinkSupport`（`migrations.js:2965`，**自有独立 BEGIN/COMMIT**），非与 fx/bank-deposit 同一事务边界。

两事务**非原子**：若 fx/bank-deposit migration 成功而 BOC 清空失败 → 中间态（主表已加 UNIQUE、BOC 未清）靠 `hasColumn`（`migrations.js:10`）守卫**幂等可重入**兜底（下次启动续跑 BOC 块）。范式照搬 v3.0.1 网关段（`migrations.js:2846-2868`）：ALTER 加列 → 回填 → 删空键 → 去重保留 id 最大 → 建 UNIQUE。每块用 `hasColumn` 守卫幂等（仅列不存在时执行整块）。

### 5.1 bank-deposit（SQL 侧，65 万行）

🔴🔴 **资金红线 A-5**：bank-deposit migration 必须全 SQL 侧（不可 JS 全表读 65.7 万行，spec §1.4-4 / R-6），单事务 + 幂等可重入：

```javascript
// 【设计示意非最终实现】仿 migrations.js:2846-2868 网关段
if (!hasColumn(db, 'linked_bank_deposit', 'biz_id')) {
  db.exec('ALTER TABLE linked_bank_deposit ADD COLUMN biz_id TEXT;');
  db.exec("UPDATE linked_bank_deposit SET biz_id = TRIM(json_extract(raw_json, '$.BizId'));"); // 回填，与 normalizeKey 字节一致
  const delEmpty = db.prepare("DELETE FROM linked_bank_deposit WHERE biz_id IS NULL OR biz_id = ''").run().changes;
  const delDup = db.prepare('DELETE FROM linked_bank_deposit WHERE id NOT IN (SELECT MAX(id) FROM linked_bank_deposit GROUP BY biz_id)').run().changes; // 去重保留 id 最大（最新）
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_bank_deposit_biz ON linked_bank_deposit(biz_id);');
  if (delEmpty || delDup) {
    appendModuleLog({ level: 'warning', source: 'main', domain: 'migration',
      message: '[migration v3.0.5] linked_bank_deposit 幂等键迁移：建 UNIQUE 前清洗存量（资金数据不可逆删除）',
      details: [`删除空键行 ${delEmpty} 条`, `删除重复键旧行 ${delDup} 条`] });
    // 同步 linked_table_meta（口径对齐 recomputeLinkedMeta：rowCount=COUNT(*) 全表；日期范围 MIN/MAX 排除 null/空串）
    const c = Number(db.prepare('SELECT COUNT(*) AS c FROM linked_bank_deposit').get().c) || 0;
    const rg = db.prepare("SELECT MIN(bill_date) AS mn, MAX(bill_date) AS mx FROM linked_bank_deposit WHERE bill_date IS NOT NULL AND bill_date != ''").get();
    db.prepare("UPDATE linked_table_meta SET row_count = ?, data_date_min = ?, data_date_max = ? WHERE table_key = 'bank-deposit'")
      .run(c, rg && rg.mn != null ? rg.mn : null, rg && rg.mx != null ? rg.mx : null);
  }
}
// OPEN-7：两专用列（不动 65.7 万行 raw_json）
if (!hasColumn(db, 'linked_bank_deposit', 'last_hit_run')) db.exec('ALTER TABLE linked_bank_deposit ADD COLUMN last_hit_run TEXT;');
if (!hasColumn(db, 'linked_bank_deposit', 'last_hit_at')) db.exec('ALTER TABLE linked_bank_deposit ADD COLUMN last_hit_at TEXT;');
```

> ⚠️ 现状 v3.0.1 网关 `appendModuleLog`（`migrations.js:2853`）禁直接 `console.*`（架构守护 v2.1.9-sr-log-1 Case 6：src 全树零 console.error/warn）→ bank-deposit 清洗日志同走 `appendModuleLog`。删除空键 + 去重均不可逆 → 日志记删除行数（spec OPEN-8 同口径）。

### 5.2 fx-settlement（JS 层全表读，体量小）

体量小（spec §1.6：单文件覆盖产物，含合计/非数字行）→ JS 层全表读重算键列（交易编号 number 须 String 化，SQL `TRIM(json_extract)` 对 number 取值有歧义，故 JS 层用 `normalizeTransactionNo` 归一更稳）：

```javascript
// 【设计示意非最终实现】fx 体量小，JS 层重算键列（单事务，幂等可重入）
if (!hasColumn(db, 'linked_fx_settlement', '__fx_key_migrated')) { // 用哨兵列/或检测是否已建 UNIQUE 作幂等守卫
  const all = db.prepare('SELECT id, raw_json FROM linked_fx_settlement ORDER BY id ASC').all();
  const upd = db.prepare('UPDATE linked_fx_settlement SET transaction_no = ? WHERE id = ?');
  const seen = new Map(); // key → id（保留最大 id）
  for (const r of all) {
    let key = '';
    try { const o = JSON.parse(r.raw_json); key = normalizeTransactionNo(o['交易编号']); } catch (_e) {}
    upd.run(key, r.id);
    if (key !== '') seen.set(key, r.id); // 后出现 id 更大 → 覆盖（保留 id 最大）
  }
  const delEmpty = db.prepare("DELETE FROM linked_fx_settlement WHERE transaction_no IS NULL OR transaction_no = ''").run().changes;
  const delDup = db.prepare('DELETE FROM linked_fx_settlement WHERE id NOT IN (SELECT MAX(id) FROM linked_fx_settlement GROUP BY transaction_no)').run().changes;
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_fx_settlement_txn_uniq ON linked_fx_settlement(transaction_no);'); // ⚠️ 与现状普通索引 idx_linked_fx_settlement_no（:2900）区分名
  // appendModuleLog 记 delEmpty/delDup + 同步 meta（同 5.1）
}
```

> 🔴 现状 `linked_fx_settlement` 已有普通索引 `idx_linked_fx_settlement_no`（`migrations.js:2900`，非 UNIQUE）→ 新建 UNIQUE 索引须用**不同名**（如 `idx_linked_fx_settlement_txn_uniq`），不可改原索引（CREATE UNIQUE INDEX IF NOT EXISTS 对已存在同名普通索引 no-op，不会升级为 UNIQUE）。幂等守卫：检测 UNIQUE 索引是否已存在（`PRAGMA index_list`）或哨兵列，避免重复跑去重。

🔴🔴 **资金红线 A-2**：交易编号唯一性仅单文件单日证实（spec R-7）。去重保留 id 最大 = 同键真撞则保留最新；去重日志可见（delDup>0 即异常信号，需人工核对是否合法重复交易编号）。

### 5.3 BOC 派生表（OPEN-3：清空 + 加列 + UNIQUE）

`ensureBocFxLinkSupport`（`migrations.js:2965`）内：

```javascript
// 【设计示意非最终实现】BOC fx 表加 orig_group_no + UNIQUE；清空两张派生表（OPEN-3）
if (!hasColumn(db, 'linked_boc_fx_settlement', 'orig_group_no')) {
  db.exec('ALTER TABLE linked_boc_fx_settlement ADD COLUMN orig_group_no TEXT;');
  // OPEN-3：存量原始组号不可恢复 → 清空两张 BOC 派生表，引导重导交割表全量恢复
  db.exec('DELETE FROM linked_boc_fx_settlement;');
  db.exec('DELETE FROM linked_boc_bank_deposit;');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_boc_fx_settlement_txn_uniq ON linked_boc_fx_settlement(transaction_no);'); // 与现状普通索引 idx_..._txn（:2981）区分名
  appendModuleLog({ level: 'warning', source: 'main', domain: 'migration',
    message: '[migration v3.0.5] BOC 派生表清空（orig_group_no 升级，存量原始组号不可恢复）：首启后请重导外汇交割表全量恢复' });
}
```

> 🔴 现状 BOC fx 表已有普通索引 `idx_linked_boc_fx_settlement_txn`（`migrations.js:2981`）→ UNIQUE 用不同名。清空两表后存量极少（v3.0.4 新表，spec §1.6）→ 清空成本可忽略。首启后弹框引导重导（沿用 `needBankImport` 弹框链文案，`src/main.js:11577` `okResult.bocDerive.needBankImport`）。

### 5.4 启动耗时实测项（A-5）

bank-deposit migration 全 SQL 侧（ALTER + UPDATE 回填 65.7 万行 + DELETE 去重 + CREATE UNIQUE INDEX）→ 单事务，启动耗时需实测（§九未覆盖项，无 CI 大数据集 → 手测）。fx + BOC 体量小可忽略。

---

## 六、OPEN-7 跨期命中提醒机制 🔴🔴（T5）

> 目标：累加后历史月份残留行仍参与对账匹配（读取口径不收窄，spec §3.5-3）；不硬排除，而是**标记 + 再次命中时提醒**，让用户看见「这条是上一期已命中过的残留行，疑似漏删」。

### 6.1 载体（7c）：专用列读写仓储

`last_hit_run`（TEXT，上次命中所属对账运行标识）+ `last_hit_at`（TEXT，命中时间）落 `linked_bank_deposit`（不动 65.7 万行 raw_json，§5.1）。键 = `biz_id`（OPEN-1 幂等键）。

```javascript
// 【设计示意非最终实现】OPEN-7 命中标记读写仓储（linked-table-repository.js 新增）
// markBankDepositHits：export 成功后回写命中标记，返回跨期命中明细供提醒注入
//   hitBizIds = 本批以入金表行为命中来源的 BizId 集合；runId = 当期运行标识
function markBankDepositHits(db, hitBizIds, runId, hitAt) {
  const ids = Array.isArray(hitBizIds) ? [...new Set(hitBizIds.map(normalizeKey).filter((x) => x !== ''))] : [];
  const sel = db.prepare('SELECT biz_id, last_hit_run, last_hit_at FROM linked_bank_deposit WHERE biz_id = ?');
  const upd = db.prepare('UPDATE linked_bank_deposit SET last_hit_run = ?, last_hit_at = ? WHERE biz_id = ?');
  const crossPeriodHits = []; // [{ bizId, prevRun, prevAt }]
  db.exec('BEGIN');
  try {
    for (const bizId of ids) {
      const prev = sel.get(bizId);
      if (!prev) continue; // BizId 不在库（理论不应发生，命中来源即库内行）
      // 跨期判定：last_hit_run 非空 ∧ ≠ 当前 runId → 跨期重复命中（同批 run/export 标识相同 → 不误报）
      if (prev.last_hit_run && prev.last_hit_run !== runId) {
        crossPeriodHits.push({ bizId, prevRun: prev.last_hit_run, prevAt: prev.last_hit_at });
      }
      upd.run(runId, hitAt, bizId); // 随后更新为当前标识
    }
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch (_e) {} throw error; }
  return { crossPeriodHits };
}

// clearBankDepositHitsByBizIds：删 BizId 后清理标记（防悬挂，§七删除联动）
function clearBankDepositHitsByBizIds(db, bizIds) { /* UPDATE ... SET last_hit_run=NULL,last_hit_at=NULL WHERE biz_id IN (...) */ }
```

### 6.2 写入时机（7a）：export 成功后回写

🔴🔴 **资金红线 A-4 新增写路径**：在 `bank-statement:export`（`src/main.js:3704`）**主输出成功落盘后**回写命中标记（run 可反复执行不写；export = 用户对该批命中的权威确认）。这是 export → `linked_bank_deposit` 的**新增写路径**（现在 export 会 mutate 该表）。

```javascript
// 【设计示意非最终实现】在 bank-statement:export 主输出 + 退款回填文件落盘成功后、export return 之前回写
// （现状 export handler `src/main.js:3704`，最终 return 在 ~:3911 附近；以「文件落盘成功后、return 前」为准，行号当近似）
// runId = 当期银行对账单导入会话 importedAt（bankStatementSession 无 sessionId 字段，仅 { filePath, fileName, rows, headers, importedAt }，
//   见 `src/main.js:310` 注释 / :3513-3519；importedAt = Date.now()，每次重新导入银行对账单刷新 → 跨期判定成立；
//   export 不刷新 session → 同批多次 export importedAt 相同 → 标识相同不误报）
try {
  const hitBizIds = Array.isArray(processingResult.depositHitBizIds) ? processingResult.depositHitBizIds : [];
  if (hitBizIds.length > 0) {
    const runId = String(bankStatementSession.importedAt);
    const ret = database.markBankDepositHits(hitBizIds, runId, new Date().toISOString());
    // ret.crossPeriodHits 用于提醒注入（已写入主输出 / 退款回填文件前若需追加，则注入提醒——见 6.4）
  }
} catch (e) {
  // 🔴🔴 graceful：标记写入失败不影响导出产物落地（标记是观测增强，非资金数据）
  appendActivityLogEntry({ level: 'warning', message: '[OPEN-7] 命中标记回写失败（不影响导出）', details: [e && e.message ? e.message : String(e)] });
}
```

> ⚠️ **时机细节（提醒注入顺序）**：提醒文案要进**主输出 / 退款回填文件**（§6.4），而文件在 export 内已落盘。两种实现：(a) 先 `markBankDepositHits` 取 `crossPeriodHits` → 再写文件（注入提醒）；(b) 写文件 → 回写标记 → 跨期命中仅记活动日志/下次提醒。**推荐 (a)**：export 内先查跨期命中（只读 `sel`，不更新）→ 写文件注入提醒 → 文件落盘成功后再 UPDATE 标记（命中口径以 export 为权威确认）。实现时把 `markBankDepositHits` 拆为 `peekCrossPeriodHits`（只读查）+ `commitHitMarks`（UPDATE），保证「文件落盘失败则标记不前移」一致性。

### 6.3 命中口径（7b）：所有以入金表为来源的命中

- **现有**：R5 场景4 JPM-US 桥接 `matchJpmUs`（`r5-refund-order-backfill.js:183`）——命中的 `dep` 行（入金表行）即「以入金表为来源的命中」，取其 `BizId` 收集。
- **新增（refund-backfill-rules-v2）**：R3（HK CustomerRef 二跳）/ R5（Drawee+DESC DATE）/ R6（附言原单日期金额）的二跳命中点——**其 hook 由 refund-backfill 落地时一并接入本机制**（跨 spec 契约，spec OPEN-7b / `docs/iterations/v3.0.5/TECH_DESIGN-中台退款订单回填规则增强-v3.0.5.md` §D12）。
- **收集方式**：引擎纯函数（`r5-refund-order-backfill.js`）在 `matchJpmUs` 命中时把 `dep.BizId` 收进返回值的 `depositHitBizIds` 数组上抛 → 编排器（`reconciliation-orchestrator.js`）汇总 → `processingResult.depositHitBizIds`（run 阶段 `src/main.js:3676` processingResult 构造处新增字段）。⚠️ run 不写标记（7a），仅收集；export 才回写。

> 🔴 引擎保持纯函数（不读 DB），命中 BizId 经返回值上抛（与现状 `refundBackfillRows` 上抛同范式，`src/main.js:3688`）。`matchJpmUs`（:183）现状返回 `hits=[{refundRow,detail}]`——扩展为同时上抛命中的 `dep` 行 BizId（或在 hits 项加 `depBizId` 字段）。

### 6.4 提醒出口（提醒文案注入点）

| 命中来源 | 提醒注入点 | 文案 | 本期范围 |
|---------|-----------|------|---------|
| R5 场景4（matchJpmUs 桥接） | **中台退款回填文件**对应回填行的「匹配命中详情」（`r5-refund-order-backfill.js:96` `buildBackfillRow` 的 `匹配命中详情`） | 追加「⚠️ 桥接入金表行 BizId=… 此前于 [last_hit_at] 已被命中，疑似历史残留」 | ✅ **本期落地**（唯一现有入金表来源命中=matchJpmUs，产物是退款回填文件行） |
| refund R3/R5/R6 二跳 + 主对账链 | **主输出「命中明细」**（`exceljs-writer.js:243` `hitHeaders` / :259 `buildHitDetail`，来自 `processingResult.modifications`） | 同款提醒 | ⏳ **预留**（随 refund-backfill-rules-v2 接入；本期 matchJpmUs 命中**不**进主输出命中明细，故本期**不改 `exceljs-writer.js`**——见下方范围说明） |

> 🔴 **本期 T5 范围（避免误扩到 exceljs-writer）**：当前唯一「以入金表为来源」的命中=`matchJpmUs`（`r5-refund-order-backfill.js:183`），其产物是**退款回填文件**行（`buildBackfillRow` `匹配命中详情` :96 → `writeRefundBackfillOutput` `src/main.js:3873`）；主输出「命中明细」sheet（`exceljs-writer.js:243` / `buildHitDetail` :259）数据来自 `processingResult.modifications`，与 matchJpmUs 的 dep 行命中**无关**。故**本期 T5 只注入退款回填文件命中详情**；`exceljs-writer.js` 命中明细注入点是**为 refund R3/R5/R6 二跳预留**（其二跳可能走主链），随 refund-backfill 落地时一并接入。§二涉及文件清单中 `exceljs-writer.js` 列为 T5 改动属预留接口，本期可不实改（实现时确认 matchJpmUs 是否唯一来源后定）。
>
> 实现：export 内 `peekCrossPeriodHits` 得到 `crossPeriodHits`（BizId → {prevRun, prevAt}）→ 传给 `writeRefundBackfillOutput`（`src/main.js:3873`）→ writer 据「行→BizId 映射」对跨期命中行追加提醒文案。退款回填文件命中详情来自引擎 `buildBackfillRow`（:96），把 `crossPeriodHits` 传到 writer 在该列文本后追加（不改引擎纯函数，writer 层注入）。主输出 `writeBankStatementMainOutput`（:3793）/ `exceljs-writer.js` 的注入随 refund 接入。

### 6.5 删 BizId 后标记清理无悬挂

删 bank-deposit 行（§七）→ 同步 `clearBankDepositHitsByBizIds(被删 BizId 集合)`（其实删行即标记随行删，但若按日期删除是 `DELETE FROM ... WHERE bill_date BETWEEN`，行删了标记自然没了——**无悬挂**；专用列随行删，无需额外清理）。⚠️ 真正需注意的是：被删行的 BizId 不再在库 → 下次 export 若 hitBizIds 含已删 BizId，`markBankDepositHits` 的 `sel.get(bizId)` 返回空 → `continue`（§6.1），不误写、不悬挂。

---

## 七、删除扩展（OPEN-4）

### 7.1 IPC tableKey 参数化三表

`count-by-date-range`（`src/main.js:11327`）/ `delete-by-date-range`（:11346）加 `tableKey` 参数（缺省 `gateway-bill` 向后兼容）；白名单 = 三张表（gateway-bill / fx-settlement / bank-deposit），逐表走各自 dateColumn（gateway=bill_date、fx=transaction_date、bank-deposit=bill_date，`linked-table-repository.js:70/88/109`）。仓储 `countGatewayBillByDateRange` / `deleteGatewayBillByDateRange`（:423/:434）参数化为 `countLinkedByDateRange(db, tableKey, start, end)` / `deleteLinkedByDateRange(db, tableKey, start, end)`（复用泛化 `recomputeLinkedMeta`）。ISO 硬守卫（`/^\d{4}-\d{2}-\d{2}$/`，:11334/:11353）+ count 门控保持。

### 7.2 删除后派生联动 🔴🔴（必须一致事务边界，A-7 / spec R-5）

| 删除目标 | 联动 |
|---------|------|
| **fx 行** | 🔴🔴 按被删行的 `transaction_no` 集合**联动删 BOC 表同键行**（⚠️ 不能按日期删 BOC：其日期列是到期日 `maturity_date`，`linked-table-repository.js:130`）→ `resetAndRematchBocFxLink` 全量重匹配 + 重编号（复用 §4.2 第 3/4 步）。实现：`deleteLinkedByDateRange('fx-settlement')` 内先 `SELECT transaction_no WHERE transaction_date BETWEEN` 收集 → DELETE fx 行 → `deleteBocFxLinkByTxnNos(txnNos)` → 重匹配重编号 → 2.4/2.5——**同一事务边界**（禁中间态）。 |
| **bank-deposit 行** | 重建 ADM（`replaceAdmBankDeposit` :598 基于 `readBankDepositAdmCandidates` :552）+ BOC bank 派生（`replaceBocBankDeposit` :841 + 2.5 全量回填 `backfillBocReconLinkIds` :321）+ 清 `processingResult`（:11362）+ `reconIdFixResult`（:11617）+ **OPEN-7 标记随行删除（§6.5，无需额外清理）**。 |
| **gateway-bill 行** | 行为不变（现状 `src/main.js:11357` 删除 + `processingResult = null` :11362）。 |

### 7.3 前端删除弹框

加「目标表」下拉（默认网关；标题随选择切换，现状写死「删除网关对账单数据」`renderer-dialogs.js:6526` 改动态）；其余交互不变（直接删 + 后台 count 门控防误删，gateway OPEN-6 同口径）。成功文案随 tableKey 显示表名。改前端 → 提 PR 前必重跑对应 `npm run preview`（项目约定 workflow_frontend_previews）。

---

## 八、任务分解 T1~T7 + commit 粒度实施计划

| Task | 内容 | 主要文件（≤5/task） | Commit message（建议） |
|---|---|---|---|
| T1 | migration：fx/bank-deposit 键列回填+去重+删空键+UNIQUE；bank-deposit 加 last_hit_run/last_hit_at；BOC 加 orig_group_no + UNIQUE + 清空两派生表 | `migrations.js` | `feat(v3.0.5): linked-fx/bank-deposit 幂等键迁移 + BOC orig_group_no + 清空派生表` |
| T2 | 仓储：upsert 内核泛化 + meta 全表重算泛化 + bank-deposit 双路 upsert + fx 数组 upsert + 删除 count/delete 参数化 | `linked-table-repository.js`、`database.js` | `feat(v3.0.5): 仓储 upsert/meta/删除泛化 + bank-deposit/fx upsert` |
| T3 | 仓储+builder：BOC upsert（orig_group_no）+「重置-重匹配-重编号」读写 + rematch 编排纯函数 + 删 BOC by txnNos | `linked-table-repository.js`、`boc-fx-link-builder.js` | `feat(v3.0.5): BOC upsert + 全量重匹配重编号` |
| T4 | main.js：导入两表换 upsert + fx 派生改全量重算 + 删除扩 tableKey + 派生联动与缓存清理 | `src/main.js`、`src/preload.js` | `feat(v3.0.5): 导入两表换 upsert + fx 全量重算 + 删除三表联动` |
| T5 | OPEN-7：命中标记读写仓储 + export 回写（peek+commit）+ 命中收集（matchJpmUs）+ 场景4/主输出提醒注入 | `linked-table-repository.js`、`src/main.js`、`r5-refund-order-backfill.js`、`exceljs-writer.js` | `feat(v3.0.5): OPEN-7 跨期命中提醒（标记+export回写+提醒注入）` |
| T6 | 前端：导入完成框两表覆盖/拒入提醒 + 删除弹框表选择与文案 + 重跑 preview | `renderer-dialogs.js` | `feat(v3.0.5): 前端导入覆盖提醒 + 删除弹框表选择` |
| T7 | 测试+文档：单测/集成（§九）+ gateway parity 锁 + 三件套 + `/check-vars` | `tests/`、`scripts/integration/`、docs | `test+docs(v3.0.5): 测试矩阵 + 文档三件套` |

> 一 task 一 commit；`src/main.js` 含 NUL，grep `-a`、git diff 显示二进制（参考 reference_mainjs_nul_grep）。提 PR 前 / 版本 bump 前必跑 `/check-vars`（硬节点）。

---

## 九、测试矩阵

### 9.1 单测（`tests/unit/`）

| 维度 | 断言 |
|------|------|
| 仓储 bank-deposit/fx upsert 数组版 | 同键覆盖（1 行且新值）、新键追加、空键拒入计数、overwriteCount 计数、meta 全表重算（rowCount/日期范围） |
| bank-deposit 流式版 | 事务 ROLLBACK（feed 中途 throw → 表保持调用前状态，旧累加完好） |
| 删除参数化三表 | gateway/fx/bank-deposit 各自 dateColumn 闭区间删除 + meta 重算；fx 删除联动删 BOC 同 txnNo 行 |
| migration 幂等可重入 | fx/bank-deposit 存量去重保留 id 最大、删空键、新列回填；BOC 表清空 + orig_group_no；二次跑 no-op |
| 🔴🔴 **fx 交易编号「键真撞」去重显式断言（R-7 资金红线）** | 构造存量两行同 `transaction_no` → migration 后剩 1 行（id 最大）+ `appendModuleLog` 记 delDup=1（日志可见性断言）。R-7 唯一单文件证实，去重日志是真撞键的唯一观测口径，须升为显式断言 |
| builder 组号偏移续编 + 重编号 | scan offset 续编全局不冲突；`rematchAllBocGroups` 按 id ASC 行序重编号 1..N 无空洞 |
| 🔴 **`upsertBocFxLink` 同键覆盖 id 不变（重编号前提）** | 同键二次 upsert 后 `readBocFxLinkRowsWithIds` 的 id 序不变（id ASC 行序稳定）——这是「重编号 1..N 无空洞 + 跨次稳定」的前提（§4.2 第 2 步依赖） |
| builder「重置-重匹配」幂等 | 同输入两次结果一致（candidate consumed 仅单次内存） |
| 跨文件组与中台候选一对一消耗 | 同日同金额不重复回填；2.2 剔除后 `orig_group_no` 不变 |
| OPEN-7 | 同批 run/export（runId 相同）不误报；跨运行标识再次命中产提醒；删 BizId 后 markBankDepositHits 不误写/无悬挂 |
| 🔴🔴 **OPEN-7 export 失败 graceful（AC-T5-1 后半句）** | mock `markBankDepositHits`/`commitHitMarks` throw → 导出产物仍落盘 + 仅 warning 日志（标记是观测增强非资金数据，写入失败不影响导出） |
| 🔴 gateway parity | 泛化重构后 gateway upsert 行为字节不变（既有 v3.0.1 单测全过 = parity 锁，A-6） |

### 9.2 集成（`scripts/integration/`）

| 场景 | 断言 |
|------|------|
| 一批多选 3 个 fx 文件 | 库内容 ≡ 三文件拼接；BOC 表含全部文件组（合并等价性）。⚠️ 断言分两类：① 调拨单号/链接ID **byte 等价**（资金语义硬约束）；② 组号**聚类等价**（同分组成员一致，非数值逐一相等——组号每次重编号，行序通常一致但非定义保证，断言过严锁死实现） |
| fx + bank-deposit + mid 混选导入 | 派生链最终态正确（ADM/BOC fx/BOC bank） |
| 同文件重复导入 | 行数不变（幂等）、overwriteCount = 行数 |
| 删 fx 日期段 | BOC 表联动缩减 + 重匹配后调拨单号正确；删 bank-deposit 日期段 → ADM/BOC bank 重建 + processingResult 清空 |
| OPEN-7 跨期残留 | 跨期残留入金表行作 JPM-US 桥接 → 退款回填文件命中详情含提醒 |

### 9.3 覆盖范围 / 未覆盖

- **覆盖**：合并等价性 + 幂等重导 + 删除联动 + OPEN-7 跨运行提醒 + migration 幂等可重入 + gateway parity 字节不变。
- **未覆盖（原因）**：① 🔴 65 万行级 bank-deposit migration 启动耗时——仅手测（无 CI 大数据集，A-5）；② 多文件并发导入——UI 串行触发无并发入口（spec §七）；③ BOC 修复引擎（`boc-dispatch-order-fix`）自身逻辑零改动，靠既有 25 案锁定；④ mid 导入不触发重算（契约④）维持，不新增案。

---

## 十、与 refund-backfill 协调 + 风险清单

### 10.1 与 refund-backfill-rules-v2 协调

- **代码顺序**：本 change（linked-fx）为硬前置，先实施（spec 状态行 / OPEN-7 拍板）。
- **OPEN-7b 跨 spec 契约**：refund-backfill-rules-v2 新增 R3/R5/R6 二跳的「入金表为命中来源」入口，其命中点 hook 由 refund-backfill 落地时接入本机制（调本 change 提供的命中 BizId 收集 + `markBankDepositHits`）。本 change 先把机制骨架（命中收集字段 `depositHitBizIds` + 标记仓储 + export 回写 + 提醒注入）落地，refund-backfill 接 R3/R5/R6 命中点即可（见 `docs/iterations/v3.0.5/TECH_DESIGN-中台退款订单回填规则增强-v3.0.5.md` §D12）。
- **同版本 v3.0.5**：与 size-startup-optimization 剩余 Phase 同发；文档三件套统一更新（项目约定 workflow_docs_update）。

### 10.2 风险清单（🔴 需人工复核，对应 spec §四）

| # | 风险 | 缓解 |
|---|------|------|
| R-1 🔴🔴 | bank-deposit BizId 非行级唯一 = 静默丢数据 | 实施前抽样核 BizId 重复率；migration 去重 + 去重日志；overwriteCount 异常大 = 键选错信号（§三 A-1） |
| R-2 🔴🔴 | BOC 调拨单号全量重算语义变化（OPEN-5 已接受） | 任意 fx 导入刷新历史组调拨单号 + 组号每次重编号；CHANGELOG/USER_GUIDE 契约说明（§四 A-3） |
| R-3 🔴 | fx 合计行去留 = 主表不再留底 | 拒入合计行（交易编号归一为空）；主表无 DB 消费方（spec §1.3-2），影响仅 meta 行数与 raw_json 留底 |
| R-4 🔴 | 累加后跨期数据进入对账引擎 | 三重缓解：OPEN-7 跨期命中提醒 + 删除按日期范围 + 用户操作规范；读取口径不收窄（spec §3.5-3） |
| R-5 🔴🔴 | 删除不可逆扩两表 + 派生联动 | 复用 gateway ISO 硬守卫 + count 门控；派生联动与删除一致事务边界，禁中间态（§七 A-7） |
| R-6 🔴 | migration 触碰 65 万行存量 | bank-deposit 全 SQL 侧 + 单事务 + 幂等可重入；启动耗时手测（§五 A-5） |
| R-7 🔴🔴 | fx 交易编号唯一性仅单文件证实 | migration 去重保留 id 最大 + 去重日志可见；upsert 同键覆盖保留最新（§五 A-2） |
| R-8 🔴🔴 | OPEN-7 export 新增回写链接表写路径 | 标记写入 graceful（失败不影响导出产物，标记非资金数据）；删除联动清理被删 BizId 标记防悬挂（§六 A-4） |

### 10.3 重要变量影响（check-vars 预备）

预计触及 `rules/important-variables.md`：`replaceLinkedTable` / `replaceLinkedTableStreaming`（落库语义旁路新增 upsert，本身不变）、`linked_fx_settlement` / `linked_bank_deposit` 表结构（+幂等键列+UNIQUE+OPEN-7 专用列）、`linked_boc_fx_settlement`（+orig_group_no+UNIQUE，`important-variables.md:910` BOC 隐藏表条目）、`buildGatewayUpsertContext` / `recomputeGatewayMeta`（泛化重构）、`countGatewayBillByDateRange` / `deleteGatewayBillByDateRange`（参数化）、`matchBocToMidAllocation` / `scanFxGroups`（重匹配入口）、`matchJpmUs`（OPEN-7 命中收集）、`readLinkedTableRows('bank-deposit')`（消费方不变）、`processingResult` / `reconIdFixResult`（删除/导入联动清空）。实施提 PR 前必跑 `/check-vars`（硬节点）。

---

## 十一、变更记录

- 2026-06-15：初稿（实现蓝本）。基于 spec `changes/linked-fx-bank-deposit-merge-import/spec.md`（✅ OPEN-1~7 全闭环）+ v3.0.1 网关先例细化。所有现状描述带 file:line；🔴🔴 资金红线段落高亮；代码示例标「设计示意非最终实现」。
- 2026-06-15（三视角定稿评审修订）：
  - 🔴 **§1.1 / §4.1 fx 空键判据统一为「交易编号归一为空」**（已与回写后的 spec §3.2.1 对齐）：补充「fx 主表无调拨单号列」（`table-signatures.js:141-147`）的代码实证，删除「与 spec『调拨单号空』等效」表述（spec 已不再用此措辞）。
  - 🔴 **§6.2 runId 删除不存在的 `bankStatementSession.sessionId`**：`bankStatementSession` 仅 `{filePath,fileName,rows,headers,importedAt}`（`src/main.js:310`/:3513-3519），直接用 `String(bankStatementSession.importedAt)`；export 不刷新 session → 同批不误报、重导刷新 importedAt → 跨期判定成立。export 写回行号 `:3888` 修正为「文件落盘成功后、return（~:3911）前」近似口径。
  - 🔴 **§五开头事务边界自纠**：原写「三块均在 ensureLinkedTableSupport 单事务」，实为 fx/bank-deposit 在 `ensureLinkedTableSupport`（独立事务）、BOC 块在 `ensureBocFxLinkSupport`（`:2965` 独立事务），两事务非原子，靠 `hasColumn`（`:10`）幂等可重入兜底（与 §5.3 对齐）。
  - 🔴 **§6.4 / §二 收敛 OPEN-7 本期范围**：本期唯一入金表来源命中=matchJpmUs（产物=退款回填文件行），主输出命中明细注入点（`exceljs-writer.js:243`）是 refund R3/R5/R6 预留，本期可不实改 `exceljs-writer.js`（避免 T5 范围误扩）。
  - ➕ **§九测试矩阵补 3 条显式断言**：fx 交易编号键真撞去重（R-7，delDup=1 + 日志可见）；`upsertBocFxLink` 同键覆盖 id 不变（重编号前提）；OPEN-7 export 失败 graceful（AC-T5-1 后半句）。
  - ➕ **新增 §4.4 累加后 BOC 全量重匹配内存/复杂度上界**（资金红线相邻）：行数万级以内 / 内存 MB 级 / 最坏 O(n×m)，可接受但手测观察。
  - ➕ **§九集成 AC-X-1 组号断言放宽**：调拨单号/链接ID byte 等价（硬约束）+ 组号聚类等价（非数值逐一相等，因每次重编号）。

---

## 十二、实施记录（实现细节 / 数据流 / 契约 / 测试矩阵 / codex 审查修复）

> 本节为 dev 实施过程的技术沉淀（team-lead 要求边实施边回写），记录已落地批次的**关键实现 + file:line + 数据流/契约 + 测试矩阵 + codex 对抗审查修复**。所有 file:line 对照工作区未提交 `git diff` 核实（截至 2026-06-15）。
>
> **实施状态：进行中**。已完成：批次1（bank-deposit upsert）/ 批次2a（fx upsert）/ 批次2b（BOC 全量重算）/ 前端导入提醒泛化（T6 子项）/ 批次3（OPEN-7）/ 批次4 T6a（仓储删除三表化）/ 批次4 T6b-1（派生重建 helper 抽取，导入侧已接 parity）。**进行中/待实施**：T6b-2（删除侧复用 helper + 删除 handler 路由）/ T6c（前端删除弹框）/ 批次5（gateway parity 锁 + 集成补齐 + 文档三件套 + `/check-vars`）。
>
> **测试现状**：`npm run test:unit` 全程递增全绿——`2511 → 2519`（T5a）`→ 2542`（T5b-1）`→ 2547`（T5b-2）`→ 2548`（T5c）`→ 2561`（T6a）；T6b-1（parity 抽取）单测数不变仍 **2561/2561 PASS**（`logs/unit-tests/unit-20260615-135943.log` 实测，exit=0，155 文件）；smoke 全过。

### 12.1 仓储 upsert/meta/删除「泛化内核」落地（T2，`linked-table-repository.js`）

实现与 §三/§五设计骨架一致，落地函数与行号：

| 设计目标 | 落地函数（file:line） | 关键实现 |
|---|---|---|
| upsert 内核泛化 | `buildLinkedUpsertContext(db, tableKey, { keyExtractor, idKeyColumn }, importedAt)`（`linked-table-repository.js:381`） | 由 `buildGatewayUpsertContext` 提炼为参数化；`INSERT (idKeyColumn, keyColumn, dateColumn, raw_json, imported_at) ON CONFLICT(idKeyColumn) DO UPDATE`（不写 idKeyColumn 本身）；先 `existsStmt` SELECT 判 INSERT/UPDATE 计 `overwriteCount`；`normalizeKey(keyExtractor(obj))===''` 空键拒入计 `rejectedEmptyCount` |
| gateway parity 薄封装 | `buildGatewayUpsertContext`（`:419` 区，委托）/ `recomputeGatewayMeta` / `countGatewayBillByDateRange` 均改为薄封装委托泛化内核 | `keyExtractor=(o)=>o.ReconBillBizId, idKeyColumn='recon_bill_biz_id'` → 行为字节不变（既有 v3.0.1 单测 parity 锁） |
| meta 全表重算泛化 | `recomputeLinkedMeta(db, tableKey, ...)`（`:418`） | `COUNT(*)` 全表 + `MIN/MAX(dateColumn)` 排除 null/空串 |
| 删除 WHERE 单一真相 | `buildDateRangeWhere(dateColumn)`（`:457`） | 纯 `dateColumn BETWEEN ? AND ?`（count 预览与 delete 实删共用 → 预览=实删；🔴 不加 `IS NOT NULL` 以严守 gateway parity 字节不变） |
| 删除 count 泛化 | `countLinkedByDateRange(db, tableKey, ...)`（`:463`）+ `countFxByDateRange` / `countBankDepositByDateRange` 封装 | 三表共用 |
| bank-deposit 双路 upsert | `upsertLinkedBankDeposit`（`:697`）/ `upsertLinkedBankDepositStreaming`（`:738`，async 单事务跨 await） | `keyExtractor=(o)=>o.BizId, idKeyColumn='biz_id'`；流式版结构照抄网关流式（去 DELETE、insertOne→upsertOne、meta 全表重算）保 65 万行内存恒定 + throw→ROLLBACK |
| fx 数组 upsert | `upsertLinkedFx`（`:875`，仅数组版） | `keyExtractor=(o)=>normalizeTransactionNo(o['交易编号']), idKeyColumn='transaction_no'` |

**与设计的实现差异（已沉淀 backlog B17）**：§4.1 设计示意建议 `normalizeTransactionNo` 下沉到无依赖工具模块（单一真相）——实施采纳：下沉到 `engine-utils.js:37`，`migrations.js` / `linked-table-repository.js` / `boc-fx-link-builder.js` 三处 require 同一份（builder 仍 re-export 保既有单测口径）。但 fx 的 `idKeyColumn===keyColumn===transaction_no` → 泛化内核拼出 `INSERT (transaction_no, transaction_no, ...)` 重复列名，实测 node:sqlite 容忍且第 1 个值生效 → 当前正确但依赖未文档化行为（🔴 资金红线脆弱点，B17，本期不改）。

### 12.2 OPEN-7 命中标记读写仓储（T5a，`linked-table-repository.js`）

- `HIT_MARKER_READ_CHUNK = 900`（`linked-table-repository.js:152` 区）：< SQLite 旧版 `SQLITE_MAX_VARIABLE_NUMBER=999` 留余量，命中标记读 + fx 联动删 BOC 的 IN 分批共用。
- `readBankDepositHitMarkers(db, bizIds)`（`:789`）：bizIds 归一去空去重 → 按 chunk 分批 `SELECT biz_id, last_hit_run, last_hit_at WHERE biz_id IN (...)` → 合并 `Map<bizId,{last_hit_run,last_hit_at}>`（只读标记列，不反序列化 raw_json）。
- `markBankDepositHits(db, bizIds, runId, atIso)`（`:814`）：单事务批量 `UPDATE ... SET last_hit_run/last_hit_at WHERE biz_id=?`，仅 UPDATE 已存在行（缺失 BizId `.changes=0` no-op，不凭空造行）。
- `clearBankDepositHitMarkersByBizIds(db, bizIds)`（`:837`）：批量置 NULL（**本批只交付函数不接线**，删除联动 T6b-2 接入）。
- 🔴 契约隔离：三函数只读/置标记列，绝不碰 raw_json/biz_id；`buildLinkedUpsertContext` ON CONFLICT SET 硬编码 4 列（keyColumn/dateColumn/raw_json/imported_at）不含标记列 → 重导覆盖同 BizId 时 `last_hit_*` 保留不被洗。facade 转发见 `database.js`（`upsertLinkedBankDeposit`/`upsertLinkedFx`/`readBankDepositHitMarkers`/`markBankDepositHits`/`clearBankDepositHitMarkersByBizIds`）。

### 12.3 migration 三块（T1，`migrations.js`，与 §五设计一致）

| 块 | 位置 | 实现要点 |
|---|---|---|
| fx 主表键 | `ensureLinkedTableSupport` 内（`migrations.js:2938` 日志锚点） | **JS 层全表读**（交易编号 number 须 `normalizeTransactionNo` 归一，SQL `json_extract` 取数有量纲歧义）→ 删空键 + 去重保留 id 最大 → 建 UNIQUE `idx_linked_fx_settlement_txn_uniq`（新名，不复用普通索引 `idx_linked_fx_settlement_no`）；幂等守卫用 `PRAGMA index_list` 查 UNIQUE 是否存在；清洗 `appendModuleLog(warning)` + 同步 `linked_table_meta` |
| bank-deposit 键 | `ensureLinkedTableSupport` 内（`:2989` 日志锚点） | **全 SQL 侧**（65.7 万行）：`ALTER ADD biz_id` → `UPDATE SET biz_id=TRIM(json_extract(raw_json,'$.BizId'))`（与 `normalizeKey` 字节一致）→ 删空键 + 去重保留 MAX(id) → UNIQUE `idx_linked_bank_deposit_biz`；`hasColumn('biz_id')` 守卫整块；清洗 `appendModuleLog(warning)` + 同步 meta |
| bank-deposit OPEN-7 列 | `:3013`/`:3014` 附近 | `last_hit_run`/`last_hit_at` 两 `ALTER ADD COLUMN`，各自 `hasColumn` 守卫；🔴 不进任何 UNIQUE、不动 raw_json |
| BOC 派生 | `ensureBocFxLinkSupport` 内（独立事务，`:3122` 日志锚点） | 加 `orig_group_no` + `idx_..._orig_group` 普通索引 + OPEN-3 清空两表（守卫①③绑 `hasColumn('orig_group_no')`）；UNIQUE `idx_linked_boc_fx_settlement_txn_uniq`（`:3138`）走**独立 `PRAGMA index_list` 守卫**（I3 自愈，见 §12.4） |

### 12.4 批次2b：BOC「增量进组 + DB 全量重匹配 + 重编号」(T3，仓储 + builder + main 编排)

**数据流（导入侧，`main.js:11619-11646` fx-settlement 分支）**：
```
getMaxBocFxOrigGroupNo()  // offset = MAX(CAST(orig_group_no AS INT))（linked-table-repository.js:1200）
  → scanFxGroups({ objects, rowNumbers, offset })  // 组号续编 += offset，写「分组」+ __origGroup（boc-fx-link-builder.js:82）
  → upsertBocFxLink(scan.rows)  // 按 transaction_no 幂等进库，同键覆盖 id 不变（:1217）
  → rebuildFxBocDerivation(deps, { scanLogs, groupCount, overwriteCount })  // T6b-1 抽取，见 §12.7
       内部：readBocFxLinkRowsForRematch()  // 全库 id ASC，从热列注入 __origGroup/__maturityIso（:1294）
            → rematchAllBocGroups(allRows, midRows)  // 重编号 + 重跑 2.2/2.3（boc-fx-link-builder.js:270）
            → writeBocFxLinkGroupRematch(allRows)  // 按 id 回写 group_no/allocation_no + raw_json（:1318）
            → 2.4 buildBocBankRows + replaceBocBankDeposit → 2.5 backfillBocReconLinkIds + writeBocFxLinkReconIds（照旧）
```

**关键契约**：
- `orig_group_no`「永不被 2.2/2.3 改写」指 `rematchAllBocGroups` 不改它（**可由 upsert 同键覆盖更新**——同交易编号重导时物理分组以最新文件为准，与主表 fx upsert 同键覆盖语义一致）。
- `readBocFxLinkRowsForRematch` 从热列注入 `__maturityIso`（raw_json 已剥此键）：🔴 `matchBocToMidAllocation` 的 2.2/2.3 日期匹配热依赖此键，不从热列恢复则全库重匹配日期恒不命中 = 调拨单号全空（资金事故）。
- `rematchAllBocGroups`（`boc-fx-link-builder.js:270`）四步：① 按 `__origGroup` 行序（id ASC）重编号消除空洞；② 重置「分组」=重编号组号、「调拨单号」=''；③ 重跑 `matchBocToMidAllocation`（逻辑零改动）；④ M4 compact（见下）。
- `writeBocFxLinkGroupRematch` 仅回写 group_no/allocation_no + raw_json，**不碰** transaction_no/orig_group_no/maturity_date/source_row/recon_link_id（recon_link_id 由 2.5 负责）。

**🔴 codex 对抗审查发现并修复 4 问题**：

| 编号 | 级别 | 问题 | 修复（file:line） |
|---|---|---|---|
| C1 | Critical | 跨文件分组等价性存疑（per-file scan 是否与「拼成大文件」等价） | **确认实现正确**（真实导出文件均含 footer/合计行作组边界，per-file scan + offset 续编等价）；仅补「无 footer 裸文件分别 scan → 2 独立组」防回归边界测（`boc-fx-link-builder.test.js`） |
| I2 | Important | `replaceBocFxLink`（保留的旧整表覆盖函数，删除联动会用）与新 schema 不兼容（缺 orig_group_no/UNIQUE） | 升级为 `INSERT OR REPLACE` 9 列含 `orig_group_no`（无则回退「分组」防 NULL 坍缩）+ 空键拒入 + last-wins（`linked-table-repository.js:1131`） |
| I3 | Important | BOC migration 三件事同绑 `hasColumn(orig_group_no)` 守卫 → 半迁移态（已加列缺 UNIQUE）跳过补建 UNIQUE | 列添加+OPEN-3 清空绑 `hasColumn`；UNIQUE 用独立 `PRAGMA index_list` 守卫自愈（`migrations.js:3138` 区） |
| M4 | Minor | 2.2 清空单行组「分组」留组号空洞（展示组号不连续） | `rematchAllBocGroups` 步④：2.2/2.3 后对「分组非空」行按 id ASC 首现序 compact 重映射 1..M（只改展示「分组」，不碰 orig_group_no/调拨单号/匹配逻辑，`boc-fx-link-builder.js:270` 步4） |

### 12.5 批次3：OPEN-7 跨期命中提醒（T5，引擎纯函数 + 接线 + 提醒注入）

**T5b-1 引擎侧（`r5-refund-order-backfill.js`，保持纯函数不读 DB）**：
- 命中收集：`matchJpmUs`（`:223`）命中 hit 附 `_depositBizId = normalizeBizIdKey(dep.BizId)`（`:92`，下划线内部字段不进对外回填模板列）；`consumeAndBackfill`（`:626`）把带 `_depositBizId` 的 hit 收进 `ctx.hitDepositBizIdSet`（去重 Set，S1/S4 等非入金表来源 hit 无此字段天然不污染）；`runRound5RefundOrderBackfill`（`:329`）两条 return 路径均返回 `hitDepositBizIds: [...Set]`（早退路径 `[]`）。
- 回填行标记：`buildBackfillRow(refundRow, bankRow, detailText, bridgeDepositBizId)`（`:126`）非空时挂内部字段 `_bridgeDepositBizId`（T5b-2 据此精确定位注入行）。
- 纯函数三件（供 main 在 export 阶段 require）：`normalizeBizIdKey`（`:92`）/ `buildStaleHitReminder(bizId, lastHitAt)`（`:98`，文案「⚠️ 桥接入金表行 BizId=… 此前于 [..] 已被命中，疑似历史残留」）/ `pickStaleHits(hitBizIds, markerMap, runId)`（`:108`，判定：marker.last_hit_run 非空 ∧ `String(last_hit_run)!==String(runId)` → 入选；== runId 同批不报；空/未命中首次不报）。
- 透传：`reconciliation-orchestrator.js`（声明 `:296`、`r5d.hitDepositBizIds` 透传 `:311`、顶层 `refundHitDepositBizIds` 返回 `:343`）冒泡（无 R5s4/无桥接命中 → `[]`）。

**T5b-2 接线侧（`main.js`）——🔴🔴 export 三步严格时序**：
- run handler（`main.js:3707/3708`）：`processingResult` 新增 `refundHitDepositBizIds: result.refundHitDepositBizIds || []` + `runId: bankStatementSession.importedAt`（同批 run/export 稳定，重导刷新 → 跨期判定成立；`bankStatementSession` 无 sessionId，用 importedAt）。
- export handler（`main.js:3880-3963`）三步：
  1. **写盘前判定+注入**（`:3899-3925`）：`open7HitBizIds` 取 `processingResult.refundHitDepositBizIds` → `database.readBankDepositHitMarkers(open7HitBizIds)`（读**旧** marker）→ `pickStaleHits(..., processingResult.runId)` → 命中行 `row['匹配命中详情']` **append**（不覆盖）`buildStaleHitReminder`；整块局部 try/catch，成功置 `open7Markable=true`，失败仅 warning + `open7Markable=false`（不抛到 export 外层）。
  2. **写盘**（`:3945` 区 `writeRefundBackfillOutput`，得 `refundBackfillReport`）。
  3. **写盘后回写**（`:3957`）：`if (open7Markable && refundBackfillReport && open7HitBizIds.length>0)` 才 `database.markBankDepositHits(..., String(runId), new Date().toISOString())`；try/catch 仅 warning。
- `exceljs-writer.js:210/263` 出口②预留可选参数 `staleHitNotesByRowId`（默认 null，本期 main 不传 → 命中明细 golden 字节不变，parity 锁；为 refund R3/R5/R6 二跳预留）。

**🔴 codex 对抗审查发现并修复 3 问题**：

| 级别 | 问题 | 修复（file:line） |
|---|---|---|
| Critical | 退款文件写失败仍 mark → 用户同批重试时 marker 已=当前 runId，`pickStaleHits` 不再报，跨期提醒永久丢失 | 回写条件加 `refundBackfillReport` 非 null（产物成功落盘）：`open7Markable && refundBackfillReport` 才推进 runId（`main.js:3957`） |
| Important | marker 读取 unguarded + IN 参数上限风险 | 仓储 `readBankDepositHitMarkers` 内 chunk ≤900 分批（`linked-table-repository.js:789`）+ export 判定块局部 try/catch 不阻断 export（`main.js:3902` 区） |
| Minor | 注入直接 mutate `processingResult.refundBackfillRows` 缓存行 → append 非幂等（重 export 重复追加同一提醒） | 导出前浅拷贝 `processingResult.refundBackfillRows.map((r)=>({...r}))`（`main.js:3886` 区）再注入 |

**OPEN-7 子项口径**：7a = export 成功后写标记（run 不写）；7b = 以入金表为来源命中（本期 `matchJpmUs`，R3/R5/R6 hook 待 refund-backfill 接入）；7c = 专用列 `last_hit_run`/`last_hit_at`。

### 12.6 批次4 T6a：仓储删除三表化（`linked-table-repository.js`，已完成）

- `countLinkedByDateRange`（`:463`）泛化 + gateway 薄封装委托（parity）+ `countFxByDateRange`/`countBankDepositByDateRange` 封装。
- `deleteBankDepositByDateRange(db, startDate, endDate)`（`:524`）：单事务；**删前同事务** `SELECT biz_id WHERE bill_date BETWEEN` → `deletedBizIds`（normalizeKey 去空去重，供 T6b-2 清 OPEN-7 命中标记 + 派生重建）→ DELETE → `recomputeLinkedMeta` 全表重算；返回 `{ deleted, deletedBizIds, rowCount, ... }`。
- `deleteFxByDateRange(db, startDate, endDate)`（`:566`）：单事务；删前 `SELECT transaction_no` → `deletedTxnNos` → DELETE fx 主表 → 🔴 **联动删 BOC**（`DELETE FROM linked_boc_fx_settlement WHERE transaction_no IN (...)` 按交易编号、chunk ≤`HIT_MARKER_READ_CHUNK`、**绝不按 maturity_date/日期**）→ `recomputeLinkedMeta`；**删主表 + 删 BOC 同一事务**（中途 throw 全 ROLLBACK，禁「删主表、BOC stale」中间态）；返回 `{ deleted, deletedTxnNos, bocDeleted, ... }`。
- 🔴 边界：本批只删 BOC 行；删后 BOC「全量重匹配 + 重编号」编排在 **T6b-2（进行中）**。facade 转发见 `database.js`（`countFxByDateRange`/`countBankDepositByDateRange`/`deleteFxByDateRange`/`deleteBankDepositByDateRange`）。

### 12.7 批次4 T6b-1：派生重建 helper 抽取（`linked-derive-rebuild.js` 新增，导入侧已接 parity）

> 🔴 spec §3.1/§3.2 明令「禁止复制粘贴第二份」（防资金口径漂移）。为给 T6b-2「删除联动复用」做准备，**先把导入 handler 内联的派生逻辑抽成共享纯编排函数**（依赖注入，便于单测），本批只改导入侧调用（行为字节不变 parity），删除侧接入在 T6b-2。

- 新文件 `src/main-process/linked-derive-rebuild.js`（untracked），3 个依赖注入纯编排函数：
  - `rebuildAdmDerivation(deps)`（`:41`）：ADM 派生（bank-deposit/mid-allocation 共享）。
  - `rebuildBankDepositBocDerivation(deps)`（`:88`）：BOC bank 派生（2.4）+ 2.5 全量回填。
  - `rebuildFxBocDerivation(deps, ctx)`（`:156`）：fx 派生的**全量重匹配重编号 + 2.4 + 2.5 + 统计**（不含进组步）。
- 导入侧接线（`main.js:127` 区 require + fx 分支 `:11633` 调 `rebuildFxBocDerivation`）：进组步（`getMaxBocFxOrigGroupNo` + `scanFxGroups` + `upsertBocFxLink`）**留 caller**（导入专属）；重匹配链入共享函数。
- 🔴 边界约束（保持 caller 分工）：`reconIdFixResult=null` / `processingResult=null` **留导入 caller**（不进共享函数——删除场景清缓存口径可能不同）；各函数内部保留 try/catch 隔离（派生任一步抛错记 `created:false`，不向外抛、不阻断导入/删除本身）。
- parity 验证：`npm run test:unit` 抽取后单测数不变仍 **2561/2561 PASS**（行为字节不变）。
- ⏳ **T6b-2（进行中）**：删除 handler（`main.js` count/delete IPC 扩 `tableKey`）+ 删除后调 `rebuildFxBocDerivation`（fx，从「读全库行重匹配」起，BOC 行已被 T6a 联动删）/ `rebuildAdmDerivation`+`rebuildBankDepositBocDerivation`（bank-deposit）+ caller 清 `processingResult`/`reconIdFixResult` + `clearBankDepositHitMarkersByBizIds(deletedBizIds)`。

### 12.8 前端导入完成框提醒泛化（T6 子项，`renderer-dialogs.js`）

- `buildImportSummaryHtml` 内 `IDEMPOTENT_IMPORT_TIPS` 数组驱动（`renderer-dialogs.js:6286` 区）：从 gateway-only 泛化为三表（gateway-bill→ReconBillBizId / bank-deposit→BizId / fx-settlement→交易编号），逐表 filter `status==='ok'` 聚合 `overwriteCount`/`rejectedEmptyCount`，>0 才各自弹「覆盖 N / 拒入 N」。
- 🔴 gateway 文案字节不变（提醒标题/键名/句式与 v3.0.1 先例一致，parity）。⏳ 删除弹框「目标表」下拉在 T6c（进行中，提 PR 前须重跑 `npm run preview`）。

### 12.9 测试矩阵实测（已落地单测文件）

新增/修改单测文件（`tests/unit/`，与 §九设计矩阵对应）：

| 文件 | 覆盖 |
|---|---|
| `backend/database/linked-bank-deposit-upsert.test.js` | bank-deposit 数组/流式 upsert：同键覆盖、新键追加、空键拒入计数、meta 全表重算、流式 ROLLBACK |
| `backend/database/linked-fx-settlement-upsert.test.js` | fx 数组 upsert：交易编号归一为空拒入、同键覆盖、meta 重算 |
| `backend/database/linked-bank-deposit-hit-markers.test.js` | OPEN-7：read/mark/clear；同批 runId 不误报、跨 runId 报、缺失 BizId no-op |
| `backend/database/linked-bank-deposit-delete-by-range.test.js` | bank-deposit 按日期删除 + deletedBizIds |
| `backend/database/linked-fx-settlement-delete-by-range.test.js` | fx 按日期删除 + 联动删 BOC（transaction_no IN）+ deletedTxnNos |
| `backend/database/linked-table-boc-rematch.test.js` | upsertBocFxLink 同键覆盖 id 不变 / getMaxBocFxOrigGroupNo / readBocFxLinkRowsForRematch / writeBocFxLinkGroupRematch |
| `backend/database/migrations-linked-bank-deposit-biz-key.test.js` | bank-deposit 键迁移：回填/删空键/去重保留 id 最大/UNIQUE/幂等可重入 |
| `backend/database/migrations-linked-fx-settlement-txn-key.test.js` | fx 键迁移（含键真撞去重 + 日志）+ 幂等可重入 |
| `backend/database/linked-table-boc.test.js`（改） | replaceBocFxLink I2 升级（orig_group_no/INSERT OR REPLACE/空键拒入）适配 |
| `main-process/boc-fx-link-builder.test.js`（改，+167 行） | scanFxGroups offset 续编；rematchAllBocGroups 重编号 1..N/幂等/M4 compact 连续；C1 无 footer 裸文件 2 独立组边界 |
| `main-process/scenario-engines/r5-refund-order-backfill-open7-hits.test.js` | matchJpmUs 命中收集 _depositBizId / pickStaleHits 判定 / buildStaleHitReminder 文案 / S1·S4 不污染 |
| `main-process/exceljs-writer-open7-stale-hit-note.test.js` | 出口②可选参数：传 null 字节不变（parity）、传 Map 时 append 注入 |

🔴 资金红线显式断言已落（与 §九矩阵补充项一致）：fx 交易编号键真撞去重（delDup=1 + 日志可见）；`upsertBocFxLink` 同键覆盖 id 不变（重编号前提）；OPEN-7 export 失败 graceful（mark throw → 产物仍落盘 + 仅 warning）。

**测试现状**：`2511 → 2519 → 2542 → 2547 → 2548 → 2561`（T6a）；T6b-1 parity 抽取后仍 `2561/2561 PASS`（`logs/unit-tests/unit-20260615-135943.log`，exit=0）；smoke 全过。**未覆盖（设计已述）**：65 万行 migration 启动耗时（手测）、多文件并发（无入口）、BOC 修复引擎逻辑（既有 25 案锁）、mid 不触发重算（契约④）。

### 12.10 实测验证记录（OPEN-7 第一期 export，🔴 资金红线观测）

- 第一期 export 实测：`matchJpmUs` 桥接命中 **47 个入金表行**并正确写 `last_hit_run` 标记（验证 7a「export 成功后写标记」+ 7c 专用列落地）。
- 退款回填文件 **65 命中 = 47 入金表桥接（CustomerRef，带 OPEN-7 标记）+ 18 S4 模糊（BillDate，非入金表来源不标记）**——印证 7b 命中口径精确：仅「以入金表为来源」的 `matchJpmUs` 桥接行写标记，S4 模糊命中（非入金表来源）不写标记，`_depositBizId` 字段的「来源精确性」契约在端到端真实数据上成立。

### 12.11 实施期 backlog 沉淀（`knowledge/backlog.md`）

| 编号 | 内容 | 性质 |
|---|---|---|
| **B17**（P2） | `buildLinkedUpsertContext` 给 fx 拼出重复列名 SQL（`idKeyColumn===keyColumn===transaction_no`）；实测 node:sqlite 容忍且第 1 个值生效 → 当前 fx 幂等正确但依赖未文档化行为（容忍重复列名 + 取第 1 值）。推荐 `idKeyColumn===keyColumn` 时去重拼列；触发：下次动 `buildLinkedUpsertContext` / fx upsert 时收敛 | 🔴 资金红线脆弱点 |
| **B18**（P3） | 导入 fx rematch BOC 链接表后未清 `reconIdFixResult`（BOC 修复结果可能 stale）；**OPEN-4 删除 fx 已做对**（联动后清 `reconIdFixResult`），导入 fx 既有缺口未修（边缘场景：BOC 修复 + fx 导入交错）。export reconIdFix snapshot 只校 scenarios 不校 BOC 链接表 → 不被动清。推荐导入 fx 派生块成功后清 `reconIdFixResult`（与删除 fx 对齐） | 边缘场景缺口（非本期引入） |

> §10.2 风险清单 R-1（BizId 行级唯一）/ R-7（fx 交易编号唯一性）/ R-2（BOC 重算语义）/ R-8（export 写路径）均已在实现中落缓解（migration 去重保留 id 最大 + 日志可见；export graceful try/catch + refundBackfillReport 门控）；R-5（删除派生联动一致事务边界）在 T6a 仓储层已落（fx 删主表+删 BOC 同事务），handler 层联动在 T6b-2（进行中）。
