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
- 全局 schema 兼容：只启用 gateway-outbound streaming 后，尚未切换的
  gateway-inbound、fund-transfer、test-payment 旧小文件导入仍可在现代身份 schema
  上安全写入，不得触发旧 business-key conflict SQL 或丢失 `sourceRecordKey`。
- 混合门禁：同次选择 gateway-outbound 与未开放普通来源时，前者由流式 writer 提交，
  后者复用同一暂存证据走旧小文件路径；两类文件各自只有一条 input proof。
- 双层白名单：配置层和 worker apply 层均只能开放 gateway-outbound；直接请求
  gateway-inbound、fund-transfer 或 test-payment 必须 fail closed，且业务行、input proof
  和 checkpoint 均不得变化。
- Apply 防碰撞：ledger 与连接级磁盘 TEMP 表同时校验 SHA-256 row hash、独立 SHA-512
  guard、业务主键及首次物理位置。
- 人工：macOS/Windows 各一次真实导入；资金数据范围替换、派生和存档证据人工复核。

## PR-C2 Evidence

- 真实五文件生产写入：5/5 `ok`，共 1,339,185 条来源和 1,339,185 条链接，
  1,339,185 个不同 `sourceRecordKey`，完全重复折叠 0 条。
- 文件级事务证据：5 条 operation input proof，checkpoint generation 从 0 推进至 5，
  `PRAGMA quick_check=ok`。
- 资源证据：总耗时 799,570 ms；main RSS 峰值 94,355,456 B；worker RSS 峰值
  832,225,280 B；worker heap 峰值 80,569,272 B；低于 1 GiB 门槛。
- 重复业务主键实证：`PD260113144304369391944` 的不同规范内容拥有不同
  `row_hash`；第 4 份文件的 `Yeepay_CN` 与 `Yeepay` 两条均落库并独立派生。
- 部分提交故障：文件 A commit、文件 B 暂存字节变化时，仅 A 保留业务数据、
  input proof 和 generation，B 回滚并返回失败。
