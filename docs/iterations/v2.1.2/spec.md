# spec — v2.1.2 实施规格

| 字段 | 值 |
|---|---|
| 文档版本 | v0.9（2026-05-13 OPEN ISSUE #5 重新拍板：BU 比较加大小写归一化；normalize 拆为 normalizeKey/normalizeBu） |
| 关联 PRD | `PRD-v2.1.2.md`（OPEN ISSUE 已 close 全部 10 项） |
| 关联 tasks | `tasks.md`（待生成） |
| 工作分支 | `v2.1.2` |
| 起草人 | team-lead |

---

## 一、本规格的边界

- **T1**：仅 `createScenarioConfigDialogC4`（renderer-dialogs.js 内 line 6711 起）的 UI 文案 + 错误消息 + 确认弹窗文案。**不动** C1/C2/C3 dialog 同名文案。
- **T2**：完全独立的新模块「月度银行对账单BU回填校验」。架构骨架参照 Pending 模块（v2.0.0），但 schema / IPC / writer 全部独立。

---

## 二、T1 — C4 dialog 文案变更（精确清单）

### 2.1 文案替换映射

| 原文案 | 新文案 |
|---|---|
| 账单类型 | 对账字段 |
| 对账字段 | 对账内容 |
| + 新增账单类型 | + 新增对账字段 |
| + 新增对账分组 | + 新增对账内容分组 |
| 对账字段分组 #N | 对账内容分组 #N |

### 2.2 精确变更点（20 处，行号已 grep 验证 0 漂移）

文件：`src/renderer-dialogs.js`

| 行号 | 类型 | 当前内容（节选） | 变更后内容 |
|---|---|---|---|
| 5868 | 错误消息 | `'账单类型至少需要 1 行'` | `'对账字段至少需要 1 行'` |
| 5872 | 错误消息 | `` `账单类型 #${...} 的"主/从"必填` `` | `` `对账字段 #${...} 的"主/从"必填` `` |
| 5876 | 错误消息 | `` `账单类型 #${...} 至少需要 1 个条件` `` | `` `对账字段 #${...} 至少需要 1 个条件` `` |
| 5878 | 错误消息 | `` `账单类型 #${...} 每行的字段不能为空...` `` | `` `对账字段 #${...} 每行的字段不能为空...` `` |
| 5887 | 错误消息 | `'账单类型必须至少包含 1 条"主边"账单类型'` | `'对账字段必须至少包含 1 条"主边"对账字段'` |
| 5888 | 错误消息 | `'账单类型必须至少包含 1 条"从边"账单类型'` | `'对账字段必须至少包含 1 条"从边"对账字段'` |
| 5896 | 错误消息 | `'对账字段至少需要 1 个分组'` | `'对账内容至少需要 1 个分组'` |
| 5899 | 错误消息变量 | `` `对账字段分组 #${gIdx + 1}` `` | `` `对账内容分组 #${gIdx + 1}` `` |
| 5918 | 错误消息变量 | `` `对账字段分组 #${gIdx + 1}` `` | `` `对账内容分组 #${gIdx + 1}` `` |
| 5922 | 错误消息 | `` `${grpLabel} 左侧的账单类型序号 #${...} 不在账单类型列表中` `` | `` `${grpLabel} 左侧的对账字段序号 #${...} 不在对账字段列表中` `` |
| 5924 | 错误消息 | `` `${grpLabel} 左侧必须指向"主边"账单类型` `` | `` `${grpLabel} 左侧必须指向"主边"对账字段` `` |
| 5927 | 错误消息 | `` `${grpLabel} 右侧的账单类型序号 #${...} 不在账单类型列表中` `` | `` `${grpLabel} 右侧的对账字段序号 #${...} 不在对账字段列表中` `` |
| 5929 | 错误消息 | `` `${grpLabel} 右侧必须指向"从边"账单类型` `` | `` `${grpLabel} 右侧必须指向"从边"对账字段` `` |
| 6867 | dialog label | `<span class="scenario-config-label">账单类型</span>` | `<span class="scenario-config-label">对账字段</span>` |
| 6870 | 按钮文案 | `>+ 新增账单类型</button>` | `>+ 新增对账字段</button>` |
| 6874 | dialog label | `<span class="scenario-config-label">对账字段</span>` | `<span class="scenario-config-label">对账内容</span>` |
| 6877 | 按钮文案 | `>+ 新增对账分组</button>` | `>+ 新增对账内容分组</button>` |
| 7420 | 确认弹窗 label | `<span class="...-label">账单类型：</span>` | `<span class="...-label">对账字段：</span>` |
| 7421 | 确认弹窗 label | `<span class="...-label">对账字段：</span>` | `<span class="...-label">对账内容：</span>` |
| 7425 | 确认弹窗 label | `<span class="...-label">对账字段（AND）：</span>` | `<span class="...-label">对账内容（AND）：</span>` |
| 7443 | 确认弹窗 label | `<span class="...-label">账单类型：</span>` | `<span class="...-label">对账字段：</span>` |
| 7458 | 确认弹窗 label | `<span class="...-label">对账字段：</span>` | `<span class="...-label">对账内容：</span>` |

实际是 22 个变更点（PRD §三表里合并了行 5876 → 5878 ，spec 阶段拆开列）。

### 2.3 代码注释同步（顺手改，不强制）

| 行号 | 当前注释 | 建议改成 |
|---|---|---|
| 7138 | `// 行 3：账单类型动态行` | `// 行 3：对账字段动态行（内部变量名 billTypes 保留）` |
| 7237 | `// 行 4：对账字段（reconGroups[] — 每个 group 内 AND；多个 group OR）` | `// 行 4：对账内容（reconGroups[] — 每个 group 内 AND；多个 group OR；内部变量名 reconGroups 保留）` |

### 2.4 不改的内容（防误伤）

⚠️ **以下 6 处 `账单类型 / 对账字段` 文案不在 T1 范围内**，实施时**不动**：

| 行号 | dialog | 文案 |
|---|---|---|
| 6014 | C1 (`createScenarioConfigDialogC1`) | `<span class="scenario-config-label">对账字段</span>` |
| 6017 | C1 | `>+ 新增对账字段</button>` |
| 6494 | C2 (`createScenarioConfigDialogC2`) | `账单类型` label + tooltip |
| 6497 | C2 | `>+ 新增账单类型</button>` |
| 6501 | C2 | `<span class="scenario-config-label">对账字段</span>` |
| 6504 | C2 | `>+ 新增对账字段</button>` |

还有 line 5830-5844（C1/C2 错误消息）也不动。

### 2.5 内部变量名保持原样

代码层保持以下符号不变：`billTypes` / `reconFields` / `reconGroups` / `billTypeSeqs` / `data-action="add-bill-type"` / `data-action="add-recon-field"` / `data-c4-action="add-bill-type"` / `data-c4-action="add-recon-group"` / `data-c4-bill-types` / `data-c4-recon-groups`。

### 2.6 T1 验收

- preview 重跑 4 张 C4 dialog 截图（business / gateway / 1vN / 主从都修复）
- C1/C2 dialog 视觉不变（preview 也跑一遍兜底）
- 触发各种校验错误：错误消息文案全部使用新版

---

## 三、T2 — 新模块「月度银行对账单BU回填校验」技术规格

### 3.1 模板文件（git 入库）

| 模板 | 路径 | Sheet 名 | 列数 | 关键列 |
|---|---|---|---|---|
| Pending 数据管理 | `assets/Pending数据管理.xlsx` | `sheet` | 20 | `主对账单号`（第 9 列，匹配 key）/ `财务BU`（第 6 列，差异字段） |
| 银行对账单 | `assets/银行对账单.xlsx` | `渠道对账单` | 44 | `ReconciliationId`（第 12 列，匹配 key）/ `Remark-BU`（第 29 列，差异字段） |

**读取规则**：按文件的**第一个 sheet**读取（不 hardcode sheet 名 — Pending 用 `sheet`，银行对账单用 `渠道对账单`，命名习惯不统一），表头取第 1 行，数据从第 2 行起。

### 3.2 完整列定义

#### 3.2.1 Pending 数据管理（20 列）

```
[1] PendingBizId            [2] 账单日期           [3] pending类型
[4] 资金类型                [5] 主体              [6] 财务BU          ★ 差异字段
[7] 业务部门                [8] 对手部门           [9] 主对账单号       ★ 匹配 key
[10] 渠道                  [11] 大账号           [12] 金额
[13] 币种                  [14] 银行账期         [15] 平账账期
[16] 备注                  [17] 状态             [18] 更新时间
[19] 操作人                [20] 财务BU修复标记
```

#### 3.2.2 银行对账单（44 列，节选关键）

```
[1]  账户主体          [2]  账户BU            [3]  BizId
[4]  BillDate         [5]  ValueDate         [6]  Channel
[7]  地区             [8]  MerchantId         [9]  Currency
[10] Credit Amount    [11] Debit Amount      [12] ReconciliationId    ★ 匹配 key
[13] ChannelOrderNo   [14] CustomerRef        [15] Account Reference
[16] Transaction Description ... [28] Datasource
[29] Remark-BU         ★ 差异字段
[30-44] 回填方式 / 关联大账号 / ... / 拆分信息
```

完整 44 列名见 `src/main-process/exceljs-writer.js` 对应的 `银行对账单` schema（v2.0.0 GA 已使用）。**注意 T2 模块只读不写银行对账单原表头，差异表里 44 列原样输出。**

### 3.3 文件组织（参照 Pending 模块结构）

```
src/
├── main-process/
│   ├── bank-bu-recon-session.js        # session 层（spawn worker + 事件路由 + 留底）
│   └── bank-bu-recon-writer.js         # exceljs 差异表 writer（整行黄底）
├── backend/
│   ├── bank-bu-recon-db/
│   │   ├── migrations.js               # 2 张表 schema
│   │   ├── columns.js                  # 模板列定义（PENDING_GUANLI_COLUMNS / BANK_STATEMENT_COLUMNS）
│   │   ├── month-repository.js         # 按月份 CRUD
│   │   └── run-repository.js           # 运行历史 CRUD
│   └── bank-bu-recon-import/
│       ├── reader.js                   # SheetJS 读 + 表头校验
│       └── validator.js                # 表头匹配 + 异常上报
```

⚠️ **是否独立 SQLite DB 文件还是放主 DB（`tool-data.sqlite`）？** 建议放主 DB（spec 阶段倾向）：
- Pending 模块用独立 DB 是因为单月百万行数据量
- T2 一个月通常 < 10w 行（财务月度对账规模），主 DB 完全够用
- 独立 DB 增加备份 / 迁移复杂度

### 3.4 SQLite Schema（放 `tool-data.sqlite`）

#### 3.4.1 表 1：`bank_bu_recon_pending_imports`

```sql
CREATE TABLE IF NOT EXISTS bank_bu_recon_pending_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year_month TEXT NOT NULL,             -- 'YYYY-MM'
  row_index INTEGER NOT NULL,           -- Excel 原行号（从 2 起，对应数据第 1 行）
  -- 20 列 Pending 数据管理（按表头顺序，列名映射见 columns.js）
  pending_biz_id TEXT,
  bill_date TEXT,
  pending_type TEXT,
  fund_type TEXT,
  entity TEXT,
  finance_bu TEXT,                      -- ★ 差异字段
  biz_dept TEXT,
  counter_dept TEXT,
  recon_id TEXT,                        -- ★ 匹配 key（"主对账单号"）
  channel TEXT,
  account_no TEXT,
  amount TEXT,
  currency TEXT,
  bank_period TEXT,
  balance_period TEXT,
  remark TEXT,
  status TEXT,
  update_time TEXT,
  operator TEXT,
  bu_fix_flag TEXT,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bbr_pending_month ON bank_bu_recon_pending_imports(year_month);
CREATE INDEX IF NOT EXISTS idx_bbr_pending_reconid ON bank_bu_recon_pending_imports(year_month, recon_id);
```

#### 3.4.2 表 2：`bank_bu_recon_bank_imports`

```sql
CREATE TABLE IF NOT EXISTS bank_bu_recon_bank_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year_month TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  -- 44 列银行对账单（列名映射见 columns.js）
  account_entity TEXT,
  account_bu TEXT,
  biz_id TEXT,
  bill_date TEXT,
  value_date TEXT,
  channel TEXT,
  region TEXT,
  merchant_id TEXT,
  currency TEXT,
  credit_amount TEXT,
  debit_amount TEXT,
  reconciliation_id TEXT,               -- ★ 匹配 key
  channel_order_no TEXT,
  customer_ref TEXT,
  account_reference TEXT,
  transaction_description TEXT,
  extra_information TEXT,
  payment_detail TEXT,
  payee_name TEXT,
  payee_card_no TEXT,
  drawee_name TEXT,
  drawee_card_no TEXT,
  by_order_of_beneficiary TEXT,
  extra_fee TEXT,
  trade_channel TEXT,
  fund_type TEXT,
  remark_description TEXT,
  datasource TEXT,
  remark_bu TEXT,                       -- ★ 差异字段
  fill_method TEXT,
  related_account TEXT,
  auto_category_rule TEXT,
  categorized_by TEXT,
  clearing_network TEXT,
  last_modified_time TEXT,
  recon_amount TEXT,
  origin_bill_id TEXT,
  fx_channel TEXT,
  fx_recon_id TEXT,
  buy_currency TEXT,
  buy_amount TEXT,
  sell_currency TEXT,
  sell_amount TEXT,
  split_info TEXT,
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_bbr_bank_month ON bank_bu_recon_bank_imports(year_month);
CREATE INDEX IF NOT EXISTS idx_bbr_bank_reconid ON bank_bu_recon_bank_imports(year_month, reconciliation_id);
```

#### 3.4.3 表 3：`bank_bu_recon_runs`

```sql
CREATE TABLE IF NOT EXISTS bank_bu_recon_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year_month TEXT NOT NULL,
  run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL,                 -- 'success' / 'failed_anomaly'
  pending_total INTEGER NOT NULL,
  bank_total INTEGER NOT NULL,
  matched_count INTEGER NOT NULL,       -- 1:1 对账成功数
  bu_diff_count INTEGER NOT NULL,
  pending_unmatched INTEGER NOT NULL,
  bank_unmatched INTEGER NOT NULL,
  anomaly_count INTEGER NOT NULL DEFAULT 0,
  anomaly_report_path TEXT,             -- 异常报告文件路径（status=failed_anomaly 才有）
  export_path TEXT                      -- 差异表导出路径
);

CREATE INDEX IF NOT EXISTS idx_bbr_runs_month ON bank_bu_recon_runs(year_month, run_at DESC);
```

### 3.5 IPC handler 命名（参照 `pending:*` 风格）

| handler | 入参 | 出参 | 说明 |
|---|---|---|---|
| `bankBuRecon:months:list` | — | `[{yearMonth, hasPending, hasBank, hasRun, ...}]` | 已导入的月份列表（Pending/银行对账单各自计数） |
| `bankBuRecon:import:pick-month` | — | `{yearMonth}` 或 `null` | 弹月份选择对话框（参照 `pending:import:pick-files`） |
| ~~`bankBuRecon:import:pick-files`~~ | — | — | **v0.4 删除** — 拆为下两条独立单选 IPC，前端用 Clear 风 modal 串联 |
| `bankBuRecon:import:pick-pending-file` | `{yearMonth}` | `{status, filePath}` | 单选 Pending 数据管理文件，触发前前端会先弹 `createBankBuReconFileImportPromptDialog` 提示用户用途 |
| `bankBuRecon:import:pick-bank-file` | `{yearMonth}` | `{status, filePath}` | 单选银行对账单文件，触发前同上 |
| `bankBuRecon:import:run` | `{yearMonth, pendingPath, bankPath}` | `{pendingCount, bankCount, errors}` | 后台导入解析 + 表头校验 + 入 SQLite |
| `bankBuRecon:run` | `{yearMonth}` | `{runId, status, stats}` 或 `{status:'failed_anomaly', anomalies, reportPath}` | 后台执行对账（**严格 1:1**） |
| ~~`bankBuRecon:export`~~ | — | — | **v0.5 删除** — 拆为下两条 |
| `bankBuRecon:export:single` | `{runId, savePath}` | `{status, filePath}` | 单月差异表导出到用户指定路径（另存为对话框结果） |
| `bankBuRecon:export:aggregate` | `{savePath}` | `{status, filePath, skippedMonths}` | 跨月汇总导出（每月最新 success run，单 xlsx 2 sheet 加「对账月份」列）；skippedMonths 用于前端 alert 提示 |
| `bankBuRecon:export:pick-save-path` | `{defaultFileName}` | `{status, savePath}` | 弹另存为对话框（dialog.showSaveDialog） |
| `bankBuRecon:status` | `{yearMonth}` | `{stage, ...}` | 查询当前模块状态（用于按钮 enabled/disabled 判定） |
| `bankBuRecon:run:history` | `{yearMonth}` | `[runs]` | 单月运行记录 |
| `bankBuRecon:run:list-success-months` | — | `[{yearMonth, latestSuccessRunId}]` | 列出所有"有 status=success run"的月份（用于「导出差异」弹窗「指定月份」下拉） |
| `bankBuRecon:run:list-ready-months` | — | `[yearMonth]` | 列出所有"两侧都已导入"的月份（用于「开始运行」弹窗下拉） |

### 3.6 对账算法（核心，资金红线 — v0.8 重写）

```javascript
async function runReconciliation(yearMonth) {
  const db = getMainDb();
  const pendingRows = monthRepository.getPendingRows(db, yearMonth);
  const bankRows = monthRepository.getBankRows(db, yearMonth);

  // 步骤 1：构建索引
  const pendingByKey = new Map();
  const bankByKey = new Map();
  for (const r of pendingRows) {
    const key = normalizeKey(r.recon_id);
    if (!key) continue;
    if (!pendingByKey.has(key)) pendingByKey.set(key, []);
    pendingByKey.get(key).push(r);
  }
  for (const r of bankRows) {
    const key = normalize(r.reconciliation_id);
    if (!key) continue;
    if (!bankByKey.has(key)) bankByKey.set(key, []);
    bankByKey.get(key).push(r);
  }

  // 步骤 2：按 key 分类处理（4 路：1:1 / 1:N / N:1 / N:M）
  const matchedPending = [];   // 进入 Pending sheet 的行（按 1:1/1:N/N:1 顺序）
  const matchedBank = [];      // 进入 银行 sheet 的行
  const buDiffPendingIds = new Set();
  const buDiffBankIds = new Set();
  const nmAnomalies = [];      // N:M 异常组（写入「异常」sheet）

  // 收集所有 key（pendingByKey ∪ bankByKey）
  const allKeys = new Set([...pendingByKey.keys(), ...bankByKey.keys()]);

  for (const key of allKeys) {
    const P = pendingByKey.get(key) || [];
    const B = bankByKey.get(key) || [];
    if (P.length === 0 || B.length === 0) continue;  // 单侧未匹上对面

    if (P.length === 1 && B.length === 1) {
      // 1:1
      matchedPending.push(P[0]);
      matchedBank.push(B[0]);
      if (normalizeBu(P[0].finance_bu) !== normalizeBu(B[0].remark_bu)) {
        buDiffPendingIds.add(P[0].id);
        buDiffBankIds.add(B[0].id);
      }
    } else if (P.length === 1 && B.length >= 2) {
      // 1:N — Pending 行不标黄；银行行逐一比 BU，仅标黄不等的
      const pBu = normalizeBu(P[0].finance_bu);
      matchedPending.push(P[0]);
      for (const b of B) {
        matchedBank.push(b);
        if (normalizeBu(b.remark_bu) !== pBu) buDiffBankIds.add(b.id);
      }
    } else if (P.length >= 2 && B.length === 1) {
      // N:1 — 银行行不标黄；Pending 行逐一比 BU，仅标黄不等的
      const bBu = normalizeBu(B[0].remark_bu);
      matchedBank.push(B[0]);
      for (const p of P) {
        matchedPending.push(p);
        if (normalizeBu(p.finance_bu) !== bBu) buDiffPendingIds.add(p.id);
      }
    } else {
      // N:M（双侧 ≥2）— 整组跳过 BU 比较，加入异常 sheet
      nmAnomalies.push({
        key,
        pendingCount: P.length,
        bankCount: B.length,
        pendingRowIndices: P.map(r => r.row_index),
        bankRowIndices: B.map(r => r.row_index)
      });
    }
  }

  const stats = {
    pendingTotal: pendingRows.length,
    bankTotal: bankRows.length,
    matchedCount: matchedPending.length,
    buDiffCount: buDiffPendingIds.size + buDiffBankIds.size,  // 标黄行数
    pendingUnmatched: pendingRows.length - matchedPending.length - sumNMPending(nmAnomalies),
    bankUnmatched: bankRows.length - matchedBank.length - sumNMBank(nmAnomalies),
    nmAnomalyCount: nmAnomalies.length
  };

  return {
    status: 'success',  // v0.8: 永远 success（不再有 failed_anomaly）
    stats,
    matchedPending,
    matchedBank,
    buDiffPendingIds,
    buDiffBankIds,
    nmAnomalies
  };
}

function normalizeKey(v) {
  // v0.9: 对账单号匹配 — 仅 trim，不大小写归一（OPEN ISSUE #5 维持原 trim 语义）
  if (v == null) return '';
  return String(v).trim();
}

function normalizeBu(v) {
  // v0.9: BU 字段比较 — trim + toLowerCase（OPEN ISSUE #5 改 C 选项，容忍 BU 命名大小写差异）
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}
```

### 3.7 差异表 writer（exceljs — v0.8 加第 3 个「异常」sheet）

#### 3.7.1 单月差异表（Sheet 1 Pending + Sheet 2 银行 + Sheet 3 异常）

- Sheet 1 Pending：matchedPending 行（含 1:1 / 1:N 中的 P / N:1 中所有 P）；BU 差异行整行黄底
- Sheet 2 银行对账单：matchedBank 行（含 1:1 / 1:N 中所有 B / N:1 中的 B）；BU 差异行整行黄底
- **Sheet 3 异常**（v0.8 新增）：
  - 表头：`['对账单号', 'Pending 匹配数量', '银行匹配数量', 'Pending 行号', '银行对账单行号']`
  - 数据行：每个 N:M 异常组一行
  - 行号字段：用逗号拼接（如 `2, 5, 18`）
  - 字号 10pt + 表头加粗
- nmAnomalies.length === 0 时**仍生成 Sheet 3**（仅表头一行，便于用户预期一致）

#### 3.7.2 跨月汇总差异表（v0.5 + v0.8 新增异常列）

- Sheet 1 / Sheet 2：每行表头第 1 列「对账月份」+ 原 20/44 列；matched 跨月合并
- Sheet 3 异常：第 1 列「对账月份」+ 原异常 5 列；跨月异常组合并



```javascript
// src/main-process/bank-bu-recon-writer.js
const ExcelJS = require('exceljs');

const YELLOW_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };

async function writeDiffWorkbook({ yearMonth, runId, matchedPending, matchedBank, buDiffSet, savePath }) {
  const workbook = new ExcelJS.Workbook();

  // Sheet 1: Pending（20 列）
  const pendingSheet = workbook.addWorksheet('Pending');
  pendingSheet.addRow(PENDING_HEADERS);     // 20 列原表头
  pendingSheet.getRow(1).font = { bold: true, size: 10 };

  matchedPending.forEach((row, idx) => {
    const dataRow = pendingSheet.addRow(pendingRowToArray(row));
    if (buDiffSet.has(row.id)) {
      dataRow.eachCell((cell) => { cell.fill = YELLOW_FILL; });   // 整行黄底
    }
  });

  // Sheet 2: 银行对账单（44 列）
  const bankSheet = workbook.addWorksheet('银行对账单');
  bankSheet.addRow(BANK_HEADERS);
  bankSheet.getRow(1).font = { bold: true, size: 10 };

  matchedBank.forEach((row) => {
    const dataRow = bankSheet.addRow(bankRowToArray(row));
    if (buDiffSet.has(row.id)) {
      dataRow.eachCell((cell) => { cell.fill = YELLOW_FILL; });
    }
  });

  await workbook.xlsx.writeFile(savePath);
  return { filePath: savePath };
}
```

### 3.8 异常报告 — v0.8 已废弃

v0.4 设计的 `error-reports/...txt` 文件 + `createBankBuReconAnomalyDialog` 中断弹窗在 v0.8 全部废弃：
- 不再单独生成 .txt 报告文件
- N:M 异常直接写入差异表 Sheet 3「异常」（无需用户再开第 2 个文件）
- 状态栏告警 N:M 异常组数；不弹窗、不中断

session.js 中 `writeAnomalyReport` 函数 + main.js IPC `bankBuRecon:run` 返回 `failed_anomaly` 路径同步删除。
`bank_bu_recon_runs.status` 字段保留（schema 兼容），但实际值始终为 'success'。
`bank_bu_recon_runs.anomaly_count` 字段重新定义：N:M 异常组数（不再是中断异常数）。

### 3.9 Frontend UI 骨架

#### 3.9.1 HTML（`index.html` 新增 section）

⚠️ **v0.2 Reverse Sync 修正**：月份选择改回 PRD §3.2.5 数据流的对话框形态（点「导入文件」→ 弹月份对话框 → 弹 2 次文件选择对话框），面板**不**放月份 select。

⚠️ **v0.6 状态框初始文案修正**：与项目其他模块（statementModulePanel / bankStatementModulePanel）对齐，初始 `<span class="status-box-text">` 文本 = `欢迎使用小助手`；renderer.js 的 `restoreBankBuReconPanelState` 切模块时的初始 message + `setBankBuReconStatus.idleTitle` 同步。

```html
<section id="bankBuReconModulePanel" class="control-board module-panel pending-board" hidden>
  <div class="control-row">
    <div class="cell left"></div>
    <div class="cell right">
      <div class="pending-action-pair">
        <button id="bankBuReconImportBtn" class="primary-btn" type="button">导入文件</button>
        <button id="bankBuReconRunBtn" class="primary-btn" type="button" disabled>开始运行</button>
      </div>
    </div>
  </div>
  <div class="control-row">
    <div class="cell left">
      <button id="bankBuReconExportBtn" class="secondary-btn" type="button" disabled>导出差异</button>
    </div>
    <div class="cell right">
      <div id="bankBuReconStatusBox" class="status-box">
        <span class="status-spark" aria-hidden="true">...</span>
        <span class="status-box-text">点击「导入文件」开始（先选月份，再选两份源文件）</span>
      </div>
    </div>
  </div>
</section>
```

#### 3.9.2 状态机（renderer 侧 — v0.5 重写：3 个按钮各自独立弹窗）

**按钮 enable 条件**（v0.5 新设计 — 不再依赖 currentSessionMonth）：
- 「导入文件」：永远 enabled
- 「开始运行」：`readyMonths.length > 0`（至少 1 个月份两侧都已导入）
- 「导出差异」：`successMonths.length > 0`（至少 1 个 status=success 的月份运行记录）

切到本模块时：拉两个列表 → 同步按钮状态。
导入完成、运行完成、清空数据等事件后：重新拉列表 → 同步按钮状态。

**「导入文件」流程**（v0.4 维持不变）：
```
[弹月份对话框] → 选月份+下一步 → [弹 Pending 文件提示] → [弹文件选择] → [弹银行对账单文件提示] → [弹文件选择] → [import:run]
```

**「开始运行」流程**（v0.5 + v0.8：删 failed_anomaly 分支）：
```
[空闲] 
  ↓ 「开始运行」点击
[拉 ready-months → 弹 createBankBuReconReconcileDialog（单列月份下拉）]
  ↓ 选月份+完成（无二次确认）
[bankBuRecon:run({yearMonth})]
  ↓ status=success → 状态栏「{yearMonth} 对账完成: 成功 X 行/BU 差异 Y 行/Pending 未匹上银行 Z 行/银行未匹上 Pending W 行/N:M 异常 V 组」+ 重拉 successMonths → 「导出差异」按钮亮
  ↓ status=error（系统错误，非业务异常）→ 状态栏 error
```
v0.8 删除 `failed_anomaly` 分支（N:M 不再中断）。

**「导出差异」流程**（v0.5 新增）：
```
[空闲]
  ↓ 「导出差异」点击
[拉 success-months → 弹 createBankBuReconExportDialog（radio: single/aggregate + 月份下拉）]
  ↓ 选 radio + 月份 + 「导出」
[bankBuRecon:export:pick-save-path] → [拿 savePath]
  ↓ savePath != null
[radio=single → bankBuRecon:export:single({runId, savePath})]
[radio=aggregate → bankBuRecon:export:aggregate({savePath})]
  ↓ 成功 → 状态栏「差异表已生成: {filePath}」
  ↓ aggregate 有 skippedMonths → 弹 alert「汇总完成，N 个月份因数据异常未包含: XXX」
  ↓ 失败 → 状态栏 error
```

**月份选择对话框（createBankBuReconMonthPickerDialog）** — v0.4 拍板：
- **前端结构和样式参照** `src/renderer-pending.js#buildImportMonthDialog`（月度 Pending 数据核对模块的 month picker）
- 复用 class：`.pending-import-month-dialog` / `.pending-dialog-title` / `.monthly-balance-time-picker.pending-import-month-picker` / `.monthly-balance-year-select.mapping-text-input` / `.monthly-balance-month-select.mapping-text-input` / `.dialog-actions.center` / `.secondary-btn.small` / `.primary-btn.small`
- 标题：`选择对账月份`（与 PRD §3.2.5 对齐）
- **两个独立下拉**：年份（`YYYY 年`）+ 月份（`M 月`）横排
- **年份范围**：当前年 ± 1（OPEN ISSUE Q1 拍板，**与 Pending 模块的 current-9~current+1 不同**）
- **月份选项**：1 - 12（固定 12 项）
- **不显示元信息**（已导入计数 / 已运行次数）— Q2 拍板 = C
- **不显示「建议 T-1 月」推荐文字**
- **默认预选**：当前年 + 上个月（静默默认，跨年初自动回退到上年 12 月）
- **按钮**：「取消」(.secondary-btn.small) / 「下一步」(.primary-btn.small)，点击拿 `yearMonth = ${year}-${month_zfill2}` → onConfirm

**文件导入提示对话框（createBankBuReconFileImportPromptDialog）** — v0.4 新增：
- **Clear 风前端 modal**，复用 `.modal-card.alert-card` / `.alert-body` / `.alert-icon` (SVG 文档图标渐变) / `.alert-message` / `.dialog-actions.center` 结构
- 取代之前的 Electron `dialog.showMessageBox`（避免 macOS 系统对话框样式割裂）
- **入参**：`{ title, detail, onConfirm, onCancel }`
- **使用场景**（renderer 串联）：
  - 步骤 1 — `title='请导入 Pending 数据管理文件'` / `detail='接下来弹出的文件选择对话框中，请选择对应的 xlsx 文件（对账月份 ${yearMonth}）。'` / onConfirm → `desktopApi.bankBuRecon.pickPendingFile({yearMonth})`
  - 步骤 2 — `title='请导入银行对账单文件'` / `detail` 同上 / onConfirm → `desktopApi.bankBuRecon.pickBankFile({yearMonth})`
- **按钮**：「取消」/ 「继续选择」

**对账月份选择对话框（createBankBuReconReconcileDialog）** — v0.5 新增（「开始运行」弹窗）：
- 前端结构和样式参照 `src/renderer-pending.js#buildReconcileDialog`（月度 Pending 模块的对账弹窗）
- 复用 class：`.pending-reconcile-dialog` / `.pending-dialog-title` / `.pending-rule-columns` / `.pending-rule-column` / `.pending-rule-column-header` / `.mapping-text-input.pending-reconcile-month-select` / `.dialog-actions.center` / `.secondary-btn.small` / `.primary-btn.small`
- 业务差异（与 Pending 不同 — BU 回填是**单月对账**）：
  - 标题：`选取需要对账的月份`（去掉 Pending 的「Pending 数据」措辞）
  - **单列单选**（OPEN ISSUE Q1 拍板 A）：仅 1 个月份下拉（不是 Pending 的双月份）
  - 月份选项：**仅"两侧都已导入"的月份**（OPEN ISSUE Q2 拍板 A，来自 `bankBuRecon:run:list-ready-months`）
  - 默认预选：最新月份（list-ready-months 倒序取首项）
  - **不需要二次确认**（OPEN ISSUE Q6 拍板 A）：「完成」按钮直接触发 `bankBuRecon:run({yearMonth})`
- **入参**：`{ readyMonths, defaultMonth, onConfirm, onCancel }`
- **按钮**：「取消」/ 「完成」

**导出差异对话框（createBankBuReconExportDialog）** — v0.5 新增（「导出差异」弹窗），v0.6 样式微调：
- 前端结构和样式参照 `src/renderer-pending.js#buildExportDialog`（月度 Pending 模块的导出弹窗）
- 复用 class：`.pending-export-dialog` / `.pending-dialog-title` / `.pending-rule-row` / `.pending-rule-columns.pending-export-cols` / `.pending-rule-column` / `.mapping-text-input.pending-reconcile-month-select` / `.dialog-actions.center` / `.secondary-btn.small` / `.primary-btn.small`
- 标题：`导出差异`
- 两个 radio：
  - **「导出指定月份」**（默认 checked）+ 单列月份下拉
    - 月份来源：`bankBuRecon:run:list-success-months`（仅 status=success 月份）
    - **不显示 Run 下拉**（OPEN ISSUE Q5 拍板 A：自动用最新 success run）
  - **「导出所有月份汇总（每月取最新 success run）」**
- 选 radio 后下拉 enable/disable 联动（参照 Pending）
- **v0.6 月份下拉样式微调**（用户拍板，v0.7 Fix7b 修订）：
  - 月份下拉与上方 radio 间距 = `marginTop:14px`（拉开）
  - 月份下拉 wrapper `paddingLeft = radio宽16px + gap8px`（让 select 左边缘对齐 label「导」字）
  - **select 宽度 = labelWidth + 32px**（v0.7b 用户视觉偏好，原 v0.7 是 = labelWidth）：JS 测量 `radioSingleLabel.getBoundingClientRect().width`，加 `SELECT_RIGHT_EXTEND_PX = 32` 后强制设 `monthSelect.style.width`。视觉效果：select 左边缘对齐 label「导」字、右边缘超出 label「份」字 32px
  - `document.fonts.ready` 兜底字体异步加载场景，确保字体加载后 select 宽度 resync
- **按钮**：「取消」/ 「导出」
- 「导出」点击流程：
  - radio=single → 调 `bankBuRecon:export:pick-save-path({defaultFileName: '月度银行对账单BU回填校验_YYYYMM_HHMMSS.xlsx'})` → 拿 savePath → 调 `bankBuRecon:export:single({runId, savePath})`
  - radio=aggregate → 调 `bankBuRecon:export:pick-save-path({defaultFileName: '月度银行对账单BU回填校验_汇总_YYYY-MM-DD.xlsx'})` → 拿 savePath → 调 `bankBuRecon:export:aggregate({savePath})` → 后端返回 skippedMonths → 前端弹 `createAlertDialog` 提示「汇总完成，N 个月份因数据异常未包含：XXX」（OPEN ISSUE Q7 拍板 A）

**汇总导出 writer（writeAggregateDiffWorkbook）** — v0.5 新增：
- 单 xlsx + 2 sheet（Pending / 银行对账单），每行表头**额外插一列「对账月份」**（OPEN ISSUE Q3 拍板 A）
- 列顺序：`[对账月份, ...原 20/44 列]`
- BU 差异行整行黄底（与单月一致）
- 跨月数据按 `yearMonth ASC, row_index ASC` 排序
- 跳过 status≠success 月份，返回 `skippedMonths` 数组让前端 alert

### 3.10 主菜单/导航条目

参照现有 ReconID 修复模块入口（`src/renderer.js` 的 module switcher），在 `index.html` 主菜单加：

```html
<button class="nav-module-btn" data-module="bank-bu-recon">月度银行对账单BU回填校验</button>
```

### 3.11 模板表头校验逻辑

```javascript
function validatePendingGuanliHeaders(actualHeaders) {
  const expected = PENDING_GUANLI_HEADERS;   // 20 列常量
  if (actualHeaders.length !== expected.length) {
    return { ok: false, error: `Pending 数据管理列数应为 ${expected.length}，实际 ${actualHeaders.length}` };
  }
  for (let i = 0; i < expected.length; i++) {
    if (normalize(actualHeaders[i]) !== normalize(expected[i])) {
      return { ok: false, error: `第 ${i + 1} 列表头应为「${expected[i]}」，实际「${actualHeaders[i]}」` };
    }
  }
  return { ok: true };
}
// validateBankHeaders 同理
```

---

## 四、smoke 测试用例（新增 2 个）

`scripts/smoke-test.js` 末尾新增：

### 4.1 用例 A：全部 BU 一致（无差异）

- 构造 Pending 数据管理 5 行 + 银行对账单 5 行，主对账单号一一对应，财务BU 与 Remark-BU 完全相等
- 期望：运行 status='success'，bu_diff_count=0，差异表 2 sheet 各 5 行，**无黄底**

### 4.2 用例 B：部分 BU 差异

- 构造 5 行匹配，其中 2 行 BU 不等
- 期望：bu_diff_count=2，差异表 Pending sheet 5 行中 2 行黄底，银行 sheet 同步

### 4.3 用例 C（**资金红线**）：1:N 异常中断

- 构造 Pending 1 行 + 银行对账单同对账单号 3 行
- 期望：status='failed_anomaly'，anomaly_count=1，生成异常报告 .txt，差异表**不生成**

### 4.4 用例 D（**资金红线**）：N:1 异常中断

- 构造 Pending 2 行同对账单号 + 银行对账单 1 行
- 期望：status='failed_anomaly'，anomaly_count=1

---

## 五、preview 入口（新增 4 处）

参照 `scripts/preview-account.js` 风格，新增 `scripts/preview-bank-bu-recon.js`：

| 场景 | 截图 |
|---|---|
| 初始（无月份） | `assets/preview-bank-bu-recon-initial.png` |
| 导入中 | `assets/preview-bank-bu-recon-importing.png` |
| 差异结果 | `assets/preview-bank-bu-recon-result.png` |
| 异常中断 | `assets/preview-bank-bu-recon-anomaly.png` |

`package.json` 新增 script：`"preview:bank-bu-recon": "node scripts/preview-bank-bu-recon.js"`

按 memory `workflow_frontend_previews`：前端 PR 前必须重跑这 4 张 preview。

---

## 六、版本号 + 三件套

- `package.json.version` 2.1.1 → 2.1.2
- `CHANGELOG.md`：v2.1.2 段落 + T1 + T2 两块
- `docs/VERSION_FEATURE_HISTORY.md`：v2.1.2 行
- `docs/USER_GUIDE.md`：新增「月度银行对账单BU回填校验」章节（参照 Pending 模块章节风格）

---

## 七、重要变量升格评估（memory `workflow_important_vars_check`）

T2 新增的以下符号，spec 阶段评估是否升级进 `rules/important-variables.md`：

| 符号 | 层级建议 | 理由 |
|---|---|---|
| `runReconciliation` (函数) | Risk-sensitive | 资金红线对账核心 |
| `normalize` (BU 比较 helper) | Important-skeleton | 影响差异判定语义 |
| `bank_bu_recon_runs.status` (字段) | Risk-sensitive | success / failed_anomaly 状态机 |
| `YELLOW_FILL` (常量) | Minor | 已在 exceljs-writer.js 存在，复用 |
| `PENDING_GUANLI_HEADERS` (常量) | Important-skeleton | 模板表头校验 anchor |
| `BANK_HEADERS` (常量) | Important-skeleton | 模板表头校验 anchor |

实施完成后执行 `npm run scan:vars` 重新生成统计，确认新符号的跨文件引用度。

---

## 八、风险与红线提醒

⚠️ **资金红线**：
- T2 对账逻辑（§3.6）— 严格 1:1 匹配，任何异常立即中断
- BU 比较语义（§3.6 normalize）— trim + 空值归一，不大小写归一
- 异常报告文件落盘 — 必须包含足够上下文（行号 + 对账单号），便于用户回溯源 Excel

⚠️ **不破坏 Pending 模块**：
- T2 共用 `tool-data.sqlite`，但表名前缀 `bank_bu_recon_*`，与 Pending 模块的独立 DB（pending-*）不冲突
- T2 IPC 命名空间 `bankBuRecon:*`，与 Pending 模块 `pending:*` 完全独立
- T2 模板文件 `assets/Pending数据管理.xlsx` ≠ Pending 模块的 `assets/Pending.xlsx`（不同文件，不同列数）

⚠️ **PR review 关注点**：
- 资金红线对账逻辑必须人工 smoke 复核（不能只看 npm run smoke 通过）
- 任何对 1:1 严格规则的"宽松化"修改都需要资金红线审查

---

## 九、未决议题（spec → 实施阶段补全）

1. **银行对账单 44 列的英文 ↔ snake_case 列名映射**（§3.4.2 已给方案，但 BillDate / ValueDate 类驼峰列名建议在 `columns.js` 落最终对照表）
2. ~~月份选择对话框的 UX~~ — ✅ **v0.2 拍板**：改回 PRD §3.2.5 对话框形态（新建轻量 `createBankBuReconMonthPickerDialog`），不复用 Pending 模块 dialog，面板不放下拉框
3. **异常弹窗 UI 实现**：是否复用现有 `recon-id-fix` 模块的 batch-error dialog？还是新建？建议**复用** → 实施时**自建**（基于 `createBankBuReconAnomalyDialog`，含异常类型/对账单号/双侧行号 4 列表格 + 「打开错误报告」按钮）
4. **「导出差异」时选目录**：是否给用户选导出目录？还是固定到 `Documents/网银账单生成小助手/exports/{date}/`？建议**固定**（与其他模块一致） → 实施时**固定**
