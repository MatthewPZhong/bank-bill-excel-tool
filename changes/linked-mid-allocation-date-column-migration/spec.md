# Spec — linked_mid_allocation 日期列名残留迁移（business_date → transaction_date）

> 状态：**待确认（未实施）** ｜ 来源分支：`v2.1.16-beta.6` ｜ 目标版本：待定
> 性质：🔴 资金对账链接表 schema 迁移（喂给 JPM/ADM 三段匹配的数据源表）—— 改动本身是一条幂等列重命名，不碰对账计算
> 缘起：用户导入「中台调拨订单表」用例文件报错 `table linked_mid_allocation has no column named transaction_date`，成功 0 失败 1

---

## 一、问题

导入中台调拨订单表时落库失败，报错：

```
table linked_mid_allocation has no column named transaction_date
```

`replaceLinkedTable` 的 INSERT 用 `def.dateColumn = 'transaction_date'`（`linked-table-repository.js:74` / `:200`），但用户本地 DB 里这张表的日期列实际叫 **`business_date`**，列名不匹配 → INSERT 报错 → 整文件导入失败。

---

## 二、调查结论（实证）

| 检查 | 事实 | 出处 |
|------|------|------|
| 代码当前 schema | `linked_mid_allocation` 日期列 = `transaction_date` | `migrations.js:2690`（建表）；`linked-table-repository.js:74` `dateColumn` |
| git 历史 | committed 代码**从 beta.1 第一次建表起就是 `transaction_date`**，从未提交过 `business_date` | `git log -S transaction_date` 仅命中 `051f004`；`git log -p` 全程无 `business_date` |
| 用户本地 DB 实际 schema | 日期列 = **`business_date`**（旧名，17 行旧测试数据），索引 `idx_linked_mid_allocation_date` 也建在 `business_date` 上 | `PRAGMA table_info(linked_mid_allocation)` 实查 |
| 其余 4 张链接表 | gateway-bill / fx-settlement / bank-deposit / adm 的 schema 均与代码一致，**仅本表错位** | 5 表 PRAGMA 全查 |
| 为何不自愈 | 建表用 `CREATE TABLE IF NOT EXISTS`（`migrations.js:2687`），表已存在即 no-op，**不会改列名也不会补列** | `migrations.js:2654` 注释自述「幂等 no-op」 |

### 成因推断
开发期这张表的日期列从 `business_date` 改名为 `transaction_date`（注释「列名已对齐『交易时间』」`migrations.js:2685`）。改名发生在**提交前的中间构建**：committed 代码一直是 `transaction_date`，但开发/beta 机器上的表是**改名之前**跑该中间构建时建的，残留 `business_date`。对比佐证：同批建的 `linked_fx_settlement` 是 `transaction_date`（正常），唯独 `mid_allocation` 残留 —— 说明这张表的改名晚于它首次落库。

### 影响面
- **`main` 线上从未发布过 `business_date`** → 正式版用户不受影响。
- **仅受影响者**：跑过该中间 beta 构建、且当时导入过中台调拨订单表的机器（开发机 + 部分 beta 测试者）。

---

## 三、已做的临时处置（仅开发机本地 DB）

App 未运行（无锁），已对开发机 `~/Library/Application Support/bank-bill-excel-tool/tool-data.sqlite`：
1. 备份 → `tool-data.sqlite.bak-20260608T173008`
2. `ALTER TABLE linked_mid_allocation RENAME COLUMN business_date TO transaction_date;`（SQLite 自动同步索引引用，已验证）

> 那 17 行旧数据无需保留：导入逻辑是「整表 DELETE + 重新 INSERT」（`linked-table-repository.js:221`），下次导入即覆盖整表。
> ⚠️ 此临时处置**只修了开发机一台**，未覆盖其他 beta 测试者 → 这正是本 spec 要解决的。

---

## 四、改造方案

在 `ensureLinkedTableSupport`（`migrations.js:2656`）建表 `linked_mid_allocation` **之前**，加一段幂等防御迁移，检测残留旧列名并就地改名：

```js
// 残留旧列名迁移：中间 beta 构建曾用 business_date，已改名 transaction_date；
//   CREATE TABLE IF NOT EXISTS 不会迁移已存在表 → 显式 RENAME COLUMN（幂等：仅当旧列在、新列不在时执行）。
if (hasColumn(db, 'linked_mid_allocation', 'business_date')
    && !hasColumn(db, 'linked_mid_allocation', 'transaction_date')) {
  db.exec('ALTER TABLE linked_mid_allocation RENAME COLUMN business_date TO transaction_date;');
}
```

### 依据 / 先例
- `hasColumn(db, table, col)` helper 已存在（`migrations.js:10`），项目内 `ALTER TABLE ... ADD COLUMN` / `RENAME` 迁移是既有范式（`migrations.js:20/58/84/234` 等多处）。
- SQLite `RENAME COLUMN`（3.25.0+）会自动更新索引/视图对该列的引用，无需重建索引（已在开发机实测验证）。

### 触及代码点
- `src/backend/database/migrations.js`：`ensureLinkedTableSupport` 内，`linked_mid_allocation` 建表语句前插入上述判断（约 `:2685` 前）。
- 仅此一处；不动 `linked-table-repository.js` / 业务逻辑。

### 不做的事
- 不动其余 4 张链接表（schema 均正常）。
- 不改 INSERT / 读取逻辑（代码侧 `transaction_date` 已是正确目标态）。

---

## 五、验证计划

| 项 | 方法 |
|----|------|
| 幂等性 | 对「已是 transaction_date」的 DB 跑迁移 → `hasColumn` 双条件不满足 → no-op，不报错 |
| 残留修复 | 构造 `business_date` 旧表 DB → 启动跑迁移 → 列变 `transaction_date`、索引引用同步 |
| 回归 | `npm run test:unit`（迁移相关 spec）+ `npm run release-check` |
| 真机 | 用本 spec 报错的用例文件 `渠道账单_*.xlsx` / `Fund_transfer_apply_*.xlsx` 重导，确认落库成功 |

---

## 六、风险提示（人工复核）

- 🔴 触及**资金对账链接表 schema 迁移**：本表是 JPM 调拨订单修复 + ADM 派生的数据源（`readLinkedTableRows('mid-allocation')` / `buildAdmRows`）。列名对齐后，下游读取链路不变。
- 迁移在**幂等启动迁移**中运行，每次启动都跑 → 必须严格双条件门控（旧列在 ∧ 新列不在），避免对正常 DB 误操作。
- 提 PR / 合并前按项目约定跑 `/check-vars`（命中 `linked_mid_allocation` / 链接表相关重要变量时输出关联 review 段）。
