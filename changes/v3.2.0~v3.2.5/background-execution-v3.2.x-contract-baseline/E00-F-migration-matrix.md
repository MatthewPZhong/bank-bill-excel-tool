
# E00-F — v3.2.0～v3.2.5 文档机械回修与拆分矩阵

| 项目 | 内容 |
| --- | --- |
| 状态 | completed as document baseline |
| 上游 | Platform Contract v1 / Lifecycle Mapping / Version Split Plan |
| 产物 | v3.2.0～v3.2.5 各一份 Spec 与 TechDoc |

## 1. 公共术语回修

| 旧写法 | 统一写法 |
| --- | --- |
| Registry `operation` | `actionKey` |
| Protocol `type` | `operation` |
| `existing-transport` | 实际mode + `adapterKind='existing-dispatch'` |
| `unitDone` / `unitError` | `unit:done` / `unit:error` |
| `criticalReady` / `criticalAck` | `critical:ready` / `critical:ack` |
| `committed` event | `commit:receipt` |
| `main-controlled` | `main-settlement` |
| `worker-persistent` | `worker-durable` |
| `existing-protocol` | `existing-critical-protocol` |
| duplicate `operationKey` coverage | duplicate static `actionKey` |
| Task status `recovery-required` | TaskRun `interrupted` + Renderer `recovery-required` |

## 2. 范围迁移

| 原v3.2.3内容 | 新位置 |
| --- | --- |
| Statement / token / manual balance | v3.2.3 |
| NewAccount | v3.2.3 |
| ReconFix / JPM | v3.2.4 |
| VCC Financial OP subject output | v3.2.4 |
| Remaining read-only exports | v3.2.5 |
| Mature adapters | v3.2.5 |
| Final Action Coverage / strategy snapshot | v3.2.5 |
| 公共Critical Intent/Resource/Lifecycle | E00 + v3.2.0 |

## 3. P0 关闭位置

| P0 | 关闭版本/PR |
| --- | --- |
| 统一平台协议/Policy | E00 |
| 完整ResourceGovernor | E00/v3.2.0 |
| Lifecycle interrupted映射 | E00/v3.2.0 |
| Critical Intent Store/Recovery Hold | E00/v3.2.0 |
| VCC saveRun receipt | v3.2.0 E03-B |
| PreFund per-file receipt/noop | v3.2.1 E05-P0/B |
| Duplicate startup inspector顺序 | v3.2.2 E07-A |
| BankBU side/main identity | v3.2.2 E08-A |
| Statement pending token/seed | v3.2.3 E09-B/D |
| JPM no-op/ID-aware reader/receipt | v3.2.4 E11-P0/B |
| VCC subject filter pushdown | v3.2.4 E12-B |
| 全量coverage/adapters | v3.2.5 E13-D～G |

## 4. 版本实施顺序

```text
E00
→ v3.2.0
→ v3.2.1
→ v3.2.2
→ v3.2.3
→ v3.2.4
→ v3.2.5
```

Action-level BLOCK不会阻止无关action继续，但不得被后续版本绕过或被版本号“自动关闭”。
