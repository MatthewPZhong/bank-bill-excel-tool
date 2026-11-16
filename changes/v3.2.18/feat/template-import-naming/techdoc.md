# TechDoc — v3.2.18 【导入模板】命名弹框与余额管理账户号 / 币种筛选

> status: in-progress
> created: 2026-11-16
> 目标版本：v3.2.18（暂定）
> 适用分支：`feat/template-import-naming`（基线 `v3.2.17` → `a7f268f2`）
> 依据：[spec](spec.md)

## 1. 【导入模板】调用链

```
renderer statement.js handleImportTemplate
  └─ templates.prepareImport()        → template:prepare-import（ipcMain.handle，只读预检）
        showImportOpenDialog → extractHeaders → findConflictingTemplateByHeaders(headers, null)
        → pendingTemplateImports.register({ ownerId: event.sender.id, filePath, sourceFileName, headers })
        ← { status: 'ready', importToken, sourceFileName } | 原有错误结果 | { status: 'cancelled' }
  └─ createTemplateImportNameDialog（configuration.js）
        确认 → templates.importTemplate({ importToken, bankName, region })
              → template:import（trackedIpcHandle，归档登记不变）
                 prepare: resolveOrdinaryTemplateImport —— peek token（按发送方窗口）、
                          normalizeTemplateImportName（D1）、findTemplateImportNameConflict（D2，模板 + 渠道，忽略大小写）；
                          不通过 → { proceed: false, result }（不预留归档批次，token 保留）
                          通过 → eager FilePlan（输入为登记的文件）
                 execute: importOrdinaryTemplate —— 复核 token / 名称 / 重名 → consume token →
                          重读表头须与预检一致（TEMPLATE_IMPORT_FILE_CHANGED）→ 复核表头重复 →
                          upsertTemplate（已保证不重名，只会新建）→ 同步模板库文件、活动日志
        取消 / × / 弹框被关闭（onDispose）/ 非名称类失败 → templates.discardImport(token) → template:discard-import
```

- **带 `channelId` 的【导入子模板】**：prepare 仍弹文件框，execute 仍走 `importStatementChildTemplate`，不变。
- **没有 token 的普通导入**：直接拒绝（`TEMPLATE_IMPORT_EXPIRED`），不再按文件名建模板。
- **名称类错误码**：`TEMPLATE_IMPORT_NAME_INVALID`、`TEMPLATE_NAME_DUPLICATED`、`TEMPLATE_NAME_CHANNEL_CONFLICT`。
  - 它们在 prepare 阶段经 `createPreflightErrorResult` 返回，带 `errorCode`，渲染层据此保留弹框。
  - execute 阶段的复核只防并发，返回的错误结果没有 `errorCode`，按其他失败关闭弹框。
- **待确认文件登记**（`createPendingTemplateImportStore`）：
  - 每个窗口只保留一个，再次预检会替换旧的。
  - 30 分钟超时作废，不跨重启。
  - 渲染层只拿到 token，不回传路径。

## 2. 余额管理

- **排序**：`balance-seed-management.js` `compareForDisplay` 改为日期降序 → 账户号 → 币种。渲染层不再排序，也不改变顺序。
- **筛选**：`createBalanceSeedManagerDialog` 新增 `state.accountFilter / currencyFilter / accountQuery`。
  - `visibleRecords()` 为分页、条数和空行提示的统一来源。
  - `reconcileFilters()` 在每次读取成功后复位已不存在的筛选值。读取失败时清空筛选。
- **账户号浮层**：沿用大账号弹窗的 `new-account-currency-dropdown-panel` 与 fixed 定位写法，挂在 overlay 上。
  - 以下情况关闭浮层：点击面板外（overlay `mousedown`）、Esc（document 捕获阶段，只关面板）、表格滚动、切换渠道、弹窗销毁。
- **样式**（`styles-gemini-extra.css`）：
  - 余额管理头部允许换行，× 绝对定位在右上角。150% 缩放时账户号 / 币种换到第二行。
  - 账户号按钮宽 260px，可缩到 140px，箭头与渠道下拉相同。

## 3. 接口与登记

| 位置 | 变更 |
| --- | --- |
| `src/main-process/template-import-naming.js` | 新增：`normalizeTemplateImportName`、`findTemplateImportNameConflict`、`createPendingTemplateImportStore` |
| `src/main.js` | 新增 `template:prepare-import`、`template:discard-import`；`template:import` 普通导入改为 token + 命名；新增 helper `templateImportOwnerId`、`prepareOrdinaryTemplateImport`、`checkOrdinaryTemplateImportName`、`resolveOrdinaryTemplateImport`、`importOrdinaryTemplate` 等 |
| `src/preload.js` | `templates.prepareImport`、`templates.discardImport`；`importTemplate(payload)` |
| TaskPolicy | `archive-center/task-policy-registry.js` 与 `execution-descriptors/legacy-task-policies.js`：两个新通道为 exclude `staging-preflight-only` |
| `architecture/boundaries.json` | `renderer-statement` 的 api 增加 `templates.prepareImport / discardImport`，ui 增加 `createTemplateImportNameDialog`；`renderer-dialog-configuration` 整域接收 `templates`，api 同步增加两项；各追加一条 `policyChanges`（源 `a7f268f2`） |
| 渲染装配 | `configuration.js` 导出 → `renderer-dialogs.js` → `renderer.js` 传给 statement controller |

## 4. 测试

| 层 | 文件 | 覆盖 |
| --- | --- | --- |
| 单测 | `tests/unit/main-process/template-import-naming.test.js` | 大写、空格、非法字符与全角、模板 / 渠道重名、登记的归属 / 替换 / consume / 超时 |
| 单测 | `tests/unit/main-process/balance-seed-management.test.js` | 新增日期降序、同日按账户号与币种排列；原用例标题改为按日期降序 |
| 单测 | `archive-task-policy-registry.test.js`、`execution-descriptor-archive-baseline.test.js` | 通道数与 exclude 清单 |
| 集成 | `scripts/integration/statement-template-import-naming.js` | 真实主库与 xlsx，7 个场景（见脚本头注释） |
| 集成 | `scripts/integration/balance-seed-management.js` | ⑤ 的期望顺序改为日期降序 |
| 归档夹具 | `tests/fixtures/archive-permanent-delete-owner-recovery.js` | prepare 以 `importToken` 调用，注入 `resolveOrdinaryTemplateImport` 桩，仍形成 eager FilePlan |
| 渲染生命周期 | `statement-controller` | 取消、预检报错、命名弹框（按钮顺序与蓝色、输入过滤与输入法组合）、重名保留、成功刷新、取消 / × / 失败时丢弃、Enter 提交 |
| 渲染生命周期 | `configuration-dialogs` | 命名弹框 100% / 150% 版式；余额管理头部顺序与默认空白、部分搜索、「全部」复位、币种联动、Esc 与面板外点击、Enter 选第一项、切换渠道清空、写入后保留或复位、筛选后分页；头部 100% 一行、150% 不溢出 |

## 5. 实施记录

- 对账专项审查（轻量）：
  - 余额管理只改显示顺序与渲染层筛选，种子的读写、可见范围与写入核对不变。
  - 导入命名只影响新建模板的名称。名称的银行段与所在地段决定种子文件、余额附加值、Channel 列与余额账单的银行名称和所在地。D1 禁止「-」，保证两段切分正确。已有模板不迁移。
  - 原来同名导入会覆盖并清空映射，D2 起不再覆盖。
- 已知限制：同一银行 + 地区要分开输出的多个模板（如 `METACOMP-SG-OSA`），导入时无法直接输入后缀，需先用不重名的名称导入、再【重命名】（用户手册已写明）。
- 验证结果见交付说明；实机 GUI 验收登记 backlog B98。
