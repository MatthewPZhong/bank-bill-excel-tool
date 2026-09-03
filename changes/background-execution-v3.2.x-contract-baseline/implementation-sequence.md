
# v3.2.x 后台执行平台 Implementation-Ready 实施序列

## E00 与 v3.2.0 PR 编号关系

E00-A～E00-F 是合同冻结/验收 track；生产源码只实现一次：

| E00 gate | 源码实现 PR |
| --- | --- |
| E00-A Policy/Protocol | v3.2.0 E02-A |
| E00-B ResourceGovernor | v3.2.0 E02-B |
| E00-C Lifecycle / Batch overlay / recovery events | v3.2.0 E02-C1 |
| E00-D Critical Intent / SettlementRecoveryProvider / generic Recovery Hold / startup scan | v3.2.0 E02-C2 |
| E00-E Probes | 各 action 对应版本 P0 PR |
| E00-F Docs | 本文档包 |

不得把 E00-B～D 和 E02-B～C2 作为两套实现重复交付。

E02-C1/C2 的平台控制表固定落在 Main-owned 主控制数据库；E02-C2 同时实现 InspectorRegistry、SettlementRecoveryProviderRegistry、open journal 枚举和 `open intents + open settlement sources + active holds` 启动扫描。

## 单一实现原则

- E00-A～F 是 gate / contract / evidence 编号；
- v3.2.0 E02-A～C2 是唯一源码实现 PR；
- E00 gate 在对应 E02-A～C2 PR 合并并通过合同测试后关闭；
- 版本 Spec 中再次出现同名组件时只表示“接入/验收”，不得重复实现 Registry、Governor、Lifecycle 或 Intent Store。

## 发布版本

| 版本 | 核心主题 | 高风险门禁 |
| --- | --- | --- |
| v3.2.0 | 平台核心、样板adapter、VCC OP | saveRun receipt |
| v3.2.1 | Toolbox、PreFund MPT | Route DB seal、per-file receipt |
| v3.2.2 | FundRecon、Duplicate、BankBU | startup inspector、side/main identity |
| v3.2.3 | Statement、NewAccount | token memory、manual seed |
| v3.2.4 | ReconFix、VCCFin subject output | JPM receipt、subject query pushdown |
| v3.2.5 | exports、adapters、coverage closure | mature zero-drift、100% coverage |

## 当前不新增v3.2.6

只有Statement需跨重启Session Artifact、JPM需要复杂人工修复UI、成熟adapter必须重写引擎，或v3.2.5 action数量超出可验证范围时重新评估。
