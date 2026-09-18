# Implementation Notes — v3.0.16

## Baseline

- 原始需求：前置资金对账纳入 Extra Fee、按附件更新规则、临时链接表失败页增加错误导出和删除重跑。
- 最终范围：见 `changes/3.0.16/spec.md`。

## Decisions

| 决定 | 原因 |
|---|---|
| 不实现 `MPT_CHANNEL_OTHERS` 及依赖它的临时银行/缺渠道链路 | 用户于 2026-07-15 明确取消；不得用不完整 FundType 来源做资金匹配 |
| 规则固化为代码常量 | 附件是本次需求输入，未要求运行时配置；固定契约可测试、可审计并避免桌面路径依赖 |
| 空网关 tradeType 表示无自动匹配类型 | 避免把空值解释为通配符造成错配 |
| Extra Fee 为空按 0、非空非法即拒绝银行导入 | 兼容旧数据，同时不掩盖金额脏值 |
| 删除错误数据为不改源文件的逻辑排除 | 用户确认；保留原始文件和排除行血缘 |
| 只有明细行校验错误可修复 | 结构、身份和完整性错误无法靠删除单行安全修复 |
| 失败操作只接受主进程 UUID 令牌 | renderer 不得传任意文件路径；令牌随新导入或重启失效 |
| 旧 side DB 只在导入写路径幂等补结构 | 避免列表/候选读取反复执行 DDL 与大文件导入争用 SQLite 写锁 |
| 错误工作簿达到 Excel 行数上限时 fail closed | 防止报告被截断或生成无法打开的文件；已有目标文件必须保持原样 |

## Assumptions

- 对账规则值去首尾空格后大小写敏感；附件中的大小写和连字符均有业务意义。
- 两侧发生额均为零的银行行继续跳过，即使 Extra Fee 非零也不提升为参与行。
- 规则不合格是可见不平结果，不是整次运行错误。

## Deviations

- 初始讨论曾包含 3.0.14/3.0.15 顺延的 `MPT_CHANNEL_OTHERS`、临时银行账单和缺渠道账单；用户最终明确本版不做，spec 已先反向同步。

## Evidence

- 附件 `资金对账规则.xlsx`：`资金对账规则!A1:F15`，14 条规则，均为 1 对 1。
- 附件 14 条规则与代码常量逐字段比较：14/14 完全一致。
- 真实历史样本验证过正手续费 `9999980 + 20 = 10000000` 与负手续费 `3300254.4 - 254.4 = 3300000`。
- MPT parser/store 聚焦测试：40/40，通过多错误汇总、严格回滚、哈希防篡改、逻辑删除审计和旧批次恢复。
- 错误报告回读：INBOUND/OUTBOUND 分 sheet、33 字段、30000 字符 UTF-16 安全分片、源文件变化和 sheet 行数超限均不会覆盖目标文件，聚焦测试 3/3 通过。
- service/UI 聚焦测试已覆盖失败令牌、错误导出、逻辑删除重跑、令牌失效和三按钮 IPC 接线。
- `npm run release-check`：单元测试 3585/3585，40 个集成脚本 1877/1877，smoke 与 ESLint 全部通过。
- 页面预览：主页面、前置资金对账完成态、临时链接表管理、临时链接表导入失败均已生成并人工检查；完成态另在 General 样式复核，无按钮、长文件名或状态文本重叠。
- `npm run startup:measure`：5 次运行，进程中位数 776.875ms，ready-to-show 中位数 167.623ms，window-visible 中位数 98.607ms，renderer init 中位数 43.2ms，getInfo 中位数 10.9ms。
- `npm run scan:vars`：191 个 JS 文件、2122 个顶层声明；A-share 335 / A-pair 554 / A-local 1100 / B 889。
- `npm run check:vars -- --include-minor`：命中 `FileValidationError`、`ipcRenderer`、`MODULES/app/dialog/state` 和前置资金对账风险符号；已逐项确认错误 schema、IPC 对称、取消分支、状态生命周期和资金不变量。
- 最终 self-review：P0/P1/P2/P3/P4 Finding 均为 0；`git diff --check` 及新增文本尾随空白检查通过。
- PR #89：GitHub Actions `smoke-test` 通过；head `e6a939f` 以 merge commit `e09a18c` 合入 `main`，远程开发分支删除。
- 归档：`docs/prs/PR89-v3.0.16.md`、`docs/iterations/v3.0.16/PRD-v3.0.16.md`。

## Remaining Unknowns

- ⚠️ 人工复核：真实脱敏样本中的规则组合和 Extra Fee 正负号仍需业务人员逐笔确认；自动测试不能替代。
