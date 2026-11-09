# TechDoc — 网银账单：原始账单仅有币种无账户号

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.16（暂定） |
| 功能分支 | `feat/statement-currency-big-account`，基于正式标签 `v3.2.15`（`5b5caf7b`） |
| 日期 | 2026-11-09 |
| 状态 | 已实现，待对账专项审查结论、release-check 与 GUI 人工检查 |
| 依据 | [spec.md](spec.md) D1–D3、A1–A5 |
| 格式来源 | `changes/v3.2.15/feat/statement-channels/techdoc.md` 的章节组织（按本任务规模精简） |

行号随代码变化，以符号名为准。

## 一、目标与范围

- MerchantId 新增「原始账单仅有币种无账户号」：按每条输出行的最终币种，取【映射管理】里维护的大账号写入 MerchantId；Currency 写成大写代码。
- 会输出的行币种为空或未维护时整批阻断，并跨文件汇总列出（D1）。
- 映射关系管理新增【映射管理】按钮和弹窗（D2）；模板包升到 v6。
- 不改「自己输入」与 MerchantId 取列两种模式的行为；月度余额导出不纳入（D3）。

## 二、技术决策

| 编号 | 决策 | 原因 |
| --- | --- | --- |
| T1 | 配置单独存 `template_currency_big_accounts`，不复用 `template_big_accounts` | 后者有多个“大账号+币种”组合就会进入选择大账号窗口，渠道导入还会汇总兄弟子模板的大账号；独立存放后，本模式在下游与 MerchantId 取列模式一致 |
| T2 | 映射存储值 `__CURRENCY_ONLY_BIG_ACCOUNT__`，不带 `__FIXED__:` 前缀 | 带前缀的值会被当成「自己输入」或固定账号，漏改的路径静默出错；不带前缀时漏改路径报“映射字段不存在” |
| T3 | `buildMappedRows` 全部行生成后统一回填（`applyCurrencyBigAccountMapping`） | 取的是最终 Currency（含币种映射表换算、拆分行币种），与目标字段顺序无关 |
| T4 | 只拦“会输出”的行，口径同 `buildDetailExportRows`（收入、支出都为空或 0 的行不拦）；合计行在映射阶段已跳过 | 与无效账单日期的阻断口径一致 |
| T5 | 跨文件汇总：`mapEachCollectingCurrencyBigAccountIssues` 收集各文件的 `CURRENCY_BIG_ACCOUNT_UNMAPPED`，其他错误照常立即抛出 | D1 要求一次列出全部文件 |
| T6 | 导入 catch 中 `CURRENCY_BIG_ACCOUNT_*` 改用 `createDetailedErrorResult`，渲染层用 `alertNative` 弹出 message + detailLines | 执行阶段的 `createErrorResult` 只回 message |
| T7 | 弹窗【保存】只带回草稿，随映射关系管理【完成】落库（A1） | 与【维护大账号】一致，映射与配置同一事务写入 |
| T9 | 本模式的币种识别不做包含式模糊匹配（`resolveCurrencyValue(..., { allowFuzzy: false })`） | spec D4：币种直接决定大账号，模糊认错会把交易记到别的账号 |
| T8 | `saveMappings` 的 `currencyBigAccounts`：传数组时整体替换；未传时只在 MerchantId 不再是本模式时清空 | 只有 `template:save-mappings` 与模板包导入两个调用方会传；其他保存路径不误删 |

## 三、数据模型与迁移

```sql
CREATE TABLE IF NOT EXISTS template_currency_big_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  currency TEXT NOT NULL COLLATE NOCASE,
  merchant_id TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE CASCADE,
  UNIQUE(template_id, currency)
);
CREATE INDEX IF NOT EXISTS template_currency_big_accounts_template_id_idx ON template_currency_big_accounts(template_id);
```

- 迁移 `ensureTemplateCurrencyBigAccountSupport`：启动时在 `ensureTemplateBigAccountNatureSupport` 之后执行，`IF NOT EXISTS` 幂等，不改已有数据。
- 仓储（`template-repository.js`）：
  - `getTemplateCurrencyBigAccounts`；`getTemplateMappings` 带 `currencyBigAccounts`。
  - `saveMappings` 同一事务内删后插（T8），币种存大写。
  - `upsertTemplate` 同名 / 同 key 重导入时清空。
  - `listTemplates` / `getTemplate` 增加 `currencyBigAccountCount`；`buildTemplateSummaryFromRow` 对本模式显示「按币种（N个大账号）」。
  - 删除模板靠外键级联。

## 四、文件清单

| 文件 | 改动 |
| --- | --- |
| `src/backend/file-service/common.js` | 存储值常量 `MERCHANT_ID_CURRENCY_ONLY_MARKER`（唯一定义处） |
| `src/backend/file-service/currency-big-account.js`（新） | 回填、阻断错误、跨文件汇总 |
| `src/backend/file-service.js` | `buildMappedRows` 新参数 `currencyBigAccountMapping`、缺配置拦截、MerchantId 分支对存储值返回空待回填；导出新函数 |
| `src/backend/database/{migrations,template-repository,utils}.js`、`database.js` | 第三节 |
| `src/main.js` | 选项常量；`decodeCustomInputMappingValue` 回显；`validateTemplateConfiguration` + `validateCurrencyBigAccountConfiguration`；`template:get-mappings` / `template:save-mappings`；`buildStatementGenerationConfig` + `buildCurrencyBigAccountMappingConfig`；`buildMappedRowsForFile` 透传；三处跨文件汇总（`buildPendingBigAccountFileEntries`、`rebuildMatchedTemplateFileEntries`、按文件名映射第 3 步）；`classifyCurrencyOnlyEntries` 与混合批次阻断；导入 catch 带详情；模板包 v6 读写 |
| `src/main-process/statement-generation.js` | `buildPreparedStatementBatchFromFilePaths` 跨文件汇总（指定模板导入） |
| `src/renderer.js`、`src/renderer-dialogs.js` | 选项常量传给配置弹窗工厂；导出新弹窗 |
| `src/renderer/dialogs/configuration.js` | 新选项、【映射管理】按钮、`createCurrencyBigAccountMappingDialog`、保存 payload；拆分映射「从主模板导入」跳过 MerchantId 的两种特殊选项 |
| `src/renderer/controllers/statement.js` | `CURRENCY_BIG_ACCOUNT_*` 导入错误弹窗 |
| `src/styles-gemini-extra.css`、`Clear/styles-gemini-extra.css` | `.currency-big-account-card` 样式（覆盖 `.manager-card` 前两列 40% / 30%） |

## 五、接口契约

- **IPC**：`template:get-mappings` 返回 `currencyBigAccounts: [{ currency, merchantId }]`；`template:save-mappings` 接收 `currencyBigAccounts`，校验失败返回 `CURRENCY_BIG_ACCOUNT_INVALID`。
- **错误码**：

| 错误码 | 场景 |
| --- | --- |
| `CURRENCY_BIG_ACCOUNT_INVALID` | 保存校验：Currency 未映射到真实币种列；没有配置；币种 / 大账号为空；币种不在币种映射表；币种重复 |
| `CURRENCY_BIG_ACCOUNT_CONFIG_MISSING` | 生成时模板没有配置，或 `buildMappedRows` 拿到存储值却没有配置 |
| `CURRENCY_BIG_ACCOUNT_UNMAPPED` | 会输出的行币种为空或未维护；`detailLines` 每组「模板「X」文件「a.xlsx」币种「EUR」：第 3、7 行」，最多 20 组、每组最多 10 个行号 |
| `CURRENCY_BIG_ACCOUNT_MIXED_SELECTION` | 按文件名映射导入时本模式文件与需要选择大账号的文件同批 |

- **模板包 v6**：条目带 `currencyBigAccounts`；读取 v≤6，v≤5 读为空数组；旧版应用遇到 v6 整包拒绝。

## 六、渲染层

- `createMappingDialog`：MerchantId 下拉在「自己输入」后加新选项；按钮 `.mapping-currency-big-account-manage-btn`（`secondary-btn small`，文字「映射管理」）由 `syncEditorState` 控制显示；Currency 行保持可见；草稿 `currentCurrencyBigAccounts` 随【完成】提交。
- `createCurrencyBigAccountMappingDialog({ pairs, onDone, onCancel })`：
  - 表格列为【新增】/ 币种 / 大账号 /【删除】，币种输入复用维护大账号的补全（→ 接受建议，失焦转大写）。
  - 【新增】在当前行下方插入；只剩一行时【删除】改为清空。
  - 【保存】忽略整行为空的行，所有校验问题一次弹窗列出；通过后 `onDone`。
  - 【返回】/ × 调 `onCancel` 放弃。

## 七、测试

| 层级 | 文件 | 覆盖 |
| --- | --- | --- |
| 单测 | `tests/unit/backend/file-service/currency-big-account.test.js` | 大小写与中文币种名、字段顺序、阻断明细与零金额 / 合计行、拆分行、缺配置拦截、跨文件汇总、明细限量 |
| 单测 | `tests/unit/backend/database/template-currency-big-accounts.test.js` | 迁移幂等、读写顺序与大写、NOCASE 唯一、切换模式清空、重导入清空、级联删除、模板包条目 |
| 单测 | `tests/unit/main-process/statement-currency-big-account.test.js` | 保存校验各规则（含拆分例外）、存储值往返、生成配置、模板包 v5 / v6 / v7、混合批次识别 |
| 集成 | `scripts/integration/statement-currency-big-account.js` | 第八节场景 ①–⑦ |
| lifecycle | `configuration-dialogs`、`statement-controller` | 选项与按钮显隐、增删行、校验弹窗、保存 / 返回 / ×、提交 payload、布局、导入错误弹窗 |

既有测试只补了注入依赖：`scripts/integration/statement-channel.js`、`tests/unit/main-process/statement-big-account-preview.test.js`。

## 八、风险、兼容与回滚

- 资金影响：配置错误会把交易归到错误账号；每个币种只能对应一个大账号，未维护整批阻断。已做对账专项审查（第十节）。
- 兼容：旧模板与旧模板包不受影响；新模板包 v6 不能导入旧版应用。
- 回滚：回退代码后新表残留但无人读写；用了本模式的模板在旧代码下会因 MerchantId 存储值不是源列而保存 / 生成报错，需改回其他模式。

## 九、实施记录（2026-11-09）

- 统一记录：E09 worker（`session-state.js`，未接入 main）未改，靠 `buildMappedRows` 的缺配置拦截失败即阻断，由单测「拿不到配置时拒绝生成」覆盖，未另写 worker 用例。
- 混合批次判断抽成 `classifyCurrencyOnlyEntries` 以便单测；阻断分支本身在 `handleFilenameMappingImport` 内。
- 指定模板导入在预检阶段不解析文件（大账号选项为 0 时直接预检通过），D1 在执行阶段写文件前触发，返回带详情的错误。
- 布局实测发现 `.manager-card .data-table` 把前两列固定为 40% / 30%，本卡片单独覆盖。

## 十、对账专项审查（2026-11-09，reconciliation-blindspot-pass）

| 等级 | 问题 | 证据 | 处置 |
| --- | --- | --- | --- |
| Important ⚠️ 资金红线 | 币种按“包含”模糊识别后直接决定大账号：`resolveCurrencyValue` 对中文币种名先精确、后包含匹配，只要唯一命中就采用。实测「人民币离岸」→ CNY（实际可能是 CNH）、「美元结算」→ USD；该行会进入 CNY / USD 对应的大账号 | `normalizers.js` `resolveCurrencyValue`；脚本实测 | 已处理（spec D4，2026-11-09 用户决定）：`resolveCurrencyValue` 新增 `allowFuzzy`，本模式传 `false`，模糊命中原样保留并按未维护阻断；其他模式不变。单测覆盖 |
| Important | 纯字母币种不经币种映射表换算：`RMB` 原样保留，而币种映射表没有 `RMB` 代码，【映射管理】也不允许填 `RMB`，这类账单在本模式下永远被阻断（不会错记，但无法使用） | 同上，`RMB` → `RMB` | 已确认不出现（spec D5：币种列只会是代码）；如日后出现再按真实写法评估 |
| 已覆盖 | 零金额行与合计行不阻断、不进余额 | `deriveBalanceRecords` 只收 `effectiveDetailRows`；单测与集成 ③ | — |
| 已覆盖 | 未维护 / 空币种整批阻断、跨文件汇总、不生成文件 | 单测、集成 ③④ | — |
| 已覆盖 | 不经大账号选择窗口、不被渠道兄弟子模板的大账号或所选大账号覆盖；混合批次阻断 | `classifyCurrencyOnlyEntries`、`rebuildMatchedTemplateFileEntries` 只给 MULTI 注入；集成 ⑤ | — |
| ASSUME（A2、A4） | 大账号不经账户映射原样输出；「自己输入」遗留的自有账号仍会进月度余额导出 | spec §5 | 已在 spec 记录 |

人工复核项：真实渠道账单中币种列的写法——已由用户确认（spec D5，2026-11-09）：只会是币种代码（如 USD），D4 不会造成大面积阻断，`RMB` 一类表外写法不会出现。

### 10.1 Codex 审查（2026-11-09，`codex review --uncommitted`）

| 轮次 | 发现 | 处置 |
| --- | --- | --- |
| 1 | [P2] 未维护币种的行号用 `includes` 去重，大文件整列未维护时平方级耗时（实测 50 万行约 18 秒，阻塞主进程） | 每组改用 `Set` 去重；单测「大文件整列币种未维护」20 万行 < 2 秒 |
| 1 | [P2] 跨文件汇总用 `push(...array)`，Currency 误映射到高基数列时分组数超过函数参数上限，`RangeError` 盖掉业务错误 | 新增 `appendCurrencyBigAccountIssues` 逐项合并，`main.js` 与 `mapEachCollectingCurrencyBigAccountIssues` 共用；单测 15 万组 |
| 2 | 无 | — |

## 十一、验证

- D4 补充（2026-11-09）：`currency-big-account.test.js` 新增模糊命中阻断用例、`normalizers.test.js` 新增 `allowFuzzy` 用例，两文件 77/77；复跑 lint、`tests/unit/backend/file-service/*` 与本功能相关单测 210/210，集成 `statement-currency-big-account` 19/19、`statement-generation-pipeline` 45/45、`statement-channel` 124/124、`statement-balance-gap` 24/24。默认（其他模式）的币种识别不变，未重跑全量 release-check。
- 单测：三个新文件 20 个用例通过；`statement-big-account-preview.test.js` 补依赖后 38/38；全量 `npm run test:unit` 修复前 9985/9991（仅 2 个为注入依赖缺失，已修复）。
- 集成：`statement-currency-big-account.js` 19/19，`statement-channel.js` 124/124，`statement-balance-gap.js` 24/24。
- renderer lifecycle：`configuration-dialogs` 91/91，`statement-controller` 13/13。
- `npm run lint`、`npm run check:architecture` 通过。
- `npm run release-check`（2026-11-09）：lint、架构检查、smoke 通过；unit 10007/10011（失败 0）；integration 98/99，唯一失败为 `toolbox-rows-csv-admission` 触发系统内存余量保护（`EXECUTION_SYSTEM_MEMORY_PRESSURE`，与本改动无关），单独重跑 13/13，随后整体重跑 `npm run test:integration` 99/99 通过，并按约定回写 `rules/integration-test-policy.md` 第七章。
- 最终内容复跑 `npm run release-check`（2026-11-09，含 D4 与 Codex 修复）：lint、架构检查、smoke 通过；unit 10011/10015（失败 0）；integration 98/99，唯一失败为 `toolbox-large-split-multi-sheet` 的 RSS 增量预算断言（负载敏感，与本改动无关），单独重跑 31/31。
- 界面截图：`RENDERER_LIFECYCLE_EVIDENCE_DIR=<目录> node scripts/test-renderer-lifecycle.js configuration-dialogs` 输出 `currency-big-account-mapping-row`（映射关系管理中的新选项与【映射管理】按钮）与 `currency-big-account-dialog`（弹窗布局）两张截图，2026-11-09 已人工核对：新增在每行最左侧，保存在返回左侧，币种与大账号各占一半。
- 未做：真实应用 GUI 人工检查（本机开发版启动受 BizOP 资源预检阻断）。币种写法已由用户确认（spec D5）。
