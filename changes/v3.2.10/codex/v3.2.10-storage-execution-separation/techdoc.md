# TechDoc｜v3.2.10 仓储、执行编排与纯校验分离（G6）

| 项目 | 内容 |
| --- | --- |
| 目标版本 / 计划分支 | `3.2.10` / `codex/v3.2.10-storage-execution-separation`（已创建） |
| 基线 | 正式附注标签 `v3.2.9`，`main@11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 日期 / 状态 | 2026-09-20 / v2（独立审查 R5 修订）+ 用户已确认 B3 补充；实际状态见[实施记录](implementation-notes.md) |
| 需求 | [Spec](spec.md)，G6-AC-01～G6-AC-08 |
| 集成 / 依赖 | `release/v3.2.10` 的基线与集成要求见[总索引](../../README.md)；G8 消费本项纯模块路径，G4 无硬前置 |

## 1. 设计文件与职责（实际落地状态见实施记录）

| 文件 | 类型 | 职责 |
| --- | --- | --- |
| `src/backend/vcc-financial-op/content-hash-contract.js` | 新增 | hash 版本、contentHash、pendingCanonicalValues、pendingContentHash 的唯一实现。 |
| `src/backend/vcc-financial-op/mapped-lineage-contract.js` | 新增 | 存储版本重建与 assertMappedLineage，无 IO。 |
| `src/backend/vcc-financial-op/row-mapper.js` | 修改 | import/re-export hash 合同；日期/金额/行映射仍留原处。 |
| `src/main-process/vcc-financial-op-dataset-writer.js` | 修改 | import 并兼容 re-export assertMappedLineage；去除同名实现。 |
| `src/backend/vcc-financial-op/review-export-plan.js` | 修改 | 直接 import mapped-lineage-contract。 |
| `src/main-process/acquiring-bill-currency-multiworker-service.js` | 新增 | 计划→执行→失败清理的编排。 |
| `src/backend/acquiring-bill-currency-db/run-repository.js` | 修改 | 只提供 SQL 计划和持久化操作，移出 worker 调用。 |
| `src/main-process/acquiring-bill-currency-session.js` | 修改 | 装配 service，沿用既有资源选择、run 状态及 resume。 |
| `src/main-process/run-check-multiworker.js` | B0 修复 | 补齐已创建 worker 所有权及真实退出等待；其后复用该 executor，不修改 SQL 算法和 merge 事务。 |
| `src/main.js` | B3 已批准修复 | 仅删除 pool failureListener 的无归属解锁，保留 run/resume 所属 prepare 的 finally/onAbandon；相应 sourceHashes 通过既有生成器的独立输出对照；已发布历史快照保持原样。 |

## 2. VCC 纯模块的完整依赖闭包

不能直接将新校验模块连接到 row-mapper：row-mapper 会经 normalizers 加载 xlsx。采用以下依赖方向：

```text
row-mapper ───────────────→ content-hash-contract → node:crypto + definitions
writer / review-plan ────→ mapped-lineage-contract → content-hash-contract + definitions
```

### 2.1 content-hash-contract（拟新增接口）

```js
module.exports = {
  HASH_VERSION,                 // 2，原值迁移
  PENDING_HASH_VERSION,         // 3，原值迁移
  contentHash,                 // (sourceType, rawJson, assignedSubject) -> hex string
  pendingCanonicalValues,      // (values, rawContractVersion) -> new array
  pendingContentHash           // (values, rawContractVersion) -> hex string
};
```

原样迁移 [row-mapper.js:113](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/vcc-financial-op/row-mapper.js:113) 的三个函数与版本常量。contentHash 的 CHANNEL payload 精确保留 `{ raw: rawJson, assignedSubject: String(value == null ? '' : value).trim() }` 的 JSON 序列化；其他类型直接 hash 原 rawJson。Pending v1 按旧 header 名映射到当前 header 顺序，v2 返回新数组；长度不匹配沿用原异常，不增添隐式补列。

row-mapper 继续导出原函数名/版本常量，使现有消费者无需同步改路径；不保留另一份函数正文，不更改 applyCanonicalCurrencyHash 的调用顺序。

### 2.2 mapped-lineage-contract（拟新增接口）

```js
assertMappedLineage(expected, mapped); // 成功 undefined；失败抛原完整性异常
mappedContentHashForStoredVersion(expected, mapped); // -> string
```

`expected` 沿用存储行字段：`source_type, hash_version, subject, import_record_id, source_row, idempotency_key, content_hash`；`mapped` 沿用 `disposition, contentHash, values, rawContractVersion, idempotencyKey`。不做字段改名或额外序列化。

普通当前版本 2 与 Pending 当前版本 3 直接使用 mapped.contentHash；普通旧版本 1 与 Pending 旧版本 2 原样重建。未知版本和不一致均沿用 `archive-row-integrity-failure` 的原中文 message。disposition 存在时保持原分支，不先重建 hash 从而改变异常优先级。

纯模块只依赖 definitions 和 content-hash-contract，后者只依赖 node:crypto 与 definitions。不得 import normalizers、row-mapper、writer、DB、filesystem、worker 或 Excel 库。旧 writer 的同名导出直接指向新函数；移除路径兼容不属于首阶段必要目标。

## 3. Acquiring 接口与唯一职责

### 3.1 计划接口（拟新增仓储导出）

```js
buildMultiworkerPlan(db, { runId, monthKey, chunkSize });
// -> {
//   totalBillRows, totalChunks,
//   chunks: [{ chunkIndex, bindParams: [monthKey, chunkSize, offset] }],
//   selectSql, partColumns, targetTable, targetColumns, prefixValues
// }
cleanupFailedMultiworkerRun(db, { runId }); // 同步事务 DELETE 指定run；失败抛出
```

计划复用 `buildSelectOnlyChunkSql()` 与当前 `DIFF_JOIN_BODY_SQL`，不复制 SQL 正文。固定：

```js
partColumns = ['bill_import_id', 'flow_currency', 'flow_amount_abs', 'diff_type'];
targetColumns = ['run_id', ...partColumns];
targetTable = 'acquiring_bill_currency_diff_rows';
prefixValues = [runId];
```

上述 table、columns、selectSql 不接受 Renderer 输入。service 在全部参数验证成功后调用计划；计划接收已归一化的 chunkSize，runId/monthKey 的 SQL 用法及 COUNT 位置保持原 wrapper 顺序。计划函数只读/构造计划，不创建 run、不启动 worker、不推进 chunk_progress。失败清理函数仅按 run_id 删除 diff，BEGIN/COMMIT/ROLLBACK 从原 catch 原样提取。

### 3.2 应用 service（拟新增接口）

```js
createAcquiringMultiworkerService({ runRepository, executeWriteSplitChunks })
  .insertDiffRows(db, {
    runId, monthKey, chunkSize, dbPath, workerCount, tempDir,
    batchContext, onChunkDone = null, cancelToken = null
  }); // Promise<{ totalChunks, totalProcessedBillRows,
      //           totalInsertedDiffRows, lastCompletedChunkIndex }>
```

只有 Main/session 装配 `executeWriteSplitChunks = runWriteSplitChunks`。该函数不是 IPC 参数，不允许 renderer 传执行函数或 SQL。service 按原 wrapper 顺序完整验证：runId 为 truthy number → monthKey 为 truthy → `cs=Number(chunkSize)` 为正整数 → dbPath 为非空 string → workerCount 本身为正整数 → tempDir 为非空 string，全部完成后才查询 COUNT。chunkSize 的数值字符串仍接受，不能额外 trim 路径或收紧 runId/monthKey 类型；错误文案即使保留旧函数名前缀也原样保留。无新增隐式默认。

service 先构造计划；0 行返回 `{totalChunks:0,totalProcessedBillRows:0,totalInsertedDiffRows:0,lastCompletedChunkIndex:-1}`。其余执行器参数沿用计划字段，加 `db, dbPath, workerCount, tempDir, batchContext, cancelToken, onProgress`。执行器既有 `initTimeoutMs=10000`、`closeTimeoutMs=5000` 保持，service 不额外 Promise.race。

progress 转换保持：`chunkIndex, totalChunks, processedRows=min(chunkSize, remaining), insertedDiffRows=ev.rowCount, elapsedMs=0`。onChunkDone 抛出的异常按原实现吞掉，不令主流程失败。该事件代表 reader 完成，不更新持久化 chunk_progress；session 成功后才按原路径标 `data-complete`。

正常执行器结果 `{insertedRows,totalChunks,workerCount}` 映射回旧仓储 API 的四字段摘要，processed 为总 bill 行数，lastCompletedChunkIndex 为 totalChunks-1。

## 4. B0 退出收口修复与后续失败顺序

### 4.1 现有缺口与必须落地的修复

当前 startWorker 在 init-error/error/timeout 后调用 terminate 立即 reject；closePool 在超时/发送 close 失败后调用 terminate 立即 finish；启动组以 Promise.all 全部成功后才赋给 workers。这三个位置使“上层 await executor”不足以证明所有 worker 已退出。B0 是明确的 P1 修复切片，不把它混为仅移动函数，也不以扩大 shutdown 超时掩盖问题。

在现有 executor 内建立每次调用私有的 group records，不新增跨 run 常驻池：

```js
// 拟新增内部状态，不跨 IPC，不持久化
{ worker, exitPromise, exited, initSettled, stopPromise }
```

1. 每次 Worker 构造成功，立即把 record 加入 group，并安装贯穿初始化/执行/关闭的 exit 监听，再 post init。构造抛错不产生 record，但已经创建的其他 record 仍由 group 拥有。
2. 单 worker 的 init Promise 只表达就绪/失败，不自行放弃退出所有权。init-error、error、timeout、postMessage 抛错统一保留首错误并触发该组 stop；所有初始化 Promise 必须 settle，晚到 init-done 不再启动派发。采用 allSettled 收集启动结果，不能用“整体赋值成功”作为清理名单来源。
3. stopPromise 对单 record 幂等。优先发送 close，等待 exit；优雅关闭超过既有 closeTimeoutMs=5000 或发送失败则只触发一次 terminate。terminate Promise 完成或已观察到 exit 才是退出确认；绝不在发出 terminate 时 resolve。
4. terminate 抛错/reject 且未 exit 时记录诊断并保留 exit 等待；不新增第二个“超时当作退出”的兜底。等待期间上层任务尚未完成、资源尚未释放；诊断记录 worker/run 标识和失败阶段，不记录业务行。
5. 任一 init 失败停止本组全部 worker，等待所有 record 的退出确认，之后才让 executor 拒绝；其原 init 首错误仍是主异常。运行中 chunk 未完成便 exit（包括 code=0）必须令该 chunk 失败，不能悬挂等待消息或当作成功。
6. finally 等所有 record 退出，再 cleanupTempFiles，再结束 executor Promise。这里的退出屏障约束本组结束清理；§4.3 中写当前 chunk 前重建历史残留是独立的既有步骤，不能据此删除。正常结果、reader/merge 首错误和 cleanup 失败的原优先级保留；不得吞“尚未退出”并继续清理。外部 service 因 await 尚未结束而不能先删 run、tempDir 或释放本调用资源。

B0 不改变取消的派发粒度、分片 SQL、每 chunk 事务、默认 initTimeoutMs=10000 或 partial/resume 模型。真实退出时间可能长于 5 秒，5 秒只约束优雅关闭等待。新增故障注入必须证明该区别。

### 4.2 service 与 session 的失败顺序

1. session 沿用原 gate、effectiveWorkerCount、自适应 chunkSize；需要时创建自身外层 tempDir，保存 ownership。
2. service 同步构建计划，再 await executor。executor 保持 reader 全部结束后才 merge、按 chunkIndex/seq 合并、每 chunk 独立事务。
3. executor 的 finally 使用 B0 修复后的真实退出屏障，再做 part 清理，service 不提前关闭 db 或清临时目录。
4. executor 拒绝后，service 调仓储 cleanupFailedMultiworkerRun。清理若也失败，按基线保留原始异常，不把清理错误转成功、不改变原 error code。
5. session catch 沿用 partial 标记；硬崩或残留情况下，既有 resumeFromChunkIndex=0 先清 run 后单 worker 重跑。service 不私自启动 retry。
6. session finally 仅删除自己创建且仍独占使用的外层 tempDir。caller 提供 tempDir 保持原拥有者；executor 按 §4.3 的受管命名空间授权，只处理本次派发的精确 part 路径及 SQLite 附属文件。

这是职责搬迁，不承诺整个 run 原子性或所有失败均无残留。修复既有“cleanup 错误只保留主异常”的诊断能力若改变对外行为，应另立行为变更，不混入本项。

### 4.3 受管 part、历史残留及目录复用合同（R5 修订）

当前 [Main:17615](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:17615) 将应用自己管理的 `storageRoot/.mw-tmp` 传给 session；session 无传入目录时通过 `makeTempDir()` 创建私有目录。二者都把该目录内 `part-<chunkIndex>.sqlite` 及其 `-wal/-shm/-journal` 命名空间保留给 write-split 执行器。**该调用关系与目录来源提供受管授权，文件名匹配本身不提供授权。** service 继续接收现有 `tempDir` 字符串，不新增 IPC 目录参数、run 子目录、磁盘所有权清单或恢复迁移。

| 阶段 / 对象 | 授权与操作 |
| --- | --- |
| 调用前提 | 可信 Main/session 调用方提供应用受管目录，或本次创建的独占私有目录；调用方在该调用存续期保留该目录的 part 命名空间，不把用户输出/源文件置入其中。直接调用 service/executor 的测试也必须使用自建临时目录并明确该保留用途。任意用户目录中碰巧同名的文件不因此成为受管 part，不能把这样的目录作为合法生产调用。 |
| 历史残留写前重建 | 保留 [writeChunkToTemp:137](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/run-check-multiworker-worker.js:137)：只对本次已经分派 chunk 的 `path.join(tempDir, 'part-' + chunkIndex + '.sqlite')` 及上述三个 sidecar 做原写前删除，再建库写入。此处可覆盖以前 run 在同一受管命名空间留下的旧文件，是 AC-07 的明确例外；不依靠 runId 判断 part 归属。 |
| 结束清理 | 保留 [cleanupTempFiles:142](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/run-check-multiworker.js:142) 的精确路径清单和四个后缀，不 glob、不扫描删除所有 `part-*`，不递归清 caller 目录；仅在 B0 确认本组所有已创建 worker 退出之后执行。以前 run 的未触及 part 不因本次存在而被批量清理；它们只有未来被对应 chunk 复用时才按写前重建处理。 |
| 数据库 diff | `cleanupFailedMultiworkerRun` 的 WHERE 仍限定本次 `runId`；part 的跨 run 重建例外不扩展到其他 run 的数据库 diff。 |
| 外层目录 / 无关文件 | session 只移除自身 `makeTempDir()` 的私有根；caller 根、保留命名空间之外的标记文件/子目录保持不变。该迁移不接管外部路径的生命周期。 |
| 并发与复用 | 同一 tempDir 的 part 命名空间仅支持顺序复用。前一组尚未确认真实退出或尚在清理时，调用方不得启动第二组；进程崩溃后的重启可把已终止旧进程留下的受管 part 当残留。沿用现有 Main [模块级 operation lock:1587](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:1587) 和 [run prepare 取锁:17546](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:17546)，该锁不是按 monthKey 分立；B1/B3 要核对执行/错误/取消直至释放锁的调用链并保存证据；本次不宣称支持两个活跃 run 共用 tempDir，也不引入自动抢占或跨进程清理。若实施发现已有并行入口绕过该前提，应阻断该切片验收并补明确修复设计，不能凭 stale 文件名继续删。 |

删除失败的错误吞吐方式、目录创建与 part 格式沿用基线，不把本次文档修订声称为已增加的文件系统身份防护。迁移必须保持 C1 字节级等价测试；不得为了“保留所有旧文件”移除写前重建，也不得把历史 part 例外扩大为任意临时文件清理权。B0 的“退出后结束清理”与 C1 的“安全复用目录后、写当前 chunk 前重建”同时成立。

### 4.4 B3 锁归属补充（2026-09-20 用户确认）

§4.3 实施核查已复现旧 idle worker failure 释放下一 prepare 锁的基线问题；用户确认按[最小补充方案](b3-lock-fix-proposal.md)修复。方案正文维护批准范围、所有者释放协议与验证要求，本节只引用，不复制第二套协议。实际 Main 回归与独立审查证据登记在[实施记录](implementation-notes.md)。共享 prepared 包装器的独立基线异常路径属于 G2 协作边界，不因本次最小修复被宣称全域闭合。

## 5. 兼容迁移与旧接口移除

VCC：先原样提取 hash contract、让 row-mapper re-export；再提取 lineage contract，让 writer re-export；最后切 review plan。每步同一函数只有一份正文。

Acquiring：新增计划/清理方法和 service；将生产 session 一次切换到 service。仓储旧 `insertDiffRowsByJoinMultiWorker` 不通过 require Main 保留兼容。若迁移中的测试仍使用旧名，改为从 service 驱动相同业务行为；仅允许测试装配层的显式适配，不在仓储中留下后门执行器。

完成前扫描全部 `insertDiffRowsByJoinMultiWorker` 调用：生产引用必须归零，测试迁移完成后删除仓储旧导出。禁止未迁完就删函数；不存在长期的可选执行模式或根据参数猜测新旧路径。

## 6. 实施任务与 AC 对应

| 阶段 | 内容 | 对应验收 |
| --- | --- | --- |
| A1 | 固定普通/Pending/CHANNEL旧新版本与失配fixture | G6-AC-02 |
| A2 | 提取两纯模块，保留旧导出，切review plan | G6-AC-01、G6-AC-02、G6-AC-03 |
| B0 | 补已创建worker注册、init全量收口、terminate/exit等待；证明退出前不做结束清理 | G6-AC-06、G6-AC-07 |
| B1 | 锁定0/1/多chunk、SQL/行顺序和失败路径；保留C1，核对目录来源、顺序复用前提与无关文件 | G6-AC-05、G6-AC-06、G6-AC-07 |
| B2 | 增加仓储计划/cleanup和service，切session | G6-AC-04、G6-AC-05、G6-AC-06 |
| B3 | 清点旧调用、删除反向import、验证resume与回退；核对caller目录及跨run diff隔离 | G6-AC-04、G6-AC-07、G6-AC-08 |

## 7. 测试计划（实际执行结果见实施记录）

已有入口：`tests/unit/main-process/vcc-financial-op-dataset-writer.test.js`、`vcc-financial-op-review-export.test.js`、`acquiring-multiworker-contract.test.js`、`run-check-multiworker.test.js`。复用其真实 fixture 与旧版哈希，不写仅断言文件名的“业务测试”。

B0 扩充既有 `tests/unit/main-process/run-check-multiworker.test.js`：同组一成功/一初始化失败、构造失败、init postMessage 抛错、init timeout、close postMessage 抛错、terminate 延迟、terminate reject 后迟到 exit、工作中 code=0 意外退出。测试在明确释放 exit 前断言 executor 尚未 settle、service cleanup 与结束阶段的 part 删除未执行（不将此前合法的 C1 写前重建计为结束清理）；释放后只关停/结算一次，无遗留 worker。真实 worker fixture 只使用测试临时 SQLite 与私有目录。对应 G6-AC-06、07。

B1/B3 复用既有 `run-check-multiworker.test.js` 的 C1（受管旧 `part-0.sqlite` 含垃圾行，结果仍与单 worker 基线逐行一致）；扩展同一 fixture，在 caller 目录放置命名空间之外的标记文件及子目录，断言内容和路径未变、caller 根仍在；再放置不属于本次派发索引的受管旧 part，断言本次不进行全目录清理。测试同时保留其他 `run_id` 的 diff，验证失败清理只影响当前 run。通过受控 executor 的延迟 exit 和调用序列检查，同一目录必须在上次 executor 及清理完成后才被再次使用。以上对应 G6-AC-05、06、07；外部独立审查已执行的 C1 仅是基线证据，未来实施仍需针对修改后代码验证，本次不重复执行并冒称实现通过。

拟新增：

- `tests/unit/backend/vcc-financial-op/mapped-lineage-contract.test.js`：G6-AC-01～03；封禁 IO/Excel require 的加载探针、所有 hash 分支、disposition/键/内容不符、异常优先级。
- `tests/unit/main-process/acquiring-multiworker-service.test.js`：G6-AC-04～07；executor 参数与返回、0行不启动、reader/merge失败、cleanup失败保主异常、进度不等提交。
- `scripts/integration/acquiring-worker-boundary.js`：G6-AC-05～08；自建临时库，单/多worker逐行等价、取消及部分合并后resume、受管part跨run复用不混入旧行、caller目录及无关文件不变；按仓库规范输出 N/N PASS，退出码决定结果。

G8 对两个纯模块的传递本地依赖与外部包施加检查。正式交付前完整 release-check；Acquiring 对账/取消/续跑 UI 与文件占用场景按适用平台手验，局部probe不能替代。

## 8. 回退与未验证边界

无 schema、hash或持久化版本迁移。以完整阶段为回退单元，VCC 同时恢复两个消费者与函数来源，Acquiring 的 B1～B3 回退同时恢复 session/仓储调用链，但保留先行 B0 修复；不能因职责迁移回退重新引入提前清理。若必须回退 B0，须明确接受原退出缺口且不能把 G6-AC-06 标为完成。先按原关停屏障排空任务再切版本；已有 partial run 仍按基线 resume，不人工清库。回退不得删除业务源文件或改存储hash。本稿无未定业务决策；实现、运行证据及尚未验证的平台行为见实施记录。B3 回退时不得单独恢复无归属解锁而继续宣称 D8 锁归属通过。

## 9. 切片实施记录与规则同步（文档补充）

沿用本稿既有阶段及任务 ID，按[切片完成标准](../../README.md#slice-completion)逐项交付。优先复用本功能目录已有的 `implementation-notes.md` / `verification.md`；首次实施且没有适用记录时建立 `implementation-notes.md`，使用[实施记录与状态要求](../../README.md#slice-record)中的最小字段，避免同一事实多处维护。设计 AC 和测试计划与实际迁移状态、执行结果分别记录，本次不建立实施记录占位文件。

按[各治理项现行规则入口映射](../../README.md#current-rule-entrypoints)同步本切片影响的规则正文和入口链接。只有职责已在实际生产调用路径落地的模块才能记为现行入口，尚未实现的模块继续标为拟新增；不影响规则时，在切片记录中写明无需更新及原因。本次为文档要求补充，不表示生产实现、边界激活或验证已经完成。
