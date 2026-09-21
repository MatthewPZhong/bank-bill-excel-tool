# R3-01 配套写分阶段事实独立审查

日期：2026-09-21。唯一工作目录：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-renderer-boundaries`。范围严格限定 `createBillSplitRowsDialog` 的两条 `saveBillSplitAmountRules([]) → saveBillSplitMeta(payload)` 链、该工厂 `runWrite` 的 disabled 恢复顺序及对应状态展示。主 Agent 修改产品，modal_host 修改共享回归；本审查仅写本目录。

来源：`changes/v3.2.10/codex/v3.2.10-renderer-boundaries/review-2026-09-20-r3.md` R3-01、其真实仓储探针与真实工厂探针；同时逐段核对当前仓储保存和 Main 两个 handler。既有审查、历史日志、快照均保持原样。

## 1. 独立确认的事实边界

| 阶段／响应 | 可确认的事实 | 不能据此断言的事实 |
| --- | --- | --- |
| clearRules 返回 success | 此次清空规则已成功；后续 meta 失败不会回滚它 | 不能声称 meta 新值也已保存 |
| clearRules 明确在数据库写前失败 | 不进入后续 meta；保留最后确认的规则状态 | 该“写前失败”需要明确注入点，不能从普通 failed 字符串推断 |
| clearRules 非 success／reject | 没有收到清空成功确认；不继续本次 meta | 不能一律声称旧规则仍持久化，可能为已写但回包／后续文件同步失败 |
| meta 返回 success | 可以接纳捕获的完整 meta payload | 无法反向用 meta 成功取代第一阶段应有的结果检查 |
| clearRules success，meta 非 success／reject | 第一阶段已确认，必须清除旧规则缓存和旧规则管理入口；保留第二阶段失败信息 | 第二阶段是否落库不能仅由非 success／reject 判定，不能伪造回滚或成功 |
| 前端 force dispose | 已发送操作及该次已接受的配套链继续真实结算 | 不应继续修改旧 DOM、显示旧告警或接管新窗口；dispose 不是数据库取消 |

仓储 `saveBillSplitAmountRules`（template-repository.js:835）自行 BEGIN/COMMIT，`saveBillSplitMeta`（:886）是后续独立 SQL。原探针在内存 SQLite 给第二步 UPDATE 安装拒绝触发器，结果规则为空而 meta 旧目标仍为 `[1]`，证实此具体失败注入点不回滚第一步。独立重跑原探针 exit 0，输出保留为 `repository-partial-write.log`。

Main 两个 handler 在 `database.save*` 后还调用 `syncTemplateLibraryFile()`，之后才返回 success。后者最终执行 mkdirSync/writeFileSync，异常会被 handler catch 转为错误结果。因此普通错误结果不等于数据库没写。此次记录不把保留的“最后已确认 meta”叫作已经证明的当前数据库状态；此边界不要求本轮修改 Main 事务，也不把已有后端写入流程扩大为新审查项。

## 2. 修前真实工厂独立探针

`partial-stage-fixture.cjs` 使用真实 rows、rules 工厂和宿主，API 为明确的合成内存存储与延迟 Promise。两条链为“按字段设空”和 signed 变更；后者由程序化 change 调用实际 handler，以覆盖其已存在 clearRules 分支，不声称是在初始互斥 disabled 状态下可由鼠标完成的人工路径。

四个组合为两条链 × 第二步 failed/reject。清空规则 API 先真实更新合成存储为 `[]` 并返回 success；meta API 延迟后失败，探针特意不写入合成 meta。这个明确故障注入能观察缓存和 UI，不能证明现实 IPC reject 时数据库必定没有写入。

修前使用 `tmp/g3-review-r3-fixes/before` 的保留源码，结果 **0/4 PASS**，见 `partial-stage-before.log/.json`：

- 所有组合在第二步等待时 close 为 blocked，全部父控件 disabled，只有一次 clear 和一次 meta；busy 基础门控本身通过。
- 清空后的合成规则存储为 0，但管理按钮仍显示、signed 仍 disabled、旧目标标签仍可见、行 Credit 仍 disabled。
- 重新进入规则编辑器仍带入“入金／出金”旧规则；signed 链还保留未经成功确认的尝试值 `Amount`。
- 错误提示存在，未产生宿主错误；修复应保留失败反馈，不能恢复 R2 忽略第二步错误的行为。

## 3. 最小实现建议与 disabled 顺序

仅收到 clear success 时记录／接纳第一阶段事实，meta success 才接纳完整 meta payload。可使用本次 operation 私有阶段标记，在 `runWrite` 恢复原 disabled 快照之后、原 handle 当前资格校验之后，再同步已确认缓存和按这些事实重绘；失败路径也执行此阶段收口，再保留原失败告警。

不能在 await 链中先重绘“规则已清空”的控件资格，最后又由 `finally` 将旧 `disabled=true` 写回。另一风险是忙碌中重绘产生新节点，未被初始 controls 快照覆盖，从而提前变得可编辑。最小方案将最终 UI 收口放在 busy 释放之后，同步完成后才显示失败告警，且没有中间 await 让新的用户事件插入。

展示要从已确认事实恢复两种 select、规则管理入口、目标标签和 picker，再通过 `initTargetSeqUI` / `rerenderTable` 计算双向互斥和行控件资格。只把 currentAmountRules 清空、却保留未确认的 signedSelect 尝试值，会继续呈现成功错觉。原 currentBillSplitMeta 的未成功阶段保留为最后确认值，不称作服务器回滚后的值。

同一写链仍占有原共享 runWrite 资格；不拆成两个独立 begin/finally，不允许其他写插入阶段间，不新增 Main 事务接口。不扩其他工厂或父 mapping 生命周期。

## 4. 最终实现与复验

最终定点源码 SHA-256 为 `4f14103f3062c6405ff5e18a7b286d06d075aeb87d56f20907c34b370deb1ec9`；正式 fixture 为 `3e23890185f0be8d382474532717f9203724fc89680c68b6cf2a3cfeba1c505f`。独立读取最终文件哈希，与实际执行记录一致。

已核对以下实现和调用闭合：

1. `saveAmountConfiguration` 仅由本次 signed 金额配置和 byField 清空两条原链调用，捕获的 templateId/meta payload 保持原会话身份。第一阶段非 success 不发第二阶段；没有自动重试、补偿写或新增 Main 事务。
2. 任一保存非 success／reject 后，在同一 activeWrite 资格内只读 `getBillSplitConfig`。读取成功只接纳 rules/meta，不以服务器 billSplitRows 替换当前行草稿。最初的业务错误仍显示，读取到已落库结果也不伪装成原调用没有失败。
3. `runWrite` 的 finally 先解除 activeWrite、恢复原 disabled 快照；紧接着检查原句柄仍当前，再同步调用 `onSettled` 接纳阶段事实和重算控件，二者之间没有 await。两个金额 select 的 disabled 都完整赋值，避免以前 signed 分支只禁用 byField、却保留 signed 旧禁用状态。
4. 恢复读也失败时，规则只在已确认 clear success 的情况下清空；meta 保留为最后确认值，原错误追加“当前配置未能重新读取，请关闭后重新打开以确认”。`configurationNeedsReload` 拒绝本会话全部交互／写入口，并禁用除关闭按钮之外的控件。`closeRows` 明确绕开该写锁，只检查 activeWrite/closing/原 top，因此普通关闭仍可成功。
5. force dispose 不截断该次已接受的配套链，也不触发销毁后的新恢复读。已经开始的恢复读可继续结算，但最终原句柄校验拦截旧 DOM／告警／新栈续接。

独立四条修前为 0/4、首版阶段修复为 4/4；分别保留在 `partial-stage-before` 与 `partial-stage-after` 的 log/json 中。四条版本的 fixture 原文另存为 `partial-stage-four-cases.cjs`，SHA 与这两次 manifest 所记的 `3a211b3c...` 相符。它们检查两个链的第二步 failed/reject、错误保留、管理入口和 select/行资格、空规则编辑器，以及服务器读取返回另一行快照时原两行和 Currency 草稿 `Condition` 仍保留。

### 4.1 独立发现并闭合的重试目标残留

首版阶段修复正确接纳 clear success 后，规则缓存成为空；用户主动重试 signed 时 `clearRules=false`。若 meta 的按字段目标仍是旧 `[1]`，旧载荷条件会保留它。行资格代码读取 signed/byField 目标并集，因此当本次 signed 目标为 `[2]` 时，第 1 行也会错误禁用。不能以放宽测试期望将该残留视为正确。

主 Agent 已授权并定点把 signed 启用时清空 byField targets 的条件改为 `newValue` 为真，与是否还需要重复清规则分离。没有新增自动重试；成功重试仍只有一次用户触发的 meta 调用。

独立用例采用 signed targets `[2]`、旧 byField targets `[1]` 两行合成配置：

| 快照 | 第二次 meta 的 byField targets | 第 1／2 行 Credit disabled | 第 1／2 行 Debit disabled | 结果 |
| --- | --- | --- | --- | --- |
| 首版阶段修复 `f36ad644...` | `[1]` | `[true,true]` | `[true,true]` | `signed-retry-before`：0/1 PASS，确认目标残留 |
| 最终 `4f14103f...` | `[]` | `[false,true]` | `[false,true]` | `partial-stage-final`：该项通过；与原四项合计 **5/5 PASS** |

首版中间源码 `before-retry-configuration.js` 是从最终版本逆向还原最后一行条件得到的比较副本；其完整 SHA 精确为已经实际运行过四项的 `f36ad6446e47ee30769278c04c5e522c50e0103f9dec1c180f89202e1b038d29`。JSON 明确记录 configurationOverride，不能把它描述成当前产品源码或原 R3 修前 4c34 快照。该副本只写本审查目录，没有修改产品。

最终独立 5/5 的 clear 总次数为 1、meta 总次数为 2（第一次失败、用户主动重试成功），模板仍为 7；没有重试 clear、重复提交或悄悄新增 Main 写。主 Agent/测试 Agent 也将 signed 目标交错纳入严格正式 fixture。

### 4.2 正式 fixture 与独立证据的区别

已读取测试 Agent 最终 `tests/after.log/.json` 与 `verification.json`：同一严格 fixture，修前 **67/80 PASS**，最终 **80/80 PASS**，exit 0；原 61 条保留，新增 19 条覆盖首阶段 failed/reject、第二阶段 failed/reject/cancelled、两阶段强制销毁、数据库已写但返回错误、恢复读取失败及在途关闭。聚焦 lint、fixture syntax、diff-check 均 exit 0，哈希对应最终源码。

本审查逐项读取了新增测试的存储提交时序，确认它们明确区分“注入在提交前”和“提交后接口失败”，没有从 reject 通用推断回滚；还实际断言了恢复读失败时配置写入口零新增、两个关闭按钮可用、完成能回父层，以及恢复读 pending 时仍 busy／force 后不写旧 DOM。

中间曾放宽 inactive targets 的通过结果不是本次闭合依据；最终依据是上述严格 80/80 和独立目标 `[2]`／`[1]` 的可观察行资格。独立审查没有重新跑这 80 项；它实际独立运行的是 5 条真工厂探针和原内存 SQLite 仓储探针。

## 5. 当前规则入口、结论和验证边界

当前业务基准为 Spec §4 / G3-AC-13 与 TechDoc §5.2 的已发写结算／前端生命周期边界。实际实现入口位于 `configuration.js` 的 `runWrite`（约 3978）、`applyBillSplit2WayExclusion`（约 4246）、`saveAmountConfiguration`（约 4576）与 `closeRows`（约 4691）；共享行为入口为 `scripts/renderer-lifecycle/fixtures/configuration-dialogs.js` 的 R3-01 状态型矩阵。主 Agent 负责现行 TechDoc/实施记录同步，本审查不另建业务真相规则。

**本限定范围内，R3-01 已闭合；未发现可证实的剩余配套写阶段／重试目标／busy 恢复缺陷。** 实现、专项验证、整产品集成分开记录：代码与定点自动证据已完成；真实产品 Main、真实持久化与模板库文件同步的端到端、完整 Task/日志、Windows、Excel/WPS、安装包和人工 GUI/财务核验未由本审查执行。内存 SQLite 证明的是仓储提交边界；Electron 工厂使用合成状态 API，不能把两层分别通过写成真实 Main 全链路已验收。

所有产品／共享测试修改均由主 Agent 和测试 Agent 完成。本审查只创建本目录的报告、探针及日志；没有修改原 R3 报告、历史证据、Main、后端或父 mapping 流程，没有提交、推送、合并或发布。报告与独立探针至此冻结。

