# Spec — R5-2 调拨回填「覆盖非空原值告警」移除

> 状态：**✅ 已实施**（代码 + 单测已改，该引擎单测 30/30 pass）｜ 来源分支：`v3.0.0` ｜ 目标版本：**3.0.1**（2026-06-09 收口进 v3.0.1 迭代，PRD 需求5）
> 性质：🔴 **资金红线引擎**（R5 场景2「中台调拨订单对账ID回填」），但本次**仅移除一条 warning，覆盖行为零改动**。
> 缘起：用户 2026-06-09 在梳理「资金对账数据处理各功能报错条件」后，要求去掉 `reconid-overwrite-backfill`（覆盖非空原值告警）。

---

## 〇、需求（用户 2026-06-09 拍板）

去掉 R5-2 引擎在「回填命中行、且银行行 `ReconciliationId` 原值非空被网关值覆盖」时产生的 `reconid-overwrite-backfill` warning。

| 项 | 用户决策 |
|---|---|
| 覆盖行为 | **只删告警，覆盖照旧** —— 命中时仍把网关 `reconciliationid` 覆盖进银行 `ReconciliationId`（含非空原值），仅不再产生 warning |
| 其它选项（未采纳） | ❌「删告警 + 非空不覆盖」（改回填语义）；❌「不进列表仅写日志」（保留可审计） |

---

## 一、现状根因（改前，代码事实带出处）

`src/main-process/scenario-engines/r5-fund-transfer-backfill.js` 回填命中处（改前 line 142-156）：

```js
const nv  = normalizeCellValue(gw && gw.reconciliationid);   // 网关待回填值
const old = normalizeCellValue(chosen.ReconciliationId);     // 银行行原值
if (nv !== '' && old !== nv) {
  if (old !== '') {
    // 原值非空被覆盖 —— 与 C1/C3 一致：发 warning 但仍执行覆盖
    warningCollector.push({ rowId: chosen._rowId, code: 'reconid-overwrite-backfill', phase,
      message: `银行行 ReconciliationId 原值「${old}」非空，被网关回填值「${nv}」覆盖（${phase}）` });
  }
  chosen.ReconciliationId = nv;
  modCollector.record(chosen._rowId, 'ReconciliationId', old, nv);
}
```

- 该 warning 仅在「覆盖**非空**原值」时产生；原值为空的正常回填不告警。
- 告警之后**仍执行覆盖**（push 与覆盖动作不互斥）。

引用范围（全 repo grep `reconid-overwrite-backfill`，仅 2 文件命中）：
- `r5-fund-transfer-backfill.js`：文件头 `@returns` 注释 warnings 清单（line 96）+ 实际 push（line 149）。
- `tests/unit/.../r5-fund-transfer-backfill.test.js`：用例 ⑦（line 349-365）断言「发该 warning 但仍写入」+ 文件头注释（line 11）。

---

## 二、改动方案（已落地，2 文件 4 处）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `r5-fund-transfer-backfill.js` 回填命中处 | 删掉 `if (old !== '') { warningCollector.push(...) }` 内层块；**保留** `chosen.ReconciliationId = nv` + `modCollector.record(...)`。新注释：`命中即覆盖（含非空原值）；按需求移除 reconid-overwrite-backfill 告警，覆盖行为不变。` |
| 2 | `r5-fund-transfer-backfill.js` 文件头 `@returns` | warnings 清单 `multi-bank-match-backfill / reconid-overwrite-backfill` → 仅留 `multi-bank-match-backfill` |
| 3 | `r5-fund-transfer-backfill.test.js` 用例 ⑦ | 断言改为「不应再发 `reconid-overwrite-backfill` warning，但仍写入新值」（`assert.ok(!overwriteWarn, ...)`） |
| 4 | `r5-fund-transfer-backfill.test.js` 文件头注释 | ⑦ 描述同步更新为「不发 warning 但仍写入（已移除）」 |

> `warningCollector` 仍被 `multi-bank-match-backfill` 使用（line 130-137），删除本处 push 不产生 dead code。
> 核心不变量全部保持：金额转分容差 0、日期两阶段（同日优先 → ±tolerance）、`usedBankRowId` 严格 1v1 单向消费、空 reconid 不入池。

---

## 三、残留风险（🔴 用户已确认接受）

覆盖一个**已有对账 ID** 的动作改为**完全静默、无审计痕迹**。若上游金额归分错误 / 日期 ±1day 配错导致误匹配，会把正确的对账 ID 悄悄改错且无 warning 可循 —— 这正是原告警要防的场景。用户 2026-06-09 选「只删告警，覆盖照旧」即接受此取舍。

---

## 四、验证

- `node --test tests/unit/main-process/scenario-engines/r5-fund-transfer-backfill.test.js` → **30/30 pass**（含「同值不写不告警」「网关空值不写」「多候选 tie-break warning」等周边用例继续通过）。
- 提 PR / 合并到受保护分支前须跑 `npm run release-check` 全绿 + `/check-vars`（硬节点）。

---

## 五、重要变量影响（check-vars 预备）

- 触及符号：`ReconciliationId`（资金对账 ID 回填目标，资金红线语义）、R5-2 引擎 `runRound5FundTransferBackfill` 的 warnings 输出。
- 对照 `rules/important-variables.md`：未逐字命中具名条目；最接近的是 `runAllScenarios`/dispatcher first-match-wins（line 170）、`unmatchedRows` 派生契约（line 181）—— **本次均未触及**（R5 是 orchestrator 轮次而非 dispatcher；未改 `modifications`/`unmatchedRows` 派生）。
- 提 PR 前仍按硬节点跑 `/check-vars`。

---

## 六、变更记录

| 日期 | 变更 |
|------|------|
| 2026-06-09 | 用户要求移除 `reconid-overwrite-backfill` 告警；拍板「只删告警，覆盖照旧」。代码 + 单测已改，单测 30/30 pass。收口进 v3.0.1 迭代（PRD 需求5）。 |
