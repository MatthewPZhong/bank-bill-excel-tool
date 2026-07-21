# Tasks — v3.0.23 C3 渠道预筛与 R4 资金性质校验收紧

## Task 1 — 规格与风险基线
- 目标：固化 C3 隔离边界、R4 固定规则、消费顺序、金额口径和资金红线。
- 验证：`spec.md`、`test-spec.md`、`tasks.md`、`implementation-notes.md` 一致。
- 状态：completed

## Task 2 — C3 双候选池
- 目标：单次数据库读取生成 `exactRows/c3Rows`，只向 C3 注入放宽候选。
- 验证：AC-01～AC-05、C3-01～C3-09。
- 状态：completed

## Task 3 — R4 严格匹配
- 目标：四个固定场景使用完整 exactRows，按四要素、金额、手续费和方向严格 1:1 消费。
- 验证：AC-06～AC-17、R4-01～R4-17。
- 状态：completed

## Task 4 — 告警、描述与版本文档
- 目标：补齐错误原因、内置场景说明、版本号、三份版本文档和重要变量清单。
- 验证：AC-18～AC-20、R4-18、版本搜索和 `/check-vars`。
- 状态：completed

## Task 5 — 自动验证与资金盲区复核
- 目标：定向测试、全量门禁、变量扫描和 reconciliation blindspot pass。
- 验证：test-spec §5 自动命令全部通过，Finding 被处理或明确留档。
- 状态：completed

## Task 6 — R4 → R5 同值匹配血缘
- 目标：R4 输出包含 no-op 的具体匹配关系，R5 精确排除 R4 AchReturn 匹配银行行，不按 ReconID 扩散。
- 验证：AC-21～AC-27、L-01～L-10，既有 modification/标黄/R1 过滤零回归。
- 状态：completed

## Task 7 — 真实资金数据人工复核
- 目标：逐笔核对真实 Ach/Wire/HX 的金额、手续费、方向、1:1 和告警。
- 验证：资金负责人留下明确结论；缺少 HX 样本时保留验收缺口，并用真实重复 ReconID 样本复核 R4 no-op → R5 排除。
- 状态：pending（⚠️ 不能由自动测试替代）

## Task 8 — 合并归档与在线发布
- 目标：归档 PR #98 与 v3.0.23 PRD，创建受控 tag，并验证 Windows Release 与在线升级资产。
- 验证：PR 为 MERGED、开发分支删除、tag 指向发布准备 commit、Release workflow 成功、公开资产与 `latest.yml` 一致。
- 状态：completed（tag `v3.0.23` 指向 `e0c370b`；workflow `29853035917` 通过，latest Release 与四个公开资产已验证）
