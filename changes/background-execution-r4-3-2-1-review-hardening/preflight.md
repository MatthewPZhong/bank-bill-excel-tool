# v3.2.1 R4 Review Hardening — Preflight

## Task Brief

- Goal：修复外部 Review 的两项存活问题：PreFund managed import 的单文件 source snapshot 失败不得中止整批；v3.2.1 final release gate 的非授权 invocation 不得产生绿色工作流。
- Context：精确基线为 R3.2.1 release-evidence HEAD `7e739036609d16f7fce78eaba0f92029d67d0311`；PR #182 与唯一 automatic CI 授权绑定该 HEAD。
- Constraints：保持金额、币种、source identity、sequence、receipt、Recovery Hold 与 production policy 不变；5 个 native action 继续 `production.enabled=false`；不运行 `release-check`、`check-vars` 或 `scan:vars`；本地修复不得 push、rerun、merge、改 #182 base/head 或启用 production。
- Done when：`valid + missing + valid` 返回等长同序 `ok/failed/ok`，missing file 无 Critical Intent/receipt 且无残留 spool；final branch 的 wrong-base/synchronize/reopened/rerun/workflow_dispatch/fork invocation 在 checkout 前稳定失败，精确 authorized tuple 与非 final 行为保持；定向 unit、validator、语法、affected lint 与 `git diff --check` 通过。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| managed import 在整批 `.map()` 内直接 `lstatSync`，真实 `ENOENT/EACCES` 在 runtime/Parser/Coordinator 前 reject。 | `managed-import.js` 与既有 missing-source unit。 | source access failure 必须有 per-file 边界，不能改变 fileIndex 或跳过后续文件。 |
| legacy `importMptFiles` 对每个文件独立 `try/catch` 并继续；冻结 Spec 要求 mixed result 等长同序。 | `service.js` §`importMptFiles`；v3.2.1 Spec §5.1/§8。 | 修复必须恢复旧 handler golden，而不是新增 batch-fatal 语义。 |
| Parser error sidecar 由 Writer 只读消费；parser-error unit 不进入 Critical Intent/receipt，Writer cleanup 有 exactly-once guard。 | `parser-outcome.js`、`single-writer-session.js`。 | source failure 可复用既有 sealed parser-error 路径，不新增公开 DTO 或持久化字段。 |
| final branch 的 release-check 条件会排除非授权事件，但后续 Windows probe/build 无失败 guard。 | `.github/workflows/build-windows.yml` 与 `windows-build-contract.test.js`。 | 必须在 checkout 前显式 FAIL，且 validator 要把 guard 纳入 authority。 |
| #182 exact HEAD 与 automatic CI 授权已经冻结。 | R3 release snapshot、PR monitor contract。 | 修复置于新的本地 R4 分支；未经 release owner 新授权不触发远端 CI。 |

## Unknowns Register

| 未知 | 类型 | 影响 | 可逆性 | 当前证据 | 处理 | 最便宜验证方式 | 当前决定 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 哪些 snapshot 异常可降为当前文件失败，避免吞掉程序错误。 | 已知未知 | 高 | 容易 | `fs.lstatSync` 的真实文件系统错误包含稳定 `code` 与 `syscall`；参数/程序错误不保证 `syscall`。 | PROBE | 注入 missing path，并保留非 filesystem throw。 | 仅捕获同时具有 `code`/`syscall` 的文件系统错误；输出固定脱敏 `PREFUND_SPOOL_SOURCE_CHANGED`。 |
| missing file 是否会错误进入 Critical/receipt 或遗留 task spool。 | 盲区 | 高 | 容易 | 现有 symlink mixed test只断言结果；Writer parser-error 路径理论上 pre-critical。 | PROBE | 真实 `valid+missing+valid` 记录 durable callbacks、Parser启动索引和 staging残留。 | missing 不启动 Parser、不触发 Critical/receipt；sealed error仍交给单 Writer有序收口。 |
| required check 的远端 context 配置是否会接受同名绿色 run。 | 已知未知 | 高 | 容易 | 配置不在仓库；但仓库可直接证明非授权工作流当前可能成功。 | ASSUME | 不依赖远端配置，直接使非授权 final invocation稳定失败。 | guard覆盖 final PR/ref 的全部非精确 tuple；不查询或改写远端保护规则。 |
| R4 是否获准成为新的最后一个 PR 并取得一次新的 automatic release-check。 | 外部授权 | 高 | 一般 | 当前仅有 #182 exact HEAD 的旧授权。 | BLOCK | release owner 在本地修复完成后决定新 head/base/attempt。 | 本轮只做本地分支、测试与 review；guard 将未授权 R4 也稳定判红，不 push、不产生 CI。 |

## 风险优先计划

| 顺序 | 步骤 | 消除的未知/保护的不变量 | 成功证据 | 失败影响 | 回滚/收缩 |
| --- | --- | --- | --- | --- | --- |
| 1 | 建立 per-file source snapshot 失败对象并复用 parser-error sidecar。 | fileIndex、mixed result、pre-critical无mutation、隐私。 | 真实 missing-middle 定向 unit。 | 会继续整批 reject或产生错误 receipt。 | 回滚到 R3 HEAD，不触碰远端。 |
| 2 | 在 Windows smoke job checkout 前增加 final invocation fail guard。 | hard gate不可被绿色替代。 | workflow truth table + validator authority。 | 非授权 run仍可能绿色或误伤普通分支。 | 删除本地 guard，保持 #182 不变。 |
| 3 | 运行定向/相邻回归和两类 blindspot pass。 | cleanup、旧路径、production false、资金恢复红线。 | unit/validator/lint/syntax/diff证据。 | 不接受本地修复。 | 收缩到问题复现与设计记录。 |
| 4 | 本地 commit并等待新的远端 CI 授权。 | 保留 #182 exact evidence与单次授权。 | clean R4 worktree、本地 commit。 | 直接push会产生未授权 synchronize。 | 不 push、不改 automation。 |
