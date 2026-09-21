# TechDoc｜v3.2.10 Renderer 状态边界与弹窗生命周期治理（G3）

| 项目 | 内容 |
|---|---|
| 目标版本 / 计划分支 | 3.2.10 / `codex/v3.2.10-renderer-boundaries`；尚未创建 |
| 代码基线 | `main@11086a3cbf632a30adbcfa796e4cd81810c5aef9`（附注标签 `v3.2.9`） |
| 集成目标 | `release/v3.2.10`；交付前已与 v3.2.9 同步，本次未操作 Git；实施时按[总索引](../../README.md)再次核对 |
| 需求依据 | 同目录 [spec.md](spec.md)，G3-AC-01 至 G3-AC-20 |
| 日期 / 状态 | 2026-09-20 / 设计稿，新增接口与路径均未实施，测试未执行 |
| 格式参考 | [v3.2.9 工具箱 TechDoc](../../../v3.2.9/codex/v3.2.9-toolbox-split-by-rows/techdoc.md) |

## 1. 现状与目标结构

当前是经典脚本按 [index.html:610](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/index.html:610)的顺序装配。旧 Renderer/Dialogs 共享总状态、DOM 引用及 API；Position/VCC/BizOP v327 已有部分独立控制器，但弹窗和导航协议尚未统一。本次保留经典脚本和 Preload sandbox。

```text
renderer.js（composition root）
  ├─ shell services：模块选择、窗口、外观、更新、共享只读配置
  ├─ modalHost：栈、DOM、焦点、关闭与销毁
  ├─ moduleRouter：调用 controller.enter / leave / dispose
  ├─ scenarioCommands + scenarioChangeRouter：按真实命令生成 scope 并路由，不读领域内部状态
  ├─ sharedReconSession：既有 Main 共享 session 的窄访问与 revision
  └─ domain controllers：私有 state + 本域 panel + scoped API + ui services
```

模块是同进程普通 JS 文件，不是新进程，也不建立通用插件框架。所有新增文件采用现有 IIFE 工厂方式导出到明确命名空间，并提供不执行 DOM/IPC 的工厂入口供测试加载。

## 2. 文件和唯一所有权

下列路径均为拟新增或拟修改，尚未实现。

| 路径（项目内；仓库根为 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool`） | 唯一职责 / 可调用者 |
|---|---|
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer/modal-host.js` | `window.__modalHost.createModalHost`；唯一写入 modalRoot 的模块，管理句柄、栈、关闭、焦点；业务通过公开方法使用 |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer/module-router.js` | `window.__moduleRouter.createModuleRouter`；唯一维护当前模块和导航 generation；只调用固定 controller 合同 |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer/scenario-command-service.js` | 按既有 Preload 命名方法调用场景写命令；根据 §6 固定矩阵生成结果 scope、发布单次成功摘要；不存结果或访问 DOM |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer/scenario-change-router.js` | `invalidationScope`→控制器失效路由；categories 仅供列表/选项刷新，不存业务结果、不访问 DOM |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer/shared-recon-session.js` | BankStatement gateway 与 ReconID 共用的既有 API 包装及 revision；不缓存第二份明细/session |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer/controllers/*.js` | 每域 controller 私有缓存、panel 内 DOM 查询、订阅清理 |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer/dialogs/*.js` | 领域弹窗工厂和私有草稿；返回结果/变更摘要，不反向调用面板刷新 |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer/configuration-services.js` | templates、币种/账号选项等现有配置的窄查询与 revision 通知；不承载业务运行结果 |
| `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer.js` | 显式挑选 Preload 方法并装配；应用壳 DOM；不导出可变总 state 给控制器 |

现有 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer-dialogs.js` 保留兼容工厂转发，迁出后逐组移除；`renderer-pending.js`、`renderer-position-reconciliation.js`、`renderer-vcc-financial-op.js`、`renderer-biz-op-v327.js` 保留其工厂入口并接入新协议，不仅为目录统一机械搬迁。

## 3. modalHost 合同（R1）

### 3.1 API 与结果

以下是确定的内部设计；公开 IPC 不变。`createModalHost({ root, document, reportError, resolveFallbackFocus })` 创建一个窗口级宿主。

```js
// 工厂只创建脱离 DOM 的内容、注册清理；初始异步加载放 onMount。
function dialogFactory(scope) {
  // scope.onDispose(fn) 注册同步资源清理；scope.signal 随最终销毁 abort。
  return {
    overlay, dialog,
    initialFocus: () => dialog.querySelector('[data-field="month"]'),
    dismiss: { escape: true, backdrop: true },
    canClose: (reason) => !busy, // 同步、只读
    onMount: (handle) => { /* 启动加载，自己处理业务失败 */ }
  };
}

const opened = host.openRoot(dialogFactory, { owner: 'vcc-financial-op' });
// { status: 'opened', handle } | { status: 'blocked', by: handleId }
// 工厂失败抛错；旧栈保留，reportError 记录；调用方显示既有失败反馈。
const child = host.push(parentHandle, factory, { owner: parentHandle.owner });
const next = host.replace(handle, factory); // 替换指定层和后代，祖先保留
host.closeTop({ status: 'cancelled', reason: 'cancel' });
host.closeOwner(owner, 'navigation'); // { status: 'closed' | 'blocked' }
host.dispose(); // 仅 renderer 卸载/初始化失败，强制收尾

// handle
handle.id;
handle.owner;
handle.signal;
handle.closed; // Promise<DialogOutcome>，永不因普通取消 reject
handle.close(outcome); // { status: 'closed' | 'blocked' | 'already-closed' }
handle.dispose('renderer-dispose'); // 仅宿主/控制器最终销毁使用
handle.isOpen();
handle.isTop(); // 只读；需要继续打开子层时校验当前栈顶资格
// DialogOutcome = { status:'submitted', value } |
//                 { status:'cancelled', reason:'cancel'|'escape'|'backdrop'|
//                    'replaced'|'parent-closed'|'navigation'|'disposed' }
```

`push` 只接受当前栈顶且仍打开的父句柄；过期/非顶父句柄抛带代码 `MODAL_PARENT_INVALID` 的内部错误。后代 `owner` 继承父层，不允许把一个域的子窗口伪装成另一域绕过清理。

`close` 默认为 `{status:'cancelled',reason:'cancel'}`；`dispose('renderer-dispose')` 的内部触发名统一转换为结果中的 `reason:'disposed'`。提交方先完成现有业务校验，再以 `submitted` 关闭；宿主不执行保存、删除、任务取消或文件清理。默认 `dismiss` 为两项 false，迁移时逐窗填入当前行为；不能让未知弹窗自动拥有 Escape/遮罩关闭权。

### 3.2 栈与事务式替换

句柄内部状态为 `constructed → mounted → closing → closed`。已 closed 的句柄不再进入回调、不能重新挂载。宿主维护栈和 id→record；业务拿不到内部可变 records。

一次替换固定执行：

1. 确定待关闭范围：根替换为全部；层替换为目标及后代；关闭父层包含后代。
2. 从顶到底调用全部 `canClose(reason)`。任一 false 或抛错，整次操作拒绝；抛错记录，不清节点、不调用后继工厂。
3. 调用新 factory 构建脱离文档的节点，使用独立 cleanup scope。factory 抛错时销毁该 scope，旧栈不变。
4. 对待关闭层从顶到底标记 closing，阻止二次事件；abort 各自 scope，逐个执行所有 disposer，移除各自节点并从栈移除，完成各自 `closed`。
5. 挂载新层、还原祖先 inert/aria 状态，设置焦点策略，然后调用 `onMount`。`onMount` 的失败属于新窗口加载失败；不恢复已正常关闭的旧窗口，按本域既有反馈显示。

预检查与栈切换均同步执行，期间不 await，不出现检查后用户又触发新保存的窗口。`canClose` 不能改状态或调用 host。重入检查/清理期间的 host 调用拒绝并记录内部错误；先分类旧“onClose 时 reopen”：需要原窗口仍存活的临时子流程按 §3.5/§3.6 改为 push/close，根本不重开；原视图已经结束的向导观察 `handle.closed`，从独立会话草稿创建新工厂。不得重挂 closed 节点，也不在 `replaced/disposed/navigation` 时复活旧流程。

`closed` 的 Promise continuation 在当前同步替换完成后运行。旧调用方的异步 continuation 必须先检查结果和 owner 活动 generation；不能看到任何取消就盲目 reopen。

### 3.3 监听、焦点与错误

宿主仅绑定一组 document keydown，按栈顶处理 Escape 和 Tab。业务行内 Enter/搜索等事件登记到 scope；不再各自绑定 document Escape。遮罩事件只在 `event.target === overlay` 且该句柄为栈顶时生效。

每个 scope 的 disposer 按逆注册顺序执行；一个失败不打断后续。finally 确保节点、栈和 Promise 收尾。`reportError` 调用使用现有日志能力，日志不得记录用户数据草稿。scope abort 不等于 abort Main IPC；取消未提交的等待与后台操作语义严格分开。

挂载时保存 `document.activeElement`；每次栈变化对非顶层保存并设置 inert/aria-hidden。恢复时还原原值，不一律删属性。requestAnimationFrame 聚焦前再次检查 isOpen 和栈顶身份；关闭时取消该 frame。顶层无可聚焦元素时 dialog 设置临时 tabindex=-1。宿主销毁取消键盘监听、所有动画和残留 scope。

### 3.4 现有入口的逐项迁移

| 真实入口 | 迁移设计 |
|---|---|
| Dialogs 与 renderer.js 两份 open/close | 都转发同一 host；旧 `openModal(element)` 仅兼容没有异步初始化/外部监听副作用的纯 DOM 构建工厂，返回打开结果；所有忙碌、异步初始化或持有资源的流程在 R1 改用延迟 factory，拒绝打开时不得已经发出 IPC |
| VCC `mountDialog` | 保留外层 `{overlay,dialog,body,close}` 兼容形状；内部使用 host；既有 `onClose` 由 `closed` 单次驱动，月份取消转回旧 null，提交返回所选值 |
| VCC preview tracker | 仍绑定原 modal 对象；保存/加载 Promise 不改；close 后 tracker 只返回快照不修改已销毁窗口 |
| LinkedTable 的映射入口 | `host.push(linkedTableHandle, mappingFactory)`；不再 appendChild |
| 映射加载失败/保存失败 | push 告警到映射层；保持 loaded guard；isOpen/generation 不满足时禁止弹出晚到告警 |
| 映射保存成功 | `host.replace(mappingHandle, successAlertFactory)`；告警继承 linkedTable 父层，确认回原 linkedTable；canClose 对已结算保存状态返回 true |
| Position 管理/配置/告警 | 所有直接 append/remove 路径改为 push/close/replace；`confirmAction` 通过 outcome 明确转换为 boolean |
| 存档设置/删除确认 | `createAppUpdateSettingsDialog` 的会话留在父 handle，确认层 push；按 §3.5 迁移 retention 锁、confirmationToken、刷新和迟到响应；删除旧 restoreSettingsDialog 重挂路径 |
| 工具箱/字段、行数、多文件选择/结果告警 | `createToolboxDialog` 为父会话；按 §3.6 push picker/alert，模式变化替换子视图且草稿归父会话；删除全部 `openModal(overlay)` 返回路径 |
| 旧确认/大账号/场景向导 | 将 `document` 级监听、浮动下拉、计时器绑定到 scope；临时子流程 push，视图结束的前进/返回才 replace；草稿由明确的存活会话持有，只在取消/完成最终释放 |
| renderer-previews | 使用同一生产宿主和工厂；预览参数只提供 fixture，不直接破坏活动生产栈 |

R1 结束前对全部 `modalRoot` 写访问和 `overlay.remove()` 做清单检查，区分普通非 modal DOM；不得仅修报告所列的 VCC 函数而保留第二份清空入口。全量旧弹窗工厂可以保留领域逻辑，但所有拥有外部资源的工厂必须登记清理。

### 3.5 存档设置 → 删除确认的父会话（R1 必迁）

现状证据：[renderer.js:3728](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer.js:3728)先预检再用确认层替换设置窗；[3766](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer.js:3766)和 [3804](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer.js:3804)重新挂载旧 overlay；[3832](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer.js:3832)的真正关闭又会设置 `destroyed`、递增代次并退订。R1 必须迁移完整流程，不能只替换 openModal 实现。

所有权固定为：`dialogs/app-settings.js`（拟新增）工厂创建 `settingsHandle`；`archiveState`、保留期意图队列、appearanceView、各订阅和列表/详情代次属于这一父 scope。确认层只有自己的 `deleteBusy`、反馈 DOM 和 `{batchId, confirmationToken, deleteRequestId}` 快照；不取得父状态的销毁权限。

1. 将 `closeSettingsDialog` 拆成同步只读 `canClose` 与父 scope 的单次 disposer。`canClose` 为非 theme saving、非 settingsLoading、非 retentionSaving 且无 retentionPendingIntent；保持最后一次期限意图保存完毕后才能关闭。disposer 原样承担 appearanceView.destroy、destroyed 标记、全部请求/意图代次失效、timer 清理和取消订阅；不再递归调用 closeModal。挂载子层、子层取消或返回绝不调用它。
2. 删除入口保留两次 `settingsReadyForDelete` 检查：预检前及 prepareDeleteBatch 返回后。等待期间父层仍可修改期限；若第二次检查发现保存未收口，只显示原提示且不 push 确认层。预检有自己的 deleteRequestId，返回时须父 handle 仍 open、仍为 top、代次匹配；原父层已替换/销毁或出现更新的操作时直接放弃 UI 结果。
3. 合法预检成功后 `host.push(settingsHandle, deleteConfirmFactory)`；父层仍 mounted 且 inert，`archiveState.destroyed` 仍 false，不 abort retention/session scope。确认层只把 Main 返回的原 confirmationToken 与原 batchId 交给 deleteBatch；不能因为层切换重生成、替换 token 或把旧预检套在另一个批次。
4. 点击确认同步设置 deleteBusy，再发一次 IPC；按钮、Escape、遮罩、祖先 close/root replace 全部经 child.canClose 拒绝。取消时只关闭子层并放弃本地预检引用，不发 deleteBatch、不重复 prepare；父层恢复原筛选/选中/滚动与焦点，按既有逻辑刷新应用更新显示。
5. `metadataDeleted:true` 时，不论 `fullyDeleted` 是否 true，先使父 list/detail 旧请求失效、清空选中与 detail；将 child busy 解除后以 submitted 关闭子层，再从同一父会话重读批次和统计。完整清理显示成功；未完全清理保持“批次记录已删除、文件清理待重试”反馈与重试入口。不得将待清理伪装为 delete 失败后自动重发删除。
6. metadata 未删除或 IPC 抛错时，父 handle 保持、确认层显示原错误、解除 busy。保留 Main 对 token 的有效期/单次消费校验：按钮重试仍交原 token，由 Main 决定是否拒绝；需要新预检时先取消回父层再由用户重新操作，绝不自动发新的破坏性确认。取消后丢弃 token 引用，不声称撤销服务端 token。
7. 所有异步收尾检查对应 handle、generation 和 deleteRequestId；读取结束不启用已销毁按钮、不重新打开确认层。强制 renderer dispose 只能让前端结果失效，不能取消已发送删除或伪造回滚；存活控制器收到已结算结果后按 Main 事实刷新。父层最终关闭或整体 dispose 才执行一次父清理，子层独立清理一次。

### 3.6 工具箱 → 拆分选择 → 保存的父会话（R1 必迁）

现状证据：[renderer-dialogs.js:11912](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer-dialogs.js:11912)维护导入/导出 busy；[12041](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer-dialogs.js:12041)进入选择，完成与取消分别重挂旧 overlay；[12384](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer-dialogs.js:12384)及 [12736](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/renderer-dialogs.js:12736)切换单/多文件。Main 的 [requireToolboxSplitReadContext](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:20735)继续拥有 token/sourcePath/snapshot 的最终校验。

`dialogs/toolbox.js`（拟新增）父工厂持有 toolboxHandle、merge/splitImport/splitExport busy、requestGeneration 与当前 splitSession。splitSession 为 `{ generation, sourceFilePath, splitReadToken, headers, valuesByField, dataRowCount, maxRowSplitFiles, draft, submitted }`，只对本次读取有效，不进入全局 state。选择层只拥有自己的控件/浮动面板监听，不拥有 token 的 Main 生命周期。

1. 父 `canClose` 沿用 `!isToolboxRunning()`；系统选文件、读表和保存期间禁止全部普通关闭/替换。splitRead 开始递增 generation 并放弃之前已结束的本地 splitSession；取消/失败不创建 picker。成功且父层仍 open/top、generation 匹配后建立 splitSession，先结束 splitImport busy，再 `push(toolboxHandle, pickerFactory)`，确保选择层初次可提交时不会被旧导入 busy 拒绝。
2. 父层在 picker 下保持 mounted/inert。单字段/按行/多文件的输入、草稿与校验沿用 v3.2.9：按行与多文件互斥、计数必须来自本次 token、最多文件数和多组文件名约束保持。模式切换在同一 splitSession 下替换 picker 子视图，旧子 DOM 真正销毁；将下一模式输入显式从当前草稿转换，保留既有切换的初始化/重置行为，不新加跨模式记忆规则。所有模式共用原 token/计数，不能为了换视图再 splitRead。
3. 取消 picker 只关子层并结束这次本地选择会话，父工具箱继续显示原状态；不发 splitExport、不清 Main session 或文件。选择完成时同步校验、设置 `submitted=true` 及 splitExport busy，复制不可变 payload，然后关 picker 显露父层，再发一次原 splitExport IPC。`submitted` 与父 busy 双重拒绝双击、模式事件及迟到 onComplete；子视图只作 submitted 结算，不因已经上交 payload 而阻塞自身关闭。
4. 系统保存取消/成功/失败按现有结果合同更新父状态，finally 解除 splitExport busy。需要告警时 `push(toolboxHandle, alertFactory)`，确认只关告警回父层。告警挂载不销毁父 scope，不通过 onConfirm 重开父节点。合并/读取失败告警也用同一路径。
5. 旧 generation、已关闭父 scope 或被新 splitRead 替代的结果不写 UI、不 push 告警、不再次导出；后台 IPC 不能被 UI abort 伪装取消。Main 返回 `TOOLBOX_SPLIT_READ_CONTEXT_STALE` 或源文件变化时保留失败反馈并要求重新读取；Renderer 不重试旧 token、不绕过来源/输出目标验证。现有 Main token 清理时点保持，本次没有新增“关闭弹窗即删除暂存/清 session”的 IPC。
6. picker 取消/完成时最终清其 scope，父只释放结束会话的本地 token/大数组引用；这不等于销毁仍打开的父会话。父最终 close/dispose 使 generation 失效，释放剩余草稿与监听一次。浮动选值面板的 document 监听、resize/scroll、timer 必须归当前 picker scope，不能仅删 overlay。

## 4. 控制器与导航合同（R2）

```js
const controller = createDomainController({
  api,       // 只包含该域所需的命名方法；由 composition root 挑选
  panel,     // 本域根节点，elements 在内部查询
  ui,        // { modalHost, alert, confirm, status, reportError }
  config,    // 需要时注入明确的只读配置服务
  sharedReconSession // 仅 BankStatement/ReconID 注入
});
controller.enter({ routeVersion, reason: 'startup' | 'navigation' });
// Promise<{ status:'ready' | 'error' | 'stale' }>；失败由本域反馈
controller.leave({ reason: 'navigation', nextModuleId });
// 同步 { status:'left' | 'blocked' }，不能等待 Main 操作完成才允许判断
controller.invalidate({ kind, invalidationScope, resyncScope, categories, revision });
controller.dispose(); // 幂等，取消订阅并最终释放本域前端资源
```

router 注册静态 moduleId→controller，注册完成后冻结；未知模块沿用当前默认 statement 模块回退，不能动态从 Renderer payload 注入工厂。router 持有当前 id、导航递增序号及面板显示。`navigate` 先让当前 controller.leave 预检并关闭本域 modal；blocked 时不更新当前 id/持久化/面板。通过后更新当前 id、模块菜单与面板，再调用目标 enter；旧 enter 的完成不能改变当前模块。设置持久化仅在真正切换成功后调用，保留现有设置失败的日志行为。

所有静态按钮绑定在工厂初始化或首次 enter 时完成一次；订阅 token 由控制器保存，dispose 逐一取消。leave 标记 inactive 并递增 renderGeneration，使在途只读刷新失效；已有后台写操作保留 task/session 身份，完成后只标记 needsRefresh，不渲染其他域。每类并行请求使用独立 requestGeneration，避免“加载月份”错误地让“读取任务状态”失效。

自动 enter 使用原有 `updateStatus:false` 语义；错误反馈不吞。无 pending 状态的首次 enter 从 Main 读取事实；重进不能凭界面缓存伪造成功。对已有不返回取消函数的 Pending import 订阅，Preload 内保留公开方法名/参数，增加取消函数返回值（旧调用者可忽略），保存原 listener 引用并 removeListener；不新增 IPC。

## 5. 确定的领域迁移批次（R3–R5）

每行是一个最小可回退切片，按表顺序迁移。字段是所有权入口，匹配该域剩余函数/局部 state 也归入同一控制器，不跨域暴露 setter。

| 批次 / 计划控制器 | 迁移的状态、入口与依赖 |
|---|---|
| R3.1 `controllers/bank-statement.js` | bankStatementSession、gatewayReconSession、refundOrderSession、processingResult、bankStatementExport、bankStatementImportIssues、bankStatementInflight、bankStatementProcessRunMode；迁移 import/run/export、进度与按钮判断；API 为 bankStatement + 通过 sharedReconSession 使用既有 reconIdFix 方法 |
| R3.2 `controllers/recon-id-fix.js` | reconIdFixSession/result/export/selectedScenarioId/scenarios/billCategory；迁移 reload/refresh/run/export/category 变更；API 为 reconIdFix、只读 scenarios、共享会话服务 |
| R3.3 `dialogs/scenarios.js` | scenarioDraft、场景列表/编辑/类别向导、复制转移批量操作；只接 scenarioCommands、scenarios/channels 只读查询 + 必需 linkedTable 配置及 UI；全部写调用经同一 service，移除反向面板回调 |
| R4.1 现有 `renderer-pending.js` 工厂 | state.pending 迁为闭包；仅 pending API、panel、ui；规则/月度导入/对账/导出弹窗随域管理 |
| R4.2 `controllers/pre-fund.js` | state.preFundReconciliation 和同域处理器；preFundReconciliation API；临时链接表弹窗作为本域配置对话框 |
| R4.3 `controllers/bank-bu.js`、`controllers/duplicate-inbound.js` | 分别迁移 bankBuReconState、duplicateInboundMatchState、restore/import/run/export 与监听；每次只迁一域 |
| R4.4 `controllers/acquiring.js`、`controllers/vcc-op-calc.js` | acquiringBillCurrencyState、vccOpCalcState 及进度/月份选择；仅对应 scoped API；保留 runCancel/runResume 业务规则 |
| R4.5 `controllers/biz-op-legacy.js` | bizOpReconState/restore 与旧界面入口；与现有 BizOP v327 工厂由一个门面按原能力选择，禁用/回退判定沿用原行为 |
| R4.6 现有 Position/VCC Financial OP/BizOP v327 | 不重写内部算法；补 enter/leave/dispose/invalidate，清理订阅和可见刷新；保留各自 status/routeVersion 保护 |
| R5.1 `controllers/statement.js` | mode、monthlyBalanceReady/Preview、canExportDetail/Balance、hasEnum/enumFileName、hasErrorReport、manualBalancePrompt 等业务状态及导入/生成/导出；templates/accounts 从窄 config 服务获取 |
| R5.2 `controllers/new-account.js` | canExportNewAccount、newAccountHasErrorReport、selectedNewAccountCurrencies、行状态 WeakMap 和表单处理；API 为 newAccount 及必需配置读取 |
| R5.3 `dialogs/configuration.js` + `configuration-services.js` | 模板管理/映射/大账号/余额种子弹窗和 drafts；使用对应 templates/accountMappings/bigAccount/balanceAdjustment/monthlyBalance 方法，结果通知调用者刷新其配置视图 |
| R5.4 `renderer.js` 应用壳 | currentModule/enabledModules/window/background/appUpdate 只在壳服务内部保留；移除总 state/elements 向生产工厂的注入，保留显式预览 facade |

R2 可以先对 R3–R5 未迁出域包装旧 refresh/restore；适配器只接命名旧函数，不导出 state。各行完成后删除对应 adapter 和根状态字段，防止两份可变事实并存。事件只绑定在本域 panel 或自己拥有的 modal；全局应用菜单/快捷键由壳显式转发命令，不让控制器查询其他域按钮。

<a id="vcc-source-settlement"></a>

### 5.1 实现审查后的来源与结算补充（2026-09-20）

依据实现审查 R01/R04，落实既有 AC-09/13，不改变金额算法、数据库结构或公开 IPC：

- VCC OP 每次实际 scan 前先撤销旧保存资格，以本域每次扫描对象和跨导航操作锁绑定所选文件、F1确认、统计与F2期初。未确认扫描即使后台已完成，离页后也不得恢复旧来源的F2；重新导入确认后才可保存。F2闭包绑定该来源及自身handle，同文件同金额的新scan也使旧F2失效。
- 已确认来源在重入、打开F2及提交save前通过现有computeAmounts核对月份、完整totals及逐文件metadata。该值用于探测漂移，不能充当不可变文件身份；当前DTO不提供scanId或内容hash。实际Main该IPC读取缓存，同时创建tracked Task和活动日志，新增核对带来的记录需在真实产品Main验收中核对。保存仍只传用户原始beginOp，实际金额和receipt由Main原链路处理。
- F2工厂本地提交锁与controller提供的关闭资格合并后交给宿主；普通关闭遵守busy，强制销毁只撤销旧UI续接。已提交save继续结算，但旧节点不能被迟到结果更新。
- BizOP区分已提交任务与尚未提交的选择。前者的最终反馈归controller保留、重入展示；后者若过期，仅废弃选择并恢复此前反馈，不续发写入、不伪造任务失败。恢复检查也先保存真实ready结算，再限制旧页面后续动作。

收纳弹窗的onCommit负责持久化和Main启用列表接纳；新增可选onCommitted仅在原handle正常提交关闭后导航和重绘。这样保留停用当前模块后切换首个启用模块的行为，同时不绕过保存中的关闭预检。强制销毁不授权该回调。

实现、验证及资金人工复核状态见[实施记录的审查整改](implementation-notes.md#review-remediation)，不以本段技术说明替代运行证据。

<a id="review-r2-lifecycle"></a>

### 5.2 第二轮复审的生命周期余项补充（2026-09-20）

沿用Spec §3.2／§3.3／§4及AC-03／14，不新增Main接口、删除规则或金额合同：

- 拆分配置由父会话统一持有活动写资格，行编辑、删除、份数、合并组、金额元数据及规则子层通过同一写入口执行。提交前冻结原参数，父子canClose共用忙碌条件；开始任一写入都使旧删除预检失效。预检尚未提交时允许关闭，但回包须同时满足原视图存活、仍为有效预检及原行仍属于当前表；预检失败不按无组结果继续删除。
- 已发送的配置互斥配套写按提交快照完成，强制销毁只撤销旧UI续接，不能伪装为取消。写入失败保持原确认／草稿并允许重试；无组合的有效删除预检仍沿用直接删除，有组时保留原组解散确认。
- 实际映射父层每次打开拆分窗口前重读配置，父handle、入口、打开请求代次及父写代次均有效才挂载；读取失败不采用旧缓存，入口关闭后重新启用也不能复用旧读。按钮返回在异步onClose期间保持原拆分层并阻止普通关闭／写入，回调结束后精确关闭该层。onClose新增可选只读{isCurrent()}上下文，旧忽略参数的回调兼容；实际父调用方在重读后检查该资格，force子层销毁后的旧回调不能更新父缓存或关闭新层。
- BankStatement／ReconID将session读取错误与其覆盖前的有效反馈单独保存；下一次有效成功仅撤回仍占据状态框的该读取错误。确定结果失效时按Main事实重绘；较新业务、进度或其他读取反馈取消旧恢复资格。正常静默刷新继续保留有效欢迎／导出提示，旧请求仍受页面与读取代次约束。

该补充落实既有已关闭视图不发新写、busy防重及读取恢复合同；五项事实、前后验证与未完成验收见[第二轮整改记录](implementation-notes.md#review-r2-remediation)。

<a id="review-r3-partial-save"></a>

### 5.3 第三轮复审的金额配置部分成功补充（2026-09-21）

规则与元数据沿用既有两个独立提交；Main在数据库落库后同步模板文件仍可能报错，不能把failed或reject解释为数据库回滚。拆分父会话的signed／byField清规则链共用saveAmountConfiguration，仍由runWrite持有唯一提交资格：

- 第一阶段明确成功才继续一次原元数据写；失败不自动重试、不补偿、不续发未获成功确认的下一阶段。已经开始的配套写按原快照结算，销毁视图不截断后台写链。
- 任一阶段失败且原视图仍有效时，在同一busy内调用既有getBillSplitConfig重新读取事实。结算后先恢复控件，再同步规则和元数据、入口显隐及互斥资格；原错误提示保留。恢复仅接纳金额配置，不用返回的持久化行覆盖未提交的行草稿。
- 用户重试启用signed时，无论规则是否已由上次操作清空，都清除旧byField目标序号，避免两类目标并集错误扩大金额列禁用范围；仍不自动重试。
- 重读也失败时，仅接纳明确成功的阶段，提示关闭后重新打开确认；该会话暂停配置写入，但允许正常关闭。迟到读取与结算不得修改已销毁视图、弹出旧提示或接管新窗口。

原工厂参数、父子返回、Preload／Main接口、独立提交与业务参数保持；本补充修复Renderer与已提交事实不一致。当前规则入口见Renderer README，实施、验证与集成状态见[第三轮整改记录](implementation-notes.md#review-r3-remediation)。

## 6. 场景结果与共享会话（R3）

### 6.1 摘要由 Renderer 命令服务生成，IPC 保持

新增 `createScenarioCommandService({ scenariosApi, channelsApi, publish, reportError })`，由 composition root 显式注入已有 Preload 方法。返回 `{scenarios, channels}` 两个命名分组；各写方法名/参数/返回值沿用对应 Preload 分组，避免两个 create/update 相互覆盖。`scenarios.list/get` 也由 service 透传；只有通过 §6.1.1 的服务 epoch/写入边界校验，成功返回的 id→category 才可记为分类证据；其他只读枚举可直接注入窄查询。`publish` 是单向内部通知，不更改 IPC 返回。dialog 只接这个 service 和只读查询，不能自行填结果 scope，也不直接通知具体 controller。

```js
// 一条已经成功的 Main 写命令只发布一次；revision 在窗口级 service 中单调递增。
Object.freeze({
  kind: 'scenarios-changed',
  command: 'scenarios:transfer',  // 准确 IPC 名，不使用含糊 batch/copy 代替
  categories: ['extract-recon-id'], // 数据/列表元数据，不决定结果域
  scenarioIds: [id],
  invalidationScope: ['bank-statement', 'recon-id-fix'],
  revision
});
```

`categories` 和 scope 数组都去重冻结；scope 仅允许上述两值或空数组。类别可能未知，采用 `categories:[]`、`categoriesComplete:false`，不能猜成普通类别。`bank-statement` 对应 Main processingResult，`recon-id-fix` 对应 Main reconIdFixResult；共享网关是后者的另一展示者，不是第二个结果实例。

create 的确定失效类别取本次实际提交 payload，其他按 category 分流的命令只使用 §6.1.1 证明有效的 **Main get/list 元数据及本次 invocation 的只读证据**，不取筛选项、draft 或仅凭数字 ID 命中的历史值。缺项、过期或补读跨写时仍只发一次原写命令；成功结算但类别无法证明时发独立 `scenarios-resync-required`（两域重读、暂禁过期导出，不宣称确定双清），由 Main hasResult 决定结果/反馈是否失效，仍有结果时保留原反馈。delete 返回 deleted:false 仍是空结果 scope；固定 scope 的 transfer/batch-delete/applyImport/setApplicableChannels 保持 §6.2 矩阵，不受类别缓存命中与否影响。

`scenarios-resync-required` 的内部形状固定为 `{kind, command, resyncScope:['bank-statement','recon-id-fix'], revision}`，不携带“确定已清”的 invalidationScope；router 按 kind 走重读分支，并刷新相关场景列表。`scenarios-closed` 只有 kind/revision，走原无变更刷新分支。

渠道 CRUD 成功的最小内部通知固定为 `{kind:'configuration-changed', resource:'channels', command:'channels:create'|'channels:update'|'channels:delete', channelIds:[id], invalidationScope:[], revision}`。id 取 create/update 的成功 `result.channel.id` 或 delete 的成功 `result.id`；数组去重冻结，revision 使用同一窗口级命令服务计数。每个成功命令发一次，失败/取消不发；这不新增 IPC 或结果失效行为。

`scenarioChangeRouter` 对该 kind 仅转发到由 composition 固定注册的 `configurationSubscribers.channels` 列表，不调用两域的结果 `invalidate`，不通知 sharedReconSession。订阅者仅为现有需要渠道列表的视图：场景管理的渠道筛选、渠道管理、转移目标选择、builtin 适用渠道选择，以及 BankStatement 的渠道配置选项。注册返回取消函数，由对应 controller/dialog scope 在 dispose 时执行；回调只通过既有 `channels.list` 重读选项并沿用原选择保留/失效回退规则，使用本视图请求代次拦截晚到结果，不重置场景草稿、运行结果、导出按钮或导出反馈。未挂载的视图不因通知被创建，下次打开沿原流程重新查询。本协议由既有 G3-AC-10、G3-AC-16 覆盖。

传输 reject/无法判定结算也用 resync-required，不广播成功 mutation；服务端明确失败不制造 mutation。连续命令逐个结算和发布，不能等整个 UI 表单成功才补发。revision 归应用级 service，不随 dialog 关闭重置；成功后无论原管理窗是否仍挂载都先发布领域失效，界面反馈另受句柄代次保护。仅关闭管理窗发 `scenarios-closed` 以轻量 reload，不重发历史 mutation。

<a id="scenario-metadata-consistency"></a>

### 6.1.1 类别元数据的唯一 owner、写入代次及 ID 复用（R9 修订）

[scenarios-repository.js:407](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/database/scenarios-repository.js:407)通过 `calculateNextScenarioId` 复用最小空闲 ID，[createScenario:428](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/database/scenarios-repository.js:428)将其用于新记录。update 不允许改类别只保证**同一记录存续期间**类别不变，不能证明 ID 删除重建后类别相同。本方案使用全局元数据 epoch；不新增持久版本、DB migration 或 IPC 字段，不设计可被误当作身份的 id-only 长期缓存。

服务唯一持有以下私有状态，不由 dialog/controller 回写：

```js
metadataEpoch = 0; // 仅元数据有效期：每次写开始、结算及服务销毁递增
categoryById = new Map(); // id -> { category, epoch }；只保存分类元数据
activeWrites = new Map(); // invocationId -> { dispatchEpoch, categoryEvidence }，包括渠道写
writerBoundaryTrusted; // 装配覆盖完整且不存在未知结算时才为 true
// event revision：成功变更/重同步通知的去重序号，不参与元数据新鲜度证明。
// controller requestGeneration：页面渲染的晚到响应屏障，不控制上面的 Map。
```

**可信边界前提。** 普通运行中可能修改 scenarios 的全部生产入口必须经这一 service；包括 create/update/delete/toggle/transfer/batchDelete/setApplicableChannels/applyImport，渠道写也纳入 epoch 以覆盖其配置关联变化。初始化 seed/迁移必须已在业务窗口启用前收口。只有这一前提经装配和调用方清点成立、且没有另一个未观察 writer/未决旧服务写入时，才允许 `writerBoundaryTrusted=true`。迁移期仍有旁路、窗口/服务重建无法证明旧写已结束、或存在额外写入来源时，默认 false；继续调用现有写 IPC，只对依赖旧类别的结果走 resync。不能把“当前 activeWrites 为空”当作证明外部没有写入。

**读返回规则。** 每次 list/get 发出时捕获 `{serviceIdentity, epoch:metadataEpoch, quiescent:activeWrites.size===0}`。只在同一存活 service、起止均无活动写、epoch 完全相同、writerBoundaryTrusted=true 且响应合法时写入 categoryById。仅当前无参数 `scenarios.list()` 的完整返回可整体替换 Map；调用方在此之后用于显示的过滤结果不得回写。若未来出现按类别筛选或分页 list，其结果不进入此全表缓存，也不能删除本页/本类别未包含的 ID；必须先另行定义覆盖范围合同。get 只更新所请求的对应 ID，明确不存在时删除对应条目。读失败/字段非法不入缓存，不能保存成普通类别。跨写的读结果仍按原 API 返回给页面，由页面自己的 generation 处理展示，但 service 必须丢弃其元数据；页面随后不得把它再喂回 service 或当作写命令的分类证据。同 epoch、无任何写的并行读只用于 id/category，该字段在此区间不变；无须按“哪个 Promise 最晚返回”覆盖身份版本。

**每次写的确定顺序。** 所有状态步骤在 service 内完成，不能依赖调用方恰好先 reload：

1. update/delete/toggle 先检查当前 epoch 的可信条目；没有时最多调用一次既有 get 补读，按上一段规则接收结果。不在循环中追赶写入，不因补读失败阻断原写命令。补读等待期间另一写开始/结算会使其 epoch 失效；此时本次 invocation 的 categoryEvidence 为空。
2. 准备调用写 IPC 的同一个同步段中，先校验 evidence.epoch 仍等于当前 metadataEpoch、writerBoundaryTrusted=true、activeWrites 为空；仅满足者把类别和当前 epoch 冻结为本次证据。然后递增 metadataEpoch、清空整个 Map，将 invocation 加入 activeWrites 并记录递增后的 dispatchEpoch，紧接着调用一次原 IPC，中间不 await、不做第二次读。这是元数据屏障，不是业务全局锁；另一写可以照常发出。
3. IPC 结算时，在移除此 invocation **之前**检查 `metadataEpoch===invocation.dispatchEpoch`、activeWrites 仅含本次 invocation、writerBoundaryTrusted 仍为 true。只有这些条件及原 categoryEvidence 同时满足，update/delete/toggle 的成功才可按该证据发确定类别 scope。另一写在本次发出前尚未收口、发出后插入，或其结果先返回，均使本次证据失效；即使另一写最终失败，也保守 resync，不猜 Main 的交错次序。
4. 无论成功、明确失败、取消还是 invoke reject，先递增 metadataEpoch、清空 Map、移除本 invocation，再按下表最多播种已证明的新条目；此后再发布对应事件，避免订阅者在旧缓存仍有效时发起下一写。保留原响应/异常和写入次数，不回放、不重试原写。
5. invoke reject、不可判定结算、无法解析的写响应将 writerBoundaryTrusted 置为 false；旧条目不能以旧 epoch 复活。一次成功 list/get 只能说明那次读取，不能证明未知写已结束，故不能清除该标记或重新播种。此 service 不提供“查询成功即重置信任”的接口；当前 IPC 没有用于证明未知写全部终止的有序屏障，本轮不新增屏障，也不提供运行中恢复 trusted 的快捷入口；后续依赖类别的写照常执行并走 resync，业务不被阻塞或重试。只有完整应用重启、旧 Main 已退出且新 Main 启动初始化完成后，满足全部写入口唯一覆盖的新 service 才可自然建立可信边界；仅窗口重载、重建 service、事件 revision 递增、页面 enter 或恢复页刷新都不等于旧 Main 请求已结束，不能作为信任重建证据。

| 本次写的结算 | 写后元数据（均先全局失效；不把本表当作业务结果失效矩阵） |
|---|---|
| create 成功，成功 ID 合法、提交类别合法，且从 dispatch 到结算无交错、无未知写 | 用**成功 result.id + 本次已提交 category**播种新 epoch 的一个条目，覆盖同数字 ID 的任何旧实体；create 的结果 scope 始终按本次 payload，播种条件不成立只保持空缓存 |
| update/toggle 成功且本次类别证据仍可信 | 可在新 epoch 播种本 ID 同类别；不能继承未经本次证明的其他条目 |
| delete 成功（含 deleted:false）或 batchDelete 成功 | 整份 Map 保持空，保证相关 ID 原实体已移除；不建立永久 tombstone 阻止未来合法复用 |
| transfer、setApplicableChannels、channels CRUD 成功 | Map 保持空；这只是元数据失效，结果 scope 继续 §6.2，不把渠道变更升级为双清 |
| applyImport 成功，包括 importedCount=0/跳过同名 | Map 保持空；成功响应不是完整 ID→category 表，不能只更新 imported IDs 或据导入计数推断旧映射仍有效 |
| 明确 failed/cancelled | Map 保持空、结束本次 activeWrites；不回滚到写前快照，不广播成功 mutation；其他不确定写仍保留其信任限制 |
| reject/结算不明/服务销毁 | Map 清空、旧读永久不能回填本代 service；依赖类别的后续成功走 resync；关闭 UI 不声称撤销已发出的 Main 写 |

**结果分类的优先级保持。** §6.2 的固定 scope 命令不需要旧记录类别，成功仍发布原固定 scope；create 使用本次提交类别，delete 的 `deleted:false` 不清结果。只有 update/delete-true/toggle 的旧记录证据不可信时切到原 resync-required，不把“缓存未知”当作 Main 的未知 category 双清。查询明确返回的未知 category 也须通过同一 epoch/无交错证明，才可沿 Main 的未知类别双清规则；除此之外未知信息只能重同步。

### 6.2 完整命令、调用方与 scope 矩阵

| Preload 命令 / Main 依据 | 现有调用方（`src/renderer-dialogs.js`） | 成功 scope / 特殊点 |
|---|---|---|
| create / [Main:5296](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:5296) | 确认详情 finish:11540；复制仅把源场景填入新建 draft，最终同入口 | 由提交 category 分流 |
| update / [Main:5306](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:5306) | 确认详情:11549；builtin 优先级/配置:8818 | 由原记录 category 分流；不支持改 category |
| deleteOne / [Main:5334](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:5334) | 单项删除:8043 | deleted:true 按原类别；false 空 scope |
| toggleEnabled / [Main:5348](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:5348) | 单项启停:8095 | 按原记录 category 分流 |
| transfer / [Main:5366](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:5366) | 单项/批量共用转移工厂:6559 | 两域；与选择了哪些 category 无关，数据库整批事务 |
| batchDelete / [Main:5381](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:5381) | 批删确认:8201 | 两域；无单类优化、无虚构部分成功 |
| setApplicableChannels / [Main:5404](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:5404) | builtin 适用渠道保存:8794，随后独立 update priority | BankStatement；后一步 update 失败不撤回前一步通知 |
| applyImport / [Main:5675](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:5675) | 缺失渠道确认:8266；ready-to-apply:8297 | 两域；importedCount=0 仍按 Main 成功双清 |
| importBundle / Main:5591；exportBundle、list/get/getApplicableChannels 与枚举查询 | 导入预检/导出/编辑加载 | 空 scope；needs-confirm/ready-to-apply 不是已导入，只有 applyImport 发结果失效 |
| channels create/update/delete / [Main:5426](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:5426) | 渠道编辑:6178、删除:6198、新建:6262 | 空结果 scope，仅 configuration-changed 刷新列表；不在 G3 中暗改 Main 行为 |

category 分流精确集合：`extract-recon-id / offset-bill-mark / gateway-recon-join / builtin-fixed` → bank-statement；`recon-id-fix / gateway-recon-id-fix` → recon-id-fix；Main 实际未知 category → 两域，保留 Main warning。不是按“含 C4/非 C4”对所有命令统一判定。实施开始和 R3 完成前各清点一次 Preload 场景/渠道写方法与全生产调用者，上表以当前基线为准；新增命令必须先补 scope 合同和回归。

### 6.3 结果路由与共享网关

router 只读 scope：BankStatement 普通结果按 bank-statement 失效；ReconID 结果按 recon-id-fix 失效，BankStatement 的 gateway 展示缓存也订阅该共享结果，即使当前显示普通 bank 面板也先标记其网关缓存 stale；只在可见时即时渲染，切换后从 Main 重读。两域 scope 必须把两侧结果/可导出状态/已导出反馈与 Main 对齐。控制器收到确定失效时递增相应请求代次、禁用旧结果导出、清对应 renderer-only export，再读 Main；不可见域先标记 stale，进入时读取。scenarios-resync-required 与无变更关闭是不同事件：前者暂禁不确定的导出并重读，后者不主动清结果或导出文案。

categories 只驱动场景下拉/列表 reload；不能据其过滤掉已命中的 scope。单项 C4 变更不清 BankStatement 普通 bank 结果，双清命令则必须清；处于 gateway 模式时重读共享事实，不复制结果。运行模式继续读取显式 bankStatementProcessRunMode，不通过 session 有无猜测。

`sharedReconSession` 明确暴露 `import(payload)`、`run(payload)`、`export()`、`sessionStatus()`、`clearSession()` 五个现有 reconIdFix 方法的透传包装，以及 `subscribe(listener)`（返回取消函数）。包装不更改 IPC 入参或结果；`run` 保留 `originModuleId:'bank-statement-process'` 等既有来源身份。`import/run/clearSession` 的结算由包装层唯一递增 revision 并通知 `{source, kind, outcome, revision}`，失败也通知“需重读”，不伪装成功；只读 sessionStatus 不发 mutation 通知。

两个控制器仍保有自己的面板展示缓存，收到通知标记 stale，Main 返回唯一事实。网关运行成功时 ReconID 控制器清原导出文案后重读；运行失败时按原逻辑重读 Main 状态，不能一律保留旧成功，也不凭 UI 局部错误推断 Main 已清结果。export 的反馈由调用者维护；共享服务不保存第二份导出/明细。subMode/category 校验继续在 Main，切账单类别仍按既有 clearSession 顺序执行。

## 7. 兼容转发与移除门槛

R1 的旧工厂返回 DOM 形状可暂时保留，但挂载必须进入 host；有资源的 DOM 使用 WeakMap 关联 descriptor，不在节点上挂完整业务 state。新代码只使用 factory/handle 合同。

每个切片移除旧代码前同时满足：生产调用者全迁移、预览调用者更新、对应行为测试通过、G8 或本分支扫描不再找到旧直写。保留公开 Preload 方法和 IPC，Pending 订阅新增返回取消函数为向后兼容的内部能力补足。

经典脚本新增顺序固定为：原 shared 纯脚本 → modalHost/router/services → 新领域 dialogs/controllers 及现有独立控制器 → 兼容 Dialogs/Previews → renderer.js 装配。依赖方向为控制器消费服务，服务不引用具体控制器；编排引用双方。不得在 classic script 顶层执行 IPC。

## 8. 测试设计与 AC 映射

全部测试为后续实施要求，本次未执行。

| 测试入口 | 类型 / 要求 | AC |
|---|---|---|
| 拟增 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/renderer/modal-host.test.js` | 使用事件可观测 fake DOM 运行完整公共工厂；重复 close、blocked root replace、工厂异常、回调异常、父子关闭与晚到任务 | G3-AC-01–G3-AC-04、G3-AC-06、G3-AC-07、G3-AC-14 |
| 拟增 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/renderer/modal-integration.test.js` | 真实 VCC 工厂 + 公共 close；linkedTable→mapping→alert 的 load reject、合法空、save success/失败；Position confirm；真实 Archive Settings/Delete 与 Toolbox/Picker/Alert 完整工厂，覆盖 §3.5/§3.6 的父子 scope、锁、token、迟到响应 | G3-AC-01、G3-AC-04、G3-AC-05、G3-AC-14、G3-AC-17、G3-AC-18 |
| 拟增 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/renderer/module-router.test.js` | 所有注册 controller 合同；leave blocked 不切换，重复进入、A/B/A 延迟响应、dispose 后订阅归零 | G3-AC-08、G3-AC-09 |
| 拟增 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/renderer/scenario-change-routing.test.js` | §6 全命令矩阵；真实 command service/router/两个 controller + 既有 Main handler 的最小 harness；普通/C4 单类 transfer/batch-delete 双清、import 0 成功、单项反例、渠道通知 shape/准确订阅者/重复与取消订阅及两域结果不变、预检无失效、连续保存半成功、缺元数据 resync、跨类别同 ID 复用、服务 epoch 拒绝旧 list/get、交错写与未知结算；断言结果/按钮/导出反馈而非函数名 | G3-AC-10、G3-AC-11、G3-AC-15、G3-AC-16、G3-AC-19、G3-AC-20 |
| 拟增 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/renderer/controller-contract.test.js` | 按 R3–R5 的注册表逐域验证 scoped deps、私有状态、enter/leave/dispose、过期响应 | G3-AC-08、G3-AC-09、G3-AC-12 |
| 拟增 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/scripts/test-renderer-lifecycle.js` | 真实 Electron 隔离 userData/Documents；键盘、焦点、inert、嵌套、导航、关闭中加载返回；加入 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/scripts/integration-runner.js` 的明确枚举 | G3-AC-04、G3-AC-06、G3-AC-07、G3-AC-13、G3-AC-14、G3-AC-17、G3-AC-18 |

复用并按迁移范围改造以下真实现有测试：[renderer-vcc-financial-op.test.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/renderer-vcc-financial-op.test.js)、[renderer-position-reconciliation.test.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/renderer-position-reconciliation.test.js)、[renderer-dialogs-fund-transfer-account-mapping-load-guard.test.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/renderer-dialogs-fund-transfer-account-mapping-load-guard.test.js)、[renderer-dialogs-scenario-channel.test.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/renderer-dialogs-scenario-channel.test.js)、[renderer-bank-statement-run-progress.test.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/renderer-bank-statement-run-progress.test.js)、[archive-center-ui-contract.test.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/archive-center-ui-contract.test.js)、[renderer-dialogs-toolbox.test.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/renderer-dialogs-toolbox.test.js)及对应 domain 单测。

R9 最小行为验收仍放在 `scenario-change-routing.test.js`，加载真实 command service/router/controller 工厂，使用真实 Main 场景 handler、真实 scenarios repository 与临时内存 SQLite，通过可控 Promise 桥延迟真实已查询结果的交付；不实现一份与设计同构的假缓存代替被测服务。测试必须包含：

1. C4 create→list/get 留一份延迟响应→delete→普通类别 create，断言仓储复用同 ID；先交付新响应/成功创建，再交付旧 list 和旧 get；在后续单项命令前重新为 Main 和两侧 controller 预置各自成功结果及导出反馈，避免两侧早已为空而形成假通过。分别从独立 fixture 执行 update、toggle、delete（delete-true 后重建再测下一种），scope 必须命中当前普通类别，Main 与两个控制器的结果、导出按钮、反馈一致，C4 的未命中结果保持；普通→C4 反向复用同测。
2. 缺项补 get 期间插入 delete/create 或 applyImport，旧 get 晚到后仍只发一次原写；即使响应 category 字段合法，也不得发旧 category 的确定 scope，必须进入 resync。另覆盖写 A 尚未回包时写 B 开始/完成，以及 A/B 逆序交付；全局 epoch 不能只看某个 ID 或事件 revision。
3. batchDelete/applyImport 后整份 Map 失效；importedCount=0 不恢复旧表；create 回包时有交错不得播种；明确失败不恢复写前缓存；未知结算后成功 list/get 不能擅自恢复信任。固定 scope 命令仍使用原矩阵，deleted:false 仍不清结果。
4. service 与页面 generation 分别验证：页面忽略旧渲染结果不能代替 service 丢弃旧元数据；service.dispose 后旧查询不得影响新服务，无法证明旧 writer 已结算的新服务使用 resync；全部用例检查业务写 IPC 调用次数不增加，不以检查源码含有 Map.clear 或 epoch++ 验收。

新增 modal integration 最小用例不得仅构造通用空弹窗：加载本次迁出的真实 `dialogs/app-settings.js`、`dialogs/toolbox.js` 和其确认/选择工厂，API 用可控 deferred promise、可观测 token/参数的 stub，不执行真实删除或输出。存档依次覆盖期限保存中零预检、预检中发起保存不进确认、取消零 delete、双击只发一次原 token、完整/待清理成功刷新、失败留层、父销毁后晚到响应与退订恰好一次；工具箱覆盖 splitRead 成功后原 token 到全部三种 payload、单/多模式切换、取消零 export、保存取消/成功/失败返回、旧 read 晚到不 push、stale token 不重试、父层最终清理一次。将现有 contract 测试继续用于原业务文案/参数，新增工厂运行断言用于迁移生命周期，两类证据分别记录。

迁移一段生产代码时，同步把绑定该段函数名/字符串位置的断言转为运行工厂的行为断言；本次不删除无关安全断言、不一次重写全部测试。fake DOM 不证明真实焦点/inert，真实 Electron 测试不证明 Windows Excel/WPS 输出，证据必须分别记录。

## 9. 实施顺序、回滚与交付

先在最新确认 v3.2.9 基线上创建计划分支，保护脏工作；按 R1 → R2 → R3 各行 → R4 各行 → R5 各行推进。R1 内按“宿主→公共/VCC→映射/Position→存档父子会话→工具箱父子会话→全入口闭合”逐块验证；存档和工具箱未通过 AC-17/18 时 R1 不完成。R3 先建立命令矩阵、含 §6.1.1 元数据屏障的 service 并通过 AC-19/20，再迁 BankStatement/ReconID controller，最后切换全部场景/渠道写调用并删旧反向刷新；用真实 handler/controller 对照后才移除兼容入口。G8 可先建待激活规则，R1/R3 合入同一集成分支时激活，不让“文件尚不存在”成为假通过。

每切片包含实现、调用者迁移、对应行为测试、兼容移除记录；先运行相关单测和本切片集成，正式 GUI/PR-ready 完成时运行完整 `npm run release-check` 和适用 GUI 验收。没有新变更/失败/疑点不重复扩大测试。

回退以切片为单位，保留当时一致的宿主/工厂/装配/测试组合；禁止只撤回 modalHost 而留下新句柄消费者。无持久化 schema 变更，不迁移或清理用户数据。对已经发出的 IPC，前端回退和销毁都不声称业务回滚。

## 10. 切片实施记录与规则同步（文档补充）

沿用本稿既有阶段及任务 ID，按[切片完成标准](../../README.md#slice-completion)逐项交付。优先复用本功能目录已有的 `implementation-notes.md` / `verification.md`；首次实施且没有适用记录时建立 `implementation-notes.md`，使用[实施记录与状态要求](../../README.md#slice-record)中的最小字段，避免同一事实多处维护。设计 AC 和测试计划与实际迁移状态、执行结果分别记录，本次不建立实施记录占位文件。

按[各治理项现行规则入口映射](../../README.md#current-rule-entrypoints)同步本切片影响的规则正文和入口链接。只有职责已在实际生产调用路径落地的模块才能记为现行入口，尚未实现的模块继续标为拟新增；不影响规则时，在切片记录中写明无需更新及原因。本次为文档要求补充，不表示生产实现、边界激活或验证已经完成。
