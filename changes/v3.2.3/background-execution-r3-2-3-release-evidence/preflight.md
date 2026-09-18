# R3.2.3 Release Evidence — Preflight

## Task Brief

- Goal：基于 v3.2.3 冻结 Spec/TechDoc、E09/E10 已审查父链和 exact parent，为 Statement 与 NewAccount 共 7 个 action 建立只读、逐 action 独立、可机器校验的最终发布证据。
- Context：最终 E10-B head 为 `5c557ae557f0f6f148734f50f3250199cac6607d`；其后的独立 pre-evidence stabilization `771e55f72b5f91caecc013220fd8f50dd2b18e18` 已收口归档 root identity 竞态与 v3.2.2 跨版本 sequence append-only 合同，`60cf39e739147001cfbb34201edf5fa20c994bf6` 继续把 v3.2.2 历史 base anchor 固定到 reviewed blob、把当前 policy/runtime 留在 current source；精确 parent `d54f97cecddef992069d867eedc227681ed562d4` 以第一父 tree 保留两项 stabilization，并仅通过第二父保留已缓存远端 #207 ancestry；R3.2.3 只交付 release evidence，不新增生产路径。
- Constraints：只新增本目录 3 文件、validator 与 unit test；不改 `src/`、Main/IPC/Renderer、金额/币种/seed/Publisher；不 bump version；不运行 `release-check`、`check-vars`、`scan:vars`；全部 action 保持 `production.enabled=false / effectiveMode=legacy / effectiveWorkerCount=0`。
- Done when：JSON/validator 绑定 exact parent/head/merge-base、tracked blob/type/mode、冻结 7-action scope、真实 runtime ownership、reviewed evidence、自动 coverage、人工 gate 和 rollback；Statement common runtime absent 不被伪报；E09-P0/A/B/C/D、E10-A/B、RSS/cancel/recovery 可追溯；Windows/资金/恢复继续 NOT READY。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 最终 E10-B head 已包含最终 v3.2.2、E09-A～D、E10-A/B 业务叠栈；其后 stabilization 只收口 release 前暴露的归档 root identity 与旧 evidence validator 问题；冻结 Spec 恰有 Statement 5项与 NewAccount 2项。 | Git `5c557ae5... → 771e55f7...`；final-chain ancestry/range-diff；stabilization notes；v3.2.3 Spec §3/§11。 | reviewed action heads、稳定化 parent 与 action 集合分别作为 exact authority，不相互冒充。 |
| Statement 5项只存在 canonical fixture 与 module-local service entry seam。 | `statement-worker/runtime-bindings.js`；公共 `BACKGROUND_EXECUTION_POLICIES`。 | 必须写 `DORMANT_MODULE_ENTRY_ONLY / COMMON_RUNTIME_ABSENT`；不得伪报 REGISTERED/PASS。 |
| NewAccount 两项 direct policy 已进入公共 runtime，仍是 false/legacy/0；冻结 Spec 的 currentDisposition 仅 save-as 为 `inline-excluded`，generate 与 Statement 六项为 `legacy-preserved`。 | v3.2.3 Spec §3；`new-account/policies.js`；`background-execution/runtime.js`。 | direct policy 必须与 common runtime 同一对象，registration 与 production enablement 分开；liveDisposition 必须按 actionKey exact 映射。 |
| E09/E10 notes 已记录自动测试、RSS、cancel、recovery，但 Windows/真实资金/Excel-WPS gate 未关闭。 | 各 reviewed implementation notes 的 Evidence/Remaining Unknowns。 | 本地证据只能标 merge-ready，不能标 production-ready。 |
| R3.2.4 已证明 Git checkout、duplicate-key、number-token 与 ignored audit-root 旁路真实可达；本版真实 require graph 还会进入 `src/backend`。 | exact commit `a805de8b...` validator/tests；`src/backend` extensionless `require()` 路径。 | audit root 必须覆盖整个 `src`，否则 ignored backend shim 可执行非 HEAD 字节。 |
| canonical long path 仍不能让 historical exact suite 在 Windows 通过。 | exact job `99753294084` checkout `75d7ff89...`；nested `57fab04a` 9 pass/13 fail；历史 validator 唯一 `path.relative()` 对嵌套路径返回 `src\\...`，Git tree固定返回 `src/...`；historical test 的 candidate `NODE_PATH` 仍是macOS绝对路径。 | 只能在当前外层 test harness 提供可审计 separator adapter 与可丢弃依赖 root；不得改历史/current validator、snapshot或跳过负例。 |
| separator 与 candidate 依赖适配后，historical exact suite 在 Windows 仍被 worktree POSIX mode 门阻断。 | exact job `99769281418` checkout `4084b632...`；nested `57fab04a` 10 pass/12 fail；authority modules、reviewed evidence与4个真实Git反例均PASS，唯一前置错误为`GIT_WORKTREE_TREE_INVALID`。历史树精确为`2016x100644+2x100755`，validator唯一 permission 比较要求`0644/0755`；Windows Node不能原生表达。 | 只能在当前外层 win32 preload 按当前cwd/HEAD投影tracked regular file低permission bits，保留HEAD/index/type/realpath/hash/status/audit门；runner原始`core.autocrlf`未观测，但必须显式固定LF以保护后续原始blob hash。 |
| 当前 EOL probe 的 plain `git hash-object` 不是跨宿主 raw-byte oracle。 | exact job `99788627297` checkout `21388ff8...`；raw CRLF断言已PASS，但Windows clean规范化使plain hash仍等于reviewed LF OID；unit仅此1 fail，historical clone/preload/nested22与integration均未启动。 | 只把current disposable probe的两处raw OID核对改为`--no-filters`；不得修改historical/current validator或据此宣称mode/candidate/nested Windows已通过。 |
| 主 historical repo 的 Windows 兼容链已通过到21/22，剩余失败只在 raw parser 前的candidate Git baseline。 | exact job `99803981567` checkout `1f1d5fda...`；lint/smoke成功，unit `6592/6595`、1 fail/2 skip；nested 21 pass/1 fail，duplicate-key candidate只返回`GIT_HEAD_TREE_INVALID + GIT_CHANGED_PATHS_INVALID`，integration未启动。 | path/mode/LF/preload、authority及21项正负证据不能再被算作失败；但安全CLI没有实际tree/diff facts，必须先做有界test-only PROBE，不能猜修复或放宽Git guard。 |
| bounded candidate 已排除通用拓扑构造问题，历史 helper 的 Windows 路径预算是剩余差异。 | exact job `99821320839` checkout `a213495f...`；bounded baseline 先通过，nested仍为`21/22`且只在duplicate-key candidate报同一Git guard错误。历史 prefix `v323-release-evidence-` 下，两条在exact base/head均为tracked blob的最长路径为`262/261`；bounded probe原prefix较短。actual tracked count与`core.longpaths`未观测。 | 只缩短current outer root并让probe使用历史精确prefix；锁定旧/新预算`262/261 → 245/244`。不得设置Git长路径配置、修改validator或把推断count写成事实。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Statement capability 应否记公共注册。 | ownership | 高 | 容易 | runtime action map exact absent。 | PROBE | 直接加载 common runtime 与 module entry keys。 | 记 dormant entry only/common runtime absent；误报 fail closed。 |
| NewAccount generate 与 frozen fixture 有已审查 overlay。 | authority | 高 | 容易 | direct/fixture exact diff 共 10 path。 | PROBE | 结构化 deep diff。 | 只允许 exact 10 path；save-as 必须 fixture exact。 |
| review evidence 是否可跨 action 借用。 | audit scope | 高 | 容易 | P0/B/C 是共享阶段证据；A/D/E10 是 action-specific。 | PROBE | catalog actionKey + action evidenceRefs mutation。 | null 只代表明确共享阶段；非 null 只能供 exact action。 |
| local RSS 是否可作为 Windows production evidence。 | platform | 高 | 困难 | macOS/本地 probe 只具方向性。 | BLOCK production only | Setup/portable 实机 + 真实代表样本。 | `LOCAL_DIRECTIONAL_ONLY`；productionReady=false。 |
| package/release 三件套是否要更新。 | release scope | 低 | 容易 | package 仍 3.1.14，PR 无用户可见 live change。 | ASSUME | 查冻结 sequence/package。 | evidence-only 不 bump；正式发布另立 owner 决策。 |
| Windows短路径alias是否会让historical exact suite误判仓库身份。 | harness/platform | 高 | 容易 | exact job `99731507623` 先报`GIT_REPOSITORY_IDENTITY_INVALID`，路径含`RUNNER~1`；Git/realpath返回规范长路径。 | PROBE | 外层wrapper规范clone cwd和TMP/TEMP/TMPDIR；正常与symlink alias本地复验 | 只改当前外层harness；历史/current validator、snapshot和Git gates不变。 |
| Windows Git/Node路径分隔符与historical candidate依赖解析是否会继续遮蔽22项证据。 | harness/platform | 高 | 容易 | exact job `99753294084` 已用长路径但仍报三类路径前置错误；历史唯一 `path.relative()` 与硬编码macOS `NODE_PATH` 已由blob锁定和require图证实。 | PROBE | 当前wrapper创建受控win32-only preload、父子继承probe及clone外临时依赖root；正常/alias复验22/22；最终新exact Windows CI。 | 只转换cwd内contained native relative的分隔符；越界/off-cwd/非Windows保持原生，依赖链接随本轮root清理。 |
| Windows worktree POSIX mode与受控LF checkout是否继续遮蔽historical 22项。 | harness/platform | 高 | 容易 | exact job `99769281418` 锁定mode根因；最新job `99788627297` 在current raw-EOL probe先退出，证明plain hash受clean filter影响，未评价preload/candidate/nested。 | PROBE | current probe用`--no-filters`核对raw bytes；wrapper仍按每进程cwd/HEAD严格解析mode map，outer local config与nested Git env固定`core.autocrlf=false`，再等待真实Windows。 | mode projection不得影响readonly/dir/symlink/untracked/off-root；不得修改historical hash/content门；nested22仍是合并门。 |
| 短 outer root 与历史精确 prefix 是否在真实 Windows 关闭 candidate 路径预算。 | harness/platform | 高 | 容易 | job `99821320839` 的bounded probe通过而历史candidate失败；已观测temp root下旧outer为`262/261`，短outer为`245/244`，两条路径在exact base/head均为blob；actual tracked count与`core.longpaths`未知。 | PROBE | 当前test锁定helper prefix与path.win32预算，下一exact Windows运行bounded baseline、nested22、unit/integration。 | 仅缩短current可丢弃root；不改Git配置、validator或任何内容/type/index/status/audit门。 |

## BLOCK

没有实施 BLOCK。以下只阻断 production enable，不阻断 evidence-only 本地合并：

- Windows Setup/portable、路径 identity/directory fsync、长驻 service/app quit；
- 真实脱敏资金样本的金额/方向/币种/seed/current-all/NewAccount 输出；
- Excel/WPS 展示和 durable recovery 人工复核。

## 风险优先计划

1. 先锁 exact single parent、branch、5-path pure-add 100644、HEAD tree/index/worktree blob/type/mode、整个 `src` audit root、main/tag refs。
2. 在 `JSON.parse` 前锁 duplicate/NFKC key 与 number lexeme，错误输出固定且不回显输入。
3. 独立验证 Statement dormant/common-runtime absent 与 NewAccount direct/common-runtime identity。
4. 绑定 reviewed head:path blob/hash、7-action evidenceRefs 与 E09/E10/RSS/cancel/recovery coverage。
5. mutation 测试拒绝 production/live upgrade、跨 action 借证和人工 gate 自动 PASS。
6. 运行定向 unit、相关 E09/E10/platform unit、integration/smoke/lint/static；如实记录平台依赖基线。
7. 执行 reconciliation blindspot、自查 diff、提交并确认 clean。
8. 在正常temp与可丢弃symlink alias temp下各运行historical exact wrapper；真实Windows CI继续作为路径身份与integration权威。
9. 锁定historical validator/test blob与唯一调用点，以当前tracked固定preload做win32-only Git分隔符适配；验证父子继承、越界不变、临时依赖root清理和完整22项负例，再等待新exact Windows unit/integration。
10. 在同一受控preload内仅对每进程当前HEAD中的tracked writable regular file投影Windows不可表达的POSIX permission bits，并以唯一`core.autocrlf=false`控制outer/candidate checkout；保留type/realpath/blob/index/status/audit门，最终仍等待新exact Windows unit/integration。
11. disposable EOL probe只以`git hash-object --no-filters`核对raw CRLF/LF，避免host/config clean filter把raw字节差异规范化；不改变historical validator自身hash命令。
12. 在nested suite前复刻historical raw duplicate-key candidate，严格核对single parent、2018 tree、五个100644 additions、index/status/worktree；失败仅输出有界脱敏Git metadata，baseline精确后仍要求CLI唯一raw code。
13. 让current outer root使用固定短prefix，并让bounded probe与历史helper共用精确candidate prefix；以两条base/head tracked最长路径锁定`262/261 → 245/244`预算，不设置`core.longpaths`或改动Git验证门。

## 本轮验证证据

- 官方Node22.18在正常temp与精确`RUNNER~1` symlink alias下各运行当前R3 wrapper，均为外层`1/1`且复验nested historical `22/22`；v3.2.2 evidence为`30/30`。
- R3/E10-B/protocol/privacy及前序17文件跨模块矩阵为`436/436`；完整unit为`6592/6595`、0 fail/3 Windows-only skip/0 cancelled，日志为`logs/unit-tests/unit-20260901-161510.log`。
- `check:packaged-inputs` PASS、lint exit0、changed JS node-check与diff-check通过；未运行被禁的`release-check`、`check-vars`或`scan:vars`。
- macOS forced win32/mode/EOL probe仅证明受控机制及负例边界，不构成真实Windows PASS；真实win32 nested `22/22`与首次可达integration仍由新exact Windows CI权威验证。
- exact Windows job `99788627297` checkout `21388ff8...`：lint/smoke成功，unit `6592/6595`、1 fail/2 skip/0 cancelled，integration未启动；唯一失败是current EOL probe在确认raw CRLF后用plain filtered hash得到reviewed LF OID，historical clone/preload/nested22均未到达。
- exact Windows job `99803981567` checkout `1f1d5fda...`：lint/smoke成功，unit `6592/6595`、1 fail/2 skip/0 cancelled，integration未启动；nested historical `21/22`，唯一duplicate-key candidate在raw parser前收到`GIT_HEAD_TREE_INVALID + GIT_CHANGED_PATHS_INVALID`。现有CLI未暴露actual tree/diff事实，具体Windows差异仍未知。
- bounded candidate baseline probe本地复验：官方Node22.18下current outer wrapper外层`1/1`、nested historical `22/22`；candidate exact parent/tree/diff/index/status与唯一`RAW_JSON_DUPLICATE_KEY`均通过，临时root清理。该结果只证明成功路径与诊断隐私边界，不代偿真实Windows。
- bounded candidate baseline probe最终本地验收：正常temp与精确`RUNNER~1` alias均outer `1/1`且nested historical `22/22`，v3.2.2 evidence `30/30`，17文件矩阵`436/436`；完整unit `6592/6595`、0 fail/3 Windows-only skip/0 cancelled（`logs/unit-tests/unit-20260901-181354.log`）；`check:packaged-inputs` PASS、lint exit0、changed JS node-check与diff-check通过。真实Windows candidate拓扑与首次可达integration仍为PROBE。
- exact Windows job `99821320839` checkout `a213495f...`：lint/smoke成功，unit `6592/6595`、1 fail/2 skip/0 cancelled，integration未启动；current bounded baseline通过后nested historical `21/22`，仍仅duplicate-key candidate返回Git tree/diff错误。路径预算复核锁定旧outer+历史prefix为`262/261`、短outer+历史prefix为`245/244`；actual tracked count与`core.longpaths`没有日志证据。
- short-root path-budget本地验收：官方Node22.18下正常temp与精确`RUNNER~1` alias均outer`1/1`、nested historical`22/22`；v3.2.2 evidence`30/30`；显式17路径矩阵实际`354/354`，扩展为21个实际路径后`452/452`，两轮均0 fail/skip/cancelled。完整unit一次通过`6592/6595`、0 fail/3 Windows-only skip/0 cancelled（`logs/unit-tests/unit-20260901-191114.log`）；`check:packaged-inputs` PASS、lint exit0、changed JS node-check与diff-check通过。旧“17文件`436/436`”保留为此前head历史记录，不用源码静态test数伪造本轮TAP计数；真实Windows与integration仍为PROBE。
- filter-safe probe 本地复验：正常temp与精确`RUNNER~1` alias均outer `1/1`且nested `22/22`，v3.2.2 evidence `30/30`，17文件矩阵`436/436`；首次完整unit在未改E05-C用例出现1项时序失败（`unit-20260901-170750.log`），该文件相对旧head零变化且隔离`17/17`，第二次完整unit `6592/6595`、0 fail/3 Windows-only skip（`unit-20260901-170952.log`）。
- `check:packaged-inputs` PASS、lint exit0、changed JS node-check与diff-check通过；未运行被禁的`release-check`、`check-vars`或`scan:vars`。真实Windows mode/EOL/candidate继承、historical nested `22/22`与integration仍为PROBE。
