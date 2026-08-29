# E10-A Implementation Notes

## Baseline

- Goal/spec：frozen v3.2.3 spec/techdoc §9、§10、§11 的 E10-A NewAccount generation core/Worker。
- Initial plan：见同目录 `preflight.md`。
- Done when：唯一 core、bounded contract、allowlisted template、one-shot Worker、业务回读与 Main technical validation完成；production/legacy/workerCount 保持 `false/legacy/0`。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| live legacy handler 与 Worker 共用业务 pure core，E10-A 不切 live | E10-B Publisher 尚未实现且 frozen release strategy 要独立 flag | E10-A 直接替换 live handler | 用户行为零切换，允许完整 golden 后再启用 |
| 模板 identity 使用固定 allowlist path + stat snapshot + SHA-256，Worker 前后双检 | 只校验 caller path 或 metadata 存在 TOCTOU/同 metadata 内容替换盲区 | 信任 Worker input path；只用 `existsSync` | 模板变化一律 fail closed |
| 复用 Statement staging ownership validator | 已覆盖 root/ancestor symlink、realpath、hardlink、alias | 新写一套弱化路径判断 | technical validation 与 cleanup 权限一致 |
| Worker result 不回传 generationPath，Main 以自己冻结的 input 绑定 staging | Worker 自报路径不能授予校验/删除权限，且结果不应泄露本地路径 | manifest 回传 generationPath 并驱动 cleanup | Main 只按已授权 staging path 校验 size/hash；Worker 无 final target |
| Worker contract 上限为 256 KiB、64 账户、每账户 64 币种、250,000 预计记录 | 64×64×近 10 年会放大到千万级行；bounded DTO 不能只限制 JSON 字节 | 沿用 legacy 无界 Worker input | dormant Worker fail closed；live legacy 不新增记录上限 |
| E10-A 在 `before-write/after-write/after-readback/before-terminal` 显式让出 Worker 消息循环，并在 entry 发 `job:done` 前再过一次 cancel gate | 同步 XLSX 读写期间仅读 `signal.aborted` 无效，因为 `job:cancel` 尚无法被 Worker message handler 处理；真实 runtime 修复前返回 `completed` | 修改全局 Supervisor 对 cancel 后 `job:done` 的通用语义；在 Worker/core 删 staging | 已接受 shutdown cancel 的 running job 以 cancellation error 收口；唯一 Main/client cleanup owner 删除 task-private generation，artifact handle 为 null |
| 落盘业务回读改为 ZIP/worksheet XML 流式扫描，并用共享 incremental canonical-array hasher 分批计算四项 evidence | 250k 旧链 `readFile 3197ms + sheet_to_json 566ms + actual/expected evidence 1758/1986ms` 连续占用消息循环；其中单次 readFile 已接近冻结5秒，不能靠更快机器假设 | 放宽Supervisor timeout；跳过实际落盘回读；把整段 `XLSX.readFile` 放到同一 Worker 的同步 promise；新增第二业务Writer | 复用既有 `zip-reader` 打开真实sheet entry，E10专用strict projection每1024行 pause/yield/check，expected evidence每1024行yield/check，artifact hash走异步stream；header/rowCount/日期/账户/币种/四digest与旧canonical byte-for-byte不变 |
| 精确阶段取消钩子只通过 test-only WorkerData `MessagePort` 注入 | readFile后/row/evidence/job:done前竞态必须等真实阶段到达后再shutdown，轮询文件存在不能定位具体窗口 | 在Protocol progress/result新增stage；向业务DTO加测试字段 | production Registry不传端口；generation contract/result/schema无stage字段，钩子只上报行数等非业务细节；Main cleanup观察点不能替换cleanup owner |
| 把 contract 的预计行数提取为共享纯函数，input limit 与 estimator 共用 | 准入必须与实际“账户 × 开户日至昨日 × 币种”记录数同口径，不能为资源再复制一份算法 | 让 caller 传 projectedRows；estimator 独立重算 | 冻结 DTO 不增字段；golden/property 对照实际 `records.length` |
| E10 resource profile v2 采用 shape-aware envelope | v1 row-only 被合法250k短文本与60,416最大文本真实反例推翻；v2 固定640 MiB拆为256 MiB executor +64 MiB writer +64 MiB readback +256 MiB safety，再计每record 2048、每cell 384、实际重复文本 writer 3份/readback 2份 UTF-8与UTF-16，以及SheetJS XML单元格编码2份 | 只提高统一per-row常数；全部按最大10.20 GB预留；降低 MAX_RECORDS；Main物化records后估算 | 共享 projector 只遍历账户×币种配置，输出 rows/cells/UTF-8/UTF-16/单元格编码摘要；小任务约640 MiB，合法大shape按实际文本增长，理论最大10,201,588,640 bytes，overflow/越界 fail closed |
| 复用 `resources.profile` Registry binding 在 Supervisor admission 前同步求动态 phase vector | 该 key 已是冻结静态引用；Supervisor 在 `adapter.start()` 前获取 PhaseLease | 新增 Protocol 字段；把 NewAccount 业务逻辑硬编码到 Supervisor；Worker 启动后再伸请 | runtime 只为 E10 注册 estimator，其他 action 继续静态 phase；不可能容纳的总预算在 Worker spawn 前拒绝，并发仍由 Governor 排队 |
| 只在 `validateNewAccountGenerationResult.allowFinanceSafeValue` 放行5个冻结 digest path | Protocol 已支持从 action-specific result validator 读取delegate；全局digest key扩张会让其他action/同名异路径绕过完整账号检测 | 修改全局full-account规则；把 `*Sha256` 全部加入通用allowlist；仅按字段名放行 | 仅 exact `/payload/result/artifact/templateSha256` 与 `businessEvidence` 四项、lowercase 64hex、父artifact/evidence冻结shape通过时放行；最终result schema仍由原validator独立拒绝 |
| E10 readback使用专用strict typed/coordinate projection，generic import scanner不改 | generic scanner按导入合同返回字符串且容忍重复/错位坐标，numeric leading-zero、boolean与cell row mismatch可使回读fail-open；旧SheetJS raw会按类型/坐标解释 | 给generic scanner打E10特例；把所有业务cell强制字符串；在Main信任内存records | `s/inlineStr/str/n/b/d/e/formula cached`与旧raw oracle同值，rich text排除`rPh`；row/cell坐标、XML根/截断/实体严格校验，合法sparse/blank仍保持`blankrows:false`语义 |
| E10 strict projection要求唯一canonical worksheet dimension并与物理used range一致 | 冻结writer固定写`A1:{lastColumn}{max(records+1,2)}`；旧SheetJS会回算missing/duplicate、规范化reversed/absolute并容忍expanded，不能据此证明元数据与cell血缘一致 | 忽略dimension；继续依赖SheetJS宽松`!ref`；只检查业务cell不检查merge/styled blank | dimension必须在sheetData前唯一出现，仅接受uppercase相对`A1`或`A1:END`、有序且在XLSX范围；used range累计全部cell refs与merge ranges，除冻结header-only `A1:{lastColumn}2`对实际header行外必须exact |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 日期继续采用 legacy 本地日历语义 | 冻结要求 golden 等价，legacy 使用 local `Date` | 改 UTC 会改变非上海时区/DST 边界 | 昨日/3650/3651 边界 golden；若产品另定时区则先改 spec |
| macOS 真实 RSS 只用于校准方向，不作为跨平台精确断言 | GC、SheetJS、Node/Electron 与采样时机会导致波动 | 若 Windows/packaged 增幅高于当前 envelope，低估风险重现 | 确定性 estimator 边界是自动门禁；R3.2.3 Windows RSS 人工门禁实测后只能向上调整余量 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 原 closeout 认为 shared Supervisor + fake crash/late-done 证据已覆盖 running Worker shutdown | 替代 Reviewer 补出真实 runtime 用例；同步 XLSX 阻塞 cancel message，实际为 `completed/job:done`、`generated != null`且 staging 残留 | 原证据只证明 Supervisor 迟到终态收口，没有证明真实 Worker 能在重型阶段观察 cancel | 补充模块 safepoint 与真实 cancel-wins 验收；冻结业务输出不变 | 是（同目录 preflight/checklist 已反向同步，frozen spec 合同未变） |
| 原计划由前一 Reviewer 完成复核 | 前一 Reviewer 两次被平台分类器拦截，后续改用替代 Reviewer；替代 Reviewer 确认本次 1 个 P2 | 评审执行路由受平台限制，不是代码或验收合同变化 | 评审流程存在偏差；P2 已用修复前失败回放和修复后真实 runtime 证据独立确认 | 不适用（无行为/spec 偏差） |
| 原 E10-A 静态 phase memory 固定 256 MiB | 替代 Reviewer 用真实 29,192/60,416 行 Worker 证明峰值分别约 468/572 MB，与 `MAX_RECORDS=250000` 的正常任务形状不匹配 | 保留静态值会让准入侵占 system reserve/OOM | 在 E10 范围增加共享投影与 dynamic profile，不改业务上限/输出 | 是（preflight/decisions/checklist 已反向同步，frozen Spec 业务合同未变） |
| 第一次动态估算采用 `448 MiB + 4096/row` | Reviewer 第三轮以合法250k短文本和60,416最大文本证明 row-only 分别低估约268 MB和1.16 GB；本机独立重放得到相同方向 | 输出文本长度和SheetJS writer/readback多份驻留未进入准入shape | 升级为共享shape projector和v2 envelope；不改MAX_RECORDS/DTO/业务输出，低pool大任务spawn前拒绝 | 是（preflight/decisions/checklist已反向同步；frozen Spec业务合同未变） |
| E10 result直接走通用finance-safe gate | 真实250k任务完成workbook后因合法digest中的数字串落 `PROTOCOL_PRIVACY_VIOLATION`；4行输入也可稳定复现17位数字串 | 合法成功被伪报transport-lost并遗留由client清理的staging | 增加action-specific exact-path delegate；不动全局隐私规则 | 是（preflight/decision/验收已同步；result schema未变） |
| 上轮 safepoint 方案把整个同步 `readBackAndValidate` 视为单一阶段 | 第二替代 Reviewer 在合法250k写盘后约4997ms触发shutdown，旧readback仍占用消息循环越过冻结5秒，最终 `cancel-timeout/transport-lost` | 已接受shutdown取消不能以cancelled收口；staging只能靠超时transport cleanup恢复 | 把实际落盘回读和证据/hash改为async有界批次；不改Supervisor/timeout/Writer/业务证据 | 是（preflight/decision/checklist已同步；frozen业务与平台合同未变） |
| 首版流式readback复用generic import `row-scanner`的字符串值/outer row语义 | 第二替代Reviewer证明numeric `00123`、boolean与outer row/cell ref错位可使新路径接受而旧raw oracle拒绝；generic scanner注释明确其导入语义为字符串且重复列最后覆盖 | 账户/日期/金额raw类型与实际坐标血缘失真，业务digest可能对错误记录自洽 | 保留ZIP流式与批次取消，但换成E10专用strict typed/coordinate projection；generic scanner及全部import消费者不改 | 是（preflight/decision/checklist同步；正常业务合同不变，结构异常更严格fail closed） |
| strict typed/coordinate projection未解析worksheet `dimension` | Reviewer把正常`A1:I2`改为`A1:I1`后，旧SheetJS因`!ref`截断忽略第2行业务记录并拒绝，而streaming仍扫描cell并接受；另probe证明旧库会宽松接受missing/duplicate/expanded/reversed/absolute | worksheet元数据与cell冲突可被新路径忽略，账户/日期/币种/行数审计不再等价 | 增加E10专用canonical dimension + actual cell/merge used-range校验；冻结header-only尾随空第2行作为唯一例外 | 是（preflight/checklist同步；正常业务输出不变，异常结构更严格fail closed） |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| 父链 | `7beb80e8151c77dbd659d4192178b07663674009` | 精确 restack 基线 |
| frozen spec/techdoc/sequence 取证 | E10-A/E10-B/R3.2.3 边界确认 | 防止范围扩张 |
| `node --test tests/unit/main-process/new-account-generation-e10-a.test.js` | 7/7 PASS | 日期/10年边界、必填、币种顺序、文件名、bounded DTO、allowlist/TOCTOU、staging alias/collision/symlink、真实 Worker golden、tamper、cancel/crash/late done、cleanup |
| focused platform/legacy set | 41/41 PASS | E10-A + Statement deferred legacy + shared runtime/toolbox lifecycle |
| `node scripts/integration/new-account-balance-statement.js` | 36/36 PASS | 既有 NewAccount/余额 writer readback golden |
| `npm run test:integration` | 51 scripts、2455/2455 PASS，291844 ms | 全平台 recovery/integration 与 NewAccount 36/36；自动 timing 文档改动已恢复，未引入范围外 churn |
| `npm run smoke` | PASS；含全部列示模块 smoke | 应用级回归 |
| `npm run test:unit` | 6302/6306 PASS；1 个 failure、3 skipped | 唯一失败为未改动 Windows NSIS dependency template `System::Store`；在精确父 worktree 同测试同样失败，确认为 baseline |
| `npm run lint -- --no-cache`、`node --check`、`git diff --check` | PASS | 静态语法/风格/补丁完整性 |
| 10 轮真实 Worker 性能探针 | 10×1815 rows，2481.58 ms；Main event loop 995 ticks；RSS max delta 193,806,336 bytes；transport leak=0、shutdown error=0 | 非阻塞、RSS 与连续 one-shot lifecycle |
| Reviewer P2 修复前真实 runtime 回放 | 等 `control.ready` 且 `runtime.inspect(jobId).state=running` 后立即 shutdown；失败为 actual `completed` vs expected `cancelled` | 确认是真实 Worker 消息循环被同步 XLSX 阻塞，而非 fake adapter 或 Reviewer 推断 |
| Reviewer P2 修复后 focused real-runtime regression | running 后shutdown 返回 `cancelled/job:error`，`execution.result=null`、`generated=null`、staging=0、final=0；已真实 completed 的 job 再 shutdown 仍保留 workbook 且 `cancelledJobs=[]` | cancel-wins、late `job:done` 不胜出、Main-only cleanup owner，以及 completed-before-shutdown 的正常终态保护 |
| P2 追加 focused/lifecycle | E10-A 8/8 PASS；running-shutdown 用例连续 10/10 轮 PASS；E10-A + Supervisor + adapters + Statement legacy + Toolbox lifecycle 123/123 PASS | 真实 Worker cancel 竞争稳定性、共享协议/终态不回归、legacy 旁路不变 |
| P2 追加 NewAccount/full integration | NewAccount 36/36 PASS；51 scripts、2455/2455 PASS，389282 ms；runner 自动 timing 文档变动已恢复 | 既有 NewAccount golden、Statement/publish/recovery 与全平台集成不回归 |
| P2 追加 full unit/smoke/static | unit 6304/6308 PASS，唯一 failure 仍为精确父链已确认的 shared `node_modules` NSIS `System::Store` 基线，3 skipped；smoke PASS；lint/node-check/diff-check PASS | 新用例纳入全量回归；无本次代码阻塞 |
| P2 追加 10 轮真实 Worker 性能探针 | 10×1815 rows，2537.30 ms；Main event loop 1016 ticks；RSS max delta 152,338,432 bytes；transport leak=0、shutdown error=0 | 新增 safepoint 后连续 one-shot 吞吐/RSS/event-loop/shutdown 保持在原证据范围 |
| dynamic resource estimator 确定性单测 | E10-A 12/12 PASS；最小/typical/29,192/60,416/250,000、safe integer/overflow、低 budget no-spawn、并发 system reserve、projected rows=actual records 全通过 | 准入口径、上下界、小任务不过度预留和并发不越预算 |
| resource-control/platform focused | policy/lease/budget/Governor/Supervisor/runtime/E10 133/133 PASS；E10 + adapters + Statement E09 A-D + Toolbox lifecycle 195/195 PASS | dynamic profile binding、spawn 前 admission、queue/cancel/shutdown、legacy 与其他 action 静态 phase 不回归 |
| NewAccount existing golden | `node scripts/integration/new-account-balance-statement.js` 36/36 PASS | 帐户/币种/日期/金额空值/文件名/工作簿等价 |
| 29,192 行真实 Worker RSS 探针 | actual 29,192；reservation 589,332,480 bytes；peak RSS delta 463,339,520 bytes；1297.21 ms；event-loop 207 ticks；leak/error=0 | 新 reservation 覆盖本机观测 envelope 125,992,960 bytes；方向性证据 |
| 60,416 行真实 Worker RSS 探针 | actual 60,416；reservation 717,225,984 bytes；peak RSS delta 569,638,912 bytes；2766.47 ms；event-loop 442 ticks；leak/error=0 | 新 reservation 覆盖本机观测 envelope 147,587,072 bytes；方向性证据 |
| dynamic estimator 追加 full unit | 6308/6312 PASS，1 failure、3 skipped；唯一 failure 仍为精确父链已确认的 shared `node_modules` Windows NSIS dependency template `System::Store` 基线 | 新增 4 个 estimator/admission 测试纳入全量 unit；无本次代码阻塞 |
| dynamic estimator 追加 full integration/smoke | 51 scripts、2455/2455 PASS，363834 ms；`npm run smoke` PASS；runner 自动 timing 文档变动已恢复 | NewAccount 36/36、Statement generation/recovery 与应用级路径均不回归，无范围外文档 churn |
| 最终 blindspot/reconciliation 复核 | 无新增代码阻塞；bounded DTO 在 estimator 前复验、共享投影与实际行数守恒、低预算 no-spawn、并发 lease 不越预算，cancel/crash/late message 的 Main-only staging cleanup 证据保持；金额空值/币种/账户/日期/文件名与 legacy golden 未改 | production 继续 `false/legacy/0`，不含 final target/copy/Publisher；资金字段与 Windows packaged/RSS 仍保留人工门禁 |
| `rules/important-variables.md` 软 review | 命中 Important-skeleton 的 Task/policy/Supervisor/Worker 跨层骨架与读写管线边界；新增 E10-only resource profile binding 和动态 PhaseLease，未改 `writeBalanceWorkbook`、`parseDateValue`、金额/币种/账户语义、Main/live source selector 或其他 action 的静态 resource | 133/133 resource focused、195/195 lifecycle、36/36 golden、2455/2455 full integration、smoke PASS 已覆盖关联功能；依任务禁令不运行 `check-vars/scan:vars/release-check` |
| 第三轮P2修复前250,000短文本真实重放 | model v1 reservation 1,493,762,048；baseline 112,033,792；peak 1,873,854,464；RSS delta 1,761,820,672；12.91 s；最终因合法digest落 `PROTOCOL_PRIVACY_VIOLATION` | 同一真实链路同时证明row-only低估268,058,624 bytes与digest误杀，不依赖Reviewer推断 |
| 第三轮P2修复前60,416最大合法CJK文本真实重放 | model v1 reservation 717,225,984；baseline 112,197,632；peak 1,993,605,120；RSS delta 1,881,407,488；5.11 s；completed | 文本shape使低估1,164,181,504 bytes，证明不能只按row count计费 |
| shape/digest focused | E10 15/15 PASS；resource/protocol/policy/Governor/Supervisor focused 181/181 PASS；background+Statement E09+Toolbox lifecycle 475/475 PASS | 0/1/typical/29,192/60,416/250,000、Unicode与XML控制字符最坏bytes、overflow、合法大任务no-spawn、并发reserve、5个digest path/近邻/错误值/schema invalid、真实digest completed、取消/cleanup与其他action静态资源 |
| v2后250,000短文本正式高预算runtime与最终shape回算 | projected cells 2,250,000；UTF-8/UTF-16/单元格编码重复文本4,500,000/9,000,000/4,500,000；最终reservation 2,123,588,640；baseline 109,461,504；peak 1,884,979,200；RSS delta 1,775,517,696；覆盖348,070,944；12.50 s；completed、leak/error=0 | 最终shape reservation覆盖本机真实RSS且成功结果不再被digest误杀；Worker路径未随单元格编码投影补强而改变，RSS仅为方向性证据 |
| v2后60,416最大合法CJK正式高预算runtime与最终shape回算 | projected cells 543,744；UTF-8/UTF-16/单元格编码重复文本151,160,832/101,740,544/151,160,832；最终reservation 2,570,446,848；baseline 108,855,296；peak 2,004,631,552；RSS delta 1,895,776,256；覆盖674,670,592；4.75 s；completed、leak/error=0 | 文本驻留与编码项覆盖最大合法字段样本；RSS仅为方向性证据，Windows仍人工门禁 |
| 第三轮P2最终 full unit | 6311/6315 PASS，1 failure、3 skipped；唯一 failure 仍为精确父链确认的 shared `node_modules` Windows NSIS dependency template `System::Store` 基线 | 最终 shape/digest/cancel 用例纳入全量 unit；无本次代码阻塞 |
| 第三轮P2最终 integration/smoke/static | 51 scripts、2455/2455 PASS，379602 ms；`npm run smoke` PASS；`npm run lint -- --no-cache`、changed `node --check`、`git diff --check` PASS；runner 自动 timing 文档已恢复 | NewAccount 36/36、statement pipeline 45/45、全平台 recovery/Toolbox/资金路径均不回归，工作树无范围外 timing churn |
| 第三轮最终 blindspot/reconciliation 复核 | verified DTO → shared shape → Governor admission → one-shot Worker → write/readback → exact digest delegate → result schema → Main-only cleanup 全链复核无新增代码阻塞；rows/cells/UTF-8/UTF-16/XML编码安全整数守恒，低budget no-spawn、并发reserve、cancel/crash/late message保持 | 金额空值与期末余额0、日期/账户/币种/行数/文件名/模板血缘未改；production仍`false/legacy/0`，不含final target/copy/Publisher；资金字段与Windows packaged/RSS保留人工门禁 |
| 第三轮 `rules/important-variables.md` 软 review | 命中 Important-skeleton 的 Task policy/Worker result validator 和 risk-sensitive 的输出资源/协议边界；仅调整 E10 action 的 dynamic profile输入shape与局部digest delegate，未改全局 finance-safe gate、Supervisor/Governor算法、writer/date/金额/币种/账户语义、其他 action 静态资源或 live selector | E10 15/15、resource/protocol 181/181、full unit/integration/smoke/static覆盖关联功能；依任务禁令未运行 `check-vars/scan:vars/release-check` |
| 第二替代Reviewer P2修复前分段计时 | 250k短文本94MB：`XLSX.readFile 3197ms`、`sheet_to_json 566ms`、normalize 5ms、actual evidence 1758ms、expected evidence 1986ms，总readback约7.5s；60,416最大文本172MB：readFile1267ms、sheet123ms、normalize4ms、actual/expected evidence856/812ms | 证明250k失败来自多个同步阶段连续占用消息循环，且单readFile跨平台不能假定低于5秒；旧方案需结构性替换 |
| `node scripts/perf/new-account-e10-a-readback-cancellation.js` | PASS；真实250k在 workbook-opened 两轮、row-batch、row-scan-complete（旧readFile后等价边界）、evidence-batch、job:done前六个场景shutdown均 `cancelled/job:error`，取消11–16ms，result/generated=null、Main cleanup=1、staging/final=0、resource/transport leak=0 | 冻结5秒内 cooperative cancel、cancel-wins、唯一cleanup owner和多轮稳定性 |
| 流式readback 250k/60,416 golden/perf/RSS探针 | 最终复跑：250k Worker 5268ms、旧同步readback对照4168ms、legacy canonical oracle1454ms、peak RSS 1,457,651,712、event-loop 889 ticks；60,416最大文本 Worker2867ms、同步对照1825ms、oracle675ms、peak RSS1,254,211,584、ticks478；两者四digest精确相等 | 实际落盘Sheet/header/rows与旧SheetJS回读及旧canonical数组语义等价；新Worker RSS低于现有shape reservation，数字仅作macOS方向性证据 |
| readback focused unit | E10-A 17/17 PASS；新增 incremental-vs-legacy canonical、真实workbook-open/row/row-scan-complete/evidence/job:done前精确shutdown、cleanup=1，既有golden/digest/resource/cancel/crash/late done全保留 | 核心合同与阶段竞态的确定性回归 |
| readback focused platform/lifecycle | E10 + adapter/admission/error-codec/policy/protocol/Governor/lease/Supervisor + Statement E09 A-C + Toolbox 共280/280 PASS | cancel terminal、5秒timeout、resource守恒、其他action协议/静态资源、legacy旁路不回归 |
| readback full unit | 6313/6317 PASS，1 failure、3 skipped；唯一failure仍为精确父链既有Windows NSIS dependency template `System::Store` 基线 | 新增2个unit纳入全量并行回归，无本次代码失败 |
| readback full integration/NewAccount golden/smoke | 51 scripts、2455/2455 PASS，374636ms；独立NewAccount 36/36 PASS；`npm run smoke` PASS；runner自动timing文档已恢复 | actual NewAccount writer、Statement/Toolbox大文件流式解析、全平台recovery/资金路径与应用冒烟不回归 |
| readback static | `npm run lint -- --no-cache`、全部changed `node --check`、`git diff --check` PASS | 生产源码、测试/探针脚本与补丁完整性 |
| readback `rules/important-variables.md` 软review | 命中 Important-skeleton 的Worker/Task终态与读写管线边界、risk-sensitive 的staging输出/hash/业务证据；复用而未修改 `writeBalanceWorkbook`、`row-scanner`、`parseDateValue`、`parseNumericValue`，未改Supervisor timeout/全局协议/资源模型/live selector | focused280/280、golden36/36、integration2455/2455、smoke与真实250k/60,416 probe覆盖关联功能；依禁令未运行`check-vars/scan:vars/release-check` |
| strict readback pre-implementation probe | SheetJS `cellDates:false/raw:true`：无type/`n` leading-zero转number，`b`转boolean，`d`转serial，`e`在JSON row为空，三类Reviewer反例均揭示generic scanner与旧oracle差异；scanner不暴露完整cell ref且截断流可resolve | 排除“只读cellTypes/所有业务cell强制文本”两条错误方案；需要E10专用strict XML projection与独立oracle差分矩阵 |
| strict readback oracle/focused | 三个Reviewer反例修复前0/3、修复后独立矩阵8/8 PASS；E10 generation 17/17、background/Statement/Toolbox focused 476/476 PASS；合法typed值、rich shared/inline `rPh`、XML实体、多字母列、blank/missing/sparse、formula cached均与旧raw oracledeep-equal，非法type/数值/shared/XML与row/cell坐标fail closed | 账户/日期/币种/金额raw值和物理坐标进入同一canonical证据前已验证；generic scanner及其消费者未修改 |
| strict readback 250k/60,416真实边界 | 最终复跑250k：Worker11,607ms、旧同步readback4,146ms、legacy oracle1,446ms、peak RSS1,445,167,104、ticks1,960、reservation2,123,588,640；60,416最大文本：Worker5,045ms、旧同步1,873ms、oracle676ms、peak RSS1,255,653,376、ticks845、reservation2,570,446,848；两者四digest精确不变 | strict类型/坐标校验增加CPU但仍保持有界event-loop与shape reservation覆盖；macOS RSS/耗时只作方向性证据，Windows仍人工门禁 |
| strict readback cancellation | 最终真实250k在workbook-opened两轮、row-batch、row-scan-complete、evidence-batch、job:done前六阶段均11–15ms内cancelled；result/generated=null、Main cleanup=1、staging/final=0、resource/transport leak=0 | 冻结5秒cancel-wins与唯一cleanup owner未因strict parser回归；已completed后shutdown保护由既有用例继续覆盖 |
| strict readback full regression | 最终full unit重跑6321/6325（唯一failure仍为精确父链Windows NSIS dependency `System::Store`基线，3 skipped）；前一轮archive symlink并行波动单独重放及全量重跑均PASS；integration 51 scripts/2455/2455 PASS，265095ms；NewAccount36/36、smoke、lint PASS；runner timing文档已恢复 | 新parser纳入全量平台、golden与应用级回归，无本次代码失败或范围外timing churn |
| strict readback `rules/important-variables.md` 软review | 命中 Important-skeleton 的Worker读写管线边界和risk-sensitive的账号/日期/币种/金额/行数/坐标/digest/staging血缘；仅替换E10 actual readback projection，未改generic scanner、Writer、Supervisor/Governor、Protocol/resource/live selector | oracle8/8、focused476/476、golden36/36、full unit/integration/smoke与真实边界/cancel覆盖关联功能；依任务禁令未运行`check-vars/scan:vars/release-check` |
| worksheet dimension 红→绿 oracle | 修复前 strict suite 10/12 PASS，Reviewer `A1:I1`截断与missing dimension均被接受；修复后12/12 PASS，旧raw与strict对截断均拒绝，strict另拒绝missing/ref缺失/duplicate/expanded/shifted/reversed/out-of-range/absolute/multi-area/malformed | 证明P2由dimension未消费导致；异常结构更严格fail closed，正常empty/header-only/1row、styled blank、merge、formula cached与multi-letter投影保持可解释 |
| dimension focused/golden | E10 generation 17/17、background/Statement/Toolbox focused 480/480、独立NewAccount integration 36/36 PASS | typed/coordinate、资源准入、5digest、取消/cleanup、legacy writer/date/account/currency/amount/file name均未回归 |
| dimension 250k/60,416真实边界 | 六个250k取消窗口均12–15ms内`cancelled`且result/generated=null、Main cleanup=1、staging/final=0、无resource/transport leak；正常250k Worker12,995ms、peak RSS1,451,917,312、ticks2,197；60,416长文本Worker5,869ms、peak RSS1,387,429,888、ticks987；两者四digest与旧oracle精确一致 | dimension扫描仍保持冻结5秒内协作取消和shape reservation覆盖；耗时/RSS仅作macOS方向性证据，Windows packaged仍人工门禁 |
| dimension full regression/static | full unit 6325/6329 PASS，唯一failure仍为父链既有Windows NSIS dependency `System::Store`，3 skipped；integration 51 scripts/2455/2455 PASS、350171ms；smoke、lint、changed node-check、diff-check PASS；runner timing文档已恢复 | 新校验纳入全量XLSX/平台/恢复/资金路径且无范围外churn |
| dimension最终 blindspot/reconciliation 与重要变量软review | verified DTO→shape admission→one-shot write→strict typed/coordinate/dimension→四digest→Main technical validation/cleanup全链无新增代码阻塞；命中Important-skeleton Worker读写边界及risk-sensitive账户/日期/币种/余额0/行列/dimension/digest/staging血缘；未改generic scanner、Writer、Supervisor/Governor、Protocol/resource/live selector | production保持`false/legacy/0`，无final target/copy/Publisher；自动化不能替代NewAccount资金字段与Windows packaged人工复核；依禁令未运行`check-vars/scan:vars/release-check` |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged Worker + assets allowlist 真实路径与动态内存 envelope | PROBE | R3.2.3 在 setup/portable 人工与 canary 验证 29k/60k/250k 代表形状 | production 必须继续 false；Windows RSS 超过 envelope 时只能向上调整余量 |
| NewAccount 日期/账户/币种/输出记录人工复核 | BLOCK（上线） | 财务/业务 owner 按 frozen checklist 复核 | 不阻断 E10-A dormant merge，阻断 production enable |
| app 进程级 crash 后持久 task-staging 扫描与 Publisher journal | PROBE | E10-B 绑定 task staging/Publisher，R3.2.3 做 restart recovery | E10-A 无发布路径且 production=false；阻断 production enable |
