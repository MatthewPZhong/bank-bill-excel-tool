# v3.1.1 子规范 2：调拨方向与日期防误匹配

> status: implemented；真实/脱敏资金样本人工复核与自动发布门禁已完成
> scope: R3.5、R4、R5s2、调拨回填管理页
> excludes: 工具箱格式引擎、平盘对账数据处理、R5s2b/R5s3/R5s4
> updated: 2026-07-29

## 0. Task Brief

### Goal

- 防止银行真实 Credit 流水被错误改成 `FundTransfer-out` 或 `Charge`。
- 防止银行真实 Debit 流水被错误改成 `FundTransfer-in`。
- 让 R3.5、R4、R5s2 共用同一套不可绕过的银行借贷方向校验。
- 在“中台调拨订单对账ID回填”管理页配置统一的调拨日期匹配策略，并同步作用于 R3.5 Step1、R5s2 两种来源和多对多只读审计。

### Context

- R3.5 Step1 当前候选只核对未消费、账号、币种、金额，随后立即统计多候选并占用银行行；没有校验银行真实 Credit/Debit，也没有日期条件。
- R3.5 Stage B 当前只按同 ReconID、未保护、非 Charge 批量改写，Credit/Inbound sibling 存在被改成 Charge 的旁路。
- R4 已在完整候选评估中严格核对方向、ReconID、账号、币种、金额和 Extra Fee。
- R5s2 网关来源和调拨对账单来源当前只用 `FundType` 分方向池，没有重新核验银行真实 Credit/Debit。
- 现有 R5 日期契约是“全局同日优先，再前后 `±N` 天”，Phase2 按绝对日期差排序。

### Constraints

- 本 PR 不修改工具箱 Excel 读写引擎。
- 不修改“平盘对账数据处理”中的 `Others`、`Revenue Clear`、`From TREASURY FUND`；它们不属于本次 R5s2。
- 不修改 R3.5 Step2 的网关白名单、金额、币种和现有 Credit 守卫。
- 不修改 R5s2b Payment 线下调拨、R5s3 中台入金剔除、R5s4 退款回填。
- 不把方向安全闸门做成可关闭的场景配置。
- 不改变 R5 多对多检测器“偏宽、只读审计”的既有定位。
- 日期继续使用前后对称 `±N`；本次不增加“银行日期晚于调拨日期优先”的新业务偏好。

### Done when

- R3.5 Step1 与 R5s2 的 1:1 候选只有在账号、币种、金额、日期（启用时）、真实借贷方向和未消费状态全部通过后，才可能被选择、消费或修改。
- R4 继续执行其既有 ReconID、账号、币种、金额、Extra Fee 与方向完整候选口径；R3.5 Stage B 继续执行既有 ReconID/DBS/sibling 范围并新增严格 Debit 守卫，不把 Step1 的日期条件错误扩散到这两条路径。
- 问题样本中的 Inbound 行不再被改成 `FundTransfer-out` 或 `Charge`。
- R5 关闭时，R3.5 仍使用管理页已保存的日期策略。
- 同 ReconID、同账号、同币种、同金额但银行方向相反的行能够被严格分流。
- 定向单测、集成测试、真实/脱敏样本人工复核、`npm run release-check` 和 `npm run check:vars` 完成。

## 1. 范围

### 1.1 纳入

- `dbs-charge-fund-check.js`
  - R3.5 Step1 候选与日期两阶段。
  - R3.5 Stage B Charge sibling 方向守卫。
- `r4-fund-nature-check.js`
  - 复用统一方向校验器，行为保持。
- `r5-fund-transfer-backfill.js`
  - R5s2 网关来源。
- `r5-fund-transfer-recon-backfill.js`
  - R5s2 调拨对账单来源。
- `main.js`
  - 从含 disabled 的完整场景集合解析日期策略、生成运行/导出快照，并把策略显式注入编排器。
- `reconciliation-orchestrator.js`
  - 只消费主流程已解析的不可变日期策略，不自行访问数据库或决定 owner。
- `many-to-many-detector.js`
  - 仅同步日期启停/容差；方向宽口径保持不变。
- `renderer-dialogs.js`、场景仓储和配置包旁路
  - 调拨回填管理页和全渠道约束。

### 1.2 明确排除

- `position-reconciliation` 模块及其 `Others / Revenue Clear / From TREASURY FUND` 规则。
- R3.5 Step2。
- R5s2b、R5s3、R5s4。
- 工具箱合并/拆分格式保真；见独立 Spec B。
- 把方向规则开放为 `directionRequired:false` 或任意用户配置。

## 2. 统一银行方向契约

### 2.1 唯一校验器

新增共享纯函数：

```javascript
validateBankDirection(bankRow, expectedDirection)
```

`expectedDirection` 只允许：

- `DEBIT`
- `CREDIT`

返回至少包含：

```javascript
{
  ok: boolean,
  code: 'ok'
    | 'expected-empty'
    | 'expected-invalid'
    | 'expected-zero'
    | 'opposite-invalid'
    | 'opposite-nonzero'
    | 'unsupported-direction'
}
```

校验器使用十进制金额解析，不得用 `parseNumber(value) || 0` 把非法值静默当 0。

### 2.2 严格矩阵

| 类型/用途 | `expectedDirection` | 主侧 | 另一侧 |
|---|---|---|---|
| `FundTransfer-out` | `DEBIT` | Debit 合法且非零 | Credit 为空或合法零 |
| `FundTransfer-in` | `CREDIT` | Credit 合法且非零 | Debit 为空或合法零 |
| `Ach Return` | `DEBIT` | Debit 合法且非零 | Credit 为空或合法零 |
| `Wire Return` | `CREDIT` | Credit 合法且非零 | Debit 为空或合法零 |
| `HX-out` | `DEBIT` | Debit 合法且非零 | Credit 为空或合法零 |
| `HX-in` | `CREDIT` | Credit 合法且非零 | Debit 为空或合法零 |
| R3.5 Stage B 置 `Charge` | `DEBIT` | Debit 合法且非零 | Credit 为空或合法零 |

- 主侧负数按绝对值判定非零并参与既有金额比较。
- 双侧非零、双侧为零、主侧为空、主侧非法、另一侧非法均失败关闭。
- 银行行当前 `FundType` 不能替代真实借贷方向校验。
- 未知方向或未知 R5 `bankFundType` 必须失败关闭并产生一次配置告警，不得为兼容而绕过方向。
- 方向映射是代码级安全常量；场景配置只能保留既有 TradeType 与 FundType 路由，不能关闭校验。

### 2.3 严格候选资格

定义两个互斥用途的集合：

- `nearCandidates`：只用于生成可审计的方向/日期失败原因。
- `eligibleCandidates`：真正可被匹配的严格候选。

银行行只有同时满足以下条件，才能进入 `eligibleCandidates`：

1. 未被本轮消费；
2. 账号非空且相等；
3. 币种非空且相等；
4. 金额按该引擎既有口径相等；
5. 日期策略启用时日期合法且满足当前 Phase；
6. `validateBankDirection(...).ok === true`；
7. 该引擎原有的 ReconID、TradeType、FundType、Extra Fee 等专属条件全部通过。

其中日期条件只适用于显式接收 `fundTransferDatePolicy` 的 R3.5 Step1 与 R5s2 写入引擎；R4 和 R3.5 Stage B 分别以第 4 节和 3.3 节为唯一条件，不新增日期门禁。

只有 `eligibleCandidates` 可以参与：

- `cand.length` 和多候选告警；
- 日期排序和 `chosen`；
- `usedBankRows`、`usedBankRowIds`、`consumedBankRows`；
- `matchedPairs`、R3.5 保护集；
- `FundType` / `ReconciliationId` 改写和标黄。

方向失败行可以出现在 `nearCandidates` 的诊断中，但不得进入候选数量、排序、选择、消费、配对、保护集或任何字段修改。

## 3. R3.5

### 3.1 Step1 候选

- 调拨行方向仍由派生表 `fund_type` 决定：
  - `FundTransfer-in` → `CREDIT`
  - `FundTransfer-out` → `DEBIT`
- 调拨日期使用 `FT_RECON_FIELD_MAP.recon.billDate`；该字段由中台调拨订单“交易时间”派生。
- 账号继续使用按方向固化的 `big_account`，币种、金额沿用既有字段与比较精度。
- 银行方向必须进入 `eligibleCandidates` 谓词，不得在 `chosen` 或消费后补验。

### 3.2 日期两阶段

日期启用时必须按全局两阶段执行，不能对每条调拨行依次“同日→容差”：

1. Phase1：所有可参与调拨行先完成严格同日匹配；
2. Phase2：只有 Phase1 未命中的调拨行，才能匹配仍未消费且处于 `±N` 天内的银行行。

Phase2 固定排序键：

```text
[abs(bankDate - counterpartDate), 银行原始行序]
```

- `-N <= bankDate - counterpartDate <= N`，边界包含。
- 正负日期差绝对值相同时不增加未来侧偏好，继续按银行原始行序选择并保留多候选告警。
- 日期启用但任一侧日期为空或非法时，不得降级为忽略日期。
- 日期关闭时完全跳过日期条件，但账号、币种、金额、方向和未消费条件仍必须通过。

示例：调拨日期 `260701`、`N=7` 时，银行 `260708` 为 `+7`，可进入日期候选；`260709` 为 `+8`，不可进入。

### 3.3 Stage B

- 继续只处理阶段A实际形成的非空 ReconID 键。
- 继续排除所有 Step1 实际命中的保护行。
- 继续遵守 `chargeSiblingsScope` 的 DBS 范围约束。
- 新增硬条件：目标 sibling 必须通过严格 `DEBIT` 校验。
- 同 ReconID 的 Credit/inbound、双侧异常、双零、非法金额行保持原值，不得改成 `Charge`，也不得伪造 modification。

### 3.4 Step2

完全保持现状：

- 网关 TradeType 白名单不变；
- 候选 FundType 范围不变；
- 现有 Credit 守卫、金额、币种和 `outbound → Charge` 回落语义不变；
- 不复用本次 Step1/Stage B 新增规则改变 Step2 口径。

## 4. R4

- `R4_RULES_BY_SUBCATEGORY` 继续固定四类业务路由，不读取可漂移的方向配置。
- 将当前方向解析替换为共享 `validateBankDirection`，但完整候选仍必须额外通过：
  - ReconID；
  - MerchantId；
  - Currency；
  - 方向主侧金额；
  - signed Extra Fee；
  - 网关 amount。
- R4 可以评估同 ReconID 的宽行集合以形成失败原因，但只有完整通过的 `matched` 集合能参与多候选、消费和 `matchedPairs`。
- no-op 命中仍产生具体 `matchedPairs` 并消费银行行，但不产生 modification、不标黄。
- Ach Return、Wire Return、HX-out、HX-in 与 R5 退款过滤的既有具体配对契约不变。

### 4.1 共享校验器兼容映射

切换共享校验器不得改变 R4 既有告警 code、数量和归类：

| `validateBankDirection.code` | 是否阻断 `matched` | R4 既有失败原因 | 是否额外产生 `r4-fund-direction-mismatch` |
|---|---:|---|---:|
| `expected-empty` / `expected-invalid` | 是 | 保持“主侧为空或不是合法金额” | 否 |
| `expected-zero` | 是 | 保持“主侧为0” | 否 |
| `opposite-invalid` | 是 | 保持“另一侧不是合法金额” | 是 |
| `opposite-nonzero` | 是 | 保持“另一侧非0” | 是 |
| `unsupported-direction` | 是 | 配置级失败关闭，不逐行制造新告警 | 否 |

- `r4-fund-match-mismatch` 的既有生成条件和聚合原因保持不变。
- 只有现状已经标记 `directionMismatch=true` 的两类“另一侧”失败，才继续产生 `r4-fund-direction-mismatch`。
- 必须使用 golden 测试锁定 warning code、条数、reason 文本和 `matchedPairs`；共享函数的内部 code 不得直接泄漏成一套新的 R4 报告口径。

## 5. R5s2

### 5.1 作用域

仅修改两条 FundTransfer 回填路径：

- 网关来源：`FundTransfer-out/in` 网关行 ↔ 银行行。
- 调拨对账单来源：`FundTransfer-out/in` 调拨行 ↔ 银行行。

不纳入 `Others`、`Revenue Clear`、`From TREASURY FUND`，也不修改 R5s2b/R5s3/R5s4。

### 5.2 银行池与候选

- 银行 `FundType === dir.bankFundType` 只是路由条件，不是方向事实。
- `FundTransfer-out` 银行池必须额外通过 `DEBIT`。
- `FundTransfer-in` 银行池必须额外通过 `CREDIT`。
- Extra Fee、账号、币种、金额、日期和 1:1 条件保持既有口径。
- “ReconID 非空”只指回填来源：
  - 网关来源的 `reconciliationid` 必须非空；
  - 调拨对账单来源必须通过 `FT_RECON_FIELD_MAP.recon.reconId` 读取实际字段 `ReconID`，且值必须非空；
  - 空来源行不得进入 source pool，不匹配、不告警占位、不消费银行行。
- 银行目标 `ReconciliationId` 不是候选前置条件：
  - 目标为空或与来源不同，完整命中后按既有语义写入/覆盖并记录真实 modification；
  - 目标已与来源相同，完整命中仍消费银行行，但不 record、不标黄；
  - 不存在“空来源完整命中后只消费不写”的合法路径。
- 方向错误行不得进入 `eligibleCandidates`，不得增加 `multi-bank-match-backfill` 的候选数。
- 方向错误行不得进入 `usedBankRowIds`，不得回填 ReconID，也不得排除后续 R5s2b。
- `directions[]` 必须在建池前整体校验为且仅为以下两个唯一配对，顺序不影响语义：
  - `FundTransfer-out → FundTransfer-out`
  - `FundTransfer-in → FundTransfer-in`
- 重复项、缺项、额外项、已知值错配（例如 `FundTransfer-in → FundTransfer-out`）或未知值均整轮失败关闭，并只产生一次配置告警；不得启动任何 direction 的独立消费集，也不得隐式设为“不要求方向”。

### 5.3 多对多只读审计

- 独立多对多检测器继续保持现有偏宽口径，不按 FundType 或实际方向收窄。
- 它不属于写入引擎的 `eligibleCandidates`，不得修改行、不得进入消费集。
- 只同步本 Spec 的日期启停和 `N` 值，确保审计时间窗口与回填策略一致。
- 检测器新增显式 `dateMatchEnabled` 入参：
  - `true`：沿用现有同日/`±N` 日期边条件；
  - `false`：建边时完全不比较日期，日期为空/非法也不单独阻断；账号、币种、金额等现有宽口径维度不变。
- 日期关闭时，同账号/币种/金额组可直接按“银行侧数量 ≥2 且对手侧数量 ≥2”形成完整二部图结论，避免实际构造 `N×M` 边。
- 编排器一律使用主流程传入的 resolved policy，不得再从 enabled `r5s2Bucket[0].config` 取值或在 R5 disabled 时回退 `N=1`。
- 调拨侧审计使用独立只读 `fundTransferAuditContext`：主流程应注入本次实际由 R3.5 或 R5s2
  加载的调拨副本。R5s2 关闭但 R3.5 开启时，仍须审计 R3.5 已使用的调拨行；该数组不得进入
  R5 写入引擎。旧调用未提供独立审计 context 时，才兼容回退 R5s2 的调拨来源 context。
- 写入引擎自身的多候选告警必须只统计 `eligibleCandidates`；不得把偏宽审计组当作可写候选。

## 6. 日期策略配置

### 6.1 管理页

仅特化 canonical `subCategory=fund-transfer-backfill` 的内置场景：

- 标题改为“调拨回填功能管理”。
- 移除“适用银行渠道”多选控件；该场景固定适用所有银行渠道。
- 保留优先级；“调拨单匹配日期”和“优先级”必须在同一行显示，日期在左、优先级在右；日期勾选框和文本的左起点须与下一行首个勾选项对齐。
- 保留“对账数据来源为中台调拨单表”。
- 保留 Payment 线下调拨配置中的“银行渠道 / 地区 / 大账号”，不得误删。
- 新增：

```text
☑ 调拨单匹配日期    ± [ 1 ] 天              优先级 [ 0 ]
```

- `dateMatchEnabled: boolean`，默认 `true`。
- `dateToleranceDays: integer`，允许 `1–999`，默认 `1`。
- 取消勾选后输入框禁用但保留原值，含义为完全不使用日期条件。
- 保存继续基于完整场景 config 浅合并，必须保留 `funcCategory`、`subCategory`、`roundPhase`、`directions`、`reconSourceMid` 和 `paymentOfflineBackfill`。

### 6.2 Canonical owner、保留签名与执行身份

日期配置和 R5s2 执行场景使用同一个 canonical owner 谓词：

```text
category === 'builtin-fixed'
isBuiltin === true
config.funcCategory === 'platform-order'
config.subCategory === 'fund-transfer-backfill'
```

- `resolveFundTransferDatePolicy` 对全部场景执行该谓词；找到 0/1/多条时按下节处理。
- `bucketScenarios` 不再只凭 `category/config` 把任意场景放入 R5s2；R5s2 只允许执行 resolver 返回的 `ownerScenarioId` 对应场景，且仅在该 owner enabled 时执行。
- 非 owner 但复用上述 `category + funcCategory + subCategory` 保留签名的场景属于伪内置冲突：
  - create/update/配置包导入入口必须拒绝创建新的冲突；
  - 旧库已存在冲突时，本次运行失败，错误列出冲突场景 id/name；
  - 不得把冲突场景送入 R5s2，也不得落入 R2 兜底执行。
- UI 只有命中完整 canonical owner 谓词时才显示“调拨回填功能管理”；配置包生成的 `isBuiltin=false` 克隆不得显示该管理页或影响日期策略。
- 旧的非内置保留签名冲突行必须在场景列表显示“非系统冲突场景”与可点击“删除冲突”动作，复用现有删除确认和 repository delete；不得因 `category='builtin-fixed'` 被锁进一个既不能改签名、也不能删除的管理页。删除后刷新列表，下一次运行可恢复。
- trusted migration/seed 仍是创建或修复 canonical owner 的唯一系统入口；普通配置包不获得修改该 owner 的能力。
- 普通 `scenarios:create`/public repository create 一律拒绝客户端传入 `isBuiltin=true`；创建 canonical owner 只能由 migration/seed 的内部 SQL 路径完成。update 继续禁止修改 `isBuiltin`。

Canonical owner 从本版本起是全局策略载体，生命周期必须受保护：

- 允许启用/停用 R5s2；enabled 不影响 policy 读取。
- 禁止单删、批量删除、转移渠道，以及把 `funcCategory/subCategory` 改离保留签名。
- 直接 repository/IPC、UI 和批量入口使用同一保护函数，不能只在按钮层隐藏。
- 新增一次幂等修复迁移：
  - 已有 1 条 canonical owner：不覆盖用户的启停、日期值或其它 config。唯一例外是 `function`
    精确等于旧系统默认文案时，将它替换为当前“来源按配置选择、日期按开关与 ±N 配置”的准确说明；
    任意用户自定义文案（包括只差一个字符的近似旧文案）必须原样保留。
  - 缺失：深拷贝当前版本完整 canonical seed config 创建，必须包含 `funcCategory/subCategory/roundPhase`、两个唯一 `directions` 配对、`reconSourceMid=true`、`paymentOfflineBackfill` 的 disabled 空值默认、`dateMatchEnabled=true/dateToleranceDays=1` 以及当前 seed 的说明字段；数据库列使用 `is_builtin=1`、通用渠道、`enabled=0`。除恢复名称和 `enabled=false` 外不得手工拼一份残缺 config。
  - 预定名称冲突时不得覆盖/改名普通场景；改用固定名称“调拨回填功能管理（系统恢复）”，仍冲突则保留 owner=0，R3.5 使用防御默认值并输出高优先级配置告警，R5s2 不执行。
  - 多条：不得自动合并或删除，运行失败等待人工修复。
- resolver 的 owner=0 回退只用于迁移前、迁移失败或数据库损坏的防御路径，不是正常可长期依赖的管理方式。

### 6.3 持久化与运行时解耦

本专项修复不新建第二套持久化体系：

- 日期字段仍存于 canonical “中台调拨订单对账ID回填”内置场景 config。
- 新增独立纯解析器 `resolveFundTransferDatePolicy(...)`，输出不可变结果：

```javascript
{
  policy: {
    enabled: true,
    toleranceDays: 1,
    ownerScenarioId: 123,
    signature: '稳定快照字符串'
  },
  warnings: []
}
```

- resolver 从全部场景中按 6.2 的完整谓词定位 canonical owner，不看 `enabled`。
- 找到 1 条：解析其配置。
- 找到 0 条：回退 `true + 1`，产生一次可见配置告警。
- 找到多条：不得静默 first-wins；本次运行失败并提示修复重复内置场景。
- 缺字段按 `true + 1` 兼容旧库。
- `dateMatchEnabled` 类型非法或 `dateToleranceDays` 非 `1–999` 整数时，回退对应默认值并产生一次配置告警。

signature 使用 stable stringify，固定输入为：

```javascript
{
  schemaVersion: 1,
  ownerState: 'missing' | 'single' | 'duplicate',
  ownerScenarioId,
  ownerCount,
  raw: {
    dateMatchEnabled: { type: 'missing' | 'boolean' | 'string' | 'number' | 'null' | 'other', value },
    dateToleranceDays: { type: 'missing' | 'boolean' | 'string' | 'number' | 'null' | 'other', value }
  },
  effective: {
    enabled,
    toleranceDays
  }
}
```

- 不能只签 effective 值；非法原值 A 改成非法原值 B，即使都回退到 `true + 1`，仍必须使旧结果失效。
- 不能直接依赖普通 `JSON.stringify` 的对象键顺序。

`main.js` 在 `bank-statement:run` 中读取全部场景详情（含 disabled），解析一次 policy，再显式传入：

- R3.5 Step1；
- R5s2 网关来源；
- R5s2 调拨对账单来源；
- 多对多只读审计。

R5 场景关闭只表示不执行 R5s2，不改变 resolver 的 owner 和 R3.5 使用的日期策略。

resolver 返回 `{ policy, warnings }`。`main.js` 把 warnings 作为 `initialWarnings` 传入编排器，编排器在其它引擎告警前加入统一 `allWarnings`，最终并入本次 `processingResult.errorReport`：

- 使用稳定 code；
- 与编排器返回 warning 去重后合并；
- shape 至少包含 `scenarioId`、`scenarioName: '调拨日期策略配置'`、`rowId: null`、`code`、`message`；
- run stats 的 warning count 必须包含配置告警；
- 导出错误报告可见；
- 不得只写活动日志后丢失。

本专项不扩展 `bank-statement:run` 与 renderer 来即时展示完整告警文字；用户在导出错误报告中查看全文。若要求运行结束立即弹出配置告警，另立 UI 返回契约。

### 6.4 快照与配置包

- 运行时由 `main.js` 把既有 enabled dispatch scenario snapshot 与 `fundTransferDatePolicy.signature` 组合成防陈旧快照。
- 导出时必须再次读取全部场景详情并运行同一 resolver；fatal owner/冲突错误直接拒绝导出，非 fatal 回退得到的 signature 参与比较。
- 运行后即使 owner 场景处于 disabled，只要日期配置发生变化，旧结果也不得继续导出。
- 场景配置更新继续清空 `processingResult`。
- 日期策略是本机 canonical 内置场景设置；普通场景配置包导入遇同名内置场景会冲突跳过，本次不新增“跨机器覆盖全局日期策略”语义。
- 普通配置包既不能修改 canonical owner，也不能通过伪内置保留签名间接影响日期策略或 R5s2 执行。

### 6.5 全渠道约束

- 幂等迁移清空 canonical owner 的历史 `scenario_applicable_channels`。
- UI 保存不再调用该场景的渠道多选写入。
- `scenarios:set-applicable-channels` 及其它能够直接指定 scenario id 的写入旁路，对 canonical owner 强制归一为空数组。
- 配置包导入不会命中或更新 canonical owner；它对保留签名的非内置克隆应按 6.2 拒绝，而不是假装替 canonical owner 归一渠道。
- 场景管理顶部的银行渠道筛选仍保留；“所有渠道”仅表示该功能的适用范围。
- R3.5 原有 DBS 业务门控保持不变。

## 7. 可观测性与状态不变量

- 方向/日期告警只在账号、币种、金额等其他关键条件已形成 near match 时输出，避免全表噪声。
- 告警必须包含引擎、银行 `_rowId`、期望方向、实际失败原因；不得输出完整敏感账号。
- 同一写入引擎内，日期失败告警按“银行原始行序 + 银行 `_rowId` + 期望方向 + 失败原因”去重；
  多条来源行或 Phase1/Phase2 同时遇到同一银行行时不得产生 N×M 重复告警。不同银行原始行、
  不同期望方向或不同失败原因仍必须分别保留；`_rowId` 缺失或重复时必须依靠银行原始行序保持
  逐行可审计。
- 上述去重只收敛错误报告规模，不得改变 eligible candidate、排序、选择、消费、配对、保护集、
  FundType/ReconciliationId 改写或标黄结果。
- 配置异常使用稳定 code，且每次运行同一配置异常只告警一次。
- “完整命中”“消费”“实际改写”“标黄”继续分离：
  - 完整命中可消费；
  - 同值命中不改写、不标黄；
  - 未完整命中不消费；
  - modification 只记录真实字段变化。
- `modifiedRows + unmatchedRows === bankRows.length` 行数守恒继续成立。
- R4 `matchedPairs`、R5 `usedBankRowIds`、R3.5 保护集必须都能追溯到具体银行对象/稳定 `_rowId`，不得按 ReconID 扩散。

## 8. 测试与验收

### 8.1 统一方向矩阵

每个方向至少覆盖：

- 主侧正数；
- 主侧负数；
- 主侧空；
- 主侧非法；
- 主侧零；
- 另一侧空；
- 另一侧合法零；
- 另一侧非法；
- 另一侧非零；
- 双非零；
- 双零；
- 未知方向。

### 8.2 同 ReconID 相反方向红线测试

R3.5 必须构造：

- `dispIn`、`dispOut` 使用同一 `RID001`、同账号、同币种、同金额、同日期；
- 银行原序故意先放 Debit 100，再放 Credit 100；
- `dispIn` 只能选择 Credit 行；
- `dispOut` 只能选择 Debit 行；
- 两条命中行分别保持 `FundTransfer-in/out` 并进入保护集；
- 再加入同 RID 的 Credit/Inbound 非命中 sibling，Stage B 不得改为 Charge；
- Debit 且未保护的 sibling 才允许改 Charge。

R4 必须构造同 ReconID 的 `AchReturn` 与 `WireReturn`，证明只形成 `AchReturn→Debit`、`WireReturn→Credit` 两个具体 pair。

R5 两种来源分别构造：

- `FundType` 看似正确但真实方向错误的银行行排在最前；
- 后一条银行行真实方向正确；
- 只能选择后一条；
- 错误方向行不进入 `usedBankRowIds`，也不增加写入引擎多候选数。
- `directions[]` 的重复、缺项、额外项、in/out 错配和未知值均在建池前整体失败，银行行零消费、零改写且配置告警只出现一次。

### 8.3 R3.5 旧测试反转

`tests/unit/dbs-charge-fund-check-direction.test.js` 当前把“银行方向不敏感”写成活文档，与本次已确认的新业务口径相反。实施时必须删除或改写这些断言，不能让旧测试被简单跳过。

### 8.4 日期

- 同日命中。
- 银行早 1 天仍在 `±N` 内命中。
- 银行晚 1 天命中。
- `N` 边界包含：`260701 ↔ 260708` 在 `N=7` 时命中。
- 超边界：`260701 ↔ 260709` 在 `N=7` 时不命中。
- 日期缺失/非法在启用时不命中。
- 关闭日期时完全不比较日期。
- 全局同日优先：前一调拨行的 `+1` 候选恰是后一调拨行的同日候选，必须先分给后一行。
- `07-09 / 07-11` 相对 `07-10` 等绝对差时按银行原序；反转银行原序后选择随之反转，并保留多候选告警。

### 8.5 配置、旁路与快照

- owner enabled / disabled 两种状态解析相同 policy。
- R5 disabled、R3.5 enabled 时 R3.5 使用已保存值。
- owner 缺失回退并告警。
- owner 重复阻断运行。
- canonical owner 单删、批删、转移和保留身份改写均被 repository/IPC 阻断。
- 修复迁移对 owner=0 恢复 disabled canonical；对 owner=1 不覆盖；对冲突/重复不破坏普通场景并 fail-closed。
- 恢复 owner 的 config 与当前版本完整 canonical seed 做深相等契约测试，仅允许约定的日期默认值和说明字段随当前 seed 演进。
- 非内置保留签名通过 create/update/配置包导入均被拒绝；旧库冲突在运行前阻断且不会落入 R2。
- 旧非内置冲突在 UI 可见、可删除；删除后不再阻断运行。
- 直接 IPC/public create 伪造 `isBuiltin=true` 被拒绝，数据库不新增第二 owner。
- canonical owner enabled 时仅该 id 进入 R5s2；disabled 时 R5s2 no-op，但 R3.5 仍读取同一 policy。
- 旧库缺字段回退。
- 非法值回退并告警。
- resolver 非致命告警进入导出错误报告，且同一 code 不重复。
- raw 非法配置 A→B 即使 effective 都是默认值，也会因 signature 改变拒绝旧结果导出。
- 运行后 policy 改变，旧结果拒绝导出。
- 历史适用渠道迁移清空。
- UI 和直接 IPC 不能恢复 canonical owner 的渠道限制。
- 配置包导入不覆盖本机 canonical 日期策略。
- `dateMatchEnabled=false` 时多对多审计不按日期建边；`true` 时继续使用 `±N`。
- R5 disabled + owner `N=7` 时，多对多审计与 R3.5 仍使用 7，不回退 1。
- R5 disabled、R3.5 enabled、N=7 的 2×2 调拨组：R5 零改写，R3.5 正常改写，两条实际修改银行行都产生调拨多对多审计说明。
- 日期关闭时，跨年、空日期和非法日期的 2×2 同账号/币种/金额组仍命中宽审计；开启时同一 fixture 不建日期边。

### 8.6 问题样本

使用真实或脱敏样本逐笔复核：

- `0016RF1210576`
- `20260721UOVBSGSGBRT8522830`

两条原始 Inbound 在严格方向不符时：

- 不得改成 `FundTransfer-out`；
- 不得在 Stage B 被改成 `Charge`；
- 不得进入消费/保护集合；
- 必须能从 warning 或未命中结果解释其去向。

## 9. 实施顺序

1. 先落共享方向校验器及纯函数矩阵测试。
2. 先修 R3.5 Step1/Stage B 最小端到端路径，回放问题样本。
3. 再接 R5 两种来源，验证错误方向不消费。
4. R4 切换共享校验器并跑 golden 回归，确认行为不变。
5. 实现 policy resolver、disabled owner 读取和 run/export 快照。
6. 实现管理页和适用渠道旁路归一。
7. 同步多对多审计日期策略，不改变其方向宽口径。
8. 更新 CHANGELOG、版本历史、用户手册，执行定向测试、`npm run release-check`、`npm run check:vars`。
9. 使用真实或脱敏资金样本逐笔人工复核后方可合并。

## 10. Review 处置结论

| Review 建议 | 处置 |
|---|---|
| 方向在候选生成阶段过滤 | 采纳；严格定义 `eligibleCandidates` |
| 日期优先选择银行日期不早于调拨日期 | 本次不采纳；现有契约和样本证据支持双向 `±N`，改变需另行人工确认 |
| R5 为 Others/Revenue Clear 等增加可选方向 | 不采纳；属于另一模块，本次只覆盖 FundTransfer-in/out |
| 日期配置脱离启停状态 | 采纳运行时解耦；resolver 忽略 R5 enabled |
| 日期配置迁到独立持久化体系 | 本次不采纳；会新增迁移、IPC、双存储原子性、配置包和降级风险 |
| 工具箱拆独立 PR | 采纳；见 Spec B |
| 增加同 ReconID 相反方向测试 | 采纳 |
| 建立统一方向校验器 | 采纳；方向为代码级安全常量，不允许配置关闭 |

## 11. 资金红线

本 Spec 改变借贷方向、候选资格、消费集合和 FundType 改写边界。

**⚠️ 合并前必须由业务人员使用真实或脱敏样本逐笔人工复核；自动测试通过不能替代资金口径确认。**
