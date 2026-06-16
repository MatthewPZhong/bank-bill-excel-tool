# Spec — R5 场景3「中台加款单脏数据处理」两处规则变更（ChannelOrderNo 兜底匹配 + FundType 子串判定）

> 状态：**已定稿，待实施** ｜ 来源/目标分支：`v3.0.7` ｜ 目标版本：随分支 v3.0.7
> 性质：🔴 **资金红线**（剔除清单错位 / 误命中 = 导出错误的财务清单）
> 缘起：业务方提出两处调整 —— ①对账号匹配不上时希望再用银行 `ChannelOrderNo` 兜一道，扩大脏数据识别面；②`FundType` 精确判等 `'Inbound'` 太死，未来出现 `Inbound-VA`、`inbound-xxx` 等入金变体会被误剔除。
> 决策：用户 2026-06-16 逐条拍板 D-1 ~ D-3（见 §二），spec 定稿可进入实施。

---

## 一、背景与现状（代码出处）

引擎：`src/main-process/scenario-engines/r5-platform-inbound-cleanup.js` → `runRound5PlatformInboundCleanup(gwRows, bankRows, options)`
调用：`reconciliation-orchestrator.js:421-431`（R5 场景3，R4 之后运行，透传 `gwTradeType` / `excludeFundType`）
配置 seed：`src/backend/database/migrations.js:1544-1556`（`gwTradeType:'Inbound-VA'`、`excludeFundType:'Inbound'`）

**现状匹配逻辑**（建索引 `:72-79`、匹配循环 `:84-133`）：
- 银行行**只**按 `ReconciliationId` 建单 Map 索引（空键跳过）。
- 逐网关行用 `gw.reconciliationid` 取候选；单候选直取，多候选按 Credit Amount 方向消歧（v3.0.0 块C，O-1：`parseNumber !== null && !== 0`），0/≥2 条 Credit 有值则发 `no-credit-match`/`multi-credit-match` 警告并跳过（仅警告不阻断）。
- 严格 1v1：`usedBankRowId` Set 标记已消费银行行。

**现状触发条件**（`:130`）：
```js
if (normalizeCellValue(bankRow.FundType) !== excludeFundType) {   // 默认 != 'Inbound'，精确判等
  cleanupRows.push(buildCleanupRow(gw, bankRow));
}
```

**现状问题**：
1. 对账号只认 `ReconciliationId` 一列，银行侧对账号没对上即匹配失败，漏识别。
2. 触发条件精确判等 `'Inbound'`，`Inbound-VA` / 大小写变体会被判为「非入金」而误产剔除行。

**关键字段事实（已探索确认）**：
- 银行字段 `BANK_STATEMENT_FIELDS`（`src/constants/bank-statement-fields.js`）同时含 `ReconciliationId`(:21) 与 `ChannelOrderNo`(:22)，导入后两列都真实存在于 bank 行对象上。
- 网关账单链接表（`gateway-bill`）字段里**没有**独立的渠道订单号字段，只有 `reconciliationid`（小写）。→ fallback 只能用网关同一个 `reconciliationid` 值去撞银行第二列。
- `FundType` 枚举当前 12 值（`tests/unit/constants/fund-type-enum.test.js`），其中**只有 `'Inbound'` 含 "Inbound" 子串** → 变更2 对现有数据行为零变化，属防御性扩展。
- `ChannelOrderNo` **不在** `CLEANUP_COPY_HEADERS`（C~O 13 列）里，只作匹配键，不进剔除行结构 → 漂移守卫单测不受影响。

---

## 二、需求规则（用户 2026-06-16 拍板 —— 权威 truth）

### 变更1：两级 fallback 匹配键

| 编号 | 规则 |
|------|------|
| **D-1** | 用网关同一个 `reconciliationid` 值，**优先**匹配银行 `ReconciliationId`；匹配不上**再**用同一个值匹配银行 `ChannelOrderNo`；两者都匹配不上才算匹配失败（跳过该网关行）。网关侧无独立渠道订单号字段，故两级都用 `gw.reconciliationid` 这一个值。 |
| **D-1a** | **fallback 触发边界**：仅当一级 `ReconciliationId` 桶「**无可用候选**」（桶为空 OR 候选已被前面网关行消费空，即 `pickFromCandidates` 返回 `skip:'empty'`）时，才退到 `ChannelOrderNo` 桶。 |
| **D-3** | **一级桶消歧失败不 fallback**：一级 `ReconciliationId` 桶找到 ≥2 候选但 Credit 方向消歧失败（0 条或 ≥2 条 Credit 有值）时，视为数据脏，保持现有 `no-credit-match`/`multi-credit-match` 警告并**跳过**，**不**退到 `ChannelOrderNo`。fallback 只补「查无此行」，不补「找到了但有歧义」，避免撞上业务无关行产错误剔除清单。 |
| **D-1b** | **二级桶同样套用 Credit 方向消歧**：`ChannelOrderNo` 桶多候选时复用同一套消歧逻辑（单候选直取 / 唯一 Credit 行 / 0 或 ≥2 条 → 警告跳过）。二级触发的警告复用同名 code（`no-credit-match`/`multi-credit-match`），message 补「(按 ChannelOrderNo 匹配)」标记便于排查；不新增 code。 |
| **D-1c** | **严格 1v1 跨两级共享**：`usedBankRowId` 在两级共用同一个 Set，一个银行行只能被消费一次（无论经由 ReconciliationId 还是 ChannelOrderNo）。 |

### 变更2：FundType 子串判定（大小写不敏感）

| 编号 | 规则 |
|------|------|
| **D-2** | 触发条件从「`FundType !== 'Inbound'` 才剔除」改为「`FundType` **不包含** `excludeFundType` 子串才剔除」。即 `FundType` 含 `excludeFundType` 子串 → 视为入金、**不**产剔除行。 |
| **D-2a** | **大小写不敏感**：`inbound` / `INBOUND` / `Inbound` 任一形态都算命中子串、都不剔除。实现用 `ft.toLowerCase().includes(ex.toLowerCase())`。 |
| **D-2b** | **配置不变**：`excludeFundType` 字段名与 seed 值 `'Inbound'` 保持不变（`migrations.js:1553`），语义从「等于此值」变为「包含此子串」只在引擎内实现。`migrations-recon-round-seed.test.js` 对 `excludeFundType:'Inbound'` 的断言仍成立。 |
| **D-2c** | **空配置兜底**：`excludeFundType` 被清空（`ex === ''`）时显式走「全部命中行都产剔除行」分支，与旧默认方向一致，避免 `includes('')` 恒真导致全不产的反转。 |

---

## 三、技术设计（最小改法）

**唯一引擎改动文件**：`src/main-process/scenario-engines/r5-platform-inbound-cleanup.js`，三处。

### 改动1 — 建双键索引（替换现 `:72-79`）

```js
const bankByReconId = new Map();        // key = normalizeCellValue(bank.ReconciliationId)，空键跳过
const bankByChannelOrderNo = new Map(); // key = normalizeCellValue(bank.ChannelOrderNo)，空键跳过
for (const bank of safeBankRows) {
  const rk = normalizeCellValue(bank && bank.ReconciliationId);
  if (rk !== '') { if (!bankByReconId.has(rk)) bankByReconId.set(rk, []); bankByReconId.get(rk).push(bank); }
  const ck = normalizeCellValue(bank && bank.ChannelOrderNo);
  if (ck !== '') { if (!bankByChannelOrderNo.has(ck)) bankByChannelOrderNo.set(ck, []); bankByChannelOrderNo.get(ck).push(bank); }
}
```
桶 value 保持「bank 对象数组、按 bankRows 插入序」，不引入 ordOf（与现有单 Map 口径一致）。同一行两列都有值会同时进两个桶，重复消费由 `usedBankRowId` 兜底（见不变量论证）。

### 改动2 — 匹配循环（替换现 `:84-133`）

把现有「单/多候选 + Credit 方向消歧」（现 `:95-125`）**原样抽成 helper**，对两个桶按严格优先级各调一次：

```js
// 在候选数组(调用方已过滤 usedBankRowId)里做消歧；不改任何 O-1/O-4 口径
// 返回 { row } | { skip:'empty' } | { skip:'no-credit' } | { skip:'multi-credit' }
function pickFromCandidates(cand) {
  if (cand.length === 0) return { skip: 'empty' };
  if (cand.length === 1) return { row: cand[0] };            // O-4 单候选维持现状
  const creditCand = cand.filter((b) => {
    const v = parseNumber(b['Credit Amount']);
    return v !== null && v !== 0;                            // O-1 口径不变
  });
  if (creditCand.length === 1) return { row: creditCand[0] };
  if (creditCand.length === 0) return { skip: 'no-credit' };
  return { skip: 'multi-credit' };
}

for (const gw of gwPool) {
  const key = normalizeCellValue(gw && gw.reconciliationid);
  if (key === '') continue;

  // ① 一级 ReconciliationId
  const candR = (bankByReconId.get(key) || []).filter((b) => !usedBankRowId.has(b._rowId));
  const resR = pickFromCandidates(candR);

  let bankRow = null;
  let via = 'ReconciliationId';
  if (resR.row) {
    bankRow = resR.row;
  } else if (resR.skip === 'empty') {
    // ② 仅「查无此行」才 fallback 到 ChannelOrderNo（D-1a）
    const candC = (bankByChannelOrderNo.get(key) || []).filter((b) => !usedBankRowId.has(b._rowId));
    const resC = pickFromCandidates(candC);
    if (resC.row) {
      bankRow = resC.row; via = 'ChannelOrderNo';
    } else if (resC.skip === 'no-credit' || resC.skip === 'multi-credit') {
      pushDisambigWarning(resC.skip, key, candC, 'ChannelOrderNo'); // 复用同名 code + 来源标记(D-1b)
      continue;
    } else {
      continue; // 两级都 empty → 静默跳过（现状一致）
    }
  } else {
    // 一级 no-credit / multi-credit → 数据脏，不 fallback（D-3）
    pushDisambigWarning(resR.skip, key, candR, 'ReconciliationId');
    continue;
  }

  usedBankRowId.add(bankRow._rowId); // 严格 1v1，跨两级共享（D-1c）
  // 触发条件见改动3
}
```
`pushDisambigWarning(skip, key, cand, via)` 封装现有两条 warning 的 push，code = `no-credit-match`/`multi-credit-match`、severity `warning`，message 末尾按 via 追加「(按 ChannelOrderNo 匹配)」（via==='ReconciliationId' 时不加，保持原文案）。

**不重复消费不变量**：只有一级 `empty`（candR 过滤后为 0 条）才走二级；二级 candC 也过滤 `usedBankRowId`。若某行两列都=key 且未被消费，它在 candR 必非空 → resR 不会是 `empty` → 不进二级；若已被消费，二级 filter 也排除它。故同一行不可能被两级各消费一次（candR 显式 Set 排除属冗余防御，默认不加）。

### 改动3 — 触发条件（替换现 `:130`）

```js
const ft = normalizeCellValue(bankRow.FundType).toLowerCase();
const ex = normalizeCellValue(excludeFundType).toLowerCase();
if (ex !== '' && ft.includes(ex)) {
  // FundType 含 excludeFundType 子串（大小写不敏感）→ 入金，不产剔除行（D-2/D-2a）
} else {
  cleanupRows.push(buildCleanupRow(gw, bankRow)); // 含 ex==='' 兜底全产（D-2c）
}
```

### 不动的部分
- `buildCleanupRow`（`:34-47`）一行不改：附言 `${bank.FundType}，中台加款单已关闭。`（中文标点）、加款单号取 `gw.orderid`、C~O 拷贝银行行同名字段。fallback 命中 `ChannelOrderNo` 的行同样按此口径产剔除行。
- 配置 / migrations 逻辑不动（D-2b）；可选把 `migrations.js:1554` 的 `function` 文案补「(ReconId 主、ChannelOrderNo 兜底)」（纯文案、seed 测试未断言该字段，安全；非必需，倾向不改）。
- 顶部注释（`:4-7` 业务语义、`:50-53` 入参/options 说明、`:128-129` 触发条件注释）同步措辞为「两级 fallback：ReconId 主、ChannelOrderNo 兜底」+「FundType 不含 excludeFundType 子串(大小写不敏感)才剔除」，并 bump 文件版本 tag 到 v3.0.7。

---

## 四、影响面 / 测试 / 回归

### 资金红线 & 重要变量
- 关联函数：`runRound5PlatformInboundCleanup`、`buildCleanupRow`（资金红线）。
- 实施前后须按 CLAUDE.md 硬节点跑 `/check-vars`（提 PR / 版本 bump / 合并前），按命中层级在 PR body 追加「关联功能 review」段。

### 测试（文件 `tests/unit/main-process/scenario-engines/r5-platform-inbound-cleanup.test.js`）
fixture `bankRow(...)`（`:40-63`）加可选 `channelOrderNo` 入参（默认不写入/空），现有用例零回归。

**改 3 个：**
1. `:153-160`（FundType=Inbound 不产）—— 断言不变，用例文案改为「含 Inbound 子串」表述。
2. `:162-172`（excludeFundType 可配化，用 'outbound'）—— 重写为「包含」语义：`excludeFundType:'outbound'` 下 `'outbound'` 含子串不产、`'Inbound'` 不含 `'outbound'` 子串则产；补一条 `'outbound-VA'` 含子串也不产，验证「包含而非等于」。
3. `:373-389`（混合用例）—— `'Inbound'` 那条仍不产，断言不变，确认通过。

**新增 7 个：**
1. `FundType:'Inbound-VA'` 命中 → 0 条（变更2 核心：子串而非等值）。
2. 大小写不敏感：`'inbound'`（小写）命中 → 0 条；`'INBOUND'` 同理；负向 `'outbound'` → 产。锁定 D-2a。
3. ReconId 不上、ChannelOrderNo 上 → 产：`bank.ReconciliationId` ≠ key 但 `bank.channelOrderNo` = key，FundType 非含 Inbound → 1 条、加款单号=gw.orderid（变更1 fallback 命中）。
4. 两级都不上 → 0 条且无警告（静默 empty）。
5. ChannelOrderNo 桶多候选方向消歧：ReconId 桶空、ChannelOrderNo 桶 2 行(1 Credit 1 Debit) → 取 Credit 行产 1 条；变体 2 行都 Credit → `multi-credit-match` 警告(带 ChannelOrderNo 标记) + 不产。
6. 1v1 跨两级不重复消费：两条 gw 同 key；一条 bank 行 `ReconciliationId=key` 且 `channelOrderNo=key` → 第一条 gw 一级消费它、第二条 gw 二级因已消费捞不到 → 1 条。
7. 🔴 红线锁：一级消歧失败不 fallback —— ReconId 桶 2 行都 Credit 有值(multi-credit)，同时存在一条 `channelOrderNo=key` 的干净行 → 仍 0 条 + `multi-credit-match` 警告（证明不退到 ChannelOrderNo，锁 D-3）。

回归（不改）：`tests/unit/main-process/reconciliation-orchestrator.test.js` 用到该场景 seed，其 bank 行不带 ChannelOrderNo、走一级匹配，行为不变，跑一遍确认。

### 验证命令
1. `npm run test:unit` —— 引擎单测全绿（重点改 3 + 新增 7）。
2. `npm run release-check` —— PASS/FAIL 总闸。
3. `npm run check:vars`（=`/check-vars`）。
4. 抽查端到端：构造「网关 reconciliationid 只与银行 ChannelOrderNo 对得上」样例，跑导出，确认生成 `中台加款单剔除模板-*.xlsx` 且加款单号/附言/C~O 正确（资金红线，留样本）。

---

## 五、风险与红线提醒

- 🔴 **fallback 误命中（最大风险）**：`ChannelOrderNo` 与 `ReconciliationId` 业务含义不同。已用 D-1a（仅「查无此行」才 fallback）+ D-1b（二级同跑 Credit 消歧）+ D-3（消歧失败不 fallback）把误命中面压到最小；仍建议用真实样本验证至少一个 fallback 命中案例的业务正当性。
- 🔴 **触发方向不能写反**：含子串是「**不**产剔除行」（视为入金），新增用例1/2 即为防反向 bug。
- 🔴 **1v1 不重复消费**：`usedBankRowId` 跨两级共享，新增用例6 守护。

---

## 六、待办（实施前置）

1. [x] 用户定 D-1 ~ D-3（2026-06-16 已拍板，见 §二）
2. [x] 据此定稿本 spec 伪代码（§三）
3. [x] 确认目标版本：随分支 v3.0.7
4. [ ] 实施 → 引擎三处改动 + 注释/版本 tag → 改 3 + 新增 7 单测 → `npm run test:unit` / `release-check` → `/check-vars` → 端到端样本 → PR
