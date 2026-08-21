# v3.1.14 Spec — VCC 财务 OP 大批量导入性能与阶段反馈

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.1.14 |
| 日期 | 2026-08-21 |
| 状态 | 正式实施规格 |
| 关联 TechDoc | `changes/3.1.14/techdoc.md` |
| 产品代码基线 | `147af9a736b7daaf7a1cdd17eff3535fdc62cd98` |
| 涉及模块 | VCC 财务 OP 校验 |

## 0. Goal / Context / Constraints / Done when

- Goal：修复明细原表完成读取后因 staging 自引用外键检查反复扫描而长时间停留的问题，并准确显示读取与数据库校验写入阶段。
- Context：充值清退读取完成 38,197 行后进入幂等分类、提升和 staging 清理；`comparison_import_row_id` 缺少子列索引。
- Constraints：金额、币种、方向、业务键、幂等范围、异常分类、归档、dataset revision、50,000 行 checkpoint、取消与 worker 终止合同不变；禁止为正式路径不可达状态增加防御。
- Done when：新库和旧 contract-v2 库自动具备目标索引；清理执行计划不再二次全表扫描；每个完成读取的明细 sourceType 有一次 `committing`；取消提示不被晚到进度覆盖；真实样本首轮与重导守恒。

## 1. 范围与根因

本迭代只包含：

1. 为 `vcc_fin_op_import_staging_rows(comparison_import_row_id)` 创建幂等 partial index，解决 `ON DELETE SET NULL` 子行定位退化。
2. 明细读取事件增加 `phase: 'reading'`，最终读取事务提交后、分类调用前增加 `phase: 'committing'`。
3. renderer 在取消中忽略晚到的 reading/committing，保持现有取消提示。

现有清理 SQL保持不变：

```sql
DELETE FROM vcc_fin_op_import_staging_rows
WHERE import_record_id = ?;
```

缺少外键子列索引时，SQLite 为每个被删除父行反复扫描 staging 查找引用行，数据量增大后接近平方级退化。索引只改变访问路径，不改变任何业务数据。

## 2. 产品行为合同

### 2.1 索引

```sql
CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_staging_comparison
  ON vcc_fin_op_import_staging_rows(comparison_import_row_id)
  WHERE comparison_import_row_id IS NOT NULL;
```

- 新库首次 schema ensure 时创建。
- 已有 v3.1.10～v3.1.13 contract-v2 库在启动或 worker ensure 时补齐。
- 重复 ensure 幂等；`VCC_STORAGE_CONTRACT_VERSION` 保持 2。
- 不改变 `ON DELETE SET NULL`、整批 DELETE、异常审计或清理事务。

### 2.2 两阶段 progress

| phase | 精确触发时点 | 文案 |
| --- | --- | --- |
| `reading` | 工作簿读取期间 | `正在导入 {原表名称}：{rows} 行` |
| `committing` | 某明细 sourceType 的全部文件完成读取，每个文件在解析后通过 SHA 核对，最终取消/空表检查通过，最终读取事务 COMMIT 后，调用 `classifyAndPromote()` 前 | `正在校验并写入 {原表名称}：{rows} 行` |

规则：

1. reading 可重复；每个完成上述读取合同的明细 sourceType 恰好上报一次 committing。
2. `committing.rows` 等于该组最终 `rawCount`，且位于该组全部 reading 之后。
3. 充值清退与 Pending 同批正常导入时分别上报，共两次；系统财务 OP 不参与明细 phase 计数。
4. 分类事务启动或执行失败时，之前已满足条件的 committing 仍然有效。
5. 读取失败、文件 SHA 变化、取消或空表不会为该组发送 committing。
6. 不提供百分比、剩余时间、`completed` progress 或更多阶段；最终状态继续由现有导入结果摘要负责。

### 2.3 取消显示优先级

当 `state.cancelRequested === true` 时，renderer 忽略随后到达的 reading 和 committing，状态框持续显示：

```text
正在取消导入并回滚本次未完成数据…
```

该规则只改变 UI 文案优先级，不改变后端取消、120 秒超时、事务回滚或 worker 终止合同。

### 2.4 读取事务摘要

保留现有每 50,000 行 checkpoint 与最终读取提交。完整顺序见 TechDoc；本迭代不修改 checkpoint、raw_count 更新或分类提升事务。

## 3. 真实样本身份与发布证据

| 文件 | SHA-256 | 字节数 |
| --- | --- | ---: |
| `VCC充值清退明细_2026-07_PPHK.xlsx` | `dc9a7f4f63c9aa5eb5cb80ccc1ebb57aa77fbe1c3856825f9e97a640ba40e529` | 8,747,409 |
| `移除归档Pending账单.xlsx` | `a669d5b66b98e4ba360330d7624deb3ce5edc4e1353402d6fc6c90606cbaa7b4` | 8,045,959 |
| `财务OP (3).xlsx` | `b7ae6554ec7db4fb229190eb26d641e0c2d7d1926871762bb42a3317267e08f0` | 4,948 |

首轮和重导分别记录任务身份，且明确：

```text
batchId === batchContext.taskRunId
```

按 `batch_id` 回读来源文件名、SHA-256 和字节数，与上表逐项一致；另人工核对：

- 充值清退 38,197 行、Pending 29,159 行，明细合计 67,356 行；
- 首轮 effective 67,356、staging 0、异常 0；
- 重导全部幂等跳过，effective 不变；
- dataset revision 不因纯跳过增加；
- 系统 OP 为 PPHK 九币种快照；
- 首轮与重导的主体×币种金额守恒。

## 4. 明确不做

1. 不关闭外键、不删除自关联、不分批 DELETE。
2. 不重建 staging 表、不提升 storage contract、不新增 migration marker。
3. 不为手工伪造同名错误索引、跨 record 自引用等正式路径不可达状态增加修复器。
4. 不新增 full index 备用、planner 运行时切换、超时重试或清理降级。
5. 不扩展阶段状态机、百分比、事件序号、队列或去重器。
6. 不修改 IPC、后端取消、120 秒超时、worker 终止或归档血缘。
7. 不把真实财务文件提交为仓库 fixture。
8. 不设置跨机器固定耗时 CI 阈值。

## 5. 验收标准

| AC | 验收条件 |
| --- | --- |
| AC-01 | fresh DB schema ensure 后存在 `idx_vcc_fin_op_staging_comparison`。 |
| AC-02 | 已有 contract-v2 库缺少索引时再次 ensure 自动补齐。 |
| AC-03 | 连续 ensure 幂等，同名索引只存在一份。 |
| AC-04 | `sqlite_master.sql` 显示目标列和 `WHERE comparison_import_row_id IS NOT NULL`。 |
| AC-05 | `foreign_keys=ON` 时正式 DELETE 计划使用目标索引定位自引用子行，不出现第二次 staging 全表 `SCAN`。 |
| AC-06 | 同 record 的非空自引用 staging 可整批清除，其它 record 不受影响且 `foreign_key_check` 为空。 |
| AC-07 | 分类、有效行、异常、金额、币种、幂等和 dataset revision 业务口径不变。 |
| AC-08 | 完成读取合同的每个明细 sourceType 恰好一次 committing；完成读取组集合与 committing 组集合精确相等，分类后失败允许已有事件。 |
| AC-09 | 组内 committing 位于全部 reading 之后，rows 等于最终 rawCount；充值清退与 Pending 正常同批为两次，系统 OP 不计入。 |
| AC-10 | 最终成功、跳过、异常和失败仍由既有完成摘要收口，不新增 completed progress。 |
| AC-11 | 取消后晚到 reading/committing 不覆盖取消提示；首轮与重导各自记录同一任务身份，并回读三份样本文件名、SHA-256、字节数与本 Spec 完全一致。 |
| AC-12 | 首轮明细 raw/effective 均为 67,356，staging 0、异常 0；系统 OP 九币种完整。 |
| AC-13 | 重导新增 0、跳过 67,356，effective、revision 及主体×币种金额不发生无效变化。 |
| AC-14 | diff 不包含新清理算法、外键关闭、表重建、通用状态机或不可达 case 防御。 |

## 6. 手动测试清单

### P0

1. 用缺少目标索引的 contract-v2 数据库启动，确认自动补齐且原业务行不变。
2. 干净临时库导入三份指定样本，记录事件时间点、总耗时、任务身份、来源回读、行数和金额。
3. 原库重导三份样本，确认幂等、revision 与金额守恒。
4. 合成同 record 冲突，确认异常可审计、staging 清空、外键完整。
5. 读取阶段点击取消，确认取消提示不被晚到 progress 覆盖且未完成数据不进入有效集。

### P1

1. 单份小明细兼容 reading → committing → 最终摘要。
2. 两类明细分别出现 committing；系统 OP 不产生明细 committing。
3. 文件失败、SHA 变化和空表沿用错误提示且该组没有 committing。
4. 已归档账期新增数据在 committing 后按既有分类规则失败。

## 7. 兼容与回滚

- progress 保留原字段并新增可选 `phase`；旧无 phase 事件按 reading 展示。
- 已创建索引的数据库在代码回滚后仍保留索引和性能收益，应用回滚不会自动删除它。
- 只有从未经过 v3.1.14 ensure 的数据库，或恢复了 v3.1.14 之前的备份，才可能再次缺索引并退化。
- 不执行 down migration；旧代码可安全读写带额外索引的 contract-v2 数据库。

## 8. 发布门禁

```bash
node --test tests/unit/backend/vcc-financial-op/storage-contract.test.js
node --test tests/unit/backend/vcc-financial-op/detail-importer.test.js
node --test tests/unit/renderer-vcc-financial-op.test.js
node --test tests/unit/vcc-financial-op-release-docs.test.js
npm run release-check
npm run scan:vars
npm run check:vars
git diff --check
```

Windows 构建、真实样本验收和 release gate 完成前，只能称 v3.1.14 迭代版本，不得写成已发布稳定版。
