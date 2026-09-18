# Background Execution E00 文档包

本目录是 v3.2.x 后台执行平台的 Implementation Ready 合同冻结包；业务源码和各 action 生产门禁仍待实施。

## 文件

1. `v3.2.x-version-split-plan.md`
   - 决定新增 v3.2.4、v3.2.5；
   - 重新划分 v3.2.3～v3.2.5 范围。

2. `platform-contract-v1.md`
   - 唯一规范性平台合同；
   - 冻结 identity、mode、protocol、resource、commit/recovery、coverage。

3. `platform-contract-v1.schema.json`
   - Action Policy Registry v1 JSON Schema；
   - 强制 worker-durable receipt/inspector、artifact publisher 与 Service resource-control。

4. `platform-protocol-v1.schema.json`
   - Job Envelope 与 Service Control Envelope v1 Schema；
   - 覆盖 resource request/grant/adoption。

5. `platform-lifecycle-mapping.md`
   - ExecutionResult → commitState → TaskRun / Batch / Renderer / retry/hold 的规范映射。

6. `E00-platform-contract-v1-spec.md`
   - E00 产品与验收规格。

7. `E00-platform-contract-v1-techdoc.md`
   - E00 技术实现、平台表、API、状态机、测试和 PR 拆分。


8. `validation/`
   - 可复跑 JSON Schema、Protocol、semantic、Markdown link 校验；
   - 包含全量 action Registry fixture 和正反例 fixtures。

## 使用顺序

```text
评审并冻结 platform-contract-v1
→ 合并唯一源码 PR：E02-A、E02-B、E02-C1、E02-C2（分别关闭 E00-A～D）
→ 完成 action probes E00-E
→ 机械回修 v3.2.0～v3.2.3
→ 新建 v3.2.4/v3.2.5 Spec/TechDoc
→ 按 action 独立门禁实施
```

## 当前评审状态

```text
Implementation Ready at documentation/contract level
```

公共合同可直接进入 E02 源码实现；具体 DB mutation、Publisher settlement 与自动恢复只有在对应 action 的 production gate 通过后才启用。

## 恢复来源合同

Platform Contract v1 已冻结：

- `publisher-journal`：不创建 Critical Intent，由 `SettlementRecoveryProvider` 枚举 open journal；
- `target-post-image`：创建 Main-owned Critical Intent，不走 Worker critical handshake；
- Inspector 统一接收 `RecoverySourceV1`；
- Startup Coordinator 扫描 open intents、open settlement sources 与 active holds；
- 平台控制表固定写入 Main-owned 主控制数据库。

## RecoverySourceV1

`platform-recovery-source-v1.schema.json` 是恢复来源 DTO 的唯一机器可读定义。所有 TypeScript/JSDoc 类型必须由它生成或逐字段等价；InspectorRegistry 是唯一判定权威，SettlementRecoveryProvider 仅枚举和恢复。
