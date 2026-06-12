# Spec — size-startup-optimization 体积与启动性能优化（Part A 打包瘦身 / Part B 主库治理 + 启动窗口先行）

> status: **approved（11 个拍板点全部拍板，2026-06-12，结果见 §A.9 / §B.9；目标版本 v3.0.5）**
> owner: pzhong
> created: 2026-06-10（两部分原 spec 落档日）
> updated: 2026-06-12（拍板收口；目标版本一度改落 v3.0.6，经核实 3.0.5 版本号未被占用——PR #72 为 v3.0.4 修订补丁——改回 **v3.0.5**）；2026-06-11（由 `changes/dist-size-slim/` 与 `changes/db-bloat-governance-startup-first/` 合并为单一 change；除版本口径同步外内容无实质变更）
> 来源：2026-06-10 性能/体积调研（`knowledge/backlog.md` B6 / B7），用户报告「打包后体积越来越大、点击后页面显示越来越慢」。
> 实施节奏：**两部分独立实施互不阻塞**——Part A 纯配置 1 个小 PR（半天量级）；Part B 🔴 本项目最高风险等级，4 阶段 = 4 个独立 PR。✅ B-D7 拍板（2026-06-12）：**Part A + Part B 四个 Phase 全部落 v3.0.5**（约 5 个 PR 的重版本；不切 v3.1.0——与原建议不同，用户自定）。
> 拍板点共 11 个：Part A 3 个（§A.9）、Part B 8 个（§B.9）——✅ 已全部拍板（2026-06-12）。

---

# Part A — 打包体积瘦身（原 change A / backlog B6）

> 性质：纯打包配置 + 守卫脚本，**零业务代码改动、零运行时行为变化**。
> 目标版本：**v3.0.5**（✅ A-D1 拍板 2026-06-12：独立小 PR）。

## A.1 背景

- 用户报告：打包产物越来越大。实测 v3.0.0 安装包 **135MB**（`dist/清结算小助手-3.0.0-setup.exe`，2026-06-09 构建）。
- 其中 Electron 运行时固定成本约 70MB（压缩后），剩余膨胀全部来自 **app.asar = 101MB**（`dist/win-unpacked/resources/app.asar`；同类应用正常 ~15MB）。
- 根因：`build.files` 宽 glob 把开发文档/测试脚本打进包 + 开发工具依赖误入 `dependencies`。

## A.2 代码现状（出处）

### A.2.1 打包清单（`package.json:118-128`）

```json
"files": ["assets/**/*", "COMMON枚举.xlsx", "index.html", "src/**/*",
          "scripts/**/*", "CHANGELOG.md", "README.md", "docs/**/*", "package.json"]
```

### A.2.2 asar 101MB 实测构成（du，2026-06-10）

| 内容 | 大小 | 运行时是否需要 | 依据 |
|---|---|---|---|
| `docs/**/*` | **42MB** | ❌ 仅 `USER_GUIDE.md`（172KB）需要 | `docs/previews/` 36MB 截图 + `iterations/` 4.7MB + `analysis/` 1.0MB + `prs/` 480K；运行时读取仅 `src/main.js:4212`（帮助页 `userGuidePath`）+ `marked` 渲染（`main.js:4220-4222`） |
| node_modules 生产依赖 | ~47MB | ⚠️ 部分 | electron-builder 自动打包全部 `dependencies`（devDependencies 不打包） |
| ├ `@napi-rs/canvas` | 25MB | ❌ **src/ 零引用** | 全 repo grep：仅 `scripts/render-*.js` 预览工具链使用 |
| ├ `exceljs` | 22MB | ✅ 7 个 writer 必需 | `src/main-process/*-writer.js` 等 |
| ├ `xlsx-js-style` + `xlsx` | 9.5MB + 7.2MB | ⚠️ 双份共存（各带 codepage ~5.9MB） | 均被 src 引用（xlsx 8 文件 / xlsx-js-style 5 文件）；合并属后续独立 PR（见 §A.3 可不做） |
| `scripts/**/*` | 2MB | ❌ 测试/预览/poc 脚本 | 运行时 worker 均在 `src/main-process/`（`run-check-worker.js` 等）；`gen-build-info.js` 是构建期工具，产物写入 `src/build-info.js`（`main.js:53` require） |
| `assets/**/*` | 6.5MB | ✅ 绝大部分 | 模板 xlsx（FundType枚举值/Pending/中台加款单剔除模板/中台调拨订单/余额账单模版/外汇交割表/外汇期权订单/收单币种校验导出差异表模版/币种映射表）、`cat-meme.gif`（index.html:26）、`fonts/` 3.4MB（fonts.css E2 方案）均运行时引用 |
| ├ `assets/app-icon-source.png` | 1.3MB | ❌ 无运行时引用 | 窗口图标引用为 `APP_ICON_FILE_NAMES = ['app-icon.ico', 'app-icon.png']`（`main.js:388`），source 仅 `scripts/sync-app-icon.js` 的输入源 |
| `CHANGELOG.md` / `README.md` | 小 | ❌ 无运行时读取 | grep src/ 仅 `scenario-hit-rows-writer.js:6` 注释提及 |
| `COMMON枚举.xlsx` | 小 | ✅ | `main.js:342` `BUNDLED_ENUM_FILE_NAME` |
| `src/**/*` + index.html | 3.4MB | ✅ | — |

### A.2.3 已知约束

- electron-builder：`files` 只控制 app 文件；`dependencies` 的 node_modules 自动全量打包，唯一出包方式是移到 `devDependencies`。
- CI（`.github/workflows/build-windows.yml`）：PR 跑 smoke，main push 跑 build——⚠️ 实测 build job **直调 `npx electron-builder --win --publish never`**（不走 `npm run dist:*`），守卫挂 dist 命令链尾**不会**被 CI 覆盖，需在 workflow 中显式加 step（2026-06-12 self-review 修正，原「自动生效」假设不成立；A-F3 已随之更新）。

## A.3 目标

- **必做**：
  1. `build.files` 改**白名单**（防复发核心：新增文件默认不进包）
  2. `@napi-rs/canvas` → `devDependencies`
  3. 新增打包体积/内容断言守卫脚本，挂进 `dist:win*` 链尾
  4. 排除 `assets/app-icon-source.png`
- **可不做（后续独立 PR）**：`xlsx` 与 `xlsx-js-style` 合一（再 −13MB 原始；涉及 8 个 src 文件 + 全模块读写回归，风险与本 change 不同量级，不混做）
- **明确不做**：不动 `exceljs`；不动 `fonts/`（v2.1.13 E2 功能性方案）；不删仓库里任何文件（`app-icon-source.png` 仅出包不删源）；不改任何 src 代码。

## A.4 功能点

### A-F1 build.files 白名单

- 新清单（替换 `package.json` build.files）：

```json
"files": [
  "index.html",
  "package.json",
  "COMMON枚举.xlsx",
  "src/**/*",
  "assets/**/*",
  "!assets/app-icon-source.png",
  "docs/USER_GUIDE.md"
]
```

- 边界：`docs/USER_GUIDE.md` 单文件白名单后，asar 内路径不变（`app.getAppPath() + 'docs/USER_GUIDE.md'`），帮助页代码零改动。
- 验收：`asar list` 中不存在 `docs/previews|iterations|analysis|prs`、`scripts/`、`CHANGELOG.md`；存在 `docs/USER_GUIDE.md`。

### A-F2 @napi-rs/canvas 移 devDependencies

- `package.json` dependencies → devDependencies，`package-lock.json` 同步（`npm install` 重算）。
- 边界：preview 脚本（`scripts/render-*.js`）在开发机不受影响（devDeps 本地照常安装）；CI build job 用 `npm ci` 装全量依赖，`prebuild:meta` 不依赖 canvas。
- 验收：打包产物（asar + asar.unpacked）中无 `@napi-rs`；开发机 `npm run preview` 正常出图。

### A-F3 守卫脚本 `scripts/check-dist-size.js`（防复发）

- 输入：`dist/win-unpacked/resources/app.asar`（路径可参数化）。
- 实现：`require('@electron/asar').listPackage()`（本地已验证可用，来自 electron-builder 传递依赖；为稳妥在 devDependencies 显式声明 `@electron/asar`）。
- 断言（任一失败 exit 1 并打印明细）：
  1. asar 体积 ≤ **25MB**（阈值常量，拍板可调）
  2. 禁止路径出现：`docs/previews` / `docs/iterations` / `docs/analysis` / `docs/prs` / `scripts/` / `node_modules/@napi-rs`
  3. 必须存在：`docs/USER_GUIDE.md`、`assets/币种映射表.xlsx`、`COMMON枚举.xlsx`、`src/main.js`（防白名单漏列的反向保护）
- 挂载：三条 dist 命令（`dist:win` / `dist:win:setup` / `dist:win:portable`）追加 `&& node scripts/check-dist-size.js`；**CI 需显式挂载**——`.github/workflows/build-windows.yml` build job 直调 electron-builder 不经 npm scripts，须在「Build Windows installer」步骤后新增 `node scripts/check-dist-size.js` step（2026-06-12 修正）。
- ⚠️ 跨平台约束（2026-06-12 self-review 发现）：`@electron/asar` `listPackage` 用 `path.join` 拼路径，**Windows 上返回反斜杠形态**（CI 为 windows-latest）——断言实现必须先把返回路径的 `\` 归一为 `/`，否则断言②在 Windows 静默失效、断言③全量误报。
- 验收：故意把一个 PNG 放进白名单路径测试 FAIL 路径；正常构建 PASS。

### A-F4 npm script 补充

- 新增 `"check:dist": "node scripts/check-dist-size.js"` 便于单独运行。

## A.5 影响范围

- 配置：`package.json`（files / dependencies / scripts）+ 新增 `scripts/check-dist-size.js`。
- 前端 / 后端 src：**零改动**。对外接口、数据、模板 bundle：零影响。
- 兼容性：NSIS `artifactName` 不变，安装升级路径不变。
- 重要变量：不触及 src → check-vars 软约束不命中；版本 bump 硬节点照常跑 `/check-vars` + `npm run scan:vars`。

## A.6 技术决策

- **白名单 vs 黑名单**：白名单。黑名单（`!docs/previews`）只能挡住已知项，下次新增 `docs/xxx/` 大文件仍静默进包——本次问题正是宽 glob 造成的，复发通道必须封死。
- **守卫挂 dist 链尾 vs 独立 CI job**：挂链尾。本地构建与 CI 双覆盖，不新增 workflow 维护面。
- **风险**：白名单漏列运行时文件 → 打包版功能缺文件（开发态 `npm start` 不受影响，难在开发期发现）。缓解 = A-F3 反向"必须存在"断言 + §A.8 打包版手测清单。

## A.7 数据 / 状态 / 安全影响

- 无数据/状态/权限变更。
- 回滚策略：单 commit revert `package.json` + 删守卫脚本即可，无残留。

## A.8 验收与测试

1. `npm run release-check` 全绿（与本改动正交，防偶发回归）。
2. 本地 `npm run dist:win`：构建成功 + `check-dist-size` PASS + 记录前后体积对比（预期安装包 135MB → **≤ 90MB**，asar 101MB → **≤ 15MB**）。
3. **打包版手测**（win-unpacked 直接运行）：
   - [ ] 帮助页打开、USER_GUIDE 正常渲染（marked 链路）
   - [ ] 窗口/任务栏图标正常
   - [ ] 网银账单导入 → 导出（币种映射表加载）
   - [ ] 新账户币种下拉（FundType枚举值.xlsx IPC 链路）
   - [ ] 收单单据币种校验 / 业务OP / 中台调拨 各打开一次（模板 xlsx 加载）
4. 开发机 `npm run preview` 仍可用（canvas devDeps 验证）。
5. CI：PR smoke 绿；合并后 main build job 绿（守卫在 CI 生效的首次验证）。

## A.9 拍板（✅ 全部拍板，2026-06-12）

- [x] **A-D1** 目标版本：✅ **v3.0.5** 独立小 PR（原建议 v3.0.4 已发版，重定）
- [x] **A-D2** asar 体积阈值：✅ **25MB**（当前理论值 ~13MB，留模板/字体增长余量约 2x）
- [x] **A-D3** `CHANGELOG.md` / `README.md`：✅ **排除出包**（无运行时读取；仓库文件本身不动）

---

# Part B — 主库膨胀治理 + 启动窗口先行（原 change B / backlog B7）

> 目标版本：**v3.0.5**（✅ B-D7 拍板 2026-06-12：四个 Phase **全部落 v3.0.5**、分 4 个独立 PR 串行，与 Part A 同版本；不切 v3.1.0——与原建议不同，用户自定）。
> 性质：🔴 **资金红线 + DB 迁移 + 启动时序**——本项目最高风险等级。每阶段 PR 前必跑 `/check-vars`（预命中清单见 §B.5.3），实施走 PM PRD → spec 细化 → dev → 用户手测循环。

## B.1 背景（2026-06-10 实测证据，均有出处）

- 用户报告：点击应用后前端页面显示越来越慢。
- **启动指标**（`~/Documents/网银账单生成小助手/app_activity_log.txt`「启动耗时/渲染层启动耗时」条目）：
  - 渲染层初始化 ~50ms、建窗到可见 ~110ms → **前端不是瓶颈**；
  - 进程启动到可见：基线 **1.2~1.5s**，版本升级首启 **28530ms**（v2.1.8 N5 迁移）/ **38126ms**（N4-cont-2 迁移 2,596,169 行 + 备份），全部消耗在 `createWindow()` 之前。
- **主库膨胀**（本机 `{userData}/tool-data.sqlite`）：
  - 文件 **15GB**；`PRAGMA page_count` = 3,935,932（×4096）、`freelist_count` = 2,407,169 页 ≈ **9.86GB（61%）为删除后未回收空洞**；
  - 表历史写入（MAX(rowid)）：`acquiring_bill_currency_bill_imports` **18,462,096**、`acquiring_bill_currency_diff_rows` **20,769,352**、`biz_op_recon_imports` 1,667,366、`linked_bank_deposit` 1,315,783；
  - 启动期孤儿清理曾单次删除 **4,615,524 行**（activity log 16:42 段）。
- **备份失控**：`backups/` **31GB** + 根目录 `tool-data.sqlite.bak-20260608` **15GB**，无保留策略；本机该应用合计占用 **~62GB**。
- **根因**：三个对账模块把 run 级批量数据写入主库 → run 后 DELETE → SQLite 文件永不收缩。全代码无任何空间回收机制（grep：VACUUM 仅出现在备份 `VACUUM INTO`，无 auto_vacuum / incremental_vacuum）。

## B.2 代码现状（出处）

### B.2.1 启动链（窗口被压在队尾）

`src/main.js:12260` `app.whenReady()` 同步顺序执行：`initializeActivityLog` → usage-stats 读写 → `database.init()`（15GB 主库 + 106 条幂等 DDL，`src/backend/database/migrations.js` 2907 行）→ `ensureUiStyleDefault` → `openPendingDb`（第二个 SQLite，1.5GB）→ `runOwnAccountsMigration` → `syncTemplateLibraryFile` → 11 组 `register*Handlers` → **`createWindow()`**（`main.js:12353`）。窗口本身是健康的 `show:false` + `ready-to-show`（`main.js:2843-2871`）。

### B.2.2 run 级数据写入/清理路径

- 写入：`src/backend/acquiring-bill-currency-db/import-repository.js`（`insertFlowRow` / `insertBillRow`）、`run-repository.js`（`insertDiffRowsByJoin`，chunked）；编排 `src/main-process/acquiring-bill-currency-session.js`（`runCheckCore` 5 阶段）+ `run-check-worker.js`（worker 独立 DB 连接，PRAGMA 6 条清单）。biz-op-recon / bank-bu-recon 同模式（`src/backend/biz-op-recon-db/*`、`bank_bu_recon_*` 表）。
- 清理：`cleanupAfterRunBackground`（50000 行/批 + setImmediate）、`setupIdleCleanupTimer`（idle 30min，`main.js:10620` 附近）、`cleanupOrphanData`（启动期 setImmediate，`main.js:12365` 附近）、`clearStaleSuccessfulRawJson`（raw_json retention）。**`node:sqlite` DatabaseSync 是同步 API——这些批量 DELETE 都在主进程执行，批内阻塞所有 IPC**。
- 约束机制：FK `ON DELETE CASCADE`（v2.1.10 N4-cont-2，`migrations.js:1506-1515`）、raw_json 瘦身契约（v2.1.8 N4）、差异行 raw_json 永留契约（N4-cont-1）。
- 备份：`createBackupFn`（SR-backup-1，`src/backend/database/backup.js`，VACUUM INTO）→ `{userData}/backups/`；一次性迁移触发，无数量上限。

## B.3 目标

- **必做**（量化验收见 §B.8）：
  1. 主库稳态体积 ≤ 50MB（run 级数据不再落主库）
  2. 版本升级首启 ≤ 3s、日常启动基线 ≤ 1.5s 不退化
  3. 窗口显示与 DB init **解耦**：点击到窗口可见 ≤ 300ms（loading 态）
  4. backups 有界：保留最近 2 份，旧备份自动清
  5. 防复发约定固化进 `rules/`
- **可不做**：`tool-data-pending.sqlite`（1.5GB，Pending 模块）治理——独立生命周期（月度归档），列为观察项。
- **明确不做**：**不改任何对账算法语义**——`runCheckCore` 5 阶段、diff JOIN SQL、epsilon、清算字段取值等零改动，parity 断言锁定（§B.8.1）。

## B.4 方案（4 阶段 = 4 个独立 PR，可分版本落地）

### Phase 0 — 备份治理 + 一次性空间回收（独立可先行，低风险）

- `backups/` 保留最近 2 份（mtime 排序），超出部分启动后台清理（setImmediate + activity log 记录每个被删文件）；根目录 `tool-data.sqlite.bak-*` 旧格式文件纳入同一策略。
- 一次性 VACUUM 主库：迁移式（app_settings 标志位幂等 + 完成前 UI 进度提示「正在优化数据库，首次约 X 分钟」）。预期本机 15GB → ~6GB；Phase 1/2 完成后第二次 VACUUM 收口到 MB 级。
  - 实施注记（2026-06-12 PR-2 落地）：① **新增磁盘安全前置**——VACUUM 前检查剩余磁盘 ≥ DB 文件大小 × 1.2，不足则跳过 + warning log + 不写标志位（下次启动重试）；检查本身失败 fail-open 放行。② **UI 提示文案承载顺延 PR-5**——调研证实 N5/N4-cont-2 升级首启本就无任何用户可见提示（窗口压在 init 链尾之后），Phase 0 阶段无承载窗口，以 activity log（开始/完成/耗时/前后体积）兑现可观测性；状态框文案随 Phase 3 窗口先行落地（同版本发布，对终端用户 B-D6 承诺不变）。③ VACUUM 后补 `wal_checkpoint(TRUNCATE)`（WAL 模式下不 checkpoint 则物理文件不缩，实测验证）。
- ⚠️ 删除用户数据（旧备份）——保留策略、删除日志、首次执行提示文案需用户过目（B-D8）。

### Phase 1 — acquiring run 级数据 → per-run 侧库（最大头，建立样板）

- 文件布局（B-D3 · **2026-06-12 实施期修正：acquiring 侧库键 = month 而非 run**）：`{userData}/run-data/acquiring-bill-currency/month-{YYYY-MM}.sqlite`，内含 `bill_imports` / `flow_imports` / `diff_rows` 三表；`runs` 元数据留主库（轻量，含侧库文件相对路径 + 状态）。
  - 修正依据（dev 调研实证 + team-lead 复核 + 用户拍板 A）：imports 表 `UNIQUE(month_key, recon_main_id)` 按月持久化（`migrations.js:2594`）、import 与 run 是独立 IPC handler（`main.js:12155/12159/12173`）、一次导入被多次 run 复用且每次 run `clearRunsByMonth` 按月清旧（`run-repository.js:148-150`）、对账 JOIN 要求 flow+bill+diff 同库——原「per-run 文件」字面在 acquiring 数据模型下不自洽（强行实现需每 run 重拷百万行 imports 并破坏导入/运行解耦）。**通则改述：侧库文件键 = 该模块批量数据的生命周期键**（acquiring=month；Phase 2 各模块按各自生命周期键裁定）。
- 生命周期：删除整月数据（用户覆盖删除 / 孤儿清理 / cleanup）= **删侧库文件**——原子、零碎片、零 VACUUM、不再有百万行 DELETE 阻塞主进程；删单 run = 文件内按 run_id 删 diff 行（与现状 `clearRunsByMonth` 同语义，量级小）。
- 机制简化映射：
  - FK CASCADE（run→diff_rows）：侧库内同库保留 bill↔diff FK；run 级联 = 删文件；
  - `clearStaleSuccessfulRawJson` / idle cleanup / `cleanupAfterRunBackground`：行级清理降级为文件级（成功 run 超 retention → 直接删侧库文件或仅保留 diff 表，B-D4）；
  - `cleanupOrphanData`：启动扫描 `run-data/` 目录 vs 主库 runs 元数据，孤儿文件直接删（替代 461 万行批量 DELETE）。
- worker：`run-check-worker.js` 直接打开侧库文件（沿用现有独立连接 + PRAGMA 清单；跨库需 ATTACH 主库只读取 runs 元数据或经参数传入，T 阶段定）。
- 历史数据处置（B-D2，推荐 b）：a) 一次性迁移到侧库；**b) 旧数据原地保留、新 run 走侧库，读路径双源（先侧库后主库），下个版本移除双源并二次 VACUUM**；c) 提示用户后清空（❌ 差异表历史重导出是真实功能，不可默认清）。
- **parity 锁定**：同一输入 fixture 在改造前后差异表 xlsx **byte-for-byte 一致**（复用 v2.1.10 A3 contract-test 思路）。

### Phase 2 — biz-op-recon + bank-bu-recon 推广同模式

- 套用 Phase 1 样板（各自表集合：`biz_op_recon_{imports,flow_imports,diff_rows,runs}`、`bank_bu_recon_{bank_imports,pending_imports,runs}`）。
- **防复发关键**：只做 acquiring，主库会从其余模块缓慢复发（biz_op_recon_imports 已 166 万行）。

### Phase 3 — 启动窗口先行

- 新时序：`whenReady` → **立即 `createWindow()`**（窗口 + loading 态）→ 后台继续 init 链 → 完成后 `webContents.send('app:init-done')` 放开功能。
- renderer：启动期状态框显示「正在初始化…」，`app:get-info` 等待 init-done（renderer 已是异步初始化链，改造点集中在入口排队）。
- ⚠️ IPC 时序风险：handlers 注册晚于窗口加载 → renderer invoke 报 no handler。方案候选（T 阶段定）：① `register*Handlers` 提前到 createWindow 前（11 组注册函数若仅闭包引用 database、不在注册时解引用，则零成本——需逐组核实）；② 统一早期 gate（init 完成前 invoke 排队/拒绝重试）。
- 回退开关（B-D5，✅ 拍板加）：setting/env 控制新旧时序，稳定一个版本后移除。
- **承接 B-D6（2026-06-12 PR-2 顺延项）**：窗口先行落地后，init 链在后台执行期间 loading 态需可显示阶段文案——其中 Phase 0 一次性 VACUUM 运行时显示「正在优化数据库，首次约 X 分钟，请勿关闭程序」（文案终稿届时供用户过目）。

### Phase 4 — 守卫固化（防复发）

- 新增 `rules/run-scoped-data-policy.md`：「对账类模块的 run 级批量数据**禁止写主库**，必须走 per-run 侧库」+ 侧库管理器使用约定。
- `rules/important-variables.md` 升格本次新符号（侧库管理器、路径常量、孤儿扫描入口等），更新受影响旧条目（§B.5.3）。
- 发版 checklist 增加启动指标确认项（activity log「启动耗时」基线对比）。

## B.5 影响范围

### B.5.1 代码

- 后端：`database.js` / `migrations.js` / `acquiring-bill-currency-db/*` / `biz-op-recon-db/*` / 各 session / `run-check-worker.js` / `main.js` 启动链与清理编排。
- 前端：loading 态 + init-done 门控（`renderer.js` 初始化入口）。
- 新增：侧库管理器模块（建议 `src/backend/run-data-store.js`）、`rules/run-scoped-data-policy.md`。

### B.5.2 数据（🔴 人工复核区）

- 三模块 run 数据存储位置变更；Phase 0 删除旧备份；历史数据双源过渡期读路径变更。
- 不可逆点必须在各 PR spec 中显式标注 + SR-backup-1 前置备份 + 8-status 迁移范式（沿用 v2.1.9/v2.1.10 惯例）。

### B.5.3 check-vars 预命中（提 PR 时逐条对照清单 review 要点）

`runCheckCore`、`cleanupAfterRunBackground`、`setupIdleCleanupTimer`、`clearStaleSuccessfulRawJson`、`ensureDiffRowsCascadeMigration_v2_1_10`、`acquiring_bill_currency_diff_rows` FK CASCADE schema、`bill_imports.raw_json`、`AppDatabase` / `AppDatabase.init`、`lastUserActivityTs` + `IDLE_CLEANUP_MS`、`app`（whenReady 链）。
⚠️ 注意：本 change 大量改动是**调用时序与数据位置**而非变量名——现版 check-vars 对此类改动命中弱（见 check-vars 评估），review 不能只依赖工具输出。

## B.6 技术决策

- **B-D1 侧库方案**：a) **per-run 独立文件（推荐）**——删文件即回收、零碎片、无 VACUUM、崩溃恢复=删孤儿文件；b) 单一侧库 + `auto_vacuum=INCREMENTAL`——仍有写放大与回收调度复杂度；c) 主库开 auto_vacuum——改造最小但回收不彻底（页面重排成本 + 不解决迁移备份 15GB 问题）。
- **为什么不是"VACUUM 一下完事"**：不治本——下一次百万行 run 再次膨胀；且 15GB VACUUM 在用户机不可控（分钟级、双倍磁盘峰值）。Phase 0 的 VACUUM 只是止血，结构性解法是数据出主库。
- **双库一致性**：主库 runs 元数据与侧库文件非同事务。以**侧库文件存在性为准**：启动孤儿扫描双向兜底（有文件无元数据 → 删文件；有元数据无文件 → 标记 run 失效）。用户手删侧库文件 → 对应 run 降级显示"数据已清理"，不崩溃。
- **可能风险**：worker 跨库访问的 PRAGMA/锁行为差异；双源读路径期间的 UI 列表合并；迁移窗口断电（8-status + 备份覆盖）。

## B.7 数据 / 状态 / 安全影响

- 状态流转：迁移沿用 8-status state machine + `createBackupFn` 注入 + app_settings 标志位幂等（v2.1.10 N4-cont-2 范式）。
- 回滚策略：
  - Phase 0/1/2：迁移失败 ROLLBACK + 前置备份保留；标志位不写 → 下次重试；
  - Phase 3：回退开关切回旧时序（B-D5）；
  - 侧库目录可整体删除回到"无历史 run"状态，不影响主库模板/设置/联动表数据。
- 权限/安全：无新增外部接口；侧库文件继承 `{userData}` 目录权限。

## B.8 验收与测试

1. **parity（资金红线核心）**：固定 fixture（含多币种/差异行/空流水边界）改造前后差异表 xlsx byte-for-byte 一致；diff_rows 行数与 summary 全等。
2. **体积**：跑一次 400 万行级 run → 主库增量 < 10MB；删 run → `run-data/` 文件消失、磁盘即时回收。
3. **启动指标**（activity log 自动记录 + `npm run startup:measure`）：升级首启 ≤ 3s；日常基线 ≤ 1.5s；Phase 3 后建窗 ≤ 300ms。
4. **兜底**：run 中途 kill 进程 → 重启孤儿扫描清理侧库文件 + 元数据一致；回退开关来回切换无残留。
5. **回归**：`npm run release-check` 全绿（smoke 19 suite + unit + integration）；三模块真实数据回放由用户手测循环确认（per memory 流程）。

## B.9 拍板清单（✅ 全部拍板，2026-06-12）

- [x] **B-D1** 侧库方案：✅ **a：独立侧库文件**（删文件回收，零碎片零 VACUUM；2026-06-12 修正：文件键 = 模块数据生命周期键，acquiring 为 per-month——见 §B.4 Phase 1 修正依据，用户拍板 A）
- [x] **B-D2** 历史 run 数据处置：✅ **b：双源过渡**（旧数据原地保留、新 run 走侧库、读路径先侧库后主库；双源移除 + 二次 VACUUM 收口顺延至 v3.0.5 之后的下一个版本）
- [x] **B-D3** 侧库路径/命名：✅ `{userData}/run-data/{module}/{生命周期键}.sqlite`（acquiring = `month-{YYYY-MM}.sqlite`；2026-06-12 随 B-D1 修正，原 `run-{id}` 命名废弃）
- [x] **B-D4** retention 归属：✅ **文件级二态**（成功 run 超保留期 → 直接删侧库文件 / 仅保留 diff 表，差异表历史重导出不丢）
- [x] **B-D5** Phase 3 回退开关：✅ **加**（setting/env 控新旧启动时序，稳定一版后移除）
- [x] **B-D6** 一次性 VACUUM：✅ **迁移式 + 状态框提示**（升级首启执行，app_settings 标志位幂等，UI 提示「正在优化数据库，首次约 X 分钟」）
- [x] **B-D7** 目标版本与 PR 切分：✅ **四个 Phase 全部落 v3.0.5**（Part A 1 PR + Phase 0-3 共 4 PR，串行；不切 v3.1.0，用户自定）
- [x] **B-D8** Phase 0 备份保留：✅ **保留最近 2 份**（mtime 排序，旧格式 `tool-data.sqlite.bak-*` 纳入同策略；启动后台清理，逐文件记 activity log）
