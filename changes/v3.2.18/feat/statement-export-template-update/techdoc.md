# TechDoc — v3.2.18 网银账单生成：导出交互调整与模板管理【更新】

> status: in-progress
> created: 2026-11-15
> 目标版本：v3.2.18（暂定）
> 适用分支：`feat/statement-export-template-update`
> 分支创建基线：`v3.2.17` 正式标签 → `a7f268f2`
> 依据：[Spec](spec.md)

## 1. 模块与改动

| 文件 | 改动 |
| --- | --- |
| `src/renderer/controllers/statement.js` | `exportDetail` 固定传 `'current'`；`present()` 对 `select-export-scope` 的通用处理保留（余额仍用） |
| `src/renderer/dialogs/configuration.js` | 见下方分项 |
| `src/styles-gemini-extra.css` | 见下方分项 |
| `src/renderer-previews.js`、`docs/previews/README.md` | `preview:export-scope` 改为余额版 |
| `src/main-process/template-header-update.js`（新） | 纯函数模块，见下方分项 |
| `src/backend/database/template-repository.js`、`src/backend/database.js` | `updateTemplateHeaders`：只写 `headers_json`、`source_file_name`、`updated_at`，期望表头不一致报 `TEMPLATE_HEADERS_CHANGED`，模板不存在报 `TEMPLATE_NOT_FOUND`，`WHERE headers_json = <读到的原串>` 防并发 |
| `src/main.js` | 见下方分项 |
| `src/preload.js` | `templates.previewHeaderUpdate(templateId)`、`templates.updateHeaders(payload)` |
| `src/main-process/archive-center/task-policy-registry.js`、`execution-descriptors/legacy-task-policies.js` | 预览：exclude `staging-preflight-only`（与 v3.2.17 `file:import-balance-seed-file` 同类）；确认：support action，reason 为 `statement-template` |
| `architecture/boundaries.json` | `renderer-dialog-configuration.allowedApiFields.api` 增加两个 API，并追加 `policyChanges`（基线 `a7f268f2`） |

**`src/renderer/dialogs/configuration.js`**

- `createExportScopeDialog`：右上角 `.export-scope-close`；底栏改为 `dialog-actions center` 下的普通 `secondary-btn small`；初始焦点保持在「导出当前批次」。
- 新增 `openTemplateMappingEditor`，【修改】与【修改映射关系】共用。
- 模板行首槽 `.manager-row-lead-actions` 放【修改】【更新】，渠道行首槽放【导入子模板】。
- 新增 `createTemplateHeaderUpdateDialog`（字段变更）与 `createTemplateHeaderUpdateResultDialog`（结果）。
- 新增 `ensureStaleFieldOption` 与 `listConcatPanelFields`，用于主映射与拆分映射的失效值显示。

**`src/styles-gemini-extra.css`**

- 删除只被旧范围弹窗使用的 `.dialog-actions.vertical`、`.export-scope-btn*`。
- 范围弹窗新增居中与关闭按钮定位规则。
- 新增 `.template-manager-row-actions` 与 `.manager-row-lead-actions`（首槽定宽 `calc(4em + 32px)`）。
- 新增更新弹窗、结果弹窗样式，以及 `.mapping-select.is-stale`、`.concat-picker-option.is-stale`。
- 颜色全部取变量，深色模式无需单独规则。

**`src/main-process/template-header-update.js`（新）**

- `diffTemplateHeaders`：`identical` 与 `findConflictingTemplateByHeaders` 同口径；`orderChanged` 只比较共同字段的相对顺序。
- `createTemplateHeaderUpdateTools(constants)` 提供：
  - `collectTemplateFieldReferences`
  - `findStaleFieldReferences`
  - `formatFieldReferenceLines`
  - `assertTemplateFieldReferencesAvailable`
- 只依赖 `file-service/common`。

**`src/main.js`**

- 注入 `templateHeaderUpdateTools`。
- 新增函数：
  - `buildTemplateFieldReferenceInput`
  - `collectStaleTemplateFieldReferences`
  - `prepareTemplateHeaderUpdate`
  - `applyTemplateHeaderUpdate`
- 新增 IPC：
  - `template:preview-header-update`：`ipcMain.handle`，选文件后只读预检。
  - `template:update-headers`：`supportIpcHandle`。
- `buildStatementGenerationConfig` 在拆分配置构建之后、字段筛选解析之前调用拦截。

## 2. 流程

```
模板管理（M）
  └─【更新】→ previewHeaderUpdate(id)
       ├ 取消 → 无
       ├ error → push 结果弹窗（仅【返回】）
       └ success → push 字段变更弹窗（D）
            ├【返回】/× → 关闭 D（M 不变）
            └【更新模板】→ updateHeaders({templateId, expectedHeaders, headers, sourceFileName})
                 └ replace D → 结果弹窗（R）
                      ├【返回】→ replace M → 刷新后的模板管理
                      └【修改映射关系】→ getMappings → replace M（含 R）→ 映射关系管理
```

**确认更新时由 renderer 回传表头。** 原因：

- 与 `template:rename`、`template:save-mappings` 的信任模型一致。
- 主进程会全量复核：规范化、非空、模板存在、乐观一致、确有变化、不与其他模板重复。仓储层还会再做一次 `WHERE` 条件校验。
- 不引入需要过期清理的暂存 token。

**防重复提交：**

- 字段变更弹窗用 `createDialogWriteScope` 锁定。
- 同一确认再次提交时，期望表头已与当前表头不一致，会被拒绝（`TEMPLATE_HEADERS_CHANGED`）。

**归档分类：**

- 预览只读文件、不写库，确认才写主库，与「导入余额文件」同类。
- 两个通道均不进入冻结的 G7 TaskPolicy 清单，因此不改 `RESERVE_CHANNELS_BY_SCOPE`、`NO_FILE_ACTION_CHANNELS`、`archive-baseline.json`。

## 3. 生成前拦截

**位置与覆盖范围**

- 位置：`buildStatementGenerationConfig`。
- 所有生产生成路径都经过这里：指定模板、按文件名映射、渠道组、记忆顺序、补录重算、导出所有批次重新生成。
- 拦截发生在读取文件、写出文件、写余额种子之前。

**引用收集口径**（与生成器实际读取一致）

| 引用来源 | 何时计入 |
| --- | --- |
| 主映射（含拼接字段、按正负号拆分的发生额、根据发生额做映射的户名/账户号） | 始终计入 |
| 按字段区分发生额规则 | 开关为「是」且规则完整 |
| 拆分映射 | 拆分/合并开启且不复用主映射 |
| 拆分行 | 拆分/合并开启且行状态为 `completed` |
| 拆分发生额规则、按正负号拆分字段 | 拆分/合并开启 |
| 字段筛选的筛选字段 | 实际生效的映射用到「字段筛选特征值」 |

以下内部标记不算源字段，不计入：`__FIXED__:`、拼接/筛选模式标记、余额「无」「通过发生额计算」、MerchantId「自己输入」「原始账单仅有币种无账户号」及其存储标记、三个开关字段。

**对现有有效模板没有影响：**

- 主映射和拆分映射在保存时已由 `validateTemplateConfiguration` 和 `validateBillSplitMappingsPayload` 校验字段存在。
- 文件匹配要求文件包含模板的完整表头序列，所以生成时可读取的字段等于模板非空表头。
- 其余引用（发生额规则、拆分行/规则、字段筛选）今天在生成时就会报「映射字段不存在」或「筛选字段不存在」。
- 新拦截唯一新增拦下的情况，是「主映射或拆分映射引用表头外字段」。这种情况以前静默输出空值。

**存量数据**

- 绕过保存校验写入的存量数据会被新拦截挡住。
- 已知例子：集成脚本 `statement-channel.js` 的 Step 2 fixture 把 Balance 映射到表头外的 'Balance' 列，已改为映射一个存在的列，该步只校验余额方式不一致。
- 真实库是否有这类数据，登记为 backlog B96。

## 4. 对账盲区扫描

| 维度 | 结论 |
| --- | --- |
| 主键与血缘 | 模板 ID、名称、`template_key`、渠道归属不变，余额种子链、账户映射、渠道输出身份延续；活动日志记录字段变更与失效映射数 |
| 金额/币种 | 不改任何金额、币种口径。此前失效的 Credit/Debit/Balance 映射会静默为空，导致行被过滤或余额错误；现在会在生成前拦下 |
| 时间边界 | 不涉及 |
| 幂等/重复 | 乐观表头校验加弹窗锁，重复提交被拒；用同一文件再次【更新】会提示字段无变化 |
| 部分失败 | 写库只有一条 UPDATE；模板库文件同步失败按现有 `syncTemplateLibraryFile` 处理（与重命名一致） |
| 行数守恒 | 拦截只阻止生成，不产生部分输出 |
| 残余风险（人工复核） | 列名不变但含义改变无法识别；模板包里带失效映射的模板在导入端被跳过；存量越界映射会被新拦截挡住（B96） |

## 5. 兼容与回滚

- **数据**：无迁移，存储格式不变。
- **回滚**：
  - 用旧模板文件再执行一次【更新】，即可恢复旧表头，映射不受影响。
  - 回退到旧版本后，失效映射会恢复为静默输出空值（旧行为）。
- **模板包**：导出格式不变；更新后的表头随模板包导出。

## 6. 验证

**单元测试**

- `tests/unit/main-process/template-header-update.test.js`：diff、引用收集与启用口径、格式化、拦截。
- `tests/unit/backend/database/template-header-update.test.js`：逐表深比较，确认只有 3 列变化；拒绝场景。
- `archive-task-policy-registry`、`execution-descriptor-archive-baseline` 计数与登记断言。

**集成测试**

- `scripts/integration/statement-template-update.js`（新）：预览 → 拒绝 → 确认 → 拦截 → 修改映射后生成 → 回读导出 → 旧格式文件不再匹配。
- `statement-feature-filter.js`、`statement-channel.js`、`statement-currency-big-account.js`：harness 注入 `templateHeaderUpdateTools`。

**渲染生命周期**

- `statement-controller.js`：
  - 导出明细固定 `current` 且不弹范围。
  - 余额范围 current/all。
  - × 空闲可关、导出中被拦。
  - 生产样式版式（亮/暗）。
- `configuration-dialogs.js`：
  - 按钮顺序与【重命名】对齐（100%、125%、150%）。150% 时【删除】换行（改动前渠道行同样会换行），【重命名】仍对齐。
  - 更新流程各分支、忙碌锁与迟到结果。
  - 失效映射显示，以及保存时提交原值。

**门禁**：`npm run release-check`，结果见实施记录或 PR。

**人工验收**：真机 GUI 验收登记为 backlog B95。
