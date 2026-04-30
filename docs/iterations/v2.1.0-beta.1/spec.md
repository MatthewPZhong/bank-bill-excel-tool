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

### 1.2 PR-B 对账引擎（约 10 文件）

| 文件 | 改动 | 概要 |
|---|---|---|
| `src/constants/recon-id-fix-fields.js` | 新增 | 4 sheet 表头常量（详见 §四） |
| `src/main-process/recon-id-fix-io.js` | 新增 | 4 sheet 读 + 校验 + 写 15 列输出 |
| `src/main-process/recon-id-fix-engine.js` | 新增 | C4 引擎主入口 `runC4Scenario(scenario, sheets)` |
| `src/main-process/scenario-engines/c4-recon-id-fix.js` | 新增 | 与 v2.0.0-beta.3 c1/c2/c3 同目录；7+5 规则纯函数 |
| `src/main-process/scenario-engines/index.js`（如需） | 新增 case | 仅当复用 dispatcher 时；本模块不复用 dispatcher，**不改 index.js** |
| `src/main.js` | 4 IPC handler 实装 | `recon-id-fix:import / run / export / session-status` |
| `src/preload.js` | 暴露 4 IPC | `desktopApi.reconIdFix.import / run / export / sessionStatus` |
| `src/renderer.js` | 4 按钮 binding 接通 | `import → run → export` 状态机 + statusBox 文案 |
| `scripts/smoke/recon-id-fix-engine.js` | 新增 smoke 测 | 7+5 规则 12 用例 + 边界 4 用例 |
| `scripts/smoke/recon-id-fix-io.js` | 新增 smoke 测 | 4 sheet 校验 + writer 5 用例 |
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
  stats?: { fixedRowCount: number; warningCount: number; mainRowsTouched: number; oppRowsTouched: number };
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

#### `recon-id-fix:export`

```typescript
desktopApi.reconIdFix.export(): Promise<{
  status: 'ok' | 'cancelled' | 'empty' | 'failed';
  mainFilePath?: string;
  mainFileName?: string;
  message?: string;
}>
```

实现要点：
- 校验 `reconIdFixResult` 存在
- defense in depth：重读 `database.getScenario(scenariosSnapshot.scenarioId)` + 比对 snapshot 字符串；不一致 → 清缓存 + 返回 failed
- 空 fixedRows → 返回 empty
- `dialog.showSaveDialog` → 默认文件名 `单据对账修复-YYYYMMDDHHmm-{sanitized scenarioName}.xlsx`
- 调 `recon-id-fix-io.js: writeReconIdFixOutput({ fixedRows, fixTemplateHeaders, savePath })`

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

### 5.2 `recon-id-fix-engine.js` + `scenario-engines/c4-recon-id-fix.js`

```javascript
// recon-id-fix-engine.js — 顶层入口
function runReconIdFix(scenario, sheets) {
  if (!scenario || scenario.category !== 'recon-id-fix') {
    throw new Error('runReconIdFix: scenario.category 必须是 recon-id-fix');
  }
  const { runC4Scenario } = require('./scenario-engines/c4-recon-id-fix');
  return runC4Scenario(scenario, sheets);
  // 返回 { fixedRows, warnings, stats }
}
```

```javascript
// scenario-engines/c4-recon-id-fix.js — 7+5 规则纯函数
const {
  evaluateCondition,         // 复用 v2.0.0-beta.3
  makeWarningCollector,
  normalizeCellValue,
  valuesEqual
} = require('./engine-utils');

function runC4Scenario(scenario, sheets) {
  const cfg = scenario.config || {};
  const warningCollector = makeWarningCollector(scenario.id, scenario.name);
  const fixedRows = [];

  // 1. 给主从边账单按 billTypes 分类
  const mainTyped = classifyRows(sheets.businessBills, cfg.billTypes, 'main');
  const oppTyped  = classifyRows(sheets.opponentBills, cfg.billTypes, 'opp');

  // 2. 按 reconFields 序号分组（同序号一组 AND；不同序号一组 OR）
  const groups = groupReconFields(cfg.reconFields);

  // 3. 对每组：分别尝试 1v1 / 1v多 / 多v1
  for (const grp of groups) {
    const leftRows  = mainTyped.filter(r => r._types.has(grp.leftTypeSeq));
    const rightRows = oppTyped .filter(r => r._types.has(grp.rightTypeSeq));

    if (cfg.matchRules.oneToOne) {
      tryOneToOne(leftRows, rightRows, grp.recoFields, scenario, sheets.reconResult, fixedRows, warningCollector);
    }
    if (cfg.matchRules.oneToMany) {
      tryOneToMany(leftRows, rightRows, grp.recoFields, scenario, sheets.reconResult, fixedRows, warningCollector);
    }
    if (cfg.matchRules.manyToOne) {
      tryManyToOne(leftRows, rightRows, grp.recoFields, scenario, sheets.reconResult, fixedRows, warningCollector);
    }
  }

  return {
    fixedRows,
    warnings: warningCollector.list(),
    stats: {
      fixedRowCount: fixedRows.length,
      warningCount: warningCollector.list().length,
      mainRowsTouched: countByOriginSide(fixedRows, 'main'),
      oppRowsTouched:  countByOriginSide(fixedRows, 'opp')
    }
  };
}
```

<!-- 2026-04-30 决策回写：Q2=A（resolveSubBizType auto 未命中 → '' + warning，不中断）-->
#### 5.2.1 7+5 规则映射（详见 PRD §七.3）

每条 `tryXxxYyy` 内部根据 `cfg.output.mode` 选 R1/R3/RB1/RB3 或 R2/R4/RB2/RB4 路径；SubBizType 由 `resolveSubBizType(side, row, cfg.output.subBizType, sheets.reconResult, warningCollector)` 决定。

> ⚠️ Q2=A 决策（2026-04-30）：`resolveSubBizType(side, row, subCfg, reconResult, warningCollector)` 在 `subCfg.mode === 'auto'` 且 `reconResult.filter(...)` 命中数为 0 时：
> - 调 `warningCollector.push({scenarioId, scenarioName, sourceSide: side, sourceRowOrderId: row.OrderId, code: 'subBizType-not-found', message: '在对账结果 sheet 未匹配到 BizType+OrderId 行'})`
> - 返回空串 `''`，**不抛错**、**不中断**
> - 调用方 `applyAssignment_*` 把 `SubBizType: ''` 写入 fixedRows，行仍写入

#### 5.2.2 防止 1v1 路径同时被 1v多 / 多v1 重复处理

实现"已配对 row 集合"：每次成功配对的 row push 到 `pairedRowIds`；后续路径过滤掉 paired。
顺序：1v1 → 1v多 → 多v1（用户先试单笔，找不到才走多笔）

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

| 触发 | `reconIdFixResult = null` | `reconIdFixSession = null` |
|---|---|---|
| `recon-id-fix:import` | ✓ | — |
| `recon-id-fix:run` | 写入新值 | — |
| `scenarios:create` (任意 category) | ✓（影响范围与 v2.0.0-beta.3 一致；也清 `processingResult`） | — |
| `scenarios:update` | ✓ | — |
| `scenarios:delete` | ✓ | — |
| `scenarios:toggle-enabled` | ✓ | — |
| `recon-id-fix:export` 中 snapshot 不一致 | ✓ + 拒绝导出 | — |

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

### 9.2 PR-B smoke 范围

| 文件 | 测试点（用例数估算）|
|---|---|
| `scripts/smoke/recon-id-fix-engine.js` | 12 用例：R1/R2/R3/R4 各 1（4） + R5/R6/R7（3） + RB1/RB2/RB3/RB4/RB5（5） |
| `scripts/smoke/recon-id-fix-io.js` | 7 用例：4 sheet 校验各 1（4） + 列校验失败 + writer round-trip + 空命中 |
| `scripts/smoke/recon-id-fix-end-to-end.js` | 4 用例：fixture 全链路 mode=main / opp / both / SubBizType 自动查 |

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

`scenarios:create` / `scenarios:update` / `scenarios:delete` / `scenarios:toggle-enabled` 4 个 handler 在 v2.0.0-beta.3 已有 `processingResult = null`；本迭代追加：

```javascript
// src/main.js — 4 个 handler 都加
processingResult = null;
reconIdFixResult = null;  // ← 新增
```

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

1. **多场景批量跑**：当前单场景模式（D10 + Q4 决策的"主页面下拉单选"）；用户后续如需多场景能否复用 v2.0.0-beta.3 dispatcher？
   - 当前 spec：不复用，避免引入 first-match-wins 行级锁与本模块的 fixedRows/warnings 模型冲突
   - 替代：未来加新 IPC `recon-id-fix:run-batch` 时再考虑
