# Renderer 运行时错误盲点 / 跨文件作用域定时炸弹

> `renderer.js` 的运行时错误（`ReferenceError` 等）完全在 `release-check` 覆盖之外。
> 来源：v2.1.16-beta.6 `escapeHtml` 未定义事故（beta.1 潜伏到 beta.6，PR #65）。

## 坑：自动化测试照不到 renderer

- `release-check`（smoke + unit + integration）只在 node 里测**后端/引擎**，**不加载 `renderer.js`**（它是浏览器端脚本，依赖 DOM / window / contextBridge，node 跑不起来）。
- `node --check src/renderer.js` 只查**语法**，查不出运行时 `ReferenceError`（调用了一个本文件作用域拿不到的函数）。
- 没装 jsdom / playwright / puppeteer，preload 又用 `contextBridge.exposeInMainWorld` 冻结接口 → **无法在 node 侧自动化触发 renderer 流程**（batch-import 还要人工选文件）。
- 结论：renderer.js 里"引用了一个作用域拿不到的符号"这类 bug，全链路 CI 全绿，只在用户实际点到那条 UI 路径才崩。

## 典型案例：`escapeHtml` 跨文件作用域

- `renderer.js` 顶层 **16 处**引用 `escapeHtml`，但它只定义在 `renderer-dialogs.js` 的 IIFE 内 → renderer.js 作用域访问不到 → 运行到时 `ReferenceError: escapeHtml is not defined`。
- 潜伏 beta.1→beta.5（5 个版本）：这些 UI 路径（批量导入明细框、手动余额录入、模板重命名、大账号编辑…）平时没被手测覆盖到，全是同一颗雷。
- 用户首次走「批量导入对账单」→ `buildBatchImportSummaryHtml` 求值 `escapeHtml(...)` → 崩 → `openModal(createAlertDialog(...))` 参数都没构造出来 → 明细框弹不出 → 后续退款提醒也无从触发。
- 修复：在 `renderer.js` 顶层补一份 `escapeHtml`（function 声明 hoist，一次覆盖全文件引用）。

## 定位套路（renderer runtime bug）

1. 在可疑路径加**诊断 log**：`console.log('[模块·诊断] 关键变量 =', x, '| 分支 =', y)`，打印 IPC 返回 / 状态 / 走哪条分支。
2. 让用户重现 + 打开 DevTools（**Cmd+Option+I** / Ctrl+Shift+I）→ Console → 复制红色报错（含 `文件:行号` + stack）。
3. stack 直接指向出错行，比逐行盲读代码快几个数量级。本次正是诊断 log 显示 `batchImport status = ok` 排除了"导入失败"，红色报错 stack 直接点出 `escapeHtml is not defined @ renderer.js:3487`。
4. 定位后删诊断 log；关键路径可保留防御 `try-catch`（如状态刷新失败不该阻断"导入明细框"这种主反馈）。

## 防范建议（待落地，见 [backlog](./backlog.md)）

- 给 `renderer.js` 加一道静态扫描：检测顶层引用的疑似全局 helper（`escapeHtml` 类）在本文件作用域是否有定义；跨文件复用的 helper 应提到双方都能 require 的共享模块，或各文件自带一份。
- renderer 关键交互链路（导入反馈、导出）入口加防御 `try-catch`，避免单点异常静默吞掉整条链路、让用户看到"点了没反应"。
