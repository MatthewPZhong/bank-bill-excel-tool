# v3.2.10 模块耦合治理｜功能分支索引

| 项目 | 内容 |
| --- | --- |
| 目标版本 | `3.2.10`，计划发布标签 `v3.2.10` |
| 文档日期 | 2026-09-20 |
| 用户已确认 | G1–G8 每项独立 Spec / TechDoc；按 v3.2.9 的功能分支目录组织；写清具体模块、接口、职责、迁移与验收 |
| 设计及源码基线 | `main@11086a3cbf632a30adbcfa796e4cd81810c5aef9`；本地附注标签 `v3.2.9` 指向同一提交 |
| 集成分支 | `release/v3.2.10`；G1–G8 已本地合入，当前为 `9a38b96b` 加未提交审查修复；第七轮修复完整门禁 PASS，见 [本地集成记录](release.md) |
| 功能分支状态 | G1–G8 已逐项本地合入；当前修复候选 31 个机器边界 active、0 pending/partial，下表保留计划名称 |
| 交付状态 | 第七轮 1 项 P2 已实现修复，新增 30 项回归；架构 386/386 PASS，完整门禁重跑 PASS（9160 项单测通过、4 项 Windows 条件跳过、68/68 集成脚本通过）。既有数组替换观察保留；修复未提交，独立复审和真实产品/平台验收未执行。见 [第七轮修复报告](reviews/2026-09-22-release-r7-repair/repair.md) |
| 独立审查修订 | R1–R9 及 G8 历史损坏配置恢复建议均在设计层关闭，无已知待修必改项；处置、验收映射和三轮依据见 [修订记录](review-response.md)，独立报告保持原状 |
| 依据 | [模块耦合审查](../architecture-coupling/2026-09-20/review.md)及该目录的静态扫描、局部探针证据 |
| 格式参考 | [v3.2.9 按行拆分 Spec](../v3.2.9/codex/v3.2.9-toolbox-split-by-rows/spec.md)、[TechDoc](../v3.2.9/codex/v3.2.9-toolbox-split-by-rows/techdoc.md)的元数据、行为合同、分阶段实施和验收结构 |

已纳入模块的实施记录：[G1](codex/v3.2.10-application-recovery/implementation-notes.md)、[G2](codex/v3.2.10-business-task-adapters/implementation-notes.md)、[G3](codex/v3.2.10-renderer-boundaries/implementation-notes.md)、[G4](codex/v3.2.10-shared-xlsx-infrastructure/implementation-notes.md)、[G5](codex/v3.2.10-bizop-query-boundaries/implementation-notes.md)、[G6](codex/v3.2.10-storage-execution-separation/implementation-notes.md)、[G7](codex/v3.2.10-execution-descriptors/implementation-notes.md)、[G8](codex/v3.2.10-architecture-guardrails/implementation-notes.md)。这些材料保留各功能实施时点的记录；当前集成 SHA、冲突处理与组合验证以 [release.md](release.md) 为准。下文第三轮设计审查状态保留为原设计基线。

本工作树已带入 G1–G8 及各自实施／审查材料。独立审查的两项 P1 已修复，最终组合完整门禁通过；机器激活、自动行为验证、真实产品／平台人工验收仍分别记录，原合入失败日志保留。

## 1. 功能分支与交付文件

优先级是治理重要性，不是已确认线上事故等级。一个治理项对应一个功能分支、一个文档目录；分支内可拆多个可验证的提交阶段，不把阶段拆成新的正式版本。

| 治理项 | 优先级 | 计划功能分支 | Spec | TechDoc |
| --- | --- | --- | --- | --- |
| G1 应用恢复与共享发布协调 | P1 | `codex/v3.2.10-application-recovery` | [spec](codex/v3.2.10-application-recovery/spec.md) | [techdoc](codex/v3.2.10-application-recovery/techdoc.md) |
| G2 业务任务适配器 | P1 | `codex/v3.2.10-business-task-adapters` | [spec](codex/v3.2.10-business-task-adapters/spec.md) | [techdoc](codex/v3.2.10-business-task-adapters/techdoc.md) |
| G3 Renderer 状态与弹窗边界 | P1 | `codex/v3.2.10-renderer-boundaries` | [spec](codex/v3.2.10-renderer-boundaries/spec.md) | [techdoc](codex/v3.2.10-renderer-boundaries/techdoc.md) |
| G4 共用 XLSX 基础设施 | P2 | `codex/v3.2.10-shared-xlsx-infrastructure` | [spec](codex/v3.2.10-shared-xlsx-infrastructure/spec.md) | [techdoc](codex/v3.2.10-shared-xlsx-infrastructure/techdoc.md) |
| G5 BizOP 查询与归档数据边界 | P2 | `codex/v3.2.10-bizop-query-boundaries` | [spec](codex/v3.2.10-bizop-query-boundaries/spec.md) | [techdoc](codex/v3.2.10-bizop-query-boundaries/techdoc.md) |
| G6 仓储、执行编排与纯校验分离 | P2；B0 为 P1 | `codex/v3.2.10-storage-execution-separation` | [spec](codex/v3.2.10-storage-execution-separation/spec.md) | [techdoc](codex/v3.2.10-storage-execution-separation/techdoc.md) |
| G7 执行与归档描述符 | P2 | `codex/v3.2.10-execution-descriptors` | [spec](codex/v3.2.10-execution-descriptors/spec.md) | [techdoc](codex/v3.2.10-execution-descriptors/techdoc.md) |
| G8 架构边界检查 | P2 | `codex/v3.2.10-architecture-guardrails` | [spec](codex/v3.2.10-architecture-guardrails/spec.md) | [techdoc](codex/v3.2.10-architecture-guardrails/techdoc.md) |

## 2. 基线、分支建立与集成

### 2.1 已核实的 Git 事实

当前主工作区为 `main@11086a3c`，正式附注标签 `v3.2.9` 指向该提交。初次调查时 `release/v3.2.10` 位于 `2ba9ef14fe972363b604955636cff0c9ac53700f`；文档交付前重新读取，已为 `11086a3cbf632a30adbcfa796e4cd81810c5aef9`，与正式 v3.2.9 一致。本任务未移动该分支，后续以实际复核结果为准，不把初次旧状态继续写成当前阻塞。

正式实施时再次检查 release 的 HEAD、干净状态、分叉和已有成果。确有基线更新需要时，仅在可快进时快进，有独有提交则采用保留成果的合并并核验；不 reset、不重建、不覆盖 dirty 工作。记录实际 SHA 和纳入的固定依赖，不使用浮动末端代替设计基线。

八个功能分支均以确认的上一正式标签 `v3.2.9` 对应提交为初始开发基线。依赖其他治理项时，将其经 `release/v3.2.10` 集成后的固定提交纳入该功能分支，并记录依赖 SHA；不从旧 release 的浮动末端无记录地起步。已存在同名分支时先检查复用，不覆盖。

模块成果按项目既有流程合入 `release/v3.2.10`，最终由 release 合入 main。创建分支、提交、推送、PR、合并、升版和正式发布均属于后续实现/发布任务，本次没有执行。

### 2.2 明确的依赖与顺序

| 阶段 | 内容 | 硬依赖 / 交付约束 |
| --- | --- | --- |
| A | G8 基线检查；G3 弹窗阶段；G6 VCC 纯校验阶段 | 可独立取证和开发。G8 对尚不存在的新边界采用文档中规定的待激活登记，不能声称已验证对应生产模块。 |
| B | G1 应用恢复 | 迁移恢复职责并先落实 owner 授权再执行副作用；未知/冲突/缺 proof 的保留是明确安全修复，不等待新的存档分类或自动清理产品设计。 |
| C | G2 通用任务与业务适配 | 集成并固定 G1 接口后落地，避免同时改写 Main 的恢复和任务所有权；仍复用 TaskLifecycle。 |
| D | G7 描述符装配 | 在 G1/G2 接口稳定后汇总注册，消费它们的接口，不重建第二套恢复/终态引擎。 |
| 并行线 | G3 领域控制器、G4 XLSX、G5 查询、G6 Acquiring | 可以并行。G4 与 G6 对 VCC 文件的改动按函数职责合并；G5 仓储改动不得覆盖 G2 的归档装配。 |
| 收口 | G8 激活全部已落地边界，release 组合验证 | 缺少任一功能分支时不能把该治理项的 AC 标为完成；待激活项不能长期当通过例外。 |

补充取证发现 G6 的 Acquiring executor 在部分 init 失败及 terminate 后提前返回，现有 Promise 收口不等于真实退出。G6 已增加明确的 P1 子阶段 B0，先建立所有已创建 worker 的退出等待，再迁移 service；其他 SQL、分片事务和恢复语义保持。这是本稿新增的具体修复要求，不能将它写成基线已有保证。

独立审查后的设计修订还明确两类修复：G1 在任何恢复副作用前完成全根归属判断和逐项授权，未知/冲突/缺 proof 的记录保留，所有实时/异常/隐式入口纳入；G2 从 prepare 成功起统一负责执行前资源，在第二 gate 或 adapter 构建失败时也收口。它们与 G6 B0 均须单列前后行为和回归证据，不能被“原样迁移”掩盖。G3 场景失效范围和父子弹窗返回、G6 受管旧 part 重建、G7 静态资源 fallback 按真实基线保留。

优先级与施工顺序不同：小切片先交付降低风险，P1 表示必须优先安排设计、实施和回归资源的结构问题。

## 3. “负责人”如何落成代码

这里的负责人指状态、规则或副作用的唯一代码归属。各模块继续位于已有 Electron Main、Renderer 或现有 worker 中，不新增微服务或业务数据库。

| 所有权 | 本轮确定的归属 | 调用方边界 |
| --- | --- | --- |
| 应用恢复阶段及平台扫描事实 | G1 应用恢复协调器 | 业务参与者不能独立宣布全应用 ready。 |
| 业务 pending / settlement / cleanup | G2 各域任务适配器及原业务服务 | 通用执行器只调用生命周期接口，不判断 Position 内部状态。 |
| UI 领域状态与请求代次 | G3 领域控制器 | 导航只调用进入/离开接口，公共弹窗通过结果回调通知调用者。 |
| 弹窗堆栈、关闭和销毁 | G3 modalHost | 业务不能清空公共根节点绕过其他弹窗的清理。 |
| XLSX 解析机制 | G4 公共基础模块 | 业务 adapter 明确资源预算、sheet/row 策略和对外错误映射。 |
| 有效业务快照与归档引用查询 | G5 domain query / archive repository | 协调器不直接访问另一模块内部表，不重新定义删除资格。 |
| 多 worker 执行 | G6 应用 service + executor | repository 保留 SQL 与事务操作，不创建 worker。 |
| VCC 映射血缘校验 | G6 `mapped-lineage-contract` | plan 与 writer 复用纯校验；该模块无文件、数据库和 worker 副作用。 |
| action 的静态装配 | G7 descriptor + 显式装配入口 | action authority 保持原定义；Renderer 不能注入策略。 |
| 边界约束 | G8 检查器及受控历史基线 | 不以扫描通过代替业务正确性或恢复验收。 |

G1/G2/G3/G4/G5/G6 定义各自接口；G7、G8 引用这些定义，不在消费侧另定义同名不同义的接口。跨项接口若需要修订，先同步其所有者 TechDoc 和对应消费者，不能在消费者内追加兼容猜测。

## 4. 统一行为与兼容底线

- 这是以保持既有业务合同为前提的结构治理。公共 IPC、金额/币种算法、匹配规则、业务身份、对外文件列与历史数据含义不因搬移代码而改变。
- 弹窗生命周期治理修复清理与回调遗漏，仍保留各业务的保存中关闭限制、取消结果、嵌套关系和现有页面样式。
- 默认不新增数据库 schema、持久化版本或新长期 feature flag；回退是整体回退已完成切片及其调用方，不能只恢复一个入口而保留半套新接口。
- 兼容转发只用于迁移路径，必须记录调用方清单及移除条件。一个入口只执行一遍实际副作用，不允许新旧实现双写或双重恢复。
- 归档永久删除保持 `managed-only`、owner/identity、hold、共享 Blob 保护与恢复合同；外部导入原件及用户另存副本不进入清理范围。
- 资源预算、准入等待、取消与真实退出屏障保持既有规则；不得为了让新架构启动而放宽失败关闭或提前释放资源。
- G1 owner 拒绝/延后恢复、G2 prepare 后收口、G6 B0 真实退出属于明列修复，其余行为保持；不得把修复要求写成当前生产已有保证。
- 源码迁移会改变 source hashes；按既有生成器和受控变更流程重算并核验。保持的是 action 覆盖、策略语义与 authority，不是要求修改代码后沿用过时的源码摘要。
- 当前“流式 reader”能力不相同。G4 保留全量读取与有界读取的差异，不将提取公共文件描述为已实现统一有界内存。

## 5. 相邻需求与历史合同

以下已发布合同按当前固定基线核对继承，不能将历史文档中的计数或验收状态直接复制为本轮结果：

- [存档文件批次合同](../v3.1.11/archive-center-file-batch-contract/spec.md)：file/no-file、manifest、lineage 与批次身份。
- [永久删除 Spec](../v3.2.9/codex/v3.2.9-archive-center-permanent-delete/spec.md)：受管范围、保护与恢复。
- [按模块保留期 Spec](../v3.2.9/codex/v3.2.9-archive-retention-by-module/spec.md)：继承、覆盖与永久保留。
- [BizOP 启动资源等待 Spec](../v3.2.7/biz-op-startup-resource-wait/spec.md)：不可满足立即拒绝、暂时竞争有界等待、未准入不得迟到执行、真实退出屏障。

[存档批次分类与退出清理](../archive-batch-lifecycle/baseline-change.md)仍有未确认产品决策，本轮不引入新的“待处理/待确认/待导出”状态、不决定拆批次号、不新增自动退出清理资格。[账号映射统一管理](../v3.2.9/codex/v3.2.9-account-mapping-management/spec.md)为相邻设计，不作为已经上线的新表/API使用。G3 若遇后续映射页面合入，仅按它真实已实现的关闭接口接入，不在本轮实现该需求。

## 6. 文档与实施的完成标准

每项 Spec 的 `Gx-AC-xx` 必须在同项 TechDoc 的测试与阶段表中有对应；新文件/接口必须标注拟新增，既有代码证据可定位；技术设计不得把未测场景写成 PASS。

本次文档检查：16份文档和索引存在；版本/分支/基线一致；本地链接可达；Spec/TechDoc AC 覆盖；计划源码文件与既有源码引用分开；跨项接口、依赖、回退与非目标一致。结果见[文档检查记录](documentation-validation.json)。

后续实施按改动风险执行单测、集成、恢复与 GUI 验收。PR-ready、正式 GUI 交付或发布前跑覆盖最终内容的 `npm run release-check`；Windows 文件占用、Excel/WPS 和真实 UI 等人工验收按各项要求单列。本次不运行完整业务门禁，不声称生产功能完成。

### 6.1 交叉审核收口

独立交叉审核已将以下问题反映到最终文档：G6 增加 B0 真实退出修复并保留原参数转换/错误优先级；G4 明确 BizOP RAW 单页与 validator 多页差异、rich 同步回调拒绝 thenable；G8 增加旧 XLSX API 新生产入边限制，并区分必需中性入口与可退役 shim。主 Agent 完成本地链接、版本/分支元数据与全部 Spec AC 对应检查。这里记录的是设计文档审核，不是代码实施或运行验收。

其后的独立审查 R1–R8 修订见 [review-response.md](review-response.md)，包含每项最终文档和 AC。G8 补入 G1 恢复入口/私有实现、G2 通用任务、G5 查询与 G7 描述符装配规则，并以完整 Git 配置历史保留本轮已激活边界底线；v3.2.9 仍是事实基线，不能作为唯一防倒退对比。G4 另补四个已存在的 VCC rich reader 消费方。这些修订已纳入后续独立复审；设计审查结论与未来实现验收分别记录。

第二轮独立报告已确认原 R1–R8 设计层关闭。新增 R9 的 G3 元数据合同明确数字 ID 复用、写前/写后失效、服务读取代次和交错写转 resync，补 G3-AC-19/20；G8 历史 JSON 损坏补准确 blob 的受控重建及 G8-AC-22，保持既有历史底线。[第三轮独立审查报告](/Users/pzhong/.codex/visualizations/2026/09/20/01a0bcfc-1a52-71f1-9e0b-2a0ad414bdb0/v3.2.10-governance-third-review/review.md)确认 R9 和该建议均在设计层关闭，R1–R8 保持关闭，未发现新增必改项。全套 92 个设计 AC 可作为按既定依赖和切片实施的依据；本次仅登记审查结项，不改变十六份 Spec/TechDoc 正文或实施状态。

实施继续遵守 §2.2 的顺序及下面的五项切片完成标准。G3 必须在实际调用链证明全部相关写入口经过同一 service；G8 的历史修复快照须由 review 核对语义保持。它们属于已确定的实施/验收义务，不是未关闭设计问题，不能以本次通过结论替代。

<a id="slice-completion"></a>

### 6.2 每切片统一完成标准

本节适用于 G1–G8 的每个既定阶段/任务，例如 G1-T2、G3 R1、G4 X2、G6 B0。沿用各 TechDoc 的切片编号；需要继续拆小时记录父切片和本次实际范围，不改变治理依赖或原 AC。每个切片除完成适用业务 AC 外，还须在同一交付中落实下列五项。各功能 Spec/TechDoc 只引用本节，不复制正文。

| 必须说明 | 完成时留下的具体事实 | 判定要求 |
| --- | --- | --- |
| 职责与边界 | 迁移前 → 迁移后模块、实际公开入口、状态/副作用写权限、允许和禁止的调用方向 | 指向实际代码位置；不能用拟新增模块表代替已实施事实，也不能只移动文件而保留原写入者。 |
| 调用方与兼容 | 已迁移及剩余调用方、保留的兼容入口、保留理由、移除条件与对应证据 | 清点生产、测试和适用预览/脚本入口；达到移除条件才删兼容转发，剩余迁移不影响已完成切片的边界判断。 |
| 业务行为 | 本切片必须保持的 AC、默认值、异常/取消/恢复及历史数据合同；明确修复项的前后差异和依据 | 复用原 Spec/TechDoc 合同并链接，不重复抄写；G6 B0 等有意修复不能被“行为全部不变”掩盖。 |
| 验证 | 适用测试名称/命令、实际结果、证据路径、执行代码状态、平台及未执行项 | 测试须覆盖该切片最终内容；设计中的测试计划、文件存在和文档检查不能代替运行结果。必要验证未完成时如实标为未完成。 |
| 当前规则入口 | 人读的现行说明/专项规则准确路径、更新章节、导读入口；适用 G8 配置、激活状态与例外变化 | 代码职责变动后同步实际说明；确实不影响某规则时写“无需更新”及原因。机器规则配置与人读模块说明分别核对。 |

切片“已完成”要求：其实现已落地、适用必要验证通过、以上五项记录齐全、当前规则与代码一致。兼容入口允许按原合同保留；不因仍有合法兼容或其他未开始切片就虚报整个治理项未做/已做。PR-ready、正式 GUI 交付和发布的完整门禁继续按原项目要求执行，不将 release-check 强制扩为每个小切片的重复步骤。

G8 尚未集成时，相关切片仍须完成自己的行为验证，并按原计划执行可用的本分支边界检查；在记录中注明 G8 未接入及后续配置更新归属。机器规则文件尚不存在时不伪造 active；其后集成 G8 的变更负责补齐已落地边界登记。已有 G8 时，适用边界状态、消费者和例外随本切片更新，不集中拖到版本结束。

<a id="slice-record"></a>

### 6.3 实施记录位置与最小格式

各功能目录优先复用已有 `implementation-notes.md`、`verification.md` 或实际使用的实施/验证记录；只选一份作为切片索引，其他证据通过链接引用。没有现成记录时，在首次实现切片开始时建立同目录 `implementation-notes.md`，按切片追加。**本次只补交付标准，不预建空白实施记录，也不把文档补充标成代码切片完成。**

使用下面的最小记录字段即可；已有记录包含等价信息时不用改名或重复生成模板：

```text
切片 ID / 父切片（如有）/ 本次范围：
代码状态：实际分支、基线 SHA、相关实现 SHA；未提交时写明 HEAD + dirty 差异证据
实现状态：未开始 / 进行中 / 已实现
验证状态：未执行 / 部分通过 / 通过 / 失败
集成状态：未集成 / 已集成（仅实际发生后记录 release SHA）
职责与边界：实际模块/接口及代码位置
调用方与兼容：已迁 / 剩余 / 保留入口与移除条件
业务行为：对应 AC；保持项与有意修复的差异
验证：命令、结果、证据、平台、未做项和原因
当前规则入口：文件路径、更新章节或无需更新原因；导读链接；G8 状态/例外
剩余项与回退：所属后续切片、已知限制、本切片适用的原回退方案
```

实现、验证、集成状态分别填写。“已实现但必要验证未完成”不能标为切片已完成；切片已完成不等于已经合入 release；未提交代码可以如实记录已实现及验证结果，不为填写记录自动提交或开 PR。证据生成后若代码变化影响其结论，补跑受影响验证并标注新代码状态；保留旧记录的来源，不覆盖成似乎一直通过。

<a id="current-rule-entrypoints"></a>

### 6.4 模块当前规则入口与维护归属

当前既有项目入口是根 [AGENTS.md](../../AGENTS.md) 的架构摘要/资料入口及 [CODEX.md](../../CODEX.md) 的工作流/资料索引；长期专项约束继续以对应 `rules/` 正文为准，例如 [run 级存储约定](../../rules/run-scoped-data-policy.md)。版本 Spec/TechDoc 保存设计合同，切片记录保存实施证据，模块现行说明保存已经落地的职责与使用方式，三者互相链接。

下表是实施时的默认落点；本 release 已建立 G1—G7 入口，G8 模块 README 仍为拟新增，不能作为已存在的规则入口。首个涉及该模块实际职责的切片建立说明；若届时已有覆盖同一职责的权威说明，则复用该说明，并在本表和切片记录中更新准确路径，避免两份正文。记录模块实际入口、状态/副作用归属、允许/禁止依赖、当前兼容接口及代表性测试链接即可，不复制完整版本设计。

| 治理项 / 维护者 | 默认人读现行说明入口（实施时建立或复用） | 切片应同步的内容 |
| --- | --- | --- |
| G1 恢复协调切片 | [src/main-process/application-recovery/README.md](../../src/main-process/application-recovery/README.md)（已集成） | 应用/平台/业务恢复事实归属、participant 顺序、publication owner 调用入口与失败边界；跨 publication-recovery 的说明由此链接其实际代码。 |
| G2 任务适配切片 | [src/main-process/task-adapters/README.md](../../src/main-process/task-adapters/README.md)（已集成） | registry、领域 task-owner、prepared 资源、live/replay terminal routes 的职责和调用关系；引用实际 Position/Archive 入口。 |
| G3 Renderer 切片 | [src/renderer/README.md](../../src/renderer/README.md)（已集成） | shell/controller/modalHost 各自写权限、脚本装配、导航/销毁协议；只把完成的 R 切片写为现状，保留剩余旧域说明。 |
| G4 XLSX 切片 | [src/backend/xlsx/README.md](../../src/backend/xlsx/README.md)（已集成） | 两类 reader 的适用入口和能力差异、预算/关闭/临时资源所有权、旧 shim 现状；不把目录提取写成性能升级。 |
| G5 BizOP 查询切片 | [src/main-process/biz-op-v327/README.md](../../src/main-process/biz-op-v327/README.md)（已集成） | queries 与 commands 的边界、catalog.db 合法保留者、Archive 查询入口及准入/预算归属；仅补本项涉及的实际内容。 |
| G6 VCC / Acquiring 切片 | [VCC](../../src/backend/vcc-financial-op/README.md)、[Acquiring](../../src/backend/acquiring-bill-currency-db/README.md)（已集成） | 分别记录纯 hash/lineage 合同，以及 repository/service/executor 的实际入口、B0 退出屏障、partial/resume/清理顺序；已有存储专项约束只引用，语义未变时不机械改写。 |
| G7 描述符切片 | [src/main-process/execution-descriptors/README.md](../../src/main-process/execution-descriptors/README.md)（已集成） | 静态装配、独立 authority、各 registry 所有权和新增 action 的真实步骤；引用 G1/G2 说明，不另定义生命周期。 |
| G8 检查器切片 | `architecture/README.md` | 检查命令、配置入口、覆盖盲区、激活/例外/退役规则及消费者维护方式；机器正文仍在 `boundaries.json`、`legacy-allowlist.json`，人读说明只解释与链接。 |

每份说明首次落地时，在根 `AGENTS.md` 的资料入口增加链接或更新其已有导读位置；只添加导航，不重复模块规则正文。后续修改职责/接口/兼容或验证入口的切片，更新对应模块说明；更名或移动时同步导读和消费者引用。已有合适上层模块索引时可通过该索引承接，并在切片记录留下从根入口到该说明的路径。

G8 的配置入口与模块说明具有不同作用：人读说明在本域变化时维护；可执行约束按 G8 已确定的规则覆盖范围维护。G1/G2/G5/G7 本轮承诺的规则已经列入 G8，不能再用“不适用”跳过；真正超出 G8 覆盖范围的行为写明原因并由对应测试验证，不为填写五项清单临时发明未设计的门禁。现行说明不改写尚未完成的行为、不擅改业务合同，也不要求每个目录新增 `AGENTS.md`。
