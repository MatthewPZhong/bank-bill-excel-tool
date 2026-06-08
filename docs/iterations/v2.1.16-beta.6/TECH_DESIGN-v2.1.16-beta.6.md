# TECH DESIGN — v2.1.16-beta.6

> 配套 [PRD-v2.1.16-beta.6.md](./PRD-v2.1.16-beta.6.md)。三需求：A 导出按钮互斥 / B 预加工导出双 sheet 重构 / C 退款回填全链路开通。
> 原则：**最大化复用现成、最小化改动**。需求 C 引擎/writer 零改。

---

## 需求 A（问题 4）：导出按钮 mode 互斥

### 落点
- `src/renderer.js`：新增 helper `updateBankStatementExportButtonsDisabled()`；在两条路径调用。

### 设计
```js
// 抽成 helper，使「导入对账单成功」(updateBankStatementUi) 与「导入不平表成功」(4109 路径) 都能刷新
function updateBankStatementExportButtonsDisabled() {
  const isGateway = state.bankStatementProcessRunMode === 'gateway';
  // 预加工组导出：仅 bank 模式 + 已有处理结果可点
  if (elements.bankStatementExportBtn) {
    elements.bankStatementExportBtn.disabled = isGateway || !state.processingResult;
  }
  // 不平表组导出：仅 gateway 模式 + reconIdFixSession 就位可点
  if (elements.bankStatementGatewayReconExportBtn) {
    elements.bankStatementGatewayReconExportBtn.disabled = !isGateway || !state.reconIdFixSession;
  }
}
```

### 改动点
1. `updateBankStatementUi()`（`renderer.js:3412`）：把 `bankStatementExportBtn.disabled = !pr` 一行**替换**为 `updateBankStatementExportButtonsDisabled()`。
2. 导入不平表成功路径（`renderer.js:4109` `updateBankStatementRunBtnDisabled()` 之后）：补一行 `updateBankStatementExportButtonsDisabled()`。

### 验证
- AC A-1~A-4（PRD §2.3）。helper 是纯 DOM 赋值，单测价值低 → 以手测 + preview 为主。

---

## 需求 B（问题 3）：预加工导出双 sheet 重构

### 链路
`main.js bank-statement:export`（`:3722` 调 `writeBankStatementMainOutput`）→ `bank-statement-io.js:227 writeBankStatementMainOutput`（透传）→ **`exceljs-writer.js:76 writeBankStatementOutput`（核心重构点）**。

### 数据源（现成，引擎不动）
- `modifiedRows`（命中行，带 `_rowId` / `_modifiedColumns` / `_hitScenarioName`）
- `unmatchedRows`（未命中行）
- `modifications: Array<{ rowId, column, oldValue, newValue, scenarioId, scenarioName }>` ← **命中明细列数据源，需新透传到 writer**

### 改动 1：透传 modifications 到 writer
- `main.js:3722` 调用处：给 `writeBankStatementMainOutput({...})` 入参补 `modifications`（从 `processingResult.modifications` 取）。
- `bank-statement-io.js:227 writeBankStatementMainOutput`：签名加 `modifications`，转传给 `writeBankStatementOutput`。

### 改动 2：`writeBankStatementOutput` 双 sheet 重构（exceljs-writer.js）
新签名：`writeBankStatementOutput(modifiedRows, headers, savePath, unmatchedRows, modifications)`

```
// ===== sheet1「未命中场景」=====
const s1 = workbook.addWorksheet('未命中场景');
s1.getCell('A1').value = '请检查，导入前请删除该sheet';
s1.getCell('A1').font = { bold: true };
// 第 2 行起：FundType='Mark without result' 行优先，再其他未命中行
const MARK = 'Mark without result';
const sorted = [
  ...unmatchedRows.filter(r => normalizeCell(r['FundType']) === MARK),
  ...unmatchedRows.filter(r => normalizeCell(r['FundType']) !== MARK),
];
// 第 2 行表头、第 3 行起数据（B-Q1 已定加表头）
writeHeaderRow(s1, headers, { row: 2 });
writeDataRows(s1, headers, sorted, { startRow: 3 });

// ===== sheet2「命中场景」=====
const s2 = workbook.addWorksheet('命中场景');
// 第一列插「命中明细」，其后为原 headers；命中行保留标黄
const modByRow = groupBy(modifications, m => m.rowId); // Map<rowId, mods[]>
const HIT_HEADERS = ['命中明细', ...headers];
writeHeaderRow(s2, HIT_HEADERS);
for (const row of modifiedRows) {
  const mods = modByRow.get(row._rowId) || [];
  const detail = mods.map(m =>
    `<命中场景:"${m.scenarioName}";"${m.column}";变更前:"${m.oldValue}";变更后:"${m.newValue}">`
  ).join('\n'); // 换行分隔（B-Q2 已定）
  const cells = [detail, ...headers.map(h => row[h])];
  const r = s2.addRow(cells);
  r.getCell(1).alignment = { wrapText: true, vertical: 'top' }; // 命中明细列单元格多行换行显示
  applyYellowFill(r); // 保留原标黄（D5 决策）
}
```

> ⚠️ 沿用现有 `exceljs-writer` 的标黄/列宽/原子写范式（`exceljs-writer.js:79-120`），只改 sheet 名/顺序/排序/新增命中明细列。空数组边界（全命中/全未命中）须仍输出含 A1 提示/表头的空 sheet（AC B-5）。

### 验证（单测 `tests/unit/`，可测性高）
- A1 提示文本 + 加粗
- FundType='Mark without result' 排序在前
- 命中明细多段拼接（同 rowId 多 mods → N 段，格式精确）
- sheet 名「未命中场景」/「命中场景」、命中明细为第一列
- 行数守恒（sheet1+sheet2 = 总行数）
- 空边界不报错

---

## 需求 C（问题 5）：退款回填全链路开通（引擎/writer 零改）

### P0-1 + P0-2：开门控 + 退款导入落 session
落点 `main.js:11459`（退款分支，现双重 disabled）：

```js
if (tableKey === 'zhongtai-refund-order') {
  // 删除 ZHONGTAI_REFUND_BATCH_ENABLED 门控判断（main.js:11305 常量一并移除或置 true）
  const rows = readRefundOrderRows(filePath, signature, detected.sheetName); // 仿 readLinkedRowsAsObjects/readBankStatement 读 25 列对象数组
  refundOrderSession = { fileName, rows, importedAt: new Date().toISOString() }; // main.js:295
  results.push({ fileName, tableKey, status: 'ok', rowCount: rows.length });
  continue;
}
```

- **读取函数**：退款订单是 PREPROCESS 表（25 列，`ZHONGTAI_REFUND_ORDER_SIGNATURE`）。dev 实现 `readRefundOrderRows`（仿 `readLinkedRowsAsObjects` 的 detector zip 范式），返回字段名=真实表头的对象数组。
- **session 结构**：`{ fileName, rows, importedAt }`，与引擎入参口径对齐（`main.js:3608` `refundOrderSession.rows`）。
- **重导覆盖**：再次导入退款表整体覆盖 `refundOrderSession`（与对账单合并语义不同；退款单是独立数据源，覆盖即可）。

### P0-3：解引擎/导出硬桩
- `main.js:3608`：删 `// 本轮恒 []` 注释，逻辑 `refundOrderSession ? structuredClone(refundOrderSession.rows) : []` **已正确**（refundOrderSession 非 null 时自然注入）→ 实际无需改代码，仅验证。
- `main.js:3618` `refundContext` + `:3607 depositRows`（入金表，JPM-US 用）已就绪。
- 导出 `main.js:3786` block：`refundBackfillRows` 非空自然进入 `writeRefundBackfillOutput`。

### P0-4：前端导入提醒框（renderer.js）
落点 `handleBankStatementBatchImport`（`renderer.js:3537` 弹完批量明细之后）：

```js
// 启用退款回填场景 + 本批未导入退款表 → 弹提醒
async function shouldPromptRefundOrderImport(results) {
  const list = await window.desktopApi.scenarios.list();
  const scenarios = (list && list.status === 'ok' && Array.isArray(list.scenarios)) ? list.scenarios : [];
  const enabled = scenarios.some(s =>
    s.config && s.config.subCategory === 'refund-order-backfill' && (s.enabled === 1 || s.enabled === true));
  if (!enabled) return false;
  const hasRefundOk = (results || []).some(r => r.tableKey === 'zhongtai-refund-order' && r.status === 'ok');
  return !hasRefundOk;
}
// 调用：弹完 buildBatchImportSummaryHtml 明细后
if (await shouldPromptRefundOrderImport(results)) {
  openModal(createAlertDialog('已启用「中台退款订单回填」场景，但本次未导入「中台退款订单表」。请补充导入后再运行。'));
}
```
> 范式参考 `maybePromptGatewayReconImport`（`renderer.js:3547`）。判定场景启用凭 `config.subCategory === 'refund-order-backfill'`（与 `migrations.js:1538` seed 对齐）。

### 验证
- 单测：`shouldPromptRefundOrderImport` 判定矩阵（启用×带表/不带表）；退款分支落 session（门控开）。
- 集成（`scripts/integration/`）：导入退款表+银行对账单 → run → `backfillRows` + 导出双 sheet 校验。
- 手测（🔴 资金红线，记入待测清单）：四基数 + JPM HK/US + 提醒框 C-1~C-3（PRD §八）。

---

## PR 拆分（文件清单）

| PR | 需求 | 文件 | 测试 |
|----|------|------|------|
| **PR-1** | A | `renderer.js`（helper + 2 调用点） | 手测 + preview |
| **PR-2** | B | `exceljs-writer.js`（双 sheet 重构）、`bank-statement-io.js`（透传 modifications）、`main.js`（export handler 传 modifications，⚠️NUL 须 `-a`） | `tests/unit/` writer 双 sheet |
| **PR-3** | C | `main.js`（11305 门控移除 + 11459 退款落 session + readRefundOrderRows，⚠️NUL）、`renderer.js`（P0-4 提醒框） | unit 提醒判定 + 落 session；integration 端到端 |
| **收尾** | 版本 | `package.json` / `package-lock.json` bump 2.1.16-beta.6；`/check-vars` + `npm run scan:vars` | `release-check` |

PR 顺序：PR-1 → PR-2 → PR-3（PR-2/PR-3 都动 `main.js`，串行避免冲突）。

---

## 重要变量 check（bump / 合并前必跑 `/check-vars`）

| 变量 | 层级 | 本迭代涉及 | review 要点 |
|------|------|-----------|------------|
| `bankStatementProcessRunMode` | Runtime-state | 需求 A | 互斥 disabled 与路由 mode 一致，不串引擎 |
| `refundOrderSession` | Runtime-state | 需求 C | 落 session / 注入引擎 / 重导覆盖；恒空硬桩解除后真实数据入引擎 |
| `modifications` | Risk-sensitive | 需求 B | 命中明细数据源，逐条对应改前/改后，不漏不串行 |
| `ZHONGTAI_REFUND_BATCH_ENABLED` | Risk-sensitive | 需求 C | 门控移除后退款通路打开，确认无其它依赖此常量 |

---

## 风险（🔴 资金红线，见 PRD §六）

- 需求 C 开通后真实退款数据首次入引擎（状态机 `SUBMITTED→SUCCESS` + 对账 ID 回填）→ **必须**四基数 + JPM 双分支手测 + `release-check` 全绿才合并。
- 需求 B 改对账主产物 sheet 名/结构 → 确认无下游依赖旧 sheet 名「渠道对账单」「未命中场景行」。
- 需求 A/C 动 renderer.js → 提 PR 前重跑 `npm run preview`。
