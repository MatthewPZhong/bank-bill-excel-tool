# v2.1.12 α — 需求5 spec：网关场景 extra fee 匹配（🔴资金红线）

> 状态：草稿（逐节填充中）
> 范围：仅需求5。立项已拍板，勿改范围。
> 本文档所有"现状"描述均带 `文件:行` 出处。

---

## 0 概述（含🔴资金红线声明）

### 0.1 需求一句话

在 C3「提取ReconId-From 网关」(`category=gateway-recon-join`) 场景的新增/修改弹窗左下角加一个勾选框，文案「网关对账单金额与银行对账单不一致」。勾选后出现「网关对账单金额 +」`[输入框]`「= 银行对账单金额」。匹配时：**网关订单金额 + extra fee 后再与银行对账单金额比对**。

### 0.2 🔴 资金红线声明（最高级，必须人工复核）

| 项 | 说明 |
|----|------|
| 红线性质 | extra fee 直接改变 **C3 网关核销 join 的金额匹配判定**——决定哪条网关行核销哪条银行行（reconId 写入哪行）。fee 算错 / 方向反 / 默认值漂移都会导致 **错配 → 银行账单写错 reconId（"幽灵核销"）** |
| 命中的既有红线契约 | ① `runC3Scenario` 1v1 严格消费（v2.1.7 F2，`usedGwRowIdx`）② `config_json.assign`/config 结构扩展（v2.1.8 N2 兼容契约）③ `gwMatchesBank` 金额相等判定（`valuesEqual` numeric）|
| 绝对不变量 | **fee 未勾选 / fee=0 时，C3 匹配行为必须与 v2.1.11 byte-for-byte 一致**（旧场景零回归，见 §2.4）|
| 必须 POC | 是。资金一致性必须在合并前用真实/构造数据集验证（见 §4）|

### 0.3 范围边界（重要 — 与立项假设的潜在偏差）

| 弹窗 / 引擎 | category | 匹配对象 | 是否在需求5 范围 | 依据 |
|------------|----------|---------|----------------|------|
| C3「提取ReconId-From 网关」 | `gateway-recon-join` | 网关账单 ↔ **银行对账单** | ✅ 是（唯一确定） | `c3-gateway-recon-join.js:60-66` gwMatchesBank 比对 bankRow |
| C4「网关对账单 ReconID 修复」 | `gateway-recon-id-fix` | 网关账单 ↔ **渠道账单** | ❓ 存疑（见 Q1） | `renderer-dialogs.js:8425` labelOpp='渠道账单'；不涉及银行对账单 |

> 需求文本写「C3 **以及**网关对账单的场景新增/修改弹窗」。经代码核对：**只有 C3 涉及"银行对账单"**；C4 gateway 子模式匹配的是"渠道账单"，与需求文本「= 银行对账单金额」语义不符。本 spec **默认范围 = 仅 C3**，C4 列为开放问题 Q1 请用户拍板。

### 0.4 现状事实速览（均带出处）

| 事实 | 出处 |
|------|------|
| C3 引擎入口 | `src/main-process/scenario-engines/c3-gateway-recon-join.js:68` `runC3Scenario(scenario, bankRows, gwRows)` |
| 金额匹配实际发生点 | `c3-gateway-recon-join.js:60-66` `gwMatchesBank` → 逐 reconField `valuesEqual(gwRow[gwField], bankValue, {numeric})` |
| 数值字段判定 | `c3-gateway-recon-join.js:55-58` `isNumericFieldName`，正则 `/Amount\|Fee\|金额\|数额\|发生额/` |
| 银行侧金额取值（虚拟字段） | `c3-gateway-recon-join.js:29-37` `getBankRowValueForC3`，「发生额绝对值」= `Math.abs((credit\|\|0)-(debit\|\|0))` |
| 数值相等比较 | `engine-utils.js:108-115` `valuesEqual` → numeric 时 `parseNumber(left)===parseNumber(right)`（精确 `===`，无容差）|
| C3 config 默认结构 | `renderer-dialogs.js:6784-6792` `{conditions:[], reconFields:[{seq,gwField,bankField}], assign:{gwField,bankField,mode,customValue}}` |
| C3 弹窗渲染 | `renderer-dialogs.js:7089-7344` `createScenarioConfigDialogC3` |
| C3 校验 | `renderer-dialogs.js:6920-6955` `validateScenarioDraft` 分支 |
| config 持久化 | `src/backend/database/scenarios-repository.js`（serializeConfig/parseConfig，整对象 JSON）|
| C3 单测 | `tests/unit/main-process/scenario-engines/c3-gateway-recon-join.test.js`（12 个 test，全字符串 OrderId 匹配，**无金额场景**）|
| C3 smoke | `scripts/smoke/scenario-engines.js:55-340+` C3-1..C3-8（含 `Amount` vs `发生额绝对值`，金额均整数 100/50）|

## 1 config schema 变更 + 旧场景兼容

### 1.1 extra fee 存哪（必答①）

存在 **C3 scenario 的 `config` 对象**（持久化在 `scenarios.config_json`，整对象 JSON 序列化，见 `scenarios-repository.js:58-67`）。新增一个对象字段 `extraFee`：

```jsonc
// gateway-recon-join 的 config（新增 extraFee 字段，其余不变）
{
  "conditions": [...],
  "reconFields": [...],
  "assign": { "gwField": "...", "bankField": "...", "mode": "direct", "customValue": "" },
  "extraFee": {              // ← v2.1.12 新增
    "enabled": false,        // 勾选框状态（默认 false = 旧行为）
    "amount": 0              // 数值，单位与金额字段同币种（默认 0）
  }
}
```

**为什么用嵌套对象 `extraFee:{enabled,amount}` 而非两个平铺字段**：与 v2.1.8 N2 `assign:{mode,customValue}` 的成组语义一致；序列化/反序列化天然成组；后续若扩展（如多 fee、按字段区分 fee）只动这一个子对象。备选方案见 Q2。

### 1.2 默认值 + createDefaultScenarioConfig 改点

`renderer-dialogs.js:6784-6792` `createDefaultScenarioConfig('gateway-recon-join')` 的返回对象**追加** `extraFee: { enabled: false, amount: 0 }`。

🔴 默认 `enabled:false` + `amount:0` 是零回归红线 —— 新建场景默认与旧 C3 行为完全一致。

### 1.3 旧场景兼容（无 migration，惰性兜底）— 推荐方案

| 维度 | 结论 |
|------|------|
| 是否需要 DB migration | **不需要**（推荐）。理由：v2.1.8 N2 的 `assign.mode` 用了 migration（因为引擎 `chosen.row[assign.gwField]` 缺 mode 时仍要分支），但 extra fee 更简单——引擎读 `config.extraFee?.enabled` 缺失即 `false`，行为退化为旧逻辑，**天然兼容** |
| 引擎兜底 | `runC3Scenario` 读 `const fee = (config.extraFee && config.extraFee.enabled) ? parseNumber(config.extraFee.amount) : null;`，缺字段 / `enabled:false` → `fee=null` → 不参与运算（见 §2.2）|
| 弹窗兜底 | `createScenarioConfigDialogC3` 读取时 `if (!config.extraFee) config.extraFee = { enabled:false, amount:0 };`（与 `:7102-7106` 对 `assign`/`conditions` 的兜底同款）|
| bundle 兼容 | extra fee 随 config 整体 JSON export/import，旧 bundle 无 `extraFee` → import 后引擎兜底为关。**新 bundle 含 `extraFee` 被旧版本 app 读取时会被忽略（旧引擎不读该字段）→ 静默退化为不加 fee**（⚠️ 跨版本风险，列 Q3）|

> 对比 v2.1.8 N2 为何当时要 migration：`config_json.assign`（important-variables.md:841）migration 是为「缺 `assign.mode` 的老场景补 `mode='direct'`」，因为 N2 改了 assign 取值分支逻辑。extra fee 不改任何既有取值路径，只在 `enabled` 时**额外加数**，故惰性兜底即可。**是否仍要做 migration 统一补 `extraFee:{enabled:false,amount:0}`** 列为 Q3 备选。

### 1.4 校验改点（validateScenarioDraft）

`renderer-dialogs.js:6920-6955` 的 `gateway-recon-join` 分支追加（仅 `enabled` 时校验 amount）：

```js
const ef = c.extraFee || {};
if (ef.enabled) {
  // 见 §2.3 校验规则：必填、数值、方向
  if (ef.amount === '' || ef.amount === undefined || ef.amount === null) errors.push('勾选"金额不一致"后 extra fee 金额不能为空');
  else if (!Number.isFinite(Number(ef.amount))) errors.push('extra fee 金额必须是数字');
  // 正负 / 小数规则见 §2.3（Q4 待定）
}
```

## 2 C3 匹配算法改点 + byte-for-byte 影响评估（必答②）🔴

### 2.1 C3 现在如何按金额匹配（现状，带出处）

匹配是 reconFields 的**逐字段 AND**，金额只是其中一个字段对。链路：

```
runC3Scenario (c3-gateway-recon-join.js:139 forEach bankRow)
  └─ gwMatchesBank(gwRow, bankRow, reconFields)            // :60-66
       └─ reconFields.every(rf =>                          // 每个字段对都要相等
            valuesEqual(gwRow[rf.gwField],                 // 网关侧原始值
                        getBankRowValueForC3(bankRow, rf.bankField),  // 银行侧值（虚拟字段算绝对值）:29-37
                        { numeric: isNumericFieldName(...) }))        // :55-58 含 Amount/金额/发生额
```

- **金额字段对示例**（smoke `scenario-engines.js:62`）：`{ gwField:'Amount', bankField:'发生额绝对值' }`。
- 银行侧「发生额绝对值」由 `getBankRowValueForC3` 用 `Math.abs((Credit Amount\|\|0)-(Debit Amount\|\|0))` 算出（`c3-gateway-recon-join.js:34`）。
- 相等判定 `valuesEqual` numeric 分支：`parseNumber(gw)===parseNumber(bank)`，**精确相等，无容差**（`engine-utils.js:108-115`）。

> 关键认知：C3 **不知道哪个 reconField 是"订单金额"**——它只是把所有 reconField 平等地做 AND 相等比较。extra fee 要"加在订单金额上"，就必须**精确指出"哪个字段是金额字段"**，否则无法把 fee 加到正确的字段对上。这是设计的核心难点，详见 §2.2 + Q5。

### 2.2 加 fee 后精确改点（推荐方案 A：识别金额字段对，gw 侧 +fee 后比）

需求语义：「网关对账单金额 + extra fee = 银行对账单金额」。即在**金额字段对**上，把网关侧值 `+fee` 后再与银行侧比；**非金额字段对照旧逻辑不变**。

改点集中在 `gwMatchesBank`（`c3-gateway-recon-join.js:60-66`），改为接收 fee 参数：

```js
// 改后（示意，非最终代码）
function gwMatchesBank(gwRow, bankRow, reconFields, fee /* number|null */) {
  return reconFields.every((rf) => {
    const numeric = isNumericFieldName(rf.gwField) || isNumericFieldName(rf.bankField);
    const bankValue = getBankRowValueForC3(bankRow, rf.bankField);
    if (fee !== null && numeric) {
      // 🔴 金额字段对：网关值 + fee 后比银行值
      const gwNum = parseNumber(gwRow[rf.gwField]);
      if (gwNum === null) return valuesEqual(gwRow[rf.gwField], bankValue, { numeric });
      return parseNumber(bankValue) !== null && (gwNum + fee) === parseNumber(bankValue);
    }
    return valuesEqual(gwRow[rf.gwField], bankValue, { numeric });
  });
}
```

`runC3Scenario` 在主循环外算一次 `fee`：
```js
const efCfg = config.extraFee;
const fee = (efCfg && efCfg.enabled === true) ? parseNumber(efCfg.amount) : null; // 缺失/未勾 → null
```

**⚠️ 方案 A 的歧义点（必须 Q5 拍板）**：`isNumericFieldName` 命中的可能不止一个字段对（例如 reconFields 同时有 `Amount` 和某个 `Fee` 字段，正则 `/Amount|Fee|.../` 两个都命中 numeric）。若有 ≥2 个金额字段对，fee 会被加到**所有** numeric 字段对上 → 错。

候选解法（Q5）：
- **A1（推荐，最小改动）**：限定"只对银行侧字段 = 「发生额绝对值」(`BANK_STATEMENT_VIRTUAL_AMOUNT_ABS`) 的那个字段对加 fee"。理由：C3 的"银行对账单金额"在现实配置里就是「发生额绝对值」（smoke 唯一金额对就是它）。判定 `rf.bankField === BANK_STATEMENT_VIRTUAL_AMOUNT_ABS`，精确、无歧义。
- **A2**：UI 让用户显式指定"哪个 reconField 是金额对"（多一个下拉），最严谨但 UI 复杂、超出需求文本。
- **A3**：对所有 numeric 字段对都加 fee（最简单，但多金额对场景会错配 → 资金风险）。

> spec 推荐 **A1**：fee 只作用于"银行侧 = 发生额绝对值"的字段对，与需求「= 银行对账单金额」字面一致，且零歧义。

### 2.3 4 字符输入框 = 金额数值：格式 / 校验 / 方向（必答③）

| 维度 | 现状/事实 | 推荐 | 备注 |
|------|----------|------|------|
| 数据类型 | config 存 number | 存 number；UI input 为 text，change 时 `Number()` 解析 | 与 priority 数值输入同款（`:6857-6860`）|
| 方向（正/负） | 需求文本「网关金额 + extra fee = 银行金额」字面是**加** | 推荐**允许正负**（负数 = 网关比银行多收）。fee 直接代数相加：`gwNum + fee` | Q4 |
| 小数 | 金额本质是货币，可能含小数（如手续费 0.5） | 推荐**允许小数**（货币 2 位） | Q4；若限整数需 UI/校验加 `step=1` |
| 4 字符宽度 | 需求明确"输入框占 4 字符" | 仅 **视觉宽度**约束（CSS width ≈ 4ch），**不等于** maxlength=4 | Q4：是否真的 `maxlength` 限 4 字符？4 字符放不下 `1234.5`（6 字符）。推荐：视觉 4ch 但不限 maxlength |
| 零值 | — | `enabled:true` 且 `amount:0` 合法（等价于不加，但用户显式声明"金额一致差额为0"）；或校验要求非 0。推荐：允许 0 但给轻提示 | Q4 |
| 空值 | — | `enabled:true` 时 amount 空 → 校验报错（§1.4）| 确定 |

🔴 **方向是资金红线**：加/减反了会让本应匹配的行不匹配（漏核销）或不该匹配的行匹配（错核销）。Q4 必须用户明确确认"网关金额 + fee = 银行金额"中 fee 的符号语义。

### 2.4 byte-for-byte 影响评估 🔴

**核心断言：`extraFee` 缺失 / `enabled:false` / `amount` 不存在 → `fee=null` → `gwMatchesBank` 走 `else` 原 `valuesEqual` 分支 → 与 v2.1.11 完全一致（byte-for-byte）。**

| 受影响测试资产 | 是否受冲击（fee 默认关时） | 说明 |
|---------------|------------------------|------|
| `c3-gateway-recon-join.test.js`（12 test，全 OrderId 字符串匹配） | **不受冲击** | 无金额字段对；且无 `extraFee` 字段 → fee=null。函数签名加第 4 参数 `fee`，旧调用不传 → `undefined`，需在引擎内 `fee=undefined→null` 归一（**改 gwMatchesBank 签名时若直接 `fee!==null` 判定，`undefined!==null` 为 true → 会误入 fee 分支！见下方⚠️**）|
| `scenario-engines.js` smoke C3-1..C3-8（含 Amount vs 发生额绝对值，金额整数） | **不受冲击（前提：默认关）** | makeC3Scenario（`:55`）config 无 `extraFee` → fee=null → 原路径。金额 100/50 整数 `parseNumber` 精确相等不变 |
| `scenario-dispatcher.test.js` / `scenario-end-to-end.js` | 不受冲击 | 不构造 extraFee |
| bundle import/export 测试（`scenarios-bundle-io.test.js`） | 不受冲击 | 旧 bundle 无 extraFee；新增字段随 JSON 透传 |

⚠️ **byte-for-byte 唯一真实风险点（实现时必须处理）**：`gwMatchesBank` 加第 4 参数后，**旧调用方（含全部现有测试）不传 fee → `fee===undefined`**。若引擎内判定写成 `if (fee !== null && numeric)`，则 `undefined !== null` 为 **true** → 旧场景误入 fee 分支 → `gwNum + undefined = NaN` → 全部金额匹配失败 → **大面积回归**。
- **必须的防御**：`runC3Scenario` 内统一算 `fee`（缺失→null），**只在 runC3Scenario 内部调用 gwMatchesBank 并传 fee**；或 gwMatchesBank 入口 `fee = Number.isFinite(fee) ? fee : null`。
- **调用方已核实（grep 结论）**：`gwMatchesBank` 全仓**唯一真实调用点是 `c3-gateway-recon-join.js:159`**（引擎内部）；`:208` 是 `module.exports` 导出但**无外部调用方**（src/tests/scripts 全仓 0 处外部引用）。→ byte-for-byte 风险面收窄：只需保证 `:159` 这一处传入归一后的 fee 即可，且引擎入口 `Number.isFinite(fee)?fee:null` 兜底使导出符号被未来测试误用时也安全。
- 此风险在 §4 POC 必须用"默认关 + 金额场景"显式回归断言覆盖。

### 2.5 不变量清单（实现/review 对照）

1. fee=null 时 `gwMatchesBank` 输出与改前完全一致（byte-for-byte）。
2. 1v1 严格消费（`usedGwRowIdx`，:132/:159/:188/:195）逻辑**完全不动**——extra fee 只改"是否匹配"的判定，不改"匹配后如何消费 gw"。
3. fee 只作用于金额字段对（A1：银行侧=发生额绝对值），其余 reconField 比对不变。
4. `parseNumber` 精确相等语义不变（无容差）；`gwNum + fee` 后仍用 `===`。

## 3 UI 改动点（勾选框 + 条件显示输入框）（必答⑥）

全部集中在 `createScenarioConfigDialogC3`（`renderer-dialogs.js:7089-7344`），新增一行/一块在弹窗 body 内。

### 3.1 DOM 结构（新增）

需求文本：左下角勾选框 + 文案「网关对账单金额与银行对账单不一致」；勾选后右侧显示「网关对账单金额 +」`[输入框 4ch]`「= 银行对账单金额」。

建议加在「对账成立后赋值」行（`:7140-7159`）之后，作为弹窗 body 最后一行：

```html
<div class="scenario-config-row scenario-config-row-extrafee">
  <label class="scenario-config-extrafee-check">
    <input type="checkbox" data-field="extrafee-enabled" ${config.extraFee.enabled ? 'checked' : ''} ${isReadonly ? 'disabled' : ''}>
    网关对账单金额与银行对账单不一致
  </label>
  <span class="scenario-config-extrafee-formula" style="${config.extraFee.enabled ? '' : 'display:none;'}">
    网关对账单金额 +
    <input class="scenario-config-input scenario-config-input-fee" type="text"
           data-field="extrafee-amount" value="${escapeHtml(String(config.extraFee.amount ?? ''))}"
           ${isReadonly ? 'disabled' : ''}>
    = 银行对账单金额
  </span>
</div>
```

> "左下角"：需求字面是左下角。当前 C3 弹窗 body 是纵向 `.scenario-config-row` 堆叠（label 左 + 控件右），无独立"左下角"区域。最小实现是作为 body 末行靠左对齐（CSS）。是否严格做成对话框左下角浮动（与 actions 同排）列 Q6。

### 3.2 事件绑定（新增，参照 assign-custom-value 同款 `:7285-7287`）

| 事件 | 行为 |
|------|------|
| checkbox `change` | `config.extraFee.enabled = e.target.checked`；toggle formula `span` 的 `display`（同 `:7277-7283` assign-custom-value 显隐套路）；取消勾选时是否清空 amount → 推荐**不清空**（保留用户输入，下次勾选还在），但**校验时 enabled=false 不校验 amount** |
| amount input `input` | `config.extraFee.amount = e.target.value`（存字符串，校验/引擎侧 `Number()`/`parseNumber`）|

### 3.3 兜底 / readonly

- 弹窗加载兜底：`if (!config.extraFee) config.extraFee = { enabled:false, amount:0 };`（加在 `:7102-7106` 同区域）。
- view 模式：checkbox + input 均 `disabled`（沿用 `isReadonly`）。

### 3.4 前端回归（previews）⚠️

C3 弹窗是 scenario 配置弹窗，改 DOM 后**必须重跑对应 preview**。需 Dev 确认 C3 配置弹窗是否在某个 `npm run preview:xxx` 覆盖（memory `workflow_frontend_previews`：改前端提 PR 前必须重跑对应 preview，新增页面需补 4 处入口）。本 spec 标记为实现期必办项（见 §8）。

### 3.5 CSS

新增 class `.scenario-config-row-extrafee` / `.scenario-config-input-fee`（width≈4ch）。落在 `src/styles*.css`（具体文件 Dev 定位现有 `.scenario-config-*` 所在处）。

## 4 POC + 资金评审计划（必答④）🔴

资金红线必须在合并前用数据集验证"加 fee 后匹配结果正确 + 默认关零回归"。

### 4.1 POC 数据集（最小集，单测层即可覆盖核心资金逻辑）

| 数据集 | 构造 | 验证点（资金一致性） |
|--------|------|--------------------|
| DS1 零回归（默认关 + 金额场景） | 复用 smoke makeC3Scenario（`Amount` vs `发生额绝对值`，无 extraFee），bank=gw=100 | fee=null → 命中，结果与 v2.1.11 byte-for-byte 一致（**防 §2.4 ⚠️ 的 NaN 回归**）|
| DS2 加 fee 命中 | extraFee{enabled:true,amount:5}；gw Amount=100，bank 发生额绝对值=105 | 100+5=105 → **命中**，reconId 写入 |
| DS3 加 fee 不命中 | 同 DS2 但 bank 发生额绝对值=100 | 100+5=105≠100 → **不命中**，bank 原值保留（不写错 reconId）|
| DS4 fee=0 显式勾选 | extraFee{enabled:true,amount:0}；gw=bank=100 | 等价默认关，命中（验证 enabled+0 不破坏）|
| DS5 负 fee（若 Q4 允许负） | amount:-5；gw=100，bank=95 | 100+(-5)=95 → 命中 |
| DS6 小数 fee（若 Q4 允许小数） | amount:0.5；gw=100，bank=100.5 | parseNumber 精确相等 100.5===100.5 命中 |
| DS7 多金额字段对（验证 A1 vs A3 歧义） | reconFields 含 Amount(发生额绝对值) + 另一个 Fee 字段 | A1：fee 只加在发生额绝对值对；其余金额对不加（**资金正确性关键**）|
| DS8 1v1 消费不变 | 多 bank 同金额 + 单 gw（加 fee 命中） | usedGwRowIdx 仍严格 1v1，只第 1 条命中（红线不变）|
| DS9 浮点精度边界 | amount:0.1，gw=0.2，bank=0.3 | ⚠️ `0.1+0.2 === 0.3` 在 JS 为 **false**！需评估是否要 epsilon 容差（见 Q7）|

### 4.2 POC 落点

- **单测**：扩 `tests/unit/main-process/scenario-engines/c3-gateway-recon-join.test.js` 新增 describe `extra fee` 覆盖 DS1-DS9。
- **smoke**：`scripts/smoke/scenario-engines.js` C3 段加 1-2 个 extra fee 端到端 case（含 DS1 零回归断言）。
- **release-check**：`npm run release-check`（串 unit+integration+smoke）必须全绿。

### 4.3 资金评审计划（人工复核）

| 评审项 | 责任 | 通过标准 |
|--------|------|---------|
| 方向语义（Q4） | 用户拍板 | fee 符号确认：`gw + fee = bank` |
| fee 作用字段（Q5） | 用户拍板 | A1（仅发生额绝对值）or A2/A3 |
| 浮点容差（Q7） | 用户拍板 | 精确 === or epsilon |
| DS1 零回归 | Dev + 自动 | byte-for-byte，smoke baseline modifiedRows 不漂移 |
| 真实账单端到端 | 用户手测 | 用一份真实"网关账单+银行对账单（金额含手续费差）"跑通，人工核对核销结果 |
| check-vars | team-lead | 提 PR 前跑 `/check-vars`（§6）|

🔴 **合并前必须有"真实数据端到端 + 人工核对"证据**，不能只靠单测（资金红线规则 6+7）。

## 5 验收标准

| # | 验收项 | 验证方式 |
|---|--------|---------|
| AC1 | C3 弹窗左下出现勾选框「网关对账单金额与银行对账单不一致」，默认不勾 | 手测 / preview |
| AC2 | 勾选后出现「网关对账单金额 +」[输入框]「= 银行对账单金额」；取消勾选隐藏 | 手测 |
| AC3 | 勾选 + 填 fee → 保存 → config.extraFee={enabled:true,amount:N} 持久化；重开弹窗回显 | 手测 + DB |
| AC4 | 🔴 勾选 fee=5：gw金额+5=bank金额时命中并写 reconId；不等时不命中保留原值 | 单测 DS2/DS3 + 端到端 |
| AC5 | 🔴 未勾选 / fee=0 → C3 匹配与 v2.1.11 byte-for-byte 一致 | 单测 DS1/DS4 + smoke baseline |
| AC6 | 旧 C3 场景（config 无 extraFee）打开正常、运行不加 fee | 手测旧场景 + 兜底单测 |
| AC7 | 校验：勾选后 amount 空/非数字报错；未勾选不校验 | 单测 + 手测 |
| AC8 | 1v1 严格消费红线不变 | 单测 DS8 |
| AC9 | bundle export/import 含/不含 extraFee 兼容 | 单测 |
| AC10 | `npm run release-check` 全绿 + 对应 preview 重跑 | CI |

## 6 check-vars 命中清单（必答⑤）

依据 `rules/important-variables.md`，需求5 改动命中以下条目（提 PR 前须跑 `/check-vars`）：

| 条目 | 层级 | 出处 | 本次是否触碰 | 变更 review 要点（摘自表 + 本需求适配） |
|------|------|------|------------|----------------------------------------|
| `runC3Scenario` | **Risk-sensitive ⚠️🔴资金红线** | important-variables.md:802 / `c3-gateway-recon-join.js:68` | **是（核心）** | 🔴 不得破坏 Set 候选池 1v1（删/改回 1v多 → 幽灵核销）；改 match key 须同步 dialog+reader；gwRows 空数组兜底保留；**必跑 smoke c3 5 case + 真实端到端**。本需求只在 gwMatchesBank 加 fee 判定，不动 usedGwRowIdx 消费 |
| `config_json.assign` | **Risk-sensitive ⚠️ 对账契约扩展** | important-variables.md:836 / scenarios.config_json | **间接**（同 config 对象新增兄弟字段 extraFee，未改 assign 本身） | 老 scenario 必须 graceful 升级（场景库不能丢）；bundle 兼容（旧 bundle 自动兜底）。本需求 extraFee 走惰性兜底而非 migration（§1.3）；需确认是否比照 assign.mode 也做幂等 migration（Q3）|
| `BANK_STATEMENT_FIELDS_FOR_C3` | **Important-skeleton ⚠️ preload 双写坑** | important-variables.md:455 / `constants/bank-statement-fields.js:60` | **否**（不改字段集合）；**只读** `BANK_STATEMENT_VIRTUAL_AMOUNT_ABS` 做 A1 金额对判定 | 改字段集合 → C3 dialog/引擎/持久化都受影响 + preload.js 双写。本需求不增删字段，仅引用常量值，无双写风险。**但若实现引用该常量须确认引擎侧 import 路径**（引擎已 import，`c3-gateway-recon-join.js:26`）|
| `GATEWAY_RECON_FIELDS` | 非升格（A-share 跨度） | important-variables.md:847 / `constants/gateway-recon-fields.js:15` | **否** | 本需求不改网关字段集合 |

> 其余 Critical / Important-skeleton 条目（如 `runAllScenarios` dispatcher first-match-wins、`writeBankStatementOutput` F8 第2 sheet）本需求**不触碰**——extra fee 只改 C3 内部金额判定，不改 dispatcher 调度顺序，也不改 writer。实现完成后仍须按软约束回看实际改动符号。

## 7 开放问题（带推荐）

| # | 问题 | 选项 | 推荐 | 优先级 |
|---|------|------|------|--------|
| **Q1** | 「网关对账单的场景新增/修改弹窗」是否含 C4 `gateway-recon-id-fix`？ | a) 仅 C3 / b) C3+C4 | **a 仅 C3**。C4 匹配的是"渠道账单"非"银行对账单"，与需求文本「= 银行对账单金额」不符（`renderer-dialogs.js:8425`）。若用户本意含 C4，需重写需求语义（C4 是 1v多/多v1 复杂匹配，extra fee 加法语义不同）| 🔴 **必拍**（决定范围）|
| **Q5** | extra fee 加到"哪个金额字段对"？（C3 不区分订单金额 vs 其他金额字段）| A1 仅银行侧=发生额绝对值 / A2 UI 显式选字段 / A3 所有 numeric 对 | **A1**。零歧义、与「= 银行对账单金额」字面一致、最小改动。A3 在多金额字段对场景会错配（资金风险）| 🔴 **必拍**（决定资金正确性）|
| **Q4** | fee 的方向/格式：正负？小数？4 字符是否硬 maxlength？ | — | 推荐：**允许正负**（代数相加 `gw+fee=bank`）、**允许小数**（货币 2 位）、4 字符仅视觉宽度**不硬限 maxlength**、允许 0 | 🔴 **必拍**（方向是资金红线）|
| Q7 | 浮点精度：`gwNum+fee===bankNum` 用精确 `===` 还是 epsilon 容差？ | 精确 / 容差(如 1e-6) | 推荐**保持精确 `===`**（与现有 valuesEqual 一致，不引入容差语义漂移）；但提示用户：`0.1+0.2!==0.3` 经典浮点坑。若 fee 常含小数，建议 Dev 在加法处用 `Math.round((gw+fee)*100)/100` 归一到分 | 中（Q4 选"允许小数"才相关）|
| Q3 | 旧场景兼容用惰性兜底还是比照 assign.mode 做幂等 migration？ | 惰性兜底 / + migration 补 extraFee | 推荐**惰性兜底**（§1.3）。extra fee 不改既有取值路径，缺失即关，无需 migration。migration 仅增加无收益的写库 | 低（不阻塞，可 Dev 定）|
| Q2 | config 字段形态：嵌套 `extraFee:{enabled,amount}` vs 平铺 `extraFeeEnabled`+`extraFeeAmount` | — | 推荐**嵌套对象**（与 assign 成组语义一致，扩展友好）| 低 |
| Q6 | UI 严格"对话框左下角浮动"还是"body 末行靠左"？ | 浮动 / 末行靠左 | 推荐**body 末行靠左**（最小改动，C3 body 是纵向堆叠无浮动布局）；如需严格左下角浮动需调 dialog flex 布局 | 低（UX 细节）|

**开放问题总数：7（Q1-Q7）**

## 8 任务拆分建议

> 前置：Q1/Q4/Q5 必须先拍板（决定范围+资金语义），否则不进代码（No Spec No Code）。

| 任务 | 内容 | 文件 | 依赖 |
|------|------|------|------|
| T1 | config 默认值 + 弹窗加载兜底加 `extraFee:{enabled:false,amount:0}` | `renderer-dialogs.js:6784-6792` / `:7102-7106` | Q2 |
| T2 | C3 弹窗 UI：勾选框 + 条件显示 formula + 输入框 + 事件绑定 | `renderer-dialogs.js:7112-7164` / `:7285` 区 | Q4,Q6 |
| T3 | C3 弹窗校验：enabled 时校验 amount | `renderer-dialogs.js:6920-6955` | Q4 |
| T4 | CSS：`.scenario-config-row-extrafee` / `-input-fee`(4ch) | `src/styles*.css` | Q6 |
| T5 | 🔴 引擎改点：`runC3Scenario` 算 fee + `gwMatchesBank` 加 fee 参数（A1：仅发生额绝对值对）+ **undefined→null 防御** | `c3-gateway-recon-join.js:60-66`/`:139-159` | Q5,Q7 |
| T6 | 🔴 单测：扩 c3 test DS1-DS9（含零回归 byte-for-byte） | `tests/unit/.../c3-gateway-recon-join.test.js` | T5 |
| T7 | smoke：C3 段加 extra fee 端到端 + 零回归断言 | `scripts/smoke/scenario-engines.js` | T5 |
| T8 | preview 回归（C3 弹窗） + 文档三件套（CHANGELOG/VERSION_FEATURE_HISTORY/USER_GUIDE） | previews + docs | T2 |
| T9 | `/check-vars`（提 PR 前）+ 真实数据端到端人工核对 | — | 全部 |

**建议提交顺序**：T1→T5→T6（先把引擎+零回归单测锁死，证明默认关无回归）→ T2/T3/T4（UI）→ T7/T8/T9。

> 规模评估：单一需求、改动集中（核心 3 文件 + 测试），不需要拆多 Phase/委托多 agent，单线 Dev 小批次即可。
