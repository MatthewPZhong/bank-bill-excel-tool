# E09-D Unknowns Preflight

## Task Brief

- Goal: implement the dormant `statement:resolve-manual-balance` Main-owned atomic settlement, target-post-image Inspector and startup recovery seam without changing the legacy balance-seed business format.
- Context: E09-P0/A/B/C already freeze Statement DTO/token/session/generation authorities; E09-D adds the file mutation and recovery authority only.
- Constraints: exact base `fa86c9297fffbc4727b22dc55188101a413a3ae1`; no E10 work; no second intent/receipt/Inspector/Publisher/config authority; `production.enabled=false`, `legacy`, worker count `0`; no `release-check`, `check-vars`, or `scan:vars`; funds/recovery remain human-gated.
- Done when: ordinal/operation identity is persistent and replay-safe; no-op avoids intent; non-noop uses Main-owned prepared/acked Intent plus same-directory temp write/fsync/rename/directory-fsync and post-image inspection; pre/post/neither and durability-unavailable outcomes are fail-closed; startup can enumerate the open target-post-image source; legacy JSON golden and critical fault matrix pass.

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| legacy seed format is a sorted UTF-8 JSON array with Chinese `生成方式` and trailing newline | `src/backend/balance-seed-store.js` `writeBalanceSeedRecords` plus E09-P0 fixture | atomic writer must reuse the same normalizer/serializer, not invent a schema |
| current IPC writes synchronously before regeneration | `src/main.js` `file:save-balance-seed` and `writeManualBalanceSeedPlan` | dormant E09-D module must not silently switch production while policy remains false/legacy |
| target-post-image open sources are derived from open Main-owned intents | `startup-recovery-coordinator.js` and C2 recovery tests | intent evidence must be sufficient for the canonical Inspector and source discovery |
| generic recovery writes require reserved exact requests and short control transactions | recovery control request-owner/repository tests | E09-D coordinator must compose the existing repositories, not write control tables directly |
| Statement token/reservation/continuation has one authority, but service does not yet execute manual settlement | `statement-worker/token-store.js`, `waiting-user-coordinator.js`, `service.js` | E09-D accepts exact continuation identity as input; it must not create another token/lock/lease implementation |
| `balance-seeds` is lazily created while `ensureStorageRoot` only creates its parent | `getBalanceSeedFilePath`, `ensureStorageRoot`, legacy writer | first target creation needs a parent-directory entry barrier owned by the same atomic writer |
| multiple raw bank names may sanitize to the same target filename | `sanitizeFileName`/`getBalanceSeedFilePath` | target alias and conflict scope must derive from the canonical target basename, not raw bank text |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| legacy serializer can be factored without byte drift | known unknown | high | easy | current writer is inline | PROBE | byte-for-byte golden test before/after | extract one shared normalizer/serializer |
| host directory fsync support and errno | platform unknown | high | medium | canonical helper classifies supported/unsupported | PROBE | injected fault matrix plus packaged Windows gate later | unsupported never becomes committed; retain open intent and Hold; new target directory also fsyncs the storage-root parent entry |
| archive task metadata CAS shape for ordinal allocation | known unknown | high | easy | TaskRun identity and metadata exist in `archive_task_runs` | PROBE | in-memory DatabaseSync concurrent/replay tests | allocate under `BEGIN IMMEDIATE` with exact TaskRun identity |
| startup provider continuation can regenerate an in-memory Statement session | known unknown | medium | medium | spec explicitly says session is not restored | ASSUME | recovery test proves seed is not repeated and requires re-import | provider closes committed seed settlement but does not recreate session |
| live production routing should switch in E09-D | contract question resolved by spec | high | hard | release strategy says legacy until gate and canonical policy says false/legacy/0 | ASSUME | policy/static contract test | keep new path dormant and injectable; do not change IPC routing |
| generic startup transition planner can accept manual sources | known unknown | medium | easy | `preFundMptRecoveryPlanTransitions` returns `[]` for non-MPT actions | PROBE | exact manual startup recovery test | add only the manual action binding over generic RecoverySourceV1 transitions; keep RecoveryControl as the sole authority |
| same operation with a different post-image can replay an old intent identity | known unknown | high | easy | transition request identity is command + intentId | PROBE | exact retry vs changed-post test | inspect the deterministic operation Intent and exact binding before any target mutation; exact replay is stable, mismatch fails closed |

## Reviewer Round 1 Unknowns Closure

| 未知 | 结论 | 动态证据 |
| --- | --- | --- |
| post-image 是否足以证明跨启动 durability | 否；只接受 canonical observation 中持久的 barrier 完成事实。无事实或有 durability Hold 时保持 unknown/open | post-without-event、unsupported/error、重复 startup fault tests |
| closed/recovered operation 是否可在无 mutation 下重放 | 是；先按 operationKey 查 Intent 并验证完整 binding，exact 返回稳定结果，different post fail closed | committed/recovered replay + conflict test |
| no-op 是否可以跳过 request/token gate | 否；read-only request-owner conflict 与 awaited preCommit 都先执行，但 no-op 不创建 Intent | async stale/orphan request test |
| A/B/A token 如何处理 | 持久完整 history；A(current) 可复用，B 新增 ordinal，历史 A 重放拒绝 stale；损坏/重复 metadata fail closed | ordinal history/corruption tests |
| 跨平台同一物理文件 scope | 物理 legacy basename 可逆保存；scope 另走仓库 target identity。Darwin 由实盘 probe 支持 NFC/NFD、大小写与 expansion fold；Windows 已存在目标取 realpath，缺失 segment 逐 code point 只接受单 code-point uppercase，不做 NFC/NFD，expansion mapping fail closed | Darwin physical-alias probe + Windows É/é、NFD、ß lexical identity tests |
| live Inspector 如何避免第二 authority | canonical attempt 可恢复；observation event 与所有 transition 在同一 RecoveryControl 事务提交，startup 重放同一状态机 | reply loss / pre-observation crash / repeated startup tests |
| settlement 如何证明业务输入同源 | 先冻结 legacy preflight plan snapshot，再校验 bank/records/account/currency/date/balance，commit-time materialize `updatedAt` 并复用 legacy serializer | plan tamper/async mutation/bank mismatch/byte golden tests |

## Reviewer Round 2 Unknowns Closure

| 未知 | 结论 | 动态证据 |
| --- | --- | --- |
| active Hold 是否可能在 prepared 前被绕过 | 否；canonical RecoveryHoldGate 是构造必需依赖，并在 awaited admission 后及 `create-prepared` 前对 exact scope 再检查 | missing-gate、active durability Hold、final-check fault tests |
| legacy plan 在等待期间是否仍代表当前 records | 只有 canonical freshness gate 完成 continuation 检查、target identity 校验、records evidence 重读与 target 双快照后才接受；并发新增记录使旧 plan fail closed | stale-plan record-conservation test |
| awaited admission 后的 no-op/pre-image 是否可信 | 不直接复用旧 snapshot；重新读取 target 并与 freshness evidence 做 CAS，漂移时在 no-op/Intent 前失败 | async no-op drift test |
| Hold reservation 与 control transaction 间崩溃如何恢复 | live/startup 共享同一 Hold request/transition/safe payload；startup 恢复原 prepared request 并原子提交 observation+Hold | reservation-crash + double-startup idempotency test |
| Windows legacy 名称能否用 Unicode full fold 写回 | 不能；真实路径保留可逆 legacy basename。缺失 NTFS 目标没有可移植 upcase-table API，只接受不扩展的 per-code-point uppercase；NFC/NFD 不归一，ß/SS 等 expansion 不猜 scope 而直接阻断 | Windows É/é same-key、NFD distinct、ß fail-closed test + Darwin inode probe |

## Reviewer Round 3 Unknowns Closure

| 未知 | 结论 | 动态证据 |
| --- | --- | --- |
| Windows 缺失目标的非 ASCII simple case 是否会漏同一 scope | 不会；É/é 与 σ/ς 逐 code point uppercase 后共享 identity，且路径分隔结构保持不变 | missing-target É/é + staging containment adjacent tests |
| simple case 是否会误做 Unicode normalization 或 expansion fold | 不会；NFC/NFD 保持不同 identity；ß、ligature 等多 code-point uppercase 在确证 missing segment 时抛 `TARGET_IDENTITY_WINDOWS_CASE_MAPPING_UNSAFE` | NFD distinct、ß/SS fail-closed、existing-realpath authority tests |
| unsafe identity 能否绕到 Hold/Intent 或文件写入 | 不能；scope 构造前即抛有界错误，不调用 Hold gate，不创建 RecoveryControl/Intent/target | manual settlement Hold-bypass-unreachable regression |
| `updatedAt` 是否代表真实 commit attempt | 是；所有 awaited admission、Hold 和最终 pre-image 检查完成后才取时钟，并由同一 materialized bytes 同时绑定 Intent/post-image | delayed-clock ordering test |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | factor and golden-lock seed bytes/snapshots | business format/amount/currency/account/date | byte equality and legacy unit tests | stops all further work | revert factor only |
| 2 | implement ordinal allocator and exact operation identity | each prompt unique; replay same token | ordinal/replay/concurrency tests | invalidates settlement identity | keep module dormant |
| 3 | implement Inspector and atomic replace primitive | pre/post/neither and persisted durability barrier | injected file/startup fault matrix | blocks coordinator | module-only rollback |
| 4 | compose Main-owned Intent coordinator | single intent authority/no Worker handshake | transition trace and crash points | blocks managed path | retain legacy routing |
| 5 | register startup inspector/provider seam | committed seed not repeated; unknown held | startup recovery tests | production remains false | omit registration until fixed |
| 6 | run cross-version and blindspot checks | no regression/hidden bypass | E09-P0/A/B/C, C2, smoke/static | do not mark local-ready | focused fix only |
