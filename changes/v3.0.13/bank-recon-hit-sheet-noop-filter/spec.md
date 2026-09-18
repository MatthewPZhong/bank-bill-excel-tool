# Spec — 银行对账单「命中场景」过滤未实际修改行

> 状态：**已实施**（代码 + 单测已改；unit / integration / lint 已通过）
> 来源：2026-07-02 用户反馈：资金对账数据处理结果表的 `命中场景` sheet 中出现大量未改数据行。
> 性质：🔴 资金对账输出分区修复。只改变最终导出分区，不改变任何匹配、回填、锁定、派生值逻辑。

---

## 1. 背景

用户使用场景配置：

`/Users/pzhong/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_ydixeb6lvoz322_b621/msg/file/2026-07/scenarios-bundle-20260702.json`

处理银行对账单：

`/Users/pzhong/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_ydixeb6lvoz322_b621/msg/file/2026-07/渠道账单_2026-07-02_223023.xlsx`

导出的结果表中，`命中场景` sheet 有大量没有实际改动的行。

用户期望：**只有字段被实际修改的银行行才进入 `命中场景` sheet**。

本次实际核对到的旧导出文件：

`/Users/pzhong/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_ydixeb6lvoz322_b621/msg/file/2026-07/银行对账单-202607021649-处理结果.xlsx`

旧导出结果：

| Sheet | 数据 |
|---|---:|
| `命中场景` 总数据行 | 533 |
| `命中明细` 为空的行 | 513 |
| 无黄色修改单元格的行 | 513 |
| `命中明细` 为空且无黄色修改单元格的行 | 513 |

这 513 行属于“场景匹配/锁定成功，但没有任何字段发生变化”的 no-op 行，不应进入 `命中场景`。

---

## 2. 现状根因

输出链路：

1. R2 dispatcher 执行 C1/C2/C3 等场景。
2. 某些场景即使没有字段变化，也会把银行行加入 `lockedRowIds`，用于维护 first-match-wins。
3. 编排器 `buildOutputRows()` 重建最终 `modifiedRows / unmatchedRows`。
4. `writeBankStatementOutput()` 把 `modifiedRows` 写入主结果表的 `命中场景` sheet。

改前 `buildOutputRows()` 使用的分区条件是：

```js
modColsByRowId.has(r._rowId) || r2HitByRowId.has(r._rowId)
```

即“被任一轮实际改过列”或“被 R2 命中过/锁定过”都会进入 `modifiedRows`。

因此以下 no-op 行会进入 `命中场景`：

- C2 `offset-bill-mark` 配对成功后锁定双方，但目标字段原值已经等于目标值，不产生 `modifications`。
- C3 `gateway-recon-join` 匹配成功并锁定银行行，但 assign 回填值与银行现有值相同，不产生 `modifications`。

这些行 `_modifiedColumns.size === 0`，导出后表现为：

- `命中明细` 为空；
- 没有黄色标记；
- 但仍出现在 `命中场景` sheet。

---

## 3. 目标行为

### 3.1 主规则

最终结果表：

- `命中场景` sheet 只展示**实际发生字段变更**的银行行。
- 未发生字段变更的 no-op 行不进入 `命中场景`。

### 3.2 保留行为

R2 dispatcher 内部的 first-match-wins 锁定语义不变：

- C2/C3 匹配成功但同值不改时，dispatcher 仍可锁定该行，避免后续 R2 场景重复消费。
- 锁定仅影响本轮 R2 调度，不再等同于“导出命中场景行”。

跨轮元数据保留不变：

- 如果某行先被 R2 命中/锁定，后续又被 R4/R5 实际改写，则该行仍进入 `modifiedRows`。
- 该行仍可保留 R2 `_hitScenario*` 元数据，用于命中场景行报表和状态展示。

行数守恒不变：

```text
modifiedRows.length + unmatchedRows.length === bankRows.length
```

---

## 4. 实现方案

### 4.1 修改 `buildOutputRows()`

文件：

`src/main-process/reconciliation-orchestrator.js`

核心改动：

```js
const isChanged = (r) => modColsByRowId.has(r._rowId);

const modifiedRows = bankRows.filter(isChanged);
const unmatchedRows = bankRows.filter((r) => !isChanged(r));
```

`r2HitByRowId` 不再参与“是否进入 modifiedRows”的判断，只在行已经实际变更时用于嫁接 R2 命中元数据。

### 4.2 不修改 dispatcher / 引擎

不改以下行为：

- `scenario-dispatcher.js` 中 `lockedRowIds` 的含义。
- C2 配对成功即锁定双方。
- C3 匹配成功即锁定银行行并消费网关行。
- C1/C2/C3/R4/R5 的匹配规则和字段写入规则。

理由：本问题只发生在**最终导出分区**，不是匹配或回填逻辑错误。

---

## 5. 测试

### 5.1 单测

文件：

`tests/unit/main-process/reconciliation-orchestrator.test.js`

新增/调整覆盖：

1. C2 配对成功但目标字段同值：
   - dispatcher 仍确认 `L1/R1` 被锁定进 `dispatcher.modifiedRows`；
   - `modifications.length === 0`；
   - 编排器最终 `modifiedRows` 为空；
   - `L1/R1` 留在 `unmatchedRows`；
   - 行数守恒。

2. C3 匹配成功但 assign 同值：
   - `modifications.length === 0`；
   - 不进入 `modifiedRows`；
   - 留在 `unmatchedRows`；
   - 行数守恒。

3. 既有回归继续覆盖：
   - R2 真正改字段时仍进入 `modifiedRows`。
   - R2 命中行后续被 R4/R5 改写时仍保留元数据。
   - R5 / R4-only 改写行仍按修改列进入 `modifiedRows`。

### 5.2 已执行验证

- `node --test tests/unit/main-process/reconciliation-orchestrator.test.js` → 35/35 pass
- `npm run test:unit` → 3284/3284 pass
- `npm run lint` → pass
- `npm run test:integration` → 38 个脚本，1775/1775 pass

`npm run test:integration` 会按项目既有机制刷新 `rules/integration-test-policy.md` 的集成测试耗时清单。

---

## 6. 风险与边界

### 6.1 风险

这是输出分区行为变更。旧逻辑把“被场景消费/锁定但未修改”的行算入 `命中场景`；新逻辑不再算入。

如果有人把 `命中场景` sheet 当作“所有被场景消费的行”审计口径，行数会减少。但这与用户当前期望冲突，本次以“实际修改行”作为 `命中场景` 的权威语义。

### 6.2 不改变

不改变：

- 场景匹配结果；
- first-match-wins 锁定；
- 网关行 1v1 消费；
- R4/R5 回填/改写；
- `异常-人工判断` 检测；
- 独立 `命中场景行` 报表的 writer 逻辑。

### 6.3 手测建议

用用户样本重新导出，预期：

- `命中场景` sheet 中不再出现 `命中明细` 为空且无黄色修改单元格的 no-op 行。
- 原 20 行有 `命中明细` / 黄色标记的实际修改行仍保留。
- `未命中场景` 行数相应增加，且总行数仍守恒。

---

## 7. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-07-02 | 用户反馈 `命中场景` sheet 混入大量未修改行；定位到 `buildOutputRows()` 将 R2 锁定 no-op 行并入 `modifiedRows`；改为只按实际修改列分区，并补 C2/C3 no-op 回归测试。 |
