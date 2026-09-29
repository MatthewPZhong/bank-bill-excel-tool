# RR01 拆分管理写入边界修复

2026-09-20。工作目录固定为 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/v3210-renderer-boundaries`；分支 `codex/v3.2.10-renderer-boundaries`，起始 HEAD `11086a3c`，所有改动尚未提交。

实现完成，最终对应真实工厂回归 **61/61 PASS**，生产源码与 fixture 已冻结；独立最终审查已完成，末次入口失效探针 **2/2 PASS**。总体集成由主 Agent 汇总。本文件只记录 RR01 的本轮证据，不修改用户第二轮报告或前轮证据。

## 职责与边界

依据 [第二轮复审 RR01](../../../changes/v3.2.10/codex/v3.2.10-renderer-boundaries/review-2026-09-20-r2.md)、G3 Spec 的 G3-AC-03 / 14 与既有 Main 删除合同。生产改动仅在 `src/renderer/dialogs/configuration.js` 的 `createBillSplitRowsDialog`，以及实际 `createMappingDialog` 调用方与行管理有关的打开、返回和父写代次屏障；回归仅增补 `scripts/renderer-lifecycle/fixtures/configuration-dialogs.js`。未更改 Main、IPC、仓储、其他工厂业务、共享 runner、总索引或设计正文。

同一父会话由 `runWrite` 维护单一同步写资格；确认/发生额规则子层从自己的原句柄进入同一资格。宿主仍唯一管理栈和关闭。删除预检使用独立 `deletePreviewEpoch`；新预检、任意写开始和父 scope 销毁均让旧预检失效，行节点还须连接到原视图且仍属于当前行对象。预检本身允许普通关闭，尚未发出的删除不会因旧预检晚到而启动。

## 调用方与兼容

保留 `createBillSplitRowsDialog` 的入参，`onClose` 回调新增可选的只读资格上下文 `{isCurrent()}`；旧忽略参数的回调兼容，实际映射父层已接入此资格。模板 ID 在工厂创建时捕获，删除请求固定为原 `{templateId,seqNo}`；有效预检的 `dissolvedGroups` 仍用于合并组确认，合法空组合仍直接删除。成功采用 Main 返回的 `currentRows` 并更新份数，不在 Renderer 仿造序号重排或解散组。

份数保存仍校验 1–99，减少时确认尾部删除、增加时直接保存。单行 completed/draft、合并组、元信息、正负号与按字段规则的互斥写顺序保持；链式操作在开始时捕获全部配套参数，force dispose 不取消已经发送的写或其已确定配套写。取消及底部完成只作用于原 handle；调用外部 `onClose` 前必须通过 idle/top 资格。返回读取期间 `closing` 同步拒绝全部普通关闭、根替换及其他写，父层继续 inert。回调结束后解除该资格，再精确关闭原子层；回调 reject 会解除锁、留原层显示错误并可重试。force dispose 后的回调先检验原子层，不能更新父缓存或关闭后来新层。

## 业务行为与写入口覆盖

| 本厂入口 | Main 写 API | 资格及覆盖 |
| --- | --- | --- |
| 行完成/编辑 | `saveBillSplitRow` | 原行对象/节点校验，原 seqNo/字段快照；共享写锁 |
| 有组确认/无组直删 | `deleteBillSplitRow` | 预检 epoch + liveness，父子共同 busy，单次提交 |
| 份数增加/减少确认 | `saveBillSplitRowCount` | 同一父子写锁，既有 4 条份数行为继续通过 |
| 取消合并/完成合并 | `clearBillSplitMergeGroups` / `saveBillSplitMergeGroup` | 共享锁，成功后的配置读取只在原视图仍有效时启动，返回也受原句柄限制 |
| 两种指定账单 checkbox / 收起选择面板 | `saveBillSplitMeta` | 同一 `updateTargetSeqNos` → `runWrite`；禁止 fire-and-forget 写 |
| 正负号选择 | `saveBillSplitAmountRules` → `saveBillSplitMeta` | 提交快照，清空对侧成功后继续配套元信息，销毁不截断已确定业务链 |
| 按字段启用/清空 | `saveBillSplitMeta` 或 `saveBillSplitAmountRules` → `saveBillSplitMeta` | 共享锁；销毁后保留配套写，禁止新开规则子窗 |
| 发生额规则子层保存 | `saveBillSplitAmountRules` | 父共享资格与原子层已有 write scope 组合；成功回原父、失败留原子层 |

共 7 种写 API、10 类入口，无新增 Main 方法。实际映射父层每次打开行管理先调用既有 `getBillSplitConfig`，只在原父 handle/top、入口仍显示且可操作、打开请求代次和父写 epoch 全部仍有效时接纳；读取失败不以旧缓存继续。父 `writeScope.begin` 仅在本工厂局部包装以推进 `mappingWriteEpoch`，保证父写开始且已结束后旧读也不能挂子层，不改变公共 write scope 或其他使用者。入口下拉框的每次 change 都推进打开请求代次，确保“是→否”或“是→否→是”都撤销旧打开意图，重新启用后须重新点击。预检失败/reject 的旧行为会把未知组合当成无组，本次**有意修复为明确失败反馈、0 delete、可重试**；这是必要确认不能被跳过的边界修复。所有写入在途时，父/子关闭、根替换和 owner 导航关闭受同步锁控制；重复/跨类型写不新增 IPC。失败恢复原操作层供用户重试；force dispose 后已提交结果照常完成，旧 DOM、旧告警、关闭/打开新窗口等 UI 续接均停止。

## 验证证据

- 原用户删行探针本次修前再次确认 **2/2 缺陷**，exit 0；这表示反例成立，不表示产品 PASS。[原探针本次日志](before-probe.log) / [命令与源码哈希](before-probe.json)。原用户探针及其历史输出未改。
- 同一新增配置工厂回归修前 **33/52 PASS**，exit 1：原有 28 条全通过，新增 24 条中 19 条暴露边界缺口。[修前日志](before-fixtures.log) / [命令记录](before-fixtures.json)。
- 首次修后 **52/52 PASS**，exit 0，现作为中间阶段证据保留。[首次修后日志](after-fixtures.log) / [命令记录](after-fixtures.json)。使用正式配置工厂、modalHost/modalBridge、真实 Electron DOM 和受控 Promise/API，覆盖有组/无组、close/replace 后晚到、预检逆序、其他写后旧预检、预检失败、删除失败重试、force dispose 三结果、旧行节点、跨类型写锁、子规则、已提交互斥链。
- 打开/返回补充阶段 **59/59 PASS**，exit 0，作为中间证据保留。[阶段日志](final-validated.log) / [命令、退出码、执行快照](final-validated.json)。该组证明真实 mapping→rows 返回、全部普通关闭拒绝、force 子层 dispose、回调错误重试、实际 mousedown meta 写、公共关闭后重读、读取失败/乱序/父层结束及跨父写 epoch。
- 末次独立审查确认“打开读取期间关闭入口”和“关闭后再启用”仍会被旧回包打开；正式工厂修前 **59/61 PASS**，新增两条均失败，exit 1。[入口竞态修前日志](before-hidden-fixtures.log) / [对应快照](before-hidden-fixtures.json)。修前生产快照另存为 [before-hidden-configuration.js](before-hidden-configuration.js)，不覆盖原始 RR01 修前材料。
- 最终 **61/61 PASS**，exit 0：原 28 条与本轮新增 33 条全部通过。[最终日志](final-hidden-validated.log) / [命令、退出码、执行快照](final-hidden-validated.json)。末两条证明入口被取消或取消再启用后旧读均不复活，重新点击可正常读取并打开。
- 独立增量审查识别的本轮提前 close 竞态先实际复现为 **53/55 PASS**、两个父子返回用例失败，见 [返回竞态复现](close-return-before.log)。后续 **55/56** 运行只有 fixture 把 handle 当 IPC 返回值造成不可克隆错误；已加 `void 0` 修正，随后 59 条通过，末次 61 条也继续通过。该中间日志保留在 [final-fixtures.log](final-fixtures.log)，不称作最终验证。公共 close 后旧缓存的独立探针由审查 Agent 单独保存，最终快照已报告 persistedRows=3/reopenedRows=3/configReads=2/writes=1。
- 独立审查的入口取消 / 取消再启用探针修前 **0/2 PASS**、修后 **2/2 PASS**，修后两分支均 `parentTop=true`、`rowsDialogs=0`。[独立修前](hidden-entry-before.json) / [独立修后](hidden-entry-after.json)。独立审查已冻结，未发现本项范围内剩余可证实缺陷；详见 [审查文档 §10](write-entry-audit.md)。
- 聚焦 ESLint、语法检查、`git diff --check` 均 exit 0；[检查命令和源码身份](verification.json)。修前两文件 SHA 均匹配主 Agent 的 `before-manifest.json`。所有本轮 shell 命令都明确使用上述功能 worktree 为 cwd。
- [代码与测试差异](changes.patch)以主 Agent 的本轮 `before` 快照为输入；[独立写入口清单](write-entry-audit.md)由审查 Agent 维护。

专项命令为 `node tmp/g3-review-r2-fixes/deletion/run.cjs before-probe probe`、`node tmp/g3-review-r2-fixes/deletion/run.cjs before-fixtures`、`node tmp/g3-review-r2-fixes/deletion/run.cjs after-fixtures`；最终命令为 `node tmp/g3-review-r2-fixes/deletion/run.cjs final-hidden-validated`（另保留 `close-return-before`、`final-fixtures`、`final-validated` 与 `before-hidden-fixtures` 阶段）。包装器完整记录底层命令；Electron 的 userData/Documents 均为新建隔离临时目录，结束只清理本次目录。没有权限拒绝，没有真实模板删除或用户财务文件写入。

## 当前规则入口与剩余边界

当前规则入口仍为项目 AGENTS.md → Renderer README，以及 G3 Spec 的 AC03/14；本轮不改这些共享入口。已验证本厂写资格和 UI 生命周期，未声称全仓弹窗均通过。记录型 API 不替代 Main 仓储的真实序号重排、数据库事务、产品 Main 启动、Windows/Excel/WPS 或安装包验收；这些规则以现有 Main/仓储合同保持。

本轮未运行完整 `release-check` 或全仓 unit；历史资源审批限制没有因本项专项通过而解除。未提交、推送、合并、开 PR、升版或发布。当前生产与 fixture 冻结；主 Agent 总体整合不在本项局部 PASS 范围。独立审查最终结论由 [写入口审查文档](write-entry-audit.md)负责，本项不修改该 Agent 的证据。
