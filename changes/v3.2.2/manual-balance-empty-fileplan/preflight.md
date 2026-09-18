# Manual balance empty FilePlan preflight

## Task Brief

- Goal: 修复网银账单内存会话补录上一账单日余额时，点击“完成”无响应的问题；日期早于当前账单日且余额为 `0` 时应正常保存并继续生成。
- Context: `file:save-balance-seed` 是 eager File Task；文件名映射与 `preparedDetailRows` 路径以内存数据继续生成，不会在补录时重读源文件。
- Constraints: 不改变余额种子主键、金额精度、日期先后规则、覆盖确认和账单生成算法；保持 File Task 非空 manifest 合同；不把资金写入降级为 no-file；不改用户附件。
- Done when: 内存会话能登记原账单源文件并进入 lifecycle；余额 `0` 原样写盘；IPC rejection 与 lifecycle 失败均有可见反馈；首次提交与覆盖确认不会重复提交。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 现场点击产生 `eager filePlan 必须至少包含一个文件`，异常发生于 `renderer-dialogs.js` 的提交 Promise | Electron DevTools console；`src/main-process/archive-center/file-plan.js` | 不能把日期或 `0` 误判为根因，必须修 FilePlan 输入来源 |
| `createManualBalanceSeedFreshnessGuard` 对内存会话返回空 `inputFilePaths` | `src/main.js#createManualBalanceSeedFreshnessGuard` | freshness 依赖与归档来源不能继续复用同一个空数组 |
| `file:save-balance-seed` 明确登记为 `eager('statement-session-inputs')` | `src/main-process/archive-center/task-file-plan-registry.js` | 应沿用账单会话源文件，不应改成 no-file 或伪造文件 |
| `importContext.inputFilePaths` 与 statement session 保留本次导入文件路径 | `src/main.js#rememberLastFileImportContext`；`src/main-process/statement-session.js` | 可在 freshness 路径为空时恢复 FilePlan 的真实输入来源 |
| 金额校验只拒绝 `parseNumericValue(...) === null` | `src/main-process/manual-balance-seed-preflight.js#buildManualBalanceSeedPlan` | `0` 是合法余额，需用回归测试锁定，不改业务校验 |
| 两个余额补录 dialog 都直接 await IPC 且没有 catch | `src/renderer-dialogs.js`；`src/renderer.js#legacyCreateManualBalanceSeedDialog` | 主修复之外必须补可观测性，避免将来再次静默无响应 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 空 FilePlan 应改为 output、deferred 还是恢复 session input | 架构盲区 | 高 | 中 | 当前 registry source kind 为 `statement-session-inputs`；operation tracker 也把此 action 视为账单输入续接 | PROBE | 对照 policy、FilePlan validator、session 状态与旧提交意图 | 恢复真实 session input；不扩大到未来 balance-seed output/原子写协议 |
| 记忆路径为空时是否可以继续写种子 | 失败模式 | 高 | 容易 | eager manifest 不允许空；无文件也无法建立可解释来源 | PROBE | 构造无 importContext/session 输入的 prepare | 结构化返回 `BALANCE_SEED_SOURCE_MISSING`，要求重新导入 |
| 用户输入 `0` 是否会被空值逻辑吞掉 | 金额边界 | 高 | 容易 | 现有解析返回数值 0，过滤条件使用 `!== null` | PROBE | 以字符串 `'0'` 完成 prepare → lifecycle → write 全链测试 | 保留为数值 0，不引入 truthy/falsy 判断 |
| IPC 再次 reject 时草稿与覆盖确认是否丢失 | UI/重试 | 中 | 容易 | 现有 Promise 无 catch，点击表现为无反馈 | PROBE | 源码契约测试覆盖 active/legacy 两入口 | 弹可见错误并在确认后恢复日期与余额；提交期间禁用重复请求 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 加入“内存会话 + 空 freshness paths + 余额 0”回归 | 锁定真实现场与金额边界 | 旧实现因 resolver 缺失/空 plan 失败 | 若无法走 lifecycle，则拆分成 FilePlan 与写盘两层测试 | 只撤测试 |
| 2 | 分离 freshness inputs 与 FilePlan session inputs | 保持 eager 非空、真实来源和现有生成逻辑 | FilePlan normalize/reserve 成功，记录仍为 0 | 若源路径丢失则停止在 prepare，不写盘 | 回退 helper 与接线 |
| 3 | 为 active/legacy 提交与覆盖路径补反馈和防重 | 消除静默失败与重复写风险 | rejection 被 catch，草稿可恢复，opaque confirmation 保留 | 若弹窗状态冲突则只保留可见错误，不自动恢复 | 独立回退 renderer 改动 |
| 4 | 跑交互预检、账单 session、archive lifecycle、store 与 smoke | 检查状态、持久化、入口旁路和审计合同 | 聚焦测试与 smoke 通过 | 任一资金语义/归档回归则停止交付 | 不碰真实余额文件 |
