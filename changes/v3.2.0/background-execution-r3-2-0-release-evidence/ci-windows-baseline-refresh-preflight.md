# PR #174 Windows CI Baseline Refresh Preflight

## Goal

Restore PR #174 Windows CI by incorporating the already reviewed fixes present on
`v3.2.0`, without changing the R3 packaged-canary, benchmark-evidence, or production
enablement contracts.

## Context

- Failed workflow: `32735879695` on head `0ab11a2f0204718ffb75cf45423c1499103c4613`.
- The three directory-fsync failures were already fixed and merged through PR #170.
- The Windows SQLite cleanup `EBUSY` failure was already fixed and merged through PR #173.
- The failed snapshot contained no R3-specific test failure.
- Refreshed workflow `32775513740` passed `smoke-test` but failed the packaged Windows
  build canary with safe code `UNINSTALL_CLEANUP_FAILED`.

## Constraints

- Keep both VCC production actions disabled and in legacy effective mode.
- Do not turn deterministic tests into real Windows or benchmark evidence.
- Do not mutate production policy from benchmark results.
- Preserve all funds, recovery, and durability human-review gates.
- Do not run `check-vars` or `scan:vars` for this repair.

## Done When

- The latest reviewed `v3.2.0` baseline is merged without conflict.
- Inherited-fix tests, R3 targeted tests, and `npm run release-check` pass locally.
- A local contract and blind-spot review finds no R3 behavior or enablement drift.
- The repaired head is pushed and receives a fresh Windows CI run before merge.

## Facts

- The failed Windows run had four failures: three directory-fsync contract failures and
  one SQLite cleanup `EBUSY` failure.
- Retargeting PR #174 to `v3.2.0` did not itself create a new workflow run.
- Merging current `origin/v3.2.0` into the PR branch completed without conflicts.
- R3 production enablement remains off; real packaged Windows and benchmark evidence
  remain `NOT_RUN`.
- electron-builder's assisted NSIS template appends `${APP_FILENAME}` when `/D` does not
  already contain it. The harness supplied a generic `installed` path, then searched that
  parent rather than the actual nested product directory for both the app and uninstaller.
  The repair keeps a fixed owned container, adds the product-name layer explicitly, and
  re-validates the resolved path against the ownership-marked work root.

## Unknowns Register

| Unknown | Class | Resolution | Status |
|---|---|---|---|
| Does the combined baseline introduce a regression in inherited durability or SQLite cleanup behavior? | PROBE | Run both affected targeted suites, then the full release check. | RESOLVED_PASS |
| Does the repaired head trigger a new Windows workflow and pass on the hosted runner? | PROBE | The first refreshed run exposed an R3 harness install-root mismatch; the local fix is complete and requires a fresh hosted Windows run. | FIXED_LOCAL_PENDING_CI |
| Does using the exact product-name directory prevent assisted NSIS from appending a second directory level? | PROBE | Lock the installed electron-builder template behavior and harness path in the Windows build contract test. | RESOLVED_LOCAL_PASS |
| Do real packaged Windows Setup and portable binaries satisfy the canary contract? | BLOCK | Production-only gate: collect actual R3 evidence on the approved disposable Windows runner. | NOT_RUN |
| Are funds, receipt atomicity, recovery, and durability red-line reviews approved? | BLOCK | Production-only gate: keep the existing human-review gates unchanged. | PENDING_HUMAN_REVIEW |

## Risk-Ordered Plan

1. Merge the reviewed `v3.2.0` baseline into the isolated PR worktree.
2. Run the two inherited-fix suites and the R3-specific targeted suites.
3. Run `npm run release-check` and discard its generated timing-only policy refresh.
4. Review the resulting diff for production, evidence, recovery, and funds-contract drift.
5. Align the harness install root with assisted NSIS `${APP_FILENAME}` semantics and run
   the Windows contract tests plus the full release check.
6. Push the repaired head and wait for fresh Windows CI before merge.

## Local Verification

- Windows build contract test: `4/4 PASS`.
- `npm run release-check`: `PASS` (`lint` and `smoke` PASS; unit `6013/6014`
  with `0` failures and `1` skipped; integration `51/51` scripts and
  `2455/2455` assertions PASS).
- Generated integration timing-table changes were discarded; no policy content changed.
