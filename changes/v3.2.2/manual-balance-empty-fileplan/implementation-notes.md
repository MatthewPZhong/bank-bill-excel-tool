# Implementation Notes

## Baseline

- Goal/spec: [preflight.md](./preflight.md)
- Initial plan: 先复现空 FilePlan 与无反馈，再分离账单来源和 freshness 路径，最后覆盖数值 0、两个 renderer 入口与 archive lifecycle。
- Done when: `26/08/01`（规范化后 `2026-08-01`）早于当前账单日且余额 `0` 时可完成补录；异常不再静默；不改变余额键、覆盖和生成语义。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 新增 `resolveManualBalanceSeedFilePlanInputPaths`，优先使用 freshness inputs，空时回退 `importContext`，最后回退当前 session scope | `file:save-balance-seed` 的 policy 明确是 `statement-session-inputs`；内存生成不重读源文件不等于任务没有源文件 | 放宽空 eager manifest；伪造输入；把 action 改成 no-file；本次提前实现未来 target-post-image 协议 | 只修 FilePlan 来源，生成与种子写入顺序不变 |
| 所有真实来源都缺失时在 prepare 返回 `BALANCE_SEED_SOURCE_MISSING` | eager FilePlan 必须非空，且继续写入会失去可解释来源 | 让底层 TypeError 冒到 renderer | 业务不会开始，也不会写余额种子 |
| 以显式 `=== null` 继续判无效，新增 `'0'` 全链回归 | 当前业务已正确允许 0，缺口在测试和 FilePlan | 改金额解析或把 0 转空字符串 | 余额 0 以 number 0 落盘 |
| active 与 legacy dialog 共用同型的 `saveBalanceSeedWithFeedback` 局部包装 | 两个入口都存在直接 await；覆盖确认是第二条 IPC 路径 | 只修现场 active 入口；只依赖主状态栏 | rejection 弹窗可见、草稿保留、重复点击受控；覆盖请求仍只传 opaque context |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 现场工作簿只读检查 | `Sheet1!A1:AJ8`；含 GBP/USD 两账号币种组合，无余额列；最早账单日期晚于用户选择的 2026-08-01 | 证明该文件应进入人工初始余额流程；附件未修改 |
| Electron 日志与 DevTools console | prompt 当前账单日为 2026-08-14；重复错误为 `eager filePlan 必须至少包含一个文件` | 证明无响应来自空 FilePlan + 未捕获 Promise，不是日期或余额 0 |
| 新增测试、生产修复前 | 8/10 PASS；FilePlan resolver 与 renderer rejection 反馈两个用例失败 | 证明测试可捕获现场缺口 |
| `node --test tests/unit/main-process/interactive-task-preflight.test.js` | 10/10 PASS | 覆盖 0 写盘、内存会话真实 input、reserve、覆盖确认、freshness 与 active/legacy 反馈 |
| 余额 store + interactive preflight + Statement session + FilePlan + TaskLifecycle + policy 聚焦组 | 165/165 PASS | 覆盖种子读写、非空 manifest、输入 freshness、会话入口和审计终态 |
| `node --check`（manual preflight/main/两个 renderer） | PASS | 四个生产文件语法有效 |
| `npm run smoke` | PASS | 账单读写、场景、ReconFix、收单币种、使用统计等 smoke 无回归 |
| `npm run check:vars` + `rules/important-variables.md` 自查 | 本补丁相关命中 `normalizeCell`、`normalizeInputFilePaths`；Critical `freezeWorkerBatchContext`/`unmatchedRows` 来自工作区既有并行改动 | 未修改两个归一函数的实现；绝对路径/中文文件名仍走既有 helper；已跑要求的 smoke |

## Reconciliation Blindspot Pass

| 维度 | 结论 | 证据/保护 |
| --- | --- | --- |
| 主键血缘 | 未改变 `merchantId + currency + billDate` | `balanceSeedRecordKey` 与 overwrite plan 原样保留 |
| 金额/币种 | `0` 保持合法 number；币种不改写 | `'0'` prepare → write → read 断言为 `0` |
| 时间边界 | 仍要求 seed date 严格早于 target bill date | 原校验未改；现场 2026-08-01 < 2026-08-14 |
| 幂等/重复 | 同键仍走覆盖确认；前端提交期间阻止重复点击 | opaque context 回归 + `saveInProgress` |
| 部分失败 | 无 FilePlan 来源时业务执行前停止；IPC rejection 可见且保留草稿 | `BALANCE_SEED_SOURCE_MISSING` 与 renderer catch |
| 行数/输出 | 未改账单行过滤、金额计算、balance workbook 生成 | 本补丁只改任务输入接线与 UI 反馈 |
| 资金红线 | 未发现新增金额方向、精度、币种或覆盖语义变化 | 聚焦测试与 smoke 均已通过 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 修复后的当前 Electron 进程尚未重启，现场同一文件的端到端点击尚待复验 | PROBE | 重启开发应用后由用户用同一文件、日期和余额重试；本次没有代用户写真实 seed | 不阻断代码级根因修复，阻断宣称现场已验证 |
| balance seed 的未来原子替换、post-image 与启动恢复协议 | ASSUME | 已在背景执行版本计划中另行安排；本修复不抢跑 | 不扩大本次 bugfix 范围 |
| 源文件在首次导入后、补录前被外部修改时，内存结果与再次归档快照的历史合同 | ASSUME | 沿用当前 `statement-session-inputs` 行为；如要锁定首次 picker snapshot，另立跨会话来源合同任务 | 不改变当前发布兼容性 |
