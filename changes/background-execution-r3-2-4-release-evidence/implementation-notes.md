# R3.2.4 Release Evidence — Implementation Notes

## Baseline

- Goal/spec：v3.2.4 Spec、TechDoc 与 implementation sequence 中冻结的 `R3.2.4 | release evidence | ReconFix/VCC独立enable`。
- Exact base：`dc2caebeda3d7b34c9d86e33c10e01bc61f73a5a`（已传播 E11-B review remediation，并修复 cancellation settle 的 E12-C head）。
- Initial plan：[preflight.md](./preflight.md)。
- Done when：6-action snapshot 与 current direct/runtime policy、冻结 Spec、Git-backed reviewed evidence一致；全部 production 继续 `false/legacy/0`，Windows/真实样本/资金/恢复人工 gate 不被本地自动化升级。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 使用 tracked JSON + 只读 CLI validator + mutation tests，不改 `src/`。 | 冻结 R3 scope 是 release evidence；current capability 与 production selector 已分离。 | 修改 feature flag/runtime routing、Main/IPC 或 package version。 | 用户可见业务路径、金额币种、receipt/Inspector/Publisher 零变化。 |
| 6 action 都按 direct module + common runtime 双 authority 校验。 | 当前公共 runtime 精确注册 E11/E12 六项。 | 只信 snapshot 或文档；把 `production=false` 当作未注册。 | registration 与 enablement 分开记录，任一 action 缺失即 fail closed。 |
| E12-C topology 使用完整的 v3.2.4 versioned action authority，direct/runtime 必须逐字段 exact 相等。 | 冻结 Spec/TechDoc 与 reviewed E12-C 都要求最多 2 Writer；共享 fixture 的 4 Writer 字节受历史合同包 checksum/report 约束。 | 继续维护六字段 overlay；静默改写共享合同包；回退到 4 Writer。 | `policy-authority.v3.2.4.json` 完整冻结 phase-zero、childrenMax=2、requestedMaxWorkers=2；overlay 白名单删除，production 仍 disabled。 |
| evidence 按 action 绑定真实 reviewed commit/blob，并要求 reviewed head 是 exact base ancestor。 | 防止 snapshot + validator 常量共同虚构已审查来源。 | null/unknown head；仅文件名或 SHA 文本。 | source/head/blob/hash任一漂移均拒绝。 |
| 本机 E12-C 性能只记 `LOCAL_SYNTHETIC_ONLY`。 | synthetic 16 subjects 提升约50%，但真实大型样本、Windows packaged和资金人工核对未完成。 | 自动把 local benchmark升级为生产 PASS。 | dual capability可审计，production gate保持关闭。 |
| snapshot 使用 metadata-only schema并先递归做隐私扫描。 | release evidence不需要也不应包含账号、金额、原始行或文件路径。 | 仅用 `rawStored=false` 自我声明。 | raw-like key、账号、金额标签数值与序列化业务行拒绝；hash/OID/版本号保留。 |
| 在加载任何 repo runtime/policy module 前执行 bootstrap Git authority guard。 | Reviewer P1 指出原 validator 可在额外 production commit、dirty selector，或 index flag 隐藏的 worktree drift 上继续使用可变 runtime。 | 依赖 snapshot 自声明、`git status`、`update-index --refresh`、在 `require` 后再检查，或只比 source hash。 | sole parent 必须是 exact E12-C base；当前 commit 只 pure-add 六个冻结路径；从 HEAD tree 枚举 1913 entries，index 必须 exact/default flags，实际 worktree 的 lstat type/mode、parent/real path 与 Git-filtered blob 必须与 HEAD 一致，且无 non-ignored untracked；branch/main/tag 均锁定。 |
| snapshot 必须先经 strict raw JSON lexer/parser，再调用 `JSON.parse`。 | Reviewer P1 指出 duplicate key 会在标准 parse 中被最后值静默覆盖，可隐藏敏感原文或门禁冲突。 | regex 扫描、只查顶层、或 parse 后查对象。 | 所有 object scope 独立检查 decode+NFKC 后 key；escaped/Unicode 等价、array 内 object、malformed、超 256 KiB和超 128 层全部 fail closed。 |
| validator 错误契约只返回固定 code 与 opaque/index path。 | Reviewer P2 证明 raw key 曾可通过 privacy error path 流入 CI stdout。 | 拼接原 key/value 以方便调试。 | 不回显任何 raw key/value；最多 20 个错误、code 64 字符、path 96 字符、CLI 输出 4096 bytes，超限使用固定 fallback。 |
| raw number lexeme 在 `JSON.parse` 前必须保留并验证。 | Reviewer P1 指出账号样式指数下溢可在 parse 后变成 `0`，使 privacy/schema 失去原 token 证据。 | 仅验证 JSON number 语法；或 parse 后再看 `Number`值。 | token 最长 64；账号长 significand 返固定脱敏 code；指数、下溢、`-0`、不安全/非canonical 表示拒绝；canonical finite 负数/小数不在 lexer 误伤，由冻结 schema 继续 fail closed。 |
| CommonJS authority 使用 exact `.js` 路径，并把实际审计根闭包纳入加载前后双 guard。 | 替代 Reviewer P1 证明 ignored 无扩展 `runtime` 会优先于 tracked `runtime.js`，而普通 Git status/tree 不枚举 ignored shim。 | 只补顶层扩展名；全盘扫描 node_modules/logs；只在加载前校验。 | 顶层 repo module 的 `require.resolve` 必须等于 HEAD tracked 绝对路径；`src/`、`scripts/` 与 R3 evidence 根实际集合（含 ignored）必须与 HEAD 集合一致；加载完成后同一 guard 再验一次，nested shim 与 TOCTOU 均不能形成 PASS。 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| snapshot 是 review artifact，不会成为运行时配置。 | `src/` 无 consumer，本阶段禁止接线。 | 若未来 runtime require 会形成双 authority。 | validator 测试固定只读；未来接线必须新合同/新PR。 |
| package/version 用户文档无需本阶段更新。 | 没有 version bump 或用户可见生产行为；冻结 sequence 只写 release evidence。 | release owner若决定正式发布，需要三件套同步。 | 当前不改；正式发布另立范围。 |

## Deviations / Reviewer Findings Closure

| Finding | 闭合方案 | 证据 | 行为/验收影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| P1：validator 未绑定 exact Git state，且 guard 前加载可变 runtime。 | top-level 仅加载 Node built-ins；CLI/API 先跑 bootstrap guard，之后才 lazy-load direct/common policy。Git guard 锁定 exact sole parent、branch、六路径 pure-add 100644 allowlist、clean tracked/index、main OID、tag refs digest 与 HEAD 无 tag。 | 真实临时 repo 反例覆盖额外 `src/main.js` commit、dirty/staged selector、wrong parent、extra commit/path、rename、main/tag ref drift；在 invalid selector 加载前均返固定 Git code。 | 只缩紧 evidence validator authority，未改 production runtime；最终 amend/squash 成 exact base 之上唯一 commit。 | 不需改冻结功能 Spec；preflight 已同步 validator 安全契约。 |
| P1：`JSON.parse` 前无 duplicate-key 检查。 | 手写严格 raw lexer/parser，在 parse 前覆盖全部 object 层级；比较 decoded+NFKC key，限制字节数与深度。 | 顶层/嵌套/escaped/NFC 等价/array object duplicate、malformed number/truncation、oversized/too-deep 反例；不同 scope 同 key 正常通过。 | 消除隐藏原文与冲突门禁的 parse 旁路，不改 snapshot 业务 schema。 | 不需改冻结功能 Spec；preflight 已同步输入权威契约。 |
| P2：privacy 失败路径回显 raw key。 | privacy traversal 改用索引 path；全部 CLI 异常转换为有界固定 code/path，不输出原 exception text。 | 敏感 sentinel、超长 key、多错误 E2E CLI 断言 stdout/stderr/返回 JSON 均不含 raw key/value，且数量和总长有界。 | 可观测性改为安全的 machine code，不暴露账号/金额/业务行。 | 不需改冻结功能 Spec；preflight 已同步 privacy error 契约。 |
| P1：`assume-unchanged` / `skip-worktree` 可隐藏 tracked runtime drift。 | HEAD tree 是唯一枚举 authority；拒绝任何非默认 index tag/stage 并要求 index exact HEAD；对每个 HEAD entry 检查实际 lstat/type/mode/非重定向 parent+real path，regular/executable 用 Git-filtered hash、symlink 用 target blob 对 HEAD OID；拒绝 submodule/未支持 type 与 non-ignored untracked。 | 真实临时 clone 攻击覆盖 bare assume/skip flag、hidden blob/mode/symlink drift、staged+hidden、额外 index/untracked，均在 runtime sentinel 加载前失败。 | 消除 index/status 伪 clean；增加 bootstrap 的全树校验成本，但未改 production runtime。 | 不需改冻结功能 Spec；preflight/snapshot Git authority 已同步。 |
| P1：number token 下溢后绕过 privacy/schema。 | strict raw parser 保留 lexeme，在 `JSON.parse` 前执行长度、finance-significand、非指数、finite/safe 与 canonical representation 校验。 | 敏感指数下溢、nested array、负数/小数/指数、超长 token 的 parser + 真文件 CLI 反例；stdout/stderr/return JSON 不回显 token。 | 关闭 parse 后信息丢失旁路；合法 canonical 负数/小数仍交由 schema 裁决。 | 不需改冻结功能 Spec；preflight 已同步 raw-number 契约。 |
| P1：ignored extensionless/CommonJS 邻近 shim 绕过 tracked authority。 | 递归枚举三个审计根的实际 lstat 集合并与 HEAD 656 个 tracked entry 精确闭合；顶层三项 repo module 使用 exact `.js` + `require.resolve`/HEAD target 校验；runtime load 后再跑完整 guard。 | ignored 顶层无扩展 shim、ignored `.js/.json` 邻居、nested dependency shim 在 runtime 前失败；注入 load 后 tracked drift 时 post-load guard 失败；根级 ignored node_modules/logs 正常 PASS。 | 消除 Git ignore 与 CommonJS resolution 组合旁路；不扫描非审计根，不改 production module。 | 不需改冻结功能 Spec；preflight/snapshot Git authority 已同步。 |
| P3：旧 focused `231/231` 未记录 exact 命令，替代 Reviewer 的自然组合得到 `230/230`。 | 放弃无法复原的旧计数；冻结下述 8 文件串行命令并重新实跑。 | 实际为 `240/240`，不添加无关用例凑旧数字。默认并发首跑出现 1 个 task-root replacement identity 摘要断言波动（`239/240`）；精确用例 `1/1`、E12-A 整文件 `64/64` 与固定串行集 `240/240` 均通过，未复现产品状态或合同漂移。 | 验证流程可复制且不依赖测试文件间并发调度；计数以固定串行命令输出为准。 | preflight 已逐字同步命令、实际计数与并发波动披露。 |
| P3：R3.2.4 以六字段 overlay 接受 shared canonical fixture 的旧 4 Writer，而实现是 2 Writer。 | 新增完整 versioned action authority；validator 对该 action 改为 direct/runtime/authority exact equality，并删除 overlay path 白名单。共享 v3.2.x fixture 保持历史合同包字节不变。 | `policy-authority.v3.2.4.json`、validator/snapshot mutation tests；2 Writer/phase-zero 任一回退或 authority hash/blob 漂移均 fail closed。 | 只修复 release evidence 的权威表达，不改 Writer、Publisher、金额币种或 production selector。 | 冻结功能 Spec 已是 2 Writer，无需改行为；preflight/notes 已同步证据合同。 |
| P3：E11-B direct no-active-Hold `not-committed` 只停在 `interrupted`。 | reviewed head `1afaf5db8f7a9a406ef037a685586456d106b12c` 在同一 RecoveryControl 写入执行 `mark-interrupted → begin-recovery → complete-recovery-failure`，再以显式 merge commit 传播至 E11-C、E12-A/B/C。 | E11-B `47/47 PASS`；E11/RecoveryControl 五文件矩阵 `154/154 PASS`；最终证据重建在 `dc2caebeda3d7b34c9d86e33c10e01bc61f73a5a`。 | 修复 direct no-Hold 的确定性失败收口；不新增 Hold、不改变资金、receipt、Inspector、Publisher 或 production selector。 | 功能合同未变；notes/preflight/evidence catalog 已同步新 head 与人工门禁。 |
| Windows CI：E12-C cancel timeout 被 `unref()` 后，空闲事件循环可在 shard Promise settle 前结束。 | exact E12-C head `dc2caebe…` 保持 bounded cancel timer 引用；child cancel 连续 `20/20`、E12-A/B/C `81/81`、平台/恢复定向 `141/141`。 | 不以测试保活句柄掩盖产品生命周期缺口；不 rerun 旧失败快照。 | `abort → terminate → exit → allSettled → Main cleanup` 必然有界可达；成功路径、资金/币种与 production selector 不变。 | 既有生命周期合同未变；E12-C notes 与 evidence catalog 已同步。 |

## Reproducible Focused Validation

```bash
node --test --test-concurrency=1 tests/unit/scripts/v3-2-4-release-evidence.test.js tests/unit/main-process/recon-id-fix-service.test.js tests/unit/main-process/recon-id-fix-jpm-durable-e11-b.test.js tests/unit/main-process/recon-id-fix-export-e11-c.test.js tests/unit/main-process/vcc-financial-op-single-writer-e12-a.test.js tests/unit/main-process/vcc-financial-op-subject-query-e12-b.test.js tests/unit/main-process/vcc-financial-op-dual-writer-e12-c.test.js tests/unit/main-process/background-execution/policy-registry.test.js
```

实际结果：`240/240 PASS`，`0 FAIL / 0 SKIP`。原 Reviewer 连续两次被平台分类器阻断，未产生可执行 review；替代 Reviewer 接管后指出旧 focused 证据缺命令且其自然组合为 `230/230`。默认并发首跑曾在 `Main create 后 Worker 开始前 task-root replacement` 的 identity 摘要断言出现 `239/240`；随后精确用例 `1/1`、E12-A 整文件 `64/64` 及上述固定串行集 `240/240` 均通过。该波动按测试并发基线披露，不作为放宽生产合同或资金/恢复门禁的理由。

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| `node scripts/validate-v3-2-4-release-evidence.js` | 隔离 exact candidate PASS：6 actions、0 production enabled、1 个 versioned canonical authority；Windows `NOT_RUN`，资金/恢复 `PENDING_HUMAN_REVIEW`。 | snapshot、source anchors、runtime/direct/versioned policy exact equality、Git ancestor/blob/hash 与 gate 状态。 |
| `node --test tests/unit/scripts/v3-2-4-release-evidence.test.js` | 62/62 PASS，0 FAIL / 0 SKIP。 | production/live 回退、旧 4 Writer topology、versioned authority/action/evidence/source drift、gate 自动升级、rollback/privacy/read-only；真实 Git clone 覆盖 assume/skip、hidden blob/mode/symlink、staged+hidden、index/untracked/ignored CommonJS shim；双 guard TOCTOU、raw duplicate/malformed/oversized/depth/number canonical/privacy 与 CLI 不泄露/有界输出。 |
| 上述固定 8 文件 focused command | 240/240 PASS，0 FAIL / 0 SKIP；默认并发首跑 `239/240` 的单一 identity 摘要断言已由精确用例、E12-A 整文件与串行固定集复验通过。 | ReconFix import/JPM/export、VCC single/query/dual Writer、公共 runtime、Git/filesystem authority 与 raw lexer hardening 回归；并发波动不改变业务合同。 |
| `npm run test:unit` | 6413/6416 PASS，0 FAIL，3 个显式环境 skip；385 files、831 suites。 | Reviewer 第三轮 hardening 后全量 unit，包含 61 个 R3.2.4 安全/合同测试。 |
| `npm run test:integration` | 51/51 scripts、2455/2455 PASS，392.774s。 | 全链路集成与大文件流式/多 sheet 回归；自动更新时间表随后恢复，未纳入本阶段改动。 |
| `npm run smoke` | PASS；包含 ReconFix engine 45/45、gateway 20/20、I/O 14/14、IPC 21/21、E2E 6/6，以及既有银行/业务场景 smoke。 | 主链 smoke 与 ReconFix/VCC 周边回归。 |
| `node --expose-gc scripts/perf/vcc-financial-op-dual-writer-e12-c.js` | Reviewer 第三轮 hardening 后 PASS（本机 synthetic only）：5 runs；large median 686.382ms→349.027ms，改善 49.15%；small 240.110ms→213.332ms，改善 11.15%；dual peak RSS large 332.469MiB、small 279.984MiB。 | E12-C 本地性能/RSS 观测；不代替 Windows、真实大型样本或 production gate。 |
| E12-C cancellation remediation | child cancel 独立连续 `20/20 PASS`；E12-A/B/C `81/81 PASS`；Supervisor/Governor/adapter/Publisher/recovery/E12-C `141/141 PASS`；lint、syntax、diff-check PASS。全 unit 的 2 项非产品失败精确归因为复用安装树仍是 26.8.1，而 lock 要求 26.15.7，未记作 PASS。 | 新 exact base 的 abort/terminate/exit/allSettled/Main cleanup 有界收口；保留 CI 按 lock 重装依赖和 Windows 验证责任。 |
| ESLint / syntax / JSON / diff static checks | PASS：changed JS、full `src/`、`node --check`、JSON parse、`git diff --check`。 | 静态质量与证据格式。 |
| 依赖环境复核 | 锁定 `electron-builder/app-builder-lib 26.15.7` 后 Windows contract 5/5 PASS、2 Windows-only skip；正常 `npm ci` 后 preview contract 16/16 PASS。 | 排除共享 `node_modules` 26.8.1 与 `--ignore-scripts` 造成的环境假失败。 |

## Blindspot Pass

- 入口旁路：bootstrap guard 在任何 snapshot/runtime/policy 加载前先校验唯一 parent、branch、exact path/status/mode、HEAD-tree↔index(default flags)↔actual worktree Git-filtered blob/type/mode、三个审计根实际集合（含 ignored）与 HEAD 精确相等、无 untracked、main/tag refs；顶层 repo modules 只按 exact `.js` 绝对 HEAD target 加载，并在加载后再跑同一 guard。snapshot 不被 runtime require，不会形成新生产旁路。
- 边界条件：action 集合、顺序、唯一性、evidence scope、source/head/blob/hash、versioned authority exact equality、gate enum 和 rollback schema 全部 closed-world；raw JSON 另外封闭 duplicate/malformed/oversized/depth/number token length/canonical/privacy 边界。
- 失败模式：额外 commit/path/index/untracked、rename/delete/submodule、dirty/staged/hidden tracked 状态、file mode/type/symlink replacement、main/tag drift、未知字段、缺 gate、head 非祖先、stale 4 Writer、production/live 开启、跨 action 借证、duplicate key、指数下溢与 raw-like metadata 均 fail closed；CLI 失败只返固定有界 code/opaque path。
- 状态生命周期：当前只记录 `REGISTERED + legacy-preserved`，不把 capability 注册误报为 production live；snapshot 不持久化业务 payload 或中间状态。
- 兼容性：未改 `src/`、package version、DB、IPC、Renderer、Writer/Publisher 或旧 selector；回滚就是移除 evidence artifact，运行时行为不变。
- 可观测性：machine-readable 摘要包含 action count、production enabled count、versioned authority count 和未闭合人工 gate；错误只使用有界 code + opaque path，不包含账号、金额、raw key/value、本地文件路径或业务行。
- 测试缺口：Windows packaged/真实 Excel-WPS、真实 JPM/VCC 业务样本、真实进程终止与恢复演练仍缺；已明确保留为上线阻断，不由本地 PASS 代偿。

## Reconciliation Checklist

- 主键血缘：未修改 ReconID/VCC 主体键或 source→worker→Main receipt 血缘；reviewed evidence 对每个 action 绑定其 E11/E12 commit/blob。
- 金额/币种：未读写或重算业务金额、币种、方向；snapshot privacy scan 明确拒绝金额标签值、账号样式值和序列化业务行。
- 幂等/重复：未新增生产执行、重试或落盘；Main single Publisher/receipt/Inspector 的既有 owner 不变。
- 部分失败/恢复：JPM receipt、ReconFix/VCC Publisher recovery 状态保持 `probe`；rollback 要求保留 legacy selector、receipts 与 recovery holds。
- 行数守恒/输出 disposition：本阶段没有业务行或输出 mutation；既有 focused、integration、smoke 回归通过，但真实文件守恒仍待人工证据。
- 资损可观测性：所有 6 action 的 funds/recovery gate 均保持 `PENDING_HUMAN_REVIEW`，production `false/legacy/0`；隐私拒绝不回显账号/金额 sentinel；结论仍需资金人工复核，不能由本提交关闭。

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows packaged/Excel-WPS、真实大型VCC样本/RSS、ReconFix真实JPM资金与恢复人工复核 | BLOCK（上线） | release owner / Windows与资金人工门禁 | 不阻止 evidence-only commit，阻止 production enable。 |
