# v3.1.1 Unknowns Preflight

## Task Brief

- Goal: 同版交付平盘空旧侧库安全初始化兼容，以及调拨资金方向/日期防误匹配。
- Context: 当前版本为 3.1.0；工作分支为 `codex/v3.1.1-empty-position-side-db-bootstrap`；两块代码入口独立，但同属资金与持久化高风险。
- Constraints: fail-closed、不迁移非空旧库、不把方向后置、不改变 R3.5 Step2、R5s2b/R5s3/R5s4 或平盘匹配口径；v3.1.2 必须等待本版发布收尾。
- Done when: 两份子规范、版本文档、变量检查、完整发布检查和人工复核门禁全部有结论。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 已有侧库缺现代 checkpoint/history 会在 schema 补齐前统一阻断 | `PositionReconciliationStore` 初始化分支 | 只能新增窄的空旧库证明分支 |
| checkpoint 上线前存在稳定十表旧 schema | Git 历史 `e02e9b5^` | 只接受该已知结构，不猜其它旧版本 |
| 主流程已有 generation 0 bootstrap，成功后写正式 checkpoint 并清 bootstrap | `src/main.js::getPositionReconciliationService` | 兼容分支复用现有绑定生命周期 |
| R3.5 Step1/Stage B 与 R5s2 当前缺真实借贷方向门禁 | 三个现有资金引擎 | 方向必须进入 eligible candidate |
| R4 已有严格主侧非零、对侧零及完整金额/账号/币种条件 | `r4-fund-nature-check.js` | 共享 validator 只能重构，不改变审计口径 |
| 当前 R5 已实现全局同日优先和 `±N` 绝对差排序 | 两个 R5s2 引擎及基线测试 | 日期策略沿用此语义 |
| 实施前定向基线通过 | position 45/45、资金 181/181、工具箱 165/165 | 后续失败可归因于本版改动 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 异常旧库是否确为受支持十表且十表全空 | 已知未知 | 高 | 困难 | 已用正式库的隔离副本完成 quick_check、schema、十表 COUNT、升级及重启复核 | RESOLVED | 隔离副本 quick_check、sqlite_master、逐表 COUNT | 确认为受支持十表全空；升级后业务表仍为 0，checkpoint 正确 |
| 两条问题样本按新规则的最终逐笔结果 | 已知未知 | 高 | 一般 | 已只读定位真实银行行及调拨来源，并按最终 R3.5 规则回放 | RESOLVED | 用真实/脱敏账单回放并逐笔签字 | 两条 Credit/Inbound 均保持原值，零改写并产生严格 Debit 失败告警 |
| canonical owner 缺失/重复/伪内置冲突的历史库形态 | 盲区 | 高 | 一般 | repository 当前允许相关旁路 | PROBE | 构造 0/1/>1 和 bundle/IPC fixtures | resolver 与迁移均 fail-closed |
| 方向 validator 重构是否改变 R4 warning | 兼容风险 | 高 | 容易 | 现有 R4 单测覆盖主要行为 | PROBE | warning code/数量/reason/matchedPairs golden | golden 不一致即回滚适配层 |
| v3.1.2 `.xls` 样式能力 | 后续版本未知 | 高 | 一般 | 尚未执行 probe | BLOCK（仅 3.1.2） | 下一版本第一步 fixture probe | 本版停止探查和实现 |

## 保守假设

- internal engine 兼容旧扁平日期参数仅供既有调用/测试；生产主流程必须显式注入 resolved policy。
- owner 缺失时 R3.5 使用 `enabled=true/toleranceDays=1` 并告警，R5s2 不执行；该回退不是长期正常态。
- 旧侧库出现未登记表、视图、触发器、非空表或结构差异时一律阻断，不自动“尽量迁移”。

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 空旧库 proof + fixture | 不接管任何含历史或未知结构的库 | 成功/阻断矩阵全过 | 推翻兼容实现 | 收缩为继续全部阻断 |
| 2 | 共享方向 validator + 引擎候选 | 借贷方向不污染候选和消费 | 矩阵与相反方向红线测试 | 阻塞所有资金后续 | 回滚到共享函数前，不放宽条件 |
| 3 | canonical owner/resolver/迁移 | 日期策略唯一、可恢复、不可伪造 | 0/1/>1、CRUD/bundle 旁路测试 | 阻塞主流程接线 | owner 缺失默认+告警、R5 no-op |
| 4 | run/export 快照与错误报告 | disabled policy 变化使旧结果失效 | run/export 集成测试 | 旧结果可能按陈旧策略导出 | 拒绝导出并要求重跑 |
| 5 | UI、文档与发布检查 | 用户可配置且版本可追溯 | UI 契约、三文档、release-check | 不能发布 | 保留分支，不进入发布 |
