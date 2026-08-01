# bank-bill-excel-tool 3.1.3 PRD

> 目标版本：`3.1.3`
> 状态：released（`v3.1.3` Windows Release 已发布；人工资金与 Windows 实机验收待完成）
> 源规格：`changes/3.1.3/spec.md`
> 交付归档：`docs/prs/PR110-v3.1.3.md`
> 更新时间：2026-08-01

## 1. 版本目标

把平盘银行对账单和五类链接原始表的导入、范围管理、删除及调拨链接重建，
从 Electron 主进程的整批物化改为独立 utility process 中的流式解析、增量写库和
可恢复事务，解决百万级 Excel 直接耗尽主进程内存的问题。

本版只承诺百万级数据的导入、管理、删除和链接派生重建，不承诺 300 万行资金性质
校验运行或单个 Excel 文件导出。

## 2. 交付范围

1. 银行 46/49 列、调拨、测试付款、网关入账、网关出账和清结算银行账户表均可在
   后台逐行读取，不把完整 workbook、明细、主键或派生集合返回主进程。
2. 银行继续按所选文件整批原子替换；普通来源先完成整批预检，再按文件独立事务提交；
   账户快照仍由用户确认后整表替换。
3. 普通来源内部身份改为规范完整行 `row_hash/sourceRecordKey`：完全相同记录折叠，
   同业务主键不同内容全部保留并可独立派生、匹配和消费。
4. 来源记录写入时同步增量派生链接行，保留零派生、隐藏行、可见行、FundTransfer
   双腿及既有稳定顺序。
5. 银行范围/状态使用覆盖索引聚合 snapshot；来源摘要使用事务内缓存，损坏时回退
   事实表；银行/来源删除和调拨账户映射重建改为后台分批作业。
6. 导入弹窗展示文件、扫描、接受、提交和耗时；提交前支持取消，提交阶段拒绝虚假取消；
   worker 异常退出后按 checkpoint、history 和 input proof 恢复。
7. 磁盘空间、staging、ledger、hash、schema、checkpoint 或恢复证据无法证明一致时
   失败关闭，不自动退回主进程旧全量 reader。

## 3. 保持不变的业务契约

- 不修改平盘 FundType 匹配算法、来源业务字段、状态过滤、金额、币种、日期和 49 列结果。
- 不修改结果回导、确认、差异和跨已确认运行的严格 1:1 消费语义。
- 主库继续只保存轻量 checkpoint/pending 信息；百万级明细保存在独立平盘 side DB。
- 备份和恢复必须把 `tool-data.sqlite` 与 `run-data/` 作为同一批次处理。
- 新引擎失败后不得自动回退到 Electron main 的 `XLSX.readFile`。

## 4. 容量与恢复证据

| 范围 | 行数与完整性 | 资源结果 |
| --- | --- | --- |
| 平盘银行 | 3,000,000 行；3/3 input proof；`quick_check=ok` | main RSS 增量 8,323,072 B；worker 峰值 641,040,384 B；最长静默 1,419ms |
| 网关入账 | 3,000,000 source + 3,000,000 link；3,000,000 个 sourceRecordKey；`quick_check=ok` | main 增量 8,552,448 B；worker 峰值 870,514,688 B；最长静默 1,977ms |
| 网关出账 | 3,000,000 source + 3,000,000 link；3,000,000 个 sourceRecordKey；`quick_check=ok` | main 增量 8,388,608 B；worker 峰值 924,991,488 B；最长静默 1,481ms |

真实五文件网关出账共 1,339,185 行，5/5 文件提交成功，来源、链接、
`sourceRecordKey` 和 input proof 守恒；同业务单号 `PD260113144304369391944`
的 `Yeepay_CN`、`Yeepay` 不同记录均保留。

## 5. 自动化与合并

- PR #110 于 2026-08-01 以 merge commit
  `4bb08b54676c9dd826d48c63ec6f7b4f6acf96f1` 合入 `main`。
- 合并后 Node 22 发布门禁：parity `54/54`、fault `50/50`、unit `4454/4454`、
  44 个 integration 脚本 `2051/2051`，lint 与 smoke 全绿。
- 主页面两种尺寸、三种缩放共 `6/6 PASS`；启动 ready-to-show 平均
  `194.527ms`，建窗到可见平均 `92.246ms`。
- 变量扫描为 261 个文件、3283 个顶层名称；发布准备未修改 `src`，重要变量硬节点安全跳过。
- 生产依赖审计为 7 high、2 moderate、0 critical；本次不静默升级依赖。

## 6. 发布与人工门禁

- 首次 Windows run `30673001316` 在 release-check 阶段因测试路径规范化和 SQLite
  teardown 顺序失败，未执行构建或发布，也未创建同名 Release 或资产。
- 测试热修 PR #112 以 merge commit
  `6c5339f33e02b8833da6d5111cdc8710f61b6250` 合入 `main`；最终 annotated tag
  `v3.1.3` 指向同一提交。
- 最终 Windows Release workflow
  [run 30674305362](https://github.com/MatthewPZhong/bank-bill-excel-tool/actions/runs/30674305362)
  全绿：unit 4453 PASS、1 个 macOS-only SKIP、0 FAIL，integration 2051/2051 PASS
  （44 个脚本），tag/main、主页面对齐、构建、包检查、资产校验、不可变发布和发布后验证
  全部成功。
- [GitHub Release v3.1.3](https://github.com/MatthewPZhong/bank-bill-excel-tool/releases/tag/v3.1.3)
  已由 workflow 验证为 stable/latest、non-draft、non-prerelease，并包含 Setup、Setup
  blockmap、portable、`latest.yml` 四项资产。workflow 同时核对 Setup 文件名、版本和
  `latest.yml` SHA-512。
- 当前会话因网络授权额度限制，未再次把公开资产下载到本机执行独立 PE 头、文件大小和
  SHA-256 回读；该证据边界不改变技术发布状态，也不得解释为 Windows 实机验收。
- Windows 安装版真实导入、取消和文件锁手测尚未完成。
- 真实或脱敏资金数据的范围替换、链接派生、账户数据、严格 1:1 和存档证据尚未逐笔确认。
- 上述人工项不阻断技术资产生成，但阻断“人工验收通过”的公告和未复核数据上的业务启用。
