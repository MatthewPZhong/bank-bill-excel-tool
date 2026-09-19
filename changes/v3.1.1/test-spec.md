# v3.1.1 Test Spec

## 1. 平盘侧库

### 1.1 允许

- 已知旧十表结构完整，十表均 0 行。
- 无现代 checkpoint/history/operation-inputs。
- 主库无正式 checkpoint、无 pending、存在合法 generation 0 bootstrap。
- 升级后表/列/索引齐全，checkpoint 与 bootstrap 一致，业务表仍全部 0 行。
- 关闭重开后按现代侧库正常加载。

### 1.2 阻断

- 十表任一有 1 行。
- marker-only、缺表、错列、未知表、未知视图、未知触发器。
- 空文件、非 SQLite、`quick_check` 非 `ok`、检查异常。
- 主库已有 checkpoint、存在 pending、bootstrap 缺失/非法/非 generation 0。
- 已有现代库不匹配、checkpoint history 缺失/分叉。
- 故障注入第二 SQLite 连接在事务前空表证明完成后插入数据；取得写锁后的完整复检必须阻断，
  不得补 schema/checkpoint，拒绝错误不得包含注入值。
- 故障注入在首次路径检查返回“不存在”后、Store 打开前创建外部表及数据；锁内无用户 schema
  证明必须阻断，外部对象/数据和 journal mode 保持原样，且不得补任何平盘 schema/checkpoint。
- 正常新建和空旧库升级在初始化事务成功后仍必须进入 `WAL`，不能因拒绝路径的无副作用约束
  丢失正式侧库运行参数。
- Store 的初始化结果只暴露 `new`、`empty-legacy-upgrade`、`existing` 三种 mode；主流程成功日志只写
  mode，拒绝日志只写结构化 code/reason。

## 2. 银行方向

对 DEBIT / CREDIT 分别覆盖：

- 主侧正数、负数、空、非法、0；
- 对侧空、合法 0、非法、正/负非 0；
- 双零、双非零、未知方向。

只有主侧合法非 0 且对侧空/合法 0 返回 `ok`。

## 3. R3.5

- 相同 ReconID/账号/币种/金额/日期下，in 只能选 Credit，out 只能选 Debit。
- 错误方向不计入多候选、不消费、不改写、不进入保护集。
- 全局 Phase1 同日优先于其它调拨行的 `±N` 候选。
- `260701 ↔ 260708` 在 N=7 命中；`260709` 不命中。
- 等绝对日期差按银行原序；反转原序后选择随之反转。
- 日期启用时缺失/非法不命中；关闭时跳过日期但仍校验其它维度。
- Stage B Credit/inbound sibling 不改 `Charge`；Debit 未保护 sibling 才可改。
- Step2 白名单、Credit 守卫和 outbound/Charge 行为 golden 不变。

## 4. R4

- Ach Return→Debit、Wire Return→Credit、HX-out→Debit、HX-in→Credit。
- 同 ReconID 方向相反银行行严格分流。
- no-op 仍产生具体 `matchedPairs`、消费银行行，但不产生 modification。
- 共享 validator 前后 warning code、数量、reason 文本和 matchedPairs 完全一致。

## 5. R5s2

- 网关和调拨两来源分别验证真实方向。
- 错误方向排在前、正确方向排在后时只能选后一条。
- 错误方向不进入 `usedBankRowIds`，不增加写入引擎多候选数。
- directions 重复、缺项、多余、错配、未知时整轮零消费/零改写，只产生一次配置告警。
- 日期 on/off、同日优先、N 边界、绝对差和原序与 R3.5 同口径。
- 来源 ReconID 空不进池；银行目标 ReconID 空可在完整命中后写入。
- 密集 `N` 来源 × `M` 银行日期失败时，每个写入引擎最多按“银行原始行序 + `_rowId` + 期望方向
  + 原因”输出一条；25×25 同原因场景应为 25 条而不是 625 条，Phase1/Phase2 不重复。
- 同一银行行的不同失败原因仍分别保留；不同银行行即使 `_rowId` 缺失也不得互相折叠。
- 告警去重前后匹配、消费、改写、标黄和行数守恒完全一致。

## 6. Policy / owner / UI

- owner enabled/disabled 解析出相同 policy。
- owner 0 返回 true/1 + warning；owner >1 或伪内置保留签名冲突 fatal。
- 缺字段兼容默认；非法原值回退并告警，非法 A→B 即使 effective 相同也改变 signature。
- migration 对 0/1/>1、两级名称冲突和历史 applicable channels 有测试。
- canonical `function` 仅在精确等于旧系统默认文案时更新；二次执行幂等，任意自定义文案及其它 config 保留。
- public create 伪造 builtin、update 身份漂移、单删/批删/转移/渠道写入/bundle 克隆均被拦截或归一。
- UI 只有 canonical owner 显示专属标题和日期控件；旧冲突可见可删。
- canonical owner 的日期控件与优先级共用同一横排，日期在左、优先级在右；日期勾选框和文本须与下一行首个勾选项左对齐；其它 builtin-fixed 仍显示银行渠道在左、优先级在右。

## 7. Run / export

- R5 disabled + owner N=7：R3.5/M2M 仍使用 N=7。
- R5 disabled + R3.5 enabled 的 2×2：独立审计 context 产生两条 M2M 说明，且审计数组不进入 R5 写入。
- owner policy 运行后变化：旧结果拒绝导出。
- owner fatal 冲突在运行和导出均拒绝。
- resolver warning 位于错误报告并计入 stats；相同 warning 去重。
- 行数守恒、实际修改/命中/消费/标黄分离。

## 8. 发布验证

- 定向单测：position、direction validator、R3.5、R4、R5 两来源、M2M、resolver、migration/repository/bundle/UI、orchestrator。
- 完整：`npm run release-check`。
- 变量：`npm run scan:vars`、`npm run check:vars -- --include-minor`。
- 人工：隔离旧侧库副本；两条问题资金样本；场景管理页交互。
