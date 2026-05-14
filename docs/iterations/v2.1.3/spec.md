# spec — v2.1.3 实施规格

| 字段 | 值 |
|---|---|
| 文档版本 | v0.10.1（2026-05-14 round 5 self-review 修订：Codex 自动 review 1 P3 — 5 处归档文档残留 "17 IPC trackedIpcHandle" 口径与 round 3 实际收口的 "15 IPC = 5 tracked + 10 plain" 不符 → CHANGELOG / VFH / PRD 标题表 / PRD §6.4 round 3 段 / PR 草稿 5 处统一改 15 IPC + §十九 round 5 修订记录段（无代码改动 / 无 smoke 改动 — 纯文档口径回填）；v0.10 = 2026-05-14 round 4 self-review 修订：Codex 自动 review 1 P1 ⚠️ 资金红线（§五 新增 `addOneDay(date)` helper UTC 实现 + `runBizOpImportAsync` 描述补事务追加 `clearRunsAndDiffsByDateBu(db, addOneDay(date), BU)` 调用 + §九 smoke Case Q）+ §十二 升格清单评估 `runBizOpImportAsync` / `addOneDay` + §十八 round 4 修订记录段；v0.9.1 = 2026-05-14 round 3 self-review S2 grep 对齐：spec ↔ code IPC 数对齐 — §三 删描述但 code 不存在的 `bizOpRecon:run:pick-date` 行 + 表格说明列改为 5 tracked + 10 plain 分级标注 + 表头 round 3 P2 总述段重写为分级 pattern + §十二 P2 行 + §十六 验证步骤 grep 命令矫正；v0.9 = 2026-05-14 round 3 self-review 修订：Codex 自动 review 1 P1 ⚠️ 资金红线（§五 新增 `clearRunsAndDiffsByDate(db, date)` 函数 + `runFlowImportAsync` 描述补流水重导事务内清 runs 调用 + §九 smoke Case P）+ 2 P2（lockfile 同步 / §三 IPC 表 usage-stats wrapper 标注）+ 1 P3（preview:all 接入 biz-op-recon）+ §十二 升格清单评估 `runFlowImportAsync` / `clearRunsAndDiffsByDate` + §十七 修订记录段；v0.8 = 2026-05-14 round 2 self-review 修订；v0.7 = 2026-05-14 round 1 self-review 修订（1 critical + 3 important + 5 minor + 3 新 smoke + §7.6 dialog 5→4）；v0.6 = 2026-05-13 fix6：writeDateRangeDiffWorkbook 由 N sheet 改单 sheet「差异」+ data_date+account_key 排序 + Billdate/data_date 一致性 console.warn + smoke Case K；v0.5 = fix5 PRD 拍板修订；v0.4 = fix4 资金红线 bug 修复；v0.3 = fix1+fix2 手动测试回归；v0.2 = OPEN ISSUE 全部拍板；v0.1 = 起草） |
| 关联 PRD | `PRD-v2.1.3.md` |
| 关联 tasks | `tasks.md` |
| 工作分支 | `v2.1.3`（基于 main `fc5d766`） |
| 起草人 | team-lead |

> **本 spec 状态**：v0.2 起 PRD §6.1 共 18 项 OPEN ISSUE 全部拍板完毕；本文件所有占位字段已精确化（含 §三 IPC schema / §四 DDL / §五 算法函数签名 / §六 writer + 失败报告 / §十四 待拍板列表清空）。

---

## 一、本规格的边界

- **唯一改动**：新增独立模块「业务OP数据核对」（IPC `bizOpRecon:*`、SQLite 4 张表前缀 `biz_op_recon_*`、前端面板 `bizOpReconModulePanel`）
- **不动**：v2.1.2 已发布的 4 个老模块、3 个 dialog（C1/C2/C3 + C4）、Pending 模块、对账单 ReconID 修复模块、月度银行对账单BU回填校验模块
- **复用**：v2.1.2 月度银行对账单BU回填校验的文件结构 / IPC 命名风格 / dialog 样式（仅风格复用，代码逻辑独立）

---

## 二、模板字段定义

### 2.1 业务 OP 表（`assets/业务OP账单.xlsx`，23 列，已就位）

| 表头序号 | Excel 表头 | DB 列名（snake_case） | 类型 | 用途 |
|---|---|---|---|---|
| 1 | Billdate | bill_date_raw | TEXT | 原始文件日期字符串（不参与对账，仅留底） |
| 2 | 业务方 | bu_name | TEXT NOT NULL | BU 维度 + 下拉框枚举来源 |
| 3 | 客户编号 | customer_no | TEXT | — |
| 4 | 主体 | entity | TEXT | — |
| 5 | 账户号 | account_no | TEXT NOT NULL | 匹配 key |
| 6 | 账户类型 | account_type | TEXT | — |
| 7 | 币种 | currency | TEXT | — |
| 8 | 期初余额 | begin_balance | TEXT | 双重校验 expr (2) 左侧（落库 TEXT 保精度，校验时 `parseAmount` 解析） |
| 9 | 发生额 | amount | TEXT | 双重校验 expr (2) 中段、expr (1) 左侧 |
| 10 | 发生额（入） | amount_in | TEXT | 双重校验 expr (1) 右侧加项（#1 拍板 B） |
| 11 | 发生额（出） | amount_out | TEXT | 双重校验 expr (1) 右侧减项（#1 拍板 B） |
| 12 | 期末余额 | end_balance | TEXT | 双重校验 expr (2) 右侧 + **对账目标字段** |
| 13 | 期末可用余额 | end_available_balance | TEXT | — |
| 14 | 期末冻结余额 | end_frozen_balance | TEXT | — |
| 15 | 最近更新时间 | last_updated | TEXT | — |
| 16 | 通道 | channel | TEXT | — |
| 17 | ppCardId | pp_card_id | TEXT | — |
| 18 | 银行卡号 | bank_card_no | TEXT | — |
| 19 | 扩展信息 | extra_info | TEXT | — |
| 20 | 账户状态 | account_status | TEXT | — |
| 21 | BizId | biz_id | TEXT | — |
| 22 | 清结算系统创建时间 | sys_created_at | TEXT | — |
| 23 | 清结算系统更新时间 | sys_updated_at | TEXT | — |

### 2.2 流水对账单（`assets/流水对账单.xlsx`，28 列，已就位）

| 表头序号 | Excel 表头 | DB 列名（snake_case） | 类型 | 用途 |
|---|---|---|---|---|
| 1 | BizId | biz_id | TEXT | — |
| 2 | 账单日期 | bill_date_raw | TEXT | 原始日期字符串 |
| 3 | originBizId | origin_biz_id | TEXT | — |
| 4 | 主体大账号 | main_account | TEXT | — |
| 5 | 公司主体 | company_entity | TEXT | — |
| 6 | 流水类型 | flow_type | TEXT | — |
| 7 | 业务部门 | bu_dept | TEXT | BU 关联字段（运行对账时 `normalizeBu` = trim+toLowerCase 与业务OP `业务方` 比较，#7 拍板 C） |
| 8 | 对账主Id | recon_main_id | TEXT | — |
| 9 | 出入方向 | direction | TEXT NOT NULL | 发生额正负号判定（#3 拍板：仅允许中文「入」/「出」，入=+ 出=-，其他值视为脏数据→整批拒绝） |
| 10 | 流水单号 | flow_no | TEXT | — |
| 11 | 用户编号 | user_no | TEXT | — |
| 12 | 账户编号 | account_no | TEXT NOT NULL | **匹配 key**（与业务OP `账户号` 关联；字段名映射在 reader 层做） |
| 13 | 拆分类型 | split_type | TEXT | — |
| 14 | 对账金额 | recon_amount | TEXT NOT NULL | 发生额数值（与 direction 组合得到正/负） |
| 15 | 币种 | currency | TEXT | — |
| 16 | 账户类型 | account_type | TEXT | — |
| 17 | 流水开始时间 | flow_start_at | TEXT | — |
| 18 | 流水完成时间 | flow_end_at | TEXT | — |
| 19 | 渠道 | channel | TEXT | — |
| 20 | MerchantId | merchant_id | TEXT | — |
| 21 | valueDate | value_date | TEXT | — |
| 22 | BankRef | bank_ref | TEXT | — |
| 23 | Pending标识 | pending_flag | TEXT | — |
| 24 | 流水BizId | flow_biz_id | TEXT | — |
| 25 | 穿透ID | trace_id | TEXT | — |
| 26 | 操作人 | operator | TEXT | — |
| 27 | 系统创建时间 | sys_created_at | TEXT | — |
| 28 | 系统修改时间 | sys_updated_at | TEXT | — |

### 2.3 表头校验逻辑（精确匹配）

```javascript
// src/backend/biz-op-recon-import/validator.js
function validateBizOpHeaders(actualHeaders) {
  const expected = BIZ_OP_HEADERS; // 23 列常量
  if (actualHeaders.length !== expected.length) {
    return { ok: false, error: `业务OP 列数应为 ${expected.length}，实际 ${actualHeaders.length}` };
  }
  for (let i = 0; i < expected.length; i++) {
    if (normalize(actualHeaders[i]) !== normalize(expected[i])) {
      return { ok: false, error: `第 ${i + 1} 列表头应为「${expected[i]}」，实际「${actualHeaders[i]}」` };
    }
  }
  return { ok: true };
}
// validateFlowHeaders 同理（28 列）
```

---

## 三、IPC 命名空间 `bizOpRecon:*`

参照 v2.1.2 `bankBuRecon:*` 风格设计（#13 拍板 A 完全复用）。

> **round 3 P2 usage-stats 接入修订（2026-05-14；round 3 self-review S2 grep 对齐修订）**：本模块共 **15 个** `bizOpRecon:*` handler，按 v2.1.2 月度BU `bankBuRecon:*` 同款分级 pattern 拆分：
> - **5 个核心 action handler 走 `trackedIpcHandle`（计入 usage-stats）**：`import:run-biz-op` / `import:run-flow`（functionKey='导入文件'）+ `run`（functionKey='开始运行'）+ `export:date` / `export:date-range`（functionKey='导出差异'）；详见 `src/main.js:9814 / :9839 / :9901 / :9943 / :9966` + `src/backend/usage-stats.js` `FUNCTION_REGISTRY['业务OP数据核对'] = ['导入文件', '开始运行', '导出差异']` 共 3 个 functionKey
> - **10 个 query/dialog/helper handler 保持 `ipcMain.handle`（不计入 usage-stats）**：`status` / `bu:list` / `import:pick-biz-op-file` / `import:pick-flow-file` / `import:open-error-report-folder` / `import:check-single-day` / `run:list-ready-dates` / `export:list-success-dates` / `export:pick-save-path` / `run:history`；与 v2.1.2 `bankBuRecon` 同款分级（D6 拍板"仅成功 action 计数"）
> 下表说明列对核心 action 标注 "（tracked via usage-stats wrapper — moduleKey/functionKey）"；query/dialog/helper 标注 "（plain — 未计入 usage-stats）"。

| handler | 入参 | 出参 | 说明 |
|---|---|---|---|
| `bizOpRecon:status` | `{}` | `{importedDateBuPairs: [{date, buName, rowCount}], buList: [{buName, count}], flowImportedDates: [date]}` | 模块状态查询（业务OP 已导入 (date, BU) 二元组 + 流水已导入 date 列表 + BU 枚举）（plain — 未计入 usage-stats） |
| `bizOpRecon:bu:list` | `{}` | `[{buName, count}]` | BU 下拉框枚举：`SELECT DISTINCT bu_name, COUNT(*) FROM biz_op_recon_imports GROUP BY bu_name`（不做 `normalizeBu`，保留原值；#A 拍板）（plain — 未计入 usage-stats） |
| `bizOpRecon:import:pick-biz-op-file` | `{date}` | `{filePath} \| null` | 弹文件选择对话框（业务OP，*.xlsx）（plain — 未计入 usage-stats） |
| `bizOpRecon:import:run-biz-op` | `{date, filePath}` | `{status: 'success' \| 'rejected', buName?, validCount?, errorReportPath?, errorRows?: [{rowIndex, reason}]}` | 后台读取 + 表头校验（23 列严格匹配）+ **双重校验**（#1 拍板 B + #5 整批拒绝 + #15 清空旧 runs）：<br>- 全部通过 → 同事务内 `DELETE imports/runs/diff_rows` (date, BU) + `INSERT imports`，返回 `{status:'success', buName, validCount}`<br>- 任一不过 → 主表事务回滚 + 落失败报告 xlsx 到 `error-reports/{date}/`，返回 `{status:'rejected', errorReportPath, errorRows}`；**v0.3 fix2 拍板**：前端不再弹独立报错对话框，仅状态栏文字 + 失败报告路径（cmd+点击可打开）（tracked via usage-stats wrapper — moduleKey='业务OP数据核对'/functionKey='导入文件'） |
| `bizOpRecon:import:pick-flow-file` | `{date}` | `{filePath} \| null` | 弹文件选择对话框（流水对账单，*.xlsx）（plain — 未计入 usage-stats） |
| `bizOpRecon:import:run-flow` | `{date, filePath}` | `{status: 'success' \| 'rejected', totalCount?, errorReportPath?, errorRows?: [{rowIndex, reason}]}` | 后台读取 + 表头校验（28 列）+ 「出入方向」枚举校验（#3：仅「入」/「出」）：<br>- 全部通过 → 同事务内 `DELETE flow_imports WHERE data_date=?` + **`clearRunsAndDiffsByDate(db, date)` 清该 date 跨所有 BU 的 runs/diff_rows**（round 3 P1 资金红线新增）+ `INSERT`，返回 `{status:'success', totalCount}`<br>- 任一不过 → 事务回滚 + 落失败报告 xlsx，返回 `{status:'rejected', errorReportPath, errorRows}`（tracked via usage-stats wrapper — moduleKey='业务OP数据核对'/functionKey='导入文件'） |
| `bizOpRecon:import:open-error-report-folder` | `{errorReportPath}` | `{ok}` | 调用 `shell.showItemInFolder`。**v0.3 fix2 主流程不再触发**（校验失败改为状态栏文字 + 路径；用户 cmd+点击直接打开），handler 保留以备后续可能场景调用（plain — 未计入 usage-stats） |
| `bizOpRecon:import:check-single-day` | `{buName}` | `{onlyOneDay: boolean, count, latestDate?}` | "库里仅有一日数据"判定（#11 拍板 B 触发前的查询）（plain — 未计入 usage-stats） |
| `bizOpRecon:run:list-ready-dates` | `{buName}` | `[{date: 'YYYY-MM-DD'}]` | 列出"三件齐"日期（T-1 业务OP + T-2 业务OP + T-1 流水按 normalizeBu 过滤均非空）；用于 #12 前置 enable（plain — 未计入 usage-stats） |
| `bizOpRecon:run` | `{date, buName}` | `{runId, status: 'success', stats: {amountDiffCount, t1NotT2Count, t2NotT1Count, multiOpAccountCount, t1OpTotal, t2OpTotal, flowTotal, t2AnomalyAccountCount}}` | 后台跑对账（§五 算法），落 `biz_op_recon_runs` + `biz_op_recon_diff_rows`。**round 1 I3 新增 `t2AnomalyAccountCount`** = T-2 业务OP 期末余额非数值（NaN）的账户号去重计数；DB schema 字段 `biz_op_recon_runs.t2_anomaly_account_count`；详见 PRD §3.5.5（tracked via usage-stats wrapper — moduleKey='业务OP数据核对'/functionKey='开始运行'） |
| `bizOpRecon:export:list-success-dates` | `{buName}` | `[{date: 'YYYY-MM-DD', runId, runAt}]` | 列出有 success run 的日期（按 buName 过滤；#13 拍板 A 风格）；用于"导出指定日期"下拉 + 区间起止（plain — 未计入 usage-stats） |
| `bizOpRecon:export:pick-save-path` | `{defaultFileName}` | `{savePath} \| null` | 弹另存为对话框（默认文件名 #9 拍板 A 格式）（plain — 未计入 usage-stats） |
| `bizOpRecon:export:date` | `{runId, savePath}` | `{status: 'success', filePath}` | 导出指定日期差异表（1 sheet，sheet 名 `YYYY-MM-DD` ISO，#14 拍板 A）（tracked via usage-stats wrapper — moduleKey='业务OP数据核对'/functionKey='导出差异'） |
| `bizOpRecon:export:date-range` | `{buName, startDate, endDate, savePath}` | `{status, filePath, sheetCount, skippedDates}` | 导出日期区间差异表（N sheet，sheet 名 `YYYY-MM-DD`；skippedDates = 区间内无 success run 的日期）（tracked via usage-stats wrapper — moduleKey='业务OP数据核对'/functionKey='导出差异'） |
| `bizOpRecon:run:history` | `{date, buName}` | `[runs]` | 单 (日期, BU) 运行历史（debug 用，可选）（plain — 未计入 usage-stats） |

> **round 2 R2-M1 修订（2026-05-14）**：原 spec v0.7 此表中描述了 `bizOpRecon:import:pick-biz-op-date` / `bizOpRecon:import:pick-flow-date` 两个 handler，但 main.js / preload.js 实际**无定义**（grep 验证无输出）。两个日期对话框在 code 中由前端 dialog factory `createBizOpReconDatePickerDialog`（`src/renderer-dialogs.js:8067`）直接渲染处理，**不走 IPC**；调用方在 `src/renderer.js:4179` / `src/renderer.js:4255` 直接 `openModal(createBizOpReconDatePickerDialog({...}))`。round 2 把 spec ↔ code 对齐：表中删除两行 + 在 §7.6 dialog factory 段补处理路径说明。

---

## 四、SQLite Schema（写入主 DB `tool-data.sqlite`，**共 4 张表**）

> **变更说明**：v0.1 曾设计 `biz_op_recon_imports_errors` 异常行表；#5 拍板 = 整批拒绝 + 失败报告 xlsx 落 `error-reports/{date}/`，**主表不留任何脏行**，所以 errors 表从 schema 中删除。最终 4 张表 = imports / flow_imports / runs / diff_rows。

### 4.1 表 1：`biz_op_recon_imports`（业务OP 主表）

```sql
CREATE TABLE IF NOT EXISTS biz_op_recon_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_date TEXT NOT NULL,              -- 'YYYY-MM-DD'（用户在导入对话框中选定）
  bu_name TEXT NOT NULL,                -- 从业务方 列读取（**落库保留原值**，对账时按 normalizeBu 归一化比较；#7 拍板 C）
  row_index INTEGER NOT NULL,           -- Excel 原行号（从 2 起，参照 v2.1.2 F5 fix 保留 blankrows=true）

  -- 23 列业务 OP 数据（原值落库 TEXT 保精度）
  bill_date_raw TEXT,                   -- 列 1: Billdate
  -- bu_name 已在上面（列 2）
  customer_no TEXT,                     -- 列 3
  entity TEXT,                          -- 列 4
  account_no TEXT NOT NULL,             -- 列 5
  account_type TEXT,                    -- 列 6
  currency TEXT,                        -- 列 7
  begin_balance TEXT,                   -- 列 8 ★ 双重校验
  amount TEXT,                          -- 列 9 ★ 双重校验
  amount_in TEXT,                       -- 列 10 ★ 双重校验
  amount_out TEXT,                      -- 列 11 ★ 双重校验
  end_balance TEXT,                     -- 列 12 ★ 对账目标
  end_available_balance TEXT,           -- 列 13
  end_frozen_balance TEXT,              -- 列 14
  last_updated TEXT,                    -- 列 15
  channel TEXT,                         -- 列 16
  pp_card_id TEXT,                      -- 列 17
  bank_card_no TEXT,                    -- 列 18
  extra_info TEXT,                      -- 列 19
  account_status TEXT,                  -- 列 20
  biz_id TEXT,                          -- 列 21
  sys_created_at TEXT,                  -- 列 22
  sys_updated_at TEXT,                  -- 列 23

  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_biz_op_imports_date_bu ON biz_op_recon_imports(data_date, bu_name);
CREATE INDEX IF NOT EXISTS idx_biz_op_imports_account ON biz_op_recon_imports(data_date, bu_name, account_no);
CREATE INDEX IF NOT EXISTS idx_biz_op_imports_bu ON biz_op_recon_imports(bu_name);
```

**重新导入策略（#4 + #15 拍板 A，统一事务）**：
```sql
BEGIN;
DELETE FROM biz_op_recon_diff_rows WHERE run_id IN (SELECT id FROM biz_op_recon_runs WHERE data_date=? AND bu_name=?);
DELETE FROM biz_op_recon_runs WHERE data_date=? AND bu_name=?;
DELETE FROM biz_op_recon_imports WHERE data_date=? AND bu_name=?;
-- INSERT 新行...
COMMIT;
```

### 4.2 表 2：`biz_op_recon_flow_imports`（流水对账单主表）

```sql
CREATE TABLE IF NOT EXISTS biz_op_recon_flow_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_date TEXT NOT NULL,
  row_index INTEGER NOT NULL,

  -- 28 列流水对账单数据（原值落库 TEXT 保精度）
  biz_id TEXT,                          -- 列 1
  bill_date_raw TEXT,                   -- 列 2
  origin_biz_id TEXT,                   -- 列 3
  main_account TEXT,                    -- 列 4
  company_entity TEXT,                  -- 列 5
  flow_type TEXT,                       -- 列 6
  bu_dept TEXT,                         -- 列 7 ★ BU 关联字段（保留原值，对账时 normalizeBu 比较）
  recon_main_id TEXT,                   -- 列 8
  direction TEXT NOT NULL,              -- 列 9 ★ 出入方向（保留原值「入」/「出」，导入时已校验非空且 ∈ {入,出}）
  flow_no TEXT,                         -- 列 10
  user_no TEXT,                         -- 列 11
  account_no TEXT NOT NULL,             -- 列 12 ★ 匹配 key
  split_type TEXT,                      -- 列 13
  recon_amount TEXT NOT NULL,           -- 列 14 ★ 对账金额（绝对值；正负号由 direction 决定）
  currency TEXT,                        -- 列 15
  account_type TEXT,                    -- 列 16
  flow_start_at TEXT,                   -- 列 17
  flow_end_at TEXT,                     -- 列 18
  channel TEXT,                         -- 列 19
  merchant_id TEXT,                     -- 列 20
  value_date TEXT,                      -- 列 21
  bank_ref TEXT,                        -- 列 22
  pending_flag TEXT,                    -- 列 23
  flow_biz_id TEXT,                     -- 列 24
  trace_id TEXT,                        -- 列 25
  operator TEXT,                        -- 列 26
  sys_created_at TEXT,                  -- 列 27
  sys_updated_at TEXT,                  -- 列 28

  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_flow_imports_date ON biz_op_recon_flow_imports(data_date);
CREATE INDEX IF NOT EXISTS idx_flow_imports_date_bu ON biz_op_recon_flow_imports(data_date, bu_dept);
CREATE INDEX IF NOT EXISTS idx_flow_imports_account ON biz_op_recon_flow_imports(data_date, account_no);
```

**重新导入策略（#4 拍板 A，仅按 date 级清空，因流水不分 BU）**：
```sql
BEGIN;
-- 资金红线 ⚠️ PR #45 round 3 P1 fix（reverse sync 入 spec）：流水按 date 跨所有 BU 共用，
-- 重导后该 date 所有旧 runs/diff_rows 都失效（旧 run 是基于旧流水算出的）—
-- 必须按 date 跨所有 BU 清 runs + diff_rows，否则 export:date 按旧 runId 读旧 diff_rows
-- → 源换了导出仍是旧数据 → 资金事故。
-- 与业务OP 重导清单 BU runs（clearRunsAndDiffsByDateBu）粒度不同，函数名清晰区分：
--   ByDate（流水路径） vs ByDateBu（业务OP 路径）。
DELETE FROM biz_op_recon_diff_rows WHERE run_id IN (SELECT id FROM biz_op_recon_runs WHERE data_date=?);
DELETE FROM biz_op_recon_runs WHERE data_date=?;
DELETE FROM biz_op_recon_flow_imports WHERE data_date=?;
-- INSERT 新行...
COMMIT;
```

实现：`src/backend/biz-op-recon-db/run-repository.js#clearRunsAndDiffsByDate(db, date)`；
调用方：`src/main-process/biz-op-recon-session.js#runFlowImportAsync` 事务内（业务OP 路径继续用 `clearRunsAndDiffsByDateBu` 不变）。
smoke 防回归：`scripts/smoke/biz-op-recon.js` Case P（构造两 BU 流水共用同 date 的 run，重导后断言两 BU run 全清）。

### 4.3 表 3：`biz_op_recon_runs`（运行记录）

```sql
CREATE TABLE IF NOT EXISTS biz_op_recon_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_date TEXT NOT NULL,              -- 对账日期（T-1）
  bu_name TEXT NOT NULL,
  run_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status TEXT NOT NULL,                 -- 'success'（系统错误不落 runs，直接 throw 给 IPC handler）

  -- 统计字段
  t1_op_total INTEGER NOT NULL DEFAULT 0,    -- T-1 业务OP 行数
  t2_op_total INTEGER NOT NULL DEFAULT 0,    -- T-2 业务OP 行数
  flow_total INTEGER NOT NULL DEFAULT 0,     -- T-1 流水（按 normalizeBu 过滤后）行数
  amount_diff_count INTEGER NOT NULL DEFAULT 0,   -- "比对测算金额=不相等" 的行数
  multi_op_account_count INTEGER NOT NULL DEFAULT 0,  -- "同账户号多个OP=是" 的账户号数量
  t1_not_t2_count INTEGER NOT NULL DEFAULT 0,
  t2_not_t1_count INTEGER NOT NULL DEFAULT 0,
  t2_anomaly_account_count INTEGER NOT NULL DEFAULT 0,  -- round 1 I3 新增：T-2 NaN end_balance 账户号去重计数

  export_path TEXT                      -- 最近一次导出路径（debug）
);

CREATE INDEX IF NOT EXISTS idx_biz_op_runs_date_bu ON biz_op_recon_runs(data_date, bu_name, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_biz_op_runs_status ON biz_op_recon_runs(status, data_date);
```

**重新导入清空（#15 拍板 A）**：见 4.1 表 `DELETE FROM biz_op_recon_runs WHERE data_date=? AND bu_name=?`。

### 4.4 表 4：`biz_op_recon_diff_rows`（差异行明细）

```sql
CREATE TABLE IF NOT EXISTS biz_op_recon_diff_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,              -- FK biz_op_recon_runs.id
  data_date TEXT NOT NULL,              -- 冗余字段（便于跨 run 区间查询，避免 JOIN）
  bu_name TEXT NOT NULL,                -- 同上
  source_table TEXT NOT NULL,           -- 'T1' / 'T2'（差异行来源）：T1 = `biz_op_recon_imports` data_date=T1；T2 = data_date=T-1 即 T2
  source_row_id INTEGER NOT NULL,       -- FK biz_op_recon_imports.id（指向具体业务 OP 原行）

  -- 4 个差异表新增字段（与 §3.5 PRD 字段定义对应）
  cmp_t2 TEXT NOT NULL DEFAULT '',      -- '比对T-2日' 列：'T-1有T-2无' / 'T-2有T-1无' / ''（空字符串 = 测算金额差异行）
  multi_op_flag TEXT NOT NULL,          -- '同账户号多个OP' 列：'是' / '否'
  cmp_amount TEXT NOT NULL DEFAULT '',  -- '比对测算金额' 列：'相等' / '不相等' / ''（T-2有T-1无 行固定 ''）
  amount_diff TEXT NOT NULL DEFAULT '', -- '测算金额差额' 列：绝对值差额（字符串保精度），'相等' / T-2有T-1无 时填 ''

  FOREIGN KEY (run_id) REFERENCES biz_op_recon_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_biz_op_diff_run ON biz_op_recon_diff_rows(run_id);
CREATE INDEX IF NOT EXISTS idx_biz_op_diff_date_bu ON biz_op_recon_diff_rows(data_date, bu_name);
```

**写入时机**：`bizOpRecon:run` 完成时按 §五 算法把"应该进表的差异行"批量 insert（#10 拍板 A：`cmp_t2 非空 OR cmp_amount=='不相等'` 才进表）。

**重新导入清空（#15 拍板 A）**：见 4.1 表 `DELETE FROM biz_op_recon_diff_rows WHERE run_id IN (...)`，**先清 diff_rows 再清 runs**（FK 约束）。

---

## 五、对账算法（核心，资金红线 ⚠️）

### 5.0 算法常量与函数签名（**所有拍板结果固化点**）

```javascript
// AMOUNT_EPSILON 单一来源（M2 round1 提取，round 2 R2-M5 spec 同步位置）：
//   src/backend/biz-op-recon-db/columns.js（L146）  ← 单一真理源
//   ↑ import 该常量的下游：
//       src/backend/biz-op-recon-import/validator.js（双重校验）
//       src/main-process/biz-op-recon-session.js（compareT1OpWithComputed）
//   原 v0.6 之前分散在 session.js + validator.js 两处定义 → 双源，调小一边漏改另一边的资金红线偏差
//   M2 round1 提取后改为单源 import；round 2 spec 描述位置从 session.js 同步为 columns.js（与 code 对齐）
const AMOUNT_EPSILON = 1e-2;            // 1 分钱容差（#1 拍板 B：双重校验 + #6 测算金额对比）

// 出入方向枚举常量（仍在 src/backend/biz-op-recon-import/validator.js 顶部定义；session.js parseSignedAmount 使用）
const VALID_DIRECTION_IN = '入';        // #3 拍板：仅允许中文「入」
const VALID_DIRECTION_OUT = '出';       // #3 拍板：仅允许中文「出」

// v0.3 fix2.4 回滚：差异表 writer 不再使用 YELLOW_FILL_ARGB；常量保留供失败报告 writer 使用（§6.3）
const YELLOW_FILL_ARGB = 'FFFFFF00';    // 仅用于 §6.3 失败报告 writer（差异表已无黄底）
```

#### 5.0.1 算法函数签名总览

| 函数 | 入参 | 返回 | 拍板依据 | 所属文件 |
|---|---|---|---|---|
| `validateBizOpRow(row)` | `{begin_balance, amount, amount_in, amount_out, end_balance, ...}` | `{ ok: boolean, reason?: string }` | #1 拍板 B：双重校验，epsilon=1e-2 | `src/backend/biz-op-recon-import/validator.js` |
| `validateFlowRow(row)` | `{direction, recon_amount, account_no, ...}` | `{ ok: boolean, reason?: string }` | #3 拍板：direction 必须 ∈ {入, 出} | `src/backend/biz-op-recon-import/validator.js` |
| `parseSignedAmount(direction, amount)` | `direction: string, amount: string` | `number \| NaN` | #3 拍板：入=+，出=-，其他=NaN | `src/main-process/biz-op-recon-session.js` |
| `normalizeBu(v)` | `v: unknown` | `string` | #7 拍板 C：trim + toLowerCase | `src/main-process/biz-op-recon-session.js` |
| `normalizeAccountKey(v)` | `v: unknown` | `string` | 仅 trim（账户号是资金 key，不做大小写归一） | `src/main-process/biz-op-recon-session.js` |
| `parseAmount(v)` | `v: unknown` | `number \| NaN` | 字符串数值解析（去除千分位 `,`） | `src/main-process/biz-op-recon-session.js` |
| `subOneDay(yyyymmdd)` | `'YYYY-MM-DD'` | `'YYYY-MM-DD'` | T-1 减一日 → T-2，字符串处理避免时区（实现：UTC + setUTCDate -1）。**round 2 R2-M4 双源说明**：实现完全一致的副本同时存在于 `src/backend/biz-op-recon-db/run-repository.js:155`，避免 backend 反向 import main-process 的工程偏好（保留双源符合 architecture 边界）。**维护时必须双侧同步**（任一处改实现 → 另一处必须同步改）；否则会出现"`runReconciliation` 用 session.js 版本 / `listReadyDates` 用 run-repository 版本"行为漂移的资金红线。已升格 `rules/important-variables.md` Risk-sensitive。 | `src/main-process/biz-op-recon-session.js` + `src/backend/biz-op-recon-db/run-repository.js`（双源） |
| `addOneDay(yyyymmdd)` | `'YYYY-MM-DD'` | `'YYYY-MM-DD'` | **round 4 P1 资金红线新增**：D 加一日 → D+1，与 `subOneDay` 对偶；**必须 UTC 实现**：`new Date(date + 'T00:00:00Z')` + `setUTCDate(getUTCDate() + 1)` + `toISOString().slice(0, 10)`，避免本地时区（如 UTC+12 / UTC-12）使用 `setDate(getDate() + 1)` 抢跑或滞后 1 天。**用途**：业务OP `(date, BU)` 重导时，`runBizOpImportAsync` 在事务内调用 `clearRunsAndDiffsByDateBu(db, addOneDay(date), BU)` 清下一日作为 T-2 的 run（业务OP 某日数据双角色：当天 T-1 + 下一日 T-2，§3.4.1 步 4.2.a）。**资金红线**：时区错乱直接错日期 → 漏清下一日 run 或误清后天 run = 资金事故。round 4 升格 `rules/important-variables.md` Risk-sensitive。 | `src/main-process/biz-op-recon-session.js` |
| `aggregateFlowByAccount(flowRows, buName)` | `flowRows: Array, buName: string` | `Map<string, number>` | 按 normalizeBu 过滤 + 按账户号 sum signedAmount（#3+#7 联动）| `src/main-process/biz-op-recon-session.js` |
| `computeT1Op(t2OpRows, flowAggMap)` | `t2OpRows: Array, flowAggMap: Map<string, number>` | `{ map: Map<accountKey, number>, anomalyAccountSet: Set<accountKey> }` | T-2 期末 + 流水累加 = 计算 T-1 期末。**round 1 I3 修订 + round 2 R2-M2 签名 spec ↔ code 对齐**：T-2 `parseAmount(r.end_balance) === NaN` 时把 accKey 加入函数内部 `anomalyAccountSet`（去重）；该账户号跳过 `map.set`，后续 `compareT1OpWithComputed` 走"T-1 有 T-2 无"分支。**round 2 R2-I2 部分 NaN 容错**：循环结束后扫一遍 `validAccountSet` 与 `anomalyAccountSet` 做集合差（`for (const acc of validAccountSet) anomalyAccountSet.delete(acc)`）— 仅当账户号**所有行**都 NaN 才标 anomaly；任一行 valid 则用 valid 行的期末 + flowSum 写 map（不退化为 silent drop 整账户）。`console.warn` 由 caller `runReconciliation` 在循环 `anomalyAccountSet` 时输出（不在 `computeT1Op` 内部输出，便于 caller 拿到 `t2Date` / `buName` 上下文构造完整文案；详见 §5.1 实现）。`runReconciliation` 解构返回值后 `summary.t2AnomalyAccountCount = anomalyAccountSet.size` | `src/main-process/biz-op-recon-session.js` |
| `compareT1OpWithComputed(t1OpRows, computedT1Map)` | `t1OpRows: Array, computedT1Map: Map<string, number>` | `{ diffRows: Array, stats: {amountDiffCount, multiOpAccountCount} }` | #6 拍板 A：1:N 逐行独立比，epsilon=1e-2。**v0.5 fix5 选项 B**：相等的多 OP 行（即 `t1Rows.length >= 2` 且 `diff <= epsilon`）也需 push 到 diffRows，meta 列填 `相等/空/是`；与不相等行的区别仅在 meta 取值。单 OP 相等行仍不进表。`amountDiffCount` 仍只累计"不相等"行（相等多 OP 行不计入差异计数）。 | `src/main-process/biz-op-recon-session.js` |
| `diffT1AndT2Accounts(t1OpRows, t2OpRows)` | `t1OpRows: Array, t2OpRows: Array` | `{ onlyInT1: Array, onlyInT2: Array }` | 步骤 4.3 账户号差集 | `src/main-process/biz-op-recon-session.js` |
| `runBizOpReconciliation({date, buName})` | 见 §5.1 | `{runId, stats: {amountDiffCount, multiOpAccountCount, t1NotT2Count, t2NotT1Count, t1OpTotal, t2OpTotal, flowTotal, t2AnomalyAccountCount}}` | 编排上述函数 + 落库；**round 1 I3**：summary 新增 `t2AnomalyAccountCount` 字段（注入 `t2AnomalySeen: Set<string>` 给 `computeT1Op` → 取 size 写 stats） | `src/main-process/biz-op-recon-session.js` |
| `clearRunsAndDiffsByDateBu(db, date, buName)` | `db: DatabaseSync, date: string, buName: string` | `void`（同事务调用） | #15 拍板 A：业务OP `(date, BU)` 重新导入时清空对应 BU 的旧 runs + diff_rows（**单 BU 清**）；DELETE 顺序：diff_rows → runs（FK 依赖） | `src/backend/biz-op-recon-db/run-repository.js` |
| `clearRunsAndDiffsByDate(db, date)` | `db: DatabaseSync, date: string` | `void`（同事务调用） | **round 3 P1 资金红线新增**：流水 `data_date` 重新导入时清空该 date **跨所有 BU** 的 runs + diff_rows（**与 `clearRunsAndDiffsByDateBu` 区分语义**：流水按 date 跨所有 BU 共用 → 跨 BU 清；业务OP 按 (date, BU) 分片 → 单 BU 清）。DELETE 顺序：diff_rows（按 run_id IN SELECT）→ runs（按 data_date）。**资金红线**：流水换了对账没重跑 → 导出旧差异 = 资金事故 | `src/backend/biz-op-recon-db/run-repository.js` |
| `runFlowImportAsync({date, filePath})` | `{date, filePath}` | `{status: 'success' \| 'rejected', totalCount?, errorReportPath?, errorRows?}` | **round 3 P1 资金红线修订**：流水重导事务（`bizOpRecon:import:run-flow` IPC handler 后端实现）必须包含 `clearRunsAndDiffsByDate(db, date)` 调用。事务内顺序：BEGIN → DELETE flow_imports WHERE data_date=? → **`clearRunsAndDiffsByDate(db, date)`**（round 3 新增）→ INSERT 新流水 → COMMIT；任一步失败回滚 | `src/main-process/biz-op-recon-session.js` |
| `runBizOpImportAsync({date, filePath})` | `{date, filePath}` | `{status: 'success' \| 'rejected', buName?, validCount?, errorReportPath?, errorRows?}` | **round 4 P1 资金红线修订**：业务OP 重导事务（`bizOpRecon:import:run-biz-op` IPC handler 后端实现）必须包含 **两次** `clearRunsAndDiffsByDateBu` 调用：当天 + 下一日。事务内顺序：BEGIN → 双重校验 → DELETE imports WHERE (date, BU) → **`clearRunsAndDiffsByDateBu(db, date, BU)`**（清当天作为 T-1 的 run；#15 拍板 A 已实现）→ **`clearRunsAndDiffsByDateBu(db, addOneDay(date), BU)`**（清下一日作为 T-2 的 run；round 4 新增）→ 落库前 `bu_name = String(rawBuName).trim()`（I2 round 1）→ INSERT 新业务OP → COMMIT；任一步失败回滚。**资金红线**：业务OP 某日数据 既是当天 T-1 也是下一日 T-2 输入（§3.4.1 步 4.2.a `计算 T-1 OP = T-2 期末 + 流水累加`），漏清下一日 run → 用旧 T-2 期末算的下一日 run + 新 T-2 期末数据 → 「导出差异」拿 stale 差额 = 资金事故 | `src/main-process/biz-op-recon-session.js` |

> **multi_op_account_count 累加点**（fix4 修复）：除主路径外，`runReconciliation` 5.a (onlyInT1 路径) 也需累加；使用 `multiOpAccountSeen: Set<accountKey>` 防重复；判定标准 = `countAccountRows(t1OpRows, accKey) >= 2`。详见 PRD §3.5.4。

> **流水重导清 runs 不变量**（round 3 P1 资金红线）：`runFlowImportAsync` 事务必须调 `clearRunsAndDiffsByDate(db, date)`（详见 PRD §3.5.6）。该函数清该 date **所有 BU** 的 runs + diff_rows，与 `clearRunsAndDiffsByDateBu` 单 BU 清不同。Dev 实施改 `src/main-process/biz-op-recon-session.js` `runFlowImportAsync` + `src/backend/biz-op-recon-db/run-repository.js` 新增 `clearRunsAndDiffsByDate` 函数；smoke Case P 防回归。

> **业务OP 重导清下一日 runs 不变量**（round 4 P1 资金红线）：`runBizOpImportAsync` 事务必须调 **两次** `clearRunsAndDiffsByDateBu`（详见 PRD §3.5.7）：`clearRunsAndDiffsByDateBu(db, date, BU)`（当天 T-1，#15 已有）+ `clearRunsAndDiffsByDateBu(db, addOneDay(date), BU)`（下一日 T-2，round 4 新增）。业务OP 某日数据双角色（既是当天 T-1 也是下一日 T-2 输入），仅清当天 → 下一日 run 用旧 T-2 数据 = 资金事故。**与 round 3 P1 (流水跨 BU 清) 互补**：业务OP 单 BU 跨 2 日清；流水跨 BU 单日清。Dev 实施改 `src/main-process/biz-op-recon-session.js` `runBizOpImportAsync` + 新增 `addOneDay(date)` helper（UTC 实现，与 `subOneDay` 对偶）；smoke Case Q 防回归。

> **t2AnomalyAccountCount 累加点**（round 1 I3 修复 + round 2 R2-M2 签名 spec ↔ code 对齐）：`runReconciliation` 1 步取数后调用 `const { map: calcT1ByAccount, anomalyAccountSet: t2AnomalyAccounts } = computeT1Op(t2OpRows, flowSumByAccount)` → 解构返回值 → 在 caller 端循环 `anomalyAccountSet` 调 `console.warn(...)`（详见 §5.1 实现 + §5.2 文案）→ `stats.t2AnomalyAccountCount = t2AnomalyAccounts.size`。**注意**：`anomalyAccountSet` 在 `computeT1Op` 内部完成"部分 NaN 容错"（`validAccountSet.delete(anomalyAccountSet)` 集合差），caller 拿到的已是"完全 silent drop"账户集合（即所有行都 NaN 的账户号；任一行 valid 的账户号已被剔除）。详见 PRD §3.5.5 关键不变量第 2 条。

### 5.1 总体流程

```javascript
// src/main-process/biz-op-recon-session.js
async function runBizOpReconciliation({ date, buName }) {
  const db = getMainDb();
  const t2Date = subOneDay(date); // 'YYYY-MM-DD' 减一日

  // 1. 取数
  const t1OpRows = repo.getBizOpRows(db, date, buName);
  const t2OpRows = repo.getBizOpRows(db, t2Date, buName);
  const flowRowsAll = repo.getFlowRows(db, date);
  const flowRows = flowRowsAll.filter(r => normalizeBu(r.bu_dept) === normalizeBu(buName));

  // 2. 步骤 4.1：流水累加（按账户号汇总 当日发生额合计；#3 拍板入=+ 出=-）
  const flowSumByAccount = aggregateFlowByAccount(flowRows, buName);
  // 内部实现：
  // const map = new Map();
  // for (const r of flowRows) {
  //   const accKey = normalizeAccountKey(r.account_no);
  //   if (!accKey) continue;
  //   const signed = parseSignedAmount(r.direction, r.recon_amount);
  //   if (Number.isNaN(signed)) continue;  // 理论上导入已拦截，对账阶段二次保护
  //   map.set(accKey, (map.get(accKey) || 0) + signed);
  // }

  // 3. 步骤 4.2.a：基于 T-2 OP + 流水累加 计算 T-1 期末余额（按账户号汇总单值）
  // round 1 I3 + round 2 R2-M2 spec ↔ code 对齐：
  //   computeT1Op 返回 { map, anomalyAccountSet }（不再接收 t2AnomalySeen / buName 参数）；
  //   anomalyAccountSet 已经过"部分 NaN 容错"（仅"完全 silent drop"账户号；详见 §5.2 + PRD §3.5.5）
  const { map: calcT1ByAccount, anomalyAccountSet: t2AnomalyAccounts } = computeT1Op(t2OpRows, flowSumByAccount);

  // round 2 R2-M3 console.warn 文案 spec ↔ code 统一：caller 端按 code 实际文案输出
  for (const acc of t2AnomalyAccounts) {
    console.warn(
      `[biz-op-recon] T-2 end_balance NaN silent drop date=${t2Date} bu=${buName} account=${acc} ` +
      `(该账户在 T-1 实际 OP 与差异表均不可见，请检查源文件期末余额字段)`
    );
  }

  // 4. 步骤 4.2.b：T-1 OP 与 计算 T-1 OP 按账户号对账（#6 拍板 A：逐行独立比）
  const { diffRows, stats } = compareT1OpWithComputed(t1OpRows, calcT1ByAccount);

  // 5. 步骤 4.3：账户号增减差集（T-1 vs T-2）
  const { onlyInT1, onlyInT2 } = diffT1AndT2Accounts(t1OpRows, t2OpRows);

  // 5.a：T-1 有 T-2 无 → 进 diff 表，cmp_t2='T-1有T-2无'（v0.3 fix2.4 回滚：不再标黄；writer 阶段差异表全部白底）
  for (const r of onlyInT1) {
    const accKey = normalizeAccountKey(r.account_no);
    const isMulti = (t1ByAccount(t1OpRows, accKey).length > 1) ? '是' : '否';
    diffRows.push({ source_table: 'T1', source_row_id: r.id, cmp_t2: 'T-1有T-2无', multi_op_flag: isMulti, cmp_amount: '', amount_diff: '' });
  }

  // 5.b：T-2 有 T-1 无 → 进 diff 表，cmp_t2='T-2有T-1无'；来源行取 T-2 表（拍板 C）；v0.3 fix2.4 回滚：不再标黄
  for (const r of onlyInT2) {
    diffRows.push({ source_table: 'T2', source_row_id: r.id, cmp_t2: 'T-2有T-1无', multi_op_flag: '否', cmp_amount: '', amount_diff: '' });
  }

  // 6. 落库 + 返回
  const runId = repo.insertRun(db, {
    date, buName, status: 'success',
    stats: {
      t1OpTotal: t1OpRows.length,
      t2OpTotal: t2OpRows.length,
      flowTotal: flowRows.length,
      amountDiffCount: stats.amountDiffCount,
      multiOpAccountCount: stats.multiOpAccountCount,
      t1NotT2Count: onlyInT1.length,
      t2NotT1Count: onlyInT2.length,
      t2AnomalyAccountCount: t2AnomalyAccounts.size              // round 1 I3 + round 2 R2-M2：取 anomalyAccountSet.size
    }
  });
  repo.insertDiffRows(db, runId, date, buName, diffRows);

  return { runId, stats: { ...stats, t1NotT2Count: onlyInT1.length, t2NotT1Count: onlyInT2.length, t1OpTotal: t1OpRows.length, t2OpTotal: t2OpRows.length, flowTotal: flowRows.length, t2AnomalyAccountCount: t2AnomalyAccounts.size } };
}
```

### 5.2 helper 函数实现（**全部拍板结果落实**）

```javascript
// 账户号匹配：仅 trim（不大小写归一；账户号资金 key，原值精确比较）
function normalizeAccountKey(v) {
  if (v == null) return '';
  return String(v).trim();
}

// BU 比较：trim + toLowerCase（#7 拍板 C，与 v2.1.2 normalizeBu 完全一致）
function normalizeBu(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase();
}

// 出入方向 → 正负号（#3 拍板：仅允许中文「入」/「出」，其他 → NaN）
// 注意：导入阶段已通过 validateFlowRow 拦截非「入/出」值；本函数是对账阶段的二次保护
function parseSignedAmount(direction, amount) {
  const num = parseAmount(amount);
  if (Number.isNaN(num)) return NaN;
  const dir = String(direction == null ? '' : direction).trim();
  if (dir === VALID_DIRECTION_IN) return +num;      // '入' → +
  if (dir === VALID_DIRECTION_OUT) return -num;     // '出' → -
  return NaN;                                        // 其他值（含空、错别字、英文 DEBIT/CREDIT 等）
}

function parseAmount(v) {
  if (v == null || v === '') return NaN;
  const n = Number(String(v).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

// T-1 → T-2 日期减一（按字符串处理，避免时区问题）
function subOneDay(yyyymmdd) {
  const d = new Date(yyyymmdd + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// 流水按账户号汇总（#3 + #7 联动）
function aggregateFlowByAccount(flowRows, buName) {
  const map = new Map();
  const buKey = normalizeBu(buName);
  for (const r of flowRows) {
    if (normalizeBu(r.bu_dept) !== buKey) continue;
    const accKey = normalizeAccountKey(r.account_no);
    if (!accKey) continue;
    const signed = parseSignedAmount(r.direction, r.recon_amount);
    if (Number.isNaN(signed)) continue;
    map.set(accKey, (map.get(accKey) || 0) + signed);
  }
  return map;
}

// T-2 期末 + 流水累加 = 计算 T-1 期末
// round 1 I3 修订 + round 2 R2-M2 签名 spec ↔ code 对齐：
//   函数签名：(t2OpRows, flowAggMap) — 不再接收 t2AnomalySeen / buName 参数
//   返回：{ map: Map<accountKey, calcT1>, anomalyAccountSet: Set<accountKey> }
//   console.warn 改由 caller 输出（在 caller 端拿到 t2Date / buName 上下文构造完整文案；详见 §5.1）
//
// round 2 R2-I2 部分 NaN 容错路径（关键不变量）：
//   仅当账户号"所有行都 NaN" 才进 anomalyAccountSet；任一行 valid 则用 valid 行的期末 + flowSum 写 map
//   实现：循环中分别维护 anomalyAccountSet 与 validAccountSet → 循环结束做集合差
//   设计动机：真实数据中部分行可能被 Excel 转码异常（#N/A / 空字符串），但同账户号其他行可能正常；
//             不退化为 silent drop 整账户，便于跑通对账并输出有效差异表
function computeT1Op(t2OpRows, flowAggMap) {
  const map = new Map();
  const anomalyAccountSet = new Set();   // T-2 该账户号 NaN end_balance 候选集
  const validAccountSet = new Set();     // T-2 该账户号至少有 1 行 valid end_balance
  for (const r of t2OpRows) {
    const accKey = normalizeAccountKey(r.account_no);
    if (!accKey) continue;
    const t2EndBal = parseAmount(r.end_balance);
    if (Number.isNaN(t2EndBal)) {
      // round 2 R2-I2：单条 NaN 不立即标 anomaly（同账户号可能有其他有效行）
      // 仅当该账户号所有行都 NaN 时才标 — 在循环结束后做 validAccountSet 集合差
      anomalyAccountSet.add(accKey);
      continue;
    }
    validAccountSet.add(accKey);
    // 同账户号 N 条：map.set 覆盖（业务上同账户号同 BU 同日期末理论一致；最后一行覆盖等价）
    const flowSum = flowAggMap.get(accKey) || 0;
    map.set(accKey, t2EndBal + flowSum);
  }
  // round 2 R2-I2 部分 NaN 容错：仅保留"完全 silent drop"账户号（剔除任一行 valid 的账户）
  for (const acc of validAccountSet) anomalyAccountSet.delete(acc);
  return { map, anomalyAccountSet };
}

// T-1 OP 与 计算 T-1 OP 对账（#6 拍板 A：1:N 逐行独立比，epsilon=1e-2）
function compareT1OpWithComputed(t1OpRows, computedT1Map) {
  // 先按账户号分组 T-1 行
  const t1ByAccount = new Map();
  for (const r of t1OpRows) {
    const accKey = normalizeAccountKey(r.account_no);
    if (!accKey) continue;
    if (!t1ByAccount.has(accKey)) t1ByAccount.set(accKey, []);
    t1ByAccount.get(accKey).push(r);
  }

  const diffRows = [];
  let amountDiffCount = 0;
  let multiOpAccountCount = 0;

  for (const [accKey, t1Rows] of t1ByAccount) {
    const calcT1 = computedT1Map.get(accKey);
    if (calcT1 === undefined) continue;  // T-1 有 T-2 无场景，§5.1 步骤 5.a 单独处理（不在这里）

    const isMulti = t1Rows.length > 1 ? '是' : '否';
    if (t1Rows.length > 1) multiOpAccountCount += 1;

    for (const r of t1Rows) {
      const t1End = parseAmount(r.end_balance);
      if (Number.isNaN(t1End)) continue;  // 理论上导入已拦截，对账阶段二次保护
      const diff = Math.abs(t1End - calcT1);
      if (diff > AMOUNT_EPSILON) {
        // 不相等 → 进 diff 表（v0.3 fix2.4 回滚：差异表 writer 不再标黄；进表条件不变）
        diffRows.push({
          source_table: 'T1',
          source_row_id: r.id,
          cmp_t2: '',
          multi_op_flag: isMulti,
          cmp_amount: '不相等',
          amount_diff: String(diff)  // 字符串保精度
        });
        amountDiffCount += 1;
      } else {
        // 相等
        if (t1Rows.length >= 2) {
          // v0.5 fix5 选项 B：多 OP 账户的相等行也 push diffRows
          // meta = 相等/空/是；amountDiffCount 不累加（仅 unequal 行计入差异计数）
          diffRows.push({
            source_table: 'T1',
            source_row_id: r.id,
            cmp_t2: '',
            multi_op_flag: '是',          // 多 OP 必定 = 是
            cmp_amount: '相等',
            amount_diff: ''               // 相等 → 空字符串
          });
        }
        // 单 OP 相等行 → 不进 diff 表（原规则保留）
      }
    }
  }

  return { diffRows, stats: { amountDiffCount, multiOpAccountCount } };
}

// T-1 vs T-2 账户号差集
function diffT1AndT2Accounts(t1OpRows, t2OpRows) {
  const t1AccMap = new Map(); // accKey → 第一行（用于"T-1有T-2无"按 acc 取代表行）
  const t2AccMap = new Map();
  for (const r of t1OpRows) {
    const k = normalizeAccountKey(r.account_no);
    if (!t1AccMap.has(k)) t1AccMap.set(k, r);
  }
  for (const r of t2OpRows) {
    const k = normalizeAccountKey(r.account_no);
    if (!t2AccMap.has(k)) t2AccMap.set(k, r);
  }

  const onlyInT1 = [];  // T-1 有 T-2 无：所有 T-1 行（按账户号），来源 T-1
  const onlyInT2 = [];  // T-2 有 T-1 无：所有 T-2 行（按账户号），来源 T-2
  for (const r of t1OpRows) {
    const k = normalizeAccountKey(r.account_no);
    if (!t2AccMap.has(k)) onlyInT1.push(r);
  }
  for (const r of t2OpRows) {
    const k = normalizeAccountKey(r.account_no);
    if (!t1AccMap.has(k)) onlyInT2.push(r);
  }
  return { onlyInT1, onlyInT2 };
}
```

#### 5.2.1 算法关键不变量（与 PRD §3.5.5 同步，round 2 R2-I2 补充）

> 本节固化 `computeT1Op` 的容错路径与 `t2AnomalyAccountCount` 统计的边界，避免 reviewer / PR audit 时 spec ↔ code 偏差。

1. **完全 silent drop**：T-2 期末余额非数值的账户号 → 跳过 `computedT1Map.set`（与 round 1 前行为一致，不退化）→ 该账户号在 §3.4.2 步骤 4.2.b 会走"T-1 有 T-2 无"分支（cmp_t2='T-1有T-2无'）

2. **同账户号多行（部分 NaN 容错路径，round 2 R2-I2 补充）**：仅当账户号**所有行都 NaN** 才进 `anomalyAccountSet`；任一行 valid 则用 valid 行的期末 + flowSum 写 map，**不计入 anomaly**。code 实现通过循环中分别累积 `validAccountSet` + `anomalyAccountSet`，循环结束做集合差（`for (const acc of validAccountSet) anomalyAccountSet.delete(acc)`，详见 §5.2 `computeT1Op` 实现）。该行为属于 round 1 fix 时的设计延伸，比规则 1 更宽松，便于真实数据中部分行被 Excel 转码异常时仍能跑通对账（不退化为 silent drop 整账户）

3. **caller 输出 console.warn**（round 2 R2-M3 文案 spec 跟 code 走）：`runReconciliation` 在循环 `anomalyAccountSet` 时按以下文案输出（不在 `computeT1Op` 内部输出，便于 caller 拿到 `t2Date` / `buName` 上下文）：
   ```
   [biz-op-recon] T-2 end_balance NaN silent drop date=${t2Date} bu=${buName} account=${acc} (该账户在 T-1 实际 OP 与差异表均不可见，请检查源文件期末余额字段)
   ```
   原 v0.7 spec 文案 `[biz-op-recon] T-2 NaN end_balance: 账户={accKey} BU={buName} 原值="{raw}"...` 与 code 实际输出不一致 → round 2 改为 code 实际版本（采纳 code 为 source of truth）

4. **summary 字段语义**：
   - `summary.t2AnomalyAccountCount = t2AnomalyAccounts.size`（即 `computeT1Op` 返回的 `anomalyAccountSet.size`，已经过 R2-I2 集合差容错）
   - 不影响 `amountDiffCount` / `multiOpAccountCount` / `t1NotT2Count` 等其它统计字段
   - `t2AnomalyAccountCount === 0` 表示 T-2 数据干净；> 0 提醒用户核查 T-2 文件是否有 `#N/A` / 空字符串 / 含字母等

### 5.3 业务 OP 行双重校验（#1 拍板 B）

```javascript
// src/backend/biz-op-recon-import/validator.js
// round 2 R2-M5 spec ↔ code 同步：AMOUNT_EPSILON 不再在本文件定义（M2 round1 后单一来源在 columns.js）
//   import { AMOUNT_EPSILON } from '../biz-op-recon-db/columns'
const { AMOUNT_EPSILON } = require('../biz-op-recon-db/columns');  // 单一来源（M2 提取）

function validateBizOpRow(row) {
  const begin = parseAmount(row.begin_balance);
  const amt = parseAmount(row.amount);
  const amtIn = parseAmount(row.amount_in);
  const amtOut = parseAmount(row.amount_out);
  const end = parseAmount(row.end_balance);

  // 任一关键字段非数值 → 校验失败
  if ([begin, amt, amtIn, amtOut, end].some(Number.isNaN)) {
    return {
      ok: false,
      reason: `字段非数值：期初=${row.begin_balance} 发生额=${row.amount} 入=${row.amount_in} 出=${row.amount_out} 期末=${row.end_balance}`
    };
  }

  // 校验 (1): 发生额 == 发生额（入） - 发生额（出）
  const diff1 = Math.abs(amt - (amtIn - amtOut));
  if (diff1 > AMOUNT_EPSILON) {
    return {
      ok: false,
      reason: `双重校验失败：发生额 ${amt} ≠ 发生额(入) ${amtIn} - 发生额(出) ${amtOut}，差额 ${diff1.toFixed(4)}`
    };
  }

  // 校验 (2): 期末余额 == 期初余额 + 发生额
  const diff2 = Math.abs(end - (begin + amt));
  if (diff2 > AMOUNT_EPSILON) {
    return {
      ok: false,
      reason: `双重校验失败：期末余额 ${end} ≠ 期初余额 ${begin} + 发生额 ${amt}，差额 ${diff2.toFixed(4)}`
    };
  }

  return { ok: true };
}

// 流水「出入方向」枚举校验（#3 拍板）
function validateFlowRow(row) {
  const dir = String(row.direction == null ? '' : row.direction).trim();
  if (dir !== '入' && dir !== '出') {
    return {
      ok: false,
      reason: `出入方向非法：实际值 "${row.direction}"，仅允许 "入" 或 "出"`
    };
  }
  // 对账金额必须可解析为数值
  const amt = parseAmount(row.recon_amount);
  if (Number.isNaN(amt)) {
    return { ok: false, reason: `对账金额非数值：${row.recon_amount}` };
  }
  // 账户号非空
  if (!String(row.account_no || '').trim()) {
    return { ok: false, reason: `账户编号为空` };
  }
  return { ok: true };
}
```

### 5.4 整批拒绝 + 失败报告流程（#5 拍板）

```javascript
// src/main-process/biz-op-recon-session.js
async function runBizOpImport({ date, filePath }) {
  const { headers, rows, rowIndices } = readBizOpXlsx(filePath);  // reader.js

  // 1. 表头校验
  const headerResult = validateBizOpHeaders(headers);
  if (!headerResult.ok) return { status: 'rejected', errorReportPath: null, errorRows: [{ rowIndex: 1, reason: headerResult.error }] };

  // 2. 逐行双重校验，收集所有失败行
  const errorRows = [];
  const buName = rows[0]?.bu_name_raw;  // 取第一行的"业务方"作为 BU（落库时校验所有行 bu_name 一致）
  // ...buName 一致性校验

  for (let i = 0; i < rows.length; i++) {
    const result = validateBizOpRow(rows[i]);
    if (!result.ok) {
      errorRows.push({ rowIndex: rowIndices[i], reason: result.reason, rawRow: rows[i] });
    }
  }

  // 3. #5 拍板：任一失败 → 整批拒绝
  if (errorRows.length > 0) {
    const errorReportPath = await writeErrorReportXlsx({
      date, buName, errorRows, headers,
      saveDir: path.join(app.getPath('documents'), '网银账单生成小助手', 'error-reports', date),
      fileName: `业务OP校验失败报告_${buName}_${formatDateCompact(date)}_${formatTime()}.xlsx`
    });
    return { status: 'rejected', errorReportPath, errorRows: errorRows.map(e => ({ rowIndex: e.rowIndex, reason: e.reason })) };
  }

  // 4. 全部通过 → 同事务内：DELETE 同 (date, BU) 的 diff_rows / runs / imports → INSERT 新行（#4 + #15）
  const txn = db.transaction(() => {
    repo.clearByDateBu(db, date, buName);  // 内部按 #15 顺序：diff_rows → runs → imports
    repo.insertRows(db, date, buName, rows, rowIndices);
  });
  txn();

  return { status: 'success', buName, validCount: rows.length };
}

// 流水导入同理（用 validateFlowRow + writeErrorReportXlsx with FLOW_HEADERS）
```

### 5.5 失败报告 xlsx 结构（writer.js 内）

详见 §六 §6.3。

---

## 六、Writer（差异表导出 + 失败报告，ExcelJS）

### 6.1 单日差异表导出（1 文件 1 sheet，#9/#10/#14 拍板）

> **v0.3 fix2.4 回滚**：#10 拍板 E — writer **不再标黄**；保留进表过滤（cmp_t2 非空 OR cmp_amount=='不相等'）与 4 列 meta 字段。`YELLOW_FILL` 常量在差异表 writer 中**不再调用**；失败报告 writer (§6.3) 仍可保留该常量（如希望失败行视觉强调）或一并移除，由 Dev 在 PR 中决定。

```javascript
// src/main-process/biz-op-recon-writer.js
const ExcelJS = require('exceljs');

// v0.3：YELLOW_FILL 在差异表 writer 中不再调用；保留导出供失败报告 writer §6.3 使用
const YELLOW_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
const DIFF_HEADER_TAIL = ['比对T-2日', '同账户号多个OP', '比对测算金额', '测算金额差额'];

async function writeSingleDateDiffWorkbook({ date, buName, runId, savePath }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(date);  // #14 拍板 A：sheet 名 = 'YYYY-MM-DD'（如 '2026-05-13'）

  // 表头：23 列业务 OP + 4 新增字段
  const headers = [...BIZ_OP_HEADERS, ...DIFF_HEADER_TAIL];
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true, size: 10 };

  // 查询差异行（按 run_id；#10 拍板 E fix2 回滚：差异行仍落 diff_rows，writer 全部输出但不标黄）
  const diffRows = repo.getDiffRowsByRun(db, runId);
  for (const dr of diffRows) {
    // 取源行（T1 → biz_op_recon_imports data_date=date；T2 → data_date=subOneDay(date)）
    const sourceRow = repo.getBizOpRowById(db, dr.source_row_id);
    const rowData = bizOpRowToArray(sourceRow).concat([dr.cmp_t2, dr.multi_op_flag, dr.cmp_amount, dr.amount_diff]);
    sheet.addRow(rowData);
    // v0.3 fix2.4 回滚：无 r.eachCell + fill 调用；差异表所有行白底
  }

  await workbook.xlsx.writeFile(savePath);
  return { filePath: savePath };
}
```

**默认文件名（#9 拍板 A）**：
```
业务OP数据核对_{BU}_{YYYYMMDD}_{HHMMSS}.xlsx
例：业务OP数据核对_BU-A_20260513_143052.xlsx
```

### 6.2 区间差异表导出（1 文件 1 sheet「差异」，**v0.6 fix6 拍板回滚**）

> **fix6 拍板回滚**：原 v0.5 设计 = N sheet（每个 success 日期一 sheet，sheet 名 = `YYYY-MM-DD` ISO）；v0.6 回滚为**单 sheet「差异」**，所有日期差异行合并到该 sheet，按 data_date 升序 + 同日内 source_account_key 升序排序。
>
> **不加新列**（不引入「数据日期」列）：日期区分依赖原 xlsx 第 1 列 Billdate（业务OP 23 列原表头第 1 列）。
>
> **已知风险**：Billdate（xlsx 原作者填的字段）可能与 data_date（用户导入时选的所属日期）不一致 → writer 阶段对每一行做一致性检查，不一致时写 `console.warn`（不弹 UI、不阻断流程；用户可在 DevTools / 状态栏日志查 warn 记录辅助 debug）。
>
> **DB schema 不变**：`diff_rows` 表结构沿用 v0.5；本次仅 writer 渲染层改动。

```javascript
async function writeDateRangeDiffWorkbook({ buName, startDate, endDate, savePath }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('差异');  // v0.6 fix6 拍板：固定 sheet 名「差异」（单 sheet）
  sheet.addRow([...BIZ_OP_HEADERS, ...DIFF_HEADER_TAIL]);  // 23 + 4 = 27 列（不加新列）
  sheet.getRow(1).font = { bold: true, size: 10 };

  // #13 拍板 A：复用 listSuccessDates 风格
  const successDates = repo.listSuccessDatesInRange(db, buName, startDate, endDate);
  const skippedDates = listDatesInRange(startDate, endDate).filter(d => !successDates.find(s => s.date === d));

  // v0.6 fix6：一次性收集所有日期的 diff_rows 再排序，再批量 addRow
  const allRows = [];
  for (const { date, runId } of successDates) {
    const diffRows = repo.getDiffRowsByRun(db, runId);
    for (const dr of diffRows) {
      const sourceRow = repo.getBizOpRowById(db, dr.source_row_id);
      // Billdate vs data_date 一致性检查（v0.6 fix6 新增；console.warn 不阻断流程）
      const billDateRaw = sourceRow.bill_date_raw;
      if (billDateRaw && normalizeDateForCompare(billDateRaw) !== date) {
        console.warn(
          `[biz-op-recon writer] Billdate ≠ data_date: ` +
          `账户=${sourceRow.account_no} BU=${buName} ` +
          `Billdate="${billDateRaw}" data_date="${date}"（已按 data_date 排序导出，但原表 Billdate 列保留原值，请用户核查源文件）`
        );
      }
      allRows.push({
        dataDate: date,
        accountKey: normalizeAccountKey(sourceRow.account_no),
        rowData: bizOpRowToArray(sourceRow).concat([dr.cmp_t2, dr.multi_op_flag, dr.cmp_amount, dr.amount_diff]),
      });
    }
  }

  // v0.6 fix6：排序 — data_date 升序 + 同日内 source_account_key 升序
  // round 1 M4 修订：accountKey 必须用 normalizeAccountKey(sourceRow.account_no)（仅 trim）
  // 与 session.js / repository 跨文件保持一致；不能直接用原值（可能含首尾空白导致排序错乱）
  allRows.sort((a, b) => {
    if (a.dataDate !== b.dataDate) return a.dataDate < b.dataDate ? -1 : 1;
    if (a.accountKey !== b.accountKey) return a.accountKey < b.accountKey ? -1 : 1;
    return 0;
  });

  for (const r of allRows) {
    sheet.addRow(r.rowData);
    // v0.3 fix2.4 回滚：无 fill 调用；区间 sheet 行白底
  }

  // 区间内无 success run → sheet「差异」保持仅表头（无数据行），保留 skippedDates 通知用户
  await workbook.xlsx.writeFile(savePath);
  return { filePath: savePath, sheetCount: 1, totalRows: allRows.length, skippedDates };
}
```

**默认文件名（#9 拍板 A）**：
```
业务OP数据核对_{BU}_{YYYYMMDD}-{YYYYMMDD}_{HHMMSS}.xlsx
例：业务OP数据核对_BU-A_20260510-20260513_143052.xlsx
```

### 6.3 失败报告 writer（#5 拍板）

```javascript
// src/main-process/biz-op-recon-writer.js（同文件）

// 业务 OP 失败报告：原 23 列 + 末尾 2 列（失败行号 + 失败原因）= 25 列
const ERROR_HEADER_TAIL = ['失败行号', '失败原因'];

async function writeBizOpErrorReportXlsx({ date, buName, errorRows, saveDir, fileName }) {
  await fs.promises.mkdir(saveDir, { recursive: true });
  const savePath = path.join(saveDir, fileName);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(date);  // 单 sheet 名 = 日期 ISO

  // 表头：原 23 列 + 失败行号 + 失败原因
  sheet.addRow([...BIZ_OP_HEADERS, ...ERROR_HEADER_TAIL]);
  sheet.getRow(1).font = { bold: true, size: 10 };

  for (const e of errorRows) {
    // e = { rowIndex, reason, rawRow }
    const rowData = bizOpRowToArray(e.rawRow).concat([e.rowIndex, e.reason]);
    const r = sheet.addRow(rowData);
    // v0.3 备注：差异表 writer 已按 fix2.4 移除黄底；失败报告是否同步去黄底由 Dev 在 PR 中决定（原拍板未明确回滚失败报告）
    r.eachCell((cell) => { cell.fill = YELLOW_FILL; });
  }

  await workbook.xlsx.writeFile(savePath);
  return savePath;
}

// 流水失败报告：原 28 列 + 失败行号 + 失败原因 = 30 列
async function writeFlowErrorReportXlsx({ date, errorRows, saveDir, fileName }) {
  await fs.promises.mkdir(saveDir, { recursive: true });
  const savePath = path.join(saveDir, fileName);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(date);

  sheet.addRow([...FLOW_HEADERS, ...ERROR_HEADER_TAIL]);
  sheet.getRow(1).font = { bold: true, size: 10 };

  for (const e of errorRows) {
    const rowData = flowRowToArray(e.rawRow).concat([e.rowIndex, e.reason]);
    const r = sheet.addRow(rowData);
    // v0.3 备注：见上 writeBizOpErrorReportXlsx 注释
    r.eachCell((cell) => { cell.fill = YELLOW_FILL; });
  }

  await workbook.xlsx.writeFile(savePath);
  return savePath;
}
```

**业务 OP 失败报告文件名**：
```
业务OP校验失败报告_{BU}_{YYYYMMDD}_{HHMMSS}.xlsx
保存路径：Documents/网银账单生成小助手/error-reports/{date}/
```

**流水失败报告文件名**：
```
流水对账单校验失败报告_{YYYYMMDD}_{HHMMSS}.xlsx
保存路径：Documents/网银账单生成小助手/error-reports/{date}/
```

**失败原因文案示例**（写入"失败原因"列）：
- `双重校验失败：期末余额 12345.67 ≠ 期初余额 10000.00 + 发生额 2345.00，差额 0.6700`
- `双重校验失败：发生额 100.00 ≠ 发生额(入) 150.00 - 发生额(出) 40.00，差额 10.0000`
- `字段非数值：期初=abc 发生额=100 入=80 出=20 期末=180`
- `出入方向非法：实际值 "DEBIT"，仅允许 "入" 或 "出"`
- `对账金额非数值：xyz`
- `账户编号为空`

---

## 七、前端 DOM 与状态机

### 7.1 HTML 结构（`index.html` 新增 section）

```html
<section id="bizOpReconModulePanel" class="control-board module-panel" hidden>
  <div class="control-row">
    <div class="cell left"></div>
    <div class="cell right">
      <div class="biz-op-recon-action-pair">
        <button id="bizOpReconImportBtn" class="primary-btn" type="button">导入文件</button>
        <button id="bizOpReconRunBtn" class="primary-btn" type="button" disabled>开始运行</button>
      </div>
    </div>
  </div>
  <div class="control-row">
    <div class="cell left">
      <!-- BU 单选下拉 + 标签 BU（在「导出差异」按钮上侧） -->
      <div class="biz-op-recon-bu-row">
        <span class="biz-op-recon-bu-label">BU</span>
        <select id="bizOpReconBuSelect" class="mapping-text-input biz-op-recon-bu-select" disabled>
          <option value="">— 请先导入业务OP数据 —</option>
        </select>
      </div>
      <button id="bizOpReconExportBtn" class="secondary-btn" type="button" disabled>导出差异</button>
    </div>
    <div class="cell right">
      <div id="bizOpReconStatusBox" class="status-box">
        <span class="status-spark" aria-hidden="true">...</span>
        <span class="status-box-text">欢迎使用小助手</span>
      </div>
    </div>
  </div>
</section>
```

### 7.2 主导航按钮（`index.html`）

```html
<button class="nav-module-btn" data-module="biz-op-recon">业务OP数据核对</button>
```

### 7.3 DOM 标识列表（renderer.js `elements` 缓存）

| 标识 | 类型 | 用途 |
|---|---|---|
| `bizOpReconModulePanel` | section | 模块面板根节点 |
| `bizOpReconImportBtn` | button | "导入文件" |
| `bizOpReconRunBtn` | button | "开始运行" |
| `bizOpReconBuSelect` | select | BU 下拉框 |
| `bizOpReconBuRow` | div | BU 标签 + 下拉的行容器（样式 anchor） |
| `bizOpReconExportBtn` | button | "导出差异" |
| `bizOpReconStatusBox` | div | 状态栏 |

### 7.4 按钮 enable 条件

| 按钮 | 启用条件 |
|---|---|
| 导入文件 | 永远 enabled |
| BU 下拉框 | `buList.length > 0` |
| 开始运行 | `selectedBu != '' && readyDates.length > 0`（即 BU 已选 + 该 BU 下至少 1 个日期"三件齐"） |
| 导出差异 | `selectedBu != '' && successDates.length > 0` |

### 7.5 模块状态机（参照 v2.1.2 `bankBuReconState`）

```javascript
const bizOpReconState = {
  buList: [],         // [{buName, count}]，option label 仅显示 buName（v0.3 fix2.2：去除行数量附加）
  selectedBu: '',
  readyDatesCount: 0,
  successDatesCount: 0
};

async function refreshBizOpReconButtons() {
  // 拉 BU 列表 + ready 日期 + success 日期
  const bus = await window.desktopApi.bizOpRecon.listBu();
  const previousSelected = bizOpReconState.selectedBu;
  bizOpReconState.buList = bus;

  // v0.3 fix2.3：BU 下拉渲染策略
  //   - buList 为空 → 单一空白 placeholder option（继承 fix1.2）+ select disabled + selectedBu=''
  //   - buList 非空 → 移除空白 placeholder + 默认选中第一项；smart preserve：
  //       若 previousSelected 仍在新 buList 中 → 保留；否则 → 重置为第一项 buList[0].buName
  if (bus.length === 0) {
    bizOpReconState.selectedBu = '';
  } else {
    const stillPresent = bus.some(b => b.buName === previousSelected);
    bizOpReconState.selectedBu = stillPresent ? previousSelected : bus[0].buName;
  }
  // 重新渲染 BU 下拉（option label 仅 buName，不附加 ` (N 行)`，fix2.2）

  // 拉 ready/success
  const [ready, success] = await Promise.all([
    bizOpReconState.selectedBu ? window.desktopApi.bizOpRecon.listReadyDates({ buName: bizOpReconState.selectedBu }) : [],
    bizOpReconState.selectedBu ? window.desktopApi.bizOpRecon.listSuccessDates({ buName: bizOpReconState.selectedBu }) : []
  ]);
  bizOpReconState.readyDatesCount = ready.length;
  bizOpReconState.successDatesCount = success.length;
  // 同步按钮 disabled 状态
}
```

**fix2.1 CSS 视觉约束**（实施细节）：BU 行容器（`bizOpReconBuRow`）的左右边界与"导出差异"按钮（`bizOpReconExportBtn`）左右边界完全对齐；建议通过 `.biz-op-recon-bu-row { width: 100%; box-sizing: border-box; }` + 按钮同级容器统一宽度实现，Dev 在 PR 中 self-review 截图核对。

### 7.6 新增 dialog factory（`renderer-dialogs.js`，**4 个**[^dialog-count]；v0.3 fix1.5 + fix2 删除 ErrorReportDialog 后实际剩 4 个；round 1 M3 修订：spec 描述从 5 同步为 4）

| factory 名 | 用途 | 参照 / 配置 |
|---|---|---|
| `createBizOpReconDatePickerDialog({title, defaultDate, onConfirm, onCancel})` | "选择业务OP所属日期" / "选择流水对账单所属日期" 通用日期选择 | 参照 v2.1.2 `createBankBuReconMonthPickerDialog` + 扩展第 3 个下拉"日"。**#8 拍板 A**：年下拉 = `[currentYear-1, currentYear, currentYear+1]`（如 2025/2026/2027）；月下拉 = 1-12；日下拉 = 1-31（**三个下拉不联动**，错选日期由后端 `import:run-biz-op` 拒绝并状态栏报错）。**默认值 defaultDate** = 系统日期 - 1（fix1.4 / fix2.5 拍板；调用方在拉起业务OP / 流水对账单日期对话框时统一传入 `subOneDay(today)` 作为 defaultDate） |
| `createBizOpReconReconcileDialog({readyDates, defaultDate, onConfirm, onCancel})` | "开始运行" — 选对账日期 | 参照 v2.1.2 `createBankBuReconReconcileDialog`。**#12 拍板 A**：日期下拉 option 仅来自 `readyDates`（IPC `bizOpRecon:run:list-ready-dates` 返回）；`readyDates.length === 0` 时 `完成` 按钮 disabled。**fix2.5 明确不改**：本对话框保持 ready 日期列表展示，**不**做"默认 T-1"处理 |
| `createBizOpReconExportDialog({successDates, onConfirm, onCancel})` | "导出差异" — 两 radio + 单日 / 区间联动 | 参照 v2.1.2 `createBankBuReconExportDialog`。**#9 拍板 A** 文件名格式 / **#13 拍板 A** `successDates` 来自 `bizOpRecon:export:list-success-dates`；radio 切换时控制单日下拉 vs 区间下拉的 disabled |
| `createBizOpReconSecondImportPromptDialog({firstDate, onConfirm, onCancel})` | **#11 拍板 B**：第 1 日业务 OP 导入完成后弹「已导入第 1 日数据（{firstDate}），是否立即导入第 2 日？」。点 `是` → 再走一轮业务OP 导入流程（renderer 直接调 `createBizOpReconDatePickerDialog` 选日期 + IPC `bizOpRecon:import:pick-biz-op-file` 选文件 + IPC `bizOpRecon:import:run-biz-op` 落库；日期选择不走 IPC，详见 §7.6 round 2 R2-M1 修订段）；点 `否` → 状态栏提示"待手动再次点击导入按钮" | 参照 v2.1.2 `createBankBuReconFileImportPromptDialog` 同结构 |

> **v0.3 删除**：`createBizOpReconErrorReportDialog` factory（fix1.5 已无业务调用 → fix2 一并删除）。校验失败提示由"独立报错对话框"改为**状态栏文字 + 失败报告路径**；用户可在 OS 内 cmd+点击路径打开（IPC `bizOpRecon:import:open-error-report-folder` 仍保留供后续可能场景调用，但当前主流程不再触发）。
>
> **round 1 M3 修订（2026-05-14）**：原 spec §7.6 文字描述了 5 个 factory（含 `createBizOpReconFileImportPromptDialog`），但实际代码 fix1.5/fix2 删除 ErrorReportDialog 后实际仅剩 4 个；本次同步把 `createBizOpReconFileImportPromptDialog` 一并从 spec 表格中移除（renderer-dialogs.js 中也无该 factory 实现）。表格仅保留代码实际存在的 4 个。
>
> **round 2 R2-M1 修订（2026-05-14）**：日期选择对话框（业务OP 日期 / 流水对账单日期）由前端 dialog factory `createBizOpReconDatePickerDialog` 直接处理，**不走 IPC**（spec §三 IPC 表中原 `bizOpRecon:import:pick-biz-op-date` / `bizOpRecon:import:pick-flow-date` 在 main.js / preload.js 实际无定义，已 round 2 删除）。前端调用入口：`src/renderer.js:4179`（业务OP 日期 — fix1.4 默认值 = subOneDay(today)）+ `src/renderer.js:4255`（流水日期 — fix2.5 默认值 = subOneDay(today)）；对话框实现 `src/renderer-dialogs.js:8067` `createBizOpReconDatePickerDialog`。defaultDate 由 caller 传入（renderer 端用 JS Date 计算 `subOneDay(today)`，与 backend 的 `subOneDay` 双源 R2-M4 解耦）。

[^dialog-count]: round 1 M3 修订前 spec 描述为 5 个，实际代码仅 4 个（fix1.5+fix2 已删 ErrorReportDialog）。round 1 把 spec 描述同步为 4 个。**known issue（KI-1，详见 PRD §6.5）**：v2.1.2 月度BU 模块同位置有 `createBankBuReconFileImportPromptDialog`（导入文件前提示弹原生窗），v2.1.3 业务OP 模块当前缺失同位置 dialog；**留 v2.1.4 补齐**（round 1-7 都未补，KI-1 持续保留）。

---

## 八、文件路径

| 路径 | 类型 | 内容 |
|---|---|---|
| `src/main-process/biz-op-recon-session.js` | 新建 | session/run 状态管理 + 对账算法（§五）+ helper 函数（normalizeBu / parseSignedAmount 等） |
| `src/main-process/biz-op-recon-writer.js` | 新建 | 差异 Excel 导出（§6.1 / §6.2）+ 失败报告 xlsx writer（§6.3） |
| `src/backend/biz-op-recon-db/migrations.js` | 新建 | **4 张表** DDL（§四，imports / flow_imports / runs / diff_rows，**无 errors 表**） |
| `src/backend/biz-op-recon-db/columns.js` | 新建 | `BIZ_OP_HEADERS`（23 列冻结数组）+ `FLOW_HEADERS`（28 列冻结数组）+ 表头到 DB 列名映射函数 |
| `src/backend/biz-op-recon-db/imports-repository.js` | 新建 | `biz_op_recon_imports` CRUD：`clearByDateBu` / `insertRows` / `getRowsByDateBu` / `listDistinctBus` / `listImportedDateBuPairs` / `getRowById` |
| `src/backend/biz-op-recon-db/flow-imports-repository.js` | 新建 | `biz_op_recon_flow_imports` CRUD：`clearByDate` / `insertRows` / `getRowsByDate` / `getRowsByDateBu` / `listImportedDates` |
| `src/backend/biz-op-recon-db/run-repository.js` | 新建 | `biz_op_recon_runs` + `biz_op_recon_diff_rows` CRUD：`insertRun` / `getRunById` / `listRunsByDateBu` / `listSuccessDates` / `listSuccessDatesInRange` / `listReadyDates` / `insertDiffRows` / `getDiffRowsByRun` / `clearRunsAndDiffsByDateBu`（**#15 联动清空，按 (date, BU) 单 BU 清**） / **`clearRunsAndDiffsByDate`（round 3 P1 资金红线新增，按 date 跨所有 BU 清，流水重导专用，详见 §五 算法签名表 + PRD §3.5.6）** |
| `src/backend/biz-op-recon-import/reader.js` | 新建 | xlsx 读（SheetJS）+ `blankrows:true` 保留行号（参照 v2.1.2 F5 fix）；通用业务OP / 流水 reader |
| `src/backend/biz-op-recon-import/validator.js` | 新建 | `validateBizOpHeaders` / `validateFlowHeaders` / `validateBizOpRow`（**#1 拍板 B 双重校验**）/ `validateFlowRow`（**#3 拍板 出入方向枚举**） |
| `src/main.js` | 修改 | 追加 `bizOpRecon:*` IPC handlers（共 15 个；5 tracked + 10 plain，见 §三） |
| `src/preload.js` | 修改 | 追加 `window.desktopApi.bizOpRecon.*` 暴露 |
| `index.html` | 修改 | 主导航第 5 按钮 + `bizOpReconModulePanel` section |
| `src/renderer.js` | 修改 | 模块切换 + 状态机 + 按钮联动 + BU 下拉渲染 + 状态栏 |
| `src/renderer-dialogs.js` | 修改 | 新增 **4 个** factory（§7.6 表格实际 4 行；v0.3 fix1.5 + fix2 删除 ErrorReportDialog 后；round 1 M3 同步 spec 描述 — `createBizOpReconFileImportPromptDialog` 仅 PRD §6.5 KI-1 描述未实现，留 v2.1.4 补） |
| `scripts/smoke-test.js` | 修改 | 新增 7 用例 A-G（§九） |
| `scripts/preview-biz-op-recon.js` | 新建 | preview script（参照 `preview-bank-bu-recon.js`） |
| `assets/preview-biz-op-recon-initial.png` | 新建 | preview 截图 |
| `assets/preview-biz-op-recon-importing.png` | 新建 | preview 截图 |
| `assets/preview-biz-op-recon-result.png` | 新建 | preview 截图 |
| `assets/preview-biz-op-recon-export-dialog.png` | 新建 | preview 截图 |
| `package.json` | 修改 | version 2.1.2 → 2.1.3 + `preview:biz-op-recon` script |
| `CHANGELOG.md` | 修改 | v2.1.3 段落 |
| `docs/VERSION_FEATURE_HISTORY.md` | 修改 | v2.1.3 行 |
| `docs/USER_GUIDE.md` | 修改 | 新增"业务OP数据核对"章节 |
| `src/backend/database/migrations.js` | 修改 | 调用 `biz-op-recon-db/migrations` 4 张表 |

---

## 九、smoke 测试用例（新增 ≥ 3 个，参照 v2.1.2 风格）

### 9.1 用例 A：核心对账（资金红线）

- 构造：2026-05-12 业务OP（BU=A）3 个账户 + 2026-05-11 业务OP（BU=A）3 个相同账户 + 2026-05-12 流水对账单 5 行（业务部门=A）
- 对账：跑 `bizOpRecon:run({ date: '2026-05-12', buName: 'A' })`
- 期望：`amount_diff_count` 与构造时刻意造的差异行数匹配；`t1_not_t2_count==0`，`t2_not_t1_count==0`

### 9.2 用例 B：多 OP 行精准标差异

- 构造：T-1 业务OP 同账户号 3 行（其中 P[1] 期末余额对得上计算 T-1，P[2]/P[3] 对不上）
- 期望：进 diff_rows 表的 2 行（P[2]/P[3]）的「同账户号多个OP」列均 = `是`、「比对测算金额」= `不相等`（P[1]「相等」行不进表）；导出 sheet 中两行**无黄底**（v0.3 fix2.4 回滚）

### 9.3 用例 C：账户号增减差异

- 构造：T-1 业务OP 含账户 `A1, A2, A3`（A3 是新增），T-2 业务OP 含 `A1, A2, A4`（A4 是销户）
- 期望：差异表含 2 行：A3 行 `比对T-2日='T-1有T-2无'` + 来源 T-1；A4 行 `比对T-2日='T-2有T-1无'` + 来源 T-2

### 9.4 用例 D：流水累加 + 出入方向（资金红线，#3 拍板）

- 构造：T-1 流水 5 行（混合「入」3 行和「出」2 行）+ T-2 业务OP 1 个账户 + T-1 业务OP 同账户
- 期望：
  - `parseSignedAmount('入', x) === +x`，`parseSignedAmount('出', x) === -x`
  - 累加结果 = 入合计 - 出合计
  - 计算 T-1 期末余额 = T-2 期末 + 累加值

### 9.5 用例 E：业务OP 行整批拒绝 + 失败报告（#1 + #5 拍板）

- 构造：业务OP 文件含 5 行，其中 2 行违反双重校验：
  - 第 3 行 `发生额 ≠ 入 - 出`
  - 第 7 行 `期末余额 ≠ 期初 + 发生额`
- 期望：
  - `biz_op_recon_imports` 落 **0 行**（事务回滚）
  - `error-reports/{date}/业务OP校验失败报告_{BU}_{YYYYMMDD}_{HHMMSS}.xlsx` 生成，含 2 行（行号 3 / 7，失败原因文案明确）
  - `runBizOpImport` 返回 `{status:'rejected', errorReportPath, errorRows:[{rowIndex:3,...},{rowIndex:7,...}]}`

### 9.6 用例 F：日期区间导出（#14 拍板）

- 构造：2026-05-10, 11, 12 三日均 success run
- 期望：
  - 区间 2026-05-10 → 2026-05-12 导出 = 1 文件 3 sheet
  - sheet 名分别为 `2026-05-10` / `2026-05-11` / `2026-05-12`（ISO 格式）
  - `skippedDates = []`
- 反例：若 2026-05-11 未 success → sheet 数 = 2，`skippedDates = ['2026-05-11']`

### 9.7 用例 G：BU 隔离（#7 拍板）

- 构造：BU=A 的 T-1 业务OP 数据 + BU=B 的 T-1 业务OP 数据，流水对账单包含两 BU 各 3 行（含大小写不一致变体如 "BU-A" / "bu-a" / " BU-A "）
- 期望：
  - 选 BU=A 运行只统计 A 的账户（`normalizeBu('BU-A') === normalizeBu(' bu-a ') === 'bu-a'`，全部命中）
  - 不串 B 的数据
  - 流水累加值正确（按 normalizeBu 过滤，不漏不串）

### 9.8 用例 I：onlyInT1 多 OP 统计 + 防重复累加（fix4 资金红线 bug 回归，15 assertion）

- **背景**：v2.1.3 上线后用户反馈 B2B 2026-05-12 实有多 OP 账户但状态栏显示 0；根因 `runReconciliation` 5.a (onlyInT1 路径) 漏累加 multi_op_account_count（详见 PRD §3.5.4）
- **I-1**：T-1∩T-2 多 OP（主路径）→ multi_op_account_count 计入
- **I-2**：onlyInT1 多 OP（T-2 无该账户号 + T-1 有该账户号 ≥ 2 条）→ multi_op_account_count 仍非零（fix4 核心 bug 修复点）
- **I-3**：同账户号 N 行只算 1 个账户（multiOpAccountSeen Set 防重复累加）
- **期望**：3 个 sub-case 共 15 个 assertion 全部通过；状态栏数值与差异表 meta 列「同账户号多个OP」"是" 的账户号去重计数一致

### 9.9 用例 J：多 OP 相等行也进 diff_rows（fix5 选项 B PRD 修订回归）

- **背景**：v0.4 上线后用户测试 0512 BU=B2B 发现"业务OP 表 ACCT 有 2 行 / 差异表只有 1 行"，提出 PRD 修订（选项 B：多 OP 账户 N 行全进差异表）；本 case 防 `compareT1OpWithComputed` 退化为"相等行漏 push"
- **构造**：
  - T-2 (2026-05-11) 业务OP：`ACC-MULTI` × 1 行（期末余额 100）
  - T-1 (2026-05-12) 业务OP：`ACC-MULTI` × 3 行（期末余额 = 100 / 101 / 100；即 P[1] 相等、P[2] 不相等差 1、P[3] 相等）
  - T-1 (2026-05-12) 流水对账单：`ACC-MULTI` 当日净发生额 = 0 → 计算 T-1 期末 = 100
- **期望**：
  - `diff_rows.filter(r.source_account_key === 'ACC-MULTI').length === 3`（3 行全进，不再过滤相等行）
  - 3 行 meta「同账户号多个OP」均 = `是`
  - 第 1 / 第 3 行 meta「比对测算金额」= `相等`、「测算金额差额」= `""`（空字符串）
  - 第 2 行 meta「比对测算金额」= `不相等`、「测算金额差额」= `1`
  - 导出 xlsx sheet 该账户号 3 行（writer 1:1 取 diff_rows）
  - `summary.amountDiffCount === 1`（**仅不相等行计入差异计数**，相等多 OP 不累加；与 fix4 口径独立）
  - `summary.multiOpAccountCount === 1`（fix4 已修复口径，本 case 不受影响）
- **反例（防回归）**：若 `compareT1OpWithComputed` 退化为 v0.4 "相等行不进表"行为 → 该 case 失败（3 行只剩 1 行 P[2]），fix5 修订丢失

### 9.10 用例 K：区间导出单 sheet（fix6 PRD #14 拍板回滚）

- **背景**：v0.5 上线后用户测试通过、提出新需求"另外导出一个日期区间的差异文件，不要 sheet 存放数据，差异要放在一个 sheet 里"；本 case 防 `writeDateRangeDiffWorkbook` 退化为 v0.5 "N sheet 按日期分" 行为
- **构造**：BU=BU-A，三天数据：
  - T-2 (2026-05-10)：账户 `A1` × 1 行（期末 100）
  - T-1 (2026-05-11)：账户 `A1` × 1 行（期末 101，测算金额不相等差 1）+ 账户 `A2` × 1 行（onlyInT1 / 测算金额不相等差 5）
  - T-0 (2026-05-12)：账户 `A1` × 2 行（多 OP：一行相等 一行差 2）+ 账户 `A3` × 1 行（onlyInT1 / 测算金额不相等差 3）
  - 三天均跑对账成功（run 3 个）
- **导出**：`bizOpRecon:export:date-range({ buName:'BU-A', startDate:'2026-05-10', endDate:'2026-05-12' })`
- **期望**：
  - `wb.SheetNames.length === 1`
  - `wb.SheetNames[0] === '差异'`
  - sheet 数据行数 = 5（T-1 A1 不等 1 + T-1 A2 不等 1 + T-0 A1 多 OP 相等 1 + T-0 A1 多 OP 不等 1 + T-0 A3 不等 1）；表头行 = 1，共 6 行
  - 相邻行 data_date 不递减（按 data_date 升序：5-10? 无差异 / 5-11 / 5-11 / 5-12 / 5-12 / 5-12）
  - 同 data_date 内 source_account_key 不递减（5-12 行：A1 / A1 / A3）
  - 表头列数 = 27（23 业务OP + 4 meta）
  - **不存在「数据日期」列**（grep 表头数组）
  - `totalRows === 5`、`skippedDates === []`（三天均 success）
- **反例（防回归）**：
  - 若 writer 退化为 N sheet 行为 → `wb.SheetNames.length > 1` → 断言失败
  - 若 writer 引入「数据日期」列 → 表头列数 > 27 → 断言失败
  - 若排序丢失 → 相邻 data_date 递减 → 断言失败
- **附加场景**（可选）：构造一行 `Billdate ≠ data_date` 的源行 → 断言 `console.warn` 至少被调用一次（用 spy 拦截 console.warn）

### 9.11 用例 L：clearByDateBu 大小写归一防回归（round 1 C1 修订）—— **round 2 R2-I3 编号 swap，原 Case M → Case L**

> **round 2 R2-I3 swap 理由**：clearByDateBu 大小写归一（C1 资金红线）是 T-2 NaN 检测（I3）的**前置依赖**（imports 表数据正确才能跑出正确的 t2AnomalyAccountCount）；按依赖顺序排在前面更符合 smoke 阅读流。

- **背景**：v0.6 之前 `clearByDateBu` 的 SQL WHERE 直接用 `bu_name = ?`，未对齐 `getRowsByDateBu` 的 `LOWER(TRIM(?))`。当业务OP 文件第一行业务方 = `"BU-A"`、第二次导入文件业务方 = `" BU-A "`（首尾空格）→ clearByDateBu 清不掉 `"BU-A"` 旧行 → 旧+新数据混存（资金红线 P0）。round 1 C1 修订统一改 `LOWER(TRIM(bu_name)) = LOWER(TRIM(?))`。
- **构造**：
  - 第 1 次导入 (BU=`BU-A`, date=2026-05-12) 5 行业务OP
  - 跑对账 1 次 → diff_rows / runs 各 1 条
  - 第 2 次导入 (BU=` bu-a `, date=2026-05-12) 8 行业务OP（注意大小写差异 + 首尾空格）
- **期望**：
  - 第 2 次导入完成后 `SELECT COUNT(*) FROM biz_op_recon_imports WHERE data_date='2026-05-12' AND LOWER(TRIM(bu_name))='bu-a'` === 8（仅新数据，旧 5 行已清）
  - `SELECT COUNT(*) FROM biz_op_recon_runs WHERE data_date='2026-05-12' AND LOWER(TRIM(bu_name))='bu-a'` === 0（旧 run 已清）
  - `SELECT COUNT(*) FROM biz_op_recon_diff_rows WHERE run_id=<旧 runId>` === 0
- **反例（防回归）**：
  - 若 `clearByDateBu` 退化为 `bu_name = ?` 字面比较 → 第 2 次导入后 imports 表存 5+8=13 行（旧脏数据未清）→ 断言失败
  - **资金红线**：脏数据混入会让后续对账结果错乱

### 9.12 用例 M：T-2 NaN end_balance + summary.t2AnomalyAccountCount 防回归（round 1 I3 修订）—— **round 2 R2-I3 编号 swap，原 Case L → Case M**

- **背景**：v0.6 之前 `computeT1Op` 对 T-2 期末余额 NaN 行静默 continue，summary 无任何信号；用户无法感知 T-2 数据是否干净。round 1 I3 修订引入 `t2AnomalySeen: Set` + console.warn + summary.t2AnomalyAccountCount 字段（详见 PRD §3.5.5）。
- **构造**：
  - T-2 (2026-05-11) 业务OP（BU=BU-A）：账户 `A1` × 1 行（end_balance=`100`）+ 账户 `A2` × 1 行（end_balance=`#N/A`）+ 账户 `A3` × 1 行（end_balance=`""`）+ 账户 `A4` × 1 行（end_balance=`abc`）
  - T-1 (2026-05-12) 业务OP（BU=BU-A）：账户 A1/A2/A3/A4 各 1 行（end_balance=100）
  - T-1 (2026-05-12) 流水：A1-A4 各 1 行（净发生额=0）
- **期望**：
  - `summary.t2AnomalyAccountCount === 3`（A2/A3/A4 三个账户号 NaN，去重计数）
  - `summary.amountDiffCount === 0`（A1 测算相等；A2/A3/A4 走 onlyInT1 不参与测算金额比较）
  - `summary.t1NotT2Count === 3`（A2/A3/A4 因 T-2 NaN 不进 computedT1Map → T-1 有 T-2 无）
  - 用 spy 拦截 `console.warn` → 至少被调用 3 次（A2/A3/A4 各一次），输出含 `[biz-op-recon] T-2 NaN end_balance: 账户=A2`等
  - DB schema：`SELECT t2_anomaly_account_count FROM biz_op_recon_runs WHERE id=?` === 3
- **反例（防回归）**：
  - 若 `computeT1Op` 退化为静默 continue → `summary.t2AnomalyAccountCount === 0` → 断言失败
  - 若 console.warn 缺失 → spy 调用次数 < 3 → 断言失败
  - 若 DB schema 没有 `t2_anomaly_account_count` 字段 → SQL 报错 → 断言失败

### 9.13 用例 N：BU 名落库前 trim 归一防回归（round 1 I2 修订）

- **背景**：v0.6 之前 `runBizOpImportAsync` 直接把源文件第一行 `业务方` 字段值落库为 `bu_name`，未做 trim。源文件首尾空格 → BU 下拉枚举出现 `"BU-A"` / `" BU-A "` 两条；用户视角下重复且选错。round 1 I2 修订：落库前 `bu_name = String(rawBuName).trim()`（**保留大小写**，与 `normalizeBu` toLowerCase 不同；账户号 normalize 也是仅 trim）。
- **构造**：
  - 第 1 次导入业务OP 文件，第一行业务方原值 = `"  BU-A  "`（前 2 空格 + 后 2 空格）
  - 第 2 次导入业务OP 文件（不同日期 date=2026-05-13），第一行业务方原值 = `"BU-A"`（无空格）
- **期望**：
  - 两次导入后 `SELECT DISTINCT bu_name FROM biz_op_recon_imports` 仅 1 行 = `"BU-A"`（不会出现 `"  BU-A  "` 与 `"BU-A"` 两条）
  - BU 下拉枚举 `[{buName: "BU-A", count: <total>}]`（合并计数）
- **反例（防回归）**：
  - 若 `runBizOpImportAsync` 退化为不 trim → DISTINCT bu_name 返回 2 行 → 断言失败
  - 若误用 `normalizeBu`（toLowerCase） → bu_name 落库变 `"bu-a"` → UI 显示丢失原大小写 → 断言失败（业务期望保留原大小写）

### 9.14 用例 O：I2 BU 名落库前 trim 边界扩展（round 2 R2-I3 新增）

- **背景**：round 2 reviewer 提出 Case N 仅覆盖"首尾空格" + "无空格"两类，未覆盖混合空白字符（tab `\t` / 全角空格 / 换行 `\n` 等）+ 同 BU 同日重复导入场景下的 trim 行为。Case O 扩展 Case N 的边界，增强 I2 防回归覆盖。
- **构造**：
  - 第 1 次导入 (date=2026-05-12)：业务方原值 = `"\tBU-B\t"`（tab 包裹）
  - 第 2 次导入 (date=2026-05-12)：业务方原值 = `"BU-B"`（无空格） — **同 date + 同 BU 归一后** → 期望 clearByDateBu 走 R2-M2 已升格的 `LOWER(TRIM(?))` SQL 命中并清掉旧 5 行
  - 第 3 次导入 (date=2026-05-13)：业务方原值 = `"BU-B "` （仅末尾 1 空格）
- **期望**：
  - 三次导入后 `SELECT DISTINCT bu_name FROM biz_op_recon_imports` 仅 1 行 = `"BU-B"`
  - 第 2 次导入完成后 `SELECT COUNT(*) FROM biz_op_recon_imports WHERE data_date='2026-05-12' AND bu_name='BU-B'` === 第 2 次行数（旧 tab 包裹的 5 行已清；与 Case L C1 大小写归一防回归联动验证）
  - BU 下拉枚举 `[{buName: "BU-B", count: <第 2 次 + 第 3 次>}]`
- **反例（防回归）**：
  - 若 `runBizOpImportAsync` trim 实现不覆盖 tab / 仅覆盖空格 → DISTINCT bu_name 返回 2+ 行 → 断言失败
  - 若 clearByDateBu 退化（C1 回归）→ 第 2 次导入后第 2 次的 BU-B 行 + 第 1 次的 `\tBU-B\t` 行混存 → 断言失败
- **覆盖目的**：扩展 I2 边界 + 与 Case L C1 联动验证（trim + LOWER 跨函数协同）

### 9.15 用例 P：流水重导清 runs + diff_rows 跨 BU 防回归（round 3 P1 资金红线 ⚠️）

- **背景**：v0.8 之前 `runFlowImportAsync` 仅清流水主表 `biz_op_recon_flow_imports` 旧行（DELETE WHERE data_date=?），未清该 date 所有 BU 的 `biz_op_recon_runs` + `biz_op_recon_diff_rows`。当用户重新导入同日流水（修正流水数据）后，旧 BU run 仍指向旧流水算出的 diff_rows → 用户「导出差异」拿到 stale 数据。**资金红线**：流水换了对账没重跑 → 导出旧差异 = 资金事故。round 3 P1 修订引入 `clearRunsAndDiffsByDate(db, date)`（按 date 跨所有 BU 清；与按 (date, BU) 单 BU 清的 `clearRunsAndDiffsByDateBu` 区分语义）。
- **构造**：
  - 同 date=2026-05-12 跨 2 个 BU：BU-A + BU-B 各自完成业务OP T-2/T-1 + 流水导入 + 跑对账成功
  - 三件齐：T-2 (2026-05-11) + T-1 (2026-05-12) 业务OP 各 BU 各 1 行 + T-1 (2026-05-12) 流水 4 行（BU-A 2 行 + BU-B 2 行）
  - 已 success run 2 个：runA = (date=2026-05-12, bu=BU-A) / runB = (date=2026-05-12, bu=BU-B)；各对应若干 diff_rows
  - **关键操作**：重新导入同日 (2026-05-12) 流水（修正后的流水文件）
- **期望**：
  - 重导后 `SELECT COUNT(*) FROM biz_op_recon_runs WHERE data_date='2026-05-12'` === 0（runA + runB 均被清；跨 BU）
  - `SELECT COUNT(*) FROM biz_op_recon_diff_rows WHERE data_date='2026-05-12'` === 0（runA + runB 对应 diff_rows 均被清）
  - `SELECT COUNT(*) FROM biz_op_recon_flow_imports WHERE data_date='2026-05-12'` === 新流水行数（旧流水已清 + 新流水入库）
  - 同 date 但**业务OP 主表不动**：`SELECT COUNT(*) FROM biz_op_recon_imports WHERE data_date='2026-05-12'` === 重导前行数（业务OP 由 `clearRunsAndDiffsByDateBu` 单独负责，流水重导不应清业务OP）
  - 重新跑对账（`bizOpRecon:run`）→ 新 runId 对应新 diff_rows
- **反例（防回归）**：
  - 若 `runFlowImportAsync` 退化为不调 `clearRunsAndDiffsByDate` → 重导后 runA + runB 仍存在 → 「导出差异」拿到 stale diff_rows → 断言失败
  - 若误用 `clearRunsAndDiffsByDateBu`（单 BU 清）→ 只清 BU-A 或 BU-B 一个 → 跨 BU 残留 → 断言失败
  - **资金红线**：用户拿旧差异表上报 → 资金事故
- **覆盖目的**：守住 P1 资金红线 — 流水共用语义（按 date 跨 BU）必须正确反映在重导清逻辑

### 9.16 用例 Q：业务OP 重导清下一日 runs + diff_rows 防回归（round 4 P1 资金红线 ⚠️）

- **背景**：v0.9 之前 `runBizOpImportAsync` 成功路径只清当天作为 T-1 的 runs/diff_rows（`clearRunsAndDiffsByDateBu(db, date, bu)`），未清下一日作为 T-2 的 runs/diff_rows（`clearRunsAndDiffsByDateBu(db, addOneDay(date), bu)`）。当用户重新导入业务OP D 数据（修正后），D+1 日的旧 run 仍按"旧 T-2 (D 旧业务OP) 期末 + 流水累加"算出 `计算 T-1 OP`，与新 T-2 (D 新业务OP) 不一致 → 用户「导出 D+1 差异」拿到 stale 差额。**资金红线**：业务OP 换了对账没重跑 → 导出旧差异 = 资金事故。round 4 P1 修订引入 `addOneDay(date)` helper（UTC 实现，与 `subOneDay` 对偶）+ `runBizOpImportAsync` 事务追加 `clearRunsAndDiffsByDateBu(db, addOneDay(date), bu)` 调用。
- **构造**：
  - 同 BU=BU-A 跨 3 日：D-1=2026-05-11 / D=2026-05-12 / D+1=2026-05-13 各导入业务OP 各 1 行（同账户号 acc1）
  - D=2026-05-12 + D+1=2026-05-13 各导入流水（按 BU-A 过滤后非空）
  - 跑两个 success run：runD = (date=D=2026-05-12, bu=BU-A) 用 T-2=D-1 期末算；runD1 = (date=D+1=2026-05-13, bu=BU-A) 用 T-2=D 期末算；各对应若干 diff_rows
  - **关键操作**：重新导入 D=2026-05-12 业务OP（修正后的文件，acc1 期末余额改）
- **期望**：
  - 重导后 `SELECT COUNT(*) FROM biz_op_recon_runs WHERE bu_name='BU-A' AND data_date IN ('2026-05-12','2026-05-13')` === 0（runD + runD1 均被清；跨 2 日单 BU）
  - `SELECT COUNT(*) FROM biz_op_recon_diff_rows WHERE bu_name='BU-A' AND data_date IN ('2026-05-12','2026-05-13')` === 0
  - 同 D 但**其他 BU runs 不动**：`SELECT COUNT(*) FROM biz_op_recon_runs WHERE data_date='2026-05-12' AND bu_name != 'BU-A'` === 重导前行数（业务OP 按 (date, BU) 单 BU 清，其他 BU 不受影响）
  - 同 D 但**业务OP D-1 主表不动**：`SELECT COUNT(*) FROM biz_op_recon_imports WHERE data_date='2026-05-11' AND bu_name='BU-A'` === 重导前行数（仅 D 业务OP 被替换）
  - **未来日期 D+2 不动**：`SELECT COUNT(*) FROM biz_op_recon_runs WHERE data_date='2026-05-14' AND bu_name='BU-A'`（如有）=== 重导前行数（addOneDay 仅 +1 日，不应级联清更远）
  - 重新跑对账（`bizOpRecon:run` for D 与 D+1）→ 新 runId 对应新 diff_rows
- **反例（防回归）**：
  - 若 `runBizOpImportAsync` 退化为不调 `clearRunsAndDiffsByDateBu(db, addOneDay(date), bu)` → 重导后 runD1 仍存在 → 「导出 D+1 差异」拿 stale diff_rows → 断言失败
  - 若 `addOneDay` 退化为本地时区 `setDate(getDate() + 1)`（非 UTC）→ UTC+12 / UTC-12 边界时区抢跑/滞后 1 天 → 误清 D+2 或漏清 D+1 → 断言失败
  - 若误用 `clearRunsAndDiffsByDate`（跨 BU 清）→ 误清其他 BU 的 D 或 D+1 run → 断言失败
  - **资金红线**：用户拿旧 D+1 差异表上报 → 资金事故
- **覆盖目的**：守住 round 4 P1 资金红线 — 业务OP 双角色语义（当天 T-1 + 下一日 T-2）必须正确反映在重导清逻辑；同时验证 `addOneDay` UTC 实现的时区安全性

---

## 十、preview 入口（新增 4 处）

参照 `scripts/preview-bank-bu-recon.js` 风格，新增 `scripts/preview-biz-op-recon.js`：

| 场景 | 截图 |
|---|---|
| 初始（无数据，BU 下拉为空，所有运行/导出按钮 disabled） | `assets/preview-biz-op-recon-initial.png` |
| 导入中（业务OP 第 1 日已导入，状态栏显示导入完成 + BU 下拉已填充） | `assets/preview-biz-op-recon-importing.png` |
| 对账结果（运行完成，状态栏显示统计） | `assets/preview-biz-op-recon-result.png` |
| 导出对话框（两 radio + 日期/区间选项） | `assets/preview-biz-op-recon-export-dialog.png` |

`package.json` 新增 script：`"preview:biz-op-recon": "node scripts/preview-biz-op-recon.js"`

按 memory `workflow_frontend_previews`：前端 PR 前必须重跑这 4 张 preview。

---

## 十一、版本号 + 三件套

- `package.json.version` 2.1.2 → 2.1.3
- `CHANGELOG.md`：v2.1.3 段落（新增"业务OP数据核对"模块）
- `docs/VERSION_FEATURE_HISTORY.md`：v2.1.3 行
- `docs/USER_GUIDE.md`：新增"业务OP数据核对"章节（入口 / BU 下拉 / 业务OP 导入流程 / 流水对账单 导入流程 / 开始运行 / 导出指定日期 / 导出指定日期区间 / 校验失败行处理 / 截图）

---

## 十二、重要变量升格评估（memory `workflow_important_vars_check`）

新增的以下符号，spec 阶段评估是否升级进 `rules/important-variables.md`：

| 符号 | 层级建议 | 理由 | round 1 升格状态 |
|---|---|---|---|
| `runBizOpReconciliation` / `runReconciliation` (函数) | **Critical** | 资金红线对账总入口；与 v1.5.x Pending 模块同名（命名冲突风险） | ✅ **已 round 1 升格 Critical**（详见 `rules/important-variables.md` § 1 Critical） |
| `compareT1OpWithComputed` (函数) | **Critical** | #6 拍板 A 1:N 精准标差异核心实现；fix4/fix5 修正点 | ✅ **已 round 1 升格 Critical** |
| `aggregateFlowByAccount` (函数) | Risk-sensitive | #3 + #7 联动，流水按账户号累加 | ✅ **已 round 1 升格 Risk-sensitive**（详见 § 4 Risk-sensitive） |
| `parseSignedAmount` (helper) | Risk-sensitive | 出入方向 → 正负号（#3 拍板），资金红线 | ✅ **已 round 1 升格 Risk-sensitive** |
| `validateBizOpRow` (函数) | Risk-sensitive | 业务OP 双重校验（#1 拍板 B） | ✅ **已 round 1 升格 Risk-sensitive** |
| `validateFlowRow` (函数) | Risk-sensitive | 流水出入方向枚举校验（#3 拍板） | ✅ **已 round 1 升格 Risk-sensitive** |
| `normalizeBu` (helper) | Important-skeleton | BU 比较（#7 拍板 C，与 v2.1.2 `normalizeBu` 同名同义） | ✅ **已 round 1 升格 Important-skeleton**（详见 § 2 Important-skeleton） |
| `normalizeAccountKey` (helper) | Important-skeleton | 账户号匹配 anchor；M4 round1 writer 排序 key 共用 | ✅ **已 round 1 升格 Important-skeleton** |
| `AMOUNT_EPSILON` (常量) | Risk-sensitive | 1e-2 容差，资金红线门槛；M2 round1 提取后 columns.js | ✅ **已 round 1 升格 Risk-sensitive** |
| `VALID_DIRECTION_IN` / `VALID_DIRECTION_OUT` (常量) | Risk-sensitive | 中文「入」/「出」枚举固化（#3 拍板） | ✅ **已 round 1 升格 Risk-sensitive**（合并为 1 条目） |
| `biz_op_recon_runs.status` (字段) | Risk-sensitive | 'success'（系统错误不落 runs） | ⚪ 暂不升格（DB 字段，靠 schema 自身约束；不需进表） |
| `BIZ_OP_HEADERS` / `FLOW_HEADERS` (常量) | Important-skeleton | 模板表头校验 anchor | ✅ **已 round 1 升格 Important-skeleton**（2 条独立条目） |
| `YELLOW_FILL` (常量) | Minor | 与 v2.1.2 复用 | ⚪ 暂不升格（v0.3 fix2.4 后差异表已无黄底；仅失败报告 writer 引用 1 处） |

**round 1 升格统计**：13 条进表（Critical 2 + Important-skeleton 4 + Risk-sensitive 7）；2 条暂不升格（DB 字段 + 低引用常量）。

**round 3 升格评估（v0.9 — 2026-05-14，Codex P1 资金红线后续）**：

| 符号 | 层级建议 | 理由 | round 3 升格状态 |
|---|---|---|---|
| `runFlowImportAsync` (函数) | **Critical** | 流水重导核心入口；P1 修订前漏清跨 BU runs/diff_rows 即资金红线（用户「导出差异」拿 stale 数据）；事务必须包含 `clearRunsAndDiffsByDate` 调用 | ✅ **round 3 升格 Critical**（详见 `rules/important-variables.md` § 1 Critical） — "变更 review 要点"：流水重导必须清 runs / smoke Case P 覆盖 |
| `clearRunsAndDiffsByDate` (函数，新) | **Risk-sensitive** | round 3 P1 新增；按 date **跨 BU** 清 runs + diff_rows；与 `clearRunsAndDiffsByDateBu` 单 BU 清不可混 | ✅ **round 3 升格 Risk-sensitive** — "变更 review 要点"：与 `clearRunsAndDiffsByDateBu` 区分语义不能混；流水重导专用 |
| `clearRunsAndDiffsByDateBu` (函数) | **Risk-sensitive** | #15 拍板 A 已实现；按 (date, BU) 单 BU 清；与新 `clearRunsAndDiffsByDate` 跨 BU 清需双门槛区分 | ✅ **round 3 升格 Risk-sensitive**（之前未升格）— "变更 review 要点"：与 `clearRunsAndDiffsByDate` 区分语义不能混；业务OP 重导专用 |

**round 3 升格统计**：3 条进表（Critical 1 + Risk-sensitive 2）；元数据 v3 → v4 + 上次人工 review 改 2026-05-14。

**round 4 升格评估（v0.10 — 2026-05-14，Codex P1 资金红线后续）**：

| 符号 | 层级建议 | 理由 | round 4 升格状态 |
|---|---|---|---|
| `runBizOpImportAsync` (函数) | **Critical** | 业务OP 重导核心入口；与 `runFlowImportAsync` round 3 升格 Critical 对齐（两个重导入口同级红线）；P1 修订前漏清下一日 (date+1, BU) runs/diff_rows 即资金红线（用户「导出 D+1 差异」拿 stale 数据）；事务必须包含 **两次** `clearRunsAndDiffsByDateBu` 调用（当天 + 下一日） | ✅ **round 4 升格 Critical**（详见 `rules/important-variables.md` § 1 Critical）— "变更 review 要点"：业务OP 重导必须清当天 + 下一日 runs / smoke Case Q 覆盖 / 与 `runFlowImportAsync` 区分语义（业务OP 单 BU 跨 2 日清；流水跨 BU 单日清） |
| `addOneDay` (函数，新) | **Risk-sensitive** | round 4 P1 新增；与 `subOneDay` 对偶（subOneDay round 2 R2-M4 已升格 Risk-sensitive），同样必须 UTC 实现避免时区抢跑；时区错乱直接错日期（漏清下一日 run 或误清后天 run）= 资金红线 | ✅ **round 4 升格 Risk-sensitive**（与 `subOneDay` 对齐）— "变更 review 要点"：UTC 实现不可改本地时区；`grep -n "function addOneDay" src/` 确认实现一致；smoke Case Q 验证时区安全性 |

**round 4 升格统计**：2 条进表（Critical 1 + Risk-sensitive 1）；元数据 v4 → v5 + 上次人工 review 保持 2026-05-14。

实施完成后执行 `npm run scan:vars` 重新生成统计，确认新符号的跨文件引用度，按 `rules/important-variables.md` 双门槛复核。

---

## 十三、风险与红线提醒

⚠️ **资金红线（全部 OPEN ISSUE 已拍板，下列是落实点）**：
- **对账逻辑（§五）**：4 步算法必须人工 smoke 复核（不能只看 `npm run smoke` 通过）
- **出入方向 → 正负号（§5.2 `parseSignedAmount`）— #3 拍板**：仅允许「入」/「出」，其他 → NaN → 整批拒绝；smoke D 单独覆盖；真实数据样本回放必查脏值
- **BU 比较语义（§5.2 `normalizeBu`）— #7 拍板 C**：trim + toLowerCase，与 v2.1.2 一致；smoke G 覆盖
- **业务 OP 双重校验（§5.3 `validateBizOpRow`）— #1 拍板 B**：epsilon=1e-2，任一不过整批拒绝；smoke E 覆盖
- **校验失败整批拒绝（§5.4）— #5 拍板**：事务回滚 + 失败报告 xlsx 落 `error-reports/`，主表 0 脏行；smoke E 覆盖
- **多 OP 行 1:N 精准标差异（§5.2 `compareT1OpWithComputed`）— #6 拍板 A**：逐行独立比，独立标"相等"/"不相等"；smoke B 覆盖（v0.3：差异表 writer 不再标黄）
- **重新导入清空旧 runs（§4.1 事务）— #15 拍板 A**：同 (date, BU) DELETE diff_rows → DELETE runs → DELETE imports → INSERT 同事务原子操作；smoke 推荐补 H "重新导入回归测试"

⚠️ **不破坏 v2.1.2 模块**：
- 共用 `tool-data.sqlite`，但表名前缀 `biz_op_recon_*` 与 v2.1.2 `bank_bu_recon_*` / Pending 模块完全独立
- IPC 命名空间 `bizOpRecon:*` 与 `bankBuRecon:*` / `pending:*` 完全独立
- 模板文件 `assets/业务OP账单.xlsx` + `assets/流水对账单.xlsx` 与 v2.1.2 `assets/Pending数据管理.xlsx` + `assets/银行对账单.xlsx` 不同文件

⚠️ **PR review 关注点**：
- 资金红线对账逻辑必须人工 smoke 复核（含真实数据样本回放）
- 资金红线高密度区（#1 双重校验 / #3 出入方向枚举 / #5 整批拒绝 / #6 1:N 精准 / #7 normalizeBu / #15 清空旧 runs）对应的代码（`validateBizOpRow` / `validateFlowRow` / `parseSignedAmount` / `compareT1OpWithComputed` / `normalizeBu` / `clearRunsAndDiffsByDateBu`）任一改动后必须重跑 smoke A-H 全套
- BU 下拉框动态更新逻辑（导入后必须刷新）— 用户体验测试

---

## 十四、OPEN ISSUE 拍板回填表（v0.2 — 全部已拍板）

> v0.1 此节列出 14 项待拍板议题；v0.2 全部回填至本文相应章节。本表保留作为 traceability 索引，方便 PR review / 后续 audit 快速定位"拍板结果落到 spec 哪一节"。

| # | 拍板结果（PRD §6.1） | spec 落实点 |
|---|---|---|
| 1 | B 双重校验 + epsilon=1e-2 | §2.1 列 8-12 标注、§5.3 `validateBizOpRow` |
| 3 | 中文「入」/「出」，入=+ 出=- | §2.2 列 9 标注、§5.0 常量、§5.2 `parseSignedAmount`、§5.3 `validateFlowRow` |
| 4 | A 替换 + 原子事务 | §三 `import:run-biz-op` 出参、§4.1 重新导入策略 SQL |
| 5 | 整批拒绝 + 失败报告 xlsx | §三 `import:run-biz-op` 出参 + `import:open-error-report-folder`、§5.4 流程、§6.3 writer；**v0.3 fix2 删除 ErrorReportDialog**，改为状态栏文字 + 失败报告路径（§三 `import:run-biz-op` 出参描述 + §7.6 dialog 列表去 ErrorReportDialog） |
| 6 | A 1:N 逐行独立比 | §5.0 函数签名、§5.2 `compareT1OpWithComputed` |
| 7 | C trim + toLowerCase | §5.2 `normalizeBu`、§2.2 列 7 标注 |
| 8 | A 年±1 / 月 1-12 / 日 1-31 不联动 | §7.6 `createBizOpReconDatePickerDialog` |
| 9 | A 完整文件名格式 | §6.1 / §6.2 默认文件名 |
| 10 | **E（v0.3 fix2.4 回滚 + v0.5 fix5 选项 B 修订）** 差异表不标黄；进表条件扩展为 `cmp_t2 非空 OR cmp_amount==不相等 OR multi_op_flag==是` | §四 diff_rows 写入条件、§6.1 writer **移除整行 YELLOW_FILL**、§5.2 `compareT1OpWithComputed` 相等多 OP 分支 push diffRows |
| 11 | B 弹确认对话框 | §三 `import:check-single-day`、§7.6 `createBizOpReconSecondImportPromptDialog` |
| 12 | A 前置 enable（下拉只列 ready 日期） | §三 `run:list-ready-dates`、§7.6 `createBizOpReconReconcileDialog` |
| 13 | A 完全复用 list-ready / success 风格 | §三 IPC 命名、§八 run-repository 函数清单 |
| 14 | **F（v0.6 fix6 拍板回滚）** 区间导出**单 sheet「差异」**，所有日期合并 + data_date+account_key 排序 + 不加新列；单日导出仍 A `YYYY-MM-DD` ISO sheet 名 | §6.1 单日 = `workbook.addWorksheet(date)`；§6.2 区间 = `workbook.addWorksheet('差异')` + 排序 + Billdate/data_date console.warn |
| 15 | A 重新导入清空 runs + diff_rows | §4.1 SQL 事务、§八 `clearRunsAndDiffsByDateBu` |
| A | 动态从业务方 distinct | §三 `bu:list` IPC |
| B | 单 OP 行也比测算金额 | §5.2 `compareT1OpWithComputed` 无 N==1 特殊分支 |
| C | T-2 有 T-1 无 行来源 T-2 表 | §四 `source_table='T2'`、§5.1 步骤 5.b |
| D | 用户已提供模板入 assets/ | §2.1 / §2.2 表头来源 |

---

## 十五、round 1 self-review 修订记录（v0.7 — 2026-05-14）

> PR #45 提 PR 后 reviewer agent 反馈 1 critical + 3 important + 5 minor + 3 测试遗漏建议；用户拍板"全修"。下表为 round 1 修订全部条目（PM/Dev 两侧 task 划分）。

| # | 级别 | 内容 | spec/PRD 落实点 | 代码改动文件（Dev 侧） |
|---|---|---|---|---|
| **C1** | **Critical** | `clearByDateBu` BU 比较未对齐 `getRowsByDateBu` 的 `LOWER(TRIM(?))` → 大小写差异时清不掉旧数据（**资金红线**：脏数据混存）。统一改 `LOWER(TRIM(bu_name)) = LOWER(TRIM(?))` | §4.1 SQL DELETE 注释；spec §九 Case M 防回归 | `src/backend/biz-op-recon-db/imports-repository.js` `clearByDateBu` |
| **I1** | Important | 13 个 v2.1.3 新符号升格 `rules/important-variables.md`（Critical 2 + Important-skeleton 4 + Risk-sensitive 7） | spec §十二 标注"已 round 1 升格"；`rules/important-variables.md` v2 元数据 | — (PM 侧文档) |
| **I2** | Important | `runBizOpImportAsync` 落库前归一化 BU 名：`bu_name = String(rawBuName).trim()`（保留大小写，与 `normalizeBu` toLowerCase 不同）。避免源文件首尾空格导致 BU 下拉枚举重复 | spec §九 Case N 防回归；§5.4 流程注释 | `src/main-process/biz-op-recon-session.js` `runBizOpImport` 落库前 trim |
| **I3** | Important | `computeT1Op` T-2 NaN end_balance 加 `console.warn(...)` + summary 新增 `t2AnomalyAccountCount` 字段 + DB schema 新增 `biz_op_recon_runs.t2_anomaly_account_count INTEGER NOT NULL DEFAULT 0`（migration 幂等） | PRD §3.5.5 + spec §5.0.1 函数签名表 + §5.1 编排 + §三 IPC 出参 schema + §4.3 DB schema + §九 Case L 防回归 | `src/main-process/biz-op-recon-session.js` `computeT1Op` + `runReconciliation` + `src/backend/biz-op-recon-db/migrations.js` (新增 ALTER) + `src/backend/biz-op-recon-db/run-repository.js` `insertRun` |
| **M1** | Minor | （Dev 范围；占位 — Dev agent 给出最终条目内容） | — | — |
| **M2** | Minor | `AMOUNT_EPSILON` 提取到公共 `src/backend/biz-op-recon-db/columns.js`，避免分散在 session.js + validator.js 两处不一致 | spec §5.0 常量定义 + `rules/important-variables.md` Risk-sensitive `AMOUNT_EPSILON` 条目 | `src/backend/biz-op-recon-db/columns.js` 新增 export + 改 session.js / validator.js import |
| **M3** | Minor | spec §7.6 dialog factory 列表：5 → 4（fix1.5 + fix2 已删 ErrorReportDialog；本次 spec 描述同步）；删除 `createBizOpReconFileImportPromptDialog` 误描述 | spec §7.6 表格 + 注脚 [^dialog-count] | — (PM 侧文档；Dev 侧已删除 ErrorReportDialog 实现) |
| **M4** | Minor | 区间 writer `writeDateRangeDiffWorkbook` 排序 key 必须用 `normalizeAccountKey(sourceRow.account_no)`（不能直接用原值），与 session.js / repository 跨文件保持一致 | spec §6.2 排序段加注释；`rules/important-variables.md` `normalizeAccountKey` 条目"writer.js 排序 key" | `src/main-process/biz-op-recon-writer.js` `writeDateRangeDiffWorkbook` 排序段 |
| **M5** | Minor | （Dev 范围；占位 — Dev agent 给出最终条目内容） | — | — |
| **Case L** | 测试遗漏 | T-2 NaN end_balance + summary.t2AnomalyAccountCount 防回归（round 1 编号；**round 2 R2-I3 swap 为 Case M**，详见 §9.12） | spec §9.12 Case M（round 2 swap 后） | `scripts/smoke-test.js` Case M |
| **Case M** | 测试遗漏 | clearByDateBu 大小写归一防回归（round 1 编号；**round 2 R2-I3 swap 为 Case L**，详见 §9.11） | spec §9.11 Case L（round 2 swap 后） | `scripts/smoke-test.js` Case L |
| **Case N** | 测试遗漏 | BU 名落库前 trim 归一防回归 | spec §9.13 Case N | `scripts/smoke-test.js` Case N |

**known issue（不在 round 1 修，留 PRD §6.5 KI-1）**：v2.1.2 月度BU回填校验对应位置有 `createBankBuReconFileImportPromptDialog`（导入文件前提示弹原生窗 UX 对齐），v2.1.3 业务OP 模块当前缺失同位置 dialog；**留 v2.1.4 补齐**（round 1-7 都未补，KI-1 持续保留）。

**round 1 验证清单（PR self-review 前必跑）**：
- `npm run smoke` 全套（含 Case A-K + Case L/M/N）→ 退出码 0
- `npm run scan:vars` → 13 个新符号已在 `rules/important-variables.md` 命中
- `grep -rn "createBizOpReconErrorReportDialog\|createBizOpReconFileImportPromptDialog" src/` → 应**无输出**（fix1.5/fix2 已删 + round 1 M3 spec 同步）
- 真实数据手测：构造一个 T-2 含 NaN end_balance 的业务OP 文件 → 状态栏 / DevTools 看到 console.warn + summary.t2AnomalyAccountCount > 0
- 真实数据手测：构造两个文件业务方分别为 `"BU-A"` 与 `" BU-A "` → 第二次导入清得掉第一次（防 C1 回归）；BU 下拉只显示 1 项 `"BU-A"`（防 I2 回归）

---

## 十六、round 2 self-review 修订记录（v0.8 — 2026-05-14）

> PR #45 round 1 修订完成后再过 reviewer agent；reviewer 给 0 critical + 3 important + 5 minor + 3 测试遗漏建议；用户拍板"全修"。下表为 round 2 修订全部条目（PM/Dev 两侧 task 划分）。

| # | 级别 | 内容 | spec/PRD 落实点 | 代码改动文件（Dev 侧） |
|---|---|---|---|---|
| **R2-I1** | Important | UX 半成品 — 状态栏文案补 `t2AnomalyAccountCount`：仅 > 0 时显示「T-2 异常 W 个」；= 0 时不显示，避免无信息时增加噪声。round 1 I3 落 DB 字段 + summary 字段 + USER_GUIDE 文案，但 renderer 状态栏未串通 | docs/USER_GUIDE.md §1.7.4 步骤 4 状态栏文案补"仅 > 0 时显示"约束 | `src/renderer.js` 状态栏渲染分支（Dev 实施） |
| **R2-I2** | Important | spec ↔ code 偏差 — `computeT1Op` 实际对"同账户号多行（部分 NaN + 部分 valid）"做容错（`validAccountSet.delete(anomalyAccountSet)` 集合差），仅当所有行都 NaN 才标 anomaly + 跳过 map；spec 描述未覆盖该容错路径，仅描述"NaN 即 anomaly + 跳过 map" | PRD §3.5.5 关键不变量第 2 条新增；spec §5.2 `computeT1Op` 实现注释 + §5.2.1 算法关键不变量段新增 | — (PM 侧文档；Dev 侧代码已正确实现) |
| **R2-I3** | Important | smoke 编号 swap + I2 回归覆盖扩展：Case L↔M swap（Case L = clearByDateBu 大小写防回归 / Case M = T-2 NaN 防回归 — 按依赖顺序）+ 新 Case O（I2 BU trim 边界扩展，覆盖 tab / 全角空格 + 同 date 联动 C1） | spec §9.11 Case L 改 swap / §9.12 Case M 改 swap / §9.14 Case O 新增 | `scripts/smoke-test.js` Case L/M swap + 新 Case O（Dev 实施） |
| **R2-M1** | Minor | spec §三 IPC 表删假 handler `bizOpRecon:import:pick-biz-op-date` / `bizOpRecon:import:pick-flow-date`（main.js / preload.js 实际无定义；日期选择由前端 dialog factory `createBizOpReconDatePickerDialog` 直接处理）+ §7.6 dialog 段补处理路径说明 | spec §三 IPC 表删 2 行 + 表底部 R2-M1 备注 + §7.6 末尾 round 2 R2-M1 修订段 | — (PM 侧文档) |
| **R2-M2** | Minor | `computeT1Op` 函数签名 spec ↔ code 对齐：spec v0.7 描述 `(t2OpRows, flowAggMap, t2AnomalySeen, buName)` 返回 `Map`；code 实际 `(t2OpRows, flowAggMap)` 返回 `{ map, anomalyAccountSet }` → spec §5.0.1 函数签名表 + §5.1 caller + §5.2 helper 全部改为 code 实际签名；caller 解构改 `const { map: calcT1ByAccount, anomalyAccountSet: t2AnomalyAccounts } = computeT1Op(...)` | spec §5.0.1 + §5.1 + §5.2 + caller 注释全部同步 | — (PM 侧文档；Dev 侧代码已正确实现) |
| **R2-M3** | Minor | console.warn 文案 spec ↔ code 统一：spec v0.7 文案 `[biz-op-recon] T-2 NaN end_balance: 账户={accKey} BU={buName} 原值="{raw}"...`；code 实际 `[biz-op-recon] T-2 end_balance NaN silent drop date=${t2Date} bu=${buName} account=${acc} (该账户在 T-1 实际 OP 与差异表均不可见，请检查源文件期末余额字段)` → spec §5.1 caller 实现 + §5.2.1 关键不变量第 3 条改为 code 实际版本（采纳 code 为 source of truth） | spec §5.1 caller + §5.2.1 关键不变量 | — (PM 侧文档；Dev 侧代码已正确实现) |
| **R2-M4** | Minor | `subOneDay` 双源说明：实现完全一致的副本同时存在于 `src/main-process/biz-op-recon-session.js:83` + `src/backend/biz-op-recon-db/run-repository.js:155`，符合工程偏好（避免 backend → main-process 反向依赖）。但维护时改一处忘改另一处会出现行为漂移（资金红线 — 时区错乱直接错日期）。spec §五 算法签名表 `subOneDay` 行加双源备注；rules/important-variables.md 升格 Risk-sensitive | spec §5.0.1 函数签名表 `subOneDay` 行 + `rules/important-variables.md` Risk-sensitive `subOneDay` 新条目 | — (PM 侧文档；不修代码 — 保留双源) |
| **R2-M5** | Minor | `AMOUNT_EPSILON` 位置同步 — spec §5.0 当前 "在 src/main-process/biz-op-recon-session.js 模块顶部常量"；M2 round1 提取后单一来源在 `src/backend/biz-op-recon-db/columns.js:146`（session.js + validator.js import）→ spec §5.0 常量定义 + §5.3 validator 段 import 注释全部同步新位置；强调"避免 import-time vs runtime epsilon 不同步的资金红线偏差" | spec §5.0 常量段 + §5.3 validator 段顶部 import 注释 | — (PM 侧文档；Dev 侧代码已正确实现) |
| **Case L swap** | 测试遗漏 | round 2 R2-I3 swap：Case L = clearByDateBu 大小写防回归（依赖更基础，先跑） | spec §9.11 Case L | `scripts/smoke-test.js` Case L swap |
| **Case M swap** | 测试遗漏 | round 2 R2-I3 swap：Case M = T-2 NaN end_balance 防回归（依赖 Case L 跑通后再跑 NaN） | spec §9.12 Case M | `scripts/smoke-test.js` Case M swap |
| **Case O** | 测试遗漏 | round 2 R2-I3 新增：I2 BU trim 边界扩展（tab / 全角空格 + 同 date 联动 C1） | spec §9.14 Case O | `scripts/smoke-test.js` Case O 新增 |

**协调（PM/Dev 并行）**：
- Dev 改 `src/renderer.js` (R2-I1) + `scripts/smoke-test.js` (R2-I3 Case L/M swap + 新 Case O) — PM 不动
- PM 改 PRD/spec/tasks/important-variables/三件套 — Dev 不动
- 字段名 `t2AnomalyAccountCount` (camelCase) ↔ `t2_anomaly_account_count` (snake) round 1 已对齐，round 2 不动
- console.warn 文案：spec 跟 code 走（PM 改 spec）— Dev 不改 code
- `computeT1Op` 函数签名：spec 跟 code 走（PM 改 spec）— Dev 不改 code

**round 2 验证清单（PR self-review 前必跑）**：
- `npm run smoke` 全套（含 Case A-K + Case L/M swap 后顺序 + Case N + 新 Case O）→ 退出码 0
- `grep -rn "pick-biz-op-date\|pick-flow-date" src/main.js src/preload.js` → 应**无输出**（spec 已删假 handler 描述）
- `grep -n "computeT1Op" src/main-process/biz-op-recon-session.js` → 函数签名 = `function computeT1Op(t2OpRows, flowAggMap)`（无第 3/4 参数）
- `grep -n "T-2 end_balance NaN silent drop" src/main-process/biz-op-recon-session.js` → 命中 1 处（caller 端 `runReconciliation`）
- `grep -n "AMOUNT_EPSILON = " src/backend/biz-op-recon-db/columns.js src/backend/biz-op-recon-import/validator.js src/main-process/biz-op-recon-session.js` → 仅 columns.js 命中**赋值**（其余应为 import）
- 真实数据手测：构造一个 T-2 含部分 NaN（同账户号 2 行：1 行 valid + 1 行 NaN）的业务OP 文件 → summary.t2AnomalyAccountCount 不应包含该账户号（容错路径正确）
- 状态栏：t2AnomalyAccountCount === 0 时**不显示** "T-2 异常 W 个"；> 0 时**显示**

**known issue（不在 round 2 修，留 PRD §6.5 KI-1 不变）**：v2.1.2 月度BU回填校验对应位置有 `createBankBuReconFileImportPromptDialog`（导入文件前提示弹原生窗 UX 对齐），v2.1.3 业务OP 模块当前缺失同位置 dialog；留 v2.1.4 补齐（round 1-7 都未补，KI-1 持续保留）。

---

## 十七、round 3 self-review 修订记录（v0.9 — 2026-05-14）

> PR #45 round 2 修订完成后再过 reviewer agent（Codex 自动 review）；reviewer 给 1 P1 ⚠️ 资金红线 + 2 P2 + 1 P3 finding。用户拍板"全修"。下表为 round 3 修订全部条目（PM/Dev 两侧 task 划分）。

| # | 级别 | 内容 | spec/PRD 落实点 | 代码改动文件（Dev 侧） |
|---|---|---|---|---|
| **P1** | ⚠️ Critical 资金红线 | `runFlowImportAsync` 成功路径只清流水主表，不清该 date 所有 BU 的 runs/diff_rows → 用户重导同日流水后「导出差异」拿 stale 数据 = 资金事故。修法：新增 `clearRunsAndDiffsByDate(db, date)` 函数（按 date 跨所有 BU 清；与 `clearRunsAndDiffsByDateBu` 单 BU 清区分语义）+ 流水重导事务内调用 + smoke Case P 覆盖 | PRD §3.4.1 步 4 流水重导描述 + PRD §3.5.6 关键不变量段新增 + spec §三 IPC `import:run-flow` 出参描述补 `clearRunsAndDiffsByDate` 调用 + spec §5.0.1 函数签名表新增 `clearRunsAndDiffsByDate` + `clearRunsAndDiffsByDateBu` + `runFlowImportAsync` 三行 + spec §八 run-repository.js 函数清单补 `clearRunsAndDiffsByDate` + spec §九 Case P 新增 + spec §十二 升格 3 条（runFlowImportAsync Critical / clearRunsAndDiffsByDate Risk-sensitive / clearRunsAndDiffsByDateBu Risk-sensitive） | `src/main-process/biz-op-recon-session.js` `runFlowImportAsync` 事务内补 `clearRunsAndDiffsByDate(db, date)` 调用；`src/backend/biz-op-recon-db/run-repository.js` 新增 `clearRunsAndDiffsByDate` 函数；`scripts/smoke-test.js` 新增 Case P |
| **P2 lockfile** | Important | `package-lock.json` 同步 2.1.3（package.json 已 bump 但 lockfile 未同步） | — (Dev 自动跑 `npm install --package-lock-only` 处理；PM 不动 lockfile) | `package-lock.json` |
| **P2 usage-stats** | Important | usage-stats 接入 — FUNCTION_REGISTRY 注册「业务OP数据核对」+ 5 个核心 action `bizOpRecon:*` handler 用 `trackedIpcHandle` 包装；其余 10 个 query/dialog/helper handler 保持 plain `ipcMain.handle`（与 v2.1.2 月度BU `bankBuRecon` 同款分级 pattern；D6 拍板"仅成功 action 计数"） | spec §三 IPC 表说明列按 5 tracked + 10 plain 分级标注 + 表头 round 3 P2 修订段说明分级理由 + FUNCTION_REGISTRY 注册 | `src/backend/usage-stats.js` `FUNCTION_REGISTRY` 新增 `'业务OP数据核对': ['导入文件', '开始运行', '导出差异']` 共 3 个 functionKey；`src/main.js` 5 个 action handler（`import:run-biz-op` / `import:run-flow` / `run` / `export:date` / `export:date-range`）改 `trackedIpcHandle('bizOpRecon:*', '业务OP数据核对', '<功能>', ...)` 包装；其余 10 个 handler 保持 plain |
| **P3 preview:all** | Minor | `package.json:71` `preview:all` script 串入 `preview:biz-op-recon`（参照 v2.1.2 月度BU preview 入串方式） | — (Dev 改 package.json；PM 不动 lockfile) | `package.json` |

**协调（PM/Dev 并行）**：
- Dev 改 `src/main-process/biz-op-recon-session.js` (P1 流水重导清 runs) + `src/backend/biz-op-recon-db/run-repository.js` (P1 新增 `clearRunsAndDiffsByDate`) + `src/main.js` (P2 5 个核心 action IPC trackedIpcHandle 包装；其余 10 个 query/dialog/helper 保持 plain) + `src/backend/usage-stats.js` (P2 FUNCTION_REGISTRY 注册) + `package.json` + `package-lock.json` (P2/P3) + `scripts/smoke-test.js` (P1 Case P) — PM 不动
- PM 改 PRD/spec/tasks/important-variables/三件套 — Dev 不动
- 字段名约定：`clearRunsAndDiffsByDate(db, date)` (新函数，按 date 跨 BU)；`clearRunsAndDiffsByDateBu(db, date, bu)` (已有，按 (date, BU) 单 BU)
- spec §三 IPC 表 tracked 标注：参照 v2.1.2 月度BU 模块风格（说明列追加 "（tracked via usage-stats wrapper）"）

**round 3 验证清单（PR self-review 前必跑）**：
- `npm run smoke` 全套（含 Case A-K + Case L/M/N/O + 新 Case P）→ 退出码 0
- `grep -n "clearRunsAndDiffsByDate\b" src/backend/biz-op-recon-db/run-repository.js src/main-process/biz-op-recon-session.js` → run-repository.js 命中**函数定义**；session.js `runFlowImportAsync` 命中**调用**
- `grep -n "trackedIpcHandle.*bizOpRecon:" src/main.js | wc -l` → 5（5 个核心 action handler 包装）；`grep -n "ipcMain.handle('bizOpRecon:" src/main.js | wc -l` → 10（其余 query/dialog/helper handler 保持 plain）；合计 15
- `grep -n "业务OP数据核对" src/backend/usage-stats.js` → 命中 FUNCTION_REGISTRY 注册行
- `grep -n "preview:biz-op-recon" package.json` → 命中 `preview:all` script 链
- `cat package-lock.json | grep '"version":' | head -3` → 顶层 version 字段 = 2.1.3
- 真实数据手测：导入业务OP T-2/T-1 + 流水（同 date 跨 2 个 BU），跑 2 个 BU 对账成功 → 重新导入同日流水 → 「导出差异」对话框两个 BU 的 success 日期均消失（runs 已清，需重新跑对账）

**known issue（不在 round 3 修，留 PRD §6.5 KI-1 不变）**：v2.1.2 月度BU回填校验对应位置有 `createBankBuReconFileImportPromptDialog`（导入文件前提示弹原生窗 UX 对齐），v2.1.3 业务OP 模块当前缺失同位置 dialog；留 v2.1.4 补齐（round 1-7 都未补，KI-1 持续保留）。

---

## 十八、round 4 self-review 修订记录（v0.10 — 2026-05-14）

> PR #45 round 3 修订完成后再过 reviewer agent（Codex 自动 review）；reviewer 给 1 P1 ⚠️ 资金红线 finding（与 round 3 P1 流水跨 BU 清互补）+ 用户明确要求 USER_GUIDE 流水汇总性质解释段。用户拍板"全修"。下表为 round 4 修订全部条目（PM/Dev 两侧 task 划分）。

| # | 级别 | 内容 | spec/PRD 落实点 | 代码改动文件（Dev 侧） |
|---|---|---|---|---|
| **P1** | ⚠️ Critical 资金红线 | `runBizOpImportAsync` 成功路径只清当天 (date, BU) 的 runs/diff_rows，不清下一日 (date+1, BU) 的 runs/diff_rows → 用户重导业务OP D 数据后 D+1 日的旧 run 仍按"旧 T-2 期末 + 流水累加"算 = stale 差额 → 「导出 D+1 差异」拿错数据 = 资金事故。修法：新增 `addOneDay(date)` helper（UTC 实现，与 `subOneDay` 对偶）+ `runBizOpImportAsync` 事务内追加 `clearRunsAndDiffsByDateBu(db, addOneDay(date), bu)` 调用 + smoke Case Q 覆盖。**与 round 3 P1 互补**：业务OP 单 BU 跨 2 日清；流水跨 BU 单日清 | PRD §3.3.1 业务OP 流程描述补 + PRD §3.5.7 关键不变量段新增（业务OP 重导清下一日 runs 不变量）+ spec §三 IPC `import:run-biz-op` 出参描述补（已隐含在 §5.0.1 函数签名表 `runBizOpImportAsync` 行）+ spec §5.0.1 函数签名表新增 `addOneDay` + `runBizOpImportAsync` 两行 + spec §九 Case Q 新增 + spec §十二 升格 2 条（runBizOpImportAsync Critical / addOneDay Risk-sensitive） | `src/main-process/biz-op-recon-session.js` `runBizOpImportAsync` 事务追加 `clearRunsAndDiffsByDateBu(db, addOneDay(date), bu)` 调用 + 新增 `addOneDay(date)` helper（UTC 实现，与 `subOneDay` 对偶）；`scripts/smoke-test.js` 新增 Case Q |
| **USER_GUIDE 流水汇总性质解释** | 文档（用户明确要求） | 用户在 round 4 测试中提出"BU-A 与 BU-B 共用同一份流水文件"的解释空缺，要求把流水汇总性质讲清楚（这是 round 3 P1 流水重导跨 BU 清的根因）。USER_GUIDE §1.7.x 流水导入说明附近补一段：流水文件 = 该日所有部门的流水汇总（用户每日只导一份），按 normalizeBu 过滤跨 BU 共用 → 重导一份 = 所有 BU 对账失效。**建议合并到同一个"重导规则"小节**（与 round 4 P1 业务OP 跨 2 日清说明并列），便于用户对照"流水跨 BU 共用 / 业务OP 跨日依赖"两种模型 | docs/USER_GUIDE.md §1.7.x 流水导入说明附近合并新建"重导规则"小节（含流水汇总性质 + 业务OP 跨日清两段） | — (PM 侧文档；Dev 不动) |

**协调（PM/Dev 并行）**：
- Dev 改 `src/main-process/biz-op-recon-session.js` (P1 业务OP 重导清下一日 + addOneDay helper) + `scripts/smoke-test.js` (P1 Case Q) — PM 不动
- PM 改 PRD/spec/tasks/important-variables/三件套 — Dev 不动
- 字段名约定：`addOneDay(date)` (新 helper, UTC 实现，与 `subOneDay` 对偶；与 R2-M4 双源说明不同：addOneDay 单源，仅 session.js 定义)
- USER_GUIDE 流水汇总性质段 + 业务OP 跨日清说明 **合并到同一个"重导规则"小节**（信息密度高，便于用户对照两种模型）

**round 4 验证清单（PR self-review 前必跑）**：
- `npm run smoke` 全套（含 Case A-K + Case L/M/N/O + Case P + 新 Case Q）→ 退出码 0
- `grep -n "function addOneDay" src/` → 命中 1 处（`src/main-process/biz-op-recon-session.js`，单源）；与 `subOneDay` 双源不同（addOneDay 不在 run-repository.js 出现 — 业务OP 重导清逻辑只在 session.js 触发）
- `grep -n "clearRunsAndDiffsByDateBu" src/main-process/biz-op-recon-session.js` → `runBizOpImportAsync` 函数体应有 **两次** 调用（当天 + addOneDay(date)）
- `grep -n "addOneDay" src/main-process/biz-op-recon-session.js` → 至少 2 命中：函数定义 + `runBizOpImportAsync` 事务内调用
- 真实数据手测：BU-A 跨 D-1 / D / D+1 三日导入业务OP + D / D+1 流水，跑 D 与 D+1 两 run 成功 → 重导 D 业务OP（修正后）→ 「导出差异」对话框 D 与 D+1 两个日期均消失（两 run 已清，需重新跑对账）
- 真实数据手测：UTC+12 时区设备（如 New Zealand）跑 smoke Case Q → addOneDay 返回正确 D+1（不抢跑到 D+2）

---

## 十九、round 5 self-review 修订记录（v0.10.1 — 2026-05-14）

> PR #45 round 4 修订完成后再过 reviewer agent（Codex 自动 review）；reviewer 给 0 critical + 0 important + 1 P3（纯文档归档口径残留）finding。用户拍板"全修"。下表为 round 5 修订全部条目（PM 单侧 task — 无代码改动 / 无 smoke 改动）。

| # | 级别 | 内容 | spec/PRD 落实点 | 代码改动文件（Dev 侧） |
|---|---|---|---|---|
| **P3** | Minor（纯文档归档口径残留） | 5 处归档文档残留旧口径 "17 IPC bizOpRecon:* 全部用 trackedIpcHandle 包装"，与 round 3 实际收口的 "15 IPC = 5 tracked + 10 plain"（D6 拍板"仅成功 action 计数"+ v2.1.2 月度BU 模块同款分级 pattern）不符。具体位置：CHANGELOG.md:93 § round 3 P2 usage-stats 段；docs/VERSION_FEATURE_HISTORY.md:37 round 3 修订摘要；docs/iterations/v2.1.3/PRD-v2.1.3.md:5 标题表 v0.10 描述；docs/iterations/v2.1.3/PRD-v2.1.3.md:607 §6.4 round 3 P2 段；docs/prs/待merge-PR #45.md:55 ipcRenderer 命中条目。5 处统一改为 "5 个核心 action 用 trackedIpcHandle + 10 个 query/dialog/helper 保持 plain（共 15 个 bizOpRecon:* IPC handler）"。**不阻断功能但归档文档误导后续 review/验收** — 全文档统一口径 | CHANGELOG.md round 3 P2 段 + VFH round 3 摘要行 + PRD §6.4 round 3 段 + PRD 标题表 v0.10 描述 + PR 草稿 ipcRenderer 行 + 本节 spec §十九 新增 | — (PM 纯文档；Dev 不动；smoke 不变) |

**协调（PM 单侧）**：
- 本 round 全部 PM 文档反向同步 — Dev 不参与（无代码改动 / 无 smoke 改动）
- 5 处口径统一文案：`"5 个核心 action（导入业务OP / 导入流水 / 开始运行 / 导出指定日期 / 导出区间）用 trackedIpcHandle 包装；其余 10 个 query/dialog/helper handler 保持 plain ipcMain.handle（共 15 个 bizOpRecon:* IPC handler）"`

**round 5 验证清单（PR self-review 前必跑）**：
- `grep -rn "17 IPC\|17 个 bizOpRecon\|17 IPC bizOpRecon" CHANGELOG.md docs/VERSION_FEATURE_HISTORY.md docs/iterations/v2.1.3/ docs/prs/` → 应**无输出**（全文档口径统一为 15 IPC = 5 tracked + 10 plain）
- `grep -n "trackedIpcHandle.*bizOpRecon:" src/main.js | wc -l` → 5（与 round 3 验证清单一致）
- `grep -n "ipcMain.handle('bizOpRecon:" src/main.js | wc -l` → 10（与 round 3 验证清单一致）
- 文档口径 5 + 10 = 15 与 code 实际 5 + 10 = 15 完全一致

**known issue（不在 round 5 修，留 PRD §6.5 KI-1 不变）**：v2.1.2 月度BU回填校验对应位置有 `createBankBuReconFileImportPromptDialog`（导入文件前提示弹原生窗 UX 对齐），v2.1.3 业务OP 模块当前缺失同位置 dialog；留 v2.1.4 补齐（round 1-7 都未补，KI-1 持续保留）。

**known issue（不在 round 4 修，留 PRD §6.5 KI-1 不变）**：v2.1.2 月度BU回填校验对应位置有 `createBankBuReconFileImportPromptDialog`（导入文件前提示弹原生窗 UX 对齐），v2.1.3 业务OP 模块当前缺失同位置 dialog；留 v2.1.4 补齐（round 1-7 都未补，KI-1 持续保留）。
