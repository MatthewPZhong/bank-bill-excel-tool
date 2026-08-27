# E07-C Duplicate Paired Parser Implementation Notes

## Baseline

- Goal/spec：v3.2.2 Spec §1-§3、§6、§9-§13；TechDoc §2、§5-§6、§10-§12；implementation sequence 的 E07-C optional paired parser。
- Exact base / parent E07-B：`1b5b77ab5829db234ae288cc24ca0f6de7bdeb7b`（三审 P0-P3=0）。
- Contract SHA-256：Spec `0cdf28e5310733355fb51d92818dde8fd837ee06b521a4694c0c9cc43300d47f`；TechDoc `9fd15a46b482e6801616554978dff67a02676b437b9759e18d15fce29dcff209`；sequence `a3aee173d0597fa0a84af87034f571992dbe89ca75401b73aabf0cd49cf5d4fd`。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：Service reservation、CompoundLease actual count、Bank/Document独立spool、两侧validate后单一Service mutation/adopt、single完整post-image parity、failure/cancel/crash cleanup、RSS/perf证据完成；production/live保持legacy/single/false。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 复用 Supervisor 已有 service-job reservation 与 CompoundLease，不新增公共协议或资源类型。 | `openJob`先占唯一Duplicate Service command，再申请compound admission；专属busy测试证明reservation期间import/run/export均立即`SERVICE_BUSY`。 | Parser先跑再reserve；Worker自行猜未计费child。 | 时序固定为reserve→lease→parse；资源数只认Governor实际批准值。 |
| paired job注册零个business unit，并使用module-private ready/terminal barrier。 | `duplicate:import`是`worker-durable`，任何registered unit的`unit:done`必须绑定critical ACK/receipt；Parser spool本身不是business commit。 | 把Parser伪装成deferred unit并伪造receipt/critical；扩Platform协议。 | 不触碰E07-B receipt协议；Service command仍由原parent job唯一提交。 |
| Main coordinator只调度descriptor与bounded terminal/result；Parser业务行只在各自task-private NDJSON spool和Service Worker中出现。 | Main不得保留第二份完整业务state；静态依赖测试证明dispatcher不加载Bank/Document reader，Parser不加载DB/matching/MPT/candidate。 | Main读取或合并业务行；把两侧rows放Job result。 | Main只见role/fileName/count/RSS/elapsed与路径descriptor，不解析业务行。 |
| 两个Parser直接复用既有Bank reader、Document streaming reader、BizId/model helper，并各写独立slot spool。 | 禁止复制normalizer/parser业务逻辑；single/paired side post-image逐字段一致。 | 在新Worker重写XLSX/字段转换；构建未来N-role框架。 | 仅固定两个slot与唯一Bank/Document角色，不泛化未来role。 |
| manifest-last不等于Parser成功；coordinator只在terminal message且Worker clean exit 0后发布exact success outcome，任一failure先记录并abort，全部Parser exit后才发布脱敏failure outcome。 | manifest发布后transport crash存在真实窗口；正常failure marker也会被Service立即解释为parent terminal。两类100k Bank真实Worker测试证明marker/teardown都不能越过`allSettled`。 | Service看到manifest即采用；Parser首错即发布marker；用普通`control.cancel()`绕过shutdown-only policy。 | outcome仍绑定job/op/producerTaskRunId/slot/unit且只含bounded causeCode；barrier前Service持续等待并保留job/CompoundLease，两侧success后才继续采用。 |
| terminal outcome文件系统不可用时，coordinator在Parser terminal barrier后以exact control触发Supervisor权威`transport-lost + forceTransport`终态。 | failure marker本身可能因ENOSPC/EACCES/readonly同步失败；普通cancel受shutdown-only policy拒绝，全runtime shutdown又会阻断后续命令。`runDuplicateParserWorker()`只在真实Worker `exit`后settle，故`Promise.allSettled(parserTasks)`是已有权威barrier。 | 吞掉marker错误后无界等execution timeout；marker或teardown提前释放parent lease；把普通user cancel伪装为基础设施失败；关闭全runtime；向control/runtime枚举API增加通用权限。 | 全部Parser exit后先尝试写normal marker；仅写入失败时才exact-control终态。正常failure保留可复用Service BaseLease但释放job CompoundLease，transport failure关闭当前generation。 |
| Service先完整校验两份manifest/source/spool/role/count/ordinal，再查exact receipt；无receipt才进入原side事务。 | paired evidence必须由两份源SHA形成，解析前无法证明exact replay；E07-B禁止的是cleanup/matching/side mutation重跑。 | 在Parser前凭operationKey猜replay；双侧任一成功即部分采用。 | exact replay仍在任何side mutation前，只恢复bounded session；bundle/rows/receipt计数不增。 |
| Service采用顺序固定Bank→Document，并在COMMIT前按首次manifest digest与rows/source hash再次完整复验。 | Parser完成时序不得影响业务顺序；仅重读“当前新manifest”会留下validate/commit TOCTOU。 | 按完成顺序adopt；只校验count；COMMIT前接受替换后的manifest。 | 同计数内容变化、manifest变化、source变化、role/identity冲突均fail closed且事务回滚。 |
| task-private spool由Main coordinator在parent terminal barrier后清理，只删除已知文件并只`rmdir`空目录。 | Parser不写DB，E07-B side receipt/result/Main mirror才是durable恢复权威。 | recursive删除宽目录；把spool纳入E07-B recovery或E07-C compensation。 | failure、transport crash、shutdown、success与replay均收口双spool；不扩E07-B/E08。 |
| native Governor降为actual=1时顺序运行两个Parser；只有显式non-production资源harness实际=2。 | E00全局IO预算不能为本action的并发目标被放大。 | 修改policy预算或production worker count以强行并发。 | capability可测；native resource gate仍未通过，production/live继续legacy/single/false。 |
| optional wrapper仅在双文件且显式perf/RSS gate满足时进入paired；`production:true`在runtime start前拒绝。 | 冻结阈值为改善≥15%且RSS不超预算；单文件/门禁失败要保留single入口。 | benchmark自动改production flag；paired入口暗接live IPC。 | `src/main.js`、policy production字段、公开IPC和legacy handler均未改。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| task-private spool不是durable business/recovery evidence。 | Parser零DB mutation；startup Inspector只认E07-B receipt/result/Main mirror。 | 若未来把spool列为恢复权威，当前terminal后cleanup会误删。 | 本PR未改startup recovery/schema；未来合同改变前必须迁移ownership。 |
| taskStagingDir由调用方按task隔离。 | descriptor与cleanup只在该root下建立hash(jobId)/slot目录，且cleanup不递归删除未知内容。 | root复用只会留下非空目录，不会越界删除；可能影响磁盘可用性。 | 路径containment/symlink gate；production接线前由Main task staging owner提供独立root。 |
| 本地darwin parser-only结果只能证明本地capability。 | packaged Windows、native production admission与真实资金样本均未执行。 | 把本地40.18%结果直接用于production会越过冻结门禁。 | production固定false；由R3.2.2 release owner补Windows连续十轮/RSS和人工复核。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 预检初稿拟把Parser建成deferred units。 | 使用零business unit + module-private filesystem terminal barrier。 | worker-durable unit必须形成critical ACK/receipt，Parser spool不能冒充commit。 | 不扩Platform Protocol，不污染E07-B Inspector；仍保留parent job的完整reservation/lease。 | 不需要；纠正方案以符合冻结receipt合同。 |
| 预检初稿写成exact replay先于Parser准备、Parser/spool=0。 | paired先解析并完整验证两份source evidence，随后在任何side mutation前receipt-first。 | receipt的`inputEvidenceHash`由两份源SHA组成；未取证前不能证明exact replay。 | replay有临时Parser I/O但side bundle/rows/receipt/matching均不重跑；spool仍terminal后清理。 | 不需要；符合E07-B“mutation前replay”不变量。 |
| 初版failure路径尝试普通cancel parent。 | failure outcome由Service在既有reservation内权威读取并自行terminal；只有app shutdown走shutdown-only cancel。 | policy明确拒绝普通cancel，错误使用会等待execution timeout并制造伪语义。 | failure立即收口且不改变cancel policy。 | 不需要；纠正方案回到冻结shutdown-only合同。 |
| 初版Service把ready manifest当Parser完成。 | clean Worker exit后才发布success outcome，两侧exact success是采用前置。 | manifest写完到Worker transport terminal之间存在真实crash窗口。 | manifest后crash必然零commit，不再依赖竞态时序。 | 不需要；补足冻结crash/partial-failure要求。 |
| 初版默认terminal outcome总能写入task-private filesystem。 | outcome发布失败时保留原Parser错误与marker错误关系，并由exact-control coordinator capability强制transport teardown。 | Reviewer在无`executionTimeoutMs` runtime用EACCES/readonly同类故障复现parent永久pending、reservation/lease不释放。 | 不改变shutdown-only取消语义或Platform公开协议；只关闭当前失败Service generation，后续runtime继续可用。 | 不需要；这是E07-C failure barrier的可达故障修复。 |
| P1修复在outcome写失败时同步触发exact-control teardown。 | 先abort并记录错误，等待全部`parserTasks` settle后才触发teardown。 | 真实tiny Document + 100k Bank证明同步teardown会在sibling exit前释放parent job/CompoundLease，形成未记账活Worker窗口。 | barrier期间后续Duplicate命令继续`SERVICE_BUSY`；真实Worker exit后才释放资源、清理spool，不新增公开接口。 | 不需要；收紧E07-C既有Parser资源所有权。 |
| 第二轮只把outcome写失败后的exact-control teardown延后到`allSettled`。 | Parser catch只记录首错/spool identity并abort；`allSettled`后才发布正常failure marker，若写失败再exact-control。 | Service以10ms轮询读取正常marker；Reviewer用坏表头Document + 100k Bank证明marker提前发布仍会在sibling exit前释放job/CompoundLease。 | 正常marker与EACCES共用同一Worker terminal barrier；marker证据仍bounded，ordinary Service复用/BaseLease合同不变。 | 不需要；修复同一E07-C资源所有权不变量。 |

冻结产品合同无行为偏差；以上均为实施探针后对初始方案的收紧。

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| E07-C专属：`NODE_PATH=/Users/pzhong/Desktop/Project/bank-bill-excel-tool/node_modules node --test tests/unit/main-process/duplicate-inbound-match/paired-parser-e07-c.test.js` | 16/16 PASS | 两slot独立spool、exact manifest/outcome identity、source/spool/manifest TOCTOU、clean-exit barrier、乱序固定Bank→Document、single完整post-image/receipt parity、exact replay零新增、busy三命令、role conflict、failure/crash/shutdown、cleanup、native actual1、gate与依赖边界；P1双EACCES、100k Bank outcome-EACCES barrier与坏表头Document + 100k Bank normal-marker barrier均通过。两种barrier前job/Compound dependency保持、冲突命令busy，exit后零mutation/adopt、cleanup与后续命令可用。 |
| Duplicate affected：`NODE_PATH=/Users/pzhong/Desktop/Project/bank-bill-excel-tool/node_modules node --test tests/unit/main-process/duplicate-inbound-match/*.test.js` | 114/114 PASS | reader/writer/matching/Service/managed Worker/startup recovery、E07-B receipt/replay/partial recovery与E07-C组合无回归。 |
| side authority：store + result digest定向unit | 9/9 PASS | import事务、receipt-owned边界、完整result digest未回归；Main CAS/Inspector同时由Duplicate affected覆盖。 |
| Platform adjacent：`NODE_PATH=... node --test tests/unit/main-process/background-execution/*.test.js` | 356/356 PASS | exact-control capability未知/已终态安全返回false且不改变control/runtime枚举API；topology/CompoundLease、downgrade-to-single、shutdown-only、ServiceHost generation、worker-durable receipt gate与资源收口无回归。 |
| Duplicate integration：`node scripts/integration/duplicate-inbound-match-end-to-end.js` | 31/31 PASS | 真实Bank/Document import、匹配、side/Main、导出与行数守恒无回归。 |
| 5轮benchmark：`DUPLICATE_PAIRED_BENCH_ROWS=3000 DUPLICATE_PAIRED_BENCH_ITERATIONS=5 node scripts/benchmark-duplicate-paired-parser.js` | 本地gate PASS；single median 531.251ms，paired 317.776ms，改善40.18%；paired peak RSS 507150336 < budget 838860800 bytes | 真实OS Parser Workers，交替顺序与warmup；详见[benchmark evidence](./benchmark-evidence.md)。只证明darwin parser-only capability，不解除native/Windows/production/人工门禁。 |
| Static | ESLint `src/` PASS；新增test/benchmark ESLint PASS；全部changed/new JS `node --check` PASS | 语法、lint与边界代码静态质量。 |
| 明确未执行 | `release-check`、`check-vars`、`scan:vars` | 按冻结任务禁止；不把跳过项宣称PASS。 |

## Frozen Done-when Mapping

| Done-when | 实现入口 | 自动证据 |
| --- | --- | --- |
| reserve command→CompoundLease→Parser | `paired-parser-dispatch.js`、`topology.js`、`runtime.js` | busy import/run/export、native1/isolated2、platform lease tests。 |
| Bank/Document独立spool；Parser无DB/MPT/candidate | `spool-contract.js`、`spool-filesystem.js`、`spool-writer.js`、`parser-worker-entry.js` | 独立slot/path、bounded manifest、dependency scan。 |
| 两侧完整validate后才Service critical/adopt | `parser-outcome.js`、`spool-reader.js`、`worker-host.js`、`managed-service.js` | manifest-after-crash、single-side failure、role conflict均零side/Main/adopt；普通failure与P1合成sibling在1秒内收口，真实Worker则严格等待exit barrier。 |
| 固定Bank→Document与single等价 | `service.js#importPreparedSpools`、抽取的`input-classifier.js`/`import-model.js` | reverse completion仍固定role order；imports/Bank rows/Document rows/receipt evidence逐字段post-image parity。 |
| E07-B committed replay不重跑 | `service.js#importPreparedSpools` receipt-first branch | same owner/op/evidence replay后imports/bank/document/receipts计数完全不增。 |
| source/manifest/spool TOCTOU与行数守恒 | `spool-reader.js` + store `beforeCommit` | 同count内容改变、manifest替换、source改变、identity/role冲突全部拒绝。 |
| cancel/crash/outcome filesystem/cleanup | `paired-parser-dispatch.js` Parser/parent双terminal barrier + Supervisor exact-control transport failure + known-file cleanup | normal marker、success/failure outcome EACCES、两类100k真实Worker、manifest transport crash、app shutdown均先全部Parser terminal、再发布marker/teardown并parent terminal，最后双spool cleanup；barrier期间仍busy，之后job Compound/dependency归零且下一命令非`SERVICE_BUSY`。 |
| single/low-resource/perf/RSS/production gate | optional wrapper、Governor topology、benchmark script/evidence | native actual1；<15%或RSS超限gate=false；`production:true`拒绝；production policy与live Main未改。 |

## Reconciliation Blindspot Pass

### [Critical] identity、顺序、幂等与side/Main authority

- 场景：Parser乱序、operation replay或artifact替换导致不同Bank/Document被采用，或重复写side receipt。
- 事实：manifest与terminal均绑定job/op/producerTaskRunId/slot/unit；source SHA/snapshot、artifact SHA/count/role完整校验；Service固定Bank→Document，receipt-first于任何side mutation。
- 证据：reverse completion、identity tamper、TOCTOU、single post-image parity与replay计数测试；E07-B recovery/unit和integration均通过。
- 处置：自动化PASS；真实脱敏BizId/MPT/document lineage仍为人工资金红线。

### [Critical] 金额、币种、candidate消费与行/状态守恒

- 本PR不改matching engine、金额十进制规范化、Currency/Channel分组、MPT/document candidate选择、result digest或Excel writer。
- Parser仅复用既有reader/model生成与single相同的Bank raw与Document row；Service仍调用同一store事务。Bank BizId/raw/FundType关系、ordinal唯一递增、Document matchable/empty完整守恒均在消费端复验。
- 证据：全部Duplicate 114/114、backend store/digest 9/9、E2E 31/31与paired/single逐字段side post-image parity。
- 处置：自动化PASS；金额币种、候选复用、三方血缘和真实Excel/WPS仍需人工复核，不能由benchmark解除。

### [Important] 部分失败、取消、crash与隐私

- Parser在两侧success前不触碰DB/adopt；manifest不是成功证据，clean exit后的terminal outcome才是。failure outcome只含bounded causeCode，不写路径/行；Main result也拒绝额外字段。
- cleanup只删除task-private known files并在parent terminal后执行；不调用startup recovery、不复制matching、不把spool当durable证据。
- normal failure marker与outcome write失败都不再越过Parser terminal barrier；coordinator只在全部真实Parser Worker exit后发布bounded marker，写失败才凭exact control触发当前transport teardown，不开放通用control/runtime方法，也不改变ordinary cancel policy。
- 证据：failure、role conflict、manifest-after-crash、shutdown、failure/success outcome EACCES、outcome-EACCES与正常marker两类100k Bank真实Worker barrier、敏感manifest/outcome scan；barrier前marker为空且job/Compound dependency保持、下一命令busy，barrier后side/Main/adopt和spool均为零/空、下一命令不再busy。
- 处置：本地自动化PASS；Windows文件锁/Worker terminate/RSS连续十轮为production PROBE。

## Important Variables Review

- ⚠️ `DuplicateInboundMatchService` / per-month Duplicate side DB（Risk-sensitive）：仅新增prepared spool import入口并抽取既有classifier/model；未改金额、币种、七元组、MPT/document candidate、result digest、mirror schema或writer。paired/single逐字段side post-image、全部Duplicate unit与E2E已通过。
- ⚠️ background runtime topology/CompoundLease：只为`duplicate:import`绑定module-private topology planner；policy fixture、Governor预算、production字段、其它action topology均未改。background-execution 356/356与Duplicate policy unit通过。
- ⚠️ background Supervisor terminal/resource lifecycle：新增module-internal exact-control WeakMap capability，只复用既有`adapter-error/transport-lost/forceTransport`收口；Supervisor/control/runtime enumerable API、cancel policy、protocol/schema均未改。background-execution 356/356通过。
- 未修改`freezeWorkerBatchContext`、公开协议/schema、`src/main.js` live IPC、package/version或重要变量清单本身。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged Worker、文件锁、shutdown/连续十轮与真实RSS | BLOCK production | R3.2.2 release owner | 不阻断production-false capability PR；阻断paired/live enable。 |
| native E00/production ResourceGovernor预算实际只批准1 Parser | BLOCK production | Platform/Release owner冻结预算并重跑 | 不得以隔离harness扩大全局预算；production继续single。 |
| BizId/MPT/document lineage、金额币种、候选消费与行数守恒真实样本 | REVIEW / 资金红线 | 业务/资金负责人逐笔复核 | 自动测试与本地benchmark不能解除人工门禁。 |
| task staging ownership与Windows残留清理 | PROBE production | Main task staging owner + release fault matrix | 当前cleanup安全收缩为known files；live接线前需验证任务目录唯一owner。 |
