# v3.2.1 E05-A Implementation Notes

## Baseline

- Goal/spec: frozen v3.2.1 `spec.md` §5/§8/§9 E05-A and `techdoc.md` §5-§7/§12-§14.
- Initial plan: preserve the current MPT parser semantics, publish parser candidates to a task-private per-file spool, revalidate it strictly and expose only an ordered single-consumer seam.
- Done when: no production handler or database is reachable from the new graph; golden/fault/order tests and focused static gates pass.

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| Parser Core wraps the existing streaming parser instead of duplicating schema logic. | Existing parser already owns the frozen normalization contract. | A second MPT schema/parser implementation. | Long IDs, date/decimal text, fingerprint and raw hash stay on the current truth source. |
| Strict/skip is represented only as issue candidate disposition. | Store currently applies the business rollback/exclusion decision after parsing. | Creating repair tokens or writing excluded rows in Parser Core. | E05-A remains read-only and E05-B can preserve old transaction semantics. |
| Spool uses fixed basenames and manifest-last publication. | Frozen TechDoc §5 and path-tamper threat model. | Manifest-provided arbitrary paths or cross-job shared spool. | Reader can derive every path from task staging/job/file index and reject drift. |
| Transport crash has a required future policy seam and defaults to fatal fail-closed. | Frozen TechDoc defers continue-vs-fail-job to E05-P0. | Mapping crashes to ordinary file errors in E05-A. | No accidental product terminal-state decision is introduced. |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| E05-B will keep any DB transaction uncommitted until streamed reader validation completes. | This PR has no real writer and the reader reports final hash/count only at EOF. | A later writer could consume tampered rows before final validation. | Record as E05-B gate; current consumer tests are read-only/fake. |

## Deviations

| 原方案 | 实际方案 | 原因 | 影响 |
| --- | --- | --- | --- |
| `<jobId>` 直接作为 spool 目录组件。 | 目录组件为 exact Platform Protocol jobId 的 `job-<lowercase sha256>`；manifest、worker result 和 Reader expected identity 仍保存并 exact 校验原 jobId。 | 大小写不敏感文件系统、Windows 尾点折叠和设备保留名使原映射非单射。 | 只改变未接生产、不可跨重启恢复的内部 spool 路径；消除跨 job 发布/cleanup 串扰。Reviewer 已要求并接受该修复。 |

## Review Findings And Fixes

| Finding | 事实/触发 | 修复 | 验证 |
| --- | --- | --- | --- |
| P1-1 Reader header identity 自签名，且 schema lookup 可命中原型链。 | 零行或全-invalid spool 没有 valid row 能反证 manifest header；重算 manifest identity 后原 Reader 会接受。`MPT_SCHEMAS['constructor']` 非空。 | schema 必须为 `MPT_SCHEMAS` own property；扩展现有 parser 增加共享 filename/gzip/BOM/UTF-8/4MB/error-map 的首行-only seam。Reader 在 source snapshot+SHA 通过后，以真实 filename+首行 metadata exact 比较全部 header 字段和 identity。 | zero/all-invalid × sourceBatch/sourceType=`constructor`/sourceFileSequence 六个联动重签负例全部在 consumer callback 前拒绝；header seam 的 gzip+BOM、非法 UTF-8、超长行和坏 gzip 测试通过。 |
| P1-2 writer/cleanup 可沿 symlink 目录越界。 | 原 writer 使用 recursive mkdir 后才检查子目录，未检查 task root；cleanup 未校验目录树即删除固定 basename。 | task root 先 lstat/realpath，随后 mpt/job/file 逐层创建并立即校验 non-symlink+realpath containment；cleanup 在任何删除前逐层执行同等校验，非法路径抛明确 code、invalidPath 和 residualPaths，删除不完整也显式失败。 | taskStaging symlink 发布拒绝且外部无 `mpt`；fileDir symlink cleanup 返回 `PREFUND_SPOOL_CLEANUP_PATH_INVALID` 且外部 artifact 原样保留。 |
| P1-3 raw jobId 在 macOS/Windows 文件系统非单射。 | `CaseJob/casejob`、`job/job.`、设备名会指向冲突或非法目录。 | jobId 按 Platform Protocol safeKey exact 保留，目录只使用其 UTF-8 lowercase SHA-256 token。 | 六个 jobId（含大小写、尾点、`CON`、colon safeKey）目录唯一且跨平台安全；manifest 保留 exact 原值；选择性 cleanup 不影响碰撞对。 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Baseline code probe | Current parser is pure file/schema logic; store callbacks own all SQLite identity/mutation behavior. | Prevents DB and funds semantics from leaking into E05-A. |
| Parser/Core golden + existing parser suite | `62/62 PASS` after P1 fixes, including 100k-row gzip streaming, long IDs/source sequence, exact decimal text, date, fingerprint, content hash, strict/skip issues, OUTBOUND complete-pair fallback and header-only compatibility/fault cases. | Parser and funds-field semantics remain on the current implementation. |
| Spool/Reader fault matrix | Success, business error, cancel, source change, part/manifest ordering, path/basename, symlink, size/hash/count, header identity, row schema/safe integer, scoped cleanup and unsupported directory fsync all pass. | Ready artifacts are task/file scoped and fail closed before fake-consumer callbacks. |
| Ordered Coordinator + real one-shot Worker | Out-of-order ready/business-error consumes in increasing file index with one consumer; backpressure/cancel pass; forced worker termination creates no manifest and explicit task cleanup removes crash residue. | No product crash policy is guessed and no production pool is enabled. |
| Existing PreFund service/store suites | `45/45 PASS`, including identity/noop/replacement, strict/skip rollback, repair-token/source-snapshot behavior and million-row lazy consumption. | Candidate order, repair flow and current DB transaction behavior were observed without modification. |
| Static gates | Affected ESLint, seven production `node --check` invocations and `git diff --check` pass. Static test rejects SQLite/store/repair/replacement/sort/SQL mutation references in the new module graph. | New graph is read-only and not live-wired. |

### P1 Verification Commands

| 命令 | 结果 |
| --- | --- |
| `node --test tests/unit/main-process/pre-fund-reconciliation/mpt-import-e05-a.test.js tests/unit/main-process/pre-fund-reconciliation/mpt-parser.test.js` | `62/62 PASS` |
| `NODE_PATH=<main-checkout>/node_modules node --test tests/unit/main-process/pre-fund-reconciliation-service.test.js tests/unit/backend/pre-fund-reconciliation-store.test.js` | `45/45 PASS` |
| `<main-checkout>/node_modules/.bin/eslint` on affected parser/spool modules and two test files | PASS；隔离 worktree 无独立 `node_modules`，复用同仓主 checkout 已安装依赖。 |
| `node --check` on `mpt-parser.js` and all six `mpt-import/*.js`; `git diff --check` | PASS |

## Blindspot Closeout

| 盲区 | 结论与证据 | 状态 |
| --- | --- | --- |
| Live-handler bypass or accidental production enablement | No existing live `src` module imports the new `mpt-import` graph; Reader alone imports the new read-only header seam and the one-shot worker imports the writer. | Closed for E05-A. |
| Crash/cancel artifact lifecycle | In-process failures remove known current-file artifacts; force-terminated worker never publishes a manifest and task-owned `cleanupMptFileSpool` removes only a fully validated exact job/file directory. Invalid directory trees and residuals are explicit failures. Spool is never used as restart truth. | Closed for component scope; task-level invocation belongs to live integration. |
| Validation after a future DB writer starts consuming | Reader validates the full artifact once before callbacks and revalidates during callback streaming. A future transaction must stay uncommitted until the second pass completes. | Explicit E05-B gate; no real writer exists here. |
| Missing/duplicate parser result | Coordinator rejects duplicate indexes, cannot advance over a missing `nextConsumeIndex`, and cancellation/crash rejects the parent seam. | Closed; E05-P0 still owns transport-crash product mapping. |
| Platform durability | Both rows/issues rename and manifest rename require a supported directory fsync barrier; unsupported/failure removes the current file spool and fails closed. | Closed using the existing platform primitive. |

## Reconciliation Closeout

- Source identity, file sequence and content SHA remain produced by the current parser and are revalidated against the caller-owned snapshot.
- Amount/currency/date/fingerprint and OUTBOUND fallback golden outputs are unchanged; no floating-point conversion was introduced.
- Parser Core emits source-order candidates only. It does not read or create repair tokens and contains no identity/noop/replacement/batch/version/order/commit decision.
- Parsed rows are conserved as valid/error/excluded candidates; the Reader checks declared count, artifact counts, row order and disposition counts before consumption.
- No funds red-line semantic change was found. Human funds review remains required before E05-B/E05-C production enablement.

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Parser transport crash parent mixed-result mapping. | BLOCK for E05-P0, fail closed here. | E05-P0 golden against old handler and TaskLifecycle. | Does not block component merge; blocks live enablement. |
| Receipt/inspector and E05-B transaction ordering. | BLOCK for E05-B. | Dedicated E05-P0/E05-B PR. | Production remains false. |
