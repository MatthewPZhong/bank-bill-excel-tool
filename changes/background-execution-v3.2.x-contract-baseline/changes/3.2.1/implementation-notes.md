# v3.2.1 E04-A Implementation Notes

## Baseline

- Goal/spec: `spec.md` §4.1/§8/§9 E04-A and `techdoc.md` §2/§13/§14.
- Initial plan: preserve the current FilePlan, FIFO Publisher and TaskLifecycle boundaries; move only merge and ordinary single-output split generation to one-shot native Workers managed by one Main-owned Supervisor/ResourceGovernor runtime.
- Done when: generation returns only validated staging manifests; Main independently validates FilePlan ownership, regular-file identity, size/hash and workbook business evidence before a single Publisher call; all failure paths publish zero files; large split and publication dispatch remain unchanged; this intermediate PR's targeted tests, lint, diff-check and local review pass. Full `release-check` is reserved for the final v3.2.1 PR.

## Task Brief

- Goal: implement the complete E04-A generation seam without introducing E04-B Route DB, multiple Writers, PreFund work or production enablement.
- Context: current handlers generate merge and ordinary split workbooks on Main, then call the existing durable FIFO Publisher. `toolbox:split-large` and `toolbox:publish` already have existing-dispatch adapters and must not be wrapped again.
- Constraints: native `thread-single`, lifetime `job`, `commit.kind=main-settlement`, `production.enabled=false`; Worker input is limited to FilePlan-owned source path/snapshot, normalized config, Main-owned generation path and exact-5/7 context; Worker cannot receive final targets or Publisher access.
- Done when: format/content and result/error semantics remain equivalent; Publisher is called once on success and zero times on generation/artifact validation failure; shutdown is re-entrant, retains unresolved cleanup ownership, and permits rollback only after a clean close; event-loop evidence shows generation does not run on Main.

## Confirmed Facts

| Fact | Evidence | Constraint |
| --- | --- | --- |
| `toolbox:merge` currently invokes `mergeToolboxFilesToXlsx` directly in Main and then `publishToolboxArtifacts`. | `src/main.js` `registerToolboxHandlers()` merge execute branch. | Move only generation; preserve the existing Publisher call and result mapping. |
| Ordinary `toolbox:split:export` currently invokes `exportToolboxFilter` directly in Main; large and multi-output branches are already separate. | `src/main.js` ordinary branch after `shouldUseLargeChannel`; large branch uses `dispatchLargeSplit`, multi-output uses existing single/large routes. | Route only the ordinary single-output branch to E04-A; do not touch large or multi-output topology. |
| Existing generation cores already perform module write/readback via `commitAndValidate()`. | `toolbox-output-writer.js` `commitAndValidate`; `toolbox-merge-io.js` and `toolbox-format-operations.js`. | Worker must reuse the cores and return their evidence, not duplicate writer logic. |
| Current Supervisor rejects every native non-`none` commit policy. | `background-execution/supervisor.js` `startExecution`, error `E02A_DURABLE_COMMIT_UNSUPPORTED`. | Add the narrow native `main-settlement` observation seam; keep worker-durable/existing-critical fail-closed. |
| Main has no shared production Supervisor/ResourceGovernor instance. | Repository search finds constructors only in canary/test runtime. | Add one Main-owned lazy runtime and close it once during quit; never construct per handler invocation. |
| No runtime technical/business validator exists for the Toolbox E04-A handoff. | Repository search; current handler sends generation evidence directly to Publisher. | Add explicit pre-Publisher Main validation; Publisher must remain uncalled on missing/tampered/mismatched artifacts. |
| FilePlan inputs contain frozen `sourceSnapshot`; outputs contain final target and `artifactKey`. | `archive-center/file-plan.js`. | Worker receives input path/snapshot and a distinct task-private generation path associated with the output artifact key, never the output `filePath`. |
| `production.enabled=false` means the live user request must remain on legacy, not enter native with `production:false`. | Policy registry `assertRunnable(..., { production })` distinguishes live production from explicit canary/harness execution. | Main uses the single policy selector before constructing the lazy runtime; a future enabled route must execute native with `production:true`, without fallback. |
| Protocol `job:done` applies `finance-safe-v1` to the whole result; Windows temp paths and real header/warning strings can contain user directories or account-like values. | `protocol-validator.js` result privacy gate; deterministic Windows path/account counterexamples. | Worker result contains no paths, headers, filenames, sheet names or warning text; task-private sidecar carries those values and Main validates it by derived path/stat/size/hash before use. |
| The first runtime manager discarded its executable reference before shutdown proved clean, while updater resume is intentionally skipped when later quit cleanup fails. | `runtime.js` moved `runtime` to a local only; `app-updater.js` resumes only after `cleanupCompleted=true`; `prepareApplicationForQuit()` had no partial-failure rollback. | Keep a distinct shutdown owner across incomplete/throw, fail closed on resume, and let Main rollback only a previously clean runtime close before rethrowing a later cleanup failure. |
| The ordinary Windows PR workflow ran `npm run release-check` for every head branch. | `.github/workflows/build-windows.yml` has `pull_request.branches: '**'` and previously gave the release-check step no condition. | Skip only that step for `codex/v3.2.1-*` intermediate PRs; preserve it for the exact final evidence branch, non-v3.2.1 PRs, `push main` and manual dispatch. |

## Unknowns Register

| Unknown | Type | Impact | Reversibility | Current evidence | Handling | Cheapest probe | Current decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| How native `main-settlement` can pass Supervisor without letting Worker claim commit. | Known unknown | High | Easy | Supervisor switch already forbids `critical:ready`/`commit:receipt`; Main owns Publisher/Task settle. | PROBE | Extend the admission predicate only, then prove commit events still fail protocol. | Allow native only for `main-settlement`; execution result remains receipt-less and cannot settle Task by itself. |
| Which context shape E04-A should carry. | Known unknown | Medium | Easy | Canonical v3.2.x policy uses operation `exact-5`; active File Task provides exact-7 batch context containing the same five owner fields. | PROBE | Derive exact-5 from the frozen exact-7 context and validate through Protocol v1. | Use exact-5 operation context for Supervisor/Worker; retain exact-7 only in Main Publisher/TaskLifecycle. |
| Whether Main business validation can reuse existing workbook validation without changing output. | Known unknown | High | Easy | `validateGeneratedWorkbook` reopens the staging workbook and checks package, styles, sheet/row counts and stable hash. | PROBE | Validate a generated fixture and tamper/missing variants. | Reuse it in Main with Worker-reported style/sheet/row evidence, preceded by FilePlan/path/stat/hash checks. |
| How to preserve cancellation and quit behavior for merge. | Blind spot | High | Easy | split core already accepts a cancel token; merge streaming facade accepts one but merge orchestration does not pass it. | PROBE | Thread a cancel token through the existing merge core and exercise real Worker shutdown. | Add optional cancel token only; no business/output change. |
| Whether production enablement should be switched on. | Known fact from spec | High | Easy | E04-A table fixes `production.enabled=false`. | ASSUME | Contract assertion. | Keep false; do not add a fallback flag or enable production policy. |
| How to preserve warning/header semantics without violating result privacy on real Windows/bank filenames. | Blind spot | High | Easy | `job:done` rejects `C:\Users\...`, account-like headers and account-like `sourceFileName`; Main already owns generation path. | PROBE | Return only safe manifest values and validate a bounded task-private evidence sidecar from the Main-owned derived path. | Sidecar contains normalized headers and structured warning samples; result carries only its size/hash and warning count. No privacy-field exception was added. |
| How to recover after runtime close succeeds but a later quit stage fails without reviving an unresolved runtime. | Blind spot | High | Easy | A stopped Supervisor cannot become executable again; incomplete/throw still needs the same transport owner; no-runtime clean close has no instance to restore. | PROBE | Exercise incomplete retry, thrown shutdown, clean existing replacement and no-runtime lazy creation; statically bind Main's later-failure catch to the clean marker. | Retain the old instance only as `shutdownOwner` until a strict clean report; clean rollback clears closing state and lazily creates one replacement, while unresolved resume rejects. |

## Risk-priority Plan

| Order | Step | Unknown/invariant protected | Success evidence | Failure impact | Rollback/scope reduction |
| --- | --- | --- | --- | --- | --- |
| 1 | Evolve Supervisor admission for native `main-settlement`. | Worker generation cannot claim durable commit or Task success. | Unit proves job completion works, commit events remain forbidden, other native durable kinds reject. | Blocks all E04-A execution. | Revert the single admission predicate and tests. |
| 2 | Add strict Worker contract, entries and single runtime owner. | Input/final-target boundary, exact context, one Worker, shutdown cleanup. | Contract/runtime unit tests and real Worker lifecycle. | Could leak Workers or expose final targets. | Remove E04 runtime wiring; legacy handlers remain structurally available in history. |
| 3 | Add Main technical/business validation and 0/1 publish orchestration. | FilePlan ownership, artifact integrity, all-before-publish. | Publisher spy for missing/tamper/mismatch/success. | Could publish invalid or partial output. | Keep generation isolated and do not call Publisher. |
| 4 | Wire merge and ordinary split only. | Preserve large/multi-output/publish routes, result order/shape/errors. | Main source contract tests plus merge/split roundtrip equivalence. | User-visible regression. | Limit changes to the two direct generation calls. |
| 5 | Run fault, cleanup, jank and targeted regression gates. | No hidden bypass/state leak/format drift. | Targeted tests, integration/benchmark evidence, lint, diff-check, local review and blindspot passes; full `release-check` runs only on the final v3.2.1 PR. | Not mergeable. | Keep production disabled and report manual red lines. |

## Decisions

| Decision | Reason and evidence | Rejected alternative | Impact |
| --- | --- | --- | --- |
| Treat E04-A Worker completion as generation evidence only. | `main-settlement` belongs to Main Publisher/TaskLifecycle; Supervisor result has no receipt hint. | Emitting `commit:receipt` from generation Worker. | Prevents generation success from masquerading as publication success. |
| Use one lazy Main-owned runtime for both E04-A actions. | Per-handler Supervisor/Governor construction would fragment resource and shutdown ownership. | Constructing a runtime for every request or wrapping existing dispatches. | Merge and ordinary split share admission and graceful shutdown; large/publish remain unchanged. |
| Derive generation ownership from FilePlan output `artifactKey` and a Main-created task-private path. | Worker must not know final target but Main must join artifact to the exact FilePlan output. | Passing final target to Worker or relying on array position alone. | Enables fail-closed manifest join without exposing Publisher boundary. |
| Keep the live false-gated handlers on legacy and reserve `production:false` for explicit tests/harnesses. | Calling native with `production:false` from IPC would bypass the frozen production gate. | Treating a real user request as canary or silently falling back after native failure. | Current users retain v3.2.0 behavior; native capability is testable but cannot be activated accidentally. |
| Put privacy-sensitive header/warning evidence in a bounded task-private sidecar, not the Worker result. | Result privacy is platform-independent and cannot safely carry Windows temp paths, account-like filenames, headers or messages. | General path/string privacy exemptions, dropping warning semantics, or rereading all source workbooks on Main. | Worker result is safe count/hash/ID evidence; Main derives the sidecar path, validates regular-file/size/hash/strict JSON, then injects owned evidence only into local validation/Publisher data. |
| Separate executable runtime ownership from unresolved shutdown ownership. | Clean shutdown makes the stopped instance non-reusable, but incomplete/throw must remain retryable on exactly that instance. | Clearing the only reference at shutdown start or allowing `resume()` after any shutdown outcome. | Concurrent shutdown shares one promise; retry re-observes the same owner; only strict clean/no-runtime outcomes may rollback to lazy replacement state. |
| Encode the v3.2.1 release-check exception on the single Windows workflow step. | The user's gate is branch-phase-specific, while Windows adapter, alignment, build and packaged canary evidence remain required on intermediate PRs. | Filtering the whole workflow/job, labels, matrices or duplicated workflows. | Only `Run release checks` is skipped for intermediate `codex/v3.2.1-*`; exact `codex/v3.2.1-r3-release-evidence` and all pre-existing event/version cases still run it. |

## Assumptions

| Assumption | Basis | Failure impact | Validation and rollback |
| --- | --- | --- | --- |
| Existing Publisher API remains the single authoritative publish/rollback implementation. | E04-A explicit non-goal and current durable journal tests. | Duplicate or uncertain publication. | Spy/static route tests; do not modify publication modules. |

## Deviations

No behavioral or contract deviations recorded.

## Evidence

| Evidence | Result | Covered behavior/risk |
| --- | --- | --- |
| Baseline repository probe | Confirmed the four facts and two missing seams above. | Prevents policy downgrade, duplicate Worker wrapping and silent missing validation. |
| E04-A focused unit (`toolbox-background-generation`) | 6/6 PASS. | Policy tuple/production selector, real writer warning object, privacy-safe sidecar, FilePlan/final boundary, Main stat/size/hash/business validation, generation/manifest/missing/tamper/zero-hit Publisher=0, real split/merge Worker success Publisher=1, jank heartbeat, shutdown cleanup and runtime re-entry. |
| Protocol + Supervisor focused unit | `protocol-validator` 26/26 PASS; `mature-action-adapters` 11/11 PASS. | Exact SHA/FilePlan digest semantic exception, Windows/user/account result rejection, native `main-settlement` admission and other native durable commit fail-closed. |
| Existing Toolbox focused unit | 300 cases run; after preserving explicit FIFO await source contract, all affected focused suites pass. | Merge/split writer/format/path, publication FIFO, large/multi existing-dispatch and archive/recovery boundaries. |
| Existing Toolbox integration | `toolbox-roundtrip` 30/30, multi-sheet merge 16/16, multi-split roundtrip 17/17, large-split multi-sheet 31/31, large-file stream 50/50 PASS. | Cross-format/row/order/format roundtrip, 600,000-row merge/100,000-row split evidence, and proof that large split remains its existing Worker dispatch. |
| Final targeted lint/unit | `eslint src/` plus changed tests PASS; focused combined `node --test` 91/91 PASS. | Final source style plus policy/privacy/Supervisor/runtime/Worker/Publisher/renderer route contracts after closeout edits. |
| Ultra Review P2 lifecycle fault gate | Runtime/quit focused `node --test` 16/16 PASS; affected-file ESLint PASS. | Incomplete and thrown shutdown keep the same owner/factory count, unresolved resume fails closed, clean existing/no-runtime rollback lazily creates at most one runtime, and Main rolls back a clean runtime before rethrowing later cleanup failure. |
| Intermediate-PR CI policy contract | `windows-build-contract` targeted unit PASS; affected test ESLint and `git diff --check` PASS. | Locks the v3.2.1 prefix, exact final evidence branch, unchanged release-check command and continued Windows build/canary workflow topology. |
| Per-PR validation policy | v3.2.1 intermediate PRs use targeted tests, lint, diff-check and local review; full `release-check` is reserved for the final v3.2.1 PR. | A full gate was started before this rule arrived: lint and smoke passed; unit reached 6023/6029 with one E04-A static source expectation (fixed and rerun 37/37) plus two worktree-local `node_modules` path failures; the run stopped before integration and is not treated as this PR's gate. |

## Remaining Unknowns

| Unknown | Handling | Owner/next step | Merge impact |
| --- | --- | --- | --- |
| Real Windows Excel/WPS format fidelity and file-lock behavior. | PROBE | Human E04-A gate after automated equivalence. | Manual gate; production remains disabled. |
| Toolbox output row-set/format/all-or-none inspection on representative business files. | BLOCK for production enablement, not implementation | Business owner manual sample review. | `production.enabled` must remain false. |
| Warning sidecar may contain account-bearing source filenames/sheets/messages. | ACCEPTED private staging boundary | Reviewer verifies it never enters Protocol result/diagnostics and is removed with the task temp directory. | No production enablement until manual privacy/sample review; do not widen `finance-safe-v1`. |

## Blindspot Closeout

- Entrypoints/routes: only merge and the ordinary single-output split branch have a policy-gated native capability. Large split, multi-output split and publication still call their existing dispatchers directly; source-contract and large integration tests cover this boundary.
- Lifecycle/idempotency: one lazy runtime owns one Supervisor/Governor, production-disabled handlers do not construct it, and concurrent shutdown shares one promise. Incomplete/throw retains the same shutdown owner and blocks resume; strict clean/no-runtime close may rollback to one lazy replacement. Main performs that runtime-specific rollback when any later quit stage fails, without relying on updater `cleanupCompleted`.
- Failure ordering: generation, result schema, FilePlan ownership, workbook stat/size/hash, sidecar stat/size/hash/strict content and workbook business readback all precede Publisher. Missing/tampered/mismatched/zero-hit cases assert Publisher count zero; real split/merge success asserts one publication handoff.
- Compatibility/privacy: external merge/split result and warning shapes remain sourced from the existing Publisher. Protocol result has no path/header/warning business strings; Windows user paths and account-like result strings remain rejected. The SHA/FilePlan-key exception is restricted to exact semantic fields and strict canonical shapes.
- Reconciliation/fund red line: no amount, currency, matching, settlement arithmetic or Publisher rollback implementation changed. Automated cross-format row/order/style tests are supporting evidence only; representative business row-set/format/all-or-none review remains a human production-enable gate.
