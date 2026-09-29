# RR01 拆分管理写入口独立核对

日期：2026-09-20。工作目录：`/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-renderer-boundaries`。来源：G3 第二轮审查 `review-2026-09-20-r2.md` RR01，当前 `src/renderer/dialogs/configuration.js` 的 `createBillSplitRowsDialog`、其金额规则子工厂及 `modal-host.js` 生命周期。

本项为独立只读源码审查，产品及测试由其他 Agent 修改。下列最初行号对应修复前读取的工厂（约 3914–4740）；以函数名和 API 名作为稳定定位。没有运行大测试，也没有把写入口枚举视为行为证明。实现冻结后的增量核对与实际测试证据另记在本文末尾。

## 1. 全部写入口

本工厂存在 7 种不同写 API，分布于以下 10 类业务入口。

| # | 入口与初始位置 | 写操作 | 必须共享的资格与兼容要点 |
| --- | --- | --- | --- |
| 1 | 行级「完成／编辑」约 4301 | `saveBillSplitRow({templateId, row:{...row,rowStatus}})` | 两方向都是真写，不能只保护完成；同步防重，保持 `completed ↔ draft`、原 `template.id` 与原行 `seqNo`。重绘后的旧行按钮不能写同序号的新行。 |
| 2 | 行删除，预检约 4322、写约 4333、确认约 4359 | `previewDeleteBillSplitRow` → `deleteBillSplitRow({templateId,seqNo})` | 无合并组直删、有组合确认两条都共用写资格。预检仅在原会话、原数据代次、原行仍有效时能续发写；提交中确认按钮、祖先关闭、导航及根替换均服从同步锁。 |
| 3 | 份数增减约 4429 | `saveBillSplitRowCount({templateId,nextN})` | 增加直接写、减少子确认写；1–99 整数校验和从最下方删除的提示保持。需要与删行／行保存等其他类型写互斥，而不是独立 `rowCountSaving`。 |
| 4 | 取消「合并账单」勾选约 4546 | `clearBillSplitMergeGroups({templateId})` | 明确是清所有组合，提交前取资格，成功后读当前配置；迟到读不能覆盖新写或已销毁视图。 |
| 5 | 合并选择器「完成」约 4567 | `saveBillSplitMergeGroup({templateId,seqNos})` | 至少两行；仍只允许 completed 且没有 mergedGroupSeq 的候选；冻结本次所选序号。与删行重排互斥，成功后重读再更新候选。 |
| 6 | `updateTargetSeqNos` 约 4121 | `saveBillSplitMeta` | 两个目标 checkbox 取消（4138/4156）、dialog mousedown 收起两种目标 panel（4726/4732）都触发写。原 fire-and-forget 不能绕过资格；父窗 inactive/closed 或其他写忙碌时不得开始。 |
| 7 | signedSelect change 约 4603/4616 | 必要时 `saveBillSplitAmountRules([])` → `saveBillSplitMeta(signed…)` | 一次已接受业务操作包含清对侧规则、保存 signed metadata 的链。配套链不能由新事件插入，局部成功/失败不伪造成全成功；强制销毁后已接受的配套写继续结算，旧 UI 不更新。 |
| 8 | byFieldSelect 选择「是」约 4645 | 必要时 `saveBillSplitMeta(signed:'',…)`，随后打开金额规则子窗 | 已发的清对侧写继续结算；若父 scope 在等待中结束，不能新开子窗。清除失败不能静默视为互斥已成立。 |
| 9 | byFieldSelect 清空约 4664 | `saveBillSplitAmountRules([])` → `updateTargetSeqNos('byField',[])` → `saveBillSplitMeta` | 两个配套写应是一份共享操作资格；不能在第一步 finally 解锁、第二步另起无归属写。提交前保留 metadata 来源。 |
| 10 | `openBillSplitAmountRulesSubDialog` 注入 saveRules，约 4687 | `saveBillSplitAmountRules({templateId,amountSplitRules})` | 子工厂已有本地 `writeScope`，父方闭包仍须验证原父、对应子 handle，并进入同一会话资格；不得落入主模板 `saveAmountSplitRules` 表。失败留子层，成功先关子再 `onDone` 更新原父。 |

7 种写 API：`saveBillSplitRow`、`deleteBillSplitRow`、`saveBillSplitRowCount`、`clearBillSplitMergeGroups`、`saveBillSplitMergeGroup`、`saveBillSplitMeta`、`saveBillSplitAmountRules`。

Currency/Credit/Debit 的行内 change 先改本地草稿，最终由 #1 保存；虽然它们本身不是 API 写，也要防忙碌、非当前行与已销毁旧节点事件改变提交中的草稿。底部「完成」与 × 是关闭／返回，不应新增整体 save。

## 2. 读资格、父子与销毁边界

- **删除预检**：原回包要同时满足会话存活、当前 top/预期父子关系、读请求代次、数据代次及原行身份。仅 `isOpen` 不够：另一行删除会重排序号；份数调整、行编辑或合并变更也可能改变预检所描述的配置。
- **预检失败**：原代码 catch 后将组视作空数组并直删，是需要覆盖的失败分支。异常／非 success／非法 dissolvedGroups 不能冒充“已知不影响组合”。应保留错误反馈及重新预检入口；这点已向实现 Agent 提出，待核对最终处理。
- **`refreshFromServer()`**：clear/save merge 后读取 `getBillSplitConfig`；旧读取不能采用到更新的数据代次或已销毁会话。已提交写与其必要事实重读应保持操作归属。
- **父层关闭回调**：行管理从 mapping 父层 push；其 `onClose` 调用方会 `getBillSplitConfig(template.id)` 再 `returnToModal(mappingOverlay)`（原约 3174）。行管理 ×／完成必须先有当前、非 busy 的关闭资格，不能在 busy 时先调用这个异步回调。成功返回保留原父节点和草稿。
- **规则子层**：`createAmountSplitRulesDialog` 的原保存顺序为子 writeScope → await saveRules → scope-current 检查 → 关闭本层 → onDone。父的 onDone 在子已关闭后检查父 top 是合法的，不能要求已结束的子仍 top 才更新父。
- **modal scope**：宿主先把整段栈标记 closing，再 abort scope、逆序 disposer、移除节点和 settle closed。最终 dispose 只释放前端资源，不等于取消 Main 写。
- **互斥结构**：同一会话所有写共用同步 begin/end。子确认处于 top 时允许对应父会话写资格；其他子窗、已重绘旧节点和隐藏父层的程序化事件必须拒绝。仅禁用按钮无法证明闭合。
- **已发与未发**：已发删除／保存保留真实结算；强制销毁后不渲染旧 DOM、不 push 告警、不 refresh/return/close 新窗。旧预检仅是只读结果，销毁后不能启动尚未发出的删除；清互斥配置后再打开子窗属于新 UI，必须停止。

## 3. templateId、seqNo 与合并删除的真实兼容依据

当前 Main `template:preview-delete-bill-split-row` 取 Number(payload.templateId/seqNo)，预演受影响组合为目标自身所属组合，加上任意成员序号大于等于被删序号的其他组合。错误返回 error result，不是成功的空组。

`src/backend/database/template-repository.js` 的 `deleteBillSplitRow`（约 733–783）在同一事务里解除这些组合、删除目标行，并将全部后续 `seq_no` 减 1。Main 随后返回 `currentRows` 与 `dissolvedGroups`。因此重复提交同一个 `{templateId,seqNo}` 可能作用于删除后递补到该序号的另一行；当前行对象／渲染代次验证有实际业务必要性。

修复应保持：payload 原模板和原序号；确认文案包含原组清单；成功以 Main 返回 currentRows 更新表和 nInput；不在 Renderer 重新实现组解散或重排序算法；合并行不可行级编辑/删除的 UI 限制保留。

## 4. 优先行为回归建议

1. 有组合确认连续普通点击／程序事件，只有 1 次 delete；同时父 close、确认 close、祖先 close、导航、根 replace 都 blocked。
2. 无组直接删除的预检在原窗关闭或替换后返回：0 次 delete，0 次新告警，新窗口仍 top。
3. 预检等待期间，另一行删除／份数保存／行编辑／合并写成功，使旧预检失效；旧 tr 节点重复 dispatch 不操作递补后的同 seqNo 行。
4. 跨类型互斥：行保存 vs 删除 vs 份数 vs metadata vs 合并；覆盖 mousedown 自动 metadata 与子规则 saveRules。
5. 删除明确失败／抛错后确认保持、取消不增加写入、再次确认可重试；预检失败不直删。
6. 强制销毁后的 delete／row save／row count／merge 等已提交结果只结算一次，不改变旧 DOM，不影响新窗口。
7. signed/byField 双写链：第一步已成功后 dispose，必要配套写结算；不打开迟到规则子窗。对侧清除失败不继续错误后续。
8. 规则子保存成功返回原父并更新规则；失败告警关闭返回子层且可重试；取消只关闭子层；父草稿和 onClose 无新增整体保存。

## 5. 首次冻结前的证据状态（历史阶段）

写入口清单与 Main/仓储语义已只读核对并同步主 Agent、modal_host。尚未对修复后代码给出结论；等待实现冻结后，仅复核本次差异和对应行为证据。以上源码枚举不代表全部行为验收已通过。

主 Agent 补充调用方核对：生产入口是 `createMappingDialog.openBillSplitRowsDialogFromMain` push 行管理子层；Renderer Dialogs 命名转发及 renderer-previews 既有入口保留。当时尚未调整外部调用签名；本轮 Main/数据库不变。后续为修复父子返回生命周期，`onClose` 新增可选资格上下文，见 §7。上述 Main preview/delete/currentRows/组合及序号压缩合同与本审查的局部读取一致；未为这项审查重复扩读无变化的 Main 模块。

## 6. 首次冻结后的增量复核（52 项工厂证据）

已读取 `after-fixtures.json`（真实 Electron configuration-dialogs 命令 exit 0）及实际 fixture；报告为 52/52 PASS。此结果由实现 Agent 运行，本独立审查没有重复执行。首次冻结的 configuration.js SHA-256 为 `7d99004e697a47811c5563310859adb3b4a5d2d5b27cfb95056efebe86c5c2c4`，fixture 为 `5f7b6218b7fc1d1e6e1429af161a7e5aef19dbe6203891ff3446bfb99dfd9773`。

源码已确认 7 种写 API 全部进入同一 `runWrite`，包括 metadata 隐式入口、两步互斥链和子规则 saveRules。子规则自身 writeScope 与父 activeWrite 同步生效，释放后子先关闭、onDone 再更新父，时序正确。删除预检由独立 epoch、每次写开始、父 dispose、tr 存活和 currentRows 原对象共同验证。`writeAndReadConfig` 把必要读 await 保持在锁内，最终当前句柄检查拦截销毁后的 UI 续接。配套写没有因前端 dispose 被截断。

新增需要处理的组合问题已同步主 Agent 和实现 Agent：`closeRows()` 从原来的“调用 onClose，由调用方 await getBillSplitConfig 后返回父层”，变成“先 closeModal 本层，再 onClose”。真实 mapping 调用方的旧 onClose 回包仍执行不限定具体子层的 `returnToModal(mappingOverlay)`。先关闭会让 mapping 立即可操作，用户可能在读取未结束时打开新 rows 子层，旧回包随后把新子层关闭。此处截至本段为源码时序证据，已请求真实父子工厂组合复现，不能将 52 PASS 视为该分支已验收。

此外，首次 52 项中的跨类型 metadata 用例覆盖目标 checkbox 清空，没有实际触发 `dialog mousedown` 收起选择面板的自动保存。该路径源码已经过 runWrite，但仍建议补实际 mousedown 的冻结参数、同步锁、强制销毁后旧事件零写入证据。待实现 Agent 补齐并再次冻结后继续复核。

## 7. 异步关闭／返回的最终组合核对

首次 52 项后的 close-first 顺序已经撤回。当前 `closeRows()` 在原 rows 仍 top 时同步置 `closing=true`，先使未提交删除预检失效，再禁止父窗控件与所有普通 host close。实际 `onClose` 返回过程中，mapping 的 `returnToModal(mappingOverlay)` 会因为原 rows 的 closing 门控而被拒绝；该回调 await 结束后 `closeRows` 释放 closing，再精确关闭捕获的原 rows handle，不使用 closeTop 接管后来窗口。

`onClose` 现在收到可选、冻结的 `{ isCurrent() }` 上下文。真实 mapping 回调在 `getBillSplitConfig` 返回后、写本地缓存前以及 `returnToModal` 前检查该资格。原 rows 被 force dispose 后，旧回调既不覆盖父缓存，也不关闭后来新子层。回调 reject 时只对仍当前的原 rows 显示失败，恢复控件并允许重试；旧代码忽略新增参数仍可正常返回。原工厂入参字段没有移除，Main/IPC/DB 参数及结果合同没有变更。

已读取实际 fixture 与 59 项运行记录 `final-validated.log/.json`：包含普通 close/submitted/owner/祖先/Escape reason/root replace 全部拒绝、实际父子返回、force 仅原子层后旧 callback、失败解锁重试、旧忽略参数 callback，以及真正的 mousedown metadata 保存。注意这里的 Escape reason 是测试直接请求 close 的理由；实际 rows descriptor 没有启用键盘 Escape dismiss，不应据此声称 UI Escape 已支持关闭。

## 8. 公共关闭后重开的独立真实工厂探针

为验证不经 ×／完成回调的关闭路径，独立探针使用真实 mapping、rows、modalHost、modalBridge 和真实 DOM；仅 API 使用合成配置替身。步骤：初始 2 行 → 通过实际份数 handler 保存为 3 行 → 调用原 rows handle.close() → 再点击实际 mapping 按钮。

| 快照 | 结果 | 当前合成配置行数 | 重开显示行数 | 配置重读 | 写次数 |
| --- | --- | --- | --- | --- | --- |
| 本轮修前保留快照 `751a1d3618d7bab925dcccf2dd8cd5e986ae192f2cd9d43899700230658e6bd9` | 预期断言失败；整组 1/2 PASS | 3 | 2 | 0 | 1 |
| 59 项候选 `5af8a1d4b69148ca08159f0871001ff73031179f99fa0b44be5c1770f980a07f` | 2/2 PASS | 3 | 3 | 2 | 1 |

证据：`before-mapping-close.log/.json` 与 `after-mapping-close.log/.json`；探针为 `mapping-close-probe-fixture.cjs`，启动 glue/launcher 为同目录 `mapping-close-probe.cjs`、`run-mapping-close-probe.cjs`。before 运行用 `AUDIT_SOURCE_ROOT` 指向保留的完整修前源码目录，没有修改被测快照。该缺口在本轮 RR01 修前已存在，是这次父子返回调用闭合时发现并一并修复的相邻路径，不应归因成 closeRows 新修复引入。

两组的另一项均记录：实际 keyboard Escape 不关闭 rows，原窗口仍显示 3 行。探针不把未启用的 dismiss 行为当作缺陷。数据是本地合成行，所谓“配置行数”来自受控 API 内存事实，不代表已连接真实 Main/SQLite 的落库验收。

## 9. 59 项候选新增异步入口的取消资格（已修复，最终证据见 §10）

对刚加入的 `openBillSplitRowsDialogFromMain()` 做定点只读复核，发现等待配置时 mapping 仍允许切换“是否拆分”，但回包只校验 `entryButton.disabled`，没有覆盖 `hidden` 或关闭后又开启的入口变化。独立同工厂探针已复现两条：点击打开后延迟 `getBillSplitConfig`，改为“否”；以及改为“否”再改回“是”。候选 SHA 为上述 `5af8a1d...`，两条都出现 `parentTop=false, rowsDialogs=1`，结果 0/2 PASS。

证据：`hidden-entry-before.log/.json`。原真工厂 probe 仅在 `AUDIT_OPEN_CANCEL=1` 时执行这两项；产品和共享测试没有由本审查者修改。已向主 Agent 和实现 Agent 同步。实现 Agent 已补入口变更推进 request 与隐藏资格，修后验证和冻结结论见下一节。本问题来自新增异步进入路径，范围没有扩到其他弹窗或账务算法。

## 10. 最终冻结核对与交付边界

最终源码 SHA-256：`4c34f8367ef140661ed0301c08ec5edcf4df222eb9185cdb8d844f4170a3933b`。最终 configuration-dialogs fixture SHA-256：`d827576e1b0f42941c2335f3a07bb2604e67e490aee6c8fb9efb36db687422b8`。本独立审查在运行后重新读取文件哈希，与最终执行记录一致。

最后一处生产差异仅限同一 `createMappingDialog`：提前声明 `billSplitRowsOpenRequest`，在 BILL_SPLIT_MERGE_FIELD 每次 change 时推进该代次，打开开始与读取回包均拒绝 hidden 入口。这能覆盖“否→是”仍然撤销旧打开意图的情况；再次点击才得到新的请求资格。未改变任何写 API、原模板／行序号载荷、Main 组合删除与序号压缩算法。

| 证据层 | 执行者／读取方式 | 结果及文件 |
| --- | --- | --- |
| 全部配置真工厂回归 | 实现 Agent 执行，本独立审查读取实际 fixture、日志和哈希 | `final-hidden-validated.log/.json`：61/61 PASS，exit 0。覆盖这轮 7 写 API 的共同资格和关键交错、父子关闭、配置重读及入口取消；不是所有可能组合的穷举。 |
| 取消旧打开意图独立真工厂探针 | 本审查独立执行 | `hidden-entry-before.log/.json` 0/2 → `hidden-entry-after.log/.json` 2/2 PASS；最终两条都是 `parentTop=true, rowsDialogs=0`，分别覆盖保持“否”和改回“是”。 |
| 公共关闭后重开独立对照 | 本审查独立执行 | §8 的 before 1/2 → 59 项候选 2/2；最终 61 项正式 fixture 继续包含同一真实 mapping→rows 重开与失败重试，最后增量没有改变该写入或缓存读取逻辑。 |
| 代码质量检查 | 实现 Agent 执行，本独立审查读取记录 | `verification.json`：聚焦 lint、两文件 syntax、diff-check 均 exit 0，最终快照与执行快照相符。没有将 untracked 源码的 git diff-check 作为源码语法／行为证明。 |
| 所有写入口闭合 | 本审查只读追踪 | §1 的 7 种 API／10 类入口共用 runWrite；关闭、预检、子规则、隐式 metadata 的资格已按 §2、§6、§7 逐项核对。源码清单与行为证据分开记录。 |

独立探针复跑命令（cwd 必须是本文顶部 worktree）：

```sh
# 修前公共 close 对照，读取保留快照，不改快照
AUDIT_SOURCE_ROOT=/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-renderer-boundaries/tmp/g3-review-r2-fixes/before node tmp/g3-review-r2-fixes/deletion/run-mapping-close-probe.cjs before-mapping-close
# 当前公共 close / 未启用 Escape dismiss
node tmp/g3-review-r2-fixes/deletion/run-mapping-close-probe.cjs after-mapping-close
# 当前入口取消与取消再启用
AUDIT_OPEN_CANCEL=1 node tmp/g3-review-r2-fixes/deletion/run-mapping-close-probe.cjs hidden-entry-after
```

本独立范围没有发现可证实的剩余 RR01 调用闭合缺陷。7 写 API 的模板/序号和合并删除语义保留，已提交写及必要配套链不因 force dispose 伪造取消；普通 close 忙碌拒绝、取消不提交，强制销毁只撤销旧 UI 续接。父子返回保持原父节点和草稿，新增 `onClose` 可选上下文与旧忽略参数调用方兼容。发现的公共 close 旧缓存和新增入口取消竞态均有实际真工厂修前/修后证据。

验证与集成仍需明确区分：本审查没有修改产品或共享测试，没有跑全套门禁，也没有再次启动真实产品 Main。探针使用隐藏 Electron 窗口、真实工厂/DOM/host/bridge 和合成受控 API，并隔离 userData/Documents；这些结果不能单独证明真实 Main/SQLite 持久化、Windows、Excel/WPS、安装包或人工 GUI 验收已通过。主 Agent 的最终受影响测试／集成结果应另行引用。本审查产物及所创建 probe 已冻结，没有提交、推送、合并或发布。
