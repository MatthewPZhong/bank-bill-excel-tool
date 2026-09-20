# G5 实现审查｜BizOP 查询与归档数据边界

审查时间：2026-09-20 19:55；19:57 复核并行发生的 export-inputs 注释调整（Asia/Shanghai）。本审查范围内未发现需修改生产代码的 P1/P2 问题。结论是当前查询迁移差异与已确认合同一致；全量等价、负向场景和集成验证仍以本功能[实施记录](implementation-notes.md)的实际执行证据为准，不能由本次代码审查代替。

## 1. 快照与审查边界

- worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-bizop-query-boundaries`。
- 分支：`codex/v3.2.10-bizop-query-boundaries`。
- 基线及当前 HEAD：`11086a3cbf632a30adbcfa796e4cd81810c5aef9`；以下审查覆盖 HEAD 上未提交的 6 个修改文件及新增 `catalog-queries.js`。
- 依据：[G5 Spec](spec.md)、[G5 TechDoc](techdoc.md)、[总索引 §6.2–§6.4](../../README.md#slice-completion)、主工作区 G2 TechDoc 的任务装配及跨分支约束。
- Q2/Q3 生产差异由非实现者复核；Q1 仓储方法及新单测由本次审查者实现，因此其结论属于作者自核，不虚列为独立复审。
- 本轮只读生产源码；仅新增本审查文件，不更改实现、不提交、不推送。测试和实施文档仍有其他并行工作，不将其未完成时的状态视为最终交付状态。

以下 SHA-256 固定被审查的未提交内容；后续涉及这些文件的变化应补充相应复核。

| 文件 | SHA-256 |
| --- | --- |
| `src/backend/database/archive-repository.js` | `c4dc444507ace2c1f65d84c1f7d0fdbf6f153474caac07b663289aad06174424` |
| `src/main-process/biz-op-v327/catalog.js` | `3c7d739ee0ae476db5851d44a36e047fd4e44461eb96f5a5ab635ad9656e639e` |
| `src/main-process/biz-op-v327/catalog-queries.js` | `3388945cd54045a4cd3bcab27a24f5c766be60522564ae1feda8a1bf6c7669a1` |
| `src/main-process/biz-op-v327/compute-inputs.js` | `ef9e1c4a28a00ca38a8e133cdad09e1ba4196a3178b1e90b104e9961846b1ae4` |
| `src/main-process/biz-op-v327/export-inputs.js` | `c3a77294113eec7dad77ad9e7290f77cf013f9469cf5dba0410077c66e361eb4` |
| `src/main-process/biz-op-v327/delete-preview.js` | `18094d55312d9e97538d234e69d63bf06a13dd35c30de3b46bdf4b6a956ac6cb` |
| `src/main-process/biz-op-v327/import-main.js` | `2d1f62c3e764c2e9e3600ab701ed47767d109c468a4ff25b2d0aeb4de09f3196` |

## 2. 生产行为核对

| 关注项 | 实际核对结论 | 证据入口 |
| --- | --- | --- |
| Q1 归档引用 | 仓储新增同步 `Boolean(get(...))`；原 `blob_id=? AND id!=? LIMIT 1` 原样保留。调用仍由 `artifact.blobId` 非空守卫，不增加 status 或 owner 条件；没有使用全量列表或聚合 referenceCount 替代。 | `archive-repository.js:2491`；`delete-preview.js:53` |
| Q2 计算输入 | ACTIVE head JOIN 和来源 `ORDER BY source_file_order` 不变。required/missing 完整检查发生在来源遍历前；逐条消费后原 `metadataCount` 检查、ready/hash/hold、行数及 manifest 检查都保留在协调器。reference、source、document 及最终返回对象的属性构造顺序与基线相同；fingerprint 算法与排序未移动。 | `catalog-queries.js:7`；`compute-inputs.js:27` |
| RESULT 导出 | 先查询 PUBLISHED run，再取得 START_OP/END_OP；非恰好 2 条及端点版本缺失仍抛原 metadata missing 错误。metadata 构造顺序仍为 version/startDate/endDate/inputFingerprint/publishedAt，随后追加 startInputVersion/endInputVersion。manifest owner 与 resultContractFor、显式版本冲突检查仍在 `freezeExportSource` 中，未提前或省略。 | `catalog-queries.js:20`；`export-inputs.js:7` |
| ERRORS 导出 | READY diagnostic 与 sealed lifecycle JOIN 沿用原 SQL；manifest 使用 lifecycle 的 sealed 路径及 diagnostic digest。producer、scanComplete、errorCountExact、sampleCount 字段及 Boolean 转换不变。缺少 report/lifecycle 时仍在调用方返回原 unavailable 错误。 | `catalog-queries.js:33` |
| DATASET 与 RAW 导出 | ACTIVE 与 outputKind 前缀匹配仍同时要求；metadata 顺序不变。RAW 的 manifest、artifact ready/hash、v327-input hold、异步真实文件验证及错误顺序未改。`source` 先重建 objectKind/metadata，再按基线位置追加 outputKind/columnSchemaVersion/objectId/manifest 字段，未因 query 返回 manifest 较早而改变冻结 JSON 属性顺序。 | `catalog-queries.js:39`；`export-inputs.js:12`、`:20`、`:22` |
| Q3 删除闭包 | selection 排序、runIds 的 Set 插入、关联 run DISTINCT 无新增排序、结果 run 最终排序不变。来源共用较宽投影，但只将原 artifactId/originalName/sha256 装入 originals；新增来源字段未加入 charge 或 closure digest。dataset/run 返回对象属性顺序和 tableName/operationMonth 构造不变。 | `catalog-queries.js:47`；`delete-preview.js:14` |
| 删除保护与预算 | hold 与 lock 的取得和两删除模式统计未移走；总选取 4096、逐项 charge 4096/49152、closure 65536、响应 131072 保留原位置及错误。预览 10 分钟、64 个未确认上限、generation/完整 closure digest、模式和复用校验未改。 | `delete-preview.js:7`、`:17`、`:47`、`:66`、`:76`、`:91` |
| 导入诊断 | dispatch `.all()` 和 report `.get()` 读取原行，无 Boolean/数字转换。原唯一 producer、manifest digest、owner、关闭事实、8 MiB 样本 manifest 验证仍由 import coordinator 拥有。成功且 sample_count=0 的诊断继续经 `protection.retireDiagnostic` 维护动作处理。 | `catalog-queries.js:66`；`import-main.js:12`、`:111`、`:143` |
| 准入/同连接 | queries 捕获 catalog 原 db；只公开 frozen 方法集合，无新连接、缓存、写 SQL、事务、锁或文件 IO。compute-main 的 exclusive、export-main 的 readTask 和删除 create 的同步 read 范围未改，bind 仍首先 assertExclusive。查询迭代器只在同步 collect 中消费，不跨 await。 | `catalog.js:12`、`:19`、`:389`；`compute-main.js:14`；`export-main.js:22`；`delete-preview.js:77`、`:103` |
| 合法命令与兼容 | `catalog.db` 和 transaction 保留；delete-preview 剩余 5 处直接 prepare 只涉及自有 delete_previews 的 get、过期清理、容量查询、插入及绑定更新。compute-inputs/export-inputs/import-main 无剩余直接 DB 查询；catalog、compute-main、recovery/diagnostic 的未迁移命令/读写不在本次强制搬迁范围。 | `catalog.js:389`；`delete-preview.js:70`、`:81`、`:82`、`:85`、`:106` |
| G2 兼容 | archive-repository 仅添加窄查询方法；catalog 的 archive 创建、ensureSchema、构造依赖和原命令公开方式保留。未改 G2 的 prepared scope、terminal registry、归档控制器或 Main 装配代码，未引入 G2 对新 query 的依赖。此处证明的是当前差异的兼容形态，尚未证明与 G2 成果的实际合并或运行。 | `archive-repository.js` 的 6 行新增差异；`catalog.js` 的 3 行新增及公开字段差异 |

## 3. 已执行验证

本节所有命令显式使用上述 worktree 为工作目录。

1. Q1 真实临时数据库测试及原仓储回归：

   ```text
   node --test tests/unit/backend/archive-blob-reference-query.test.js tests/unit/backend/database/archive-repository.test.js
   tests 35 / pass 35 / fail 0 / skipped 0，退出码 0
   ```

   其中新增 5 项覆盖无 Blob/无其他引用、排除自身、跨 owner 的 ready/pending/failed 引用、原 SQL 结果等价、删除引用后的即时结果、数据库错误透传。20,000 条其他引用使用临时磁盘 SQLite，并通过 statement 适配器拒绝 all/iterate/run/exec、确认 LIMIT 1 标量读取。该结果覆盖 Q1 及现有 Archive 仓储合同，不自动外推为 Q2/Q3 通过。

2. 针对三个 query iterator 执行只读 Node 探针，以带 `finally` 的委托迭代器分别验证 `break`、循环体抛错及显式 `return()`：

   ```text
   3/3 iterator APIs PASS; break/throw/return each close the delegated iterator;
   9/9 closures, one row per consumption.
   ```

   三种 API 均只前进一条，外层退出均触发内层关闭；同时确认 query 对象 frozen。该探针验证 JS generator/IteratorClose 行为，使用替身 db，不等同真实 SQLite 大闭包或预算边界集成验证。三个生产 generator 的 `for-of` 直接委托当前 SQLite `.iterate()`，没有缓存全量结果。

3. `git diff --check` 通过；扫描四个迁移调用方剩余 DB 入口，与上一节的合法命令清单一致。

## 4. 风险、未验证项与后续归属

- 本审查没有发现需要修复的生产差异；测试仍在补充时不认定 G5 切片验收全部完成。冻结 JSON 与 fingerprint、删除完整 digest、4096/49152/65536 边界、负向错误时序及导入 producer/closure 合同，须由本功能最终测试记录提供执行证据。
- `readDispatchesForPlan` 保留基线 `.all()`，RESULT 端点查询也保留基线 `.all()`；这符合既定接口，不应在本次审查中顺带改写其容量或错误合同。来源/关联 run/run artifacts 三种可扩张遍历使用 iterator。
- G8 当前尚未接入。本审查的文本/源码扫描不是已激活的机器规则；Q1/Q2/Q3 子边界、preview 合法命令及附属读取例外须按最终实施记录交由 G8 集成登记，不能用宽泛例外放回已经迁移的读取。
- G2 实际代码合并、release 集成、完整 release-check、Windows/Excel/WPS/GUI 人工验收均不在本次已执行证据中。生产职责迁移未新增 GUI 行为，但不据此声明平台验收通过。
- 若后续生产文件 SHA-256 改变，按实际差异补复核；无数据迁移，回退仍按 TechDoc 的 Q1/Q2/Q3 完整切片恢复调用方与接口，不能留下调用新接口而仓储/query 缺失的组合。


## 5. 最终测试复核与收口补充

生产文件与第 1 节七项摘要逐项复核仍相同。测试实现由非作者另行只读审查，发现的三项 P2 证据问题已在本分支修正；这些发现针对测试可信度，不是新的生产行为缺陷。

| 测试发现 | 最终处置与证据 |
| --- | --- |
| deepEqual 不检查对象 key 顺序，原文案声称序列化顺序等价 | equivalent 同时检查完整 JSON.stringify 相等；最终 9/9 集成通过 |
| RAW current 先修复后，旧 oracle 不再面对同一故障初态 | 每个 oracle 分别回滚数据库、恢复相同文件字节并施加同一损坏；分别断言实际目录文件修复和 canonical 字节不变 |
| 目录 fsync 不支持的平台会误跑持久化成功场景 | 沿用真实能力探测，5 组 durable 场景明确 skip、4 组 SQL/预算继续；skip 不计 PASS。本机 supported、9/9 全执行，Windows 未验证，未改 CI |

空诊断回收另补了真实 maintenance Task、reclaim queue、报告状态及文件消失链；手工自动报告故障 fixture 由旧 raw DB 改为 query 故障注入，该套件已 46/46 通过。最终相关单测合计 153/153、0 skip；新集成 9/9、0 skip；lint 与差异空白检查通过，完整证据见[实施记录](implementation-notes.md)。

未修改的 11086a3c 隔离源码快照也复现 `E13-G Action Manifest drift`，因此保留为基线已有的完整门禁待处理项，未改写生成清单。未运行全量 release-check；未集成 G2/G8/release，未做 Windows/Excel/WPS/GUI 或安装包验收。本结论不宣称 PR-ready 或可发布。
