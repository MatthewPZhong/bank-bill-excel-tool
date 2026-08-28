# E09-D Blindspot And Reconciliation Checklist

## Authority And Entry Paths

- [x] Live `file:save-balance-seed` remains legacy while canonical production is `false/legacy/0`.
- [x] No second token, reservation, business lock, PhaseLease, intent repository, receipt, Inspector, Publisher, config or transition authority was introduced.
- [x] Hold admission and business/token `preCommitCheck` run before `prepared`; known rejection leaves no Intent or target mutation.
- [x] `prepared -> acked` is Main-owned and has no Worker `critical:ready/critical:ack` messages.
- [x] Pre-fund-only recovery planning returns no manual transitions; generic target-post-image startup transitions remain authoritative.

## Identity, Replay And State Lifecycle

- [x] Each TaskRun persists `interactionOrdinal=1..N` under `BEGIN IMMEDIATE`.
- [x] Same token hash reuses ordinal; a new token hash allocates a new ordinal/operationKey.
- [x] Intent identity is deterministic from operationKey and the canonical request hash binds target alias, exact pre/post, revision and token hash.
- [x] Exact committed retry reaches byte no-op; same operation with a changed post-image conflicts before mutation.
- [x] Canonical target alias derives from the sanitized target basename, so raw-bank-name collisions share one conflict scope.
- [x] No-op returns before Intent/critical transition and creates no control event.

## File Durability And Recovery

- [x] First creation of `balance-seeds` persists its parent entry before writing the target.
- [x] Non-noop uses same-directory exclusive temp, full file write, file fsync, atomic rename, target-directory fsync and fresh target readback.
- [x] Explicit directory-fsync unsupported retains `acked` Intent, returns terminal failure and creates `DURABILITY_BARRIER_UNAVAILABLE` Hold.
- [x] Hard directory-fsync error cannot convert exact visible post bytes into durable committed; Intent stays open under the durability Hold.
- [x] Inspector maps exact post/pre/neither to committed/not-committed/unknown.
- [x] Unknown target never regenerates or overwrites automatically.
- [x] Crash after durable rename and before reply is closed by startup reread; the seed is not rewritten and the session requires re-import.
- [x] App-critical section has no cancellation branch; caller must preserve the existing non-cancellable E09-B lock/lease owner.

## Funds And Business Invariants

- [x] Legacy and atomic paths share one serializer; ordering, fields, Chinese `生成方式` and trailing newline are byte-identical.
- [x] Merchant/account, currency, bill date, balance amount, template lineage and updatedAt semantics remain the legacy plan's values.
- [x] Record count and key replacement behavior remain owned by the existing manual preflight plan.
- [x] Target/operation evidence contains only bounded alias, size/hash, revision, ordinal and token hash; no raw account, rows or filesystem path enters recovery control data.
- [x] All failures are structured/bounded; ambiguous or durability-unproven state creates an observable Hold.

## Required Human Gates

- [ ] Windows packaged directory-fsync capability probe succeeds on the released filesystem topology.
- [ ] Release owner manually reviews account/currency/date/balance lineage and Recovery Hold behavior.
- [ ] Only a later authorized change may enable production; E09-D does not alter funds/recovery red lines.
