# 第七轮证据与复现

工作目录固定为 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`。所有命令都须以该目录作为 cwd，当前检查器还须匹配 input-manifest.json。以下命令重跑时建议重定向到新的临时文件，不覆盖本次证据。这里只写说明，不表示再次执行。

## 归档一致性与正式验证

```sh
python3 changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/verify-probes.py
node --test --test-concurrency=1 tests/unit/architecture/*.test.js
node --test --test-name-pattern='RR6-01' tests/unit/architecture/release-rereview-r6.test.js
node --test --test-name-pattern='RR6-02' tests/unit/architecture/release-rereview-r6.test.js
node scripts/check-architecture.js --json /tmp/r7-replay-architecture-check.json
```

verify-probes.py 读取同目录 JSON/JSONL/TAP，验证本轮观察，并写 probe-verification.json。其 PASS 表示包括 RR7-01 漏报在内的证据符合预期，不表示产品无问题。定向测试包含在 356 项内。

## Renderer

原问题脚本保留于 R6 归档：

```sh
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r6/evidence/r6-renderer-parameter-realconfig.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-renderer-neighbors.cjs
renderer_before_root="$(node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-renderer-before-bootstrap.cjs)"
RENDERER_SCANNER_ROOT="$renderer_before_root" node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-renderer-neighbors.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-renderer-default-realconfig.cjs
```

bootstrap 每次在 /tmp 新建完整工具目录，使用 R6 repair/before 的两个修改文件和当前三个未变工具，5 个 hash 均须匹配 R6 修复起点；不会依赖证据 JSON 中旧 /tmp 目录是否仍存在。它会写 `/tmp/r7-renderer-before-inputs.json` 并输出目录路径。current 输入另与本轮 manifest 核对。真实 Renderer 配置探针保留全部 20 个 boundary，只向内存 AST 追加代码，VM stub 捕获注入对象，无业务 IO。8 个小夹具的 array-replaced-element 是前后相同的未关闭观察，详见 review.md。

## G1

```sh
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-g1-neighbor-probe.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-g1-adjacent-probe.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-g1-compare.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-g1-compare.cjs r7-g1-adjacent-probe.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-g1-projection-real-source-probe.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-g1-native-data-real-source-probe.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-g1-preparing-real-source-probe.cjs
```

compare 自举 R6 修复前工具与两份机器 JSON，7 项 hash 均校验，再从同目录选择探针，输出 before/current。三份 real-source 脚本复制实际源码到临时目录并静态解析 765 文件，只求值完整实际 G1 active 边界；不能写成全 31 边界突变扫描。VM 仅用内存 stub，无生产恢复 IO。

## 共享解析

```sh
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-data-shared-probes.cjs > /tmp/r7-data-shared-probes.json
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-data-destructure-probes.cjs > /tmp/r7-data-destructure-probes.json
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-data-localenv-probes.cjs > /tmp/r7-data-localenv-probes.json
python3 changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-data-verify.py
```

三组共 38 小夹具，各自自举经 hash 校验的 before 工具；query 场景只执行内存 SELECT。原 r7-data-verify.py 读取上述 /tmp 结果；verify-probes.py 则直接核验本目录的归档结果，适用于不重跑扫描的复核。扫描 JSON、evidenceId 与求值前后稳定不表示重跑过去所有私有旁表隔离专项。

## 完整门禁与保全

完整 release-check 未在本轮重跑。最近 R6 repair 的 verification.json 保存 9,130 PASS、4 Windows skip、68 个集成脚本通过；gate-evidence-comparison.json 核验其 HEAD 与 1,703 个输入仍与本轮一致。

input-manifest.json 保存开始时 4,391 个已有文件的 hash、HEAD 与 Git status；input-diff.patch 保存 tracked 差异。preservation-final.json 核验它们结束时未变、本轮目录外无新文件。artifact-sha256.json 为本目录全部归档文件（自身除外）的 SHA-256。
