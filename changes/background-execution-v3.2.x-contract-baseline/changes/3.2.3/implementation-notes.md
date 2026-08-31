# Implementation Notes

## Baseline

- Goal/spec: [`spec.md`](./spec.md) 与 [`techdoc.md`](./techdoc.md) 的 E09-C current/all generation。
- Initial plan: 先取证 session scope、legacy generation seam 与 Publisher，再实现 dormant Service generation、Main validation/publication seam 和专项回归。
- Done when: Service 仅从私有 session 选择 entries，复用既有 generation seam 写 task staging，Main 只接收 bounded manifest 并在全部校验通过后 all-or-none 发布；production 仍 disabled/legacy/0 workers，专项和既有回归通过。

## Task Brief / Unknowns Register

### Goal / Context / Constraints / Done when

- Goal: 实现 `statement:generate-current` / `statement:generate-all` 的 dormant canonical execution。
- Context: E09-P0/A/B 已冻结 DTO、Service session、token reservation 与 waiting-user 生命周期；review fix 的初始 restack exact base 是 `513620c4a20c32975e4615c968e1381fbdb421c5`，最终合并前再传播 #197 release tip `290c3a9cdbbeb7fbf424e3d940e4aa3b619a374b`。
- Constraints: 不接 live Renderer/IPC，不启用 production，不实现 E09-D manual seed settlement 或 E10；不把 detail rows/prepared batch/大 workbook 状态带回 Main；warning 与业务顺序保持 legacy。
- Done when: 真实临时 XLSX/SQLite/worker/service 链路、current/all 与四金额/余额 golden、artifact tamper/all-or-none/crash-cleanup 等专项证据及 E09-P0/A/B/platform 回归通过。

| 未知 | 处理 | 当前证据 | 当前决定 |
| --- | --- | --- | --- |
| current/all 的 entries 选择与顺序 | PROBE | `statement-session.js#getStatementSessionEntries`；E09-P0 golden | current 使用 `currentBatchId.entryIds` 顺序，all 使用 `fileEntries` 插入顺序；不另建排序规则 |
| 四金额、余额、多币种、warning 与 writer 的单一真相 | PROBE | `statement-generation.js#createStatementGenerationHelpers`；`statement-legacy-golden-e09-p0.test.js` | Service 复用同一 helper seam，不复制金额/余额算法，不并行 detail/balance |
| worker 如何只写 task staging | PROBE | generation helper 的 `buildStatementOutputFilePath` 是注入依赖 | worker 绑定 staging output planner；请求不允许 final target |
| Main all-or-none Publisher 能力 | PROBE → CLOSED | `toolbox-output-publication.js` 的 prepare/publish/dispose 与 journal fault tests | 复用既有 journal Publisher；全部 technical/business readback 先完成，Publisher 只调用一次 |
| generation token、revision、input evidence 的绑定形态 | PROBE → CLOSED | E09-B token store、Service 私有 session、import template/source evidence | scope prompt token 私有绑定 current/all 两个 evidence hash；continuation 按实际 action scope 复核，再 single-use consume |
| parent/child/filename 多模板 session 的 generation authority | PROBE → CLOSED | E09-A 已冻结逐 source `templateRef/templateDigest` lineage；真实 filename owner current/all mixed-template golden | `generationConfigByDigest` 是 Worker session 内唯一累积 authority；entry 必须按自己的 digest 命中，unknown/missing fail closed，不回退 owner/最近模板或建立第二 config authority |
| 同步 writer 完成与 shutdown cancel 谁拥有终态和未发布文件 | PROBE → CLOSED | 真实 Worker 可在 success completion 已登记、token release ack 尚未返回时收到 cancel；同步 writer 内原先没有可达 event-loop safepoint | artifact unit 间及最终 manifest handoff 前让出 event loop，并始终复用 `job.cancelled/assertJobActive`；cancel request/ack 后 success completion 不得胜出，唯一 unpublished generation owner 清理整组 staging |
| manual balance prompt | BLOCK for E09-D, observable in E09-C | Spec 明确 E09-D 后续；legacy helper 以 warning 返回 prompt | E09-C 仅返回 bounded warning summary 并拒绝发布不完整 artifact set，不写 seed、不结算 prompt |

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| entries 选择委托现有 `getStatementSessionEntries` | legacy golden 已冻结 current/all batch identity 与 remove 回退语义 | 在 generation 模块重新筛选或排序 | scope/order 与 legacy 同源 |
| generation 继续调用 `createStatementGenerationHelpers`，并把 Main 原余额 helper 抽到 `statement-generation-business.js` | helper 已承载 mapped-row merge、四金额、余额、warning、writer；legacy 与 Worker 现共用同一份 balance/date/seed-scan 函数 | 在 Worker 复制业务算法 | Main/Worker 单一真相；既有 golden 改为直接加载共享 production module |
| Worker 只接受 task staging + artifact plans | TechDoc 禁止 Worker 接 final target，且 Main 只持 FilePlan/manifest | Worker 直接写正式 exports 或 Main 传大行数据 | 维持单 Publisher 与 Main heap 边界 |
| detail/balance 严格串行，任一缺失即删除全组 staging | legacy helper 的 warning/output 顺序是业务合同；manifest 是 all-or-none | 并行 writer 或返回 partial manifest | 保持 warning/order，partial writer/manual-seed-required 时 Publisher=0 |
| 串行 generation 以 artifact 为最小 safepoint unit，Service 在 `job:done` 前持有 unpublished ownership | XLSX writer 同步执行，只有 artifact 边界可在不改变 legacy writer/顺序的前提下观测 shutdown cancel；token release ack 之前 Main 尚未取得 manifest/publication ownership | 修改通用 Supervisor、在线程内增加第二 cancel authority、writer 每行异步化或 cancel 后允许既有 success completion 获胜 | current/all、detail/both 均在 unit 间和最终 handoff 前可取消；cancel 统一为 `STATEMENT_IMPORT_CANCELLED`，整组 staging 清零；成功仍把文件保留给 Main validation 与单 Publisher |
| generation Worker 不持久化 balance seed | Worker 只能写 task-private FilePlan staging，manifest 不承载 seed mutation；manual seed 属 E09-D | Worker 直接改共享 balance-seeds | dormant 路径只生成 workbook；seed settlement 继续由后续独立门禁负责 |
| Main 对 journal manual-recovery 保留 generation | 既有 Publisher 的 `preserveTemporaryFiles=true` 是人工恢复证据 | finally 无条件删除 generation | 普通成功/失败清 staging，uncertain/manual-recovery 保留证据 |
| Main descriptor 以 cell-contract digest 绑定 writer 持久化语义 | Round 2 证明业务值 digest 会把非特殊字段的 string/number 归一为同值，且原 style gate 未覆盖 data font 与 header bold/color | 把 raw rows/完整 style XML 放入 descriptor，或校验 XF id/apply flags 等默认噪声 | descriptor 只增加定长 `cellCount/cellsSha256`；逐格绑定 writer 实际 t/z 和有意义 style，仍不携带 raw rows |
| style evidence 按 workbook relationship 解析实际 worksheet part | Round 3 证明硬编码 `sheet1.xml` 与正则扫描任意 `<c>` 可被 relationship decoy、注释和属性语法旁路 | 继续硬编码 part、扩大 raw XF 摘要或引入第二套 ZIP reader | 复用现有 `sax` 结构化解析 `workbook.xml`/rels/`worksheet/sheetData/row/c`；重复坐标及显式 style 不可解析时 fail closed，只有缺失 `s` 使用 style 0 |
| workbook 公式使用单一 sheet-wide gate | 原实现只在 data record loop 检查 `cell.f`，header 正确缓存值可旁路 | 在每类 header/data validator 分散补检查 | bounded range 确认后统一拒绝所有正式输出 cell 的 formula，再执行业务 readback |
| mixed-template generation 按 entry digest 解析配置并按 legacy template group 串行生成 | E09-A parent/child 与 filename owner 允许同 session 多模板；live filename path 以模板首次出现顺序分组，组内保持来源顺序后再合并 workbook | 复用 owner config、最近 config、或为 generation 再建 filename fallback | 金额/币种/银行/所在地/余额使用各 child snapshot；current/all 保持 legacy 的模板分组/组内顺序，calculated/statement 余额可在同 template 的多 entry 间连续推导 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| 现有 journal publisher 可在不接 live IPC 的情况下复用 | 其核心 API 已模块化并有 fault tests | 已通过双 artifact 第二项失败回滚、成功发布及 generation cleanup 验证 | production 保持 false，可独立回滚新增 dormant seam |

## Deviations

### Reviewer Round 1 contract clarification

Round 1 证明原实现的“Main business validator”只有单 sheet/行数回读，且
`FilePlan + Worker manifest` 不能独立绑定 artifact kind 与业务内容。为闭合既有
“全部 technical/business validation 后才 Publisher”的合同，本 change 增加
`MainExpectedArtifactDescriptorV1`：由 Main 持有并在调用 publication seam 时传入，
绑定 artifactKey、kind、冻结顺序、task-owned staging resource、sheet/header、行守恒、
有序记录及日期/账户/币种/金额摘要、writer/style/watermark/template lineage。该 descriptor
不进入 Worker manifest，也不携带 raw rows/prepared batch；manifest 冻结字段保持不变。
`spec.md`/`techdoc.md` 已同步此验证与清理边界，属于原合同的安全澄清，不改变 legacy 业务输出。

此外，Round 1 的四个 P1 已由项目负责 Agent 接受为真实可达：

| Finding | 分类 | 决定 |
| --- | --- | --- |
| staging 中间祖先 symlink 可越界发布/清理 | PROBE → CLOSED | technical、默认 Publisher 前、restart cleanup 共用逐级 `lstat` + `realpath` + inode/alias 的 task-owned validator |
| invalid/outside manifest 可驱动 finally 删除外部文件 | PROBE → CLOSED | 清理只从 Main-owned descriptor 解析且通过归属验证的资源；不再把未验证 manifest 交给通用 disposer |
| detail/balance resource alias 可先后覆盖 | PROBE → CLOSED | request 拒绝 dot/parent，Worker 写入前对完整集合做平台 alias 检查，Main 再做集合 alias 与 kind/order 绑定 |
| 自洽 manifest 可用错误 workbook 冒充业务 artifact | PROBE → CLOSED | Main 按 descriptor 做完整 bounded readback；任一内容/type/format/style/lineage 不符时 Publisher=0 |

最终 blindspot pass 另关闭两个同边界可达缺口：journal Publisher 只白名单接受
`checkpoint/now/randomUUID` test runtime，不允许 `publisherOptions` 覆盖 Main-owned task/artifact/target/
validation 参数；余额 0 输出模板占位行必须为空，禁止在自洽 `rowCounts.output=0` 下夹带业务记录。

### Reviewer Round 2 contract closure

Round 2 的两个 finding 均由项目负责 Agent 裁决为真实可达：header 公式可用正确缓存值绕过原
data-only formula gate；非特殊文本 string→numeric、data font、以及保持 Courier New 10 的
header bold/color 变化均可保持 manifest/hash/业务值摘要自洽。修复沿既有 frozen spec 的
“cell type/format/style 摘要证据”收口，不扩充 Worker manifest，也不改变业务值或 writer 输出。

`MainExpectedArtifactDescriptorV1` 新增定长 `cellContractEvidence`，按正式 grid 顺序摘要每个
header/data cell 的预期 `t/z` 与 legacy writer 真实持久化的 font 语义；header 固定 Courier New 10
且无额外 bold/color，data 使用 writer 的 Calibri 11 默认语义，balance header 的持久 number
format 来自受信模板。既有 header/template lineage validator 继续负责 writer 已冻结的 fill/border，
本轮不把 data alignment/protection、raw XF id、apply flags 或未持久化对象字段升格成新合同。
金额 cell 复用 writer 的 `buildNumericCellValue`，日期格式复用 normalizer，避免复制金额/日期格式
分支。现有 spec/techdoc 已明确要求该摘要 readback，因此本轮无需反向改写合同文本，仅在 notes
记录实现闭环。

### Reviewer Round 3 parser/font closure

Round 3 的两个 P2 均由项目负责 Agent 裁决为真实可达。原 style evidence 固定读取
`xl/worksheets/sheet1.xml`，并以正则扫描整个 XML 的 `<c>` 开标签：workbook relationship 可指向
另一个实际 worksheet part，注释内伪造 cell 可覆盖真实坐标，单引号与属性空白不能按 XML 语义解析，
重复坐标则静默 last-wins。修复通过 workbook sheet 的 relationship id 解析内部 worksheet target，
再用现有 `sax` 依赖只遍历根 `worksheet/sheetData/row/c`。cell coordinate 重复/非法、显式 `s`
不是非负安全整数或不能解析到 `CellXf` 时统一 fail closed；只有完全缺失 `s` 才按 OOXML style 0。

font 摘要只在 normalized/expected 两侧加入 legacy writer 已持久化为 false 的
`outline/shadow/condense/extend` 四个布尔字段。未增加 raw XF id、apply flags、alignment、protection
或其它 style 字段；公式/type/format、token/revision/evidence/single-use、staging/Publisher、manual seed
及 production=false/legacy/0 均保持不变。Round 3 没有改变用户可见行为、数据契约或验收口径，
因此无 spec/techdoc 偏差。

### E09-A/B restack adaptation

新 lineage 将 import authority 冻结为 `sessionOwner + templateCatalog + source.templateRef`，并把
source evidence 拆成带路径/内容身份的 `sourceIdentity` 与资源句柄 `sourceEvidence`。E09-C restack
据此修正两项可达偏差：generation input evidence 的 `resourceId` 必须取
`sourceEvidence.resourceId`；generation 前必须复核 canonical path/file identity/snapshot 与完整
content SHA-256，不能仅比较可被同大小/时间戳替换绕过的 metadata。

同一 filename parent session 可能跨 batch 使用不同 child template，故 session adoption 对
`generationConfigByDigest` 与 `templateEvidenceByDigest` 都做累积保留；新 batch 未再次携带的旧
digest 仍为旧 entry 的唯一 authority。真实 current/all golden 以 A-B-A 输入、A-A-B 输出证明
legacy 的模板首次出现顺序与组内来源顺序；余额按各 child 的银行/所在地、账户、币种和余额合同
生成。任何 entry
digest unknown/missing 都在写 artifact 前 fail closed；没有 owner/最近模板 fallback，也没有把
大状态返回 Main。scope-generation token 继续由同一 token store 原子校验 exact
`kind/scope/inputEvidenceHash` choice 后 single-use consume。

除上述合同澄清外无业务偏差；production policy、manual seed 与 live IPC 范围均不变。

### E09-C Reviewer Round 1 cancellation closure

Reviewer 的唯一 P1 是真实可达时序：同步 generation 已写完 artifacts 并把 success completion 交给
token release 后，shutdown cancel 可以先收到 `cancel:ack`，但旧 release ack 路径仍直接
`finishDone`；同时同步 writer 没有 event-loop safepoint，使 cancel 不能在 detail/balance unit 间被
Worker 观测。修复不改通用 Supervisor，也不新增 cancel authority：generation wrapper 仍串行调用
同一 production helper，每个 artifact unit 后让出一次 event loop 并复用
`job.cancelled/assertJobActive`；Service 只在成功终态交给 Main 前保存 task-private generation paths，
cancel/error 由该唯一 owner 删除全部已规划/已生成 staging。

token reservation/release 仍是原 single-use/retry FSM。若 cancel 在 writer 执行中到达，Worker 先回
`cancel:ack`，wrapper 在 safepoint 抛同一 `STATEMENT_IMPORT_CANCELLED` 并保留首错；若 cancel 在
success completion 已登记、release ack 未到时到达，release ack 的同一 `job.cancelled` gate 拒绝
success、清理 staging 并只发 `job:error`。成功 release ack 则显式把 ownership 交给 Main，文件继续
供 bounded manifest validation 与唯一 Publisher 使用。未增加 startup 扫描/恢复、fallback、第二
Publisher 或第二 `generationConfigByDigest` authority；production 仍 false/legacy/0。

实现后 blindspot pass 还关闭一个由新 safepoint 自身引入的窄窗口：单元内部已完成的 source
currentness 检查发生在 final yield 之前，来源可能在 handoff 窗口漂移。wrapper 因而在最终 manifest
组装前再次复用现有 canonical path/file identity/snapshot/content SHA-256 校验；定向 mutant 在 yield
中替换来源后稳定 `STATEMENT_GENERATION_INPUT_STALE`、manifest=0、staging=0，不新增 evidence 来源。

### E09-C Review Pack remediation（2026-08-30）

独立复审指出重复 `prepare-generation` 仍走 release-first：Service 先把当前已发布
`scope-generation` token 标记 releasing，等待 release-ack 后却没有创建候选 token；这既违反 E09-B
冻结的 candidate-first replacement，也会在 grant reject、adoption timeout/revoke 或跨 purpose
冲突时丢失原 continuation authority。Finding 经远端 head 与冻结 token contract 复核后确认真实可达。

修复只统一入口，不改变 token store/FSM：重复 `prepare-generation` 选择当前 `published` token 并调用
既有 `requestInteractionToken(..., replacementTokenRecord)`；`prepareReplacement` 在任何旧 token release
之前完成 purpose、current、in-flight、数量与预算校验，grant/private insert 期间旧 token 保持
`published`，只有候选 `adopt-ack` 才由 token store 原子替换。grant reject、candidate revoke/adoption
timeout 仅清理候选并恢复旧 token TTL；跨 purpose 直接 fail closed，旧 token 仍可继续 replacement。
没有把 `maxOutstanding=1` 泛化为普通双 token，也没有新增 release/publish authority。

该修复与现有 Spec/TechDoc 的 replacement 合同一致，无需修改冻结合同；production、live IPC、manual
balance seed、Publisher 与资金输出边界均未变化。

### Finalized E09-B release-tip propagation（2026-08-30）

#199 远端旧 head `a913ae51772fa69e5aa6a07c3f3e2376ad2f3e3e` 不包含 #197 最终 head
`290c3a9cdbbeb7fbf424e3d940e4aa3b619a374b`，旧绿色/取消 CI 因而不能替代最终叠栈验证。为保留 PR
历史且禁止强推，传播提交 `4ffea1fda1afcd33cff2dcc16ca75543fc0ee2ef` 使用 exact 双父：第一父是
#199 旧 head，第二父是 #197 最终 head。Git 自动合并无冲突，E09-C generation 树与 candidate-first
replacement 保持可达，同时继承最终 v3.2.2/v3.2.3 与 #197 release lineage。

首次五文件默认并发聚焦矩阵为 78/79：唯一失败是 adoption-timeout 用例在 15 秒 Supervisor 测试
上限处被判为 `transport-lost`；同一用例隔离复跑 1/1、单并发完整矩阵 79/79 均通过。正式单测 runner
同样使用 Node 默认文件并发，因此测试 harness 只允许该精确用例把 execution 上限提高到 30 秒，保留
默认 15 秒给其它用例；生产 Supervisor 超时、20 ms adoption deadline、状态机及断言均未放宽。修复后
默认并发矩阵 79/79，通过扩大后的平台与 Statement 矩阵 452/452。

### Windows Worker shutdown liveness closure（2026-08-30）

#199 在最终 v3.2.3 base 上的 automatic run `33299808535` 没有出现断言失败：lint 与 smoke 已完成，
Windows 单测输出停在第 2387 项，排序上的下一文件为 `statement-generation-e09-c.test.js`；随后进程持续
存活并在 GitHub 六小时上限被取消，build 因而 skipped。本地同一 E09-C 文件 21/21 PASS，结合真实
ServiceHost/Worker 生命周期复核，定位到关闭路径的 event-loop liveness，而不是业务断言或工作簿输出漂移。

ServiceHost 仍按原合同先 `close()` 再等待 `terminate()`，且 terminate 不 settle 时继续返回
`SERVICE_SHUTDOWN_TIMEOUT` 并保留 leak diagnostics。进一步核对 Node 内置 Worker 实现后确认：
`Worker.terminate()` 在等待 `exit` 前会主动 `ref()`，所以只在 `close()` 中幂等 `unref()` 仍会被随后
的 terminate 抵消。Worker adapter 现在保留 close 的首次 unref，并在 close 已发生时于调用
`worker.terminate()` 后再次 unref；若 terminate 先发生、close 后发生，则仍由 close 解除引用。

该动作不终止 Worker、不伪造 cleanup success，仍 await 原 termination Promise，也不缩短资源 revoke/
release 流程或改变 Supervisor 的 timeout、取消及资金输出语义。专门回归同时覆盖两种时序：
`terminate()` 已启动但永不 settle 时后续 close 解除引用，以及 close 后 terminate 内部重新 ref 时立即
再次解除引用；正常 close/terminate、error listener 与资源释放合同继续由平台矩阵覆盖。

### Windows Worker protocol-ack natural-exit candidate（2026-08-31）

后续 exact head `7a16a9dd5cce388747fb5706d65ab8cd032f0fc5` 的 Windows automatic run
`33335790483` 在无断言失败的情况下再次长时停留于同一 release-check 步骤；2026-08-31
10:13 +08:00 查询时已运行超过 5 小时且仍为 `IN_PROGRESS`。第一个 post-terminate
`unref()` 修复只能在 `Worker.terminate()` 同步返回 Promise 后执行；如果 Windows 卡在该方法
内部的同步 `stopThread()`，后续 `unref()` 不可达。

候选修复不对所有 Worker 通用延迟 terminate。Adapter 仅在亲眼观测到
`executor:close-ack`，且 Host 后续已调用 `close()` 时，给 Worker 最多 250 ms 的自然退出
窗口。Statement Service 先 post ack，再在同一 Worker 的 `queueMicrotask` 中关闭 `parentPort`；
若 `exit` 先到则返回真实 exit code，不进入可能同步卡住的强制 terminate。没有 ack
的普通 Worker 仍立即执行原 `Worker.terminate()`；ack 后未退出则宽限耗尽后仍走原
强制路径，Supervisor timeout/leak/error 不会被改写为成功。

该候选当前只保存在隔离 worktree，未推送。必须等待当前 exact Windows run 终态与日志；
只有日志继续证明 Worker 关闭活性卡滞时才能取代远端快照，不用本地推断代偿 Windows CI。

### Node 22 cleanup truth follow-up（2026-08-31）

扩大到官方 Node 22.18 的 ServiceHost/Worker 矩阵后，首版候选暴露两个此前 161 项聚焦集未覆盖的
生命周期盲区。其一，FundRecon、Duplicate 等既有 service worker 会回 `executor:close-ack`，但不关闭
自己的 `parentPort`；Adapter 因而在 250 ms 后仍进入强制 terminate。其二，旧的 post-terminate
`unref()` 会撤销 Node `Worker.terminate()` 为等待真实 exit 建立的引用，使 Node 22 在 cleanup Promise
仍 pending 时耗尽 event loop，`node:test` 以 cancelled 收口；这不是可审计的 cleanup success。

候选现统一 close-ack 的传输语义：Statement、FundRecon、Duplicate 都先同步投递 ack，再在
`queueMicrotask` 关闭各自 `parentPort`；正常 Service 因此在有界 grace 内以真实 exit 完成，不调用
强制 terminate。没有 ack、ack 后未退出或 forced/crash 路径仍调用原 `Worker.terminate()`，但不再在
termination Promise settle 前重复 `unref()`；只有真实 exit 才能完成 cleanup。Supervisor 的 timeout、
leak/error 诊断和资源 revoke/release 次序未放宽，production/资金输出/恢复合同均未改变。

该扩面仍是首版候选的 shutdown-liveness 收口，不改变 E09-C Spec 的业务输入、输出、token、Workbook、
Publisher 或状态机合同；无需反向修改冻结 Spec/TechDoc。v3.2.4 后续新增的 ReconFix Service 也必须在
其 own tranche 采用相同 ack-then-close 语义，并以 Node 22 真实 ServiceHost 测试证明，不能仅靠传播
通用 Adapter 后复用本轮结果。

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| E09-C initial restack lineage | 初始 exact base/merge-base `513620c4a20c32975e4615c968e1381fbdb421c5`；旧 E09-C 四个提交按序 cherry-pick 后适配 E09-A/B 与 token replacement review fix lineage | 初始 review-fix 边界；最终 predecessor 另由下方 release-tip propagation 覆盖 |
| #197 final release-tip propagation | merge `4ffea1fda1afcd33cff2dcc16ca75543fc0ee2ef` exact parents=`a913ae51772fa69e5aa6a07c3f3e2376ad2f3e3e 290c3a9cdbbeb7fbf424e3d940e4aa3b619a374b`；两父 ancestry PASS；merge 无冲突；`git diff --check` PASS | #199 保留 E09-C 历史并完整继承最终 #197/v3.2.3，不复用旧 stack CI、不强推 |
| restack E09-C/A/B/P0 聚焦矩阵 | 60/60 PASS；filename parent multi-template golden 单项 PASS | current/all、child digest authority、filename owner、四金额/币种/余额、A-B-A 输入按 legacy 模板串行分组输出 A-A-B、token/revision/evidence/single-use、Publisher/cleanup |
| E09-C 专项 `node --test ...statement-generation-e09-c.test.js` | 13/13 PASS；其中 filename parent multi-template golden 单项复跑 PASS | 真实 Supervisor/ServiceHost/Worker、临时 XLSX/SQLite、current/all、stale/replay/revision/evidence、Round 1/2/3 findings、tamper、all-or-none、四金额、混币余额、0 输出、partial writer、manual prompt、bounded manifest |
| E09-C cancellation Round 1 专项 | 21/21 PASS；current/all × detail/both 四组、generation 早期 shutdown、success-completion/release-ack 精确竞态均使用真实 Supervisor/ServiceHost/Worker，并含 final-yield source drift mutant | 每组均 `cancel:ack` 先于 `job:error`、Supervisor outcome=`cancelled`、code=`STATEMENT_IMPORT_CANCELLED`、task staging=0；来源漂移 fail closed；正常 current/all/golden 同文件回归通过 |
| Reviewer 后 E09-C/A/B/P0/error-codec 聚焦矩阵 | 98/98 PASS | cancel authority、token single-use/retry、source/template lineage、current/all、四金额/币种/余额/行序/warning、bounded DTO 与 production=false 门禁 |
| Reviewer 后 platform Governor/ServiceHost/Supervisor/recovery/P0 聚焦矩阵 | 245/245 PASS | 未改通用 Supervisor；资源 grant/adopt/revoke/release、shutdown/crash、service generation 与 recovery 合同无回归 |
| 2026-08-30 E09-C replacement remediation | `statement-interactions-e09-b.test.js` 21/21 PASS；`statement-generation-e09-c.test.js` 21/21 PASS；E09-P0/A/B/C 六文件聚焦矩阵 93/93 PASS | duplicate `prepare-generation` candidate-first success、grant reject、adoption timeout/revoke、cross-purpose fail-closed、旧 token continuation；current/all generation 与既有 token/session/resource 合同无回归 |
| final predecessor propagation 聚焦复验 | 默认并发五文件矩阵 79/79 PASS；background-execution + Statement 全链单并发 452/452 PASS；`statement-generation-pipeline.js` 45/45 PASS；`npm run smoke` PASS | 最终 v3.2.2/3.2.3 基座传播后的 Governor/ServiceHost/Supervisor/recovery、candidate-first、current/all、Workbook、金额/币种/余额、Publisher 与 legacy smoke |
| #199 Windows shutdown liveness remediation | automatic run `33299808535`：lint/smoke 完成，Windows 单测输出停在 E09-C 文件前并于 6h 被取消；Node 内置实现证明 `Worker.terminate()` 会先 `ref()`；adapter 回归覆盖 close-before-terminate 与 terminate-before-close 两种时序；修复后完整矩阵见本节后续 evidence | close 已发生时 terminate 内部 ref 会被随后 unref 中和；shutdown timeout/leak 仍为失败证据，不用旧 run 代偿新 head CI |
| #199 post-terminate unref local validation | adapter + ServiceHost + E09-C 93/93 PASS；完整 background-execution + E09-B/C 单并发矩阵 403/403 PASS；`npm run smoke` PASS；变更 JS ESLint、`node --check`、`git diff --check` PASS | 两种 close/terminate 时序、资源 grant/adopt/revoke/release、token replacement、取消、恢复、Workbook 与 legacy smoke 无回归；`check-vars`、`scan:vars`、`release-check` 按用户要求跳过，不声称 PASS |
| #199 protocol-ack natural-exit local candidate | 首版 system Node 与 Electron 36/Node 22.19 聚焦矩阵 161/161 PASS；Node 22 扩面 probe 捕获 pending-cleanup 盲区后，官方 Node 22.18 完整单测 6435/6438 PASS、0 fail、3 expected skip；双 Node 适配器/ServiceHost/Supervisor/FundRecon/Duplicate/E09-C 矩阵均 PASS；Node 22 `npm run smoke` PASS；变更 JS ESLint、`node --check`、`git diff --check` PASS | 正常 Service 先 close-ack 再关闭 `parentPort`，真实自然 exit 不调用强制 terminate；无 ack/未退出仍强制 terminate且保持引用直至真实 settle；不以 event-loop 提前退出伪造 cleanup；真实 Windows 证据仍待 exact run 终态/日志，候选未推送 |
| Round 2/3 自洽 workbook mutations | formula、type/format、font 及其四个扩展布尔、single-quote style、comment spoof、relationship decoy、duplicate coordinate、非法显式 style 全部 Publisher=0 | 实际 worksheet relationship/结构化 cell style、全 grid t/z 与 writer-owned font 摘要 readback；manifest size/hash/rowCounts 均按篡改后文件重算 |
| Reviewer 后 `node scripts/integration/statement-generation-pipeline.js` | 45/45 PASS | legacy generation pipeline、detail/balance/current/all 业务等价 |
| `npm run test:integration` | 51/51 scripts、2455/2455 PASS | 全仓集成、Publisher/cleanup 与资金相关输出回归；runner 自动清单的本地耗时刷新已回退，不纳入 change |
| Reviewer 后 `npm run smoke` | PASS | Excel/账单 I/O、scenario engines、writer 与主业务 smoke 回归 |
| 全量 `npm run test:unit` | 6246 PASS，2 FAIL，3 SKIP（6251 total） | 两个失败均为 `windows-build-contract.test.js` 直接读取隔离 worktree 缺失的 `node_modules/app-builder-lib/templates/nsis/multiUser.nsh`；共享安装为 26.8.1、lockfile 为 26.15.7，属于既有依赖环境漂移，未改依赖掩盖 |
| changed JS ESLint + `node --check` + parent/overall `git diff --check` | PASS | 静态质量与 diff 完整性 |
| `statement-legacy-golden-e09-p0.test.js` 与真实 descriptor readback | current/all、四金额、混合币种/余额、manual prompt、sheet/header/type/style/watermark/template lineage 已冻结且回归通过 | 业务等价与资金输出防冒充基线 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| 真实脱敏资金样本的逐行金额方向、币种、余额与 Excel/WPS 展示 | BLOCK production/release gate | 资金负责人按 current/all、四金额、混合币种、0 输出和余额提示逐项人工复核 | 自动化业务等价不替代人工资损验收；不阻塞 dormant E09-C，阻止 production 启用 |
| Windows packaged durable publication | BLOCK release gate | R3.2.3 人工/packaged 门禁 | 不阻塞 dormant E09-C 合并，production 必须保持 false |
| balance seed durable settlement（含自动派生 seed 的最终 owner） | BLOCK production gate | E09-D/后续合同按 Main-owned settlement 闭环 | E09-C 不允许 Worker 修改共享 seed；不阻塞 dormant 合并，阻止 production 启用 |
| #199 exact Windows natural-exit 证据 | PROBE | 2026-08-31 10:51:56 +08:00 查询仍为 exact head `7a16a9dd5cce388747fb5706d65ab8cd032f0fc5`、run `33335790483` `IN_PROGRESS`；等待终态，若失败/取消则下一独立查询轮下载 exact job log定位最后输出，再裁决是否推送候选 | 当前远端 check pending，不合并、不推送候选；不用旧 head 或本地结果代偿 |
