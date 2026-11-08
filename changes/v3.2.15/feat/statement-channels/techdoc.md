# TechDoc — 网银账单：渠道与子模板（取代主模板）

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.15 |
| 功能分支 | `feat/statement-channels`，基于正式标签 `v3.2.14`（main 合并提交 `245bae04`，内容与发布候选 `6eadb896` 一致） |
| 日期 | 2026-11-04 |
| 状态 | 已实现，待 PR 审查；实施中的偏差见「十一、实施记录」 |
| 依据 | [spec.md](spec.md) 的 D1–D9、A1–A11；用户 2026-11-04 批准的实施方案，以及同日补充的账户映射渠道层与导入子模板命名 |
| 格式来源 | `changes/v3.2.13/feat/settings-template-versions/techdoc.md` 的章节组织 |

行号均指基线 `v3.2.14` / `245bae04`，实现时以符号名为准。

## 一、目标与范围

- 用渠道取代主模板：新表保存渠道，模板通过 `channel_id` 归属渠道；旧的主/子数据启动时一次性迁移。
- 账单生成按渠道分组，输出身份（明细 `Channel` 列、余额银行名称与所在地、种子、余额调整、导出文件名）统一取渠道名；渠道内一条余额链，余额方式必须一致。
- 模板管理页与映射关系管理改为渠道交互，新增【导入子模板】、渠道重命名与删除。
- 账户映射增加渠道层：渠道统一设置，对全部子模板生效；迁移时合并子模板原有映射，冲突登记为待处理，由用户在升级后选定。
- 模板文件包升到 v5，兼容读取 v≤4。

不包含：对账模块的渠道（`channels` 表、`channel_enum_values`）、按表头匹配规则、输出列与格式、月度余额导出范围、跨文件去重。

## 二、技术决策

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| T1 | 新表 `statement_channels`，`templates` 新增 `channel_id`（外键，`ON DELETE SET NULL`）。旧列 `is_parent`、`parent_template_id` 保留不删，迁移后清零，新代码不再读写 | 删除渠道时子模板自动变回普通模板（A5）；SQLite 删列需要重建表，保留旧列风险更小；与对账模块的 `channels` 表分开命名（A1） |
| T2 | 迁移 `ensureStatementChannelSupport` 以旧标记是否存在作为是否执行的判断，不另设完成标记 | 转换后旧标记清零，再次启动自然为空操作；用户删除的渠道没有旧标记可依，不会重建 |
| T3 | 输出身份集中由 `resolveStatementOutputName(template)` 决定（`template.channelName \|\| template.name`），在 `buildStatementGenerationConfig` 中算出并放入 `config.outputName`；下游凡是用模板名决定输出身份的地方改读 `config.outputName`，`config.template` 仍是子模板本身 | 明细行按各文件命中的子模板构建（`Channel` 列在构建配置时写入），余额、种子、文件名在组配置上取值，两处都经同一函数，不会分叉 |
| T4 | 分组键统一由 `resolveGenerationGroupKey(entry)` 给出：属于渠道为 `channel:<id>`，否则为 `template:<matchedTemplateId>`；`entry.matchedTemplateId` 保持子模板 ID 不变 | 明细行映射、会话、重算仍需知道每个文件命中的子模板；只有分组口径改变 |
| T5 | 余额方式由 `resolveTemplateBalanceMode(mappings)` 归一为 `none`（Balance 未映射或为“无”）/ `statement` / `calculated`；保存映射时校验，导入分组后整批再校验，不一致抛 `FileValidationError('CHANNEL_BALANCE_MODE_MISMATCH')` | D2；导入时的校验兜住迁移与模板包导入留下的不一致 |
| T6 | 渠道归属随 `template:save-mappings` 一起提交，在 `saveMappings` 的同一事务内写入；校验全部在写入前完成 | 原来映射与主/子状态分三次 IPC 写入，中途失败会留下半更新；`saveMappings` 自带 `BEGIN/COMMIT`（`template-repository.js:430`），不能嵌套事务 |
| T7 | 【导入子模板】新增 `template:import-child`，复用 `template:import` 的选择框与表头查重；模板名按 D9 由渠道编号生成，不走 `upsertTemplate` 的同名覆盖，在一个事务内分配编号、插入模板并写入 `channel_id` | 与【导入模板】的文件计划、归档登记一致；编号只在导入成功的事务里递增，失败或取消不占号（A11） |
| T8 | 删除界面已走不到的“选主模板导入”分支（`main.js:12362–12460`）和 3 个旧 IPC（`template:list-children`、`template:set-parent-status`、`template:set-child-parent`） | 不保留两套分组语义；删除前用调用方检索确认无入口 |
| T9 | 渠道内的组配置取第一个文件命中子模板的配置，只用于输出身份与余额方式（二者在渠道内一致）；是否多大账号、大账号注入按各文件自己的子模板判断 | 现有 `generateMultiTemplateGroupFiles` 以 `groupEntries[0]` 的配置判断多大账号（`main.js:10243–10253`），渠道内各子模板的 MerchantId 映射可能不同，需改为逐条目判断 |
| T10 | 渠道账户映射单独建表 `statement_channel_account_mappings`，列与 `account_mappings` 相同，以 `channel_id` 取代 `template_id`（外键级联删除，`UNIQUE(channel_id, bank_account_id)`）；子模板加入渠道时其模板级映射并入渠道后删除，移出时由渠道复制回模板 | `account_mappings.template_id` 为 `NOT NULL` 且带唯一约束，改为可空需要重建表；渠道内只保留一份映射，避免两处来源 |
| T11 | 生成时读取的映射统一经 `listEffectiveAccountMappings(template)`：属于渠道取渠道映射，否则取模板映射；替换 `buildStatementGenerationConfig` 中的 `database.listAccountMappings(template.id)`（`main.js:9807`） | 账户映射在明细行构建时生效（`file-service.js:626`、`661`），按每个文件的子模板构建配置，入口只此一处 |
| T12 | 迁移冲突登记在 `statement_channel_account_mapping_conflicts(channel_id, bank_account_id, candidates_json, created_at)`，候选为 `{ clearingAccountId, noCurrency, currency, sourceTemplateNames[] }`；用户选定后在一个事务内写入渠道映射并删除该冲突 | 冲突需要跨重启保留，并能按渠道判断是否阻断生成；不复用 `account_mapping_migration_pending`（旧版全局 → 模板迁移的开关，语义不同） |
| T13 | 冲突提醒在网银账单模块激活时检查一次（`controllers/statement.js`），打开账户映射时再检查；生成阻断放在 §5.2 余额方式校验的同一位置 | D8 要求升级后打开网银账单时弹窗；阻断在进入大账号选择与生成之前，不产出任何文件 |

明细合并的前提已核实：`exportTargetFields` 来自全局枚举（`buildExportTargetFields`，`main.js:3819`），所有模板的明细列相同、顺序相同，`mergeMappedDetailRows`（`statement-session.js:151`）按位置拼接不会错列。取账单余额模式下同日多余额值由 `inferEndingBalance`（`normalizers.js:49`）按收支金额推导唯一值，与文件顺序无关。

## 三、数据模型与迁移

### 3.1 表结构

```sql
CREATE TABLE IF NOT EXISTS statement_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  next_child_no INTEGER NOT NULL DEFAULT 1,  -- 【导入子模板】下一个编号（D9、A11）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- hasColumn 判断后执行
ALTER TABLE templates ADD COLUMN channel_id INTEGER REFERENCES statement_channels(id) ON DELETE SET NULL;
```

删除渠道依赖外键级联置空。主库连接已开启 `PRAGMA foreign_keys = ON`（`database.js:156`、`446`），`deleteChannel` 仍在同一事务内显式置空 `templates.channel_id`，不单独依赖连接设置，并写测试覆盖。

### 3.2 迁移 `ensureStatementChannelSupport(db, createBackupFn)`

放在 `ensureParentTemplateSupport` 之后执行：

1. 建表、加列（幂等）。
2. 查询“渠道来源”：`is_parent = 1` 的模板，以及被任何模板 `parent_template_id` 引用的模板。没有则返回。
3. 有待迁移数据时先用 `createBackupFn` 备份主库（沿用 `ensureScenariosNameUniqueByChannelId` 的做法）。
4. 单个事务内：
   - 每个来源模板按其名称取得或新建渠道，把来源模板和 `parent_template_id` 指向它的模板都设为该渠道。
   - 清零所有模板的 `is_parent`、`parent_template_id`。
   - 收集“子模板名银行段与渠道名银行段不同”的模板（D5，种子文件不搬移）。
   - 合并账户映射（§3.4）：把渠道下各模板的 `account_mappings` 按账户号归并；设置完全相同的写入渠道映射，不一致的写入冲突表；合并后删除这些模板的模板级映射。
5. 提交后把迁移结果写入活动日志：新建渠道数、归入模板数、银行段不同的模板清单、合并的账户映射数与冲突数。
6. 失败回滚并抛出，沿用现有迁移的启动失败处理。

### 3.3 仓储（`template-repository.js`，另可拆出 `statement-channel-repository.js`）

| 函数 | 说明 |
| --- | --- |
| `listChannels(db)` | `{ id, name, templateCount, createdAt, updatedAt }`，按名称排序 |
| `getChannel` / `getChannelByName` | 单条查询 |
| `createChannel(db, name)` | 名称去空白、非空、唯一；冲突抛带 code 的错误 |
| `renameChannel(db, channelId, name)` | 同上校验 |
| `deleteChannel(db, channelId)` | 删除渠道，子模板 `channel_id` 置空 |
| `listTemplatesByChannel(db, channelId)` | 渠道下的模板摘要 |
| `setTemplateChannel(db, templateId, channelId)` | 仅供模板包导入使用 |
| `createChildTemplate(db, channelId, { sourceFileName, headers })` | 单个事务：读取 `next_child_no`，从它开始找第一个未被任何模板占用的 `<渠道名>-子模板-<N>`，插入模板（新 `template_key`）并写 `channel_id`，再把 `next_child_no` 设为 N+1；返回模板摘要 |

- `listTemplates`、`getTemplate`、`listChildTemplates` 的查询改为 `LEFT JOIN statement_channels`，摘要（`database/utils.js` `buildTemplateSummaryFromRow`）删去 `isParent`、`parentTemplateId`，新增 `channelId`、`channelName`。
- `saveMappings` 增加可选参数 `channelAssignment`：`{ mode: 'keep' }`（默认，不改归属）、`{ mode: 'none' }`、`{ mode: 'create', name }`、`{ mode: 'join', channelId }`，在原事务内写入。
- 删除 `setParentStatus`、`setChildParent`、`listChildTemplates` 及 `database.js` 门面的对应方法。
- 归属变化时的账户映射在同一事务内处理：`create` 把模板映射移到新渠道；`join` 先比对，同一账户号设置不同即抛 `CHANNEL_ACCOUNT_MAPPING_CONFLICT`（带冲突明细，整个保存回滚），否则并入后删除模板映射；`none`（移出）与 `deleteChannel` 把渠道映射复制给恢复为普通模板的模板（A10）。

### 3.4 账户映射（`settings-repository.js`）

```sql
CREATE TABLE IF NOT EXISTS statement_channel_account_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES statement_channels(id) ON DELETE CASCADE,
  bank_account_id TEXT NOT NULL,
  clearing_account_id TEXT NOT NULL,
  no_currency INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT '',
  row_index INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(channel_id, bank_account_id)
);
CREATE TABLE IF NOT EXISTS statement_channel_account_mapping_conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES statement_channels(id) ON DELETE CASCADE,
  bank_account_id TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(channel_id, bank_account_id)
);
```

| 函数 | 说明 |
| --- | --- |
| `listAccountMappings(db, scope)` / `saveAccountMappings(db, scope, mappings)` | `scope` 为 `{ templateId }` 或 `{ channelId }`；保存为整表替换，沿用现有校验 `validateAccountMappings`。对渠道子模板以 `{ templateId }` 保存时拒绝（D7） |
| `listEffectiveAccountMappings(db, template)` | T11 |
| `listChannelAccountMappingConflicts(db, channelId?)` | 不传渠道时列出全部，带渠道名 |
| `resolveChannelAccountMappingConflicts(db, channelId, choices)` | `choices: [{ bankAccountId, candidateIndex }]`；只接受当前登记的冲突与候选下标，选定项追加到渠道映射末尾 |

比对口径：账户号按现有规则规范化（去空白）后比较；`clearingAccountId`、`noCurrency`、`currency` 三项全部相同才算同一设置。

## 四、文件清单

| 文件 | 改动 |
| --- | --- |
| `src/backend/database/migrations.js` | `ensureStatementChannelSupport`（§3.2） |
| `src/backend/database.js` | 启动时调用迁移并传入备份函数；渠道门面方法；删除主/子门面 |
| `src/backend/database/template-repository.js`、`database/utils.js` | §3.3；`listTemplateBundleEntries` 输出 `channelName` |
| `src/main.js` | IPC（§5.1）；`buildStatementGenerationConfig` 计算 `outputName`（`Channel` 列，`main.js:9763–9771`）；分组改用 `resolveGenerationGroupKey`（`resolveGenerationTemplateConfig` 2606、`regenerateVirtualTemplateBalanceFromSession` 10107、`generateMultiTemplateGroupFiles` 10209、默认文件名分组 10776–10813、导出全部 10880）；`main.js:13218–13221` 是否走多组路径的判断保留按子模板计数：同一渠道有多个子模板时必须走分组路径，才能逐文件按各自映射构建，组数与 `N-BALANCE` 文件名中的 N 由分组键决定；多大账号逐条目判断（T9）；余额方式整批校验；大账号候选按渠道聚合（替换 11896–11935 的主模板追加）；删除旧分支（T8）；模板包 v5（`SUPPORTED_BUNDLE_VERSION` 1729、导出 3543、解析 3575–3602、导入写回 9013–9020） |
| `src/main-process/statement-generation.js`、`statement-generation-business.js`、`manual-balance-seed-preflight.js` | 以模板名决定银行名、种子、余额调整、文件名的位置改读 `config.outputName`（如 `statement-generation.js:164/232`、`statement-generation-business.js:201/329/412/479`、`manual-balance-seed-preflight.js:135/188`） |
| 新增 `src/main-process/statement-channel-identity.js` | `resolveStatementOutputName`、`resolveGenerationGroupKey`、`resolveTemplateBalanceMode` 与余额方式不一致的明细文案，纯函数 |
| `src/main-process/monthly-balance.js` | `isRegularTemplate` 改为 `!template.channelId`（A7） |
| `src/backend/database/settings-repository.js` | §3.4 账户映射按 scope 读写、生效映射、冲突的查询与处理 |
| `src/main.js`（账户映射） | `account-mapping:list` / `account-mapping:save`（`main.js:7667–7709`）接受 scope；新增冲突查询与处理 IPC；`buildStatementGenerationConfig` 改用生效映射（9807）；模板包导出不再为渠道子模板写 `accountMappings`（3532），渠道映射写在 `channels[]` |
| `src/renderer/controllers/statement.js` | 模块激活与打开账户映射时检查冲突（`handleOpenAccountMappings` 附近，198–218）；账户映射弹窗的下拉数据改为渠道与普通模板 |
| `src/preload.js` | `templates` 删除 `listChildren`、`setParentStatus`、`setChildParent`，新增 `importChild(channelId)`；新增 `channels.list/rename/delete` |
| `src/renderer/dialogs/configuration.js` | §6；`createAccountMappingDialog`（5068）下拉框改为渠道 / 模板；新增渠道账户映射冲突弹窗（参照 `createAccountMappingMigrationDialog`，5402） |
| `src/main-process/archive-center/task-policy-registry.js`、`task-file-plan-registry.js`、`operation-tracker.js`、`execution-descriptors/legacy-task-policies.js` | 新增与删除通道的登记（§7） |
| `architecture/boundaries.json` | `renderer-dialog-configuration`、`renderer-statement` 的 `allowedApiFields.api` 增删，登记 policyChanges（§7） |
| `tests/fixtures/execution-descriptors/archive-baseline.json` | 通道基线同步 |
| 预览与夹具：`scripts/render-template-manager-preview.js`、`scripts/render-modal-preview.js`（mapping-dialog）、`scripts/renderer-lifecycle/fixtures/configuration-dialogs.js` | 预览数据与夹具改为渠道 |
| `docs/USER_GUIDE.md` | 主/子模板章节改为渠道与子模板（发版时） |

## 五、接口契约

### 5.1 IPC

| preload 方法 | IPC | 处理器 | 返回 |
| --- | --- | --- | --- |
| `channels.list()` | `channel:list` | `ipcMain.handle` | `[{ id, name, templateCount }]` |
| `channels.rename({ channelId, name })` | `channel:rename` | `businessIpcHandle` | `{ status: 'success', channel }`；名称为空 `CHANNEL_NAME_REQUIRED`，重复 `CHANNEL_NAME_DUPLICATED`，不存在 `CHANNEL_NOT_FOUND` |
| `channels.delete(channelId)` | `channel:delete` | `businessIpcHandle` | `{ status: 'success', releasedTemplateCount }` |
| `templates.importChild(channelId)` | `template:import-child` | `trackedIpcHandle`，与 `template:import` 相同的 prepare / filePlan | 同 `template:import`，`template` 带 `channelId`、`channelName`，`message` 含分配的模板名；渠道不存在 `CHANNEL_NOT_FOUND`；表头与已有模板相同 `TEMPLATE_HEADERS_DUPLICATE`（不占号）。活动日志记录渠道、分配的模板名与源文件 |
| `templates.saveMappings(payload)` | `template:save-mappings` | 不变 | `payload.channel` 可选：`{ mode: 'none' \| 'create' \| 'join', channelId? }`，缺省为不改归属；新增错误 `CHANNEL_NAME_DUPLICATED`（create 时同名渠道已存在，D6）、`CHANNEL_NOT_FOUND`、`CHANNEL_BALANCE_MODE_MISMATCH`、`CHANNEL_ACCOUNT_MAPPING_CONFLICT`（join 时账户映射冲突，A9） |
| `accountMappings.list(scope)` / `accountMappings.save(scope, mappings)` | `account-mapping:list` / `account-mapping:save` | 不变 | `scope` 为 `{ templateId }` 或 `{ channelId }`；为兼容旧调用，传数字视为 `{ templateId }`。对渠道子模板以模板保存返回 `ACCOUNT_MAPPING_CHANNEL_SCOPE_REQUIRED` |
| `accountMappings.listChannelConflicts()` | `channel-account-mapping:list-conflicts` | `ipcMain.handle` | `{ status: 'success', channels: [{ channelId, channelName, conflicts: [{ bankAccountId, candidates }] }] }` |
| `accountMappings.resolveChannelConflicts({ channelId, choices })` | `channel-account-mapping:resolve-conflicts` | `businessIpcHandle` | `{ status: 'success', remaining }`；候选下标或账户号不在登记中返回 `CHANNEL_ACCOUNT_MAPPING_CONFLICT_STALE` |

渠道写操作成功后调用 `syncTemplateLibraryFile()`，并写活动日志。删除 `template:list-children`、`template:set-parent-status`、`template:set-child-parent`。

### 5.2 生成前校验：余额方式与账户映射冲突

- 保存时：目标渠道中除当前模板外、已保存过映射的子模板，`resolveTemplateBalanceMode` 结果须与当前提交一致；没有映射的子模板不参与比较。
- 导入时：在 `handleFilenameMappingImport` 完成按模板匹配、进入生成之前，按 `resolveGenerationGroupKey` 分组，任一渠道组内余额方式不一致即返回错误，不进入大账号选择和生成。错误明细逐行列出“子模板名：余额方式”。
- 同一位置检查渠道是否有待处理的账户映射冲突（D8），有则返回 `CHANNEL_ACCOUNT_MAPPING_CONFLICT_PENDING`，明细列出渠道与账户号，提示到账户映射中处理。

### 5.3 模板文件包 v5

- 顶层新增 `channels: [{ name, accountMappings }]`，保留空渠道；条目以 `channelName` 取代 `isParent`、`parentTemplateKey`，渠道子模板的条目不带 `accountMappings`。
- 导入 v5：按名称取得或新建渠道，再按 `channelName` 归属。
- 导入 v≤4：`isParent` 为真的条目按其名称建渠道，它和 `parentTemplateKey` 指向它的条目归入该渠道；各条目的 `accountMappings` 按 §3.2 第 4 步合并，冲突登记为待处理；之后按 v5 处理。
- 导入后对每个渠道做一次余额方式检查，不一致不阻断导入（模板包是整体恢复），写入活动日志，生成时由 §5.2 的导入校验阻断。
- `templates/template-library.json` 由同一份条目生成，随之变为 v5 结构。

## 六、渲染层（`configuration.js`）

- 普通模板过滤（`configuration.js:151–155`）改为 `!template.channelId`。
- 模板管理（`createTemplateManagerDialog`，2765；分组渲染 2703–2760）：
  - 打开时并行取 `services.getTemplates()` 与 `api.channels.list()`，按 `channelId` 分组。
  - 渠道行沿用原主模板行的折叠按钮与样式，名称列为渠道名，“大账号”列汇总子模板大账号（A2），操作为【导入子模板】【重命名】【删除】。
  - 【导入子模板】成功后刷新模板与渠道，展开该渠道，状态栏显示分配的模板名；【重命名】复用模板改名弹窗并加 A6 提示；【删除】先确认，文案说明子模板会恢复为普通模板。
  - 子模板行与普通模板行沿用 `createTemplateRow`（2634）。
- 映射关系管理（`createMappingDialog`，2821；勾选区 2874–2970；保存 3533–3600）：
  - 文案：【设为主模板】→【渠道存在多个子模板】，下拉标签“主模板”→“渠道”，选项来自 `api.channels.list()`。
  - 两个勾选互斥；打开属于渠道的模板时，【设为子模板】勾选并选中所属渠道。
  - 删除名称校验与“取消主模板”的两处确认。
  - 保存时把 `channel` 一并传给 `saveMappings`，不再单独调用旧接口；错误按返回的 code 提示，`CHANNEL_ACCOUNT_MAPPING_CONFLICT` 列出冲突的账户号与两边设置。
- 账户映射（`createAccountMappingDialog`，5068）：
  - 顶部下拉框标签“模板”改为“渠道 / 模板”，选项为渠道（带“渠道”标记）与普通模板，不列渠道子模板；从子模板进入时默认选中其渠道。
  - 切换选项时以对应 scope 读取和保存；渠道有待处理冲突时，表格上方显示提示与【处理冲突】。
- 渠道账户映射冲突弹窗（新增，参照 `createAccountMappingMigrationDialog`）：按渠道分组，每个账户号一行，单选其中一个候选（显示清结算账号、币种设置与来源子模板）；全部选定后才能确认；可关闭，关闭不改数据。
- 网银账单模块激活时（`controllers/statement.js`）调用 `listChannelConflicts`，有冲突即提示并可打开上述弹窗；本次运行内关闭后不再自动弹出，打开账户映射时仍会提示。

## 七、架构与策略登记

- `renderer-dialog-configuration.allowedApiFields.api`：删除 `templates.listChildren`、`templates.setParentStatus`、`templates.setChildParent`，新增 `templates.importChild`、`channels.list`、`channels.rename`、`channels.delete`、`accountMappings.listChannelConflicts`、`accountMappings.resolveChannelConflicts`。`renderer-statement` 新增 `accountMappings.listChannelConflicts`，以及账户映射弹窗所需的 `channels.list`。新增属于放宽，按 `architecture/README.md` 在 `policyChanges` 登记来源提交与 blob。分支以 `v3.2.14` 标签为基线，合入 `release/v3.2.15` 时若 release 侧提交仍持有旧集合，按 v3.2.14 先例以合并前末端补登，并要求 merge commit 合并。
- 归档与执行描述：`template:import-child` 在 `task-file-plan-registry.js` 登记 `eager('prepare-selected-inputs')`，在 `operation-tracker.js`、`legacy-task-policies.js`（`STATEMENT`）、`task-policy-registry.js` 与 `template:import` 同类登记；`channel:rename`、`channel:delete` 与 `template:set-parent-status` 同类；`channel:list` 与 `template:list-children` 同类（只读查询）；`channel-account-mapping:list-conflicts` 为只读查询，`channel-account-mapping:resolve-conflicts` 与 `account-mapping:distribute-migration` 同类。三个旧通道从上述位置与 `archive-baseline.json` 删除，`archive-task-policy-registry.test.js` 的计数同步调整。

## 八、测试与验收

| 层 | 入口 | 覆盖 |
| --- | --- | --- |
| Unit | 新增 `tests/unit/backend/database/statement-channel-migration.test.js` | 主模板与子模板迁移为同名渠道；被引用但未标 `is_parent` 的模板也成为渠道来源；重复运行为空操作；删除渠道后重跑不重建；事务失败回滚；有待迁移数据才备份；银行段不同的清单 |
| Unit | 新增 `statement-channel-repository.test.js` | 渠道增删改查、名称唯一与空白处理、删除后子模板变回普通模板、摘要字段、`saveMappings` 的四种归属模式与失败回滚；`createChildTemplate` 连续编号、删除后不回收、名称被占用时顺延、渠道改名后用新名、失败回滚不占号、迁移渠道从 1 开始 |
| Unit | 新增 `statement-channel-account-mappings.test.js` | scope 读写与子模板以模板保存被拒；生效映射；create / join / none / 删除渠道时的映射移动与复制；join 冲突整体回滚；迁移合并与冲突登记（相同去重、清结算账号不同、无币种标记不同、币种不同）；冲突处理只接受登记中的候选，处理后写入并删除；渠道删除级联清除冲突 |
| Unit | 新增 `statement-channel-identity.test.js` | `resolveStatementOutputName`、`resolveGenerationGroupKey`、`resolveTemplateBalanceMode`（未映射、“无”、余额列、通过发生额计算） |
| Unit | 模板包相关单测 | v5 往返；v4 主/子转为渠道；版本高于 5 拒绝 |
| Unit | IPC 与登记基线 | preload 与 Main 通道对应；归档登记与执行描述基线、计数 |
| Integration | 新增 `scripts/integration/statement-channel.js`（仿照 `statement-balance-gap.js`，真实主库与 xlsx） | ① 渠道两子模板、两个文件含同一账号：一份明细、一份余额，`Channel` 列与余额银行名、所在地为渠道名，余额跨文件连续，种子写在渠道银行段文件；② 余额方式不一致：保存被拒，绕过保存后导入整批阻断且导出目录无新文件；③ 渠道组与普通模板混合导入，组数与文件名正确；④ 发生额计算下渠道首次补录与断档按渠道一次处理；⑤ 旧主/子数据迁移后导入结果符合 ①；⑥ 子模板 MerchantId 映射不同（一个固定账号、一个多大账号）时大账号注入正确；⑦ 渠道账户映射：两个子模板的文件都按渠道映射输出清结算账号与兜底币种，回读明细核对；⑧ 迁移账户映射冲突：未处理时该渠道导入被阻断、普通模板照常生成，处理后导入成功且回读账号为所选候选 |
| 既有用例更新 | `scripts/smoke/scenarios.js`、`scripts/integration/new-account-balance-statement.js`、`scripts/test-v1.5.2-backend.js`、`tests/unit/main-process/archive-storage-root-migration.test.js`、`renderer-lifecycle` 的 configuration-dialogs 夹具 | 改用渠道字段与新接口 |
| Renderer 生命周期 | `configuration-dialogs` 夹具 | 渠道行折叠、【导入子模板】后展开、渠道重命名与删除确认、映射弹窗勾选互斥与保存 payload；账户映射下拉框不含子模板、从子模板进入默认选中渠道；冲突弹窗必须全部选定才能确认 |
| Renderer 生命周期 | `statement-controller` 夹具 | 模块激活时有冲突即提示，关闭后本次运行不再自动弹出 |
| 界面预览 | `npm run preview:template-manager`、`npm run preview:mapping-dialog` | 截图检查渠道行与映射弹窗文案 |

专项审查：实现完成后做 reconciliation-blindspot-pass，重点为余额链合并、种子与调整归属、迁移前后输出身份变化；余额相关结论须人工复核。门禁：本地 lint、相关单测与集成测试；完整 `release-check` 以 PR 的 `smoke-test` 为准（本机内存不足以跑架构检查）。

## 九、风险、兼容与回滚

| 编号 | 内容 | 处理 |
| --- | --- | --- |
| R1 | 子模板名银行段与原主模板不同，迁移后读不到原种子与余额调整 | D5：不搬移种子文件；迁移日志列出这些模板；发布说明提示 |
| R2 | 同一渠道各子模板的 MerchantId / Currency 映射方式不同 | T9 逐条目判断；集成用例 ⑥ 覆盖 |
| R3 | 输出身份在渠道改名后变化，旧种子按旧银行段存放 | 与现有模板改名一致（A6），改名弹窗提示 |
| R4 | 回退到 v3.2.14：旧标记已清零 | 模板与字段映射保留，均显示为普通模板；账户映射见 R9；迁移前的主库备份可用于恢复 |
| R5 | 模板包导入可能带入余额方式不一致的渠道 | 导入时只记日志，生成时阻断（§5.2） |
| R6 | 外键级联依赖 `foreign_keys` 设置 | 已开启；`deleteChannel` 另行显式置空，§3.1 |
| R7 | 账户号没有映射时按原值输出、不报错（`file-service.js:661–665`），渠道映射遗漏的账户号会以原账户号输出 | 现有行为，本次不改；渠道统一设置后不再出现“某个子模板漏设”的情形。是否改为缺映射告警另行决定 |
| R8 | 迁移冲突未处理期间，该渠道不能生成账单 | D8 的预期行为；弹窗与阻断提示都指向处理入口，其他渠道与普通模板不受影响 |
| R9 | 回退到 v3.2.14 时，渠道层账户映射不被旧版读取，渠道子模板的模板级映射已在迁移中删除 | 旧版下这些模板没有账户映射，账户号按原值输出；回退须恢复迁移前的主库备份 |

## 十、实施顺序

1. 数据层：迁移（含账户映射合并与冲突登记）、仓储、账户映射 scope 与生效映射、摘要字段及单测。
2. 主进程：`statement-channel-identity.js`，输出身份与分组改造，余额方式校验，大账号聚合，删除旧分支及旧 IPC；新 IPC 与登记。
3. 模板包 v5 与模板库文件。
4. 渲染层（含账户映射下拉框与冲突弹窗、模块激活检查）、预览与生命周期夹具。
5. 集成测试 `statement-channel.js` 与既有用例更新。
6. 架构登记、专项审查、文档。

## 十一、实施记录（2026-11-05）

实现以本文为准，下列为实施中核实到的事实与相应调整。业务规则（spec D1–D9、A1–A11）没有变化。

### 11.1 与上文不同的技术处理

| 编号 | 原设计 | 实际处理 | 原因 |
| --- | --- | --- | --- |
| I1 | T8、§5.1：删除 `template:list-children`、`template:set-parent-status`、`template:set-child-parent` | 三个通道保留注册：主进程处理器不再读写数据（列表返回空数组，两个写入返回 `TEMPLATE_PARENT_RETIRED`），Preload 方法保留，界面不再调用 | 两个写入通道属于冻结的 G7 TaskPolicy 清单：`action-task-binding-registry.js` 在运行时校验清单数量（134）与 JCS 摘要，`archive-baseline.json` 与基线测试也逐项比对；删除即改动冻结契约。另有测试要求 Preload 通道与主进程注册完全相等。待 G7 基线下次重冻结时一并删除，登记为 backlog |
| I2 | §5.1：新增 `template:import-child` | 复用 `template:import`，Preload `templates.importChild(channelId)` 传 `{ channelId }`；prepare 先确认渠道存在，execute 按 D9 命名并归入渠道 | 新增文件型任务通道同样会改变冻结的 TaskPolicy 清单；复用后文件计划、归档登记与执行描述保持不变 |
| I3 | §5.1：`channel:rename`、`channel:delete` 用 `businessIpcHandle`；`channel-account-mapping:resolve-conflicts` 与 `account-mapping:distribute-migration` 同类 | 三者登记为 support action（reason `statement-channel`），用 `supportIpcHandle`；`channel:list`、`channel-account-mapping:list-conflicts` 登记为只读查询 exclude | 新增 no-file 任务同样改变冻结清单；support action 是 v3.2.13 模板文件版本写入（`template-resources:*`）的先例。基线测试的新增清单与通道计数已同步 |
| I4 | §5.1：Preload 命名空间 `channels.*` | `statementChannels.list/rename/delete` | Preload 已有对账模块的 `channels` 命名空间 |
| I5 | §3.3：门面方法 `listChannels`、`deleteChannel` 等 | `AppDatabase` 上统一加 `Statement` 前缀（如 `listStatementChannels`、`deleteStatementChannel`），仓储内部仍为原名 | `AppDatabase` 已有同名的对账渠道方法，后定义者会覆盖前者 |
| I6 | §3.4：`clearingAccountId`、`noCurrency`、`currency` 三项全部相同才算同一设置 | 按生效值比较：只有勾选“无币种”时才比较兜底币种（大小写不敏感），未勾选时币种栏不参与比较 | `file-service` 只在 `noCurrency` 为真时使用 `currency` 作兜底币种；按存储值比较会把输出相同的设置误判为冲突 |
| I7 | §3.2 第 6 步：失败回滚并抛出 | 失败回滚、写活动日志，启动不阻塞，旧标记保留到下次启动重试；备份失败同样不改动数据 | 与 N5 等启动迁移一致，避免一次迁移失败导致应用无法启动 |
| I8 | §5.3：渠道条目 `{ name, accountMappings }` | 另带 `accountMappingConflicts`（未处理的冲突），v5 导入时原样还原 | 导出时若渠道仍有待处理冲突，不带冲突会丢失这些账户号 |
| I9 | — | 渠道相关业务错误经 `createDetailedErrorResult` 把 `errorCode` 与 `detailLines` 一并返回给界面；`createErrorResult` 的公共返回形状不变 | 余额方式不一致、加入渠道时的账户映射冲突需要在弹窗里逐条展示 |
| I11 | §4.9、A10：移出渠道时复制渠道映射 | 原渠道还有待处理的账户映射冲突时，阻断移出、新建渠道与转入其他渠道（`CHANNEL_ACCOUNT_MAPPING_CONFLICT_PENDING`），保存整体回滚；删除渠道仍按 §4.6 处理 | 对账专项审查：映射副本不含冲突账户号，之后这些账户号按原值输出且无提示（R7），与 D8“不静默取舍”冲突 |
| I12 | §3.4：冲突只经冲突弹窗处理 | 在渠道层账户映射中显式保存了冲突账户号的设置，即视为已为该账户号选定，删除对应冲突，并在提示与活动日志中列出 | 对账专项审查：否则之后在冲突弹窗选定候选会覆盖用户手工设置 |
| I13 | T9：组配置按 `groupEntries[0]` 判断多大账号 | 组内全部条目都是多大账号模板时，组配置才带所选大账号；逐文件注入仍由 `rebuildMatchedTemplateFileEntries` 按各自子模板判断 | 组配置的所选大账号只决定输出文件名中的账号；渠道混有固定账号子模板时，带上所选大账号会使文件名与内容不符 |
| I10 | §4.2 未区分 | 已属于渠道的模板勾选【渠道存在多个子模板】：先移出原渠道，新渠道取原渠道账户映射的副本；同名渠道已存在时仍按 D6 阻断 | 界面上两个勾选互斥，勾选新建时会自动取消【设为子模板】，原实现会直接报错 |

### 11.2 补充处理

- 余额附加值（`余额管理`）从渠道子模板打开时按渠道名读写，与生成时按渠道银行段读取一致；附加值弹窗的账号下拉仍来自当前子模板的大账号（已知限制）。
- 导出全部（`exportScope = all`）与导入一样，按渠道分组并在渠道余额方式不一致时阻断。
- 旧版账户映射迁移分配（`v1.5.1` 之前的数据）只面向普通模板：分配目标为渠道子模板时返回 `MIGRATION_DISTRIBUTE_CHANNEL_TEMPLATE`，分配弹窗不列出渠道子模板。
- 状态栏的账户映射条数包含渠道层映射。
- 单模板导入路径（界面当前不可达）同样在渠道有待处理冲突时阻断，作为兜底。
- 单模板导入路径中 `generateStatementFiles`、种子、补录预检的模板名统一经 `statementOutputName(config)` / `resolveStatementOutputName(template)` 取输出名；`statement-worker` 生成路径共用同一组函数。
- 架构登记：`renderer-dialog-configuration`、`renderer-statement` 的 `allowedApiFields` 以 `f5348123`（本分支 spec 提交，配置与 `v3.2.14` 相同）为来源登记 `policyChanges`；Preload 仍保留的三个旧方法未从白名单移除（命名空间整体传入）。

### 11.3 对账专项审查（2026-11-05，reconciliation-blindspot-pass）

已修正：I11（有冲突时移出渠道会带走缺账户号的映射副本）、I12（手工设置被冲突候选覆盖）、I13（文件名中的大账号与内容不符），以及单模板导入路径的冲突兜底。

⚠️ 资金红线，须人工复核（自动测试不能代替）：

1. **同一渠道两种格式含同一笔交易**：渠道内不做跨文件去重（spec §4.5 第 8 条，与同模板多文件一致）。同一银行两种格式覆盖同一时段时，发生额计算会重复累加，余额多记。需确认业务上是否会对同一时段导入两种格式；如会，需另定去重或告警口径。
2. **迁移后输出身份变化**：子模板名银行段或所在地段与原主模板不同的，`Channel` 列、余额银行名称/所在地、种子与余额调整改按渠道名（D5，逐条写活动日志）。需确认下游清结算对 `Channel` 列取值变化的影响，并核对迁移日志中的模板。
3. **迁移后的余额链衔接**：渠道银行段的种子文件可能没有、或只有更早的原子模板账号种子。发生额计算会提示首次补录或断档（可观测），但用户须按实际期末余额补录，不能沿用原子模板银行段的旧值而不核对。
4. **删除含冲突的渠道**：冲突随渠道清除，冲突账户号在子模板上没有映射，之后按原账户号输出（既有 R7 行为）；删除时有提示并写活动日志。
5. **回退到 v3.2.14**：渠道层账户映射不被旧版读取，须恢复迁移前备份（R9）。

已由 spec 明确为有意设计：渠道内同日多余额值的推导（取账单余额模式沿用 `inferEndingBalance`）；月度余额导出排除渠道模板（A7）；账户号未映射时按原值输出（R7）。

### 11.4 PR #246 Codex 审查（2026-11-05）

`@codex review` 审查 `d657dfe4`，提出 5 项，逐项核实都成立。修复如下，各项都有修复前失败、修复后通过的回归用例。

| 编号 | 发现 | 处理 |
| --- | --- | --- |
| I14（P1） | 与渠道同名的首个子模板移出渠道（或渠道改名为普通模板名）后，普通模板与渠道输出名称相同：两组的生成文件路径相同、后一组覆盖前一组，余额与种子归属也相同 | 不只隔离路径，从源头禁止同名（spec §4.1）：`applyTemplateChannelAssignment`（移出）与 `renameChannel` 抛 `CHANNEL_OUTPUT_NAME_CONFLICT`；`template:rename`、`template:import` 普通模板与渠道同名返回 `TEMPLATE_NAME_CHANNEL_CONFLICT`；导入步骤 3.5 与“导出全部”用 `findGenerationGroupOutputNameConflicts` 兜底，返回 `STATEMENT_OUTPUT_NAME_CONFLICT` |
| I15（P1） | 导入 v≤4 模板包并入已有渠道时只合并渠道生效映射，`replaceChannelAccountMappingsFromSources` 清空冲突后重建，包里未涉及的冲突账户号连同冲突一起消失，渠道解除阻断 | 新增 `listChannelExistingSources`（生效映射 + 冲突候选），启动迁移与 `restoreTemplateBundleStatementChannels` 的旧版包分支在同一事务内共用 |
| I16（P1） | 模板包第一轮被跳过（表头重复、映射校验失败）的模板仍进入第二、三轮，账户映射与渠道归属被包内容改写 | 记录第一轮成功条目，第二、三轮抽为 `restoreBundleFollowUpRounds` 只处理成功条目（第二轮改写映射的问题自 v1.5.1 即存在，一并修正） |
| I17（P1） | v1.5.1 账户映射迁移标记未清除且模板全在渠道时，分配弹窗无数据无目标，两个导入入口被永久阻断 | `settleLegacyAccountMappingMigration`：没有普通模板持有模板级映射时清除标记；每次启动与模板新建 / 加入渠道后核对 |
| I18（P2） | 进入网银账单时的冲突提示用 `openModal` 替换弹窗栈，会关掉启动时的更新说明（不确认、本次不再弹） | `waitUntilNoModalOpen`：逐个等顶层弹窗关闭再提示，期间离开模块不提示；只用已允许的 `modalBridge.host.getTop` |

I14、I15、I16 涉及输出身份与账户血缘，按资金红线列入 PR #246 人工复核。

### 11.5 release/v3.2.15 Codex 审查（2026-11-06）

对 `main...release/v3.2.15` 的只读审查又提出两项 I14、I16 修复后仍可触发的旁路，逐项核实都成立。修复如下，回归在修复前失败、修复后通过。

| 编号 | 发现 | 处理 |
| --- | --- | --- |
| I19（P1） | v5 模板包里归入某渠道的模板第一轮全部被跳过，而该渠道与本地渠道同名时，第三轮仍按包内 `channels[]` 整体替换该渠道的账户映射与冲突：被跳过模板的生效清结算账号、兜底币种被改写，原有待处理冲突被清掉 | `buildBundleV5ChannelRestore` 只还原包内没有模板归入、或至少有一个归入模板第一轮成功的渠道；未还原的渠道写入活动日志。同一渠道部分模板成功时照常还原（渠道层映射属于渠道） |
| I20（P1） | 生成前的同名兜底只比较本批各组：同名的渠道与普通模板分两批导入时，每批只有一组被放行，后一批覆盖前一批的明细、余额文件与同键余额种子 | `findGenerationGroupOutputNameConflicts` 另查库里同名的另一方：渠道组查同名普通模板（不属于任何渠道），普通模板组查同名渠道；导入步骤 3.5 与“导出全部”共用 |

修复后的只读复审（`release/v3.2.15@0b7f873d`）又提出三项，逐项核实都成立：

| 编号 | 发现 | 处理 |
| --- | --- | --- |
| I21（P1，I20 引入） | I20 按显示文字给所有者去重：两个名称只差首尾空格的普通模板（模板名取自文件名、不去空格）显示文字相同，被合成一个所有者而放行，生成路径相同 | 所有者按组身份（`channel:<id>` / `template:<id>`）去重 |
| I22（P1） | v≤4 模板包里父模板第一轮被跳过、子模板成功时，父模板 key 在成功条目里找不到，被当作包外父模板去找本地同 key 模板：本地模板被归入渠道、模板级映射被清掉，生效映射改为与子模板合并的结果 | `buildLegacyBundleChannelRestore` 区分“包内被跳过”与“包外”：父模板在包内但未成功时按无父模板处理，子模板按普通模板导入并写入活动日志；本地父模板不变 |
| I23（P1） | 同名兜底按原始名称精确比较：大小写不同或带首尾空格的渠道与普通模板会放行，而生成路径去空格，且 Windows / macOS 默认文件系统不区分大小写 | 兜底按“去首尾空格、不区分大小写”比较，库里同名的另一方改为遍历模板与渠道列表；同批两个只差大小写的模板同样阻断。另在指定模板导入与按文件名映射补录种子（写入种子前）两处补上同一兜底 |

第二轮修复后的只读复审（`release/v3.2.15@827669ef`）确认 I21–I23 的原反例已关闭，又提出四项，逐项核实都成立：

| 编号 | 发现 | 处理 |
| --- | --- | --- |
| I24（P1） | 兜底的比较口径与实际写盘文件名不一致：写盘时 `sanitizeFileName` 把非法字符替换为 `-`、合并内部空白（含全角空格），兜底只去首尾空格、转小写。`ACME  BANK-SG` 与 `ACME BANK-SG`、`ACME-SG?x` 与 `ACME-SG*x` 被放行；同批同账号同账期时写到同一文件，合并时前一组数据丢失、最后一组重复 | 兜底键改为 `sanitizeFileName(名称).toLowerCase()`，与写盘口径一致 |
| I25（P1） | 库里只查另一类：两个只差大小写或空格的普通模板、两个只差大小写的渠道分两批导入时放行，后一批覆盖前一批的输出文件 | 库里不属于渠道的普通模板与渠道都查，同类与异类都算，仍按组身份去重；属于渠道的子模板由渠道代表，不单独计数 |
| I26（P2） | 指定模板会话的“导出全部”重新生成前没有兜底：导入后把模板改名为与渠道只差大小写（界面改名按原名精确比较），重新生成时与渠道输出相同。标准界面制作账单用虚拟模板，只有指定模板的兼容入口会走到 | 非虚拟分支在记重算上下文和生成之前，用实际生成的模板配置核对 |
| I27（P3） | 多层旧版模板包（A→B→C）A 被跳过时，B 被成功的 C 引用、与 C 组成渠道「B」，日志却写“B 按普通模板导入” | 日志按最终归属分开列：按普通模板导入的子模板，以及以自身名称组成渠道的模板 |

I25 扩大了阻断范围：已有的两个普通模板名称只差大小写、空格或非法字符时，此前分两批生成可以通过，现在要先改名（同批原本已阻断）。余额种子按名称中的银行段与账号归属，同银行的模板本来就共用，名称冲突的风险在输出文件路径；I20 所说的“同键余额种子”不单独构成风险。

第三轮修复后的只读复审（`release/v3.2.15@54cef023`）确认 I24–I27 的原反例已关闭，又提出四项，逐项核实都成立：

| 编号 | 发现 | 处理 |
| --- | --- | --- |
| I28（P1，按 macOS 计） | 兜底键未做 Unicode 规范化：预组合 `É` 与 `E` + 组合重音在 APFS 上是同一个文件名，兜底判为不同。正式用户使用 Windows（NTFS 不合并规范等价写法），实际影响在 macOS | 兜底键在 `sanitizeFileName` 后加 NFC 规范化再转小写 |
| I29（P2） | 生成前的兜底只在导入、导出全部等入口做一次：指定模板补录（`current` / `all`）、大账号选择后续跑、预检计划执行都在等待用户确认后才生成，期间模板或渠道改名不会被发现；补录还会先写种子 | 统一在 main 的两个生成入口（`generateStatementFiles`、`generateFilesFromRememberedContext`）按本次实际使用的模板配置核对：身份取库里模板当前的归属，名称取实际写盘的配置，按文件名映射的虚拟模板跳过。多模板生成在修改会话和写文件之前整批核对，避免前几组已写出；补录在写种子、登记断档之前核对（指定模板按记下的生成上下文） |
| I30（P2，I25 引入） | I25 每次核对都调用 `listTemplates()`，它是管理页的摘要查询，会把全库映射与大账号连接后计数；合成大库上单次核对约 1.5 秒，同步阻塞主进程 | 新增 `listStatementOutputOwners()`，只取不属于渠道的普通模板与全部渠道的 ID 和名称 |
| I31（P3） | 手工合并的旧版模板包里同一模板出现两次时，日志按条目分类，与最后生效的归属不一致 | 日志按模板最终归属分类，每个模板只列一次 |

第四轮修复后的只读复审（`release/v3.2.15@03ce623b`）确认 I28、I30 已关闭、统一核对未误拦正常流程，又提出三项，逐项核实都成立：

| 编号 | 发现 | 处理 |
| --- | --- | --- |
| I32（P1，v3.2.14 起既有） | 按文件名映射多模板导入在预检之后、生成之前删除其中一个模板 B：`getEntryTemplateConfig` 找不到 B 时回退到首模板 A 的配置，B 组按 A 的名称写到 A 组的同一个文件，汇总时 A 的记录丢失、B 的记录重复，导入仍显示成功 | `generateMultiTemplateGroupFiles` 在规划前发现有明确模板 ID 但模板已不存在的组时整批拦下（`TEMPLATE_NOT_FOUND`，明细列出文件），不改会话、不写文件。`getEntryTemplateConfig` 的回退另有调用方，不改 |
| I33（P2，I29 遗留） | 多模板生成的整批核对用库里当前配置，实际生成的组配置可能取自之前记下的配置（fallback）：等待确认期间模板改名、旧名被渠道占用时整批核对放行，先替换了会话里的旧文件，首组生成时才被拦下，会话数据不恢复 | 整批核对改为按各组实际生成用的配置（身份仍取库里当前归属），放在替换会话旧文件与写文件之前 |
| I34（P3，I31 遗留） | 旧包里重复条目最后把模板归入别的渠道时，日志仍写“以自身名称组成渠道” | 日志改为“仍归入渠道的模板：B（渠道「C」）”，写出最终渠道名 |

对整个 release 的只读审查（`release/v3.2.15@32d5f571`）另提出一项本模块的遗留：

| 编号 | 发现 | 处理 |
| --- | --- | --- |
| I35（P1，v3.2.14 起既有） | 内部文件名为“输出名称-账号-…”，组内只有一个账号时才带账号：渠道「BANK-SG」只有账号 1001、模板「BANK-SG-1001」有多个账号时，两组拼出同一个文件名，名称核对放行；同批生成时后一组覆盖前一组，汇总时一组数据丢失、另一组重复，仍显示成功 | 新增 `findGenerationGroupOutputPathConflicts`：按各组实际生成配置的输出名称拼上本组账号（`preparedBatch.selectedMerchantId`，范围为全部时不带账号），按写盘口径比较；多模板生成在替换会话旧文件、写文件之前整批核对，补录重算改为先规划全部组再核对、再生成 |

复审（`release/v3.2.15@5f277fc2`）确认同批覆盖的原反例已关闭，另两项：

| 编号 | 发现 | 处理 |
| --- | --- | --- |
| I35-a（P2，资金） | 按文件名映射的补录在写种子、登记断档之前只核对输出名称，实际文件名（名称拼上账号）到重新生成时才核对：导入后、补录前把模板改成另一组“名称+账号”的名字，补录返回冲突时种子已写入（选“不补录”时断档确认已登记），与 I29 不一致 | 补录重算的分组规划拆为 `planVirtualTemplateBalanceRegeneration`（只读会话与模板配置，不写文件、不读种子）；补录在写种子、登记断档之前按它核对实际文件名，冲突即阻断，同一份规划交给重新生成 |
| I35-b（P2，保留） | 文件名核对只比较“输出名称+账号”，不看明细 / 余额文件名里的日期段：组 A「BANK-SG」账号 1001 账期 9 月 1 日、组 B「BANK-SG-1001」账期 9 月 2 日，实际文件名不同也被拦下要求改名 | 保持按名称与账号核对、不区分日期。日期段由生成层按明细的有效账单日期（明细）与输入账单日期集合（余额）算出，与补录种子、断档确认无关；要按完整文件名比较，须在生成前另写一套与生成层一致的日期推算，口径一旦不一致就会漏拦，漏拦即覆盖丢数据。只差日期的拼接撞名很少见，改名即可解除，因此宁可误拦。用户指南写明该核对不区分日期。若以后要减少误拦，应抽出与生成层共用的只读日期规划，无法确定日期时仍保守拦截 |

界面上的同名拦截（导入模板、模板改名、渠道改名、移出渠道）仍按原始名称精确比较；只差大小写、空格、非法字符或 Unicode 写法的同名由生成前兜底阻断，提示先改名。冲突对象写在报错文件与活动日志里，屏幕摘要只显示提示。

回归：集成脚本 `statement-channel.js` 第 ⑪–⑰ 步、`statement-balance-gap.js` 多模板用例；单测 `statement-balance-gap.test.js` 的按文件名映射补录前阻断（输出名称、实际文件名两类，后者覆盖补录与不补录）、指定模板补录前阻断、指定模板导入建立会话前阻断、指定模板会话“导出全部”重新生成前阻断、生成入口统一核对等用例。I19–I35 涉及账户血缘与输出身份，按资金红线人工复核。

PR #246 的 Codex 审查（`release/v3.2.15@cf78fd0b`）另提出两项：

| 编号 | 发现 | 处理 |
| --- | --- | --- |
| I36（P2，资金） | 模板加入已有渠道时只比较渠道的生效映射；待处理冲突的账户号不在生效映射里，会被漏掉。渠道账户号 111 的冲突候选为 OLD1 / OLD2、模板维护 111 = NEW 时加入成功：模板级映射被删，NEW 写入渠道却不在冲突候选里，之后处理冲突时被所选候选覆盖，NEW 丢失 | `applyTemplateChannelAssignment` 加入前核对目标渠道的待处理冲突：模板维护了其中的账户号时阻断（`CHANNEL_ACCOUNT_MAPPING_CONFLICT_PENDING`），明细逐条列出渠道候选与模板设置，提示先处理冲突再加入；不涉及冲突账户号的模板照常加入。处理冲突后再加入按 A9 比较生效映射 |
| I37（P1，资金） | 启动迁移备份失败或事务回滚时只记日志、继续启动：旧主/子标记保留，模板未归入渠道；新代码不再读旧标记，月度余额只按 `channelId` 排除渠道模板，主、子模板维护同一账号时同一余额输出两次，导入也会按普通模板各自输出 | 新增 `hasPendingStatementChannelMigration`（仍有旧标记即迁移未完成；标记只在迁移成功时清零）。迁移完成前网银账单导入（标准入口与指定模板入口）与月度余额装配返回 `STATEMENT_CHANNEL_MIGRATION_PENDING`，提示重启重试并查看活动日志；下次启动迁移成功后自动解除。不做按旧标记的兼容读取（旧主/子的生成口径已退役） |

回归：单测 `statement-channel-repository.test.js`、`statement-channel-migration.test.js` 新增用例；集成脚本 `statement-channel.js` 第 ⑱、⑲ 步（真实主库迁移冲突后加入被拦、模板映射与候选不变；备份失败后月度余额装配复现重复、入口在处理前核对迁移状态、重试成功后解除）。I36、I37 涉及账户血缘与余额输出，按资金红线人工复核。

### 11.6 验证

见 PR 说明；新增单测 `statement-channel-migration`、`statement-channel-repository`、`statement-channel-account-mappings`、`statement-channel-identity`，集成脚本 `scripts/integration/statement-channel.js`，renderer lifecycle 新增渠道用例。

