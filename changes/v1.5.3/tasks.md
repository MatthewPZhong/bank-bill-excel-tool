# Tasks — v1.5.3

> v1 定稿阶段任务清单。每个 task 一 commit，commit message 推荐格式：`[v1.5.3] <简述>`。
>
> **实施顺序**（按依赖链 + 风险由低到高）：**G2 → G1 → G3**
> - G2（R2 基础设施）：schema + 数据迁移 + 仓库层参数扩展是 R1 的前置依赖
> - G1（R1 月度余额）：依赖 G2.5（`getTemplateBigAccounts` 加 `includeOwn` 参数）
> - G3（R3 表头字体）：最后做，改动 `writers.js` 减少与 R1 验证的干扰
>
> **总任务数**：24 条（G2=10 条、G1=9 条、G3=5 条）
>
> 所有 task 完成后的 commit 树预期约 24 个独立 commit。

---

## G2 — 需求 R2：自有账号合并入大账号表（先做）

### Task T2.1 — Schema 迁移函数 `ensureTemplateBigAccountNatureSupport`
- 目标：给 `template_big_accounts` 加 `account_nature TEXT NOT NULL DEFAULT 'client'` 列（幂等）
- 涉及文件：
  - `src/backend/database/migrations.js`：新增 `ensureTemplateBigAccountNatureSupport(db)` 函数（参考 `:293 ensureTemplateFilenameFixedFieldSupport`）
  - `src/backend/database/migrations.js:299-311 module.exports`：导出新函数
- 操作：`ALTER TABLE template_big_accounts ADD COLUMN account_nature TEXT NOT NULL DEFAULT 'client';` 用 `hasColumn` 判定幂等
- 验证证据：
  - 新建空库启动 → 列不存在 → ALTER 执行 → `PRAGMA table_info(template_big_accounts)` 显示新列
  - 重启 → 列已存在 → 函数 short-circuit，无 SQL 执行
- 依赖：无
- 状态：todo

### Task T2.2 — 门面层注册迁移
- 目标：在 `database.init()` 链路注册新迁移
- 涉及文件：
  - `src/backend/database.js:16 import`：新增 `ensureTemplateBigAccountNatureSupport`
  - `src/backend/database.js:100-105 init()`：在 `ensureTemplateFilenameFixedFieldSupport` 之后调用 `this.ensureTemplateBigAccountNatureSupport()`
  - `src/backend/database.js:143-145` 附近：新增门面方法
- 操作：参考现有 `ensureTemplateFilenameFixedFieldSupport` 的注册模式
- 验证证据：`npm start` 启动 → 日志无错 → 查 `PRAGMA table_info` 确认列存在
- 依赖：T2.1
- 状态：todo

### Task T2.3 — 新增 `own-accounts-migration.js` 数据迁移模块
- 目标：实现一次性迁移函数 `runOwnAccountsMigration(db, storageRoot)`
- 涉及文件：
  - 新建 `src/backend/database/own-accounts-migration.js`
  - 依赖 `src/backend/own-account-store.js readOwnAccounts`（既有）
  - 依赖 `src/backend/balance-seed-store.js splitTemplateName`（既有）
- 操作：按 TechDoc §3.4 伪码实现；含幂等检查 + bankName 匹配 + 冲突保留 + orphan 跳过 + 结构化日志
- 验证证据：
  - 在 `scripts/fixtures/own-accounts/` 放 2 份 json（含 4 条账号）
  - 运行迁移 → `template_big_accounts` 新增 4 条 `account_nature='own'` 记录
  - 再次运行 → short-circuit，记录数不变
- 依赖：T2.1、T2.2
- 状态：todo

### Task T2.4 — 启动序列调用迁移
- 目标：在 `src/main.js` 启动路径里调用迁移（含 D15 失败不阻塞启动）
- 涉及文件：
  - `src/main.js`（启动序列，具体位置在 `database.init()` 之后、注册 IPC 之前，约 `:300-400` 区间）
- 操作：
  - `const migrationResult = runOwnAccountsMigration(database.db, ensureStorageRoot())`（内部已 try/catch，失败不抛异常）
  - 若 `migrationResult.ok === false` → 主窗口加载完成（`ready-to-show` / `did-finish-load`）后通过 IPC 通知渲染端调用 `setStatus('自有账号迁移失败，请查看迁移日志后联系技术支持', 'error')`
  - 告警保留到用户手动关闭或下一次 `setStatus` 覆盖
  - orphan bankName（D16）仅产生 `[WARN]` 日志，`migrationResult.ok` 仍为 `true`，**不触发状态栏告警**
- 验证证据：
  - 启动日志包含 "own-accounts migration done" 或 "skipped" 条目
  - `{storageRoot}/own-accounts-migration-v1.5.3.log` 生成
  - **模拟迁移失败用例**（如人为抛异常或传无效 storageRoot）：启动仍能成功 + 状态栏显示显著告警 + 迁移日志含 `[ERROR]` 条目
  - **模拟 orphan 用例**（放一份 bankName 数据库无对应模板的 json）：启动成功 + 状态栏**无**告警 + 迁移日志含 `[WARN] orphan bankName: xxx, skipped (N accounts)`
- 依赖：T2.3
- 状态：todo

### Task T2.5 — `getTemplateBigAccounts` 加 `includeOwn` 参数
- 目标：仓库层实现 §3.1 的 SQL 过滤
- 涉及文件：
  - `src/backend/database/template-repository.js:240-257 getTemplateBigAccounts`
  - `src/backend/database.js:196-198`（门面方法透传参数）
- 操作：按 TechDoc §3.3 扩展；SELECT 新增 `account_nature AS accountNature` 字段；WHERE 按 `includeOwn` 决定是否加 `AND account_nature='client'`
- 验证证据：
  - 单元级：临时插入 2 条客资 + 1 条自有 → `getTemplateBigAccounts(db, tid)` 返回 2 条；`getTemplateBigAccounts(db, tid, {includeOwn:true})` 返回 3 条
- 依赖：T2.1
- 状态：todo

### Task T2.6 — `listTemplates/getTemplate/listChildTemplates` SQL 过滤
- 目标：模板列表的 `bigAccountCount` 统计不含自有账号
- 涉及文件：
  - `src/backend/database/template-repository.js:22-37 listTemplates`
  - `src/backend/database/template-repository.js:61-83 getTemplate`
  - `src/backend/database/template-repository.js:112-130 listChildTemplates`
- 操作：`LEFT JOIN template_big_accounts ba ON ba.template_id=t.id AND ba.account_nature='client'`
- 验证证据：模板管理对话框显示的"大账号数量"不含自有；手动导入 3 客资 + 2 自有 → 管理对话框显示 "3"
- 依赖：T2.1
- 状态：todo

### Task T2.7 — `saveMappings` 接收 `accountNature`
- 目标：前端提交的 `bigAccounts[].accountNature` 能正确入库
- 涉及文件：
  - `src/backend/database/template-repository.js:334-491 saveMappings`
  - `src/backend/database/template-repository.js:400-409 insertBigAccountStatement` INSERT 加 `account_nature` 字段
- 操作：`normalizeText(item.accountNature) || 'client'`；若值不在 `{'client','own'}` → throw
- 验证证据：P0-12（导入 Excel → 完成 → DB 查 nature 正确）
- 依赖：T2.1
- 状态：todo

### Task T2.8 — bundle 导出 / 导入带 nature
- 目标：bundle 保持 v3 格式，`bigAccounts` 项新增可选 `accountNature`
- 涉及文件：
  - `src/backend/database/template-repository.js:837-884 listTemplateBundleEntries`（导出时写入 nature）
  - `src/main.js`（bundle 导入 handler，需 grep 定位；约 `:3420` 附近用 `extractHeaders` 或 `template:import-bundle`）
- 操作：导出时加 `accountNature: item.accountNature || 'client'`；导入时 `accountNature = entry.bigAccounts[i].accountNature || 'client'`
- 验证证据：P1-5（bundle 导出包含字段；导入老 bundle 默认 client）
- 依赖：T2.5、T2.7
- 状态：todo

### Task T2.9 — 前端维护大账号对话框合并 tbody
- 目标：导入 Excel 后客资 + 自有都进 tbody，完成时带 nature 回写
- 涉及文件：
  - `src/renderer-dialogs.js:2020-2043 import-bank-info handler`：合并 clientAccounts + ownAccounts 到 combined 数组
  - `src/renderer-dialogs.js:1767-1798 createBigAccountRow`：`row.dataset.accountNature`
  - `src/renderer-dialogs.js:2087-2107 done 按钮`：收集 nextBigAccounts 时加 `accountNature: row.dataset.accountNature`
  - `src/renderer-dialogs.js:2649-2659 onDone 回调`：不再调 `saveOwnAccounts`，删除 `extra.ownAccounts` 分支
  - `src/main.js:6207-6225 big-account:save-own-accounts handler`：加 deprecated 日志
- 操作：按 TechDoc §5.2.1-5.2.4
- 验证证据：P0-12 + P0-16（合并导入 + §3.1 过滤联合验证）
- 依赖：T2.5、T2.7
- 状态：todo

### Task T2.10 — 新增 IPC `template:get-big-accounts-with-own`
- 目标：维护大账号对话框打开时能拉到含自有的完整列表
- 涉及文件：
  - `src/preload.js:32-56 templates`：新增 `getBigAccountsWithOwn`
  - `src/main.js`：新增 handler，直接 `database.getTemplateBigAccounts(templateId, {includeOwn:true})`
  - `src/renderer-dialogs.js`：维护大账号对话框初始化时优先调新 IPC
- 验证证据：维护大账号对话框 tbody 首次打开即显示全部（含自有）
- 依赖：T2.5
- 状态：todo

**G2 完成标志**：P0-12、P0-13、P0-14、P0-15、P0-16、P1-4、P1-5 全部 pass，§3.1 过滤一致性验证通过。

---

## G1 — 需求 R1：主页面"模式"切换 + 月度余额账单导出（依赖 G2 完成）

### Task T1.1 — 新增 `listBalanceSeedBankNames` helper
- 目标：跨模板遍历 balance-seeds 目录
- 涉及文件：`src/backend/balance-seed-store.js:27-34`（helper 定义）+ `:163-172 module.exports`
- 操作：按 TechDoc §4.1.1
- 验证证据：单元级，mock `fs.readdirSync` 返回 `['中行.json', '建行.json']` → helper 返回 `['中行', '建行']`
- 依赖：无
- 状态：todo

### Task T1.2 — 新增 `src/main-process/monthly-balance.js` 模块
- 目标：实现 `assembleMonthlyBalance` + `toBalanceRows` + `lastDayOfMonth` + `pad2` utility
- 涉及文件：新建 `src/main-process/monthly-balance.js`
- 操作：按 TechDoc §4.1.2 伪码；显式调 `db.getTemplateBigAccounts(templateId, {includeOwn:true})`
- 验证证据：
  - `scripts/fixtures/balance-seeds/中行.json` 按 TechDoc §7.3 构造
  - 调用 `assembleMonthlyBalance({templateScope:'中行-北京', year:2026, month:3, db, storageRoot})` → records 应为 1 条（精确匹配 2026-03-31）
  - 去掉该条 → 兜底返回 2026-02-28
  - 切到 USD 账号全部 billDate>月末 → records 不含该账号
- 依赖：T1.1、T2.5
- 状态：todo

### Task T1.3 — 新增 IPC `monthly-balance:assemble`
- 目标：前端触发装配 + 写入临时 xlsx
- 涉及文件：
  - `src/main.js`：新增 handler（在 `file:export-balance` 附近 `:8150-8200`）
  - `src/main.js:1877-1905 buildStatementOutputFilePath`：新增或加独立 `buildMonthlyBalanceOutputFilePath`（按 TechDoc §4.1.4）
  - `src/main.js:81-89 lastGeneratedExports`：加 `monthlyBalance: null` 字段
  - `src/main.js:1907-1917 clearGeneratedExports`：保留 `monthlyBalance` 不清
  - `src/preload.js:70-78 files`：新增 `monthlyBalanceAssemble`
- 操作：调用 `assembleMonthlyBalance` → 为空返回 E4 错误；有记录 → 调 `writeBalanceWorkbook` 写临时路径 → 暂存到 `lastGeneratedExports.monthlyBalance`
- 验证证据：P0-4 到 P0-7 + P0-11
- 依赖：T1.2、T2.5
- 状态：todo

### Task T1.4 — 新增 IPC `monthly-balance:export`
- 目标：`dialog.showSaveDialog` 另存为
- 涉及文件：
  - `src/main.js`：新增 handler（复制 `lastGeneratedExports.monthlyBalance.filePath` 到用户选的路径）
  - `src/preload.js:70-78 files`：新增 `monthlyBalanceExport`
- 操作：类似 `exportStatementByScope` 的 save dialog 分支
- 验证证据：P0-4 末尾的另存为步骤
- 依赖：T1.3
- 状态：todo

### Task T1.5 — `updateTemplateSelect` 重写为"模式"下拉
- 目标：DOM 改造 + 默认模式
- 涉及文件：
  - `index.html:47-48`：label "模式"，options 两值
  - `src/renderer.js:25-30`：新增常量 `STATEMENT_MODE_VALUES`
  - `src/renderer.js:59-88 state`：新增 `currentStatementMode`、`monthlyBalanceReady`、`monthlyBalancePreview`；`selectedTemplateId` 默认改为 `FILENAME_MAPPING_TEMPLATE_ID`
  - `src/renderer.js:1617-1655 updateTemplateSelect`：重写
- 操作：按 TechDoc §5.1.1-5.1.3
- 验证证据：P0-1（默认态 UI 正确）
- 依赖：无
- 状态：todo

### Task T1.6 — 按钮可用/禁用矩阵 `applyStatementModeSideEffects`
- 目标：模式切换时按矩阵重置按钮状态
- 涉及文件：
  - `src/renderer.js:1008-1013 setExportAvailability`：可选重构（接收 mode 参数）
  - `src/renderer.js` 新增 `applyStatementModeSideEffects` 函数
  - `src/renderer.js:2869-2875 templateSelect change listener`：改为调 `applyStatementModeSideEffects`
- 操作：按 TechDoc §5.1.4
- 验证证据：P0-2（切到月度余额按钮矩阵正确）、P1-1（模式切换不丢 session）
- 依赖：T1.5
- 状态：todo

### Task T1.7 — `createMonthlyBalanceExportDialog` 新增弹窗
- 目标：R1 模式下点「导出余额」弹出的对话框
- 涉及文件：
  - `src/renderer-dialogs.js`：新增 `createMonthlyBalanceExportDialog` 函数（建议放 `:157` 附近）
  - `src/styles.css`：可能需要加 `.monthly-balance-export-card / .year-month-picker` 等类（先复用现有样式）
- 操作：按 TechDoc §5.1.6；年份范围 `[currentYear-9, currentYear+1]`；默认模板 = `__ALL_BANKS__`；月份默认未选
- 验证证据：P0-3、P0-8、P0-9
- 依赖：T1.3、T1.5
- 状态：todo

### Task T1.8 — `handleExportBalance` 分流
- 目标：按模式选择走月度余额链路 or 原链路
- 涉及文件：`src/renderer.js:2730-2750 handleExportBalance`
- 操作：按 TechDoc §5.1.5
- 验证证据：P0-3（弹窗触发）、P0-10（全部银行渠道）
- 依赖：T1.7
- 状态：todo

### Task T1.9 — smoke 脚本增量
- 目标：为 R1 装配 + 导出链路加 smoke 测试
- 涉及文件：
  - `scripts/smoke-test.js`（v1.5.2 已存在）新增 R1 场景
  - `scripts/fixtures/balance-seeds/` 准备测试数据（TechDoc §7.3）
- 操作：调用 `assembleMonthlyBalance` → 断言 records 字段；调 `monthly-balance:assemble` IPC → 断言文件生成
- 验证证据：`npm run smoke` 通过
- 依赖：T1.2、T1.3
- 状态：todo

**G1 完成标志**：PRD AC1-1 ~ AC1-14 全部 pass，P0-1 ~ P0-11 全部人工测试通过。

---

## G3 — 需求 R3：导出表头字体 Courier New（最后做）

### Task T3.1 — 引入 `xlsx-js-style` 依赖
- 目标：`package.json` 新增依赖
- 涉及文件：`package.json:60-68 dependencies`
- 操作：`npm install xlsx-js-style@^1.2.0`（不卸载 `xlsx`）
- 验证证据：`package-lock.json` 更新；`npm start` 无模块缺失错误
- 依赖：无
- 状态：todo

### Task T3.2 — writers.js 切换 require + 新增 `applyHeaderRowFont`
- 目标：局部切换到 `xlsx-js-style` + 新增 helper（D14 = 字体名直接写死 `'Courier New'`，无可选参数）
- 涉及文件：
  - `src/backend/file-service/writers.js:1`：`require('xlsx')` → `require('xlsx-js-style')`
  - `src/backend/file-service/writers.js`：新增 `applyHeaderRowFont(worksheet, headerRow)` 函数（按 TechDoc §4.3.2；字体名硬编码，不加切换参数）
- 操作：仅此文件切换；其它文件不动
- 验证证据：smoke 通过（原有测试不破坏）
- 依赖：T3.1
- 状态：todo

### Task T3.3 — `writeWorkbookRows` 注入表头字体
- 目标：明细 writer 第 1 行字体 Courier New
- 涉及文件：`src/backend/file-service/writers.js:193-203 writeWorkbookRows`
- 操作：在 `applyExportFieldFormats` 之后、`book_append_sheet` 之前调 `applyHeaderRowFont(worksheet, rows[0])`
- 验证证据：P0-17（明细表头字体）
- 依赖：T3.2
- 状态：todo

### Task T3.4 — `writeBalanceWorkbook` 注入表头字体
- 目标：余额 writer + R1 月度余额 + 新开账户模块三条路径共用链路表头字体（D14 = 统一写死 Courier New，新开账户模块副作用接受）
- 涉及文件：`src/backend/file-service/writers.js:205-267 writeBalanceWorkbook`
- 操作：在 `applyBalanceFieldFormats` 之后、`XLSX.writeFile` 之前调 `applyHeaderRowFont(worksheet, headerFields)`；不加任何 `applyHeaderFont` 开关
- 验证证据：P0-18（余额表头字体）、P0-19（月度余额字体）；新开账户模块导出亦应呈现 Courier New（D14 接受）
- 依赖：T3.2
- 状态：todo

### Task T3.5 — 合并场景字体验证（不改代码先验证）
- 目标：`mergeGeneratedXlsxFiles` 浅拷贝是否保留 `s` 字段
- 涉及文件：`src/main.js:5249-5294 mergeGeneratedXlsxFiles`（观察，如需可补 `applyHeaderRowFont` 调用）
- 操作：P0-20 实际触发多模板合并场景，打开合并后的 xlsx 抽查第 1 行字体
- 验证证据：P0-20 通过 → 不改代码；不通过 → 在 `:5287-5293` 写回前补调字体注入
- 依赖：T3.3、T3.4
- 状态：todo

**G3 完成标志**：PRD AC3-1 ~ AC3-6 全部 pass，P0-17 ~ P0-21 + P1-6 ~ P1-8 全部人工测试通过。

---

## G4 — 需求 R4：账单拆分合并浮点精度修复（hotfix，2026-04-22 引入）

### Task T4.1 — 账单合并求和加 `roundAmountHighPrecision`

- 目标：修 `src/backend/file-service.js:437-439` 合并求和纯浮点，消除尾部噪声（如 `2377.49 + 178.31 = 2555.7999999999997`）
- 涉及文件：
  - `src/backend/file-service.js`：
    - 顶部 import 补 `roundAmountHighPrecision`（如未 import；现已 import `parseNumericValue` / `sanitizeAmountValue` 等，同文件同目录 `./file-service/normalizers` 已提供该函数）
    - `:437-439` 改：`const net = roundAmountHighPrecision(sumCredit - sumDebit);`（把 round 作用于 net，而不是分别 round sumCredit / sumDebit，保持逻辑最简）
- 操作：
  1. grep 该文件现有 import 行，加 `roundAmountHighPrecision`
  2. 把 `const net = sumCredit - sumDebit;` 替换为 `const net = roundAmountHighPrecision(sumCredit - sumDebit);`
  3. 确认 `if (net === 0)` 仍在 round 之后，命中规则同步生效
- 验证证据：手工 node REPL 验 `roundAmountHighPrecision(2377.49 + 178.31) === 2555.8`；`npm run smoke` 全绿
- 依赖：无（独立 fix）
- 状态：todo

### Task T4.2 — 回归测试用例（补到 `scripts/test-v1.5.3-regression.js`）

- 目标：固化 3 条固定精度样例到 regression 脚本，防止回归
- 涉及文件：`scripts/test-v1.5.3-regression.js`（已存在，G1/G2/G3 自测脚本）
- 操作：新增 Section 6 「R4 账单合并浮点精度」：
  - 直接调 `file-service` 的合并路径，或抽取 `sumCredit/sumDebit/net` 关键逻辑作单元测试
  - 用例：
    - `P0-R4-1`：`sumDebit = 2377.49 + 178.31`，`net = round(sumCredit - sumDebit)` → 期望 `-2555.8`（`Math.abs(net) === 2555.8`，`sanitizeAmountValue(String(2555.8)) === '2555.8'`）
    - `P0-R4-2`：`[65572.01, 4917.90]` → `net = -70489.91`（Math.abs 后 70489.91）
    - `P0-R4-3`：对称零值 `[1.1, -1.1]` → `net === 0` 成立，返回 `null` 跳过合并组
- 验证证据：`node scripts/test-v1.5.3-regression.js` 新增 3 条 ✅
- 依赖：T4.1 完成后
- 状态：todo

**G4 完成标志**：AC4-1 ~ AC4-3 全部 pass；smoke + regression 全绿；log.md 记录 diff 位置。

---

## 关键依赖链可视化

```
T2.1 (schema) ─────┬─ T2.2 (注册) ──────┬─ T2.4 (启动调用)
                   │                     │
                   ├─ T2.3 (迁移模块) ──┘
                   │
                   ├─ T2.5 (getTemplateBigAccounts 参数)
                   │      ├─ T2.6 (listTemplates SQL)
                   │      ├─ T2.7 (saveMappings 带 nature)
                   │      ├─ T2.8 (bundle)
                   │      ├─ T2.9 (前端 tbody 合并)
                   │      └─ T2.10 (新 IPC get-big-accounts-with-own)
                   │
                   └─ 【R2 完成】
                           ↓
T1.1 (listBankNames) ─┬─ T1.2 (monthly-balance 模块，需要 T2.5) ─┬─ T1.3 (assemble IPC)
                      │                                            │
                      │                                            ├─ T1.4 (export IPC)
                      │                                            ├─ T1.9 (smoke)
                      │
T1.5 (模式下拉) ──┬── T1.6 (按钮矩阵) ── T1.8 (handleExportBalance 分流)
                  │                                            ↑
                  │                                            │
                  └── T1.7 (弹窗) ──────────────────────────┘
                           ↓
                   【R1 完成】
                           ↓
T3.1 (依赖) ── T3.2 (writers 切换) ──┬── T3.3 (明细)
                                    ├── T3.4 (余额 + R1)
                                    └── T3.5 (合并验证)
                           ↓
                   【R3 完成】
```

**关键节点**（人工复核红线）：
- T2.3 **数据迁移**：资金字段 merchant_id 迁移，必须抽查 orphan / conflict 日志
- T2.4 启动序列调用：迁移失败不阻塞启动（D15）+ orphan bankName 跳过写日志（D16）
- T2.6 `listTemplates` SQL：关乎模板管理对话框显示数量，影响用户直觉
- T1.2 `assembleMonthlyBalance`：**资金字段 endBalance**，Q2 兜底策略、未来余额排除两条规则都集中在这，必须严测
- T3.4 `writeBalanceWorkbook`：R1 月度余额 + 新开账户模块共用 writer；D14 决策写死 Courier New，新开账户模块表头副作用用户已接受

---

## 变更记录

| 日期 | 变更内容 |
|------|---------|
| 2026-04-20 | D14/D15/D16 回写（变更最小）：T2.4 操作 + 验收条件补充 D15 失败告警 + D16 orphan 用例；T3.2 注明 D14 字体名硬编码；T3.4 注明三路径共用 writer、新开账户模块副作用接受 |
