# v3.2.1 E04-A / E04-B Implementation Notes

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
| The ordinary Windows PR workflow ran `npm run release-check` for every head branch; a prefix-only exception would also trust fork-controlled branch names. | `.github/workflows/build-windows.yml` has `pull_request.branches: '**'`; `github.head_ref` alone does not establish that the PR head belongs to this repository. | Skip only that step for same-repository `codex/v3.2.1-*` intermediate PRs; force fork PRs to run, and preserve the exact final evidence branch, non-v3.2.1 PRs, `push main` and manual dispatch. |

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
| Encode the same-repository v3.2.1 release-check exception on the single Windows workflow step. | The user's gate is branch-phase-specific, while fork branch names are untrusted and Windows adapter, alignment, build and packaged canary evidence remain required on intermediate PRs. | Filtering the whole workflow/job, trusting `head_ref` alone, labels, matrices or duplicated workflows. | Only same-repository intermediate `codex/v3.2.1-*` skips `Run release checks`; fork PRs, exact `codex/v3.2.1-r3-release-evidence` and all pre-existing event/version cases run it. |

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
| Intermediate-PR CI policy contract | `windows-build-contract` targeted unit PASS; YAML parse, affected test ESLint and `git diff --check` PASS. | Static step contract plus local truth table lock same-repo intermediate=skip and same-repo final/fork prefix/ordinary PR/push/workflow dispatch=run, while preserving the release-check command and Windows build/canary topology. |
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

## E04-B Increment — Single Scanner + Sealed Route DB + One Writer

### Goal / Context / Constraints / Done when

- Goal: add the smallest testable `toolbox:split-multi-output` managed capability: one Scanner Worker, one task-private sealed Route DB, one read-only Writer Worker, Main join by `outputIndex`, then exactly one existing FIFO Publisher handoff.
- Context: a disposable macOS benchmark of the real current `exportToolboxMultiFilters` path showed generation is the objective main hotspot. The existing path already parses the source workbook once and fans every row to all output writers; E04-B therefore changes the inter-Worker handoff, not the number of Excel structure parses.
- Constraints: `production.enabled=false`; large split remains its existing dispatch; live non-large multi-output remains the legacy facade; no second Writer/E04-C, no Publisher changes, no final target in either Worker, no cross-restart Route DB recovery, no general-purpose/cross-Node codec.
- Done when: v1 row/style codec fidelity is locked by golden and real XLSX/BIFF8/CSV tests; the sealed DB has one meta row, no WAL/SHM/journal, read-only integrity/count/size/hash evidence and a last-written manifest; Writer and Main independently validate the seal; all artifacts join uniquely and in order to FilePlan outputs; failure calls Publisher zero times; success calls it once; task-private files and handles cleanly release.

### Confirmed Facts and Gate Benchmark

| Fact | Direct evidence | Consequence |
| --- | --- | --- |
| Current non-large multi-output parses the source structure exactly once. | `toolbox:split:export` → `exportToolboxMultiFilters` → one `streamToolboxTables`/`openToolboxXlsxPass`; `onDataRow` tests every group and emits to its writer. Benchmark monkeypatch of the exact source `yauzl.open` observed one open in every measured generation and zero in Publisher. | Do not claim E04-B eliminates repeated source parsing. Scanner continues one structural parse; source SHA is a separate raw-byte read. |
| Generation owns almost all current wall time. | Synthetic 50,000-row × 12-column styled XLSX, 8 outputs, 4,247,000 bytes, SHA-256 `054733d06cfe908d369f0d308ad78958a0817997511e7e056d15e3e1c7c52b67`; one warmup plus five real-path measurements. | Project owner approved the E04-B gate; this is not the E04-C ≥15% production-parallel threshold. |
| Existing row/style representation is reusable. | `ToolboxCell`/`ToolboxRow`/`ToolboxSheetMeta`, `SourceStyleRegistry.get/size`, normalized static style objects, and `createToolboxOutputWriter` resolver contract. | Route DB v1 serializes these task-private values and reconstructs through the existing constructors/normalizer. |
| The renderer and existing multi-output normalizer accept one through eight outputs. | The dialog starts with one undeletable group and may submit it; `normalizeMultiSplitGroups` and its unit contract accept 1..8. | Route mask v1 is one byte and the strict managed input/result contracts accept 1..8 without narrowing existing behavior. |
| FilePlan source evidence is stat-only; no reusable source SHA exists. | `archive-center/source-snapshot.js` contains size/mtime/ctime/inode but no hash. | Scanner performs a raw-byte SHA pass, with FilePlan snapshot checks before and after hash and after structural parse. Raw hashing is not a second Excel parse. |

Benchmark raw milliseconds:

| Run | generation | Main join validation | Publisher | total wall | generation share |
| --- | ---: | ---: | ---: | ---: | ---: |
| warmup | 11981.605 | 0.060 | 256.167 | 12239.086 | 97.906% |
| 1 | 12005.546 | 0.061 | 256.684 | 12263.070 | 97.906% |
| 2 | 12086.872 | 0.065 | 250.091 | 12337.634 | 97.972% |
| 3 | 12297.484 | 0.066 | 255.758 | 12553.865 | 97.962% |
| 4 | 12199.686 | 0.059 | 251.812 | 12452.152 | 97.977% |
| 5 | 11996.776 | 0.061 | 254.764 | 12252.280 | 97.920% |
| median (measurements only) | 12086.872 | 0.061 | 254.764 | 12337.634 | 97.962% |

- Row evidence: 50,000 input rows, 50,000 total output rows and eight committed publications in each iteration.
- Event loop: generation heartbeat maximum delay per measured run was 23.838/18.881/12.373/11.788/11.874 ms (median 12.373 ms); Publisher median maximum delay 1.143 ms. Generation `monitorEventLoopDelay` p99 was about 13 ms.
- RSS boundary: same-process cumulative high-water maximum 368,345,088 bytes (about 351.3 MiB), median cumulative high-water 353,533,952 bytes; this is not an independent per-iteration peak.
- Disk boundary: stable generation staging 3,885,372 bytes, Publisher journal/meta about 16,776 bytes, final targets 3,885,372 bytes, stable post-Publisher task footprint about 7,805,837 bytes. These are phase-boundary sizes, not a continuous transient disk watermark.
- E04-B disk diagnosis first exposed a 410,120,192-byte Route DB because v8 serialized every object key and repeated cell-level source file/Sheet/row/registry values. The narrow v1 codec now uses fixed arrays, row-level source/registry fallback and `General` format elision, while decoding through the same model constructors. A preliminary compact probe produced 54,034,432 bytes; the final five-run fixture consistently produced 57,528,320 bytes. Golden and real XLSX/BIFF8/CSV parity remained green.
- Platform boundary: macOS 15.7.4 arm64, Node 25.8.0, 14 CPUs, 48 GiB. This evidence cannot replace Windows packaged, directory-fsync, file-lock, RSS/disk and Excel/WPS gates.

### E04-B Unknowns Register

| Unknown | Type | Impact | Evidence/handling | Decision |
| --- | --- | --- | --- | --- |
| Can a task-private codec preserve values and styles without a new canonical business model? | PROBE | High | Golden covers formula/negative zero/row/layout/style metadata; real XLSX comparison covers values, formats, font/fill/border/alignment, widths/heights/hidden state; BIFF8/CSV cover long IDs and row routing. | Use versioned `node:v8` BLOB only inside one job and one Node runtime; reconstruct through current model/style validators. It is not restart/version durable. |
| Does the additional source hash race the Excel parse? | PROBE | High | FilePlan snapshot is checked before hash, after hash and after structural parse. | Keep raw hash pass required by Route DB meta; label it separately from the single structure parse. |
| Can current Supervisor dynamically release Scanner phase then acquire Writer phase? | Known platform gap | Medium now, high for production | Current job-scoped CompoundLease admits root phase + child together and exposes no narrow Worker-driven phase transition. | Do not widen public Supervisor/Protocol in E04-B. Functionally seal then spawn Writer; conservatively hold both accounted slots for the whole job. This blocks production enablement/E04-C production gate until separately resolved. |
| Is directory fsync reliable on packaged Windows filesystems? | PROBE | High | Shared durability helper explicitly reports EACCES/EISDIR/EPERM as unsupported; Route DB converts unsupported to a fail-closed seal error. | Capability code may merge with production false, but Windows production remains blocked until packaged evidence succeeds; never fake durability. |
| Is a second Writer beneficial and safe? | Deferred E04-C PROBE | High | This increment intentionally has one child and `childrenMax=1`. | No second Writer or production threshold claim in E04-B. |
| Can job-start disk need be bounded safely from current evidence? | Known implementation gap | High | Existing reusable limits bound shared-strings extraction, Excel row/text dimensions and style counts, but do not bound total row payload, output bytes or Route DB bytes. Compressed source bytes cannot safely upper-bound the 410 MB observed DB. | Do not invent a multiplier. This increment does not claim the spec disk preflight; production/E04-C remain blocked pending a proven estimator or explicit spool quota design. |

### E04-B Decisions / Deviations

| Decision or deviation | Evidence and boundary | Impact |
| --- | --- | --- |
| SQLite schema v1 stores one `route_meta`, normalized styles, ordered routed rows and a one-byte route mask. | Existing output cap is eight; rows are ordered by a job-local source ordinal so repeated worksheet row numbers cannot collide. | Preserves flattened multi-sheet scan order and permits overlapping groups without reparsing. |
| Seal uses DELETE journal, transaction completion, close, no-sidecar assertion, DB file + parent fsync, read-only integrity/meta/count, DB size/hash, then atomic durable manifest last. | Writer and Main each call the same read-only seal inspector; manifest contains only basename and evidence, no final target. | Missing/tampered/mismatched DB or manifest cannot reach Publisher. |
| Writer owns all outputs in this increment and reads ordered Route DB rows once. | One child Worker creates existing output writers, decodes each row once and dispatches by mask; it commits/validates in `outputIndex` order. | This is E04-B one-Writer capability only, not E04-C parallel generation. |
| Main derives every task-private path, binds generation artifacts to FilePlan `artifactKey`, rejects alias/duplicates, and validates all outputs before Publisher. | Result carries IDs/index/count/hash only; headers/warnings remain existing bounded evidence sidecars. | Neither Worker receives final targets or Publisher access; result ordering alone is insufficient ownership evidence. |
| Resource accounting intentionally over-holds Scanner + Writer resources. | Functional sequence is strictly Scanner seal → spawn Writer, but the current CompoundLease holds phase + one child for the whole job. | This is an explicit implementation deviation from the desired dynamic phase handoff. It does not underestimate resources, but it must not be described as releasing/reacquiring phases and blocks production enablement. |

### Compact E04-B Cost Probe (one warmup + five measurements)

- Fixture: synthetic 50,000 rows × 12 columns × 8 outputs; compressed source 4,247,000 bytes; ten ZIP entries total 27,464,836 uncompressed bytes (6.467× compressed). The exact synthetic package SHA changes with workbook package metadata.
- Phase boundary: Scanner Worker includes raw SHA + structural scan + SQLite transaction/seal; Writer Worker includes read-only seal validation, row decode/routing, eight writes and each writer's `commitAndValidate`; Main validation independently rechecks Route DB, artifact/evidence hashes and business workbooks. No Publisher is included in the E04-B total below.

| Run | Scanner hash+seal ms | Writer ms | Main validation ms | total ms |
| --- | ---: | ---: | ---: | ---: |
| warmup | 4750.858 | 9696.188 | 3497.815 | 17945.378 |
| 1 | 4639.268 | 9667.424 | 3455.790 | 17762.759 |
| 2 | 4691.537 | 9726.799 | 3453.563 | 17872.191 |
| 3 | 4842.904 | 9716.414 | 3461.609 | 18021.201 |
| 4 | 4702.161 | 9664.991 | 3472.593 | 17839.978 |
| 5 | 4682.980 | 9697.696 | 3471.962 | 17852.943 |
| median | 4691.537 | 9697.696 | 3461.609 | 17852.943 |

- Disk median/stable: Route DB 57,528,320 bytes; generation workbooks 3,885,372 bytes; stable task-private footprint and 10 ms sampled peak 61,415,901 bytes. Route density is 1,150.57 bytes/input row, 95.88 bytes/cell, 13.546× compressed source and 2.095× measured uncompressed ZIP entries. Sampling is not proof that a sub-10 ms transient never exceeded the recorded peak.
- RSS sample medians: Scanner 529,039,360 bytes, Writer 534,151,168 bytes, Main validation 491,487,232 bytes. These are same-process phase samples, not independent clean-process peaks; compared with the legacy cumulative high-water median 353,533,952 bytes, direction is unfavorable.
- Event loop heartbeat median maxima: Scanner 1.676 ms, Writer 1.673 ms, Main validation 44.563 ms; each phase's event-loop-delay p99 stayed about 11.6–11.8 ms. Worker phases keep Main responsive, but independent Main workbook validation still has a visible bounded stall.
- Conservative comparison: compact E04-B median total 17,852.943 ms is materially slower than the recorded legacy total median 12,337.634 ms; even Scanner + Writer alone total 14,389.233 ms versus legacy generation median 12,086.872 ms. RSS and disk direction are also unfavorable. This capability therefore stays `production.enabled=false`; the raw evidence is handed to the later E04-C decision without implementing or pre-judging a second Writer here.

### E04-B Evidence and Blindspot Closeout

- Entrypoints/bypass: `shouldUseLargeChannel` remains first; large multi-output still uses `dispatchLargeSplit`. Only non-large and future `production.enabled=true` can enter the managed route. With the frozen false flag, live requests still call the legacy `exportToolboxMultiFilters` and do not lazily construct runtime for this action.
- Ownership/order: strict input accepts 1..8 unique indexed groups/generations, matching the existing multiple-mode UI and normalizer; task-private DB/manifest/generation paths cannot alias one another, FilePlan inputs or formal outputs. Worker result requires the complete `[0..N-1]` order; Main rejoins each artifact to the exact FilePlan output key and revalidates every staging workbook before one Publisher call.
- Seal/tamper: codec version mismatch, invalid mask, path alias, route hash tamper, missing/invalid evidence and reordered artifact cases fail closed. Scanner failure removes DB/manifest/sidecars; Writer failure aborts every generation and evidence file. Successful runtime shutdown reports no leaked transport and the task directory is removable after handles close.
- Worker lifecycle: Scanner stores the child result but does not complete until the child emits `exit(0)`; a result followed by nonzero exit and a transport error both reject, and cancellation waits for exit/termination. The narrow `outputPlanHash` result field is privacy-exempt only when it is exactly a 64-character lowercase hexadecimal digest; similarly named/general strings remain rejected.
- Compatibility: XLSX Route DB output is projection-equal to the current legacy multi-output path for values, long IDs, date/number formats, header styling, column widths, row height/hidden state and scan order. Real BIFF8 and CSV Scanner/Writer paths preserve routed row counts and long IDs. Zero-hit groups remain header-only outputs through the unchanged writer behavior.
- Publisher/idempotency: generation and Route DB are non-durable task-private handoff facts. All validation completes before Publisher; reordered/tampered/failing cases observe zero calls and success observes exactly one. Existing Publisher journal remains the only publication/recovery fact and was not edited.
- Financial blindspot: no amount/currency matching, reconciliation keys, row filtering, settlement arithmetic, Publisher rollback or archive semantics changed. Row/output disposition remains explainable by source ordinal + route mask + outputIndex, but representative Windows business-file review is still required before production enablement.
- Required remaining gates: proven job-start disk estimator/quota, packaged Windows directory fsync/file-lock/cleanup, peak RSS and transient disk watermark, representative Excel/WPS format review, and the independent resource-phase platform decision. `production.enabled` remains false.
- Final targeted self-check: the initial E04-B focused set passed 78/78; after the Review P2 corrected managed output cardinality to 1..8, the expanded focused set passed 90/90, including real single-group matched and zero-hit Scanner/Writer/Main/Publisher parity. Affected ESLint, `node --check` and `git diff --check` passed.
- Validation policy: this E04-B intermediate PR runs targeted tests, affected ESLint and `git diff --check` only. It did not run `release-check`, `check-vars` or `scan:vars`; the complete v3.2.1 `release-check` is reserved for exactly one run before the final v3.2.1 PR is sent remotely.

## E04-C Gate — Second Writer Rejected

### Goal / Method / Decision Boundary

- Goal: independently test whether a second read-only Writer merits a production implementation without first adding it to production code.
- Baseline: exact reviewed E04-B head `5008eef12316910cb5c487382c18d7d191bac2b1`; the probe itself lived outside the repository and changed no production source, Policy, test or feature flag.
- Candidate topology: one real `scanAndSealRouteDb` Scanner pass writes and seals one task-private Route DB; two disposable Writer processes both open that DB read-only and deterministically own global `outputIndex` shards `[0,2,4,6]` and `[1,3,5,7]`; Main joins only the unique complete `[0..7]` set and calls the real `validateMultiGenerationResult`; the existing durable Publisher prepares and commits exactly eight task-private targets once.
- Comparator topology: the same Scanner/sealed DB/Main validation/Publisher chain with the existing one Writer owning `[0..7]`. The current legacy `exportToolboxMultiFilters` path was measured separately through workbook validation and the same task-private durable Publisher.
- Sampling: every mode/run executed in a fresh Node process. Each scenario ran one warmup per mode followed by five measured runs. Measured order rotated (`one→two→legacy`, `legacy→two→one`, `two→one→legacy`, `legacy→one→two`, `two→legacy→one`) so a fixed later mode could not inherit all cache/order advantage. Semantic equivalence rereads ran after the product-path timer and were not counted in end-to-end time.
- Resource sampling: phase timers recorded wall time, 10 ms event-loop heartbeat, `monitorEventLoopDelay` p99, process `maxRSS`, 10 ms sampled task-root bytes and stable phase/task-root bytes. RSS is fresh-process high-water; sampled disk is not proof against a sub-10 ms transient. Event-loop figures are supporting evidence because a timer can under-observe a fully synchronous interval.
- Platform: macOS Darwin `24.6.0`, arm64, Node `v25.8.0`, 14 logical CPUs, 51,539,607,552 bytes RAM. This evidence does not represent packaged Windows, directory-fsync or Windows file-lock behavior.

The representative fixture is one styled XLSX with 50,000 rows × 12 columns, eight equally sized `Group` routes, 3,518,118 bytes, SHA-256 `d6c0f883490e6ecc1292684de6a9c24f810afff32928c1375f5b1689e0d9cb3b`. The small fixture uses the same 12-column/style/routing shape with 800 rows, 59,761 bytes, SHA-256 `0aa1909fb7eb7e88c6bf3f836afab49663747d1a40a7a51e2c2b600c41b7e54b`.

### Raw End-to-end Evidence

All values below are milliseconds. Warmups are recorded but excluded from medians.

| Scenario | Mode | Warmup | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Measured median |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 50k × 12 × 8 | one Writer | 17097.340 | 17627.156 | 17665.905 | 17583.591 | 17696.555 | 17403.465 | 17627.156 |
| 50k × 12 × 8 | two Writers | 13656.725 | 13389.223 | 13908.494 | 13953.733 | 13913.439 | 13873.662 | 13908.494 |
| 50k × 12 × 8 | legacy | 15109.913 | 15044.089 | 15221.480 | 15061.306 | 15214.014 | 15272.738 | 15214.014 |
| 800 × 12 × 8 | one Writer | 987.976 | 998.441 | 981.809 | 993.358 | 978.148 | 979.386 | 981.809 |
| 800 × 12 × 8 | two Writers | 907.747 | 900.022 | 920.462 | 919.208 | 901.000 | 911.821 | 911.821 |
| 800 × 12 × 8 | legacy | 593.390 | 617.981 | 608.230 | 621.817 | 609.293 | 608.549 | 609.293 |

- On the representative fixture, two Writers improve end-to-end median by `21.096%` relative to one Writer, but only `8.581%` relative to the current legacy path.
- On the small fixture, two Writers improve the one-Writer median by `7.128%`; expressed as the specified regression metric, `(two - one) / one`, the result is `-7.128%`, within the `≤5%` ceiling.
- The frozen Spec says only that production parallelism needs end-to-end median improvement `≥15%` and that E04-C needs “15%收益、RSS、Windows”; it does not name one Writer or legacy as the comparison denominator. The delegated E04-C probe selected one Writer as the incremental comparator, but the production decision conservatively also considered the current legacy path and all resource/platform gates.

### Phase / Resource Evidence

Representative medians and maxima:

| Mode | Scanner median ms | Writer median ms | Main validation median ms | Publisher median ms | RSS median / max bytes | Stable / sampled max disk bytes | Route DB median bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| one Writer | 4333.042 | 9509.590 | 3475.559 | 267.562 | 451,002,368 / 457,211,904 | 74,844,015 / 74,844,015 | 68,448,256 |
| two Writers | 4405.560 | 5709.854 | 3494.706 | 263.608 | 593,887,232 / 600,424,448 | 74,844,015 / 74,844,015 | 68,448,256 |
| legacy | n/a | 11470.910 | 3496.960 | 270.911 | 288,391,168 / 289,865,728 | 6,393,790 / 6,393,790 | 0 |

Small-fixture medians and maxima:

| Mode | Scanner median ms | Writer median ms | Main validation median ms | Publisher median ms | RSS median / max bytes | Stable / sampled max disk bytes | Route DB median bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| one Writer | 241.755 | 386.143 | 109.576 | 252.591 | 218,005,504 / 229,654,528 | 1,320,424 / 1,320,424 | 1,110,016 |
| two Writers | 241.599 | 305.333 | 111.757 | 247.483 | 316,751,872 / 318,275,584 | 1,320,424 / 1,320,424 | 1,110,016 |
| legacy | n/a | 282.119 | 78.285 | 246.673 | 166,658,048 / 170,442,752 | 208,442 / 208,442 | 0 |

- Representative two-Writer RSS median is `31.682%` above one Writer and `105.931%` above legacy. Absolute two-Writer median/max are about 566.4/572.6 MiB.
- Route topology stable disk is the same for one and two Writers because both retain the same Route DB and eight generated/final workbooks at the sampled boundary, but 74,844,015 bytes is `11.706×` the legacy 6,393,790-byte task footprint. No job-start estimator or hard spool quota exists to prove this safe from compressed source size.
- Representative event-loop heartbeat maxima across measured phases were 50.068 ms for one Writer, 45.820 ms for two Writers and 17.918 ms for legacy. The route maxima occur in independent Main workbook validation, not Scanner/Writer: two-Writer Scanner/Writer heartbeat maxima were 1.461/1.529 ms with p99 maxima 11.264/11.387 ms; Main validation heartbeat/p99 maxima were 45.820/11.624 ms. One-Writer Main validation heartbeat max was 50.068 ms. These local samples do not satisfy a Windows packaged responsiveness gate.

### Equivalence / Publisher Evidence

Every warmup and all 30 measured mode/scenario runs satisfied the following checks:

- input row count equalled output row count (`50,000` or `800`); each of eight outputs contained exactly one eighth of the fixture rows;
- the complete `outputIndex` sequence was exactly `[0,1,2,3,4,5,6,7]`, with no duplicate or missing owner;
- canonical semantic digests matched across one Writer, two Writers and legacy for every output. The digest covered cell values/types/formulas/number formats, resolved font/fill/border/alignment styles, header/layout metadata, column widths, row height/hidden/outline state and row order;
- warning counts were `[0,0,0,0,0,0,0,0]` in every mode/run;
- Main accepted the sealed Route DB and every staging artifact only after hash/size/business validation; Publisher committed exactly once with eight files and no Writer accessed a final target;
- all benchmark Publisher state, generation paths and final targets lived below a benchmark-created temporary root and were removed after each child exit. No user output or repository business file was used as a target.

### Conservative Gate Decision

E04-C fails the combined production gate and is rejected. No second Writer production code, shard planner, Policy change, test path or permanent generic benchmark framework is retained; `production.enabled` remains `false` and live requests remain legacy.

Although the local incremental comparison clears `≥15%` against one Writer and the small regression threshold, it does not make the complete E04-C gate green:

1. benefit against the actual current legacy path is only `8.581%` on the representative fixture;
2. two-Writer RSS materially increases relative to both one Writer and legacy;
3. Route DB disk remains about `11.706×` legacy and has neither a proven job-start estimator nor an explicit quota;
4. the current CompoundLease cannot release Scanner active phase and then acquire the Writer phase as specified;
5. packaged Windows directory-fsync, file lock, cleanup, RSS, disk and Excel/WPS evidence was not run and is not inferred from macOS;
6. the event-loop maximum still comes from Main validation and is not improved into a production acceptance result by adding the second Writer.

`productionImplementationAuthorized=false`. E04-C creates no PR and does not enable a second Writer. The next v3.2.1 implementation step may carry this decision evidence forward, but must not reinterpret the rejected probe as production authorization.

### E04-C Decisions / Evidence / Remaining Unknowns

| Type | Record | Impact |
| --- | --- | --- |
| Decision | Treat the frozen comparison-baseline ambiguity conservatively: examine both one Writer and current legacy, then apply RSS/disk/Windows requirements as co-equal gates. | A local `+21.096%` incremental result cannot override `+8.581%` versus live legacy or failed/missing resource and platform evidence. |
| Decision | Reject, rather than land production-false second-Writer scaffolding. | Avoids carrying unused concurrency/failure/cleanup complexity for a topology that does not pass the combined gate. |
| Evidence | One disposable harness run; raw JSON was 155,899 bytes with SHA-256 `f3fc31c02ef0ef5e85ab4c29ed8c1031db9d5a20b54f065a76f6ee29b10774a0`. The necessary reproducible contract and raw timings are preserved above; the disposable file itself is not tracked. | Evidence remains reviewable without creating a permanent general-purpose benchmark surface. |
| PROBE / production BLOCK | Packaged Windows durability/file-lock/resource/Excel-WPS behavior. | Blocks production enablement; no local substitute or fabricated PASS. |
| BLOCK | Dynamic Scanner→Writer phase lease transition and job-start Route DB/staging disk estimator or quota. | Blocks production enablement even if a future benchmark produces a larger speedup. |
| Human gate | Representative business-file row-set/format/all-or-none inspection. | Automated semantic equivalence supports review but does not replace the required human production gate. |

### E04-C Blindspot / Financial Closeout

- Entrypoint and lifecycle: because the probe is rejected and no source is retained, there is no new Worker entrypoint, production selector, cancellation race, partial-success cleanup path or Publisher bypass to maintain. The reviewed E04-B one-Writer capability remains production-false and live execution remains legacy.
- Data lineage and disposition: the disposable evidence proved one source structural scan, stable source ordinal + route mask lineage, exact row-count conservation and deterministic artifact ownership for its synthetic fixtures. It did not change amount, currency, matching, filtering, reconciliation key, archive or settlement semantics.
- Failure/resource blindspots: a real two-Writer implementation would still need sibling cancellation, wait-for-exit, all-artifact cleanup and Publisher=0 fault evidence. Rejecting the implementation avoids claiming those unimplemented properties. Windows durability and transient disk high-water remain unknown rather than being relabelled PASS.
- ⚠️ Financial/manual boundary: automated styled-fixture parity does not replace human inspection of representative business workbooks for row set, formats, warnings and all-or-none publication. This remains a production blocker, not a task completed by the E04-C probe.
