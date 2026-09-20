# TechDoc｜v3.2.10 BizOP 查询与归档数据边界（G5）

| 项目 | 内容 |
| --- | --- |
| 目标版本 / 计划分支 | `3.2.10` / `codex/v3.2.10-bizop-query-boundaries`（未创建） |
| 基线 | 正式附注标签 `v3.2.9`，`main@11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 日期 / 状态 | 2026-09-20 / v1 设计；未实施、未执行测试 |
| 需求 / 集成 | [Spec](spec.md) G5-AC-01～G5-AC-08；`release/v3.2.10` 基线处理见[总索引](../../README.md) |

## 1. 模块划分与文件清单

| 文件 | 改动 | 唯一职责 |
| --- | --- | --- |
| `src/main-process/biz-op-v327/catalog-queries.js` | 拟新增 | 本域只读 SQL 与稳定行投影，使用 catalog 同连接 |
| `src/main-process/biz-op-v327/catalog.js` | 修改 | 初始化并公开 frozen `queries`，原命令/db/transaction能力保留 |
| `src/backend/database/archive-repository.js` | 修改 | 新增有界存在性查询，归档表结构只由本仓储解释 |
| `src/main-process/biz-op-v327/compute-inputs.js` | 修改 | 使用query；仍拥有输入合同、来源校验与指纹 |
| `src/main-process/biz-op-v327/export-inputs.js` | 修改 | 使用query；仍拥有manifest、版本和RAW文件验证 |
| `src/main-process/biz-op-v327/delete-preview.js` | 修改 | 使用query和archive方法；仍拥有闭包、预算、预览命令与确认 |
| `src/main-process/biz-op-v327/import-main.js` | 修改 | 使用诊断/dispatch查询；仍拥有导入编排与真实维护动作 |

只迁移下文列出的读点。`catalog.db` 保留给 catalog 命令、delete-preview 的预览写入/绑定和本域尚未迁移的 recovery/diagnostic 实现；它不作为新的跨域公共接口。没有“先删除 db 再修所有调用”的阶段。

## 2. query 对象与返回合同（均为拟新增内部接口）

```js
const queries = createBizOpCatalogQueries({ db });
// 返回 Object.freeze 的方法集合；每次调用即时查询，无结果缓存。
// catalog 创建完成后公开 catalog.queries。
```

所有方法同步；`read*` 返回新投影对象或 null，`iterate*` 返回同步 Iterator。每个 iterator 只在当前原有 admission 回调内同步消费，不跨 await、不跨事务、不返回 Renderer。未消费完需用 for-of 退出或显式 return 释放 statement iterator；不 .all() 再预算检查。

### 2.1 计算与来源

```js
readActiveDataset(kind, dataDate)
// null | { datasetId, kind, dataDate, publicVersion, rowCount,
//          sourceManifestDigest, manifestRelativePath, manifestDigest }
iterateDatasetSources(datasetId)
// Iterator<{ artifactId, sha256, originalName, order, sheetName, bu, rowCount }>
```

前者使用原 input_heads JOIN datasets 和 ACTIVE 过滤；后者保持 ORDER BY source_file_order。compute-inputs 的 required/missing 循环、metadataCount++、hold、rowCount、manifest、BU/摘要排序和 fingerprint 仍在原函数，字段名在该函数边界适配。返回保持 `{startDate,endDate,documents,inputs,bus,originalDigests,inputFingerprint,expectedGeneration}`。

预算检查发生在每次消耗来源时，不能在query内先收集全量。query 不读取 payloadStore，不执行 getArchiveService，不把 missing 当空数据。

### 2.2 导出

```js
readExportObject(outputKind, objectId)
// null | {
//   objectKind: 'RESULT' | 'DIAGNOSTIC' | 'DATASET',
//   manifestRelativePath, manifestDigest, metadata
// }
```

| objectKind | metadata 精确字段 | SQL条件 |
| --- | --- | --- |
| RESULT | version,startDate,endDate,inputFingerprint,publishedAt,startInputVersion,endInputVersion | run state=PUBLISHED；端点role为START_OP/END_OP |
| DIAGNOSTIC | producerTaskRunId,scanComplete,errorCountExact,sampleCount | diagnostic state=READY，JOIN sealed lifecycle |
| DATASET | version,dataDate,sourceManifestDigest,activatedAt | dataset state=ACTIVE且kind匹配outputKind前缀 |

RESULT 端点不是恰好2条、缺少任一版本时，沿用 `BIZOP_EXPORT_INPUT_METADATA_MISSING`。DIAGNOSTIC 布尔字段继续 Boolean 转换。无row返回null，由原freezeExportSource抛 `BIZOP_EXPORT_SOURCE_UNAVAILABLE`，保持异常顺序。

`schemaFor`、opaque、RESULT manifest的objectKind/owner与resultContractFor、columnSchemaVersion决策，以及RAW originals的hold/hash/真实文件校验仍留在export-inputs。最终snapshot大小仍65536，无新增字段。

### 2.3 删除闭包的只读部分

```js
readActiveDatasetForDelete(datasetId)
// null | { datasetId, kind, dataDate, publicVersion, activatedAt }
iteratePublishedRunIdsUsingDataset(datasetId)
// Iterator<string>；原 DISTINCT 查询语义，不新增排序
readPublishedRunForDelete(runId)
// null | { runId, startDate, endDate, resultVersion,
//          manifestDigest, operationMonth }
iterateRunArtifacts(runId)
// Iterator<{ artifactId, originalName, sha256 }>；ORDER BY artifact_id
```

delete-preview.collect 仍负责 selection排序、runIds闭包、charge、outputName、operationMonth与引用计数。新增的投影只替换读行，不改变 Set 插入顺序；datasets 的来源复用 iterateDatasetSources，但只使用原预览需要字段，不能将未使用字段纳入digest。

collect/create/get/validate/bind 的输出、预览表读写及TTL等仍由原模块维护。将业务事实读与预览命令分开，不为“全部query化”引入第二个command框架。

### 2.4 导入诊断

```js
readDispatchesForPlan(taskRunId, planDigest) // 当前 matching dispatch 原字段行数组
readDiagnosticByRef(reportRef)             // 当前 diagnostic 原字段行或null
```

覆盖 import-main.restoreDiagnostic 的dispatch与existing读取，以及runImport的manifest摘要、sample_count读取。这里保留原字段投影以避免改变 producer 校验；不对这些内部原行做数值/布尔转换。唯一carrier检查、digest、关闭证明和样本文件verify仍由原import coordinator执行；query不能调用registerDiagnostic/retireDiagnostic。

## 3. 归档存在性接口

拟新增 archive repository 方法：

```js
hasOtherArtifactForBlob(blobId, artifactId) // -> boolean，同步，无写入
```

将原SQL原样收回仓储：

```sql
SELECT 1 FROM archive_artifacts WHERE blob_id=? AND id!=? LIMIT 1
```

不增加status/owner过滤，不从“可导出”推导“可删除”。调用方继续仅在artifact.blobId存在时调用；入参沿用既有受信任映射对象，不新增面向Renderer的接口。结果为Boolean(get(...))，缺少其他引用为false。

仓储已有listArtifactsByBlob，但本项选择窄存在性接口，保持LIMIT 1的内存边界；不使用findBlobByHash.referenceCount替代真实排除自身的存在性语义，也不虚构getBlob接口。

## 4. 准入、事务与错误时序

- compute-main 继续在同一个 admission.exclusive 中collectInputs；query不另申请锁。
- export-main 继续以 admission.readTask 覆盖整个异步任务，不能查询后提前释放再验证文件。
- delete-preview.collect保持同步admission.read，不能把query改成Promise；预览写入仍用原catalog.transaction。
- bind继续assertExclusive，并按原顺序复核过期、generation、closure digest、confirmed_mode/task；query不预先“缓存验证通过”。
- import-main仍在原exclusive、保护及关闭链内查询诊断。query与原模块共享db，不能打开独立连接来规避busy或得到不同快照。
- 原sql错误/业务错误按原路径传播；不将异常转换为空结果，不在读取失败时选择历史对象回退。

本项不新增BEGIN，不更改SQLite isolation、schema、index、cleanup或保留期。正常行为等价也包括错误发生时点和数组顺序。

## 5. 阶段、兼容与移除条件

| 阶段 | 操作 | 完成条件 |
| --- | --- | --- |
| Q1 | archive增加方法、delete-preview替换唯一跨表存在性SQL | G5-AC-01；新旧所有状态引用样例一致 |
| Q2 | catalog创建queries，迁移compute/export | G5-AC-02、G5-AC-03、G5-AC-06、G5-AC-08；冻结JSON/错误一致 |
| Q3 | 迁移delete事实读取与import诊断 | G5-AC-04、G5-AC-05、G5-AC-06、G5-AC-08；命令SQL仍保留原owner |
| Q4 | 复核 Q1–Q3 已逐项激活的 G8 ARCH-BIZOP-QUERY，扫描剩余SQL并维护合法命令清单 | G5-AC-07；不得误禁预览get/create/bind及其附属读取 |

`ARCH-BIZOP-QUERY` 的保护作用域、合法 preview 命令及别名覆盖见 [G8 TechDoc](../v3.2.10-architecture-guardrails/techdoc.md#governance-rules)。Q1 完成时登记 Archive 查询子边界，Q2 登记 compute/export，Q3 登记 collect/import，各子边界以真实文件、消费者及证据路径激活；G8 尚未接入时按总索引记录后续归属。Q4 核对全部剩余 SQL，不把之前已经迁移的读取作用域继续留作宽泛例外。静态负例为读取协调器新建 raw DB 查询或透传句柄；正例包括 query facade、hasOtherArtifactForBlob，以及 get/create/bind 自有表命令/附属读取。真实同步、过滤、iterator、锁和预算由本项测试证明。

不保留新旧查询的“双读比对”生产模式。等价对比仅在隔离测试中进行。剩余db使用必须在实施记录逐条归属；没有迁移的合法命令/恢复读写不计为本项失败，也不让其成为其他模块绕过仓储的接口。

## 6. 测试与验收映射（计划，未执行）

| 测试入口 | 场景 | AC |
| --- | --- | --- |
| 拟新增 `tests/unit/main-process/biz-op-v327-catalog-queries.test.js` | ACTIVE/PUBLISHED/READY、端点不完整、源顺序、iterator提前停止、无写SQL/连接/锁 | G5-AC-02、G5-AC-03、G5-AC-06、G5-AC-08 |
| 拟新增 `tests/unit/backend/archive-blob-reference-query.test.js` | 排除自身、不同owner、非ready引用、无blob/无其他引用 | G5-AC-01 |
| 既有 `tests/unit/main-process/biz-op-v327-compute-main.test.js` | missing、hold失效、manifest不符、generation及fingerprint | G5-AC-02、G5-AC-06 |
| 既有 `tests/unit/main-process/biz-op-v327-export-main.test.js`、`biz-op-v327-export-rule-version.test.js` | 各导出类型、历史规则、RAW保护与源变化 | G5-AC-03、G5-AC-06 |
| 既有 `tests/unit/main-process/biz-op-v327-delete-main.test.js` | 预览过期/复用、两删除模式、共享保护与closure变化 | G5-AC-04、G5-AC-07 |
| 既有 `tests/unit/main-process/biz-op-v327-import-main.test.js` | producer/digest、关闭屏障与空诊断维护 | G5-AC-05、G5-AC-06 |
| 拟新增 `scripts/integration/biz-op-query-boundary.js` | 临时库真实catalog/archive调用，导入→计算→导出/删除预览输出等价 | G5-AC-01～G5-AC-08 |

集成fixture不得使用用户真实库；脚本自建/清理tmp，输出N/N PASS并用退出码判定。特意覆盖49152/65536字节及4096条边界，禁止通过只比较首几条结果证明全量等价。PR-ready或发布前完整release-check，不能只靠读取文件的regex测试。

## 7. 回退与状态

无持久化格式变化。按Q1/Q2/Q3完整切片回退查询入口与调用方；先等待原任务关停/排空，不在异步readTask期间切代码。原schema和catalog命令始终保留，无需改写历史数据。当前文档编写未执行任何库写入、删除、生产功能或验证；已发布安全合同的沿用不等同本稿实现已通过。

## 8. 切片实施记录与规则同步（文档补充）

沿用本稿既有阶段及任务 ID，按[切片完成标准](../../README.md#slice-completion)逐项交付。优先复用本功能目录已有的 `implementation-notes.md` / `verification.md`；首次实施且没有适用记录时建立 `implementation-notes.md`，使用[实施记录与状态要求](../../README.md#slice-record)中的最小字段，避免同一事实多处维护。设计 AC 和测试计划与实际迁移状态、执行结果分别记录，本次不建立实施记录占位文件。

按[各治理项现行规则入口映射](../../README.md#current-rule-entrypoints)同步本切片影响的规则正文和入口链接。只有职责已在实际生产调用路径落地的模块才能记为现行入口，尚未实现的模块继续标为拟新增；不影响规则时，在切片记录中写明无需更新及原因。本次为文档要求补充，不表示生产实现、边界激活或验证已经完成。
