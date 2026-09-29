# Renderer 架构登记对齐

本片段对照 G3 TechDoc §4–6、G3 Renderer README、G8 Spec AC-05 / AC-19 与 TechDoc §4.4 / §5 核对当前生产装配。它不改变 Renderer/Preload 业务接口或资金计算。正式配置由主任务整合；`renderer-boundaries.json` 是冻结的 20 个完整边界对象。

- 准确登记真实经典脚本导出：`BankStatementController`、`ReconIdFixController`、`StatementController`，`__preFundController` / `__bankBuController` / `__duplicateInboundController` / `__acquiringController` / `__bizOpLegacyController`，以及 `ScenarioDialogs.createScenarioDialogs`、`ConfigurationDialogs.createConfigurationDialogs`。
- Pending 登记原实现与生产 facade 两条真实消费边，工厂选择 `createPendingController`；旧 `createRendererPending` 兼容入口没有被错误当成生产 controller 合同。
- Bank / ReconID 只有共同 `sharedReconSession`；分别登记 Bank 的 bankStatement API、只读 scenario 与 linkedTable 配置，以及 ReconID 的类别设置与同一共享会话。各领域的 API 表面取自本版本对应 Preload namespace，冻结到完整方法清单，之后 namespace 新增方法不会自动获准。
- Statement / Configuration 按 G3 配置职责登记 `files/monthlyBalance/templates/accountMappings/bigAccount/balanceAdjustment` 等分组及具体方法。`ui` 的 modalHost、modalBridge 按实际返回方法展开；命名 dialog 回调逐个登记。`initialInfo` 与 `initialBillCategory` 追溯到既有 `app:get-info` IPC 返回的可序列化数据，不作为可调用 authority 方法。
- VCC Financial OP 的 differenceApi 精确限定两项十进制函数，reviewProjection 精确限定两项函数及三项纯字面量数组常量。公共纯模块实际 globals 与脚本依赖顺序已登记。Position 仍保留调用端既有的 `openModal/closeModal` 命名兼容转发；工厂内部不消费这两个参数，不额外授权其他域对象。
- 公共 router、scenario command/router、shared session、configuration service 与 modal bridge 均登记真实 Renderer 消费者及行为验证入口；服务没有获取任意其他 controller 实现的 allowedLocal 通行权。现有 factory 参数差异由 G3 现行合同/真实装配解释，不沿用早期统一四参数模板。

## 静态检查支持与失败边界

`renderer-contracts.js` 只读取 AST，支持准确 Preload namespace、命名工厂的单一可解释返回值、显式跨文件和同文件参数转发、静态对象 spread、确定领域 DOM 查询、有限数组/Object.keys 命令表产生的方法。能力对象初始声明后的成员写入也计入允许集合。

以下保持失败关闭：完整 desktopApi/state/elements；不明确的面板/动态 selector；不透明 helper/条件返回；未知 spread/成员键；未解析的可调用参数；能力对象被 Object.assign/defineProperty 或其他非纯观察 helper 接管；全局 provider 重复赋值。该检查不执行业务、IPC、getter 或回调，也不以静态 PASS 替代 GUI/资金验收。

schema 只向 allowedApiFields 的固定键集合补入 modalHost、modalBridge、services、subscriptions、legacyController、differenceApi、reviewProjection。没有新增未参与历史强度比较的配置顶层字段；原 allowedApiFields 强度比较覆盖每一个键及其方法集合，新测试证明增加任一这些参数的方法权限仍触发 ARCH-POLICY-HISTORY。

## 验证

- 本 Renderer 片段对真实生产源码检查：20 active、0 partial、0 Renderer 诊断，见 `renderer-policy-check.json`。检查保留既有扩展 worker 图的两条精确历史循环例外，没有使用 Renderer 豁免。
- 原 rules/adversarial/review-regressions/review-round2 聚焦套件：57/57 PASS。
- 新 `tests/unit/architecture/release-renderer-policy.test.js` 包含真实生产登记检验、Preload namespace 扩权、有限命令表扩权、未知对象写入、领域 DOM 与整对象对比、同文件 helper 伪装完整 API、Object.assign/defineProperty/迟到全局替换的实际 VM 反例，以及新增参数的历史强度检验。正式片段整合后已执行，8/8 PASS，见 `new-tests.log`；其中真实生产登记验证包括当前源码、消费者、脚本顺序及行为入口。
- 独立审查的参数叶和对象 mutation 探针已用于补回归；独立复验固定 helper SHA256 `bb4cb2ca821fd639fc12b04d5606d14ac36828f93dfc5f3bfc0660f3dc72022c`，5 条已确认越权路径均重新产生诊断，合法 UMD scoped 继续通过。原始与复验 JSON 位于相邻 `independent-review/`。`forward(api){return {read:api.read}}` 接收完整 API 再摘取方法仍保守拒绝，未声称支持所有合法 JavaScript 别名形式。完整 release-check 由主任务对最终组合执行。
