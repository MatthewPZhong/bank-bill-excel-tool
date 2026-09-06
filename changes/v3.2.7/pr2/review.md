# PR2 业务与工程盲区复核

| 边界 | 证据 / 处置 |
| --- | --- |
| 导入入口与后台平台 | Main 私有 planRef 绑定真实 Task；复用原生 thread-single 和原 PR1a 关闭观察；未修改共享恢复核心、Supervisor 或 parser pool |
| 原件与混批覆盖 | 全部 READY+PREPARE 后派发；仅同批完整相同原件去重。真实 A+B、逆序复用、A+B′及重复原件测试通过；后文件坏行保持旧 heads |
| 财务与身份 | 金额从数值 XML 词元/解码文本进入精确十进制，账户字符串前导零保留；0.01 边界精确通过；账户、币种、BU 三个键分别规范，流水单号不设唯一约束 |
| 完整原列 | OP 23 / FLOW 28 列先解释验证；尾列公式/错误也拒绝；非法行不因投影丢弃。样本限额不停止行错误计数 |
| 动态来源与崩溃 | allocation 先于候选文件；真实 Main 在三个日期候选封存后退出，重启没有发布版本并回收全部未提交候选，原 Task 合法失败，报告保持 READY |
| 文件身份与交接 | 大文件核验留在 worker；Main 实际退出后校验摘要与封存身份。退出后修改候选文件的真实反例被拒绝 |
| 取消和关闭 | 观察到真实行写入后才发取消；退出事实确认后收口，部分扫描明确 false，未发布版本；SST 关闭错误保留文件和错误，重复 close 不伪报成功 |
| 公共 writer 事务 | 已存在调用方事务时拒绝 BEGIN、不回滚外层；两块已提交后当前块失败只回滚当前块；COMMIT 反馈丢失不重放且保留原始不确定错误 |
| 内存和磁盘 | 单活跃 reader/写连接，SST 条目与字节双限，候选逐行 INSERT、无 batch[]；10万/100万合成试验有实测证据，未据此宣称目标规模达标 |

## check-vars 关联功能

对比 PR1b `6fdde8c2` 的生产差异（包含未跟踪新增文件），正式命中如下：

- Important-skeleton：`BIZ_OP_HEADERS`、`FLOW_HEADERS`。沿用表中“改顺序/列名 → 表头严格匹配会拒绝旧版文件”“writer / reader / validator 三处必须同步引用本数组”的复核要求。数组定义未修改；新原表识别使用完整原数组，12/9 列投影为新区间单独定义。原业务 OP smoke Case A/E、流水 Case D 随完整 smoke 通过，真实账单回放未运行。
- Risk-sensitive：新调用共享 `financial-decimal`；复用表中“运算只能走共享字符串/BigInt helper，不得使用 JS 浮点加减比较”。共享模块及旧退款规则没有修改；完整单元和 `refund-backfill-yellow-fill-e2e` 258/258 已通过，新的 OP 校验用原词元和精确 0.01 阈值测试。真实业务人工复核仍保留。
- 文本扫描出现 `state`，核实为候选 writer 的局部状态，未触及表中定义于 renderer.js 的全局 `state`，排除同名误报。

升格候选：`CELL_CONTRACT_VERSION` / `RULE_VERSION` 已跨适配、候选封存和 Main 三个生产文件，今后改值会影响接受规则及输入指纹，应在后续规则表维护时评估纳入。当前未改全局重要变量表。

延续 PR1b 对 TaskLifecycle/Archive 的复核：保持 no-file/FilePlan 分类、全部原件一次结算、真实 Task/hold/receipt 所有权、主库元数据边界。PR2 没有修改共享 Archive 表结构、Task 身份清单或旧 BizOP 导入/金额实现。唯一既有共享 reader 改动是可选 SST 字节缓存和 opt-in 严格关闭；旧平盘未传新选项时仍按条目数 LRU，聚焦旧读取与预检回归保留。

人工资金样例、Windows 新功能启用、Excel/WPS 输出与升级迁移仍是后续门禁。这里的 PASS 仅来自合成文件和临时数据库，不作为人工或发布验收。现有目录 fsync 的 Windows unsupported 不能通过放宽提交条件消除；PR6 启用前须单独解决。
