# E10-A Implementation Notes

## Baseline

- Goal/spec：frozen v3.2.3 spec/techdoc §9、§10、§11 的 E10-A NewAccount generation core/Worker。
- Initial plan：见同目录 `preflight.md`。
- Done when：唯一 core、bounded contract、allowlisted template、one-shot Worker、业务回读与 Main technical validation完成；production/legacy/workerCount 保持 `false/legacy/0`。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| live legacy handler 与 Worker 共用业务 pure core，E10-A 不切 live | E10-B Publisher 尚未实现且 frozen release strategy 要独立 flag | E10-A 直接替换 live handler | 用户行为零切换，允许完整 golden 后再启用 |
| 模板 identity 使用固定 allowlist path + stat snapshot + SHA-256，Worker 前后双检 | 只校验 caller path 或 metadata 存在 TOCTOU/同 metadata 内容替换盲区 | 信任 Worker input path；只用 `existsSync` | 模板变化一律 fail closed |
| 复用 Statement staging ownership validator | 已覆盖 root/ancestor symlink、realpath、hardlink、alias | 新写一套弱化路径判断 | technical validation 与 cleanup 权限一致 |
| Worker result 不回传 generationPath，Main 以自己冻结的 input 绑定 staging | Worker 自报路径不能授予校验/删除权限，且结果不应泄露本地路径 | manifest 回传 generationPath 并驱动 cleanup | Main 只按已授权 staging path 校验 size/hash；Worker 无 final target |
| Worker contract 上限为 256 KiB、64 账户、每账户 64 币种、250,000 预计记录 | 64×64×近 10 年会放大到千万级行；bounded DTO 不能只限制 JSON 字节 | 沿用 legacy 无界 Worker input | dormant Worker fail closed；live legacy 不新增记录上限 |
| E10-A 在 `before-write/after-write/after-readback/before-terminal` 显式让出 Worker 消息循环，并在 entry 发 `job:done` 前再过一次 cancel gate | 同步 XLSX 读写期间仅读 `signal.aborted` 无效，因为 `job:cancel` 尚无法被 Worker message handler 处理；真实 runtime 修复前返回 `completed` | 修改全局 Supervisor 对 cancel 后 `job:done` 的通用语义；在 Worker/core 删 staging | 已接受 shutdown cancel 的 running job 以 cancellation error 收口；唯一 Main/client cleanup owner 删除 task-private generation，artifact handle 为 null |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 日期继续采用 legacy 本地日历语义 | 冻结要求 golden 等价，legacy 使用 local `Date` | 改 UTC 会改变非上海时区/DST 边界 | 昨日/3650/3651 边界 golden；若产品另定时区则先改 spec |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 原 closeout 认为 shared Supervisor + fake crash/late-done 证据已覆盖 running Worker shutdown | 替代 Reviewer 补出真实 runtime 用例；同步 XLSX 阻塞 cancel message，实际为 `completed/job:done`、`generated != null`且 staging 残留 | 原证据只证明 Supervisor 迟到终态收口，没有证明真实 Worker 能在重型阶段观察 cancel | 补充模块 safepoint 与真实 cancel-wins 验收；冻结业务输出不变 | 是（同目录 preflight/checklist 已反向同步，frozen spec 合同未变） |
| 原计划由前一 Reviewer 完成复核 | 前一 Reviewer 两次被平台分类器拦截，后续改用替代 Reviewer；替代 Reviewer 确认本次 1 个 P2 | 评审执行路由受平台限制，不是代码或验收合同变化 | 评审流程存在偏差；P2 已用修复前失败回放和修复后真实 runtime 证据独立确认 | 不适用（无行为/spec 偏差） |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 父链 | `7beb80e8151c77dbd659d4192178b07663674009` | 精确 restack 基线 |
| frozen spec/techdoc/sequence 取证 | E10-A/E10-B/R3.2.3 边界确认 | 防止范围扩张 |
| `node --test tests/unit/main-process/new-account-generation-e10-a.test.js` | 7/7 PASS | 日期/10年边界、必填、币种顺序、文件名、bounded DTO、allowlist/TOCTOU、staging alias/collision/symlink、真实 Worker golden、tamper、cancel/crash/late done、cleanup |
| focused platform/legacy set | 41/41 PASS | E10-A + Statement deferred legacy + shared runtime/toolbox lifecycle |
| `node scripts/integration/new-account-balance-statement.js` | 36/36 PASS | 既有 NewAccount/余额 writer readback golden |
| `npm run test:integration` | 51 scripts、2455/2455 PASS，291844 ms | 全平台 recovery/integration 与 NewAccount 36/36；自动 timing 文档改动已恢复，未引入范围外 churn |
| `npm run smoke` | PASS；含全部列示模块 smoke | 应用级回归 |
| `npm run test:unit` | 6302/6306 PASS；1 个 failure、3 skipped | 唯一失败为未改动 Windows NSIS dependency template `System::Store`；在精确父 worktree 同测试同样失败，确认为 baseline |
| `npm run lint -- --no-cache`、`node --check`、`git diff --check` | PASS | 静态语法/风格/补丁完整性 |
| 10 轮真实 Worker 性能探针 | 10×1815 rows，2481.58 ms；Main event loop 995 ticks；RSS max delta 193,806,336 bytes；transport leak=0、shutdown error=0 | 非阻塞、RSS 与连续 one-shot lifecycle |
| Reviewer P2 修复前真实 runtime 回放 | 等 `control.ready` 且 `runtime.inspect(jobId).state=running` 后立即 shutdown；失败为 actual `completed` vs expected `cancelled` | 确认是真实 Worker 消息循环被同步 XLSX 阻塞，而非 fake adapter 或 Reviewer 推断 |
| Reviewer P2 修复后 focused real-runtime regression | running 后shutdown 返回 `cancelled/job:error`，`execution.result=null`、`generated=null`、staging=0、final=0；已真实 completed 的 job 再 shutdown 仍保留 workbook 且 `cancelledJobs=[]` | cancel-wins、late `job:done` 不胜出、Main-only cleanup owner，以及 completed-before-shutdown 的正常终态保护 |
| P2 追加 focused/lifecycle | E10-A 8/8 PASS；running-shutdown 用例连续 10/10 轮 PASS；E10-A + Supervisor + adapters + Statement legacy + Toolbox lifecycle 123/123 PASS | 真实 Worker cancel 竞争稳定性、共享协议/终态不回归、legacy 旁路不变 |
| P2 追加 NewAccount/full integration | NewAccount 36/36 PASS；51 scripts、2455/2455 PASS，389282 ms；runner 自动 timing 文档变动已恢复 | 既有 NewAccount golden、Statement/publish/recovery 与全平台集成不回归 |
| P2 追加 full unit/smoke/static | unit 6304/6308 PASS，唯一 failure 仍为精确父链已确认的 shared `node_modules` NSIS `System::Store` 基线，3 skipped；smoke PASS；lint/node-check/diff-check PASS | 新用例纳入全量回归；无本次代码阻塞 |
| P2 追加 10 轮真实 Worker 性能探针 | 10×1815 rows，2537.30 ms；Main event loop 1016 ticks；RSS max delta 152,338,432 bytes；transport leak=0、shutdown error=0 | 新增 safepoint 后连续 one-shot 吞吐/RSS/event-loop/shutdown 保持在原证据范围 |
| `rules/important-variables.md` 软 review | 命中 Important-skeleton 的 Task/policy 跨层骨架与读写管线边界；只改 E10-A policy `safePoints` 声明和 Worker 调度，未改 `writeBalanceWorkbook`、`parseDateValue`、金额/币种/账户语义或 Main/live source selector | 123/123 lifecycle、36/36 golden、2455/2455 integration 和 smoke 已覆盖关联功能；依任务禁令未运行 `check-vars/scan:vars/release-check` |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged Worker + assets allowlist 真实路径 | PROBE | R3.2.3 在 setup/portable 人工与 canary 验证 | production 必须继续 false |
| NewAccount 日期/账户/币种/输出记录人工复核 | BLOCK（上线） | 财务/业务 owner 按 frozen checklist 复核 | 不阻断 E10-A dormant merge，阻断 production enable |
| app 进程级 crash 后持久 task-staging 扫描与 Publisher journal | PROBE | E10-B 绑定 task staging/Publisher，R3.2.3 做 restart recovery | E10-A 无发布路径且 production=false；阻断 production enable |
