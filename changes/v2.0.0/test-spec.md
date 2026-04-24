# Test Spec — v2.0.0

> status: propose（PRD 定稿后派生；实施阶段由 Dev 跑）
> created: 2026-04-23

## 覆盖范围

全量对应 PRD §六 的 21 条 AC + §七 的 13 P0 + 8 P1。

### 自动化覆盖

- `npm run smoke`：v1.5.3 原有场景（不动）——保证现有两个模块不被 v2.0.0 破坏
- 新增 `node scripts/test-v2.0.0-pending.js`（**建议 Task 11 时写**）：
  - Small-data reconciliation：5 行 × 5 行，手工算出 `new=1 / missing=1 / changed=2 / unchanged=1`，跑 engine 后 `diff_rows` 精确匹配
  - Hash collision detection：构造同月两文件含 1 条重复行，验证 worker 正确识别并 rollback
  - Adjacent month checker：单测 `isAdjacentMonths('2025-12', '2026-01') === true`、`('2026-01', '2026-03') === false` 等

### 手动回归（人工必跑）

PRD §七 的 P0-1 ~ P0-13 全部跑。

## P0 必测场景（13 条）

编号对应 PRD §7.1。逐条打勾记录在 `changes/v2.0.0/log.md`。

- [ ] P0-1 首次切到 Pending 模块
- [ ] P0-2 规则首次保存
- [ ] P0-3 单文件导入
- [ ] P0-4 表头不一致
- [ ] P0-5 多文件同月合并（无冲突）
- [ ] P0-6 多文件行级冲突（导出报错文件）
- [ ] P0-7 重复月份覆盖（含留底）
- [ ] P0-8 相邻月对账
- [ ] P0-9 非相邻月
- [ ] P0-10 跨年相邻（2025-12 + 2026-01）
- [ ] P0-11 无差异场景
- [ ] P0-12 单月导出（选 run）
- [ ] P0-13 汇总导出

## P1 应测场景（至少 5 条）

- [ ] P1-1 大文件性能（300 万行 < 5 分钟）**←⚠️ 资金风险红线**
- [ ] P1-2 规则覆盖
- [ ] P1-3 规则变更后重跑（两 run 共存）
- [ ] P1-4 取消覆盖（状态回退）
- [ ] P1-5 年月选择边界（2017/2027）
- [ ] P1-6 并发保护（运算中再点）
- [ ] P1-7 child process 意外退出（DB rollback）
- [ ] P1-8 表头字体（Courier New）

## 不测项

- CSV 导入（明确不做）
- PDF 导入（明确不做）
- 单月差异 >105 万行（业务承诺不超）
- 规则导出/导入（v2.0.0 不做）
- 历史差异 record 的手动清理 UI（不做，用户可直接删 DB 文件）

## 资金敏感红线单测

**必须在 Task 7（对账 engine）完成前补自动化脚本**：

```js
// scripts/test-v2.0.0-reconcile.js 样例
const upperRows = [
  { order_no: 'A001', 金额: '100', 币种: 'USD', pending资金类型: '充值' },
  { order_no: 'A002', 金额: '200', 币种: 'CNY', pending资金类型: '提现' },
  ...
];
const lowerRows = [
  { order_no: 'A001', 金额: '100', 币种: 'USD', pending资金类型: '充值' },  // unchanged
  { order_no: 'A002', 金额: '250', 币种: 'CNY', pending资金类型: '提现' },  // changed 金额
  { order_no: 'A003', 金额: '50',  币种: 'HKD', pending资金类型: '退票' },  // new
];
const rule = { matchFields: ['order_no'], compareFields: ['金额', '币种'] };

// 跑后预期:
// diff_rows 有 3 条
// 1× type=changed (upper_id=A002, lower_id=A002 diff on 金额)
// 1× type=new    (lower_id=A003)
// 1× type=missing (upper 只有 A001/A002 → A001 unchanged → no missing 其实)
// ^ 自检一下数据集构造
```

## 变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-04-23 | 初建，覆盖 PRD §六/§七 全部 |
