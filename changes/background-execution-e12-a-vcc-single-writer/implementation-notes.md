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

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| E12-A 允许单 Writer 读全量 subjects。 | §7.2 明确将 subject filter 下推放在 E12-B，禁止场景是多 Writer 重复全量读取。 | 若要求 E12-A 已下推，将超出 PR 边界。 | 测试断言 Worker 实例=1；E12-B 独立实现 query。 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| preflight 初始假设 E12-A 只实现 `export-subjects` | 同一 core 同时实现 `export-subjects` + `export-single` exact-one specialization | 项目 owner 明确冻结 Action 范围要求两者均属 E12-A | 增加第二 canonical policy/entry/validator 与单主体 golden；不扩大到 E12-B/C | 是（本记录与 preflight 已反向同步） |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Preflight 合同/代码取证 | 无 BLOCK；4 个高影响未知进入 PROBE | ownership、authority/TOCTOU、bounded DTO、cleanup。 |
| E12-A focused unit | 15/15 PASS | 两 action policy exact、production false、一个 Writer topology、全主体/exact-one golden、bounded DTO、task/run/archive A/B、Join 前后 TOCTOU、manual recovery preserve、forced-shutdown tmp cleanup、extension parity、cancel/crash/Publisher 0/1、shutdown clean。 |
| 既有 writer/service/recovery + policy/binding regression | 80/80 PASS | legacy writer、Service ownership、durable Publisher、policy registry/action binding 未回归。 |
| Toolbox publication worker regression | 10/10 PASS | `requireValidatedArtifacts` 的发布前与 copy 后 identity 校验、transport recovery、manual preserve 跨线程传播未回归。 |
| Supervisor + VCC archive/lineage/audit/result-write regression | 83/83 PASS | lease/transport/shutdown、archive identity、adjustment lineage、结果写 claim 未回归。 |
| E11-C/package/task-policy regression | 46/46 PASS | 上一阶段 ReconFix export、packaged runtime、TaskPolicy inventory 未回归。 |
| VCC integration chains | 19/19、29/29、226/226、77/77 PASS | effective result、历史模板、调整/跨月 archive、破坏性状态链。 |
| Smoke + static checks | `npm run smoke` PASS；ESLint、`node --check`、`git diff --check` PASS | 全局 smoke 与本轮 JS/差异静态质量门禁。 |
| E11-C restack interaction | E11-C focused cancellation/cleanup 15/15 PASS；VCC focused 15/15 PASS；既有 VCC writer/service/archive/recovery 87/87 PASS | ReconFix 与 VCC 各自保留单一 cleanup owner；取消后 staging 清零、同 staging 重试和 Publisher 0/1 不漂移。 |
| Platform/Publisher affected regression | Supervisor、ResourceGovernor、policy/action binding、packaged runtime、TaskPolicy、Publisher 共 243/243 PASS | 新 VCC policy/entry 注册未覆盖 E11-C，transport/lease/journal recovery 不回归。 |
| Recovery canary | background recovery canary 9/9、recovery control 27/27、pure-compute canary 9/9 PASS | 恢复状态、人工保留和静态 production gate 保持既有语义。 |

## Round1 Findings And Fixes

| Finding | 最小修复 | 可达证据 |
| --- | --- | --- |
| P1 Join→Publisher identity 未绑定 | dispatch 把 Join 的 `byteSize/sha256` 传为 expected；VCC wrapper 重读 generation 后 exact 比对，并把 expected 作为 `requireValidatedArtifacts=true` 的 identity 交给既有 Publisher。 | 第三次 authority read 回调在 Join 后篡改 generation；wrapper 在调用 Publisher 前以 `VCC_OUTPUT_GENERATION_CHANGED_AFTER_JOIN` 拒绝，Publisher=0、普通 cleanup 完成。 |
| P1 manual recovery 被 catch 清理 | 仅当 `preserveTemporaryFiles === true` 时跳过全部 cleanup；可信 generation paths 优先与既有 `recoveryPaths` 去重合并，最多 100 项。 | Publisher 抛 manual-recovery fixture 后 generation、atomic tmp、未知 task-private 文件均保留；recoveryPaths 含 generation + journal、无重复且有界。 |
| P2 forced shutdown 遗留 atomic tmp | 普通失败扫描 generation 同目录，只删除 exact generation path 及严格 `${generation}.<uuid>.tmp`；不递归、不删除 lookalike/未知文件；cleanup failure 仅附最多 8 条无资金内容的 error-code 诊断。 | shutdown-timeout 等价 deterministic seam 生成 partial generation、合法 UUID tmp、lookalike tmp、未知文件；前两者删除，后两者保留，Publisher=0。 |
| P2 extension parity | canonical FilePlan 在 Worker 前按 lower-case extension 仅接受 `.xlsx`，与 legacy `assertXlsxOutputPath` 一致。 | `.XLSX` 两路径接受；`.csv` 两路径拒绝，Worker=0、Publisher=0。 |

## Blindspot Pass

| 维度 | 证据型结论 | 处置 |
| --- | --- | --- |
| 入口与旁路 | managed dispatcher 尚未接入 live Main；legacy handler 仍是唯一 production 路径。 | 符合 dormant/production-false 边界；禁止在 E12-A 偷接 live。 |
| 数据合同 | Worker input/result exact keys；Main 绑定 DB/assets；DTO 只有 run/task/digest/count/path authority，不含 subject 文本、金额或币种原始行。 | validator、finance-safe allowlist 与 <8 KiB 实测闭合。 |
| 状态生命周期 | task authority 与 run/archive authority 在 generation 前、Join 后、Publisher 前复核；Worker 在 read transaction 内首尾复核。 | B 点变化均 fail closed，Publisher=0。 |
| 失败模式 | 普通失败删除 exact generation 及严格同源 UUID atomic tmp；manual recovery 明示 preserve 时全部保留并返回 generation recovery paths；不自动 retry Publisher。 | focused fault tests 覆盖 pre-cancel、between-subject cancel、crash partial、Join 前后 tamper、Publisher throw/preserve。 |
| 并发/幂等 | `export-subjects` compound topology 恒为 1；subjectIndex exact set/order；FilePlan fresh target snapshot；一次 journal publication。 | 不引入 shard、第二 Writer 或自动二次发布。 |
| 可观测性 | runtime 继续用 `finance-safe-v1`；protocol error/result 受现有 maxBytes/rate-limit/validator 管控。 | 不新增 raw finance diagnostics；production enable 另行收集门禁证据。 |
| 测试缺口 | 自动测试无法证明 Windows packaged Worker、Excel/WPS 渲染及真实资金样本人工逐项等价。 | 保留为不可绕过的人工 production gate。 |
| Restack 交互 | E11-C 的 `activeExportPlan`/terminal cleanup 仅属于 ReconFix；VCC 的 generation cleanup 仍由 VCC Writer + Main dispatch owning catch 完成，两个 action 不共享 generation paths 或 Publisher。 | 代码边界与双 focused 回归已覆盖；未引入跨模块 cleanup fallback。 |

## Reconciliation Blindspot Pass

| 核对面 | 证据与结论 |
| --- | --- |
| 主键/血缘 | runId + targetMonth + resultRevision + inputFingerprint + archiveStateDigest + subjectIndex 构成 authority；subject/business digest 和 adjustment defined names 在 Main 回读。 |
| 金额/币种/差异 | 未改计算规则；managed 与 legacy 使用同一 `buildSubjectRowPlan/buildPendingSheet/writeRunWorkbooks`；结果金额/币种/difference fill 与 Pending 完整 projection 回读。 |
| 时间边界 | 只接受 exact archived run/month，archive evidence 必须唯一且非 inconsistent；跨月 integration 226/226 PASS。 |
| 幂等/重复 | generation 仅写 task-private exact paths；Join identity 贯穿 wrapper 与既有 Publisher 二次校验；碰撞 fail closed；Publisher 无自动重试且成功仅一次。 |
| 行数/输出守恒 | `export-subjects` 必须 0..N-1 全覆盖，`export-single` exact-one；result/Pending row count 与 subject authority 一致，golden 保留文件/Sheet/主体顺序。 |
| 部分失败 | Join 前无正式目标写入；普通失败清理 generation/同源 atomic tmp 且 Publisher=0；人工恢复错误保留全部证据；正式发布仍由既有 durable journal 统一处理。 |

⚠️ 资金红线：该改动触及 VCC 金额、币种、差异、Pending、revision/archive 与输出血缘的执行边界。自动 golden/回读只能证明测试样本合同；真实资金样本逐主体金额/币种/差异/行数人工复核，以及 Windows Excel/WPS/packaged Worker 人工门禁必须保留，完成前不得启用 production。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| A/B authority 与 task-private path 故障矩阵是否全部 fail closed | 已闭合 | focused tests：task/run/archive B、tamper、cancel/crash、Publisher 0/1 | 无 |
| 真实资金样本和 Windows Excel/WPS 样式等价 | BLOCK（production enable 门禁） | 资金/发布负责人人工复核 | 不阻断 dormant PR；未完成不得 production enable |
