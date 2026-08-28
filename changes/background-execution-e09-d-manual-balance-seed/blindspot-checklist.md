# E09-D Blindspot And Reconciliation Checklist

## Authority And Entry Paths

- [x] Live `file:save-balance-seed` remains legacy while canonical production is `false/legacy/0`.
- [x] No second token, reservation, business lock, PhaseLease, intent repository, receipt, Inspector, Publisher, config or transition authority was introduced.
- [x] Hold admission and business/token `preCommitCheck` run before `prepared`; known rejection leaves no Intent or target mutation.
- [x] `prepared -> acked` is Main-owned and has no Worker `critical:ready/critical:ack` messages.
- [x] Manual recovery supplies only the frozen action binding over generic RecoverySourceV1 transitions; RecoveryControl remains the sole observation/transition authority.

## Identity, Replay And State Lifecycle

- [x] Each TaskRun persists `interactionOrdinal=1..N` under `BEGIN IMMEDIATE`.
- [x] Complete token history is strict, monotonic and one-to-one: current token reuses, new token increments, A/B/A historical replay fails stale, and corrupt/duplicate metadata fails closed.
- [x] Intent identity is deterministic from operationKey and the canonical request hash binds target alias, exact pre/post, revision and token hash.
- [x] Exact closed/recovered retry returns its stable decision before mutation; same operation with a changed post-image conflicts before mutation.
- [x] Canonical target alias/scope uses the repository target identity authority (sanitized basename, NFC/full case-fold and existing-ancestor realpath), so Darwin/Windows spellings of one physical file share scope.
- [x] Persisted request-owner conflict and awaited continuation pre-commit gate run before no-op; accepted no-op then returns before Intent/critical transition and creates no control event.

## File Durability And Recovery

- [x] First creation of `balance-seeds` persists its parent entry before writing the target.
- [x] Non-noop uses same-directory exclusive temp, full file write, file fsync, atomic rename, target-directory fsync and fresh target readback.
- [x] Explicit directory-fsync unsupported retains `acked` Intent, persists canonical unknown evidence, returns terminal failure and creates a stable `DURABILITY_BARRIER_UNAVAILABLE` Hold/source across repeated startup.
- [x] Hard directory-fsync error cannot convert exact visible post bytes into durable committed; Intent stays open under the durability Hold.
- [x] Inspector maps exact pre to not-committed and neither to unknown; exact post is committed only with canonical persisted durability-complete evidence, otherwise unknown.
- [x] Unknown target never regenerates or overwrites automatically.
- [x] Live durable rename is closed by canonical observation plus Intent transition before reply; reply loss replays without rewrite, while crash before that observation remains unknown/held on startup.
- [x] Inspector observation attempt is canonical/resumable; its event and all Intent/Hold transitions commit atomically, so repeated startup continues the same state instead of creating a second authority or permanent recovered loop.
- [x] App-critical section has no cancellation branch; caller must preserve the existing non-cancellable E09-B lock/lease owner.

## Funds And Business Invariants

- [x] Legacy and atomic paths share one serializer; ordering, fields, Chinese `生成方式` and trailing newline are byte-identical.
- [x] Settlement freezes and accepts only the validated legacy preflight plan snapshot; bank target, records/account, currency, bill date, balance amount and template lineage cannot be independently spliced or changed during an awaited gate.
- [x] `updatedAt` is materialized at commit time through the shared legacy normalizer/serializer, preserving legacy field ordering and bytes.
- [x] Record count and key replacement behavior remain owned by the existing manual preflight plan.
- [x] Target/operation evidence contains only bounded alias, size/hash, revision, ordinal and token hash; no raw account, rows or filesystem path enters recovery control data.
- [x] All failures are structured/bounded; ambiguous or durability-unproven state creates an observable Hold.

## Required Human Gates

- [ ] Windows packaged directory-fsync capability probe succeeds on the released filesystem topology.
- [ ] Release owner manually reviews account/currency/date/balance lineage and Recovery Hold behavior.
- [ ] Only a later authorized change may enable production; E09-D does not alter funds/recovery red lines.
