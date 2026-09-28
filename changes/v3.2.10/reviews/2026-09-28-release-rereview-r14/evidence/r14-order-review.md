# R14 数组/helper 写入排序有限复核

结论：本范围未发现新问题。8 个普通 synthetic fixture 在 before/current 均无 scanError；5 个安全例零诊断，3 个存在越权路径的例子各一条 ARCH-RENDERER-SCOPE。修复前后诊断数量相同。Node VM 分别运行 flag=false/true，确认注入对象身份、字段与方法调用结果符合每例预期。

覆盖：多层 helper 条件写后确定覆盖的正反对照；确定写后的条件写；factory 返回对象条件写后覆盖；固定数组槽位覆盖；重复 helper 无法唯一排序时保留来源；函数声明文本顺序与调用顺序相反；后续覆盖之前捕获的旧别名。8 例详见 r14-order-cases.cjs、r14-order-verification.json。

合同依据：architecture/README.md:145 与 changes/v3.2.10/codex/v3.2.10-architecture-guardrails/techdoc.md:132。可证明较晚的无条件写入才清除旧候选；无法证明顺序继续保守合并。第三例只在 flag=true 时越权，静态拒绝符合可能路径要求；第六例为重复 helper 的保守来源保留对照，未将保守拒绝报告为缺陷。

HEAD：9a38b96b1b8006c5851535d0c1e586bbaeb63f10。

- before renderer-contracts.js：f288b9b66558e1fee0ca9697c493aed3b60c5999fac6c0366b81041a46c4f082，取自 R13 repair/before。
- current renderer-contracts.js：adc6b47bb07c2c66f0d41b09d42e6195ffa404587bf8b3faceda662ec1767072。
- 四个共享工具、boundaries/allowlist 均逐项与 before/R14 input manifest 核对；793 个 src/index.html 文件两侧相同，无 mismatch。完整哈希见 JSON。

可重放命令（工作目录必须为 /Users/pzhong/Desktop/Project/bank-bill-excel-tool/tmp/worktrees/release-v3.2.10）：

```sh
node changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-order-compare.cjs r14-order-probe.cjs minimal > /tmp/r14-order-replayed.json
node changes/v3.2.10/reviews/2026-09-28-release-rereview-r14/evidence/r14-order-verify.cjs
```

本次实际运行 compare 的入口为 /tmp/r14-order-compare.cjs，原始输出归档为 r14-order-before-current.json；归档脚本按自身 __dirname 读取案例，before 工具自举读取仓库修复快照并核对 manifest，不依赖旧 /tmp 工具目录。verify 校验同目录原始结果；r14-order-archive-replay.json 为归档后断言结果。

边界：只运行本项 8 个 synthetic fixture 的 before/current 与 VM 对照，未运行实际全部 20 Renderer 配置、全架构测试或完整门禁；本项无候选需实际配置复现。未扩展异常跳转或完整控制流分析，分支/循环由另一审查者负责。未修改源码、测试、配置或旧证据。
