# v3.1.3 Tasks

## PR-A — Characterization

- [x] 锁定银行 46/49、XLS、sheet、物理行和 cell 类型契约。
- [x] 锁定五类来源的重复、冲突、过滤、错误首因和结果顺序。
- [x] 锁定 0/隐藏/可见/双腿派生及数据库 JSON、revision、checkpoint。
- [x] 建立 parity、fault、benchmark 和 fixture 脚本骨架。

## PR-B — Preflight Engine

- [x] 流式 XLSX workbook/sheet reader 和 SheetJS parity decoder。
- [x] 内存/磁盘 shared strings provider。
- [x] 异步 staging/hash、按 `row_hash` 折叠完全重复行的 job ledger、封存和验证。
- [x] utilityProcess dispatcher、进度和基础取消。

## PR-C1 — Mutation And Recovery

- [x] Store/worker 共用 side DB mutation helper。
- [x] archive intent durable 后才允许 apply。
- [x] `row_hash` 来源身份迁移、消费血缘回填、现代索引和 schema fingerprint。
- [x] 普通来源 worker exit 后按 checkpoint/history/input proof 恢复。
- [x] bank/account 专用恢复未接入前明确 fail closed，禁止误套普通来源算法。

## PR-C2 — Gateway Outbound

- [x] 单记录派生 API 和增量 source/link writer。
- [x] 接入 gateway-outbound feature gate。
- [x] 现代全局身份 schema 下保持其余旧小文件来源写入路径可用。
- [x] 回放真实 1,339,185 行和部分提交故障。

## PR-D — Remaining Sources And Maintenance

- [x] 接入 gateway-inbound、fund-transfer、test-payment。
- [x] 流式来源删除、银行删除和 FundTransfer 映射重建。

## PR-E — Bank, Account, UI And Release

- [x] 银行 prepare/apply 和账户混合确认流程。
- [x] SQL scope 计数、磁盘门禁、进度/取消弹窗和 previews。
- [x] 300 万 bank/inbound/outbound macOS 压测及证据固化。
- [ ] Windows 安装版导入、取消和文件锁手测。
- [x] 版本号、三份版本文档和重要变量清单更新。
- [ ] 真实资金范围替换、派生和账户数据人工逐笔复核。

## 正式收尾

- [x] PR #110 以 merge commit `4bb08b54676c9dd826d48c63ec6f7b4f6acf96f1` 合入 `main`。
- [x] 建立 `docs/prs/PR110-v3.1.3.md` 和 `docs/iterations/v3.1.3/PRD-v3.1.3.md`。
- [x] 合并后重新执行 Node 22 发布门禁、parity、fault、布局、启动性能和变量检查。
- [x] 记录 macOS 历史时区导致的 SheetJS 测试夹具偏移，且不改变既有业务日期契约。
- [ ] 提交并合并 v3.1.3 发布准备 PR。

## 发布收尾

- [ ] 创建并推送 annotated tag `v3.1.3`，且 tag 必须指向当时最新 `main`。
- [ ] 等待 Windows Release workflow 全部通过。
- [ ] 验证 GitHub Release 为 stable/latest 且恰有 Setup、Setup blockmap、portable、`latest.yml` 四个资产。
- [ ] 下载并回读发布资产，核对 PE 头、文件大小、SHA-256、`latest.yml` 的 SHA-512 和版本引用。
- [ ] 回写发布 run、资产摘要和最终状态，提交并合并发布证据 PR。
- [ ] 同步本地 `main`，删除收尾分支并确认 tracked worktree 干净。

## 发布后人工跟进

- [ ] Windows 安装版完成真实导入、取消和文件锁手测。
- [ ] 使用真实或脱敏资金数据逐笔核对范围替换、链接派生、账户数据、严格 1:1 和存档证据。
- [ ] 使用上一 stable 完成 `v3.1.2 → v3.1.3` 在线升级 canary，并核对 SQLite、设置和导出文件保留。
