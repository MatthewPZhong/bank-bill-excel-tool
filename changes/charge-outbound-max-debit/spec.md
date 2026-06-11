# Spec — charge-outbound-max-debit Charge转outbound 多行取 Debit Amount 最大行（R4 子场景行为变更）

> status: implemented（v3.0.4 分支，2026-06-11，commit 9387655；r4 单测 26→35 全绿 + 全量 2390/2390；CHANGELOG 对外契约变更第 ⑦ 条 + 手测清单块 G 已落）
> owner: pzhong
> created: 2026-06-11
> updated: 2026-06-11
> 目标版本：**v3.0.4**（用户原话：「并入3.0.4里做」）
> 性质：🔴 **资金红线**（R4 资金性质校验 FundType 改写语义变更——由「同桶全转」收紧为「仅转一行」，直接影响主输出 FundType 列与下游链式改写）。
> 来源：用户 2026-06-11 需求原文：「Charge转outbound功能变更：银行单ReconciliationId存在多条行数据时，取Debit Amount值最大的那行转outbound」。调研：1 探索 agent（file:line 实读核验）。

---

## 1. 背景与需求

「Charge转outbound」是 R4「资金性质校验」引擎（五轮对账第 4 轮）五个内置子场景之一：R1 对账匹配成功的网关行所关联的银行行，若 `FundType==='Charge'` 则改写为 `'outbound'` 并标黄。

**现状**：同一 ReconciliationId 关联多条银行行时，**每一条** FundType='Charge' 的行都被转为 outbound（逐条跑 handler，各产一条 modification）。

**变更**：同一 ReconciliationId 存在多条行数据时，只取 **Debit Amount 值最大**的那一行转 outbound，其余行不转。

## 2. 代码现状（出处，经探索 agent 实读核验）

- R4 引擎：`src/main-process/scenario-engines/r4-fund-nature-check.js`，主函数 `runRound4FundNatureCheck`（:85-155）。Step2 建 `bankByReconId: Map<key, bankRow[]>`（同 key 多条按原序入桶，:113-133 注释明示「逐条都跑 handler」）；Step3 对每个 R1 命中网关行取桶内全部银行行逐条 `applyHandler`，命中即原地改写 `bankRow.FundType` + `modCollector.record`（标黄）。
- charge-outbound 场景 config（seed：`migrations.js:1457-1468`）：`{ subCategory:'charge-outbound', requireBankFundType:'Charge', setFundType:'outbound', priority:1 }`——**仅凭 R1 匹配 + 银行 FundType='Charge' 即命中，不校验网关 TradeType**（v2.1.16-beta.2 PRD §八 Q3 既定拍板）。
- 多行现状测试锁：`tests/unit/main-process/scenario-engines/r4-fund-nature-check.test.js` 测试④（:235-251）——同 reconid 三行（Charge/Charge/Inbound）→ 前两条都转、第三条不转、2 条 modification。**本变更将改写该测试**。
- 链式改写：同一行转 outbound 后可被 hx-out 子场景续改 outbound→HX-out（测试②，:160-204）——本变更后未被选中的 Charge 行不再进入该链（语义随动）。
- Debit Amount 解析先例：`parseNumber`（非数值 fallback 0），字段名 `'Debit Amount'` 含空格驼峰；金额比较精确到分（转分先例）。charge-outbound 现状**不读任何金额字段**。
- R4 引擎返回形态：`{ modifications }`，无 warnings 通道。

## 3. 决策表（按需求字面 + 项目既定口径取默认，spec review 时可推翻）

| # | 决策点 | 拍板 |
|---|---|---|
| G1 | 变更范围 | **仅 charge-outbound 子场景**（需求标题字面）；其余四个 R4 子场景（ach-return/wire-return/hx-out/hx-in）保持「逐条全转」现状 |
| G2 | 「取最大」的候选集 | 同 ReconciliationId 桶内 **FundType='Charge'（即满足 requireBankFundType）的行**中取 Debit Amount 最大者；非 Charge 行从不参与（备选解读「全桶取最大、最大行非 Charge 则整桶不转」会让功能静默失效，不取） |
| G3 | 实现取径 | 引擎按 `config.subCategory==='charge-outbound'` 应用「多行取最大」规则——**零 migration、零 config schema 变更**（存量库 seed 已 marker 化不可重 seed，config 字段化需 UPDATE config_json 迁移，成本不成比例；config 字段化留 backlog） |
| G4 | Debit Amount 解析 | `parseNumber` 非数值/空 fallback 0（与 `bankAmountAbs` 先例同口径）；比较用转分精度（`Math.round(*100)`） |
| G5 | 并列最大（多行同最大值） | 桶内**原序首行** first-wins（与 R5s2 tie 口径一致），不新增 warning 通道（R4 无该通道，引擎注释说明即可） |
| G6 | 单行桶 | 桶内仅一条 Charge 行 → 行为与现状一致（转），「多条行数据时」的判定 = 候选集行数 > 1 时才触发挑选，=1 时直接转 |
| G7 | 选择粒度 | 按「网关行 × ReconciliationId 桶」为单位挑选：同一桶被多个网关行命中时，每次遍历对同一候选集会选出同一行（确定性）；该行已是 outbound 后重复命中为 no-op（旧值==新值不 record，现状守卫沿用） |

## 4. 功能点（引擎改动详设）

`r4-fund-nature-check.js` Step3 内，对 `scenario.config.subCategory==='charge-outbound'` 的场景改变行级遍历语义：

```
对每个 R1 命中网关行的 relatedBankRows（同 reconid 桶）：
  对每个 scenario（priority 降序，现状不变）：
    若 scenario.subCategory !== 'charge-outbound'：
      现状逻辑不变（逐条 applyHandler）
    否则（charge-outbound 专属）：
      candidates = relatedBankRows 中 normalizeCellValue(FundType)==='Charge' 的行   // G2
      若 candidates.length === 0 → 跳过
      若 candidates.length === 1 → target = candidates[0]                            // G6
      否则 target = candidates 中 toCents(Debit Amount) 最大者（并列取原序首行）      // G4/G5
      仅对 target 行执行 applyHandler 改写（FundType→'outbound'）+ record 标黄；
      其余 candidates 不改写、不 record（自然不进 hx-out 链式改写）
```

- 实现保持引擎纯函数、入参形态/返回形态零变化；`applyHandler` 本体不改（挑选逻辑在调用侧）。
- 引擎头注释补充：charge-outbound 子场景的多行挑选规则 + G5 tie 口径 + 「其余子场景维持逐条全转」防误扩散。
- 工具函数 `toCents`/Debit Amount 字段名引用既有常量或就地常量（随 R4 文件内现状风格，禁手敲散落字符串）。

## 5. 边界情况

1. 桶内多条 Charge 且 Debit Amount 全为空/非数值 → 全部解析为 0，并列取原序首行（G5）。
2. 桶内 Charge 与非 Charge 混合 → 非 Charge 行从不参与候选与改写（与现状一致，测试④ b3 语义保留）。
3. 目标行旧值已 = 'outbound'（理论不可达：候选集要求 ='Charge'）→ no-op 守卫沿用。
4. 同桶被多个网关行重复命中 → 第二次选出同一 target，已转则 no-op（G7），不会改写第二条。
5. 链式交互：target 行后续可被 hx-out 续改（现状链保留）；未选中行停留 Charge，不进链。
6. 负数 Debit Amount（理论场景）→ 按数值比较取最大（-5 < 0 < 3），不做绝对值。

## 6. 测试计划

- **改写测试④**（多行现状锁）：同 reconid 三行（Charge[Debit 10]/Charge[Debit 99]/Inbound）→ 仅 Debit 99 行转 outbound，1 条 modification；原「全转」断言删除。
- 新增用例：①并列最大取原序首行；②Debit Amount 空/非数值 fallback 0；③单行桶行为不变；④非 charge-outbound 子场景（如 ach-return）同桶多行仍逐条全转（G1 范围锁）；⑤链式：target 行 outbound→HX-out 仍成立、未选中 Charge 行不进链（改造测试②或新增）；⑥同桶双网关行命中只转一行（G7）；⑦金额转分比较（10.005 vs 10.01 边界）。
- 既有测试①③⑤⑥⑦（单场景命中/no-op/priority/空入参/applyHandler 纯函数）零改动全过。
- 回归：`npm run test:unit` 全量 + orchestrator 测试 + smoke（release-check）。

## 7. 影响范围与风险

- **改动文件**：`src/main-process/scenario-engines/r4-fund-nature-check.js` + `tests/unit/main-process/scenario-engines/r4-fund-nature-check.test.js`（2 文件）。零 migration、零 IPC、零 renderer、零 main.js。
- 🔴 **对外行为变更（CHANGELOG 必注明）**：存量用户同 reconid 多条 Charge 行的文件，升级后主输出从「多行 FundType 全改 outbound 全标黄」变为「仅 Debit Amount 最大一行改写标黄」；下游 hx-out 链产出的 HX-out 行数随之减少。
- 风险缓解：测试矩阵锁定 G1-G7 全部口径；`/check-vars` 预计命中 R4 引擎/FundType 域条目；手测清单补一条真实样本人工核对（多行桶只转最大行）。
