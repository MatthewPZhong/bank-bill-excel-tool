# TechDoc — 映射字段「字段筛选特征值」

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.16（暂定） |
| 功能分支 | `feat/mapping-feature-filter`，基于正式标签 `v3.2.15`（`5b5caf7b`） |
| 日期 | 2026-11-09 |
| 状态 | 已实现，待 PR 审查与 GUI 人工检查 |
| 依据 | [spec.md](spec.md) D1–D6 |
| 格式来源 | `changes/v3.2.16/feat/statement-balance-verification/techdoc.md` 的章节组织（按本任务规模精简） |

以符号名为准，行号会随后续提交变化。

## 一、目标与范围

新增映射值「字段筛选特征值」：按模板级规则从一个源字段拆段取第一个命中片段，赋给选该值的目标字段。覆盖主映射弹窗、拆分/合并映射弹窗、保存校验、模板包、生成与导入提示。

## 二、技术决策

| 编号 | 决策 | 原因 |
| --- | --- | --- |
| T1 | 规则存模板级一列 `templates.feature_filter_json`（JSON，`''` 为未设置），不放在映射行 | D4 一个模板一套；`mapped_fields_json` 只接受字符串数组（`parseJsonArray`），塞对象会被读成 `[]` |
| T2 | 映射行存 `mapped_field = '字段筛选特征值'`、`mapped_fields_json = '[]'`，不带源字段 | 未识别该值的旧代码（旧版导入模板包）会因“映射字段不存在”失败关闭，而不是退化成整列直取 |
| T3 | 生成 lookup（`buildMappedFieldLookup`）把该值转为内部 token `__FEATURE_FILTER__`（`file-service/common.js`），`buildMappedRows` 在 `resolveMappedPartsByTokens` 中按 token 取当行特征值 | 与 `__FIXED__:` 同一机制；所有目标字段的后续规范化自动沿用；不与真实表头重名 |
| T4 | 匹配纯函数集中在 `src/backend/file-service/feature-filter.js`（`normalizeFeatureFilterRule`、`extractFeatureValue`），主进程保存校验与生成共用；渲染端 `configuration.js` 保留同口径的样例校验与推导 | 渲染端不能 require 后端模块；后端为准，保存时再次校验 |
| T5 | 分隔符存键名（`space`/`slash`/`comma`/`dot`/`backslash`/`''`） | 空格字符经 `normalizeCell` 会被裁掉 |
| T6 | 每行在循环开头算一次特征值；未命中提示只在会进入明细的行记录（非拆分：`hasCreditAmount || hasDebitAmount`；拆分：合并后任一展开行有金额），合计行沿用既有回滚 | 避免与“收支均为 0 或空值”过滤提示重复；多文件合并时不靠行号去重 |
| T7 | 保存时：有字段使用 → 规则必须有效；未使用 → 有效规则照存、无效忽略。仓储 `featureFilter` 为对象才写入，`undefined/null` 不动该列 | 便于再次选用；避免未使用时的残缺草稿阻断保存 |
| T8 | 拆分/合并映射保存（`template:save-bill-split-mappings`）载荷带 `featureFilter`，用到时校验（缺省回落已存规则）并与拆分映射同一事务写入 | D4 共用一套；该弹窗即时写库，不能依赖主弹窗稍后保存 |
| T9 | 不新增 `desktopApi` 方法；模板包按需升版：任一模板主映射或拆分映射用到该值时写 v6（`resolveTemplateBundleVersion`，`SUPPORTED_BUNDLE_VERSION = 6`），否则写 `BASE_BUNDLE_VERSION = 5` | 避开 `architecture/boundaries.json` 白名单放宽；旧版不校验拆分映射，只靠 T2 时“只在拆分映射中用到”的包会被旧版静默导入，按版本号整包拒绝才能失败关闭；未用到时不影响旧版导入 |
| T10 | `upsertTemplate` 覆盖表头、清空映射时一并清空规则 | 规则引用的源字段可能已不存在 |
| T11 | “是否使用”只看实际生效的映射：拆分/合并且不复用时看拆分映射，否则看主映射（`resolveStatementFeatureFilter` 与 `buildMappedRows` 同口径）；保存主映射与导入模板包时，不复用的拆分映射（已存或包内）用到该值也要求规则有效 | 主映射残留该值不应误报未命中；只在拆分映射中用到时也要在保存时拦住缺规则，而不是到生成才失败 |

## 三、数据流

```
映射弹窗 / 拆分映射弹窗 ──featureFilter──► template:save-mappings / save-bill-split-mappings
  └ createFeatureFilterDialog（样例推导、客户端校验）        │ validateTemplateConfiguration / validateBillSplitMappingsPayload
                                                              │ normalizeFeatureFilterRule(rule, { headers })
                                                              ▼
                                         templates.feature_filter_json（同事务）
                                                              │ getTemplate → buildTemplateSummaryFromRow.featureFilter
                                                              ▼
buildStatementGenerationConfig ─ resolveStatementFeatureFilter（用到 token 时必须有效）─► config.featureFilter
  └ buildMappedRowsForFile ─► buildMappedRows({ featureFilter })
        每行 extractFeatureValue(源列, rule) → token 取值 → 各字段既有规范化
        未命中 → issues: { type: 'feature-value-unmatched', rowNumber, sourceField, rawValue }
  └ buildImportWarningDetailLines / buildImportWarningMessage → 导入提示与报错文件
```

模板包：`listTemplateBundleEntries` 导出 `featureFilter` → `readTemplateBundleFile` 透传 → `template:import-bundle` 校验后随 `saveMappings` 写入。

## 四、改动文件

| 文件 | 改动 |
| --- | --- |
| `src/backend/file-service/feature-filter.js`（新） | 规则规范化/校验、拆段、匹配、取值 |
| `src/backend/file-service/common.js`、`src/backend/file-service.js` | token 常量；`buildMappedRows` 新入参 `featureFilter`、逐行取值与未命中提示；门面导出 |
| `src/backend/database/migrations.js`、`src/backend/database.js` | `ensureTemplateFeatureFilterSupport` 幂等补列；`saveBillSplitMappings` 透传 options |
| `src/backend/database/template-repository.js`、`utils.js` | 读出 `featureFilter`；`saveMappings` / `saveBillSplitMappings` 同事务写入；`upsertTemplate` 清空；模板包导出 |
| `src/main.js` | 常量 `FEATURE_FILTER_MAPPING_FIELD`；保存校验、两个保存 IPC、模板包读写、`buildTemplateSummary`、lookup、`resolveStatementFeatureFilter`、导入提示 |
| `src/renderer.js`、`src/renderer-dialogs.js`、`src/renderer/dialogs/configuration.js` | 常量接线；两个映射弹窗的选项与【筛选条件】；`createFeatureFilterDialog`；保存前检查与载荷 |
| `src/styles-gemini-extra.css` | `.feature-filter-*` 弹窗布局 |
| 测试与文档 | 新增单测、集成脚本与生命周期用例（见第五节）；`statement-channel.js` 脚手架补依赖；`docs/USER_GUIDE.md` 问答；`rules/important-variables.md` 登记 |

未改：`transformFileToWorkbook`（旧导出路径，按源字段→目标字段映射，不产生该 token，主进程无调用方）；statement worker 合同（未接入生产，模板对象 key 未变）。

## 五、测试

| 层级 | 位置 | 覆盖 |
| --- | --- | --- |
| 单测 | `tests/unit/backend/file-service/feature-filter.test.js` | 五种分隔符与不拆分、连续/全角空白、首个命中、未命中、单项与组合条件、数值单元格、规则校验各错误、样例不符/含分隔符 |
| 集成 | `scripts/integration/statement-feature-filter.js`（41 项） | ① 旧库补列与重复启动；② 保存→读回→生成→回读导出，提示与报错文件；③ 缺规则、字段不存在、非法目标、直接写库缺规则生成被拒；④ 模板包往返、覆盖表头清空、按需 v6 与旧版拒绝；⑤ 拆分/合并「不复用」路径、缺规则保存被拒、主映射残留不误报 |
| 渲染生命周期 | `scripts/renderer-lifecycle/fixtures/configuration-dialogs.js`（新增 4 例） | 选项位置与范围、按钮显隐、无规则阻止保存、样例推导、保存载荷、弹窗校验与回显、拆分弹窗共用规则与回传、最小窗口布局与截图证据 |

fixture 的 `setup` 补传 `CONCAT_FIELDS_MAPPING_FIELD`、`FEATURE_FILTER_MAPPING_FIELD`（此前未传，拼接选项值为 `undefined`；不影响既有用例）。

`scripts/integration/statement-channel.js` 按名加载 `buildStatementGenerationConfig` 等 main.js 函数，脚手架补注入 `FEATURE_FILTER_MAPPING_FIELD`、`FEATURE_FILTER_FIELD_TOKEN`、`normalizeFeatureFilterRule` 并加载 `resolveStatementFeatureFilter`（否则 `ReferenceError`）；用例本身不变。

## 六、兼容与回滚

- 迁移只加列（默认 `''`），启动幂等；回滚到旧版本后多出的列被忽略。
- 旧版本读取含该值的模板：映射值当作源字段名，生成时该列为空、保存报“映射字段不存在”；不会把整列原文误填。
- 模板包：用到该值的包为 v6，旧版本整包拒绝并提示升级；未用到的包仍为 v5，新旧版本互通。
- 回滚即回退本分支提交。

## 七、实施记录

- 2026-11-09 本地验证：
  - `npm run release-check`：lint、架构检查、smoke 通过；单测 9995/10000 通过，1 例 `biz-op-v327-low-memory.test.js` 报 `EXECUTION_SYSTEM_MEMORY_PRESSURE`（本机可用内存不足），单独重跑 4/4 通过；同一代码此前一次全量单测 0 失败。门禁因此在单测处中断，集成测试另行补跑。
  - `npm run test:integration` 首轮 3 个失败：`statement-channel`（脚手架缺新依赖，已补，124/124）；`production-memory-qualification`、`publication-legacy-concurrency`（内存紧张时的环境波动，单独重跑 9/9、2/2）。修复后完整重跑 99/99 通过，`rules/integration-test-policy.md` §七由 runner 回写。
  - 渲染生命周期 `configuration-dialogs.js` 91/91；布局证据截图 `feature-filter-mapping-row`、`feature-filter-dialog` 已人工查看（按钮在下拉框右侧同一行，弹窗在最小窗口内完整）。
  - 未做：真实应用 GUI 人工检查（本机开发版启动受 BizOP 资源预检阻断，沿用 lifecycle 截图替代）。
- 对账专项自查：只新增可选映射模式，不改金额/币种/余额口径、行数与幂等；存量模板输出不变。
- 2026-11-09 Codex 第一轮审查（`codex review --base main`）3 条 P2，均已核实并修复：
  1. 只在拆分映射中用到该值的模板包仍为 v5，旧版会静默导入并输出空值 → 按需写 v6（T9）。
  2. 保存主映射只校验主映射，不复用的拆分映射用到该值而缺规则时能保存、到生成才失败 → 保存与模板包导入一并校验（T11）。
  3. 不复用时主映射残留该值仍会记未命中提示 → 只看实际生效的映射（T11）。
  集成脚本补对应用例（41 项）。
