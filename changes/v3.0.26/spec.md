# Spec — v3.0.26 平盘文案、前置资金导出与 R5 手续费迭代

> status: released（PR #101 已合入 main；GitHub Release v3.0.26 已发布；human-fund-review-pending）
> owner: PM / Dev
> created: 2026-07-25
> updated: 2026-07-25

## 0. 任务摘要

- Goal：调整两处前端文案；在前置资金对账“不平结果”增加银行 `FundType`；让 R5 中台调拨订单对账 ID 回填按包含 `Extra Fee` 的银行金额匹配。
- Context：当前“不平结果”为 20 列且未输出 `FundType`；R5 两种调拨来源与多对多审计复用只计算 `abs(Credit-Debit)` 的金额助手，该助手同时被 DBS-Charge 使用。
- Constraints：C4 必须继续读取历史 19/20 列结果；DBS-Charge 不得因 R5 需求开始计算手续费；不改变 R5 的日期、账号、币种、方向、候选顺序和 1:1 消费规则。
- Done when：AC-01～AC-15 通过，版本文档、模板、定向测试、release-check、启动性能与重要变量检查完成。

## 1. v3.0.25 基线

- 平盘占位模块按钮位于 `index.html`，点击提示在 `src/renderer.js`；两处当前均使用“对账表管理”。
- 资金对账链接表删除框由 `src/renderer-dialogs.js::createLinkedTableDeleteRangeDialog` 创建，标题会随目标表切换；前置资金临时链接表使用另一独立弹框。
- 前置资金“不平结果”字段由 `src/main-process/pre-fund-reconciliation/output-mapper.js::UNBALANCED_HEADERS` 定义，当前为 20 列；`mapUnbalancedRow` 可通过银行派生行的 `rawRow` 读取原始 `FundType`。
- 导出模板由 `src/main-process/pre-fund-reconciliation/excel-writer.js` 严格校验，真实模板为 `assets/资金对账导出不平.xlsx`。
- C4 gateway 文件读取由 `src/main-process/recon-id-fix-io.js` 负责；当前兼容旧 19 列“对账结果”和 20 列“不平结果”，再投影回既有 19 列内部结构。
- R5 默认调拨来源位于 `r5-fund-transfer-backfill.js`，调拨对账单来源位于 `r5-fund-transfer-recon-backfill.js`，审计位于 `many-to-many-detector.js`。
- 当前 `bankAmountAbs` 只计算 `abs(Credit Amount - Debit Amount)`，且被 `dbs-charge-fund-check.js` 复用。

## 2. 已确认决定

| 项目 | 决定 |
|---|---|
| `FundType` 位置 | 插入“交易类型”之后，成为“不平结果”第 6 列 |
| `FundType` 来源 | 对应银行原始行的 `FundType`，空值保持空，不推导 |
| R5 覆盖范围 | 默认调拨对账单来源、网关对账单来源及调拨多对多审计 |
| 银行金额 | `abs(Credit Amount - Debit Amount) + signed Extra Fee` |
| 精度 | 先加总，再沿用现有精确到分比较；合计后不再次取绝对值 |
| 手续费边界 | 空值按 0；正数增加、负数冲减；非空非法值退出 R5 候选并产生一次可见 warning |
| DBS-Charge | 两个步骤都使用显式旧口径比较器，不包含 `Extra Fee`，不得复用已改为含手续费的 R5 比较器 |
| 删除弹框 | 仅资金对账数据处理的链接表删除框标题固定为“删除数据” |

## 3. 前端文案

- 平盘模块按钮和 `showComingSoon` 提示由“对账表管理”统一改为“对账数据管理”。
- 按钮 ID、位置、尺寸、白色次按钮样式、占位行为和 IPC 范围不变。
- 资金对账链接表删除框初始标题和切换目标表后的标题都固定为“删除数据”。
- 目标表下拉、日期范围、后台计数门控、删除路由、实际删除表和成功提示保持现状。
- 前置资金对账的临时链接表删除框不在本次范围，继续显示具体临时表名称。

## 4. 不平结果 `FundType`

- `不平结果`由 20 列变为 21 列，前 7 列固定为：
  `对账数据来源、账单日期、支付渠道、业务类型、交易类型、FundType、对账结果`。
- `FundType`直接读取对应银行原始行同名字段；`null`、`undefined` 和缺失字段输出空单元格。
- 更新 `assets/资金对账导出不平.xlsx` 的“不平结果”表头；新增列复制相邻表头样式并保持协调列宽，冻结和自动筛选设置保持模板原状（当前模板二者均未设置），其余 sheet 不变。
- `平账结果`、网关账单、渠道账单、订单修复和动态重复审计 sheet 的字段、顺序和数据不变。
- C4 gateway 读取器严格接受：
  1. 旧 19 列“对账结果”；
  2. v3.0.14～v3.0.25 的 20 列“不平结果”；
  3. v3.0.26 的 21 列“不平结果”。
- 对新 21 列结果，C4 忽略“对账数据来源”和 `FundType`，继续投影为既有 19 列内部数据。
- 除上述三种精确契约外，错列、错序、缺列和未知额外列仍须拒绝。

## 5. R5 `Extra Fee`

- R5 银行匹配金额固定为：

```text
abs(Credit Amount - Debit Amount) + signed Extra Fee
```

- Credit/Debit 差值先取绝对值，随后加有符号手续费；最终合计不再次取绝对值。
- 比较继续沿用现有转分精度；网关和调拨对手金额仍按既有规则取绝对值，避免扩大到其它金额或舍入规则。
- 银行合计为负时，不能命中正数或负数对手金额，因为对手金额进入比较前仍会取绝对值。
- `Extra Fee` 为 `null`、`undefined` 或 trim 后空字符串时按 0。
- 合法正数、负数、普通小数和科学计数法按数值参与计算。
- 非空且无法解析为有限数值时：
  - 该银行行不进入本次 R5 候选；
  - 即使本次所选来源没有对手数据，也产生一次可见 warning；
  - warning 包含稳定 code、银行 `_rowId`、字段名，并在可见 message 中包含原始手续费值；
  - 同一 `_rowId` 每次运行只告警一次；缺少 `_rowId` 时才按对象身份去重；
  - 不降级为 0，不影响其它合法银行行继续运行。
- 新增 R5 专用金额助手，由默认调拨来源、调拨对账单来源和调拨多对多审计共同使用，保证执行与审计口径一致。
- 保留旧 `bankAmountAbs` 的既有导出和语义。DBS-Charge 步骤1继续使用旧银行金额；步骤2使用显式旧网关/银行比较器，两个步骤均只计算 `abs(Credit-Debit)`，不能复用已改为含手续费的 R5 `amountEqual`。
- R5 的日期优先、日期容差、账号、币种、方向池、原序、多候选、严格 1:1、同值消费、标黄和 `usedBankRowIds` 均不变。
- Payment 线下调拨、退款回填、R4 和前置资金对账自身的匹配规则不调整。

## 6. 兼容性与失败行为

- 不新增数据库表、迁移、IPC 或场景配置字段。
- 旧前置资金运行结果随应用重启失效，不做历史运行结果回填。
- 导出模板与代码契约必须同步升级；模板不匹配时继续 fail-fast，不生成半成品。
- R5 单行非法手续费是候选级失败并可见告警，不中止整批，也不静默当 0。
- “可见 warning”指进入随结果生成的主错误报告；本迭代不新增即时弹框或状态框提示。
- 版本回滚到 3.0.25 后不能读取 21 列“不平结果”属于旧版本能力限制；3.0.26 自身必须向后兼容旧文件。

## 7. 验收标准

- AC-01：平盘按钮和点击提示均显示“对账数据管理”。
- AC-02：平盘按钮 ID、样式、位置和占位行为不变。
- AC-03：资金链接表删除框在三种目标表下标题均为“删除数据”。
- AC-04：删除计数、路由、实际目标及成功提示不变；前置资金临时删除框不变。
- AC-05：“不平结果”固定为 21 列，`FundType` 位于第 6 列。
- AC-06：`FundType` 来自对应银行原始行，空值保持空。
- AC-07：真实模板保留 5-sheet 基础结构；有重复时仍仅动态追加第 6 sheet。
- AC-08：C4 可读取旧 19 列、旧 20 列和新 21 列并投影为 19 列。
- AC-09：C4 继续拒绝未知额外列、错序、缺列和错误列名。
- AC-10：R5 两种数据来源均使用含有符号手续费金额。
- AC-11：多对多审计与实际 R5 使用相同金额口径。
- AC-12：空手续费按 0；正负手续费和分位边界符合公式。
- AC-13：非空非法手续费不匹配，按稳定行身份只产生一次包含原始值的可见 warning；无对手数据时也不吞告警。
- AC-14：DBS-Charge 带非零手续费时行为与 3.0.25 一致。
- AC-15：版本、三份版本文档、重要变量、release-check 和启动性能门禁完成。

## 8. Unknowns Register

| 未知 | 分类 | 处理 |
|---|---|---|
| 真实正负手续费样本是否覆盖两种 R5 来源 | PROBE | 自动测试覆盖合成边界；交付后使用真实或脱敏样本逐笔人工复核 |
| Windows Excel/WPS 对新增模板列的最终视觉效果 | PROBE | 自动回读样式与结构；Windows 实机打开列入人工验收 |
| DBS-Charge 未来是否也应包含手续费 | 非目标 | 本迭代明确保持旧口径，后续需独立资金规则立项 |

## 9. 非目标

- 不实现平盘模块实际管理、运行或导出后端。
- 不改变 DBS-Charge、Payment、退款、R4 或前置资金对账匹配金额。
- 原实施计划不包含 PR、合并与发布；用户后续分别追加授权 PR #101 合并及 v3.0.26 发布收尾。
- 不在发布收尾中升级生产依赖；现有 advisory 进入安全治理 follow-up。

## 10. 交付与发布状态

- PR #101 最终 self-review 无 P0-P4 Finding，GitHub Windows smoke-test 与主页面对齐检查通过。
- PR #101 于 2026-07-25 以 merge commit `fa416aa` 合入 `main`，远程与本地开发分支均已删除。
- 合并后的 `main` 在干净 `npm ci` 依赖上重新通过 release-check：unit `3855/3855`、43 个 integration 脚本 `1978/1978`，lint 与 smoke 全绿。
- 发布前主页面布局为 `6/6 PASS`；启动建窗到可见平均 `102.107ms`，ready-to-show 平均 `173.357ms`。
- `scan:vars` 为 202 个 JS 文件、2329 个顶层声明；`check:vars -- --include-minor` 因 `src` 无新改动安全跳过。
- `npm audit --omit=dev` 报告 9 条生产依赖 advisory（2 moderate、7 high、0 critical）；v3.0.26 与 v3.0.25 的依赖图一致，新增计数来自 advisory 数据更新，继续作为安全治理 follow-up。
- annotated tag `v3.0.26` 指向 `f229c2c2837965d0d14335db5a6625f0196f2089`；Windows Release workflow run `30156308464` 全部通过。
- GitHub Release `v3.0.26` 已成为 latest、非 draft、非 prerelease，包含 Setup、Setup blockmap、portable 和 `latest.yml` 四个资产。
- 公开 `latest.yml` 版本为 `3.0.26`，Setup 路径和大小 `99,766,838` 正确；其 SHA-256 `07f3af5...ec1e5` 与 GitHub 元数据一致。
- Setup 与 portable 匿名 Range 回读均返回 HTTP 206，文件头均为 `MZ`。
- 真实资金样本、Windows Excel/WPS 和 `v3.0.25 → v3.0.26` 在线升级 canary 仍是公告前人工门禁；技术 Release 完成不等于这些人工验收完成。
