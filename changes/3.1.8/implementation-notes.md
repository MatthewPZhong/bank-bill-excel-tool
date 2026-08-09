# Implementation Notes

## Baseline

- Goal/spec source: `/Users/pzhong/Downloads/v3.1.8-codex-spec-final.md`，原始 SHA-256 `9f3af33df52907499ec673b20f808b7615e7edf10231a33508c8eb5acd2a76de`；仓库内最终规范为 `changes/3.1.8/spec.md`；Q01～Q12 全部锁定。
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
| 系统财务OP金额以 workbook relationship 指向 worksheet 的原始 `<v>` lexical token 为第一权威源 | SheetJS 在形成 `Number` 前可能已合并大额分币，显示值也可能被单元格格式截断 | 继续信任 SheetJS `raw:true` Number；从显示文本反推 | 公式使用缓存 `<v>`；重复余额 cell、空/损坏 XML 稳定以 `amount-precision-invalid` 失败关闭；只有明确缺少 OOXML relationship/entry 时才进入 Number fallback |
| OOXML 缺失时的 Number fallback 允许安全整数，非整数在 `abs(value) >= 2^46` 时拒绝 | 15 位整数在 `Number.isSafeInteger` 时可精确证明；`2^46` 起浮点相邻间距已不能保证分币唯一 | 所有大于低阈值的 Number 一律拒绝；继续放行至 `MAX_SAFE_INTEGER` | 合法 15 位整数不误伤，大额非整数缺 lexical 证据时 fail closed；最终仍受两位小数与 15 位有效数字门禁约束 |
| 财务OP运行必须同时通过主进程 service 与 worker 内 `expectedInputFingerprint` 校验 | 可选 fingerprint 允许绕过“预检确认 → 事务内二次预检”的状态一致性门禁 | 仅依赖 renderer 总会传参；只在主进程入口校验 | 缺失、格式非法或与最新状态不一致均不写计算结果；伪造 64 位值只能进入 `state-changed`，不能放行 |
| preflight 以稳定顺序返回完整 `issues[]`，renderer 逐条展示；损坏系统快照不再冒充 missing dataset | 单一 top-level code 会遮蔽同账期其它待处理问题，用户需反复运行才能逐个发现 | 保留 first-error-only；把 invalid snapshot 继续塞入 `missing` | 兼容保留 top-level code/missing 等字段，同时一次展示 active、缺失/空表、快照损坏、归档、未处理导入和主体差异 |
| 后置候选表头通过 row-scanner 的按行稀疏全宽模式校验到 XFD | 原扫描器只有物理第 1 行全宽，后置 Pending 表头的 BM/XFD 增列会被 64 列预览截断 | 将所有行稠密扩到 16384 列；只扩大固定预览宽度 | 普通数据行契约不变；候选行只物化实际非空 cell，XFD fixture 仅有 2 个数组键；正式读取再次全宽核验命中表头行 |
| `systemRowError` 同时保留顶层定位字段与 JSON-safe `context` | worker 错误序列化只透传 `context`，原顶层 `sourceRow/fieldName/sheetName` 会在主进程丢失 | 扩展全局 serialize-error 的专用字段列表 | 保持库内旧调用兼容，跨 worker 的 `amount-precision-invalid` 仍可定位 sheet、行和字段 |
| GitHub 认证问题不阻塞本地实现 | `gh` 已安装但 token 失效；代码和测试均可离线推进 | 等待登录后才开始编码 | push/PR 创建仍明确阻塞，不能声称已发布 |
| 将锁定规范纳入仓库，业务内容只反向同步 §10.4 的两处真实发布文档路径，并把前五行双空格硬换行改为等价 `<br>` | Downloads 原文件不是可随代码评审的仓库证据，其中 `VERSION_FEATURE_HISTORY.md`、`USER_GUIDE.html` 与仓库真实位置不符；双空格又会使完整 diff-check 报错 | 继续仅引用 Downloads；照抄错误路径；把格式修复误记为业务变更 | `changes/3.1.8/spec.md` 的业务差异仅为 `docs/VERSION_FEATURE_HISTORY.md`、`docs/USER_GUIDE.md` 两处路径；五处换行仅是语义等价格式修复。原文件、格式修复前阶段和当前文件三组哈希分别留证 |
| PR 2 将首月事实诊断拆到无迁移依赖的 `state-model.js` | 运行时 repository 不应反向依赖 migrations；迁移和运行门禁必须共享同一严格月份诊断 | repository 直接导入 migrations；复制两套判断 | 避免依赖环和迁移副作用，旧库诊断与运行门禁口径一致 |
| 多期初月份/畸形月份只记录幂等诊断并阻断 VCC 功能，不让 `AppDatabase.init()` 整体失败 | Spec 要求不自动删改资金事实；桌面应用仍需启动供诊断和其他模块使用 | 启动抛错；自动选择最早月份并覆盖 | 资金事实原样保留；preflight/calculate/initialize fail-closed |
| 首次人工期初写入和 `first_month` claim 放在同一 `BEGIN IMMEDIATE` 事务 | 首月是全局永久事实，不能出现余额已写但首月为空或反向状态 | 先写余额后单独更新状态；只靠 UI 串行 | claim 失败时余额与状态同时回滚；同月同内容重放幂等 |
| 首月期初提交完整性只检查 `subjects - opening.balances` 的真正缺失主体 | PR #125 review 证明 preflight/renderer 只向用户收集 `missingOpeningSubjects`；要求重复提交已初始化主体会阻断同月新增主体 | 每次提交全部主体；跳过完整性检查 | 已初始化主体无需重复提交；主动重放已初始化主体仍按 content hash 幂等跳过或拒绝改写，真正漏交的新主体仍整事务回滚；属于既定契约缺陷修复，不改 Spec |
| `rowKey` 固定为 `v1:sha256(JSON.stringify([row_kind, subject, source_type, category_major || '', category_minor || '']))` | 调整坐标必须跨币种稳定，又不能受 run/id/金额/展示顺序影响 | 使用数据库行 id；把币种或金额纳入 key | 同一逻辑行不同币种共享 rowKey，以 `rowKey × currency` 构成调整坐标 |
| PR 2 的 `getEffectiveRunResult()` 仅做只读统一重算，并严格核对 sequence/revision/基础公式/坐标 | 基础 `run_rows`、`run_balances` 必须不可变；损坏的调整账本不得静默参与归档 | 就地覆盖基础表；遇到损坏记录跳过 | PR 4 已复用同一 reader 接入调整写入与归档；任何事实不一致均结构化失败 |
| 生效结果的基础行与不可变调整先用 `DecimalAccumulator` 无损聚合，仅在每个最终可见字段分别执行 15 位有效数字校验 | PR #125 review 证明 `999999999999999 + 1 - 1` 的合法抵消链会被中间值校验误拒；计算器既有契约也是“全量聚合后再校验最终值” | 每一步调用 `canonicalizeVccAmount`；改用 `Number`；对整个 DTO 只做一次总校验 | 合法抵消可通过，真实最终溢出继续 fail-closed；`base-period`、`adjustment-total`、行级和余额级字段各自独立封顶，不允许跨字段掩盖溢出 |
| 最终金额溢出统一返回 `result-amount-out-of-range`，稳定坐标放入 JSON-safe `error.context` | worker 的 `serializeError()` 只保留 `code/detailLines/context`；仅挂顶层 `scope/field/rowKey/value` 会在跨线程后丢失 | 只依赖错误 message；只保留任意顶层属性 | 调用方跨 worker 仍可读取 scope、field、rowKey/summary 坐标和原始十进制值；真实错误已做 `serializeError → deserializeError` 往返回归 |
| PR 1 合入 PR 2 时，保留 PR 1 的强制 fingerprint 与完整 `issues[]`，并合并 PR 2 的 module/openingState 门禁 | 两分支分别收紧预检时序与首月资金状态，任一侧被覆盖都会形成绕过；用户在知悉资金红线后明确批准合并规则 | 任选一侧解决冲突；让 openingState 覆盖其它输入问题；把首月待初始化当预检错误 | `migrationDiagnostic` 去重后保持首项；active、缺/空表、非法快照、归档、未处理记录、主体问题按稳定顺序；其它 blocked opening 后置；`first-month-initialization-required` 仅在无其它 issue 时随成功 preflight 进入初始化流程；primary code 取首项，message 聚合全部 |
| PR 3 的归档枚举和解归档均复用同一套严格一致性检查，并逐主体逐九币种比对含调整的生效余额 | 单看 `run.status` 会把缺 archive、错 run、混合 dataset 或余额漂移暴露为可操作月份 | 宽松枚举后在提交时尽力修复；只比基础 calculated balance | 损坏月份不进入普通枚举；直接 preview 返回 `archive-state-inconsistent` 并失败关闭 |
| 所有 VCC worker/直接任务共享一个全局任务租约，任务代次仅在释放租约时递增 | preview token 需要同时防数据库状态漂移和预览后插队任务；导出、归档、期初初始化、异常处理等直接写也不能旁路 | 只互斥 worker；获取租约即递增代次 | preview 与提交按 generation 二次门禁；任何在先任务完成后旧预览失效 |
| 破坏性 worker 在 `openDb()` 和 migration 之前先完成 `critical-ready → 父进程保护 → critical-ack` 握手 | 打开数据库本身可能产生 migration 写事务；父进程必须在允许写入前承诺不 terminate | 事务开始后再通知；超时一律 terminate | 仅事务前任务可协作取消/超时终止；已保护或状态未知任务只能等待收口 |
| 解归档、删除期初、删除结果先在 `BEGIN IMMEDIATE` 中重算 token/门禁并固化完整证据，成功审计与业务写同事务；失败后尽力补写 rolled_back 审计 | 防止预览后状态变化、部分成功和审计先后不一致 | 事务外审计；只记录计数摘要 | 成功审计不会脱离业务提交；回滚后保留失败原因，失败审计自身异常仅附加为 `context.auditFailure`，不覆盖主错 |
| 统一删除目标使用独立 `targetType` 表达五类源表、首月期初和结果，不伪造 `source_type` | opening/result 不属于导入源类型，伪造会污染数据契约和 usage 统计 | 复用假的 source type 常量 | 旧 source 删除 preload 方法名保持兼容，但提交同样强制携带用户已观察的 token/generation，不再自动 preview；动态 usage 仅将 result 成功路由为“删除结果”，source/opening 沿用业务 operation label“删除数据”，不误计为“删除结果” |
| UI 把破坏性执行成功视为不可逆边界：提交成功后保持执行锁定，完成 `onCompleted` 刷新后再关闭；刷新失败也关闭并警告，不重开或重试提交 | 重开弹框会诱导用户对已成功事务重复操作 | 将执行与刷新放在同一 catch 后恢复按钮 | renderer 明确显示“操作已成功但刷新失败”，执行中 Esc/遮罩/关闭均被锁定 |
| 首月期初初始化成功后立即结束当前【开始运行】流程，要求用户再次显式点击后才重新预检和计算 | Spec §4.2.5 禁止初始化后自动沿用当前点击继续计算或归档；资金结果需要新的明确用户动作 | 初始化成功后在同一调用栈自动 preflight/calculate | 成功状态和弹框均明确提示再次点击；renderer 契约测试禁止初始化后分支出现 preflight/calculate/archive |
| 来源原表删除在同一 `BEGIN IMMEDIATE` 内按 run id 顺序先固化完整生效结果证据，再写 success operation audit，最后执行既有级联删除与 legacy deletion 记录 | PR #126 review 证明原实现先删 `run_adjustments`/run，只留下计数，无法还原人工纠错、基础结果和九币种余额 | 仅扩大 `vcc_fin_op_dataset_deletions` 计数字段；删除后再尽力拼证据 | operation type 固定为 `delete-source-dataset`；证据损坏、success 审计写入或后续删除失败均回滚零业务写，事务外只 best-effort 追加 `rolled_back` 且不掩盖主错误；旧调用方与 legacy deletion 记录保持兼容 |
| 系统财务OP首次成功写 snapshot 时同步写一条引用该 snapshot 的 `accepted` attempt；删除历史 snapshot 前检查所有 linked disposition 的 `existing_*` 为空或与 snapshot 精确一致，仅 accepted 额外要求 incoming 唯一完整一致 | `materializeSystemAudit` 会对 skip/conflict/rolled_back 同样执行 `COALESCE` 物化和 FK 解除；只校验 accepted 会让非 accepted 的非空错值原样保留后成功删快照 | 只依赖后续幂等重试；只检查 accepted；用新正确回填掩盖旧错值 | 新导入天然具备首次成功审计；历史缺失可幂等补录；全部 linked attempt 物化后必须与 snapshot 精确一致，accepted 另保持 0→补 1/唯一 incoming 规则；任一错值、重复或部分失败均整体回滚 |
| `protected === true` 是取消超时后无限等待的唯一判据；`critical-ready` 但未 ACK/未 protected 的 worker 仍可安全 terminate | 用户先取消或关窗后 worker 才发 `critical-ready` 时，父进程不会发 ACK，worker 不可能进入数据库事务；旧逻辑却把 phase 当成 protected 永久等待 | 看到 `critical-ready` 就无限等；所有 timeout 都强杀 | 已 ACK 的事务继续只等待；取消在先的握手窗口超时后强制终止并释放全局租约，避免关窗悬挂 |
| 四类破坏性事务在 COMMIT 前对全部 VCC 表建立“目标月允许集 + 其他月份/全局零漂移”指纹；run child 按父 run 月份、import error 按父 record 月份归属，孤儿按全局事实保护 | 仅 target month 指纹无法发现 trigger 删除/篡改其他月；跨月错链还会被目标 materializer 按 FK 更新并清空 | 仅保护目标月；为所有事实加载数组；依赖 FK 正常而忽略孤儿 | 全部查询使用稳定列/NULL/类型 framing 的 `iterate()` 增量 SHA-256，额外内存不随行数增长；source 删除只归一化允许的目标审计物化、成功记录删除标记和 accepted backfill，跨月错链和其他月 silent trigger 均回滚 |
| effective/import/system snapshot/attempt 的 `raw_json` 与 `existing_raw_json_snapshot` 直接进入逐行流式指纹，不再只比较 length/content hash | silent trigger 可做同长度 raw 改写且不更新 content_hash，原投影会把资金审计载荷漂移视为未变化 | 信任持久化 content_hash；只比较字符串长度 | 六类同长度 raw 改写回归均触发事务回滚；原始载荷只进入 hash，不进入错误 context |
| 旧 operation audit 以事务前 max id 为边界纳入全局指纹；边界后必须恰好一条本次 success audit，并明确断言 id/month/type/run/status/token/evidence hash 与构建字段 | success audit INSERT trigger 可篡改旧审计或本次 evidence/metadata，业务事务仍可能提交伪造审计 | 完全排除 operation audit；只相信 `lastInsertRowid` | 旧行任何漂移、新行篡改或额外插入均在 COMMIT 前回滚；错误只携带 metadata/count/hash，跨 worker 序列化不泄露 evidence/raw |
| opening/result/source 删除在所有业务写完成后、COMMIT 前最后重跑目标月全 status run/全子表与操作专属零残留断言；允许新行以事务前 max-id 精确限定 | broad target exclusion 会漏掉 success audit、dataset deletion 或 import-record UPDATE trigger 后置新建 archived run/child、目标 source/dataset、attempt 或 deletion row | 只依赖中途 postcondition 或 preserved fingerprint；只按 `status='calculated'` 查残留 | operation audit 边界后恰 1 条；source deletion 边界后恰 1 条且字段一致；system attempt 物化前不得越过 preserved boundary，物化后仅允许记录的 backfill fingerprint/max/count；后置重建全部回滚 |
| 每个破坏性事务在 `BEGIN IMMEDIATE` 后仅从 SQLite 读取一次 localtime，success audit、source deletion/import deletion/system backfill 及 unarchive run/dataset 时间线都显式写入并精确断言该值 | 仅断言时间非空会让 trigger 写入等长错误时间仍提交；多次 `datetime('now')` 也不能证明同一事务时间线 | 使用 column default/各 SQL 自行取时；只做 truthy 检查 | 同一事务的 `operation_audit.created_at`、`dataset_deletions.deleted_at`、`import_records.dataset_deleted_at`、本次 backfill `created_at` 与 unarchive `updated_at` 可相互对账；任一非空错值均回滚 |
| 破坏性提交统一要求非空 preview token 和显式安全 generation，并移除 worker legacy `delete-dataset` action | 参数解构默认和 service 预先 `Number('')` 会把缺失代次降为 0，低层或旧 worker action 可绕过用户已观察状态确认 | 只在 acquireTask/部分低层校验；缺失值按 generation 0 执行 | service 在创建 worker 前对 raw payload 调用统一 validator；unarchive 与 unified source/opening/result 内部入口继续防御，缺失/null/空串/NaN/负数/超范围均不进入业务事务 |
| 损坏归档月在继续排除普通枚举的同时通过注入 logger 输出固定结构事件 | PR 3 的 fail-closed 枚举原先静默 `continue/catch`，生产无法发现 run/archive/dataset 漂移 | 向用户枚举返回损坏月份；日志失败时中断枚举 | 从后续 PR 5 最小回移到 PR 3 的 `archiveConsistencyLogger`；日志异常仅影响旁路观测，不会让损坏月重新可操作 |
| PR 4 的调整写入只接受后端生成的 `rowKey` 与用户核对时的 `result_revision`，在同一 `BEGIN IMMEDIATE` 中追加不可变调整并递增 revision | renderer 不可信且同一坐标只允许一次；并发修改必须要求用户重新核对 | renderer 回传主体/分类后自行拼坐标；覆盖基础结果行 | 元数据从目标基础行反查，唯一约束与提交前 effective reader 断言共同防伪；成功后页面必须重新读取完整结果 |
| 完整结果页面只渲染后端固定九币种 review DTO，不在 renderer 做金额计算或把缺失值当 0 | 页面、归档和下月期初必须共享同一生效口径；空值补零会掩盖资金事实缺失 | renderer 基于基础行和调整行自行求和；宽松容忍缺币种 | 九币种、四类 summary 与规范十进制均严格校验；DTO 损坏或回读失败时归档 fail-closed |
| 结果操作失败与 review 健康度分离 | 调整候选为空/暂时读取失败或 `active-vcc-task` 不代表已展示结果不可信，不应永久禁用归档 | 任一异常统一设置 `reviewHealthy=false` | 修改失败清核对并提示；无候选仅禁用修改；并发已归档/revision 变化强制回读；归档临时占用允许重新勾选重试，输入/结构性错误仍失败关闭 |
| 重算替换在读取旧结果证据阶段失败也必须补写 rolled_back 审计 | 旧 run 若损坏，`collectRunEvidence()` 会在赋值完整 evidence 前抛错；原实现虽零删除但没有替换失败记录 | 仅依赖原始异常和数据库现状；为写审计而绕过严格 reader | 审计固化全部旧 run IDs、已成功采集的前缀、失败 run/code/message；业务事务先回滚且不删除损坏旧 run，审计失败仍只附加 `auditFailure` |
| PR 4 对含人工调整的已归档结果在旧 writer 前临时失败关闭 | PR 4 的 writer 仍直接读取基础 `run_rows/run_balances`，而归档和下月期初已读取生效结果；继续导出会让同一 run 出现两套资金口径 | 让旧 writer 静默导出基础值；在 PR 4 提前实现 PR 5 语义模板 writer | 在全局导出租约及归档一致性检查后，若调整数大于 0，返回稳定 `adjusted-result-export-unsupported`、中文提示和 run/月/调整数上下文，writer 零调用；无调整历史归档保持兼容。PR 5 仅在 writer 改为消费生效结果且补足 readback 回归后解除此闸 |
| PR 3 → PR 4 restack 使用双父非快进 merge，并按安全边界逐块合并冲突 | PR 3 已在结构化 preflight/fingerprint、最终值 DecimalAccumulator、破坏性事务 exact allowset 与 worker 保护协议上形成更严格基线；PR 4 另有调整账本、review DTO、导出临时闸和 IPC 错误保真 | rebase/force；任选一侧覆盖冲突；放宽 fingerprint 兼容旧测试 | calculator 同时保留必填 64 位 fingerprint、最终值聚合与 replacement audit；service 同时保留 critical/task/generation 链和 adjusted export guard；测试调用改为携带真实 preflight fingerprint，生产门禁不降级 |
| PR 5 将用户提供的结果模板按文件名、SHA-256、14 列表头、物理/业务区域、打印区和唯一语义锚点完整校验，任何缺失或漂移均在解析输出路径前失败关闭 | 样式和业务行定位不能依赖脆弱固定行号；错误模板不得生成“看似成功”的财务文件或覆盖已有目标 | 模板漂移时回退代码内置样式；只校验 sheet 名/表头；先创建目标再校验 | 金标准模板保持只读；contract cache 按 path+stat+hash 隔离并深拷贝，半样式/旧缓存均不可复用；无 fallback |
| PR 5 writer 只消费 `getEffectiveRunResult()` 的基础行、调整行和四类生效汇总，调整血缘用可逆 Excel defined name 一对一绑定最终结果表 M 单元格 | 导出必须与页面/归档共享同一生效金额口径，并让人工调整能从 Excel 追溯到 `rowKey × currency` | 继续从基础表自行汇总；把 rowKey 写进可见业务列；用 comment/隐藏列作为非严格标记 | 调整紧邻目标基础行，M/N 可见；defined name 对多引用、跨表、区域、额外/重复标记均失败关闭，写后重开验证 |
| PR 5 restack 在语义 writer 证据闭环后移除 PR 4 的 adjusted-result 临时门禁 | PR 4 的失败关闭只为阻止旧 writer 导出基础值；PR 5 已让 writer 消费 `getEffectiveRunResult()`，且真实链逐行回读 D:L、M:N、defined names、归档审计和次月九币种期初 | 永久保留临时门禁；绕过 service 直接调用 writer | 仅删除 `adjusted-result-export-unsupported` 常量、调整 COUNT 拦截及其专属阻断断言；保留 `targetMonth`、全局租约、归档一致性重查、原子发布和结构化 IPC 错误，不改变金额/币种/状态契约 |
| 历史导出 IPC/renderer 只提交 `targetMonth`，service 先取得全局直接任务租约再严格重查一致归档并派生 runId，租约持有到原子发布结束 | picker 打开后月份可能被解归档；信任 renderer runId 或租约外解析会串月/导出过期事实 | renderer 同时提交 runId；默认永远导出 latest；选择时解析一次后直接写 | 两年月份选择器默认最新但可选历史；导出与解归档双向互斥；无归档证据返回 `no-archived-results`，部分证据返回 `archive-state-inconsistent` |
| 页面与 Excel 表头复用同一严格十进制零值 helper；颜色仅标记固定九币种表头，差异数值格不着色 | Spec §4.6.3/Q10 将视觉提示范围锁定在九币种表头；页面和 writer 不能用 JS 浮点近似判零 | 页面和 writer 各自判断；同时给差异数值格上色 | `0`/`0.00`/`-0.00` 视为零，非法值抛错；差异行零值显示 `-`，非零显示原规范金额 |
| picker 的执行失败与随后月份刷新失败分开保留；刷新返回结构化 `{ok,error}`，空列表/不可执行是成功刷新 | OS 保存取消或失败后需要保留弹框重试，同时列表可能变化；吞掉刷新错误会留下禁用按钮且无解释 | 任一错误关闭弹框；刷新 catch 内吞；把不可执行当刷新异常 | 原月份仍在时显示原错误；被移除时自动切到新月份并要求确认重试；刷新自身失败追加说明且不覆盖原错 |
| PR 5 review 后将导出失败响应的 `detailLines` 过滤后保留到 renderer Error，并由主状态与 picker 统一显示 `message + 明细` | 模板缺失/漂移错误虽经 IPC 携带实际模板路径，旧 `responseFailure()` 只保留 message/code，用户无法定位真实文件；reviewer P2 复现 | 仅写日志；展示 error.stack/context；把路径拼进固定 message | 只展示显式结构化 detailLines，不泄漏无关 stack；模板实际路径在失败弹框内可见且仍可重试 |
| 调整原因行高按 N 列实际宽度与 Unicode 显示宽度确定性估算，仅 adjustment 行覆盖模板行高，并限制为 Excel 最大 `409.5pt` | 500 字调整原因虽启用 wrapText，但复制 15/17pt 固定行高会裁切；reviewer P2 复现 | 依赖 Excel 自动适配；扩大全部业务行；固定一个大行高 | ASCII 按 1、其他 Unicode 按 2 估算换行；validator 复用同一 helper；长文本可能触顶但单元格数据完整，基础行保持模板高度 |
| 用户文档明确披露 M/N 可见但默认打印区保持 A:L | 调整值与原因必须在电子表格中可见且可审计，但用户提供模板锁定的默认打印宽度不包含 M/N | 静默扩大打印区；不解释纸质记录缺少调整列 | 保持模板打印口径；需要纸质调整证据时由用户在 Excel/WPS 手动扩展打印区，并列入 Windows 人工门禁 |
| 合成预览入口只在主进程确认 `APP_CAPTURE_PATH` 后向 preload 暴露只读 `previewCapture=true`，VCC 假数据 hook 仅在该标志为真时挂载 | 仅凭 `APP_PREVIEW_MODAL` 或生产 renderer 全局 hook 会形成伪造业务状态的旁路 | 生产环境始终挂载 hook；只用环境中的 modal token 作为门禁 | 正常启动时 `window.__vccFinancialOpPreview` 不存在；capture hook 冻结且不可写，preview modal/zoom/窗口尺寸均受同一 capture gate 约束 |
| 预览 PNG 先写同目录本轮 staging，Electron 非 0 退出或 PNG 结构不完整时保留旧图；仅验证通过后原子 rename | 直接写正式截图会在 capture 失败时留下截断图，或让旧图冒充本轮成功证据 | 启动前删除旧图；只校验 8 字节签名 | 校验 signature、13 字节 IHDR、正尺寸、非空完整 IDAT、IEND 且恰好 EOF；失败返回非 0，旧证据不动 |
| Windows PR 构建对任意目标分支执行完整发布检查，并实际构建 x64 installer/portable 后运行分发守卫 | 旧 workflow 跳过 PR build，且架构未锁定时可能检查陈旧 `win-unpacked` | 仅做静态 workflow lint；继续依赖本机旧 dist | 本地/PR/Release 构建统一 `--x64`；分发守卫校验两份 VCC 金标准模板及包内版本，目标平台产物仍须 CI 与人工打开确认 |
| PR 6 reviewer P2 将全部 26 个 `vcc-financial-op-*` capture token 冻结为显式 `sync / state / lifecycle` readiness 契约，并由主进程对此前缀统一失败关闭 | 数据管理、删除、导出等弹框依赖异步状态；结果/导入/运行/调整等入口返回的 Promise 却代表“弹框关闭”，若统一 await 会死锁，若统一固定延时会截到旧状态 | 继续只门禁解归档 4 个 token；所有 hook 都 await 返回 Promise；用固定 sleep 猜状态 | `state` 入口必须返回并等待真实 DOM 状态 tracker，`lifecycle` 入口只探测同步/立即拒绝而不等待关闭，`sync` 入口禁止意外 Promise；未知 token、缺 hook/method、null、同步抛错、拒绝、非法结果或 8 秒超时均以非 0 退出，staged PNG 不得晋升 |
| PR 6 self-review 将 RSS 增长分为“低信号有界”与“可测增长”，并把两档扫描改为独立 `--expose-gc` 子进程 | tier1/tier2 同时加减 8MB 会使 `13→39MB`、行数比 3 的精确线性增长通过；同进程先后扫描又会混入 allocator 复用 | 双侧不确定性区间；删除亚线性门禁；只提高 150MB 硬上限 | tier1 `<=8MB` 时 tier2 必须 `<=32MB`；tier1 `>8MB` 时以原始 tier1 外推一半并只加一次 8MB 余量。150MB 硬上限和非法输入 fail-closed 不变 |
| PR 6 restack 将可测增长的单侧 RSS 余量从 8MB 校准为 16MB，并独立要求可测档严格低于线性外推；低信号包络与硬上限不变 | 最新 PR5 合入后同一生产路径零 diff，但默认规模两次独立采样稳定得到 `82→135MB`、`82→133MB`，均仅因 8MB 余量产生的 131MB 边界失败；self-review 又证明仅扩大余量会让 `9→27MB` 的低幅精确线性增长通过 | 反复执行直到偶然通过；恢复双侧区间；删除亚线性断言；提高 150MB 硬上限；只保留 13MB/32MB 高档反例 | 16MB 仅加在可测 tier2 预算侧，同时要求 tier2 严格小于 `tier1 × rowsRatio`；`6→33MB` 低信号溢出、`9→27MB`/`13→39MB`/`32→96MB` 精确线性、140MB 新边界、150MB 硬上限与非法输入仍失败关闭；只改变测试稳定性，不改变产品/资金契约 |
| PR #129 review 对低信号 RSS 也强制严格低于线性外推；后续 P3 将采样触发与增长分类解耦，首次 tier1 `<=16MB` 时追加两轮隔离采样、以三次中位数裁决增长 | 固定 32MB 包络本身会让 `8→24MB` 精确线性、`6→29MB`/`8→32MB` 超线性通过；若只在 `<=8MB` 重采，1MB 抖动会让 `8→24MB` 三采样而 `9→26MB` 单采样 | 继续把 low-signal 标为自动通过；只收紧常量；把 9～16MB 误称为低信号；所有正常档无条件跑三次 | 增长分类仍以 8MB 为界，低信号同时满足 `tier2<=32MB` 与 `tier2<tier1×rowsRatio`；16MB 只定义 RSS 重采保护区。三次中位数裁决趋势，任一样本 `>=150MB` 仍失败；默认实测约 82MB，不增加常规 CI 次数，700万仍是 PRD 人工门禁 |
| `scan-vars` 的源码集合固定为 Git index 已跟踪 `.js` | 文件系统递归会把 ignored/generated `src/build-info.js` 计入本地报告，导致本地 294 文件、clean checkout 293 文件 | 按文件名硬编码排除 build-info；继续扫描所有非 ignored untracked；把 294 固化为报告常量 | `git ls-files --cached` 成为唯一集合来源；ignored/generated/untracked 全排除，报告写入 `sourceSet=git-tracked-js`，独立临时 Git 仓库测试锁定 tracked/ignored/untracked 三类 |
| PR 5 调整原因只在 ExcelJS 单元格赋值边界调用既有 `encodeExcelStXstring()`，数据库、review DTO、归档审计和行高计算继续使用业务原文 | 直接赋值时 ExcelJS 会把用户输入的字面 `_x000D_` 解码成回车，并把真实 CRLF 规范成 LF；既有 helper 已覆盖大小写十六进制、预编码外观、控制字符和 Unicode 合法性 | 在写入数据库时编码；复制一份 writer 私有 escape；对读回结果再做猜测性反解 | 每次导出都从不可变原文单次编码，避免重复导出双重编码；staged validator 仍严格以业务原文 readback，审计与 Excel 可逐字符对账 |
| PR #127 调整与归档事务对全部 19 张 VCC 事实表做流式确定性指纹，并用事务前 max-id/目标月精确划定新增调整、目标归档、run revision/status 和 dataset status 允许集 | 原提交前检查只证明新调整或目标归档看起来正确，AFTER INSERT trigger 仍可同时篡改旧 sequence、基础 run row 或其他月份/全局事实 | 只检查目标 run/新行；复用只覆盖破坏性删除的目标月排除模型 | 调整与归档在最后一次业务写后、COMMIT 前验证旧事实零漂移；新调整必须边界后恰一条且字段/时间/构建来源全等，目标归档与五类 dataset 必须精确匹配；任一 silent trigger 整事务回滚并留下 rolled_back 审计 |
| PR #127 重算替换和归档的 success operation audit 必须在事务内按旧审计 max-id、唯一新行、完整 evidence hash、run/月/type/status、可信版本来源和同一事务时间做最终断言 | INSERT 后触发器可删除或改写本次 success audit，原流程仍可能提交资金事实且制造伪成功审计 | 只相信 `lastInsertRowid`；COMMIT 后再补查 | `assertSuccessOperationAudit` 成为两条成功路径最后的审计边界；删除、改 evidence 或伪造 app/build 均在 COMMIT 前失败，旧资金事实/归档/dataset 全回滚，事务外仅 best-effort 记录可信 `rolled_back` |
| PR #127 service 对 calculate 请求只提取 `targetMonth` 与 `expectedInputFingerprint`，所有 worker 任务的 `taskGeneration/appVersion/buildSha` 均由 service 闭包最后覆盖 | renderer/IPC payload 可伪造构建来源，旧 spread 顺序还允许覆盖 worker 审计 provenance | 在 worker 内逐 action 清洗；信任 renderer 只传正常字段 | calculate 的额外 runId/版本/代次等字段不再进入 worker；其他 worker action 即使 payload 同名也只能得到主进程可信 provenance，审计来源单一 |
| #127 → #128 restack 使用普通双父 merge，并只对实施记录和自动集成策略做语义冲突裁决 | 冻结修复头 `28fbd2a` 与 #128 修复头 `b0b367b` 均已独立验收，rebase/force/squash 会破坏堆叠审计父链；生产代码和测试可自动合并 | rebase 后重写 #128；任选一侧覆盖记录；手工保留旧 integration 计时 | 实施记录完整保留双方决策/证据；integration policy 由最终全量 runner 重新生成；生产树同时保留 19 表 exact allowset、success audit/provenance 白名单、semantic writer、targetMonth 租约重查和 ST_Xstring 单次边界编码 |
| #129 → 冻结 #128 restack 使用普通双父 merge，第一父固定 `67019de`、第二父固定 `cc3080e` | #129 已独立冻结 RSS/scan/spec 修复，#128 已独立冻结 #127 资金事务收紧与 ST_Xstring/semantic export；rebase/force/squash 会破坏审计父链 | 重写任一冻结头；用一侧 notes/policy 覆盖另一侧；重新手改旧扫描或集成计数 | 生产代码与测试自动合并；实施记录保留双方历史，policy 由最终 integration runner 重建，scan reports 由最终 Git-tracked 源集合重建；最终树同时保留三条 PR 的不变量 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 未跟踪的其他 change、预览和输出文件不属于 v3.1.8 | 与 Spec 文件清单和目标模块无关 | 误提交用户资料 | 始终显式暂存；每次 commit 前检查 staged diff |
| 后续 PR 可暂时保持草稿和堆叠 base | 用户要求“按 Spec 里的多 PR 推进”且未要求每个立即合入 main | GitHub 展示/合并顺序需维护 | PR body 标明前序；前序合并后再重设 base |
| 旧结果行的 `category_major` 可能为空，不能在 PR 2 reader 中新增非空限制 | 当前 recharge/fee 取 `business_sub_type || ''`，channel 取 `mid || ''`，现有持久化契约允许空字符串 | 若生产事实始终非空则校验可更严格 | 继续将空值规范编码进 rowKey；未知/错配 `source_type` 仍严格拒绝 |
| 余额表存在“主体有九币种余额但本月无基础发生额行”是合法延续场景 | 上月归档主体本月无发生额仍必须进入结果与系统余额核对 | 若来源链路改变则可能掩盖孤儿余额 | 允许 balance-only 主体；反向要求每个基础行 subject+currency 必须存在 balance |
| 不可变调整账本的 `result_revision` 等于连续 sequence `1..N` 的记录数 | 每次新增调整只允许追加一次且 revision 加一；没有删除/编辑 API | 若后续引入不同 revision 语义会触发 reader 门禁 | PR 4 已按单事务追加 sequence=N+1 并 revision+1；后续仍须维持该契约 |
| 严格 `YYYY-MM` 字符串可直接用于跨月先后比较 | 月份入口统一规范化且固定两位月份 | 非规范历史月份会被排除普通枚举并在直接 preview 失败 | 保持 `normalizeOperationMonth()` 为所有破坏性入口前置门禁 |
| 删除首月期初允许五类 dataset 中部分已被用户删除，但所有仍存在的 dataset 必须处于未归档状态 | 用户可能先删除某一原表；期初清理不应要求伪造缺失 dataset | 强制五表必须齐全；缺表即阻断 | 只删除期初和同月 calculated runs；first_month、剩余 dataset、源事实和导入审计保持不变 |
| `assets/VCC财务OP校验/VCC财务OP校验结果表_模板.xlsx` 在 PR 5 生命周期内是不可变 golden，SHA-256 固定为 `f920fd2161156314a0d523eacb7cf7d11f7002b7781fe9cca01b298edfa4a1f4` | 用户提供文件与 Spec 锁定 hash 一致 | 文件变化会使所有结果导出失败关闭 | 单测每次从磁盘重新 stat/read/hash；任何更新必须先由 PM/财务人员更新契约和验收基线，不能自动接受 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| Spec 建议六个提交 | 六个堆叠 PR，每个 PR 内可含少量聚焦提交 | 用户明确要求多 PR 推进 | 评审与回滚粒度更细，功能口径不变 | 是（本实施记录） |
| 共享归档月份选择器在 PR 3 先服务解归档，历史结果按月份导出当时仍沿用“最新归档” | Spec 的 Phase 5 明确拥有月份导出和 writer；PR 3 只负责破坏性状态事务 | 在 PR 3 提前新增 get-by-month 导出契约 | PR 5 已接入同一 picker 并补历史月份导出测试 | 无需（既定阶段边界） |
| 归档一致性 logger 原计划随 PR 5 进入，现提前最小回移到 PR 3 | PR #126/P3+ review 明确要求生产不再静默隐藏损坏 archive；PR 5 参考实现已验证且不依赖 writer 语义 | 等 PR 5 restack 后再补 | PR 5 restack 时解决重复实现；本 PR 不回移 `getArchivedRunByMonth` 或模板 writer 语义 | 是（review 明确要求） |
| PR 6 restack 原计划原样复用 8MB 单侧 RSS 余量 | 两次默认规模独立采样都只在 131MB 亚线性边界失败，且 PR5 未改 toolbox 生产路径；按观测到的约 11MB 跨运行偏移校准为单侧 16MB，并在 self-review 补上独立严格低于线性外推的约束及 `9→26/27MB` 边界测试 | 影响仅限非产品测试判据；低信号、全部可测档精确线性、150MB 硬上限和真实 multi-sheet/worker 验证均不放宽 | 无需（Spec 与 PRD 未规定该测试内部余量，产品行为不变） |
| PR 6 低信号原计划只使用 32MB 固定包络 | PR #129 P2 反例证明它不能支撑“亚线性”判定；改为条件式三样本中位数 + 严格低于线性外推，并把 700 万自动证明口径收窄为既有人工门禁 | 仅测试判据和证据表述改变，产品路径、150MB 硬上限和 PR1～PR5 资金实现不变 | 无需（不改变 Spec 产品契约；修正自动化证据强度） |
| Spec 示例以模板业务末行为静态参考；实际导出按语义行计划重建结果表并将打印区动态收口为 `A1:L<实际末行>` | 调整行数量与主体业务分类会改变结果末行；固定 A1:L45 会留下样例行或截断新增行 | 保留模板原 45 行并原位覆盖；固定打印区 | M/N 仍保留为可见审计列但不进入模板锁定打印宽度；动态合并/打印区由 staged validator 回读验证 | 无需（Spec 已要求动态行与模板打印宽度） |

## Evidence

> 表中较早的“最终/冻结”表述只表示当时阶段的历史证据；当前候选以表末 `PR 5 → PR 6 restack`、RSS、26 张 PNG、release-check、check-vars 与双盲区终审六行为准。

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `git rev-parse HEAD` | `dff07df11fb94ce84940b474b55ac796f084d241` | 基线无漂移 |
| 两份模板 `shasum -a 256` | 分别匹配 `f7967d...a9fc`、`f920fd...1f4` | 用户资产身份 |
| PR 1 定向单测 | `104/104 PASS` | Pending 46/48 列契约与迁移、五表预检、原始数值精度、审计/导出兼容、renderer 接线 |
| PR #124 review 导出精度定向回归 | `node --test tests/unit/main-process/vcc-financial-op-dataset-writer.test.js` 返回 `6/6 PASS` | 原表/校验表重新打开后 JPY 为 `135886024.59`；其余显示列及 CNY→CNH 展示血缘不变；`balances_json` 缺失/非对象/币种缺失或重复/金额非法/读取证据不一致均结构化失败关闭 |
| 极老审计表回归 | 空残缺表可幂等补审计列；存在 Pending 行但缺 `raw_json` 时事务回滚且历史 hash 不变 | 迁移兼容与失败关闭 |
| 真实样本 `/Users/pzhong/Downloads/财务OP (22).xlsx` | PPHK JPY 读取为 `135886024.59`；检测到显示值 `135886024.6` 与原始值不一致并保留审计证据 | 原始数值优先及大额两位小数不被显示格式截断 |
| PR 1 `npm run release-check` | lint 通过；smoke 通过；unit `4587/4587 PASS`；integration `44/44` 脚本、`2051/2051` 断言通过 | 全仓静态检查、核心业务回归、迁移/大文件/side DB 集成门禁 |
| PR 1 review 定向回归 | 核心 7 文件 `93/93 PASS`；system importer + serialize-error `42/42 PASS` | 正负大额分币、relationship 重定位、公式缓存、安全 15 位整数、重复/损坏 XML、跨 worker 定位上下文、强制 fingerprint、多问题完整展示、后置 XFD 增列与稀疏键数 |
| PR 1 review 全仓门禁 | changed src ESLint 通过；smoke 通过；unit `4600/4600 PASS`；integration `44/44` 脚本、`2051/2051` 断言通过；`git diff --check` 通过 | 共享 row-scanner 四方等价、VCC 资金计算、迁移、全仓模块与大文件集成零回归 |
| `gh auth status` | 默认账号 token invalid | 仅 GitHub 发布被阻塞 |
| PR 2 定向单测 | `39/39 PASS`（calculator 22、state/migration 8、effective result 9） | 首月 claim 原子回滚、同月新增主体增量初始化与漏交回滚、迁移诊断启动隔离、非首月/早于首月门禁、多失败 code/message 同源、run fingerprint/revision/timestamp、rowKey 稳定、防伪/金额边界、跨币种调整及基础表不可变 |
| `AppDatabase.init()` 多期初旧库回归 | 二次启动成功；`first_month` 保持 `NULL`；幂等诊断仅 1 条 | 诊断不扩大为全应用不可启动，同时 VCC 运行层保持失败关闭 |
| effective result 篡改矩阵 | forged rowKey/metadata、未知来源/币种、0/三位小数/NaN/Infinity/16 位金额、sequence/revision、重复坐标、空基础事实、余额脱节和公式篡改均按专用 code 阻断 | 调整账本、金额/币种语义、行数与余额血缘 |
| PR 2 `npm run release-check` | lint 通过；smoke 通过；unit `4609/4609 PASS`；integration `44/44` 脚本、`2051/2051` 断言通过 | 全仓静态检查、资金模块回归、大文件/side DB/迁移集成门禁 |
| PR 2 `npm run check:vars` | 仅命中通用词 `state`；实际未改 `src/renderer.js` 顶层 UI state，判定为扫描误报 | 已复核 UI 模块/模板列表/导出状态均无改动；PR body 仍保留关联功能 review 说明 |
| PR 2 reconciliation blindspot pass | 主键血缘、九币种、月份边界、幂等、事务回滚、基础表不可变和行/余额坐标守恒均有代码与测试证据 | 未发现自动删改或静默补零；首月期初与生效金额仍需发布前人工财务复核 |
| PR #125 review 增量主体回归 | calculator `22/22 PASS`；首月既有 PPHK 后新增 NEW 时 preflight/calculate 仅返回 NEW，仅提交 NEW 成功，PPHK 的金额/hash/说明与 `first_month` 不变；新增 NEW+NEW2 仅提交 NEW 时 NEW 写入回滚 | 修复已初始化主体被误判 omitted，同时锁定真正缺失主体、九币种和事务完整性 |
| PR #125 review 链路与变量门禁 | service/renderer `21/21 PASS`；`npm run check:vars` 扫描本次唯一 src 改动，未命中重要变量 | renderer 仍只提交缺失主体；未改 IPC/用户流程，未触及既有重要变量清单 |
| PR #125 review 金额抵消与最终封顶定向回归 | result-adjustments、calculator、state migration、serialize-error 合计 `59/59 PASS`；其中 effective result `14/14 PASS` | 基础行和 adjustment 的“先越界后抵消”合法；基础汇总、调整汇总、行级 effectiveAmount、跨行 balance 的真实最终溢出均返回稳定 code/context，不返回部分 DTO，数据库/归档/调整账本不变；sequence、revision 与九币种契约保持 |
| PR #125 review 生效结果真实 SQLite 集成 | `scripts/integration/vcc-financial-op-effective-result.js` 返回 `19/19 PASS`，数据库关闭重开后读取 | 锁定合法抵消、精确字符串、归档只读和真实最终溢出；失败前后 run/row/balance/adjustment/archive 快照一致 |
| PR #125 review 静态与变量门禁 | 变更源文件 ESLint、3 个 JS 文件 `node --check`、`git diff --check` 全部通过；`npm run check:vars` 未命中任何重要变量 | 未引入语法/格式问题；本次金额聚合修复未触及 `rules/important-variables.md` 中的重要变量 |
| PR #125 review reconciliation blindspot pass | 已复核 rowKey×currency 血缘、币种隔离、精确十进制、逐可见字段封顶、只读生命周期、失败原子性与跨 worker 可观测性 | 未发现 P3+ 新缺口；金额规则属于资金红线，自动化证据不能替代发布前真实财务样本人工复核 |
| PR #125 review 全仓 `npm run release-check` | lint、smoke 通过；unit `4618/4618 PASS`；integration `45/45` 脚本、`2070/2070` 断言通过 | 新增集成脚本已被 runner 自动发现并同步 `rules/integration-test-policy.md`；全仓资金、迁移、大文件和 side DB 回归无失败 |
| PR 1 → PR 2 组合定向回归 | PR 1 导入/预检/跨 worker `81/81 PASS`；PR 2 calculator/state/effective `48/48 PASS`；真实 SQLite effective `19/19 PASS` | 同时保留 OOXML 原始金额、Pending 全宽表头、强制 fingerprint、首月状态模型、最终金额封顶和归档只读契约 |
| 预检并存门禁矩阵 | calculator `26/26 PASS` | 缺表+缺上月归档按稳定顺序完整展示；非法快照+首月待初始化不写期初或 claim 首月；migration diagnostic+缺表保持诊断最高优先且 issue 不重复；所有失败均在写 run/opening 前阻断 |
| PR 1 → PR 2 合并后全仓门禁 | changed src ESLint、`git diff --check` 通过；smoke 通过；unit `4631/4631 PASS`；integration `45/45` 脚本、`2070/2070` 断言通过 | 资金计算、导入、迁移、side DB、大文件及 UI 静态契约无回归；integration runner 已同步测试清单 |
| PR 1 → PR 2 `npm run check:vars` | Runtime-state 命中通用词 `state`；实际未改 `src/renderer.js` 顶层 `state`，仅新增 `state-changed` 提示与 VCC issues 展示 | 已复核模板列表、当前模块、导出可用性三组联动均未改；`src/renderer-vcc-financial-op.js` 只读错误 DTO 并展示，未新增/改写全局状态 |
| PR 1 → PR 2 reconciliation blindspot pass | 已复核预检优先级、首月 claim、失败零写入、fingerprint 二次核对、金额/币种精度、rowKey 血缘、归档只读与错误可观测性 | 未发现 P3+ 新缺口；本次同时触及期初与金额规则，仍属资金红线，发布前真实月份逐主体逐币种人工复核保持阻塞 |
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
| PR #126 P3+ 修复聚焦回归 | system importer / dataset deletion / destructive actions / audit writer / service 共覆盖首次 accepted、历史无重试 backfill、取消握手窗口、显式 confirmation、四类 silent trigger 和 logger；最新组合回归全部 PASS | accepted 的 snapshot FK/文件/sheet/行/raw 血缘；backfill 删除后完整双侧证据；未 protected timeout 可终止；mismatch 回滚且 context 不泄露 raw |
| PR #126 P3+ 真实 SQLite + worker 状态链 | `scripts/integration/vcc-financial-op-destructive-state-chain.js` 为 `64/64 PASS` | M1/M2/M3 解归档/删除链、worker generation/token、成功与 rolled_back 审计、全部子表与来源守恒 |
| PR #126 P3+ 最终单次 `npm run release-check` | lint PASS；smoke PASS；unit `4648/4648 PASS`（295 个测试文件）；integration `45/45` 脚本、`2115/2115` 可计数断言 PASS | 当前代码一次性通过静态、其他模块 smoke、全仓单测、迁移/大文件/side DB 与破坏性状态链门禁 |
| PR #126 P3+ `npm run check:vars` | 仅命中通用局部变量名 `state`；未改 `src/renderer.js` 顶层 UI state，无 Critical / Important-skeleton / Risk-sensitive 命中 | 已额外复核 VCC `activeTask/taskGeneration/protected/phase` 生命周期、worker ACK 边界和任务释放；旧预览仍在 generation 推进后失效 |
| PR #126 P3+ blindspot + reconciliation 复核 | 入口旁路、月份/source 主键血缘、九币种余额原样物化、幂等 backfill、部分失败、行/子表守恒、错误可观测性均有代码与 silent-trigger 回归 | 新发现的 unified undefined→0 和 backfill 后 trigger 漂移已在本轮修复；未发现未处理的 P3+ 自动化缺口，真实财务月份与 Windows 退出时序仍保留人工门禁 |
| PR #126 独立终审聚焦回归 | dataset deletion / destructive actions / system importer / audit writer / service 共 `96/96 PASS`，其中核心新增组合 `71/71 PASS` | accepted 0/唯一且完全一致、六类同长 raw 篡改、六类当次 success audit 篡改/额外行、旧 audit 篡改、跨月 run child/import error/外键错链及 service 零 worker 旁路均回滚；错误上下文只含 count/hash/metadata，跨 worker 序列化不泄露 raw/evidence |
| PR #126 独立终审真实 SQLite + worker 状态链 | `scripts/integration/vcc-financial-op-destructive-state-chain.js` 为 `64/64 PASS` | 三月解归档/删期初/删结果/删原表、generation/token、success/rolled_back 审计及事务故障回滚在真实连接中保持一致 |
| PR #126 独立终审 `npm run check:vars` | 本轮 6 个 `src` 文件仅命中 Runtime-state 通用词 `state`，无 Critical / Important-skeleton / Risk-sensitive 命中 | 实际未修改 renderer 全局 `state`；已复核 VCC task generation、confirmation、worker 创建前失败关闭与事务保护边界 |
| PR #126 独立终审 blindspot + reconciliation 复核 | 对照 migration 复核全部 19 张 VCC 表；目标月允许集、其他月/全局零漂移、父表月份归属、raw 精确 framing、audit 边界和 accepted 双侧血缘均有代码与故障注入证据 | 未发现遗留的可自动化 P2/P3 缺口；未自动修复损坏账务数据。真实资金月份主体/币种复核仍为发布前人工红线 |
| PR #126 第四轮独立审计最小 SQLite probe | 在修改生产代码前构造 linked `idempotent_skip` 且预置错误 `existing_raw_json_snapshot`；旧实现返回删除成功、snapshot=0、FK=NULL，错值原样保留 | 证实 `COALESCE` + accepted-only 断言存在真实审计血缘缺口，不是静态推测 |
| PR #126 第四轮独立审计聚焦回归 | dataset deletion / destructive actions / system importer / audit writer / service 共 `123/123 PASS`；核心三文件 `98/98 PASS` | skip/conflict/rolled_back 七类 existing_* 错值、空值正常物化、after-audit/after-delete/after-import-update 重建、额外 attempt/deletion、全 status run/child 残留，以及 audit/deletion/import/backfill/unarchive 等长错误时间均有成功或回滚反例 |
| PR #126 第四轮独立审计真实 SQLite + worker 状态链 | `scripts/integration/vcc-financial-op-destructive-state-chain.js` 为 `64/64 PASS` | 统一事务时间、最终零残留和 exact allowset 加固后，真实连接/worker 的三月破坏性链路无回归 |
| PR #126 第四轮全仓 unit + smoke | unit `4701/4701 PASS`（295 个测试文件）；`npm run smoke` PASS | 当前冻结代码的全仓单测及其他业务基础集成链无回归；最终堆叠分支仍由 team-lead 统一运行 release-check |
| PR #126 第四轮静态与变量门禁 | 修改 JS `node --check` PASS；targeted ESLint PASS；`git diff --check` PASS；`npm run check:vars` 仅命中 Runtime-state 通用词 `state` | 5 个 src 均为后端 VCC 事务局部状态，未改 renderer 全局 `state`，无 Critical / Important-skeleton / Risk-sensitive 命中 |
| PR #126 第四轮 blindspot + reconciliation 复核 | 检查最后写后断言窗口、显式低/高 ID、跨月归属、全 disposition 物化、时间线与错误上下文 | 未发现新的可自动化 P2/P3；低 ID 由旧行指纹捕获，高 ID 由 exact allowset 捕获，无业务写位于最终断言之后。真实资金月份复核仍为人工红线 |
| PR 2 → PR 3 restack staged diff 复核 | `MERGE_HEAD=b05a2478f060ab0c25a07b39cf3fb87853da4e3c`；无 unmerged entry/冲突标记；`git diff --cached --check` PASS；两条 service worker 测试仅给既有 `calculate()` 调用补合法小写 64 位 fingerprint，未删除或放宽断言 | 同时保留 PR 2 结构化 preflight + `openingState`、强制 `expectedInputFingerprint`、`DecimalAccumulator` 最终值封顶，以及 PR 3 事务前 critical 握手、统一 token/generation 门禁、四类破坏性事务 exact allowset |
| PR 2 → PR 3 restack 全仓门禁 | `NODE_PATH=/Users/pzhong/Desktop/Project/bank-bill-excel-tool/node_modules npm run test:unit` 为 `4719/4719 PASS`（295 个测试文件）；`npm run smoke` PASS；`npm run test:integration` 为 `46/46` 脚本、`2134/2134` 可计数断言 PASS | 真实 SQLite + worker destructive state chain `64/64 PASS`，effective result `19/19 PASS`；integration runner 已同步 policy，且两条 VCC 集成入口同时在清单内 |
| PR 2 → PR 3 restack `npm run check:vars` | 仅命中 Runtime-state 通用词 `state` 并按工具约定以 code 2 提醒；实际 diff 命中为 `opening-state` 等 VCC 状态码，未修改 `src/renderer.js` 顶层 `state`，无 Critical / Important-skeleton / Risk-sensitive 命中 | 已按清单复核模板列表、当前模块、导出可用性三组联动未变；smoke 已通过，PR body 仍保留关联功能 review 说明 |
| PR 2 → PR 3 restack reconciliation blindspot pass | 复核 fingerprint/月份/source/run 主键血缘、九币种与十进制金额、重放及并发 generation、事务部分失败、全表 exact allowset、审计与行/子表守恒 | 自动化未发现新 P2/P3 缺口；未自动修复生产异常资金事实。真实月份逐主体逐币种、生产副本历史归档一致性与 Windows 退出时序仍保持人工/平台门禁 |
| PR 4 本机生产库只读探针 | 对 `/Users/pzhong/Library/Application Support/bank-bill-excel-tool/tool-data.sqlite` 使用 `DatabaseSync({ readOnly: true })` 并执行 `PRAGMA query_only=ON`；`vcc_fin_op_runs`、`vcc_fin_op_run_rows`、`vcc_fin_op_run_balances` 均存在且 count=0，升级前尚无 `vcc_fin_op_run_adjustments` | 本机没有存量 calculated/archived run 需要兼容非规范金额或空分类；仅证明这台机器当前事实，不能泛化到其他生产机器，迁移仍只允许新增空账本/列而不得猜测或改写资金值 |
| PR 4 调整/归档定向单测 | result-adjustments + calculator 覆盖合法/非法金额、500 Unicode 字符边界、rowKey/元数据防伪、坐标唯一、revision、effective 九币种、归档和重算替换事务；证据采集阶段损坏时亦零删除并写 rolled_back 审计 | 调整账本不可变、金额/币种语义、失败原错优先、旧结果证据和跨期归档血缘 |
| PR 4 service/IPC/usage/renderer 契约测试 | 调整 options 为不计数查询，成功 add 计“修改结果”且持有全局租约；full-result get/manager row/revision/preload 对称；renderer 严格消费后端 DTO、失败策略可重试、归档 revision gate 和已归档只读 | IPC 旁路、usage 误计、并发状态污染、renderer 自算金额和核对状态未清除 |
| PR 4 真实 SQLite + 真实 worker 调整归档链 | `scripts/integration/vcc-financial-op-adjustment-archive-chain.js` 直接执行 `59/59 PASS` | M1 计算→调整→关闭重开→九币种生效归档→含调整导出在 writer 前以稳定 code/context 失败关闭且零文件→M2 从调整后 USD `104.25` 继承期初并计算至 `107.25`；同时覆盖 stale revision、归档锁定、版本元数据和完整审计 |
| PR 4 dev self-review P1/P3 定向回归 | `node --test` 运行 calculator、service、serialize-error、renderer VCC 契约共 `80/80 PASS`；隔离工作树通过 `NODE_PATH` 只读复用主仓依赖 | 无调整历史归档仍成功进入 writer；calculate 业务主错误及 rolled_back 审计二次失败从 worker 序列化到 IPC 保留 `code/detailLines/context.auditFailure`；calculate/export handler 均使用统一结构化错误返回 |
| PR 4 dev self-review 最终静态门禁 | 全量 `src/` ESLint PASS；修改 JS `node --check` PASS；`git diff --check` PASS；`node scripts/check-vars.js` 返回“未命中任何重要变量” | 临时资金闸、IPC 接线及测试文件均无静态错误或重要变量旁路 |
| PR 4 Electron 结果/调整预览 | `/private/tmp/codex-vcc-pr4-result.png` 与 `/private/tmp/codex-vcc-pr4-adjustment.png` 均成功生成 2480×1720 截图；调整预览入口可重复执行 | 完整结果宽表、调整行/revision/归档控件，以及主体→大类→分类→币种→调整值→原因、取消/确认顺序和桌面双列布局视觉通过；520px 单列由 renderer/CSS 契约测试锁定 |
| PR 4 冻结代码最终单次 `npm run release-check` | lint PASS；smoke PASS；unit `4654/4654 PASS`（295 个测试文件）；integration `46/46` 脚本、`2158/2158` 断言 PASS，其中 PR 4 真实 SQLite/worker 调整归档链 `55/55 PASS` | 同一次命令完整覆盖静态检查、其他模块 smoke、全仓单测及全部集成链；证据对应冻结代码，但不替代真实财务月份和 Windows 发布门禁 |
| PR 4 `npm run check:vars` 与人工 review | `ipcRenderer` 为真实命中：main/preload 通道对称且已有契约测试；`MODULES` 仅被 preview 路由引用，未修改枚举；`dialog`、`setStatus`、`state` 均为 VCC renderer 局部命名或局部状态，不是规则指向的 Electron `dialog` 或 `src/renderer.js` 全局 `state`；无 Critical/Risk-sensitive 命中 | ⚠️ 关联功能 review 已覆盖 IPC 对称性、preview 路由、局部弹框/状态生命周期；未发现重要变量旁路或全局状态污染 |
| PR 4 发布门禁复核 | 自动化与本机视觉证据均不能替代真实财务事实及目标平台验证 | 真实财务月份逐主体逐币种核对、Windows 打包及 Excel/WPS 显示仍阻塞 3.1.8 发布 |
| PR 3 → PR 4 restack 冲突与定向回归 | 无冲突标记且 `git diff --check` PASS；PR 3 精确三文件核心组合在叠加 PR 4 两个 service 用例后 `101/101 PASS`；calculator/result-adjustments/service/serialize-error/IPC 组合 `89/89 PASS` | 强制 fingerprint/preflight、DecimalAccumulator、replacement/rolled_back audit、critical-ready 取消边界、无调整导出兼容和 `vccFinancialOpErrorResult` 的 `context.auditFailure` 均同时保留 |
| PR 3 → PR 4 restack 真实 SQLite + worker 链 | destructive `64/64 PASS`；effective `19/19 PASS`；adjustment/archive `59/59 PASS` | 三月破坏性 exact allowset/回滚守恒、生效结果最终值精度、调整→归档→下月期初同口径均通过；含调整导出稳定返回 `adjusted-result-export-unsupported`，writer 调用数为 0 且目标文件不存在 |
| PR 3 → PR 4 restack 全仓门禁 | 共享依赖执行全量 `src/` ESLint PASS；`npm run smoke` PASS；unit `4741/4741 PASS`（295 个测试文件）；integration `47/47` 脚本、`2193/2193` 可计数断言 PASS；runner 已同步三条 VCC 集成链到 policy | 静态检查、其他业务 smoke、全仓 unit、迁移/大文件/side DB 与 VCC 三条真实链在当前合并结果无回归 |
| PR 3 → PR 4 restack `npm run check:vars` | code 2 仅命中 Runtime-state 通用词 `state`；diff 实际为 VCC 局部事务状态、`opening-state` code 及模块文件名，未修改 `src/renderer.js` 顶层 `state` | 按清单判定为误报；无 Critical / Important-skeleton / Risk-sensitive 命中，既有 smoke 与 renderer 契约已通过 |
| PR 3 → PR 4 restack blindspot + reconciliation 复核 | 沿 preflight→worker→calculate/adjust→archive→export 及 preview→destructive transaction→audit 数据流核对入口、状态、金额、失败与观测；代码定位与上述定向/真实链/全仓门禁相互印证 | 未发现会改变合并方案的新旁路或自动化缺口；未自动修复异常生产事实。真实月份逐主体逐币种、历史 archived run 一致性和 Windows 退出时序仍为发布前人工/平台门禁 |
| PR 5 模板/金额/renderer 定向单测 | result-template contract、共享判零 helper、writer、service、破坏性 resolver 与 renderer picker 覆盖模板 SHA/锚点/缓存、九币种金额、样式故障、血缘负向矩阵、原子不覆盖、targetMonth 租约、空态和失败重试 | 模板漂移、串月导出、浮点判零、样例泄漏、血缘孤儿、刷新错误吞没 |
| PR 5 ExcelJS defined name 探针 | 金标准 rowKey 标记经 write→reopen 后仍精确引用 `'财务OP校验结果表'!$M$2`，可逆还原完整 `v1:64hex + JPY` | 证明当前 ExcelJS 版本可承载非业务可见列的严格调整血缘；validator 仍对异常引用失败关闭 |
| PR 5 真实 SQLite + 金标准模板历史导出链 | `scripts/integration/vcc-financial-op-historical-template-export.js` 直接执行 `28/28 PASS` | 两个一致归档月份倒序枚举；显式选择旧月严格导出旧 run；调整 M/N、effective 汇总、动态 printArea 和 named-range 写后回读均正确，未回退 latest；latest 真实 worker 解归档后立即从枚举消失并以 `no-archived-results` 禁止再次导出；正式 service 重新归档后恢复为 latest 候选和严格 resolver |
| PR 5 可重复 UI 预览入口 | `preview:vcc-financial-op-result-export-month` 使用静态 2026/2025 两年归档月份并复用蓝色【导出】picker；已串入 `preview:vcc-financial-op` | PR 6 已在不依赖本机数据库的情况下生成并纳入最终历史月份导出截图资产 |
| PR 5 reviewer P2 定向回归 | renderer + writer 两文件 `36/36 PASS`；PR 5 六文件组合 `70/70 PASS`；历史月份真实 SQLite + 金标准模板链 `28/28 PASS`。500 字 Unicode 原因 write→reopen 后 adjustment 行为 `409.5pt`、wrapText 保留、相邻基础行仍为模板 `15pt`；结构化模板错误测试确认 code/message/detailLines 保留、实际路径可见且 stack 不展示 | 模板错误可观测性、长调整原因裁切、基础行样式回归、staged validator 同口径，以及历史月份导出/解归档/重归档链无回归 |
| PR 5 reviewer P2 修复后最终单次 `npm run release-check` | lint PASS；smoke PASS；unit `4673/4673 PASS`（297 个测试文件）；integration `47/47` 脚本、`2186/2186` 断言 PASS，其中 VCC 历史月份模板导出链 `28/28 PASS` | 同一次命令覆盖静态检查、基础 smoke、全仓单测和全部集成链；证据对应最终冻结代码 |
| PR 5 最终 `npm run check:vars` 与人工 review | 仅命中 `MODULES`、`elements`、`setStatus`、`state`；`MODULES` 只新增 preview route，后三者均为 VCC renderer 局部变量；无 Critical/Risk-sensitive 命中 | 已复核导出可用性、错误状态展示和模块路由，未发现重要变量旁路或全局状态污染 |
| PR 6 锁定规范入库 | Downloads 原规范 SHA-256 为 `9f3af33df52907499ec673b20f808b7615e7edf10231a33508c8eb5acd2a76de`；`018675fb6da6a07a72b8a7b23a28928dd8eb643b02592d0320714628f55221d8` 是仅修正 §10.4 两处真实路径、尚未完成五处 Markdown 换行格式修复的阶段哈希；当前 `changes/3.1.8/spec.md` 按 CRLF/CR → LF 规范化后的冻结内容 SHA-256 为 `1f5f0663ee35436c8b1f7da628822a4f83a3f70db215cd5ebd60a6720bae367d` | 业务内容只改两处路径，前五行双空格改 `<br>` 为五处语义等价格式修复；换行规范化只消除 checkout 平台差异，不接受其它字节变化。原始规范、格式修复前阶段与当前评审基线均可追溯，没有改 Q01～Q12 或业务契约 |
| PR 6 版本与发布文档契约 | `package.json`、`package-lock.json` 均为 `3.1.8`；CHANGELOG 标记 `Unreleased`、版本历史标记“待发布”、用户手册标记“发布候选”；release-docs `3/3 PASS` | 防止未完成人工门禁时误写成已发布；锁定 46 列、原始数值、五表预检、调整不覆盖基础行、尾月解归档、历史导出、M/N 与 A:L 披露及旧口径负断言 |
| PR 6 VCC Electron 预览矩阵 | 26 张 PNG 全量生成并视觉复核，覆盖主面板、缺表、期初、数据管理、首月/结果删除、尾月/非尾月/执行中解归档、历史导出空态、完整结果、单/多调整、已归档、100%/125%/150% 与最小窗口 | 关键状态均可重复生成；面板版本为 3.1.8，危险 disabled 按钮有明确静默视觉；预览隔离与旧图防冒充由静态/行为测试锁定 |
| PR 6 preview/dist/Windows 定向回归 | VCC preview、renderer、在线升级、Windows 构建及 check-dist 组合 `45/45 PASS`；release-docs `3/3 PASS`；真实 asar fixture 覆盖模板缺失、旧版本、version 缺失/空值 | capture-only hook、PNG 完整性、x64 构建、任意 PR 门禁、模板/版本分发守卫和发布候选文档均有自动化证据 |
| PR 6 asar fixture 并发稳定性修复 | 首轮全量 unit 为 `4691/4692`，定位 `@electron/asar` 3.x 在调用 destination stream `end()` 后即 resolve；fixture 增加等待 stream `finish`，定向 `6/6 PASS`，后续两次全量 unit 均 `4692/4692 PASS` | 消除高负载下读取未完全 flush 的测试包；没有放宽分发守卫或生产打包契约 |
| PR 6 最终 `npm run scan:vars` / `npm run check:vars` | 扫描 v3.1.8、`src/` 293 文件、3688 个顶层名字；命中 Runtime-state：`MODULES`、`app`、`dialog`、`setStatus`、`state`，无 Critical/Risk-sensitive | `MODULES` 只使用既有 VCC ID 做 capture 路由；`app` 仅让 capture 失败以非 0 退出；`dialog` 是 VCC renderer 局部 DOM；`setStatus` 只生成 capture 的空归档/缺表状态；`state` 命中来自 preview/既有引用，本轮未修改 `src/renderer.js` 全局 state 结构，capture 状态仅保存为隔离的 Promise/DOM 快照；生产模块枚举、Electron dialog、状态栏行为和启动/退出钩子未改变 |
| PR 6 本机陈旧 dist 负向探针 | `npm run check:dist` 正确拒绝本机 3.0.13 `win-unpacked`：缺两份 VCC 模板且包内版本 `3.0.13 != 3.1.8` | 证明旧目录不能冒充当前构建；这不是 3.1.8 Windows 产物成功证据，不能替代目标平台构建与打开验证 |
| PR 6 冻结工作树最终单次 `npm run release-check` | 最终对外术语修复后重跑：lint PASS；smoke PASS；unit `4695/4695 PASS`（301 个测试文件）；integration `47/47` 脚本、`2186/2186` 断言 PASS，其中调整归档 `55/55`、破坏性状态链 `52/52`、历史模板导出 `28/28` | 同一次命令覆盖静态检查、其他模块 smoke、全仓单测和全部集成链；证据对应最终生产代码与用户行为，不替代 Windows/Excel/WPS、关窗时序或真实月份资金人工验收 |
| PR 6 资金/通用 blindspot 收口 | 复核入口旁路、capture 生命周期、分发架构/陈旧产物、模板路径、状态部分失败、主键血缘、金额币种、跨月边界、幂等和行/余额守恒 | 未发现新增自动改写资金事实或生产预览旁路；剩余项全部保留为人工发布门禁，不把自动化结果升级为财务签字 |
| PR 6 reviewer P1 预览根因定位 | 旧切年 PNG 修改时间为 20:33:11，早于 disabled CSS 的 20:35:27；非尾月 PNG 在 20:35:56 才生成，renderer 又在 21:13 后继续改动。旧 capture 只等固定延时，没有等年/月切换后的异步 preview 完成 | 退回图中“有后续依赖但危险按钮仍像可点”是陈旧截图证据与缺失 capture 完成信号的组合问题，不是生产 picker 或后台尾月保护失效 |
| PR 6 reviewer P1 capture 完成信号 | 解归档 4 个截图 token 的 hook 必须返回 Promise；年/月切换后等 preview response、目标选项、真实 `button.disabled` 和状态文案稳定，再等两帧绘制；主进程 8 秒超时且失败非 0 退出 | 等待只由 `APP_CAPTURE_PATH` 激活；缺 hook、缺 method、无返回值、Promise 拒绝/悬挂或错误状态都不得用旧 PNG 冒充本轮证据，生产弹框和后台 token/generation 保护不变 |
| PR 6 reviewer P1 行为回归 | 伪 DOM 行为测试实际触发年份/月份 `change` 事件，等异步 preview 结束后断言切年、非尾月与执行中的真实确认按钮均为 `disabled === true`；缺 hook/缺 method 负向用例断言 readiness 拒绝 | 回归检查 DOM 最终状态，不仅匹配源码字符串；后台依赖保护仍由原 service/integration 测试覆盖 |
| PR 6 reviewer P1 预览证据冻结 | 本轮一次全量生成 26/26 张 VCC PNG，全部修改时间晚于本轮生成起点；`sips` 26/26 解码成功，25 张为 2480×1720，最小窗口图为 2160×1520 | 人工复核切年为 2025-12/灰色禁用删除、非尾月 2026-05/灰色禁用删除、执行中禁用年月与删除/取消、结果页“当前结果版本”，未再发现陈旧状态 |
| PR 6 reviewer P2 用户文案与操作链 | VCC 界面所有用户可见 `revision` 改为“结果版本”，内部 `resultRevision` 与错误码不改；手册写明较新“已归档/已计算”均会阻断，须从最新月逐月“解归档→删除全部未归档结果”，修订后再按时间正序重跑/归档 | CHANGELOG/版本历史/手册当前 v3.1.8 候选切片删除内部评审词、“金标准/语义模板”和 x64/arm64 矛盾，改用“正式模板/结果模板”及“64 位 Windows 安装版和便携版”；历史版本记录不做机械改写 |
| PR 6 reviewer 最终 `npm run scan:vars` / `npm run check:vars` | 扫描 v3.1.8、`src/` 293 文件、3688 个顶层名字；命中 Runtime-state：`MODULES`、`app`、`dialog`、`setStatus`、`state`，无 Critical/Risk-sensitive | `MODULES` 只用既有 VCC ID 做 capture 路由；`app` 只在 capture 失败时非 0 退出；`dialog`/`setStatus`/`state` 是 VCC 局部 DOM、状态或测试引用，未改 Electron 原生 dialog、全局状态结构或生产退出钩子 |
| PR 6 reviewer 最终定向与全量回归 | 最终对外术语修复后，release-docs `3/3 PASS`；完整 `npm run release-check` 为 lint/smoke PASS、unit `4695/4695 PASS`、integration `47/47` 脚本与 `2186/2186` 断言 PASS；术语修复前的 preview + renderer + release-docs 组合为 `37/37 PASS` | 真实 disabled 行为、readiness 负向用例、当前 v3.1.8 对外切片术语负断言和手册操作链已进入全仓门禁；集成链确认解归档/删除/历史导出的后台保护无回归 |
| PR 6 reviewer 范围记录（历史） | 当时 intended 变更共 56 个文件：33 个 modified + 23 个 added | 该数字在随后 RSS 门禁和 self-review 修复后已过期；当前范围见表末阶段性证据，不得继续引用为最终冻结 |
| PR 6 reviewer 最终通用/资金盲区复核 | 最终 diff 对 `src/backend/` 与 `src/main-process/` 的生产资金实现为 0 文件；逐项检查 capture 入口隔离、缺失/超时/拒绝、异步旧响应、DOM 销毁、旧 PNG 替换、尾月依赖、主键、金额/币种、跨月、重复操作、部分失败、行/余额守恒和错误可观测性 | 未发现新的生产入口旁路、自动删改资金事实或静默降级；capture 只读取预览 DOM 并在失败时非 0 退出。真实月份逐主体/币种、Windows Excel/WPS 和关窗时序人工复核继续作为资金发布红线，不得由自动化 PASS 代替 |
| PR 6 reviewer P2 全 token readiness 定向回归 | preview contract 新增完整 26-token 集合一致性、策略分派、缺失/未知/null/同步抛错/拒绝/悬挂超时/非法结果负向矩阵；行为伪 DOM 验证删除目标异步切换后真实按钮/文案稳定；pending 的 result/import/run/adjustment lifecycle Promise 在 100ms 内完成 readiness；合法 staged PNG 遇 readiness 错误也不覆盖旧正式图 | 证明所有 capture 入口由同一 fail-closed 主进程门禁覆盖，同时避免生命周期 Promise 导致截图命令死锁；测试断言最终 DOM 与发布文件行为而非只匹配源码字符串 |
| PR 6 reviewer P2 26-token 预览证据 | 生成日志记录 26 张 VCC PNG 按 package 脚本顺序完成；自动门禁不使用 mtime 判断新鲜度，而是按 26-token 契约枚举仓库真实文件，逐张验证 signature、IHDR、非空 IDAT、以 IEND 精确结束及尺寸 | 25 张必须为 2480×1720，`result-min-window` 必须为 2160×1520；缺失、截断、空 IDAT、额外尾字节或尺寸漂移都会让 unit 失败 |
| PR 6 reviewer P2 最终 `npm run check:vars` 与人工 review | 仅命中 Runtime-state：`MODULES`、`dialog`、`state`；无 Critical / Important-skeleton / Risk-sensitive 命中 | `MODULES` 只把既有 VCC preview 路由集中到显式契约，未增删模块枚举或 UI tab；`dialog` 为 renderer 局部 DOM；`state` 为策略字面量/局部状态文案，不是 `src/renderer.js` 顶层单例结构。模块切换、原生文件对话框及模板/当前模块/导出可用性联动均未改写 |
| PR 6 reviewer P2 readiness 阶段发布回归（历史） | 定向 renderer + preview + release-docs `41/41 PASS`；`npm run release-check` 当时完整通过：lint/smoke PASS，unit `4705/4705 PASS`（301 个测试文件），integration `47/47` 脚本、`2198/2198` 断言 PASS | 该证据早于随后 RSS 稳定性和 self-review 修复，只作历史 baseline；不得声称它覆盖当前或最终 HEAD |
| PR 6 reviewer P2 通用/资金盲区复核 | 本轮生产改动仅在 capture 主进程门禁、renderer preview 路由与 preview-only hook 状态观测；`src/backend/`、`src/main-process/`、金额/币种、数据库迁移及资金 writer 均为 0 diff。复核全部 VCC 前缀入口、未知 token、注册时序、最新异步 Promise、DOM 销毁、同步/拒绝/超时、生命周期不等待及 staged 输出原子晋升 | 未发现生产入口旁路、异步旧响应覆盖、截图死锁、旧 PNG 冒充或资金事实自动改写；真实月份逐主体/币种、Windows Excel/WPS 与关窗时序继续保留为人工发布红线，不由本轮自动化替代 |
| 截至当前 PR6 修复 SHA 的 RSS 门禁证据 | RSS 模型单测 `4/4 PASS`；5 万/15 万行小规模与默认 50 万/150 万行 `toolbox-large-split-multi-sheet.js` 均 `31/31 PASS`；默认档独立采样为 `93→138MB`，可测预算上限 148MB，两档均低于 150MB 硬上限 | `6→29MB` 低信号包络通过，`6→33MB` 超包络拒绝，`13→39MB` 与 `32→96MB` 精确线性反例拒绝，150MB 硬上限与非法输入 fail-closed；真多 sheet/真 worker 链同时通过 |
| 截至当前 PR6 修复 SHA 的归档与预览证据 | 关联定向单测 `55/55 PASS`，其中 renderer + preview + release-docs `43/43 PASS`；新增 `docs/iterations/v3.1.8/PRD-v3.1.8.md` 索引并由 release-docs 锁定 | release-docs 定位版本/锁定 spec/范围/非目标/验收/人工门禁；preview 测试直接读取仓库 26 张 PNG 并锁定 25+1 尺寸分布；Windows/asar 定向契约也在同组通过 |
| 截至当前 PR6 修复 SHA 的静态证据 | `npm run lint` PASS；修改的 4 个 JS 文件 `node --check` PASS；`git diff --check` PASS | 未引入 src lint 回归、JS 语法错误或新 whitespace 问题 |
| 截至当前 PR6 修复 SHA 的阶段性范围 | 相对 PR5 base 为 59 个文件：34 modified + 25 added；本轮新增 1 份 iteration PRD 索引和 1 份 RSS 门禁单测 | 该数字不是最终冻结；并行 PR1～PR4 修复叠加后，由主代理对最终 HEAD 重跑 release-check 并回写计数/范围 |
| PR 5 合并前资金链盲区复核 | 将既有真实 SQLite/worker 调整归档链扩展为 `calculate → adjust → 重开数据库 → archive → 按月 export → ExcelJS reopen → 次月 calculate` 单一链，直接执行 `295/295 PASS`；逐结果行核对主体/分类、D:L 九币种、M/N 调整事实、defined-name 坐标、archive audit 生效余额，并逐九币种核对下月期初；相关 effective/归档/service/writer 单测 `56/56 PASS`，既有历史模板导出链 `28/28 PASS` | 消除原来“调整归档继承”与“历史 Excel 回读”分属两条 fixture、无法证明同一 run 端到端闭环的 P3 测试缺口；未改变生产逻辑或锁定 Spec |
| PR 5 合并前全量 integration | `npm run test:integration` 为 `47/47` 脚本、`2438/2438` 可计数断言 PASS；runner 自动同步 `rules/integration-test-policy.md`，其中调整归档导出继承链 `295/295 PASS`、破坏性状态链 `64/64 PASS`、历史模板导出链 `28/28 PASS` | 新单链回归进入自动发现门禁；既有迁移、大文件、side DB、破坏性事务与其他业务集成无回归 |
| PR 4 → PR 5 restack semantic writer 定向探针 | 在临时门禁仍保留的保守中间态运行 result-adjustments、result-template-contract 与 writer 单测 `40/40 PASS` | 先证明 `getEffectiveRunResult()`、模板 SHA/锚点、M/N、defined names、ExcelJS 重开及失败不覆盖，再精确移除阶段性门禁；不是先放宽后补证据 |
| PR 4 → PR 5 restack 定向单测 | calculator/dataset deletion/destructive/adjustment/template/system import/serialize-error/audit writer/service/writer/renderer/shared difference 共 `250/250 PASS` | mandatory 64-hex fingerprint、all-issues preflight、openingState、DecimalAccumulator、critical/token/generation/exact destructive chain、structured IPC `auditFailure` 与 semantic export 同时保留 |
| PR 4 → PR 5 restack 四条真实 SQLite/worker 链 | destructive `64/64 PASS`；effective `19/19 PASS`；adjustment/archive/export/inherit `295/295 PASS`；historical template export `28/28 PASS` | 调整后归档、按月租约内解析、Excel D:L/M:N/defined names 回读、审计与下月九币种期初闭环；临时 guard 专属 writer 零调用/零文件断言已随历史阶段结束删除 |
| PR 4 → PR 5 restack 全仓门禁 | 共享主工作区只读依赖执行全量 `src/` ESLint PASS；`npm run smoke` PASS；unit `4760/4760 PASS`（297 个测试文件）；integration `48/48` 脚本、`2457/2457` 可计数断言 PASS，runner 已同步 policy | 当前普通 merge 结果通过静态、基础 smoke、全仓 unit、迁移/大文件/side DB 与四条 VCC 真实链；未用降级测试替代缺失依赖 |
| PR 4 → PR 5 restack `npm run check:vars` | 工具按约定以 code 2 提醒，仅命中 Runtime-state `state`；实际 diff 只在 `renderer-vcc-financial-op.js` 的 VCC 局部 state 附近新增完整 preflight 阻断原因展示，未修改 `src/renderer.js` 顶层 state | 已按清单复核模板列表、当前模块、导出可用性三组全局联动未变；局部 busy/latestArchivedRun 生命周期未改，renderer 定向与全仓测试均通过；无 Critical / Important-skeleton / Risk-sensitive 命中 |
| PR 4 → PR 5 restack 合并与资金盲区终审 | `HEAD=c843f619...`、`MERGE_HEAD=31810ef5...`；无 unmerged entry/冲突标记，cached/working `git diff --check` PASS。沿 preflight→worker→calculate→adjust→archive→按月 export→Excel 回读→次月期初及 preview→破坏性事务→audit 全链复核主键、九币种、Decimal、幂等、租约、部分失败和行/子表守恒 | PR 4 的 mandatory fingerprint、完整 issues/openingState、protected worker、exact destructive allowset、`vccFinancialOpErrorResult`/`auditFailure` 与 PR 5 的 semantic writer/targetMonth 二次重查同时保留；未发现未处理 P3+ 自动化缺口。异常生产事实不自动修复，真实月份逐主体逐币种、历史归档一致性和 Windows Excel/WPS/退出时序仍保持人工/平台门禁 |
| PR 5 `e086f2d99e9cb7a0b48c6c32e52b51f7ff9398ff` → PR 6 restack | 以 `9b507061a2ab303c81e6fb0a8dfad56b961c4d12` 为第一父候选、最新 PR 5 为第二父候选执行普通 merge；冲突仅出现在本实施记录与 integration policy，均按两侧证据合并，无生产文件冲突。相对最新 PR 5 的最终范围仍为 59 个文件（34 modified + 25 added） | PR 5 的计算/调整/破坏性事务与 PR 6 的发布收口保持堆叠祖先关系；未使用 rebase、squash 或 force，未恢复 PR 4 的 `adjusted-result-export-unsupported` 临时门禁 |
| PR 6 restack RSS 盲区发现与修复 | 默认 50 万/150 万行隔离采样连续两次仅在亚线性预算失败：`82→135MB`（预算 131MB）和 `82→133MB`（预算 131MB），两档均低于 150MB 硬上限；校准单侧可测噪声余量后，小档与默认档分别 `31/31 PASS`，完整 release-check 内默认档再次 `31/31 PASS`；self-review 新增 `9→26MB` 通过、`9→27MB` 拒绝 | 两个 P3 测试门禁缺口均已修复；16MB 余量只作用于可测增长的 tier2 预算，可测档另须严格低于线性外推；低信号 32MB 包络、150MB 硬上限、非法输入 fail-closed、真实 multi-sheet/worker 链均保持 |
| PR 6 restack 26 张 PNG 最终证据 | 一次完整 `npm run preview:vcc-financial-op` 生成 26/26；自动契约 `16/16 PASS`，逐图验证 PNG signature、IHDR、正尺寸、非空 IDAT、IEND 长度 0 且恰好位于 EOF | 25 张为 `2480×1720`，`vcc-financial-op-result-min-window.png` 为 `2160×1520`；缺图、截断、尾随字节或尺寸漂移均会失败，旧图不能冒充本轮证据 |
| PR 6 restack 最终单次 `npm run release-check` | self-review 的 RSS 公式修复与单测补强后，在同一候选工作树重跑：lint PASS；smoke PASS；unit `4792/4792 PASS`（302 个测试文件，0 failures）；integration `48/48` 脚本、`2457/2457` 可计数断言 PASS（`310791ms`） | 覆盖全部静态检查、smoke、单测、迁移/大文件/side DB 与 VCC 真实链；RSS 默认档 `31/31`，VCC 调整归档继承 `295/295`、破坏性状态 `64/64`、effective `19/19`、历史模板导出 `28/28` |
| PR 6 restack 最终 `scan:vars` / `check:vars` | 修复可复现源码集合后，`scan:vars` 扫描 v3.1.8、Git 已跟踪 `src/` 293 个 JS 文件、3737 个顶层名字并刷新 md/json；此前 294 文件口径误含 ignored/generated `src/build-info.js`。本轮默认 `check:vars` 因不改 `src/` 正常跳过；完整 PR base `e086f2d...` 口径按约定 code 2，仅命中 Runtime-state `MODULES`、`app`、`dialog`、`setStatus`、`state`，无 Critical / Important-skeleton / Risk-sensitive 命中 | 五项均来自既有 PR6 capture/UI 路径：模块枚举未增删，`app` 只处理 capture 失败退出，`dialog`/`setStatus`/`state` 是局部 DOM、状态或测试引用；未改 Electron 原生 dialog、`src/renderer.js` 顶层状态结构或生产启动/退出钩子。模板列表、当前模块、导出可用性三组全局联动未改，定向与全仓 renderer 测试通过 |
| PR 6 restack 通用与资金盲区终审 | 相对最新 PR 5，`src/backend/` 与 `src/main-process/` 生产资金实现为 0 diff；逐项复核 capture 入口/超时/拒绝/DOM 生命周期、PR 1 强制 fingerprint + 完整 issues/openingState、PR 2 DecimalAccumulator、PR 3 protected worker + exact preserved allowset、PR 4 调整账本、PR 5 semantic writer + targetMonth 租约与 IPC `auditFailure` | P3 RSS 抖动误报、P3 低幅精确线性漏检与 P3 发布策略文档仍写成三段/无 CI 均已修复；未发现剩余 P3+ 或资金红线新缺口。真实月份逐主体/九币种、生产历史 archive/数据库副本、Windows installer/portable + Excel/WPS、已保护 worker 关窗时序仍是人工/平台发布门禁，不得由自动化 PASS 替代 |
| PR #129 finding probe | 未改代码前，模型确认 `8→24MB`、`6→29MB`、`8→32MB` 均误判 PASS；默认压力档 `88→140MB`、预算 148MB、`31/31 PASS`，证明常规环境走 measurable 分支。`git check-ignore` 证明 `src/build-info.js` 被 `.gitignore` 排除且不在 index；完整 `e086f2d...→c2b3b7e...` diff-check 精确命中 Spec 第 3～7 行五处尾随空格 | 三个 finding 均有确定触发条件；无 BLOCK 产品决策。修复范围只在发布测试、统计工具、报告和 Markdown，不改变 PR1～PR5 生产资金实现 |
| PR #129 P2/P3 定向修复证据 | RSS 模型/采样路径与 scan-vars 源码集合组合 `7/7 PASS`；5万/15万行 `31/31 PASS`（`46→51MB`，预算 85MB）；默认 50万/150万行 `31/31 PASS`（`82→135MB`，预算 139MB）；`scan:vars` 在本地 ignored build-info 存在时仍得到 293 文件、3737 名字；完整 base→工作树 `git diff --check` code 0 | `8→24`、`6→29`、`8→32` 反例拒绝；低信号追加两轮路径被 stub 锁定，任一样本 150MB 硬上限不能被中位数隐藏；spec 行尾问题和本地/clean 统计漂移均已直接收口 |
| PR #129 最终单次 `npm run release-check` | lint PASS；smoke PASS；unit `4795/4795 PASS`（303 个测试文件，0 failures）；integration `48/48` 脚本、`2457/2457` 可计数断言 PASS（`303845ms`） | RSS 默认档 `31/31`；VCC 调整归档继承 `295/295`、破坏性状态 `64/64`、effective `19/19`、历史模板导出 `28/28`；新 RSS/scan-vars 回归已进入全仓门禁，PR1～PR5 资金链无回归 |
| PR #129 `check:vars` | 当前 `c2b3b7e...→working tree` 没有 `src/` 改动，默认扫描正常跳过；完整 PR `e086f2d...→HEAD` 仅命中 Runtime-state `MODULES/app/dialog/setStatus/state`，无 Critical / Important-skeleton / Risk-sensitive | 五项均来自既有 PR6 capture/UI 路径：模块枚举未增删，`app` 仅 capture 失败退出，`dialog/setStatus/state` 为局部 DOM/状态；本轮测试/统计/文档修复未修改任何生产 `src/` 或资金实现 |

## PR #129 Unknowns Preflight（2026-08-09）

### Task Brief

- Goal：修复 1×P2 RSS 低信号证据缺口与 2×P3 Markdown/scan-vars 可复现性缺口，并在当前 PR6 分支提交，不 push。
- Context：基线 `c2b3b7e8...` 与远端一致；PR1～PR5 资金实现不是本轮修改范围。
- Constraints：保留 150MB 硬上限、非法输入 fail-closed、正常大小压力稳定性；完整 base→HEAD 检查；19 个既有未跟踪项不得触碰或暂存。
- Done when：三个反例与统计漂移都有自动回归，RSS 小/默认档、scan/check-vars、发布/预览契约和完整 release-check 通过，clean checkout 统计一致，提交后 tracked clean。

### Unknowns Register

| 未知 | 影响 | 处理 | 最便宜验证 | 当前决定 |
| --- | --- | --- | --- | --- |
| 默认 RSS 是否真的落在 low-signal，收紧后会否破坏常规 CI | 高 | PROBE | 未改代码跑默认 50万/150万档并记录两档增量 | `88→140MB`，明显为 measurable；low-signal 只在异常环境追加采样 |
| 单次低信号怎样区分取整/allocator 抖动与真实线性增长 | 高 | PROBE | 对确定性反例、三样本中位数及单样本 150MB spike 建模 | 条件式三样本中位数裁决趋势，同时对每个样本保留硬上限 |
| 294 与 293 差异是否只来自 generated build-info | 中 | PROBE | `git check-ignore`、`git ls-files`、本地扫描与独立临时 Git 仓库 | build-info ignored 且未跟踪；统计集合固定为 Git 已跟踪 JS |
| 完整 PR diff 是否还有最后提交看不到的 whitespace | 中 | PROBE | `git diff --check e086f2d...` | 原仅 Spec 5 行，已改 `<br>` 后 code 0 |
| clean checkout 统计 | 高 | PROBE | 对已暂存候选树建立 detached worktree，重跑 scan-vars 并与候选报告去时间戳后比较 | 已解决：clean checkout 不存在 generated build-info；293 文件、3737 名字和 `git-tracked-js` sourceSet 逐字段一致；完整 base diff-check code 0 |
| 完整发布门禁 | 高 | PROBE | 同一候选工作树运行 `npm run release-check` | 已全绿：unit `4795/4795`，integration `48/48` / `2457/2457` |

无 BLOCK 问题；没有采用会改变产品契约或资金边界的假设。

## Self-review Findings（2026-08-09）

### 事实、推断与未知

| 类型 | 结论 | 证据/边界 |
| --- | --- | --- |
| 事实 | PR 6 相对最新 PR 5 没有修改 `src/backend/` 或 `src/main-process/` 的生产资金实现；产品侧增量为 capture-only 预览门禁、renderer 状态观测与禁用态样式 | `git diff e086f2d99... -- src/backend src/main-process` 为空；正常启动不暴露 preview token/hook，未知/缺失/拒绝/超时均非 0 退出 |
| 事实 | PR 1～PR 5 的资金链在最终合并树中同时存在 | 强制 64-hex input fingerprint、完整 `issues[]`/openingState、DecimalAccumulator、preview token + generation、protected worker、逐表 preserved fingerprint、不可变 adjustment、effective result、targetMonth 租约内解析和结构化 `auditFailure` 均有代码与定向/全量回归 |
| 推断 | 在自动化覆盖的 SQLite/worker/Excel 边界内，结果行与九币种余额保持单一血缘，破坏性失败不会提交部分状态，历史导出不会使用 renderer runId 串月 | adjustment/archive/export/inherit `295/295`、destructive `64/64`、effective `19/19`、historical export `28/28`，加上 unit 与提交前 postcondition/preserved fingerprint；该结论不外推到未检查的生产库或 Windows 应用退出时序 |
| 未知 | 真实月份、生产数据库副本、Windows installer/portable、Excel/WPS 显示/打印与已保护 worker 关窗时序 | 保持为下方 Remaining Unknowns 和 preflight 人工/平台门禁；资金红线必须人工复核，自动化结果不得视为签字 |

### Findings 与处置

| 级别 | Finding | 最便宜验证 | 处置 |
| --- | --- | --- | --- |
| P2 | low-signal 分支把 `strictlyBelowLinear` 无条件设为 true，使 `8→24MB`、`6→29MB`、`8→32MB` 线性/超线性反例通过，不能支撑亚线性结论 | 直接调用模型，并以低信号触发的成对隔离采样 stub 验证实际分支 | 当时阶段已修复低信号线性判定并在首次 tier1 `<=8MB` 时重采；后续同根 P3 已把采样触发独立扩大为 `<=16MB` 的 RSS 重采保护区，增长分类仍以 8MB 为界。任一样本 150MB 硬上限、非法输入 fail-closed 与 700 万人工门禁不变 |
| P3 | `changes/3.1.8/spec.md` 前五行用 Markdown 双空格换行，完整 PR base→HEAD `git diff --check` code 2 | 对完整 `e086f2d...→HEAD` 跑 diff-check，不只检查最后提交 | 已改为显式 `<br>`；完整 base→工作树 diff-check code 0 |
| P3 | `scan-vars` 递归文件系统，把 ignored/generated `src/build-info.js` 纳入本地统计，clean checkout 文件数少 1 | 对照 `git check-ignore` / `git ls-files`，并在独立临时 Git 仓库同时放 tracked、ignored、untracked JS | 已改为只扫描 Git index 已跟踪 JS；报告写明 sourceSet，本地含 ignored build-info 时为 293 文件，自动测试证明 generated/untracked 均不进入 |
| P3 | 两档 RSS 在独立进程中的单侧 allocator 抖动使默认样本 `82→135MB` / `82→133MB` 仅越过 131MB 预算，却均低于 150MB 硬上限；原 8MB 单侧余量会产生稳定误报 | 在生产路径零 diff 的同一环境连续运行默认 50 万/150 万行档，并对照硬上限与原预算 | 已修复：可测档只把 tier2 单侧余量校准到 16MB，不放宽低信号 32MB 包络或 150MB 硬上限；小档、默认档及最终 release-check 内默认档均 `31/31 PASS` |
| P3 | RSS 可测增长把单侧噪声余量调到 16MB 后，原公式会放过 `9→27MB` 的低幅精确线性增长 | 直接调用 `assessScanMemoryGrowth(9, 27, 3)` 并锁定边界 | 已修复：可测档同时要求严格低于线性外推；`9→26MB` PASS、`9→27MB` FAIL，13MB/32MB 反例与 150MB 硬上限保留 |
| P3 | integration policy 仍把 `release-check` 写成三段且声称项目无 CI，与 package script 和 Windows workflow 不一致 | 对照 `package.json` 与两份 workflow | 已修复为 lint + smoke + unit + integration，并明确本地与 Windows PR/Release 使用同一门禁 |
| P0～P1 | 未发现 | 对入口旁路、失败关闭、租约/代次、金额币种、幂等、部分失败、行数/子表守恒、审计与输出回读逐项复核 | 无需代码处置；人工资金红线不降级为自动通过 |
| PR 5 调整原因 ST_Xstring 定向探针与回归 | 原始 `核对_x000D_补记` 经 ExcelJS 重开会变成真实回车；边界编码后，字面 `_x000D_`、`_X000d_`、预编码外观 `_x005F_x000D_`、真实 CRLF 和普通中文/emoji 均严格等于业务原文。helper+writer `17/17 PASS`，相关 writer/renderer/archive/audit 组合 `87/87 PASS` | 证明修复点必须且只需位于 N 列赋值边界；sharedStrings 断言同时锁定 escape 词法，defined-name 仍可逆还原 `rowKey × JPY`，数据库 reason 未被 OOXML 词法污染 |
| PR 5 调整归档与历史按月导出真实链 | 调整归档导出继承链 `297/297 PASS`，历史 `targetMonth` 模板导出链 `28/28 PASS` | 同一真实 service/SQLite 链核对 adjustment 写入、review DTO、archive audit、按月 semantic writer、ExcelJS reason 严格回读、M defined-name 血缘及次月九币种期初；未走 helper-only 捷径 |
| PR 5 ST_Xstring 修复最终全仓门禁 | 全量 `src/` ESLint PASS；unit `4761/4761 PASS`（297 个测试文件）；integration `48/48` 脚本、`2459/2459` 可计数断言 PASS；smoke PASS；`npm run check:vars` code 0，未命中重要变量 | 静态、writer/renderer、历史导出、调整归档继承、迁移/大文件/side DB 和其他业务链均无回归；integration runner 已同步 policy |
| PR 5 ST_Xstring blindspot + reconciliation 终审 | 从调整 UI/service 原文 → 不可变账本 → review DTO → archive audit → semantic writer N 列单次编码 → ExcelJS strict readback 全链枚举入口；代码搜索确认无第二个调整原因 Excel 写入口。重复导出不变异数据库原文，失败继续由 staged validator/原子发布阻断，金额、币种、月份、行数与余额均未改 | 未发现 P3+ 旁路、双重编码、状态/幂等、审计不一致或资损风险；真实月份逐主体逐币种及 Windows Excel/WPS 打开显示仍保留人工发布门禁 |
| PR #127 三条 finding 定向回归 | calculator、result-adjustments、service 共 `77/77 PASS`；全部 VCC + 错误序列化组合 `270/270 PASS` | AFTER INSERT 篡改旧调整 sequence/基础 run row、删除 replacement success audit、篡改 archive success evidence/app/build 均触发结构化错误；业务事实完整回滚，只保留 rolled_back；calculate 伪造字段不会越过 service allowlist |
| PR #127 真实 SQLite + worker 链 | adjustment/archive `59/59 PASS`；destructive `64/64 PASS`；effective result `19/19 PASS` | 调整→重算替换→归档、三月破坏性事务及最终金额/只读归档三条独立链无回归，审计、revision、九币种和跨月期初血缘保持 |
| PR #127 全仓门禁 | 全量 `src/` ESLint PASS；smoke PASS；unit `4746/4746 PASS`（295 个测试文件）；integration `47/47` 脚本、`2193/2193` 可计数断言 PASS | 静态检查、其他模块 smoke、全仓单测、迁移/大文件/side DB 与 VCC 三条真实链均通过；integration runner 已同步 policy |
| PR #127 `npm run check:vars` | 4 个 `src` 文件仅命中 Runtime-state 通用词 `state`；实际为 VCC 事务局部/函数命名，未修改 `src/renderer.js` 顶层 `state`，无 Critical / Important-skeleton / Risk-sensitive 清单命中 | 已复核任务代次、worker provenance、结果 revision/status 与审计生命周期；smoke 和 service 契约回归通过。新增 `snapshotResultMutationState` 跨 3 个源文件且承载资金事务边界，作为下次 `scan:vars` 的 Risk-sensitive 升格候选交由人工审批，不在本次静默改清单 |
| PR #127 blindspot + reconciliation 复核 | 沿 renderer/IPC→service allowlist→worker→calculate/adjust/archive→audit 检查入口旁路、全 19 表主键/月份/run 血缘、金额币种不变、幂等/revision、部分失败、全表/新行守恒和可观测性 | 未发现遗留可自动化 P2/P3 缺口；无自动修复或生产数据写入。真实生产副本的调整→替换→归档逐主体×币种及历史审计一致性仍是未完成的人工资金红线 |
| #127 → #128 restack 双亲与冲突预检 | 待提交父固定为 `b0b367b98176e4c3f28aa5942d8d3c69c450790a` + `28fbd2aad5c39362fb10bd0903c83f3fa26f139d`，共同祖先 `31810ef5...`；合并后无 unmerged entry、无冲突标记，staged `git diff --check` PASS | 生产代码与测试自动合并；实施记录保留双侧，policy 先取较新 48 脚本清单再由最终 integration 刷新；未使用 rebase/force/squash |
| #127 → #128 restack 定向与真实链 | #127 calculator/result-adjustments/service 故障注入 `77/77 PASS`；#128 writer/helper `17/17 PASS`；真实 adjustment/archive/export/inherit `297/297`、destructive `64/64`、effective `19/19`、historical targetMonth `28/28` 全 PASS | AFTER trigger 全表漂移/success audit 篡改/provenance 伪造继续 fail-closed；调整原因原文、M/N defined-name、按月租约导出和次月九币种继承未被 19 表指纹收紧破坏 |
| #127 → #128 restack 最终单次 `npm run release-check` | 以共享锁定依赖路径执行：lint PASS；smoke PASS；unit `4766/4766 PASS`（297 个测试文件）；integration `48/48` 脚本、`2459/2459` 可计数断言 PASS（271096ms），policy 自动刷新 | 静态、基础集成、全仓 unit、迁移/大文件/side DB 及四条 VCC 真实链均无回归；证据对应待提交最终树 |
| #127 → #128 restack `npm run check:vars` 与双盲区终审 | 工具 code 2 仅命中 Runtime-state 通用词 `state`；diff 实际是 `operation-state`/`preserved-state`/`*StateError`/`snapshotResultMutationState` 等后端局部命名，未修改 renderer 顶层 `state`。沿 service allowlist→worker→calculate/adjust/archive→19 表指纹/audit→targetMonth export→Excel readback→次月继承复核入口、状态、幂等、部分失败、九币种和审计血缘 | 无现存 P3+ 或新增旁路；`snapshotResultMutationState` 仍是待人工审批的 Risk-sensitive 升格候选，不静默改清单。真实生产副本逐主体×币种/revision/sequence/success+rolled_back 审计与 Windows Excel/WPS ST_Xstring 显示仍为发布人工资金红线 |
| #129 → 冻结 #128 合并边界与冲突裁决 | `67019de...` 与 `cc3080e...` 的共同祖先为 `e086f2d...`，两侧独有 6/3 个提交；普通 `--no-commit` merge 仅冲突 implementation-notes 与 integration policy，生产代码/测试无冲突。#127/#128 资金文件逐字节等同 `cc3080e`，#129 RSS/scan/spec 文件逐字节等同 `67019de`；markers 为 0 | notes 按双方决策/证据并集合并；policy 由本轮 48 脚本全绿后自动重建，未用旧计时覆盖最终树；相对 `cc3080e` 的 intended 范围为 60 文件（34 modified + 26 added） |
| #129 → 冻结 #128 定向与真实链 | #127 calculator/result-adjustments/service `77/77 PASS`；#128 helper/writer `17/17 PASS`；#129 RSS 模型/重采样/scan source-set `7/7 PASS`；5万/15万真实 RSS 链 `31/31 PASS`（`44→44MB`）。四条真实链分别为 `297/297`、`64/64`、`19/19`、`28/28` | AFTER trigger 全表漂移、success audit/provenance 伪造继续 fail-closed；ST_Xstring 仅在 Excel 边界单次编码；低信号反例、任一样本 150MB 与 Git-tracked source set 同时保留 |
| #129 → 冻结 #128 最终统计与发布门禁 | 本地 SHA `61bcd26d2f7e11622ac322011f50c622cd5ad560`（无 Actions run ID）：`scan:vars` 为 Git-tracked `src/` 293 文件、3744 个顶层名字（A-share 558 / A-pair 800 / A-local 2232 / B 1358）；`release-check` 为 lint/smoke PASS、unit `4801/4801`（303 文件、0 failures）、integration `48/48` / `2459/2459`（`294086ms`），policy 自动刷新 | 这是该历史本地 SHA 的证据，不是后续 Windows 口径；默认 50万/150万 RSS 为 `31/31`，同一次本地门禁包含 297/64/19/28 四链。`check:vars` 对 #128 合并增量仅命中 Runtime-state `state`；完整 PR base `cc3080e...` 仅命中 Runtime-state `MODULES/app/dialog/setStatus/state`，无 Critical / Important-skeleton / Risk-sensitive 命中 |
| #129 → 冻结 #128 blindspot + reconciliation 终审 | 沿 service allowlist→worker→calculate/adjust/archive→19 表指纹/success audit→targetMonth semantic writer→ST_Xstring readback→次月九币种继承，复核入口、主键血缘、金额币种、状态/幂等、部分失败、行/子表守恒与可观测性 | 未发现新的 P3+ 或自动化缺口；未改金额、币种、方向、主键或迁移契约。`snapshotResultMutationState` 仍待人工审批清单升格；真实生产副本逐主体×币种/revision/sequence/audit 与 Windows Excel/WPS 显示继续是发布资金红线 |

## #129 → 冻结 #128 Restack Unknowns Preflight（2026-08-09）

### Task Brief

- Goal：在 #129 修复头 `67019de` 上以普通 merge 合入冻结 #128 `cc3080e`，保留双亲和三条 PR 的全部不变量，不 push。
- Context：两侧共同祖先为 `e086f2d...`；#128 已包含 #127 资金事务收紧与 ST_Xstring/semantic export，#129 已冻结 RSS/scan/spec 证据修复。
- Constraints：严禁 rebase/force/squash；19 个既有 untracked 入口不读取、不暂存、不移动、不删除；资金红线不由自动化替代人工签字。
- Done when：双亲/祖先正确，无冲突标记；定向与四条真实链、scan/check-vars、完整 base diff-check、release-check、clean checkout 均通过；notes/policy/reports 对应最终树。

### 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 冻结头分叉且可普通合并 | `merge-base=e086f2d...`，两侧独有 6/3 提交 | 第一父必须保持 `67019de`，第二父必须为 `cc3080e` |
| 生产代码和测试可自动合并 | merge 只冲突 notes/policy；双方关键文件与对应父逐字节一致 | 不得借文档冲突改写生产契约 |
| 最终来源集合和集成清单必须重算 | #127 新增顶层名字；297 链比 #129 旧快照多 2 断言 | 不沿用 3737/2457 等历史计数 |

### Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 三条 PR 不变量能否同时存活 | 资金/状态盲区 | 高 | 困难 | 双方关键文件无冲突 | PROBE | 77/17/7 定向 + 297/64/19/28 真实链 | 已解决，全部精确通过 |
| 报告是否对应最终树 | 可复现性 | 中 | 容易 | 旧快照分别为 3737/2457 与 2459 | PROBE | 重跑 scan-vars、integration runner | 已解决：3744/2459 |
| 最终双亲、祖先与 clean checkout | Git/交付边界 | 高 | 一般 | 对最终候选树生成无引用双父提交并 detached 验证 | PROBE | 检查 `%P`、`merge-base --is-ancestor`，detached worktree 重跑 scan | 已解决：父序预演为 `67019de cc3080e`、#128 为祖先；clean scan 与报告逐字段一致，为 293/3744/`git-tracked-js`；正式提交后再复核确切 HEAD |

### 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 普通 merge 与语义冲突裁决 | 父链、生产契约 | 仅 notes/policy 冲突，关键文件与父一致 | 推翻合并方案 | 中止 merge，冻结头不变 |
| 2 | 定向与真实资金链 | 19 表、audit、provenance、ST_Xstring、RSS | 77/17/7 与 297/64/19/28 全绿 | 阻断提交并修复 P3+ | 仅修可复现缺口，不放宽资金门禁 |
| 3 | 重生成报告并全量回归 | 可复现证据、其他模块兼容 | 293/3744、4801/2459 | 阻断提交 | 恢复到 runner/scanner 生成结果 |
| 4 | 双盲区与提交图/clean checkout 复核 | 交付完整性、人工红线 | 无 P3+、双亲正确、clean scan 一致 | 阻断交付 | 不 push，保留本地 merge 供诊断 |

## 冻结 `61bcd26` P3 Follow-up（2026-08-09）

### Task Brief

- Goal：修复 RSS 8/9MB 边界采样次数突变与 Spec 阶段哈希表述不完整两个 P3，在冻结 `61bcd26d2f7e11622ac322011f50c622cd5ad560` 上提交，不 push。
- Context：分支、HEAD 与远端完全一致且 tracked clean；本轮不改 `src/`、资金数据、增长分类或发布契约。
- Constraints：保留 8MB low-signal 分类、32MB 低信号包络、严格低于线性、任一样本 150MB 硬上限与非法输入 fail-closed；19 个既有未跟踪项不读取、不移动、不删除、不暂存。
- Done when：9/16MB 重采、17/约82MB 单采样、中位数与 spike 有确定性回归；Spec 三阶段哈希与两类差异可自动核验；小/默认压力、docs、完整 diff-check、release-check、scan/check-vars 和盲区复核通过。

### Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 最便宜验证 | 当前决定 |
| --- | --- | --- | --- | --- | --- |
| 16MB 应改变增长分类还是只改变采样触发 | RSS 契约 | 高 | PROBE | 对照既有常量、反例和 16MB 可测档公式 | 只新增 `RSS_RESAMPLE_PROTECTION_MAX_MB=16`；low-signal 仍为 `<=8MB`，9～16MB 明确称 RSS 重采保护区 |
| 保护区扩大是否让默认档无条件三采样 | 性能/CI | 中 | PROBE | 小规模和默认 50万/150万真实链记录首次 tier1 | 小档 `42MB`、默认档 `82MB`，均单采样并 `31/31 PASS`；17MB 和 82MB stub 同样锁定不重采 |
| 中位数能否统一裁决 8/9MB 抖动且不隐藏硬上限 spike | 失败模式 | 高 | PROBE | `9,8,8 → 26,24,23` 与含 151MB 样本的确定性模型 | 中位数把前者裁决为 `8→24MB` 并拒绝线性趋势；后者中位趋势虽通过，但 every-sample ceiling 独立失败 |
| Spec 的 `018675...` 是否是当前候选哈希 | 证据链 | 中 | PROBE | 对 original、pre-format stage 与当前文件的规范化内容 SHA-256/差异 | 否；`018675...` 是仅修两路径、五处格式修复前阶段，当前 CRLF/CR → LF 规范化冻结内容为 `1f5f0663...`；业务内容仅两处路径，另有五处语义等价格式修复 |
| 是否存在同根 P3+ 表述漂移 | 文档/可观测性 | 中 | PROBE | 搜索采样阈值、low-signal、两阶段哈希及相关测试 | 找到并修正旧 self-review 把 `<=8MB` 重采写成当前结论的证据一致性 P3；历史测试计数保留为当时事实，未发现行为 P3+ |

无 BLOCK 问题；没有采用会改变产品、资金、数据或公开接口的假设。

### 当前证据

| 检查 | 结果 | 证明/边界 |
| --- | --- | --- |
| RSS + scan-vars + release docs 定向组合 | `11/11 PASS` | 9/16MB 三采样，17/82MB 单采样，中位数决定趋势，任一样本 150MB 硬上限不被隐藏；Spec 当前哈希与三阶段证据被测试锁定 |
| RSS 小规模真实链 | 5万/15万 `31/31 PASS`，`42→48MB`，样本数 1 | 保护区外保持单采样，亚线性预算 79MB、150MB 硬上限和真 multi-sheet/worker 链同时通过 |
| RSS 默认真实链 | 50万/150万 `31/31 PASS`，`82→134MB`，样本数 1 | 默认约 82MB 不触发重采；tier2 低于 139MB 可测预算和 150MB 硬上限 |
| Spec 当前文件 | CRLF/CR → LF 规范化冻结内容 SHA-256 `1f5f0663ee35436c8b1f7da628822a4f83a3f70db215cd5ebd60a6720bae367d` | original `9f3af...`、pre-format `018675...` 与当前候选三阶段分离；完整 `cc3080e...→working tree` diff-check code 0 |
| `scan:vars` / `check:vars` | Git-tracked `src/` 293 文件、3744 个顶层名字；`check:vars` code 0 并因 `src/` 无改动跳过。合并前硬节点再次运行 `scan:vars`，两份报告只刷新 `scannedAt/扫描时间`，统计与源码集合均无漂移 | 本轮只改测试/docs 契约和发布证据，无重要变量命中；保留并纳入共享工作树中的合并前时间戳刷新，不覆盖协作者改动 |
| 最终单次 `npm run release-check` | 本地候选内容（后提交为 SHA `9eabde33113e0cb1a54891611bd0dba5b5ce1f52`，无 Actions run ID）：lint PASS；smoke PASS；unit `4802/4802 PASS`（303 文件、0 failures）；integration `48/48` 脚本、`2459/2459` 可计数断言 PASS（`291703ms`） | 这是本地证据；跨平台 Spec 哈希回归已进入全仓门禁，release 内默认 RSS `31/31 PASS`，297/64/19/28 四条 VCC 真实链均保持。后续 Windows run `31296877417` 的 RSS 失败另行记录，不得把本行概括为 Windows 或全平台 PASS |
| blindspot threshold/evidence consistency 终审 | `assessScanMemoryGrowth()` 与 8/32/150MB 判据相对冻结 HEAD 零行为 diff；16MB 新常量只进入 `collectMemorySamples()` 重采条件。日志、代码注释、测试和 preflight 均把 9～16MB 称为 RSS 重采保护区；三阶段 Spec 哈希、当前规范化内容实算值和两类差异表述一致 | 已修复旧 self-review 把 `<=8MB` 写成当前重采边界的同根文档 P3；未发现其余 P3+。负值、非有限值、采样异常继续失败关闭；真实 700 万压力、Windows 构建/Excel/WPS 和财务人工资金核对仍为发布门禁 |
| Windows Actions run `31295431757` Spec 哈希失败根因与修复 | LF checkout 原始 SHA-256 为 `1f5f0663...`；同内容模拟 CRLF 得到 CI 实际 `9af4dfd836ea3037cf3006b0746ba639fcc482bf16472680181c5b840aa9a0c3`，CRLF 再规范化为 LF 后恢复 `1f5f0663...` | 哈希入口仅把 CRLF/孤立 CR 规范化为 LF，其他字节仍参与 SHA-256；自动测试锁定 LF/CRLF/CR 等价，并用真实路径内容变化证明非换行改动继续失败。定向 `5/5 PASS`、完整 release-check `4802/4802` + `2459/2459`；Spec 本身、业务路径和三阶段证据值未修改 |
| Windows Spec 哈希 P3+ blindspot 终审 | 搜索确认冻结哈希只有 release-docs 单测这一处可执行入口；规范化函数用 latin1 保持字节一一映射，只替换 `0D 0A`/`0D` 换行，不做 trim、Unicode 规范化或内容修补。Spec、`src/`、scan 源码均零 diff；两份 scan 报告仅为协作者执行合并前硬节点产生的时间戳刷新，293/3744 不变 | 未发现遗留 P3+。内容变更、增删尾随换行、Unicode 或其它字节变化仍改变哈希并触发断言；剩余外部验证仅为修复提交后的 Windows Actions 重跑，不在本地伪造通过 |

## Windows RSS 边界重采 Follow-up（2026-08-09）

### Task Brief

- Goal：修复 Windows Actions run `31296877417` 在 `49→94MB`、精确预算 `89.5MB` 处的单样本边界裁决，不改变既有 RSS 增长预算或硬上限。
- Context：同一 SHA `9eabde33113e0cb1a54891611bd0dba5b5ce1f52` 的本地 `release-check` 为 unit `4802/4802`、integration `48/48` / `2459/2459`；Windows unit 为 4801 pass + 1 skipped，其他 47 个 integration 脚本通过，仅 RSS 脚本 `30/31`。PR 相对冻结 #128 的生产 scan 路径为零 diff。
- Constraints：不改 `src/`、Spec、16MB measurable 余量、8/32MB low-signal 边界、0.5 fraction、strict-linear 或 150MB hard cap；19 个既有未跟踪入口不读取、不移动、不删除、不暂存；不 push、Ready 或 merge。
- Done when：首对 measurable 样本距预算边界两侧 `<=8MB` 时固定追加两组成对采样；旧独立中位裁决继续是必要条件，paired budget/linear margin 只新增拒绝；精确日志、反例、真实小/默认档、全仓门禁、diff/check-vars 与 P3+ 复核通过，并提交到本地分支。

### Unknowns Register

| 未知 | 类型 | 影响 | 处理 | 最便宜验证 | 当前决定 |
| --- | --- | --- | --- | --- | --- |
| `49→94MB` 是生产回归还是平台基线/单样本敏感 | 归因 | 高 | PROBE | 对比 PR5 base 的生产 scan 文件、倍率/硬上限与 47 条其余 integration | 生产路径零 diff，`94/49≈1.92 < rowsRatio 3`，且 94MB 低于 147MB 线性外推和 150MB 硬上限；不是本 PR 生产回归证据，但单次 Windows 样本仍不能区分随机抖动与稳定平台基线 |
| 成对 margin 是否可能放宽历史裁决 | 回归边界 | 高 | PROBE | 回放 `[9,8,8]→[26,24,23]` 和构造独立中位假 PASS 反例 | 采用保守 AND 双门禁：原独立中位 assessment 必须通过，paired budget/linear margin 也必须通过；paired 只能新增拒绝，历史 8/9MB 边界 FAIL 不翻转 |
| 边界重采会否重复追加或只覆盖失败侧 | 状态/偏差 | 中 | PROBE | stub 首对在预算两侧恰好 8MB，并让 9～16MB 同时命中两条件 | 单一布尔门控制固定三样本；低 tier1 保护区优先且不重复追加，可测预算 PASS/FAIL 两侧对称触发 |
| 发布证据中的 4801/4802 口径能否追溯 | 可观测性 | 中 | PROBE | 对照 preflight 两处计数与 Windows run | 本地 4802/4802 和 Windows 4801 pass + 1 skipped 按 SHA/平台/run ID 分开；Windows RSS FAIL 前不得再称自动化平台门禁完成 |

### Decisions

| 决策 | 原因 | 放弃方案/边界 |
| --- | --- | --- |
| 首对 `measurable-growth` 的 `abs(tier2 - sublinearLimit) <= 8MB` 与既有 tier1 `<=16MB` 任一命中即追加两组成对采样 | 覆盖预算两侧边界抖动，同时保持增长分类与预算不变 | 不只对 FAIL 侧重采，避免选择偏差；不全局三采样，远离边界仍保持单样本 |
| 多样本同时要求独立中位 assessment、paired budget-margin 中位数 `<=0`、paired linear-margin 中位数 `<0` | 保留上一轮 reviewer 锁定的历史 FAIL，并阻止不同轮次错配造成假 PASS | 不采用“paired 多数可把独立中位 FAIL 翻为 PASS”的宽松裁决 |
| 150MB 对每个原始样本逐一检查；日志输出未四舍五入的参考预算和两类 paired margin | 中位数不得隐藏 spike；Windows `89.5MB` 不再显示成误导性的 90MB | 不改 150MB，不用日志格式替代真实浮点比较 |

### 当前证据

| 检查 | 结果 | 证明/边界 |
| --- | --- | --- |
| Windows Actions 基线 | SHA `9eabde33113e0cb1a54891611bd0dba5b5ce1f52`，run `31296877417`：unit 4801 pass + 1 skipped；RSS `30/31`，其他 47 个 integration 脚本通过 | 精确预算 `49×3×0.5+16=89.5MB`，94MB 超 4.5MB；整体 workflow FAIL、build skipped |
| RSS 确定性单测 | `6/6 PASS` | 预算两侧 `<=8MB` 对称重采且不重复；稳定 `49→94` 三样本仍 FAIL；旧 `[9,8,8]→[26,24,23]` 仍 FAIL；独立中位假 PASS 会被 paired margin 拒绝；线性、140/150、非法输入均 fail-closed |
| RSS + release-docs 定向组合 | `11/11 PASS` | RSS 六组模型/采样回归与版本候选、用户文档、Spec 三阶段/跨换行哈希契约同时通过 |
| RSS 小规模真实链 | 5万/15万 `31/31 PASS`，`38→42MB`，单样本 | 预算 73MB、paired 预算 margin -31MB、线性 margin -72MB；远离 8MB 边界带时不追加采样，真实 multi-sheet/worker 链保持 |
| RSS 默认真实链 | 50万/150万 `31/31 PASS`，`88→133MB`，单样本 | 预算 148MB、paired 预算 margin -15MB、线性 margin -131MB；默认档本轮远离保护带，150MB 硬上限与真实链同时通过 |
| 本轮最小修复候选树最终单次 `npm run release-check` | 基于 `9eabde3` 的本轮最小修复候选树（尚无 Actions run ID）：lint/smoke PASS；unit `4802/4802 PASS`；integration `48/48` / `2459/2459 PASS`（`295458ms`） | RSS 脚本 `31/31 PASS`，297/64/19/28 四条 VCC 真实链保持；runner 只刷新 integration policy 时间与耗时。该本地证据不替代提交后的 Windows Actions 重跑 |
| diff/check-vars 与 P3+ 终审 | 目标脚本/单测 ESLint PASS；本轮最小修复候选树与完整 `cc3080e...→候选树` diff-check code 0；本轮提交未修改 `src/`，`npm run check:vars` 因 `src/` 无改动而跳过；生产 scan 路径相对冻结 #128 仍为零 diff；19 个既有 untracked 入口数量不变 | 复核入口、边界、失败关闭、配对关系、硬上限和日志：首对预算两侧恰好 8MB 均触发、两侧 9MB 均单采样；9～16MB 双条件只追加一次；独立中位旧裁决与 paired margin 为 AND，paired 不能新增 PASS；非法/非有限样本、精确线性和任一 150MB spike 均拒绝。未发现剩余 P3+；唯一存活外部未知是修复提交后的 Windows Actions 结果 |

### Remaining Unknowns

| 未知 | 处理 | 下一步 | 合并影响 |
| --- | --- | --- | --- |
| 修复后的 Windows 平台结果 | PROBE（外部） | 本地提交后由根代理 push 并重跑 Windows Actions；按 run ID 回写最终状态 | 阻断 Ready/merge，不阻断本地修复提交 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 生产历史 Pending raw_json 是否有未知列数 | 已通过 dry-run 迁移测试与运行时失败关闭收口 | PR 1 覆盖 46/48/异常列数；异常历史事实拒绝迁移且不改写 | 不再阻塞代码合并；生产遇到异常仍需人工处置 |
| Windows 打包资产与 Excel/WPS 实际显示 | PROBE + 人工门禁 | 任意 PR 的 Windows x64 构建提供产物证据；财务人员实际打开 installer/portable 与 Excel/WPS 复核 | 阻塞版本发布 |
| GitHub 登录恢复 | BLOCK（发布） | 用户执行 `gh auth login -h github.com`，Codex 复检 | 阻塞 push/PR，不阻塞实现 |
| 真实月份逐主体逐币种复核 | BLOCK（发布） | 财务人员按最终核对清单执行 | 阻塞 3.1.8 发布 |
| 其他生产机器的存量 calculated run 是否存在空分类或被手工改写的非规范金额 | PROBE + fail-closed | 本机生产库只读探针确认 run/row/balance 均为 0；其他机器仍须在升级前只读扫描，异常 run 要求重跑 | 不得把本机“无存量 run”结论泛化；可能要求异常旧 run 重新运行，不允许静默归档 |
| 调整写入事务能否始终保持 `sequence=N+1` 与 `result_revision=N+1` | 已用事务、唯一约束、故障与 stale revision 单测消除 | 继续由 `getEffectiveRunResult()` 在每次读取、归档和审计时复核连续 sequence/revision | 不阻塞合并；任何账本漂移仍按结构化错误失败关闭 |
| 生产历史 archived run 是否存在 archive subject/九币种/effective result/dataset 不一致 | PROBE + fail-closed | 合入前对生产副本执行只读枚举/preview；异常月份人工核账，不自动修复 | 异常月份不可解归档/导出，但不污染其他月份 |
| Windows 退出过程中已保护 worker 的真实时序 | PROBE/平台测试 | 自动化已覆盖“取消在先→critical-ready 未 protected→timeout terminate”和“protected 后只等待”；仍需 Windows CI/手测在真实 SQLite 事务中触发关窗 | 阻塞 3.1.8 发布，不阻塞代码评审 |
| PR #127 真实生产副本调整→重算替换→归档的逐主体×币种、revision/sequence 与历史 success/rolled_back 审计一致性 | BLOCK（资金红线，人工复核未完成） | 财务人员在只读副本逐笔核对；异常事实只诊断并阻断，不自动修复 | 阻塞 3.1.8 发布，不阻塞本地代码评审 |
