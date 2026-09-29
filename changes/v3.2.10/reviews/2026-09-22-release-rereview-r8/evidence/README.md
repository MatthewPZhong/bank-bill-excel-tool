# 第八轮证据与复现

所有命令的工作目录固定为 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`。当前工具须匹配 input-manifest.json；重跑时应把输出写到新的临时文件，保留本次审查证据。下面为复现说明，非额外执行记录。

## 证据核验与正式检查

```sh
python3 changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/verify-shared-archive.py
python3 changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/verify-probes.py
node --test --test-concurrency=1 tests/unit/architecture/*.test.js
node --test --test-name-pattern='RR7-01' tests/unit/architecture/release-rereview-r7.test.js
node scripts/check-architecture.js --json /tmp/r8-replay-architecture-check.json
```

两份归档 Python 断言读取同目录证据，验证包括漏报在内的记录；PASS 不表示两项缺陷已修复。30 项定向回归包含于386项架构测试。

本轮正式 CLI 首次误用了相对 --json 路径，命令在输入校验阶段退出2，未执行扫描；日志保存在 architecture-cli-relative-path-attempt.log。随后使用绝对路径执行，architecture-check.log 和 architecture-check.json 保存实际通过结果。未将第一次参数错误计为产品缺陷。

## 默认参数与 IPC

```sh
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r7/evidence/r7-renderer-default-realconfig.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-renderer-probes.cjs
renderer_before_root="$(node changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-renderer-before-bootstrap.cjs)"
RENDERER_SCANNER_ROOT="$renderer_before_root" node changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-renderer-probes.cjs
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-renderer-ipc-realconfig.cjs
```

before 自举使用 R7 repair/before 的 renderer-contracts.js 和4个未变工具，5个hash匹配R7起点；每次创建新的 /tmp 目录并输出路径，不依赖历史JSON中记录的临时目录。当前5个工具匹配R8冻结清单。小夹具10例：原4例、参数环境4例、IPC2例。

实际配置保留全部20 active Renderer边界和真实Preload/Renderer AST，具体追加BankStatement装配，不表示逐个测试20个工厂。VM只执行异步内存stub，await完成后读取数据并捕获注入对象；没有调用真实产品Main或IPC。

## 数组替换

```sh
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-array-probe.cjs minimal
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-array-probe.cjs real
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-array-compare.cjs
```

cases、probe、compare三个cjs保持同目录。compare自举R7起点并在结束后清理自己的临时工具目录；5工具加2机器JSON的before/current均核对manifest。5场景在最小和实际配置中分别运行，两个漏报均保留，不把脚本exit0解释为五例全PASS。

## 共享解析

```sh
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-shared-shared-probes.cjs > /tmp/r8-shared-shared-probes.json
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-shared-destructure-probes.cjs > /tmp/r8-shared-destructure-probes.json
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-shared-localenv-probes.cjs > /tmp/r8-shared-localenv-probes.json
node changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-shared-default-combinations.cjs > /tmp/r8-shared-default-combinations.json
python3 changes/v3.2.10/reviews/2026-09-22-release-rereview-r8/evidence/r8-shared-verify.py
```

原r8-shared-verify.py读取/tmp结果；verify-shared-archive.py是主审适配的归档版本，从自身目录读取并写shared-archive-verification.json，判定逻辑相同。44小夹具均分别使用R7起点和当前工具，42个通过/拒绝结果保持、2个合法误报修复，另有1例拒绝规则码由scope变coverage但仍拒绝。查询仅内存SQLite；10个SQL反例均拒绝，8个安全例不执行SQL。

## 证据边界与保全

完整release-check本轮未重跑。复用R7repair中16:37:31–16:56:01的完整沙箱外门禁；HEAD和1704输入完全匹配，9160 PASS、4 Windows条件跳过、68集成脚本通过。R7修复的早期沙箱内失败记录没有被当成最终PASS，也没有在本轮重新尝试该流程。

input-manifest.json记录开始时4476个已有文件、HEAD与Git status；input-diff.patch记录tracked差异。finalize-artifact.py生成结束时保全、链接/JSON核验及artifact-sha256.json（自身除外）。仅本轮目录被排除在新增文件检查外；生产源码、配置、旧证据等既有字节必须全保持。
