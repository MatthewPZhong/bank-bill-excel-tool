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
- 普通来源门禁：`fund-transfer`、`test-payment`、`gateway-inbound`、
  `gateway-outbound` 均使用现代身份流式 writer；代码级和 worker apply 层继续拒绝
  `bank-account` 或未知来源。
- 配置缩小兼容：显式只开放部分普通来源时，未开放的小文件仍可复用同一暂存证据走
  现代 schema 兼容旧路径；两类文件各自只有一条 input proof。
- 派生 parity：四类普通来源覆盖 0、hidden、visible 和 FundTransfer 双腿，并校验
  `source_row_id/leg_index/id` 顺序、`sourceRecordKey` 和 checkpoint。
- 维护作业：来源删除、银行删除和 FundTransfer 映射重建在 utilityProcess 中分批执行；
  任一取消/异常整体回滚，0 行来源删除仍推进 revision，0 行银行删除不推进 checkpoint。
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

## PR-D Evidence

- 四类普通来源流式 writer 定向用例通过；8 条来源派生为 8 条链接，覆盖 2 条可见
  FundTransfer 腿、2 条隐藏 FundTransfer 腿、来源零派生及入账隐藏证据。
- 来源/银行删除与 FundTransfer 映射重建 3/3 定向用例通过；覆盖批大小 1 的多批事务、
  FK cascade、实际 scope revision、空结果及重建中途取消回滚。
- Service → dispatcher → utility worker → side DB → 主进程 checkpoint 同步链路通过。

## PR-E Evidence

- 银行 prepare/apply 覆盖多文件单事务、scope 原子替换、跨 scope BizId 冲突回滚、
  49→46 列投影、文件/物理行顺序、operation input proof 和 COMMIT 后 worker exit 恢复。
- 清结算银行账户表覆盖与普通来源混选、独立确认、仅状态正常、完全相同物理行分别保留、
  来源/链接行守恒、旧快照保护和 COMMIT 后 worker exit 恢复。
- 管理查询覆盖 300 万行 scope/date/status 聚合及 covering index；状态页和数据管理页复用
  同一 snapshot，不调用明细读取。
- 来源管理摘要缓存覆盖导入、删除、账户替换和映射重建的事务内刷新；缓存损坏时回退事实表，
  不得显示伪 0 行。
- UI 覆盖扫描/接受/提交/耗时、协作取消、停止中和提交不可取消状态；另覆盖 main/worker
  阶段竞态时 `accepted=false`、清除强制终止计时器并恢复提交状态。
- 磁盘门禁覆盖导入与维护写事务；空间不足或无法确认空间时必须在删除旧银行范围、来源、
  账户映射或链接派生前失败关闭，并证明 generation 与旧数据不变。
- dispatcher heartbeat 必须保持阶段和三项计数原值；耗时和最大静默使用 monotonic clock，
  不受测试机墙上时间跳变影响。
- 暂存生命周期覆盖授权前取消、授权拒绝、重复预检、启动消息失败、零提交退出和部分提交恢复；
  outbox、主库 pending 或活动账户 token 任一仍引用共享 job root 时不得删除，保护解除后才回收。
- 所有百万级暂存删除均为异步；零提交重启恢复会把全部未提交输入交给受保护清理，不等待
  7 天过期任务。
- 最终容量证据写入 `changes/3.1.3/evidence/`：
  - `bank-3m-macos.json`：3,000,000 bank rows，main RSS 增量
    8,323,072 B，worker RSS 峰值 641,040,384 B，最长静默 1,419ms，
    status/data-manager P95 254.80/253.75ms。
  - `gateway-inbound-3m-macos.json`：3,000,000 source + 3,000,000 link，
    main RSS 增量 8,552,448 B，worker RSS 峰值 870,514,688 B，最长静默
    1,977ms，三类管理查询 P95 均低于 1ms。
  - `gateway-outbound-3m-macos.json`：3,000,000 source + 3,000,000 link，
    main RSS 增量 8,388,608 B，worker RSS 峰值 924,991,488 B，最长静默
    1,481ms，三类管理查询 P95 均低于 1ms。
- 三份证据均为 `status=success`、3/3 input proof、`quick_check=ok`，且来源证据各有
  3,000,000 个 distinct `sourceRecordKey`。
- Windows 实机导入/取消、真实资金范围替换和派生逐笔核对仍为人工发布门禁；不得用合成
  benchmark 或 macOS 自动化替代。
