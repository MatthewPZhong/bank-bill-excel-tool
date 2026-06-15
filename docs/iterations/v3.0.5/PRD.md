# PRD - 网银账单小助手 v3.0.5（体积与启动性能优化：打包瘦身 + 主库膨胀治理 + 启动窗口先行）

| 项目 | 内容 |
|------|------|
| 版本 | v3.0.5 |
| 日期 | 2026-06-12 |
| 作者 | PM |
| 状态 | 初稿 |
| 模块 | 打包配置 · 备份治理 · 主库膨胀治理（acquiring / biz-op-recon / bank-bu-recon 三对账模块）· 应用启动时序 |
| 依赖 | 开发分支 `v3.0.5`（已切出）；目标版本 3.0.5 |

> **来源 spec（唯一事实源）**：`changes/size-startup-optimization/spec.md`（status=approved，11 个拍板点全部拍板收口，2026-06-12；Part A 3 个 §A.9、Part B 8 个 §B.9）。
>
> 本 PRD 以上述 spec 为唯一事实源，所有标 ✅ 拍板的结论原样转述，不自行发明语义。
>
> **代码现状（第三章）file:line 出处直接转录自 spec §A.2 / §B.2，行号为 2026-06-10 快照，实施时以代码为准。**

---

## 一、需求概述

本次迭代聚焦「体积与启动性能」一个主题，分两部分共 **5 个 PR 串行**（✅ B-D7 拍板：Part A + Part B 四个 Phase 全部落 v3.0.5，不切 v3.1.0）：

1. **PR-1 · Part A 打包瘦身** —— `build.files` 改白名单（防复发核心）+ `@napi-rs/canvas` 移 devDependencies + 新增 `check-dist-size.js` 守卫（asar ≤25MB）+ CHANGELOG/README 排除出包。纯打包配置，零业务代码改动、零运行时行为变化。
2. **PR-2 · Part B Phase 0 备份治理 + 一次性 VACUUM** —— `backups/` 保留最近 2 份（旧格式 `bak-*` 纳入同策略，启动后台清理逐文件记 activity log）+ 一次性 VACUUM 主库（迁移式 app_settings 标志位幂等 + UI 状态框提示「正在优化数据库」）。⚠️ 删用户数据动作。
3. **PR-3 · Part B Phase 1 acquiring run 级数据迁出侧库** —— acquiring 批量三表迁出 per-month 侧库 `{userData}/run-data/acquiring-bill-currency/month-{YYYY-MM}.sqlite`（B-D1/B-D3，2026-06-12 实施期由 per-run 修正为 per-month）；历史数据双源过渡（B-D2）；retention 文件级二态（B-D4）；差异表 xlsx byte-for-byte parity 锁定。
4. **PR-4 · Part B Phase 2 推广同模式** —— biz-op-recon + bank-bu-recon 套用 Phase 1 样板迁出侧库（防主库从其余模块缓慢复发）。
5. **PR-5 · Part B Phase 3 启动窗口先行 + Phase 4 守卫固化** —— `whenReady` 立即建窗 + loading 态 + init-done 门控 + 回退开关（B-D5）；新增 `rules/run-scoped-data-policy.md` + important-variables 升格 + 发版 checklist 启动指标项。

> 集成形态：5 个 PR 串行（PR-1 已在本分支并行实施中，PRD 照 spec 终态写）；commit 前缀 `[v3.0.5]`。
> 性质：Part A 纯配置低风险；Part B 为本项目最高风险等级（🔴 资金红线 + DB 迁移 + 启动时序），每阶段 PR 前必跑 `/check-vars`，走 PM PRD → spec 细化 → dev → 用户手测循环。

---

## 二、背景与目标

### 2.1 背景

来源：2026-06-10 性能/体积调研（`knowledge/backlog.md` B6 / B7），用户报告「打包后体积越来越大、点击后页面显示越来越慢」。

| PR | 为什么要做 | 用户 / 业务价值 | 当前问题（均有实测出处） |
|----|-----------|----------------|----------|
| PR-1 (Part A) | v3.0.0 安装包实测 **135MB**（`dist/清结算小助手-3.0.0-setup.exe`）；Electron 运行时固定约 70MB，剩余膨胀全部来自 **app.asar = 101MB**（同类应用正常 ~15MB）。根因：`build.files` 宽 glob 把开发文档/测试脚本打进包 + 开发工具依赖误入 `dependencies`。 | 安装包/asar 显著瘦身；白名单封死复发通道，新增文件默认不进包。 | `docs/**/*` 42MB（仅 USER_GUIDE 172KB 需要）+ `@napi-rs/canvas` 25MB（src 零引用）+ `scripts/**/*` 2MB 测试脚本被全量打包。 |
| PR-2 (Phase 0) | 备份失控：`backups/` **31GB** + 根目录 `tool-data.sqlite.bak-20260608` **15GB**，无保留策略；主库 15GB 中 **9.86GB（61%）为删除后未回收空洞**（`freelist_count`=2,407,169 页）。全代码无空间回收机制（VACUUM 仅出现在备份 `VACUUM INTO`）。 | backups 有界；一次性回收旧空洞（预期 15GB→~6GB），磁盘即时减负。 | 备份无数量上限；主库永不收缩。 |
| PR-3 (Phase 1) | 三对账模块把 run 级批量数据写主库 → run 后 DELETE → 文件永不收缩。acquiring 是最大头：`acquiring_bill_currency_diff_rows` 历史写入 **20,769,352** 行、`acquiring_bill_currency_bill_imports` **18,462,096** 行。 | acquiring 批量数据迁出主库，删整月 = 删文件（原子、零碎片、无 VACUUM、不再有百万行 DELETE 阻塞主进程）、删单 run = 文件内 diff 行级。 | 启动期孤儿清理曾单次删 **4,615,524 行**（activity log 16:42 段）；DatabaseSync 同步 API 使批量 DELETE 阻塞所有 IPC。 |
| PR-4 (Phase 2) | 只做 acquiring 不够——主库会从其余模块缓慢复发（`biz_op_recon_imports` 已 1,667,366 行，`linked_bank_deposit` 1,315,783 行）。 | biz-op-recon + bank-bu-recon 同步迁出，根除复发通道。 | 其余两模块仍写主库。 |
| PR-5 (Phase 3+4) | 进程启动到可见基线 **1.2~1.5s**，版本升级首启 **28530ms**（v2.1.8 N5 迁移）/ **38126ms**（N4-cont-2 迁移 2,596,169 行+备份），全部消耗在 `createWindow()` **之前**；渲染层初始化 ~50ms、建窗到可见 ~110ms → **前端不是瓶颈**。 | 窗口显示与 DB init 解耦，点击到窗口可见 ≤300ms（loading 态）；防复发约定固化进 `rules/`。 | 窗口被压在初始化队尾；无任何防复发护栏。 |

### 2.2 目标（必做）

- **PR-1 (Part A)**（量化见 §A.8）：
  1. `build.files` 改白名单（防复发核心：新增文件默认不进包）；
  2. `@napi-rs/canvas` → `devDependencies`；
  3. 新增 `scripts/check-dist-size.js`（asar ≤25MB + 禁止/必须路径断言），挂进 `dist:win*` 链尾；
  4. 排除 `assets/app-icon-source.png`、`CHANGELOG.md`、`README.md` 出包。
- **PR-2 (Phase 0)**：`backups/` 保留最近 2 份（mtime 排序，旧格式 `bak-*` 纳入同策略，启动后台清理逐文件记 activity log）+ 一次性 VACUUM 主库（迁移式 app_settings 标志位幂等 + UI 状态框提示「正在优化数据库，首次约 X 分钟」）。
- **PR-3 (Phase 1)**：acquiring 批量三表（`bill_imports`/`flow_imports`/`diff_rows`）迁出 per-month 侧库（生命周期键 = month，2026-06-12 实施期修正）；`runs` 元数据留主库；历史数据双源过渡（读路径先侧库后主库）；retention 文件级二态；差异表 xlsx byte-for-byte parity 锁定。
- **PR-4 (Phase 2)**：biz-op-recon（`biz_op_recon_{imports,flow_imports,diff_rows,runs}`）+ bank-bu-recon（`bank_bu_recon_{bank_imports,pending_imports,runs}`）套用 Phase 1 样板。
- **PR-5 (Phase 3+4)**：`whenReady` 立即建窗 + loading 态 + `app:init-done` 门控 + 回退开关；新增 `rules/run-scoped-data-policy.md` + important-variables 升格 + 发版 checklist 增启动指标确认项。
- **收尾**：版本 bump 3.0.5 + 文档三件套（CHANGELOG / VERSION_FEATURE_HISTORY / USER_GUIDE）+ `npm run scan:vars` + `/check-vars` 硬节点 + `npm run release-check` 全绿。

### 2.3 明确不做（非目标）

- **Part A**：不做 `xlsx` 与 `xlsx-js-style` 合一（再 −13MB 原始，涉及 8 个 src 文件 + 全模块读写回归，风险量级不同，后续独立 PR）；不动 `exceljs`；不动 `fonts/`（v2.1.13 E2 功能性方案）；不删仓库里任何文件（`app-icon-source.png` 仅出包不删源）；不改任何 src 代码。
- **Part B**：不改任何对账算法语义——`runCheckCore` 5 阶段、diff JOIN SQL、epsilon、清算字段取值等零改动，parity 断言锁定（§B.8.1）；不治理 `tool-data-pending.sqlite`（1.5GB，Pending 模块，独立生命周期月度归档，列为观察项）。
- **双源移除 + 二次 VACUUM 收口**（B-D2）：顺延至 v3.0.5 **之后的下一个版本**，本迭代仅做双源过渡。

---

## 三、代码现状（必须有出处）

> 行号为 2026-06-10 快照，实施时以代码为准。出处转录自 spec §A.2 / §B.2。

| PR | 相关文件 | 当前行为 | 已知限制 |
|------|---------|---------|---------|
| PR-1 | `package.json:118-128`（build.files） | 宽 glob 白名单：`assets/**/*`、`src/**/*`、`scripts/**/*`、`docs/**/*`、`CHANGELOG.md`、`README.md` 等全量进包。 | electron-builder 自动打包全部 `dependencies`（devDependencies 不打包）；`docs/**/*` 42MB、`scripts/**/*` 2MB、`@napi-rs/canvas` 25MB 全部进 asar。 |
| PR-1 | `package.json` dependencies（`@napi-rs/canvas`） | 全 repo grep：canvas 仅 `scripts/render-*.js` 预览工具链使用，src 零引用。 | 误入 `dependencies` → electron-builder 全量打包 25MB。`dependencies` 唯一出包方式是移 `devDependencies`。 |
| PR-1 | `src/main.js:4212`（`userGuidePath`）/ `:4220-4222`（marked 渲染）/ `:388`（`APP_ICON_FILE_NAMES`）/ `:342`（`BUNDLED_ENUM_FILE_NAME`） | 运行时仅读取 `docs/USER_GUIDE.md`（172KB）；窗口图标引用 `['app-icon.ico','app-icon.png']`，`app-icon-source.png` 仅 `scripts/sync-app-icon.js` 输入源。 | 白名单漏列运行时文件 → 打包版缺文件（开发态 `npm start` 不受影响，难在开发期发现）。缓解 = check-dist-size「必须存在」反向断言。 |
| PR-2 | `src/backend/database/backup.js`（`createBackupFn`，SR-backup-1，`VACUUM INTO`）→ `{userData}/backups/` | 一次性迁移触发备份，**无数量上限**；根目录 `tool-data.sqlite.bak-*` 旧格式同样无策略。 | backups/ 31GB + 根目录 .bak 15GB 失控。 |
| PR-2 | 全代码 grep | VACUUM 仅出现在备份 `VACUUM INTO`，无 `auto_vacuum` / `incremental_vacuum`。 | 主库删除空洞永不回收（9.86GB / 61%）。 |
| PR-3/4 | 写入：`src/backend/acquiring-bill-currency-db/import-repository.js`（`insertFlowRow`/`insertBillRow`）、`run-repository.js`（`insertDiffRowsByJoin` chunked）；编排 `src/main-process/acquiring-bill-currency-session.js`（`runCheckCore` 5 阶段）+ `run-check-worker.js`（worker 独立 DB 连接 + PRAGMA 6 条清单）。biz-op-recon / bank-bu-recon 同模式（`src/backend/biz-op-recon-db/*`、`bank_bu_recon_*` 表）。 | run 级批量数据写主库 → run 后 DELETE。 | 文件永不收缩；run 后空洞累积。 |
| PR-3/4 | 清理：`cleanupAfterRunBackground`（50000 行/批 + setImmediate）、`setupIdleCleanupTimer`（idle 30min，`main.js:10620` 附近）、`cleanupOrphanData`（启动期 setImmediate，`main.js:12365` 附近）、`clearStaleSuccessfulRawJson`（raw_json retention） | 批量 DELETE 清理。 | `node:sqlite` DatabaseSync 是**同步 API**——批量 DELETE 都在主进程执行，批内阻塞所有 IPC。 |
| PR-3/4 | 约束机制：FK `ON DELETE CASCADE`（v2.1.10 N4-cont-2，`migrations.js:1506-1515`）、raw_json 瘦身契约（v2.1.8 N4）、差异行 raw_json 永留契约（N4-cont-1） | CASCADE 级联 run→diff_rows。 | 迁侧库后需把行级机制映射为文件级（见 §5.3）。 |
| PR-5 | `src/main.js:12260` `app.whenReady()` 同步顺序：`initializeActivityLog` → usage-stats 读写 → `database.init()`（15GB 主库 + 106 条幂等 DDL，`migrations.js` 2907 行）→ `ensureUiStyleDefault` → `openPendingDb`（第二个 SQLite 1.5GB）→ `runOwnAccountsMigration` → `syncTemplateLibraryFile` → 11 组 `register*Handlers` → **`createWindow()`**（`main.js:12353`） | 窗口被压在初始化队尾；窗口本身健康（`show:false` + `ready-to-show`，`main.js:2843-2871`）。 | 进程启动到可见全部消耗在 createWindow 之前；升级首启 28530ms / 38126ms。 |

---

## 四、术语

| 术语 | 含义 |
|------|------|
| asar | electron-builder 打包后 app 资源归档文件（`dist/win-unpacked/resources/app.asar`）；本迭代瘦身核心对象。 |
| build.files 白名单 | `package.json` build.files 改为只列允许进包的路径（含 `!` 排除项），新增文件默认不进包；与黑名单（`!docs/previews`）相对，封死复发通道。 |
| check-dist-size 守卫 | 新增脚本 `scripts/check-dist-size.js`，用 `@electron/asar` listPackage 断言 asar 体积 ≤25MB + 禁止/必须路径，任一失败 exit 1，挂 dist 链尾。 |
| per-month 侧库（acquiring） | acquiring 批量数据从主库迁出到独立文件 `{userData}/run-data/acquiring-bill-currency/month-{YYYY-MM}.sqlite`（B-D1 拍板 a 方案 + 2026-06-12 实施期修正：侧库文件键 = month）；删整月 = 删文件，删单 run = 文件内 diff 行级。 |
| 侧库生命周期键（通则） | 侧库文件键 = 该模块批量数据的**生命周期键**（acquiring = month；Phase 2 各模块按各自生命周期键裁定）；原「per-run / run-{id}」命名废弃。 |
| 双源过渡（B-D2） | 旧 run 历史数据原地保留主库、新 run 走侧库；读路径先侧库后主库；双源移除 + 二次 VACUUM 收口顺延下一版本。 |
| retention 文件级二态（B-D4） | 成功 run 超保留期 → 直接删侧库文件 / 仅保留 diff 表（差异表历史重导出不丢）；替代原行级 retention 清理。 |
| 迁移式 VACUUM（B-D6） | 一次性 VACUUM 主库，升级首启执行，app_settings 标志位幂等，UI 状态框提示「正在优化数据库，首次约 X 分钟」。 |
| 启动窗口先行（Phase 3） | `whenReady` → 立即 `createWindow()`（窗口 + loading 态）→ 后台继续 init → 完成 `webContents.send('app:init-done')` 放开功能。 |
| init-done 门控 | renderer 启动期显示「正在初始化…」，`app:get-info` 等待 `app:init-done` 事件后放开功能调用。 |
| 回退开关（B-D5） | setting/env 控制新旧启动时序，稳定一个版本后移除。 |
| parity 锁定 | 同一输入 fixture 在改造前后差异表 xlsx **byte-for-byte 一致**（复用 v2.1.10 A3 contract-test 思路）；资金红线核心断言。 |
| 8-status 迁移范式 | 沿用 v2.1.9/v2.1.10 的 8-status state machine + `createBackupFn` 注入 + app_settings 标志位幂等。 |

---

## 五、功能详细描述

### 5.1 PR-1 · Part A 打包体积瘦身

> 性质：纯打包配置 + 守卫脚本，零业务代码改动、零运行时行为变化（spec §A）。

#### 5.1.1 说明

- **A-F1 build.files 白名单**：替换 `package.json` build.files 为白名单清单：
  ```json
  "files": [
    "index.html", "package.json", "COMMON枚举.xlsx",
    "src/**/*", "assets/**/*", "!assets/app-icon-source.png",
    "docs/USER_GUIDE.md"
  ]
  ```
  - 输入：electron-builder 打包过程；输出：仅白名单文件进 asar。
  - 边界：`docs/USER_GUIDE.md` 单文件白名单后 asar 内路径不变（`app.getAppPath() + 'docs/USER_GUIDE.md'`），帮助页代码零改动。
- **A-F2 `@napi-rs/canvas` 移 devDependencies**：dependencies → devDependencies，`package-lock.json` 同步（`npm install` 重算）。开发机 `npm run preview`（`scripts/render-*.js`）不受影响（devDeps 本地照常安装）；CI build job 用 `npm ci` 装全量依赖。
- **A-F3 守卫脚本 `scripts/check-dist-size.js`**：
  - 输入：`dist/win-unpacked/resources/app.asar`（路径可参数化）；实现：`require('@electron/asar').listPackage()`（devDependencies 显式声明 `@electron/asar`）。
  - 断言（任一失败 exit 1 并打印明细）：① asar 体积 ≤ **25MB**（阈值常量，✅ A-D2）；② 禁止路径出现：`docs/previews` / `docs/iterations` / `docs/analysis` / `docs/prs` / `scripts/` / `node_modules/@napi-rs`；③ 必须存在：`docs/USER_GUIDE.md`、`assets/币种映射表.xlsx`、`COMMON枚举.xlsx`、`src/main.js`（防白名单漏列的反向保护）。
  - 挂载：`dist:win` / `dist:win:setup` / `dist:win:portable` 三条命令追加 `&& node scripts/check-dist-size.js`；CI main-push build 自动生效。
- **A-F4 npm script 补充**：新增 `"check:dist": "node scripts/check-dist-size.js"` 便于单独运行。

#### 5.1.2 影响范围

- 配置：`package.json`（files / dependencies / scripts）+ 新增 `scripts/check-dist-size.js`。前端 / 后端 src **零改动**；对外接口、数据、模板 bundle 零影响。
- 兼容性：NSIS `artifactName` 不变，安装升级路径不变。
- 对外契约变更（CHANGELOG 标注）：`CHANGELOG.md` / `README.md` 排除出包（✅ A-D3，无运行时读取，仓库文件本身不动）。
- 重要变量：不触及 src → check-vars 软约束不命中；版本 bump 硬节点照常跑 `/check-vars` + `npm run scan:vars`。

#### 5.1.3 UI Mockup（如适用）

无（无 UI 变化）。

---

### 5.2 PR-2 · Part B Phase 0 备份治理 + 一次性 VACUUM 🔴

> 独立可先行，spec 标「低风险」；但含删除用户数据动作（旧备份），风险章节单列 🔴。

#### 5.2.1 说明

- **备份保留策略（✅ B-D8）**：`backups/` 保留最近 2 份（mtime 排序），超出部分启动后台清理（setImmediate + activity log 记录每个被删文件）；根目录 `tool-data.sqlite.bak-*` 旧格式文件纳入**同一策略**。
  - 输入：`{userData}/backups/` 目录文件列表 + 根目录 `tool-data.sqlite.bak-*`；输出：保留最近 2 份，其余删除，逐文件写 activity log。
  - 边界：删除动作异步后台（不阻塞启动）；每个被删文件单独记一条 activity log。
- **一次性 VACUUM 主库（✅ B-D6 迁移式）**：升级首启执行，app_settings 标志位幂等（执行完写标志位，标志位已存在则跳过）；完成前 UI 进度提示「正在优化数据库，首次约 X 分钟」。
  - 输出：主库回收旧空洞，预期本机 15GB → ~6GB；Phase 1/2 完成后第二次 VACUUM 收口到 MB 级（顺延下一版本）。
  - 边界：迁移窗口断电 → 标志位不写、下次重试（8-status + 备份覆盖）；VACUUM 在用户机分钟级、双倍磁盘峰值（不可控，故仅作止血，结构性解法是数据出主库 §5.3）。

#### 5.2.2 影响范围

- 后端：`main.js` 启动链（备份清理 setImmediate + VACUUM 迁移）、备份模块、迁移/标志位逻辑。前端：UI 状态框提示文案。
- 数据（🔴 人工复核区）：删除旧备份（用户数据动作）；保留策略、删除日志、首次执行提示文案需用户过目。
- 回滚：标志位不写 → 下次重试；删备份不可逆（前置保留 2 份 + 逐文件日志兜底）。

#### 5.2.3 UI Mockup（如适用）

```
[升级首启] → 状态框：
  「正在优化数据库，首次约 X 分钟，请勿关闭程序…」
（完成后写 app_settings 标志位，下次启动不再执行）

[启动后台] → activity log（每个被删备份一条）：
  「[INFO] 清理旧备份：tool-data.sqlite.bak-20260605（保留最近 2 份策略）」
```

---

### 5.3 PR-3 · Part B Phase 1 acquiring run 级数据 → per-month 侧库 🔴🔴

> 最大头，建立样板。资金红线（parity 锁）+ DB 迁移，本项目最高风险等级。

#### 5.3.1 说明

- **文件布局（✅ B-D3，2026-06-12 实施期由 per-run 修正为 per-month）**：`{userData}/run-data/acquiring-bill-currency/month-{YYYY-MM}.sqlite`，内含 `bill_imports` / `flow_imports` / `diff_rows` 三表；`runs` 元数据留主库（轻量，含侧库文件相对路径 + 状态）。
  - **修正依据**（dev 调研实证 + team-lead 复核 + 用户拍板 A）：imports 表 `UNIQUE(month_key, recon_main_id)` 按月持久化（`migrations.js:2594`）、import 与 run 是独立 IPC handler（`main.js:12155/12159/12173`）、一次导入被多次 run 复用且每次 run `clearRunsByMonth` 按月清旧（`run-repository.js:148-150`）、对账 JOIN 要求 flow+bill+diff 同库——原「per-run 文件」字面在 acquiring 数据模型下不自洽（强行实现需每 run 重拷百万行 imports 并破坏导入/运行解耦）。**通则改述：侧库文件键 = 该模块批量数据的生命周期键**（acquiring = month；Phase 2 各模块按各自生命周期键裁定）。
- **侧库方案（✅ B-D1：a 独立侧库文件，文件键 = 生命周期键）**：删整月数据（用户覆盖删除 / 孤儿清理 / cleanup）= **删侧库文件**——原子、零碎片、零 VACUUM、不再有百万行 DELETE 阻塞主进程；删单 run = 文件内按 run_id 删 diff 行（与现状 `clearRunsByMonth` 同语义，量级小）。
- **机制简化映射**：
  - FK CASCADE（run→diff_rows）：侧库内同库保留 bill↔diff FK；删整月 = 删文件、删单 run = 文件内按 run_id 删 diff 行；
  - `clearStaleSuccessfulRawJson` / idle cleanup / `cleanupAfterRunBackground`：行级清理降级为文件级（成功 run 超 retention → 直接删侧库文件或仅保留 diff 表，✅ B-D4）；
  - `cleanupOrphanData`：启动扫描 `run-data/` 目录 vs 主库 runs 元数据，孤儿文件直接删（替代 461 万行批量 DELETE）。
- **worker**：`run-check-worker.js` 直接打开侧库文件（沿用现有独立连接 + PRAGMA 清单；跨库需 ATTACH 主库只读取 runs 元数据或经参数传入，T 阶段定）。
- **历史数据处置（✅ B-D2：b 双源过渡）**：旧数据原地保留、新 run 走侧库，读路径双源（先侧库后主库）；下个版本移除双源并二次 VACUUM。
- **双库一致性**：主库 runs 元数据与侧库文件非同事务，以**侧库文件存在性为准**——启动孤儿扫描双向兜底（有文件无元数据 → 删文件；有元数据无文件 → 标记 run 失效）。用户手删侧库文件 → 对应 run 降级显示「数据已清理」，不崩溃。
- **parity 锁定（资金红线核心）**：同一输入 fixture（含多币种/差异行/空流水边界）改造前后差异表 xlsx **byte-for-byte 一致**；diff_rows 行数与 summary 全等。
- **不改对账语义**：`runCheckCore` 5 阶段、diff JOIN SQL、epsilon、清算字段取值等零改动。

#### 5.3.2 影响范围

- 后端：`database.js` / `migrations.js` / `acquiring-bill-currency-db/*` / `acquiring-bill-currency-session.js` / `run-check-worker.js` / `main.js`（启动链与清理编排）。新增侧库管理器模块（建议 `src/backend/run-data-store.js`）。
- 数据（🔴 人工复核区）：acquiring run 数据存储位置变更；历史数据双源过渡期读路径变更。不可逆点须在 PR spec 显式标注 + SR-backup-1 前置备份 + 8-status 迁移范式。
- 回滚：迁移失败 ROLLBACK + 前置备份保留；标志位不写 → 下次重试；侧库目录可整体删除回到「无历史 run」状态，不影响主库模板/设置/联动表数据。

#### 5.3.3 UI Mockup（如适用）

无（导入/对账交互形态零改动，仅底层存储位置变更；用户手删侧库文件时 run 降级显示「数据已清理」）。

---

### 5.4 PR-4 · Part B Phase 2 推广同模式 🔴

#### 5.4.1 说明

- 套用 Phase 1 样板，迁出各自表集合：
  - biz-op-recon：`biz_op_recon_{imports, flow_imports, diff_rows, runs}`（imports 已 166 万行）；
  - bank-bu-recon：`bank_bu_recon_{bank_imports, pending_imports, runs}`。
- **防复发关键**：只做 acquiring 不够——主库会从其余模块缓慢复发，Phase 2 根除复发通道。
- parity 锁定与不改对账语义口径同 Phase 1。

#### 5.4.2 影响范围

- 后端：`biz-op-recon-db/*`、`bank_bu_recon_*` 表相关 repository / session / worker；复用 Phase 1 侧库管理器（`run-data/{module}/{生命周期键}.sqlite`，module = `biz-op-recon` / `bank-bu-recon`，各模块按各自生命周期键裁定）。
- 数据（🔴 人工复核区）：两模块 run 数据存储位置变更；双源过渡同 Phase 1。
- 回滚：同 Phase 1（侧库目录可整体删除回退）。

#### 5.4.3 UI Mockup（如适用）

无（同 Phase 1）。

---

### 5.5 PR-5 · Part B Phase 3 启动窗口先行 + Phase 4 守卫固化

#### 5.5.1 说明

**Phase 3 — 启动窗口先行（🟡 IPC 时序风险）**

- 新时序：`whenReady` → **立即 `createWindow()`**（窗口 + loading 态）→ 后台继续 init 链 → 完成后 `webContents.send('app:init-done')` 放开功能。
- renderer：启动期状态框显示「正在初始化…」，`app:get-info` 等待 init-done（renderer 已是异步初始化链，改造点集中在入口排队）。
- ⚠️ **IPC 时序风险**：handlers 注册晚于窗口加载 → renderer invoke 报 no handler。方案候选（T 阶段定）：① `register*Handlers` 提前到 createWindow 前（11 组注册函数若仅闭包引用 database、不在注册时解引用，则零成本——需逐组核实）；② 统一早期 gate（init 完成前 invoke 排队/拒绝重试）。
- **回退开关（✅ B-D5）**：setting/env 控制新旧时序，稳定一个版本后移除。
- 输出：点击到窗口可见 ≤300ms（loading 态）；init 完成后功能放开。

**Phase 4 — 守卫固化（防复发）**

- 新增 `rules/run-scoped-data-policy.md`：「对账类模块的 run 级批量数据**禁止写主库**，必须走侧库（侧库文件键 = 该模块批量数据的生命周期键，acquiring = month）」+ 侧库管理器使用约定。
- `rules/important-variables.md` 升格本次新符号（侧库管理器、路径常量、孤儿扫描入口等），更新受影响旧条目（§B.5.3 预命中清单）。
- 发版 checklist 增加启动指标确认项（activity log「启动耗时」基线对比）。

#### 5.5.2 影响范围

- 前端：loading 态 + init-done 门控（`renderer.js` 初始化入口）。后端：`main.js` 启动链时序重排（`whenReady` → createWindow 提前 + register*Handlers 顺序 + init-done 广播 + 回退开关）。
- 新增/更新规则文件：`rules/run-scoped-data-policy.md`、`rules/important-variables.md`、发版 checklist。
- 回滚：回退开关切回旧时序（B-D5）。

#### 5.5.3 UI Mockup（如适用）

```
[点击应用] →（≤300ms）→ 窗口可见 + loading 态：
  「正在初始化…」
        ↓（后台 init 完成）
  webContents.send('app:init-done') → 功能放开
```

---

## 六、验收标准

> 本章节按 PR 列 AC，共 **24 条**。量化指标转录自 spec §A.8 / §B.3 / §B.8。

### 6.1 PR-1 · Part A AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC1-1 | 本地 `npm run dist:win` 构建成功 + `check-dist-size` PASS + 记录前后体积对比（安装包 135MB → **≤ 90MB**、asar 101MB → **≤ 15MB 实测**） |
| AC1-2 | `asar list` 中不存在 `docs/previews|iterations|analysis|prs`、`scripts/`、`CHANGELOG.md`、`node_modules/@napi-rs`；存在 `docs/USER_GUIDE.md`、`assets/币种映射表.xlsx`、`COMMON枚举.xlsx`、`src/main.js` |
| AC1-3 | check-dist-size 阈值 **25MB**（✅ A-D2）；故意把一个 PNG 放进白名单路径测试 FAIL 路径、正常构建 PASS |
| AC1-4 | 打包版手测（win-unpacked 直接运行）：帮助页 USER_GUIDE 渲染、窗口/任务栏图标、网银账单导入→导出（币种映射表）、新账户币种下拉（FundType 枚举值）、收单/业务OP/中台调拨各打开一次（模板 xlsx）全正常 |
| AC1-5 | 开发机 `npm run preview` 仍可用（canvas devDeps 验证）；`npm run release-check` 全绿；CI PR smoke 绿、合并后 main build job 绿 |

### 6.2 PR-2 · Phase 0 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC2-1 | `backups/` 保留最近 2 份（mtime 排序），超出部分被删；根目录 `tool-data.sqlite.bak-*` 纳入同策略 |
| AC2-2 | 每个被删备份逐文件写 activity log；删除动作后台异步不阻塞启动 |
| AC2-3 | 一次性 VACUUM 升级首启执行，app_settings 标志位幂等（再次启动不重复执行）；UI 状态框提示「正在优化数据库」 |
| AC2-4 | VACUUM 预期本机 15GB → ~6GB；迁移窗口断电后标志位不写 → 下次重试，前置备份保留 |

### 6.3 PR-3 · Phase 1 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC3-1 | **parity（资金红线核心）**：固定 fixture（含多币种/差异行/空流水边界）改造前后差异表 xlsx **byte-for-byte 一致**；diff_rows 行数与 summary 全等 |
| AC3-2 | 跑一次 **400 万行级 run** → **主库增量 < 10MB**；删整月 → `run-data/acquiring-bill-currency/month-{YYYY-MM}.sqlite` 文件消失、磁盘即时回收；删单 run → 文件内 diff 行级清理 |
| AC3-3 | 双源过渡：新 run 走侧库、旧 run 历史数据原地保留主库；读路径先侧库后主库，UI 列表合并正确 |
| AC3-4 | retention 文件级二态（B-D4）：成功 run 超保留期 → 删侧库文件 / 仅保留 diff 表（差异表历史重导出不丢） |
| AC3-5 | 兜底：run 中途 kill 进程 → 重启孤儿扫描清理侧库文件 + 元数据一致；用户手删侧库文件 → run 降级显示「数据已清理」不崩溃 |
| AC3-6 | `runCheckCore` 5 阶段 / diff JOIN SQL / epsilon / 清算字段取值零改动；`npm run release-check` 全绿 |

### 6.4 PR-4 · Phase 2 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC4-1 | biz-op-recon parity：改造前后差异表 byte-for-byte 一致；批量数据迁出 `run-data/biz-op-recon/{生命周期键}.sqlite`，删整批生命周期 = 删文件 |
| AC4-2 | bank-bu-recon parity：改造前后输出一致；run 数据迁出 `run-data/bank-bu-recon/` |
| AC4-3 | 三模块均迁侧库后，跑各模块 run → 主库增量 < 10MB；防复发通道根除（主库不再因对账 run 膨胀） |
| AC4-4 | 复用 Phase 1 侧库管理器与孤儿扫描；两模块对账语义零改动，`npm run release-check` 全绿 |

### 6.5 PR-5 · Phase 3+4 AC

| AC 编号 | 验收条件 |
|---------|---------|
| AC5-1 | Phase 3 后**建窗 ≤ 300ms**（点击到窗口可见，loading 态）；**升级首启 ≤ 3s**；日常基线 ≤ 1.5s 不退化（activity log + `npm run startup:measure`） |
| AC5-2 | init 完成后 `app:init-done` 广播放开功能；启动期 renderer 显示「正在初始化…」无 no-handler 报错 |
| AC5-3 | 回退开关（B-D5）切回旧时序无残留；新旧来回切换功能正常 |
| AC5-4 | 新增 `rules/run-scoped-data-policy.md`；`rules/important-variables.md` 升格新符号 + 更新旧条目；发版 checklist 含启动指标确认项 |
| AC5-5 | 主库稳态体积 ≤ 50MB（run 级数据不再落主库，结合双源移除收口后达成；本版双源过渡阶段先验证新 run 不增主库） |

---

## 七、手动测试清单

### 7.1 P0 必测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| Part A 打包版功能 | win-unpacked 直接运行 | PR-1 已落地 | 帮助页/图标/网银导入导出/币种下拉/三模块模板加载全正常；asar ≤15MB 实测、安装包 ≤90MB |
| Phase 0 备份清理 | 现存多份备份 + 根目录 .bak | PR-2 已落地 | 仅保留最近 2 份，逐文件记 activity log；首启状态框提示「正在优化数据库」，二启不再 VACUUM |
| Phase 1 acquiring parity | 真实多币种/差异行 fixture | PR-3 已落地、场景启用 | 改造前后差异表 xlsx byte-for-byte 一致（资金红线，人工核对一份真实样本） |
| Phase 1 体积/回收 | 400 万行级 run | PR-3 已落地 | 主库增量 <10MB；删整月 → 侧库文件消失、磁盘即时回收；删单 run → 文件内 diff 行级清理 |
| Phase 2 三模块回放 | biz-op-recon + bank-bu-recon 真实数据 | PR-4 已落地 | 两模块输出与改造前一致；run 数据落各自 `run-data/{module}/` |
| Phase 3 启动指标 | 升级首启 + 日常启动 | PR-5 已落地 | 建窗 ≤300ms、升级首启 ≤3s、日常 ≤1.5s（activity log 留档）；功能在 init-done 后放开 |

### 7.2 P1 应测场景

| 场景 | 输入 | 前置条件 | 预期结果 |
|------|------|----------|---------|
| Part A FAIL 路径 | 故意把 PNG 放进白名单路径 | PR-1 | check-dist-size FAIL（exit 1）打印明细 |
| Phase 0 断电重试 | VACUUM 过程中 kill | PR-2 | 标志位不写、前置备份保留、下次启动重试 |
| Phase 1 孤儿兜底 | run 中途 kill 进程 | PR-3 | 重启孤儿扫描清理侧库文件 + 元数据一致 |
| Phase 1 手删侧库 | 手动删除某 run 侧库文件 | PR-3 | 对应 run 降级显示「数据已清理」不崩溃 |
| Phase 3 回退开关 | setting/env 切旧时序 | PR-5 | 新旧来回切换无残留、功能正常 |

### 7.3 不测项与原因

- Part A `dist:win` CI 守卫首次生效靠 main build job 实跑（本地已验证），不在 PR smoke 重复完整构建。
- `tool-data-pending.sqlite`（1.5GB Pending 模块）治理：本迭代非目标（独立月度归档生命周期），列为观察项不测。
- 双源移除 + 二次 VACUUM 收口（B-D2）：顺延下一版本，本迭代仅验证双源过渡，不测移除路径。
- 主库稳态 ≤50MB 终态：依赖双源移除后达成，本版仅验证新 run 不增主库（AC5-5）。

---

## 八、数据 / 状态 / 安全影响

| 类别 | 说明 |
|------|------|
| 数据结构变更 | Phase 1/2：批量表（acquiring `bill_imports`/`flow_imports`/`diff_rows`、biz-op-recon/bank-bu-recon 对应表集合）从主库迁出至侧库 `{userData}/run-data/{module}/{生命周期键}.sqlite`（acquiring = `month-{YYYY-MM}.sqlite`，2026-06-12 实施期由 per-run 修正为 per-month；各模块按各自生命周期键裁定）；`runs` 元数据留主库（含侧库文件相对路径 + 状态）。Part A：无 DB 变更。Phase 0：无 schema 变更（仅 VACUUM + 删备份）。 |
| 状态流转变更 | Phase 0/1/2 迁移沿用 8-status state machine + `createBackupFn` 注入 + app_settings 标志位幂等（v2.1.10 N4-cont-2 范式）。Phase 3：`whenReady` 启动时序由「init 完成后建窗」改为「立即建窗 + init-done 门控放开功能」。run 级联清理由行级 DELETE 降级为文件级删除（B-D4）。 |
| 权限 / 安全 | 无新增外部接口；侧库文件继承 `{userData}` 目录权限。 |
| 回滚策略 | Part A：单 commit revert `package.json` + 删守卫脚本，无残留。Phase 0/1/2：迁移失败 ROLLBACK + 前置备份保留；标志位不写 → 下次重试；侧库目录可整体删除回到「无历史 run」状态，不影响主库模板/设置/联动表。Phase 3：回退开关切回旧时序（B-D5）。 |

---

## 九、非功能性要求

| 类别 | 要求 |
|------|------|
| 向下兼容 | Part A：NSIS artifactName / 安装升级路径不变；`CHANGELOG.md`/`README.md` 排除出包（无运行时读取，CHANGELOG 标注）。Part B：不改任何对账算法语义（`runCheckCore` 5 阶段 / diff JOIN / epsilon / 清算字段零改动），parity byte-for-byte 锁定为合并门；双源过渡期旧 run 历史数据可读不丢。 |
| 性能 | 主库稳态体积 ≤ 50MB（批量数据不再落主库）；400 万行 run 主库增量 < 10MB；删整月 = 删侧库文件（原子、零碎片、无 VACUUM、不阻塞主进程 IPC）、删单 run = 文件内 diff 行级；版本升级首启 ≤ 3s、日常启动基线 ≤ 1.5s 不退化；建窗（点击到可见）≤ 300ms；asar ≤ 15MB 实测（25MB 阈值守卫）、安装包 ≤ 90MB。 |
| 鲁棒性 | Part A：check-dist-size 反向「必须存在」断言防白名单漏列。Phase 0：删备份前保留 2 份 + 逐文件日志 + VACUUM 标志位幂等可重试。Phase 1/2：双库一致性以侧库文件存在性为准，启动孤儿扫描双向兜底；run 中途 kill / 用户手删侧库文件均不崩溃。Phase 3：回退开关稳定一版后移除。 |

---

## 十、待澄清问题

- 本迭代决策点**全部已拍板**（11 个，2026-06-12），无未决问题：
  - Part A：✅ A-D1（v3.0.5 独立小 PR）/ A-D2（asar 阈值 25MB）/ A-D3（CHANGELOG/README 排除出包）。
  - Part B：✅ B-D1（独立侧库文件，2026-06-12 修正：文件键 = 模块数据生命周期键，acquiring 为 per-month）/ B-D2（双源过渡，移除收口顺延下版本）/ B-D3（`run-data/{module}/{生命周期键}.sqlite`，acquiring = `month-{YYYY-MM}.sqlite`；原 `run-{id}` 命名废弃）/ B-D4（retention 文件级二态）/ B-D5（Phase 3 加回退开关）/ B-D6（迁移式 VACUUM + 状态框提示）/ B-D7（四 Phase 全落 v3.0.5、5 PR 串行）/ B-D8（备份保留最近 2 份）。
- 实施期待核（非决策）项（留 Part B 实施前 TechDoc 细化）：
  - Phase 1 worker 跨库访问 PRAGMA/锁行为差异（ATTACH 主库只读取 runs 元数据 或 参数传入，T 阶段定）；
  - Phase 3 handlers 注册时序方案二选一（register*Handlers 提前 vs 统一早期 gate，需逐组核实闭包引用 database 是否在注册时解引用）；
  - Phase 0 VACUUM「首次约 X 分钟」文案的 X 取值（依本机 15GB 实测估算）。

---

## 十一、风险提示（人工复核）

> 资金敏感区逐条列。等级：🔴 资金红线 / 删用户数据 / 🟡 中 / 🟢 低。

| # | 风险 | 等级 | 缓解 |
|---|------|------|------|
| R-1 | Phase 0 删除旧备份（用户数据动作）→ 误删用户需要的历史备份 | 🔴（删备份） | 保留最近 2 份（mtime 排序）+ 逐文件 activity log + 删除动作后台异步；保留策略/删除日志/首次提示文案用户过目（B-D8） |
| R-2 | Phase 1 acquiring 迁侧库后差异表输出漂移（资金红线核心） | 🔴（parity 锁） | 同 fixture 改造前后差异表 xlsx **byte-for-byte 一致** + diff_rows/summary 全等；`runCheckCore` 5 阶段/JOIN/epsilon/清算字段零改动；人工核对真实样本 |
| R-3 | Phase 2 biz-op-recon / bank-bu-recon 迁侧库后输出漂移 | 🔴（parity 锁） | 套用 Phase 1 parity 断言（各模块 byte-for-byte）；两模块对账语义零改动 |
| R-4 | 双库一致性（主库 runs 元数据与侧库文件非同事务）→ 孤儿/失效 run | 🔴 | 以侧库文件存在性为准；启动孤儿扫描双向兜底（有文件无元数据删文件、有元数据无文件标失效）；run 中途 kill / 手删文件均不崩溃 |
| R-5 | Phase 1/2 迁移窗口断电 → DB 中间态 | 🔴 | 8-status 迁移范式 + `createBackupFn` 前置备份 + app_settings 标志位幂等（不写则重试）+ ROLLBACK |
| R-6 | Phase 3 IPC 时序：handlers 注册晚于窗口加载 → renderer invoke 报 no handler | 🟡 | T 阶段定方案（register*Handlers 提前 / 统一早期 gate）；init-done 门控；回退开关切回旧时序 |
| R-7 | Phase 0 一次性 VACUUM 在用户机不可控（分钟级、双倍磁盘峰值） | 🟡 | 仅作止血（结构性解法是数据出主库）；UI 提示「首次约 X 分钟」；标志位幂等可重试 |
| R-8 | Phase 1 worker 跨库访问 PRAGMA/锁行为差异 | 🟡 | 沿用现有独立连接 + PRAGMA 清单；ATTACH 只读元数据 / 参数传入（T 阶段定）；smoke/集成全走侧库路径验证 |
| R-9 | 双源读路径期间 UI 列表合并（侧库新 run + 主库旧 run） | 🟡 | 读路径先侧库后主库，列表合并正确性纳入 AC3-3 + 手测 |
| R-10 | Part A 白名单漏列运行时文件 → 打包版缺文件（开发态 npm start 不暴露） | 🟡 | check-dist-size「必须存在」反向断言 + 打包版手测清单（AC1-4） |
| R-11 | check-vars 对「调用时序与数据位置」改动命中弱（本 change 大量改动非变量名） | 🟡 | review 不只依赖工具输出；每阶段 PR 前必跑 `/check-vars` + 逐条对照 §B.5.3 预命中清单（`runCheckCore`/`cleanupAfterRunBackground`/`setupIdleCleanupTimer`/`clearStaleSuccessfulRawJson`/CASCADE schema/`AppDatabase.init`/`app` whenReady 链等） |

---

## 十二、变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-06-12 | 初稿（基于 `changes/size-startup-optimization/spec.md` status=approved，11 个拍板点全部拍板收口；Part A 3 个 §A.9 + Part B 8 个 §B.9 结论原样转述；5 PR 串行：Part A + Phase 0-4） |
| 2026-06-12 | 侧库粒度修正（同步 spec §B.4 Phase 1 + §B.9 B-D1/B-D3 终态）：acquiring 侧库键由 per-run 改为 **per-month**（`month-{YYYY-MM}.sqlite`），通则改述为「侧库文件键 = 该模块批量数据的生命周期键」。依据：imports 按月持久化 `UNIQUE(month_key,...)`、import/run 独立 handler、一次导入多次 run 复用、JOIN 要求三表同库——原 per-run 字面与 acquiring 数据模型不自洽（dev 调研实证 + team-lead 复核 + 用户拍板 A）。「删 run=删文件」改述为「删整月=删文件、删单 run=文件内 diff 行级」。 |

---

## 十三、实施记录

> 由 PR merged + 归档后追加，PM 不需要手动填写。
