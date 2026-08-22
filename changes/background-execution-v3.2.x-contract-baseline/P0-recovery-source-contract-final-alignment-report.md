# P0 最终回修：RecoverySource / Intent / Inspector / Provider 唯一合同

## 1. 结论

本轮只做定点合同回修，不改变 v3.2.0～v3.2.5 的版本拆分和模块拓扑。关闭事项：

1. `RecoverySourceV1` 从两套定义收敛为一份机器可读 Schema；
2. Critical Intent 的适用范围与 Policy Schema 完全一致；
3. InspectorRegistry 成为唯一判定权威；
4. SettlementRecoveryProvider 删除独立 `inspect()`；
5. validator 校验 RecoverySource 结构、Intent 映射和 Provider/Inspector 边界；
6. validation report 哈希覆盖包内全部相关 Markdown/JSON/Python/Shell/requirements 输入。

当前评审状态：

```text
Architecture Approved
Implementation Ready at documentation/contract level
Action Production Enablement remains gated
```

## 2. RecoverySourceV1 唯一定义

新增：

```text
changes/background-execution/platform-recovery-source-v1.schema.json
```

唯一 source kind：

```text
critical-intent
publisher-journal
target-post-image
existing-protocol
module-recovery
```

唯一字段：

```text
contractVersion
sourceKind
sourceRef
actionKey
operationKey
taskRunId
conflictScopeKey
inspectorKey
settlementKey
intentId
evidenceVersion
boundedEvidence
```

删除/禁止第二套字段：

```text
intent
receiptHint
safeEvidence
```

`manual` 只属于 Recovery Hold，不是可自动检查的 RecoverySource。

## 3. Intent 唯一映射

| policy | Critical Intent |
| --- | --- |
| worker-durable | 平台 worker-critical intent |
| main-settlement + target-post-image | Main-owned intent，无 Worker handshake |
| main-settlement + publisher-journal | 无 intent |
| existing-critical-protocol | 无平台 intent；只使用既有协议证据 |
| none | 无 intent |

existing protocol 证据不足时保持 blocked；禁止临时创建平台 Intent 包裹旧协议。

## 4. Inspector / Provider 边界

```text
InspectorRegistry:
  inspect(source) -> inspection

SettlementRecoveryProvider:
  listOpenSources()
  recover(source, inspection)
```

Provider 不再包含 `inspect()`。Startup Coordinator 先通过 `source.inspectorKey` 调用唯一 Inspector，再根据 inspection 调用 Provider 恢复 settlement。

## 5. Startup Recovery

顺序固定：

```text
load active holds and restore gates
load open intents
enumerate every provider open source
validate/normalize RecoverySourceV1
dedupe by sourceKind + sourceRef
inspect through InspectorRegistry
recover through Provider when required
persist events/holds/task mapping
initialize business services last
```

manual hold 不进入 InspectorRegistry；它只恢复冲突 gate 和用户可见 recovery-required。

## 6. 自动校验

新增：

- RecoverySource JSON Schema meta-validation；
- 五类合法 fixture；
- intentId/settlementKey/legacy field/manual source 负例；
- 单一 inline type definition 检查；
- Critical Intent 映射检查；
- Provider 无 `inspect()` 检查；
- Startup manual hold 处理检查；
- 全输入递归 SHA-256 记录。

最新结果以 `validation-report.json` 为准。
