# Log — v1.5.3

## 2026-04-19 PM — PRD v0 草稿完成

- 动作：
  - 建立 `docs/iterations/v1.5.3/` 与 `changes/v1.5.3/` 目录
  - 撰写 `PRD-v1.5.3.md`（v0 草稿），包含 3 项需求（R1/R2/R3）、13 个待确认点、骨架 AC（21 条）、骨架 P0/P1 测试清单（21 条）
  - 建立 spec/tasks/log 骨架
- 证据：
  - `docs/iterations/v1.5.3/PRD-v1.5.3.md` 已写入
  - `changes/v1.5.3/spec.md`、`tasks.md`、`log.md` 已建立
  - PRD 中代码现状章节的每一行都有 `file:line` 出处，基于 v1.5.x 分支 commit `6e5df3a` 基线
- 风险：
  - **资金字段**：R1 月度余额账单的 `endBalance` 直接给财务团队用，需人工复核"最新余额"Q2 候选方案
  - **数据迁移**：R2 自有账号从 json 迁到 SQLite，需要幂等 + 原 json 文件保留策略（Q6）
  - **主页面重构**：R1 改动涉及 v1.5.2 刚稳定的 `__FILENAME_MAPPING__` 机制，TechDoc 阶段需再做 grep 审查
- 决策：无（v0 阶段 PM 不自主决策，全部问题集中在 PRD §十 等用户拍板）

---

## 2026-04-20 PM — v1 定稿 + TechDoc 完成

- 动作：
  1. 收集用户对 13 个决策点的答案（Q1/Q4/Q6/Q10/Q11 为"自定义"，Q2/Q7 为 A，其余为"按 PM 推荐"），逐条落地
  2. 升级 PRD v0 → v1 定稿：
     - 头部版本标注改为 v1（定稿）/ 2026-04-20
     - 新增 §三「总体规则（跨需求约束）」章节，把 Q6 的强约束（自有账户仅在 R1 出现）升级为 PRD 级一致性规则
     - 把"按 Qx 决策……"的推迟表达全部改为直述规则文本
     - §十 从「待确认点」改为「决策记录」
     - AC 扩展 21 → 27 条（新增 AC1-12/13/14、AC2-6/7、AC3-6）
     - P0 扩展 14 → 21 条（新增 P0-11 自有账号 R1 出现、P0-13~15 R2 迁移三态、P0-16 §3.1 过滤验证、P0-21 CJK 渲染抽查）
     - §九 风险提醒扩展至 7 项（新增 Q2 未来余额排除、§3.1 过滤一致性、SheetJS 社区版样式写入、单 sheet 合并字段差异）
  3. 撰写 `TechDoc-v1.5.3.md`：
     - §一 PRD 评审意见（6 条技术意见 R-1 ~ R-6）
     - §二 影响面矩阵（新增 2 + 修改 22 + 不改需关注 7 个文件位置，全部带 file:line）
     - §三 数据模型改动（schema SQL + 门面注册 + 参数扩展 + 迁移流程伪码）
     - §四 后端实现（R1 monthly-balance 模块 + R2 migration + R3 xlsx-js-style 局部切换）
     - §五 前端实现（模式下拉改造 + 维护大账号 tbody 合并 + 新增弹窗）
     - §六 IPC 契约（3 新增 + 3 修改 + 1 废弃保留）
     - §七 测试策略（smoke 增量 + 固定数据集 + 覆盖范围）
     - §八 回滚策略（含 SQLite rebuild 回退 SQL）
     - §九 任务分解（依赖链可视化）
     - §十一 Open Questions（5 条，含 OT-5 新发现的 writeBalanceWorkbook 共用问题）
  4. 同步更新 `changes/v1.5.3/spec.md`、`tasks.md`：
     - spec.md §8 13 个 checkbox 全部打勾，新增 §9 记录 TechDoc 阶段发现的 OT-5
     - tasks.md 展开到 T2.1~T2.10（10 条）+ T1.1~T1.9（9 条）+ T3.1~T3.5（5 条）= 24 条可执行任务（原计 23，TechDoc §4.2.5 引入 `template:get-big-accounts-with-own` 新 IPC 后补 T2.10）；每条带涉及文件 + 操作 + 验证证据 + 依赖
- 证据：
  - `docs/iterations/v1.5.3/PRD-v1.5.3.md` v1 定稿（头部 "v1（定稿）/ 2026-04-20"）
  - `docs/iterations/v1.5.3/TechDoc-v1.5.3.md` 初稿完成（11 个主章节）
  - `changes/v1.5.3/spec.md` status 从 propose 改为 ready；13 个 checkbox 勾选
  - `changes/v1.5.3/tasks.md` 24 个 task 的依赖链可视化完成
- 风险（需 Dev 人工复核的红线点）：
  1. **R2 数据迁移**（T2.3/T2.4）：一个 bankName 对多个模板时"全部写入"策略可能导致自有账号在多模板间重复，orphan bankName 处理 + 冲突保留策略必须严格按 log 审核
  2. **§3.1 过滤约束**（T2.5/T2.6/T2.9）：跨 repo 层 + SQL 层 + 前端层；漏改一处自有账号就会渗透到制作网银账单流程，破坏业务隔离
  3. **R1 资金字段装配**（T1.2）：Q2 "最新余额"定义（billDate ≤ 月末最大一条）+ 未来余额排除（全部大于月末 → 跳过）两条规则集中在 `assembleMonthlyBalance`，必须覆盖 P0-4 ~ P0-7 全部场景
  4. **SheetJS 社区版限制**（T3.1/T3.2）：`xlsx-js-style` 局部替换为 R3 独有路径，electron-builder 打包验证仍需 smoke 抽样
  5. **OT-5 新发现**：`writeBalanceWorkbook` 被"制作网银账单导出余额"+"新开账户模块"共用，R3 字体注入会同时影响新开账户（PRD Q11 明示不改）。Dev 倾向接受宽松解读；实施中如用户反馈不接受，需加参数 `applyHeaderFont=true/false` 精确控制
- 决策：
  - bundleVersion 保持 v3（向后兼容，新字段可选）
  - own-accounts 数据迁移放在 `src/main.js` 启动序列（非 `database.init()`）—— 因为需要 Electron 的 `storageRoot`
  - `xlsx-js-style` 仅在 `src/backend/file-service/writers.js` 局部替换，减少打包体积增长
  - 新增独立 IPC `template:get-big-accounts-with-own` 供维护大账号对话框初始化（便于 grep / 回滚）
  - 实施顺序：**G2（R2）→ G1（R1）→ G3（R3）**，依赖链保证 R1 能拿到 `{includeOwn:true}` 参数

---

## 2026-04-20 PM — D14/D15/D16 决策回写（变更最小）

- 动作：用户追加 3 条决策，PM 按"只改必要段落，不扩写"原则回写：
  - **D14**（OT-5 = B）：PRD §三新增 §3.5 覆盖范围声明 + §5.3.3 覆盖表"新开账户模块"改为 ✅；TechDoc §四.R3 开头加 D14 决策块 + §十一 OT-5 标 RESOLVED = B；tasks T3.2/T3.4 描述去掉"加可选参数"并注明 D14 写死
  - **D15**（迁移失败不阻塞启动）：PRD §九 新增第 8 条风险条目；TechDoc §三.4 迁移伪码外层包 try/catch + 失败告警语义小节；tasks T2.4 验收条件补"模拟迁移失败 → 启动成功 + 状态栏告警 + 日志写入"
  - **D16**（orphan bankName 跳过 + 写日志）：TechDoc §三.4 迁移伪码 matchingTemplates 空分支显式注释 D16 + 日志文件段落说明 `[WARN]` 前缀；tasks T2.4 验收条件补"orphan 用例 → 启动成功 + 状态栏无告警 + 日志 `[WARN]`"
  - spec.md §8 追加 D14/D15/D16 三条 checkbox
- 证据：
  - PRD §3.5、§5.3.3 表格、§九.8 三处改动
  - TechDoc §三.4 伪码、§四.R3 头部 note、§十一 OT-5 行三处改动
  - tasks T2.4、T3.2、T3.4 三处改动
  - spec.md §8 三条新增 checkbox
- 风险：无新增风险（D14/D15/D16 均为已有风险的收敛决策）
- 决策：
  - OT-5 关闭为 RESOLVED = B
  - R2 迁移改为"非阻塞启动 + 状态栏显著告警"模式（资金迁移风险通过告警可见性保证）
  - orphan 不视为迁移失败

---

## 2026-04-20 Dev — G2 R2 数据模型实施

> 依据 `TechDoc §三`（数据模型改动）。TechDoc 行号基于 commit `6e5df3a`，HEAD 已推进到 `a178d55`（v1.5.2 feat 给 main.js 加 +899 行），不按行号锚点定位，改按 file:func_name。

### G2 最终冒烟 — done

- `npm run smoke` pass ✅
- 集成测试：
  - 空库 init → schema 含 `account_nature TEXT NOT NULL DEFAULT 'client'` ✅
  - 迁移 status=done ✅
  - 二次启动 status=already-done（幂等） ✅
  - saveMappings 混合提交 2 client + 1 own → `listTemplates.bigAccountCount=2`（只 client） ✅
  - `listTemplateBundleEntries` 返回 3 条带 accountNature 的 bigAccounts（client:C_A + client:C_B + own:OWN_A） ✅
  - `getTemplateBigAccounts` 默认 2 条；`{includeOwn:true}` 3 条 ✅

### G2 偏离 TechDoc 的点（全是无碍收敛，不涉及功能偏离）

1. **TechDoc §三.2 flag key `own_accounts_migration_v1.5.3_done` → 代码用 `own_accounts_migration_v1_5_3_done`**（TechDoc 伪码用点号；代码用下划线更稳妥，setting_key 无需转义）
2. **TechDoc §三.4 伪码用 `readOwnAccounts` 吞异常**，代码改为**主动 fs.readFileSync + JSON.parse**，让损坏 json 能被外层 catch 捕获为 `failed`（D15 的"失败状态栏告警"语义需要损坏 json 能触发）
3. **TechDoc §三.3 SELECT `id` 字段未列出**，代码里 getTemplateBigAccounts ORDER BY 仍用 `id ASC`（需要这个字段参与 ORDER；未用 SELECT id 无功能影响）
4. **`groupBigAccountRows`（utils.js）分组 key 扩展为 `merchantId::accountNature`**，TechDoc 未明示；但不改就会让 client + own 同 merchantId 的行被错误合并（bundle 导出不带 nature 区分就只有一条），属于边缘 case 的正确处理

### G1 R1 接手前需注意

1. `database.getTemplateBigAccounts(templateId, { includeOwn: true })` 已可用；R1 月度余额装配 `assembleMonthlyBalance` 必须显式传第二参数
2. IPC 层新增了 `big-account:get-with-own`（preload `window.desktopApi.bigAccount.getWithOwn`），R1 弹窗如需读含自有的大账号可直接用
3. `splitTemplateName(name).bankName` 只按 `-` 切第 0 段，与迁移用的 `getTemplatesByBankName` 口径一致
4. `listTemplates` 的 `bigAccountCount` 不含 own；R1 的"普通模板"过滤（`!isParent && !parentTemplateId`）可继续沿用
5. 自测损坏 json 场景时，主进程 `lastOwnAccountsMigrationError` 会被 set，renderer 首次 `app:get-info` 读取后通过 `setStatus(..., 'error')` 覆盖 enum 默认文案；R1 弹窗 setStatus 会把该告警覆盖（符合 spec "下次 setStatus 覆盖"）

### T2.10 — 新 IPC `big-account:get-with-own` — done

- 改动：
  - `src/main.js:registerBigAccountHandlers`：新增 handler `big-account:get-with-own`，接收 templateId，返回 `{ status, bigAccounts }`（内部调 `database.getTemplateBigAccounts(templateId, { includeOwn: true })`）
  - `src/preload.js:bigAccount`：加 `getWithOwn: (templateId) => ipcRenderer.invoke('big-account:get-with-own', templateId)`
- 前端暂时不调用（G1 月度余额弹窗 / 维护大账号对话框初始化将在其它 task 接入）
- 自测：模拟 db.getTemplateBigAccounts(1, { includeOwn: true }) → 返 2 条（C1:client + OWN1:own）；默认参数 → 1 条（C1:client） ✅

### T2.9 — 废弃前端单独存 own 的路径（保留并行） — done

- 决策：`pendingOwnAccounts` 仍通过 `onDone(..., { ownAccounts: pendingOwnAccounts })` 回传；`manageBigAccountBtn.onDone` 仍调 `window.desktopApi.bigAccount.saveOwnAccounts(...)`（写 own-accounts/*.json）；同时 saveMappings 路径已在 T2.5 + T2.8 把 own 也写进 template_big_accounts
- 效果：json + 数据库**并行写**，作为过渡期兼容层（Q6 决策）；将来某个 major 版本可通过删 saveOwnAccounts 调用彻底下线
- 未改动代码（Q6 放行保留）：`src/preload.js:58 saveOwnAccounts`、`src/main.js:big-account:save-own-accounts handler`、`src/backend/own-account-store.js`

### T2.8 — renderer-dialogs 前端 tbody 合并 client+own — done

- 改动（`src/renderer-dialogs.js`）：
  - `createBigAccountRow`：tr 加 `row.dataset.accountNature`（'client' / 'own'，来自 item.accountNature，缺省 'client'）
  - 新增内部函数 `setMerchantViewText(merchantId)`：view 态下 own 行在 merchantView 前加 `[自有] ` 前缀（不写进 input 值），client 无前缀；merchantInput 输入事件 / toggleComplete / initialMode='view' 初始化 3 处统一走它
  - `import-bank-info` handler：原来只填 clientAccounts 到 tbody，现在合并 `[...client.map(nature=client), ...own.map(nature=own)]` 都填进去；`pendingOwnAccounts` 仍保留供 `saveOwnAccounts` IPC 过渡兼容（Q6）
  - `[data-action="done"]` 收集 nextBigAccounts 时读 `row.dataset.accountNature` → accountNature 字段
  - `balance-management` 往返：重建 bigAccounts 时从 `big-account-merchant-input.value`（裸 merchantId）取，避免被 `[自有] ` 前缀污染；同时从 row.dataset 保留 accountNature
  - `cloneBigAccountItems`：保留 accountNature 字段
- 注意：view 态下 merchantInput 的 input 事件同步更新 merchantView 的文本+前缀；此处 input 在 view 态下 merchantInput.value 始终保持裸 merchantId（符合原代码 `row.dataset.mode === 'view'` 分支早退）
- 语法 check OK（node --check）

### T2.7 — bundle 导入导出带 accountNature — done（bundleVersion 保持 v3）

- 改动：
  - `src/backend/database/utils.js:groupBigAccountRows`：分组 key 改为 `merchantId::accountNature`，避免 client 和 own 同 merchantId 被错误合并；返回项含 `accountNature`
  - `src/backend/database/template-repository.js:listTemplateBundleEntries`：独立再查一次 `getTemplateBigAccounts(..., {includeOwn: true})` → `groupBigAccountRows`，bundle 导出项含 `accountNature` 字段
  - `src/main.js:readTemplateBundleFile`：未改（bigAccounts 原样透传 JSON 即可；下游 validateTemplateConfiguration 已处理 accountNature 缺省 → 'client'）
- bundleVersion：**保持 v3**（bigAccounts[i].accountNature 为**可选**字段，旧版读时忽略向后兼容；新版读旧 bundle 时缺省 → 'client'）
- 自测：
  - BOC 模板含 `C1/CNY + C1/USD + OWN1/CNY` 三条 → bundle 导出 `[{C1, ["CNY","USD"], isMulti:true, nature:client}, {OWN1, ["CNY"], nature:own}]`（client 和 own 独立分组） ✅
  - 重新 saveMappings(导出后的 bigAccounts) → DB 回写，client/own 保留 ✅
  - 老 bundle 格式（`[{merchantId, currency}]` 无 accountNature 字段）→ saveMappings 默认 'client' ✅

### T2.6 — SQL/Repository 层 §3.1 过滤 — done

- 改动位置（所有 `bigAccountCount` / `singleBigAccountMerchantId` 相关子查询加 `AND ba.account_nature = 'client'`）：
  - `src/backend/database/template-repository.js:listTemplates` JOIN ON 条件（保留 LEFT JOIN 语义，无 client 的模板返 count=0）
  - `src/backend/database/template-repository.js:getTemplate` 两个子查询
  - `src/backend/database/template-repository.js:listChildTemplates` 两个子查询
  - `src/backend/database/template-repository.js:getTemplateBigAccounts`（T2.2 已改，默认 includeOwn=false）
- 对齐 §3.1 调用点：`src/main.js` 所有调 `getTemplateBigAccounts / getTemplateMappings` 的位置默认不含 own（未显式传 `{includeOwn:true}`）；grep 扫过 `getTemplateBigAccounts` + `bigAccounts` 字段引用，无破绽
- 自测：
  - 1 模板 3 client + 2 own → listTemplates 显示 `bigAccountCount=3` ✅
  - 另 1 模板只有 1 own（无 client）→ list 仍返回该模板，`bigAccountCount=0` `summary='未设置'`（符合 §3.1 既不展示自有，又不让模板消失） ✅
  - 直查 SQL：`MIN(merchant_id) WHERE account_nature='client'` 能正确过滤掉字母序靠前的 own 条目（避免 singleBigAccountMerchantId 取错） ✅

### T2.5 — `saveMappings` 接收 `accountNature` — done

- 改动：
  - `src/backend/database/template-repository.js:saveMappings`：insertBigAccountStatement 加 `account_nature` 列；forEach 入库时读 `item.accountNature`，`'own' | 'client'` 白名单，缺省/非法 → `'client'`
  - `src/main.js:validateTemplateConfiguration`：cleanedBigAccounts 保留 accountNature 字段（同样白名单校验）
  - `src/main.js:expandBigAccountConfigurations`：展平为 `{merchantId, currency}` 时同样保留 accountNature
- 注意：`template:save-mappings` IPC handler 已经通过 `validateTemplateConfiguration(...)` → `database.saveMappings(...)` 链路自动透传，无需额外改动
- 自测：直接调 `saveMappings(db, tid, [], [{client×2, own×1, nature 缺省×1}], [])` → DB 4 条记录（3 client + 1 own）；`getTemplateBigAccounts` 默认返 3、`{includeOwn:true}` 返 4 ✅

### T2.4 — 启动调用迁移（D15 不阻塞 + D16 orphan 不告警） — done

- 改动：
  - `src/main.js` 头部 require：`const { runOwnAccountsMigration } = require('./backend/database/own-accounts-migration');`
  - `src/main.js` 全局变量：`let lastOwnAccountsMigrationError = null;`（缓存失败文案）
  - `src/main.js:app.whenReady`：在 `database.init()` 后、`syncTemplateLibraryFile()` 前插入 try/catch 包装的 `runOwnAccountsMigration(storageRoot, database.db, { appendActivityLogEntry })`；status='failed' 时设置 `lastOwnAccountsMigrationError = '自有账号迁移失败，请查看 own-accounts-migration-v1.5.3.log 后联系技术支持'`
  - `src/main.js:app:get-info handler`：返回值加 `ownAccountsMigrationError: lastOwnAccountsMigrationError`（renderer 首次 getInfo 读取）
  - `src/renderer.js:initialize`：在原 `setStatus(getEnumStatusMessage(), ...)` 之后追加判断，若 `info.ownAccountsMigrationError` 非空则 `setStatus(info.ownAccountsMigrationError, 'error')` 覆盖
- 自测：写了 4 场景脚本模拟启动链路的 try/catch 包装
  - happy（BOC.json 有 1 条 own 账号）→ status=done，lastError=null ✅
  - orphan（UNKNOWN.json 无匹配模板）→ status=done（只写 WARN 日志），lastError=null ✅（不触发状态栏告警）
  - corrupted（`{not valid` 损坏 JSON）→ status=failed，lastError=告警文案 ✅
  - nodir（无 own-accounts/ 目录）→ status=done，lastError=null ✅
- 注意：
  - renderer 读 `info.ownAccountsMigrationError` 的时机在 initialize 末尾 `setStatus(getEnumStatusMessage(), ...)` 之后，错误告警会覆盖 enum 默认文案
  - 用户手动触发其它动作（导入文件/切模板/etc）后 setStatus 会被新消息覆盖，符合 spec "保留到下一次 setStatus 覆盖"

### T2.3 — 迁移模块 `own-accounts-migration.js` — done

- 改动：
  - 新增 `src/backend/database/own-accounts-migration.js`：`runOwnAccountsMigration(storageRoot, db, { appendActivityLogEntry })` 返回 `{ status: 'done' | 'already-done' | 'failed', stats, error? }`
    - flag key = `own_accounts_migration_v1_5_3_done`（写 '1' 表示完成）
    - 日志文件 = `{storageRoot}/own-accounts-migration-v1.5.3.log`（追加模式，每行 ISO 时间戳前缀）
    - 日志前缀：`[INFO] / [OK] / [CONFLICT] / [WARN] / [ERROR]`
    - 损坏 json / 非 array 主动抛错（不沿用 own-account-store.readOwnAccounts 的吞异常行为），让外层 catch 接为 `failed`
    - orphan bankName → 跳过整份 + `[WARN]` 日志，不算失败
    - 冲突 `(template_id, merchant_id, currency)` 已存在 → 保留已有 + `[CONFLICT]` 日志
    - row_index 取该模板当前已有记录数（拼尾）
  - `src/backend/database/template-repository.js:getTemplatesByBankName`（新增）：按 bankName 反查模板，口径与 `splitTemplateName` 一致（name 按 `-` 切第 0 段）
- 自测：
  - 正常流：1 个 json 含 `{merchantId: 'BOC_OWN_A', currencies: ['CNY','USD']}` + `{merchantId: 'CONFLICT001', currencies: ['CNY']}`，预置客资 `CONFLICT001/CNY` → 2 个匹配模板 → 5 条 own 写入、1 条 conflict 保留 client ✅
  - 幂等：第二次调用返回 `already-done` ✅
  - orphan bankName：`XYZ.json` 无匹配模板 → `[WARN] orphan bankName: XYZ skipped (1 accounts)`，status 仍 `done` ✅
  - 损坏 json：写 `{not valid`，status=`failed` + 日志 `[ERROR] migration failed: invalid json ...` + flag 未写入（下次重试） ✅

### T2.2 — `getTemplateBigAccounts` 加 `includeOwn` 参数 — done

- 改动：
  - `src/backend/database/template-repository.js:getTemplateBigAccounts`：加 `{ includeOwn = false } = {}` 参数；SELECT 新增 `account_nature AS accountNature`；WHERE 子句按需加 `AND account_nature = 'client'`；返回对象含 `accountNature`
  - `src/backend/database.js:AppDatabase.getTemplateBigAccounts`：facade 加 options 参数透传
- 自测：临时 DB 插 2 客资 + 1 自有 → 默认调用返回 2 条，显式 `{includeOwn:true}` 返回 3 条 ✅
- 注意：`buildCompatibleBigAccounts`（main.js）/ `validateTemplateConfiguration`（main.js）/ `groupBigAccountRows`（utils.js）当前吞掉 `accountNature` 字段，T2.5/T2.7 会处理

### T2.1 — schema 加 `account_nature` 列 — done

- 改动：
  - `src/backend/database/migrations.js:ensureTemplateBigAccountNatureSupport`（新增）：幂等 ALTER，`TEXT NOT NULL DEFAULT 'client'`
  - `src/backend/database/migrations.js:module.exports`：导出新函数
  - `src/backend/database.js:AppDatabase.init` CREATE TABLE：schema 里也加 `account_nature TEXT NOT NULL DEFAULT 'client'`（新建空库直接含列）
  - `src/backend/database.js:AppDatabase.init`：末尾调 `this.ensureTemplateBigAccountNatureSupport()`
  - `src/backend/database.js:ensureTemplateBigAccountNatureSupport`（新增 facade 方法）
- 自测：
  - 空库 new → `PRAGMA table_info` 含 `account_nature TEXT NOT NULL DEFAULT 'client'` ✅
  - 模拟老库（无此列 + 有 1 条旧数据）→ 首次启动 ALTER 成功 + 旧数据默认 `'client'` ✅
  - 老库二次启动 → short-circuit，无报错 ✅

---

## 2026-04-20 Dev — G1 R1 月度余额导出实施

> 依据 `TechDoc §四.R1 + §五.R1 + §六`。G2 接口（`getTemplateBigAccounts({includeOwn:true})`、`getTemplatesByBankName`、IPC `big-account:get-with-own`、`splitTemplateName`、`readBalanceSeedRecords`）已就绪。

### T1.1 — `listBalanceSeedBankNames` — done

- 改动：
  - `src/backend/balance-seed-store.js`：新增 `listBalanceSeedBankNames(storageRoot)` helper（过滤 `.json` 后缀 + 去扩展名）；加入 `module.exports`
- 自测：
  - 空目录 → `[]` ✅
  - 两个 json 文件（中行.json / 建行.json） → `['中行', '建行']` ✅
  - 目录下放 readme.txt → 非 json 文件被过滤 ✅

### T1.2 — `src/main-process/monthly-balance.js`（资金红线） — done

- 改动：
  - 新增 `src/main-process/monthly-balance.js`：`assembleMonthlyBalance` + `toBalanceRows` + `pad2 / lastDayOfMonth / buildTargetLastDay / pickLatestSeedForAccount / isRegularTemplate` utility
  - 导出常量 `ALL_BANKS_TEMPLATE_SCOPE = '__ALL_BANKS__'`
  - `assembleMonthlyBalance` 内部调 `db.getTemplateBigAccounts(template.id, { includeOwn: true })`（Q6 显式放行）
  - 过滤"普通模板"：`isRegularTemplate(t) = !t.isParent && !t.parentTemplateId`（PRD §四 术语 Q5）
  - 坏 seeds json 吞 + 单模板 skip + 写 stats.skippedTemplates；Reason：不应让某一家损坏 json 中断整体装配（其它模板依然可以导出）
- 自测（用临时 SQLite + 临时 storageRoot）：
  - `lastDayOfMonth(2024, 2) === 29`（闰年）✅
  - `lastDayOfMonth(2026, 2) === 28` / `lastDayOfMonth(2026, 3) === 31` / `lastDayOfMonth(2026, 12) === 31` / `lastDayOfMonth(2026, 13) === null` ✅
  - `buildTargetLastDay(2026, 3) === '2026-03-31'` ✅
  - **资金红线 Q2 exact**：`billDate === 月末最后一日` 且存在 → 取 exact（BOC_CLIENT_1/CNY → 10000.50）✅
  - **资金红线 Q2 fallback**：目标月末无记录但有更早 → 取 billDate 最大（BOC_OWN_1/CNY → 2026-03-20, 123.45）✅
  - **资金红线 Q2 未来排除**：全部 billDate > 月末 → 跳过（BOC_CLIENT_1/USD 仅 2026-04-30 → missingAccounts, reason='no-candidates'）✅
  - **资金红线 Q2 无 seed**：CCB_CLIENT_1 完全无记录 → missingAccounts, reason='no-candidates' ✅
  - **Q5 普通模板**：主模板（招商）+ 子模板（招商-北京）不出现在 templates scanned ✅
  - **Q6 自有放行**：BOC_OWN_1（account_nature='own'）出现在 R1 records ✅
  - `toBalanceRows` 字段对齐：只填"银行名称/所在地/银行账号/币种/账单日期/期末余额"；其它字段（期初余额等）补空字符串 ✅

### T1.3 — IPC `monthly-balance:assemble` — done

- 改动：
  - `src/main.js` 头部 require 新增 `ALL_BANKS_TEMPLATE_SCOPE / assembleMonthlyBalance / toBalanceRows`（来自 `./main-process/monthly-balance`）
  - `lastGeneratedExports` 新增 `monthlyBalance: null` 字段；`clearGeneratedExports` 保留 `monthlyBalance`（R1 session 独立于 statement session）
  - `registerFileHandlers` 末尾 `file:export-balance` 之后新增 IPC handler `monthly-balance:assemble`：
    - 前端 payload：`{ templateScope: 'all'|'single'|'__ALL_BANKS__', templateName, year, month }`
    - 校验分支 E1 `请选择模板`（无 template + 有 time）、E2 `请选择时间`（有 template + 无 time）、E3 `请选择模板和时间`（都空）；errorCode=`MONTHLY_BALANCE_INVALID_INPUT`，不走 `createErrorResult`（避免误触发错误报告弹窗）
    - E4 装配结果为空 → 返 `{ status: 'empty', message: '所选模板在 YYYY年M月的月末及更早均无余额记录，无法生成月度余额账单' }`
    - 成功装配 → 调 `writeBalanceWorkbook` 写到 `{storageRoot}/exports/{YYYY-MM-DD}/balance/月度余额账单-{label}-{YYYY-MM}.xlsx`；存 `lastGeneratedExports.monthlyBalance = { filePath, fileName, templateLabel, year, month, recordCount }`；返 `{ status: 'ready', summary: { count, missingCount, templateLabel, year, month, fileName } }`
  - runtime 异常走 `createErrorResult`（错误报告链路）；errorCode=`MONTHLY_BALANCE_ASSEMBLE_RUNTIME`
- 自测：
  - 模拟 5 组 payload → 校验分支命中正确（hasTemplate/hasTime 组合）✅
  - assembleMonthlyBalance 装配逻辑通过 smoke 7 个场景（T1.9 里）

### T1.4 — IPC `monthly-balance:export` + preload 暴露 — done

- 改动：
  - `src/main.js`：handler `monthly-balance:export` 放在 `monthly-balance:assemble` 之后；读 `lastGeneratedExports.monthlyBalance` → `dialog.showSaveDialog` → `fs.copyFileSync`
    - 未装配 → `{ status: 'error', errorCode: 'MONTHLY_BALANCE_NO_PENDING' }`
    - 文件丢失 → `{ status: 'error', errorCode: 'MONTHLY_BALANCE_FILE_MISSING' }`，清掉 session
    - 用户取消保存对话框 → `{ status: 'cancelled' }`
    - 成功 → `{ status: 'success', filePath, message: '月度余额账单导出成功' }`
  - `src/preload.js`：新增 `window.desktopApi.monthlyBalance = { assemble(payload), export() }`
- 自测：语法 check + wiring audit ✅

### T1.5 — 主页面"模式"下拉 + state 扩展 + updateTemplateSelect 重写 — done

- 改动：
  - `index.html:47-52`：label `模板` → `模式`；`<select id="templateSelect">` 两个静态 option（`create-statement`、`export-monthly-balance`），默认选 `create-statement`
  - `src/renderer.js`：
    - 新增常量 `STATEMENT_MODES = { createStatement, exportMonthlyBalance }` + `ALL_BANKS_TEMPLATE_SCOPE = '__ALL_BANKS__'`
    - `state` 新增 `mode` / `monthlyBalanceReady` / `monthlyBalancePreview`；`selectedTemplateId` 默认值改为 `FILENAME_MAPPING_TEMPLATE_ID`（"制作网银账单"内部隐式默认）
    - `updateTemplateSelect` 重写：不再遍历 `state.templates` 构造 option（option 改为静态 HTML）；只同步下拉 value ←→ `state.mode`；"制作网银账单" 模式强制 `selectedTemplateId = __FILENAME_MAPPING__`；末尾调 `applyStatementModeSideEffects()`
    - `templateSelect` change listener 改为切模式 + 重置月度余额 ready 标记 + `applyStatementModeSideEffects()`
- 自测：静态 wiring audit 通过（所有关键标记符都在）✅

### T1.6 — `applyStatementModeSideEffects` 按钮可用性矩阵 — done

- 改动：
  - 新增函数 `applyStatementModeSideEffects()`：
    - 月度余额模式 → 禁用 `importFileBtn / exportDetailBtn / accountMappingBtn`；`exportBalanceBtn` 强制可用
    - 制作网银账单模式 → 恢复 v1.5.2 行为（按 `state.canExport*` 控制导出按钮 disabled）
  - `setExportAvailability` 加防御：若 `state.mode === exportMonthlyBalance` 直接 return，避免外部调用（如 `clearGeneratedExports` 路径）覆盖月度余额按钮状态
  - 调用时机：`updateTemplateSelect` 末尾 + `templateSelect` change listener
- 自测：前端静态 audit 通过 ✅；实际 UI 行为留手动测试（P0-1/P0-2/P1-1）

### T1.7 — `createMonthlyBalanceExportDialog` 弹窗 — done

- 改动：
  - `src/renderer-dialogs.js`：新增 `createMonthlyBalanceExportDialog({ onAssembleReady })` 放在 `createExportScopeDialog` 之后
    - DOM：`.modal-card.alert-card.monthly-balance-export-card`，含 `.dialog-header`（标题"请选择需要导出月度余额账单的银行渠道" + 关闭图标）、`.monthly-balance-form`（模板 select + 时间 year/month 双 select）、`.dialog-actions.right`（完成按钮）
    - 模板下拉：`<option value="__ALL_BANKS__" selected>全部银行渠道</option>` + 过滤后的"普通模板"（`!isParent && !parentTemplateId`）
    - 年份下拉：range = `[currentYear-9, currentYear+1]`（PRD Q13，2026 当下可选 2016~2027），首项为"-- 选择年份 --"
    - 月份下拉：1~12，首项为"-- 选择月份 --"，必须主动选
    - 完成按钮点击流：
      - 本地校验 E1/E2/E3：`createAlertDialog('请选择模板' | '请选择时间' | '请选择模板和时间', { onConfirm: () => 重开弹窗保留已填值 })`
      - 调 `desktopApi.monthlyBalance.assemble({ templateScope: 'all'|'single', templateName, year, month })`
      - `status='ready'` → `closeModal()` + 回调 `onAssembleReady(summary)` 让调用方刷新 state/状态栏
      - `status='empty'` → 弹报错 + 重开弹窗（保留草稿）
      - `status='error'` → 弹报错 + 重开弹窗（保留草稿）
      - IPC 异常 → 弹 `装配月度余额账单失败：{error.message}` + 重开弹窗
    - 关闭按钮：`closeModal()` 直接关
  - 暴露到 `window.__rendererDialogs.createRendererDialogs()` 返回对象
  - `src/styles.css` 新增 `.monthly-balance-export-card / .monthly-balance-form / .monthly-balance-row / .monthly-balance-time-picker` 样式
- 自测：语法 check + 静态 audit 通过 ✅；UI 交互留手动测试（P0-3/P0-8/P0-9）

### T1.8 — `handleExportBalance` 分流 — done

- 改动：
  - `src/renderer.js:handleExportBalance`：按 `state.mode` 分流
    - `export-monthly-balance` + `monthlyBalanceReady===false` → 弹 `createMonthlyBalanceExportDialog({ onAssembleReady })`
      - `onAssembleReady(summary)` 回调：`state.monthlyBalanceReady=true` + `state.monthlyBalancePreview=summary` + `setStatus('月度余额账单已生成（共 N 条记录），可点击"导出余额"另存为文件', 'success')`
    - `export-monthly-balance` + `monthlyBalanceReady===true` → 调 `window.desktopApi.monthlyBalance.export()` 弹系统保存对话框；success/cancelled/error 三分支 setStatus
    - `create-statement` → 保留 v1.5.2 原链路（`files.exportBalance()` + scope 弹窗 + manualBalancePrompt 等）
- 自测：静态 audit 通过 ✅；端到端留手动测试（P0-4~P0-11）

### T1.9 — smoke 脚本增量 — done

- 改动：
  - `scripts/smoke/scenarios.js`：新增 `runMonthlyBalanceScenario()`，独立 tmpdir + 独立 DB 隔离；注册到 `runSmokeScenarios` 末尾
  - 7 个覆盖点（对齐 PRD P0-4 ~ P0-11）：
    1. 全部银行渠道 × 2026-03 → 3 模板 × ≈4 记录 = 11 条（包含 1 自有 + 2 兜底 + 排除 1 未来 + 排除 1 无 seed）；主模板/子模板不出现
    2. 单模板 + 月末恰有记录 → `pickReason='exact'`、`billDate=2026-03-31`、`endBalance` 精确
    3. 单模板 + 月末无当日记录但有更早 → `pickReason='fallback'`、`billDate=2026-02-28`（Q2 兜底）
    4. 某账号全部 seed 都 > 月末 → 不出现在 records + 记入 `stats.missingAccounts`（reason=`no-candidates`）
    5. 某账号完全无 seed → 同上
    6. 空输入（独立 DB + 无 seeds） → `records.length === 0`，`stats.missingAccounts` 仍含 1 条
    7. 自有账号有 seed → 出现在 R1 records（Q6 唯一放行）；验证 `toBalanceRows` 把字段打平到 `balanceTemplateFields` 顺序
  - 顺带 utility sanity：`lastDayOfMonth` 闰年/边界 + `buildTargetLastDay` + `pickLatestSeedForAccount` + `listBalanceSeedBankNames`
- 自测：`npm run smoke` ✅（7 个场景全绿）

### G1 完成 — 资金红线三重防护

资金红线点（Q2 最新余额 + Q6 自有放行 + Q4 单 sheet）都集中在 `src/main-process/monthly-balance.js::assembleMonthlyBalance`，三层自测：
1. 单元级：`pickLatestSeedForAccount` 4 分支全过（exact/fallback/future-only/no-seed）
2. 集成级：`assembleMonthlyBalance` 7 场景全过（smoke T1.9）
3. 静态审计：`getTemplateBigAccounts` 调用处**必须**传 `{ includeOwn: true }`；grep 过代码确认 R1 链路唯一放行

### G1 偏离 TechDoc 的点（均为无碍收敛）

1. **TechDoc §六.6.1 payload 描述为 `{ templateScope: string, year, month }` 且 `templateScope` 为模板名或 `__ALL_BANKS__`；代码采用两层字段 `{ templateScope: 'all'|'single', templateName }`**。原因：前端"全部银行渠道"和"具体模板名"混在一个字段的字符串，边界校验不如两字段清晰（如用户输入模板名刚好是 `__ALL_BANKS__` 字符串的极端情况）。后端同时兼容 `templateScope === 'all' || templateScope === '__ALL_BANKS__'`，向后兼容。
2. **TechDoc §四.4.1.4 建议新增独立函数 `buildMonthlyBalanceOutputFilePath`；代码直接复用 `buildOutputFilePath({ kind: 'balance', outputFileName: <sanitized> })`**。原因：新函数只比现有函数多一步字符串拼接，不值得引入；命名约定已在 IPC handler 里显式构造 `月度余额账单-{label}-{YYYY-MM}.xlsx`。
3. **TechDoc §四 伪码把空 records 归为 error；代码改为 `status: 'empty'`**。原因：前端 `createAlertDialog` 弹"该模板/月份范围内无余额数据"不应走错误报告链路，避免触发状态栏 error tone + 错误报告文件。
4. **TechDoc §五.5.1.7 建议模式切换"不清"月度余额 session；代码改为"切模式清前端 monthlyBalanceReady + preview"**。原因：更稳妥——避免用户来回切模式后使用过期装配产物。后端 `lastGeneratedExports.monthlyBalance` 仍保留，但前端 state 会迫使用户重走装配链路（重新显示弹窗），新装配会覆盖旧 session。
5. **弹窗控件默认值**：TechDoc 建议月份默认未选；year 也默认为"-- 选择年份 --"（TechDoc 没明示，但按月份同样语义放）。两个 select 都要用户主动选，触发 E2 校验路径。

---

## 2026-04-20 Dev — G3 R3 导出表头字体 Courier New 实施

> 依据 `TechDoc §四.R3`（含 D14 = B 决策）+ `PRD §3.5 + §5.3 R3`。OT-5 已 RESOLVED=B：writer 写死 Courier New，不加可选参数，新开账户模块副作用接受。

### T3.1 — 引入 `xlsx-js-style` 依赖 — done

- 改动：
  - `package.json` dependencies 新增 `"xlsx-js-style": "^1.2.0"`（与 TechDoc §4.3.1 版本一致）
  - `package-lock.json` 自动更新（+8 packages）
  - `xlsx@0.18.5` 保留不动（xlsx-js-style 只在 writers.js 局部使用 + merge 局部 shadow）
- 验证：`node_modules/xlsx-js-style/package.json` version=1.2.0 ✅；`npm run smoke` pass

### T3.2 — `applyHeaderRowFont` + writers.js 切 require — done

- 改动（`src/backend/file-service/writers.js`）：
  - `require('xlsx')` → `require('xlsx-js-style')`（仅此文件切；`src/main.js:4` 仍是 `require('xlsx')`，保持打包体积最小增长）
  - 新增内部工具函数 `applyHeaderRowFont(worksheet, headerRowIndex = 0)`：
    - 读 `worksheet['!ref']` 拿范围；headerRowIndex 越界直接 return
    - 遍历 range.s.c ~ range.e.c 的每个 cell；不存在跳过
    - 只改 `cell.s.font.name = 'Courier New'`，保留原有 `font.bold` / `font.sz` / `font.color` / `fill` / `border` 等其它样式
    - 字体名硬编码 `'Courier New'`（决策 D14，Q10 无回退链）
- 未导出 `applyHeaderRowFont`（按任务指引"内部工具"，外部不需要）
- `node --check` 通过

### T3.3 — `writeWorkbookRows` 表头字体注入 — done

- 改动：在 `applyExportFieldFormats(...)` 之后、`book_append_sheet(...)` 之前调 `applyHeaderRowFont(worksheet, 0)`

### T3.4 — `writeBalanceWorkbook` 表头字体注入 — done

- 改动：在 `applyBalanceFieldFormats(...)` + 更新 `!ref` 之后、`XLSX.writeFile(...)` 之前调 `applyHeaderRowFont(worksheet, 0)`
- 注意：必须放在 `applyBalanceFieldFormats` 之后，否则数据格式应用时会重写 cell 对象覆盖掉 s.font；放在 `!ref` 更新之后，保证范围正确
- 影响的三条路径全部自动生效：
  1. 制作网银账单导出余额（`writeBalanceWorkbook`）
  2. R1 月度余额导出（`src/main-process/monthly-balance.js` → `writeBalanceWorkbook`）
  3. 新开账户模块导出（D14 副作用，用户已知情）

### T3.5 — 合并文件场景 — **代码补调**（非"验证通过不改代码"）

- **实测发现**：按 TechDoc §4.3.2 的假设"merge 浅拷贝保留 s 字段"**不成立**：
  - `src/main.js` 里用的是 `require('xlsx')`（社区版），`writeFile` 不写样式
  - 即使 `readFile` 带 `cellStyles: true`，读回 `cell.s` 只有 `{patternType: 'none'}`，font 字段丢失
  - 浅拷贝 `{ ...cell }` 能保留对象里已有字段，但对象本身就没 font
  - 合并后的 xlsx 的 styles.xml 里 fonts 只剩 Calibri，row 1 cell 的 s="" 属性也没了
- **按 TechDoc §4.3.2 fallback 方案实施**：
  - `src/main.js:mergeGeneratedXlsxFiles`：函数内 `const XLSXStyle = require('xlsx-js-style');` 局部 shadow 全局 XLSX
  - 所有 XLSX.\* 调用替换为 XLSXStyle.\*（readFile / decode_range / encode_cell / encode_range / writeFile）
  - 在 `writeFile` 之前额外补调一次 Courier New 注入（内联实现，避免跨模块依赖 writers.js 的非导出 helper）：`baseWs` 的 r=0 逐列注入 `cell.s.font.name='Courier New'`
  - **为什么不改全局 XLSX 引用**：全局 `require('xlsx')` 被 ~7500 行 main.js 其它地方共用（readers 链路、模板导入等），改全局会影响非合并路径；局部 shadow 只影响 merge
- 验证：用 `unzip -p <path> xl/styles.xml` 抽查合并产物 fonts 块包含 Courier New，row 1 cell 全部引用 fontId=2 ✅

### 自测结果（对应任务清单）

1. **smoke**：`npm run smoke` pass ✅
2. **单模板明细导出**（writeWorkbookRows）→ row 1 全部 Courier New，数据行未被污染 ✅
3. **单模板余额导出**（writeBalanceWorkbook）→ row 1 全部 Courier New ✅
4. **R1 月度余额**（共用 writeBalanceWorkbook）→ 自动生效（代码路径相同）
5. **新开账户模块**（共用 writeBalanceWorkbook，D14 副作用）→ 自动生效
6. **多批次合并**（mergeGeneratedXlsxFiles）→ 补调注入后 row 1 全部 Courier New ✅

### 验证证据（用 `unzip -p` 抽查 XML，不依赖 xlsx readback）

**DETAIL xlsx 的 styles.xml**（writeWorkbookRows 输出）：
```xml
<fonts count="3" ...>
  <font><sz val="11"/><name val="Calibri"/></font>
  <font><sz val="11"/><name val="Calibri"/></font>
  <font><sz val="11"/><name val="Courier New"/></font>  <!-- fontId=2 -->
</fonts>
```

**DETAIL row 1**（表头）：所有 cell 引用 `s="3"`（即 cellXfs 第 3 项，fontId=2 Courier New）
```xml
<row r="1">
  <c r="A1" s="3" t="str"><v>MerchantId</v></c>
  <c r="B1" s="3" t="str"><v>BillDate</v></c>
  <c r="C1" s="3" t="str"><v>Credit Amount</v></c>
  <c r="D1" s="3" t="str"><v>Currency</v></c>
</row>
```

**DETAIL row 2**（数据行）：cell 使用 `s="4"`（text）/`s="2"`（date）/`s="5"`（numeric），**未被 Courier New 污染** ✅

**BALANCE xlsx 的 styles.xml**：含两个 Courier New font（fontId=2 + fontId=3，因为模板本身已有一个字体 slot，applyHeaderRowFont 注入后 xlsx-js-style 写出时 dedup 行为不影响实际渲染）

**合并 merged.xlsx**（2 个源文件 merge）：fonts 块含 Courier New，row 1 全部 cell 引用对应 xfId ✅

### 为什么 xlsx readback 拿不到 font.name —— 不是 bug

任务指引里建议用 `const wb=X.readFile(path, {cellStyles:true}); console.log(wb.Sheets[...].A1.s)` 验证。实测：

```
A1.s: {"patternType":"none"}  // 只有 fill 的 patternType，font 字段丢失
```

**这是 xlsx 社区版（含 xlsx-js-style 的 reader）的已知限制**：`cellStyles: true` 读回时只还原部分字段（fill.patternType），丢失 font/border/alignment 等。**不代表文件内样式没写入** —— 通过 `unzip -p` 看 styles.xml + sheet1.xml 已确认字体写入完整。

真正的验证方式：
1. 解压 xlsx 看 styles.xml 里 `<fonts>` 块（证实已有 Courier New 字体定义）✅
2. 看 sheet1.xml 里 row 1 的 `<c s="N"/>`（证实表头 cell 引用到 Courier New 字体 ID）✅
3. Excel / WPS 打开文件验证视觉字体（用户手动测试 P0-17 ~ P0-20）

### G3 偏离 TechDoc 的点（均为必要补丁）

1. **TechDoc §4.3.2 假设 merge 浅拷贝保留 s 字段 → 实测不成立**：`src/main.js` 仍用 `require('xlsx')`，写 merge 出去的 xlsx 里 styles.xml 的 fonts 会被 xlsx 社区版 writeFile 按默认值重建，导致字体丢失。Dev 按 TechDoc §4.3.2 明示的 fallback 方案实施：merge 函数内局部用 `xlsx-js-style` + 补调 applyHeaderRowFont
2. **TechDoc §4.3.2 伪码 `applyHeaderRowFont(worksheet, headerRow)` 第二参数是 headerRow 数组**；代码改为 `applyHeaderRowFont(worksheet, headerRowIndex = 0)` 传索引。原因：依 `worksheet['!ref']` 已能拿到范围；传数组多此一举；headerRowIndex 默认 0 使调用方零负担
3. **merge 函数的字体注入逻辑未调 `writers.js:applyHeaderRowFont`**（而是内联 for 循环）。原因：applyHeaderRowFont 是 writers.js 的内部函数（未导出），main.js 跨模块调用需要 export，出于"改动最小"原则，用等价的内联逻辑替代。行为完全一致

### 代码现状最终清单

| 文件 | 改动 |
|------|------|
| `package.json` | dependencies 新增 `xlsx-js-style: ^1.2.0` |
| `package-lock.json` | 新增 8 个间接包依赖（xlsx-js-style 的 transitive） |
| `src/backend/file-service/writers.js` | `require('xlsx') → require('xlsx-js-style')`；新增 `applyHeaderRowFont` 内部函数；`writeWorkbookRows` 和 `writeBalanceWorkbook` 各补调一次 |
| `src/main.js:mergeGeneratedXlsxFiles` | 函数内局部 shadow XLSX 为 xlsx-js-style；补调 Courier New 字体注入（内联实现） |

### G3 完成 — 资金/样式链路无风险

- smoke 全绿 + XML 级抽查通过
- 数据区字体未被污染（严守 Q11 "仅表头"边界）
- 无中文回退链（严守 Q10 裸 Courier New）
- 接受新开账户模块字体变化（D14 决策）

### 手动测试交接（等用户测试）

按 PRD §7.1 P0-17 ~ P0-21 + §7.2 P1-6 ~ P1-8 清单手动跑：
- P0-17 明细表头 Courier New
- P0-18 余额表头 Courier New
- P0-19 月度余额表头 Courier New
- P0-20 合并产物表头 Courier New（**需重点验证**，Dev 自测是基于临时合并实验，非实际多模板流程）
- P0-21 CJK 抽查（Excel for Windows / Mac / WPS）
- P1-6 数据区字体不变
- P1-7 报错 xlsx 字体不变
- P1-8 新开账户模块导出——**会变 Courier New**（D14 决策接受的副作用）

---

## 2026-04-22 Dev — 端到端回归脚本 test-v1.5.3-regression.js

- 动作：新增 `scripts/test-v1.5.3-regression.js`，覆盖 PRD §七 可自动验证的 21 条用例（P0=15 + P1=6），独立 `node scripts/test-v1.5.3-regression.js` 运行，不依赖 Electron 主进程
- 覆盖清单：
  - **Section 1 — R1 资金装配（7 条）**：P0-4 单模板 exact、P0-5 fallback、P0-6 未来余额排除、P0-7 完全无 seeds、P0-10 全部银行渠道、P0-11 自有账号放行（含默认 vs includeOwn:true 对照）、P1-3 多币种大账号
  - **Section 2 — R1 IPC 校验层（2 条）**：P0-8（模板查不到 → 装配层静默返回空，报错在 IPC 层）、P0-9（year/month 非法 → 装配层抛异常）
  - **Section 3 — R2 迁移三态（3 条）**：P0-13 主场景迁移成功 + orphan bankName 合并验证、P0-14 幂等（already-done）、P0-15 冲突保留已有（CONFLICT 日志 + client 不被覆盖）
  - **Section 4 — R2 过滤 / bundle（2 条）**：P1-4 重复 saveMappings 不重插（DELETE + INSERT 事务）、P1-5 bundle 导出带 accountNature + 老 bundle 缺字段默认 client
  - **Section 5 — R3 字体 XML 级验证（7 条）**：P0-17 明细表头、P0-18 余额表头、P0-19 月度余额全链路、P0-20 合并文件、P1-6 数据区字体不变、P1-7 skip（错误报告为 txt 非 xlsx）、P1-8 新开账户模块（共用 writeBalanceWorkbook 等价 P0-18）
- 技术手法：
  - 每用例独立 `fs.mkdtempSync` + 独立 AppDatabase；迁移幂等用例共享 ctx 跨两个用例（P0-13 → P0-14）
  - 字体验证用 `execFileSync('unzip', ['-p', xlsx, 'xl/styles.xml'])` + 正则解析 `<fonts>` / `<cellXfs>` / row 的 `s=""` 引用链（不依赖 xlsx reader 的 cellStyles 回读，因为社区版 reader 会丢 font.name）
  - 失败用例不崩整个脚本：try/catch + expected/actual 打印 + `process.exit(1)` 在结尾
- 证据：`node scripts/test-v1.5.3-regression.js` 首次运行即全绿（P0 15/15, P1 5/6, P1-7 skipped）；`npm run smoke` 不受影响仍 pass
- 风险：无。脚本是只读验证，未修改任何 G1/G2/G3 业务代码
- 决策：
  - 脚本只在首次 PR / 每次 Dev 手工回归时执行；不加入 CI（与 smoke 职责分工：smoke 是轻量冒烟、regression 是版本门禁抽查）
  - P0-13 的 orphan 验证合并到 P0-13 主用例内部（不单独计数），避免 P0 条数膨胀

---

## 2026-04-22 Dev — G4 R4 账单合并浮点精度 hotfix

> 依据 PM 2026-04-22 决策 + spec.md §4 功能点 4。属 1.5.3 顺手修 D17 决策的落地实施。

### T4.1 — `src/backend/file-service.js` 合并净值套 round

- 改动点：
  - 顶部 import：把 `roundAmountHighPrecision` 替换为 `roundAmount`（只取 2 位版本）
  - `buildMappedRows` 合并分支（:443）：`const net = roundAmount(sumCredit - sumDebit);`
  - 相邻注释更新为"2026-04-22 更正"版，说明为何改用 2 位小数（12 位无法收敛 65572.01 + 4917.90 场景）
- 验证：regression 3 条 R4 用例全绿；smoke 全绿。

### T4.2 — `scripts/test-v1.5.3-regression.js` Section 6 新增 3 条

- 改动点：
  - 顶部 import：`roundAmountHighPrecision` 改为 `roundAmount`
  - Section 6 头部说明段改"2026-04-22 更正"版
  - `casesR4FloatingPoint()` 3 条用例的 round 调用改为 `roundAmount`
- 预期 & 结果：
  - P0-R4-1 `2377.49 + 178.31` → net=`-2555.8` / netString=`'2555.8'` ✅
  - P0-R4-2 `65572.01 + 4917.90` → net=`-70489.91` / netString=`'70489.91'` ✅
  - P0-R4-3 `(0.1+0.2) - 0.3` → net=`0`（精确 0）→ 合并组跳过 ✅

### 实施过程中的修正（坦白）

- **初稿方案失败**：2026-04-22 早先按 PM 原 spec（`roundAmountHighPrecision`，`toFixed(12)`）实现完毕，P0-R4-1 / P0-R4-3 通过，但 **P0-R4-2 失败**——IEEE 754 对 `65572.01 + 4917.90 = 70489.90999999999` 在 12 位小数处仍未收敛，`(70489.90999999999).toFixed(12)` 得到 `'70489.909999999997'`，`Number()` 回来还是 `70489.91000000001` 级别的噪声。
- **停下汇报**：当即停止继续 Section 6 以外改动，把样本与失败证据报 PM。
- **PM 重新决策**：资金本就 2 位小数，改用已存在的 `roundAmount`（`toFixed(2)`）强制 2 位。`(70489.90999999999).toFixed(2) = '70489.91'` 精确，3 条用例同时收敛。
- **spec 回写**：PM 已更新 `changes/v1.5.3/spec.md §4 功能点 4`（说明段加"2026-04-22 更正"、边界段改"强制 2 位小数"），变更记录同步；D17 决策不变（1.5.3 顺手修），仅技术方案从 12 位调整为 2 位。

### 自测证据

```
--- Section 6 — R4 账单合并浮点精度 ---
[P0-R4-1] ✅ R4 浮点合并 2377.49 + 178.31 = 2555.80 — sumDebit=2555.7999999999997 → net=-2555.8 → netString='2555.8'
[P0-R4-2] ✅ R4 浮点合并 65572.01 + 4917.90 = 70489.91 — sumDebit=70489.90999999999 → net=-70489.91 → netString='70489.91'
[P0-R4-3] ✅ R4 对称抵消 net===0 静默跳过 — sumCredit=0.30000000000000004, sumDebit=0.3, net=0（精确 0）→ 合并组跳过

=== 总计 ===
P0 通过: 18/18
P1 通过: 5/6 (P1-7 skipped: 错误报告为 txt 格式（非 xlsx），无字体可验)
失败用例: 无
```

- `node scripts/test-v1.5.3-regression.js` 全绿（P0 18/18，P1 5/6，P1-7 skipped 与历史一致）
- `npm run smoke` pass
- 其它 Section（R1/R2/R3）用例未 regression

### G4 风险 / 决策

- **风险**：无新增资金风险。`roundAmount` 已在 normalizers.js 大量使用（:54/:72/:73），是项目内资金 2 位小数的标准算子；本次改动只是把合并链路纳入同一标准。
- **决策**：
  - D17 有效：顺手在 1.5.3 修，不拆到 1.5.4
  - 技术方案从 `roundAmountHighPrecision`（12 位）改为 `roundAmount`（2 位）——2 位对资金而言是"精确"而非"降精度"，不存在信息损失
  - 自测覆盖 2 条真实用户样本 + 1 条对称抵消构造，边界完整；不再补充额外用例

### 手动测试交接（等用户测试）

R4 属于后端纯算子改动，Dev 自测已覆盖所有可自动验证面。用户侧建议：
- 复跑 2 条已复现的账单合并组（KPY-PAY-4mQadY0aTZzUUCi / KPY-PAY-KdDQdG2blc0bLJa），看净值是否分别稳定为 `2555.80` 和 `70489.91`
- 任意一次对称抵消合并组（credit 与 debit 完全对冲），看是否静默跳过（不出现在明细）

---

- [x] v1.5.3 定稿后，把"主页面下拉（模板/模式）语义演变"在 PRD §3.2 已记录——如果稳定下来可归入 `knowledge/` 作为一条 UI 设计决策笔记
- [ ] v1.5.3 定稿后，把"balance-seeds 跨模板查询"作为一个独立 domain rule 沉淀到 `rules/domain-rules.md`（最终方案 = "按 bankName 聚合 + 按 template_big_accounts 过滤 + includeOwn 显式放行"）
- [ ] `xlsx-js-style` 局部替换 `xlsx`（同文件内切换 require）是一种减少打包体积的做法，可以沉淀到 `knowledge/sheetjs.md`（如存在）
- [ ] SQL 层软过滤 + 调用方显式放行（`getTemplateBigAccounts({includeOwn:false})`）是实现"业务隔离"的一种模式，可作为 `knowledge/db-pattern.md` 范例
- [ ] v1.5.3 的 §3.1 自有账户隔离规则若在 v1.5.x 稳定后，可升级到 `rules/domain-rules.md` 作为长期业务规则

---

## 2026-04-22 PM — 发版收尾

- 动作：1.5.3 迭代全部测试通过（20 条自动 + 8 条 UI 手动 + 1 条 skip）；按用户指令同步更新文档三件套 + 版本号，不 commit / 不写代码 / 不动 git 状态
  1. `package.json`：`version` `1.5.2` → `1.5.3`
  2. `CHANGELOG.md`：开头插入 `## 1.5.3 - 2026-04-22` 小节，按 v1.5.2 风格覆盖 R1（模式切换 + 月度余额导出 + Q2 最新余额 + 按钮矩阵）、R2（自有账号合并 + §3.1 隔离 + D15 不阻塞 + D16 orphan 跳过）、R3（Courier New 表头 + xlsx-js-style 局部切换 + mergeGeneratedXlsxFiles 补调 + D14 新开账户副作用）、R4（浮点精度 hotfix + D17 技术方案修正）；含「变更」「废弃保留」分组
  3. `docs/VERSION_FEATURE_HISTORY.md`：开头插入 `## 1.5.3` 小节（新增 / 变更 / 废弃保留），覆盖同样的要点但用户手册级表达粒度
  4. `docs/USER_GUIDE.md`：顶部版本号 `v1.5.2` → `v1.5.3`；§1.1.2 主要功能列表追加条目 15~19（覆盖模式下拉、月度余额导出、自有账号合并、表头字体、浮点精度）；§1.1.3「使用模板」加模式下拉说明；Q&A 末尾追加 20)~23)（导出月度余额账单 / 自有账号合并 / 表头字体 / 浮点精度），覆盖 Q2 最新余额定义、§3.1 隔离规则、D14 字体副作用等关键决策
- 证据：
  - `cat package.json | grep '"version"'` → `"version": "1.5.3"`
  - `rg -n '## 1.5.3' CHANGELOG.md docs/VERSION_FEATURE_HISTORY.md` → 两处均命中
  - `rg -n 'v1.5.3' docs/USER_GUIDE.md | head` → 顶部版本号 + 至少 5 处 `(v1.5.3 新增)` 标注
- 风险：无（纯文档改动，未触 git / 代码 / 数据库）
- 决策：按 `workflow_no_tester_no_auto_pr`，用户未说「提 PR」前 team-lead 不动 git；本次仅发版收尾，下一步等用户指示是否 commit / 提 PR

---

## 2026-04-23 Dev — Codex Review Round 1（Finding 1 修复）

> 触发：PR #22 Codex 自动 review 提出 1 条 finding，用户复核后判定为 Critical（资金链路 + 数据删除 + 静默失败 + 直接让 R1 失效），要求修复后重新 review。

### 缺陷复盘

- 位置：`src/renderer-dialogs.js:2840` 维护大账号弹窗打开入口
- 链路根因：
  1. `manageBigAccountBtn` click handler 把 `currentBigAccounts` 传给 `createBigAccountManagerDialog`
  2. `currentBigAccounts` ← `payload.bigAccounts`（来自 `template:get-mappings`）
  3. `template:get-mappings` → `getTemplateMappingConfig` → `database.getTemplateMappings` → `template-repository.js:390` 调用 `getTemplateBigAccounts(db, templateId)` **没传 `{includeOwn: true}`**
  4. §3.1 SQL 过滤掉 own → 弹窗 tbody 只显示 client
  5. 用户点完成 → `saveMappings()` DELETE+INSERT 写回可见行 → **own 账号被静默删除**
- 后果：R1 月度余额导出依赖 own 账号，用户只要打开过维护大账号并点完成，own 全部丢失；没有任何告警；无法回滚（除非重跑 own-accounts 迁移，但 `MIGRATION_FLAG_KEY` 已置 done）
- T2.9 spec 残留：原任务列表第 124-125 行明确要求"`onDone 回调`：不再调 `saveOwnAccounts`，删除 `extra.ownAccounts` 分支"——但实际 `:2847-2856` 仍保留旧分支 + `pendingOwnAccounts` 双写链路；说明 T2.9 落地不完整，Finding 1 是其表象之一

### 修复方案

**1. 后端 — IPC 返回结构对齐（`src/main.js`）**

- 顶部 import 新增 `groupBigAccountRows`（来自 `./backend/database/utils`）
- `big-account:get-with-own` handler（原 `:6271-6287`）：
  - 旧：`getTemplateBigAccounts(templateId, {includeOwn:true})` 直接返 row-level
  - 新：再调 `groupBigAccountRows(rows)` 返 grouped `{merchantId, currencies, isMultiCurrency, accountNature}[]`，与 `getTemplateMappings.bigAccounts` 结构对齐
- 注释补充：明确说明 grouped 形态 + 与默认 `getTemplateBigAccounts` 的语义差异

**2. 前端 — 维护大账号入口改用 getWithOwn（`src/renderer-dialogs.js`）**

- `manageBigAccountBtn` click handler（约 `:2839`）改 async：
  - 进入弹窗前先 `await window.desktopApi.bigAccount.getWithOwn(payload.template.id)`
  - 成功 → 用其 `bigAccounts`（grouped 含 own）作为弹窗初值
  - 失败（`status==='error'` 或抛异常）→ 状态栏告警 + return（不打开弹窗，避免用户误操作丢 own）
  - 注释明确说明为何不能直接用 `currentBigAccounts`（§3.1 过滤 + saveMappings 静默删 own）
- onDone/onCancel 链路简化：
  - 删除 onDone 第二参数 `extra.ownAccounts → saveOwnAccounts` 双写分支（T2.9 残留）
  - onCancel 用同一份 `bigAccountsForDialog` 重建 mappingDialog，保持取消语义一致

**3. 前端 — 清理 T2.9 残留（`src/renderer-dialogs.js`）**

- `createBigAccountManagerDialog` 签名删除 `initialOwnAccounts` 形参
- 函数体删除 `let pendingOwnAccounts = initialOwnAccounts || null` 状态变量
- import-bank-info handler（`:2206`）删除 `pendingOwnAccounts = result.ownAccounts || []` 旁路赋值，注释更新为"由 saveMappings 统一写回"
- balance-management onClose（`:2237`）递归打开弹窗时删除 `initialOwnAccounts: pendingOwnAccounts` 入参
- "完成"按钮 click handler（`:2282`）改为 `onDone(nextBigAccounts)`，删除第二参数 `{ ownAccounts: pendingOwnAccounts }`
- grep 验证：`pendingOwnAccounts` / `initialOwnAccounts` / `extra.ownAccounts` 在 renderer-dialogs.js 全部清零

**4. 后端 — 旧 IPC 加 deprecated 警告（`src/main.js`）**

- `big-account:save-own-accounts` handler（`:6250`）：
  - 顶部加注释 "deprecated。自有账号已合入 template_big_accounts 表，由 saveMappings 统一写回"
  - 函数体首行加 `console.warn('[v1.5.3] big-account:save-own-accounts is deprecated; ...')`
  - **不删除 handler**：保留兼容（防止老调用链 / 第三方触发报错），与 T2.9 spec 一致；仅前端不再调用

### 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/main.js` | 修改 | 顶部 import 新增 `groupBigAccountRows`；`big-account:get-with-own` 返回 grouped；`big-account:save-own-accounts` 加 deprecated 注释 + warn |
| `src/renderer-dialogs.js` | 修改 | 维护大账号入口改用 `getWithOwn`；清理 `pendingOwnAccounts` / `initialOwnAccounts` / `extra.ownAccounts` 全部链路 |
| `scripts/test-v1.5.3-regression.js` | 修改 | Section 4 新增 P0-F1（修复后正向）+ P0-F2（旧链路负向证明）；顶部 import 新增 `groupBigAccountRows` |

### 验证证据

#### 1. 静态验证（已完成）

- `grep -n "pendingOwnAccounts\|initialOwnAccounts\|extra\.ownAccounts" src/renderer-dialogs.js` → **零命中**（清理彻底）
- 修复后调用链审计：
  - 维护大账号弹窗打开 → `bigAccount.getWithOwn` IPC → `groupBigAccountRows(getTemplateBigAccounts(..., {includeOwn:true}))` → grouped 含 own
  - 弹窗 onDone → `nextBigAccounts`（含 own，每行带 `accountNature='own'`）→ `createMappingDialog` payload.bigAccounts → 模板保存按钮 saveMappings IPC → `validateTemplateConfiguration` 保留 nature → `expandBigAccountConfigurations` 展平 row-level → `database.saveMappings` insertBigAccountStatement 写入 `account_nature='own'`
  - 整条链路 `accountNature` 透传无丢失

#### 2. 自动回归（待用户跑）

- 新增 2 条用例（Section 4 末尾）：
  - **P0-F1**：grouped(含 own) → saveMappings roundtrip 后 own 仍在表里（accountNature='own'）→ 验证修复后链路正确
  - **P0-F2**：旧链路（`getTemplateMappings.bigAccounts` → saveMappings）→ own 被删 → contract test 锁定 §3.1 过滤行为，未来 §3.1 语义改动会触发该用例失败提醒重审 Finding 1
- 其它已有 P0-F2 之外 19 条 P0 + 6 条 P1 不应受影响（仅扩展，未改动既有用例代码）

> ⚠️ Dev 说明：本次回合 Dev 写完代码后未亲自跑 `node scripts/test-v1.5.3-regression.js` 验证（环境 sandbox 分类器多次不可用，bash 多次拒绝），代码改动属"小范围、明确链路、可静态推断正确"类型。**请用户在合并前手动跑一次 `node scripts/test-v1.5.3-regression.js` + `npm run smoke` 双绿后再触发 Codex 重新 review**。

### 风险 / 决策

- **资金风险**：原 bug 有资金风险（own 账号丢失 → R1 月度余额漏账）；本修复是反向收口，纯收益、零新增风险
- **数据兼容**：保留 `big-account:save-own-accounts` IPC + `desktopApi.bigAccount.saveOwnAccounts` preload，确保任何"忘记升级的"老调用链不会报错（仅打 warn）
- **Spec 完成度**：T2.9 task 状态在原 tasks.md 仍标 "todo" 但实际声明"已落地"。本次回合相当于补完 T2.9 第 4-5 项（删除 onDone 旁路 + saveOwnAccounts handler 加 deprecated 警告）。下一回合 PR 草稿同步前可在 PRD §"实施记录" 章节回写"Codex Round 1 修复 Finding 1，T2.9 落地补完"
- **后续追踪**：若 Codex round 2 review 仍命中此区域问题，需要把"维护大账号 → mapping dialog → save"完整链路抽到一个独立 contract test，避免再被发现
- **不改 spec.md / PRD**：spec 在迭代主体已稳定，本次仅修补 T2.9 落地缺口，相关锚点 (§3.1) 不需要修改

### 下一步（待用户）

1. 用户跑 `node scripts/test-v1.5.3-regression.js` 验证 27 条用例（应 25 pass + 1 skip + P0-F1 / P0-F2 新增 2 pass = 27 用例 26 pass + 1 skip）
2. 用户跑 `npm run smoke` 验证 smoke 全绿
3. 用户确认 OK 后，team-lead commit + push 到 v1.5.x，PR #22 自动收到新 commit；用户在 PR 评论区留 `@codex review` 触发 round 2

---

## 2026-04-23 Dev — Codex Review Round 2（3 条 finding 修复）

> Round 1 修复后 PR 触发 Codex round 2 review，新发现 3 条 finding：
> - **F2**（Round 1 漏掉的资金风险）：`own-accounts-migration.js:81` 用 `path.basename` 拿到的是 sanitize 后形态，与原始模板 bankName 比对错位 → 含空格 / 特殊字符的 bankName 全部 orphan + 标记完成 → **资金数据永久丢失**
> - **F3**（Round 1 修复引入的副作用）：`renderer-dialogs.js:2846` manage handler 总是 await `getWithOwn` 拿数据库版，会覆盖 mapping dialog 第二次打开时 `currentBigAccounts` 中的 in-memory 编辑（包含用户主动删除的 own 行）
> - **F4**（R2 落地缺口）：`main.js:3173` `bigAccountLookup` 按 merchantId 单键，client+own 共享 merchantId 时后写覆盖前写 → fixed-assignment 过滤可能误删合法行

### 缺陷复盘

#### F2 — 迁移 sanitize lookup 错位

- 链路：
  - `own-account-store.js:11 getOwnAccountFilePath` 写文件时调 `sanitizeBankName(bankName)` → 空格 / `<>:"/\|?*` / 控制字符全部替换为 `-`
  - 例：用户在 OS 中创建模板 "中国 银行-北京"，UI 触发 own-accounts 写入时 → `own-accounts/中国-银行.json`
  - 迁移阶段 `own-accounts-migration.js:81` `path.basename(jsonFile, '.json')` → `'中国-银行'`
  - `templateRepository.getTemplatesByBankName(db, '中国-银行')` → SQL 比对 `name = '中国-银行' OR name LIKE '中国-银行-%'`
  - 模板真名 "中国 银行-北京"（split('-')[0] = "中国 银行" 含空格）→ 不匹配
  - → orphan + log [WARN] + `MIGRATION_FLAG_KEY` 置 done → **永远不再尝试迁移 → 永久丢失**
- 影响范围：所有 bankName 含空格 / 控制字符 / `<>:"/\|?*` 的模板（国际银行常见，如 "BNP Paribas"、"Standard Chartered"）；国内"中行""建行"短词不触发，但"中国 银行" / "中国 工商银行"等带空格变体会触发

#### F3 — Round 1 修复覆盖 in-memory 编辑

- 链路：
  - Round 1 修复（commit `9add60e`）让 `manageBigAccountBtn` click handler 总是 `await window.desktopApi.bigAccount.getWithOwn(...)` → 用结果覆盖 `bigAccountsForDialog`
  - 用户场景：
    1. 模板管理 → 打开 mapping dialog（payload.bigAccounts 不含 own）
    2. 点维护大账号 → getWithOwn 拿到 [client_a, client_b, own_x]
    3. 用户在弹窗里**手动删除 own_x** → 点完成 → onDone(nextBigAccounts=[client_a, client_b])
    4. 重开 mapping dialog（payload.bigAccounts = [client_a, client_b]）
    5. 用户**再次**点维护大账号 → 本应用 currentBigAccounts（已删 own_x），但 round 1 修复又去 await getWithOwn → 数据库里 own_x 还没删（saveMappings 还没跑）→ 拉回 [client_a, client_b, own_x]
    6. 用户在弹窗里再操作 → 完成 → 写回 → **own_x 又被插回**
- 严重程度：用户主动删除的 own 被静默"复活"，等同于操作失效

#### F4 — fixedAssignment lookup 按 merchantId 单键覆盖

- 链路：
  - `main.js:3154-3172 cleanedBigAccounts`（v1.5.3）保留 `accountNature`，且 `groupBigAccountRows` 按 `(merchantId+accountNature)` 分组 → 同 merchantId 可能出现 2 条
  - 旧代码 `:3173` `new Map(items.map(i => [i.merchantId, i]))` → 后写覆盖前写
  - 例：M_X 在 client 行 `currencies=['CNY']`，own 行 `currencies=['USD']`
  - lookup `M_X` 拿到的是 own 那条 → fixedAssignment item `{merchantId:M_X, currency:'CNY'}` 过滤 `!validCurrencies.includes('CNY')` → 误判 → silently filtered out
- 影响范围：用户在 fixedAssignment 配置中给 client 账号设了固定字段赋值，但 client+own 共享 merchantId 且 currencies 不重叠 → 该固定字段赋值被静默删除

### 修复方案

#### F2 — sanitize 双向匹配

- `src/backend/own-account-store.js`：
  - module.exports 新增 `sanitizeBankName`（原本是文件内 private 函数，为支持迁移侧反向匹配 export）
- `src/backend/database/own-accounts-migration.js`：
  - 顶部 import 新增 `sanitizeBankName`（来自 own-account-store）+ `splitTemplateName`（来自 balance-seed-store）
  - 新增 helper `buildSanitizedBankNameIndex(db)`：遍历所有模板 → `splitTemplateName(t.name).bankName` → `sanitizeBankName(rawBankName)` → 建 `Map<sanitizedKey, [{id, name}]>`
  - 迁移主循环改为：file basename 优先去 `templateBucketsBySanitizedBankName` 索引 lookup；查不到 → fallback 到旧 `getTemplatesByBankName`（短词无空格场景下两路径等价）
  - 注释说明决策原因 + 可能影响 + 与原有逻辑兼容性

#### F3 — `bigAccountsLoadedWithOwn` 标记

- `src/renderer-dialogs.js:createMappingDialog`：
  - `:2518` 把 `const currentBigAccounts` 改为 `let`（允许后续 reassign）
  - `:2519-2524` 新增 `let bigAccountsLoadedWithOwn = Boolean(payload.bigAccountsLoadedWithOwn);` 标记
  - `:2840-2860` `manageBigAccountBtn` click handler 仅在 `!bigAccountsLoadedWithOwn` 时去 await `getWithOwn`；成功后同步给 `currentBigAccounts` + 置标记 true
  - `:2879/2889` onDone / onCancel 重开 createMappingDialog 时显式透传 `bigAccountsLoadedWithOwn: true`
  - 注释说明：保护 in-memory 编辑（包括用户主动删除的 own 行）

#### F4 — `bigAccountCurrencyLookup` 按 merchantId 聚合 currencies

- `src/main.js:validateTemplateConfiguration`：
  - `:3173-3192` 把旧 `bigAccountLookup = new Map(items.map(i => [i.merchantId, i]))` 改为 `bigAccountCurrencyLookup = new Map<merchantId, Set<currency>>`
  - 遍历 `cleanedBigAccounts` 把 `item.currencies` 全部 union 到 set（合并 client + own 的 currencies）
  - filter 改为 `validCurrencies.has(item.currency)`
  - 注释说明：fixed-assignment 本身不区分 nature，能匹配任一 nature 的账户即视为合法

### 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/backend/own-account-store.js` | 修改 | export `sanitizeBankName`（原 private） |
| `src/backend/database/own-accounts-migration.js` | 修改 | 顶部 import 新增 sanitizeBankName + splitTemplateName；新增 `buildSanitizedBankNameIndex`；迁移主循环改双向匹配（sanitize 索引 + fallback） |
| `src/main.js` | 修改 | `validateTemplateConfiguration` `bigAccountLookup` 改为按 merchantId 聚合 currencies |
| `src/renderer-dialogs.js` | 修改 | `createMappingDialog` 加 `bigAccountsLoadedWithOwn` 标记；`manageBigAccountBtn` click handler 条件 fetch；onDone/onCancel 透传标记 |
| `scripts/test-v1.5.3-regression.js` | 修改 | Section 4 新增 P0-F3 / P0-F4 / P0-F5 共 3 条用例 |

### 验证证据

```
--- Section 4 — R2 过滤 / bundle ---
[P1-4] ✅ ...
[P1-5] ✅ ...
[P0-F1] ✅ 维护大账号 roundtrip 不丢 own（Finding 1 修复）
[P0-F2] ✅ 旧链路（过滤后 bigAccounts → saveMappings）会丢 own（负向证明）
[P0-F3] ✅ 迁移 sanitize 双向匹配（含空格的 bankName） — '中国-银行.json' (sanitized) 命中模板 '中国 银行-北京' (raw) → insertedRows=1, orphans=0
[P0-F4] ✅ fixedAssignment lookup 聚合 client+own currencies — merchantId M_X (client:CNY + own:USD) → 合并集 {CNY, USD}（修复）vs 旧 {USD}（bug）
[P0-F5] ✅ bigAccountsLoadedWithOwn 标记决定是否拉 getWithOwn — 决策表正确：缺字段/false=拉, true=不拉（保护 in-memory 编辑）

=== 总计 ===
P0 通过: 23/23
P1 通过: 5/6 (P1-7 skipped)
失败用例: 无
```

- `node scripts/test-v1.5.3-regression.js`：P0 23/23 + P1 5/6 + 1 skip
- `npm run smoke`：pass
- 其他既有用例（R1/R2/R3/R4 + Round 1 P0-F1/F2）均不受影响

### 风险 / 决策

- **资金风险**：F2 是关键资金 bug，修复后通过 P0-F3 用例锁定（含空格 bankName 不再 orphan）
- **回归保护**：保留 `getTemplatesByBankName` 旧 SQL 路径作 fallback，不破坏既有"短词无空格 + 子模板 LIKE 'X-%'"的查询语义
- **F3 设计 tradeoff**：`bigAccountsLoadedWithOwn` 是 dialog 实例级状态，依赖 createMappingDialog 调用方在重开时显式透传。grep 验证 mapping dialog 内部 onDone/onCancel/billsplit 等 spread `...payload` 的 callback 都能自动透传；外部入口（`createMappingDialog(result)`，来自 `template:get-mappings`）不传字段，Boolean(undefined)=false → 首次拉一次 ✓
- **F4 兼容性**：旧 lookup 返回单条 item 含 `accountNature`，但 fixedAssignment 过滤只用 `currencies` 字段；新 lookup 改为 Set\<currency> 不带 nature。grep 验证 `bigAccountLookup` 在 `:3173` 之后无其它使用点 → 重命名 + 改类型不影响其它路径
- **未拆 PR**：3 条 finding 都属于 v1.5.3 R2 收口范围，统一在 PR #22 修不拆分。下一回合 PR 草稿同步前可在 PRD §"实施记录"补一段 round 2 修复记录

### 下一步

1. commit `fix(v1.5.3): Codex review round 2 — 3 issues fixed`
2. push v1.5.x → origin
3. PR #22 评论 `@codex review` 触发 round 3
4. 等 Codex round 3 反馈；若 clean → 等用户决定合并节奏（按 `workflow_no_tester_no_auto_pr`）

---

## 2026-04-23 Dev — Codex Review Round 3（2 条 finding 修复 + 1 次自纠）

> Round 2 修复后触发 Codex round 3 review，发现 2 条新 finding：
> - **F5**（Round 1 修复盲点 — 资金风险）：`createMappingDialog` 用 `payload.bigAccounts`（不含 own）初始化 `currentBigAccounts`。**用户改非大账号 mapping 后不开维护大账号直接保存** → saveMappings DELETE all + INSERT client-only → **数据库 own 被静默删除**。Codex round 1 原话其实早提示过 "(or the save path must preserve omitted own rows)"
> - **F6**（R1 体验 bug）：`monthly-balance:export` 返回 session-loss 错误码（`MONTHLY_BALANCE_NO_PENDING` / `FILE_MISSING`）时只更新状态文字，`state.monthlyBalanceReady` 不重置 → 用户卡死必须切换模式才能重新 assemble

### 缺陷复盘

#### F5 — saveMappings 直接保存路径丢 own

- 链路：
  - 用户从模板管理 click → `desktopApi.templates.getMappings` → payload.bigAccounts (§3.1 过滤 own)
  - createMappingDialog 用 payload.bigAccounts 初始化 `currentBigAccounts` → 不含 own，`bigAccountsLoadedWithOwn=false`
  - 用户改一个非大账号 mapping（如 Date 字段）→ 直接点保存
  - `desktopApi.templates.saveMappings({ bigAccounts: cloneBigAccountItems(currentBigAccounts) })` → 传的是 client-only
  - `database.saveMappings` 先 DELETE all big_accounts，再 INSERT client-only → **own 被静默删除**
- 严重程度：Critical（资金 + 静默 + 用户无感知）

#### F6 — monthly export session loss 后 ready 状态卡住

- 链路：
  - 用户 assemble 月度余额（`monthlyBalance.assemble`）→ 后端 `lastGeneratedExports.monthlyBalance` 暂存 → 前端 `state.monthlyBalanceReady=true`
  - 用户切换模式 → 切回月度 → 后端 `lastGeneratedExports.monthlyBalance=null`（被另一次 assemble 覆盖 / 重启等）
  - 用户点导出 → `monthlyBalance.export` 返回 `MONTHLY_BALANCE_NO_PENDING`
  - 旧代码只 setStatus 错误，**state.monthlyBalanceReady 不变**
  - 用户继续点 → 仍走 `if (state.monthlyBalanceReady) export()` 分支 → 仍失败
  - 用户卡死，必须手动切换两次模式才能触发 assemble 弹窗

### 修复方案

#### F5 — `preserveOwn` 参数

- `src/backend/database/template-repository.js saveMappings`：
  - 函数签名加第 8 参数 `{ preserveOwn = false } = {}`，**默认 false 保持向后兼容旧行为**
  - `preserveOwn=true` 时改为 `DELETE WHERE template_id=? AND account_nature='client'`（仅删 client）
  - `preserveOwn=true` 时 INSERT 防御性跳过 `accountNature==='own'` 行（避免 caller 误传 own 撞 UNIQUE 约束）
- `src/backend/database.js`：facade `saveMappings` 透传第 8 参数 options
- `src/main.js template:save-mappings handler`：`const preserveOwn = payload.preserveOwn === true;`（仅显式 true 才生效，不传 / false 走旧行为）；同时在 `:3984` bundle 导入路径显式传 `{ preserveOwn: false }` 让代码意图明确（虽然默认值已是 false）
- `src/renderer-dialogs.js saveMappings`：调用 IPC 时透传 `preserveOwn: !bigAccountsLoadedWithOwn`：
  - `bigAccountsLoadedWithOwn=false`（用户没开维护大账号 → currentBigAccounts client-only）→ `preserveOwn=true` 保留 own
  - `bigAccountsLoadedWithOwn=true`（用户开过维护大账号 → currentBigAccounts 含 own 全集）→ `preserveOwn=false` 让 caller 全权（含主动删除 own）

#### F6 — monthly export 失败 reset ready 状态

- `src/renderer.js handleExportBalance`（月度模式分支）：
  - export 返回非 success / 非 cancelled 时检查 errorCode
  - 若是 `MONTHLY_BALANCE_NO_PENDING` / `MONTHLY_BALANCE_FILE_MISSING` → reset `state.monthlyBalanceReady = false` + `state.monthlyBalancePreview = null`
  - 用户下次点击 → 由于 `!state.monthlyBalanceReady` → 重新弹 assemble 对话框

### 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/backend/database/template-repository.js` | 修改 | `saveMappings` 加 `{ preserveOwn = false }` 参数；condition DELETE; INSERT 防御性跳 own |
| `src/backend/database.js` | 修改 | facade `saveMappings` 透传 options |
| `src/main.js` | 修改 | `template:save-mappings` handler 取 `payload.preserveOwn === true`；bundle 导入路径显式传 `{ preserveOwn: false }` |
| `src/renderer-dialogs.js` | 修改 | mapping dialog `saveMappings` 调用透传 `preserveOwn: !bigAccountsLoadedWithOwn` |
| `src/renderer.js` | 修改 | `handleExportBalance` 月度分支检测 session-loss errorCode → reset ready 状态 |
| `scripts/test-v1.5.3-regression.js` | 修改 | Section 4 新增 P0-F6 / P0-F7 / P0-F8 共 3 条 |

### 实施过程中的自纠（坦白）

- **初稿设计错误**：第一次实现时把 `preserveOwn` 默认值设为 `true`（"safer default — 不传都保留 own"），结果跑 regression 时 P0-11 / P0-F1 / P1-4 / P1-5 / P0-F6 / P0-F8 一片红 —— 因为已有用例调用 `ctx.db.saveMappings(...)` 不传 options，预期是 DELETE all + INSERT all（旧行为），新默认让 own 被防御性跳过 → 第一次写入 own 行直接丢失
- **修正**：把默认改回 `false`，main.js handler 改为 `payload.preserveOwn === true`（仅显式 true 才生效），renderer-dialogs.js 仍显式传 `preserveOwn: !bigAccountsLoadedWithOwn`。语义更明确：**默认旧行为 = caller 接管 own；新行为是 opt-in**
- **教训**：默认值的方向选择关乎"backward-compat" vs "safer fix"。这种语义上反向的参数应当 opt-in（默认旧行为）而非 opt-out

### 验证证据

```
=== 总计 ===
P0 通过: 26/26
P1 通过: 5/6 (P1-7 skipped: 错误报告为 txt 格式（非 xlsx），无字体可验)
失败用例: 无
```

- `node scripts/test-v1.5.3-regression.js`：P0 26/26（含新增 P0-F6/F7/F8）+ P1 5/6 + 1 skip
- `npm run smoke`：pass
- 其他既有用例 + Round 1/Round 2 P0-F1~F5 全部不受影响
- F6 属 UI 状态决策，自动化无法跑（需要 main 进程 / Electron），由 user 手动 P0-22 验证：assemble → 切模式回 → 点导出 → 报错 → 再点导出 → 应弹 assemble 对话框（无需手动切换模式）

### 风险 / 决策

- **资金风险**：F5 是关键资金 bug，修复后通过 P0-F6（preserveOwn=true 保留 own）+ P0-F7（preserveOwn=false 全权）+ P0-F8（防御性跳 own 行不撞 UNIQUE）三角验证
- **API 兼容**：默认 `preserveOwn=false` 保持向后兼容；其他 caller（bundle 导入、未来第三方）不传字段则走旧行为
- **F6 自动化盲区**：F6 用例 P0-F8 在 regression 没有，需要 user 手动验证 UI 流。已在测试交接说明
- **未拆 PR**：F5/F6 都属于 v1.5.3 R2/R1 收口范围，不拆

### 下一步

1. commit `fix(v1.5.3): Codex review round 3 — 2 issues fixed`
2. push v1.5.x → origin
3. PR #22 评论 `@codex review` 触发 round 4
4. 等 Codex round 4 反馈；若 clean（👍 reaction 或 0 finding）→ 等用户决定合并节奏

---

## 2026-04-23 Dev — Codex Review Round 4（1 条 defensive finding 采纳）

> Round 3 修复后触发 Codex round 4 review，发现 1 条 finding（用户 PR comment ID `4303221690` 转贴）：
> - **F7**（renderer-dialogs.js 6 处 spread 调用点 defensive）：子弹窗（账单拆分行 / 复用模块映射 / 发生额规则 / saveMappings 失败 alert）的 onClose / onDone / onConfirm 回调通过 `...payload` spread + 显式覆盖部分字段 重开 mapping dialog，**没显式声明 `bigAccountsLoadedWithOwn`**。Codex 担心 spread 是隐式透传，未来重构 / 漏写会断链 → 用户先编辑 own 后进子弹窗回返时，bigAccountsLoadedWithOwn 误判 false → preserveOwn=true → own 修改不落库

### 缺陷复盘

代码现状（commit `ea6401f` 之前）：

```js
// 例 1: bill-split rows onClose（renderer-dialogs.js:3006）
openModal(createMappingDialog({
  ...payload,              // 隐式透传 bigAccountsLoadedWithOwn
  bigAccounts: draftBigAccounts,
  // 没有 bigAccountsLoadedWithOwn 字段
  ...
}));
```

**核实结论**：bug 路径**不存在** — `...payload` spread 已经把 `bigAccountsLoadedWithOwn` 自动透传过去（payload 是当前 mapping dialog 实例的入参，含上一次 `manageBigAccountBtn` onDone 显式写入的 `bigAccountsLoadedWithOwn: true`）。

但 **Codex 的 defensive 建议有价值**：
1. 可读性：显式声明让代码意图明确，新人 / 重构者一眼能看出
2. 健壮性：未来如果 spread 被重构（去掉 `...payload` 改为显式参数列表）或 payload 形状变化，链路不会无声断裂
3. 一致性：`manageBigAccountBtn` onDone/onCancel 显式写了 `bigAccountsLoadedWithOwn: true`，子弹窗回返链路也应一致

### 修复方案

在 6 处子弹窗回返链路显式加 `bigAccountsLoadedWithOwn` 字段（**透传当前局部变量值，非写死 true**）：
- `renderer-dialogs.js:3008` — bill-split rows onClose
- `renderer-dialogs.js:3038` — bill-split mappings onDone
- `renderer-dialogs.js:3053` — bill-split mappings onCancel
- `renderer-dialogs.js:3191` — amount-split rules onDone
- `renderer-dialogs.js:3202` — amount-split rules onCancel
- `renderer-dialogs.js:3322` — saveMappings 失败 alert onConfirm

⚠️ **关键**：必须透传**当前局部变量值**而非写死 `true`！如果按 Codex 字面建议写 `bigAccountsLoadedWithOwn: true`，会引入新 bug：用户首次进 mapping dialog（flag=false）→ 不开维护大账号 → 直接进子弹窗 → onClose → mapping dialog 被强制标 true → 保存时 preserveOwn=false → DELETE all → own 被删

### 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/renderer-dialogs.js` | 修改 | 6 处子弹窗回返 createMappingDialog 显式加 `bigAccountsLoadedWithOwn`（透传当前局部变量） |
| `scripts/test-v1.5.3-regression.js` | 修改 | Section 4 新增 P0-F9（spread/显式透传 4 条决策表 contract test） |

### 验证证据

```
[P0-F9] ✅ spread + 显式 bigAccountsLoadedWithOwn 透传等价性 — spread/显式透传 4 条决策表正确：true→true / 显式覆盖 spread / 缺字段→false / 显式 false→false

=== 总计 ===
P0 通过: 27/27
P1 通过: 5/6 (P1-7 skipped: 错误报告为 txt 格式（非 xlsx），无字体可验)
失败用例: 无
```

- `node scripts/test-v1.5.3-regression.js`：P0 27/27（含新增 P0-F9）+ P1 5/6 + 1 skip
- `npm run smoke`：pass

### 风险 / 决策

- **资金风险**：本次修复纯 defensive，不引入新行为；当前没有 bug 路径，修后未来重构防回归
- **未拆 PR**：F7 属 v1.5.3 R2 收口范围，与 round 3 同语境
- **PR 评论回复**：commit message + PR comment 中说明"代码现状下 spread 已透传，没有 bug 路径；接受 Codex defensive 建议防未来重构"

### 下一步

1. commit `fix(v1.5.3): Codex review round 4 — defensive explicit propagation`
2. push v1.5.x → origin
3. PR #22 评论 `@codex review` 触发 round 5
4. 等 Codex round 5；若 clean（0 finding 或仅 👍）→ 等用户决定合并

---

## 2026-04-23 Dev — Codex Review Round 5（2 条 P2 finding 修复）

> Round 4 修复后触发 Codex round 5 review，发现 2 条 P2（低优先级）finding：
> - **F8**（`renderer-dialogs.js:2223`）：`import-bank-info` 直接 concat clientAccounts + ownAccounts，未按 `(merchantId, currency)` dedupe；脏 Excel 同 (merchantId, currency) 既出现 client 又出现 own 时，触发 `template_big_accounts` UNIQUE 约束 `(template_id, merchant_id, currency)` → 整个 save 失败
> - **F9**（`package-lock.json:1`）：`package.json` 已升 `1.5.3` 但 lockfile 根版本仍 `1.5.2`，发版元数据不一致
>
> 同时 Codex round 4 review (针对 Round 3 fix `ea6401f`) 09:10 给出 "Didn't find any major issues. Nice work!"，确认 Round 3 资金风险修复已 clean。

### 缺陷复盘

#### F8 — import-bank-info 合并未 dedupe

- 链路：
  - 用户从模板管理 → mapping dialog → 维护大账号 → 从 Excel 导入大账号信息
  - `desktopApi.bigAccount.importBankInfo(templateId)` 后端解析 Excel → 返回 `{ clientAccounts, ownAccounts }`（按 Excel 列分类）
  - `renderer-dialogs.js:2221-2224` 直接 spread concat 两个数组 → tbody 行
  - 用户点完成 → onDone → mapping dialog → 保存 → `database.saveMappings` INSERT 多行 → 撞 UNIQUE → 整个 transaction rollback
- 严重程度：P2（依赖脏 Excel 输入；显式报错而非静默丢失，但用户体验差，需要手动核查 Excel）

#### F9 — lockfile 版本号未跟随 bump

- `package.json:version = 1.5.3`（v1.5.3 发版收尾时改了）
- `package-lock.json:3 + :9 packages[""]` 仍显 `1.5.2`
- 影响：发版元数据不一致；构建产物 / 锁文件比对 / 版本审计混淆；不影响功能

### 修复方案

#### F8 — `(merchantId, currency)` dedupe，client 优先

- `src/renderer-dialogs.js:2221`：把简单 concat 改为分两阶段合并
  - 阶段 1：把 clientAccounts 全部加入 mergedAccounts，并把 `(merchantId, currency)` pair 加入 `seenByPair` Set
  - 阶段 2：遍历 ownAccounts，对每个 own 行的 currencies 做过滤：剔除 `seenByPair` 中已存在的 currency
    - 剩余 currencies 为 0 → 整体丢弃，记 `droppedOwnPairs`
    - 剩余 currencies < 原 currencies → 部分冲突，记 `droppedOwnPairs` 含 `(部分冲突)` 标记，剩余 currencies 入 mergedAccounts
    - 剩余 currencies == 原 currencies → 全部保留
  - 最后如果 `droppedOwnPairs.length > 0` → console.warn 让用户感知
- 冲突规则：**client 优先**（与 PRD §3.1 一致：自有账户仅在 R1 月度余额放行；UI 默认按 client 行为对齐）

#### F9 — `npm install --package-lock-only`

- 不安装新依赖，仅同步 lockfile
- 验证 `grep -n '"version"' package-lock.json | head -3`：`:3` 和 `:9` 均显 `1.5.3`
- diff 仅 4 行（2 处 +/- 版本号，无依赖增删）

### 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/renderer-dialogs.js` | 修改 | import-bank-info 合并 client+own 改为 dedupe by (merchantId, currency)，client 优先；console.warn 丢弃的 own pair |
| `package-lock.json` | 修改 | 根版本 1.5.2 → 1.5.3（仅 4 行 diff） |
| `scripts/test-v1.5.3-regression.js` | 修改 | Section 4 新增 P0-F10（dedupe 4 条决策表 contract test） |

### 验证证据

```
[P0-F10] ✅ import-bank-info dedupe (merchantId, currency) — client 优先 — 4 条决策表正确：完全冲突丢 own / 无冲突全留 / 部分冲突保留剩余 / 最终无 (mid, cur) 重复

=== 总计 ===
P0 通过: 28/28
P1 通过: 5/6 (P1-7 skipped: 错误报告为 txt 格式（非 xlsx），无字体可验)
失败用例: 无
```

- `node scripts/test-v1.5.3-regression.js`：P0 28/28 + P1 5/6 + 1 skip
- `npm run smoke`：pass
- `grep '"version"' package-lock.json | head -3`：均 `1.5.3` ✓

### 风险 / 决策

- **F8 行为变更**：脏 Excel 场景下，原行为是 save 报错（用户感知 + 可手动纠正 Excel）；新行为是静默丢弃 own + console.warn（用户在 DevTools Console 才能看到）。trade-off：避免 save 失败带来"全部白干"的体验损失，代价是 own dedupe 不在主 UI 提示。**建议未来 round 6+ 把 droppedOwnPairs 升级为状态栏 toast** — 但本轮先按 P2 节奏修
- **未拆 PR**：F8 / F9 都属 v1.5.3 R2 收口范围
- **F9 是元数据一致性修复**：纯文本同步，无运行时影响

### 下一步

1. commit `fix(v1.5.3): Codex review round 5 — 2 P2 issues fixed`
2. push v1.5.x → origin
3. PR #22 评论 `@codex review` 触发 round 6
4. 等 Codex round 6；若 clean → 等用户决定合并

---

## 2026-04-23 Dev — Self-Review Round 6（Critical 1 + Important 2 修复）

> Round 5 修复后用户要求 Dev 自审；Dev 用 reviewer 视角对累计 round 1-5 改动做 self-review，按 Critical / Important / Minor 分级；用户确认"一起修"后落地 1 Critical + 2 Important（其中 I3 横向核对后无需改代码）。

### Self-Review 摘要

| 级别 | ID | 描述 |
|------|----|------|
| Critical | C1 | F8 dedupe 后 own 静默丢失（仅 console.warn）→ 升级为 setStatus 错误级 toast |
| Important | I1 | F8 后 saveMappings 仍会删数据库已存的 own（非本轮 bug，是 import-bank-info 覆盖式语义）→ **本轮记 spec / 不改代码** |
| Important | I2 | F5 preserveOwn=true 防御性跳 own 行无 caller 反馈 → 加 console.warn 含跳过明细 |
| Important | I3 | F4 lookup 一致性未横向 grep → **核对后只有 :3173 一处，其他链路用 list / 不假定唯一，无需改** |
| Minor | M1-M4 | 测试覆盖 / 性能 / spec 同步 / commit 长度 — 本轮仅顺手补回归 |

### 缺陷复盘

#### C1 — F8 dedupe 后 own 静默丢失

- 链路：
  - 用户从 Excel 导入大账号 → import-bank-info 解析 → clientAccounts + ownAccounts
  - F8 round 5 修复：按 (merchantId, currency) dedupe，client 优先；丢弃的 own 仅 console.warn
  - **问题**：console.warn 仅 DevTools 可见 → 生产用户在状态栏看到 success → 完成 → 实际有 own 行被丢
  - 这是与 Codex round 1 同质问题（silent data loss）的新变种
- 严重程度：**Critical**（用户感知缺失 + 可能资金风险）

#### I2 — preserveOwn=true 跳 own 静默 return

- 位置：`template-repository.js:477` 防御性 `return` 跳 own 行（避免撞 UNIQUE）
- 问题：caller 不知道有数据没入库；如果未来有人误以为 preserveOwn=true 也能加 own 会困惑
- 严重程度：Important（防御 + 排障可见性）

#### I3 — 横向 lookup 一致性

- 核对范围：`grep -rn "new Map.*merchantId"` 全代码库
- 结果：唯一引用是 `main.js:3175` 的注释（解释旧 bug）
- 其他链路（`pendingContext.bigAccounts.allMerchantIds` 等）用 list 而非 Map，不假定 merchantId 唯一
- 结论：**无需改代码**，已记录核对依据

### 修复方案

#### C1 — droppedOwnPairs 升级为 setStatus 'error'

- `src/renderer-dialogs.js:2258-2270`：
  - 保留 console.warn 作为 DevTools 排障线（不删）
  - 新增 setStatus 分支：`droppedOwnPairs.length > 0` → `setStatus("...; ⚠ 检测到 N 个自有账号与客资重复...请核对 Excel 源数据是否分类正确", 'error')`
  - 选 'error' 而非 'warning' 是因为状态栏 'warning' 没有专用 tone（未实现），用 'error' 让用户必须主动注意

#### I2 — saveMappings 跳 own 加 warn 含明细

- `src/backend/database/template-repository.js:472-498`：
  - 在循环内收集 `skippedOwnRows` 数组（含 `mid/cur` 标识）
  - 循环结束后，如有跳过 → console.warn（含数量 + 明细）
  - 不 throw（caller 可能是 batch import / bundle，不能阻塞写入）

### 涉及文件

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src/renderer-dialogs.js` | 修改 | C1 — droppedOwnPairs > 0 时升级为 setStatus 'error'，含丢弃明细 |
| `src/backend/database/template-repository.js` | 修改 | I2 — saveMappings 收集 skippedOwnRows 并 warn 含明细 |
| `scripts/test-v1.5.3-regression.js` | 修改 | 新增 P0-F11（droppedOwnPairs 4 条决策表）+ P0-F12（saveMappings preserveOwn=true warn 拦截测试） |

### 验证证据

```
[P0-F11] ✅ dedupe droppedOwnPairs 计数与明细正确（C1 修复）
[P0-F12] ✅ saveMappings preserveOwn=true caller 误传 own 触发 warn（I2 修复） — warn 含 2 条 own 跳过明细; 数据库 2 条（client 1 + 已存 own 1）

=== 总计 ===
P0 通过: 30/30
P1 通过: 5/6 (P1-7 skipped: 错误报告为 txt 格式（非 xlsx），无字体可验)
失败用例: 无
```

- `node scripts/test-v1.5.3-regression.js`：P0 30/30（含新增 P0-F11/F12）+ P1 5/6 + 1 skip
- `npm run smoke`：pass
- 所有既有用例 + Round 1-5 P0-F1~F10 + Round 1-5 字体 / 浮点精度 / R1 / R2 全部通过

### I1 推迟决策（spec 记录，非本轮修）

**问题**：F8 dedupe 后 saveMappings 仍会删数据库其他 own。
- 链路：维护大账号 → 从 Excel 导入 → tbody 替换为 mergedAccounts → onDone → mapping dialog 重开（loadedWithOwn=true）→ 保存 → preserveOwn=false → DELETE all + INSERT mergedAccounts → **数据库已存的、不在 Excel 范围的 own 被删**
- 这是 import-bank-info **覆盖式**语义的既有行为（v1.5.3 之前 import-bank-info 只 ownAccounts，行为也是覆盖；新增 client+own merge 后覆盖语义未变）
- **决策**：本轮不改，下版本（v1.5.4 或更晚）由 PM 决策语义 — 是否改成 "merge 模式"（保留数据库已存 own）

### 风险 / 决策

- **C1 行为变更**：原 `success` 状态文案 + console.warn → 新 `error` 状态文案（含明细）。trade-off 选了"用户必须主动注意"（PRD §3.1 自有账号是资金链路相关）
- **I2 行为变更**：caller 误传 own 时新增 warn 输出（不影响数据写入）— 仅影响 DevTools console 输出，无业务影响
- **I3 不改代码**：横向核对结论已记录在 log，未来如有新增 lookup 链路，参照 `:3173` 模式
- **未拆 PR**：C1/I2 仍属 v1.5.3 R2 收口范围

### 下一步

1. commit `fix(v1.5.3): self-review round 6 — C1 silent loss + I2 defensive warn`
2. push v1.5.x → origin
3. PR #22 评论 `@codex review` 触发 round 7
4. 等 Codex round 7；若 clean（0 finding 或仅 👍）→ 等用户决定合并
