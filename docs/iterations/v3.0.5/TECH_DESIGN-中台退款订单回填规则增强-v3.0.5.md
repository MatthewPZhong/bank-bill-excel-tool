# TechDoc - 网银账单小助手 v3.0.5「中台退款订单回填规则增强」（R1~R6 / O1~O4）

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.5 |
| 日期 | 2026-06-15 |
| 作者 | 软件架构师（设计稿，按 spec 决议落地，dev 据此实现 + 补单测） |
| 状态 | ✅ 定稿（设计蓝本；R1~R6 / O1~O4 + spec §9 D0~D13 **全部拍板**，详见 `changes/refund-backfill-rules-v2/spec.md`）。spec §9 D2/D3/D5/D7/D8/D10 已按推荐默认采纳、D12 已决方案①（2026-06-15 收口） |
| 关联 spec | `changes/refund-backfill-rules-v2/spec.md`（唯一真相；status=propose；R1~R6/O1~O4 / D0~D13 全部拍板，D2/D3/D5/D7/D8/D10 已按推荐默认采纳、D12 已决方案①） |
| 范式来源 | `docs/iterations/v2.1.16-beta.3/PRD-中台退款订单回填-v2.1.16-beta.3.md` + 同目录 TECH_DESIGN |
| 前置依赖 | `changes/linked-fx-bank-deposit-merge-import`（同 v3.0.5，排在本需求之前，§九）✅ **该前置 spec OPEN-1~7 已全闭环可实施（2026-06-15）：OPEN-7a=export 后写命中标记 / 7b=所有以入金表为来源的命中（含 R3/R5/R6）/ 7c=专用列 last_hit_run/last_hit_at；本需求 D12 已决方案①。代码顺序硬约束：linked-fx 先 → 本需求后（已拍板的按序施工）** |
| 同版本载荷 | v3.0.5 = size/DB 治理（剩 Phase 2/3/4）+ linked-fx-bank-deposit-merge-import + 本需求（三块同发） |

> 🔴 本文件是**设计蓝本**，文中 JS 片段为**设计示意（伪代码 / 骨架）**，标注「示意」，进入实现版本由 dev 落地并补单测。所有代码现状均带 `file:line` 出处（已二次实读核验）。
>
> 🔴 **资金红线（双变更）**：① R5 引擎匹配规则面扩张（R1~R6，新增 4 条「以入金表为命中来源」的二跳路径）；② 回填模板输出列契约变更（O1~O4，14→31 列）。任一规则错位 / 列序错位都会写错退款回填，回填一旦执行会把退款单状态误改 `SUCCESS`。每个功能 commit 一提交；提 PR 前必跑 `/check-vars` + `npm run release-check` 全量三层。

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| spec 要点 | 架构评审 |
|---|---|
| R1 提取正则放宽 `T54SWIC` → `/T54[A-Z]{4}\d{6}/g` | 可落地。旧 `/T54SWIC\d{6}/` 是新正则真子集，存量零漏配；命中仍走原等值收口（`r5-refund-order-backfill.js:167-171`），误提 ≠ 误配 |
| R2 新策略层 S2b（附言含入金 CustomerRef） | 可落地，但**必须独立成层**（不能并入 matchJpmUs 回落），否则等值主流被拖进同层反向多笔报错（§三 决策 1）。守卫（黑名单 + 最小长度）是必选项 |
| R3 HK 分支内 CustomerRef 二跳回落 | 可落地。把 matchJpmUs 二跳抽成 `matchCustomerRefTwoHop`，US 语义逐字不变，HK 复用，零行为漂移 |
| R4 S4 单向容差 0~21 天 | 可落地，但 `dayDiffWithin` 是 fund-transfer 共用双向函数（`r5-fund-transfer-backfill.js:192` 实证），**绝不可改**；须另立 `signedDayDiff`。S4 既有夹具方向重造须同 commit（§十一） |
| R5 新策略层 S3b（Drawee Name + DESC DATE 二跳） | 可落地。正则 `/DESC\s*DATE\s*=\s*(\d{6})/`（D1 拍板，起息日取 DESC DATE 非 ENTRY DATE）+ payNo 二跳 + `sameDay(dep.ValueDate, token)` 双锚收口 |
| R6 新策略层 S3c（附言原单日期+金额币种二跳） | 可落地。正则 `/DTD\s*(\d{2}\/\d{2}\/\d{4})/` + `/FOR\s*(?:USD\|AMT)\s*([\d.]+)/`；金额分比对 `Math.round(amt*100)`（同 `:321/:329` 口径）。入金侧日期列 `dep.ValueDate`（D3 已采纳，实施期 3 例实测复核） |
| O1 命中类型列（精准/模糊） | 可落地。命中类型 = 策略层属性，经 `consumeAndBackfill` 第 4 参 + `buildBackfillRow` 透传，**不动现有匹配器返回值形状**（代码实测 7 个 `match*`）；精准优先由层序天然保证 |
| O2 命中详情删前缀 + S4 固定串 | 可落地，纯文案常量化 |
| O3+O4 模板扩列 14→31 | 可落地。`buildBackfillRow` F 起银行列循环后追加 ro 字段循环；writer 纯按表头投影（`refund-backfill-writer.js:45-47`），**零 writer 功能代码改动** |
| F-PERF 入金索引 depIndex | 可落地，强制同批。65.7 万行下 4 条新二跳不建索引会使 run 耗时倍增 |

### 1.2 技术意见 / 风险提醒

| 编号 | 评审 | 处理 |
|------|------|------|
| R-1 🔴 | R2 是本批最高误配风险点（占位短串 `NONREF` 大面积假命中） | 守卫硬编码黑名单 `['NOTPROVIDED','NONREF']`（D6 定稿）+ 最小长度 ≥6；读银行主表 Payment Detail（恒有），不踩入金行存量缺字段坑 |
| R-2 🔴 | `dayDiffWithin` 被 fund-transfer 共用，改双向语义会破坏调拨回填 | R4 另立 `signedDayDiff`，`dayDiffWithin`/`sameDay`/`toDate` 一行不动（§七） |
| R-3 🔴 | 列契约 14→31 + sheet2 12→13 错位会写错回填 / 对外解析脚本错位 | 列序单一真相收敛在 `REFUND_TEMPLATE_HEADERS`（6+10+15）；CHANGELOG 显式提示对外契约破坏 |
| R-4 🔴 | 入金表实测 65.7 万行（解压 1.72GB / 内存尖峰 ~1.2GB），SheetJS 读不动 | 这是**独立工程风险点**（非本引擎纯算法可解），TechDoc §八明确标注流式读取风险，归口 linked-fx / pending-import 链路 |
| R-5 🟠 | R3 二跳生效后报错行数可能上升（旧第二条落 S4，新版同层反向多笔双报错） | 非回归，验收时向用户说明（§十一） |
| R-6 🟠 | R5/R6 正则与原件强耦合 | 正则常量化挂 `M.s3b`/`M.s3c`，「正则为 null 即整层 no-op」防御；本期原件已到位、正则已拍板（D1/D4） |
| R-7 🟠 | 命中详情字段与 linked-fx OPEN-7 残留提醒同字段构造 | buildBackfillRow 以 linked-fx 落地后形态为基线 rebase，本需求文案与 OPEN-7 提醒**叠加不互相覆盖**（§九） |
| R-8 🟡 | `usDepositKeys/usDepositTake/usBankCompare` 命名（HK 复用后名不副实） | 改中性名 `depositKeys/depositTake/bankCompare`（D8 已采纳），连带常量单测一次到位 |

### 1.3 与 spec 的差异

- 无功能性差异。本 TechDoc 把 spec §4 的链路图、§8 的 commit 切分、§9 已闭合决议固化为可落地的函数签名 + 常量契约 + 测试矩阵，逐项与 spec 决议等价。
- **版本号**：spec §9 D0 历史上一度标「版本号待定（倾向 3.0.7）」，已于本轮评审收口**回写为 `[x]` v3.0.5**（与 spec 头部第 6 行一致，由用户 2026-06-15 拍板）；本文以 v3.0.5 为准；linked-fx 原拟 3.0.7 同步作废（其 spec 版本号待其作者改）。

---

## 二、涉及文件清单（精确到函数）

| 文件 | 改动类型 | 精确到函数 / 常量 |
|------|---------|------------------|
| `src/main-process/scenario-engines/r5-refund-order-backfill.js`（现 609 行，主战场）| 修改 | 见下「2.1 引擎函数级改动」 |
| `src/constants/refund-backfill-fields.js`（现 119 行）| 修改 | 见下「2.2 常量级改动」 |
| `src/main-process/scenario-engines/engine-date-utils.js`（现 49 行）| 修改 | **仅新增** `signedDayDiff(a,b)`（追加在 `dayDiffWithin` 后，`:46` 之后）；`toDate`/`sameDay`/`dayDiffWithin` 一行不动；`module.exports`（`:48`）追加导出 |
| `src/main-process/refund-backfill-writer.js`（现 123 行）| **仅注释** | 文件头 `:7-13`「14 列 A~N / 9 列」→「31 列 / 10 列」；sheet2 注释 `:34-36` 同步「12→13」。`projectRow`（`:45-47`）/ sheet1（`:83-86`）/ sheet2（`:91-94`）功能代码零改动（按表头投影，自动跟随常量） |
| `tests/unit/constants/refund-backfill-fields.test.js` | 修改 | 常量断言（9→10 / 14→31 / 列序 / freeze / ⊆25 列签名 / T54 正则形态 / toleranceDays=21） |
| `tests/unit/main-process/scenario-engines/r5-refund-order-backfill.test.js` | 修改 | R1~R6 + O1/O2/O4 + US 165 行回归（一行不改） |
| `tests/unit/main-process/refund-backfill-writer.test.js` | 修改 | 31 列投影 + Payment Detail 列 + 15 ro 字段 + sheet2 提示行投影 `''` |

> **零改动面**（spec §6）：`reconciliation-orchestrator.js`（`:300-303` 签名不变）、`main.js`（`:3646-3647/3672/3873` 注入与调用不变）、renderer/preload、DB schema（无 migration）、唯一值分组（`:312-331`）与 1↔1/反向多笔/锁定骨架（Q13/Q14/Q15）、44 列表头契约。

### 2.1 引擎函数级改动（`r5-refund-order-backfill.js`）

| 函数 / 位置 | 改动类型 | 说明 |
|------------|---------|------|
| 顶部 require（`:29-34`）| 改 | 删 `T54SWIC_FEATURE`，引入 `T54_REFUND_RE`、`REFUND_RO_COLUMNS`；新增 `sameDay` 从 engine-date-utils、`signedDayDiff` |
| `T54SWIC_RE`（`:40`，`buildFeatureRegex(T54SWIC_FEATURE)`）| 改 | 删除，改用常量 `T54_REFUND_RE`（不再走 builder，§五）；`extractFeature` 仅用 `.source` 重建，正则字面量天然兼容（`:55-60`）|
| `HIT_TYPE_PRECISE`/`HIT_TYPE_FUZZY` 常量 | **新增** | 与 `RESULT_ERROR`/`RESULT_NOTICE` 同位（`:43-44`），导出供单测（O1）|
| `detailBankToRo`/`detailBankToDeposit`（`:82-87`）| 改 | 删 `匹配成功:` 前缀（O2）|
| `S4_DETAIL_TEXT` 常量 | **新增** | `'命中唯一值:退款提交日期+大账号+金额+币种'`（O2）|
| `buildBackfillRow`（`:90-103`）| 改 | 加第 4 参 `hitType` → `row['命中类型']=hitType`（O1）；F 起银行列循环（`:99-101`）后追加 ro 字段循环（O4）|
| `matchJpmHk`（`:157-180`）| 改 | T54 提取用 `T54_REFUND_RE`；提取为空 / 未等值后回落 `matchCustomerRefTwoHop`（R3，同层内）|
| `matchCustomerRefTwoHop(bankRow, refundCands, depIndex)` | **新增（抽取）** | 从 `matchJpmUs`（`:183-207`）抽出二跳逻辑（US 语义逐字不变）；HK/US 共用（R3）|
| `matchJpmUs`（`:183-207`）| 改 | 改为薄壳调用 `matchCustomerRefTwoHop`（R3）；depositRows → depIndex |
| `matchMemoContainsDepositRef(bankRow, refundCands, depIndex)` | **新增** | S2b 独立层（R2）|
| `matchDraweeNameDate(bankRow, refundCands, depIndex)` | **新增** | S3b 层（R5）|
| `matchMemoDateAmount(bankRow, refundCands, depIndex)` | **新增** | S3c 层（R6）|
| `matchS4`（`:247-265`）| 改 | `dayDiffWithin` → `signedDayDiff`，命中条件 `diff>=0 && diff<=21`，升序去 `Math.abs`（R4）；detail 改 `S4_DETAIL_TEXT`（O2）|
| `minDayDiffToSet`（`:555-566`）| 改 | 替换为 `hasInWindowCandidate(bankRow, refundSet)`（R4，§七）|
| `strategyChain`（`:428-432`）| 改 | 裸函数 → `{run, hitType}`；插入 S2b/S3b/S3c 三层（O1 + R2/R5/R6）|
| 链层循环（`:434-499`）| 改 | 解构 `{run, hitType}`；S4 调用点（`:518-533`）改写 hasInWindowCandidate 三分支 |
| `consumeAndBackfill`（`:569-574`）| 改 | 加第 4 参 hitType，透传 buildBackfillRow（O1）|
| `runRound5RefundOrderBackfill`（`:285`）入口 | 改 | 构建 `depIndex`（F-PERF），经 ctx 传各二跳匹配器 |
| `module.exports`（`:588-609`）| 改 | 追加导出新匹配器 + `HIT_TYPE_*` + `S4_DETAIL_TEXT`（供单测）|

### 2.2 常量级改动（`refund-backfill-fields.js`）

| 常量 / 位置 | 改动 |
|------------|------|
| `T54SWIC_FEATURE`（`:101`）| **删除** |
| `T54_REFUND_RE` | **新增** = `/T54[A-Z]{4}\d{6}/g`（§五）|
| `s4.toleranceDays`（`:69`）| `10 → 21` + 注释「单向 0≤bank.BillDate−ro.valueDate≤21；文案口径=退款提交日期（=底层 valueDate）」|
| `jpm.usDepositKeys/usDepositTake/usBankCompare`（`:76-77`）| 改中性名 `depositKeys/depositTake/bankCompare`（D8）|
| `jpm` 守卫子块 | **新增** `memoBlacklist: ['NOTPROVIDED','NONREF']`、`minRefLen: 6`、`memoFields: ['Payment Detail','Extra Information']`（R2/D6）|
| `s3b` 子块 | **新增** `{ enableField:'Drawee Name', memoFields:['Payment Detail','Extra Information'], dateRe:/DESC\s*DATE\s*=\s*(\d{6})/, depDate:'ValueDate' }`（R5/D1）|
| `s3c` 子块 | **新增** `{ memoFields:['Payment Detail'], dateRe:/DTD\s*(\d{2}\/\d{2}\/\d{4})/, amtRe:/FOR\s*(?:USD\|AMT)\s*([\d.]+)/, depDate:'ValueDate'(D3 已采纳) }`（R6/D4）|
| `REFUND_BANK_COLUMNS`（`:87-91`）| 9→10：`CustomerRef` 右侧加 `'Payment Detail'`（O3）|
| `REFUND_RO_COLUMNS` | **新增** 15 列（O4，§四）|
| `REFUND_TEMPLATE_HEADERS`（`:94-97`）| 14→31：`[退款单号,状态,渠道流水号,渠道退款时间,命中类型,匹配命中详情, ...REFUND_BANK_COLUMNS(10), ...REFUND_RO_COLUMNS(15)]`（O1+O3+O4）|
| 启动期断言（`:105-110`）| 沿用 `REFUND_BANK_COLUMNS ⊆ BANK_STATEMENT_FIELDS`（Payment Detail ∈ 44 列，自动覆盖）|
| 新断言 `REFUND_RO_COLUMNS ⊆ ZHONGTAI_REFUND_ORDER_SIGNATURE.expectedHeaders` | **新增**（require `./table-signatures`，依赖无环已核：table-signatures 仅 require bank-statement-fields）|
| `module.exports`（`:112-118`）| 删 `T54SWIC_FEATURE`，加 `T54_REFUND_RE`/`REFUND_RO_COLUMNS` |

---

## 三、策略链总设计

### 3.1 新链路图（L1~L6 + S4，命中类型挂层）

精准层 L1~L5 全排在模糊层 L6/S4 之前，「精准优先级高于模糊」由**层序天然保证**（命中即停，无需额外打分）：

```
对每个唯一值分组（大账号||币种||金额分，不变 :313）：
strategyChain（批量解析层，命中即停，全继承 Q13/Q14/Q15 骨架；元素 {run, hitType}）：
  L1 S1   渠道流水号等值（matchS1，不变）                                  [精准]
  L2 S2   附言层（matchS2 综合，不变骨架）：
          ├ JPM-HK ① T54 宽正则 ↔ ro 银行打款流水号等值（matchJpmHk）       [精准] ← R1
          │         ② ①空 → matchCustomerRefTwoHop（HK 同层回落）          [精准] ← R3
          ├ JPM-US  matchCustomerRefTwoHop（原 matchJpmUs 薄壳）            [精准]
          └ JPM 链空 / 非 JPM → matchS2Mtx 常规包含（不变）                [精准]
  L3 S2b  matchMemoContainsDepositRef（限 JPM，等值层之后）                 [精准] ← R2（新层）
  L4 S3   付款人/卡号/虚拟卡号按位等值（matchS3，不变）                     [精准]
  L5 S3b  matchDraweeNameDate（Drawee + DESC DATE ↔ dep.ValueDate 二跳）    [精准] ← R5（新层）
  L6 S3c  matchMemoDateAmount（附言原单日期+金额币种 ↔ 入金表二跳）         [模糊] ← R6（新层）
S4（链后，结构不变 :501）：单向 0 ≤ bank.BillDate − ro.valueDate ≤ 21        [模糊] ← R4
```

> 链层 hitType：L1~L5 = `HIT_TYPE_PRECISE`，L6 = `HIT_TYPE_FUZZY`，S4（链后）= `HIT_TYPE_FUZZY`。
> R1/R3 在 matchS2 内部（L2 同层），不新增 strategyChain 元素；R2/R5/R6 各新增一个 strategyChain 元素。

### 3.2 决策 1：R2 独立成层 vs R3 并入 HK 分支（分层即分强度）

这是本设计的核心结构决策，spec §4 F-R2 / §8 已论证，此处给出架构理由：

- **现状骨架（`:434-499`）**：每个 strategyChain 层在**同一冻结快照**上批量算命中图，逐 bank 定性——正向多笔报错（`:464-474`）、反向多笔报错+锁定（`:480-490`，`if (hitters.size>1)` 判据起点 `:480`）、严格 1↔1 回填（`:493`）。「反向多笔」= 同一 ro 被同层多条 bank 命中 → 全部报错。
- **R3（HK 二跳）并入 matchS2 内部（L2 同层）**：因 HK 的 T54 等值与 CustomerRef 二跳是**同一强度**（都收口到 ro 银行打款流水号等值），同层内「T54 命中 bank 与二跳命中 bank 撞同一 ro」是**真歧义**，报错是正确语义。故 R3 并入 L2 安全。
- **R2（附言包含入金 CustomerRef）必须独立成 L3 层**：附言 `.includes(ref)` 是**比等值弱**的强度。若并入 matchJpmUs/matchCustomerRefTwoHop 内部回落（与 US 165 行等值命中进**同一冻结快照**），则「等值 bankA 命中 ro X」与「附言含同 ref 的 bankB 也命中 ro X」会触发**同层反向多笔**，把 165 行等值主流拖进报错。
- **结论 = 分层即分强度**：精准等值层（L1/L2）先结清消费 → 模糊/弱包含层（L3 及之后）只见**剩余候选**。独立成层后，等值主流先被消费锁定，S2b 不会再抢已消费的 ro，保护了等值主路径（US 165 行回归零影响）。

### 3.3 新匹配器函数签名与算法（设计示意，非最终实现）

四个新匹配器与现有匹配器（代码实测 7 个 `match*`：matchS1/matchS2Mtx/matchJpmHk/matchJpmUs/matchS2/matchS3/matchS4）**返回值形状完全一致**（`[{refundRow, detail}]`，`:118` 注释定义），命中类型不进返回值（O1 经层属性透传，§六）。

```javascript
// 【示意】R2 — S2b：附言包含入金 CustomerRef（精准，独立层 L3，限 JPM）
//   收口三重：payNo 二跳到入金行(双键OR) → dep.CustomerRef 过守卫 → bank 附言.includes(ref)
function matchMemoContainsDepositRef(bankRow, refundCands, depIndex) {
  if (normalizeCellValue(bankRow.Channel) !== M.jpm.channelValue) return []; // D7：限 JPM
  const hits = [];
  for (const ro of refundCands) {
    const payNo = normalizeCellValue(ro[M.jpm.usRoKey]);
    if (payNo === '') continue;
    const dep = lookupDeposit(depIndex, payNo);          // O(1) 双 Map 并集（§八）
    if (!dep) continue;
    const ref = normalizeCellValue(dep[M.jpm.depositTake]); // dep.CustomerRef
    // 🔴 必选守卫：非空 + 不在黑名单 + 长度≥6（D6 定稿，占位短串会大面积假命中）
    if (ref === '' || M.jpm.memoBlacklist.includes(ref) || ref.length < M.jpm.minRefLen) continue;
    for (const f of M.jpm.memoFields) {                   // ['Payment Detail','Extra Information']（银行主表恒有）
      const memo = normalizeCellValue(bankRow[f]);
      if (memo !== '' && memo.includes(ref)) {
        hits.push({ refundRow: ro, detail: detailBankToDeposit(f, ref, M.jpm.depositTake, ref) });
        break;
      }
    }
  }
  return hits;
}

// 【示意】R3 — 把 matchJpmUs 二跳抽成共享层（US 语义逐字不变；HK/US 共用）
//   收口：dep 行(双键OR ↔ ro 银行打款流水号) → dep.CustomerRef ↔ bank.CustomerRef 等值
function matchCustomerRefTwoHop(bankRow, refundCands, depIndex) {
  const bankRef = normalizeCellValue(bankRow[M.jpm.bankCompare]); // bank.CustomerRef
  if (bankRef === '') return [];
  const hits = [];
  for (const ro of refundCands) {
    const payNo = normalizeCellValue(ro[M.jpm.usRoKey]);
    if (payNo === '') continue;
    const dep = lookupDeposit(depIndex, payNo);
    if (!dep) continue;
    const depRef = normalizeCellValue(dep[M.jpm.depositTake]);
    if (depRef !== '' && depRef === bankRef) {
      hits.push({ refundRow: ro, detail: detailBankToDeposit(M.jpm.bankCompare, bankRef, M.jpm.depositTake, depRef) });
    }
  }
  return hits;
}
// matchJpmUs 改薄壳：return matchCustomerRefTwoHop(bankRow, refundCands, depIndex);
// matchJpmHk 在 T54 提取空/未等值后：const fb = matchCustomerRefTwoHop(...); if (fb.length) return fb;（同层 L2 回落）

// 【示意】R5 — S3b：Drawee Name + 附言 DESC DATE ↔ dep.ValueDate 二跳（精准，L5）
//   双锚收口：payNo 二跳等值 + sameDay(dep.ValueDate, DESC DATE)
function matchDraweeNameDate(bankRow, refundCands, depIndex) {
  if (M.s3b.dateRe === null) return [];                          // 「正则未配置即整层 no-op」防御
  if (normalizeCellValue(bankRow[M.s3b.enableField]) === '') return []; // Drawee Name 非空（D2 已采纳方案 a：仅作启用条件）
  const token = extractDateToken(bankRow, M.s3b.memoFields, M.s3b.dateRe); // YYMMDD→Date（世纪固定 20YY）
  if (!token) return [];
  const hits = [];
  for (const ro of refundCands) {
    const payNo = normalizeCellValue(ro[M.jpm.usRoKey]);
    if (payNo === '') continue;
    const dep = lookupDeposit(depIndex, payNo);
    if (!dep) continue;
    if (sameDay(dep[M.s3b.depDate], token)) {                   // sameDay 现成（engine-date-utils.js:28）
      hits.push({ refundRow: ro, detail: detailBankToDeposit(M.s3b.enableField, normalizeCellValue(bankRow[M.s3b.enableField]), M.s3b.depDate, normalizeCellValue(dep[M.s3b.depDate])) });
    }
  }
  return hits;
}

// 【示意】R6 — S3c：附言原单日期+金额+币种 ↔ 入金表二跳（模糊，L6）
//   三 token 收口：payNo 二跳 + dep 日期等日 + 金额分比对 + 币种等值
function matchMemoDateAmount(bankRow, refundCands, depIndex) {
  if (M.s3c.dateRe === null || M.s3c.amtRe === null) return [];  // no-op 防御
  const memoDate = extractDateTokenSlash(bankRow, M.s3c.memoFields, M.s3c.dateRe); // DTD MM/DD/YYYY
  const amtCents = extractAmountCents(bankRow, M.s3c.memoFields, M.s3c.amtRe);     // FOR USD|AMT → Math.round(amt*100)
  const cur = 'USD'; // D4：电汇格式币种 USD（或 FOR 后三字母码）
  if (!memoDate || amtCents === null) return [];
  const hits = [];
  for (const ro of refundCands) {
    const payNo = normalizeCellValue(ro[M.jpm.usRoKey]);
    if (payNo === '') continue;
    const dep = lookupDeposit(depIndex, payNo);
    if (!dep) continue;
    const depAmt = parseNumber(dep['Credit Amount']) || parseNumber(dep['Debit Amount']);
    const depCents = (depAmt === null) ? null : Math.round(Math.abs(depAmt) * 100);
    if (sameDay(dep[M.s3c.depDate], memoDate) && depCents === amtCents && normalizeCellValue(dep.Currency) === cur) {
      hits.push({ refundRow: ro, detail: detailBankToDeposit('Payment Detail(原单日期+金额+币种)', `${cur} ${amtCents/100}`, M.s3c.depDate, normalizeCellValue(dep[M.s3c.depDate])) });
    }
  }
  return hits;
}
```

> ⚠️ R6 不硬 gate `dep.CustomerRef==='NOTPROVIDED'`（D5 已采纳：不 gate）：前层未命中已隐含其失效，硬 gate 只损召回。

---

## 四、跨表字段映射常量变更 🔴

> 🔴 三表大小写 / 语言不同（银行驼峰 / refund order 中文 / 入金表驼峰），**禁止任何同名假设**，全程显式映射（沿用 `refund-backfill-fields.js` 文件头风格）。任一列名漂移触发启动期 `throw`。

### 4.1 `REFUND_BANK_COLUMNS` 9 → 10（O3）

```javascript
// 【示意】CustomerRef 右侧加 Payment Detail（取配对银行行值）
const REFUND_BANK_COLUMNS = Object.freeze([
  'BillDate', 'Channel', '地区', 'MerchantId', 'Currency',
  'Debit Amount',                       // ⚠️ 只放 Debit Amount，不放 Credit Amount（沿用 Q4）
  'ReconciliationId', 'ChannelOrderNo', 'CustomerRef',
  'Payment Detail'                      // ← O3 新增（44 列契约 idx17，已核 BANK_STATEMENT_FIELDS.indexOf('Payment Detail')===17）
]);
```

- 启动期断言（`:105-110`）沿用 `REFUND_BANK_COLUMNS ⊆ BANK_STATEMENT_FIELDS` → Payment Detail ∈ 44 列，自动覆盖，无需改断言代码。
- **联动 sheet2**：`refund-backfill-writer.js:37-42` `UNMATCHED_HEADERS = [..., ...REFUND_BANK_COLUMNS, ...]` 自动 12→13 列。① 银行未匹配行恒有 Payment Detail 正常落值；② refund 提示行经 `projectRow` 投影 `''`（`:45-47` 已防御）。可接受，CHANGELOG 提示。

### 4.2 `REFUND_RO_COLUMNS` 新增 15 字段（O4）🔴

```javascript
// 【示意】回填模板追加配对 refund order 原值（全部 ∈ 25 列签名，按用户列序）
const REFUND_RO_COLUMNS = Object.freeze([
  '流水号', '加款单号', '渠道名称', '银行大账号', '虚拟卡号', '原加款金额', '退款金额', '币种',
  '付款人名称', '付款卡号', '附言', '客户号', '账户号', '银行打款流水号', 'valueDate'
]);
```

- **新断言**（防常量漂移）：

```javascript
// 【示意】REFUND_RO_COLUMNS 全部 ∈ ZHONGTAI_REFUND_ORDER_SIGNATURE.expectedHeaders（25 列签名）
const { ZHONGTAI_REFUND_ORDER_SIGNATURE } = require('./table-signatures'); // 依赖无环已核
const __missingRoColumns = REFUND_RO_COLUMNS.filter((f) => !ZHONGTAI_REFUND_ORDER_SIGNATURE.expectedHeaders.includes(f));
if (__missingRoColumns.length > 0) {
  throw new Error(`[refund-backfill-fields] REFUND_RO_COLUMNS 含非 25 列签名字段（常量漂移）：${__missingRoColumns.join(', ')}`);
}
```

> ⚠️ 已核：15 字段全部命中 `ZHONGTAI_REFUND_ORDER_SIGNATURE.expectedHeaders`（`table-signatures.js:57-62`）——`渠道名称`/`银行大账号`/`虚拟卡号`/`原加款金额`/`退款金额`/`币种`/`付款人名称`/`付款卡号`/`附言`/`客户号`/`账户号`/`银行打款流水号`/`valueDate`/`流水号`/`加款单号` 均在签名内。

### 4.3 `REFUND_TEMPLATE_HEADERS` 14 → 31（O1+O3+O4）

```javascript
// 【示意】6 固定列 + 10 银行列 + 15 ro 列 = 31
const REFUND_TEMPLATE_HEADERS = Object.freeze([
  '退款单号', '状态', '渠道流水号', '渠道退款时间', '命中类型', '匹配命中详情', // A~F（命中类型 = O1 新增第 5 列）
  ...REFUND_BANK_COLUMNS,  // 10 列
  ...REFUND_RO_COLUMNS     // 15 列
]);
```

> ⚠️ 31 列**表头名全互异**（`流水号` ≠ `退款单号`，表头不冲突），但**内容会出现重复列**（如 `退款单号` 与 ro `流水号` 同值、`渠道退款时间` 与 ro 字段可能重叠）——这是**用户明确要求**，照做。

### 4.4 其他常量变更 🔴

| 变更 | 旧 | 新 |
|------|----|----|
| 提取正则常量（§五）| `T54SWIC_FEATURE = {featureCode:'T54SWIC',digitCount:6,totalLength:13}`（`:101`，走 buildFeatureRegex）| `T54_REFUND_RE = /T54[A-Z]{4}\d{6}/g`（直写，删 builder 依赖）|
| S4 容差 | `s4.toleranceDays: 10`（`:69`）| `s4.toleranceDays: 21` + 单向语义注释 |
| jpm 二跳键命名（D8）| `usDepositKeys / usDepositTake / usBankCompare`（`:76-77`）| `depositKeys / depositTake / bankCompare`（HK 复用后中性名）|
| jpm 守卫子块（R2/D6）| —（不存在）| `memoBlacklist:['NOTPROVIDED','NONREF'], minRefLen:6, memoFields:['Payment Detail','Extra Information']` |
| R5/R6 正则子块 | —（不存在）| `s3b`/`s3c` 子块（含 dateRe/amtRe/depDate，§3.3）|

---

## 五、提取正则规则 🔴

### 5.1 R1 — JPM-HK `T54_REFUND_RE = /T54[A-Z]{4}\d{6}/g`

- ⚠️ **正则修正（2026-06-15 真实数据实跑）**：原 spec 一度写 `T54SW[A-Z]{2}`，但实跑 `Refund_order_..jpmhk-用例.xls` + `渠道账单_..JPMHK.xlsx` 实测「银行打款流水号」前缀为 **`T54SWIC` / `T54LCIC` / `T54CCBT`**（= `T54` + **4 字母** + 6 数字，中段 SW/LC/CC，尾段 IC/BT）。`T54SW[A-Z]{2}` 会漏 `T54LC*`(22) / `T54CC*`(3) → **正确正则 = `/T54[A-Z]{4}\d{6}/g`**。
- **样本（原件实测前缀）**：`T54SWIC494867`、`T54LCIC######`、`T54CCBT######`（清洗 `//` 后提取，`r5-refund-order-backfill.js:158` `split('//').join('')` 不变）。
- **为何不能复用 C1 `buildFeatureRegex`**：`buildFeatureRegex`（`c1-extract-recon-id.js:29-38`）只能生成「`[A-Z]{n}` 前缀 + 特征码 + `\d{m}`」形态（`englishExtraN=0` 退化为 `特征码+数字`，`:34-37`）。`T54` + **4 字母** + 数字 这种「数字+字母混合前缀 + 可变中段字母」模板**表达不了**（`T54` 含数字 `54`，但其后 4 字母不是固定特征码）→ R1 必须直写正则常量，不能走 builder。
- **安全性**：提取只决定「左操作数候选集」，命中仍须与 `ro['银行打款流水号']` 严格等值（`:167-171` 不变）；旧 `/T54SWIC\d{6}/` 是新 `/T54[A-Z]{4}\d{6}/` 的**真子集** → 存量零漏配。误提 ≠ 误配（收口在等值），最坏升为反向多笔报错（保守方向）。
- 原型实跑佐证（`scripts/prototype-refund-backfill-v2.js:15` 已用 `T54_RE = /T54[A-Z]{4}\d{6}/g`）：HK 52 行经 R1 精准命中。

### 5.2 R5 — DESC DATE token `/DESC\s*DATE\s*=\s*(\d{6})/`

- 原件 `渠道账单_2026-06-08_226235-JPMUS-CASE.xlsx`，Payment Detail 形如：

```
["DESC DATE=260513;ENTRY DATE=260529;IND NAME=nakandalage don mahesh"]
```

- 正则 `/DESC\s*DATE\s*=\s*(\d{6})/`，捕获 YYMMDD，**世纪固定 20YY**（260513 → 2026-05-13）；**起息日取 `DESC DATE`，不取 ENTRY DATE**（D1 拍板，ENTRY DATE=退款入账日）。
- `IND NAME=<名>` 即 Drawee Name 在附言中的呈现（D2 已采纳方案 a：Drawee Name 仅作启用条件，不额外比对 IND NAME ↔ ro 付款人名称）。
- 二跳收口：`sameDay(dep.ValueDate, DESC DATE)`（`sameDay` 现成，`engine-date-utils.js:28`）。

### 5.3 R6 — DTD + FOR token

- 原件电汇格式 Payment Detail 形如：

```
REMARK=/BNF/OUR REF JPM260529-011513 RTN DTD05/21/2026 ... FOR AMT5043.00
（或 ... FOR USD2285.00）
```

- 原单日期：`/DTD\s*(\d{2}\/\d{2}\/\d{4})/`（MM/DD/YYYY，05/21/2026 → 2026-05-21）。
- 金额：`/FOR\s*(?:USD\|AMT)\s*([\d.]+)/`，**一律分比对** `Math.round(amt*100)`（同 `:321/:329` 口径）。
- 币种：`USD`（电汇格式，或 `FOR` 后三字母码）。
- 入金侧日期列 `dep.ValueDate`（D3 待 3 例核对 ValueDate vs BillDate，推荐 ValueDate 与 R5 一致）。
- ❌ **D13 `OUR REF JPM######-######` 强匹配不做**（用户 2026-06-15 拍板）：原件电汇格式虽含 `OUR REF JPM260529-011513`（55/455 行），本期不查它对应的中台字段、不升级为 US 版强匹配。

---

## 六、命中类型透传路径（最小改动）

> O1 设计原则：命中类型 = **策略层属性**，不进匹配器返回值（避免改现有匹配器返回值形状——代码实测 7 个 `match*` 函数）。透传路径 = `strategyChain` 层属性 → `consumeAndBackfill` 第 4 参 → `buildBackfillRow` 第 4 参 → `row['命中类型']`。

```javascript
// 【示意】1) 常量（与 RESULT_ERROR/RESULT_NOTICE 同位 :43-44，导出供单测）
const HIT_TYPE_PRECISE = '精准命中';
const HIT_TYPE_FUZZY = '模糊命中';

// 【示意】2) strategyChain 元素由裸函数 → {run, hitType}（:428-432）
const strategyChain = [
  { run: (b, c) => matchS1(b, c), hitType: HIT_TYPE_PRECISE },                      // L1
  { run: (b, c) => matchS2(b, c, depIndex), hitType: HIT_TYPE_PRECISE },            // L2（含 R1/R3）
  { run: (b, c) => matchMemoContainsDepositRef(b, c, depIndex), hitType: HIT_TYPE_PRECISE }, // L3 R2
  { run: (b, c) => matchS3(b, c), hitType: HIT_TYPE_PRECISE },                      // L4
  { run: (b, c) => matchDraweeNameDate(b, c, depIndex), hitType: HIT_TYPE_PRECISE },// L5 R5
  { run: (b, c) => matchMemoDateAmount(b, c, depIndex), hitType: HIT_TYPE_FUZZY }   // L6 R6（模糊）
];
// 层循环解构（:434）：for (const layer of strategyChain) { const hits = layer.run(bankRow, availRefunds); ... }

// 【示意】3) 回填点（:493 链层 / :510 S4）传 hitType
consumeAndBackfill(bankRow, hits[0], { ...ctx }, layer.hitType);          // 链层
consumeAndBackfill(bankRow, inTol[0], { ...ctx }, HIT_TYPE_FUZZY);        // S4 链后

// 【示意】4) consumeAndBackfill 第 4 参（:569-574）
function consumeAndBackfill(bankRow, hit, ctx, hitType) {
  const { usedBankRowId, usedRefundIdx, refundIdOf, backfillRows } = ctx;
  usedBankRowId.add(bankRow._rowId);
  usedRefundIdx.add(refundIdOf(hit.refundRow));
  backfillRows.push(buildBackfillRow(hit.refundRow, bankRow, hit.detail, hitType)); // 第 4 参
}

// 【示意】5) buildBackfillRow 第 4 参写「命中类型」列（:90-103）
function buildBackfillRow(refundRow, bankRow, detailText, hitType) {
  const row = {
    '退款单号': normalizeCellValue(refundRow[M.backfill.fromRoSerialNo]),
    '状态': M.backfill.statusSuccess,
    '渠道流水号': normalizeCellValue(bankRow[M.backfill.fromBankReconId]),
    '渠道退款时间': bankRow[M.backfill.fromBankBillDate],
    '命中类型': hitType,                 // ← O1
    '匹配命中详情': detailText
  };
  for (const col of REFUND_BANK_COLUMNS) row[col] = bankRow[col]; // 10 列（O3）
  for (const col of REFUND_RO_COLUMNS) row[col] = refundRow[col]; // 15 列（O4）
  return row;
}
```

- **精准优先级**由层序保证（精准层 L1~L5 全在模糊层 L6/S4 前 + 命中即停），无需额外排序逻辑。
- **sheet2 不加命中类型列**（非命中行无此语义）；`UNMATCHED_HEADERS` 不含「命中类型」。

---

## 七、S4 方向收紧（R4）

### 7.1 `signedDayDiff` 设计（dayDiffWithin 为何不可动）

```javascript
// 【示意】engine-date-utils.js 新增（追加在 dayDiffWithin 后，:46 之后）
function signedDayDiff(a, b) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da || !db) return null;
  return Math.round((da.getTime() - db.getTime()) / MS_PER_DAY); // 有符号；去 Math.abs
}
// module.exports（:48）追加 signedDayDiff
```

- 🔴 **`dayDiffWithin` 绝不可动**：它是 `Math.abs` 双向（`engine-date-utils.js:44`），被 `r5-fund-transfer-backfill.js:192` 共用（`dayDiffWithin(gw.Billdate, b.BillDate, dateToleranceDays)`，已 grep 实证）。改其双向语义会破坏 R5 场景2 调拨回填。故 R4 须**另立** `signedDayDiff`，`toDate`/`sameDay`/`dayDiffWithin` 一行不动。

### 7.2 `matchS4` 改单向（`:247-265`）

```javascript
// 【示意】命中条件改单向 0~21，按 diff 升序（去 Math.abs）
function matchS4(bankRow, refundCands) {
  const hits = [];
  for (const ro of refundCands) {
    const diff = signedDayDiff(bankRow[M.s4.bankDate], ro[M.s4.roDate]); // bank.BillDate − ro.valueDate
    if (diff !== null && diff >= 0 && diff <= M.s4.toleranceDays) {       // 单向 0≤diff≤21
      hits.push({ refundRow: ro, dayDiff: diff, detail: S4_DETAIL_TEXT }); // O2 固定串
    }
  }
  hits.sort((a, b) => a.dayDiff - b.dayDiff);
  return hits;
}
```

### 7.3 `minDayDiffToSet` → `hasInWindowCandidate`（判据三分支）

```javascript
// 【示意】替换 minDayDiffToSet（:555-566）：冻结全集内是否∃ro 满足 0≤diff≤21
function hasInWindowCandidate(bankRow, refundSet) {
  for (const ro of refundSet) {
    const diff = signedDayDiff(bankRow[M.s4.bankDate], ro[M.s4.roDate]);
    if (diff !== null && diff >= 0 && diff <= M.s4.toleranceDays) return true;
  }
  return false;
}
```

调用点（`:518-533`）改写为三分支（**报错 / 提示**）：

| 情形 | 判据 | 输出 |
|------|------|------|
| S4 命中 | `matchS4(...).length > 0` | 回填（模糊，已在 7.2）|
| **报错-人工介入** | 组非空 ∧ 有可解析日期对 ∧ `hasInWindowCandidate===false` | sheet2 `RESULT_ERROR`，文案改「S4 金额币种已关联但银行账单日期早于退款提交日期或差异 >21 天，请人工介入」；warning code `refund-backfill-date-over-tolerance`（不变）。**含 bank 早于全部退款的负 diff = 时序矛盾脏数据** |
| **提示-未匹配** | 有窗内候选但被抢光 / 组空 / 全不可解析 | sheet2 `RESULT_NOTICE`「未能关联到任何退款订单」|

- **边界四态**（验收）：diff=0 命中 / diff=21 命中 / diff=22 报错 / diff=−1 报错（方向收紧）。
- 🔴 **R4 前置硬验收**：38 行 NONREF 样本须回放确认**无「bank.BillDate 早于 ro.valueDate」的合法配对**（否则方向收紧会把合法对误报错）——此为 R4 上线前置条件（spec §7.2）。

---

## 八、depIndex 入金索引设计（F-PERF）+ 流式读取风险

### 8.1 双 Map 设计 + 二跳改写

```javascript
// 【示意】runRound5RefundOrderBackfill 入口一次性构建（:285 之后）
function buildDepIndex(depositRows) {
  const byReconId = new Map();        // ReconciliationId → dep[]
  const byChannelOrderNo = new Map(); // ChannelOrderNo  → dep[]
  for (const dep of (Array.isArray(depositRows) ? depositRows : [])) {
    const rid = normalizeCellValue(dep[M.jpm.depositKeys[0]]); // ReconciliationId
    const cno = normalizeCellValue(dep[M.jpm.depositKeys[1]]); // ChannelOrderNo
    if (rid !== '') { if (!byReconId.has(rid)) byReconId.set(rid, []); byReconId.get(rid).push(dep); }
    if (cno !== '') { if (!byChannelOrderNo.has(cno)) byChannelOrderNo.set(cno, []); byChannelOrderNo.get(cno).push(dep); }
  }
  return { byReconId, byChannelOrderNo };
}

// 【示意】二跳取值：OR 双键 = 两 Map 并集；取第一条（与原 deps.find 语义一致）
function lookupDeposit(depIndex, payNo) {
  const a = depIndex.byReconId.get(payNo);
  if (a && a.length) return a[0];
  const b = depIndex.byChannelOrderNo.get(payNo);
  if (b && b.length) return b[0];
  return null;
}
```

- **改写点**：现状 `matchJpmUs` 每 (bank, ro) 对做 `deps.find` 线性扫（`:191-195`）。R2/R3/R5/R6 新增 4 条二跳路径会把线性扫乘数倍 → O(n)→O(1) Map 查为**性能必选项**（D9 拍板纳入 commit ⑦）。
- 🔴 **「索引版与线性版结果 byte 级一致」断言**（验收）：同一组样本，depIndex 版 `backfillRows`/`unmatchedRows` 与旧线性 `deps.find` 版**逐行逐键全等**（可拆独立 commit ⑦，便于二分定位）。
- ⚠️ **累加语义下的多值**：linked-fx 落地后 depositRows 是「跨次幂等累加」（§九-2），同一 ReconId/ChannelOrderNo 可能对应多条 dep（跨期残留）。`Map<key, dep[]>` 已支持同键多值；`lookupDeposit` 取 `[0]` 与旧 `deps.find` 取首条**语义一致**，但样本回放须在累加后入金表语义下验收（候选面变大 → 误配/反向多笔概率画像变化，§九-2）。

### 8.2 ⚠️ 入金表 65.7 万行 / 1.72GB SheetJS 读不动（独立工程风险点）

> 🔴 这是**另一工程风险点**，不在本引擎纯算法可解范围，TechDoc 在此明确标注，归口 linked-fx / pending-import 流式读取链路：

- 实测入金表可达 **65.7 万行**（解压体积 **1.72GB** / 内存尖峰 **~1.2GB**，两者量纲不同）。⚠️ `main.js:3649` 源码注释当前仅写「65.7 万行 ~1.2GB 尖峰」（指内存尖峰），未含解压体积——本文以「解压 1.72GB / 内存尖峰 1.2GB」并列为准；commit ⑧ 若统一口径，可顺手把 `main.js:3649` 注释补全（注意 main.js 含 NUL，改注释须留意 Edit 限制，参考 main.js NUL 经验）。
- 现状 `main.js:3646` `workingDepositRows = structuredClone(database.readLinkedTableRows('bank-deposit'))` 一次性全量入内存——**SheetJS（XLSX）整表读在此量级会读不动 / 内存爆**。
- depIndex（本节）只解决「二跳查找」的算法复杂度，**不解决「入金表本身能不能读进来」**。后者属于 linked-fx-bank-deposit-merge-import 的入金表导入链路（同 v3.0.5），须走**流式读取**（参考仓内既有流式 reader：`src/backend/big-table-import/`、`src/backend/pending-import/streaming-xlsx-reader.js`、`src/backend/pending-import/xlsx-size-preflight.js`）。
- 本需求**依赖** linked-fx 把入金表读进来（§九-前置），本需求侧只在「已读入的 depositRows」之上建 depIndex；流式读取本身不在本需求改动面，但**必须在文档协调段标注**，避免上线时入金表读不动导致全部二跳静默漏配。

---

## 九、前置依赖 linked-fx 协调与 rebase 顺序（spec §2.8）

> 🔴 **前置门槛（✅ 已全闭环，按序施工）**：`changes/linked-fx-bank-deposit-merge-import`（🔴🔴 资金红线）须**先合入 v3.0.5 分支**，本需求在其改造后的入金表 + 命中详情之上施工。代码顺序硬约束（linked-fx 先 → 本需求后）仍成立，但已不再是"未决阻塞"，而是"已拍板的按序施工"。
>
> ✅ **前置 spec 现状（2026-06-15 收口）= OPEN-1~7 全闭环可实施**：OPEN-1=BizId 键 / OPEN-2=交易编号单键 / OPEN-7a=export 成功后写命中标记 / OPEN-7b=**所有以入金表为来源的命中（含本需求 R3/R5/R6）** / OPEN-7c=专用列 `last_hit_run`/`last_hit_at`；与本需求 **D12 已决方案①**（linked-fx 侧建 OPEN-7 提醒机制，本需求命中点接入）双向闭合。dev 开工前只需确认 linked-fx 已合入 v3.0.5 即可按序施工。
>
> 四处硬交叉：

1. **「匹配命中详情」字段共改（同 `r5-refund-order-backfill.js:96` / `buildBackfillRow:90-103`）**：linked-fx 的 OPEN-7 机制（其 T5）会在 R5 场景4 回填行的 `匹配命中详情` **追加**「⚠️ 桥接入金表行 BizId=… 此前于 [last_hit_at] 已被命中，疑似历史残留」。本需求 O1（新增「命中类型」列）+ O2（删前缀 + S4 固定串）改的是**同一字段构造** → 命中详情终态 = **本需求文案 + OPEN-7 残留提醒叠加**，两边**不得互相覆盖**；`buildBackfillRow` 以 linked-fx 落地后形态为基线 rebase。
   - ⚠️ linked-fx OPEN-7 当前把残留提醒追加到 `r5-refund-order-backfill.js:96`（即旧 E 列「匹配命中详情」位）；O1 插入「命中类型」后该字段挪到第 6 列（F），dev rebase 时须确认 OPEN-7 注入点跟随到新的「匹配命中详情」键名（按 key 写，非按列号）。

2. **depositRows 语义变化（整表覆盖 → 跨次幂等累加，其 §3.1 / OPEN-1 键=BizId）**：累加后 `depositRows`（`main.js:3646` 注入源）含跨期残留行，候选入金行变多 → 本需求 R2/R3/R5/R6 四条二跳候选面随之扩大 → **误配 / 反向多笔报错概率上升**。depIndex 的 `Map<key, dep[]>` 已支持同键多值，但**风险画像变化**，样本回放须在「累加后入金表」语义下验收。

3. **OPEN-7 命中口径已扩到本需求新入口（其 OPEN-7b / 本 spec D12 已决方案①）**：本需求 R3（HK 二跳）/ R5（S3b）/ R6（S3c）都新增「以入金表行为命中来源」的路径，OPEN-7b 命中口径**已定为「所有以入金表为来源的命中」（含 R3/R5/R6）** → 经这些新策略命中的残留行**均触发残留提醒**，无可见性缺口。协调方案（D12 已采纳方案①）：在 linked-fx 侧建 OPEN-7 提醒机制（命中口径单一真相在 linked-fx 侧），本需求落地 R3/R5/R6 时把命中点接入该机制——命中即写 last_hit，载体对齐 linked-fx OPEN-7c 专用列（`last_hit_run`/`last_hit_at`），不双写。

4. **matchJpmUs 重构同文件交叉**：本需求 R3 把 matchJpmUs 抽成 `matchCustomerRefTwoHop` + depIndex；linked-fx T5 也改 `r5-refund-order-backfill.js`（注入 OPEN-7 提醒）→ **先 linked-fx 后本需求**，本需求基于其落地后行号 rebase。本文所有 `file:line` 出处为**当前（linked-fx 未落地前）**行号，实施时以 linked-fx 落地后为准。

> **rebase 顺序铁律**：linked-fx（T5 / OPEN-7）→ 本需求 commit ① ~ ⑧。本需求每个 commit 的「改动点行号」实施时重新定位。

---

## 十、任务分解与 8 commit 实施计划

> 前置：linked-fx 已合入 v3.0.5；R5/R6 正则已拍板（D1/D4，原件已到位）。每个功能 commit 一提交，后做方以先做方落地后实际行号为准。

| commit | message（建议）| 改动文件 | 单测增减 | 验证 |
|--------|---------------|---------|---------|------|
| ① 常量层 + O3/O4 | `[v3.0.5] feat: 退款回填模板扩列(REFUND_BANK_COLUMNS 9→10 + REFUND_RO_COLUMNS 15 + HEADERS 14→31 + ⊆25列断言)` | `refund-backfill-fields.js` + `buildBackfillRow` ro 循环 + `refund-backfill-writer.js` 注释 | `refund-backfill-fields.test.js`（9→10/14→31/列序/freeze/⊆签名）+ `refund-backfill-writer.test.js`（31 列投影 + Payment Detail + 15 ro 字段 + sheet2 提示行 `''`）| 列契约先稳；writer 端到端 |
| ② O1/O2 | `[v3.0.5] feat: 命中类型列(精准/模糊)透传 + 命中详情删前缀 + S4 固定串` | `r5-refund-order-backfill.js`（HIT_TYPE_*/S4_DETAIL_TEXT/strategyChain 改 {run,hitType}/consumeAndBackfill+buildBackfillRow 第4参/detail 函数）| `r5...test.js`：各层命中类型断言 + 去前缀 + S4 固定串 | 透传路径闭环 |
| ③ R1 + R3 | `[v3.0.5] feat: T54 提取正则放宽(/T54[A-Z]{4}\d{6}/) + matchCustomerRefTwoHop 抽取 + HK 二跳回落` | `refund-backfill-fields.js`(T54_REFUND_RE/删 T54SWIC_FEATURE/命名中性化) + `r5...js`(matchJpmHk/matchJpmUs/抽取) | R1 三前缀 + 旧值回归 + 收口；R3 HK FPS 4 例 + ChannelOrderNo 第二键 + 链顺序（T54 优先二跳）| 存量零漏配 |
| ④ R2 | `[v3.0.5] feat: S2b 独立层(附言含入金 CustomerRef) + 黑名单/最小长度守卫` | `refund-backfill-fields.js`(jpm 守卫子块) + `r5...js`(matchMemoContainsDepositRef + strategyChain L3) | R2 US 11 例 + HK 1 例 + 黑名单不触发 + 短 ref 守卫 + **分层保护断言** | 等值主流不被拖入报错 |
| ⑤ R4 | `[v3.0.5] feat: S4 单向容差 0~21(signedDayDiff/hasInWindowCandidate) + S4 夹具方向重造` | `engine-date-utils.js`(signedDayDiff) + `refund-backfill-fields.js`(toleranceDays 21) + `r5...js`(matchS4/调用点) | R4 边界 diff=0/21/22/−1 + **既有 S4 夹具按 ro.valueDate≤bank.BillDate 方向重造**（同提交，否则测试红）| dayDiffWithin 一行不动 |
| ⑥ R5/R6 | `[v3.0.5] feat: S3b(Drawee+DESC DATE) + S3c(附言原单日期金额币种) 二跳层 + no-op 防御` | `refund-backfill-fields.js`(s3b/s3c 子块) + `r5...js`(matchDraweeNameDate/matchMemoDateAmount + strategyChain L5/L6) | 二跳闭环 + 「正则未配置→层跳过」+ R6 多笔报错 + R6 锁定退出 S4 | 原件正则回放 |
| ⑦ depIndex | `[v3.0.5] perf: 入金索引 depIndex(byReconId/byChannelOrderNo 双 Map) 二跳 O(n)→O(1)` | `r5...js`(buildDepIndex/lookupDeposit + 各二跳匹配器改用 depIndex) | 「索引版与线性版 byte 级一致」断言 | 可二分定位 |
| ⑧ docs/守卫收口 | `[v3.0.5] docs: 三件套适配提示 + important-variables 注记 + backlog 沉淀` | CHANGELOG/VERSION_FEATURE_HISTORY/USER_GUIDE + `rules/important-variables.md` + `knowledge/backlog.md` | — | `npm run scan:vars` + `/check-vars` + `release-check` 全量 |

> 提 PR 前：`npm run scan:vars` + `/check-vars`（命中 `BANK_DEPOSIT_FIELDS`(Risk-sensitive)/`refundOrderSession`，R5 新增对 `dep.ValueDate` 读依赖须声明）+ `npm run release-check` 全量三层。引擎含 NUL 风险，review 用 `git diff --text` / `grep -a`（参考 main.js NUL 经验）。

---

## 十一、测试矩阵

### 11.1 对照 387 行样本分桶

| 桶 | 来源 | 行数 | 命中策略 | 验收 |
|----|------|------|---------|------|
| HK T54 | JPM HK | 153 | R1（L2）| T54SWIC/T54LCIC/T54CCBT 三前缀各 1 条回放命中 + 旧 T54SWIC 回归 + 「提取到但 ro 无等值→不命中」收口 |
| HK NONREF | JPM HK | 38 | S4（R4）| 边界 diff=0/21/22/−1 + 38 行无负 diff 合法对（R4 前置硬验收）|
| HK FPS 二跳 | JPM HK | 4 | R3（L2 回落）| bank.CustomerRef ↔ dep.CustomerRef → dep.ReconId == ro 打款流水号 + ChannelOrderNo 第二键 + 链顺序（T54 优先二跳）|
| HK 附言含客户流水 | JPM HK | 1 | R2（L3）| 同构回放命中 |
| US CustomerRef 等值 | JPM US | 165 | matchCustomerRefTwoHop（L2）| **既有 JPM-US 用例断言一行不改全过**（等值主线零回归）|
| US 附言含 CustomerRef | JPM US | 11 | R2（L3）| 11 例命中 + 黑名单不触发 + 短 ref 守卫 + **分层保护断言** |
| US Drawee+DATE | JPM US | 12 | R5（L5）| Drawee Name + DESC DATE ↔ dep.ValueDate 二跳闭环 + 「正则未配置→跳过」|
| US 原单日期金额 | JPM US | 3 | R6（L6）| 三 token 二跳闭环 + R6 多笔报错 + R6 锁定退出 S4 |

### 11.2 关键专项断言

- **R4 边界 diff diff（四态）**：diff=0 命中 / diff=21 命中 / diff=22 报错（`refund-backfill-date-over-tolerance`）/ diff=−1 报错（时序矛盾脏数据）。S4 既有夹具按「ro.valueDate ≤ bank.BillDate」方向重造（与 R4 同 commit ⑤）。
- **R2 分层保护断言**（最高优先验证）：构造 bankA 等值命中 ro X、bankB 附言含同 ref（也指向 X）→ 断言 **bankA 在 L2 回填 X、bankB 不在 L3（S2b）复抢 X**（等值层先消费锁定）。证明分层即分强度、US 165 行主流不被拖入反向多笔报错。
- **O1 各层命中类型**：S1/S2/S2b/S3/S3b 断言 `命中类型===精准命中`；S3c/S4 断言 `命中类型===模糊命中`。
- **O2 文案**：精确断言 detail 去 `匹配成功:` 前缀；S4 命中行 `匹配命中详情 === S4_DETAIL_TEXT`。
- **O4 列**：回填行含 Payment Detail 列 + 15 ro 字段；「流水号」与「退款单号」同值双列断言（内容重复系用户要求）。
- **R6 入金行金额取数 falsy(0) 陷阱**（§3.3 伪代码 `parseNumber(dep['Credit Amount']) || parseNumber(dep['Debit Amount'])`）：构造入金行 `Credit Amount=0` / `Debit Amount=有值` 夹具 → 断言取数走到 Debit（`0` 是 falsy 会触发 `||` 跳转，须确认这是期望行为而非把合法 0 金额误当缺失）；dev 实现期复核此口径，必要时改 `Credit!=null?Credit:Debit` 显式判空。
- **常量断言**：`REFUND_BANK_COLUMNS.length===10` 且含 Payment Detail；`REFUND_TEMPLATE_HEADERS.length===31` 且 = 6+10+15 三段拼接列序；`toleranceDays===21`；删 `T54SWIC_FEATURE`→换 `T54_REFUND_RE` 形态断言（`/T54[A-Z]{4}\d{6}/` + 「T54SWIC494867 仍被新正则匹配」+「T54LCIC/T54CCBT 也命中」）；`REFUND_RO_COLUMNS` 15 列顺序/freeze/⊆25 列签名。
- **depIndex byte 级一致**（commit ⑦）：同样本 depIndex 版与线性 `deps.find` 版 `backfillRows`/`unmatchedRows` 逐行逐键全等。
- **累加语义同键多 dep（commit ⑦ 输入构造）**：构造同一 ReconId/ChannelOrderNo 对应 ≥2 条 dep（linked-fx 跨期幂等累加后的残留场景）→ 断言 `lookupDeposit` 取首条 `[0]` 与旧 `deps.find` 取首条**语义一致**（纳入 byte 级一致断言的输入集，非仅 P1 口头）。
- **US 165 行回归（零回归证明）**：既有 `r5-refund-order-backfill.test.js` 的 JPM-US 用例断言**一行不改**全过。

### 11.3 样本回放 + 收口

- 387 行脱敏子集（HK 196 / US 191 按规则分桶取代表行；脱敏 = 对账号/流水号/客户号保形替换，保留命中关系）进 `tests/fixtures/`，作回放基线（D11 拍板）。
- 人工 `/verify` 一份同时含多策略命中 + S4 兜底 + 报错的真实样本，打开回填文件确认 31 列 + 命中类型 + 文案。

---

## 关键技术决策清单

1. **R1 正则修正为 `/T54[A-Z]{4}\d{6}/g`（直写，删 buildFeatureRegex 依赖）**：真实数据前缀 T54SWIC/T54LCIC/T54CCBT（T54+4字母+6数字），builder 表达不了「数字前缀+可变中段字母」；旧正则是真子集→存量零漏配，收口仍在 ro 银行打款流水号等值（`:167-171` 不变）。
2. **R2 必须独立成 L3 层（分层即分强度）**：附言 `.includes` 弱于等值；并入 matchCustomerRefTwoHop 会与 US 165 行等值命中进同一冻结快照触发同层反向多笔，拖垮主流。独立成层 + 黑名单 `['NOTPROVIDED','NONREF']` + 最小长度 6 守卫（D6）。
3. **R3 抽 matchCustomerRefTwoHop 共享、并入 L2 同层**：HK 的 T54 等值与二跳同强度，同层撞同一 ro 是真歧义（报错正确）；US 语义逐字不变。
4. **R4 另立 `signedDayDiff`，`dayDiffWithin` 一行不动**：后者被 fund-transfer `r5-fund-transfer-backfill.js:192` 共用双向语义，改它会破坏调拨回填。`minDayDiffToSet`→`hasInWindowCandidate` 三分支（报错含负 diff 时序矛盾脏数据）；toleranceDays 10→21 单向。
5. **R5/R6 正则常量化 + 「null 即整层 no-op」防御**：DESC DATE 取非 ENTRY DATE（D1）；R6 金额一律 `Math.round(amt*100)` 分比对，D13 OUR REF 强匹配不做。
6. **O1 命中类型 = 层属性透传（不动现有匹配器返回值形状，代码实测 7 个 `match*` 函数）**：`strategyChain {run,hitType}` → `consumeAndBackfill` 第4参 → `buildBackfillRow` 第4参；精准优先由层序保证。
7. **O3/O4 列契约 14→31（6+10+15）+ ⊆25 列签名启动断言**：表头名互异、内容可重复（用户要求）；sheet2 联动 12→13（提示行投影 `''`）；CHANGELOG 显式提示对外解析破坏。writer 零功能代码改动（仅注释）。
8. **F-PERF depIndex 双 Map + byte 级一致断言**：二跳 O(n)→O(1)；累加语义下 `Map<key,dep[]>` 支持同键多值，`lookupDeposit` 取首条与旧 `deps.find` 一致。
9. **⚠️ 入金表 65.7 万行/1.72GB SheetJS 读不动 = 独立工程风险**：depIndex 只解算法复杂度，不解「能否读进来」；流式读取归口 linked-fx/pending-import 链路，本需求依赖其把入金表读入。
10. **前置依赖 linked-fx 先合 + rebase**：命中详情字段共改（OPEN-7 残留提醒叠加不覆盖，按 key 写）；depositRows 累加语义；OPEN-7b 命中口径扩到 R3/R5/R6（D12 推荐 linked-fx 侧扩口径）；matchJpmUs 重构同文件→先 linked-fx 后本需求，行号实施时重定位。
