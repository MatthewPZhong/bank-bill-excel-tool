# PR5 页面布局纠偏

## Task Brief

- Goal：落实 E5 Spec §6 已确认的 VCC 财务 OP 页面布局，修复业务 OP 主页面额外出现“导出数据”的偏差。
- Context：当前启用提交 `9c1784d2`；E5 压缩包根目录 spec.md §6.1—6.4 与确认版要求一致。参考现有 `index.html` 的 `vccFinancialOpModulePanel` 及 `renderer-vcc-financial-op.js` 的 `openDataManager`。
- Constraints：修正前端结构、样式与入口位置，并按用户追加要求去掉差异文件的说明页；Main 仅配套接受差异单页和零说明行。IPC、Task、输入版本、导出目标、删除范围及取消协议保留，不用真实数据做删除验证。
- Done when：主面板与 VCC 的两行位置及尺寸一致；“导出数据”只能从数据管理进入；数据管理恢复左侧分类、右侧表格、底部操作；实际 Electron 布局及取消/删除预览回归通过。

## Unknowns Register

| 项目 | 结论与证据 |
| --- | --- |
| 对齐哪个 VCC 模块 | PROBE 已确认：E5 明确 VCC 财务 OP 校验，不是 VCC 业务 OP 计算 |
| 需求是否改变过主布局 | PROBE 已确认：E5 延续两行布局要求；PR5 实现成单排工具栏，属于实施偏差 |
| “导出数据”是否应该取消 | PROBE 已确认：四种输入导出仍需要，入口应沿用 VCC 的数据管理操作区 |
| 数据管理的结构 | PROBE 已确认：VCC 左侧三类导航、右侧列表、底部操作；业务 OP 保留自身日期/列序/选择和删除合同 |

## Decisions / Deviations

### 本轮明确的界面细节

- 后续用户追加：导出原表期间去掉管理页左下角进度状态框（取消仍可用，失败仍提示）；“导出数据”的账期和目标也横排缩窄并对齐标题；删除选取阶段不显示整版本处理注释，影响确认页保留原删除范围说明。
- 用户要求差异文件不带“核对说明”工作表，输出合同同步到 [PR4 Spec](../pr4/spec.md)。保留 19 列，导出阶段把末列定位提示指向完整原表，不修改已封存数据或计算规则。

- 用户确认：初始状态为“欢迎使用小助手”；导入期间在原导入按钮位置显示“取消导入”，保持焦点、请求绑定和实际完成后才解锁的规则。
- 结果导出弹窗的操作月份与结果表下拉框横排，采用适当窄宽；标题左侧对齐下方分割线。
- 数据管理移除“刷新”和“下一页”，初始操作为“删除 / 导出 / 返回”；“删除”先进入选择，再进入原影响确认，不改变删除 mode。
- PROBE 已确认：Main 元数据接口每页最多 200 条，游标绑定 generation。采用仅在多页时显示的页码选择框，继续按页读取；切换筛选及删除后重载第一页，不加载全部记录。
- BizOP“导出原表”复用 VCC“查看结果”文字按钮；两者结果表操作列统一左对齐，去掉按钮内侧偏移。
- 验收补充：原位取消的几何位置、横排字段/标题和文字对齐、多页可达性与过期游标，以及既有真实鼠标/键盘取消链。

- 主面板第一行左侧为导入/运行，右侧为差异结果导出；第二行左侧为状态框，右侧为数据管理。临时错误报告、恢复和取消只在需要时显示。
- 数据管理采用 VCC 的分类导航与表格布局；底部沿用“导出”按钮，打开“导出数据”窗口，仍提供四类当前输入导出，不从归档恢复旧输入。
- 原生 dialog 继续用于隔离模态焦点和取消保护，外观复用现有 VCC 对话框样式；不引入 VCC 人工调账、归档或解归档业务。
- 之前 UI 验收仅证明动作和字段可用，未比较 VCC 与业务 OP 的结构和几何位置；本次补充实际浏览器尺寸对照。

## Evidence

- `verify-ui.js`：28 PASS。实际 VCC 主面板在 1200×900、1080×760 两档与 BizOP 几何对照；两类导出弹窗横排/标题对齐、实际 VCC 预览入口和 BizOP 的文字按钮对齐；401 条三页完整可达、generation 变化重载、晚到页拒绝，以及四类导出、删除影响、草稿与旧路由。
- `verify-ui-cancellation.js`：11 PASS，真实 Electron 鼠标/键盘输入。导入取消坐标与尺寸完全等于原按钮，鼠标/Enter、重复取消、晚到响应及双层模态都保持；导出原表的进度框不可见，但取消仍有正确焦点、requestId 和等待行为。
- `biz-op-v327-export.test.js` + `biz-op-v327-export-main.test.js`：真实 Electron Node、SQLite、XLSX 和 Task/Publisher/Archive 21 PASS / 0 SKIP / 0 FAIL，包含零差异单页、完整原表说明保留、19 列对照、封存数据不变及六类共 72 个损坏反例。差异说明政策已体现在 schema/expected/actual/Main 的同一身份中。
- 本轮探针时序修正：明确等待原生 close 事件移除旧窗口，导出任务实际完成，且新分类列表可操作后再点击删除；不能用旧表相同的首格日期作为新列表就绪证据。首次差异页名称篡改未匹配 XLSX 属性顺序，补上“确实修改 XML”的断言后复验通过；没有放松产品行为或拒绝条件。
- 前轮 `b32d265c` 的 19/10 项结果为历史记录，不与本轮 28/11 项重复相加；前轮主页面先展开再聚焦的修复保留。
- VCC 前端、预览及文档回归：58 PASS / 0 FAIL；lint、git diff --check 通过。
- `check-vars` 词法命中 renderer 局部 `dialog`；按 important-variables.md 的显式判定说明，它不是 Main 的 Electron dialog，未修改原生文件选择接口。用户取消分支已由上述真实输入专项验证。
- 页面及数据保护复核：分类切换仍清空选择并用 loadVersion 拒绝晚到列表；四类输入导出继续查询当前对象并传 Main selectionRef；删除只在完整预览后提交原 mode，来源名仍使用 textContent。未修改金额、币种、主键、版本、目录或恢复行为，未新增资金红线项。
- 截图见 [主面板](screenshots/layout-main.png)、[原位取消](screenshots/layout-import-cancel.png)、[数据管理](screenshots/layout-manager.png)、[输入导出](screenshots/layout-input-export.png)、[结果导出](screenshots/layout-result-export.png)、[VCC 操作列](screenshots/layout-vcc-manager.png)、[导出原表期间](screenshots/layout-manager-exporting.png)。截图来自隔离 Electron 中的实际组件与样式，业务 API 为夹具；未把这些检查写成真实资金或目标规模验收。

## Remaining Unknowns

- 当前产品固定 Clear 样式，General 已退役；上述两种窗口及模态操作已验证。真实业务数据处理和原有 Windows/规模/人工验收门禁仍分别记录，不在布局修正中重新宣称通过。
