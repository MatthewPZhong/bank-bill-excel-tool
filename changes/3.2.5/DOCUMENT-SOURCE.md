# v3.2.5 Document Source

- 权威来源：`changes/background-execution-v3.2.x-contract-baseline/changes/3.2.5/`。
- Bootstrap 时顶层 `spec.md` 与 `techdoc.md` 必须与上述冻结来源逐字节一致；该同步由提交
  `5913a59628ece1abde8640846cc9c726567c64ea` 完成。
- 冻结 SHA-256：Spec `13410e4e5cf64798255cab30dd2487d4da4323eddf59d44cf2a0653e950898f2`；TechDoc `3fb1845979823f2c39a8e26d9d5adc5d7f3e351fda90d2f4086d6c355d17e64f`。
- 实施期经 current-tree 证据证明冻结 topology/authority 已失实时，只允许按
  [implementation-notes.md](./implementation-notes.md) 的 Decisions/Deviations 反向同步顶层当前合同；
  冻结来源本身保持不可变。最终当前 SHA-256：Spec
  `d223b7ad422b904e2af573f99ae35f2a169c2a27cdc8dbbf8cc2431227c1244f`；TechDoc
  `f63e12205e67c3a483c20d4d85940b2bc494113c730d96cbd3ac749ca8c19933`。
- 因此最终顶层文档是 current authority，不得再声称与冻结来源逐字节一致；任何未在
  implementation notes 中记录、未受测试约束的额外漂移仍必须失败。
- 实施顺序来源：冻结 Spec §10 与 `changes/background-execution-v3.2.x-contract-baseline/changes/background-execution/v3.2.x-version-split-plan.md`，后者 SHA-256 为 `27bbdde9beca98a6abbdc9902016e319c98e52775b46c3727014d628ba6f174a`。
- 顶层文档同步不改写业务 SQL、排序、金额/币种、Workbook、事务、幂等、取消、恢复、进程拓扑、资金人工红线或 production enablement。
