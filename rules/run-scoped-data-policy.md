# 对账 run 级数据存储约定（run-scoped data policy）

> 版本：v2（2026-07-10 v3.0.14 新增前置资金对账接入约定）
> 关联：`changes/size-startup-optimization/spec.md`（Part B）/ `rules/important-variables.md`（per-月侧库体系条目）/ `src/backend/run-data-store.js`
> 适用：所有「对账类模块」的 run 级批量数据存储决策。本规则为**长期硬约束**，新模块接入与既有模块改动都必须遵守。

## 一、为什么有这条规则（背景）

历史上三个对账模块（收单单据币种校验 / 业务OP数据核对 / 月度银行对账单BU回填校验）把 run 级批量数据（imports / flow / bill / diff_rows）写主库 `tool-data.sqlite`，run 后 DELETE。SQLite 文件**永不收缩** → 删除空洞累积。本机主库实测 15GB，其中 ~9.86GB（61%）为删除空洞；启动期孤儿清理曾单次删 461 万行（阻塞主进程 + 升级首启 28~38 秒）。

根因：**run 级批量数据不该进主库**。主库只应存「轻量、长期、稳态」数据（模板 / 设置 / 映射 / runs 元数据）。

## 二、硬约束（禁止行为）

1. 🔴 **对账类模块的 run 级批量数据禁止写主库。** 必须走 per-生命周期键侧库文件 `{userData}/run-data/{module}/{生命周期键}.sqlite`。
   - run 级批量数据 = 单次导入/对账产生的、run 后即可整批回收的大表行（imports / flow_imports / bill_imports / diff_rows）。
   - 反例（禁止）：新对账模块直接 `INSERT INTO 主库表` 落百万行 imports，run 后 `DELETE`。
2. 🔴 **主库只保留 runs 元数据镜像行**（轻量：summary + status + 路径 + `side_db_rel_path`）。UI 列表 / 导出下拉 / run 历史读主库镜像。
3. 🔴 **对账算法零改动**：算法函数（`runCheckCore` / `runReconciliation` / 4 步算法 / diff JOIN / epsilon）在「侧库 db 句柄」上运行 = 在主库上运行（同库自洽）。**不得为侧库化改写算法 SQL/语义**——只换 db 句柄/dbPath。parity 锁强制 byte-for-byte。
4. 🔴 **侧库 DDL 必须有单一真相**：既有模块若由主库 schema 平移而来，`run-data-store.js` 的 `SIDE_DB_DDL_*` 必须与主库 `ensure*TablesSupport` 对应表/索引 byte-for-byte 一致。新模块若从未在主库建立 bulk 表，则侧库 DDL 直接以 `run-data-store.js` 为唯一真相，主库只建结构不同的轻量 run 镜像表，不得复制 bulk schema。

## 三、侧库管理器约定（run-data-store.js）

唯一侧库入口是 `src/backend/run-data-store.js`，提供 module-agnostic 能力：

| 能力 | 函数 | 约定 |
|---|---|---|
| 模块白名单 | `KNOWN_MODULES` / `MODULE_*` | 新模块接入须加常量 + 进白名单（`assertModule` 防误用） |
| 路径解析 | `sideDbPath` / `sideDbRelPath` / `sideDbFileName` | 文件名固定 `month-{key}.sqlite` 形态（`MONTH_KEY_RE` 防路径注入）；rel 存主库元数据列（跨机/迁移目录解耦） |
| 建/开 | `openSideDb`（建表+PRAGMA） / `openExistingSideDb`（只读路径，不存在抛错） | PRAGMA 清单 `SIDE_DB_PRAGMA_STATEMENTS` 主进程直连用；worker 直连走 worker 既有清单（值一致） |
| 删 | `deleteSideDb` / `deleteSideDbByPath` | 连带删 -wal/-shm 旁文件；幂等 |
| 扫描 | `listSideDbFiles` | 孤儿扫描用；跳过非法名 + 旁文件 |
| DDL | `SIDE_DB_DDL_*` / `MODULE_DDL` | byte-for-byte 平移主库（见硬约束 4） |

**每个模块一个编排层** `src/main-process/{module}-run-data.js`，职责：
- 写路径：import 落侧库 / run 路由侧库（acquiring 经 worker pool dispatch `__dbPath`=侧库；biz-op/bank-bu inline 直跑）。
- 主库镜像：`upsertMainRunMirror`（月级/(date,BU)级覆盖，返回 mirrorId = **对外 runId 真值**；侧库内 run id 仅内部用）。
- 双源读（过渡期）：side_db_rel_path 非空读侧库、NULL 读主库旧表。
- retention 文件级：删整生命周期 = 删文件（原子、零碎片、零 VACUUM、零百万行 DELETE）。
- 孤儿双向兜底：`reconcileOrphans`（以侧库文件存在性为准）。

## 四、生命周期键裁定准则（侧库文件键 = 该模块批量数据的生命周期键）

通则：**侧库文件键 = 该模块批量数据被「整批回收」的最小生命周期单元**。

| 模块 | 生命周期键 | 依据 |
|---|---|---|
| 收单单据币种校验 acquiring | **month**（`month_key`） | imports `UNIQUE(month_key, recon_main_id)` 按月持久化；import/run 独立 handler；一次导入多次 run 复用；`clearRunsByMonth` 按月清旧；对账 JOIN 要求 flow+bill+diff 同库 |
| 业务OP数据核对 biz-op | **month**（`month(data_date)`） | imports 按 date 分片但数据量小；同月多 date 同库；对账要求 T-1/T-2/flow 同库 → per-month 单库自洽（免 ATTACH）；🔴 月初 T-2 跨月由月末冗余副本画清边界 |
| 月度银行对账单BU回填校验 bank-bu | **month**（`year_month`） | 三表 `importMonthAtomic` 原子覆盖，与 acquiring 同构 |
| 前置资金对账 pre-fund-reconciliation | **month + 双生命周期模块** | `pre-fund-reconciliation` 按账单月持久保存临时 MPT，手工删完批次即可删月文件；`pre-fund-reconciliation-results` 按运行月保存最后一次候选池/结果，主库镜像保存精确 `side_db_rel_path + side_run_id`，新 run/重启整文件回收旧结果。两者分离，禁止把可丢弃结果写进需跨重启保留的 MPT 月库 |

裁定步骤（新模块）：
1. 找该模块「重导/覆盖」的清理粒度（clearByXxx 的 Xxx）——通常即生命周期键。
2. 确认对账算法所需的所有表（imports/flow/diff）在同一生命周期键内自洽（同库 JOIN/getRowById）。
3. 若对账需跨生命周期键取数（如 biz-op 月初 T-2 跨月）→ **画清边界**：要么冗余副本到目标库（biz-op 方案），要么编排层多库读后注入算法（不改算法签名）。务必在 parity 脚本加跨边界用例。

## 五、新对账模块接入 checklist

新增对账类模块（产生 run 级批量数据）时，PM/Dev 必须：

- [ ] 生命周期键裁定（§四）+ 在 spec 写明依据。
- [ ] `run-data-store.js`：加 `MODULE_XXX` 常量 + 进 `KNOWN_MODULES` + `SIDE_DB_DDL_XXX`（byte-for-byte 平移主库 `ensure*TablesSupport`）+ `MODULE_DDL` 映射。
- [ ] 主库 runs 表或专用轻量镜像表保存 `side_db_rel_path`（`ensureXxxSupport` 幂等建表/加列 + database.js init 接入）。
- [ ] 新建明确的模块编排层（可为 `src/main-process/{module}-run-data.js`，或模块目录下唯一 service），负责 import 落侧库 / run 路由 / 主库镜像 mirrorId / 生命周期清理 / 孤儿状态处理；存在历史主库 bulk 数据时才需要双源读。
- [ ] main.js handler 全改调编排层；whenReady 孤儿兜底扩本模块。
- [ ] 🔴 parity 集成脚本 `scripts/integration/{module}-side-db-parity.js`：侧库路径和生命周期、幂等/替换/回滚、主库 bulk 表恒 0 行（若从未建 bulk 表则验证主库业务表不受影响）+ 跨生命周期边界用例。
- [ ] 单测覆盖编排层（双源/孤儿/生命周期边界/runId 映射）+ run-data-store DDL 断言。
- [ ] 升格 `rules/important-variables.md` per-月侧库体系条目（加本模块符号）。

## 六、发版 checklist（启动指标）

版本号 bump / 合并前，除 `npm run release-check` + `/check-vars` + `npm run scan:vars` 外，对账侧库相关改动还须确认：

- [ ] 四个已接入模块 parity 脚本全绿（`acquiring-side-db-parity` / `biz-op-recon-side-db-parity` / `bank-bu-recon-side-db-parity` / `pre-fund-reconciliation-side-db-parity`）。
- [ ] `npm run startup:measure` 启动指标不退化（建窗 ≤300ms / 日常基线 ≤1.5s / 升级首启 ≤3s）。
- [ ] 跑一次大数据量 run → 主库增量 < 10MB（run 级数据未落主库）；删整生命周期 → `run-data/` 文件消失、磁盘即时回收。
- [ ] activity log「启动耗时」基线对比（升级首启不退化）。

## 七、过渡与收口（双源移除）

- B-D2 双源过渡：v3.0.5 三模块新 run 走侧库、历史主库 run 原地保留、读路径先侧库后主库。
- 收口（顺延 v3.0.5 之后版本）：确认历史主库 run 已迁清后，移除编排层双源分支 + 删主库旧 imports/diff 表数据 + 二次 VACUUM 收口主库到 MB 级。移除前必须确认无历史 side_db_rel_path=NULL 的 success run 仍被用户依赖（差异表重导出）。
