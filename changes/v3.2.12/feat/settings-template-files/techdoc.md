# TechDoc — 设置 · 模板文件（前端接入与只读接口）

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.2.12（合入 `release/v3.2.12`） |
| 功能分支 | `feat/settings-template-files`，基于 `origin/main` `52b92b55`（v3.2.11） |
| 日期 | 2026-10-07 |
| 状态 | 前端页面与只读接口已实现，功能分支 `release-check` 通过；版本存储、导入预检、启用与删除待后端阶段 |
| 依据 | 用户确认的模板文件管理设计讨论与前端原型 `tmp/settings-template-files.html`（不入库）；本文件只记录本分支实际落地的范围与契约 |
| 格式来源 | `changes/v3.2.11/v3.2.11-settings-defaults/techdoc.md` 的章节组织 |

## 一、目标与范围

在设置弹窗新增「模板文件」页，集中查看随应用打包的 Excel 模板：按名称/字段搜索，按模块、类型、状态筛选，查看字段（或枚举值）、版本、使用方与文件信息，并可另存为原文件。

本分支范围：

- Renderer：新页面、导入/确认/未纳入清单等子弹窗，按 Main 返回的能力决定按钮状态。
- Main：模板清单、只读查询（列表、详情）和另存为。
- 不包含：用户版本存储、导入预检、启用/恢复默认/删除版本、变更记录、各模块改读当前版本。这些属于后端阶段；在此之前「导入新版本」等操作按能力置灰并显示原因，不伪造成功。

## 二、文件清单

| 文件 | 内容 |
| --- | --- |
| `src/main-process/template-resources/catalog.js` | 39 个纳管模板与 3 个未纳入文件的清单：类型、读取方式、使用方、目标设计中的可替换性、缓存/失败/生效说明 |
| `src/main-process/template-resources/service.js` | 读取文件、解析 Sheet/表头/枚举、SHA-256、列表与详情结构、另存为写出 |
| `src/main.js` | `registerTemplateResourceHandlers`：两个只读 IPC 与一个 support action |
| `src/preload.js` | `desktopApi.templateResources.{list,get,saveAs}` |
| `src/main-process/archive-center/task-policy-registry.js`、`src/main-process/execution-descriptors/legacy-task-policies.js` | IPC 分类登记 |
| `src/renderer/dialogs/template-files.js` | 页面工厂 `createTemplateFilesDialogs`，返回 `mountTemplateFiles(pane, { getParentHandle })` |
| `src/renderer/dialogs/app-settings.js` | 导航「模板文件」（位于存档中心与外观设置之间）、面板、标签切换与视图生命周期 |
| `src/renderer.js`、`index.html` | 装配新工厂并注入设置弹窗；加载顺序在 `app-settings.js` 之前 |
| `src/styles-gemini-extra.css`、`src/styles-dark-mode.css` | 页面样式与深色覆盖，沿用存档中心尺寸与语义色 |
| `architecture/boundaries.json` | 新边界 `renderer-dialog-template-files`；设置弹窗 `ui` 新增 `mountTemplateFiles`（policyChanges） |

## 三、接口契约

### 3.1 已实现

| 方法 | IPC | 分类 | 返回 |
| --- | --- | --- | --- |
| `list()` | `template-resources:list` | exclude / read-only-query | `{ status, resources[], excluded[] }` |
| `get(resourceId)` | `template-resources:get` | exclude / read-only-query | `{ status, resource }`，未知 id 为 `{ status: 'failed', message }` |
| `saveAs({ resourceId, versionId })` | `template-resources:save-as` | support-action / user-document-export | `{ status: 'success', fileName, filePath }`、`{ status: 'cancelled' }` 或 `failed` |

列表项字段：`id, name, fileName, path, type, readMode, bindings[{moduleId,use,read}], sheets[{name,headerRow,headers,dataRows}], enumValues, readError, cache, failure, effect, twin, currentTemplate, current, capabilities`。

- `current` 为内置版本：`{ id: 'v1', label: 'V1', source: 'builtin', current: true, fileName, size, appVersion, tasks: [] }`；详情另带 `sha256`、`versions`、`tasks`。
- `capabilities`：`saveAs`（文件可读即为 true）、`importVersion/setCurrent/deleteVersion/restoreDefault`（当前均为 false）、`importReason`（目标设计可替换的 6 个模板为「版本导入尚未开放」，其余为清单中的具体原因）。
- 另存为由 Main 弹出保存框，默认文件名为原文件名，写出前拒绝覆盖内置文件本身。

### 3.2 后端阶段待实现（Renderer 已按此消费）

Renderer 仅在对应方法存在且 `capabilities` 允许时启用入口：

| 方法 | 约定 |
| --- | --- |
| `pickImportFile({ resourceId })` | Main 选择 .xlsx；`{ status: 'success', filePath, fileName, size }` 或 `cancelled` |
| `prepareImport({ resourceId, filePath })` | 暂存并预检；返回 `importToken, expectedVersionId, expectedVersionLabel, expectedVersionSource, file{name,size,sha256}, verdict(pass/warn/fail), checks[{group:file/usage,label,status,detail}], diff{added,removed}` |
| `discardImport(importToken)` | 放弃暂存；可重复调用 |
| `commitImport({ importToken, enable })` | 当前版本已变化时返回 `conflict`，Renderer 提示重新校验；成功返回 `{ version }` |
| `setCurrentVersion({ resourceId, versionId, expectedVersionId })` | 启用 / 恢复默认，版本已变化返回 `conflict` |
| `deleteVersion({ resourceId, versionId })` | 当前、内置或被运行中任务固定的版本由 Main 拒绝 |
| `listChanges()` | `{ changes[{at,resourceId,resourceName,action,from,to,result}] }`；存在时显示「变更记录」入口 |
| `onChanged(listener)` | 返回退订函数；Renderer 收到后重读列表 |

## 四、清单与读取口径

- 纳管 39 个：输出模板 8、枚举 1、输入原表 24、链接表 4、示例参考 2；未纳入 `COMMON枚举.xlsx`、`余额账单模版.xlsx`、`币种映射表.xlsx`（由原模块维护）。
- 读取方式依据现有代码：运行时读取 5 个（资金对账导出不平、重复入金召回邮件模板、平盘银行对账单、银行对账单、VCC 移除归档 Pending 发生额计算表；最后一个所属模块未接入替换）、缓存读取 2 个（FundType 枚举、网关对账单）、哈希锁定 1 个（VCC 结果模板）；其余为结构样例、程序生成、未启用或参考文件。
- 解析用 SheetJS（与 `fund-type-enum.js`、`gateway-recon-headers-loader.js` 一致）。`<dimension>` 声明小于实际单元格时按实际单元格重算范围；合并单元格覆盖的行计入「另有 N 行内容」。枚举值口径与运行时一致：第 1 个 Sheet 第 1 列、跳过表头、去空去重保序。
- 成功的解析结果按文件大小与修改时间缓存；读取或解析失败不缓存，下次请求重新读取（权限、占用等临时错误解除后文件签名通常不变）。首次列表在开发机约 45ms。

## 五、架构与策略登记

- 新增 2 个 exclude（read-only-query）与 1 个 support action；固定基线 fixture 不改，基线测试以显式新增清单比对。
- 新边界 `renderer-dialog-template-files`（G3，active）：工厂参数 `api/modalBridge/modules/ui`，API 仅 `templateResources.get/list/saveAs`，UI 仅 `escapeHtml/createConfirmDialog`；由 `src/renderer.js` 以 classic global 消费。
- `renderer-dialog-app-settings.allowedApiFields.ui` 新增 `mountTemplateFiles`：设置弹窗只接收挂载函数，不直接持有模板 API；按 policyChanges 记录。

## 六、测试与验收

| 层 | 入口 | 覆盖 |
| --- | --- | --- |
| Unit | `tests/unit/main-process/template-resources-service.test.js` | 清单与 assets 一致、运行时契约表头与代码常量一致、VCC 锁定哈希、枚举口径、能力与另存为边界、读取失败恢复后重新读取 |
| Unit | `tests/unit/main-process/template-resources-ipc.test.js` | 执行 `main.js`/`preload.js` 真实注册代码：方法与通道、列表/详情委托、另存为先校验再弹框、取消不写入 |
| Unit | IPC 清单与基线测试、Renderer 边界登记、设置弹窗源码合同 | 通道数量与分类（基线 fixture 不改）、active Renderer 边界 20 → 21、导航顺序 |
| Integration | `scripts/integration/template-resources-save-as.js` | 真实 assets 另存为字节一致、拒绝覆盖内置文件、未知资源 |
| Renderer 生命周期 | `scripts/renderer-lifecycle/fixtures/template-files.js` | 真实 DOM：懒加载、筛选与高亮、详情标签、另存为、能力置灰、子弹窗栈、导入/冲突/启用/删除（受控 API）、晚到响应与释放；真实按键下激活模板、切换 Sheet、跳转关联模板后焦点不丢失 |

人工检查：真实应用中打开设置 → 模板文件，浅色/深色、最小窗口 1080×760。

### 6.1 功能分支验证结果（2026-10-07）

- `npm run release-check` 通过：lint、架构检查、smoke；unit 9608/9612，0 失败，4 项为既有跳过；integration 84 个脚本 3135/3135。
- Renderer 生命周期 `template-files` 13/13，含 1080×760 浅色、深色与 150% 缩放的无横向溢出检查与截图。
- 真实应用：隔离 userData/Documents 启动后打开设置 → 模板文件，真实 IPC 返回 39 个模板、3 个未纳入文件，无读取失败，导入按钮显示「版本导入尚未开放」。本机 `origin/main` 启动被 BizOP 升级预检拦截（系统可用内存不足，兼容内存预算为 0）；该次验证在临时副本中套用 `fix/bizop-upgrade-startup` 并固定内存采样后完成，仓库代码未改动该部分。
- 未执行：`npm run verify:app-settings-layout` 在未改动的 `origin/main` 上同样报 `createAppUpdateSettingsDialog is not defined`，属既有问题，不在 release-check 内。

## 七、风险与后续

| 编号 | 风险 | 处理 |
| --- | --- | --- |
| R1 | 用户以为「启用」会改变模块输出，但模块仍读内置文件 | 后端阶段与各模块改读当前版本同时上线；在此之前能力全部为 false |
| R2 | 清单与 assets、代码契约漂移 | 单测核对文件存在、运行时表头与常量、锁定哈希 |
| R3 | 首次列表解析阻塞 Main | 文件小、按签名缓存；若后续纳入大文件，改为后台解析 |
