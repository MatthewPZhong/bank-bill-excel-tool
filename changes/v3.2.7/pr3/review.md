# PR3 业务与工程复核

| 边界 | 证据 / 结论 |
| --- | --- |
| 缺日与指纹 | Main 预检及目录事务双重完整检查；缺失全部日期一次返回，未创建 Task；中间 OP / 区间外 FLOW 不进指纹 |
| 金额与身份 | 17 组批准样例经真实 XLSX 到固定 19 列；精确大数、0.01 边界、账号大小写/前导零、CNY/CNH、UTF-8 排序均测试 |
| 描述与行守恒 | 同一键 5000 条/端倒序候选集合仍不误判变化；全部 OP 源行写说明；NULL/空合并为空候选；8000 UTF-16 分段不截代理对 |
| Main/worker 边界 | 固定小计划、真实 no-file Task、单 admitted worker；行不回传 Main，三种数据库最多各一连接；Main 校验实际退出、清单、身份及行数 |
| 发布及历史 | 目录提交一次占版本；输入覆盖/回收不改变已封存 19 列及说明；RESULT holds 独立保留所有原件 |
| 失败和重试 | 实际开始 SQLite 写入后取消；提交前/后独立 Main 进程退出，原 Task 和 receipt 恢复；失败未占版本，已删除 run 重算新版本，不复活旧结果 |
| 资源 | 临时 SQLite 分组、磁盘描述集合、有界 JSONL 中转；30 万输入的分散/极端单键各有实测，目标 2200 万输入未执行 |
| 兼容性 | 旧未标类型 manifest 沿用旧计数语义；共享 StartupRecoveryCoordinator / financial-decimal 未修改；生产仍关闭 |

## check-vars 关联功能

- 自动命中 `readRows`，核实为本模块局部行数统计，不是 registry 中共享 readers.js 的读取接口。已按“签名变化要同步 main.js orchestration”“输出列变化要同步 writers.js 的格式化规则”复查；共享接口/旧输出不变。
- 自动命中 `state`，核实为局部 writer 状态/SQL 字段，不是 renderer 全局 state；页面状态未改。
- 人工补充实际 Risk-sensitive 依赖 `financial-decimal`。规则“运算只能走共享字符串/BigInt helper，不得使用 JS 浮点加减比较”已满足；没有 SQL SUM/REAL 金额聚合。SQL MAX 只用于描述集合的布尔存在性。旧退款模块未改，完整单元及退款集成 258/258 通过。
- `RESULT_SCHEMA_VERSION` 跨结果 schema、候选生成及 Main 校验，是后续升格候选；本 PR 不修改重要变量登记表。

E01—E03 已经用户批准。本次合成回归证明实现符合这些规则，不替代真实资金人工复核、Windows 与 Excel/WPS 验收。没有访问或修改真实业务文件及用户数据库。
