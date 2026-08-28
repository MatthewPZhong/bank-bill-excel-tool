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

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| startup recovery may close a committed seed intent without restoring session only when persisted durability evidence exists | Spec says in-memory session is not restored and user re-imports | UI needs a separate continuation feature | recovery returns bounded `sessionReimportRequired`; post bytes without the persisted barrier stay unknown/held and never rewrite seed |
| the caller keeps the existing E09-B business lock/PhaseLease across `preCommitCheck`, prepared/acked, write and inspection | E09-D receives but does not recreate continuation authority | stale target/token race if caller violates contract | fail-closed pre-image CAS remains a second guard; live routing stays disabled |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| rely on the target-directory fsync after rename | first creation also fsyncs the parent directory entry | `balance-seeds` is lazily created | stronger durability; no public contract change | contract already requires durable target post-image |
| raw bank alias | repository canonical target identity (sanitized basename + NFC/full case-fold + real existing ancestor) | raw names and Darwin/Windows path spellings can resolve to one target file | fixes lock/Hold scope identity without a second path authority | no; implementation detail only |

## Reviewer Round 1 Findings

| Finding | Closure | Regression evidence |
| --- | --- | --- |
| durability completion was not restart-proof | canonical observation persists `durabilityBarrierCompleted`; startup requires it, and durability Hold/source survives repeated scans | unsupported/error, post-without-event, repeated-startup tests |
| closed/recovered replay could reach mutation first | operation-key lookup validates exact plan/job/scope/session/token/ordinal and returns the stable decision before any write; mismatch conflicts | committed/recovered replay and changed-post conflict test |
| no-op could bypass persisted request/pre-commit gates | read-only request-owner inspection and awaited `preCommitCheck` precede byte no-op, while no-op still creates no Intent | async stale gate + orphan request-owner test |
| ordinal stored only current token | strict versioned history validates complete monotonic one-to-one mappings; A/B/A fails stale | history replay/corruption tests |
| target scope could drift by OS/path spelling | shared target identity authority resolves existing ancestors and applies platform canonicalization | Darwin/Windows NFC/full-fold + physical-path test |
| live Inspector could leave split recovery state | canonical observation attempt is resumable; its event plus Intent/Hold transitions commit atomically in RecoveryControl | reply-loss, observation crash boundary and startup idempotency tests |
| settlement accepted independently supplied alias/records | only an immutable snapshot of the validated legacy plan is accepted and hash-bound; commit-time timestamp uses the legacy materializer/serializer | plan tamper, async admission mutation, bank mismatch and byte-golden test |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `manual-balance-seed-settlement-e09-d.test.js` | 24/24 PASS | serializer golden, strict ordinal history, exact replay/conflict, no-op gate order, Main intent trace, durability persistence, canonical observation, immutable plan binding, OS target identity |
| E09-D + E09-C/B/A/P0 + RecoveryControl/startup/preflight focused suite | 225/225 PASS | Statement service/token/session/generation/legacy plus RecoverySourceV1, Hold, target-post-image startup, FilePlan and target-identity invariants |
| `npm run smoke` | PASS | repository-wide integration smoke |
| `npm run test:integration` | 51/51 scripts, 2455/2455 assertions PASS | recovery control, statement generation pipeline and repository-wide integration; generated timing table restored after evidence capture |
| `npm run test:unit` | 6290 pass / 1 unrelated failure / 3 skipped (6294 total) | all E09-D and adjacent tests pass; `windows-build-contract` rejects the installed electron-builder NSIS template's `System::Store` and has no changed-file overlap |
| `node --check` (all changed JS) + `git diff --check` | PASS | static syntax and patch hygiene |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| packaged Windows directory fsync capability | PROBE | R3.2.3 Windows packaged probe + human review | production remains disabled until proven |
| funds semantics and recovery holds | BLOCK | release owner/manual review | must not enable production automatically |
