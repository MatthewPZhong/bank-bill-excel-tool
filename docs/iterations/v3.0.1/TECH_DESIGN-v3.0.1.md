# TechDoc - 网银账单小助手 v3.0.1

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.1 |
| 日期 | 2026-06-09 |
| 作者 | Dev（team-lead 收口，待 dev 实施时细化） |
| 状态 | 初稿 |
| 关联 PRD | `docs/iterations/v3.0.1/PRD-v3.0.1.md`（25 条 AC，4 项需求） |
| 依赖 | v3.0.0 baseline；4 份源 spec：`changes/linked-gateway-bill-batch-idempotent/`、`changes/biz-op-recon-left-buttons-shift/`、`changes/gateway-recon-scenario-picker-style-fix/`、`changes/adm-derive-popup-only-when-data/` |
| 原则 | **最大化复用现成、最小化改动**；资金红线（需求1）仅改 schema + 网关落库语义，**不碰对账引擎与编排器**（原「对账消费标记」方案 2026-06-09 已移除） |

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §5.1 幂等累加（upsert by ReconBillBizId） | 可行。SQLite 支持 `ON CONFLICT(列) DO UPDATE`，需配 UNIQUE 索引。新增网关专用 `upsertLinkedGatewayBill`，**不复用** `replaceLinkedTable`（4 表共用、整表覆盖语义不能破坏 mid-allocation/fx/bank-deposit + ADM 派生）。 |
| §5.1 按日期删除 | 可行。新增 IPC + `DELETE ... WHERE bill_date BETWEEN ? AND ?` + meta 重算。 |
| §5.2 按钮右移 | 可行且极轻。`#bizOpReconModulePanel` 专属选择器 + `transform: translateX(px)`；因 workspace-shell 恒 960px（<窗口 minWidth 1080），D 恒定，可写死 px。 |
| §5.3 场景框样式 | 可行。对齐项目 `pending-reconcile-card` 范式，专属 `gateway-recon-picker-card` class，逻辑零改。 |
| §5.4 ADM 提醒 | 可行且最小。`buildAdmDeriveHtml` 加一行 `total` 守卫，后端不动。 |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 | 🔴 reconid 跨期复用 → R1/R5s2/R5s3 1v1 漏匹配 | ✅ **用户接受（2026-06-09，PRD §十 Q7=A）**：消费标记移除，对账维持全表，漏匹配作为已知限制接受、本期不规避。建议提 PR 前用真实样本**评估**漏匹配程度并在用户文档告知 |
| R-2 | 🔴 UNIQUE 索引在存量空值 `''`/重复值上建不起来 → 资金模块启动失败 | migration 先清洗：空 `ReconBillBizId` 行处理 + 重复去重，再建 UNIQUE（§三需求1 D1） |
| R-3 | 🔴 「整表覆盖→累加」语义破坏，用户旧心智失效 | 导入完成框 + 管理界面文案明确「累加导入」；《删除》按钮作为「换批」手段 |
| R-4 | 流式 upsert 须保留单事务跨 await + 全 ROLLBACK | upsert 流式版沿用 `replaceLinkedTableStreaming` 的事务骨架（`linked-table-repository.js:290`，已实测 657,757 行回滚） |
| R-5 | 需求2 改公共 `.pending-board` 会殃及 4 模块 | 强制 `#bizOpReconModulePanel` ID 圈定，code review 卡点 |
| R-6 | 改前端（需求 2/3/4 + 需求1 task7）须回归 preview | 落地后跑对应 `npm run preview:*`（项目硬约定 workflow_frontend_previews） |

### 1.3 与 PRD 的差异

无。技术方案与 PRD §五一致。`source_file_name` 显示策略（PRD Q2 / 需求1 OPEN-5）落地时按「最近一次 + 累计 N 来源」实现，若评审改口径再调。

---

## 二、涉及的文件清单

| 文件 | 改动类型 | 概要 | 需求 |
|------|---------|------|------|
| `src/backend/database/migrations.js` | 修改 | `linked_gateway_bill` 加 `recon_bill_biz_id` 列 + 回填 + UNIQUE 索引 + 存量去重/空键清洗 | 1 |
| `src/backend/database/linked-table-repository.js` | 修改 | 新增 `upsertLinkedGatewayBill`(数组+流式)、`deleteGatewayBillByDateRange`；meta 全表重算。**对账读取 `readLinkedTableRows('gateway-bill')` 不改** | 1 |
| `src/backend/database.js` | 修改 | AppDatabase facade 暴露上述新方法 | 1 |
| `src/main.js` | 修改 | `linked-table:import` 网关分支改走 upsert + 回传 `overwriteCount`/`rejectedEmptyCount`；新增 `linked-table:delete-by-date-range` handler | 1 |
| ~~`reconciliation-orchestrator.js`~~ | ❌ 不改 | 原计划「取未标记 + 命中回写标记」随消费标记移除，本期**不动编排器** | — |
| `src/renderer-dialogs.js` | 修改 | ①链接表管理弹窗加《删除》按钮 + 日期范围弹框 + 导入完成框提醒（需求1）；②场景框 DOM 换专属范式（需求3）；③`buildAdmDeriveHtml` 加 `total` 守卫（需求4） | 1/3/4 |
| `src/styles-gemini-extra.css` | 修改 | ①`#bizOpReconModulePanel` 右移规则（需求2）；②`gateway-recon-picker-card` 专属 CSS（需求3） | 2/3 |
| `tests/unit/*`、`scripts/integration/*` | 新增 | upsert 幂等 / overwriteCount / 空键拒入 / 删除 单测 + 集成 | 1 |

---

## 三、需求 1：网关对账单批量导入 + 幂等累加 + 删除 + 消费标记

### 3.1 实现方案

「整表覆盖→跨次幂等累加」。改动集中在 schema（加幂等键列 + UNIQUE）、网关专用 upsert、按日期删除三处，**完全不碰对账引擎与编排器**。

> ⚠️ 原方案含「对账消费标记」（`matched_flag` + 只读未标记 + 命中回写）以规避 reconid 跨期复用漏匹配，2026-06-09 **整体移除**。对账维持现状全表读取，漏匹配风险 re-opened（PRD §十 Q7）。

**为何不复用 `replaceLinkedTable`**：它被 4 张链接表共用且语义是「整表覆盖」，直接改会破坏 mid-allocation/fx-settlement/bank-deposit 的覆盖语义与 ADM 派生连锁。故新增网关专用函数。

### 3.2 改动点

| 文件 | 行号（现状参照） | 改动内容 |
|------|------|---------|
| `migrations.js` | `2674`(建表) / `2687`(hasColumn 范式) | 加列 + 回填 + 索引 + 去重清洗（D1） |
| `linked-table-repository.js` | `256`/`297`(replace*) | 新增 upsert / delete（D2/D4）；对账读取 `334` `readLinkedTableRows` **不改** |
| `main.js` | `11218`(import handler) / `11310`(results) | 网关分支走 upsert + 回传计数；新增 delete handler（D3/D4） |
| `renderer-dialogs.js` | `createLinkedTableManagerDialog` | 删除按钮 + 日期弹框 + 提醒（D4/D5） |

### 3.3 代码示例

**D1 — schema 迁移（幂等 + 存量清洗）**
```sql
-- 幂等加列（仿 migrations.js:2687 hasColumn 守卫）
ALTER TABLE linked_gateway_bill ADD COLUMN recon_bill_biz_id TEXT;   -- 仅列不存在时
-- 回填幂等键（精确大小写 ReconBillBizId）
UPDATE linked_gateway_bill SET recon_bill_biz_id = json_extract(raw_json,'$.ReconBillBizId');
-- ⚠️ 建 UNIQUE 前先清洗：空键行直接删（OPEN-8）+ 重复键（保留最大 id）——否则建索引抛错（R-2）
DELETE FROM linked_gateway_bill WHERE recon_bill_biz_id IS NULL OR recon_bill_biz_id = '';
DELETE FROM linked_gateway_bill WHERE id NOT IN (
  SELECT MAX(id) FROM linked_gateway_bill GROUP BY recon_bill_biz_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_linked_gateway_bill_biz ON linked_gateway_bill(recon_bill_biz_id);
-- ❌ 不再新增 matched_flag 列 / matched 索引（消费标记移除）
```

**D2 — 网关专用 upsert（统计 overwriteCount / rejectedEmptyCount）**
```javascript
// INSERT ... ON CONFLICT(recon_bill_biz_id) DO UPDATE，逐行判 INSERT/UPDATE 累计 overwriteCount
const sql = `INSERT INTO linked_gateway_bill
  (recon_bill_biz_id, reconciliation_id, bill_date, raw_json, imported_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(recon_bill_biz_id) DO UPDATE SET
    reconciliation_id=excluded.reconciliation_id,
    bill_date=excluded.bill_date,
    raw_json=excluded.raw_json,
    imported_at=excluded.imported_at`;
// 空 ReconBillBizId → 不入库，rejectedEmptyCount++（D3 提醒）；DO UPDATE 仅重写数据列（D2）
```

**D4 — 按日期范围删除（直接删，OPEN-6）**
```javascript
// DELETE FROM linked_gateway_bill WHERE bill_date BETWEEN ? AND ?（闭区间）→ meta 全表重算 → 返回删除行数
// 前端弹框须显著提示「删除后不可恢复 + 将删约 N 行」（唯一一道确认，无二次确认框）
```

### 3.4 注意事项
- meta（rowCount/dateMin/dateMax）累加 / 删除后不能用单批增量，须 `SELECT COUNT(*)/MIN/MAX` 全表重算。
- 流式 upsert 沿用单事务骨架，中途 throw 全 ROLLBACK（R-4）。
- ⚠️ 对账读取（`readLinkedTableRows('gateway-bill')`）**维持现状全表**，本期不改——reconid 跨期复用漏匹配未解（PRD §十 Q7）。

---

## 四、需求 2：业务OP按钮右移

### 4.1 实现方案
仅 `styles-gemini-extra.css` 追加一条专属规则，用 `transform: translateX` 平移左列两元素（不改 grid 轨道、不挤压右列）。D 恒定（workspace-shell 960 < 窗口 minWidth 1080），可写死 px。

### 4.2 改动点 / 代码示例
```css
/* 业务OP数据核对：左列（BU 下拉 + 导出差异）整体右移 = D/2 + 12px */
#bizOpReconModulePanel .cell.left > * {
  transform: translateX(<SHIFT>px);  /* <SHIFT>=D/2+12，实施时 preview 实测确定 */
}
```
### 4.3 注意事项
- 🔴 严禁改 `.pending-board .cell.left` 公共规则（殃及 4 模块）；必须 `#bizOpReconModulePanel` 圈定。
- `<SHIFT>` 实测法：`preview` 渲染真实 panel → 读 `exportBtn.right`→`statusBox.left` 得 D → `D/2+12` 写入 → 复核。

---

## 五、需求 3：场景框样式修复

### 5.1 实现方案
对齐项目窄弹框范式（`pending-reconcile-card`）：DOM 换专属 `gateway-recon-picker-card` class，补专属 CSS；交互逻辑零改。

### 5.2 改动点
- `renderer-dialogs.js:10145-10163`：`className` 改 `'modal-card gateway-recon-picker-card'`；结构 `dialog-header>dialog-title` + `gateway-recon-picker-body>(hint+list>items)` + `dialog-actions`；单选项用 `.gateway-recon-picker-item` class。
- `styles-gemini-extra.css`：追加 11 行专属 CSS（标题 16px、body padding 4px 28px、hint、list、item hover、actions），见 `changes/gateway-recon-scenario-picker-style-fix/spec.md §二改动2`。

### 5.3 注意事项
专属 class，不碰 `alert-card`/`dialog-*` 公共规则；逻辑（escapeHtml/radioName/onPick/取消确认）完全不动。

---

## 六、需求 4：ADM 派生提醒

### 6.1 实现方案 / 代码示例
`buildAdmDeriveHtml` 成功分支加 `total` 守卫，后端不动：
```javascript
// renderer-dialogs.js:6316-6320
const unmatched = Array.isArray(admDerive.unmatched) ? admDerive.unmatched : [];
if (unmatched.length === 0) {
  if (!admDerive.total) return null;          // 0 行：不弹（返回 null → 调用链跳过 ADM 框）
  return 'ADM银行对账单链接表已创建。';
}
```
### 6.2 注意事项
- `total===0 ⟹ unmatched.length===0`（空源派生无未匹配，spec 已证），守卫放成功分支即可。
- 失败分支（`created===false`）、部分成功分支不动。

---

## 七、任务分解

> 每个 task 尽量小、可验证、可独立完成。需求1 拆 7 task，需求 2/3/4 各 1~2 task。

| 序号 | 任务 | 涉及文件 | 验证方式 | 状态 |
|------|------|---------|---------|------|
| 1 | migration：加 `recon_bill_biz_id` 列 + 回填 + UNIQUE 索引 + 存量去重/空键清洗 | `migrations.js` | 单测：旧库（含空/重复键）启动不抛错（AC1-6） | ✅ done（含 console.warn→appendModuleLog 修复） |
| 2 | 仓储·导入：`upsertLinkedGatewayBill`(数组+流式) + overwriteCount + 空键拒入 + meta 重算 | `linked-table-repository.js`、`database.js` | 单测：幂等/计数/ROLLBACK（AC1-1~5,7） | ✅ done（UT-UPSERT ×7） |
| 3 | handler·导入：网关分支改 upsert + 回传计数 | `main.js` | 集成：多文件累加 + 提醒（AC1-1~5） | ✅ done（集成 31/31） |
| 4 | 删除：`linked-table:delete-by-date-range` handler + DB + meta 重算 | `main.js`、`linked-table-repository.js` | 集成：按日期删 + meta（AC1-8） | ✅ done（含 count-by-range 预览；集成 40/40） |
| 5 | 前端·需求1：《删除》按钮 + 日期弹框（直接删 + 显著提示）+ 导入完成框提醒 | `renderer-dialogs.js` | preview 回归 + 手测（AC1-4,5,8） | ✅ done（删除弹框 + 累加提醒 + 新 preview linked-table-delete-range） |
| 6 | 需求2：左列右移 CSS（实测 SHIFT） | `styles-gemini-extra.css` | `preview:biz-op-recon`，4 模块对照（AC2-*） | ✅ done（实测 D=147px → SHIFT=85.5px；像素级隔离证明不殃及另 3 模块） |
| 7 | 需求3：场景框 DOM + 专属 CSS | `renderer-dialogs.js`、`styles-gemini-extra.css` | preview / 手测（AC3-*） | ✅ done（新 preview gateway-recon-scenario-picker） |
| 8 | 需求4：`buildAdmDeriveHtml` 加 total 守卫 | `renderer-dialogs.js` | 手测 3 路径（AC4-*） | ✅ done |
| 9 | 三件套 + 文档：CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE + 本迭代 PRD 实施记录 | 三件套 + `docs/iterations/v3.0.1/` | 发版前统一更新 | ✅ done（需求1-4；需求5 由并行线；未 bump 版本号） |

> ❌ 原 task 4/5（对账消费标记 仓储 + 编排器）已移除。
> 🔴 task 1/2 触及 schema + 落库语义（资金红线）——**提 PR 前必跑 `/check-vars`**（项目硬节点）。本期**不再触及对账编排器**（消费标记移除）。⚠️ 对账漏匹配（PRD §十 Q7）落地前须由用户定方向。

---

## 八、实施计划（Commit 粒度）

| 序号 | Commit message | 涉及文件 | 需求 |
|------|---------------|---------|------|
| 1 | `feat(v3.0.1/链接表): 网关对账单 schema 加幂等键+消费标记列+迁移清洗` | `migrations.js` | 1 |
| 2 | `feat(v3.0.1/链接表): upsertLinkedGatewayBill 幂等累加+overwriteCount+流式事务` | `linked-table-repository.js`、`database.js` | 1 |
| 3 | `feat(v3.0.1/链接表): import handler 网关分支改 upsert + 覆盖/拒入回传` | `main.js` | 1 |
| 4 | `feat(v3.0.1/链接表): 按日期范围删除 handler + meta 重算` | `main.js`、`linked-table-repository.js` | 1 |
| 5 | `feat(v3.0.1/链接表): 删除按钮+日期弹框+导入完成框覆盖/拒入提醒` | `renderer-dialogs.js` | 1 |
| 6 | `style(v3.0.1/业务OP): 左列按钮右移 D/2+12 专属选择器` | `styles-gemini-extra.css` | 2 |
| 7 | `fix(v3.0.1/网关场景框): 对齐窄弹框范式修样式错乱` | `renderer-dialogs.js`、`styles-gemini-extra.css` | 3 |
| 8 | `fix(v3.0.1/ADM): 仅派生出数据才弹「已创建」提醒` | `renderer-dialogs.js` | 4 |
| 9 | `test+docs(v3.0.1): 单测/集成 + 三件套 + 实施记录` | tests、三件套、iterations | 全部 |

> commit 不加 AI 署名（项目约定）。一 task 一 commit。

---

## 九、实施日志

> 记录实施过程中的关键决策、风险发现和可沉淀知识（由 dev 实施时追加）。

### 2026-06-09
- 动作：team-lead 收口 4 份 change spec 为 v3.0.1，产出 PRD + 本 TechDoc（未写代码）。
- 证据：4 份 spec 版本号已 reverse-sync 为 3.0.1；`docs/iterations/v3.0.1/` 已建。
- 风险：需求1 资金红线（R-1~R-4），实施前必读 §一 1.2 + 跑 `/check-vars`。
- 决策：需求1 与 3 项 UI 修复同发 3.0.1（用户决策，PRD Q1 留评审复核）。

### 2026-06-09（消费标记移除）
- 动作：按用户「对账消费标记有关的完全去掉」，从 spec/PRD/本 TechDoc 移除整套消费标记（`matched_flag`、D6/D7、`readUnmatchedGatewayBillRows`、`markGatewayBillMatched`、编排器回写、相关 AC/task/commit/测试）。
- 影响：需求1 收敛为「批量导入 + 幂等累加 + 按日期删除」；不再触及对账编排器/状态机；task 11→9、AC 25→22。
- 🔴 风险：消费标记原是解 reconid 跨期复用漏匹配的方案，移除后 R-1 re-opened（PRD §十 Q7），落地前须用户定对账数据范围。

### 2026-06-09（task1–3 实施 + 工作树发现）
- **task1**：migration 已落（`migrations.js` recon_bill_biz_id + UNIQUE + 清洗）；单测 UT-GW-BIZ ×3 绿。
  - 🔧 修复：task1 初版用 `console.warn` 记录不可逆删除行数，违反架构守护 `v2.1.9-sr-log-1` Case 6（src 全树零 `console.error/warn`）。改走 `appendModuleLog({level:'warning',source:'main',domain:'migration',...})`，与本文件 N4 备份失败范式一致；无 storageRoot 时 silent skip（单测不受影响）。Case 6 恢复 33/33。
- **task2**：`upsertLinkedGatewayBill`(数组+流式) 已落，UT-UPSERT ×7 绿（含 ROLLBACK / 空键拒入 / overwriteCount 全表重算）。
- **task3**：`linked-table:import` 网关分支改走 upsert（流式 `upsertLinkedGatewayBillStreaming` + 数组 `upsertLinkedGatewayBill`），其余 3 表保持 replace；`okResult` 仅网关加 `overwriteCount/rejectedEmptyCount`。新增集成 `scripts/integration/v3.0.1-linked-gateway-upsert.js`（6 步：detector 路由/流式首导/累加覆盖/空键拒入/数组路径/读回，31/31）。
- ✅ **release-check 全绿**（exit 0）：unit 2071/2071、集成 19/19、smoke 通过。
- 🚩 **工作树注意（非本迭代产物）**：核 diff 发现 `src/main-process/scenario-engines/r5-fund-transfer-backfill.js` + 其单测被改（移除 `reconid-overwrite-backfill` 告警）。经 transcript 取证，来自**另一并行会话 `a2ccb174`**（议题「资金对账各功能触发报错条件」，2026-06-09 17:09 编辑），**与 v3.0.1 无关**。处置：不碰、不还原，提交 v3.0.1 时按路径精确 `git add` 隔离。该 🔴 资金红线引擎改动归属另一工作流，待用户/该会话处理。

### 可沉淀知识
- [ ] upsert 流式版的单事务骨架复用经验（若实测有坑，回写 `knowledge/`）。
- [ ] 「消费标记」方案的设计与移除取舍（对账类「累加多期 + 跨期复用键」的通用难点，值得入 `knowledge/` 备查）。

---

## 十、Open Technical Questions

- OPEN-T1：✅ **已定（2026-06-09）：A 接受漏匹配**（PRD §十 Q7）。对账维持读全表，累加多期下的 reconid 跨期复用漏匹配作为已知限制接受，本期不实现任何规避；实施时在导入提醒 / 用户文档适当告知。
- OPEN-T2：`source_file_name` 累加后口径（PRD Q2）——多来源拼接 vs「最近 + 计数」，待评审定。
- OPEN-T3：场景框是否补 `preview:gateway-recon-scenario-picker` fixture（PRD Q5）——现疑无入口，task9 时确认。
- OPEN-T4：✅ **已定（2026-06-09）：建 UNIQUE 前直接删除空 `ReconBillBizId` 存量行**（与新导入「空键拒入」同口径，§3.3 D1 SQL 已是此实现）。🔴 不可逆删除，migration 必须记录删除行数到日志。
- OPEN-T5：✅ **已定（2026-06-09）：《删除》按钮闭区间 + 直接删（无二次确认）**。task6/7 实现时，删除弹框内须显著提示「删除后不可恢复 + 将删约 N 行」——这是唯一一道确认，UI 上要做足（资金数据删除）。
