# R3.2.0 Release Evidence — Implementation Notes

## Baseline

- Branch: `codex/v3.2.0-r3-release-evidence`
- Baseline commit: `143477c2`
- Scope: isolated packaged canary, Windows packaged harness, and offline VCC parser benchmark evidence only.
- Production enablement remains unchanged.

## Decisions

- The packaged canary is an explicit, isolated startup mode that exits before normal application initialization, window creation, user database access, and business IPC registration.
- Canary state is confined to a private temporary directory and temporary SQLite databases.
- Canary output is bounded, machine-readable, and contains no paths, filenames, or user data.
- `vcc-op:scan-and-compute` remains `production.enabled=false`,
  `production.effectiveMode=legacy`, and effective worker count `1`.
- `vcc-op:save-run` remains `production.enabled=false`,
  `production.effectiveMode=legacy`, and effective worker count `0`.
- Parser concurrency above one is evidence-only. No benchmark result mutates either action policy.
- The Windows Setup canary is restricted to a GitHub-hosted disposable Windows runner. It
  refuses to install when the exact manifest product identity already exists in HKCU/HKLM
  uninstall entries or the current/common Start Menu, and verifies the same identity is absent
  after uninstall without deleting or repairing any external installation.
- VCC parser measurement uses one uncounted full parse/reduce/private-save warm-up per
  `(fileCount, requestedWorkerCount)` combination. Counted runs rotate worker order
  deterministically by scenario and run so later workers do not receive a systematic cache advantage.
- Benchmark JSON is always emitted to stdout. Optional `--evidence-file` publication is
  same-directory, exclusive, atomic, and refuses to overwrite an existing file.

## Assumptions

- Packaged execution must prove that the application is running from `app.asar`; source-tree execution must fail closed.
- Windows Setup and portable evidence is valid only when each actual packaged executable independently returns a valid canary report.

## Deviations

- None recorded.

## Evidence

- Real Windows Setup canary: `NOT_RUN`
- Real Windows portable canary: `NOT_RUN`
- Real VCC offline benchmark: `NOT_RUN`
- Exact Main owner association and receipt/run/files atomicity sign-off: `PENDING_HUMAN_REVIEW`
- VCC amount/direction/month/currency/begin-end conservation sign-off: `PENDING_HUMAN_REVIEW`
- Windows crash durability and directory-fsync sign-off: `PENDING_HUMAN_REVIEW`
- Packaged request/runner targeted unit tests: `9/9 PASS`.
- Main startup authority/single-instance adjacent tests: `23/23 PASS`.
- Windows harness/check-dist targeted unit tests: `18/18 PASS`.
- VCC parser benchmark deterministic unit tests: `10/10 PASS`.
- Targeted ESLint for changed JavaScript: `PASS`.
- Final `npm run release-check`: `PASS` (`lint` and `smoke` PASS; unit
  `6013/6014 PASS` with `0` failures and `1` skipped; integration `51/51`
  scripts and `2455/2455` assertions PASS).

### Benchmark timing definitions

- `e2eMs`: wall time from parser-unit construction through parse, ordered reduce, and
  private AppDatabase save transaction.
- `parseWallMs`: wall time from dispatching the scenario's parser workers until all
  parser results settle.
- `parseCumulativeWorkerMs`: sum of each unit's dispatch-to-result wall time. This is
  cumulative worker occupancy evidence and is not labelled as elapsed wall time.
- `reduceWallMs`: main-thread ordered reducer wall time.
- `saveWallMs`: private AppDatabase save transaction wall time.
- `peakRssMiB`: sampled process RSS peak at a 10 ms interval; Worker threads share the process.
- `eventLoopDelayMaxMs`: maximum main event-loop delay observed for the measured sample.

The real benchmark remains `NOT_RUN`; deterministic tests validate scheduling, report
privacy, medians, and eligibility logic only and are not performance evidence.

## Enablement Blocks

- E03-A JSZip whole-archive buffer memory coverage.
- E03-A terminate-rejection handling.
- E03-A pre-allocation byte budget.
- C2 critical-intent lifecycle.
- C2 provider enablement.
- C2 Recovery Hold lifecycle and gates.
- C2 recovery-lock/exact-scope ownership.
- E03-B Inspector, critical source, provider, and Recovery Hold are not registered or wired into
  the product-start recovery registry/Hold seam. Product-start recovery and same-month conflict
  gating therefore remain unavailable.

## Remaining Unknowns

- Real silent-installed Windows Setup executable behavior has not been measured.
- Real Windows portable executable behavior has not been measured.
- Packaged Windows directory-fsync behavior has not been evidenced.
- Parser concurrency eligibility has not been evaluated with the required complete benchmark matrix.
