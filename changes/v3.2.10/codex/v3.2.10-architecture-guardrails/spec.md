# Spec｜v3.2.10 架构依赖边界门禁（G8）

| 项目 | 内容 |
|---|---|
| 目标版本 | 3.2.10 |
| 治理项 / 优先级 | G8 / P2；可先建立基线，保护其他治理分支 |
| 适用模块 | 源码依赖检查、Renderer 装配边界、npm / CI 门禁及相关测试 |
| 计划功能分支 | `codex/v3.2.10-architecture-guardrails`；尚未创建 |
| 代码基线 | `main@11086a3cbf632a30adbcfa796e4cd81810c5aef9`；正式附注标签 `v3.2.9` |
| 集成目标 | `release/v3.2.10`；交付前已与 v3.2.9 同步，本次未操作 Git；实施时按[总索引](../../README.md)再次核对 |
| 日期 / 状态 | 2026-09-20 / 设计稿，未实施，本文测试未执行 |
| 配套文档 | [techdoc.md](techdoc.md)、[治理总索引](../../README.md) |
| 依据 | [耦合审查 G8](../../../architecture-coupling/2026-09-20/review.md)、[静态图证据](../../../architecture-coupling/2026-09-20/evidence/dependencies.json) |
| 格式参考 | [v3.2.9 工具箱 Spec](../../../v3.2.9/codex/v3.2.9-toolbox-split-by-rows/spec.md) |

## 1. 目标与已知问题

治理后仍可能新增跨域深层引用、把纯校验再次接到 writer，或让 Renderer 继续传完整可变状态。本分支增加可重复运行的依赖门禁，以明确规则及逐步收缩的历史例外约束后续改动。

当前 [eslint.config.js](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/eslint.config.js)以 `no-undef` 为主，排除四个旧经典 Renderer；后台 action manifest 检查只覆盖其合同。它们都不等价于通用依赖边界检查，继续保留。

冻结审查扫描了 685 个 JS 文件、2,254 条字面量本地边，未发现这类边构成循环。98 条 backend→main-process 引用混有同域代码、纯计算工具和实际反向执行，不能将其全部列为违规。扫描未覆盖回调、IPC、共享状态和动态路径，不把静态通过写成全应用无耦合。

## 2. 范围和首批规则

规则面向 `src/**/*.js`（兼容新增 `.cjs/.mjs`）和 `index.html` 的生产脚本装配。脚本、测试、fixtures 不进入生产依赖图，但扫描器自身和规则要有独立正反例测试。输出覆盖文件数、未解析点、动态点、启用/待启用规则，不能默默漏文件。

| 规则 | 首批约束 | 当前/激活条件 |
|---|---|---|
| ARCH-CYCLE | 全生产字面量/可静态解析本地依赖不得新增循环，包含自引用 | 立即启用；固定基线为零个循环，无初始例外 |
| ARCH-PLATFORM-CORE | resource-governor、resource-lease、admission-queue 及其本地闭包不得依赖业务模块、Electron、数据库、文件 IO 或 worker 启动 | 立即启用；`node:crypto` 为 governor 的既有允许能力 |
| ARCH-PURE-LINEAGE | G6 的 mapped-lineage-contract、content-hash-contract 及同域纯 definitions 闭包不能引入 writer、fs、sqlite、worker、Electron、xlsx/exceljs | 两个新入口随 G6 落地激活；允许 `node:crypto` 和明确纯本地模块 |
| ARCH-RENDERER-SCOPE | G3 新控制器/领域弹窗只能依赖列明服务/自身领域；不能接整包 desktopApi、总 state/elements 或引用另一控制器内部实现 | G3 新模块出现即按模板检查；完成迁移的域必须标记 active |
| ARCH-MODAL-OWNER | `modalRoot` 的挂载/移除/清空归 modalHost；旧生产入口只允许兼容转发 | 初始以准确旧位置为历史例外；G3 R1 移除全部生产写入例外 |
| ARCH-XLSX-INFRA | G4 中性 XLSX 基础层允许必要文件 IO 和已有解析库；禁止反向引用 Position/Pending/Toolbox 业务目录及 main-process | 随 G4 基础目录落地激活；旧路径单向转发合法，但不得增加生产入边，迁完可按证据退役 |
| ARCH-PUBLICATION-RECOVERY-ENTRY | G1 raw recovery、worker recovery 操作及 prepare 的隐式恢复只能来自授权 dispatcher 路径；业务只调用 owner-scoped recovery | G1 统一启动/实时/异常/隐式入口后激活；历史 raw 调用逐位置列例外并清零 |
| ARCH-BIZOP-RECOVERY-PRIVATE | 非 BizOP 业务不得深引 BizOP recovery/publication 私有实现；Main 显式 composition 和同域业务装配合法 | 随 G1 迁移激活，旧跨域边逐项收缩；不以重命名绕过 |
| ARCH-TASK-ADAPTER | 通用 task lifecycle/executor/preflight 不得依赖 Position 状态机；业务职责通过适配器注入 | 随 G2 最后一个真实调用方迁移激活；适配器到本域业务为合法方向 |
| ARCH-BIZOP-QUERY | G5 读取协调器不得通过原始 DB 读取业务/归档表；query facade 与 archive repository 承担事实查询 | 按 Q1–Q3 切片激活；delete-preview 自有预览表命令及附属读取准确保留，不全面禁止 SQL |
| ARCH-DESCRIPTOR-COMPOSITION | G7 公共 runtime/registries/descriptor contract 不得加载领域实现或反向加载 composition；显式 composition/catalog 可以装配领域注册 | G7 移除公共 runtime 兼容反向导出并迁完消费者后激活；不能把合法装配也禁掉 |
| ARCH-STATIC-COVERAGE | 解析失败、新未解析本地引用、新不可解释动态加载/worker 路径不能被静默跳过 | 立即启用；已有动态点与 build-info 生成入口逐项登记 |

“纯模块”不按文件名含 `contract` 自动猜测，按注册入口的传递依赖闭包判断。共享 UI、恢复协调、资源调度及归档一致性能力是合法公共依赖；首批不禁止所有跨目录引用，也不要求所有域互相零依赖。

本次不重构 G1–G7 业务、不自动修复违规、不全仓移除历史测试、不解除 Preload sandbox、不引入构建框架。G8 可以发现已登记的源代码边界违规，不试图用静态规则推断资金/删除/恢复业务语义。

## 3. 历史基线与例外治理

基线从固定 v3.2.9 提交重新扫描生成，不能从包含新违规的当前分支直接“更新基线”来通过门禁。旧审查图作为比对证据，不能不经校验直接复制为生产规则。

例外必须逐项包含规则编号、准确源/目标或 AST 指纹、原始提交、理由、归属治理项与移除条件。禁止用 `src/**`、整目录放行或“历史原因”四个字覆盖整类违规。单纯 backend→main-process 不触发违例，也无需把 98 条边塞进 allowlist。

删除历史边通过；检查报告提醒移除已经无匹配的例外，同一实现变更必须收缩清单。日常检查本身只读，不自动更改清单。移动文件/改名不得把旧豁免自动扩散到新路径；确有兼容搬迁时显式替换条目并保留依据。

初始循环基线为零，新循环禁止加入历史例外。新增不可静态解析加载必须改成显式注册，或以准确位置登记完整允许目标及理由；不允许一个不透明动态字符串直接绕过平台纯度检查。新增例外/放宽规则属于可审查的架构契约变更，不由扫描器自动批准。

## 4. 新模块尚未落地时的行为

G8 先合入时，G1–G7 的拟新增边界尚未全部存在，报告将对应项显示为 `pending`，不显示这些治理项已经通过验收。配置明确计划入口、所属分支、依赖规则及激活条件；各项准确保护范围与合法装配见 [TechDoc §4.7–4.10](techdoc.md#governance-rules)。

- 文件一旦出现，基础边界立即检查，不能通过仍标 pending 豁免代码。
- 所属治理切片完成时在同一变更把规则状态改为 active，并添加存在性/装配验证；active 后路径缺失、规则回退成 pending、例外重新扩大都不能静默通过。
- 激活 G6 纯校验要求两个入口同时存在，review plan 与 writer/row-mapper 消费方向符合 G6 契约；不能只创建空文件骗过检查。
- 激活 G3 R1 要求宿主实际被生产脚本加载，全部 modalRoot 旧写入迁出；后续按控制器切片逐项激活，不宣称未迁移域已经隔离。
- 合并到 release 时复核文档、配置与实际已纳入分支清单。未纳入的切片保持明确 pending，不假填零违规。

旧 XLSX 兼容入口不属于必须永久存在的 active 入口。G4 迁移期按固定旧消费者清单允许保留，禁止增加新生产消费者；迁完后生产入边须归零。全仓引用清点和兼容回归完成后可以退役 shim，G8 核对登记状态与生产入边，不因 active 就强制保留已无调用的旧文件。

固定 v3.2.9 仅提供事实基线，该提交没有 `architecture/boundaries.json`。首次引入配置必须明确记录 bootstrap 并完整登记本稿规则。之后每次检查，除事件基线外，还从固定事实基线到实际 HEAD 的完整可达历史提取已激活边界和已退役入口的底线；更换 `--against` 或 tag/manual 再选 v3.2.9 不能清空该底线。active 不得消失或降级，必需入口/消费者不得无依据移除，retired 不得复活；合法入口改名等须有准确的 policyChanges 证据链。

PR、main push、tag、manual 和本地检查适用同一底线；历史不可读取即报输入错误，不把缺少配置误认为首次引入。三提交回归必须覆盖 S0 无配置 → S1 active → S2 pending 且删除入口，所有事件均拒绝 S2。机制和真实事件参数见 [TechDoc §5.3](techdoc.md#policy-history)。扫描器核实结构和证据链，架构调整的业务合理性仍需 review。

历史 JSON 语法损坏仍默认失败关闭，但提供准确 blob 的受控重建出口，见 [TechDoc §5.4](techdoc.md#policy-history-repair)：在同一配置变更中保存最小语法修复快照、内容指纹和审查依据，重建内容完整参与既有历史底线。当前错误配置、缺失 Git 对象、可解析的弱化配置不能借此通过；已纳入历史的有效修复绑定不得静默删改。无依据的损坏继续阻断，不通过跳过历史、换基线或重写 Git 历史恢复。

## 5. 动态边与盲区

字面量 require/import、常量 worker 路径、经典脚本顺序和已登记的全局工厂读取纳入检查。动态加载用静态可解析目标集或准确历史登记处理；无法解释的新位置使检查失败。

IPC 名称、运行时 callback 注入、任意别名/反射、共享对象内部写入和数据库语义不能由本扫描器完整证明。对 G3 已迁移控制器增加工厂入参/禁止全局标识检查，并由公开入口行为测试验证状态和生命周期。对 G6 校验增加真实模块加载测试，观察实际加载模块集合，保证无 writer/Excel/IO 依赖。

报告单独列“静态覆盖边界”，不把未检出的类别从报告消失。新模块不能使用 eval/Function constructor 或动态属性拼接去隐藏边界访问；在受保护模块发现这些结构直接失败。未受保护旧模块先准确登记，不能扩展成全仓允许。

## 6. 开发者体验与门禁

新增 `npm run check:architecture`，默认扫描当前工作区、输出中文可操作诊断和非零退出码；不写文件、不修复代码、不访问网络、不加载生产模块。可选 JSON 输出到显式路径供证据留存，输出不得包含业务数据或源码大段内容。

接入 `release-check` 为 `lint → check:architecture → smoke → unit → integration`。现有 Windows 构建/发布工作流已经调用 release-check，自动继承该检查；不增加只覆盖某个分支前缀的旁路规则。

误报应改解析器/明确配置并增加反例；不得为赶进度临时跳过命令、吞退出码或批量加入例外。首次落地保持当前合法代码通过，新增规则只限制这里明确保护的边界。

## 7. 验收清单

以下全部为后续实施验收，不是已运行结果。

| 编号 | 用例 | 断言 |
|---|---|---|
| G8-AC-01 | 固定 v3.2.9 基线 | 全部目标文件有解析结果；与旧图按共同口径一致；不将 98 条反向边全判违规 |
| G8-AC-02 | 新增两文件环/自环 | 非零退出，列出具体循环路径；删除环通过 |
| G8-AC-03 | resource-governor 间接依赖业务/writer | 传递依赖路径可定位且失败；合法 crypto 继续通过 |
| G8-AC-04 | G6 两个纯 contract | 直接或间接 fs/sqlite/Electron/worker/xlsx/exceljs/writer 均失败；definitions+crypto 合法 |
| G8-AC-05 | G3 全量 state/API 注入、跨控制器全局读取 | 在已迁移域失败；正常 scoped API 与私有本地 state 通过 |
| G8-AC-06 | modalRoot 第二写入者 | 历史条目准确匹配；新增直写失败；移除旧写入并收缩清单后通过 |
| G8-AC-07 | 例外变化 | 删除旧边可通过；过期例外有诊断；新路径不自动继承；不允许自动重写基线 |
| G8-AC-08 | 动态 import/require/worker/构建生成项 | 已知位置解释完整；新未解释位置、解析失败、错误大小写失败；合法 build-info 生成例外通过 |
| G8-AC-09 | pending→active | 缺失的计划模块明示 pending；出现即检查；激活后删除入口或退回 pending 失败 |
| G8-AC-10 | Classic scripts | 新工厂真实加载、顺序正确、跨控制器深层全局依赖失败；不要求 ESM |
| G8-AC-11 | npm/CI 集成 | check 命令失败使 release-check/现有 CI 失败；脚本跨平台，无 shell glob 依赖 |
| G8-AC-12 | 原行为测试迁移 | 改函数名/文件位置但公开行为不变仍通过；真实生命周期破坏仍失败 |
| G8-AC-13 | 确定性和只读 | 同一输入输出稳定，正常检查不改 tracked 文件、不加载业务、不请求网络 |
| G8-AC-14 | 盲区声明 | 报告显示 unresolved/dynamic/global 覆盖和 pending 数量，不以 AST PASS 宣称业务隔离全部完成 |
| G8-AC-15 | G4 中性 XLSX 边界 | 允许 fs/Node 及既有解析库，旧路径→新层转发通过，新层→旧业务/main-process 失败；新增生产消费者引用旧 API 失败，退役须无入边及有迁移证据 |
| G8-AC-16 | G1 恢复入口与私有实现 | 业务直调 raw/worker recover、prepare 隐式无授权入口、跨域 BizOP 私有引用失败；受限 owner gateway/dispatcher 和明确 Main 装配通过；运行时授权由 G1 测试证明 |
| G8-AC-17 | G2 任务适配器边界 | 公共执行器直接或经 helper 加载 Position 状态机失败；adapter 调本域与 Main 注入通过；资源收口由 G2 测试证明 |
| G8-AC-18 | G5 查询边界 | compute/export/import 及 delete collect 的 raw DB 事实查询失败；query facade、archive 方法、预览表合法命令/附属读取通过；新增未解释 DB alias 失败 |
| G8-AC-19 | G7 描述符边界 | 公共 runtime/registry/contract 直接或间接加载领域/composition/catalog 失败；composition/catalog/mature/legacy 允许清单合法，旧 runtime 转发迁完才可激活 |
| G8-AC-20 | 首次配置与历史底线 | S0 无配置允许显式完整 bootstrap；已存在配置后删除失败；S1 active → S2 pending/删除入口在本地、PR、push、tag、manual 参数下均失败；缺历史不得降为 bootstrap |
| G8-AC-21 | 历史路径迁移与恢复 | 有精确 policyChanges 的合法入口改名通过，无记录删除/扩大/retired复活失败；保持active但清空protectedScopes、删受限operation、扩装配仍失败；修复当前树恢复底线后通过，不要求为中间失败状态重写 Git 历史；merge 的各父链不得藏掉激活 |
| G8-AC-22 | 历史 JSON 语法损坏的恢复 | 当前恢复合法但历史仍坏时默认失败；精确 blob+重建hash+schema+审查依据齐备才恢复完整历史核对；错配、空重建、可解析弱化配置借道和有效修复绑定被改弱均失败；重建不能清除 active/retired 底线 |

## 8. 依赖、实施和回退

实现采用 Acorn AST，明确把当前锁文件中已有 `acorn@8.17.0` 提升为直接 devDependency 并同步 lockfile，避免依赖 ESLint 的偶然传递安装。此次仅编写设计，不修改 package.json 或安装依赖。

G8 独立建立扫描器、固定基线、历史底线与门禁；G1–G7 负责自己的迁移和行为测试，G8 提供共享规则格式及本稿明确的规则。先实现基线/诊断及正反例，再接入门禁，随后随各治理切片收缩例外和激活规则。治理优先级不依赖按文件行数或 import 数硬打分。

回退扫描器变更须连同配置和 package scripts 成套处理，不借回退删除其他治理已建立的行为测试或扩大 allowlist。纯检查无用户数据/数据库迁移。正式交付执行本分支测试、`check:architecture` 与完整 `release-check`，当前文档交付不冒称这些检查已运行。

本次文档补充统一交付要求：每个切片均按[切片完成标准](../../README.md#slice-completion)验收，并按[实施记录与状态要求](../../README.md#slice-record)区分本稿设计 AC、实际实施进度与已取得的验证证据；本补充不改变上述业务验收条件。
