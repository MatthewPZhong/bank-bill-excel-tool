# size-startup-optimization Phase 2/3/4 实施 spec（dev worktree，基于 bb036eb）

> status: in-progress（dev 实施 spec，细化自父 spec §B.4 Phase 2/3/4 + §B.9 B-D1~D8）
> owner: dev（worktree agent-a2a13491efcb8e7ad）
> base: bb036eb（已含 PR-1 PartA / PR-2 Phase0 / PR-3 Phase1）
> 目标版本：v3.0.5

本 spec 只覆盖 dev 本轮任务：Phase 2（PR-4）biz-op + bank-bu 侧库 / Phase 3（PR-5）启动窗口先行 / Phase 4（PR-6）守卫固化。
父 spec `changes/size-startup-optimization/spec.md` 为真理来源；本文件细化实施决策，冲突以父 spec + 任务 brief 为准。

---

## 共同硬约束（贯穿三 Phase）

- 🔴 不改任何对账算法语义：biz-op `runReconciliation`/4 步算法、bank-bu `runReconciliation`/4 路分类、acquiring `runCheckCore` 零改动；parity 锁。
- 🔴 侧库 DDL byte-for-byte 平移主库（biz-op = `biz-op-recon-db/migrations.js`；bank-bu = `database/migrations.js:2410-2529`）。
- 不碰 r5 引擎 / refund 文件（其他轨道）。
- 中文注释；不 push。
- 每 Phase 后 `npm run release-check` 全绿 + 新 parity 脚本。

---

## Phase 2（PR-4）— biz-op + bank-bu 推广侧库

### 2.1 生命周期键裁定（已定，任务 brief）

| 模块 | 生命周期键 | 侧库文件 | 依据 |
|---|---|---|---|
| bank-bu | per-month（`year_month`） | `month-{YYYY-MM}.sqlite` | 三表 `importMonthAtomic` 原子覆盖，与 acquiring 同构 |
| biz-op | per-month（数据量小，单库自洽免 ATTACH） | `month-{YYYY-MM}.sqlite` | imports 按 date 分片但量小；同月多 date 同库；JOIN/getRowById 要求 diff+imports 同库 |

### 2.2 run-data-store.js（侧库管理器扩 2 模块）

- `KNOWN_MODULES` 加 `MODULE_BIZ_OP='biz-op-recon'` / `MODULE_BANK_BU='bank-bu-recon'`。
- `SIDE_DB_DDL_BIZ_OP`：byte-for-byte 平移 `biz-op-recon-db/migrations.js` 的 4 表 + 7 索引。含 `t2_anomaly_account_count`（建表即含，不需 ALTER 分支）。diff_rows FK 引用 runs(id)（主库无 CASCADE，侧库也不加——byte-for-byte；删整月=删文件无需级联）。
- `SIDE_DB_DDL_BANK_BU`：byte-for-byte 平移 `database/migrations.js:2410-2529` 的 3 表 + 5 索引。bank-bu 无 diff_rows 表（diff 实时算不落库）。
- `MODULE_DDL` 加两条；其余 helper 已 module-agnostic。

### 2.3 编排层（新建 2 文件，仿 acquiring-bill-currency-run-data.js）

**`src/main-process/bank-bu-recon-run-data.js`**：
- `importMonth`：open 侧库 → `monthRepository.importMonthAtomic(sideDb, ...)`；import 不写主库镜像（镜像在 run 成功后写）。
- `runViaSideDb`：inline 直跑 → open 侧库 → `runReconciliation(sideDb, ym)` → 侧库 insertRun 拿 runId → 主库镜像 upsert（side_db_rel_path + summary + status + run_at）。`lastRunCache` 侧库化失效 → export 走重跑路径。
- 双源读：`listMonthsDualSource` / `getStatusDualSource` / `listReadyMonthsDualSource` / `listSuccessMonthsDualSource`。
- `loadExportDataByRun`：主库镜像 → open 侧库 → 重跑 `runReconciliation` 拿 matched/buDiff/nmAnomalies。
- `aggregateExportData`：逐月 open 侧库重跑汇总。
- `deleteMonthSideDb` / `reconcileOrphans`：仿 acquiring（module=bank-bu）。

**`src/main-process/biz-op-recon-run-data.js`**：
- monthKey = `date.slice(0,7)`。
- `runBizOpImport`：worker 路径传侧库 dbPath（worker `ensureBizOpReconTablesSupport` 幂等建侧库表）。
  - 🔴 月末跨月写边界：worker D/D+1 清只在当月侧库；月末（month(D)≠month(D+1)）时编排层 import 成功后 open 下月侧库补清 `clearRunsAndDiffsByDateBu(nextSide, addOneDay(date), firstBu)`。firstBu 取 worker complete.buName。
- `runFlowImport`：worker/engine 传侧库 dbPath。flow 按 date 清，无跨月。
- `runViaSideDb`：inline 直跑。月初跨月读边界见 §2.4。
- 双源：status/bu:list/check-single-day/list-ready-dates/list-success-dates/run:history（遍历侧库 + 主库镜像）。

### 2.4 biz-op 月初 T-2 跨月：冗余副本方案（最终采纳，画清边界）

biz-op 对账要 T-1(date)+T-2(date-1) 同库。per-month 下仅**月初第一天** T-2 跨月。采纳「月末 D 冗余副本到 D+1 月侧库」：

- 导入 D：落 month(D) 侧库（D 作为 D 当日 T-1）。若 D 是月末（D+1 跨月）→ **额外落 month(D+1) 侧库**一份 (D,BU) 行（作 D+1 对账的 T-2 基线）。
- 跑对账 date（月初）：month(date) 侧库已含 T-2 冗余副本 → `runReconciliation(curSide, {date,buName})` 单库自洽，**算法零改动**。diff source_row_id 指向 month(date) 侧库行 → 导出 `getRowById` 命中 byte-for-byte。
- 清旧一致：
  - 重导 D（月末）：clear month(D) 的 (D,BU)+(D+1,BU)；跨月时 clear month(D+1) 的 (D,BU)[旧副本]+(D+1,BU) → 重落两库刷新副本。
  - 重导 D+1（次月月初）：clear month(D+1) 的 (D+1,BU)+(D+2,BU)；**不清 (D,BU) 副本**（D 副本是 D+1 的 T-2）→ 副本保留。
- listImportedDateBuPairs 双源去重（Set by `date|bu`，副本与原件同键去重）。
- flow 落 month(date) 侧库，无冗余无跨月。
- listReadyDates(bu)：遍历该 bu 所有月侧库逐月跑（每库 T-1/T-2 含副本自洽）合并。listSuccessDates(bu)：主库镜像（按 (date,BU) 存）跨月查。

代价 = 月末 D 数据两库各一份（量小可接受）。月初/月末边界均画清。

### 2.5 main.js 改造

- require 加 `bizOpReconRunData` / `bankBuReconRunData`。
- bank-bu handlers（~10689-10879）：months:list / status / import:run / run / export:single / export:aggregate / run:history / list-ready-months / list-success-months 全改调侧库编排。
- biz-op handlers（~10887-11149）：import:run-biz-op / import:run-flow / run / status / bu:list / check-single-day / list-ready-dates / list-success-dates / export:date / export:date-range / run:history 全改调侧库编排。
- whenReady 孤儿兜底（~12771）：扩 biz-op + bank-bu 各一段 reconcileOrphans。

### 2.6 migrations（主库 runs 加 side_db_rel_path）

- `bank_bu_recon_runs` 加 `side_db_rel_path TEXT`（`ensureBankBuReconRunsSideDbPath`）。
- `biz_op_recon_runs` 加 `side_db_rel_path TEXT`（`ensureBizOpReconRunsSideDbPath`）。
- exports + database.js init 序列（各自 ensure*TablesSupport 之后）。

### 2.7 parity 锁 + 测试

- `scripts/integration/bank-bu-recon-side-db-parity.js`：多 BU/1:1/1:N/N:1/N:M/buDiff fixture → 改造前 in-process golden vs 改造后侧库编排 → 导出 sheet byte-for-byte + 主库 3 表恒 0 行 + 冻结 golden.json。
- `scripts/integration/biz-op-recon-side-db-parity.js`：必含 D/D+1 跨日清 + T-2 NaN silent drop + 月初 T-2 跨月 + 月末 D+1 跨月补清 → diff_rows 逐行 + 导出 xlsx 数据 sheet byte-for-byte + 主库 4 表恒 0 行 + 冻结 golden.json。
- 单测：`biz-op-recon-run-data.test.js` / `bank-bu-recon-run-data.test.js`（孤儿 + 双源 + 跨月 + retention）+ `run-data-store.test.js` 扩 DDL 断言。

---

## Phase 3（PR-5）— 启动窗口先行

### 3.1 新时序（方案①）

whenReady → initializeActivityLog + usage-stats（轻量）→ **立即 createWindow(loading 态) + register*Handlers（上移）** → 后台 init 链 → `send('app:init-done')`。
- register*Handlers 上移：handler 体惰性引用 database，注册时不解引用（已核实）。
- `app:get-info` 两段式：init 未完（database null）→ `{ initPending:true, version }`；init-done 后 renderer 重 getInfo 拿全量。
- renderer initialize() 拆轻量骨架（init 前）+ 数据填充（init-done 后，`onInitDone` 回调重 getInfo）。preload 加 `app.onInitDone(cb)`。

### 3.2 回退开关（B-D5）

`DEFERRED_WINDOW_STARTUP` env：`=0` 旧时序（init 完再建窗）；默认新时序。旧时序完整可达，稳定一版后移除。

### 3.3 B-D6 loading VACUUM 文案

VACUUM 前 main `send('app:init-progress', { phase:'vacuum', text })`，renderer loading 态显示「正在优化数据库，首次约 X 分钟，请勿关闭程序」。

### 3.4 验收

`npm run startup:measure`（升级首启≤3s/日常≤1.5s/建窗≤300ms）+ 回退开关来回切无残留 + 重跑 preview。

---

## Phase 4（PR-6）— 守卫固化

- 新建 `rules/run-scoped-data-policy.md`：对账 run 级数据禁写主库 + 侧库管理器约定 + 新模块接入 checklist + 生命周期键裁定准则。
- `rules/important-variables.md` 升格侧库符号 + 更新 §B.5.3 预命中旧条目。
- `npm run scan:vars`。

---

## 交付（worktree 内分阶段 commit）

- `[size-startup] Phase2 biz-op/bank-bu侧库` / `[size-startup] Phase3 启动窗口先行` / `[size-startup] Phase4 守卫固化`
- 报告：各 commit hash + git diff --stat + parity 结果 + release-check + startup:measure + biz-op per-month 月末/月初跨月边界处理说明。
