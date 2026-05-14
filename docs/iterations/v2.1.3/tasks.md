# tasks — v2.1.3 任务拆分

| 字段 | 值 |
|---|---|
| 文档版本 | v0.10（2026-05-14，基于 spec v0.10 — round 4 self-review 修订：Codex 自动 review 1 P1 ⚠️ 资金红线（业务OP 重导清下一日 (date+1, BU) runs/diff_rows，新增 `addOneDay(date)` helper UTC 实现 + `runBizOpImportAsync` 事务追加 `clearRunsAndDiffsByDateBu(db, addOneDay(date), bu)` 调用 + smoke Case Q）+ USER_GUIDE 流水汇总性质解释段（用户明确要求）+ T18 round 4 修订记录；v0.9 = 2026-05-14 round 3 self-review 修订：Codex 自动 review 1 P1 ⚠️ 资金红线（流水重导清该 date 跨 BU 的 runs/diff_rows，新增 `clearRunsAndDiffsByDate` 函数 + smoke Case P）+ 2 P2（lockfile 同步 / usage-stats 接入 17 IPC trackedIpcHandle）+ 1 P3（preview:all 接入 biz-op-recon）+ T17 round 3 修订记录；v0.8 = 2026-05-14 round 2 self-review 修订；v0.7 = 2026-05-14 round 1 self-review 修订；v0.6 = 2026-05-13 fix6 PRD #14 拍板回滚；v0.5 = fix5 PRD 拍板修订；v0.4 = fix4 资金红线 bug 修复；v0.3 = fix1+fix2 手动测试回归） |
| 关联 spec | `spec.md` |
| 关联 PRD | `PRD-v2.1.3.md` |
| 工作分支 | `v2.1.3` |
| 起草人 | team-lead |
| 总任务数 | 19（T0 spec、T1 migration、T2 reader/validator、T3 session/算法、T4 writer、T5 前端面板/dialog、T6 IPC、T7 smoke、T8 preview、T9 三件套 + version、T10 self-review + PR 草稿、T11 fix1+fix2 自测回归记录、T12 fix4 资金红线 bug 修复记录、T13 fix5 PRD 拍板修订 + Dev 实施、T14 fix6 PRD #14 拍板回滚 + Dev 实施、T15 round 1 self-review 修订、T16 round 2 self-review 修订、T17 round 3 self-review 修订、**T18 round 4 self-review 修订（round 3 完成后 Codex 自动 review 反馈：1 P1 资金红线 — 业务OP 重导清下一日 runs，与 round 3 P1 流水跨 BU 清互补；+ USER_GUIDE 流水汇总性质解释段用户明确要求）**） |

---

## 任务分组与依赖图

```
[T0 PRD/spec/tasks 起草 + OPEN ISSUE 全部拍板] (✅ 已完成 v0.2)
        │
        ▼
[T1 SQLite migration]   ← 4 张表（无 errors 表，已按 #5 调整）
        │
        ▼
[T2 reader + validator]   ← 双重校验 #1 + 出入方向枚举 #3 + 整批拒绝 #5
        │
        ▼
[T3 session + 对账算法] ⚠️ 资金红线   ← parseSignedAmount #3 + 1:N 精准 #6 + normalizeBu #7
        │
        ▼
[T4 writer (1 sheet / N sheet) + 失败报告 writer]
        │
        ▼
[T5 前端面板 + dialogs + BU 下拉]
        │
        ▼
[T6 IPC handlers + preload]
        │
        ▼
[T7 smoke 测试 (A-G 7 用例)]
        │
        ▼
[T8 preview script + 4 张截图]
        │
        ▼
[T9 三件套 (CHANGELOG / VFH / USER_GUIDE) + version bump 2.1.2 → 2.1.3]
        │
        ▼
[T10 self-review 圈 + PR 草稿入 docs/prs/]
```

---

## T0：起草 PRD / spec / tasks 三件套 + OPEN ISSUE 全部拍板（本任务）

- **状态**：✅ 已完成（2026-05-13 起草 v0.1 + 同日拍板 14 项 OPEN ISSUE → v0.2）
- **产物**：
  - `docs/iterations/v2.1.3/PRD-v2.1.3.md` v0.2（PRD §6.1 共 18 项已拍板）
  - `docs/iterations/v2.1.3/spec.md` v0.2（DDL / IPC / 算法函数签名 / writer 全部精确化）
  - `docs/iterations/v2.1.3/tasks.md` v0.2（每个 task 关联 OPEN ISSUE 改为"已拍板 #X = Y"引用）
- **下一步**：Dev 启动 T1

---

## T1：SQLite migration + DDL（**4 张表**）

- **依赖**：T0
- **文件**：
  - `src/backend/biz-op-recon-db/migrations.js`（新建）
  - `src/backend/database/migrations.js`（修改：调用新的 migrations）
- **DDL 内容**：spec.md §四 4 张表（**已拍板 #5 整批拒绝 → 不需要 errors 表**）
  - `biz_op_recon_imports` — 业务 OP 主表（id / data_date / bu_name / row_index / 23 列 + imported_at；索引：(date,bu) / (date,bu,account_no) / bu）
  - `biz_op_recon_flow_imports` — 流水对账单主表（id / data_date / row_index / 28 列 + imported_at；索引：date / (date,bu_dept) / (date,account_no)）
  - `biz_op_recon_runs` — 运行记录（id / data_date / bu_name / run_at / status='success' / 7 个统计字段 / export_path；索引：(date,bu,run_at DESC) / (status,date)）
  - `biz_op_recon_diff_rows` — 差异行明细（id / run_id FK / data_date / bu_name / source_table='T1'\|'T2' / source_row_id FK / cmp_t2 / multi_op_flag / cmp_amount / amount_diff；索引：run_id / (date,bu)）
- **关联 OPEN ISSUE**：
  - 已拍板 #4 = A 替换 + 原子事务（事务 SQL 写到 imports-repository.clearByDateBu）
  - 已拍板 #5 = 整批拒绝 + 失败报告 xlsx（**不需要 errors 表**）
  - 已拍板 #15 = 重新导入清空 runs + diff_rows（DELETE 顺序：diff_rows → runs → imports → INSERT，同事务）
- **acceptance criteria**：
  - 启动 app → SQLite 浏览工具确认 **4 张表**存在（无 errors 表）+ 索引齐全
  - 重启 app → 不报 "table already exists"（幂等）
  - `DROP DATABASE` 再启动 → 全部表从零建好
  - SELECT 1 from biz_op_recon_diff_rows FK 引用 biz_op_recon_runs 正确
- **验证命令**：
  ```bash
  npm start  # 启动 app；右下角无报错
  sqlite3 ~/Library/Application\ Support/bank-bill-excel-tool/tool-data.sqlite ".schema biz_op_recon_imports"
  sqlite3 ~/Library/Application\ Support/bank-bill-excel-tool/tool-data.sqlite ".tables biz_op_recon_*"
  ```
- **commit message**：`[v2.1.3] feat(t1): SQLite migration — biz_op_recon_* 4 张表 DDL + 索引`
- **预估**：S（30-60 分钟）

---

## T2：后端 reader + validator + repository

- **依赖**：T1
- **文件**：
  - `src/backend/biz-op-recon-db/columns.js`（新建）
    - 导出 `BIZ_OP_HEADERS`（23 列冻结数组，按 spec §2.1 顺序：Billdate / 业务方 / 客户编号 / ... / 清结算系统更新时间）
    - 导出 `FLOW_HEADERS`（28 列冻结数组，按 spec §2.2 顺序：BizId / 账单日期 / ... / 系统修改时间）
    - 导出 `bizOpHeaderToDbColumn(header)` / `flowHeaderToDbColumn(header)` 映射函数
    - 导出 `bizOpRowToArray(row)` / `flowRowToArray(row)` 反序列化函数（writer 用）
  - `src/backend/biz-op-recon-import/reader.js`（新建）
    - 用 `xlsx`/SheetJS 读第一个 sheet
    - 表头取第 1 行，数据从第 2 行起
    - `blankrows: true` 保留行号一致性（**复用 v2.1.2 PR #43 F5 fix 经验**）
    - 返回 `{headers, rows, rowIndices}`（rowIndices 是 Excel 真实行号数组）
  - `src/backend/biz-op-recon-import/validator.js`（新建）
    - `validateBizOpHeaders(headers)` / `validateFlowHeaders(headers)`（严格 23/28 列匹配，列名 trim 后比较）
    - `validateBizOpRow(row) → { ok, reason? }`：**双重校验**（已拍板 #1 = B）
      - 常量 `AMOUNT_EPSILON = 1e-2`
      - 任一字段（begin / amount / amount_in / amount_out / end）非数值 → ok=false，reason 含具体字段名与原值
      - 校验 (1): `Math.abs(amt - (amtIn - amtOut)) > 1e-2` → ok=false，reason 格式 `双重校验失败：发生额 X ≠ 发生额(入) Y - 发生额(出) Z，差额 W`
      - 校验 (2): `Math.abs(end - (begin + amt)) > 1e-2` → ok=false，reason 格式 `双重校验失败：期末余额 X ≠ 期初余额 Y + 发生额 Z，差额 W`
    - `validateFlowRow(row) → { ok, reason? }`：出入方向枚举（已拍板 #3）
      - `direction` 必须严格 ∈ {'入', '出'}（**不**做 normalize），其他 → ok=false，reason 格式 `出入方向非法：实际值 "X"，仅允许 "入" 或 "出"`
      - `recon_amount` 必须可 parseAmount，否则 ok=false
      - `account_no` 非空，否则 ok=false
  - `src/backend/biz-op-recon-db/imports-repository.js`（新建）
    - `clearByDateBu(db, date, buName)` — 仅 DELETE `biz_op_recon_imports`，**runs/diff_rows 清空由 run-repository.clearRunsAndDiffsByDateBu 调用**
    - `insertRows(db, date, buName, rows, rowIndices)`（批量插入，prepared stmt + 事务）
    - `getRowsByDateBu(db, date, buName)` — 对账算法用，**SQL WHERE 比较时用 `LOWER(TRIM(bu_name)) = LOWER(TRIM(?))`** 实现 normalizeBu 语义（资金红线 #7 拍板 C 一致性）
    - `getRowById(db, id)` — writer 用
    - `listDistinctBus(db)` → `[{buName, count}]`（BU 下拉框枚举，**保留原值**不 normalize）
    - `listImportedDateBuPairs(db)` → `[{date, buName, rowCount}]`
    - `countByBu(db, buName)` — `import:check-single-day` 用
  - `src/backend/biz-op-recon-db/flow-imports-repository.js`（新建）
    - `clearByDate(db, date)` — DELETE WHERE data_date=?（流水不分 BU）
    - `insertRows(db, date, rows, rowIndices)`
    - `getRowsByDate(db, date)`
    - `getRowsByDateBu(db, date, buName)` — **`LOWER(TRIM(bu_dept)) = LOWER(TRIM(?))`** 过滤（资金红线一致性）
    - `listImportedDates(db)`
- **关联 OPEN ISSUE**：
  - 已拍板 #1 = B 双重校验（validateBizOpRow 实现，epsilon=1e-2）
  - 已拍板 #3 = 中文「入」/「出」枚举（validateFlowRow 实现，严格枚举）
  - 已拍板 #4 = 替换 + 原子事务（clearByDateBu + insertRows 事务包装）
  - 已拍板 #5 = 整批拒绝（**validator 不直接写库，由 session 层在校验失败时整批拒绝并调用 writer 落失败报告**；本 task 不创建 errors-repository）
  - 已拍板 #7 = trim + toLowerCase（repository.getRowsByDateBu 内部 normalizeBu 过滤）
  - 已拍板 #15 = 联动清空 runs + diff_rows（imports-repository 不直接做，由 session 层编排）
- **acceptance criteria**：
  - 用 `assets/业务OP账单.xlsx`（空数据）测试：headers 校验通过、rows=[]
  - 用 `assets/流水对账单.xlsx`（空数据）测试：headers 校验通过、rows=[]
  - 故意删一列表头 → ok=false, error 文本精确指出第几列
  - 故意构造行违反双重校验 (1) → validateBizOpRow ok=false, reason 包含"发生额 X ≠ 发生额(入) Y - 发生额(出) Z"
  - 故意构造行违反双重校验 (2) → validateBizOpRow ok=false, reason 包含"期末余额 X ≠ 期初余额 Y + 发生额 Z"
  - 故意构造行 `direction='DEBIT'` → validateFlowRow ok=false, reason 包含"仅允许 入 或 出"
  - 重复导入同 (date, BU) → 原数据清空，新数据落库（事务原子）
- **验证命令**：
  ```bash
  npm run smoke  # 见 T7（T2 完成时 smoke 还未覆盖，可加 unit 自检脚本）
  ```
- **commit message**：`[v2.1.3] feat(t2): biz-op-recon reader + 双重校验/出入方向 validator + 2 repositories`
- **预估**：M（2-3h）

---

## T3：session + 对账算法（**资金红线 ⚠️**）

- **依赖**：T1 + T2
- **文件**：
  - `src/main-process/biz-op-recon-session.js`（新建）
    - 常量定义（spec §5.0）：
      - `AMOUNT_EPSILON = 1e-2`
      - `VALID_DIRECTION_IN = '入'` / `VALID_DIRECTION_OUT = '出'`
    - helper 函数（spec §5.2）：
      - `normalizeAccountKey(v)` — 仅 trim
      - `normalizeBu(v)` — trim + toLowerCase（已拍板 #7 = C）
      - `parseSignedAmount(direction, amount)` — '入' → +num，'出' → -num，其他 → NaN（已拍板 #3）
      - `parseAmount(v)` — 字符串数值解析（去千分位 `,`，非数 → NaN）
      - `subOneDay(yyyymmdd)` — T-1 → T-2 字符串日期减一
      - `aggregateFlowByAccount(flowRows, buName)` — 按 normalizeBu 过滤 + 按 normalizeAccountKey 累加 signedAmount → Map
      - `computeT1Op(t2OpRows, flowAggMap)` — T-2 期末 + 累加 = 计算 T-1 期末 → Map
      - `compareT1OpWithComputed(t1OpRows, computedT1Map)` — **1:N 逐行独立比**（已拍板 #6 = A），返回 `{diffRows, stats:{amountDiffCount, multiOpAccountCount}}`
      - `diffT1AndT2Accounts(t1OpRows, t2OpRows)` — 账户号差集，返回 `{onlyInT1, onlyInT2}`
    - 核心函数：`runBizOpReconciliation({ date, buName })` → `{runId, stats}`
      - 编排：取数 → aggregateFlowByAccount → computeT1Op → compareT1OpWithComputed → diffT1AndT2Accounts → 合并 diffRows → insertRun + insertDiffRows
      - 差异行写入条件（已拍板 #10 = A）：`cmp_amount === '不相等' OR cmp_t2 !== ''`（相等行不进表）
      - 状态机：永远 `status='success'`（系统错误直接 throw 给 IPC handler）
    - 整批拒绝 + 失败报告流程（spec §5.4）：
      - `runBizOpImport({date, filePath})` → `{status, ...}`：双重校验全部通过 → 事务清空旧数据 + INSERT；任一不过 → 调用 `writeBizOpErrorReportXlsx` 落失败报告 + 返回 `{status:'rejected', errorReportPath, errorRows}`
      - `runFlowImport({date, filePath})` → 同上但用 `validateFlowRow` + `writeFlowErrorReportXlsx`
  - `src/backend/biz-op-recon-db/run-repository.js`（新建）
    - `insertRun(db, {date, buName, status, stats}) → runId`
    - `getRunById(db, runId)`
    - `listRunsByDateBu(db, date, buName)`
    - `listSuccessDates(db, buName)` → `[{date, runId, runAt}]`（已拍板 #13 = A 风格）
    - `listSuccessDatesInRange(db, buName, startDate, endDate)`（区间导出用）
    - `listReadyDates(db, buName)` — **"三件齐"日期**（T-1 业务OP + T-2 业务OP + T-1 流水按 normalizeBu 过滤均非空；SQL 使用 EXISTS + LOWER(TRIM(...)) 实现）（已拍板 #12 = A）
    - `insertDiffRows(db, runId, date, buName, diffRows)`（批量 + 事务）
    - `getDiffRowsByRun(db, runId)`
    - `clearRunsAndDiffsByDateBu(db, date, buName)` — **顺序：DELETE diff_rows WHERE run_id IN (...) → DELETE runs**（FK 约束）（已拍板 #15 = A）
- **关联 OPEN ISSUE**：
  - 已拍板 #3 = 中文「入」/「出」入=+ 出=-（`parseSignedAmount` 实现）
  - 已拍板 #6 = A 1:N 逐行独立比（`compareT1OpWithComputed` 实现）
  - 已拍板 #7 = trim + toLowerCase（`normalizeBu` 实现 + repository 内 SQL 使用）
  - 已拍板 #10 = **E（v0.3 fix2.4 回滚）三类差异都进 diff_rows，writer 阶段不再标黄**（差异表所有行白底）
  - 已拍板 #12 = A 前置 enable（`listReadyDates` 实现，SQL 三件齐判定）
  - 已拍板 #13 = A 完全复用 v2.1.2 list-ready / success 命名风格
  - 已拍板 #15 = A 重新导入清空 runs + diff_rows（`clearRunsAndDiffsByDateBu` 实现，事务）
- **acceptance criteria**（**资金红线，必须人工 review + smoke 双覆盖**）：
  - smoke A（核心对账）：测算金额差额正确分类，epsilon=1e-2 验证通过
  - smoke B（多 OP 行）：3 条 T-1 行按 #6 = A 各自独立标，N 条全独立进 diff_rows
  - smoke C（账户号增减）：T-1有T-2无 来源 T-1、T-2有T-1无 来源 T-2 正确分类
  - smoke D（流水累加）：`parseSignedAmount('入', x) === +x`，`parseSignedAmount('出', x) === -x`，`parseSignedAmount('DEBIT', x) === NaN`
  - smoke G（BU 隔离）：normalizeBu 容忍大小写 + 空白差异，但不串其他 BU 数据
  - 真实数据回放（如有）：人工 review 1-2 个用户提供的真实文件，对比结果
- **验证命令**：
  ```bash
  npm run smoke
  ```
- **⚠️ 风险提醒**：
  - 此 task 是本迭代**最大资金红线**，PR review 必须人工跑真实数据样本
  - `parseSignedAmount` 的 case 分支必须**完全枚举**，未知方向值必须返回 NaN（不能默认 +/-）；导入阶段已通过 `validateFlowRow` 拦截非「入/出」值，这里是二次保护
  - `runBizOpReconciliation` / `compareT1OpWithComputed` / `parseSignedAmount` / `validateBizOpRow` 建议升格进 `rules/important-variables.md` Risk-sensitive 层
- **commit message**：`[v2.1.3] feat(t3): biz-op-recon session + 4 步对账算法 + 整批拒绝（资金红线）`
- **预估**：L（3-5h）

---

## T4：writer（差异表导出 + 失败报告）

- **依赖**：T3
- **文件**：
  - `src/main-process/biz-op-recon-writer.js`（新建）
    - `writeSingleDateDiffWorkbook({ date, buName, runId, savePath })` — 单日差异表（spec §6.1）
      - sheet 名 = `date` 即 `YYYY-MM-DD` ISO 格式（已拍板 #14 = A）
      - 表头 = 23 列 BIZ_OP_HEADERS + 4 列 `['比对T-2日', '同账户号多个OP', '比对测算金额', '测算金额差额']`
      - 表头加粗 size=10
      - 数据行 = 来自 diff_rows 的所有行 + 拼接源行原 23 列 + 4 字段
      - **差异表无颜色高亮**（已拍板 #10 = E，v0.3 fix2.4 回滚；writer 不调用 `r.eachCell + fill`）
    - `writeDateRangeDiffWorkbook({ buName, startDate, endDate, savePath })` — 区间差异表（spec §6.2）
      - N sheet，每个 success 日期一 sheet，sheet 名 = `YYYY-MM-DD`
      - 区间内无 success run 的日期 → `skippedDates: [date]` 返回
      - successDates 为空 → 占位 sheet `'无差异数据'`
    - `writeBizOpErrorReportXlsx({date, buName, errorRows, saveDir, fileName})` — 业务 OP 失败报告（spec §6.3）
      - 单 sheet 名 = `date`
      - 表头 = 23 列 BIZ_OP_HEADERS + `['失败行号', '失败原因']`（共 25 列）
      - 所有行黄底（v0.3：差异表已无黄底，**失败报告是否同步去黄底由 Dev 在 PR 中决定**；spec §6.3 内有备注）
    - `writeFlowErrorReportXlsx({date, errorRows, saveDir, fileName})` — 流水失败报告（spec §6.3）
      - 单 sheet，表头 = 28 列 FLOW_HEADERS + `['失败行号', '失败原因']`（共 30 列）
    - `YELLOW_FILL` 常量保留（差异表 writer 不再调用；失败报告 writer 仍可调用）
- **默认文件名**（已拍板 #9 = A）：
  - 单日差异表：`业务OP数据核对_{BU}_{YYYYMMDD}_{HHMMSS}.xlsx`
  - 区间差异表：`业务OP数据核对_{BU}_{YYYYMMDD}-{YYYYMMDD}_{HHMMSS}.xlsx`
  - 业务 OP 失败报告：`业务OP校验失败报告_{BU}_{YYYYMMDD}_{HHMMSS}.xlsx`
  - 流水失败报告：`流水对账单校验失败报告_{YYYYMMDD}_{HHMMSS}.xlsx`
- **失败报告保存路径**：`Documents/网银账单生成小助手/error-reports/{date}/`
- **关联 OPEN ISSUE**：
  - 已拍板 #5 = 整批拒绝 + 失败报告（`writeBizOpErrorReportXlsx` / `writeFlowErrorReportXlsx` 实现）
  - 已拍板 #9 = A 文件名格式（4 类文件名 helper）
  - 已拍板 #10 = **E（v0.3 fix2.4 回滚）差异表无颜色高亮**（writer 不调用 fill；进表条件不变）
  - 已拍板 #14 = A `YYYY-MM-DD` ISO sheet 名
- **acceptance criteria**：
  - smoke A/B/C 生成的差异表 xlsx 用 Excel 打开 → 23 + 4 列表头 + 数据行；**差异表无颜色高亮**（v0.3 fix2.4 回滚验收）
  - 4 列 meta 字段（比对T-2日 / 同账户号多个OP / 比对测算金额 / 测算金额差额）取值正确
  - smoke E 生成的失败报告 xlsx → 23 + 2 列表头 + 失败行；保存路径正确（黄底保留与否由 Dev 决定）
  - smoke F（区间）→ N 个 sheet，sheet 名 = `YYYY-MM-DD`
  - 区间内有空日期 → `skippedDates` 数组返回
- **验证命令**：
  ```bash
  npm run smoke
  open <生成的 xlsx>  # 人工检查 23+4 列表头 + 无颜色高亮（差异表）+ 失败报告 23+2 列（黄底由 Dev 决定）
  ```
- **commit message**：`[v2.1.3] feat(t4): biz-op-recon writer — 差异表 (1/N sheet) + 失败报告 (业务OP/流水)`
- **预估**：M（2h）

---

## T5：前端面板 + dialogs + BU 下拉

- **依赖**：T0（spec 落定 DOM 标识）
- **文件**：
  - `index.html`（修改）
    - 主导航追加 `<button class="nav-module-btn" data-module="biz-op-recon">业务OP数据核对</button>`
    - 追加 `<section id="bizOpReconModulePanel">` 完整结构（spec §7.1）
  - `src/renderer.js`（修改）
    - `MODULES` 枚举追加 `bizOpRecon: { id: 'biz-op-recon' }`
    - `elements` 缓存追加 6 个新标识（spec §7.3）
    - 模块切换：`elements.bizOpReconModulePanel.hidden = moduleId !== MODULES.bizOpRecon.id`
    - `bizOpReconState` 状态对象（buList / selectedBu / readyDatesCount / successDatesCount）
    - `refreshBizOpReconButtons()` 状态机（拉 bu:list + run:list-ready-dates + export:list-success-dates）
    - `restoreBizOpReconPanelState()` 切模块时调用
    - 3 个按钮 click handler + BU 下拉 change handler
    - 状态栏 `setBizOpReconStatus(message, tone)` 工具函数
    - **BU 下拉行为**（v0.3 fix2.2 / fix2.3）：
      - option label **仅显示 buName**（不附加 ` (N 行)` 行计数）
      - `buList.length === 0` → 单一空白 placeholder option（继承 fix1.2）+ select disabled + selectedBu=''
      - `buList.length > 0` → 移除空白 option + 默认选中第一项；smart preserve（上次 selectedBu 仍在新 buList 中 → 保留；否则重置为第一项）
      - BU 行容器 CSS 宽度与"导出差异"按钮左右边界对齐（fix2.1 视觉约束）
    - 导入流程编排（含 #11 续导对话框，**v0.3 删除错误报告对话框分支**）：
      ```
      [导入文件] → bu:list 检查 → 弹日期对话框（默认值 = subOneDay(today)，fix1.4/fix2.5）→ 弹文件选择 → import:run-biz-op
       → 若 {status:'rejected'} → 状态栏文字 + 失败报告路径（v0.3 fix2 改）
       → 若 {status:'success'} → import:check-single-day → 若 onlyOneDay → 弹续导对话框 (#11)
      [接续路径] 第2日：同上一轮
      ```
  - `src/renderer-dialogs.js`（修改 — **5 个 factory**；v0.3 删除 ErrorReportDialog）
    - `createBizOpReconDatePickerDialog({title, defaultDate, onConfirm, onCancel})` — 通用日期选择
      - **#8 拍板 A**：年下拉 = `[currentYear-1, currentYear, currentYear+1]`（2025/2026/2027），月 = 1-12，日 = 1-31，**不联动**
      - **v0.3 fix1.4 / fix2.5**：业务OP 日期 + 流水对账单日期对话框调用时 `defaultDate = subOneDay(today)`（系统日期 - 1）
    - `createBizOpReconFileImportPromptDialog({title, detail, onConfirm, onCancel})` — 文件导入前置提示
    - `createBizOpReconReconcileDialog({readyDates, defaultDate, onConfirm, onCancel})` — "开始运行" 日期选择
      - **#12 拍板 A**：下拉 option 仅 readyDates；空时"完成"按钮 disabled
      - **v0.3 fix2.5 明确不改**：本对话框保持 ready 日期列表展示，不做"默认 T-1"处理
    - `createBizOpReconExportDialog({successDates, onConfirm, onCancel})` — "导出差异" 两 radio + 单日/区间联动
      - **#9 拍板 A** 默认文件名 / **#13 拍板 A** successDates 来源
    - `createBizOpReconSecondImportPromptDialog({firstDate, onConfirm, onCancel})` — "已导入第 1 日，是否立即导入第 2 日？"（**#11 拍板 B**）
    - ~~`createBizOpReconErrorReportDialog`~~ — **v0.3 fix1.5 + fix2 删除**：校验失败提示改为状态栏文字 + 失败报告路径（用户 cmd+点击打开），不再弹独立对话框
- **关联 OPEN ISSUE**：
  - 已拍板 #5 = 整批拒绝 + 失败报告（**v0.3 fix2 改**：状态栏文字 + 失败报告路径；删除 ErrorReportDialog）
  - 已拍板 #8 = A 年±1 / 月 1-12 / 日 1-31 不联动（`createBizOpReconDatePickerDialog` 选项构造）
  - 已拍板 #9 = A 文件名格式（`createBizOpReconExportDialog` 默认值构造）
  - 已拍板 #11 = B 续导确认（`createBizOpReconSecondImportPromptDialog`）
  - 已拍板 #12 = A 前置 enable（`createBizOpReconReconcileDialog` 下拉 option 限制 + 完成按钮禁用）
  - 已拍板 #13 = A 复用 v2.1.2 list-ready / success 风格（拉数据走 list-ready-dates / list-success-dates）
  - **v0.3 fix1.4 / fix2.5**：业务OP / 流水日期 dialog 默认 T-1
  - **v0.3 fix2.1 / fix2.2 / fix2.3**：BU 下拉行为（CSS 对齐 + label 去计数 + 空白 placeholder 切换 + smart preserve）
- **acceptance criteria**：
  - app 启动 → 主导航看到第 5 按钮
  - 点击切换 → 面板显示 + 按钮 disabled 状态符合 spec §7.4
  - 导入 1 个新 BU 后 → 下拉 option 自动多 1 项；**buList 非空时无空白 placeholder + 默认选中第一项**（fix2.3）
  - **option label 仅显示 buName，不含 `(N 行)`**（fix2.2）
  - **BU 行视觉宽度与"导出差异"按钮左右边界对齐**（fix2.1，PR self-review 截图核对）
  - 切到其它模块再切回 → 状态保留（BU 选择 / 按钮状态）
  - **日期对话框默认值 = 系统日期 - 1**（业务OP + 流水对账单两类；"选择需要对账的日期"对话框保持现状，fix2.5）
  - 日期对话框：年下拉显示 3 项（2025/2026/2027），月 12 项，日 31 项；选 2026-02-30 后端拒绝 + 状态栏报错
  - 第 1 日导入完成后续导对话框弹出，点"否"状态栏正确提示
  - **校验失败：状态栏文字 + 失败报告路径**（不再弹独立对话框，v0.3 fix2 改）
  - "开始运行"日期下拉只显示 ready 日期；ready 空时"完成"按钮 disabled
- **验证命令**：
  ```bash
  npm start  # 手动测试
  ```
- **commit message**：`[v2.1.3] feat(t5): biz-op-recon 前端面板 + 5 dialog factory + BU 下拉状态机`
- **预估**：L（4-5h）

---

## T6：主进程 IPC handlers + preload

- **依赖**：T2 + T3 + T4 + T5
- **文件**：
  - `src/main.js`（修改）— 追加 **16 个** `ipcMain.handle('bizOpRecon:*')` handler（spec §三）
    1. `bizOpRecon:status` — 模块状态查询
    2. `bizOpRecon:bu:list` — BU 下拉框枚举
    3. `bizOpRecon:import:pick-biz-op-date` — 业务OP 日期对话框
    4. `bizOpRecon:import:pick-biz-op-file` — 业务OP 文件对话框
    5. `bizOpRecon:import:run-biz-op` — 业务OP 导入（含双重校验 + 整批拒绝 + 失败报告 + 清空旧 runs，已拍板 #1/#4/#5/#15）
    6. `bizOpRecon:import:pick-flow-date` — 流水日期对话框
    7. `bizOpRecon:import:pick-flow-file` — 流水文件对话框
    8. `bizOpRecon:import:run-flow` — 流水导入（含出入方向枚举校验 + 整批拒绝 + 失败报告，已拍板 #3/#5）
    9. `bizOpRecon:import:open-error-report-folder` — 打开错误报告文件夹（shell.showItemInFolder）；**v0.3 fix2 主流程不再触发**，handler 保留以备后续场景
    10. `bizOpRecon:import:check-single-day` — 检查"库里仅一日数据"（已拍板 #11）
    11. `bizOpRecon:run:list-ready-dates` — 列出 ready 日期（已拍板 #12/#13）
    12. `bizOpRecon:run:pick-date` — 对账日期对话框
    13. `bizOpRecon:run` — 跑对账（已拍板 #3/#6/#7/#10）
    14. `bizOpRecon:export:list-success-dates` — 列出 success 日期（已拍板 #13）
    15. `bizOpRecon:export:pick-save-path` — 另存为对话框（已拍板 #9 默认文件名）
    16. `bizOpRecon:export:date` — 单日导出（已拍板 #14 sheet 名 ISO）
    17. `bizOpRecon:export:date-range` — 区间导出（已拍板 #14）
    18. `bizOpRecon:run:history` — 运行历史（debug，可选）
  - `src/preload.js`（修改）— `window.desktopApi.bizOpRecon.*` 暴露所有 18 个 handler
- **关联 OPEN ISSUE**：
  - 已拍板 #5 = 新增 `import:open-error-report-folder` handler
  - 已拍板 #11 = 新增 `import:check-single-day` handler
  - 已拍板 #13 = A 命名风格对齐 v2.1.2（`list-ready-dates` / `list-success-dates`，不是 `list-ready` / `list-success`）
- **acceptance criteria**：
  - `grep "ipcMain.handle('bizOpRecon:" src/main.js` ≥ 17 匹配（不含 debug `run:history`）
  - 每个 handler 都有 try/catch 包装 + 错误返回 `{error: ...}` 标准化结构
  - 前端 `window.desktopApi.bizOpRecon.run({...})` 不报 undefined
  - 失败报告流程：`import:run-biz-op` 返回 `{status:'rejected', errorReportPath, errorRows}` 时前端在状态栏文字 + 路径显示（v0.3 fix2 改），用户可直接 cmd+点击路径打开（`import:open-error-report-folder` handler 保留但主流程不调）
- **验证命令**：
  ```bash
  npm start  # 启动后 DevTools 验证 IPC 链通
  ```
- **commit message**：`[v2.1.3] feat(t6): main.js IPC handlers + preload — bizOpRecon:* 17-18 个 handler`
- **预估**：M（2-3h）

---

## T7：smoke 测试（全部 7 用例 + 推荐补 H）

- **依赖**：T3 + T4
- **文件**：`scripts/smoke-test.js`（修改：末尾追加用例）
- **必做用例**（spec §九，全部拍板已就绪，可一次性实现）：
  - 用例 A：核心对账（资金红线）
  - 用例 B：多 OP 行精准标差异（已拍板 #6 = A 1:N 独立比）
  - 用例 C：账户号增减差异（拍板 C：T-2 有 T-1 无来源 T-2 表）
  - 用例 D：流水累加 + 出入方向（已拍板 #3，资金红线）
  - 用例 E：业务OP 行整批拒绝 + 失败报告（已拍板 #1 双重校验 + #5 整批拒绝）
  - 用例 F：日期区间导出（已拍板 #14 ISO sheet 名）
  - 用例 G：BU 隔离（已拍板 #7 normalizeBu）
- **推荐补**：
  - 用例 H：重新导入清空旧 runs（已拍板 #15，资金红线 P1 fix 回归）
    - 构造：同 (date=2026-05-12, BU=A) 第 1 次导入 → 跑对账 1 次 → 第 2 次导入新数据 → 验证 runs/diff_rows 已清空（无旧 run）
- **acceptance criteria**：
  - `npm run smoke` 全部用例 PASS
  - 资金红线用例（A/B/D/E/H）必须人工 review smoke 输出文件
- **验证命令**：
  ```bash
  npm run smoke
  ```
- **commit message**：`[v2.1.3] test(t7): smoke 用例 A-G + H — biz-op-recon 全流程 + 资金红线 + 重新导入回归`
- **预估**：M（2-3h）

---

## T8：preview 截图（4 张）

- **依赖**：T5（前端 UI 完成）+ T6（IPC 链通）
- **文件**：
  - `scripts/preview-biz-op-recon.js`（新建）— 参照 `scripts/preview-bank-bu-recon.js`
  - `package.json`（修改）— 追加 `"preview:biz-op-recon": "node scripts/preview-biz-op-recon.js"`
  - 截图入仓：
    - `assets/preview-biz-op-recon-initial.png`
    - `assets/preview-biz-op-recon-importing.png`
    - `assets/preview-biz-op-recon-result.png`
    - `assets/preview-biz-op-recon-export-dialog.png`
- **acceptance criteria**：
  - `npm run preview:biz-op-recon` 一键生成 4 张截图
  - `git diff --stat assets/preview-biz-op-recon-*` 显示新增 4 个文件
- **验证命令**：
  ```bash
  npm run preview:biz-op-recon
  ```
- **⚠️ memory `workflow_frontend_previews`**：前端 PR 前**必须**重跑这 4 张
- **commit message**：`[v2.1.3] chore(t8): biz-op-recon preview script + 4 张截图`
- **预估**：M（2h）

---

## T9：文档三件套 + version bump

- **依赖**：T1-T8 全部完成
- **文件**：
  - `package.json`（修改）— `"version": "2.1.2"` → `"2.1.3"`
  - `CHANGELOG.md`（修改）— v2.1.3 段落
    - 标题：`## v2.1.3 (2026-MM-DD)`
    - 内容：新增模块「业务OP数据核对」+ 关键设计点（4 步对账算法 / 双重校验+整批拒绝 / 中文「入」「出」枚举 / BU 单选 / 4 张表 / 18 IPC / **5 dialog**（v0.3 删 ErrorReportDialog）/ 8 smoke 用例（A-H）/ 4 张 preview / **v0.3 fix1+fix2 UI 微调**）
  - `docs/VERSION_FEATURE_HISTORY.md`（修改）— v2.1.3 行
  - `docs/USER_GUIDE.md`（修改）— 新增"业务OP数据核对"章节
    - 入口介绍
    - BU 下拉框使用
    - 业务OP 导入流程（含校验失败处理）
    - 流水对账单 导入流程
    - 开始运行流程
    - 导出指定日期
    - 导出指定日期区间
    - 4 张 preview 截图
- **acceptance criteria**：
  - `grep "2.1.3" CHANGELOG.md docs/VERSION_FEATURE_HISTORY.md` 命中
  - `node -e "console.log(require('./package.json').version)"` 输出 `2.1.3`
  - USER_GUIDE 目录追加新章节（含截图）
- **验证命令**：
  ```bash
  cat package.json | grep version
  ```
- **commit message**：`[v2.1.3] docs(t9): version bump 2.1.2→2.1.3 + CHANGELOG + VFH + USER_GUIDE`
- **预估**：M（2h）

---

## T10：self-review + `/check-vars` + PR 草稿

- **依赖**：T1-T9 全部完成
- **文件**：
  - `docs/analysis/var-reference-stats.{md,json}`（自动生成，由 `npm run scan:vars`）
  - `rules/important-variables.md`（可能修改，spec §十二 升格评估）
  - `docs/prs/待merge-PR #N.md`（新建，N 待定 = 45 预计）
- **流程**：
  1. **self-review 圈**（参照 v2.1.2 PR43 流程）：
     - 圈 1：tasks 逐项过一遍 + 关键文件 diff 复盘
     - 圈 2：spec §六 OPEN ISSUE 全部拍板 ✅ 检查
     - 圈 3：smoke / preview 双覆盖检查
     - 圈 4：文案 / 注释残留检查（grep "v2.1.2" / "v2.1.3"）
     - 圈 5：资金红线 review（§5 算法人工复盘）
  2. **`/check-vars` skill 触发**：
     - `npm run scan:vars` 重新生成统计
     - 评估新符号（spec §十二）是否升格 `rules/important-variables.md`
     - 把 skill 输出的"⚠️ 关联功能 review"段落粘贴到 PR body
  3. **PR 草稿**：
     - 文件名：`docs/prs/待merge-PR #N.md`（N 由 GitHub 当时编号决定）
     - frontmatter：参照 v2.1.2 PR43 草稿格式
     - 内容：
       - Summary（1-3 句）
       - 改动文件清单
       - Test plan（smoke A-G + 手动测试 checklist）
       - 关联文档（PRD / spec / tasks）
       - check-vars 输出
       - 资金红线提醒（⚠️ 必须人工 review §5 算法）
       - OPEN ISSUE 拍板回顾（PRD §6.1 共 18 项 → 18 个最终选项的逐项确认表）
- **关联 memory**：
  - `workflow_no_tester_no_auto_pr` — 用户手动测试通过 + 显式说"提 PR"后 team-lead 才执行实际 `gh pr create`
  - `workflow_important_vars_check` — version bump + 合并 main 前**必须** `/check-vars`
  - `workflow_archive_pr_draft` — PR 创建后改名归档
  - `workflow_frontend_previews` — preview 必须重跑（T8 已覆盖）
- **acceptance criteria**：
  - self-review 圈全过
  - `npm run scan:vars` 输出无新升格 candidate（或已人工评估后入表）
  - PR 草稿入 `docs/prs/`，team-lead 等待用户"提 PR"指令
- **验证命令**：
  ```bash
  npm run scan:vars
  cat docs/prs/待merge-PR\ #N.md | head -50
  ```
- **commit message**：`[v2.1.3] docs(t10): self-review + /check-vars + PR 草稿入 docs/prs/`
- **预估**：M（1-2h，依赖 PR 草稿质量）

---

## T11：fix1+fix2 自测回归记录（v0.3 增补）

- **依赖**：T1-T10（fix1 + fix2 在 Dev 完成主流程后用户手动测试发现）
- **背景**：v0.3 (2026-05-13) 用户在手动测试阶段提出两轮 fix（fix1.x + fix2.x），其中：
  - fix1：日期默认值 + BU 下拉空白 placeholder + ErrorReportDialog 死代码清理（标记 fix1.5）
  - fix2：BU 行 CSS 对齐 + BU option label 去计数 + BU 下拉空白行为细化 + 差异表黄底回滚 (#10 拍板回滚) + 流水日期默认 T-1
- **占位回归项**（Dev 自测后填实际数据）：
  | 项 | 期望 | 实际 |
  |---|---|---|
  | `npm run smoke` 退出码 | 0 | 待 Dev 回填 |
  | `npm run preview:biz-op-recon` 输出 | 4 张截图（initial / importing / result / export-dialog） | 待 Dev 回填 |
  | fix1 手动测试条目 | 5 条全部通过（fix1.1 ~ fix1.5） | 待 Dev 回填 |
  | fix2 手动测试条目 | 5 条全部通过（fix2.1 ~ fix2.5） | 待 Dev 回填 |
  | 差异表 xlsx 用 Excel 打开 | **所有差异行白底**（v0.3 fix2.4 回滚） | 待 Dev 回填 |
  | 业务OP 日期对话框 | 打开后默认选中 系统日期 - 1 | 待 Dev 回填 |
  | 流水日期对话框 | 打开后默认选中 系统日期 - 1 | 待 Dev 回填 |
  | 对账日期对话框 | 保持 ready 日期列表展示（不预选 T-1） | 待 Dev 回填 |
  | BU 下拉 buList=空 | 单一空白 placeholder + select disabled | 待 Dev 回填 |
  | BU 下拉 buList=非空 | 无空白 placeholder + 默认第一项 + smart preserve | 待 Dev 回填 |
  | BU option label | 仅 buName，无 `(N 行)` 附加 | 待 Dev 回填 |
  | BU 行 CSS 宽度 | 与"导出差异"按钮左右边界对齐 | 待 Dev 回填 |
  | 校验失败 UI | 状态栏文字 + 失败报告路径，无独立对话框 | 待 Dev 回填 |
- **关联文档**：
  - PRD §6.4 fix1 + fix2 手动测试增补条目
  - spec §6.1 / §7.5 / §7.6（writer 无黄底 + BU 下拉状态机 + 5 dialog factory）
- **acceptance criteria**：
  - 上述 12 项占位全部通过（Dev 回填 ✅ / 失败原因）
  - 死代码 `createBizOpReconErrorReportDialog` 已删除（`grep` 验证）
  - PR 草稿 §自测记录粘贴本表
- **验证命令**：
  ```bash
  npm run smoke
  npm run preview:biz-op-recon
  grep -n "createBizOpReconErrorReportDialog" src/renderer-dialogs.js src/renderer.js  # 应无输出
  ```
- **commit message**：`[v2.1.3] test(t11): fix1+fix2 自测回归记录（10 条 fix 全过 + 差异表无黄底 + 日期默认 T-1）`
- **预估**：S（≤ 1h，作为 PR self-review 一部分）

---

## T12 — fix4 资金红线 bug 修复

**bug**：multi_op_account_count 在 onlyInT1 路径下统计漏算（用户报：B2B 2026-05-12 多 OP 0 个）
**根因**：`biz-op-recon-session.js:255` runReconciliation 5.a 分支漏累加
**修法**：6 行新代码（含 multiOpAccountSeen Set）
**验证**：smoke Case I（I-1/I-2/I-3，15 assertion）+ 全套 84/84 PASS
**关联 OPEN ISSUE #6**（1:N 精准标差异）：差异表 meta 列「同账户号多个OP」未受影响（口径正确），仅状态栏数值修复

---

## T13 — fix5 PRD 拍板修订 + Dev 实施（多 OP 账户 N 行全进差异表）

- **bug**：多 OP 账户 N 行（相等行）漏导出差异表（用户报 2026-05-13 fix4 后测试 0512 BU=B2B 对账：业务OP 表 `102201051506418034111_RECEIVING_CNH` 账户有 2 行 / 差异表只有 1 行）
- **根因**：**不是代码 bug**。PRD-v2.1.3 v0.3/v0.4 §3.5.3 进表条件设计为 `比对T-2日 非空 OR 比对测算金额 == 不相等` → `compareT1OpWithComputed` 相等行（`diff <= epsilon`）静默跳过 → 多 OP 账户内的相等子行被过滤掉
- **拍板**：用户拍板**选项 B**（PRD 修订）：多 OP 账户 N 行**全部进差异表**（不论相等/不相等），相等行 meta = `相等/空/是`；单 OP 相等行仍不进表（原规则保留）
- **PRD 修订**：v0.4 → v0.5
  - §3.4.1 步 4.2.b：单 OP 相等 vs 多 OP 相等分支拆分（多 OP 相等 → push diffRows）
  - §3.5.1 sheet 内容来源：新增"多 OP 相等子行"差异类型 + meta 取值表
  - §3.5.3 进表条件：扩展为 `比对T-2日 非空 OR 比对测算金额 == 不相等 OR 同账户号多个OP == 是`
  - §6.4：新增 fix5 条目；标题改名为 fix1+fix2+fix4+fix5
- **spec 修订**：v0.4 → v0.5
  - §5.0.1 `compareT1OpWithComputed` 函数签名补充注释
  - §5.2 函数实现伪码 `else` 分支新增多 OP 相等行 push diffRows 逻辑（`t1Rows.length >= 2` 判定）
  - §九 smoke 新增 Case J（共 15 assertion，含反例）
  - §十四 OPEN ISSUE #10 回填行追加"v0.5 fix5 选项 B 修订"
- **Dev 修法**：`compareT1OpWithComputed` 函数 `else` 分支补 if-multi push 代码（~7 行新增）
- **验证**：
  - smoke Case J（含反例：若退化为 v0.4 行为 → assertion 失败）
  - smoke Case I（fix4，确保 multiOpAccountCount 口径不变）
  - smoke A-H 全套（确保非多 OP 路径 / 单 OP 相等不进表行为不退化）
- **影响范围**：
  - **代码** = 1 个文件（`src/main-process/biz-op-recon-session.js` 或 `compareT1OpWithComputed` 所在文件）+ smoke fixture 新增 Case J
  - **DB schema** = 不变（diff_rows 表结构沿用）
  - **writer** = 不变（writer 1:1 取 diff_rows，N 行入 N 行出）
  - **summary 统计** = 不变（`amountDiffCount` 仅累计 unequal；`multiOpAccountCount` fix4 口径正确）
- **关联 OPEN ISSUE #6 / #10**：
  - #6（1:N 精准标差异）算法骨架不变；仅相等多 OP 子行的"落地位置"由"丢弃"改为"push diffRows"
  - #10（差异表样式）writer 仍不标黄；进表条件扩展（多 OP 相等行也进）
- **commit message**：`[v2.1.3] feat(t13-fix5): compareT1OpWithComputed 相等多 OP 行 push diffRows + smoke Case J`
- **预估**：XS（≤ 30 分钟代码修改 + ≤ 30 分钟 smoke fixture 补 J）

---

## T14 — fix6 PRD #14 拍板回滚 + Dev 实施（区间导出单 sheet「差异」）

- **bug**：用户在 fix5 测试通过后提出"另外导出一个日期区间的差异文件，不要 sheet 存放数据，差异要放在一个 sheet 里"（v0.5 设计区间导出 = N sheet 按日期分，不便于在 Excel 用筛选器一次性查询整个区间）
- **根因**：**不是代码 bug**。PRD-v2.1.3 v0.5 §3.3.3 + §6.1 OPEN ISSUE #14 拍板 A（区间导出 N sheet，sheet 名 = `YYYY-MM-DD` ISO）→ 用户审计场景下不便
- **拍板**：用户拍板**选项 F**（PRD #14 拍板回滚）：区间导出**单 sheet「差异」**（所有日期合并），按 data_date 升序 + 同日 source_account_key 升序排序；**不加「数据日期」列**，依靠原 xlsx 第 1 列 Billdate 区分；console.warn 日志告警 Billdate ≠ data_date（**已知风险**：xlsx 原作者填的 Billdate 可能 ≠ 导入时选的 data_date → 用户在 Excel 筛选可能区分不出来 → console.warn 辅助 debug，不弹 UI 不阻断）
- **PRD 修订**：v0.5 → v0.6
  - §3.3.3 导出流程「指定日期区间」子节：N sheet → 单 sheet「差异」+ data_date+account_key 排序 + Billdate console.warn
  - §3.5.2 表头说明：补 fix6 备注（区间 sheet 结构与单日一致 23+4=27 列；不引入「数据日期」列）
  - §6.1 #14 拍板表：A → F（fix6 拍板回滚）
  - §6.4：标题改名 fix1+fix2+fix4+fix5+fix6；追加 fix6 段；表格末追加 fix6 行
- **spec 修订**：v0.5 → v0.6
  - §6.2 `writeDateRangeDiffWorkbook`：从"N sheet 循环 add"改为"1 sheet 合并 add + 排序 + console.warn"；返回值 `sheetCount: 1` + `totalRows`（替换原 `sheetCount: N`）
  - §九 smoke 新增 Case K（≥ 6 个 assertion，含反例：sheet 数 > 1 / 表头列 > 27 / 排序失序均失败）
  - §十四 OPEN ISSUE #14 回填行：A → F fix6 修订
- **Dev 修法**：
  - `src/main-process/biz-op-recon-writer.js` 中 `writeDateRangeDiffWorkbook` 函数重写（约 30 行代码改动）：
    1. 改 `workbook.addWorksheet('差异')`（替代原 N sheet 循环 add）
    2. 一次性收集所有 successDate 的 diff_rows → `allRows[]`
    3. 排序：`(a, b) => a.dataDate - b.dataDate || a.accountKey - b.accountKey`
    4. 每行 add 前做 Billdate vs data_date 一致性检查 → 不一致 `console.warn(...)`
    5. 返回值 `{ filePath, sheetCount: 1, totalRows, skippedDates }`
  - smoke fixture 新增 Case K（三天数据 + 多 OP + onlyInT1 混合场景）
  - **影响范围**：
    - 代码 = 1 个文件（`src/main-process/biz-op-recon-writer.js` 的 `writeDateRangeDiffWorkbook` 函数）+ smoke fixture 新增 Case K
    - **DB schema = 不变**（`diff_rows` 表结构沿用 v0.5）
    - **session 层 = 不变**（仍 1:N runs / diff_rows）
    - **单日 writer = 不变**（`writeSingleDateDiffWorkbook` 仍 1 sheet sheet 名 = `YYYY-MM-DD` ISO）
    - **IPC handler = 不变**（`bizOpRecon:export:date-range` 出参 schema 兼容；旧 `sheetCount: N` → 新 `sheetCount: 1 + totalRows: K`，前端状态栏文案可能微调）
    - **前端状态栏文案**：原"差异表已生成 N sheet"如有此类描述需改为"差异表已生成 K 行"或类似（Dev 检查）
- **验证**：
  - smoke Case K（含反例：sheet 数 > 1 / 表头列 > 27 / 排序失序均失败）
  - smoke A-J 全套（单日 writer + session + algorithm 路径不退化）
  - 真实数据手测：导出跨多日区间 → Excel 打开仅 1 sheet「差异」 + 按 data_date 排序 + Billdate 列区分日期可用
  - console.warn 日志：构造 Billdate ≠ data_date 行 → DevTools 看到 warn 输出
- **关联 OPEN ISSUE #14**：原 A 多 sheet 拍板回滚为 F 单 sheet；**不涉及 #6 / #10 / fix5 算法骨架**（writer 渲染层独立修改，diff_rows 数据流不变）
- **关联文档**：
  - PRD §3.3 + §3.5.2 + §6.1 #14 + §6.4 fix6 段
  - spec §6.2 + §9.10 Case K + §14 #14 回填
- **commit message**：`[v2.1.3] feat(t14-fix6): writeDateRangeDiffWorkbook 单 sheet「差异」+ data_date+account_key 排序 + Billdate/data_date console.warn + smoke Case K`
- **预估**：XS（≤ 30 分钟代码修改 + ≤ 30 分钟 smoke fixture 补 K）

---

## 工作量总览（粗估）

| 阶段 | 任务数 | 总预估 |
|---|---|---|
| T0（已完成） | 1 | — |
| T1（DDL） | 1 | S ≈ 0.5-1h |
| T2（reader/validator/repo） | 1 | M ≈ 2-3h |
| T3（算法，**资金红线**） | 1 | L ≈ 3-5h |
| T4（writer） | 1 | M ≈ 2h |
| T5（前端面板 + dialog） | 1 | L ≈ 4-5h |
| T6（IPC + preload） | 1 | M ≈ 2-3h |
| T7（smoke） | 1 | M ≈ 2-3h |
| T8（preview） | 1 | M ≈ 2h |
| T9（文档三件套 + version） | 1 | M ≈ 2h |
| T10（self-review + PR） | 1 | M ≈ 1-2h |
| T11（fix1+fix2 自测回归记录，v0.3 增补） | 1 | S ≈ ≤ 1h |
| **总计** | **12** | **~21-29h** |

---

## ⚠️ 风险与红线提醒

| 风险 | 应对 |
|---|---|
| **资金红线**：T3 对账算法 4 步流程 | spec §五 伪码逐字对齐；smoke A-D + G 必须通过；PR review 人工跑真实数据样本 |
| **资金红线**：T2 业务 OP 双重校验（已拍板 #1 = B，epsilon=1e-2） | smoke E 覆盖（两种违反场景）+ 单元自检 |
| **资金红线**：T2 流水出入方向枚举（已拍板 #3，仅「入」/「出」） | 未知方向 → `parseSignedAmount` 返回 NaN；导入阶段 `validateFlowRow` 一并拦截；smoke D 覆盖 |
| **资金红线**：T3 多 OP 行 1:N 精准标差异（已拍板 #6 = A） | smoke B 覆盖；与 v2.1.2 1:N 风格一致 |
| **资金红线**：T3 BU 比较语义（已拍板 #7 = C trim+lower） | 与 v2.1.2 `normalizeBu` 一致；repository 内 SQL 使用 `LOWER(TRIM(...))`；smoke G 覆盖 |
| **资金红线**：T2 校验失败整批拒绝（已拍板 #5） | session 层调用 writer 落失败报告 xlsx；主表保 0 脏行；smoke E 覆盖 |
| **资金红线**：T3 重新导入清空旧 runs + diff_rows（已拍板 #15） | `clearRunsAndDiffsByDateBu` 严格 DELETE diff_rows → DELETE runs 顺序（FK 约束）；smoke H 覆盖 |
| v2.1.2 模块同名风险 | T1-T10 全部命名前缀 `bizOpRecon` / `biz_op_recon` / `biz-op-recon`，与 v2.1.2 `bankBuRecon` / `bank_bu_recon` / `bank-bu-recon` 严格区分 |
| 文档三件套漏更新 | T9 显式列出，commit message 自检 |
| preview 漏跑（memory `workflow_frontend_previews`） | T8 显式拆成独立 task |

---

## 执行顺序建议（OPEN ISSUE 全部拍板，可直接 Dev 实施）

**阶段 0（PM）**：✅ T0 起草 + 18 项 OPEN ISSUE 全部拍板（2026-05-13 完成）

**阶段 1（Dev 后端骨架）**：T1 → T2 → T3 → T4（依赖链严格串行，资金红线段落人工 review 后再进入下一 task）

**阶段 2（Dev 前端 + IPC）**：T5 → T6（T5 / T6 可部分并行）

**阶段 3（Dev 测试 + 文档）**：T7 → T8 → T9

**阶段 4（PM/team-lead 收尾）**：T10（self-review + PR 草稿）→ 用户手动测试 → 用户明确说"提 PR" → 执行 `gh pr create`（memory `workflow_no_tester_no_auto_pr`）→ 合并后 PR 草稿归档（参照 `workflow_archive_pr_draft`）→ 整合进 PRD §七 实施记录（参照 `workflow_pr_integrate_prd`）

---

## T15 — round 1 self-review 修订（v0.7 — 2026-05-14，PR #45 提 PR 后 reviewer agent 反馈）

- **触发**：PR #45 提 PR 后 reviewer agent 给 1 critical + 3 important + 5 minor + 3 测试遗漏建议。用户拍板"全修"。
- **PM 范围（本任务）**：
  - **I1 升格**：13 个 v2.1.3 新符号写入 `rules/important-variables.md`（Critical 2 + Important-skeleton 4 + Risk-sensitive 7）；元数据 v1 → v2，上次人工 review 改 2026-05-14
  - **M3 spec §7.6 dialog 计数同步**：5 → 4（删除 `createBizOpReconFileImportPromptDialog` 误描述；fix1.5/fix2 已删 ErrorReportDialog 后实际仅 4 个）+ 注脚 [^dialog-count] + known issue（KI-1 留 PRD §6.5）
  - **PRD/spec/tasks v0.6 → v0.7** + round 1 修订段落
  - **PRD §3.5.5** 新增 `t2AnomalyAccountCount` 统计语义说明（对齐 I3 Dev 实施）
  - **spec §三 IPC 出参 schema** 同步：`bizOpRecon:run` 出参 stats 加 `t2AnomalyAccountCount` 字段
  - **spec §五 5.0.1 函数签名 + §5.1 编排 + §5.2 helper** 同步 I3：`computeT1Op` 第 3/4 参数 `t2AnomalySeen, buName` + 函数体 `console.warn` + summary.t2AnomalyAccountCount
  - **spec §4.3 DB schema** 同步 I3：`biz_op_recon_runs.t2_anomaly_account_count INTEGER NOT NULL DEFAULT 0`
  - **spec §6.2 区间 writer** 同步 M4：排序 key 必须用 `normalizeAccountKey(sourceRow.account_no)` + 跨文件一致性注释
  - **spec §九 smoke 用例** 追加 Case L（I3 防回归）/ Case M（C1 防回归）/ Case N（I2 防回归）
  - **spec §十二 升格清单** 标注"已 round 1 升格" + 引用 important-variables.md 对应条目
  - **spec §十五 round 1 修订记录** 全 9 条修订项详表（含 C1/I1-I3/M1-M5/Case L-N）+ 验证清单
  - **三件套同步**：CHANGELOG.md / docs/USER_GUIDE.md / docs/VERSION_FEATURE_HISTORY.md（详见 acceptance criteria）
- **Dev 范围（并行另一 agent）**：C1 / I2 / I3 / M1 / M2 / M4 / M5 + Case L/M/N smoke 实现；详见 spec §十五 round 1 修订记录表"代码改动文件"列
- **acceptance criteria**：
  - `rules/important-variables.md` 新增 13 条（git diff 验证）
  - PRD 标题表 v0.6 → v0.7 + §3.5.5 新增 + §6.4 round1 段 + §6.5 KI-1
  - spec 标题表 v0.6 → v0.7 + §三 IPC schema 同步 + §五签名/编排/helper 同步 + §6.2 排序注释 + §7.6 dialog 5→4 + §九 Case L/M/N + §十二 标注升格 + §十五 修订记录
  - tasks 总任务 15 → 16 + T15 完整 task
  - CHANGELOG.md v2.1.3 段追加 round 1 修订段
  - docs/USER_GUIDE.md §1.7.x 状态栏文案补 t2AnomalyAccountCount 描述（如状态栏会显示）
  - docs/VERSION_FEATURE_HISTORY.md v2.1.3 行追加 round 1 修订
- **关联文档**：
  - PRD §3.5.5 + §6.4 round1 段 + §6.5 KI-1
  - spec §三 / §四 / §五 / §六 / §7.6 / §九 / §十二 / §十五
  - rules/important-variables.md 新 13 条目
  - CHANGELOG.md / docs/USER_GUIDE.md / docs/VERSION_FEATURE_HISTORY.md
- **commit message**：`[v2.1.3] docs(t15-round1): PRD/spec/tasks v0.6→v0.7 + important-variables 升格 13 条 + spec §7.6 dialog 5→4 + Case L/M/N 草稿 + 三件套同步`
- **预估**：M（1-2h，PM 侧文档同步 + I1 升格起草）

---

## T16 — round 2 self-review 修订（v0.8 — 2026-05-14，round 1 完成后再过 reviewer agent）

- **触发**：PR #45 round 1 修订完成后再过 reviewer agent；reviewer 给 0 critical + 3 important + 5 minor + 3 测试遗漏建议（按依赖顺序补编号 / 边界扩展）。用户拍板"全修"。
- **PM 范围（本任务）**：
  - **R2-I2 PRD §3.5.5 关键不变量补"部分 NaN"容错路径**：补充第 2 条不变量描述同账户号多行场景下 `validAccountSet.delete(anomalyAccountSet)` 集合差行为；spec §5.2 `computeT1Op` 实现注释 + §5.2.1 算法关键不变量段（与 PRD 同步）
  - **R2-M1 spec §三 IPC 表删假 handler**：删除 `bizOpRecon:import:pick-biz-op-date` / `bizOpRecon:import:pick-flow-date` 两行（main.js / preload.js 实际无定义；日期选择由前端 dialog factory 直接处理）+ §7.6 dialog 段补处理路径说明（renderer.js 调用入口 + dialog 实现 line 号）
  - **R2-M2 `computeT1Op` 函数签名 spec ↔ code 对齐**：spec v0.7 描述 `(t2OpRows, flowAggMap, t2AnomalySeen, buName)` 返回 `Map`；code 实际 `(t2OpRows, flowAggMap)` 返回 `{ map, anomalyAccountSet }` → spec §5.0.1 函数签名表 + §5.1 caller + §5.2 helper 全部改为 code 实际签名 + 描述返回结构 + caller 解构
  - **R2-M3 console.warn 文案 spec ↔ code 统一**：spec v0.7 文案与 code 实际不一致 → spec §5.1 caller 实现 + §5.2.1 关键不变量第 3 条改为 code 实际版本（采纳 code 为 source of truth）
  - **R2-M4 `subOneDay` 双源说明**：spec §五 算法签名表 `subOneDay` 行加双源备注（保留双源符合工程偏好；维护需双侧同步）；rules/important-variables.md 升格 Risk-sensitive（资金红线 — 时区错乱直接错日期）
  - **R2-M5 `AMOUNT_EPSILON` 位置同步**：spec §5.0 常量段 + §5.3 validator 段顶部注释从 "session.js 模块顶部常量" 改为 "columns.js（M2 提取后单一来源）"
  - **PRD/spec/tasks v0.7 → v0.8** + round 2 修订记录段（spec §十六 新增）
  - **spec §九 smoke 用例编号 swap + 新增**：Case L↔M swap（Case L = clearByDateBu / Case M = T-2 NaN，按依赖顺序）+ 新 Case O（I2 BU trim 边界扩展，覆盖 tab / 全角空格 + 同 date 联动 C1）
  - **三件套同步**：CHANGELOG.md / docs/USER_GUIDE.md / docs/VERSION_FEATURE_HISTORY.md（详见 acceptance criteria）
  - **rules/important-variables.md**：`subOneDay` 升格 Risk-sensitive 新条目（双源说明）；元数据 v2 → v3 + 上次人工 review 改 2026-05-14
- **Dev 范围（并行另一 agent）**：R2-I1 状态栏文案 + R2-I3 smoke Case L/M swap + 新 Case O；详见 spec §十六 round 2 修订记录表"代码改动文件"列
- **acceptance criteria**：
  - PRD 标题表 v0.7 → v0.8 + §3.5.5 关键不变量第 2 条新增 + §6.4 round2 段
  - spec 标题表 v0.7 → v0.8 + §三 IPC 表删 2 行 + §三 表底 R2-M1 备注 + §5.0 AMOUNT_EPSILON 位置 + §5.0.1 函数签名 computeT1Op 同步 + §5.0.1 subOneDay 双源备注 + §5.1 caller 解构 + §5.2 computeT1Op 实现 + §5.2.1 关键不变量段新增 + §5.3 validator import 同步 + §7.6 round 2 R2-M1 修订段 + §9.11 Case L swap + §9.12 Case M swap + §9.14 Case O 新增 + §十六 round 2 修订记录段
  - tasks 总任务 16 → 17 + T16 完整 task
  - rules/important-variables.md 新增 `subOneDay` Risk-sensitive 条目 + 元数据 v3 + 上次人工 review 改 2026-05-14
  - CHANGELOG.md v2.1.3 段追加 round 2 修订段
  - docs/USER_GUIDE.md §1.7.4 步骤 4 状态栏文案补"仅 > 0 时显示"约束（约束 R2-I1 Dev 实施）
  - docs/VERSION_FEATURE_HISTORY.md v2.1.3 行追加 round 2 修订
- **关联文档**：
  - PRD §3.5.5 + §6.4 round2 段
  - spec §三 / §5.0 / §5.0.1 / §5.1 / §5.2 / §5.2.1 / §5.3 / §7.6 / §9.11 / §9.12 / §9.14 / §十六
  - rules/important-variables.md `subOneDay` 新条目
  - CHANGELOG.md / docs/USER_GUIDE.md / docs/VERSION_FEATURE_HISTORY.md
- **commit message**：`[v2.1.3] docs(t16-round2): PRD/spec/tasks v0.7→v0.8 + spec §三 IPC 删假 handler + computeT1Op 签名 spec↔code 对齐 + Case L/M swap + 新 Case O + subOneDay 双源说明 + 三件套同步`
- **预估**：M（1-2h，PM 侧文档同步 + subOneDay 升格起草）

---

## T17 — round 3 self-review 修订（v0.9 — 2026-05-14，round 2 完成后 Codex 自动 review 反馈）

- **触发**：PR #45 round 2 修订完成后再过 reviewer agent（Codex 自动 review）；reviewer 给 1 P1 ⚠️ 资金红线 + 2 P2 + 1 P3 finding。用户拍板"全修"。
- **PM 范围（本任务）**：
  - **P1 PRD §3.4.1 步 4 流水重导描述补 `clearRunsAndDiffsByDate(date)` 调用**（资金红线 ⚠️：流水换了对账没重跑 → 导出旧差异 = 资金事故；流水按 date 跨 BU 共用，重导后该 date 所有 BU 旧 run 失效）
  - **P1 PRD §3.5.6 关键不变量段新增**「流水重导清 runs 不变量」+ 与业务OP 重导 (`clearRunsAndDiffsByDateBu` 单 BU 清) 区分语义说明 + smoke Case P 引用
  - **P1 spec §三 IPC 表 `import:run-flow` 出参描述**补 `clearRunsAndDiffsByDate(db, date)` 调用 + round 3 P1 资金红线新增标注
  - **P1 spec §5.0.1 函数签名表**新增 3 行：`clearRunsAndDiffsByDateBu(db, date, buName)` (#15 拍板 A 已实现，按 (date, BU) 单 BU 清) + `clearRunsAndDiffsByDate(db, date)` (round 3 P1 新增，按 date 跨所有 BU 清，流水重导专用) + `runFlowImportAsync({date, filePath})` (round 3 P1 修订事务内调清函数)；表底部追加"流水重导清 runs 不变量"注释段
  - **P1 spec §八 文件路径**：`run-repository.js` 函数清单补 `clearRunsAndDiffsByDate`（标 round 3 P1 新增）
  - **P1 spec §九 smoke 用例追加 Case P**（流水重导清 runs + diff_rows 跨 BU 防回归，含构造同 date 跨 2 BU success run + 重导流水 + 断言 + 反例 + 资金红线说明）
  - **P1 spec §十二 升格清单**：评估 `runFlowImportAsync` / `clearRunsAndDiffsByDate` / `clearRunsAndDiffsByDateBu` 三个符号升格；新增 round 3 升格表段（runFlowImportAsync 升格 Critical / clearRunsAndDiffsByDate 升格 Risk-sensitive / clearRunsAndDiffsByDateBu 升格 Risk-sensitive）
  - **P2 spec §三 IPC 表头**追加 round 3 P2 usage-stats 接入修订段（说明 17 IPC 全部用 trackedIpcHandle 包装 + FUNCTION_REGISTRY 注册「业务OP数据核对」）+ 17 行说明列分别追加 "（tracked via usage-stats wrapper）" 标注（按 v2.1.2 月度BU 模块对齐风格）
  - **PRD/spec/tasks v0.8 → v0.9** + round 3 修订记录段（spec §十七 新增）
  - **PRD §6.4 标题**改 fix1+fix2+fix4+fix5+fix6+round1+round2+round3 + 追加 round 3 段（4 条修订摘要）
  - **rules/important-variables.md 升格 3 条**（runFlowImportAsync Critical + clearRunsAndDiffsByDate Risk-sensitive + clearRunsAndDiffsByDateBu Risk-sensitive）+ 元数据 v3 → v4 + 上次人工 review 改 2026-05-14
  - **三件套同步**：CHANGELOG.md / docs/VERSION_FEATURE_HISTORY.md（追加 round 3 修订段）+ docs/USER_GUIDE.md §1.7.x 流水导入说明补"重新导入同日流水后，该日期所有 BU 旧对账结果会被自动清空，请重新点开始运行生成新差异"
- **Dev 范围（并行另一 agent）**：P1 (`runFlowImportAsync` 事务调 `clearRunsAndDiffsByDate` + `run-repository.js` 新增函数 + smoke Case P) + P2 lockfile (`npm install --package-lock-only`) + P2 usage-stats (FUNCTION_REGISTRY + main.js 17 IPC trackedIpcHandle 包装) + P3 package.json:71 preview:all 接入 biz-op-recon；详见 spec §十七 round 3 修订记录表"代码改动文件"列
- **acceptance criteria**：
  - PRD 标题表 v0.8 → v0.9 + §3.4.1 步 4 流水重导描述补 `clearRunsAndDiffsByDate` 调用 + §3.5.6 关键不变量段新增 + §6.4 round3 段
  - spec 标题表 v0.8 → v0.9 + §三 IPC 表头 round 3 P2 段 + 17 行 tracked 标注 + `import:run-flow` 出参补清函数 + §5.0.1 新增 3 行函数签名 + §八 run-repository 补 `clearRunsAndDiffsByDate` + §九 Case P 新增 + §十二 round 3 升格 3 条评估表 + §十七 round 3 修订记录段
  - tasks 总任务 17 → 18 + T17 完整 task
  - rules/important-variables.md 新增 3 条目（runFlowImportAsync Critical + clearRunsAndDiffsByDate Risk-sensitive + clearRunsAndDiffsByDateBu Risk-sensitive）+ 元数据 v3 → v4 + 上次人工 review 2026-05-14
  - CHANGELOG.md v2.1.3 段追加 round 3 修订段
  - docs/USER_GUIDE.md §1.7.x 流水导入说明补"流水重导清旧对账结果"约束
  - docs/VERSION_FEATURE_HISTORY.md v2.1.3 行追加 round 3 修订摘要
- **关联文档**：
  - PRD §3.4.1 + §3.5.6 + §6.4 round3 段
  - spec §三 / §5.0.1 / §八 / §九 Case P / §十二 round 3 升格 / §十七
  - rules/important-variables.md `runFlowImportAsync` / `clearRunsAndDiffsByDate` / `clearRunsAndDiffsByDateBu` 新条目
  - CHANGELOG.md / docs/USER_GUIDE.md / docs/VERSION_FEATURE_HISTORY.md
- **commit message**：`[v2.1.3] docs(t17-round3): PRD/spec/tasks v0.8→v0.9 + P1 流水重导清 runs 跨 BU + spec §三 IPC tracked 标注 + Case P 新增 + important-vars 升格 3 条 + 三件套同步`
- **预估**：M（1-2h，PM 侧文档同步 + 升格起草）

---

## T18 — round 4 self-review 修订（v0.10 — 2026-05-14，round 3 完成后 Codex 自动 review 反馈）

- **触发**：PR #45 round 3 修订完成后再过 reviewer agent（Codex 自动 review）；reviewer 给 1 P1 ⚠️ 资金红线 finding（与 round 3 P1 流水跨 BU 清互补）+ 用户明确要求 USER_GUIDE 流水汇总性质解释段。用户拍板"全修"。
- **PM 范围（本任务）**：
  - **P1 PRD §3.3.1 业务OP 流程描述补**：事务内 `clearRunsAndDiffsByDateBu(db, date, BU)` + `clearRunsAndDiffsByDateBu(db, addOneDay(date), BU)` 双调用说明（资金红线 ⚠️：业务OP 某日数据双角色，重导后下一日 run 失效，必须强制清下一日 run + 重跑对账；漏清下一日 → 用旧 T-2 算的 D+1 差异表 = 资金事故）
  - **P1 PRD §3.5.7 关键不变量段新增**「业务OP 重导清下一日 runs 不变量」+ 与 round 3 P1 流水跨 BU 清互补对照表（业务OP 单 BU 跨 2 日清；流水跨 BU 单日清）+ `addOneDay(date)` UTC 实现不变量 + smoke Case Q 引用
  - **P1 spec §5.0.1 函数签名表新增 2 行**：`addOneDay(date)` helper（与 `subOneDay` 对偶，UTC 实现避免时区抢跑）+ `runBizOpImportAsync({date, filePath})` (round 4 P1 修订事务追加 `clearRunsAndDiffsByDateBu(db, addOneDay(date), BU)` 调用)；表底部追加"业务OP 重导清下一日 runs 不变量"注释段
  - **P1 spec §九 smoke 用例追加 Case Q**（业务OP 重导清下一日 runs + diff_rows 防回归，含构造 BU-A 跨 D-1/D/D+1 三日业务OP + 跑 D 与 D+1 两 run 成功 + 重导 D 业务OP + 断言两 run 均被清 + 反例（不调 addOneDay 清 / 退化本地时区 / 误用 ByDate 跨 BU 清）+ 资金红线说明）
  - **P1 spec §十二 升格清单**：评估 `runBizOpImportAsync` / `addOneDay` 两个符号升格；新增 round 4 升格表段（runBizOpImportAsync 升格 Critical / addOneDay 升格 Risk-sensitive，与 subOneDay round 2 R2-M4 升格 Risk-sensitive 对齐）
  - **PRD/spec/tasks v0.9 → v0.10** + round 4 修订记录段（spec §十八 新增）
  - **PRD §6.4 标题**改 fix1+fix2+fix4+fix5+fix6+round1+round2+round3+round4 + 追加 round 4 段（P1 + USER_GUIDE 流水汇总解释段两条摘要）
  - **rules/important-variables.md 升格 2 条**（runBizOpImportAsync Critical + addOneDay Risk-sensitive）+ 元数据 v4 → v5 + 上次人工 review 保持 2026-05-14
  - **三件套同步**：CHANGELOG.md / docs/VERSION_FEATURE_HISTORY.md（追加 round 4 修订段）+ docs/USER_GUIDE.md §1.7.x 流水/业务OP 导入说明附近**合并新建"重导规则"小节**（含两段：6.A 业务OP 重导清下一日说明 + 6.B 流水汇总性质解释段，用户给的原话保留）
- **Dev 范围（并行另一 agent）**：P1 (`runBizOpImportAsync` 事务追加 `clearRunsAndDiffsByDateBu(db, addOneDay(date), bu)` 调用 + 新增 `addOneDay(date)` helper UTC 实现 + smoke Case Q)；详见 spec §十八 round 4 修订记录表"代码改动文件"列
- **acceptance criteria**：
  - PRD 标题表 v0.9 → v0.10 + §3.3.1 业务OP 流程描述补 + §3.5.7 关键不变量段新增 + §6.4 round4 段（含 P1 + USER_GUIDE 流水汇总解释段）
  - spec 标题表 v0.9.1 → v0.10 + §5.0.1 新增 2 行函数签名（addOneDay + runBizOpImportAsync）+ §九 Case Q 新增 + §十二 round 4 升格 2 条评估表 + §十八 round 4 修订记录段
  - tasks 总任务 18 → 19 + T18 完整 task
  - rules/important-variables.md 新增 2 条目（runBizOpImportAsync Critical + addOneDay Risk-sensitive）+ 元数据 v4 → v5
  - CHANGELOG.md v2.1.3 段追加 round 4 修订段（含 P1 + USER_GUIDE 流水汇总解释段）
  - docs/USER_GUIDE.md §1.7.x 流水/业务OP 导入说明附近合并新建"重导规则"小节（两段合一：6.A + 6.B）
  - docs/VERSION_FEATURE_HISTORY.md v2.1.3 行追加 round 4 修订摘要
- **关联文档**：
  - PRD §3.3.1 + §3.5.7 + §6.4 round4 段
  - spec §5.0.1 / §九 Case Q / §十二 round 4 升格 / §十八
  - rules/important-variables.md `runBizOpImportAsync` / `addOneDay` 新条目
  - CHANGELOG.md / docs/USER_GUIDE.md / docs/VERSION_FEATURE_HISTORY.md
- **commit message**：`[v2.1.3] docs(t18-round4): PRD/spec/tasks v0.9→v0.10 + P1 业务OP 重导清下一日 runs + addOneDay helper + Case Q + USER_GUIDE 重导规则小节（流水汇总性质 + 业务OP 跨日清）+ important-vars 升格 2 条 + 三件套同步`
- **预估**：M（1-2h，PM 侧文档同步 + 升格起草 + USER_GUIDE 用户原话融入）
