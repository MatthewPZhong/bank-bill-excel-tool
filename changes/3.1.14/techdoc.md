# v3.1.14 TechDoc — VCC 财务 OP 大批量导入性能与阶段反馈

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.1.14 |
| 日期 | 2026-08-21 |
| 状态 | 与已合入实现同步；正式技术发布已授权；Windows 人工边界未验证 |
| 产品 Spec | `changes/3.1.14/spec.md` |
| 发布代码基线 | PR #162 merge commit `1cc5999c62e4666d56b542e37e54529f6177e6bc` |
| 设计起始基线 | `147af9a736b7daaf7a1cdd17eff3535fdc62cd98` |
| 涉及模块 | VCC 财务 OP 校验 |

## 1. 技术目标与不变量

目标是为 staging 自引用外键子列增加 partial index，并在明细读取持久化完成后展示数据库校验写入阶段。

必须保持：`foreign_keys=ON`、`ON DELETE SET NULL`、50,000 行 checkpoint、业务键/content hash/异常/金额/币种/dataset revision、整批清理、归档血缘、取消与 worker 终止合同。`VCC_STORAGE_CONTRACT_VERSION` 继续为 2。

不为手工 schema 破坏、不可达跨 record 引用或未来 SQLite 猜测增加防御；不新增 IPC、状态机框架或清理算法。

## 2. 调用链与根因

```text
renderer handleImport
  → preload/main/service/worker 透明转发
  → import-service 按 sourceType 分组
  → detail-importer 读取、staging、最终读取 COMMIT
  → committing progress
  → classifyAndPromote
       分类 → 提升 → 异常/dataset → staging DELETE → COMMIT
```

自引用外键要求 SQLite 在删除每个父行时查找：

```sql
SELECT rowid
FROM vcc_fin_op_import_staging_rows
WHERE comparison_import_row_id = ?;
```

现有 `(import_record_id, disposition, id)` 与 `(import_record_id, idempotency_key, content_hash, id)` 均不能支撑该查询，导致第二次 staging 全表扫描。

## 3. P0：索引设计

在 `ensureVccStorageSideTables()` 的现有 staging 索引之后增加：

```sql
CREATE INDEX IF NOT EXISTS idx_vcc_fin_op_staging_comparison
  ON vcc_fin_op_import_staging_rows(comparison_import_row_id)
  WHERE comparison_import_row_id IS NOT NULL;
```

partial index 合适的原因：外键等值检查参数是非空父 id；正常 staging 行该列大多为 null；索引只维护实际比较引用，同时仍能支撑等值查找。

安装路径：

- fresh DB 建表时创建；
- 既有 contract-v2 DB 在启动或 worker schema ensure 时补齐；
- `IF NOT EXISTS` 保证重复 ensure 幂等。

不提升 contract 版本，不新增 marker、full index、错误索引修复器或 planner 运行时分支。`repository.clearImportStagingRows()` 保持整批 DELETE。

## 4. P1：progress 合同

### 4.1 事件结构

```javascript
{
  phase: 'reading' | 'committing',
  recordId,
  sourceType,
  sourceFile, // reading 保留
  rows
}
```

reading 沿现有 reader 节奏重复上报；旧 progress 缺少 phase 时 renderer 仍按 reading 处理。

### 4.2 精确事务与事件顺序

单个明细 sourceType：

```text
BEGIN IMMEDIATE
├─ 读取文件并 INSERT staging
├─ 每累计 50,000 行：
│    COMMIT 当前 staging 事务
│    → autocommit UPDATE import_record.raw_count
│    → BEGIN IMMEDIATE
├─ 零或多次 checkpoint
├─ 每个文件解析完成后执行 SHA 二次核对
├─ 最终 shouldCancel 检查
├─ 最终 rawCount/空表检查
└─ COMMIT 最终读取事务

committing progress（一次，rows = rawCount）

classifyAndPromote：
BEGIN IMMEDIATE
→ 冲突/幂等分类
→ 有效数据提升与异常持久化
→ import record / dataset 更新
→ staging 清理
→ COMMIT
```

小于 50,000 行没有中间 checkpoint，只有最终读取提交；超过 50,000 行则是零或多次 checkpoint 加最终读取提交。逐文件 SHA 核对位于每份文件解析之后；最后再执行取消与空表检查。

`committing` 仅表示读取持久化完成、准备调用分类提升；不表示分类已经成功。分类事务随后失败时，该事件仍保留。

读取异常、SHA 变化、取消或空表走读取失败收口，不发送 committing。

### 4.3 renderer 纯函数

```javascript
function buildImportProgressStatus(progress, cancelRequested) {
  if (cancelRequested) return null;
  const label = SOURCE_LABELS[progress.sourceType] || '原表';
  const rows = formatInteger(progress.rows);
  return {
    message: progress.phase === 'committing'
      ? `正在校验并写入 ${label}：${rows} 行`
      : `正在导入 ${label}：${rows} 行`,
    tone: 'info'
  };
}
```

listener 只负责接线：

```javascript
const unsubscribe = api.onImportProgress((progress) => {
  const status = buildImportProgressStatus(progress, state.cancelRequested);
  if (status) setStatus(status.message, status.tone);
});
```

取消判断发生在任何 `setStatus()` 前。返回 null 后继续保留“正在取消导入并回滚本次未完成数据…”。后端 120 秒超时、取消 ACK、事务回滚和 worker 终止不变。

## 5. 测试设计

### 5.1 storage contract

1. fresh DB ensure 后索引存在。
2. 已有 v2 库删除目标索引后再次 ensure 可补齐。
3. 重复 ensure 同名索引只有一份。
4. `sqlite_master.sql` 精确包含目标列和 partial predicate。
5. `foreign_keys=ON` 下执行：

```sql
EXPLAIN QUERY PLAN
DELETE FROM vcc_fin_op_import_staging_rows
WHERE import_record_id = ?;
```

断言外键子行访问包含目标索引，且不存在第二条 `SCAN vcc_fin_op_import_staging_rows`。不锁定计划行号、顺序、`COVERING` 或完整文本。

6. 插入同 record 的 parent/child 非空自引用，调用正式 `clearImportStagingRows()`；目标清空、其它 record 保留、`foreign_key_check` 为空。

### 5.2 detail importer progress

同次成功导入至少两种明细 sourceType，按 sourceType 分组：

- 每组至少一个 reading；
- 每组最后 reading.rows 等于最终 rawCount；
- 每组恰好一个 committing，且位于所有 reading 后；
- committing.rows 等于最终 rawCount；
- 完成读取的明细组集合与 committing 组集合精确相等；
- 系统 OP 不在该集合内。

反例覆盖：读取失败、取消、空表没有 committing；分类阶段拒绝或异常可以已有 committing。不得断言分类成功才有事件。

### 5.3 renderer

执行纯函数验证：

1. `cancelRequested=true` 时 reading/committing 均返回 null；
2. reading 返回“正在导入”；
3. committing 返回“正在校验并写入”；
4. 无 phase 的旧事件返回“正在导入”。

再用最小接线断言确认实际 listener 将 `state.cancelRequested` 传给纯函数，且只对非空结果调用 `setStatus()`；不能只搜索变量名是否存在。

### 5.4 release docs

`tests/unit/vcc-financial-op-release-docs.test.js` 校验两份正式文档的：

- v3.1.14、2026-08-21、代码基线；
- phase 精确时点与每 sourceType 计数；
- 50,000 行 checkpoint、逐文件 SHA、最终 COMMIT 和分类事务顺序；
- 取消优先、120 秒合同、回滚语义；
- 三份样本文件名、SHA-256、字节数一致；
- 不存在把 committing 写成批次级单事件或分类成功后才上报的表述。

## 6. 真实样本与财务证据

| 文件 | SHA-256 | 字节数 |
| --- | --- | ---: |
| `VCC充值清退明细_2026-07_PPHK.xlsx` | `dc9a7f4f63c9aa5eb5cb80ccc1ebb57aa77fbe1c3856825f9e97a640ba40e529` | 8,747,409 |
| `移除归档Pending账单.xlsx` | `a669d5b66b98e4ba360330d7624deb3ce5edc4e1353402d6fc6c90606cbaa7b4` | 8,045,959 |
| `财务OP (3).xlsx` | `b7ae6554ec7db4fb229190eb26d641e0c2d7d1926871762bb42a3317267e08f0` | 4,948 |

首轮与重导各自记录任务身份，并明确 `batchId === batchContext.taskRunId`。来源回读：

```sql
SELECT
  source_file_name,
  source_sha256,
  source_size_bytes
FROM vcc_fin_op_import_sources
WHERE import_record_id IN (
  SELECT id
  FROM vcc_fin_op_import_records
  WHERE batch_id = ?
)
ORDER BY import_record_id, source_ordinal;
```

逐项比对本地文件名、SHA-256 和字节数。人工核对首轮/重导行数、有效行、staging、异常、dataset revision、系统 OP 九币种以及主体×币种金额守恒。真实业务文件不入仓。

## 7. benchmark 方法

- 组合三份样本只记录整批总耗时，以及 reading/committing/结果返回的事件时间点；不同 sourceType 串行执行，不能把最后一个 committing 到批次返回误称为全部数据库阶段。
- 若需要声明数据库阶段耗时，单独用一个 sourceType 测量该组 committing 回调至该次结果返回，并在 implementation notes 记录机器、SQLite、数据规模与测量方法。
- 自动化仅锁定执行计划和语义，不设置固定秒数阈值。

## 8. 文件边界

生产修改：

- `src/backend/vcc-financial-op-db/storage-contract.js`
- `src/backend/vcc-financial-op/detail-importer.js`
- `src/renderer-vcc-financial-op.js`

worker、service、main IPC 与 preload 已透明转发，不为形式完整修改。repository 清理 SQL不变。

同步测试、`package.json`/lockfile、`CHANGELOG.md`、`docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md` 与本目录四份实施文档。

## 9. 兼容与回滚

- 新 phase 是可选扩展；旧事件兼容为 reading。
- 应用代码回滚不会删除已创建的索引。
- 已被 v3.1.14 打开并成功 ensure 的数据库在回滚后继续保留索引与性能收益。
- 只有未升级数据库或恢复旧备份时，旧代码才可能再次运行在缺索引状态。
- 不做 down migration；不改变 contract v2 读写能力或数据格式。

## 10. 门禁

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

绝对耗时仅作本机证据；行数、来源身份、幂等、revision、金额守恒和执行计划才是合并门禁。

## 11. Tag 前正式发布设计

### 11.1 两阶段仓库收口

1. 从已合入功能的 `main@1cc5999c62e4666d56b542e37e54529f6177e6bc` 创建发布准备分支，仅更新发布文档与文档合同测试。
2. 发布准备 PR 的定向文档测试、`release-check` 和 Review 通过后合入 `main`。
3. 再次 fetch 并确认本地 `HEAD === origin/main`、tracked worktree 干净、`package.json.version === 3.1.14`、同名远端 tag/Release 不存在，才创建并推送唯一 annotated tag `v3.1.14`。
4. tag 触发受控 Windows Release workflow；只有公开、非 draft、非 prerelease、latest stable Release 与 Setup、portable、blockmap、`latest.yml` 四项资产完成独立回读后，技术发布才闭合。
5. 从发布后的最新 `main` 创建独立证据分支，回写真实发布准备 PR、merge commit、tag object、peeled commit、workflow、Release、资产大小与摘要；不得修改已发布 tag 或资产。

### 11.2 人工边界与授权

发布负责人在已知以下范围尚未执行后明确授权继续正式技术发布：

- Windows packaged VCC 的 reading → committing → 最终摘要切换，以及取消中提示保持；
- Windows 10/11 Setup 与 portable；
- SmartScreen 实际提示；
- `v3.1.13 -> v3.1.14` 离线覆盖安装及用户数据保留；
- Release 存在后从 `production/latest` 执行的在线升级 canary。

全部范围保持 `MANUAL / NOT RUN`。授权只允许继续生成技术资产，不构成人工 PASS，也不能用于“Windows 已验证”或“在线升级已验证”的公告。

在创建或推送 tag 前，还必须把授权落到稳定的 GitHub PR body 或 Issue 评论：记录实际批准人、上述完整豁免范围、理由，以及发布后逐项补做计划。真实链接只能在 PR/评论创建后写入，不得预写占位；记录缺失或字段不全时不得创建/推送 tag。

### 11.3 不可变身份、回读与失败边界

- annotated tag 名必须与 `package.json.version` 精确一致，peeled commit 必须等于创建 tag 时重新同步并复验的 `origin/main`。
- 本文档不预写尚不存在的 tag object、workflow ID、Release URL、资产大小、SHA-256 或 Setup SHA-512。真实值只在发布后独立回读并写入证据 PR。
- 从 tag 前最终同步/复验并准备推送 tag 起，到 Release workflow 的 `Verify tag and main` 成功为止，冻结对 `main` 的 merge/push；窗口外不要求全程冻结 `main`。
- tag 前发现身份、门禁或 `main` 漂移时停止发布，重新同步并复验门禁、文档和 Review；不得推送已知错误 tag。
- tag 推送后、`Verify tag and main` 成功前若 `main` 漂移，停止 v3.1.14，保留且不改 tag，并发布更高补丁版本。
- 仅当 Release 和资产均尚未创建、且有证据证明是基础设施瞬时故障时，才可在不改代码、tag、commit 或打包输入的前提下对同一 tag/commit 受控重跑。
- 产品、元数据或打包输入问题，或 Release 已创建后的任何失败，均停止公告/推广并发布更高补丁版本。后续人工/canary 失败也执行同一停止规则；不得删除、替换或重传 tag/资产。
