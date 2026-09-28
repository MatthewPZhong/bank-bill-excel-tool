# R14 共享与闭包绑定重放

结论：62 个既有夹具已 fresh 执行，机器断言 PASS；本范围无新增 finding。

所有命令显式使用工作目录 `/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10`。以下七个 Node 命令实际执行并退出 0；Python 断言也已实际 PASS。

```sh
node /tmp/r14-shared-shared-probes.cjs > /tmp/r14-shared-shared-probes.json
node /tmp/r14-shared-destructure-probes.cjs > /tmp/r14-shared-destructure-probes.json
node /tmp/r14-shared-localenv-probes.cjs > /tmp/r14-shared-localenv-probes.json
node /tmp/r14-shared-default-combinations.cjs > /tmp/r14-shared-default-combinations.json
node /tmp/r14-shared-async-array-combinations.cjs > /tmp/r14-shared-async-array-combinations.json
node /tmp/r14-shared-logical-combinations.cjs > /tmp/r14-shared-logical-combinations.json
node /tmp/r14-shared-bindings-probes.cjs > /tmp/r14-shared-bindings-probes.json
python3 /tmp/r14-shared-verify.py
```

## 归档重放

本目录脚本、结果、断言不依赖原先的 /tmp 证据或随机临时目录。验证既有结果可执行：

```sh
python3 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-shared-verify.py
```

重新执行全部七组夹具并验证可执行：

```sh
python3 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10/changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-shared-replay.py
```

replay 为每个子进程固定 release worktree 工作目录，将结果写回本目录自己的 r14-shared-*.json。夹具运行中临时目录由脚本创建和清理，不是证据重放的外部依赖。

## 输入和结果

- before 精确使用 R13 repair 的 before/renderer-contracts.js，SHA-256 `f288b9b66558e1fee0ca9697c493aed3b60c5999fac6c0366b81041a46c4f082`；四个共享工具与该 repair/input-manifest.json 匹配。
- current 五工具与 R14 input-manifest.json 匹配；renderer-contracts.js SHA-256 `adc6b47bb07c2c66f0d41b09d42e6195ffa404587bf8b3faceda662ec1767072`。
- 56 共享夹具（38 Renderer、18 query）源代码和 expectedClean 保持 R13 归档；before/current 诊断数组相同。10 例实际执行内存 SQLite，SQL 及结果相同。
- 6 个闭包绑定夹具原样重放：三个安全例前后均 0，三个越权例前后均 1 条 scope；VM 身份及额外函数实际调用与判定一致。
- 全部 62 例 repeat/post-rules/before-current scanner 序列化及 siteEvidenceIds 保持，源码精确比较及聚合 SHA-256 保持。
- boundaries、legacy-allowlist、schema、policy-history 四份政策文件与 R13 修复起点及 R14 冻结字节一致。
- 真正 async invoke 纠正保留：single-mount-category-explicit-ipc 调用 app:get-info 后触发 other，分类为 Promise，expectedClean=false。
- conditional-distinct-pure-values 两分支均纯字符串，前后仍各拒绝一次；作为已有保守拒绝单列，不算合法通过或新增 finding。

完整机器汇总为 r14-shared-verification.json。未扩展探针或运行全套门禁；未修改源码、测试、配置或历史记录。
