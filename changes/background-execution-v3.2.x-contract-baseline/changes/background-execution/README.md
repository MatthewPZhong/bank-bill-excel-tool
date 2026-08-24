# Background Execution E00 文档包

本目录是 v3.2.x 后台执行平台的 Implementation Ready 合同冻结包；业务源码和各 action 生产门禁仍待实施。

包内 published `validation-report.json` 只允许 repo/default 模式生成；no-write 必须 exact 绑定 complete normalized authority provenance、canonical generation command 与 input hashes。external/detached 证据只能写入包外临时 report 后以相同 provenance 复验，不能复用 published repo report。

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

5. `platform-recovery-source-v1.schema.json`
   - RecoverySource、Inspection 与 Settlement Result 的 exact Schema。

6. `platform-recovery-control-v1.schema.json`
   - Recovery transition/observation request、全部 command branch 与 immutable result 的 exact Schema。

7. `recovery-contract-authority.v1.json`
   - 独立、非生成地冻结 binding/result/inventory digest、counts 与 source contract version；
   - v1 authority 的受控 value（含 genesis）变化必须相对 previous 精确提升 revision +1；contractVersion 固定为 1，未来 v2 另立 versioned authority 与人工 redline，当前人工状态保持 PENDING。

8. `platform-lifecycle-mapping.md`
   - ExecutionResult → commitState → TaskRun / Batch / Renderer / retry/hold 的规范映射。

9. `E00-platform-contract-v1-spec.md`
   - E00 产品与验收规格。

10. `E00-platform-contract-v1-techdoc.md`
   - E00 技术实现、平台表、API、状态机、测试和 PR 拆分。

11. `validation/`
   - 可复跑 JSON Schema、Protocol、semantic、Markdown link 校验；
   - 包含全量 action Registry、真实 TaskPolicy binding manifest、RFC 8785/JCS shared KAT 和正反例 fixtures。

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

## RecoveryControl v1 勘误

- `recovery-contract-authority.v1.json` 是 public digest/count/version 的单一机器权威；生产 `ActionTaskBindingRegistry` 的模块私有常量只负责 runtime canonical actionKey→allowed legacy TaskPolicy keys，caller 不可注入 replacement。factory 只接受真实 registry 的 frozen exact plain `{ list }` host，单次 descriptor-safe 复制并持有 private Sets，完整 122-key inventory JCS digest 为 `95381024…b368`。Action Manifest v3 只保存审计 snapshot，map JCS digest `c217253c…f0ba`、60 条独立 pair provenance 与 52/122/60/52/70 hard counts 共同阻断自授权；Main binding freeze 严格早于 DB/IPC，Map/prototype/hostile message accessor、后改/等数量替换/duplicate 与 missing/mismatch/empty binding fail closed。
- canonical JSON 固定 RFC 8785/JCS 与 lowercase SHA-256；duplicate-aware raw parser 拒绝 nested duplicate 与超出 ±(2^53-1) 的整数，Python validator 与 Node runtime 共用 fixed KAT。
- Main-owned persistent request owner 首次保存 stable eventId/createdAt/完整 request_jcs/hash；20 个 requestKey namespace/tuple 排除 volatile leaf，owner/event 五项 identity 由 composite FK 保持一致，restart/startup/Hold 重扫复用。
- 四类 observation 在 owner 前持久分配 durable `observationAttemptId`；同 ordinal restart exact replay，下一 ordinal 才能追加 event，attempt/event composite FK fail closed。
- `platform-recovery-control-v1.schema.json` 对每个 writer input/branch/result 都 exact unknown-key closed；Batch mark 显式携带 failure 字段，两个 result 固定各自 writer/event domain并只返回 immutable 20-field persisted projection。独立 20-result KAT（JCS digest `1ced39a5…c039`）按 branch 冻结全部字段，mapper/source/CAS mutants 均经实际 SQLite DDL/immutable SELECT 后比较。
- `archive_batches.id === batchId`，overlay 才使用 `overlay.batch_id`；每个 control write 都要求完整 CAS 与 `changes() === 1`。
