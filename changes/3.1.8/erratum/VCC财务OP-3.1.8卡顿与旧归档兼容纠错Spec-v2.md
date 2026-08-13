# VCC 财务 OP v3.1.8 卡顿与旧归档兼容纠错 Spec v2

> document-version: `2.0`<br>
> document-date: `2026-08-10`<br>
> product-contract-owner: `v3.1.8 上线后纠错补遗`<br>
> implementation-release: `v3.1.9`<br>
> baseline: `origin/main@63c1ce46357587643e506768f712352cbb6c7127`<br>
> supersedes: `VCC财务OP-3.1.8卡顿与旧归档兼容纠错Spec.md`<br>
> status: `产品口径已锁定；待仓库内归档和实施`

## 0. 执行摘要

本 Spec 修复 VCC 财务 OP 校验模块在大数据库下的页面卡死，并为 v3.1.7 合法生成的标准四数据集归档提供正式兼容路径。

本次影响高，但集中在 VCC 财务 OP：

| 区域 | 影响 | 最终口径 |
|---|---:|---|
| PR1 批次号与存档表结构 | 低 | 不返工，不新增 schema migration。 |
| PR2 TaskLifecycle | 中 | 复用 BOR、终态 CAS 和七字段 worker context，不改变核心设计。 |
| 原 PR3 VCC 接线 | 高 | 必须在本纠错系列 PR 完成后接线。 |
| 数据兼容与降级 | 高 | 新增 legacy 状态转换；执行 legacy 解归档后不支持降级到 3.1.8 写入。 |
| 发布验收 | 高 | 增加真实 v3.1.7 fixture、目标旧库、约 16 GB 副本、Windows runtime 和财务人工门禁。 |

本 Spec 最重要的产品决定是：

> `archiveContract` 只判断归档结构。活动任务、未处理异常和后续依赖只影响 `canUnarchive`，不得把结构合法的月份判为 `inconsistent`，不得使其从归档枚举或导出入口消失。

## 1. Goal / Context / Constraints / Done when

### 1.1 Goal

- 点击【数据管理】后立即显示弹窗，不再等待数据库重查询完成才挂载。
- 删除目标表选择、修改结果确认、确认归档、解归档和删除执行期间页面保持响应。
- 标准 v3.1.7 四数据集归档可被枚举、导出，并在满足操作门禁时安全解归档。
- 用户继续沿用逐表删除；所有活动业务状态清除后，月份自动从普通月份列表隐藏。
- 保留导入记录、删除审计和操作审计，不物理清理历史证据。

### 1.2 Context

- 线上 v3.1.8 数据库样本约 16 GB，`vcc_fin_op_import_rows` 约 1080 万行，`vcc_fin_op_effective_rows` 约 610 万行。
- 当前归档月份读取逐月构建完整 operation state，并访问 import rows 大表。
- 当前修改结果、确认归档、解归档和删除事务通过前后全事实表 SHA-256 快照保护不可变状态；这是本次需要移除的热路径瓶颈，不是目标方案。
- v3.1.7 只强制四类 dataset；v3.1.8 解归档强制五类，导致旧四表归档形成“不能解归档、也不能删除”的闭环。

### 1.3 Constraints

- 不改变金额、币种、主体、九币种余额、调整公式、跨月期初或五表新计算规则。
- 不伪造 Pending dataset，不把缺少 Pending 解释成 Pending 为零。
- 不新增通用旧归档 fallback、重试、timer、lease、`VACUUM` 或 import rows 大表索引。
- 不在 worker 内执行 migration；schema migration 只属于应用启动阶段。
- 不因 mutation guard 或 runtime 能力缺失而降级为无保护提交。
- 不增加“一键清空月份”“强制解除归档”或“显示旧版数据”入口。
- v3.1.8 已发布二进制和 tag 不重发，实际代码随 v3.1.9 发布。

### 1.4 Done when

- 结构分类和解归档操作门禁完全分离，并有正反例测试。
- 数据管理、确认归档及所有目标操作在约 16 GB 副本上达到本 Spec 性能门禁。
- legacy/current 解归档分别按固定变化预算提交，任一越界都回滚。
- 真实 v3.1.7 生成的 fixture 经当前 migration 后可正确分类和解归档。
- 删除全部活动状态后月份隐藏，但显式审计查询仍可读取历史。
- PR2 生命周期、七字段 worker context、取消终态和批次唯一性无回归。
- Windows 打包 runtime、全量自动化和财务人工复核完成。

## 2. 范围与非目标

### 2.1 本次范围

- 数据管理弹窗首屏异步化。
- 归档月份集合化轻量读取。
- 删除目标一次快照和前端 preview 缓存。
- 修改结果、确认归档、解归档和删除写操作后台化。
- 全表 SHA 保护替换为固定预算 mutation guard。
- 标准 v3.1.7 四数据集归档正式兼容。
- 活动月份派生语义及删除后自动隐藏。
- 与 v3.1.9 TaskLifecycle 的最终接线合同。

### 2.2 非目标

- 不物理删除 import rows、import records、dataset deletion 或 operation audit。
- 不自动缩小 SQLite 文件，不在用户点击路径 checkpoint truncate 或 vacuum。
- 不兼容无法由 v3.1.7 代码证明的非标准旧库形态。
- 不允许 legacy run 在解归档后直接修改或重新归档。
- 不修改结果 Excel 模板、金额精度或导入幂等规则。
- 不把工具箱改动混入 VCC 纠错 PR。

## 3. 已确认产品决策

| ID | 决策 | 最终口径 |
|---|---|---|
| D01 | 结构分类与操作门禁分离 | `archiveContract` 只含结构事实；gate 只控制本次解归档。 |
| D02 | 正式兼容范围 | 仅标准 `legacy-v3.1.7-four-dataset`。 |
| D03 | 枚举与导出 | current/legacy 结构合法即进入；后续月份和未处理异常不得隐藏它。 |
| D04 | 解归档 | 结构合法且全部 gate 通过才允许提交。 |
| D05 | 旧 run 后续行为 | 解归档后可查看、可删除，不可调整、不可归档；真实补齐 Pending 后新运行。 |
| D06 | 历史清理 | 沿用逐表删除；全部活动状态清除后隐藏月份，审计保留。 |
| D07 | UI 兼容提示 | 月份列表不显示“旧版”标签；操作审计记录内部 contract。 |
| D08 | SHA-256 | 保留业务 fingerprint；移除热路径全事实表 SHA 快照。 |
| D09 | 事务保护 | 固定变化预算、protected-table session 和精确后置断言三重保护。 |
| D10 | Worker migration | 读写 worker 均禁止 migration，只做 schema-ready 断言。 |
| D11 | 降级 | 执行 legacy 解归档后不支持 3.1.8 继续写库；恢复仅依赖操作前备份。 |
| D12 | 版本归属 | v3.1.8 Spec 补遗，v3.1.9 代码发布；PR1/PR2 核心不返工。 |

## 4. 归档结构分类合同

### 4.1 分类结果

每个存在归档证据的月份必须且只能得到以下一种结构分类：

| `archiveContract` | 含义 | 可枚举 | 可导出 |
|---|---|---:|---:|
| `current-five-dataset` | 满足 v3.1.8 五数据集归档合同 | 是 | 是 |
| `legacy-v3.1.7-four-dataset` | 满足标准 v3.1.7 四数据集归档合同 | 是 | 是 |
| `inconsistent` | 结构损坏、来源不明或证据不足 | 否 | 否 |

分类不得读取或依赖：

- 当前是否有 VCC 任务；
- 当前是否有 importing batch；
- 是否存在未处理导入异常；
- 是否存在后续 calculated/archived 月份；
- 当前用户是否具有执行条件。

这些内容全部属于 §5 的操作门禁。

### 4.2 current-five-dataset

必须满足现有五表一致性合同：

- 目标月恰好一个 archived run，没有 calculated run。
- 五类 dataset 类型唯一、revision 与 run 输入 revision 一致，全部 archived 且指向该 run。
- run 具有有效五表 input fingerprint。
- archive 非空，全部指向同一 run。
- archive 主体集合与 run balance 主体集合一致。
- 每个主体严格覆盖九币种；余额逐主体逐币种与生效结果相等。
- adjustment sequence、result revision 和生效结果合同有效。

### 4.3 legacy-v3.1.7-four-dataset

必须同时满足：

- 目标月恰好一个 archived run，没有 calculated run。
- `input_fingerprint IS NULL`、`result_revision=0`，不存在 adjustment。
- `input_revisions_json` 可解析为对象，键集合恰好是充值清退、费用换汇、通道、系统财务 OP；按语义比较键和值，不比较 JSON 原始字符串顺序。
- dataset 恰好为上述四类，revision 与 input revisions 一致，全部 archived 且指向同一 run。
- 唯一缺失 dataset 为 `pending_archive_removal`；不得创建空 Pending。
- 不存在 Pending effective facts、Pending run rows、Pending summary 或 Pending currency totals。
- archive 非空且全部指向同一 run。
- archive 主体集合与 run balance 主体集合一致，每个主体严格覆盖九币种。
- 金额使用规范十进制字符串逐主体逐币种比较，不使用 JSON 文本或 hash 相等代替金额相等。

### 4.4 inconsistent

以下任一情况必须归为 inconsistent：

- archived run 数量不是 1，或同时存在 calculated run；
- 缺少任一非 Pending dataset，或出现未知/重复 dataset；
- run、dataset、archive 的 run ID 不一致；
- input revisions 无法解析、键集合错误或 revision 不一致；
- 主体集合、九币种集合或余额不一致；
- legacy 形态存在 Pending、adjustment、非零 result revision 或有效 input fingerprint；
- current 形态缺少有效 input fingerprint；
- 生效结果无法读取或金额不合法。

inconsistent 月份记录结构化诊断并从普通枚举排除，不提供自动修复、fallback 或删除。

## 5. 解归档操作门禁

### 5.1 Gate 与分类独立

对 `current-five-dataset` 和 `legacy-v3.1.7-four-dataset` 执行相同的操作门禁：

1. 没有其他活动 VCC 任务。
2. 没有 importing batch/record。
3. 目标月没有 `resolution_status='unresolved'` 的导入记录。
4. 没有更晚的 calculated/archived run、archive 或 archived dataset 依赖月份。
5. preview token v2 与提交时锁定状态一致。
6. PR2 task generation 与 preview 时一致。

Gate 不通过时：

- 月份仍留在归档月份列表；
- 仍允许读取和历史导出；
- `canUnarchive=false`；
- 返回唯一主阻断 code 及全部相关 dependent months，不改写结构分类。

### 5.2 Gate code 优先级

固定优先级：

1. `archive-state-inconsistent`
2. `active-vcc-task`
3. `unresolved-imports`
4. `unarchive-not-tail`
5. `state-changed`

### 5.3 解归档提交结果

- current：删除 N 条 archive，更新 1 个 run、5 个 dataset，写 1 条 success audit；固定总变化数 `N+7`。
- legacy：删除 N 条 archive，更新 1 个 run、4 个 dataset，写 1 条 success audit；固定总变化数 `N+6`。
- 不修改 run rows、run balances、金额、主体、币种或 input revisions。
- 不新建 Pending dataset，不修改 `first_month`。
- success audit 记录 contract、classifier version、固定变化预算、实际变化数、run/dataset/archive 证据和 `minimumSafeAppVersion`。
- 重复提交旧 token 返回 `state-changed`，不得 no-op 伪成功。

### 5.4 legacy 解归档后的限制

- run 状态恢复为 calculated，四类 dataset 恢复为 unprocessed。
- 结果可查看，可通过现有结果删除或源表删除清理。
- 添加 adjustment 和确认归档均返回 `result-recalculation-required`。
- 如需继续业务使用，必须真实导入 Pending，并重新执行五表计算生成新 run。
- 一旦成功执行 legacy 解归档，该数据库不支持再由 3.1.8 写入。

## 6. 页面与性能行为

### 6.1 数据管理

- 点击后先挂载弹窗外壳、月份 loading、归档按钮 loading 和内容 skeleton。
- 月份与归档列表并行异步加载；失败在已打开弹窗内展示，可重试。
- 不得因读取失败关闭弹窗或让点击无反馈。
- 归档、解归档或删除完成后，每个用户动作最多触发一次归档列表刷新和一次活动月份刷新。

### 6.2 删除目标

- 打开删除页时一次返回全部可见目标、count、available、disabledReason 和各自 token。
- 切换目标表直接使用本次响应中的 preview，不再次查询数据库。
- 提交仍在写事务内重新验证，不把前端缓存视为授权。
- 每次删除后重新读取目标和月份；目标月仍活跃则保持，已隐藏则选择最新活动月份，无月份则显示空状态。

### 6.3 修改结果与确认归档

- 修改结果和确认归档必须在写 worker 中执行。
- UI 显示“校验—固化审计—写入—核验—提交”阶段，主窗口保持响应。
- 五表 input fingerprint、result revision、调整唯一性、归档主体和九币种余额校验继续保留。
- 禁止通过移除输入 fingerprint 或归档余额校验换取性能。

### 6.4 解归档与删除执行

- 写事务开始前允许取消；进入受保护阶段后取消按钮禁用，等待提交或回滚。
- 源表删除仍可随目标行数增长，但不得阻塞 renderer 或 Electron 主进程。
- 进度只表示阶段，不伪造不准确百分比。

## 7. 活动月份与历史隐藏

### 7.1 保持月份可见的状态

以下任一存在时月份继续显示：

- dataset、run、archive、opening；
- effective rows 或 system snapshots；
- importing batch/record；
- unresolved import record；
- success/success_with_skips/all_skipped 且 `dataset_deleted_at IS NULL` 的 import record。

### 7.2 不保持月份可见的审计

以下数据单独存在时月份隐藏：

- 已标记 dataset deleted 的成功导入记录；
- 已 resolved 的失败记录；
- import rows 历史审计；
- dataset deletion 和 operation audit；
- 仅 `module_state.first_month`。

### 7.3 行为

- 部分删除不隐藏月份。
- 最后一项活动状态删除后自动隐藏。
- `listImportRecords(yearMonth)`、记录详情和审计导出继续支持显式月份。
- 重新导入或产生新 run/dataset 后月份重新出现。
- 本功能不物理删除审计，SQLite 文件不会自动变小。

## 8. SHA-256 与安全口径

### 8.1 必须保留

- 模板资产 SHA；
- 导入幂等/content hash；
- 五表计算 input fingerprint；
- 小型 canonical preview token；
- 审计 evidence 摘要。

### 8.2 必须移除的热路径用法

- 修改结果、确认归档、解归档和删除前后对全部 VCC 事实表逐行读取、拼接并计算 SHA-256。
- 为证明“其他月份没变化”而重复扫描与本次操作无关的千万级事实。

替代方案必须同时具备：固定变化预算、protected-table SQLite session、精确主键/字段后置断言和 success audit 断言。任一能力缺失都失败关闭。

## 9. TaskLifecycle、进度与取消

- list/get/preview/progress 全部 exclude，不增加批次或运行次数。
- adjustment、archive、unarchive、delete 继续各自 reserve 一个元数据批次。
- 最终 PR3 接线时，主进程先完成 `BOR.begin → reserve → started`，再把同一七字段 worker context 传入写 worker。
- worker 不创建、恢复、猜测或预留批次。
- progress 事件只作 UI 旁路通知，不创建批次、不改变 task 状态。
- 事务前取消只产生一个 `cancelled` 终态。
- 进入受保护事务后，迟到 cancel 不得覆盖 committed success 或 rolled-back failure；终态继续由 PR2 CAS 收敛。

## 10. 兼容、发布与回滚

### 10.1 版本归属

- 仓库内 `changes/3.1.8/spec.md` 追加本纠错补遗。
- v3.1.9 Spec 增加窄范围 erratum：仅“VCC 归档兼容、操作保护和性能路径”由本补遗取代；其他 C01～C14、PR1/PR2 合同不变。
- 实际二进制版本为 v3.1.9，不重发 v3.1.8。

### 10.2 降级

- 未执行 legacy 解归档前，代码回滚仍需按常规数据库兼容性评估。
- 成功执行 legacy 解归档后，禁止使用低于 3.1.9 的版本继续写入该数据库。
- 恢复到 3.1.8 的唯一受支持方式是恢复 legacy 操作前的完整一致性备份。
- 不提供反向 migration、自动重建 archive 或从 audit 自动恢复按钮。

### 10.3 上线顺序

1. PR2 CI 全绿并冻结实施头。
2. 仓库内补遗与 TechDoc 评审通过。
3. 纠错系列 PR 串行完成。
4. 原 PR3 拆为 VCC TaskLifecycle 接线和工具箱接线。
5. 在目标旧库副本和约 16 GB 性能副本验收。
6. 财务人工复核签字。
7. Windows installer/portable 和发布门禁通过后发布 v3.1.9。

## 11. 验收矩阵

| ID | Given | When | Then |
|---|---|---|---|
| AC-01 | current 五表归档结构正确 | 枚举/导出 | 月份出现且可导出。 |
| AC-02 | legacy 四表归档结构正确 | 枚举/导出 | 月份出现且可导出，无“旧版”标签。 |
| AC-03 | legacy 结构正确但存在后续月份 | 打开解归档 | 月份仍出现且可导出；`canUnarchive=false`、code=`unarchive-not-tail`。 |
| AC-04 | legacy 结构正确但有 unresolved import | 打开解归档 | 月份仍出现且可导出；`canUnarchive=false`、code=`unresolved-imports`。 |
| AC-05 | legacy 结构正确且 gate 全通过 | 确认解归档 | N+6 精确提交，金额和结果子表不变。 |
| AC-06 | current 结构正确且 gate 全通过 | 确认解归档 | N+7 精确提交，金额和结果子表不变。 |
| AC-07 | 任一结构证据不一致 | 枚举/导出/解归档 | 从普通枚举排除，直接操作失败关闭并记录原因。 |
| AC-08 | legacy 已解归档 | 添加调整/确认归档 | 返回 `result-recalculation-required`，无写入。 |
| AC-09 | 删除部分目标 | 刷新月份 | 月份继续显示。 |
| AC-10 | 最后一项活动状态删除 | 刷新月份 | 月份隐藏，显式审计查询仍可读。 |
| AC-11 | audit-only 月重新导入 | 导入完成 | 月份重新出现。 |
| AC-12 | 约 16 GB 库 | 点击数据管理 | 150 ms 内弹窗外壳可见。 |
| AC-13 | 约 16 GB 库 | 确认归档 | UI 不冻结，P95 ≤ 2 s，无全事实表扫描。 |
| AC-14 | 大源表 | 删除数据 | 200 ms 内显示阶段，主进程 P95 lag < 100 ms。 |
| AC-15 | preview 后状态变化 | 提交 | 返回 `state-changed`，零业务写入。 |
| AC-16 | 未批准 trigger 或 session 不可用 | 任一受保护写操作 | 失败关闭，事务不提交。 |
| AC-17 | 事务中注入额外写入 | 提交 | 固定预算或 protected session 失败，整事务回滚。 |
| AC-18 | legacy 解归档成功后 | 尝试降级写入 | 明确属于不支持场景，只能恢复操作前备份。 |
| AC-19 | 用户事务前取消 | TaskLifecycle 收口 | 恰好一个 cancelled 终态，无幽灵批次。 |
| AC-20 | 事务受保护后取消 | 任务最终完成 | commit→succeeded，rollback→failed，迟到取消不覆盖。 |

## 12. 非功能门禁

在约 16 GB、1080 万 import rows、610 万 effective rows 的完整一致性副本上：

- 数据管理外壳可见：P95 ≤ 150 ms。
- 归档枚举和解归档 preview：P95 ≤ 500 ms；SQL trace 零 `vcc_fin_op_import_rows`。
- 删除目标列表：P95 ≤ 2 s；目标切换 ≤ 50 ms。
- 修改结果、确认归档、解归档和结果删除：P95 ≤ 2 s。
- 大源表删除允许随目标数据量增长，但 renderer 动画持续，主进程 P95 lag < 100 ms。
- 将其他月份历史数据翻倍后，归档枚举、解归档和非源表写操作耗时增长不超过 20%。
- 0、1、100 个归档月份均不得产生逐月 source facts 扫描或 N+1 preview。

## 13. Unknowns Register 与发布前 PROBE

当前无待用户确认的 BLOCK 产品问题。以下 PROBE 是发布门禁，不改变已锁定架构：

| 未知 | 处理 | 成功证据 | 失败处置 |
|---|---|---|---|
| Windows 打包 Electron 是否支持 `DatabaseSync.createSession()` | PROBE | installer/portable runtime feature test PASS | 不发布，不降级提交。 |
| 打包 SQLite 是否支持计划使用的只读连接和 `UPDATE ... FROM` | PROBE | runtime SQL feature test PASS | 改为等价且有性能证据的固定实现，反向同步 TechDoc。 |
| 真实 v3.1.7 数据经 current migration 的精确形态 | PROBE | 由 v3.1.7 代码生成的 fixture 通过 | classifier 不扩范围，先修合同或阻断。 |
| 目标线上旧库是否严格属于 legacy-four | PROBE | 完整副本 inspect 报告 | inconsistent 只人工诊断，不自动处理。 |
| 约 16 GB 副本真实 P95 | PROBE | 基准报告和 SQL trace | 未达标不得用“机器差异”关闭。 |

## 14. 资金红线人工复核

⚠️ 资金红线，请人工复核：

- 一个 current 五表归档月和一个真实 legacy 四表归档月；
- archive 与 run balance 的主体、九币种和金额；
- legacy 解归档前后 run rows、run balances、金额和 revision；
- 后续月份门禁和跨月期初血缘；
- 逐表删除后的导入审计、结果去向和月份隐藏；
- 操作前完整备份及 legacy 解归档后的不降级说明。

自动化、CI 或 mutation guard 通过均不能替代本人工门禁。
