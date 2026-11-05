# TechDoc — 网银账单：渠道与子模板（取代主模板）

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.15 |
| 功能分支 | `feat/statement-channels`，基于正式标签 `v3.2.14`（main 合并提交 `245bae04`，内容与发布候选 `6eadb896` 一致） |
| 日期 | 2026-11-04 |
| 状态 | 草稿，未实现 |
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
