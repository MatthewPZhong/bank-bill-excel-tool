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
| 把 contract 的预计行数提取为共享纯函数，input limit 与 estimator 共用 | 准入必须与实际“账户 × 开户日至昨日 × 币种”记录数同口径，不能为资源再复制一份算法 | 让 caller 传 projectedRows；estimator 独立重算 | 冻结 DTO 不增字段；golden/property 对照实际 `records.length` |
| E10 resource profile 采用 `448 MiB + 4096 bytes × projectedOutputRows` | 448 MiB 显式拆为 256 MiB executor baseline + 64 MiB workbook + 64 MiB readback + 64 MiB safety；两个真实样本增量斜率约 3.36 KiB/行，4 KiB/行保留余量 | 继续静态 256 MiB；全部按 250,000 行预留；降低 MAX_RECORDS | 0 行最小 469,762,048 bytes，250,000 行最大 1,493,762,048 bytes；overflow/越界 fail closed，小任务不按最大值收费 |
| 复用 `resources.profile` Registry binding 在 Supervisor admission 前同步求动态 phase vector | 该 key 已是冻结静态引用；Supervisor 在 `adapter.start()` 前获取 PhaseLease | 新增 Protocol 字段；把 NewAccount 业务逻辑硬编码到 Supervisor；Worker 启动后再伸请 | runtime 只为 E10 注册 estimator，其他 action 继续静态 phase；不可能容纳的总预算在 Worker spawn 前拒绝，并发仍由 Governor 排队 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 日期继续采用 legacy 本地日历语义 | 冻结要求 golden 等价，legacy 使用 local `Date` | 改 UTC 会改变非上海时区/DST 边界 | 昨日/3650/3651 边界 golden；若产品另定时区则先改 spec |
| macOS 真实 RSS 只用于校准方向，不作为跨平台精确断言 | GC、SheetJS、Node/Electron 与采样时机会导致波动 | 若 Windows/packaged 增幅高于当前 envelope，低估风险重现 | 确定性 estimator 边界是自动门禁；R3.2.3 Windows RSS 人工门禁实测后只能向上调整余量 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 原 closeout 认为 shared Supervisor + fake crash/late-done 证据已覆盖 running Worker shutdown | 替代 Reviewer 补出真实 runtime 用例；同步 XLSX 阻塞 cancel message，实际为 `completed/job:done`、`generated != null`且 staging 残留 | 原证据只证明 Supervisor 迟到终态收口，没有证明真实 Worker 能在重型阶段观察 cancel | 补充模块 safepoint 与真实 cancel-wins 验收；冻结业务输出不变 | 是（同目录 preflight/checklist 已反向同步，frozen spec 合同未变） |
| 原计划由前一 Reviewer 完成复核 | 前一 Reviewer 两次被平台分类器拦截，后续改用替代 Reviewer；替代 Reviewer 确认本次 1 个 P2 | 评审执行路由受平台限制，不是代码或验收合同变化 | 评审流程存在偏差；P2 已用修复前失败回放和修复后真实 runtime 证据独立确认 | 不适用（无行为/spec 偏差） |
| 原 E10-A 静态 phase memory 固定 256 MiB | 替代 Reviewer 用真实 29,192/60,416 行 Worker 证明峰值分别约 468/572 MB，与 `MAX_RECORDS=250000` 的正常任务形状不匹配 | 保留静态值会让准入侵占 system reserve/OOM | 在 E10 范围增加共享投影与 dynamic profile，不改业务上限/输出 | 是（preflight/decisions/checklist 已反向同步，frozen Spec 业务合同未变） |

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
| dynamic resource estimator 确定性单测 | E10-A 12/12 PASS；最小/typical/29,192/60,416/250,000、safe integer/overflow、低 budget no-spawn、并发 system reserve、projected rows=actual records 全通过 | 准入口径、上下界、小任务不过度预留和并发不越预算 |
| resource-control/platform focused | policy/lease/budget/Governor/Supervisor/runtime/E10 133/133 PASS；E10 + adapters + Statement E09 A-D + Toolbox lifecycle 195/195 PASS | dynamic profile binding、spawn 前 admission、queue/cancel/shutdown、legacy 与其他 action 静态 phase 不回归 |
| NewAccount existing golden | `node scripts/integration/new-account-balance-statement.js` 36/36 PASS | 帐户/币种/日期/金额空值/文件名/工作簿等价 |
| 29,192 行真实 Worker RSS 探针 | actual 29,192；reservation 589,332,480 bytes；peak RSS delta 463,339,520 bytes；1297.21 ms；event-loop 207 ticks；leak/error=0 | 新 reservation 覆盖本机观测 envelope 125,992,960 bytes；方向性证据 |
| 60,416 行真实 Worker RSS 探针 | actual 60,416；reservation 717,225,984 bytes；peak RSS delta 569,638,912 bytes；2766.47 ms；event-loop 442 ticks；leak/error=0 | 新 reservation 覆盖本机观测 envelope 147,587,072 bytes；方向性证据 |
| dynamic estimator 追加 full unit | 6308/6312 PASS，1 failure、3 skipped；唯一 failure 仍为精确父链已确认的 shared `node_modules` Windows NSIS dependency template `System::Store` 基线 | 新增 4 个 estimator/admission 测试纳入全量 unit；无本次代码阻塞 |
| dynamic estimator 追加 full integration/smoke | 51 scripts、2455/2455 PASS，363834 ms；`npm run smoke` PASS；runner 自动 timing 文档变动已恢复 | NewAccount 36/36、Statement generation/recovery 与应用级路径均不回归，无范围外文档 churn |
| 最终 blindspot/reconciliation 复核 | 无新增代码阻塞；bounded DTO 在 estimator 前复验、共享投影与实际行数守恒、低预算 no-spawn、并发 lease 不越预算，cancel/crash/late message 的 Main-only staging cleanup 证据保持；金额空值/币种/账户/日期/文件名与 legacy golden 未改 | production 继续 `false/legacy/0`，不含 final target/copy/Publisher；资金字段与 Windows packaged/RSS 仍保留人工门禁 |
| `rules/important-variables.md` 软 review | 命中 Important-skeleton 的 Task/policy/Supervisor/Worker 跨层骨架与读写管线边界；新增 E10-only resource profile binding 和动态 PhaseLease，未改 `writeBalanceWorkbook`、`parseDateValue`、金额/币种/账户语义、Main/live source selector 或其他 action 的静态 resource | 133/133 resource focused、195/195 lifecycle、36/36 golden、2455/2455 full integration、smoke PASS 已覆盖关联功能；依任务禁令不运行 `check-vars/scan:vars/release-check` |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged Worker + assets allowlist 真实路径与动态内存 envelope | PROBE | R3.2.3 在 setup/portable 人工与 canary 验证 29k/60k/250k 代表形状 | production 必须继续 false；Windows RSS 超过 envelope 时只能向上调整余量 |
| NewAccount 日期/账户/币种/输出记录人工复核 | BLOCK（上线） | 财务/业务 owner 按 frozen checklist 复核 | 不阻断 E10-A dormant merge，阻断 production enable |
| app 进程级 crash 后持久 task-staging 扫描与 Publisher journal | PROBE | E10-B 绑定 task staging/Publisher，R3.2.3 做 restart recovery | E10-A 无发布路径且 production=false；阻断 production enable |
