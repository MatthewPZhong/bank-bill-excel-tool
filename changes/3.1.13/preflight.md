# v3.1.13 Preflight — 工具箱状态与运行保护

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-20 |
| 状态 | 无 BLOCK；允许实施 |
| 基线 | `7221274f01b769c2786b63300f554fec65bf8641` |
| 关联文档 | `spec.md`、`techdoc.md`、`implementation-notes.md` |

## Task Brief

- Goal：完成 v3.1.13 三项工具箱 UI/交互调整。
- Context：主弹框在 renderer 动态创建；覆盖确认在 main 的多文件拆分 `prepare`；样式位于 Gemini extra CSS。
- Constraints：保持工具箱 Excel、FilePlan、批次和可恢复发布合同；不触碰金额/币种业务。
- Done when：实现、测试、视觉预览和版本资料一致。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 工具箱主弹框由动态 DOM 创建 | `src/renderer-dialogs.js:createToolboxDialog` | 状态结构和运行态都在该工厂内收口 |
| 三条异步边界分别是 merge、splitRead、splitExport | `src/preload.js` 与 `createToolboxDialog` | 关闭按钮必须覆盖三条 Promise 生命周期 |
| 多文件同名确认只有一个工具箱入口 | `src/main.js` 的 `toolbox:split:export.prepare` | 只改该原生确认框，不影响其他覆盖流程 |
| response 0 在 FilePlan 建立前返回 cancelled | 同一 `prepare` 实现 | 【返回】可保持整批零写入、零批次语义 |
| 标题和 body 左 padding 均为 28px | `src/styles-gemini-extra.css` 的 `.dialog-header` / `.toolbox-body` | 两者可直接实现左沿对齐 |
| 标签布局宽度为 72px，按钮高度为 36px | `.toolbox-row-label` 与 `.small` | 状态框宽 144px；两行 grid 可精确对齐上下沿 |
| 工具箱已有静态单测、IPC 单测和专用 preview | `tests/unit/renderer-dialogs-toolbox.test.js`、`toolbox-multi-split-ipc.test.js`、`npm run preview:toolbox` | 可补定向回归与视觉证据 |
| 当前追踪工作树干净，但存在用户未追踪文件 | `git status --short --untracked-files=no` | 只编辑本迭代文件，不清理未追踪内容 |

## Unknowns Register

| 未知 | 类型 | 影响 | 当前证据 | 处理 | 当前决定 |
| --- | --- | --- | --- | --- | --- |
| 状态框具体短文案和色调 | 隐性偏好 | 低 | 需求只规定位置；项目已有等待/运行/成功/失败状态模式 | ASSUME | 使用短状态表，详细内容仍进既有提示框 |
| “运行时”是否只指 worker 写文件 | 状态边界 | 中 | 三个 IPC 都可能等待原生选择框或执行长扫描/发布 | PROBE | 以 Promise 未 settle 为统一运行边界 |
| 运行时遮罩是否仍可关闭 | 入口旁路 | 中 | 当前遮罩点击直接 `closeModal()` | PROBE | 与隐藏关闭按钮同期开启遮罩关闭门禁 |
| 两个入口是否可并发 | 状态/重入 | 中 | 当前只禁用被点击按钮，另一按钮仍可启动 | PROBE | 共享 busy 状态，运行时同时禁用两个入口 |
| 【返回】是否需恢复已填分类编辑器 | 交互偏好 | 低/可逆 | 用户明确要求的是按钮“改为【返回】”，未要求修改返回目标；现有 response 0 回工具箱且零写入 | ASSUME | 本版只改文案与保留零写入语义，不扩大 IPC 契约 |
| 状态框精确宽度如何避免魔法值漂移 | 布局 | 低 | 标签已有 72px 固定 basis | PROBE | 共用 CSS 变量，状态宽用两个 label width 相加 |

## 风险优先计划

| 顺序 | 步骤 | 保护的不变量 | 成功证据 | 失败时收缩 |
| --- | --- | --- | --- | --- |
| 1 | 锁定覆盖确认 response 与 running 旁路 | 返回零写入、任务不可重入 | main/renderer 定向测试 | 保留原业务，仅撤 UI 增强 |
| 2 | 建状态 DOM 与 grid | 四边对齐、宽度 2× | CSS 合同测试 + preview | 只调整工具箱作用域 CSS |
| 3 | 接入三条状态生命周期 | 所有早返回与异常都复位 | success/failed/cancelled 静态与交互测试 | 状态只降级为等待，不改 IPC |
| 4 | 同步版本与用户说明 | 不虚报发布/验收 | 文档检索与 diff | 保留“迭代中”口径 |
| 5 | 自动化与盲区复核 | 数据/发布合同不变 | 定向测试、集成、预览 | 未通过则不交付 |

## 当前门禁

- 没有会改变数据模型、公共接口、资金边界或主要流程的 BLOCK。
- 真实 Windows 原生覆盖框按钮顺序与工具箱长任务手感仍需最终人工环境验收；不影响实现启动。

## 增补：存档中心前端调整

### Task Brief

- Goal：日期筛选默认置空并直接展示全部日期的可见批次；把存档设置入口放到“存档中心”标题右侧；把【变更】紧邻“存档位置”，并移除“运行次数 / 最新批次”。
- Context：存档中心浏览页和设置页由 `createAppUpdateSettingsDialog()` 同一动态 DOM 工厂创建；列表请求由空字符串表示未启用日期筛选。
- Constraints：仅调整 renderer DOM、样式和初始筛选值；不修改 archiveCenter IPC、数据库查询、存档统计、迁移、保留期限和维护生命周期。
- Done when：初次进入请求的 `localDate` 为空、预览批次不再被当天日期隐式过滤；两个按钮位置与精简统计均有静态合同、运行布局验证和双预览证据。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 日期输入由 `archiveCenterDateInputValue()` 写入当天 | `src/renderer.js` 的日期 input 模板 | 移除该默认值后，`dateFilter.value` 自然为 `''` |
| repository/controller 已把空日期解释为不筛选 | `archive-repository.listVisibleBatches()` 与 `controller.listBatches()` | 不需要新增 IPC 或后端分支 |
| 设置齿轮目前位于右侧“文件总大小”容器内 | `.archive-center-storage-summary` DOM | 移到标题 copy 内，文件总大小继续靠右 |
| 【变更】已是“存档位置”的相邻 DOM，但 CSS 使用 `space-between` | `.archive-center-storage-location-heading` | 保留 DOM 语义，只改为紧邻布局 |
| stats 仍被存档路径、文件总大小和迁移状态消费 | `renderArchiveStats()` | 只删除运行次数/最新批次 DOM 与赋值，不移除 `getStats()` |

### Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| “全量批次”是否要求突破既有 1000 条接口上限 | 范围歧义 | 中 | 一般 | 用户将其定义为“日期选择框默认为空值”后的前端行为；任务明确为前端改动 | ASSUME | 检查 controller 现有 `limit: 1000` 与 UI 无分页事实 | 本版表示“不按日期筛选并展示现有接口返回的全部可见批次”，不扩展后端/分页合同 |
| “存档设置按钮”是否保留齿轮图标 | 隐性偏好 | 低 | 容易 | 需求只指定位置，现有 title/aria 已明确“存档设置” | ASSUME | 更新 preview 检查标题邻接 | 保留齿轮、title 和 aria，仅移动 DOM |
| “变更移至文本右侧”是相邻还是仍靠行末 | 布局歧义 | 低 | 容易 | 当前已在同一行但靠最右，仍被要求“移至” | PROBE | 对比当前 preview 与 CSS `space-between` | 改为 `flex-start` + 固定 gap，使按钮直接紧邻文本 |
| 去掉两项统计是否意味着停止请求 stats | 契约盲区 | 中 | 容易 | 文件总大小、路径、迁移仍依赖 stats | PROBE | 审计 `renderArchiveStats()` 消费方 | 只移除两项显示，保留 stats 请求及其余字段 |

### 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 锁定空日期请求合同 | 空值不触发日期校验且保持模块/批次筛选 | 静态合同 + 布局脚本捕获首次 filters | 会推翻“仅前端”方案 | 恢复日期模板并单独设计分页/API |
| 2 | 调整两个按钮的 DOM/CSS | 入口事件、aria、迁移禁用逻辑不变 | DOM 顺序测试 + browser/settings preview | 只影响视觉方案 | 回退局部 DOM/CSS |
| 3 | 移除两项统计投影 | stats 其余消费不空引用、不丢迁移状态 | 单测确保旧 role/赋值均消失，文件大小仍渲染 | 设置页可能运行时报错 | 恢复两个投影或增加空值保护 |
| 4 | 同步文档并回归 | v3.1.13 行为与版本资料一致 | 定向测试、layout、preview、完整门禁 | 不满足交付 | 不发布该增补 |

### 当前门禁

- 无 BLOCK；现有代码足以确定实现方案。
- “全量”按前端既有查询合同解释为不按日期筛选、展示单次请求返回的全部可见批次；不新增分页或数据库改动。

## 增补二：存档设置统计与维护提示精简

### Task Brief

- Goal：移除存档设置页的“存储统计”标题和文件总大小，并让存档中心顶部提示栏不再显示后台维护类文案。
- Context：设置页与浏览页分别投影同一个 `fileTotalBytes`；后台维护的启动、进度、完成、失败及到期删除选中批次都会写入共用的 `archive-feedback` 提示栏。
- Constraints：浏览页标题栏的文件总大小继续保留；后台维护仍在首次进入后启动，完成后仍刷新列表和统计，维护删除选中批次时仍清空选择；列表加载、详情、迁移、保留期限、锁定、删除和重试等非维护反馈不变。
- Done when：设置页不再渲染两个移除项；renderer 中五类维护路径均不调用 `showArchiveFeedback()`；完成刷新和非维护错误提示有回归证据。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 浏览页和设置页有两个独立文件大小 role | `archive-file-total-size` / `archive-settings-file-total-size` | 只删除设置页 role 及对应赋值，浏览页 role 保留 |
| “存储统计”只是设置页静态标题 | `data-archive-view="settings"` 第一段 `h4` | 删除标题不影响 `getStats()` 数据源 |
| maintenance completed 回调承担列表与容量刷新 | `onEntryMaintenanceCompleted` | 只去掉反馈文案，必须保留 `loadArchiveBatches()` 与 `loadArchiveStats()` |
| 维护删除当前选中批次依赖 deleted IDs | `selectedRemovedByMaintenance` | 清空选择逻辑保留，只移除维护说明文案 |
| 其它操作共用同一提示栏 | `showArchiveFeedback()` 的设置、列表、详情、迁移、锁定、删除、重试调用 | 不可整体隐藏或移除提示栏 |

### Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 当前决定 |
| --- | --- | --- | --- | --- |
| “文件总大小移除”是否也包含浏览页顶部 | 范围歧义 | 中 | 结合“存档设置里的”语法与上一条明确保留顶部总大小的需求 | ASSUME：仅移除设置页投影，浏览页顶部保留 |
| “维护类提示文本”具体覆盖哪些状态 | 状态边界 | 中 | 穷举 renderer 的维护消息入口 | PROBE：启动、进度、完成、失败、到期删除选中批次五类均静默 |
| 静默失败是否会丢失全部可观测性 | 失败模式 | 中 | 检查后台状态与 renderer 日志能力 | PROBE：后台失败状态/事件保持，renderer 仅写开发日志；不向用户提示栏投影 |

### 风险优先计划与门禁

1. 先移除设置页节点与 `renderArchiveStats()` 对应写入，避免空节点赋值。
2. 再逐入口移除维护反馈调用，保留完成刷新、选中态清理和失败日志。
3. 静态合同验证维护函数不再写提示栏，运行布局验证设置页移除项和非维护保存错误仍可见。
4. 重建设置页 preview，并同步三份版本资料、Spec、TechDoc 和实施记录。

- 无 BLOCK；改动不触及存档数据、保留期执行、IPC、迁移或数据库合同。

## 增补三：平盘对账与对账单修复初始化欢迎文案

### Task Brief

- Goal：恢复 v3.1.9 已冻结的初始化契约，使“平盘对账数据处理”和“对账单修复”自动同步成功时不再用历史 session 摘要覆盖状态框的“欢迎使用小助手”。
- Context：两个面板的静态 HTML 都是欢迎文案，真实覆盖发生在 `setCurrentModule()` 的自动同步入口；VCC 财务 OP 已按相同契约正确实现。
- Constraints：继续同步真实 session、场景、pending run 和按钮可用性；读取失败必须显示；用户导入、运行、导出、场景切换等主动操作后的反馈不能被模块切回悄悄清除；不修改任何对账数据、金额、币种、匹配、回填或持久化合同。
- Done when：首次成功进入显示“欢迎使用小助手”，自动重进只刷新数据和按钮并保留当前状态文案，读取失败仍显示错误，用户动作仍能更新状态；静态接线与平盘行为测试覆盖该生命周期。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| v3.1.9 明确要求三个模块初始化成功时保持欢迎文案 | `changes/3.1.9/test-spec.md` VUI-02 与 `implementation-notes.md` | 本次是恢复既有契约，不重新定义产品偏好 |
| VCC 初始化在真实刷新后显式写欢迎文案 | `src/renderer-vcc-financial-op.js:initialize()` | VCC 无需修改，可作为行为参照 |
| 平盘初始化本身传 `showSummary:false`，但模块进入传 `showSummary:enteringModule` | `src/renderer-position-reconciliation.js` 与 `src/renderer.js:setCurrentModule()` | 必须修自动进入旁路，不能只改 HTML |
| 对账单修复的模块进入传 `updateStatus:enteringModule` | `src/renderer.js:setCurrentModule()` | 成功同步与状态投影必须解耦 |
| 两条现有单测仅匹配源码，并把错误接线当成正确合同 | `renderer-position-reconciliation.test.js`、`renderer-status-box-text.test.js` | 需替换旧断言，平盘至少补真实控制器行为测试 |
| 读取失败在平盘返回失败结果时可见，但 Promise reject 未在控制器内收口；对账单修复失败只写 console | 两个 refresh 实现 | 静默成功模式不能吞掉真实失败，异常也不能打断应用初始化 |

### Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 当前决定 |
| --- | --- | --- | --- | --- |
| 每次切回模块是否都强制重置欢迎文案 | 状态生命周期 | 中 | 对照 v3.1.9“用户动作后的状态反馈仍按原路径显示” | ASSUME：自动同步成功不写状态框，首次静态欢迎自然保留，当前进程内用户反馈也可跨模块切回保留 |
| 静默同步时读取失败是否仍应越过 `updateStatus:false` | 失败可观测性 | 高 | 历史契约已明确“读取错误仍显示错误” | PROBE：失败结果和 reject 均无条件写 error，同时更新按钮为安全状态 |
| 是否需要修改 VCC | 范围 | 低 | 审计初始化顺序与现有测试 | CLOSED：VCC 已先同步真实数据再写欢迎，保持不动 |
| 是否触及资金或对账结果 | 资金边界 | 高 | 对照调用链和 diff | CLOSED：只改变 renderer 状态投影开关和错误展示，不改 API 参数、session 内容、按钮判定或业务执行 |

### 风险优先计划与门禁

1. 先冻结“自动同步成功不写文案、失败必写错误、用户动作默认写文案”的三态合同。
2. 平盘把 `showSummary` 改为语义明确的 `updateStatus`，模块进入固定静默；初始化仅在成功后显式写欢迎，失败不覆盖。
3. 对账单修复模块进入固定 `updateStatus:false`；session 读取失败先同步安全按钮态，再无条件显示错误。
4. 替换锁错的静态断言，增加平盘控制器行为测试，并以两个真实主面板 preview/布局检查补视觉证据。
5. 同步 v3.1.13 Spec、TechDoc、版本资料与实施记录后执行定向/全量回归和盲区扫描。

- 无 BLOCK；既有 v3.1.9 契约已消除交互偏好歧义。
- 本增补不触发金额、币种、方向、主键、幂等、行数或 Excel 输出变更，不新增资金人工验收项。

## 增补四：移除所有状态框星星 SVG

### Task Brief

- Goal：移除应用内全部状态框的星星 SVG 装饰，保留状态文字、色调、可访问性与既有状态生命周期。
- Context：生产界面主页面存在 13 个静态状态框星星，工具箱动态弹框存在 1 个；仓库根部 `Clear/` 当前 UI 样板另有 6 份同款镜像。Clear 与 General 两套生产主题仍保留图标盒/间距合同，主面板几何验证也把图标作为必需结构。
- Constraints：只移除状态框内的星星装饰，不移除按钮、模块切换器或其它功能性 SVG；不改变状态框外框尺寸、位置、滚动、文案、`data-tone`、`role="status"` 或 `aria-live`。
- Done when：14 个生产入口与 6 个当前 UI 样板均不再生成 `status-spark`/星星 SVG，残余图标样式和 8px 图文间距合同移除，静态测试、真实布局验证及对应预览通过。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| `index.html` 中共有 13 个 `.status-spark` | 全仓检索与逐状态框 DOM 审计 | 静态主面板必须一次性全部清理，包含结构特殊的“新开账户”状态框 |
| 工具箱工厂另有 1 个 `.status-spark` | `src/renderer-dialogs.js:createToolboxDialog()` | 不能只改静态 HTML，动态弹框也必须同步 |
| `Clear/` 六个当前 UI 样板复制了同款星星，另有一份样板 CSS | 全仓非历史路径检索 | 虽不进入 Electron 运行包，也应同步清理，避免当前设计样板与产品实现漂移 |
| 所有状态更新都查询 `.status-box-text` | `src/renderer.js`、各模块 renderer 与工具箱局部更新函数 | 删除图标不会改变文案更新、色调和状态生命周期 |
| Clear/General 均为内容层保留 8px gap 和 14px 图标盒 | `src/styles-gemini.css`、`src/styles.css` | 需删除残余图标选择器与无意义间距，避免留下幽灵布局合同 |
| 主面板布局单测和 Electron 验证要求图标存在并测量图文中线 | `renderer-main-panel-alignment.test.js`、`verify-main-panel-alignment.js` | 验证需改成“无星星/无状态框 SVG + 文字内容层居中且不溢出” |

### Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 当前决定 |
| --- | --- | --- | --- | --- |
| “所有状态框”是否包含没有 `.status-box-content` 的新开账户状态框 | 入口边界 | 中 | PROBE：它仍有 `.status-box` 与同款星星 SVG | 包含；删除星星但保持其既有特殊 DOM 结构 |
| 是否应同时删除其它界面 SVG | 范围边界 | 高 | PROBE：需求对象明确为状态框，仓库还有功能性图标 | 不包含；只清理 `.status-box` 内的星星装饰及其专属样式 |
| 删除图标后是否保留 8px gap | 布局 | 低 | PROBE：内容层只剩文字，gap 已无作用且会误导后续实现 | 删除 gap 与图标盒规则，文字继续由内容层居中 |
| 是否改写旧版本关于 spark 的历史记录 | 文档兼容 | 低 | ASSUME：历史文档描述当时真实行为 | 不改历史版本，仅在 v3.1.13 当前资料中记录全局移除 |
| `Clear/` 当前样板是否视为“所有状态框”的镜像范围 | 入口旁路 | 中 | PROBE：该目录仍被版本历史称为 HTML 结构基线，且不是冻结迭代归档 | 包含；同步移除 6 个 SVG 与样板 CSS 死规则，但不重构样板文字结构 |

### 风险优先计划与门禁

1. 先冻结“只删状态框星星、不删其它 SVG”的入口集合和无图标 DOM/CSS 合同。
2. 同步 Spec/TechDoc 后再修改 13 个静态入口、1 个动态入口及两套主题样式。
3. 把静态与真实几何验证从图文对齐改为无图标、文字内容层居中和不溢出，并覆盖特殊的新开账户结构。
4. 重建受影响预览，执行定向、全量、lint、smoke、真实布局与 diff 检查，再完成盲区复核。

- 无 BLOCK；入口、范围与布局语义均可从仓库直接确定。
- 本增补是纯展示调整，不触及资金/对账数据、IPC、数据库、文件输出或状态机。
