# v3.1.3 Tasks

## PR-A — Characterization

- [x] 锁定银行 46/49、XLS、sheet、物理行和 cell 类型契约。
- [x] 锁定五类来源的重复、冲突、过滤、错误首因和结果顺序。
- [x] 锁定 0/隐藏/可见/双腿派生及数据库 JSON、revision、checkpoint。
- [x] 建立 parity、fault、benchmark 和 fixture 脚本骨架。

## PR-B — Preflight Engine

- [ ] 流式 XLSX workbook/sheet reader 和 SheetJS parity decoder。
- [ ] 内存/磁盘 shared strings provider。
- [ ] 异步 staging/hash、job ledger、封存和验证。
- [ ] utilityProcess dispatcher、进度和基础取消。

## PR-C1 — Mutation And Recovery

- [ ] Store/worker 共用 side DB mutation helper。
- [ ] archive intent durable 后才允许 apply。
- [ ] 现代索引、schema fingerprint 和重复阻断。
- [ ] worker exit 后按 checkpoint/history/input proof 恢复。

## PR-C2 — Gateway Outbound

- [ ] 单记录派生 API 和增量 source/link writer。
- [ ] 接入 gateway-outbound feature gate。
- [ ] 回放真实 1,339,185 行和部分提交故障。

## PR-D — Remaining Sources And Maintenance

- [ ] 接入 gateway-inbound、fund-transfer、test-payment。
- [ ] 流式来源删除、银行删除和 FundTransfer 映射重建。

## PR-E — Bank, Account, UI And Release

- [ ] 银行 prepare/apply 和账户混合确认流程。
- [ ] SQL scope 计数、磁盘门禁、进度/取消弹窗和 previews。
- [ ] 300 万 bank/inbound/outbound 压测及 macOS/Windows 手测。
- [ ] 版本号、三份版本文档、重要变量检查和人工资金复核。
