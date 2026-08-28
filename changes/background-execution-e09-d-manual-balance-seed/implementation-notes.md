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
| keep pre-fund recovery planning as a no-op for manual sources | the existing planner explicitly returns `[]` outside its action map while generic startup transitions already settle target-post-image | a manual-specific transition map | one RecoverySourceV1/control authority |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| startup recovery may close committed seed intent without restoring session | Spec says in-memory session is not restored and user re-imports | UI needs a separate continuation feature | recovery returns bounded `sessionReimportRequired`; never rewrites seed |
| the caller keeps the existing E09-B business lock/PhaseLease across `preCommitCheck`, prepared/acked, write and inspection | E09-D receives but does not recreate continuation authority | stale target/token race if caller violates contract | fail-closed pre-image CAS remains a second guard; live routing stays disabled |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| rely on the target-directory fsync after rename | first creation also fsyncs the parent directory entry | `balance-seeds` is lazily created | stronger durability; no public contract change | contract already requires durable target post-image |
| raw bank alias | canonical sanitized target alias | raw names can collide at one target file | fixes lock/Hold scope identity | no; implementation detail only |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `manual-balance-seed-settlement-e09-d.test.js` | 18/18 PASS | serializer golden, ordinal/replay/corrupt metadata, exact identity, no-op, Main intent trace, temp/rename/parent+target fsync/Inspector failures, startup, hold/token gate |
| E09-D + E09-C/B/A/P0 + recovery/preflight/preview focused suite | 176/176 PASS | Statement service/token/session/generation/legacy plus RecoverySourceV1, Hold, target-post-image startup and FilePlan invariants |
| `npm run smoke` | PASS | repository-wide integration smoke |
| `npm run test:integration` | 51/51 scripts, 2455/2455 assertions PASS | recovery control, statement generation pipeline and repository-wide integration; generated timing table restored after evidence capture |
| `node -c` (`main.js`, settlement module) + `git diff --check` | PASS | static syntax and patch hygiene |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| packaged Windows directory fsync capability | PROBE | R3.2.3 Windows packaged probe + human review | production remains disabled until proven |
| funds semantics and recovery holds | BLOCK | release owner/manual review | must not enable production automatically |
