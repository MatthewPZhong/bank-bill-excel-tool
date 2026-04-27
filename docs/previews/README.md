# UI Preview 索引

本目录归档全部前端页面 / modal 截图。所有 png 由 `scripts/render-*.js` 自动生成（启动一次性 Electron + 一次性 user data dir + 触发指定 preview 状态后截屏）。

## 一键重生成全部

```bash
npm run preview:all
```

> 注：`preview:all` 串行调 35 个独立 Electron 窗口，全跑约 3 分钟。如只更新某一张，使用对应的子命令（见下方表格）。

## 全部 35 张图

### 主页面 / 模块首屏（6 张）

| 截图 | 说明 | render 命令 |
|------|------|------|
| ![main-page](main-page.png) | 主页面默认态（v1.5.3 起为「模式」下拉，默认选中「制作网银账单」） | `npm run preview` |
| ![module-switcher-open](module-switcher-open.png) | 顶部模块切换菜单展开态（三选一：网银账单生成 / 新开账户 / 月度 Pending 数据核对） | `npm run preview:module-switcher-open` |
| ![new-account](new-account.png) | 新开账户余额账单模块（默认单行） | `npm run preview:new-account` |
| ![new-account-multi](new-account-multi.png) | 新开账户模块 — 多行模式（3 条不同银行 / 币种） | `npm run preview:new-account-multi` |
| ![new-account-currency-dropdown](new-account-currency-dropdown.png) | 新开账户模块 — 币种下拉展开态 | `npm run preview:new-account-currency-dropdown` |
| ![statement-palette](statement-palette.png) | 制作网银账单模块的背景调色板 | `npm run preview:statement-palette` |

### 模板 / 映射管理（5 张）

| 截图 | 说明 | render 命令 |
|------|------|------|
| ![template-manager](template-manager.png) | 模板管理对话框（含主/子模板、bigAccountSummary 列） | `npm run preview:template-manager` |
| ![template-rename](template-rename.png) | 模板重命名对话框 | `npm run preview:template-rename` |
| ![mapping-dialog](mapping-dialog.png) | 映射关系管理（字段映射主对话框） | `npm run preview:mapping-dialog` |
| ![account-mapping](account-mapping.png) | 账户映射对话框（v1.5.1 起按模板隔离，默认态） | `npm run preview:account` |
| ![account-mapping-editing](account-mapping-editing.png) | 账户映射对话框 — 行编辑态（首行进入 `tr.is-editing`） | `npm run preview:account-mapping-editing` |

### 大账号 / 余额相关（7 张）

| 截图 | 说明 | render 命令 |
|------|------|------|
| ![big-account-manager](big-account-manager.png) | 维护大账号对话框 | `npm run preview:big-account-manager` |
| ![big-account-manager-dropdown](big-account-manager-dropdown.png) | 维护大账号 — 币种下拉展开态 | `npm run preview:big-account-manager-dropdown` |
| ![big-account-selection](big-account-selection.png) | 大账号选择对话框 — 单文件 radio 模式 | `npm run preview:big-account-selection` |
| ![big-account-selection-multi](big-account-selection-multi.png) | 大账号选择对话框 — 多文件 split 双栏模式（v1.5.2） | `npm run preview:big-account-selection-multi` |
| ![extract-order](extract-order.png) | 提取大账号顺序 — 确认大账号顺序对话框（v1.5.0） | `npm run preview:extract-order` |
| ![balance-addon-manager](balance-addon-manager.png) | 余额管理（addon manager）对话框 | `npm run preview:balance-addon-manager` |
| ![manual-balance-seed](manual-balance-seed.png) | 余额种子人工录入对话框 | `npm run preview:manual-balance-seed` |

### 拆分 / 合并账单（3 张）

| 截图 | 说明 | render 命令 |
|------|------|------|
| ![bill-split-rows](bill-split-rows.png) | 账单拆分行配置对话框（v1.4.9） | `npm run preview:bill-split-rows` |
| ![bill-split-mappings](bill-split-mappings.png) | 账单拆分映射关系对话框（v1.4.9） | `npm run preview:bill-split-mappings` |
| ![amount-split-rules](amount-split-rules.png) | 发生额规则管理对话框（按字段区分发生额场景，v1.4.9） | `npm run preview:amount-split-rules` |

### 月度余额 / 导出（2 张）

| 截图 | 说明 | render 命令 |
|------|------|------|
| ![monthly-balance-export](monthly-balance-export.png) | 月度余额账单导出对话框（v1.5.3 R1） | `npm run preview:monthly-balance-export` |
| ![export-scope](export-scope.png) | 导出范围选择对话框（当前批次 / 所有批次） | `npm run preview:export-scope` |

### 提示 / 迁移类（3 张）

| 截图 | 说明 | render 命令 |
|------|------|------|
| ![new-account-palette](new-account-palette.png) | 新开账户模块的背景调色板 | `npm run preview:new-account-palette` |
| ![remember-order-mismatch](remember-order-mismatch.png) | 大账号顺序不匹配提示对话框（v1.5.0） | `npm run preview:remember-order-mismatch` |
| ![account-mapping-migration](account-mapping-migration.png) | 账户映射迁移分配对话框（v1.5.1 升级路径） | `npm run preview:account-mapping-migration` |

### 月度 Pending 数据核对（9 张，v2.0.0 新增）

| 截图 | 说明 | render 命令 |
|------|------|------|
| ![pending-panel](pending-panel.png) | Pending 主面板 — 对账完成态 | `npm run preview:pending-panel` |
| ![pending-panel-initial](pending-panel-initial.png) | Pending 主面板 — 初始态（未设规则 / 未导入） | `npm run preview:pending-panel-initial` |
| ![pending-panel-importing](pending-panel-importing.png) | Pending 主面板 — 导入中态（状态栏实时进度） | `npm run preview:pending-panel-importing` |
| ![pending-panel-error](pending-panel-error.png) | Pending 主面板 — 报错态（可点击导出报错文件，红框） | `npm run preview:pending-panel-error` |
| ![pending-rule-dialog](pending-rule-dialog.png) | 规则管理对话框（对账字段 / 对账内容两列） | `npm run preview:pending-rule-dialog` |
| ![pending-rule-confirm](pending-rule-confirm.png) | 规则确认对话框（字段 / 内容分行展示） | `npm run preview:pending-rule-confirm` |
| ![pending-import-month](pending-import-month.png) | 导入 Pending 文件的年月选择对话框 | `npm run preview:pending-import-month` |
| ![pending-reconcile](pending-reconcile.png) | 开始运行 / 对账月份选择对话框 | `npm run preview:pending-reconcile` |
| ![pending-export-runs](pending-export-runs.png) | 导出差异 run 选择对话框（指定月份 / 所有月份汇总） | `npm run preview:pending-export-runs` |

## 添加新 modal preview 的步骤

1. **renderer-dialogs.js**：确认目标 dialog factory 已 export（通过 `createRendererDialogs` 返回对象）
2. **renderer-previews.js**：
   - 顶部 `deps` 解构里加入新 factory（如 `createMyNewDialog`）
   - 写一个 `applyMyNewDialogPreviewState()` 函数：注入 mock `state` + `openModal(createMyNewDialog(mockPayload))`
   - 在文件末尾 `return { ... }` 里 export 它
3. **renderer.js**：
   - import 段加入新 factory（透传给 `createRendererPreviews`）
   - 调用 `createRendererPreviews({...})` 时把新 factory 传进去
   - 解构 `apply...PreviewState` 后，在 `if (info.previewModal === 'xxx')` 分支链末尾加新 hook
4. **package.json**：
   - 加 `preview:my-new-dialog` 命令：`node scripts/render-modal-preview.js my-new-dialog my-new-dialog.png`
   - 把新命令追加到 `preview:all` 链
5. **本 README.md**：把图加到对应分类表格

## 注意

- 所有 preview 在**临时目录**启动 Electron（`mkdtempSync` → `APP_USER_DATA_DIR` / `APP_DOCUMENTS_DIR`），不污染本机生产数据
- mock payload 含真实数据形态（含中文 / 多币种 / 多模板）以便截图覆盖典型场景
- 资金链路 modal（monthly-balance-export / manual-balance-seed / balance-addon-manager）在 mock 时使用形似真实金额的占位（如 `12345.67`），但**不要使用真实客户数据**
