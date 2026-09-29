# 第九轮证据与复现

全部命令以 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10` 为工作目录。当前源码须与 input-manifest.json 匹配。重跑时将输出写到新的临时文件，保留本轮既有证据。以下为复现说明，不表示额外执行。

## 归档核验与正式检查

```sh
python3 changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/verify-shared-archive.py
python3 changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/verify-probes.py
node --test --test-concurrency=1 tests/unit/architecture/*.test.js
node --test --test-name-pattern='RR8-01' tests/unit/architecture/release-rereview-r8.test.js
node scripts/check-architecture.js --json /tmp/r9-replay-architecture-check.json
```

本轮全架构432项、CLI均exit0。13项IPC定向子集包含于432项；46项R8新增正式回归也全部在432项内，没有另行累加。两份归档Python脚本直接断言本目录JSON/JSONL；PASS表示证据支持已记录的关闭、漏报和判定纠正，不代表两项缺陷修复。

## IPC 与逻辑表达式

```sh
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-renderer-ipc-realconfig.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-renderer-probes.cjs
renderer_before_root="$(node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-renderer-before-bootstrap.cjs)"
RENDERER_SCANNER_ROOT="$renderer_before_root" node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-renderer-probes.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-renderer-logical-realconfig.cjs
```

before自举使用R8 repair/before的renderer-contracts.js加4个未变工具，5项匹配R8起点；每次新建/tmp工具目录并输出路径，不依赖记录中的历史/tmp目录。current5工具匹配R9冻结清单。原配置两例、6邻近小例和逻辑表达式实际配置两例分别保存结果。缺存在性证明的backgroundConfig保守拒绝属已声明范围。

## 数组

```sh
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-array-probe.cjs real
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-array-neighbor-probe.cjs minimal
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-array-compare.cjs r9-array-neighbor-probe.cjs minimal
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-array-compare.cjs r9-array-selected-probe.cjs real
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-array-input-hashes.cjs
```

所有r9-array-*.cjs保持同目录。compare支持probe文件名与minimal/real两个参数，每次自举R8起点并清理自己的工具目录；5工具加2机器JSON核对before/current清单。原5例实际配置，邻近8例最小前后，4个代表实际配置前后，总计13个独立场景，不把重复执行作为额外场景计数。两个静态spread漏报保留，脚本exit0只是取证成功。

## 共享及异步语义

```sh
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-shared-shared-probes.cjs > /tmp/r9-shared-shared-probes.json
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-shared-destructure-probes.cjs > /tmp/r9-shared-destructure-probes.json
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-shared-localenv-probes.cjs > /tmp/r9-shared-localenv-probes.json
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-shared-default-combinations.cjs > /tmp/r9-shared-default-combinations.json
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-shared-async-array-combinations.cjs > /tmp/r9-shared-async-array-combinations.json
python3 changes/v3.2.10/reviews/2026-09-22-release-rereview-r9/evidence/r9-shared-verify.py
```

原r9-shared-verify.py读取/tmp；verify-shared-archive.py是主审适配的归档版本，从自身目录读取并写shared-archive-verification.json，逻辑相同。50例使用正确R8起点和当前工具。single-mount-category-explicit-ipc使用真正async stub，保留historicalExpectedClean=true及纠正后的expectedClean=false。原源码直接从Promise读字段，实际app:get-info之后会执行other默认值；不能继续计为安全。

## 边界与保全

实际Renderer配置探针保留20 active边界、真实Renderer/Preload AST，具体在内存追加BankStatement装配，未逐一验收20工厂。VM只执行合成源码和内存API/controller stub，没有真实Main IPC、产品GUI或业务数据IO；SQLite仅内存查询。

完整release-check本轮未重跑；复用R8repair的18:06:12–18:27:32完整沙箱外隔离门禁，HEAD和1705输入完全匹配，9206 PASS、4 Windows条件跳过、68集成脚本通过。该证据不代替本轮确认的漏报，也不是平台发布验收。

input-manifest.json冻结4555个已有文件、HEAD与Git status；input-diff.patch保存tracked差异。finalize-artifact.py核对结束时字节、Git状态和本轮目录外新增文件，生成preservation-final.json、链接/JSON核验及artifact-sha256.json（自身除外）。旧审查、修复和生产文件均在保全范围。
