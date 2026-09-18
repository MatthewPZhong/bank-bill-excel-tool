# 3.0.14 Implementation Notes

## Original request

- 仅命中场景时校验异常说明。
- 新增 `前置资金对账`，3.0.14 交付 `缺网关账单`。
- 导入 MPT 网关账单和标准银行账单，联合既有网关链接表做 1:1 对账并按模板导出。
- PR #87 用户追加确认：完全重复网关记录必须有可无损追溯的审计输出，并将导出/C4 契约扩为按渠道动态 5/6-sheet。

## Decisions

| 决定 | 原因 | 备选 |
|---|---|---|
| 命中只认实际字段变化 | 用户明确确认 | 锁定或 note-only 均被否决 |
| 3.0.14 只显示缺网关账单 | 避免暴露不可运行功能 | 缺渠道账单延后 3.0.15 |
| 平账使用非空对账 ID + 渠道 + 金额 + 币种四字段精确条件 | 用户修订确认；避免 ID 相同但资金要素不同被误判平账 | 不做模糊、日期或其它兜底；金额沿用精确十进制规范值 |
| 银行重复不去重，严格逐行消费 | 用户明确“全部 1 对 1” | 聚合/多对多被否决 |
| 临时明细和结果使用 side DB | 大数据与主库隔离规则 | 不写主库大表 |
| 主库保存轻量 run 镜像，对外 run ID 使用镜像 ID | 满足 run-scoped data policy，并能观察中断/侧库丢失 | 只在内存保存结果被否决 |
| 临时 MPT 与 run 结果拆成两个 side DB 模块 | 两者生命周期不同；结果候选池可达百万行，必须支持新 run/重启整文件回收 | 同库 DELETE 会留下空洞且污染跨重启临时批次月库 |
| INBOUND/OUTBOUND 共用物理月侧库、按 `sourceType` 形成两个逻辑表库 | 用户确认“逻辑隔离”；现有批次/明细已有 `sourceType`，无需复制 DDL 或迁移历史数据 | 物理拆成两个 side DB 模块会增加生命周期和联合匹配复杂度 |
| OUTBOUND 使用 bankDebit -> target -> origin | 用户确认且实样支持 | target 优先被否决 |
| 按银行 Channel 拆分导出 | 用户确认 | 单一汇总文件不采用 |
| 完全重复仍按 `reconciliationId + 10 字段指纹` 折叠 | 用户确认；保持候选池不重复和既有 1:1 语义 | 不取消折叠，也不改为仅按 reconciliationId 去重 |
| 重复审计按渠道动态追加第 6 sheet `重复网关账单` | 用户确认；无重复文件保持既有 5-sheet 兼容，有重复才增加可见审计 | 固定所有文件 6 sheet、或只显示重复计数均不采用 |
| `重复网关账单` 固定 22 列，同时输出保留/被折叠双方 | 用户确认；折叠必须能解释“保留了谁、折叠了谁、来自哪里” | 只输出被折叠侧、只写摘要或只写告警均不采用 |
| 双方原始 JSON 每片最多 30000 字符，多行可无损重组 | 用户确认；避开 Excel 单元格长度风险且保留完整审计证据 | 截断、压缩摘要、只保留规范字段均不采用 |
| 导出渠道取银行渠道与重复渠道并集，并按渠道严格隔离 | 用户确认；只有重复记录的渠道也必须可审计 | 仅按银行渠道导出会漏掉重复专属渠道 |
| C4 同时兼容 4/5/6-sheet | 用户确认；第 6 sheet 是前置资金审计附加页，C4 当前无需消费 | 只兼容 4/5 会拒绝带审计页的新文件 |
| INBOUND/OUTBOUND 日期删除继续以 `sourceType` 为强隔离键 | 用户确认沿用；两类共用月侧库但删除生命周期不能串 | 删除不带 sourceType 或删一类即回收整月库均不采用 |

## Assumptions

- 新模块对已有用户默认关闭。
- 临时网关候选优先于现有网关链接表候选。
- 网关联合池为空时阻断运行。
- 匹配不增加日期窗口。

## Deviations

| 原计划 | 实际变化 | 原因 | 影响 |
|---|---|---|---|
| 独立 `{module}-run-data.js` 编排层 | 使用 `pre-fund-reconciliation/service.js` 作为模块唯一编排层 | 新模块无历史主库 bulk 数据和双源迁移；service 已集中 import/run/mirror/export 生命周期 | 已同步 `rules/run-scoped-data-policy.md` v2 |
| MPT 文件结果直接透传底层 `status` | 外层固定 `status=ok`，底层动作放 `importStatus=imported/noop/replaced` | 避免底层状态覆盖外层成功状态，导致 UI 把已入库文件误报失败 | 已补真实同月链路回归 |
| 临时批次与运行结果共用月侧库 | 拆为 `pre-fund-reconciliation` 与 `pre-fund-reconciliation-results` | 自审发现重复 run 会复制百万级候选池；同库保留 MPT 时无法用删文件即时回收结果空间 | 新 run 标 `superseded`、重启标 `expired`，结果库整文件删除 |
| 临时链接表首页使用 7 列批次管理表 | 首页改为与既有链接表管理一致的 3 列表库概览和 `删除 / 导入 / 退出` | 用户要求两页前端一致，仅移除不存在的账户映射功能 | 首页只展示临时表库汇总，导入仍复用 MPT 路径 |
| 删除按钮进入批次选择/全部清空子页 | 改为与既有链接表删除框相同的目标表、起止日期、删除/取消页面 | 用户要求删除框前端完全一致 | 按批次 `sourceDate` 闭区间整体删除；旧单批/清空接口保留但不再由页面展示 |
| 主面板单列展示场景、MPT 导入和临时表管理，状态框跨三行 | 场景下拉移到视觉左上角，与银行导入、导出三等分对齐；删除重复的主面板 MPT 导入按钮；状态框恢复为既有资金对账面板高度 | 临时链接表 `导入` 已复用同一 MPT handler，用户要求统一入口和精确边界对齐 | MPT 导入能力不变，只收敛页面入口；状态框宽度保持不变 |
| 平账只按非空对账 ID 精确相等 | 收紧为对账 ID、渠道、金额、币种四项全部相同；同 ID 但要素不符的网关候选不消费 | 用户于 2026-07-12 修订平账口径 | 平账数量可能下降、不平和未使用候选可能增加；已先反向同步 spec，再实施引擎 |
| 临时链接表首页只显示一个汇总行、删除目标只有一个 | 首页改为入金/出金两个逻辑表库，汇总和日期删除均携带 `sourceType` | 用户明确两类 MPT 在临时链接表中分别对应入金/出金表库，并确认采用逻辑隔离 | 只改变管理与生命周期边界；对账运行仍联合两类临时明细 |
| 前置模块顶部使用下拉框/导入/导出三等分专用布局 | 改为与资金对账数据处理完全相同的五槽位骨架：原导入/导出/运行/场景/链接槽位分别放下拉框/链接表管理/导入/运行/导出 | 用户给出逐槽位映射关系 | 功能 ID、事件和状态不变；只调整 DOM 位置、入口文案和专用样式 |
| `对账场景` 文本在下拉框上方；已有网关链接数据时空会话显示统计 | 文本移到下拉框左侧；未导入银行文件且无 run/error 时固定显示欢迎语 | 用户明确前端位置和初始文案 | 不改变按钮可用性、链接表数据或对账状态，只收敛空会话展示 |
| 导出覆盖在写入完成后统一删备份，任一异常都按整批回滚 | 备份阶段记录已移动/未移动原文件；写入失败只清理本次新文件并恢复已备份原文件；提交成功后备份清理失败改为可见提醒 | Review 发现第二个原文件备份失败时，旧逻辑可删掉尚未备份的原文件 | 修复多文件覆盖的部分失败原子性，新增原文件保全回归 |
| 结果 side DB 只在前置模块首次打开时回收 | 主库完成初始化后立即在后台创建 service，标记上一进程镜像失效并回收结果库 | 新模块对存量用户默认关闭，不能依赖用户打开模块才执行重启生命周期 | 即使功能未启用，旧 run 结果也不会跨进程滞留 |
| 持久网关游标沿用旧读取器语义，损坏 `raw_json` 直接跳过 | 损坏/非对象 JSON 仍不中断剩余游标，但显式交给引擎计入 `gatewayInvalidRows` | Review 确认直接跳过会使持久网关行无可观测地消失，可把银行行表现为右单边 | 保留容错遍历，同时补齐资金对账无效行统计 |
| 完全重复只折叠并显示统计，导出固定 5 sheet | 完全重复仍折叠，但对应渠道文件末尾动态追加第 6 sheet `重复网关账单`；无重复渠道保持 5 sheet | PR #87 用户确认旧方案缺少逐条审计证据 | 用户可见输出契约从固定 5-sheet 改为按渠道动态 5/6-sheet；spec/test/release docs 已反向同步并完成实现 |
| 重复折叠只保留规范候选和告警计数 | 为每个折叠组保留 1 条保留记录 + 全部被折叠记录的来源、位置、字段和原始 JSON | 用户要求保留/被折叠双方均可审计并能还原原文 | 结果 side DB 与 writer 需新增审计数据链；不得只从聚合统计反推 |
| 导出渠道仅取银行行 Channel | 改为银行渠道与重复记录渠道并集，重复专属渠道仍导出且不串渠道 | 用户确认只按银行渠道会漏掉无银行行的重复审计 | 渠道枚举与逐渠道 writer 输入需扩展；每个文件独立判断 5/6 sheet |
| C4 兼容旧 4-sheet 与新 5-sheet | 扩为 4/5/6-sheet，6-sheet 仅多末尾 `重复网关账单` | 用户确认新导出仍需进入 C4 流程 | C4 对第 6 sheet 严格校验 22 列后忽略数据；必需 sheet/表头拒绝规则及按名称读取行为不变 |
| 结果 side DB 仅依赖进程内共享锁 | 正式应用启动时取得 Electron 单实例锁，第二实例只聚焦既有窗口；隔离预览/启动测量保留并行能力 | Review 发现两个正式实例可能同时回收同一结果侧库 | 消除跨实例 run ID/文件路径串线；新增静态单实例回归 |
| 首次重复时只按来源记录 ID 回读保留对象原文 | 候选池额外保存原文 SHA-256；回读原文必须与候选哈希一致后才能写审计快照 | Review 发现来源记录被替换或 ID 复用时可能拼接错误血缘 | 唯一候选仍不复制原文，只增加固定 32 字节身份摘要；不一致显式终止 run |
| C4 先整本读取再忽略第 6 sheet | 先以 `sheetRows:1` 校验完整 sheet 列表和重复审计表头，再只读取业务 sheet | Review 指出大审计页仍会被 SheetJS 全量载入 | C4 读取内存不再随第 6 sheet 数据量线性增长，旧 4/5-sheet 行为不变 |
| writer 假定 sheet 数据量不超过 Excel 上限 | 所有 sheet 在追加第 1,048,576 条数据行前显式失败并回滚临时文件 | Review 指出 JSON 分片可能突破 Excel 行数硬上限 | 禁止生成被 Excel 截断或修复的伪成功文件；本版不引入分卷契约 |
| 重复审计结果侧库只校验 raw JSON 为字符串 | 导出前要求原始 JSON 可解析且顶层为对象 | Review 发现损坏结果库可输出非法审计证据 | 保留原始字符串逐字符输出；损坏或结构无效时禁止导出 |
| 临时 Excel 完成后直接 `rename` 到目标路径 | 同目录优先硬链接 no-clobber 发布；不支持硬链接时降级 `COPYFILE_EXCL`，覆盖模式的备份恢复使用同一不覆盖语义 | Review 发现冲突检查后外部创建文件时可能覆盖/误删，且部分文件系统不支持硬链接 | 只回滚本次实际发布且身份未变化的文件；外部新增/替换/修改文件一律保留并显式报错 |

## Evidence

- 真实 MPT INBOUND：101,857 行，33 字段。
- 真实 MPT OUTBOUND：40,345 行，33 字段。
- OUTBOUND `targetCurrency/targetAmount` 100% 有值。
- OUTBOUND `bankDebitCurrency/bankDebitAmount` 40,339 行有值，仅空 6 行。
- bankDebit 与 target 币种相同 40,274/40,339；金额相同 40,292/40,339。
- 两类差异并集 71 行，分析报告：`/Users/pzhong/Desktop/MPT_OUTBOUND_GATEWAY-目标金额与银行扣款差异.md`。
- 原 5-sheet 基线针对性单元测试均 PASS（MPT、side DB、1:1、输出、C4、命中口径、UI/IPC、Review 回归和大数据合成用例）。
- 原 5-sheet 基线完整单元测试：3452/3452 PASS。
- 原 5-sheet 基线集成测试：39/39 脚本、1817/1817 断言 PASS；pre-fund parity 37/37 PASS。
- smoke、ESLint 均通过。
- 启动测量 5 次：进程总耗时平均 724.128ms，ready-to-show 平均 172.981ms，建窗到可见平均 102.506ms，低于仓库阈值。
- 真实模板端到端：同月 MPT 导入 -> 1 平 1 不平 -> 5-sheet 导出 -> 删除来源后旧结果禁止导出。
- Electron 1240x860 截图验收：长统计文案、场景下拉和按钮无重叠/截断。
- 链接表管理首页截图：`docs/previews/pre-fund-temp-manager.png`；标题和主面板入口均为 `链接表管理`，与既有链接表管理同宽、同三列表头和同右侧按钮顺序，分两行显示入金/出金逻辑表库，未显示账户映射入口。
- 临时删除框截图：`docs/previews/pre-fund-temp-delete-range.png`；与既有链接表删除框同为 2480×1720，card、双目标表下拉、起止日期及删除/取消按钮布局一致。
- 前置资金对账主面板截图：`docs/previews/pre-fund-reconciliation-panel.png`；Clear 主题下五个控件逐槽位对齐 `docs/previews/bank-statement-panel.png`：原导入/导出/运行/场景/链接位置分别为下拉框/链接表管理/导入文件/开始运行/导出文件；`对账场景` 位于下拉框左侧。preview 注入已有网关数据但无银行 session，状态框仍显示 `欢迎使用小助手`，运行/导出保持禁用。
- UI/IPC 针对性测试 7/7 PASS：锁定 row1 + merged-row 五槽位、主面板不存在重复 MPT 按钮或旧 `临时链接表管理` 文案，链接表弹窗 `导入` 仍把 `handlePreFundImportMpt` 作为唯一页面入口。
- 四字段匹配针对性测试：前置资金对账 103/103 PASS；覆盖错渠道、错金额、错币种、十进制等价、要素不符候选不消费，以及生产 SQLite 查询跳过不符的临时候选并消费后续精确候选。
- 四字段生产实现不改 side DB schema：查询先按现有 `run_id + reconciliation_id` 索引缩小范围，再对 `fields_json` 中的渠道、规范金额和币种做参数化精确比较。
- 临时逻辑表库隔离不改 side DB schema：同月 INBOUND/OUTBOUND 共存时可按来源分别汇总；删除 INBOUND 后 OUTBOUND 批次、明细和共享月库均保留，未知或缺失来源在 service 边界被拒绝。
- 2026-07-12 PR #87 用户确认后的契约探查：当前 `spec.md`、writer/C4 测试和发布文档仍以固定 5-sheet、C4 4/5 为基线，且重复仅有折叠统计；因此本次变更属于行为与验收口径偏差，必须先反向同步文档再交 Dev，旧 PASS 不能覆盖新增动态 5/6-sheet、22 列和 JSON 分片验收。
- 每文件 MPT 导入结果把 `sourceType` 和实际 `rowCount` 提升到顶层，临时链接表导入汇总不再把成功批次误显示为 0 行。
- 大文件工具箱集成首次受运行时内存波动影响为 14/15（878MB > 800MB）；同脚本独立复跑 15/15（681MB），随后完整 `release-check` 再跑为 15/15，最终整套检查通过。
- 合成 100,000 行 gzip MPT 通过生产解析器验证：按 1,000 行批次交付，共100批，不累计全文件对象。
- 合成 1,000,000 条持久网关候选通过 `PreFundReconciliationService.run()` 生产消费循环验证：游标每 yield 一行立即规范化并下沉 side-DB adapter，不预读或常驻全量数组。
- Review 回归覆盖：真实持久网关表头 `merchantid` 可输出、损坏结果 JSON 显式失败、结果库运行中丢失禁止导出、部分备份失败保留全部原文件、成功但零渠道结果不点亮导出、超长 MPT 行无论换行分块都被拦截、非法日历删除范围被拒绝。
- 动态重复审计定向单测 43/43 PASS：含单实例锁、SHA-256 保留原文身份校验、side DB 回滚、6-sheet/C4 选择性读取和 Excel 行数上限。
- 动态重复审计 side DB -> writer -> 5/6-sheet -> C4 集成 62/62 PASS；覆盖最短合法对象 `{}`、30000/30001/60000/60001 字符、中英文/转义/emoji 边界、同组 `1+N` 对象独立分片及逐字符无损重组。
- C4 非空 5/6-sheet 业务数据读取结果逐字段相同；INBOUND/OUTBOUND 两个删除方向均验证另一逻辑表和共享月库保留，OUTBOUND 删除后旧 run 立即失效。
- no-clobber 回归覆盖冲突检查后外部创建文件、发布后外部修改身份识别、硬链接 `ENOTSUP` 时排他复制降级和覆盖导出备份清理。
- 最终 `npm run release-check` 全绿：lint、smoke、unit 3483/3483、integration 1842/1842（39 个脚本）。
- 最终独立 Review 经过多轮 Finding 修复与复核，P0/P1/P2/P3/P4 均为 0；无待合并代码 Finding。
- `npm run scan:vars`：v3.0.14、183 个 JS 文件、1986 个顶层声明；`npm run check:vars -- --include-minor` 命中 `FileValidationError`、Electron `app`、`GATEWAY_SOURCE`，对应回归已复核。
- 真实同月来源删除隔离：INBOUND 101,857 行、OUTBOUND 40,345 行；删除 INBOUND 后 OUTBOUND 40,345 行及共享月库保留，反向删除同样只影响所选 `sourceType`。
- 人工资金复核已完成：四字段匹配、临时来源优先、10 字段指纹、保留/被折叠双方原文、姓名/卡号、渠道并集/不串、C4 兼容和 `sourceType` 删除隔离均按展示证据确认。

## Remaining unknowns

- `ASSUME`：跨月删除横跨多个独立 SQLite 月库，无法提供分布式原子提交；当前每月事务原子、全程共享写锁，失败会报告已删除批次/行数，并支持同范围幂等重跑。若未来要求跨月全有或全无，需要引入删除计划/补偿日志。
- `ASSUME（非阻断）`：已用百万条惰性游标跑过 service 生产消费循环，但未在验收机对真实百万行 SQLite 链接表记录耗时/RSS；这是发布后性能基线补充，不影响本版迭代/投影内存契约的自动验收。

## Check-vars Review

- **Critical**：`unmatchedRows` 的去向按 3.0.14 改为“未实际改值即未命中”，dispatcher 锁定仍保留，命中+未命中行数守恒已有 unit/integration；`FileValidationError` 仅复用既有结构承载 MPT 文件/行级错误，没有改变公共错误类契约。
- **Important-skeleton**：新增 preload/main IPC 10 个 invoke 与 3 个进度通道均有静态契约测试；`settingsRepository` 的模块全集扩为 10，新模块不进入默认启用列表。
- **Runtime-state**：新状态隔离在 `state.preFundReconciliation`，模块切换按需刷新；所有状态框写入继续走 `updateStatusBox`；临时批次和结果不放 renderer。Electron `app` 新增正式环境单实例锁，preview/startup measure 的隔离环境不受影响。
- **Risk-sensitive**：`MODULE_PRE_FUND_RECONCILIATION` / `MODULE_PRE_FUND_RECONCILIATION_RESULTS` / `SIDE_DB_DDL_PRE_FUND_GATEWAY` / `SIDE_DB_DDL_PRE_FUND_RUNS`、`hasActualFieldChanges` / `buildOutputRows`、`detectFundTransferManyToMany` 已按本文件 Evidence 的 unit、parity、integration 和 smoke 验证。
- **人工项**：严格 ID+渠道+金额+币种 1:1、临时优先、重复指纹、金额/币种 fallback、银行方向/name/cardNo、双方原始 JSON、按渠道不串和 `sourceType` 删除隔离已由业务负责人结合展示证据复核。
