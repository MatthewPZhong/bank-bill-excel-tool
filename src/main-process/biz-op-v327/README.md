# BizOP catalog 查询与命令边界

本页说明已经落地的 G5 查询入口。设计合同见 [G5 Spec](../../../changes/v3.2.10/codex/v3.2.10-bizop-query-boundaries/spec.md)，切片状态、命令与证据见[实施记录](../../../changes/v3.2.10/codex/v3.2.10-bizop-query-boundaries/implementation-notes.md)。本页不改变存储、回收、升级或恢复合同；存储约束继续以 [run-scoped-data-policy](../../../rules/run-scoped-data-policy.md) 为准。

## 已落地入口与所有权

`createBizOpCatalog(db, ...)` 在原连接上建立并公开冻结的 `catalog.queries`。实现位于 [catalog-queries.js](catalog-queries.js)，每次同步读取，不缓存、不写库、不打开连接、不开始事务、不申请准入、不读文件，也不返回 DB、statement 或 transaction 句柄。

| 调用方 | 查询入口 | 仍由调用方负责 |
| --- | --- | --- |
| [compute-inputs.js](compute-inputs.js) `collectInputs` | `readActiveDataset`、`iterateDatasetSources` | missing 完整清单、4096 元数据预算、ready/hash/hold、行数与 manifest 校验、BU/digest 排序、fingerprint、generation 和快照 |
| [export-inputs.js](export-inputs.js) `freezeExportSource` | `readExportObject` | schema/引用参数验证、RESULT manifest 与历史规则、RAW 文件与 hold/hash 检查、65536 字节快照 |
| [delete-preview.js](delete-preview.js) `collect` | `readActiveDatasetForDelete`、`iterateDatasetSources`、`iteratePublishedRunIdsUsingDataset`、`readPublishedRunForDelete`、`iterateRunArtifacts` | selection/闭包、顺序、charge 与字节预算、用户锁及 hold 保护、digest；只使用原预览字段 |
| [import-main.js](import-main.js) `restoreDiagnostic` / `runImport` | `readDispatchesForPlan`、`readDiagnosticByRef` | 唯一 producer、owner/digest、关闭证明、真实样本校验、注册诊断与原维护动作回收 |

归档 Blob 引用由 [ArchiveRepository.hasOtherArtifactForBlob](../../backend/database/archive-repository.js) 解释归档表。它用 `LIMIT 1` 排除当前 artifact，计入其他任意状态、任意 owner 的引用。调用方只在 `blobId` 存在时调用；结果不赋予删除资格。不得以全量 `listArtifactsByBlob` 或 hash 引用计数替代该语义。

三个 `iterate*` 返回同步 iterator，必须在既有 admission 回调中同步消费，不跨 `await`、事务或 Renderer 边界。使用 `for...of` 提前退出或显式 `return()` 释放底层 statement；不得先收集全量再检查预算。`readDispatchesForPlan` 沿用原数组语义。

计算的 `admission.exclusive`、导出的整个 `admission.readTask`、预览的同步 `admission.read` 及 import 原 exclusive/关闭链保持不变。查询成功不代表文件验证、删除资格或任务准入已通过。

## catalog.db 的合法保留者

G5 只迁移上表中的读取作用域。`catalog.db` 保留给以下既有本域实现；这不是新增跨域公共 API。未来迁移须整体移动其合同与测试后才能移除对应能力，不以禁止全部 SQL 的方式破坏命令或恢复。

| 文件 / 作用域 | 合法责任与保留原因 |
| --- | --- |
| [catalog.js](catalog.js) | schema 初始化、control/operation/task/receipt、导入/计算/删除提交、版本、hold 与回收命令；原事务层级及附属读取保留 |
| [catalog-queries.js](catalog-queries.js) | 本页规定的只读投影，原 catalog 连接由构造器注入 |
| [delete-preview.js](delete-preview.js) `get/create/bind` | 自有 `biz_op_v327_delete_previews` 的五处 SQL：读取、过期删除、未确认计数、插入、绑定更新；`validate` 经 get 与 collect 重新核验，`bind` 必须 exclusive |
| [compute-main.js](compute-main.js) `runCompute` | 按 inputFingerprint 查询已发布运行，保持重复请求处理；不在 collectInputs 迁移范围 |
| [metadata.js](metadata.js) | 当前输入、月份、日历与分页清单，属于未迁移的同域查询 |
| [ipc.js](ipc.js) 导出预检 | 导出命名所需元数据预检；实际冻结仍进入 export query |
| [auto-error-report.js](auto-error-report.js) | 独立诊断及 producer 读取，原自动报告编排保留 |
| [read-protection.js](read-protection.js) | dispatch、read pin、关闭证据、诊断登记/退役及附属读取 |
| [delete-preservation.js](delete-preservation.js) | KEEP_RESULTS 在删除/恢复期间核验历史结果、收据、预览绑定及原件保留 |
| [reclaim.js](reclaim.js) | 回收授权、pin/对象状态核验、队列命令及删除事实；未改变回收资格 |
| [export-publication.js](export-publication.js) | publication intent、提交/关闭事实、结算与 ACK 持久状态 |
| [recovery-driver.js](recovery-driver.js) | 原启动/任务恢复编排与 control 的读取、更新 |
| [recovery-sources.js](recovery-sources.js) | 原恢复 discovery、followup、finalization、结算事实 |
| [recovery-plan.js](recovery-plan.js) | task、batch、overlay 与终结事实的恢复决策输入 |
| [recovery-alignment.js](recovery-alignment.js) | task/batch/outbox 的恢复一致性检查 |
| [archive-owner-completion.js](archive-owner-completion.js) | 归档 owner 完成证明、同连接校验与补偿收口 |
| [archive-owner-backfill.js](archive-owner-backfill.js) | 历史归档 owner 的分页补录、游标与失败记录 |
| [upgrade-main.js](upgrade-main.js) | 原升级/激活命令、状态和恢复事实 |
| [module.js](module.js) | 接收并装配原连接；`protectedTasks` 清点升级前后需要保护的任务与批次 |

`candidate-router`、`compute-pipeline`、`result-sink`、`worker-entry`、`export-source`、`export-spool`、`import-adapter`、`upgrade-legacy` 的本地 SQLite 操作属于候选/工作/封存 part/导出 spool/旧库职责，不是上表的 catalog 事实读取。逐 SQL 位置及具名函数见[扫描证据](../../../changes/v3.2.10/codex/v3.2.10-bizop-query-boundaries/evidence/query-boundary-inventory.json)，该证据是当前快照，不是长期规则正文。

## 边界检查与兼容

- compute-inputs、export-inputs、import-main 的事实读取与 delete `collect` 禁止重新取得 raw DB 或在消费者拼 SQL；只能消费上述 query / Archive 方法。
- delete `get/create/bind` 的五处预览 SQL 是现行命令职责，不是待清零的历史例外。
- 未更改 IPC、schema、持久化版本、状态/删除模式、输出字段、准入和资源预算。ArchiveRepository 仅增加窄方法，构造与装配未改；G2 合并时保留其成果并按方法合并。
- G8 检查器及机器配置尚未集成。本分支 AST 清点和动态测试不代表 `ARCH-BIZOP-QUERY` 已 active。G8 集成者须分别登记 Q1 Archive、Q2 compute/export、Q3 collect/import，使用真实消费者和测试入口，并允许上面的五处合法命令；静态别名/闭包正反例由 G8 实施。

## 代表性验证入口

- [query 真库单测](../../../tests/unit/main-process/biz-op-v327-catalog-queries.test.js)：状态、投影、顺序、错误、readonly 与迭代器关闭。
- [归档引用单测](../../../tests/unit/backend/archive-blob-reference-query.test.js)：任意状态/owner、自身排除、20,000 引用及 LIMIT 1。
- [导入诊断负向测试](../../../tests/unit/main-process/biz-op-v327-import-query.test.js)：producer/digest/关闭顺序、query 后样本损坏、raw DB 拒绝。
- [完整基线等价集成](../../../scripts/integration/biz-op-query-boundary.js)：真实临时库、worker 和文件，比较完整快照/错误与预算边界。
- compute-main、export-main、export-rule-version、delete-main、import-main、phase-admission 既有单测继续覆盖原安全合同；实际结果、环境与未执行项以实施记录为准。
