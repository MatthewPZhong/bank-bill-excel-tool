# TechDoc - 网银账单小助手 v1.5.3

| 项目 | 内容 |
|------|------|
| 版本 | v1.5.3 |
| 日期 | 2026-04-20 |
| 作者 | Dev |
| 状态 | 初稿 |
| 关联 PRD | `docs/iterations/v1.5.3/PRD-v1.5.3.md`（R1×14 + R2×7 + R3×6 = 27 条 AC）|
| 依赖 | v1.5.2 已 merged 到 v1.5.x；从 `v1.5.x` 分支 commit `6e5df3a` 继续开发 |

> **阅读顺序**：§一 → §二（影响面）→ §三（数据模型）→ §四（后端 R1/R2/R3）→ §五（前端）→ §六（IPC 契约）→ §七（测试）→ §八（回滚）→ §九（任务分解）→ §十（Open Questions）

---

## 一、PRD 评审意见（技术角度）

### 1.1 可直接落地的部分

| PRD 要点 | Dev 评审 |
|---------|---------|
| §5.1 R1 模式下拉重构 | 可直接落地。DOM 改动局限于 `index.html:47-48` + `src/renderer.js:1617/2869`；业务逻辑点不多，影响面可控 |
| §5.1.3 月度余额装配规则 | 可直接落地。只需**新增**一个按 bankName 读取的 helper（`readBalanceSeedRecords` 已存在），不改现有数据格式 |
| §5.1.5 文件命名 `月度余额账单-{模板名 or "全部银行渠道"}-{YYYY-MM}.xlsx` | 可直接落地。`buildOutputFilePath`（`src/main.js:1865`）已有足够扩展性 |
| §5.2.2 Schema 变更 | 可直接落地。参考 v1.5.2 的 `ensureTemplateFilenameFixedFieldSupport`（`src/backend/database/migrations.js:293`）模板，新增 `ensureTemplateBigAccountNatureSupport` |
| §5.2.3 历史数据迁移 | 可直接落地。参考 `ensureAccountMappingTemplateSupport`（`src/backend/database/migrations.js:221`）的 `app_settings` 标记模式 |
| §5.3 表头字体改 Courier New | 可落地但需新增依赖（见 1.2 R-1）|

### 1.2 技术意见 / 风险提醒

| 编号 | Dev 评审 | 处理 |
|------|---------|------|
| R-1 | **SheetJS 社区版 `xlsx@0.18.5` 不支持写入 cell 样式**（见 `package.json:67`、`src/backend/file-service/writers.js:1`）。当前 `writeBalanceWorkbook` 读模板字体能保留是因为 `cellStyles:true` 读时保留了 `s` 字段，但 `XLSX.writeFile` 在社区版不把 `s` 字段写回 xlsx 文件。R3 需写入 `s.font.name` 必须换依赖 | 引入 `xlsx-js-style`（第三方维护 fork，API 与 `xlsx` 一致，支持样式写入）作为**新增**依赖，**不替换** `xlsx`。仅在 writers 模块内 `require('xlsx-js-style')`，其它文件维持 `require('xlsx')`。详见 §4.3.1 |
| R-2 | §3.1 自有账户隔离是一条**跨很多位置的全局约束**。代码里直接调用 `database.getTemplateBigAccounts(templateId)` 的位置在 `template-repository.js` 的 `listTemplates` / `getTemplate` / `getTemplateMappings`，间接经由 IPC 返回的 `bigAccountCount`、`bigAccounts` 结构散布在前后端。需要在 DB 层给 `getTemplateBigAccounts` 新增 `{ includeOwn = false }` 参数，而不是在调用方每处加过滤 | 见 §3.3 改造清单；§4.2 给出 SQL 片段 |
| R-3 | PRD §5.2.4 提到 bundleVersion 是否升到 v4。**Dev 评审结论：保持 v3，向后兼容**。`listTemplateBundleEntries` (`template-repository.js:837`) 原来就没有 nature 字段，新版导出在 `bigAccounts` 项里加 `accountNature` 字段（默认 `'client'`），旧版导入时忽略该字段，不破坏兼容 | 见 §4.2.4 |
| R-4 | `src/main.js` 7500+ 行，R1 的装配逻辑若全部写在 main.js 会进一步膨胀。建议新增 `src/main-process/monthly-balance.js` 模块专门承载 `assembleMonthlyBalance` + 跨模板 seeds 遍历 helper | 见 §4.1.2 |
| R-5 | 「制作网银账单」模式内部隐式使用 `__FILENAME_MAPPING__` 可能与现有 `state.selectedTemplateId === ''` 的分支冲突（`src/renderer.js:2871` change listener 把值直接赋给 `state.selectedTemplateId`）。模式切换时要同步重置 `state.selectedTemplateId` | 见 §5.1 renderer 改造 |
| R-6 | R2 的"写入所有 bankName 匹配的模板"策略可能导致**自有账号在多模板间重复**（同一 merchantId 被写进 A 模板 + B 模板的 `template_big_accounts`）。PRD §5.2.3 已明示"全部写入"，Dev 接受但需在日志里记录迁移的详细分布，便于人工审核 | 见 §4.2.3 |

### 1.3 与 PRD 的差异

无。Dev 实施按 PRD 描述执行，仅在 §4.3.1（新增 `xlsx-js-style` 依赖）、§3.3（`getTemplateBigAccounts` 新增 `includeOwn` 参数）两处做了 PRD 未显式描述的技术决定，但均在 PRD §1.2 Dev 评审意见范围内，不构成偏离。

---

## 二、涉及的文件清单（影响面矩阵）

> 按文件列改动类型 + 行号锚点。改动类型：新增 / 修改 / 删除 / 废弃保留。

### 2.1 新增文件

| 文件 | 概要 |
|------|------|
| `src/main-process/monthly-balance.js` | R1 月度余额装配的主函数 + 跨模板 balance-seeds 遍历 helper |
| `src/backend/database/own-accounts-migration.js` | R2 一次性迁移 own-accounts/*.json → template_big_accounts；幂等；独立文件便于 grep |

### 2.2 修改文件

| 文件 | 行号锚点 | 改动类型 | 概要 |
|------|---------|---------|------|
| `index.html` | `:47-48` | 修改 | `<label>` 文本 "模板" → "模式"；`<select>` options 结构化改（保留 id `templateSelect` 不动 — 最小化 DOM id 变动，减少 CSS 风险）|
| `src/renderer.js` | `:27-30` | 新增常量 | `STATEMENT_MODE_VALUES`（`'statement'` / `'monthly-balance'`）|
| `src/renderer.js` | `:59-88 state` | 修改 | 新增 `state.currentStatementMode`（默认 `'statement'`）、`state.monthlyBalanceReady`（默认 `false`）|
| `src/renderer.js` | `:1008-1013 setExportAvailability` | 修改 | 接收"模式"参数；按模式决定 `importFileBtn / accountMappingBtn` 的 disabled |
| `src/renderer.js` | `:1617-1655 updateTemplateSelect` | 大幅重写 | 改为 `updateModeSelect`（名字可保留 updateTemplateSelect 减少 call site 破坏）；仅写入两个 option |
| `src/renderer.js` | `:2730-2750 handleExportBalance` | 修改 | 根据 `state.currentStatementMode` 分流：`statement` 走现有路径；`monthly-balance` 走新路径（弹 `createMonthlyBalanceExportDialog`，或装配完后点击另存为）|
| `src/renderer.js` | `:2869-2875 templateSelect change listener` | 修改 | 改为读取 `event.target.value` 作为 `state.currentStatementMode`；切换时调 `applyStatementModeSideEffects()` |
| `src/renderer-dialogs.js` | `:2020-2043 import-bank-info handler` | 修改 | 客资 + 自有都进 tbody；不保留 `pendingOwnAccounts`；返回 tbody 数据时带 `accountNature` |
| `src/renderer-dialogs.js` | `:1630-2117 createBigAccountManagerDialog` | 修改 | `initialOwnAccounts` 参数废弃（调用方仍可传，内部忽略）；完成按钮收集 tbody 行时把每行的 `accountNature` 一并提交 |
| `src/renderer-dialogs.js` | `:2640-2679 manageBigAccountBtn handler` | 修改 | 不再调 `bigAccount.saveOwnAccounts`（IPC 废弃）；nature 字段随 `saveMappings` 一起提交 |
| `src/renderer-dialogs.js` | 新增 `createMonthlyBalanceExportDialog` | 新增 | R1 弹窗（标题 + 模板下拉 + 年月选择器 + 完成按钮）|
| `src/backend/database.js` | `:53-63 CREATE TABLE template_big_accounts` | 修改 | 新建表时 schema 已含 `account_nature` 列 |
| `src/backend/database.js` | `:100-105 init()` | 修改 | 调用链新增 `ensureTemplateBigAccountNatureSupport()`（迁移函数）+ `runOwnAccountsMigration()`（一次性数据迁移）|
| `src/backend/database/migrations.js` | 末尾 | 新增 | 导出 `ensureTemplateBigAccountNatureSupport` |
| `src/backend/database/template-repository.js` | `:240-257 getTemplateBigAccounts` | 修改 | 新增 `{ includeOwn = false }` 参数；WHERE 子句按需加 `account_nature='client'` |
| `src/backend/database/template-repository.js` | `:9-38 listTemplates`、`:40-83 getTemplate` | 修改 | `bigAccountCount` 查询加 `account_nature='client'` 过滤（§3.1 规则，避免 UI 显示含自有的数量）|
| `src/backend/database/template-repository.js` | `:334-491 saveMappings` | 修改 | `bigAccounts` 入参支持 `accountNature` 字段；`INSERT INTO template_big_accounts` 写入该字段 |
| `src/backend/database/template-repository.js` | `:837-884 listTemplateBundleEntries` | 修改 | bundle 项中 `bigAccounts` 数组新增 `accountNature` 字段（默认 `'client'`，bundleVersion 保持 v3）|
| `src/backend/bank-account-import.js` | `:44-72 parseBankAccountExcel` | 修改 | 返回值结构不变（仍是 `{clientAccounts, ownAccounts, skippedCount}`），但新增测试确保 `ownAccounts` 可被前端统一消费 |
| `src/backend/file-service/writers.js` | `:1` | 修改 | `require('xlsx-js-style')` 替换 `require('xlsx')`（注意：仅 writers 文件换依赖，其它地方仍用 `xlsx`）|
| `src/backend/file-service/writers.js` | `:193-203 writeWorkbookRows` | 修改 | 写入后给第 1 行每个 cell 的 `s.font.name='Courier New'` |
| `src/backend/file-service/writers.js` | `:205-267 writeBalanceWorkbook` | 修改 | 写入后遍历第 1 行 cell 的 `s.font = { ...(cell.s?.font || {}), name:'Courier New' }`（保留其他 font 属性）|
| `src/main.js` | `:81-89 lastGeneratedExports` | 修改 | 加 `monthlyBalance: null` 字段 |
| `src/main.js` | `:1877-1905 buildStatementOutputFilePath` | 修改 | 新增"月度余额"分支：`kind='monthly-balance'` 时生成 `月度余额账单-{templateName}-{YYYY-MM}.xlsx` |
| `src/main.js` | `:5249-5294 mergeGeneratedXlsxFiles` | 修改 | 合并后遍历第 1 行字体（或在 writers 层统一处理，TechDoc 建议后者）|
| `src/main.js` | `:6136-6205 big-account:import-bank-info` | 修改 | 返回值新增 `ownAccounts[].accountNature='own'` 标记（冗余但便于前端区分渲染）|
| `src/main.js` | `:6207-6225 big-account:save-own-accounts` | 废弃保留 | IPC handler 代码保留；前端不再调用；可在日志加 deprecated 警告 |
| `src/main.js` | 新增 IPC | 新增 | `monthly-balance:assemble` / `monthly-balance:export` 两条 IPC（见 §六）|
| `src/main.js` | `:8155-8157 file:export-balance` | 修改 | 按 `state.currentStatementMode` 分流；`monthly-balance` 模式下走新 IPC 路径（或复用现有入口 + 判断 `lastGeneratedExports.monthlyBalance`）|
| `src/preload.js` | `:58-65 bigAccount` | 修改 | `saveOwnAccounts` 标记 deprecated（保留但前端不用）|
| `src/preload.js` | `:70-78 files` | 新增 API | 新增 `files.monthlyBalanceAssemble(payload)` / `files.monthlyBalanceSaveAs()` 或在 `files.exportBalance` 内通过 payload 区分 |
| `src/backend/balance-seed-store.js` | `:27-34` | 新增 helper | `listBalanceSeedBankNames(storageRoot)`：读目录返回所有 bankName（去 `.json` 后缀）|
| `src/backend/own-account-store.js` | — | 废弃保留 | 不改代码；在文件顶部注释标记 "DEPRECATED since v1.5.3，仅作 v1.5.2 回退 fallback" |

### 2.3 不改文件但需关注（§3.1 §3.3 过滤一致性验证）

| 文件 | 行号锚点 | 关注原因 |
|------|---------|---------|
| `src/main.js` | `:1140 expandBigAccountConfigurations` | 大账号展开逻辑；确认读入参 `bigAccounts` 已被调用方过滤 |
| `src/main.js` | `:1590 buildCompatibleBigAccounts` | 同上 |
| `src/main.js` | `:1657 normalizeMappingRows` | 同上；入参 `bigAccounts` 上游已过滤 |
| `src/main.js` | `:2563 bigAccountCount: template.bigAccountCount` | IPC 返给前端的数量字段——因 `getTemplate` 已加 `account_nature='client'` 过滤（§2.2），此处数量自然正确 |
| `src/main.js` | `:3074 validateTemplateConfiguration` | 同上 |
| `src/main.js` | `:4228 database.getTemplateMappings(templateId)` | `getTemplateMappings` 内部调 `getTemplateBigAccounts` 默认 `includeOwn=false`——此路径获得的 bigAccounts 不含自有，符合 §3.1 |

---

## 三、数据模型改动

### 3.1 `template_big_accounts` 新增 `account_nature` 列

**SQL**：
```sql
-- 幂等迁移：如果列已存在则跳过（参考 ensureTemplateFilenameFixedFieldSupport:293）
ALTER TABLE template_big_accounts
  ADD COLUMN account_nature TEXT NOT NULL DEFAULT 'client';
```

**位置**：`src/backend/database/migrations.js` 新增函数 `ensureTemplateBigAccountNatureSupport`；在 `src/backend/database.js:100-105 init()` 内调用。

**既有约束**：`UNIQUE(template_id, merchant_id, currency)` 保持不变；同一账号不能同时是客资+自有，迁移冲突时保留已存在记录。

### 3.2 `app_settings` 新增迁移标记

**SQL**：
```sql
INSERT OR REPLACE INTO app_settings (setting_key, setting_value, updated_at)
  VALUES ('own_accounts_migration_v1.5.3_done', 'true', ?);
```

**位置**：迁移完成后由 `runOwnAccountsMigration` 写入。参考现有 `account_mapping_migration_pending` 模式（`src/backend/database/migrations.js:265`）。

**读取**：启动时 `settingsRepository.getSetting('own_accounts_migration_v1.5.3_done')`，`'true'` → 跳过迁移。

### 3.3 `getTemplateBigAccounts` 参数扩展

**当前函数签名**（`src/backend/database/template-repository.js:240-257`）：
```javascript
function getTemplateBigAccounts(db, templateId) { ... }
```

**改造后**：
```javascript
function getTemplateBigAccounts(db, templateId, { includeOwn = false } = {}) {
  const natureClause = includeOwn ? '' : "AND account_nature = 'client'";
  return db
    .prepare(`
      SELECT
        merchant_id AS merchantId,
        currency,
        row_index AS rowIndex,
        account_nature AS accountNature
      FROM template_big_accounts
      WHERE template_id = ? ${natureClause}
      ORDER BY row_index ASC, id ASC
    `)
    .all(templateId)
    .map(...)
}
```

**调用点影响**：
- `template-repository.js:361 getTemplateMappings` 内部调：不传第三参 → 默认 `includeOwn=false` → 符合 §3.1 "制作网银账单"流程不含自有
- `database.js:196-198` 门面方法：转发第三参
- R1 月度余额模块（新增）：显式传 `{ includeOwn: true }`
- `listTemplates` / `getTemplate` 查 `bigAccountCount` 时用 SQL 直接加 `WHERE account_nature='client'`（不走上面的 helper，单独改 SQL）

### 3.4 数据迁移流程

**文件**：`src/backend/database/own-accounts-migration.js`（新增）

**伪码流程**（含 D15 "失败不阻塞启动" + D16 "orphan bankName 跳过 + 写日志"）：
```
// 外层包 try/catch（D15）：整体异常不抛出，由调用方（main.js 启动序列）根据返回值决定是否触发状态栏告警
function runOwnAccountsMigration(db, storageRoot) {
  try {
    if (getSetting(db, 'own_accounts_migration_v1.5.3_done') === 'true') {
      log.info('own-accounts migration already done, skip')
      return { ok: true, skipped: true }
    }

    const ownAccountsDir = path.join(storageRoot, 'own-accounts')
    if (!fs.existsSync(ownAccountsDir)) {
      setSetting(db, 'own_accounts_migration_v1.5.3_done', 'true')
      return { ok: true, skipped: true, reason: 'no-dir' }
    }

    const jsonFiles = fs.readdirSync(ownAccountsDir).filter(f => f.endsWith('.json'))
    const allTemplates = listTemplates(db)
    const stats = { totalJsonFiles: 0, totalAccounts: 0, inserted: 0, conflicts: [], orphans: [] }

    for (const jsonFile of jsonFiles) {
      stats.totalJsonFiles++
      const bankName = path.basename(jsonFile, '.json')
      const accounts = readOwnAccounts(storageRoot, bankName)
      const matchingTemplates = allTemplates.filter(
        t => splitTemplateName(t.name).bankName === bankName
      )

      // D16：orphan bankName（数据库里找不到对应模板）→ 跳过整份 json，不中断整体迁移，仅写日志
      // 这个分支不算"迁移失败"，不触发 D15 的状态栏告警
      if (matchingTemplates.length === 0) {
        stats.orphans.push({ bankName, accountCount: accounts.length })
        appendMigrationLog(storageRoot, `[WARN] orphan bankName: ${bankName}, skipped (${accounts.length} accounts)`)
        continue
      }

      for (const account of accounts) {
        const currencies = account.currencies || []
        for (const currency of currencies) {
          stats.totalAccounts++
          for (const template of matchingTemplates) {
            // 冲突检测 —— 已有记录则保留 nature（客资优先）
            const existing = db.prepare(
              'SELECT account_nature FROM template_big_accounts WHERE template_id=? AND merchant_id=? AND currency=?'
            ).get(template.id, account.merchantId, currency)

            if (existing) {
              stats.conflicts.push({
                templateName: template.name,
                merchantId: account.merchantId,
                currency,
                existingNature: existing.account_nature
              })
              continue
            }

            db.prepare(`
              INSERT OR IGNORE INTO template_big_accounts
                (template_id, merchant_id, currency, row_index, account_nature, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'own', ?, ?)
            `).run(template.id, account.merchantId, currency, 0, now, now)
            stats.inserted++
          }
        }
      }
    }

    setSetting(db, 'own_accounts_migration_v1.5.3_done', 'true')
    log.info('own-accounts migration done', stats)
    return { ok: true, stats }
  } catch (err) {
    // D15：迁移整体失败 —— 不抛异常、不阻塞启动
    // 失败明细写 own-accounts-migration-v1.5.3.log；调用方拿 ok:false 后在主窗口加载完成时
    // 通过 setStatus 显示"自有账号迁移失败，请查看迁移日志后联系技术支持"（error/warning tone），
    // 告警保留到用户手动关闭或下一次 setStatus 覆盖
    appendMigrationLog(storageRoot, `[ERROR] migration failed: ${err.stack || err.message}`)
    return { ok: false, error: err.message }
  }
}
```

**事务**：整个迁移函数外层不包事务；每次 INSERT 独立。原因是迁移逻辑读取文件 + 多个 SQL + 可能持续一段时间，若整体事务失败会全回滚难以定位。INSERT OR IGNORE 保证幂等。

**日志文件**：迁移的 stats 写入 `{storageRoot}/app_activity_log.txt`（复用 `appendActivityLogEntry`）+ 写一份明细到 `{storageRoot}/own-accounts-migration-v1.5.3.log`（便于单独审核）。orphan bankName（D16）与整体失败（D15）都走同一份迁移日志，通过 `[WARN]` / `[ERROR]` 前缀区分。

**失败告警语义**（D15）：
- 迁移返回 `{ ok: false }` → 主进程在 `ready-to-show` 或等价时机向渲染进程发一条状态消息；
- 渲染端用 `setStatus('自有账号迁移失败，请查看迁移日志后联系技术支持', 'error')`；
- 告警不自动清除；被下一次 `setStatus` 覆盖或用户手动关闭即消失。
- orphan（D16）不算失败，不走这条告警路径。

---

## 四、后端实现

### 4.1 R1：月度余额账单导出链路

#### 4.1.1 新增 helper：`listBalanceSeedBankNames`

**位置**：`src/backend/balance-seed-store.js`

**签名**：
```javascript
function listBalanceSeedBankNames(storageRoot) {
  const dir = getBalanceSeedsDir(storageRoot)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => path.basename(f, '.json'))
}
```

**导出**：加入 `module.exports`（`balance-seed-store.js:163-172`）。

#### 4.1.2 新增模块：`src/main-process/monthly-balance.js`

**职责**：
1. `assembleMonthlyBalance({ templateScope, year, month, context })` —— 装配 records
2. `generateMonthlyBalanceFile({ assembled, outputFilePath, balanceTemplatePath })` —— 写入 xlsx

**assembleMonthlyBalance 伪码**：
```javascript
async function assembleMonthlyBalance({ templateScope, year, month, db, storageRoot }) {
  const targetLastDay = `${year}-${pad2(month)}-${lastDayOfMonth(year, month)}`
  
  // 1. 确定要处理的模板范围
  const allTemplates = db.listTemplates()
    .filter(t => !t.isParent && !t.parentTemplateId)  // "普通模板"
  const targetTemplates = templateScope === '__ALL_BANKS__'
    ? allTemplates
    : allTemplates.filter(t => t.name === templateScope)
  
  if (!targetTemplates.length) {
    return { records: [], bankCount: 0, accountCount: 0 }
  }
  
  const records = []
  
  for (const template of targetTemplates) {
    const bankName = splitTemplateName(template.name).bankName
    const location = splitTemplateName(template.name).location
    
    // 2. 取该模板所有大账号（R1 是唯一放行自有的场景：includeOwn=true）
    const bigAccounts = db.getTemplateBigAccounts(template.id, { includeOwn: true })
    if (!bigAccounts.length) continue
    
    // 3. 读该 bankName 的 seeds
    const seeds = readBalanceSeedRecords(storageRoot, bankName)
    if (!seeds.length) continue
    
    // 4. 逐大账号处理
    for (const ba of bigAccounts) {
      // 优先：月末当日精确匹配
      const exactMatch = seeds.find(s =>
        s.billDate === targetLastDay &&
        s.merchantId === ba.merchantId &&
        s.currency === ba.currency
      )
      
      let chosenSeed = exactMatch
      if (!chosenSeed) {
        // 兜底：billDate ≤ 月末最后一日，取 billDate 最大的一条
        const candidates = seeds
          .filter(s =>
            s.merchantId === ba.merchantId &&
            s.currency === ba.currency &&
            s.billDate <= targetLastDay
          )
          .sort((a, b) => b.billDate.localeCompare(a.billDate))
        chosenSeed = candidates[0] || null
      }
      
      // 未来余额排除 / 无 seed：跳过该大账号
      if (!chosenSeed) continue
      
      records.push({
        bankName,
        location,
        merchantId: ba.merchantId,
        currency: ba.currency,
        billDate: chosenSeed.billDate,
        endBalance: chosenSeed.endBalance,
        // 其他字段按 balance 模板 headerFields 逐一对齐，缺失补空
      })
    }
  }
  
  return {
    records,
    bankCount: new Set(records.map(r => r.bankName)).size,
    accountCount: records.length,
    targetLastDay,
    year,
    month
  }
}
```

**字段对齐**（§5.1.3 要求的"对齐 `balanceTemplateFields`"）：

`balanceTemplateFields = extractHeaders(getBalanceTemplatePath())` 返回的字段例如 `['银行名称', '所在地', '银行账号', '币种', '账单日期', '期末余额', ...]`。装配成 records 时，每条 record 是一个**数组**（按 balanceTemplateFields 顺序），不是对象。这样才能直接喂给 `writeBalanceWorkbook`（`writers.js:205` 的 `records` 参数格式）。

转换逻辑：
```javascript
function toBalanceRows(assembled, balanceTemplateFields) {
  const fieldToValue = new Map()
  return assembled.records.map(r => {
    fieldToValue.clear()
    fieldToValue.set('银行名称', r.bankName)
    fieldToValue.set('所在地', r.location)
    fieldToValue.set('银行账号', r.merchantId)
    fieldToValue.set('币种', r.currency)
    fieldToValue.set('账单日期', r.billDate)
    fieldToValue.set('期末余额', r.endBalance)
    // 其它字段（如"期初余额"、"期初可用余额"等）缺省为空字符串
    return balanceTemplateFields.map(f => fieldToValue.get(f) ?? '')
  })
}
```

**关键约束**：PRD §九.7 要求单 sheet 合并场景下"硬编码使用 `assets/余额账单模版.xlsx` 的字段集"，这里的 `balanceTemplateFields` 就是该字段集的唯一来源。

#### 4.1.3 新增 IPC handler

在 `src/main.js:8149` 附近（`registerFileHandlers` 末尾）新增：

```javascript
ipcMain.handle('monthly-balance:assemble', async (_event, payload = {}) => {
  // payload = { templateScope, year, month }
  // 1. 前端参数校验返回 E1/E2/E3（也可放前端）
  // 2. 调 assembleMonthlyBalance
  // 3. 空 records → 返回 E4 错误结构
  // 4. 非空 → 写入临时路径（buildOutputFilePath 'monthly-balance'）
  //    → lastGeneratedExports.monthlyBalance = { filePath, fileName, ... }
  //    → 返回 { status:'success', fileName, recordCount }
})

ipcMain.handle('monthly-balance:export', async (_event) => {
  // 复用现有 dialog.showSaveDialog → fs.copyFileSync 链路
  // 类似 exportStatementByScope 但从 lastGeneratedExports.monthlyBalance 取
})
```

**是否新增独立 IPC vs 复用 `file:export-balance`**：

Dev 推荐**新增独立 IPC**（`monthly-balance:assemble` / `monthly-balance:export`），原因：
- `exportStatementByScope`（`src/main.js:5910`）耦合了 `statementImportSessions` 逻辑，月度余额是全新数据流，不应走该分支
- 独立 IPC 更易回滚（R1 撤销时只需下掉两个 handler）
- 前端代码清晰：`state.currentStatementMode === 'monthly-balance'` → 走 `window.desktopApi.files.monthlyBalanceAssemble(...)`；`statement` → 走原有 `exportBalance`

#### 4.1.4 文件命名扩展

**改动点**：`src/main.js:1877-1905 buildStatementOutputFilePath`

新增 `kind='monthly-balance'` 分支或新建独立 helper：

```javascript
function buildMonthlyBalanceOutputFilePath({ templateScopeLabel, year, month }) {
  const publicFileName = `月度余额账单-${templateScopeLabel}-${year}-${pad2(month)}.xlsx`
  return buildOutputFilePath({
    kind: 'balance',   // 目录仍用 balance/ 子目录（复用现有 exports/{date}/balance/）
    outputFileName: publicFileName
  })
}
```

其中 `templateScopeLabel` 为 `全部银行渠道` 或具体模板名。

### 4.2 R2：自有账号迁入 `template_big_accounts`

#### 4.2.1 Schema 迁移函数

**位置**：`src/backend/database/migrations.js` 末尾新增：

```javascript
function ensureTemplateBigAccountNatureSupport(db) {
  if (!hasColumn(db, 'template_big_accounts', 'account_nature')) {
    db.exec("ALTER TABLE template_big_accounts ADD COLUMN account_nature TEXT NOT NULL DEFAULT 'client';")
  }
}
```

**注册**：
- `src/backend/database.js:16` 导入：`ensureTemplateBigAccountNatureSupport`
- `src/backend/database.js:100-105 init()` 末尾调用 `this.ensureTemplateBigAccountNatureSupport()`
- 新增门面方法（参考 `:143-145 ensureTemplateFilenameFixedFieldSupport`）

**顺序**：必须在其它涉及 `template_big_accounts` 迁移之后执行；当前列表里 `ensureAccountMappingTemplateSupport` 和 `account_mappings` 无关，不受影响。

#### 4.2.2 历史数据迁移执行点

**调用位置**：`src/backend/database.js:105 init()` 末尾：
```javascript
this.ensureTemplateBigAccountNatureSupport()
this.runOwnAccountsMigration(storageRoot)  // 需外部传 storageRoot
```

或者（更干净）：把迁移放在 `src/main.js` 启动序列里，在 `database.init()` 之后：
```javascript
// src/main.js 启动序列
database = new AppDatabase(dbPath)
database.init()
runOwnAccountsMigration(database.db, ensureStorageRoot())
```

**Dev 推荐**：放在 `src/main.js` 启动序列，理由：
- `database.init()` 不知道 `storageRoot`（`app.getPath('documents')` 是 Electron 特有的）
- 分层清晰：DB schema 迁移在 `database.init()`；**数据**迁移（依赖文件系统）在 main.js

#### 4.2.3 迁移冲突日志

**位置**：`{storageRoot}/own-accounts-migration-v1.5.3.log`

**格式**（JSON lines）：
```
{"timestamp":"2026-04-20T09:30:00Z","stage":"start","jsonFiles":3,"templatesCount":5}
{"timestamp":"2026-04-20T09:30:01Z","stage":"insert","bankName":"中行","merchantId":"6225...","currency":"CNY","templateName":"中行-北京","result":"ok"}
{"timestamp":"2026-04-20T09:30:01Z","stage":"conflict","bankName":"中行","merchantId":"6226...","currency":"USD","templateName":"中行-北京","existingNature":"client","result":"skip"}
{"timestamp":"2026-04-20T09:30:02Z","stage":"orphan","bankName":"XX银行","accountCount":2,"result":"skip"}
{"timestamp":"2026-04-20T09:30:02Z","stage":"end","stats":{"totalJsonFiles":3,"totalAccounts":7,"inserted":5,"conflicts":1,"orphans":1}}
```

实现：`fs.appendFileSync(migrationLogPath, JSON.stringify(entry) + '\n', 'utf8')`。

#### 4.2.4 `saveMappings` + bundle 的 nature 字段

**`saveMappings`**（`template-repository.js:334`）：

当前入参 `bigAccounts` 是 `[{ merchantId, currencies, isMultiCurrency }, ...]`（从 tbody 收集）。改为接受 `[{ merchantId, currencies, accountNature }, ...]`。

实际入库时每个 `(merchantId, currency)` 一行，所以 `currencies` 展开后每条都带 `accountNature`：

```javascript
// template-repository.js:400 附近
const insertBigAccountStatement = db.prepare(`
  INSERT INTO template_big_accounts (
    template_id, merchant_id, currency, row_index, account_nature, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);

bigAccounts.forEach((item, index) => {
  const nature = normalizeText(item.accountNature) || 'client'
  if (nature !== 'client' && nature !== 'own') {
    throw new Error(`invalid accountNature: ${nature}`)
  }
  insertBigAccountStatement.run(
    templateId,
    item.merchantId,
    item.currency,      // 注：当前代码是 item.currency 单个；详见现状 :429
    index,
    nature,
    now,
    now
  );
})
```

> 注意：`saveMappings` 在当前实现里接收的 `bigAccounts` 是**展平后**的 `(merchantId, currency)` 对；tbody 传过来前已由 `getRowDraft()` 展开。确认这一点：`src/renderer-dialogs.js:2095-2107` —— 收集时是逐行 `{merchantId, currencies, isMultiCurrency}`，但传给 `saveMappings` 的路径里会被进一步展平。TechDoc 实施时要先 grep 确认展平点在前端还是后端，并把 `accountNature` 放在展平前还是展平后的对象上。

**`listTemplateBundleEntries`**（`template-repository.js:837-884`）：

`bigAccounts` 项新增 `accountNature` 字段：
```javascript
bigAccounts: payload ? payload.bigAccounts.map((item) => ({
  merchantId: item.merchantId,
  currencies: item.currencies.slice(),
  isMultiCurrency: Boolean(item.isMultiCurrency),
  accountNature: item.accountNature || 'client'   // 新增
})) : [],
```

**bundle 导入回写**（`src/main.js` 里的 `template:import-bundle` handler，需 grep 确定行号）：入参若缺 `accountNature` 字段则默认 `'client'`，向后兼容 v1.5.2 及之前的 bundle。

#### 4.2.5 §3.1 过滤一致性逐位置清单

| 代码位置 | 当前行为 | R2 改后行为 | 判定依据 |
|---------|---------|------------|----------|
| `src/backend/database/template-repository.js:240-257 getTemplateBigAccounts` | 返回所有 nature | 默认 `includeOwn=false` → 只返 client | §3.3 |
| `src/backend/database/template-repository.js:361 getTemplateMappings` | 调 `getTemplateBigAccounts(db, templateId)`（无参）→ 只返 client | 不改代码，符合 §3.1 | v1.5.3 新默认生效 |
| `src/backend/database/template-repository.js:22 listTemplates` SQL | `COUNT(DISTINCT ba.merchant_id) AS bigAccountCount` 含全部 nature | 改 SQL：`LEFT JOIN template_big_accounts ba ON ba.template_id=t.id AND ba.account_nature='client'` | §3.1 "维护大账号对话框初始化不显示自有数量" |
| `src/backend/database/template-repository.js:61 getTemplate` SQL | 同上 | 同上改 SQL | 同上 |
| `src/backend/database/template-repository.js:112 listChildTemplates` SQL | 同上 | 同上改 SQL | 同上（虽然子模板不参与，但保持一致性）|
| `src/main-process/monthly-balance.js` | 新文件 | 显式 `getTemplateBigAccounts(id, { includeOwn: true })` | R1 唯一放行 |
| `src/renderer-dialogs.js:1630 createBigAccountManagerDialog` tbody 初始化 | 接收 `bigAccounts`（`getTemplateMappings` 返回）| 不改调用方；因上游已过滤，这里收到的自然只含 client —— **但**根据 PRD §3.1 "维护大账号 tbody 显示客资+自有不区分"，需**单独**调一个带 `includeOwn=true` 的接口取两类。Dev 方案：新增 `template:get-big-accounts-with-own` IPC 或给 `getMappings` 加参数 `{includeOwn:true}`。见 §六 |

### 4.3 R3：导出 Excel 表头字体

> **决策 D14（2026-04-20）**：R3 采用方案 B —— 在 `writeBalanceWorkbook` / `writeDetailWorkbook`（及 `writeWorkbookRows`）内部**直接写死 Courier New**，不加可选参数切换。副作用：新开账户模块（`new-account:generate`）导出表头也会一并变 Courier New，用户已知情并接受。OT-5 由此收敛，以下实现均按"直接写死"版本。

#### 4.3.1 引入 `xlsx-js-style`

**package.json 变动**：
```json
"dependencies": {
  "xlsx": "^0.18.5",              // 保留
  "xlsx-js-style": "^1.2.0"       // 新增
}
```

**版本选择依据**：`xlsx-js-style` 1.2.0（GitHub gitbrent/xlsx-js-style）与 `xlsx@0.18.5` API 兼容；社区使用充分；无 native 依赖，不影响 electron-builder 打包。

**实施步骤**：
1. `npm install xlsx-js-style@^1.2.0`
2. 仅在 `src/backend/file-service/writers.js:1` 把 `require('xlsx')` 改为 `require('xlsx-js-style')`
3. **不改**其它文件（`src/main.js:4 require('xlsx')`、`src/backend/file-service.js`、`src/backend/file-service/readers.js` 等仍用 `xlsx`）

**为什么不全局替换**：`xlsx-js-style` 是 `xlsx` 的 fork，读 API 完全兼容但打包体积大约翻倍。仅在写样式的 `writers.js` 切换，减少打包体积增加。

#### 4.3.2 表头字体注入

**`writeWorkbookRows` 修改**（`writers.js:193-203`）：

```javascript
function writeWorkbookRows({ rows, outputFilePath, sheetName = 'COMMON' }, formatters) {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  applyExportFieldFormats(worksheet, rows, formatters);
  applyHeaderRowFont(worksheet, rows[0] || []);   // 新增
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  XLSX.writeFile(workbook, outputFilePath);
  return outputFilePath;
}
```

**新增 `applyHeaderRowFont`**（writers.js 内部）：

```javascript
function applyHeaderRowFont(worksheet, headerRow) {
  if (!headerRow || !headerRow.length) return
  for (let c = 0; c < headerRow.length; c++) {
    const addr = XLSX.utils.encode_cell({ r: 0, c })
    const cell = worksheet[addr]
    if (!cell) continue
    const existingFont = (cell.s && cell.s.font) || {}
    cell.s = {
      ...(cell.s || {}),
      font: { ...existingFont, name: 'Courier New' }
    }
  }
}
```

**`writeBalanceWorkbook` 修改**（`writers.js:205-267`）：

在 `XLSX.writeFile(workbook, outputFilePath)` 之前加 `applyHeaderRowFont(worksheet, headerFields)`。

**合并场景（`mergeGeneratedXlsxFiles`，`src/main.js:5249`）**：

Dev 推荐**不在 main.js 合并函数里重复注入**。因为合并前的每个源文件都已经注入过字体（R3 保证），`mergeGeneratedXlsxFiles` 在第 5256-5282 行复制单元格对象时 `{ ...cell }` 浅拷贝会保留 `s` 字段。验证方法：P1-6 测试。

如果测试发现合并后字体丢失，fallback 方案：在 `mergeGeneratedXlsxFiles` 写出前也调 `applyHeaderRowFont(baseWs, headerRow)`（需从 baseWs 读 r=0 的 headerRow）。

#### 4.3.3 多行表头识别

PRD §四术语："多行表头按'位于第 1 行的所有单元格'处理"。

当前项目里**没有明确的多行表头场景**（明细模板是单行表头，余额模板 `assets/余额账单模版.xlsx` 也是单行表头）。Dev 结论：本次实现只处理 r=0 一行；若后续引入多行表头，再扩展 `applyHeaderRowFont` 接收 `headerRowCount` 参数。当前代码按 r=0 硬编码。

#### 4.3.4 回退链策略

PRD §5.3.1 明示："不加回退链"。Dev 严格按原话：`cell.s.font.name = 'Courier New'`（不写 `cell.s.font.names` 数组、不写系统字体 fallback）。

---

## 五、前端实现

### 5.1 R1：主页面"模式"下拉重构

#### 5.1.1 DOM 改动

**`index.html:47-48`** → 保留 id `templateSelect`（减少 CSS 风险），修改 label：
```html
<label class="select-label" for="templateSelect">模式</label>
<select id="templateSelect" class="template-select">
  <option value="statement">制作网银账单</option>
  <option value="monthly-balance">导出月度余额账单</option>
</select>
```

#### 5.1.2 state 扩展

**`src/renderer.js:59-88 state`** 新增：
```javascript
currentStatementMode: 'statement',      // 'statement' | 'monthly-balance'
monthlyBalanceReady: false,             // R1 装配完成后为 true
monthlyBalancePreview: null,            // { fileName, recordCount, year, month } 装配成功后暂存
selectedTemplateId: '__FILENAME_MAPPING__',   // 默认值改为虚拟 ID（"制作网银账单"模式下永远等于此值）
```

注意：`selectedTemplateId` 不再从下拉读取（下拉现在是"模式"）；但旧代码有大量 `state.selectedTemplateId` 的调用，**不能删除**。改为在 `state.currentStatementMode='statement'` 时永远 `__FILENAME_MAPPING__`；`monthly-balance` 时不参与（为空串或保留最后一次选值）。

#### 5.1.3 `updateTemplateSelect` → `updateModeSelect`

**`src/renderer.js:1617-1655`** 完全重写（保留函数名便于兼容）：

```javascript
function updateTemplateSelect() {
  elements.templateSelect.innerHTML = '';
  const options = [
    { value: 'statement', label: '制作网银账单' },
    { value: 'monthly-balance', label: '导出月度余额账单' }
  ];
  for (const opt of options) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    elements.templateSelect.appendChild(option);
  }
  elements.templateSelect.value = state.currentStatementMode;
  // "制作网银账单"模式下 selectedTemplateId 固定为 __FILENAME_MAPPING__
  if (state.currentStatementMode === 'statement') {
    state.selectedTemplateId = FILENAME_MAPPING_TEMPLATE_ID;
  }
}
```

#### 5.1.4 change listener

**`src/renderer.js:2869-2875`** 重写：
```javascript
elements.templateSelect.addEventListener('change', (event) => {
  const nextMode = event.target.value === 'monthly-balance' ? 'monthly-balance' : 'statement';
  if (state.currentStatementMode === nextMode) return;
  state.currentStatementMode = nextMode;
  applyStatementModeSideEffects();
});
```

**新增 `applyStatementModeSideEffects`**：

```javascript
function applyStatementModeSideEffects() {
  const isStatement = state.currentStatementMode === 'statement';
  // 按钮可用/禁用矩阵（PRD §5.1.1）
  elements.importFileBtn.disabled = !isStatement;
  elements.accountMappingBtn.disabled = !isStatement;
  elements.exportDetailBtn.disabled = !isStatement || !state.canExportDetail;
  if (isStatement) {
    elements.exportBalanceBtn.disabled = !state.canExportBalance;
    state.selectedTemplateId = FILENAME_MAPPING_TEMPLATE_ID;
  } else {
    // 月度余额模式：导出余额始终可用（点击会弹装配弹窗或触发另存为）
    elements.exportBalanceBtn.disabled = false;
    // 保留现有 session 不清（PRD §九.5 + 决策 Q13）
    setStatus('点击"导出余额"选择模板和年月', 'info');
  }
}
```

#### 5.1.5 `handleExportBalance` 分流

**`src/renderer.js:2730-2750`** 修改：

```javascript
async function handleExportBalance() {
  if (state.currentStatementMode === 'monthly-balance') {
    // 分支 A：未装配 → 弹装配对话框；已装配 → 弹系统另存为
    if (!state.monthlyBalanceReady) {
      openModal(createMonthlyBalanceExportDialog());
      return;
    }
    const result = await window.desktopApi.files.monthlyBalanceExport();
    setStatus(result.message, result.status === 'success' ? 'success' : 'error');
    return;
  }
  // 分支 B：statement 模式 —— 保留 v1.5.2 原逻辑
  const result = await window.desktopApi.files.exportBalance();
  // ... 原代码
}
```

#### 5.1.6 `createMonthlyBalanceExportDialog`（新建）

**位置**：`src/renderer-dialogs.js`（在 `createExportScopeDialog` 附近；具体行号由 Dev 决定，建议放在 `:157` 之后）

**DOM 骨架**：
```html
<div class="modal-overlay">
  <div class="modal-card monthly-balance-export-card">
    <div class="dialog-header">
      <div class="dialog-title">请选择需要导出月度余额账单的银行渠道</div>
      <button class="icon-close" type="button">×</button>
    </div>
    <div class="monthly-balance-form">
      <label class="form-row">
        <span class="form-label">模板</span>
        <select class="template-scope-select">
          <option value="__ALL_BANKS__" selected>全部银行渠道</option>
          <!-- 普通模板 options -->
        </select>
      </label>
      <label class="form-row">
        <span class="form-label">时间</span>
        <div class="year-month-picker">
          <select class="year-select">
            <!-- 近 10 年 ~ 今年+1 -->
          </select>
          <select class="month-select">
            <option value="" selected>-- 选择月 --</option>
            <option value="1">1 月</option>
            ...
            <option value="12">12 月</option>
          </select>
        </div>
      </label>
    </div>
    <div class="dialog-actions right">
      <button class="primary-btn small" type="button" data-action="done">完成</button>
    </div>
  </div>
</div>
```

**行为**：
- 初始化年份下拉：`currentYear = new Date().getFullYear()`，范围 `[currentYear-9, currentYear+1]`（即"近 10 年 ~ 今年+1"，2026 年显示 2016-2027）
- 月份默认未选（空 option），用户必须主动选
- 完成按钮点击时：
  1. 前端校验：模板为空 → `openModal(createAlertDialog('请选择模板'))` 后重新打开本弹窗；时间为空 → 同上 `'请选择时间'`；两者都空 → `'请选择模板和时间'`
  2. 校验通过 → 调 `window.desktopApi.files.monthlyBalanceAssemble({ templateScope, year, month })`
  3. IPC 返回 `status:'error', errorCode:'MONTHLY_BALANCE_EMPTY'` → `openModal(createAlertDialog(errorMessage))` 后重弹本弹窗
  4. IPC 返回 `status:'success'` → `closeModal()`，`state.monthlyBalanceReady=true`，`setStatus('月度余额账单已准备好，点击"导出余额"另存为文件','success')`

#### 5.1.7 模式切换不丢 session

`applyStatementModeSideEffects` 只改按钮状态和 `selectedTemplateId`；**不调用** `clearGeneratedExports()`、**不清** `statementImportSessions`。切回 `statement` 模式时 `state.canExportDetail / canExportBalance` 由上次装载决定，按 P1-1 验证。

### 5.2 R2：银行账号导入 UI 变更

#### 5.2.1 `createBigAccountManagerDialog` tbody 初始化

**`src/renderer-dialogs.js:1988 渲染 bigAccounts` + `:2020 import-bank-info handler`**：

当前：
```javascript
// :2032
pendingOwnAccounts = result.ownAccounts || [];
tbody.innerHTML = '';
const clientAccounts = result.clientAccounts || [];
if (clientAccounts.length === 0) {
  tbody.appendChild(createBigAccountRow({}, 'edit'));
} else {
  clientAccounts.forEach((item) => {
    tbody.appendChild(createBigAccountRow(item, 'view'));
  });
}
```

改为：
```javascript
tbody.innerHTML = '';
const clientAccounts = (result.clientAccounts || []).map(a => ({ ...a, accountNature: 'client' }));
const ownAccounts = (result.ownAccounts || []).map(a => ({ ...a, accountNature: 'own' }));
const combined = clientAccounts.concat(ownAccounts);
if (combined.length === 0) {
  tbody.appendChild(createBigAccountRow({}, 'edit'));
} else {
  combined.forEach((item) => {
    tbody.appendChild(createBigAccountRow(item, 'view'));   // accountNature 作为 data-* attribute 挂到 tr 上
  });
}
// pendingOwnAccounts 不再使用（可删除该变量，或保留为 null 方便差异最小化）
```

#### 5.2.2 `createBigAccountRow` 带 accountNature

**`src/renderer-dialogs.js:1767`**：`row.dataset.accountNature = item.accountNature || 'client';`

UI 上**不显示**nature 标识（PRD §5.2.1 明示）。仅通过 dataset 传递给"完成"按钮的收集逻辑。

#### 5.2.3 "完成"按钮收集 nature

**`src/renderer-dialogs.js:2087-2107`**：

```javascript
const nextBigAccounts = rows.map((row) => {
  const merchantId = row.querySelector('.big-account-merchant-input').value.trim();
  const isMultiCurrency = row.querySelector('.big-account-multi-checkbox').checked;
  const currencies = isMultiCurrency ? ... : ...;
  const accountNature = row.dataset.accountNature || 'client';  // 新增
  return { merchantId, currencies, isMultiCurrency, accountNature };
}).filter(...);

// onDone 回调时不再传 { ownAccounts: pendingOwnAccounts }，因为已合并
onDone(nextBigAccounts);
```

#### 5.2.4 调用方不再调 `saveOwnAccounts`

**`src/renderer-dialogs.js:2649-2659`**：

```javascript
onDone: async (nextBigAccounts) => {
  // 删除原 extra.ownAccounts 处理分支
  // saveMappings 时把 nextBigAccounts（含 nature）直接下发到后端
  openModal(createMappingDialog({
    ...payload,
    bigAccounts: nextBigAccounts,
    // ... 其它字段
  }));
}
```

**`saveMappings` IPC 入参**（`src/preload.js:40`）保持不变，但后端解包 `bigAccounts[].accountNature` 字段。

#### 5.2.5 `template:get-big-accounts-with-own` 需求

"维护大账号"对话框初始化时，tbody 需要显示客资**和**自有账号（§3.1 的特例：仅 UI 展示，不参与业务）。当前 IPC `template:get-mappings` 返回的 `bigAccounts`（来自 `getTemplateMappings` → `getTemplateBigAccounts`）现在默认过滤自有。

**方案**：给 `template:get-mappings` IPC 加入参 `{ includeOwnBigAccounts: true }`；或新增独立 IPC `template:get-big-accounts-with-own`。

**Dev 推荐**：新增独立 IPC（更易 grep、更易回滚）：
- preload：`templates.getBigAccountsWithOwn: (templateId) => ipcRenderer.invoke('template:get-big-accounts-with-own', templateId)`
- main.js handler：直接调 `database.getTemplateBigAccounts(templateId, { includeOwn: true })` 返回
- renderer-dialogs 打开维护大账号对话框前先调此 IPC 拿完整列表，再传给 `createBigAccountManagerDialog`

---

## 六、IPC 契约

### 6.1 新增 IPC

| Channel | payload | 返回值 | 描述 |
|---------|---------|--------|------|
| `monthly-balance:assemble` | `{ templateScope: string, year: number, month: number }` | `{ status:'success', recordCount, fileName } \| { status:'error', errorCode, message }` | R1：装配月度余额 records 并写入临时 xlsx；`templateScope` 为具体模板名或 `'__ALL_BANKS__'` |
| `monthly-balance:export` | — | `{ status:'success', message } \| { status:'cancelled' } \| { status:'error', ... }` | R1：弹系统另存为，把 `lastGeneratedExports.monthlyBalance.filePath` 复制到用户选的路径 |
| `template:get-big-accounts-with-own` | `templateId: number` | `{ status:'success', bigAccounts: [{merchantId, currencies, isMultiCurrency, accountNature}] }` | R2：维护大账号对话框初始化专用；含 `account_nature='own'` |

### 6.2 修改 IPC

| Channel | 变更 |
|---------|------|
| `big-account:import-bank-info` | 返回值保持 `{status, message, clientAccounts, ownAccounts}` 兼容 v1.5.2；前端把两类合并到 tbody |
| `template:save-mappings` | `payload.bigAccounts[]` 新增 `accountNature` 字段；后端在 `saveMappings` 里按此字段写 DB |
| `template:get-mappings` | 返回的 `bigAccounts[]` 默认**不含**自有（§3.1 规则）；UI 若需要两类一起展示则改用 `template:get-big-accounts-with-own` |

### 6.3 废弃 IPC（保留源码）

| Channel | 状态 |
|---------|------|
| `big-account:save-own-accounts` | 前端不再调用；handler 保留（`src/main.js:6207-6225`）；在 handler 开头加 `appendActivityLogEntry({level:'warn', message:'big-account:save-own-accounts 已废弃（v1.5.3）'})` 方便定位误调用 |

### 6.4 preload 变动

`src/preload.js:70-78` 新增：
```javascript
files: {
  // 保留现有字段 ...
  monthlyBalanceAssemble: (payload) => ipcRenderer.invoke('monthly-balance:assemble', payload),
  monthlyBalanceExport: () => ipcRenderer.invoke('monthly-balance:export')
},
templates: {
  // 保留现有字段 ...
  getBigAccountsWithOwn: (templateId) => ipcRenderer.invoke('template:get-big-accounts-with-own', templateId)
}
```

---

## 七、测试策略

### 7.1 smoke 场景增量

`scripts/smoke-test.js` 基于 temp dir 模拟完整流程。本次新增：

- **R1 smoke**：构造一个 balance-seeds json（含目标月末当日记录 + 早于月末一个月的记录），调用新 IPC `monthly-balance:assemble` → 验证装配出的 records 数量、billDate 选择正确、单 sheet 输出
- **R2 smoke**：
  - 构造 own-accounts/{bankName}.json（2 条记录）→ 启动 DB + `runOwnAccountsMigration` → 查 `template_big_accounts` 断言 nature='own'
  - 二次启动 → 断言 migration short-circuit（查 settings flag 并跳过）
- **R3 smoke**：导出明细 + 余额 xlsx → 读回 xlsx（用 `xlsx-js-style` 或 `xlsx` 读）→ 断言 r=0 每个 cell 的 `s.font.name === 'Courier New'`，r≥1 不等于 'Courier New'

> 提示：smoke 脚本目前不测 Electron UI 层；UI 部分进人工测试清单（PRD §七）。

### 7.2 手动回归清单

详见 PRD §七 P0/P1（总计 P0=21 条，P1=8 条）。

**重点回归**（R2 的 §3.1 过滤是最大隐患）：
- P0-11 验证自有账号在 R1 月度余额中出现
- P0-16 验证制作网银账单流程不含自有账号
- P1-4 重复导入不重插
- P1-5 bundle 导出/导入带 nature

### 7.3 资金字段的样例验证数据

**R1 P0-4 ~ P0-7 测试固定数据集**（Dev 在 `scripts/fixtures/` 下准备）：

```json
// scripts/fixtures/balance-seeds/中行.json
[
  { "merchantId": "6225880101234567", "currency": "CNY", "billDate": "2026-03-31", "endBalance": 10000.50, "templateName": "中行-北京", "生成方式": "人工录入", "updatedAt": "2026-03-31T10:00:00Z" },
  { "merchantId": "6225880101234567", "currency": "CNY", "billDate": "2026-02-28", "endBalance":  8000.00, "templateName": "中行-北京", "生成方式": "人工录入", "updatedAt": "2026-02-28T10:00:00Z" },
  { "merchantId": "6225880109999999", "currency": "USD", "billDate": "2026-04-30", "endBalance":  5000.00, "templateName": "中行-北京", "生成方式": "人工录入", "updatedAt": "2026-04-30T10:00:00Z" }
]
```

预期行为（`templateScope='中行-北京'`, year=2026, month=3）：
- `6225880101234567 / CNY` → 取 2026-03-31 的 10000.50（精确匹配）
- 若去掉第一条 → 取 2026-02-28 的 8000（兜底）
- `6225880109999999 / USD` → 所有 seeds billDate > 2026-03-31 → **跳过**，不出现在导出文件

### 7.4 覆盖范围与未覆盖

**已覆盖**：
- R1/R2/R3 各自的主路径（功能正确）
- R2 迁移幂等 + 冲突处理（数据完整性）
- §3.1 过滤一致性（通过 P0-16 + P0-11 对照验证）

**未覆盖（原因）**：
- `new-account:generate` 模块导出字体不变（决策 Q11 明示不测）
- Courier New 在所有操作系统 × Excel 版本的渲染差异（风险由用户承担，抽样 P0-21 验证）
- bundle v3 → v4 升级（Dev 评审 R-3 决定保持 v3）

---

## 八、回滚策略

### 8.1 Schema 迁移的回退 SQL

若 R2 schema 需要撤回（一般不需要，因为旧代码忽略新字段可运行）：

```sql
-- SQLite 不支持 DROP COLUMN（直到 3.35.0+ 部分支持）
-- 兼容方案：重建表
BEGIN;
ALTER TABLE template_big_accounts RENAME TO template_big_accounts_v153;
CREATE TABLE template_big_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  merchant_id TEXT NOT NULL,
  currency TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
  UNIQUE(template_id, merchant_id, currency)
);
INSERT INTO template_big_accounts (id, template_id, merchant_id, currency, row_index, created_at, updated_at)
  SELECT id, template_id, merchant_id, currency, row_index, created_at, updated_at FROM template_big_accounts_v153
  WHERE account_nature = 'client';  -- 自有账号在回退时丢弃（不可避免）
DROP TABLE template_big_accounts_v153;
COMMIT;
```

**注意**：回退会丢失自有账号在大账号表的记录，但原 `own-accounts/{bankName}.json` 保留（§5.2.3），可作为 v1.5.2 行为的数据源。

### 8.2 own-accounts/*.json 作为 fallback

- `own-accounts/*.json` 在 R2 迁移后**不删除**；
- 若需要回退到 v1.5.2 代码，旧版本的 `readOwnAccounts(storageRoot, bankName)` 仍能工作；
- 回退代码后，数据库里的 `account_nature='own'` 记录会因旧代码不读该字段而被"当作客资处理"——但 v1.5.2 代码路径里"客资"的唯一定义就是 `template_big_accounts` 里的全部记录，行为退化到 v1.5.2-before-nature，即自有账号会意外出现在制作网银账单流程。

**回退清洗**（若必须回退）：
```sql
DELETE FROM template_big_accounts WHERE account_nature = 'own';
```
（依赖回退前执行 8.1 前置步骤或用 account_nature 判断）

### 8.3 字体回退

R3 回滚只需：
1. `git revert` writers.js 的改动
2. `package.json` 移除 `xlsx-js-style` 依赖（可选，保留不影响 v1.5.2 运行）
3. 已导出的 xlsx 文件**无需处理**（字体是文件内元数据，回滚代码不影响已导出文件）

### 8.4 完整回退流程顺序

```
1. git revert v1.5.3 commits（主分支）
2. 执行 §8.1 SQL（在重启前）
3. 重启应用 → 老代码读取数据库无 account_nature 字段（ALTER DROP 后）→ 正常运行
4. 保留 own-accounts/*.json 不动（v1.5.2 代码会读）
```

---

## 九、任务分解

> 详见 `changes/v1.5.3/tasks.md`。本节仅列出依赖链摘要。

**依赖链**：
```
G2（R2 基础设施）
  T2.1 schema 迁移函数 → T2.2 门面注册 → T2.3 数据迁移模块 → T2.4 启动序列调用
       ↓（R2 schema 就绪后）
  T2.5 模板 repo 参数扩展 → T2.6 IPC 新增 get-big-accounts-with-own
       ↓（仓库层 + IPC 就绪）
  T2.7 前端 import-bank-info 合并 tbody → T2.8 前端收集 nature 回写 → T2.9 废弃 saveOwnAccounts 调用
       ↓（R2 完成）
G1（R1 月度余额）
  T1.1 新增 listBalanceSeedBankNames helper → T1.2 新增 monthly-balance.js 模块
       ↓
  T1.3 新增 monthly-balance:assemble IPC → T1.4 新增 monthly-balance:export IPC
       ↓
  T1.5 前端 updateTemplateSelect 改造 → T1.6 前端按钮矩阵 applyStatementModeSideEffects
       ↓
  T1.7 前端 createMonthlyBalanceExportDialog → T1.8 handleExportBalance 分流
       ↓（R1 完成）
G3（R3 表头字体）⬅️ 最后做，减少对 R1 验证的干扰
  T3.1 引入 xlsx-js-style 依赖 → T3.2 writers.js 新增 applyHeaderRowFont
       ↓
  T3.3 writeWorkbookRows 注入 → T3.4 writeBalanceWorkbook 注入
       ↓
  T3.5 验证合并场景字体（mergeGeneratedXlsxFiles）
```

**关键依赖**：
- R1 读 `template_big_accounts` 时要带 `includeOwn=true`——必须等 R2 的 `getTemplateBigAccounts` 参数扩展完成（T2.5）
- R2 的 `runOwnAccountsMigration` 读 `template_big_accounts` 时要写入 `account_nature='own'`——必须等 schema 迁移（T2.1-2.2）
- R3 最后做，避免 writers.js 被多次改动冲突

---

## 十、实施日志

> 记录实施过程中的关键决策、风险发现和可沉淀知识。

### 2026-04-20 初稿

- 动作：PM v1 PRD 定稿后，Dev 撰写 TechDoc v1.5.3 初稿
- 证据：PRD §十 13 个决策点全部落地；TechDoc §二 影响面矩阵覆盖 12 个文件（新增 2 + 修改 10）
- 风险：
  - SheetJS 社区版样式写入限制（§1.2 R-1）→ 已决策引入 xlsx-js-style
  - §3.1 过滤一致性横跨 repo 层 + IPC 层 + 前端层（§1.2 R-2）→ 已给出逐位置清单（§2.3、§4.2.5）
  - 维护大账号对话框的 nature 混合展示需要新 IPC（§5.2.5）→ 已设计 `template:get-big-accounts-with-own`
- 决策：保持 bundleVersion 为 v3（§1.2 R-3）；迁移放在 main.js 启动序列而非 database.init()（§4.2.2）；R3 仅 writers.js 局部切换到 xlsx-js-style（§4.3.1）

### 2026-04-20 D14/D15/D16 决策回写（变更最小）

- 动作：
  - **D14**（OT-5 = B）：§四.R3 开头加决策 note（直接写死 Courier New，不加可选参数）；§十一 OT-5 行改为 RESOLVED = B，删除"宽松 vs 严格"分支讨论
  - **D15**（迁移失败不阻塞启动）：§三.4 迁移伪码外层包 try/catch，失败返回 `{ok:false}` 而非抛异常；新增"失败告警语义"小节说明主窗口加载完成后状态栏 error tone 告警
  - **D16**（orphan bankName 跳过 + 写日志）：§三.4 迁移伪码 `matchingTemplates.length===0` 分支显式注释 D16 意图 + 追加 `[WARN] orphan bankName: ...` 日志；日志文件段落说明 orphan 与整体失败通过 `[WARN]` / `[ERROR]` 前缀区分
- 证据：§三.4、§四.R3 头部 note、§十一 OT-5 三处改动
- 风险：无新增；D14/D15/D16 为已有风险的收敛决策

### 可沉淀知识

- [ ] 若 v1.5.3 定稿后验证 `xlsx-js-style` 与 `xlsx` 兼容性稳定，可在 `knowledge/` 沉淀"SheetJS 社区版样式写入的最小依赖变更方案"
- [ ] `template_big_accounts` 的 `account_nature` 字段 + `getTemplateBigAccounts({includeOwn})` 参数模式可作为"SQL 层软过滤 + 调用方显式放行"的范例，沉淀到 `knowledge/db-pattern.md`（如有）
- [ ] §3.1 跨需求的"自有账户隔离"规则如果在 v1.5.x 稳定，可沉淀到 `rules/domain-rules.md` 作为长期业务规则

---

## 十一、Open Technical Questions

| 编号 | 问题 | 当前处置 | 触发升级条件 |
|------|------|----------|-------------|
| OT-1 | `xlsx-js-style` 在 Electron 36 + electron-builder 26 打包环境下是否会触发 native 模块问题？ | 按 §4.3.1 "无 native 依赖"假设落地；smoke 环境验证 | 若打包后 xlsx 文件不含 `s` 字段 → 升级为 TechDoc v2，研究 `xlsx-populate` / `exceljs` 替代 |
| OT-2 | `mergeGeneratedXlsxFiles` 浅拷贝 `{ ...cell }` 是否完整保留 `s` 字段？| §4.3.2 假设保留，P1-6 测试验证 | 若字段丢失 → 在合并函数出口加 `applyHeaderRowFont` |
| OT-3 | `saveMappings` 入参 `bigAccounts` 的展平点（前端/后端）？| TechDoc §4.2.4 提示实施时需 grep 确认；默认按"前端已展平"假设 | 实施时发现后端再展平 → `accountNature` 必须在前端展平时就绑定到 `(merchantId, currency)` 级别 |
| OT-4 | R1 弹窗的 CSS 类命名（`monthly-balance-export-card` 等）是否与现有 `styles.css` 冲突？| §5.1.6 假设类名不冲突；实施时先 grep | 冲突则加 `v153-` 前缀 |
| OT-5 | `writeBalanceWorkbook` 被制作网银账单导出余额 + R1 月度余额 + 新开账户模块三条路径共用，R3 字体改动一次全改 | **RESOLVED = B**（决策 D14，2026-04-20）：直接写死 Courier New，不加可选参数；新开账户模块导出表头一并变 Courier New，用户已知情并接受 | — |

**OT-5 收敛记录**（D14，2026-04-20）：用户选择方案 B —— `writeBalanceWorkbook` / `writeDetailWorkbook` / `writeWorkbookRows` 全部直接写死 `Courier New`，不加 `applyHeaderFont` 等可选参数。新开账户模块导出表头因共用 writer 一并改为 Courier New，属于用户接受的副作用。对应 PRD §三.3.5、§五.3.3 覆盖范围表已同步。
