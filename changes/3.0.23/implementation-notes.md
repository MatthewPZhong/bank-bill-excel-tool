# Implementation Notes — v3.0.23

## Baseline

- Goal/spec：[`spec.md`](./spec.md)
- Source：`/Users/pzhong/Desktop/R4四类资金性质校验收紧方案.md`
- Initial plan：用户批准“C3 Channel 仅预筛层忽略大小写 + R4 四类严格 1:1 匹配”实施计划。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
|---|---|---|---|
| 单次 SQL 生成 exact/C3 两个网关池 | 网关表可达百万行，不能重复查询、解析或深拷 | 两次查询；全表读后 JS 过滤 | 保留内存优化并隔离行为 |
| C3 使用 trim + SQLite NOCASE | 用户要求只 trim、不区分大小写；Channel 为英文枚举 | 子串/模糊匹配；全局 lower-case 持久化 | 仅候选加载层放宽 |
| R4 使用完整 exactRows | R1 只按 ReconID 预配对会提前选择错误 TradeType/账号候选 | 继续使用 `r1.matchedGwRows` | R4 自己执行完整资金条件 |
| 网关原始顺序优先 | 用户明确选择 | 银行顺序优先；金额最接近 | 冲突结果稳定可解释 |
| 相反方向空按 0、非法阻断 | 用户明确选择 | 空/非法都按 0；空/非法都阻断 | 收紧非法金额且兼容空单元格 |
| 四类规则由 subCategory 固定 | 规格要求固定 TradeType、方向和目标 FundType | 继续读取可漂移 config 字段 | 用户启停保留，核心资金口径固定 |
| R4 匹配关系与字段修改分离 | R5 需要识别 R4 no-op AchReturn 关系，但 modification 必须只代表真实改值 | 伪造 no-op modification；按 ReconID 扩散过滤 | 新增 `matchedPairs`，保持标黄与字段修改契约真实 |
| R5 按 R4 pair.bankRow 对象身份过滤 | 本次编排全程复用同一银行行对象，可精确表达实际消费关系 | 按 ReconID 或 `_rowId` 建集合 | 只排实际配对行，不连带同 ID 其它行 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
|---|---|---|---|
| Channel 大小写差异只涉及 ASCII 英文 | 当前 Channel 枚举和用户示例 | 非 ASCII 大小写不会被 NOCASE 折叠 | 单测锁定边界；需要时单独评审 Unicode 规则 |
| 链接表查询 `ORDER BY id ASC` 等于网关原始顺序 | 当前落库与仓储契约 | 冲突赢家可能改变 | 仓储测试锁定；回滚为旧读取接口 |
| R4 输入银行行保持 Excel 原序且 `_rowId` 稳定 | 当前导入和编排器原地复用 `bankRows` | 1:1 消费顺序或身份判断失效 | 单元/编排器测试锁定 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
|---|---|---|---|---|
| 既有 `gateway-channel-filter-equivalence` 集成 fixture 继续按旧 R4 仅 ReconID 行为运行 | fixture 补齐 MerchantId、Currency、金额和方向字段，并改为验证双候选池及严格 R4 实际命中 | v3.0.23 的 R4 契约已收紧，旧 fixture 不再构成合法候选 | 只更新测试数据和断言，不改变已批准业务规则 | 是 |

## Evidence

| 证据 | 结果 | 覆盖范围 |
|---|---|---|
| 初始定向单元测试 | `144/144 PASS` | 双候选池、编排隔离、R4 四类规则、告警、迁移和 main 接线 |
| R4→R5 血缘定向单元测试 | `205/205 PASS` | R4 matchedPairs、no-op、对象身份、同 ID 不扩散、R1/R4 并集与完整编排 |
| `npm run release-check` | 通过；ESLint、smoke、`3791/3791` 单测、42 个集成脚本共 `1963/1963` 断言全部通过 | 全量自动回归门禁 |
| `gateway-channel-filter-equivalence` | `23/23 PASS` | 旧 exact 接口等价、C3-only 候选隔离、严格 R4 命中及 R4 no-op→R5 完整链路 |
| `npm run scan:vars` | 通过；v3.0.23 共扫描 201 个文件、2323 个顶层变量 | 重要变量统计刷新 |
| `npm run check:vars -- --include-minor` | 按设计以 code 2 报告 2 个 Critical、4 个 Risk-sensitive 命中；要求的 smoke 已由 `release-check` 验证通过 | `runAllScenarios`、`runReconciliation`、`readGatewayBillRowPoolsByChannels`、`runRound4FundNatureCheck`、`runRound5RefundOrderBackfill` 关联功能 review |
| reconciliation blindspot pass | 已完成；R4→R5 no-op 自动化血缘缺口已关闭，真实重复 ReconID 与资金人工门禁继续记录 | 对账主键、金额币种、方向、消费守恒、可观测性 |
| GitHub PR #98 Windows workflow | PASS | 远端 Windows 门禁 |
| 最终 self-review | P0-P4 Finding 0 | 合并质量门 |
| PR #98 | merge commit `0171b2b` 合入 `main`；远程与本地开发分支删除 | 合并和分支收口 |
| 最终 `main` release-check | 干净 `npm ci` 后 lint、smoke、unit `3791/3791`、integration `1963/1963` 全绿 | tag 前发布门禁 |
| 主页面几何门禁 | 2 个窗口尺寸 × 3 个缩放比例，`6/6 PASS` | Windows 发布工作流同款 UI 门禁 |
| `npm run startup:measure` | 平均总耗时 `941.452 ms`，平均 ready-to-show `236.08 ms` | tag 前启动性能检查 |
| 最终变量门禁 | `scan:vars` 仍为 201/2323；归档后 HEAD/工作区无 `src/` 差异，`check-vars` 安全跳过 | 硬节点已执行，PR 关联变量 review 继续有效 |
| `npm audit --omit=dev` | 既有 7 条生产依赖告警（2 moderate、5 high） | v3.0.23 未改生产依赖，继续作为依赖治理 follow-up |
| annotated tag `v3.0.23` | tag object `7a888c5`，指向发布准备 commit `e0c370b` | 版本与最终 `main` 一致 |
| Windows Release workflow | run `29853035917` 在 `15m04s` 内完成测试、打包、资产校验、发布和发布后验证 | 正式 Windows 发布证据 |
| GitHub Release `v3.0.23` | latest、非 draft、非 prerelease；四个资产 uploaded | 在线升级发布完成 |
| 公开资产独立复核 | Setup/portable 匿名 Range 文件头均为 `MZ`；`latest.yml` 版本、路径、大小、SHA-512 与 SHA-256 元数据一致 | 公开下载与更新 feed 可用 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
|---|---|---|---|
| HX_OUTBOUND/HX_INBOUND 真实样本缺失 | PROBE | 资金负责人提供样本后逐笔复核 | 不阻断编码；不得宣称 HX 业务验收通过 |
| 真实 Extra Fee 正负组合是否符合固定公式 | PROBE | Ach/Wire 真实样本逐笔核对 | 资金红线人工门禁 |
| 真实重复 ReconID 下 R4 no-op Ach Return 与 R5 的逐笔结果 | PROBE | 自动化缺口已通过 `matchedPairs` 关闭；资金负责人用真实重复 ReconID 样本核对只排具体银行行 | 不阻断代码完成；不得据此宣称退款碰撞场景已人工验收 |
