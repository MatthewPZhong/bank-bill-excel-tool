# R15 共享与闭包绑定重放

结论：62 个既有夹具已 fresh 执行，机器断言 PASS；本范围无新增 finding。

所有命令显式使用工作目录 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`。以下七个 Node 命令实际执行并退出 0；Python 断言实际 PASS。

```sh
node /tmp/r15-shared-shared-probes.cjs > /tmp/r15-shared-shared-probes.json
node /tmp/r15-shared-destructure-probes.cjs > /tmp/r15-shared-destructure-probes.json
node /tmp/r15-shared-localenv-probes.cjs > /tmp/r15-shared-localenv-probes.json
node /tmp/r15-shared-default-combinations.cjs > /tmp/r15-shared-default-combinations.json
node /tmp/r15-shared-async-array-combinations.cjs > /tmp/r15-shared-async-array-combinations.json
node /tmp/r15-shared-logical-combinations.cjs > /tmp/r15-shared-logical-combinations.json
node /tmp/r15-shared-bindings-probes.cjs > /tmp/r15-shared-bindings-probes.json
python3 /tmp/r15-shared-verify.py
```

## 归档重放

本目录脚本、结果与断言不依赖原先 /tmp 证据或随机临时目录。验证已归档结果：

```sh
python3 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-shared-verify.py
```

重新执行七组夹具并验证：

```sh
python3 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r15/evidence/r15-shared-replay.py
```

replay 为各子进程固定 release worktree 工作目录，只写本目录自己的 r15-shared-*.json。夹具在运行时创建并清理临时目录，不依赖此前随机目录。

## 输入和结果

- before 精确使用 R14 repair/before/scripts/architecture/renderer-contracts.js，SHA-256 `adc6b47bb07c2c66f0d41b09d42e6195ffa404587bf8b3faceda662ec1767072`；四个共享工具与 R14 repair/input-manifest.json 哈希匹配。
- current 五工具与 R15 input-manifest.json 匹配；renderer-contracts.js SHA-256 `eb2aae187b91f9e204eeacf97234ae6a4ebb277a9a0e9ce642cef556153c0e4d`。
- 56 共享夹具（38 Renderer、18 query）源代码和 expectedClean 保持 R14 归档，before/current 诊断数组相同。10 例实际执行内存 SQLite，SQL 和返回值保持。
- 6 个原样闭包绑定例中，三个安全例前后均 0，三个越权例前后均 1 条 scope；VM 身份及额外函数实际调用与判定一致。
- 全部 62 例重复扫描、规则前后扫描序列化、before/current digest 与 siteEvidenceIds 保持；源码精确比较及聚合 SHA-256 一致。
- boundaries、legacy-allowlist、schema、policy-history 四份政策文件相对 R14 起点及 R15 冻结字节不变。
- 真正 async invoke 纠正保持：single-mount-category-explicit-ipc 调用 app:get-info 后触发 other，分类为 Promise，expectedClean=false。
- conditional-distinct-pure-values 两分支均纯字符串，前后仍各拒绝一次；单列为已有保守拒绝，不算合法通过或新增 finding。

完整机器汇总见 r15-shared-verification.json。未增加探针或执行全套门禁；未修改源码、测试、配置或历史记录。
