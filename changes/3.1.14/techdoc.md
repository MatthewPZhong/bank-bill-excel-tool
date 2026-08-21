# v3.1.14 TechDoc — VCC 财务 OP 大批量导入性能与阶段反馈

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.1.14 |
| 日期 | 2026-08-21 |
| 状态 | 与已发布实现同步；正式技术 Release 与资产回读完成；Windows 人工边界未验证 |
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

## 11. 正式发布证据

### 11.1 仓库、tag 与 workflow 身份

1. 功能 PR #162 以 merge commit `1cc5999c62e4666d56b542e37e54529f6177e6bc` 合入产品代码，发布准备 PR #163 以 merge commit `225d07d17a7c211348ba549734aaf84f602253cb` 收口 `main`。
2. annotated tag `v3.1.14` 的 tag object 为 `fee1498311854a69fea666fe275511da89d99836`，peeled 后精确指向 `225d07d17a7c211348ba549734aaf84f602253cb`；远端 tag 回读一致。
3. Windows Release workflow [32508170702](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/32508170702) 全部 15 步 success；`Verify tag and main` 成功后完成 release-check、构建、应用检查、staging、更新元数据和 Release 回读。
4. [v3.1.14 Release](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.14) 于 `2026-08-21T17:58:54Z` 发布，公开、非 draft、非 prerelease；GitHub 默认 latest 回读 `tagName=v3.1.14`。

### 11.2 人工边界与授权留痕

PR #163 body 已稳定记录实际批准人、完整豁免范围、理由和发布后逐项补做计划；其范围为：

- Windows packaged VCC 的 reading → committing → 最终摘要切换，以及取消中提示保持；
- Windows 10/11 Setup/portable；
- SmartScreen 实际提示；
- `v3.1.13 -> v3.1.14` 离线覆盖安装及用户数据保留；
- Release 存在后从 `production/latest` 执行的在线升级 canary。

全部范围继续保持 `MANUAL / NOT RUN`。技术 Release 完成不构成人工 PASS，也不能用于“Windows 已验证”或“在线升级已验证”的公告；任一补测失败均停止推广并发布更高补丁。

### 11.3 资产回读、串行窗口与失败边界

- portable `bank-bill-excel-tool-portable-3.1.14.exe` 为 `99,874,669` bytes，SHA-256 `964944f588bfe4ca38b73bc9e45af3d795a5d05fec48ab1b52d942c541e02781`。
- Setup `bank-bill-excel-tool-setup-3.1.14.exe` 为 `100,371,449` bytes，SHA-256 `e71e17aa0525b92ca9d15c508ef48cd783ed24ebdd63ace82cb693a1920503df`；blockmap `bank-bill-excel-tool-setup-3.1.14.exe.blockmap` 为 `105,515` bytes，SHA-256 `831edeaa11a2e4015f812b81d794c38c9c7fed98fb179f05607bcf635c87ef10`。
- `latest.yml` 为 `372` bytes，SHA-256 `9dea317367aa36cde238c672b870151613686538da035a3f4472984a3a491a2c`；version `3.1.14`，path/size 对应 Setup，releaseDate `2026-08-21T17:58:41.566Z`，Setup SHA-512 `QmsR5uVGyBSwB1A8w7J70WyiIgqEE7HOLfZVXhxWPh91G3uREMH21u3tWcj+wYnB6T3fBvMydQevH6+fwUll4g==`，独立计算一致。
- 四项资产均以无凭据公开 HTTPS GET 完整下载，实际大小/SHA-256 与 GitHub asset digest 一致；两个 EXE 均识别为 Windows PE32 GUI / Nullsoft Installer self-extracting archive，认证下载与匿名下载逐字节一致。
- 从最终同步/tag 推送到 `Verify tag and main` 成功的最小 `main` 冻结窗口已经执行并闭合；workflow 首轮成功，未触发瞬时故障重跑。
- `isImmutable=false` 只表示 GitHub 未启用平台级强制；tag/资产仍不得删除、替换或重传。只有 Release/资产均未创建且可证明为基础设施瞬时故障时，才可在代码、tag、commit、打包输入不变时受控重跑同一 tag/commit；产品、元数据、打包输入问题或 Release 已创建后的失败必须改发更高补丁。
