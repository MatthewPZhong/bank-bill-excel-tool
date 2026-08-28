# E09-P0 Statement Probes Implementation Notes

## Baseline

- Goal/spec：v3.2.3 Spec §3～§13；TechDoc §1～§12；E09-P0 Statement state footprint/token/current-state golden。
- Exact base：`7577d5ae2f627619ba3f22597505c587be9867b6`。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：DTO/resource contract、state/token footprint、固定规模 probe 与 legacy business golden 均有可复现证据；live/production 保持 legacy/false；定向测试、静态检查和自审通过。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| P0 只提供冻结 contract/probe library，不注册 Service/entry/runtime | PR 序列明确 E09-A 才实现 Service import/session，E09-B 才实现 token store/waiting-user | 在 P0 顺手创建 Worker/Service；把本地 Map 当正式 token store | legacy live 行为零变化；后续必须复用本合同 |
| canonical policy 的资源/token 数值只读镜像为冻结常量并做 fixture parity | Platform Contract 与 policy fixture 已是机器权威 | 根据小样本自行缩小/放大预算；允许 Renderer 配置 | probe 只报告样本占用，不解除真实样本/Windows/人工 gate |
| public DTO 与 private context 使用独立 validator/constructor；BigAccount prompt不再携带legacy `contextId` | `buildBigAccountSelectionRequiredResult`的展示shape无contextId；旧preview只因Main全局pending lookup追加它。冻结合同以外层exact-eight handle的`tokenId`作为唯一opaque handle | 同时返回tokenId与第二个contextId；让Renderer回传rows；把private object展开成status | E09-B resource adopt-ack后只公开bounded prompt + token handle，不提前实现store |
| pending private context 与 persistent state 独立估算、独立对 256 MiB ceiling 判定 | canonical policy 明确两类资源，不能以共享总额掩盖任一超限 | 把两类 graph 合成一个预算；用 JSON byte length 代替 retained graph | E09-A/B 申请 reservation 时可分别 fail closed |
| estimator 固定 50% headroom 并按 4 KiB 向上取整 | 修复后50k probe的state+token reservation为44,294,144 B，高于本次retained heap delta 13,615,608 B；数组metadata/shared/cycle已覆盖 | 把单次RSS当精确资源值；只算enumerable JSON | P0提供可复现保守输入，但仍不宣称真实峰值上界 |
| public interaction 采用240 KiB inner ceiling + 16 KiB wire reserve，status独立保持1 MiB | 最大合法purpose DTO经真实最大route/context Protocol envelope仍低于256 KiB，+1 byte在封装前拒绝 | 让prompt共用1 MiB status ceiling；inner直接占满256 KiB | E09-B不得以status ceiling放宽Renderer payload，也不得先adopt后发现wire不可发送 |
| 完整 `merchantId` 只由 Statement action-specific result validator 的 path-aware delegate 放行 | legacy Renderer 的大账号选择与 manual-balance prompt 明确展示完整账号；Platform privacy 为 exact domain validator 预留 allow delegate | mask/opaque choice（会改UI/选择合同并越到E09-B）；修改全局privacy regex | 仅canonical判定为`full-account`、exact done wrapper path、exact parent shape可穿越；纯数字/空格/连字符兼容，scope/message/fileName/raw/private仍拒绝 |
| P0 result validator只冻结 `interaction-required + interaction` exact result | TechDoc明确waiting-user由`job:done`返回interaction-required；artifact success manifest属E09-C | 在P0预造artifact manifest/Publisher结果 | production仍false；E09-C必须在启用前扩展同一validator，而不是旁路本privacy binding |
| 只有`job:done`能形成Statement interaction-required终态 | TechDoc §4唯一冻结done interaction；Platform progress没有action result validator，当前也无Statement Worker producer | 在叶子delegate前另造完整progress根validator；保留progress叶子例外；新增Protocol/Supervisor production deny | 含`full-account`的interaction-shaped progress在`onProgress`前被privacy拒绝；generic-safe M001/scope progress仍可观测，但不形成waiting-user/settlement |
| status pending interactions使用冻结上限专用exact-Array reader | canonical maxOutstanding=1，原直接`.map()`会在count/limit前读取调用方元素 | 通用hostile graph walker；先map再校验；放宽status shape | Proxy零trap拒绝；count、own data length、上限和一致性先于最多一个own data index读取 |
| `lastPendingBalanceSeedConfirmation`作为第六个legacy global独立投影 | 真实Main global持有完整plan/records/import/session与`assertFresh` callback；后续Service可用record + records digest + session/batch ref重新取证，不应跨线程复制重对象 | 把legacy confirmation整体送Worker；增加第四种token purpose；在P0实现token store | overwrite继续复用`manual-balance`单token；private context仅保留bounded record/digest/ref/count，public continuation用`tokenId`替代legacy `contextId` |
| overwrite token在confirm/cancel/stale/replacement均必须release | legacy confirm在execute清空、replacement覆盖旧global；cancel无第二IPC、stale当前仍保留旧global，不能照搬成future token泄漏 | 把legacy callback/global生命周期直接当正式token实现；在P0接Renderer取消hook | P0只冻结四类release characterization；E09-B负责single-use、stale与cancel transport/runtime实现 |
| public source display统一使用首次出现顺序alias | basename仍可能包含完整账号、客户目录命名或任意长业务文本；finance-safe不得为fileName/message开例外 | mask merchantId；放宽全局privacy；把raw filename直接放wire | `rows/rowsWithEmptyBlocks/failedFileNames`保持原数组与选择顺序但只输出`来源文件 N`；raw basename留在private context；result validator要求输入与规范化结果canonical exact-equal，privacy-safe raw名字也不能旁路 |
| mismatch message由固定摘要、总数和最多8个alias preview构造 | legacy message可拼接1024个raw filename，旧1024字符字段上限使合法列表随机失败 | 提高message到无界；截断raw filename；放宽240 KiB ceiling | 1024个合法failed aliases仍可构造并受整体240 KiB UTF-8 ceiling；message本身不含raw filename |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| deterministic object-graph estimator + headroom 足以作为 P0 reservation contract | E06 使用相同原则；Statement graph 主要是 plain arrays/objects/Map | 与真实 V8 RSS 比例偏低可能低估 | child-process baseline 校准；偏低则提高 headroom/显式类型成本，不放宽预算 |
| 现有 production core 可在 Node tests 中直接执行足够多的资金 golden | file-service/session/balance modules不依赖 Electron；main-local orchestration可用静态 seam补充 | 某些 handler-only ordering 无法动态驱动 | 只把动态 core结果称为 executable golden；handler-only部分明确标 seam，不伪称端到端 |
| `expiresAt` 使用正安全整数的 epoch milliseconds | canonical TTL 为毫秒且现有平台时间点均以 epoch ms 表示；TechDoc 未另给字符串格式 | E09-B 若定义不同 wire format 会破坏 exact-eight handle | E09-B 必须沿用本 DTO；若权威合同修订，先反向同步 Spec/TechDoc再改 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| footprint曾接受binary view并尝试按retained backing计费 | production-shape证实无binary retained state，合同改为Buffer/TypedArray/DataView/ArrayBuffer O(1) fail closed；同时收紧Map/Set exact shape与override上限 | Reviewer P1要求避免shared backing重复；负责人复核指出枚举TypedArray索引会在预算前造成DoS，并明确允许无业务需要时拒绝binary | P0 estimator不再为不可达binary付出O(n)扫描；不接runtime | 不需要，符合canonical硬上限与Reviewer收敛意见 |
| public prompt只做通用private-key过滤 | 改为三purpose exact bounded DTO并验证真实Protocol envelope | Reviewer P1：通用JSON允许未知/二维raw rows且内层262144无法装入wrapper | E09-B必须复用purpose schema/保守wire ceiling | 不需要，落实TechDoc bounded DTO |
| probe只构造session与一个pending clone | 扩为五globals inventory/projection并抽共享builder | Reviewer P1：未证明prepared/selected/source/remembered/pending唯一所有权 | probe更贴近现状但仍不是E09-A实现 | 不需要 |
| golden只执行file-service/session core | 抽取production generation characterization seam并直接执行 | Reviewer P1：未锁定current/all workbook/name/warning/cache/missing seed/error零artifact | 保持live行为，禁止Publisher/atomic seed | 不需要 |
| exact footprint包含TMPDIR绝对路径 | graph内改用稳定逻辑source identity，真实临时workbook仅用于seed | Reviewer P2：跨runner rawBytes漂移 | 默认与`TMPDIR=/tmp`一致 | 不需要 |
| finance-safe-v1 会把真实纯数字或格式化账号当通用隐私泄漏拒绝 | 为五个canonical Statement result validator附加action-specific `allowFinanceSafeValue`，值域直接复用canonical `financeSafeTextViolation === 'full-account'`，并让exact result validator核对outer purpose/wrapper | 放宽/复制全局regex；按字段名全局允许；mask/choice改变业务合同 | 合法public interaction只经done走真实Protocol；错误action/purpose/path/parent与含`full-account`的interaction-shaped progress仍fail closed；generic-safe progress不借此获得interaction语义 | 不需要，属于Platform预留domain delegate |
| status直接对调用方`pendingInteractions`执行`.map()` | 冻结为maxOutstanding=1专用exact-Array reader，count/own data length/上限/一致性先验后才读own data index | Reviewer 4 P2：Proxy/accessor或overlimit可在拒绝前进入元素读取 | status字段、数量上限和合法0/1语义不变；hostile shape使用稳定错误码且零getter/trap读取 | 不需要，收紧既有exact DTO边界 |
| 证据曾笼统称所有Statement interaction-shaped progress都会在`onProgress`前拒绝 | 仅保留canonical `full-account` privacy拒绝声明；补真实main-settlement action证明generic-safe M001/scope progress进入`onProgress`但`result/receiptHint`保持null | Reviewer 4 P3：Platform通用progress不调用action result validator，原描述超出真实可达证据 | 不增加production deny/hook；waiting-user仍只由未来Worker的done interaction形成 | 不需要，属于证据校正 |
| legacy inventory只列五个global且manual seed仅覆盖首轮prompt | 增加真实`lastPendingBalanceSeedConfirmation`，执行production preflight生成overwrite重对象后投影为独立pending footprint，并冻结confirm/cancel/stale/replacement release evidence | Reviewer final P1：遗漏真实retained global与二次确认continuation会使E09-A/B迁移漏状态 | baseline inventory变六项；probe v2新增overwrite raw/estimated/public bytes，不改变live Main | 不需要，补齐现状与后续合同输入 |
| public BigAccount DTO透传raw fileName/failedFileNames与legacy message | constructor先验证真实prompt exact shape，再以first-seen alias重建三处display与固定message；finance-safe delegate未变化 | Reviewer final P1：文件名可携带完整账号/客户命名，且mismatch拼接会碰任意1024上限 | Renderer字段/选择顺序不变；公开值改为privacy-safe display alias；raw值只保留private graph | 不需要，落实Platform public/private边界 |
| current/all golden只断言workbook长度 | 增加exact workbook rows、merged rowMetas、entry source order，并执行`scope=all/includeDetail=false/includeBalance=true`的production balance-only组合与`allBalance` cache | Reviewer final P1：长度无法发现金额/币种/来源排序漂移，也未覆盖真实balance-only all路径 | 不改generation production；只加characterization golden | 不需要，收紧既有业务等价证据 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| exact base / canonical policy probe | HEAD `7577d5ae...`；Statement 五 action production=false；state/token budget 256 MiB；1 token；TTL 900000 ms | 防基线、资源、production gate 漂移 |
| E09-P0 focused tests（Reviewer 4） | 27/27 PASS | 五action parity、三purpose DTO/contextId替代、真实done Protocol boundary、path-aware finance-safe binding、full-account progress privacy拒绝、generic-safe progress可观测边界、status exact Array、footprint、五globals/TMPDIR及资金golden |
| Reviewer 2 affected regressions | 133/133 PASS（6 files） | 真实PolicyRegistry/Protocol/Supervisor、16/20位账号四domain slot、三purpose、错误action/purpose/path/parent/unknown key，以及legacy/probe回归 |
| Reviewer 3 affected regressions | 134/134 PASS（6 files） | 真实PolicyRegistry/createJobEnvelope/Supervisor、formatted与纯数字四domain slot done、含full-account的合法/错误purpose/private extra/non-array progress在onProgress前拒绝，以及Platform/legacy/probe回归 |
| Reviewer 4 affected regressions | 136/136 PASS（6 files） | frozen PolicyRegistry、Protocol与Supervisor通用progress合同、status 0/1及hostile array边界、formatted/pure-digit merchantId closure、Platform/legacy/probe回归 |
| impacted unit regressions | 209/209 PASS（43 suites） | seed/file-service、policy/interactive preflight、big-account preview与新增合同/golden/probe |
| 全量unit（环境审计） | 6195 PASS、2 FAIL、3 SKIP（6200 tests/831 suites） | 两个失败均为隔离worktree无本地`node_modules/app-builder-lib/.../multiUser.nsh`的Windows contract环境路径；其余6195通过，非业务断言失败 |
| 50k/4批次/1 token standalone probe | Reviewer 4复跑default与`TMPDIR=/tmp`的deterministic部分一致：state raw/estimated 23,614,188/35,422,208 B；pending raw/estimated 5,912,626/8,871,936 B；public DTO 805 B；default retained heap/RSS delta 13,615,592/48,431,104 B，`/tmp`为13,615,392/48,873,472 B；两类各自低于268,435,456 B | 五globals production-shape target的retained-state量级、唯一所有权与estimator headroom；动态heap/RSS不进入exact golden，不代表parser peak/真实业务/Windows批准 |
| affected ESLint + `node --check` + `git diff --check` | PASS | Reviewer 4变更的Statement contracts/test语法、lint与全部diff空白检查通过；此前Main薄委托、generation seam与probe模块检查仍保留 |
| static live-path gate | PASS：`src/main.js` 与 background runtime无 `statement-worker` 引用；canonical 五 action仍 production=false | P0未切Main/IPC/Worker/live路径 |
| Reviewer final focused | 38/38 PASS（contract/probe/golden/interactive preflight） | 第六global、真实overwrite preflight投影/footprint/release、source aliases、1024 mismatch、wire boundary、current/all/balance-only golden |
| Reviewer final affected unit | 178/178 PASS（9 files） | background error codec/PolicyRegistry/Protocol/Supervisor、big-account preview、interactive preflight与全部E09-P0 suites |
| related integration | `statement-generation-pipeline.js` 45/45 PASS | 真实statement import/generation pipeline未因合同/golden收紧回归 |
| full smoke | PASS；首次运行发现旧smoke仍扫描已抽离的`src/main.js`，仅把同一`balanceSeedStatus`守卫取证路径改到production `statement-generation.js`后复跑通过 | 修复本PR早前characterization seam抽取造成的测试路径漂移；未改业务guard或live行为 |
| 50k/4批次/1 token probe v2（default + `TMPDIR=/tmp`） | deterministic exact-equal：state raw/estimated 23,614,188/35,422,208 B；big pending 5,912,626/8,871,936 B；overwrite pending 2,012/4,096 B；public interaction/overwrite continuation 795/125 B；两类各自低于268,435,456 B | 六globals、独立overwrite footprint与TMPDIR确定性；动态heap/RSS仅校准，不作为跨runner golden |
| Reviewer final static | full `src/` ESLint PASS（只读主仓依赖）、全部changed JS `node --check` PASS、fixture JSON parse PASS、`git diff --check` PASS | 语法、lint与空白边界；无release/check-vars/scan-vars调用 |

隔离 worktree 没有独立 `node_modules`，直接运行依赖 `xlsx` 的用例会报 `MODULE_NOT_FOUND`，`npm run lint`也因本worktree没有本地eslint binary直接返回127。上述测试/probe/smoke均通过只读 `NODE_PATH=/Users/pzhong/Desktop/Project/bank-bill-excel-tool/node_modules` 使用主仓库已安装依赖；ESLint用同一依赖目录的binary + `NODE_PATH`执行并通过。这些是隔离环境依赖差异，不是业务或lint断言失败。

## Blindspot Self-review

| 盲区 | 结论 | 证据/处置 |
| --- | --- | --- |
| 入口旁路 | 新模块只被probe/tests引用，未注册Main、IPC、ServiceHost、Worker entry或background index | 静态测试与`rg`；五action production=false/effectiveMode=legacy |
| DTO/private泄露 | token handle exact-eight且拒绝extra/getter/Proxy；public DTO剥离`reservationId/sessionKey`并递归拒绝rows/prepared batch/path/grant/private context；status不含token/reservation | DTO正反测试、getter零读取与256 KiB超限测试 |
| filename/message隐私 | BigAccount constructor对raw basenames按跨数组首次出现顺序生成alias，mismatch只输出固定摘要/总数/8项preview；message/fileName没有finance-safe例外；result validator拒绝任何未规范化结果 | full-account/raw客户名正例构造后wire JSON零命中；1024个512字符failed names仍产出bounded DTO；full-account mutation经真实Protocol privacy拒绝，普通raw message/fileName/failedFileNames经真实Registry binding result validation拒绝 |
| domain privacy例外 | delegate由冻结canonical `result.validatorKey` binding取得，只接受四个真实`merchantId` slot、canonical `full-account`值域、exact done path与exact邻接shape；outer purpose由exact result validator复核；progress无delegate例外 | 真实Registry + Protocol/Supervisor；formatted/pure-digit done正例，message/fileName/scope注入、错误action/wrapper/parent/unknown key及full-account-bearing progress反例；generic-safe M001/scope progress进入`onProgress`但不产生terminal result |
| status summary边界 | `pendingInteractions`只接受exact non-Proxy Array；own data length与count/上限/一致性先验，随后才descriptor-read最多一个dense index | 0/1正例、accessor index、Proxy零trap、sparse/extra/symbol/custom prototype/non-array、overlimit/count mismatch零item读取与稳定错误码 |
| 资源双算/漏算 | persistent与pending独立计费；shared/cycle只计一次；数组enumerable/non-enumerable metadata与exact Map/Set计入；production-shape不需要的binary O(1)拒绝；unsupported prototype/accessor/Proxy/function/symbol/weak collection fail closed | footprint unit + large-view快速拒绝 + 25k child probe + 50k standalone probe |
| 状态生命周期 | P0没有token store、grant/adopt、TTL/replay/stale/crash逻辑，因此不会用本地对象假装resource handshake完成 | E09-B继续保持BLOCK；本PR只冻结DTO/estimator |
| overwrite continuation生命周期 | 真实legacy preflight生成含callback/records/session/import的confirmation；目标投影仅保留record、records digest、session/batch ref与source count，单独按pending budget计费；confirm/cancel/stale/replacement均冻结release reason | public continuation exact `{status,message,tokenId}`；callback/contextId/root/records/input paths不进入目标graph；runtime release仍留E09-B |
| 失败模式 | estimator超预算抛稳定错误且不返回reservation大小；public/status超byte ceiling fail closed | budget/size反例；live未接线所以无半采用状态 |
| legacy等价 | Main薄委托到同一`generateStatementFiles` seam；真实执行两batch current/all exact workbook rows/merged rowMetas/source order/命名/warning/cache、mixed alias、statement/calculated balance、`scope=all` balance-only与allBalance cache、缺seed queue、both-nonzero抛错且零artifact；四金额模式与manual seed继续调用真实production core | executable golden；只抽characterization seam，未实现Publisher或atomic seed settlement |
| 可观测性 | probe单行JSON同时记录inputs、heap/RSS、raw/estimated/budget、public DTO bytes、productionEnabled与明确caveat | 50k standalone输出可归档比较 |

未发现需要扩大E09-P0范围的自动Critical缺口。真实parser峰值、Windows packaged长驻、Service adoption、token lifecycle、all-or-none Publisher与seed crash settlement均仍是后续明确门禁。

## Reconciliation Blindspot Self-review

- 主键/状态血缘：golden按真实session key、batch id、entry id冻结current/all成员和稳定顺序；删除当前entry后只回退到上一有效batch。P0未改legacy globals、session mutation或artifact cache。
- 金额/方向/行数：direct、signed、field-conditional、bill split/merge均执行真实`buildMappedRows`；零金额进入`skippedRows`，Credit/Debit双非零进入`simultaneousRows`，并确认Main gate先于writer。没有复制金额算法或改变行去向。
- 币种/余额：多币种balance writer回读保持USD/EUR记录顺序和值；余额计算与manual seed复合键/previous选择/exact file bytes均锁定。未新增币种归一、seed overwrite或fallback。
- 账号格式/隐私：formatted `merchantId`只在public done DTO的既有展示值上获得transport例外，不做trim、去空格、去连字符、账号匹配或持久化转换；因此不改变大账号识别/资金归属语义，真实账号格式仍保留人工复核红线。
- 文件名/消息：raw source basename只在private state/token context中保留；public alias不参与source identity、session member、金额/币种归属或writer filename计算，因此不会改变current/all成员和资金行序。
- 幂等/部分失败：manual seed现状仍为legacy直接写；P0不实现atomic replace、intent/outcome inspector或unknown-state自动续跑，因此不声称已关闭crash window。
- ⚠️ 关联功能 review：`src/main.js`的`generateStatementFiles`抽取触及`lastGeneratedExports`关联的导出/重复导出路径，但仅改为同一函数薄委托，cache current/all characterization与209项回归通过；未修改`statementImportSessions`、`lastFileImportContext`、四金额模式标识或`BALANCE_CALCULATED_OPTION`的生命周期/值。新`STATEMENT_RESOURCE_CONTRACT`语义上属于后续跨进程Critical候选，E09-A接线时必须重新评估。本轮按负责人明确要求未运行`check-vars`/`scan:vars`。
- 🔴 人工门禁：金额、借贷方向、币种、余额seed、current/all成员与输出仍需资金负责人用脱敏真实样本逐笔复核；自动golden与generated footprint probe不解除production enablement红线。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 真实业务大文件/parser峰值与Windows packaged长驻RSS | BLOCK（后续） | Release owner用批准脱敏样本与Windows构建验证 | 不阻断P0合同；阻断Statement production enable |
| E09-A Service adoption 与旧 session mutation 等价 | PROBE | E09-A 复用本合同与 golden | 不阻断 P0；阻断 Statement import production |
| E09-B token lifecycle/waiting-user | PROBE | E09-B | 不阻断 P0；阻断所有 interaction production |
| overwrite cancel/stale runtime如何把Renderer事件送达并原子release reservation | PROBE | E09-B沿用本轮四类release characterization；不得复用legacy无IPC取消或stale保留global语义 | 不阻断P0；阻断manual-balance interaction production |
| E09-C current/all workbook all-or-none | PROBE | E09-C | 不阻断 P0；阻断 generation production |
| E09-C success artifact manifest尚未加入同一Statement result validator | PROBE | E09-C沿用本action binding扩展exact success shape，保留本delegate | P0 production=false不受影响；阻断generate-current/all production |
| E09-D seed atomic settlement/inspector/Windows | BLOCK（后续） | E09-D + release owner | manual seed 必须保持 legacy/production false |
| 金额/币种/seed/current-all 人工资金复核 | REVIEW | Reviewer / release owner | 自动测试不可解除；阻断 production enable |
