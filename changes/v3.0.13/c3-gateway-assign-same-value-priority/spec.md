# Spec — C3 网关赋值场景优先选择同值赋值候选

> 状态：待实施
> 来源：2026-07-02 用户反馈：网关对账单赋值银行对账单场景中，银行行已有的被赋值字段值能匹配到某条网关行，但仍可能被另一条同条件/同对账字段网关行的赋值字段覆盖。
> 性质：🔴 资金对账 C3 引擎匹配候选选择修复。只调整多候选时的候选选择优先级，不改变条件判断、对账字段、赋值字段、金额匹配、Extra Fee 写盘语义。

---

## 1. 背景

复现使用场景配置文件：

`/Users/pzhong/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_ydixeb6lvoz322_b621/msg/file/2026-07/scenarios-bundle-20260702.json`

其中 `outbound-2` 场景配置：

- category：`gateway-recon-join`
- 条件：
  - 网关 `orderid` 开头为 `PD`
  - 银行 `FundType` 等于 `outbound`
  - 网关 `Channel` 等于 `BOSH`
- 对账字段：
  - 网关 `currency` = 银行 `Currency`
  - 网关 `amount` = 银行 `发生额绝对值`
  - 网关 `Billdate` = 银行 `BillDate`
- 赋值：
  - 网关 `reconciliationid` → 银行 `ReconciliationId`

用户指出的问题：

当同一条银行行同时匹配到两条网关行，且其中一条网关行的 `reconciliationid` 已经等于银行行当前 `ReconciliationId` 时，系统仍可能选择另一条网关行，把银行行 `ReconciliationId` 覆盖成另一个值。

---

## 2. 复现

构造一条银行行：

```js
{
  _rowId: 'b1',
  FundType: 'outbound',
  Currency: 'USD',
  'Credit Amount': 0,
  'Debit Amount': 100,
  BillDate: '2026-06-30',
  ReconciliationId: 'RC-SAME'
}
```

构造两条网关行，均满足 `outbound-2` 的条件和对账字段：

```js
const gwSame = {
  Channel: 'BOSH',
  orderid: 'PD-SAME',
  currency: 'USD',
  amount: 100,
  Billdate: '2026-06-30',
  reconciliationid: 'RC-SAME'
};

const gwOther = {
  Channel: 'BOSH',
  orderid: 'PD-OTHER',
  currency: 'USD',
  amount: 100,
  Billdate: '2026-06-30',
  reconciliationid: 'RC-OTHER'
};
```

改前结果：

| 网关行顺序 | 当前选择 | 银行最终 `ReconciliationId` | 是否错误覆盖 |
|---|---|---|---|
| `[gwSame, gwOther]` | `gwSame` | `RC-SAME` | 否 |
| `[gwOther, gwSame]` | `gwOther` | `RC-OTHER` | 是 |

结论：当前结果依赖网关行导入顺序。只要“错误候选”排在“同值候选”之前，就会发生错误覆盖。

---

## 3. 根因

文件：

`src/main-process/scenario-engines/c3-gateway-recon-join.js`

当前 C3 候选选择流程：

1. 先过滤网关侧条件、银行侧条件。
2. 对每条银行行，从未消费的网关行中找出所有满足 `reconFields` 的候选。
3. 排除赋值字段为空的网关候选。
4. 如果候选数大于 1，发 `multi-gateway-match` warning。
5. 直接选择第一条候选：

```js
const chosen = matched[0];
```

问题点：

`matched[0]` 只反映网关行原始顺序，不考虑银行行当前被赋值字段是否已经和某条网关候选的赋值字段相等。

对 `outbound-2` 而言，银行行已经有 `ReconciliationId=RC-SAME`，且候选中存在 `gw.reconciliationid=RC-SAME`，这条候选应明显优先于 `RC-OTHER`，否则会把一个已经自洽的对账 ID 错改成另一条网关的 ID。

---

## 4. 目标行为

### 4.1 主规则

对 C3 `gateway-recon-join` 的 direct assign 模式：

当一条银行行匹配到多条网关候选时，如果银行被赋值字段当前值非空，并且候选网关中存在：

```text
normalizeCellValue(gw[assign.gwField]) === normalizeCellValue(bankRow[assign.bankField])
```

则优先选择这条“赋值字段同值”的网关候选。

如果不存在同值候选，则保持现有行为：选择 `matched[0]`。

### 4.2 适用范围

仅适用于：

- `assign.mode !== 'custom'` 的 direct assign；
- `assign.gwField` 与 `assign.bankField` 均有效；
- 银行被赋值字段旧值非空；
- 候选网关赋值字段值非空。

不适用于 custom mode：

- custom mode 的新值来自 `assign.customValue`，不是网关行字段；
- 没有“网关赋值字段同值候选”的概念。

### 4.3 保留行为

以下行为不变：

- `conditions` 的过滤口径不变。
- `reconFields` 的匹配口径不变。
- `发生额绝对值` 虚拟字段口径不变。
- Extra Fee 匹配与写盘口径不变。
- `usedGwRowIdx` 仍消费最终选择的那条网关行。
- 匹配成功后仍 lock 银行行。
- 候选数大于 1 时仍发 `multi-gateway-match` warning。

---

## 5. 实现方案

### 5.1 新增候选选择 helper

建议在 `c3-gateway-recon-join.js` 内新增纯函数：

```js
function chooseC3MatchedCandidate(matched, bankRow, assign, isCustom) {
  if (!Array.isArray(matched) || matched.length === 0) return null;
  if (isCustom) return matched[0];
  if (!assign || !assign.gwField || !assign.bankField) return matched[0];

  const oldValue = normalizeCellValue(bankRow[assign.bankField]);
  if (oldValue === '') return matched[0];

  const sameValue = matched.find((x) =>
    normalizeCellValue(x.row && x.row[assign.gwField]) === oldValue
  );
  return sameValue || matched[0];
}
```

然后替换：

```js
const chosen = matched[0];
```

为：

```js
const chosen = chooseC3MatchedCandidate(matched, bankRow, assign, isCustom);
```

### 5.2 warning 文案

保留 `multi-gateway-match` warning。

可选增强 warning message：

- 若命中了同值候选，可把文案从“取第一条”调整为“优先取赋值字段同值候选”。
- 若未命中同值候选，保持“取第一条”。

建议最小实现：

- 保留原 warning code；
- 文案可增加后缀，便于审计但不影响下游逻辑。

示例：

```text
bankRow 在网关账单中匹配到 2 行可用 gw，优先取赋值字段同值候选（数据脏）
```

如果担心文案改动影响测试，可暂不改 warning 文案，只改选择逻辑。

---

## 6. 测试

### 6.1 单测文件

`tests/unit/main-process/scenario-engines/c3-gateway-recon-join.test.js`

### 6.2 必测用例

1. **outbound-2 同值候选在后时仍优先选择同值候选**

输入：

- 银行 `ReconciliationId = RC-SAME`
- 网关候选顺序 `[gwOther(RC-OTHER), gwSame(RC-SAME)]`

预期：

- 银行最终 `ReconciliationId` 仍为 `RC-SAME`
- `modifications.length === 0`
- `lockedRowIds` 包含该银行行
- `multi-gateway-match` warning 仍存在

2. **同值候选在前时行为不变**

输入：

- 网关候选顺序 `[gwSame(RC-SAME), gwOther(RC-OTHER)]`

预期：

- 银行最终 `ReconciliationId` 为 `RC-SAME`
- `modifications.length === 0`
- `multi-gateway-match` warning 仍存在

3. **没有同值候选时沿用第一条候选**

输入：

- 银行 `ReconciliationId = RC-OLD`
- 网关候选 `[gwOther1(RC-1), gwOther2(RC-2)]`

预期：

- 银行最终 `ReconciliationId = RC-1`
- 产生一条 `ReconciliationId: RC-OLD -> RC-1` modification
- `multi-gateway-match` warning 仍存在

4. **银行旧值为空时沿用第一条候选**

输入：

- 银行 `ReconciliationId = ''`
- 网关候选 `[gw1(RC-1), gw2(RC-2)]`

预期：

- 银行最终 `ReconciliationId = RC-1`
- 产生一条 modification

5. **custom mode 不走同值候选优先**

输入：

- `assign.mode = 'custom'`
- 多条网关候选

预期：

- 仍按现有 custom mode 行为写入 `customValue`
- 不因网关字段值与银行旧值相同而改变候选选择

### 6.3 建议回归命令

```bash
node --test tests/unit/main-process/scenario-engines/c3-gateway-recon-join.test.js
npm run test:unit
npm run lint
```

如果同批还改到编排器或导出分区，再跑：

```bash
npm run test:integration
```

---

## 7. 风险与边界

### 7.1 风险

这是 C3 多候选场景下的候选选择规则变更。旧逻辑完全按网关行顺序取第一条；新逻辑在“银行旧值非空且存在同值候选”时优先同值候选。

这会改变部分历史多候选脏数据的输出结果，但目标是避免把已经自洽的银行对账 ID 错改成另一条网关对账 ID。

### 7.2 不解决的问题

本修复不解决“为什么同一银行行能匹配多条网关行”的数据质量问题。

多候选仍然是脏数据，所以 `multi-gateway-match` warning 应继续保留。

### 7.3 不改变

不改变：

- C3 是否命中；
- C3 条件配置 schema；
- C3 对账字段配置 schema；
- C3 assign 配置 schema；
- 网关账单导入顺序；
- C3 1v1 消费模型；
- 输出文件结构。

---

## 8. 验收

用 `scenarios-bundle-20260702.json` 中的 `outbound-2` 场景构造复现数据：

- `[gwOther, gwSame]` 顺序下，银行 `ReconciliationId` 不应再被 `RC-OTHER` 覆盖。
- `multi-gateway-match` warning 仍能提示该银行行存在多条网关候选。
- 没有同值候选的多候选场景仍保持原来的第一条候选行为。

---

## 9. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-07-02 | 用户要求用 `scenarios-bundle-20260702.json` 的 `outbound-2` 排查 C3 赋值错误覆盖；确认现状按 `matched[0]` 取候选，存在网关行顺序导致的错误覆盖风险；形成同值候选优先 spec。 |
