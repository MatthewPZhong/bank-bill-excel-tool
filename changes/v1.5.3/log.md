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
