# G3 Renderer 边界实施记录

本记录为唯一切片索引；设计合同见 [Spec](spec.md)、[TechDoc](techdoc.md)，五项标准见 [总索引 §6.2–§6.4](../../README.md#slice-completion)，实际入口见 [Renderer 现行边界](../../../../src/renderer/README.md)。设计稿的审查通过与“尚未实施”保留原快照含义，实际进度以下表为准。

- 分支：`codex/v3.2.10-renderer-boundaries`。
- worktree：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-renderer-boundaries`。
- 基线与当前 HEAD：`11086a3cbf632a30adbcfa796e4cd81810c5aef9`（本地 main / v3.2.9）。全部实施差异未提交；没有推送、PR、合并、升版或发布。
- 输入：从用户指定主工作区读取并复制 G3 Spec/TechDoc、总索引及 review-response。其他治理项与审查报告保留主工作区绝对链接，避免副本索引指向不存在的材料；未改主工作区输入文件。
- 当前状态：第四轮复审确认R3-01已修复，在整改增量及相关恢复、重试、弹窗组合范围内未发现新的可执行缺陷。该轮649项受影响单测、206项隔离Electron工厂、22项独立保存／恢复矩阵、2项独立mapping组合及lint／smoke通过；另3项独立探针因执行器异常未完成。R06／整项G3的完整门禁、产品／平台、资金人工复核与集成验收仍未完成。当前验证状态见末尾第四轮复审接收记录。

“集成状态”指合入 release／其他治理功能分支；本 worktree 内的生产装配已完成。下表及 R1–R5 正文保留首轮实施事实，修后当前证据以末尾审查整改记录为准。

| 切片 | 实现状态 | 验证状态 | 集成状态 |
| --- | --- | --- | --- |
| R1 modalHost 与弹窗闭合 | 已实现 | 专项及最终Renderer整组通过；完整门禁未完成 | 未集成 |
| R2 静态导航与生命周期 | 已实现；过渡adapter已删除 | 路由11项、实际装配/卸载6组通过；完整门禁未完成 | 未集成 |
| R3 场景服务与 Bank/ReconID | 已实现；全部写入口/六类渠道订阅已接入 | Main/SQLite/controller31项、service44项、写边界3项、场景DOM11组通过 | 未集成 |
| R4 其余领域控制器 | 已实现；取消/迟到/busy收尾已修复 | 专项单测136项、Position/VCC/BizOP真实DOM33组通过 | 未集成 |
| R5 Statement/NewAccount/配置 | 已实现；身份绑定与写后返回已修复 | Statement11组、NewAccount5组、配置24组、配置服务6项通过 | 未集成 |

## R1：唯一宿主与父子弹窗会话

**职责与边界。** 原 renderer/dialogs 的多个挂载入口、VCC 自建遮罩、Position 弹窗以及 Pending/BizOP 等调用都转到 [modal-host.js](../../../../src/renderer/modal-host.js)。host 独占栈、关闭原子预检、挂载/移除、焦点、owner 与资源释放；[modal-bridge.js](../../../../src/renderer/modal-bridge.js) 只把旧 DOM 工厂转为同一 descriptor/handle。

**调用方与兼容。** 两个公共入口、Settings/Toolbox、配置/场景、Pending、Position、VCC、BizOP 和对应预览均使用同一实例。生产临时 host 全局已移除。保留旧 DOM 返回形状、命名工厂转发及必要测试别名，原因是现有预览/脚本仍消费；最后一个调用者迁移且同类业务回归通过后才移除。父子返回使用 push/close 或 returnToModal，不重挂 closed 节点。

**业务行为。** 对应 AC01–07/14/17/18。保存 busy 时普通关闭/替换整次拒绝；关闭结果及最终清理一次；链接表/映射/告警返回保留父草稿；Settings 保留期限队列和原 delete token；Toolbox 保留 splitReadToken/不可变 payload，单项/行数/多文件至多提交一次。未新增 Main 清理 IPC，前端销毁不取消已提交后台写、不伪造数据回滚。

**验证证据。** modal-host Node 行为测试；Electron app-settings、toolbox、shared-dialogs、legacy-dialogs、vcc-position、pending-controller、existing-controllers、configuration-dialogs 工厂。原存档删除19项、静态合同28项和工具箱源合同继续保留，源码位置按实际模块更新。最终命令与计数见文末证据表；测试为受控 API + 真 DOM，不是产品 Main 端到端证据。

**当前规则入口。** 根 AGENTS → [Renderer README](../../../../src/renderer/README.md)「弹窗入口与权限」。G8 未集成，无 active 机器配置/例外；当前通过全生产调用扫描、host 行为测试及 lint 检查。Archive 删除资格、保存参数、Side-DB 生命周期未改，对应业务规则正文无需更新。

## R2：静态模块路由

**职责与边界。** [module-router.js](../../../../src/renderer/module-router.js) 管理固定 13 项注册、当前模块、导航代次及持久化；调用 controller 的 enter/leave/invalidate/dispose，不访问领域 state。renderer.js 的 setCurrentModule 只转发 navigate。

**调用方与兼容。** 13 个现有模块全部接入实际控制器；R2 过渡 legacy-controller-adapter 已删除。BizOP 的 v327/legacy 选择在自身门面内完成，不成为路由业务分支。模块菜单/快捷键是应用壳命名转发。

**业务行为。** AC08/09/12：leave 被 busy modal 拒绝时，当前模块、面板与持久化不变；同域重复 navigate 不重入、不重绑；旧 enter 不改变新导航结果。离页后的写仍按 Main 结算，页面请求代次只决定能否渲染。

**验证证据。** module-router 11 项，包括 A/B/A、拒绝、重复和销毁；application-shell 用实际 index、Preload 表面及全部经典脚本，未知 API 立即失败，已验证完整 initialize/13域循环/菜单与 busy 导航。最终清理及整组证据见文末。

**当前规则入口。** Renderer README「应用壳与领域控制器」「配置、经典脚本与兼容入口」；ESLint 不再排除四个旧 Renderer 脚本。G8 未集成；没有新增业务路由或设置键，现有模块 ID 不变。

## R3：场景命令与共享结果

**职责与边界。** [scenario-command-service.js](../../../../src/renderer/scenario-command-service.js) 拥有元数据 epoch、活动写、可信边界与事件 revision；[scenario-change-router.js](../../../../src/renderer/scenario-change-router.js) 只消费失效/重同步 scope。BankStatement 与 ReconID 私有状态各迁入自己的 controller；共享引擎仅经 [shared-recon-session.js](../../../../src/renderer/shared-recon-session.js) 的五个原方法，不复制会话。

**调用方与兼容。** 场景8个写方法、渠道3个写方法只经根创建的唯一 command instance。预览仅设置复制草稿；复制流程最终调用 create。旧“任意场景关闭即清全部结果”的反向刷新已移除。静态审计递归检查 src 生产调用、解构/别名/计算属性/bind 等旁路；读API及原结果形状保持。

**业务行为。** AC10/11/15/16/19/20；固定命令遵循 Main 原矩阵；字段 category 与 invalidationScope 分开；失败不发成功，单纯关闭不清结果或导出反馈。渠道通知只重读选项并保留合法选择。Bank 网关和 ReconID 使用同一 Main 结果，两域明确失效与未知重同步分别处理。

**R9 决策。** 现有 IPC 不提供 Main 启动身份/旧写终止证明，生产默认不可信；新窗口/新 service 或成功 list/get 都不能恢复信任。依赖旧类别的成功写使用 resync，固定 scope 命令仍确定通知。测试建立独占真实临时仓储的明确可信前提，以检验 ID 复用、epoch 与交错；不能把该测试前提当生产保证。写前/写后失效、补读跨写、失败/未知结算、applyImport/batchDelete 全表失效均不额外重试业务写。

**验证证据。** scenario-change-routing31项从实际 Preload 表面到实际 Main handler AST、真实 `DatabaseSync(':memory:')` 仓储和当前 controller，含双向类别 ID 复用与两域/共享网关结果对照；scenario-command-service44项；scenario-write-boundary3项；scenarios Electron 工厂包括父子返回、同服务通知、迟到读取及重复完成。真实 Main handler 的依赖按 fixture 控制，没有加载产品 Main 进程/TaskLifecycle/实际输出，因此不能表述为完整产品端到端验收。

**当前规则入口。** Renderer README「场景命令、失效与共享会话」；全写审计为当前分支可执行边界证明；G8 active 配置待集成。Main、DB仓储和业务算法代码没有改变，原 IPC/schema/结果命令矩阵无需重定义。Preload 仅为现有两个订阅返回对应监听的清理函数，见下述资源收口决定。

## R4：剩余领域生命周期

**职责与边界。** preFund/bankBU/duplicateInbound/vccOpCalc/acquiring/bizLegacy 的状态从根迁到 [controllers](../../../../src/renderer/controllers)；Pending scoped 工厂保留原文件正文，Position/VCC/BizOP 现有独立文件接入同一生命周期。各域 panel 内绑定，私有读代次/动作代次及清理列表管理监听和迟到响应。

**调用方与兼容。** 根只注入对应 domain API、panel 和命名 UI 服务；所有路由使用实际实例，不保留根镜像状态。BizOP legacy 是 v327 门面消费者；Pending/Position 旧名字供现有脚本测试兼容，新生产调用均 scoped。预览通过明确快照/命令，不反向访问状态。

**业务行为。** AC08/09/12/13/14；保留原金额、月份、导入/运行/导出和错误反馈。VCC 离页后不继续弹旧确认，重入从当前归档事实刷新。Position 导航取消尚未提交的银行/源表 token 时仍执行原清理，已提交 token 不取消。BizOP 原存档/删除/恢复条件、选择参数与能力回退不改；旧读取不能在父层结束后续开确认或发起尚未提交的导出。

**验证证据。** r4-domain-controllers33项、r4-controllers与Pending历史反馈、VCC/Position旧73项、BizOP业务/恢复16项；existing-controllers、vcc-position、pending-controller等实际工厂。独立复查的 token 清理与同域迟到读先复现后修复，最终计数文末更新。没有把假 API 财务样例称作平台/真实账单验收。

**当前规则入口。** Renderer README 模块表、导航/销毁协议及兼容入口；无新的存储目录、资金计算或公共 IPC，业务规则正文无需更新。G8 未集成。

## R5：Statement、NewAccount 与配置闭合

**职责与边界。** [statement.js](../../../../src/renderer/controllers/statement.js) 拥有模式、导出与手工余额反馈；[new-account.js](../../../../src/renderer/controllers/new-account.js) 拥有行 WeakMap/币种/表单；[configuration-services.js](../../../../src/renderer/configuration-services.js) 拥有配置快照及读取版本；配置草稿归 [dialogs/configuration.js](../../../../src/renderer/dialogs/configuration.js)。根 state 只剩应用壳字段，生产工厂不收总 state/elements/API。

**调用方与兼容。** 模板/映射/大账号/余额/迁移工厂从 Dialogs 命名转发；Statement/NewAccount 和显式预览 facade 消费复制配置。root 旧业务实现、状态镜像及最后 adapter 已移除；经典脚本顺序与 lint 覆盖同步更新。

**业务行为。** AC09/12/13/14：虚拟模板 ID、月度模式、错误报告、手工余额/大账号/记忆顺序流程保持。Statement 没有公开 sessionStatus；后台命令事实保留、结果按钮恢复，迟到的待确认 context 由用户再次点击继续，不自动复活旧窗、不重复 IPC。月度装配/导出范围禁止重复提交及 busy 关闭，已销毁窗口不能关新窗口。账户映射切模板需要读取 epoch，加载中不能提交旧行，保存冻结原模板 ID/快照；模板管理与迁移迟到不接管新层。

**验证证据。** Statement实际index+完整工厂11组，NewAccount实际表单5组，配置服务6项；配置窗口读写竞态的新反例先1/9通过、8项精确失败后再修复；最终配置工厂24/24通过。模板重命名/导入/删除/映射及子窗写后返回使用同一write scope，主子模板关系取提交快照，手工余额覆盖仍以原context继续下一项。该反例证明原显示A/保存B串写风险，不涉及真实账户数据。最终修复及整组状态见文末。

**当前规则入口。** Renderer README「配置、经典脚本与兼容入口」及ESLint全Renderer no-undef；配置草稿/请求归属更新，业务映射规则/余额算法/schema不变，无需改写其契约正文。G8 未集成。

## 资源收口与测试组织决定

- 实际 Preload 的 `window.onMaximizedState` 与 `pending.onImportProgress` 原先不返回清理函数；只做 disposed guard 无法达到订阅资源释放要求。本次沿用 appUpdate 等已有模式，返回移除本次 wrapped listener 的函数。频道、事件 payload、调用参数和旧忽略返回值的调用方都保持兼容；没有新增 IPC。应用壳和 Pending 消费该返回值，在最终 dispose 退订；原函数引用即使被手工迟到调用也不改 UI。
- 两项 actual-Preload/EventEmitter 回归验证原 payload、多观察者、仅移除自身与重复取消；实际整壳卸载验证订阅归零、静态事件不生效及 host 只清一次。
- TechDoc 拟设的 controller-contract 单文件按域拆到 r4-controllers/r4-domain-controllers、scenario-change-routing 和 Statement/NewAccount/Pending/Position/VCC/BizOP 实际工厂，并以 application-shell 的13域注册/事件验证覆盖装配；没有通过单独检查文件名或生命周期方法存在来替代行为。

## 验证过程与证据边界

- 初次全单测在并行实施期间运行：8,159 tests / 31 fail / 4 skipped，耗时670s，日志 `/private/tmp/g3-unit-all.log`。这不是冻结最终差异证据；多项失败源于旧源码测试读取位置，已按实际入口迁移并保留业务断言。
- 其中1024真实Task Inspector大规模用例只返回`ERR_SQLITE_ERROR`，没有底层message，不能断言根因；R3.2.4历史exact evidence日志明确出现checkout `No space left on device`及`mkdtemp ENOSPC`。对应Backend/历史validator与test/helper相对HEAD无差异。同轮磁盘耗尽是前一项的资源线索，不能据此确定归因。最终完整门禁另记。
- 中间集中回归：`node --test $(rg -l 'renderer\.js|renderer-dialogs|renderer-pending' tests/unit --glob '*.test.js') tests/unit/renderer/*.test.js`，497/497 PASS，日志 `/private/tmp/g3-focused-all.log`。后续修复需要补跑受影响验证，不把该次通过自动扩为最终全部通过。
- 完整应用预览 `node scripts/render-modal-preview.js toolbox g3-toolbox.png` 在加载 Renderer 前被未改 Main 的 ArchiveCenter 初始化阻塞：`BIZOP_ACTIVATION_STARTUP_REQUIRED`，要求持有单实例锁且业务窗口尚未开放。只终止本次隔离预览进程，没有弱化恢复前置条件。真实工厂/实际Renderer装配测试不代替产品Main启动。
- Electron工厂runner隔离userData/Documents，仅受控API；没有真实删除/业务导出。新增 `scripts/integration/renderer-lifecycle.js` 已被现有integration-runner自动发现，完整runner的清单只在全PASS时自动同步。

- 首次完整 `release-check` 在 smoke 的旧Renderer函数路径合同失败后停止，未运行后续unit/integration；适配两份smoke的真实控制器来源后，完整smoke通过。修前日志 `/private/tmp/g3-release-check-smoke-before.log`，修后日志 `/private/tmp/g3-smoke-migration-fixed.log`。
- 中间真实Electron整组118/118通过，之后继续收口模板写后返回及Preload退订；118条只证明当时内容，最终计数另记。

## AC 证据导航

以下链接定位实际执行入口；最终通过/失败以文末冻结验证为准，Windows/Excel/WPS及产品Main启动不混入这些局部结论。

| AC | 当前自动化证据入口 |
| --- | --- |
| 01 / 02 / 03 / 06 | [modal-host](../../../../tests/unit/renderer/modal-host.test.js)：事务关闭、异常清理、busy、焦点/Tab/Escape/遮罩；[vcc-position](../../../../scripts/renderer-lifecycle/fixtures/vcc-position.js)验证实际VCC月份Promise经公共替换恰好取消一次 |
| 04 / 05 | [shared-dialogs](../../../../scripts/renderer-lifecycle/fixtures/shared-dialogs.js)、[configuration-dialogs](../../../../scripts/renderer-lifecycle/fixtures/configuration-dialogs.js)：实际父子层、合法空表、失败禁保存、旧读取 |
| 07 | [application-shell](../../../../scripts/renderer-lifecycle/fixtures/application-shell.js)、[vcc-position](../../../../scripts/renderer-lifecycle/fixtures/vcc-position.js)：实际脚本加载、公共/独立工厂同host；[生产挂载入口清单](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/logs/modal-root-inventory.log)定位全部modalRoot引用、唯一宿主append/remove |
| 08 / 09 | [module-router](../../../../tests/unit/renderer/module-router.test.js)、[r4-domain](../../../../tests/unit/renderer/r4-domain-controllers.test.js)、[r4-controllers](../../../../tests/unit/renderer/r4-controllers.test.js)及各域Electron fixture：重复导航、晚到、dispose |
| 10 | [scenario-command-service](../../../../tests/unit/renderer/scenario-command-service.test.js)、[scenario-change-routing](../../../../tests/unit/renderer/scenario-change-routing.test.js)：命令矩阵/失败/关闭 |
| 11 | [共享会话及真实Main接缝](../../../../tests/unit/renderer/scenario-change-routing.test.js)：同session来源身份、共享网关结果、实际Preload转换；原Recon Service golden继续保留 |
| 12 | [实际13域装配](../../../../scripts/renderer-lifecycle/fixtures/application-shell.js)及上列域测试：窄API/panel、私有状态、统一生命周期；root不保留领域镜像 |
| 13 | 迁移后的原有Renderer单测、smoke、[Statement](../../../../scripts/renderer-lifecycle/fixtures/statement-controller.js)、[NewAccount](../../../../scripts/renderer-lifecycle/fixtures/new-account-controller.js)、[previews](../../../../scripts/renderer-lifecycle/fixtures/previews.js)；完整真实业务输出验收另记 |
| 14 | host异常/晚到用例、[配置窗口](../../../../scripts/renderer-lifecycle/fixtures/configuration-dialogs.js)、[现有控制器](../../../../scripts/renderer-lifecycle/fixtures/existing-controllers.js)：关闭后不复活/不重复提交 |
| 15 | [真实Main失效矩阵](../../../../tests/unit/renderer/scenario-change-routing.test.js)：transfer/batchDelete/applyImport、两域已导出前置反馈 |
| 16 | [scenarios](../../../../scripts/renderer-lifecycle/fixtures/scenarios.js)、[全写边界审计](../../../../tests/unit/renderer/scenario-write-boundary.test.js)：复制create、连续保存部分成功、六类渠道订阅；[实际Main矩阵](../../../../tests/unit/renderer/scenario-change-routing.test.js)验证setApplicableChannels只失效BankStatement |
| 17 | [app-settings](../../../../scripts/renderer-lifecycle/fixtures/app-settings.js)、[原删除竞态](../../../../tests/unit/archive-delete-dialog-lifecycle.test.js)：期限锁、token、取消/完整/待清理/失败 |
| 18 | [toolbox](../../../../scripts/renderer-lifecycle/fixtures/toolbox.js)：原token三种payload、切换、取消、双击、stale、最终资源清理 |
| 19 / 20 | [真实仓储ID复用及交错](../../../../tests/unit/renderer/scenario-change-routing.test.js)、[元数据屏障](../../../../tests/unit/renderer/scenario-command-service.test.js)：双向复用、晚到list/get、交错/未知写、dispose重建不恢复信任 |

## 首轮实施验证与剩余事项（审查前快照）

测试时94个变更代码/测试/脚本文件的哈希保存在 [验证快照](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/verified-code-sha256.json)。结束前核对一致；之后只在三份文件校正旧挂载注释或删除空行缩进，Acorn AST 比较完全一致，见 [无语义变更证明](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/comment-whitespace-proof.json)，涉及文件再次lint通过。最终交付哈希另存 [delivery-manifest.json](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/delivery-manifest.json)。文档本地链接检查没有缺失。

完整 `release-check` 重跑在执行前被环境自动审批拒绝，理由是此前历史Git clone测试已有ENOSPC证据、共享磁盘仅约11GiB可用；不能通过改名或间接执行绕过。获准的安全替代为：显式排除“1024 个真实 Task 来源”及“R3.2.4 历史 exact evidence”的其余单测（文件并发2），另行执行lint、smoke和按原清单发现的完整integration-runner。两项排除仅适用于单测。这些分项结果不等于完整release-check通过。

所有命令的工作目录均为本记录开头的功能worktree。

| 验证 | 最终结果 | 证据 |
| --- | --- | --- |
| `npm run lint` | PASS；注释整理后涉及三文件追加lint同样PASS | [完整lint](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/logs/g3-lint-final.log)、[注释整理lint](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/logs/comment-cleanup-lint.log) |
| `npm run smoke` | PASS，保留原业务断言并按迁移后函数位置取证 | [smoke日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/logs/g3-smoke-final.log) |
| 全单测文件，显式排除两项、并发2 | 8,248 tests：8,244 PASS / 0 FAIL / 4 SKIPPED；358.05秒。两项名称过滤的测试未执行，不计作通过 | [最终unit日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/logs/g3-unit-filtered-final.log) |
| `npm run test:integration` | 61个脚本全部PASS；可解析计数合计2,710/2,710，另有1个脚本退出成功但未输出计数；Renderer生命周期131/131；脚本耗时合计579.882秒 | [完整集成日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/logs/g3-integration-final.log)；runner自动同步[集成规则§七](../../../../rules/integration-test-policy.md#七当前集成测试清单自动同步) |
| AC19/20及全部场景写入口 | service44、实际Main/SQLite/controller31、写入口审计3均通过；已包括在最终unit中 | [专项92项日志（另含原ReconService14）](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/logs/g3-ac-audit.log)、[最终unit日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/logs/g3-unit-filtered-final.log) |
| 生产弹窗写入口扫描 | 当前modalRoot引用为根装配/只读观察/预览；唯一root挂载/overlay移除在modal-host | [扫描结果](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/logs/modal-root-inventory.log)；命令为 `rg -n 'modalRoot|overlay\.remove\(|modal-root' src --glob '*.js'`，补查host的root.appendChild/record.overlay.remove |
| 完整 `npm run release-check` | 未完成：最初smoke失败已修；重跑在执行前被自动审批拒绝，未开始 | [首次真实执行日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/logs/g3-release-check-smoke-before.log)；拒绝原因见上文，不能以分项结果改写为PASS |
| 产品Main启动／正式GUI | 本次隔离产品预览在Renderer加载前失败，`BIZOP_ACTIVATION_STARTUP_REQUIRED`；未取得产品Main端到端证据 | 受控API的131项Electron工厂测试不替代此项 |
| Windows／Excel／WPS／安装包 | 未执行 | 本轮在macOS做源码、Node和隔离Electron验证 |

最终unit实际命令：

```sh
node --test --test-concurrency=2 --test-skip-pattern='1024 个真实 Task 来源|R3\.2\.4 历史 exact evidence' $(rg --files tests/unit -g '*.test.js')
```

两项排除没有改写或删除原测试：`tests/unit/main-process/biz-op-v327.test.js` 的1024来源组和 `tests/unit/scripts/v3-2-4-release-evidence.test.js:761` 的历史exact evidence。前一项原`ERR_SQLITE_ERROR`根因仍未确认；后一项原ENOSPC已有直接日志。空间条件满足并获准后补跑这两项及完整release-check。完整集成通过不能解决这两项缺口。当前不能宣称正式GUI交付、release-ready或全部验收完成。

回退按完整功能切片撤回源模块与根装配、script顺序和相应测试/规则入口；不涉及数据迁移或线上数据回滚。跨G1/G2/G5/G8等集成按后续用户指令执行，不从其他功能worktree自行合并。

首轮交付产物（审查前快照）：[完整未提交补丁（含新增文件及本项文档）](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/renderer-boundaries.patch)、[差异统计](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/diff-stat.txt)、[验证清单与文件哈希](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-delivery/delivery-manifest.json)。补丁仅表达本分支相对上述HEAD的本地差异，不产生提交或集成动作。

<a id="review-remediation"></a>

## 审查整改记录（R01–R06）

依据：[2026-09-20 实现审查](review-2026-09-20.md)。保留原报告、脚本和日志，不把修前反例改写为通过。整改仍在同一功能worktree，HEAD仍为11086a3c；修前110个现有变更／审查文件的哈希与本轮源文件备份位于 [修复前清单](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/before-manifest.json)。原资金算法、Main接口及真实业务数据不属于本次修改范围。

| 审查项／所属切片 | 实现 | 验证 | release集成 |
| --- | --- | --- | --- |
| R01 来源绑定／R4 VCC OP | 已实现 | 自动验证通过；资金人工复核未完成 | 未集成 |
| R02 默认存档入口／R1 | 已实现 | 默认依赖、实际根装配及组合回归通过 | 未集成 |
| R03 场景下拉恢复／R3 | 已实现 | 原反例、新矩阵及最终组合通过 | 未集成 |
| R04 后台任务反馈／R4 BizOP | 已实现 | 原反例、后台与选择／恢复矩阵及最终组合通过 | 未集成 |
| R05 隐藏域失效反馈／R3 | 已实现 | 原两方向反例、新矩阵及最终组合通过 | 未集成 |
| R06 写窗busy协议／R1、R5 | 已实现 | 收纳／拆分父子、正常导航及最终组合通过 | 未集成 |

### 整改职责、调用闭合与前后行为

**R01／R4 VCC OP（AC-09/13）。** scan之前先清旧保存资格，来源对象与操作锁跨导航保留；F1确认、计算及F2期初只属于该来源。旧扫描未确认就离页时只保存事实和继续说明，不能复活旧F2。已确认compute和已提交save保留真实结算。重入、打开F2及提交前经既有computeAmounts核对月份、totals、perFile；提交仍只有beginOp，不从Renderer传回旧金额覆盖Main。调用方仍为本域controller及原F1/F2工厂；工厂新增可选canClose，将域资格与本地computing合并为一次登记，避免覆盖busy条件。金额算法、schema及公开IPC无需更新；该既有核对IPC产生Task/活动日志，已在[TechDoc §5.1](techdoc.md#vcc-source-settlement)记录。当前规则入口更新为Renderer README的VCC来源段。证据与资损风险分级见[来源验证说明](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/vcc/README.md)。

**R02／R1 正式存档入口（AC-13/17）。** 默认依赖从外层窄API读取，使用archiveApi局部变量，消除TDZ；显式override只作兼容路径。工厂专项验证无override的列表、统计、保留期及父子删除；实际index/Preload/设置按钮再覆盖正式调用链。只改API取值，不改变删除token、存储目录或删除资格，因此专项业务规则正文无需更新；入口与资源协议仍在Renderer README。

**R03、R05／R3 场景资格及反馈（AC-13/15）。** 两controller独占busy与失效待重绘状态。ReconID每次按busy、当前类别及合法场景完整计算disabled；确定失效在隐藏时保留resultFeedbackInvalidated，成功重读Main后消费，失败读取不能吞标记。修后下拉在成功/失败/取消/reject结算恢复合法资格，返回已失效域清除旧导出成功反馈。原command service、scope矩阵、resync、未命中域、仅关闭与明确写失败的兼容语义保持；没有新增调用方或公开API。当前Renderer README已更新，完整35项矩阵及五项事实见[场景修复说明](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/scenarios/results.md)。

**R04／R4 BizOP（AC-09/13）。** controller的feedback保存已提交任务的真实终态，页面代次仅控制DOM/弹窗续接；enter恢复busy、可用状态和已结算反馈。相邻调用方复查发现旧picker和retryRecovery也返回null，现以独立abandonedSelection废弃尚未提交的文件/保存位置选择并恢复此前反馈，已提交恢复检查则先归一真实ready。没有新增IPC、重试业务写或取消已提交后台任务；perform全部消费者保持原结果/后续界面资格。原Electron断言“返回后不显示旧任务错误”与本次已确认合同冲突，已改为显示真实错误且无旧窗复活、一次调用；修前失败记录保留。当前规则入口已更新为Renderer README的后台反馈段。

**R06／R1、R5 写入弹窗（AC-03/14）。** 功能收纳和拆分份数将同步提交锁与host的canClose连接，父子和根替换遵守同一资格；保存完成只操作原handle。收纳onCommit仍负责保存及Main启用列表接纳，新增可选onCommitted在原handle正常提交关闭后导航/重绘；取消、失败、force dispose不调用。实际root装配保留“停用当前模块→切Main返回列表首项”。拆分减少份数的确认及增加份数的直接写均仅一次提交，保持原templateId/nextN、失败重试和取消行为。此前旧入口遗漏和本轮F2迟到DOM补修均记录为有意修复，不声称原行为完全不变。当前规则入口为Renderer README弹窗权限段；[工厂说明及证据](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/modals/README.md)保存完整调用兼容与测试。

G8仍未集成，配置/激活和例外无变化。当前人读入口由AGENTS→Renderer README导航；新增技术细节同步TechDoc §5.1，Spec及原审查报告保持原样。首轮完整门禁与平台限制不会被局部整改通过覆盖。

### 本轮最终验证

最终96个代码／脚本／测试文件以[冻结哈希](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/frozen-code.json)执行验证，完成后逐一核对无漂移。各组修前反例保留；所有命令工作目录均为本功能worktree。

| 本轮执行 | 结果 | 证据与范围 |
| --- | --- | --- |
| 42个受影响单测文件，`node --test --test-concurrency=2` | **623/623 PASS，0 fail、0 skipped** | [最终日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/final-unit.log)、[完整命令与退出码](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/final-unit-command.json)；包括已迁移原测试、Renderer边界、R9及本次新增回归，不是全仓unit |
| `node scripts/test-renderer-lifecycle.js` | **154/154 PASS** | [全部工厂日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/final-electron.log)；实际index/Preload/控制器/F1/F2、默认存档、收纳正常导航，API受控 |
| `npm run lint` | **PASS** | [日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/final-lint.log) |
| `npm run smoke` | **PASS** | [日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/final-smoke.log) |
| R01真实parser/session/SQLite | 新25项＋原域33项＝**58/58**，含在最终unit | [资金来源日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/vcc/after-focused.log)：B未确认不能保存；重新确认后08账期、900发生额、100期初、1000期末，B逐文件明细及receipt hash一致 |
| R03/R05原审查反例 | 修前0/3，修后**3/3 PASS**；新矩阵35项 | [原探针修后日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/scenarios/after-probes.log)、[矩阵说明](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/scenarios/results.md) |
| R04原审查探针 | 修前停留“等待后台”；修后保留真实失败，一次导入、busy=false | [修前](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/bizop/before-review-probe.log)、[修后](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/bizop/after-review-probe.log)；13个新增背景／选择／恢复用例与旧业务／恢复组合29/29，含在最终unit |
| R02/R06及F2正式工厂 | 原默认/busy反例修前成立；整改后父子、双击、失败、force dispose均通过 | [弹窗前后证据](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/modals/README.md)；F2新增8项，修前6项失败、修后17/17（含原9项），均纳入154项 |
| 哈希、差异、链接与保护检查 | **PASS** | [交付清单](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/final-manifest.json)、[差异检查](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/final-checks.log)；原审查/证据与Spec无改动，Main/backend/package/lock无新增变更 |

实际根F1/F2和SQLite验证是两层独立证据：前者用受控API验证正式DOM/参数/导航，后者运行真实解析、会话、存储及receipt但使用记录型弹窗。没有把两者合称完整产品Main端到端。

本轮只执行与Renderer修复影响相称的组合验证，没有重复全仓unit或完整integration-runner；此前623项以外的测试、历史61脚本通过属于首轮快照。未运行的完整门禁和平台项继续保留。

交付：[相对审查快照的整改补丁](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/review-fixes.patch)、[整改差异统计](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/review-fixes-stat.txt)、[当前完整功能补丁](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/renderer-boundaries-current.patch)、[当前文件与日志哈希清单](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-fixes/final-manifest.json)。全部为未提交差异；本次回退可按整改补丁精确撤回到审查前状态，不触及真实数据。

### 资金人工复核与剩余门禁

**⚠️ 资金红线，请人工复核。** [reconciliation-blindspot-pass](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/.agents/skills/reconciliation-blindspot-pass/SKILL.md)要求“命中资金红线时标注 `⚠️ 资金红线，请人工复核`，不得仅凭自动测试宣布安全”；CODEX.md也要求资金损失红线发现人工复核。R01的自动化仅使用合成Excel、真实parser/session及内存SQLite。需人工核对界面确认账期、输入期初、Main snapshot、逐文件明细和落库receipt的一致性；当前没有访问真实业务数据，不能推断既有真实数据是否受影响。

完整release-check、两项高占用单测复验、真实产品Main启动（含新增computeAmounts核对的Task/日志）、Windows/Excel/WPS/安装包以及release/跨治理集成仍未完成。本轮未重试此前因ENOSPC和共享磁盘空间被自动审批拒绝的完整门禁，也没有将历史61脚本通过升级为本轮完整集成通过。

<a id="review-r2-remediation"></a>

## 第二轮复审整改（RR01 / RR02）

依据：[第二轮复审](review-2026-09-20-r2.md)。继续复用原功能worktree及11086a3c未提交基线；修前逐一确认上轮112个交付文件未漂移，并保存本轮123个变更／审查文件的[修前哈希与备份清单](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/before-manifest.json)。两轮审查报告及其证据保持原样。上轮R01–R05及收纳／份数原反例的闭合结论保留，不把两项旧余项归为已确认的新回归。

| 余项／父切片 | 实现状态 | 验证状态 | 集成状态 |
| --- | --- | --- | --- |
| RR01 拆分单行删除与同父会话写资格／R06、R1、R5 | 已实现 | 最终专项61/61、独立复核、冻结187项工厂及649项单测通过 | 未集成 |
| RR02 两域状态读取失败恢复／R3 | 已实现 | 原探针7/7、反馈矩阵61/61、专项组合164/164及最终组合通过 | 未集成 |

本轮修复限定在既有弹窗生命周期和状态反馈合同；Main、schema、金额和删除业务参数不调整。R06及整项G3的完成判断仍须区分本次代码、适用验证及原有交付缺口。

### 职责、兼容与业务行为

**RR01／R06、R1、R5（AC-03／14）。** [configuration.js](../../../../src/renderer/dialogs/configuration.js)中的createBillSplitRowsDialog以父会话runWrite持有统一活动写资格；覆盖行完成／编辑、删行确认／直删、增减份数、合并组保存／清空、金额目标元数据、signed／byField互斥链及规则子层保存。原独立rowCountSaving仅覆盖份数，现被同会话统一资格替代；7种写API／10类入口的实际调用清单见[独立写入口审查](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/deletion/write-entry-audit.md)。扫描证明调用归属，真实工厂回归证明相应行为，二者不相互替代。

删除预检保存请求代次、原行节点和原行对象资格，关闭、替换、销毁、其他写开始或行重绘后不能继续新删除；最新有效无组预检仍直接删除，有组预检保留组解散确认。预检失败或reject不再按空组合直删，这是落实错误与取消区分的有意修复。写入同步锁住父子关闭及控件，同参数双击仅一次提交；失败保留原窗口供重试。已经发出的互斥配套写按提交快照继续，强制销毁仅撤销旧DOM、弹窗和后续读取／交互续接。

**调用方与兼容。** 生产仍由映射管理的openBillSplitRowsDialogFromMain以push打开；现每次打开前重读getBillSplitConfig，按父handle、入口是否启用、打开请求与父写代次校验，读取失败不回退旧缓存。工厂原入参字段、Renderer Dialogs命名转发和renderer-previews入口保留；onClose新增可选只读资格上下文{isCurrent()}，旧忽略参数的回调兼容，实际mapping调用方已接入。按钮返回在onClose等待期间保持拆分子层并锁定普通关闭与写入，回调完成后精确结束原层；force子层销毁后的回调不能更新父缓存或关闭新层。原templateId、seqNo、nextN、合并组确认、Main的currentRows／dissolvedGroups结果保持；Main处理器与实际仓储不修改。实际声明位置和调用方见[调用清单](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/caller-inventory.log)。

**RR02／R3（Spec §4／§5，AC-09／13／15）。** BankStatement与ReconID各自私有保存lastStatusFeedback和statusReadFeedback。sessionStatus错误仅暂时覆盖原有效反馈；有效成功后撤回仍占据状态框的读取错误，确定失效则按Main结果重绘。正常业务、导入进度或其他读取提示会取消旧恢复资格，不能在后续静默成功时回放较旧文本。连续失败、快速进出、并行读取、R9重同步未命中域、已失效导出和较新反馈交错均按原页面／读取代次验证。构造、enter／leave、commands、共享session及根装配接口不变，不新增跨域状态或镜像会话。

**当前规则入口。** AGENTS → [Renderer README](../../../../src/renderer/README.md)的“弹窗入口与权限”和“场景命令、失效与共享会话”已同步实际责任；[TechDoc §5.2](techdoc.md#review-r2-lifecycle)保存技术补充，Spec沿用原合同无需修改。G8仍未集成，无active配置或例外变化。Main／数据库／金额／删除业务规则正文无需更新，因为本次只修Renderer提交与展示生命周期，没有调整其接口和业务语义。

### 修前与专项证据

| 范围 | 修前证据 | 修后专项证据 |
| --- | --- | --- |
| 原独立删行探针 | 2种缺陷均复现：确认双击2次删除、父层可关闭；预检关闭后仍发1次删除 | 对应序列及相邻入口纳入真实工厂新增回归；不改写原探针“exit 0表示复现缺陷”的含义 |
| 拆分配置实际工厂 | 原28项＋新增24项＝52项，33 PASS／19 FAIL | 52/52 PASS，受控API＋真实Electron DOM；命令、退出码及说明见[删除整改证据](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/deletion/result.md) |
| 原独立状态恢复探针 | 7项，5 PASS／2 FAIL | 7/7 PASS，原脚本及用户日志未改 |
| 两域反馈矩阵 | 原35项＋新增26项＝61项，41 PASS／20 FAIL | 61/61 PASS；加Main路由、service、进度及状态显示组合164/164，0 skipped；见[状态整改证据](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/status/results.md) |

专项组包含关系不重复相加。RR02使用真实controller、Main handler／内存SQLite harness及一次故障注入；RR01使用真实Electron工厂与受控API，没有删除真实模板。两者都不覆盖产品Main完整TaskLifecycle或平台验收。最终冻结组合与交付哈希见下段。

**独立复核补充。** 本轮新增“先关子层再await父onClose”的候选实现被真实父子组合证明会使旧回调关闭新子层，已恢复安全顺序并添加回调资格；该候选反例与后续修复记录单独保留，没有归为用户此前快照的缺陷。公共handle关闭后父缓存仍为2行、Main已3行的重开问题，在本轮修前快照也成立；现由每次开窗前重读修复。新增异步开窗还须在入口关闭／重新启用时使旧读失效，不能仅依据最终按钮显示值。上述定点复核、原序列及执行快照见独立审查文档，不扩称全仓弹窗均已验收。

首轮组合已执行649项单测和185项工厂并通过，lint通过；smoke有2项B5-4静态定位失败，因为RR02将业务反馈记录与writeStatusBox透传分开，原审计仍要求updateStatusBox直接调用ui.status。已保持原格式化要求并核对update→write→ui.status传参链，更新同一smoke断言；入口迟到读修复完成后已复跑下述最终组合。首轮日志及代码哈希保存在[阶段证据目录](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/pre-final-adjustments)。

### 最终冻结验证与交付

最后两条“读取中改为否／否→是”的定点用例在修前59/61、独立0/2均复现；入口change推进打开请求代次，并在开始／回包时检查hidden和disabled后，配置工厂**61/61**（原28＋新增33）、独立探针**2/2**通过。独立审查§10已核对最终两文件SHA与实际执行一致；既有公共close缓存缺口和本次候选异步边界分别归档，没有混称本轮新回归或历史已通过。

96个实现／验证及模块说明文件按[最终冻结清单](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/frozen-code.json)执行下面四项检查；结束后再次逐一核对。期间只更新实施／设计记录及交付产物，未再修改生产代码和测试。所有命令均使用本记录开头的worktree。

| 最终执行 | 实际结果 | 证据与边界 |
| --- | --- | --- |
| `node --test --test-concurrency=2`，42个受影响文件 | **649/649 PASS，0 fail、0 skipped** | [日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/final-unit.log)、[精确参数与退出码](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/final-unit-command.json)；含R9、全部场景写边界、上轮VCC／BizOP及本轮新增反馈26项，不是全仓unit |
| `node scripts/test-renderer-lifecycle.js`，全部工厂 | **187/187 PASS** | [日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/final-electron.log)、[命令与退出码](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/final-electron-command.json)；含配置61项，真实DOM／工厂／index／Preload，API受控 |
| `npm run lint` | **PASS** | [日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/final-lint.log)；退出码0 |
| `npm run smoke` | **PASS** | [日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/final-smoke.log)；B5状态格式化27/27，退出码0，原两项静态定位失败已修 |
| 差异、哈希、保护与文档链接 | **PASS** | [交付清单](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/final-manifest.json)、[检查日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/final-checks.log)；Git可见的两轮审查／证据及Spec保留修前哈希，Main／backend／package／lock相对HEAD无差异，Preload相对本轮修前不变 |

实施记录、TechDoc §5.2及Renderer README已落实本轮五项事实。本轮实际代码和相称自动验证完成，release集成未执行；R06／整项G3不据此标为全部验收完成。原资金人工复核、完整release-check及两项高占用单测复验、真实产品Main端到端（含computeAmounts的Task／日志）、Windows／Excel／WPS／安装包、release及跨治理集成缺口仍保留。本轮没有重试此前因ENOSPC／共享磁盘资源被自动审批拒绝的完整门禁；只运行上表覆盖修复的本地组合，没有访问真实业务目录或删除真实模板。

交付：[相对第二轮复审快照的整改补丁](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/review-r2-fixes.patch)、[本轮差异统计](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/review-r2-fixes-stat.txt)、[相对11086a3c的完整功能补丁](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/renderer-boundaries-current.patch)、[当前文件和日志哈希](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r2-fixes/final-manifest.json)。本次回退可按整改补丁精确恢复到第二轮审查前内容，不涉及数据迁移或真实数据回滚；未提交、推送、开PR、合并、升版或发布。


<a id="review-r3-remediation"></a>

## 第三轮复审整改（R3-01，2026-09-21）

依据：[第三轮审查](review-2026-09-20-r3.md)。复用原worktree与11086a3c未提交基线；开始前核对上轮123个文件哈希，并冻结本轮139个Git可见变更文件与65个审查／证据文件的[修前清单](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/before-manifest.json)。R3-01按本轮审查确认的新回归记录，RR01／RR02原反例闭合结论保留。

| 余项／父切片 | 实现状态 | 验证状态 | 集成状态 |
| --- | --- | --- | --- |
| R3-01 清空金额规则后元数据失败／R06、R1、R5 | 已实现 | 专项80/80、独立5/5、最终649项单测及206项工厂通过 | 未集成 |

**职责与边界。** createBillSplitRowsDialog内部的saveAmountConfiguration负责两条金额互斥写链的结算与金额事实恢复；所有写和恢复读取仍处于父会话runWrite锁内。重读和展示只属于原handle，强制销毁不终止已提交配套写、不更新旧DOM。Main和仓储仍各自提交规则及元数据，没有新增事务、回滚或自动重试。

**调用方与兼容。** 由signed切换、byField清空两个既有监听消费，仍调用既有saveBillSplitAmountRules、saveBillSplitMeta和getBillSplitConfig。工厂入参、Dialogs命名转发、mapping父子返回与所有业务写参数保持。runWrite增加仅工厂内部使用的结算投影回调，在恢复disabled快照后执行；互斥控件完整重算，避免成功重试后遗留旧禁用状态。重试启用signed时始终清除旧byField目标序号，不以规则是否已被前次清空决定目标清理，避免目标并集错误扩大行禁用范围。

**业务行为。** 第一阶段已成功时第二阶段报错，界面不能继续使用已删除规则；失败后优先重读实际规则／元数据，同时保留原失败提示。Main数据库写后模板文件同步也可能报错，因此failed／reject不等于未提交；第一阶段未明确成功时不继续元数据写。恢复不采用返回的billSplitRows覆盖本地行草稿。重读失败时只接纳已明确成功的阶段，告知关闭重开并暂停当前窗口写入，普通关闭仍允许；恢复读取未结算期间继续busy防重与阻止关闭。对应AC-03／13／14，未调整金额算法或存储合同。

**当前规则入口。** AGENTS → [Renderer README](../../../../src/renderer/README.md)“弹窗入口与权限”；[TechDoc §5.3](techdoc.md#review-r3-partial-save)同步独立提交和恢复边界。Spec、三轮审查及其全部证据保持原样。G8未集成，无active规则或例外变化；Main／仓储业务规则正文无需改写。

### 验证证据与交付状态

专项与最终组合存在包含关系，不重复相加；真实Electron DOM／工厂配合受控API，不等同产品Main全链路。

**中间证据。** 首候选配置工厂77/80通过，3条signed主动重试发现旧byField目标序号未清理；独立复核确认目标并集会使额外行被禁用，已修复既有meta payload的清理条件。曾将这3条预期放宽的中间80/80已作废并单独保留，不作为闭合证据；最终用例恢复严格空byField目标断言，并检查signed目标为第2行时第1行可编辑、第2行受限。早期fixture返回不可序列化handle的4条测试执行错误也保留，修正后不计产品反例。

**专项前后对照。** 同一最终fixture使用修前生产快照为67/80 PASS（原61项全通过，新增19项中13项失败）；最终生产为80/80 PASS。[专项记录](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/tests/result.md)、[修前日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/tests/before.log)、[修后日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/tests/after.log)、[同组与源码哈希核对](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/tests/verification.json)记录两个阶段失败／reject／cancelled、落库后报错、销毁交错、重读失败锁写但可关闭及行草稿保持。

独立复核原四组修前0/4、修后4/4；另用候选源码证明signed目标残留0/1，最终合计5/5。[独立复核文档](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/review/stage-acceptance-audit.md)保存原仓储探针复跑、真实工厂合成状态探针、候选重试反例和最终源码SHA。修后API由状态型替身控制，真实仓储仅为原独立提交探针；不将两者合称产品Main端到端。

**最终组合。** [冻结清单](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/frozen-code.json)涵盖96个实现／测试／模块说明文件，最终检查后逐一核对。全部命令明确使用本记录开头worktree，源码和测试执行后未改。

| 最终执行 | 结果 | 证据 |
| --- | --- | --- |
| `node --test --test-concurrency=2`，42个受影响文件 | **649/649 PASS，0 fail／skipped** | [日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/final-unit.log)、[精确命令](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/final-unit-command.json)；包含R9及全场景写边界，非全仓unit |
| `node scripts/test-renderer-lifecycle.js`，全部工厂 | **206/206 PASS** | [日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/final-electron.log)、[命令](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/final-electron-command.json)；含配置80项，与专项不重复累计 |
| `npm run lint`、`npm run smoke` | **PASS，均exit 0** | [lint](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/final-lint.log)、[smoke](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/final-smoke.log)；专项另覆盖fixture lint与语法 |
| 差异／哈希／文档链接 | **PASS** | [检查日志](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/final-checks.log)、[交付清单](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/final-manifest.json)；65份三轮审查／证据及Spec原样保留；Main／backend／package／lock无改动 |

实施记录、TechDoc §5.3及当前Renderer规则入口已同步本轮五项事实。此次仅改5个Git可见文件：配置工厂、其fixture和3份现行说明。本轮代码与适用自动验证完成，集成未执行；R06／整项G3仍不标为全部验收完成。完整release-check、两项历史高占用单测复验、真实产品Main全链路、Windows／Excel／WPS／安装包、此前资金人工复核及release／跨治理集成缺口继续保留；本轮没有访问真实业务数据，也没有重试此前因ENOSPC／共享磁盘资源而被自动审批拒绝的完整门禁。

交付：[相对第三轮审查快照的整改补丁](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/review-r3-fixes.patch)、[5文件差异统计](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/review-r3-fixes-stat.txt)、[相对11086a3c的完整功能补丁](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/renderer-boundaries-current.patch)、[当前文件与运行哈希清单](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r3-fixes/final-manifest.json)。整改补丁可精确还原本轮修改，不涉及数据库回滚。分支及HEAD保持原值，未提交、推送、开PR、合并、升版或发布。


<a id="review-r4-acceptance"></a>

## 第四轮复审接收（2026-09-21）

依据：[第四轮审查报告](review-2026-09-21-r4.md)。本次接收只更新实施记录，未修改产品源码、测试、Spec、TechDoc或原报告／证据，未重新运行产品测试。已核对原第三轮整改交付的139个文件在接收前无漂移；第四轮审查仍针对11086a3c基线上的未提交实现。

| 对象 | 实现状态 | 验证状态 | 集成状态 |
| --- | --- | --- | --- |
| R3-01／R06、R1、R5的金额配置部分成功 | 已实现 | 第四轮复审通过；原缺陷以同一正确行为探针对照闭合，相关范围无新增确认缺陷 | 未集成 |
| 整项G3 | 已实现，详见各切片及整改记录 | 适用局部验证通过；完整验收未完成 | 未集成 |

**验证证据。** 以下结果由第四轮审查实际执行，本次仅核对报告、执行记录与日志，不算作本次重新执行：42个受影响单测文件649/649、隔离Electron全部工厂206/206（已含配置80项）、独立两阶段保存／恢复矩阵22/22、独立实际mapping父子组合2/2，lint、smoke和差异检查通过。原R3快照在同一正确行为探针下0/1、当前快照通过；该对照包含在22项中。命令与日志统一引用[第四轮报告§4](review-2026-09-21-r4.md#4-本轮实际验证)，不覆盖第三轮整改的历史执行记录。

**未完成的补充验证。** 另3项草稿／主动重试独立探针在executeJavaScript阶段异常，未形成有效业务断言。其0/3输出既不计通过，也不作产品缺陷证据；该补充独立加验保持未完成。相关行为结论依赖本轮已通过的正式用例及代码审查，原脚本与失败日志仍保留在[第四轮报告§3](review-2026-09-21-r4.md#3-相关生命周期和重试检查)。

**职责、调用兼容、业务行为及当前规则入口。** 本次没有实现或合同变动，沿用[第三轮整改的五项事实](#review-r3-remediation)、[TechDoc §5.3](techdoc.md#review-r3-partial-save)及AGENTS → [Renderer README](../../../../src/renderer/README.md)。这些规则正文无需更新；G8仍未集成，无active配置／例外变动。第四轮“无新增确认缺陷”仅覆盖报告范围，不扩大为全仓或全部平台验收。

**剩余项。** 完整release-check及既有高占用单测复验、真实产品Main两阶段提交／模板库同步／Task和日志全链路、Windows／Excel／WPS／安装包、此前资金人工复核、release与跨治理集成仍未完成。R3-01标为已修复；R06／整项G3不标为全部验收完成。原整改补丁与哈希保留原交付快照含义；本次文档接收差异及保护核对见[接收检查记录](../../evidence/merge-g3-g7/g3-worktree-evidence/tmp/g3-review-r4-record/checks.json)。未提交、推送、开PR、合并、升版或发布。
