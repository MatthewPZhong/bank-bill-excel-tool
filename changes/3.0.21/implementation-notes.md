# Implementation Notes — v3.0.21

## Baseline

- Goal/spec：[`spec.md`](./spec.md)
- Initial plan：用户于 2026-07-20 批准“Ach Return 使用 R1 具体配对 + DBS 固定白名单与方向守卫”实施计划。
- Done when：自动验收 AC-01～AC-13 通过，合成回归与受控本地问题样本精准命中；人工资金复核保留为明确 follow-up，用户已在知悉该项未完成后授权发布。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
|---|---|---|---|
| R5 使用 `r1Pairs` 中的银行对象引用 | R1 已做精确 ID 配对并返回原引用，可避免同 ID 扩散 | 在 R5 重建 reconid Set；按 ID 再匹配一次 | 只过滤 R1 选中的具体行 |
| R5 只认严格 `AchReturn` | 用户确认网关 TradeType 才代表前置过滤语义 | 任意同 ID 网关行；模糊/大小写不敏感 | `Inbound-VA` 不再阻断退款 |
| DBS 白名单写死为 12 类 | 权威附件 `DBS-Charge网关TradeType白名单.xlsx`，`Sheet1!A2:A13`，SHA-256 `78fbffcd9d2dcca8755124fc92b6aa2c58fc53bd60f945668203d685225160f0`；2026-07-20 逐项回读 | 每次运行读取 Excel；数据库可配置 | 行为可测试、可版本追踪 |
| DBS 方向先于金额币种 | 批准计划明确“方向通过后继续金额币种”；方向异常应保持进入步骤2前的 FundType | 只有金额币种命中后才检查方向 | 步骤2不新增改写；步骤1既有 sibling 归并仍保留 |
| 空/非法 Credit 按 0 | 明确要求沿用 R4 的现有 `(parseNumber(value)||0)` 口径 | 非法阻断或人工异常 | 兼容既有行为，但保留资金风险说明 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
|---|---|---|---|
| 生产编排器传入的 R1 bankRow 与 R5 bankRows 是同一对象引用 | 当前编排器各轮原地复用 `bankRows` | 若未来克隆，前置过滤会失效 | 编排器集成测试锁定；未来接口变化时改用稳定行 ID |
| 网关 TradeType 字段名为 `TradeType` | 现有链接表 raw JSON、R4 和受控本地网关样本 | 字段改名后白名单/过滤失效 | 版本测试和本地导入回放；无 schema 变更可直接回滚 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
|---|---|---|---|---|
| 无行为偏差 | 实施保持批准口径 | — | — | 是 |
| test-spec 已列缺省/畸形 `r1Pairs` 矩阵，但首版只覆盖未传参数 | self-review 补齐 null、非数组、空数组、畸形 pair、`Inbound-VA` 和空 TradeType | 清除 P4 测试覆盖缺口 | 不改变生产行为，只锁定兼容契约 | 无需，原 spec/test-spec 已有该要求 |
| 对象引用过滤已有实现，但首版同 ID 用例使用不同 `_rowId`，未锁死身份边界 | 独立 Development review 后补“克隆对象同 rowId/reconid 不过滤”及“有效 bankRow 缺 gwRow”用例 | 清除 P4 防回归缺口 | 不改变生产行为，防止未来退化为 rowId/reconid 过滤 | 无需，原 spec 已规定对象引用 |
| 首版文档将 Credit 非0描述成引擎全程“原值不变” | PM review 后收窄为“步骤2不新增改写”，并补 sibling 已被步骤1归 Charge 的组合测试 | DBS 步骤1是明确非目标，不能被方向守卫回滚 | 清除跨步骤契约歧义，生产逻辑不变 | 是 |
| 首版测试和分发文档记录了本地问题样本业务标识 | 全部替换为合成编号，仅保留“受控本地回放通过”的非识别性证据 | 真实业务标识不应进入 Git 历史或安装包用户指南 | 合成测试维持同构行为；本地血缘不分发 | 是 |
| 初版把人工资金复核写为发布硬门禁 | 用户在最终汇报已明确披露待办后，仍于 2026-07-20 指示合并并执行发布收尾 | 最新明确发布指令覆盖原流程假设，但不等于人工复核已完成 | 改为发布后 follow-up，发布说明持续披露风险 | 是 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
|---|---|---|
| 受控本地银行/退款附件只读解析 | DBS/USD、Debit 11000、FundType=Ach Return、SUBMITTED，账号/币种/金额和 CustomerRef 条件一致；标识不入库 | 退款两侧血缘 |
| 当前网关库只读查询 | 对应 ID 唯一行 `TradeType=Inbound-VA`、amount 11000、currency USD；标识不入库 | 证明旧全 ID 过滤错误、目标行为应放行 |
| 白名单权威附件回读 | `DBS-Charge网关TradeType白名单.xlsx` `Sheet1!A2:A13` 共 12 项，与代码常量逐项一致；SHA-256 如 Decisions 所列 | 白名单来源可追溯 |
| 最终定向单元测试 | `220/220 PASS` | R5 配对过滤、对象身份边界、缺省/畸形 pairs、DBS 白名单/方向、步骤1 组合回归、编排器接线和错误原因 |
| 受控本地问题样本只读回放 | 网关 TradeType=`Inbound-VA`；输出对应退款单，命中类型=`精准命中`，未命中数=0，warning=0；业务标识不入库 | AC-05 及原问题闭环 |
| 完整单元测试 | `3716/3716 PASS`，227 个测试文件，0 失败 | 全模块单元回归 |
| 完整集成测试 | 42 个脚本，`1955/1955 PASS` | 编排器、Excel 链路及既有资金流程回归 |
| `npm run release-check` | PASS；lint、smoke、unit、integration 全部通过 | 发布自动门禁 |
| `npm run scan:vars` | PASS；纯 v3.0.21 树为 195 个 JS 文件、2202 个顶层名称 | 重要变量统计刷新；排除后续 v3.0.22 未提交文件干扰 |
| `npm run check:vars -- --include-minor` | 按设计返回退出码 2，命中 Risk-sensitive：`runRound5RefundOrderBackfill`、`STEP2_GW_TRADE_TYPE_WHITELIST`；无更高层级命中 | 要求关联功能 review，不代表测试失败 |
| GitHub PR workflow | run `29747527965` PASS | 远端 Windows smoke 门禁 |
| 最终 self-review | P0-P4 Finding 0 | 合并质量门 |
| PR #96 | merge commit `3c44420e` 合入 `main`；远程与本地 3.0.21 开发分支删除 | 合并和分支收口 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
|---|---|---|---|
| 真实 DBS 数据中 12 类白名单与方向结果是否符合业务预期 | PROBE | 资金负责人发布后逐笔复核；用户已在知悉未完成后授权发布 | 不阻断此次发布，但不得宣称人工验收通过 |
| 合法 AchReturn 静默过滤是否需要审计 | 已知非目标 | 后续建议4迭代 | 不阻断本轮实现 |
| R4 扩散、网关侧 DBS MerchantId/Channel、候选1:1是否需收紧 | 已知非目标 | 单独资金规则评审；当前其它渠道/商户同 ID 白名单候选仍可能参与步骤2 | 不阻断本轮实现，已在用户文档披露 |
