# PR5 页面布局纠偏

## Task Brief

- Goal：落实 E5 Spec §6 已确认的 VCC 财务 OP 页面布局，修复业务 OP 主页面额外出现“导出数据”的偏差。
- Context：当前启用提交 `9c1784d2`；E5 压缩包根目录 spec.md §6.1—6.4 与确认版要求一致。参考现有 `index.html` 的 `vccFinancialOpModulePanel` 及 `renderer-vcc-financial-op.js` 的 `openDataManager`。
- Constraints：只修正前端结构、样式与入口位置；保留现有 Main、IPC、Task、输入版本、导出目标、删除范围及取消协议。保留正在运行的真实业务操作，不用真实数据做删除验证。
- Done when：主面板与 VCC 的两行位置及尺寸一致；“导出数据”只能从数据管理进入；数据管理恢复左侧分类、右侧表格、底部操作；实际 Electron 布局及取消/删除预览回归通过。

## Unknowns Register

| 项目 | 结论与证据 |
| --- | --- |
| 对齐哪个 VCC 模块 | PROBE 已确认：E5 明确 VCC 财务 OP 校验，不是 VCC 业务 OP 计算 |
| 需求是否改变过主布局 | PROBE 已确认：E5 延续两行布局要求；PR5 实现成单排工具栏，属于实施偏差 |
| “导出数据”是否应该取消 | PROBE 已确认：四种输入导出仍需要，入口应沿用 VCC 的数据管理操作区 |
| 数据管理的结构 | PROBE 已确认：VCC 左侧三类导航、右侧列表、底部操作；业务 OP 保留自身日期/列序/选择和删除合同 |

## Decisions / Deviations

- 主面板第一行左侧为导入/运行，右侧为差异结果导出；第二行左侧为状态框，右侧为数据管理。临时错误报告、恢复和取消只在需要时显示。
- 数据管理采用 VCC 的分类导航与表格布局；底部沿用“导出”按钮，打开“导出数据”窗口，仍提供四类当前输入导出，不从归档恢复旧输入。
- 原生 dialog 继续用于隔离模态焦点和取消保护，外观复用现有 VCC 对话框样式；不引入 VCC 人工调账、归档或解归档业务。
- 之前 UI 验收仅证明动作和字段可用，未比较 VCC 与业务 OP 的结构和几何位置；本次补充实际浏览器尺寸对照。

## Evidence

- `verify-ui.js`：19 PASS，包含从真实 index.html 提取 VCC 面板进行 1200×900、1080×760 两档几何对照，四类管理内导出、列序、来源名转义、删除影响、取消及旧模式路由。
- `verify-ui-cancellation.js`：10 PASS，真实 Electron 鼠标/键盘输入，覆盖移入管理页后的双层输入导出、结果导出、删除/保留结果、发布保护与晚到取消响应。初次发现主页面隐藏操作区展开前调用 focus，已改为先展开再聚焦；未放松断言。
- VCC 前端、预览及文档回归：58 PASS / 0 FAIL；lint、git diff --check 通过。
- `check-vars` 词法命中 renderer 局部 `dialog`；按 important-variables.md 的显式判定说明，它不是 Main 的 Electron dialog，未修改原生文件选择接口。用户取消分支已由上述真实输入专项验证。
- 页面及数据保护复核：分类切换仍清空选择并用 loadVersion 拒绝晚到列表；四类输入导出继续查询当前对象并传 Main selectionRef；删除只在完整预览后提交原 mode，来源名仍使用 textContent。未修改金额、币种、主键、版本、目录或恢复行为，未新增资金红线项。
- 截图见 [主面板](screenshots/layout-main.png)、[VCC 参考](screenshots/layout-vcc-reference.png)、[数据管理](screenshots/layout-manager.png)。截图来自隔离 Electron 中的实际组件与样式，业务 API 为夹具；未把这些检查写成真实资金或目标规模验收。

## Remaining Unknowns

- 当前产品固定 Clear 样式，General 已退役；上述两种窗口及模态操作已验证。真实业务数据处理和原有 Windows/规模/人工验收门禁仍分别记录，不在布局修正中重新宣称通过。
