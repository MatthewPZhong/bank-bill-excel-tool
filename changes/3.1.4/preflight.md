# v3.1.4 Preflight — 来源异常行自动过滤

## Goal / Context / Constraints / Done when

- Goal：仅对 `fund-transfer`、`test-payment` 的白名单证据缺失行自动过滤，正常行继续按文件原子落库，并留下可验证的异常报告、过滤墓碑和运行快照。
- Context：3.1.3 已使用流式两遍读取、sealed ledger、主库归档 pending、侧库 checkpoint 和逐文件事务；生产入口固定为 streaming engine。
- Constraints：不改匹配算法、金额币种方向、严格 1:1、`row_hash/sourceRecordKey` 身份；失败不得产生部分文件提交；真实文件和现有用户侧库只读。
- Done when：Spec 第 11 节自动化、六份真实文件回放、`release-check`、`check-vars` 与资金人工复核门禁全部有证据。

## Unknowns Register

| ID | Priority | Unknown | Why it matters | Evidence / probe | Resolution |
|---|---|---|---|---|---|
| U1 | BLOCK | 异常报告如何在侧库提交前形成可靠归档意图 | 报告丢失会破坏过滤审计链 | `operation-lifecycle.js` 的 apply grant 已在 side DB mutation 前持久化 input manifest；archive tracker 支持同批次 input/output | 报告在 worker 预检后生成并哈希，写入 sealed ledger；授权时把 input + report output 一并登记后再 apply |
| U2 | BLOCK | 跨文件正常行/过滤行业务键碰撞如何消除选择顺序影响 | 顺序相关会造成同批次结果不确定 | 当前 ledger 以文件 savepoint 记录 owner，释放后不能直接回滚早先文件 | 碰撞只拒绝含过滤记录的文件；若碰撞指向已预检文件，丢弃并重建 ledger，第二遍固定跳过这些文件 |
| U3 | BLOCK | 同业务键已有合法记录时是否删除旧数据 | 误删会直接改变候选和资金结果 | 3.1.3 真实数据证明一个业务键可有多条合法 `row_hash` | 禁止删除；过滤文件返回 `position-filtered-key-collision`，正常导入仅解除墓碑 |
| U4 | PROBE | 过滤明细完整原文存在哪里 | 侧库长期保存 raw JSON 会放大数据库和隐私面 | 存档中心支持内容寻址 blob；Spec 要求墓碑轻量 | 完整原文只在不可变 xlsx；ledger 临时保存过滤行 raw JSON，提交后侧库仅保存行引用、键、哈希和报告引用 |
| U5 | PROBE | 存档 artifact ID 在何时可用 | worker 提交发生在 archive copy 之前 | archive batch 可按 `moduleId + operationKey` 查询，artifact 可按 key 查询 | 墓碑冻结 operation key、artifact key、报告 SHA/size；运行时从存档解析，暂存未清理时可作受哈希校验的恢复来源 |
| U6 | PROBE | 全量过滤如何区别普通来源缺失 | 错误提示和运行门禁不同 | 运行已知必要 source types 和月份；墓碑有 month key | 先按月份查活动墓碑与有效来源行；有墓碑且有效行为 0 返回 `position-source-all-filtered` |
| U7 | ASSUME | 活动墓碑关联的存档批次解锁策略 | 自动解锁需要跨库引用计数 | Spec 只要求活动墓碑/pending run 期间不可清理 | 3.1.4 异常报告批次创建时锁定；自动解锁不作为本期成功条件，保守保留审计证据 |
| U8 | BLOCK | 六份样本是否都应成功 | 验收结论会影响白名单边界 | 只读回放发现第三份调拨文件另有“付款成功但付款金额为空”硬错误 | 不扩大白名单；该文件仍整文件拒绝，作为成功调拨缺证据的负向验收样本 |

## Risk-prioritized plan

1. 先用纯函数测试锁定白名单、硬错误和行去向互斥。
2. 扩展 ledger，证明行数守恒、过滤明细完整、跨文件碰撞无顺序依赖。
3. 在 side DB 增加墓碑与 run 关联表，并在同一文件 mutation 中写入/解除。
4. 把报告生成、哈希、归档意图接到 apply grant 前。
5. 冻结运行过滤快照，加入全量过滤阻断、结果页导出和确认完整性门禁。
6. 最后接 UI/IPC、版本文档与全量发布门禁。

## Human decision gate

这是资金红线改动。发布前必须人工确认测试付款 404/429 行的过滤业务语义，以及第三份调拨样本继续失败符合预期；实现和自动化测试不能替代该确认。
