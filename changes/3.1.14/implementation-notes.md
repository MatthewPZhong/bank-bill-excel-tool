# v3.1.14 Implementation Notes

## Baseline

- Goal/spec：`changes/3.1.14/spec.md`
- Initial plan：以索引修复数据库收尾退化，并用 reading/committing 两阶段提供真实反馈。
- Done when：正式文档、代码、测试、版本资料一致；自动门禁通过；真实样本首轮与重导证据可回读。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| storage contract 保持 v2，仅幂等创建 partial index | 索引只改变访问路径，不改变表、数据编码或写能力 | 新 migration marker、contract v3 | 旧库启动/worker ensure 自动受益；旧代码可继续使用 |
| `committing` 位于最终读取 COMMIT 与 `classifyAndPromote()` 调用之间 | 该时点已完成逐文件 SHA、取消/空表检查和读取持久化，且数据库收尾尚未开始 | 分类完成后上报、更多阶段状态机 | 分类事务失败时仍可能已经出现该事件，符合“正在校验并写入”语义 |
| renderer 采用 `buildImportProgressStatus(progress, cancelRequested)` | 可执行单测覆盖取消、reading、committing 和旧无 phase 事件 | listener 内分散写状态、消息序号/队列 | 取消中返回 null，晚到进度不能覆盖取消提示 |
| benchmark 不设固定耗时阈值 | 绝对耗时依赖机器、磁盘和 SQLite；执行计划能稳定防止索引回归 | CI 秒级 SLA | 组合样本记录总耗时和事件时间点；数据库阶段仅在单一 sourceType 下测量 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 同名错误索引不会由正式版本产生 | 索引名首次引入且 schema 由应用控制 | 手工破坏库不会自动修复 | 不增加修复器；人工恢复 schema 后重跑 ensure |
| 当前正式写入只产生同 record 的 staging 自引用 | `updateConflictComparisons()` 仅按 record 查 peer | 跨 record 手工数据需独立处置 | 测试真实同 record 形态；不增加不可达防御 |

## Deviations

无行为性偏差。正式 Spec/TechDoc 已将 review 后的 phase 时点、逐文件 SHA、统一任务身份和 renderer 可执行测试写入合同。

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `node --test tests/unit/backend/vcc-financial-op/storage-contract.test.js` | 13/13 PASS | fresh/旧 v2/幂等安装、partial predicate、执行计划、自引用清理与 FK 完整性 |
| `node --test tests/unit/backend/vcc-financial-op/detail-importer.test.js` | 39/39 PASS | 两明细组事件集合/顺序/rawCount、分类拒绝、读取失败、取消、空表 |
| `node --test tests/unit/renderer-vcc-financial-op.test.js` | 28/28 PASS | formatter 取消优先、reading/committing/旧事件兼容、listener 接线 |
| `node --test tests/unit/vcc-financial-op-release-docs.test.js` | 13/13 PASS | 版本/基线/phase/事务/取消/回滚/样本身份跨文档一致性 |
| `npm run lint` | PASS | 三个生产文件符合现有 ESLint 规则 |
| `git diff --check` | PASS | 本次 diff 无空白错误 |
| `npm run release-check` | PASS | smoke PASS；unit 5,601 PASS / 1 intentional skip / 0 fail；integration 48/48、2,410/2,410 PASS；integration runner 自动刷新的耗时清单已恢复基线，不纳入 PR |
| `npm run scan:vars` | PASS | v3.1.14；340 个 tracked JS、4,515 个 top-level names；stats Markdown/JSON 已刷新 |

### 真实样本本地回放（项目负责人，PROBE 已关闭）

- 环境：本地临时 contract-v2 数据库，Node 内置 SQLite 3.50.4；三份样本按 `sourceType` 串行处理。
- 计时口径：组合样本只记录整批总耗时与 `committing` 事件时间点；未将最后一个 `committing` 到批次返回的区间表述为全部数据库阶段。

| 轮次 | 任务身份 | 整批总耗时 | `committing` 事件 |
| --- | --- | ---: | --- |
| 首轮 | `taskRunId === batchId === v314-real-first` | 9.033s | `recharge_refund` 38,197 行 @ 4.640s；`pending_archive_removal` 29,159 行 @ 8.358s |
| 重导 | `taskRunId === batchId === v314-real-reimport` | 7.742s | `recharge_refund` 38,197 行 @ 3.870s；`pending_archive_removal` 29,159 行 @ 7.264s |

- 首轮：充值清退 `raw/inserted=38,197/38,197`，Pending `29,159/29,159`，系统 OP `1/1`；有效明细 67,356 行，staging、anomaly、`foreign_key_check` 均为 0。系统 OP 为 PPHK 单一快照，九币种完整。
- 重导：两类明细 `inserted=0`，分别 `skipped=38,197`、`29,159`；系统 OP `inserted=0, skipped=1`。有效明细、revision 与金额保持不变，staging、anomaly、外键异常仍均为 0。
- `pending_archive_removal`、`recharge_refund`、`system_op` 三组 dataset revision 在首轮与重导后均为 1。
- 首轮与重导均按 `batch_id` 回读来源表，三份文件的文件名、SHA-256 与字节数均和 Spec 样本身份表逐项一致。
- 金额守恒采用规范化向量比较：按 subject × 9 currencies 的 `periodTotals` 首轮/重导 `assert.deepEqual` PASS；Pending 按 subject × 8 个实际币种聚合向量 `assert.deepEqual` PASS，币种集合与系统九币种合同一致。仓库不记录原始金额或聚合金额值。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 三份真实样本首轮与重导的任务身份、来源指纹、revision 和主体×币种金额守恒 | 已关闭 | 项目负责人已完成本地临时库回放；证据见上 | 不再阻塞合并 |
| Windows packaged 环境的最终状态切换观感 | PROBE（MANUAL / NOT RUN） | 发布前 Windows 10/11 人工验收 | 不影响代码合并，但影响稳定发布结论 |
