# 第二轮 R1 修复与最终组合验证

2026-09-06。用户在第二轮 review(8).md 核验后授权修复，沿用本地提交后直接更新远端 PR 的授权。原 E5 工程包及 E01—E03 不变；本次限定扩展已同步到仓库 PR1b spec，不生成 E6，不修改业务数据或生产开关。

## 最终改动与传播

- PR231：真实终态 Task 保持原业务结果。检查器暂时失败时落观察和恢复保护，anchor 未完成时由共享 exact 校验确认同 Task/operation、合法终态及无恢复标记，然后原子重放必要 Hold。保留原 schema、注册接口、E5 调度和 committed-only Provider。
- PR231：修复 ServiceHost 已接收合法 close-ack、同轮正常 exit 被误判崩溃的窗口。非零退出、信号退出或缺 ACK 仍拒绝；原关闭流程继续等待载体和释放资源。
- PR232：真实 XLSX 失败/取消后的 12 个恢复组合；PR234：真实成功导出待 ACK 的 6 个恢复组合。覆盖有无既存 Hold、同进程故障恢复、anchor 后真实进程退出和写入后未 COMMIT 的真实进程退出。每组再由独立进程重新打开磁盘库，并检查重复恢复。
- PR235 合并测试宿主时保留 beforeBootstrap 钩子和原 expectReady 参数。PR236 继续保留自身 moduleOptions、dbFileName 及升级宿主能力，后续验证覆盖该组合。
- 通过普通 merge 逐层传播，未强制推送、未合并 main、未改变 Draft 状态。PR230 保持 98976f6e。

最终生产源码相对上一轮 25f787da 仅涉及 3 个文件、21 行新增/3 行删除：BizOP recovery-plan、共享 StartupRecoveryCoordinator 和 ServiceHost。

## 本轮证据

| 范围 | 实际结果 | 说明 |
| --- | --- | --- |
| C2 / RecoveryControl / JPM E11-B | 148 PASS / 0 FAIL | 真实持久 Task 与 SQLite；含新增 12 个终态/Hold/中断窗口和 7 个拒绝反例 |
| 最终 C2 + BizOP 恢复 | 96 PASS / 0 FAIL | 含真实候选失败、原 prepared/running 崩溃恢复、unavailable 后原 Task/receipt 冲突仍阻断 |
| ServiceHost / 关闭观察 / Duplicate paired parser | 88 PASS / 0 FAIL | 含原 CI 失败的 persist/shutdown/回滚用例及 ACK/exit 时序反例 |
| PR2 导入 Main 与新增恢复 | 20 PASS / 0 FAIL | 12 个新恢复组合及 8 个原 Main 测试；补显式同 Task Hold 断言后 12 项再次通过 |
| PR4 导出 Main 与新增恢复 | 19 PASS / 0 FAIL | 6 个新恢复组合及 13 个原 Main 测试 |
| PR5 合并宿主、IPC/删除与终态恢复 | 36 PASS / 0 FAIL | 保留两边测试宿主能力后执行 |
| PR6 Electron 最终组合 | 48 PASS / 0 FAIL / 0 SKIP | 18 个真实终态恢复组合及原升级 30 项；Electron 36.9.5 / Node 22.19，13.95 秒 |
| 完整 release-check | PASS，退出码 0 | lint / smoke PASS；单元 7172 PASS / 3 既有 SKIP / 0 FAIL（7175 项、458 文件）；53/53 集成脚本、2488/2488 |
| 大文件内存门禁 | 31/31 PASS | 原 toolbox-large-split-multi-sheet 脚本、50 万/150 万行及原阈值，253627 ms；读取器、采样与预算未修改 |

完整检查宿主为 macOS arm64 / Node 25.8.0，代码及测试基线为 9e25a2af1e5c799c3faeb84e64068536fbc7e3e1；单元 237544 ms、集成 460464 ms。该基线后的 PR6 提交只更新四份验证文档，不改变被测源码或测试。集成 runner 自动刷新的策略表只涉及时间戳和耗时，核对内容后还原该噪声改动，完整输出仍保存在日志。

上述专项存在重叠，不相加宣称独立验收总数。Inspector 回调内只采集事实，断言在恢复返回后执行；共享测试另断言 Inspector 正常返回的观察，避免断言异常被平台当成临时故障重试而形成假通过。

真实终态回归验证原 Task/错误、目录及 publication receipt、版本计数器、当前输入 head、源文件和目标文件 SHA-256 均保持；收敛后没有 prepared anchor 或未决来源，原读取 pin 完成，ACK/cleanup_completed 按实际提交事实收尾。

## 失败记录及检查边界

- 修改前的终态复现见 outputs/pr230-236-second-review-20260906：三个真实流程在依赖恢复与新进程重启后仍报同错误、Inspector 调用零次。该记录不是 PASS。
- 新增 C2 测试宿主初版缺 parentRunId，在进入恢复前失败；补齐既有创建合同后通过，没有放宽生产 Task 创建规则。
- ServiceHost 的合法 ACK 后同步 exit(0) 在修复前确定性失败，非零/信号退出拒绝对照通过。修复后全组通过，与原 CI 症状对应；原 CI 日志本身不包含逐事件跟踪，未冒称已从该日志证明完整时序。
- PR233 旧 Windows 内存门禁失败：五组配对样本预算差值中位数 +1 MB。源码跟踪到工具箱 style-aware 流式扫描和有界字段累加器；该结果尚不足以定位具体生产内存缺陷。本轮没有修改读取器、采样规则、预算、取整容差或门槛，最终 macOS 完整检查按原条件 31/31 PASS；本地通过不证明旧 Windows 波动的根因已经定位或修复。
- check-vars 对本轮生产 diff 仅词法命中 record.state；清单所定义的 renderer.js 顶层 state 未修改。其模板/模块/导出联动不受该局部字段改变。对共享状态与恢复风险执行了上表合同回归。
- 未发现本轮改变金额、币种、账号、业务唯一键或历史回填的资金红线；Task/receipt 冲突保持可见阻断。Windows 目录耐久、目标规模、Excel/WPS 与真实资金人工验收继续保留，自动检查不替代这些门禁。

## 证据位置

- PR6 outputs/terminal-recovery-fix-20260906/：最终 Electron、release-check 及汇总；各 PR 同名 outputs 目录保存本轮专项日志。
- tests/helpers/biz-op-v327-terminal-recovery.js 与 tests/fixtures/biz-op-v327-terminal-recovery.cjs：可复跑的真实进程故障链；PR2/PR4 分别注册实际已具备的业务流程。
- changes/v3.2.7/pr1b/terminal-recovery-remediation.md：共享合同、最小扩展与独立关闭修复的依据。

所有业务夹具、故障触发器和数据库均位于临时目录；脚本结束清理自身生成的临时材料。原用户文档、用户数据库和真实报表未修改。
