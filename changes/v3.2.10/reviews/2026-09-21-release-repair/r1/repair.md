# R1 退款／C3 确认流程修复

结论：R1 原缺陷已复现并修复；聚焦单测及真实 Electron DOM 组合回归通过。本记录不替代 G8 修复后的最终 release-check，也不代表真实产品 Main、Windows 或财务输出人工验收。

## 改动与契约

- `src/renderer/controllers/bank-statement.js`：每个确认框捕获 `openRoot()` 返回的实际 handle。确认／直接运行仅在页面代次仍有效、该 handle 仍打开且位于栈顶，并以 `{ status: 'submitted' }` 成功关闭后继续业务。
- 删除业务回调中按 owner 关闭全部弹窗的 `completed` 调用；`canClose` 拒绝、旧句柄失效、导航后的旧回调均不启动业务。取消仍交给真实确认框工厂以 `{ status: 'cancelled', reason: 'cancel' }` 结束。
- 导入后的退款/C3 提醒复用同一提交逻辑。Gateway picker 原来调用相同非法 helper，亦改为自己的实际 handle，保留所选场景 ID。
- 不修改金额/候选计算、退款→C3→运行顺序、业务 IPC、Main 或 modalHost outcome 合同。

## 回归覆盖

1. `scripts/renderer-lifecycle/fixtures/bank-statement-confirmation.js` 新增 **27 项实际 Electron 点击回归**：退款/C3 四按钮分别覆盖正常提交、busy/canClose 拒绝后重试、同页面替换旧句柄、重复点击、导航晚到；另覆盖两类取消、两类导入后提醒、退款→C3 顺序、gateway picker 忙碌及旧句柄。使用真实 controller、confirm/picker 工厂、bridge/host；API 为受控 fixture。既有 renderer-lifecycle 集成会自动发现该 fixture。
2. `tests/unit/renderer/scenario-change-routing.test.js` 将旧无条件成功宿主替身换成真实 modalHost，原编排和状态回归 **31/31 PASS**。
3. `tests/unit/renderer-refund-prompt-orchestration.test.js` 把旧的 `closeModal(); return ...` 字符串断言改为真实 controller/host 的导入后提醒回归，核对拒绝关闭不导入、submitted 后导入、不自动续跑、不重复导入；与 ready guard、controller feedback 合计 **94/94 PASS**。

## 证据

- [修复前复现](before-probe.json)：退款/C3 四路径均 `MODAL_OUTCOME_INVALID`、业务调用为 0；额外 gateway picker 同因。
- [Electron 27/27](renderer-confirmation-unsandboxed.log)：受控业务 API 调用时原确认框均已关闭，真实宿主无 outcome 错误。
- [编排单测 31/31](scenario-change-routing.log)、[退款/反馈 94/94](refund-feedback-tests-fixed.log)。
- [命令、退出码及 SHA-256](verification.json)。原始中间失败保留：沙箱内 Electron 启动 SIGABRT；受批准的隔离沙箱外执行通过。旧字符串测试失败记录亦保留，未把该失败记成 PASS。

没有提交、推送、改写原审查证据或运行全量 release-check。最终组合门禁由主任务执行。
