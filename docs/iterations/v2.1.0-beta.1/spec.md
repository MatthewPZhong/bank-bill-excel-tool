# spec — v2.1.0-beta.1 单据对账 ReconID 修复模块

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（draft） |
| 目标版本 | `v2.1.0-beta.1` |
| 关联 PRD | `PRD-v2.1.0-beta.1.md`（本目录） |
| 关联 tasks | `tasks.md`（本目录） |
| 起草日期 | 2026-04-30 |
| 起草人 | team-lead（PM 角色） |

> 本文档落到字段级、表结构级、IPC 通道级、文件路径级。供 Dev 实施时直接对照。

---

## 一、新增 / 改动文件清单

<!-- 2026-04-30 决策回写：Q4=部分采纳（PR-A 文件清单含主面板下拉相关代码） -->
### 1.1 PR-A 骨架（约 13 文件）

| 文件 | 改动 | 概要 |
|---|---|---|
| `src/backend/database/migrations.js` | 新增 `ensureScenariosCategoryReconIdFix(db)` | CHECK 约束扩 4 值，重建表迁移；幂等 |
| `src/backend/database.js` | 调用新 migration | 在 `runMigrations()` 链路中 |
| `src/backend/database/scenarios-repository.js` | `VALID_CATEGORIES` 数组追加 | `'recon-id-fix'` |
| `src/backend/database/settings-repository.js:95` | `CURRENT_MODULE_VALID` 追加 | `'recon-id-fix'` |
| `index.html:41-44` | 模块下拉新增第 5 项 | `<button class="module-option" data-module="recon-id-fix">单据对账 ReconID 修复</button>` |
| `index.html`（新 panel） | 新增 `reconIdFixModulePanel` | fork `bankStatementModulePanel`（4 按钮 + 1 场景下拉 + statusBox；Q4 决策追加 `<select id="reconIdFixScenarioSelect">`） |
| `src/renderer.js`（搜 MODULES） | `MODULES.reconIdFix` + `setCurrentModule` 分支 + 6 elements 缓存（含 `reconIdFixScenarioSelect`，Q4 新增）+ 4 按钮 binding 占位 + 场景下拉 reload 函数 | 与 v2.0.0-beta.3 PR #30 同结构 |
| `src/renderer-dialogs.js:5525 createScenarioCategorySelectDialog` | 三选一扩四选一 | 新增"单据对账 ReconID 修复" 项 |
| `src/renderer-dialogs.js:65-67` | 类别 → dialog 路由扩 | 加 `'recon-id-fix' → createScenarioConfigDialogC4` |
| `src/renderer-dialogs.js`（5381 附近） | 场景管理表"功能类别"列文案映射 | 4 类显示名 |
| `src/renderer-dialogs.js`（新增 dialog factory） | 新增 `createScenarioConfigDialogC4` | 5 行 + 识读按钮 + 完成按钮 |
| `src/renderer-dialogs.js`（确认弹窗） | `createScenarioConfirmDetailDialog` 增 C4 文本预览 | switch case |
| `src/renderer-dialogs.js` 或 `src/renderer.js` | 场景管理 dialog 关闭时回调 → `reloadReconIdFixScenarios()`（Q4 新增） | 主面板下拉同步 |
| `styles.css` + `styles-gemini-extra.css` | 模块面板 + C4 dialog 样式 + 主面板"场景"下拉样式 | 新 `.recon-id-fix-board` 等 class |

### 1.2 PR-B 对账引擎（**Round 5 微调后约 14 文件**）

> Round 5（2026-05-09，用户测试反馈微调）：Step 2 ±1day 多候选时按 tie-break 挑 1 个最优做 1v1（不退池子）。
> 仅改 `c4-recon-id-fix.js` 的 `tryOneToOne`（增 `pickBestByTieBreak` 工具函数）+ 同步 smoke。
> 其他文件不动；Round 4 subset-sum 池子 + tieBreak + RB4 Type=0 + unmatched writer 全部沿用。


| 文件 | 改动 | 概要 |
|---|---|---|
| `src/constants/recon-id-fix-fields.js` | 新增 | 4 sheet 表头常量（详见 §四） |
| `src/main-process/recon-id-fix-io.js` | 新增/扩 | 4 sheet 读 + 校验 + 写 15 列输出 + **Round 3 新增 `writeUnmatchedReport` + `buildUnmatchedReportFileName`** |
| `src/main-process/recon-id-fix-engine.js` | 新增 | C4 引擎主入口 `runC4Scenario(scenario, sheets)` |
| `src/main-process/scenario-engines/c4-recon-id-fix.js` | 新增/重写 | **Round 4 subset-sum 重构**：5 阶段（Step 1/2/3.x/3'.x）+ Step 3.x / 3'.x 改 subset-sum + tieBreak（spread → distToMain → size → firstIdx）；Round 3 RB4 Type=0 沿用 |
| `src/main-process/scenario-engines/index.js`（如需） | 新增 case | 仅当复用 dispatcher 时；本模块不复用 dispatcher，**不改 index.js** |
| `src/main.js` | 4 IPC handler 实装 | `recon-id-fix:import / run / export / session-status`；**Round 3 改 export 一并写主+unmatched 双文件** |
| `src/preload.js` | 暴露 4 IPC | `desktopApi.reconIdFix.import / run / export / sessionStatus` |
| `src/renderer.js` | 4 按钮 binding 接通 | `import → run → export` 状态机 + statusBox 文案；**Round 3 status 加"M 行未匹配"档** |
| `src/renderer-dialogs.js` | C4 dialog 行 4 重构 | **Q1=B**：reconFields[] → reconGroups[]；**Round 3 Decision 4**：新增 group 默认带 Amount 锁定 fieldPair；锁定行 select disable + 删除按钮隐藏 |
| `src/backend/database/migrations.js` | 新增/扩 | `migrateC4ReconGroupsStructure`（Q1=B）+ **Round 3 扩**：兼容老 reconGroups 数据，自动给"恰好 Amount/Amount 的 fieldPair"补 `locked: true`，否则给每个 group 头部插一条 `{leftField:'Amount', rightField:'Amount', locked: true}` |
| `src/backend/database.js` | 调用新 migration | 在 `runMigrations()` 链路中 `ensureScenariosCategoryReconIdFix` 之后 |
| `scripts/smoke/recon-id-fix-engine.js` | 重写 smoke | **Round 3 重写**：覆盖 Step 1 / Step 2 / 池子 1v多 / 多v1 / Amount 锁定 / RB4 Type=0 / unmatched reason 推断 / 跨 group 共享集合 |
| `scripts/smoke/recon-id-fix-io.js` | 扩 smoke | 加 unmatched writer round-trip + buildUnmatchedReportFileName 用例 |
| `scripts/smoke/recon-id-fix-end-to-end.js` | 重写 smoke | 5 阶段端到端 + unmatched 文件输出 + 真实 fixture（"基金"场景）回归 |
| `scripts/smoke/recon-id-fix-ipc-handlers.js` | 扩 smoke | export 双文件返回 / unmatched 单独导出 / stale-snapshot 防御 |
| `scripts/smoke/migrations-recon-id-fix.js` | 扩 smoke | 加 G1-G5 共 5 个 reconFields → reconGroups 迁移用例（含幂等三连）+ **Round 3 加 H 系列**：Amount 锁定 fieldPair migration |
| `scripts/smoke-test.js` | 接入新 smoke 文件 | runner 注册 |

### 1.3 PR-C 识读规律（约 4 文件）

| 文件 | 改动 | 概要 |
|---|---|---|
| `src/main-process/recon-id-fix-infer.js` | 新增 | 识读规律算法 |
| `src/main.js` | 1 IPC handler | `recon-id-fix:infer-rules` |
| `src/preload.js` | 暴露 1 IPC | `desktopApi.reconIdFix.inferRules` |
| `src/renderer-dialogs.js` | C4 dialog 加"识读场景规律"按钮 + 回填逻辑 | tooltip + 文件选择器 + 回填 |
| `scripts/smoke/recon-id-fix-infer.js` | 新增 smoke 测 | 5 用例（fixture 解析 / 候选挖掘 / 边界） |

### 1.4 PR-D 收尾（约 4 文件）

| 文件 | 改动 | 概要 |
|---|---|---|
| `package.json` | `version` bump | `"2.0.0"` → `"2.1.0-beta.1"` |
| `package-lock.json` | 同步 bump | 跟随 |
| `CHANGELOG.md` | 新增 v2.1.0-beta.1 段 | 5 模块概述 |
| `docs/VERSION_FEATURE_HISTORY.md` | 新增 v2.1.0-beta.1 段 | 单据对账 ReconID 修复模块 |
| `docs/USER_GUIDE.md` | 新增 1.5 章节 + 顶部版本号 + 模块总览第 5 项 | 单据对账 ReconID 修复模块使用说明 |

---

## 二、SQLite schema 变更

### 2.1 现状（v2.0.0 GA）

```sql
CREATE TABLE IF NOT EXISTS scenarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL CHECK (category IN (
    'extract-recon-id',
    'offset-bill-mark',
    'gateway-recon-join'
  )),
  name TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  config_json TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (name)
);
```

### 2.2 目标（v2.1.0-beta.1）

CHECK 约束多一个枚举值 `'recon-id-fix'`：

```sql
CHECK (category IN (
  'extract-recon-id',
  'offset-bill-mark',
  'gateway-recon-join',
  'recon-id-fix'
))
```

### 2.3 migration 实现（`ensureScenariosCategoryReconIdFix(db)`）

```javascript
// src/backend/database/migrations.js
function ensureScenariosCategoryReconIdFix(db) {
  // 幂等检查：sqlite_master 取当前 scenarios 表 SQL，若已含 'recon-id-fix' → no-op
  const tableSqlRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='scenarios'"
  ).get();
  if (!tableSqlRow || !tableSqlRow.sql) return;
  if (tableSqlRow.sql.includes("'recon-id-fix'")) return; // 已扩，no-op

  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE scenarios RENAME TO scenarios_old;');

    db.exec(`
      CREATE TABLE scenarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK (category IN (
          'extract-recon-id',
          'offset-bill-mark',
          'gateway-recon-join',
          'recon-id-fix'
        )),
        name TEXT NOT NULL,
        priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 3),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        config_json TEXT NOT NULL,
        is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (name)
      );
    `);

    db.exec(`
      INSERT INTO scenarios
        (id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at)
      SELECT id, category, name, priority, enabled, config_json, is_builtin, created_at, updated_at
      FROM scenarios_old;
    `);

    db.exec('DROP TABLE scenarios_old;');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

> ⚠️ 资金红线：必须包在事务里；包含 v2.0.0-beta.3 builtin scenarios 的老库必须无损迁移。
> ⚠️ 调用顺序：在 `ensureScenariosSupport(db)` 之后；marker 写入逻辑不变。

### 2.4 `scenarios-repository.js` 同步

```javascript
const VALID_CATEGORIES = [
  'extract-recon-id',
  'offset-bill-mark',
  'gateway-recon-join',
  'recon-id-fix'   // ← 新增
];
```

### 2.5 PR-B 数据迁移：`migrateC4ReconGroupsStructure(db)`（**Q1=B 决策回写，2026-04-30**）

PR-A 已 ship 的 C4 场景 config_json 含 `reconFields[]`（每条带 seq/leftTypeSeq/rightTypeSeq/leftField/rightField）。
PR-B Q1=B 决策把 dialog 与引擎模型改为 `reconGroups[]`（每组自带 leftTypeSeq/rightTypeSeq + fieldPairs[]）。
为兼容 PR-A 老库需要一次性迁移。

```javascript
// src/backend/database/migrations.js
function migrateC4ReconGroupsStructure(db) {
  const rows = db.prepare(
    `SELECT id, config_json FROM scenarios WHERE category = 'recon-id-fix'`
  ).all();
  if (rows.length === 0) return;
  const update = db.prepare(`UPDATE scenarios SET config_json = ?, updated_at = ? WHERE id = ?`);
  const now = new Date().toISOString();
  rows.forEach((row) => {
    let config;
    try { config = JSON.parse(row.config_json); } catch (_e) { return; }
    if (!config || typeof config !== 'object') return;
    // 幂等：已含 reconGroups → no-op（清掉 reconFields 残留即可）
    if (Array.isArray(config.reconGroups) && config.reconGroups.length > 0) {
      if (Object.prototype.hasOwnProperty.call(config, 'reconFields')) {
        delete config.reconFields;
        update.run(JSON.stringify(config), now, row.id);
      }
      return;
    }
    if (!Array.isArray(config.reconFields) || config.reconFields.length === 0) return;
    // 按 seq 聚合
    const grouped = new Map();
    for (const rf of config.reconFields) {
      if (!rf || typeof rf !== 'object') continue;
      if (!grouped.has(rf.seq)) {
        grouped.set(rf.seq, {
          leftTypeSeq: rf.leftTypeSeq,
          rightTypeSeq: rf.rightTypeSeq,
          fieldPairs: []
        });
      }
      grouped.get(rf.seq).fieldPairs.push({ leftField: rf.leftField, rightField: rf.rightField });
    }
    config.reconGroups = Array.from(grouped.values());
    delete config.reconFields;
    update.run(JSON.stringify(config), now, row.id);
  });
}
```

幂等性要求（smoke G1-G5 覆盖）：
1. 已含 reconGroups（且不含 reconFields）→ no-op
2. 仅含 reconFields[] → 转换 + 写回（删除 reconFields，写入 reconGroups）
3. 同时含两者（理论上不出现）→ 以 reconGroups 为准，删除 reconFields 残留
4. 解析 config_json 失败 → 跳过该行不抛错
5. category != 'recon-id-fix' → 完全不动（保护 C2 自己的 reconFields[] 结构）

调用顺序：`AppDatabase.init()` 中 `ensureScenariosCategoryReconIdFix()` 之后（依赖 CHECK 约束已扩到 4 值）。

---

## 三、IPC 通道清单

### 3.1 复用（v2.0.0-beta.3 已 ship）

| Channel | Handler | preload 暴露 |
|---|---|---|
| `scenarios:list` | `src/main.js:2710` | `desktopApi.scenarios.list` |
| `scenarios:get` | `src/main.js:2717` | `desktopApi.scenarios.get` |
| `scenarios:create` | `src/main.js:2728` | `desktopApi.scenarios.create` |
| `scenarios:update` | `src/main.js:2739` | `desktopApi.scenarios.update` |
| `scenarios:delete` | `src/main.js:2748` | `desktopApi.scenarios.delete` |
| `scenarios:toggle-enabled` | `src/main.js:2757` | `desktopApi.scenarios.toggleEnabled` |

> 这 6 个 channel 已支持 C4：`scenarios.create({category: 'recon-id-fix', ...})` 在 `VALID_CATEGORIES` 扩展后即可用。
> 复用 v2.0.0-beta.3 PR #33 round 2/3 的 `processingResult = null` 清缓存逻辑——本模块也要在 IPC 入口清 `state.reconIdFixResult`，详见 §六。

### 3.2 新增（PR-B + PR-C）

#### `recon-id-fix:import`

```typescript
// 调用：renderer → main
desktopApi.reconIdFix.import(): Promise<{
  status: 'ok' | 'cancelled' | 'invalid' | 'failed';
  fileName?: string;
  sheetCounts?: { recon: number; business: number; opp: number };
  code?: string;       // FileValidationError code
  message?: string;
  detailLines?: string[];
}>
```

实现要点：
- `dialog.showOpenDialog` → 用户选 .xlsx
- 调 `recon-id-fix-io.js: readReconIdFixFile(filePath)`
- 校验 4 sheet 名 + 各 sheet 表头（详见 §四）
- 写 `reconIdFixSession`（session state，详见 §六）
- 重新导入清空 `reconIdFixResult` + 同步触发 statusBox 文案

#### `recon-id-fix:run`

<!-- 2026-04-30 决策回写：Q4=部分采纳（scenarioId 来源 = 主面板"场景"下拉）-->
```typescript
desktopApi.reconIdFix.run(payload: { scenarioId: number }): Promise<{
  status: 'ok' | 'failed';
  stats?: {
    fixedRowCount: number;
    warningCount: number;
    unmatchedRowCount: number;        // ⬅︎ Round 3 新增
    mainRowsTouched: number;
    oppRowsTouched: number;
  };
  message?: string;
}>
```

> ⚠️ Q4 决策（2026-04-30）：`payload.scenarioId` 由 renderer 从**主面板"场景"下拉**（`elements.reconIdFixScenarioSelect.value`）当前选中项取得；下拉未选时「开始运行」按钮 disabled，IPC 不应被触发。

实现要点：
- 校验 `reconIdFixSession` 存在 + `scenarioId` 非空且对应 scenario 存在 + 该 scenario 的 `category === 'recon-id-fix'`
- `database.getScenario(scenarioId)` 取 config
- structuredClone 三个 sheet（避免 in-place 修改污染 session，参考 v2.0.0-beta.3 PR #32a F1 P1）
- 调 `recon-id-fix-engine.js: runReconIdFix(scenario, sheets)`
- 落 `reconIdFixResult` + 写 `scenariosSnapshot`（含本场景的 id|name|priority|enabled|config 拼接）
- 返回 stats

#### `recon-id-fix:export`（**Round 3 修订，2026-05-09**）

```typescript
desktopApi.reconIdFix.export(): Promise<{
  status: 'ok' | 'cancelled' | 'empty' | 'failed';
  mainFilePath?: string;
  mainFileName?: string;
  unmatchedFilePath?: string;       // ⬅︎ Round 3 新增
  unmatchedFileName?: string;
  rowCount?: number;
  unmatchedCount?: number;
  message?: string;
}>
```

实现要点（**Round 3 修订**）：
- 校验 `reconIdFixResult` 存在
- defense in depth：重读 `database.getScenario(...)` + 比对 snapshot；不一致 → 清缓存 + 返回 failed
- **空命中 + 空 unmatched** → 返回 status='empty'
- 至少一方非空 → 弹 saveDialog（用户选主文件保存位置）；timestamp 在 export 入口内一次生成，主+unmatched 共用
- 主文件非空 → 调 `writeReconIdFixOutput({ fixedRows, savePath })`
- unmatched 非空 → 在主文件保存目录用 `buildUnmatchedReportFileName(...)` 生成路径调 `writeUnmatchedReport({ unmatchedRows, savePath })`
- 返回值含主+unmatched 两路径

#### `recon-id-fix:session-status`

```typescript
desktopApi.reconIdFix.sessionStatus(): Promise<{
  status: 'ok';
  hasFile: boolean;
  fileName?: string;
  sheetCounts?: { recon: number; business: number; opp: number };
  hasResult: boolean;
  resultStats?: { fixedRowCount: number; warningCount: number };
}>
```

renderer 启动时拉一次刷 statusBox。

#### `recon-id-fix:infer-rules`（PR-C）

```typescript
desktopApi.reconIdFix.inferRules(sampleFilePath?: string): Promise<{
  status: 'ok' | 'failed';
  billTypes?: Array<{ side: 'main'|'opp'; conditions: Array<{field, op, value}> }>;
  reconFields?: Array<{ leftSeq: number; leftField: string; rightSeq: number; rightField: string }>;
  message?: string;
}>
```

实现要点：
- 若 `sampleFilePath` 未传 → 弹 `dialog.showOpenDialog` 让用户选文件
- 调 `recon-id-fix-infer.js: inferReconIdFixRules(filePath)`
- 仅返回推断结果，**不落库**；renderer 拿到后回填 dialog

---

## 四、字段常量（`src/constants/recon-id-fix-fields.js`）

```javascript
// 「对账结果」sheet 表头（18 列）
const RECON_RESULT_FIELDS = [
  '账单日期', '业务部门', '对手部门', '业务类型', '对账结果',
  'reconId', '业务部门单号', '业务部门金额', '业务部门币种', '业务部门单据子类型',
  '对手部门单号', '对手部门金额', '对手部门币种', '对手部门单据子类型',
  '业务部门交易完成时间', '对手部门完成时间', '对平类型', '备注'
];

// 「业务部门账单」sheet 表头（23 列）— 主边
const BUSINESS_BILL_FIELDS = [
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type', 'Reference', 'Currency', 'Amount', 'OriginBillBizId', 'ReconBillBizId',
  'BizType', 'reconId', 'clientId', 'AccountId', 'createTime', 'finishTime', 'subRcptType',
  '订单创建来源', '交易订单号'
];

// 「对手部门账单」sheet 表头（22 列）— 从边
const OPPONENT_BILL_FIELDS = [
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type', 'Reference', 'Currency', 'Amount', 'OriginBillBizId', 'ReconBillBizId',
  'BizType', 'reconId', 'clientId', 'AccountId', 'createTime', 'finishTime', 'subRcptType',
  '交易订单号'
];

// 「订单修复」sheet 表头（15 列）— 输出
const ORDER_REPAIR_FIELDS = [
  'BillDate', 'Bank', 'MerchantId', 'OrderId', 'DataSource', 'OppBu', 'OriginBillSource',
  'BillType', 'Type', 'Reference', 'Currency', 'Amount', 'OriginBillBizId', 'ReconBillBizId',
  'SubBizType'
];

// sheet 名常量
const RECON_RESULT_SHEET_NAME = '对账结果';
const BUSINESS_BILL_SHEET_NAME = '业务部门账单';
const OPPONENT_BILL_SHEET_NAME = '对手部门账单';
const ORDER_REPAIR_SHEET_NAME = '订单修复';

module.exports = {
  RECON_RESULT_FIELDS,
  BUSINESS_BILL_FIELDS,
  OPPONENT_BILL_FIELDS,
  ORDER_REPAIR_FIELDS,
  RECON_RESULT_SHEET_NAME,
  BUSINESS_BILL_SHEET_NAME,
  OPPONENT_BILL_SHEET_NAME,
  ORDER_REPAIR_SHEET_NAME,
};
```

> 字段顺序与样例 `samples/单据对账导出不平.xlsx` 完全一致；运行时严格校验。

---

## 五、核心模块实现细节

### 5.1 `recon-id-fix-io.js`

```javascript
// 公开签名
async function readReconIdFixFile(filePath): Promise<{
  filePath: string;
  fileName: string;
  sheets: {
    reconResult: Array<RowObject>;
    businessBills: Array<RowObject>;
    opponentBills: Array<RowObject>;
    fixTemplate: { headers: string[]; rows: [] };
  };
  importedAt: number;
}>

async function writeReconIdFixOutput({
  fixedRows,
  savePath
}): Promise<{ filePath: string; fileName: string; rowCount: number }>
```

读法：复用 `src/backend/file-service/readers.js` 现有 SheetJS（与 v2.0.0-beta.3 `bank-statement-io.js: sheetToObjects` 相同模式）。

写法：直接 SheetJS（无标黄需求，**不引入 exceljs**）。`xlsx-js-style` 已在依赖里（`pending-session.js` 已用），表头字号 10pt 与其他 writer 一致。

校验：
- 必须含 4 个 sheet（按名）
- 「对账结果」sheet 表头 == `RECON_RESULT_FIELDS`（顺序+长度严格）
- 「业务部门账单」表头 == `BUSINESS_BILL_FIELDS`
- 「对手部门账单」表头 == `OPPONENT_BILL_FIELDS`
- 「订单修复」表头 == `ORDER_REPAIR_FIELDS`（rows 可空，仅取作模板）
- 任一不符 → `FileValidationError(code, message, { detailLines })`

输出：
- 单 sheet：`'订单修复'`
- 表头 = `ORDER_REPAIR_FIELDS`（15 列）
- 行 = `fixedRows`（每行已是 `{BillDate, ..., SubBizType}` 对象）
- 文件名见 §三 export

### 5.2 `recon-id-fix-engine.js` + `scenario-engines/c4-recon-id-fix.js`（**Round 4 subset-sum 重构，2026-05-09**）

> Round 4 修订（用户测试发现 Round 3 池子语义错位）：
> - Round 3 错误：池子里"逐行 Amount 全等"过滤（每个候选从单 Amount === 主单 Amount）
> - Round 4 正解：subset-sum(候选.Amount) === 主.Amount —— 会计对账常见做法（多笔小金额拼出大金额）
>
> 5 阶段算法步骤不变（Step 1/2/3.1/3.2/3'.1/3'.2），但 Step 3.x / Step 3'.x 内部改 subset-sum 语义：
> - 候选过滤：BillDate（按 mode）+ **除 Amount 外其他对账字段** AND 全等
> - subset-sum：候选 Amount 整数化（×100 转分，避浮点精度坑），DFS + 升序剪枝；subset 必须 size ≥ 2
> - 多解 tie-break：spread 最小 → 离主单最近 → size 最小 → firstIdx 字典序兜底
> - 跨 group 共享 pairedLeft/pairedRight，避免双重命中
> - 跑完所有 group 后未配的主从行写 unmatched.xlsx 告警 report（详见 §五.4）

```javascript
// recon-id-fix-engine.js — 顶层入口
function runReconIdFix(scenario, sheets) {
  if (!scenario || scenario.category !== 'recon-id-fix') {
    throw new Error('runReconIdFix: scenario.category 必须是 recon-id-fix');
  }
  const { runC4Scenario } = require('./scenario-engines/c4-recon-id-fix');
  return runC4Scenario(scenario, sheets);
  // 返回 { fixedRows, warnings, unmatchedRows, stats }
}
```

```javascript
// scenario-engines/c4-recon-id-fix.js — 5 阶段算法 + 7+5 规则纯函数（Round 3 重写）
const {
  evaluateCondition,
  makeWarningCollector,
  normalizeCellValue
} = require('./engine-utils');

function runC4Scenario(scenario, sheets) {
  const cfg = scenario.config || {};
  const matchRules = cfg.matchRules || {};
  const warningCollector = makeWarningCollector(scenario.id, scenario.name);
  const fixedRows = [];

  // 1. billTypes 分类
  const mainTyped = classifyRows(sheets.businessBills, cfg.billTypes, 'main');
  const oppTyped  = classifyRows(sheets.opponentBills, cfg.billTypes, 'opp');

  const groups = groupReconFields(cfg);

  // 2. 跨 group 共享配对集合
  const pairedLeft  = new Set();
  const pairedRight = new Set();
  // 跟踪每行最后到达的 step（用于 unmatched reason 推断）
  const lastStepByLeft  = new Map();
  const lastStepByRight = new Map();

  for (const grp of groups) {
    const leftRows  = mainTyped.filter(r => r._types.has(grp.leftTypeSeq));
    const rightRows = oppTyped .filter(r => r._types.has(grp.rightTypeSeq));
    const amountPair = findAmountLockedPair(grp.fieldPairs);

    // ----- Step 1：同 BillDate 严格 1v1（全部 fieldPairs AND）-----
    if (matchRules.oneToOne) {
      tryOneToOne(leftRows, rightRows, grp.fieldPairs, 'strict',
        scenario, cfg, sheets.reconResult, fixedRows, warningCollector,
        pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, 'step1');
    }
    // ----- Step 2：BillDate ±1day 1v1（全部 fieldPairs AND） -----
    if (matchRules.oneToOne) {
      tryOneToOne(leftRows, rightRows, grp.fieldPairs, '±1day',
        scenario, cfg, sheets.reconResult, fixedRows, warningCollector,
        pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, 'step2');
    }
    // ----- Step 3.1+3.2：池子 1v多（subset-sum + tieBreak，Round 4 重写）-----
    if (matchRules.oneToMany && amountPair) {
      tryOneToManyPool(leftRows, rightRows, grp.fieldPairs, 'strict',
        scenario, cfg, sheets.reconResult, fixedRows, warningCollector,
        pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, 'step3.1');
      tryOneToManyPool(leftRows, rightRows, grp.fieldPairs, '±1day',
        scenario, cfg, sheets.reconResult, fixedRows, warningCollector,
        pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, 'step3.2');
    }
    // ----- Step 3'.1+3'.2：池子 多v1（subset-sum + tieBreak，Round 4 重写）-----
    if (matchRules.manyToOne && amountPair) {
      tryManyToOnePool(leftRows, rightRows, grp.fieldPairs, 'strict',
        scenario, cfg, sheets.reconResult, fixedRows, warningCollector,
        pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, "step3'.1");
      tryManyToOnePool(leftRows, rightRows, grp.fieldPairs, '±1day',
        scenario, cfg, sheets.reconResult, fixedRows, warningCollector,
        pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, "step3'.2");
    }
  }

  // 3. 算法跑完后收集 unmatchedRows
  const unmatchedRows = collectUnmatchedRows(
    mainTyped, oppTyped, pairedLeft, pairedRight,
    lastStepByLeft, lastStepByRight, matchRules, scenario.name
  );

  return {
    fixedRows,
    warnings: warningCollector.list(),
    unmatchedRows,
    stats: {
      fixedRowCount: fixedRows.length,
      warningCount: warningCollector.list().length,
      unmatchedRowCount: unmatchedRows.length,
      mainRowsTouched: fixedRows.filter(r => r._sourceSide === 'main').length,
      oppRowsTouched:  fixedRows.filter(r => r._sourceSide === 'opp').length
    }
  };
}
```

#### 5.2.x findAmountLockedPair / billDateMatches 工具函数

```javascript
// 找 group 里"locked Amount/Amount" fieldPair（行级锁定，由 dialog 强制；migration 兼容老数据）
function findAmountLockedPair(fieldPairs) {
  if (!Array.isArray(fieldPairs)) return null;
  for (const fp of fieldPairs) {
    if (!fp) continue;
    if (fp.leftField === 'Amount' && fp.rightField === 'Amount') return fp;
  }
  return null;
}

// BillDate 比较：mode='strict' 严格相等；mode='±1day' 容错（D-1 / D / D+1 任一相等）
function billDateMatches(leftRaw, rightRaw, mode) {
  const L = normalizeCellValue(leftRaw);
  const R = normalizeCellValue(rightRaw);
  if (L === '' || R === '') return false;
  if (L === R) return true;
  if (mode !== '±1day') return false;
  const lDate = parseBillDateMs(L);
  const rDate = parseBillDateMs(R);
  if (lDate === null || rDate === null) return false;
  const diff = Math.abs(lDate - rDate);
  return diff === 86400 * 1000;
}

function parseBillDateMs(s) {
  // 'YYYY-MM-DD' 或 'YYYY/MM/DD' 或 ExcelDate 的 number→string
  const m = String(s).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}
```

<!-- 2026-04-30 决策回写：Q2=A（resolveSubBizType auto 未命中 → '' + warning，不中断）-->
<!-- 2026-04-30 决策回写：PR-B Q2=a（commonId 取 src.reconId 不是 OrderId）-->
#### 5.2.1 7+5 规则映射（详见 PRD §七.3）

每条 `tryXxxYyy` 内部根据 `cfg.output.mode` 选 R1/R3/RB1/RB3 或 R2/R4/RB2/RB4 路径；SubBizType 由 `resolveSubBizType(side, row, cfg.output.subBizType, sheets.reconResult, warningCollector)` 决定。

`computeCommonId` 实现（PR-B Q2=a 决策回写，2026-04-30）：

```javascript
// 共同修复 ID（仅 mode='both' 用）
// commonIdCfg = { source: 'main'|'opp', suffix: string }
function computeCommonId(commonIdCfg, leftRow, rightRow) {
  if (!commonIdCfg) return '';
  const src = commonIdCfg.source === 'opp' ? rightRow : leftRow;
  const baseReconId = src ? normalizeCellValue(src.reconId) : '';
  const suffix = commonIdCfg.suffix === null || commonIdCfg.suffix === undefined ? '' : String(commonIdCfg.suffix);
  return baseReconId + suffix;
}
```

> ⚠️ 决策依据（2026-04-30）：业务上 reconId 才是"同对账组"的稳定标识；OrderId 跨主从边没法表达"同对账组"。
> 用户 fixture 验证：Right 文件（`/Users/pzhong/Downloads/单据对账修复-202604301427-基金-应导出文件.xlsx`）的 commonId 列正是 reconId 拼接结果。

> ⚠️ Q2=A 决策（2026-04-30）：`resolveSubBizType(side, row, subCfg, reconResult, warningCollector)` 在 `subCfg.mode === 'auto'` 且 `reconResult.filter(...)` 命中数为 0 时：
> - 调 `warningCollector.push({scenarioId, scenarioName, sourceSide: side, sourceRowOrderId: row.OrderId, code: 'subBizType-not-found', message: '在对账结果 sheet 未匹配到 BizType+OrderId 行'})`
> - 返回空串 `''`，**不抛错**、**不中断**
> - 调用方 `applyAssignment_*` 把 `SubBizType: ''` 写入 fixedRows，行仍写入

#### 5.2.2 防止重复配对 — pairedLeft / pairedRight 集合

实现"已配对 row 集合"：每次成功配对的 row push 到 `pairedLeft.add(_rowIdx)` / `pairedRight.add(_rowIdx)`；后续 step / group 过滤掉 paired。
**顺序**（Round 3 重写）：Step 1 → Step 2 → Step 3.1 → Step 3.2 → Step 3'.1 → Step 3'.2。

> ⚠️ PR-B Q1=B 决策（2026-04-30）：reconGroups[] 顺序就是用户在 dialog 看到的"分组顺序"。
> 跨 group 的 OR 行为：多个 group 共享 pairedLeft/pairedRight 集合——一行被某 group 某 step 配对成功后不会再被后续 step / group 处理。
> 这与早期 PR-A spec（同 seq AND，不同 seq OR）的运行时语义一致，仅数据结构改变。

> ⚠️ Round 3 决策（2026-05-09）：跨 step 也共享 pairedLeft/pairedRight。这意味着 Step 1 严格命中的行不会再被 Step 2 或 Step 3.x 处理；优先级：严格 > 容错 > 池子。

#### 5.2.3 tryOneToOne 与 Step 2 多候选 tie-break（**Round 5 微调，2026-05-09**）

> Round 5 微调依据：用户测试 round 4 时发现一个用例没命中——
> 主单 04-28 USD 300000 入账；从单池里有 04-27（target）和 04-29 两个 USD 300000 入账；
> 期望命中 04-27 target，但 round 4 实现要求"恰好 1 个候选"，候选 = 2 时直接跳过 → 退到 Step 3 池子失败 → 进 unmatched。
> 用户决策：Step 2 多候选时按 tie-break 挑 1 个 1v1 命中（不退到池子）。

`tryOneToOne` 共用 Step 1 / Step 2，由 `billDateMode` 切换。Round 5 起：

- **`billDateMode === 'strict'`（Step 1）保持原行为**：候选数必须恰好 1 + reverse 也恰好 1 才命中（资金红线最严）
- **`billDateMode === '±1day'`（Step 2）启用 tie-break 多候选挑选 + 双向一致性校验**：
  1. 候选 ≥ 1 时，用 `pickBestByTieBreak(leftRow, candidates)` 挑 1 个最优 `bestRight`
  2. 反向：从 `bestRight` 视角回看 `leftRows`，filter 出"未配 + BillDate 容错通过 + AND 全等"得到 reverseCandidates
  3. 用同样 tie-break 选 `bestLeftFromReverse`；若不是当前 `leftRow` → 让位（continue）避免主从抢配冲突
  4. 一致 → 锁定 `pairedLeft.add(leftRow._rowIdx)` + `pairedRight.add(bestRight._rowIdx)` + 走 `apply1v1Assignment`

`pickBestByTieBreak(referenceRow, candidates)` 排序顺序：
1. **|referenceRow.BillDate - candidate.BillDate| 最小**（距离最近）
2. **并列时按 candidate `_rowIdx` 数字部分（解析后比较）最小**（原数组顺序首个 row index；`_rowIdx` 形如 `'opp_0'` / `'main_3'`）

> ⚠️ PR #36 round 1 P2 修复（2026-04-30）：原文档与实现都用"`_rowIdx` 字符串字典序"作 fallback，但当候选 ≥ 10 时 `'opp_10'` < `'opp_2'`（字典序按字符比较，`'1'<'2'`）排错；改成解析 `_rowIdx` 数字部分比较即可恢复"原数组首个 row index"的真实语义。详见 §五.2.4.1 `parseRowIdxNum`。

伪代码：

```javascript
function pickBestByTieBreak(referenceRow, candidates) {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const refMs = parseBillDateMs(normalizeCellValue(referenceRow.BillDate));
  return candidates
    .map((r) => ({
      row: r,
      dist: refMs === null || parseBillDateMs(r.BillDate) === null
        ? Infinity
        : Math.abs(refMs - parseBillDateMs(r.BillDate)),
      idxNum: parseRowIdxNum(r._rowIdx)
    }))
    .sort((a, b) => a.dist - b.dist || a.idxNum - b.idxNum)[0].row;
}

function tryOneToOne(leftRows, rightRows, fieldPairs, billDateMode, ..., stepLabel) {
  for (const leftRow of leftRows) {
    if (pairedLeft.has(leftRow._rowIdx)) continue;
    lastStepByLeft.set(leftRow._rowIdx, stepLabel);
    const candidates = rightRows.filter(r =>
      !pairedRight.has(r._rowIdx)
      && billDateMatches(leftRow.BillDate, r.BillDate, billDateMode)
      && rowsMatchFieldPairs(leftRow, r, fieldPairs)
    );
    if (billDateMode === 'strict') {
      // Step 1：保持原行为，必须恰好 1 个候选 + reverse 1
      if (candidates.length !== 1) continue;
      const reverse = leftRows.filter(...);
      if (reverse.length !== 1) continue;
      // 锁定 + apply1v1Assignment
    } else {
      // Step 2 ±1day：多候选 tie-break + 双向一致性校验
      if (candidates.length === 0) continue;
      const bestRight = pickBestByTieBreak(leftRow, candidates);
      candidates.forEach(r => lastStepByRight.set(r._rowIdx, stepLabel));
      const reverseCandidates = leftRows.filter(l =>
        !pairedLeft.has(l._rowIdx)
        && billDateMatches(l.BillDate, bestRight.BillDate, billDateMode)
        && rowsMatchFieldPairs(l, bestRight, fieldPairs)
      );
      if (reverseCandidates.length === 0) continue;
      const bestLeftFromReverse = pickBestByTieBreak(bestRight, reverseCandidates);
      if (bestLeftFromReverse._rowIdx !== leftRow._rowIdx) continue; // 反向不一致让位
      // 锁定 + apply1v1Assignment
    }
  }
}
```

> ⚠️ Round 5 关键不变量：
> 1. Step 1 严格 1v1 行为不变（候选 2 → 跳过，不靠 tie-break）
> 2. Step 2 单候选行为不变（候选 1 → 直接命中，单候选 pickBestByTieBreak 直接返回该候选）
> 3. 双向一致性校验避免主从抢配冲突 — 当多个主单都把同一从单当 bestRight 时，只有"反向 pickBest 选回当前主单"的那一个主单才命中
> 4. 让位的主单本轮不命中，但下一轮（其他主单可能因 reverse 不一致也让位）仍可能找到其他从单

#### 5.2.4 池子算法实现细节（**Round 4 subset-sum 重写，2026-05-09**）

```javascript
// Step 3.x 池子 1v多：subset-sum(候选从.Amount) === 主.Amount
//   候选过滤：BillDate（按 mode）+ 除 Amount 外其他对账字段 AND 全等
//   subset-sum：候选 Amount 整数化（×100 转分），DFS + 升序剪枝；subset 必须 size ≥ 2
//   多解 tieBreak：spread → distToMain → size → firstIdx 字典序兜底
function tryOneToManyPool(leftRows, rightRows, fieldPairs, billDateMode,
  scenario, cfg, reconResult, fixedRows, warningCollector,
  pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, stepLabel) {
  // 拆出 amountPair（locked）+ 其他 fieldPairs
  const amountPair = findAmountLockedPair(fieldPairs);
  if (!amountPair) return;
  const otherFieldPairs = (fieldPairs || []).filter(
    (fp) => fp && !(fp.leftField === 'Amount' && fp.rightField === 'Amount')
  );

  for (const leftRow of leftRows) {
    if (pairedLeft.has(leftRow._rowIdx)) continue;
    lastStepByLeft.set(leftRow._rowIdx, stepLabel);
    // 候选过滤：BillDate + 其他对账字段 AND 全等（Amount 不参与）
    const candidates = rightRows.filter((r) =>
      !pairedRight.has(r._rowIdx)
        && billDateMatches(leftRow.BillDate, r.BillDate, billDateMode)
        && rowsMatchOtherFieldPairs(leftRow, r, otherFieldPairs)
    );
    if (candidates.length < 2) {
      candidates.forEach((r) => lastStepByRight.set(r._rowIdx, stepLabel));
      continue;
    }
    // subset-sum 找子集（size ≥ 2）
    const targetCents = toCents(leftRow.Amount);
    if (targetCents === null) {
      candidates.forEach((r) => lastStepByRight.set(r._rowIdx, stepLabel));
      continue;
    }
    const candidatesWithCents = candidates
      .map((r) => ({ row: r, cents: toCents(r.Amount) }))
      .filter((c) => c.cents !== null);
    const subsets = enumerateAmountSubsets(candidatesWithCents, targetCents);
    if (subsets.length === 0) {
      candidates.forEach((r) => lastStepByRight.set(r._rowIdx, stepLabel));
      continue;
    }
    const chosen = subsets.length === 1
      ? subsets[0]
      : tieBreakSubsets(subsets, leftRow.BillDate);
    if (!chosen || chosen.length < 2) {
      candidates.forEach((r) => lastStepByRight.set(r._rowIdx, stepLabel));
      continue;
    }
    pairedLeft.add(leftRow._rowIdx);
    chosen.forEach((r) => pairedRight.add(r._rowIdx));
    apply1vNAssignment(leftRow, chosen, scenario, cfg, reconResult, fixedRows, warningCollector);
  }
}

// Step 3'.x 池子 多v1：subset-sum(候选主.Amount) === 从.Amount（对称）
function tryManyToOnePool(leftRows, rightRows, fieldPairs, billDateMode,
  scenario, cfg, reconResult, fixedRows, warningCollector,
  pairedLeft, pairedRight, lastStepByLeft, lastStepByRight, stepLabel) {
  const amountPair = findAmountLockedPair(fieldPairs);
  if (!amountPair) return;
  const otherFieldPairs = (fieldPairs || []).filter(
    (fp) => fp && !(fp.leftField === 'Amount' && fp.rightField === 'Amount')
  );
  for (const rightRow of rightRows) {
    if (pairedRight.has(rightRow._rowIdx)) continue;
    lastStepByRight.set(rightRow._rowIdx, stepLabel);
    const candidates = leftRows.filter((l) =>
      !pairedLeft.has(l._rowIdx)
        && billDateMatches(l.BillDate, rightRow.BillDate, billDateMode)
        && rowsMatchOtherFieldPairs(l, rightRow, otherFieldPairs)
    );
    if (candidates.length < 2) {
      candidates.forEach((l) => lastStepByLeft.set(l._rowIdx, stepLabel));
      continue;
    }
    const targetCents = toCents(rightRow.Amount);
    if (targetCents === null) {
      candidates.forEach((l) => lastStepByLeft.set(l._rowIdx, stepLabel));
      continue;
    }
    const candidatesWithCents = candidates
      .map((l) => ({ row: l, cents: toCents(l.Amount) }))
      .filter((c) => c.cents !== null);
    const subsets = enumerateAmountSubsets(candidatesWithCents, targetCents);
    if (subsets.length === 0) {
      candidates.forEach((l) => lastStepByLeft.set(l._rowIdx, stepLabel));
      continue;
    }
    const chosen = subsets.length === 1
      ? subsets[0]
      : tieBreakSubsets(subsets, rightRow.BillDate);
    if (!chosen || chosen.length < 2) {
      candidates.forEach((l) => lastStepByLeft.set(l._rowIdx, stepLabel));
      continue;
    }
    pairedRight.add(rightRow._rowIdx);
    chosen.forEach((l) => pairedLeft.add(l._rowIdx));
    applyNv1Assignment(chosen, rightRow, scenario, cfg, reconResult, fixedRows, warningCollector);
  }
}

// 注意：tryOneToOne 在 Step 1 / Step 2 共用同一函数，billDateMode 参数控制日期比较；
// Step 1+2 要求 group 全部 fieldPairs AND 全等（含 Amount，因为 1v1 时主从 Amount 等价）；
// 池子 Step 3.x / 3'.x 只用 "其他对账字段 AND 全等"过滤候选 + Amount 走 subset-sum。
```

#### 5.2.4.1 subset-sum 工具函数（**Round 4 新增**）

```javascript
// 金额转整数分（×100 四舍五入）— 避免浮点 0.1+0.2!=0.3 精度坑
function toCents(amount) {
  if (amount === null || amount === undefined) return null;
  if (typeof amount === 'string') {
    const trimmed = amount.trim();
    if (trimmed === '') return null;             // 空串 → null（避免 Number('')===0 假命中）
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  }
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) return null;
    return Math.round(amount * 100);
  }
  return null;
}

// 池子算法专用：除 Amount 外的对账字段 AND 全等过滤
//   otherFieldPairs 已在调用端过滤掉 Amount/Amount 锁定行；空数组 → 直接 true
function rowsMatchOtherFieldPairs(leftRow, rightRow, otherFieldPairs) {
  if (!Array.isArray(otherFieldPairs) || otherFieldPairs.length === 0) return true;
  return otherFieldPairs.every((fp) => {
    const lv = normalizeCellValue(leftRow[fp.leftField]);
    const rv = normalizeCellValue(rightRow[fp.rightField]);
    if (lv === '' && rv === '') return false;
    return lv === rv;
  });
}

// subset-sum 枚举：在 candidates 中找所有 subset 使 sum(cents) === targetCents
//   - subset.length ∈ [2, maxSize]（业务上一笔大单很少拆超过 8 笔小单）
//   - DFS + 升序剪枝（sum > target 则后续更大值无须试）
//   - solutions 上限 maxSolutions（防极端数据组合爆炸）
//   - 返回 Array<Array<row>>，每个解 = 命中 row 数组（已按 _origIdx 升序保证稳定）
function enumerateAmountSubsets(candidates, targetCents, maxSize = 8, maxSolutions = 64) {
  if (!Array.isArray(candidates) || candidates.length < 2) return [];
  if (!Number.isFinite(targetCents) || targetCents <= 0) return [];
  const indexed = candidates.map((c, originalIdx) => ({ ...c, _origIdx: originalIdx }));
  indexed.sort((a, b) => a.cents - b.cents);
  const solutions = [];
  const path = [];
  function dfs(startIdx, remaining, depth) {
    if (solutions.length >= maxSolutions) return;
    if (remaining === 0 && depth >= 2) {
      solutions.push(path.slice());
      return;
    }
    if (depth >= maxSize) return;
    for (let i = startIdx; i < indexed.length; i++) {
      const c = indexed[i];
      if (c.cents > remaining) break;       // 升序剪枝
      path.push(c);
      dfs(i + 1, remaining - c.cents, depth + 1);
      path.pop();
      if (solutions.length >= maxSolutions) return;
    }
  }
  dfs(0, targetCents, 0);
  return solutions.map((s) => s
    .slice()
    .sort((a, b) => a._origIdx - b._origIdx)
    .map((c) => c.row)
  );
}

// tieBreak：多解时按 spread → distToMain → size → firstIdxNum 数字部分排序，取首
//
// PR #36 round 1 P2 修复（2026-04-30）：原实现 `s.map(r=>r._rowIdx).sort()[0]` 是字符串字典序，
// 当候选 ≥ 10 时 'opp_10' < 'opp_2'（因 '1'<'2'）排错；改成解析 _rowIdx 数字部分比较即可。
function tieBreakSubsets(subsets, mainBillDate) {
  if (!Array.isArray(subsets) || subsets.length === 0) return null;
  if (subsets.length === 1) return subsets[0];
  const mainMs = parseBillDateMs(normalizeCellValue(mainBillDate));
  const scored = subsets.map((s) => {
    const dates = s.map((r) => parseBillDateMs(normalizeCellValue(r.BillDate))).filter((x) => x !== null);
    const spread = dates.length === 0 ? Infinity : (Math.max(...dates) - Math.min(...dates));
    let distToMain = Infinity;
    if (mainMs !== null && dates.length > 0) {
      distToMain = Math.min(...dates.map((d) => Math.abs(mainMs - d)));
    }
    const firstIdxNum = Math.min(...s.map((r) => parseRowIdxNum(r._rowIdx)));
    return { subset: s, spread, distToMain, size: s.length, firstIdxNum };
  });
  scored.sort((a, b) => {
    if (a.spread !== b.spread) return a.spread - b.spread;
    if (a.distToMain !== b.distToMain) return a.distToMain - b.distToMain;
    if (a.size !== b.size) return a.size - b.size;
    return a.firstIdxNum - b.firstIdxNum;
  });
  return scored[0].subset;
}

// PR #36 round 1 P2 修复新增：解析 _rowIdx 字符串末尾数字部分
//   _rowIdx 形如 'main_<idx>' / 'opp_<idx>'（由 classifyRows 生成）
//   非法格式（无 _<digits> 后缀）→ 返回 MAX_SAFE_INTEGER 让其排在最后
function parseRowIdxNum(rowIdx) {
  if (rowIdx === null || rowIdx === undefined) return Number.MAX_SAFE_INTEGER;
  const m = String(rowIdx).match(/_(\d+)$/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}
```

> ⚠️ 性能边界：subset-sum DFS 在最坏情况下是 O(2^n) 但通过升序剪枝 + maxSize=8 + maxSolutions=64 三道防线，业务场景候选 ≤ 数百时可控。
> ⚠️ 浮点精度：必须先 `toCents` 化成整数分再比较，否则 `0.1 + 0.2 = 0.30000000000000004 ≠ 0.3` 经典坑会让 200 个用例对账失败。
> ⚠️ subset 必须 size ≥ 2：1 主 vs 1 从单元素子集已在 Step 1 / Step 2 处理过；池子里 size=1 视为"无解"防止与 1v1 重复抢配。

#### 5.2.5 collectUnmatchedRows（**Round 3 新增**）

```javascript
function collectUnmatchedRows(mainTyped, oppTyped, pairedLeft, pairedRight,
  lastStepByLeft, lastStepByRight, matchRules, scenarioName) {
  const out = [];
  function deriveReason(rowIdx, lastStepMap, matchRules) {
    const last = lastStepMap.get(rowIdx);
    if (last === 'step3.2' || last === "step3'.2") return '池子内 BillDate ±1day 未匹配';
    if (last === 'step3.1' || last === "step3'.1") return '池子内 BillDate 未匹配';
    if (last === 'step2') {
      // 进了 Step 2 但未配；如果用户没勾池子算法 → 直接此原因
      if (!matchRules.oneToMany && !matchRules.manyToOne) return '1v1 BillDate ±1day 未匹配';
      // 如果勾了池子但未进 Step 3.x → 因为该行不属于任何 group 的 leftRows / rightRows（理论极少）
      return '1v1 BillDate ±1day 未匹配';
    }
    if (last === 'step1') {
      if (!matchRules.oneToMany && !matchRules.manyToOne) return '1v1 严格 BillDate 未匹配';
      return '1v1 严格 BillDate 未匹配';
    }
    if (!matchRules.oneToMany && !matchRules.manyToOne) return '未勾 1v多/多v1，跳过';
    return '未勾 1v多/多v1，跳过';  // fallback，理论不会
  }
  for (const r of mainTyped) {
    if (pairedLeft.has(r._rowIdx)) continue;
    out.push({
      场景名: scenarioName, 单据来源: '主',
      OrderId: r.OrderId, BillDate: r.BillDate, Amount: r.Amount,
      未配原因: deriveReason(r._rowIdx, lastStepByLeft, matchRules)
    });
  }
  for (const r of oppTyped) {
    if (pairedRight.has(r._rowIdx)) continue;
    out.push({
      场景名: scenarioName, 单据来源: '从',
      OrderId: r.OrderId, BillDate: r.BillDate, Amount: r.Amount,
      未配原因: deriveReason(r._rowIdx, lastStepByRight, matchRules)
    });
  }
  return out;
}
```

<!-- 2026-04-30 决策回写：Q1=A（直读 row.reconId，无 fallback） -->
#### 5.2.3 lookupReconId（用于 R1-R4 / RB 系列）

```javascript
function lookupReconId(opCounterRow) {
  // 用户业务约定：导入的"业务部门账单" / "对手部门账单" sheet 各行都已带正确的 reconId 列
  // R1-R4 / RB 系列里 Reference 取"对方那边"的 reconId 字段
  // 直接读 opCounterRow.reconId 即可（无需回查"对账结果" sheet）
  return opCounterRow ? (opCounterRow.reconId ?? '') : '';
}
```

> ⚠️ 决策依据（2026-04-30）：用户已确认"业务部门账单"/"对手部门账单"两 sheet 的 reconId 列由对账系统填好，直读即可，无需回查"对账结果" sheet。**单一路径**，**无 dry-run fallback**，**不引入** `reconResult` 反查分支。
> ⚠️ 资金红线提示：若 `opCounterRow.reconId` 为空（导入数据本身缺列值），返回空串并由调用方写入 warnings；不要静默走兜底反查，避免污染 Reference。

#### 5.2.6 RB4 1v多 修订（**Round 3 Decision 1，2026-05-09**）

```javascript
// apply1vNAssignment：mode='both' 分支
//   原 (Round 1+2)：left Type=0；多个 right Type=2
//   修订 (Round 3) ：left Type=0；多个 right **Type=0**（全 0）
function apply1vNAssignment_both(leftRow, matches, scenario, cfg, reconResult, fixedRows, warningCollector) {
  const commonId = computeCommonId((cfg.output || {}).commonId, leftRow, matches[0]);
  const leftSub  = resolveSubBizType('main', leftRow, cfg.output.subBizType, reconResult, warningCollector);
  fixedRows.push(buildOutputRow(leftRow, { Type: 0, Reference: commonId, SubBizType: leftSub, _sourceSide: 'main' }));
  for (const rightRow of matches) {
    const rightSub = resolveSubBizType('opp', rightRow, cfg.output.subBizType, reconResult, warningCollector);
    fixedRows.push(buildOutputRow(rightRow, {
      Type: 0,                       // ⬅︎ Round 3 修订（原 2 → 0）
      Reference: commonId,
      SubBizType: rightSub,
      _sourceSide: 'opp'
    }));
  }
}

// applyNv1Assignment：mode='both' 分支保持原规则不变（多个 left Type=2 / right Type=0）
```

> ⚠️ 决策依据（2026-05-09 Decision 1）：用户重新审视后，1v多 = 1 主对 N 从（多张独立从单据），从单据本身是各独立项；多v1 = N 主聚合到 1 从，主单据是被聚合方才是 Type=2。

### 5.4 `recon-id-fix-io.js: writeUnmatchedReport`（**Round 3 新增，2026-05-09，Decision 3**）

```javascript
// recon-id-fix-io.js — 新增 writer
async function writeUnmatchedReport({ unmatchedRows, savePath }) {
  if (!Array.isArray(unmatchedRows)) {
    throw new Error('writeUnmatchedReport: unmatchedRows 必须是数组');
  }
  if (!savePath) {
    throw new Error('writeUnmatchedReport: 需提供 savePath');
  }
  const dir = path.dirname(savePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const headers = ['场景名', '单据来源', 'OrderId', 'BillDate', 'Amount', '未配原因'];
  const aoa = [headers.slice()];
  for (const row of unmatchedRows) {
    aoa.push(headers.map((col) => {
      const v = row[col];
      return v === null || v === undefined ? '' : v;
    }));
  }
  const ws = XLSXStyle.utils.aoa_to_sheet(aoa);
  applyHeaderRowFont(ws);
  const wb = XLSXStyle.utils.book_new();
  XLSXStyle.utils.book_append_sheet(wb, ws, '未匹配单据');
  XLSXStyle.writeFile(wb, savePath);
  return { filePath: savePath, fileName: path.basename(savePath), rowCount: unmatchedRows.length };
}

// 文件名规则
function buildUnmatchedReportFileName(scenarioName, timestamp = buildTimestampMinute()) {
  const safeName = sanitizeFileName(scenarioName);
  return `单据对账修复-未匹配-${timestamp}-${safeName}.xlsx`;
}
```

**导出策略**（在 `main.js: recon-id-fix:export` handler 内）：

| 主 fixedRows.length | unmatchedRows.length | 行为 |
|---|---|---|
| > 0 | 0 | 仅弹一次 saveDialog 写主文件（与原行为一致；mainFilePath 返回；unmatchedFilePath null） |
| > 0 | > 0 | 弹一次 saveDialog（用户选主文件保存路径），主文件写完后**自动**用相同 timestamp + scenarioName 在同一目录写 unmatched 文件；都返回 |
| 0 | > 0 | 弹一次 saveDialog（用户选主文件位置当容器目录），不写主文件，仅写 unmatched 文件 |
| 0 | 0 | 不弹 saveDialog，直接返回 status='empty' |

> 路径策略：unmatchedFilePath = 主 saveDialog 选定目录 + `buildUnmatchedReportFileName(...)`；与主文件 timestamp 完全一致（在同一次 export 内同步生成 timestamp）。

<!-- 2026-04-30 决策回写：Q3=C（颜色冲突取"有数据 cell"的最高频色）-->
### 5.3 `recon-id-fix-infer.js`（PR-C）

```javascript
async function inferReconIdFixRules(filePath) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const businessSheet = wb.getWorksheet(BUSINESS_BILL_SHEET_NAME);
  const opponentSheet = wb.getWorksheet(OPPONENT_BILL_SHEET_NAME);
  if (!businessSheet || !opponentSheet) {
    throw new Error('识读规律失败：文件缺少业务部门账单或对手部门账单 sheet');
  }

  // 1. 解析每行的"颜色组"
  const businessByColor = groupRowsByCellColor(businessSheet, BUSINESS_BILL_FIELDS);
  const opponentByColor = groupRowsByCellColor(opponentSheet, OPPONENT_BILL_FIELDS);

  // 2. 合并色组（同色的主从边归为一例）
  const exampleGroups = mergeColorGroups(businessByColor, opponentByColor);
  if (exampleGroups.length === 0) {
    throw new Error('识读规律失败：没找到任何例子（无色或同色）');
  }

  // 3. 候选对账字段挖掘
  const reconFieldCandidates = mineReconFields(exampleGroups);

  // 4. 候选账单类型挖掘
  const billTypeCandidates = mineBillTypes(exampleGroups);

  return {
    billTypes: billTypeCandidates.slice(0, 4), // top 4
    reconFields: reconFieldCandidates.slice(0, 4)
  };
}

// Q3=C 决策（2026-04-30）：颜色冲突时按"有数据 cell"的最高频色定行色
function groupRowsByCellColor(sheet, fields) {
  // ExcelJS row.eachCell 取 cell.fill.fgColor.argb
  // 把同色行归到 Map<colorKey, rowObjects[]>
  // 'no-color' = ARGB 'FFFFFFFF' 或 fill 为空
  // 单行多色冲突解决（Q3=C 决策）：
  //   1) 仅统计"有数据的 cell"——cell.value 非 null 且非空字符串（''）
  //   2) 统计这些 cell 的 ARGB 出现次数，按 desc 排序
  //   3) 取 count 最高的 ARGB 作为该行行色
  //   4) 平票（多色 count 并列最高）→ 取第一个出现的色（稳定排序）
  //   5) 该行所有"有数据的 cell"都没颜色 → 归 'no-color'
}

// 关键内部函数（Q3=C 决策落地）
function pickRowColor(row, fields) {
  const counts = new Map(); // ARGB → count
  let firstSeenOrder = []; // 用于平票时取第一个
  for (const field of fields) {
    const cell = row.getCell(/* col index by field */);
    if (cell.value === null || cell.value === undefined || cell.value === '') continue; // 跳过无数据
    const argb = cell.fill && cell.fill.fgColor ? cell.fill.fgColor.argb : null;
    if (!argb || argb === 'FFFFFFFF') continue;
    if (!counts.has(argb)) firstSeenOrder.push(argb);
    counts.set(argb, (counts.get(argb) || 0) + 1);
  }
  if (counts.size === 0) return 'no-color';
  // 取 count 最高，平票取 firstSeenOrder 中靠前者
  let best = firstSeenOrder[0], bestCount = counts.get(best);
  for (const argb of firstSeenOrder) {
    if (counts.get(argb) > bestCount) { best = argb; bestCount = counts.get(argb); }
  }
  return best;
}
```

详细算法见 PRD §七.4。

---

## 六、in-memory state（main 进程）

```javascript
// src/main.js 顶部全局变量
let reconIdFixSession = null;
let reconIdFixResult = null;

// 结构详见 PRD §8.3
```

清空时机（**资金红线**，参考 v2.0.0-beta.3 PR #33 round 2 的双层防御）：

> **PR #35 round 3 P2 修订**：scenarios:* 4 入口按变更场景的 `category` 分流清缓存——避免跨模块互抹。
>
> - C1 / C2 / C3（category in {`extract-recon-id`, `offset-bill-mark`, `gateway-recon-join`}）→ **只清 `processingResult`**
> - C4（category = `recon-id-fix`）→ **只清 `reconIdFixResult`**
>
> 实装：`src/main.js` `clearResultCacheForCategory(category)` 工具函数 + 4 入口先 SELECT 老 row 取 category 再分流（详见 §三 IPC handler）。

| 触发 | `reconIdFixResult = null` | `processingResult = null` | `reconIdFixSession = null` |
|---|---|---|---|
| `recon-id-fix:import` | ✓ | — | — |
| `recon-id-fix:run` | 写入新值 | — | — |
| `scenarios:create` (C4) | ✓ | — | — |
| `scenarios:create` (C1/C2/C3) | — | ✓ | — |
| `scenarios:update` (C4) | ✓ | — | — |
| `scenarios:update` (C1/C2/C3) | — | ✓ | — |
| `scenarios:delete` (C4) | ✓ | — | — |
| `scenarios:delete` (C1/C2/C3) | — | ✓ | — |
| `scenarios:toggle-enabled` (C4) | ✓ | — | — |
| `scenarios:toggle-enabled` (C1/C2/C3) | — | ✓ | — |
| `recon-id-fix:export` 中 snapshot 不一致 | ✓ + 拒绝导出 | — | — |

---

<!-- 2026-04-30 决策回写：Q4=部分采纳（新增主面板"场景"下拉相关 state / element / 按钮联动）-->
## 七、Renderer 状态机

```javascript
// src/renderer.js — state 新增 4 字段
state.reconIdFixSession = null;       // 显示导入文件信息
state.reconIdFixResult = null;        // 显示运行结果信息
state.reconIdFixExport = null;        // 显示导出后信息
state.reconIdFixSelectedScenarioId = null; // 主面板"场景"下拉当前选中的 scenario id（Q4 决策；影响"开始运行"按钮可用）
state.reconIdFixScenarios = [];       // 主面板下拉 source data（每次场景管理 dialog 关闭后 reload）

// 6 个 elements 缓存（Q4 新增 reconIdFixScenarioSelect）
elements.reconIdFixModulePanel
elements.reconIdFixManageScenariosBtn
elements.reconIdFixImportBtn
elements.reconIdFixScenarioSelect    // ← Q4 新增：主面板"场景"单选下拉
elements.reconIdFixRunBtn
elements.reconIdFixExportBtn
elements.reconIdFixStatusBox
```

主面板"场景"下拉刷新时机（Q4 决策）：
- 模块切到"单据对账 ReconID 修复"时
- 场景管理 dialog 关闭时（不论用户做了什么操作，统一 reload）
- `scenarios:create / update / delete / toggle-enabled` 任一 IPC 成功返回后

刷新逻辑（伪代码）：
```javascript
async function reloadReconIdFixScenarios() {
  const all = await desktopApi.scenarios.list();
  state.reconIdFixScenarios = all.filter(s => s.category === 'recon-id-fix');
  renderReconIdFixScenarioSelect();
  // 已选 id 仍存在则保持；不存在则置 null + disable run 按钮
  if (!state.reconIdFixScenarios.some(s => s.id === state.reconIdFixSelectedScenarioId)) {
    state.reconIdFixSelectedScenarioId = null;
  }
  updateReconIdFixRunBtnEnabled();
}
```

按钮可用性（Q4 决策更新）：

| 按钮 / 控件 | 启用条件 |
|---|---|
| 场景管理 | 始终启用 |
| 导入文件 | 始终启用 |
| **场景下拉** | `state.reconIdFixScenarios.length > 0`；空场景时 disabled，placeholder = "请先在场景管理中创建场景" |
| 开始运行 | `state.reconIdFixSession !== null` **&&** `state.reconIdFixSelectedScenarioId !== null`（即用户已在主面板下拉里选了一个 C4 场景） |
| 导出文件 | `state.reconIdFixResult !== null` |

statusBox 文案（详见 PRD §三 D11，Q4 新增"已配场景未导入"档）。

---

## 八、Renderer Dialog 实现

### 8.1 `createScenarioConfigDialogC4` 结构

```
┌─ 场景配置（C4：单据对账 ReconID 修复）──────────────────────────┐
│                                                                │
│  场景名称：[___________________]                                │
│                                                                │
│  单据匹配规则：                                                  │
│   ☑ 主边单据 1 v 1 从边单据                                      │
│   ☐ 主边单据 1 v 多 从边单据                                     │
│   ☐ 主边单据 多 v 1 从边单据                                     │
│                                                                │
│  账单类型：                                                      │
│   #1: [主边▼] [BillType▼] [等于▼] [业务订单_____]   [新增] [✗]  │
│   #2: [从边▼] [OriginBillSource▼] [等于▼] [rcpt_inbound] [✗]    │
│  [新增账单类型]                                                 │
│                                                                │
│  对账字段：                                                      │
│   #1: [类型 1▼] [Currency▼]  vs  [类型 2▼] [Currency▼]   [✗]    │
│   #2: [类型 1▼] [Amount▼]    vs  [类型 2▼] [Amount▼]     [✗]    │
│  [新增]                                                         │
│                                                                │
│  修复结果输出：                                                  │
│   ☐ 主边单据   ☐ 从边单据    （互斥）                            │
│   ☑ 主从边都修复 →  取 [主边单据ID▼] 加上 [_____] 作为主从边共同的修复ID │
│   ─── SubBizType 取值（三选一） ────────────────────────────────  │
│   ☑ 订单修复表的SubBizType值取对应单据在对账结果表里单据子类型     │
│   ☐ 主边单据SubBizType值 [_____]                                │
│   ☐ 从边单据SubBizType值 [_____]                                │
│                                                                │
│ [识读场景规律] (tooltip)                  [取消] [完成]          │
└────────────────────────────────────────────────────────────────┘
```

### 8.2 控件联动

- 行 2：1v多 ↔ 多v1 单选切换（jQuery 风格 onchange）
- 行 3 下拉 1（主/从）→ 下拉 2 enum 重渲染（用 `BUSINESS_BILL_FIELDS` 或 `OPPONENT_BILL_FIELDS`）
- 行 3 下拉 3 = "空值"/"非空值" → 隐藏值输入框
- 行 4 下拉 1/3 enum = `state.scenarioDraft.billTypes.map(t => t.seq)`（动态）
- 行 4 下拉 2 enum = `BUSINESS_BILL_FIELDS`；下拉 4 enum = `OPPONENT_BILL_FIELDS`
- 行 5：勾"主从边都修复" → 禁用上面两个 + 显示共同 ID 区
- 行 5 SubBizType 三选一：勾"自动查"则禁用两个手填框；任一手填有值 → 取消"自动查"勾选

### 8.3 与 v2.0.0-beta.3 dialog 模式一致性

复用 `state.scenarioDraft` 跨弹窗共享（PR #33 PRD §8 已落）；"返回"保留 / "完成"成功落库 / "取消" / 关闭 / 模块切换都清空。

### 8.4 「识读场景规律」按钮

- 按钮 + tooltip（PRD §三 D7 文本）
- 点击 → 调 `desktopApi.reconIdFix.inferRules()`（不传 path，main 弹文件选择器）
- 返回 ok → 用 `inferred.billTypes` / `inferred.reconFields` 替换 dialog 行 3 / 行 4 内容（保留 dialog 其他字段）+ 弹 toast"已自动填充"
- 返回 failed → 弹 alert

---

## 九、测试策略

### 9.1 PR-A smoke 范围

| 文件 | 测试点 |
|---|---|
| `scripts/smoke/scenarios-repository.js`（已有）| 增 1 用例：`createScenario({category: 'recon-id-fix', ...})` 通过校验 |
| `scripts/smoke/migrations-recon-id-fix.js`（新） | A1 空库启动 CHECK 含 4 值 / B1 v2.0.0-beta.3 老库启动 builtin 无损 / C1 重复启动幂等 |

### 9.2 PR-B smoke 范围（**Round 4 subset-sum 重构**）

| 文件 | 测试点（实际用例数）|
|---|---|
| `scripts/smoke/recon-id-fix-engine.js` | **Round 4 重写**：常量 + helpers + 5 阶段算法（Step 1 / Step 2 / Step 3.x / Step 3'.x）+ Amount 锁定保护 + RB4 Type=0 + unmatched reason 推断 + 跨 group 共享 + 多 group OR 集成 + **subset-sum 工具函数（toCents / enumerateAmountSubsets / tieBreakSubsets）+ 用户用例（270k = 200k + 70k）+ 多解 tieBreak + 大候选集性能 + 浮点精度 + 多v1 对称** |
| `scripts/smoke/recon-id-fix-io.js` | **Round 3 扩**：原 9 用例 + writeUnmatchedReport round-trip + buildUnmatchedReportFileName 命名 |
| `scripts/smoke/recon-id-fix-end-to-end.js` | **Round 3 重写**：5 阶段端到端 mode=main/opp/both（含 unmatched 输出）+ "基金"真实 fixture 全量回归 |
| `scripts/smoke/recon-id-fix-ipc-handlers.js` | **Round 3 扩**：export 双文件返回 / 主空 unmatched 非空 / stale-snapshot 防御 / 主+unmatched 都空 → empty |
| `scripts/smoke/migrations-recon-id-fix.js` | **扩 G + H 系列**：G1-G5 reconFields → reconGroups 迁移 + H1-H3 Amount 锁定 fieldPair migration（自动补 locked / 自动插入头部 Amount 锁定行 / 老库已含 Amount/Amount 不重复插） |

<!-- 2026-04-30 决策回写：Q3=C（新增"颜色冲突最高频色"用例）-->
### 9.3 PR-C smoke 范围

| 文件 | 测试点 |
|---|---|
| `scripts/smoke/recon-id-fix-infer.js` | 6 用例：fixture 解析 / 同色分组 / 无色分组 / 候选对账字段挖掘 / 候选账单类型挖掘 / **单行多色冲突取"有数据 cell"最高频色（Q3=C）** |

### 9.4 GUI 实测（PR-B + PR-D）

详见 PRD §十二 P0/P1 矩阵。

---

## 十、Defense in depth — 资金红线双层防御

**完全沿用 v2.0.0-beta.3 PR #33 round 2 + 3 的双层模式**：

### 10.1 第一层：scenarios:* IPC 入口主动清

`scenarios:create` / `scenarios:update` / `scenarios:delete` / `scenarios:toggle-enabled` 4 个 handler 按变更场景的 `category` 分流清缓存（**PR #35 round 3 P2 修订**：原方案"两个都清"会让 C4 变更误抹银行对账模块的 `processingResult`，反向亦然）。

```javascript
// src/main.js — 4 个 handler 共享工具函数
function clearResultCacheForCategory(category) {
  if (category === 'recon-id-fix') {
    reconIdFixResult = null;     // C4 变更只清 C4 模块结果
  } else {
    processingResult = null;     // C1/C2/C3 变更只清银行对账模块结果
  }
}

// create：从 payload.category 取（已通过 createScenario 内 validateCategory）
clearResultCacheForCategory(payload && payload.category);

// update / delete / toggle：先 SELECT 老 row 取 category（spec §三 update 不允许改 category；
// delete 路径必须先查再删，否则 row 已不存在）
const existing = database.getScenario(id);
// ... 执行 update/delete/toggle ...
clearResultCacheForCategory(existing && existing.category);
```

> ⚠️ delete 必须**先 SELECT 后 DELETE**，否则 `database.getScenario(id)` 在 DELETE 之后会返回 null，分流退化成默认走 `processingResult = null`，等同于"删 C4 误清银行对账结果"——回到原始 finding。

### 10.2 第二层：export 端被动校验 snapshot

```javascript
// src/main.js — recon-id-fix:export handler
function buildReconIdFixSnapshot(scenario) {
  return [
    scenario.id,
    scenario.name,
    scenario.priority,
    scenario.enabled ? 1 : 0,
    JSON.stringify(scenario.config || {})
  ].join('|');
}

trackedIpcHandle('recon-id-fix:export', '单据对账ReconID修复', '导出文件', async () => {
  if (!reconIdFixResult) return { status: 'failed', message: '请先点击"开始运行"' };

  const currentScenario = database.getScenario(reconIdFixResult.scenarioId);
  if (!currentScenario) {
    reconIdFixResult = null;
    return { status: 'failed', message: '场景已删除，请重新选择场景再运行' };
  }
  const currentSnapshot = buildReconIdFixSnapshot(currentScenario);
  if (currentSnapshot !== reconIdFixResult.scenariosSnapshot) {
    reconIdFixResult = null;
    return { status: 'failed', message: '场景已变更，请重新点击"开始运行"再导出' };
  }
  // ... 走正常导出
});
```

---

## 十一、preload 暴露

```javascript
// src/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  // ...（v2.0.0 已有的）

  reconIdFix: {
    import: () => ipcRenderer.invoke('recon-id-fix:import'),
    run: (scenarioId) => ipcRenderer.invoke('recon-id-fix:run', scenarioId),
    export: () => ipcRenderer.invoke('recon-id-fix:export'),
    sessionStatus: () => ipcRenderer.invoke('recon-id-fix:session-status'),
    inferRules: () => ipcRenderer.invoke('recon-id-fix:infer-rules')
  }
});
```

---

<!-- 2026-04-30 决策回写：Q1/Q2/Q3 已闭环，仅 Q4 后续若再扩多场景批量再考虑 -->
## 十二、Open Technical Questions

> 2026-04-30：用户已对原 4 个 Open Question 给出决策（Q1/Q2/Q3/Q4），已分别回写入 PRD §6 D6 / §8.4 与 spec §5.2.3 / §5.3 / §三 / §七等章节。下表仅保留**远期保留项**。
> 2026-05-09 Round 3：用户对 Decision 1-5 已闭环，留下少量算法边界问题待生产观察。

1. **多场景批量跑**：当前单场景模式（D10 + Q4 决策的"主页面下拉单选"）；用户后续如需多场景能否复用 v2.0.0-beta.3 dispatcher？
   - 当前 spec：不复用，避免引入 first-match-wins 行级锁与本模块的 fixedRows/warnings 模型冲突
   - 替代：未来加新 IPC `recon-id-fix:run-batch` 时再考虑

2. **BillDate ±1day 容错的并发匹配冲突如何处理**（Round 3 新增）：
   - 当前 spec：Step 2 走严格"反向校验 reverse.length === 1"逻辑；只要左右两个候选集合都恰好是 1，就配对；否则跳过
   - 边界场景：如果"Step 1 严格命中 1 但 Step 2 ±1day 后又有第二个候选"理论上不会出现（因为 Step 1 已锁两端）；但用户场景可能出现"主单 D 同时与从单 D-1 和 D+1 都对得上 Currency+Amount+BizType"的情况——当前算法行为：reverse.length 会变成 2 跳过，留给 Step 3 池子或 unmatched
   - 远期保留：用户验证后如果该场景出现且需求改"取最近时间"，再加 BillDate diff 排序逻辑；当前不做

3. **池子内 1v多 + 多v1 同时勾选时优先级**（Round 3 新增）：
   - 当前 spec：算法按"Step 3.1 / 3.2 → Step 3'.1 / 3'.2"顺序跑（即 1v多 优先于 多v1）
   - 影响：如果一对剩余主从同时满足 1v多 和 多v1（理论极少），1v多 会先抢配对；多v1 看不到了
   - 当前 spec：保持顺序，文档说明；用户可通过调整 reconGroups 顺序间接控制
   - 远期保留：用户如需"两路径都跑出候选再投票"，再加策略参数
