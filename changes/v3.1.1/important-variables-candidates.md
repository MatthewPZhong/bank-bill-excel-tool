# v3.1.1 重要变量升格候选

> 状态：待用户审批  
> 依据：2026-07-29 `npm run scan:vars` 与 `npm run check:vars -- --include-minor`

以下条目满足 `rules/important-variables.md` 的“数据门槛 + 资金语义门槛”。本文件只提供
可审阅草稿；用户批准前不直接改写手工维护清单。

## 候选 1：严格银行方向与调拨方向配置

建议层级：**Risk-sensitive ⚠️🔴🔴 资金红线**

建议条目：

### `validateBankDirection` / `validateFundTransferDirections`

- 定义：
  - `src/main-process/scenario-engines/bank-direction-validator.js`
  - `src/main-process/scenario-engines/fund-transfer-engine-policy.js`
- 数据证据：
  - `validateBankDirection`：A-share，跨 5 个文件、12 次引用。
  - `validateFundTransferDirections`：A-share，跨 3 个文件、6 次引用。
- 关联功能：
  - R3.5 Step1/Stage B、R4、R5s2 网关来源和调拨来源的银行真实借贷方向。
  - `FundTransfer-out / Ach Return / HX-out` 必须严格 Debit；
    `FundTransfer-in / Wire Return / HX-in` 必须严格 Credit。
  - R5s2 的 in/out directions 配置必须完整、唯一且与 canonical 矩阵一致。
- 变更 review 要点：
  - 方向必须在候选生成阶段校验；失败行不得进入候选数、多候选、消费、保护集、pair 或改写。
  - 主侧必须是合法非零金额，对侧只能为空或合法零；非法值、双零、双非零均失败关闭。
  - R4 复用共享校验器时不得改变 warning、`matchedPairs` 和 no-op 消费语义。
  - R5 directions 缺项、重复、额外、错配或未知时必须整轮零消费、零改写，只产生一次配置告警。
  - 必跑方向矩阵、相同 ReconID 相反方向、R3.5/R4/R5 两来源、orchestrator 与完整 `release-check`；
    真实资金样本仍须逐笔人工复核。

## 候选 2：调拨日期策略与 canonical owner

建议层级：**Risk-sensitive ⚠️🔴🔴 资金红线**

建议条目：

### `isCanonicalFundTransferOwner` / `resolveFundTransferDatePolicy` / `normalizeFundTransferDatePolicy`

- 定义：
  - `src/main-process/fund-transfer-date-policy.js`
  - `src/main-process/scenario-engines/fund-transfer-engine-policy.js`
- 数据证据：
  - `isCanonicalFundTransferOwner`：A-share，跨 4 个文件、19 次引用。
  - `normalizeFundTransferDatePolicy`：A-share，跨 5 个文件、10 次引用。
  - `resolveFundTransferDatePolicy` 当前为 A-pair；作为 owner 的唯一生产解析入口随同审阅。
- 关联功能：
  - 唯一系统 owner 身份、迁移恢复、CRUD/bundle/UI 旁路保护。
  - R3.5、R5s2 两来源和 M2M 共享的“全局同日优先，未命中再 `±N` 天”策略。
  - 运行/导出 policy signature；配置变化后拒绝按旧结果导出。
- 变更 review 要点：
  - canonical owner 必须同时满足 `builtin-fixed + isBuiltin=true + platform-order + fund-transfer-backfill`。
  - owner 0 只能临时使用 `enabled=true/N=1` 并告警；owner 多条或非系统保留签名冲突必须阻断。
  - owner 可启停 R5s2，但 disabled 不得阻断 R3.5 读取已保存日期策略。
  - 日期开启时先全局同日，再让未命中来源进入 `±N`；边界包含、绝对差优先、同差按银行原序。
  - 日期关闭只跳过日期；账号、币种、金额、方向、未消费和严格 1:1 均不得放宽。
  - N 只允许 1–999；缺失兼容默认，非法值回退并告警，raw 值变化必须反映在 signature。
  - 必跑 owner 0/1/>1、迁移/仓储/bundle/UI、run/export 快照、R3.5/R5/M2M 日期竞争及完整
    `release-check`。

## 审批动作

用户批准后：

1. 将上述两条加入 `rules/important-variables.md` 的 Risk-sensitive 区。
2. 更新清单版本、v3.1.1 review 摘要、基线统计与上次人工 review 日期。
3. 重新执行 `npm run check:vars -- --include-minor`，确认 PR body 复核段与新条目一致。

