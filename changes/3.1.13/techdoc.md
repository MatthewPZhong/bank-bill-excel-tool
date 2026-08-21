# v3.1.13 TechDoc — 工具箱、存档中心与模块初始化状态调整

| 项目 | 内容 |
| --- | --- |
| 目标版本 | v3.1.13 |
| 日期 | 2026-08-20 |
| 状态 | 与已合入实现同步；正式技术发布已授权；Windows 人工边界未验证 |
| 产品 Spec | `changes/3.1.13/spec.md` |
| 实施记录 | `changes/3.1.13/implementation-notes.md` |
| 发布代码基线 | PR #159 merge commit `9e68c0339427a91c1948f73bfae66f0a76d17b5c` |

## 1. 技术目标与不变量

本次改动触及工具箱的 renderer 交互、存档中心 renderer 模板/投影、两者的作用域 CSS、多文件拆分原生确认框文案，以及平盘对账数据处理和对账单修复的初始化状态投影、对应测试、预览和文档。

必须保持：

1. `window.desktopApi.toolbox.merge / splitRead / splitExport` 的方法名、请求和返回形态不变。
2. 合并/拆分的读取、格式保真、筛选、行数、文件名、FilePlan、全局批次、存档和 committed publication 不变。
3. 多文件冲突的 response 0 仍在 FilePlan、临时目录和正式目标写入前返回；response 1 仍进入既有整批发布。
4. 任何成功、失败、异常或用户取消都必须解除 renderer busy 状态；不得留下永久隐藏关闭按钮或永久禁用入口。
5. 一个工具箱主弹框实例同一时刻最多只有一个异步任务。

## 2. 当前调用链与改动落点

```text
工具箱主弹框 createToolboxDialog
├─ 合并表格 click
│  └─ desktopApi.toolbox.merge()
│     └─ main: toolbox:merge prepare + execute
├─ 拆分表格 click
│  └─ desktopApi.toolbox.splitRead()
│     └─ main: toolbox:split:read
└─ 选择拆分字段 onComplete
   └─ desktopApi.toolbox.splitExport(payload)
      └─ main: toolbox:split:export prepare + execute
         └─ 多文件模式：选目录 → 冲突确认 → FilePlan → 生成/发布
```

| 文件 | 技术职责 | 本次修改 |
| --- | --- | --- |
| `src/renderer-dialogs.js` | 动态创建工具箱 DOM、调用 IPC、展示结果 | 状态框、busy 派生状态、状态文案、关闭/重入门禁 |
| `src/renderer.js` | 动态创建存档中心、加载列表与设置 | 日期默认空、两个按钮重排、移除两项统计投影 |
| `src/styles-gemini-extra.css` | 工具箱与存档中心 Clear 主题布局 | 工具箱 grid；存档标题与位置按钮相邻布局 |
| `src/main.js` | 工具箱 IPC 编排与原生 dialog | 冲突按钮 `取消` → `返回` |
| `tests/unit/renderer-dialogs-toolbox.test.js` | renderer/CSS 静态合同 | 状态结构、生命周期、几何与 busy 门禁 |
| `tests/unit/main-process/toolbox-multi-split-ipc.test.js` | 多拆 IPC 顺序合同 | 按钮文本及 response 0 的写入前返回 |
| `tests/unit/archive-center-ui-contract.test.js` | 存档中心 renderer/CSS 静态合同 | 空日期、DOM 顺序、精简统计与旧生命周期保护 |
| `scripts/verify-app-settings-layout.js` | 设置弹框真实 DOM 布局验证 | 首次 filters 捕获、相邻位置和移除项检查 |
| `docs/previews/toolbox.png` | 工具箱视觉基线 | 更新为带状态框的 v3.1.13 布局 |
| `docs/previews/archive-center-*.png` | 存档浏览/设置视觉基线 | 更新空日期和两个设置入口布局 |

`src/preload.js` 不改：没有新增 IPC，也没有修改 payload/result。

## 3. DOM 与布局设计

### 3.1 DOM 顺序

`.toolbox-body` 直属子节点按以下顺序创建：

1. `.status-box.toolbox-status-box`
2. `.toolbox-row.toolbox-merge-row`
3. `.toolbox-row.toolbox-split-row`

状态框包含项目通用的 `.status-box-content` 和 `.status-box-text`；v3.1.13 全局移除 `.status-spark` 星星 SVG，并设置：

- `role="status"`
- `aria-live="polite"`
- 初始 `data-tone="neutral"`
- 初始文案“等待操作”

### 3.2 几何模型

定义：

- 标签布局宽度 `L = --toolbox-label-width = 72px`
- 状态框宽度 `S = L + L = 144px`
- 按钮/主 grid 行高 `B = 36px`
- 两行间距 `G = 18px`
- 状态框高度 `H = B + G + B = 90px`
- 主体左右 padding `P = 28px`
- 主列间距 `C = 22px`
- 卡片宽度 `W = 414px`

CSS grid：

```css
grid-template-columns: 144px minmax(0, 1fr);
grid-template-rows: 36px 36px;
column-gap: 22px;
row-gap: 18px;
```

对齐证明：

- `.dialog-header` 与 `.toolbox-body` 左 padding 都是 28px，因此标题和状态框左沿相同。
- 状态框 `grid-row: 1 / 3` 且 `align-self: stretch`，其上沿等于 row 1 上沿，下沿等于 row 2 下沿。
- 两个按钮均使用 `.small { height: 36px }`，所在 grid row 也是 36px，因此状态框上下沿分别与两按钮外沿一致。
- 状态宽度和标签宽度引用同一个 CSS 变量，避免 72px/144px 两处独立常量漂移。

右侧操作列可用宽度为 `414 - 2×28 - 144 - 22 = 192px`；内部为 `72px 标签 + 18px gap + 102px 按钮`，不会挤压四字标签或按钮。

保留现有 `transform: translateY(7.5px)` 与 body 上下 padding，弹框总高度不因改成 grid 而改变既有垂直基线。

## 4. Renderer 状态机

### 4.1 状态所有权

不新增 renderer 全局 state。每次 `createToolboxDialog()` 创建一个独立闭包，继续持有：

- `mergeInFlight`
- `splitImportInFlight`
- `splitExportInFlight`

统一派生：

```js
running = mergeInFlight || splitImportInFlight || splitExportInFlight
```

三者不能同时为 true；入口事件先检查 `isToolboxRunning()`，再同步置位，因此同一事件循环内也不会启动第二条任务。

### 4.2 busy UI 同步

`syncToolboxRunningUi()` 是唯一 busy 出口：

| UI 属性 | running=true | running=false |
| --- | --- | --- |
| `closeBtn.hidden` | true | false |
| `mergeImportBtn.disabled` | true | false |
| `splitImportBtn.disabled` | true | false |
| `overlay[aria-busy]` | `true` | `false` |
| `card.is-running` | 添加 | 移除 |

关闭按钮 click 和 overlay click 都再次检查 `!isToolboxRunning()`，形成 DOM 隐藏之外的行为门禁。即使后续 CSS 或脚本意外让按钮可见，运行中也不能调用 `closeModal()`。

### 4.3 状态迁移

```text
idle（等待操作）
├─ merge click → merge-running（正在合并表格）
│  ├─ success → 合并完成
│  ├─ failed/throw → 合并失败
│  └─ cancelled/null → 已取消合并
├─ split click → split-read-running（正在读取表格）
│  ├─ success → split-config（等待拆分设置）
│  ├─ failed/throw → 读取失败
│  └─ cancelled/null → 已取消拆分
└─ split config complete → split-export-running（正在拆分表格）
   ├─ success → 拆分完成
   ├─ failed/throw/invalid → 拆分失败
   └─ cancelled/null → 已取消拆分
```

每条运行路径都采用：

1. 置对应 in-flight flag；
2. 更新短状态；
3. 调 `syncToolboxRunningUi()`；
4. `await` IPC；
5. 根据结果更新短状态和既有详细提示框；
6. `finally` 清 flag 并再次同步 UI。

### 4.4 Modal 替换与状态保留

`openModal()` 会清空 `modalRoot`，但不会销毁 renderer 闭包中的 `overlay` 对象：

- splitRead 成功后，主工具箱 overlay 暂时被选字段弹框替换；关闭/完成后可重新插入同一个 overlay，状态保留为“等待拆分设置”或后续导出状态。
- 成功/失败提示框也会暂时替换工具箱；提示框确认回调重新插入同一 overlay，因此能看到最后短状态。
- 用户真正关闭工具箱并重新打开时会创建新实例，状态重置为“等待操作”；不跨会话持久化。

## 5. Main 进程冲突确认

多文件拆分 `prepare` 的顺序保持：

1. 校验 split read context、字段和值；
2. 用户选择一次输出目录；
3. 计算全部 `targetPlans`；
4. 拒绝“已存在但不是普通文件”的目标；
5. 收集普通文件冲突；
6. 如有冲突，显示 `buttons: ['返回', '覆盖全部']`；
7. response 不是 1 时返回 `{proceed:false,result:{status:'cancelled'}}`；
8. 之后才建立 outputPaths、FilePlan 和 task；execute 中才创建临时目录。

因此【返回】具有以下可证明边界：

- 不创建 generation/staging 文件；
- 不覆盖或删除正式目标；
- 不建立本次 File Batch；
- 不改变 split read context 的既有生命周期；
- renderer 收到普通 `cancelled`，状态改为“已取消拆分”。

本版不新增 `conflict-return` 返回码，也不把已提交的分组重新灌回多文件编辑器。若未来产品要求“返回后原样继续编辑”，应单独扩展 `initialGroups` 和明确返回原因，不能复用模糊 cancelled 猜测来源。

## 6. 失败、恢复与并发边界

| 场景 | 行为 |
| --- | --- |
| 用户取消文件/目录/另存为 | IPC 返回 cancelled；状态显示对应取消；busy 复位 |
| renderer IPC reject | 状态显示失败；既有应用内错误框展示；busy 复位 |
| main prepare 校验失败 | 不进入 task execute；状态失败；既有 detailLines 可见 |
| 生成或发布失败 | 继续由工具箱 publication/recovery 合同处理；本次 UI 只消费 failed 结果 |
| 提示框显示期间 | 任务 Promise 已同步进入 finally；回工具箱时 close 与入口已恢复 |
| 快速连续点击两个入口 | 第一次同步置 busy；第二次 `isToolboxRunning()` 直接返回 |
| 运行时点遮罩或关闭按钮 | 关闭按钮隐藏且两个 handler 均拒绝 close |

不新增 worker 取消按钮，也不改变应用退出时对任务和 committed receipt 的已有处理。

## 7. 可访问性与可观测性

- 状态框为 polite live region，不打断用户当前读屏内容。
- 原有成功/错误提示框及 renderer 错误日志上报保持不变；状态框不会重复上报同一错误。
- `aria-busy` 只标记工具箱 overlay 当前是否有异步任务，不扩散到整个应用。
- disabled 属性同时提供视觉和键盘门禁；关闭按钮使用 `hidden`，不会留在 Tab 顺序中。
- 状态使用文字而非只靠绿色/红色，颜色只是辅助信息。

## 8. 测试与验收矩阵

### 8.1 自动化

| 层级 | 用例 | 关键断言 |
| --- | --- | --- |
| renderer 静态合同 | `renderer-dialogs-toolbox.test.js` | 状态 DOM、aria-live、所有短状态、共享 busy、关闭/遮罩门禁 |
| CSS 合同 | 同上 | label 72px、状态 2×、跨两行、两条 36px grid row |
| main IPC 合同 | `toolbox-multi-split-ipc.test.js` | 【返回 / 覆盖全部】、response 0 在 FilePlan/临时目录前返回 |
| 工具箱集成 | `scripts/integration/toolbox-roundtrip.js` 及工具箱相关 unit | 合并/拆分数据和文件合同不回退 |
| 语法/lint | `node --check`、`npm run lint` | renderer/main 语法和项目 lint |
| 视觉 | `npm run preview:toolbox` | 新 PNG 完整且人工检查几何 |

### 8.2 人工验收

1. Windows 打开工具箱，确认初始状态框布局与 preview 一致。
2. 启动一次足够长的合并、拆分扫描和拆分导出，分别确认右上角关闭消失、双入口禁用、遮罩不能关闭。
3. 三条任务分别验证 success / failed / cancelled 后 UI 恢复。
4. 多文件拆分输出到含同名文件的目录，确认原生框显示【返回 / 覆盖全部】。
5. 点【返回】，核对所有旧文件 SHA/大小不变且无新文件/临时文件；点【覆盖全部】，核对整批成功或整批恢复。
6. 真实 Excel/WPS 打开合并和拆分结果，确认本次 UI 改动没有改变内容与格式。

## 9. 兼容、回滚与发布

- 数据库无 migration；preload 无变更；不存在新旧 renderer/main IPC 不匹配。
- 回滚 UI 时可一起回退 renderer、工具箱 CSS 和 preview；输出文件及存档无需处理。
- 回滚确认文案只需恢复 main 的按钮文本，不影响 publication journal 或历史任务。
- `package.json`/lockfile bump 到 3.1.13，三份版本资料同步；tag 前随包指南使用不依赖瞬时 latest 状态的稳定候选口径，实际 Release 身份只在发布后证据 PR 回写。
- 正式技术发布授权与人工验收分开记录：授权允许继续创建技术资产，不能把未执行的 Windows 项标为 PASS。

## 10. 已知验证边界

- macOS preview 能证明应用内工具箱布局，不能证明 Windows 原生 `showMessageBox` 的最终按钮顺序、系统字体截断或键盘默认焦点。
- 静态 renderer 测试能锁定门禁代码结构；真实长任务期间的视觉消失与点击手感仍需 packaged Windows 人工验收。
- 本次不改变资金、金额、币种或对账数据，但工具箱输出仍需以既有 roundtrip/格式保真测试证明无回归。

## 11. 存档中心前端增补设计

### 11.1 改动边界

只修改 `src/renderer.js` 的存档中心模板/投影和 `src/styles-gemini-extra.css` 的局部布局，并更新 `archive-center-ui-contract`、布局脚本和两个 preview。不修改 `src/preload.js`、`src/main.js`、archive controller/repository 或数据库。

必须保持：

1. `archiveCenter.listBatches/getStats/changeStorageLocation/setRetentionDays` 契约不变。
2. 首次 list、后台 entry maintenance、选中批次清理与 detail request 防竞态顺序不变。
3. 存档位置迁移的 running/cleanup-pending 禁用、进度和错误反馈不变。
4. 浏览页文件总大小、完整存档路径、保留期限仍由原数据源渲染。

### 11.2 日期空值与列表请求

删除只服务于默认当天值的 `archiveCenterDateInputValue()`，日期模板改为显式 `value=""`。`currentArchiveFilters()` 保持返回：

```js
{
  localDate: dateFilter.value,
  moduleId: moduleFilter.value,
  batchNumber: batchIdFilter.value.trim()
}
```

因此首次进入时请求值为 `{ localDate: '', moduleId: '', batchNumber: '' }`。controller 已把空日期转为 `localDate: ''`，repository 只在日期非空时追加 `b.local_date = ?`；现有 `limit: 1000` 不变。本次“全量”是一次查询返回的全部可见批次，不引入分页、无限查询或新的 renderer 聚合循环。

日期、模块 change 和批次号防抖 input 仍调用 `loadArchiveBatches()`；用户选定日期后行为完全沿用现状，清空日期则重新回到全日期范围。

### 11.3 浏览页标题结构

DOM 调整为：

```text
.archive-center-header
├─ .archive-center-header-copy
│  ├─ h3 “存档中心”
│  └─ button[data-action="open-archive-settings"]
└─ .archive-center-storage-summary
   ├─ span “文件总大小”
   └─ strong size
```

`.archive-center-header-copy` 改为 inline flex 语义（实际为 `display:flex`），以固定 gap 让齿轮紧邻标题；storage summary 保留 `margin-left:auto`，继续靠右。事件委托/直接 listener 均通过 `data-action` 查找，因此移动节点不改变行为。

### 11.4 设置页统计精简

`.archive-center-storage-location-heading` 保留“存档位置”与【变更】相邻 DOM，布局从 `justify-content: space-between` 改为 `justify-content: flex-start`，以固定 gap 形成直接相邻。路径和迁移提示仍位于下一行。

删除“存储统计”标题、`.archive-center-storage-labels`、`archive-settings-file-total-size`，以及“运行次数”和“最新批次”对应的 `.archive-center-stat-grid`、`archive-stat-runs` / `archive-stat-latest` role；`renderArchiveStats()` 同步删除对这些节点的 `.textContent` 写入，避免空引用。以下投影保留：

- `archive-file-total-size`
- `archive-storage-path` 与 title
- `migrationStatus` → `renderStorageMigration()`

preview/stub 中可以继续返回 `runCount/latestBatchNumber`，证明多余字段向后兼容但 UI 不再消费；不缩减公共 stats payload。

### 11.5 后台维护提示静默

`archive-feedback` 是存档中心所有操作共用的 `role="status"` 区域，不能通过隐藏节点或修改 `showArchiveFeedback()` 全局行为实现，否则会同时吞掉列表、迁移、删除和保留期限等错误。改为在 maintenance 专属入口停止投影：

- `startArchiveEntryMaintenance()`：仍等待启动 IPC；started/running/failed 结果不写提示栏，调用异常只记 `console.warn`。
- `onEntryMaintenanceProgress`：renderer 不再订阅仅用于文案展示的 progress 事件；preload 与 main 事件合同保留。
- `onEntryMaintenanceCompleted`：保留 maintenance deleted IDs、`loadArchiveBatches({ clearFeedback: false })` 和 `loadArchiveStats()`，删除完成提示。
- `onEntryMaintenanceFailed`：保留订阅并把 error code 写入开发日志，不写提示栏。
- `loadArchiveBatches()`：`selectedRemovedByMaintenance` 继续决定是否清空选择，但不再显示“已到期删除”维护说明。

该方案保留后台维护状态机、首次进入触发、失败后的再次进入重试、完成刷新和所有非维护反馈，只改变 maintenance → 顶部提示栏这一条展示边。

### 11.6 验证

- 静态合同：日期显式空值、首次 filters 透传、标题/按钮 DOM 顺序、设置页旧统计 role/赋值不存在、maintenance 专属路径不调用 `showArchiveFeedback()`。
- 运行布局：捕获首次 `listBatches` 参数；检查标题与齿轮同轴且相邻、存档位置与【变更】同轴且相邻、路径仍位于下一行、设置页移除项不可见；保留期限最终失败仍能显示顶部错误。
- 视觉：重建 `archive-center-browser.png` 和 `archive-center-settings.png` 并人工检查。
- 回归：存档中心 unit、全量 unit、`verify-app-settings-layout.js` 与 lint；前序存档增补的完整 release-check 证据保留，本次纯展示增补不重复业务集成链。

## 12. 对账模块初始化状态生命周期修复

### 12.1 既有偏差

v3.1.9 的目标是“成功初始化同步真实数据和按钮，但状态框保持欢迎；读取错误仍显示；用户动作反馈不变”。当前实现却把“是否刚进入模块”直接传成成功状态投影开关：

```text
setCurrentModule()
├─ 平盘：refresh({ showSummary: enteringModule })
└─ 对账单修复：reloadScenarios({ updateStatus: enteringModule })
```

真实切换进入时 `enteringModule === true`，因此恰好在用户看见面板时写入历史 session/pending 摘要。HTML 初始文案和隐藏初始化测试均无法阻止这条旁路。

### 12.2 统一语义

两个模块统一把 `updateStatus` 解释为“成功同步后是否投影摘要”，不控制错误展示：

| 触发入口 | `updateStatus` | 成功 | 失败/异常 |
| --- | --- | --- | --- |
| 应用初始化/自动模块进入 | `false` | 只更新内存状态、场景和按钮，保留当前状态框 | 无条件显示读取失败并进入安全按钮态 |
| 用户导入/运行/导出/确认后的 refresh | 默认 `true` | 显示最新摘要 | 显示读取失败 |
| 用户切换平盘功能或修复场景 | 原路径 | 显示对应提示或摘要 | 原路径显示错误 |

平盘控制器的 `initialize()` 在一次成功静默同步后显式写“欢迎使用小助手”；失败结果不执行该写入，避免错误被欢迎文案盖掉。之后 `setCurrentModule()` 的自动刷新始终传 `updateStatus:false`，因此既能让首次静态欢迎保留，也不会擦除当前进程内已有的用户动作反馈。

对账单修复沿用已有 `updateReconIdFixUi({ updateStatus })` 分层：自动模块进入固定传 `false`；`refreshReconIdFixStatus()` 在非 `ok` 或 reject 时先清 session/result 并以 `updateStatus:false` 更新按钮，再独立调用 `updateStatusBox(..., 'error')`。成功路径才服从 `updateStatus`。

### 12.3 并发、兼容与失败边界

- 应用恢复上次模块时，`setCurrentModule()` 与平盘 `initialize()` 可能并发读取；所有自动成功结果均不投影摘要，最终成功初始化写欢迎，任一末次失败仍可见。
- 模块重进不重置状态框，所以用户操作成功/失败文案可保留；真实后台 state 和按钮每次仍刷新，不以旧文案驱动按钮。
- 不新增 renderer 全局状态或 IPC，不改变 status/session 返回结构；旧数据库和历史 session 无需迁移。
- 状态文案不参与对账业务判断。主键、金额、币种、方向、匹配、回填、幂等、行数守恒、归档和 Excel 输出链全部不经过本次改动。
- 状态读取失败内容只使用既有结果 message/detail 或 Error message，不新增账号、订单或行数据泄露。

### 12.4 验证策略

- 平盘控制器行为测试：真实调用 `initialize()`、默认 `refresh()` 和 `refresh({updateStatus:false})`，覆盖成功欢迎、摘要更新、自动重进保留、失败结果和 reject。
- 对账单修复接线测试：锁定自动模块进入固定 `updateStatus:false`、用户动作默认更新、失败分支无条件 error 且先同步安全按钮态。
- HTML/布局：两个状态框静态初值均为欢迎；`verify:main-panel-alignment` 在 2 viewport × 3 zoom 下补充精确初始文案断言。
- 视觉：重建 `recon-id-fix-panel.png` 与 `position-reconciliation-panel.png`，确认首次面板状态文案和布局。

## 13. 全局状态框星星 SVG 移除

### 13.1 入口与边界

已确认的生产装饰入口共 14 个：`index.html` 中 13 个静态 `.status-box`，以及 `createToolboxDialog()` 模板中的 1 个动态 `.status-box`。另外，仓库根部 `Clear/` 当前 UI 样板有 6 个状态框镜像和一份样板 `.status-spark` 样式，需同步清理；该目录不进入 Electron 运行包，但仍作为当前 HTML 结构参考。删除范围以状态框内 `.status-spark` 包装及其星形 `<svg>` 为准；其它按钮、模块切换器和功能图标不在范围内。

所有运行时状态写入均通过后代选择器查找 `.status-box-text`，因此 DOM 从：

```html
<span class="status-box-content">
  <span class="status-spark" aria-hidden="true"><svg>…</svg></span>
  <span class="status-box-text">…</span>
</span>
```

收敛为：

```html
<span class="status-box-content">
  <span class="status-box-text">…</span>
</span>
```

“新开账户”状态框原本没有内容层，本次只删除其 `status-spark`，继续保留 `status-box-text` 为直接子元素，避免把装饰删除扩大为 DOM 统一重构。

### 13.2 CSS 与布局

- 从 Clear/General 生产主题及 `Clear/` 样板 CSS 删除 `.status-spark`、`.status-box-content .status-spark` 与对应 `svg` 规则。
- 从 `.status-box` 和 `.status-box-content` 删除原图标与文字之间的 `gap: 8px`；内容层的 `inline-flex`、水平/垂直居中、最大宽度和最小宽度规则保留。
- 状态框外层尺寸、模块专属定位、长文本 `white-space`/换行、资金状态滚动和 toolbox 144px × 跨行几何均不改变。
- General 主题原有全局 `.status-spark { display:none; }` 一并删除，避免保留已不存在节点的死样式。

### 13.3 验证策略

- 静态合同：逐个解析 13 个主页面状态框及工具箱模板，断言存在 `.status-box-text` 且不存在 `.status-spark`/状态框内 `<svg>`；另检索 6 个 `Clear/` 样板与样板 CSS；两套生产主题及样板不得残留专属选择器或 8px 图文 gap。
- 真实几何：`verify-main-panel-alignment.js` 不再要求或测量图标，改为检查文字内容层中线、内容不溢出和所有状态框均无 SVG；特殊的新开账户状态框单独检查无图标且结构未被统一改写。
- 视觉：重建所有受影响主面板和工具箱预览，检查移除图标后文字仍居中、长状态框与跨行状态框无位移或异常留白。
- 回归：状态更新测试继续锁定 `.status-box-text` 后代选择器，确保文案、色调、错误态、运行态与点击行为不依赖已删除装饰。

## 14. 正式收尾与发布设计

### 14.1 两阶段仓库收口

发布使用固定顺序，避免把尚未发生的外部事实写入 tag：

1. 从已合入功能的 `main@9e68c0339427a91c1948f73bfae66f0a76d17b5c` 创建 tag 前收尾分支，只更新 Spec、TechDoc、实现记录、三份版本资料、Windows Runbook 与文档合同测试。
2. 收尾 PR 的完整自动门禁和 Windows PR workflow 通过后，以 merge commit 合入 `main`。
3. 再次 fetch 并确认本地 `HEAD === origin/main`、tracked worktree 干净、`package.json.version === 3.1.13`、远端不存在同名 tag/Release，随后创建并推送唯一 annotated tag `v3.1.13`。
4. tag 触发受控 Windows Release workflow。只有 workflow 成功、Release 为公开 stable latest、四项资产完成独立回读后，技术发布才闭合。
5. 从发布后的最新 `main` 创建独立证据分支，把真实 PR、merge commit、tag object、workflow、Release、资产大小与摘要回写文档并再次经 PR 合入；不得修改已发布 tag 或资产。

### 14.2 Tag 身份与并发门禁

Release workflow 必须 fail closed：

- `refs/tags/v3.1.13` 的对象类型为 `tag`，而不是 lightweight tag。
- tag 名与 `package.json.version` 精确相等。
- annotated tag peeled commit 与创建 tag 瞬间的 `origin/main` 精确相等。
- 同名 GitHub Release 不存在；Setup、portable、blockmap、`latest.yml` 由本次 workflow 一次生成。

收尾 PR 合并后到推 tag 前若 `main` 又发生变化，必须重新 fetch、验证新 HEAD 的门禁和文档状态，不能把旧本地提交当成发布基线。tag 推送后视为不可变；workflow 可在相同 tag 上受控重跑处理基础设施瞬时故障，但不能借重跑替换已经发布的资产或引入 tag 之后的代码。

### 14.3 人工边界与授权记录

当前收尾环境为 macOS，不能执行 Windows 10/11 原生/packaged 人工交互。发布负责人在已知下列范围后明确授权继续技术发布：

- 原生同名覆盖确认框的【返回 / 覆盖全部】文案、顺序、默认焦点与系统字体；
- packaged 长任务期间关闭按钮隐藏、双入口禁用、遮罩门禁和恢复手感；
- Windows 10/11 Setup、portable、SmartScreen 实际提示；
- `v3.1.12 -> v3.1.13` 离线覆盖安装及用户数据保留；
- Release 存在后从 `production/latest` 执行的在线升级 canary。

这些项目统一记录为 `MANUAL / NOT RUN`。授权仅允许生成技术资产，不构成验收 PASS，也不能用于“Windows 已验证”或“在线升级已验证”的公告。tag 前收尾 PR body 需以稳定 GitHub 记录写明批准来源、范围、理由和发布后补做项。

### 14.4 Release 与资产回读

发布后验证不得只依赖 workflow 的绿色状态，至少独立确认：

- annotated tag object、peeled commit 与发布时 `main`；
- Release URL、published/non-draft/non-prerelease/latest 状态；
- 四项资产精确文件名、大小、GitHub digest 和匿名下载 HTTP 状态；
- 独立下载文件的 SHA-256 与 GitHub digest 一致；
- `latest.yml` 的 version、Setup path、size、releaseDate 与公开资产一致，其 SHA-512 与独立下载的 Setup 一致。

真实 ID、摘要和大小只在实际回读后写入 `docs/WINDOWS_RELEASE_RUNBOOK.md` 与发布证据 PR；预期值不得冒充实际证据。

### 14.5 失败、回滚与不可变规则

- 收尾 PR 或 tag 前门禁失败：不创建 tag，修复后重新走 PR/门禁。
- tag 只在本地创建且尚未推送时发现身份错误：停止发布，删除错误的本地 tag 后按已验证 HEAD 重建；不得删除任何远端 tag。
- tag 推送后 workflow 失败：保留 tag 和失败证据。仅基础设施瞬时故障可对同一 commit 重跑；产品、元数据或打包输入缺陷使用更高补丁版本修复。
- Release 已创建后任一回读失败：停止公告，不删除、不替换、不重传同版本资产；记录实际状态并发布更高补丁版本。
- Windows 人工项或在线 canary 后续失败：同样停止公告/推广，保留不可变发布证据并以更高补丁修复。
