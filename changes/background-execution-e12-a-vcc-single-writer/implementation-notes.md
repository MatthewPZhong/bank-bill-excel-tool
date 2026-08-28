# v3.2.4 E12-A Implementation Notes

## Baseline

- Goal/spec：冻结 v3.2.4 Spec §7.1/§9，TechDoc §9-§14，Platform Contract v1。
- Initial plan：[preflight.md](./preflight.md)。
- Restack parent：已审查 E11-C `771572ff3b7b4f623eafd2a8c44c34038f2a6b98`；旧 E12-A 两笔提交按原顺序重放，无文本冲突。
- Done when：production-false dormant single Writer 在 task/run/archive/FilePlan exact authority 下生成 legacy-equivalent 全主体 artifacts，Main 深度 Join 后 Publisher 一次或零次。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| E12-A 用同一 one-shot Writer core 实现 `export-subjects` 和 `export-single`；前者 thread-pool topology 固定一个 child/Writer，后者 thread-single 且 exact-one subjectIndex。 | 项目 owner 对冻结 Action 范围的显式裁决；Spec §3 同时列出两 action。 | 只实现 `export-subjects`；改写 canonical mode；提前做双 Writer。 | 两 action 共享生成/回读/Publisher 不变量；E12-B/C 仍独立。 |
| Worker 从 Main 绑定的 read-only DB 路径自读业务数据，协议只传 bounded authority/subject/path。 | 冻结 TechDoc Worker input；无 raw finance rows DTO 要求。 | Main 把 effective rows/Pending 数组传入 Worker。 | 协议边界不暴露金额明细；DB/assets path 不接受 caller override。 |
| 业务生成复用现有 `writeRunWorkbooks`/template validator，只增加 exact generation paths、cancel safe point 和 Join 证据。 | 金额/币种/样式/lineage 零漂移要求。 | 在新 Writer 重写 Excel 生成。 | legacy 和 managed 共享同一业务 core。 |
| 一次现有 `publishVccFinancialOpOutputs` 是唯一正式发布边界。 | 现有 wrapper 已使用 durable journal、target snapshot 与 source size/hash。 | Writer rename 到正式目标；新建 VCC Publisher/receipt。 | 任一 generation/Join 失败 Publisher=0；全集成功后仅一次调用。 |
| Main dispatch 是 E12-A generation/task-dir 的唯一 cleanup/recovery owner；atomic writer 只拥有当前 UUID tmp。 | committed Publisher 后 cleanup 失败不能改写业务成功，也不能由 recovery wrapper 与 dispatch 双删；既有 Main owner 已能做 exact-path、严格 UUID tmp 与 task-dir 收口。 | Worker finally 删除 generation；wrapper 吞错删除；新增第二 cleanup/recovery service。 | publication 结果附带有界 `generationCleanup` evidence；pending cleanup 不触发二次 Publisher，原 task dir 未收口前同 operation retry fail closed。 |
| Main 创建 task dir 后冻结 exact staging identity，并随 exact Worker input 传递；Worker 入口、逐主体写入前、atomic handoff 前复用一个 checker。 | 关闭 Main create 与 Worker 使用之间可复现的目录替换窗口，同时保留单一路径 authority。 | 仅靠字符串 containment；每个阶段各写一套校验；引入 native/openat。 | 已发生的 replacement 在外部写入前 fail closed、Publisher=0；不声称消除校验后的 OS 纳秒级竞态。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| E12-A 允许单 Writer 读全量 subjects。 | §7.2 明确将 subject filter 下推放在 E12-B，禁止场景是多 Writer 重复全量读取。 | 若要求 E12-A 已下推，将超出 PR 边界。 | 测试断言 Worker 实例=1；E12-B 独立实现 query。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| preflight 初始假设 E12-A 只实现 `export-subjects` | 同一 core 同时实现 `export-subjects` + `export-single` exact-one specialization | 项目 owner 明确冻结 Action 范围要求两者均属 E12-A | 增加第二 canonical policy/entry/validator 与单主体 golden；不扩大到 E12-B/C | 是（本记录与 preflight 已反向同步） |
| 原 Reviewer 完成扩展场景前连续受到平台安全分类器阻断 | 替补 Reviewer 完成全量结论后亦在扩展场景受阻；Round4 改由新的独立 Ultra Reviewer 做全 diff 复核 | 保留独立 review 且不把工具阻断误判为代码结论 | 仅是 review 流程偏差；Round4 两项 finding 均由 owner 接受并以动态复现闭合 | 不适用 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Preflight 合同/代码取证 | 无 BLOCK；4 个高影响未知进入 PROBE | ownership、authority/TOCTOU、bounded DTO、cleanup。 |
| E12-A focused unit | 17/17 PASS | 两 action policy exact、production false、一个 Writer topology、全主体/exact-one golden、bounded DTO、task/run/archive A/B、Join 前后 TOCTOU、manual recovery preserve、普通 cleanup 残留 recovery、forced-shutdown tmp cleanup、raw styleId tamper、extension parity、cancel/crash/Publisher 0/1、shutdown clean。 |
| 既有 writer/service/recovery + policy/binding regression | 80/80 PASS | legacy writer、Service ownership、durable Publisher、policy registry/action binding 未回归。 |
| Toolbox publication worker regression | 10/10 PASS | `requireValidatedArtifacts` 的发布前与 copy 后 identity 校验、transport recovery、manual preserve 跨线程传播未回归。 |
| Supervisor + VCC archive/lineage/audit/result-write regression | 83/83 PASS | lease/transport/shutdown、archive identity、adjustment lineage、结果写 claim 未回归。 |
| E11-C/package/task-policy regression | 46/46 PASS | 上一阶段 ReconFix export、packaged runtime、TaskPolicy inventory 未回归。 |
| VCC integration chains | 19/19、29/29、226/226、77/77 PASS | effective result、历史模板、调整/跨月 archive、破坏性状态链。 |
| Smoke + static checks | `npm run smoke` PASS；ESLint、`node --check`、`git diff --check` PASS | 全局 smoke 与本轮 JS/差异静态质量门禁。 |
| E11-C restack interaction | E11-C focused cancellation/cleanup 15/15 PASS；E12-A focused 17/17 PASS；既有 VCC writer/service/archive/recovery 87/87 PASS | ReconFix 与 VCC 各自保留单一 cleanup owner；取消后 staging 清零、残留 recovery、同 staging 重试和 Publisher 0/1 不漂移。 |
| Platform/Publisher affected regression | Supervisor、ResourceGovernor、policy/action binding、packaged runtime、TaskPolicy、Publisher 共 243/243 PASS | 新 VCC policy/entry 注册未覆盖 E11-C，transport/lease/journal recovery 不回归。 |
| Recovery canary | background recovery canary 9/9、recovery control 27/27、pure-compute canary 9/9 PASS | 恢复状态、人工保留和静态 production gate 保持既有语义。 |
| Restack Review Round2 focused | E12-A 27/27（含 7 个 raw OOXML 子案例）、writer 16/16 PASS | exact task staging/recovery、样式/布局语义矩阵、正常/调整/merge golden。 |
| Restack Review Round2 affected VCC | archive/result/template/read/Service/Writer 共 148/148 PASS | revision/archive、调整 lineage、历史模板、durable publication 与 Main Join 未回归。 |
| Restack Review Round2 E11-C interaction | ReconFix export 15/15 PASS | E11-C export plan closure 与 E12-A exact task directory 各自保持唯一 cleanup owner；同 staging retry、symlink/collision、Publisher 0/1 不互相覆盖。 |
| Restack Review Round2 platform/Publisher | Supervisor/Governor/policy/binding/packaged/recovery/toolbox generation/Publisher 共 320/320 PASS | 单一 cleanup/Publisher authority、transport/lease、journal recovery 与 task inventory 未漂移。 |
| Restack Review Round2 integration/smoke | VCC 19/19、29/29、226/226、77/77；recovery 9/9、27/27、pure 9/9；smoke PASS | 正常/历史/调整/破坏性链、recovery canary 与全局 smoke。 |
| Independent Review Round4 focused | E12-A 34/34 PASS；writer/recovery 19/19 PASS | committed 后 generation `EBUSY/EPERM`、task-dir `rmdir` 失败、bounded pending evidence、retry collision/owner 收口；before-worker/before-handoff replacement、外部同名文件不触碰、Windows-compatible 正常路径零残留。 |
| Independent Review Round4 affected VCC | 全 VCC 单元矩阵 549/549 PASS | amount/currency/style/order/revision/archive、Writer/Join/Publisher 与历史回归未漂移。 |
| Independent Review Round4 platform/recovery | E11-C/background runtime/policy/toolbox Publisher 共 529/529 PASS；recovery control 27/27、pure 9/9、recovery canary 9/9 PASS | 单一 cleanup/Publisher authority、transport/lease/journal recovery、E11-C cleanup/runtime 交互未漂移。 |
| Independent Review Round4 integration/smoke | VCC 19/19、29/29、226/226、77/77 PASS；`npm run smoke` PASS | 正常/历史/调整/破坏性资金链及全局 smoke。 |

## Round1 Findings And Fixes

| Finding | 最小修复 | 可达证据 |
| --- | --- | --- |
| P1 Join→Publisher identity 未绑定 | dispatch 把 Join 的 `byteSize/sha256` 传为 expected；VCC wrapper 重读 generation 后 exact 比对，并把 expected 作为 `requireValidatedArtifacts=true` 的 identity 交给既有 Publisher。 | 第三次 authority read 回调在 Join 后篡改 generation；wrapper 在调用 Publisher 前以 `VCC_OUTPUT_GENERATION_CHANGED_AFTER_JOIN` 拒绝，Publisher=0、普通 cleanup 完成。 |
| P1 manual recovery 被 catch 清理 | 仅当 `preserveTemporaryFiles === true` 时跳过全部 cleanup；可信 generation paths 优先与既有 `recoveryPaths` 去重合并，最多 100 项。 | Publisher 抛 manual-recovery fixture 后 generation、atomic tmp、未知 task-private 文件均保留；recoveryPaths 含 generation + journal、无重复且有界。 |
| P2 forced shutdown 遗留 atomic tmp | 普通失败扫描 generation 同目录，只删除 exact generation path 及严格 `${generation}.<uuid>.tmp`；不递归、不删除 lookalike/未知文件；cleanup failure 仅附最多 8 条无资金内容的 error-code 诊断。 | shutdown-timeout 等价 deterministic seam 生成 partial generation、合法 UUID tmp、lookalike tmp、未知文件；前两者删除，后两者保留，Publisher=0。 |
| P2 extension parity | canonical FilePlan 在 Worker 前按 lower-case extension 仅接受 `.xlsx`，与 legacy `assertXlsxOutputPath` 一致。 | `.XLSX` 两路径接受；`.csv` 两路径拒绝，Worker=0、Publisher=0。 |

## Restack Review Round1 Findings And Fixes

| Finding | Owner triage / 最小修复 | 可达证据 |
| --- | --- | --- |
| P2 普通 pre-Publisher cleanup 部分失败只写诊断、没有结构化残留恢复证据 | 接受。扩展现有 Main cleanup owner：删除后只对 task-private containment 内确实仍可 `lstat` 的候选设置 `preserveTemporaryFiles + recoveryPaths`；去重、有界，首错不变；不新增 cleanup/Publisher/inspector。 | 动态同时注入 staging scan `EACCES` 与第二 generation `EBUSY`：第一文件已删、第二文件确实残留，recoveryPaths 只含第二文件；原 code/message 保留；同 staging retry 在 Worker 前以 collision 拒绝；Publisher=0。 |
| P2 普通分类单元格 style 可在重算 size/hash 后绕过 Main Join | 接受。在 canonical `validateResultSheet` 对所有未合并分类格复用模板 anchor full style 校验；Writer staged self-check 与 Main artifact readback 已共同调用该 validator，不在 Join 新建第二套 style authority。 | Writer staged validator 的普通分类 fill fault 被拒；raw XLSX XML 修改 `C3 styleId`、重新压缩并重算 artifact size/hash 后，Main Join 仍失败且 Publisher=0；正常 golden 继续通过。 |
| blocking P3 toolbox runtime exact inventory 未同步新 E12-A policies | 接受。只把 `export-single`/`export-subjects` 及各自 exact resource vector 加入既有 inventory 断言。 | `toolbox-background-generation.test.js` 10/10 PASS；没有加入 subject query、shard planner 或 second Writer。 |

## Restack Review Round2 Findings And Fixes

| Finding | Owner triage / 最小修复 | 可达证据 |
| --- | --- | --- |
| P2 共享 staging root 在 `readdir` 失败时会被误当为当前任务的 recoveryPath，且 exact 子目录 identity 未绑定 | 接受。共享 root 仅作为父 authority；从 action、operationKey、task authority、run authorityDigest、subjectIndex set 与 canonical FilePlan 派生直属 `vcc-export-<digest>` 子目录，绑定 parent realpath 与 exact child realpath。现有 Main cleanup owner 只处理该目录中的 exact generations/严格 UUID tmp；scan 失败只返回目录级 exact task path，已知残留仍返回具体路径；Join/cleanup 都复核 root 未被 symlink/reparse 替换。不新增 scanner、cleanup、recovery 或 Publisher authority。 | 真实 FS `chmod 0300` 令 `readdir=EACCES`、已知 generation 可删、严格 UUID tmp 留存：首错保留、Publisher=0、recoveryPaths 唯一为 task dir，caller shared root 未暴露；恢复 `0700` 后同 cleanup owner 扫描并清空，retry 到达 Writer 无 collision。另覆盖 EBUSY 部分残留、parent symlink/非规范 path/exact child reparse 拒绝，以及 runtime 后 reparse 不删除外部同名文件。 |
| P2 canonical Result validator 未形成闭合的模板样式/布局语义矩阵 | 接受。仍由唯一 `validateResultSheet` 覆盖 header A:N；body A 与 B:C merge master/follower、D:L、普通空白 M/N、调整 target/M/N；动态 font/numFmt/wrap/height 例外；全部 row/column hidden/outline/width/height。币种表头 D:L 继续按结构样式 + 动态差异 fill 分层，避免误杀合法 normal/abnormal fill；不比较 OOXML styleId，不在 Main 新建第二套样式逻辑。 | Writer self-check/Main Join 均复用该 validator。正常单/多主体 merge golden、调整/long reason golden 通过；raw OOXML 自洽篡改 C1/A2/C3/M3/N3、row hidden、column hidden 并重算 size/hash 均在 Main Join 阻断且 Publisher=0。 |

## Independent Review Round4 Findings And Fixes

| Finding | Owner triage / 最小修复 | 可达证据 |
| --- | --- | --- |
| P2 committed Publisher 后 generation/task-dir cleanup 错误被吞，成功返回无 pending cleanup 证据 | 接受。E12-A 调用现有 wrapper 时显式 defer generation cleanup，由既有 Main cleanup owner 在 publication committed/manifest handoff 后唯一收口；不改变正式目标与首个 publication 结果。owner 返回有界、finance-safe 的 `generationCleanup` status/recoveryPaths/diagnosticCodes/task-root digest；exact task dir 未清空前，确定性名称使同 operation retry 在 Worker 前 collision。legacy wrapper 默认行为不变。 | 动态注入 generation `EBUSY`、`EPERM` 与空 task dir `rmdir EPERM`：正式目标只成功一次、Publisher=1、结果为 committed 且 `generationCleanup=pending`，只暴露确知 task-private path；同 operation retry Publisher=0/Worker=0；恢复权限后同一 owner 可收净并正常重试。正常 success 为 `complete` 且 task dir 零残留。 |
| P2 Main 创建 task dir 后、Worker 开始或 atomic handoff 前的目录替换窗口没有绑定同一 identity | 接受。Main 将 resolved/real path、task dir device/inode、parent path 与 canonical digest 冻结成 exact Worker input；唯一 checker 在 Worker entry、每个 subject write 前及 atomic rename/handoff 前验证 parent/root real directory、root identity、generation direct child/no alias、strict UUID tmp identity。identity error 只保留原 task-private recovery evidence，不删除替换目录或外部同名文件。 | before-worker replacement 与 before-finalize replacement 均 Publisher=0；外部同名 generation/tmp 保持原内容，原 task dir 的 UUID tmp 作为可恢复证据保留；恢复正确 identity 后同 cleanup owner 可收口。Unicode/空格及 Windows-compatible 路径正常成功、Publisher=1、零残留。 |

## Blindspot Pass

| 维度 | 证据型结论 | 处置 |
| --- | --- | --- |
| 入口与旁路 | managed dispatcher 尚未接入 live Main；legacy handler 仍是唯一 production 路径。 | 符合 dormant/production-false 边界；禁止在 E12-A 偷接 live。 |
| 数据合同 | Worker input/result exact keys；Main 绑定 DB/assets；DTO 只有 run/task/digest/count/path authority，不含 subject 文本、金额或币种原始行。 | validator、finance-safe allowlist 与 <8 KiB 实测闭合。 |
| 状态生命周期 | task authority 与 run/archive authority 在 generation 前、Join 后、Publisher 前复核；Worker 在 read transaction 内首尾复核。 | B 点变化均 fail closed，Publisher=0。 |
| 失败模式 | Main 是 generation/task-dir 唯一 cleanup owner；普通失败删除 exact generation 及严格同源 UUID atomic tmp，manual recovery 明示 preserve 时全部保留；committed 后 cleanup 失败只返回 pending evidence，不把业务成功重解释为可重发失败。 | focused fault tests 覆盖 pre-cancel、between-subject cancel、crash partial、Join 前后 tamper、Publisher throw/preserve、committed cleanup EBUSY/EPERM/rmdir failure。 |
| 并发/幂等 | `export-subjects` compound topology 恒为 1；subjectIndex exact set/order；FilePlan fresh target snapshot；一次 journal publication。 | 不引入 shard、第二 Writer 或自动二次发布。 |
| 可观测性 | runtime 继续用 `finance-safe-v1`；protocol error/result 受现有 maxBytes/rate-limit/validator 管控。 | 不新增 raw finance diagnostics；production enable 另行收集门禁证据。 |
| 测试缺口 | 自动测试无法证明 Windows packaged Worker、Excel/WPS 渲染及真实资金样本人工逐项等价。 | 保留为不可绕过的人工 production gate。 |
| Restack 交互 | E11-C 的 `activeExportPlan`/terminal cleanup 仅属于 ReconFix；VCC generation/task-dir 只由 VCC Main dispatch owner 收口，atomic writer 仅拥有当前 UUID tmp；两个 action 不共享 generation paths 或 Publisher。 | E11-C/platform/VCC 回归覆盖；recovery wrapper 在 E12-A defer，不与 dispatch 双删，未引入跨模块 cleanup fallback。 |

## Reconciliation Blindspot Pass

| 核对面 | 证据与结论 |
| --- | --- |
| 主键/血缘 | runId + targetMonth + resultRevision + inputFingerprint + archiveStateDigest + subjectIndex 构成 authority；subject/business digest 和 adjustment defined names 在 Main 回读。 |
| 金额/币种/差异 | 未改计算规则；managed 与 legacy 使用同一 `buildSubjectRowPlan/buildPendingSheet/writeRunWorkbooks`；结果金额/币种/difference fill 与 Pending 完整 projection 回读。 |
| 时间边界 | 只接受 exact archived run/month，archive evidence 必须唯一且非 inconsistent；跨月 integration 226/226 PASS。 |
| 幂等/重复 | generation 仅写冻结 identity 下的 task-private exact paths；Join identity 贯穿 wrapper 与既有 Publisher 二次校验；未清 task dir 的同 operation retry collision fail closed；Publisher 无自动重试且成功仅一次。 |
| 行数/输出守恒 | `export-subjects` 必须 0..N-1 全覆盖，`export-single` exact-one；result/Pending row count 与 subject authority 一致，golden 保留文件/Sheet/主体顺序。 |
| 部分失败 | Join 前无正式目标写入；普通失败由 Main owner 清理 generation/同源 atomic tmp 且 Publisher=0；人工恢复错误保留证据；正式发布仍由既有 durable journal 统一处理；committed 后 cleanup pending 不改变正式目标成功事实。 |

⚠️ 资金红线：该改动触及 VCC 金额、币种、差异、Pending、revision/archive 与输出血缘的执行边界。自动 golden/回读只能证明测试样本合同；真实资金样本逐主体金额/币种/差异/行数人工复核，以及 Windows Excel/WPS/packaged Worker 人工门禁必须保留，完成前不得启用 production。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| A/B authority 与 task-private path 故障矩阵是否全部 fail closed | 已闭合 | focused tests：task/run/archive B、tamper、cancel/crash、Publisher 0/1 | 无 |
| task-root identity checker 后仍存在的 OS 纳秒级替换竞态 | 已知边界（production gate） | 本 PR 关闭可复现的 before-worker/before-handoff 已变化窗口；不引入 native/openat 句柄语义 | 不阻断 dormant PR；Windows packaged/恢复演练人工确认 |
| 真实资金样本和 Windows Excel/WPS 样式等价 | BLOCK（production enable 门禁） | 资金/发布负责人人工复核 | 不阻断 dormant PR；未完成不得 production enable |
