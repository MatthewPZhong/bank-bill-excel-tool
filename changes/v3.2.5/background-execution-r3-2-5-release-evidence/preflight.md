# v3.2.5 R3.2.5 Release Evidence Preflight

## Goal / Context / Constraints / Done when

- **Goal**：在 E13-A～G 最终 head 上形成 54-action 逐项 release evidence，收口 `3.2.5` package 元数据与三份发布文档。
- **Context**：精确 base 为 E13-G `0a07cca0261baebe6c664f51e2271126fd639d8a`；E13-G 已证明 54 actions、61 legacy pairs、324/324 surfaces、36 implemented、16 legacy-only、2 platform canaries，production enabled=0。
- **Constraints**：不修改业务 SQL、排序、金额/币种、Workbook、事务、幂等、取消、恢复或进程拓扑；不切 production；不删除 legacy seam；不合并 main、不创建 tag。按用户要求不运行 `release-check`、`check-vars` 或 `scan:vars`。
- **Done when**：每个 action 都有 baseline fixture、语义/DB/Workbook/故障/资源、Windows、人工复核和 production decision；package/lock/docs 一致；validator、定向与适当完整测试通过；未执行项如实保留 `NOT_RUN` / `PENDING_HUMAN_REVIEW`。

## Unknowns Register

| 未知 | 分类 | 证据/处理 | 结论 |
| --- | --- | --- | --- |
| 54 个 action 是否都能唯一归属当前或历史证据 | PROBE | 对 E13-G Inventory 与 R3.2.1～R3.2.4 snapshot、E13-A～F action set 做集合并/交校验 | validator 必须要求 54 个唯一 assignment，缺失、重复或额外 action 均失败。 |
| 模块级 PASS 是否足以满足 R3.2.5 | BLOCK | TechDoc §10 明确禁止模块级结果代偿单 action | evidence 必须逐 action 展开，并保留 action-specific refs。 |
| Windows、真实样本、Excel/WPS、RSS 和观察窗口能否在本机完成 | BLOCK（production） | 当前没有 Windows packaged/真实业务样本与人工签字 authority | 如实写 `NOT_RUN` / `PENDING_HUMAN_REVIEW`；阻止 production，不阻止 dormant capability 合并。 |
| release-check/check-vars/scan:vars 能否用于本节点 | BLOCK（命令） | 用户明确禁止 | 只记录 `SKIPPED_USER_INSTRUCTION`，不得声明 PASS；用允许的单独 lint/unit/integration/smoke 与专用 validator 取证。 |
| 历史 action 是否需要在 v3.2.5 重做业务算法验证 | ASSUME（低风险） | v3.2.5 不修改其业务实现；各版本 exact R3 evidence 仍在树中，E13-G 重新核对当前静态覆盖 | 引用历史逐 action evidence，同时由当前全仓回归发现兼容漂移；不伪造新 Windows/人工结论。 |

## Risk-first Plan

1. 先锁定 54-action authority 与唯一 evidence assignment。
2. 再生成逐 action evidence，所有 effective strategy 固定 legacy/0/false。
3. 用 mutants 拒绝 action 缺失/额外、生产启用、Windows/人工/观察伪 PASS 和 evidence ref 缺失。
4. 同步版本元数据与三份发布文档，检查禁止性声明。
5. 最后运行专用 validator、定向测试与允许的完整回归，做 blindspot/reconciliation 复核。

## Human Red Line

⚠️ 本节点只证明 dormant capability、静态 coverage 与本地自动回归。真实金额/币种/行序/Workbook、Windows packaged、进程终止、unknown/partial/committed-result-lost 与 Recovery Hold 处置仍须资金与恢复负责人人工复核；任何自动 PASS 都不得关闭这些门禁。
