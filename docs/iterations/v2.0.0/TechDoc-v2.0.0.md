# TechDoc - 网银账单小助手 v2.0.0

| 项目 | 内容 |
|------|------|
| 版本 | v2.0.0（v0 初稿）|
| 日期 | 2026-04-23 |
| 作者 | Dev |
| 状态 | 初稿 |
| 关联 PRD | `docs/iterations/v2.0.0/PRD-v2.0.0.md`（v1 定稿，21 条 AC）|
| 依赖 | v1.5.3 已 merged 到 main，v2.0.0 已同步 |
| 基版本 | `2.0.0-beta.1`（commit `c81937c`）|

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §5.1 顶部下拉改造 | 可落地。现有 `<button id="moduleSwitcherBtn">` + `src/renderer.js:1068-1090` 自定义切换动画替换为 `<select>`，CSS 需改 |
| §5.3 规则管理弹窗 | 可落地。复用 v1.5.3 的 modal / createXxxDialog 模式（`src/renderer-dialogs.js`）|
| §5.4.1~§5.4.3 多文件导入 + 表头校验 + 年月选择 | 可落地，复用 `readers.js` 的 `extractHeaders` + 现有的年月选择器样式（参考 `createMonthlyBalanceExportDialog`）|
| §5.4.4 覆盖提醒 + 留底 | 可落地，参考 v1.5.3 的导出另存实现（`writeBalanceWorkbook` → 输出到 `pending-archives/`）|
| §5.6 导出差异 xlsx + 按类型分 sheet + _before/_after 展开 | 可落地，xlsx-js-style 已在 v1.5.3 引入，表头字体自动延续 Courier New |

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理方案 |
|------|---------|---------|
| R-T1 | **300 万行 / 31 列 SQLite 批量 INSERT 性能**：基于项目用的 `node:sqlite` DatabaseSync，实测 INSERT 约 5000-8000 行/s；300 万行估计 **6-10 分钟**。PRD §九目标"< 3 分钟"较激进 | (a) 关 WAL checkpoint 提速；(b) `PRAGMA synchronous = OFF` 批量时临时关；(c) INSERT 单次批 5000 行；若仍超 3 分钟，PRD 目标放宽到 **5 分钟** 再汇报用户 |
| R-T2 | **child process 传 300 万行 JSON 给父进程，体积约 1-2GB，会撑爆 IPC 管道** | child worker **直接写 SQLite**（同文件 `tool-data-pending.sqlite`），父进程仅发任务指令 + 轮询进度。IPC 只传元数据（行数、耗时、错误摘要），不传数据行 |
| R-T3 | **pending_rows 表 31 列文本存储** vs JSON blob 权衡：文本列易查询但磁盘大（300 万 × 31 ≈ 几 GB）；JSON blob 紧凑但查询慢 | 选 **31 列文本 + 索引只在 match_fields 上动态建**（运行时 `CREATE INDEX IF NOT EXISTS` 按规则动态建）|
| R-T4 | **changed 行对比按值严格相等（OT-8）** —— SQL 里如何实现不等 | 用 `(A.col_1 IS NOT B.col_1 OR A.col_2 IS NOT B.col_2 ...)`，`IS NOT` 处理 NULL 友好 |
| R-T5 | **顶部 `<select>` vs 现有自定义展开动画** —— 现有的点击 → 展开 → 选择流程在 `src/renderer.js:1068-1090`；改为原生 select 后要删掉动画逻辑 | 删掉 `moduleSwitcherBtn` 相关的自定义展开 DOM 与 CSS；`<select>` 用原生下拉，变更 handler 直接触发 `setCurrentTopModule(value)` |
| R-T6 | **xlsx-js-style 依赖复用** —— v1.5.3 已引入，但仅在 `writers.js` 局部 require | Pending export writer 单独新增 `src/backend/pending-export/writer.js`，同样局部 require `xlsx-js-style` |
| ~~R-T7~~ | ~~benchmark 的取样来源~~ | ~~SQL LIMIT 10000 采样~~（2026-04-24 Reverse Sync #6 移除 benchmark） |
| R-T8 | **规则变更后旧 run 的导出兼容性** —— Q-20 + OT-10 要求保留所有 run 并能选历史 run 导出 | run 的 `rule_snapshot` 列存 JSON 快照；导出时 writer 根据快照的 `compare_fields` 动态展列，不依赖当前规则 |

### 1.3 与 PRD 的差异

| 差异点 | 说明 |
|---|---|
| **性能目标放宽到 5 分钟**（用户 sign-off OT-T1）| PRD §九已更新；child process 启动带 `--max-old-space-size=8192` |
| **child worker 职责扩大** | PRD §5.4.7 说"解析走 child process"，Dev 扩为"解析 + 入库都在 child process"，避免父子进程传 300 万行 |

---

## 二、涉及的文件清单

### 新增

| 文件 | 用途 |
|------|------|
| `src/backend/pending-db.js` | 独立 DB facade（类似 `AppDatabase`）|
| `src/backend/pending-db/migrations.js` | schema 迁移（idempotent）|
| `src/backend/pending-db/rule-repository.js` | 规则 CRUD |
| `src/backend/pending-db/month-repository.js` | `pending_months` + `pending_rows` CRUD |
| `src/backend/pending-db/diff-repository.js` | `diff_runs` + `diff_rows` CRUD |
| `src/backend/pending-import/worker.js` | child process 解析 + 入库（主执行体）|
| `src/backend/pending-import/validator.js` | 表头校验 + `pending资金类型` 枚举校验 + 行级冲突检测（hash）|
| `src/backend/pending-reconcile/engine.js` | 对账 SQL 生成 + 执行 |
| ~~`src/backend/pending-reconcile/benchmark.js`~~ | ~~采样 + 外推估时~~（2026-04-24 删除）|
| `src/backend/pending-export/writer.js` | 差异 xlsx 组装（单月 + 汇总两种形态）|
| `src/main-process/pending-session.js` | 主进程 Pending 模块 session 状态 + IPC 处理 |
| `src/renderer-pending.js` | renderer 侧 Pending 模块逻辑 |
| `assets/Pending.xlsx` | 已复制到位 |

### 修改

| 文件 | 改动概要 |
|------|---------|
| `index.html` | `moduleSwitcherMenu` 追加第 3 项菜单项；增加 `#pendingModulePanel` 容器 DOM |
| `src/renderer.js` | `MODULES` 枚举加第三项；`setCurrentModule` / `setCurrentTopModule` 路由到三个模块；删除旧 `moduleSwitcherBtn` 展开动画相关代码（行 1068-1090）|
| `src/preload.js` | 新增 `window.desktopApi.pending = {...}` |
| `src/main.js` | 注册 `pending:*` IPC handlers；应用启动时 open `pendingDb` |
| `src/styles.css` | 新增 `.top-module-select` / `.pending-module-container` 等样式 |
| `src/renderer-dialogs.js` | 新增 `createPendingRuleDialog` / `createPendingImportMonthDialog` / `createPendingReconcileDialog` / `createPendingExportDialog` |
| `package.json` | version `2.0.0-beta.1` 不变；可能新增 `dist` 钩子（暂无）|

### 不改（v1.5.3 功能保留）

- 现有"网银账单生成"/"新开账户余额账单生成"两模块的业务文件（`src/main-process/statement-session.js` / `statement-generation.js` / `src/backend/file-service/*`）零改动
- `tool-data.sqlite` 主 DB 零改动

---

## 三、实现方案

### 3.1 顶部模块切换扩展（**保留**现有自定义下拉）

**现状发现**（Reverse Sync）：`index.html:30-39` 已是自定义下拉 pattern（`<button id="moduleSwitcherBtn">` 触发 `#moduleSwitcherMenu` 展开菜单），不是简单按钮。TechDoc v0 计划的"替换为原生 select"属于过度改造。

**实际改动**：

- `index.html:38` 在 `moduleSwitcherMenu` 内追加 `<button class="module-option" data-module="pending-reconciliation">月度 Pending 数据核对</button>`
- `src/renderer.js:39-48` `MODULES` 枚举加第三项 `pendingReconciliation`
- `src/renderer.js:1066-1079` `setCurrentModule` 从二选一扩为三选一：按 `moduleId` 查 `MODULES` 字典取 name；三个 panel 联动 hide/show
- CSS / 事件绑定 / 菜单展开动画 / 点击外部关闭 — **全部保留**（现有实现已天然支持动态菜单项）

### 3.2 Pending 模块 DOM + state

```html
<div id="pendingContainer" class="module-container hidden">
  <div class="pending-row pending-row-top">
    <button id="pendingRuleBtn">规则管理</button>
    <button id="pendingImportBtn">导入文件</button>
    <button id="pendingRunBtn">开始运行</button>
  </div>
  <div class="pending-row pending-row-bottom">
    <button id="pendingExportBtn">导出差异</button>
    <div id="pendingStatusBox" class="status-box"></div>
  </div>
</div>
```

**renderer state**（`src/renderer.js`）：

```js
state.pending = {
  rule: null,                    // { matchFields: [...], compareFields: [...] } or null
  months: [],                    // ['2026-02', '2026-03', ...]
  latestRunResult: null,         // 最近一次 run 的统计，供状态栏显示
  importing: false,              // 导入中
  running: false,                // 对账中
  errorReportPath: null,         // 最近一次报错文件路径（供状态栏点击下载）
};
```

### 3.3 独立 DB 与 schema

**打开 DB**（`src/main.js`）：

```js
const { DatabaseSync } = require('node:sqlite');
const pendingDbPath = path.join(app.getPath('userData'), 'tool-data-pending.sqlite');
const pendingDb = new DatabaseSync(pendingDbPath);
// 启动时调 pending-db/migrations.js 的 runMigrations(pendingDb)
```

**Schema**（`src/backend/pending-db/migrations.js`）：

```sql
-- rule 表（单行）
CREATE TABLE IF NOT EXISTS rule (
  id TEXT PRIMARY KEY,                    -- 固定 '__GLOBAL__'
  match_fields TEXT NOT NULL,              -- JSON 数组
  compare_fields TEXT NOT NULL,            -- JSON 数组
  updated_at TEXT NOT NULL
);

-- pending_months 元数据
CREATE TABLE IF NOT EXISTS pending_months (
  year_month TEXT PRIMARY KEY,             -- 'YYYY-MM'
  imported_at TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  source_files TEXT NOT NULL,              -- JSON 数组
  archive_path TEXT                        -- 覆盖前留底路径（若有）
);

-- pending_rows 行级数据
CREATE TABLE IF NOT EXISTS pending_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year_month TEXT NOT NULL,
  row_hash TEXT NOT NULL,                  -- 31 列拼串 SHA-1（去重依据）
  col_pending_type TEXT,                   -- pending类型
  col_pending_fund_type TEXT,              -- pending资金类型（建索引，分 sheet 用）
  col_bill_type TEXT,                      -- 账单类型
  col_bill_date TEXT,                      -- billDate
  col_value_date TEXT,                     -- valueDate
  -- ... 其余 26 列，列名 col_* 或保留原中文（TechDoc 敲定用拼音化后的统一命名）
  ...
);
CREATE INDEX IF NOT EXISTS idx_pending_rows_month ON pending_rows(year_month);
CREATE INDEX IF NOT EXISTS idx_pending_rows_fund_type ON pending_rows(year_month, col_pending_fund_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_rows_hash ON pending_rows(year_month, row_hash);
  -- ↑ 同月 row_hash 唯一 → 支撑 §5.4.5 行级冲突检测

-- match_fields 动态建索引：导入时根据当前规则的 match_fields 动态 CREATE INDEX

-- diff_runs
CREATE TABLE IF NOT EXISTS diff_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upper_month TEXT NOT NULL,
  lower_month TEXT NOT NULL,
  rule_snapshot TEXT NOT NULL,             -- JSON {matchFields, compareFields}
  created_at TEXT NOT NULL,
  stat_new INTEGER NOT NULL,
  stat_missing INTEGER NOT NULL,
  stat_changed INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diff_runs_months ON diff_runs(lower_month, upper_month, created_at DESC);

-- diff_rows
CREATE TABLE IF NOT EXISTS diff_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES diff_runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                      -- 'new' | 'missing' | 'changed'
  upper_row_id INTEGER,
  lower_row_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_diff_rows_run ON diff_rows(run_id, type);
```

**列命名策略**：31 列的数据库列名统一用 `col_<拼音>` 或保持原中文字段名。考虑 SQL 可读性，**推荐用中文字段作为列名**（SQLite 支持，反引号包裹），避免 lookup 映射。实施时用常量：

```js
const PENDING_COLUMNS = [
  'pending类型', 'pending资金类型', '账单类型', 'billDate', 'valueDate',
  '平账账期', '业务BU', ...  // 31 列
];
```

### 3.4 规则管理

**UI**（`src/renderer-dialogs.js` 新增 `createPendingRuleDialog`）：
- 两个多选下拉，选项 = `PENDING_COLUMNS`
- 点下拉外部 blur → 弹 `createConfirmDialog`（复用 v1.5.3 弹框）→ 确认 → 调 `window.desktopApi.pending.saveRule(matchFields, compareFields)` → upsert DB

**IPC**：
- `pending:rule:get()` → `{ matchFields, compareFields, updatedAt } | null`
- `pending:rule:save({ matchFields, compareFields })` → `{ ok: true }`

### 3.5 导入流程（含 child worker）

#### IPC 流

```
renderer                           main                           worker
  |   importStart(files, yyyymm)    |                               |
  |----------------------------->   |                               |
  |                                 |  spawn child worker           |
  |                                 |------------------------------>|
  |                                 |                               |
  |                                 |   (worker 解析 + 校验 + 批量 INSERT)
  |                                 |                               |
  |   <---- onProgress(rowCount) ---|   <---- progress ipc ---------|
  |                                 |                               |
  |                                 |   <---- result (err|ok) ------|
  |   <----onComplete(result)-------|                               |
```

#### worker 主流程（`pending-import/worker.js`）

```js
process.argv: [node, worker.js, jobId, dbPath, yyyymm, filesJson, modeJson]

1. open DB (child 也用 DatabaseSync)
2. for each file:
   a. XLSX.readFile(file, { cellDates: true })  → 迭代 Sheet1 行
   b. extractHeaders → 严格比对 PENDING_COLUMNS（顺序+内容）→ 不符则写 error + exit(1)
   c. 每行：
      - 取 31 列值 → 拼串 SHA-1 → row_hash
      - 资金类型值校验 ∈ {提现, 退票, 充值} → 否则记错
      - 跨文件 Set<hash> 查重 → 冲突记错
   d. 批量 INSERT（transaction 包裹，每批 5000 行）
3. 全部文件处理完 → COMMIT → 输出 result JSON 到 stdout → exit(0)
4. 任何异常 → ROLLBACK → exit(非 0)
```

#### 父进程监控

`src/main-process/pending-session.js`：
- `execFile(nodePath, [workerScript, args...], { maxBuffer: 50MB })`
- 监听 stdout 按行 parse JSON progress 事件 → 通过 `webContents.send('pending:progress', ...)` 转发到 renderer
- 处理 exit code：0 = 成功，非 0 = 失败（读 stderr 内容构造 error）

#### 留底

导入覆盖前，main 进程：
1. 查 `pending_rows WHERE year_month = ?` 全部行
2. 按 `source_files`（JSON 里的原文件名列表）还原为 xlsx（用 `writeWorkbookRows` 或直接 xlsx 写）
3. 保存到 `{documents}/网银账单生成小助手/pending-archives/{yyyy-mm}/{原文件名}-backup-{YYYYMMDDThhmmss}.xlsx`
4. `pending_months.archive_path` 更新
5. DELETE 原 `pending_rows`；新数据由 worker INSERT

### 3.6 对账引擎

#### ~~Benchmark~~（2026-04-24 Reverse Sync #6 移除）

benchmark 预估时间已整体删除，见 `changes/v2.0.0/log.md`。原因：预估算法用 `NOT EXISTS` 采样 + 线性外推，而 engine 在 Reverse Sync #5 已切 JS 层 Map 配对，两条路径 per-row cost 差一个数量级，预估严重失真（用户看到"3 分 20 秒"，实际几秒完成）。

#### 对账 SQL + JS 层配对（`pending-reconcile/engine.js`）— A1 fallback 语义

v2.0.0-beta.2 从原 AND 语义改为 **A1 fallback**（见 Reverse Sync #5）。同一笔定义：按 `matchFields` 顺序逐轮，任一字段相等即视为同一笔。

```js
function runReconciliation(db, { upperMonth, lowerMonth, rule }) {
  const { matchFields, compareFields } = rule;

  // 为每个 matchField 建覆盖索引 (year_month, col, id) — index-only scan
  ensureMatchIndex(db, matchFields);

  db.exec('BEGIN');
  const runId = createRun(db, { upperMonth, lowerMonth, ruleSnapshot: { matchFields, compareFields } });

  // tmp_pairs 累积已配对（UNIQUE 约束防重复）
  db.exec('CREATE TEMP TABLE IF NOT EXISTS tmp_pairs(upper_id INTEGER UNIQUE, lower_id INTEGER UNIQUE);');
  db.exec('DELETE FROM tmp_pairs;');

  // JS 层多轮 fallback 配对（原 SQL CTE+ROW_NUMBER+LEFT JOIN 在 121 万行 planner 低效）
  const matchedUpperIds = new Set();
  const matchedLowerIds = new Set();
  const insertPair = db.prepare('INSERT INTO tmp_pairs(upper_id, lower_id) VALUES (?, ?)');

  for (const field of matchFields) {
    // SELECT 走 (year_month, col, id) 覆盖索引
    const upperRows = db.prepare(`
      SELECT id, \`${field}\` AS k FROM pending_rows
      WHERE year_month = ? AND \`${field}\` IS NOT NULL AND \`${field}\` <> ''
      ORDER BY id
    `).all(upperMonth);
    const lowerRows = /* 同上对 lowerMonth */;

    // Map 按 key 分组（已 matched 的 id 跳过；ORDER BY id 保证 push 顺序升序）
    const upperByKey = new Map(), lowerByKey = new Map();
    for (const r of upperRows) if (!matchedUpperIds.has(r.id)) push(upperByKey, r.k, r.id);
    for (const r of lowerRows) if (!matchedLowerIds.has(r.id)) push(lowerByKey, r.k, r.id);

    // 同 key 1 对 1 配对：min(upper.length, lower.length) 对
    for (const [k, uIds] of upperByKey) {
      const lIds = lowerByKey.get(k) || [];
      const n = Math.min(uIds.length, lIds.length);
      for (let i = 0; i < n; i++) {
        insertPair.run(uIds[i], lIds[i]);
        matchedUpperIds.add(uIds[i]); matchedLowerIds.add(lIds[i]);
      }
    }
  }

  // 三段 SQL：changed / new / missing
  db.prepare(`INSERT INTO diff_rows(run_id, type, upper_row_id, lower_row_id)
    SELECT ?, 'changed', p.upper_id, p.lower_id FROM tmp_pairs p
    INNER JOIN pending_rows A ON A.id = p.upper_id
    INNER JOIN pending_rows B ON B.id = p.lower_id
    WHERE ${compareFields.map(f => `(A.\`${f}\` IS NOT B.\`${f}\`)`).join(' OR ') || '0'}`).run(runId);

  db.prepare(`INSERT INTO diff_rows(run_id, type, lower_row_id)
    SELECT ?, 'new', A.id FROM pending_rows A
    LEFT JOIN tmp_pairs t ON t.lower_id = A.id
    WHERE A.year_month = ? AND t.lower_id IS NULL`).run(runId, lowerMonth);

  db.prepare(`INSERT INTO diff_rows(run_id, type, upper_row_id)
    SELECT ?, 'missing', A.id FROM pending_rows A
    LEFT JOIN tmp_pairs t ON t.upper_id = A.id
    WHERE A.year_month = ? AND t.upper_id IS NULL`).run(runId, upperMonth);

  db.exec('DROP TABLE tmp_pairs;');
  db.exec('COMMIT');
}
```

**性能**（T12 真实样本 243 万行）：4.31 秒完成（3 轮 fallback）。

### 3.7 导出差异

`pending-export/writer.js` — **2026-04-24 Reverse Sync #6 格式增强**。

#### 表头结构

```
[ PENDING 31 列 ]  diff_type  pair_id  change_side  changed_fields
   [ <cf>_before / <cf>_after ... ]
   [ 金额_diff? ]  [ 计算金额_diff? ]
```

- 前 3 大类固定；后 1 类为 `compareFields` 内每字段一对 `_before/_after`（与 v0 一致）
- 末尾 2 可选列：仅当 `compareFields` 含对应字段时出现

#### changed pair 展开 → 双行

每对 changed 产生 **2 行**：
- 第 1 行：`change_side='before'`，31 原列取 upper 快照
- 第 2 行：`change_side='after'`，31 原列取 lower 快照
- 两行共享 `pair_id = "{upper_id}_{lower_id}"`、`changed_fields`（逗号分隔 upper≠lower 的字段名）、所有 `_before/_after`、所有 `_diff`

new / missing 仍 1 行；新增元数据列在 new/missing 上全空。

#### `_diff` 列计算

```js
function computeAmountDiff(upperRow, lowerRow, field) {
  const u = parseFloat(upperRow[field]);
  const l = parseFloat(lowerRow[field]);
  if (!Number.isFinite(u) || !Number.isFinite(l)) return '';  // 千分位 / 非数字 → 空
  return l - u;  // after - before
}
```

#### Sheet 结构

| Sheet | 条件 | 内容 |
|---|---|---|
| `汇总` | 始终 | 所有行（changed 双行 + new + missing）|
| `{pending 资金类型值}` | 始终（动态 1~N 张）| 按行自身 `pending资金类型` 分组；若 changed pair 两行资金类型不同，两行落不同 sheet |
| `pending资金类型差异` | compareFields 含 `pending资金类型` | 仅收资金类型变更的 pair；无则空表（仅 header）|
| `按月维度区别汇总` | 仅 aggregate export | 各月 run 数据串联 + 月份 label 空行分隔 |

字体：每 sheet 第 1 行 Courier New（xlsx-js-style 注入），沿用 v1.5.3 OT-3 决策。

### 3.8 状态框文案流

由 `renderer-pending.js` 管理；状态转移表见 PRD §5.4.8。一个 `computePendingStatusText(state.pending)` 纯函数根据 state 返回文案。

### 3.9 报错链路

- 行级冲突 / 表头不一致 / 枚举校验失败 都落 `import_errors` 临时内存结构（不入 DB，session 级）
- 状态框可点击文字（link-like）触发 `pending:error:export-report(savePath)`
- 报告 xlsx 列：`source_file` / `row_index` / `error_type` / `error_detail` / 31 列原内容

---

## 四、任务分解

| 序号 | 任务 | 涉及文件 | 验证方式 | 状态 |
|------|------|---------|---------|------|
| T1 | 独立 DB 基建 + migrations | `src/backend/pending-db.js` + `pending-db/migrations.js` + `src/main.js`（open DB）| node --check + 启动看 DB 文件生成 | todo |
| T2 | 顶部下拉改造 | `index.html`、`src/renderer.js`（删旧动画 + 加 setCurrentTopModule）、`src/styles.css` | preview:main-page 截图；切换无动画 | todo |
| T3 | Pending 模块空壳（DOM + 容器显隐）| `index.html` / `src/renderer-pending.js` / `src/renderer.js`（state.pending）| 切到 Pending 模块能看到 4 按钮 + 状态框 | todo |
| T4 | 规则管理 UI + 弹窗 + IPC + repository | `src/renderer-dialogs.js`（createPendingRuleDialog）+ `pending-db/rule-repository.js` + `src/preload.js` + `src/main.js`（IPC）| 手动：选值 → 确认 → DB 能查到 | todo |
| T5 | Import worker（child process + 校验 + 批量 INSERT）| `src/backend/pending-import/worker.js` + `validator.js` + `pending-db/month-repository.js` | 手动：导入 1 个小文件（100 行）→ DB 看到行；再导入表头错的文件 → exit 非 0 | todo |
| T6 | 导入入口 UI + 主进程 session + 进度回传 | `src/main-process/pending-session.js` + `src/renderer-dialogs.js`（月份选择 + 覆盖确认）+ IPC `pending:import:*` | 手动：完整走多文件多月导入流程 + 覆盖留底；P0-3 ~ P0-7 | todo |
| T7 | 对账 engine + benchmark | `pending-reconcile/engine.js` + `benchmark.js` + `diff-repository.js` + IPC `pending:reconcile:*` | 手动：对账小数据集验证三类差异正确；bench 时间合理 | todo |
| T8 | 开始运行 UI + 相邻月校验 + 状态栏估时 | `createPendingReconcileDialog` + renderer-pending.js | 手动：P0-8/P0-9/P0-10 跨年相邻场景 | todo |
| T9 | 导出差异 writer + 单月 run 选择 UI + 汇总 | `pending-export/writer.js` + `createPendingExportDialog` + IPC `pending:diff:export-*` | 手动：P0-12/P0-13；打开导出文件看列、sheet 组织、字体 | todo |
| T10 | 状态框文案流完整化 + 报错链路 | `renderer-pending.js` + `pending:error:export-report` IPC | 手动：故意触发每类错误看文案 | todo |
| T11 | 文档三件套同步 + CHANGELOG + PRD 回写 | `CHANGELOG.md` / `docs/VERSION_FEATURE_HISTORY.md` / `docs/USER_GUIDE.md` | diff 过 | todo |
| T12 | 性能回归（300 万行真实测试）| 需要用户提供 300 万行样本 | P1-1 | todo |

### 关键依赖链

```
T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12
    （DB / UI 骨架 / 规则 / worker 单元 / 导入集成 / 对账 / 开始运行 UI / 导出 / 状态文案 / 文档 / 性能）
```

**关键节点**（人工复核红线）：

- **T1 独立 DB**：一旦 schema 定型，后续数据都依赖，migration 必须幂等
- **T5 worker + batch INSERT**：⚠️ 性能红线（R-T1）；300 万行 < 5 分钟（若无法 < 3 分钟，回来汇报）
- **T7 对账 engine**：⚠️ **资金敏感**（三类差异语义错会让用户做错决策），必须覆盖手工算过的小数据集比对
- **T9 导出 writer**：⚠️ 列顺序、`_before` / `_after` 对应关系错会让用户看错数据，必跑 4-6 行的样本文件人眼过

---

## 五、实施计划（Commit 粒度）

| 序号 | Commit message | 涉及文件 | 任务 |
|------|---------------|---------|------|
| 1 | `feat(v2.0.0): 独立 pending DB + schema migrations` | T1 | T1 |
| 2 | `feat(v2.0.0): 顶部模块切换改为下拉（3 选 1）` | T2 | T2 |
| 3 | `feat(v2.0.0): Pending 模块骨架（DOM + state + 空容器）` | T3 | T3 |
| 4 | `feat(v2.0.0): Pending 规则管理（UI + IPC + repository）` | T4 | T4 |
| 5 | `feat(v2.0.0): Pending 导入 worker（child process + 校验 + 批量 INSERT）` | T5 | T5 |
| 6 | `feat(v2.0.0): Pending 导入入口（多文件 + 年月 + 覆盖留底）` | T6 | T6 |
| 7 | `feat(v2.0.0): Pending 对账 engine + benchmark` | T7 | T7 |
| 8 | `feat(v2.0.0): Pending 开始运行 UI + 相邻月校验` | T8 | T8 |
| 9 | `feat(v2.0.0): Pending 导出差异（单月选 run + 汇总）` | T9 | T9 |
| 10 | `feat(v2.0.0): Pending 状态框完整流 + 报错链路` | T10 | T10 |
| 11 | `docs(v2.0.0): CHANGELOG + VERSION_FEATURE_HISTORY + USER_GUIDE 同步` | T11 | T11 |
| 12 | `test(v2.0.0): 300 万行性能回归` | T12 | T12 |

---

## 六、实施日志

> 记录实施过程中的关键决策、风险发现和可沉淀知识。详见 `changes/v2.0.0/log.md`。

### 已执行 Reverse Sync 速览

| # | 日期 | 主题 | 核心决策 |
|---|------|------|---------|
| Rev Sync v1→v1.1 | 2026-04-24 | OT-9 枚举撤回 + ExcelJS 替换 + worker 流式 INSERT + 复合索引 | 见 PRD §十一 |
| Rev Sync #5 | 2026-04-24 | 对账语义 AND → A1 fallback + SQL → JS 层 Map 配对 | 见 log.md |
| Rev Sync #6 | 2026-04-24 | UX 打磨 + 导出差异格式增强（changed 双行 + pair_id + _diff + 资金类型差异 sheet）+ benchmark 删除 | 见 log.md |

---

## 七、技术决策记录

用户 sign-off 全部 6 个 OT-T：

| 编号 | 决策 | 落地位置 |
|---|---|---|
| OT-T1 | **性能目标 300 万行 / 31 列 < 5 分钟**（从 3 分钟放宽）| PRD §九 已更新；child process 启动传 `--max-old-space-size=8192` |
| OT-T2 | **DB 列名用中文原名**（反引号包裹）| `pending-db/columns.js` 常量；`migrations.js` 建表用 `\`金额\`` / `\`pending资金类型\`` 等 |
| OT-T3 | **`match_fields` 动态索引在"开始运行"时 lazy 建** | `pending-reconcile/engine.js` 每次 run 前调用 `ensureMatchIndex(db, matchFields)` |
| OT-T4 | **`XLSX.readFile` 全读 + child process `--max-old-space-size=8192`**（不引入 exceljs）| `pending-session.js` spawn worker 传该 flag；若实测爆内存再回来 fallback exceljs streaming |
| OT-T5 | **对账 SQL 用 NOT EXISTS**（new/missing）+ INNER JOIN（changed）| `pending-reconcile/engine.js` |
| OT-T6 | **强制留底**，不提供"跳过留底"选项 | `pending-session.js` 覆盖前必执行留底；留底失败即 abort |
