# v3.1.10 Preflight — VCC 存储与异常审计瘦身

## Task Brief

- Goal: 用存档 artifact 作为原始输入长期真相，瘦身 VCC 有效事实/导入审计，并提供显式 copy-on-write 物理迁移。
- Context: 基线 `646bcf4`；当前 VCC 27.42GB 核心表大量重复 `raw_json` 与永久逐行审计；存档中心已有 SHA Blob、重试、TaskLifecycle 和 root maintenance。
- Constraints: 不触碰生产库；不改 CNY 九币种、金额公式、幂等键、业务状态、归档/解归档/调整；不伪造历史血缘；迁移失败保持旧库。
- Done when: Spec 数据/状态合同落地；新导入不永久保存正常审计原始行；artifact/fallback/hold闭环；完整与部分原表导出闭环；迁移守恒与故障矩阵通过；发布候选自动门禁闭合；真实库、Windows packaged 和人工资金复核通过或按 runbook 留下明确豁免证据后才正式发布。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 当前 effective/import_rows 分别约 11.14/16.28GB | 2026-08-16 对生产库只读 `dbstat` | 必须物理重建，单纯 DELETE/ALTER 不会返还文件体积 |
| 存档 artifact 以 Blob SHA-256+size 为完整性真相 | ArchiveRepository/ArchiveService | 原件绑定必须复用 artifact，不建第二份文件库 |
| VCC 原表导出语义是当前有效数据集 | 现有 dataset writer 与用户确认 | 必须按 effective 行从 artifact/fallback重建，不得下载整份输入 |
| 导入 record 的六类计数是业务审计 | repository/importer/calculator gate | 瘦身不得改变计数与 failed resolution 语义 |
| v3.1.9 CNY 九币种已冻结 | `changes/3.1.9/spec.md` §0.2 | 迁移与导出不得恢复 CNH 或改金额 |
| 历史 archive 绑定必须有 flow/record/artifact/SHA 证据 | 用户确认 + archive flow anchors | 文件名相同不能绑定；缺口只能部分导出 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 现有 importer 如何最小改成 staging+anomaly | 代码 ownership | 高 | 一般 | detail/system importer 均直接写旧审计表 | PROBE | 先以 detail 单纵切+真实 SQLite test | staging 为唯一临时全行表，终态清空 |
| 新导入 SHA 在 worker/Archive handoff 的唯一所有权 | 调用边界 | 高 | 一般 | source snapshot 当前仅 stat，Archive staging后才算SHA | PROBE | 跟踪 TaskLifecycle settle payload | VCC读取阶段算 expected SHA；Archive artifact仍复核 |
| business hold 与 batch delete 的粒度 | 数据安全 | 高 | 困难 | Archive 当前批次级删除 | 已确认 | repository delete代表测试 | 任一 artifact 有hold则阻断整个批次删除 |
| 历史精确绑定覆盖率 | 数据质量 | 高 | 困难 | 初估约57.49%，但尚非exact | PROBE | 临时副本运行只读binder报告 | 仅exact绑定；其余unavailable且无fallback |
| 全库copy-on-write时SQLite内部对象复制策略 | 迁移 | 高 | 一般 | AppDatabase单文件+WAL；有generated virtual/temp对象可能性 | PROBE | schema inventory + 合成全库迁移 | 显式排除 sqlite内部对象，逐表复制并验证 |
| 迁移可用磁盘估算 | 环境 | 高 | 容易 | 当时约23GiB空闲，低于安全余量 | BLOCK-at-runtime | statfs+checkpoint后源大小 | 空间不足拒绝开始，不破坏旧库 |
| Windows跨进程原子切换/占用句柄 | 环境 | 高 | 一般 | 本机非Windows | PROBE | Windows installer/portable人工门禁 | 未验证不得发布 |
| 4.3–4.6GB目标是否达成 | 性能/容量 | 中 | 一般 | 代表字段投影约4.186GB+异常约91MB | PROBE | 真实副本迁移后dbstat | 至少下降75%，否则阻断发布或反写偏差 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 冻结 v2 schema/DTO/计数公式 | 避免迁移与运行时双真相 | schema contract tests | 禁止继续编码 | 只改Spec，无数据写入 |
| 2 | detail导入最小纵切 | staging/anomaly/effective/fallback原子性 | 成功/异常/冲突/回滚测试 | 不接system/UI | 回退新纵切 |
| 3 | artifact binding+hold | 文件真相与删除安全 | SHA错/对、retry、manual/retention测试 | 不删除fallback | 保留pending |
| 4 | 导出+UI | 用户可见血缘与异常合同 | 六列Excel/部分说明/完整性失败 | 不开放按钮 | 保留旧接口直至迁移完成 |
| 5 | copy-on-write迁移 | 现有库物理缩小与守恒 | 故障注入+双启动+dbstat | 旧库继续唯一有效 | 删除临时目标，不切换 |
| 6 | 全回归/人工门禁 | 资金与发布风险 | release-check+真实库/Windows/人工清单 | 阻断发布 | 不放宽阈值/守恒 |

## 发布候选收口（2026-08-17）

- 功能 PR #147 已合入 `main@f75af1ed4eb2cd7cead8ffd6562174b2fc24ee6e`；Windows workflow `31993149328` 全绿，最终 reviewer 对 `01d24e5ca9` 未发现新问题。
- 版本化收口只修改版本号、三份发布文档、release baseline、变量统计与3.1.10管理证据；不改 VCC 生产算法、schema、迁移状态机或金额币种合同。
- 真实约27.42GB副本迁移、Windows installer/portable SQLite/WAL与主体×九币种资金人工仍是发布阻断；候选 PR 合并不等于三项通过，也不等于正式 Release。
