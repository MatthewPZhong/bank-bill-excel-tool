# v3.1.3 Test Spec

完整验收矩阵以 [spec.md](./spec.md) 第 16、17 节为准。

## Required Gates

1. `npm run test:position-import:parity`
2. `npm run test:position-import:faults`
3. `npm run test:unit`
4. `npm run test:integration`
5. `npm run smoke`
6. `npm run release-check`
7. `npm run scan:vars`
8. `npm run check:vars -- --include-minor`

## Release Evidence

- 真实五文件：1,339,185 扫描行；同业务单号不同内容全部保留，完全相同记录按 `row_hash` 折叠；文件级 generation/history/input proof 与成功文件一一对应。
- 容量：bank、gateway-inbound、gateway-outbound 各不少于 3,000,000 行。
- 内存：main RSS 增量目标不超过 150 MiB，worker RSS 目标不超过 1 GiB。
- 故障：OOM、SIGKILL、未捕获异常、取消、磁盘不足、DB busy/full、ledger 损坏。
- 兼容：除用户明确变更的来源重复口径外，旧 reader 的 JS 值、类型、日期、hash、DB JSON、物理行号和错误首因等价。
- 身份迁移：旧业务主键唯一库原子迁移为 `row_hash` 唯一，链接与消费关系完整回填 `sourceRecordKey`。
- 人工：macOS/Windows 各一次真实导入；资金数据范围替换、派生和存档证据人工复核。
