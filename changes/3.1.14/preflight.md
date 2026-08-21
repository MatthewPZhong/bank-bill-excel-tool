# v3.1.14 Unknowns Preflight

## Task Brief

- Goal：修复 VCC 财务 OP 明细导入在读取 38,197 行后因 staging 自引用外键清理退化而长时间无响应的问题，并展示真实数据库收尾阶段。
- Context：充值清退与 Pending 合计 67,356 行；现有 `comparison_import_row_id` 自关联列缺少子列索引，renderer 只展示最后一条读取进度。
- Constraints：不改变金额、币种、方向、业务键、幂等、异常、revision、取消和 worker 终止合同；不升级 storage contract v2；不修改下载底稿；禁止为正式路径不可达状态增加防御。
- Done when：新库/旧 v2 库幂等具备 partial index；清理计划不再二次扫描 staging；每个完成读取的明细 sourceType 上报一次 `committing`；取消提示不被晚到 progress 覆盖；真实样本首轮与重导守恒。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| staging 存在 `comparison_import_row_id → staging.id ON DELETE SET NULL` | `src/backend/vcc-financial-op-db/storage-contract.js` | 必须保留外键并索引子列，不能关闭外键规避 |
| 清理按 `import_record_id` 整批 DELETE | `repository.clearImportStagingRows()` | 只改变访问路径，不重写清理算法 |
| 读取每 50,000 行 checkpoint，最终读取提交后才分类 | `STAGING_COMMIT_INTERVAL`、`commitStagingProgress()`、`importDetailGroup()` | progress 时点必须落在最终 COMMIT 与分类调用之间 |
| 每个文件解析后执行 SHA 二次核对 | `assertSourceFileMatchesSync(file)` | SHA 失败、空表、取消不得发送 `committing` |
| progress 已由 worker/service/preload 透明转发 | 现有 import progress 调用链与单测 | 不新增 IPC 或中间层字段复制 |
| renderer 取消中先写固定提示，但现有 listener 可覆盖 | `handleCancelImport()`、`handleImport()` | formatter 必须以 `cancelRequested` 为最高优先级 |
| `batchId` 由 `batchContext.taskRunId` 归一化得到 | `vcc-financial-op-service.js` | 发布证据使用同一任务身份，不制造第二个 ID |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 打包 SQLite 是否使用 partial index 执行自引用外键子行查询 | 已知未知 | 高 | 容易 | 缺索引计划存在第二次 staging 扫描 | PROBE | `EXPLAIN QUERY PLAN DELETE ...` | 以执行计划单测为发布门禁 |
| 多明细组 progress 的数量与顺序 | 契约盲区 | 中 | 容易 | import service 按 sourceType 逐组调用 | PROBE | 同批两种明细捕获事件并分组 | 每个完成读取组恰好一次 |
| 分类事务失败前是否已经上报 `committing` | 失败边界 | 中 | 容易 | 事件位于最终读取 COMMIT 后 | PROBE | 归档数据集拒绝新增用例 | 允许已有 `committing` |
| 绝对耗时是否可作为 CI 门槛 | 环境差异 | 低 | 容易 | 磁盘、机器和 SQLite 版本影响明显 | ASSUME | 真实样本记录事件时间点与总耗时 | CI 不设置固定秒数 |

无 BLOCK 项。所有会改变方案的未知均可从仓库或最小本地实验确认。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 增加并验证 partial index | 外键完整性、旧库幂等升级、线性访问路径 | schema SQL、重复 ensure、执行计划、真实自引用清理 | 推翻 P0 方案 | 撤回索引并重新评估，不改 DELETE |
| 2 | 在最终读取 COMMIT 后发送 progress | SHA、取消、空表与事务时点 | 多组/失败/取消/空表测试 | 调整事件落点，不改数据事务 |
| 3 | renderer 纯函数与最小接线 | 取消文案优先、旧事件兼容 | 纯函数执行测试和 listener 接线断言 | 收缩为 formatter 局部改动 |
| 4 | 真实样本首轮和重导 | 行数、幂等、revision、主体×币种金额守恒 | 本地 DB 回读和人工核对 | 阻止发布，不引入补偿逻辑 |
