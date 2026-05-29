# 技术规格 — v2.1.11 迭代：单测运行日志 + pending 移除核对 + C2「银行对账单字段赋值」增强

| 字段 | 值 |
|---|---|
| 文档版本 | v0.1（2026-05-29）|
| 关联 PRD | `PRD-v2.1.11.md` v0.2（决策全确认）|
| 关联 tasks | `tasks.md` |
| 起草人 | PM（team-lead）|
| 状态 | v0.1 — 待委托 dev 实现 |

> 本 spec 仅覆盖 PRD §1.1 的 3 个用户追加需求（T1/T2/T3）。性能主线（A3-multi-worker / F5-cont）另起 spec。

---

## 一、总览

### 1.1 三需求技术边界

| 需求 | 进程/层 | 核心改动 | 必须保持的不变量 |
|---|---|---|---|
| **T1** | 构建脚本（Node CLI）| `run-unit-tests.js` 解析输出 + 落盘 | 退出码透传语义；`release-check` 串联；三平台兼容 |
| **T2** | DB + main + renderer 全链路 | 新表 + reader + IPC + 匹配 + 导出 2 sheet | 现有 `new/missing/changed` 逻辑；`pending_rows`/`diff_rows` schema；选"否"时流程零变化 |
| **T3** | renderer + engine + constants | `billTypes` 多条件结构 + 引擎 AND + UI + FundType 下拉 | scenario category `offset-bill-mark`；行4/5 的 seq 引用；44 字段枚举；`preload.js` 内联副本同步 |

### 1.2 全局改动清单（文件级）

| 文件 | 改/新 | 归属 | 说明 |
|---|---|---|---|
| `scripts/run-unit-tests.js` | 改 | T1 | 解析 TAP/计数 + N/N 汇总 + 落盘 |
| `CLAUDE.md` | 改 | T1 | 删"No unit test framework"过时句 |
| `.gitignore` | 改 | T1 | 加 `logs/` |
| `src/backend/pending-db/migrations.js` | 改 | T2 | 新增 `removed_pending_rows` + `pending_removal_matches` 表（幂等）|
| `src/backend/pending-db/removed-repository.js` | 新 | T2 | 移除行 CRUD + 按月查询 |
| `src/backend/pending-import/removed-reader.js` | 新 | T2 | 解析 `移除归档Pending账单.xlsx` |
| `src/backend/pending-reconcile/removal-match.js` | 新 | T2 | missing↔移除 matchFields 配对（复用 engine 规则）|
| `src/main-process/pending-session.js` | 改 | T2 | 导入后流程 + 移除文件导入 + 对账后触发匹配 |
| `src/backend/pending-export/writer.js` | 改 | T2 | 2 张新 sheet |
| `src/renderer-pending.js` | 改 | T2 | 提醒弹窗 + 移除文件导入入口 + 结果展示 |
| `src/preload.js` | 改 | T2 | 新 IPC channel（+ T3 FundType 枚举若需）|
| `src/main.js` | 改 | T2 | 新 ipcMain.handle |
| `src/renderer-dialogs.js` | 改 | T3 | C2 多条件渲染 + 行内新增 + FundType 下拉 + 校验放开 |
| `src/main-process/scenario-engines/c2-offset-bill-mark.js` | 改 | T3 | 多条件 AND 判定 |
| `src/backend/database/scenarios-repository.js` | 改 | T3 | 读取时惰性迁移单条件→多条件 |
| `src/constants/fund-type-enum.js` | 新 | T3 | 运行时读 `assets/FundType枚举值.xlsx` + 缓存 |
| `assets/FundType枚举值.xlsx` | 新（用户提供）| T3 | 🚫 blocker |
| `scripts/smoke/*` + `scripts/integration/*` | 新/改 | 全部 | 见 §五 |

---

## 二、T1 — 单元测试运行日志

### 2.1 现状与目标
- 现状：`run-unit-tests.js:43` `spawnSync(node --test, {stdio:'inherit'})` → 仅终端、无汇总、不落盘。
- 目标：① 终端输出 `==== N/N PASS ====` + 每文件用例数/耗时；② 落盘带时间戳日志。

### 2.2 输出解析方案
- 把 `stdio:'inherit'` 改为捕获 stdout/stderr（`spawnSync(..., {encoding:'utf8'})`），同时仍实时回显（写一份到 `process.stdout` + 累积到 buffer）。
- 解析 `node --test` 的 TAP 摘要行（`# tests N` / `# pass N` / `# fail N` / `# duration_ms`），提取计数。
- 终端打印仿 `integration-runner.js` 风格：每文件一行 + 末尾 `==== {pass}/{total} PASS ====`。
- **退出码**：透传 `node --test` 退出码（保持现状真理来源不变）。

### 2.3 落盘日志（D-T1-1=a / D-T1-2=a / D-T1-3=a）
- 路径：`logs/unit-tests/unit-<YYYYMMDD-HHmmss>.log`（项目根，gitignore）。
- 内容：纯文本 = 头部元信息（时间、Node 版本、文件数）+ 完整原始输出 + 尾部汇总。
- 时间戳：用 `new Date()`（脚本是一次性 CLI，不受 workflow 限制）。
- 仅 unit；integration runner 不在本版改（D-T1-3=a）。

### 2.4 验收
`npm run test:unit` → 终端见 `N/N PASS` + 生成 `logs/unit-tests/unit-*.log`；`npm run test:unit:coverage` 仍работ；`release-check` 退出码语义不变。

---

## 三、T2 — pending 移除核对（最大篇幅）

### 3.1 数据模型（D-T2-1=上月 / D-T2-3=全列 raw_json + 索引列）

**表 1：`removed_pending_rows`**（存移除文件解析行）
```sql
CREATE TABLE IF NOT EXISTS removed_pending_rows (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  year_month    TEXT NOT NULL,          -- 关联"上月"(missing 来源月)，D-T2-1
  source_file   TEXT,                   -- 移除文件名（留痕）
  raw_json      TEXT NOT NULL,          -- 全 46 列原始数据 JSON（D-T2-3 导出展示用）
  -- 匹配索引列（matchFields 可能用到的公共字段，加速配对；值从 raw_json 提取）
  order_no      TEXT,
  recon_id      TEXT,
  金额          TEXT,
  channel       TEXT,
  merchant_id   TEXT,
  bank_ref      TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_removed_ym ON removed_pending_rows(year_month);
CREATE INDEX IF NOT EXISTS idx_removed_order ON removed_pending_rows(year_month, order_no);
CREATE INDEX IF NOT EXISTS idx_removed_recon ON removed_pending_rows(year_month, recon_id);
```
> 索引列集合 = 现有对账规则 `matchFields` 的全集候选（与 `pending_rows` 公共字段）。若 `matchFields` 配了其它公共字段，按需补索引列；非索引字段仍可从 `raw_json` 取值参与匹配（慢路径）。

**表 2：`pending_removal_matches`**（对账后匹配结果）
```sql
CREATE TABLE IF NOT EXISTS pending_removal_matches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL,      -- 关联 diff_runs.id
  diff_row_id    INTEGER NOT NULL,      -- 匹配上的 missing diff_rows.id
  removed_row_id INTEGER NOT NULL,      -- 匹配上的 removed_pending_rows.id
  match_field    TEXT,                  -- 命中哪个 matchField（留痕）
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prm_run ON pending_removal_matches(run_id);
```
- migration 幂等（`migrations.js` 现有范式），**不动** `pending_rows` / `diff_rows` / `diff_runs`。

### 3.2 移除文件解析（`removed-reader.js`）
- D-T2-4=a：取 workbook **第一个 sheet**（模板 sheet 名是数字 ID `1405800876820465666`，不可硬编码）。
- 定位表头行（第一行），按 46 列表头映射；输出 `[{raw:{列名:值,…}, order_no, recon_id, 金额, channel, merchant_id, bank_ref}]`。
- 复用 `file-service` 的 xlsx 读取 + `FileValidationError`（缺表头/空文件报错）。

### 3.3 导入后交互流程
```
renderer-pending.js 导入成功回调（约 :432，refreshPendingUi 前）
  → createConfirmDialog("是否核对移除pending数据？")
     ├─ 否：refreshPendingUi()（现状）
     └─ 是：desktopApi.pending.pickFiles() → 选移除 xlsx
            → desktopApi.pending.removed.import({ yearMonth, files })   ← 新 IPC
               main.js handle 'pending:removed:import'
                 → removed-reader 解析 → removed-repository.replaceByMonth(yearMonth, rows)
               （yearMonth = 本次导入的月份；它将作为后续对账的 upperMonth 时被用上 — D-T2-1）
```
- 新增 preload api：`pending.removed = { import: (p)=>invoke('pending:removed:import', p) }`。
- `replaceByMonth`：同月重复导入 → 先删旧再插（幂等，避免累积）。

### 3.4 missing↔移除匹配（`removal-match.js`，D-T2-2=对账后自动）
- 触发点：`engine.js` reconcile 跑完产出 diff_rows 后（或 `pending-session.js` 对账回调末尾），若 `removed_pending_rows` 存在该 `upperMonth` 数据 → 调 `matchRemoval(db, runId, upperMonth, matchFields)`。
- 算法（复用 engine 的 matchFields 多轮 fallback 语义）：
```
matchRemoval(db, runId, upperMonth, matchFields):
  missingRows = diffRepo.listDiffRows(db, runId, 'missing')   # 各含 upper_row_id → 取 pending_rows 值
  removedRows = removedRepo.listByMonth(db, upperMonth)
  matchedRemoved = Set()
  for field in matchFields:                 # 多轮，单字段相等即配对，已配对的跳过
     group removedRows(未匹配) by field 值
     for m in missingRows(未匹配):
        key = pendingRowValue(m, field)
        if key 非空 and group[key] 有未用项:
           r = group[key].shift()
           insert pending_removal_matches(runId, m.diff_row_id, r.id, field)
           标记 m、r 已匹配
  # 剩余 missing 未匹配 = "missing有_移除无"；剩余 removed 未匹配 = "移除有_missing无"
```
- ⚠️ 资金红线：与 `engine.js` 现有配对**同一套 matchFields 语义**，不另造规则；matchFields 取自 `rule-repository.getRule()`。

### 3.5 导出 2 张新 sheet（`writer.js`，D-T2-5=仅 single run）
- 仅 `exportSingleRun` 加（`exportAggregate` 本版不加）。
- 位置：现有 sheet（汇总 / 资金类型分组 / pending资金类型差异）**之后**追加 → 天然最右。
- **sheetA「missing核对移除」**（D-T2-7 待最终文案）：
  - 行 = 该 run 全部 `missing` diff 行（复用现有 `buildExportRowsForDiff` 的 missing 展开）。
  - 末尾新增 1 列 **「移除核对状态」**（D-T2-6）**三态**（手测增强）：配对成功后用对账规则 `compareFields` 做内容核对 — `核对无误`（matchFields 配上 + compareFields 全部归一化一致）/ `核对有差异：字段(missing原值≠移除原值)`（配上但 compareFields 有不一致；仅状态列文字写明；数值字段复用 C1 归一化判定、展示原始值）/ `missing有_移除无`（未配上）。
- **sheetB「移除有_missing无」**（条件：存在未匹配 removed 行才生成）：
  - 行 = `removed_pending_rows`(upperMonth) 中未出现在 `pending_removal_matches` 的行，按 `raw_json` 还原 46 列展示。
- 表头字体沿用 `applyHeaderRowFont`（Courier New 10）。

### 3.6 验收
导入选"否"→ 行为零变化；选"是"导入移除文件 → 对账后 missing 正确标记；导出最右见 sheetA（含状态列）；有未匹配 removed → 见 sheetB。

---

## 四、T3 — C2「银行对账单字段赋值」增强

### 4.1 数据结构变更（D-T3-1a=AND）
- 旧：`config.billTypes = [{seq, field, op, value}]`
- 新：`config.billTypes = [{seq, conditions:[{field, op, value}, …]}]`
- 行4 `reconFields`、行5 `markValue` 仍按 `seq` 引用，**结构不变**。

### 4.2 老数据惰性迁移（D-T3-mig=a）
- 在 `scenarios-repository.js` 读取 C2 场景 config 时归一化：
```
normalizeC2Config(cfg):
  for bt in cfg.billTypes:
     if bt.conditions === undefined:
        bt.conditions = [{ field: bt.field||'', op: bt.op||'等于', value: bt.value||'' }]
        delete bt.field/op/value     # 或保留兼容字段，写回时以 conditions 为准
  return cfg
```
- 写入（保存场景）时统一以 `conditions` 结构持久化。
- 兜底：引擎 `c2-offset-bill-mark.js` 入口也做一次同样归一化（防御旧内存对象）。

### 4.3 引擎多条件 AND 判定（`c2-offset-bill-mark.js:30-42`）
```
classifyRowsByBillTypes(bankRows, billTypes):
  for row in bankRows:
     row._c2Types = []
     for bt in billTypes:                      # bt.conditions = [{field,op,value}…]
        if bt.conditions.every(c => evaluateCondition(row, c)):   # AND 全满足
           row._c2Types.push(bt.seq)
```
- `evaluateCondition` 复用现有（单条件判定不变）；变化仅在"每类型多条件 AND 聚合"。
- 空条件处理：`conditions` 为空 → 该类型不匹配任何行（或按 spec 评审定，建议视为不命中）。

### 4.4 UI 渲染（`renderer-dialogs.js:7698-7810`，D-T3-1b=空白行 / D-T3-1c=子序号）
- `renderBillTypes` 改为**按 seq 分组**渲染：每个账单类型 = 一个分组块，块内 N 个条件行，子序号 `#{seq}.{idx+1}`。
- 每条件行控件：`[字段下拉][操作下拉][值输入/下拉] [×删除] [新增]`。
- 事件：
  - `[新增]`（新增 `data-multi-action="add-condition"`）→ 当前 seq 的 conditions 在当前行 idx 后 `splice(idx+1,0,{field:'',op:'等于',value:''})` → rerender。
  - `[×删除]` → 删该条件；若删空该类型最后一条件 → 该类型 conditions 留 1 空行（或删整类型，spec 评审定，建议保留至少占位避免 seq 空洞）。
  - 顶部"+新增账单类型"（:7806）不变 → push `{seq, conditions:[{field:'',op:'等于',value:''}]}`。
- 删类型重排 seq 的逻辑（:7792-7804）保留，行4/5 引用校正不变。

### 4.5 FundType 值下拉（`fund-type-enum.js`，D-T3-2-src=xlsx / scope=b / strict=a）
- `src/constants/fund-type-enum.js`：`loadFundTypeEnum()` 读 `assets/FundType枚举值.xlsx` 第一个 sheet → 返回**有序**枚举数组（保持表内顺序）；模块级缓存。
- 暴露给 renderer：经 `preload.js`（或 main IPC `scenario:fund-type-enum`）注入；renderer 渲染条件行 value 时：
  - `if (condition.field === 'FundType')` → 渲染 `<select>`（options = 枚举，**strict 仅枚举值**，D-T3-2-strict=a）。
  - 作用范围（D-T3-2-scope=b）：账单类型**条件行 value** + **赋值行 markValue.value**（:7750）都套用此规则。
- **降级**：`FundType枚举值.xlsx` 缺失/读取失败 → value 回退文本输入 + 一次性 UI 提示"未找到 FundType 枚举文件，暂用手输"。（保证 blocker 未解时其余功能可用）

### 4.6 对账字段可空（D-T3-3，`renderer-dialogs.js:6816-6818`）
- 放开 C2 校验：允许 `reconFields` 为 0 行 / 允许某行 `leftField`/`rightField` 留空（留空行视为未配置，引擎按"衍生方案A无条件赋值"走，引擎已支持 `reconFields=0`）。
- 删除按钮门槛（:7734 `length===1` 不显示 / :7829 `length>1` 才删）放开到允许删到 0。

### 4.7 验收
老 C2 场景正常打开（迁移）；可加多条件 AND；行内新增插空白条件；FundType 字段值为下拉（文件就位后）；对账字段可空保存不报错；`preview:scenario-config-c2` 回归。

---

## 五、测试矩阵

### 5.1 unit（`tests/unit/`，`node:test`）
| 用例组 | 覆盖 | 归属 |
|---|---|---|
| `run-unit-tests` 输出解析 | TAP 摘要 → N/N 计数（多档：全 pass / 有 fail / 0 测试）| T1 |
| `removed-reader` | 46 列表头解析 / 缺表头报错 / 数字 sheet 名 | T2 |
| `removal-match` | 多轮 fallback 配对 / missing有移除无 / 移除有missing无 / 空 matchFields | T2 |
| `c2 classify AND` | 多条件全满足命中 / 任一不满足不命中 / 单条件兼容 / 空条件 | T3 |
| `normalizeC2Config` | 旧单条件→conditions / 已是新结构幂等 | T3 |
| `fund-type-enum` | 读 xlsx 顺序 / 文件缺失降级 | T3 |

### 5.2 integration（`scripts/integration/`，硬约束 `N/N PASS`）
| 脚本 | 覆盖 |
|---|---|
| `pending-removal-reconcile.js`（新）| 导入月→导入移除→对账→匹配→导出 2 sheet 端到端契约（列结构/sheet 顺序/状态列值）|
| `c2-multi-condition-assign.js`（新）| C2 多条件 AND 分类 + 赋值结果 byte 级 + 老场景迁移 |

### 5.3 smoke（`scripts/smoke/`）
- pending 模块 smoke 增补移除核对路径；scenario C2 smoke 增补多条件。

### 5.4 preview 回归
- `npm run preview:scenario-config-c2`（必跑）+ 相关 C2 preview；pending 面板 preview 如交互变化同步。

---

## 六、兼容性 & 破坏性变更

### 6.1 破坏性
- **无对外破坏性变更**。C2 config 结构变更通过惰性迁移向后兼容（旧场景自动升级）。

### 6.2 兼容性
- T2 新表为增量，老库升级走幂等 migration；选"否"路径与旧版完全一致。
- T1 仅改脚本输出/落盘，不影响产物。
- `preload.js` 内联 `BANK_STATEMENT_FIELDS` 副本如涉及需同步（T3 若动字段枚举）。

---

## 七、风险红线总结（CLAUDE.md 规则 7）

| 项 | 级别 | 护栏 |
|---|---|---|
| T2 missing↔移除匹配正确性 | 🔴 | 复用 matchFields 语义；unit 多档；integration 端到端 |
| T2 新表 migration | 🔴 | 幂等；不动现有表；migration smoke |
| T2 导出契约变更 | 🟡 | integration 校验列/顺序 |
| T3.1 多条件分类→赋错值 | 🔴 | 引擎 unit AND 多档 + 迁移 contract |
| T3 config 结构变更 | 🟡 | 惰性迁移 + 引擎入口兜底归一化 |
| 重要变量 | 🟡 | 实现阶段 `/check-vars`（命中 scenario/engine 概率高）|

---

## 八、spec 评审 checklist（dev 启动前）

- [ ] T2 表名/字段与现有 `pending-db` 命名风格一致（确认 `pending_rows` 实际列命名后微调索引列）
- [ ] `matchFields` 实际默认值确认（决定索引列集合）
- [ ] C2 删空类型最后条件的兜底行为定稿（保留占位 vs 删类型）
- [ ] FundType 下拉降级文案定稿
- [ ] D-T2-6/D-T2-7 中文文案最终确认（状态列值 / 2 个 sheet 名）
- [ ] 新增 integration 脚本命名符合 `rules/integration-test-policy.md §二`
