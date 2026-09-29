# B3 顺序复用前提：模块锁释放归属补充方案（用户已确认）

## 证据与判定

基线 `11086a3c` 的 `src/main.js` 在 `runCheckWorkerPool.setFailureListener` 中无条件调用 `releaseAcquiringBillCurrencyOpLock()`。真实 pool 上可以复现：保留上一轮 idle worker → 下一轮 prepare 获得全模块锁 → idle worker 异常退出，`hadActiveJob=false` → 回调清掉当前 prepare 的锁 → 第二个 prepare 获锁。

该反例证明锁所有权前提不成立，不声称已经在真实 GUI 复现两个子 worker 同时写同一 part。G6 TechDoc §4.3 要求发现旁路后阻断切片验收并补明确修复设计，因此 B3 在处置前不能通过。原始设计仅明确列出 B0 修复，没有将 Main 锁协议修复列入代码范围。

## 已批准的最小修复

- `src/main.js` 的 pool failureListener 保留日志、通知和原有 partial 兜底；删除无所属任务身份的全局解锁。
- run/resume 的 `prepared.releaseLock()`（各 execute 的 finally）及 `onAbandon` 继续负责本次准备资源。现有 release closure 的幂等行为不变。
- 不改变 SQL、schema、业务错误/通知、取消、B0、C1、tempDir 格式或调用参数。不引入第二套任务引擎。
- 增加回归：idle worker crash 不解下一轮 prepare 的锁；active worker crash 仍经当前 execute finally 解锁；正常/取消/abandon 每次只释放所属锁一次。
- Main 改动核对 sourceHashes 和 action/策略语义。实施发现现有 `scripts/check-background-execution-manifest.js --write` 会把已发布 v3.2.5 快照从 54 个 action 改为当前 67 个 action，超出本次范围；已恢复本次生成的历史文件。改为在独立输出中运行同一生成器，对照修复前后当前政策产物，只允许 Main 的 sourceHash 差异；仓内历史快照保持原样，完整门禁继续使用其既有历史提交复验入口。该证据方式不改变生产设计，也不宣称直接历史快照 gate 对当前源码通过。
- G2 也调整 Main prepare 资源所有权，未来集成需同时保留其 prepared cleanup 与此处唯一释放者；不跨分支合并未固定的 G2 改动。

2026-09-20 用户在本任务回复“确认”，授权本文件所列最小修复及必要回归。Spec D8/AC-08 与 TechDoc §4.4 已引用本补充。实现、验证和集成状态以[实施记录](implementation-notes.md)为准，不从授权或下方旧方案实验推断已完成。

## 获批前补丁与临时验证（历史证据）

- [获批前准备的补丁](evidence/b3-proposed-lock-fix.diff)：只移除 failureListener 的无归属解锁并修正相邻说明，该证据文件保留获批前快照，当前生产状态见实施记录。
- [临时实验脚本](evidence/b3-proposed-lock-fix-probe.cjs)与[原始结果](evidence/b3-proposed-lock-fix-probe.txt)：在内存字符串应用精确 diff，装配原 Main 锁函数、prepare release closure 和 failureListener，调用真实 pool idle crash。当前源码复现错误释放；补丁方案保持原月锁/第二 prepare busy，owner release 后下一 prepare 获锁，旧 owner 重复 release 不清新锁，下一 prepare 的 onAbandon 正常释放。
- 实验前后生产 `src/main.js` SHA256 相同。该实验没有覆盖实际 IPC execute、active failure/取消及平台文件占用，不能把方案实验 PASS 标为 B3 已实现或验收通过；本轮新增正式回归另行记录。
