# PRD - 清结算小助手 v3.0.6（资金对账数据处理：调拨对账单派生 / 对账数据来源二选一 / DBS-Charge 资金校验 + charge-outbound 退役）

| 项 | 值 |
|---|---|
| 版本 | v3.0.6 |
| 状态 | 已实施（implemented） |
| 模块 | 资金对账数据处理（bank-statement / 5 轮对账编排） |
| 实施方式 | team-lead 拆分委托 dev 分 T1~T11 实施 |
| 质量门 | `npm run release-check` 全绿（unit 2803 / integration 30 脚本 / smoke 全模块 PASS） |

---

## 一、需求概述

v3.0.6 聚焦「调拨」对账，三需求 + 一项退役：

1. **需求1 调拨对账单派生**：「链接表管理」导入「中台调拨订单」（mid-allocation）后，自动派生隐藏表「调拨对账单」（一行中台单 → FundTransfer-in + FundTransfer-out 两行）。
2. **需求2 对账数据来源二选一**：「中台调拨订单对账ID回填」（R5 场景2）新增勾选框「对账数据来源为中台调拨单表」（默认勾选）。勾选 → 用调拨对账单匹配回填 `ReconciliationId`；取消 → 沿用原网关对账单（R5s2）。
3. **需求3 DBS-Charge 资金校验**：原全渠道「Charge转outbound」整体重写为 **DBS 渠道专属** 校验，对账编排新增 R3.5 轮（R3 后、R4 前）。
4. **charge-outbound 退役**（需求3 配套）：非 DBS 渠道不再有 charge→outbound；v3.0.4 块 G「同 reconid 多 Charge 取 Debit 最大行」逻辑移除；旧库该场景每次启动幂等删除。

🔴 **对外行为变更（存量用户升级产出会变）**：① 非 DBS 渠道不再 charge→outbound；② R5s2 默认数据源由网关 → 调拨对账单；③ DBS-Charge（R3.5）默认启用。

---

## 二、背景与目标

### 2.1 背景

- 「中台调拨订单对账ID回填」（R5 场景2，引擎 `r5-fund-transfer-backfill.js`）原以**网关对账单**为对手方匹配回填银行 `ReconciliationId`。中台调拨订单本身已含完整的「付款 / 收款」双向信息，可直接派生成对账对手方，省去对网关数据的依赖、并支持 DBS 这类靠调拨单识别资金性质的渠道。
- 原「资金性质校验-Charge转outbound」是**全渠道**子场景（有 R1 匹配且 `FundType=Charge` → `outbound`），v3.0.4 块 G 又给它加了「同一 ReconciliationId 多条 Charge 仅转 Debit Amount 最大行」的边界口径。真实业务里 charge / outbound 的判定只在 **DBS** 渠道需要、且要靠调拨对账单 + 网关两路证据，全渠道一刀切会误改其它渠道。

### 2.2 目标（必做）

- 导入中台调拨订单即派生调拨对账单（隐藏表，与 v3.0.4 BOC 两张派生表同构）。
- R5 场景2 支持「调拨对账单 / 网关对账单」二选一，默认调拨对账单，老库无字段视为勾选。
- 新增 R3.5「DBS-Charge 资金校验」，仅 DBS 生效，对称模型两步定 FundTransfer / outbound / Charge。
- 退役全渠道 charge-outbound（含 v3.0.4 块 G），旧库幂等清理。

### 2.3 明确不做（非目标）

- 不改其余四个资金性质子场景（Ach Return / Wire Return / HX-out / HX-in）行为。
- 不改原 R5s2 网关路（取消勾选路）的任何匹配口径——逐字保留。
- 不改 BOC 调拨订单修复、外汇交割表 / 入金表累加导入等 v3.0.4/v3.0.5 既有链路。
- 不动 `linked_table_meta` / `ALL_TABLE_KEYS` 用户可见表清单（调拨对账单是隐藏派生表）。

---

## 三、代码现状（必须有出处）

- 5 轮对账编排：`src/main-process/reconciliation-orchestrator.js`（`runReconciliation` / `bucketScenarios`）。
- R5 场景2 现状引擎：`src/main-process/scenario-engines/r5-fund-transfer-backfill.js`（网关对手方，含 `bankAmountAbs`）。
- 资金性质校验：`src/main-process/scenario-engines/r4-fund-nature-check.js`（原 5 子场景含 charge-outbound + v3.0.4 块 G）。
- 隐藏派生表先例：v3.0.4 BOC `linked_boc_fx_settlement` / `linked_boc_bank_deposit`（`migrations.js` DDL + `linked-table-repository.js` 白名单 + `adm-bank-deposit-builder.js` 派生纯函数 + `linked-derive-rebuild.js` 重建编排）。
- 写死场景 seed 先例：`ensureBocDispatchOrderScenarioSeed`（独立 marker 绕全局短路）。
- R5 场景2 UI：`src/renderer-dialogs.js`「请选择适用的银行渠道」弹窗（v3.0.4 Payment 勾选行 gating `subCategory==='fund-transfer-backfill'`）。

---

## 四、术语

- **中台调拨订单（mid-allocation）**：链接表「中台调拨订单」表库，含「付款账户（卡号）」「收款账户（卡号）」（**全角括号**）/ 交易时间 / 渠道流水号 / 付收渠道·金额·币种等。
- **调拨对账单（linked_fund_transfer_recon）**：需求1 派生的隐藏表，一行中台单 → in/out 两行。
- **大账号 `big_account`**：决策 D1 按方向固化的卡号（in=收款卡号 / out=付款卡号），下游与银行 `MerchantId` 比对。
- **R3.5**：对账编排新增轮次，R3 后 R4 前，承载 DBS-Charge 资金校验。
- **对称模型**：DBS-Charge 步骤1 用调拨对账单标 FundTransfer + 步骤2 用网关标 outbound、未命中归 Charge。

---

## 五、功能详细描述

### 5.1 需求1：调拨对账单派生 🔴

- **字段映射单一真相**：`src/constants/fund-transfer-recon-fields.js`（`FT_RECON_FIELD_MAP`）——`mid`（中台源列，含全角括号，逐字取自 `ZHONGTAI_DISPATCH_ORDER_SIGNATURE.expectedHeaders`）/ `recon`（派生字段：调拨单号 / BillDate / ReconID / 付款账号 / 收款账号 / 付收渠道 / 金额 / 币种 / `fund_type` / `big_account`）/ `FUND_TYPE_IN` / `FUND_TYPE_OUT`。
- **派生纯函数**：`src/main-process/fund-transfer-recon-builder.js`（`buildFundTransferReconRows`，仿 `adm-bank-deposit-builder.js`，不读 DB / 不碰 FS）——一行中台单 → in 行（渠道·金额·币种取收款侧）+ out 行（取付款侧），按「每单 in 行后接 out 行」顺序展开。
- **🔴 决策 D1（大账号按方向固化）**：in 行 `big_account` = 收款账户（卡号）、out 行 = 付款账户（卡号）；派生阶段写定，下游匹配引擎零方向分支。
- **建表 + 仓储 + facade**：`migrations.js`（`linked_fund_transfer_recon` DDL + 隐藏红线，不进 `ALL_TABLE_KEYS`/`linked_table_meta`）/ `linked-table-repository.js`（upsert + 读回）/ `database.js`（facade）。
- **派生编排 + 导入接线**：`linked-derive-rebuild.js`（中台调拨订单导入后派生重建）/ `main.js`（导入成功提示追加「已生成 N 条调拨对账单」，N=中台单行数×2）。

> 🔴 资金红线：中台源列全角括号「付款账户（卡号）」「收款账户（卡号）」半角化即取空 → `big_account` 全空 → 下游误命中 `MerchantId` 也为空的银行行（`valuesEqual('','')===true`）写错 `ReconciliationId`。故需求2 / 需求3 引擎均加 `big_account` 非空护栏。

### 5.2 需求2：对账数据来源二选一 🔴

- **新引擎**：`src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js`（`runRound5FundTransferReconBackfill`）——与原 R5s2 同口径，唯一差异对手方=调拨对账单 `reconRows`：
  - 调拨对账单 `fund_type=FundTransfer-out/in` 行 ↔ R4 后银行 `FundType` 同值行，命中回填调拨对账单 `ReconID` 进银行 `ReconciliationId`（标黄）。
  - 金额绝对值精确到分（复用 `bankAmountAbs`，禁重写）；两方向独立跑互不串池。
  - 日期两阶段：Phase1 严格同日（sameDay）先消费 → Phase2 仅未命中 recon 用 `±dateToleranceDays`（dayDiffWithin）兜底、按天数差升序稳定排序。
  - 严格 1v1（`usedBankRowId` 单向消费，含「消费但未写」行）；多候选 tie-break 同日优先 → 银行行原序最前 + warning。
- **编排器二选一 gating**：`reconciliation-orchestrator.js`——`config.reconSourceMid !== false`（默认勾选；老库无字段 undefined !== false → true → 勾选）→ 勾选路注入 `fundTransferReconContext.reconRows` 走新引擎；`=== false` → 取消路沿用 `runRound5FundTransferBackfill`（网关 `gwRows` 逐字保留）。
- **run 注入**：`main.js`（`bank-statement:run` 注入 `fundTransferReconContext`）。
- **seed 默认**：`migrations.js`——`fund-transfer-backfill` 场景 config 默认 `reconSourceMid: true`。
- **UI 勾选框**：`renderer-dialogs.js`——「对账数据来源为中台调拨单表」勾选行，仅 `subCategory==='fund-transfer-backfill'` 场景显示（与 Payment 行同 gating），加载口径 `cachedConfig.reconSourceMid !== false`。

### 5.3 需求3：DBS-Charge 资金校验（R3.5）🔴🔴

引擎 `src/main-process/scenario-engines/dbs-charge-fund-check.js`（`runDbsChargeFundCheck`），仅 `Channel=DBS` 生效，【对称模型】：

- **步骤1（调拨对账单 ↔ DBS 银行，标 FundTransfer + 赋 ReconciliationId + 归并 Charge）**：
  - `dbsBankRows` = bankRows.filter(Channel===DBS)（空 → 整体 no-op）。
  - `dispRows` = dispatchReconRows.filter(付款渠道===DBS && 收款渠道===DBS && `big_account` 非空）。
  - 按 `big_account` + 金额 + 币种**严格 1v1**（多候选取文件原序首行 + warning）；命中行 `FundType` 标为该调拨行 `fund_type`（FundTransfer-in/out）+ 赋 `ReconciliationId`；同 `ReconID` 其他行归 `Charge`。
  - 🔴 **两阶段化（防覆盖关键交互）**：一笔调拨单 in/out 行 `ReconID` 相同（都=渠道流水号），边匹配边归并会把刚标的 FundTransfer 命中行覆盖成 Charge。拆「阶段A 先匹配 + 标记（命中行入 `matchedBankRows` 保护集，记归并键）→ 阶段B 再归并」（对每个被赋 ReconID 的键，把「同 ReconId + 不在 matchedBankRows + FundType≠Charge」行置 Charge）。
- **步骤2（网关 amount/currency 找真正 outbound 行；同 ID 未命中行归 Charge）**：
  - 用步骤1 改后的新 `ReconciliationId` 关联网关；候选 = `FundType ∈ {Charge, outbound}`（步1 标的 FundTransfer-in/out 不在内、不被碰）。
  - 同 `ReconID` 网关 amount/currency 相等 → `outbound`；**未命中 → `Charge`**（语义翻转，不再「保持原值」）。
  - 最终每个 `ReconID` 桶 = 1 条 FundTransfer-in/out（步1命中）+ 网关确认的 outbound（步2命中）+ 其余全 Charge。
- **`chargeSiblingsScope` 默认 `dbs-only`**（步骤1 末归并仅遍历 DBS 渠道行；`'all'` 可切全渠道）。
- 改写 `ReconciliationId` + `FundType` 两列均 record 留痕标黄。
- **R3.5 编排接线**：`reconciliation-orchestrator.js`——`bucketScenarios` 把 `builtin-fixed + funcCategory==='dbs-charge-fund-check'` 分流到 `dbsChargeFundCheck` 桶（在 fund-nature-check / 兜底 else 之前命中）；`runReconciliation` 在 R3 后 R4 前跑 R3.5，**改后 `bankRows` 同一引用进 R4**（叠加链跨轮保留：R3.5 置 outbound 的 DBS 行进 R4 后 hx-out 可续改 outbound→HX-out）。`dispatchReconContext` **不受需求2 `reconSourceMid` 开关控制**，由 `main.js` 单独 `structuredClone` 注入；gating = `dbsChargeFundCheck` 桶非空（场景 enabled）。
- **写死场景 seed**：`migrations.js`——`DBS-Charge资金校验`（`is_builtin=1` / `category='builtin-fixed'` / `funcCategory='dbs-charge-fund-check'` = R3.5 分流键 / `subCategory='dbs-charge-fund-check'` = seed 幂等定位键，区别于已退役 `'charge-outbound'` / `bankChannel='DBS'` / `dispatchChannelValue='DBS'`），**默认 `enabled=1`**；独立 marker `dbs_charge_fund_check_scenario_seeded`（绕全局 marker 短路），老库补种。

### 5.4 charge-outbound 退役（需求3 配套）🔴

- `r4-fund-nature-check.js`：内置子场景 5 → 4，移除 `charge-outbound` 子场景及 v3.0.4 块 G「仅转 Debit Amount 最大行」边界口径；R4 退化为纯叠加链（其余四子场景零变化）。
- `migrations.js`：`retireChargeOutboundOrphans` 每次启动**幂等 DELETE** 旧库已 seed 的 `charge-outbound` 条目（含级联删 `scenario_applicable_channels` 关联行）；R4 seed 由 5 → 4。

---

## 六、关键决策（用户拍板）

| # | 决策点 | 拍板 |
|---|---|---|
| D1 | 调拨对账单大账号 `big_account` 取值 | **按方向固化**：in=收款卡号 / out=付款卡号（派生阶段写定，下游匹配引擎零方向分支） |
| D2 | DBS-Charge 步骤1 末归并范围 `chargeSiblingsScope` | 默认 **`dbs-only`**（仅 DBS 渠道行；保留 `'all'` 可切全渠道） |
| D3 | DBS-Charge 资金性质判定模型 | **对称模型**——步骤1 用调拨对账单标 FundTransfer-in/out、步骤2 用网关标 outbound；**步骤2 未命中归 `Charge`**（语义翻转，替代早期「保持原值」方案） |
| D4 | 步骤1 in/out 同 ReconID 归并次序 | **两阶段化**（阶段A 先匹配标记入保护集 → 阶段B 再归并），防 out 行归并覆盖 in 行 FundTransfer 命中 |
| D5 | 需求2 二选一默认值 | **默认勾选「中台调拨单表」**（`reconSourceMid !== false`，老库无字段视为勾选） |
| D6 | 需求3 数据源是否受需求2 开关控制 | **不受**——DBS-Charge 总需调拨对账单，`dispatchReconContext` 独立注入（gating=场景 enabled） |
| D7 | 调拨对账单是否进用户可见表清单 | **否**（隐藏派生表，不进 `ALL_TABLE_KEYS`/`linked_table_meta`，与 BOC 派生表同构） |

---

## 七、实施文件清单

### 新增（源码）

| 文件 | 作用 |
|---|---|
| `src/constants/fund-transfer-recon-fields.js` | 需求1 跨表字段映射单一真相（`FT_RECON_FIELD_MAP`） |
| `src/main-process/fund-transfer-recon-builder.js` | 需求1 派生纯函数 `buildFundTransferReconRows`（in/out 两行 + D1） |
| `src/main-process/scenario-engines/r5-fund-transfer-recon-backfill.js` | 需求2 新引擎（对手方=调拨对账单，与 R5s2 同口径） |
| `src/main-process/scenario-engines/dbs-charge-fund-check.js` | 需求3 R3.5 引擎（对称模型两步） |

### 变更（源码）

| 文件 | 改动 |
|---|---|
| `src/backend/database/migrations.js` | 需求1 建表 + 隐藏红线；需求2 seed `reconSourceMid:true`；需求3 DBS-Charge 写死场景 seed（默认 enabled=1）+ 独立 marker；charge-outbound R4 seed 5→4 + `retireChargeOutboundOrphans` 幂等删除 |
| `src/backend/database/linked-table-repository.js` | 需求1 调拨对账单 upsert + 读回 |
| `src/backend/database.js` | 需求1 facade |
| `src/main-process/linked-derive-rebuild.js` | 需求1 中台调拨订单导入后派生重建 |
| `src/main-process/reconciliation-orchestrator.js` | 需求3 R3.5 接线（`bucketScenarios` 分流 + R3 后 R4 前跑）；需求2 二选一 gating |
| `src/main-process/scenario-engines/r4-fund-nature-check.js` | charge-outbound 退役（5→4 子场景，移除 v3.0.4 块 G 边界） |
| `src/main.js` | 需求1 导入提示「已生成 N 条调拨对账单」；需求2 `fundTransferReconContext` 注入；需求3 `dispatchReconContext` 独立 structuredClone 注入 |
| `src/renderer-dialogs.js` | 需求2 UI 勾选框「对账数据来源为中台调拨单表」（默认勾选 gating） |

### 测试

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `tests/unit/main-process/fund-transfer-recon-builder.test.js` | 24 | 需求1 派生 in/out 字段映射 + D1 大账号方向 + 全角括号列名取值 |
| `tests/unit/backend/database/linked-fund-transfer-recon.test.js` | 10 | 需求1 建表 / upsert / 读回 / 隐藏红线 |
| `tests/unit/main-process/scenario-engines/r5-fund-transfer-recon-backfill.test.js` | 46 | 需求2 新引擎日期两阶段 + 严格 1v1 + 金额分比对 |
| `tests/unit/main-process/reconciliation-orchestrator-fund-transfer-recon.test.js` | 11 | 需求2 编排器二选一 gating（默认勾选 / 取消沿用网关 / 老库无字段视为勾选） |
| `tests/unit/main-process/scenario-engines/dbs-charge-fund-check.test.js` | 52 | 需求3 对称模型（步1 两阶段防覆盖 + 步2 未命中归 Charge + chargeSiblingsScope dbs-only + DBS 空/调拨空 no-op） |
| `tests/unit/main-process/reconciliation-orchestrator-dbs-charge.test.js` | 14 | 需求3 R3.5 接线（R3 后 R4 前、改后 bankRows 进 R4 叠加链） |
| `tests/unit/backend/database/migrations-dbs-charge-fund-check-seed.test.js` | 14 | 需求3 seed 默认 enabled=1 + 独立 marker 补种 |
| `tests/unit/main-process/linked-derive-rebuild.test.js`（扩） | — | 需求1 派生重建编排 |
| `tests/unit/backend/database/migrations-recon-round-seed.test.js`（改） | — | charge-outbound 退役 + R4 5→4 + DBS-Charge seed |
| `tests/unit/main-process/scenario-engines/r4-fund-nature-check.test.js`（改） | — | charge-outbound 退役（移除块 G 边界用例，四子场景零回归） |
| `tests/unit/renderer-dialogs-payment-offline-backfill.test.js`（扩） | — | 需求2 UI 勾选框默认勾选 + gating |
| `tests/unit/main-process/reconciliation-orchestrator-payment-offline.test.js`（改） | — | R5s2 二选一与 Payment 行共存 |
| `tests/unit/main-process/reconciliation-orchestrator.test.js`（改） | — | R3.5 轮次统计 + 编排顺序 |

---

## 八、数据 / 状态 / 安全影响

- **新表**：`linked_fund_transfer_recon`（隐藏派生表，中台调拨订单导入触发重建；不进用户可见表清单）。
- **场景 seed 变更**：新增写死场景 `DBS-Charge资金校验`（默认 enabled=1）；R4 资金性质子场景 5→4；旧库 `charge-outbound` 条目每次启动幂等 DELETE（含级联删关联表）。
- **config 字段**：`fund-transfer-backfill` 场景新增 `reconSourceMid`（默认 true）；config_json 自由 JSON 承载，无需 DB migration、不 bump bundleVersion（老库无字段缺省视为勾选）。
- **🔴 资金红线**：需求1 派生表是需求2 / 需求3 数据来源（大账号按方向取卡号、全角括号列名漂移=大账号全空）；需求2 / 需求3 均改写银行 `ReconciliationId`（需求3 还改 `FundType`）；需求3 R3.5 在 R4 前演化 `bankRows` 同一引用（叠加链跨轮保留）。

---

## 九、风险提示（人工复核）

- 🔴🔴 **需求3 DBS-Charge** 改写 DBS 银行行 `ReconciliationId` + `FundType`，对称模型两步定性，**升级后用真实 DBS 数据人工核对一份样本**。
- 🔴 **需求2 默认数据源变更**：存量用户升级后默认走调拨对账单；依赖网关回填的需到场景「管理」弹窗取消勾选，且须先导入「中台调拨订单」派生数据源。
- 🔴 **charge-outbound 退役**：非 DBS 渠道升级后产出变化（原被改写行保持 Charge，下游 HX-out 链行数减少），依赖旧全渠道行为的对账口径需重新核对。
- 🔴 **全角括号列名**：中台调拨订单模板「付款账户（卡号）」「收款账户（卡号）」列名不可半角化（否则大账号全空、对账错配）。

---

## 十、对外行为变更（合并适配提示）

| # | 变更 | 影响面 |
|---|---|---|
| ① | 非 DBS 渠道不再 charge→outbound（charge-outbound 退役，含 v3.0.4 块 G） | 存量非 DBS 渠道主输出 FundType 改写行数减少、下游 HX-out 链减少；旧库场景条目幂等删除 |
| ② | R5 场景2 默认数据源由网关 → 调拨对账单（需求2） | 存量用户升级后默认走调拨对账单；依赖网关须取消勾选 + 先导中台调拨订单 |
| ③ | 新增 R3.5「DBS-Charge资金校验」（默认启用，改 DBS 行 ReconciliationId + FundType） | DBS 渠道资金性质判定由 R3.5 承接；DBS 空/调拨空时 no-op 零影响 |

---

## 十一、待澄清问题

- 本迭代决策点全部已拍板（D1~D7 见 §六），无未决问题。
- 实施期待核（非决策）项：网关侧交易类型真实取值字符串与实际数据一致性，沿用既有内置默认值（与 v3.0.4 同口径，留待真实数据核对）。

---

## 十二、验证证据

- `npm run test:unit`：**2803/2803 PASS**（v3.0.5 基线 2673 → v3.0.6 新增需求1/2/3 专项 + charge-outbound 退役改造单测）。
- `npm run release-check`：全绿（unit 2803 / integration 30 脚本 / smoke 全模块 PASS）。
- `package.json.version` 无相关测试断言（仅 `scripts/scan-vars.js` 读 `pkg.version` 用于统计报告）。
