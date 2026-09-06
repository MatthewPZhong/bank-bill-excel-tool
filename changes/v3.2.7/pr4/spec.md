# PR4 六类导出、诊断读取与唯一 Publisher

Goal：六类固定对象和诊断报告经同一 Task 导出；expected → writer → 独立 actual 在一次 1 GiB 原生线程租约内顺序完成，Main 小证据核对后交给既有 Publisher，发布阶段独立计费。

Context：基线 PR3 be71707b；E5 和用户批准 E01—E03。生产关闭、版本不变、所有测试临时数据。提交后直接创建基于 PR3 的远端草稿 PR。

Constraints：不改共享恢复核心接口；不重新实现 ZIP/样式/单元格解析器，不用全量 cells/SST，不改旧输出摘要。所有目标由真实 FilePlan 授权，生成器只写任务私有候选；所有导出、Publisher 和恢复消费者实际关闭及输入消费完成后才释放 pin。

Done when：六类完整列/表头/类型/页序/说明独立回读；逐类损坏拒绝；分页和零差异有证据；真实 Publisher/Task/Archive、取消及提交反馈丢失恢复链通过。Windows、目标规模和人工资金/Excel 打开仍单独验收。

输出身份采用 output-schemas.json 的 evidenceVersion / revision 2 / kind / columnSchemaVersion 1。RAW 重读固定原件日切片的完整 23/28 原列；CHECK 读取固定 12/9；RESULT 读取同一已封存 run 的 19 列与 is_difference，说明不查最新 OP。文本账号固定为文本；金额复用现有词元精度分类，无损数值或精确文本，文本回退附 PRECISION_NOTE。NULL、空文本、数字 0、文本 0 和布尔均有不同编码。

expected 先把有类型输出行写临时 SQLite，再按固定页序增量摘要，随后 writer 逐行消费该清单；actual 重新打开最终 XLSX，用共享 rich scanner + 磁盘 SST 逐页验证全部显式单元格（含列外空 c）。为不同表头和严格类型增加 BizOP writer 适配，不改变旧工具箱导出。

每页最多 1048575 数据行，说明页 22 列，标题不超过 31 UTF-16。说明文本 8000 单元分段，结果 diff 的 OUTPUT_ROW_MAP 保留原 rowOrdinal。各阶段一次一个读者/输出 writer；工作库每连接 16 MiB cache、FILE temp，共享 writer 4096 行/4 MiB。

PR4 实施收敛：原共享 `TaskLifecycle.runFileTask` 新增可选 `beforeTerminalSettlement` Main owner 钩子，位于 execute 分类后、自动 artifact 与终态写入前。已有调用不传则行为不变；BizOP 只在原 Publisher 观察明确、载体已退出时允许收口。提交后异常或提交事实未明时钩子拒绝，让原 Task 保持可恢复，不能先写失败后再改成功。该扩展是原 File Task 的终态准入，不新增任务平台或修改 StartupRecoveryCoordinator。

同 Task 的 READ/CARRIER 来源只收敛自身 Hold；Task/Batch overlay 始终由 OPERATION/RECLAIM 主来源推进。避免读取来源先拥有 overlay 后，主来源无法通过 source identity CAS。共享 Publisher journal 仍由既有 dispatcher 完整观察；旧 Toolbox/VCC Archive owner 通过 BizOP Main 包装器跳过本模块的接管及 ACK，避免 blocked 轮次抢先确认清理。

RAW 的 Archive 原件摘要核验、Publisher 复制/恢复/确认，以及 Archive 输出复制分别通过现有 Governor 申请 1 GiB/1 worker/1 CPU/1 IO 容量，等待实际调用结束后释放。expected/writer/actual 仍在同一原生 worker 租约内。回传仅五字段候选引用，Main 核对固定来源、大小、文件身份及小报告。

命名遵循 Spec §4.4/§5.5：四类输入默认名带账期和该类型公开版本，结果默认名按同年/跨年区间压缩；实际结果页签采用两端固定输入日期与版本的缩写。大版本加页号超过 31 UTF-16 时使用日期缩写，完整版本对比仍写入核对说明，既不截断业务值也不重新查询当前 head。
