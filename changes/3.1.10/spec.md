# v3.1.10 Spec — VCC 财务 OP 存储、原表血缘与异常审计瘦身

> status: apply
> owner: VCC 财务 OP / 存档中心
> created: 2026-08-16
> updated: 2026-08-17
> baseline: `v3.1.9` + release-evidence `646bcf4ec5cd269ed51389f5c1f1d6d13d79e1ba`
> nature: 前向数据合同。本文取代 v3.1.6 的永久逐行导入审计和 v3.1.8 的大表 `raw_json` 保留规则，但不追溯修改已发布文档、tag 或历史二进制。

## 1. 背景与目标

当前 VCC 财务 OP 将有效事实的计算字段与完整原始行重复保存在 SQLite，同时永久保存幂等跳过、回滚和异常逐行审计。代表真实库中 `vcc_fin_op_effective_rows` 约 11.14GB、`vcc_fin_op_import_rows` 约 16.28GB，VCC 核心表合计约 27.42GB；输入工作簿已经由存档中心以 SHA-256 Blob 保存，继续在 SQLite 重复保存完整原表不是唯一可信来源。

本迭代必须同时完成：

1. `vcc_fin_op_effective_rows` 只保留计算、校验、幂等与最小来源定位所需字段；
2. 原始输入以存档中心 artifact 为唯一长期原件，业务引用由不可绕过的 hold 保护；
3. 用户可见导入审计只保存真正异常，不保存纯幂等跳过和正常回滚行；
4. “校验原表”按当前有效事实从已校验 artifact 或临时 fallback 重建；
5. 通过显式维护模式 copy-on-write 重建，使现有 `tool-data.sqlite` 物理缩小；
6. 保持 CNY 九币种、金额公式、幂等键、计算结果、归档/解归档、人工调整和业务状态语义不变。

代表真实库目标：VCC 核心表约 4.3–4.6GB，至少下降 75%。存档中心约 1.57GB 文件不计入 SQLite 体积。

## 2. 明确非目标

- 不把原始工作簿直接作为“校验原表”下载；导出内容仍是当前有效数据集。
- 不为未能严格证明血缘的历史行伪造 artifact 绑定或永久 fallback。
- 不改变 CNY 九币种、金额/余额公式、幂等键生成、内容哈希业务语义或 VCC 结果模板。
- 不删除 `vcc_fin_op_system_snapshot_attempts`；该表继续是小型、受保护、非用户可见的删除审计证据。
- 不允许旧版程序继续打开已完成 v3.1.10 数据升级的新库。
- 不对用户生产库进行隐式启动迁移；维护模式必须由用户显式触发。

## 3. 数据合同

### 3.1 `vcc_fin_op_effective_rows`

物理重建后固定保留：

- 身份与幂等：`id/source_type/idempotency_key/content_hash/hash_version/raw_contract_version/legacy_content_hash`；
- 业务坐标：`target_month/subject`；
- 计算字段：`stat_currency/signed_amount/business_department/counterparty_department/business_sub_type/channel_name/mid/recon_type/pending_currency/pending_amount/flow_currency/flow_amount/currency_mismatch`；
- 最小血缘：`import_record_id/import_source_id/sheet_name/source_row/first_imported_at`。

移除 `raw_json`、`idempotency_key_raw`、重复 `source_file` 及不属于上述集合的 legacy 大字段。`UNIQUE(source_type,idempotency_key)` 和现有业务 ID 必须保持。

### 3.2 `vcc_fin_op_import_sources`

每个导入记录的每个物理输入一行，至少保存：

- `id/import_record_id/source_ordinal/source_file_name`；
- 首次读取时计算的 `source_sha256/source_size_bytes`；
- 可空 `archive_artifact_id`；
- `archive_state`：`pending/ready/failed/unavailable`；
- 最近错误与绑定时间。

唯一约束为 `(import_record_id,source_ordinal)`；artifact 绑定必须同时满足 SHA-256 与大小精确一致。仅由 flow identity、import record、artifact 和 SHA 唯一证明的历史来源可绑定；文件名相同不是证据。

业务开始前，TaskLifecycle 必须把本次全部输入的 `taskRunId/source_type/source_ordinal/resolved_path/source_sha256/source_size_bytes` 作为不可变 handoff descriptor 持久化到原批次的 Archive intent/outbox。descriptor 未持久化时不得启动导入 worker；worker 首次读取并计算 SHA/size 后、创建 import batch 或执行任何业务 DML 前，必须逐项精确比对路径、类型、顺序、SHA、大小和 taskRunId。任一不一致整次 fail-closed，且业务表零写入。

### 3.3 `vcc_fin_op_import_staging_rows`

导入事务内部使用的完整行暂存表。字段可覆盖旧 `vcc_fin_op_import_rows` 的分类需要，但终态后对应记录必须清空；应用异常恢复也必须清空。不得成为用户可见永久审计表。

### 3.4 `vcc_fin_op_import_anomalies`

只保存真正异常：

- `invalid_key`
- `format_error`
- `idempotent_conflict`
- 系统主体/九币种快照异常
- 文件级失败事件

行级记录保存规范化幂等键、来源、sheet/行号、异常字段、说明、必要的 incoming/existing 内容哈希和差异字段；禁止保存完整 `raw_json`。`idempotent_skip` 仅累计到 import record，不留逐行记录。`rolled_back` 正常行只保留数量和一条文件级失败事件。

### 3.5 `vcc_fin_op_effective_raw_fallback`

仅保存 v3.1.10 程序新导入中“业务已成功、输入文件尚未成功归档”的临时完整原始值；包括程序升级后、用户尚未执行物理重建的 v1 过渡期导入。以 effective row 为唯一键，并关联 import source。artifact 经 SHA/大小验证绑定成功后，在同一业务事务中创建 hold 并删除对应 fallback。升级前历史未覆盖行不补 fallback。

### 3.6 `archive_artifact_holds`

存档 artifact 的业务引用锁，至少包含 `artifact_id/owner_module/owner_type/owner_id/reason/created_at`，同一 owner 唯一。当前有效 VCC 行通过其 import source 持有输入 artifact；任何 hold 存在时：

- artifact 显示禁用的 `🔒`；
- 用户锁定/解锁不得覆盖业务锁；
- 手工删除、批次删除和 retention cleanup 均必须阻断；
- 删除对应有效原表后，在确认无其他有效引用后自动释放。

### 3.7 Import record DTO

导入记录 DTO 新增：

- `anomalyCount`
- `archiveState`

保留六类计数：`raw/inserted/skipped/invalidKey/conflict/formatError/rolledBack` 的既有业务解释和守恒关系。纯幂等跳过不计 anomaly。

## 4. 导入状态机

```text
读取文件并计算 SHA/size
  -> 创建 import source
  -> staging 分类
  -> 正常行写 slim effective + fallback
  -> 异常行写 compact anomaly
  -> 更新 record 六类计数
  -> 清空 staging
  -> 业务终态
  -> 存档中心绑定 artifact
       -> SHA/size 一致：source=ready + hold + 清 fallback
       -> 失败：source=failed/pending + 保留 fallback
```

约束：

1. 纯成功、成功含异常、全幂等、冲突、格式错误、取消和崩溃恢复均必须清空 staging。
2. hard failure 回滚有效事实；正常 rolled-back 行不逐行审计，只更新数量并记录一个文件级 failure anomaly。
3. 存档失败不得回滚已成功业务数据；UI 显示“输入文件待存档”，沿用存档中心 `↻` 重试。
4. 重选文件必须 SHA-256 与大小一致；成功绑定后自动清 fallback。
5. 已 ready 的 artifact 只有在本次 expected SHA/size 与既有 artifact/blob 精确一致时才可复用；冲突必须明确失败，不得返回 `alreadyArchived`，也不得覆盖既有 Blob。
6. 业务终态已提交但首次 artifact settle 前崩溃时，启动恢复必须用 durable handoff 在原 task batch 上重放输入与终态，并按原 source identity 绑定；不得新建 source、猜 latest 或永久遗留 pending fallback。

## 5. 用户界面与导出

### 5.1 异常明细

删除“查看导入明细”及其分页接口。新增【导出明细】，生成 `.xlsx`，固定六列表头：

`幂等键 / 文件名 / 原表行号 / 分类 / 异常字段 / 说明`

显示规则：

- 存在真正异常或文件级失败时显示；`success_with_skips` 可显示；
- 纯成功、纯幂等跳过不显示；
- 失败且未处理的记录另保留【标记已处理】。

### 5.2 “校验原表”预览与导出

预览 DTO 固定返回：

- `totalRows`
- `exportableRows`
- `missingRows`
- `incomplete`

导出按 artifact 分组流式读取工作簿，用 `sheet_name/source_row/idempotency_key/content_hash` 精确筛选当前有效行；不得直接复制原工作簿。尚未归档的新导入可用 fallback。历史未绑定来源计入 missing。

部分导出合同：

1. 先展示总行数、可导出数、缺失数并二次确认；
2. 输出文件名包含“ 不完整”；
3. 首个 sheet 为“导出说明”，记录覆盖率和按 import record 汇总的缺失数；
4. 零覆盖时仍只允许生成说明 sheet，不伪造数据；
5. 已绑定 artifact 损坏、SHA 不符、定位行幂等键或内容哈希不符均是完整性故障，整次失败，不得降级成部分导出；该规则同样适用于 SYSTEM_OP 和仍含 `raw_json` 的 v1 过渡行。只有从未存在 import source 的历史 v1 行可走独立 raw fallback 合同。

## 6. 历史迁移

### 6.1 显式维护模式

迁移必须：

1. 以 owner/token lease 拒绝新业务任务、第二次迁移、存档删除/重试；updater、退出和迁移只能释放自己持有的 lease；
2. 等待所有活动 TaskLifecycle、VCC worker 和数据库任务自然终态；
3. 执行 `PRAGMA wal_checkpoint(TRUNCATE)`，要求成功且无 busy frame；
4. 对源库执行 `integrity_check`、`foreign_key_check`；
5. 预估源数据库、目标紧凑库、journal/临时文件所需空间；空间不足不开始。

程序升级后、用户执行显式维护迁移前允许继续使用 v1 物理库：旧 `effective_rows.raw_json` 暂时保留；所有新导入仍按 v3.1.10 合同写 import source、compact anomaly、staging 与 fallback。历史终态记录没有可证明 source 时标记 `unavailable`，不得把新增列默认值 `pending` 当成“输入文件待存档”。若从 v3.1.9 崩溃现场直接升级，恢复必须同时接管旧 `vcc_fin_op_import_rows` 与新 staging：未分类正常行计入 rolled back、可证明异常转 compact anomaly、重算六类计数并清理旧宽行。该过渡期不会自动缩小数据库，物理瘦身仍只由用户触发。

### 6.2 Copy-on-write 重建

迁移在同目录创建新数据库：

- 复制全部非 VCC schema/data；
- 以 v3.1.10 schema 创建 VCC 表；
- 保留所有业务 ID、run/result/adjustment/archive/operation audit；
- 把旧 effective 行转换为 slim effective；
- 把严格可证明的历史来源绑定至 import source/artifact/hold；
- 把严格异常转换为 compact anomaly；
- 原样保留过渡期已存在的 import source/anomaly/fallback；若 ready artifact 的 SHA/size 已验证，则重建时创建 hold 并删除对应 fallback；
- 不复制旧永久 `idempotent_skip`/正常 `rolled_back` 逐行审计；
- 不为未覆盖历史创建 fallback。

### 6.3 切换前守恒

新库必须全部满足：

- `integrity_check=ok`、`foreign_key_check` 空；
- 每个 import record 六类计数不变；
- effective 的主键集合、`source_type+idempotency_key+content_hash` 集合不变；
- 各月×来源行数不变；
- 所有 run 结果、调整、归档、九币种余额与计算摘要不变；
- artifact 绑定、SHA/size 和 business hold 一致；
- staging 为空；升级前历史不新增 fallback；升级后过渡期已有 fallback 必须守恒，只有对应 ready artifact 的 SHA/size 已验证时才可删除并建立 hold。

### 6.4 Journal 与原子切换

迁移 journal 覆盖 `prepared/copying/verifying/switching/switched/reopen-verified/done`。worker 完成候选复制与完整复验后进入 `ready`，但必须继续持有源库 `BEGIN IMMEDIATE`；coordinator 关闭所有主库连接并保持 mutation lease 后才发送 ack，worker 收到 ack 才释放源锁并允许切换。切换采用同目录原子 rename：保留源库作为带 migration id 的旧文件，激活新库，重新打开并执行首次只读校验；只有用户在维护确认框中明确选择“校验成功后删除旧数据库”时，才自动删除旧数据库及其 sidecar，否则保留带 migration id 的备份。删除旧库与 sidecar 后必须先 fsync 数据库目录，再推进 journal；删除 journal 后也必须 fsync journal 目录。任一切换前失败保持旧库不变；崩溃恢复以 journal、活动文件身份和 schema marker 唯一判定，不猜测。

## 7. 兼容与安全

- schema 设置持久 `vcc_storage_contract_version=2`；v3.1.10 启动必须拒绝比自身更新的合同。contract-v2 的每张 `vcc_fin_op_*` 表必须以数据库 trigger 要求 v3.1.10 连接显式注册的 write capability；已发布 v3.1.9 即使能打开数据库，也不得执行任何 VCC INSERT/UPDATE/DELETE。marker 与 guards 必须在同一原子边界安装。
- 启动顺序固定为 Archive outbox replay → 模块 owner 恢复 → post-owner replay → VCC source/hold reconcile → interrupted sweep/retention cleanup；reconcile 失败时跳过 sweep/retention 并 fail-closed。
- 不从 fallback 或导出结果反向生成新的 canonical Blob/hash。
- 不接受文件名、路径或 mtime 作为 SHA 的替代证据。
- 所有相对路径必须经存档中心 root containment；renderer 不得传任意物理路径。
- 迁移只在临时测试库和用户显式维护模式写库，常规启动不得隐式压缩。

## 8. 验收与人工红线

自动化必须覆盖导入、存档绑定、hold、异常导出、完整/部分原表导出、迁移故障注入、计算/归档/解归档/删除/调整与 Excel 回读回归。

真实库门禁：迁移前后逐表 `dbstat`；VCC 核心目标约 4.3–4.6GB且下降至少75%；整库和外部存档分别报告。

⚠️ 资金红线人工复核：按主体×`AUD/CAD/CNY/EUR/GBP/HKD/JPY/SGD/USD` 抽查有效行、金额、幂等冲突、部分导出缺口、删除审计和 archive SHA 血缘。该人工项未通过前不得正式发布。
