# tasks — v2.1.6 任务拆分

| 字段 | 值 |
|---|---|
| 文档版本 | v0.12（2026-05-20 — PR #50 round 1/2/3 reviewer findings 修复集中追溯）；v0.10 = fix15 月份弹窗标题三分支；v0.9 = fix14 UI 镜像布局；v0.8 = fix11/12/13 联合调整；v0.7 = fix5-fix10 任务追溯；v0.6-v0.1 起草 |
| 关联 PRD | `PRD-v2.1.6.md` |
| 关联 spec | `spec.md` |
| 工作分支 | `v2.1.6` |
| 起草人 | team-lead |

---

## 依赖图

```
[T0 起 PRD/spec/tasks 三件套] (✅ 本任务)
        │
        ├──── Module A（轻量，并行可做）─────┐
        │                                   ▼
        │   [T1 package.json 元数据] ──→ [T2 watermark helper + 8 writer 接入] ──→ [T3 log 头 + build 戳]
        │
        └──── Module B（重，严格串行）─────┐
                                            ▼
            [T4 SQLite migration] ──→ [T5 reader/validator] ──→ [T6 session/算法 ⚠️] ──→ [T7 writer ⚠️]
                                                                                            │
                                                                                            ▼
                                                          [T8 前端面板/dialog] ──→ [T9 IPC handlers/preload]
                                                                                            │
        ┌────────────────────────── 收口 ──────────────────────────────────────────────────┘
        ▼
[T10 smoke (A/B 两块)] ──→ [T11 preview 截图] ──→ [T12 三件套 + version bump + important-variables 同步]
        │
        ▼
[T13 self-review + /check-vars + PR 草稿入 docs/prs/]
```

---

## T0：起 PRD / spec / tasks 三件套

- **状态**：✅ 已完成（2026-05-18 起草 v0.1）
- **产物**：
  - `docs/iterations/v2.1.6/PRD-v2.1.6.md` v0.1
  - `docs/iterations/v2.1.6/spec.md` v0.1
  - `docs/iterations/v2.1.6/tasks.md` v0.1（本文件）
- **依赖**：13 项 spec 用户已拍板（2026-05-18）
- **下一步**：Dev 启动 T1（用户审 PRD 后）

---

## T1：Module A — package.json + electron-builder 元数据

- **状态**：⏳ 待启动
- **依赖**：T0
- **改动文件**：
  - `package.json`（加 `author` 字段 + `build.copyright` + `build.win.publisherName`）
- **关联 spec**：§2.5
- **验收标准**：
  - `npm run dist:win:portable` 产物在 Windows 右键→属性→详细信息显示 `pzhong` 作为 publisher
  - `package.json` 含完整 `author.name` / `author.email`
- **风险**：🟢 低
- **预估**：0.5h

---

## T2：Module A — watermark helper + 8 writer 接入

- **状态**：⏳ 待启动
- **依赖**：T1
- **新建文件**：
  - `src/main-process/workbook-watermark.js`（~20 行，spec §2.1）
- **改动文件**（8 个 writer，共 ~15 处 `writeFile` 调用前加 `applyWatermark(wb)`）：
  - `src/backend/file-service/writers.js`
  - `src/main.js`（行 6104 附近）
  - `src/main-process/pending-session.js`（行 94, 268）
  - `src/backend/pending-export/writer.js`
  - `src/main-process/recon-id-fix-io.js`（行 259, 300）
  - `src/main-process/exceljs-writer.js`（行 63, 89）
  - `src/main-process/bank-bu-recon-writer.js`（行 110, 158）
  - `src/main-process/biz-op-recon-writer.js`（行 68, 139, 209, 234）
- **关联 spec**：§2.1 / §2.2
- **验收标准**：
  - grep `writeFile` 全局确认所有调用点前都有 `applyWatermark(wb)`
  - smoke A1 通过：任意模块导出文件用 Excel 打开 → 属性 → 修改者 = `pzhong`
- **风险**：🟢 低（纯元数据）
- **预估**：2h

---

## T3：Module A — log 头 + build 戳

- **状态**：⏳ 待启动
- **依赖**：T2
- **新建文件**：
  - `scripts/gen-build-info.js`（spec §2.4）
- **改动文件**：
  - `package.json` 加 `prebuild:meta` script + 改 `dist:win*` 串入 `prebuild:meta`
  - `.gitignore` 加 `src/build-info.js`
  - `src/main.js`（启动期紧贴 `应用启动 | 版本` 日志后加一条 `appendActivityRecord(... crafted by pzhong ...)`）
- **关联 spec**：§2.3 / §2.4
- **验收标准**：
  - `npm run prebuild:meta` 后 `src/build-info.js` 存在且含正确 commit
  - 启动应用 → `app_activity_log.txt` 新增行 `[INFO] crafted by pzhong (pzhong1212@gmail.com) · build {sha}`（smoke A2）
  - dev 期（无 git）build_info.commit = `'dev'`，不报错
- **风险**：🟢 低
- **预估**：1h

---

## T4：Module B — SQLite migration（4 张表）

- **状态**：⏳ 待启动
- **依赖**：T0
- **改动文件**：
  - `src/backend/database/migrations.js`（加新 migration `migration_v2_1_6_acquiring_bill_currency`）
- **关联 spec**：§四（4 张 DDL + 索引）
- **验收标准**：
  - 启动应用 → 4 张表存在 + 3 个索引存在（用 `sqlite3 tool-data.sqlite ".schema acquiring_bill_currency_*"` 验证）
  - 多次启动 migration 幂等（不报错 / 不重复）
  - UNIQUE 约束生效（手动 INSERT 重复 ID 失败）
- **风险**：🟡 中（DDL 改 schema）
- **预估**：2h

---

## T5：Module B — reader（流式 ExcelJS）+ validator

- **状态**：⏳ 待启动
- **依赖**：T4
- **新建文件**：
  - `src/backend/acquiring-bill-currency-import/reader.js`（流式读 xlsx + 解析两表）
  - `src/backend/acquiring-bill-currency-import/validator.js`（表头一致性 + 主Id 唯一性 + 月份归属一致性）
  - `src/backend/acquiring-bill-currency-db/columns.js`（字段映射常量，spec §3.1 / §3.2）
  - `src/backend/acquiring-bill-currency-db/import-repository.js`（批量 INSERT，事务，UNIQUE 失败时 ROLLBACK）
- **关联 spec**：§3.1 / §3.2 / §3.3 / §4.1 / §4.2
- **验收标准**：
  - 单 xlsx 100w 行峰值内存 < 300MB（dryrun 验证）
  - 主Id 重复 → 整批 ROLLBACK + error_report 写出（含具体重复 ID 列表）
  - 表头不匹配 → 整批拒绝 + error_report
  - 跨月份混杂 → 整批拒绝
  - 流水入库时 `recon_amount_abs` 已正确 ABS（resp. spec §3.1）⚠️ 资金红线
- **风险**：🔴 HIGH（资金红线 — 金额 ABS 在入库阶段）
- **预估**：1d

---

## T6：Module B — session + 对账算法 ⚠️ 资金红线

- **状态**：⏳ 待启动
- **依赖**：T5
- **新建文件**：
  - `src/main-process/acquiring-bill-currency-session.js`（session 管理 + `runAcquiringCurrencyCheck`）
  - `src/backend/acquiring-bill-currency-db/run-repository.js`（写 runs + diff_rows）
- **关联 spec**：§5.1 / §5.2 / §5.3
- **验收标准**：
  - 核心 SQL（spec §5.2）实测：500w × 500w JOIN 时间 ≤ 30s（dryrun）
  - 币种归一函数（spec §5.3）正确处理 `usd` ≡ `USD` ≡ `USD `
  - diff_rows 写入时 `flow_currency` = 流水侧原值（不归一）；`flow_amount_abs` = 流水侧 ABS 值
  - smoke C 通过：单据币种缺失行 diff_type = `bill_currency_missing`
- **风险**：🔴 HIGH（资金红线 — 核心比对逻辑）
- **预估**：1.5d

---

## T7：Module B — writer（流式 ExcelJS 输出差异表，29 列 + 仅差异行） ⚠️ 资金红线

- **状态**：⏳ 待启动
- **依赖**：T6
- **新建文件**：
  - `src/main-process/acquiring-bill-currency-writer.js`（spec §六）
- **关联 spec**：§6.1 / §6.2 / §6.3 / §3.1 / §3.2
- **验收标准**：
  - 输出 xlsx 含 **29 列**（原 26 列 + 末尾 3 列对比区）
  - 第 27 列名 = `单据_对账币种`（copy 自单据 raw 第 20 列）
  - 第 28 列名 = `流水币种`
  - 第 29 列名 = `流水金额绝对值`
  - **不导出**`单据_对账金额` copy 列（用户决策；金额信息已在原第 19 列）
  - **仅含差异行**（diff_type ∈ `currency_mismatch` / `bill_currency_missing`）；币种一致行不入表；unmatched 不入表
  - 1 对 1 输出：3 个输入单据 xlsx → 3 个差异 xlsx（若某文件 0 差异行 → 仍输出含 29 列表头的空表）
  - writer 内已 apply watermark（Module A helper），`lastModifiedBy = 'pzhong'`
  - 输出路径 = `Documents/网银账单生成小助手/exports/{date}/acquiring-bill-currency/`
  - 输出文件名 = `{原文件名}-diff-{YYYYMMDD-HHMMSS}.xlsx`
- **风险**：🔴 HIGH（资金红线 — 列名/列序/值写入）
- **预估**：1d

---

## T8：Module B — 前端面板 + dialog

- **状态**：⏳ 待启动
- **依赖**：T7（实际可与 T7 并行，但需先有 IPC 占位）
- **改动文件**：
  - `index.html`（加 `acquiringBillCurrencyModulePanel` section + 模块切换器选项）
  - `src/renderer.js`（加 MODULES 第 8 项 + state 字段 + 事件绑定）
  - `src/renderer-dialogs.js`（导入文件多选 + 月份选择 + 结果展示）
  - `src/styles*.css`（如需，复用 bankBuRecon 样式）
- **关联 spec**：§八
- **验收标准**：
  - 模块切换器显示「收单单据币种校验」
  - 4 个按钮交互正确（disabled 状态机如 spec §8.2）
  - 月份下拉框枚举正确（同时刷新流水 + 单据已导入月份）
  - 状态栏文案与 spec §8.3 一致
  - 错误时状态栏红色 + 可触发 error_report 导出
- **风险**：🟡 中
- **预估**：1d

---

## T9：Module B — IPC handlers + preload

- **状态**：⏳ 待启动
- **依赖**：T8
- **改动文件**：
  - `src/main.js`（加 7 个 ipcMain.handle）
  - `src/preload.js`（contextBridge 加 `acquiringBillCurrency` 命名空间）
- **关联 spec**：§七
- **验收标准**：
  - 7 个 IPC channel 与 spec §七一致
  - preload 暴露 `desktopApi.acquiringBillCurrency` 含 7 个方法
  - 启动应用从 renderer 调用每个 IPC 不报 `No handler registered`
- **风险**：🟡 中
- **预估**：0.5d

---

## T10：smoke 测试

- **状态**：⏳ 待启动
- **依赖**：T2 / T3 / T9（全部 Dev 收口）
- **改动/新建文件**：
  - `scripts/smoke/acquiring-bill-currency.js`（新建，含 spec §九 的 Case A-G + A1/A2）
  - `scripts/smoke-test.js`（如有入口，串入）
- **关联 spec**：§九
- **验收标准**：
  - Case A-G 全部通过
  - Module A 的 A1（任意模块导出 xlsx 含 `pzhong`）+ A2（log 含 `crafted by pzhong`）通过
  - 资金红线 Case B/C/D 强制覆盖
- **风险**：🟡 中（测试覆盖完整性）
- **预估**：0.5d

---

## T11：preview 截图 + 接入 `preview:all`

- **状态**：⏳ 待启动
- **依赖**：T8
- **新建文件**：
  - `scripts/preview/preview-acquiring-bill-currency.js`（新模块 4 张截图渲染）
- **改动文件**：
  - `package.json` scripts 加 `preview:acquiring-bill-currency`
  - `scripts/preview/preview-all.js`（或同名汇总脚本）串入新 preview
- **关联 spec**：§十一
- **验收标准**：
  - `npm run preview:acquiring-bill-currency` 产出 4 张 png
  - `npm run preview:all` 包含本模块
  - （按 memory `workflow_frontend_previews`）凡 renderer 改动必须重跑 previews
- **风险**：🟢 低
- **预估**：0.5h

---

## T12：文档三件套 + version bump + important-variables 同步

- **状态**：⏳ 待启动
- **依赖**：T10 / T11
- **改动文件**：
  - `package.json`（version 2.1.5 → 2.1.6）
  - `package-lock.json`（同步）
  - `CHANGELOG.md`（新增 v2.1.6 段）
  - `docs/VERSION_FEATURE_HISTORY.md`（同上）
  - `docs/USER_GUIDE.md`（新增「收单单据币种校验」章节）
  - `rules/important-variables.md`（新增 spec §10.1 列出的 4 条）
- **关联 spec**：§十 / §十一 / PRD §四
- **验收标准**：
  - 三件套版本号与 package.json 一致
  - USER_GUIDE 含完整使用流程（截图引用 preview 产物）
  - important-variables 新增 4 条且 `npm run scan:vars` 重跑成功
- **风险**：🟢 低
- **预估**：1h

---

## T13：self-review + `/check-vars` + PR 草稿

- **状态**：⏳ 待启动
- **依赖**：T12
- **流程**（按 memory `workflow_no_tester_no_auto_pr`）：
  1. self-review：grep / 文档对齐 / smoke 再跑一次
  2. `npm run check:vars` → 拿到「⚠️ 关联功能 review」段
  3. 起 `docs/prs/待merge-PR #NN.md`（按 memory `workflow_archive_pr_draft`，PR 号留待提 PR 时回填）
  4. **不主动 push、不主动 gh pr create**；等用户明确说"提 PR"
- **关联 spec**：§十
- **验收标准**：
  - PR 草稿含 ⚠️ 资金红线声明 + 关联功能 review 段 + smoke 截图 + preview 链接
  - check-vars 输出无遗漏
  - 等用户手动测试 + 显式"提 PR"指令后 team-lead 才能 push + gh pr create
- **风险**：🟢 低
- **预估**：0.5d

---

## T-fix1：单据/流水导入预检 + 覆盖确认（用户实测发现 UX 漏洞）

- **状态**：🔄 进行中（2026-05-18 起）
- **触发**：用户实测发现"二次导入相同月份的单据表/流水表"时第一行即撞 UNIQUE constraint → 整批 ROLLBACK，错误信息不引导用户去清月（spec §七 `clearMonth` IPC 已存在但 UI 未接）
- **关联 spec**：§3.4「重复导入检测」+ §七 IPC（入参 + 出参修订）+ §8.3-8.4「覆盖确认弹窗」+ §九 Case H1/H2/H3
- **关联 PRD**：§3.4 B-Q10

### T-fix1.1：reverse sync spec/PRD/tasks ✅ 已完成

- spec.md v0.4：§3.4 / §七 IPC / §8.3-8.4 / §九 Case H1/H2/H3 / 变更记录
- PRD-v2.1.6.md v0.4：§3.4 B-Q10 + 变更记录
- tasks.md：本章节 + 变更记录 v0.4

### T-fix1.2：backend 实现 — peek monthKey + importBill/Flow IPC 改造

- **文件**：
  - `src/backend/acquiring-bill-currency-import/reader.js`：新增 `peekMonthKeyFromFile({ filePath, kind })`（读首文件首行 + 表头校验，不 INSERT；返回 `{ monthKey, sourceFile }`）
  - `src/main.js`：`acquiringBillCurrency:importFlow` / `acquiringBillCurrency:importBill` 两个 handler 改造（dialog → peek → getMonthReadiness → 分支：直接 / overwrite-required / 清侧+导入）
  - `src/preload.js`：`importFlow` / `importBill` 接受 `(payload)` 入参
  - 复用 `importRepo.getMonthReadiness` 查 flowCount/billCount
- **关键不变量**：
  - 第二次调用（confirmOverwrite=true）**仅 DELETE 对应单侧**（流水或单据），不连带清 runs/diff_rows
  - peek 失败 → 直接返回 `{ status: 'error' }`，不进事务
- **验收标准**：跑 smoke H1/H2/H3 通过
- **预估**：1h

### T-fix1.3：renderer 覆盖确认弹窗

- **文件**：`src/renderer.js`
- **handler 改造**：
  - `acquiringBillCurrencyImportFlowBtn` / `ImportBillBtn` 的 click handler 检查 IPC 返回 status
  - `overwrite-required` → `window.confirm`（文案见 spec §8.4）→ 用户确认 → 二次调 `importFlow/importBill({ filePaths, confirmOverwrite: true })`
  - 二次调用后刷新 month select + status box（沿用 `refreshAcquiringBillCurrencyMonths` / `refreshAcquiringBillCurrencyStatus`）
- **状态文案**：状态栏在 overwrite-required 时显示「等待用户确认」（spec §8.3 新增行）
- **验收标准**：手动回归通过；renderer 不在 cancelled / error 分支下意外清 DB
- **预估**：30min

### T-fix1.4：smoke + 手动回归

- **smoke 文件**：`scripts/smoke/acquiring-bill-currency.js` 加 3 个用例（H1/H2/H3）
- **手动回归**：
  - 启动应用 → 切到「收单单据币种校验」模块
  - 导入流水 + 单据（happy path）
  - 同月份再次导入单据 → 弹窗确认 → 覆盖成功（H2）
  - 同月份再次导入单据 → 弹窗取消 → DB 不变（H1）
- **验收标准**：`npm run smoke` 全绿；手动回归 4 个 case 通过
- **预估**：1h

### T-fix1.5：更新 PR #50 草稿 + CHANGELOG + check-vars

- `docs/prs/待merge-PR #50.md`：补 fix1 commits 列表 + 改动文件清单
- `CHANGELOG.md` v2.1.6 段：补「修复：单据/流水二次导入相同月份时 UNIQUE 报错无引导 → 改为预检 + 覆盖确认」
- `npm run check:vars`（`recon_main_id` 是 Important-skeleton，fix1 改动 reader/IPC 命中 Module B 关联）
- **预估**：30min

**T-fix1 工时合计**：~3h

---

## T-fix2：reader 选型变更 — yauzl + sax 流式（spec §3.5）

- **状态**：🔄 进行中（2026-05-18 起）
- **触发**：用户实测发现真实数据规模（30w 行/文件 + inlineStr 格式 + 800MB 解压 + POI 流式写 ZIP data descriptor）下 SheetJS dense 完全跑不动；ExcelJS streaming（unzipper）同样失败。原 spec §3.7 性能预估假设错误
- **关联 spec**：§3.5「Reader 实现（fix2）」+ §3.7 性能预估修订
- **关联 PRD**：§3.6 风险表 + §3.7 性能预估

### T-fix2.1：reverse sync spec/PRD/tasks ✅ 已完成

- spec.md v0.5：§3.5 新增 reader 实现章节 + §3.4 peek 性能段修订 + 变更记录
- PRD-v2.1.6.md v0.5：§3.7 性能预估全部废弃重写 + §3.6 风险表更新 + 变更记录
- tasks.md：T-fix2 章节 + 变更记录 v0.5

### T-fix2.2：装依赖 — yauzl + sax

- `npm install yauzl sax`（顶层依赖；yauzl 当前是 electron→extract-zip 的 transitive）
- 验证无 native 编译需求（Windows 兼容性）
- 跑 `npm run smoke` + `npm start` 确认无 break
- **预估**：15min

### T-fix2.3：reader 重写 — yauzl ZIP 流式 + sax XML 流式

- `src/backend/acquiring-bill-currency-import/reader.js` 完全重写：
  - `peekMonthKeyFromFile({ kind, filePath })` → yauzl 打开 → 找 `xl/worksheets/sheet1.xml` → sax 流式解析到首条数据行的"账单日期" → 立即停 sax + 释放 yauzl
  - `importFlowFile / importBillFile({ db, filePath, importedAt, expectedMonthKey, onProgress })` → yauzl + sax 流式解析全文件，每行调 prepared `insertRow`（事务由 caller 持有）
  - 识别 cell 类型：`inlineStr` / `s` / `str` / `b` / `e` / 默认数字（详 spec §3.5 表）
  - 空 cell 按 `r` 属性补齐
- **接口契约不变**：return `{ sourceFile, monthKey, importedCount }`；ImportValidationError 累积错误（最多 100 条）
- **关键不变量**：保持 fix1 的 peek 早退出 / 不进事务行为
- **预估**：3h

### T-fix2.4：smoke 补充 — inlineStr + data descriptor

- `scripts/smoke/acquiring-bill-currency.js` 加：
  - Case I：inlineStr 格式 xlsx（人工构造 `<is><t>VALUE</t></is>` 格式 sheet1.xml） → 验证 SAX 解析正确
  - Case J：data descriptor 模式 ZIP（参考用户文件结构构造） → 验证 yauzl 能解析
- 既有 Case A-H 全部通过（reader 接口未变，session/import-repo 行为不变）
- **预估**：1.5h

### T-fix2.5：真实数据回归（用户主导）

- 用户跑 `/Users/pzhong/Desktop/小助手-Debug/2.1.6/3月流水表/*.xlsx` 16 个文件（~480w 行）端到端
- 验收：
  - 导入流水 + 单据 + 跑 run + 导出差异 全程无异常
  - 内存峰值 < 200MB（流式）
  - 总耗时合理（spec §3.7 修订后预估 8-15 min）
- 回填 spec §3.7 实测数据
- **预估**：1h（用户操作 + 监控）

### T-fix2.6：更新 PR #50 + CHANGELOG + scan:vars

- `docs/prs/待merge-PR #50.md`：补 fix2 改动 + 性能基线修正 + 选型决策更新
- `CHANGELOG.md` v2.1.6 段：补 fix2 选型变更
- `package.json` dependencies 加 yauzl + sax（脚本提示）
- `npm run scan:vars` 刷新（fix2 改 reader）
- `npm run check:vars`（recon_main_id 仍 Important-skeleton 命中）
- **预估**：30min

**T-fix2 工时合计**：~6h

---

## T-fix4：对账字段切换 — settle_currency / settle_amount（spec §3.1/§4/§5/§6/§10）

- **状态**：🔄 进行中（2026-05-19 起）
- **触发**：用户在 v0.6 reader 跑通后对账显示「零差异」（466 万行 100% match），实测发现是字段语义错位（用「币种」= 订单视角对账，而单据「对账币种」本就是清算视角）→ 必须切换到「通道清算币种」+「通道清算金额」（清算视角）
- **关联 spec**：§3.1 ★ 标移位 / §4.1/4.2 schema 重命名 / §5.2 SQL JOIN / §6.2 输出列名
- **关联 PRD**：§3.4 B-Q11 / §3.6 风险表新增 HIGH 项
- **预估差异规模**：~259 万行 mismatch（v0.6 = 0 → v0.7 = ~56% bill）

### T-fix4.1：reverse sync spec/PRD/tasks ✅ 已完成

- spec.md v0.7：§3.1 ★ 标移到 29/30 列，§4.1/4.2 schema 重命名，§5.2 SQL 字段同步，§6.2 输出列名加「_通道清算」前缀，§九 Case J/K/L，§十 important-variables 同步，变更记录
- PRD-v2.1.6.md v0.6：§3.4 B-Q11，§3.6 风险表加 HIGH 项，变更记录
- tasks.md：本章节 + 工时合计 + 变更记录 v0.6

### T-fix4.2：migration — ALTER COLUMN 重命名

- `src/backend/database/migrations.js`：
  - 加 `ensureAcquiringBillCurrencyFix4ColumnsRename(db)` 幂等 migration
  - 用 `PRAGMA table_info` 检查列名（已有 settle_amount 跳过；存在 recon_amount 执行 ALTER）
  - 流水侧 ALTER 4 列：recon_amount → settle_amount / recon_amount_abs → settle_amount_abs / currency → settle_currency / currency_norm → settle_currency_norm
  - 单据侧 ALTER 2 列：currency → settle_currency / currency_norm → settle_currency_norm
  - 同步 `CREATE TABLE IF NOT EXISTS` 中的列名（保证新机器初始化正确）
- **预估**：30min

### T-fix4.3：columns/import-repo/run-repo/writer 改造

- `columns.js`：
  - FLOW_KEY_COLUMNS：`currency: '币种'` → `settleCurrency: '通道清算币种'` / `reconAmount: '对账金额'` → `settleAmount: '通道清算金额'`
  - 旧 key 名 `currency` / `reconAmount` → `settleCurrency` / `settleAmount`
  - WRITER_OUTPUT_FLOW_CURRENCY_HEADER: '流水币种' → '流水_通道清算币种'
  - WRITER_OUTPUT_FLOW_AMOUNT_ABS_HEADER: '流水金额绝对值' → '流水_通道清算金额'
- `import-repository.js`：
  - FLOW_INSERT_SQL / BILL_INSERT_SQL 列名更新
  - insertFlowRow：`values[12]` → `values[28]`（金额）/ `values[13]` → `values[29]`（币种）
  - getMonthReadiness 字段名同步
- `run-repository.js`：4 处 SQL 字段名同步（insertDiffRowsByJoin / computeRunStats / getDiffRowsForFile / 等）
- writer.js：列名 hardcode 改
- **预估**：1.5h

### T-fix4.4：smoke 加 Case J/K/L

- `scripts/smoke/acquiring-bill-currency.js`：
  - makeFlow helper：原 r[12]/r[13] 保留填值，新加 r[28]/r[29]（默认同 r[12]/r[13]，保证 Case A-I 向后兼容）
  - Case J：flow.[13]=USD + flow.[29]=EUR + bill.[19]=EUR → matched, mismatch=0
  - Case K：flow.[29]=USD + bill.[19]=EUR → mismatch=1, diff_rows.flow_currency='USD'
  - Case L：flow.[29]='' + bill.[19]=EUR → mismatch=1, diff_type='currency_mismatch'
- 跑 npm run smoke 全绿
- **预估**：1h

### T-fix4.5：真实数据回归（用户主导）

- 用户重启 npm start
- DevTools 调 `clearMonth({ monthKey: '2026-03' })` 或 UI「清月」
- 重导 16 流水 + N 单据 xlsx
- 跑「开始运行」预期 mismatch ~259 万行
- 导出差异 xlsx 抽样验证「流水_通道清算币种」「流水_通道清算金额」列值
- **预估**：30min（用户操作）

### T-fix4.6：更新 PR #50 + CHANGELOG + scan:vars + check:vars

- PR 草稿补 fix4 改动 + spec v0.7
- CHANGELOG.md v2.1.6 段补 fix4
- rules/important-variables.md 字段名同步（recon_amount_abs → settle_amount_abs；新增 settle_currency 条目）
- npm run scan:vars 刷新
- npm run check:vars 跑一遍
- **预估**：30min

**T-fix4 工时合计**：~4h

---

## T-fix10：启动期孤儿数据 cleanup（用户实测 OOM 闪退 + 重启撑爆磁盘）

**背景**：fix7 之前 OOM 闪退 → DB 残留 4.6M flow + 4.6M bill + 2.6M diff_rows ≈ 15 GB → 磁盘 97% 满 → 下次 INSERT `database or disk is full`。fix8/fix9 只覆盖「run 成功后」清理路径，闪退/中断场景无人善后。

### T-fix10.1：reverse sync spec/PRD/tasks ✅ 已完成

- spec.md v0.13 + §5.4「启动期孤儿数据 cleanup」+ smoke Case Q + 变更记录
- PRD v0.7 集中追溯 fix5-fix10
- tasks v0.7 + 本节
- **预估**：1h

### T-fix10.2：cleanupOrphanData + 启动钩子

- src/main-process/acquiring-bill-currency-session.js 新增 `cleanupOrphanData({ db, onProgress })`：扫 `runs WHERE status != 'success'` 找孤儿 → 复用 fix9 `cleanupAfterRunBackground` 分批 DELETE flow/bill/diff_rows → DELETE runs 记录本身 → 兜底扫没 success run 关联的孤儿 imports
- src/main.js `app.whenReady` + migration 后 `setImmediate` 后台异步触发；acquire `'cleanup'` lock；状态栏文案；finally 释放 lock；抛错只记 log 不阻塞
- **预估**：2h

### T-fix10.3：smoke Case Q

- scripts/smoke/acquiring-bill-currency.js：手工 INSERT 一个 run（status='running'）+ 关联 imports/diff_rows + 另一个 success run（验证不被误清）→ 调 cleanupOrphanData → 断言孤儿全清 + success run 数据保留
- **预估**：1h

### T-fix10.4：更新 PR #50 + CHANGELOG + scan:vars + check:vars

- PR 草稿补 fix10 段
- CHANGELOG.md v2.1.6 段补 fix10
- npm run scan:vars 刷新
- npm run check:vars 跑一遍
- **预估**：30min

**T-fix10 工时合计**：~4.5h

---

## T-fix11/12/13：writer 多 sheet + 时区修复 + report 嵌入末尾 sheet

**背景**：用户 v0.13 实测 260w 差异行单 sheet → Excel 显示上限 1,048,576 截断；ran_at UTC 差 8 小时；report 用户希望嵌入 diff 末尾。三个问题耦合在 writer 层，一次性改造。

### T-fix11/12/13.1：spec/PRD/tasks reverse sync v0.14 ✅ 已完成

- spec.md v0.14：§6.3 改为「N+1 sheet」+ §6.3.1 fix11 切分算法 + §6.3.2 fix13 嵌入 sheet + §6.4 fix13 路径变更 + §6.6 fix12 时区处理；smoke Case R/S/T；变更记录 v0.14
- PRD v0.8、tasks v0.8 变更记录
- **预估**：1h

### T-fix11.2：writer 多 sheet 集成（按账单日期切分）

- writer.js writeDiffWorkbook 改造（仍用 ExcelJS streaming writer 单 workbook）
- run-repository.js 加 `getBillDateCounts({ db, runId })` + `listDiffRowsByDateRange({ db, runId, startDate, endDate, limit, offset })`
- 贪心切分算法 + sheet 命名 `YYYY-MM-DD~MM-DD`
- 资金红线断言：sum(sheet rows) == mismatch_rows
- **预估**：2h

### T-fix12.2：ran_at 时区修复

- run-repository.js insertRun 接 ranAt 参数
- session.js runCheck 调用处传 `new Date().toISOString()`
- writer.js 加 `formatRanAtLocal` 辅助函数
- 兼容旧无 Z 字符串当 UTC 解析
- **预估**：1h

### T-fix13.2：report 嵌入 diff 末尾 sheet

- writer.js writeRunOutputs 合并：writeDiffWorkbook 末尾 addWorksheet('运行结果汇总') + 写 11 区块
- 不再独立调 writeReportWorkbook（保留函数但内部调用改）
- exports 目录不再生成 report/ 子目录
- runs.report_file_path = diff_file_path（指向同文件）
- **预估**：1.5h

### T-fix11/12/13.3：smoke Case R/S/T

- Case R（fix11）：fixture 跨日期 + 强制 ≥ 1M 行（用降低阈值或扩 fixture 行数）+ 断言多 sheet + sum==mismatch
- Case S（fix12）：跑 run 后断言 runs.ran_at 含 'Z' + writer 显示是本地时间
- Case T（fix13）：跑 run 后断言 diff xlsx 末尾 sheet = '运行结果汇总' + 119 行 + 不存在 report/ 子目录
- 既有 Case A/D/N/P 兼容性回归（writer 输出形态变了，多 sheet + 末尾 summary）
- **预估**：1.5h

### T-fix11/12/13.4：PR/CHANGELOG/scan:vars/check:vars

- PR #50 草稿补 fix11/12/13 段
- CHANGELOG.md 加三段
- npm run scan:vars 刷新
- npm run check:vars
- **预估**：30min

**T-fix11/12/13 工时合计**：~7.5h

---

## 工时合计

| 类别 | 工时 |
|---|---|
| Module A（T1-T3） | ~3.5h |
| Module B Dev（T4-T9） | ~5d |
| 测试 + preview + 文档（T10-T12） | ~1d |
| Review + PR 草稿（T13） | ~0.5d |
| **fix1（用户实测发现）** | **~3h** |
| **fix2（用户实测 reader 选型错）** | **~6h** |
| **fix3（并发触发嵌套事务）** | **~1h** |
| **fix4（对账字段语义错位）** | **~4h** |
| **fix5（UX 重构 + 输出形态反转）** | **~6h** |
| **fix6（通道清算金额允空）** | **~1h** |
| **fix7（diff writer OOM 修复）** | **~2h** |
| **fix8（run 后清原始数据）** | **~2h** |
| **fix9（cleanup 异步 + 通用 lock）** | **~3h** |
| **fix10（启动期孤儿 cleanup）** | **~4.5h** |
| **fix11+12+13（writer 多 sheet + 时区 + report 嵌入）** | **~7.5h** |
| **合计** | **~7-8 工作日 + fix1-13 ≈ 40h** |

---

## 文档变更记录

| 版本 | 日期 | 修订 |
|---|---|---|
| v0.1 | 2026-05-18 | 起草 |
| v0.2 | 2026-05-18 | ① 全套命名 acquiring-currency → acquiring-bill-currency；② T7 验收标准 28 列 → 30 列 + 仅差异行 + 4 列对比区 + `-diff-` 文件名；其他 task 未受影响 |
| v0.3 | 2026-05-18 | 用户决策：去掉「单据_对账金额」copy 列。T7 验收标准 30 列 → 29 列 / 末尾 4 列对比区 → 末尾 3 列对比区（27 单据_对账币种 / 28 流水币种 / 29 流水金额绝对值）；其他 task 未受影响 |
| v0.4 | 2026-05-18 | **fix1**：用户实测发现"二次导入相同月份 → UNIQUE 整批拒绝 + 无 UI 引导"。新增 T-fix1（5 个子任务：spec sync / backend peek+IPC / renderer 弹窗 / smoke H1-H3 / PR 草稿更新），工时 +3h |
| v0.5 | 2026-05-18 | **fix2 reader 选型变更**：用户实测发现 SheetJS dense 假设错（30w 行 inlineStr xlsx + POI ZIP data descriptor 不兼容）。新增 T-fix2（6 个子任务：spec/PRD sync / 装 yauzl+sax / reader 重写 / smoke I+J / 真实数据回归 / PR 更新），工时 +6h |
| v0.6 | 2026-05-19 | **fix4 对账字段切换**：用户实测 v0.6 零差异 = 字段语义错位。新增 T-fix4（6 个子任务：spec/PRD/tasks sync / migration ALTER COLUMN / columns+repo+writer 改造 / smoke J/K/L / 清月重导 / PR 更新），工时 +4h |
| v0.7 | 2026-05-19 | **fix5-fix10 集中追溯**（前期 fix5-fix9 task 子项未单独建，本次一并 catch-up + 加 T-fix10）：fix5 UX 重构（删月份下拉/导入弹窗/输出形态反转，~6h）+ fix6 通道清算金额允空（~1h）+ fix7 diff writer OOM 修复（~2h）+ fix8 run 后清原始数据（~2h）+ fix9 cleanup 异步 + 通用 lock（~3h）+ fix10 启动期孤儿 cleanup（~4.5h）。新增 T-fix10 节 4 个子任务；工时合计表全套补齐 |
| v0.8 | 2026-05-20 | **fix11/12/13 联合调整**：fix11 writer 按账单日期切分多 sheet（≤ 1M 行/sheet）+ sheet 名 `YYYY-MM-DD~MM-DD` + 资金红线 sum==mismatch_rows；fix12 ran_at 用 ISO 8601 带 Z + writer 显示转本地（formatRanAtLocal）；fix13 report 嵌入 diff 末尾 sheet「运行结果汇总」+ 不再生成独立 report.xlsx + exports 去掉 report/ 子目录。新增 T-fix11/12/13 节 5 个子任务（spec sync / fix11 writer / fix12 ran_at / fix13 嵌入 / smoke R/S/T / PR 收尾），工时 +7.5h |
| v0.9 | 2026-05-20 | **fix14 UI 镜像布局**：以 bank-statement-board 为模板左右镜像，2 行 × 2 cell grid，4 按钮 min-width 140px 统一（覆盖 secondary 默认 180px）；index.html acquiringBillCurrencyModulePanel 重写 + styles-gemini-extra.css 加 .acquiring-bill-currency-board 规则段；renderer 零改动（按钮 ID 全保留）；先 mockup 后实施。新增 T-fix14 节 5 子任务（spec sync / html+css / preview / smoke / PR），工时 +2h |
| v0.10 | 2026-05-20 | **fix15 月份选择弹窗标题三分支**：renderer-dialogs.js `createAcquiringBillCurrencyMonthPickerDialog` 标题文案 2 分支扩 3 分支（'导入' → '请选择导入文件的月份'）。工时 +0.5h |
| v0.11 | 2026-05-20 | **PR #50 round 1 reviewer findings 修复**（F1 P1 + F2 P1 + F3 P2）：smoke cleanup helper 解 Windows CI EBUSY / 账单日期归一化 / USER_GUIDE 同步。smoke 145 → 161（+16）。工时 +1.5h |
| v0.12 | 2026-05-20 | **PR #50 round 2 + round 3 reviewer findings 修复**：round 2（NewF1 P1 spec Case O 描述错只修文档 / CodexP1 P1 sub-sheet 切分 / NewF2 P2 success-no-files / NewF3 P2 header detailLines 透传 / CodexP2 P2 不完整修复）+ round 3（NewF1 P2 sax 层 header dynamic array 真正修复列多严格校验）。smoke 161 → 168（+7） → 172（+4）。工时 +2h |
