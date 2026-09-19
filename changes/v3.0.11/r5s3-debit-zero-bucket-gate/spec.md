# 需求0：R5s3 银行行入桶新增 Debit=0 门槛（v3.0.11 · 🔴资金红线）

## 背景
R5 场景3「中台加款单脏数据处理」(`src/main-process/scenario-engines/r5-platform-inbound-cleanup.js`) 把网关 `Inbound-VA` 订单与银行行按对账ID 1v1 配对，命中且 `FundType` 不含 `Inbound` 子串时生成「加款单剔除行」。当前银行行建索引桶（`bankByReconId` / `bankByChannelOrderNo`，`:87-100`）对所有行一视同仁，导致有借方发生额（出金）的行也可能被当入金参与匹配。

## 变更：入桶门槛
仅「无借方发生额」的银行行可入桶。**口径B（已与用户确认）**：`Debit Amount` 为 **0 或空白** 都入桶；仅**真实非零借方**排除。

### 落点
`r5-platform-inbound-cleanup.js` 入桶循环 `for (const bank of safeBankRows)`（现 `:89`）体最前面加：
```js
// 需求0(v3.0.11 · 🔴资金红线)：仅「无借方发生额」的银行行可入桶。
// 口径B：Debit 为 0 或空白均入桶；仅真实非零 Debit 排除（= Credit 消歧 O-1「有值」判定的对称取反）。
const debitVal = parseNumber(bank && bank['Debit Amount']);
if (debitVal !== null && debitVal !== 0) continue; // 真实非零借方 → 一级/二级桶都不入
```
- `parseNumber` 已在文件顶部引入（`:36`，来自 `./engine-utils`）。行为：`""`/非数字 → `null`；`"0"`/`"0.00"`/`"-0"` → `0`；`"1,000"` → `1000`。
- 字段 `'Debit Amount'` 恒有（`src/constants/bank-statement-fields.js:20`）。
- **双级一致**：门槛在建桶处统一拦截，`bankByReconId` 与 `bankByChannelOrderNo` 都收紧。

## 🔴 连锁影响（必须覆盖测试）
入桶收紧后，原本含 Debit≠0 候选的桶变小 → 既有 Credit 方向消歧（`pickFromCandidates` `:111-122`）的多候选场景大量塌缩为单候选；两级 fallback（`:151-178`）与 1v1 消费（`usedBankRowId`）的命中路径随之变化。

## 测试（`tests/unit/main-process/scenario-engines/r5-platform-inbound-cleanup.test.js`）
1. 修正既有「Credit 消歧」相关 fixture：凡用 Debit≠0 行制造多候选的 case（约测试⑦a/⑦c、⑨二级 fallback），按新门槛重算预期（Debit≠0 行不再入桶）。
2. 新增门槛边界 case：同一 reconid 下
   - Debit 为 `""` / `null` / `"0"` / `"0.00"` → 入桶（可命中/参与消歧）；
   - Debit 为 `"100"` / `"1,000"` → 不入桶（被预过滤）。
3. 新增交互 case：门槛过滤后一级变 empty → 触发二级 ChannelOrderNo fallback；二级桶同样应用 Debit 门槛；1v1 跨级消费不受破坏。

## 不变量（不可破坏）
- 不改 `buildCleanupRow`（剔除行结构）、不改 FundType 子串触发方向、不改 `gwTradeType`/`excludeFundType` 默认值。
- 本场景 `modifications` 仍恒为 `[]`。

## 验收
- `node --test tests/unit/main-process/scenario-engines/r5-platform-inbound-cleanup.test.js` 全绿。
- `npm run release-check` 全绿。
