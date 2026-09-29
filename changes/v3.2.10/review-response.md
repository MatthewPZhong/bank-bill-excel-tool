# v3.2.10 治理设计｜独立审查修订记录

日期：2026-09-20。状态：第三轮独立设计复审通过，R1–R9 及 G8 历史损坏配置恢复建议均在设计层关闭，未发现新增必改项；生产实现和业务验收均未执行。

## 1. 目标、依据与范围

继续交付用户要求的 G1–G8 分功能分支 Spec / TechDoc，使职责、接口、迁移顺序、兼容入口和验收条件可以指导后续实现。此次根据[独立审查报告](/Users/pzhong/.codex/visualizations/2026/09/20/01a0bcfc-1a52-71f1-9e0b-2a0ad414bdb0/v3.2.10-governance-independent-review/review.md)核实并修订 R1–R8，保留已经明确的每切片五项交付要求。

随后收到[第二轮独立审查报告](/Users/pzhong/.codex/visualizations/2026/09/20/01a0bcfc-1a52-71f1-9e0b-2a0ad414bdb0/v3.2.10-governance-rereview/review.md)：R1–R8 设计层关闭，新增 R9/P2 场景 ID 复用与迟到查询问题，另建议 G8 明确历史 JSON 损坏后的受控恢复。本记录保留原处置，并追加这两项设计响应，当时记录为修订后待复核。

[第三轮独立审查报告](/Users/pzhong/.codex/visualizations/2026/09/20/01a0bcfc-1a52-71f1-9e0b-2a0ad414bdb0/v3.2.10-governance-third-review/review.md)现已明确通过：R9 和 G8 恢复建议设计层关闭，R1–R8 保持关闭，无新增必改项。本次仅把该独立结论及快照身份登记到索引、修订记录和文档验证 JSON，不再修改已审查的十六份 Spec/TechDoc 或增加 AC。第三轮原报告、[输入状态及指纹](/Users/pzhong/.codex/visualizations/2026/09/20/01a0bcfc-1a52-71f1-9e0b-2a0ad414bdb0/v3.2.10-governance-third-review/input-state.json)及[验证记录](/Users/pzhong/.codex/visualizations/2026/09/20/01a0bcfc-1a52-71f1-9e0b-2a0ad414bdb0/v3.2.10-governance-third-review/verification.json)保持原状。

事实基线仍为 `11086a3cbf632a30adbcfa796e4cd81810c5aef9`，对应本地 `main`、`v3.2.9^{commit}` 和本次读取的 `release/v3.2.10`。待审文档是主工作区未跟踪文件，不能用 `git diff` 为空证明其没有变化；外部报告及其中的探针结果是输入证据，不改写外部报告，不把其基线探针当成修订后的实现验收。

本次只修改本版本的 Markdown 和文档核对记录，不改生产代码、测试、依赖、Git 引用或持久化数据。完成条件是已确认问题都有明确设计处置及验收映射，跨文档职责和接口一致，本地链接/行号/锚点与 AC 映射检查通过；不是治理代码已经完成。

## 2. Unknowns Register 与设计决策

| 项目 | 分级 / 核实方式 | 决策与可验证条件 |
| --- | --- | --- |
| R1 恢复副作用与入口 | PROBE：核对底层 recover、隐式 prepare 恢复、Main handoff/ack、异常恢复调用 | owner 认定必须先于每项副作用；所有实时和启动入口受同一授权边界约束。未知/冲突/缺 proof 的记录保留，是明确的安全收紧。 |
| R2 场景失效范围 | PROBE：逐个对照 Main IPC 和 Renderer 更新调用 | categories 与 invalidationScope 分离，保留 Main 各命令现有清空行为，不在拆控制器时缩小范围。 |
| R3 父子弹窗 | PROBE：存档确认及 Toolbox 返回调用链 | modalHost 管理父子 handle；父会话直到最终关闭才销毁。关闭子层返回、异步锁、过期结果和一次清理纳入验收。 |
| R4 prepare 后资源归属 | PROBE：二次 gate、构建 adapter、TaskLifecycle 接管时点 | 从 prepare 成功起建立唯一 prepared scope owner，覆盖执行前所有失败；这是相对基线的显式修复。 |
| R5 跨 run 残留 | PROBE：multiworker 的 fixed tempDir、part 清理与既有 C1 回归 | 保留受管旧 part 的必要清理；以受管命名空间和任务权限认定，不凭 basename 删除 caller 的无关文件。 |
| R6 descriptor/registry 合同 | PROBE：原 registry bucket、runtime 装配与 supervisor fallback | 对齐原 bucket 名和静态 resourceProfileKeys；静态 phase 资源不伪装成动态 estimator。 |
| R7 跨文档规则缺口 | PROBE：G1/G2/G5/G7 的承诺逐条映射 G8 | 明列受保护入口、合法装配、精确历史例外、激活及正反例；运行时语义仍归各域行为测试。 |
| R8 policy 基线 | PROBE：v3.2.9 树及真实 CI 事件参数 | 事实基线与防倒退证据分离；事件对比之外强制检查本轮历史激活底线，首次无配置有独立 bootstrap 合同。 |
| R9 场景类别元数据 | PROBE：真实仓储 ID 分配、Main 单项分类及原读取 API | 采用服务私有 metadataEpoch/活动写集合；写前和结算全局失效，跨写旧读不能入缓存；只在分类证据无交错且写入口可信时发布确定 scope。 |
| G8 历史 JSON 损坏 | PROBE：按配置历史合同推演坏 JSON→当前恢复序列 | 默认仍拒绝；用准确原 blob、最小语法重建快照和审查依据恢复历史解析，重建完整进入原底线；无记录或身份/内容不符继续拒绝。 |

以上选择均在原治理目标和已发布行为约束内作出；R1、R4 及原有 G6 B0 的行为修复须明确单列，不能声称都是行为完全不变的搬迁。不新增微服务或数据库，不以静态门禁替代业务证明。

上述 PROBE 均已通过当前源码读取及跨文档核对解决设计未知，不表示相应未来测试已执行；本轮没有需产品另行拍板的未决设计选择。原计划 G1→G2→G7 顺序及每切片五项交付标准保持。

## 3. 问题处置与验收映射

下表的“已修订”只表示设计正文和验收计划已落实，不代表实现完成。R1–R8 已由第二轮独立报告关闭，R9 和 G8 恢复建议由第三轮关闭，均限设计层。优先级保留各轮提出问题时的设计修订等级，不代表当前仍有同级待修问题。

| 项目 | 处置与最终设计 | 文档入口 | 对应验收 / 必须验证的核心断言 |
| --- | --- | --- | --- |
| R1 / P1 / G1 | 已修订。FIFO 内只读发现→全根归属判定→Main 授权→worker 重验后执行；全部启动/实时/异常/隐式入口归一。unknown/conflict/缺 proof 在副作用前保留；deferred 不得丢失或误作 ack 成功。 | [Spec](codex/v3.2.10-application-recovery/spec.md)、[TechDoc §4](codex/v3.2.10-application-recovery/techdoc.md:89) | G1-AC-04/05/08/09：各状态五类材料不变；隐式 prepare/transport 同入口；deferred ack 零确认/cleanup；合法回滚及 receipt 已清理后的有证据幂等保持。 |
| R2 / P1 / G3 | 已修订。Renderer command service 区分 categories 与 invalidationScope；transfer/batch-delete/import apply 成功双清，setApplicableChannels 仅 BankStatement，其余逐命令保留实际行为。IPC 不变。 | [Spec §5](codex/v3.2.10-renderer-boundaries/spec.md:103)、[TechDoc §6](codex/v3.2.10-renderer-boundaries/techdoc.md:207) | G3-AC-10/11/15/16：真实 handler+controller 对照矩阵；结果、按钮、导出反馈一致；缺元数据/不确定结算显式 resync。 |
| R3 / P1 / G3 | 已修订。Archive Settings/Delete、Toolbox/Picker/Alert 采用存活父 handle+子层；返回不重挂已销毁 DOM；父会话保有 token/草稿/锁，最终清理一次。 | [TechDoc §3.5](codex/v3.2.10-renderer-boundaries/techdoc.md:134)、[§3.6](codex/v3.2.10-renderer-boundaries/techdoc.md:148) | G3-AC-17/18：取消/成功/失败/待清理、保存限制、迟到回包、提交一次及 token 生命周期；真实工厂和 GUI 各有验收。 |
| R4 / P2 / G2 | 已修订，明确为修复。prepare 成功即建立唯一 resource scope，二次 gate、初始化、adapter 构建与 lifecycle 同处收口范围；executeStarted 后交给领域；cleanup 纳入退出 tail。 | [Spec](codex/v3.2.10-business-task-adapters/spec.md)、[TechDoc §3](codex/v3.2.10-business-task-adapters/techdoc.md:51) | G2-AC-02/04/09：执行前拒绝业务零次、abandon 一次；执行接管后公共 abandon 零次；同步异常、双异常优先级、延迟 cleanup。 |
| R5 / P2 / G6 | 已修订。保留可信受管 part 命名空间内的 C1 写前重建，精确到实际派发路径及 sidecar；caller 根/无关文件/未触及 part/其他 run diff 不动；同空间顺序复用，不引入新 run 子目录。 | [Spec](codex/v3.2.10-storage-execution-separation/spec.md)、[TechDoc §4.3](codex/v3.2.10-storage-execution-separation/techdoc.md:140) | G6-AC-04/05/07：旧差异行不混入、新旧受管 part 身份与真实退出顺序、调用方无关文件保留；复用既有 C1 并补边界。 |
| R6 / P2 / G7 | 已修订。十四个 staticKeys bucket 与既有 registry 原名一致，五类 runtime registry 精确转换；resourceProfileKeys 含静态 profile，动态 estimator 仅保留原 NewAccount 项。 | [Spec](codex/v3.2.10-execution-descriptors/spec.md)、[TechDoc §2.1/2.2](codex/v3.2.10-execution-descriptors/techdoc.md:67) | G7-AC-02/03/05/08：真实原 registry freeze/getBinding；静态 profile 继续 phase fallback，重复键/缺键/Promise/slot 变更按原错拒绝。 |
| R7 / P2 / G8 | 已修订。新增两条 G1 恢复规则，以及 G2 task adapter、G5 query、G7 descriptor composition 三条；保护入口、允许装配、schema、历史例外、激活与正反例一一对应。 | [Spec](codex/v3.2.10-architecture-guardrails/spec.md)、[TechDoc §4.7–4.10](codex/v3.2.10-architecture-guardrails/techdoc.md#governance-rules) | G8-AC-16～19：非法直调/间接依赖/DB 旁路失败；合法注入、preview 命令、composition 通过；运行时语义仍归原域测试。 |
| R8 / P2 / G8 | 已修订。事实基线、事件对比、完整配置历史分离；保留所有可达父链 active/retired 底线，定义首次 bootstrap。防倒退覆盖所有影响规则效力的字段，不只看 active 状态。 | [TechDoc §5.3](codex/v3.2.10-architecture-guardrails/techdoc.md#policy-history) | G8-AC-20/21：真实 Git S0无配置→S1active→S2降级/删入口，local/PR/push/tag/manual 均拒绝；清空 scope/删受限 API 仍失败；合法改名和 S3 恢复通过。 |
| R9 / P2 / G3 | 已修订，第三轮设计层关闭。数字 ID 可跨类别复用；元数据仅由 service 持有，写开始及结算递增 epoch/失效缓存，拒绝跨写的旧 list/get；create 有证据才播种新身份，批删/导入/未知结算不保留可信旧映射。 | [Spec](codex/v3.2.10-renderer-boundaries/spec.md)、[TechDoc 元数据合同](codex/v3.2.10-renderer-boundaries/techdoc.md#scenario-metadata-consistency) | G3-AC-19/20：同 ID 跨类别复用及反向用例；旧读/补读晚到、交错写和未知结算；实际 Main/Renderer scope、按钮、反馈一致，不只测试 Map 方法。 |

另采纳 G4 非阻断建议：补列 workbook-import-plan、system-op-importer、dataset-writer、review-validator 四个现有 rich reader 调用方，独立为 R4 组；区分其未设置 cacheMaxBytes 与 review plan 的显式缓存，纳入 G4-AC-04/06/08。见 [G4 迁移与测试清单](codex/v3.2.10-shared-xlsx-infrastructure/techdoc.md:110)。

## 4. 交叉核对中的补充收口

- G1 的 BizOP ack 原代码在 recovered 缺项时可能继续确认；现明确 deferred/skippedActive 必须 ACK_PENDING，零确认/cleanup；共享 Archive 三阶段透传未决，不能拼接不同观察为虚假 absence。absence 仅约束缺 recovered 的分支，原明确回滚/取消结果仍沿原逻辑形成 NOT_COMMITTED。
- G3 渠道 CRUD 的 configuration-changed 补齐最小 shape、固定配置订阅者、退订与迟到响应，仍不清业务结果。
- G8 修正 ipc-task-contract 的 archive-center 真实路径；防倒退覆盖 protectedScopes/restrictedApis/允许装配等全部语义字段。迁移链以提交/配置版本判断顺序，允许有依据的 A→B→A 路径恢复。
- G1/G7 publication owner 统一为 biz-op-v327 / archive-publication；toolbox-vcc-publications 仅保留应用阶段 participant/log 身份。G2/G5/G7 使用 G8 同名规则，不再保留消费侧承诺却无提供侧规则的情况。

## 5. 第二轮追加修订的具体边界

R9 使用 service 自身的 metadataEpoch，独立于事件去重 revision 和页面 request generation。delete/batchDelete 删除后的缓存、create 同 ID 新实体、applyImport 不完整变化集合均有明确规则。现有 scenarios.list 确实是全量列表；若未来有过滤/分页结果，不得当全量覆盖。读取来源、调用前冻结证据、写期间交错及结算后的播种分开判断，不能把页面先刷新当成正确性前提。

结果分类仍保持 R2 已关闭的命令矩阵：固定双清/单域命令和 create 的提交类别不因元数据缓存失效改变。只有依赖原记录类别的 update/delete-true/toggle，在类别证据过期或不可信时走既有 resync；不能广播错误确定 scope。unknown settlement 不靠一次读取或重建 service 恢复信任，不重试业务写、不阻塞原命令；Main 的当前结果仍是事实来源。

G8 非阻断建议对应 [TechDoc §5.4](codex/v3.2.10-architecture-guardrails/techdoc.md#policy-history-repair) 和 **G8-AC-22**。准确 path/blob 的历史语法修复快照及审查依据恢复解析，重建继续参与 active/retired 与完整保护字段的历史底线。只有在相应历史提交通过身份、hash、材料、schema、证据完整核对的 repair 绑定才固定；错 hash 的未生效登记允许后续修正，先前完整有效绑定不能被坏 manifest 清除。全部登记及引用材料的历史变化都必须读取。当前错误配置、缺失 Git 对象和可解析的弱化配置不能借此豁免。

本节为设计增量；没有新增真实场景服务、repair 文件、扫描器或 CLI 开关，也没有修改数据库 ID 分配策略。G1→G2→G7 依赖与每切片五项交付要求保持。

修订时另做了限定范围的内部交叉核对：R9 的 ID 复用、读写代次、逆序响应、播种和 resync 合同未发现新增必改项；G8 的历史读取范围及“完整有效绑定才固定”两处反馈已经补齐并复核。此后第三轮外部独立复审对这两项明确给出设计层关闭结论；内部核对与外部结论分别保留来源。

## 6. 验证与未执行项

本次核对范围为文档、当前源码事实、接口一致性与可实施性。独立审查已执行的五个基线探针及一个 C1 回归见其[验证记录](/Users/pzhong/.codex/visualizations/2026/09/20/01a0bcfc-1a52-71f1-9e0b-2a0ad414bdb0/v3.2.10-governance-independent-review/verification.json)，本次不重复标记为新实现 PASS。

本次文档检查结果写入 [documentation-validation.json](documentation-validation.json)，包含逐文件指纹、链接/源码行号/锚点、AC 技术表覆盖及工作区边界；PASS 仅限这些已执行的结构检查。第一轮修订后为 89 条 AC，第二轮修订新增 G3-AC-19/20 和 G8-AC-22，共 92 条；第三轮结项登记不再增加或修改 AC。原有编号保留，修改过的旧 AC 保留编号不表示旧文义未变。

第二轮同事执行的[ID 复用探针](/Users/pzhong/.codex/visualizations/2026/09/20/01a0bcfc-1a52-71f1-9e0b-2a0ad414bdb0/v3.2.10-governance-rereview/scenario-id-reuse-probe.json)使用真实仓储与内存 SQLite，3 项断言通过；本轮读取仓储/Main 源码核实其事实，没有重复执行该探针，也没有运行尚未实现的 command service 或 G8 历史恢复 fixture。

G7 的十四条 STATIC_REFERENCE_PATHS 已从既有 registry 逐项抽取与映射表对照，无缺项。G8 首次配置、实际工作流参数及新规则覆盖经只读交叉核对；未执行未来 scanner 或真实 Git fixture，不以设计推演称门禁通过。

未执行治理实现、治理单测/集成、完整 `release-check`、真实 GUI、Windows、Excel/WPS 或安装包验收；未创建功能分支、提交、推送或发布。生产代码及其他已跟踪文件未改，既有无关未跟踪目录保留。三轮独立审查报告均未修改；本次状态登记后的索引/记录使用新指纹，十六份方案正文保持第三轮已审查内容。

## 7. 设计审查结项与实施交接

设计审查状态：通过，R1–R9 及 G8 非阻断建议均关闭，无已知待修必改项。实施状态：未开始；运行验证状态：未执行；集成状态：未集成治理代码。设计通过可以作为后续实施依据，不能据此把切片或 92 个 AC 标为完成。

实施沿用总索引的既定依赖和切片，不重排 G1→G2→G7。每完成一个切片，仍记录职责边界、已迁调用方与兼容入口、保持及修复的业务行为、实际验证证据、当前规则入口五项。尤其保留 G3 全部相关写入口的实际接入证明，以及 G8 repair 快照语义保持的人工 review；它们是实施验收义务，不是待补设计条款。
