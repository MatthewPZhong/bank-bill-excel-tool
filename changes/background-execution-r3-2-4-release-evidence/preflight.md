# R3.2.4 Release Evidence — Preflight

## Task Brief

- Goal：基于 v3.2.4 冻结 Spec/TechDoc、E11/E12 已审查父链和当前 runtime，为 ReconFix 与 VCC Financial OP 共 6 个 action 建立只读、逐 action 独立、可机器校验的 release evidence。
- Context：精确 parent 为已包含最终 v3.2.3 收尾、E11-B review remediation、E12-A identity 摘要稳定化与 cancellation settle 修复的 E12-C head `d5c6242d9e3a11591a998cf02fe11c27fb01d8d1`；冻结 R3.2.4 scope 是 `release evidence | ReconFix/VCC 独立 enable`，不是新增生产路径。
- Constraints：不改 `src/`、Main/IPC/Renderer、金额币种/receipt/Inspector/Publisher；不 bump version；所有 action 保持 `production.enabled=false / effectiveMode=legacy / effectiveWorkerCount=0`；不改变资金、恢复、Windows 或 production 人工门禁；不运行 `release-check`、`check-vars`、`scan:vars`。
- Done when：tracked JSON 对 6 action 独立记录 policy/runtime ownership、reviewed evidence、gate 与 rollback；`export-subjects` 由完整的 v3.2.4 versioned canonical action authority 与 direct/runtime exact 相等，不再依赖字段 overlay；validator 拒绝跨 action 借证、production enable、人工/Windows gate 自动升级、E12-C topology 回退到 4 Writer、敏感业务 payload 与 head/source 漂移；定向验证完成。

## 已确认事实

| 事实 | 证据 | 对方案的约束 |
| --- | --- | --- |
| 冻结 Spec 恰有 4 个 ReconFix action 和 2 个 VCC output action；代码合并时全部 production false。 | v3.2.4 Spec §3、§9；两个 module `policies.js`。 | snapshot 固定 6 action 集合和顺序，任何 action 不能由另一项证据代偿。 |
| 6 action 均已进入公共 `BACKGROUND_EXECUTION_POLICIES`，但 live selector 仍是 legacy。 | `src/main-process/background-execution/runtime.js` 与 production 字段。 | runtime registration 只能记录 capability，不得伪报 live managed/production enabled。 |
| JPM 的 receipt/Inspector、ReconFix export Publisher 与 VCC single/subject Writer 分别由 E11-P0/B/C、E12-A/B/C 实现。 | 对应 implementation notes 和 reviewed Git heads。 | 每项 evidence 绑定真实 reviewed commit、blob OID 和 canonical SHA-256。 |
| E12-C 已审查 topology 是最多 2 Writer、phase zero、Main single Publisher；本机 synthetic 16 subjects 的 5-run 中位数改善 53.96%，但 Windows/真实大样本/RSS/人工资金 gate 仍未闭合。 | E12-C preflight/notes、`policies.js`、性能脚本。 | 只记 `LOCAL_SYNTHETIC_ONLY`，不升级 production。 |
| baseline canonical policy fixture 的 `export-subjects` 仍保留旧的 phase Writer + `childrenMax/requestedMaxWorkers=4`，且该 fixture 属冻结合同包 checksum/report authority。 | fixture、合同包 `PACKAGE-SHA256SUMS.txt`、published `validation-report.json` 与当前 direct/runtime policy 对比。 | 不静默改写共享 v3.2.x 合同包；新增完整 v3.2.4 action authority，direct/runtime 必须与其 exact 相等，不再允许字段 overlay。 |
| `package.json.version` 已从最终前序版本继承为 3.2.3，冻结序列未要求 evidence-only PR 直接 bump 到 3.2.4。 | `package.json`、implementation sequence、最终 v3.2.3 closeout。 | 本 evidence commit 不更新版本号或 release 三件套；正式 v3.2.4 收尾在后续 closeout commit 同步三件套。 |
| evidence validator 本身必须先绑定唯一 Git authority，再加载可变的 runtime/policy module。 | Reviewer 反例：额外 production commit、dirty/staged selector，以及 `assume-unchanged` / `skip-worktree` 隐藏的 blob/mode/symlink 替换均不能交给 `git status` 自证。 | CLI 在读 snapshot 与加载 repo runtime 前执行 bootstrap guard：唯一 parent=冻结 E12-C、精确 branch、五文件 allowlist、HEAD tree 枚举、index exact/default flags、实际 lstat/mode/type/路径与 Git-filtered blob 全量匹配、无 non-ignored untracked、main/tag ref 冻结。 |
| `JSON.parse` 不能作为 duplicate-key 的首个观测者。 | JSON 语义会丢弃前一个重复字段，escaped/Unicode 等价 key 同样可隐藏原文或门禁冲突。 | 先用 strict raw lexer/parser 对每个 object scope 的 decode+NFKC key 做唯一性检查，再进入 `JSON.parse`；大小/深度/语法均有界。 |
| 隐私拒绝路径也是输出契约。 | Reviewer 证明原 raw key 可被拼进 error path 并流入 CI stdout。 | error 仅使用固定 code + opaque/index path；错误数、单项长度与 CLI 总输出全部有上限。 |
| raw JSON number 的词法是 privacy authority 的一部分。 | `6222021234567890e-999` 在 `JSON.parse` 后下溢为 `0`，会丢失账号样式原 token 并绕过 parse 后隐私扫描。 | raw lexer 保留每个 number lexeme；账号长 significand、指数/下溢、`-0`、非 canonical/不安全与超长 token 均在 `JSON.parse` 前以固定脱敏 code 拒绝。 |
| CommonJS 解析候选必须属于 HEAD authority。 | ignored 无扩展 `runtime` 会优先于 tracked `runtime.js`；nested extensionless require 同样可被 ignored shim 截获。 | 顶层 repo modules 使用 exact `.js` 并核对 `require.resolve` absolute path/HEAD target；递归枚举 `src/`、`scripts/`、R3 evidence 实际集合（含 ignore/info-exclude 隐藏项）与 HEAD 精确一致，加载后重跑同一 guard；根级 node_modules/logs 不扫描。 |

## Unknowns Register

| 未知 | 处理 | 影响 | 最便宜验证 | 当前决定 |
| --- | --- | --- | --- | --- |
| release snapshot 是否应改生产 selector 或 feature flag。 | PROBE（已闭合） | 高 | 查冻结 R3 scope、相邻 R3.2.1/R3.2.2 交付和当前 routing。 | 只读 evidence；所有 action `KEEP_DISABLED`，不改 `src/`。 |
| stale shared fixture 与 E12-C reviewed implementation 如何形成单一版本事实。 | PROBE（Review 后闭合） | 高 | 对 direct/runtime/shared fixture、冻结 Spec 及合同包 checksum/report authority 做结构与来源取证。 | 保留 shared v3.2.x fixture 的历史合同包字节；新增完整 `policy-authority.v3.2.4.json`，仅该 action 使用版本级 authority，direct/runtime 必须 exact equal；删除六字段 overlay 白名单。 |
| synthetic 50% 是否足以启用 dual Writer。 | BLOCK（上线） | 高 | Windows packaged、真实大型样本多轮中位数、RSS、逐主体九币种人工复核。 | 本地证据不能替代上线 gate，production 继续 false。 |
| 是否需要把用户文档三件套写成 v3.2.4 已发布。 | ASSUME | 中 | 冻结 sequence 和 package version。 | 不写；本阶段没有用户可见生产行为，也没有 version bump。 |
| snapshot 是否可能落原始账号、金额或业务行。 | PROBE（设计收口） | 高 | metadata-only schema + 递归 privacy scan mutation tests。 | 只允许 action/evidence/gate/哈希/OID/枚举；拒绝 raw-like key/value。 |
| validator 如何证明 snapshot 不是在额外代码或未提交 selector 上生成。 | PROBE（已闭合） | 高 | 真实临时 Git repo 中构造 parent/commit/path/index/worktree/ref 反例。 | bootstrap guard 必须在 runtime 加载前 fail closed；最终提交只有冻结 base 一个 parent。 |
| raw JSON 的 duplicate key 与错误输出是否可以泄露敏感内容。 | PROBE（已闭合） | 高 | 顶层/嵌套/array object/escape/Unicode/超长/多错误 CLI 攻击测试。 | 重复 key 在 parse 前拒绝；任何返回 JSON、stdout、stderr 不包含 raw key/value sentinel。 |
| index flag 是否能隐藏实际 tracked runtime 漂移。 | PROBE（已闭合） | 高 | 临时 clone 中分别构造 assume-unchanged、skip-worktree、blob/mode/symlink drift、staged+hidden。 | 不信任 index/status 的 clean 结论；从 HEAD tree 枚举 2088 tracked entries，index 和实际 worktree各自对 HEAD 闭合。 |
| number token 是否可在 parse 时发生信息丢失。 | PROBE（已闭合） | 高 | 文件/CLI 测试敏感指数下溢、负数、小数、指数、超长和 nested array。 | 仅允许有界、finite、safe且 `JSON.stringify(value)===lexeme` 的非指数 canonical number；canonical 负数/小数由下游 schema 再裁决。 |
| ignored/CommonJS shim 与加载期 TOCTOU 是否可逃过 Git authority。 | PROBE（已闭合） | 高 | 临时 clone 注入 ignored 顶层无扩展、`.js/.json` 邻居、nested shim；hook 在 runtime load 后改 tracked 文件。 | 三个审计根实际集合=HEAD 748 entries；exact module resolution；pre/post-load guard 任一失败都阻止 PASS。 |

没有需要改变冻结数据模型、资金/恢复边界或主要用户流程的实施 `BLOCK`。Windows、真实业务样本、资金与恢复人工复核仍是 production gate，只能由 release owner/人工证据关闭。

## 风险优先计划

1. 在任何 snapshot/runtime 加载前先锁定 sole-parent Git authority、六路径 allowlist、HEAD-tree↔index default flags↔actual worktree exact blob/type/mode、无 untracked、main/tag refs，优先消除验证器自身的 checkout 旁路。
2. 在 `JSON.parse` 前完成 raw JSON 唯一 key/语法/大小/深度及 number lexeme canonical/privacy 校验，并用不回显的有界错误契约封闭 privacy 失败路径。
3. 固定 6 action、runtime/direct policy、legacy live 状态；以完整 v3.2.4 action authority 取代 E12-C 六字段 overlay，消除双重事实与白名单扩张风险。
4. 建立 Git-backed evidence catalog 与 action-scoped引用，拒绝跨 action 借证和假 reviewed head。
5. 建立 metadata-only snapshot、只读 validator 与 mutation/privacy tests，不接 production runtime。
6. 运行 focused/全量 unit、integration、smoke、lint/static 与既有 E12 性能/RSS probe。
7. 执行 blindspot/reconciliation 检查，更新 notes，将本地修复 amend 为唯一 clean commit；保留 Windows/真实样本/资金人工门禁。

## Frozen Focused Validation

```bash
node --test --test-concurrency=1 tests/unit/scripts/v3-2-4-release-evidence.test.js tests/unit/main-process/recon-id-fix-service.test.js tests/unit/main-process/recon-id-fix-jpm-durable-e11-b.test.js tests/unit/main-process/recon-id-fix-export-e11-c.test.js tests/unit/main-process/vcc-financial-op-single-writer-e12-a.test.js tests/unit/main-process/vcc-financial-op-subject-query-e12-b.test.js tests/unit/main-process/vcc-financial-op-dual-writer-e12-c.test.js tests/unit/main-process/background-execution/policy-registry.test.js
```

最终 clean single-parent candidate 按上述固定命令实跑 `241/241 PASS`、`0 fail / 0 skip`；旧 parent 的 `240/240` 和并发波动不作为最终 head 的代偿证据。测试临时 clone 只复制 tracked tree，harness 仅通过 `NODE_PATH` 复用仓库已安装依赖，不改变 relative source shim 的 Git/filesystem authority 审计。E12-A 已加入全数字 digest 的确定性回归，避免随机 SHA-256 被 finance-safe 账号模式误分类。

## 2026-09-02 Final v3.2.3 Ancestry Preflight

- Goal：把最终 v3.2.3 exact head `d12abe7ca781305aaf3eef77d8b86018261741ff` 以 natural merge 传播到 #194→#204，同时保持八段 v3.2.4 effective patch 不变。
- Constraints：只在新隔离 worktree 工作；不 force/rebase/cherry-pick，不改写旧 ready 历史；不改变金额、币种、主键、receipt/Inspector/Publisher、恢复或 production gate；主工作区只读。
- Done when：八个新 head 形成严格祖先链，`d12abe7c…` 为全部 head 祖先；每个传播提交双亲精确；新旧逐段 `name-status` 与 full-index binary patch 相同；完整本地验证及新 exact Windows CI 均完成后才允许 ready/merge。

| 未知 | 处理 | 当前证据与决定 |
| --- | --- | --- |
| #194 `CONFLICTING` 是否需要新的业务取舍 | PROBE（已闭合） | 精确冲突仅两处公共 runtime registry/test；旧 ready merge 已保留两边语义，且相关 v3.2.3 blob 从 `07ef9efa…` 到 `d12abe7c…` 未变。沿旧 ready 继续 natural merge，无需手改业务代码。 |
| 最终基线传播是否改变任一 E11/E12 patch | PROBE（已闭合） | 八段新旧 `git diff --name-status` 与 `git diff --full-index --binary` 全部相同，路径数仍为 `11/9/26/14/17/11/16/19`。 |
| 新组合在完整本地与 Windows CI 是否稳定 | PROBE（待闭合） | 先跑 frozen focused 与跨模块矩阵，再跑完整 unit/integration/smoke/static；普通 push 后只信新 exact CI。 |
| Windows packaged、真实样本、资金/恢复人工证据 | BLOCK（production） | 继续阻止 production enable；不阻止本次 evidence/祖先传播。 |

风险优先顺序：先验证八段父链、scope 与 worktree cleanliness，再运行 ReconFix/VCC/公共 runtime focused 测试和 reconciliation 盲区检查，随后执行完整回归；任何资金语义变化、scope 偏移、失败或清理残留都停止传播，不以旧 CI 代偿。
