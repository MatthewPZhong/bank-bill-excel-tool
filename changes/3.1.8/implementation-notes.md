# Implementation Notes

## Baseline

- Goal/spec: `/Users/pzhong/Downloads/v3.1.8-codex-spec-final.md`，SHA-256 `9f3af33df52907499ec673b20f808b7615e7edf10231a33508c8eb5acd2a76de`；Q01～Q12 全部锁定。
- Initial plan: 按 Spec Phase 0～6 建立六个堆叠草稿 PR，分别覆盖输入契约、状态模型、破坏性事务、调整 UI、模板导出与发布收口。
- Done when: `changes/3.1.8/preflight.md` 的 Done when 与 Spec §15 同时满足；人工财务核对门禁保持开启。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 使用堆叠 PR，后续分支以直接前序分支为 base | 数据库和 UI 阶段存在真实依赖，同时需要每个 PR diff 可独立评审 | 一个大 PR；每个 PR 都从 main 重复带依赖 | 合并顺序必须固定，PR body 标明依赖 |
| PR 1 同时包含 Pending 资产、代码契约、历史 hash 迁移与运行门禁 | 单独只改表头会制造历史同键异内容冲突；只改门禁会让合法新模板仍无法导入 | 将资产/迁移/门禁拆散 | 这一 PR 是后续资金计算的输入可信基座 |
| 系统财务OP数据管理导出以 `balances_json` 为九币种财务余额唯一权威源，`raw_json.rows[].displayValues` 仅保留其余 15 列展示血缘 | PR #124 review 用真实精度反例证明显示值 `135886024.6` 会覆盖 canonical `135886024.59`；Spec §4.7.3 要求数据管理全链路保持原精度 | 继续从 `displayValues` 导出全行；在 writer 内重算余额 | 仅“财务余额”按 `normalizedCurrency` 覆盖为 canonical；九币种集合、金额或读取证据损坏时 `invalid-export-lineage` 失败关闭，不回退显示值 |
| 两份已在工作区且哈希匹配的模板视为用户提供的本迭代资产 | 哈希与 Spec §2.3/§2.4 精确一致 | 重新生成或肉眼复制模板 | 保留用户原始工作簿字节，测试不得改写 golden |
| 极老残缺审计表为空时允许补列；若已有 Pending 行却缺少 `raw_json` 等重算证据则失败关闭 | 无原始 46/48 列载荷无法证明新 hash，静默跳过会制造同键异内容 | 猜测列序或沿用旧 hash | 空旧库兼容升级；有事实但无血缘的旧库必须人工处理 |
| GitHub 认证问题不阻塞本地实现 | `gh` 已安装但 token 失效；代码和测试均可离线推进 | 等待登录后才开始编码 | push/PR 创建仍明确阻塞，不能声称已发布 |
| PR 2 将首月事实诊断拆到无迁移依赖的 `state-model.js` | 运行时 repository 不应反向依赖 migrations；迁移和运行门禁必须共享同一严格月份诊断 | repository 直接导入 migrations；复制两套判断 | 避免依赖环和迁移副作用，旧库诊断与运行门禁口径一致 |
| 多期初月份/畸形月份只记录幂等诊断并阻断 VCC 功能，不让 `AppDatabase.init()` 整体失败 | Spec 要求不自动删改资金事实；桌面应用仍需启动供诊断和其他模块使用 | 启动抛错；自动选择最早月份并覆盖 | 资金事实原样保留；preflight/calculate/initialize fail-closed |
| 首次人工期初写入和 `first_month` claim 放在同一 `BEGIN IMMEDIATE` 事务 | 首月是全局永久事实，不能出现余额已写但首月为空或反向状态 | 先写余额后单独更新状态；只靠 UI 串行 | claim 失败时余额与状态同时回滚；同月同内容重放幂等 |
| 首月期初提交完整性只检查 `subjects - opening.balances` 的真正缺失主体 | PR #125 review 证明 preflight/renderer 只向用户收集 `missingOpeningSubjects`；要求重复提交已初始化主体会阻断同月新增主体 | 每次提交全部主体；跳过完整性检查 | 已初始化主体无需重复提交；主动重放已初始化主体仍按 content hash 幂等跳过或拒绝改写，真正漏交的新主体仍整事务回滚；属于既定契约缺陷修复，不改 Spec |
| `rowKey` 固定为 `v1:sha256(JSON.stringify([row_kind, subject, source_type, category_major || '', category_minor || '']))` | 调整坐标必须跨币种稳定，又不能受 run/id/金额/展示顺序影响 | 使用数据库行 id；把币种或金额纳入 key | 同一逻辑行不同币种共享 rowKey，以 `rowKey × currency` 构成调整坐标 |
| PR 2 的 `getEffectiveRunResult()` 仅做只读统一重算，并严格核对 sequence/revision/基础公式/坐标 | 基础 `run_rows`、`run_balances` 必须不可变；损坏的调整账本不得静默参与归档 | 就地覆盖基础表；遇到损坏记录跳过 | 后续 PR 4 复用同一 reader 接入调整写入与归档；任何事实不一致均结构化失败 |
| PR 3 的归档枚举和解归档均复用同一套严格一致性检查，并逐主体逐九币种比对含调整的生效余额 | 单看 `run.status` 会把缺 archive、错 run、混合 dataset 或余额漂移暴露为可操作月份 | 宽松枚举后在提交时尽力修复；只比基础 calculated balance | 损坏月份不进入普通枚举；直接 preview 返回 `archive-state-inconsistent` 并失败关闭 |
| 所有 VCC worker/直接任务共享一个全局任务租约，任务代次仅在释放租约时递增 | preview token 需要同时防数据库状态漂移和预览后插队任务；导出、归档、期初初始化、异常处理等直接写也不能旁路 | 只互斥 worker；获取租约即递增代次 | preview 与提交按 generation 二次门禁；任何在先任务完成后旧预览失效 |
| 破坏性 worker 在 `openDb()` 和 migration 之前先完成 `critical-ready → 父进程保护 → critical-ack` 握手 | 打开数据库本身可能产生 migration 写事务；父进程必须在允许写入前承诺不 terminate | 事务开始后再通知；超时一律 terminate | 仅事务前任务可协作取消/超时终止；已保护或状态未知任务只能等待收口 |
| 解归档、删除期初、删除结果先在 `BEGIN IMMEDIATE` 中重算 token/门禁并固化完整证据，成功审计与业务写同事务；失败后尽力补写 rolled_back 审计 | 防止预览后状态变化、部分成功和审计先后不一致 | 事务外审计；只记录计数摘要 | 成功审计不会脱离业务提交；回滚后保留失败原因，失败审计自身异常仅附加为 `context.auditFailure`，不覆盖主错 |
| 统一删除目标使用独立 `targetType` 表达五类源表、首月期初和结果，不伪造 `source_type` | opening/result 不属于导入源类型，伪造会污染数据契约和 usage 统计 | 复用假的 source type 常量 | 旧 source 删除 preload 方法名保持兼容，但提交同样强制携带用户已观察的 token/generation，不再自动 preview；动态 usage 仅将 result 成功路由为“删除结果”，source/opening 沿用业务 operation label“删除数据”，不误计为“删除结果” |
| UI 把破坏性执行成功视为不可逆边界：提交成功后保持执行锁定，完成 `onCompleted` 刷新后再关闭；刷新失败也关闭并警告，不重开或重试提交 | 重开弹框会诱导用户对已成功事务重复操作 | 将执行与刷新放在同一 catch 后恢复按钮 | renderer 明确显示“操作已成功但刷新失败”，执行中 Esc/遮罩/关闭均被锁定 |
| 首月期初初始化成功后立即结束当前【开始运行】流程，要求用户再次显式点击后才重新预检和计算 | Spec §4.2.5 禁止初始化后自动沿用当前点击继续计算或归档；资金结果需要新的明确用户动作 | 初始化成功后在同一调用栈自动 preflight/calculate | 成功状态和弹框均明确提示再次点击；renderer 契约测试禁止初始化后分支出现 preflight/calculate/archive |
| 来源原表删除在同一 `BEGIN IMMEDIATE` 内按 run id 顺序先固化完整生效结果证据，再写 success operation audit，最后执行既有级联删除与 legacy deletion 记录 | PR #126 review 证明原实现先删 `run_adjustments`/run，只留下计数，无法还原人工纠错、基础结果和九币种余额 | 仅扩大 `vcc_fin_op_dataset_deletions` 计数字段；删除后再尽力拼证据 | operation type 固定为 `delete-source-dataset`；证据损坏、success 审计写入或后续删除失败均回滚零业务写，事务外只 best-effort 追加 `rolled_back` 且不掩盖主错误；旧调用方与 legacy deletion 记录保持兼容 |
| PR 4 的调整写入只接受后端生成的 `rowKey` 与用户核对时的 `result_revision`，在同一 `BEGIN IMMEDIATE` 中追加不可变调整并递增 revision | renderer 不可信且同一坐标只允许一次；并发修改必须要求用户重新核对 | renderer 回传主体/分类后自行拼坐标；覆盖基础结果行 | 元数据从目标基础行反查，唯一约束与提交前 effective reader 断言共同防伪；成功后页面必须重新读取完整结果 |
| 完整结果页面只渲染后端固定九币种 review DTO，不在 renderer 做金额计算或把缺失值当 0 | 页面、归档和下月期初必须共享同一生效口径；空值补零会掩盖资金事实缺失 | renderer 基于基础行和调整行自行求和；宽松容忍缺币种 | 九币种、四类 summary 与规范十进制均严格校验；DTO 损坏或回读失败时归档 fail-closed |
| 结果操作失败与 review 健康度分离 | 调整候选为空/暂时读取失败或 `active-vcc-task` 不代表已展示结果不可信，不应永久禁用归档 | 任一异常统一设置 `reviewHealthy=false` | 修改失败清核对并提示；无候选仅禁用修改；并发已归档/revision 变化强制回读；归档临时占用允许重新勾选重试，输入/结构性错误仍失败关闭 |
| 重算替换在读取旧结果证据阶段失败也必须补写 rolled_back 审计 | 旧 run 若损坏，`collectRunEvidence()` 会在赋值完整 evidence 前抛错；原实现虽零删除但没有替换失败记录 | 仅依赖原始异常和数据库现状；为写审计而绕过严格 reader | 审计固化全部旧 run IDs、已成功采集的前缀、失败 run/code/message；业务事务先回滚且不删除损坏旧 run，审计失败仍只附加 `auditFailure` |
| PR 5 将用户提供的结果模板按文件名、SHA-256、14 列表头、物理/业务区域、打印区和唯一语义锚点完整校验，任何缺失或漂移均在解析输出路径前失败关闭 | 样式和业务行定位不能依赖脆弱固定行号；错误模板不得生成“看似成功”的财务文件或覆盖已有目标 | 模板漂移时回退代码内置样式；只校验 sheet 名/表头；先创建目标再校验 | 金标准模板保持只读；contract cache 按 path+stat+hash 隔离并深拷贝，半样式/旧缓存均不可复用；无 fallback |
| PR 5 writer 只消费 `getEffectiveRunResult()` 的基础行、调整行和四类生效汇总，调整血缘用可逆 Excel defined name 一对一绑定最终结果表 M 单元格 | 导出必须与页面/归档共享同一生效金额口径，并让人工调整能从 Excel 追溯到 `rowKey × currency` | 继续从基础表自行汇总；把 rowKey 写进可见业务列；用 comment/隐藏列作为非严格标记 | 调整紧邻目标基础行，M/N 可见；defined name 对多引用、跨表、区域、额外/重复标记均失败关闭，写后重开验证 |
| 历史导出 IPC/renderer 只提交 `targetMonth`，service 先取得全局直接任务租约再严格重查一致归档并派生 runId，租约持有到原子发布结束 | picker 打开后月份可能被解归档；信任 renderer runId 或租约外解析会串月/导出过期事实 | renderer 同时提交 runId；默认永远导出 latest；选择时解析一次后直接写 | 两年月份选择器默认最新但可选历史；导出与解归档双向互斥；无归档证据返回 `no-archived-results`，部分证据返回 `archive-state-inconsistent` |
| 页面与 Excel 表头复用同一严格十进制零值 helper；颜色仅标记固定九币种表头，差异数值格不着色 | Spec §4.6.3/Q10 将视觉提示范围锁定在九币种表头；页面和 writer 不能用 JS 浮点近似判零 | 页面和 writer 各自判断；同时给差异数值格上色 | `0`/`0.00`/`-0.00` 视为零，非法值抛错；差异行零值显示 `-`，非零显示原规范金额 |
| picker 的执行失败与随后月份刷新失败分开保留；刷新返回结构化 `{ok,error}`，空列表/不可执行是成功刷新 | OS 保存取消或失败后需要保留弹框重试，同时列表可能变化；吞掉刷新错误会留下禁用按钮且无解释 | 任一错误关闭弹框；刷新 catch 内吞；把不可执行当刷新异常 | 原月份仍在时显示原错误；被移除时自动切到新月份并要求确认重试；刷新自身失败追加说明且不覆盖原错 |
| PR 5 review 后将导出失败响应的 `detailLines` 过滤后保留到 renderer Error，并由主状态与 picker 统一显示 `message + 明细` | 模板缺失/漂移错误虽经 IPC 携带实际模板路径，旧 `responseFailure()` 只保留 message/code，用户无法定位真实文件；reviewer P2 复现 | 仅写日志；展示 error.stack/context；把路径拼进固定 message | 只展示显式结构化 detailLines，不泄漏无关 stack；模板实际路径在失败弹框内可见且仍可重试 |
| 调整原因行高按 N 列实际宽度与 Unicode 显示宽度确定性估算，仅 adjustment 行覆盖模板行高，并限制为 Excel 最大 `409.5pt` | 500 字调整原因虽启用 wrapText，但复制 15/17pt 固定行高会裁切；reviewer P2 复现 | 依赖 Excel 自动适配；扩大全部业务行；固定一个大行高 | ASCII 按 1、其他 Unicode 按 2 估算换行；validator 复用同一 helper；长文本可能触顶但单元格数据完整，基础行保持模板高度 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 未跟踪的其他 change、预览和输出文件不属于 v3.1.8 | 与 Spec 文件清单和目标模块无关 | 误提交用户资料 | 始终显式暂存；每次 commit 前检查 staged diff |
| 后续 PR 可暂时保持草稿和堆叠 base | 用户要求“按 Spec 里的多 PR 推进”且未要求每个立即合入 main | GitHub 展示/合并顺序需维护 | PR body 标明前序；前序合并后再重设 base |
| 旧结果行的 `category_major` 可能为空，不能在 PR 2 reader 中新增非空限制 | 当前 recharge/fee 取 `business_sub_type || ''`，channel 取 `mid || ''`，现有持久化契约允许空字符串 | 若生产事实始终非空则校验可更严格 | 继续将空值规范编码进 rowKey；未知/错配 `source_type` 仍严格拒绝 |
| 余额表存在“主体有九币种余额但本月无基础发生额行”是合法延续场景 | 上月归档主体本月无发生额仍必须进入结果与系统余额核对 | 若来源链路改变则可能掩盖孤儿余额 | 允许 balance-only 主体；反向要求每个基础行 subject+currency 必须存在 balance |
| 不可变调整账本的 `result_revision` 等于连续 sequence `1..N` 的记录数 | 每次新增调整只允许追加一次且 revision 加一；没有删除/编辑 API | PR 4 若引入不同 revision 语义会触发 reader 门禁 | PR 4 写入必须在单事务内追加 sequence=N+1 并 revision+1 |
| 严格 `YYYY-MM` 字符串可直接用于跨月先后比较 | 月份入口统一规范化且固定两位月份 | 非规范历史月份会被排除普通枚举并在直接 preview 失败 | 保持 `normalizeOperationMonth()` 为所有破坏性入口前置门禁 |
| 删除首月期初允许五类 dataset 中部分已被用户删除，但所有仍存在的 dataset 必须处于未归档状态 | 用户可能先删除某一原表；期初清理不应要求伪造缺失 dataset | 强制五表必须齐全；缺表即阻断 | 只删除期初和同月 calculated runs；first_month、剩余 dataset、源事实和导入审计保持不变 |
| `assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx` 在 PR 5 生命周期内是不可变 golden，SHA-256 固定为 `f920fd2161156314a0d523eacb7cf7d11f7002b7781fe9cca01b298edfa4a1f4` | 用户提供文件与 Spec 锁定 hash 一致 | 文件变化会使所有结果导出失败关闭 | 单测每次从磁盘重新 stat/read/hash；任何更新必须先由 PM/财务人员更新契约和验收基线，不能自动接受 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| Spec 建议六个提交 | 六个堆叠 PR，每个 PR 内可含少量聚焦提交 | 用户明确要求多 PR 推进 | 评审与回滚粒度更细，功能口径不变 | 是（本实施记录） |
| 共享归档月份选择器在 PR 3 先服务解归档，但历史结果按月份导出仍沿用“最新归档” | Spec 的 Phase 5 明确拥有月份导出和 writer；PR 3 只负责破坏性状态事务 | 在 PR 3 提前新增 get-by-month 导出契约 | 不影响 PR 3 解归档/删除验收；PR 5 必须接入同一 picker 并补历史月份导出测试 | 无需（既定阶段边界） |
| Spec 示例以模板业务末行为静态参考；实际导出按语义行计划重建结果表并将打印区动态收口为 `A1:L<实际末行>` | 调整行数量与主体业务分类会改变结果末行；固定 A1:L45 会留下样例行或截断新增行 | 保留模板原 45 行并原位覆盖；固定打印区 | M/N 仍保留为可见审计列但不进入模板锁定打印宽度；动态合并/打印区由 staged validator 回读验证 | 无需（Spec 已要求动态行与模板打印宽度） |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `git rev-parse HEAD` | `dff07df11fb94ce84940b474b55ac796f084d241` | 基线无漂移 |
| 两份模板 `shasum -a 256` | 分别匹配 `f7967d...a9fc`、`f920fd...1f4` | 用户资产身份 |
| PR 1 定向单测 | `104/104 PASS` | Pending 46/48 列契约与迁移、五表预检、原始数值精度、审计/导出兼容、renderer 接线 |
| PR #124 review 导出精度定向回归 | `node --test tests/unit/main-process/vcc-financial-op-dataset-writer.test.js` 返回 `6/6 PASS` | 原表/校验表重新打开后 JPY 为 `135886024.59`；其余显示列及 CNY→CNH 展示血缘不变；`balances_json` 缺失/非对象/币种缺失或重复/金额非法/读取证据不一致均结构化失败关闭 |
| 极老审计表回归 | 空残缺表可幂等补审计列；存在 Pending 行但缺 `raw_json` 时事务回滚且历史 hash 不变 | 迁移兼容与失败关闭 |
| 真实样本 `/Users/pzhong/Downloads/财务OP (22).xlsx` | PPHK JPY 读取为 `135886024.59`；检测到显示值 `135886024.6` 与原始值不一致并保留审计证据 | 原始数值优先及大额两位小数不被显示格式截断 |
| PR 1 `npm run release-check` | lint 通过；smoke 通过；unit `4587/4587 PASS`；integration `44/44` 脚本、`2051/2051` 断言通过 | 全仓静态检查、核心业务回归、迁移/大文件/side DB 集成门禁 |
| `gh auth status` | 默认账号 token invalid | 仅 GitHub 发布被阻塞 |
| PR 2 定向单测 | `39/39 PASS`（calculator 22、state/migration 8、effective result 9） | 首月 claim 原子回滚、同月新增主体增量初始化与漏交回滚、迁移诊断启动隔离、非首月/早于首月门禁、多失败 code/message 同源、run fingerprint/revision/timestamp、rowKey 稳定、防伪/金额边界、跨币种调整及基础表不可变 |
| `AppDatabase.init()` 多期初旧库回归 | 二次启动成功；`first_month` 保持 `NULL`；幂等诊断仅 1 条 | 诊断不扩大为全应用不可启动，同时 VCC 运行层保持失败关闭 |
| effective result 篡改矩阵 | forged rowKey/metadata、未知来源/币种、0/三位小数/NaN/Infinity/16 位金额、sequence/revision、重复坐标、空基础事实、余额脱节和公式篡改均按专用 code 阻断 | 调整账本、金额/币种语义、行数与余额血缘 |
| PR 2 `npm run release-check` | lint 通过；smoke 通过；unit `4609/4609 PASS`；integration `44/44` 脚本、`2051/2051` 断言通过 | 全仓静态检查、资金模块回归、大文件/side DB/迁移集成门禁 |
| PR 2 `npm run check:vars` | 仅命中通用词 `state`；实际未改 `src/renderer.js` 顶层 UI state，判定为扫描误报 | 已复核 UI 模块/模板列表/导出状态均无改动；PR body 仍保留关联功能 review 说明 |
| PR 2 reconciliation blindspot pass | 主键血缘、九币种、月份边界、幂等、事务回滚、基础表不可变和行/余额坐标守恒均有代码与测试证据 | 未发现自动删改或静默补零；首月期初与生效金额仍需发布前人工财务复核 |
| PR #125 review 增量主体回归 | calculator `22/22 PASS`；首月既有 PPHK 后新增 NEW 时 preflight/calculate 仅返回 NEW，仅提交 NEW 成功，PPHK 的金额/hash/说明与 `first_month` 不变；新增 NEW+NEW2 仅提交 NEW 时 NEW 写入回滚 | 修复已初始化主体被误判 omitted，同时锁定真正缺失主体、九币种和事务完整性 |
| PR #125 review 链路与变量门禁 | service/renderer `21/21 PASS`；`npm run check:vars` 扫描本次唯一 src 改动，未命中重要变量 | renderer 仍只提交缺失主体；未改 IPC/用户流程，未触及既有重要变量清单 |
| PR 3 破坏性事务定向单测 | 冻结代码全仓 unit 由 team-lead 复核 `4633/4633 PASS`；其中覆盖严格归档一致性、调整后余额、非尾月及孤立后月归档状态、token 失效统一返回 `state-changed`、期初/结果整体删除、事务故障和失败审计二次失败 | 破坏性操作失败关闭、原始错误优先、跨月血缘、源事实/first_month/调整证据守恒 |
| PR 3 真实 SQLite + 真实 worker 状态链 | `scripts/integration/vcc-financial-op-destructive-state-chain.js` 为 `52/52 PASS` | M1 非尾阻断→M2 解归档/删结果→M1 解归档/删期初；持久化审计、generation、`state-changed` token 门禁和触发器故障全链路 |
| PR 3 全量 integration | `45/45` 脚本、`2103/2103` 可计数断言通过；自动刷新 `rules/integration-test-policy.md` 第七节 | 新状态链纳入 auto-discovery 门禁，既有迁移、大文件、side DB 和其他业务集成无回归 |
| PR 3 冻结代码最终单次 `npm run release-check` | 在孤立后月 archive/archived dataset fail-closed 修复完成后执行：lint PASS；smoke PASS；unit `4633/4633 PASS`（295 个测试文件）；integration `45/45` 脚本、`2103/2103` 断言 PASS，其中破坏性 SQLite/worker 状态链 `52/52 PASS` | 最终发布门禁在同一次命令中完整覆盖静态检查、其他模块 smoke、全仓单测及全部集成链，证据对应当前冻结代码 |
| PR 3 静态与 smoke 回归 | `npm run lint` PASS；`npm run smoke` PASS；`git diff --check` PASS；新增/修改 JS `node --check` PASS | 主进程、preload、renderer 接线和其他模块基础回归 |
| PR 3 `npm run check:vars` | 命中 `ipcRenderer`（真实命中，main/preload/renderer 已同步并有契约测试）以及 `dialog`/`elements`/`setStatus`/`state`（仅 VCC renderer 局部命中，并非规则指向的 Electron dialog 或 `src/renderer.js` 全局单例）；无 Critical/Risk-sensitive 命中 | 已复核取消行为、DOM 生命周期、状态显示与归档导出联动，未发现旁路或不同步 |
| PR 3 P0→P1 自测 | P0：事务链、`state-changed` token 门禁、故障回滚、审计与行数守恒全部通过；P1：全局租约/取消保护、picker 默认最新/切年/非尾禁用、执行锁定、提交后刷新失败边界，以及期初初始化后必须再次点击运行，均由 service/renderer contract tests 通过 | 自动化覆盖本 PR 可重复场景；100%/125%/150% 视觉预览和真实财务月份仍留最终发布阶段人工门禁 |
| PR 3 reconciliation blindspot pass | 核对 run/archive/dataset 主键血缘、含调整九币种金额、严格月份边界、重复提交、部分失败、行数守恒、审计及错误可观测性 | 未发现资金红线被自动绕过；损坏归档失败关闭，真实月份逐主体逐币种复核继续阻塞发布 |
| PR 3 最终跨月血缘盲区回归 | 后月依赖改为 archived/calculated runs、archive 快照、archived datasets 的确定性排序去重并集；孤立 archive 和孤立 archived dataset 定向测试均返回 `unarchive-not-tail`，重复 preview 的月份/token 稳定且目标月资金状态零改动 | 保留完整 `laterRuns` 证据并将并集纳入 preview token；只阻断，不自动修复或级联损坏历史状态 |
| PR #126 来源删除审计修复定向回归 | dataset deletion、destructive actions、service 共 `36/36 PASS`；真实 SQLite + worker 状态链 `64/64 PASS` | success 证据完整保留 USD `12.34` 人工纠错、rowKey/sequence/reason、基础/生效结果、九币种余额和 Pending 汇总；删除后 run/adjustment/目标原表为 0；证据损坏、success audit failpoint、后续 DELETE failpoint 均零业务删除且只留 `rolled_back` |
| PR #126 来源删除审计修复静态门禁 | `npm run lint`、修改文件 `node --check`、`git diff --check` 均通过；`npm run check:vars` 仅命中通用局部变量名 `state` | 未修改 `src/renderer.js` 全局 Runtime-state，也未命中 Critical / Important-skeleton / Risk-sensitive；按清单将该命中记录为误报并保留人工复核说明 |
| PR 4 本机生产库只读探针 | 对 `/Users/pzhong/Library/Application Support/bank-bill-excel-tool/tool-data.sqlite` 使用 `DatabaseSync({ readOnly: true })` 并执行 `PRAGMA query_only=ON`；`vcc_fin_op_runs`、`vcc_fin_op_run_rows`、`vcc_fin_op_run_balances` 均存在且 count=0，升级前尚无 `vcc_fin_op_run_adjustments` | 本机没有存量 calculated/archived run 需要兼容非规范金额或空分类；仅证明这台机器当前事实，不能泛化到其他生产机器，迁移仍只允许新增空账本/列而不得猜测或改写资金值 |
| PR 4 调整/归档定向单测 | result-adjustments + calculator 覆盖合法/非法金额、500 Unicode 字符边界、rowKey/元数据防伪、坐标唯一、revision、effective 九币种、归档和重算替换事务；证据采集阶段损坏时亦零删除并写 rolled_back 审计 | 调整账本不可变、金额/币种语义、失败原错优先、旧结果证据和跨期归档血缘 |
| PR 4 service/IPC/usage/renderer 契约测试 | 调整 options 为不计数查询，成功 add 计“修改结果”且持有全局租约；full-result get/manager row/revision/preload 对称；renderer 严格消费后端 DTO、失败策略可重试、归档 revision gate 和已归档只读 | IPC 旁路、usage 误计、并发状态污染、renderer 自算金额和核对状态未清除 |
| PR 4 真实 SQLite + 真实 worker 调整归档链 | `scripts/integration/vcc-financial-op-adjustment-archive-chain.js` 直接执行 `55/55 PASS` | M1 计算→调整→关闭重开→九币种生效归档→M2 从调整后 USD `104.25` 继承期初并计算至 `107.25`；同时覆盖 stale revision、归档锁定、版本元数据和完整审计 |
| PR 4 Electron 结果/调整预览 | `/private/tmp/codex-vcc-pr4-result.png` 与 `/private/tmp/codex-vcc-pr4-adjustment.png` 均成功生成 2480×1720 截图；调整预览入口可重复执行 | 完整结果宽表、调整行/revision/归档控件，以及主体→大类→分类→币种→调整值→原因、取消/确认顺序和桌面双列布局视觉通过；520px 单列由 renderer/CSS 契约测试锁定 |
| PR 4 冻结代码最终单次 `npm run release-check` | lint PASS；smoke PASS；unit `4654/4654 PASS`（295 个测试文件）；integration `46/46` 脚本、`2158/2158` 断言 PASS，其中 PR 4 真实 SQLite/worker 调整归档链 `55/55 PASS` | 同一次命令完整覆盖静态检查、其他模块 smoke、全仓单测及全部集成链；证据对应冻结代码，但不替代真实财务月份和 Windows 发布门禁 |
| PR 4 `npm run check:vars` 与人工 review | `ipcRenderer` 为真实命中：main/preload 通道对称且已有契约测试；`MODULES` 仅被 preview 路由引用，未修改枚举；`dialog`、`setStatus`、`state` 均为 VCC renderer 局部命名或局部状态，不是规则指向的 Electron `dialog` 或 `src/renderer.js` 全局 `state`；无 Critical/Risk-sensitive 命中 | ⚠️ 关联功能 review 已覆盖 IPC 对称性、preview 路由、局部弹框/状态生命周期；未发现重要变量旁路或全局状态污染 |
| PR 4 发布门禁复核 | 自动化与本机视觉证据均不能替代真实财务事实及目标平台验证 | 真实财务月份逐主体逐币种核对、Windows 打包及 Excel/WPS 显示仍阻塞 3.1.8 发布 |
| PR 5 模板/金额/renderer 定向单测 | result-template contract、共享判零 helper、writer、service、破坏性 resolver 与 renderer picker 覆盖模板 SHA/锚点/缓存、九币种金额、样式故障、血缘负向矩阵、原子不覆盖、targetMonth 租约、空态和失败重试 | 模板漂移、串月导出、浮点判零、样例泄漏、血缘孤儿、刷新错误吞没 |
| PR 5 ExcelJS defined name 探针 | 金标准 rowKey 标记经 write→reopen 后仍精确引用 `'财务OP校验结果表'!$M$2`，可逆还原完整 `v1:64hex + JPY` | 证明当前 ExcelJS 版本可承载非业务可见列的严格调整血缘；validator 仍对异常引用失败关闭 |
| PR 5 真实 SQLite + 金标准模板历史导出链 | `scripts/integration/vcc-financial-op-historical-template-export.js` 直接执行 `28/28 PASS` | 两个一致归档月份倒序枚举；显式选择旧月严格导出旧 run；调整 M/N、effective 汇总、动态 printArea 和 named-range 写后回读均正确，未回退 latest；latest 真实 worker 解归档后立即从枚举消失并以 `no-archived-results` 禁止再次导出；正式 service 重新归档后恢复为 latest 候选和严格 resolver |
| PR 5 可重复 UI 预览入口 | `preview:vcc-financial-op-result-export-month` 使用静态 2026/2025 两年归档月份并复用蓝色【导出】picker；已串入 `preview:vcc-financial-op` | PR 6 可在不依赖本机数据库的情况下生成最终历史月份导出截图；本 PR 不提交截图资产 |
| PR 5 reviewer P2 定向回归 | renderer + writer 两文件 `36/36 PASS`；PR 5 六文件组合 `70/70 PASS`；历史月份真实 SQLite + 金标准模板链 `28/28 PASS`。500 字 Unicode 原因 write→reopen 后 adjustment 行为 `409.5pt`、wrapText 保留、相邻基础行仍为模板 `15pt`；结构化模板错误测试确认 code/message/detailLines 保留、实际路径可见且 stack 不展示 | 模板错误可观测性、长调整原因裁切、基础行样式回归、staged validator 同口径，以及历史月份导出/解归档/重归档链无回归 |
| PR 5 reviewer P2 修复后最终单次 `npm run release-check` | lint PASS；smoke PASS；unit `4673/4673 PASS`（297 个测试文件）；integration `47/47` 脚本、`2186/2186` 断言 PASS，其中 VCC 历史月份模板导出链 `28/28 PASS` | 同一次命令覆盖静态检查、基础 smoke、全仓单测和全部集成链；证据对应最终冻结代码 |
| PR 5 最终 `npm run check:vars` 与人工 review | 仅命中 `MODULES`、`elements`、`setStatus`、`state`；`MODULES` 只新增 preview route，后三者均为 VCC renderer 局部变量；无 Critical/Risk-sensitive 命中 | 已复核导出可用性、错误状态展示和模块路由，未发现重要变量旁路或全局状态污染 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 生产历史 Pending raw_json 是否有未知列数 | PROBE | Codex 在 PR 1 建 dry-run 迁移测试；运行时异常 fail-closed | 阻塞 PR 1 合并 |
| Windows 打包资产与 Excel/WPS 实际显示 | PROBE + 人工门禁 | PR 6 Windows CI 与财务人员 | 阻塞版本发布 |
| GitHub 登录恢复 | BLOCK（发布） | 用户执行 `gh auth login -h github.com`，Codex 复检 | 阻塞 push/PR，不阻塞实现 |
| 真实月份逐主体逐币种复核 | BLOCK（发布） | 财务人员按最终核对清单执行 | 阻塞 3.1.8 发布 |
| 其他生产机器的存量 calculated run 是否存在空分类或被手工改写的非规范金额 | PROBE + fail-closed | 本机生产库只读探针确认 run/row/balance 均为 0；其他机器仍须在升级前只读扫描，异常 run 要求重跑 | 不得把本机“无存量 run”结论泛化；可能要求异常旧 run 重新运行，不允许静默归档 |
| PR 4 调整写入事务能否始终保持 `sequence=N+1` 与 `result_revision=N+1` | 已用事务/唯一约束/故障与 stale revision 单测消除 | 继续由 `getEffectiveRunResult()` 在每次读取、归档和审计时复核连续 sequence/revision | 当前不阻塞 PR 4；任何账本漂移仍按结构化错误失败关闭 |
| 生产历史 archived run 是否存在 archive subject/九币种/effective result/dataset 不一致 | PROBE + fail-closed | 合入前对生产副本执行只读枚举/preview；异常月份人工核账，不自动修复 | 异常月份不可解归档/导出，但不污染其他月份 |
| Windows 退出过程中已保护 worker 的真实时序 | PROBE/平台测试 | PR 6 Windows CI/手测在解归档和删除事务中触发关窗，验证应用等待任务收口 | 阻塞 3.1.8 发布，不阻塞 PR 3 代码评审 |
