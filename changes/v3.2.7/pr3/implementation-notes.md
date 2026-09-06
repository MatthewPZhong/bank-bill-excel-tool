# PR3 实施记录

## Decisions

- 复用 PR2 T01 临时 SQLite 方案，不重新比较归并框架。
- E03 具体 19 列样例已批准；核对差额必须为起始减反推终止，不能反号。
- no-file 运行使用真实 `runOperationOnly`，不伪造空 FilePlan/batch。
- 大描述组以磁盘 distinct/有序查询处理，所有 OP 源行和候选值逐行固定到结果说明。

## Unknowns Register

| 项目 | 分类 | 处置/证据 |
| --- | --- | --- |
| 完整输入和指纹是否与 Main 提交同一清单 | PROBE | 读取现有 commitRun，实施前确认缺日、来源及版本规则；新增真实链测试 |
| RESULT 与 NOTES 分片计数和历史独立性 | PROBE | 新分片类型显式区分，保留旧 manifest；源输入回收后回读结果验证 |
| 同端描述巨大组 | PROBE | 磁盘索引 + 有序集合比较，测试单键高基数与来源行守恒 |
| 真实取消/反馈丢失/原 Task 恢复 | PROBE | 运行阶段及目录提交后故障注入，等待真实关闭和 E5 driver |
| Windows 与目标规模/人工样例 | OPEN | 单独保留，不将小样本或 CI SKIP 视为发布通过 |

## Evidence / Deviations

- PR233 评审修复：将计算的最后一次取消检查落实在 PR3 的 `commitRun` 前；通过真实 Archive、TaskLifecycle、native worker 和候选 manifest 核验，验证异步核验期间取消不提交、提交后取消保留成功。Electron 两个计算测试文件共 32 PASS / 0 FAIL / 0 SKIP，包含新增的两个提交边界测试。后台平台恢复接口未修改。

实施中持续记录；原 E5 包不改动。所有资源、测试与未执行项在 validation.md 记录，不沿用历史成绩。

- 实际 17 个样例已通过完整 XLSX → 公共 writer → 固定输入 → 临时 SQLite → 19 列比对。首轮发现缺端原因英文代码与批准样例命名不同，已对齐；金额和 19 列显示不变。
- 为保持单输出连接，按 spec 新增有界临时结果 JSONL，说明先写完再生成结果 SQLite；单键描述集合仍在 SQLite，未使用无界 JS Set。
- RESULT manifest 新分片类型区分业务行与说明行，旧未标类型合同继续有效；Main 和 worker 均检查数量和输入摘要。
- 提交入口补完整逐日检查。PR1b 的人工目录夹具原来只有两端 OP，现补必需 FLOW，保留/释放原件预期数相应从 2/1 调整为 3/2；未降低校验。
- PR1b Windows 同名文档重试 fsync 句柄修复已通过 28 项并提交 `638d24dd`；PR2 合并为 `f73d864d`，PR3 基线随之前移，既有业务差异保留。

- 交叉复核已批准 E02 后，将 General 数值日期拒绝及 YYYYMMDD 文本支持放回 PR2 `bf196156`，随后同步到 PR3；最终完整单元及 Electron 专项包含此补充。
- 说明片段严格采用 E5 的 8000 UTF-16 单元，长文本在代理对边界切分并能按片段原样重建。
- 实际主进程在提交前/后退出，原 Task、receipt、候选和版本均由原 E5 driver 收敛；无新增恢复平台接口。
