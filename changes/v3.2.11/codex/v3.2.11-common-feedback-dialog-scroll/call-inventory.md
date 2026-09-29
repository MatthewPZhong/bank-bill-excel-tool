# 公共反馈弹窗调用与包装清单

日期：2026-09-29。分支：`codex/v3.2.11-common-feedback-dialog-scroll`。基线：`main@18b82b4328cf5e00c1b2549d373a5b2f2677215c`；本次未提交工作区。

扫描 `src/**/*.js` 的命名公共工厂调用及 `ui.alert`／`ui.confirm`，使用 Acorn 排除注释、字符串和参数声明；再核对 `renderer.js` 的装配、别名来源、宿主转接和包装层 DOM 操作。逐表达式行号与各文件 SHA-256 见 [call-inventory.json](./implementation-evidence/call-inventory.json)。共 15 个生产文件、191 个匹配调用表达式，包含包装转发本身，**不是去重后的业务入口数，也不代表逐调用点运行验收**。预览文件另有 2 个匹配调用。

| 文件 | 匹配调用数 | 注入来源／代表性路径 | 布局包装检查 |
| --- | ---: | --- | --- |
| `src/renderer-dialogs.js` | 27 | 两个工厂定义；前置资金临时表、链接表、ADM／BOC、账户映射等反馈 | 工厂统一加标记；不改业务回调、参数和消息生成 |
| `src/renderer/dialogs/scenarios.js` | 63 | `ScenarioDialogs` 的 `ui.createAlertDialog/createConfirmDialog` 来自公共工厂 | 无覆盖公共卡片 class 或搬动 footer 的包装 |
| `src/renderer/dialogs/configuration.js` | 44 | `ConfigurationDialogs` 注入；模板、大账号、映射、余额等 | `showUnmaintainedBigAccounts()` 仅 `classList.add('big-account-unmaintained-alert')`；正在取消提示仅禁用按钮；均保留布局标记 |
| `src/renderer/dialogs/toolbox.js` | 1 | `showToolboxAlert()` 汇集 merge、read、split 成功／失败 | 旧 `scrollable` 仅追加 `toolbox-split-rows-result`，不重新构造正文或 footer |
| `src/renderer/dialogs/app-settings.js` | 1 | 存档中心删除确认；由 `renderer.js` 注入公共 confirm | 失败时向 `.alert-body` 追加 `.archive-delete-confirm-error`；不搬动 footer；追加后的真实布局回归通过 |
| `src/renderer/controllers/bank-statement.js` | 2 | `ui.alert/ui.confirm`；本地 `alert()/confirm()` 包装 | `renderer.js` 的 `domainModalHost.openRoot` 转接 `modalBridge.openModal`，仍执行注册的 `onMount`；只包装提交资格，不改 DOM |
| `src/renderer/controllers/recon-id-fix.js` | 1 | `ui.alert`；本地 `alert()` 包装 | 同上，保留 owner／代次检查与原 DOM |
| `src/renderer/controllers/pre-fund.js` | 3 | `domainUi.alert` 转成本地 `createAlertDialog` | 透传参数；公共管理页另由工厂处理反馈链 |
| `src/renderer/controllers/bank-bu.js` | 4 | `domainUi.alert` 转成本地 `createAlertDialog` | 透传参数，无 DOM 改写 |
| `src/renderer/controllers/vcc-op-calc.js` | 4 | `domainUi.alert` 转成本地 `createAlertDialog` | 透传参数，保留原前 N 条消息展示规则 |
| `src/renderer/controllers/statement.js` | 2 | `ui.createAlertDialog` 注入 | 普通公共反馈；`ui.alertNative` 是系统弹框，不计入 |
| `src/renderer/controllers/biz-op-legacy.js` | 1 | `ui.createAlertDialog` 和 `ui.modalBridge.openModal` | 仅包装 owner／反馈，无 DOM 重排 |
| `src/renderer-pending.js` | 27 | `ui.createAlertDialog/createConfirmDialog`，兼容旧 deps 注入 | 根／子层均经 bridge；没有覆盖公共 class 或操作区 |
| `src/renderer-position-reconciliation.js` | 3 | 公共 alert／confirm 参数注入 | 公共反馈纳入；账户映射 `showNestedAlert()` 是独立工厂，见下表 |
| `src/renderer.js` | 8 | Shell、设置、应用升级及公共工厂对领域模块的装配 | 保留原日志选项、关闭和回调 |

`duplicate-inbound`、`new-account`、`acquiring` 接收 `domainUi`，当前没有实际调用公共 `ui.alert/ui.confirm`；`acquiring` 的 `ui.confirmNative` 不属于公共 DOM 工厂。`main.js`、`preload.js` 的文本命中没有对应公共调用表达式。

本次未发现需要另改的公共包装层；不依赖逐业务入口新传滚动参数。保留两套旧局部保护，公共外层仍只有一个主要正文滚动区。实际业务控制器和包装的回归证据在新增 fixture 与完整生命周期套件中；静态盘点不外推为全部业务已 GUI 手测。

| 排除入口 | 依据与处理 |
| --- | --- |
| 平盘账户映射 `showNestedAlert()`，OOS-01 | 自行创建 `.modal-card.alert-card`，无公共标记。本次用真实控制器触发保存失败，核对原关闭回调；不宣称已修复，也不要求既有裁剪缺陷必须保留才算通过 |
| VCC 财务 OP `showMessage()` | 独立 `.vcc-fin-op-dialog-body`，按钮在正文内，保留原滚动行为；真实控制器和鼠标关闭回归通过 |
| 配置模块其他自行创建的同名 alert-card | 同名类不自动纳入；专用选择器不命中 |
| 管理表格、前置资金日期删除表单 | 结构保留，表单校验和禁用状态不被公共规则改变；后续经公共工厂打开的提示仍纳入 |
| 系统原生 alert／confirm | 无公共 DOM 卡片，不在本次范围 |
| `renderer-previews.js` | 预览装配单列，不计入生产调用数 |
