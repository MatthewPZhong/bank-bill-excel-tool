# 实施记录

## Baseline

- 用户已授权“修复”；任务范围与验收见 [spec.md](spec.md)。
- 起始提交 f75e76d1；工作区已有 release-gates.js、biz-op-v327-enablement.test.js 等其他任务改动，保留。

## Decisions

- 全局资源预算保持不变；给业务 OP Main 阶段统一增加“固定预算不可满足立即失败、暂时竞争最多 5 秒”的准入。
- 使用 governor 自身的队列超时和清理，不能超时遗留待执行请求，也不能提前释放已准入工作持有的 lease。
- 启动失败继续保留任务、输入 pin、发布回执；将内部可操作错误传至既有对话框。
- 按原合同修复退出 Promise，使用生产源码提取后的执行测试验证异步行为。

## Deviations

- 排查时发现同类直接租约还用于删除保全、升级预检和原始表导出读取；在实施前纳入 spec，避免换一条恢复入口仍无限等待。
- 应用补丁前发现并行任务已为 upgrade-main.js 增加首次及重启预检的 reject + timeoutMs:0；不覆盖该实现，只接入本轮其余入口，已同步 spec。
- 发布任务独立复核指出真实调用方没有向 governor 透传取消信号，新增 5 秒期限会把排队取消变成失败；补充 Publisher/RAW 入口取消与真实调用回归，先同步 spec。

## Evidence

- 前一轮只读诊断：零预算真实共享发布恢复函数持续排队，关闭 governor 后产生同一 AdmissionQueueError；退出函数在 VM 中复现多余调用。
- 原退出函数行为回归：修复前 0 PASS / 4 FAIL；修复后 4 PASS / 0 FAIL。覆盖存档实际排空、重复调用、runtime 关闭失败、后续清理失败和 updater token。
- 首批资源/退出/Controller/启动错误专项：62 PASS / 0 FAIL / 0 SKIP，日志 `/private/tmp/bizop-startup-focused.log`。
- 扩展 9 文件回归：156 PASS / 0 FAIL / 0 SKIP，日志 `/private/tmp/bizop-startup-regression.log`。包含 BizOP export-main、delete、upgrade、recovery，Main startup/updater，Archive UI contract 和通用 governor。该轮完成后补充的取消接线由下一项重新验证。
- 真实 Publisher 与 RAW 准入取消反例：接线前 0 PASS / 2 FAIL，均等待 5 秒后被报为资源超时；接线后资源持续占用时即返回 cancelled，目标文件不变，原件未被读取，队列无残留。
- 最终受影响文件组：`node --test --test-concurrency=2 tests/unit/main-process/biz-op-v327-startup-resource-recovery.test.js tests/unit/main-process/biz-op-v327-export-main.test.js tests/unit/main-process/biz-op-v327-phase-admission.test.js tests/unit/main-quit-lifecycle.test.js`，27 PASS / 0 FAIL / 0 SKIP，日志 `/private/tmp/bizop-startup-final-focused.log`。
- Electron 36.9.5 / 内置 Node 22.19.0：用 `ELECTRON_RUN_AS_NODE=1` 执行新增的 phase-admission、startup-resource-recovery、main-quit-lifecycle 三文件，14 PASS / 0 FAIL / 0 SKIP，日志 `/private/tmp/bizop-startup-final-electron.log`。使用临时目录的真实 SQLite / worker / publisher / archive，不连接用户数据库，不启动 Electron GUI。
- 最终 `npm run lint`、`git diff --check` 均通过。以上测试集合存在重叠，不相加为独立用例数。

## 盲区复核

- 已覆盖：零/不足预算、五维资源检查（CPU、Worker、Utility、I/O、内存）、已有队列、公平排队、超时移除后迟到容量、准入后超时不释放 lease、原始关闭和取消错误。
- 已覆盖：未发布导出保留同一记录和 pin，资源足够后原 Task 以失败终态收口；已发布导出保留提交证明并只完成归档和回执清理，最终原 Task succeeded，不重复发布。
- 已覆盖：取消只影响尚未准入的工作；已开始发布继续等待真实退出与结果核验。RAW 取消不制造来源、业务 intent 或发布记录，并保留 Task 的 cancelled 审计终态；沿既有恢复检查重新开放读取准入。
- 未改变金额、币种、匹配/记账、业务主键、清理授权范围或数据迁移；本次未发现要求人工资金口径复核的红线。

## Remaining Unknowns

- PROBE：用户真实 Electron 重启与目标 Windows GUI/打包运行未执行；真实数据不纳入自动测试。原机器内存仍不足时会明确拒绝启动，需释放内存后重启重新采样预算。
- 发布任务负责统一提交、完整 release-check/CI 及发布验收；本任务没有提交、切分支、合并或打标签。其同时修改的发布门禁、升级和产品文档不计入本轮修复成果。
