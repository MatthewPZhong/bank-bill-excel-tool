# TechDoc — 映射字段「字段筛选特征值」多特征值与「特征值管理」

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.18（暂定） |
| 功能分支 | `feat/mapping-feature-values`，基于正式标签 `v3.2.17`（`a7f268f2`） |
| 日期 | 2026-11-16 |
| 状态 | 已实现，待 PR 审查与 GUI 人工检查 |
| 依据 | [spec.md](spec.md) D1–D8；v3.2.16 [TechDoc](../../../v3.2.16/feat/mapping-feature-filter/techdoc.md) |
| 格式来源 | `changes/v3.2.16/feat/mapping-feature-filter/techdoc.md` |

以符号名为准，行号会随后续提交变化。

## 一、目标与范围

把 v3.2.16 的“一个模板一套筛选规则”改为“一个模板多个具名特征值，映射行各选一个”；原「筛选特征值」弹窗改为「特征值管理」（新增、选中修改、删除，保存与删除即时落库）。匹配口径（拆段、首个命中、条件组合）不变。

## 二、技术决策

| 编号 | 决策 | 原因 |
| --- | --- | --- |
| T1 | 沿用 `templates.feature_filter_json`，改存数组 `[{ id, name, sourceField, separator, length, letterPrefixCount, digitsOnly, sample }]`；`''` 为无 | 回滚到 v3.2.17 时旧版 `parseJsonObject` 读数组得 null，用到该值即“尚未设置筛选条件”失败关闭；新增列会让旧版静默使用陈旧单规则 |
| T2 | 映射行仍存 `mapped_field='字段筛选特征值'`，所选特征值 id 存 `mapped_fields_json[0]`；映射表不改结构 | `parseJsonArray` 只接受字符串数组，id 用字符串即可；v3.2.17 对该映射值忽略 mappedFields |
| T3 | id 由后端分配：已有与列表内最大数字 id + 1；改名不变 id | 引用稳定；删除后再新增不复用更小的 id |
| T4 | `ensureTemplateFeatureFilterSupport` 补列后调用 `upgradeLegacyTemplateFeatureFilters`：仍是对象的规则按模板单事务改写为 `[{ id:'1', name:'特征值1', ...rule }]`，主映射与拆分映射中该映射值且引用为空的行写 `["1"]` | spec §3.5；只处理对象形状，幂等；迁移不依赖 file-service，口径与 `upgradeLegacyFeatureFilter` 一致 |
| T5 | 新 IPC `template:save-feature-filters`（preload `templates.saveFeatureFilters`）整表替换；`validateFeatureFiltersPayload` 逐条校验名称与条件、已有 id 须存在、分配新 id；被删掉的特征值若仍被已保存的主映射或拆分映射引用（`listTemplateFeatureFilterReferences`）则拒绝并列出字段 | spec D5、D7；删除与保存共用一个入口，后端是“引用不悬空”的最终防线 |
| T6 | 该通道登记为 `support-action`（reason `statement-template-feature-filter`），用 `supportIpcHandle` 注册 | 与 v3.2.15 `channel:rename`、v3.2.16 `balance-seed:update` 同类：仅主库写入、无文件，不进入冻结的 G7 TaskPolicy 清单 |
| T7 | 架构边界 `renderer-dialog-configuration.allowedApiFields.api` 增加 `templates.saveFeatureFilters`，`policyChanges` 绑定 sourceCommit `a7f268f2`、sourcePolicyBlob `1ff406df` | 增加方法不会自动获准；release 合入时如有其他分支提交仍持原集合，按 v3.2.17 先例补登 |
| T8 | `template:save-mappings`、`template:save-bill-split-mappings` 不再携带或写入规则，按库中 `template.featureFilters` 校验生效映射的选择（`resolveUsedFeatureFilters`：未选、不存在、条件无效均拒绝）；删除 `resolveSavedFeatureFilter` | 特征值已即时落库，映射只保存引用；“只看实际生效映射”沿用 v3.2.16 T11 |
| T9 | lookup token 改为 `__FEATURE_FILTER__:<id>`；`resolveStatementFeatureFilters` 返回 `{ id → { id, name, ...rule } }`；`buildMappedRows` 每行按用到的特征值各算一次，BillDate 合计行识别取 BillDate 所选特征值的源单元格；未命中每行一条 issue，`misses[{ featureName, sourceField, rawValue }]` | 多特征值；保留 v3.2.16 T12 资金红线修复；导入提示仍按行计 |
| T10 | 模板包导出 `featureFilters`；用到该值写 v7（`SUPPORTED_BUNDLE_VERSION = 7`），只用到「原始账单仅有币种无账户号」写 `CURRENCY_ONLY_BUNDLE_VERSION = 6`，否则 v5；读 v≤6 包时 `upgradeLegacyFeatureFilter` + `upgradeLegacyBundleFeatureFilterRefs` 按 T4 口径升级；导入时 `normalizeFeatureFilterList`（保留包内 id）后随 `saveMappings({ featureFilters })` 同事务写入 | v3.2.16/3.2.17 读 v7 整包拒绝；旧包可直接导入 |
| T11 | `normalizeMappingRows`、`normalizeExportMappingRows` 先识别该映射值，避免把 id 当成源字段；`validateBillSplitMappingsPayload` 只保留 mappedFields 第一项 | 这些路径原本把 mappedFields 当源字段 |
| T12 | 渲染端：映射行新增「选择特征值」文本与下拉（class `mapping-select mapping-feature-value-select`，排在映射字段下拉之后，`querySelector('.mapping-select')` 仍取到映射字段下拉）；`createFeatureFilterManagerDialog` 取代 `createFeatureFilterDialog`，删除前用 `getUsage` 查主映射草稿与拆分映射（拆分弹窗另合并主映射草稿）；拆分弹窗经 `onFeatureFiltersChange` 回写主映射弹窗列表 | spec D1–D6；“被使用”包含未保存草稿，后端再按已保存映射兜底 |

## 三、数据流

```
映射行「选择特征值」 ── mappedFields:[id] ──► template:save-mappings / save-bill-split-mappings
                                               │ validateTemplateConfiguration / collectFeatureFilterRefs
                                               │ resolveUsedFeatureFilters(template.featureFilters, refs)
【特征值管理】保存 / 确认删除 ── featureFilters ──► template:save-feature-filters（support-action）
                                               │ validateFeatureFiltersPayload：normalizeFeatureFilterList + 引用守卫
                                               ▼
                         templates.feature_filter_json（数组）；映射 mapped_fields_json = ["<id>"]
                                               │ getTemplate → buildTemplateSummaryFromRow.featureFilters
                                               ▼
buildStatementGenerationConfig ─ resolveStatementFeatureFilters ─► config.featureFilters
  └ buildMappedRows({ featureFilters })：每行按 id 取值 → token `__FEATURE_FILTER__:<id>` → 各字段既有规范化
        未命中 → { type: 'feature-value-unmatched', rowNumber, misses[] }
```

## 四、改动文件

| 文件 | 改动 |
| --- | --- |
| `src/backend/file-service/feature-filter.js`、`common.js`、`file-service.js` | 列表规范化、旧规则升级、引用/token 工具、按生效映射取规则；`buildMappedRows` 多特征值；token 前缀 |
| `src/backend/database/migrations.js`、`utils.js`、`template-repository.js`、`database.js` | 旧规则升级迁移；读数组；`saveTemplateFeatureFilters`、`listTemplateFeatureFilterReferences`；`saveMappings` 的 `featureFilters`（仅模板包导入）；模板包导出 |
| `src/main.js` | 常量与模板包版本；`validateFeatureFiltersPayload`、`collectFeatureFilterRefs`、`resolveStatementFeatureFilters`、`upgradeLegacyBundleFeatureFilterRefs`；保存校验、两个保存 IPC、新 IPC、导入提示 |
| `src/preload.js`、`architecture/boundaries.json`、`src/main-process/archive-center/task-policy-registry.js` | 新 API、白名单与 policyChanges、support-action 登记 |
| `src/renderer/dialogs/configuration.js`、`src/styles-gemini-extra.css` | 映射行与特征值管理弹窗、拆分弹窗同步、样式 |
| 测试与文档 | 见第五节；`docs/USER_GUIDE.md` 问答；`rules/important-variables.md` 登记 |

## 五、测试

| 层级 | 位置 | 覆盖 |
| --- | --- | --- |
| 单测 | `tests/unit/backend/file-service/feature-filter.test.js` | 原匹配用例；列表 id 分配/保留、名称校验、未知 id、条件错误带名称；旧规则升级；引用与 token；按生效映射取规则 |
| 单测 | `archive-task-policy-registry.test.js`、`execution-descriptor-archive-baseline.test.js` | support-action 登记与计数 |
| 单测 | `statement-currency-big-account.test.js` | 模板包版本常量（7 / 6）与注入依赖 |
| 集成 | `scripts/integration/statement-feature-filter.js`（65 项） | ① 旧库补列与单套规则升级、重复启动幂等、升级后输出口径；② 两个特征值分别取值、提示与报错文件、回读导出；③ 保存载荷 id/改名/校验/删除守卫；④ 未选、不存在、非法目标、直接写库引用缺失生成被拒；⑤ 模板包 v7 往返、旧版拒绝、v6 包升级导入、覆盖表头清空；⑥ 拆分不复用路径与残留；⑦ BillDate 合计行资金红线 |
| 集成 | `statement-channel.js`、`statement-currency-big-account.js` | 脚手架注入名同步（用例不变） |
| 渲染生命周期 | `scripts/renderer-lifecycle/fixtures/configuration-dialogs.js`（特征值相关 7 例） | 行内文本/下拉/按钮显隐与默认空白、未选不保存与载荷；弹窗工具栏与字段顺序、新增推导保存与行刷新、按钮顺序；选中回显改名、校验、保存失败、取消；删除未选/被用/确认/失败重试；拆分残留口径；拆分弹窗共用列表与回写、切换拼接不混入 id；最小窗口布局截图 |

## 六、兼容与回滚

- 迁移只改仍是对象形状的规则与其空引用，启动幂等；回滚到 v3.2.17 时数组被读为“未设置”，用到该值的模板保存与生成失败关闭，不会用旧条件静默输出。
- 模板包：用到该值的包为 v7，v3.2.16/3.2.17 整包拒绝；v6 包在新版本可导入并升级；未用到时仍写 v5 / v6。
- 回滚即回退本分支提交；已升级的库回到旧版后需重新设置筛选条件（旧版提示“尚未设置筛选条件”）。

## 七、实施记录

- 2026-11-16 本地验证：
  - `npm run release-check` 首轮在单测中断：`statement-merged-header-summary-row.test.js` 按名加载 `readTemplateBundleFile` 的脚手架缺新依赖 `upgradeLegacyBundleFeatureFilterRefs`（ReferenceError），补注入后 11/11。
  - 复跑 `npm run release-check` 通过（EXIT=0）：lint、架构检查（对比 `a7f268f2`）、smoke 通过；单测 10225/10229（0 失败）；集成 106 个脚本 3743/3743，`rules/integration-test-policy.md` §七由 runner 回写。
  - `statement-feature-filter.js` 65/65；渲染生命周期 `configuration-dialogs` 127/127；布局证据 `feature-filter-mapping-row`、`feature-filter-dialog` 已人工查看（行内顺序为映射字段下拉 →「选择特征值」→ 特征值下拉 →【特征值管理】；弹窗工具栏在标题右侧，设置区按 D3 顺序，【保存】在【取消】左侧，最小窗口内完整可见）。
- 对账专项自查：不改金额/币种/余额口径与行数；存量模板经迁移后两字段仍取同一特征值（集成 ①）；BillDate 合计行识别改为取所选特征值的源单元格，回归 ⑦ 保持“合计金额不作为交易导出”，**须人工复核**。
- 未做：真实应用 GUI 人工检查（本机开发版启动受 BizOP 资源预检阻断，沿用 lifecycle 截图替代）。
