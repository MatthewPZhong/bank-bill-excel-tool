# E09-D Implementation Notes

## Baseline

- Goal/spec: v3.2.3 Spec §7/7.1 and TechDoc §7/8/10/11.
- Initial plan: shared legacy serializer -> persistent ordinal -> atomic writer/Inspector -> Main-owned coordinator -> startup recovery registration -> fault/golden/regression tests.
- Done when: see `preflight.md`; no production enablement and no change to funds/recovery human gates.

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| factor the legacy JSON serializer and make both legacy and atomic paths consume it | byte identity is a funds invariant | duplicate E09-D serializer | one business format authority |
| E09-D settlement receives the existing TaskRun/token continuation identity | E09-B already owns token/reservation/lock/lease | a second token or operation registry | no parallel interaction authority |
| keep production routing legacy in this PR | frozen policy is `false/legacy/0`; Windows packaged durability is still a release gate | silently switching `file:save-balance-seed` | dormant path can be reviewed/tested without live behavior drift |
| derive intentId from operationKey and bind the exact request hash to alias/pre/post/revision/token evidence | same-operation replay must be idempotent only for the same post-image | random intent IDs or a second operation ledger | exact retry reaches byte no-op; changed post-image conflicts before mutation |
| canonicalize target alias to the sanitized target basename | two raw bank names can resolve to one file | conflict scope from raw bank text | one physical seed target has one alias/scope |
| persist a newly created `balance-seeds` directory entry before target mutation | production storage root exists but its seed child is lazy | assuming target directory is pre-provisioned | parent fsync unsupported is terminal/held before target write |
| bind manual recovery planning to the generic RecoverySourceV1 transition vocabulary | pre-fund's action map cannot resolve a manual Hold, while RecoveryControl already owns the atomic observation/transition transaction | a second manual transition repository or ad-hoc close | one control authority; manual source only supplies the frozen action binding |
| persist durability completion as a canonical observation before closing Intent | visible post bytes do not prove directory-entry durability after restart | infer committed from target hash alone | startup closes only when the canonical event proves the barrier; otherwise Hold remains stable |
| validate persisted request ownership and await the continuation gate before no-op | no-op is still a replay of an operation identity and stale continuation must not bypass admission | returning on equal bytes before identity/token checks | rejection performs no Intent or target mutation |
| persist complete token-to-ordinal history | a single current token cannot distinguish A/B/A stale replay from a current retry | silently allocating the old token a new ordinal | current retry reuses; new token increments; historical token fails closed |
| commit Inspector observation event and all recovery transitions in one RecoveryControl transaction | a crash between observation and Intent/Hold transition creates a second incomplete state | a live-only in-memory Inspector result | the prepared canonical attempt is resumable; its event and state transitions commit atomically |
| accept only the validated legacy manual seed plan and materialize `updatedAt` at commit | independent alias/records inputs can splice unrelated business evidence | arbitrary target alias plus record array | bank/records/account/currency/date/balance stay bound to one preflight plan and legacy bytes |
| require canonical Hold and plan-freshness gates, then repeat exact-scope/pre-image checks after every await | construction-time optional callbacks and stale snapshots can bypass current recovery/business state | caller-supplied `preCommitCheck` or one early Hold lookup | stale Hold/plan/target fail before no-op, Intent or mutation |
| share one Hold request builder and resume the exact persisted prepared request at startup | reservation can survive a crash before the control transaction | regenerate a similar request or create a live-only Hold | requestKey/transition/safe payload and Hold lifecycle are identical live/startup |
| keep the legacy target basename reversible and separate it from lock/scope identity | Unicode normalization/folding is platform-volume identity, not a safe physical filename transform | writing NFC/full-fold keys back as Windows legacy paths | bytes go to the original legacy name; scope uses realpath/probed platform rules |
| obtain commit `updatedAt` only after awaited admission and final target CAS | an early timestamp describes prompt/admission time, not the write attempt | materialize bytes before async gates | Intent evidence and file bytes share the same commit-attempt timestamp |
| align toolbox NFC/NFD assertions with the existing platform identity contract | exact Windows CI completed the unit suite and showed four tests still expected Darwin/Linux collision semantics on Windows | globally normalizing production targets or skipping the Windows cases | Windows exercises distinct prepare/publish/reservation cleanup; Darwin/Linux keep fail-closed collision behavior |
| resolve historical v3.2.2 base-anchor facts only from the frozen reviewed Git blob | the current startup wiring legitimately adds Manual Balance recovery while the signed snapshot still describes the reviewed v3.2.2 base | re-signing the snapshot or accepting arbitrary current-file drift | base anchors remain immutable historical evidence; evidence catalog and all other current-file checks remain strict |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| startup recovery may close a committed seed intent without restoring session only when persisted durability evidence exists | Spec says in-memory session is not restored and user re-imports | UI needs a separate continuation feature | recovery returns bounded `sessionReimportRequired`; post bytes without the persisted barrier stay unknown/held and never rewrite seed |
| the caller keeps the existing E09-B business lock/PhaseLease across the canonical freshness gate, prepared/acked, write and inspection | E09-D receives but does not recreate continuation authority | stale target/token race if caller violates contract | fail-closed plan evidence and final pre-image CAS remain additional guards; live routing stays disabled |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| rely on the target-directory fsync after rename | first creation also fsyncs the parent directory entry | `balance-seeds` is lazily created | stronger durability; no public contract change | contract already requires durable target post-image |
| raw bank alias | reversible sanitized legacy basename is encoded in the alias; conflict scope separately uses repository target identity (Darwin realpath/full fold; Windows existing-target realpath or strict single-code-point uppercase for missing segments) | identity keys are not safe physical filenames, and missing NTFS targets expose no portable Unicode upcase table | preserves exact legacy path, coalesces É/é, keeps NFC/NFD distinct and rejects expansion scope guesses | no; implementation detail only |
| the first cancelled Windows log was treated as a lower bound on failures | the new exact #202 job completed unit and exposed four additional platform assertions plus three historical-anchor failures | assuming the earlier six failures exhausted the suite | no production contract change; local and new exact Windows validation now cover the completed failure set | no; validation scope correction only |
| run the final local suite against the dependency versions frozen by this branch | the #202 worktree intentionally has no install, while the main worktree has older `electron-builder` inputs than this branch lock; a clean downstream worktree provides the exact `26.15.7` tree | treating missing modules or `26.8.1` NSIS template differences as product failures | temporary dependency link is removed after each command; acceptance uses only the lock-matching run | no; validation harness correction only |

## Reviewer Round 1 Findings

| Finding | Closure | Regression evidence |
| --- | --- | --- |
| durability completion was not restart-proof | canonical observation persists `durabilityBarrierCompleted`; startup requires it, and durability Hold/source survives repeated scans | unsupported/error, post-without-event, repeated-startup tests |
| closed/recovered replay could reach mutation first | operation-key lookup validates exact plan/job/scope/session/token/ordinal and returns the stable decision before any write; mismatch conflicts | committed/recovered replay and changed-post conflict test |
| no-op could bypass persisted request/pre-commit gates | read-only request-owner inspection and awaited `preCommitCheck` precede byte no-op, while no-op still creates no Intent | async stale gate + orphan request-owner test |
| ordinal stored only current token | strict versioned history validates complete monotonic one-to-one mappings; A/B/A fails stale | history replay/corruption tests |
| target scope could drift by OS/path spelling | shared target identity authority resolves existing targets; Darwin uses measured full fold, while missing Windows segments use strict non-expanding Unicode uppercase without normalization | Darwin physical-alias + Windows É/é/NFD/ß tests |
| live Inspector could leave split recovery state | canonical observation attempt is resumable; its event plus Intent/Hold transitions commit atomically in RecoveryControl | reply-loss, observation crash boundary and startup idempotency tests |
| settlement accepted independently supplied alias/records | only an immutable snapshot of the validated legacy plan is accepted and hash-bound; commit-time timestamp uses the legacy materializer/serializer | plan tamper, async admission mutation, bank mismatch and byte-golden test |

## Reviewer Round 2 Findings

| Finding | Closure | Regression evidence |
| --- | --- | --- |
| Hold dependency/final admission could be bypassed | coordinator requires canonical RecoveryHoldGate and checks exact scope before admission, after await, and immediately before prepared | missing gate, active durability Hold and final-check rejection tests |
| stale plan could delete a concurrently added record | canonical freshness gate rebinds plan provenance, re-reads legacy records and target snapshot after continuation admission, and requires exact evidence equality | async stale-plan record-conservation test |
| awaited admission could return a false no-op or mutate stale pre-image | target is re-read after all awaited admission and compared to canonical freshness snapshot before timestamp/no-op/Intent | async no-op drift test |
| Hold reservation crash could diverge live/startup lifecycle | one shared Hold request builder plus exact prepared-request resume keeps requestKey/transition/payload stable; observation and Hold commit atomically | reservation-to-control crash followed by two startup scans |
| Unicode identity could rewrite or merge distinct Windows legacy names | physical alias encodes exact sanitized legacy basename; Darwin uses measured physical folding; missing Windows targets accept only single-code-point uppercase and reject expansion | Windows É/é same scope, NFD distinct, ß fail-closed and Darwin same-inode alias tests |
| `updatedAt` was available before final admission | clock/materialization moved after awaited freshness, Hold and final pre-image checks; one materialization feeds Intent and post bytes | delayed-clock ordering and byte-equality test |

## Reviewer Round 3 Findings

| Finding | Closure | Regression evidence |
| --- | --- | --- |
| Windows missing-target identity missed non-ASCII simple case pairs | per-code-point uppercase accepts only exactly one mapped code point, preserving path separators and existing staging containment semantics | É/é and σ/ς identity equality plus adjacent staging tests |
| Windows expansion mapping could be guessed or mismerged | confirmed missing segments throw a bounded path-free `TargetIdentityError`; NFC/NFD remain distinct; existing targets continue through realpath and preserve expansion code points | NFD distinct, ß/SS missing fail-closed, existing-realpath and Hold-bypass tests |

## Final predecessor propagation（2026-08-30）

PR #202 的旧 head `b54943c45ee898ffdac7e8dd17012e3d52e57db8` 仍以旧 #199 head
`a913ae51772fa69e5aa6a07c3f3e2376ad2f3e3e` 为第二父，因而不包含最终 E09-C head
`c014b9ee637c333639984418c31c468d2f88f460`。本地 final restack 使用 no-ff merge 保留
#202 历史；exact parents 为旧 #202 head 与最终 #199 head，不复用旧 stack 的绿色 CI。

唯一冲突位于 `initializeBackgroundExecutionRecovery()` 的 registry 注册段。Manual Balance 与
Duplicate Startup 的 inspector/provider key 均不同，且二者都必须在各自 registry freeze 前注册；
因此合并同时保留两条恢复链，而不是选择任一侧。新增 wiring 回归显式要求 manual/duplicate 两个
inspector 与两个 provider 均先于 freeze，防止后续传播再次静默删除任一恢复 authority。此次传播不改
金额、币种、行序、Workbook、seed serializer、operation identity、Hold 生命周期或 production policy；
资金与恢复人工复核门禁继续保留。

## Exact Windows CI portability closure（2026-09-01）

最终 v3.2.2 祖先传播后的 #202 exact job `99548182180` checkout head 为
`62c96c2276b23108dab98ef8a20e41e124f9f5f9`。日志确认 lint/smoke 完成，unit 明确暴露三类
#202-owned 测试可移植性错误：wiring source probe 用 LF 字面量匹配 Windows CRLF；Darwin physical
alias 用例在 Windows 文件系统上伪装 `platform: 'darwin'`；legacy path 期望硬编码 POSIX 分隔符。
这些失败都发生在测试证据层，不支持修改 production recovery、identity、serializer 或资金门禁。

修复只统一 source probe 的行尾、只在真实 Darwin 执行 physical alias 回放，并用 `path.join` 构造
host path 期望。纯函数层的 Darwin/Windows identity 断言、Windows unsafe expansion fail-closed、
Hold/Intent/write 零副作用继续在所有主机执行。#202 引入的 target identity 明确是 Darwin/Linux NFC、
Windows 不做 NFC/NFD；因此继承的 E09-C Unicode alias 测试只在 Windows 期待 distinct，不能按初始
自动化假设把 Linux 也改为 distinct。#199 的 deterministic cleanup 先以 no-ff merge 传播，当前修复
不改 `src`、workflow timeout 或 production policy。

## Exact Windows CI completed-unit closure（2026-09-01）

#202 exact job `99702298285` checkout head 为
`74c6e55aede1f34c2adbddb76e1f0d5c8c4f2752`。lint 与 smoke 完成；unit 完整结束为
`6463/6472`、7 fail、2 skip、0 cancelled，随后 exit 1，integration 未启动。四项失败是 toolbox
multi-split/output-publication 对 Windows NFC/NFD 仍期待 collision；另三项来自 v3.2.2 base anchor
继续读取已被后续版本合法扩展的 current startup wiring。日志证明本轮不是 timeout/cancellation，也不支持
修改 production target identity、workflow timeout、snapshot hash、资金或恢复门禁。

修复保持 Windows 缺失目标逐 code point simple-uppercase 且 NFC/NFD distinct，Darwin/Linux 仍按现有
NFC 规则 collision。Windows 成功分支必须实际发布所有 prepared task，并验证 target、journal/index、
temporary file 与 reservation 全部收尾。历史 validator 只让 `baseAnchors` 从冻结 reviewed Git blob
提取 ordered facts；`evidenceCatalog` 仍要求 current canonical file 与 reviewed blob 精确一致，snapshot
不重签。integration 是否还有后续失败必须由新 exact Windows CI 验证。

本地完整 unit 的验收使用与该分支 lock 一致的 `electron-builder/app-builder-lib 26.15.7` 依赖树。
一次完整运行中未改动的 E05-B Writer transport 用例出现单次时序失败；它在此前两次完整运行中通过，
随后同名用例连续 `5/5` 通过，最终完整运行也通过，因此不为本轮 test-only 修复扩张到无关生产或
E05-B 代码。缺失 worktree 依赖及主工作区旧版 NSIS 模板产生的两次 harness 结果不计入验收。

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| final #199 → #202 propagation 与双恢复链 wiring | exact parents=`b54943c45ee898ffdac7e8dd17012e3d52e57db8 c014b9ee637c333639984418c31c468d2f88f460`；E09-D + Duplicate startup/wiring + E09-B + Recovery C2 定向矩阵 `106/106 PASS`；`node --check src/main.js` 与 `git diff --check` PASS | Manual Balance/Duplicate Startup inspector/provider 同时注册并在 freeze 前可达；Hold、幂等、candidate-first token、启动恢复与 production=false 无回归 |
| exact #202 Windows cancelled job | job `99548182180`：lint/smoke 完成，unit 至少六项失败且 integration 未启动；#202-owned failures 精确落在 CRLF source probe、Darwin physical alias 回放、host path literal，以及该 PR 新 identity 合同下继承的两项 E09-C Unicode 断言 | 修复保持 production bytes、target identity、恢复与资金合同不变；新 exact Windows CI 仍必须完整验证 test 2440 后续范围 |
| 2026-09-01 #199 cleanup propagation 与 #202 portability 本地验证 | cleanup merge exact parents=`62c96c2276b23108dab98ef8a20e41e124f9f5f9 85de7a25514bdf419481ba05190c570a41b19c69`；Electron 36 / Node 22.19 的 wiring + E09-D + E09-C + target identity 矩阵 61/61 PASS；内存 CRLF structural probe 2/2、Win32 Unicode distinct probe 2/2、Win32 host path probe 1/1 PASS；三个变更测试文件 `node --check` 与 `git diff --check` PASS | 旧 #199 为祖先；平台测试修正不改 src/bytes/identity/恢复门禁；伪平台探针不替代真实 Windows CI |
| exact #202 completed-unit Windows failure log | job `99702298285`：checkout=`74c6e55aede1f34c2adbddb76e1f0d5c8c4f2752`；lint/smoke 成功，unit=`6463/6472`、7 fail、2 skip、0 cancelled，integration 未启动；四项 Unicode test-only 失败与三项 frozen base-anchor 失败已逐项定位 | 穷尽该 exact unit 的已执行失败；不以旧绿或本地绿替代修复后的新 Windows unit/integration |
| completed-unit closure 本地验证 | 官方 Node 22.18 定向七文件 `159/159`；changed JS `node --check` 与 `git diff --check`；锁定依赖完整 unit=`6470/6473`、0 fail、3 Windows-only skip、0 cancelled，日志=`logs/unit-tests/unit-20260901-101112.log`；`check:packaged-inputs` PASS；lint exit 0 | 四项 Windows success/cleanup、Darwin/Linux fail-closed、frozen base-anchor 与既有 evidence/privacy gates 同时覆盖；真实 Windows unit/integration 仍必须由新 exact CI 验证 |
| Reviewer Round 1 `manual-balance-seed-settlement-e09-d.test.js` baseline | 24/24 PASS | serializer golden, strict ordinal history, exact replay/conflict, no-op gate order, Main intent trace, durability persistence, canonical observation, immutable plan binding, OS target identity |
| E09-D + E09-C/B/A/P0 + RecoveryControl/startup/preflight focused suite | 225/225 PASS | Statement service/token/session/generation/legacy plus RecoverySourceV1, Hold, target-post-image startup, FilePlan and target-identity invariants |
| Reviewer Round 2 exact regressions | 34/34 PASS | Hold bypass, stale-plan conservation, async no-op drift, reservation crash/double startup, Windows physical names, delayed clock |
| Reviewer Round 3 Windows identity regressions (folded into existing test cases) | 34/34 PASS | É/é same scope, NFC/NFD distinct, ß/SS missing fail-closed, existing realpath, no Hold/Intent/write bypass |
| Round 3 E09-D + E09-C/B/A/P0 + recovery/archive/identity matrix | 227/227 PASS | manual seed end-to-end state machine, adjacent Statement authorities and startup recovery |
| Additional recovery/pre-fund matrix | 113/113 PASS | request-owner resume, RecoveryControl and unchanged pre-fund recovery paths |
| `npm run smoke` | PASS | repository-wide integration smoke |
| `npm run test:integration` | 51/51 scripts, 2455/2455 assertions PASS | recovery control, statement generation pipeline and repository-wide integration; generated timing table restored after evidence capture |
| `npm run test:unit` | 6296 pass / 1 unrelated failure / 3 skipped (6300 total) | all E09-D and adjacent tests pass; `windows-build-contract` rejects the installed electron-builder NSIS template's `System::Store` and has no changed-file overlap |
| `node --check` (all changed JS) + `git diff --check` | PASS | static syntax and patch hygiene |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| packaged Windows directory fsync capability | PROBE | R3.2.3 Windows packaged probe + human review | production remains disabled until proven |
| packaged Windows NTFS Unicode case identity for missing targets | PROBE | use actual packaged target volume; until then only single-code-point uppercase is accepted and expansion fails closed | production remains disabled; no Unicode normalization/full-fold filename rewrite |
| exact Windows unit after completed-unit corrections | PROBE | 完成 #202 本地验证与严格下游传播后，等待新 exact Windows CI 验证四项 success/cleanup 分支和 frozen base-anchor 兼容 | 新 exact CI 全绿前不合并，不以本地或旧绿色代偿 |
| exact Windows integration after unit succeeds | PROBE | job `99702298285` 因 unit exit 1 未启动 integration；只由修复后的新 exact Windows CI 继续验证 | integration 未成功前不合并 |
| funds semantics and recovery holds | BLOCK | release owner/manual review | must not enable production automatically |
