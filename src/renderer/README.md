# Renderer 现行边界

从根 [AGENTS.md](../../AGENTS.md) 进入本页。设计合同见 [G3 Spec](../../changes/v3.2.10/codex/v3.2.10-renderer-boundaries/spec.md) / [TechDoc](../../changes/v3.2.10/codex/v3.2.10-renderer-boundaries/techdoc.md)，实现、验证及集成分别以 [实施记录](../../changes/v3.2.10/codex/v3.2.10-renderer-boundaries/implementation-notes.md) 为准。本页描述功能分支当前代码，不代表已经发布。

## 应用壳与领域控制器

[renderer.js](../renderer.js) 只装配依赖并持有应用窗口、模块菜单、背景与更新状态。[module-router.js](module-router.js) 冻结 13 个模块注册项，统一导航、面板显示和设置持久化；导航自身不读领域状态。所有生产控制器接收自己的 panel、窄 API 及命名 UI 服务，不能接收或反向读取应用总 state/elements/API。

| 所属模块 | 领域事实与实际入口 |
| --- | --- |
| 网银账单 | [controllers/statement.js](controllers/statement.js)：模式、导出就绪、手工余额提示、导入/导出反馈；配置通过只读快照及订阅获取 |
| 新开账户 | [controllers/new-account.js](controllers/new-account.js)：行 WeakMap、币种选择、表单与生成/导出状态 |
| 资金对账 | [controllers/bank-statement.js](controllers/bank-statement.js)：银行/网关模式、进度、批量导入摘要及结果展示 |
| 对账单修复 | [controllers/recon-id-fix.js](controllers/recon-id-fix.js)：场景选择、类别、结果与导出反馈 |
| 前置资金 / BU / 重复入金 / VCC 业务计算 | [pre-fund](controllers/pre-fund.js)、[bank-bu](controllers/bank-bu.js)、[duplicate-inbound](controllers/duplicate-inbound.js)、[vcc-op-calc](controllers/vcc-op-calc.js)：各自会话摘要、月份、busy 与领域命令 |
| 收单 / 旧 BizOP | [acquiring](controllers/acquiring.js)、[biz-op-legacy](controllers/biz-op-legacy.js)：各自月份/日期选择及进度；旧 BizOP 由下面的统一门面选择 |
| Pending | [controllers/pending.js](controllers/pending.js) 转发 [renderer-pending.js](../renderer-pending.js) 的 scoped 工厂，规则/月份/导入/对账状态私有 |
| Position / VCC 财务 OP / BizOP | [renderer-position-reconciliation.js](../renderer-position-reconciliation.js)、[renderer-vcc-financial-op.js](../renderer-vcc-financial-op.js)、[renderer-biz-op-v327.js](../renderer-biz-op-v327.js) 接入同一 host 与 enter/leave/dispose；BizOP 按真实能力状态选择 v327 或 legacy |

各控制器实现 `enter/leave/invalidate/dispose`。同域重复导航不重绑事件；leave 先检查自己拥有的弹窗，blocked 时不改变当前模块、面板或持久化。通过后推进页面代次，旧读取不能覆盖新访问。离页不等于取消 Main 写入；已提交动作按 Main 结算并按域重读。尚未提交的 Position 导入 token 仍按原取消合同释放。

现有 Preload 的 Pending 进度和窗口最大化订阅现返回只移除自身监听的清理函数，和其他订阅一致；保持原频道/参数/payload及旧忽略返回值的调用兼容。控制器/壳在 dispose 退订；旧回调还保留 disposed 屏障。

VCC OP 每次实际 scan 前撤销旧保存资格，以独立扫描对象及跨导航操作锁绑定F1、统计与F2。未确认的后台扫描不能恢复旧F2；已确认来源在重入、打开F2及save前通过既有computeAmounts探测漂移，保存仍只传beginOp。月份/金额/逐文件核对值不充当不可变文件身份；该IPC还会产生Main Task/活动日志，真实产品验收单独记录。F2将本地提交锁与域关闭资格合并，已销毁视图不接纳迟到DOM更新。

BizOP 将已提交导入／恢复检查的最终反馈保存在控制器，离页只阻止旧 DOM 和弹窗续接，重入显示真实结算；尚未提交的过期文件／保存位置选择使用单独的废弃终态，恢复此前反馈，不伪造后台失败或继续提交。

Statement 没有既有的公开 `sessionStatus` IPC。本次保留本窗口已确认的 Main 命令结果；后台成功恢复按钮/反馈，等待选择的结果只保存原 context，用户再次点击原按钮继续，不自动复活旧弹窗、不再发一次导入。未新增恢复 IPC 或猜测磁盘结果。

## 弹窗入口与权限

- 根创建窗口内唯一 [modal-host.js](modal-host.js) 与 [modal-bridge.js](modal-bridge.js)。host 独占 `#modalRoot` 栈、挂载/移除、owner、关闭资格、焦点与释放；业务不得清空 modalRoot 或直接移除 overlay。
- `openRoot/push/replace/closeOwner` 操作 handle。`push` 指定当前父句柄，子层继承 owner。`canClose` 是同步只读检查，任一 busy 拒绝使普通关闭/替换整次不发生，后继工厂不执行。
- DOM 工厂兼容层用 WeakMap 保存 descriptor；`openModal` 使用延迟工厂，`onMount(handle, scope)` 启动资源，scope 收口监听/计时器及清理。`returnToModal` 只返回仍存活父层，closed 节点不可重挂。
- `handle.closed` 恰好一次结算 submitted/cancelled；disposer 不保存、导出或确认业务。强制 dispose 只用于最终卸载/初始化失败，不能拿来绕过业务 busy。
- [dialogs/app-settings.js](dialogs/app-settings.js) 拥有期限保存队列、批次读取代次及父设置会话。删除子层只持有原 batchId/token，期限保存未结算不得预检/确认，删除提交中祖先不可关闭。
- [dialogs/toolbox.js](dialogs/toolbox.js) 持有本次 splitReadToken/来源/草稿，选择层只拥有控件。单项/行数/多文件转换保留父会话；同步冻结 payload 并锁定提交后只发送一次原 splitExport。取消不导出、不添加 Main 清理 IPC。
- [dialogs/configuration.js](dialogs/configuration.js) 拥有模板、映射、大账号、余额及迁移草稿。数据读取校验视图及请求代次；写入期间沿用对应 busy/确认语义；旧窗口不能接管新窗口。
- 功能收纳的 `onCommit` 保存并接纳 Main 返回的启用列表；同步 busy 阻止导航，原 handle 正常提交关闭后才执行 `onCommitted` 导航。强制销毁不取消已提交写，也不授予旧窗新的导航权限。账单拆分配置的行编辑、单行删除、份数、合并组、金额元数据及规则子层共享父会话提交锁与关闭资格；写入开始使旧删除预检失效。预检失败不删除，原窗口关闭或行重绘后的迟到预检不能续发删除；已提交的配套写继续结算，旧视图不能接管新窗口。父映射窗口每次打开拆分子层前重读配置，父会话、请求和父写代次均有效才挂载，失败不使用旧缓存。按钮返回在异步onClose期间保持原拆分子层并锁定关闭；onClose可选资格上下文只允许原层仍有效的回调更新父缓存，随后精确结束原拆分子层。
- 拆分金额规则与元数据各自提交；`saveAmountConfiguration`在同一父会话提交锁内处理signed／byField清规则链。失败时重读已保存的金额配置，保留原失败提示及未提交的行草稿；不把failed／reject当回滚，不自动重试业务写。重读失败仅接纳已明确成功阶段，暂停本窗口配置写入并提示关闭重开；关闭仍可用。恢复读取和结算均受原handle资格约束。
- [dialogs/scenarios.js](dialogs/scenarios.js) 拥有场景草稿、筛选与渠道选项。临时确认用子层，返回保持父草稿；视图订阅在自己的 scope 中释放。

## 场景命令、失效与共享会话

[scenario-command-service.js](scenario-command-service.js) 是生产唯一场景/渠道写入口。根仅向它注入 raw API，其他消费者使用同一实例：场景 create/update/deleteOne/toggleEnabled/setApplicableChannels/batchDelete/transfer/applyImport，渠道 create/update/deleteOne。新增写方法必须先补 Main 副作用矩阵及回归，再接入 service。

service 私有维护 metadataEpoch、活动写集合、id/category 与 revision；读开始/返回均检查同一 service、同 epoch、无活动写及可信 writer 边界。写开始和结算均失效元数据；未知结算永久撤销该实例的信任，成功查询不能恢复。现有 IPC 无 Main 生命周期身份和旧 writer 完成证明，生产 `writerBoundaryTrusted:false`；依赖旧类别的成功写发 `scenarios-resync-required`，不谎称确定清了哪域；固定 scope 命令仍遵守 Main 原矩阵，不额外重试业务写。

[scenario-change-router.js](scenario-change-router.js) 只消费明确 scope：Bank 普通结果对应 bank-statement；ReconID 及 Bank 网关展示对应 recon-id-fix。未知范围暂禁不确定导出并重读；仅关闭场景窗口只刷新列表，不清结果或已导出反馈。渠道变更只通知配置选项订阅，不使结果失效。确定失效发生在隐藏域时记录待重绘事实，下一次成功读取 Main 状态后清除旧导出反馈；读取失败不吞掉该事实。ReconID 场景下拉每次按 busy 与当前类别的可选场景计算资格，不把旧 disabled 值当业务状态。两域单独记录当前 session 状态读取错误及其覆盖前的反馈；有效成功撤回该错误，确定失效按 Main 状态重绘。新业务、进度或其他读取反馈会使旧错误失去恢复资格，静默重入不覆盖仍有效的欢迎／导出提示。

[shared-recon-session.js](shared-recon-session.js) 仅透传原 ReconID `import/run/clearSession/export/sessionStatus` 并通知结算；保留参数与 `originModuleId`，不复制会话明细或引擎。Bank 与 ReconID 依赖同一实例。

## 配置、经典脚本与兼容入口

[configuration-services.js](configuration-services.js) 私有持有模板/币种/映射数量，返回复制快照；刷新请求代次防止旧读取回写。配置弹窗操作对应窄 API，完成后通知服务刷新，控制器订阅自己的视图。

[index.html](../../index.html) 明确加载顺序：纯模块 → 宿主/服务/控制器定义 → dialogs 领域工厂 → 公共 Dialogs/Previews 与已有独立控制器 → 应用壳。定义阶段不发业务 IPC。[renderer-dialogs.js](../renderer-dialogs.js) 保留公共提示、部分领域选择工厂及命名转发；不存在第二份配置或场景状态。`legacy-controller-adapter.js` 和生产临时 host 全局已移除。

保留的兼容入口是旧 DOM 工厂返回形状、Pending/Position 工厂别名及显式预览 facade，供现有测试/预览脚本使用。移除条件是最后一个对应调用方迁移并通过原行为用例；不得仅因主页面迁出就删除这些入口。预览只接收 currentModule 只读值、复制的配置/行快照及命名方法，异步预览等待对应 route.ready、检查代次和当前句柄；不获取生产领域可变 state。

## 当前检查与证据边界

- `npm run lint` 已覆盖全部 Renderer；四个大脚本不再排除 `no-undef`。这是当前可执行基础检查，不能替代行为验收。
- [modal-host.test.js](../../tests/unit/renderer/modal-host.test.js)、[module-router.test.js](../../tests/unit/renderer/module-router.test.js) 验证事务关闭、生命周期、blocked 导航和资源释放。
- [scenario-change-routing.test.js](../../tests/unit/renderer/scenario-change-routing.test.js) 用当前 Preload 表面、实际 Main handler AST 与真实 SQLite 仓储验证 AC19/20；[scenario-write-boundary.test.js](../../tests/unit/renderer/scenario-write-boundary.test.js) 递归审计当前生产写调用及唯一 service 装配。
- [Electron 工厂入口](../../scripts/test-renderer-lifecycle.js)：`node scripts/test-renderer-lifecycle.js`，也通过 [integration/renderer-lifecycle.js](../../scripts/integration/renderer-lifecycle.js) 自动纳入 integration-runner。真实 DOM、经典脚本和工厂；API 受控，隔离 userData/Documents，不加载产品 Main。

G8 尚未合入此分支，未声明 active 机器规则或例外。当前用实际源码审计、lint 和行为测试；G8 集成后由其配置登记已实施边界。Main IPC、数据库 schema、金额/匹配/输出内容及 Archive 删除资格未改变，对应业务规则正文无需更新。完整 Main 启动、正式产品 GUI、Windows、Excel/WPS 和发布门禁状态必须单独查看实施记录。
