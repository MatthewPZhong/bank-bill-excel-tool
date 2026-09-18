# TechDoc — v3.2.9 存档中心批次永久删除

> D-01 已于 2026-09-11 确认：仅删除存档中心原件及可确认归属的受管文件。当前实现固定 `managed-only`；下述外部路径接入条件仅保留为边界说明，不属于本轮实现或验收分支。

| 项目 | 内容 |
| --- | --- |
| 目标版本 | `3.2.9` |
| 适用分支 | `codex/v3.2.9-archive-center-permanent-delete` |
| 集成目标 | `release/v3.2.9` |
| 基线 | `v3.2.8^{commit}` = `2ba9ef14fe972363b604955636cff0c9ac53700f` |
| 关联 Spec | [spec.md](spec.md)，REQ-01～03、ARC-DEL-01～09、AT-01～24 |
| 文档状态 | 实现及 review 修复完成，模块历史自动验证通过，已集成 release；D-01 固定 managed-only |
| 日期 | 2026-09-11；集成状态更新于 2026-09-19 |
| 建议仓库路径 | `changes/v3.2.9/codex/v3.2.9-archive-center-permanent-delete/techdoc.md` |
| 本轮执行状态 | 已集成本地 `release/v3.2.9`；当前组合验证与发布进度见 [release.md](../../release.md)，Windows/GUI 人工验收为 NOT_RUN |

> 第 0～13 节保留设计与历史审查依据：“已有”指基线源码行为，“拟新增/拟扩展”指设计约束，初稿的“待核对”和未勾选 Checklist 不代表当前实施进度。后续实施约定及八轮 review 修复见第 14～21 节和 [implementation-notes.md](implementation-notes.md)，模块历史自动验证见 [validation.md](validation.md)；最终 release 组合门禁另行记录。实施不得改变 D-01 删除授权范围。

## 0. 技术目标与关键边界

以**存档中心统一删除链路**为修改单位，使用户确认后的批次删除同时覆盖信息、约定原始文件和系统独占存档资源；失败能持久跟踪、可安全重试、不误报完成。

技术边界：保留已有锁、业务引用、恢复和存储维护保护；不级联修改业务计算数据；不把所有 `sourcePath` 都视为可删原文件；不递归清空存档根；不重建一套并行清理队列；不改变到期清理的授权范围；不在模块分支执行整版发布。

**D-01 与 Spec 完全一致：** 外部导入原路径是否在范围内尚未确认。基础设计支持区分两类文件，但不把“具备实现能力”当作“已经获得删除授权”。未关闭 D-01 时不可宣告完整验收，不启用外部路径删除。

## 1. 已核实的基线调用链

### 1.1 UI → Controller → Service → Repository

```text
src/renderer.js
  confirmArchiveBatchDelete(button)
    → getArchiveCenterApi().deleteBatch(batchId)
      → preload / main 的存档中心桥接（实施前复核实际 IPC 绑定）
        → ArchiveCenterController.deleteBatch(batchNumberOrId)
          → ArchiveService.deleteBatch(batchId)
            → _run('deleteBatch', ...)
              → _deleteBatchUnlocked(batchId)
                → repository.listArtifacts(batchId)
                → repository.deleteBatch(batchId)
                → _releaseSourcePaths(sourcePaths)
                → _executeCleanupJobUnlocked(cleanupJob)
```

UI、Controller、Service、Repository 的上述方法已定位；本轮未逐行复核 preload/main 的具体 channel 名，故不在本文虚构现有 IPC 字符串。[R1～R5]

### 1.2 前端当前行为

`confirmArchiveBatchDelete()` 直接包含需要移除的提示；确认后禁用确认按钮并调用统一 API；`metadataDeleted` 为真时清空选中与详情，`ok === false` 时显示物理副本待重试信息，再刷新批次与统计。[R1]

**正确判断：** 已有部分失败展示，不是“所有情况都无条件成功”。本次应收紧明确完成判据，并补上删除任务长期可见/重试和异步刷新保护，不能仅修改一句成功提示。

### 1.3 Controller 当前行为

Controller 检查存储维护状态、解析 batch ID，调用 Service；metadata 已删除时清除 `batchNumberToId` 对应缓存，映射为 `success` 或 `partial`。目前将“metadata 已删且 ok 不是 false”视为成功，缺少独立的全目标完成标志。[R2]

### 1.4 Repository 当前行为

`deleteBatch()` 在写事务内完成以下步骤：[R4]

1. 拒绝不存在、活动、锁定、有效业务引用、恢复中的目标。
2. 为已有 operation key 写入 `archive_operation_issuances.deleted_at`。
3. 收集 artifact、目录化路径和候选 Blob。
4. 删除目标 `archive_artifacts`、已解决的恢复 overlay 和 `archive_batches`。
5. 对候选 Blob 查询剩余 artifact 引用，只删除无引用 Blob 的元数据。
6. 如存在目录化路径或已释放 Blob，插入 `archive_cleanup_jobs`。

现有 cleanup job 以 `materialized_paths_json` 和 `released_blobs_json` 保存清理证据。它不是一个天然覆盖所有外部原文件和临时副本的清单。

### 1.5 Service 当前行为

`_executeCleanupJobUnlocked()` 校验批次目录，逐个调用 materializer 删除目录化文件，清理空目录，再删除 released Blob。失败登记 cleanup job，成功删除 job。[R3]

`_releaseSourcePaths()` 去重源路径，保留仍有 unresolved artifact 引用的路径，再调用 `onSourceReleased`。查询失败会返回；释放回调异常会被吸收，而且不返回逐文件完成结果。[R5]

因此：

- 该方法属于尽力释放资源，**不能充当本次严格删除的完成合同**。
- 本次不能仅增加一次该调用或把其返回视为成功。
- 也不能直接把它改成全局抛错：它可能被其他正常归档路径使用，必须先核对所有调用点。

### 1.6 与自动维护的耦合

`cleanupExpired()` 同样调用 `_deleteBatchUnlocked()`。任何新增“删除原始来源文件”的默认参数，都可能误扩大自动清理的权限。[R3]

方案必须显式区分手动删除、retention 和旧任务恢复，并将选择后的策略保存在清理计划中，不能仅在内存里临时开关。

## 2. 总体设计决策

| 决策 | 本稿设计 | 理由 |
| --- | --- | --- |
| 修改范围 | 存档中心统一入口；不写工具箱专属判断 | 满足用户纠正后的模块归属 |
| 清理基础 | 扩展现有 `archive_cleanup_jobs` | 复用已有事务与恢复骨架，避免两套队列 |
| 原文件策略 | 主进程决定且持久化；渲染端不能选择任意策略 | 防止 UI 参数成为越界删除授权 |
| 成功条件 | 增加显式 `fullyDeleted`，并检查全部计划项收口 | metadata 删除不代表文件已清理 |
| 源文件清理 | 严格清理纳入计划执行器，不以尽力回调代替 | 防止源文件异常被吞掉 |
| 数据库/文件顺序 | 同事务保存删除证据和 metadata 变更，再执行文件清理 | 文件删除不可由数据库回滚恢复 |
| 共享内容 | 执行每个释放动作前重新验证有效引用 | 清理失败后可能出现新的引用 |
| 失败 UI | 轻量清理任务提示/明细，不恢复业务批次卡片 | 元数据删除后仍可定位未完成动作 |
| 历史任务 | 旧计划继续旧授权，禁止自动扩展到外部原文件 | 升级不等于重新授权 |
| 未收口迁移 | journal 存在即阻止新删除；先由原迁移恢复收口 | 维护锁释放不证明另一根副本已删除 |
| 未确认终态通知 | 与目标 owner 相关的 outbox/afterTerminal 未收口即阻止新删除 | 批次终态不证明业务恢复和通知确认已完成 |
| 外部原路径 | D-01 关闭后接入严格源身份校验 | 不依据模糊术语盲删用户文件 |

## 3. 删除策略与计划

### 3.1 策略分类（拟新增内部合同）

```ts
type DeleteOrigin = 'manual' | 'retention' | 'legacy-recovery';
type SourcePolicy = 'managed-only' | 'verified-external-inputs';
```

`managed-only` 指应用受管存档原件及有归属证据的可释放文件。`verified-external-inputs` 在前者基础上纳入获授权且经验证的外部输入原路径；它不包含所有 output 的 `sourcePath`，也不包含用户另存文件。

未确认的 D-01 不是可执行的第三种删除策略：手动删除最终上线策略尚未确定时应停止对应启用与完整验收。自动清理和旧计划不能默认切入 `verified-external-inputs`。

### 3.2 主进程构造计划

建议抽出 `buildBatchDeletePlan()`，由 Controller/Service 调用，读取当前 Repository 和已登记的文件归属信息。名称是设计建议，不是现有 API。

计划至少包含：

```ts
interface BatchDeletePlanV2 {
  version: 2;
  deletionId: string;
  archiveInstanceId: string;
  batchId: number;
  batchNumber: string;
  localDate: string;
  moduleId: string;
  origin: DeleteOrigin;
  sourcePolicy: SourcePolicy;
  rootIdentity: unknown;        // 复用已验证的存储根身份，不信任 UI 路径
  batchRevision: string;        // 批次状态、文件清单和引用的校验依据
  items: DeleteItem[];
  createdAt: string;
}

interface DeleteItem {
  itemId: string;
  kind: 'materialized' | 'blob' | 'owned-temp' | 'external-input';
  managedRelativePath?: string;
  sourceIdentityRef?: string;   // 只在主进程/持久层使用
  expectedIdentity: unknown;    // 内容证据 + 对象/路径所有权证据
  state: 'pending' | 'deleted' | 'already-missing' |
         'preserved-shared' | 'blocked' | 'failed';
  lastErrorCode?: string;
}
```

实际类型应复用项目已存在的 fingerprint、source snapshot、root identity 类型，不能在各模块复制不兼容的同名结构。`unknown` 是待对接的类型位置，不是允许不校验的数据。

### 3.3 计划构造约束

目标从主进程的真实批次、artifact 与所有权登记中获取，不扫描用户全盘，不按文件名搜索删除，不接受 renderer 提交的目标数组。

清单在逻辑层去重，但不能仅按 SHA 去重不同独占路径。两个独立文件即使内容相同也需要各自处理；共享 Blob 的物理目标与逻辑引用必须分别计数。

必须在删除 artifacts 前提取所有必要证据。对 failed/pending artifact，不得仅因没有 ready Blob 就遗漏已存在的受管原件或获得授权的源文件。

批次 ID、archive instance、目标根和所有权必须一致。源身份不足、目标被其他活动任务持有、关键归属未知时，在破坏性步骤前拒绝本次删除；运行后才出现的冲突转为未完成任务。

## 4. 持久化与事务

### 4.1 扩展现有 cleanup job

建议给 `archive_cleanup_jobs` 增加版本化计划及状态字段，实际 SQL 命名须与当前迁移规范对齐：

| 拟扩展字段 | 用途 |
| --- | --- |
| `plan_version` | 区分现有路径/Blob 清单与新版完整计划 |
| `deletion_id` | 稳定的删除请求身份与并发去重 |
| `archive_instance_id` | 防止跨存档实例误用任务 |
| `origin`、`source_policy` | 保存当时已授权范围；恢复时不得重新推导为更大范围 |
| `plan_json` | 版本化目标、归属、文件身份与必要源证据 |
| `progress_json` | 已完成/失败/阻止项及有限错误信息 |
| `state` | `pending` / `running` / `failed`；历史重叠恢复另用 `waiting-migration` 表示原计划项已清理但迁移副本仍待收口，不能作为完成状态 |

保留既有 `batch_id`、`batch_number`、`local_date`、旧路径数组及 attempt/error 字段的兼容读取。旧任务不因为缺少新字段就被解释成“允许删除外部文件”。

**关键调整：** 不能只在 `materializedPaths.length > 0 || releasedBlobs.length > 0` 时建立新清理计划。若存在获授权的源文件或受管临时文件，即使没有 ready 存档内容，也必须持久保存这些目标。

不得以 JSON 解析失败得到空数组后宣告成功。新版计划缺少关键字段、类型不合法或路径证据无效时，返回明确的计划损坏错误。

### 4.2 最小完成凭证

已有 `archive_operation_issuances.deleted_at` 能表示发行对应批次已删除，但不能仅靠该字段证明物理文件已经全部清理。[R4]

建议优先在现有控制记录中补充删除完成状态和时间，用于请求重发、完成后响应丢失及重启查询。没有 operation key 的旧批次若无法复用该记录，可补充以 `archiveInstanceId + batchId/deletionId` 为键的最小完成凭证；它不是第二套清理队列。

凭证只保留对象身份、策略、结论与时间，不长期保留完整文件路径、业务明细或内容。另按第 4.6 节保留处理迟到终态通知所需的最小 owner 身份与终态/后处理收口事实；它们属于控制信息，不保存完整 Task 或业务批次。具体落表在实现前核对现有 schema 后确定。

无已完成凭证且批次不存在时，返回“批次不存在/无法确认该请求的完成状态”，不得凭 not-found 伪造 `fullyDeleted: true`。重复请求至少必须无额外破坏副作用。

### 4.3 只读/暂存文件归属

实施前检查 `.readonly`、暂存、owner journal 的真实登记机制。存在可复用所有权索引时直接使用。

只有目录名随机、文件名相同或 SHA 相同，均不能证明旧临时文件属于目标批次。若当前生成路径没有持久 owner 信息，应在新文件生成时登记“实例、批次/文件引用、文件类型、受管相对路径、指纹与状态”，再由删除计划读取；不得对历史未知文件事后猜测认领。

生成文件与所有权登记之间也应有可恢复状态，避免生成成功但登记失败形成无法定位的副本。成功后只保留必要 owner 信息，删除完成后清理关联登记。

### 4.4 单次数据库事务边界

```text
获取现有存储/批次变更保护
→ 在同一删除准入保护内重读迁移 journal 与目标 owner/outbox inventory
→ 核验计划、活动状态、锁、业务引用、恢复状态及终态通知收口事实
→ BEGIN（沿用 withWriteTransaction）
    写入必要防重放标记及最小 owner 终态/后处理收口事实
    保存不可丢失的清理计划及目标身份
    删除目标批次正常展示元数据、artifacts、可回收专属关联
    释放本批次 Blob 逻辑引用，确定当下候选回收项
  COMMIT
→ 执行文件清理并持久记录进度
→ 全部完成：登记完成凭证、收口 cleanup job
```

“保存计划”和“metadata 删除”必须在同一事务；不能先删 metadata 再单独写计划。数据库提交失败时不得进入文件删除。

迁移准入、终态通知登记/重放和删除提交必须参与同一有效协调，避免 inventory 检查之后又登记目标通知或切换存档根。先获取 owner/outbox 协调，再进入根级操作；沿用这个顺序，不在根级操作中反向等待一个需要根级操作的 outbox flush。发现待恢复事项即释放本次删除准入并返回阻止结果；由原恢复入口处理，之后重新预检。预检凭证或一次文件列表查询不能代替该协调。

不要跨耗时文件 I/O 长时间保持 SQLite 写事务，也不要在该事务内调用 owner 恢复或 afterTerminal。SQLite 与文件系统不构成可自动回滚的单一事务。文件已删除后只能继续安全收口，不保证恢复原文件。

### 4.5 批次关联信息盘点

除已核实的 `archive_batches`、`archive_artifacts` 和恢复 overlay 外，实施前核对 `archive_task_runs`、关联任务/父流程、owner 引用、outbox 与各表的实际外键行为。

逐项区分：本批次专属业务元数据应清理；共享关系只解除目标边；当前有效业务引用不能强制删除；发号、防重放与必要审计身份按最小控制信息保留。不能全删某个 parentRunId 下的所有批次，也不能未经核实依赖 CASCADE 处理全部关联。

### 4.6 终态 outbox 与业务后处理

**基线事实：** `owner.version === 1 && owner.kind === 'file-batch'` 的终态重放位于 legacy issuance 删除检查之前；即使 Task 已经终态，仍调用 `finishFileTask()`。批次已删除时该调用返回不存在，通知不被确认；启动要求 outbox 无剩余项，因而可能阻断业务启动。[R11] 保留 `deleted_at` 和仅验证“不复活”不足以覆盖这一分支。

**本次确定的前置规则：** 新删除请求必须先证明目标任务及其终态通知都已收口，而不能仅依赖 batch/task 的 `succeeded`、`failed` 或 `cancelled` 状态。

1. 只读预检及提交前重校验读取持久 outbox 和有关 owner 恢复记录。使用 archive instance、owner version/kind、module、operationKey、taskRunId、batchId 与发行记录验证关联；旧通知只能用已核实的 lineage 归属，不能凭文件名或单独一个 batchId 猜测。
2. 与目标关联的终态通知尚未 ACK、`afterTerminal` 尚未完成或任务 owner 仍有恢复责任时，返回恢复未完成；metadata、引用及文件保持不变。inventory 读取失败、损坏或无法排除目标依赖时同样阻止，不将空列表作为默认值。
3. 由既有 owner 恢复/outbox 入口先完成耐久终态、必要 `afterTerminal` 及通知 ACK，再允许重新预检。`prepareDeleteBatch()` 不调用 flush、后处理或删除 outbox，不改变取消确认的无副作用合同。
4. 删除事务保留能验证迟到通知的最小控制事实：完整 owner/发行身份、耐久终态结论，以及该 owner 是否需要后处理、已完成后处理的稳定身份和确认事实。已收口证据必须来自原 owner 流程，不能由删除请求伪造；清理专属 Task 元数据时不得丢失这些控制字段。

**迟到通知与已删除批次的重放：** 在进入 file-batch 分支的 `finishFileTask()` 之前检查删除控制事实。仅当完整身份匹配、终态相符，且无需后处理或可验证同一后处理已经完成时，才将其作为已收口的重复通知幂等 ACK，不重建批次、不重复执行业务动作。对于尚需后处理的历史意图，仍由原 owner 按其恢复合同完成并记录结果后 ACK；不能只凭 `not-found`、`deleted_at` 或物理删除完成凭证丢弃通知。身份冲突、证据不足或后处理失败时保留原意图并明确诊断；不得降低现有启动保护来掩盖问题。缺少必要历史证据的场景应单列待处理，不能宣称其重启验收已通过。

此控制也适用于复用删除链路的 retention，保持其文件删除授权不变。不得为避免 outbox 阻塞而级联删除关联任务、释放业务 hold 或跳过原 owner 后处理。

## 5. 物理清理执行器

### 5.1 与现有服务的关系

保留 `_run()` 和现有根级操作串行化/维护门禁。可将新版计划执行整理为 `executeBatchDeletePlan()`，由 `_executeCleanupJobUnlocked()` 按 `plan_version` 分发。

旧版本任务沿旧授权执行，但也应应用必要的路径和实时共享引用保护。计划执行器不得独立绕开原根级操作协调。

`_releaseSourcePaths()` 可以继续承担不影响归档结果的尽力释放；本次必删文件必须作为显式目标由严格执行器处理。若确需扩展回调，应新增返回逐项结果的严格适配器，而不是改变所有旧调用的异常语义。

### 5.2 清理顺序

在目标全部预检查、计划与元数据事务提交后，推荐顺序为：可释放的已知受管临时文件 → 批次目录化文件 → 无有效引用 Blob → 已授权外部输入文件（D-01 启用时）→ 已知空批次目录 → 最终状态核对。

外部输入最后处理可减少在存档清理尚未开始时就删除用户来源文件的风险，但**不能提供跨多文件原子删除**。每一步成功都应在计划中记录；失败不得吞掉或改写为成功。

### 5.3 受管路径保护

复用 `_resolveManagedRelative()`、`_assertManagedRoot()`、`_assertManagedFilePath()` 和 materializer 的路径保护，核对路径实际位于当前允许根内。[R3][R9]

拒绝路径穿越、绝对路径替代相对路径、符号链接/目录联接重定向、非预期目录目标。批次目录只清理计划中的文件，目录仅在为空时删除；遇到陌生文件不得使用整目录递归删除来“完成清理”。

存档根离线、archive instance 不一致或存在未收口迁移 journal 时，按第 11.1 节停止相应删除，不依赖维护锁是否已释放。不能因为某个路径返回 ENOENT，就把整个存档盘消失当成删除成功。

### 5.4 Blob 再引用保护

现有 Repository 在 metadata 删除时计算 remaining 引用；但清理任务失败后可能稍后重试。当前读取到的 `_removeReleasedBlobs()` 按任务提供的 Blob 路径执行删除，未在该函数内重查当前引用。[R3][R4]

本次设计要求每次实际删除 Blob 前，在同一有效变更保护内重新查询当前引用/持有状态，并复核内容身份。若 Blob 已被新批次重新引用，该项记为 `preserved-shared`，不删除新引用所需内容，也不能再次减少引用计数。

这是需要补测试和保护的风险点，不将尚未运行复现场景写成已经发生的生产故障。不能只检查旧 blob ID，因为同 SHA 内容可能已经以新记录重新入库；应按当前内容身份和实际路径核查。

### 5.5 文件身份与竞态

采用现有文件快照和内容摘要作为证据的一部分，同时检查所有权、真实路径/父目录身份及对象指纹。相同 SHA 不等于同一个被授权删除的文件。

预检查到删除之间必须重新检查对象身份。操作系统允许的路径/句柄保护能力需在实际 Electron/Node 版本和 Windows/macOS 上验证；普通 `stat` 后接 `rm` 不能被文档描述为跨平台绝对无竞态原子删除。

不能可靠证明目标仍是原对象时拒绝删除。只对受管、经验证对象采用已有安全文件操作；不得为追求“彻底”越过所有权保护。

### 5.6 重试与幂等

已删除或可安全确认缺失的目标不重复计为新删除字节。旧失败目标在每次重试前重新核验身份和依赖；同路径出现新文件即停止，不能依据旧清单盲删。

单次调用采用有界重试，避免无限等待文件占用；失败后保留计划，由用户【重试清理】或既有维护入口继续。恢复时只重试未收口项，必要时再验证已完成项的控制状态，不重新生成业务批次。

## 6. 外部原始输入文件：本轮不启用

本节为条件设计，**不是当前已授权执行的行为**。

### 6.1 必须核对的源文件链路

逐个实际接入模块检查：用户选择的路径 → 解析读取路径 → 受管快照/中间路径 → archive artifact 的 `sourcePath` → source snapshot/expected SHA → 任务持有与重试引用。

建立一张实施证据表，至少记录模块、入口、原路径字段、快照字段、内容摘要来源、是否被暂存替换、持有者/共享依赖查询方式、现有清理适配器和回归测试。未完成的模块不能被默认为已经覆盖外部原文件删除。

文件 `direction` 和业务角色也必须核对。`artifact.sourcePath` 可能是输入或输出的来源路径；**不能遍历所有 artifact.sourcePath 后统一 unlink**。

### 6.2 执行条件

只有同时满足以下条件，外部文件才能进入执行清单：D-01 明确包含；主进程持有该批次实际导入证据；当前对象身份未改变；不是另存/无关输出；不是链接到未知目标；没有其他有效批次、任务或业务数据依赖；确认范围已向用户呈现。

外部源文件被另一有效批次/任务共享时，在删除前阻止本次动作并说明依赖；不能像共享 Blob 那样默默跳过外部原文件后报告它也已删除。不得自动连删其他批次。

### 6.3 无法处理的历史输入

历史记录缺少真实原路径、对象身份或关联证据时，不按同名、同目录或同内容补猜。返回可定位的源证据不足状态，保留未完成信息，不能为了完成验收隐藏该类数据。

外部原文件已经被修改/替换时，不删除替换后的文件。用户后来重新选文件应被视为新的需验证授权，不是“原路径还在即可继续”。任何新增选择界面均需同步 Spec，不在实现中偷偷增加默认删除范围。

## 7. API 与 UI 合同（拟扩展）

### 7.1 接口形状

保留存档中心命名空间和现有统一入口；不要为工具箱新增独立永久删除 API。建议：

| 拟定接口 | 说明 |
| --- | --- |
| `prepareDeleteBatch(batchId)` | 只读预检，返回安全显示摘要、阻止原因和短期确认凭证 |
| `deleteBatch(batchId, confirmationToken)` | 重校验状态与凭证，执行本次删除并返回明确结果 |
| `listDeleteCleanupJobs()` | 返回未完成删除任务的安全摘要，不暴露任意可执行路径 |
| `retryDeleteCleanupJob(cleanupJobId)` | 主进程根据已持久化、已授权计划重新校验并重试 |

这些是拟新增/扩展方法，不是已经存在的 IPC 名称。实施时同步 preload、main、Controller、preview mock 与契约测试。

确认凭证由主进程生成，绑定调用窗口/会话、batch、instance、策略及计划版本，短期有效且不可用于其他批次。计划、锁、迁移 journal 或目标 owner/终态通知状态变化以及存储根切换时失效；不能只比较 UI 传入批次号。提交时仍在第 4.4 节协调内重读权威状态，不能凭预检结果跳过检查。相同请求正在执行时复用结果/任务身份，不重复创建计划。

预检不删除记录、不落“已授权删除”标记；取消确认时只撤销或让短期预检信息过期。确认后持久化的删除任务不依赖 renderer 内存存活。

### 7.2 成功结果示例

```json
{
  "status": "success",
  "ok": true,
  "metadataDeleted": true,
  "fullyDeleted": true,
  "deletionId": "server-generated-id",
  "cleanupJobId": null,
  "message": "存档批次及对应原始文件已永久删除",
  "summary": {
    "planned": 5,
    "deleted": 4,
    "alreadyMissing": 0,
    "preservedShared": 1,
    "remaining": 0
  },
  "failures": []
}
```

数字仅用于说明字段，不是测试数据或实际删除结果。文案必须与 D-01 的最终删除范围一致。

### 7.3 部分失败结果示例

```json
{
  "status": "partial",
  "ok": false,
  "metadataDeleted": true,
  "fullyDeleted": false,
  "deletionId": "server-generated-id",
  "cleanupJobId": 123,
  "message": "删除未完成：部分文件尚未清理，请解除占用或检查权限后重试",
  "failures": [
    { "itemId": "item-3", "code": "ARCHIVE_FILE_BUSY", "retryable": true }
  ]
}
```

错误码为拟定协议示例，实际应与项目错误标准统一。preflight 拒绝通常为 `status: failed`、`metadataDeleted: false`、`fullyDeleted: false`。

迁移 journal 未收口时提示“存档位置变更尚未完成，请先完成迁移恢复后重试”；终态通知或后处理未收口时提示“该批次的任务恢复尚未完成，请完成恢复后重试”。响应附安全的阻止原因及可用恢复入口信息；不得自动从删除预检触发恢复，也不能把这种拒绝显示为部分文件已经删除。

### 7.4 Controller 映射与缓存

仅 Service 明确证明全部目标收口时才返回 `fullyDeleted: true`。不得再以 `result.ok !== false` 或仅 `metadataDeleted` 为成功依据；缺少关键字段视为契约错误。

metadata 确已删除时仍应清除 `batchNumberToId` 映射，但不可因此把 cleanup job 的失败状态一起丢弃。Controller 不吞掉 Service 的 item 失败信息，不在没有读取计划结果时自行生成成功文案。

### 7.5 前端状态处理

完整成功至少同时满足：

```js
const fullyDeleted = result?.status === 'success'
  && result?.ok === true
  && result?.metadataDeleted === true
  && result?.fullyDeleted === true;
```

`metadataDeleted` 为真但 `fullyDeleted` 不为真：清空正常批次详情，显示“删除未完成”，刷新未完成任务入口，而非继续保留一个可以打开文件的陈旧批次卡片。

尚未发生 metadata 删除的失败：保留批次选择，显示原因，允许用户处理原因后重试。关闭/取消和执行中状态遵循 Spec；确认按钮必须在真正失败且可再次提交时恢复，不让重复点击并发执行。

增加删除请求标识/现有请求序号保护：旧详情请求、文件列表请求或批次列表响应晚到时不得恢复已删除批次。关联任务区域需刷新，但不能级联删除其他批次。

本次删除本身未产生真实运行文件，不应为它再新建一个普通存档批次。新增 IPC 是否需要登记为无文件操作须沿项目实际任务策略注册表核对。

## 8. 中断、失败与恢复矩阵

| 发生点 | 数据状态 | 应有行为 |
| --- | --- | --- |
| 用户未确认 | 无删除授权，文件不变 | 取消不产生删除副作用 |
| 预检/重校验失败 | 批次与文件仍在 | 明确阻止，不能写完成标记 |
| 数据库事务提交前异常 | 事务整体回滚 | 不执行物理清理 |
| 事务提交后、首次文件删除前退出 | 批次 metadata 已删，计划已持久保存 | 重启/维护恢复计划，不重新创建批次 |
| 部分文件删除后异常 | 一部分文件已删，剩余计划仍可定位 | 返回或恢复为未完成；不承诺恢复已删文件 |
| 全部文件已清理、完成记录写入前退出 | 计划可能仍在 | 幂等复验，安全收口，不误删重建对象 |
| 完成提交后响应丢失 | 完成凭证已在 | 重复请求读取完成事实，不执行第二轮破坏动作 |
| 计划重试时 Blob 被重新引用 | 新批次依赖存在 | 保留共享内容，更新计划项结果 |
| 计划重试时源路径被替换 | 对象身份冲突 | 不删除新文件，返回待核定状态 |
| 存储根离线或迁移中 | 根身份/可达性不满足 | 不把 ENOENT 当成完成，不访问猜测的新旧根 |
| 迁移已返回失败/部分完成，维护锁已释放 | pre-switch 失败或 post-switch `cleanup-pending` journal 仍在，另一根可能有副本 | 阻止新删除；先原迁移恢复收口，再重新预检 |
| 删除已提交但清理未完成，随后申请迁移 | cleanup job 仍在，批次 metadata 可能已删除 | 保留原根计划并先完成清理；拒绝开始新迁移 |
| 批次终态但 terminal-owner 通知未 ACK | 终态或 afterTerminal/通知确认尚未完整收口 | 预检/提交前拒绝删除，由原 owner 恢复完成后再试 |
| 已删除批次收到迟到终态通知 | 删除控制事实与原 owner 事实需核对 | 按第 4.6 节验证身份和终态/后处理完成证据后安全 ACK；无证据不丢弃 |

沿用既有维护入口的触发节奏；失败不能导致后台无限重试，关闭窗口也不应丢失已授权任务。是否在启动还是首次进入时处理某类旧任务，以实际当前维护机制为准，不仅根据旧提示“下次启动重试”来推断。

## 9. 修改落点与实施拆分

| 文件/位置 | 修改职责 | 状态 |
| --- | --- | --- |
| `src/renderer.js` | 统一移除旧句、确认/执行状态、严格结果判断、失败任务入口、请求时序保护 | 现有删除函数已定位 |
| `src/preload.js`、`src/main.js` | 复核并扩展统一存档 IPC；参数校验与受控方法暴露 | 路径已知，准确 channel/handler 待实施核对 |
| `src/main-process/archive-center/controller.js` | 预检、执行、结果映射、缓存失效、重试摘要；终态 owner inventory 与已删批次的重放收口 | 已定位 deleteBatch、file-batch outbox 和 startup remaining 门禁 |
| `src/main-process/archive-center/archive-service.js` | 策略隔离、计划执行、严格失败传播、恢复与维护门禁 | 已定位删除及物理清理方法 |
| `src/backend/database/archive-repository.js` | 幂等迁移、同事务计划/metadata 收口、引用查询、删除凭证及最小 owner 收口事实 | 已定位删除事务与 cleanup jobs |
| `src/main-process/archive-center/storage-root-manager.js` | 提供受保护的未收口 journal 状态；删除/迁移双向准入协调 | 已定位维护释放、cleanup-pending 与现有 cleanup job 迁移门禁 |
| `src/main-process/archive-center/task-lifecycle.js`、outbox/owner 适配器 | 终态通知登记、后处理收口及 ACK 与删除协调，保留取消恢复合同 | 已定位 fileTask 取消及 owner 重放路径 |
| `src/main-process/archive-center/batch-delete-plan.js` | 计划构造/校验与版本化解码 | **建议新增**；不强制重构无关代码 |
| `src/main-process/archive-center/batch-delete-cleanup.js` | 逐项文件清理和结果汇总 | **建议新增**；可在保持清晰边界下复用现有文件 |
| 现有 source snapshot、materializer、存储根/owner 相关代码 | 复用身份保护，补足已知归属登记，不放宽安全检查 | 具体调用点待实施核对 |
| `onSourceReleased` 注入点及模块适配器 | 确认回调范围，避免全局异常语义回归 | 尚未完整核对 |
| preview/mock 与现有存档测试 | 新成功字段、partial、阻止和重试契约 | 待修改/新增 |

推荐在同一个模块分支拆成三组提交：先完成策略/计划与持久化测试，再接入物理清理及恢复，最后接入 UI/IPC 与跨模块回归。不要在第一组仅删提示后就把需求标为完成。

## 10. 测试方案

### 10.1 测试结构

先搜索并扩展现有存档中心测试；缺少覆盖时可新增以下测试文件，名称只是建议：

```text
tests/unit/archive-center-permanent-delete.test.js
tests/unit/archive-center-delete-contract.test.js
scripts/integration/archive-center-delete-recovery.js
```

测试应使用真实临时文件和测试 SQLite 数据库验证最终状态；故障注入用于精确模拟 I/O/DB 错误，不替代全部真实磁盘验证。UI 预览只能证明静态外观，不能替代删除操作测试。

### 10.2 分层覆盖与 Spec 对照

| 层 | 核心内容 | Spec 用例 |
| --- | --- | --- |
| 策略/计划单元 | origin 策略、不可信路径、完整输入输出清单、D-01 门禁 | AT-04/05/11/17/19/24 |
| Repository 真实数据库 | 同事务持久化、锁/hold/recovery 拒绝、引用释放、发号不复用 | AT-06/07/12/14/15/23 |
| Service 真实临时文件 | 目录文件、独占 Blob、缺失路径、清理错误聚合 | AT-03/04/08/10/20 |
| 中断恢复集成 | 提交前后故障点、部分清理、完成响应丢失、重复请求；file-batch 终态 outbox、afterTerminal 和初始化成功 | AT-12/13/14/15/21 |
| 并发/共享 | 新批次重新引用 Blob、同路径替换；迁移并发、迁移返回后未收口、删除失败后申请迁移 | AT-06/09/18/22 |
| UI/IPC 契约 | 所有模块共用入口、取消无副作用、结果字段严格校验 | AT-01/02/08/15/16 |
| 外部来源条件测试 | 原路径血缘、不同模块输入角色、共享源依赖和另存保护 | AT-05/09/23/24 |

### 10.3 必须特别验证的回归

- `_releaseSourcePaths()`/严格源适配器报错时，目标没有被完整清理不得返回完整成功；正常归档的尽力释放语义不受污染。
- 只有外部源/已登记暂存对象、没有 materialized 或 released Blob 的计划仍会持久化。
- cleanup plan 解码损坏或关键字段缺失不能退化为空计划成功。
- 一个 Blob 因旧删除失败而保留，随后被新批次引用，再重试旧清理时内容仍在。
- 删除完成后旧 IPC 结果、outbox 或任务回调不会让批次重新出现；覆盖 legacy 与 `owner.version === 1 && kind === 'file-batch'` 两种重放路径，不只断言“不复活”。
- 真实 File Task 已取消或其他终态但通知未 ACK 时，预检和提交均拒绝删除；模拟 afterTerminal 失败、inventory 读取失败及预检之后新增通知，验证原批次/引用/文件不变且原意图保留。原 owner 恢复完成后再删除，断言相关后处理无丢失、无重复业务效果、目标通知已 ACK；隔离夹具 `remaining === 0` 且 Controller 初始化成功。
- 已删除批次收到身份匹配的已收口重复终态通知时，可验证幂等 ACK 和初始化成功；反例覆盖身份不符、终态冲突、缺失后处理完成证据，不能把 not-found 当成功或丢弃意图。
- 迁移切换前失败且目标已有文件，以及切换后旧根清理失败/离线的 cleanup-pending，两种状态都在维护锁释放后发起删除：保持两根文件及批次信息不变并明确拒绝。由原迁移恢复收口后重新确认删除，检查两根的该批次独占文件实际不存在。
- 预检后出现迁移 journal 时提交必须被拒绝；删除先产生待清理 job 后申请迁移时，保持原根和计划并拒绝迁移，先按原计划安全重试。另用升级前已有 pre-switch journal + cleanup job 的重叠夹具，验证第 11.1 节原计划清理 → waiting-migration → 原迁移恢复 → 完成凭证的顺序；在每一阶段中断重启，特别覆盖迁移写 done 后/删除完成事务前、完成事务后/移除 journal 前，以及无 journal 且缺少完成证据的反例，均不互等、不提前 fullyDeleted、不扩大范围。不能用“迁移与删除正在并发”的一个测试代替这些顺序场景。
- 外部输出来源路径、用户另存副本和无关同名文件不因 sourcePath 扫描被删除。
- 旧计划迁移/升级只保留原授权，不把外部输入追加到原来的 retention 任务。
- 存储根离线时所有文件路径缺失不能使整批假成功。

Windows 文件占用行为需要 Windows 上真实复核；不能用其他系统“打开文件时仍可 unlink”的结果替代。权限失败测试注意测试进程权限，必要时使用受控 I/O 注入加实际环境人工复核。

### 10.4 计划执行的项目门禁

以下是原设计保留的项目门禁要求；模块各轮执行结果见 [validation.md](validation.md)，不能替代当前 release 最终组合门禁。执行时核对最终工作树 `package.json` 的实际 scripts 和项目当前规则：

```bash
npm run test:unit
npm run test:integration
npm run smoke
# 整体门禁入口；按项目既定流程执行，不把重复运行当作新增覆盖。
npm run release-check
```

对新增高风险删除路径增加专项测试，并记录命令、最终 commit、通过/失败数及未执行原因。依当前适用的 AGENTS/CODEX/项目规则执行必要审查，不依据历史文档恢复用户已经移除的旧 Skill 或强行运行不再适用的变量扫描。

人工界面验收至少包括普通业务模块批次、工具箱批次、业务引用保护批次、文件占用失败、退出后重试及 D-01 的最终范围。不得用真实用户数据进行不可逆试删。

## 11. 兼容、迁移与回退

### 11.1 兼容与迁移

新增 schema 使用项目既有幂等方式；保留旧 cleanup job 解码与旧归档数据读取能力。旧批次缺少 source identity 时明确进入证据不足处理，不自动扫描目录补足。

计划必须绑定 archive instance/根身份；沿用现有维护协调，并增加**持久迁移 journal 未收口即阻止新删除**的条件。当前根已明确、`isMaintenanceRequested()` 已为 false 或迁移调用已返回，均不能证明迁移文件已清理。[R10]

| 顺序/状态 | 本次采用的规则 |
| --- | --- |
| 迁移正在执行 | 拒绝新删除，保持已有维护保护 |
| 切换前失败，目标根可能已有已发布副本 | 只要 journal 未收口就拒绝新删除；由原迁移恢复核定并完成两根收口 |
| 已切换，旧根仍为 `cleanup-pending`，包括旧盘离线 | 即使维护锁已释放也拒绝新删除；等待原迁移恢复完成旧根清理后重新预检 |
| 删除已提交，cleanup job 尚未完成，再申请迁移 | 复用 `_assertSourceReady()` 对未完成 cleanup job 的拒绝；先在原根按原计划完成清理，再允许新迁移 |
| 读取 journal 失败/损坏，或计划与实例/根身份冲突 | 明确阻止并保留证据；不能推断无 journal，也不能猜测新旧根 |

预检和提交前都检查 journal；本次选择“先恢复、后新删除”，不新增跨两根的删除范围，也不在只读预检里运行迁移恢复。正常新流程应由双向准入防止产生重叠；升级前已经同时存在的 journal 和 cleanup job 必须单独分流，不能一律让双方互相等待。

**历史重叠的确定收口顺序：**

1. 在独占恢复协调内核对持久根设置、迁移是否已提交切换、journal、cleanup job 的实例/原根及两端所有权；暂停普通删除、迁移和相关后台清理。证据无法关联时保留两类记录并给出恢复诊断，不猜测路径或循环互等。
2. 若切换尚未提交、设置仍指向 job 的原根，先执行这些既有 job 在原根/原授权范围内尚未完成的项目，保留逐项进度。项目完成后 job 进入 `waiting-migration`，持久绑定原迁移 journal 身份，仍在未完成任务列表可见，不删除 job、不写 `fullyDeleted`；迁移已发布到目标根的副本仍由迁移 journal 负责。任一项目失败则保留原计划停止本轮推进。
3. 仅为重放这份已存在、身份已验证的 pre-switch journal，允许 `_assertSourceReady()` 的 cleanup job 检查识别上述同根且所有原计划项目已完成的 `waiting-migration` 项；其他源根检查继续执行，任何未清理或无关 job 仍拒绝。此例外不能用于发起新迁移。随后由原迁移恢复按 durable inventory 清理目标残留、恢复迁移并完成旧根清理；不得由删除执行器扫描第二个根。
4. 只有原迁移已核定相关副本收口且 job 控制事实一致时，才允许完成删除。存在关联 `waiting-migration` job 时，迁移恢复须先耐久写入 `done` journal（保留迁移身份和可核验完成事实），暂不按旧流程移除 journal；随后原子登记删除完成凭证并移除关联 job，最后由原迁移入口清理 `done` journal。重启对 `done` 阶段继续这个收尾流程，不重新迁移；若 journal 已缺失且没有等价耐久完成证据，保留 job 诊断，不把缺失当成功。任一步中断均以持久阶段和逐项事实恢复，不再次删除已完成目标，也不将挂起项误解为空计划成功。若切换已经提交，则先按 post-switch 迁移恢复完成旧根清理，再依据 job 原根及项目身份处理剩余已授权清理；不能将旧路径换前缀后重跑。

该分流是本次需实现并测试的恢复设计，当前 `_startMigration(existingJournal)` 仍无条件调用源根就绪检查，不能声称它已原生支持以上顺序。

迁移 journal 必须由原恢复流程按既有完成标准收口，不得为了放行删除直接删除 journal。另一根离线时保持阻止；不能把旧绝对路径字符串替换为新前缀后宣告计划恢复。

### 11.2 回退限制

回退软件不等于恢复已删除文件。真正执行永久删除后，只有用户独立备份或重新导入可以提供内容恢复，本次不创建隐藏的永久业务文件备份来假称删除。

如新版生成了旧版不认识的清理计划，应限制旧版接管这些计划，或在明确完成/停止安全收口后再降级；不能让旧版把新版计划当成空任务丢弃。迁移应避免删改旧必需列，兼容性通过实际读写测试证明。

发生缺陷时先阻止新的删除请求并保留已有计划；不得为“回滚”擦掉失败任务证据或移动正式版本标签。

## 12. 分支与交付操作说明

确定分支：`codex/v3.2.9-archive-center-permanent-delete`。集成目标：`release/v3.2.9`，功能现已合入该本地 release。基线为已核实的 `v3.2.8` 正式标签提交。[R6]

以下命令保留为初稿的分支创建参考，不是当前待执行清单。开发分支和 release 已存在，本次状态同步只核对，不运行创建或重置命令：

```bash
# 实施前核对工作区、远端和基线；不要覆盖本地未提交内容。
git status --short
git branch --show-current
git fetch origin --prune --tags
git rev-parse 'v3.2.8^{commit}'
# 预期为 2ba9ef14fe972363b604955636cff0c9ac53700f；不一致先核实。

# 仅在该模块分支不存在且工作区安全时创建。
git switch -c codex/v3.2.9-archive-center-permanent-delete 'v3.2.8^{commit}'
```

本模块已由已获授权的集成人员合入已有 `release/v3.2.9`；本模块不直接以 main 作为功能完成后的合入目标。已有 release 的其他模块改动必须保留。[R8]

本分支只维护本需求 Spec、TechDoc 与必要专项证据；`package.json`/lockfile 升版、CHANGELOG、版本功能历史和用户指南的整版汇总由 release 阶段统一协调，避免多个模块分支分别升版或宣告发布。

## 13. 初稿实施 Checklist（历史）

下表保留初稿状态供追溯；当前实现及模块回归记录见 [implementation-notes.md](implementation-notes.md)、[validation.md](validation.md)，集成与整版交付状态见 [release.md](../../release.md)。Windows/macOS 适用人工验收及最终组合门禁须分别按实际结果记录，不由历史勾选状态推定通过。

- [ ] 读取真实工作树中的当前项目规则，核对基线、已有分支与并行修改。
- [x] 关闭 Spec D-01：仅受管文件，并固定确认文案。
- [ ] 核对统一 IPC、源路径适配器、owner 信息和所有受影响模块。
- [ ] 建立严格删除计划与版本化持久合同，不重建重复队列。
- [ ] 原子登记清理证据、元数据变更与必要防重放控制。
- [ ] 落实未收口迁移 journal 的预检/提交门禁及未完成 cleanup job 的反向迁移保护。
- [ ] 落实目标 terminal-owner intent/afterTerminal 收口门禁、准入协调和已删 owner 的安全重复通知处理。
- [ ] 逐项物理清理、实时共享引用检查、异常聚合和完成凭证。
- [ ] 隔离主动删除、retention 与旧计划恢复的授权。
- [ ] 完成 UI 严格成功判据、失败任务可见与重试、请求时序保护。
- [ ] 执行 Spec AT-01～24 的适用测试，关闭 D-01 对应条件分支。
- [ ] 完成 Windows/macOS 适用验证、组合回归及最终提交门禁。
- [ ] 在实际交付记录中写入修改文件、最终 SHA、测试证据、未完成事项；不提前勾选。
- [ ] 在授权范围内合入 release；正式发布另按本轮 weekly-release 流程处理。

## 14. 源码证据与设计来源

[R1]～[R8] 的含义见 [Spec 依据](spec.md#11-依据)；本 TechDoc 的 [R9]～[R11] 在下文单独定义。为便于复核，列出本次主要源文件的 blob：

| 源文件 | 基线 blob SHA | 主要定位 |
| --- | --- | --- |
| `src/renderer.js` | `660111a49cf97b224d8d0de37fd654d317f571c8` | 3556–3615，统一删除确认与部分失败 UI |
| `src/main-process/archive-center/controller.js` | `4793cceb5145ec3ecbf213d7193dabca077dd79b` | 1427–1475，删除入口与结果映射 |
| `src/main-process/archive-center/archive-service.js` | `628c9dcc390ff2d6aed157754a21fccdfd54f8a0` | 370–414、2650–2933，释放回调、物理清理与 retention |
| `src/backend/database/archive-repository.js` | `7159e63385c6da6ba2c42f475172ce8725853684` | 3990–4210、4200–尾，删除事务、jobs、统计 |

**[R9]** `archive-service.js` 414–455 行：受管路径/根身份检查；完整路径保护与 materializer 各分支仍须实施时按实际调用补回归。

**[R10]** 同一基线的 `storage-root-manager.js` 1131–1134 行：迁移返回时释放维护锁；1140–1155 行：`_assertSourceReady()` 拒绝尚有 cleanup job 的根；1791 行附近：旧根清理失败保留 `cleanup-pending`。`controller.js` 250–255、1433–1438 行：现有删除门禁只检查维护请求。`tests/unit/main-process/archive-storage-root-migration.test.js` 716 行附近和 1357–1407 行：切换前失败、切换后旧根副本未清理时仍能在当前根删除批次的基线场景。

**[R11]** 同一基线的 `controller.js` 519–563、771–795 行：file-batch owner 终态重放及 afterTerminal；282–295 行：剩余 outbox 阻止初始化。`archive-repository.js` 2680–2682 行与 `archive-service.js` 1423–1433 行：批次不存在时 finishFileTask 失败。`main.js` 18985–19024 行及 `task-lifecycle.js` 1619–1626 行：平盘取消先持久化终态通知再写 File Task 终态，不能据此推断通知已经 ACK。现有 Controller 测试 1296–1365 行的 legacy 删除通知用例不能代替新版 owner 分支验收。

**前序审查的基线验证：** 专项命令 `node --test --test-name-pattern='cleanup-pending 期间新根删除批次不会使旧根冻结清单漂移' tests/unit/main-process/archive-storage-root-migration.test.js` 为 1/1 PASS；它确认的是旧根残留及删除时序。内存 SQLite 探针使用真实 Repository、Controller/Service 重放方法及内存 outbox，确认删除成功且发行删除标记存在后，两次重放仍为 `flushed: 0, remaining: 1`；该临时探针不是已落入仓库的回归测试。这些是旧基线问题证据，均不代表本稿新增保护或最终功能已通过。

**本次修订验证与边界：** 仅修正文档并校验相互引用、目录和需求/设计/验收一致性；产品实现与 AT-01～24 仍待执行。每个模块外部源文件的完整血缘、所有源清理回调、旧临时目录 owner、全部外键/后台 worker 并发路径及 Windows/真实界面验收仍待核对。

## 14. 本轮实施约定与兼容边界（2026-09-11）

D-01 已确定 `managed-only`。实现复用 `archive_cleanup_jobs`，以 `plan_version=2` 的不可变目标、`progress_json` 逐项状态和 `archive_delete_receipts` 最小完成凭证收口。新计划的旧兼容路径数组为空，删除触发器要求先有完成凭证，阻止旧版本忽略新计划并丢弃任务。

受管目标包含存档根内的 materialized/Blob/有持久 owner 的 readonly，也包含由专门适配器核验的 Position 导入暂存。后者使用 `owned-temp`、`sourceArtifactId`、`managedRootIdentity` 和 `sourceOwnerProof`；相对路径只在该独立受管根解析。Repository 在元数据事务中重读 artifact 归属、输入方向、sourcePath、snapshot、SHA 和 size，要求计划与主进程核定目标完全一致。预检不写登记，不接收 renderer 的文件目标。重试沿用已保存的原根，重新检查活动保护和其他批次引用。

原 TaskLifecycle 的终态及 afterTerminal 实际完成后记录 `archive_owner_terminal_completions`。Controller 的主动删除和后台到期删除通过同一 owner/outbox 顺序保护；没有原 owner 收口证据的现代历史 FileTask 返回明确诊断。不能靠批次不存在、issuance.deleted_at 或空 outbox 生成后处理已完成的证明。

旧 v1 清理任务若只存路径、SHA 和大小，不能识别同字节新 inode。现存目标缺少历史对象身份时返回 `ARCHIVE_DELETE_LEGACY_IDENTITY_MISSING` 并保留原 job；只有目标安全缺失时可原范围升级。历史迁移交叠的自动收口验收使用具有完整身份的 v2 计划；旧 v1 缺证任务须证明“不丢 journal/job、不误删、不报完整成功”，不能声称全量旧任务均可自动完成。

文件执行在应用受管根串行队列内，核验原根、相对路径、父链、dev/ino、内容摘要和大小/时间戳，最后同步核验与 unlink。该实现不提供操作系统级按 inode 原子 unlink；Windows/外部写入者并发行为不能由 macOS 临时文件回归替代。

## 15. Review 修复的技术约束（2026-09-11）

本节落实 ARC-DEL-03～09 的既有安全边界，不改变 D-01 的 managed-only 范围。

1. **首次归属核验。** artifact 的 storageRelativePath 可能在实际输出生成前分配。计划不得把首次采集的当前文件身份当作原始所有权；现存 materialized 或 Blob 目标缺少持久原指纹/inode 时返回 `ARCHIVE_DELETE_OWNER_IDENTITY_MISSING`。历史 Blob 的 NULL 指纹不会因升级、同 SHA 去重复用或删除预检而被回填。缺失路径仍须验证存档根与父链；预检不写入、不删除。
2. **硬链接及共享引用。** 新计划额外冻结 nlink/birthtime/mode。执行器仅使用同计划、同根、同 inode、同摘要/大小/时间的链接组解释自身 unlink 引起的 ctime 变化，并核对缺失 sibling 与精确链接数差。新计划在只读预检和删除事务内均拒绝与未完成 job 共享同一硬链接 inode 的删除，先由原 job 重试收口，普通 copy 共享不受影响。共享 Blob 的目录目标未全部清理时不得提前标记 preserved-shared；全部完成后以持久 job 为依据，在同一事务中比较原指纹并更新仍引用该 inode 的 Blob/artifact 指纹。只接受原值或相同重放终值，冲突时整次指纹更新回滚。unlink 与进度落库之间、指纹更新与进度落库之间的中断都由原计划恢复；旧计划缺失 nlink/birthtime 时不从当前文件补造旧证据。
3. **终态责任。** eager/deferred 成功但 artifact 未 durable、终态写入失败及匿名回调失败的持久意图，统一保留 `_archiveAfterTerminalPending`。存在待完成匿名后处理且无路由时保留通知；有明确路由时由该路由完成。`recordFileTaskOwnerCompletion` 同时校验 batch 和 TaskRun 的 taskRunId/taskKey/moduleId/parentRunId/operationKey，以及 batchId/batchNumber/终态，避免另一 owner 的状态被认证。
4. **恢复凭证顺序。** 工具箱 publisher 的 `deferCommittedFinalization` 是内部恢复选项：后处理真实完成且 finalizing 索引已持久时返回 `commit-finalization-pending`，原 owner 保存 completion 后再完成恢复控制记录清理。正常 Main receipt ACK 与启动恢复共同使用此三阶段协议。已核实后处理只由 receipt 清理组成的入口按完整 moduleId/taskKey 登记在 `PUBLICATION_ONLY_FILE_TASKS`：Toolbox 的 merge/split export 两项、VCC 的 data-manager/result/import-audit export 三项、Pending 的 error-report/single-diff/aggregate-diff export 三项、Biz OP 的 date/date-range export 两项、Pre-fund 与 Acquiring currency 各一项，共 12 项。Main 只为 Toolbox/VCC 的精确入口直接注册匿名回调；其他只读导出继续遵循原 `prepared.afterTerminal` 注册条件，带有其他持久业务路由的任务仍由原路由收口。VCC 及已登记只读导出归档暂时失败时，原发布 receipt 保留后处理恢复责任；恢复完成并写入 exact owner 凭证后，原匿名 pending 通知才可 ACK。凭证写失败或最终清理失败都保留可重入入口。共享 publisher 的其他业务 owner 不由工具箱恢复流程推断其后处理已完成。Biz OP 月末复制仅在 target copy 持久且校验通过后保存 owner 事实，再删除原 intent；目标数据及原 Task/批次号不变。
5. **维护持有者。** entry maintenance 的 ownerToken 经 Controller → Service → owner guard → plan/提交前准入透传；Manager 仅允许 origin=retention、当前 token 精确匹配、requested 且非 active 的持有者继续。任何未收口 migration journal 仍阻止删除；渲染端不能提交该内部授权参数。

6. **正常读写与挂起硬链接计划协调。** 读取、目录副本修复、Blob invalidation、released Blob 清理和维护在修改现存 inode 或刷新原指纹前检查同实例、同根的未完成硬链接计划。必要脱钩被推迟时保留原 inode，读取可继续使用已经验证的 canonical 内容，维护保留明确待处理状态；原删除收口后再完成独立副本修复。正常脱钩前比较已有 Blob/artifact 指纹，unlink 后核验同 dev/ino、size、mtime、birthtime、mode 和精确 nlink 减一，再以事务 CAS 推进仍引用原 inode 的持久指纹。事务失败保留旧身份，维护只对同一持久 inode 重试；共享引用分页顺序可能使首轮保留 CAS pending，后续维护收口。维护不认领同 SHA 的替代 inode，不回填 NULL 指纹。旧计划的同组目录目标已经完成、原目录中不存在原 inode，而 Blob 路径已由当前有效引用持有且完整持久指纹证明是新 inode 时，可以保留新共享对象完成旧计划，不刷新新对象为旧计划的指纹。无法解释的 inode/链接变化仍拒绝。

回归使用临时 SQLite、真实目录文件和合成输入，覆盖未知同名文件、历史 NULL Blob 指纹、硬链接中断及正常读取/维护/重新发布、未完成匿名后处理、正常发布与启动恢复的凭证崩溃窗口、维护自持有及伪造令牌。具体命令、计数和平台边界以 [validation.md](validation.md) 的最终记录为准。

## 16. 第三轮 Review 修复约束（2026-09-12）

本轮落实 ARC-DEL-02、06、07、09，不扩展 managed-only 删除范围。

### 16.1 迁移发布路径与原对象身份

`targetPublishedPaths`、`sourceCleanupPaths` 只描述历史位置，不能单独授权删除同路径现在存在的对象。新 journal 在源清理和目标发布时保存原对象身份，切换前恢复及切换后清理均使用这些证据。任何关联删除任务的资格或待清理对象无法核验时，必须在两端清理之前保留文件、job 和 journal，返回明确失败；不能先删除文件再因缺原根或身份报错。

journal 保持 `schemaVersion=1`，增加可选的 `sourceFileIdentities`、`targetFileIdentities`，按原受管相对路径索引。源身份在首次 prepared 写入前采集；目标身份在实际发布完成后，与 `targetPublishedPaths` 和进度通过同一次原子 journal 写入保存。身份包含根与父目录链、dev/ino、SHA/size、mtime/ctime/birthtime、mode 和 nlink。恢复使用原记录逐项比较；只有冻结 inventory 内同 inode 的确切缺失 sibling 与链接数差可以解释自身 unlink 引起的变化。目标已为 0444 时不重复 chmod，避免无业务变化的 ctime 更新破坏后续恢复。

恢复不从当前 stat 或相同 SHA 补造历史对象身份。旧 pre-switch journal 连 sourceCleanupPaths 都缺失时，当前数据库路径仅作为待核验清单，不作为新增路径生成旧身份证据。旧 journal 的现存目标缺证时保留诊断；安全缺失仅在关联 V2 原计划、原根及任务资格同样可核验时幂等收口。V1 job 缺少原身份时，即使路径已缺失仍保留迁移诊断。文件发布成功但身份尚未持久就中断时，现存未登记目标保留并报冲突，不重新认领。可选字段允许当前版本读取旧 journal，但不表示旧二进制会采用新增的身份保护。完成凭证仍等待两端原对象清理及关联任务收口。

Manager 为创建的 Service 安装内部 `assertManagedObjectMutationAllowed`。读取、materialize、invalidation 和后台维护沿已有受管对象检查读取 durable journal；未 done 的迁移涉及原源路径时暂缓修改，包括重新创建已缺失的目录副本。正常读取仍可返回已验证的 canonical 内容并标记 repairPending，不脱钩历史硬链接或改变已冻结 inode；迁移结束后自动恢复正常修复。journal 损坏时保留错误，不跳过保护。

### 16.2 删除预检与弹窗生命周期

设置页新增 `deleteRequestId`，每次预检递增，关闭页面再次递增并设置 `destroyed`。预检成功、失败及异常回调都检查该请求仍为当前请求、设置页尚存活且原 overlay 仍连接；不同批次请求乱序返回只允许最近一次显示确认。

确认框回调同样检查自身仍拥有当前弹窗。取消时的微任务只在请求有效且 modalRoot 为空时恢复设置页，不覆盖随后打开的业务弹窗。提交删除后禁用重复确认和取消，并显示“删除中…”；实际失败时保留当前确认框和错误、恢复按钮。删除成功后的列表和统计刷新之间继续核验生命周期，页面关闭后的迟到结果不再修改反馈或重新打开页面。

## 17. 第四轮 Review 修复协议（2026-09-12）

本轮落实 ARC-DEL-03、04、06、09 的恢复与幂等要求，保持 managed-only 范围。

### 17.1 普通 File Task 的持久恢复责任

新增 additive/idempotent 的 `archive_file_task_owner_recovery` 元数据表。TaskLifecycle 对明确既无 afterTerminal callback、也无 afterTerminalIntent 的新 File Task 提交内部 `no-after-terminal` 恢复责任；Repository 在 reserveFileTaskBatch 的创建事务内，与原批次、冻结 manifest 和 issuance 一起保存实例与 exact owner。责任写入失败须回滚创建，不放行业务或 deferred promotion。重复使用已有批次不能借此补造旧责任，带路由或匿名 callback 的任务沿既有原 owner 协议恢复。

启动按既有顺序处理 owner、terminal outbox、受保护恢复任务和 interrupted sweep，再恢复本表可核验责任。恢复须重读同一实例、七字段 owner、Task／batch 关系与终态；pending/protected owner 继续保留。正常终态要求两端状态相同；运行中崩溃只接受现有 sweep 形成的 Task interrupted 与 batch failed 对应状态，由该持久责任生成 interrupted completion，不将任务改为成功或重新执行业务。completion 写入与责任删除在同一事务提交，失败保留责任供下次启动重试；正常生命周期 completion 同样原子清除自身责任。历史缺责任、身份不符和未完成匿名后处理不得借此放行删除。

`archive_owner_terminal_completions` 增加可选 `recovery_kind` 来源字段，旧凭证默认空。只有本轮责任生成的凭证标记 `no-after-terminal`；普通 completion 写入不获得该标记。已有原 owner 的恢复入口可以合法地将 interrupted Task 重新执行：`beginFileTaskRecovery` 在核验完整身份、manifest 和原中断状态后，必须在相同事务中撤销仅属于该新协议的 interrupted、无后处理凭证并重建原恢复责任，与 Task／batch 的重开一起提交。普通终态证明和旧缺来源凭证不能被重置；任一步失败整体回滚。

Acquiring 的恢复保护枚举使用共享 listSideDbFiles 的内部严格读取选项；目录确实不存在仍为空，其他目录读取错误必须传播，其他调用方保留默认枚举语义。已经发现的侧库无法打开或查询，或者恢复 JSON／已有 batch context 无法解析时，同样沿现有 Main／Controller fail-closed 路径阻止通用 sweep 或删除，不能把无法验证的恢复责任当成空清单。正式旧记录确实没有 batchContextVersion 和 batchContext 时继续按旧协议跳过，不猜归属。侧库恢复可读后继续由原 owner 恢复；不重新生成业务任务或改变业务结果。

### 17.2 原 unlink 证据与同 SHA 新对象

原硬链接组的 sibling 路径可能在旧 Blob unlink 后由新批次合法重新发布。当前路径存在新 inode 并不能否定原链接曾被该计划删除；执行器据同一 V2 cleanup job 的耐久 plan/progress 核验原 sibling 的 deleted 事实，禁止使用循环内尚未落库状态或 already-missing／preserved-shared 代替 unlink 证据。

只有原计划身份、原 sibling 目标、根及父链均匹配，且当前 sibling 是有效 Blob 引用持有、完整持久指纹匹配的不同 inode，才将原 unlink 计入缺失链接数。原待删目录文件继续要求同 dev/ino、内容、大小、mtime、birthtime、mode，并且实际 nlink 严格等于冻结 nlink 减去可解释的原链接数。原 inode 再出现在 sibling 路径、父链替换、引用缺失或进度不可信时继续保留诊断；新 Blob 及其新批次目录不得被旧计划删除或刷新为旧身份。

最终实现、反例回归与完整门禁证据见 [validation.md](validation.md)。

## 18. 第五轮 Review 修复协议（2026-09-12）

### 18.1 新 FilePlan 的来源摘要

冻结的 input item 可携带 expectedSha256 与 expectedSizeBytes。两字段必须成对提供，SHA 为规范小写 SHA-256，size 为非负安全整数并等于原 sourceSnapshot.sizeBytes；规范化及 Repository 均校验。来源摘要不参与 artifactKey 与 manifest identity 的既有计算，不改变历史 owner 或批次身份。首次 reserve 将其与 sourceSnapshot 一并持久保存为 artifact metadata，整个批次、issuance、编号与证据同事务提交；写失败全部回滚，不能产生仅有身份而丢失来源证据的已发号批次。重复 reserve 的 existing 分支只读取原登记，不补造或覆盖历史摘要。

Position 只透传业务 staging 已核验的摘要与大小。删除适配仍核验持久 sourceSnapshot/SHA/size、配置受管根、父链和其他 owner，不在预检中依据当前 stat 或 Blob 回填旧来源。原业务 pending 的持久证据继续供对应恢复入口使用。

### 18.2 BizOP v327 的原发布 owner 收口

匿名 afterTerminal 的 pending outbox 必须由 BizOP 原 owner 的耐久事实解决。正常导出后处理与启动恢复共用 publication 收口入口，在输出提交、读取保护和文件清理完成且 Task/batch 终态一致后，核验原 binding 的 exact owner、manifest 与实例，再写 Archive completion；完成凭证与业务恢复责任关闭的顺序必须保证任何写失败都可重入。

新 binding 持久记录 archive instance 与 manifest identity。旧 binding 仅在同一数据库中有完整原 publication、binding、output、manifest 和 owner 事实时由该业务 owner 核验；显式不匹配或畸形证据拒绝。旧代码已关闭业务恢复、但 Archive completion 仍缺失的原 EXPORT 也须可被重新枚举；已删除批次不重建。Controller 保持按 proof 的 exact owner、实例、终态和 afterTerminal 匹配后 ACK 通知，不能通过删除 pending 标记或泛化 ready 判断放行。

### 18.3 Position 共享来源与硬保护

其他批次已完成归档的来源引用，只有在其 ready artifact、有 Blob、无未完成恢复、原 Task/batch 终态和同实例 completion 一致，并且持久源 snapshot/SHA/size 与当前来源相同时，才归类为共享来源。活动任务、待确认 token、outbox、业务 pending、缺证或冲突引用仍是硬保护。provider 的旧数组返回继续按硬保护解释，新对象格式须提供可验证的 protectedPaths/sharedPaths 数组。

共享关系只决定保留源文件，不免除本批次原对象和父链核验；若源文件仍在但已被替换，仍拒绝删除。通过核验的共享来源不进入本批次物理删除计划，由最后一个合法持有者清理，来源已安全缺失也不会因历史 ready 引用形成互锁。已有持久清理计划在重试时出现新引用仍保留 job，不能绕过引用保护删除新任务正在使用的来源。

## 19. 第六轮 Review 修复协议（2026-09-12）

### 19.1 未提交导出的补偿完成凭证

`NOT_COMMITTED` 导出在首次失败终态落库失败时，仍保留原匿名后处理通知。BizOP 原 owner 必须根据原 publication binding、实例、完整 Task/batch/manifest 身份及持久 abort/补偿清理事实完成收口；不能将空 outbox、单独的 cleanup 标志、没有注册 Publisher 或当前失败状态当作完成证明。

完成凭证与原恢复责任关闭必须处于同一事务。凭证写入失败或随后的 phase/settlement 更新失败，都保留可重试的原责任。已经被旧代码关闭但仍缺 completion 的此类导出，须能重新枚举并按同样原始事实核验；已删除批次不重建。身份、路由、终态或补偿证据冲突时继续保留通知，不靠删除 `_archiveAfterTerminalPending` 或跳过启动门禁解除阻塞。

旧 publication binding 缺少新增的 Archive 实例和 manifest 字段时，仅在同一数据库内原 owner、issuance、manifest、abort/closure 和回收授权等完整证据一致后兼容；显式损坏或不同实例字段继续拒绝。Publisher 尚未注册的失败是原流程的另一分支：须有原 `publisherNeverRegistered` 事实、没有 dispatch 且补偿/输入责任已闭合，才沿原恢复流程关闭责任；已有 Lifecycle 凭证仍核验完整身份，缺凭证时不在此分支生成新证明，原普通终态通知继续由 Lifecycle/Controller 处理。

### 19.2 预先生成的 Position 异常报告

Position streaming 来源导入在预检期间生成的异常报告属于已登记的输出，不能套用暂存输入的方向及数字目录规则。仅精确来源入口和报告目录中的合法输出可采用报告归属协议；普通预分配输出、未知文件和外部用户文件不因此获得删除授权。

原报告对象快照及摘要应从业务生成/预检证据进入首次 FilePlan reserve 事务，在业务执行、attempt 写入或 settlement 前中断也不能丢失。可复用与原报告快照一致的冻结 targetSnapshot；不在删除时用当前 stat、相同内容或 Blob 重新认领旧文件。重复预留不回填历史缺证记录，现存替代 inode 或证据不一致仍拒绝。

FilePlan 使用用途限定的 `preGeneratedOutput` 证据，包含版本、报告类型、原 producerArtifactKey、原快照和摘要/大小。原 producer key 与派生的 Archive artifactKey 各有含义，不能互换；报告 jobId、固定文件名及 producer key 必须相互匹配。Repository 首次预留持久保存用途和 producer key、原摘要及冻结目标快照；新报告 V2 source proof 同时绑定原 operationKey 与两种 artifact key，元数据删除后的重试仍可核验原业务引用。旧 input 计划没有报告来源字段时继续按原协议处理。

活动过滤记录或历史对账结果仍引用报告时，必须保护该批次及报告。引用判断使用业务持久记录中的原 operation/artifact 身份；读取失败不能当作无引用。引用合法释放后，报告仍存在时按原对象证据删除，已由原 Main 清理时在受管根及父链可核验的条件下按安全缺失收口。持久删除计划重试也必须重新检查引用，不能仅在确认弹窗前检查一次。

仅存在报告候选时打开固定 Position side-DB 的只读连接，按主库保存的 checkpoint 验证原数据库。查询未解除的过滤记录与历史结果冻结引用，不按历史 run 状态过滤引用。有已登记报告时侧库缺失或不可验证不代表空引用；普通 input 及其他模块不会因报告检查额外打开 Position 数据库。

本轮不调整金额、币种、匹配、报告内容或业务数据删除语义；定向回归、跨进程复现及最终门禁结果见 [validation.md](validation.md)。

## 20. 第七轮 Review 修复协议（2026-09-15）

### 20.1 迁移提交使用原目标身份

目标 canonical 或目录化文件从首次发布开始绑定原对象身份，发布函数持有原 staging 或独占创建的目标文件句柄，并将核验后的原身份传给首次 journal 登记。内容相同、路径相同不能证明替代 inode 属于原迁移。目录化读取 canonical、最终目标校验和存档根切换前均须核对原身份；不得以首次登记或最终校验时的当前 stat 重新认领未知对象，再把该指纹赋给永久删除计划。

当前 materializer 生成独立 copy；历史目标 hardlink 的恢复转换可能由应用自身 unlink 导致 canonical 的 ctime/nlink 变化。仅在原路径组、原 inode 和持久迁移证据能够解释该变动时更新相应证据。根、父目录、内容及原对象归属继续核验，不能利用本次新发现的路径补造旧身份。

最终异步内容校验后、设置和指纹事务提交前再次同步核验原目标，避免在两阶段之间接受已改变的对象。校验失败不切换根、不登记替代指纹、不清理两根文件；原 journal 保留诊断并由既有恢复流程重入。此规则同时覆盖新迁移与可验证的历史恢复，不给缺证历史目标新增授权。

目标已缺失而需重建时，重新确认缺失并采用排他发布，不先删除路径或以 rename 覆盖现场文件。同卷使用本次已同步落盘的 staging inode 排他创建目标；文件系统不支持 hardlink 时通过 `wx` 独占创建目标句柄，并通过同一原句柄写入、同步、设置模式及取得身份。检查、复制或首次登记前出现的替代对象保留，迁移不切换设置。storage-materializer 的可选发布回调仅由迁移使用，默认调用维持既有发布行为。

### 20.2 历史导出凭证分批补齐

原先已 CLOSED/COMPLETE、仅缺新增 Archive completion 的历史导出，不等同于真正未完成的业务恢复任务。真实未决来源继续完整枚举并遵守原来源数量、字节、工作量和期限限制；不能把完整清单截断后宣称恢复完成，也不通过提高常量解决历史总量问题。仍有原 Archive pending 通知的已关闭导出继续作为真实待恢复 owner 处理，不能因归类历史记录而推迟原通知收口。

历史凭证补齐按有界批次处理，进度与单项诊断在原 SQLite 中持久保存。每项只通过既有原 owner 的完整身份、manifest、publication 或补偿事实核验生成 completion，不重新发布、重新归档、改变任务终态或删除历史记录。凭证、对应诊断及游标更新必须保持事务一致；写入失败不能提前推进进度，重启后能从原位置继续。无法验证的历史项留下诊断并可重试，不阻挡后续合法项；诊断或游标本身不是删除授权。

仅历史凭证待补齐或某一历史文件不可验证时，不将整个 BizOP 模块视为业务恢复未完成；该历史批次仍必须取得完整原 completion 才可删除。Archive 尚未装配的启动阶段不执行凭证补齐；保存进度须绑定原 Archive 实例，不能跨实例复用。最终实现和验证计数见 [validation.md](validation.md)。

每次恢复检查最多补齐 64 条历史记录。状态接口独立返回 `archiveOwnerBackfillPending`，界面在业务已恢复且仍有历史待检查时保留“继续检查存档”入口，并提示可继续操作业务或再次检查。点击后重新读取状态，仍有未通过核验的记录就继续提示；全部完成后隐藏入口。真正的未决业务仍显示“重试恢复”并禁用业务操作，模块未激活或检查执行中不能重复发起。历史补齐不依赖用户反复重启应用。

## 21. 第八轮 Review 修复协议（2026-09-15）

只读副本的创建归属来自本次 `wx` 创建的原文件句柄。首次 creating 登记前同步核对句柄、临时路径及根／父目录；写入流保持句柄打开，写入结束与 rename 返回后再次核验。权限调整作用于原句柄，不能通过当前路径修改替代文件。

最终摘要校验后，同步复核原句柄、当前文件、原根／父链与已校验的完整身份，再登记 ready；这段核验及登记不让出事件循环。文件内容相同或同一路径不构成归属，保留原文件 inode 的父目录替换也不能通过。句柄在调用 opener 前关闭，所有失败路径通过 finally 关闭，持久 owner 和现场文件保留供诊断；原创建身份无法解释现场对象时，后续批次删除继续拒绝。

本协议仅修复只读副本首次归属登记的身份连续性，不改变现有数据库结构、业务 owner、删除范围或文件发布接口。回归和完整门禁结果见 [validation.md](validation.md)。
